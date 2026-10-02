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

export interface SelfhostHealthResponse {
  readonly status: "ready" | "not_ready" | "live";
  readonly database?: "readable" | "unavailable";
  readonly workerRuntime?: SelfhostRuntimeHealth;
  readonly supervisor?: WorkerdSupervisorState;
}

export type SelfhostHealthHandler = (request: Request) => Promise<Response | undefined>;

const DEFAULT_DATABASE_CHECK_TIMEOUT_MS = 1_000;

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

function healthResponse(body: SelfhostHealthResponse, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store" },
  });
}

/**
 * Read-only Bun self-host health routes. Runtime recovery remains owned by the
 * supervisor and startup restore; these requests only observe their current
 * states and issue one bounded SQL read.
 */
export function createSelfhostHealthHandler(input: {
  readonly sql: Pick<Sql, "query">;
  readonly startupRestore: SelfhostStartupRestoreOutcome;
  readonly supervisor: Pick<WorkerdSupervisor, "snapshot">;
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
    // Snapshot only after the SQL read so the runtime phase is as current as
    // possible at the point this response is formed.
    const snapshot = input.supervisor.snapshot();
    const runtime = runtimeHealth(input.startupRestore, snapshot.state);
    const ready = databaseReady && (runtime === "not-required" || runtime === "serving");
    return healthResponse(
      {
        status: ready ? "ready" : "not_ready",
        database: databaseReady ? "readable" : "unavailable",
        workerRuntime: runtime,
        // Preserve the live child phase even when a boot restore failure takes
        // precedence; a later serving boolean does not prove that full restore.
        supervisor: snapshot.state,
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
