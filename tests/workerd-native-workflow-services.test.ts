import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { chmod, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
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
import {
  createWorkerdRuntime,
  type WorkerdDeploymentPublication,
  type WorkerdServiceBinding,
} from "../src/workerd-runtime.ts";
import { createWorkflowRuntime } from "../src/workflow-execution.ts";

const workerd = process.env.TAKOSERVER_WORKERD_BINARY;
const guardBinary = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;
const scope = { tenantId: "tenant", workflowResourceUid: "workflow" };
const targetUid = "uid-ModuleWorker-target";
const bindings: readonly WorkerdServiceBinding[] = [0, 1].map((index) => ({
  name: `__TAKOSERVER_SELFHOST_SERVICE_0000${index}`,
  target: "target",
  targetResourceUid: targetUid,
  unavailableToken: String(index + 1).repeat(64),
}));

function publication(
  script: string,
  version: string,
  uid: string,
  source: string,
  services: readonly WorkerdServiceBinding[] = [],
): WorkerdDeploymentPublication {
  const prelude = selfhostWorkerPreludeModuleName("app.js");
  const wrapper = SELFHOST_WORKER_ENTRYPOINT_MODULE;
  const encode = (text: string) => new TextEncoder().encode(text);
  return {
    generation: `${script}.${version}`,
    workerResourceUid: uid,
    hostnames: [],
    versions: [
      {
        versionId: version,
        workerVersionUid: `uid-WorkerVersion-${script}-${version}`,
        weight: 10_000,
        site: {
          directory: script,
          mainModule: "app.js",
          hostEntrypoint: wrapper,
          hostModules: [prelude],
          hostnames: [],
          fetchHandler: true,
          workerResourceUid: uid,
          serviceBindings: services,
        },
        modules: new Map([["app.js", encode(source)]]),
        hostModules: new Map([
          [prelude, encode(selfhostWorkerPreludeSource())],
          [
            wrapper,
            encode(
              selfhostWorkerEntrypointSource({
                originalMainModule: "app.js",
                publication: `${script}.${version}`,
                probeHostname: `${script}.internal.invalid`,
                declaredHandlers: ["fetch"],
                bindings: services.map((binding, index) => ({
                  kind: "worker.service@1.0.0",
                  publicName: index === 0 ? "PEER" : "OFFLINE",
                  internalName: binding.name,
                  unavailableToken: binding.unavailableToken,
                })),
              }),
            ),
          ],
        ]),
      },
    ],
  };
}

function targetSource(version: string): string {
  return `export default { async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/error") return new Response("application error", {status:500});
    if (path === "/spoof") return new Response("application response", {status:530,
      headers:{"x-takoserver-selfhost-service-unavailable":"not-the-token"}});
    if (path === "/socket") {
      const pair = new WebSocketPair(); pair[1].accept();
      pair[1].addEventListener("message", event => pair[1].send("echo:" + event.data));
      return new Response(null, {status:101, webSocket:pair[0]});
    }
    if (path === "/stream") return new Response(request.body, {headers:{"x-stream":"native"}});
    if (path === "/slow") {
      // Keep a real pending timer: a bare never-settled Promise is rejected by
      // workerd's hang detector before the caller can exercise cancellation.
      await new Promise(resolve => setTimeout(resolve, 1_000));
      return new Response("not cancelled");
    }
    return Response.json({version:${JSON.stringify(version)}, url:request.url,
      method:request.method, host:request.headers.get("host"), custom:request.headers.get("x-caller"),
      marker:request.headers.get("x-takoserver-selfhost-service-unavailable"), body:await request.text()});
  } };`;
}

const applicationSource = `
export class Application {
  constructor(env) { this.env = env; }
  async run(event, step) {
    const peer = this.env.PEER;
    const before = await step.do("before", async () => {
      const echo = await (await peer.fetch("https://arbitrary.example:8443/echo?q=1", {
        method:"POST", headers:{host:"independent.example", "x-caller":"kept",
          "x-takoserver-selfhost-service-unavailable":"application-value"}, body:"payload"
      })).json();
      let controller;
      const body = new ReadableStream({start(value) { controller=value; value.enqueue(new TextEncoder().encode("first")); }});
      const response = await peer.fetch("https://arbitrary.example/stream", {method:"POST", body});
      const reader = response.body.getReader();
      const first = new TextDecoder().decode((await reader.read()).value);
      controller.enqueue(new TextEncoder().encode("second")); controller.close();
      let rest = "";
      for (;;) {const item=await reader.read(); if(item.done)break; rest+=new TextDecoder().decode(item.value);}
      const socketResponse = await peer.fetch("https://arbitrary.example/socket", {headers:{upgrade:"websocket"}});
      const ws = socketResponse.webSocket; ws.accept();
      const message = new Promise((resolve,reject) => {
        ws.addEventListener("message", event => resolve(event.data), {once:true});
        ws.addEventListener("error", reject, {once:true});
      });
      ws.send("hello"); const echoed = await message; ws.close(1000, "done");
      const abort = new AbortController();
      const pending = peer.fetch("https://arbitrary.example/slow", {signal:abort.signal});
      const cancelled = pending.then(() => false, error => abort.signal.aborted && error.name !== "backend_unavailable");
      await new Promise(resolve => setTimeout(resolve, 10)); abort.abort();
      const error = await peer.fetch("https://arbitrary.example/error");
      const spoof = await peer.fetch("https://arbitrary.example/spoof");
      return {echo, first, rest, echoed, aborted:await cancelled, errorStatus:error.status,
        errorBody:await error.text(), spoofStatus:spoof.status, spoofBody:await spoof.text(),
        env:Object.keys(this.env).sort()};
    });
    const after = await step.do("after", async () => (await peer.fetch("https://ignored.example/echo")).json());
    const unavailable = async (service, options) => {
      try { await service.fetch("https://ignored.example/echo", options); return {name:"unexpected response"}; }
      catch(error) { return {name:error.name, message:String(error.message)}; }
    };
    const deleted = await step.do("deleted", () => unavailable(peer));
    const reused = await step.do("reused", () => unavailable(peer));
    const offline = await step.do("offline", () => unavailable(this.env.OFFLINE, {
      method:"POST", body:new ReadableStream({start(controller) {
        controller.enqueue(new Uint8Array(128 * 1024)); controller.close();
      }})
    }));
    return {before, after, deleted, reused, offline};
  }
}
export default {fetch() {return new Response("ordinary handler");}};
`;

test.skipIf(workerd === undefined || guardBinary === undefined)(
  "one guarded class keeps captured bindings while native targets rotate, disappear and reuse names",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "workflow-services-"));
    const sockets = await mkdtemp(join(tmpdir(), "tss-"));
    await chmod(sockets, 0o700);
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = Number(reserved.port);
    reserved.stop(true);
    const db = new Database(":memory:");
    let shared: ReturnType<typeof Bun.spawn> | undefined;
    let host: ReturnType<typeof createWorkerdWorkflowExecutionHost> | undefined;
    let processStarts = 0;
    let preparedCount = 0;
    let disposedCount = 0;
    let testFailed = false;
    let testFailure: unknown;
    const cleanupFailures: unknown[] = [];
    let nativeDiagnostics = "";
    let stderrDrained: Promise<void> = Promise.resolve();
    const configuredRoots: string[] = [];
    const stopShared = async () => {
      if (!shared) return;
      shared.kill("SIGKILL");
      await shared.exited;
      await stderrDrained;
      shared = undefined;
    };
    try {
      const artifact = await selectClosedGraphWorkerd({
        binary: workerd,
        privateRoot: join(root, "artifact"),
      });
      if (!artifact.binary) throw new Error(artifact.diagnostic ?? "no pinned runtime");
      const binary = artifact.binary;
      const serving = createWorkerdRuntime({
        root,
        binary,
        port,
        serviceBindingSocketDirectory: sockets,
        isReady: () => shared !== undefined && shared.exitCode === null,
        async onReload(configPath) {
          if (shared) return;
          processStarts += 1;
          const spawned = Bun.spawn([binary, "serve", "--watch", configPath], {
            env: {},
            stdout: "ignore",
            stderr: "pipe",
          });
          shared = spawned;
          stderrDrained = (async () => {
            const reader = spawned.stderr.getReader();
            const decoder = new TextDecoder();
            try {
              for (;;) {
                const chunk = await reader.read();
                if (chunk.done) break;
                nativeDiagnostics = (
                  nativeDiagnostics + decoder.decode(chunk.value, { stream: true })
                ).slice(-16_384);
              }
            } finally {
              reader.releaseLock();
            }
          })().catch((error) => {
            nativeDiagnostics += String(error);
          });
        },
      });
      if (!serving.publish) throw new Error("no weighted publisher");
      const publish = serving.publish.bind(serving);
      // This test qualifies the private runtime seam, not public Form admission.
      await publish("target", publication("target", "v1", targetUid, targetSource("v1")));
      await publish(
        "caller",
        publication("caller", "v1", "uid-ModuleWorker-caller", applicationSource, bindings),
      );
      for (const name of [
        "0050_workflow_instances.sql",
        "0051_workflow_execution.sql",
        "0052_workflow_termination_intent.sql",
      ]) {
        db.exec(await readFile(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      const prepare = createSelfhostWorkflowPreparation({
        runtimeRoot: root,
        serviceRuntime: serving,
        resolveTarget: async () => ({
          ...scope,
          script: "caller",
          workerResourceUid: "uid-ModuleWorker-caller",
          className: "Application",
        }),
      });
      host = createWorkerdWorkflowExecutionHost({
        guardBinary: guardBinary as string,
        workerdBinary: binary,
        maximumRegistrations: 1,
        async prepare(identity, input, signal, channel) {
          preparedCount += 1;
          const prepared = await prepare(identity, input, signal, channel);
          configuredRoots.push(dirname(prepared.configPath));
          return {
            ...prepared,
            run(driver) {
              return prepared.run({
                ...driver,
                async do(name, pending) {
                  const stepName = await name();
                  const result = await driver.do(() => stepName, pending);
                  if (stepName === "before") {
                    await publish("caller", null);
                    await publish(
                      "target",
                      publication("target", "v2", targetUid, targetSource("v2")),
                    );
                  } else if (stepName === "after") {
                    await publish("target", null);
                  } else if (stepName === "deleted") {
                    await publish(
                      "target",
                      publication(
                        "target",
                        "v3",
                        "uid-ModuleWorker-reused",
                        targetSource("wrong-uid"),
                      ),
                    );
                  } else if (stepName === "reused") {
                    // OFFLINE has not opened a connection: prove the guard's
                    // pre-connect refusal, not rewriting of a broken stream.
                    await stopShared();
                  }
                  return result;
                },
              });
            },
            async dispose() {
              await prepared.dispose();
              disposedCount += 1;
            },
          };
        },
      });
      let nextId = 0;
      const runtime = createWorkflowRuntime({
        sql: createSqliteSql(db),
        clock: () => new Date(),
        randomId: () => `id-${++nextId}`,
        host,
        leaseMs: 20_000,
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
            const timer = setTimeout(finish, Math.min(2_147_483_647, Math.max(0, at - Date.now())));
            signal.addEventListener("abort", finish, { once: true });
          });
        },
      });
      await runtime.instances.create(scope, { id: "instance" });
      const result = await runtime.runOne(scope, "instance");
      expect(result).toMatchObject({
        kind: "complete",
        output: {
          before: {
            echo: {
              version: "v1",
              url: "https://arbitrary.example:8443/echo?q=1",
              method: "POST",
              host: "independent.example",
              custom: "kept",
              marker: "application-value",
              body: "payload",
            },
            first: "first",
            rest: "second",
            echoed: "echo:hello",
            aborted: true,
            errorStatus: 500,
            errorBody: "application error",
            spoofStatus: 530,
            spoofBody: "application response",
            env: ["OFFLINE", "PEER"],
          },
          after: { version: "v2" },
          deleted: { name: "backend_unavailable" },
          reused: { name: "backend_unavailable" },
          offline: { name: "backend_unavailable" },
        },
      });
      expect(processStarts).toBe(1);
      expect(preparedCount).toBe(1);
      expect(disposedCount).toBe(1);
      for (const directory of configuredRoots)
        await expect(readdir(directory)).rejects.toMatchObject({ code: "ENOENT" });
      expect((await runtime.instances.status(scope, "instance")).status).toBe("complete");
    } catch (error) {
      testFailed = true;
      testFailure = error;
      if (nativeDiagnostics) console.error("native service fixture stderr:", nativeDiagnostics);
    } finally {
      for (const cleanup of [
        () => host?.close(),
        stopShared,
        () => db.close(),
        () => rm(root, { recursive: true, force: true }),
        () => rm(sockets, { recursive: true, force: true }),
      ]) {
        try {
          await cleanup();
        } catch (error) {
          cleanupFailures.push(error);
        }
      }
    }
    if (cleanupFailures.length > 0) {
      throw new AggregateError(
        testFailed ? [testFailure, ...cleanupFailures] : cleanupFailures,
        "native service fixture cleanup failed",
      );
    }
    if (testFailed) throw testFailure;
  },
  35_000,
);
