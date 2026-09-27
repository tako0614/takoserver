-- Private WfP Actor KV publication capability. The claim binds one exact
-- target deployment incarnation to its native Actor and KV namespace before
-- any publication authority is consumed. Once upload is authorized, a lost
-- acknowledgement (including a later 404) is indeterminate: the capability
-- cannot be revoked, replaced, or reused. The public Host/API gains no state
-- route from this private-adapter persistence foundation.
CREATE TABLE cloudflare_managed_actor_kv_capability_claims (
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  target_resource_uid TEXT NOT NULL CHECK (length(target_resource_uid) BETWEEN 1 AND 1024),
  target_generation INTEGER NOT NULL CHECK (target_generation > 0),
  target_deployment_id TEXT NOT NULL CHECK (length(target_deployment_id) BETWEEN 1 AND 1024),
  installation_id TEXT NOT NULL CHECK (length(installation_id) BETWEEN 1 AND 1024),
  account_id TEXT NOT NULL CHECK (length(account_id) BETWEEN 1 AND 1024),
  dispatch_namespace TEXT NOT NULL CHECK (length(dispatch_namespace) BETWEEN 1 AND 1024),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 1024),
  native_id TEXT NOT NULL CHECK (length(native_id) BETWEEN 1 AND 1024),
  namespace_id TEXT NOT NULL CHECK (
    length(namespace_id) = 32 AND namespace_id NOT GLOB '*[^0-9a-f]*'
  ),
  script_name TEXT NOT NULL CHECK (length(script_name) BETWEEN 1 AND 255),
  module_sha256 TEXT NOT NULL CHECK (
    length(module_sha256) = 64 AND module_sha256 NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('claimed', 'upload_authorized', 'committed', 'revoked')),
  provider_etag TEXT CHECK (provider_etag IS NULL OR length(provider_etag) BETWEEN 1 AND 4096),
  CHECK (
    (state = 'committed' AND provider_etag IS NOT NULL) OR
    (state <> 'committed' AND provider_etag IS NULL)
  ),
  PRIMARY KEY (provider_id, target_resource_uid, target_generation, target_deployment_id),
  UNIQUE (account_id, dispatch_namespace, script_name)
);

CREATE TRIGGER cloudflare_managed_actor_kv_capability_claims_once
BEFORE UPDATE ON cloudflare_managed_actor_kv_capability_claims
WHEN NOT (
    (OLD.state = 'claimed' AND NEW.state = 'upload_authorized'
      AND NEW.provider_etag IS NULL) OR
    (OLD.state = 'claimed' AND NEW.state = 'revoked'
      AND NEW.provider_etag IS NULL) OR
    (OLD.state = 'upload_authorized' AND NEW.state = 'committed'
      AND NEW.provider_etag IS NOT NULL)
  )
  OR NEW.provider_id IS NOT OLD.provider_id
  OR NEW.target_resource_uid IS NOT OLD.target_resource_uid
  OR NEW.target_generation IS NOT OLD.target_generation
  OR NEW.target_deployment_id IS NOT OLD.target_deployment_id
  OR NEW.installation_id IS NOT OLD.installation_id
  OR NEW.account_id IS NOT OLD.account_id
  OR NEW.dispatch_namespace IS NOT OLD.dispatch_namespace
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.native_id IS NOT OLD.native_id
  OR NEW.namespace_id IS NOT OLD.namespace_id
  OR NEW.script_name IS NOT OLD.script_name
  OR NEW.module_sha256 IS NOT OLD.module_sha256
BEGIN
  SELECT RAISE(ABORT, 'managed_actor_kv_capability_claim_immutable');
END;

CREATE TRIGGER cloudflare_managed_actor_kv_capability_claims_no_delete
BEFORE DELETE ON cloudflare_managed_actor_kv_capability_claims
BEGIN
  SELECT RAISE(ABORT, 'managed_actor_kv_capability_claim_durable');
END;
