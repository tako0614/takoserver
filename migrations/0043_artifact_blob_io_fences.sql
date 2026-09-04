-- R2 cannot participate in a D1 transaction. Canonical blob writers and
-- collectors therefore share one durable, per-digest ownership row around
-- every external PUT or DELETE. A monotonically increasing fence prevents ABA;
-- the operation id distinguishes an exact lost acknowledgement from older
-- identical bytes at the same content-addressed key.

-- Refuse before creating any 0043 object when previous state contains a live
-- root and an already-deleting object in the same immutable closure. Choosing
-- either the consumer or the in-flight delete would invent authority.
INSERT INTO tf_artifact_gc_guards (token, valid)
SELECT 'migration-0043-artifact-blob-io', CASE WHEN NOT EXISTS (
  SELECT 1
  FROM tf_artifact_gc_candidates AS candidate
  JOIN tf_artifact_roots AS root ON root.state = 'active'
  WHERE candidate.state = 'deleting' AND (
    (root.target_kind = candidate.kind AND root.digest = candidate.digest) OR
    (candidate.kind = 'blob' AND root.target_kind = 'manifest' AND EXISTS (
      SELECT 1 FROM tf_artifact_manifest_members AS member
      WHERE member.manifest_digest = root.digest AND member.blob_digest = candidate.digest
    ))
  )
) THEN 1 ELSE 0 END;
DELETE FROM tf_artifact_gc_guards WHERE token = 'migration-0043-artifact-blob-io';

CREATE TABLE tf_artifact_blob_io_leases (
  digest TEXT PRIMARY KEY NOT NULL,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  operation_id TEXT NOT NULL UNIQUE,
  tenant_id TEXT,
  principal_id TEXT,
  upload_id TEXT,
  upload_fence INTEGER,
  root_fence INTEGER,
  expected_size INTEGER,
  candidate_fence INTEGER,
  lease_expires_at INTEGER,
  last_outcome TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    length(digest) = 71 AND
    substr(digest, 1, 7) = 'sha256:' AND
    substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (state IN ('available', 'writing', 'deleting')),
  CHECK (fence >= 1),
  CHECK (length(operation_id) BETWEEN 3 AND 128),
  CHECK (upload_fence IS NULL OR upload_fence >= 1),
  CHECK (root_fence IS NULL OR root_fence >= 1),
  CHECK (expected_size IS NULL OR expected_size >= 0),
  CHECK (candidate_fence IS NULL OR candidate_fence >= 1),
  CHECK (lease_expires_at IS NULL OR lease_expires_at >= 0),
  CHECK (last_outcome IN (
    'write_admitted', 'write_committed',
    'delete_claimed', 'delete_reclaimed', 'delete_started',
    'etag_changed', 'deleted', 'already_absent', 'reference_present'
  )),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK (
    (state = 'writing'
      AND tenant_id IS NOT NULL AND principal_id IS NOT NULL AND upload_id IS NOT NULL
      AND upload_fence IS NOT NULL AND root_fence IS NOT NULL
      AND expected_size IS NOT NULL AND candidate_fence IS NULL
      AND lease_expires_at IS NOT NULL) OR
    (state = 'deleting'
      AND tenant_id IS NULL AND principal_id IS NULL AND upload_id IS NULL
      AND upload_fence IS NULL AND root_fence IS NULL AND expected_size IS NULL
      AND candidate_fence IS NOT NULL AND lease_expires_at IS NOT NULL) OR
    (state = 'available'
      AND tenant_id IS NULL AND principal_id IS NULL AND upload_id IS NULL
      AND upload_fence IS NULL AND root_fence IS NULL AND expected_size IS NULL
      AND candidate_fence IS NULL AND lease_expires_at IS NULL)
  )
);

CREATE INDEX tf_artifact_blob_io_leases_due
  ON tf_artifact_blob_io_leases (state, lease_expires_at, updated_at, digest);

-- A released lease can be reused immediately, including before the previous
-- caller discovers that its D1 acknowledgement was lost. Preserve each exact
-- completed operation independently so later reuse cannot erase that proof.
CREATE TABLE tf_artifact_blob_io_results (
  operation_id TEXT PRIMARY KEY NOT NULL,
  digest TEXT NOT NULL,
  operation_kind TEXT NOT NULL,
  lease_fence INTEGER NOT NULL,
  candidate_fence INTEGER,
  tenant_id TEXT,
  principal_id TEXT,
  upload_id TEXT,
  upload_fence INTEGER,
  root_fence INTEGER,
  expected_size INTEGER,
  outcome TEXT NOT NULL,
  completed_at INTEGER NOT NULL,
  CHECK (length(operation_id) BETWEEN 3 AND 128),
  CHECK (
    length(digest) = 71 AND
    substr(digest, 1, 7) = 'sha256:' AND
    substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (operation_kind IN ('write', 'delete')),
  CHECK (lease_fence >= 1),
  CHECK (candidate_fence IS NULL OR candidate_fence >= 1),
  CHECK (upload_fence IS NULL OR upload_fence >= 1),
  CHECK (root_fence IS NULL OR root_fence >= 1),
  CHECK (expected_size IS NULL OR expected_size >= 0),
  CHECK (completed_at >= 0),
  CHECK (
    (operation_kind = 'write'
      AND candidate_fence IS NULL
      AND tenant_id IS NOT NULL AND principal_id IS NOT NULL AND upload_id IS NOT NULL
      AND upload_fence IS NOT NULL AND root_fence IS NOT NULL
      AND expected_size IS NOT NULL AND outcome = 'write_committed') OR
    (operation_kind = 'delete'
      AND candidate_fence IS NOT NULL
      AND tenant_id IS NULL AND principal_id IS NULL AND upload_id IS NULL
      AND upload_fence IS NULL AND root_fence IS NULL AND expected_size IS NULL
      AND outcome IN ('deleted', 'already_absent', 'etag_changed', 'reference_present'))
  )
);

CREATE INDEX tf_artifact_blob_io_results_digest
  ON tf_artifact_blob_io_results (digest, operation_kind, completed_at, operation_id);

CREATE TRIGGER tf_artifact_blob_io_result_immutable_update
BEFORE UPDATE ON tf_artifact_blob_io_results
BEGIN
  SELECT RAISE(ABORT, 'artifact_blob_io_result_immutable');
END;

CREATE TRIGGER tf_artifact_blob_io_result_durable_delete
BEFORE DELETE ON tf_artifact_blob_io_results
BEGIN
  SELECT RAISE(ABORT, 'artifact_blob_io_result_durable');
END;

-- A deleting candidate created by a pre-0043 Worker remains fenced on upgrade.
-- Its synthetic operation has already crossed an unknown external boundary:
-- neither observed absence nor elapsed time can prove that invocation will not
-- resume, so new code never releases or reuses this owner automatically.
INSERT INTO tf_artifact_blob_io_leases
  (digest, state, fence, operation_id, tenant_id, principal_id, upload_id,
   upload_fence, root_fence, expected_size, candidate_fence, lease_expires_at,
   last_outcome, created_at, updated_at)
SELECT digest, 'deleting', 1,
       'legacy-delete-' || substr(digest, 8),
       NULL, NULL, NULL, NULL, NULL, NULL, fence, updated_at,
       'delete_started', created_at, updated_at
FROM tf_artifact_gc_candidates
WHERE kind = 'blob' AND state = 'deleting';

-- The deployment protocol proves no pre-0043 invocation can run after this
-- migration. SQL triggers cannot intercept an older invocation's R2 request,
-- so this migration deliberately does not manufacture runtime compatibility
-- for old code. The remaining triggers defend current SQL state transitions.

-- A hold cannot cross an exclusive delete fence. Before the external boundary
-- it cancels a candidate only when a live root proves that tenant still owns
-- the digest.
CREATE TRIGGER tf_artifact_blob_hold_delete_guard
BEFORE INSERT ON tf_artifact_holds
WHEN NEW.kind = 'blob' AND EXISTS (
  SELECT 1 FROM tf_artifact_gc_candidates AS candidate
  WHERE candidate.kind = 'blob' AND candidate.digest = NEW.digest
    AND candidate.state = 'deleting'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_gc_delete_fenced');
END;

CREATE TRIGGER tf_artifact_blob_hold_cancels_candidate
AFTER INSERT ON tf_artifact_holds
WHEN NEW.kind = 'blob' AND EXISTS (
  SELECT 1 FROM tf_artifact_roots AS root
  WHERE root.tenant_id = NEW.tenant_id AND root.state = 'active' AND (
    (root.target_kind = 'blob' AND root.digest = NEW.digest) OR
    (root.target_kind = 'manifest' AND EXISTS (
      SELECT 1 FROM tf_artifact_manifest_members AS member
      WHERE member.manifest_digest = root.digest AND member.blob_digest = NEW.digest
    ))
  )
)
BEGIN
  UPDATE tf_artifact_gc_candidates
  SET state = 'cancelled', fence = fence + 1, expected_etag = NULL,
      last_outcome = 'reference_present',
      updated_at = CASE WHEN updated_at < created_at THEN created_at ELSE updated_at END,
      deleted_at = NULL
  WHERE kind = 'blob' AND digest = NEW.digest
    AND state IN ('pending', 'retry', 'deleted', 'cancelled');
END;

-- Upload completion and abandonment must wait for every admitted PUT.
CREATE TRIGGER tf_artifact_upload_transition_write_guard
BEFORE UPDATE OF lifecycle_state ON tf_artifact_uploads
WHEN OLD.lifecycle_state = 'open' AND NEW.lifecycle_state <> 'open' AND EXISTS (
  SELECT 1
  FROM tf_artifact_manifest_members AS member
  JOIN tf_artifact_blob_io_leases AS lease ON lease.digest = member.blob_digest
  WHERE member.manifest_digest = OLD.manifest_digest AND lease.state = 'writing'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_blob_write_fenced');
END;

-- The old same-kind guard cannot see that a manifest root retains all member
-- blobs. Rebuild it so every root kind and every reactivation/digest change is
-- serialized against member deletion.
DROP TRIGGER IF EXISTS tf_artifact_active_root_insert_guard;
DROP TRIGGER IF EXISTS tf_artifact_active_root_update_guard;

CREATE TRIGGER tf_artifact_active_root_insert_guard
BEFORE INSERT ON tf_artifact_roots
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM tf_artifact_gc_candidates AS candidate
  WHERE candidate.state = 'deleting' AND (
    (candidate.kind = NEW.target_kind AND candidate.digest = NEW.digest) OR
    (NEW.target_kind = 'manifest' AND candidate.kind = 'blob' AND EXISTS (
      SELECT 1 FROM tf_artifact_manifest_members AS member
      WHERE member.manifest_digest = NEW.digest AND member.blob_digest = candidate.digest
    ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_gc_delete_fenced');
END;

CREATE TRIGGER tf_artifact_active_root_update_guard
BEFORE UPDATE OF state, target_kind, digest ON tf_artifact_roots
WHEN NEW.state = 'active'
  AND (OLD.state <> 'active' OR OLD.target_kind <> NEW.target_kind OR OLD.digest <> NEW.digest)
  AND EXISTS (
    SELECT 1 FROM tf_artifact_gc_candidates AS candidate
    WHERE candidate.state = 'deleting' AND (
      (candidate.kind = NEW.target_kind AND candidate.digest = NEW.digest) OR
      (NEW.target_kind = 'manifest' AND candidate.kind = 'blob' AND EXISTS (
        SELECT 1 FROM tf_artifact_manifest_members AS member
        WHERE member.manifest_digest = NEW.digest AND member.blob_digest = candidate.digest
      ))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_gc_delete_fenced');
END;

-- The reverse edge is equally important: once any manifest consumer is live,
-- neither an INSERT nor a transition may put one immutable member into the
-- deleting state. D1 serializes this trigger with provider persistence.
CREATE TRIGGER tf_artifact_blob_candidate_insert_root_guard
BEFORE INSERT ON tf_artifact_gc_candidates
WHEN NEW.state = 'deleting' AND EXISTS (
  SELECT 1 FROM tf_artifact_roots AS root
  WHERE root.state = 'active' AND (
    (root.target_kind = NEW.kind AND root.digest = NEW.digest) OR
    (NEW.kind = 'blob' AND root.target_kind = 'manifest' AND EXISTS (
      SELECT 1 FROM tf_artifact_manifest_members AS member
      WHERE member.manifest_digest = root.digest AND member.blob_digest = NEW.digest
    ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_gc_active_root');
END;

CREATE TRIGGER tf_artifact_blob_candidate_update_root_guard
BEFORE UPDATE OF state, kind, digest ON tf_artifact_gc_candidates
WHEN NEW.state = 'deleting'
  AND (OLD.state <> 'deleting' OR OLD.kind <> NEW.kind OR OLD.digest <> NEW.digest)
  AND EXISTS (
    SELECT 1 FROM tf_artifact_roots AS root
    WHERE root.state = 'active' AND (
      (root.target_kind = NEW.kind AND root.digest = NEW.digest) OR
      (NEW.kind = 'blob' AND root.target_kind = 'manifest' AND EXISTS (
        SELECT 1 FROM tf_artifact_manifest_members AS member
        WHERE member.manifest_digest = root.digest AND member.blob_digest = NEW.digest
      ))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_gc_active_root');
END;

-- Membership is content-addressed metadata. New rows must join the same fence;
-- existing relationships cannot be rewritten or removed to evade it.
CREATE TRIGGER tf_artifact_manifest_member_insert_delete_guard
BEFORE INSERT ON tf_artifact_manifest_members
WHEN EXISTS (
  SELECT 1
  FROM tf_artifact_gc_candidates AS candidate
  JOIN tf_artifact_roots AS root
    ON root.target_kind = 'manifest' AND root.digest = NEW.manifest_digest
  WHERE candidate.kind = 'blob' AND candidate.digest = NEW.blob_digest
    AND candidate.state = 'deleting' AND root.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_gc_delete_fenced');
END;

CREATE TRIGGER tf_artifact_manifest_member_immutable_update
BEFORE UPDATE ON tf_artifact_manifest_members
BEGIN
  SELECT RAISE(ABORT, 'artifact_manifest_member_immutable');
END;

CREATE TRIGGER tf_artifact_manifest_member_immutable_delete
BEFORE DELETE ON tf_artifact_manifest_members
BEGIN
  SELECT RAISE(ABORT, 'artifact_manifest_member_immutable');
END;
