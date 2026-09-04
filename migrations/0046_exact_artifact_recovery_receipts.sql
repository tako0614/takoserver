-- One forward-only authorization exists for one reviewed failed-run artifact
-- recovery. The migration contains the shape and invariants, never an
-- incident descriptor or its digest. The descriptor is admitted later by a
-- route-less, immutable Worker Version.

DROP TRIGGER IF EXISTS tf_artifact_owner_closure_receipt_exact_insert;
DROP TRIGGER IF EXISTS tf_artifact_owner_closure_receipt_immutable_update;
DROP TRIGGER IF EXISTS tf_artifact_owner_closure_receipt_durable_delete;
DROP INDEX IF EXISTS tf_artifact_owner_closure_receipts_exact;

-- Blob I/O results remain durable by default. Recovery-created results carry
-- an explicit kind and request binding so the owner can later remove only the
-- one incident's retained detail without relying on an operation-id prefix.
DROP TRIGGER IF EXISTS tf_artifact_blob_io_result_durable_delete;

-- Recovery mutations reuse the generic candidate table, but ordinary GC must
-- remain deployable against the immediately preceding schema. Extend its
-- existing transient batch guard with an explicit authority kind rather than
-- teaching the public collector to query incident-only tables. A recovery
-- guard exists only inside the exact coordinator's atomic batch.
ALTER TABLE tf_artifact_gc_guards
  ADD COLUMN authority_kind TEXT NOT NULL DEFAULT 'artifact_gc'
  CHECK (authority_kind IN ('artifact_gc', 'exact_failed_run_recovery'));

ALTER TABLE tf_artifact_gc_guards
  ADD COLUMN recovery_request_digest TEXT
  CHECK (
    (authority_kind = 'artifact_gc' AND recovery_request_digest IS NULL) OR
    (authority_kind = 'exact_failed_run_recovery'
      AND length(recovery_request_digest) = 71
      AND substr(recovery_request_digest, 1, 7) = 'sha256:'
      AND substr(recovery_request_digest, 8) NOT GLOB '*[^0-9a-f]*')
  );

ALTER TABLE tf_artifact_blob_io_results
  ADD COLUMN receipt_kind TEXT NOT NULL DEFAULT 'artifact_io'
  CHECK (receipt_kind IN ('artifact_io', 'exact_failed_run_recovery'));

ALTER TABLE tf_artifact_blob_io_results
  ADD COLUMN recovery_request_digest TEXT
  CHECK (
    (receipt_kind = 'artifact_io' AND recovery_request_digest IS NULL) OR
    (receipt_kind = 'exact_failed_run_recovery'
      AND length(recovery_request_digest) = 71
      AND substr(recovery_request_digest, 1, 7) = 'sha256:'
      AND substr(recovery_request_digest, 8) NOT GLOB '*[^0-9a-f]*')
  );

CREATE INDEX tf_artifact_blob_io_results_recovery
  ON tf_artifact_blob_io_results
    (recovery_request_digest, receipt_kind, completed_at, operation_id);

ALTER TABLE tf_artifact_owner_closure_receipts
  RENAME TO tf_artifact_owner_closure_receipts_before_0046;

-- `receipt_kind` and `recovery_request_digest` are authoritative. Recovery
-- identity is never inferred from a receipt-id prefix or principal spelling.
CREATE TABLE tf_artifact_owner_closure_receipts (
  receipt_id TEXT PRIMARY KEY NOT NULL,
  receipt_fence INTEGER NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  upload_id TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  upload_fence INTEGER NOT NULL,
  root_fence INTEGER NOT NULL,
  receipt_kind TEXT NOT NULL DEFAULT 'run_owner_closure',
  recovery_request_digest TEXT,
  state TEXT NOT NULL,
  closed_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  purge_after INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (length(receipt_id) BETWEEN 3 AND 128),
  CHECK (receipt_fence >= 1),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(principal_id) BETWEEN 5 AND 255),
  CHECK (length(upload_id) BETWEEN 3 AND 128),
  CHECK (
    length(manifest_digest) = 71 AND
    substr(manifest_digest, 1, 7) = 'sha256:' AND
    substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (upload_fence >= 1),
  CHECK (root_fence >= 1),
  CHECK (receipt_kind IN ('run_owner_closure', 'exact_failed_run_recovery')),
  CHECK (
    (receipt_kind = 'run_owner_closure'
      AND recovery_request_digest IS NULL
      AND substr(principal_id, 1, 4) = 'run:'
      AND state IN ('closed', 'revoked')
      AND purge_after IS NULL) OR
    (receipt_kind = 'exact_failed_run_recovery'
      AND tenant_id = 'org_takosumi_hosted_staging'
      AND length(recovery_request_digest) = 71
      AND substr(recovery_request_digest, 1, 7) = 'sha256:'
      AND substr(recovery_request_digest, 8) NOT GLOB '*[^0-9a-f]*'
      AND state IN ('recovery_active', 'recovery_complete')
      AND purge_after IS NOT NULL)
  ),
  CHECK (closed_at >= 0),
  CHECK (expires_at > closed_at),
  CHECK (purge_after IS NULL OR purge_after >= created_at),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
);

INSERT INTO tf_artifact_owner_closure_receipts
  (receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
   manifest_digest, upload_fence, root_fence, receipt_kind,
   recovery_request_digest, state, closed_at, expires_at, purge_after,
   created_at, updated_at)
SELECT receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
       manifest_digest, upload_fence, root_fence, 'run_owner_closure', NULL,
       state, closed_at, expires_at, NULL, created_at, updated_at
FROM tf_artifact_owner_closure_receipts_before_0046;

DROP TABLE tf_artifact_owner_closure_receipts_before_0046;

CREATE INDEX tf_artifact_owner_closure_receipts_exact
  ON tf_artifact_owner_closure_receipts
    (tenant_id, principal_id, upload_id, manifest_digest, upload_fence,
     root_fence, receipt_kind, state, expires_at, closed_at);

CREATE INDEX tf_artifact_owner_closure_receipts_recovery
  ON tf_artifact_owner_closure_receipts
    (recovery_request_digest, receipt_kind, state, purge_after);

-- The compact row is retained forever as the authorization and terminal
-- receipt. Incident detail lives in separately purgeable tables below.
CREATE TABLE tf_artifact_recovery_once (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  request_digest TEXT NOT NULL UNIQUE,
  evidence_digest TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  logical_target_digest TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  owner_set_digest TEXT NOT NULL,
  upload_set_digest TEXT NOT NULL,
  member_set_digest TEXT NOT NULL,
  replay_set_digest TEXT NOT NULL,
  hold_set_digest TEXT NOT NULL,
  expected_owner_count INTEGER NOT NULL CHECK (expected_owner_count = 4),
  expected_upload_count INTEGER NOT NULL CHECK (expected_upload_count = 5),
  expected_replay_count INTEGER NOT NULL CHECK (expected_replay_count = 2),
  expected_member_count INTEGER NOT NULL CHECK (expected_member_count = 28),
  expected_hold_count INTEGER NOT NULL CHECK (expected_hold_count = 29),
  settlement_evidence_kind TEXT NOT NULL,
  settlement_evidence_digest TEXT NOT NULL,
  lineage_migration TEXT NOT NULL,
  lineage_digest TEXT NOT NULL,
  r2_identity_digest TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  source_version TEXT NOT NULL,
  preparing_worker_version_id TEXT NOT NULL,
  active_worker_version_id TEXT NOT NULL,
  execution_handoff_count INTEGER NOT NULL DEFAULT 0,
  retention_policy_kind TEXT NOT NULL,
  retention_policy_digest TEXT NOT NULL,
  detail_retention_milliseconds INTEGER NOT NULL,
  phase TEXT NOT NULL,
  prepared_at INTEGER NOT NULL,
  completed_at INTEGER,
  result_set_digest TEXT,
  purge_after INTEGER,
  purge_worker_version_id TEXT,
  purge_authorization_digest TEXT,
  purge_authorized_at INTEGER,
  detail_state TEXT NOT NULL DEFAULT 'active',
  details_purged_at INTEGER,
  CHECK (tenant_id = 'org_takosumi_hosted_staging'),
  CHECK (
    length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:' AND
    substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(evidence_digest) = 71 AND substr(evidence_digest, 1, 7) = 'sha256:' AND
    substr(evidence_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(logical_target_digest) = 71 AND
    substr(logical_target_digest, 1, 7) = 'sha256:' AND
    substr(logical_target_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(manifest_digest) = 71 AND substr(manifest_digest, 1, 7) = 'sha256:' AND
    substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(owner_set_digest) = 71 AND substr(owner_set_digest, 1, 7) = 'sha256:' AND
    substr(owner_set_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(upload_set_digest) = 71 AND substr(upload_set_digest, 1, 7) = 'sha256:' AND
    substr(upload_set_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(member_set_digest) = 71 AND substr(member_set_digest, 1, 7) = 'sha256:' AND
    substr(member_set_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(replay_set_digest) = 71 AND substr(replay_set_digest, 1, 7) = 'sha256:' AND
    substr(replay_set_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (
    length(hold_set_digest) = 71 AND substr(hold_set_digest, 1, 7) = 'sha256:' AND
    substr(hold_set_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(settlement_evidence_kind) BETWEEN 3 AND 128),
  CHECK (
    length(settlement_evidence_digest) = 71 AND
    substr(settlement_evidence_digest, 1, 7) = 'sha256:' AND
    substr(settlement_evidence_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (lineage_migration = '0045_cloudflare_provider_executor_operations.sql'),
  CHECK (lineage_digest = 'sha256:7d87cb2eec7a3434ece89f1e5d2ecac470d1e717c0611ee3f47b5390f991f9f2'),
  CHECK (
    length(r2_identity_digest) = 71 AND substr(r2_identity_digest, 1, 7) = 'sha256:' AND
    substr(r2_identity_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(source_commit) = 40 AND source_commit NOT GLOB '*[^0-9a-f]*'),
  CHECK (length(source_version) BETWEEN 1 AND 128),
  CHECK (length(preparing_worker_version_id) = 36),
  CHECK (length(active_worker_version_id) = 36),
  CHECK (execution_handoff_count >= 0),
  CHECK (length(retention_policy_kind) BETWEEN 3 AND 128),
  CHECK (
    length(retention_policy_digest) = 71 AND
    substr(retention_policy_digest, 1, 7) = 'sha256:' AND
    substr(retention_policy_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (detail_retention_milliseconds BETWEEN 3600000 AND 31536000000),
  CHECK (phase IN ('prepared', 'settling', 'complete', 'revoked')),
  CHECK (prepared_at >= 0),
  CHECK (
    (phase IN ('prepared', 'settling', 'revoked')
      AND completed_at IS NULL AND result_set_digest IS NULL AND purge_after IS NULL) OR
    (phase = 'complete'
      AND completed_at IS NOT NULL AND completed_at >= prepared_at
      AND length(result_set_digest) = 71
      AND substr(result_set_digest, 1, 7) = 'sha256:'
      AND substr(result_set_digest, 8) NOT GLOB '*[^0-9a-f]*'
      AND purge_after = completed_at + detail_retention_milliseconds)
  ),
  CHECK (detail_state IN ('active', 'purging', 'purged')),
  CHECK (
    (detail_state = 'active'
      AND purge_worker_version_id IS NULL
      AND purge_authorization_digest IS NULL
      AND purge_authorized_at IS NULL
      AND details_purged_at IS NULL) OR
    (detail_state = 'purging'
      AND phase = 'complete'
      AND purge_worker_version_id = active_worker_version_id
      AND length(purge_authorization_digest) = 71
      AND substr(purge_authorization_digest, 1, 7) = 'sha256:'
      AND substr(purge_authorization_digest, 8) NOT GLOB '*[^0-9a-f]*'
      AND purge_authorized_at IS NOT NULL AND purge_authorized_at >= purge_after
      AND details_purged_at IS NULL) OR
    (detail_state = 'purged'
      AND phase = 'complete'
      AND purge_worker_version_id = active_worker_version_id
      AND length(purge_authorization_digest) = 71
      AND substr(purge_authorization_digest, 1, 7) = 'sha256:'
      AND substr(purge_authorization_digest, 8) NOT GLOB '*[^0-9a-f]*'
      AND purge_authorized_at IS NOT NULL AND purge_authorized_at >= purge_after
      AND details_purged_at IS NOT NULL
      AND details_purged_at >= purge_after
      AND details_purged_at >= purge_authorized_at)
  )
);

-- A successor version becomes the sole executor only in the same atomic batch
-- that resolves the predecessor's ambiguous DELETE. The detailed chain is
-- retained until owner GC; result_set_digest commits its ordered digests.
CREATE TABLE tf_artifact_recovery_execution_handoffs (
  request_digest TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  candidate_ordinal INTEGER NOT NULL,
  candidate_fence INTEGER NOT NULL,
  predecessor_worker_version_id TEXT NOT NULL,
  successor_worker_version_id TEXT NOT NULL,
  resolution_kind TEXT NOT NULL,
  observed_etag TEXT,
  reviewed_operation_id TEXT,
  reviewed_candidate_fence INTEGER,
  review_evidence_digest TEXT,
  quiescence_evidence_digest TEXT NOT NULL,
  activated_at INTEGER NOT NULL,
  handoff_digest TEXT NOT NULL,
  purge_after INTEGER,
  PRIMARY KEY (request_digest, sequence),
  UNIQUE (request_digest, predecessor_worker_version_id),
  UNIQUE (request_digest, successor_worker_version_id),
  CHECK (
    length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:' AND
    substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (sequence >= 1),
  CHECK (candidate_ordinal BETWEEN 0 AND 27),
  CHECK (candidate_fence >= 1),
  CHECK (length(predecessor_worker_version_id) = 36),
  CHECK (length(successor_worker_version_id) = 36),
  CHECK (predecessor_worker_version_id <> successor_worker_version_id),
  CHECK (resolution_kind IN ('confirm-head-absent', 'reviewed-retry')),
  CHECK (
    (resolution_kind = 'confirm-head-absent'
      AND observed_etag IS NULL
      AND reviewed_operation_id IS NULL
      AND reviewed_candidate_fence IS NULL
      AND review_evidence_digest IS NULL) OR
    (resolution_kind = 'reviewed-retry'
      AND length(observed_etag) BETWEEN 1 AND 512
      AND length(reviewed_operation_id) BETWEEN 3 AND 128
      AND reviewed_candidate_fence = candidate_fence + 2
      AND length(review_evidence_digest) = 71
      AND substr(review_evidence_digest, 1, 7) = 'sha256:'
      AND substr(review_evidence_digest, 8) NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK (
    length(quiescence_evidence_digest) = 71 AND
    substr(quiescence_evidence_digest, 1, 7) = 'sha256:' AND
    substr(quiescence_evidence_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (activated_at >= 0),
  CHECK (
    length(handoff_digest) = 71 AND substr(handoff_digest, 1, 7) = 'sha256:' AND
    substr(handoff_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (purge_after IS NULL OR purge_after >= activated_at)
);

CREATE TRIGGER tf_artifact_recovery_once_uncertainty_guard
BEFORE INSERT ON tf_artifact_recovery_once
WHEN EXISTS (
  SELECT 1 FROM tf_artifact_consumer_uncertainties AS uncertainty
  WHERE uncertainty.tenant_id = NEW.tenant_id AND uncertainty.state = 'active'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_consumer_uncertainty');
END;

CREATE TRIGGER tf_artifact_recovery_once_identity_immutable
BEFORE UPDATE OF
  singleton, request_digest, evidence_digest, tenant_id,
  logical_target_digest, manifest_digest, owner_set_digest, upload_set_digest,
  member_set_digest, replay_set_digest, hold_set_digest,
  expected_owner_count, expected_upload_count, expected_replay_count,
  expected_member_count, expected_hold_count, settlement_evidence_kind,
  settlement_evidence_digest, lineage_migration, lineage_digest,
  r2_identity_digest, source_commit, source_version,
  preparing_worker_version_id, retention_policy_kind, retention_policy_digest,
  detail_retention_milliseconds, prepared_at
ON tf_artifact_recovery_once
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_identity_immutable');
END;

CREATE TRIGGER tf_artifact_recovery_execution_handoff_insert_guard
BEFORE INSERT ON tf_artifact_recovery_execution_handoffs
WHEN NOT EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_once AS recovery
  JOIN tf_artifact_recovery_candidates AS detail
    ON detail.request_digest = recovery.request_digest
  JOIN tf_artifact_gc_candidates AS candidate
    ON candidate.kind = detail.kind AND candidate.digest = detail.digest
  WHERE recovery.singleton = 1
    AND recovery.request_digest = NEW.request_digest
    AND recovery.phase IN ('prepared', 'settling')
    AND recovery.detail_state = 'active'
    AND recovery.active_worker_version_id = NEW.predecessor_worker_version_id
    AND recovery.execution_handoff_count = NEW.sequence - 1
    AND NEW.successor_worker_version_id <> recovery.preparing_worker_version_id
    AND NOT EXISTS (
      SELECT 1 FROM tf_artifact_recovery_execution_handoffs AS existing
      WHERE existing.request_digest = NEW.request_digest AND (
        existing.predecessor_worker_version_id = NEW.successor_worker_version_id OR
        existing.successor_worker_version_id = NEW.successor_worker_version_id
      )
    )
    AND detail.ordinal = NEW.candidate_ordinal AND detail.kind = 'blob'
    AND candidate.fence = NEW.candidate_fence
    AND NEW.activated_at >= recovery.prepared_at
    AND (
      (NEW.resolution_kind = 'confirm-head-absent'
        AND detail.state = 'delete_started'
        AND candidate.state = 'deleting'
        AND detail.execution_worker_version_id = NEW.predecessor_worker_version_id) OR
      (NEW.resolution_kind = 'reviewed-retry' AND (
        (detail.state = 'delete_started'
          AND candidate.state = 'deleting'
          AND detail.execution_worker_version_id = NEW.predecessor_worker_version_id) OR
        (detail.state = 'pending' AND candidate.state IN ('pending', 'retry'))
      ))
    )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_execution_handoff_not_exact');
END;

CREATE TRIGGER tf_artifact_recovery_once_execution_handoff_transition
BEFORE UPDATE OF active_worker_version_id, execution_handoff_count
ON tf_artifact_recovery_once
WHEN NOT (
  OLD.phase IN ('prepared', 'settling')
  AND NEW.phase = OLD.phase
  AND NEW.detail_state = OLD.detail_state
  AND NEW.active_worker_version_id <> OLD.active_worker_version_id
  AND NEW.execution_handoff_count = OLD.execution_handoff_count + 1
  AND EXISTS (
    SELECT 1 FROM tf_artifact_recovery_execution_handoffs AS handoff
    WHERE handoff.request_digest = OLD.request_digest
      AND handoff.sequence = NEW.execution_handoff_count
      AND handoff.predecessor_worker_version_id = OLD.active_worker_version_id
      AND handoff.successor_worker_version_id = NEW.active_worker_version_id
  )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_execution_handoff_invalid');
END;

CREATE TRIGGER tf_artifact_recovery_execution_handoff_identity_immutable
BEFORE UPDATE OF
  request_digest, sequence, candidate_ordinal, candidate_fence,
  predecessor_worker_version_id, successor_worker_version_id,
  resolution_kind, observed_etag, reviewed_operation_id,
  reviewed_candidate_fence, review_evidence_digest,
  quiescence_evidence_digest, activated_at, handoff_digest
ON tf_artifact_recovery_execution_handoffs
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_execution_handoff_immutable');
END;

CREATE TRIGGER tf_artifact_recovery_execution_handoff_retention_transition
BEFORE UPDATE OF purge_after ON tf_artifact_recovery_execution_handoffs
WHEN NOT (
  OLD.purge_after IS NULL
  AND NEW.purge_after IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM tf_artifact_recovery_once AS recovery
    WHERE recovery.request_digest = OLD.request_digest
      AND recovery.phase = 'complete'
      AND NEW.purge_after = recovery.purge_after
  )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_execution_handoff_retention_invalid');
END;

CREATE TRIGGER tf_artifact_recovery_once_phase_transition
BEFORE UPDATE OF phase, completed_at, result_set_digest, purge_after
ON tf_artifact_recovery_once
WHEN NOT (
  (OLD.phase = 'prepared' AND NEW.phase = 'settling'
    AND NEW.completed_at IS NULL AND NEW.result_set_digest IS NULL
    AND NEW.purge_after IS NULL) OR
  (OLD.phase IN ('prepared', 'settling') AND NEW.phase = 'complete'
    AND NEW.completed_at IS NOT NULL AND NEW.completed_at >= OLD.prepared_at
    AND length(NEW.result_set_digest) = 71
    AND NEW.purge_after = NEW.completed_at + OLD.detail_retention_milliseconds) OR
  (OLD.phase IN ('prepared', 'settling') AND NEW.phase = 'revoked'
    AND NEW.completed_at IS NULL AND NEW.result_set_digest IS NULL
    AND NEW.purge_after IS NULL)
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_phase_transition_invalid');
END;

CREATE TRIGGER tf_artifact_recovery_once_detail_transition
BEFORE UPDATE OF
  detail_state, purge_worker_version_id, purge_authorization_digest,
  purge_authorized_at, details_purged_at
ON tf_artifact_recovery_once
WHEN NOT (
  (OLD.phase = 'complete' AND NEW.phase = 'complete'
    AND OLD.detail_state = 'active' AND NEW.detail_state = 'purging'
    AND NEW.purge_worker_version_id = OLD.active_worker_version_id
    AND length(NEW.purge_authorization_digest) = 71
    AND NEW.purge_authorized_at IS NOT NULL
    AND NEW.purge_authorized_at >= OLD.purge_after
    AND NEW.details_purged_at IS NULL) OR
  (OLD.phase = 'complete' AND NEW.phase = 'complete'
    AND OLD.detail_state = 'purging' AND NEW.detail_state = 'purged'
    AND NEW.purge_worker_version_id = OLD.purge_worker_version_id
    AND NEW.purge_authorization_digest = OLD.purge_authorization_digest
    AND NEW.purge_authorized_at = OLD.purge_authorized_at
    AND NEW.details_purged_at IS NOT NULL
    AND NEW.details_purged_at >= OLD.purge_after
    AND NEW.details_purged_at >= OLD.purge_authorized_at)
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_detail_transition_invalid');
END;

CREATE TRIGGER tf_artifact_recovery_once_durable_delete
BEFORE DELETE ON tf_artifact_recovery_once
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_once_durable');
END;

CREATE TABLE tf_artifact_recovery_details (
  request_digest TEXT PRIMARY KEY NOT NULL,
  request_json TEXT NOT NULL,
  prepared_worker_version_id TEXT NOT NULL,
  purge_after INTEGER,
  CHECK (
    length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:' AND
    substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (json_valid(request_json) AND length(request_json) BETWEEN 2 AND 131072),
  CHECK (length(prepared_worker_version_id) = 36),
  CHECK (purge_after IS NULL OR purge_after >= 0)
);

CREATE TABLE tf_artifact_recovery_candidates (
  request_digest TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  prepared_etag TEXT,
  active_etag TEXT,
  state TEXT NOT NULL,
  reviewed_operation_id TEXT,
  reviewed_candidate_fence INTEGER,
  review_evidence_digest TEXT,
  quiescence_evidence_digest TEXT,
  delete_operation_id TEXT,
  delete_lease_fence INTEGER,
  execution_worker_version_id TEXT,
  result_digest TEXT,
  completed_at INTEGER,
  purge_after INTEGER,
  PRIMARY KEY (request_digest, ordinal),
  UNIQUE (request_digest, kind, digest),
  CHECK (
    length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:' AND
    substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (ordinal BETWEEN 0 AND 28),
  CHECK ((ordinal < 28 AND kind = 'blob') OR (ordinal = 28 AND kind = 'manifest')),
  CHECK (
    length(digest) = 71 AND substr(digest, 1, 7) = 'sha256:' AND
    substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK ((kind = 'blob' AND length(prepared_etag) BETWEEN 1 AND 512
      AND length(active_etag) BETWEEN 1 AND 512)
    OR (kind = 'manifest' AND prepared_etag IS NULL AND active_etag IS NULL)),
  CHECK (
    (reviewed_operation_id IS NULL AND reviewed_candidate_fence IS NULL
      AND review_evidence_digest IS NULL) OR
    (kind = 'blob' AND length(reviewed_operation_id) BETWEEN 3 AND 128
      AND reviewed_candidate_fence IS NOT NULL AND reviewed_candidate_fence >= 2
      AND length(review_evidence_digest) = 71
      AND substr(review_evidence_digest, 1, 7) = 'sha256:'
      AND substr(review_evidence_digest, 8) NOT GLOB '*[^0-9a-f]*')
  ),
  CHECK (quiescence_evidence_digest IS NULL OR (
    length(quiescence_evidence_digest) = 71 AND
    substr(quiescence_evidence_digest, 1, 7) = 'sha256:' AND
    substr(quiescence_evidence_digest, 8) NOT GLOB '*[^0-9a-f]*'
  )),
  CHECK (state IN ('pending', 'delete_started', 'deleted', 'metadata_deleted')),
  CHECK (
    (state = 'pending'
      AND delete_operation_id IS NULL AND delete_lease_fence IS NULL
      AND execution_worker_version_id IS NULL
      AND result_digest IS NULL AND completed_at IS NULL) OR
    (state = 'delete_started' AND kind = 'blob'
      AND length(delete_operation_id) BETWEEN 3 AND 128
      AND delete_lease_fence IS NOT NULL AND delete_lease_fence >= 1
      AND length(execution_worker_version_id) = 36
      AND result_digest IS NULL AND completed_at IS NULL) OR
    (state = 'deleted' AND kind = 'blob'
      AND length(delete_operation_id) BETWEEN 3 AND 128
      AND delete_lease_fence IS NOT NULL AND delete_lease_fence >= 1
      AND length(execution_worker_version_id) = 36
      AND length(result_digest) = 71 AND completed_at IS NOT NULL) OR
    (state = 'metadata_deleted' AND kind = 'manifest'
      AND delete_operation_id IS NULL AND delete_lease_fence IS NULL
      AND execution_worker_version_id IS NULL
      AND length(result_digest) = 71 AND completed_at IS NOT NULL)
  ),
  CHECK (purge_after IS NULL OR purge_after >= 0)
);

CREATE INDEX tf_artifact_recovery_candidates_state
  ON tf_artifact_recovery_candidates (request_digest, state, ordinal);

CREATE TRIGGER tf_artifact_recovery_detail_identity_immutable
BEFORE UPDATE OF request_digest, request_json, prepared_worker_version_id
ON tf_artifact_recovery_details
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_detail_identity_immutable');
END;

CREATE TRIGGER tf_artifact_recovery_candidate_identity_immutable
BEFORE UPDATE OF request_digest, ordinal, kind, digest, prepared_etag
ON tf_artifact_recovery_candidates
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_candidate_identity_immutable');
END;

CREATE TRIGGER tf_artifact_recovery_detail_delete_guard
BEFORE DELETE ON tf_artifact_recovery_details
WHEN NOT EXISTS (
  SELECT 1 FROM tf_artifact_recovery_once AS recovery
  WHERE recovery.request_digest = OLD.request_digest
    AND recovery.phase = 'complete' AND recovery.detail_state = 'purging'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_detail_durable');
END;

CREATE TRIGGER tf_artifact_recovery_candidate_delete_guard
BEFORE DELETE ON tf_artifact_recovery_candidates
WHEN NOT EXISTS (
  SELECT 1 FROM tf_artifact_recovery_once AS recovery
  WHERE recovery.request_digest = OLD.request_digest
    AND recovery.phase = 'complete' AND recovery.detail_state = 'purging'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_candidate_durable');
END;

CREATE TRIGGER tf_artifact_recovery_execution_handoff_delete_guard
BEFORE DELETE ON tf_artifact_recovery_execution_handoffs
WHEN NOT EXISTS (
  SELECT 1 FROM tf_artifact_recovery_once AS recovery
  WHERE recovery.request_digest = OLD.request_digest
    AND recovery.phase = 'complete' AND recovery.detail_state = 'purging'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_execution_handoff_durable');
END;

CREATE TRIGGER tf_artifact_recovery_blob_io_result_insert_guard
BEFORE INSERT ON tf_artifact_blob_io_results
WHEN NEW.receipt_kind = 'exact_failed_run_recovery' AND NOT EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_once AS recovery
  JOIN tf_artifact_recovery_candidates AS detail
    ON detail.request_digest = recovery.request_digest
  JOIN tf_artifact_gc_candidates AS candidate
    ON candidate.kind = detail.kind AND candidate.digest = detail.digest
  WHERE recovery.request_digest = NEW.recovery_request_digest
    AND recovery.phase IN ('prepared', 'settling')
    AND detail.kind = 'blob' AND detail.digest = NEW.digest
    AND detail.state = 'delete_started'
    AND detail.delete_operation_id = NEW.operation_id
    AND detail.delete_lease_fence = NEW.lease_fence
    AND candidate.state = 'deleting'
    AND candidate.fence = NEW.candidate_fence
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_blob_io_result_not_exact');
END;

CREATE TRIGGER tf_artifact_blob_io_result_durable_delete
BEFORE DELETE ON tf_artifact_blob_io_results
WHEN OLD.receipt_kind <> 'exact_failed_run_recovery' OR NOT EXISTS (
  SELECT 1 FROM tf_artifact_recovery_once AS recovery
  WHERE recovery.request_digest = OLD.recovery_request_digest
    AND recovery.phase = 'complete' AND recovery.detail_state = 'purging'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_blob_io_result_durable');
END;

CREATE TRIGGER tf_artifact_recovery_gc_candidate_delete_guard
BEFORE DELETE ON tf_artifact_gc_candidates
WHEN EXISTS (
  SELECT 1 FROM tf_artifact_recovery_candidates AS detail
  WHERE detail.kind = OLD.kind AND detail.digest = OLD.digest
) AND NOT EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_candidates AS detail
  JOIN tf_artifact_recovery_once AS recovery
    ON recovery.request_digest = detail.request_digest
  WHERE detail.kind = OLD.kind AND detail.digest = OLD.digest
    AND recovery.phase = 'complete' AND recovery.detail_state = 'purging'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_gc_candidate_durable');
END;

-- The normal collector and the recovery coordinator can both see the shared
-- candidate rows. Only a guard produced by the exact coordinator for this
-- durable request may mutate one while recovery is active. This is the
-- reciprocal database fence; a read-time filter would leave a TOCTOU window.
CREATE TRIGGER tf_artifact_recovery_gc_candidate_update_guard
BEFORE UPDATE ON tf_artifact_gc_candidates
WHEN EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_candidates AS detail
  JOIN tf_artifact_recovery_once AS recovery
    ON recovery.request_digest = detail.request_digest
  WHERE detail.kind = OLD.kind AND detail.digest = OLD.digest
    AND recovery.phase IN ('prepared', 'settling')
) AND NOT EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_candidates AS detail
  JOIN tf_artifact_recovery_once AS recovery
    ON recovery.request_digest = detail.request_digest
  JOIN tf_artifact_gc_guards AS guard
    ON guard.authority_kind = 'exact_failed_run_recovery'
   AND guard.recovery_request_digest = recovery.request_digest
   AND guard.valid = 1
  WHERE detail.kind = OLD.kind AND detail.digest = OLD.digest
    AND recovery.phase IN ('prepared', 'settling')
)
BEGIN
  SELECT RAISE(ABORT, 'constraint: artifact_recovery_gc_candidate_reserved');
END;

CREATE TRIGGER tf_artifact_owner_closure_receipt_exact_insert
BEFORE INSERT ON tf_artifact_owner_closure_receipts
WHEN NOT EXISTS (
  SELECT 1
  FROM tf_artifact_uploads AS upload
  JOIN tf_artifact_roots AS root
    ON root.tenant_id = upload.tenant_id
   AND root.root_kind = 'upload' AND root.root_id = upload.id
   AND root.target_kind = 'manifest' AND root.digest = upload.manifest_digest
  WHERE upload.id = NEW.upload_id AND upload.tenant_id = NEW.tenant_id
    AND upload.principal_id = NEW.principal_id
    AND upload.manifest_digest = NEW.manifest_digest
    AND upload.lifecycle_state = 'committed'
    AND upload.lifecycle_fence = NEW.upload_fence
    AND root.state = 'active' AND root.fence = NEW.root_fence
) OR (
  NEW.receipt_kind = 'exact_failed_run_recovery' AND NOT EXISTS (
    SELECT 1 FROM tf_artifact_recovery_once AS recovery
    WHERE recovery.request_digest = NEW.recovery_request_digest
      AND recovery.tenant_id = NEW.tenant_id
      AND recovery.manifest_digest = NEW.manifest_digest
      AND recovery.phase IN ('prepared', 'settling')
  )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_owner_closure_receipt_not_exact');
END;

CREATE TRIGGER tf_artifact_owner_closure_receipt_immutable_update
BEFORE UPDATE ON tf_artifact_owner_closure_receipts
WHEN NOT (
  OLD.receipt_kind = 'run_owner_closure'
  AND NEW.receipt_kind = OLD.receipt_kind
  AND OLD.state = 'closed' AND NEW.state = 'revoked'
  AND NEW.receipt_id = OLD.receipt_id
  AND NEW.receipt_fence = OLD.receipt_fence
  AND NEW.tenant_id = OLD.tenant_id
  AND NEW.principal_id = OLD.principal_id
  AND NEW.upload_id = OLD.upload_id
  AND NEW.manifest_digest = OLD.manifest_digest
  AND NEW.upload_fence = OLD.upload_fence
  AND NEW.root_fence = OLD.root_fence
  AND NEW.recovery_request_digest IS OLD.recovery_request_digest
  AND NEW.closed_at = OLD.closed_at AND NEW.expires_at = OLD.expires_at
  AND NEW.purge_after IS OLD.purge_after
  AND NEW.created_at = OLD.created_at AND NEW.updated_at >= OLD.updated_at
) AND NOT (
  OLD.receipt_kind = 'exact_failed_run_recovery'
  AND NEW.receipt_kind = OLD.receipt_kind
  AND OLD.state = 'recovery_active' AND NEW.state = 'recovery_complete'
  AND NEW.receipt_id = OLD.receipt_id
  AND NEW.receipt_fence = OLD.receipt_fence
  AND NEW.tenant_id = OLD.tenant_id
  AND NEW.principal_id = OLD.principal_id
  AND NEW.upload_id = OLD.upload_id
  AND NEW.manifest_digest = OLD.manifest_digest
  AND NEW.upload_fence = OLD.upload_fence
  AND NEW.root_fence = OLD.root_fence
  AND NEW.recovery_request_digest = OLD.recovery_request_digest
  AND NEW.closed_at = OLD.closed_at AND NEW.expires_at = OLD.expires_at
  AND NEW.created_at = OLD.created_at AND NEW.updated_at >= OLD.updated_at
  AND EXISTS (
    SELECT 1 FROM tf_artifact_recovery_once AS recovery
    WHERE recovery.request_digest = OLD.recovery_request_digest
      AND recovery.phase = 'complete'
      AND NEW.purge_after = recovery.purge_after
  )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_owner_closure_receipt_immutable');
END;

CREATE TRIGGER tf_artifact_owner_closure_receipt_durable_delete
BEFORE DELETE ON tf_artifact_owner_closure_receipts
WHEN OLD.receipt_kind <> 'exact_failed_run_recovery' OR NOT EXISTS (
  SELECT 1 FROM tf_artifact_recovery_once AS recovery
  WHERE recovery.request_digest = OLD.recovery_request_digest
    AND recovery.phase = 'complete' AND recovery.detail_state = 'purging'
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_owner_closure_receipt_durable');
END;

-- Once recovery is active, a tenant uncertainty cannot appear or reactivate.
-- Conversely, an uncertainty that won the race prevents prepare/delete-start.
CREATE TRIGGER tf_artifact_recovery_uncertainty_insert_guard
BEFORE INSERT ON tf_artifact_consumer_uncertainties
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1 FROM tf_artifact_recovery_once AS recovery
  WHERE recovery.tenant_id = NEW.tenant_id
    AND recovery.phase IN ('prepared', 'settling')
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_active');
END;

CREATE TRIGGER tf_artifact_recovery_uncertainty_update_guard
BEFORE UPDATE OF tenant_id, state ON tf_artifact_consumer_uncertainties
WHEN NEW.state = 'active'
  AND (OLD.state <> 'active' OR OLD.tenant_id <> NEW.tenant_id)
  AND EXISTS (
    SELECT 1 FROM tf_artifact_recovery_once AS recovery
    WHERE recovery.tenant_id = NEW.tenant_id
      AND recovery.phase IN ('prepared', 'settling')
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_active');
END;

CREATE TRIGGER tf_artifact_recovery_candidate_delete_start_guard
BEFORE UPDATE OF state ON tf_artifact_gc_candidates
WHEN NEW.state = 'deleting' AND OLD.state <> 'deleting'
  AND EXISTS (
    SELECT 1
    FROM tf_artifact_recovery_candidates AS detail
    JOIN tf_artifact_recovery_once AS recovery
      ON recovery.request_digest = detail.request_digest
    WHERE detail.kind = NEW.kind AND detail.digest = NEW.digest
      AND recovery.phase IN ('prepared', 'settling')
  )
  AND EXISTS (
    SELECT 1
    FROM tf_artifact_recovery_candidates AS detail
    JOIN tf_artifact_recovery_once AS recovery
      ON recovery.request_digest = detail.request_digest
    JOIN tf_artifact_consumer_uncertainties AS uncertainty
      ON uncertainty.tenant_id = recovery.tenant_id AND uncertainty.state = 'active'
    WHERE detail.kind = NEW.kind AND detail.digest = NEW.digest
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_consumer_uncertainty');
END;

CREATE TRIGGER tf_artifact_recovery_delete_started_guard
BEFORE UPDATE OF last_outcome ON tf_artifact_blob_io_leases
WHEN NEW.last_outcome = 'delete_started' AND OLD.last_outcome <> 'delete_started'
  AND EXISTS (
    SELECT 1
    FROM tf_artifact_recovery_candidates AS detail
    JOIN tf_artifact_recovery_once AS recovery
      ON recovery.request_digest = detail.request_digest
    JOIN tf_artifact_consumer_uncertainties AS uncertainty
      ON uncertainty.tenant_id = recovery.tenant_id AND uncertainty.state = 'active'
    WHERE detail.kind = 'blob' AND detail.digest = NEW.digest
      AND recovery.phase IN ('prepared', 'settling')
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_consumer_uncertainty');
END;

CREATE TRIGGER tf_artifact_recovery_delete_started_insert_guard
BEFORE INSERT ON tf_artifact_blob_io_leases
WHEN NEW.last_outcome = 'delete_started'
  AND EXISTS (
    SELECT 1
    FROM tf_artifact_recovery_candidates AS detail
    JOIN tf_artifact_recovery_once AS recovery
      ON recovery.request_digest = detail.request_digest
    JOIN tf_artifact_consumer_uncertainties AS uncertainty
      ON uncertainty.tenant_id = recovery.tenant_id AND uncertainty.state = 'active'
    WHERE detail.kind = 'blob' AND detail.digest = NEW.digest
      AND recovery.phase IN ('prepared', 'settling')
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_consumer_uncertainty');
END;

-- The inverse edges below close the pending/quarantine interval left open by
-- the generic delete fence. They cover new consumers, holds and blob writers
-- before the candidate reaches `deleting`.
CREATE TRIGGER tf_artifact_recovery_active_root_insert_guard
BEFORE INSERT ON tf_artifact_roots
WHEN NEW.state = 'active' AND EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_once AS recovery
  JOIN tf_artifact_recovery_candidates AS detail
    ON detail.request_digest = recovery.request_digest
  WHERE recovery.phase IN ('prepared', 'settling') AND (
    (NEW.target_kind = detail.kind AND NEW.digest = detail.digest) OR
    (NEW.target_kind = 'manifest' AND (
      NEW.digest = recovery.manifest_digest OR EXISTS (
        SELECT 1 FROM tf_artifact_manifest_members AS member
        WHERE member.manifest_digest = NEW.digest
          AND member.blob_digest = detail.digest
      )
    ))
  )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_active');
END;

CREATE TRIGGER tf_artifact_recovery_active_root_update_guard
BEFORE UPDATE OF state, target_kind, digest ON tf_artifact_roots
WHEN NEW.state = 'active'
  AND (OLD.state <> 'active' OR OLD.target_kind <> NEW.target_kind OR OLD.digest <> NEW.digest)
  AND EXISTS (
    SELECT 1
    FROM tf_artifact_recovery_once AS recovery
    JOIN tf_artifact_recovery_candidates AS detail
      ON detail.request_digest = recovery.request_digest
    WHERE recovery.phase IN ('prepared', 'settling') AND (
      (NEW.target_kind = detail.kind AND NEW.digest = detail.digest) OR
      (NEW.target_kind = 'manifest' AND (
        NEW.digest = recovery.manifest_digest OR EXISTS (
          SELECT 1 FROM tf_artifact_manifest_members AS member
          WHERE member.manifest_digest = NEW.digest
            AND member.blob_digest = detail.digest
        )
      ))
    )
  )
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_active');
END;

CREATE TRIGGER tf_artifact_recovery_member_insert_guard
BEFORE INSERT ON tf_artifact_manifest_members
WHEN EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_once AS recovery
  JOIN tf_artifact_recovery_candidates AS detail
    ON detail.request_digest = recovery.request_digest
  WHERE recovery.phase IN ('prepared', 'settling')
    AND detail.kind = 'blob' AND detail.digest = NEW.blob_digest
    AND (
      NEW.manifest_digest = recovery.manifest_digest OR EXISTS (
        SELECT 1 FROM tf_artifact_roots AS root
        WHERE root.state = 'active' AND root.target_kind = 'manifest'
          AND root.digest = NEW.manifest_digest
      )
    )
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_active');
END;

CREATE TRIGGER tf_artifact_recovery_hold_insert_guard
BEFORE INSERT ON tf_artifact_holds
WHEN EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_once AS recovery
  JOIN tf_artifact_recovery_candidates AS detail
    ON detail.request_digest = recovery.request_digest
  WHERE recovery.tenant_id = NEW.tenant_id
    AND recovery.phase IN ('prepared', 'settling')
    AND detail.kind = NEW.kind AND detail.digest = NEW.digest
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_active');
END;

CREATE TRIGGER tf_artifact_recovery_blob_writer_insert_guard
BEFORE INSERT ON tf_artifact_blob_io_leases
WHEN NEW.state = 'writing' AND EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_once AS recovery
  JOIN tf_artifact_recovery_candidates AS detail
    ON detail.request_digest = recovery.request_digest
  WHERE recovery.phase IN ('prepared', 'settling')
    AND detail.kind = 'blob' AND detail.digest = NEW.digest
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_active');
END;

CREATE TRIGGER tf_artifact_recovery_blob_writer_update_guard
BEFORE UPDATE OF state ON tf_artifact_blob_io_leases
WHEN NEW.state = 'writing' AND OLD.state <> 'writing' AND EXISTS (
  SELECT 1
  FROM tf_artifact_recovery_once AS recovery
  JOIN tf_artifact_recovery_candidates AS detail
    ON detail.request_digest = recovery.request_digest
  WHERE recovery.phase IN ('prepared', 'settling')
    AND detail.kind = 'blob' AND detail.digest = NEW.digest
)
BEGIN
  SELECT RAISE(ABORT, 'artifact_recovery_active');
END;
