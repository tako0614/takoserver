-- Durable wake markers for Queue custody dead-letter transfers.
--
-- A marker records only the exact source Consumer generation, destination
-- Queue identity and the new DLQ message id. It carries no payload or
-- transport endpoint: a private caller resolves the destination through its
-- own authority, wakes it, then acknowledges this marker by CAS on the token.
-- One row per source generation and target coalesces repeated transfers while
-- retaining the newest token. There are intentionally no foreign keys to
-- Queue rows, so source expiry or Queue housekeeping cannot erase an
-- unacknowledged destination wake.

CREATE TABLE queue_custody_transfer_notices (
  source_queue_id TEXT NOT NULL CHECK (length(source_queue_id) BETWEEN 1 AND 512),
  source_consumer_id TEXT NOT NULL CHECK (length(source_consumer_id) BETWEEN 1 AND 512),
  source_generation INTEGER NOT NULL CHECK (source_generation BETWEEN 1 AND 9007199254740991),
  target_queue_id TEXT NOT NULL CHECK (length(target_queue_id) BETWEEN 1 AND 512),
  notice_token TEXT NOT NULL CHECK (length(notice_token) BETWEEN 1 AND 128),
  PRIMARY KEY (source_queue_id, source_consumer_id, source_generation, target_queue_id)
);
