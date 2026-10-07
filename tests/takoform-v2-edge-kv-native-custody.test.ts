import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createV2EdgeKvNativeCustody } from "../src/takoform-v2/edge-kv-native-custody.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { EDGE_KV_NAMESPACE_FORM_URL } from "../src/takoform-v2/forms/edge-kv-namespace.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Execution } from "../src/takoform-v2/types.ts";

const TITLE = "takos-owned-kv-a";
const ID = "a".repeat(32);
const DIGEST = `sha256:${"b".repeat(64)}` as const;

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "v2-edge-kv-native-"));
  const path = join(directory, "state.sqlite");
  const db = new Database(path);
  migrateSqlite(db);
  const sql = createSqliteSql(db);
  let nowMs = Date.now();
  const now = () => new Date(nowMs);
  const engine = createTakoformV2Engine({
    sql,
    now,
    replayWindowSeconds: 3600,
    leaseMilliseconds: 60_000,
    authorize: async () => true,
    forms: {
      [EDGE_KV_NAMESPACE_FORM_URL]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "private-v2-wfp-edge-kv-namespace-v1",
          targetKey: "target-a",
          async execute() {
            return { kind: "unknown" as const };
          },
          async reconcile() {
            return { kind: "unknown" as const };
          },
        },
      },
    },
  });
  const store = createV2Store(sql);
  async function execution(operationId: string, leaseToken: string): Promise<V2Execution> {
    const op = await store.operation(operationId);
    const resource = op && (await store.resource(op.resource_uid));
    if (!op || !resource) throw new Error("missing accepted operation");
    expect(await store.claim(op.id, leaseToken, nowMs, nowMs + 60_000)).toBe(true);
    expect(await store.markDispatch(op.id, leaseToken, now().toISOString())).toBe(true);
    return {
      operationId: op.id,
      resourceUid: resource.uid,
      principal: op.principal,
      action: op.action,
      generation: op.generation,
      form: resource.form_url,
      space: resource.space,
      name: resource.name,
      spec: JSON.parse(op.accepted_spec_json),
      previousObserved: JSON.parse(resource.observed_json),
      previousOutput: JSON.parse(resource.output_json),
      backendKey: op.backend_key,
      backendId: op.backend_id,
      targetKey: op.target_key,
      leaseToken,
    };
  }
  async function settle(e: V2Execution) {
    expect(
      await store.settle({
        id: e.operationId,
        token: e.leaseToken,
        status: "succeeded",
        effect: "complete",
        at: now().toISOString(),
        retainUntil: new Date(nowMs + 86_400_000).toISOString(),
        observedJson: JSON.stringify({
          namespaceExists: true,
          maxKeyBytes: 467,
          maxValueBytes: 26_214_400,
          maxMetadataBytes: 1024,
          consistency: "eventual",
        }),
        outputJson: "{}",
      }),
    ).toBe(true);
    await sql.run(
      "UPDATE tf_v2_resources SET phase = 'idle', busy_operation = NULL, observed_generation = ? WHERE uid = ?",
      [e.generation, e.resourceUid],
    );
  }
  const accepted = await engine.acceptCreate({
    principal: "org-a",
    key: "create-edge-kv-native-0001",
    input: { form: EDGE_KV_NAMESPACE_FORM_URL, space: "production", name: "cache", spec: {} },
  });
  const create = await execution(accepted.id, "create-lease");
  return {
    directory,
    path,
    db,
    sql,
    engine,
    store,
    now,
    create,
    execution,
    settle,
    custody: createV2EdgeKvNativeCustody({ sql, now }),
    advance(ms: number) {
      nowMs += ms;
    },
    close() {
      db.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test("one CREATE grant survives duplicate/reopen; no-ID ACK loss never adopts title", async () => {
  const f = await fixture();
  const intent = { execution: f.create, plannedTitle: TITLE, closureDigest: DIGEST };
  const reopenedDb = new Database(f.path);
  const reopened = createV2EdgeKvNativeCustody({ sql: createSqliteSql(reopenedDb), now: f.now });
  try {
    expect(await f.custody.inspectCreate(intent)).toEqual({ kind: "never_granted" });
    expect(
      (await Promise.all([f.custody.grantCreate(intent), reopened.grantCreate(intent)])).sort(),
    ).toEqual(["already_granted", "granted"]);
    expect(await reopened.inspectCreate(intent)).toEqual({ kind: "sent" });
    expect(await reopened.grantCreate(intent)).toBe("already_granted");
    expect(await reopened.grantCreate({ ...intent, plannedTitle: "same-title-is-not-proof" })).toBe(
      "conflict",
    );
    expect(
      await reopened.acknowledgeCreate({
        ...intent,
        execution: { ...f.create, principal: "foreign-org" },
        nativeId: ID,
        receipt: "foreign-ack",
      }),
    ).toBe(false);
    expect(await reopened.confirmCreate({ ...intent, nativeId: ID, receipt: "get-id" })).toBe(
      false,
    );
    expect(
      await reopened.acknowledgeCreate({ ...intent, nativeId: ID, receipt: "create-ack" }),
    ).toBe(true);
    expect(await reopened.inspectCreate(intent)).toEqual({
      kind: "acknowledged",
      nativeId: ID,
      receipt: "create-ack",
    });
    expect(await reopened.confirmCreate({ ...intent, nativeId: ID, receipt: "get-id" })).toBe(true);
    expect(await f.custody.inspectCreate(intent)).toEqual({
      kind: "confirmed",
      nativeId: ID,
      receipt: "get-id",
    });
    expect(
      await reopened.acknowledgeCreate({ ...intent, nativeId: "c".repeat(32), receipt: "other" }),
    ).toBe(false);
  } finally {
    reopenedDb.close();
    f.close();
  }
});

test("confirmed exact ID survives same-spec UPDATE and DELETE one-send/absence proof", async () => {
  const f = await fixture();
  const intent = { execution: f.create, plannedTitle: TITLE, closureDigest: DIGEST };
  try {
    expect(await f.custody.grantCreate(intent)).toBe("granted");
    expect(await f.custody.acknowledgeCreate({ ...intent, nativeId: ID, receipt: "post-id" })).toBe(
      true,
    );
    expect(await f.custody.confirmCreate({ ...intent, nativeId: ID, receipt: "get-id" })).toBe(
      true,
    );
    await f.settle(f.create);
    const settledCreate = {
      targetKey: f.create.targetKey,
      principal: f.create.principal,
      space: f.create.space,
      resourceUid: f.create.resourceUid,
      generation: 1,
      sourceOperationId: f.create.operationId,
      backendId: f.create.backendId,
    };
    const expectedTarget = {
      nativeId: ID,
      plannedTitle: TITLE,
      closureDigest: DIGEST,
      sourceCreateOperationId: f.create.operationId,
      sourceCreateGeneration: 1,
      confirmedReceipt: "get-id",
    };
    expect(await f.custody.readSettledTarget(settledCreate)).toEqual(expectedTarget);
    expect(
      await f.custody.readSettledTarget({ ...settledCreate, principal: "foreign-org" }),
    ).toBeNull();
    const observedRow = (
      await f.sql.query("SELECT observed_json FROM tf_v2_resources WHERE uid = ?", [
        f.create.resourceUid,
      ])
    )[0];
    const originalObserved = observedRow?.observed_json;
    if (typeof originalObserved !== "string") throw new Error("missing observed projection");
    const extraObserved = JSON.stringify({ ...JSON.parse(originalObserved), foreign: true });
    await f.sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      extraObserved,
      f.create.resourceUid,
    ]);
    expect(await f.custody.readSettledTarget(settledCreate)).toBeNull();
    await f.sql.run("UPDATE tf_v2_operations SET result_observed_json = ? WHERE id = ?", [
      extraObserved,
      f.create.operationId,
    ]);
    expect(await f.custody.readSettledTarget(settledCreate)).toBeNull();
    await f.sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      originalObserved,
      f.create.resourceUid,
    ]);
    await f.sql.run(
      "UPDATE tf_v2_operations SET result_observed_json = ?, result_output_json = ? WHERE id = ?",
      [originalObserved, '{"foreign":true}', f.create.operationId],
    );
    expect(await f.custody.readSettledTarget(settledCreate)).toBeNull();
    await f.sql.run("UPDATE tf_v2_operations SET result_output_json = '{}' WHERE id = ?", [
      f.create.operationId,
    ]);
    expect(await f.custody.readSettledTarget(settledCreate)).toEqual(expectedTarget);
    const update = await f.engine.acceptUpdate({
      principal: "org-a",
      key: "update-edge-kv-native-0001",
      uid: f.create.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    const updateExecution = await f.execution(update.id, "update-lease");
    expect(await f.custody.readSettledTarget(settledCreate)).toBeNull();
    expect(await f.custody.confirmedForUpdate(updateExecution)).toEqual({
      nativeId: ID,
      plannedTitle: TITLE,
      closureDigest: DIGEST,
      sourceOperationId: f.create.operationId,
    });
    expect(await f.custody.confirmedForUpdate({ ...updateExecution, space: "other" })).toBeNull();
    await f.settle(updateExecution);
    expect(
      await f.custody.readSettledTarget({
        ...settledCreate,
        generation: 2,
        sourceOperationId: update.id,
      }),
    ).toEqual(expectedTarget);
    const deletion = await f.engine.acceptDelete({
      principal: "org-a",
      key: "delete-edge-kv-native-0001",
      uid: f.create.resourceUid,
      expectedGeneration: 2,
    });
    const deleteExecution = await f.execution(deletion.id, "delete-lease");
    const prepared = await f.custody.prepareDelete(deleteExecution);
    expect(prepared).toEqual({
      nativeId: ID,
      plannedTitle: TITLE,
      closureDigest: DIGEST,
      sourceOperationId: f.create.operationId,
    });
    if (!prepared) throw new Error("missing confirmed source");
    expect(await f.custody.inspectDelete(deleteExecution)).toEqual({ kind: "never_granted" });
    expect(
      await f.custody.grantDelete(deleteExecution, { ...prepared, nativeId: "c".repeat(32) }),
    ).toEqual({ kind: "conflict" });
    expect(await f.custody.inspectDelete(deleteExecution)).toEqual({ kind: "never_granted" });
    expect(await f.custody.grantDelete(deleteExecution, prepared)).toEqual({
      kind: "granted",
      nativeId: ID,
      plannedTitle: TITLE,
      closureDigest: DIGEST,
      sourceOperationId: f.create.operationId,
    });
    expect(await f.custody.grantDelete(deleteExecution, prepared)).toMatchObject({
      kind: "already_granted",
    });
    expect(await f.custody.inspectDelete(deleteExecution)).toEqual({ kind: "sent" });
    expect(await f.custody.acknowledgeDelete(deleteExecution, "delete-ack")).toBe(true);
    expect(await f.custody.confirmAbsent(deleteExecution, "get-absent")).toBe(true);
    expect(await f.custody.inspectDelete(deleteExecution)).toEqual({
      kind: "confirmed_absent",
      receipt: "get-absent",
    });
    expect(await f.custody.confirmAbsent(deleteExecution, "different-proof")).toBe(false);
  } finally {
    f.close();
  }
});

test("stale claim and foreign scope cannot mint native send or overwrite receipt", async () => {
  const f = await fixture();
  const intent = { execution: f.create, plannedTitle: TITLE, closureDigest: DIGEST };
  try {
    expect(
      await f.custody.grantCreate({ ...intent, execution: { ...f.create, principal: "other" } }),
    ).toBe("conflict");
    expect(
      await f.custody.grantCreate({ ...intent, execution: { ...f.create, space: "other" } }),
    ).toBe("conflict");
    expect(
      await f.custody.grantCreate({ ...intent, closureDigest: `sha256:${"F".repeat(64)}` }),
    ).toBe("conflict");
    await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms = ? WHERE id = ?", [
      Date.now() - 1000,
      f.create.operationId,
    ]);
    expect(await f.custody.grantCreate(intent)).toBe("conflict");
    expect(await f.sql.query("SELECT * FROM tf_v2_edge_kv_native_custody")).toHaveLength(0);
  } finally {
    f.close();
  }
});

test("DELETE cannot adopt a title or unconfirmed CREATE intent as a native namespace", async () => {
  const f = await fixture();
  const intent = { execution: f.create, plannedTitle: TITLE, closureDigest: DIGEST };
  try {
    expect(await f.custody.grantCreate(intent)).toBe("granted");
    expect(await f.custody.acknowledgeCreate({ ...intent, nativeId: ID, receipt: "post-id" })).toBe(
      true,
    );
    // The accepted Resource may not use a provider ID until exact-ID readback
    // has positively confirmed this CREATE lineage.
    await f.settle(f.create);
    const deletion = await f.engine.acceptDelete({
      principal: "org-a",
      key: "delete-unconfirmed-native-0001",
      uid: f.create.resourceUid,
      expectedGeneration: 1,
    });
    const execution = await f.execution(deletion.id, "delete-unconfirmed-lease");
    expect(await f.custody.prepareDelete(execution)).toBeNull();
    expect(
      await f.custody.grantDelete(execution, {
        nativeId: ID,
        plannedTitle: TITLE,
        closureDigest: DIGEST,
        sourceOperationId: f.create.operationId,
      }),
    ).toEqual({ kind: "conflict" });
    expect(await f.custody.inspectDelete(execution)).toEqual({ kind: "never_granted" });
  } finally {
    f.close();
  }
});

test("an exhausted claim cannot turn a persisted grant into a second send", async () => {
  const f = await fixture();
  const intent = { execution: f.create, plannedTitle: TITLE, closureDigest: DIGEST };
  try {
    expect(await f.custody.grantCreate(intent)).toBe("granted");
    await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms = ? WHERE id = ?", [
      Date.now() - 1000,
      f.create.operationId,
    ]);
    expect(await f.custody.grantCreate(intent)).toBe("conflict");
    expect(await f.custody.inspectCreate(intent)).toEqual({ kind: "sent" });
    const token = "reclaimed-lease";
    const at = Date.now();
    expect(await f.store.claim(f.create.operationId, token, at, at + 60_000)).toBe(true);
    const reclaimed = { ...intent, execution: { ...f.create, leaseToken: token } };
    expect(await f.custody.grantCreate(reclaimed)).toBe("already_granted");
    expect(await f.custody.inspectCreate(reclaimed)).toEqual({ kind: "sent" });
    expect(
      await f.custody.grantCreate({ ...reclaimed, closureDigest: `sha256:${"c".repeat(64)}` }),
    ).toBe("conflict");
  } finally {
    f.close();
  }
});

test("a grant committed before delayed SQL return does not authorize a late provider send", async () => {
  const f = await fixture();
  const intent = { execution: f.create, plannedTitle: TITLE, closureDigest: DIGEST };
  try {
    const sql: Sql = {
      query: f.sql.query,
      batch: f.sql.batch,
      async run(statement, params) {
        const result = await f.sql.run(statement, params);
        if (statement.startsWith("INSERT INTO tf_v2_edge_kv_native_custody")) {
          await f.sql.run("UPDATE tf_v2_operations SET lease_until_ms = ? WHERE id = ?", [
            Date.now() - 1000,
            f.create.operationId,
          ]);
        }
        return result;
      },
    };
    const delayed = createV2EdgeKvNativeCustody({ sql, now: f.now });
    expect(await delayed.grantCreate(intent)).toBe("conflict");
    expect(await f.custody.inspectCreate(intent)).toEqual({ kind: "sent" });
  } finally {
    f.close();
  }
});

test("0084 populated lineage forwards to 0085 without changing an old Resource or Operation", () => {
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS.filter(({ name }) => !name.startsWith("0085_")))
      db.exec(migration.sql);
    db.exec(`INSERT INTO tf_v2_resources
      (uid, principal, form_url, space, name, backend_id, target_key,
       active_name, generation, observed_generation, phase, spec_json, last_operation)
      VALUES ('old-resource','org-a','${EDGE_KV_NAMESPACE_FORM_URL}',
        'production','old-cache','private-v2-wfp-edge-kv-namespace-v1','target-a',
        'old-cache',1,0,'pending','{}','old-operation')`);
    db.exec(`INSERT INTO tf_v2_operations
      (id,resource_uid,principal,replay_key,request_fingerprint,action,generation,
       status,effect,created_at,updated_at,retain_until,backend_key,
       backend_id,target_key,accepted_spec_json)
      VALUES ('old-operation','old-resource','org-a','old-replay','old-fingerprint',
        'create',1,'queued','none','2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z','2027-01-01T00:00:00.000Z',
        'old-key','private-v2-wfp-edge-kv-namespace-v1','target-a','{}')`);
    const before = db.query("SELECT * FROM tf_v2_resources WHERE uid = 'old-resource'").get();
    const forward = MIGRATIONS.find(({ name }) => name.startsWith("0085_"));
    if (!forward) throw new Error("missing 0085");
    db.exec(forward.sql);
    expect(db.query("SELECT * FROM tf_v2_resources WHERE uid = 'old-resource'").get()).toEqual(
      before,
    );
    expect(db.query("SELECT COUNT(*) AS n FROM tf_v2_edge_kv_native_custody").get()).toEqual({
      n: 0,
    });
  } finally {
    db.close();
  }
});
