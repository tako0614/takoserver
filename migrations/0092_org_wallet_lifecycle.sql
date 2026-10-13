-- Additive lifecycle; existing wallet history and credit lots stay intact.
-- Stable opaque pagination handles cover arbitrarily long legacy references
-- without publishing SQLite rowids or counters shared across Organizations.
ALTER TABLE wallet_credit_lots ADD COLUMN cursor_handle TEXT
  CHECK (cursor_handle IS NULL OR
    (length(cursor_handle) = 32 AND cursor_handle NOT GLOB '*[^0-9a-f]*'));
UPDATE wallet_credit_lots SET cursor_handle = lower(hex(randomblob(16)));
CREATE UNIQUE INDEX wallet_credit_lots_cursor
  ON wallet_credit_lots (org_id, cursor_handle);
CREATE TRIGGER wallet_credit_lots_cursor_insert AFTER INSERT ON wallet_credit_lots
WHEN NEW.cursor_handle IS NULL
BEGIN
  UPDATE wallet_credit_lots SET cursor_handle = lower(hex(randomblob(16)))
    WHERE org_id = NEW.org_id AND ref = NEW.ref;
END;
CREATE TRIGGER wallet_credit_lots_cursor_immutable BEFORE UPDATE OF cursor_handle ON wallet_credit_lots
WHEN OLD.cursor_handle IS NOT NULL AND NEW.cursor_handle IS NOT OLD.cursor_handle
BEGIN
  SELECT RAISE(ABORT, 'wallet lot cursor is immutable');
END;

CREATE TABLE org_wallet_holds (
  org_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  ledger_ref TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  fingerprint TEXT,
  pricing_revision TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  state TEXT NOT NULL CHECK (state IN ('live', 'captured', 'released', 'expired')),
  captured_minor INTEGER NOT NULL DEFAULT 0 CHECK (captured_minor >= 0),
  released_minor INTEGER NOT NULL DEFAULT 0 CHECK (released_minor >= 0),
  capture_fingerprint TEXT,
  actual_micros TEXT,
  closed_at TEXT,
  PRIMARY KEY (org_id, ref),
  UNIQUE (org_id, ledger_ref),
  CHECK (captured_minor + released_minor <= amount_minor),
  CHECK ((state = 'live' AND closed_at IS NULL AND expires_at IS NOT NULL
          AND captured_minor = 0 AND released_minor = 0)
      OR (state <> 'live' AND closed_at IS NOT NULL
          AND captured_minor + released_minor = amount_minor))
);
CREATE INDEX org_wallet_holds_expiry ON org_wallet_holds (org_id, state, expires_at, ref);
CREATE INDEX org_wallet_holds_sweep ON org_wallet_holds (state, expires_at, org_id, ref);

-- Unpaid already-consumed usage is durable without an implicit negative wallet.
CREATE TABLE org_wallet_usage_records (
  org_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  pricing_revision TEXT NOT NULL,
  meter TEXT NOT NULL,
  quantity TEXT NOT NULL,
  quantity_unit TEXT NOT NULL,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  rate_numerator_micros TEXT NOT NULL,
  rate_denominator TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  state TEXT NOT NULL CHECK (state IN ('pending', 'paid')),
  created_at TEXT NOT NULL,
  paid_at TEXT,
  PRIMARY KEY (org_id, ref),
  CHECK ((state = 'pending' AND paid_at IS NULL) OR (state = 'paid' AND paid_at IS NOT NULL))
);
CREATE INDEX org_wallet_usage_pending ON org_wallet_usage_records (org_id, state, created_at, ref);

CREATE TABLE org_wallet_grant_snapshots (
  org_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  pricing_revision TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, ref)
);

-- A revision is immutable and retired tariffs remain available for delayed usage.
CREATE TABLE org_wallet_pricing_revisions (
  revision TEXT PRIMARY KEY NOT NULL,
  effective_at TEXT NOT NULL UNIQUE,
  config_json TEXT NOT NULL CHECK (json_valid(config_json))
);
CREATE TABLE org_wallet_monthly_tariffs (
  month TEXT PRIMARY KEY NOT NULL,
  pricing_revision TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor >= 0),
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
