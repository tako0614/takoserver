-- Prepared -> dispatched is the unique external-mutation claim. No transition
-- returns to prepared, even if Stripe's acknowledgement is lost.
-- price_amount_minor (Stripe cash) and included_minor (plan entitlement)
-- are both USD cents. Wallet grant accounting converts entitlement to micros
-- at its single grant boundary; custody never treats these as wallet units.
CREATE TABLE stripe_subscription_cancellation_intents (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  request_key_digest TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  subscription_id TEXT NOT NULL,
  customer_id TEXT NOT NULL,
  livemode INTEGER NOT NULL CHECK (livemode IN (0, 1)),
  plan_key TEXT NOT NULL,
  pricing_revision TEXT NOT NULL,
  price_id TEXT NOT NULL,
  price_amount_minor INTEGER NOT NULL CHECK (price_amount_minor > 0),
  included_minor INTEGER NOT NULL CHECK (included_minor >= 0),
  pre_period_end TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('prepared','dispatched','verified')),
  effective_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK ((state = 'verified') = (effective_at IS NOT NULL)),
  UNIQUE (org_id, request_key_digest),
  FOREIGN KEY (subscription_id) REFERENCES stripe_billing_associations(subscription_id)
);
CREATE UNIQUE INDEX stripe_subscription_cancellation_active
  ON stripe_subscription_cancellation_intents (subscription_id)
  WHERE state IN ('prepared','dispatched');
