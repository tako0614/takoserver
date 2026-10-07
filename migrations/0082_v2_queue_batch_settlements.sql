-- Source-only Queue batch settlement evidence. The existing message/lease row
-- remains the delivery authority; this table binds one Host-assigned batch ID
-- to its exact claimed leases and retains terminal evidence after ACK deletes
-- a message or retry clears its lease. It is not a Resource/Operation ledger.
CREATE TABLE queue_v2_batch_settlements (
  batch_id TEXT NOT NULL CHECK (length(CAST(batch_id AS BLOB)) BETWEEN 1 AND 256),
  queue_id TEXT NOT NULL CHECK (length(queue_id) BETWEEN 1 AND 512),
  consumer_id TEXT NOT NULL CHECK (length(consumer_id) BETWEEN 1 AND 512),
  generation INTEGER NOT NULL CHECK (generation BETWEEN 1 AND 9007199254740991),
  lease_token TEXT NOT NULL CHECK (length(lease_token) BETWEEN 1 AND 128),
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 128),
  attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 101),
  max_retries INTEGER NOT NULL CHECK (max_retries BETWEEN 0 AND 100),
  retry_delay_seconds INTEGER NOT NULL CHECK (retry_delay_seconds BETWEEN 0 AND 43200),
  dead_letter_queue_id TEXT,
  dead_letter_delivery_delay_seconds INTEGER,
  dead_letter_retention_seconds INTEGER,
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'settling', 'settled')),
  outcome TEXT CHECK (outcome IS NULL OR outcome IN ('ack', 'retry')),
  delay_seconds INTEGER CHECK (delay_seconds IS NULL OR delay_seconds BETWEEN 0 AND 43200),
  settlement_token TEXT CHECK (
    settlement_token IS NULL OR length(settlement_token) BETWEEN 1 AND 128
  ),
  settled_at_ms INTEGER CHECK (settled_at_ms IS NULL OR settled_at_ms > 0),
  dead_letter_message_id TEXT CHECK (
    dead_letter_message_id IS NULL OR length(dead_letter_message_id) BETWEEN 1 AND 128
  ),
  PRIMARY KEY (batch_id, message_id),
  UNIQUE (queue_id, message_id, lease_token),
  CHECK (
    (dead_letter_queue_id IS NULL AND dead_letter_delivery_delay_seconds IS NULL
      AND dead_letter_retention_seconds IS NULL) OR
    (dead_letter_queue_id IS NOT NULL AND dead_letter_delivery_delay_seconds IS NOT NULL
      AND dead_letter_retention_seconds IS NOT NULL)
  ),
  CHECK (
    (state = 'pending' AND outcome IS NULL AND delay_seconds IS NULL
      AND settlement_token IS NULL AND settled_at_ms IS NULL
      AND dead_letter_message_id IS NULL) OR
    (state IN ('settling', 'settled') AND outcome IS NOT NULL
      AND settlement_token IS NOT NULL AND settled_at_ms IS NOT NULL
      AND ((outcome = 'ack' AND delay_seconds IS NULL AND dead_letter_message_id IS NULL) OR
           (outcome = 'retry' AND delay_seconds IS NOT NULL)))
  )
);

-- Registration is all-or-none through Sql.batch before customer JS receives
-- the batch. An expired, reclaimed or reinterpreted claim cannot be bound.
CREATE TRIGGER queue_v2_batch_register_guard
BEFORE INSERT ON queue_v2_batch_settlements
WHEN NEW.state <> 'pending' OR
  EXISTS (
    SELECT 1 FROM queue_v2_batch_settlements prior
    WHERE (prior.batch_id = NEW.batch_id AND prior.message_id = NEW.message_id)
       OR (prior.queue_id = NEW.queue_id AND prior.message_id = NEW.message_id
         AND prior.lease_token = NEW.lease_token)
  ) OR
  EXISTS (
    SELECT 1 FROM queue_v2_batch_settlements prior
    WHERE prior.batch_id = NEW.batch_id AND
      (prior.queue_id <> NEW.queue_id OR prior.consumer_id <> NEW.consumer_id OR
       prior.generation <> NEW.generation OR prior.lease_token <> NEW.lease_token)
  ) OR NOT EXISTS (
    SELECT 1 FROM selfhost_queue_messages message
    JOIN queue_consumer_custody consumer ON consumer.queue_id = message.queue_id
    WHERE message.queue_id = NEW.queue_id AND message.message_id = NEW.message_id
      AND message.lease_token = NEW.lease_token
      AND message.lease_consumer_id = NEW.consumer_id
      AND message.lease_generation = NEW.generation
      AND message.lease_expires_at_ms >
        (CAST(strftime('%s', 'now') AS INTEGER) * 1000
         + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))
      AND message.deliveries = NEW.attempts
      AND message.lease_max_retries = NEW.max_retries
      AND message.lease_retry_delay_seconds = NEW.retry_delay_seconds
      AND message.lease_dead_letter_queue_id IS NEW.dead_letter_queue_id
      AND message.lease_dead_letter_delivery_delay_seconds
          IS NEW.dead_letter_delivery_delay_seconds
      AND message.lease_dead_letter_retention_seconds IS NEW.dead_letter_retention_seconds
      AND consumer.consumer_id = NEW.consumer_id AND consumer.generation = NEW.generation
      AND consumer.state IN ('active', 'retiring')
  )
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_claim_unavailable');
END;

CREATE TRIGGER queue_v2_batch_identity_immutable
BEFORE UPDATE ON queue_v2_batch_settlements
WHEN OLD.batch_id IS NOT NEW.batch_id OR OLD.queue_id IS NOT NEW.queue_id OR
  OLD.consumer_id IS NOT NEW.consumer_id OR OLD.generation IS NOT NEW.generation OR
  OLD.lease_token IS NOT NEW.lease_token OR OLD.message_id IS NOT NEW.message_id OR
  OLD.attempts IS NOT NEW.attempts OR OLD.max_retries IS NOT NEW.max_retries OR
  OLD.retry_delay_seconds IS NOT NEW.retry_delay_seconds OR
  OLD.dead_letter_queue_id IS NOT NEW.dead_letter_queue_id OR
  OLD.dead_letter_delivery_delay_seconds IS NOT NEW.dead_letter_delivery_delay_seconds OR
  OLD.dead_letter_retention_seconds IS NOT NEW.dead_letter_retention_seconds
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_identity_immutable');
END;

CREATE TRIGGER queue_v2_batch_no_same_state_update
BEFORE UPDATE ON queue_v2_batch_settlements
WHEN OLD.state = NEW.state
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_receipt_immutable');
END;

CREATE TRIGGER queue_v2_batch_transition_guard
BEFORE UPDATE OF state ON queue_v2_batch_settlements
WHEN NOT (
  (OLD.state = 'pending' AND NEW.state = 'settling'
    AND (
      (NEW.outcome = 'retry' AND OLD.attempts >= 1 + OLD.max_retries
        AND OLD.dead_letter_queue_id IS NOT NULL AND NEW.dead_letter_message_id IS NOT NULL)
      OR ((NEW.outcome = 'ack' OR OLD.attempts < 1 + OLD.max_retries
        OR OLD.dead_letter_queue_id IS NULL) AND NEW.dead_letter_message_id IS NULL)
    ) AND EXISTS (
    SELECT 1 FROM selfhost_queue_messages message
    JOIN queue_consumer_custody consumer ON consumer.queue_id = message.queue_id
    WHERE message.queue_id = OLD.queue_id AND message.message_id = OLD.message_id
      AND message.lease_token = OLD.lease_token
      AND message.lease_consumer_id = OLD.consumer_id
      AND message.lease_generation = OLD.generation
      AND message.lease_expires_at_ms >
        (CAST(strftime('%s', 'now') AS INTEGER) * 1000
         + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))
      AND message.deliveries = OLD.attempts
      AND message.lease_max_retries = OLD.max_retries
      AND message.lease_retry_delay_seconds = OLD.retry_delay_seconds
      AND message.lease_dead_letter_queue_id IS OLD.dead_letter_queue_id
      AND message.lease_dead_letter_delivery_delay_seconds
          IS OLD.dead_letter_delivery_delay_seconds
      AND message.lease_dead_letter_retention_seconds IS OLD.dead_letter_retention_seconds
      AND consumer.consumer_id = OLD.consumer_id AND consumer.generation = OLD.generation
      AND consumer.state IN ('active', 'retiring')
  )) OR
  (OLD.state = 'settling' AND NEW.state = 'settled'
    AND NEW.outcome = OLD.outcome AND NEW.delay_seconds IS OLD.delay_seconds
    AND NEW.settlement_token = OLD.settlement_token
    AND NEW.settled_at_ms = OLD.settled_at_ms
    AND NEW.dead_letter_message_id IS OLD.dead_letter_message_id
    AND (
      ((OLD.outcome = 'ack' OR OLD.attempts >= 1 + OLD.max_retries)
        AND NOT EXISTS (
          SELECT 1 FROM selfhost_queue_messages message
          WHERE message.queue_id = OLD.queue_id AND message.message_id = OLD.message_id
        )
        AND (OLD.dead_letter_message_id IS NULL OR (
          EXISTS (
            SELECT 1 FROM selfhost_queue_messages dlq
            WHERE dlq.queue_id = OLD.dead_letter_queue_id
              AND dlq.message_id = OLD.dead_letter_message_id
          ) AND EXISTS (
            SELECT 1 FROM queue_custody_transfer_notices notice
            WHERE notice.source_queue_id = OLD.queue_id
              AND notice.source_consumer_id = OLD.consumer_id
              AND notice.source_generation = OLD.generation
              AND notice.target_queue_id = OLD.dead_letter_queue_id
              AND notice.notice_token = OLD.dead_letter_message_id
          )
        ))) OR
      (OLD.outcome = 'retry' AND OLD.attempts < 1 + OLD.max_retries
        AND EXISTS (
          SELECT 1 FROM selfhost_queue_messages message
          WHERE message.queue_id = OLD.queue_id AND message.message_id = OLD.message_id
            AND message.lease_token IS NULL AND message.deliveries = OLD.attempts
            AND message.visible_at_ms = OLD.settled_at_ms + OLD.delay_seconds * 1000
        ))
    ))
)
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_transition_unconfirmed');
END;

CREATE TRIGGER queue_v2_batch_no_delete
BEFORE DELETE ON queue_v2_batch_settlements
BEGIN
  SELECT RAISE(ABORT, 'queue_v2_batch_receipt_immutable');
END;
