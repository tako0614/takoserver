-- One native send intent per accepted EdgeKVNamespace CREATE or DELETE Operation.
-- This is subordinate to tf_v2_resources/operations, never a second Resource ledger.
-- A matching provider title alone cannot establish ownership after a lost ACK.
CREATE TABLE tf_v2_edge_kv_native_custody (
  operation_id TEXT PRIMARY KEY REFERENCES tf_v2_operations(id),
  resource_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  action TEXT NOT NULL CHECK (action IN ('create', 'delete')),
  principal TEXT NOT NULL,
  space TEXT NOT NULL,
  backend_key TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  accepted_spec_json TEXT NOT NULL CHECK (accepted_spec_json = '{}'),
  planned_title TEXT NOT NULL CHECK (length(planned_title) BETWEEN 1 AND 512),
  closure_digest TEXT NOT NULL CHECK (
    length(closure_digest) = 71 AND substr(closure_digest, 1, 7) = 'sha256:'
    AND substr(closure_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  source_operation_id TEXT REFERENCES tf_v2_operations(id),
  native_id TEXT CHECK (native_id IS NULL OR length(native_id) BETWEEN 1 AND 255),
  grant_lease_token TEXT NOT NULL,
  granted_at_ms INTEGER NOT NULL CHECK (granted_at_ms >= 0),
  acknowledged_receipt TEXT CHECK (
    acknowledged_receipt IS NULL OR length(acknowledged_receipt) BETWEEN 1 AND 255
  ),
  confirmed_receipt TEXT CHECK (
    confirmed_receipt IS NULL OR length(confirmed_receipt) BETWEEN 1 AND 255
  ),
  CHECK (
    (action = 'create' AND source_operation_id IS NULL
      AND (native_id IS NULL) = (acknowledged_receipt IS NULL)
      AND (confirmed_receipt IS NULL OR acknowledged_receipt IS NOT NULL))
    OR (action = 'delete' AND source_operation_id IS NOT NULL AND native_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX tf_v2_edge_kv_one_create
  ON tf_v2_edge_kv_native_custody(resource_uid) WHERE action = 'create';
CREATE UNIQUE INDEX tf_v2_edge_kv_native_id
  ON tf_v2_edge_kv_native_custody(target_key, native_id)
  WHERE action = 'create' AND native_id IS NOT NULL;
CREATE UNIQUE INDEX tf_v2_edge_kv_planned_title
  ON tf_v2_edge_kv_native_custody(target_key, planned_title)
  WHERE action = 'create';

-- The INSERT SELECT in the custody is the linearization point. This trigger
-- refuses a different trusted SQL writer without the same live DB-time claim.
CREATE TRIGGER tf_v2_edge_kv_native_insert_guard
BEFORE INSERT ON tf_v2_edge_kv_native_custody
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op
  JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
  WHERE op.id = NEW.operation_id AND op.resource_uid = NEW.resource_uid
    AND op.action = NEW.action AND op.action IN ('create', 'delete')
    AND op.principal = NEW.principal AND resource.principal = NEW.principal
    AND resource.space = NEW.space
    AND resource.form_url = 'https://edge.forms.takoform.com/forms/EdgeKVNamespace/0.2.0/'
    AND op.backend_key = NEW.backend_key AND op.backend_id = NEW.backend_id
    AND op.target_key = NEW.target_key AND resource.backend_id = NEW.backend_id
    AND resource.target_key = NEW.target_key
    AND op.generation = NEW.generation AND resource.generation = NEW.generation
    AND op.accepted_spec_json = NEW.accepted_spec_json
    AND resource.spec_json = NEW.accepted_spec_json
    AND resource.last_operation = op.id AND resource.busy_operation = op.id
    AND resource.deleted_at IS NULL
    AND (NEW.action = 'create' OR resource.phase = 'deleting')
    AND op.status = 'reconciling' AND op.dispatch_possible = 1
    AND op.lease_token = NEW.grant_lease_token
    AND op.lease_until_ms > NEW.granted_at_ms
    AND op.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
    AND (NEW.action = 'create' OR (
      NOT EXISTS (
        SELECT 1 FROM tf_v2_resource_references reference
        JOIN tf_v2_resources referrer ON referrer.uid = reference.referrer_uid
        WHERE reference.target_uid = resource.uid AND referrer.deleted_at IS NULL
      )
      AND EXISTS (
        SELECT 1 FROM tf_v2_edge_kv_native_custody source
        WHERE source.operation_id = NEW.source_operation_id
          AND source.resource_uid = NEW.resource_uid AND source.action = 'create'
          AND source.principal = NEW.principal AND source.space = NEW.space
          AND source.backend_id = NEW.backend_id AND source.target_key = NEW.target_key
          AND source.generation < NEW.generation
          AND source.planned_title = NEW.planned_title
          AND source.closure_digest = NEW.closure_digest
          AND source.native_id = NEW.native_id
          AND source.confirmed_receipt IS NOT NULL
      )
    ))
    AND (NEW.action = 'delete' OR (
      NEW.source_operation_id IS NULL AND NEW.native_id IS NULL
      AND NEW.acknowledged_receipt IS NULL AND NEW.confirmed_receipt IS NULL
    ))
    AND (NEW.action = 'create' OR (
      NEW.acknowledged_receipt IS NULL AND NEW.confirmed_receipt IS NULL
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_edge_kv_native_claim_lost');
END;

CREATE TRIGGER tf_v2_edge_kv_native_monotonic
BEFORE UPDATE ON tf_v2_edge_kv_native_custody
WHEN NEW.operation_id IS NOT OLD.operation_id OR NEW.resource_uid IS NOT OLD.resource_uid
  OR NEW.action IS NOT OLD.action OR NEW.principal IS NOT OLD.principal
  OR NEW.space IS NOT OLD.space OR NEW.backend_key IS NOT OLD.backend_key
  OR NEW.backend_id IS NOT OLD.backend_id OR NEW.target_key IS NOT OLD.target_key
  OR NEW.generation IS NOT OLD.generation
  OR NEW.accepted_spec_json IS NOT OLD.accepted_spec_json
  OR NEW.planned_title IS NOT OLD.planned_title
  OR NEW.closure_digest IS NOT OLD.closure_digest
  OR NEW.source_operation_id IS NOT OLD.source_operation_id
  OR (OLD.native_id IS NOT NULL AND NEW.native_id IS NOT OLD.native_id)
  OR NEW.grant_lease_token IS NOT OLD.grant_lease_token
  OR NEW.granted_at_ms IS NOT OLD.granted_at_ms
  OR (OLD.acknowledged_receipt IS NOT NULL
    AND NEW.acknowledged_receipt IS NOT OLD.acknowledged_receipt)
  OR (OLD.confirmed_receipt IS NOT NULL
    AND NEW.confirmed_receipt IS NOT OLD.confirmed_receipt)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_edge_kv_native_immutable');
END;

CREATE TRIGGER tf_v2_edge_kv_native_no_delete
BEFORE DELETE ON tf_v2_edge_kv_native_custody
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_edge_kv_native_immutable');
END;
