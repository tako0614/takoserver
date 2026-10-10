import type { Sql } from "./ports.ts";
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
  /** Present only when a v2 Worker composition is mounted and could be read. */
  readonly v2Workers?: SelfhostV2WorkerHealth;
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
 * read and one bounded observation of the accepted child listener.
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
    // Restore failure and a failed legacy runtime keep precedence. An owner the
    // Host could not read, or one that lost its child, is unavailable; v2
    // owners that serve turn "no workload" into "serving".
    const workerRuntime: SelfhostRuntimeHealth =
      runtime === "restore-failed" || runtime === "unavailable"
        ? runtime
        : v2 === null || (v2 !== undefined && v2.unavailable > 0)
          ? "unavailable"
          : v2 !== undefined && v2.serving > 0 && runtime === "not-required"
            ? "serving"
            : runtime;
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
        ...(v2 ? { v2Workers: v2 } : {}),
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
