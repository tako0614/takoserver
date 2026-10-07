import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { createSelfhostV2KvBindingBroker } from "../src/providers/selfhost-v2-kv-binding-broker.ts";
import { createSelfhostV2KvStore } from "../src/providers/selfhost-v2-kv-store.ts";
import {
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_PROTOCOL,
} from "../src/providers/selfhost-worker-wrapper.ts";
import {
  runSelfhostKvOperation,
  selfhostKvOperationErrorCode,
} from "../src/selfhost-data-planes.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  EDGE_KV_NAMESPACE_FORM_URL,
  EDGE_KV_NAMESPACE_LIMITS,
} from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { EDGE_KV_NAMESPACE_BACKEND_ID } from "../src/takoform-v2/forms/edge-kv-namespace-backend.ts";
import { createKvWorkerBindingAuthority } from "../src/takoform-v2/forms/kv-worker-binding-authority.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { compileWorkerdVersionGraph } from "../src/workerd-version-graph.ts";
import { nativeEvidenceBinary } from "./helpers/native-evidence.ts";

const TARGET = "kv-native-binding-target";
const BUNDLE_FORM = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";
const WORKERD = nativeEvidenceBinary("workerd-artifact");
const MAX_VALUE_BYTES = EDGE_KV_NAMESPACE_LIMITS.maxValueBytes;

test.skipIf(WORKERD === undefined)(
  "native Worker KV facade round-trips the full 25 MiB value through the exact v2 broker",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "v2-kv-native-binding-"));
    const control = new Database(join(root, "control.sqlite"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let plane: ReturnType<typeof Bun.serve> | undefined;
    try {
      control.exec("PRAGMA foreign_keys = ON");
      for (const name of [
        "0038_selfhost_edge_kv.sql",
        "0070_takoform_v2.sql",
        "0071_v2_sqlite_migration_set_custody.sql",
        "0073_v2_reference_acceptance.sql",
        "0081_v2_private_inputs.sql",
      ]) {
        control.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
      }
      const sql = createSqliteSql(control);
      const store = createSelfhostV2KvStore({
        root: join(root, "native"),
        sql,
        runOperation: runSelfhostKvOperation,
        operationErrorCode: selfhostKvOperationErrorCode,
      });
      const identity = {
        targetKey: TARGET,
        principal: "alice",
        space: "default",
        resourceUid: "kv-native-one",
      };
      expect(await store.create({ identity, operationId: "op-kv-native-create" })).toBe("ready");

      settleTarget(control, {
        uid: "worker-native-one",
        form: MODULE_WORKER_FORM_URL,
        name: "worker",
        backend: "worker-backend",
      });
      settleTarget(control, {
        uid: "bundle-native-one",
        form: BUNDLE_FORM,
        name: "bundle",
        backend: "worker-backend",
      });
      settleTarget(control, {
        uid: identity.resourceUid,
        form: EDGE_KV_NAMESPACE_FORM_URL,
        name: "cache",
        backend: EDGE_KV_NAMESPACE_BACKEND_ID,
        observed: JSON.stringify({
          namespaceExists: true,
          maxKeyBytes: EDGE_KV_NAMESPACE_LIMITS.maxKeyBytes,
          maxValueBytes: EDGE_KV_NAMESPACE_LIMITS.maxValueBytes,
          maxMetadataBytes: EDGE_KV_NAMESPACE_LIMITS.maxMetadataBytes,
          consistency: EDGE_KV_NAMESPACE_LIMITS.consistency,
        }),
      });

      const versionSpec = JSON.stringify({
        worker: { resourceUid: "worker-native-one" },
        bundle: { resourceUid: "bundle-native-one" },
        handlers: ["fetch"],
        kvBindings: [{ name: "CACHE", resource: { resourceUid: identity.resourceUid } }],
      });
      seedVersion(control, versionSpec, [
        ["worker-native-one", MODULE_WORKER_FORM_URL],
        ["bundle-native-one", BUNDLE_FORM],
        [identity.resourceUid, EDGE_KV_NAMESPACE_FORM_URL],
      ]);
      const nativeVersionId = `v2-${(
        await bytesDigest(new TextEncoder().encode("version-native-one\u00001"))
      ).slice("sha256:".length)}`;
      const grant = {
        principal: "alice",
        space: "default",
        targetKey: TARGET,
        workerUid: "worker-native-one",
        workerVersionUid: "version-native-one",
        workerVersionOperationId: "op-version-native-one",
        nativeVersionId,
        incarnationId: "native-incarnation-one",
        servingSourceOperationId: "source-operation-native-one",
        bindings: [{ name: "CACHE", resourceUid: identity.resourceUid }],
      };
      let nativeCurrent = true;
      const authority = createKvWorkerBindingAuthority({ sql, targetKey: TARGET });
      const broker = createSelfhostV2KvBindingBroker({
        store,
        targetKey: TARGET,
        signingKey: new Uint8Array(32).fill(11),
        resolveCurrentBinding: authority.resolveCurrentBinding,
        async observeVersionTarget(input) {
          return nativeCurrent
            ? { kind: "confirmed" as const, ...input, status: "active" as const }
            : { kind: "unknown" as const };
        },
      });
      const token = broker.issueGrant(grant);
      plane = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          return broker
            .handle(request)
            .then((response) => response ?? new Response(null, { status: 404 }));
        },
      });

      const artifact = await selectClosedGraphWorkerd({
        binary: WORKERD as string,
        privateRoot: join(root, "artifact"),
      });
      if (!artifact.binary) throw new Error(artifact.diagnostic ?? "pinned workerd unavailable");
      const portProbe = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      });
      const workerdPort = Number(portProbe.port);
      portProbe.stop(true);
      const modules = new Map([
        [
          "app.js",
          new TextEncoder().encode(`export default { async fetch(request, env) {
  const path = new URL(request.url).pathname;
  const cache = env.CACHE;
  if (path === "/large") {
    let stage = "put";
    try {
      const value = new Uint8Array(${MAX_VALUE_BYTES});
      value[0] = 0;
      value[1] = 255;
      value[value.length - 1] = 37;
      await cache.put("full-size", value);
      stage = "get";
      const answer = await cache.get("full-size");
      const bytes = new Uint8Array(answer);
      return Response.json({
        keys: Reflect.ownKeys(env).sort(),
        length: bytes.byteLength,
        first: [bytes[0], bytes[1]],
        last: bytes[bytes.length - 1],
        unknownMethod: typeof cache.erase,
        privateVisible: Object.keys(env).some((key) => key.includes("PRIVATE")),
      });
    } catch (error) {
      return Response.json({ name: error.name, stage }, { status: 500 });
    }
  }
  if (path === "/stale") {
    try { await cache.get("full-size"); return Response.json({ accepted: true }); }
    catch (error) { return Response.json({ name: error.name }); }
  }
  return new Response("not found", { status: 404 });
} }`),
        ],
      ]);
      const graph = compileWorkerdVersionGraph({
        directory: "v2-kv-native",
        mainModule: "app.js",
        modules,
        moduleMediaTypes: { "app.js": "application/javascript+module" },
        hostnames: [],
        generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
        workerResourceUid: "worker-native-one",
        declaredHandlers: ["fetch"],
        readiness: { publication: "v2-kv-native", probeHostname: "kv.localhost" },
        environment: [],
        serviceBindings: [],
        dataPlane: {
          address: `127.0.0.1:${plane.port}`,
          token,
          bindings: [{ kind: "edge.kv@1.0.0", publicName: "CACHE" }],
        },
      });
      const runtime = createWorkerdRuntime({
        root,
        binary: artifact.binary,
        port: workerdPort,
        isReady: () => true,
      });
      if (!runtime.publish) throw new Error("workerd weighted publication unavailable");
      await runtime.publish("v2-kv-native", {
        generation: "takoserver-v2-operation:11111111-1111-4111-8111-111111111111",
        workerResourceUid: "worker-native-one",
        hostnames: ["kv.localhost"],
        versions: [
          {
            versionId: nativeVersionId,
            workerVersionUid: "version-native-one",
            weight: 10_000,
            ...graph,
          },
        ],
      });
      child = Bun.spawn([artifact.binary, "serve", join(root, "workers", "workerd.capnp")], {
        stdout: "ignore",
        stderr: "pipe",
      });
      const origin = `http://127.0.0.1:${workerdPort}`;
      let ready = false;
      for (let attempt = 0; attempt < 80; attempt += 1) {
        try {
          await fetch(origin, {
            headers: { host: "kv.localhost" },
            signal: AbortSignal.timeout(250),
          });
          ready = true;
          break;
        } catch {
          await Bun.sleep(50);
        }
      }
      expect(ready).toBe(true);
      async function call(path: string) {
        const response = await fetch(`${origin}${path}`, {
          headers: { host: "kv.localhost" },
        });
        return { status: response.status, value: await response.json() };
      }
      expect(await call("/large")).toEqual({
        status: 200,
        value: {
          keys: ["CACHE"],
          length: MAX_VALUE_BYTES,
          first: [0, 255],
          last: 37,
          unknownMethod: "undefined",
          privateVisible: false,
        },
      });

      const malformed = await broker.handle(
        new Request(`http://localhost${SELFHOST_DATA_PLANE_KV_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: JSON.stringify({
            protocol: SELFHOST_DATA_PLANE_PROTOCOL,
            binding: "CACHE",
            op: "unknown-operation",
          }),
        }),
      );
      expect(malformed && (await malformed.json())).toEqual({
        ok: false,
        error: { code: "backend_unavailable" },
      });
      const wrongMethod = await broker.handle(
        new Request(`http://localhost${SELFHOST_DATA_PLANE_KV_PATH}`, {
          method: "GET",
          headers: { authorization: `Bearer ${token}` },
        }),
      );
      if (!wrongMethod) throw new Error("KV broker did not claim the private path");
      expect(wrongMethod.status).toBe(405);
      expect(await wrongMethod.json()).toEqual({
        ok: false,
        error: { code: "backend_unavailable" },
      });
      const invalidBody = await broker.handle(
        new Request(`http://localhost${SELFHOST_DATA_PLANE_KV_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${token}` },
          body: "not-json",
        }),
      );
      expect(invalidBody && (await invalidBody.json())).toEqual({
        ok: false,
        error: { code: "backend_unavailable" },
      });

      control
        .prepare("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?")
        .run("{}", identity.resourceUid);
      expect(await call("/stale")).toEqual({ status: 200, value: { name: "backend_unavailable" } });
      control.prepare("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?").run(
        JSON.stringify({
          namespaceExists: true,
          maxKeyBytes: EDGE_KV_NAMESPACE_LIMITS.maxKeyBytes,
          maxValueBytes: EDGE_KV_NAMESPACE_LIMITS.maxValueBytes,
          maxMetadataBytes: EDGE_KV_NAMESPACE_LIMITS.maxMetadataBytes,
          consistency: EDGE_KV_NAMESPACE_LIMITS.consistency,
        }),
        identity.resourceUid,
      );
      nativeCurrent = false;
      expect(await call("/stale")).toEqual({ status: 200, value: { name: "backend_unavailable" } });
    } finally {
      if (child) {
        child.kill();
        await child.exited;
      }
      plane?.stop(true);
      control.close();
      rmSync(root, { recursive: true, force: true });
    }
  },
  30_000,
);

function settleTarget(
  db: Database,
  input: { uid: string; form: string; name: string; backend: string; observed?: string },
): void {
  const operationId = `op-${input.uid}`;
  db.prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,observed_json,output_json,last_operation)
    VALUES (?,'alice',?,'default',?,?,?, ?,1,1,'idle','{}',?,'{}',?)`).run(
    input.uid,
    input.form,
    input.name,
    input.backend,
    TARGET,
    input.name,
    input.observed ?? '{"ready":true}',
    operationId,
  );
  db.prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES (?,?,'alice',?,'fp','create',1,'succeeded','complete',
      '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',?, ?,?,'{}')`).run(
    operationId,
    input.uid,
    `replay-${input.uid}`,
    input.backend,
    TARGET,
    `key-${input.uid}`,
  );
}

function seedVersion(db: Database, spec: string, references: readonly [string, string][]): void {
  db.prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,observed_json,output_json,last_operation,busy_operation)
    VALUES ('version-native-one','alice',?,'default','version','worker-backend',?,'version',1,0,
      'pending',?,'{}','{}','op-version-native-one','op-version-native-one')`).run(
    WORKER_VERSION_FORM_URL,
    TARGET,
    spec,
  );
  db.prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES ('op-version-native-one','version-native-one','alice','replay-version-native','fp',
      'create',1,'queued','none','2026-10-07T00:00:00Z','2026-10-07T00:00:00Z',
      '2026-10-08T00:00:00Z','worker-backend',?,'key-version-native',?)`).run(TARGET, spec);
  db.exec(
    "INSERT INTO tf_v2_operation_reference_sets (operation_id,sealed) VALUES ('op-version-native-one',0)",
  );
  for (const [uid, form] of references) {
    db.prepare(
      "INSERT INTO tf_v2_operation_references (operation_id,target_uid,form_url,readiness) VALUES ('op-version-native-one',?,?,'observed')",
    ).run(uid, form);
  }
  db.exec(
    "UPDATE tf_v2_operation_reference_sets SET sealed=1 WHERE operation_id='op-version-native-one'",
  );
  db.exec("UPDATE tf_v2_operations SET status='running' WHERE id='op-version-native-one'");
  db.exec(
    "UPDATE tf_v2_operations SET status='reconciling',effect='unknown' WHERE id='op-version-native-one'",
  );
  db.exec(`UPDATE tf_v2_operations SET status='succeeded',effect='complete',
    result_observed_json='{"ready":true}' WHERE id='op-version-native-one'`);
  db.exec(`UPDATE tf_v2_resources SET phase='idle',observed_generation=1,
    observed_json='{"ready":true,"resolvedBindings":true,"bundleVerified":true}',
    busy_operation=NULL WHERE uid='version-native-one'`);
}
