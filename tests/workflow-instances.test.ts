import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Sql, SqlWrite } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  createWorkflowInstances,
  WORKFLOW_MAX_DOCUMENT_BYTES,
  WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS,
  WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS,
  type WorkflowScope,
} from "../src/workflow-instances.ts";

const MIGRATION = readFileSync(
  new URL("../migrations/0050_workflow_instances.sql", import.meta.url),
  "utf8",
);

const SCOPE: WorkflowScope = {
  tenantId: "tenant_a",
  workflowResourceUid: "workflow_uid_a",
};

const START = Date.UTC(2026, 0, 1);

interface Fixture {
  readonly database: Database;
  readonly sql: Sql;
  readonly clock: () => Date;
  setNow(value: number): void;
  readonly store: ReturnType<typeof createWorkflowInstances>;
}

const openFixtures: Database[] = [];

afterEach(() => {
  for (const database of openFixtures.splice(0)) database.close();
});

function fixture(randomIds = ["execution_a", "execution_b", "execution_c"]): Fixture {
  const database = new Database(":memory:");
  database.exec(MIGRATION);
  openFixtures.push(database);
  let timestamp = START;
  let next = 0;
  const clock = () => new Date(timestamp);
  const sql = createSqliteSql(database);
  const store = createWorkflowInstances({
    sql,
    clock,
    randomId: () => randomIds[next++] ?? `execution_${next}`,
  });
  return {
    database,
    sql,
    clock,
    setNow(value) {
      timestamp = value;
    },
    store,
  };
}

async function row(
  fixture: Fixture,
  sql: string,
  params: readonly (string | number | null)[] = [],
) {
  return (await fixture.sql.query(sql, params))[0];
}

describe("Durable workflow instance identity", () => {
  test("creates, resolves and persists one queued instance", async () => {
    const first = fixture(["execution_one"]);
    const created = await first.store.create(SCOPE, { id: "order-1", params: { amount: 3 } });
    expect(created).toEqual({ id: "order-1", status: "queued" });
    expect(await first.store.get(SCOPE, "order-1")).toEqual({ id: "order-1" });
    expect(await first.store.status(SCOPE, "order-1")).toEqual({ status: "queued" });

    // Reopening the domain object over the same durable SQL sees the exact row.
    const reopened = createWorkflowInstances({
      sql: first.sql,
      clock: first.clock,
      randomId: () => "execution_reopened",
    });
    expect(await reopened.status(SCOPE, "order-1")).toEqual({ status: "queued" });
    const stored = await row(
      first,
      "SELECT params_json, execution_id, revision FROM tf_workflow_instances WHERE tenant_id = ? AND workflow_resource_uid = ? AND instance_id = ?",
      [SCOPE.tenantId, SCOPE.workflowResourceUid, "order-1"],
    );
    expect(stored).toMatchObject({
      params_json: '{"amount":3}',
      execution_id: "execution_one",
      revision: 1,
    });
  });

  test("survives a file-backed close and reopen", async () => {
    const directory = mkdtempSync(join(tmpdir(), "takos-workflow-instances-reopen-"));
    const databasePath = join(directory, "state.sqlite");
    let database: Database | undefined;
    let reopenedDatabase: Database | undefined;
    try {
      database = new Database(databasePath);
      database.exec(MIGRATION);
      const sql = createSqliteSql(database);
      const timestamp = START;
      const store = createWorkflowInstances({
        sql,
        clock: () => new Date(timestamp),
        randomId: () => "execution_file",
      });
      await store.create(SCOPE, { id: "file-backed", params: { durable: true } });
      database.close();
      database = undefined;

      reopenedDatabase = new Database(databasePath);
      const reopenedSql = createSqliteSql(reopenedDatabase);
      const reopened = createWorkflowInstances({
        sql: reopenedSql,
        clock: () => new Date(timestamp),
        randomId: () => "execution_reopened_file",
      });
      expect(await reopened.status(SCOPE, "file-backed")).toEqual({ status: "queued" });
      expect(
        await reopenedSql.query(
          "SELECT params_json, execution_id FROM tf_workflow_instances WHERE instance_id = ?",
          ["file-backed"],
        ),
      ).toEqual([{ params_json: '{"durable":true}', execution_id: "execution_file" }]);
    } finally {
      reopenedDatabase?.close();
      database?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("holds a retained id and fences tenant, workflow and execution scopes", async () => {
    const f = fixture(["execution_a", "execution_b"]);
    await f.store.create(SCOPE, { id: "same" });
    await expect(f.store.create(SCOPE, { id: "same" })).rejects.toMatchObject({
      code: "instance_exists",
      name: "instance_exists",
    });
    await f.store.create(
      { tenantId: "tenant_b", workflowResourceUid: SCOPE.workflowResourceUid },
      { id: "same" },
    );
    await f.store.create(
      { tenantId: SCOPE.tenantId, workflowResourceUid: "workflow_uid_b" },
      { id: "same" },
    );

    await f.store.sendEvent(SCOPE, "same", { type: "before_wait", payload: { ok: true } });
    const events = await f.sql.query(
      "SELECT tenant_id, workflow_resource_uid, instance_id, execution_id, type, payload_json FROM tf_workflow_events ORDER BY event_id",
    );
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      tenant_id: SCOPE.tenantId,
      workflow_resource_uid: SCOPE.workflowResourceUid,
      instance_id: "same",
      execution_id: "execution_a",
      type: "before_wait",
      payload_json: '{"ok":true}',
    });
  });

  test("concurrent explicit creates have one winner", async () => {
    const f = fixture(["execution_concurrent_a", "execution_concurrent_b"]);
    const outcomes = await Promise.allSettled([
      f.store.create(SCOPE, { id: "concurrent" }),
      f.store.create(SCOPE, { id: "concurrent" }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    const rejected = outcomes.find((outcome) => outcome.status === "rejected");
    expect(rejected).toMatchObject({
      status: "rejected",
      reason: { code: "instance_exists" },
    });
  });
});

describe("Durable workflow events and terminal transitions", () => {
  test("retains an event before a wait and refuses events after termination", async () => {
    const f = fixture(["execution_events"]);
    await f.store.create(SCOPE, { id: "eventful" });
    await f.store.sendEvent(SCOPE, "eventful", { type: "approval" });
    expect(
      await f.sql.query(
        "SELECT type, payload_json FROM tf_workflow_events WHERE execution_id = ?",
        ["execution_events"],
      ),
    ).toEqual([{ type: "approval", payload_json: null }]);

    await f.store.terminate(SCOPE, "eventful");
    expect(await f.store.status(SCOPE, "eventful")).toEqual({ status: "terminated" });
    expect(
      await f.sql.query("SELECT COUNT(*) AS count FROM tf_workflow_events WHERE execution_id = ?", [
        "execution_events",
      ]),
    ).toEqual([{ count: 0 }]);
    await expect(f.store.sendEvent(SCOPE, "eventful", { type: "late" })).rejects.toMatchObject({
      code: "instance_terminal",
    });

    // A lost terminate response is safe to retry and preserves the terminal state.
    await f.store.terminate(SCOPE, "eventful");
    expect(await f.store.status(SCOPE, "eventful")).toEqual({ status: "terminated" });
  });

  test("sendEvent and terminate interleave without leaving an event", async () => {
    const f = fixture(["execution_interleave"]);
    await f.store.create(SCOPE, { id: "interleave" });
    const outcomes = await Promise.allSettled([
      f.store.sendEvent(SCOPE, "interleave", { type: "race" }),
      f.store.terminate(SCOPE, "interleave"),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).not.toHaveLength(0);
    expect(await f.store.status(SCOPE, "interleave")).toEqual({ status: "terminated" });
    expect(
      await f.sql.query("SELECT COUNT(*) AS count FROM tf_workflow_events WHERE instance_id = ?", [
        "interleave",
      ]),
    ).toEqual([{ count: 0 }]);
  });

  test("does not deliver a paused event to a reused execution id", async () => {
    const f = fixture(["execution_reused_event"]);
    await f.store.create(SCOPE, { id: "reused-event-race" });
    let releaseQuery!: () => void;
    let querySeen!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      querySeen = resolve;
    });
    let paused = true;
    const raceSql: Sql = {
      query: async (sql, params) => {
        const rows = await f.sql.query(sql, params);
        if (paused && sql.includes("SELECT execution_id, status, output_json, error_json")) {
          paused = false;
          querySeen();
          await release;
        }
        return rows;
      },
      run: (sql, params) => f.sql.run(sql, params),
      batch: (statements) => f.sql.batch(statements),
    };
    const pausedStore = createWorkflowInstances({
      sql: raceSql,
      clock: f.clock,
      randomId: () => "unused-race-id",
    });
    const pending = pausedStore.sendEvent(SCOPE, "reused-event-race", { type: "old" });
    await seen;

    const terminatedAt = START + 1;
    f.setNow(terminatedAt);
    await f.store.terminate(SCOPE, "reused-event-race");
    const replacementTime = terminatedAt + WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS * 1_000 + 1;
    const replacement = createWorkflowInstances({
      sql: f.sql,
      clock: () => new Date(replacementTime),
      randomId: () => "execution_reused_event",
    });
    await replacement.create(SCOPE, { id: "reused-event-race" });
    await replacement.sendEvent(SCOPE, "reused-event-race", { type: "replacement" });
    releaseQuery();

    await expect(pending).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(
      await f.sql.query("SELECT execution_id, type FROM tf_workflow_events WHERE instance_id = ?", [
        "reused-event-race",
      ]),
    ).toEqual([{ execution_id: "execution_reused_event", type: "replacement" }]);
  });

  test("does not terminate or delete events from a reused execution id", async () => {
    const f = fixture(["execution_reused_terminate"]);
    await f.store.create(SCOPE, { id: "reused-terminate-race" });
    let releaseQuery!: () => void;
    let querySeen!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      querySeen = resolve;
    });
    let paused = true;
    const raceSql: Sql = {
      query: async (sql, params) => {
        const rows = await f.sql.query(sql, params);
        if (paused && sql.includes("SELECT execution_id, status, output_json, error_json")) {
          paused = false;
          querySeen();
          await release;
        }
        return rows;
      },
      run: (sql, params) => f.sql.run(sql, params),
      batch: (statements) => f.sql.batch(statements),
    };
    const pausedStore = createWorkflowInstances({
      sql: raceSql,
      clock: f.clock,
      randomId: () => "unused-race-id",
    });
    const pending = pausedStore.terminate(SCOPE, "reused-terminate-race");
    await seen;

    const terminatedAt = START + 1;
    f.setNow(terminatedAt);
    await f.store.terminate(SCOPE, "reused-terminate-race");
    const replacementTime = terminatedAt + WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS * 1_000 + 1;
    const replacement = createWorkflowInstances({
      sql: f.sql,
      clock: () => new Date(replacementTime),
      randomId: () => "execution_reused_terminate",
    });
    await replacement.create(SCOPE, { id: "reused-terminate-race" });
    await replacement.sendEvent(SCOPE, "reused-terminate-race", { type: "replacement" });
    releaseQuery();

    await expect(pending).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(await replacement.status(SCOPE, "reused-terminate-race")).toEqual({ status: "queued" });
    expect(
      await f.sql.query("SELECT execution_id, type FROM tf_workflow_events WHERE instance_id = ?", [
        "reused-terminate-race",
      ]),
    ).toEqual([{ execution_id: "execution_reused_terminate", type: "replacement" }]);
  });

  test("lazy-settles at the lifetime deadline and uses deadline-based retention", async () => {
    const f = fixture(["execution_lifetime"]);
    await f.store.create(SCOPE, { id: "long-lived" });
    f.setNow(START + WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS * 1_000);
    expect(await f.store.status(SCOPE, "long-lived")).toEqual({
      status: "errored",
      error: { reason: "lifetime_exceeded" },
    });
    await expect(
      f.store.sendEvent(SCOPE, "long-lived", { type: "too-late" }),
    ).rejects.toMatchObject({
      code: "instance_terminal",
    });

    f.setNow(
      START +
        (WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS + WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS) * 1_000,
    );
    await expect(f.store.status(SCOPE, "long-lived")).rejects.toMatchObject({
      code: "unknown_instance",
    });
  });

  test("samples the clock once at the lifetime boundary", async () => {
    const f = fixture(["execution_clock_boundary"]);
    await f.store.create(SCOPE, { id: "clock-boundary" });
    const deadline = START + WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS * 1_000;
    let timestamp = deadline;
    let clockCalls = 0;
    const sampled = createWorkflowInstances({
      sql: f.sql,
      clock: () => {
        clockCalls += 1;
        return new Date(timestamp);
      },
      randomId: () => "execution_clock_boundary_reopened",
    });
    expect(await sampled.status(SCOPE, "clock-boundary")).toEqual({
      status: "errored",
      error: { reason: "lifetime_exceeded" },
    });
    expect(clockCalls).toBe(1);
    timestamp += 1;
    await sampled.terminate(SCOPE, "clock-boundary");
    expect(clockCalls).toBe(2);
    expect(await sampled.status(SCOPE, "clock-boundary")).toEqual({
      status: "errored",
      error: { reason: "lifetime_exceeded" },
    });
  });
});

describe("Durable workflow limits and backend fences", () => {
  test("rejects malformed data without invoking accessors or normalizing undefined/NaN", async () => {
    const f = fixture(["execution_limits"]);
    let getterCalls = 0;
    const params = {} as { readonly value?: unknown };
    Object.defineProperty(params, "value", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return 1;
      },
    });
    await expect(f.store.create(SCOPE, { id: "getter", params })).rejects.toMatchObject({
      code: "invalid_params",
    });
    expect(getterCalls).toBe(0);
    await expect(
      f.store.create(SCOPE, { id: "undefined", params: { value: undefined } }),
    ).rejects.toMatchObject({
      code: "invalid_params",
    });
    await expect(
      f.store.create(SCOPE, { id: "nan", params: { value: Number.NaN } }),
    ).rejects.toMatchObject({
      code: "invalid_params",
    });

    const tooLarge = { value: "x".repeat(WORKFLOW_MAX_DOCUMENT_BYTES) };
    await expect(f.store.create(SCOPE, { id: "large", params: tooLarge })).rejects.toMatchObject({
      code: "document_too_large",
    });

    const scalarText = "nul\u0000-and-astral-😀";
    await f.store.create(SCOPE, {
      id: scalarText,
      params: { value: scalarText },
    });
    await f.store.sendEvent(SCOPE, scalarText, {
      type: scalarText,
      payload: { value: scalarText },
    });
    expect(
      await f.sql.query(
        "SELECT instance_id, type, payload_json FROM tf_workflow_events WHERE instance_id = ?",
        [scalarText],
      ),
    ).toEqual([
      {
        instance_id: scalarText,
        type: scalarText,
        payload_json: '{"value":"nul\\u0000-and-astral-😀"}',
      },
    ]);

    await expect(
      f.store.create(SCOPE, { id: "lone-high", params: { value: "\ud800" } }),
    ).rejects.toMatchObject({ code: "invalid_params" });
    let deep: Record<string, unknown> = { ok: true };
    for (let index = 0; index < 192; index += 1) deep = { next: deep };
    await f.store.create(SCOPE, { id: "deep-valid", params: deep });

    const shared: Record<string, unknown> = { value: true };
    await f.store.create(SCOPE, { id: "shared-ref", params: { left: shared, right: shared } });
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    await expect(f.store.create(SCOPE, { id: "cyclic", params: cyclic })).rejects.toMatchObject({
      code: "invalid_params",
    });
  });

  test("accepts stack-hostile data within the published document bound", async () => {
    const f = fixture(["execution_deep"]);
    let deep: Record<string, unknown> = { ok: true };
    for (let index = 0; index < 20_000; index += 1) deep = { next: deep };
    // 20,000 wrappers of {"next":...}, plus the leaf, remain below 1 MiB.
    expect(20_000 * 9 + 11).toBeLessThan(WORKFLOW_MAX_DOCUMENT_BYTES);
    expect(await f.store.create(SCOPE, { id: "stack-hostile", params: deep })).toEqual({
      id: "stack-hostile",
      status: "queued",
    });
  });

  test("round-trips escaped chunks and accepts the exact document byte bound", async () => {
    const f = fixture();
    const mixed = '\u0000\n\t😀"\\/\u2028\u2029'.repeat(800);
    const params = { value: mixed, list: [{ nested: mixed }, null, 42, true] };
    await f.store.create(SCOPE, { id: "escaped-chunks", params });
    const stored = await row(
      f,
      "SELECT params_json FROM tf_workflow_instances WHERE instance_id = ?",
      ["escaped-chunks"],
    );
    expect(JSON.parse(String(stored?.params_json))).toEqual(params);

    await f.store.create(SCOPE, {
      id: "exact-bound",
      params: { value: "x".repeat(WORKFLOW_MAX_DOCUMENT_BYTES - 12) },
    });
    expect(
      await row(
        f,
        "SELECT length(CAST(params_json AS BLOB)) AS bytes FROM tf_workflow_instances WHERE instance_id = ?",
        ["exact-bound"],
      ),
    ).toEqual({ bytes: WORKFLOW_MAX_DOCUMENT_BYTES });
  });

  test("bounds each expiry batch to 64 instances and at most 65 parameters", async () => {
    const f = fixture();
    for (let index = 0; index < 65; index += 1) {
      const id = `bounded-${index}`;
      await f.store.create(SCOPE, { id });
      await f.store.sendEvent(SCOPE, id, { type: "retained" });
    }
    f.setNow(
      START +
        (WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS + WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS) * 1_000,
    );
    const boundedSql: Sql = {
      query: (sql, params) => f.sql.query(sql, params),
      run: (sql, params) => f.sql.run(sql, params),
      batch: (statements) => {
        for (const statement of statements) {
          expect(statement.params?.length ?? 0).toBeLessThanOrEqual(65);
        }
        return f.sql.batch(statements);
      },
    };
    const store = createWorkflowInstances({
      sql: boundedSql,
      clock: f.clock,
      randomId: () => "unused",
    });
    expect(await store.sweepExpired()).toBe(64);
    expect(await row(f, "SELECT COUNT(*) AS count FROM tf_workflow_instances")).toEqual({
      count: 1,
    });
    expect(await row(f, "SELECT COUNT(*) AS count FROM tf_workflow_events")).toEqual({ count: 1 });
    expect(await store.sweepExpired()).toBe(1);
    expect(await row(f, "SELECT COUNT(*) AS count FROM tf_workflow_events")).toEqual({ count: 0 });
  });

  test("does not sweep events from a reused execution id", async () => {
    const f = fixture(["execution_reused_sweep"]);
    await f.store.create(SCOPE, { id: "reused-sweep-race" });
    const terminatedAt = START + 1;
    f.setNow(terminatedAt);
    await f.store.terminate(SCOPE, "reused-sweep-race");
    const sweepTime = terminatedAt + WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS * 1_000 + 1;
    f.setNow(sweepTime);

    let releaseQuery!: () => void;
    let querySeen!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseQuery = resolve;
    });
    const seen = new Promise<void>((resolve) => {
      querySeen = resolve;
    });
    let paused = true;
    const raceSql: Sql = {
      query: async (sql, params) => {
        const rows = await f.sql.query(sql, params);
        if (paused && sql.includes("ORDER BY retention_until ASC")) {
          paused = false;
          querySeen();
          await release;
        }
        return rows;
      },
      run: (sql, params) => f.sql.run(sql, params),
      batch: (statements) => f.sql.batch(statements),
    };
    const pausedStore = createWorkflowInstances({
      sql: raceSql,
      clock: f.clock,
      randomId: () => "unused-race-id",
    });
    const pending = pausedStore.sweepExpired({ scope: SCOPE, limit: 1 });
    await seen;

    const replacement = createWorkflowInstances({
      sql: f.sql,
      clock: () => new Date(sweepTime + 1),
      randomId: () => "execution_reused_sweep",
    });
    await replacement.create(SCOPE, { id: "reused-sweep-race" });
    await replacement.sendEvent(SCOPE, "reused-sweep-race", { type: "replacement" });
    releaseQuery();

    await expect(pending).resolves.toBe(0);
    expect(
      await f.sql.query("SELECT execution_id, type FROM tf_workflow_events WHERE instance_id = ?", [
        "reused-sweep-race",
      ]),
    ).toEqual([{ execution_id: "execution_reused_sweep", type: "replacement" }]);
    expect(await replacement.status(SCOPE, "reused-sweep-race")).toEqual({ status: "queued" });
  });

  test("maps storage failures to backend_unavailable and keeps batch writes atomic", async () => {
    const base = fixture(["execution_fault"]);
    let failBatch = true;
    const faulted: Sql = {
      query: (sql, params) => base.sql.query(sql, params),
      run: (sql, params) => base.sql.run(sql, params),
      batch: async (statements): Promise<readonly SqlWrite[]> => {
        if (failBatch) {
          failBatch = false;
          throw new Error("injected batch failure");
        }
        return await base.sql.batch(statements);
      },
    };
    const store = createWorkflowInstances({
      sql: faulted,
      clock: base.clock,
      randomId: () => "execution_fault",
    });
    await expect(store.create(SCOPE, { id: "atomic" })).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(
      await base.sql.query(
        "SELECT COUNT(*) AS count FROM tf_workflow_instances WHERE instance_id = ?",
        ["atomic"],
      ),
    ).toEqual([{ count: 0 }]);
    await store.create(SCOPE, { id: "atomic" });
  });

  test("rolls back terminate when a later batch statement fails", async () => {
    const base = fixture(["execution_terminate_fault"]);
    await base.store.create(SCOPE, { id: "terminate-fault" });
    await base.store.sendEvent(SCOPE, "terminate-fault", { type: "pending" });
    const faulted: Sql = {
      query: (sql, params) => base.sql.query(sql, params),
      run: (sql, params) => base.sql.run(sql, params),
      batch: async (statements) => {
        if (statements[0]?.sql.includes("SET status = 'terminated'")) {
          return await base.sql.batch([...statements, { sql: "THIS IS NOT VALID SQL" }]);
        }
        return await base.sql.batch(statements);
      },
    };
    const store = createWorkflowInstances({
      sql: faulted,
      clock: base.clock,
      randomId: () => "execution_terminate_fault_retry",
    });
    await expect(store.terminate(SCOPE, "terminate-fault")).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(await store.status(SCOPE, "terminate-fault")).toEqual({ status: "queued" });
    expect(
      await base.sql.query(
        "SELECT COUNT(*) AS count FROM tf_workflow_events WHERE execution_id = ?",
        ["execution_terminate_fault"],
      ),
    ).toEqual([{ count: 1 }]);
  });

  test("replaces an expired id with a distinct execution and no old events", async () => {
    const f = fixture(["execution_old", "execution_new"]);
    await f.store.create(SCOPE, { id: "reused" });
    await f.store.sendEvent(SCOPE, "reused", { type: "old" });
    await f.store.terminate(SCOPE, "reused");
    f.setNow(START + WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS * 1_000 + 1);
    await f.store.create(SCOPE, { id: "reused" });
    expect(
      await f.sql.query("SELECT execution_id, type FROM tf_workflow_events WHERE instance_id = ?", [
        "reused",
      ]),
    ).toEqual([]);
    expect(
      await f.sql.query("SELECT execution_id FROM tf_workflow_instances WHERE instance_id = ?", [
        "reused",
      ]),
    ).toEqual([{ execution_id: "execution_new" }]);
  });
});
