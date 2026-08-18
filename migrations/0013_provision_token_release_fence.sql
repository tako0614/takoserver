-- A provision-token redemption owns the reservation's hold from the instant
-- the single-use credential is consumed. Keep that fact separately from the
-- generic replay cache: a replay entry may expire, but a live resource must
-- never become releasable merely because its credential did.
--
-- One reservation buys exactly one resource. The unique reservation index
-- also closes the case where a reseller mints two valid tokens before either
-- one is redeemed.
CREATE TABLE provision_token_consumptions (
  token_id TEXT PRIMARY KEY NOT NULL,
  organization_id TEXT NOT NULL,
  tenant_ref TEXT NOT NULL,
  reservation_id TEXT NOT NULL UNIQUE,
  offering_id TEXT NOT NULL,
  offering_digest TEXT NOT NULL,
  expires_at_epoch_seconds INTEGER NOT NULL,
  consumed_at_epoch_seconds INTEGER NOT NULL,
  CHECK (length(token_id) BETWEEN 3 AND 256),
  CHECK (length(organization_id) BETWEEN 3 AND 256),
  CHECK (length(tenant_ref) BETWEEN 3 AND 256),
  CHECK (length(reservation_id) BETWEEN 3 AND 256),
  CHECK (length(offering_id) BETWEEN 3 AND 256),
  CHECK (
    substr(offering_digest, 1, 7) = 'sha256:' AND
    length(offering_digest) = 71 AND
    substr(offering_digest, 8) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (expires_at_epoch_seconds > consumed_at_epoch_seconds),
  CHECK (consumed_at_epoch_seconds >= 0)
);

CREATE INDEX provision_token_consumptions_terminal_cleanup
  ON provision_token_consumptions (expires_at_epoch_seconds, reservation_id);
