import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

const ARTIFACT_LIFECYCLE = "0031_takoform_artifact_lifecycle.sql";
const RUNTIME_INPUT_PREPARATIONS = "0032_worker_runtime_input_preparations.sql";
const ARTIFACT_FORWARD_REPAIR = "0033_takoform_artifact_lifecycle_forward_repair.sql";
const CLOUDFLARE_MANAGED_WORKER_STATE = "0034_cloudflare_managed_worker_state.sql";
const WORKER_ENDPOINT_ORIGIN_RESERVATION_V2 = "0035_worker_endpoint_origin_reservation_v2.sql";
const PROVIDER_REPAIR_AND_MANAGED_SCHEDULE_RECONCILIATION =
  "0036_provider_repair_and_managed_schedule_reconciliation.sql";
const RUNTIME_INPUT_PREPARATION_V2 = "0037_worker_runtime_input_preparation_v2.sql";
const SELFHOST_EDGE_KV = "0038_selfhost_edge_kv.sql";
const LIVE_NATIVE_CLAIM_ACROSS_TENANTS = "0039_takoform_live_native_claim_across_tenants.sql";
const SELFHOST_QUEUES_AND_SCHEDULES = "0040_selfhost_queues_and_schedules.sql";
const SELFHOST_OBJECT_BUCKETS = "0041_selfhost_object_buckets.sql";
const WORKER_ENDPOINT_ORIGIN_RESERVATION_SPACE_ID =
  "0042_worker_endpoint_origin_reservation_space_id.sql";
const ARTIFACT_BLOB_IO_FENCES = "0043_artifact_blob_io_fences.sql";
const ARTIFACT_CONSUMER_RESOLUTION_RECEIPTS = "0044_artifact_consumer_resolution_receipts.sql";
const CLOUDFLARE_PROVIDER_EXECUTOR_OPERATIONS = "0045_cloudflare_provider_executor_operations.sql";
const EXACT_ARTIFACT_RECOVERY_RECEIPTS = "0046_exact_artifact_recovery_receipts.sql";
const POST_ARTIFACT_LINEAGE_MIGRATIONS = [
  ARTIFACT_FORWARD_REPAIR,
  CLOUDFLARE_MANAGED_WORKER_STATE,
  WORKER_ENDPOINT_ORIGIN_RESERVATION_V2,
  PROVIDER_REPAIR_AND_MANAGED_SCHEDULE_RECONCILIATION,
  RUNTIME_INPUT_PREPARATION_V2,
  SELFHOST_EDGE_KV,
  LIVE_NATIVE_CLAIM_ACROSS_TENANTS,
  SELFHOST_QUEUES_AND_SCHEDULES,
  SELFHOST_OBJECT_BUCKETS,
  WORKER_ENDPOINT_ORIGIN_RESERVATION_SPACE_ID,
  ARTIFACT_BLOB_IO_FENCES,
  ARTIFACT_CONSUMER_RESOLUTION_RECEIPTS,
  CLOUDFLARE_PROVIDER_EXECUTOR_OPERATIONS,
  EXACT_ARTIFACT_RECOVERY_RECEIPTS,
] as const;
const MODIFIED_ARTIFACT_LIFECYCLE_SQL = readFileSync(
  new URL("./fixtures/migrations/0031_takoform_artifact_lifecycle.modified.sql", import.meta.url),
  "utf8",
);

type ArtifactLifecycleLineage = "original" | "modified";

interface ArtifactLineageFixture {
  readonly database: Database;
  readonly manifestDigest: string;
  readonly modifiedRowsBeforeRepair:
    | {
        readonly roots: Record<string, unknown>[];
        readonly uncertainties: Record<string, unknown>[];
        readonly receipts: Record<string, unknown>[];
      }
    | undefined;
  readonly originalRootsBeforeRepair: readonly Record<string, unknown>[];
}

function prepareArtifactLineage(lineage: ArtifactLifecycleLineage): ArtifactLineageFixture {
  const database = new Database(":memory:");
  database.exec(`
    CREATE TABLE applied_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const lifecycleIndex = MIGRATIONS.findIndex((migration) => migration.name === ARTIFACT_LIFECYCLE);
  expect(lifecycleIndex).toBeGreaterThan(0);
  for (const migration of MIGRATIONS.slice(0, lifecycleIndex)) {
    applyHistoricalMigration(database, migration.name, migration.sql);
  }

  const manifestDigest = `sha256:${"1".repeat(64)}`;
  const blobDigest = `sha256:${"2".repeat(64)}`;
  const legacyDigest = `sha256:${"3".repeat(64)}`;
  const manifest = JSON.stringify({
    apiVersion: "artifacts.takoform.com/v1alpha1",
    kind: "WorkerBundle",
    mainModule: "worker.mjs",
    modules: [
      {
        name: "worker.mjs",
        mediaType: "application/javascript+module",
        size: 1,
        digest: blobDigest,
      },
    ],
  });
  const resource = JSON.stringify({
    apiVersion: "edge.forms.takoform.com/v1beta1",
    kind: "WorkerBundle",
    metadata: {
      space: "default",
      name: "fixture-worker",
      uid: "uid_fixture_worker",
    },
    form: {
      formRef: {
        apiVersion: "edge.forms.takoform.com",
        kind: "WorkerBundle",
        definitionVersion: "1.0.0",
        schemaDigest: `sha256:${"4".repeat(64)}`,
      },
    },
    spec: { manifestDigest },
  });
  database
    .query(
      `INSERT INTO tf_artifact_uploads
         (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
       VALUES (?, 'tenant_fixture', 'run:fixture', ?, ?, 100)`,
    )
    .run("up_fixture", manifest, manifestDigest);
  database
    .query(
      `INSERT INTO tf_artifact_manifests (digest, manifest_json, created_at)
       VALUES (?, ?, 100)`,
    )
    .run(manifestDigest, manifest);
  database
    .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, ?)")
    .run("tenant_fixture", legacyDigest, "blob");
  database
    .query(
      `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
       VALUES (?, 201, ?, 1000)`,
    )
    .run(
      ["tenant_fixture", "run:fixture", "start", "fixture"].join("\u0000"),
      JSON.stringify({ uploadId: "up_fixture", manifestDigest }),
    );
  database
    .query(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, relations_json, package_digest, implementation_digest, updated_at)
       VALUES ('tenant_fixture', 'default', 'edge.forms.takoform.com/v1beta1',
               'WorkerBundle', 'fixture-worker', 'uid_fixture_worker', '1',
               'revision-fixture', ?, '[]', NULL, NULL, 100)`,
    )
    .run(resource);
  database.exec(`
    INSERT INTO tf_resource_deployments
      (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
       provider_installation_ref, native_id, native_claimed, state,
       observed_json, outputs_json, created_at, updated_at)
    VALUES
      ('tenant_fixture', 'dep_fixture', 'uid_fixture_worker', 'offering.fixture',
       'provider.fixture', 'installation.fixture', 'native-fixture', 0,
       'retained', '{}', '{}', 100, 100),
      ('tenant_fixture', 'dep_unknown_fixture', 'uid_missing_fixture', 'offering.fixture',
       'provider.fixture', 'installation.fixture', 'native-unknown-fixture', 0,
       'retained', '{}', '{}', 110, 110);
  `);

  const lifecycleSql =
    lineage === "original"
      ? (MIGRATIONS[lifecycleIndex]?.sql ?? "")
      : MODIFIED_ARTIFACT_LIFECYCLE_SQL;
  applyHistoricalMigration(database, ARTIFACT_LIFECYCLE, lifecycleSql);
  const runtimeInputs = MIGRATIONS.find(
    (migration) => migration.name === RUNTIME_INPUT_PREPARATIONS,
  );
  expect(runtimeInputs).toBeDefined();
  applyHistoricalMigration(database, RUNTIME_INPUT_PREPARATIONS, runtimeInputs?.sql ?? "");

  if (lineage === "modified") {
    database.exec(`
      UPDATE tf_artifact_roots
      SET fence = 5
      WHERE tenant_id = 'tenant_fixture' AND root_kind = 'upload'
        AND root_id = 'up_fixture' AND digest = '${manifestDigest}';

      UPDATE tf_artifact_consumer_uncertainties
      SET state = 'resolved', fence = 4, resolved_at = 150
      WHERE tenant_id = 'tenant_fixture' AND consumer_id = 'dep_fixture';

      UPDATE tf_artifact_consumer_uncertainties
      SET fence = 9
      WHERE tenant_id = 'tenant_fixture' AND consumer_id = 'dep_unknown_fixture';

      INSERT INTO tf_artifact_roots
        (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
         expires_at, release_reason, created_at, released_at)
      VALUES
        ('tenant_fixture', 'resource', 'retired-fixture', 'manifest',
         'sha256:${"5".repeat(64)}', 'released', 6, NULL, 'consumer_replaced', 100, 200),
        ('tenant_fixture', 'replay', 'retired-replay-fixture', 'manifest',
         'sha256:${"6".repeat(64)}', 'released', 8, 180, 'replay_replaced', 100, 200);

      INSERT INTO tf_artifact_owner_closure_receipts
        (receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
         manifest_digest, upload_fence, root_fence, state, closed_at,
         expires_at, created_at, updated_at)
      VALUES
        ('receipt_fixture', 7, 'tenant_fixture', 'run:fixture', 'up_fixture',
         '${manifestDigest}', 1, 5, 'closed', 120, 1000, 120, 120);
    `);
  }

  const originalRootsBeforeRepair = database
    .query(
      `SELECT tenant_id, root_kind, root_id, target_kind, digest, state, fence,
              expires_at, release_reason, created_at, released_at
       FROM tf_artifact_roots ORDER BY tenant_id, root_kind, root_id, target_kind, digest`,
    )
    .all() as Record<string, unknown>[];
  const modifiedRowsBeforeRepair =
    lineage === "modified"
      ? {
          roots: originalRootsBeforeRepair,
          uncertainties: database
            .query(
              `SELECT tenant_id, consumer_kind, consumer_id, state, fence, reason,
                      created_at, resolved_at
               FROM tf_artifact_consumer_uncertainties
               ORDER BY tenant_id, consumer_kind, consumer_id`,
            )
            .all() as Record<string, unknown>[],
          receipts: database
            .query(
              `SELECT receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
                      manifest_digest, upload_fence, root_fence, state, closed_at,
                      expires_at, created_at, updated_at
               FROM tf_artifact_owner_closure_receipts ORDER BY receipt_id`,
            )
            .all() as Record<string, unknown>[],
        }
      : undefined;

  return {
    database,
    manifestDigest,
    modifiedRowsBeforeRepair,
    originalRootsBeforeRepair,
  };
}

function applyHistoricalMigration(database: Database, name: string, sql: string): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(sql);
    database
      .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'fixture')")
      .run(name);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function canonicalSqliteSchema(database: Database): readonly Record<string, unknown>[] {
  return (
    database
      .query(
        `SELECT type, name, tbl_name, sql
         FROM sqlite_schema
         WHERE sql IS NOT NULL
         ORDER BY type, name`,
      )
      .all() as { type: string; name: string; tbl_name: string; sql: string }[]
  ).map((row) => ({
    type: row.type,
    name: row.name,
    tbl_name: row.tbl_name,
    sql: row.sql,
  }));
}

function sqliteTableSql(database: Database, table: string): string {
  const row = database
    .query("SELECT sql FROM sqlite_schema WHERE type = 'table' AND name = ?")
    .get(table) as { sql: unknown } | null;
  if (!row || typeof row.sql !== "string") {
    throw new Error(`missing SQLite table schema for ${table}`);
  }
  return row.sql;
}

function sqliteIndexes(database: Database, table: string): readonly Record<string, unknown>[] {
  return database
    .query(
      `SELECT name, sql FROM sqlite_schema
       WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL
       ORDER BY name`,
    )
    .all(table) as Record<string, unknown>[];
}

function normalizeSqliteSql(sql: string): string {
  return sql
    .replace(/["`]/g, "")
    .replace(/\s+/gu, " ")
    .replace(/\s*,\s*/gu, ",")
    .trim();
}

function expectWidenedTableSchema(
  before: string,
  after: string,
  replacements: readonly (readonly [string, string])[],
): void {
  let expected = before;
  for (const [narrow, wide] of replacements) {
    expect(expected).toContain(narrow);
    expected = expected.replace(narrow, wide);
  }
  expect(normalizeSqliteSql(after)).toBe(normalizeSqliteSql(expected));
}

function artifactRoots(database: Database): readonly Record<string, unknown>[] {
  return database
    .query(
      `SELECT tenant_id, root_kind, root_id, target_kind, digest, state, fence,
              expires_at, release_reason, created_at, released_at
       FROM tf_artifact_roots ORDER BY tenant_id, root_kind, root_id, target_kind, digest`,
    )
    .all() as Record<string, unknown>[];
}

/**
 * A self-hosted deployment starts with an empty file. If the first run does
 * not produce a schema, it produces a server that answers every request with
 * "no such table" — which is what it did.
 */
describe("bringing a local database up to date", () => {
  test("keeps the applied artifact lifecycle migration immutable and repairs it forward", () => {
    const lifecycle = MIGRATIONS.find(
      (migration) => migration.name === "0031_takoform_artifact_lifecycle.sql",
    );
    const repair = MIGRATIONS.find(
      (migration) => migration.name === "0033_takoform_artifact_lifecycle_forward_repair.sql",
    );

    expect(lifecycle).toBeDefined();
    expect(
      createHash("sha256")
        .update(lifecycle?.sql ?? "")
        .digest("hex"),
    ).toBe("dda3a01d915ef5871ad5a7fb8499761bce4309243044aa0b206076e1cf9bda45");
    expect(repair).toBeDefined();
    expect(
      MIGRATIONS.slice(-(POST_ARTIFACT_LINEAGE_MIGRATIONS.length + 1)).map(
        (migration) => migration.name,
      ),
    ).toEqual([RUNTIME_INPUT_PREPARATIONS, ...POST_ARTIFACT_LINEAGE_MIGRATIONS]);
    expect(createHash("sha256").update(MODIFIED_ARTIFACT_LIFECYCLE_SQL).digest("hex")).toBe(
      "9894eb347b8544875e3ebaef9802e9f2ab2680ff819a05b8fca4085d1c6688a7",
    );
  });

  test("appends provider execution receipts before exact recovery receipts", () => {
    const receiptMigrationIndex = MIGRATIONS.findIndex(
      (migration) => migration.name === ARTIFACT_CONSUMER_RESOLUTION_RECEIPTS,
    );
    expect(receiptMigrationIndex).toBeGreaterThan(0);
    expect(MIGRATIONS[receiptMigrationIndex - 1]?.name).toBe(ARTIFACT_BLOB_IO_FENCES);
    expect(MIGRATIONS[receiptMigrationIndex + 1]?.name).toBe(
      CLOUDFLARE_PROVIDER_EXECUTOR_OPERATIONS,
    );
    expect(MIGRATIONS[receiptMigrationIndex + 2]?.name).toBe(EXACT_ARTIFACT_RECOVERY_RECEIPTS);

    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    for (const migration of MIGRATIONS.slice(0, receiptMigrationIndex)) {
      applyHistoricalMigration(database, migration.name, migration.sql);
    }

    expect(migrateSqlite(database).applied).toEqual([
      ARTIFACT_CONSUMER_RESOLUTION_RECEIPTS,
      CLOUDFLARE_PROVIDER_EXECUTOR_OPERATIONS,
      EXACT_ARTIFACT_RECOVERY_RECEIPTS,
    ]);

    const digest = (character: string) => `sha256:${character.repeat(64)}`;
    const insert = database.query(`
      INSERT INTO tf_artifact_consumer_resolution_receipts
        (receipt_id, tenant_id, deployment_id, uncertainty_fence, idempotency_key,
         plan_digest, snapshot_digest, resolution, manifest_digest,
         provider_evidence_digest, deployment_state_before,
         deployment_updated_at_before, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      "acr_sqlite_fixture",
      "tenant_fixture",
      "deployment_fixture",
      1,
      "repair:sqlite:fixture",
      digest("1"),
      digest("2"),
      "terminalized_absent",
      null,
      digest("3"),
      "retained",
      100,
      101,
    );

    expect(() =>
      insert.run(
        "acr_duplicate_fence",
        "tenant_fixture",
        "deployment_fixture",
        1,
        "repair:sqlite:other",
        digest("4"),
        digest("5"),
        "terminalized_absent",
        null,
        digest("6"),
        "retained",
        100,
        102,
      ),
    ).toThrow(/UNIQUE|constraint/iu);
    expect(() =>
      database
        .query(
          "UPDATE tf_artifact_consumer_resolution_receipts SET created_at = 102 WHERE receipt_id = 'acr_sqlite_fixture'",
        )
        .run(),
    ).toThrow("artifact_consumer_resolution_receipt_immutable");
    expect(() =>
      database
        .query(
          "DELETE FROM tf_artifact_consumer_resolution_receipts WHERE receipt_id = 'acr_sqlite_fixture'",
        )
        .run(),
    ).toThrow("artifact_consumer_resolution_receipt_durable");
  });

  /**
   * One provider installation is one account, so one native object has one
   * live claim in it. The migration states that; a database where two tenants
   * already share one has to be resolved by hand rather than converged.
   */
  describe("live native claim uniqueness across tenants", () => {
    const LIVE_CLAIM = (tenant: string, id: string) =>
      `INSERT INTO tf_resource_deployments
         (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
          provider_installation_ref, native_id, native_claimed, state,
          observed_json, outputs_json, created_at, updated_at)
       VALUES ('${tenant}', '${id}', 'uid_${id}', 'offering.test', 'cloudflare',
               'installation.test', 'r2:ts-shared', 0, 'active', '{}', '{}', 1, 1)`;

    function upTo(exclusive: string): Database {
      const database = new Database(":memory:");
      database.exec(`
        CREATE TABLE applied_migrations (
          name TEXT PRIMARY KEY NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS) {
        if (migration.name === exclusive) break;
        database.exec(migration.sql);
        database.exec(
          `INSERT INTO applied_migrations (name, applied_at) VALUES ('${migration.name}', 'x')`,
        );
      }
      return database;
    }

    test("refuses to converge a database where two tenants share a live claim", () => {
      const database = upTo(LIVE_NATIVE_CLAIM_ACROSS_TENANTS);
      database.exec(LIVE_CLAIM("tenant_a", "dep_a"));
      database.exec(LIVE_CLAIM("tenant_b", "dep_b"));

      expect(() => migrateSqlite(database)).toThrow(
        /takoform_live_native_claim_shared_across_tenants/u,
      );
      // Forward only: the refusal leaves the database on its previous version.
      expect(
        database
          .query(
            `SELECT COUNT(*) AS count FROM applied_migrations WHERE name = '${LIVE_NATIVE_CLAIM_ACROSS_TENANTS}'`,
          )
          .get(),
      ).toEqual({ count: 0 });
      expect(database.query("SELECT COUNT(*) AS count FROM tf_resource_deployments").get()).toEqual(
        { count: 2 },
      );
    });

    test("converges a database whose live claims are already distinct, then holds them", () => {
      const database = upTo(LIVE_NATIVE_CLAIM_ACROSS_TENANTS);
      database.exec(LIVE_CLAIM("tenant_a", "dep_a"));
      // Everything from this migration to the head, because `upTo` seeded the
      // database at the version just before it.
      expect(migrateSqlite(database).applied).toEqual([
        LIVE_NATIVE_CLAIM_ACROSS_TENANTS,
        SELFHOST_QUEUES_AND_SCHEDULES,
        SELFHOST_OBJECT_BUCKETS,
        WORKER_ENDPOINT_ORIGIN_RESERVATION_SPACE_ID,
        ARTIFACT_BLOB_IO_FENCES,
        ARTIFACT_CONSUMER_RESOLUTION_RECEIPTS,
        CLOUDFLARE_PROVIDER_EXECUTOR_OPERATIONS,
        EXACT_ARTIFACT_RECOVERY_RECEIPTS,
      ]);
      expect(() => database.exec(LIVE_CLAIM("tenant_b", "dep_b"))).toThrow(/UNIQUE|constraint/iu);
    });
  });

  test("widens every persisted Space contract without changing rows, checks, or indexes", () => {
    const migrationIndex = MIGRATIONS.findIndex(
      (migration) => migration.name === WORKER_ENDPOINT_ORIGIN_RESERVATION_SPACE_ID,
    );
    expect(migrationIndex).toBeGreaterThan(0);
    const database = new Database(":memory:");
    for (const migration of MIGRATIONS.slice(0, migrationIndex)) {
      database.exec(migration.sql);
    }
    const offeringDigest = `sha256:${"a".repeat(64)}`;
    database.exec(`
      INSERT INTO worker_endpoint_origin_reservations
        (organization_id, reservation_id, reservation_format,
         legacy_space, legacy_worker_name, legacy_endpoint_name, requested_subdomain,
         canonical_public_origin, provider_pack_ref, provider_installation_ref,
         offering_id, offering_digest, requested_ttl_seconds, expires_at,
         state, revision, bound_space, bound_worker_name,
         worker_resource_uid, worker_resource_revision, bound_endpoint_name,
         endpoint_resource_uid, endpoint_resource_revision,
         created_at, updated_at, released_at)
      VALUES
        ('org_01', 'reservation_legacy',
         'takoserver.worker-endpoint-origin-reservation.v1',
         'legacy-space', 'legacy-worker', 'legacy-endpoint', NULL,
         'https://legacy.example.test', 'pack', 'installation',
         'offering', '${offeringDigest}', 600, 1000,
         'activated', 3, 'legacy-space', 'legacy-worker',
         'uid-legacy-worker', '2', 'legacy-endpoint',
         'uid-legacy-endpoint', '4', 1, 2, NULL),
        ('org_01', 'reservation_current',
         'takoserver.worker-endpoint-origin-reservation.v2',
         NULL, NULL, NULL, 'current',
         'https://current.example.test', 'pack', 'installation',
         'offering', '${offeringDigest}', 600, 1000,
         'released', 4, 'tenant:fixture', 'current-worker',
         'uid-current-worker', '1', 'current-endpoint',
         'uid-current-endpoint', '3', 1, 3, 3);

      INSERT INTO tf_provider_mutation_sagas
        (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
         target_space, target_api_version, target_kind, target_name,
         accepted_uid, accepted_generation, accepted_revision, phase,
         receipt_json, created_at, updated_at, expires_at, authority_head_digest,
         execution_lease_token, execution_lease_until, execution_started_at,
         provider_handle, provider_outcome)
      VALUES
        ('operation_planned', 'replay_planned', 'tenant_saga', 'fp-planned',
         'uid-planned', 'space-planned', 'edge.forms.takoform.com/v1beta1',
         'WorkerBundle', 'worker-planned', NULL, NULL, NULL, 'planned', NULL,
         10, 20, 100, 'sha256:${"b".repeat(64)}', 'lease-planned', 30, 20,
         'handle-planned', 'indeterminate'),
        ('operation_executed', 'replay_executed', 'tenant_saga', 'fp-executed',
         'uid-executed', 'space-executed', 'edge.forms.takoform.com/v1beta1',
         'WorkerBundle', 'worker-executed', 'uid-accepted', '7', 'revision-7',
         'executed', '{"ok":true}', 30, 40, NULL,
         'sha256:${"c".repeat(64)}', 'lease-executed', 50, 40,
         'handle-executed', 'running');

      INSERT INTO worker_runtime_input_preparations
        (organization_id, operation_key, preparation_id, apply_commitment,
         canonical_public_origin, binding_names_json, sealed_payload, seal_nonce,
         seal_key_id, state, fence, host_operation_id, claim_owner,
         claim_expires_at, claimed_resource_uid, space, worker_name,
         worker_resource_uid, bundle_name, consumed_receipt_digest, expires_at,
         created_at, updated_at, consumed_at, revoked_at)
      VALUES
        ('org_runtime', 'operation-key-claimed', 'prep-claimed',
         'sha256:${"d".repeat(64)}', 'https://claimed.example.test',
         '{"TOKEN":"secret"}', 'sealed-payload', 'seal-nonce', 'seal-key',
         'claimed', 2, 'host-op-claimed', 'claim-owner', 50,
         'uid-runtime-claimed', 'space-claimed', 'worker-claimed',
         'uid-runtime-claimed', 'bundle-claimed', NULL, 100, 1, 2,
         NULL, NULL),
        ('org_runtime', 'operation-key-consumed', 'prep-consumed',
         'sha256:${"e".repeat(64)}', 'https://consumed.example.test',
         '{"TOKEN":"consumed"}', NULL, NULL, NULL,
         'consumed', 3, 'host-op-consumed', 'claim-owner-consumed', 60,
         'uid-runtime-consumed', 'space-consumed', 'worker-consumed',
         'uid-runtime-consumed', 'bundle-consumed', 'receipt-consumed', 200, 3, 4,
         5, NULL);
    `);
    const tableNames = [
      "worker_endpoint_origin_reservations",
      "tf_provider_mutation_sagas",
      "worker_runtime_input_preparations",
    ] as const;
    const tableBefore = new Map(
      tableNames.map((table) => [table, sqliteTableSql(database, table)]),
    );
    const rowsBefore = new Map(
      tableNames.map((table) => [table, database.query(`SELECT * FROM ${table}`).all()]),
    );
    const indexesBefore = new Map(
      tableNames.map((table) => [table, sqliteIndexes(database, table)]),
    );

    // Read the migration file directly so this focused test also exercises an
    // unpublished migration before generated db-schema.ts is refreshed.
    const migrationSql = readFileSync(
      new URL(
        "../migrations/0042_worker_endpoint_origin_reservation_space_id.sql",
        import.meta.url,
      ),
      "utf8",
    );
    database.exec(migrationSql);

    for (const table of tableNames) {
      const expectedRows = rowsBefore.get(table);
      const expectedIndexes = indexesBefore.get(table);
      if (!expectedRows || !expectedIndexes) throw new TypeError(`missing fixture for ${table}`);
      expect(database.query(`SELECT * FROM ${table}`).all()).toEqual(expectedRows);
      expect(sqliteIndexes(database, table)).toEqual(expectedIndexes);
      expect(
        database.query(`SELECT name FROM sqlite_schema WHERE name LIKE '%_forward_space_id'`).all(),
      ).toEqual([]);
    }
    expectWidenedTableSchema(
      tableBefore.get("worker_endpoint_origin_reservations") ?? "",
      sqliteTableSql(database, "worker_endpoint_origin_reservations"),
      [
        [
          "CHECK (legacy_space IS NULL OR length(legacy_space) BETWEEN 1 AND 128)",
          "CHECK (legacy_space IS NULL OR length(legacy_space) BETWEEN 1 AND 255)",
        ],
        [
          "CHECK (bound_space IS NULL OR length(bound_space) BETWEEN 1 AND 128)",
          "CHECK (bound_space IS NULL OR length(bound_space) BETWEEN 1 AND 255)",
        ],
      ],
    );
    expectWidenedTableSchema(
      tableBefore.get("tf_provider_mutation_sagas") ?? "",
      sqliteTableSql(database, "tf_provider_mutation_sagas"),
      [
        [
          "CHECK (length(target_space) BETWEEN 1 AND 128)",
          "CHECK (length(target_space) BETWEEN 1 AND 255)",
        ],
      ],
    );
    expectWidenedTableSchema(
      tableBefore.get("worker_runtime_input_preparations") ?? "",
      sqliteTableSql(database, "worker_runtime_input_preparations"),
      [
        [
          "CHECK (space IS NULL OR length(space) BETWEEN 1 AND 128)",
          "CHECK (space IS NULL OR length(space) BETWEEN 1 AND 255)",
        ],
      ],
    );

    // SQLite length(TEXT) counts Unicode code points. An astral character is
    // one code point even though JavaScript UTF-16 uses two code units.
    const maximumSpace = `tenant:${"😀".repeat(248)}`;
    expect([...maximumSpace]).toHaveLength(255);
    const oversizedSpace = `${maximumSpace}x`;
    const widenedColumns = [
      ["worker_endpoint_origin_reservations", "legacy_space", "reservation_legacy"],
      ["worker_endpoint_origin_reservations", "bound_space", "reservation_current"],
      ["tf_provider_mutation_sagas", "target_space", "operation_planned"],
      ["tf_provider_mutation_sagas", "target_space", "operation_executed"],
      ["worker_runtime_input_preparations", "space", "operation-key-claimed"],
      ["worker_runtime_input_preparations", "space", "operation-key-consumed"],
    ] as const;
    for (const [table, column, key] of widenedColumns) {
      const keyColumn =
        table === "worker_endpoint_origin_reservations"
          ? "reservation_id"
          : table === "tf_provider_mutation_sagas"
            ? "operation_id"
            : "operation_key";
      database
        .query(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`)
        .run(maximumSpace, key);
      expect(
        database
          .query(`SELECT length(${column}) AS space_length FROM ${table} WHERE ${keyColumn} = ?`)
          .get(key),
      ).toEqual({ space_length: 255 });
      expect(() =>
        database
          .query(`UPDATE ${table} SET ${column} = ? WHERE ${keyColumn} = ?`)
          .run(oversizedSpace, key),
      ).toThrow(/CHECK constraint/iu);
    }
  });

  test("converges fresh, original 0031, and modified 0031 lineages without losing rows", () => {
    const fresh = new Database(":memory:");
    expect(migrateSqlite(fresh).applied.slice(-POST_ARTIFACT_LINEAGE_MIGRATIONS.length)).toEqual([
      ...POST_ARTIFACT_LINEAGE_MIGRATIONS,
    ]);

    const original = prepareArtifactLineage("original");
    const modified = prepareArtifactLineage("modified");
    expect(migrateSqlite(original.database).applied).toEqual([...POST_ARTIFACT_LINEAGE_MIGRATIONS]);
    expect(migrateSqlite(modified.database).applied).toEqual([...POST_ARTIFACT_LINEAGE_MIGRATIONS]);

    expect(canonicalSqliteSchema(original.database)).toEqual(canonicalSqliteSchema(fresh));
    expect(canonicalSqliteSchema(modified.database)).toEqual(canonicalSqliteSchema(fresh));

    const originalRootsAfterRepair = artifactRoots(original.database);
    for (const row of original.originalRootsBeforeRepair) {
      expect(originalRootsAfterRepair).toContainEqual(row);
    }
    expect(
      original.database
        .query(
          `SELECT root_kind, root_id, state, fence
           FROM tf_artifact_roots
           WHERE tenant_id = 'tenant_fixture'
           ORDER BY root_kind, root_id`,
        )
        .all(),
    ).toEqual([
      { root_kind: "deployment", root_id: "dep_fixture", state: "active", fence: 1 },
      {
        root_kind: "legacy-hold",
        root_id: `blob:sha256:${"3".repeat(64)}`,
        state: "active",
        fence: 1,
      },
      {
        root_kind: "replay",
        root_id: ["tenant_fixture", "run:fixture", "start", "fixture"].join("\u0000"),
        state: "active",
        fence: 1,
      },
      {
        root_kind: "resource",
        root_id: [
          "default",
          "edge.forms.takoform.com/v1beta1",
          "WorkerBundle",
          "fixture-worker",
        ].join("\u0000"),
        state: "active",
        fence: 1,
      },
      { root_kind: "upload", root_id: "up_fixture", state: "active", fence: 1 },
    ]);
    expect(
      original.database
        .query(
          `SELECT consumer_id, state, fence, reason, created_at, resolved_at
           FROM tf_artifact_consumer_uncertainties
           WHERE tenant_id = 'tenant_fixture'
           ORDER BY consumer_id`,
        )
        .all(),
    ).toEqual([
      {
        consumer_id: "dep_fixture",
        state: "active",
        fence: 1,
        reason: "historical_deployment_digest_unknown",
        created_at: 100,
        resolved_at: null,
      },
      {
        consumer_id: "dep_unknown_fixture",
        state: "active",
        fence: 1,
        reason: "historical_deployment_digest_unknown",
        created_at: 110,
        resolved_at: null,
      },
    ]);

    const modifiedBefore = modified.modifiedRowsBeforeRepair;
    expect(modifiedBefore).toBeDefined();
    if (!modifiedBefore) throw new Error("modified lineage fixture is missing pre-repair rows");
    const modifiedRootsAfterRepair = artifactRoots(modified.database);
    expect(modifiedRootsAfterRepair).toEqual(modifiedBefore.roots);
    expect(
      modified.database
        .query(
          `SELECT tenant_id, consumer_kind, consumer_id, state, fence, reason,
                  created_at, resolved_at
           FROM tf_artifact_consumer_uncertainties
           ORDER BY tenant_id, consumer_kind, consumer_id`,
        )
        .all(),
    ).toEqual(modifiedBefore.uncertainties);
    expect(
      modified.database
        .query(
          `SELECT receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
                  manifest_digest, upload_fence, root_fence, state, closed_at,
                  expires_at, created_at, updated_at
           FROM tf_artifact_owner_closure_receipts ORDER BY receipt_id`,
        )
        .all(),
    ).toEqual(modifiedBefore.receipts);
  });

  test("accepts the expanded root lifecycle and rejects undeclared values", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const insert = database.query(`
      INSERT INTO tf_artifact_roots
        (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
         expires_at, release_reason, created_at, released_at)
      VALUES ('tenant_checks', ?, ?, 'manifest', ?, 'released', 2, ?, ?, 10, 20)
    `);

    expect(() =>
      insert.run(
        "resource",
        "resource-check",
        `sha256:${"7".repeat(64)}`,
        null,
        "consumer_replaced",
      ),
    ).not.toThrow();
    expect(() =>
      insert.run(
        "deployment",
        "deployment-check",
        `sha256:${"8".repeat(64)}`,
        null,
        "consumer_closed",
      ),
    ).not.toThrow();
    expect(() =>
      insert.run("replay", "replay-check", `sha256:${"9".repeat(64)}`, 15, "replay_replaced"),
    ).not.toThrow();
    expect(() =>
      insert.run("undeclared", "invalid-kind", `sha256:${"a".repeat(64)}`, null, "consumer_closed"),
    ).toThrow();
    expect(() =>
      insert.run(
        "resource",
        "invalid-reason",
        `sha256:${"b".repeat(64)}`,
        null,
        "undeclared_reason",
      ),
    ).toThrow();
  });

  for (const lineage of ["original", "modified"] as const) {
    test(`keeps previous and current Worker upload writes compatible after ${lineage} 0031`, () => {
      const { database } = prepareArtifactLineage(lineage);
      expect(migrateSqlite(database).applied).toEqual([...POST_ARTIFACT_LINEAGE_MIGRATIONS]);
      const previousManifestDigest = `sha256:${(lineage === "original" ? "c" : "d").repeat(64)}`;
      const currentManifestDigest = `sha256:${(lineage === "original" ? "e" : "f").repeat(64)}`;
      const previousManifest = JSON.stringify({
        apiVersion: "artifacts.takoform.com/v1alpha1",
        kind: "WorkerBundle",
        mainModule: "worker.mjs",
        modules: [],
      });

      database
        .query(
          `INSERT INTO tf_artifact_uploads
             (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
           VALUES (?, 'tenant_compat', 'run:compat', ?, ?, 300)`,
        )
        .run(`up_previous_${lineage}`, previousManifest, previousManifestDigest);
      expect(
        database
          .query(
            `SELECT upload.lifecycle_state, upload.lifecycle_fence, upload.updated_at,
                    root.state AS root_state, root.fence AS root_fence
             FROM tf_artifact_uploads AS upload
             JOIN tf_artifact_roots AS root
               ON root.tenant_id = upload.tenant_id AND root.root_kind = 'upload'
              AND root.root_id = upload.id AND root.digest = upload.manifest_digest
             WHERE upload.id = ?`,
          )
          .get(`up_previous_${lineage}`),
      ).toEqual({
        lifecycle_state: "open",
        lifecycle_fence: 1,
        updated_at: 300,
        root_state: "active",
        root_fence: 1,
      });

      database.exec("BEGIN IMMEDIATE");
      try {
        database
          .query(
            `INSERT INTO tf_artifact_uploads
               (id, tenant_id, principal_id, manifest_json, manifest_digest,
                created_at, lifecycle_state, lifecycle_fence, updated_at)
             VALUES (?, 'tenant_compat', 'run:compat', ?, ?, 400, 'open', 1, 400)`,
          )
          .run(`up_current_${lineage}`, previousManifest, currentManifestDigest);
        database
          .query(
            `INSERT INTO tf_artifact_roots
               (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
                expires_at, release_reason, created_at, released_at)
             VALUES ('tenant_compat', 'upload', ?, 'manifest', ?, 'active', 1,
                     NULL, NULL, 400, NULL)`,
          )
          .run(`up_current_${lineage}`, currentManifestDigest);
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
      expect(
        database
          .query(
            `SELECT upload.lifecycle_state, upload.lifecycle_fence, upload.updated_at,
                    root.state AS root_state, root.fence AS root_fence
             FROM tf_artifact_uploads AS upload
             JOIN tf_artifact_roots AS root
               ON root.tenant_id = upload.tenant_id AND root.root_kind = 'upload'
              AND root.root_id = upload.id AND root.digest = upload.manifest_digest
             WHERE upload.id = ?`,
          )
          .get(`up_current_${lineage}`),
      ).toEqual({
        lifecycle_state: "open",
        lifecycle_fence: 1,
        updated_at: 400,
        root_state: "active",
        root_fence: 1,
      });
    });
  }

  test("creates everything on a fresh file", () => {
    const database = new Database(":memory:");
    const report = migrateSqlite(database);
    expect(report.applied).toEqual(MIGRATIONS.map((migration) => migration.name));

    // The tables the product actually needs on its first request.
    for (const table of [
      "principals",
      "orgs",
      "ledger",
      "integration_e2e_credential_pair_operations",
      "tf_artifact_consumer_uncertainties",
      "tf_artifact_gc_candidates",
      "tf_artifact_blob_io_leases",
      "tf_artifact_blob_io_results",
      "tf_artifact_manifest_members",
      "tf_artifact_owner_closure_receipts",
      "tf_artifact_roots",
      "tf_cloudflare_provider_executor_operations",
      "tf_resources",
      "tf_resource_attachments",
      "tf_resource_deployments",
      "tf_deferred_operations",
      "tf_operation_commit_guards",
      "tf_resource_claims",
      "tf_resource_deletion_attestations",
      "tf_resource_provider_effects",
      "worker_endpoint_origin_reservations",
      "worker_runtime_input_preparations",
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

  test("appends the pair lifecycle without reinterpreting historical single-key rows", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const pairLifecycle = MIGRATIONS.findIndex(
      (migration) => migration.name === "0030_integration_e2e_credential_pairs.sql",
    );
    expect(MIGRATIONS.slice(pairLifecycle).map((migration) => migration.name)).toEqual([
      "0030_integration_e2e_credential_pairs.sql",
      ARTIFACT_LIFECYCLE,
      RUNTIME_INPUT_PREPARATIONS,
      ...POST_ARTIFACT_LINEAGE_MIGRATIONS,
    ]);
    expect(MIGRATIONS[pairLifecycle - 1]?.name).toBe("0029_resource_deletion_attestations.sql");
    expect(MIGRATIONS[pairLifecycle + 1]?.name).toBe("0031_takoform_artifact_lifecycle.sql");
    for (const migration of MIGRATIONS.slice(0, pairLifecycle)) {
      expect(migration.sql).not.toContain("integration_e2e_credential_pair_operations");
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database.exec(`
      INSERT INTO principals
        (id, provider, provider_subject, email, display_name, created_at)
      VALUES
        ('principal_legacy', 'takos-id', 'legacy', 'legacy@example.test', 'Legacy',
         '2026-08-30T00:00:00.000Z');
      INSERT INTO orgs (id, name, owner_principal_id, created_at)
      VALUES
        ('org_takosumi_hosted_staging', 'Takosumi Hosted staging', 'principal_legacy',
         '2026-08-30T00:00:00.000Z');
      INSERT INTO auth_tokens
        (secret_digest, id, kind, principal_id, org_id, name, scopes_json,
         created_at, expires_at, revoked_at)
      VALUES
        ('sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
         'key_ie2e_historical_single', 'api_key', 'principal_legacy',
         'org_takosumi_hosted_staging', 'integration-e2e-api-key',
         '["resources:write"]', '2026-08-30T00:00:00.000Z',
         '2026-08-30T00:15:00.000Z', NULL);
    `);
    const historical = database
      .query("SELECT * FROM auth_tokens WHERE id = 'key_ie2e_historical_single'")
      .get();

    expect(migrateSqlite(database).applied).toEqual([
      "0030_integration_e2e_credential_pairs.sql",
      "0031_takoform_artifact_lifecycle.sql",
      "0032_worker_runtime_input_preparations.sql",
      "0033_takoform_artifact_lifecycle_forward_repair.sql",
      "0034_cloudflare_managed_worker_state.sql",
      "0035_worker_endpoint_origin_reservation_v2.sql",
      "0036_provider_repair_and_managed_schedule_reconciliation.sql",
      "0037_worker_runtime_input_preparation_v2.sql",
      "0038_selfhost_edge_kv.sql",
      "0039_takoform_live_native_claim_across_tenants.sql",
      "0040_selfhost_queues_and_schedules.sql",
      "0041_selfhost_object_buckets.sql",
      "0042_worker_endpoint_origin_reservation_space_id.sql",
      "0043_artifact_blob_io_fences.sql",
      "0044_artifact_consumer_resolution_receipts.sql",
      "0045_cloudflare_provider_executor_operations.sql",
      "0046_exact_artifact_recovery_receipts.sql",
    ]);
    expect(
      database.query("SELECT * FROM auth_tokens WHERE id = 'key_ie2e_historical_single'").get(),
    ).toEqual(historical);
    expect(
      database
        .query("SELECT COUNT(*) AS count FROM integration_e2e_credential_pair_operations")
        .get(),
    ).toEqual({ count: 0 });
  });

  test("backfills historical artifact owners conservatively into normalized roots", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const lifecycle = MIGRATIONS.findIndex(
      (migration) => migration.name === "0031_takoform_artifact_lifecycle.sql",
    );
    expect(MIGRATIONS.slice(lifecycle).map((migration) => migration.name)).toEqual([
      ARTIFACT_LIFECYCLE,
      RUNTIME_INPUT_PREPARATIONS,
      ...POST_ARTIFACT_LINEAGE_MIGRATIONS,
    ]);
    for (const migration of MIGRATIONS.slice(0, lifecycle)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }

    const manifestDigest = `sha256:${"a".repeat(64)}`;
    const blobDigest = `sha256:${"b".repeat(64)}`;
    const unknownDigest = `sha256:${"c".repeat(64)}`;
    const manifest = JSON.stringify({
      apiVersion: "artifacts.takoform.com/v1alpha1",
      kind: "WorkerBundle",
      mainModule: "worker.mjs",
      modules: [
        {
          name: "worker.mjs",
          mediaType: "application/javascript+module",
          size: 1,
          digest: blobDigest,
        },
      ],
    });
    database
      .query(
        `INSERT INTO tf_artifact_uploads
           (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("up_legacy_artifact", "tenant_legacy", "run:legacy", manifest, manifestDigest, 10);
    database
      .query(
        `INSERT INTO tf_artifact_manifests (digest, manifest_json, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(manifestDigest, manifest, 10);
    database
      .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, ?)")
      .run("tenant_legacy", manifestDigest, "manifest");
    database
      .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, ?)")
      .run("tenant_legacy", blobDigest, "blob");
    database
      .query("INSERT INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, ?)")
      .run("tenant_unknown", unknownDigest, "blob");
    database
      .query(
        `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
         VALUES (?, 201, ?, ?)`,
      )
      .run(
        ["tenant_legacy", "run:legacy", "start", "legacy-key"].join("\u0000"),
        JSON.stringify({ uploadId: "up_legacy_artifact", manifestDigest }),
        100,
      );
    database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, relations_json, package_digest, implementation_digest, updated_at)
         VALUES ('tenant_legacy', 'default', 'edge.forms.takoform.com/v1beta1',
                 'WorkerBundle', 'legacy-consumer', 'uid_legacy_consumer', '1',
                 'revision-legacy-consumer', ?, '[]', NULL, NULL, 10)`,
      )
      .run(
        JSON.stringify({
          apiVersion: "edge.forms.takoform.com/v1beta1",
          kind: "WorkerBundle",
          metadata: { space: "default", name: "legacy-consumer", uid: "uid_legacy_consumer" },
          spec: { manifestDigest },
        }),
      );
    database.exec(`
      INSERT INTO tf_resource_deployments
        (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
         provider_installation_ref, native_id, native_claimed, state,
         observed_json, outputs_json, created_at, updated_at)
      VALUES
        ('tenant_legacy', 'dep_legacy_consumer', 'uid_legacy_consumer',
         'offering.legacy', 'provider.legacy', 'installation.legacy',
         'native-legacy-consumer', 0, 'retained', '{}', '{}', 10, 10);
    `);

    expect(migrateSqlite(database).applied).toEqual([
      "0031_takoform_artifact_lifecycle.sql",
      "0032_worker_runtime_input_preparations.sql",
      "0033_takoform_artifact_lifecycle_forward_repair.sql",
      "0034_cloudflare_managed_worker_state.sql",
      "0035_worker_endpoint_origin_reservation_v2.sql",
      "0036_provider_repair_and_managed_schedule_reconciliation.sql",
      "0037_worker_runtime_input_preparation_v2.sql",
      "0038_selfhost_edge_kv.sql",
      "0039_takoform_live_native_claim_across_tenants.sql",
      "0040_selfhost_queues_and_schedules.sql",
      "0041_selfhost_object_buckets.sql",
      "0042_worker_endpoint_origin_reservation_space_id.sql",
      "0043_artifact_blob_io_fences.sql",
      "0044_artifact_consumer_resolution_receipts.sql",
      "0045_cloudflare_provider_executor_operations.sql",
      "0046_exact_artifact_recovery_receipts.sql",
    ]);
    expect(
      database
        .query(
          `SELECT lifecycle_state, lifecycle_fence, updated_at
           FROM tf_artifact_uploads WHERE id = 'up_legacy_artifact'`,
        )
        .get(),
    ).toEqual({ lifecycle_state: "committed", lifecycle_fence: 1, updated_at: 10 });
    expect(
      database
        .query(
          `SELECT manifest_digest, blob_digest FROM tf_artifact_manifest_members
           ORDER BY manifest_digest, blob_digest`,
        )
        .all(),
    ).toEqual([{ manifest_digest: manifestDigest, blob_digest: blobDigest }]);
    expect(
      database
        .query(
          `SELECT tenant_id, root_kind, target_kind, digest, state
           FROM tf_artifact_roots ORDER BY tenant_id, root_kind, target_kind, digest`,
        )
        .all(),
    ).toEqual([
      {
        tenant_id: "tenant_legacy",
        root_kind: "deployment",
        target_kind: "manifest",
        digest: manifestDigest,
        state: "active",
      },
      {
        tenant_id: "tenant_legacy",
        root_kind: "replay",
        target_kind: "manifest",
        digest: manifestDigest,
        state: "active",
      },
      {
        tenant_id: "tenant_legacy",
        root_kind: "resource",
        target_kind: "manifest",
        digest: manifestDigest,
        state: "active",
      },
      {
        tenant_id: "tenant_legacy",
        root_kind: "upload",
        target_kind: "manifest",
        digest: manifestDigest,
        state: "active",
      },
      {
        tenant_id: "tenant_unknown",
        root_kind: "legacy-hold",
        target_kind: "blob",
        digest: unknownDigest,
        state: "active",
      },
    ]);
    expect(
      database
        .query(
          `SELECT consumer_kind, consumer_id, state, reason
           FROM tf_artifact_consumer_uncertainties
           WHERE tenant_id = 'tenant_legacy'`,
        )
        .all(),
    ).toEqual([
      {
        consumer_kind: "deployment",
        consumer_id: "dep_legacy_consumer",
        state: "active",
        reason: "historical_deployment_digest_unknown",
      },
    ]);
  });

  test("normalizes a previous artifact writer that starts and commits after lifecycle migration", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);

    const manifestDigest = `sha256:${"d".repeat(64)}`;
    const blobDigest = `sha256:${"e".repeat(64)}`;
    const manifest = JSON.stringify({
      apiVersion: "artifacts.takoform.com/v1alpha1",
      kind: "WorkerBundle",
      mainModule: "worker.mjs",
      modules: [
        {
          name: "worker.mjs",
          mediaType: "application/javascript+module",
          size: 1,
          digest: blobDigest,
        },
      ],
    });
    const startReplayKey = ["tenant_previous", "run:previous", "start", "previous-start"].join(
      "\u0000",
    );
    const commitReplayKey = [
      "tenant_previous",
      "run:previous",
      "POST",
      "/apis/forms.takoform.com/v1/artifacts/uploads/up_previous/commit",
      "previous-commit",
    ].join("\u0000");

    // Exact start shape used by the previous Worker after 0031 has already run.
    database
      .query(
        `INSERT INTO tf_artifact_uploads
           (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("up_previous", "tenant_previous", "run:previous", manifest, manifestDigest, 100);
    database
      .query(
        `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
         VALUES (?, 201, ?, ?)`,
      )
      .run(startReplayKey, JSON.stringify({ uploadId: "up_previous", manifestDigest }), 1_000);

    expect(
      database
        .query(
          `SELECT lifecycle_state, lifecycle_fence, updated_at
           FROM tf_artifact_uploads WHERE id = 'up_previous'`,
        )
        .get(),
    ).toEqual({ lifecycle_state: "open", lifecycle_fence: 1, updated_at: 100 });
    expect(
      database
        .query(
          `SELECT manifest_digest, blob_digest FROM tf_artifact_manifest_members
           WHERE manifest_digest = ?`,
        )
        .all(manifestDigest),
    ).toEqual([{ manifest_digest: manifestDigest, blob_digest: blobDigest }]);
    expect(
      database
        .query(
          `SELECT root_kind, root_id, state FROM tf_artifact_roots
           WHERE tenant_id = 'tenant_previous' ORDER BY root_kind, root_id`,
        )
        .all(),
    ).toEqual([
      { root_kind: "replay", root_id: startReplayKey, state: "active" },
      { root_kind: "upload", root_id: "up_previous", state: "active" },
    ]);

    // Exact commit/hold/replay shape used by the previous Worker.
    database
      .query(
        `INSERT OR IGNORE INTO tf_artifact_manifests (digest, manifest_json, created_at)
         VALUES (?, ?, ?)`,
      )
      .run(manifestDigest, manifest, 200);
    database
      .query(
        `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
         VALUES (?, ?, 'manifest')`,
      )
      .run("tenant_previous", manifestDigest);
    database
      .query(
        `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
         VALUES (?, ?, 'blob')`,
      )
      .run("tenant_previous", blobDigest);
    database
      .query(
        `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
         VALUES (?, 201, ?, ?)`,
      )
      .run(commitReplayKey, JSON.stringify({ manifestDigest }), 1_000);

    expect(
      database
        .query(
          `SELECT lifecycle_state, lifecycle_fence
           FROM tf_artifact_uploads WHERE id = 'up_previous'`,
        )
        .get(),
    ).toEqual({ lifecycle_state: "committed", lifecycle_fence: 2 });
    expect(
      database
        .query(
          `SELECT root_kind, root_id, state, fence FROM tf_artifact_roots
           WHERE tenant_id = 'tenant_previous' ORDER BY root_kind, root_id`,
        )
        .all(),
    ).toEqual([
      { root_kind: "replay", root_id: commitReplayKey, state: "active", fence: 1 },
      { root_kind: "replay", root_id: startReplayKey, state: "active", fence: 1 },
      { root_kind: "upload", root_id: "up_previous", state: "active", fence: 2 },
    ]);

    database
      .query(
        `INSERT INTO tf_artifact_uploads
           (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run("up_previous_delete", "tenant_previous", "run:previous", manifest, manifestDigest, 300);
    database.query("DELETE FROM tf_artifact_uploads WHERE id = ?").run("up_previous_delete");
    expect(
      database
        .query(
          `SELECT state, fence FROM tf_artifact_roots
           WHERE tenant_id = 'tenant_previous' AND root_kind = 'upload'
             AND root_id = 'up_previous_delete'`,
        )
        .get(),
    ).toEqual({ state: "active", fence: 1 });
    database
      .query(
        `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
         VALUES (?, 204, NULL, ?)`,
      )
      .run(
        [
          "tenant_previous",
          "run:previous",
          "DELETE",
          "/apis/forms.takoform.com/v1/artifacts/uploads/up_previous_delete",
          "previous-delete",
        ].join("\u0000"),
        1_000,
      );
    expect(
      database
        .query(
          `SELECT lifecycle_state, lifecycle_fence, abandoned_at
           FROM tf_artifact_uploads WHERE id = 'up_previous_delete'`,
        )
        .get(),
    ).toEqual({ lifecycle_state: "abandoned", lifecycle_fence: 2, abandoned_at: 300 });
    expect(
      database
        .query(
          `SELECT state, fence, release_reason
           FROM tf_artifact_roots
           WHERE tenant_id = 'tenant_previous' AND root_kind = 'upload'
             AND root_id = 'up_previous_delete'`,
        )
        .get(),
    ).toEqual({ state: "released", fence: 2, release_reason: "upload_abandoned" });

    const abandonedCommitReplayKey = [
      "tenant_previous",
      "run:previous",
      "POST",
      "/apis/forms.takoform.com/v1/artifacts/uploads/up_previous_delete/commit",
      "previous-commit-after-delete",
    ].join("\u0000");
    expect(() =>
      database
        .query(
          `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
           VALUES (?, 201, ?, ?)`,
        )
        .run(abandonedCommitReplayKey, JSON.stringify({ manifestDigest }), 1_000),
    ).toThrow("artifact_upload_abandoned");
    expect(
      database
        .query("SELECT lifecycle_state FROM tf_artifact_uploads WHERE id = 'up_previous_delete'")
        .get(),
    ).toEqual({ lifecycle_state: "abandoned" });
  });

  test("normalizes a previous writer commit that replaces an expired replay row", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const manifestDigest = `sha256:${"8".repeat(64)}`;
    const blobDigest = `sha256:${"9".repeat(64)}`;
    const manifest = JSON.stringify({
      apiVersion: "artifacts.takoform.com/v1alpha1",
      kind: "WorkerBundle",
      mainModule: "worker.mjs",
      modules: [
        {
          name: "worker.mjs",
          mediaType: "application/javascript+module",
          size: 1,
          digest: blobDigest,
        },
      ],
    });
    const replayKey = [
      "tenant_replaced",
      "run:replaced",
      "POST",
      "/apis/forms.takoform.com/v1/artifacts/uploads/up_replaced/commit",
      "replaced-commit",
    ].join("\u0000");
    database
      .query(
        `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
         VALUES (?, 500, ?, 1)`,
      )
      .run(replayKey, JSON.stringify({ manifestDigest }));
    database
      .query(
        `INSERT INTO tf_artifact_uploads
           (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
         VALUES ('up_replaced', 'tenant_replaced', 'run:replaced', ?, ?, 100)`,
      )
      .run(manifest, manifestDigest);

    database
      .query(
        `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
         VALUES (?, 201, ?, ?)
         ON CONFLICT (replay_key) DO UPDATE SET
           status = excluded.status, body_json = excluded.body_json,
           expires_at = excluded.expires_at`,
      )
      .run(replayKey, JSON.stringify({ manifestDigest }), 86_400_200);

    expect(
      database
        .query(
          `SELECT lifecycle_state, lifecycle_fence, updated_at
           FROM tf_artifact_uploads WHERE id = 'up_replaced'`,
        )
        .get(),
    ).toEqual({ lifecycle_state: "committed", lifecycle_fence: 2, updated_at: 200 });
    expect(
      database
        .query(
          `SELECT state, fence, expires_at FROM tf_artifact_roots
           WHERE tenant_id = 'tenant_replaced' AND root_kind = 'replay'
             AND root_id = ? AND digest = ?`,
        )
        .get(replayKey, manifestDigest),
    ).toEqual({ state: "active", fence: 2, expires_at: 86_400_200 });
  });

  test("refuses a previous writer start while any declared blob is externally delete-fenced", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const manifestDigest = `sha256:${"d".repeat(64)}`;
    const blobDigest = `sha256:${"e".repeat(64)}`;
    const manifest = JSON.stringify({
      apiVersion: "artifacts.takoform.com/v1alpha1",
      kind: "WorkerBundle",
      mainModule: "worker.mjs",
      modules: [
        {
          name: "worker.mjs",
          mediaType: "application/javascript+module",
          size: 1,
          digest: blobDigest,
        },
      ],
    });
    database
      .query(
        `INSERT INTO tf_artifact_gc_candidates
           (kind, digest, state, fence, not_before, expected_etag, attempts,
            last_outcome, created_at, updated_at, deleted_at)
         VALUES ('blob', ?, 'deleting', 2, 1, 'etag-delete-fenced', 1,
                 'claimed', 1, 1, NULL)`,
      )
      .run(blobDigest);

    expect(() =>
      database
        .query(
          `INSERT INTO tf_artifact_uploads
             (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at)
           VALUES ('up_previous_delete_fenced', 'tenant_previous', 'run:previous', ?, ?, 2)`,
        )
        .run(manifest, manifestDigest),
    ).toThrow("artifact_gc_delete_fenced");
    expect(
      database
        .query("SELECT COUNT(*) AS total FROM tf_artifact_uploads WHERE id = ?")
        .get("up_previous_delete_fenced"),
    ).toEqual({ total: 0 });
  });

  test("enforces the fixed organization, roles, scopes, TTL, and distinct role ids in 0030", () => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    const insert = database.query(`
      INSERT INTO integration_e2e_credential_pair_operations
        (operation_id, authority_slot, org_id, writer_key_id, evidence_key_id,
         writer_name, evidence_name, writer_scopes_json, evidence_scopes_json,
         ttl_seconds, state, fence, source_commit, artifact_digest,
         authority_worker_version_id, created_at, updated_at, revoked_at)
      VALUES (?, 'integration-e2e-credential-pair', ?, ?, ?, ?, ?, ?, ?, ?,
              'prepared', 1, ?, ?, ?, 1, 1, NULL)
    `);
    const valid = [
      "operation-migration-constraints",
      "org_takosumi_hosted_staging",
      "key_writer",
      "key_evidence",
      "integration-e2e-writer",
      "integration-e2e-evidence",
      '["resources:write"]',
      '["resources:read"]',
      3_600,
      "a".repeat(40),
      `sha256:${"b".repeat(64)}`,
      "00000000-0000-4000-8000-000000000001",
    ] as const;
    for (const [index, replacement] of [
      [1, "org_wrong"],
      [3, "key_writer"],
      [4, "wrong-writer-name"],
      [5, "wrong-evidence-name"],
      [6, '["resources:read"]'],
      [7, '["resources:write"]'],
      [8, 900],
    ] as const) {
      const values: (string | number)[] = [...valid];
      values[0] = `${valid[0]}-${index}`;
      values[index] = replacement;
      expect(() => insert.run(...values)).toThrow();
    }
    expect(() => insert.run(...valid)).not.toThrow();
  });

  test("does not fabricate deletion attestations for pre-0029 deleted deployments", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const deletionAttestation = MIGRATIONS.findIndex(
      (migration) => migration.name === "0029_resource_deletion_attestations.sql",
    );
    expect(deletionAttestation).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, deletionAttestation)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database
      .query(
        `INSERT INTO tf_resource_deployments
           (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
            provider_installation_ref, native_id, native_claimed, state,
            observed_json, outputs_json, created_at, updated_at)
         VALUES ('tenant-legacy', 'dep_deleted', 'uid_deleted', 'offering.test',
                 'provider.test', 'provider.test.primary', 'native:test', 0,
                 'deleted', '{}', '{}', 100, 100)`,
      )
      .run();

    const report = migrateSqlite(database);

    expect(report.applied[0]).toBe("0029_resource_deletion_attestations.sql");
    expect(
      database.query("SELECT COUNT(*) AS count FROM tf_resource_deletion_attestations").get(),
    ).toEqual({ count: 0 });
  });

  test("fails closed when live rows cannot be registered as unique incarnations", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const deletionAttestation = MIGRATIONS.findIndex(
      (migration) => migration.name === "0029_resource_deletion_attestations.sql",
    );
    for (const migration of MIGRATIONS.slice(0, deletionAttestation)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    const resource = JSON.stringify({
      form: {
        formRef: {
          apiVersion: "edge.forms.takoform.com",
          kind: "Thing",
          definitionVersion: "v1",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
    });
    for (const name of ["first", "second"]) {
      database
        .query(
          `INSERT INTO tf_resources
             (tenant_id, space, api_version, kind, name, uid, generation, revision,
              resource_json, relations_json, updated_at)
           VALUES ('tenant-duplicate', 'main', 'example.forms.invalid', 'Thing', ?,
                   'uid_duplicate', '1', '1', ?, '[]', 1)`,
        )
        .run(name, resource);
    }

    expect(() => migrateSqlite(database)).toThrow(/0029_resource_deletion_attestations/);
    expect(
      database
        .query(
          "SELECT name FROM applied_migrations WHERE name = '0029_resource_deletion_attestations.sql'",
        )
        .all(),
    ).toEqual([]);
    expect(() => database.query("SELECT 1 FROM tf_resource_deletion_attestations").all()).toThrow();
  });

  test("fails closed when a live row has no FormRef", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const deletionAttestation = MIGRATIONS.findIndex(
      (migration) => migration.name === "0029_resource_deletion_attestations.sql",
    );
    for (const migration of MIGRATIONS.slice(0, deletionAttestation)) {
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
         VALUES ('tenant-malformed', 'main', 'example.forms.invalid', 'Thing', 'broken',
                 'uid_broken', '1', '1', '{}', '[]', 1)`,
      )
      .run();

    expect(() => migrateSqlite(database)).toThrow(/0029_resource_deletion_attestations/);
    expect(
      database
        .query(
          "SELECT name FROM applied_migrations WHERE name = '0029_resource_deletion_attestations.sql'",
        )
        .all(),
    ).toEqual([]);
  });

  test("fails closed for every malformed FormRef grammar component", () => {
    const malformed: readonly [string, Record<string, string>][] = [
      ["empty apiVersion", { apiVersion: "" }],
      ["invalid apiVersion version", { apiVersion: "edge.forms.takoform.com/v1gamma1" }],
      ["empty kind", { kind: "" }],
      ["invalid kind case", { kind: "thing" }],
      ["non-semver definitionVersion", { definitionVersion: "latest" }],
      ["bad schema digest", { schemaDigest: "sha256:short" }],
    ];
    const deletionAttestation = MIGRATIONS.findIndex(
      (migration) => migration.name === "0029_resource_deletion_attestations.sql",
    );
    for (const [index, [label, replacement]] of malformed.entries()) {
      const database = new Database(":memory:");
      database.exec(`
        CREATE TABLE applied_migrations (
          name TEXT PRIMARY KEY NOT NULL,
          applied_at TEXT NOT NULL
        );
      `);
      for (const migration of MIGRATIONS.slice(0, deletionAttestation)) {
        database.exec(migration.sql);
        database
          .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
          .run(migration.name);
      }
      const formRef = {
        apiVersion: "edge.forms.takoform.com",
        kind: "Thing",
        definitionVersion: "1.0.0",
        schemaDigest: `sha256:${"a".repeat(64)}`,
        ...replacement,
      };
      database
        .query(
          `INSERT INTO tf_resources
             (tenant_id, space, api_version, kind, name, uid, generation, revision,
              resource_json, relations_json, updated_at)
           VALUES ('tenant-malformed-ref', 'main', 'edge.forms.takoform.com', 'Thing', ?, ?,
                   '1', '1', ?, '[]', 1)`,
        )
        .run(`broken-${index}`, `uid_malformed_${index}`, JSON.stringify({ form: { formRef } }));

      expect(() => migrateSqlite(database), label).toThrow(/0029_resource_deletion_attestations/);
      expect(
        database
          .query(
            "SELECT name FROM applied_migrations WHERE name = '0029_resource_deletion_attestations.sql'",
          )
          .all(),
      ).toEqual([]);
      expect(() =>
        database.query("SELECT 1 FROM tf_resource_deletion_attestations").all(),
      ).toThrow();
    }
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
      .run(
        JSON.stringify({
          existing: true,
          form: {
            formRef: {
              apiVersion: "edge.forms.takoform.com",
              kind: "Thing",
              definitionVersion: "1.0.0",
              schemaDigest: `sha256:${"a".repeat(64)}`,
            },
          },
        }),
      );
    database
      .query(`
      INSERT INTO tf_operations
        (id, tenant_id, operation, state, resource_json, created_at, expires_at)
      VALUES
        ('op_existing', 'tenant-a', 'apply', 'succeeded', ?,
         '2026-08-23T00:00:00.000Z', 9999999999999)
    `)
      .run(
        JSON.stringify({
          existing: true,
          form: {
            formRef: {
              apiVersion: "edge.forms.takoform.com",
              kind: "Thing",
              definitionVersion: "1.0.0",
              schemaDigest: `sha256:${"a".repeat(64)}`,
            },
          },
        }),
      );

    const report = migrateSqlite(database);

    expect(report.applied.slice(0, 5)).toEqual([
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
      resource_json: JSON.stringify({
        existing: true,
        form: {
          formRef: {
            apiVersion: "edge.forms.takoform.com",
            kind: "Thing",
            definitionVersion: "1.0.0",
            schemaDigest: `sha256:${"a".repeat(64)}`,
          },
        },
      }),
      relations_json: "[]",
      updated_at: 42,
    });
    expect(
      database
        .query("SELECT id, state, resource_json FROM tf_operations WHERE id = 'op_existing'")
        .get(),
    ).toEqual({
      id: "op_existing",
      state: "succeeded",
      resource_json: JSON.stringify({
        existing: true,
        form: {
          formRef: {
            apiVersion: "edge.forms.takoform.com",
            kind: "Thing",
            definitionVersion: "1.0.0",
            schemaDigest: `sha256:${"a".repeat(64)}`,
          },
        },
      }),
    });
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

    expect(report.applied.slice(0, 2)).toEqual([
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

    expect(report.applied.slice(0, 2)).toEqual([
      "0024_takoform_provider_execution_leases.sql",
      "0025_resource_migration_execution.sql",
    ]);
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

  test("pins previously dispatched provider repairs until their Host command is terminal", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const repairMigration = MIGRATIONS.findIndex(
      (migration) => migration.name === PROVIDER_REPAIR_AND_MANAGED_SCHEDULE_RECONCILIATION,
    );
    expect(repairMigration).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, repairMigration)) {
      applyHistoricalMigration(database, migration.name, migration.sql);
    }
    database.exec(`
      INSERT INTO tf_deferred_operations
        (id, tenant_id, principal_id, operation, phase, request_path, request_query,
         request_headers_json, request_body_json, fingerprint, replay_key,
         target_space, target_api_version, target_kind, target_name,
         target_form_ref_json, accepted_uid, accepted_generation, accepted_revision,
         resource_uid, polls_remaining, lease_token, lease_until, terminal_json,
         committed_uid, created_at, updated_at, expires_at)
      VALUES
        ('op_dispatched', 'tenant-a', 'principal-a', 'apply', 'committing',
         '/apis/forms/resources/example/Thing/dispatched', '', '{}', '{}',
         'fingerprint', 'replay-dispatched', 'main', 'example.forms.invalid',
         'Thing', 'dispatched', '{}', NULL, NULL, NULL, 'uid_dispatched', 0,
         NULL, NULL, NULL, NULL, '2026-09-01T00:00:00.000Z', 100, 123);

      INSERT INTO tf_provider_mutation_sagas
        (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
         target_space, target_api_version, target_kind, target_name,
         accepted_uid, accepted_generation, accepted_revision, phase,
         receipt_json, authority_head_digest, created_at, updated_at, expires_at,
         execution_lease_token, execution_lease_until, execution_started_at,
         provider_handle, provider_outcome)
      VALUES
        ('op_dispatched', 'replay-dispatched', 'tenant-a', 'fingerprint',
         'uid_dispatched', 'main', 'example.forms.invalid', 'Thing', 'dispatched',
         NULL, NULL, NULL, 'planned', NULL, NULL, 100, 100, 123,
         NULL, NULL, 100, NULL, 'indeterminate');
    `);

    expect(migrateSqlite(database).applied).toEqual([
      PROVIDER_REPAIR_AND_MANAGED_SCHEDULE_RECONCILIATION,
      RUNTIME_INPUT_PREPARATION_V2,
      SELFHOST_EDGE_KV,
      LIVE_NATIVE_CLAIM_ACROSS_TENANTS,
      SELFHOST_QUEUES_AND_SCHEDULES,
      SELFHOST_OBJECT_BUCKETS,
      WORKER_ENDPOINT_ORIGIN_RESERVATION_SPACE_ID,
      ARTIFACT_BLOB_IO_FENCES,
      ARTIFACT_CONSUMER_RESOLUTION_RECEIPTS,
      CLOUDFLARE_PROVIDER_EXECUTOR_OPERATIONS,
      EXACT_ARTIFACT_RECOVERY_RECEIPTS,
    ]);
    expect(
      database
        .query(
          `SELECT operation.expires_at AS operation_expiry, saga.expires_at AS saga_expiry
           FROM tf_deferred_operations AS operation
           INNER JOIN tf_provider_mutation_sagas AS saga ON saga.operation_id = operation.id
           WHERE operation.id = 'op_dispatched'`,
        )
        .get(),
    ).toEqual({
      operation_expiry: 253402300799999,
      saga_expiry: 253402300799999,
    });
  });

  test("rolls 0036 back without schema drift when a dispatched saga has no exact Host command", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const repairMigration = MIGRATIONS.findIndex(
      (migration) => migration.name === PROVIDER_REPAIR_AND_MANAGED_SCHEDULE_RECONCILIATION,
    );
    expect(repairMigration).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, repairMigration)) {
      applyHistoricalMigration(database, migration.name, migration.sql);
    }
    database.exec(`
      INSERT INTO tf_provider_mutation_sagas
        (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
         target_space, target_api_version, target_kind, target_name,
         accepted_uid, accepted_generation, accepted_revision, phase,
         receipt_json, authority_head_digest, created_at, updated_at, expires_at,
         execution_lease_token, execution_lease_until, execution_started_at,
         provider_handle, provider_outcome)
      VALUES
        ('op_unmatched', 'replay-unmatched', 'tenant-a', 'fingerprint',
         'uid_unmatched', 'main', 'example.forms.invalid', 'Thing', 'unmatched',
         NULL, NULL, NULL, 'planned', NULL, NULL, 100, 100, 123,
         NULL, NULL, 100, NULL, 'indeterminate');
    `);
    const schemaBefore = database
      .query(
        `SELECT type, name, tbl_name, sql FROM sqlite_schema
         WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
      )
      .all();

    expect(() => migrateSqlite(database)).toThrow(
      PROVIDER_REPAIR_AND_MANAGED_SCHEDULE_RECONCILIATION,
    );

    expect(
      database
        .query(
          `SELECT type, name, tbl_name, sql FROM sqlite_schema
           WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
        )
        .all(),
    ).toEqual(schemaBefore);
    expect(
      database
        .query("SELECT name FROM applied_migrations WHERE name = ?")
        .get(PROVIDER_REPAIR_AND_MANAGED_SCHEDULE_RECONCILIATION),
    ).toBeNull();
    expect(
      database
        .query(
          `SELECT expires_at FROM tf_provider_mutation_sagas
           WHERE operation_id = 'op_unmatched'`,
        )
        .get(),
    ).toEqual({ expires_at: 123 });
  });

  test("makes existing in-flight Resource Migrations recovery-only without changing state", () => {
    const database = new Database(":memory:");
    database.exec(`
      CREATE TABLE applied_migrations (
        name TEXT PRIMARY KEY NOT NULL,
        applied_at TEXT NOT NULL
      );
    `);
    const executionMigration = MIGRATIONS.findIndex(
      (migration) => migration.name === "0025_resource_migration_execution.sql",
    );
    expect(executionMigration).toBeGreaterThan(0);
    for (const migration of MIGRATIONS.slice(0, executionMigration)) {
      database.exec(migration.sql);
      database
        .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
        .run(migration.name);
    }
    database.exec(`
      INSERT INTO tf_resource_migrations
        (tenant_id, id, resource_uid, source_deployment_id, target_deployment_id,
         target_offering_id, target_provider_pack_ref, target_provider_installation_ref,
         commercial_authorization_ref, commercial_tenant_ref, mode, transfer_format, state,
         verification_json, rollback_until, attachment_rebindings_json, created_at, updated_at)
      VALUES
        ('tenant-a', 'mig_planned', 'uid_planned', 'dep_source_planned', 'dep_target_planned',
         'offering.target', 'target', 'target.primary', 'reservation_planned', 'commercial-a',
         'offline', 'transfer.example/v1', 'planned', NULL, NULL, NULL, 100, 110),
        ('tenant-a', 'mig_provisioning', 'uid_provisioning', 'dep_source_provisioning',
         'dep_target_provisioning', 'offering.target', 'target', 'target.primary',
         'reservation_provisioning', 'commercial-a', 'offline', 'transfer.example/v1',
         'provisioning', NULL, NULL, NULL, 200, 210),
        ('tenant-a', 'mig_transferring', 'uid_transferring', 'dep_source_transferring',
         'dep_target_transferring', 'offering.target', 'target', 'target.primary',
         'reservation_transferring', 'commercial-a', 'offline', 'transfer.example/v1',
         'transferring', NULL, NULL, NULL, 300, 310);
    `);

    const report = migrateSqlite(database);

    expect(report.applied[0]).toBe("0025_resource_migration_execution.sql");
    expect(
      database
        .query(
          `SELECT id, state, execution_lease_token, execution_lease_until,
                  execution_started_at, execution_json
           FROM tf_resource_migrations ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "mig_planned",
        state: "planned",
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: null,
        execution_json: "{}",
      },
      {
        id: "mig_provisioning",
        state: "provisioning",
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: 210,
        execution_json: "{}",
      },
      {
        id: "mig_transferring",
        state: "transferring",
        execution_lease_token: null,
        execution_lease_until: null,
        execution_started_at: 310,
        execution_json: "{}",
      },
    ]);
    expect(migrateSqlite(database)).toEqual({
      applied: [],
      alreadyApplied: MIGRATIONS.length,
    });
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
          form: {
            formRef: {
              apiVersion: "edge.forms.takoform.com/v1beta1",
              kind: "ObjectBucket",
              definitionVersion: "1.0.0",
              schemaDigest: `sha256:${"b".repeat(64)}`,
            },
          },
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
