import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { JsonObject, Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  createWorkflowRuntime,
  type WorkflowApplicationOutcome,
  type WorkflowDriver,
  type WorkflowExecutionHost,
  type WorkflowRunIdentity,
  WorkflowRuntimeError,
  WorkflowStepError,
} from "../src/workflow-execution.ts";
import {
  WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS,
  WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS,
} from "../src/workflow-instances.ts";

const START = Date.UTC(2026, 0, 1);
const SCOPE = { tenantId: "tenant", workflowResourceUid: "workflow" };
const MIGRATIONS = ["0050_workflow_instances.sql", "0051_workflow_execution.sql"]
  .map((name) => readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"))
  .join("\n");
const databases: Database[] = [];
afterEach(() => {
  for (const db of databases.splice(0)) db.close();
});

function latch<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
async function flush() {
  for (let n = 0; n < 30; n += 1) await Promise.resolve();
}

/** A protocol double, not evidence of workerd or WfP hard cancellation. */
function fixture(decorateSql: (sql: Sql) => Sql = (sql) => sql, randomIds: string[] = []) {
  const db = new Database(":memory:");
  db.exec(MIGRATIONS);
  databases.push(db);
  const baseSql = createSqliteSql(db);
  let timestamp = START;
  let nextId = 0;
  const timers = new Set<{ at: number; done(): void }>();
  const runs = new Map<
    string,
    {
      deadline: number;
      stopped: boolean;
      signal: ReturnType<typeof latch<WorkflowApplicationOutcome>>;
    }
  >();
  const hooks = {
    application: async (_driver: WorkflowDriver): Promise<JsonObject | undefined> => undefined,
    beforeOpen: async (): Promise<void> => undefined,
    beforeStop: async (): Promise<void> => undefined,
    beforeExtend: async (): Promise<void> => undefined,
    outcome: undefined as WorkflowApplicationOutcome | undefined,
  };
  const calls = { opened: 0, started: 0, stopped: 0, extended: [] as number[] };
  const key = (identity: WorkflowRunIdentity) => JSON.stringify(identity);
  const host: WorkflowExecutionHost = {
    async openPaused(identity, _input, hardDeadline) {
      calls.opened += 1;
      await hooks.beforeOpen();
      const execution = {
        deadline: hardDeadline,
        stopped: false,
        signal: latch<WorkflowApplicationOutcome>(),
      };
      runs.set(key(identity), execution);
      return {
        async run(driver) {
          if (execution.stopped || timestamp >= execution.deadline)
            throw new WorkflowRuntimeError("host_unavailable");
          calls.started += 1;
          const app = Promise.resolve()
            .then(() => hooks.application(driver))
            .then(
              (output): WorkflowApplicationOutcome =>
                output === undefined ? { kind: "complete" } : { kind: "complete", output },
              (error): WorkflowApplicationOutcome => {
                if (error instanceof WorkflowRuntimeError) throw error;
                return error instanceof WorkflowStepError && error.code === "step_failed"
                  ? { kind: "failed", reason: "step_failed", error }
                  : { kind: "failed", reason: "run_threw" };
              },
            )
            .then((outcome) => hooks.outcome ?? outcome);
          return Promise.race([app, execution.signal.promise]);
        },
        async extendDeadline(until) {
          await hooks.beforeExtend();
          if (execution.stopped || timestamp >= execution.deadline)
            throw new Error("expired context");
          calls.extended.push(until);
          execution.deadline = until;
        },
      };
    },
    async stop(identity) {
      calls.stopped += 1;
      await hooks.beforeStop();
      const execution = runs.get(key(identity));
      if (!execution) return "not_registered";
      execution.stopped = true;
      execution.signal.reject(new WorkflowRuntimeError("host_unavailable"));
      return "stopped";
    },
  };
  const runtime = createWorkflowRuntime({
    sql: decorateSql(baseSql),
    host,
    leaseMs: 10_000,
    clock: () => new Date(timestamp),
    randomId: () => randomIds.shift() ?? `id-${++nextId}`,
    waitUntil: (at, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted || timestamp >= at) {
          resolve();
          return;
        }
        const timer = {
          at,
          done: () => {
            timers.delete(timer);
            signal.removeEventListener("abort", timer.done);
            resolve();
          },
        };
        timers.add(timer);
        signal.addEventListener("abort", timer.done, { once: true });
      }),
  });
  return {
    db,
    sql: baseSql,
    runtime,
    hooks,
    calls,
    async create() {
      await runtime.instances.create(SCOPE, { id: "instance" });
    },
    async advance(ms: number) {
      timestamp = START + ms;
      for (const run of runs.values()) {
        if (!run.stopped && timestamp >= run.deadline) {
          run.stopped = true;
          run.signal.reject(new WorkflowRuntimeError("host_unavailable"));
        }
      }
      for (const timer of [...timers]) if (timer.at <= timestamp) timer.done();
      await flush();
    },
    row() {
      return db
        .query("SELECT * FROM tf_workflow_instances WHERE instance_id = 'instance'")
        .get() as Record<string, unknown>;
    },
  };
}

describe("internal Workflow execution coordinator", () => {
  test.each(["lifetime_exceeded", "step_limit_exceeded"])(
    "a host cannot fabricate the core-owned %s terminal outcome",
    async (reason) => {
      const f = fixture();
      await f.create();
      f.hooks.outcome = { kind: "failed", reason } as unknown as WorkflowApplicationOutcome;
      await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
        code: "host_unavailable",
      });
      expect(f.row()).toMatchObject({ status: "running", error_json: null, run_owner: null });
      f.hooks.outcome = undefined;
      expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "complete" });
    },
  );

  test("a fabricated step error has no core failure authority", async () => {
    const f = fixture();
    await f.create();
    f.hooks.application = async () => {
      throw new WorkflowStepError("step_failed");
    };
    await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
      code: "host_unavailable",
    });
    expect(f.row()).toMatchObject({ status: "running", error_json: null, run_owner: null });
  });

  test("mutating a genuine non-exhaustion error cannot manufacture exhausted retries", async () => {
    const f = fixture();
    await f.create();
    f.hooks.application = async (step) => {
      try {
        await step.sleep("invalid", -1);
      } catch (error) {
        if (!(error instanceof WorkflowStepError)) throw error;
        // TypeScript readonly does not protect values returned to JavaScript.
        Object.defineProperty(error, "code", { value: "step_failed" });
        throw error;
      }
      return undefined;
    };
    await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
      code: "host_unavailable",
    });
    expect(f.row()).toMatchObject({ status: "running", error_json: null, run_owner: null });
  });

  test("only an uncaught core step failure can report exhausted retries, including memo replay", async () => {
    const f = fixture();
    await f.create();
    let effects = 0;
    const fail = () => {
      effects += 1;
      throw new Error("application effect failed");
    };
    f.hooks.application = async (step) => {
      try {
        await step.do("failed", [], fail);
      } catch (error) {
        expect(error).toMatchObject({ code: "step_failed" });
      }
      await step.sleep("later", 1);
      return undefined;
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    await f.advance(1_000);
    f.hooks.application = (step) => step.do("failed", [], fail);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(JSON.parse(String(f.row().error_json))).toEqual({ reason: "step_failed" });
    expect(effects).toBe(1);
  });

  test.each(["complete", "failed"] as const)(
    "an application cannot settle %s while its unawaited effect is pending",
    async (kind) => {
      const f = fixture();
      await f.create();
      const entered = latch<void>();
      const effect = latch<JsonObject>();
      let effects = 0;
      f.hooks.application = async (step) => {
        void step.do("effect", [], async () => {
          effects += 1;
          entered.resolve();
          return effect.promise;
        });
        await entered.promise;
        if (kind === "failed") throw new Error("application returned early");
        return { premature: true };
      };
      await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
        code: "step_conflict",
      });
      expect(f.row()).toMatchObject({
        status: "running",
        output_json: null,
        error_json: null,
        run_owner: null,
      });
      expect(f.db.query("SELECT state FROM tf_workflow_steps").get()).toEqual({ state: "pending" });
      // This double cannot kill JS: a late old callback must still be fenced.
      effect.resolve({ stale: true });
      await flush();
      f.hooks.application = (step) => step.do("effect", [], () => ({ effects: ++effects }));
      expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
        kind: "complete",
        output: { effects: 2 },
      });
    },
  );

  test("the instance facade preserves private ID collision recovery", async () => {
    const f = fixture(undefined, ["repeated", "repeated", "fresh"]);
    await f.create();
    expect(await f.runtime.instances.create(SCOPE, { id: "another" })).toEqual({
      id: "another",
      status: "queued",
    });
    expect(
      f.db.query("SELECT execution_id FROM tf_workflow_instances ORDER BY instance_id").all(),
    ).toEqual([{ execution_id: "fresh" }, { execution_id: "repeated" }]);
  });

  test("completion returns the persisted output and settlement time despite a delayed stop acknowledgement", async () => {
    const f = fixture();
    await f.create();
    const output = { snapshot: "committed" };
    f.hooks.application = async () => output;
    f.hooks.beforeStop = async () => {
      output.snapshot = "changed after commit";
      await f.advance(WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS * 1_000);
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { snapshot: "committed" },
    });
    expect(f.row()).toMatchObject({
      status: "complete",
      output_json: '{"snapshot":"committed"}',
      updated_at: START,
    });
  });

  test("replays committed names after sleep and settles finite retention with explicit cleanup", async () => {
    const f = fixture();
    await f.create();
    f.db.exec("PRAGMA foreign_keys = OFF");
    let effects = 0;
    f.hooks.application = async (step) => {
      const result = await step.do("effect", [], () => ({ count: ++effects }));
      await step.sleep("delay", 2);
      return result;
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.row()).toMatchObject({ status: "sleeping", run_owner: null, wake_at: START + 2_000 });
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "deferred",
      retryAt: START + 2_000,
    });
    await f.advance(2_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { count: 1 },
    });
    expect(effects).toBe(1);
    expect(f.row()).toMatchObject({
      status: "complete",
      run_owner: null,
      retention_until: START + 2_000 + WORKFLOW_MAX_TERMINAL_RETENTION_SECONDS * 1_000,
    });
    expect(f.db.query("SELECT COUNT(*) AS count FROM tf_workflow_steps").get()).toEqual({
      count: 0,
    });
  });

  test("explicit retries park then resume without a retry-default convention", async () => {
    const f = fixture();
    await f.create();
    let attempts = 0;
    f.hooks.application = (step) =>
      step.do("retry", [2], () => {
        attempts += 1;
        if (attempts === 1) throw new Error("app failure");
        return { attempts };
      });
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    await f.advance(1_999);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "deferred",
      retryAt: START + 2_000,
    });
    expect(attempts).toBe(1);
    await f.advance(2_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { attempts: 2 },
    });
  });

  test("retained pre-wait events are consumed once, including omitted payload", async () => {
    const f = fixture();
    await f.create();
    await f.runtime.instances.sendEvent(SCOPE, "instance", { type: "approval" });
    f.hooks.application = async (step) => {
      expect(await step.waitForEvent("first", "approval", 10)).toBeUndefined();
      return step.waitForEvent("second", "approval", 10);
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.db.query("SELECT COUNT(*) AS count FROM tf_workflow_events").get()).toEqual({
      count: 0,
    });
    await f.runtime.instances.sendEvent(SCOPE, "instance", {
      type: "approval",
      payload: { approved: true },
    });
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { approved: true },
    });
  });

  test("an event arriving between inbox read and park cannot lose its wake", async () => {
    let inject: (() => Promise<void>) | undefined;
    const f = fixture((sql) => ({
      ...sql,
      async run(statement, params) {
        if (statement.includes("SET status = ?, pending_step_name = ?") && inject) {
          const action = inject;
          inject = undefined;
          await action();
        }
        return sql.run(statement, params);
      },
    }));
    await f.create();
    inject = () =>
      f.runtime.instances.sendEvent(SCOPE, "instance", {
        type: "approval",
        payload: { raced: true },
      });
    f.hooks.application = (step) => step.waitForEvent("wait", "approval", 10);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.row().wake_at).toBe(START);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { raced: true },
    });
  });

  test("stop acknowledgement never overwrites a newer matching-event wake", async () => {
    const f = fixture();
    await f.create();
    const stopping = latch<void>();
    const proceed = latch<void>();
    f.hooks.beforeStop = async () => {
      stopping.resolve();
      await proceed.promise;
    };
    f.hooks.application = (step) => step.waitForEvent("wait", "approval", 10);
    const run = f.runtime.runOne(SCOPE, "instance");
    await stopping.promise;
    await f.runtime.instances.sendEvent(SCOPE, "instance", {
      type: "approval",
      payload: { raced: true },
    });
    proceed.resolve();
    expect(await run).toEqual({ kind: "parked" });
    expect(f.row()).toMatchObject({ wake_at: START, run_owner: null });
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { raced: true },
    });
  });

  test("wait timeout is a stored error, not a successful undefined result", async () => {
    const f = fixture();
    await f.create();
    f.hooks.application = async (step) => {
      try {
        await step.waitForEvent("wait", "approval", 1);
      } catch (error) {
        expect(error).toMatchObject({ code: "wait_timeout" });
        return { timedOut: true };
      }
      return { timedOut: false };
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    await f.advance(1_001);
    await f.runtime.instances.sendEvent(SCOPE, "instance", {
      type: "approval",
      payload: { tooLate: true },
    });
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { timedOut: true },
    });
  });

  test("current code cannot shorten a persisted sleep by changing duration", async () => {
    const f = fixture();
    await f.create();
    f.hooks.application = async (step) => {
      await step.sleep("delay", 2);
      return { done: true };
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    f.hooks.application = async (step) => {
      await step.sleep("delay", 0);
      return { done: true };
    };
    await f.advance(1_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "deferred",
      retryAt: START + 2_000,
    });
    await f.advance(2_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toMatchObject({ kind: "complete" });
  });

  test("a committed name replays across kind/config changes without running distinct work", async () => {
    const f = fixture();
    await f.create();
    f.hooks.application = async (step) => {
      await step.sleep("memo", 0);
      await step.sleep("later", 1);
      return undefined;
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    await f.advance(1_000);
    f.hooks.application = async (step) => {
      expect(
        await step.do("memo", [], () => {
          throw new Error("must not execute");
        }),
      ).toBeUndefined();
      await step.sleep("later", 1);
      return { replayed: true };
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { replayed: true },
    });
  });

  test("another runner defers under a live lease; heartbeat extends SQL then host deadline", async () => {
    const f = fixture();
    await f.create();
    const entered = latch<void>();
    const effect = latch<JsonObject>();
    f.hooks.application = (step) =>
      step.do("held", [], async () => {
        entered.resolve();
        return effect.promise;
      });
    const run = f.runtime.runOne(SCOPE, "instance");
    await entered.promise;
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "deferred",
      retryAt: START + 10_000,
    });
    f.hooks.beforeExtend = async () => {
      expect(f.row().run_lease_until).toBe(START + 15_000);
    };
    await f.advance(5_000);
    expect(f.calls.extended).toEqual([START + 15_000]);
    effect.resolve({ done: true });
    expect(await run).toMatchObject({ kind: "complete" });
    expect(f.calls.started).toBe(1);
  });

  test("a lost host deadline extension stops the run without inventing an application failure", async () => {
    const f = fixture();
    await f.create();
    const entered = latch<void>();
    f.hooks.application = (step) =>
      step.do("held", [], async () => {
        entered.resolve();
        return new Promise(() => undefined);
      });
    f.hooks.beforeExtend = async () => {
      throw new Error("host unavailable");
    };
    const run = f.runtime.runOne(SCOPE, "instance");
    void run.catch(() => undefined);
    await entered.promise;
    await f.advance(5_000);
    await expect(run).rejects.toMatchObject({ code: "host_unavailable" });
    expect(f.row()).toMatchObject({ status: "running", error_json: null, run_owner: null });
  });

  test("effect-before-commit storage failure re-executes without inventing an app failure", async () => {
    let failCommit = true;
    const f = fixture((sql) => ({
      ...sql,
      async run(statement, params) {
        if (failCommit && statement.includes("UPDATE tf_workflow_steps SET state = 'complete'")) {
          failCommit = false;
          throw new Error("lost step commit");
        }
        return sql.run(statement, params);
      },
    }));
    await f.create();
    let effects = 0;
    f.hooks.application = (step) => step.do("effect", [], () => ({ count: ++effects }));
    await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(f.row()).toMatchObject({ status: "running", run_owner: null, error_json: null });
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { count: 2 },
    });
    expect(effects).toBe(2);
  });

  test("terminate waits for stop acknowledgement and retains its owner until then", async () => {
    const f = fixture();
    await f.create();
    const entered = latch<void>();
    const stopping = latch<void>();
    const acknowledge = latch<void>();
    f.hooks.application = (step) =>
      step.do("held", [], async () => {
        entered.resolve();
        return new Promise(() => undefined);
      });
    const run = f.runtime.runOne(SCOPE, "instance");
    void run.catch(() => undefined);
    await entered.promise;
    f.hooks.beforeStop = async () => {
      stopping.resolve();
      await acknowledge.promise;
    };
    let terminated = false;
    const termination = f.runtime.instances.terminate(SCOPE, "instance").then(() => {
      terminated = true;
    });
    await stopping.promise;
    expect(terminated).toBe(false);
    expect(f.row()).toMatchObject({ status: "terminated", run_owner: expect.any(String) });
    acknowledge.resolve();
    await termination;
    await run.catch(() => undefined);
    expect(f.row()).toMatchObject({ status: "terminated", run_owner: null });
    await f.runtime.instances.terminate(SCOPE, "instance");
  });

  test("terminate cannot mistake a delayed open for a stopped run", async () => {
    const f = fixture();
    await f.create();
    const opening = latch<void>();
    const opened = latch<void>();
    f.hooks.beforeOpen = async () => {
      opening.resolve();
      await opened.promise;
    };
    const run = f.runtime.runOne(SCOPE, "instance");
    void run.catch(() => undefined);
    await opening.promise;
    let done = false;
    const termination = f.runtime.instances.terminate(SCOPE, "instance").then(() => {
      done = true;
    });
    await flush();
    expect(done).toBe(false);
    opened.resolve();
    expect(await run).toEqual({ kind: "stale" });
    await f.advance(10_000);
    await termination;
    expect(f.calls.started).toBe(0);
  });

  test("all step kinds share the atomic 1024-name bound; memo replay does not consume it", async () => {
    const f = fixture();
    await f.create();
    let effects = 0;
    f.hooks.application = async (step) => {
      for (let i = 0; i < 1_024; i += 1)
        await step.do(`step-${i}`, [], () => ({ i, effects: ++effects }));
      await step.do("step-0", [], () => {
        throw new Error("memo was rerun");
      });
      await step.sleep("too-many", 1);
      return { unreachable: true };
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(effects).toBe(1_024);
    expect(JSON.parse(String(f.row().error_json))).toEqual({ reason: "step_limit_exceeded" });
  });

  test("a sleep crossing lifetime fails immediately rather than being shortened", async () => {
    const f = fixture();
    await f.create();
    await f.advance(1);
    f.hooks.application = async (step) => {
      await step.sleep("beyond", WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS);
      return undefined;
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(JSON.parse(String(f.row().error_json))).toEqual({ reason: "lifetime_exceeded" });
    expect(f.row().run_owner).toBeNull();
  });

  test("a retained event resolves immediately even if its requested timeout exceeds remaining lifetime", async () => {
    const f = fixture();
    await f.create();
    await f.advance(1_000);
    await f.runtime.instances.sendEvent(SCOPE, "instance", {
      type: "approval",
      payload: { early: true },
    });
    f.hooks.application = (step) =>
      step.waitForEvent("wait", "approval", WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { early: true },
    });
  });

  test("an over-lifetime wait expires at the instance bound, not when the wait is registered", async () => {
    const f = fixture();
    await f.create();
    await f.advance(1_000);
    f.hooks.application = (step) =>
      step.waitForEvent("wait", "approval", WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.row().status).toBe("waiting");
    await f.advance(WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS * 1_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(JSON.parse(String(f.row().error_json))).toEqual({ reason: "lifetime_exceeded" });
  });

  test("a replacement epoch rejects a late result from the expired owner", async () => {
    const f = fixture();
    await f.create();
    const entered = latch<void>();
    const oldResult = latch<JsonObject>();
    f.hooks.application = (step) =>
      step.do("effect", [], async () => {
        entered.resolve();
        return oldResult.promise;
      });
    const oldRun = f.runtime.runOne(SCOPE, "instance");
    void oldRun.catch(() => undefined);
    await entered.promise;
    await f.advance(10_001);
    await oldRun.catch(() => undefined);
    f.hooks.application = (step) => step.do("effect", [], () => ({ owner: "replacement" }));
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { owner: "replacement" },
    });
    oldResult.resolve({ owner: "stale" });
    await flush();
    expect(JSON.parse(String(f.row().output_json))).toEqual({ owner: "replacement" });
    expect(f.row().run_epoch).toBe(2);
  });

  test("a terminal stop failure retains the owner and an idempotent retry finishes it", async () => {
    const f = fixture();
    await f.create();
    f.hooks.application = async () => ({ finished: true });
    f.hooks.beforeStop = async () => {
      throw new Error("stop acknowledgement unavailable");
    };
    await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
      code: "host_unavailable",
    });
    expect(f.row()).toMatchObject({ status: "complete", run_owner: expect.any(String) });
    await expect(f.runtime.instances.terminate(SCOPE, "instance")).rejects.toMatchObject({
      name: "backend_unavailable",
      code: "backend_unavailable",
    });
    expect(f.row()).toMatchObject({ status: "complete", run_owner: expect.any(String) });
    f.hooks.beforeStop = async () => undefined;
    await f.runtime.instances.terminate(SCOPE, "instance");
    expect(f.row()).toMatchObject({ status: "complete", run_owner: null });
  });
});
