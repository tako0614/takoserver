-- An operation key and its deterministic preparation ID can be reused after
-- an undispatched handoff is revoked. The integer fence also resets when the
-- replacement row is inserted. Retain the value-free sealing nonce as the
-- exact lease generation after dispatch erases the sealed payload and nonce,
-- so a stale dispatch/settle acknowledgement can never adopt a replacement.
-- Historical dispatched rows have no recoverable nonce and stay NULL; an
-- ambiguous acknowledgement or recovery for them must fail closed.
ALTER TABLE worker_runtime_input_preparations
  ADD COLUMN lease_generation TEXT CHECK (
    lease_generation IS NULL OR
    (length(lease_generation) = 16 AND
     lease_generation NOT GLOB '*[^A-Za-z0-9_-]*')
  );

-- Live material still carries its exact nonce. This also makes migration
-- safe for a deployment that has prepared/claimed rows at the transition.
UPDATE worker_runtime_input_preparations
SET lease_generation = seal_nonce
WHERE state IN ('prepared', 'claimed') AND seal_nonce IS NOT NULL;
