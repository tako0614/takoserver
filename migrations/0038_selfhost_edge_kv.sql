-- Where a self-hosted machine keeps the bytes an edge.kv namespace promises.
--
-- Cloudflare sells a KV namespace as a service, so the managed backend only
-- has to name one. A machine standing on its own has to store the entries
-- itself, and until now `EdgeKVNamespace` was a name with nothing behind it:
-- the provider allocated an id and every read returned nothing.
--
-- Entries are keyed by the namespace id the provider derives, never by a
-- customer-chosen string, so two tenants cannot collide and a Worker can only
-- reach the namespaces its own Version declared. Expiry is stored as an
-- absolute instant rather than a TTL, because a row that outlives a restart
-- must not have its clock restarted with the process.
CREATE TABLE selfhost_kv_entries (
  namespace_id TEXT NOT NULL CHECK (length(namespace_id) BETWEEN 1 AND 1024),
  key TEXT NOT NULL CHECK (length(key) BETWEEN 1 AND 512),
  value BLOB NOT NULL CHECK (length(value) <= 26214400),
  -- Names and string values only, exactly what the edge.kv facade projects.
  metadata_json TEXT CHECK (
    metadata_json IS NULL OR (
      length(metadata_json) BETWEEN 2 AND 16384 AND
      json_valid(metadata_json) AND json_type(metadata_json) = 'object'
    )
  ),
  expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms > 0),
  PRIMARY KEY (namespace_id, key)
);

-- Listing walks one namespace in key order and skips what has expired, which
-- is exactly the primary key's order; the expiry index is for the sweep that
-- reclaims rows nobody asks for again.
CREATE INDEX selfhost_kv_entries_expiry ON selfhost_kv_entries (expires_at_ms);
