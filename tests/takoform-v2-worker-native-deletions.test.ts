import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { WORKER_VERSION_FORM_URL } from "../src/takoform-v2/forms/worker-specs.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";
import { createV2NativeDeletionCustody } from "../src/takoform-v2/worker-native-deletions.ts";
import { createV2NativeEffectCustody } from "../src/takoform-v2/worker-native-effects.ts";

const digest = `sha256:${"a".repeat(64)}` as const;
const nativeIdentity = `v2w-${"b".repeat(48)}`;

async function fixture(confirmUpload = true, secondSource = false, deadReferrer = false) {
  const directory = mkdtempSync(join(tmpdir(), "v2-native-delete-"));
  const path = join(directory, "db.sqlite");
  const db = new Database(path);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  const now = () => new Date();
  const backend = {
    id: "fixture-version-backend",
    targetKey: "target-a",
    async execute() {
      return { kind: "unknown" as const };
    },
    async reconcile() {
      return { kind: "unknown" as const };
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    now,
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [WORKER_VERSION_FORM_URL]: {
        validateCreate() {},
        validateUpdate() {},
        backend,
      },
    },
  });
  const created = await engine.acceptCreate({
    principal: "org-a",
    key: "create-version-key",
    input: {
      form: WORKER_VERSION_FORM_URL,
      space: "production",
      name: "version-a",
      spec: { worker: { resourceUid: "worker-a" }, handlers: [] },
    },
  });
  const store = createV2Store(sql);
  const operation = await store.operation(created.id);
  const resource = operation && (await store.resource(operation.resource_uid));
  if (!operation || !resource) throw new Error("missing accepted version");
  const sourceToken = "source-token";
  const start = Date.now();
  expect(await store.claim(operation.id, sourceToken, start, start + 60_000)).toBe(true);
  expect(await store.markDispatch(operation.id, sourceToken, now().toISOString())).toBe(true);
  const source: V2Execution = {
    operationId: operation.id,
    resourceUid: resource.uid,
    principal: operation.principal,
    action: operation.action,
    generation: operation.generation,
    form: resource.form_url,
    space: resource.space,
    name: resource.name,
    spec: JSON.parse(operation.accepted_spec_json),
    previousObserved: {},
    previousOutput: {},
    backendKey: operation.backend_key,
    backendId: operation.backend_id,
    targetKey: operation.target_key,
    leaseToken: sourceToken,
  };
  const uploads = createV2NativeEffectCustody({ sql, now });
  expect(await uploads.grant({ execution: source, nativeIdentity, closureDigest: digest })).toBe(
    "granted",
  );
  if (confirmUpload)
    expect(
      await uploads.confirm({
        execution: source,
        nativeIdentity,
        closureDigest: digest,
        receipt: "etag-upload",
      }),
    ).toBe(true);
  expect(
    await store.settle({
      id: source.operationId,
      token: sourceToken,
      status: "succeeded",
      effect: "complete",
      at: now().toISOString(),
      retainUntil: new Date(Date.now() + 86_400_000).toISOString(),
      observedJson: "{}",
      outputJson: "{}",
    }),
  ).toBe(true);
  await sql.run(
    `UPDATE tf_v2_resources SET phase = 'idle', busy_operation = NULL,
    observed_generation = 1, observed_json = '{}', output_json = '{}'
    WHERE uid = ?`,
    [resource.uid],
  );
  if (secondSource) {
    const update = await engine.acceptUpdate({
      principal: "org-a",
      key: "update-version-key",
      uid: resource.uid,
      expectedGeneration: 1,
      spec: source.spec,
    });
    const updateRow = await store.operation(update.id);
    if (!updateRow) throw new Error("missing version update");
    const token = "second-source-token";
    const updateStart = Date.now();
    expect(await store.claim(update.id, token, updateStart, updateStart + 60_000)).toBe(true);
    expect(await store.markDispatch(update.id, token, now().toISOString())).toBe(true);
    const secondExecution: V2Execution = {
      ...source,
      operationId: update.id,
      action: "update",
      generation: 2,
      backendKey: updateRow.backend_key,
      leaseToken: token,
    };
    expect(
      await uploads.grant({
        execution: secondExecution,
        nativeIdentity,
        closureDigest: digest,
      }),
    ).toBe("granted");
    expect(
      await uploads.confirm({
        execution: secondExecution,
        nativeIdentity,
        closureDigest: digest,
        receipt: "etag-second",
      }),
    ).toBe(true);
    expect(
      await store.settle({
        id: update.id,
        token,
        status: "succeeded",
        effect: "complete",
        at: now().toISOString(),
        retainUntil: new Date(Date.now() + 86_400_000).toISOString(),
        observedJson: "{}",
        outputJson: "{}",
      }),
    ).toBe(true);
    await sql.run(
      `UPDATE tf_v2_resources SET phase = 'idle', busy_operation = NULL,
      observed_generation = 2 WHERE uid = ?`,
      [resource.uid],
    );
  }
  if (deadReferrer) {
    await sql.run(
      `INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key,
       active_name, generation, observed_generation, phase, spec_json, last_operation)
      VALUES ('dead-referrer','org-a',?,'production','dead-referrer',
        'fixture-version-backend','target-a','dead-referrer',1,1,'idle','{}','dead-op')`,
      [WORKER_VERSION_FORM_URL],
    );
    await sql.run(
      `INSERT INTO tf_v2_resource_references (target_uid,referrer_uid)
      VALUES (?,'dead-referrer')`,
      [resource.uid],
    );
    await sql.run(
      `UPDATE tf_v2_resources SET deleted_at = ?, active_name = NULL
      WHERE uid = 'dead-referrer'`,
      [now().toISOString()],
    );
  }
  const deletion = await engine.acceptDelete({
    principal: "org-a",
    key: "delete-version-key",
    uid: resource.uid,
    expectedGeneration: secondSource ? 2 : 1,
  });
  const deletionRow = await store.operation(deletion.id);
  if (!deletionRow) throw new Error("missing deletion");
  const deleteToken = "delete-token";
  const deleteStart = Date.now();
  expect(await store.claim(deletionRow.id, deleteToken, deleteStart, deleteStart + 60_000)).toBe(
    true,
  );
  expect(await store.markDispatch(deletionRow.id, deleteToken, now().toISOString())).toBe(true);
  const execution: V2Execution = {
    ...source,
    operationId: deletionRow.id,
    action: "delete",
    generation: deletionRow.generation,
    backendKey: deletionRow.backend_key,
    backendId: deletionRow.backend_id,
    targetKey: deletionRow.target_key,
    leaseToken: deleteToken,
  };
  const custody = createV2NativeDeletionCustody({ sql, now });
  return {
    directory,
    path,
    db,
    sql,
    store,
    custody,
    uploads,
    source,
    execution,
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("confirmed source stages, one DELETE grant persists across reopen, and lost ACK reconciles by absence", async () => {
  const f = await fixture();
  try {
    expect(await f.custody.stageNext(f.execution)).toBe("more");
    expect(await f.custody.stageNext(f.execution)).toBe("ready");
    const item = await f.custody.next(f.execution);
    if (!item) throw new Error("missing item");
    expect(item).toMatchObject({
      sourceGeneration: 1,
      nativeIdentity,
      uploadReceipt: "etag-upload",
    });
    expect(await f.custody.qualifySource(item, "different-source-receipt")).toBe(false);
    expect(await f.custody.allAbsent(f.execution)).toBe(false);
    expect(await f.custody.grant(item, "etag-upload")).toBe("granted");
    await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms = ? WHERE id = ?", [
      Date.now() - 1000,
      f.execution.operationId,
    ]);
    const reclaimedAt = Date.now();
    expect(
      await f.store.claim(
        f.execution.operationId,
        "reclaimed-token",
        reclaimedAt,
        reclaimedAt + 60_000,
      ),
    ).toBe(true);
    const reclaimedExecution = { ...f.execution, leaseToken: "reclaimed-token" };
    const reopened = new Database(f.path);
    try {
      const custody = createV2NativeDeletionCustody({ sql: createSqliteSql(reopened) });
      expect(await custody.inspect(item)).toEqual({ kind: "sent", acknowledgedReceipt: null });
      expect(await custody.grant(item, "etag-upload")).toBe("already_granted");
      expect(await custody.confirmAbsent(item, "owned-404-receipt")).toBe(true);
      expect(await custody.inspect(item)).toEqual({
        kind: "confirmed_absent",
        receipt: "owned-404-receipt",
      });
      expect(await custody.allAbsent(f.execution)).toBe(false);
      expect(await custody.allAbsent(reclaimedExecution)).toBe(true);
    } finally {
      reopened.close();
    }
  } finally {
    f.close();
  }
});

test("historical reused script identity deletes the latest source once and accounts for every old grant", async () => {
  const f = await fixture(true, true);
  try {
    expect(await f.custody.stageNext(f.execution)).toBe("more");
    expect(await f.custody.stageNext(f.execution)).toBe("ready");
    const rows = await f.sql.query(
      "SELECT source_operation_id, source_generation FROM tf_v2_worker_native_deletions ORDER BY source_generation",
    );
    expect(rows.map((row) => row.source_generation)).toEqual([1, 2]);
    const first = await f.custody.next(f.execution);
    if (!first) throw new Error("missing first source");
    expect(first.sourceGeneration).toBe(2);
    const older = {
      ...first,
      sourceOperationId: String(rows[0]?.source_operation_id),
      sourceGeneration: 1,
      uploadReceipt: "etag-upload",
    };
    expect(await f.custody.grant(older, "etag-upload")).toBe("unknown");
    expect(await f.custody.grant(first, "etag-second")).toBe("granted");
    expect(await f.custody.confirmAbsent(first, "absence-latest")).toBe(true);
    expect(await f.custody.allAbsent(f.execution)).toBe(false);
    const second = await f.custody.next(f.execution);
    if (!second) throw new Error("missing second source");
    expect(second.sourceGeneration).toBe(1);
    expect(await f.custody.grant(second, "etag-upload")).toBe("unknown");
    expect(await f.custody.confirmAbsent(second, "absence-latest")).toBe(true);
    expect(await f.custody.allAbsent(f.execution)).toBe(true);
  } finally {
    f.close();
  }
});

test("historical edge from a tombstoned referrer does not block accepted native cleanup", async () => {
  const f = await fixture(true, false, true);
  try {
    expect(
      await f.sql.query("SELECT 1 FROM tf_v2_resource_references WHERE target_uid = ?", [
        f.execution.resourceUid,
      ]),
    ).toHaveLength(1);
    expect(await f.custody.stageNext(f.execution)).toBe("more");
    const item = await f.custody.next(f.execution);
    if (!item) throw new Error("missing item");
    expect(await f.custody.grant(item, "etag-upload")).toBe("granted");
    expect(await f.custody.confirmAbsent(item, "owned-404-receipt")).toBe(true);
    expect(await f.custody.allAbsent(f.execution)).toBe(true);
  } finally {
    f.close();
  }
});

test("confirmed old upload can be proven already absent without issuing a native DELETE", async () => {
  const f = await fixture();
  try {
    expect(await f.custody.stageNext(f.execution)).toBe("more");
    const item = await f.custody.next(f.execution);
    if (!item) throw new Error("missing item");
    await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms = ? WHERE id = ?", [
      Date.now() - 1000,
      f.execution.operationId,
    ]);
    const reclaimedAt = Date.now();
    expect(
      await f.store.claim(
        f.execution.operationId,
        "presend-reclaimed",
        reclaimedAt,
        reclaimedAt + 60_000,
      ),
    ).toBe(true);
    const resumed = { ...item, execution: { ...item.execution, leaseToken: "presend-reclaimed" } };
    expect(await f.custody.confirmAbsent(resumed, "exact-preexisting-absence")).toBe(true);
    expect(await f.custody.inspect(resumed)).toEqual({
      kind: "confirmed_absent",
      receipt: "exact-preexisting-absence",
    });
    expect(await f.custody.grant(item, "etag-upload")).toBe("unknown");
    expect(await f.custody.allAbsent(resumed.execution)).toBe(true);
  } finally {
    f.close();
  }
});

test("unknown historical upload needs new exact source readback, not old lease revival", async () => {
  const f = await fixture(false);
  try {
    expect(await f.custody.stageNext(f.execution)).toBe("more");
    const item = await f.custody.next(f.execution);
    if (!item) throw new Error("missing item");
    expect(item.uploadReceipt).toBeNull();
    expect(await f.custody.confirmAbsent(item, "unqualified-absence")).toBe(false);
    expect(await f.custody.grant(item, "qualified-owned-byte-readback")).toBe("unknown");
    expect(await f.custody.qualifySource(item, "qualified-owned-byte-readback")).toBe(true);
    expect(await f.custody.grant(item, "qualified-owned-byte-readback")).toBe("granted");
    expect(await f.custody.confirmAbsent(item, "owned-404-receipt")).toBe(true);
    expect(await f.custody.allAbsent(f.execution)).toBe(true);
  } finally {
    f.close();
  }
});

test("raw stage INSERT cannot smuggle an unverified source qualification", async () => {
  const f = await fixture(false);
  try {
    await expect(
      f.sql.run(
        `INSERT INTO tf_v2_worker_native_deletions
      (delete_operation_id, source_operation_id, resource_uid, principal, space,
       backend_id, target_key, delete_generation, source_generation,
       native_identity, closure_digest, upload_receipt, qualified_source_receipt,
       qualification_lease_token, stage_lease_token, staged_at_ms)
      SELECT ?, effect.operation_id, effect.resource_uid, effect.principal, effect.space,
        effect.backend_id, effect.target_key, ?, effect.generation,
        effect.native_identity, effect.closure_digest, effect.confirmed_receipt,
        'forged-source-proof', ?, ?, ?
      FROM tf_v2_worker_native_effects effect WHERE effect.resource_uid = ?`,
        [
          f.execution.operationId,
          f.execution.generation,
          f.execution.leaseToken,
          f.execution.leaseToken,
          Date.now(),
          f.execution.resourceUid,
        ],
      ),
    ).rejects.toThrow();
    expect(await f.sql.query("SELECT 1 FROM tf_v2_worker_native_deletions")).toHaveLength(0);
    expect(await f.custody.stageNext(f.execution)).toBe("more");
  } finally {
    f.close();
  }
});

test("a historical 0074 confirmation after staging can converge without changing its original grant", async () => {
  const f = await fixture(false);
  try {
    expect(await f.custody.stageNext(f.execution)).toBe("more");
    const item = await f.custody.next(f.execution);
    if (!item) throw new Error("missing item");
    expect(
      await f.uploads.confirm({
        execution: f.source,
        nativeIdentity,
        closureDigest: digest,
        receipt: "late-exact-upload",
      }),
    ).toBe(true);
    expect(await f.custody.stageNext(f.execution)).toBe("unknown");
    expect(await f.custody.qualifySource(item, "late-exact-upload")).toBe(true);
    expect(await f.custody.stageNext(f.execution)).toBe("ready");
    expect(await f.custody.grant(item, "late-exact-upload")).toBe("granted");
    expect(await f.custody.confirmAbsent(item, "owned-404-receipt")).toBe(true);
    expect(await f.custody.allAbsent(f.execution)).toBe(true);
  } finally {
    f.close();
  }
});

test("stale DELETE claim cannot stage or send a script", async () => {
  const f = await fixture();
  try {
    const stale = { ...f.execution, leaseToken: "stale-token" };
    expect(await f.custody.stageNext(stale)).toBe("unknown");
    expect(await f.sql.query("SELECT 1 FROM tf_v2_worker_native_deletions")).toHaveLength(0);
    expect(await f.custody.stageNext(f.execution)).toBe("more");
    const item = await f.custody.next(f.execution);
    if (!item) throw new Error("missing item");
    expect(await f.custody.grant({ ...item, execution: stale }, "etag-upload")).toBe("unknown");
    expect(await f.custody.grant(item, "wrong-fresh-source")).toBe("unknown");
    expect(await f.custody.grant(item, "etag-upload")).toBe("granted");
  } finally {
    f.close();
  }
});

test("local D1 applies 0079 and rejects an unclaimed native DELETE item", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "v2-native-delete-d1-test",
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
          env: { STATE_DB: { type: "d1", id: "v2-native-delete-d1-test" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const migration of MIGRATIONS.filter(({ name }) =>
      [
        "0070_takoform_v2.sql",
        "0071_v2_sqlite_migration_set_custody.sql",
        "0074_v2_worker_native_effects.sql",
        "0076_v2_worker_invocation_custody.sql",
        "0077_v2_operation_acceptance_order.sql",
        "0078_v2_worker_invocation_retirement.sql",
        "0079_v2_worker_native_deletions.sql",
      ].includes(name),
    )) {
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    }
    const rows = await database
      .prepare("SELECT name FROM sqlite_master WHERE name = 'tf_v2_worker_native_deletions'")
      .all();
    expect(rows.results).toHaveLength(1);
    await expect(
      database
        .prepare(`INSERT INTO tf_v2_worker_native_deletions
      (delete_operation_id,source_operation_id,resource_uid,principal,space,backend_id,target_key,
       delete_generation,source_generation,native_identity,closure_digest,stage_lease_token,staged_at_ms)
      VALUES ('missing-delete','missing-source','missing-resource','org','space','backend','target',
       2,1,?,?,'lease',1000)`)
        .bind(nativeIdentity, digest)
        .run(),
    ).rejects.toThrow();
    const sql = createD1Sql(database);
    const nowMs = Date.now();
    await sql.run(
      `INSERT INTO tf_v2_resources
      (uid,principal,form_url,space,name,backend_id,target_key,active_name,generation,
       observed_generation,phase,spec_json,last_operation,busy_operation)
      VALUES ('d1-version','org-a',?,'production','version-a','backend-a','target-a',
        'version-a',1,0,'pending','{}','d1-source','d1-source')`,
      [WORKER_VERSION_FORM_URL],
    );
    await sql.run(
      `INSERT INTO tf_v2_operations
      (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,
       status,effect,dispatch_possible,lease_token,lease_until_ms,created_at,updated_at,
       retain_until,backend_key,backend_id,target_key,accepted_spec_json)
      VALUES ('d1-source','d1-version','org-a','source-key','source-fp','create',1,
        'reconciling','unknown',1,'source-lease',?,? ,? ,? ,
        'source-backend-key','backend-a','target-a','{}')`,
      [
        nowMs + 60_000,
        new Date(nowMs).toISOString(),
        new Date(nowMs).toISOString(),
        new Date(nowMs + 86_400_000).toISOString(),
      ],
    );
    await sql.run(
      `INSERT INTO tf_v2_worker_native_effects
      (operation_id,resource_uid,principal,space,backend_key,backend_id,target_key,
       generation,native_identity,closure_digest,grant_lease_token,granted_at_ms,
       confirmed_receipt)
      VALUES ('d1-source','d1-version','org-a','production','source-backend-key',
        'backend-a','target-a',1,?,?,'source-lease',?,'etag-d1')`,
      [nativeIdentity, digest, nowMs],
    );
    await sql.run(`UPDATE tf_v2_operations SET status='succeeded',effect='complete',
      lease_token=NULL,lease_until_ms=NULL WHERE id='d1-source'`);
    await sql.run(
      `INSERT INTO tf_v2_operations
      (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,
       status,effect,dispatch_possible,lease_token,lease_until_ms,created_at,updated_at,
       retain_until,backend_key,backend_id,target_key,accepted_spec_json)
      VALUES ('d1-delete','d1-version','org-a','delete-key','delete-fp','delete',2,
        'reconciling','unknown',1,'delete-lease',?,? ,? ,? ,
        'delete-backend-key','backend-a','target-a','{}')`,
      [
        nowMs + 60_000,
        new Date(nowMs).toISOString(),
        new Date(nowMs).toISOString(),
        new Date(nowMs + 86_400_000).toISOString(),
      ],
    );
    await sql.run(`UPDATE tf_v2_resources SET generation=2,phase='deleting',
      last_operation='d1-delete',busy_operation='d1-delete' WHERE uid='d1-version'`);
    const execution: V2Execution = {
      operationId: "d1-delete",
      resourceUid: "d1-version",
      principal: "org-a",
      action: "delete",
      generation: 2,
      form: WORKER_VERSION_FORM_URL,
      space: "production",
      name: "version-a",
      spec: {},
      previousObserved: {},
      previousOutput: {},
      backendKey: "delete-backend-key",
      backendId: "backend-a",
      targetKey: "target-a",
      leaseToken: "delete-lease",
    };
    const custody = createV2NativeDeletionCustody({ sql });
    expect(await custody.stageNext(execution)).toBe("more");
    const item = await custody.next(execution);
    if (!item) throw new Error("missing D1 native deletion");
    expect(await custody.grant(item, "etag-d1")).toBe("granted");
    const other = createV2NativeDeletionCustody({ sql: createD1Sql(database) });
    expect(await other.grant(item, "etag-d1")).toBe("already_granted");
    expect(await other.confirmAbsent(item, "d1-owned-absence")).toBe(true);
    expect(await other.allAbsent(execution)).toBe(true);
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
