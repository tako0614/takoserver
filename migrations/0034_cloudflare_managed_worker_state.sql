-- Provider-private authority for the official Cloudflare Workers-for-Platforms
-- lane. These rows are the first-primary gateway authority and the durable
-- receipts that make a lost provider acknowledgement recoverable.
CREATE TABLE cloudflare_managed_worker_receipts (
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  resource_uid TEXT NOT NULL CHECK (length(resource_uid) BETWEEN 1 AND 1024),
  native_id TEXT NOT NULL CHECK (length(native_id) BETWEEN 1 AND 1024),
  kind TEXT NOT NULL CHECK (
    kind IN ('worker', 'version', 'deployment', 'endpoint', 'cron', 'consumer', 'sqlite')
  ),
  logical_worker_id TEXT NOT NULL CHECK (length(logical_worker_id) BETWEEN 1 AND 1024),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 1024),
  generation INTEGER NOT NULL CHECK (generation > 0),
  descriptor_digest TEXT NOT NULL CHECK (
    substr(descriptor_digest, 1, 7) = 'sha256:' AND length(descriptor_digest) = 71 AND
    substr(descriptor_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  state TEXT NOT NULL CHECK (state IN ('pending', 'committed', 'deleting', 'deleted')),
  provider_etag TEXT CHECK (
    provider_etag IS NULL OR (
      state IN ('committed', 'deleting') AND length(provider_etag) BETWEEN 1 AND 4096
    )
  ),
  observed_json TEXT NOT NULL DEFAULT '{}' CHECK (
    length(observed_json) BETWEEN 2 AND 1048576 AND
    json_valid(observed_json) AND json_type(observed_json) = 'object'
  ),
  previous_json TEXT CHECK (
    previous_json IS NULL OR (
      length(previous_json) BETWEEN 2 AND 2097152 AND
      json_valid(previous_json) AND json_type(previous_json) = 'object'
    )
  ),
  CHECK (
    state = 'pending' OR
    (state = 'deleting' AND previous_json IS NOT NULL) OR
    (state IN ('committed', 'deleted') AND previous_json IS NULL)
  ),
  PRIMARY KEY (provider_id, resource_uid),
  UNIQUE (provider_id, native_id),
  UNIQUE (provider_id, operation_id)
);

CREATE INDEX cloudflare_managed_worker_receipts_logical
  ON cloudflare_managed_worker_receipts (provider_id, logical_worker_id, kind);

CREATE TABLE cloudflare_managed_worker_routes (
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  route_kind TEXT NOT NULL CHECK (route_kind IN ('host', 'worker', 'queue', 'schedule')),
  route_key TEXT NOT NULL CHECK (length(route_key) BETWEEN 1 AND 1024),
  owner_native_id TEXT NOT NULL CHECK (length(owner_native_id) BETWEEN 1 AND 1024),
  generation INTEGER NOT NULL CHECK (generation > 0),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 1024),
  state TEXT NOT NULL CHECK (state IN ('active', 'tombstone')),
  value_json TEXT NOT NULL CHECK (
    length(value_json) BETWEEN 2 AND 1048576 AND
    json_valid(value_json) AND json_type(value_json) = 'object'
  ),
  PRIMARY KEY (provider_id, route_kind, route_key),
  UNIQUE (provider_id, operation_id)
);

CREATE INDEX cloudflare_managed_worker_routes_active
  ON cloudflare_managed_worker_routes (provider_id, route_kind, state, route_key);

CREATE TABLE cloudflare_managed_worker_cron_leases (
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  cron TEXT NOT NULL CHECK (length(cron) BETWEEN 1 AND 1024),
  logical_worker_id TEXT NOT NULL CHECK (length(logical_worker_id) BETWEEN 1 AND 1024),
  lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 1 AND 1024),
  lease_expires_at_ms INTEGER NOT NULL CHECK (lease_expires_at_ms > 0),
  PRIMARY KEY (provider_id, cron, logical_worker_id)
);

CREATE INDEX cloudflare_managed_worker_cron_leases_expiry
  ON cloudflare_managed_worker_cron_leases (provider_id, lease_expires_at_ms);
