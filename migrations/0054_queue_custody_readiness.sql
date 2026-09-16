-- Bounded scheduling and maintenance lookup for shared Queue custody.
--
-- Equality on queue identity plus NULL lease ownership selects only unleased
-- rows. Visibility is the ordered suffix, so a fixed LIMIT bounds index entries
-- visited instead of filtering retention, retry count or lease state after an
-- older queue-wide visibility scan.

CREATE INDEX selfhost_queue_messages_custody_ready
  ON selfhost_queue_messages (queue_id, lease_token, visible_at_ms);
