-- Provider changes are explicit, reviewable operations. A logical Resource
-- remains stable while source and target Deployments coexist.

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
  updated_at INTEGER NOT NULL,
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

CREATE UNIQUE INDEX tf_resource_migrations_one_open
  ON tf_resource_migrations (tenant_id, resource_uid)
  WHERE state IN ('planned', 'provisioning', 'transferring', 'verified');

CREATE INDEX tf_resource_migrations_resource
  ON tf_resource_migrations (tenant_id, resource_uid, created_at, id);
