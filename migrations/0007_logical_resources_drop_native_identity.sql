-- A logical Takoform Resource never owns a provider-native identity.
--
-- Older pre-Deployment builds could write one into tf_resources. Silently
-- dropping such a value would orphan real infrastructure, so that upgrade is
-- refused until an operator has adopted every native identity into an exact
-- tf_resource_deployments row and cleared the legacy column.

CREATE TABLE tf_resource_native_identity_migration_guard (
  singleton INTEGER NOT NULL CHECK (singleton = 0)
);

INSERT INTO tf_resource_native_identity_migration_guard (singleton) VALUES (0);
INSERT INTO tf_resource_native_identity_migration_guard (singleton)
SELECT 0 FROM tf_resources WHERE native_id IS NOT NULL LIMIT 1;

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
