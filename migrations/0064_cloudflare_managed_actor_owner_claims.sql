-- Private WfP Actor-owner publication authority. An ActorNamespace UID owns
-- one stable script, independent of Actor Version. A pending claim is consumed
-- even when native PUT acknowledgement is lost; no ordinary retry can mint a
-- second PUT. Only a pre-PUT native absence read advances claimed to
-- upload_authorized. Recovery may commit exact native readback from that phase
-- without PUT; it cannot adopt a script from a merely claimed row. The public
-- foundation owns this shared D1 lineage, not the
-- private Cloudflare adapter or a new Host/Form admission contract.
CREATE TABLE cloudflare_managed_actor_owner_claims (
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  installation_id TEXT NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 1024),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 1024),
  dispatch_namespace TEXT NOT NULL CHECK (length(dispatch_namespace) BETWEEN 1 AND 1024),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 1024),
  actor_namespace_uid TEXT NOT NULL CHECK (length(actor_namespace_uid) BETWEEN 1 AND 1024),
  script_name TEXT NOT NULL CHECK (length(script_name) BETWEEN 1 AND 255),
  owner_class TEXT NOT NULL CHECK (length(owner_class) BETWEEN 1 AND 255),
  module_sha256 TEXT NOT NULL CHECK (
    length(module_sha256) = 64 AND module_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'upload_authorized', 'committed')),
  namespace_id TEXT CHECK (
    namespace_id IS NULL OR
    (length(namespace_id) = 32 AND namespace_id NOT GLOB '*[^0-9a-f]*')
  ),
  provider_etag TEXT CHECK (provider_etag IS NULL OR length(provider_etag) BETWEEN 1 AND 4096),
  CHECK (
    (state IN ('claimed', 'upload_authorized') AND namespace_id IS NULL AND provider_etag IS NULL) OR
    (state = 'committed' AND namespace_id IS NOT NULL AND provider_etag IS NOT NULL)
  ),
  PRIMARY KEY (provider_id, actor_namespace_uid),
  UNIQUE (account_id, dispatch_namespace, script_name),
  UNIQUE (account_id, namespace_id)
);

CREATE TRIGGER cloudflare_managed_actor_owner_claims_once
BEFORE UPDATE ON cloudflare_managed_actor_owner_claims
WHEN NOT (
    (OLD.state = 'claimed' AND NEW.state = 'upload_authorized'
      AND NEW.namespace_id IS NULL AND NEW.provider_etag IS NULL) OR
    (OLD.state = 'upload_authorized' AND NEW.state = 'committed'
      AND NEW.namespace_id IS NOT NULL AND NEW.provider_etag IS NOT NULL)
  )
  OR NEW.provider_id IS NOT OLD.provider_id
  OR NEW.installation_id IS NOT OLD.installation_id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.dispatch_namespace IS NOT OLD.dispatch_namespace
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.actor_namespace_uid IS NOT OLD.actor_namespace_uid
  OR NEW.script_name IS NOT OLD.script_name
  OR NEW.owner_class IS NOT OLD.owner_class
  OR NEW.module_sha256 IS NOT OLD.module_sha256
BEGIN
  SELECT RAISE(ABORT, 'managed_actor_owner_claim_immutable');
END;

CREATE TRIGGER cloudflare_managed_actor_owner_claims_no_delete
BEFORE DELETE ON cloudflare_managed_actor_owner_claims
BEGIN
  SELECT RAISE(ABORT, 'managed_actor_owner_claim_durable');
END;
