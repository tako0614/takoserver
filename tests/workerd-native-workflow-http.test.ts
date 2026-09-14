import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  selfhostWorkerEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { createWorkerdWorkflowExecutionHost } from "../src/selfhost-workflow-execution-host.ts";
import { createSelfhostWorkflowPreparation } from "../src/selfhost-workflow-preparation.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { createWorkflowRuntime } from "../src/workflow-execution.ts";

const workerd = process.env.TAKOSERVER_WORKERD_BINARY;
const guardBinary = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;
const scope = { tenantId: "tenant", workflowResourceUid: "workflow" };

const poisonNonPromiseIntrinsicsSource = `
const define = Object.defineProperty;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const broken = () => { throw new Error("poisoned intrinsic invoked"); };
define(Object.prototype, "toJSON", { value: broken, configurable: true });
define(Object.prototype, "signal", { get: broken, configurable: true });
define(Object.prototype, "headers", { get: broken, configurable: true });
define(typedArrayPrototype, "byteLength", { get: broken, configurable: true });
Object.keys = Object.getOwnPropertyDescriptors = Object.getOwnPropertyDescriptor = broken;
Object.getPrototypeOf = Object.defineProperty = Object.create = Object.hasOwn = broken;
Reflect.apply = Reflect.construct = Reflect.get = Reflect.ownKeys = broken;
WeakMap.prototype.get = WeakMap.prototype.set = broken;
WeakSet.prototype.has = WeakSet.prototype.add = broken;
Map.prototype.get = Map.prototype.set = broken;
Set.prototype.has = Set.prototype.add = Set.prototype.delete = broken;
JSON.parse = JSON.stringify = broken;
TextEncoder.prototype.encode = broken;
globalThis.TextEncoder = broken;
console.error = broken;
`;

// These native-profile gaps are refusal tests, not positive conformance.
const poisonIntrinsicsSource = `${poisonNonPromiseIntrinsicsSource}
const originalPromise = Promise;
globalThis.Promise = broken;
originalPromise.prototype.then = originalPromise.prototype.catch = originalPromise.prototype.finally = broken;
define(originalPromise, Symbol.species, { value: broken, configurable: true });
`;

const applications = [
  {
    name: "module-load-error-after-ready",
    source: `throw Error("module import occurs only after RUN"); export class Application {}`,
    infrastructure: "host_unavailable",
  },
  {
    name: "memo-and-private-env",
    source: `
export class Application {
  constructor(env) { this.env = env; }
  async run(event, step) {
    let builtinImport = false;
    try { await import("cloudflare:workers"); builtinImport = true; } catch {}
    if (builtinImport) throw Error("imported control builtin");
    if (Object.keys(this.env).join() !== "SETTING") throw Error("projected control env");
    let privateImport = false;
    try { await import("./${SELFHOST_WORKER_ENTRYPOINT_MODULE}"); privateImport = true; } catch {}
    if (privateImport) throw Error("imported private projector");
    const first = await step.do("memo", () => ({ value: this.env.SETTING, input: event.params.value }));
    const second = await step.do("memo", null, { invalid: true });
    await step.sleep("zero", 0);
    return { first, second, instance: event.instanceId };
  }
}`,
    output: {
      first: { value: "selected", input: 7 },
      second: { value: "selected", input: 7 },
      instance: "instance",
    },
  },
  {
    name: "poisoned-non-promise-intrinsics",
    source: `
export class Application {
  constructor(env) { this.env = env; }
  run(event, step) {
${poisonNonPromiseIntrinsicsSource}
    return step.do("protected", () => ({ value: this.env.SETTING, input: event.params.value }))
      .then(value => ({ value }));
  }
}`,
    output: { value: { value: "selected", input: 7 } },
  },
  {
    name: "in-run-promise-poison-refusal",
    source: `
export class Application {
  constructor(env) { this.env = env; }
  run(event, step) {
${poisonIntrinsicsSource}
    return step.do("protected", () => ({ value: this.env.SETTING, input: event.params.value }))
      .then(value => ({ value }));
  }
}`,
    infrastructure: "host_unavailable",
  },
  {
    name: "startup-poison-refusal",
    source: `
${poisonIntrinsicsSource}
export class Application {
  constructor(env) { this.env = env; }
  run(event, step) {
    return step.do("protected", () => ({ value: this.env.SETTING, input: event.params.value }))
      .then(value => ({ value }));
  }
}`,
    infrastructure: "host_unavailable",
  },
  {
    name: "checked-input",
    source: `export class Application { async run(event, step) {
      let checked = false;
      try { await step.do("", null); } catch (error) { checked = error instanceof TypeError; }
      return { checked, value: await step.do("valid", () => ({ ok: true })) };
    } }`,
    output: { checked: true, value: { ok: true } },
  },
  {
    name: "inherited-then-memo-refusal",
    source: `export class Application { async run(event, step) {
      const first = await step.do("memo", () => ({ value: 7 }));
      Object.defineProperty(Object.prototype, "then", { configurable: true, value() { throw Error("inherited then observed private data"); } });
      let second;
      try { second = await step.do("memo", null); }
      finally { delete Object.prototype.then; }
      return { first, second };
    } }`,
    infrastructure: "host_unavailable",
    retainedSteps: [{ name: "memo", kind: "do", state: "complete", result_json: '{"value":7}' }],
  },
  {
    name: "inherited-then-final-response",
    source: `export class Application { run() {
      Object.defineProperty(Object.prototype, "then", { configurable: true, value() { throw Error("private Response assimilated"); } });
      return undefined;
    } }`,
    output: undefined,
  },
  {
    name: "unsettled-step-mismatch",
    source: `export class Application { run(event, step) {
      step.do("never-commit", () => ({ unexpected: true }));
      return { ignored: true };
    } }`,
    reason: "step_definition_mismatch",
  },
  {
    name: "genuine-error",
    source: `export class Application { async run(event, step) {
      let saved;
      try { await step.do("failure", () => { throw Error("app failure"); }); } catch (error) { saved = error; }
      try { await step.do("failure", null); } catch {}
      throw saved;
    } }`,
    reason: "step_failed",
  },
  {
    name: "forged-error",
    source: `export class Application { async run(event, step) {
      try { await step.do("failure", () => { throw Error("app failure"); }); }
      catch (error) { throw { name: error.name, message: error.message }; }
    } }`,
    reason: "run_threw",
  },
] as const;

test.skipIf(workerd === undefined || guardBinary === undefined)(
  "pinned guarded HTTP class bridge uses canonical env and durable step coordinator",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-native-workflow-http-"));
    try {
      const artifact = await selectClosedGraphWorkerd({
        binary: workerd,
        privateRoot: join(root, "artifact"),
      });
      if (!artifact.binary) throw new Error(artifact.diagnostic ?? "no pinned runtime");
      const binary = artifact.binary;
      for (const application of applications) {
        const directory = await mkdtemp(join(root, `${application.name}-`));
        const db = new Database(":memory:");
        for (const name of [
          "0050_workflow_instances.sql",
          "0051_workflow_execution.sql",
          "0052_workflow_termination_intent.sql",
        ]) {
          db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
        }
        const prelude = selfhostWorkerPreludeModuleName("app.js");
        const wrapper = SELFHOST_WORKER_ENTRYPOINT_MODULE;
        const serving = createWorkerdRuntime({ root: directory, isReady: () => true });
        if (!serving.publish) throw new Error("weighted publication is unavailable");
        // Filesystem publication fixture, not semantic admission of the forward
        // Workflow candidate or readiness qualification of the HTTP serving graph.
        await serving.publish("workflow", {
          generation: "workflow.selected",
          workerResourceUid: "uid-ModuleWorker-workflow",
          hostnames: [],
          versions: [
            {
              versionId: "version",
              workerVersionUid: "uid-WorkerVersion-workflow",
              weight: 10_000,
              site: {
                directory: "workflow",
                mainModule: "app.js",
                hostEntrypoint: wrapper,
                hostModules: [prelude],
                hostnames: [],
                fetchHandler: true,
                workerResourceUid: "uid-ModuleWorker-workflow",
                vars: [{ name: "SETTING", kind: "text", value: "selected" }],
              },
              modules: new Map([
                [
                  "app.js",
                  new TextEncoder().encode(
                    `${application.source}\nexport default { fetch() { return new Response("ordinary required default"); } };`,
                  ),
                ],
              ]),
              hostModules: new Map([
                [prelude, new TextEncoder().encode(selfhostWorkerPreludeSource())],
                [
                  wrapper,
                  new TextEncoder().encode(
                    selfhostWorkerEntrypointSource({
                      originalMainModule: "app.js",
                      publication: "workflow.selected",
                      probeHostname: "workflow.internal.invalid",
                      declaredHandlers: ["fetch"],
                      bindings: [{ type: "plain_text", name: "SETTING" }],
                    }),
                  ),
                ],
              ]),
            },
          ],
        });
        const prepare = createSelfhostWorkflowPreparation({
          runtimeRoot: directory,
          // A short private socket path, independent of the long evidence root.
          resolveTarget: async () => ({
            ...scope,
            script: "workflow",
            workerResourceUid: "uid-ModuleWorker-workflow",
            className: "Application",
          }),
        });
        let configured = 0;
        let readyChecks = 0;
        let disposed = 0;
        const host = createWorkerdWorkflowExecutionHost({
          guardBinary: guardBinary as string,
          workerdBinary: binary,
          maximumRegistrations: 4,
          async prepare(identity, input, signal, channel) {
            configured += 1;
            const prepared = await prepare(identity, input, signal, channel);
            return {
              ...prepared,
              async run(driver) {
                // The real guard has started, but RUN has not been sent.
                // Even the top-level-throw application must answer ready here:
                // this replaces the old fixture-only global import sentinel.
                let ready: Response | undefined;
                const until = Date.now() + 2_000;
                while (!ready && Date.now() < until) {
                  try {
                    ready = await fetch(`http://workflow.internal/${channel.journalToken}/ready`, {
                      unix: join(dirname(prepared.configPath), "run.sock"),
                      redirect: "error",
                      signal: AbortSignal.timeout(200),
                    });
                  } catch {
                    await Bun.sleep(10);
                  }
                }
                if (!ready) throw new Error("private child was not ready before RUN");
                expect(ready.status).toBe(200);
                expect(await ready.text()).toBe("ready");
                readyChecks += 1;
                return prepared.run(driver);
              },
              async dispose() {
                await prepared.dispose();
                disposed += 1;
              },
            };
          },
        });
        let random = 0;
        const runtime = createWorkflowRuntime({
          sql: createSqliteSql(db),
          clock: () => new Date(),
          randomId: () => `id-${++random}`,
          host,
          leaseMs: 10_000,
          waitUntil(at, signal) {
            return new Promise<void>((resolve) => {
              if (signal.aborted) {
                resolve();
                return;
              }
              const finish = () => {
                clearTimeout(timer);
                signal.removeEventListener("abort", finish);
                resolve();
              };
              const timer = setTimeout(
                finish,
                Math.min(2_147_483_647, Math.max(0, at - Date.now())),
              );
              signal.addEventListener("abort", finish, { once: true });
            });
          },
        });
        try {
          await runtime.instances.create(scope, { id: "instance", params: { value: 7 } });
          expect(configured).toBe(0);
          if ("infrastructure" in application) {
            await expect(runtime.runOne(scope, "instance")).rejects.toMatchObject({
              code: application.infrastructure,
            });
            const status = await runtime.instances.status(scope, "instance");
            expect(["complete", "errored", "terminated"]).not.toContain(status.status);
            expect(status.output).toBeUndefined();
            expect(
              db
                .query(
                  "SELECT status, output_json, run_owner, run_lease_until FROM tf_workflow_instances WHERE instance_id = 'instance'",
                )
                .get(),
            ).toMatchObject({
              output_json: null,
              run_owner: null,
              run_lease_until: null,
            });
            expect(
              db
                .query("SELECT name, kind, state, result_json FROM tf_workflow_steps ORDER BY name")
                .all(),
            ).toEqual("retainedSteps" in application ? [...application.retainedSteps] : []);
          } else {
            const result = await runtime.runOne(scope, "instance");
            const status = await runtime.instances.status(scope, "instance");
            if ("output" in application) {
              expect(result).toEqual(
                application.output === undefined
                  ? { kind: "complete" }
                  : { kind: "complete", output: application.output },
              );
              expect(status.output).toEqual(application.output);
            } else {
              expect(result).toEqual({ kind: "terminal", status: "errored" });
              expect(status.error?.reason).toBe(application.reason);
            }
          }
          expect(configured).toBe(1);
          expect(readyChecks).toBe(1);
          expect(disposed).toBe(1);
        } finally {
          await host.close();
          db.close();
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  40_000,
);
