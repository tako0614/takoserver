import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { JsonObject } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { executeWorkflowClass, type WorkflowClassStep } from "../src/workflow-class-execution.ts";
import { createWorkflowRuntime, type WorkflowDriver } from "../src/workflow-execution.ts";

const START = Date.UTC(2026, 0, 1);
const SCOPE = { tenantId: "tenant", workflowResourceUid: "workflow" };
const migrations = [
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

/** Real durable coordinator, fake isolated host: no physical-stop claim. */
function fixture(namespace: Record<string, unknown>, env: Record<string, unknown> = {}) {
  const db = new Database(":memory:");
  db.exec(migrations);
  databases.push(db);
  let time = START;
  let nextId = 0;
  let stops = 0;
  const runtime = createWorkflowRuntime({
    sql: createSqliteSql(db),
    clock: () => new Date(time),
    randomId: () => `id-${++nextId}`,
    waitUntil: (_at, signal) =>
      new Promise<void>((resolve) => {
        if (signal.aborted) resolve();
        else signal.addEventListener("abort", () => resolve(), { once: true });
      }),
    host: {
      async openPaused(identity, input) {
        return {
          run: (driver) =>
            executeWorkflowClass({
              namespace,
              className: "Workflow",
              env,
              instanceId: identity.instanceId,
              ...(input === undefined ? {} : { params: input }),
              driver,
            }),
          async extendDeadline() {},
        };
      },
      async stop() {
        stops += 1;
        return "stopped";
      },
    },
  });
  return {
    db,
    runtime,
    create: (params?: JsonObject) =>
      runtime.instances.create(SCOPE, {
        id: "instance",
        ...(params === undefined ? {} : { params }),
      }),
    run: () => runtime.runOne(SCOPE, "instance"),
    status: () => runtime.instances.status(SCOPE, "instance"),
    advance: (seconds: number) => {
      time += seconds * 1_000;
    },
    stops: () => stops,
  };
}

describe("private forward Workflow class execution", () => {
  test("ordinary constructor, this, selected env and exact event; output is a detached document", async () => {
    const env = { SETTING: "declared" };
    const params = { nested: { original: true } };
    let constructed = 0;
    let returned: JsonObject | undefined;
    const f = fixture(
      {
        Workflow: class {
          readonly env: unknown;
          constructor(selected: unknown) {
            constructed += 1;
            this.env = selected;
          }
          run(event: { instanceId: string; params: JsonObject }, step: WorkflowClassStep) {
            expect(this.env).toBe(env);
            expect(Object.keys(event)).toEqual(["instanceId", "params"]);
            expect(event.instanceId).toBe("instance");
            expect(event.params).toEqual(params);
            expect(Object.keys(step).sort()).toEqual(["do", "sleep", "waitForEvent"]);
            Reflect.set(event.params, "changed", true);
            returned = { value: "ok" };
            return returned;
          }
        },
      },
      env,
    );
    await f.create(params);
    expect(await f.run()).toEqual({ kind: "complete", output: { value: "ok" } });
    if (returned !== undefined) Reflect.set(returned, "value", "later");
    expect((await f.status()).output).toEqual({ value: "ok" });
    expect(params).toEqual({ nested: { original: true } });
    expect(constructed).toBe(1);
    expect(f.stops()).toBe(1);
  });

  test("constructor-returned object and a single run lookup follow ordinary JS semantics", async () => {
    let lookups = 0;
    const returned = {
      get run() {
        lookups += 1;
        return function (this: unknown, event: object) {
          expect(this).toBe(returned);
          expect(Object.keys(event)).toEqual(["instanceId"]);
          return undefined;
        };
      },
    };
    function Workflow() {
      return returned;
    }
    const f = fixture({ Workflow });
    await f.create();
    expect(await f.run()).toEqual({ kind: "complete" });
    expect(lookups).toBe(1);
  });

  test.each([
    ["missing", undefined],
    ["arrow", () => ({ run() {} })],
    [
      "constructor throws",
      class {
        constructor() {
          throw new Error("constructor");
        }
      },
    ],
    ["run missing", class {}],
    [
      "run non-callable",
      class {
        run = 42;
      },
    ],
    [
      "run getter throws",
      class {
        get run(): never {
          throw new Error("lookup");
        }
      },
    ],
    [
      "run throws",
      class {
        run() {
          throw new Error("run");
        }
      },
    ],
    [
      "run rejects",
      class {
        async run() {
          throw new Error("run");
        }
      },
    ],
    [
      "invalid output",
      class {
        run() {
          return [];
        }
      },
    ],
    [
      "nested undefined output",
      class {
        run() {
          return { bad: undefined };
        }
      },
    ],
  ])("%s is run_threw, not an infrastructure retry", async (_label, Workflow) => {
    const f = fixture({ Workflow });
    await f.create();
    expect(await f.run()).toEqual({ kind: "terminal", status: "errored" });
    expect((await f.status()).error?.reason).toBe("run_threw");
  });

  test("finished history skips invalid unused arguments across methods and preserves clones", async () => {
    let effects = 0;
    const result = { nested: { value: 1 } };
    const f = fixture({
      Workflow: class {
        async run(_event: unknown, step: WorkflowClassStep) {
          const first = await step.do("one", () => {
            effects += 1;
            return result;
          });
          expect(first).not.toBe(result);
          if (first !== undefined) Reflect.set(first, "nested", { value: 2 });
          expect(await step.do("one", null, { unsupported: true })).toEqual(result);
          expect(await step.waitForEvent("one", null)).toEqual(result);
          expect(await step.sleep("one", "unused")).toBeUndefined();
          return undefined;
        }
      },
    });
    await f.create();
    expect(await f.run()).toEqual({ kind: "complete" });
    expect(effects).toBe(1);
    expect(result).toEqual({ nested: { value: 1 } });
  });

  test("invalid JS calls are catchable TypeErrors without effects or journal writes", async () => {
    let effects = 0;
    const f = fixture({
      Workflow: class {
        async run(_event: unknown, step: WorkflowClassStep) {
          const badCalls = [
            () =>
              step.do("", () => {
                effects += 1;
              }),
            () =>
              step.do("\ud800", () => {
                effects += 1;
              }),
            () => step.do("bad-effect", 4),
            () =>
              step.do(
                "no-attempts",
                () => {
                  effects += 1;
                },
                {},
              ),
            () =>
              step.do(
                "extra",
                () => {
                  effects += 1;
                },
                { maxAttempts: 1, extra: true },
              ),
            () =>
              step.do(
                "undefined-field",
                () => {
                  effects += 1;
                },
                { maxAttempts: 1, backoff: undefined },
              ),
            () =>
              step.do(
                "range",
                () => {
                  effects += 1;
                },
                { maxAttempts: 101 },
              ),
            () =>
              step.do(
                "null",
                () => {
                  effects += 1;
                },
                null,
              ),
            () => step.sleep("negative", -1),
            () => step.sleep("fraction", 0.5),
            () => step.sleep("coercion", "0"),
            () => step.sleep("overflow", 31_536_001),
            () => step.waitForEvent("missing", { type: "event" }),
            () => step.waitForEvent("timeout", { type: "event", timeoutSeconds: 0 }),
            () =>
              step.waitForEvent("hidden", Object.defineProperty({}, "type", { value: "event" })),
          ];
          for (const call of badCalls) await expect(call()).rejects.toBeInstanceOf(TypeError);
          expect(f.db.query("SELECT COUNT(*) AS count FROM tf_workflow_steps").get()).toEqual({
            count: 0,
          });
          return { handled: true };
        }
      },
    });
    await f.create();
    expect(await f.run()).toEqual({ kind: "complete", output: { handled: true } });
    expect(effects).toBe(0);
  });

  test("option validation does not invoke getters", async () => {
    let gets = 0;
    const f = fixture({
      Workflow: class {
        async run(_event: unknown, step: WorkflowClassStep) {
          const policy = {
            get maxAttempts() {
              gets += 1;
              return 1;
            },
          };
          await expect(step.do("options", () => undefined, policy)).rejects.toBeInstanceOf(
            TypeError,
          );
        }
      },
    });
    await f.create();
    expect(await f.run()).toEqual({ kind: "complete" });
    expect(gets).toBe(0);
  });

  test.each(["return", "throw", "overlap"])(
    "%s with an unsettled app step is uncatchable mismatch",
    async (mode) => {
      let caught = 0;
      let finalized = 0;
      let effects = 0;
      const f = fixture({
        Workflow: class {
          run(_event: unknown, step: WorkflowClassStep) {
            void step
              .do("pending", () => {
                effects += 1;
                return {};
              })
              .catch(() => {
                caught += 1;
              })
              .finally(() => {
                finalized += 1;
              });
            if (mode === "throw") throw new Error("run threw with an outstanding step");
            if (mode === "overlap") return step.sleep("second", 0);
            return {};
          }
        },
      });
      await f.create();
      expect(await f.run()).toEqual({ kind: "terminal", status: "errored" });
      expect((await f.status()).error?.reason).toBe("step_definition_mismatch");
      expect(caught).toBe(0);
      expect(finalized).toBe(0);
      expect(effects).toBe(0);
    },
  );

  test("discarding a finished memo still observes the app-facing Promise boundary", async () => {
    let effects = 0;
    const f = fixture({
      Workflow: class {
        async run(_event: unknown, step: WorkflowClassStep) {
          await step.do("done", () => {
            effects += 1;
            return {};
          });
          void step.sleep("done", "unused");
          return {};
        }
      },
    });
    await f.create();
    expect(await f.run()).toEqual({ kind: "terminal", status: "errored" });
    expect((await f.status()).error?.reason).toBe("step_definition_mismatch");
    expect(effects).toBe(1);
  });

  test("even an immediately-resolved private driver cannot hide a discarded app Promise", async () => {
    let signalMismatch!: () => void;
    const signaled = new Promise<void>((resolve) => {
      signalMismatch = resolve;
    });
    let settled = false;
    const driver: WorkflowDriver = {
      do: () => Promise.resolve(undefined),
      sleep: () => Promise.resolve(),
      waitForEvent: () => Promise.resolve(undefined),
      definitionMismatch() {
        signalMismatch();
        return new Promise<never>(() => undefined);
      },
    };
    void executeWorkflowClass({
      namespace: {
        Workflow: class {
          run(_event: unknown, step: WorkflowClassStep) {
            void step.sleep("already-complete", 0);
            return {};
          }
        },
      },
      className: "Workflow",
      env: {},
      instanceId: "instance",
      driver,
    }).then(() => {
      settled = true;
    });
    await signaled;
    expect(settled).toBe(false);
  });

  test("a driver transport failure rejects the host without entering app catch/finally", async () => {
    let caught = 0;
    let finalized = 0;
    const failure = new Error("private transport lost");
    const driver: WorkflowDriver = {
      do: () => Promise.reject(failure),
      sleep: () => Promise.reject(failure),
      waitForEvent: () => Promise.reject(failure),
      definitionMismatch: () => new Promise<never>(() => undefined),
    };
    const execution = executeWorkflowClass({
      namespace: {
        Workflow: class {
          async run(_event: unknown, step: WorkflowClassStep) {
            try {
              await step.sleep("pending", 1);
            } catch {
              caught += 1;
            } finally {
              finalized += 1;
            }
          }
        },
      },
      className: "Workflow",
      env: {},
      instanceId: "instance",
      driver,
    });
    await expect(execution).rejects.toBe(failure);
    expect(caught).toBe(0);
    expect(finalized).toBe(0);
  });

  test.each(["exact", "copy", "wrap", "handled"])("host error provenance: %s", async (mode) => {
    let caught: Error | undefined;
    const f = fixture({
      Workflow: class {
        async run(_event: unknown, step: WorkflowClassStep) {
          try {
            await step.do("failure", () => {
              throw new Error("effect");
            });
          } catch (error) {
            if (!(error instanceof Error)) throw error;
            caught = error;
            expect(Object.getOwnPropertyDescriptor(error, "name")).toEqual({
              value: "step_failed",
              writable: false,
              enumerable: false,
              configurable: false,
            });
            Object.assign(error, { annotated: true, code: "anything" });
            if (mode === "exact") throw error;
            if (mode === "copy") throw Object.assign(new Error("copy"), { name: error.name });
            if (mode === "wrap") throw new Error("wrapped", { cause: error });
          }
        }
      },
    });
    await f.create();
    await f.run();
    expect(caught).toBeInstanceOf(Error);
    const status = await f.status();
    if (mode === "handled") expect(status.status).toBe("complete");
    else expect(status.error?.reason).toBe(mode === "exact" ? "step_failed" : "run_threw");
  });

  test("retry policy is normalized once, capped and retained across fresh class invocations", async () => {
    let constructions = 0;
    let effects = 0;
    let policy: unknown = {
      maxAttempts: 4,
      initialDelaySeconds: 2,
      backoff: "exponential",
      maxDelaySeconds: 3,
    };
    const f = fixture({
      Workflow: class {
        constructor() {
          constructions += 1;
        }
        async run(_event: unknown, step: WorkflowClassStep) {
          return step.do(
            "retry",
            () => {
              effects += 1;
              if (effects < 4) throw new Error("retry");
              return { effects };
            },
            policy,
          );
        }
      },
    });
    await f.create();
    for (const delay of [2, 3, 3]) {
      expect(await f.run()).toEqual({ kind: "parked" });
      expect(f.db.query("SELECT config_json FROM tf_workflow_steps").get()).toEqual({
        config_json: '{"retryDelaysSeconds":[2,3,3]}',
      });
      policy = { maxAttempts: 1 };
      f.advance(delay);
    }
    expect(await f.run()).toEqual({ kind: "complete", output: { effects: 4 } });
    expect(constructions).toBe(4);
  });

  test("zero-delay retry parks and reconstructs instead of looping in the same context", async () => {
    let attempts = 0;
    const f = fixture({
      Workflow: class {
        run(_event: unknown, step: WorkflowClassStep) {
          return step.do(
            "zero",
            () => {
              if (++attempts === 1) throw new Error("retry");
              return undefined;
            },
            { maxAttempts: 2 },
          );
        }
      },
    });
    await f.create();
    expect(await f.run()).toEqual({ kind: "parked" });
    expect(attempts).toBe(1);
    expect(await f.run()).toEqual({ kind: "complete" });
    expect(attempts).toBe(2);
  });

  test("invalid callback results use the saved policy, not final-output failure", async () => {
    let attempts = 0;
    const f = fixture({
      Workflow: class {
        run(_event: unknown, step: WorkflowClassStep) {
          return step.do(
            "invalid",
            () => {
              attempts += 1;
              return { nested: undefined };
            },
            { maxAttempts: 2 },
          );
        }
      },
    });
    await f.create();
    expect(await f.run()).toEqual({ kind: "parked" });
    expect(await f.run()).toEqual({ kind: "terminal", status: "errored" });
    expect((await f.status()).error?.reason).toBe("step_failed");
    expect(attempts).toBe(2);
  });

  test("retained event payload resolves and timeout rethrow remains run_threw", async () => {
    let timeout = false;
    const f = fixture({
      Workflow: class {
        async run(_event: unknown, step: WorkflowClassStep) {
          const payload = await step.waitForEvent("event", { type: "ready", timeoutSeconds: 1 });
          expect(payload).toEqual({ accepted: true });
          try {
            await step.waitForEvent("timeout", { type: "never", timeoutSeconds: 1 });
          } catch (error) {
            timeout = true;
            expect(error).toHaveProperty("name", "wait_timeout");
            throw error;
          }
        }
      },
    });
    await f.create();
    await f.runtime.instances.sendEvent(SCOPE, "instance", {
      type: "ready",
      payload: { accepted: true },
    });
    expect(await f.run()).toEqual({ kind: "parked" });
    f.advance(1);
    expect(await f.run()).toEqual({ kind: "terminal", status: "errored" });
    expect(timeout).toBe(true);
    expect((await f.status()).error?.reason).toBe("run_threw");
  });
});
