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
const digest = `sha256:${"a".repeat(64)}`;

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
  expect(await owner.read(handle)).toMatchObject({
    phase: "admitted",
    bodyState: null,
    versionUid: "version-one",
    nativeIdentity: "script-one",
    sourceOperationId: "op-deployment-one",
  });
  expect(await owner.beginSend(handle)).toBe(true);
  expect(await owner.beginSend(handle)).toBe(false);
  expect(await owner.refuseBeforeSend(handle)).toBe(false);
  expect(await owner.observeBody(handle, "finished")).toBe(true);
  expect(await owner.observeBody(handle, "finished")).toBe(true);
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
        name === "0070_takoform_v2.sql" || name === "0076_v2_worker_invocation_custody.sql",
    )) {
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    }
    await exercise(createD1Sql(database));
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
