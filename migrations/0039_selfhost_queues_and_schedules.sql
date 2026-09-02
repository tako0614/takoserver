-- Where a self-hosted machine keeps the messages a queue promises to deliver,
-- and the next instant a cron trigger is due.
--
-- Cloudflare sells a queue and a scheduler as services, so the managed backend
-- only has to name them. A machine standing on its own has to be them, and
-- until now `AtLeastOnceQueue` was a name with nothing behind it and
-- `WorkerCronTrigger` a recorded declaration nothing fired.
--
-- Both tables are runtime state, not desired state. What a Worker declares —
-- which queue it consumes, with which limits, on which schedule — lives in the
-- provider's own durable script state beside the Worker it belongs to. These
-- rows are what has actually happened: which messages are still owed, how many
-- times each has been delivered, and when a trigger last came due.

-- Messages are keyed by the queue id the provider derives from the Resource,
-- never by a customer-chosen string, so two tenants cannot collide and a
-- Worker can only reach the queues its own Version declared.
--
-- `deliveries` counts deliveries already made, so the attempt number a handler
-- sees is one more. The Form counts REDELIVERIES: a message is delivered at
-- most 1 + maxRetries times, and one that exhausts them moves to the
-- dead-letter queue as a NEW message there — new identity, new acceptance
-- timestamp, and its own count starting again.
--
-- `visible_at_ms` is when the message may next be delivered: a queue's own
-- delivery delay at acceptance, a consumer's retry delay after a refusal, or a
-- delay the handler asked for. `expires_at_ms` is acceptance plus the queue's
-- retention, stored as an absolute instant rather than a TTL because a row
-- that outlives a restart must not have its clock restarted with the process.
CREATE TABLE selfhost_queue_messages (
  queue_id TEXT NOT NULL CHECK (length(queue_id) BETWEEN 1 AND 512),
  message_id TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 128),
  body BLOB NOT NULL CHECK (length(body) <= 127000),
  enqueued_at_ms INTEGER NOT NULL CHECK (enqueued_at_ms > 0),
  visible_at_ms INTEGER NOT NULL CHECK (visible_at_ms > 0),
  expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > 0),
  deliveries INTEGER NOT NULL DEFAULT 0 CHECK (deliveries BETWEEN 0 AND 101),
  -- An in-flight batch owns its messages until the lease expires. The token
  -- fences a delivery that completes after that: it settles the batch it was
  -- handed or nothing, never the batch that took the message next.
  lease_token TEXT CHECK (lease_token IS NULL OR length(lease_token) BETWEEN 1 AND 128),
  lease_expires_at_ms INTEGER CHECK (lease_expires_at_ms IS NULL OR lease_expires_at_ms > 0),
  PRIMARY KEY (queue_id, message_id)
);

-- The pump asks one question of this table — "what is due on this queue" — and
-- the sweep asks the other.
CREATE INDEX selfhost_queue_messages_ready ON selfhost_queue_messages (queue_id, visible_at_ms);
CREATE INDEX selfhost_queue_messages_expiry ON selfhost_queue_messages (expires_at_ms);

-- One row per attached trigger, keyed by the script and the exact expression,
-- because the expression is the trigger's own durable identity.
--
-- `next_fire_at_ms` is what survives a restart: without it a process that came
-- back at 12:05 would have no way to tell a match it already fired from one it
-- has not. `running_until_ms` is the single-flight lease — the Form says a host
-- that could not fire a match because the previous invocation was still
-- running skips it rather than firing late.
CREATE TABLE selfhost_worker_schedules (
  script TEXT NOT NULL CHECK (length(script) BETWEEN 1 AND 128),
  cron TEXT NOT NULL CHECK (length(cron) BETWEEN 1 AND 256),
  next_fire_at_ms INTEGER NOT NULL CHECK (next_fire_at_ms > 0),
  running_until_ms INTEGER CHECK (running_until_ms IS NULL OR running_until_ms > 0),
  last_fired_at_ms INTEGER CHECK (last_fired_at_ms IS NULL OR last_fired_at_ms > 0),
  PRIMARY KEY (script, cron)
);
