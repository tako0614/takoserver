-- A reseller capture crosses two durable authorities: the prepaid ledger and
-- the usage statement/resource reservation projection.  A provider/resource
-- cutover can finish before the caller gets to the capture, and a ledger call
-- can finish before its response reaches the caller.  Keep a value-only intent
-- so a later executor can forward-repair the same reservation without a
-- second charge.

CREATE TABLE reseller_settlement_intents (
  idempotency_key TEXT NOT NULL,
  org_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  reservation_id TEXT NOT NULL,
  authority_ref TEXT,
  offering_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  quantity REAL NOT NULL,
  amount_minor INTEGER NOT NULL,
  state TEXT NOT NULL,
  ledger_captured INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  lease_until INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (org_id, idempotency_key),
  UNIQUE (org_id, reservation_id),
  CHECK (length(idempotency_key) BETWEEN 3 AND 1024),
  CHECK (length(org_id) BETWEEN 1 AND 128),
  CHECK (length(tenant_ref) BETWEEN 3 AND 256),
  CHECK (length(reservation_id) BETWEEN 3 AND 128),
  CHECK (authority_ref IS NULL OR length(authority_ref) BETWEEN 1 AND 256),
  CHECK (length(offering_id) BETWEEN 1 AND 256),
  CHECK (length(meter) BETWEEN 1 AND 256),
  CHECK (quantity >= 0),
  CHECK (amount_minor >= 0),
  CHECK (state IN ('pending', 'ready', 'captured', 'recovery_required', 'cancelled')),
  CHECK (ledger_captured IN (0, 1)),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL)),
  CHECK (lease_until IS NULL OR lease_until >= 0),
  CHECK (last_error IS NULL OR length(last_error) BETWEEN 1 AND 128),
  CHECK (created_at >= 0),
  CHECK (updated_at >= created_at)
);

CREATE INDEX reseller_settlement_intents_due
  ON reseller_settlement_intents (state, lease_until, updated_at);

-- The guard is deliberately tiny and value-only.  Its CHECK turns the final
-- reservation + statement + intent transition into an all-or-none batch even
-- on a storage adapter that only exposes D1-style batches.
CREATE TABLE reseller_settlement_guards (
  token TEXT PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1),
  CHECK (length(token) BETWEEN 3 AND 128)
);
