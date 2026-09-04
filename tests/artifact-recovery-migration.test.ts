import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";

const MIGRATION = "0046_exact_artifact_recovery_receipts.sql";
const PREDECESSOR = "0045_cloudflare_provider_executor_operations.sql";
const TENANT = "org_takosumi_hosted_staging";
const REQUEST = sha("1");
const MANIFEST = sha("2");
const WORKER = "10000000-0000-4000-8000-000000000001";
const SUCCESSOR = "20000000-0000-4000-8000-000000000002";
const COMPETING_SUCCESSOR = "30000000-0000-4000-8000-000000000003";
const RETENTION = 86_400_000;

test("0046 follows 0045 exactly, contains no incident authorization, and preserves prior receipts", () => {
  const index = migrationIndex();
  expect(MIGRATIONS[index - 1]?.name).toBe(PREDECESSOR);
  const source = MIGRATIONS[index]?.sql ?? "";
  expect(source).not.toContain("afr_");
  expect(source).not.toContain("takoserver.exact-failed-run-artifact-recovery-request@v2");

  const database = new Database(":memory:");
  applyThrough(database, index - 1);
  database.exec(`
    INSERT INTO tf_artifact_uploads
      (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at,
       lifecycle_state, lifecycle_fence, updated_at, abandoned_at)
    VALUES ('up_preserved', 'tenant_before_0046', 'run:preserved', '{}',
            '${MANIFEST}', 1, 'committed', 1, 1, NULL);
    INSERT INTO tf_artifact_roots
      (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
       expires_at, release_reason, created_at, released_at)
    VALUES ('tenant_before_0046', 'upload', 'up_preserved', 'manifest',
            '${MANIFEST}', 'active', 1, NULL, NULL, 1, NULL);
    INSERT INTO tf_artifact_owner_closure_receipts
      (receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
       manifest_digest, upload_fence, root_fence, state, closed_at,
       expires_at, created_at, updated_at)
    VALUES ('receipt_preserved', 1, 'tenant_before_0046', 'run:preserved',
            'up_preserved', '${MANIFEST}', 1, 1, 'closed', 1, 10, 1, 1);
    INSERT INTO tf_artifact_blob_io_results
      (operation_id, digest, operation_kind, lease_fence, candidate_fence,
       tenant_id, principal_id, upload_id, upload_fence, root_fence,
       expected_size, outcome, completed_at)
    VALUES ('write_preserved', '${sha("e")}', 'write', 1, NULL,
            'tenant_before_0046', 'run:preserved', 'up_preserved', 1, 1,
            0, 'write_committed', 1);
  `);
  database.exec(source);
  expect(
    database
      .query(
        `SELECT name FROM sqlite_schema WHERE type = 'table' AND name IN (
           'tf_artifact_owner_closure_receipts', 'tf_artifact_recovery_once',
           'tf_artifact_recovery_details', 'tf_artifact_recovery_candidates',
           'tf_artifact_recovery_execution_handoffs'
         ) ORDER BY name`,
      )
      .all(),
  ).toEqual([
    { name: "tf_artifact_owner_closure_receipts" },
    { name: "tf_artifact_recovery_candidates" },
    { name: "tf_artifact_recovery_details" },
    { name: "tf_artifact_recovery_execution_handoffs" },
    { name: "tf_artifact_recovery_once" },
  ]);
  expect(
    database
      .query(
        `SELECT receipt_id, receipt_kind, recovery_request_digest, state, purge_after
         FROM tf_artifact_owner_closure_receipts`,
      )
      .all(),
  ).toEqual([
    {
      receipt_id: "receipt_preserved",
      receipt_kind: "run_owner_closure",
      recovery_request_digest: null,
      state: "closed",
      purge_after: null,
    },
  ]);
  expect(
    database
      .query(
        `SELECT operation_id, receipt_kind, recovery_request_digest
         FROM tf_artifact_blob_io_results`,
      )
      .all(),
  ).toEqual([
    {
      operation_id: "write_preserved",
      receipt_kind: "artifact_io",
      recovery_request_digest: null,
    },
  ]);
  expect(() => database.query("DELETE FROM tf_artifact_blob_io_results").run()).toThrow(
    "artifact_blob_io_result_durable",
  );
});

test("the database admits one immutable authorization and rejects every second descriptor", () => {
  const database = migratedDatabase();
  insertSingleton(database, REQUEST);
  expect(() => insertSingleton(database, REQUEST)).toThrow();
  expect(() => insertSingleton(database, sha("9"))).toThrow();
  expect(() =>
    database.query("UPDATE tf_artifact_recovery_once SET source_version = 'drift'").run(),
  ).toThrow("artifact_recovery_identity_immutable");
  expect(() => database.query("DELETE FROM tf_artifact_recovery_once").run()).toThrow(
    "artifact_recovery_once_durable",
  );
  expect(
    database.query("SELECT request_digest, phase FROM tf_artifact_recovery_once").all(),
  ).toEqual([{ request_digest: REQUEST, phase: "prepared" }]);
});

test("an ambiguous delete admits one ordered successor and rejects an unfenced handoff", () => {
  const database = migratedDatabase();
  insertSingleton(database, REQUEST);
  const blob = sha("f");
  database.exec(`
    INSERT INTO tf_artifact_gc_candidates
      (kind, digest, state, fence, not_before, expected_etag, attempts,
       last_outcome, created_at, updated_at, deleted_at)
    VALUES ('blob', '${blob}', 'deleting', 2, 1000, 'etag-one', 1,
            'claimed', 1000, 1000, NULL);
    INSERT INTO tf_artifact_recovery_candidates
      (request_digest, ordinal, kind, digest, prepared_etag, active_etag,
       state, delete_operation_id, delete_lease_fence,
       execution_worker_version_id, purge_after)
    VALUES ('${REQUEST}', 0, 'blob', '${blob}', 'etag-one', 'etag-one',
            'delete_started', 'recovery-delete-one', 1, '${WORKER}', NULL);
  `);
  expect(() =>
    database
      .query(
        `UPDATE tf_artifact_recovery_once
         SET active_worker_version_id = ?, execution_handoff_count = 1`,
      )
      .run(SUCCESSOR),
  ).toThrow("artifact_recovery_execution_handoff_invalid");
  database
    .query(
      `INSERT INTO tf_artifact_recovery_execution_handoffs
         (request_digest, sequence, candidate_ordinal, candidate_fence,
          predecessor_worker_version_id, successor_worker_version_id,
          resolution_kind, observed_etag, reviewed_operation_id,
          reviewed_candidate_fence, review_evidence_digest,
          quiescence_evidence_digest, activated_at, handoff_digest, purge_after)
       VALUES (?, 1, 0, 2, ?, ?, 'confirm-head-absent', NULL, NULL, NULL, NULL,
               ?, 1100, ?, NULL)`,
    )
    .run(REQUEST, WORKER, SUCCESSOR, sha("6"), sha("7"));
  database
    .query(
      `UPDATE tf_artifact_recovery_once
       SET active_worker_version_id = ?, execution_handoff_count = 1`,
    )
    .run(SUCCESSOR);
  expect(() =>
    database
      .query(
        `INSERT INTO tf_artifact_recovery_execution_handoffs
           (request_digest, sequence, candidate_ordinal, candidate_fence,
            predecessor_worker_version_id, successor_worker_version_id,
            resolution_kind, observed_etag, reviewed_operation_id,
            reviewed_candidate_fence, review_evidence_digest,
            quiescence_evidence_digest, activated_at, handoff_digest, purge_after)
         VALUES (?, 2, 0, 2, ?, ?, 'confirm-head-absent', NULL, NULL, NULL, NULL,
                 ?, 1200, ?, NULL)`,
      )
      .run(REQUEST, WORKER, COMPETING_SUCCESSOR, sha("8"), sha("9")),
  ).toThrow("artifact_recovery_execution_handoff_not_exact");
  expect(() =>
    database
      .query("UPDATE tf_artifact_recovery_execution_handoffs SET handoff_digest = ?")
      .run(sha("a")),
  ).toThrow("artifact_recovery_execution_handoff_immutable");
  expect(() => database.query("DELETE FROM tf_artifact_recovery_execution_handoffs").run()).toThrow(
    "artifact_recovery_execution_handoff_durable",
  );
  expect(
    database
      .query(
        `SELECT preparing_worker_version_id, active_worker_version_id,
                execution_handoff_count
         FROM tf_artifact_recovery_once`,
      )
      .all(),
  ).toEqual([
    {
      preparing_worker_version_id: WORKER,
      active_worker_version_id: SUCCESSOR,
      execution_handoff_count: 1,
    },
  ]);
});

test("uncertainty and recovery authorization serialize in both winner orders", () => {
  const uncertaintyFirst = migratedDatabase();
  insertUncertainty(uncertaintyFirst, "first");
  expect(() => insertSingleton(uncertaintyFirst, REQUEST)).toThrow(
    "artifact_recovery_consumer_uncertainty",
  );
  expect(
    uncertaintyFirst.query("SELECT COUNT(*) AS total FROM tf_artifact_recovery_once").get(),
  ).toEqual({
    total: 0,
  });

  const recoveryFirst = migratedDatabase();
  insertSingleton(recoveryFirst, REQUEST);
  expect(() => insertUncertainty(recoveryFirst, "second")).toThrow("artifact_recovery_active");
  expect(
    recoveryFirst.query("SELECT COUNT(*) AS total FROM tf_artifact_consumer_uncertainties").get(),
  ).toEqual({ total: 0 });
});

test("detail deletion requires completion and an active-Worker purge authorization after retention", () => {
  const database = migratedDatabase();
  insertSingleton(database, REQUEST);
  database
    .query(
      `INSERT INTO tf_artifact_recovery_details
         (request_digest, request_json, prepared_worker_version_id, purge_after)
       VALUES (?, '{}', ?, NULL)`,
    )
    .run(REQUEST, WORKER);
  expect(() => database.query("DELETE FROM tf_artifact_recovery_details").run()).toThrow(
    "artifact_recovery_detail_durable",
  );

  const completedAt = 2_000;
  const result = sha("8");
  database
    .query(
      `UPDATE tf_artifact_recovery_once
       SET phase = 'complete', completed_at = ?, result_set_digest = ?, purge_after = ?
       WHERE singleton = 1`,
    )
    .run(completedAt, result, completedAt + RETENTION);
  expect(() => database.query("DELETE FROM tf_artifact_recovery_details").run()).toThrow(
    "artifact_recovery_detail_durable",
  );
  expect(() =>
    database
      .query(
        `UPDATE tf_artifact_recovery_once
         SET detail_state = 'purging', purge_worker_version_id = ?,
             purge_authorization_digest = ?, purge_authorized_at = ?
         WHERE singleton = 1`,
      )
      .run(SUCCESSOR, sha("7"), completedAt + RETENTION),
  ).toThrow();
  database
    .query(
      `UPDATE tf_artifact_recovery_once
       SET detail_state = 'purging', purge_worker_version_id = ?,
           purge_authorization_digest = ?, purge_authorized_at = ?
       WHERE singleton = 1`,
    )
    .run(WORKER, sha("7"), completedAt + RETENTION);
  database.query("DELETE FROM tf_artifact_recovery_details").run();
  database
    .query(
      `UPDATE tf_artifact_recovery_once
       SET detail_state = 'purged', details_purged_at = ? WHERE singleton = 1`,
    )
    .run(completedAt + RETENTION);
  expect(
    database
      .query("SELECT phase, detail_state, request_digest FROM tf_artifact_recovery_once")
      .all(),
  ).toEqual([{ phase: "complete", detail_state: "purged", request_digest: REQUEST }]);
});

function insertSingleton(database: Database, requestDigest: string): void {
  database
    .query(
      `INSERT INTO tf_artifact_recovery_once
         (singleton, request_digest, evidence_digest, tenant_id,
          logical_target_digest, manifest_digest, owner_set_digest,
          upload_set_digest, member_set_digest, replay_set_digest, hold_set_digest,
          expected_owner_count, expected_upload_count, expected_replay_count,
          expected_member_count, expected_hold_count, settlement_evidence_kind,
          settlement_evidence_digest, lineage_migration, lineage_digest,
          r2_identity_digest, source_commit, source_version,
          preparing_worker_version_id, active_worker_version_id,
          execution_handoff_count, retention_policy_kind,
          retention_policy_digest, detail_retention_milliseconds, phase, prepared_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 4, 5, 2, 28, 29,
               'takosumi.apply-run-failure@v1', ?,
               '0045_cloudflare_provider_executor_operations.sql',
               'sha256:7d87cb2eec7a3434ece89f1e5d2ecac470d1e717c0611ee3f47b5390f991f9f2',
               ?, ?, 'recovery-test-v1', ?, ?, 0,
               'takoserver.exact-failed-run-artifact-recovery-detail-retention@v1',
               ?, ?, 'prepared', 1000)`,
    )
    .run(
      requestDigest,
      sha("3"),
      TENANT,
      sha("4"),
      MANIFEST,
      sha("5"),
      sha("6"),
      sha("7"),
      sha("8"),
      sha("9"),
      sha("a"),
      sha("b"),
      "c".repeat(40),
      WORKER,
      WORKER,
      sha("d"),
      RETENTION,
    );
}

function insertUncertainty(database: Database, id: string): void {
  database
    .query(
      `INSERT INTO tf_artifact_consumer_uncertainties
         (tenant_id, consumer_kind, consumer_id, state, fence, reason,
          created_at, resolved_at)
       VALUES (?, 'deployment', ?, 'active', 1,
               'historical_deployment_digest_unknown', 1, NULL)`,
    )
    .run(TENANT, id);
}

function migrationIndex(): number {
  const index = MIGRATIONS.findIndex(({ name }) => name === MIGRATION);
  expect(index).toBeGreaterThan(0);
  return index;
}

function migratedDatabase(): Database {
  const database = new Database(":memory:");
  applyThrough(database, MIGRATIONS.length - 1);
  return database;
}

function applyThrough(database: Database, index: number): void {
  for (const migration of MIGRATIONS.slice(0, index + 1)) database.exec(migration.sql);
}

function sha(digit: string): `sha256:${string}` {
  return `sha256:${digit.repeat(64)}`;
}
