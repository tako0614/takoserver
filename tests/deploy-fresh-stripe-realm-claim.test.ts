import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { buildD1MigrationImport } from "../scripts/deploy/d1-migration-import.ts";
import { buildFreshStripeRealmClaim } from "../scripts/deploy/fresh-stripe-realm-claim.ts";
import { readCurrentAuditedMigrationSourceArtifact } from "../scripts/deploy/schema.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { assertStripeModeRealm } from "../src/stripe-mode-realm.ts";

const files = readCurrentAuditedMigrationSourceArtifact(
  resolve(import.meta.dir, "../migrations"),
).files.slice(0, 100);
const claim = buildFreshStripeRealmClaim(files);
const migrations = buildD1MigrationImport(files, { freshLedger: true }).sql;

/** The whole fresh import as one transaction, as the D1 import applies it. */
function importInto(database: Database, before: (db: Database) => void = () => {}): void {
  database.exec("BEGIN");
  try {
    database.exec(migrations);
    before(database);
    database.exec(claim.sql);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

test("the fresh 0100 import claims exactly the test realm the served Worker requires", async () => {
  const database = new Database(":memory:");
  importInto(database);
  expect(database.query("SELECT singleton, mode FROM stripe_mode_realm").all()).toEqual([
    { singleton: 1, mode: "test" },
  ]);
  const pinnedAt = (
    database.query("SELECT pinned_at FROM stripe_mode_realm").get() as {
      pinned_at: string;
    }
  ).pinned_at;
  expect(pinnedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
  await assertStripeModeRealm(createSqliteSql(database), "test");
  expect(claim.historyTables.length).toBeGreaterThan(30);
  for (const table of claim.historyTables)
    expect(database.query(`SELECT COUNT(*) AS n FROM "${table}"`).get()).toEqual({ n: 0 });
});

test("an existing pin, a history row or an unexpected financial table refuses the whole import", () => {
  expect(claim.historyTables).toContain("idempotency");
  const refusals: ((db: Database) => void)[] = [
    (db) =>
      db.exec(
        "INSERT INTO stripe_mode_realm (singleton, mode, pinned_at) VALUES (1, 'live', '2026-01-01T00:00:00.000Z')",
      ),
    (db) =>
      db.exec(
        "INSERT INTO idempotency (scope_key, fingerprint, status, body_json, expires_at) VALUES ('scope', 'fingerprint', 200, NULL, 0)",
      ),
    (db) => db.exec("CREATE TABLE stripe_unclassified_history (id INTEGER PRIMARY KEY)"),
  ];
  for (const before of refusals) {
    const database = new Database(":memory:");
    expect(() => importInto(database, before)).toThrow();
    // Nothing of the import survives: no schema, no ledger, no pin.
    expect(
      database
        .query("SELECT COUNT(*) AS n FROM sqlite_schema WHERE name NOT GLOB 'sqlite_*'")
        .get(),
    ).toEqual({ n: 0 });
  }
});

test("the claim requires the 0098 realm schema and the complete financial history", () => {
  expect(() => buildFreshStripeRealmClaim(files.slice(0, 97))).toThrow("0098 realm schema");
});
