-- Usage is accumulated below the currency minor unit and rounded only when a
-- ledger roll-up is settled. The predecessor name said "minor" even though
-- the stored value was one millionth of a minor unit; make the durable name
-- match the money semantics before the on-demand catalog is published.
ALTER TABLE usage_events RENAME COLUMN amount_minor TO amount_micros;
