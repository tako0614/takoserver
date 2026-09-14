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
        await step.sleep(
          () => "invalid",
          () => -1,
        );
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
        await step.do(
          () => "failed",
          () => ({ retryDelaysSeconds: [], effect: fail }),
        );
      } catch (error) {
        expect(error).toMatchObject({ code: "step_failed" });
      }
      await step.sleep(
        () => "later",
        () => 1,
      );
      return undefined;
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    await f.advance(1_000);
    f.hooks.application = async (step) => {
      // Settle the retained sleep before testing exhausted-error provenance;
      // leaving it unfinished would independently require a mismatch outcome.
      await step.sleep(
        () => "later",
        () => 1,
      );
      return step.do(
        () => "failed",
        () => ({ retryDelaysSeconds: [], effect: fail }),
      );
    };
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
      let caught = false;
      let finallyRan = false;
      f.hooks.application = async (step) => {
        void step
          .do(
            () => "effect",
            () => ({
              retryDelaysSeconds: [],
              effect: async () => {
                effects += 1;
                entered.resolve();
                return effect.promise;
              },
            }),
          )
          .catch(() => {
            caught = true;
          })
          .finally(() => {
            finallyRan = true;
          });
        await entered.promise;
        if (kind === "failed") throw new Error("application returned early");
        return { premature: true };
      };
      expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
        kind: "terminal",
        status: "errored",
      });
      expect(f.row()).toMatchObject({
        status: "errored",
        output_json: null,
        error_json: '{"reason":"step_definition_mismatch"}',
        run_owner: null,
      });
      expect(f.db.query("SELECT state FROM tf_workflow_steps").get()).toBeNull();
      // This double cannot kill JS: a late old callback must still be fenced.
      effect.resolve({ stale: true });
      await flush();
      expect(effects).toBe(1);
      expect(caught).toBe(false);
      expect(finallyRan).toBe(false);
      expect(f.row()).toMatchObject({
        status: "errored",
        output_json: null,
        error_json: '{"reason":"step_definition_mismatch"}',
      });
    },
  );

  test("terminal publication waits for physical stop acknowledgement", async () => {
    const f = fixture();
    await f.create();
    const stopping = latch<void>();
    const proceed = latch<void>();
    const output = { committed: true };
    f.hooks.application = async () => output;
    f.hooks.beforeStop = async () => {
      expect(f.row()).toMatchObject({
        status: "running",
        output_json: null,
        error_json: null,
      });
      output.committed = false;
      stopping.resolve();
      await proceed.promise;
    };
    const run = f.runtime.runOne(SCOPE, "instance");
    await stopping.promise;
    expect(f.row()).toMatchObject({ status: "running", run_owner: expect.any(String) });
    proceed.resolve();
    expect(await run).toEqual({ kind: "complete", output: { committed: true } });
    expect(f.row()).toMatchObject({
      status: "complete",
      output_json: '{"committed":true}',
      run_owner: null,
    });
  });

  test("a mismatch during pending preparation cannot publish the park state", async () => {
    const f = fixture();
    await f.create();
    const stopping = latch<void>();
    const proceed = latch<void>();
    let driver!: WorkflowDriver;
    f.hooks.application = async (step) => {
      driver = step;
      await step.sleep(
        () => "sleeping",
        () => 60,
      );
      return undefined;
    };
    f.hooks.beforeStop = async () => {
      stopping.resolve();
      await proceed.promise;
    };
    const run = f.runtime.runOne(SCOPE, "instance");
    await stopping.promise;
    void driver.definitionMismatch();
    proceed.resolve();
    expect(await run).toEqual({ kind: "terminal", status: "errored" });
    expect(f.row()).toMatchObject({
      status: "errored",
      wake_at: null,
      error_json: '{"reason":"step_definition_mismatch"}',
      run_owner: null,
    });
  });

  test("an async pending preparation is fenced after a mismatch latch", async () => {
    const f = fixture();
    await f.create();
    const prepared = latch<void>();
    const release = latch<void>();
    let driver!: WorkflowDriver;
    let effects = 0;
    let caught = false;
    let finalized = false;
    f.hooks.application = async (step) => {
      driver = step;
      try {
        await step.do(
          () => "async-pending",
          async () => {
            prepared.resolve();
            await release.promise;
            return {
              retryDelaysSeconds: [],
              effect: () => {
                effects += 1;
                return { stale: true };
              },
            };
          },
        );
      } catch {
        caught = true;
      } finally {
        finalized = true;
      }
      return { unreachable: true };
    };
    const run = f.runtime.runOne(SCOPE, "instance");
    await prepared.promise;
    void driver.definitionMismatch();
    release.resolve();
    expect(await run).toEqual({ kind: "terminal", status: "errored" });
    expect(effects).toBe(0);
    expect(caught).toBe(false);
    expect(finalized).toBe(false);
    expect(f.db.query("SELECT COUNT(*) AS count FROM tf_workflow_steps").get()).toEqual({
      count: 0,
    });
  });

  test("pending cross-kind mismatch stops before validating new pending arguments", async () => {
    const f = fixture();
    await f.create();
    f.hooks.application = async (step) => {
      await step.sleep(
        () => "same-name",
        () => 60,
      );
      return { unreachable: true };
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });

    await f.advance(60_000);
    let pendingPrepared = 0;
    let caught = false;
    let finallyRan = false;
    f.hooks.application = async (step) => {
      try {
        await step.do(
          () => "same-name",
          () => {
            pendingPrepared += 1;
            throw new TypeError("must not validate a cross-kind call");
          },
        );
      } catch {
        caught = true;
      } finally {
        finallyRan = true;
      }
      return { unreachable: true };
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(pendingPrepared).toBe(0);
    expect(caught).toBe(false);
    expect(finallyRan).toBe(false);
    expect(f.row()).toMatchObject({
      status: "errored",
      error_json: '{"reason":"step_definition_mismatch"}',
      run_owner: null,
    });
  });

  test("overlapping step calls latch an uncatchable mismatch and fence late writes", async () => {
    const f = fixture();
    await f.create();
    const entered = latch<void>();
    const release = latch<JsonObject>();
    let caught = false;
    let finallyRan = false;
    let effects = 0;
    f.hooks.application = async (step) => {
      void step
        .do(
          () => "held",
          () => ({
            retryDelaysSeconds: [],
            effect: async () => {
              effects += 1;
              entered.resolve();
              return release.promise;
            },
          }),
        )
        .catch(() => {
          caught = true;
        })
        .finally(() => {
          finallyRan = true;
        });
      await entered.promise;
      try {
        await step.sleep(
          () => "overlap",
          () => 0,
        );
      } catch {
        caught = true;
      } finally {
        finallyRan = true;
      }
      return { unreachable: true };
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(caught).toBe(false);
    expect(finallyRan).toBe(false);
    expect(effects).toBe(1);
    release.resolve({ stale: true });
    await flush();
    expect(f.db.query("SELECT COUNT(*) AS count FROM tf_workflow_steps").get()).toEqual({
      count: 0,
    });
    expect(f.row()).toMatchObject({
      status: "errored",
      error_json: '{"reason":"step_definition_mismatch"}',
      run_owner: null,
    });
  });

  test("a retained pending history cannot settle around a new application run", async () => {
    const f = fixture();
    await f.create();
    await f.sql.run(
      `INSERT INTO tf_workflow_steps
         (tenant_id, workflow_resource_uid, instance_id, execution_id, execution_created_at,
          name, kind, state, config_json, created_at, updated_at, revision)
       SELECT tenant_id, workflow_resource_uid, instance_id, execution_id, created_at,
              'unfinished', 'do', 'pending', '{"retryDelaysSeconds":[]}', created_at, created_at, 1
       FROM tf_workflow_instances
       WHERE instance_id = ?`,
      ["instance"],
    );
    f.hooks.application = async () => ({ settled: true });
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(f.row()).toMatchObject({
      status: "errored",
      output_json: null,
      error_json: '{"reason":"step_definition_mismatch"}',
      run_owner: null,
    });
    expect(f.db.query("SELECT COUNT(*) AS count FROM tf_workflow_steps").get()).toEqual({
      count: 0,
    });
  });

  test("a host.run transport rejection remains infrastructure with pending history", async () => {
    const f = fixture();
    await f.create();
    await f.sql.run(
      `INSERT INTO tf_workflow_steps
         (tenant_id, workflow_resource_uid, instance_id, execution_id, execution_created_at,
          name, kind, state, config_json, created_at, updated_at, revision)
       SELECT tenant_id, workflow_resource_uid, instance_id, execution_id, created_at,
              'transport-pending', 'do', 'pending', '{"retryDelaysSeconds":[]}', created_at, created_at, 1
       FROM tf_workflow_instances
       WHERE instance_id = ?`,
      ["instance"],
    );
    f.hooks.application = async () => {
      throw new WorkflowRuntimeError("host_unavailable");
    };
    await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
      code: "host_unavailable",
    });
    expect(f.row()).toMatchObject({
      status: "running",
      output_json: null,
      error_json: null,
      run_owner: null,
    });
  });

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

  test("a delayed stop acknowledgement rechecks the absolute lifetime before publication", async () => {
    const f = fixture();
    await f.create();
    const output = { snapshot: "committed" };
    f.hooks.application = async () => output;
    f.hooks.beforeStop = async () => {
      output.snapshot = "changed after commit";
      await f.advance(WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS * 1_000);
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(f.row()).toMatchObject({
      status: "errored",
      output_json: null,
      error_json: '{"reason":"lifetime_exceeded"}',
      updated_at: START + WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS * 1_000,
    });
  });

  test("replays committed names after sleep and settles finite retention with explicit cleanup", async () => {
    const f = fixture();
    await f.create();
    f.db.exec("PRAGMA foreign_keys = OFF");
    let effects = 0;
    f.hooks.application = async (step) => {
      const result = await step.do(
        () => "effect",
        () => ({ retryDelaysSeconds: [], effect: () => ({ count: ++effects }) }),
      );
      await step.sleep(
        () => "delay",
        () => 2,
      );
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
      step.do(
        () => "retry",
        () => ({
          retryDelaysSeconds: [2],
          effect: () => {
            attempts += 1;
            if (attempts === 1) throw new Error("app failure");
            return { attempts };
          },
        }),
      );
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

  test("a replay keeps the journaled retry plan after the first retry", async () => {
    const f = fixture();
    await f.create();
    let attempts = 0;
    f.hooks.application = (step) =>
      step.do(
        () => "retry",
        () => ({
          retryDelaysSeconds: [1, 1],
          effect: () => {
            attempts += 1;
            if (attempts <= 2) throw new Error("app failure");
            return { attempts };
          },
        }),
      );
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    await f.advance(1_000);
    f.hooks.application = (step) =>
      step.do(
        () => "retry",
        () => ({
          retryDelaysSeconds: [],
          effect: () => {
            attempts += 1;
            if (attempts <= 2) throw new Error("replayed app failure");
            return { attempts };
          },
        }),
      );
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.row()).toMatchObject({ status: "sleeping", wake_at: START + 2_000 });
    await f.advance(2_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { attempts: 3 },
    });
  });

  test("a pending zero-retry journal cannot gain a retry from changed code", async () => {
    let failAfterInsert = false;
    const f = fixture((sql) => ({
      ...sql,
      async run(statement, params) {
        const result = await sql.run(statement, params);
        if (statement.startsWith("INSERT INTO tf_workflow_steps") && result.changes === 1) {
          failAfterInsert = true;
        }
        return result;
      },
      async query(statement, params) {
        if (
          statement.startsWith("SELECT * FROM tf_workflow_steps WHERE execution_id = ?") &&
          failAfterInsert
        ) {
          failAfterInsert = false;
          throw new Error("crash after pending journal");
        }
        return sql.query(statement, params);
      },
    }));
    await f.create();
    let effects = 0;
    f.hooks.application = (step) =>
      step.do(
        () => "retry",
        () => ({
          retryDelaysSeconds: [],
          effect: () => {
            effects += 1;
            throw new Error("initial app failure");
          },
        }),
      );
    await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(f.row()).toMatchObject({ status: "running", run_owner: null });
    expect(f.db.query("SELECT state, config_json FROM tf_workflow_steps").get()).toEqual({
      state: "pending",
      config_json: '{"retryDelaysSeconds":[]}',
    });
    f.hooks.application = (step) =>
      step.do(
        () => "retry",
        () => ({
          retryDelaysSeconds: [1],
          effect: () => {
            effects += 1;
            throw new Error("replayed app failure");
          },
        }),
      );
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(effects).toBe(1);
    expect(f.row()).toMatchObject({ status: "errored", wake_at: null, run_owner: null });
  });

  test("a changed valid retry delay cannot recompute persisted future wakes", async () => {
    const f = fixture();
    await f.create();
    let attempts = 0;
    f.hooks.application = (step) =>
      step.do(
        () => "retry",
        () => ({
          retryDelaysSeconds: [5, 7],
          effect: () => {
            attempts += 1;
            throw new Error("app failure");
          },
        }),
      );
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.row()).toMatchObject({ status: "sleeping", wake_at: START + 5_000 });
    f.hooks.application = (step) =>
      step.do(
        () => "retry",
        () => ({
          retryDelaysSeconds: [1, 2],
          effect: () => {
            attempts += 1;
            throw new Error("replayed app failure");
          },
        }),
      );
    await f.advance(1_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "deferred",
      retryAt: START + 5_000,
    });
    await f.advance(5_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.row()).toMatchObject({ status: "sleeping", wake_at: START + 12_000 });
    expect(attempts).toBe(2);
  });

  test("an invalid do result is a failed attempt without invoking getters", async () => {
    const f = fixture();
    await f.create();
    let getterReads = 0;
    const invalid = {};
    Object.defineProperty(invalid, "forbidden", {
      enumerable: true,
      get() {
        getterReads += 1;
        throw new Error("getter must not run");
      },
    });
    f.hooks.application = (step) =>
      step.do(
        () => "invalid",
        () => ({ retryDelaysSeconds: [], effect: () => invalid as unknown as JsonObject }),
      );
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "terminal",
      status: "errored",
    });
    expect(getterReads).toBe(0);
    expect(JSON.parse(String(f.row().error_json))).toEqual({ reason: "step_failed" });
  });

  test("an oversized do result retries under its saved plan before replay success", async () => {
    const f = fixture();
    await f.create();
    const oversized = { payload: "x".repeat(1_048_577) } as unknown as JsonObject;
    let attempts = 0;
    f.hooks.application = (step) =>
      step.do(
        () => "oversized",
        () => ({
          retryDelaysSeconds: [1, 1],
          effect: () => {
            attempts += 1;
            return oversized;
          },
        }),
      );
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.row()).toMatchObject({ status: "sleeping", wake_at: START + 1_000 });
    f.hooks.application = (step) =>
      step.do(
        () => "oversized",
        () => ({
          retryDelaysSeconds: [],
          effect: () => {
            attempts += 1;
            return attempts <= 2 ? oversized : { ok: true };
          },
        }),
      );
    await f.advance(1_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.row()).toMatchObject({ status: "sleeping", wake_at: START + 2_000 });
    await f.advance(2_000);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { ok: true },
    });
    expect(attempts).toBe(3);
  });

  test("retained pre-wait events are consumed once, including omitted payload", async () => {
    const f = fixture();
    await f.create();
    await f.runtime.instances.sendEvent(SCOPE, "instance", { type: "approval" });
    f.hooks.application = async (step) => {
      expect(
        await step.waitForEvent(
          () => "first",
          () => ({ type: "approval", timeoutSeconds: 10 }),
        ),
      ).toBeUndefined();
      return step.waitForEvent(
        () => "second",
        () => ({ type: "approval", timeoutSeconds: 10 }),
      );
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
    f.hooks.application = (step) =>
      step.waitForEvent(
        () => "wait",
        () => ({ type: "approval", timeoutSeconds: 10 }),
      );
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    expect(f.row().wake_at).toBe(START);
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { raced: true },
    });
  });

  test("parking waits for stop acknowledgement without losing a matching event", async () => {
    const f = fixture();
    await f.create();
    const stopping = latch<void>();
    const proceed = latch<void>();
    f.hooks.beforeStop = async () => {
      stopping.resolve();
      await proceed.promise;
    };
    f.hooks.application = (step) =>
      step.waitForEvent(
        () => "wait",
        () => ({ type: "approval", timeoutSeconds: 10 }),
      );
    const run = f.runtime.runOne(SCOPE, "instance");
    await stopping.promise;
    const statusWhileStopping = await f.runtime.instances.status(SCOPE, "instance");
    await f.runtime.instances.sendEvent(SCOPE, "instance", {
      type: "approval",
      payload: { raced: true },
    });
    proceed.resolve();
    expect(await run).toEqual({ kind: "parked" });
    expect(statusWhileStopping.status).toBe("running");
    expect(f.row()).toMatchObject({ wake_at: START, run_owner: null });
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({
      kind: "complete",
      output: { raced: true },
    });
  });

  test("parking never exposes sleeping while the execution context is still stopping", async () => {
    const f = fixture();
    await f.create();
    const stopping = latch<void>();
    const stopped = latch<void>();
    f.hooks.beforeStop = async () => {
      stopping.resolve();
      await stopped.promise;
    };
    f.hooks.application = async (step) => {
      await step.sleep(
        () => "sleep",
        () => 60,
      );
      return undefined;
    };
    const run = f.runtime.runOne(SCOPE, "instance");
    await stopping.promise;
    const statusWhileStopping = await f.runtime.instances.status(SCOPE, "instance");
    stopped.resolve();
    expect(await run).toEqual({ kind: "parked" });
    expect(statusWhileStopping.status).toBe("running");
    expect(await f.runtime.instances.status(SCOPE, "instance")).toMatchObject({
      status: "sleeping",
    });
    expect(f.row()).toMatchObject({ wake_at: START + 60_000, run_owner: null });
  });

  test("failed parking stop cannot publish a sleeping instance", async () => {
    const f = fixture();
    await f.create();
    f.hooks.beforeStop = async () => {
      throw new Error("stop is unacknowledged");
    };
    f.hooks.application = async (step) => {
      await step.sleep(
        () => "sleep",
        () => 60,
      );
      return undefined;
    };
    await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
      code: "host_unavailable",
    });
    expect(await f.runtime.instances.status(SCOPE, "instance")).toMatchObject({
      status: "running",
    });
    expect(f.row()).toMatchObject({
      run_owner: expect.any(String),
      wake_at: null,
    });
  });

  test("a bounded-failure stop rejection reaches the host, never app catch/finally", async () => {
    const f = fixture();
    await f.create();
    let caught = false;
    let finalized = false;
    f.hooks.beforeStop = async () => {
      throw new Error("stop is unacknowledged");
    };
    f.hooks.application = async (step) => {
      try {
        await step.sleep(
          () => "past-lifetime",
          () => WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS,
        );
      } catch {
        caught = true;
      } finally {
        finalized = true;
      }
      return undefined;
    };
    await f.advance(1_000);
    await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
      code: "host_unavailable",
    });
    expect(caught).toBe(false);
    expect(finalized).toBe(false);
    expect(f.row()).toMatchObject({
      status: "running",
      error_json: null,
      run_owner: expect.any(String),
    });
  });

  test("wait timeout is a stored error, not a successful undefined result", async () => {
    const f = fixture();
    await f.create();
    f.hooks.application = async (step) => {
      try {
        await step.waitForEvent(
          () => "wait",
          () => ({ type: "approval", timeoutSeconds: 1 }),
        );
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
      await step.sleep(
        () => "delay",
        () => 2,
      );
      return { done: true };
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    f.hooks.application = async (step) => {
      await step.sleep(
        () => "delay",
        () => 0,
      );
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
      await step.sleep(
        () => "memo",
        () => 0,
      );
      await step.sleep(
        () => "later",
        () => 1,
      );
      return undefined;
    };
    expect(await f.runtime.runOne(SCOPE, "instance")).toEqual({ kind: "parked" });
    await f.advance(1_000);
    f.hooks.application = async (step) => {
      expect(
        await step.do(
          () => "memo",
          () => ({
            retryDelaysSeconds: [],
            effect: () => {
              throw new Error("must not execute");
            },
          }),
        ),
      ).toBeUndefined();
      await step.sleep(
        () => "later",
        () => 1,
      );
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
      step.do(
        () => "held",
        () => ({
          retryDelaysSeconds: [],
          effect: async () => {
            entered.resolve();
            return effect.promise;
          },
        }),
      );
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
      step.do(
        () => "held",
        () => ({
          retryDelaysSeconds: [],
          effect: async () => {
            entered.resolve();
            return new Promise(() => undefined);
          },
        }),
      );
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

  test("a successful-result commit failure stays infrastructure and retryable", async () => {
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
    f.hooks.application = (step) =>
      step.do(
        () => "effect",
        () => ({ retryDelaysSeconds: [1], effect: () => ({ count: ++effects }) }),
      );
    await expect(f.runtime.runOne(SCOPE, "instance")).rejects.toMatchObject({
      code: "backend_unavailable",
    });
    expect(f.row()).toMatchObject({ status: "running", run_owner: null, error_json: null });
    expect(
      f.db.query("SELECT state, retry_progress_json, wake_at FROM tf_workflow_steps").get(),
    ).toEqual({
      state: "pending",
      retry_progress_json: null,
      wake_at: null,
    });
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
      step.do(
        () => "held",
        () => ({
          retryDelaysSeconds: [],
          effect: async () => {
            entered.resolve();
            return new Promise(() => undefined);
          },
        }),
      );
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
        await step.do(
          () => `step-${i}`,
          () => ({ retryDelaysSeconds: [], effect: () => ({ i, effects: ++effects }) }),
        );
      await step.do(
        () => "step-0",
        () => ({
          retryDelaysSeconds: [],
          effect: () => {
            throw new Error("memo was rerun");
          },
        }),
      );
      await step.sleep(
        () => "too-many",
        () => 1,
      );
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
      await step.sleep(
        () => "beyond",
        () => WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS,
      );
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
      step.waitForEvent(
        () => "wait",
        () => ({ type: "approval", timeoutSeconds: WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS }),
      );
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
      step.waitForEvent(
        () => "wait",
        () => ({ type: "approval", timeoutSeconds: WORKFLOW_MAX_INSTANCE_LIFETIME_SECONDS }),
      );
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
      step.do(
        () => "effect",
        () => ({
          retryDelaysSeconds: [],
          effect: async () => {
            entered.resolve();
            return oldResult.promise;
          },
        }),
      );
    const oldRun = f.runtime.runOne(SCOPE, "instance");
    void oldRun.catch(() => undefined);
    await entered.promise;
    await f.advance(10_001);
    await oldRun.catch(() => undefined);
    f.hooks.application = (step) =>
      step.do(
        () => "effect",
        () => ({ retryDelaysSeconds: [], effect: () => ({ owner: "replacement" }) }),
      );
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
    expect(f.row()).toMatchObject({ status: "running", run_owner: expect.any(String) });
    await expect(f.runtime.instances.terminate(SCOPE, "instance")).rejects.toMatchObject({
      name: "backend_unavailable",
      code: "backend_unavailable",
    });
    expect(f.row()).toMatchObject({ status: "terminated", run_owner: expect.any(String) });
    f.hooks.beforeStop = async () => undefined;
    await f.runtime.instances.terminate(SCOPE, "instance");
    expect(f.row()).toMatchObject({ status: "terminated", run_owner: null });
  });
});
