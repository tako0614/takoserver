import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { MoneyUnitCutoverRequiredError, migrateSqlite } from "../src/migrate-sqlite.ts";

function predecessor(count = 92): Database {
  const db = new Database(":memory:");
  db.exec(
    "CREATE TABLE applied_migrations(name TEXT PRIMARY KEY NOT NULL, applied_at TEXT NOT NULL)",
  );
  for (const migration of MIGRATIONS.slice(0, count)) {
    db.exec(migration.sql);
    db.query("INSERT INTO applied_migrations VALUES (?, 'original')").run(migration.name);
  }
  return db;
}

const funding = "INSERT INTO ledger VALUES ('old', 'org', 'funding', 'cash', 1, 0, 'original')";
const fundedLot =
  "INSERT INTO wallet_credit_lots (org_id, ref, kind, amount_minor, expires_at, created_at) VALUES ('org', 'cash', 'direct', 1, NULL, 'original')";
const schema = (db: Database) =>
  db.query("SELECT name, sql FROM sqlite_schema ORDER BY name").all();

describe("automatic USD-micros startup boundary", () => {
  test("funded 0092 refuses before any schema, checkpoint, or money write", () => {
    const db = predecessor();
    db.exec(funding);
    db.exec(fundedLot);
    const before = schema(db);
    const history = db.query("SELECT * FROM applied_migrations").all();
    expect(() => migrateSqlite(db)).toThrow(MoneyUnitCutoverRequiredError);
    expect(schema(db)).toEqual(before);
    expect(db.query("SELECT * FROM applied_migrations").all()).toEqual(history);
    expect(db.query("SELECT settled_delta FROM ledger").all()).toEqual([{ settled_delta: 1 }]);
    db.close();
  });

  test("prepared 0093 with classification evidence still cannot auto-convert 0094", () => {
    const db = predecessor(93);
    db.exec(funding);
    db.exec(fundedLot);
    db.exec(
      "INSERT INTO wallet_credit_lot_classification_proofs VALUES ('org','cash','direct',1,NULL,'purchased','operator-protected-proof','original')",
    );
    // This is valid operator-classified history, not a dangling proof that
    // SQL would reject for another reason. Startup still has no authority.
    const qualified = predecessor(93);
    qualified.exec(funding);
    qualified.exec(fundedLot);
    qualified.exec(
      "INSERT INTO wallet_credit_lot_classification_proofs VALUES ('org','cash','direct',1,NULL,'purchased','operator-protected-proof','original')",
    );
    qualified.exec(MIGRATIONS[93]!.sql);
    expect(qualified.query("SELECT settled_delta_micros FROM ledger").get()).toEqual({
      settled_delta_micros: 10_000,
    });
    qualified.close();
    const before = schema(db);
    expect(() => migrateSqlite(db)).toThrow(MoneyUnitCutoverRequiredError);
    expect(schema(db)).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS n FROM applied_migrations").get()).toEqual({ n: 93 });
    db.close();
  });

  for (const table of ["quotes", "usage_statements"] as const) {
    test(`partial prefix with only ${table} history refuses without creating a migration ledger`, () => {
      const db = new Database(":memory:");
      db.exec(`CREATE TABLE ${table}(amount_minor INTEGER); INSERT INTO ${table} VALUES (0)`);
      const before = schema(db);
      expect(() => migrateSqlite(db)).toThrow(MoneyUnitCutoverRequiredError);
      expect(schema(db)).toEqual(before);
      db.close();
    });
  }

  test("a writer between advisory read and first lock cannot trigger automatic conversion", () => {
    const db = predecessor();
    const before = schema(db);
    let injected = false;
    const raced = {
      query: (query: string) => db.query(query),
      exec: (query: string) => {
        if (query === "BEGIN IMMEDIATE" && !injected) {
          injected = true;
          db.exec(funding);
        }
        return db.exec(query);
      },
    };
    expect(() => migrateSqlite(raced)).toThrow(MoneyUnitCutoverRequiredError);
    expect(injected).toBe(true);
    expect(schema(db)).toEqual(before);
    expect(db.query("SELECT COUNT(*) AS n FROM applied_migrations").get()).toEqual({ n: 92 });
    db.close();
  });

  test("fresh and never-billed predecessors initialize micros; converted restart writes nothing", () => {
    for (const db of [new Database(":memory:"), predecessor()]) {
      const migrated = migrateSqlite(db);
      expect(migrated.applied).toContain("0094_wallet_usd_micros.sql");
      expect(migrated.applied.at(-1)).toBe(MIGRATIONS.at(-1)?.name);
      expect(
        db
          .query("SELECT name FROM applied_migrations WHERE name = ?")
          .get("0094_wallet_usd_micros.sql"),
      ).toEqual({ name: "0094_wallet_usd_micros.sql" });
      const before = schema(db);
      const readOnlyRestart = {
        query: (query: string) => db.query(query),
        exec: (_query: string) => {
          throw new Error("restart attempted a write");
        },
      };
      expect(migrateSqlite(readOnlyRestart)).toEqual({
        applied: [],
        alreadyApplied: MIGRATIONS.length,
      });
      expect(schema(db)).toEqual(before);
      db.close();
    }
  });
});
