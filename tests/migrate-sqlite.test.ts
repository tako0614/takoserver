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
      "tf_deferred_operations",
      "tf_operation_commit_guards",
      "tf_resource_claims",
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

  test("adds durable operations and claims without rewriting released Takoform rows", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const durableOperations = MIGRATIONS.findIndex(
      (migration) => migration.name === "0020_takoform_deferred_operations.sql",
    );
    expect(durableOperations).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, durableOperations)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, relations_json, updated_at)
         VALUES ('tenant-a', 'main', 'example.forms.invalid', 'Thing', 'existing',
                 'uid_existing', '3', '7', ?, '[]', 42)`,
      )
      .run('{"existing":true}');
    database.exec(`
      INSERT INTO tf_operations
        (id, tenant_id, operation, state, resource_json, created_at, expires_at)
      VALUES
        ('op_existing', 'tenant-a', 'apply', 'succeeded', '{"existing":true}',
         '2026-08-23T00:00:00.000Z', 9999999999999)
    `);

    const report = migrateSqlite(database);

    expect(report.applied).toEqual([
      "0020_takoform_deferred_operations.sql",
      "0021_takoform_provider_mutation_sagas.sql",
      "0022_takoform_admission.sql",
      "0023_takoform_host_authority.sql",
      "0024_takoform_provider_execution_leases.sql",
    ]);
    expect(
      database
        .query(
          `SELECT uid, generation, revision, resource_json, relations_json, updated_at
           FROM tf_resources WHERE name = 'existing'`,
        )
        .get(),
    ).toEqual({
      uid: "uid_existing",
      generation: "3",
      revision: "7",
      resource_json: '{"existing":true}',
      relations_json: "[]",
      updated_at: 42,
    });
    expect(
      database
        .query("SELECT id, state, resource_json FROM tf_operations WHERE id = 'op_existing'")
        .get(),
    ).toEqual({ id: "op_existing", state: "succeeded", resource_json: '{"existing":true}' });
    for (const table of [
      "tf_deferred_operations",
      "tf_operation_commit_guards",
      "tf_resource_claims",
    ]) {
      expect(() => database.query(`SELECT 1 FROM ${table} LIMIT 1`).all()).not.toThrow();
    }
  });

  test("preserves every applied 0022 checkpoint predecessor when adding profile identity", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const authorityMigration = MIGRATIONS.findIndex(
      (migration) => migration.name === "0023_takoform_host_authority.sql",
    );
    expect(authorityMigration).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, authorityMigration)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    const sha = (letter: string) => `sha256:${letter.repeat(64)}`;
    database
      .query(
        `INSERT INTO tf_form_revocation_checkpoints
           (id, publisher_key, sequence, checkpoint_digest, entries_digest,
            previous_checkpoint_digest, revoked_package_digests_json,
            policy_digest, policy_event_digest, actor, reason, event_at,
            event_digest, predecessor_digest)
         VALUES (?, ?, 1, ?, ?, ?, '[]', ?, ?, ?, ?, 7, ?, ?)`,
      )
      .run(
        "checkpoint_legacy",
        "publisher-legacy",
        sha("1"),
        sha("2"),
        sha("f"),
        sha("3"),
        sha("4"),
        "legacy-operator",
        "preserve protected row",
        sha("5"),
        sha("0"),
      );

    const report = migrateSqlite(database);

    expect(report.applied).toEqual([
      "0023_takoform_host_authority.sql",
      "0024_takoform_provider_execution_leases.sql",
    ]);
    expect(
      database
        .query(
          `SELECT checkpoint_api_version, sequence, previous_checkpoint_digest,
                  event_digest
           FROM tf_form_revocation_checkpoints WHERE id = 'checkpoint_legacy'`,
        )
        .get(),
    ).toEqual({
      checkpoint_api_version: "trust.forms.takoform.com/v1alpha1",
      sequence: 1,
      previous_checkpoint_digest: sha("f"),
      event_digest: sha("5"),
    });
    expect(() =>
      database.exec(`
        INSERT INTO tf_form_revocation_checkpoints
          (id, publisher_key, checkpoint_api_version, sequence,
           checkpoint_digest, entries_digest, previous_checkpoint_digest,
           revoked_package_digests_json, policy_digest, policy_event_digest,
           actor, reason, event_at, event_digest, predecessor_digest)
        VALUES
          ('checkpoint_canonical', 'publisher-canonical',
           'trust.forms.takoform.com/v1alpha1', 1,
           '${sha("6")}', '${sha("7")}', NULL, '[]', '${sha("8")}',
           '${sha("9")}', 'legacy-operator', 'canonical legacy genesis', 8,
           '${sha("a")}', '${sha("0")}')
      `),
    ).not.toThrow();
  });

  test("adds provider execution leases without rewriting planned or executed sagas", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const executionLeaseMigration = MIGRATIONS.findIndex(
      (migration) => migration.name === "0024_takoform_provider_execution_leases.sql",
    );
    expect(executionLeaseMigration).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, executionLeaseMigration)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database.exec(`
      INSERT INTO tf_provider_mutation_sagas
        (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
         target_space, target_api_version, target_kind, target_name,
         accepted_uid, accepted_generation, accepted_revision, phase,
         receipt_json, authority_head_digest, created_at, updated_at, expires_at)
      VALUES
        ('op_planned', 'replay-planned', 'tenant-a', '{}', 'uid_planned',
         'main', 'example.forms.invalid', 'Thing', 'planned',
         NULL, NULL, NULL, 'planned', NULL, NULL, 100, 100, 999),
        ('op_executed', 'replay-executed', 'tenant-a', '{}', 'uid_executed',
         'main', 'example.forms.invalid', 'Thing', 'executed',
         NULL, NULL, NULL, 'executed', '{"observed":{}}', NULL, 100, 100, NULL);
    `);

    const report = migrateSqlite(database);

    expect(report.applied).toEqual(["0024_takoform_provider_execution_leases.sql"]);
    expect(
      database
        .query(
          `SELECT operation_id, phase, receipt_json, execution_lease_token,
                  execution_lease_until, execution_started_at
           FROM tf_provider_mutation_sagas ORDER BY operation_id`,
        )
        .all(),
    ).toEqual([
      {
        operation_id: "op_executed",
        phase: "executed",
        receipt_json: '{"observed":{}}',
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: null,
      },
      {
        operation_id: "op_planned",
        phase: "planned",
        receipt_json: null,
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: null,
      },
    ]);
  });

  test("renames fractional usage money without changing its value", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const usageMicros = MIGRATIONS.findIndex((migration) => migration.name.startsWith("0018_"));
    expect(usageMicros).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, usageMicros)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO usage_events
           (request_id, org_id, resource_uid, meter, quantity, amount_minor, created_at)
         VALUES ('request_1', 'org_1', 'resource_1', 'object.get', 1, 123456, 'now')`,
      )
      .run();

    migrateSqlite(database);

    expect(database.query("SELECT amount_micros FROM usage_events").get()).toEqual({
      amount_micros: 123456,
    });
    expect(
      database
        .query("PRAGMA table_info(usage_events)")
        .all()
        .map((column) => String((column as { name: unknown }).name)),
    ).not.toContain("amount_minor");
  });

  test("refuses credit-lot activation until predecessor wallet data was snapshotted and reset", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const creditLots = MIGRATIONS.findIndex((migration) => migration.name.startsWith("0017_"));
    expect(creditLots).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, creditLots)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO ledger
           (id, org_id, type, ref, settled_delta, held_delta, created_at)
         VALUES ('led_old', 'org_old', 'funding', 'old-payment', 100, 0, '2026-08-01T00:00:00.000Z')`,
      )
      .run();

    expect(() => migrateSqlite(database)).toThrow(/0017_wallet_credit_lots\.sql failed/u);
    expect(
      database
        .query(
          "SELECT COUNT(*) AS count FROM sqlite_schema WHERE type = 'table' AND name = 'wallet_credit_lots'",
        )
        .get(),
    ).toEqual({ count: 0 });
    expect(database.query("SELECT settled_delta FROM ledger WHERE id = 'led_old'").get()).toEqual({
      settled_delta: 100,
    });
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
          status: {
            observed: { region: "global" },
            outputs: { bucket: "opaque" },
          },
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
