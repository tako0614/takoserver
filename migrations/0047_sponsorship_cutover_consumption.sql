CREATE TABLE sponsorship_credential_issuance_operations (
  issuance_operation_id TEXT PRIMARY KEY NOT NULL
    CHECK (
      length(issuance_operation_id) = 71 AND
      substr(issuance_operation_id, 1, 7) = 'sha256:' AND
      substr(issuance_operation_id, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  input_sha256 TEXT UNIQUE NOT NULL
    CHECK (
      length(input_sha256) = 71 AND
      substr(input_sha256, 1, 7) = 'sha256:' AND
      substr(input_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  request_sha256 TEXT NOT NULL
    CHECK (
      length(request_sha256) = 71 AND
      substr(request_sha256, 1, 7) = 'sha256:' AND
      substr(request_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  request_nonce_sha256 TEXT NOT NULL
    CHECK (
      length(request_nonce_sha256) = 71 AND
      substr(request_nonce_sha256, 1, 7) = 'sha256:' AND
      substr(request_nonce_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  tenant_ref TEXT NOT NULL CHECK (length(tenant_ref) BETWEEN 3 AND 256),
  org_id TEXT NOT NULL CHECK (length(org_id) BETWEEN 3 AND 256),
  hosted_version_id TEXT NOT NULL
    CHECK (
      length(hosted_version_id) = 36 AND
      substr(hosted_version_id, 9, 1) = '-' AND
      substr(hosted_version_id, 14, 1) = '-' AND
      substr(hosted_version_id, 19, 1) = '-' AND
      substr(hosted_version_id, 24, 1) = '-'
    ),
  issued_at_epoch_seconds INTEGER NOT NULL
    CHECK (issued_at_epoch_seconds >= 0),
  expires_at_epoch_seconds INTEGER NOT NULL
    CHECK (
      expires_at_epoch_seconds > issued_at_epoch_seconds AND
      expires_at_epoch_seconds - issued_at_epoch_seconds <= 300
    ),
  token_id TEXT UNIQUE NOT NULL CHECK (length(token_id) BETWEEN 3 AND 255),
  credential_key_id TEXT NOT NULL CHECK (length(credential_key_id) BETWEEN 3 AND 128),
  receipt_key_id TEXT NOT NULL CHECK (length(receipt_key_id) BETWEEN 3 AND 128),
  authority_version_id TEXT NOT NULL
    CHECK (
      length(authority_version_id) = 36 AND
      substr(authority_version_id, 9, 1) = '-' AND
      substr(authority_version_id, 14, 1) = '-' AND
      substr(authority_version_id, 19, 1) = '-' AND
      substr(authority_version_id, 24, 1) = '-'
    ),
  authority_source_commit TEXT NOT NULL
    CHECK (
      length(authority_source_commit) = 40 AND
      authority_source_commit NOT GLOB '*[^0-9a-f]*'
    ),
  authority_artifact_sha256 TEXT NOT NULL
    CHECK (
      length(authority_artifact_sha256) = 71 AND
      substr(authority_artifact_sha256, 1, 7) = 'sha256:' AND
      substr(authority_artifact_sha256, 8) NOT GLOB '*[^0-9a-f]*'
    ),
  created_at TEXT NOT NULL CHECK (length(created_at) = 24)
);

CREATE TRIGGER sponsorship_credential_issuance_bind_tenant
AFTER INSERT ON sponsorship_credential_issuance_operations BEGIN
  INSERT INTO sponsorship_tenants (tenant_ref, org_id, created_at)
  VALUES (NEW.tenant_ref, NEW.org_id, NEW.created_at)
  ON CONFLICT(tenant_ref) DO UPDATE SET org_id = excluded.org_id
  WHERE sponsorship_tenants.org_id = excluded.org_id;
  SELECT CASE
    WHEN NOT EXISTS (
      SELECT 1 FROM sponsorship_tenants
      WHERE tenant_ref = NEW.tenant_ref AND org_id = NEW.org_id
    )
    THEN RAISE(ABORT, 'sponsorship tenant binding conflict')
  END;
END;

CREATE TRIGGER sponsorship_credential_issuance_operations_no_update
BEFORE UPDATE ON sponsorship_credential_issuance_operations BEGIN
  SELECT RAISE(ABORT, 'sponsorship credential issuance operations are append-only');
END;

CREATE TRIGGER sponsorship_credential_issuance_operations_no_delete
BEFORE DELETE ON sponsorship_credential_issuance_operations BEGIN
  SELECT RAISE(ABORT, 'sponsorship credential issuance operations are append-only');
END;

CREATE TABLE sponsorship_cutover_operation_starts (
  operation_id TEXT PRIMARY KEY NOT NULL,
  target_sha256 TEXT NOT NULL,
  environment TEXT NOT NULL CHECK (environment IN ('integration', 'production')),
  stage TEXT NOT NULL CHECK (stage IN ('public-route-removal', 'legacy-secret-retirement')),
  proof_sha256 TEXT NOT NULL,
  predecessor_deployment_id TEXT NOT NULL,
  predecessor_version_id TEXT NOT NULL,
  predecessor_topology_sha256 TEXT NOT NULL,
  source_commit TEXT NOT NULL,
  bundle_sha256 TEXT NOT NULL,
  config_sha256 TEXT NOT NULL,
  candidate_identity_sha256 TEXT NOT NULL,
  started_at TEXT NOT NULL,
  UNIQUE (target_sha256, environment, stage, proof_sha256)
);

CREATE TABLE sponsorship_cutover_operation_completions (
  operation_id TEXT PRIMARY KEY NOT NULL,
  successor_deployment_id TEXT NOT NULL,
  successor_version_id TEXT NOT NULL,
  completed_at TEXT NOT NULL,
  FOREIGN KEY (operation_id) REFERENCES sponsorship_cutover_operation_starts(operation_id)
);

CREATE TRIGGER sponsorship_cutover_operation_starts_no_update
BEFORE UPDATE ON sponsorship_cutover_operation_starts BEGIN
  SELECT RAISE(ABORT, 'sponsorship cutover starts are append-only');
END;

CREATE TRIGGER sponsorship_cutover_operation_starts_no_delete
BEFORE DELETE ON sponsorship_cutover_operation_starts BEGIN
  SELECT RAISE(ABORT, 'sponsorship cutover starts are append-only');
END;

CREATE TRIGGER sponsorship_cutover_operation_completions_no_update
BEFORE UPDATE ON sponsorship_cutover_operation_completions BEGIN
  SELECT RAISE(ABORT, 'sponsorship cutover completions are append-only');
END;

CREATE TRIGGER sponsorship_cutover_operation_completions_no_delete
BEFORE DELETE ON sponsorship_cutover_operation_completions BEGIN
  SELECT RAISE(ABORT, 'sponsorship cutover completions are append-only');
END;
