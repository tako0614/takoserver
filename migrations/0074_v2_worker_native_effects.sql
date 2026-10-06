-- One durable permission to attempt an external native effect for an accepted
-- WorkerVersion Operation. This is intent/receipt custody, not external fencing
-- or proof that a Form Operation completed. No historical v2 rows are changed.
CREATE TABLE tf_v2_worker_native_effects (
  operation_id TEXT PRIMARY KEY REFERENCES tf_v2_operations(id),
  resource_uid TEXT NOT NULL REFERENCES tf_v2_resources(uid),
  principal TEXT NOT NULL,
  space TEXT NOT NULL,
  backend_key TEXT NOT NULL,
  backend_id TEXT NOT NULL,
  target_key TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation >= 1),
  native_identity TEXT NOT NULL CHECK (length(native_identity) BETWEEN 1 AND 255),
  closure_digest TEXT NOT NULL CHECK (
    length(closure_digest) = 71 AND substr(closure_digest, 1, 7) = 'sha256:'
    AND substr(closure_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  grant_lease_token TEXT NOT NULL,
  granted_at_ms INTEGER NOT NULL CHECK (granted_at_ms >= 0),
  acknowledged_receipt TEXT CHECK (
    acknowledged_receipt IS NULL OR length(acknowledged_receipt) BETWEEN 1 AND 255
  ),
  confirmed_receipt TEXT CHECK (
    confirmed_receipt IS NULL OR length(confirmed_receipt) BETWEEN 1 AND 255
  ),
  CHECK (
    acknowledged_receipt IS NULL OR confirmed_receipt IS NULL
    OR acknowledged_receipt = confirmed_receipt
  )
);

-- The public writer's INSERT SELECT repeats this exact predicate. The trigger
-- also prevents an unrelated trusted SQL writer from creating a grant without
-- the current Operation/Resource claim. The lease is only a DB send-admission
-- fence: it cannot cancel a request already in flight at a native provider.
CREATE TRIGGER tf_v2_worker_native_effect_insert_guard
BEFORE INSERT ON tf_v2_worker_native_effects
WHEN NOT EXISTS (
  SELECT 1 FROM tf_v2_operations op
  JOIN tf_v2_resources r ON r.uid = op.resource_uid
  WHERE op.id = NEW.operation_id AND op.resource_uid = NEW.resource_uid
    AND op.principal = NEW.principal AND r.principal = NEW.principal
    AND r.space = NEW.space
    AND r.form_url = 'https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/'
    AND op.action IN ('create', 'update')
    AND op.generation = NEW.generation AND r.generation = NEW.generation
    AND op.backend_key = NEW.backend_key
    AND op.backend_id = NEW.backend_id AND r.backend_id = NEW.backend_id
    AND op.target_key = NEW.target_key AND r.target_key = NEW.target_key
    AND op.accepted_spec_json = r.spec_json
    AND op.status = 'reconciling' AND op.dispatch_possible = 1
    AND op.lease_token = NEW.grant_lease_token
    AND op.lease_until_ms > NEW.granted_at_ms
    -- The client clock passed before an await is not the grant linearization
    -- time. Require the lease through the end of this DB clock second too.
    AND op.lease_until_ms > (CAST(strftime('%s', 'now') AS INTEGER) + 1) * 1000
    AND r.last_operation = op.id AND r.busy_operation = op.id
    AND r.deleted_at IS NULL
)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_effect_claim_lost');
END;

-- Native receipts may arrive after the SQL lease changes or the process
-- restarts. They can only advance this exact immutable intent, never replace
-- its identity or retract previously recorded evidence.
CREATE TRIGGER tf_v2_worker_native_effect_monotonic
BEFORE UPDATE ON tf_v2_worker_native_effects
WHEN NEW.operation_id IS NOT OLD.operation_id
  OR NEW.resource_uid IS NOT OLD.resource_uid
  OR NEW.principal IS NOT OLD.principal OR NEW.space IS NOT OLD.space
  OR NEW.backend_key IS NOT OLD.backend_key
  OR NEW.backend_id IS NOT OLD.backend_id OR NEW.target_key IS NOT OLD.target_key
  OR NEW.generation IS NOT OLD.generation
  OR NEW.native_identity IS NOT OLD.native_identity
  OR NEW.closure_digest IS NOT OLD.closure_digest
  OR NEW.grant_lease_token IS NOT OLD.grant_lease_token
  OR NEW.granted_at_ms IS NOT OLD.granted_at_ms
  OR (OLD.acknowledged_receipt IS NOT NULL
    AND NEW.acknowledged_receipt IS NOT OLD.acknowledged_receipt)
  OR (OLD.confirmed_receipt IS NOT NULL
    AND NEW.confirmed_receipt IS NOT OLD.confirmed_receipt)
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_effect_immutable');
END;

CREATE TRIGGER tf_v2_worker_native_effect_no_delete
BEFORE DELETE ON tf_v2_worker_native_effects
BEGIN
  SELECT RAISE(ABORT, 'tf_v2_worker_native_effect_immutable');
END;
