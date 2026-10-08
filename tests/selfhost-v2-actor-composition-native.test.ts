import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject } from "../src/ports.ts";
import { createSelfhostActorExecutionHost } from "../src/selfhost-actor-execution-host.ts";
import { createSelfhostV2ActorBoot } from "../src/selfhost-v2-actor-boot.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2ActorNamespaceGraphAuthority } from "../src/takoform-v2/actor-namespace-graph-authority.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { ACTOR_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/actor-namespace.ts";
import { createV2HeldArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { createWorkerBundleHost } from "../src/takoform-v2/forms/worker-bundle-backend.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { v2ServiceTargetName } from "../src/takoform-v2/worker-service-resolution.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { spawnWorkerdWithParentDeath } from "../src/workerd-linux-process.ts";
import { internalHostname } from "../src/workerd-runtime.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const binary = nativeEvidenceBinary("workerd-artifact");
const principal = "actor-composition-principal";
const space = "default";
const targetKey = "actor-composition-target";
const moduleBytes = new TextEncoder().encode(`
export default {
  fetch(request, env) {
    return env.ACTOR.get(env.ACTOR.idFromName("room")).fetch(request);
  }
};
export class CounterActor {
  constructor(context, env) { this.context = context; this.env = env; }
  async fetch(request) {
    if (new URL(request.url).pathname === "/socket")
      return (await this.context.sockets.accept(request, {protocol: "chat"})).response;
    if (new URL(request.url).pathname === "/alarm-set") {
      await this.context.alarm.set(Date.now() + 2500);
      return new Response("armed");
    }
    if (new URL(request.url).pathname === "/alarm-count") {
      const rows = await this.context.storage.query("SELECT count(*) AS n FROM retirement_alarm_runs").catch(() => ({rows:[{n:0}]}));
      return new Response(String(rows.rows[0].n));
    }
    if (new URL(request.url).pathname === "/held-nested") {
      const actor = this.env.ACTOR;
      if (!actor) return new Response("nested-binding-missing", {status: 500});
      await new Promise(resolve => setTimeout(resolve, 1500));
      try {
        const nested = await actor.get(actor.idFromName("nested")).fetch(
          new Request("http://actor.example.test/plain"),
        );
        return new Response("nested-status:" + nested.status);
      } catch {
        return new Response("nested-refused");
      }
    }
    return new Response("actor:" + this.env.LABEL);
  }
  async alarm() {
    await this.context.storage.execute("CREATE TABLE IF NOT EXISTS retirement_alarm_runs (n INTEGER)");
    await this.context.storage.execute("INSERT INTO retirement_alarm_runs VALUES (1)");
  }
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

async function exercise(
  activeUpdate: boolean,
  namespaceAfterDeployment = false,
  failedRetirement = false,
  graphChangeDuringNested = false,
): Promise<void> {
  if (!binary) throw new Error("pinned Workerd unavailable");
  const root = await mkdtemp(join(tmpdir(), "v2-actor-composition-"));
  const db = new Database(join(root, "state.sqlite"));
  let workers: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
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
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    const manifestUrl = "https://artifacts.example.test/composition/manifest.json";
    const moduleUrl = "https://artifacts.example.test/composition/actor.mjs";
    const manifest = new TextEncoder().encode(
      JSON.stringify({
        entrypoint: "actor.mjs",
        files: [
          {
            path: "actor.mjs",
            url: moduleUrl,
            sha256: sha(moduleBytes),
            mediaType: "application/javascript+module",
          },
        ],
      }),
    );
    await objects.create("actor/manifest", manifest);
    await objects.create("actor/module", moduleBytes);
    const heldArtifacts = [
      {
        url: manifestUrl,
        sha256: sha(manifest),
        objectKey: "actor/manifest",
        grants: [{ principal, space }],
      },
      {
        url: moduleUrl,
        sha256: sha(moduleBytes),
        objectKey: "actor/module",
        grants: [{ principal, space }],
      },
    ];
    const bundleHost = createWorkerBundleHost({
      sql,
      targetKey,
      source: createV2HeldArtifactSource({ objects, entries: heldArtifacts }),
    });
    const graph = createV2ActorNamespaceGraphAuthority({
      sql,
      targetKey,
      owner: {
        async ownerForWorker(uid) {
          return workers ? await workers.ownerForWorkerUid(uid) : null;
        },
      },
    });
    let graphWithdrawn = false;
    let holdNextGraphRead = false;
    let markGraphReadStarted!: () => void;
    const graphReadStarted = new Promise<void>((resolve) => {
      markGraphReadStarted = resolve;
    });
    let releaseGraphRead!: () => void;
    const graphReadGate = new Promise<void>((resolve) => {
      releaseGraphRead = resolve;
    });
    const physicalAuthority: typeof graph = {
      ...graph,
      async readGraph(identity, signal) {
        if (graphWithdrawn) {
          if (holdNextGraphRead) {
            holdNextGraphRead = false;
            markGraphReadStarted();
            await graphReadGate;
          }
          signal.throwIfAborted();
          return null;
        }
        return graph.readGraph(identity, signal);
      },
    };
    let observeNestedArrival = false;
    let markNestedArrival!: () => void;
    const nestedArrival = new Promise<void>((resolve) => {
      markNestedArrival = resolve;
    });
    const actorHost = createSelfhostActorExecutionHost({
      runtimeRoot: join(root, "actor-runtime"),
      storageRoot: join(root, "actor-storage"),
      binary: selected.binary,
      authority: physicalAuthority,
    });
    physical = actorHost;
    let listenerPort = 0;
    workers = createSelfhostV2WorkerComposition({
      sql,
      objects,
      clock,
      config: {
        cursorSigningKey: new Uint8Array(32).fill(0x52),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
        workerBundle: { targetKey, heldArtifacts },
      },
      targetKey,
      rootDirectory: join(root, "worker-owners"),
      workerdBinary: selected.binary,
      v2Actor: createSelfhostV2ActorBoot({
        sql,
        targetKey,
        namespaceGraph: graph,
        physical: {
          ...actorHost,
          fetch: (identity, request) => {
            if (observeNestedArrival && new URL(request.url).pathname === "/plain")
              markNestedArrival();
            return actorHost.fetch(identity, request);
          },
        },
        privateSocketDirectory: join(root, "actor-brokers"),
      }),
      listenerPortForOperation: async () => (listenerPort = await unusedPort()),
      spawn: (command) =>
        spawnWorkerdWithParentDeath(command, { stdout: "ignore", stderr: "ignore" }),
    });
    expect(await workers.restoreOwners()).toEqual([]);
    const forms = workers.internalFormFactory({ sql, objects, clock });
    expect(forms[ACTOR_NAMESPACE_FORM_URL]).toBeDefined();
    const engine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3600,
      leaseMilliseconds: 300_000,
      authorize: async () => true,
      forms: { ...forms, [WORKER_BUNDLE_FORM_URL]: bundleHost.form },
    });
    const create = async (form: string, name: string, spec: JsonObject) => {
      const operation = await engine.acceptCreate({
        principal,
        key: `actor-composition-${name}`,
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
    const earlyNamespace = namespaceAfterDeployment
      ? undefined
      : await create(ACTOR_NAMESPACE_FORM_URL, "namespace", namespaceSpec);
    const version = await create(WORKER_VERSION_FORM_URL, "version", {
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      vars: { LABEL: "composition" },
      ...(earlyNamespace
        ? {
            actorBindings: [
              { name: "ACTOR", resource: { resourceUid: earlyNamespace.resourceUid } },
            ],
          }
        : {}),
    });
    await create(WORKER_DEPLOYMENT_FORM_URL, "deployment", {
      worker: { resourceUid: worker.resourceUid },
      versions: [{ workerVersion: { resourceUid: version.resourceUid }, weight: 10_000 }],
    });
    const namespace =
      earlyNamespace ?? (await create(ACTOR_NAMESPACE_FORM_URL, "namespace", namespaceSpec));
    const scope = { tenantId: principal, namespaceResourceUid: namespace.resourceUid };
    expect(await physical.hasNamespace(scope)).toBe(true);
    if (namespaceAfterDeployment) {
      const rows = await sql.query("SELECT observed_json FROM tf_v2_resources WHERE uid = ?", [
        namespace.resourceUid,
      ]);
      const observed = JSON.parse(String(rows[0]?.observed_json)) as Record<string, unknown>;
      expect(observed).toMatchObject({
        ready: true,
        activeActorCount: 0,
        pendingAlarmCount: 0,
        openSocketCount: 0,
      });
      const response = await physical.fetch(
        { ...scope, id: "warm-room" },
        new Request("http://actor.example.test/plain", { signal: AbortSignal.timeout(10_000) }),
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("actor:composition");
    } else {
      const hostname = internalHostname(await v2ServiceTargetName(worker.resourceUid));
      const origin = `http://127.0.0.1:${listenerPort}`;
      const response = await fetch(`${origin}/plain`, {
        headers: { host: hostname },
        signal: AbortSignal.timeout(10_000),
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("actor:composition");
      const WebSocketWithHeaders = WebSocket as unknown as new (
        url: string,
        options: { protocols: readonly string[]; headers: Record<string, string> },
      ) => WebSocket;
      const ws = new WebSocketWithHeaders(`${origin.replace(/^http:/u, "ws:")}/socket`, {
        protocols: ["chat"],
        headers: { host: hostname },
      });
      const message = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("Actor socket timed out")), 10_000);
        ws.onopen = () => ws.send("hello");
        ws.onmessage = (event) => {
          clearTimeout(timer);
          resolve(String(event.data));
        };
        ws.onerror = (event) => {
          clearTimeout(timer);
          reject(new Error(`Actor socket failed: ${String((event as ErrorEvent).message)}`));
        };
      });
      expect(message).toBe("actor:hello");
      ws.close();
    }
    if (activeUpdate) {
      const update = await engine.acceptUpdate({
        principal,
        key: "actor-composition-same-spec-put",
        uid: namespace.resourceUid,
        expectedGeneration: 1,
        spec: namespaceSpec,
      });
      expect(await engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
      const observedRows = await sql.query(
        "SELECT observed_json FROM tf_v2_resources WHERE uid = ?",
        [namespace.resourceUid],
      );
      const observed = JSON.parse(String(observedRows[0]?.observed_json)) as Record<
        string,
        unknown
      >;
      expect(observed.ready).toBe(true);
      expect(observed.activeActorCount).toBeGreaterThanOrEqual(0);
      expect(observed.pendingAlarmCount).toBeGreaterThanOrEqual(0);
      expect(observed.openSocketCount).toBeGreaterThanOrEqual(0);
    }
    const graphNow = await graph.readGraph(scope, AbortSignal.timeout(10_000));
    expect(graphNow).not.toBeNull();
    if (!graphNow) throw new Error("Actor graph missing after native invocation");
    const readback = await graph.readRealization(graphNow, AbortSignal.timeout(10_000));
    expect(readback.kind).toBe("ready");
    if (failedRetirement) {
      if (
        readback.kind !== "ready" ||
        !readback.realization.sourceOperationId ||
        !readback.realization.incarnationId
      )
        throw new Error("Actor retirement fixture lacks an exact incarnation");
      const baselineNested = await physical.fetch(
        { ...scope, id: "retirement-baseline" },
        new Request("http://actor.example.test/held-nested"),
      );
      expect(baselineNested.status).toBe(200);
      expect(await baselineNested.text()).toBe("nested-status:200");
      const armed = await physical.fetch(
        { ...scope, id: "retirement-alarm" },
        new Request("http://actor.example.test/alarm-set"),
      );
      expect(await armed.text()).toBe("armed");
      const beforeTurn = await physical.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      expect(beforeTurn).toMatchObject({
        kind: "confirmed",
        pendingAlarmCount: 1,
      });
      if (beforeTurn.kind !== "confirmed") throw new Error("Actor observation unavailable");
      const outer = physical.fetch(
        { ...scope, id: "retirement-outer" },
        new Request("http://actor.example.test/held-nested", {
          signal: AbortSignal.timeout(10_000),
        }),
      );
      void outer.catch(() => {});
      let activeTurn = await physical.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      for (
        let attempt = 0;
        attempt < 80 &&
        (activeTurn.kind !== "confirmed" ||
          activeTurn.activeActorCount <= beforeTurn.activeActorCount);
        attempt += 1
      ) {
        await Bun.sleep(25);
        activeTurn = await physical.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      }
      expect(activeTurn.kind).toBe("confirmed");
      if (activeTurn.kind !== "confirmed") throw new Error("Actor turn never started");
      expect(activeTurn.activeActorCount).toBeGreaterThan(beforeTurn.activeActorCount);
      const retirementInput = {
        workerResourceUid: worker.resourceUid,
        targetKey,
        sourceOperationId: readback.realization.sourceOperationId,
        incarnationId: readback.realization.incarnationId,
        generation: readback.realization.graph.generation,
        versions: readback.realization.graph.versions.map((version) => ({
          versionId: version.versionId,
          workerVersionUid: version.workerVersionUid,
          weight: version.weight,
        })),
        retirementOperationId: "accepted-deletion-whose-lease-was-lost",
      };
      let authorityReads = 0;
      const retirement = physical.quiesceIncarnation(retirementInput, async () => {
        authorityReads += 1;
        return authorityReads === 1;
      });
      const retirementOutcome = retirement.then(
        () => null,
        (error: unknown) => error,
      );
      await expect(physical.quiesceIncarnation(retirementInput, async () => true)).rejects.toThrow(
        "retirement already in progress",
      );
      const outerResponse = await outer;
      expect(outerResponse.status).toBe(200);
      expect(await outerResponse.text()).toBe("nested-status:503");
      expect(String(await retirementOutcome)).toContain("retirement authority changed");
      expect(authorityReads).toBe(2);
      // No application fetch may wake the carrier after the lost withdrawal
      // proof; the retained alarm must resume from its current graph alone.
      let alarm = await physical.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      for (
        let attempt = 0;
        attempt < 200 && (alarm.kind !== "confirmed" || alarm.pendingAlarmCount !== 0);
        attempt += 1
      ) {
        await Bun.sleep(50);
        alarm = await physical.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      }
      expect(alarm).toMatchObject({ kind: "confirmed", pendingAlarmCount: 0 });
      const after = await physical.fetch(
        { ...scope, id: "retirement-outer" },
        new Request("http://actor.example.test/plain", {
          signal: AbortSignal.timeout(10_000),
        }),
      );
      expect(after.status).toBe(200);
      expect(await after.text()).toBe("actor:composition");
      let errorReads = 0;
      await expect(
        physical.quiesceIncarnation(retirementInput, async () => {
          errorReads += 1;
          if (errorReads === 2) throw new Error("SQL read unavailable");
          return true;
        }),
      ).rejects.toThrow("retirement authority changed");
      expect(errorReads).toBe(2);
      const counted = await physical.fetch(
        { ...scope, id: "retirement-alarm" },
        new Request("http://actor.example.test/alarm-count"),
      );
      expect(await counted.text()).toBe("1");
    }
    if (graphChangeDuringNested) {
      const baseline = await physical.fetch(
        { ...scope, id: "graph-change-baseline" },
        new Request("http://actor.example.test/held-nested"),
      );
      expect(baseline.status).toBe(200);
      expect(await baseline.text()).toBe("nested-status:200");
      const beforeTurn = await physical.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      expect(beforeTurn.kind).toBe("confirmed");
      if (beforeTurn.kind !== "confirmed") throw new Error("Actor observation unavailable");
      const outer = physical.fetch(
        { ...scope, id: "graph-change-outer" },
        new Request("http://actor.example.test/held-nested", {
          signal: AbortSignal.timeout(10_000),
        }),
      );
      void outer.catch(() => {});
      let activeTurn = await physical.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      for (
        let attempt = 0;
        attempt < 80 &&
        (activeTurn.kind !== "confirmed" ||
          activeTurn.activeActorCount <= beforeTurn.activeActorCount);
        attempt += 1
      ) {
        await Bun.sleep(25);
        activeTurn = await physical.observeNamespaceRuntime(scope, AbortSignal.timeout(5_000));
      }
      expect(activeTurn.kind).toBe("confirmed");
      if (activeTurn.kind !== "confirmed") throw new Error("Actor turn never started");
      expect(activeTurn.activeActorCount).toBeGreaterThan(beforeTurn.activeActorCount);
      graphWithdrawn = true;
      holdNextGraphRead = true;
      observeNestedArrival = true;
      const refresh = physical.fetch(
        { ...scope, id: "graph-change-refresh" },
        new Request("http://actor.example.test/plain", {
          signal: AbortSignal.timeout(10_000),
        }),
      );
      const refreshOutcome = refresh.then(
        () => null,
        (error: unknown) => error,
      );
      await graphReadStarted;
      await nestedArrival;
      // The inner same-Namespace call has arrived while the outer selector's
      // graph read holds the lane. Releasing the read must not start a drain
      // behind which that inner call waits for its own outer turn.
      releaseGraphRead();
      expect(String(await refreshOutcome)).toContain("Actor carrier is in use");
      const outerResponse = await outer;
      expect(outerResponse.status).toBe(200);
      graphWithdrawn = false;
      observeNestedArrival = false;
      expect(await outerResponse.text()).toBe("nested-status:503");
      const recovered = await physical.fetch(
        { ...scope, id: "graph-change-outer" },
        new Request("http://actor.example.test/plain"),
      );
      expect(recovered.status).toBe(200);
      expect(await recovered.text()).toBe("actor:composition");
    }
  } catch (error) {
    failure = error;
  }
  const cleanupErrors: unknown[] = [];
  if (workers) {
    try {
      await workers.suspendOwnersRetainingCustody();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  if (physical) {
    try {
      await physical.close();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  db.close();
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      [...(failure === undefined ? [] : [failure]), ...cleanupErrors],
      `Actor composition cleanup incomplete; retained ${root}`,
    );
  await rm(root, { recursive: true, force: true });
  if (failure !== undefined) throw failure;
}

test.skipIf(binary === undefined)(
  "normal v2 Worker factory forwards accepted native Actor fetch and upgrade",
  () => exercise(false),
  60_000,
);

test.skipIf(binary === undefined)(
  "same-spec active Actor Namespace PUT confirms native counts under its held Operation",
  () => exercise(true),
  60_000,
);

test.skipIf(binary === undefined)(
  "first active Actor Namespace CREATE warms and observes the accepted native graph",
  () => exercise(false, true),
  60_000,
);

test.skipIf(binary === undefined)(
  "Actor retirement releases its Namespace lane during a nested turn and restores the current child after a lost withdrawal claim",
  () => exercise(false, false, true),
  60_000,
);

test.skipIf(binary === undefined)(
  "graph-change selection refuses an active Actor carrier without blocking a queued nested call",
  () => exercise(false, false, false, true),
  60_000,
);
