-- The route-less Cloudflare executor must bind the first provider effect to
-- the exact durable Host saga and logical command. The Host saga remains the
-- receipt/outcome authority; this table is only the pre-effect compare-and-set
-- that prevents the same operation id from authorizing different native work.

CREATE TABLE tf_cloudflare_provider_executor_operations (
  operation_id TEXT PRIMARY KEY NOT NULL,
  tenant_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  host_fingerprint TEXT NOT NULL,
  mutation_kind TEXT NOT NULL,
  logical_intent_digest TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  CHECK (length(operation_id) BETWEEN 3 AND 128),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(host_fingerprint) BETWEEN 2 AND 8192),
  CHECK (mutation_kind IN ('apply', 'adopt', 'delete', 'sqlite-migration')),
  CHECK (
    length(logical_intent_digest) = 71 AND
    substr(logical_intent_digest, 1, 7) = 'sha256:' AND
    substr(logical_intent_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (created_at >= 0)
);

CREATE INDEX tf_cloudflare_provider_executor_operations_resource
  ON tf_cloudflare_provider_executor_operations (tenant_id, resource_uid, created_at);
