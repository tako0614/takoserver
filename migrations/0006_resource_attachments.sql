-- Connections are first-class relations. They store only bounded references;
-- long-lived provider credentials never belong in this table.

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

CREATE INDEX tf_resource_attachments_provider
  ON tf_resource_attachments (tenant_id, provider_resource_uid, state, id);

CREATE INDEX tf_resource_attachments_consumer
  ON tf_resource_attachments (tenant_id, consumer_resource_uid, state, id);
