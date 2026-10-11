/**
 * Readiness used to answer 200 with nothing else while v2 Operations sat in
 * `reconciling`, Queue batches stayed sent and unretired, or a background pass
 * failed on every tick. These tests pin the counts that make that visible,
 * the indexes that keep them cheap on unpruned history, and the rule that none
 * of them makes the probe 503: they only set `degraded`.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSelfhostHealthHandler } from "../src/selfhost-health.ts";
import {
  createSelfhostBackgroundPassRecorder,
  createSelfhostBacklogObserver,
  SELFHOST_BACKLOG_QUERIES,
  type SelfhostBacklogHealth,
} from "../src/selfhost-health-signals.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const NOW = new Date("2026-10-11T12:00:00.000Z");
const MINUTE = 60_000;
const OLD = NOW.getTime() - 30 * MINUTE;
const FRESH = NOW.getTime() - MINUTE;
const PRINCIPAL = "org:tenant-principal-must-not-leak";
const FORM = "https://forms.example.test/forms/Thing/1.0.0/";

type OperationStatus =
  | "queued"
  | "running"
  | "waiting_input"
  | "reconciling"
  | "succeeded"
  | "failed";

function migratedDatabase(): Database {
  const database = new Database(":memory:");
  migrateSqlite(database);
  return database;
}

/** One Resource and its one Operation, inserted in a state the schema accepts. */
function seedOperation(
  database: Database,
  id: string,
  status: OperationStatus,
  createdAtMs: number,
  nextAttemptAtMs = 0,
): void {
  const at = new Date(createdAtMs).toISOString();
  const terminal = status === "succeeded" || status === "failed";
  database
    .prepare(
      `INSERT INTO tf_v2_resources
        (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
         observed_generation,phase,spec_json,observed_json,output_json,last_operation,busy_operation)
       VALUES (?,?,?,'default',?,'test-backend','test-target',?,1,0,?,'{}','{}','{}',?,?)`,
    )
    .run(
      `resource-${id}`,
      PRINCIPAL,
      FORM,
      `name-${id}`,
      `name-${id}`,
      terminal ? "idle" : "pending",
      id,
      terminal ? null : id,
    );
  const effect =
    status === "succeeded"
      ? "complete"
      : status === "failed"
        ? "none"
        : status === "reconciling"
          ? "unknown"
          : "none";
  database
    .prepare(
      `INSERT INTO tf_v2_operations
        (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
         created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json,
         next_attempt_at_ms,error_code,error_message)
       VALUES (?,?,?,?,'fp','create',1,?,?,?,?,'2026-10-20T00:00:00.000Z','test-backend',
         'test-target',?,'{}',?,?,?)`,
    )
    .run(
      id,
      `resource-${id}`,
      PRINCIPAL,
      `replay-${id}`,
      status,
      effect,
      at,
      at,
      `backend-${id}`,
      nextAttemptAtMs,
      status === "failed" ? "test_failure" : null,
      status === "failed" ? "test failure" : null,
    );
}

/**
 * Batch executions are written only through the Consumer acceptance guards in
 * production. This reader test needs rows in each state without a whole Queue
 * graph, so it drops the guards on its own disposable database only.
 */
function allowDirectExecutionRows(database: Database): void {
  const triggers = database
    .query(
      "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'queue_v2_batch_executions'",
    )
    .all() as { name: string }[];
  for (const { name } of triggers) database.exec(`DROP TRIGGER "${name}"`);
}

function seedExecution(
  database: Database,
  batchId: string,
  consumerUid: string,
  state: "registered" | "send_authorized" | "retired",
  sentAtMs: number,
): void {
  const reservedAtMs = sentAtMs - 1_000;
  const sent = state !== "registered";
  database
    .prepare(
      `INSERT INTO queue_v2_batch_executions
        (batch_id,reservation_token,lease_token,queue_id,consumer_uid,consumer_generation,
         worker_uid,consumer_spec_json,serving_source_operation_id,selected_versions_json,
         principal,space,target_key,max_concurrency,reserved_at_ms,reservation_until_ms,state,
         message_count,worker_version_uid,worker_version_generation,incarnation_operation_id,
         send_authorized_at_ms,retired_at_ms,retirement_kind,retirement_receipt_digest)
       VALUES (?,?,?,'queue-1',?,1,'worker-1','{}','source-op','[]',?,'default','test-target',
         10,?,?,?,1,?,?,?,?,?,?,?)`,
    )
    .run(
      batchId,
      `reservation-${batchId}`,
      `lease-${batchId}`,
      consumerUid,
      PRINCIPAL,
      reservedAtMs,
      reservedAtMs + 120_000,
      state,
      sent ? "version-1" : null,
      sent ? 1 : null,
      sent ? "incarnation-op" : null,
      sent ? sentAtMs : null,
      state === "retired" ? sentAtMs + 1_000 : null,
      state === "retired" ? "handler_and_wait_until" : null,
      state === "retired" ? `receipt-${batchId}` : null,
    );
}

function seededBacklog(): Database {
  const database = migratedDatabase();
  seedOperation(database, "op-old-queued", "queued", OLD);
  seedOperation(database, "op-old-running-1", "running", OLD);
  seedOperation(database, "op-old-running-2", "running", OLD);
  seedOperation(database, "op-old-reconciling", "reconciling", OLD);
  seedOperation(database, "op-old-waiting", "waiting_input", OLD);
  seedOperation(database, "op-fresh-reconciling", "reconciling", FRESH);
  seedOperation(database, "op-old-succeeded", "succeeded", OLD);
  seedOperation(database, "op-old-failed", "failed", OLD);
  allowDirectExecutionRows(database);
  seedExecution(database, "batch-old-a", "consumer-a", "send_authorized", OLD);
  seedExecution(database, "batch-old-b", "consumer-b", "send_authorized", OLD);
  seedExecution(database, "batch-fresh-a", "consumer-a", "send_authorized", FRESH);
  seedExecution(database, "batch-old-retired", "consumer-c", "retired", OLD);
  seedExecution(database, "batch-old-registered", "consumer-c", "registered", OLD);
  return database;
}

const idleSupervisor = {
  snapshot: () => ({ state: "idle" as const }),
  async probeReadiness() {
    return { snapshot: { state: "idle" as const }, listenerReady: null };
  },
};

async function readReady(handler: ReturnType<typeof createSelfhostHealthHandler>) {
  const response = await handler(new Request("http://host.test/_takoserver/health/ready"));
  if (!response) throw new Error("readiness route did not answer");
  const text = await response.text();
  return { status: response.status, text, body: JSON.parse(text) as Record<string, unknown> };
}

test("backlog counts only unsettled work older than the threshold, by status", async () => {
  const database = seededBacklog();
  const observer = createSelfhostBacklogObserver({
    sql: createSqliteSql(database),
    now: () => NOW,
  });
  expect(await observer.observe()).toEqual({
    olderThanSeconds: 600,
    operations: { queued: 1, running: 2, reconciling: 1, waitingInput: 1 },
    queueExecutions: { sendAuthorized: 2 },
  });

  // A shorter threshold takes in the fresh items as well.
  const everything = createSelfhostBacklogObserver({
    sql: createSqliteSql(database),
    now: () => NOW,
    stalledAfterMs: 30_000,
  });
  expect(await everything.observe()).toEqual({
    olderThanSeconds: 30,
    operations: { queued: 1, running: 2, reconciling: 2, waitingInput: 1 },
    queueExecutions: { sendAuthorized: 3 },
  });
  database.close();
});

test("an empty ledger reads as zero, not as missing", async () => {
  const database = migratedDatabase();
  const observer = createSelfhostBacklogObserver({
    sql: createSqliteSql(database),
    now: () => NOW,
  });
  expect(await observer.observe()).toEqual({
    olderThanSeconds: 600,
    operations: { queued: 0, running: 0, reconciling: 0, waitingInput: 0 },
    queueExecutions: { sendAuthorized: 0 },
  });
  database.close();
});

test("backlog reads are index searches, never a scan of the unpruned history tables", () => {
  const database = seededBacklog();
  const plan = (statement: string, parameter: string | number) =>
    (database.query(`EXPLAIN QUERY PLAN ${statement}`).all(parameter) as { detail: string }[]).map(
      (row) => row.detail,
    );
  const operations = plan(SELFHOST_BACKLOG_QUERIES.operations, NOW.toISOString());
  expect(operations).toEqual([
    "SEARCH tf_v2_operations USING COVERING INDEX tf_v2_operations_work (status=?)",
  ]);
  const executions = plan(SELFHOST_BACKLOG_QUERIES.queueExecutions, NOW.getTime());
  // Only the recursive CTE itself is scanned; every table access is an index seek.
  for (const line of executions) {
    if (line.startsWith("SCAN ")) expect(line).toBe("SCAN consumer");
  }
  expect(executions).toContain(
    "SEARCH execution USING INDEX queue_v2_batch_executions_open_consumer (consumer_uid=? AND state=?)",
  );
  expect(executions).toContain(
    "SEARCH next USING COVERING INDEX queue_v2_batch_executions_open_consumer (consumer_uid>?)",
  );
  database.close();
});

test("a missing backlog index is refused instead of silently scanning", async () => {
  const database = migratedDatabase();
  database.exec("DROP INDEX tf_v2_operations_work");
  const observer = createSelfhostBacklogObserver({
    sql: createSqliteSql(database),
    now: () => NOW,
  });
  await expect(observer.observe()).rejects.toThrow("no such index");
  database.close();
});

test("readiness stays 200 but degrades for stalled work, with counts and no identifiers", async () => {
  const database = seededBacklog();
  const sql = createSqliteSql(database);
  const handler = createSelfhostHealthHandler({
    sql,
    startupRestore: "empty",
    supervisor: idleSupervisor,
    v2Workers: { observe: async () => ({ owners: 1, serving: 1, unavailable: 0 }) },
    backlog: createSelfhostBacklogObserver({ sql, now: () => NOW }),
    backgroundPasses: createSelfhostBackgroundPassRecorder(),
  });
  const result = await readReady(handler);
  expect(result.status).toBe(200);
  expect(result.body).toEqual({
    status: "ready",
    database: "readable",
    workerRuntime: "serving",
    supervisor: "idle",
    degraded: true,
    v2Workers: { owners: 1, serving: 1, unavailable: 0 },
    backlog: {
      olderThanSeconds: 600,
      operations: { queued: 1, running: 2, reconciling: 1, waitingInput: 1 },
      queueExecutions: { sendAuthorized: 2 },
    },
    backgroundPasses: { failing: 0, stalled: 0 },
  });
  for (const identifier of [PRINCIPAL, "op-old", "resource-", "batch-", "consumer-", FORM]) {
    expect(result.text).not.toContain(identifier);
  }
  database.close();
});

test("only Host-side backlog degrades: waiting for a client's inputs does not", async () => {
  const database = migratedDatabase();
  seedOperation(database, "op-waiting", "waiting_input", OLD);
  seedOperation(database, "op-fresh", "queued", FRESH);
  const sql = createSqliteSql(database);
  const result = await readReady(
    createSelfhostHealthHandler({
      sql,
      startupRestore: "empty",
      supervisor: idleSupervisor,
      backlog: createSelfhostBacklogObserver({ sql, now: () => NOW }),
    }),
  );
  expect(result.status).toBe(200);
  expect(result.body.degraded).toBeUndefined();
  expect(result.body.backlog).toEqual({
    olderThanSeconds: 600,
    operations: { queued: 0, running: 0, reconciling: 0, waitingInput: 1 },
    queueExecutions: { sendAuthorized: 0 },
  });
  database.close();
});

function handlerWithBacklog(
  observe: () => Promise<SelfhostBacklogHealth>,
  options: { databaseFails?: boolean; timeoutMs?: number } = {},
) {
  let observed = 0;
  const handler = createSelfhostHealthHandler({
    sql: {
      async query() {
        if (options.databaseFails) throw new Error("database is locked");
        return [{ selfhost_health: 1 }];
      },
    },
    startupRestore: "empty",
    supervisor: idleSupervisor,
    backlog: {
      observe() {
        observed += 1;
        return observe();
      },
    },
    ...(options.timeoutMs ? { databaseCheckTimeoutMs: options.timeoutMs } : {}),
  });
  return { handler, observed: () => observed };
}

test("an unreadable backlog degrades instead of failing readiness, and never leaks its cause", async () => {
  const thrown = handlerWithBacklog(async () => {
    throw new Error("/srv/takoserver/control.sqlite: private detail");
  });
  const failed = await readReady(thrown.handler);
  expect(failed.status).toBe(200);
  expect(failed.body).toMatchObject({ status: "ready", degraded: true, backlog: "unavailable" });
  expect(failed.text).not.toContain("private detail");
  expect(failed.text).not.toContain("/srv/");

  const hung = handlerWithBacklog(() => new Promise(() => undefined), { timeoutMs: 20 });
  const timedOut = await readReady(hung.handler);
  expect(timedOut.status).toBe(200);
  expect(timedOut.body).toMatchObject({ degraded: true, backlog: "unavailable" });

  const malformed = handlerWithBacklog(
    async () => ({ olderThanSeconds: 600, operations: { queued: -1 } }) as never,
  );
  expect((await readReady(malformed.handler)).body.backlog).toBe("unavailable");
});

test("an unreadable database keeps its 503 and is not read again for the backlog", async () => {
  const probe = handlerWithBacklog(
    async () => ({
      olderThanSeconds: 600,
      operations: { queued: 0, running: 0, reconciling: 0, waitingInput: 0 },
      queueExecutions: { sendAuthorized: 0 },
    }),
    { databaseFails: true },
  );
  const result = await readReady(probe.handler);
  expect(result.status).toBe(503);
  expect(result.body.database).toBe("unavailable");
  expect(result.body.backlog).toBeUndefined();
  expect(probe.observed()).toBe(0);
});

test("a failing background pass degrades until it succeeds, reporting only its name and age", async () => {
  let clock = 1_000;
  const recorder = createSelfhostBackgroundPassRecorder({ now: () => clock });
  const cause = new Error("SQLITE_BUSY at /srv/takoserver/control.sqlite operator-token=hidden");
  const failing = recorder.observe("takoform-v2", async () => {
    throw cause;
  });
  // The wrapper changes nothing about the outcome the shutdown owner reports.
  await expect(failing()).rejects.toBe(cause);
  clock += 5_400;
  const handler = createSelfhostHealthHandler({
    sql: {
      async query() {
        return [{ selfhost_health: 1 }];
      },
    },
    startupRestore: "empty",
    supervisor: idleSupervisor,
    backgroundPasses: recorder,
  });
  const degraded = await readReady(handler);
  expect(degraded.status).toBe(200);
  expect(degraded.body).toEqual({
    status: "ready",
    database: "readable",
    workerRuntime: "not-required",
    supervisor: "idle",
    degraded: true,
    backgroundPasses: {
      failing: 1,
      stalled: 0,
      lastFailure: { name: "takoform-v2", ageSeconds: 5 },
    },
  });
  expect(degraded.text).not.toContain("SQLITE_BUSY");
  expect(degraded.text).not.toContain("operator-token");

  // Another pass succeeding does not clear it; the same pass succeeding does.
  await recorder.observe("settlement", async () => undefined)();
  expect(recorder.snapshot().failing).toBe(1);
  await recorder.observe("takoform-v2", async () => undefined)();
  clock += 60_000;
  const recovered = await readReady(handler);
  expect(recovered.body.degraded).toBeUndefined();
  expect(recovered.body.backgroundPasses).toEqual({
    failing: 0,
    stalled: 0,
    lastFailure: { name: "takoform-v2", ageSeconds: 65 },
  });
});

test("a pass running past the threshold counts as stalled until it settles", async () => {
  let clock = 0;
  const recorder = createSelfhostBackgroundPassRecorder({
    now: () => clock,
    stalledAfterMs: 10_000,
  });
  let release!: () => void;
  const running = recorder.observe(
    "queue-pump",
    () => new Promise<void>((resolve) => (release = resolve)),
  )();
  clock = 10_000;
  expect(recorder.snapshot()).toEqual({ failing: 0, stalled: 0 });
  clock = 10_001;
  expect(recorder.snapshot()).toEqual({ failing: 0, stalled: 1 });
  release();
  await running;
  expect(recorder.snapshot()).toEqual({ failing: 0, stalled: 0 });
});

test("pass names that are not fixed source names are reported without their text", async () => {
  const recorder = createSelfhostBackgroundPassRecorder({ now: () => 0 });
  await expect(
    recorder.observe("tenant org:secret /path", async () => {
      throw new Error("boom");
    })(),
  ).rejects.toThrow("boom");
  expect(recorder.snapshot()).toEqual({
    failing: 1,
    stalled: 0,
    lastFailure: { name: "unnamed", ageSeconds: 0 },
  });

  // A recorder that cannot answer is one failing pass, not a failed probe.
  const handler = createSelfhostHealthHandler({
    sql: {
      async query() {
        return [{ selfhost_health: 1 }];
      },
    },
    startupRestore: "empty",
    supervisor: idleSupervisor,
    backgroundPasses: {
      snapshot() {
        throw new Error("recorder detail");
      },
    },
  });
  const result = await readReady(handler);
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ degraded: true, backgroundPasses: { failing: 1 } });
  expect(result.text).not.toContain("recorder detail");
});

const ENTRY = join(import.meta.dir, "..", "src", "entry-bun.ts");

async function unusedPort(): Promise<number> {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null, { status: 503 }),
  });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

test("the Bun entry composes the backlog and pass signals into its readiness answer", async () => {
  const base = await mkdtemp(join(tmpdir(), "selfhost-health-signals-"));
  const dataRoot = join(base, "data");
  await mkdir(dataRoot, { mode: 0o700 });
  // Accepted long ago and not due for days: the engine will not touch it while
  // this test runs, so it is exactly a stalled Operation as the probe sees one.
  const database = new Database(join(dataRoot, "control.sqlite"));
  migrateSqlite(database);
  seedOperation(
    database,
    "op-stalled",
    "queued",
    Date.now() - 60 * MINUTE,
    Date.now() + 86_400_000,
  );
  database.close();
  const port = await unusedPort();
  const child = Bun.spawn([process.execPath, "--no-env-file", ENTRY], {
    cwd: base,
    stdin: "ignore",
    stdout: "ignore",
    stderr: "pipe",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: base,
      TMPDIR: base,
      CI: "1",
      NO_COLOR: "1",
      PORT: String(port),
      TAKOSERVER_DATA_ROOT: dataRoot,
      TAKOSERVER_PUBLIC_ORIGIN: "https://health-signals.takoserver.test",
      TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      }),
      TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: base64UrlEncode(new Uint8Array(32).fill(0x68)),
    },
  });
  try {
    let answer: { status: number; text: string } | undefined;
    const deadline = Date.now() + 20_000;
    while (!answer && Date.now() < deadline && child.exitCode === null) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/_takoserver/health/ready`, {
          signal: AbortSignal.timeout(1_000),
        });
        answer = { status: response.status, text: await response.text() };
      } catch {
        await Bun.sleep(50);
      }
    }
    if (!answer) {
      if (child.exitCode === null) child.kill("SIGKILL");
      await child.exited;
      throw new Error(`entry never answered: ${await new Response(child.stderr).text()}`);
    }
    expect(answer.status).toBe(200);
    const body = JSON.parse(answer.text) as Record<string, unknown>;
    expect(body).toMatchObject({
      status: "ready",
      degraded: true,
      backlog: {
        olderThanSeconds: 600,
        operations: { queued: 1, running: 0, reconciling: 0, waitingInput: 0 },
        queueExecutions: { sendAuthorized: 0 },
      },
      backgroundPasses: { failing: 0, stalled: 0 },
    });
    expect(answer.text).not.toContain("op-stalled");
    expect(answer.text).not.toContain(PRINCIPAL);
  } finally {
    if (child.exitCode === null) child.kill("SIGTERM");
    const code = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
    if (code === null) {
      child.kill("SIGKILL");
      await child.exited;
    }
    await rm(base, { recursive: true, force: true });
  }
});
