import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_WORKER_ENTRYPOINT_MODULE,
  SELFHOST_WORKER_PROJECT_ENV_EXPORT,
  selfhostWorkerEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { createWorkerdWorkflowExecutionHost } from "../src/selfhost-workflow-execution-host.ts";
import { prepareWorkflowHttpExecution } from "../src/selfhost-workflow-http-transport.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
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
        let configured = 0;
        let disposed = 0;
        const host = createWorkerdWorkflowExecutionHost({
          guardBinary: guardBinary as string,
          workerdBinary: binary,
          maximumRegistrations: 4,
          async prepare(identity, input, signal, channel) {
            configured += 1;
            return prepareWorkflowHttpExecution({
              channel,
              signal,
              async configure(companionAddress, configureSignal) {
                try {
                  configureSignal.throwIfAborted();
                  const reservation = Bun.serve({
                    hostname: "127.0.0.1",
                    port: 0,
                    fetch: () => new Response(),
                  });
                  const port = reservation.port;
                  reservation.stop(true);
                  const prelude = selfhostWorkerPreludeModuleName("app.js");
                  const wrapper = SELFHOST_WORKER_ENTRYPOINT_MODULE;
                  const entrySource = `
import { createWorkflowHttpWorker } from ${JSON.stringify(new URL("../src/workflow-http-worker.ts", import.meta.url).pathname)};
import { adoptTrustedWorkflowPromise as trusted } from ${JSON.stringify(new URL("../src/workflow-driver.ts", import.meta.url).pathname)};
const create = Object.create;
const implementation = createWorkflowHttpWorker({
 token: ${JSON.stringify(channel.journalToken)}, className: "Application",
 instanceId: ${JSON.stringify(identity.instanceId)}, params: ${JSON.stringify(input)},
 async load() {
   globalThis.__workflowFixtureRun = true;
   const wrapper = (await trusted(import(${JSON.stringify(`./${wrapper}`)}))).value;
   const namespace = (await trusted(import("./app.js"))).value;
   const loaded = create(null);
   loaded.namespace = namespace;
   loaded.projectEnv = wrapper[${JSON.stringify(SELFHOST_WORKER_PROJECT_ENV_EXPORT)}];
   return loaded;
 }
});
export default implementation;`;
                  const entry = join(directory, "entry.ts");
                  await writeFile(entry, entrySource, { mode: 0o600 });
                  const externalized = new Set<string>();
                  const build = await Bun.build({
                    entrypoints: [entry],
                    target: "browser",
                    format: "esm",
                    plugins: [
                      {
                        name: "retain-private-workerd-imports",
                        setup(builder) {
                          builder.onResolve({ filter: /^\.\//u }, (args) => {
                            if (
                              args.importer !== entry ||
                              (args.path !== `./${wrapper}` && args.path !== "./app.js")
                            )
                              return undefined;
                            externalized.add(args.path);
                            return { path: args.path, external: true };
                          });
                        },
                      },
                    ],
                  });
                  configureSignal.throwIfAborted();
                  if (!build.success || build.outputs.length !== 1)
                    throw new Error(`workflow bootstrap build: ${build.logs.join("\n")}`);
                  expect([...externalized].sort()).toEqual([`./${wrapper}`, "./app.js"].sort());
                  await writeFile(
                    join(directory, "entry.js"),
                    (await build.outputs[0]?.text()) ?? "",
                    { mode: 0o600 },
                  );
                  await writeFile(join(directory, prelude), selfhostWorkerPreludeSource(), {
                    mode: 0o600,
                  });
                  await writeFile(
                    join(directory, wrapper),
                    selfhostWorkerEntrypointSource({
                      originalMainModule: "app.js",
                      publication: "workflow.selected",
                      probeHostname: "workflow.internal.invalid",
                      declaredHandlers: ["fetch"],
                      bindings: [{ type: "plain_text", name: "SETTING" }],
                    }),
                    { mode: 0o600 },
                  );
                  await writeFile(
                    join(directory, "app.js"),
                    `
if (globalThis.__workflowFixtureRun !== true) throw Error("application evaluated before RUN");
${application.source}
export default { fetch() { return new Response("ordinary required default"); } };`,
                    { mode: 0o600 },
                  );
                  const configPath = join(directory, "run.capnp");
                  await writeFile(
                    configPath,
                    `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
 services = [
  (name = "application", worker = (
   modules = [
    (name = "entry.js", esModule = embed "entry.js", role = hostPrivate),
    (name = ${JSON.stringify(prelude)}, esModule = embed ${JSON.stringify(prelude)}, role = hostPrivate),
    (name = ${JSON.stringify(wrapper)}, esModule = embed ${JSON.stringify(wrapper)}, role = hostPrivate),
    (name = "app.js", esModule = embed "app.js", role = application)
   ],
   modulePolicy = (applicationMain = "app.js"), compatibilityDate = "2026-01-01",
   compatibilityFlags = ["disallow_importable_env"], globalOutbound = "deny",
   bindings = [
    (name = "SETTING", text = "selected"),
    (name = "__TAKOSERVER_WORKFLOW_COMPANION", service = "companion")
   ]
  )),
  (name = "companion", external = (address = ${JSON.stringify(companionAddress)}, http = ())),
  (name = "deny", network = (allow = []))
 ],
 sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "application")]
);`,
                    { mode: 0o600 },
                  );
                  configureSignal.throwIfAborted();
                  return {
                    configPath,
                    runOrigin: `http://127.0.0.1:${port}`,
                    async dispose() {
                      disposed += 1;
                      await rm(directory, { recursive: true, force: true });
                    },
                  };
                } catch (error) {
                  await rm(directory, { recursive: true, force: true });
                  throw error;
                }
              },
            });
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
