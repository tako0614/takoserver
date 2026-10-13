-- One row per verified Stripe webhook event, keyed by Stripe's own event id.
--
-- This table deduplicates deliveries and records what the Host did with each
-- event. It never decides money: a wallet credit is idempotent through its own
-- ledger reference (`stripe:<Checkout Session id>`), so a lost row or a lost
-- race here can repeat work but cannot credit twice. Amounts, organizations
-- and periods are re-read from the Stripe API, never taken from this row or
-- from the event body.
--
-- `received` is the only non-terminal outcome: the event was authenticated and
-- recorded but not finished (a crash, or Stripe being unavailable), so a
-- redelivery processes it again. Every other outcome answers a redelivery
-- without processing. `deferred` names an event type this Host recognises for
-- a later capability (subscriptions, invoices, refunds) and records without
-- acting on; `unsupported` is any other type.
CREATE TABLE stripe_events (
  event_id TEXT PRIMARY KEY NOT NULL,
  type TEXT NOT NULL,
  livemode INTEGER NOT NULL,
  object_id TEXT,
  event_created_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  outcome TEXT NOT NULL,
  outcome_detail TEXT,
  settled_at TEXT,
  CHECK (length(event_id) BETWEEN 5 AND 255 AND substr(event_id, 1, 4) = 'evt_'),
  CHECK (length(type) BETWEEN 1 AND 128),
  CHECK (livemode IN (0, 1)),
  CHECK (object_id IS NULL OR length(object_id) BETWEEN 1 AND 255),
  CHECK (outcome IN ('received', 'credited', 'ignored', 'deferred', 'unsupported')),
  CHECK (outcome_detail IS NULL OR length(outcome_detail) BETWEEN 1 AND 64),
  CHECK ((outcome = 'received') = (settled_at IS NULL))
);

CREATE INDEX stripe_events_outcome ON stripe_events (outcome, received_at);
