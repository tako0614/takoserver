import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

/**
 * A self-hosted deployment starts with an empty file. If the first run does
 * not produce a schema, it produces a server that answers every request with
 * "no such table" — which is what it did.
 */
describe("bringing a local database up to date", () => {
  test("creates everything on a fresh file", () => {
    const database = new Database(":memory:");
    const report = migrateSqlite(database);
    expect(report.applied).toEqual(MIGRATIONS.map((migration) => migration.name));

    // The tables the product actually needs on its first request.
    for (const table of [
      "principals",
      "orgs",
      "ledger",
      "tf_resources",
      "tf_resource_attachments",
      "tf_resource_deployments",
      "reservations",
    ]) {
      expect(() => database.query(`SELECT 1 FROM ${table} LIMIT 1`).all()).not.toThrow();
    }
  });

  test("running it again applies nothing", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const second = migrateSqlite(database);
    expect(second.applied).toEqual([]);
    expect(second.alreadyApplied).toBe(MIGRATIONS.length);
  });

  test("refuses a database written by a newer build", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    database.exec(
      "INSERT INTO applied_migrations (name, applied_at) VALUES ('9999_from_the_future.sql', 'now')",
    );
    // Downgrading by re-running old migrations over a newer schema is how a
    // database gets destroyed by an upgrade tool.
    expect(() => migrateSqlite(database)).toThrow(/newer Takoserver/u);
  });

  test("leaves nothing half applied when a migration fails", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    // A table this build's first migration would create already exists, so a
    // second pass over a wiped record must abort rather than half-apply.
    database.exec("DELETE FROM applied_migrations");
    expect(() => migrateSqlite(database)).toThrow(/migration .* failed/u);
    expect(database.query("SELECT COUNT(*) AS n FROM applied_migrations").all()).toEqual([
      { n: 0 },
    ]);
  });
});
