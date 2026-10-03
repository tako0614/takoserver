import { existsSync } from "node:fs";
import { join } from "node:path";
import { workerPortOwnership } from "./workerd-linux-process.ts";

/**
 * Keeping workerd running.
 *
 * Generating a configuration and leaving somebody to start the runtime is not
 * a platform; it is homework. This keeps workerd in watch mode, so a rewritten
 * configuration is picked up without bouncing a healthy process — one tenant's
 * deploy must not drop every other tenant's in-flight requests. If an accepted
 * child exits, the same configuration is retried with bounded backoff.
 *
 * A serving activation is not recorded until the spawned child passes a
 * liveness/readiness probe. A machine that cannot start workerd therefore
 * fails the Worker operation explicitly instead of reporting a false serving
 * state.
 */

export interface WorkerdProcess {
  kill(): void;
  readonly pid?: number;
  /** Bun exposes this promise; test doubles may omit it. */
  readonly exited?: Promise<number>;
}

export interface WorkerdSupervisor {
  /** Starts the runtime if it is not already running. Safe to call repeatedly. */
  ensure(configPath: string): Promise<void>;
  /** Whether the child is currently alive and has passed readiness. */
  isReady(): boolean;
  /** A fresh read-only view of the child lifecycle; it does not start recovery. */
  snapshot(): WorkerdSupervisorSnapshot;
  /** Probe the exact accepted child once without changing its lifecycle. */
  probeReadiness(): Promise<WorkerdSupervisorReadinessObservation>;
  /** Refuse to rewrite a watched config while an unknown process owns its port. */
  assertMayRender(): Promise<void>;
  stop(): void;
}

export type WorkerdSupervisorState = "idle" | "starting" | "serving" | "recovering" | "unavailable";

export interface WorkerdSupervisorSnapshot {
  readonly state: WorkerdSupervisorState;
}

export interface WorkerdSupervisorReadinessObservation {
  readonly snapshot: WorkerdSupervisorSnapshot;
  /** Null means there was no accepted ready child to probe in this turn. */
  readonly listenerReady: boolean | null;
}

type CancelScheduledRestart = () => void;
type ScheduleRestart = (run: () => void, delayMs: number) => CancelScheduledRestart;
export type WorkerdReadinessMode = "startup" | "observation";

type RuntimeEntry = {
  readonly process: WorkerdProcess;
  readonly configPath: string;
  readonly epoch: number;
  ready: boolean;
  killed: boolean;
};

type DesiredRuntime = {
  readonly configPath: string;
  readonly epoch: number;
  restartAttempt: number;
};

type StartingRuntime = {
  readonly promise: Promise<void>;
};

type PendingRestart = {
  readonly id: number;
  readonly cancel: CancelScheduledRestart;
};

const RESTART_INITIAL_DELAY_MS = 100;
const RESTART_MAX_DELAY_MS = 5_000;
const OBSERVATION_PROBE_TIMEOUT_MS = 500;
const RETIRED_CHILD_EXIT_TIMEOUT_MS = 1_000;

/** Where a workerd binary is normally found beside this package. */
export function findWorkerd(repositoryRoot: string): string | null {
  const candidates = [
    join(repositoryRoot, "node_modules", "@cloudflare", "workerd-linux-64", "bin", "workerd"),
    join(repositoryRoot, "node_modules", "workerd", "bin", "workerd"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

export function createWorkerdSupervisor(options: {
  readonly binary: string | null;
  readonly spawn: (command: readonly string[]) => WorkerdProcess;
  readonly listenerPort?: number;
  /** Kernel listener ownership; injectable only at the OS observation boundary. */
  readonly listenerOwnership?: typeof workerPortOwnership;
  /** A real listener/readiness check supplied by the serving composition. */
  readonly readiness?: (
    configPath: string,
    child: WorkerdProcess,
    mode: WorkerdReadinessMode,
  ) => Promise<boolean>;
  readonly log?: (message: string) => void;
  /** Internal clock seam for deterministic recovery tests. */
  readonly scheduleRestart?: ScheduleRestart;
}): WorkerdSupervisor {
  const scheduleRestart =
    options.scheduleRestart ??
    ((run, delayMs) => {
      const timer = setTimeout(run, delayMs);
      return () => clearTimeout(timer);
    });

  let running: RuntimeEntry | null = null;
  let starting: StartingRuntime | null = null;
  let checking: Promise<void> | null = null;
  // A signalled child is not safe to replace until its own exit and a vacant
  // listener have both been observed. Keep it after an uncertain timeout.
  let retiring: RuntimeEntry | null = null;
  // Desired state is committed only after readiness. A failed first start
  // therefore rejects once and cannot turn into an unbounded background loop.
  let desired: DesiredRuntime | null = null;
  let pendingRestart: PendingRestart | null = null;
  let firstStartFailed = false;
  let stoppedAfterRequiredRuntime = false;
  let nextEpoch = 0;
  let nextRestartId = 0;
  const listenerOwnership = options.listenerOwnership ?? workerPortOwnership;

  const logRecoveryDiagnostic = (message: string): void => {
    try {
      options.log?.(message);
    } catch {
      // Diagnostics must not change the runtime lifecycle.
    }
  };

  const isDesiredEpoch = (epoch: number): boolean =>
    desired?.epoch === epoch && nextEpoch === epoch;

  const kill = (entry: RuntimeEntry): void => {
    if (entry.killed) return;
    entry.killed = true;
    try {
      entry.process.kill();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(`workerd runtime child could not be stopped: ${message}`);
    }
  };

  const cancelPendingRestart = (): void => {
    const pending = pendingRestart;
    pendingRestart = null;
    if (!pending) return;
    try {
      pending.cancel();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(`workerd runtime restart timer could not be cancelled: ${message}`);
    }
  };

  const restartDelay = (attempt: number): number => {
    // Clamp the exponent before calculating so a process that keeps crashing
    // cannot overflow the timer delay. The delay itself remains bounded.
    const exponent = Math.min(Math.max(attempt - 1, 0), 31);
    return Math.min(RESTART_MAX_DELAY_MS, RESTART_INITIAL_DELAY_MS * 2 ** exponent);
  };

  const schedule = (epoch: number, configPath: string): void => {
    if (!isDesiredEpoch(epoch) || running || pendingRestart) return;
    const current = desired;
    if (!current || current.epoch !== epoch) return;

    const attempt = current.restartAttempt + 1;
    current.restartAttempt = attempt;
    const delayMs = restartDelay(attempt);
    const id = ++nextRestartId;
    let fired = false;
    let cancel: CancelScheduledRestart = () => undefined;
    const launch = (): void => {
      if (!isDesiredEpoch(epoch) || running || pendingRestart) return;
      const currentStarting = starting;
      if (currentStarting) {
        // A child can report exit in the same turn that its readiness
        // continuation accepts it. Wait for that start promise's cleanup
        // rather than losing the recovery or starting two children at once.
        void currentStarting.promise.then(launch, launch);
        return;
      }
      const promise = beginStart(configPath, epoch, true);
      void promise.catch((error: unknown) => {
        if (!isDesiredEpoch(epoch)) return;
        const message = error instanceof Error ? error.message : String(error);
        options.log?.(`workerd runtime restart failed: ${message}`);
      });
    };
    const run = (): void => {
      if (fired) return;
      fired = true;
      if (pendingRestart?.id === id) pendingRestart = null;
      launch();
    };

    try {
      cancel = scheduleRestart(run, delayMs);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      options.log?.(`workerd runtime restart could not be scheduled: ${message}`);
      return;
    }

    // A test scheduler may run a callback inline. In that case the callback
    // already owns the lifecycle and there is no timer left to cancel.
    if (!fired && isDesiredEpoch(epoch) && !running && !pendingRestart) {
      pendingRestart = { id, cancel };
    }
    logRecoveryDiagnostic(
      `workerd runtime automatic restart scheduled (attempt=${attempt} delayMs=${delayMs})`,
    );
  };

  const handleExit = (entry: RuntimeEntry, code: number | null): void => {
    if (running !== entry) return;
    const shouldRecover = entry.ready && isDesiredEpoch(entry.epoch);
    running = null;
    if (!shouldRecover) return;

    const safeCode =
      code !== null && Number.isInteger(code) && code >= 0 && code <= 255 ? code : "unknown";
    logRecoveryDiagnostic(`workerd runtime child exited (code=${safeCode})`);
    schedule(entry.epoch, entry.configPath);
  };

  const observeExit = (entry: RuntimeEntry): void => {
    const exited = entry.process.exited;
    if (!exited) return;
    void exited.then(
      (code) => handleExit(entry, code),
      () => handleExit(entry, null),
    );
  };

  const awaitReadiness = async (entry: RuntimeEntry): Promise<boolean> => {
    const readiness = Promise.resolve().then(() =>
      options.readiness?.(entry.configPath, entry.process, "startup"),
    );
    const exited = entry.process.exited;
    if (!exited) return (await readiness) ?? false;

    const exitedBeforeReadiness = exited.then(
      () => {
        throw new Error("workerd runtime exited before its serving readiness check");
      },
      () => {
        throw new Error("workerd runtime exited before its serving readiness check");
      },
    );
    return (await Promise.race([readiness, exitedBeforeReadiness])) ?? false;
  };

  const start = async (
    configPath: string,
    epoch: number,
    recovery: boolean,
    explicitReplacement = false,
  ): Promise<void> => {
    let entry: RuntimeEntry | null = null;
    try {
      const binary = options.binary;
      const readiness = options.readiness;
      if (!binary) {
        throw new Error("workerd runtime binary is required to activate Worker serving");
      }
      if (!readiness) {
        throw new Error("workerd runtime readiness probe is required to activate Worker serving");
      }

      // `--watch` is why a redeploy does not restart anything: workerd reads
      // the rewritten configuration itself.
      const child = options.spawn([binary, "serve", "--watch", configPath]);
      entry = {
        process: child,
        configPath,
        epoch,
        ready: false,
        killed: false,
      };
      running = entry;
      observeExit(entry);

      const ready = await awaitReadiness(entry);
      if (!ready) {
        throw new Error("workerd runtime failed its serving readiness check");
      }
      if (
        running !== entry ||
        nextEpoch !== epoch ||
        (recovery && !isDesiredEpoch(epoch)) ||
        (desired && desired.epoch !== epoch)
      ) {
        throw new Error("workerd runtime startup was cancelled");
      }

      entry.ready = true;
      firstStartFailed = false;
      stoppedAfterRequiredRuntime = false;
      if (!desired) {
        desired = { configPath, epoch, restartAttempt: 0 };
      }
      if (recovery) {
        logRecoveryDiagnostic(
          explicitReplacement
            ? "workerd runtime recovered after listener replacement"
            : "workerd runtime recovered after automatic restart",
        );
      } else {
        options.log?.(`workerd started against ${configPath}`);
      }
    } catch (error) {
      if (entry) {
        kill(entry);
        if (running === entry) running = null;
      }
      if (!recovery) firstStartFailed = true;
      throw error;
    }
  };

  const beginStart = (
    configPath: string,
    epoch: number,
    recovery: boolean,
    explicitReplacement = false,
  ): Promise<void> => {
    const promise = start(configPath, epoch, recovery, explicitReplacement);
    const attempt: StartingRuntime = { promise };
    starting = attempt;
    void promise.then(
      () => {
        if (starting === attempt) starting = null;
      },
      () => {
        if (starting === attempt) starting = null;
        if (recovery && isDesiredEpoch(epoch)) schedule(epoch, configPath);
      },
    );
    return promise;
  };

  const waitForExit = async (entry: RuntimeEntry): Promise<void> => {
    const exited = entry.process.exited;
    if (!exited) throw new Error("workerd runtime child exit cannot be confirmed");
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        exited.then(() => undefined),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("workerd runtime child exit was not confirmed in time")),
            RETIRED_CHILD_EXIT_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };

  const replaceRetired = async (
    entry: RuntimeEntry,
    configPath: string,
    epoch: number,
    recovery: boolean,
  ): Promise<void> => {
    const port = options.listenerPort;
    if (port === undefined) throw new Error("workerd listener port is required for replacement");
    await waitForExit(entry);
    if (retiring !== entry || nextEpoch !== epoch) {
      throw new Error("workerd runtime replacement was cancelled");
    }
    const ownership = await listenerOwnership(port, undefined);
    if (retiring !== entry || nextEpoch !== epoch) {
      throw new Error("workerd runtime replacement was cancelled");
    }
    if (ownership !== "vacant") {
      throw new Error("workerd listener port is occupied after child exit");
    }
    retiring = null;
    cancelPendingRestart();
    await beginStart(configPath, epoch, recovery, recovery);
  };

  const trackCheck = (promise: Promise<void>): Promise<void> => {
    checking = promise;
    void promise.then(
      () => {
        if (checking === promise) checking = null;
      },
      () => {
        if (checking === promise) checking = null;
      },
    );
    return promise;
  };

  const snapshot = (): WorkerdSupervisorSnapshot => {
    let state: WorkerdSupervisorState;
    if (running?.ready) state = "serving";
    else if (starting || checking) state = desired ? "recovering" : "starting";
    else if (pendingRestart) state = "recovering";
    else if (desired || firstStartFailed || stoppedAfterRequiredRuntime) state = "unavailable";
    else state = "idle";
    return Object.freeze({ state });
  };

  return {
    ensure(configPath) {
      if (checking) return checking;
      if (starting) return starting.promise;
      if (running?.ready) {
        const entry = running;
        const port = options.listenerPort;
        if (port === undefined) return Promise.resolve();
        return trackCheck(
          (async () => {
            const assertCurrent = (): void => {
              if (running !== entry || nextEpoch !== entry.epoch) {
                throw new Error("workerd runtime listener check was cancelled");
              }
            };
            let ownership = await listenerOwnership(port, entry.process.pid);
            assertCurrent();
            if (ownership === "vacant") {
              // Watch-mode reload can briefly release the accepted listener.
              // Its existing bounded startup probe waits for the exact child
              // to resume; the final kernel read alone decides ownership.
              try {
                await options.readiness?.(entry.configPath, entry.process, "startup");
              } catch {
                // A readiness failure is not socket-ownership evidence.
              }
              assertCurrent();
              ownership = await listenerOwnership(port, entry.process.pid);
              assertCurrent();
            }
            if (ownership === "owned") return;
            if (ownership === "foreign") {
              throw new Error(
                "workerd listener port is occupied by a process not owned by this Host",
              );
            }

            // Invalidate the old watcher before signaling the exact captured
            // child. Its expected exit cannot schedule a second replacement.
            running = null;
            retiring = entry;
            kill(entry);
            await replaceRetired(entry, desired?.configPath ?? configPath, entry.epoch, true);
          })(),
        );
      }
      if (!options.binary) {
        firstStartFailed = true;
        return Promise.reject(
          new Error("workerd runtime binary is required to activate Worker serving"),
        );
      }
      if (!options.readiness) {
        firstStartFailed = true;
        return Promise.reject(
          new Error("workerd runtime readiness probe is required to activate Worker serving"),
        );
      }

      cancelPendingRestart();
      const epoch = desired?.epoch ?? ++nextEpoch;
      const targetConfigPath = desired?.configPath ?? configPath;
      if (retiring) {
        return trackCheck(replaceRetired(retiring, targetConfigPath, epoch, desired !== null));
      }
      return beginStart(targetConfigPath, epoch, desired !== null);
    },

    isReady() {
      return running?.ready === true;
    },

    snapshot() {
      return snapshot();
    },

    async probeReadiness() {
      const entry = running;
      if (!entry?.ready) return Object.freeze({ snapshot: snapshot(), listenerReady: null });

      let timer: ReturnType<typeof setTimeout> | undefined;
      const probe = Promise.resolve()
        .then(() => options.readiness?.(entry.configPath, entry.process, "observation"))
        .then((result) => result === true)
        .catch(() => false);
      const timeout = new Promise<boolean>((resolve) => {
        timer = setTimeout(() => resolve(false), OBSERVATION_PROBE_TIMEOUT_MS);
      });
      let ready = false;
      try {
        ready = await Promise.race([probe, timeout]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }

      // The probe is observational. If this child stopped or was replaced
      // while awaiting I/O, its result must not describe the newer lifecycle.
      if (running !== entry || !entry.ready) {
        return Object.freeze({ snapshot: snapshot(), listenerReady: false });
      }
      return Object.freeze({ snapshot: snapshot(), listenerReady: ready });
    },

    async assertMayRender() {
      if (options.listenerPort === undefined) return;
      const ownership = await listenerOwnership(options.listenerPort, running?.process.pid);
      if (ownership === "foreign") {
        throw new Error("workerd listener port is occupied by a process not owned by this Host");
      }
    },

    stop() {
      stoppedAfterRequiredRuntime =
        desired !== null ||
        running !== null ||
        starting !== null ||
        pendingRestart !== null ||
        firstStartFailed;
      nextEpoch += 1;
      desired = null;
      firstStartFailed = false;
      const wasChecking = checking !== null;
      checking = null;
      cancelPendingRestart();
      const entry = running;
      running = null;
      if (entry) {
        // A concurrent ownership check may still resolve after stop. Preserve
        // the exact signalled child until a later ensure can prove its exit.
        if (wasChecking && entry.ready && options.listenerPort !== undefined) retiring = entry;
        kill(entry);
      }
      // Invalidate the in-flight promise as well. Its readiness completion may
      // still arrive later, but it can no longer replace a subsequent ensure.
      starting = null;
    },
  };
}
