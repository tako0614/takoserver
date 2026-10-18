import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { readV2ConfiguredPrivateInputs } from "../src/takoform-v2/configured-private-inputs.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const TABLE = "tf_v2_operation_configured_private_inputs";
const TRIGGERS = [
  `${TABLE}_immutable_delete`,
  `${TABLE}_immutable_update`,
  `${TABLE}_insert_guard`,
];
const digest = (value: unknown) => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("predecessor row encoding is incomplete");
  return createHash("sha256").update(encoded).digest("hex");
};
const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
const statements = () =>
  frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql }));

function fixture() {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrateSqlite(database);
  return { database, sql: createSqliteSql(database) };
}

function checkpoint(database: Database) {
  const catalog = database
    .query("SELECT type, name, tbl_name, sql FROM sqlite_schema ORDER BY type, name")
    .all() as Array<{ type: string; name: string; tbl_name: string; sql: string | null }>;
  const tableList = database.query("PRAGMA table_list").all() as Array<{
    schema: string;
    name: string;
    wr: number;
  }>;
  const tables = catalog
    .filter((row) => row.type === "table")
    .map((row) => {
      const shape = tableList.find((table) => table.schema === "main" && table.name === row.name);
      if (!shape) throw new Error("predecessor table metadata is incomplete");
      const rows = database
        .query(
          shape.wr === 1
            ? `SELECT * FROM ${quoted(row.name)}`
            : `SELECT rowid AS __configured_update_rowid__, * FROM ${quoted(row.name)}`,
        )
        .all();
      return { name: row.name, count: rows.length, rowDigests: rows.map(digest).sort() };
    });
  return {
    catalog: catalog.map((row) => ({
      type: row.type,
      name: row.name,
      table: row.tbl_name,
      sqlDigest: row.sql === null ? null : digest(row.sql),
    })),
    tables,
  };
}

test("unnumbered configured UPDATE leaf has exact operation/resource FK scope and immutable guards", async () => {
  const f = fixture();
  try {
    const planned = statements();
    expect(planned.length).toBe(4);
    await f.sql.batch(planned);
    const columns = f.database.query(`PRAGMA table_info(${quoted(TABLE)})`).all() as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
    }>;
    expect(columns.map(({ name, type, notnull, pk }) => ({ name, type, notnull, pk }))).toEqual([
      { name: "operation_id", type: "TEXT", notnull: 1, pk: 1 },
      { name: "resource_uid", type: "TEXT", notnull: 1, pk: 0 },
      { name: "generation", type: "INTEGER", notnull: 1, pk: 0 },
      { name: "key_id", type: "TEXT", notnull: 1, pk: 0 },
      { name: "nonce", type: "TEXT", notnull: 1, pk: 0 },
      { name: "ciphertext", type: "TEXT", notnull: 1, pk: 0 },
    ]);
    const foreignKeys = f.database
      .query(`PRAGMA foreign_key_list(${quoted(TABLE)})`)
      .all() as Array<{
      from: string;
      table: string;
      to: string;
      on_update: string;
      on_delete: string;
    }>;
    expect(
      foreignKeys
        .map(({ from, table, to, on_update, on_delete }) => ({
          from,
          table,
          to,
          on_update,
          on_delete,
        }))
        .sort((a, b) => a.from.localeCompare(b.from)),
    ).toEqual([
      {
        from: "operation_id",
        table: "tf_v2_operations",
        to: "id",
        on_update: "NO ACTION",
        on_delete: "NO ACTION",
      },
      {
        from: "resource_uid",
        table: "tf_v2_resources",
        to: "uid",
        on_update: "NO ACTION",
        on_delete: "NO ACTION",
      },
    ]);
    const triggers = f.database
      .query("SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? ORDER BY name")
      .all(TABLE) as Array<{ name: string }>;
    expect(triggers.map((row) => row.name)).toEqual(TRIGGERS);
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("unnumbered leaf adds only its own objects and preserves the complete current predecessor", async () => {
  const f = fixture();
  try {
    const before = checkpoint(f.database);
    const oldNames = new Set(before.catalog.map((row) => row.name));
    expect(before.catalog.some((row) => row.name === TABLE || TRIGGERS.includes(row.name))).toBe(
      false,
    );
    await f.sql.batch(statements());
    const after = checkpoint(f.database);
    expect(after.catalog.filter((row) => oldNames.has(row.name))).toEqual(before.catalog);
    expect(after.tables.filter((row) => row.name !== TABLE)).toEqual(before.tables);
    const additions = after.catalog.filter((row) => !oldNames.has(row.name));
    expect(additions.filter((row) => row.type === "table").map((row) => row.name)).toEqual([TABLE]);
    expect(additions.filter((row) => row.type === "trigger").map((row) => row.name)).toEqual(
      TRIGGERS,
    );
    expect(additions.every((row) => row.table === TABLE)).toBe(true);
    expect(additions.filter((row) => row.type === "index").length).toBe(1);
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    f.database.close();
  }
});

// Portable storage fixture: these opaque strings are ciphertext DATA only,
// not an authority, registered schema, physical target or native qualification.
async function acceptanceFixture(mode: "positive" | "late-fault") {
  const f = fixture();
  const formUrl = "https://forms.example.test/ConfiguredUpdateLeaf/1.0.0";
  const material = Object.freeze({
    keyId: "fixture-key",
    nonce: "fixture-nonce",
    ciphertext: "fixture-update",
  });
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const comparison = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  f.database.exec(
    "CREATE TABLE fixture_configured_update_late_fault (must_follow_history TEXT NOT NULL)",
  );
  let armed = false;
  let positiveRead = false;
  const sql: Sql = {
    ...f.sql,
    async batch(coreStatements) {
      if (!armed) return f.sql.batch(coreStatements);
      const historyIndex = coreStatements.findIndex((statement) =>
        statement.sql.startsWith(`INSERT INTO ${TABLE}\n`),
      );
      expect(historyIndex).toBeGreaterThan(0);
      const history = coreStatements[historyIndex];
      if (!history || history.params?.length !== 6)
        throw new Error("missing fixed Core UPDATE history statement");
      const params = history.params;
      const [operationId, resourceUid, generation, keyId, nonce, ciphertext] = params;
      const selected = `SELECT history.operation_id, history.resource_uid, history.generation,
          history.key_id, history.nonce, history.ciphertext
        FROM tf_v2_operation_configured_private_inputs history
        JOIN tf_v2_operations op ON op.id = history.operation_id
        JOIN tf_v2_resources resource ON resource.uid = history.resource_uid
        WHERE history.operation_id = ? AND history.resource_uid = ? AND history.generation = ?
          AND history.key_id = ? AND history.nonce = ? AND history.ciphertext = ?
          AND op.resource_uid = history.resource_uid AND op.generation = history.generation
          AND op.action = 'update' AND op.status = 'queued' AND op.private_inputs_present = 1
          AND resource.generation = op.generation AND resource.last_operation = op.id
          AND resource.busy_operation = op.id AND resource.principal = op.principal
          AND resource.backend_id = op.backend_id AND resource.target_key = op.target_key
          AND resource.deleted_at IS NULL`;
      const leaf = statements();
      const read: SqlStatement = { sql: selected, params };
      const lateFault: SqlStatement = {
        sql: `INSERT INTO fixture_configured_update_late_fault (must_follow_history)
          SELECT NULL WHERE EXISTS (${selected}) AND
            (SELECT COUNT(*) FROM sqlite_schema WHERE type = 'trigger' AND tbl_name =
              'tf_v2_operation_configured_private_inputs' AND name IN (
                'tf_v2_operation_configured_private_inputs_insert_guard',
                'tf_v2_operation_configured_private_inputs_immutable_update',
                'tf_v2_operation_configured_private_inputs_immutable_delete')) = 3`,
        params,
      };
      // Same exact Core statements and final read in both controls. Only the
      // final conditional NOT NULL fault is added in the rollback control.
      const writes = await f.sql.batch([
        ...leaf,
        ...coreStatements,
        read,
        ...(mode === "late-fault" ? [lateFault] : []),
      ]);
      expect(writes[leaf.length + coreStatements.length]?.rows).toEqual([
        {
          operation_id: operationId,
          resource_uid: resourceUid,
          generation,
          key_id: keyId,
          nonce,
          ciphertext,
        },
      ]);
      positiveRead = true;
      return writes.slice(leaf.length, leaf.length + coreStatements.length);
    },
  };
  const form: V2Form = {
    validateCreate() {},
    validateUpdate() {},
    references() {
      return [];
    },
    privateInputs: {
      validateCreate() {},
      validateUpdate() {},
      async prepareCreate() {
        return {
          keyId: "fixture-key",
          nonce: "fixture-create-nonce",
          ciphertext: "fixture-create",
        };
      },
      async prepareUpdate() {
        return material;
      },
    },
    backend: {
      id: "configured-leaf-fixture",
      targetKey: "configured-leaf-target",
      async execute() {
        return { kind: "complete", observed: {}, output: {} };
      },
      async reconcile() {
        return { kind: "complete", observed: {}, output: {} };
      },
    },
  };
  const engine = createTakoformV2Engine({
    sql,
    forms: { [formUrl]: form },
    replayWindowSeconds: 300,
    now: () => new Date("2026-10-18T00:00:00.000Z"),
    privateInputCustody: {
      transfer: { current: { id: "fixture-transfer", key: aes } },
      comparison: { current: { id: "fixture-comparison", key: comparison } },
      transferTtlSeconds: 300,
    },
    authorize: async () => true,
  });
  const created = await engine.acceptCreate({
    principal: "org:fixture",
    key: "leaf-create-fixture-0001",
    input: {
      form: formUrl,
      space: "fixture",
      name: "resource",
      spec: {},
      privateInputs: { secret: "fixture-initial" },
    },
  });
  expect(await engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
  const identity = {
    principal: "org:fixture",
    form: formUrl,
    space: "fixture",
    name: "resource",
    resourceUid: created.resourceUid,
  };
  return {
    ...f,
    identity,
    material,
    positiveRead: () => positiveRead,
    update() {
      armed = true;
      return engine.acceptUpdate({
        principal: identity.principal,
        key: "leaf-update-fixture-0001",
        uid: created.resourceUid,
        expectedGeneration: 1,
        spec: {},
        privateInputs: { secret: "fixture-updated" },
      });
    },
  };
}

test("successful same-batch leaf/history read precedes unique late fault and complete DDL/data rollback", async () => {
  // The positive control must finish before a fresh rollback fixture is used.
  for (const mode of ["positive", "late-fault"] as const) {
    const f = await acceptanceFixture(mode);
    try {
      const before = checkpoint(f.database);
      expect(before.catalog.some((row) => row.name === TABLE || TRIGGERS.includes(row.name))).toBe(
        false,
      );
      if (mode === "positive") {
        const updated = await f.update();
        expect(updated.status).toBe("queued");
        expect(f.positiveRead()).toBe(true);
        expect(
          await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
            operationId: updated.id,
            generation: 2,
          }),
        ).toEqual(f.material);
        expect(
          f.database
            .query(
              "SELECT name FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = ? ORDER BY name",
            )
            .all(TABLE),
        ).toEqual(TRIGGERS.map((name) => ({ name })));
        expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      } else {
        let failure: unknown;
        try {
          await f.update();
        } catch (error) {
          failure = error;
        }
        expect(failure instanceof SqlError).toBe(true);
        expect(failure).toMatchObject({ code: "constraint" });
        expect(failure instanceof Error && failure.message).toBe(
          "NOT NULL constraint failed: fixture_configured_update_late_fault.must_follow_history",
        );
        // The final failure can occur only after all leaf objects and the exact
        // accepted history/Operation/Resource join are present in that batch.
        expect(checkpoint(f.database)).toEqual(before);
        expect(
          f.database.query("SELECT COUNT(*) AS n FROM sqlite_schema WHERE tbl_name = ?").get(TABLE),
        ).toEqual({ n: 0 });
        expect(
          f.database.query("SELECT COUNT(*) AS n FROM fixture_configured_update_late_fault").get(),
        ).toEqual({ n: 0 });
      }
    } finally {
      f.database.close();
    }
  }
});
