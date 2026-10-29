import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import {
  createV2RetiredConfiguredUpdateDiscard,
  readV2ConfiguredPrivateInputs,
} from "../src/takoform-v2/configured-private-inputs.ts";
import {
  additiveV2ConfiguredUpdateInputsDDL,
  v2ConfiguredUpdateDiscardTransition,
} from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/RetiredConfiguredUpdate/1.0.0";
const TABLE = "tf_v2_operation_configured_private_inputs";
const PRINCIPAL = "org:fixture";

function custodyDigest(database: Database): string {
  const rows = [
    database.query(`SELECT * FROM ${TABLE} ORDER BY generation, operation_id`).all(),
    database.query("SELECT * FROM tf_v2_configured_private_inputs ORDER BY resource_uid").all(),
    database
      .query(
        "SELECT uid, generation, observed_generation, last_operation, busy_operation, deleted_at FROM tf_v2_resources ORDER BY uid",
      )
      .all(),
    database
      .query("SELECT id, generation, status, effect FROM tf_v2_operations ORDER BY generation, id")
      .all(),
  ];
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

async function acceptedPair(f: Awaited<ReturnType<typeof fixture>>) {
  const old = await f.update();
  expect(await f.engine.runNext()).toMatchObject({ id: old.id, status: "succeeded" });
  const latest = await f.update();
  expect(await f.engine.runNext()).toMatchObject({ id: latest.id, status: "succeeded" });
  return { old, latest };
}

async function fixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrateSqlite(database);
  const sql = createSqliteSql(database);
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((statement) => ({
      sql: statement,
    })),
  );
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const comparison = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  let effect: "complete" | "no_effect" = "complete";
  const seal = (generation: number) => ({
    keyId: "fixture-key",
    nonce: `fixture-nonce-${generation}`,
    ciphertext: `fixture-ciphertext-${generation}`,
  });
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    references() {
      return [];
    },
    privateInputs: {
      validateCreate() {},
      validateUpdate() {},
      async prepareCreate(input) {
        return seal(input.generation);
      },
      async prepareUpdate(input) {
        return seal(input.generation);
      },
    },
    backend: {
      id: "discard-fixture-backend",
      targetKey: "discard-fixture-target",
      async execute() {
        return effect === "no_effect"
          ? { kind: "no_effect", code: "fixture_failed", message: "synthetic" }
          : { kind: "complete", observed: { ready: true }, output: {} };
      },
      async reconcile() {
        return { kind: "complete", observed: { ready: true }, output: {} };
      },
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    forms: { [FORM]: form },
    replayWindowSeconds: 300,
    privateInputCustody: {
      transfer: { current: { id: "transfer-fixture", key: aes } },
      comparison: { current: { id: "comparison-fixture", key: comparison } },
      transferTtlSeconds: 300,
    },
    authorize: async () => true,
  });
  const created = await engine.acceptCreate({
    principal: PRINCIPAL,
    key: "discard-create-fixture-0001",
    input: {
      form: FORM,
      space: "fixture",
      name: "resource",
      spec: {},
      privateInputs: { secret: "synthetic" },
    },
  });
  expect(await engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
  const identity = {
    principal: PRINCIPAL,
    space: "fixture",
    name: "resource",
    form: FORM,
    resourceUid: created.resourceUid,
    backendId: form.backend.id,
    targetKey: form.backend.targetKey,
  };
  let generation = 1;
  let updateCount = 0;
  return {
    database,
    sql,
    engine,
    created,
    identity,
    setEffect(value: "complete" | "no_effect") {
      effect = value;
    },
    async update() {
      updateCount++;
      const updated = await engine.acceptUpdate({
        principal: PRINCIPAL,
        key: `discard-update-fixture-${updateCount.toString().padStart(4, "0")}`,
        uid: created.resourceUid,
        expectedGeneration: generation,
        spec: {},
        privateInputs: { secret: "synthetic" },
      });
      generation++;
      return updated;
    },
  };
}

test("retired older UPDATE ciphertext has a guarded removal path", async () => {
  const f = await fixture();
  try {
    const { old, latest } = await acceptedPair(f);
    const original = await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
      operationId: old.id,
      generation: 2,
    });
    expect(original).not.toBeNull();
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    const discard = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired(input) {
        expect(input.resourceUid).toBe(f.created.resourceUid);
        expect(input.generation).toBe(2);
      },
    });
    await discard.discard({ ...f.identity, operationId: old.id, generation: 2 });
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: old.id,
        generation: 2,
      }),
    ).toBeNull();
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: latest.id,
        generation: 3,
      }),
    ).not.toBeNull();
    expect(await readV2ConfiguredPrivateInputs(f.sql, f.identity)).not.toBeNull();
    expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 1 });
    expect(
      f.database.query("SELECT COUNT(*) AS n FROM tf_v2_configured_update_discard_gate").get(),
    ).toEqual({ n: 0 });
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("older UPDATE retirement after actual soft DELETE still requires the native verifier", async () => {
  const f = await fixture();
  try {
    const { old, latest } = await acceptedPair(f);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "discard-delete-fixture-0001",
      uid: f.created.resourceUid,
      expectedGeneration: 3,
    });
    expect(await f.engine.runNext()).toMatchObject({
      id: deleted.id,
      status: "succeeded",
      effect: "complete",
    });
    const resource = f.database
      .query("SELECT deleted_at FROM tf_v2_resources WHERE uid = ?")
      .get(f.created.resourceUid) as { deleted_at: string | null };
    expect(resource.deleted_at).not.toBeNull();
    const input = { ...f.identity, operationId: old.id, generation: 2 };
    const before = custodyDigest(f.database);
    const unverified = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired() {
        throw new Error("retirement unavailable");
      },
    });
    await expect(unverified.discard(input)).rejects.toThrow();
    expect(custodyDigest(f.database)).toBe(before);
    let verified = 0;
    const discard = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired(candidate) {
        expect(candidate.resourceUid).toBe(f.created.resourceUid);
        verified++;
      },
    });
    await expect(
      discard.discard({ ...f.identity, operationId: latest.id, generation: 3 }),
    ).rejects.toThrow();
    expect(custodyDigest(f.database)).toBe(before);
    await discard.discard(input);
    expect(verified).toBe(2);
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: old.id,
        generation: 2,
      }),
    ).toBeNull();
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: latest.id,
        generation: 3,
      }),
    ).not.toBeNull();
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("transition preserves 0081 and old material, rejects broad DELETE and repeat application", async () => {
  const f = await fixture();
  try {
    await acceptedPair(f);
    const before = custodyDigest(f.database);
    const createSql = f.database
      .query("SELECT sql FROM sqlite_schema WHERE name = 'tf_v2_configured_private_delete_guard'")
      .get() as { sql: string };
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    expect(custodyDigest(f.database)).toBe(before);
    expect(
      f.database
        .query("SELECT sql FROM sqlite_schema WHERE name = 'tf_v2_configured_private_delete_guard'")
        .get(),
    ).toEqual(createSql);
    expect(() => f.database.exec(`DELETE FROM ${TABLE}`)).toThrow();
    expect(custodyDigest(f.database)).toBe(before);
    await expect(f.sql.batch(v2ConfiguredUpdateDiscardTransition())).rejects.toThrow();
    expect(custodyDigest(f.database)).toBe(before);
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("unknown, missing or ambiguous retirement and caller-minted result do not touch SQL custody", async () => {
  const f = await fixture();
  try {
    const { old } = await acceptedPair(f);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    const before = custodyDigest(f.database);
    for (const reason of ["unknown", "missing", "ambiguous", "still-serving"]) {
      let called = 0;
      const discard = createV2RetiredConfiguredUpdateDiscard({
        sql: f.sql,
        async assertRetired(input) {
          called++;
          expect(Object.isFrozen(input)).toBe(true);
          expect(input).toEqual({ ...f.identity, operationId: old.id, generation: 2 });
          throw new Error(reason);
        },
      });
      await expect(
        discard.discard({ ...f.identity, operationId: old.id, generation: 2 }),
      ).rejects.toThrow();
      expect(called).toBe(1);
      expect(custodyDigest(f.database)).toBe(before);
    }
    const forged = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired() {
        return true as never;
      },
    });
    await expect(
      forged.discard({ ...f.identity, operationId: old.id, generation: 2 }),
    ).rejects.toThrow();
    expect(custodyDigest(f.database)).toBe(before);
  } finally {
    f.database.close();
  }
});

test("wrong accepted identity and missing material are zero-effect rejects", async () => {
  const f = await fixture();
  try {
    const { old, latest } = await acceptedPair(f);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    const before = custodyDigest(f.database);
    const discard = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired() {},
    });
    const valid = { ...f.identity, operationId: old.id, generation: 2 };
    const wrong = [
      { ...valid, principal: "org:other" },
      { ...valid, space: "other" },
      { ...valid, name: "other" },
      { ...valid, form: "https://forms.example.test/Other/1.0.0" },
      { ...valid, resourceUid: "other-uid" },
      { ...valid, backendId: "other-backend" },
      { ...valid, targetKey: "other-target" },
      { ...valid, operationId: latest.id },
      { ...valid, operationId: "missing-operation" },
      { ...valid, generation: 3 },
      { ...valid, generation: Number.MAX_SAFE_INTEGER + 1 },
      { ...valid, generation: 1 },
      { ...valid, retirementLease: "caller-made" },
    ];
    for (const input of wrong) {
      await expect(discard.discard(input)).rejects.toThrow();
      expect(custodyDigest(f.database)).toBe(before);
    }
  } finally {
    f.database.close();
  }
});

test("latest accepted failed PUT map and still-observed generation remain retained", async () => {
  const f = await fixture();
  try {
    const old = await f.update();
    expect(await f.engine.runNext()).toMatchObject({ id: old.id, status: "succeeded" });
    const latest = await f.update();
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    const discard = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired() {},
    });
    const beforePending = custodyDigest(f.database);
    await expect(
      discard.discard({ ...f.identity, operationId: old.id, generation: 2 }),
    ).rejects.toThrow();
    expect(custodyDigest(f.database)).toBe(beforePending);
    f.setEffect("no_effect");
    expect(await f.engine.runNext()).toMatchObject({
      id: latest.id,
      status: "failed",
      effect: "none",
    });
    const beforeFailed = custodyDigest(f.database);
    for (const [operationId, generation] of [
      [old.id, 2],
      [latest.id, 3],
    ] as const) {
      await expect(discard.discard({ ...f.identity, operationId, generation })).rejects.toThrow();
      expect(custodyDigest(f.database)).toBe(beforeFailed);
    }
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: latest.id,
        generation: 3,
      }),
    ).not.toBeNull();
  } finally {
    f.database.close();
  }
});

test("older retired ciphertext can be removed while a newer failed PUT map stays exact", async () => {
  const f = await fixture();
  try {
    const { old, latest: serving } = await acceptedPair(f);
    const failed = await f.update();
    f.setEffect("no_effect");
    expect(await f.engine.runNext()).toMatchObject({
      id: failed.id,
      status: "failed",
      effect: "none",
    });
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    const discard = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired() {},
    });
    await discard.discard({ ...f.identity, operationId: old.id, generation: 2 });
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: old.id,
        generation: 2,
      }),
    ).toBeNull();
    for (const [operationId, generation] of [
      [serving.id, 3],
      [failed.id, 4],
    ] as const)
      expect(
        await readV2ConfiguredPrivateInputs(f.sql, f.identity, { operationId, generation }),
      ).not.toBeNull();
    expect(await readV2ConfiguredPrivateInputs(f.sql, f.identity)).not.toBeNull();
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("post-verifier currentness drift and late transaction fault preserve all ciphertext", async () => {
  const f = await fixture();
  try {
    const { old, latest } = await acceptedPair(f);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    const caller = { ...f.identity, operationId: old.id, generation: 2 };
    const drifted = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired(input) {
        caller.operationId = latest.id;
        f.database
          .query("UPDATE tf_v2_resources SET observed_generation = 2 WHERE uid = ?")
          .run(f.created.resourceUid);
        expect(input.operationId).toBe(old.id);
      },
    });
    const afterDrift = custodyDigest(f.database);
    await expect(drifted.discard(caller)).rejects.toThrow();
    expect(custodyDigest(f.database)).not.toBe(afterDrift);
    expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 2 });
    f.database
      .query("UPDATE tf_v2_resources SET observed_generation = 3 WHERE uid = ?")
      .run(f.created.resourceUid);
    f.database.exec("CREATE TABLE fixture_discard_late_fault (value TEXT NOT NULL)");
    const beforeFault = custodyDigest(f.database);
    const lateFaultSql: Sql = {
      ...f.sql,
      batch(statements) {
        return f.sql.batch([
          ...statements,
          { sql: "INSERT INTO fixture_discard_late_fault (value) VALUES (NULL)" },
        ]);
      },
    };
    const lateFault = createV2RetiredConfiguredUpdateDiscard({
      sql: lateFaultSql,
      async assertRetired() {},
    });
    await expect(
      lateFault.discard({ ...f.identity, operationId: old.id, generation: 2 }),
    ).rejects.toThrow();
    expect(custodyDigest(f.database)).toBe(beforeFault);
    expect(
      f.database.query("SELECT COUNT(*) AS n FROM tf_v2_configured_update_discard_gate").get(),
    ).toEqual({ n: 0 });
  } finally {
    f.database.close();
  }
});

test("a zero-row DELETE leaves the gate and rolls the whole batch back", async () => {
  const f = await fixture();
  try {
    const { old } = await acceptedPair(f);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    const before = custodyDigest(f.database);
    let guardSql = "";
    const zeroDeleteSql: Sql = {
      ...f.sql,
      batch(statements) {
        guardSql = statements[2]?.sql ?? "";
        return f.sql.batch(
          statements.map((statement, index) =>
            index === 1 ? { ...statement, sql: `${statement.sql} AND 0` } : statement,
          ),
        );
      },
    };
    const discard = createV2RetiredConfiguredUpdateDiscard({
      sql: zeroDeleteSql,
      async assertRetired() {},
    });
    await expect(
      discard.discard({ ...f.identity, operationId: old.id, generation: 2 }),
    ).rejects.toThrow();
    expect(guardSql).not.toContain("changes()");
    expect(custodyDigest(f.database)).toBe(before);
    expect(
      f.database.query("SELECT COUNT(*) AS n FROM tf_v2_configured_update_discard_gate").get(),
    ).toEqual({ n: 0 });
  } finally {
    f.database.close();
  }
});

test("missing or drifted successor schema rejects before native verifier", async () => {
  const f = await fixture();
  try {
    const { old } = await acceptedPair(f);
    let called = 0;
    const discard = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired() {
        called++;
      },
    });
    const input = { ...f.identity, operationId: old.id, generation: 2 };
    const before = custodyDigest(f.database);
    await expect(discard.discard(input)).rejects.toThrow();
    expect(called).toBe(0);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    f.database.exec("DROP TRIGGER tf_v2_operation_configured_private_inputs_discard_consume");
    await expect(discard.discard(input)).rejects.toThrow();
    expect(called).toBe(0);
    expect(custodyDigest(f.database)).toBe(before);
  } finally {
    f.database.close();
  }
});

test("post-verifier schema drift cannot bypass the exact guarded batch", async () => {
  const f = await fixture();
  try {
    const { old } = await acceptedPair(f);
    await f.sql.batch(v2ConfiguredUpdateDiscardTransition());
    const before = custodyDigest(f.database);
    const discard = createV2RetiredConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired() {
        f.database.exec("DROP TRIGGER tf_v2_operation_configured_private_inputs_discard_consume");
      },
    });
    await expect(
      discard.discard({ ...f.identity, operationId: old.id, generation: 2 }),
    ).rejects.toThrow();
    expect(custodyDigest(f.database)).toBe(before);
    expect(
      f.database.query("SELECT COUNT(*) AS n FROM tf_v2_configured_update_discard_gate").get(),
    ).toEqual({ n: 0 });
  } finally {
    f.database.close();
  }
});

test("a changed immutable predecessor cannot be replaced by the transition", async () => {
  const f = await fixture();
  try {
    const { old } = await acceptedPair(f);
    f.database.exec("DROP TRIGGER tf_v2_operation_configured_private_inputs_immutable_delete");
    f.database.exec(`CREATE TRIGGER tf_v2_operation_configured_private_inputs_immutable_delete
      BEFORE DELETE ON ${TABLE} BEGIN SELECT RAISE(ABORT, 'other guard'); END`);
    const before = custodyDigest(f.database);
    const catalog = f.database
      .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
      .all();
    await expect(f.sql.batch(v2ConfiguredUpdateDiscardTransition())).rejects.toThrow();
    expect(custodyDigest(f.database)).toBe(before);
    expect(
      f.database
        .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
        .all(),
    ).toEqual(catalog);
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: old.id,
        generation: 2,
      }),
    ).not.toBeNull();
  } finally {
    f.database.close();
  }
});
