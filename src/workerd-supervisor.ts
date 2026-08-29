import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Keeping workerd running.
 *
 * Generating a configuration and leaving somebody to start the runtime is not
 * a platform; it is homework. This starts workerd once, in watch mode, so a
 * rewritten configuration is picked up without bouncing the process — one
 * tenant's deploy must not drop every other tenant's in-flight requests.
 *
 * A serving activation is not recorded until the spawned child passes a
 * liveness/readiness probe. A machine that cannot start workerd therefore
 * fails the Worker operation explicitly instead of reporting a false serving
 * state.
 */

export interface WorkerdProcess {
  kill(): void;
  /** Bun exposes this promise; test doubles may omit it. */
  readonly exited?: Promise<number>;
}

export interface WorkerdSupervisor {
  /** Starts the runtime if it is not already running. Safe to call repeatedly. */
  ensure(configPath: string): Promise<void>;
  /** Whether the child is currently alive and has passed readiness. */
  isReady(): boolean;
  stop(): void;
}

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
  /** A real listener/readiness check supplied by the serving composition. */
  readonly readiness?: (configPath: string) => Promise<boolean>;
  readonly log?: (message: string) => void;
}): WorkerdSupervisor {
  let running: { readonly process: WorkerdProcess; ready: boolean } | null = null;
  let starting: Promise<void> | null = null;

  return {
    async ensure(configPath) {
      if (running?.ready) return;
      if (starting) return await starting;
      if (!options.binary) {
        throw new Error("workerd runtime binary is required to activate Worker serving");
      }
      if (!options.readiness) {
        throw new Error("workerd runtime readiness probe is required to activate Worker serving");
      }
      const readiness = options.readiness;
      // `--watch` is why a redeploy does not restart anything: workerd reads
      // the rewritten configuration itself.
      const child = options.spawn([options.binary, "serve", "--watch", configPath]);
      const entry = { process: child, ready: false };
      running = entry;
      child.exited?.then(() => {
        if (running?.process === child) running = null;
      });
      starting = (async () => {
        const ready = await readiness(configPath);
        if (!ready || running?.process !== child) {
          child.kill();
          if (running?.process === child) running = null;
          throw new Error("workerd runtime failed its serving readiness check");
        }
        entry.ready = true;
        options.log?.(`workerd started against ${configPath}`);
      })();
      try {
        await starting;
      } catch (error) {
        if (running?.process === child) running = null;
        throw error;
      } finally {
        starting = null;
      }
    },

    isReady() {
      return running?.ready === true;
    },

    stop() {
      running?.process.kill();
      running = null;
    },
  };
}
