import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createWorkflowDueScheduler } from "../src/workflow-due-scheduler.ts";
import {
  createWorkflowRuntime,
  type WorkflowExecutionHost,
  type WorkflowRunOutcome,
} from "../src/workflow-execution.ts";
import { createWorkflowInstances, type WorkflowScope } from "../src/workflow-instances.ts";

const START = Date.UTC(2026, 0, 1);
const SCOPE = { tenantId: "tenant", workflowResourceUid: "workflow" };
const MIGRATIONS = [
  "0050_workflow_instances.sql",
  "0051_workflow_execution.sql",
  "0052_workflow_termination_intent.sql",
]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function fixture() {
  const db = new Database(":memory:");
  db.exec(MIGRATIONS);
  databases.push(db);
  const sql = createSqliteSql(db);
  let timestamp = START;
  let sequence = 0;
  const clock = () => new Date(timestamp);
  const instances = createWorkflowInstances({
    sql,
    clock,
    randomId: () => `private-${++sequence}`,
  });
  return {
    db,
    sql,
    clock,
    instances,
    at(value: number) {
      timestamp = value;
    },
    async create(id: string, scope: WorkflowScope = SCOPE) {
      await instances.create(scope, { id });
    },
    set(id: string, patch: string, params: readonly (string | number | null)[] = []) {
      db.query(`UPDATE tf_workflow_instances SET ${patch} WHERE instance_id = ?`).run(
        ...params,
        id,
      );
    },
    row(id: string): Record<string, unknown> {
      return db
        .query("SELECT * FROM tf_workflow_instances WHERE instance_id = ?")
        .get(id) as Record<string, unknown>;
    },
  };
}

function recorder() {
  const calls: string[] = [];
  return {
    calls,
    runtime: {
      async runOne(scope: WorkflowScope, id: string): Promise<WorkflowRunOutcome> {
        calls.push(`${scope.tenantId}/${scope.workflowResourceUid}/${id}`);
        return { kind: "stale" };
      },
    },
  };
}

describe("private Workflow due-row scheduler", () => {
  test("selects due, expired-lease, and deadline rows, but not future wake or live lease", async () => {
    const f = fixture();
    const r = recorder();
    for (const id of ["due", "future", "lease-expired", "lease-live", "deadline"]) {
      await f.create(id);
    }
    f.set("future", "status = 'sleeping', wake_at = ?", [START + 1_000]);
    f.set("lease-expired", "status = 'running', run_owner = 'owner', run_lease_until = ?", [START]);
    f.set("lease-live", "status = 'running', run_owner = 'owner', run_lease_until = ?", [
      START + 1_000,
    ]);
    f.set("deadline", "status = 'sleeping', wake_at = ?, deadline_at = ?", [START + 1_000, START]);
    const scheduler = createWorkflowDueScheduler({
      sql: f.sql,
      clock: f.clock,
      runtime: r.runtime,
    });
    expect((await scheduler.pollDue()).selected).toBe(3);
    expect(r.calls).toEqual([
      "tenant/workflow/deadline",
      "tenant/workflow/due",
      "tenant/workflow/lease-expired",
    ]);
    f.at(START + 1_000);
    r.calls.length = 0;
    expect((await scheduler.pollDue()).selected).toBe(5);
    expect(r.calls).toContain("tenant/workflow/future");
    expect(r.calls).toContain("tenant/workflow/lease-live");
  });

  test("future wake and live lease agree with runOne's deferred guard", async () => {
    const f = fixture();
    await f.create("future");
    await f.create("owned");
    f.set("future", "status = 'sleeping', wake_at = ?", [START + 1_000]);
    f.set("owned", "status = 'running', run_owner = 'owner', run_lease_until = ?", [START + 1_000]);
    const host: WorkflowExecutionHost = {
      async openPaused() {
        throw new Error("must not open before due");
      },
      async stop() {
        return "stopped";
      },
    };
    const runtime = createWorkflowRuntime({
      sql: f.sql,
      clock: f.clock,
      randomId: () => "owner-new",
      waitUntil: async () => {},
      host,
    });
    expect(await runtime.runOne(SCOPE, "future")).toEqual({
      kind: "deferred",
      retryAt: START + 1_000,
    });
    expect(await runtime.runOne(SCOPE, "owned")).toEqual({
      kind: "deferred",
      retryAt: START + 1_000,
    });
    const scheduler = createWorkflowDueScheduler({ sql: f.sql, clock: f.clock, runtime });
    expect((await scheduler.pollDue()).selected).toBe(0);
  });

  test("saved termination intent and terminal owner are polled even behind a future wake", async () => {
    const f = fixture();
    const r = recorder();
    for (const id of ["intent", "terminal-owned", "terminal-intent", "terminal-clean"]) {
      await f.create(id);
    }
    f.set("intent", "status = 'waiting', wake_at = ?, termination_requested = 1", [START + 1_000]);
    f.set("terminal-owned", "status = 'errored', run_owner = 'owner', run_lease_until = ?", [
      START + 1_000,
    ]);
    f.set("terminal-intent", "status = 'terminated', termination_requested = 1");
    f.set("terminal-clean", "status = 'complete'");
    const scheduler = createWorkflowDueScheduler({
      sql: f.sql,
      clock: f.clock,
      runtime: r.runtime,
    });
    expect((await scheduler.pollDue()).selected).toBe(3);
    expect(r.calls).toEqual([
      "tenant/workflow/intent",
      "tenant/workflow/terminal-intent",
      "tenant/workflow/terminal-owned",
    ]);
  });

  test("runOne recovers termination intent and clears a terminal residual owner", async () => {
    const f = fixture();
    await f.create("intent");
    await f.create("owned");
    f.set("intent", "status = 'sleeping', wake_at = ?, termination_requested = 1", [START + 1_000]);
    f.set("owned", "status = 'errored', run_owner = 'owner', run_lease_until = ?", [START + 1_000]);
    let opened = 0;
    let stopped = 0;
    const host: WorkflowExecutionHost = {
      async openPaused() {
        opened += 1;
        throw new Error("must not open an application context");
      },
      async stop() {
        stopped += 1;
        return "stopped";
      },
    };
    const runtime = createWorkflowRuntime({
      sql: f.sql,
      clock: f.clock,
      randomId: () => "owner-new",
      waitUntil: async () => {},
      host,
    });
    const scheduler = createWorkflowDueScheduler({ sql: f.sql, clock: f.clock, runtime });
    expect((await scheduler.pollDue()).outcomes).toEqual([
      { kind: "terminal", status: "terminated" },
      { kind: "terminal", status: "errored" },
    ]);
    expect(f.row("intent")).toMatchObject({ status: "terminated", termination_requested: 0 });
    expect(f.row("owned")).toMatchObject({ status: "errored", run_owner: null });
    expect(opened).toBe(0);
    expect(stopped).toBe(1);
  });

  test("failed stop leaves durable termination intent for the next poll", async () => {
    const f = fixture();
    await f.create("intent");
    f.set(
      "intent",
      "status = 'running', run_owner = 'owner', run_lease_until = ?, termination_requested = 1",
      [START + 1_000],
    );
    let failStop = true;
    const host: WorkflowExecutionHost = {
      async openPaused() {
        throw new Error("must not run");
      },
      async stop() {
        if (failStop) throw new Error("stop proof unavailable");
        return "stopped";
      },
    };
    const runtime = createWorkflowRuntime({
      sql: f.sql,
      clock: f.clock,
      randomId: () => "owner-new",
      waitUntil: async () => {},
      host,
    });
    const scheduler = createWorkflowDueScheduler({ sql: f.sql, clock: f.clock, runtime });
    await expect(scheduler.pollDue()).rejects.toBeInstanceOf(AggregateError);
    expect(f.row("intent")).toMatchObject({
      status: "running",
      termination_requested: 1,
      run_owner: "owner",
    });
    failStop = false;
    expect((await scheduler.pollDue()).outcomes).toEqual([
      { kind: "terminal", status: "terminated" },
    ]);
    expect(f.row("intent")).toMatchObject({
      status: "terminated",
      termination_requested: 0,
      run_owner: null,
    });
  });

  test("keyset wrap lets a persistent recovery row coexist with later due rows", async () => {
    const f = fixture();
    const r = recorder();
    await f.create("a-terminal");
    await f.create("b-due");
    f.set("a-terminal", "status = 'errored', run_owner = 'owner', run_lease_until = ?", [
      START + 1_000,
    ]);
    const scheduler = createWorkflowDueScheduler({
      sql: f.sql,
      clock: f.clock,
      runtime: r.runtime,
      batchSize: 1,
      concurrency: 1,
    });
    await scheduler.pollDue();
    await scheduler.pollDue();
    await scheduler.pollDue();
    expect(r.calls).toEqual([
      "tenant/workflow/a-terminal",
      "tenant/workflow/b-due",
      "tenant/workflow/a-terminal",
    ]);
  });

  test("a new wake before the cursor is reached on wrap, without duplicate selection", async () => {
    const f = fixture();
    const r = recorder();
    await f.create("a-later");
    await f.create("b-due");
    f.set("a-later", "status = 'sleeping', wake_at = ?", [START + 1_000]);
    const scheduler = createWorkflowDueScheduler({
      sql: f.sql,
      clock: f.clock,
      runtime: r.runtime,
      batchSize: 2,
    });
    expect((await scheduler.pollDue()).selected).toBe(1);
    f.at(START + 1_000);
    r.calls.length = 0;
    expect((await scheduler.pollDue()).selected).toBe(2);
    expect(r.calls).toEqual(["tenant/workflow/a-later", "tenant/workflow/b-due"]);
  });

  test("bounded slots coalesce overlapping polls and await every selected run before rejecting", async () => {
    const f = fixture();
    for (const id of ["a", "b", "c", "d"]) await f.create(id);
    let active = 0;
    let peak = 0;
    const entered: string[] = [];
    const releases: (() => void)[] = [];
    const runtime = {
      async runOne(_scope: WorkflowScope, id: string): Promise<WorkflowRunOutcome> {
        active += 1;
        peak = Math.max(peak, active);
        entered.push(id);
        await new Promise<void>((resolve) => releases.push(resolve));
        active -= 1;
        if (id === "a") throw new Error("host failed");
        return { kind: "stale" };
      },
    };
    const scheduler = createWorkflowDueScheduler({
      sql: f.sql,
      clock: f.clock,
      runtime,
      batchSize: 3,
      concurrency: 2,
    });
    const first = scheduler.pollDue();
    expect(scheduler.pollDue()).toBe(first);
    while (entered.length < 2) await Promise.resolve();
    expect(entered).toEqual(["a", "b"]);
    releases.shift()?.();
    while (entered.length < 3) await Promise.resolve();
    expect(entered).toEqual(["a", "b", "c"]);
    expect(peak).toBe(2);
    releases.shift()?.();
    releases.shift()?.();
    await expect(first).rejects.toMatchObject({ errors: [expect.any(Error)] });
    expect(active).toBe(0);
    expect(entered).toHaveLength(3);
  });

  test("concurrent pollers leave claiming and execution to runOne", async () => {
    const f = fixture();
    await f.create("one");
    let starts = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const host: WorkflowExecutionHost = {
      async openPaused() {
        return {
          async run() {
            starts += 1;
            await held;
            return { kind: "complete" };
          },
          async extendDeadline() {},
        };
      },
      async stop() {
        return "stopped";
      },
    };
    const runtime = createWorkflowRuntime({
      sql: f.sql,
      clock: f.clock,
      randomId: () => `owner-${starts + 1}`,
      waitUntil: (_at, signal) =>
        new Promise<void>((resolve) =>
          signal.addEventListener("abort", () => resolve(), { once: true }),
        ),
      host,
    });
    const one = createWorkflowDueScheduler({ sql: f.sql, clock: f.clock, runtime });
    const two = createWorkflowDueScheduler({ sql: f.sql, clock: f.clock, runtime });
    const first = one.pollDue();
    const second = two.pollDue();
    for (let attempt = 0; starts === 0 && attempt < 100; attempt += 1) await Promise.resolve();
    expect(starts).toBe(1);
    release();
    const outcomes = await Promise.all([first, second]);
    expect(starts).toBe(1);
    expect(outcomes.map((result) => result.outcomes[0]?.kind).sort()).toEqual([
      "complete",
      "stale",
    ]);
    expect(f.row("one")).toMatchObject({ status: "complete", run_owner: null });
  });

  test("rejects invalid limits without reading rows", () => {
    const f = fixture();
    const r = recorder();
    expect(() =>
      createWorkflowDueScheduler({
        sql: f.sql,
        clock: f.clock,
        runtime: r.runtime,
        batchSize: 257,
      }),
    ).toThrow();
    expect(() =>
      createWorkflowDueScheduler({
        sql: f.sql,
        clock: f.clock,
        runtime: r.runtime,
        batchSize: 1,
        concurrency: 2,
      }),
    ).toThrow();
  });
});
