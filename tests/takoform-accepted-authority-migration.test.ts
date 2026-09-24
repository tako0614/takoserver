import { Database, type SQLQueryBindings } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformStore } from "../src/takoform/store.ts";

const OPERATION_GENERATION = "0060_takoform_operation_generation.sql";
const ACCEPTED_AUTHORITY_CONTINUITY = "0061_takoform_accepted_authority_continuity.sql";
const IMPORT_SELECTION = "0062_takoform_import_provider_selection.sql";
const MANAGED_QUEUE_RETIREMENT = "0063_cloudflare_managed_queue_retirement.sql";

const MUTATION_AUTHORITY_SUMMARY = JSON.stringify({
  formRef: {
    apiVersion: "edge.forms.takoform.com",
    definitionVersion: "1.0.0",
    kind: "Thing",
    schemaDigest: `sha256:${"a".repeat(64)}`,
  },
  headDigest: `sha256:${"d".repeat(64)}`,
  implementationDigest: `sha256:${"c".repeat(64)}`,
  lifecycleOperation: "create",
  mode: "mutation",
  packageDigest: `sha256:${"b".repeat(64)}`,
  protocolGeneration: 1,
  version: "takoserver.takoform-accepted-authority@v1",
});

const UNFENCED_AUTHORITY_SUMMARY = JSON.stringify({
  mode: "unfenced",
  protocolGeneration: 1,
  version: "takoserver.takoform-accepted-authority@v1",
});

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

function createDatabaseAtOperationGeneration(): Database {
  const database = new Database(":memory:");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec(`
    CREATE TABLE applied_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  const operationGeneration = MIGRATIONS.findIndex(
    (migration) => migration.name === OPERATION_GENERATION,
  );
  expect(operationGeneration).toBeGreaterThan(0);

  for (const migration of MIGRATIONS.slice(0, operationGeneration)) {
    applyHistoricalMigration(database, migration.name, migration.sql);
  }
  seedLegacyRows(database);
  const operationMigration = MIGRATIONS[operationGeneration];
  expect(operationMigration).toBeDefined();
  applyHistoricalMigration(database, OPERATION_GENERATION, operationMigration?.sql ?? "");
  seedCurrentRows(database);
  return database;
}

function seedLegacyRows(database: Database): void {
  database
    .query(
      `INSERT INTO tf_deferred_operations
         (id, tenant_id, principal_id, operation, phase, request_path, request_query,
          request_headers_json, request_body_json, fingerprint, replay_key,
          target_space, target_api_version, target_kind, target_name,
          target_form_ref_json, accepted_uid, accepted_generation, accepted_revision,
          resource_uid, polls_remaining, lease_token, lease_until, terminal_json,
          committed_uid, created_at, updated_at, expires_at)
       VALUES (?, 'tenant_legacy', 'principal_legacy', ?, 'pending', '/legacy', '', '{}', NULL,
               ?, ?, 'main', 'edge.forms.takoform.com', 'Thing', ?, '{}', NULL, NULL, NULL,
               ?, 0, NULL, NULL, NULL, NULL, '2026-09-20T00:00:00.000Z', 1, 9999999999)`,
    )
    .run(
      "legacy-operation",
      "apply",
      "legacy-fingerprint",
      "legacy-replay",
      "legacy",
      "uid-legacy",
    );
  database
    .query(
      `INSERT INTO tf_provider_mutation_sagas
         (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
          target_space, target_api_version, target_kind, target_name,
          accepted_uid, accepted_generation, accepted_revision, phase,
          receipt_json, created_at, updated_at, expires_at)
       VALUES (?, ?, 'tenant_legacy', ?, ?, 'main', 'edge.forms.takoform.com', 'Thing', ?,
               NULL, NULL, NULL, 'planned', NULL, 1, 1, 9999999999)`,
    )
    .run(
      "legacy-saga",
      "legacy-saga-replay",
      "legacy-saga-fingerprint",
      "uid-legacy-saga",
      "legacy-saga",
    );
}

function seedCurrentRows(database: Database): void {
  insertCurrentOperation(database, "old-null-apply", "apply");
  insertCurrentOperation(database, "old-null-import", "import");
  insertCurrentOperation(database, "old-null-delete", "delete");
}

function insertCurrentOperation(
  database: Database,
  id: string,
  operation: "apply" | "import" | "delete",
  acceptedAuthorityJson?: string,
): void {
  const columns = [
    "id",
    "protocol_generation",
    "tenant_id",
    "principal_id",
    "operation",
    "phase",
    "request_path",
    "request_query",
    "request_headers_json",
    "request_body_json",
    "fingerprint",
    "replay_key",
    "target_space",
    "target_api_version",
    "target_kind",
    "target_name",
    "target_form_ref_json",
    "accepted_uid",
    "accepted_generation",
    "accepted_revision",
    "resource_uid",
    "polls_remaining",
    "lease_token",
    "lease_until",
    "terminal_json",
    "committed_uid",
    "created_at",
    "updated_at",
    "expires_at",
  ];
  const values: SQLQueryBindings[] = [
    id,
    1,
    "tenant-current",
    "principal-current",
    operation,
    "pending",
    "/current",
    "",
    "{}",
    null,
    `fingerprint-${id}`,
    `replay-${id}`,
    "main",
    "edge.forms.takoform.com",
    "Thing",
    id,
    "{}",
    null,
    null,
    null,
    `uid-${id}`,
    0,
    null,
    null,
    null,
    null,
    "2026-09-20T00:00:00.000Z",
    1,
    9999999999,
  ];
  if (acceptedAuthorityJson !== undefined) {
    columns.push("accepted_authority_json");
    values.push(acceptedAuthorityJson);
  }
  database
    .query(
      `INSERT INTO tf_deferred_operations_selection_v1
         (${columns.join(", ")})
       VALUES (${columns.map(() => "?").join(", ")})`,
    )
    .run(...values);
}

describe("Takoform accepted-authority continuity migration", () => {
  test("preserves old rows and fences only new apply writes", async () => {
    const database = createDatabaseAtOperationGeneration();
    const legacyBefore = {
      deferred: database
        .query(
          `SELECT id, tenant_id, principal_id, operation, phase, fingerprint, replay_key,
                  target_name, resource_uid, created_at, updated_at, expires_at
           FROM tf_deferred_operations ORDER BY id`,
        )
        .all(),
      saga: database
        .query(
          `SELECT operation_id, replay_key, tenant_id, fingerprint, resource_uid,
                  target_name, phase, receipt_json, created_at, updated_at, expires_at
           FROM tf_provider_mutation_sagas ORDER BY operation_id`,
        )
        .all(),
    };

    expect(migrateSqlite(database).applied).toEqual([
      ACCEPTED_AUTHORITY_CONTINUITY,
      IMPORT_SELECTION,
      MANAGED_QUEUE_RETIREMENT,
    ]);
    expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(
      database
        .query(
          `SELECT id, operation, accepted_authority_json
           FROM tf_deferred_operations_selection_v1 ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: "old-null-apply", operation: "apply", accepted_authority_json: null },
      { id: "old-null-delete", operation: "delete", accepted_authority_json: null },
      { id: "old-null-import", operation: "import", accepted_authority_json: null },
    ]);
    const store = createTakoformStore(createSqliteSql(database), () => new Date(1_000));
    const legacyApply = await store.readDeferredOperation(
      "tenant-current",
      "principal-current",
      "old-null-apply",
    );
    expect(legacyApply?.acceptedAuthority).toBeUndefined();
    expect(
      database
        .query(
          `SELECT id, tenant_id, principal_id, operation, phase, fingerprint, replay_key,
                  target_name, resource_uid, created_at, updated_at, expires_at
           FROM tf_deferred_operations ORDER BY id`,
        )
        .all(),
    ).toEqual(legacyBefore.deferred);
    expect(
      database
        .query(
          `SELECT operation_id, replay_key, tenant_id, fingerprint, resource_uid,
                  target_name, phase, receipt_json, created_at, updated_at, expires_at
           FROM tf_provider_mutation_sagas ORDER BY operation_id`,
        )
        .all(),
    ).toEqual(legacyBefore.saga);

    expect(() => insertCurrentOperation(database, "old-writer-apply", "apply")).toThrow();
    expect(() =>
      database
        .query(
          `UPDATE tf_deferred_operations_selection_v1
           SET accepted_authority_json = ? WHERE id = 'old-null-apply'`,
        )
        .run(MUTATION_AUTHORITY_SUMMARY),
    ).toThrow();
    insertCurrentOperation(database, "new-mutation", "apply", MUTATION_AUTHORITY_SUMMARY);
    insertCurrentOperation(database, "new-unfenced", "apply", UNFENCED_AUTHORITY_SUMMARY);
    insertCurrentOperation(database, "new-import", "import");
    insertCurrentOperation(database, "new-delete", "delete");

    expect(() =>
      database
        .query(
          `UPDATE tf_deferred_operations_selection_v1
           SET accepted_authority_json = ? WHERE id = 'new-mutation'`,
        )
        .run(UNFENCED_AUTHORITY_SUMMARY),
    ).toThrow();
    expect(
      database
        .query(
          `SELECT accepted_authority_json
           FROM tf_deferred_operations_selection_v1 WHERE id = 'new-mutation'`,
        )
        .get(),
    ).toEqual({ accepted_authority_json: MUTATION_AUTHORITY_SUMMARY });
    expect(
      database
        .query(
          `SELECT id, operation, accepted_authority_json
           FROM tf_deferred_operations_selection_v1
           WHERE id IN ('new-mutation', 'new-unfenced') ORDER BY id`,
        )
        .all(),
    ).toEqual([
      {
        id: "new-mutation",
        operation: "apply",
        accepted_authority_json: MUTATION_AUTHORITY_SUMMARY,
      },
      {
        id: "new-unfenced",
        operation: "apply",
        accepted_authority_json: UNFENCED_AUTHORITY_SUMMARY,
      },
    ]);
    expect(
      database
        .query(
          `SELECT id, operation, accepted_authority_json
           FROM tf_deferred_operations_selection_v1
           WHERE id IN ('new-delete', 'new-import') ORDER BY id`,
        )
        .all(),
    ).toEqual([
      { id: "new-delete", operation: "delete", accepted_authority_json: null },
      { id: "new-import", operation: "import", accepted_authority_json: null },
    ]);
  });
});
