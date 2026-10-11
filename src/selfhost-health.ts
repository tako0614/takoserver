import type { Sql } from "./ports.ts";
import type {
  SelfhostBackgroundPassHealth,
  SelfhostBacklogHealth,
} from "./selfhost-health-signals.ts";
import type { WorkerdSupervisor, WorkerdSupervisorState } from "./workerd-supervisor.ts";

export const SELFHOST_HEALTH_PATHS = Object.freeze({
  live: "/_takoserver/health/live",
  ready: "/_takoserver/health/ready",
});

export type SelfhostStartupRestoreOutcome = "empty" | "restored" | "failed";

export type SelfhostRuntimeHealth =
  | "not-required"
  | "starting"
  | "serving"
  | "recovering"
  | "restore-failed"
  | "unavailable";

/** Counts only: no Worker UID, hostname or path is ever put in a probe body. */
export interface SelfhostV2WorkerHealth {
  /** Owners this Host has opened for v2 Workers. */
  readonly owners: number;
  /** Owners whose recorded active incarnation is ready. */
  readonly serving: number;
  /** Owners that recorded an active incarnation which is not ready. */
  readonly unavailable: number;
}

export interface SelfhostHealthResponse {
  readonly status: "ready" | "not_ready" | "live";
  readonly database?: "readable" | "unavailable";
  readonly workerRuntime?: SelfhostRuntimeHealth;
  readonly supervisor?: WorkerdSupervisorState;
  /**
   * Present (always `true`) when at least one v2 Worker owner is unavailable,
   * work has stalled past the backlog threshold, the backlog could not be
   * read, or a background pass is failing or stalled. The control plane can
   * still be ready: one tenant Worker's failure, or a stuck Operation, must
   * not make a load balancer pull the operator API that shares this port.
   */
  readonly degraded?: true;
  /** Present only when a v2 Worker composition is mounted and could be read. */
  readonly v2Workers?: SelfhostV2WorkerHealth;
  /**
   * Counts of unsettled v2 work older than the threshold, or `unavailable`
   * when the bounded read failed. Present only when an observer is composed
   * and the database answered.
   */
  readonly backlog?: SelfhostBacklogHealth | "unavailable";
  /** Fixed pass names and counts only; present when a recorder is composed. */
  readonly backgroundPasses?: SelfhostBackgroundPassHealth;
}

export type SelfhostHealthHandler = (request: Request) => Promise<Response | undefined>;

const DEFAULT_DATABASE_CHECK_TIMEOUT_MS = 1_000;

/** Release the unused body of a readiness-only response without waiting on it. */
export function discardSelfhostReadinessProbeBody(response: Response): void {
  try {
    const cancellation = response.body?.cancel();
    if (cancellation) void cancellation.catch(() => undefined);
  } catch {
    // Body disposal is best-effort and must not affect the readiness result.
  }
}

async function databaseIsReadable(sql: Pick<Sql, "query">, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
  });
  const check = Promise.resolve()
    .then(() => sql.query("SELECT 1 AS selfhost_health"))
    .then((rows) => rows.length === 1 && rows[0]?.selfhost_health === 1)
    .catch(() => false);
  try {
    return await Promise.race([check, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function runtimeHealth(
  restore: SelfhostStartupRestoreOutcome,
  supervisor: WorkerdSupervisorState,
): SelfhostRuntimeHealth {
  if (restore === "failed") return "restore-failed";
  if (supervisor === "idle") return restore === "empty" ? "not-required" : "unavailable";
  return supervisor;
}

/**
 * One bounded read of the backlog counts. A thrown, hung or malformed read is
 * `unavailable`: it degrades the answer but never makes it 503.
 */
async function observeBacklog(
  backlog: { observe(): Promise<SelfhostBacklogHealth> },
  timeoutMs: number,
): Promise<SelfhostBacklogHealth | "unavailable"> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<"unavailable">((resolve) => {
    timer = setTimeout(() => resolve("unavailable"), timeoutMs);
  });
  const counted = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const observed = Promise.resolve()
    .then(() => backlog.observe())
    .then((value): SelfhostBacklogHealth | "unavailable" =>
      counted(value.olderThanSeconds) &&
      counted(value.operations.queued) &&
      counted(value.operations.running) &&
      counted(value.operations.reconciling) &&
      counted(value.operations.waitingInput) &&
      counted(value.queueExecutions.sendAuthorized)
        ? {
            olderThanSeconds: value.olderThanSeconds,
            operations: {
              queued: value.operations.queued,
              running: value.operations.running,
              reconciling: value.operations.reconciling,
              waitingInput: value.operations.waitingInput,
            },
            queueExecutions: { sendAuthorized: value.queueExecutions.sendAuthorized },
          }
        : "unavailable",
    )
    .catch(() => "unavailable" as const);
  try {
    return await Promise.race([observed, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** A recorder that throws or answers nonsense is reported as one failing pass. */
function observeBackgroundPasses(passes: {
  snapshot(): SelfhostBackgroundPassHealth;
}): SelfhostBackgroundPassHealth {
  try {
    const value = passes.snapshot();
    const counted = (n: unknown): n is number =>
      typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
    if (counted(value.failing) && counted(value.stalled)) {
      const last = value.lastFailure;
      return {
        failing: value.failing,
        stalled: value.stalled,
        ...(last &&
        typeof last.name === "string" &&
        /^[a-z0-9][a-z0-9-]{0,63}$/u.test(last.name) &&
        counted(last.ageSeconds)
          ? { lastFailure: { name: last.name, ageSeconds: last.ageSeconds } }
          : {}),
      };
    }
  } catch {
    // Fall through: the probe answers even when its recorder cannot.
  }
  return { failing: 1, stalled: 0 };
}

/**
 * One bounded read of the v2 owners. A thrown or hung observation is a result,
 * not an exception: the probe must answer, and "could not tell" is not ready.
 */
async function observeV2Workers(
  v2Workers: { observe(): Promise<SelfhostV2WorkerHealth> },
  timeoutMs: number,
): Promise<SelfhostV2WorkerHealth | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), timeoutMs);
  });
  const observed = Promise.resolve()
    .then(() => v2Workers.observe())
    .then((value) =>
      Number.isSafeInteger(value.owners) &&
      Number.isSafeInteger(value.serving) &&
      Number.isSafeInteger(value.unavailable) &&
      value.owners >= 0 &&
      value.serving >= 0 &&
      value.unavailable >= 0
        ? { owners: value.owners, serving: value.serving, unavailable: value.unavailable }
        : null,
    )
    .catch(() => null);
  try {
    return await Promise.race([observed, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function healthResponse(body: SelfhostHealthResponse, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Read-only Bun self-host health routes. Runtime recovery remains owned by the
 * supervisor and startup restore; these requests only issue one bounded SQL
 * read, one bounded observation of the accepted child listener, and, when
 * composed, bounded reads of the v2 owners and the backlog counts plus an
 * in-memory pass snapshot. Only the first three can make the answer 503.
 */
export function createSelfhostHealthHandler(input: {
  readonly sql: Pick<Sql, "query">;
  readonly startupRestore: SelfhostStartupRestoreOutcome;
  readonly supervisor: Pick<WorkerdSupervisor, "snapshot" | "probeReadiness">;
  /**
   * The v2 Worker owners run their own workerd children outside `supervisor`.
   * Without this, serving v2 Workers read as `not-required` and a dead one was
   * invisible. Absent when the Host has no v2 Worker composition.
   */
  readonly v2Workers?: { observe(): Promise<SelfhostV2WorkerHealth> };
  /**
   * Unsettled v2 Operations and sent Queue executions past a threshold. Read
   * only after the database answered, with the same deadline; it can mark the
   * response `degraded` but never makes it 503.
   */
  readonly backlog?: { observe(): Promise<SelfhostBacklogHealth> };
  /** In-memory background pass outcomes; never a reason for 503 either. */
  readonly backgroundPasses?: { snapshot(): SelfhostBackgroundPassHealth };
  readonly databaseCheckTimeoutMs?: number;
}): SelfhostHealthHandler {
  const timeoutMs = input.databaseCheckTimeoutMs ?? DEFAULT_DATABASE_CHECK_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 10_000) {
    throw new TypeError("self-host database health timeout must be between 1 and 10000 ms");
  }

  return async (request) => {
    if (request.method !== "GET") return undefined;
    const path = new URL(request.url).pathname;
    if (path === SELFHOST_HEALTH_PATHS.live) {
      return healthResponse({ status: "live" }, 200);
    }
    if (path !== SELFHOST_HEALTH_PATHS.ready) return undefined;

    const databaseReady = await databaseIsReadable(input.sql, timeoutMs);
    // Probe only after the SQL read so the runtime phase is as current as
    // possible at the point this response is formed. The probe is observational
    // and never changes process lifecycle state.
    const observation = await input.supervisor.probeReadiness();
    const snapshot = observation.snapshot;
    const runtime =
      snapshot.state === "serving" &&
      observation.listenerReady === false &&
      input.startupRestore !== "failed"
        ? "unavailable"
        : runtimeHealth(input.startupRestore, snapshot.state);
    const v2 = input.v2Workers ? await observeV2Workers(input.v2Workers, timeoutMs) : undefined;
    // Restore failure and a failed legacy runtime keep precedence. A v2
    // observation that failed or hung is not ready: the Host could not tell.
    // v2 owners that serve turn "no workload" into "serving". An individual
    // unavailable owner is a tenant Worker's failure, reported as `degraded`
    // and in the counts, not a reason to fail the shared control plane.
    const workerRuntime: SelfhostRuntimeHealth =
      runtime === "restore-failed" || runtime === "unavailable"
        ? runtime
        : v2 === null
          ? "unavailable"
          : v2 !== undefined && v2.serving > 0 && runtime === "not-required"
            ? "serving"
            : runtime;
    // Only after SQL answered: a backlog read on an unreadable database would
    // spend a second deadline to report what `database` already says.
    const backlog =
      input.backlog && databaseReady ? await observeBacklog(input.backlog, timeoutMs) : undefined;
    const passes = input.backgroundPasses
      ? observeBackgroundPasses(input.backgroundPasses)
      : undefined;
    // Waiting for a client to resupply private inputs is the tenant's move,
    // so `waitingInput` is reported but does not degrade the Host.
    const backlogDegraded =
      backlog === "unavailable" ||
      (backlog !== undefined &&
        backlog.operations.queued +
          backlog.operations.running +
          backlog.operations.reconciling +
          backlog.queueExecutions.sendAuthorized >
          0);
    const degraded =
      (v2 !== undefined && v2 !== null && v2.unavailable > 0) ||
      backlogDegraded ||
      (passes !== undefined && passes.failing + passes.stalled > 0);
    const ready =
      databaseReady && (workerRuntime === "not-required" || workerRuntime === "serving");
    return healthResponse(
      {
        status: ready ? "ready" : "not_ready",
        database: databaseReady ? "readable" : "unavailable",
        workerRuntime,
        // Preserve the live child phase even when a boot restore failure takes
        // precedence; a later serving boolean does not prove that full restore.
        supervisor: snapshot.state,
        ...(degraded ? { degraded: true as const } : {}),
        ...(v2 ? { v2Workers: v2 } : {}),
        ...(backlog !== undefined ? { backlog } : {}),
        ...(passes ? { backgroundPasses: passes } : {}),
      },
      ready ? 200 : 503,
    );
  };
}

/** The Bun entry uses this exact composition so diagnostics bypass product work. */
export function createSelfhostBunFetchHandler(input: {
  readonly health: SelfhostHealthHandler;
  readonly provision: (request: Request) => Promise<Response | null | undefined>;
  readonly appFetch: (request: Request) => Promise<Response>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    const health = await input.health(request);
    if (health) return health;
    return (await input.provision(request)) ?? (await input.appFetch(request));
  };
}
