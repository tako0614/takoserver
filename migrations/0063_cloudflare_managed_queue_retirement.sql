-- Destructive Queue retirement is distinct from Consumer attachment removal.
-- This marker freezes the complete managed-transfer helper closure before any
-- helper DELETE. Historical transfer tombstones are deliberately not promoted
-- into markers: only an exact live Host delete operation may create one.
CREATE TABLE cloudflare_managed_queue_retirements (
  provider_id TEXT NOT NULL CHECK (length(provider_id) BETWEEN 1 AND 1024),
  destination_queue_id TEXT NOT NULL CHECK (length(destination_queue_id) BETWEEN 1 AND 1024),
  operation_id TEXT NOT NULL CHECK (length(operation_id) BETWEEN 1 AND 1024),
  tenant_id TEXT NOT NULL CHECK (length(tenant_id) BETWEEN 1 AND 1024),
  resource_uid TEXT NOT NULL CHECK (length(resource_uid) BETWEEN 1 AND 1024),
  resource_generation TEXT NOT NULL CHECK (length(resource_generation) BETWEEN 1 AND 1024),
  incarnation_id TEXT NOT NULL CHECK (length(incarnation_id) BETWEEN 1 AND 1024),
  execution_lease_token TEXT NOT NULL CHECK (length(execution_lease_token) BETWEEN 1 AND 1024),
  execution_fingerprint TEXT NOT NULL CHECK (length(execution_fingerprint) BETWEEN 1 AND 4096),
  route_snapshot_digest TEXT NOT NULL CHECK (
    substr(route_snapshot_digest, 1, 7) = 'sha256:' AND length(route_snapshot_digest) = 71 AND
    substr(route_snapshot_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  route_snapshot_json TEXT NOT NULL CHECK (
    length(route_snapshot_json) BETWEEN 2 AND 4194304 AND
    json_valid(route_snapshot_json) AND json_type(route_snapshot_json) = 'array'
  ),
  helper_state_json TEXT NOT NULL CHECK (
    length(helper_state_json) BETWEEN 2 AND 4194304 AND
    json_valid(helper_state_json) AND json_type(helper_state_json) = 'array'
  ),
  phase TEXT NOT NULL CHECK (phase IN ('cleaning', 'complete')),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms > 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  PRIMARY KEY (provider_id, destination_queue_id),
  UNIQUE (provider_id, operation_id)
);

CREATE TRIGGER cloudflare_managed_queue_retirements_identity_immutable
BEFORE UPDATE ON cloudflare_managed_queue_retirements
WHEN NEW.provider_id IS NOT OLD.provider_id
  OR NEW.destination_queue_id IS NOT OLD.destination_queue_id
  OR NEW.operation_id IS NOT OLD.operation_id
  OR NEW.tenant_id IS NOT OLD.tenant_id
  OR NEW.resource_uid IS NOT OLD.resource_uid
  OR NEW.resource_generation IS NOT OLD.resource_generation
  OR NEW.incarnation_id IS NOT OLD.incarnation_id
  OR NEW.execution_lease_token IS NOT OLD.execution_lease_token
  OR NEW.execution_fingerprint IS NOT OLD.execution_fingerprint
  OR NEW.route_snapshot_digest IS NOT OLD.route_snapshot_digest
  OR NEW.route_snapshot_json IS NOT OLD.route_snapshot_json
  OR NEW.created_at_ms IS NOT OLD.created_at_ms
BEGIN
  SELECT RAISE(ABORT, 'cloudflare_managed_queue_retirement_identity_immutable');
END;

CREATE TRIGGER cloudflare_managed_queue_retirements_no_regression
BEFORE UPDATE ON cloudflare_managed_queue_retirements
WHEN OLD.phase = 'complete' AND (
  NEW.phase IS NOT 'complete' OR NEW.helper_state_json IS NOT OLD.helper_state_json
)
BEGIN
  SELECT RAISE(ABORT, 'cloudflare_managed_queue_retirement_complete_immutable');
END;

-- Empty tripwire table used by private atomic route/marker batches. A failed
-- postcondition inserts 1 and aborts the whole D1 batch on this CHECK.
CREATE TABLE cloudflare_managed_queue_retirement_tripwire (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 0)
);
