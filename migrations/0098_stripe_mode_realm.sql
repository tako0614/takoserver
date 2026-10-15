-- Pin a durable deployment-wide Stripe realm. Runtime source-claiming is
-- allowed only for a genuinely fresh wallet/Stripe history; see
-- src/stripe-mode-realm.ts. This row is intentionally inserted by runtime,
-- not inferred from Stripe IDs or event livemode values.
CREATE TABLE stripe_mode_realm (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  pinned_at TEXT NOT NULL
);

CREATE TRIGGER stripe_mode_realm_no_update BEFORE UPDATE ON stripe_mode_realm
BEGIN
  SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable');
END;

CREATE TRIGGER stripe_mode_realm_no_delete BEFORE DELETE ON stripe_mode_realm
BEGIN
  SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable');
END;
