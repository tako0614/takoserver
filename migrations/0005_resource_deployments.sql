-- Provider-native realizations belong to Deployments, not logical Resources.
-- Multiple rows may coexist during migration; exactly one may be active.

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

CREATE INDEX tf_resource_deployments_resource
  ON tf_resource_deployments (tenant_id, resource_uid, state, created_at, id);

CREATE UNIQUE INDEX tf_resource_deployments_one_active
  ON tf_resource_deployments (tenant_id, resource_uid)
  WHERE state = 'active';
