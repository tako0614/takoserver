import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { type Row, type Sql, SqlError, type SqlParam } from "../src/ports.ts";
import { createD1Sql, type D1StatementLike } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import {
  readV2ConfiguredPrivateInputs,
  type V2ConfiguredPrivateInputs,
} from "../src/takoform-v2/configured-private-inputs.ts";
import { additiveV2ConfiguredUpdateInputsDDL } from "../src/takoform-v2/configured-update-inputs-schema.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import { createV2Store } from "../src/takoform-v2/store.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const FORM = "https://forms.example.test/ConfiguredUpdateFixture/1.0.0";
const TABLE = "tf_v2_operation_configured_private_inputs";
const PRINCIPAL = "org:fixture";

const digest = (value: unknown) => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("predecessor row encoding is incomplete");
  return createHash("sha256").update(encoded).digest("hex");
};
const quoted = (value: string) => `"${value.replaceAll('"', '""')}"`;
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

// Real D1 adapter and atomic SQLite SQL, without a provider/runtime dependency.
// This exercises the D1 batch contract; it is not live D1 qualification.
function d1Shape(database: Database) {
  type Statement = D1StatementLike & { text: string; values: readonly SqlParam[] };
  const execute = (statement: Statement) => {
    expect(statement.values.length).toBeLessThanOrEqual(100);
    const results = database
      .query(statement.text)
      .all(
        ...statement.values.map((value) =>
          value instanceof ArrayBuffer ? new Uint8Array(value) : value,
        ),
      ) as Row[];
    const { changes } = database.query("SELECT changes() AS changes").get() as { changes: number };
    return { results, meta: { changes } };
  };
  const prepare = (text: string, values: readonly SqlParam[] = []): Statement => ({
    text,
    values,
    bind(...params) {
      return prepare(text, params);
    },
    async all() {
      return execute(this);
    },
  });
  return createD1Sql({
    prepare,
    async batch(statements) {
      database.exec("BEGIN IMMEDIATE");
      try {
        const result = statements.map((statement) => execute(statement as Statement));
        database.exec("COMMIT");
        return result;
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
  });
}

async function fixture(
  options: { oldSchema?: boolean; sql?: (sql: Sql, database: Database) => Sql } = {},
) {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  migrateSqlite(database);
  const base = createSqliteSql(database);
  if (!options.oldSchema) {
    await base.batch(
      frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
    );
  }
  const sql = options.sql?.(base, database) ?? base;
  const aes = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  const comparison = await crypto.subtle.generateKey({ name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
  const prepared = new Map<string, V2ConfiguredPrivateInputs>();
  const preparedFor = (operationId: string): V2ConfiguredPrivateInputs => {
    const material = prepared.get(operationId);
    if (material === undefined) throw new Error("missing prepared fixture material");
    return material;
  };
  const seenConfigured: Array<V2ConfiguredPrivateInputs | null> = [];
  const state: {
    mode: "rotate" | "void" | "invalid";
    invalid?: unknown;
    beforeUpdate?: () => Promise<void>;
    beforeAdmission?: () => Promise<void>;
    permitted: boolean;
    unknown: boolean;
    nowMs: number;
  } = { mode: "rotate", permitted: true, unknown: false, nowMs: Date.now() };
  const encode = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
  const seal = async (input: {
    principal: string;
    space: string;
    name: string;
    form: string;
    resourceUid: string;
    operationId: string;
    generation: number;
    privateInputs: Readonly<Record<string, string>> | undefined;
  }) => {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const aad = new TextEncoder().encode(
      JSON.stringify([
        input.principal,
        input.space,
        input.name,
        input.form,
        input.resourceUid,
        input.operationId,
        input.generation,
        "configured-fixture",
        "configured-target",
      ]),
    );
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, additionalData: aad },
      aes,
      new TextEncoder().encode(JSON.stringify(input.privateInputs)),
    );
    const value = {
      keyId: "fixture-key",
      nonce: encode(iv),
      ciphertext: encode(new Uint8Array(ciphertext)),
    };
    prepared.set(input.operationId, value);
    return value;
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
      prepareCreate: seal,
      async prepareUpdate(input) {
        seenConfigured.push(input.configured);
        await state.beforeUpdate?.();
        if (state.mode === "void") return;
        if (state.mode === "invalid") return state.invalid as V2ConfiguredPrivateInputs;
        return seal(input);
      },
    },
    async prepareAdmission(input) {
      if (input.action === "update") await state.beforeAdmission?.();
      return { sql: state.permitted ? "1" : "0", params: [] };
    },
    backend: {
      id: "configured-fixture",
      targetKey: "configured-target",
      async execute() {
        if (state.unknown)
          return { kind: "unknown", code: "fixture_unknown", message: "Synthetic unknown" };
        return { kind: "complete", observed: { ready: true }, output: {} };
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
    now: () => new Date(state.nowMs),
    leaseMilliseconds: 1,
    privateInputCustody: {
      transfer: { current: { id: "transfer-fixture", key: aes } },
      comparison: { current: { id: "comparison-fixture", key: comparison } },
      transferTtlSeconds: 300,
    },
    authorize: async () => true,
  });
  const created = await engine.acceptCreate({
    principal: PRINCIPAL,
    key: "configured-create-00001",
    input: {
      form: FORM,
      space: "fixture",
      name: "resource",
      spec: {},
      privateInputs: { password: "synthetic-initial" },
    },
  });
  expect(await engine.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
  const identity = {
    principal: PRINCIPAL,
    space: "fixture",
    name: "resource",
    form: FORM,
    resourceUid: created.resourceUid,
  };
  const update = (
    key = "configured-update-00001",
    generation = 1,
    privateInputs: Readonly<Record<string, string>> | undefined = { password: "synthetic-rotated" },
  ) =>
    engine.acceptUpdate({
      principal: PRINCIPAL,
      key,
      uid: created.resourceUid,
      expectedGeneration: generation,
      spec: {},
      ...(privateInputs === undefined ? {} : { privateInputs }),
    });
  return {
    database,
    sql,
    engine,
    created,
    identity,
    update,
    prepared,
    preparedFor,
    seenConfigured,
    state,
  };
}

test("accepted UPDATE retains exact operation ciphertext without replacing stable CREATE custody", async () => {
  const f = await fixture();
  try {
    const updated = await f.update();
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: updated.id,
        generation: 2,
      }),
    ).toEqual(f.preparedFor(updated.id));
    expect(await readV2ConfiguredPrivateInputs(f.sql, f.identity)).toEqual(
      f.preparedFor(f.created.id),
    );
    expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 1 });
    const publicValues = JSON.stringify([
      updated,
      await f.engine.getOperation({ principal: PRINCIPAL, id: updated.id }),
      await f.engine.getResource({ principal: PRINCIPAL, uid: f.created.resourceUid }),
    ]);
    expect(publicValues).not.toContain("synthetic-rotated");
    expect(publicValues).not.toContain(f.preparedFor(updated.id).ciphertext);
    expect(publicValues).not.toContain("fixture-key");
  } finally {
    f.database.close();
  }
});

test("void hooks work on the old schema without any UPDATE-history access", async () => {
  const statements: string[] = [];
  const f = await fixture({
    oldSchema: true,
    sql: (base) => ({
      query(sql, params) {
        statements.push(sql);
        return base.query(sql, params);
      },
      run(sql, params) {
        statements.push(sql);
        return base.run(sql, params);
      },
      batch(batch) {
        statements.push(...batch.map((item) => item.sql));
        return base.batch(batch);
      },
    }),
  });
  try {
    f.state.mode = "void";
    const updated = await f.update();
    expect(await f.engine.runNext()).toMatchObject({ id: updated.id, status: "succeeded" });
    expect(f.seenConfigured).toEqual([f.preparedFor(f.created.id)]);
    expect(statements.some((sql) => sql.includes(TABLE))).toBe(false);
    expect(await readV2ConfiguredPrivateInputs(f.sql, f.identity)).toEqual(
      f.preparedFor(f.created.id),
    );
  } finally {
    f.database.close();
  }
});

for (const adapter of ["sqlite", "d1-batch-shape"] as const) {
  test(`${adapter}: old schema opt-in and insert faults roll back all acceptance writes`, async () => {
    for (const oldSchema of [true, false]) {
      const f = await fixture({
        oldSchema,
        ...(adapter === "d1-batch-shape" ? { sql: (_base: Sql, db: Database) => d1Shape(db) } : {}),
      });
      try {
        if (!oldSchema)
          f.database.exec(
            `CREATE TRIGGER fixture_custody_fault BEFORE INSERT ON ${TABLE} BEGIN SELECT RAISE(ABORT, 'fixture fault'); END;`,
          );
        await expect(f.update()).rejects.toThrow();
        expect(
          f.database
            .query("SELECT generation, busy_operation, last_operation FROM tf_v2_resources")
            .get(),
        ).toEqual({ generation: 1, busy_operation: null, last_operation: f.created.id });
        for (const table of [
          "tf_v2_operations",
          "tf_v2_private_inputs",
          "tf_v2_operation_reference_sets",
        ])
          expect(f.database.query(`SELECT COUNT(*) AS n FROM ${table}`).get()).toEqual({ n: 1 });
        if (!oldSchema)
          expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 0 });
      } finally {
        f.database.close();
      }
    }
  });

  test(`${adapter}: committed UPDATE with lost ACK replays the winning ciphertext once`, async () => {
    let lost = false;
    const f = await fixture({
      sql: (base, db) => {
        const actual = adapter === "d1-batch-shape" ? d1Shape(db) : base;
        return {
          ...actual,
          async batch(statements) {
            const writes = await actual.batch(statements);
            if (
              !lost &&
              statements.some((statement) => statement.sql.includes(`INSERT INTO ${TABLE}`))
            ) {
              lost = true;
              throw new Error("synthetic lost ACK after commit");
            }
            return writes;
          },
        };
      },
    });
    try {
      const winner = await f.update();
      expect(lost).toBe(true);
      f.state.beforeUpdate = async () => {
        throw new Error("replay must not prepare again");
      };
      expect(await f.update()).toMatchObject({ id: winner.id });
      expect(f.prepared.size).toBe(2);
      expect(
        await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
          operationId: winner.id,
          generation: 2,
        }),
      ).toEqual(f.preparedFor(winner.id));
      expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 1 });
    } finally {
      f.database.close();
    }
  });
}

test("concurrent prepared candidates commit only the accepted winner's material", async () => {
  const f = await fixture();
  try {
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.state.beforeUpdate = async () => {
      if (++arrivals === 2) release();
      await barrier;
    };
    const candidates = await Promise.allSettled([
      f.update("concurrent-update-00001"),
      f.update("concurrent-update-00002"),
    ]);
    const winners = candidates.flatMap((item) => (item.status === "fulfilled" ? [item.value] : []));
    expect(winners).toHaveLength(1);
    expect(candidates.filter((item) => item.status === "rejected")).toHaveLength(1);
    const winner = winners[0];
    if (!winner) throw new Error("missing winner");
    expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 1 });
    for (const id of f.prepared.keys()) {
      if (id !== f.created.id)
        expect(
          await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
            operationId: id,
            generation: 2,
          }),
        ).toEqual(id === winner.id ? f.preparedFor(id) : null);
    }
  } finally {
    f.database.close();
  }
});

test("configured CREATE CAS, failed admission, and mutable hook results cannot substitute custody", async () => {
  const f = await fixture();
  try {
    f.state.permitted = false;
    await expect(f.update("admission-refused-00001")).rejects.toMatchObject({
      code: "dependency_conflict",
    });
    expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 0 });
    f.state.permitted = true;
    let expected: V2ConfiguredPrivateInputs | undefined;
    f.state.beforeAdmission = async () => {
      const returned = [...f.prepared.values()].at(-1);
      if (!returned) throw new Error("missing prepared material");
      expected = { ...returned };
      (returned as { ciphertext: string }).ciphertext = "mutated-after-hook";
    };
    const winner = await f.update("snapshot-update-000001");
    if (expected === undefined) throw new Error("missing prepared fixture snapshot");
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: winner.id,
        generation: 2,
      }),
    ).toEqual(expected);
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded" });
    f.state.beforeAdmission = async () => {
      f.database.exec("DROP TRIGGER tf_v2_configured_private_immutable");
      f.database.exec(
        "UPDATE tf_v2_configured_private_inputs SET ciphertext = 'synthetic-raced-row'",
      );
    };
    await expect(f.update("cas-refused-update-0001", 2)).rejects.toMatchObject({
      code: "generation_conflict",
    });
    expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 1 });
  } finally {
    f.database.close();
  }
});

test("malformed or source-free opaque returns fail before acceptance without defining Form omission", async () => {
  const f = await fixture();
  try {
    f.state.mode = "invalid";
    for (const invalid of [
      null,
      false,
      {},
      { keyId: 4, nonce: "n", ciphertext: "c" },
      { keyId: "k", nonce: "", ciphertext: "c" },
    ]) {
      f.state.invalid = invalid;
      await expect(f.update()).rejects.toThrow("invalid configured private input preparation");
    }
    f.state.invalid = { keyId: "k", nonce: "n", ciphertext: "c" };
    await expect(
      f.engine.acceptUpdate({
        principal: PRINCIPAL,
        key: "omitted-inputs-0000001",
        uid: f.created.resourceUid,
        expectedGeneration: 1,
        spec: {},
      }),
    ).rejects.toThrow("invalid configured private input preparation");
    expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 0 });
    expect(f.database.query("SELECT generation FROM tf_v2_resources").get()).toEqual({
      generation: 1,
    });
  } finally {
    f.database.close();
  }
});

test("exact identity and selector mismatches refuse without CREATE/latest fallback", async () => {
  const f = await fixture();
  try {
    const updated = await f.update();
    const selector = { operationId: updated.id, generation: 2 };
    for (const name of ["principal", "space", "name", "form", "resourceUid"] as const)
      expect(
        await readV2ConfiguredPrivateInputs(f.sql, { ...f.identity, [name]: "foreign" }, selector),
      ).toBeNull();
    for (const wrong of [
      { operationId: f.created.id, generation: 1 },
      { operationId: updated.id, generation: 3 },
      { operationId: "missing", generation: 2 },
    ])
      expect(await readV2ConfiguredPrivateInputs(f.sql, f.identity, wrong)).toBeNull();
    for (const malformed of [
      null,
      {},
      { operationId: updated.id },
      { operationId: "", generation: 2 },
      { operationId: updated.id, generation: NaN },
    ])
      await expect(
        readV2ConfiguredPrivateInputs(f.sql, f.identity, malformed as typeof selector),
      ).rejects.toThrow("invalid configured private input operation selector");
  } finally {
    f.database.close();
  }
});

test("markDispatch erases only transfer; exact UPDATE history survives recovery and later generations", async () => {
  const f = await fixture();
  try {
    const updated = await f.update();
    const store = createV2Store(f.sql);
    expect(
      await store.claim(updated.id, "fixture-claim", f.state.nowMs, f.state.nowMs + 10_000),
    ).toBe(true);
    expect(
      await store.markDispatch(updated.id, "fixture-claim", new Date(f.state.nowMs).toISOString()),
    ).toBe(true);
    expect(
      f.database
        .query("SELECT transfer_ciphertext FROM tf_v2_private_inputs WHERE operation_id = ?")
        .get(updated.id),
    ).toEqual({ transfer_ciphertext: null });
    expect(
      await readV2ConfiguredPrivateInputs(createSqliteSql(f.database), f.identity, {
        operationId: updated.id,
        generation: 2,
      }),
    ).toEqual(f.preparedFor(updated.id));
    f.state.nowMs += 20_000;
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded" });
    const later = await f.update("later-generation-00001", 2);
    f.state.unknown = true;
    expect(await f.engine.runNext()).toMatchObject({ status: "reconciling" });
    f.state.nowMs += 400_000;
    for (const [id, generation] of [
      [updated.id, 2],
      [later.id, 3],
    ] as const)
      expect(
        await readV2ConfiguredPrivateInputs(f.sql, f.identity, { operationId: id, generation }),
      ).toEqual(f.preparedFor(id));
    expect(f.seenConfigured).toEqual([f.preparedFor(f.created.id), f.preparedFor(f.created.id)]);
  } finally {
    f.database.close();
  }
});

test("immutable history rejects UPDATE/DELETE/REPLACE and survives actual soft deletion/name reuse", async () => {
  const f = await fixture();
  try {
    const updated = await f.update();
    f.database.exec("PRAGMA recursive_triggers = OFF");
    const before = f.database.query(`SELECT * FROM ${TABLE}`).get();
    expect(() => f.database.exec(`UPDATE ${TABLE} SET ciphertext = 'replaced'`)).toThrow(
      "immutable",
    );
    expect(() => f.database.exec(`DELETE FROM ${TABLE}`)).toThrow("immutable");
    expect(() =>
      f.database.exec(
        `INSERT OR REPLACE INTO ${TABLE} SELECT operation_id, resource_uid, generation, key_id, nonce, 'replaced' FROM ${TABLE}`,
      ),
    ).toThrow();
    expect(f.database.query(`SELECT * FROM ${TABLE}`).get()).toEqual(before);
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded" });
    const deleted = await f.engine.acceptDelete({
      principal: PRINCIPAL,
      key: "delete-retain-00000001",
      uid: f.created.resourceUid,
      expectedGeneration: 2,
    });
    expect(await f.engine.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
    expect(await readV2ConfiguredPrivateInputs(f.sql, f.identity)).toBeNull();
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: updated.id,
        generation: 2,
      }),
    ).toEqual(f.preparedFor(updated.id));
    const replacement = await f.engine.acceptCreate({
      principal: PRINCIPAL,
      key: "recreate-retain-000001",
      input: {
        form: FORM,
        space: "fixture",
        name: "resource",
        spec: {},
        privateInputs: { password: "synthetic-new-owner" },
      },
    });
    expect(replacement.resourceUid).not.toBe(f.created.resourceUid);
    expect(
      await readV2ConfiguredPrivateInputs(
        f.sql,
        { ...f.identity, resourceUid: replacement.resourceUid },
        { operationId: updated.id, generation: 2 },
      ),
    ).toBeNull();
    expect(() =>
      f.database.query("DELETE FROM tf_v2_operations WHERE id = ?").run(updated.id),
    ).toThrow();
    expect(() =>
      f.database.query("DELETE FROM tf_v2_resources WHERE uid = ?").run(f.created.resourceUid),
    ).toThrow();
    expect(f.database.query(`SELECT * FROM ${TABLE}`).get()).toEqual(before);
  } finally {
    f.database.close();
  }
});

test("unnumbered leaf expands the populated current predecessor without changing its existing rows or schema", async () => {
  const f = await fixture({ oldSchema: true });
  try {
    const tables = [
      "tf_v2_resources",
      "tf_v2_operations",
      "tf_v2_private_inputs",
      "tf_v2_configured_private_inputs",
      "tf_v2_operation_reference_sets",
    ];
    const before = tables.map((table) => f.database.query(`SELECT * FROM ${table}`).all());
    const catalog = () =>
      f.database
        .query("SELECT name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY name")
        .all()
        .map((row) => {
          const value = row as { name: string; sql: string };
          return {
            name: value.name,
            sqlDigest: createHash("sha256").update(value.sql).digest("hex"),
          };
        });
    const schema = catalog();
    await f.sql.batch(
      frameHostMigrationSql(additiveV2ConfiguredUpdateInputsDDL).map((sql) => ({ sql })),
    );
    expect(tables.map((table) => f.database.query(`SELECT * FROM ${table}`).all())).toEqual(before);
    const names = new Set(schema.map((row) => (row as { name: string }).name));
    expect(catalog().filter((row) => names.has(row.name))).toEqual(schema);
    expect(f.database.query("PRAGMA foreign_key_check").all()).toEqual([]);
    const updated = await f.update();
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: updated.id,
        generation: 2,
      }),
    ).toEqual(f.preparedFor(updated.id));
  } finally {
    f.database.close();
  }
});

test("insert guards bind actual accepted identity; later void UPDATE has no history fallback", async () => {
  const f = await fixture();
  try {
    const first = await f.update();
    expect(await f.engine.runNext()).toMatchObject({ status: "succeeded" });
    f.state.mode = "void";
    const current = await f.update("void-after-optin-00001", 2);
    const insert = f.database.query(
      `INSERT INTO ${TABLE} (operation_id, resource_uid, generation, key_id, nonce, ciphertext) VALUES (?, ?, ?, 'k', 'n', 'c')`,
    );
    for (const [id, uid, generation] of [
      [f.created.id, f.created.resourceUid, 1],
      ["unaccepted", f.created.resourceUid, 3],
      [current.id, "foreign-uid", 3],
      [current.id, f.created.resourceUid, 4],
    ] as const)
      expect(() => insert.run(id, uid, generation)).toThrow();
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: current.id,
        generation: 3,
      }),
    ).toBeNull();
    expect(
      await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
        operationId: first.id,
        generation: 2,
      }),
    ).toEqual(f.preparedFor(first.id));
    expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 1 });
    expect(f.seenConfigured).toEqual([f.preparedFor(f.created.id), f.preparedFor(f.created.id)]);
  } finally {
    f.database.close();
  }
});

test("explicit UPDATE material fails atomically without the unregistered leaf while void UPDATE remains usable", async () => {
  const f = await fixture({ oldSchema: true });
  try {
    const before = {
      resource: await f.sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [
        f.created.resourceUid,
      ]),
      operations: await f.sql.query("SELECT * FROM tf_v2_operations ORDER BY id"),
      stable: await readV2ConfiguredPrivateInputs(f.sql, f.identity),
    };
    const completeBefore = checkpoint(f.database);
    let failure: unknown;
    try {
      await f.update();
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof SqlError).toBe(true);
    expect(failure).toMatchObject({ code: "unavailable" });
    expect(failure instanceof Error && failure.message).toBe(
      "no such table: tf_v2_operation_configured_private_inputs",
    );
    expect(checkpoint(f.database)).toEqual(completeBefore);
    expect({
      resource: await f.sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [
        f.created.resourceUid,
      ]),
      operations: await f.sql.query("SELECT * FROM tf_v2_operations ORDER BY id"),
      stable: await readV2ConfiguredPrivateInputs(f.sql, f.identity),
    }).toEqual(before);
    expect(
      f.database
        .query("SELECT COUNT(*) AS n FROM sqlite_schema WHERE type = 'table' AND name = ?")
        .get(TABLE),
    ).toEqual({ n: 0 });
    f.state.mode = "void";
    const accepted = await f.update("void-after-absent-0001");
    expect(accepted.status).toBe("queued");
    expect(await f.engine.runNext()).toMatchObject({ id: accepted.id, status: "succeeded" });
    expect(await readV2ConfiguredPrivateInputs(f.sql, f.identity)).toEqual(before.stable);
  } finally {
    f.database.close();
  }
});

test("selected UPDATE requires its exact history postimage after CAS and preserves complete state on custody faults", async () => {
  for (const fault of ["operation", "generation", "current-owner"] as const) {
    let armed = false;
    const f = await fixture({
      sql: (base) => ({
        ...base,
        batch(statements) {
          return base.batch(
            statements.map((statement) => {
              if (!armed) return statement;
              if (fault === "current-owner") {
                if (
                  !statement.sql.startsWith("INSERT INTO tf_v2_operations\n") ||
                  !statement.sql.endsWith("WHERE changes() = 1")
                )
                  return statement;
                const params = [...(statement.params ?? [])];
                // Counterfactual fixed-statement bindings disagree with the
                // retained Resource. Neither SQL nor a successful CAS may turn
                // that missing exact postimage into a silent zero-row receipt.
                params[6] = "foreign-target";
                params[18] = "foreign-target";
                return { sql: statement.sql, params };
              }
              if (!statement.sql.startsWith(`INSERT INTO ${TABLE}\n`)) return statement;
              const params = [...(statement.params ?? [])];
              if (fault === "operation") params[0] = "unaccepted-operation";
              if (fault === "generation") params[2] = 99;
              return { sql: statement.sql, params };
            }),
          );
        },
      }),
    });
    try {
      const before = checkpoint(f.database);
      armed = true;
      let failure: unknown;
      try {
        await f.update();
      } catch (error) {
        failure = error;
      }
      expect(failure instanceof SqlError).toBe(true);
      expect(failure).toMatchObject({ code: "constraint" });
      expect(
        failure instanceof Error &&
          (fault === "current-owner"
            ? // The false exact-postimage CASE supplies a NULL Operation id.
              // The retained predecessor CHECK requires last_operation_id;
              // identify that actual guard, not an assumed NN error or full
              // driver message representation. Full-state and positive-control
              // assertions below remain required for this one changed binding.
              /^CHECK constraint failed:/u.test(failure.message) &&
              /\blast_operation_id\s+IS\s+NOT\s+NULL\b/iu.test(failure.message)
            : failure.message === "invalid accepted UPDATE configured private input custody"),
      ).toBe(true);
      expect(checkpoint(f.database)).toEqual(before);
      expect(f.database.query(`SELECT COUNT(*) AS n FROM ${TABLE}`).get()).toEqual({ n: 0 });
      armed = false;
      const updated = await f.update("after-custody-fault-0001");
      expect(updated.status).toBe("queued");
      expect(
        await readV2ConfiguredPrivateInputs(f.sql, f.identity, {
          operationId: updated.id,
          generation: 2,
        }),
      ).toEqual(f.preparedFor(updated.id));
    } finally {
      f.database.close();
    }
  }
});
