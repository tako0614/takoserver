import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2WorkerInvocationLifecycle } from "../src/takoform-v2/worker-invocation-custody.ts";
import {
  inspectV2WorkerInvocationDrainSchema,
  inspectV2WorkerInvocationSchema,
  v2WorkerInvocationSchemaReady,
} from "../src/takoform-v2/worker-invocation-schema.ts";

const handle = { invocationId: "invocation-001", custodyToken: "private-custody-token-001" };
const digest = `sha256:${"a".repeat(64)}` as const;
const terminalReceipt = `sha256:${"b".repeat(64)}` as const;
const retirementIdentity = {
  backendId: "backend-one",
  targetKey: "target-one",
  principal: "org-1",
  space: "prod",
  workerUid: "worker-one",
  deploymentUid: "deployment-one",
  deploymentGeneration: 1,
  sourceOperationId: "op-deployment-one",
  ingress: { kind: "endpoint", endpointUid: "endpoint-one", endpointGeneration: 1 },
  versionUid: "version-one",
  versionGeneration: 1,
  versionOperationId: "op-version-one",
  nativeIdentity: "script-one",
  closureDigest: digest,
  confirmedReceipt: "etag-one",
} as const;

async function seed(sql: Sql) {
  for (const [uid, form, name] of [
    ["worker-one", "ModuleWorker/0.3.0", "worker"],
    ["deployment-one", "WorkerDeployment/0.4.0", "deployment"],
    ["endpoint-one", "WorkerEndpoint/0.3.0", "endpoint"],
    ["version-one", "WorkerVersion/0.5.0", "version"],
  ] as const) {
    await sql.run(
      `INSERT INTO tf_v2_resources
       (uid, principal, form_url, space, name, backend_id, target_key,
        active_name, generation, observed_generation, phase, spec_json, last_operation)
       VALUES (?, 'org-1', ?, 'prod', ?, 'backend-one', 'target-one', ?, 1, 1, 'idle', '{}', ?)`,
      [uid, `https://edge.forms.takoform.com/forms/${form}/`, name, name, `op-${uid}`],
    );
  }
  for (const uid of ["deployment-one", "version-one"]) {
    await sql.run(
      `INSERT INTO tf_v2_operations
       (id, resource_uid, principal, replay_key, request_fingerprint, action,
        generation, status, effect, created_at, updated_at, retain_until,
        backend_id, target_key, backend_key, accepted_spec_json)
       VALUES (?, ?, 'org-1', ?, 'fp', 'create', 1, 'succeeded', 'complete',
        '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z',
        'backend-one', 'target-one', ?, '{}')`,
      [`op-${uid}`, uid, `replay-${uid}`, `key-${uid}`],
    );
  }
  await sql.run(
    `INSERT INTO tf_v2_worker_invocations
     (invocation_id, custody_token, backend_id, target_key, principal, space,
      worker_uid, deployment_uid, deployment_generation, source_operation_id,
      endpoint_uid, endpoint_generation, version_uid, version_generation,
      version_operation_id, native_identity, closure_digest, confirmed_receipt,
      admitted_at_ms)
     VALUES (?, ?, 'backend-one', 'target-one', 'org-1', 'prod',
       'worker-one', 'deployment-one', 1, 'op-deployment-one',
       'endpoint-one', 1, 'version-one', 1, 'op-version-one',
       'script-one', ?, 'etag-one', 1000)`,
    [handle.invocationId, handle.custodyToken, digest],
  );
}

async function exercise(sql: Sql, alreadySeeded = false) {
  if (!alreadySeeded) await seed(sql);
  const owner = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
  const mutableHandle = { ...handle };
  const pendingRead = owner.read(mutableHandle);
  mutableHandle.invocationId = "other-invocation";
  mutableHandle.custodyToken = "other-custody-token";
  const ownedRecord = await pendingRead;
  expect(ownedRecord?.handle).toEqual(handle);
  expect(Object.isFrozen(ownedRecord)).toBe(true);
  expect(Object.isFrozen(ownedRecord?.handle)).toBe(true);
  expect(await owner.beginSend(ownedRecord?.handle ?? mutableHandle)).toBe(true);
  expect(await owner.read(handle)).toMatchObject({
    phase: "send_authorized",
    bodyState: null,
    versionUid: "version-one",
    nativeIdentity: "script-one",
    sourceOperationId: "op-deployment-one",
  });
  expect(await owner.beginSend(handle)).toBe(false);
  expect(await owner.refuseBeforeSend(handle)).toBe(false);
  expect(await owner.observeBody(handle, "finished")).toBe(true);
  const mutableObservedHandle = { ...handle };
  const pendingObservation = owner.observeBody(mutableObservedHandle, "finished");
  mutableObservedHandle.invocationId = "other-invocation";
  mutableObservedHandle.custodyToken = "other-custody-token";
  expect(await pendingObservation).toBe(true);
  expect(await owner.observeBody(handle, "canceled")).toBe(false);
  expect(await owner.inspectDeployment("deployment-one")).toEqual({
    outstanding: 1,
    bodyFinished: 1,
  });
  expect(await owner.read(handle)).toMatchObject({
    phase: "send_authorized",
    bodyState: "finished",
    versionUid: "version-one",
  });
  await expect(
    sql.run(
      `INSERT INTO tf_v2_operations
     (id, resource_uid, principal, replay_key, request_fingerprint, action,
      generation, status, effect, created_at, updated_at, retain_until,
      backend_id, target_key, backend_key, accepted_spec_json)
     VALUES ('op-delete-version', 'version-one', 'org-1', 'replay-delete-version',
      'fp', 'delete', 2, 'queued', 'none', '2026-10-07T00:00:00Z',
      '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z',
      'backend-one', 'target-one', 'key-delete-version', '{}')`,
    ),
  ).rejects.toThrow();
  // A body EOF is not the provider's post-waitUntil terminal trace.
  expect(
    await owner.confirmNativeRetirement({
      handle,
      expected: { ...retirementIdentity, nativeIdentity: "other-script" },
      receiptDigest: terminalReceipt,
    }),
  ).toBe(false);
  expect(
    await owner.confirmNativeRetirement({
      handle,
      expected: { ...retirementIdentity, principal: "other-organization" },
      receiptDigest: terminalReceipt,
    }),
  ).toBe(false);
  expect(
    await owner.confirmNativeRetirement({
      handle,
      expected: retirementIdentity,
      receiptDigest: terminalReceipt,
    }),
  ).toBe(true);
  expect(
    await owner.confirmNativeRetirement({
      handle,
      expected: retirementIdentity,
      receiptDigest: terminalReceipt,
    }),
  ).toBe(true);
  expect(
    await owner.confirmNativeRetirement({
      handle,
      expected: retirementIdentity,
      receiptDigest: `sha256:${"c".repeat(64)}`,
    }),
  ).toBe(false);
  expect(await owner.read(handle)).toMatchObject({
    retirement: { receiptDigest: terminalReceipt, retiredAtMs: 2000 },
  });
  expect(await owner.confirmNoNativeDispatch(handle)).toBe(false);
  expect(await owner.inspectDeployment("deployment-one")).toEqual({
    outstanding: 0,
    bodyFinished: 0,
  });
  // The old live-Reference guard must now permit an accepted Version delete.
  await sql.run(
    `INSERT INTO tf_v2_operations
     (id, resource_uid, principal, replay_key, request_fingerprint, action,
      generation, status, effect, created_at, updated_at, retain_until,
      backend_id, target_key, backend_key, accepted_spec_json)
     VALUES ('op-delete-version-confirmed', 'version-one', 'org-1',
      'replay-delete-version-confirmed', 'fp', 'delete', 2, 'queued', 'none',
      '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z',
      '2026-10-08T00:00:00Z', 'backend-one', 'target-one',
      'key-delete-version-confirmed', '{}')`,
  );
  expect(
    await sql.query("SELECT id FROM tf_v2_operations WHERE id = ?", [
      "op-delete-version-confirmed",
    ]),
  ).toHaveLength(1);
}

test("SQLite invocation lifecycle keeps a finished body outstanding and protects its Version", async () => {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    await exercise(createSqliteSql(db));
  } finally {
    db.close();
  }
});

test("a lost retirement ACK resolves from the exact row and cannot reassign the receipt", async () => {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    await seed(sql);
    const owner = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
    expect(
      await owner.confirmNativeRetirement({
        handle,
        expected: retirementIdentity,
        receiptDigest: terminalReceipt,
      }),
    ).toBe(false);
    expect(await owner.beginSend(handle)).toBe(true);
    const lostAckSql: Sql = {
      query: (statement, params) => sql.query(statement, params),
      batch: (statements) => sql.batch(statements),
      async run(statement, params) {
        const result = await sql.run(statement, params);
        if (statement.includes("SET retired_at_ms")) throw new Error("retirement ACK lost");
        return result;
      },
    };
    const resumed = createV2WorkerInvocationLifecycle({
      sql: lostAckSql,
      now: () => new Date(2000),
    });
    expect(
      await resumed.confirmNativeRetirement({
        handle,
        expected: retirementIdentity,
        receiptDigest: terminalReceipt,
      }),
    ).toBe(true);
    await expect(
      sql.run(
        `UPDATE tf_v2_worker_invocations SET retirement_receipt_digest = ?
       WHERE invocation_id = ?`,
        [`sha256:${"c".repeat(64)}`, handle.invocationId],
      ),
    ).rejects.toThrow();
    const second = { invocationId: "invocation-002", custodyToken: "private-custody-token-002" };
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id, custody_token, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt,
        admitted_at_ms)
       SELECT ?, ?, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt,
        admitted_at_ms FROM tf_v2_worker_invocations WHERE invocation_id = ?`,
      [second.invocationId, second.custodyToken, handle.invocationId],
    );
    expect(await owner.beginSend(second)).toBe(true);
    expect(
      await owner.confirmNativeRetirement({
        handle: second,
        expected: retirementIdentity,
        receiptDigest: terminalReceipt,
      }),
    ).toBe(false);
    expect((await owner.read(second))?.retirement).toBeNull();
    expect(await owner.inspectDeployment("deployment-one")).toMatchObject({ outstanding: 1 });
  } finally {
    db.close();
  }
});

test("proven no-native-dispatch after send authorization is a durable terminal, not retirement", async () => {
  const db = new Database(":memory:");
  try {
    migrateSqlite(db);
    const sql = createSqliteSql(db);
    await seed(sql);
    const custody = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
    expect(await custody.confirmNoNativeDispatch(handle)).toBe(false);
    expect(await custody.beginSend(handle)).toBe(true);
    expect(
      await custody.confirmNoNativeDispatch({
        invocationId: handle.invocationId,
        custodyToken: "wrong-token",
      }),
    ).toBe(false);
    expect(await custody.inspectDeployment("deployment-one")).toEqual({
      outstanding: 1,
      bodyFinished: 0,
    });
    expect(await custody.confirmNoNativeDispatch(handle)).toBe(true);
    await expect(
      sql.run(
        "UPDATE tf_v2_worker_invocations SET no_native_dispatch_at_ms = ? WHERE invocation_id = ?",
        [2001, handle.invocationId],
      ),
    ).rejects.toThrow();
    expect(await custody.read(handle)).toMatchObject({
      phase: "send_authorized",
      noNativeDispatchAtMs: 2000,
      bodyState: null,
      retirement: null,
    });
    expect(await custody.inspectDeployment("deployment-one")).toEqual({
      outstanding: 0,
      bodyFinished: 0,
    });
    expect(await custody.confirmNoNativeDispatch(handle)).toBe(true);
    expect(await custody.observeBody(handle, "canceled")).toBe(false);
    expect(
      await custody.confirmNativeRetirement({
        handle,
        expected: retirementIdentity,
        receiptDigest: terminalReceipt,
      }),
    ).toBe(false);
  } finally {
    db.close();
  }
});

test("0084 forward migration preserves old sent rows and exact lost-ACK terminal readback", async () => {
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS.filter(
      ({ name }) =>
        !name.startsWith("0084_") &&
        !name.startsWith("0086_") &&
        !name.startsWith("0087_") &&
        !name.startsWith("0088_"),
    ))
      db.exec(migration.sql);
    const sql = createSqliteSql(db);
    await seed(sql);
    await sql.run(
      "UPDATE tf_v2_worker_invocations SET phase = 'send_authorized', send_authorized_at_ms = 1500 WHERE invocation_id = ?",
      [handle.invocationId],
    );
    expect(await inspectV2WorkerInvocationSchema(sql)).toBeNull();
    const forward = MIGRATIONS.find(({ name }) => name.startsWith("0084_"));
    if (!forward) throw new Error("missing 0084 source");
    db.exec(forward.sql);
    expect(await inspectV2WorkerInvocationSchema(sql)).toBe("endpoint");
    const owner = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
    const legacyTail = { invocationId: "legacy-tail", custodyToken: "legacy-tail-token" };
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id, custody_token, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt, admitted_at_ms)
       SELECT ?, ?, backend_id, target_key, principal, space, worker_uid, deployment_uid,
         deployment_generation, source_operation_id, endpoint_uid, endpoint_generation,
         version_uid, version_generation, version_operation_id, native_identity,
         closure_digest, confirmed_receipt, admitted_at_ms
       FROM tf_v2_worker_invocations WHERE invocation_id = ?`,
      [legacyTail.invocationId, legacyTail.custodyToken, handle.invocationId],
    );
    expect(await owner.beginSend(legacyTail)).toBe(true);
    expect(await owner.observeBody(legacyTail, "finished")).toBe(true);
    expect(
      await owner.confirmNativeRetirement({
        handle: legacyTail,
        expected: retirementIdentity,
        receiptDigest: `sha256:${"c".repeat(64)}`,
      }),
    ).toBe(true);
    expect((await owner.read(legacyTail))?.retirement?.receiptDigest).toBe(
      `sha256:${"c".repeat(64)}`,
    );
    expect(await owner.inspectDeployment("deployment-one")).toEqual({
      outstanding: 1,
      bodyFinished: 0,
    });
    const versionDelete = `INSERT INTO tf_v2_operations
      (id, resource_uid, principal, replay_key, request_fingerprint, action,
       generation, status, effect, created_at, updated_at, retain_until,
       backend_id, target_key, backend_key, accepted_spec_json)
      VALUES ('op-delete-after-0084', 'version-one', 'org-1', 'delete-after-0084',
       'fp', 'delete', 2, 'queued', 'none', '2026-10-07T00:00:00Z',
       '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z',
       'backend-one', 'target-one', 'key-delete-after-0084', '{}')`;
    await expect(sql.run(versionDelete)).rejects.toThrow();
    const lostAckSql: Sql = {
      query: (statement, params) => sql.query(statement, params),
      batch: (statements) => sql.batch(statements),
      async run(statement, params) {
        const result = await sql.run(statement, params);
        if (statement.includes("SET no_native_dispatch_at_ms"))
          throw new Error("no-dispatch ACK lost");
        return result;
      },
    };
    const uncertain = createV2WorkerInvocationLifecycle({
      sql: lostAckSql,
      now: () => new Date(2000),
    });
    expect(await uncertain.confirmNoNativeDispatch(handle)).toBe(true);
    expect(await owner.confirmNoNativeDispatch(handle)).toBe(true);
    expect(await owner.inspectDeployment("deployment-one")).toEqual({
      outstanding: 0,
      bodyFinished: 0,
    });
    expect(await owner.read(handle)).toMatchObject({
      phase: "send_authorized",
      noNativeDispatchAtMs: 2000,
      retirement: null,
    });
    await sql.run(versionDelete);
    expect(
      await sql.query("SELECT id FROM tf_v2_operations WHERE id = ?", ["op-delete-after-0084"]),
    ).toHaveLength(1);
  } finally {
    db.close();
  }
});

test("native D1 preserves invocation lifetime and beginSend across the full Cron schema", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-invocation-custody-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-invocation-custody-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS.filter(
      ({ name }) =>
        name === "0070_takoform_v2.sql" ||
        name === "0071_v2_sqlite_migration_set_custody.sql" ||
        name === "0073_v2_reference_acceptance.sql" ||
        name === "0074_v2_worker_native_effects.sql" ||
        name === "0076_v2_worker_invocation_custody.sql" ||
        name === "0077_v2_operation_acceptance_order.sql" ||
        name === "0078_v2_worker_invocation_retirement.sql" ||
        name === "0079_v2_worker_native_deletions.sql" ||
        name === "0080_v2_worker_cron_trigger_matches.sql" ||
        name === "0084_v2_worker_invocation_no_native_dispatch.sql",
    )) {
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    }
    const sql = createD1Sql(database);
    await seed(sql);
    const oldRow = await sql.query(
      "SELECT * FROM tf_v2_worker_invocations WHERE invocation_id = ?",
      [handle.invocationId],
    );
    const forward = MIGRATIONS.find(
      ({ name }) => name === "0086_v2_worker_service_invocation_custody.sql",
    );
    if (!forward) throw new Error("missing 0086 source");
    for (const statement of splitMigration(forward.sql)) await database.prepare(statement).run();
    const migrated = await sql.query(
      "SELECT * FROM tf_v2_worker_invocations WHERE invocation_id = ? /* after 0086 */",
      [handle.invocationId],
    );
    expect(migrated[0]).toMatchObject(oldRow[0] ?? {});
    expect(migrated[0]?.ingress_kind).toBe("endpoint");
    await exercise(sql, true);
    const second = { invocationId: "d1-no-native-invocation", custodyToken: "d1-no-native-token" };
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id, custody_token, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt,
        admitted_at_ms)
       SELECT ?, ?, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt,
        admitted_at_ms FROM tf_v2_worker_invocations WHERE invocation_id = ?`,
      [second.invocationId, second.custodyToken, handle.invocationId],
    );
    const owner = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
    expect(await owner.beginSend(second)).toBe(true);
    expect(await owner.confirmNoNativeDispatch(second)).toBe(true);
    expect(await owner.read(second)).toMatchObject({
      phase: "send_authorized",
      noNativeDispatchAtMs: 2000,
      retirement: null,
    });
    const cronForward = MIGRATIONS.find(
      ({ name }) => name === "0087_v2_worker_cron_invocation_custody.sql",
    );
    if (!cronForward) throw new Error("missing 0087 source");
    for (const statement of splitMigration(cronForward.sql))
      await database.prepare(statement).run();
    expect(await inspectV2WorkerInvocationSchema(sql)).toBe("cron");
    const afterCronSchema = {
      invocationId: "d1-endpoint-on-cron-schema",
      custodyToken: "d1-endpoint-on-cron-schema-token",
    };
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id,custody_token,backend_id,target_key,principal,space,
        worker_uid,deployment_uid,deployment_generation,source_operation_id,
        ingress_kind,endpoint_uid,endpoint_generation,version_uid,version_generation,
        version_operation_id,native_identity,closure_digest,confirmed_receipt,admitted_at_ms)
       SELECT ?,?,backend_id,target_key,principal,space,worker_uid,deployment_uid,
         deployment_generation,source_operation_id,'endpoint',endpoint_uid,
         endpoint_generation,version_uid,version_generation,version_operation_id,
         native_identity,closure_digest,confirmed_receipt,admitted_at_ms
       FROM tf_v2_worker_invocations WHERE invocation_id=?`,
      [afterCronSchema.invocationId, afterCronSchema.custodyToken, handle.invocationId],
    );
    expect(await owner.beginSend(afterCronSchema)).toBe(true);
    expect((await owner.read(afterCronSchema))?.phase).toBe("send_authorized");
    const serviceAfterCronSchema = {
      invocationId: "d1-service-on-cron-schema",
      custodyToken: "d1-service-on-cron-schema-token",
    };
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id,custody_token,backend_id,target_key,principal,space,
        worker_uid,deployment_uid,deployment_generation,source_operation_id,
        ingress_kind,service_caller_worker_uid,service_caller_version_uid,
        service_caller_version_generation,service_caller_version_operation_id,
        service_binding_name,service_caller_execution_ref,version_uid,version_generation,
        version_operation_id,native_identity,closure_digest,confirmed_receipt,admitted_at_ms)
       SELECT ?,?,backend_id,target_key,principal,space,worker_uid,deployment_uid,
         deployment_generation,source_operation_id,'service',worker_uid,version_uid,
         version_generation,version_operation_id,'CALLER','native-d1-slot',version_uid,
         version_generation,version_operation_id,native_identity,closure_digest,
         confirmed_receipt,admitted_at_ms
       FROM tf_v2_worker_invocations WHERE invocation_id=?`,
      [
        serviceAfterCronSchema.invocationId,
        serviceAfterCronSchema.custodyToken,
        handle.invocationId,
      ],
    );
    expect(await owner.beginSend(serviceAfterCronSchema)).toBe(true);
    expect((await owner.read(serviceAfterCronSchema))?.phase).toBe("send_authorized");

    // Seed an already-admitted physical Cron attempt. Its setup bypasses only
    // the match/publication insert guards; beginSend must still prove the live
    // lease, active graph, and confirmed native receipt in its D1 UPDATE.
    await database.prepare("DROP TRIGGER tf_v2_worker_cron_match_insert_guard").run();
    await database.prepare("DROP TRIGGER tf_v2_worker_native_effect_insert_guard").run();
    await sql.run(`UPDATE tf_v2_resources SET observed_json=? WHERE uid='worker-one'`, [
      JSON.stringify({ ready: true, activeDeploymentUid: "deployment-one" }),
    ]);
    await sql.run(
      `UPDATE tf_v2_resources SET spec_json=?, observed_json=? WHERE uid='deployment-one'`,
      [
        JSON.stringify({
          versions: [{ workerVersion: { resourceUid: "version-one" }, weight: 10_000 }],
        }),
        JSON.stringify({
          ready: true,
          active: true,
          selectedVersions: [{ resourceUid: "version-one", weight: 10_000 }],
        }),
      ],
    );
    await sql.run(
      `UPDATE tf_v2_resources SET spec_json=?, observed_json=? WHERE uid='version-one'`,
      [JSON.stringify({ handlers: ["scheduled"] }), JSON.stringify({ ready: true })],
    );
    await sql.run(
      `INSERT INTO tf_v2_worker_native_effects
       (operation_id,resource_uid,principal,space,backend_key,backend_id,target_key,
        generation,native_identity,closure_digest,grant_lease_token,granted_at_ms,
        acknowledged_receipt,confirmed_receipt)
       VALUES ('op-version-one','version-one','org-1','prod','key-version-one',
         'backend-one','target-one',1,'script-one',?,'native-grant-001',1000,
         'etag-one','etag-one')`,
      [digest],
    );
    await sql.run(
      `INSERT INTO tf_v2_resources
       (uid,principal,form_url,space,name,backend_id,target_key,active_name,
        generation,observed_generation,phase,spec_json,last_operation)
       VALUES ('cron-trigger-one','org-1',
         'https://edge.forms.takoform.com/forms/WorkerCronTrigger/0.3.0/',
         'prod','cron-trigger','backend-one','target-one','cron-trigger',1,1,
         'idle','{}','op-cron-trigger-one')`,
    );
    await sql.run(
      `INSERT INTO tf_v2_operations
       (id,resource_uid,principal,replay_key,request_fingerprint,action,
        generation,status,effect,created_at,updated_at,retain_until,
        backend_id,target_key,backend_key,accepted_spec_json)
       VALUES ('op-cron-trigger-one','cron-trigger-one','org-1','replay-cron-trigger-one',
         'fp','create',1,'succeeded','complete','2026-10-07T00:00:00Z',
         '2026-10-07T00:00:00Z','2026-10-08T00:00:00Z','backend-one',
         'target-one','key-cron-trigger-one','{}')`,
    );
    const cronMatch = `sha256:${"c".repeat(64)}`;
    const cronLease = "native-d1-cron-lease-token";
    await sql.run(
      `INSERT INTO tf_v2_worker_cron_matches
       (match_id,trigger_uid,principal,space,target_key,trigger_generation,
        trigger_operation_id,trigger_settled_at,worker_uid,cron,scheduled_time_ms,
        state,attempts,created_at_ms,next_attempt_at_ms,lease_token,lease_until_ms,
        updated_at_ms)
       VALUES (?,'cron-trigger-one','org-1','prod','target-one',1,
         'op-cron-trigger-one','2026-10-07T00:00:00Z','worker-one','* * * * *',
         1000,'dispatching',1,1000,1000,?,?,1000)`,
      [cronMatch, cronLease, Date.now() + 60_000],
    );
    const cronAfterCronSchema = {
      invocationId: "d1-cron-on-cron-schema",
      custodyToken: "d1-cron-on-cron-schema-token",
    };
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id,custody_token,backend_id,target_key,principal,space,
        worker_uid,deployment_uid,deployment_generation,source_operation_id,
        ingress_kind,cron_match_id,cron_trigger_operation_id,cron_lease_token,cron_attempt,
        version_uid,version_generation,version_operation_id,native_identity,
        closure_digest,confirmed_receipt,admitted_at_ms)
       VALUES (?,?,'backend-one','target-one','org-1','prod','worker-one',
         'deployment-one',1,'op-deployment-one','cron',?,
         'op-cron-trigger-one',?,1,'version-one',1,'op-version-one',
         'script-one',?,'etag-one',1000)`,
      [
        cronAfterCronSchema.invocationId,
        cronAfterCronSchema.custodyToken,
        cronMatch,
        cronLease,
        digest,
      ],
    );
    expect(await owner.beginSend(cronAfterCronSchema)).toBe(true);
    expect(await owner.beginSend(cronAfterCronSchema)).toBe(false);
  } finally {
    await runtime.dispose();
  }
});

test("0086 preserves populated endpoint phases and opens exact endpoint-free Service lifecycle", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS.filter(
      ({ name }) =>
        !name.startsWith("0086_") && !name.startsWith("0087_") && !name.startsWith("0088_"),
    ))
      db.exec(migration.sql);
    const sql = createSqliteSql(db);
    await seed(sql);
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id, custody_token, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt,
        admitted_at_ms)
       SELECT 'old-retired', 'retired-custody-token', backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt, admitted_at_ms
       FROM tf_v2_worker_invocations WHERE invocation_id = ?`,
      [handle.invocationId],
    );
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
       (invocation_id, custody_token, backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt,
        admitted_at_ms)
       SELECT 'old-no-dispatch', 'no-dispatch-token', backend_id, target_key, principal, space,
        worker_uid, deployment_uid, deployment_generation, source_operation_id,
        endpoint_uid, endpoint_generation, version_uid, version_generation,
        version_operation_id, native_identity, closure_digest, confirmed_receipt, admitted_at_ms
       FROM tf_v2_worker_invocations WHERE invocation_id = ?`,
      [handle.invocationId],
    );
    const before = await sql.query("SELECT * FROM tf_v2_worker_invocations ORDER BY invocation_id");
    await sql.run(
      "UPDATE tf_v2_worker_invocations SET phase = 'send_authorized', send_authorized_at_ms = 1500 WHERE invocation_id <> ?",
      [handle.invocationId],
    );
    await sql.run(
      "UPDATE tf_v2_worker_invocations SET retired_at_ms = 1600, retirement_receipt_digest = ? WHERE invocation_id = 'old-retired'",
      [`sha256:${"d".repeat(64)}`],
    );
    await sql.run(
      "UPDATE tf_v2_worker_invocations SET no_native_dispatch_at_ms = 1600 WHERE invocation_id = 'old-no-dispatch'",
    );
    const populated = await sql.query(
      "SELECT * FROM tf_v2_worker_invocations ORDER BY invocation_id",
    );
    expect(before).toHaveLength(3);
    const migration = MIGRATIONS.find(({ name }) => name.startsWith("0086_"));
    if (!migration) throw new Error("missing 0086 source");
    db.exec(migration.sql);
    expect(await inspectV2WorkerInvocationSchema(sql)).toBe("service");
    expect(
      await sql.query(`SELECT 1 WHERE ${v2WorkerInvocationSchemaReady("service")}`),
    ).toHaveLength(1);
    // A new SQL text avoids bun:sqlite's cached pre-DDL SELECT * shape.
    const after = await sql.query(
      "SELECT * FROM tf_v2_worker_invocations ORDER BY invocation_id /* 0086 */",
    );
    expect(after).toHaveLength(3);
    for (let index = 0; index < populated.length; index += 1) {
      expect(after[index]).toMatchObject(populated[index] ?? {});
      expect(after[index]?.ingress_kind).toBe("endpoint");
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    await sql.run(`INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key, active_name,
       generation, observed_generation, phase, spec_json, last_operation)
      SELECT 'caller-version', principal, form_url, space, 'caller-version', backend_id,
       target_key, 'caller-version', generation, observed_generation, phase, spec_json,
       'op-caller-version' FROM tf_v2_resources WHERE uid = 'version-one'`);
    await sql.run(`INSERT INTO tf_v2_operations
      (id, resource_uid, principal, replay_key, request_fingerprint, action,
       generation, status, effect, created_at, updated_at, retain_until,
       backend_id, target_key, backend_key, accepted_spec_json)
      SELECT 'op-caller-version', 'caller-version', principal, 'replay-caller-version',
       request_fingerprint, action, generation, status, effect, created_at,
       updated_at, retain_until, backend_id, target_key, 'key-caller-version',
       accepted_spec_json FROM tf_v2_operations WHERE id = 'op-version-one'`);
    const service = { invocationId: "service-001", custodyToken: "service-custody-token" };
    const serviceInsert = `INSERT INTO tf_v2_worker_invocations
      (invocation_id, custody_token, backend_id, target_key, principal, space,
       worker_uid, deployment_uid, deployment_generation, source_operation_id,
       ingress_kind, endpoint_uid, endpoint_generation, service_caller_worker_uid,
       service_caller_version_uid, service_caller_version_generation,
       service_caller_version_operation_id, service_binding_name, service_caller_execution_ref,
       version_uid, version_generation, version_operation_id, native_identity,
       closure_digest, confirmed_receipt, admitted_at_ms)
      SELECT ?, ?, backend_id, target_key, principal, space,
       worker_uid, deployment_uid, deployment_generation, source_operation_id,
       'service', NULL, NULL, 'worker-one', 'caller-version', 1,
       'op-caller-version', 'UPSTREAM', 'nonsecret-caller-slot-1',
       version_uid, version_generation, version_operation_id, native_identity,
       closure_digest, confirmed_receipt, admitted_at_ms
      FROM tf_v2_worker_invocations WHERE invocation_id = ?`;
    await sql.run(serviceInsert, [service.invocationId, service.custodyToken, handle.invocationId]);
    const owner = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
    expect((await owner.read(service))?.ingress).toEqual({
      kind: "service",
      callerWorkerUid: "worker-one",
      callerVersionUid: "caller-version",
      callerVersionGeneration: 1,
      callerVersionOperationId: "op-caller-version",
      bindingName: "UPSTREAM",
      callerExecutionRef: "nonsecret-caller-slot-1",
    });
    const noDispatch = {
      invocationId: "service-no-dispatch",
      custodyToken: "service-no-dispatch-token",
    };
    await sql.run(serviceInsert, [
      noDispatch.invocationId,
      noDispatch.custodyToken,
      handle.invocationId,
    ]);
    expect(await owner.beginSend(noDispatch)).toBe(true);
    expect(await owner.confirmNoNativeDispatch(noDispatch)).toBe(true);
    expect(await owner.confirmNoNativeDispatch(noDispatch)).toBe(true);
    expect(await owner.observeBody(noDispatch, "finished")).toBe(false);
    expect((await owner.read(noDispatch))?.noNativeDispatchAtMs).toBe(2000);
    await expect(
      sql.run(
        "UPDATE tf_v2_worker_invocations SET service_caller_execution_ref = 'rewritten' WHERE invocation_id = ?",
        [service.invocationId],
      ),
    ).rejects.toThrow();
    const deleteCaller = `INSERT INTO tf_v2_operations
      (id, resource_uid, principal, replay_key, request_fingerprint, action,
       generation, status, effect, created_at, updated_at, retain_until,
       backend_id, target_key, backend_key, accepted_spec_json)
      VALUES ('op-delete-caller-version', 'caller-version', 'org-1',
       'replay-delete-caller-version', 'fp', 'delete', 2, 'queued', 'none',
       '2026-10-07T00:00:00Z', '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z',
       'backend-one', 'target-one', 'key-delete-caller-version', '{}')`;
    await expect(sql.run(deleteCaller)).rejects.toThrow();
    expect(await owner.beginSend(service)).toBe(true);
    expect(await owner.observeBody(service, "finished")).toBe(true);
    expect(await owner.inspectDeployment("deployment-one")).toEqual({
      outstanding: 2,
      bodyFinished: 1,
    });
    expect(
      await owner.confirmNativeRetirement({
        handle: service,
        expected: {
          ...retirementIdentity,
          ingress: {
            kind: "service",
            callerWorkerUid: "worker-one",
            callerVersionUid: "caller-version",
            callerVersionGeneration: 1,
            callerVersionOperationId: "op-caller-version",
            bindingName: "UPSTREAM",
            callerExecutionRef: "wrong-slot",
          },
        },
        receiptDigest: `sha256:${"e".repeat(64)}`,
      }),
    ).toBe(false);
    expect(
      await owner.confirmNativeRetirement({
        handle: service,
        expected: {
          ...retirementIdentity,
          ingress: {
            kind: "service",
            callerWorkerUid: "worker-one",
            callerVersionUid: "caller-version",
            callerVersionGeneration: 1,
            callerVersionOperationId: "op-caller-version",
            bindingName: "UPSTREAM",
            callerExecutionRef: "nonsecret-caller-slot-1",
          },
        },
        receiptDigest: `sha256:${"e".repeat(64)}`,
      }),
    ).toBe(true);
    expect(await owner.inspectDeployment("deployment-one")).toEqual({
      outstanding: 1,
      bodyFinished: 0,
    });
    await sql.run(deleteCaller);
    await expect(
      sql.run(serviceInsert.replace("'service', NULL, NULL", "'service', 'endpoint-one', NULL"), [
        "mixed-001",
        "mixed-custody-token",
        handle.invocationId,
      ]),
    ).rejects.toThrow();
    await expect(
      sql.run(
        serviceInsert.replace(
          "'UPSTREAM', 'nonsecret-caller-slot-1'",
          "NULL, 'nonsecret-caller-slot-1'",
        ),
        ["partial-001", "partial-custody-token", handle.invocationId],
      ),
    ).rejects.toThrow();
    await expect(
      sql.run("DELETE FROM tf_v2_worker_invocations WHERE invocation_id = ?", [
        service.invocationId,
      ]),
    ).rejects.toThrow();
  } finally {
    db.close();
  }
});

test("native D1 fences external SQLite through Tail and exact trusted drain", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-sqlite-drain-d1-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "v2-sqlite-drain-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS.filter(
      ({ name }) =>
        name === "0070_takoform_v2.sql" ||
        name === "0071_v2_sqlite_migration_set_custody.sql" ||
        name === "0073_v2_reference_acceptance.sql" ||
        name === "0074_v2_worker_native_effects.sql" ||
        name === "0076_v2_worker_invocation_custody.sql" ||
        name === "0077_v2_operation_acceptance_order.sql" ||
        name === "0078_v2_worker_invocation_retirement.sql" ||
        name === "0079_v2_worker_native_deletions.sql" ||
        name === "0080_v2_worker_cron_trigger_matches.sql" ||
        name === "0084_v2_worker_invocation_no_native_dispatch.sql",
    )) {
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    }
    const sql = createD1Sql(database);
    await seed(sql);
    const owner = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
    for (const name of [
      "0086_v2_worker_service_invocation_custody.sql",
      "0087_v2_worker_cron_invocation_custody.sql",
    ]) {
      const migration = MIGRATIONS.find((entry) => entry.name === name);
      if (!migration) throw new Error(`missing ${name}`);
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
      if (name.startsWith("0086_")) expect(await owner.beginSend(handle)).toBe(true);
    }
    // The earlier Endpoint SQL grant is preserved across the later migration.
    const use = { handle, expected: retirementIdentity };
    expect(await inspectV2WorkerInvocationDrainSchema(sql)).toBe(false);
    expect(await owner.armSQLiteExternalUse(use)).toBe(false);
    const migration = MIGRATIONS.find(
      (entry) => entry.name === "0088_v2_worker_sqlite_external_drain.sql",
    );
    if (!migration) throw new Error("missing 0088 source");
    for (const [index, statement] of splitMigration(migration.sql).entries()) {
      await database.prepare(statement).run();
      if (index === 0) {
        expect(await inspectV2WorkerInvocationSchema(sql)).toBeNull();
        expect(await owner.armSQLiteExternalUse(use)).toBe(false);
      }
    }
    expect(await inspectV2WorkerInvocationDrainSchema(sql)).toBe(true);
    expect(await owner.read(handle)).toMatchObject({ sqliteDrainState: null });
    expect(
      await owner.armSQLiteExternalUse({ ...use, handle: { ...handle, custodyToken: "wrong" } }),
    ).toBe(false);
    expect(
      await owner.armSQLiteExternalUse({
        ...use,
        expected: { ...retirementIdentity, principal: "wrong" },
      }),
    ).toBe(false);
    const outage: Sql = {
      query: async () => {
        throw new Error("D1 unavailable");
      },
      run: sql.run,
      batch: sql.batch,
    };
    expect(await createV2WorkerInvocationLifecycle({ sql: outage }).armSQLiteExternalUse(use)).toBe(
      false,
    );
    const lostArmAck: Sql = {
      query: async (statement, params) => {
        const rows = await sql.query(statement, params);
        if (statement.includes("SET sqlite_drain_state = 'pending'"))
          throw new Error("D1 arm ACK lost");
        return rows;
      },
      run: sql.run,
      batch: sql.batch,
    };
    expect(
      await createV2WorkerInvocationLifecycle({ sql: lostArmAck }).armSQLiteExternalUse(use),
    ).toBe(true);
    expect(
      await Promise.all([owner.armSQLiteExternalUse(use), owner.armSQLiteExternalUse(use)]),
    ).toEqual([true, true]);
    expect(await owner.read(handle)).toMatchObject({ sqliteDrainState: "pending" });
    await expect(
      sql.run(
        "UPDATE tf_v2_worker_invocations SET no_native_dispatch_at_ms=2000 WHERE invocation_id=?",
        [handle.invocationId],
      ),
    ).rejects.toThrow();
    expect(await owner.confirmNativeRetirement({ ...use, receiptDigest: terminalReceipt })).toBe(
      true,
    );
    expect(
      await owner.confirmSQLiteDrained({
        ...use,
        receiptDigest: terminalReceipt,
        expected: { ...retirementIdentity, nativeIdentity: "wrong" },
      }),
    ).toBe(false);
    expect(await owner.armSQLiteExternalUse(use)).toBe(false);
    expect(await owner.inspectDeployment("deployment-one")).toEqual({
      outstanding: 1,
      bodyFinished: 0,
    });
    const deletion = `INSERT INTO tf_v2_operations
      (id,resource_uid,principal,replay_key,request_fingerprint,action,
       generation,status,effect,created_at,updated_at,retain_until,
       backend_id,target_key,backend_key,accepted_spec_json)
      VALUES (?,'version-one','org-1',?,'fp','delete',2,'queued','none',
        '2026-10-07T00:00:00Z','2026-10-07T00:00:00Z','2026-10-08T00:00:00Z',
        'backend-one','target-one',?,'{}')`;
    await expect(
      sql.run(deletion, ["pending-delete", "pending-replay", "pending-key"]),
    ).rejects.toThrow();
    const freshOwner = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(3000) });
    const drainReceipt = `sha256:${"d".repeat(64)}` as const;
    const lostDrainAck: Sql = {
      query: async (statement, params) => {
        const rows = await sql.query(statement, params);
        if (statement.includes("SET sqlite_drain_state = 'drained'"))
          throw new Error("D1 drain ACK lost");
        return rows;
      },
      run: sql.run,
      batch: sql.batch,
    };
    expect(
      await createV2WorkerInvocationLifecycle({ sql: lostDrainAck }).confirmSQLiteDrained({
        ...use,
        receiptDigest: terminalReceipt,
      }),
    ).toBe(true);
    expect(await freshOwner.confirmSQLiteDrained({ ...use, receiptDigest: drainReceipt })).toBe(
      false,
    );
    expect(await freshOwner.confirmSQLiteDrained({ ...use, receiptDigest: terminalReceipt })).toBe(
      true,
    );
    expect(await freshOwner.armSQLiteExternalUse(use)).toBe(false);
    expect(await freshOwner.inspectDeployment("deployment-one")).toEqual({
      outstanding: 0,
      bodyFinished: 0,
    });
    await sql.run(deletion, ["drained-delete", "drained-replay", "drained-key"]);
    await database
      .prepare("DROP TRIGGER tf_v2_worker_native_deletion_sqlite_drain_send_guard")
      .run();
    expect(await inspectV2WorkerInvocationDrainSchema(sql)).toBe(false);
    expect(await freshOwner.read(handle)).toBeNull();
  } finally {
    await runtime.dispose();
  }
});

test("0087 preserves populated Endpoint and Service custody and fences incomplete schema closure", async () => {
  const db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys = ON");
    for (const migration of MIGRATIONS.filter(
      ({ name }) => !name.startsWith("0087_") && !name.startsWith("0088_"),
    ))
      db.exec(migration.sql);
    const sql = createSqliteSql(db);
    await seed(sql);
    const service = { invocationId: "pre-0087-service", custodyToken: "service-custody-token" };
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
      (invocation_id,custody_token,backend_id,target_key,principal,space,
       worker_uid,deployment_uid,deployment_generation,source_operation_id,
       ingress_kind,service_caller_worker_uid,service_caller_version_uid,
       service_caller_version_generation,service_caller_version_operation_id,
       service_binding_name,service_caller_execution_ref,version_uid,version_generation,
       version_operation_id,native_identity,closure_digest,confirmed_receipt,admitted_at_ms)
      SELECT ?,?,backend_id,target_key,principal,space,worker_uid,deployment_uid,
        deployment_generation,source_operation_id,'service',worker_uid,version_uid,
        version_generation,version_operation_id,'CALLER','private-slot',version_uid,
        version_generation,version_operation_id,native_identity,closure_digest,
        confirmed_receipt,admitted_at_ms
      FROM tf_v2_worker_invocations WHERE invocation_id=?`,
      [service.invocationId, service.custodyToken, handle.invocationId],
    );
    await sql.run(
      `UPDATE tf_v2_worker_invocations SET phase='send_authorized',
      send_authorized_at_ms=1500 WHERE invocation_id=?`,
      [service.invocationId],
    );
    const before = await sql.query("SELECT * FROM tf_v2_worker_invocations ORDER BY invocation_id");
    const migration = MIGRATIONS.find(({ name }) => name.startsWith("0087_"));
    if (!migration) throw new Error("missing 0087 source");
    db.exec(migration.sql);
    const after = await sql.query(
      "SELECT * FROM tf_v2_worker_invocations ORDER BY invocation_id /* 0087 */",
    );
    expect(after).toHaveLength(2);
    for (let index = 0; index < before.length; index += 1) {
      expect(after[index]).toMatchObject(before[index] ?? {});
      expect(after[index]?.cron_match_id).toBeNull();
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const selectedShape = await inspectV2WorkerInvocationSchema(sql);
    expect(selectedShape).toBe("cron");
    expect(
      await sql.query(`SELECT 1 WHERE ${v2WorkerInvocationSchemaReady("service")}`),
    ).toHaveLength(0);
    expect(
      await sql.query(`SELECT 1 WHERE ${v2WorkerInvocationSchemaReady("endpoint")}`),
    ).toHaveLength(0);
    expect(await sql.query(`SELECT 1 WHERE ${v2WorkerInvocationSchemaReady("cron")}`)).toHaveLength(
      1,
    );
    const owner = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
    expect((await owner.read(service))?.ingress.kind).toBe("service");
    expect(await owner.beginSend(handle)).toBe(true);
    if (selectedShape !== "cron") throw new Error("0087 shape not ready");
    const freshService = {
      invocationId: "post-0087-service",
      custodyToken: "post-0087-service-token",
    };
    const admitService = (shape: "service" | "cron") =>
      sql.run(
        `INSERT INTO tf_v2_worker_invocations
       (invocation_id,custody_token,backend_id,target_key,principal,space,
        worker_uid,deployment_uid,deployment_generation,source_operation_id,
        ingress_kind,service_caller_worker_uid,service_caller_version_uid,
        service_caller_version_generation,service_caller_version_operation_id,
        service_binding_name,service_caller_execution_ref,version_uid,version_generation,
        version_operation_id,native_identity,closure_digest,confirmed_receipt,admitted_at_ms)
       SELECT ?,?,backend_id,target_key,principal,space,worker_uid,deployment_uid,
        deployment_generation,source_operation_id,'service',worker_uid,version_uid,
        version_generation,version_operation_id,'CALLER','fresh-slot',version_uid,
        version_generation,version_operation_id,native_identity,closure_digest,
        confirmed_receipt,admitted_at_ms
       FROM tf_v2_worker_invocations WHERE invocation_id=? AND (${v2WorkerInvocationSchemaReady(shape)})`,
        [freshService.invocationId, freshService.custodyToken, handle.invocationId],
      );
    expect((await admitService("service")).changes).toBe(0);
    expect((await admitService(selectedShape)).changes).toBe(1);
    expect((await owner.read(freshService))?.ingress.kind).toBe("service");
    expect(await owner.beginSend(freshService)).toBe(true);
    expect(
      await owner.confirmNativeRetirement({
        handle: service,
        expected: {
          ...retirementIdentity,
          ingress: {
            kind: "service",
            callerWorkerUid: "worker-one",
            callerVersionUid: "version-one",
            callerVersionGeneration: 1,
            callerVersionOperationId: "op-version-one",
            bindingName: "CALLER",
            callerExecutionRef: "private-slot",
          },
        },
        receiptDigest: terminalReceipt,
      }),
    ).toBe(true);
    expect((await owner.read(service))?.retirement?.receiptDigest).toBe(terminalReceipt);
    const pending = { invocationId: "post-0087-pending", custodyToken: "pending-custody-token" };
    await sql.run(
      `INSERT INTO tf_v2_worker_invocations
      (invocation_id,custody_token,backend_id,target_key,principal,space,
       worker_uid,deployment_uid,deployment_generation,source_operation_id,
       ingress_kind,endpoint_uid,endpoint_generation,version_uid,version_generation,
       version_operation_id,native_identity,closure_digest,confirmed_receipt,admitted_at_ms)
      SELECT ?,?,backend_id,target_key,principal,space,worker_uid,deployment_uid,
        deployment_generation,source_operation_id,ingress_kind,endpoint_uid,
        endpoint_generation,version_uid,version_generation,version_operation_id,
        native_identity,closure_digest,confirmed_receipt,admitted_at_ms
      FROM tf_v2_worker_invocations WHERE invocation_id=?`,
      [pending.invocationId, pending.custodyToken, handle.invocationId],
    );
    db.exec("CREATE TABLE tf_v2_worker_invocations_next (marker INTEGER)");
    expect(await inspectV2WorkerInvocationSchema(sql)).toBeNull();
    expect(await owner.read(handle)).toBeNull();
    expect(await owner.beginSend(pending)).toBe(false);
    db.exec("DROP TABLE tf_v2_worker_invocations_next");
    expect(await owner.beginSend(pending)).toBe(true);
    db.exec("DROP INDEX tf_v2_worker_invocations_cron_attempt");
    expect(await inspectV2WorkerInvocationSchema(sql)).toBeNull();
    expect(await owner.read(handle)).toBeNull();
  } finally {
    db.close();
  }
});

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
