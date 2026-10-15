import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { DatabaseSync, constants as SQLITE } from "node:sqlite";
import { prepareMigrationSql, prepareNativeMigrationSql } from "../src/sqlite-migration-policy.ts";
import {
  SQLITE_MIGRATION_APPLICATION_FORM_URL,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0,
  sqliteMigrationApplicationReferences,
} from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { createSQLiteMigrationApplicationNativePort } from "../src/takoform-v2/forms/sqlite-migration-application-native.ts";
import type { SQLiteMigrationRecord } from "../src/takoform-v2/forms/sqlite-migration-application-port.ts";
import {
  SQLITE_MIGRATION_SET_FORM_URL,
  SQLITE_MIGRATION_SET_FORM_URL_0_3_0,
  SQLITE_MIGRATION_SET_FORM_URL_0_4_0,
} from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import corpus from "./fixtures/sqlite-migration-pragma-040-cases.json";

const LEDGER = "_takoform_sqlite_migrations";
const CASES = corpus.cases as readonly {
  readonly id: string;
  readonly sql: string;
  readonly allowed: boolean;
  readonly setupSql?: string;
}[];

// The owner requires adapters to bind its fixture-only ledger identity to their
// genuine protected ledger, including autoindex/dynamic metadata arguments.
// This is test-vector adaptation, never a production migration SQL rewrite.
const fixtureSql = (sql: string) => sql.replaceAll(corpus.ledgerTable, LEDGER);

function snapshot(database: DatabaseSync): string {
  const schema = database
    .prepare("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY name")
    .all();
  const tables = database
    .prepare("SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name")
    .all();
  const rows = tables.map(({ name }) => {
    if (typeof name !== "string") throw new Error("fixture table name missing");
    const quoted = `"${name.replaceAll('"', '""')}"`;
    return { name, rows: database.prepare(`SELECT * FROM ${quoted}`).all() };
  });
  return JSON.stringify({ schema, rows });
}

function fixture(setup = "", form: string = SQLITE_MIGRATION_APPLICATION_FORM_URL) {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    database.exec(corpus.setupSql);
    database.exec(`CREATE TABLE ${LEDGER} (
    sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 512),
    path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
    operation_id TEXT NOT NULL
  )`);
    if (setup) database.exec(fixtureSql(setup));
  } catch (error) {
    database.close();
    throw error;
  }
  const port = createSQLiteMigrationApplicationNativePort({
    async withAuthorizedDatabase(input) {
      if (!(await input.stillAuthorized())) throw new Error("fixture authority lost");
      return input.use(database);
    },
  });
  const apply = async (sql: string, expectedPrefix: readonly SQLiteMigrationRecord[] = []) => {
    const bytes = new TextEncoder().encode(sql);
    return port.withAuthorizedMigrationSession({
      resourceUid: "staging-introspection-database",
      execution: {
        operationId: "staging-introspection-operation",
        leaseToken: "staging-introspection-lease",
        backendKey: "staging-introspection-backend",
        backendId: "selfhost-v2-sqlite-migration-application-native-v1",
        targetKey: "staging-introspection-target",
        resourceUid: "staging-introspection-application",
        principal: "staging-introspection-owner",
        action: "create",
        generation: 1,
        form,
        space: "staging-introspection",
        name: "staging-introspection",
        spec: {},
      },
      stillAuthorized: async () => true,
      use: async (session) =>
        session.applyOneHeldFile({
          sequence: expectedPrefix.length + 1,
          expectedPrefix,
          entry: {
            path: `staging/${expectedPrefix.length + 1}.sql`,
            sha256: createHash("sha256").update(bytes).digest("hex"),
          },
          bytes,
          operationId: "staging-introspection-operation",
        }),
    });
  };
  return { database, apply };
}

test("SQLite 0.4 corpus is the exact 103-case owning source and version references", () => {
  const bytes = readFileSync(
    new URL("./fixtures/sqlite-migration-pragma-040-cases.json", import.meta.url),
  );
  expect(createHash("sha256").update(bytes).digest("hex")).toBe(
    "40fa5d3e90159bc6bf76585f13cde9b8fff3f2a281c55bd12b9324a6cfed8a77",
  );
  expect(CASES).toHaveLength(103);
  expect(corpus.form).toBe(SQLITE_MIGRATION_APPLICATION_FORM_URL_0_4_0);
  expect(corpus.migrationSetForm).toBe(SQLITE_MIGRATION_SET_FORM_URL_0_4_0);
  expect(SQLITE_MIGRATION_APPLICATION_FORM_URL).toBe(corpus.form);
  expect(SQLITE_MIGRATION_SET_FORM_URL).toBe(corpus.migrationSetForm);
  const spec = { database: { resourceUid: "db" }, migrationSet: { resourceUid: "set" } };
  expect(sqliteMigrationApplicationReferences(spec)[1]?.formUrl).toBe(
    SQLITE_MIGRATION_SET_FORM_URL_0_4_0,
  );
  expect(
    sqliteMigrationApplicationReferences(spec, SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0)[1]
      ?.formUrl,
  ).toBe(SQLITE_MIGRATION_SET_FORM_URL_0_3_0);
});

test("SQLite 0.4 canonical metadata keeps exact trigger slices and legacy provider policy", () => {
  const trigger =
    "CREATE TRIGGER keep_outer AFTER INSERT ON evidence BEGIN INSERT INTO parent VALUES(7); END;";
  const sql =
    trigger +
    "\nPRAGMA /* read */ main.\"TaBlE_InFo\"('child'); SELECT * FROM pragma_table_info('child');";
  const statements = prepareNativeMigrationSql(sql, "introspection");
  expect(statements.map((entry) => entry.sql).join("")).toBe(sql);
  expect(statements.map((entry) => entry.command)).toEqual(["create", "pragma", "select"]);
  expect(statements.map((entry) => entry.pragma)).toEqual([null, "introspection", null]);
  expect(() => prepareMigrationSql(sql)).toThrow();
  expect(() =>
    prepareNativeMigrationSql("PRAGMA /* not a read */ defer_foreign_keys=ON;", "introspection"),
  ).toThrow();
});

// These are genuine native-port policy/transaction components. The fixture
// owns its synthetic handle; Host acceptance/custody/RPC is tested elsewhere.
for (const entry of CASES) {
  test(`SQLite 0.4 native owner corpus: ${entry.id}`, async () => {
    const f = fixture(entry.setupSql);
    try {
      const before = snapshot(f.database);
      const result = await f.apply(fixtureSql(entry.sql));
      expect(result.kind, entry.id).toBe(entry.allowed ? "applied" : "rejected");
      expect(f.database.prepare("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
      expect(f.database.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys).toBe(0);
      if (entry.allowed) {
        expect(f.database.prepare(`SELECT sequence,operation_id FROM ${LEDGER}`).all()).toEqual([
          { sequence: 1, operation_id: "staging-introspection-operation" },
        ]);
      } else {
        expect(snapshot(f.database), entry.id).toBe(before);
      }
    } finally {
      f.database.close();
    }
  });
}

test("SQLite 0.4 keeps authorizer through repeated metadata, schema changes, ledger and commit", async () => {
  const f = fixture();
  const actions: {
    readonly action: number;
    readonly first: string | null;
    readonly second: string | null;
  }[] = [];
  const genuine = f.database.setAuthorizer.bind(f.database);
  let installs = 0;
  let clears = 0;
  const observer = spyOn(f.database, "setAuthorizer").mockImplementation((authorize) => {
    if (authorize == null) {
      clears += 1;
      return genuine(null);
    }
    installs += 1;
    return genuine((action, first, second, schema, origin) => {
      actions.push({ action, first, second });
      return authorize(action, first, second, schema, origin);
    });
  });
  try {
    const result = await f.apply(
      "CREATE VIEW cols AS SELECT name FROM pragma_table_info('child'); INSERT INTO evidence SELECT name FROM cols; ALTER TABLE child ADD COLUMN note TEXT; INSERT INTO evidence SELECT name FROM cols;",
    );
    expect(result.kind).toBe("applied");
    expect(f.database.prepare("SELECT count(*) AS count FROM evidence").get()).toEqual({
      count: 5,
    });
    expect(
      actions.filter(
        (event) => event.action === SQLITE.SQLITE_PRAGMA && event.first === "table_info",
      ).length,
    ).toBeGreaterThanOrEqual(2);
    expect(
      actions.some((event) => event.action === SQLITE.SQLITE_INSERT && event.first === LEDGER),
    ).toBe(true);
    expect(
      actions.some(
        (event) => event.action === SQLITE.SQLITE_TRANSACTION && event.first === "COMMIT",
      ),
    ).toBe(true);
    expect(installs).toBe(1);
    expect(clears).toBe(1);
  } finally {
    observer.mockRestore();
    f.database.close();
  }
});

test("SQLite 0.4 distinguishes explicit main from a temp shadow and preserves valid ordinary names", async () => {
  const f = fixture("CREATE TEMP TABLE child(secret TEXT)");
  try {
    const result = await f.apply(
      "INSERT INTO evidence SELECT name FROM pragma_table_info('child','main'); CREATE TABLE pragma_notes(value); INSERT INTO pragma_notes VALUES('ok');",
    );
    expect(result.kind).toBe("applied");
    expect(f.database.prepare("SELECT count(*) AS count FROM evidence").get()).toEqual({
      count: 2,
    });
    expect(f.database.prepare("SELECT value FROM pragma_notes").get()).toEqual({ value: "ok" });
  } finally {
    f.database.close();
  }
});

test("SQLite 0.4 denies dynamic ledger metadata from a trigger and rolls back preceding effects", async () => {
  const f = fixture();
  try {
    const before = snapshot(f.database);
    const result = await f.apply(`CREATE TRIGGER inspect_ledger AFTER INSERT ON evidence BEGIN
      INSERT INTO parent SELECT cid FROM pragma_table_info(NEW.name);
    END;
    INSERT INTO evidence VALUES('${LEDGER}');`);
    expect(result).toEqual({ kind: "rejected", code: "migration_sql_error" });
    expect(snapshot(f.database)).toBe(before);
  } finally {
    f.database.close();
  }
});

test("SQLite 0.4 resolves metadata after main DDL while refusing implicit attached fallback", async () => {
  const f = fixture("ATTACH ':memory:' AS other; CREATE TABLE other.created_here(secret TEXT)");
  try {
    const first = await f.apply(
      "CREATE TABLE created_here(visible TEXT); INSERT INTO evidence SELECT name FROM pragma_table_info('created_here');",
    );
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") throw new Error("main DDL did not commit");
    expect(f.database.prepare("SELECT name FROM evidence").all()).toEqual([{ name: "visible" }]);
    const before = snapshot(f.database);
    expect(
      await f.apply("DROP TABLE created_here; SELECT * FROM pragma_table_info('created_here');", [
        first.record,
      ]),
    ).toEqual({ kind: "rejected", code: "migration_sql_error" });
    expect(snapshot(f.database)).toBe(before);
  } finally {
    f.database.close();
  }
});

test("SQLite retained 0.3 allows defer but denies new metadata without invalidating its prefix", async () => {
  const f = fixture("", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0);
  try {
    const first = await f.apply(
      "PRAGMA defer_foreign_keys=ON; INSERT INTO evidence VALUES('old');",
    );
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") throw new Error("retained defer file failed");
    expect(await f.apply("PRAGMA table_info('child');", [first.record])).toEqual({
      kind: "rejected",
      code: "migration_sql_error",
    });
    expect(f.database.prepare("SELECT name FROM evidence").all()).toEqual([{ name: "old" }]);
    expect(f.database.prepare(`SELECT sequence FROM ${LEDGER}`).all()).toEqual([{ sequence: 1 }]);
  } finally {
    f.database.close();
  }
  const old = fixture("", SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0);
  try {
    expect(await old.apply("PRAGMA defer_foreign_keys=ON;")).toEqual({
      kind: "rejected",
      code: "migration_sql_error",
    });
  } finally {
    old.database.close();
  }
});
