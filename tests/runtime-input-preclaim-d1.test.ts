import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createRuntimeInputAuthority } from "../src/runtime-input-preparations.ts";
import { createD1Sql } from "../src/sql-d1.ts";

const ORG = "org-d1-preclaim";
const OPERATION_KEY = `takoform-worker-runtime-v1-${"d".repeat(64)}`;
const OPERATION_ID = "op-version-d1";
const VERSION_UID = "version-d1-uid";
const WORKER_UID = "worker-d1-uid";
const HOST_ORIGIN = "https://api.takoserver.test";
const NOW = new Date("2026-09-27T00:00:00Z");
const PATH = "/apis/forms.takoform.com/v1/spaces/default/resources/WorkerVersion/d1";
const BODY = '{"apiVersion":"edge.forms.takoform.com","kind":"WorkerVersion"}';
const target = {
  space: "default",
  workerName: "worker-d1",
  workerResourceUid: WORKER_UID,
  bundleName: "bundle-d1",
};

test("native D1 serializes preclaim closure against a same-key runtime-input claim", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "runtime-input-preclaim-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "runtime-input-preclaim-d1" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS) {
      for (const statement of splitMigration(migration.sql)) {
        await database.prepare(statement).run();
      }
    }
    const sql = createD1Sql(database);
    await seedWorker(sql);
    await sql.run(
      "CREATE TABLE private_preclaim (operation_id TEXT PRIMARY KEY, state TEXT NOT NULL)",
    );
    await sql.run("INSERT INTO private_preclaim (operation_id, state) VALUES (?, 'preclaim')", [
      OPERATION_ID,
    ]);
    const key = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    const authority = createRuntimeInputAuthority({
      sql,
      sealKeys: { current: { keyId: "test-key", key } },
      canonicalPublicOrigin: HOST_ORIGIN,
      clock: () => NOW,
    });
    const input = {
      organizationId: ORG,
      operationId: OPERATION_ID,
      resourceUid: VERSION_UID,
      reference: OPERATION_KEY,
      target,
      bindingNames: ["SECRET_VALUE"],
      publicApply: { method: "PUT", path: PATH, ifNoneMatch: "*", body: BODY },
    };
    await authority.preparations.prepare({
      organizationId: ORG,
      operationKey: OPERATION_KEY,
      canonicalPublicOrigin: HOST_ORIGIN,
      publicApply: { method: "PUT", path: PATH, fences: { ifNoneMatch: "*" }, body: BODY },
      bindings: { SECRET_VALUE: "never-log-this-value" },
    });
    const pin = authority.leases.pinPrepared;
    const noEffectRevocation = authority.leases.noEffectRevocation;
    if (!pin || !noEffectRevocation) throw new Error("preclaim fence is unavailable");
    const { generation } = await pin(input);
    const guarded = {
      ...input,
      expectedGeneration: generation,
      leaseFence: {
        claim: {
          sql: "EXISTS (SELECT 1 FROM private_preclaim WHERE operation_id = ? AND state = 'preclaim')",
          params: [OPERATION_ID],
        },
        dispatch: {
          sql: "EXISTS (SELECT 1 FROM private_preclaim WHERE operation_id = ? AND state = 'pending')",
          params: [OPERATION_ID],
        },
      },
    };
    const lease = await authority.leases.acquire(guarded);
    const revoke = await noEffectRevocation({ ...input, generation });
    const outcome = await sql.batch([
      {
        sql: `UPDATE private_preclaim SET state = 'closed'
              WHERE operation_id = ? AND state = 'preclaim'
                AND EXISTS (SELECT 1 FROM worker_runtime_input_preparations
                            WHERE organization_id = ? AND operation_key = ? AND seal_nonce = ?
                              AND state = 'claimed' AND claim_owner = ?
                              AND claimed_resource_uid = ?)`,
        params: [OPERATION_ID, ORG, OPERATION_KEY, generation, OPERATION_ID, VERSION_UID],
      },
      revoke,
    ]);
    expect(outcome.map((result) => result.changes)).toEqual([1, 1]);
    await expect(lease.dispatch(guarded.leaseFence.dispatch)).rejects.toMatchObject({
      code: "conflict",
    });
    await authority.preparations.prepare({
      organizationId: ORG,
      operationKey: OPERATION_KEY,
      canonicalPublicOrigin: HOST_ORIGIN,
      publicApply: { method: "PUT", path: PATH, fences: { ifNoneMatch: "*" }, body: BODY },
      bindings: { SECRET_VALUE: "a-new-value" },
    });
    await expect(authority.leases.acquire(guarded)).rejects.toMatchObject({ code: "conflict" });
    await expect(
      authority.leases.acquire({ ...input, leaseFence: guarded.leaseFence }),
    ).rejects.toMatchObject({
      code: "conflict",
    });
    expect((await sql.query("SELECT state FROM worker_runtime_input_preparations"))[0]?.state).toBe(
      "prepared",
    );
  } finally {
    await runtime.dispose();
  }
}, 30_000);

async function seedWorker(sql: ReturnType<typeof createD1Sql>): Promise<void> {
  const now = NOW.getTime();
  await sql.run(
    `INSERT INTO tf_resources
       (tenant_id, space, api_version, kind, name, uid, generation, revision,
        resource_json, updated_at)
     VALUES (?, 'default', 'edge.forms.takoform.com', 'ModuleWorker', 'worker-d1', ?,
             '1', '1', '{}', ?)`,
    [ORG, WORKER_UID, now],
  );
  await sql.run(
    `INSERT INTO tf_resource_deployments
       (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
        provider_installation_ref, native_id, native_claimed, state,
        observed_json, outputs_json, created_at, updated_at)
     VALUES (?, 'deployment-worker-d1', ?, 'worker.module.test', 'fake', 'fake.primary',
             'worker:native-d1', 0, 'active', '{}', '{}', ?, ?)`,
    [ORG, WORKER_UID, now, now],
  );
  await sql.run(
    `INSERT INTO tf_resource_deletion_attestations
       (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
        state, closure_fence, effects_json, evidence_json, evidence_ref,
        evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at)
     VALUES (?, ?, 'default', 'edge.forms.takoform.com', 'ModuleWorker', 'worker-d1', '{}',
             'live', 1, '[]', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
    [ORG, WORKER_UID, now, now],
  );
}

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
