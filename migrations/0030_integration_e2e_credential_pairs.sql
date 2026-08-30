-- The integration E2E writer and external-evidence credentials are one
-- authority lifecycle.  The operation row is published before either bearer
-- row can be inserted, so an acknowledgement loss or process death always
-- leaves deterministic recovery coordinates and a monotonic revoke fence.
--
-- Historical single-key rows are deliberately not backfilled.  They do not
-- prove that an evidence key ever existed, so treating them as a completed or
-- absent pair would manufacture lifecycle history.

CREATE TABLE integration_e2e_credential_pair_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  authority_slot TEXT NOT NULL,
  org_id TEXT NOT NULL,
  writer_key_id TEXT NOT NULL,
  evidence_key_id TEXT NOT NULL,
  writer_name TEXT NOT NULL,
  evidence_name TEXT NOT NULL,
  writer_scopes_json TEXT NOT NULL,
  evidence_scopes_json TEXT NOT NULL,
  ttl_seconds INTEGER NOT NULL,
  state TEXT NOT NULL,
  fence INTEGER NOT NULL,
  source_commit TEXT NOT NULL,
  artifact_digest TEXT NOT NULL,
  authority_worker_version_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  revoked_at INTEGER,
  CHECK (length(operation_id) BETWEEN 8 AND 128),
  CHECK (authority_slot = 'integration-e2e-credential-pair'),
  CHECK (org_id = 'org_takosumi_hosted_staging'),
  CHECK (length(writer_key_id) BETWEEN 8 AND 128),
  CHECK (length(evidence_key_id) BETWEEN 8 AND 128),
  CHECK (writer_key_id <> evidence_key_id),
  CHECK (writer_name = 'integration-e2e-writer'),
  CHECK (evidence_name = 'integration-e2e-evidence'),
  CHECK (writer_name <> evidence_name),
  CHECK (writer_scopes_json = '["resources:write"]'),
  CHECK (evidence_scopes_json = '["resources:read"]'),
  CHECK (ttl_seconds = 3600),
  CHECK (state IN ('prepared', 'issuing', 'active', 'partial', 'revoking', 'revoked')),
  CHECK (fence >= 1),
  CHECK (length(source_commit) = 40 AND source_commit NOT GLOB '*[^0-9a-f]*'),
  CHECK (
    length(artifact_digest) = 71 AND
    substr(artifact_digest, 1, 7) = 'sha256:' AND
    substr(artifact_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(authority_worker_version_id) = 36),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at),
  CHECK (revoked_at IS NULL OR revoked_at >= created_at),
  CHECK ((state = 'revoked') = (revoked_at IS NOT NULL))
);

-- Exactly one nonterminal pair may occupy the dedicated integration authority
-- slot.  Revoked tombstones remain forever and do not prevent a fresh pair for
-- the next product E2E run.
CREATE UNIQUE INDEX integration_e2e_credential_pair_live_slot
  ON integration_e2e_credential_pair_operations (authority_slot)
  WHERE state <> 'revoked';

CREATE INDEX integration_e2e_credential_pair_state
  ON integration_e2e_credential_pair_operations (state, updated_at, operation_id);

-- Historical single-key detection uses the fixed organization/name prefix.
-- This index includes old rows without manufacturing operation history.
CREATE INDEX integration_e2e_legacy_live_keys
  ON auth_tokens (org_id, name, id)
  WHERE kind = 'api_key' AND revoked_at IS NULL;
