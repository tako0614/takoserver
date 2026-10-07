import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2ActorBindingAuthority } from "../src/takoform-v2/actor-binding-authority.ts";
import { createV2ActorForwardBoot } from "../src/takoform-v2/actor-forward-runtime.ts";
import { createV2ActorNamespaceForm } from "../src/takoform-v2/actor-namespace-backend.ts";
import { createV2ActorNamespaceGraphAuthority } from "../src/takoform-v2/actor-namespace-graph-authority.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/actor-namespace.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { createWorkerCronTriggerAdmissionReader } from "../src/takoform-v2/worker-cron-trigger-backend.ts";
import { createWorkerDeploymentForm } from "../src/takoform-v2/worker-deployment-backend.ts";
import {
  createInternalV2CodeWorkerVersionForm,
  createInternalV2ModuleWorkerForm,
} from "../src/takoform-v2/worker-lifecycle-backend.ts";
import { createV2WorkerPublicationState } from "../src/takoform-v2/worker-publication-state.ts";
import { v2ServiceTargetName } from "../src/takoform-v2/worker-service-resolution.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import { internalHostname } from "../src/workerd-runtime.ts";
import { createWorkerdWorkerModuleInspector } from "../src/workerd-worker-module-inspector.ts";
import {
  openWorkerdWorkerRuntimeOwner,
  type WorkerdWorkerRuntimeOwner,
} from "../src/workerd-worker-runtime-owner.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");
const principal = "actor-native-principal";
const space = "default";
const targetKey = "actor-native-target";
const modulePath = "actor.mjs";
const moduleBytes = new TextEncoder().encode(`
export default {
  fetch(request, env) {
    const id = env.ACTOR.idFromName("room");
    return env.ACTOR.get(id).fetch(request);
  }
};
export class CounterActor {
  constructor(context, env) { this.context = context; this.env = env; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/socket")
      return (await this.context.sockets.accept(request, {protocol: "chat"})).response;
    return new Response("actor:" + this.env.LABEL);
  }
  alarm() {}
  async socketMessage(socket, data) { await socket.send("actor:" + data); }
  socketClose() {}
  socketError() {}
}
`);
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

async function unusedPort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

test.skipIf(binary === undefined)(
  "accepted v2 Actor binding reaches native stub fetch and upgrade, then rejects stale edge",
  async () => {
    if (!binary) throw new Error("pinned Workerd unavailable");
    const root = await mkdtemp(join(tmpdir(), "v2-actor-native-"));
    const db = new Database(join(root, "state.sqlite"));
    let owner: WorkerdWorkerRuntimeOwner | undefined;
    let physical: ReturnType<typeof createSelfhostActorExecutionHost> | undefined;
    let failure: unknown;
    try {
      const selected = await selectClosedGraphWorkerd({
        binary,
        privateRoot: join(root, "binary"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "pinned Workerd unavailable");
      migrateSqlite(db);
      const sql = createSqliteSql(db);
      const manifestUrl = "https://artifacts.example.test/v2-actor/manifest.json";
      const moduleUrl = "https://artifacts.example.test/v2-actor/actor.mjs";
      const manifest = new TextEncoder().encode(
        JSON.stringify({
          entrypoint: modulePath,
          files: [
            {
              path: modulePath,
              url: moduleUrl,
              sha256: sha(moduleBytes),
              mediaType: "application/javascript+module",
            },
          ],
        }),
      );
      const bundleHost = createWorkerBundleHost({
        sql,
        targetKey,
        source: {
          async read({ url }) {
            if (url === manifestUrl) return manifest;
            if (url === moduleUrl) return moduleBytes;
            throw new Error("unexpected Actor source URL");
          },
        },
      });
      const publicationState = createV2WorkerPublicationState({
        sql,
        bundleCustody: bundleHost.custody,
      });
      const inspector = createWorkerdWorkerModuleInspector({ binary: selected.binary });
      const graph = createV2ActorNamespaceGraphAuthority({
        sql,
        targetKey,
        owner: { ownerForWorker: async () => owner ?? null },
      });
      physical = createSelfhostActorExecutionHost({
        runtimeRoot: join(root, "actor-runtime"),
        storageRoot: join(root, "actor-storage"),
        binary: selected.binary,
        authority: graph,
      });
      const actorAuthority = createV2ActorBindingAuthority({
        sql,
        targetKey,
        namespaceGraph: graph,
        physical,
      });
      const actorBoot = createV2ActorForwardBoot({
        sql,
        targetKey,
        authority: actorAuthority,
        physical,
        privateSocketDirectory: join(root, "brokers"),
      });
      const retirement = {
        observeRetired: async () => ({ kind: "unknown" as const }),
      };
      const engine = createTakoformV2Engine({
        sql,
        replayWindowSeconds: 3600,
        leaseMilliseconds: 300_000,
        authorize: async () => true,
        forms: {
          [MODULE_WORKER_FORM_URL]: createInternalV2ModuleWorkerForm({
            sql,
            targetKey,
            retirement,
            serving: {
              observeServing: async (input) =>
                owner?.observeServing(input) ?? { kind: "unknown" as const },
            },
          }),
          [WORKER_BUNDLE_FORM_URL]: bundleHost.form,
          [ACTOR_NAMESPACE_FORM_URL]: createV2ActorNamespaceForm({
            sql,
            targetKey,
            bundleCustody: bundleHost.custody,
            inspector,
            physical,
          }),
          [WORKER_VERSION_FORM_URL]: createInternalV2CodeWorkerVersionForm({
            sql,
            targetKey,
            publicationState,
            retirement,
            inspectModule: inspector.inspect,
            v2ActorBinding: actorAuthority,
          }),
          [WORKER_DEPLOYMENT_FORM_URL]: createWorkerDeploymentForm({
            targetKey,
            publicationState,
            ownerForWorker: async () => {
              if (!owner) throw new Error("native Actor owner not open");
              return owner;
            },
            scheduledAttachments: createWorkerCronTriggerAdmissionReader({ sql }),
          }),
        },
      });
      const create = async (form: string, name: string, spec: JsonObject) => {
        const operation = await engine.acceptCreate({
          principal,
          key: `actor-native-${name}`,
          input: { form, space, name, spec },
        });
        expect(await engine.runNext()).toMatchObject({ id: operation.id, status: "succeeded" });
        return operation;
      };
      const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
      const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {
        artifact: { url: manifestUrl, sha256: sha(manifest) },
      });
      const namespaceSpec = {
        worker: { resourceUid: worker.resourceUid },
        className: "CounterActor",
      };
      const namespace = await create(ACTOR_NAMESPACE_FORM_URL, "namespace", namespaceSpec);
      const versionSpec = {
        worker: { resourceUid: worker.resourceUid },
        bundle: { resourceUid: bundle.resourceUid },
        handlers: ["fetch"],
        vars: { LABEL: "v2" },
        actorBindings: [{ name: "ACTOR", resource: { resourceUid: namespace.resourceUid } }],
      };
      const version = await create(WORKER_VERSION_FORM_URL, "version", versionSpec);
      const targetClaim = {
        principal,
        space,
        targetKey,
        workerUid: worker.resourceUid,
        namespaceResourceUid: namespace.resourceUid,
      };
      const beforeNamespaceUpdate = await actorAuthority.resolveTarget(targetClaim);
      expect(beforeNamespaceUpdate).not.toBeNull();
      const updateNamespace = await engine.acceptUpdate({
        principal,
        key: "actor-native-namespace-same-spec-update",
        uid: namespace.resourceUid,
        expectedGeneration: 1,
        spec: namespaceSpec,
      });
      expect(await actorAuthority.resolveTarget(targetClaim)).toBeNull();
      expect(await engine.runNext()).toMatchObject({ id: updateNamespace.id, status: "succeeded" });
      const afterNamespaceUpdate = await actorAuthority.resolveTarget(targetClaim);
      expect(afterNamespaceUpdate?.vector).toBe(beforeNamespaceUpdate?.vector);
      let listenerPort = 0;
      const openOwner = () =>
        openWorkerdWorkerRuntimeOwner({
          rootDirectory: join(root, "owner"),
          workerResourceUid: worker.resourceUid,
          targetKey,
          publicationState,
          workerdBinary: selected.binary,
          inspectModule: inspector.inspect,
          listenerPortForOperation: async () => (listenerPort = await unusedPort()),
          spawn: (command) =>
            spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" }),
          v2ActorForward: {
            openIncarnation(source) {
              return actorBoot.openIncarnation({ principal, space, ...source });
            },
          },
        });
      owner = await openOwner();
      await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
        worker: { resourceUid: worker.resourceUid },
        versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
      });
      const scope = { tenantId: principal, namespaceResourceUid: namespace.resourceUid };
      const acceptedGraph = await graph.readGraph(scope, AbortSignal.timeout(10_000));
      expect(acceptedGraph).not.toBeNull();
      if (!acceptedGraph) throw new Error("accepted Actor graph unavailable");
      expect(await graph.hasRealization(acceptedGraph)).toBe(true);
      expect((await graph.readRealization(acceptedGraph, AbortSignal.timeout(10_000))).kind).toBe(
        "ready",
      );
      expect(await physical.hasNamespace(scope)).toBe(true);
      const direct = await physical.fetch(
        { ...scope, id: "direct-test-id" },
        new Request("http://actor.invalid/plain"),
      );
      expect(await direct.text()).toBe("actor:v2");
      expect(listenerPort).toBeGreaterThan(0);
      const hostname = internalHostname(await v2ServiceTargetName(worker.resourceUid));
      const origin = `http://127.0.0.1:${listenerPort}`;
      const response = await fetch(`${origin}/plain`, {
        headers: { host: hostname },
        signal: AbortSignal.timeout(10_000),
      });
      if (response.status !== 200)
        throw new Error(`Actor native fetch ${response.status}: ${await response.text()}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("actor:v2");
      const updateVersion = await engine.acceptUpdate({
        principal,
        key: "actor-native-version-same-spec-update",
        uid: version.resourceUid,
        expectedGeneration: 1,
        spec: versionSpec,
      });
      const duringVersionUpdate = await fetch(`${origin}/plain`, {
        headers: { host: hostname },
        signal: AbortSignal.timeout(10_000),
      });
      expect(duringVersionUpdate.status).not.toBe(200);
      expect(await engine.runNext()).toMatchObject({ id: updateVersion.id, status: "succeeded" });
      const afterVersionUpdate = await fetch(`${origin}/plain`, {
        headers: { host: hostname },
        signal: AbortSignal.timeout(10_000),
      });
      expect(afterVersionUpdate.status).toBe(200);
      expect(await afterVersionUpdate.text()).toBe("actor:v2");
      await owner.suspend();
      owner = await openOwner();
      const afterRecoveredVersion = await fetch(`${origin}/plain`, {
        headers: { host: hostname },
        signal: AbortSignal.timeout(10_000),
      });
      expect(afterRecoveredVersion.status).toBe(200);
      expect(await afterRecoveredVersion.text()).toBe("actor:v2");
      const WebSocketWithHeaders = WebSocket as unknown as new (
        url: string,
        options: { protocols: readonly string[]; headers: Record<string, string> },
      ) => WebSocket;
      const ws = new WebSocketWithHeaders(`${origin.replace(/^http:/u, "ws:")}/socket`, {
        protocols: ["chat"],
        headers: { host: hostname },
      });
      const message = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("v2 Actor socket timed out")), 10_000);
        ws.onopen = () => ws.send("hello");
        ws.onmessage = (event) => {
          clearTimeout(timer);
          resolve(String(event.data));
        };
        ws.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(`v2 Actor socket failed: ${String((event as ErrorEvent).message)}`));
        };
      });
      expect(message).toBe("actor:hello");
      ws.close();
      await sql.run(
        "DELETE FROM tf_v2_resource_references WHERE referrer_uid = ? AND target_uid = ?",
        [version.resourceUid, namespace.resourceUid],
      );
      const stale = await fetch(`${origin}/plain`, {
        headers: { host: hostname },
        signal: AbortSignal.timeout(10_000),
      });
      expect(stale.status).not.toBe(200);
    } catch (error) {
      failure = error;
    }
    const shutdown: unknown[] = [];
    if (owner) {
      try {
        await owner.suspend();
      } catch (error) {
        shutdown.push(error);
      }
    }
    if (physical) {
      try {
        await physical.close();
      } catch (error) {
        shutdown.push(error);
      }
    }
    db.close();
    if (shutdown.length > 0)
      throw new AggregateError(
        [...(failure === undefined ? [] : [failure]), ...shutdown],
        `Actor native shutdown incomplete; retained ${root}`,
      );
    await rm(root, { recursive: true, force: true });
    if (failure !== undefined) throw failure;
  },
  60_000,
);
