-- A logical Takoform Resource never owns a provider-native identity.
--
-- Older pre-Deployment builds could write one into tf_resources. The three
-- released Cloudflare-backed Forms from that build have exact historical
-- offering and provider identities, so they can be adopted deterministically.
-- Anything else remains unknown and makes the migration fail closed instead
-- of orphaning real infrastructure or inventing a new Form/provider mapping.

INSERT INTO tf_resource_deployments
  (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
   provider_installation_ref, native_id, state, observed_json, outputs_json,
   created_at, updated_at)
SELECT
  resource.tenant_id,
  'dep_legacy_' || resource.uid,
  resource.uid,
  CASE resource.kind
    WHEN 'ObjectBucket' THEN 'storage.object.standard'
    WHEN 'SqlDatabase' THEN 'database.sql.standard'
    WHEN 'WorkerScript' THEN 'compute.worker.standard'
  END,
  'cloudflare',
  'cloudflare.primary',
  resource.native_id,
  'active',
  COALESCE(json_extract(resource.resource_json, '$.status.observed'), '{}'),
  COALESCE(json_extract(resource.resource_json, '$.status.outputs'), '{}'),
  resource.updated_at,
  resource.updated_at
FROM tf_resources AS resource
WHERE resource.native_id IS NOT NULL
  AND resource.api_version = 'edge.forms.takoform.com/v1beta1'
  AND resource.kind IN ('ObjectBucket', 'SqlDatabase', 'WorkerScript')
  AND NOT EXISTS (
    SELECT 1
    FROM tf_resource_deployments AS deployment
    WHERE deployment.tenant_id = resource.tenant_id
      AND deployment.id = 'dep_legacy_' || resource.uid
      AND deployment.resource_uid = resource.uid
      AND deployment.offering_id = CASE resource.kind
        WHEN 'ObjectBucket' THEN 'storage.object.standard'
        WHEN 'SqlDatabase' THEN 'database.sql.standard'
        WHEN 'WorkerScript' THEN 'compute.worker.standard'
      END
      AND deployment.provider_pack_ref = 'cloudflare'
      AND deployment.provider_installation_ref = 'cloudflare.primary'
      AND deployment.native_id = resource.native_id
      AND deployment.state = 'active'
  );

CREATE TABLE tf_resource_native_identity_migration_guard (
  singleton INTEGER NOT NULL CHECK (singleton = 0)
);

INSERT INTO tf_resource_native_identity_migration_guard (singleton) VALUES (0);
INSERT INTO tf_resource_native_identity_migration_guard (singleton)
SELECT 0
FROM tf_resources AS resource
WHERE resource.native_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM tf_resource_deployments AS deployment
    WHERE deployment.tenant_id = resource.tenant_id
      AND deployment.id = 'dep_legacy_' || resource.uid
      AND deployment.resource_uid = resource.uid
      AND deployment.offering_id = CASE resource.kind
        WHEN 'ObjectBucket' THEN 'storage.object.standard'
        WHEN 'SqlDatabase' THEN 'database.sql.standard'
        WHEN 'WorkerScript' THEN 'compute.worker.standard'
      END
      AND deployment.provider_pack_ref = 'cloudflare'
      AND deployment.provider_installation_ref = 'cloudflare.primary'
      AND deployment.native_id = resource.native_id
      AND deployment.state = 'active'
  )
LIMIT 1;

UPDATE tf_resources AS resource
SET native_id = NULL
WHERE resource.native_id IS NOT NULL
  AND EXISTS (
    SELECT 1
    FROM tf_resource_deployments AS deployment
    WHERE deployment.tenant_id = resource.tenant_id
      AND deployment.id = 'dep_legacy_' || resource.uid
      AND deployment.resource_uid = resource.uid
      AND deployment.offering_id = CASE resource.kind
        WHEN 'ObjectBucket' THEN 'storage.object.standard'
        WHEN 'SqlDatabase' THEN 'database.sql.standard'
        WHEN 'WorkerScript' THEN 'compute.worker.standard'
      END
      AND deployment.provider_pack_ref = 'cloudflare'
      AND deployment.provider_installation_ref = 'cloudflare.primary'
      AND deployment.native_id = resource.native_id
      AND deployment.state = 'active'
  );

CREATE TABLE tf_resources_without_native_identity (
  tenant_id TEXT NOT NULL,
  space TEXT NOT NULL,
  api_version TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  uid TEXT NOT NULL,
  generation TEXT NOT NULL,
  revision TEXT NOT NULL,
  resource_json TEXT NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, space, api_version, kind, name),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(space) BETWEEN 1 AND 255),
  CHECK (length(uid) BETWEEN 3 AND 128),
  CHECK (length(resource_json) BETWEEN 2 AND 1048576),
  CHECK (updated_at >= 0)
);

INSERT INTO tf_resources_without_native_identity
  (tenant_id, space, api_version, kind, name, uid, generation, revision,
   resource_json, updated_at)
SELECT tenant_id, space, api_version, kind, name, uid, generation, revision,
       resource_json, updated_at
FROM tf_resources;

DROP TABLE tf_resources;
ALTER TABLE tf_resources_without_native_identity RENAME TO tf_resources;

-- Keep this as the final statement. Bun's SQLite exec reports the final
-- statement's error; making the uniqueness proof last therefore rolls the
-- whole migration back when the legacy row above added a second sentinel.
CREATE UNIQUE INDEX tf_resource_native_identity_migration_guard_exact
  ON tf_resource_native_identity_migration_guard (singleton);
