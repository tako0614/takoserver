-- Shared Queue message custody for self-host and Host-owned managed runtimes.
--
-- `selfhost_queue_messages` is the existing public message ledger. Its name is
-- historical: migration 0040 already owns durable admission, visibility,
-- retention, attempts and leases, so a managed runtime must extend that ledger
-- rather than create a private second lifecycle authority.
--
-- A Consumer generation is separate from its Queue. Retiring or deleting a
-- Consumer prevents new claims but preserves producers and backlog. Each claim
-- snapshots the exact generation and retry/dead-letter policy which owns its
-- lease; a later generation cannot reinterpret an old in-flight delivery.

CREATE TABLE queue_consumer_custody (
  queue_id TEXT PRIMARY KEY NOT NULL CHECK (length(queue_id) BETWEEN 1 AND 512),
  consumer_id TEXT NOT NULL CHECK (length(consumer_id) BETWEEN 1 AND 512),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  state TEXT NOT NULL CHECK (state IN ('active', 'retiring', 'tombstone')),
  max_retries INTEGER NOT NULL CHECK (max_retries BETWEEN 0 AND 100),
  retry_delay_seconds INTEGER NOT NULL CHECK (retry_delay_seconds BETWEEN 0 AND 43200),
  dead_letter_queue_id TEXT
    CHECK (dead_letter_queue_id IS NULL OR length(dead_letter_queue_id) BETWEEN 1 AND 512),
  dead_letter_delivery_delay_seconds INTEGER
    CHECK (
      dead_letter_delivery_delay_seconds IS NULL OR
      dead_letter_delivery_delay_seconds BETWEEN 0 AND 43200
    ),
  dead_letter_retention_seconds INTEGER
    CHECK (
      dead_letter_retention_seconds IS NULL OR
      dead_letter_retention_seconds BETWEEN 60 AND 1209600
    ),
  retirement_started_at_ms INTEGER
    CHECK (retirement_started_at_ms IS NULL OR retirement_started_at_ms > 0),
  CHECK (
    (dead_letter_queue_id IS NULL AND
     dead_letter_delivery_delay_seconds IS NULL AND
     dead_letter_retention_seconds IS NULL) OR
    (dead_letter_queue_id IS NOT NULL AND
     dead_letter_delivery_delay_seconds IS NOT NULL AND
     dead_letter_retention_seconds IS NOT NULL AND
     dead_letter_queue_id <> queue_id)
  ),
  CHECK (
    (state = 'active' AND retirement_started_at_ms IS NULL) OR
    (state = 'retiring' AND retirement_started_at_ms IS NOT NULL) OR
    state = 'tombstone'
  )
);

ALTER TABLE selfhost_queue_messages
  ADD COLUMN lease_consumer_id TEXT
  CHECK (lease_consumer_id IS NULL OR length(lease_consumer_id) BETWEEN 1 AND 512);

ALTER TABLE selfhost_queue_messages
  ADD COLUMN lease_generation INTEGER
  CHECK (lease_generation IS NULL OR lease_generation BETWEEN 1 AND 9007199254740991);

ALTER TABLE selfhost_queue_messages
  ADD COLUMN lease_max_retries INTEGER
  CHECK (lease_max_retries IS NULL OR lease_max_retries BETWEEN 0 AND 100);

ALTER TABLE selfhost_queue_messages
  ADD COLUMN lease_retry_delay_seconds INTEGER
  CHECK (lease_retry_delay_seconds IS NULL OR lease_retry_delay_seconds BETWEEN 0 AND 43200);

ALTER TABLE selfhost_queue_messages
  ADD COLUMN lease_dead_letter_queue_id TEXT
  CHECK (
    lease_dead_letter_queue_id IS NULL OR
    length(lease_dead_letter_queue_id) BETWEEN 1 AND 512
  );

ALTER TABLE selfhost_queue_messages
  ADD COLUMN lease_dead_letter_delivery_delay_seconds INTEGER
  CHECK (
    lease_dead_letter_delivery_delay_seconds IS NULL OR
    lease_dead_letter_delivery_delay_seconds BETWEEN 0 AND 43200
  );

ALTER TABLE selfhost_queue_messages
  ADD COLUMN lease_dead_letter_retention_seconds INTEGER
  CHECK (
    lease_dead_letter_retention_seconds IS NULL OR
    lease_dead_letter_retention_seconds BETWEEN 60 AND 1209600
  );

CREATE INDEX selfhost_queue_messages_custody_lease
  ON selfhost_queue_messages
    (queue_id, lease_consumer_id, lease_generation, lease_expires_at_ms);
