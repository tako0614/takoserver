import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2WorkerInvocationLifecycle } from "../src/takoform-v2/worker-invocation-custody.ts";

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
  endpointUid: "endpoint-one",
  endpointGeneration: 1,
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

async function exercise(sql: Sql) {
  await seed(sql);
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
    for (const migration of MIGRATIONS.filter(({ name }) => !name.startsWith("0084_")))
      db.exec(migration.sql);
    const sql = createSqliteSql(db);
    await seed(sql);
    await sql.run(
      "UPDATE tf_v2_worker_invocations SET phase = 'send_authorized', send_authorized_at_ms = 1500 WHERE invocation_id = ?",
      [handle.invocationId],
    );
    const forward = MIGRATIONS.find(({ name }) => name.startsWith("0084_"));
    if (!forward) throw new Error("missing 0084 source");
    db.exec(forward.sql);
    const owner = createV2WorkerInvocationLifecycle({ sql, now: () => new Date(2000) });
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

test("native D1 enforces the same monotonic invocation lifetime", async () => {
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
        name === "0074_v2_worker_native_effects.sql" ||
        name === "0076_v2_worker_invocation_custody.sql" ||
        name === "0077_v2_operation_acceptance_order.sql" ||
        name === "0078_v2_worker_invocation_retirement.sql" ||
        name === "0079_v2_worker_native_deletions.sql" ||
        name === "0084_v2_worker_invocation_no_native_dispatch.sql",
    )) {
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    }
    const sql = createD1Sql(database);
    await exercise(sql);
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
  } finally {
    await runtime.dispose();
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
