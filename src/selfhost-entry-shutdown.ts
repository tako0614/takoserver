const MAX_BACKGROUND_CAUSE_LENGTH = 240;
const SAFE_IDENTIFIER = /^[A-Za-z0-9_.-]{1,40}$/u;

/**
 * One bounded, single-line description of why a background pass failed.
 *
 * Only the error's class name, a short code (for example `SQLITE_BUSY`) and its
 * message are used, truncated to a fixed length with control characters
 * replaced, so one failure stays one log line. This code never serializes the
 * error's other properties, bound parameters or arbitrary non-Error values.
 * The message itself is whatever the failing library wrote and can echo
 * fragments of its input (a SQL error can quote part of a statement), so it is
 * bounded, not guaranteed free of data.
 */
export function describeBackgroundFailure(cause: unknown): string {
  if (cause === undefined) return "unknown cause";
  if (!(cause instanceof Error)) return "non-error cause";
  const read = (read: () => unknown): string => {
    try {
      const value = read();
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  };
  const name = read(() => cause.name);
  const code = read(() => (cause as { code?: unknown }).code);
  const message = read(() => cause.message)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips terminal control bytes from a log line
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .trim();
  const head = [
    SAFE_IDENTIFIER.test(name) ? name : "Error",
    ...(SAFE_IDENTIFIER.test(code) ? [code] : []),
  ].join(" ");
  const text = message ? `${head}: ${message}` : head;
  return text.length > MAX_BACKGROUND_CAUSE_LENGTH
    ? `${text.slice(0, MAX_BACKGROUND_CAUSE_LENGTH - 1)}…`
    : text;
}

export type SelfhostEntryShutdownStage = "ingress" | "drain" | "cleanup";

export interface SelfhostEntryShutdownOptions {
  /** Stop accepting requests without interrupting accepted response bodies. */
  readonly stopIngress: () => Promise<void>;
  /** Close the owned runtime resources after requests and passes have drained. */
  readonly finishShutdown: () => Promise<void>;
  readonly onFailure: (stage: SelfhostEntryShutdownStage) => void;
  readonly onSuccess: () => void;
}

export interface SelfhostEntryShutdown {
  readonly isStopping: () => boolean;
  readonly fetch: (
    request: Request,
    handler: (request: Request) => Response | Promise<Response>,
  ) => Promise<Response>;
  readonly startInterval: (
    name: string,
    milliseconds: number,
    run: () => void | Promise<void>,
    /** `cause` is the rejection; print it only through `describeBackgroundFailure`. */
    onFailure: (name: string, cause?: unknown) => void,
  ) => void;
  readonly runPass: (name: string, run: () => void | Promise<void>) => Promise<void>;
  readonly shutdown: () => Promise<boolean>;
}

export type SelfhostEntryOwnedResourceStage =
  | "workerd-reap"
  | "v2-worker-suspend"
  | "actor-close"
  | "data-plane-close"
  | "control-database-close";

export interface SelfhostEntryOwnedResourceOptions {
  readonly workerdShutdown: () => Promise<void>;
  readonly mayCloseDependents: () => boolean;
  /** Stop v2 native owners while SQL and private binding services remain live. */
  readonly v2WorkerSuspend?: () => Promise<void>;
  readonly actorClose: () => Promise<void>;
  readonly dataPlanesStop: () => Promise<void>;
  readonly controlDatabaseClose: () => void;
  readonly onFailure: (stage: SelfhostEntryOwnedResourceStage) => void;
}

/**
 * Close dependent owners only while every earlier owner has proved shutdown.
 * In particular, an uncertain Actor close must not close its backing planes
 * or the database beneath it.
 */
export async function closeSelfhostEntryOwnedResources(
  options: SelfhostEntryOwnedResourceOptions,
): Promise<boolean> {
  try {
    await options.workerdShutdown();
  } catch {
    options.onFailure("workerd-reap");
    return false;
  }

  if (!options.mayCloseDependents()) return false;

  try {
    await options.v2WorkerSuspend?.();
  } catch {
    options.onFailure("v2-worker-suspend");
    return false;
  }

  try {
    await options.actorClose();
  } catch {
    options.onFailure("actor-close");
    return false;
  }

  try {
    await options.dataPlanesStop();
  } catch {
    options.onFailure("data-plane-close");
    return false;
  }

  try {
    options.controlDatabaseClose();
  } catch {
    options.onFailure("control-database-close");
    return false;
  }

  return true;
}

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

/**
 * Own the entry's stop fence and every unit of work that must finish before
 * the resources serving it can be closed.
 */
export function createSelfhostEntryShutdown(
  options: SelfhostEntryShutdownOptions,
): SelfhostEntryShutdown {
  let stopping = false;
  let shutdownPromise: Promise<boolean> | undefined;
  const timers = new Set<ReturnType<typeof setInterval>>();
  const activeRequests = new Set<Promise<void>>();
  const activePasses = new Set<Promise<void>>();
  const namedPasses = new Map<string, Promise<void>>();

  function completeAfterResponseBody(response: Response): {
    readonly response: Response;
    readonly completed: Deferred;
  } {
    const completed = deferred();
    if (!response.body) {
      completed.resolve();
      return { response, completed };
    }

    const reader = response.body.getReader();
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      completed.resolve();
    };
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const next = await reader.read();
          if (next.done) {
            settle();
            controller.close();
          } else {
            controller.enqueue(next.value);
          }
        } catch (error) {
          settle();
          controller.error(error);
        }
      },
      async cancel(reason) {
        try {
          await reader.cancel(reason);
        } finally {
          settle();
        }
      },
    });
    return {
      response: new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      }),
      completed,
    };
  }

  function reportFailure(stage: SelfhostEntryShutdownStage): false {
    try {
      options.onFailure(stage);
    } catch {
      // Failure reporting must not turn a stopped-but-unproven entry into a
      // successful exit or leave a rejected signal promise unobserved.
    }
    return false;
  }

  function runPass(name: string, run: () => void | Promise<void>): Promise<void> {
    if (stopping) return Promise.resolve();
    const current = namedPasses.get(name);
    if (current) return current;

    let tracked: Promise<void>;
    tracked = Promise.resolve()
      .then(run)
      .then(() => undefined)
      .finally(() => {
        activePasses.delete(tracked);
        if (namedPasses.get(name) === tracked) namedPasses.delete(name);
      });
    activePasses.add(tracked);
    namedPasses.set(name, tracked);
    return tracked;
  }

  return {
    isStopping: () => stopping,

    async fetch(request, handler) {
      if (stopping) {
        return new Response("self-host is shutting down\n", {
          status: 503,
          headers: {
            connection: "close",
            "content-type": "text/plain; charset=utf-8",
            "retry-after": "1",
          },
        });
      }

      const completed = deferred();
      activeRequests.add(completed.promise);
      try {
        const response = await handler(request);
        const tracked = completeAfterResponseBody(response);
        if (tracked.completed.promise !== completed.promise) {
          tracked.completed.promise.then(completed.resolve, completed.resolve);
        }
        if (!response.body) completed.resolve();
        return tracked.response;
      } catch (error) {
        completed.resolve();
        throw error;
      } finally {
        void completed.promise.then(() => activeRequests.delete(completed.promise));
      }
    },

    startInterval(name, milliseconds, run, onFailure) {
      if (stopping) return;
      const timer = setInterval(() => {
        void runPass(name, run).catch((cause: unknown) => onFailure(name, cause));
      }, milliseconds);
      timers.add(timer);
    },

    runPass,

    shutdown() {
      if (shutdownPromise) return shutdownPromise;
      stopping = true;
      for (const timer of timers) clearInterval(timer);
      timers.clear();

      // Publish the single-flight promise before invoking any callback. The
      // stopIngress callback is allowed to reenter shutdown synchronously.
      shutdownPromise = Promise.resolve().then(async () => {
        try {
          // Both ingress listeners are stopped together by this callback.
          await options.stopIngress();
        } catch {
          return reportFailure("ingress");
        }

        try {
          await Promise.allSettled([...activeRequests, ...activePasses]);
        } catch {
          return reportFailure("drain");
        }

        try {
          await options.finishShutdown();
          options.onSuccess();
          return true;
        } catch {
          return reportFailure("cleanup");
        }
      });
      return shutdownPromise;
    },
  };
}
