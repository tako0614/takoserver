import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";

const MIGRATION = "0043_artifact_blob_io_fences.sql";
const manifestDigest = `sha256:${"a".repeat(64)}`;

function migrationIndex(): number {
  const index = MIGRATIONS.findIndex(({ name }) => name === MIGRATION);
  expect(index).toBe(42);
  return index;
}

function databaseBefore0043(): Database {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS.slice(0, migrationIndex())) database.exec(migration.sql);
  return database;
}

function addOpenUpload(
  database: Database,
  input: {
    readonly id: string;
    readonly tenantId: string;
    readonly principalId: string;
    readonly memberDigest: string;
  },
): void {
  database
    .query(
      `INSERT INTO tf_artifact_uploads
         (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at,
          lifecycle_state, lifecycle_fence, updated_at, abandoned_at)
       VALUES (?, ?, ?, '{}', ?, 10, 'open', 1, 10, NULL)`,
    )
    .run(input.id, input.tenantId, input.principalId, manifestDigest);
  database
    .query(
      `INSERT OR IGNORE INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
       VALUES (?, ?)`,
    )
    .run(manifestDigest, input.memberDigest);
  database
    .query(
      `INSERT INTO tf_artifact_roots
         (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
          expires_at, release_reason, created_at, released_at)
       VALUES (?, 'upload', ?, 'manifest', ?, 'active', 1,
               NULL, NULL, 10, NULL)`,
    )
    .run(input.tenantId, input.id, manifestDigest);
}

test("0043 preserves an existing deleting blob as a permanent fail-closed lease", () => {
  const database = databaseBefore0043();
  const deletingDigest = `sha256:${"d".repeat(64)}`;
  database
    .query(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'deleting', 2, 100, 'legacy-etag', 1, 'claimed', 10, 20, NULL)`,
    )
    .run(deletingDigest);

  database.exec(MIGRATIONS[migrationIndex()]?.sql ?? "");

  expect(
    database
      .query(
        `SELECT state, fence, operation_id, candidate_fence, lease_expires_at, last_outcome
         FROM tf_artifact_blob_io_leases WHERE digest = ?`,
      )
      .get(deletingDigest),
  ).toEqual({
    state: "deleting",
    fence: 1,
    operation_id: `legacy-delete-${"d".repeat(64)}`,
    candidate_fence: 2,
    lease_expires_at: 20,
    last_outcome: "delete_started",
  });
});

test("0043 refuses a pre-existing live manifest member deletion before creating new tables", () => {
  const database = databaseBefore0043();
  database.exec(`
    CREATE TABLE applied_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
  `);
  for (const migration of MIGRATIONS.slice(0, migrationIndex())) {
    database
      .query("INSERT INTO applied_migrations (name, applied_at) VALUES (?, 'now')")
      .run(migration.name);
  }
  const memberDigest = `sha256:${"e".repeat(64)}`;
  database
    .query("INSERT INTO tf_artifact_manifest_members (manifest_digest, blob_digest) VALUES (?, ?)")
    .run(manifestDigest, memberDigest);
  database
    .query(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'deleting', 1, 1, 'etag-conflict', 1,
               'claimed', 1, 1, NULL)`,
    )
    .run(memberDigest);
  database
    .query(
      `INSERT INTO tf_artifact_roots
         (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
          expires_at, release_reason, created_at, released_at)
       VALUES ('tenant_migration_conflict', 'resource', 'resource-conflict',
               'manifest', ?, 'active', 1, NULL, NULL, 1, NULL)`,
    )
    .run(manifestDigest);

  expect(() => migrateSqlite(database)).toThrow("CHECK constraint failed: valid = 1");
  expect(
    database
      .query(
        `SELECT name FROM sqlite_schema
         WHERE name IN ('tf_artifact_blob_io_leases', 'tf_artifact_blob_io_results')`,
      )
      .all(),
  ).toEqual([]);
  expect(
    database
      .query(
        `SELECT root.state AS root_state, candidate.state AS candidate_state
         FROM tf_artifact_roots AS root
         JOIN tf_artifact_manifest_members AS member ON member.manifest_digest = root.digest
         JOIN tf_artifact_gc_candidates AS candidate ON candidate.digest = member.blob_digest
         WHERE root.root_id = 'resource-conflict'`,
      )
      .get(),
  ).toEqual({ root_state: "active", candidate_state: "deleting" });
});

test("0043 keeps completed operation evidence immutable across lease reuse", () => {
  const database = databaseBefore0043();
  database.exec(MIGRATIONS[migrationIndex()]?.sql ?? "");
  const digest = `sha256:${"f".repeat(64)}`;
  database
    .query(
      `INSERT INTO tf_artifact_blob_io_leases
         (digest, state, fence, operation_id, tenant_id, principal_id, upload_id,
          upload_fence, root_fence, expected_size, candidate_fence,
          lease_expires_at, last_outcome, created_at, updated_at)
       VALUES (?, 'available', 2, 'abw_completed_operation',
               NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL,
               'write_committed', 10, 20)`,
    )
    .run(digest);
  database
    .query(
      `INSERT INTO tf_artifact_blob_io_results
         (operation_id, digest, operation_kind, lease_fence, candidate_fence,
          tenant_id, principal_id, upload_id, upload_fence, root_fence,
          expected_size, outcome, completed_at)
       VALUES ('abw_completed_operation', ?, 'write', 1, NULL,
               'tenant_result', 'run:result', 'up_result', 1, 1,
               12, 'write_committed', 20)`,
    )
    .run(digest);

  database
    .query(
      `UPDATE tf_artifact_blob_io_leases
       SET operation_id = 'abw_later_operation', fence = fence + 1, updated_at = 21
       WHERE digest = ?`,
    )
    .run(digest);
  expect(
    database
      .query(
        `SELECT operation_id, digest, lease_fence, outcome
         FROM tf_artifact_blob_io_results`,
      )
      .get(),
  ).toEqual({
    operation_id: "abw_completed_operation",
    digest,
    lease_fence: 1,
    outcome: "write_committed",
  });
  expect(() =>
    database.query("UPDATE tf_artifact_blob_io_results SET completed_at = 21").run(),
  ).toThrow("artifact_blob_io_result_immutable");
  expect(() => database.query("DELETE FROM tf_artifact_blob_io_results").run()).toThrow(
    "artifact_blob_io_result_durable",
  );
});

test("0043 fences holds and upload transitions against current blob owners", () => {
  const database = databaseBefore0043();
  const pendingDigest = `sha256:${"c".repeat(64)}`;
  const deletingDigest = `sha256:${"d".repeat(64)}`;
  const writingDigest = `sha256:${"e".repeat(64)}`;
  addOpenUpload(database, {
    id: "up_legacy_compat",
    tenantId: "tenant_compat",
    principalId: "run:legacy-worker",
    memberDigest: pendingDigest,
  });
  database
    .query(
      `INSERT OR IGNORE INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
       VALUES (?, ?), (?, ?)`,
    )
    .run(manifestDigest, deletingDigest, manifestDigest, writingDigest);
  database
    .query(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'pending', 1, 100, NULL, 0, 'pending', 10, 10, NULL),
              ('blob', ?, 'deleting', 2, 100, 'legacy-etag', 1, 'claimed', 10, 20, NULL)`,
    )
    .run(pendingDigest, deletingDigest);
  database.exec(MIGRATIONS[migrationIndex()]?.sql ?? "");

  database
    .query(
      `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
       VALUES ('tenant_compat', ?, 'blob')`,
    )
    .run(pendingDigest);
  expect(
    database
      .query(
        `SELECT state, fence, last_outcome FROM tf_artifact_gc_candidates
         WHERE kind = 'blob' AND digest = ?`,
      )
      .get(pendingDigest),
  ).toEqual({ state: "cancelled", fence: 2, last_outcome: "reference_present" });

  expect(() =>
    database
      .query(
        `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
         VALUES ('tenant_compat', ?, 'blob')`,
      )
      .run(deletingDigest),
  ).toThrow("artifact_gc_delete_fenced");

  database
    .query(
      `INSERT INTO tf_artifact_blob_io_leases
         (digest, state, fence, operation_id, tenant_id, principal_id, upload_id,
          upload_fence, root_fence, expected_size, candidate_fence,
          lease_expires_at, last_outcome, created_at, updated_at)
       VALUES (?, 'writing', 1, 'abw_previous_worker_guard', 'tenant_compat',
               'run:legacy-worker', 'up_legacy_compat', 1, 1, 1, NULL, 100,
               'write_admitted', 30, 30)`,
    )
    .run(writingDigest);
  expect(() =>
    database
      .query(
        `UPDATE tf_artifact_uploads
         SET lifecycle_state = 'abandoned', lifecycle_fence = 2,
             updated_at = 31, abandoned_at = 31
         WHERE id = 'up_legacy_compat'`,
      )
      .run(),
  ).toThrow("artifact_blob_write_fenced");
});

test("0043 serializes every manifest-root path and membership edge against member deletion", () => {
  const database = databaseBefore0043();
  database.exec(MIGRATIONS[migrationIndex()]?.sql ?? "");
  const deletingMember = `sha256:${"1".repeat(64)}`;
  database
    .query(`INSERT INTO tf_artifact_manifest_members (manifest_digest, blob_digest) VALUES (?, ?)`)
    .run(manifestDigest, deletingMember);
  database
    .query(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'deleting', 1, 1, 'etag-member', 1, 'claimed', 1, 1, NULL)`,
    )
    .run(deletingMember);

  for (const [index, rootKind] of [
    "upload",
    "replay",
    "resource",
    "deployment",
    "legacy-hold",
    "legacy-manifest",
  ].entries()) {
    const expiresAt = rootKind === "replay" ? 10_000 : null;
    expect(() =>
      database
        .query(
          `INSERT INTO tf_artifact_roots
             (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
              expires_at, release_reason, created_at, released_at)
           VALUES ('tenant_root_fence', ?, ?, 'manifest', ?, 'active', 1,
                   ?, NULL, 1, NULL)`,
        )
        .run(rootKind, `active-${index}`, manifestDigest, expiresAt),
    ).toThrow("artifact_gc_delete_fenced");

    database
      .query(
        `INSERT INTO tf_artifact_roots
           (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
            expires_at, release_reason, created_at, released_at)
         VALUES ('tenant_root_fence', ?, ?, 'manifest', ?, 'released', 1,
                 ?, ?, 1, 2)`,
      )
      .run(
        rootKind,
        `released-${index}`,
        manifestDigest,
        expiresAt,
        rootKind === "replay" ? "replay_expired" : "consumer_closed",
      );
    expect(() =>
      database
        .query(
          `UPDATE tf_artifact_roots
           SET state = 'active', fence = fence + 1,
               release_reason = NULL, released_at = NULL
           WHERE tenant_id = 'tenant_root_fence' AND root_kind = ? AND root_id = ?`,
        )
        .run(rootKind, `released-${index}`),
    ).toThrow("artifact_gc_delete_fenced");
  }

  const rootedManifest = `sha256:${"2".repeat(64)}`;
  const updateMember = `sha256:${"3".repeat(64)}`;
  const insertMember = `sha256:${"4".repeat(64)}`;
  database
    .query(
      `INSERT INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
       VALUES (?, ?), (?, ?)`,
    )
    .run(rootedManifest, updateMember, rootedManifest, insertMember);
  database
    .query(
      `INSERT INTO tf_artifact_roots
         (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
          expires_at, release_reason, created_at, released_at)
       VALUES ('tenant_root_fence', 'resource', 'rooted-resource', 'manifest', ?,
               'active', 1, NULL, NULL, 1, NULL)`,
    )
    .run(rootedManifest);
  database
    .query(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'pending', 1, 1, NULL, 0, 'pending', 1, 1, NULL)`,
    )
    .run(updateMember);
  expect(() =>
    database
      .query(
        `UPDATE tf_artifact_gc_candidates
         SET state = 'deleting', fence = fence + 1, expected_etag = 'etag-update',
             attempts = attempts + 1, last_outcome = 'claimed', updated_at = 2
         WHERE kind = 'blob' AND digest = ? AND state = 'pending'`,
      )
      .run(updateMember),
  ).toThrow("artifact_gc_active_root");
  expect(() =>
    database
      .query(
        `INSERT INTO tf_artifact_gc_candidates
           (kind, digest, state, fence, not_before, expected_etag, attempts,
            last_outcome, created_at, updated_at, deleted_at)
         VALUES ('blob', ?, 'deleting', 1, 1, 'etag-insert', 1,
                 'claimed', 1, 1, NULL)`,
      )
      .run(insertMember),
  ).toThrow("artifact_gc_active_root");

  const lateManifest = `sha256:${"5".repeat(64)}`;
  const lateMember = `sha256:${"6".repeat(64)}`;
  database
    .query(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'deleting', 1, 1, 'etag-late', 1, 'claimed', 1, 1, NULL)`,
    )
    .run(lateMember);
  database
    .query(
      `INSERT INTO tf_artifact_roots
         (tenant_id, root_kind, root_id, target_kind, digest, state, fence,
          expires_at, release_reason, created_at, released_at)
       VALUES ('tenant_root_fence', 'deployment', 'late-root', 'manifest', ?,
               'active', 1, NULL, NULL, 1, NULL)`,
    )
    .run(lateManifest);
  expect(() =>
    database
      .query(
        `INSERT INTO tf_artifact_manifest_members (manifest_digest, blob_digest)
         VALUES (?, ?)`,
      )
      .run(lateManifest, lateMember),
  ).toThrow("artifact_gc_delete_fenced");

  // A provider operation may have passed artifact resolution before the
  // collector claimed a member. Its later authoritative Resource persistence
  // must fail atomically when the resource-root trigger reaches this fence.
  const providerManifest = `sha256:${"8".repeat(64)}`;
  const providerMember = `sha256:${"9".repeat(64)}`;
  database
    .query(`INSERT INTO tf_artifact_manifest_members (manifest_digest, blob_digest) VALUES (?, ?)`)
    .run(providerManifest, providerMember);
  database
    .query(
      `INSERT INTO tf_artifact_gc_candidates
         (kind, digest, state, fence, not_before, expected_etag, attempts,
          last_outcome, created_at, updated_at, deleted_at)
       VALUES ('blob', ?, 'deleting', 1, 1, 'etag-provider', 1, 'claimed', 1, 1, NULL)`,
    )
    .run(providerMember);
  expect(() =>
    database
      .query(
        `INSERT INTO tf_resources
           (tenant_id, space, api_version, kind, name, uid, generation, revision,
            resource_json, relations_json, package_digest, implementation_digest, updated_at)
         VALUES ('tenant_root_fence', 'main', 'example.test/v1', 'Widget',
                 'paused-provider', 'uid_paused_provider', '1', 'revision-1',
                 ?, '[]', NULL, NULL, 2)`,
      )
      .run(JSON.stringify({ spec: { manifestDigest: providerManifest } })),
  ).toThrow("artifact_gc_delete_fenced");
  expect(
    database
      .query("SELECT COUNT(*) AS total FROM tf_resources WHERE uid = 'uid_paused_provider'")
      .get(),
  ).toEqual({ total: 0 });

  expect(() =>
    database
      .query(
        `INSERT INTO tf_artifact_gc_candidates
           (kind, digest, state, fence, not_before, expected_etag, attempts,
            last_outcome, created_at, updated_at, deleted_at)
         VALUES ('blob', ?, 'deleting', 1, 1, 'etag-unrelated', 1,
                 'claimed', 1, 1, NULL)`,
      )
      .run(`sha256:${"7".repeat(64)}`),
  ).not.toThrow();
});
