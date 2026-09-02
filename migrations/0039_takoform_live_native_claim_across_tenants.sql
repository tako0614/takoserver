-- A native object is one object, whoever declares it.
--
-- The live-claim index was scoped by tenant, so two tenants could each hold a
-- live deployment on the same provider object. Nothing legitimate produces
-- that: every native name a Host mints is derived from the tenant's own
-- address, provider-assigned identifiers are unique in the account, and import
-- is now fenced to the object this Host derives for the exact Resource address
-- being imported onto. The tenant scoping was therefore not describing a real
-- freedom, only failing to state an invariant the Host already relies on when
-- it reads a claim before adopting.
--
-- One provider installation is one account. Making the claim unique across it
-- says exactly that, and leaves a second tenant's write refused by the database
-- rather than by the fence alone.

-- The tightened index is a promise about the rows that already exist too. If
-- any two tenants hold a live claim on one object today, refuse by name here
-- rather than inside CREATE UNIQUE INDEX, whose message names only the index.
CREATE TABLE tf_resource_deployments_native_claim_guard (duplicate_native_id TEXT);

CREATE TRIGGER tf_resource_deployments_native_claim_guard_refuses
BEFORE INSERT ON tf_resource_deployments_native_claim_guard
BEGIN
  SELECT RAISE(ABORT, 'takoform_live_native_claim_shared_across_tenants');
END;

INSERT INTO tf_resource_deployments_native_claim_guard (duplicate_native_id)
SELECT native_id
FROM tf_resource_deployments
WHERE state IN ('provisioning', 'candidate', 'active', 'draining')
GROUP BY provider_installation_ref, native_id
HAVING COUNT(*) > 1;

DROP TRIGGER tf_resource_deployments_native_claim_guard_refuses;
DROP TABLE tf_resource_deployments_native_claim_guard;

DROP INDEX tf_resource_deployments_live_native;

CREATE UNIQUE INDEX tf_resource_deployments_live_native
  ON tf_resource_deployments (provider_installation_ref, native_id)
  WHERE state IN ('provisioning', 'candidate', 'active', 'draining');
