/**
 * Readiness used to answer 200 with nothing else while v2 Operations sat in
 * `reconciling`, Queue batches stayed sent and unretired, or a background pass
 * failed on every tick. These tests pin the counts that make that visible, the
 * query plans that keep them bounded on unpruned history with and without
 * planner statistics, the background sampling that keeps that SQL off the
 * unauthenticated probe, and the rule that none of them makes the probe 503:
 * they only set `degraded`.
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { base64UrlEncode } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSelfhostEntryShutdown } from "../src/selfhost-entry-shutdown.ts";
import { createSelfhostHealthHandler } from "../src/selfhost-health.ts";
import {
  createSelfhostBackgroundPassRecorder,
  createSelfhostBacklogObserver,
  createSelfhostBacklogSampler,
  observeSelfhostBackgroundPasses,
  SELFHOST_BACKLOG_QUERIES,
  type SelfhostBackgroundPassHealth,
  type SelfhostBacklogCounts,
  type SelfhostBacklogHealth,
} from "../src/selfhost-health-signals.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { migrateSqliteDatabase } from "./helpers/migrated-database.ts";

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
  const database = migrateSqliteDatabase();
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

/** The process started long before every seeded item, unless a test says otherwise. */
const LONG_UP = NOW.getTime() - 24 * 60 * MINUTE;

test("backlog counts only unsettled work older than the threshold, by status", async () => {
  const database = seededBacklog();
  const observer = createSelfhostBacklogObserver({
    sql: createSqliteSql(database),
    now: () => NOW,
    startedAtMs: LONG_UP,
  });
  expect(await observer.observe()).toEqual({
    operations: { queued: 1, running: 2, reconciling: 1, waitingInput: 1 },
    queueExecutions: { sendAuthorized: 2 },
  });

  // A shorter threshold takes in the fresh items as well.
  const everything = createSelfhostBacklogObserver({
    sql: createSqliteSql(database),
    now: () => NOW,
    startedAtMs: LONG_UP,
    stalledAfterMs: 30_000,
  });
  expect(await everything.observe()).toEqual({
    operations: { queued: 1, running: 2, reconciling: 2, waitingInput: 1 },
    queueExecutions: { sendAuthorized: 3 },
  });
  database.close();
});

test("work that waited out a stopped Host is not stalled until the Host has run that long", async () => {
  const database = seededBacklog();
  const sql = createSqliteSql(database);
  let queries = 0;
  const counting = {
    async query(statement: string, params?: readonly (string | number | null)[]) {
      queries += 1;
      return await sql.query(statement, params);
    },
  };
  // Up for five minutes: everything seeded is older, but none of it has been
  // pending for ten minutes of this process's life. No SQL is spent on it.
  const justStarted = createSelfhostBacklogObserver({
    sql: counting,
    now: () => NOW,
    startedAtMs: NOW.getTime() - 5 * MINUTE,
  });
  expect(await justStarted.observe()).toEqual({
    operations: { queued: 0, running: 0, reconciling: 0, waitingInput: 0 },
    queueExecutions: { sendAuthorized: 0 },
  });
  expect(queries).toBe(0);

  // Up for exactly the threshold: the old items now count.
  const upLongEnough = createSelfhostBacklogObserver({
    sql: counting,
    now: () => NOW,
    startedAtMs: NOW.getTime() - 10 * MINUTE,
  });
  expect((await upLongEnough.observe()).operations.reconciling).toBe(1);
  expect(queries).toBe(2);
  database.close();
});

test("an empty ledger reads as zero, not as missing", async () => {
  const database = migratedDatabase();
  const observer = createSelfhostBacklogObserver({
    sql: createSqliteSql(database),
    now: () => NOW,
    startedAtMs: LONG_UP,
  });
  expect(await observer.observe()).toEqual({
    operations: { queued: 0, running: 0, reconciling: 0, waitingInput: 0 },
    queueExecutions: { sendAuthorized: 0 },
  });
  database.close();
});

/** Settled history of the kind neither table ever prunes, spread over three Consumers. */
function addSettledHistory(database: Database, rows: number): void {
  const operation = database.prepare(
    `INSERT INTO tf_v2_operations
      (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
       created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
     VALUES (?,?,?,?,'fp','create',1,'succeeded','complete',?,?,'2027-01-01T00:00:00.000Z',
       'test-backend','test-target',?,'{}')`,
  );
  const execution = database.prepare(
    `INSERT INTO queue_v2_batch_executions
      (batch_id,reservation_token,lease_token,queue_id,consumer_uid,consumer_generation,
       worker_uid,consumer_spec_json,serving_source_operation_id,selected_versions_json,
       principal,space,target_key,max_concurrency,reserved_at_ms,reservation_until_ms,state,
       message_count,worker_version_uid,worker_version_generation,incarnation_operation_id,
       send_authorized_at_ms,retired_at_ms,retirement_kind,retirement_receipt_digest)
     VALUES (?,?,?,'queue-1',?,1,'worker-1','{}','source-op','[]',?,'default','test-target',
       10,?,?,'retired',1,'version-1',1,'incarnation-op',?,?,'handler_and_wait_until',?)`,
  );
  database.transaction(() => {
    for (let index = 0; index < rows; index += 1) {
      const at = OLD - (index + 1) * 1_000;
      const iso = new Date(at).toISOString();
      operation.run(
        `history-${index}`,
        `resource-op-old-queued`,
        PRINCIPAL,
        `history-${index}`,
        iso,
        iso,
        `history-${index}`,
      );
      execution.run(
        `history-${index}`,
        `reservation-history-${index}`,
        `lease-history-${index}`,
        `consumer-${["a", "b", "c"][index % 3]}`,
        PRINCIPAL,
        at,
        at + 120_000,
        at + 1,
        at + 2,
        `receipt-history-${index}`,
      );
    }
  })();
}

function queryPlan(database: Database, statement: string, parameter: string | number): string[] {
  return (
    database.query(`EXPLAIN QUERY PLAN ${statement}`).all(parameter) as { detail: string }[]
  ).map((row) => row.detail);
}

function expectBoundedPlans(database: Database): void {
  expect(queryPlan(database, SELFHOST_BACKLOG_QUERIES.operations, NOW.toISOString())).toEqual([
    "SEARCH tf_v2_operations USING COVERING INDEX tf_v2_operations_work (status=?)",
  ]);
  const executions = queryPlan(database, SELFHOST_BACKLOG_QUERIES.queueExecutions, NOW.getTime());
  // Only the recursive CTE itself is scanned; every table access is an index
  // seek, and the execution search is driven by each Consumer UID.
  for (const line of executions) {
    if (line.startsWith("SCAN ")) expect(line).toBe("SCAN consumer");
  }
  expect(executions.slice(-2)).toEqual([
    "SCAN consumer",
    "SEARCH execution USING INDEX queue_v2_batch_executions_open_consumer (consumer_uid=? AND state=?)",
  ]);
  expect(executions).toContain(
    "SEARCH next USING COVERING INDEX queue_v2_batch_executions_open_consumer (consumer_uid>?)",
  );
}

test("backlog plans stay index searches with and without planner statistics", async () => {
  for (const collect of ["none", "ANALYZE", "PRAGMA optimize=0x10002"] as const) {
    const database = seededBacklog();
    addSettledHistory(database, 2_000);
    if (collect !== "none") database.exec(collect);
    expectBoundedPlans(database);
    // The fixture is large enough to provoke the planner: with statistics the
    // same age filter inside the index becomes a skip-scan over all history.
    const unguarded = queryPlan(
      database,
      SELFHOST_BACKLOG_QUERIES.operations.replace("+created_at", "created_at"),
      NOW.toISOString(),
    );
    if (collect === "none") {
      expect(unguarded).toEqual([
        "SEARCH tf_v2_operations USING COVERING INDEX tf_v2_operations_work (status=?)",
      ]);
    } else {
      expect(unguarded[0]).toContain("ANY(status) AND ANY(lease_until_ms) AND created_at<?");
    }
    // The counts are unchanged by the settled history.
    const observer = createSelfhostBacklogObserver({
      sql: createSqliteSql(database),
      now: () => NOW,
      startedAtMs: LONG_UP,
    });
    expect(await observer.observe()).toEqual({
      operations: { queued: 1, running: 2, reconciling: 1, waitingInput: 1 },
      queueExecutions: { sendAuthorized: 2 },
    });
    database.close();
  }
});

test("a missing backlog index is refused instead of silently scanning", async () => {
  const database = migratedDatabase();
  database.exec("DROP INDEX tf_v2_operations_work");
  const observer = createSelfhostBacklogObserver({
    sql: createSqliteSql(database),
    now: () => NOW,
    startedAtMs: LONG_UP,
  });
  await expect(observer.observe()).rejects.toThrow("no such index");
  database.close();
});

function counts(reconciling: number): SelfhostBacklogCounts {
  return {
    operations: { queued: 0, running: 0, reconciling, waitingInput: 0 },
    queueExecutions: { sendAuthorized: 0 },
  };
}

test("the sampler serves its latest sample from memory and goes unavailable when stale", async () => {
  let clock = 0;
  let next: SelfhostBacklogCounts | Error = counts(2);
  let observed = 0;
  const sampler = createSelfhostBacklogSampler({
    observer: {
      async observe() {
        observed += 1;
        if (next instanceof Error) throw next;
        return next;
      },
    },
    now: () => clock,
    staleAfterMs: 60_000,
  });
  expect(sampler.snapshot()).toBe("unavailable");

  await sampler.refresh();
  clock = 4_500;
  expect(sampler.snapshot()).toEqual({
    olderThanSeconds: 600,
    sampledSecondsAgo: 4,
    operations: { queued: 0, running: 0, reconciling: 2, waitingInput: 0 },
    queueExecutions: { sendAuthorized: 0 },
  });
  // Reading the snapshot never samples.
  sampler.snapshot();
  expect(observed).toBe(1);

  // A failed refresh rejects for the pass to report and keeps the last sample...
  next = new Error("database is locked");
  await expect(sampler.refresh()).rejects.toThrow("database is locked");
  clock = 60_000;
  expect(sampler.snapshot()).toMatchObject({ sampledSecondsAgo: 60 });
  // ...only until it is stale.
  clock = 60_001;
  expect(sampler.snapshot()).toBe("unavailable");

  next = counts(0);
  await sampler.refresh();
  expect(sampler.snapshot()).toMatchObject({ sampledSecondsAgo: 0 });
});

function sampled(value: SelfhostBacklogHealth | "unavailable" | (() => never)): {
  snapshot(): SelfhostBacklogHealth | "unavailable";
} {
  return { snapshot: () => (typeof value === "function" ? value() : value) };
}

const STALLED: SelfhostBacklogHealth = {
  olderThanSeconds: 600,
  sampledSecondsAgo: 3,
  operations: { queued: 1, running: 2, reconciling: 1, waitingInput: 1 },
  queueExecutions: { sendAuthorized: 2 },
};

test("readiness stays 200 but degrades for stalled work, and runs only SELECT 1 itself", async () => {
  const database = seededBacklog();
  const sql = createSqliteSql(database);
  const statements: string[] = [];
  const sampler = createSelfhostBacklogSampler({
    observer: createSelfhostBacklogObserver({ sql, now: () => NOW, startedAtMs: LONG_UP }),
  });
  await sampler.refresh();
  const handler = createSelfhostHealthHandler({
    sql: {
      async query(statement, params) {
        statements.push(statement);
        return await sql.query(statement, params);
      },
    },
    startupRestore: "empty",
    supervisor: idleSupervisor,
    v2Workers: { observe: async () => ({ owners: 1, serving: 1, unavailable: 0 }) },
    backlog: sampler,
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
      sampledSecondsAgo: 0,
      operations: { queued: 1, running: 2, reconciling: 1, waitingInput: 1 },
      queueExecutions: { sendAuthorized: 2 },
    },
    backgroundPasses: { failing: 0, stalled: 0 },
  });
  expect(statements).toEqual(["SELECT 1 AS selfhost_health"]);
  for (const identifier of [PRINCIPAL, "op-old", "resource-", "batch-", "consumer-", FORM]) {
    expect(result.text).not.toContain(identifier);
  }
  database.close();
});

test("only Host-side backlog degrades: waiting for a client's inputs does not", async () => {
  const result = await readReady(
    createSelfhostHealthHandler({
      sql: {
        async query() {
          return [{ selfhost_health: 1 }];
        },
      },
      startupRestore: "empty",
      supervisor: idleSupervisor,
      backlog: sampled({
        ...STALLED,
        operations: { queued: 0, running: 0, reconciling: 0, waitingInput: 1 },
        queueExecutions: { sendAuthorized: 0 },
      }),
    }),
  );
  expect(result.status).toBe(200);
  expect(result.body.degraded).toBeUndefined();
  expect((result.body.backlog as SelfhostBacklogHealth).operations.waitingInput).toBe(1);
});

function handlerWithBacklog(
  backlog: { snapshot(): SelfhostBacklogHealth | "unavailable" },
  options: { databaseFails?: boolean } = {},
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
      snapshot() {
        observed += 1;
        return backlog.snapshot();
      },
    },
  });
  return { handler, observed: () => observed };
}

test("a missing, broken or malformed sample degrades instead of failing readiness", async () => {
  const missing = await readReady(handlerWithBacklog(sampled("unavailable")).handler);
  expect(missing.status).toBe(200);
  expect(missing.body).toMatchObject({ status: "ready", degraded: true, backlog: "unavailable" });

  const thrown = await readReady(
    handlerWithBacklog(
      sampled(() => {
        throw new Error("/srv/takoserver/control.sqlite: private detail");
      }),
    ).handler,
  );
  expect(thrown.status).toBe(200);
  expect(thrown.body).toMatchObject({ degraded: true, backlog: "unavailable" });
  expect(thrown.text).not.toContain("private detail");
  expect(thrown.text).not.toContain("/srv/");

  const malformed = await readReady(
    handlerWithBacklog(sampled({ ...STALLED, sampledSecondsAgo: -1 })).handler,
  );
  expect(malformed.body.backlog).toBe("unavailable");
});

test("an unreadable database keeps its 503 and reports no backlog", async () => {
  const probe = handlerWithBacklog(sampled(STALLED), { databaseFails: true });
  const result = await readReady(probe.handler);
  expect(result.status).toBe(503);
  expect(result.body.database).toBe("unavailable");
  expect(result.body.backlog).toBeUndefined();
  expect(probe.observed()).toBe(0);
});

function readyWithPasses(recorder: { snapshot(): SelfhostBackgroundPassHealth }) {
  return createSelfhostHealthHandler({
    sql: {
      async query() {
        return [{ selfhost_health: 1 }];
      },
    },
    startupRestore: "empty",
    supervisor: idleSupervisor,
    backgroundPasses: recorder,
  });
}

test("a failing background pass degrades until it succeeds, as a count without its name or cause", async () => {
  const recorder = createSelfhostBackgroundPassRecorder({ now: () => 0 });
  const cause = new Error("SQLITE_BUSY at /srv/takoserver/control.sqlite operator-token=hidden");
  const failing = recorder.observe("takoform-v2", async () => {
    throw cause;
  });
  // The wrapper changes nothing about the outcome the shutdown owner reports.
  await expect(failing()).rejects.toBe(cause);
  const handler = readyWithPasses(recorder);
  const degraded = await readReady(handler);
  expect(degraded.status).toBe(200);
  expect(degraded.body).toEqual({
    status: "ready",
    database: "readable",
    workerRuntime: "not-required",
    supervisor: "idle",
    degraded: true,
    backgroundPasses: { failing: 1, stalled: 0 },
  });
  for (const text of ["takoform-v2", "SQLITE_BUSY", "operator-token", "/srv/"]) {
    expect(degraded.text).not.toContain(text);
  }

  // Another pass succeeding does not clear it; the same pass succeeding does.
  await recorder.observe("settlement", async () => undefined)();
  expect(recorder.snapshot()).toEqual({ failing: 1, stalled: 0 });
  await recorder.observe("takoform-v2", async () => undefined)();
  const recovered = await readReady(handler);
  expect(recovered.body.degraded).toBeUndefined();
  expect(recovered.body.backgroundPasses).toEqual({ failing: 0, stalled: 0 });
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

test("names that are not fixed source names share one bucket, and a broken recorder is one failure", async () => {
  const recorder = createSelfhostBackgroundPassRecorder({ now: () => 0 });
  for (const name of ["tenant org:secret /path", "Another Bad Name"]) {
    await expect(
      recorder.observe(name, async () => {
        throw new Error("boom");
      })(),
    ).rejects.toThrow("boom");
  }
  expect(recorder.snapshot()).toEqual({ failing: 1, stalled: 0 });

  const result = await readReady(
    readyWithPasses({
      snapshot() {
        throw new Error("recorder detail");
      },
    }),
  );
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ degraded: true, backgroundPasses: { failing: 1 } });
  expect(result.text).not.toContain("recorder detail");
});

function shutdownOwner() {
  return createSelfhostEntryShutdown({
    stopIngress: async () => undefined,
    finishShutdown: async () => undefined,
    onFailure: () => undefined,
    onSuccess: () => undefined,
  });
}

test("observed intervals report a failure to the shutdown owner's callback and to the recorder", async () => {
  const shutdown = shutdownOwner();
  const recorder = createSelfhostBackgroundPassRecorder();
  const passes = observeSelfhostBackgroundPasses(shutdown, recorder);
  const cause = new Error("tick failed");
  let runs = 0;
  const failures: { name: string; cause: unknown }[] = [];
  const failedOnce = new Promise<void>((resolve) => {
    passes.startInterval(
      "takoform-v2",
      5,
      async () => {
        runs += 1;
        if (runs === 1) throw cause;
      },
      (name, reported) => {
        failures.push({ name, cause: reported });
        resolve();
      },
    );
  });
  await failedOnce;
  expect(failures).toEqual([{ name: "takoform-v2", cause }]);
  expect(recorder.snapshot().failing).toBe(1);
  // The next tick succeeds and clears the count; the callback is not called.
  while (runs < 2) await Bun.sleep(5);
  await Bun.sleep(5);
  expect(recorder.snapshot()).toEqual({ failing: 0, stalled: 0 });
  expect(failures).toHaveLength(1);
  expect(await shutdown.shutdown()).toBe(true);
});

test("observed passes keep single-flight, the caller's rejection and the stop fence", async () => {
  const shutdown = shutdownOwner();
  const recorder = createSelfhostBackgroundPassRecorder();
  const passes = observeSelfhostBackgroundPasses(shutdown, recorder);
  let release!: (error?: Error) => void;
  let firstRuns = 0;
  let secondRuns = 0;
  const first = passes.runPass("queue-pump", () => {
    firstRuns += 1;
    return new Promise<void>((resolve, reject) => {
      release = (error) => (error ? reject(error) : resolve());
    });
  });
  // A second request for the same name joins the running pass.
  const second = passes.runPass("queue-pump", () => {
    secondRuns += 1;
  });
  expect(second).toBe(first);
  await Bun.sleep(0);
  expect(firstRuns).toBe(1);
  const cause = new Error("pump failed");
  release(cause);
  await expect(first).rejects.toBe(cause);
  expect(secondRuns).toBe(0);
  expect(recorder.snapshot()).toEqual({ failing: 1, stalled: 0 });

  expect(await shutdown.shutdown()).toBe(true);
  let fencedRuns = 0;
  await passes.runPass("queue-pump", () => {
    fencedRuns += 1;
  });
  expect(fencedRuns).toBe(0);
  // Nothing ran past the fence, so the last recorded outcome stands.
  expect(recorder.snapshot()).toEqual({ failing: 1, stalled: 0 });
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

test("the Bun entry composes the backlog sample and pass counts into its readiness answer", async () => {
  const base = await mkdtemp(join(tmpdir(), "selfhost-health-signals-"));
  const dataRoot = join(base, "data");
  await mkdir(dataRoot, { mode: 0o700 });
  // Accepted an hour before this Host started and not due for days: it waited
  // out a stopped Host, so it is not counted as stalled the moment the Host
  // returns, and the engine will not touch it while this test runs.
  const database = new Database(join(dataRoot, "control.sqlite"));
  migrateSqlite(database);
  seedOperation(database, "op-waited", "queued", Date.now() - 60 * MINUTE, Date.now() + 86_400_000);
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
    // The first sample exists before the listener opens.
    expect(body).toMatchObject({
      status: "ready",
      backlog: {
        olderThanSeconds: 600,
        operations: { queued: 0, running: 0, reconciling: 0, waitingInput: 0 },
        queueExecutions: { sendAuthorized: 0 },
      },
      backgroundPasses: { failing: 0, stalled: 0 },
    });
    expect(body.degraded).toBeUndefined();
    expect(typeof (body.backlog as SelfhostBacklogHealth).sampledSecondsAgo).toBe("number");
    expect(answer.text).not.toContain("op-waited");
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
