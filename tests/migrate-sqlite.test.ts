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
    expect(
      database
        .query("PRAGMA table_info(tf_resources)")
        .all()
        .map((column) => String((column as { name: unknown }).name)),
    ).not.toContain("native_id");
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

  test("refuses to discard a legacy native identity that has not been adopted", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const dropNativeIdentity = MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith("0007_"),
    );
    expect(dropNativeIdentity).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, dropNativeIdentity)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, native_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_1",
        "default",
        "forms/v1",
        "Bucket",
        "assets",
        "uid_1",
        "1",
        "1",
        "{}",
        "bucket:assets",
        1,
      );

    expect(() => migrateSqlite(database)).toThrow(
      /0007_logical_resources_drop_native_identity\.sql failed/u,
    );
    expect(database.query("SELECT native_id FROM tf_resources").all()).toEqual([
      { native_id: "bucket:assets" },
    ]);
  });

  test("adopts exact released legacy resources into provider Deployments before dropping native identity", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const dropNativeIdentity = MIGRATIONS.findIndex((migration) =>
      migration.name.startsWith("0007_"),
    );
    for (const migration of MIGRATIONS.slice(0, dropNativeIdentity)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, native_id, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        "org_1",
        "default",
        "edge.forms.takoform.com/v1beta1",
        "ObjectBucket",
        "assets",
        "uid_legacy_bucket",
        "1",
        "2",
        JSON.stringify({
          status: { observed: { region: "global" }, outputs: { bucket: "opaque" } },
        }),
        "r2:opaque-native-id",
        42,
      );

    migrateSqlite(database);
    expect(
      database
        .query(
          `SELECT id, resource_uid, offering_id, provider_pack_ref,
                  provider_installation_ref, native_id, state, observed_json,
                  outputs_json
           FROM tf_resource_deployments`,
        )
        .all(),
    ).toEqual([
      {
        id: "dep_legacy_uid_legacy_bucket",
        resource_uid: "uid_legacy_bucket",
        offering_id: "storage.object.standard",
        provider_pack_ref: "cloudflare",
        provider_installation_ref: "cloudflare.primary",
        native_id: "r2:opaque-native-id",
        state: "active",
        observed_json: '{"region":"global"}',
        outputs_json: '{"bucket":"opaque"}',
      },
    ]);
    expect(
      database
        .query("PRAGMA table_info(tf_resources)")
        .all()
        .map((column) => String((column as { name: unknown }).name)),
    ).not.toContain("native_id");
  });
});
