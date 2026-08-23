-- A native identity is two facts, and this table recorded only one.
--
-- `native_id` says WHICH backing object serves a resource. It did not say
-- whether that object was ADOPTED. An object this Host minted for a resource
-- it created is not a claim anybody made; an object named by an import is.
-- Without the distinction the first import onto a Host-created resource looked
-- like an attempt to move an existing claim and was refused, so the ordinary
-- `terraform import` onto an address a configuration already manages could
-- never succeed — and a Host that records nothing for an object it already
-- served lets the next workspace adopt that object unopposed.
--
-- The table-level UNIQUE also held a native object against every state,
-- including `deleted`. A destroyed object's identifier stayed claimed forever,
-- so re-creating and re-importing the same object was impossible, and the dead
-- claim was held against every other Form kind as well as its own. A claim
-- belongs to a LIVE deployment, which a partial unique index states exactly.
-- SQLite cannot drop a table constraint in place, so the table is rebuilt.

CREATE TABLE tf_resource_deployments_next (
  tenant_id TEXT NOT NULL,
  id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  provider_pack_ref TEXT NOT NULL,
  provider_installation_ref TEXT NOT NULL,
  native_id TEXT NOT NULL,
  native_claimed INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL,
  observed_json TEXT NOT NULL,
  outputs_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(id) BETWEEN 3 AND 128),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(offering_id) BETWEEN 3 AND 255),
  CHECK (length(provider_pack_ref) BETWEEN 1 AND 255),
  CHECK (length(provider_installation_ref) BETWEEN 1 AND 255),
  CHECK (length(native_id) BETWEEN 1 AND 4096),
  CHECK (native_claimed IN (0, 1)),
  CHECK (state IN (
    'provisioning', 'candidate', 'active', 'draining', 'retained', 'failed', 'deleted'
  )),
  CHECK (length(observed_json) BETWEEN 2 AND 1048576),
  CHECK (length(outputs_json) BETWEEN 2 AND 1048576),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
);

-- Every row that exists was written by a build with no import path of its own
-- beyond adoption, and this Host cannot tell afterwards which of them was
-- adopted. Treating them all as claimed is the conservative reading: it keeps
-- an object that may have been imported from being silently re-pointed, and
-- the cost is only that an unimported one must be destroyed and re-adopted
-- rather than adopted in place.
INSERT INTO tf_resource_deployments_next
  (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
   provider_installation_ref, native_id, native_claimed, state, observed_json,
   outputs_json, created_at, updated_at)
SELECT
  tenant_id, id, resource_uid, offering_id, provider_pack_ref,
  provider_installation_ref, native_id, 1, state, observed_json,
  outputs_json, created_at, updated_at
FROM tf_resource_deployments;

DROP TABLE tf_resource_deployments;
ALTER TABLE tf_resource_deployments_next RENAME TO tf_resource_deployments;

CREATE INDEX tf_resource_deployments_resource
  ON tf_resource_deployments (tenant_id, resource_uid, state, created_at, id);

CREATE UNIQUE INDEX tf_resource_deployments_one_active
  ON tf_resource_deployments (tenant_id, resource_uid)
  WHERE state = 'active';

-- One GOVERNING deployment per native object. A row still governs its object
-- while it is being provisioned, waiting as a migration candidate, serving, or
-- draining; a deleted, retained, or failed row does not. That is what makes a
-- destroyed object adoptable again, and what keeps a migration candidate from
-- naming the object the active deployment is still serving.
CREATE UNIQUE INDEX tf_resource_deployments_live_native
  ON tf_resource_deployments (tenant_id, provider_installation_ref, native_id)
  WHERE state IN ('provisioning', 'candidate', 'active', 'draining');
