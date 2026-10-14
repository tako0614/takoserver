-- Stripe subscription, grant, and refund proof is additive to the shared wallet.
-- Existing funding and allocations retain their original identity and amount.
CREATE TABLE stripe_billing_customers (
  org_id TEXT PRIMARY KEY NOT NULL,
  customer_id TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
CREATE TABLE stripe_billing_subscriptions (
  org_id TEXT PRIMARY KEY NOT NULL,
  subscription_id TEXT NOT NULL UNIQUE,
  customer_id TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  pricing_revision TEXT NOT NULL,
  status TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL CHECK (cancel_at_period_end IN (0, 1)),
  period_start TEXT,
  period_end TEXT,
  paid_through TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE stripe_billing_commands (
  org_id TEXT NOT NULL,
  reference TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  kind TEXT NOT NULL,
  remote_id TEXT,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, reference)
);
-- One pending subscription Checkout for an Organization across distinct
-- idempotency references. The remote session must be resolved before reuse.
CREATE TABLE stripe_billing_checkouts (
  org_id TEXT PRIMARY KEY NOT NULL,
  reference TEXT NOT NULL,
  session_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE stripe_billing_reconcile (
  stream TEXT PRIMARY KEY NOT NULL,
  cursor TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0),
  cycle_unresolved INTEGER NOT NULL DEFAULT 0 CHECK (cycle_unresolved >= 0),
  last_unresolved INTEGER NOT NULL DEFAULT 0 CHECK (last_unresolved >= 0),
  cycle_started_at TEXT,
  updated_at TEXT NOT NULL
);
CREATE TABLE stripe_billing_object_claims (
  object_id TEXT PRIMARY KEY NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0)
);
-- Item failures survive a sweep cursor advancing. The attempt sequence gives
-- bounded retries fair rotation without depending on wall-clock precision.
CREATE TABLE stripe_billing_reconcile_failures (
  event_type TEXT NOT NULL,
  object_id TEXT NOT NULL,
  error_code TEXT NOT NULL,
  attempt_sequence INTEGER NOT NULL CHECK (attempt_sequence > 0),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (event_type, object_id)
);
CREATE TABLE stripe_billing_pricing (
  revision TEXT PRIMARY KEY NOT NULL,
  config_json TEXT NOT NULL CHECK (json_valid(config_json))
);
CREATE TABLE stripe_billing_refund_observations (
  refund_id TEXT PRIMARY KEY NOT NULL,
  charge_id TEXT NOT NULL,
  status TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- A verified Stripe source and its exact lot are an inseparable proof. A
-- charge may have multiple sources, but an automated refund must resolve the
-- complete charge allocation before touching any of them.
CREATE TABLE stripe_billing_grants (
  org_id TEXT NOT NULL,
  funding_ref TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('purchased', 'plan-included')),
  consumption_class TEXT NOT NULL CHECK (consumption_class IN ('subscription', 'purchased')),
  amount_micros INTEGER NOT NULL CHECK (amount_micros >= 0),
  expires_at TEXT,
  source_type TEXT NOT NULL CHECK (source_type IN ('checkout', 'invoice')),
  source_id TEXT NOT NULL,
  charge_id TEXT NOT NULL,
  customer_id TEXT,
  subscription_id TEXT,
  plan_key TEXT,
  pricing_revision TEXT,
  stripe_price_id TEXT,
  period_start TEXT,
  period_end TEXT,
  consideration_micros INTEGER NOT NULL CHECK (consideration_micros > 0),
  legacy_lot INTEGER NOT NULL DEFAULT 0 CHECK (legacy_lot IN (0, 1)),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, funding_ref),
  UNIQUE (source_type, source_id),
  CHECK (source_type <> 'invoice' OR
    (subscription_id IS NOT NULL AND plan_key IS NOT NULL AND pricing_revision IS NOT NULL
     AND stripe_price_id IS NOT NULL AND period_start IS NOT NULL AND period_end IS NOT NULL)),
  CHECK ((kind = 'plan-included' AND consumption_class = 'subscription') OR
         (kind = 'purchased' AND consumption_class = 'purchased')),
  CHECK (amount_micros > 0 OR kind = 'plan-included')
);
CREATE INDEX stripe_billing_grants_charge ON stripe_billing_grants (charge_id, source_type, source_id);
CREATE UNIQUE INDEX stripe_billing_grants_paid_period
  ON stripe_billing_grants (subscription_id, period_start, period_end)
  WHERE source_type = 'invoice';

-- A freeze can precede the funding proof for out-of-order refund delivery.
-- Generation fences prevent an older worker from clearing a newer freeze.
CREATE TABLE stripe_billing_fences (
  org_id TEXT NOT NULL,
  funding_ref TEXT NOT NULL,
  generation INTEGER NOT NULL CHECK (generation > 0),
  active INTEGER NOT NULL CHECK (active IN (0, 1)),
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, funding_ref)
);

-- Every refund belongs to its original lot. `debit_micros` removes unused
-- unexpired credit, `receivable_micros` records credit already consumed, and
-- `expired_micros` records unused credit already expired. No other lot pays it.
CREATE TABLE stripe_billing_refunds (
  refund_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  funding_ref TEXT NOT NULL,
  amount_micros INTEGER NOT NULL CHECK (amount_micros > 0),
  cumulative_refunded_micros INTEGER NOT NULL CHECK (cumulative_refunded_micros > 0),
  target_revoked_micros INTEGER NOT NULL CHECK (target_revoked_micros >= 0),
  debit_micros INTEGER NOT NULL CHECK (debit_micros >= 0),
  receivable_micros INTEGER NOT NULL CHECK (receivable_micros >= 0),
  expired_micros INTEGER NOT NULL CHECK (expired_micros >= 0),
  created_at TEXT NOT NULL,
  FOREIGN KEY (org_id, funding_ref) REFERENCES stripe_billing_grants(org_id, funding_ref),
  CHECK (debit_micros + receivable_micros + expired_micros >= 0)
);
CREATE INDEX stripe_billing_refunds_lot ON stripe_billing_refunds (org_id, funding_ref, created_at, refund_id);

-- Preserve every authenticated event row while extending the terminal status
-- vocabulary. No event money decision depends on this delivery table.
CREATE TABLE stripe_events_next (
  event_id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  object_id TEXT,
  event_created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  outcome_detail TEXT,
  settled_at TEXT,
  handler_version INTEGER NOT NULL DEFAULT 0 CHECK (handler_version >= 0),
  CHECK (length(event_id) BETWEEN 5 AND 255 AND substr(event_id, 1, 4) = 'evt_'),
  CHECK (length(type) BETWEEN 1 AND 128),
  CHECK (livemode IN (0, 1)),
  CHECK (object_id IS NULL OR length(object_id) BETWEEN 1 AND 255),
  CHECK (outcome IN ('received', 'credited', 'ignored', 'deferred', 'unsupported', 'applied')),
  CHECK (outcome_detail IS NULL OR length(outcome_detail) BETWEEN 1 AND 64),
  CHECK ((outcome = 'received') = (settled_at IS NULL))
);
INSERT INTO stripe_events_next
  (event_id, type, livemode, object_id, event_created_at, received_at,
   outcome, outcome_detail, settled_at)
  SELECT event_id, type, livemode, object_id, event_created_at,
         received_at, outcome, outcome_detail, settled_at FROM stripe_events;
DROP TABLE stripe_events;
ALTER TABLE stripe_events_next RENAME TO stripe_events;
CREATE INDEX stripe_events_outcome ON stripe_events (outcome, received_at);

ALTER TABLE org_wallet_holds ADD COLUMN closure_reason TEXT;
