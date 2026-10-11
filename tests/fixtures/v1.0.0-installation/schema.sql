-- The control database schema exactly as the published Takoserver v1.0.0
-- release (tag v1.0.0, commit c080a898, the Latest GitHub Release of
-- 2026-08-20) creates it: its migrator applies migrations 0001-0015 to an
-- empty control.sqlite on first boot and records them in applied_migrations.
--
-- Generated on 2026-10-11 by running `bun src/entry-bun.ts` from
-- `git archive v1.0.0` against a new TAKOSERVER_DATA_ROOT, stopping it, and
-- taking `sqlite3 control.sqlite .dump`. The CREATE statements below are that
-- dump verbatim; its INSERT rows are split into empty.sql, signed-in.sql and
-- used.sql. Do not edit; regenerate from the tag instead.
CREATE TABLE applied_migrations (
      name TEXT PRIMARY KEY NOT NULL,
      applied_at TEXT NOT NULL
    );
CREATE TABLE runtime_grant_keys (
  key_id TEXT PRIMARY KEY NOT NULL,
  public_jwk TEXT NOT NULL,
  created_at_epoch_seconds INTEGER NOT NULL,
  revoked_at_epoch_seconds INTEGER,
  CHECK (length(key_id) BETWEEN 3 AND 128),
  CHECK (length(public_jwk) BETWEEN 1 AND 4096),
  CHECK (created_at_epoch_seconds >= 0),
  CHECK (revoked_at_epoch_seconds IS NULL OR revoked_at_epoch_seconds >= created_at_epoch_seconds)
);
CREATE TABLE runtime_grant_replays (
  grant_id TEXT PRIMARY KEY NOT NULL,
  expires_at_epoch_seconds INTEGER NOT NULL,
  consumed_at_epoch_seconds INTEGER NOT NULL,
  CHECK (length(grant_id) BETWEEN 3 AND 256),
  CHECK (expires_at_epoch_seconds > consumed_at_epoch_seconds),
  CHECK (consumed_at_epoch_seconds >= 0)
);
CREATE TABLE runtime_resources (
  organization_id TEXT NOT NULL,
  security_domain_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  resource_ref TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  native_id TEXT NOT NULL,
  allowances_json TEXT NOT NULL,
  created_at_epoch_seconds INTEGER NOT NULL,
  PRIMARY KEY (security_domain_id, tenant_ref, resource_ref),
  UNIQUE (backend_id, native_id),
  CHECK (length(organization_id) BETWEEN 3 AND 128),
  CHECK (length(security_domain_id) BETWEEN 3 AND 128),
  CHECK (length(tenant_ref) BETWEEN 3 AND 128),
  CHECK (length(resource_ref) BETWEEN 3 AND 128),
  CHECK (length(reservation_id) BETWEEN 3 AND 128),
  CHECK (length(offering_id) BETWEEN 3 AND 128),
  CHECK (
    substr(offering_digest, 1, 7) = 'sha256:' AND
    length(offering_digest) = 71 AND
    substr(offering_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(backend_id) BETWEEN 3 AND 128),
  CHECK (length(native_id) BETWEEN 3 AND 512),
  CHECK (length(allowances_json) BETWEEN 2 AND 4096),
  CHECK (created_at_epoch_seconds >= 0)
);
CREATE TABLE tf_prepares (
  tenant_id TEXT NOT NULL,
  prepare_digest TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  expected_generation TEXT,
  current_uid TEXT,
  expires_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, prepare_digest),
  CHECK (
    substr(prepare_digest, 1, 7) = 'sha256:' AND
    length(prepare_digest) = 71 AND
    substr(prepare_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(fingerprint) BETWEEN 2 AND 1048576),
  CHECK (expires_at >= 0)
);
CREATE TABLE tf_replays (
  replay_key TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL,
  resource_json TEXT,
  bound_uid TEXT,
  expires_at INTEGER NOT NULL,
  CHECK (length(replay_key) BETWEEN 1 AND 1024),
  CHECK (status BETWEEN 100 AND 599),
  CHECK (resource_json IS NULL OR length(resource_json) BETWEEN 2 AND 1048576),
  CHECK (expires_at >= 0)
);
CREATE TABLE tf_artifact_uploads (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  manifest_json TEXT NOT NULL,
  manifest_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (length(manifest_json) BETWEEN 2 AND 1048576),
  CHECK (
    substr(manifest_digest, 1, 7) = 'sha256:' AND
    length(manifest_digest) = 71 AND
    substr(manifest_digest, 8) NOT GLOB '*[^0-9a-f]*'
  )
);
CREATE TABLE tf_artifact_manifests (
  digest TEXT PRIMARY KEY NOT NULL,
  manifest_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(manifest_json) BETWEEN 2 AND 1048576)
);
CREATE TABLE tf_artifact_holds (
  tenant_id TEXT NOT NULL,
  digest TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (tenant_id, digest, kind),
  CHECK (kind IN ('blob', 'manifest'))
);
CREATE TABLE tf_artifact_replays (
  replay_key TEXT PRIMARY KEY NOT NULL,
  status INTEGER NOT NULL,
  body_json TEXT,
  expires_at INTEGER NOT NULL,
  CHECK (status BETWEEN 100 AND 599),
  CHECK (expires_at >= 0)
);
CREATE TABLE tf_operations (
  id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  state TEXT NOT NULL,
  resource_json TEXT,
  created_at TEXT NOT NULL,
  expires_at INTEGER NOT NULL,
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (state IN ('succeeded', 'failed')),
  CHECK (resource_json IS NULL OR length(resource_json) BETWEEN 2 AND 1048576),
  CHECK (expires_at >= 0)
);
CREATE TABLE ledger (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  type TEXT NOT NULL,
  ref TEXT NOT NULL,
  settled_delta INTEGER NOT NULL,
  held_delta INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (org_id, type, ref),
  CHECK (type IN ('funding', 'hold', 'capture', 'release', 'usage_debit')),
  CHECK (length(org_id) BETWEEN 1 AND 128),
  CHECK (length(ref) BETWEEN 1 AND 256)
);
CREATE TABLE principals (
  id TEXT PRIMARY KEY NOT NULL,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  email TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (provider, provider_subject),
  CHECK (provider IN ('google', 'github'))
);
CREATE TABLE orgs (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL,
  owner_principal_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(name) BETWEEN 1 AND 128)
);
CREATE TABLE auth_tokens (
  secret_digest TEXT PRIMARY KEY NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  org_id TEXT,
  name TEXT NOT NULL,
  scopes_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  CHECK (kind IN ('session', 'api_key')),
  CHECK (length(secret_digest) = 71),
  CHECK (length(scopes_json) BETWEEN 2 AND 1024)
);
CREATE TABLE quotes (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  meter TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (quantity > 0),
  CHECK (amount_minor >= 0),
  CHECK (
    substr(offering_digest, 1, 7) = 'sha256:' AND
    length(offering_digest) = 71 AND
    substr(offering_digest, 8) NOT GLOB '*[^0-9a-f]*'
  )
);
CREATE TABLE reservations (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  meter TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (quote_id),
  CHECK (status IN ('active', 'captured', 'released', 'expired')),
  CHECK (amount_minor >= 0)
);
CREATE TABLE usage_statements (
  reservation_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  quantity REAL NOT NULL,
  amount_minor INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  CHECK (quantity >= 0),
  CHECK (amount_minor >= 0)
);
CREATE TABLE usage_events (
  request_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  meter TEXT NOT NULL,
  quantity REAL NOT NULL,
  amount_minor INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  rollup_id TEXT,
  CHECK (quantity >= 0),
  CHECK (amount_minor >= 0)
);
CREATE TABLE idempotency (
  scope_key TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL,
  body_json TEXT,
  expires_at INTEGER NOT NULL,
  CHECK (status BETWEEN 100 AND 599),
  CHECK (expires_at >= 0)
);
CREATE TABLE tf_resource_deployments (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  provider_pack_ref TEXT NOT NULL,
  provider_installation_ref TEXT NOT NULL,
  native_id TEXT NOT NULL,
  state TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, provider_installation_ref, native_id),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(offering_id) BETWEEN 3 AND 255),
  CHECK (length(provider_pack_ref) BETWEEN 1 AND 255),
  CHECK (length(provider_installation_ref) BETWEEN 1 AND 255),
  CHECK (length(native_id) BETWEEN 1 AND 4096),
  CHECK (state IN (
    'provisioning', 'candidate', 'active', 'draining', 'retained', 'failed', 'deleted'
  )),
  CHECK (length(observed_json) BETWEEN 2 AND 1048576),
  CHECK (length(outputs_json) BETWEEN 2 AND 1048576),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
);
CREATE TABLE tf_resource_attachments (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  consumer_resource_uid TEXT NOT NULL,
  provider_resource_uid TEXT NOT NULL,
  interface_ref_json TEXT NOT NULL,
  target TEXT NOT NULL,
  permissions_json TEXT NOT NULL,
  state TEXT NOT NULL,
  provider_deployment_id TEXT NOT NULL,
  consumer_deployment_id TEXT NOT NULL,
  resolution_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (length(consumer_resource_uid) BETWEEN 3 AND 128),
  CHECK (length(provider_resource_uid) BETWEEN 3 AND 128),
  CHECK (consumer_resource_uid <> provider_resource_uid),
  CHECK (length(interface_ref_json) BETWEEN 2 AND 4096),
  CHECK (length(target) BETWEEN 1 AND 255),
  CHECK (length(permissions_json) BETWEEN 2 AND 4096),
  CHECK (state IN ('active', 'stale', 'deleted')),
  CHECK (length(provider_deployment_id) BETWEEN 3 AND 128),
  CHECK (length(consumer_deployment_id) BETWEEN 3 AND 128),
  CHECK (length(resolution_json) BETWEEN 2 AND 4096),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
);
CREATE TABLE IF NOT EXISTS "tf_resources" (
  tenant_id TEXT NOT NULL,
  space TEXT NOT NULL,
  api_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  uid TEXT NOT NULL,
  generation TEXT NOT NULL,
  revision TEXT NOT NULL,
  resource_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL, relations_json TEXT NOT NULL DEFAULT '[]'
  CHECK (
    json_valid(relations_json) AND
    json_type(relations_json) = 'array' AND
    length(relations_json) BETWEEN 2 AND 1048576
  ),
  PRIMARY KEY (tenant_id, space, api_version, kind, name),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(space) BETWEEN 1 AND 255),
  CHECK (length(uid) BETWEEN 3 AND 128),
  CHECK (length(resource_json) BETWEEN 2 AND 1048576),
  CHECK (updated_at >= 0)
);
CREATE TABLE tf_resource_migrations (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  source_deployment_id TEXT NOT NULL,
  target_deployment_id TEXT NOT NULL,
  target_offering_id TEXT NOT NULL,
  target_provider_pack_ref TEXT NOT NULL,
  target_provider_installation_ref TEXT NOT NULL,
  commercial_authorization_ref TEXT NOT NULL,
  mode TEXT NOT NULL,
  transfer_format TEXT NOT NULL,
  state TEXT NOT NULL,
  verification_json TEXT,
  rollback_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL, attachment_rebindings_json TEXT
  CHECK (
    attachment_rebindings_json IS NULL OR
    length(attachment_rebindings_json) BETWEEN 2 AND 262144
  ), commercial_tenant_ref TEXT
  CHECK (
    commercial_tenant_ref IS NULL OR
    length(commercial_tenant_ref) BETWEEN 3 AND 128
  ),
  PRIMARY KEY (tenant_id, id),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(source_deployment_id) BETWEEN 3 AND 128),
  CHECK (length(target_deployment_id) BETWEEN 3 AND 128),
  CHECK (length(target_offering_id) BETWEEN 3 AND 255),
  CHECK (length(target_provider_pack_ref) BETWEEN 1 AND 255),
  CHECK (length(target_provider_installation_ref) BETWEEN 1 AND 255),
  CHECK (length(commercial_authorization_ref) BETWEEN 3 AND 255),
  CHECK (mode IN ('offline', 'online')),
  CHECK (length(transfer_format) BETWEEN 3 AND 255),
  CHECK (state IN (
    'planned', 'provisioning', 'transferring', 'verified',
    'completed', 'rolled_back', 'failed'
  )),
  CHECK (verification_json IS NULL OR length(verification_json) BETWEEN 2 AND 65536),
  CHECK (rollback_until IS NULL OR rollback_until >= created_at),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
);
CREATE TABLE provision_token_consumptions (
  token_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  reservation_id TEXT NOT NULL UNIQUE,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  expires_at_epoch_seconds INTEGER NOT NULL,
  consumed_at_epoch_seconds INTEGER NOT NULL,
  CHECK (length(token_id) BETWEEN 3 AND 256),
  CHECK (length(organization_id) BETWEEN 3 AND 256),
  CHECK (length(tenant_ref) BETWEEN 3 AND 256),
  CHECK (length(reservation_id) BETWEEN 3 AND 256),
  CHECK (length(offering_id) BETWEEN 3 AND 256),
  CHECK (
    substr(offering_digest, 1, 7) = 'sha256:' AND
    length(offering_digest) = 71 AND
    substr(offering_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (expires_at_epoch_seconds > consumed_at_epoch_seconds),
  CHECK (consumed_at_epoch_seconds >= 0)
);
CREATE TABLE provider_meter_checkpoints (
  tenant_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  meter_source_id TEXT NOT NULL,
  cursor_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, deployment_id, meter_source_id),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(deployment_id) BETWEEN 3 AND 128),
  CHECK (length(meter_source_id) BETWEEN 1 AND 255),
  CHECK (cursor_at >= 0),
  CHECK (updated_at >= 0)
);
CREATE TABLE provider_meter_schedule (
  tenant_id TEXT NOT NULL,
  deployment_id TEXT NOT NULL,
  next_at INTEGER NOT NULL,
  lease_until INTEGER NOT NULL,
  lease_token TEXT,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, deployment_id),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(deployment_id) BETWEEN 3 AND 128),
  CHECK (next_at >= 0),
  CHECK (lease_until >= 0),
  CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 8 AND 128),
  CHECK (updated_at >= 0)
);
CREATE INDEX runtime_grant_keys_active
  ON runtime_grant_keys (key_id)
  WHERE revoked_at_epoch_seconds IS NULL;
CREATE INDEX runtime_grant_replays_expiry
  ON runtime_grant_replays (expires_at_epoch_seconds, grant_id);
CREATE INDEX runtime_resources_reservation
  ON runtime_resources (reservation_id, offering_id);
CREATE INDEX tf_prepares_expiry ON tf_prepares (expires_at);
CREATE INDEX tf_replays_expiry ON tf_replays (expires_at);
CREATE INDEX tf_artifact_uploads_owner ON tf_artifact_uploads (tenant_id, principal_id);
CREATE INDEX tf_artifact_replays_expiry ON tf_artifact_replays (expires_at);
CREATE INDEX tf_operations_tenant ON tf_operations (tenant_id, id);
CREATE INDEX tf_operations_expiry ON tf_operations (expires_at);
CREATE INDEX ledger_org ON ledger (org_id, created_at);
CREATE INDEX orgs_owner ON orgs (owner_principal_id);
CREATE UNIQUE INDEX auth_tokens_id ON auth_tokens (id);
CREATE INDEX auth_tokens_org ON auth_tokens (org_id);
CREATE INDEX quotes_org ON quotes (org_id, tenant_ref);
CREATE INDEX reservations_org ON reservations (org_id, tenant_ref);
CREATE INDEX reservations_expiry ON reservations (status, expires_at);
CREATE INDEX usage_events_unrolled ON usage_events (org_id, rollup_id);
CREATE INDEX idempotency_expiry ON idempotency (expires_at);
CREATE INDEX tf_resource_deployments_resource
  ON tf_resource_deployments (tenant_id, resource_uid, state, created_at, id);
CREATE UNIQUE INDEX tf_resource_deployments_one_active
  ON tf_resource_deployments (tenant_id, resource_uid)
  WHERE state = 'active';
CREATE INDEX tf_resource_attachments_provider
  ON tf_resource_attachments (tenant_id, provider_resource_uid, state, id);
CREATE INDEX tf_resource_attachments_consumer
  ON tf_resource_attachments (tenant_id, consumer_resource_uid, state, id);
CREATE UNIQUE INDEX tf_resource_migrations_one_open
  ON tf_resource_migrations (tenant_id, resource_uid)
  WHERE state IN ('planned', 'provisioning', 'transferring', 'verified');
CREATE INDEX tf_resource_migrations_resource
  ON tf_resource_migrations (tenant_id, resource_uid, created_at, id);
CREATE UNIQUE INDEX tf_resource_attachments_live_consumer_target
  ON tf_resource_attachments (tenant_id, consumer_resource_uid, target)
  WHERE state <> 'deleted';
CREATE UNIQUE INDEX tf_resource_migrations_commercial_authority
  ON tf_resource_migrations (tenant_id, commercial_authorization_ref);
CREATE INDEX provision_token_consumptions_terminal_cleanup
  ON provision_token_consumptions (expires_at_epoch_seconds, reservation_id);
CREATE INDEX provider_meter_schedule_due
  ON provider_meter_schedule (next_at, lease_until, tenant_id, deployment_id);
