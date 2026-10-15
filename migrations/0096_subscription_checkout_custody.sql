-- Forward-only custody for configured shared-plan Checkout. The existing
-- billing grants and subscription projection remain the sole money authority.
-- Every *_minor column in 0096 is USD cents: price_amount_minor records the
-- Stripe cash price; included_minor records the plan entitlement, not cash.
-- Convert the latter to wallet USD micros only at the grant boundary.
CREATE TABLE stripe_billing_price_identity (
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  price_id TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  included_minor INTEGER NOT NULL CHECK (included_minor >= 0),
  period_months INTEGER NOT NULL CHECK (period_months = 1),
  PRIMARY KEY (livemode, price_id)
);
CREATE TABLE stripe_billing_price_identity_checks (
  id TEXT PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1)
);
CREATE TABLE stripe_subscription_checkout_intents (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  request_key_digest TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  plan_key TEXT NOT NULL,
  pricing_revision TEXT NOT NULL,
  price_id TEXT NOT NULL,
  price_amount_minor INTEGER NOT NULL CHECK (price_amount_minor > 0),
  included_minor INTEGER NOT NULL CHECK (included_minor >= 0),
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  customer_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('prepared','dispatched','session_known','associated','expired','invalidated')),
  session_id TEXT UNIQUE,
  session_url TEXT,
  subscription_id TEXT,
  recovery_phase TEXT NOT NULL DEFAULT 'tail' CHECK (recovery_phase IN ('tail','prefix_head','prefix')),
  recovery_after_id TEXT,
  recovery_scan_head_id TEXT,
  recovery_prefix_head_id TEXT,
  recovery_match_id TEXT,
  recovery_conflict INTEGER NOT NULL DEFAULT 0 CHECK (recovery_conflict IN (0, 1)),
  recovery_version INTEGER NOT NULL DEFAULT 0 CHECK (recovery_version >= 0),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (state NOT IN ('session_known','associated','expired') OR session_id IS NOT NULL),
  CHECK (state <> 'associated' OR (subscription_id IS NOT NULL AND customer_id IS NOT NULL)),
  UNIQUE (org_id, request_key_digest)
);
CREATE UNIQUE INDEX stripe_subscription_checkout_org_slot
  ON stripe_subscription_checkout_intents (org_id)
  WHERE state IN ('prepared','dispatched','session_known');

CREATE TABLE stripe_subscription_custody_reconcile (
  stream TEXT PRIMARY KEY NOT NULL CHECK (stream IN ('checkout','cancellation')),
  cursor TEXT,
  generation INTEGER NOT NULL DEFAULT 0 CHECK (generation >= 0)
);

-- Immutable historical subscription binding. A later subscription may use
-- the same customer but never reassign a subscription to another Organization.
CREATE TABLE stripe_billing_associations (
  subscription_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  plan_key TEXT NOT NULL,
  pricing_revision TEXT NOT NULL,
  price_id TEXT NOT NULL,
  price_amount_minor INTEGER NOT NULL CHECK (price_amount_minor > 0),
  included_minor INTEGER NOT NULL CHECK (included_minor >= 0),
  session_id TEXT NOT NULL UNIQUE,
  association_generation INTEGER NOT NULL CHECK (association_generation > 0),
  created_at TEXT NOT NULL,
  UNIQUE (org_id, association_generation),
  FOREIGN KEY (org_id) REFERENCES stripe_billing_customers(org_id),
  FOREIGN KEY (session_id) REFERENCES stripe_subscription_checkout_intents(session_id)
);
CREATE INDEX stripe_billing_associations_org ON stripe_billing_associations (org_id, subscription_id);
