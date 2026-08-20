-- Credit expiry cannot be reconstructed from the predecessor append-only
-- ledger: those rows never recorded which funds were included, purchased, or
-- direct. TASK-0030 therefore requires the reviewed private snapshot + reset
-- cutover. Refuse an in-place migration with any money history rather than
-- silently turning an existing balance into the wrong lot semantics.
CREATE TABLE wallet_credit_reset_guard (
  singleton INTEGER PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

INSERT INTO wallet_credit_reset_guard (singleton, valid)
SELECT 1, CASE WHEN EXISTS (SELECT 1 FROM ledger LIMIT 1) THEN 0 ELSE 1 END;

DROP TABLE wallet_credit_reset_guard;

CREATE TABLE wallet_credit_lots (
  org_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  kind TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  expires_at TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, ref),
  CHECK (kind IN ('direct', 'plan-included', 'purchased'))
);

CREATE TABLE wallet_credit_allocations (
  org_id TEXT NOT NULL,
  debit_type TEXT NOT NULL,
  debit_ref TEXT NOT NULL,
  lot_ref TEXT NOT NULL,
  amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
  created_at TEXT NOT NULL,
  PRIMARY KEY (org_id, debit_type, debit_ref, lot_ref),
  FOREIGN KEY (org_id, lot_ref) REFERENCES wallet_credit_lots(org_id, ref),
  CHECK (debit_type IN ('hold', 'capture', 'usage_debit'))
);

CREATE INDEX wallet_credit_lots_expiry
  ON wallet_credit_lots (org_id, expires_at, created_at);

CREATE TABLE wallet_allocation_guards (
  id TEXT PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

-- A Hosted Workspace is deliberately opaque to Takoserver. The private
-- sponsorship service binds that opaque reference to the one legal
-- Organization projected from Takos ID. Hosted never gets a second wallet.
CREATE TABLE sponsorship_tenants (
  tenant_ref TEXT PRIMARY KEY NOT NULL,
  org_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(tenant_ref) BETWEEN 3 AND 256),
  CHECK (length(org_id) BETWEEN 1 AND 128)
);

-- Billing ownership is separate from the Takoform Resource. Switching a
-- Resource to direct billing updates this projection; it never rewrites the
-- Resource identity or moves provider state behind the caller's back.
CREATE TABLE sponsorship_resources (
  tenant_ref TEXT NOT NULL,
  resource_uid TEXT NOT NULL,
  billing_mode TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_ref, resource_uid),
  FOREIGN KEY (tenant_ref) REFERENCES sponsorship_tenants(tenant_ref),
  CHECK (billing_mode IN ('sponsored', 'direct')),
  CHECK (length(resource_uid) BETWEEN 3 AND 128)
);

CREATE INDEX sponsorship_resources_mode
  ON sponsorship_resources (tenant_ref, billing_mode, resource_uid);
