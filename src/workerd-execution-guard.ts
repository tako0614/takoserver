import { isAbsolute } from "node:path";

/** Host-private process protocol. This is not an application Binding or a qualified Workflow host. */
export interface WorkerdExecutionRegistration {
  /** SHA-256 of the complete, canonical run identity, including epoch and owner. */
  readonly identity: string;
  readonly deadlineAt: number;
  readonly until: number;
}

export interface WorkerdExecutionGuard {
  /** Registration arms the independent deadline but does not start workerd. */
  readonly registered: Promise<void>;
  readonly exited: Promise<number>;
  start(configPath: string): Promise<void>;
  extendDeadline(until: number): Promise<void>;
  /** Only a matching guard ACK proves that its exact child has been reaped. */
  stop(): Promise<void>;
}

/** The private process seam keeps protocol races testable without starting an application. */
export interface WorkerdGuardProcess {
  readonly stdout: ReadableStream<Uint8Array>;
  readonly exited: Promise<number>;
  write(frame: Uint8Array): Promise<void>;
  end(): void;
  kill(): void;
}

export class WorkerdExecutionGuardError extends Error {
  constructor(readonly code: "invalid_input" | "protocol_failure" | "unavailable" | "stopped") {
    super(code);
    this.name = "WorkerdExecutionGuardError";
  }
}

const FRAME_LIMIT = 16 * 1_024;
const MAX_PENDING = 32;
type Ack = "registered" | "started" | "extended" | "stopped";

/**
 * Binary paths must be operator-owned retained artifacts; this function does
 * not qualify or search for either binary. The composition must select the
 * pinned workerd first. It is deliberately not wired into any serving entry.
 */
export function spawnWorkerdExecutionGuard(options: {
  readonly guardBinary: string;
  readonly workerdBinary: string;
  readonly registration: WorkerdExecutionRegistration;
}): WorkerdExecutionGuard {
  validatePath(options.guardBinary);
  validatePath(options.workerdBinary);
  if (process.platform !== "linux" || process.arch !== "x64") {
    throw new WorkerdExecutionGuardError("unavailable");
  }
  return createWorkerdExecutionGuard({
    registration: options.registration,
    spawn: () => {
      const child = Bun.spawn([options.guardBinary, "--workerd-binary", options.workerdBinary], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "ignore",
        env: {},
      });
      return {
        stdout: child.stdout,
        exited: child.exited,
        write: async (frame) => {
          child.stdin.write(frame);
          await child.stdin.flush();
        },
        end: () => {
          child.stdin.end();
        },
        kill: () => {
          child.kill("SIGKILL");
        },
      };
    },
  });
}

export function createWorkerdExecutionGuard(options: {
  readonly registration: WorkerdExecutionRegistration;
  readonly spawn: () => WorkerdGuardProcess;
  /** Transport bound only, never used as proof that application execution stopped. */
  readonly commandTimeoutMs?: number;
}): WorkerdExecutionGuard {
  const registration = { ...options.registration };
  const timeout = options.commandTimeoutMs ?? 5_000;
  if (
    !/^[a-f0-9]{64}$/u.test(registration.identity) ||
    !instant(registration.until) ||
    !instant(registration.deadlineAt) ||
    registration.until > registration.deadlineAt ||
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > 60_000
  ) {
    throw new WorkerdExecutionGuardError("invalid_input");
  }
  // The guard, not this controller's clock, decides whether the old deadline expired.
  let child: WorkerdGuardProcess;
  try {
    child = options.spawn();
  } catch {
    throw new WorkerdExecutionGuardError("unavailable");
  }
  const pending = new Map<
    number,
    {
      readonly kind: Ack;
      readonly resolve: () => void;
      readonly reject: (error: WorkerdExecutionGuardError) => void;
      readonly timer: ReturnType<typeof setTimeout>;
    }
  >();
  let nextId = 0;
  let writes = Promise.resolve();
  let failure: WorkerdExecutionGuardError | undefined;
  let started = false;
  let stopping: Promise<void> | undefined;
  let stopAcknowledged = false;
  let lastDeadline = registration.until;

  function fail(code: "protocol_failure" | "unavailable"): void {
    if (failure || stopAcknowledged) return;
    failure = new WorkerdExecutionGuardError(code);
    for (const request of pending.values()) {
      clearTimeout(request.timer);
      request.reject(failure);
    }
    pending.clear();
    // EOF requests orderly cleanup. Emergency guard kill triggers its child's
    // kernel parent-death signal, but is NEVER converted into a successful ACK.
    try {
      child.end();
    } catch {}
    try {
      child.kill();
    } catch {}
  }

  function request(op: string, kind: Ack, fields: Record<string, unknown> = {}): Promise<void> {
    if (failure) return Promise.reject(failure);
    if (pending.size >= MAX_PENDING || nextId >= Number.MAX_SAFE_INTEGER) {
      fail("protocol_failure");
      return Promise.reject(failure);
    }
    const id = ++nextId;
    const frame = new TextEncoder().encode(
      `${JSON.stringify({ id, op, identity: registration.identity, ...fields })}\n`,
    );
    if (frame.length > FRAME_LIMIT) {
      fail("protocol_failure");
      return Promise.reject(failure);
    }
    const result = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => fail("unavailable"), timeout);
      pending.set(id, { kind, resolve, reject, timer });
    });
    // Registration/start/renew/stop retain invocation order even if pipe flush blocks.
    writes = writes
      .then(async () => {
        if (!failure) await child.write(frame);
      })
      .catch(() => fail("unavailable"));
    return result;
  }

  function accept(line: string): void {
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      fail("protocol_failure");
      return;
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      fail("protocol_failure");
      return;
    }
    const reply = value as Record<string, unknown>;
    const entry = typeof reply.id === "number" ? pending.get(reply.id) : undefined;
    if (
      !entry ||
      (pending.has(1) && reply.id !== 1) ||
      Object.keys(reply).length !== 2 ||
      reply.kind !== entry.kind
    ) {
      // Error frames also fail the session; never leak raw guard diagnostics as app errors.
      fail("protocol_failure");
      return;
    }
    pending.delete(reply.id as number);
    clearTimeout(entry.timer);
    if (entry.kind === "stopped") {
      // STOP must be able to preempt an asynchronous START. Its reap proof
      // supersedes in-flight start/renew replies, not the registration ACK.
      stopAcknowledged = true;
      for (const cancelled of pending.values()) {
        clearTimeout(cancelled.timer);
        cancelled.reject(new WorkerdExecutionGuardError("stopped"));
      }
      pending.clear();
    }
    entry.resolve();
  }

  async function read(): Promise<void> {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let line = "";
    let lineBytes = 0;
    try {
      while (!failure && !stopAcknowledged) {
        const item = await reader.read();
        if (item.done) {
          // A truncated frame or clean EOF is absence, never an implicit stopped ACK.
          fail("unavailable");
          break;
        }
        // Bound bytes before decoding: Unicode and newline-free chunks cannot evade the cap.
        let offset = 0;
        for (let i = 0; i < item.value.length; i += 1) {
          if (item.value[i] !== 10) continue;
          lineBytes += i - offset + 1;
          if (lineBytes > FRAME_LIMIT) throw new Error("oversized guard reply");
          line += decoder.decode(item.value.subarray(offset, i), { stream: true });
          line += decoder.decode();
          accept(line);
          if (failure || stopAcknowledged) return;
          line = "";
          lineBytes = 0;
          offset = i + 1;
        }
        lineBytes += item.value.length - offset;
        if (lineBytes > FRAME_LIMIT) throw new Error("oversized guard reply");
        line += decoder.decode(item.value.subarray(offset), { stream: true });
      }
    } catch {
      fail("protocol_failure");
    } finally {
      reader.releaseLock();
    }
  }

  const registered = request("register", "registered", {
    deadlineAt: registration.deadlineAt,
    until: registration.until,
  });
  // A caller may stop before awaiting registration; keep its rejection observable but handled.
  void registered.catch(() => undefined);
  void read();
  // Stream data may still be buffered when exited resolves. The reader owns
  // orderly EOF so a final stopped frame is not lost to process-exit ordering.
  void child.exited.catch(() => fail("unavailable"));

  return {
    registered,
    exited: child.exited,
    start(configPath) {
      if (stopping) return Promise.reject(new WorkerdExecutionGuardError("stopped"));
      if (started) return Promise.reject(new WorkerdExecutionGuardError("invalid_input"));
      try {
        validatePath(configPath);
      } catch (error) {
        return Promise.reject(error);
      }
      started = true;
      return request("start", "started", { configPath });
    },
    extendDeadline(until) {
      if (stopping) return Promise.reject(new WorkerdExecutionGuardError("stopped"));
      if (!instant(until) || until < lastDeadline || until > registration.deadlineAt) {
        return Promise.reject(new WorkerdExecutionGuardError("invalid_input"));
      }
      lastDeadline = until;
      return request("extend", "extended", { until });
    },
    stop() {
      stopping ??= request("stop", "stopped").then(() => {
        // This closes the one-use helper after its proven reap ACK.
        try {
          child.end();
        } catch {}
      });
      return stopping;
    },
  };
}

function instant(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function validatePath(path: string): void {
  if (typeof path !== "string" || !isAbsolute(path) || path.includes("\0")) {
    throw new WorkerdExecutionGuardError("invalid_input");
  }
}
