-- Preparation schema only. After the independently qualified 0092 baseline,
-- this table can be separately reviewed and applied before an operator seeds
-- exact, protected provenance/disposition evidence for non-purchased lots.
-- This migration does not alter a wallet amount or authorize a unit cutover.

CREATE TABLE wallet_credit_lot_classification_proofs (
  org_id TEXT NOT NULL,
  ref TEXT NOT NULL,
  original_kind TEXT NOT NULL,
  original_amount_minor INTEGER NOT NULL,
  original_expires_at TEXT,
  consumption_class TEXT NOT NULL,
  evidence_ref TEXT NOT NULL,
  reviewed_at TEXT NOT NULL,
  PRIMARY KEY (org_id, ref),
  CHECK (original_kind IN ('direct', 'plan-included')),
  CHECK (consumption_class IN ('free', 'subscription', 'purchased')),
  CHECK (original_amount_minor > 0),
  CHECK (length(evidence_ref) BETWEEN 16 AND 512),
  CHECK (length(reviewed_at) > 0)
);
