import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import {
  createV2FinalDeleteConfiguredUpdateDiscard,
  createV2RetiredConfiguredUpdateDiscard,
  type V2FinalDeleteConfiguredUpdateInput,
} from "../src/takoform-v2/configured-private-inputs.ts";
import {
  additiveV2ConfiguredUpdateInputsDDL,
  v2ConfiguredUpdateDiscardTransition,
  v2FinalDeleteConfiguredUpdateDiscardSchema,
  v2FinalDeleteConfiguredUpdateDiscardTransition,
} from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Execution, V2Form } from "../src/takoform-v2/types.ts";

// Storage/helper contract only: the verifier below is an explicit fixture,
// not a Native retirement producer. No Core/OCI consumer is connected here.
const TABLE = "tf_v2_operation_configured_private_inputs";
const GATE = "tf_v2_configured_update_discard_gate";
const FORM = "https://example.invalid/NONSECRET-final-delete/1.0.0/";
async function fixture(expanded = true) {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys=ON");
  migrateSqlite(database); // only this new owned in-memory database
  const sql = createSqliteSql(database);
  await sql.batch(
    frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
  );
  await sql.batch(v2ConfiguredUpdateDiscardTransition());
  if (expanded) await sql.batch(v2FinalDeleteConfiguredUpdateDiscardTransition());
  const key = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0x31),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  const comparison = await crypto.subtle.importKey(
    "raw",
    new Uint8Array(32).fill(0x32),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
  let onDelete: ((execution: V2Execution) => Promise<void>) | undefined;
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    references: () => [],
    privateInputs: {
      validateCreate() {},
      validateUpdate() {},
      async prepareCreate(input) {
        return { keyId: "NONSECRET", nonce: "fixture", ciphertext: `opaque-${input.generation}` };
      },
      async prepareUpdate(input) {
        return { keyId: "NONSECRET", nonce: "fixture", ciphertext: `opaque-${input.generation}` };
      },
    },
    backend: {
      id: "NONSECRET-final-delete",
      targetKey: "NONSECRET-target",
      async execute(execution) {
        if (execution.action === "delete") {
          await onDelete?.(execution);
          return { kind: "unknown" };
        }
        return { kind: "complete", observed: {}, output: {} };
      },
      async reconcile() {
        return { kind: "unknown" };
      },
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    forms: { [FORM]: form },
    replayWindowSeconds: 300,
    authorize: async () => true,
    privateInputCustody: {
      transfer: { current: { id: "NONSECRET-transfer", key } },
      comparison: { current: { id: "NONSECRET-comparison", key: comparison } },
      transferTtlSeconds: 300,
    },
  });
  const created = await engine.acceptCreate({
    principal: "NONSECRET-principal",
    key: "NONSECRET-create",
    input: {
      form: FORM,
      name: "resource",
      space: "space",
      spec: {},
      privateInputs: { VALUE: "fixture" },
    },
  });
  expect(await engine.runNext()).toMatchObject({ status: "succeeded" });
  const updates: Awaited<ReturnType<typeof engine.acceptUpdate>>[] = [];
  for (let generation = 2; generation <= 3; generation++) {
    const update = await engine.acceptUpdate({
      principal: "NONSECRET-principal",
      key: `NONSECRET-update-${generation}`,
      uid: created.resourceUid,
      expectedGeneration: generation - 1,
      spec: {},
      privateInputs: { VALUE: "fixture" },
    });
    expect(await engine.runNext()).toMatchObject({ id: update.id, status: "succeeded" });
    updates.push(update);
  }
  const original = (index: number) => {
    const operation = updates[index];
    if (!operation) throw Error("fixture original update absent");
    return {
      principal: "NONSECRET-principal",
      space: "space",
      name: "resource",
      form: FORM,
      resourceUid: created.resourceUid,
      backendId: form.backend.id,
      targetKey: form.backend.targetKey,
      operationId: operation.id,
      generation: index + 2,
    };
  };
  const materials = () => database.query(`SELECT * FROM ${TABLE} ORDER BY generation`).all();
  return {
    database,
    sql,
    engine,
    original,
    materials,
    async deleting(use: (input: V2FinalDeleteConfiguredUpdateInput) => Promise<void>) {
      let callbackFailed = false,
        callbackFailure: unknown;
      onDelete = async (execution) => {
        try {
          await use({
            ...original(1),
            deleteOperationId: execution.operationId,
            deleteGeneration: execution.generation,
            leaseToken: execution.leaseToken,
          });
        } catch (error) {
          callbackFailed = true;
          callbackFailure = error;
          throw error;
        }
      };
      await engine.acceptDelete({
        principal: "NONSECRET-principal",
        key: "NONSECRET-delete",
        uid: created.resourceUid,
        expectedGeneration: 3,
      });
      let result: Awaited<ReturnType<typeof engine.runNext>>;
      try {
        result = await engine.runNext();
      } catch (error) {
        if (callbackFailed) throw callbackFailure; // includes throw undefined
        throw error;
      }
      if (callbackFailed) throw callbackFailure;
      expect(result).toMatchObject({ status: "reconciling", effect: "unknown" });
    },
  };
}

const observed = <T>(promise: Promise<T>) =>
  promise.then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );

test("configured-final-delete exact forward shape removes latest and older UPDATE only after verifier in actual DELETE lease", async () => {
  const f = await fixture();
  try {
    expect(f.database.query("SELECT sql FROM sqlite_schema WHERE name=?").get(GATE)).toEqual({
      sql: v2FinalDeleteConfiguredUpdateDiscardSchema.gate,
    });
    let calls = 0;
    const discard = createV2FinalDeleteConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired(input, signal) {
        expect(signal.aborted).toBe(false);
        expect(input.deleteGeneration).toBe(4);
        calls++;
      },
    });
    await f.deleting(async (input) => {
      await discard.discard(input, new AbortController().signal);
      expect(f.materials()).toHaveLength(1);
      await discard.discard({ ...input, ...f.original(0) }, new AbortController().signal);
    });
    expect(calls).toBe(2);
    expect(f.materials()).toEqual([]);
    expect(f.database.query(`SELECT * FROM ${GATE}`).all()).toEqual([]);
    expect(f.database.query("SELECT * FROM tf_v2_configured_private_inputs").all()).toHaveLength(1); // existing CREATE finalizer is separate
    expect(f.database.query("SELECT phase,deleted_at FROM tf_v2_resources").get()).toEqual({
      phase: "deleting",
      deleted_at: null,
    });
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.database.close();
  }
});

for (const expanded of [false, true])
  test(`configured-final-delete preserves superseded helper contract on ${expanded ? "expanded" : "old"} shape`, async () => {
    const f = await fixture(expanded);
    try {
      const discard = createV2RetiredConfiguredUpdateDiscard({
        sql: f.sql,
        async assertRetired() {},
      });
      await discard.discard(f.original(0));
      const before = f.materials();
      expect(await observed(discard.discard(f.original(1)))).toHaveProperty("error");
      expect(f.materials()).toEqual(before);
      expect(before).toHaveLength(1);
    } finally {
      f.database.close();
    }
  });

test("configured-final-delete old shape refuses new purpose before verifier or data mutation", async () => {
  const f = await fixture(false);
  try {
    const before = f.materials();
    let calls = 0;
    const discard = createV2FinalDeleteConfiguredUpdateDiscard({
      sql: f.sql,
      async assertRetired() {
        calls++;
      },
    });
    await f.deleting(async (input) => {
      expect(await observed(discard.discard(input, new AbortController().signal))).toHaveProperty(
        "error",
      );
    });
    expect(calls).toBe(0);
    expect(f.materials()).toEqual(before);
  } finally {
    f.database.close();
  }
});

for (const fault of [
  "verifier",
  "cancel",
  "lease",
  "foreign-operation",
  "foreign-material",
  "schema-drift",
] as const)
  test(`configured-final-delete rejects ${fault} without discarding original material`, async () => {
    const f = await fixture();
    try {
      const before = f.materials(),
        controller = new AbortController();
      let calls = 0;
      const discard = createV2FinalDeleteConfiguredUpdateDiscard({
        sql: f.sql,
        async assertRetired(input) {
          calls++;
          if (fault === "verifier") throw Error("NONSECRET retirement unknown");
          if (fault === "cancel") controller.abort();
          if (fault === "lease")
            await f.sql.run("UPDATE tf_v2_operations SET lease_token=? WHERE id=?", [
              "NONSECRET-replaced",
              input.deleteOperationId,
            ]);
          if (fault === "schema-drift") {
            f.database.exec(`DROP TRIGGER tf_v2_configured_update_discard_gate_insert_guard`);
            f.database.exec(
              `CREATE TRIGGER tf_v2_configured_update_discard_gate_insert_guard BEFORE INSERT ON ${GATE} BEGIN SELECT 1; END`,
            );
          }
        },
      });
      await f.deleting(async (input) => {
        const candidate = {
          ...input,
          ...(fault === "foreign-operation" ? { deleteOperationId: "NONSECRET-foreign" } : {}),
          ...(fault === "foreign-material" ? { resourceUid: "NONSECRET-foreign" } : {}),
        };
        expect(await observed(discard.discard(candidate, controller.signal))).toHaveProperty(
          "error",
        );
      });
      expect(calls).toBe(1);
      expect(f.materials()).toEqual(before);
      expect(f.database.query(`SELECT * FROM ${GATE}`).all()).toEqual([]);
    } finally {
      f.database.close();
    }
  });

for (const fault of ["foreign-guard", "pending-gate"] as const)
  test(`configured-final-delete transition preserves data and predecessor on ${fault}`, async () => {
    const f = await fixture(false);
    try {
      if (fault === "foreign-guard") {
        f.database.exec(`DROP TRIGGER tf_v2_configured_update_discard_gate_insert_guard`);
        f.database.exec(
          `CREATE TRIGGER tf_v2_configured_update_discard_gate_insert_guard BEFORE INSERT ON ${GATE} BEGIN SELECT 1; END`,
        );
      } else {
        const input = f.original(0);
        await f.sql.run(
          `INSERT INTO ${GATE}(operation_id,resource_uid,generation,principal,space,name,form_url,backend_id,target_key) VALUES (?,?,?,?,?,?,?,?,?)`,
          [
            input.operationId,
            input.resourceUid,
            input.generation,
            input.principal,
            input.space,
            input.name,
            input.form,
            input.backendId,
            input.targetKey,
          ],
        );
      }
      const before = f.materials(),
        gate = f.database.query(`SELECT * FROM ${GATE}`).all();
      const schema = f.database
        .query("SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name")
        .all();
      expect(
        await observed(f.sql.batch(v2FinalDeleteConfiguredUpdateDiscardTransition())),
      ).toHaveProperty("error");
      expect(
        f.database.query("SELECT name,type,tbl_name,sql FROM sqlite_schema ORDER BY name").all(),
      ).toEqual(schema);
      expect(f.materials()).toEqual(before);
      expect(f.database.query(`SELECT * FROM ${GATE}`).all()).toEqual(gate);
    } finally {
      f.database.close();
    }
  });

test("configured-final-delete lost batch ACK stays rejected after actual commit without retry", async () => {
  const f = await fixture();
  try {
    let calls = 0,
      batches = 0;
    const original = f.sql.batch.bind(f.sql);
    const discard = createV2FinalDeleteConfiguredUpdateDiscard({
      sql: {
        ...f.sql,
        async batch(statements) {
          batches++;
          await original(statements); // genuine atomic commit, only receipt lost
          throw Error("NONSECRET lost SQL receipt");
        },
      },
      async assertRetired() {
        calls++;
      },
    });
    await f.deleting(async (input) => {
      expect(await observed(discard.discard(input, new AbortController().signal))).toHaveProperty(
        "error",
      );
    });
    expect(calls).toBe(1);
    expect(batches).toBe(1);
    expect(f.materials()).toHaveLength(1);
    expect(f.database.query(`SELECT * FROM ${GATE}`).all()).toEqual([]);
    expect(f.database.query("SELECT phase,deleted_at FROM tf_v2_resources").get()).toEqual({
      phase: "deleting",
      deleted_at: null,
    });
  } finally {
    f.database.close();
  }
});

test("configured-final-delete captures exact caller identity before its first awaited read", async () => {
  const f = await fixture();
  try {
    let candidate: V2FinalDeleteConfiguredUpdateInput | undefined,
      captured = false;
    const original = f.sql.query.bind(f.sql);
    const discard = createV2FinalDeleteConfiguredUpdateDiscard({
      sql: {
        ...f.sql,
        async query(sql, params) {
          const rows = await original(sql, params);
          if (candidate)
            Object.assign(candidate, {
              resourceUid: "NONSECRET-foreign",
              leaseToken: "NONSECRET-foreign",
            });
          return rows;
        },
      },
      async assertRetired(input) {
        expect(input.resourceUid).toBe(f.original(1).resourceUid);
        expect(input.leaseToken).not.toBe("NONSECRET-foreign");
        expect(Object.isFrozen(input)).toBe(true);
        captured = true;
      },
    });
    await f.deleting(async (input) => {
      candidate = { ...input };
      await discard.discard(candidate, new AbortController().signal);
    });
    expect(captured).toBe(true);
    expect(f.materials()).toHaveLength(1);
  } finally {
    f.database.close();
  }
});

test("configured-final-delete fixture propagates callback failure through real Engine UNKNOWN including undefined", async () => {
  for (const failure of [Error("NONSECRET original assertion failure"), undefined]) {
    const f = await fixture();
    try {
      const result = await observed(
        f.deleting(async () => {
          throw failure;
        }),
      );
      expect(result).toHaveProperty("error");
      if (!("error" in result)) throw Error("fixture lost original callback failure");
      expect(result.error).toBe(failure);
    } finally {
      f.database.close();
    }
  }
});
