-- The reseller lane: quote, reserve, capture or release.
--
-- A reseller's customer is identified only by an opaque `tenant_ref`. No
-- upstream user, workspace, or session identity is accepted or stored, so
-- Takoserver cannot become a directory of somebody else's customers.
--
-- Money is not held here; the ledger owns that. These tables record what was
-- offered and what state the reservation is in, and the reservation id is the
-- ledger reference that ties the two together.

CREATE TABLE quotes (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  meter TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (quantity > 0),
  CHECK (amount_minor >= 0),
  CHECK (
    substr(offering_digest, 1, 7) = 'sha256:' AND
    length(offering_digest) = 71 AND
    substr(offering_digest, 8) NOT GLOB '*[^0-9a-f]*'
  )
);

CREATE INDEX quotes_org ON quotes (org_id, tenant_ref);

CREATE TABLE reservations (
  id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  quote_id TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  quantity INTEGER NOT NULL,
  amount_minor INTEGER NOT NULL,
  meter TEXT NOT NULL,
  status TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (quote_id),
  CHECK (status IN ('active', 'captured', 'released', 'expired')),
  CHECK (amount_minor >= 0)
);

CREATE INDEX reservations_org ON reservations (org_id, tenant_ref);
CREATE INDEX reservations_expiry ON reservations (status, expires_at);

CREATE TABLE usage_statements (
  reservation_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  offering_id TEXT NOT NULL,
  meter TEXT NOT NULL,
  quantity REAL NOT NULL,
  amount_minor INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  CHECK (quantity >= 0),
  CHECK (amount_minor >= 0)
);

-- Metered data-plane usage. One row per request, deduplicated by request id, so
-- a retried request is charged once. `rollup_id` marks the rows already folded
-- into a ledger debit.
CREATE TABLE usage_events (
  request_id TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  meter TEXT NOT NULL,
  quantity REAL NOT NULL,
  amount_minor INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  rollup_id TEXT,
  CHECK (quantity >= 0),
  CHECK (amount_minor >= 0)
);

CREATE INDEX usage_events_unrolled ON usage_events (org_id, rollup_id);

-- Control-plane idempotency for the commands that are not naturally idempotent
-- through a ledger reference.
CREATE TABLE idempotency (
  scope_key TEXT PRIMARY KEY NOT NULL,
  fingerprint TEXT NOT NULL,
  status INTEGER NOT NULL,
  body_json TEXT,
  expires_at INTEGER NOT NULL,
  CHECK (status BETWEEN 100 AND 599),
  CHECK (expires_at >= 0)
);

CREATE INDEX idempotency_expiry ON idempotency (expires_at);
