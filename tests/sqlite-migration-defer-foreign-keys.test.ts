import { expect, test } from "bun:test";
import { DatabaseSync } from "node:sqlite";
import {
  MigrationSqlCapacityError,
  prepareMigrationSql,
} from "../src/providers/sqlite-migration-policy.ts";
import {
  assertMigrationPragmaAssignments,
  MigrationSqlCapacityError as NeutralCapacityError,
  prepareMigrationSql as prepareNeutralMigrationSql,
} from "../src/sqlite-migration-policy.ts";
import {
  SQLITE_MIGRATION_APPLICATION_FORM_URL,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0,
} from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { createSQLiteMigrationApplicationNativePort } from "../src/takoform-v2/forms/sqlite-migration-application-native.ts";
import type { SQLiteMigrationRecord } from "../src/takoform-v2/forms/sqlite-migration-application-port.ts";

const VALUES = ["ON", "OFF", "TRUE", "FALSE", "1", "0"] as const;
const FORBIDDEN_PRAGMAS = [
  "PRAGMA foreign_keys=ON",
  "PRAGMA foreign_keys=OFF",
  "PRAGMA user_version=1",
  "PRAGMA application_id=1",
  "PRAGMA table_info(actors)",
  "PRAGMA foreign_key_check",
  "PRAGMA integrity_check",
  "PRAGMA defer_foreign_keys",
  "PRAGMA main.defer_foreign_keys=ON",
  "PRAGMA temp.defer_foreign_keys=ON",
  "PRAGMA defer_foreign_keys(ON)",
  "PRAGMA 'defer_foreign_keys'=ON",
  'PRAGMA "defer_foreign_keys"=ON',
  "PRAGMA [defer_foreign_keys]=ON",
  "PRAGMA `defer_foreign_keys`=ON",
  "PRAGMA defer_foreign_keys='ON'",
  'PRAGMA defer_foreign_keys="ON"',
  "PRAGMA defer_foreign_keys=[ON]",
  "PRAGMA defer_foreign_keys=`ON`",
  "PRAGMA defer_foreign_keys=+1",
  "PRAGMA defer_foreign_keys=-0",
  "PRAGMA defer_foreign_keys=01",
  "PRAGMA defer_foreign_keys=1.0",
  "PRAGMA defer_foreign_keys=0x1",
  "PRAGMA defer_foreign_keys=2",
  "PRAGMA defer_foreign_keys=yes",
  "PRAGMA defer_foreign_Keys=ON",
  "PRAGMA defer_foreign_keys=ON,foreign_keys=OFF",
  "PRAGMA defer_foreign_keys=ON=OFF",
  "PRAGMA defer_foreign_keys=ON OFF",
  "PRAGMA defer_foreign_keys=ON extra",
  "EXPLAIN PRAGMA defer_foreign_keys=ON",
  "EXPLAIN QUERY PLAN PRAGMA defer_foreign_keys=ON",
  "SELECT * FROM pragma_defer_foreign_keys",
  "SELECT * FROM pragma_foreign_keys",
  "SELECT * FROM pragma_table_info('actors')",
] as const;

test("parser compatibility path shares the exact neutral parser and capacity error identity", () => {
  expect(prepareMigrationSql).toBe(prepareNeutralMigrationSql);
  expect(MigrationSqlCapacityError).toBe(NeutralCapacityError);
  expect(() => prepareMigrationSql("SELECT 1;", 8)).toThrow(NeutralCapacityError);
  try {
    prepareMigrationSql("SELECT 1; PRAGMA foreign_keys=OFF;", 8);
    throw new Error("a later policy violation must not be hidden by capacity");
  } catch (error) {
    expect(error).not.toBeInstanceOf(NeutralCapacityError);
    expect(error).toBeInstanceOf(Error);
  }
});

test("parser permits only the six bare defer assignments and preserves exact slices", () => {
  for (const value of VALUES) {
    const pragma = `/* outside prefix ; */ pRaGmA\r\n DeFeR_FoReIgN_KeYs = ${value.toLowerCase()} ;`;
    const ddl = "\nCREATE TABLE quoted (value TEXT DEFAULT 'PRAGMA foreign_keys=OFF; BEGIN');";
    const trailing = " -- trailing no-op\n;";
    expect(prepareMigrationSql(pragma + ddl + trailing)).toEqual([pragma, ddl]);
    expect(prepareMigrationSql(`PRAGMA defer_foreign_keys=${value}`)).toEqual([
      `PRAGMA defer_foreign_keys=${value}`,
    ]);
  }
  const toggles = "PRAGMA defer_foreign_keys=ON; PRAGMA defer_foreign_keys=OFF;";
  expect(prepareMigrationSql(toggles).join("")).toBe(toggles);
});

test("parser refuses read, qualified, quoted, parenthesized and multi-assignment PRAGMA forms", () => {
  for (const sql of FORBIDDEN_PRAGMAS) {
    expect(() => prepareMigrationSql(`${sql};`), sql).toThrow();
    expect(() => prepareMigrationSql(`CREATE TABLE untouched(id); ${sql};`), sql).toThrow();
  }
  for (const sql of ["PRAGMA", "PRAGMA defer_foreign_keys=", "PRAGMA defer_foreign_keys=/* open"]) {
    expect(() => prepareMigrationSql(sql), sql).toThrow();
  }
});

test("parser retains trigger framing and refuses authority escapes after an allowed PRAGMA", () => {
  const trigger =
    "CREATE TRIGGER audit AFTER INSERT ON source BEGIN " +
    "INSERT INTO sink VALUES(CASE WHEN NEW.id=1 THEN 'END;' ELSE 'PRAGMA' END); END;";
  expect(prepareMigrationSql(trigger)).toEqual([trigger]);
  for (const sql of [
    "ATTACH 'other.sqlite' AS other",
    "DETACH other",
    "COMMIT",
    "SAVEPOINT escaped",
    "SELECT load_extension('unsafe')",
    "SELECT * FROM _takoform_sqlite_migrations",
  ]) {
    expect(() => prepareMigrationSql(`PRAGMA defer_foreign_keys=TRUE; ${sql};`), sql).toThrow();
  }
});

test("parser native PRAGMA entry preserves the provider's separate non-PRAGMA identifier policy", () => {
  const literal = "SELECT 'load_extension', '_takoform_literal', 'pragma_table_info';";
  expect(() => assertMigrationPragmaAssignments(literal)).not.toThrow();
  expect(() => prepareMigrationSql(literal)).toThrow();
  for (const value of VALUES) {
    expect(() =>
      assertMigrationPragmaAssignments(`PRAGMA defer_foreign_keys=${value};`),
    ).not.toThrow();
  }
  for (const sql of FORBIDDEN_PRAGMAS.filter((value) => !value.startsWith("SELECT"))) {
    expect(() => assertMigrationPragmaAssignments(`${sql};`), sql).toThrow();
  }
});

function fixture(form: string = SQLITE_MIGRATION_APPLICATION_FORM_URL) {
  const database = new DatabaseSync(":memory:");
  let ownerOpens = 0;
  database.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE _takoform_sqlite_migrations (
 sequence INTEGER PRIMARY KEY CHECK(sequence BETWEEN 1 AND 512),
 path TEXT NOT NULL UNIQUE, sha256 TEXT NOT NULL CHECK(length(sha256)=64),
 operation_id TEXT NOT NULL
);
CREATE TABLE parent(id INTEGER PRIMARY KEY);
CREATE TABLE child(id INTEGER PRIMARY KEY, parent_id INTEGER NOT NULL REFERENCES parent(id));`);
  const port = createSQLiteMigrationApplicationNativePort({
    async withAuthorizedDatabase(input) {
      ownerOpens += 1;
      if (!(await input.stillAuthorized())) throw new Error("fixture authorization lost");
      return input.use(database);
    },
  });
  const apply = async (sql: string, expectedPrefix: readonly SQLiteMigrationRecord[] = []) =>
    port.withAuthorizedMigrationSession({
      resourceUid: "staging-sqlite-component",
      execution: {
        operationId: "staging-component-operation",
        leaseToken: "staging-component-lease",
        backendKey: "staging-component-backend",
        backendId: "selfhost-v2-sqlite-migration-application-native-v1",
        targetKey: "staging-component-target",
        resourceUid: "staging-component-application",
        principal: "staging-component-principal",
        action: "create",
        generation: 1,
        form,
        space: "staging-component",
        name: "staging-application",
        spec: {},
      },
      stillAuthorized: async () => true,
      async use(session) {
        return session.applyOneHeldFile({
          sequence: expectedPrefix.length + 1,
          expectedPrefix,
          entry: { path: `staging/${expectedPrefix.length + 1}.sql`, sha256: "a".repeat(64) },
          bytes: new TextEncoder().encode(sql),
          operationId: "staging-component-operation",
        });
      },
    });
  const settings = () => ({
    deferred: database.prepare("PRAGMA defer_foreign_keys").get()?.defer_foreign_keys,
    enforced: database.prepare("PRAGMA foreign_keys").get()?.foreign_keys,
  });
  return {
    database,
    apply,
    settings,
    get ownerOpens() {
      return ownerOpens;
    },
  };
}

test("native retained 0.2 denies new defer effects while keeping its committed prefix", async () => {
  const f = fixture(SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0);
  try {
    const first = await f.apply("INSERT INTO parent VALUES(7);");
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") throw new Error("ordinary retained SQL did not apply");
    expect(
      await f.apply("PRAGMA defer_foreign_keys=ON; INSERT INTO parent VALUES(8);", [first.record]),
    ).toEqual({ kind: "rejected", code: "migration_sql_error" });
    expect(f.database.prepare("SELECT id FROM parent").all()).toEqual([{ id: 7 }]);
    expect(f.database.prepare("SELECT sequence FROM _takoform_sqlite_migrations").all()).toEqual([
      { sequence: 1 },
    ]);
    expect(f.settings()).toEqual({ deferred: 0, enforced: 1 });
  } finally {
    f.database.close();
  }
});

test("native unknown Form identity cannot open the owner or invoke a migration session", async () => {
  const f = fixture("https://unknown.example/SQLiteMigrationApplication/");
  try {
    await expect(f.apply("INSERT INTO parent VALUES(7);")).rejects.toThrow(
      "Form identity is unsupported",
    );
    expect(f.ownerOpens).toBe(0);
    expect(f.database.prepare("SELECT id FROM parent").all()).toEqual([]);
    expect(f.settings()).toEqual({ deferred: 0, enforced: 1 });
  } finally {
    f.database.close();
  }
});

test("SQLite component commits a deferred forward reference with its ledger and resets on commit", async () => {
  const { database, apply, settings } = fixture();
  try {
    const result = await apply(
      "PRAGMA defer_foreign_keys=TRUE; INSERT INTO child VALUES(1,7); INSERT INTO parent VALUES(7);",
    );
    expect(result.kind).toBe("applied");
    expect(database.prepare("SELECT * FROM child").all()).toEqual([{ id: 1, parent_id: 7 }]);
    expect(database.prepare("SELECT sequence FROM _takoform_sqlite_migrations").all()).toEqual([
      { sequence: 1 },
    ]);
    expect(settings()).toEqual({ deferred: 0, enforced: 1 });
  } finally {
    database.close();
  }
});

test("SQLite component rolls failed FK commit back with its ledger and next-file setting", async () => {
  const { database, apply, settings } = fixture();
  try {
    expect(await apply("PRAGMA defer_foreign_keys=ON; INSERT INTO child VALUES(1,7);")).toEqual({
      kind: "rejected",
      code: "migration_sql_error",
    });
    expect(database.prepare("SELECT * FROM child").all()).toEqual([]);
    expect(database.prepare("SELECT * FROM _takoform_sqlite_migrations").all()).toEqual([]);
    expect(settings()).toEqual({ deferred: 0, enforced: 1 });
    expect(await apply("INSERT INTO child VALUES(1,7); INSERT INTO parent VALUES(7);")).toEqual({
      kind: "rejected",
      code: "migration_sql_error",
    });
    expect(database.prepare("SELECT * FROM parent").all()).toEqual([]);
    expect(settings()).toEqual({ deferred: 0, enforced: 1 });
  } finally {
    database.close();
  }
});

test("SQLite component retained 0.3 permits OFF aliases and rejects every other PRAGMA before effects", async () => {
  for (const value of ["OFF", "FALSE", "0"]) {
    const { database, apply, settings } = fixture(SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0);
    try {
      const result = await apply(
        `PRAGMA defer_foreign_keys=ON; PRAGMA defer_foreign_keys=${value}; INSERT INTO parent VALUES(7); INSERT INTO child VALUES(1,7);`,
      );
      expect(result.kind).toBe("applied");
      expect(settings()).toEqual({ deferred: 0, enforced: 1 });
    } finally {
      database.close();
    }
  }
  for (const sql of FORBIDDEN_PRAGMAS) {
    const { database, apply, settings } = fixture(SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0);
    try {
      expect(await apply(`INSERT INTO parent VALUES(7); ${sql};`), sql).toEqual({
        kind: "rejected",
        code: "migration_sql_error",
      });
      expect(database.prepare("SELECT * FROM parent").all(), sql).toEqual([]);
      expect(database.prepare("SELECT * FROM _takoform_sqlite_migrations").all(), sql).toEqual([]);
      expect(settings(), sql).toEqual({ deferred: 0, enforced: 1 });
    } finally {
      database.close();
    }
  }
});

test("SQLite component preserves harmless native literals and rejects actual extension loading", async () => {
  const { database, apply, settings } = fixture();
  try {
    const first = await apply("SELECT 'load_extension', '_takoform_literal', 'pragma_table_info';");
    expect(first.kind).toBe("applied");
    if (first.kind !== "applied") throw new Error("literal migration was not applied");
    expect(await apply("SELECT load_extension('forbidden');", [first.record])).toEqual({
      kind: "rejected",
      code: "migration_sql_error",
    });
    expect(database.prepare("SELECT sequence FROM _takoform_sqlite_migrations").all()).toEqual([
      { sequence: 1 },
    ]);
    expect(settings()).toEqual({ deferred: 0, enforced: 1 });
  } finally {
    database.close();
  }
});
