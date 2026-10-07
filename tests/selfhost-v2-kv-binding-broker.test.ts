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
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { EDGE_KV_NAMESPACE_BACKEND_ID } from "../src/takoform-v2/forms/edge-kv-namespace-backend.ts";
import { createKvWorkerBindingAuthority } from "../src/takoform-v2/forms/kv-worker-binding-authority.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";

const TARGET = "kv-binding-target";
const BUNDLE_FORM = "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/";

test("private KV binding broker exposes only the current sealed namespace binding", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-kv-binding-"));
  const control = new Database(join(root, "control.sqlite"));
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
    const namespaceIdentity = {
      targetKey: TARGET,
      principal: "alice",
      space: "default",
      resourceUid: "kv-one",
    };
    expect(await store.create({ identity: namespaceIdentity, operationId: "op-kv-create" })).toBe(
      "ready",
    );
    settleTarget(control, {
      uid: "worker-one",
      form: MODULE_WORKER_FORM_URL,
      name: "worker",
      backend: "worker-backend",
    });
    settleTarget(control, {
      uid: "bundle-one",
      form: BUNDLE_FORM,
      name: "bundle",
      backend: "worker-backend",
    });
    settleTarget(control, {
      uid: "kv-one",
      form: EDGE_KV_NAMESPACE_FORM_URL,
      name: "kv",
      backend: EDGE_KV_NAMESPACE_BACKEND_ID,
      observed: JSON.stringify({
        namespaceExists: true,
        maxKeyBytes: 467,
        maxValueBytes: 26_214_400,
        maxMetadataBytes: 1_024,
        consistency: "eventual",
      }),
    });

    const versionSpec = JSON.stringify({
      worker: { resourceUid: "worker-one" },
      bundle: { resourceUid: "bundle-one" },
      handlers: ["fetch"],
      kvBindings: [{ name: "CACHE", resource: { resourceUid: "kv-one" } }],
    });
    seedVersion(control, versionSpec);
    const nativeVersionId = `v2-${(await bytesDigest(new TextEncoder().encode("version-one\u00001"))).slice("sha256:".length)}`;
    const grant = {
      principal: "alice",
      space: "default",
      targetKey: TARGET,
      workerUid: "worker-one",
      workerVersionUid: "version-one",
      workerVersionOperationId: "op-version-one",
      nativeVersionId,
      incarnationId: "incarnation-one",
      servingSourceOperationId: "source-operation-one",
      bindings: [{ name: "CACHE", resourceUid: "kv-one" }],
    };
    let nativeCurrent = true;
    const authority = createKvWorkerBindingAuthority({ sql, targetKey: TARGET });
    const broker = createSelfhostV2KvBindingBroker({
      store,
      targetKey: TARGET,
      signingKey: new Uint8Array(32).fill(9),
      resolveCurrentBinding: authority.resolveCurrentBinding,
      async observeVersionTarget(input) {
        return nativeCurrent
          ? { kind: "confirmed" as const, ...input, status: "active" as const }
          : { kind: "unknown" as const };
      },
    });
    const token = broker.issueGrant(grant);
    const call = async (
      op: string,
      fields: Record<string, unknown> = {},
      binding = "CACHE",
      bearer = token,
    ) => {
      const response = await broker.handle(
        new Request(`http://localhost${SELFHOST_DATA_PLANE_KV_PATH}`, {
          method: "POST",
          headers: { authorization: `Bearer ${bearer}` },
          body: JSON.stringify({ protocol: SELFHOST_DATA_PLANE_PROTOCOL, binding, op, ...fields }),
        }),
      );
      if (!response) throw new Error("KV broker did not claim its private path");
      return await response.json();
    };

    expect(await call("put", { key: "binary", value: "AP8=" })).toEqual({ ok: true, value: {} });
    expect(await call("get", { key: "binary" })).toEqual({
      ok: true,
      value: { found: true, value: "AP8=" },
    });
    expect(
      await call("put", {
        key: "metadata",
        value: "AQ==",
        metadata: { content: "sample" },
      }),
    ).toEqual({ ok: true, value: {} });
    expect(await call("getWithMetadata", { key: "metadata" })).toEqual({
      ok: true,
      value: { found: true, value: "AQ==", metadata: { content: "sample" } },
    });

    expect(await call("get", { key: "binary" }, "OTHER")).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    expect(await call("get", { key: "binary", extra: true })).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    const staleBindingToken = broker.issueGrant({
      ...grant,
      bindings: [{ name: "CACHE", resourceUid: "kv-not-current" }],
    });
    expect(await call("get", { key: "binary" }, "CACHE", staleBindingToken)).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    nativeCurrent = false;
    expect(await call("put", { key: "blocked", value: "AQ==" })).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    expect(await sql.query("SELECT key FROM selfhost_kv_entries WHERE key = 'blocked'")).toEqual(
      [],
    );
  } finally {
    control.close();
    rmSync(root, { recursive: true, force: true });
  }
});

function settleTarget(
  db: Database,
  input: { uid: string; form: string; name: string; backend: string; observed?: string },
): void {
  const operationId = `op-${input.uid}`;
  const observed = input.observed ?? '{"ready":true}';
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
    observed,
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

function seedVersion(db: Database, spec: string): void {
  db.prepare(`INSERT INTO tf_v2_resources
    (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
     observed_generation,phase,spec_json,observed_json,output_json,last_operation,busy_operation)
    VALUES ('version-one','alice',?,'default','version','worker-backend',?,'version',1,0,
      'pending',?,'{}','{}','op-version-one','op-version-one')`).run(
    WORKER_VERSION_FORM_URL,
    TARGET,
    spec,
  );
  db.prepare(`INSERT INTO tf_v2_operations
    (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,status,effect,
     created_at,updated_at,retain_until,backend_id,target_key,backend_key,accepted_spec_json)
    VALUES ('op-version-one','version-one','alice','replay-version','fp','create',1,'queued','none',
      '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',
      'worker-backend',?,'key-version',?)`).run(TARGET, spec);
  db.exec(
    "INSERT INTO tf_v2_operation_reference_sets (operation_id,sealed) VALUES ('op-version-one',0)",
  );
  for (const [uid, form] of [
    ["worker-one", MODULE_WORKER_FORM_URL],
    ["bundle-one", BUNDLE_FORM],
    ["kv-one", EDGE_KV_NAMESPACE_FORM_URL],
  ] as const) {
    db.prepare(
      "INSERT INTO tf_v2_operation_references (operation_id,target_uid,form_url,readiness) VALUES ('op-version-one',?,?,'observed')",
    ).run(uid, form);
  }
  db.exec("UPDATE tf_v2_operation_reference_sets SET sealed=1 WHERE operation_id='op-version-one'");
  db.exec("UPDATE tf_v2_operations SET status='running' WHERE id='op-version-one'");
  db.exec(
    "UPDATE tf_v2_operations SET status='reconciling',effect='unknown' WHERE id='op-version-one'",
  );
  db.exec(`UPDATE tf_v2_operations SET status='succeeded',effect='complete',result_observed_json='{"ready":true}'
    WHERE id='op-version-one'`);
  db.exec(`UPDATE tf_v2_resources SET phase='idle',observed_generation=1,
    observed_json='{"ready":true}',busy_operation=NULL WHERE uid='version-one'`);
}
