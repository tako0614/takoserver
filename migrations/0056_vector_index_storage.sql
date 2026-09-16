-- Host-owned SQL storage for the internal VectorIndex data plane.
--
-- The native provider index, endpoint, credentials, and native identity stay
-- outside this table family.  These rows are addressed only by the owning
-- tenant and Resource UID.  A Resource lifecycle caller owns admission and
-- deletion fences; this migration owns only the durable index and records.

CREATE TABLE vector_indexes (
  tenant_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  dimension INTEGER NOT NULL,
  metric TEXT NOT NULL,
  filter_keys_json TEXT NOT NULL,
  -- Private Host quota.  It is deliberately bounded even when a caller omits
  -- the option, so a query never has to scan an unbounded SQL table.
  record_limit INTEGER NOT NULL DEFAULT 1000,
  PRIMARY KEY (tenant_id, resource_uid),
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (dimension BETWEEN 1 AND 1536),
  CHECK (metric = 'cosine'),
  CHECK (length(CAST(filter_keys_json AS BLOB)) BETWEEN 2 AND 8192),
  CHECK (record_limit BETWEEN 1 AND 1000)
);

CREATE TABLE vector_index_records (
  tenant_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  values_blob BLOB NOT NULL,
  norm REAL NOT NULL,
  metadata_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, resource_uid, namespace, id),
  FOREIGN KEY (tenant_id, resource_uid)
    REFERENCES vector_indexes (tenant_id, resource_uid)
    ON DELETE CASCADE,
  CHECK (length(tenant_id) BETWEEN 1 AND 255),
  CHECK (length(resource_uid) BETWEEN 3 AND 128),
  CHECK (length(namespace) BETWEEN 0 AND 128),
  CHECK (length(id) BETWEEN 1 AND 128),
  CHECK (length(CAST(values_blob AS BLOB)) BETWEEN 4 AND 6144),
  CHECK (norm > 0 AND norm = norm),
  CHECK (length(CAST(metadata_json AS BLOB)) BETWEEN 2 AND 32768)
);

CREATE INDEX vector_index_records_scan
  ON vector_index_records (tenant_id, resource_uid, namespace, id);

CREATE TABLE vector_index_filter_terms (
  tenant_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  namespace TEXT NOT NULL,
  id TEXT NOT NULL,
  filter_key TEXT NOT NULL,
  value_type TEXT NOT NULL,
  canonical_scalar_json TEXT NOT NULL,
  PRIMARY KEY (tenant_id, resource_uid, namespace, id, filter_key),
  FOREIGN KEY (tenant_id, resource_uid, namespace, id)
    REFERENCES vector_index_records (tenant_id, resource_uid, namespace, id)
    ON DELETE CASCADE,
  CHECK (length(CAST(filter_key AS BLOB)) BETWEEN 1 AND 64),
  CHECK (value_type IN ('string', 'number', 'boolean', 'null')),
  CHECK (length(CAST(canonical_scalar_json AS BLOB)) BETWEEN 1 AND 32768)
);

-- The query path uses one equality lookup per declared filter term.  The id
-- suffix keeps the lookup deterministic without making ties part of the wire
-- contract.
CREATE INDEX vector_index_filter_terms_equality
  ON vector_index_filter_terms
    (tenant_id, resource_uid, namespace, filter_key, value_type,
     canonical_scalar_json, id);

-- Configuration is immutable for the lifetime of a Resource.  A replacement
-- must be a new Resource UID or an explicitly reviewed migration; there is no
-- update route here that can silently reinterpret existing vectors.
CREATE TRIGGER vector_index_config_immutable
BEFORE UPDATE OF dimension, metric, filter_keys_json, record_limit ON vector_indexes
WHEN NEW.dimension <> OLD.dimension
  OR NEW.metric <> OLD.metric
  OR NEW.filter_keys_json <> OLD.filter_keys_json
  OR NEW.record_limit <> OLD.record_limit
BEGIN
  SELECT RAISE(ABORT, 'vector_index_config_immutable');
END;

-- A new key is admitted only while the scoped record count is below the
-- private quota.  Existing keys are replacements and remain writable at the
-- cap, which keeps retries and whole-record replacement possible.
CREATE TRIGGER vector_index_record_quota
BEFORE INSERT ON vector_index_records
WHEN NOT EXISTS (
  SELECT 1 FROM vector_index_records AS existing
  WHERE existing.tenant_id = NEW.tenant_id
    AND existing.resource_uid = NEW.resource_uid
    AND existing.namespace = NEW.namespace
    AND existing.id = NEW.id
)
AND (
  SELECT COUNT(*)
  FROM vector_index_records AS record
  WHERE record.tenant_id = NEW.tenant_id
    AND record.resource_uid = NEW.resource_uid
) >= (
  SELECT index_record.record_limit
  FROM vector_indexes AS index_record
  WHERE index_record.tenant_id = NEW.tenant_id
    AND index_record.resource_uid = NEW.resource_uid
)
BEGIN
  SELECT RAISE(ABORT, 'vector_index_record_quota');
END;

-- The codec checks the dimension before the first write.  This trigger keeps
-- direct SQL writers from introducing a BLOB that the exact scorer cannot
-- decode if an operator later inspects the tables.
CREATE TRIGGER vector_index_record_dimension
BEFORE INSERT ON vector_index_records
WHEN length(CAST(NEW.values_blob AS BLOB)) <> (
  SELECT dimension * 4
  FROM vector_indexes AS index_record
  WHERE index_record.tenant_id = NEW.tenant_id
    AND index_record.resource_uid = NEW.resource_uid
)
BEGIN
  SELECT RAISE(ABORT, 'vector_index_record_dimension');
END;

CREATE TRIGGER vector_index_record_dimension_update
BEFORE UPDATE OF values_blob ON vector_index_records
WHEN length(CAST(NEW.values_blob AS BLOB)) <> (
  SELECT dimension * 4
  FROM vector_indexes AS index_record
  WHERE index_record.tenant_id = NEW.tenant_id
    AND index_record.resource_uid = NEW.resource_uid
)
BEGIN
  SELECT RAISE(ABORT, 'vector_index_record_dimension');
END;
