-- Cancellation is a different direction from capture.  Persist its phase and
-- the exact ledger release reference so a lost release acknowledgement can be
-- retried without ever sending the intent through the capture path.

ALTER TABLE reseller_settlement_intents
  ADD COLUMN settlement_direction TEXT NOT NULL DEFAULT 'capture'
  CHECK (settlement_direction IN ('capture', 'cancel'));

ALTER TABLE reseller_settlement_intents
  ADD COLUMN cancellation_phase TEXT NOT NULL DEFAULT 'none'
  CHECK (cancellation_phase IN ('none', 'release_pending', 'release_succeeded', 'finalized'));

ALTER TABLE reseller_settlement_intents
  ADD COLUMN cancellation_release_reference TEXT
  CHECK (
    cancellation_release_reference IS NULL OR
    length(cancellation_release_reference) BETWEEN 1 AND 256
  );

ALTER TABLE reseller_settlement_intents
  ADD COLUMN cancellation_receipt TEXT
  CHECK (
    cancellation_receipt IS NULL OR
    length(cancellation_receipt) BETWEEN 1 AND 256
  );

-- Cancellation may be initiated by an operator release or by the expiry
-- sweeper. Keep that direction durable so a restart cannot turn an expired
-- reservation into a merely released one (or vice versa).
ALTER TABLE reseller_settlement_intents
  ADD COLUMN desired_terminal_status TEXT NOT NULL DEFAULT 'released'
  CHECK (desired_terminal_status IN ('released', 'expired'));

UPDATE reseller_settlement_intents
SET desired_terminal_status = 'released'
WHERE desired_terminal_status IS NULL;

CREATE INDEX reseller_settlement_cancellation_due
  ON reseller_settlement_intents (
    settlement_direction,
    cancellation_phase,
    state,
    lease_until,
    updated_at
  );
