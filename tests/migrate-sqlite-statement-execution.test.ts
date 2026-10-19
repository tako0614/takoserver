import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { executeSqliteMigrationStatements, migrateSqlite } from "../src/migrate-sqlite.ts";
import {
  frameHostMigrationSql,
  prepareNativeMigrationSql,
} from "../src/sqlite-migration-policy.ts";

const literal = (value: string) => `'${value.replaceAll("'", "''")}'`;

function snapshot(database: Database): string {
  database.query("SELECT name FROM temp.sqlite_schema").all();
  const schema = database
    .query("SELECT type,name,tbl_name,sql FROM main.sqlite_schema ORDER BY type,name")
    .all();
  const temporary = database
    .query("SELECT type,name,tbl_name,sql FROM temp.sqlite_schema ORDER BY type,name")
    .all();
  const tables = database
    .query<{ name: string }, []>(
      "SELECT name FROM main.sqlite_schema WHERE type='table' ORDER BY name",
    )
    .all()
    .map(({ name }) => ({
      name,
      rows: database.query(`SELECT * FROM "${name.replaceAll('"', '""')}"`).all(),
    }));
  return JSON.stringify({ schema, temporary, tables });
}

test("Host migration executor preserves quoted guard DDL, semicolons, multiline literals and complete triggers", () => {
  const database = new Database(":memory:");
  const trigger = `CREATE TRIGGER retained_guard BEFORE UPDATE ON retained BEGIN
  SELECT RAISE(ABORT, 'immutable; boundary');
END`;
  const payload = "first; line\n-- this is literal data, not a comment;\nlast line";
  const chunks = [
    "-- leading comment; untouched\nCREATE TABLE retained(value TEXT);",
    "\n/* outer ; comment */ CREATE TABLE audit(payload TEXT);",
    `\n${trigger};`,
    "\nCREATE TABLE expected(sql TEXT);",
    `\nINSERT INTO expected VALUES(${literal(trigger)});`,
    `\nINSERT INTO audit VALUES(${literal(payload)});`,
    "\nINSERT INTO retained VALUES('before');",
  ];
  const calls: string[] = [];
  try {
    executeSqliteMigrationStatements(
      {
        exec(sql) {
          calls.push(sql);
          return database.exec(sql);
        },
        query(sql) {
          return database.query(sql);
        },
      },
      chunks.join(""),
    );
    expect(calls).toEqual(chunks);
    expect(database.query("SELECT sql FROM expected").get()).toEqual({ sql: trigger });
    expect(
      database.query("SELECT sql FROM sqlite_schema WHERE name='retained_guard'").get(),
    ).toEqual({ sql: trigger });
    expect(database.query("SELECT payload FROM audit").get()).toEqual({ payload });
    expect(() => database.query("UPDATE retained SET value='after'").run()).toThrow(
      "immutable; boundary",
    );
    expect(database.query("SELECT value FROM retained").get()).toEqual({ value: "before" });
  } finally {
    database.close();
  }
});

test("Host framing preserves operator PRAGMA meaning while all tenant preparation profiles retain their bans", () => {
  const database = new Database(":memory:");
  const chunks = [
    "PRAGMA user_version = 17;",
    "\nPRAGMA application_id = 1234;",
    "\nPRAGMA foreign_keys = ON;",
    "\nPRAGMA user_version;",
  ];
  try {
    expect(frameHostMigrationSql(chunks.join(""))).toEqual(chunks);
    executeSqliteMigrationStatements(database, chunks.join(""));
    expect(database.query("PRAGMA user_version").get()).toEqual({ user_version: 17 });
    expect(database.query("PRAGMA application_id").get()).toEqual({ application_id: 1234 });
    expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    for (const profile of ["deny", "defer", "introspection"] as const) {
      expect(() => prepareNativeMigrationSql(chunks.join(""), profile)).toThrow();
    }
  } finally {
    database.close();
  }
});

test("Host migration executor stops at the original CHECK rollback without executing or autocommitting its suffix", () => {
  const database = new Database(":memory:");
  try {
    database.exec(
      "CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('before'); CREATE TABLE suffix(value TEXT);",
    );
    const before = snapshot(database);
    let refusal: unknown;
    try {
      executeSqliteMigrationStatements(
        database,
        `BEGIN IMMEDIATE;
CREATE TEMP TABLE assertion(ok INTEGER NOT NULL CHECK(ok=1));
INSERT OR ROLLBACK INTO assertion VALUES(0);
INSERT INTO suffix VALUES('must not execute');
INSERT INTO assertion VALUES(1);
COMMIT;`,
      );
    } catch (error) {
      refusal = error;
    }
    expect(refusal).toBeInstanceOf(Error);
    if (!(refusal instanceof Error)) throw new Error("missing native CHECK refusal");
    expect(refusal.message).toContain("CHECK constraint failed: ok=1");
    expect(refusal.message).not.toContain("no such table");
    expect(database.inTransaction).toBe(false);
    expect(database.query("SELECT * FROM suffix").all()).toEqual([]);
    expect(snapshot(database)).toBe(before);
  } finally {
    database.close();
  }
});

test("Host framing rejects an incomplete trigger before any earlier statement executes", () => {
  const database = new Database(":memory:");
  try {
    database.exec("CREATE TABLE retained(value TEXT); INSERT INTO retained VALUES('before');");
    const before = snapshot(database);
    expect(() =>
      executeSqliteMigrationStatements(
        database,
        "INSERT INTO retained VALUES('not executed'); CREATE TRIGGER incomplete AFTER INSERT ON retained BEGIN SELECT 1;",
      ),
    ).toThrow();
    expect(snapshot(database)).toBe(before);
  } finally {
    database.close();
  }
});

test("Actual migrateSqlite retains the original receipt rollback error and the exact existing database", () => {
  const database = new Database(":memory:");
  try {
    database.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE operator_marker(value TEXT); INSERT INTO operator_marker VALUES('retained');
CREATE TABLE applied_migrations(name TEXT PRIMARY KEY NOT NULL,applied_at TEXT NOT NULL);
CREATE TRIGGER receipt_rollback BEFORE INSERT ON applied_migrations BEGIN SELECT RAISE(ROLLBACK,'fixture_receipt_rollback'); END;`);
    const before = snapshot(database);
    expect(() => migrateSqlite(database)).toThrow(
      "migration 0001_runtime_storage.sql failed: SQLiteError: fixture_receipt_rollback",
    );
    expect(database.inTransaction).toBe(false);
    expect(snapshot(database)).toBe(before);
    expect(database.query("SELECT * FROM applied_migrations").all()).toEqual([]);
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});

for (const existing of [false, true]) {
  test(`Actual migrateSqlite ${existing ? "retained installation" : "fresh installation"} applies the unchanged complete owning lineage and restarts read-only`, () => {
    const database = new Database(":memory:");
    const writes: string[] = [];
    try {
      database.exec("PRAGMA foreign_keys=ON");
      if (existing)
        database.exec(
          "CREATE TABLE operator_marker(value TEXT); INSERT INTO operator_marker VALUES('retained');",
        );
      const owner = {
        exec(sql: string) {
          writes.push(sql);
          return database.exec(sql);
        },
        query(sql: string) {
          return database.query(sql);
        },
      };
      expect(MIGRATIONS.length).toBe(100);
      expect(migrateSqlite(owner)).toEqual({
        applied: MIGRATIONS.map((migration) => migration.name),
        alreadyApplied: 0,
      });
      expect(database.query("SELECT name FROM applied_migrations ORDER BY rowid").all()).toEqual(
        MIGRATIONS.map((migration) => ({ name: migration.name })),
      );
      expect(database.inTransaction).toBe(false);
      expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
      expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
      if (existing)
        expect(database.query("SELECT * FROM operator_marker").get()).toEqual({
          value: "retained",
        });
      writes.length = 0;
      expect(migrateSqlite(owner)).toEqual({ applied: [], alreadyApplied: MIGRATIONS.length });
      expect(writes).toEqual([]);
    } finally {
      database.close();
    }
  });
}

test("Actual migrateSqlite keeps the financial Stripe realm transaction and its already-qualified restart", () => {
  const database = new Database(":memory:");
  try {
    database.exec("PRAGMA foreign_keys=ON");
    expect(migrateSqlite(database, { stripeMode: "test" }).applied).toEqual(
      MIGRATIONS.map((migration) => migration.name),
    );
    expect(database.query("SELECT mode FROM stripe_mode_realm WHERE singleton=1").get()).toEqual({
      mode: "test",
    });
    expect(database.inTransaction).toBe(false);
    expect(migrateSqlite(database, { stripeMode: "test" })).toEqual({
      applied: [],
      alreadyApplied: MIGRATIONS.length,
    });
    expect(() => migrateSqlite(database, { stripeMode: "live" })).toThrow();
    expect(database.query("SELECT mode FROM stripe_mode_realm WHERE singleton=1").get()).toEqual({
      mode: "test",
    });
    expect(database.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    database.close();
  }
});
