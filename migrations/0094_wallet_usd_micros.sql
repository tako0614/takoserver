-- USD-micro ledger cutover after separately qualified 0093 preparation.
-- Apply only with protected preimage, stopped money writers, reviewed lot
-- dispositions, and independent review. The runner uses one transaction;
-- guard failure rolls back all 0094 schema/data changes and is never retried blind.
-- Historical Stripe, reseller quote, and configuration cents stay cents.
-- The classification proof table must already exist from migration 0093.
CREATE TABLE money_cutover_guard (
  singleton INTEGER PRIMARY KEY NOT NULL,
  valid INTEGER NOT NULL CHECK (valid = 1)
);

-- Bounds are floor(MAX_SAFE_INTEGER / 10000) = 900719925474 cents.
-- INTEGER affinity and range CHECKs still admit REAL fractions in SQLite;
-- require actual integer storage before taking any sums or scaling a row.
-- SUM() also fails closed on SQLite integer overflow before conversion.
INSERT INTO money_cutover_guard (singleton, valid)
SELECT 1, CASE WHEN
  NOT EXISTS (SELECT 1 FROM org_wallet_holds WHERE state = 'live')
  AND NOT EXISTS (SELECT 1 FROM wallet_credit_allocations WHERE debit_type = 'hold')
  AND NOT EXISTS (SELECT 1 FROM org_wallet_usage_records WHERE state = 'pending')
  AND NOT EXISTS (SELECT 1 FROM reservations WHERE status = 'active')
  AND NOT EXISTS (SELECT 1 FROM reseller_settlement_intents
                  WHERE state IN ('pending', 'ready', 'recovery_required')
                     OR cancellation_phase IN ('release_pending', 'release_succeeded'))
  AND NOT EXISTS (SELECT 1 FROM usage_events WHERE rollup_id IS NULL)
  AND NOT EXISTS (SELECT 1 FROM idempotency
                  WHERE scope_key LIKE 'ai:%' AND status IN (100, 101, 102, 202))
  AND NOT EXISTS (SELECT 1 FROM stripe_events WHERE outcome IN ('received', 'deferred'))
  AND NOT EXISTS (
    SELECT 1 FROM wallet_credit_lots l
    LEFT JOIN wallet_credit_lot_classification_proofs p
      ON p.org_id = l.org_id AND p.ref = l.ref
    WHERE l.kind <> 'purchased' AND (
      p.ref IS NULL OR p.original_kind <> l.kind
      OR p.original_amount_minor <> l.amount_minor
      OR p.original_expires_at IS NOT l.expires_at
      OR (l.kind = 'plan-included' AND p.consumption_class = 'purchased')
    )
  )
  AND NOT EXISTS (
    SELECT 1 FROM wallet_credit_lot_classification_proofs p
    LEFT JOIN wallet_credit_lots l ON l.org_id = p.org_id AND l.ref = p.ref
    WHERE l.ref IS NULL OR l.kind = 'purchased'
  )
  AND NOT EXISTS (SELECT 1 FROM wallet_credit_lot_classification_proofs
                  WHERE typeof(original_amount_minor) <> 'integer'
                     OR original_amount_minor NOT BETWEEN 1 AND 900719925474)
  AND NOT EXISTS (SELECT 1 FROM ledger
                  WHERE typeof(settled_delta) <> 'integer'
                     OR typeof(held_delta) <> 'integer'
                     OR settled_delta NOT BETWEEN -900719925474 AND 900719925474
                     OR held_delta NOT BETWEEN -900719925474 AND 900719925474)
  AND NOT EXISTS (SELECT 1 FROM wallet_credit_lots
                  WHERE typeof(amount_minor) <> 'integer'
                     OR amount_minor NOT BETWEEN 1 AND 900719925474)
  AND NOT EXISTS (SELECT 1 FROM wallet_credit_allocations
                  WHERE typeof(amount_minor) <> 'integer'
                     OR amount_minor NOT BETWEEN 1 AND 900719925474)
  AND NOT EXISTS (SELECT 1 FROM org_wallet_holds
                  WHERE typeof(amount_minor) <> 'integer'
                     OR typeof(captured_minor) <> 'integer'
                     OR typeof(released_minor) <> 'integer'
                     OR amount_minor NOT BETWEEN 0 AND 900719925474
                     OR captured_minor NOT BETWEEN 0 AND 900719925474
                     OR released_minor NOT BETWEEN 0 AND 900719925474)
  AND NOT EXISTS (SELECT 1 FROM org_wallet_usage_records
                  WHERE typeof(amount_minor) <> 'integer'
                     OR amount_minor NOT BETWEEN 0 AND 900719925474)
  AND NOT EXISTS (SELECT 1 FROM org_wallet_grant_snapshots
                  WHERE typeof(amount_minor) <> 'integer'
                     OR amount_minor NOT BETWEEN 0 AND 900719925474)
  AND NOT EXISTS (SELECT 1 FROM org_wallet_monthly_tariffs
                  WHERE typeof(amount_minor) <> 'integer'
                     OR amount_minor NOT BETWEEN 0 AND 900719925474)
  AND NOT EXISTS (SELECT 1 FROM usage_events
                  WHERE typeof(amount_micros) <> 'integer'
                     OR amount_micros NOT BETWEEN 0 AND 9007199254740991)
  AND NOT EXISTS (
    SELECT 1 FROM ledger GROUP BY org_id, ref HAVING SUM(held_delta) <> 0
  )
  THEN 1 ELSE 0 END;

-- Refuse a damaged predecessor wallet rather than scaling its inconsistency.
INSERT INTO money_cutover_guard (singleton, valid)
SELECT 2, CASE WHEN
  NOT EXISTS (
    SELECT 1 FROM wallet_credit_lots l
    LEFT JOIN ledger f ON f.org_id = l.org_id AND f.type = 'funding' AND f.ref = l.ref
    WHERE f.id IS NULL OR f.settled_delta <> l.amount_minor OR f.held_delta <> 0
  )
  AND NOT EXISTS (
    SELECT 1 FROM ledger f
    LEFT JOIN wallet_credit_lots l ON l.org_id = f.org_id AND l.ref = f.ref
    WHERE f.type = 'funding' AND l.ref IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM wallet_credit_lots l
    WHERE COALESCE((SELECT SUM(a.amount_minor) FROM wallet_credit_allocations a
                    WHERE a.org_id = l.org_id AND a.lot_ref = l.ref), 0) > l.amount_minor
  )
  AND NOT EXISTS (
    SELECT 1 FROM wallet_credit_allocations a
    LEFT JOIN ledger d ON d.org_id = a.org_id
      AND d.type = a.debit_type AND d.ref = a.debit_ref
    WHERE d.id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1 FROM ledger d WHERE d.type IN ('capture', 'usage_debit')
      AND COALESCE((SELECT SUM(a.amount_minor) FROM wallet_credit_allocations a
                    WHERE a.org_id = d.org_id AND a.debit_type = d.type
                      AND a.debit_ref = d.ref), 0) <> -d.settled_delta
  )
  THEN 1 ELSE 0 END;

-- The old writer claimed rows by setting rollup_id before its separate ledger
-- debit. A claimed row is not proof of payment. Reconcile each actual claimed
-- group with the exact old nonnegative Math.round(microcents / 1,000,000)
-- behavior. JS summed safe integers exactly; ROUND on the same binary64
-- quotient has its positive-half rule. A pre-read/claim race can have charged
-- a different amount, and must be resolved from the protected old epoch.
-- SUM() overflow and a group total above JS safe integer fail closed.
INSERT INTO money_cutover_guard (singleton, valid)
SELECT 4, CASE WHEN NOT EXISTS (
  SELECT 1 FROM (
    SELECT org_id, rollup_id, total_microcents,
      CAST(ROUND(CAST(total_microcents AS REAL) / 1000000.0) AS INTEGER) AS expected_minor
    FROM (
      SELECT org_id, rollup_id, SUM(amount_micros) AS total_microcents
      FROM usage_events WHERE rollup_id IS NOT NULL
      GROUP BY org_id, rollup_id
    ) AS old_groups
  ) AS g
  LEFT JOIN ledger d ON d.org_id = g.org_id
    AND d.type = 'usage_debit' AND d.ref = g.rollup_id
  WHERE g.total_microcents NOT BETWEEN 0 AND 9007199254740991
    OR (g.expected_minor = 0 AND d.id IS NOT NULL)
    OR (g.expected_minor > 0 AND (
      d.id IS NULL OR d.settled_delta <> -g.expected_minor OR d.held_delta <> 0
      OR COALESCE((SELECT SUM(a.amount_minor) FROM wallet_credit_allocations a
                   WHERE a.org_id = g.org_id AND a.debit_type = 'usage_debit'
                     AND a.debit_ref = g.rollup_id), 0) <> g.expected_minor
    ))
) THEN 1 ELSE 0 END;

-- Keep exact row preimages and per-Organization sums as an auditable proof.
-- No funding/debit rows are fabricated to represent the unit conversion.
CREATE TABLE money_cutover_preimage (
  source_table TEXT NOT NULL,
  row_key TEXT NOT NULL,
  source_column TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  PRIMARY KEY (source_table, row_key, source_column)
);
CREATE TABLE money_cutover_aggregates (
  source_table TEXT NOT NULL,
  org_id TEXT NOT NULL,
  source_column TEXT NOT NULL,
  total_minor INTEGER NOT NULL,
  PRIMARY KEY (source_table, org_id, source_column)
);
INSERT INTO money_cutover_preimage
  SELECT 'ledger', id, 'settled_delta', settled_delta FROM ledger;
INSERT INTO money_cutover_aggregates
  SELECT 'ledger', org_id, 'settled_delta', SUM(settled_delta)
  FROM ledger GROUP BY org_id;
INSERT INTO money_cutover_preimage
  SELECT 'ledger', id, 'held_delta', held_delta FROM ledger;
INSERT INTO money_cutover_aggregates
  SELECT 'ledger', org_id, 'held_delta', SUM(held_delta)
  FROM ledger GROUP BY org_id;
INSERT INTO money_cutover_preimage
  SELECT 'wallet_credit_lots', json_array(org_id, ref), 'amount_minor', amount_minor FROM wallet_credit_lots;
INSERT INTO money_cutover_aggregates
  SELECT 'wallet_credit_lots', org_id, 'amount_minor', SUM(amount_minor)
  FROM wallet_credit_lots GROUP BY org_id;
INSERT INTO money_cutover_preimage
  SELECT 'wallet_credit_allocations', json_array(org_id, debit_type, debit_ref, lot_ref), 'amount_minor', amount_minor FROM wallet_credit_allocations;
INSERT INTO money_cutover_aggregates
  SELECT 'wallet_credit_allocations', org_id, 'amount_minor', SUM(amount_minor)
  FROM wallet_credit_allocations GROUP BY org_id;
INSERT INTO money_cutover_preimage
  SELECT 'org_wallet_holds', json_array(org_id, ref), 'amount_minor', amount_minor FROM org_wallet_holds;
INSERT INTO money_cutover_aggregates
  SELECT 'org_wallet_holds', org_id, 'amount_minor', SUM(amount_minor)
  FROM org_wallet_holds GROUP BY org_id;
INSERT INTO money_cutover_preimage
  SELECT 'org_wallet_holds', json_array(org_id, ref), 'captured_minor', captured_minor FROM org_wallet_holds;
INSERT INTO money_cutover_aggregates
  SELECT 'org_wallet_holds', org_id, 'captured_minor', SUM(captured_minor)
  FROM org_wallet_holds GROUP BY org_id;
INSERT INTO money_cutover_preimage
  SELECT 'org_wallet_holds', json_array(org_id, ref), 'released_minor', released_minor FROM org_wallet_holds;
INSERT INTO money_cutover_aggregates
  SELECT 'org_wallet_holds', org_id, 'released_minor', SUM(released_minor)
  FROM org_wallet_holds GROUP BY org_id;
INSERT INTO money_cutover_preimage
  SELECT 'org_wallet_usage_records', json_array(org_id, ref), 'amount_minor', amount_minor FROM org_wallet_usage_records;
INSERT INTO money_cutover_aggregates
  SELECT 'org_wallet_usage_records', org_id, 'amount_minor', SUM(amount_minor)
  FROM org_wallet_usage_records GROUP BY org_id;
INSERT INTO money_cutover_preimage
  SELECT 'org_wallet_grant_snapshots', json_array(org_id, ref), 'amount_minor', amount_minor FROM org_wallet_grant_snapshots;
INSERT INTO money_cutover_aggregates
  SELECT 'org_wallet_grant_snapshots', org_id, 'amount_minor', SUM(amount_minor)
  FROM org_wallet_grant_snapshots GROUP BY org_id;
INSERT INTO money_cutover_preimage
  SELECT 'org_wallet_monthly_tariffs', month, 'amount_minor', amount_minor FROM org_wallet_monthly_tariffs;
INSERT INTO money_cutover_aggregates
  SELECT 'org_wallet_monthly_tariffs', '*', 'amount_minor', SUM(amount_minor)
  FROM org_wallet_monthly_tariffs GROUP BY '*';

INSERT INTO money_cutover_guard (singleton, valid)
SELECT 3, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates
  WHERE total_minor NOT BETWEEN -900719925474 AND 900719925474
) THEN 1 ELSE 0 END;

ALTER TABLE wallet_credit_lots ADD COLUMN consumption_class TEXT
  CHECK (consumption_class IN ('free', 'subscription', 'purchased'));
UPDATE wallet_credit_lots SET consumption_class = CASE
  WHEN kind = 'purchased' THEN 'purchased'
  ELSE (SELECT p.consumption_class FROM wallet_credit_lot_classification_proofs p
        WHERE p.org_id = wallet_credit_lots.org_id AND p.ref = wallet_credit_lots.ref)
END;

ALTER TABLE ledger RENAME COLUMN settled_delta TO settled_delta_micros;
ALTER TABLE ledger RENAME COLUMN held_delta TO held_delta_micros;

ALTER TABLE wallet_credit_lots RENAME COLUMN amount_minor TO amount_micros;

ALTER TABLE wallet_credit_allocations RENAME COLUMN amount_minor TO amount_micros;

ALTER TABLE org_wallet_holds RENAME COLUMN amount_minor TO amount_micros;
ALTER TABLE org_wallet_holds RENAME COLUMN captured_minor TO captured_micros;
ALTER TABLE org_wallet_holds RENAME COLUMN released_minor TO released_micros;

ALTER TABLE org_wallet_usage_records RENAME COLUMN amount_minor TO amount_micros;

ALTER TABLE org_wallet_grant_snapshots RENAME COLUMN amount_minor TO amount_micros;

ALTER TABLE org_wallet_monthly_tariffs RENAME COLUMN amount_minor TO amount_micros;

UPDATE ledger SET settled_delta_micros = settled_delta_micros * 10000, held_delta_micros = held_delta_micros * 10000;
UPDATE wallet_credit_lots SET amount_micros = amount_micros * 10000;
UPDATE wallet_credit_allocations SET amount_micros = amount_micros * 10000;
UPDATE org_wallet_holds SET amount_micros = amount_micros * 10000, captured_micros = captured_micros * 10000, released_micros = released_micros * 10000;
UPDATE org_wallet_usage_records SET amount_micros = amount_micros * 10000;
UPDATE org_wallet_grant_snapshots SET amount_micros = amount_micros * 10000;
UPDATE org_wallet_monthly_tariffs SET amount_micros = amount_micros * 10000;

-- Existing receipt fingerprints and original decisions remain historical.
ALTER TABLE org_wallet_holds ADD COLUMN money_policy TEXT NOT NULL DEFAULT 'usd-cents-v1'
  CHECK (money_policy IN ('usd-cents-v1', 'usd-micros-v2'));
ALTER TABLE org_wallet_usage_records ADD COLUMN money_policy TEXT NOT NULL DEFAULT 'usd-cents-v1'
  CHECK (money_policy IN ('usd-cents-v1', 'usd-micros-v2'));
ALTER TABLE org_wallet_grant_snapshots ADD COLUMN money_policy TEXT NOT NULL DEFAULT 'usd-cents-v1'
  CHECK (money_policy IN ('usd-cents-v1', 'usd-micros-v2'));
ALTER TABLE org_wallet_monthly_tariffs ADD COLUMN money_policy TEXT NOT NULL DEFAULT 'usd-cents-v1'
  CHECK (money_policy IN ('usd-cents-v1', 'usd-micros-v2'));
ALTER TABLE usage_events ADD COLUMN amount_unit TEXT NOT NULL DEFAULT 'microcent-v1'
  CHECK (amount_unit IN ('microcent-v1', 'usd-micros-v2'));
ALTER TABLE usage_events ADD COLUMN amount_numerator_micros TEXT;
ALTER TABLE usage_events ADD COLUMN amount_denominator TEXT;

CREATE TABLE money_unit_policy (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  ledger_unit TEXT NOT NULL CHECK (ledger_unit = 'usd-micros-v2'),
  historical_usage_unit TEXT NOT NULL CHECK (historical_usage_unit = 'microcent-v1'),
  cash_unit TEXT NOT NULL CHECK (cash_unit = 'usd-cents-v1')
);
INSERT INTO money_unit_policy VALUES (1, 'usd-micros-v2', 'microcent-v1', 'usd-cents-v1');

CREATE TRIGGER wallet_credit_lots_class_insert BEFORE INSERT ON wallet_credit_lots
WHEN NEW.consumption_class IS NULL
  OR NEW.consumption_class NOT IN ('free', 'subscription', 'purchased')
  OR (NEW.kind = 'purchased' AND NEW.consumption_class <> 'purchased')
  OR (NEW.kind = 'plan-included' AND NEW.consumption_class = 'purchased')
BEGIN
  SELECT RAISE(ABORT, 'explicit valid credit consumption class required');
END;
CREATE TRIGGER wallet_credit_lots_funding_immutable BEFORE UPDATE OF
  org_id, ref, kind, consumption_class, amount_micros, expires_at, created_at ON wallet_credit_lots
WHEN NEW.org_id IS NOT OLD.org_id
  OR NEW.ref IS NOT OLD.ref
  OR NEW.kind IS NOT OLD.kind
  OR NEW.consumption_class IS NOT OLD.consumption_class
  OR NEW.amount_micros IS NOT OLD.amount_micros
  OR NEW.expires_at IS NOT OLD.expires_at
  OR NEW.created_at IS NOT OLD.created_at
BEGIN
  SELECT RAISE(ABORT, 'credit funding provenance is immutable');
END;
CREATE TRIGGER ledger_entry_no_update BEFORE UPDATE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger money history is immutable');
END;
CREATE TRIGGER ledger_entry_no_delete BEFORE DELETE ON ledger
BEGIN
  SELECT RAISE(ABORT, 'ledger money history is immutable');
END;
CREATE TRIGGER org_wallet_holds_new_money_policy BEFORE INSERT ON org_wallet_holds
WHEN NEW.money_policy <> 'usd-micros-v2'
BEGIN
  SELECT RAISE(ABORT, 'new money receipt requires usd-micros-v2');
END;
CREATE TRIGGER org_wallet_holds_legacy_receipt_immutable BEFORE UPDATE ON org_wallet_holds
WHEN OLD.money_policy = 'usd-cents-v1' OR NEW.money_policy IS NOT OLD.money_policy
BEGIN
  SELECT RAISE(ABORT, 'historical money receipt is immutable');
END;
CREATE TRIGGER org_wallet_usage_records_new_money_policy BEFORE INSERT ON org_wallet_usage_records
WHEN NEW.money_policy <> 'usd-micros-v2'
BEGIN
  SELECT RAISE(ABORT, 'new money receipt requires usd-micros-v2');
END;
CREATE TRIGGER org_wallet_usage_records_legacy_receipt_immutable BEFORE UPDATE ON org_wallet_usage_records
WHEN OLD.money_policy = 'usd-cents-v1' OR NEW.money_policy IS NOT OLD.money_policy
BEGIN
  SELECT RAISE(ABORT, 'historical money receipt is immutable');
END;
CREATE TRIGGER org_wallet_grant_snapshots_new_money_policy BEFORE INSERT ON org_wallet_grant_snapshots
WHEN NEW.money_policy <> 'usd-micros-v2'
BEGIN
  SELECT RAISE(ABORT, 'new money receipt requires usd-micros-v2');
END;
CREATE TRIGGER org_wallet_grant_snapshots_legacy_receipt_immutable BEFORE UPDATE ON org_wallet_grant_snapshots
WHEN OLD.money_policy = 'usd-cents-v1' OR NEW.money_policy IS NOT OLD.money_policy
BEGIN
  SELECT RAISE(ABORT, 'historical money receipt is immutable');
END;
CREATE TRIGGER org_wallet_monthly_tariffs_new_money_policy BEFORE INSERT ON org_wallet_monthly_tariffs
WHEN NEW.money_policy <> 'usd-micros-v2'
BEGIN
  SELECT RAISE(ABORT, 'new money receipt requires usd-micros-v2');
END;
CREATE TRIGGER org_wallet_monthly_tariffs_legacy_receipt_immutable BEFORE UPDATE ON org_wallet_monthly_tariffs
WHEN OLD.money_policy = 'usd-cents-v1' OR NEW.money_policy IS NOT OLD.money_policy
BEGIN
  SELECT RAISE(ABORT, 'historical money receipt is immutable');
END;
CREATE TRIGGER usage_events_new_money_unit BEFORE INSERT ON usage_events
WHEN NEW.amount_unit <> 'usd-micros-v2'
  OR NEW.amount_numerator_micros IS NULL
  OR NEW.amount_denominator IS NULL
  OR length(NEW.amount_numerator_micros) = 0
  OR length(NEW.amount_denominator) = 0
  OR NEW.amount_numerator_micros GLOB '*[^0-9]*'
  OR NEW.amount_denominator GLOB '*[^0-9]*'
  OR (length(NEW.amount_numerator_micros) > 1 AND substr(NEW.amount_numerator_micros, 1, 1) = '0')
  OR substr(NEW.amount_denominator, 1, 1) = '0'
BEGIN
  SELECT RAISE(ABORT, 'new usage event requires exact usd-micros-v2 rational');
END;
CREATE TRIGGER usage_events_money_immutable BEFORE UPDATE OF
  amount_micros, amount_unit, amount_numerator_micros, amount_denominator ON usage_events
WHEN NEW.amount_micros IS NOT OLD.amount_micros
  OR NEW.amount_unit IS NOT OLD.amount_unit
  OR NEW.amount_numerator_micros IS NOT OLD.amount_numerator_micros
  OR NEW.amount_denominator IS NOT OLD.amount_denominator
BEGIN
  SELECT RAISE(ABORT, 'usage event money and unit are immutable');
END;

INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM ledger t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'ledger'
    AND p.row_key = id AND p.source_column = 'settled_delta'
  WHERE p.row_key IS NULL OR t.settled_delta_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'ledger' AND p.source_column = 'settled_delta'
    AND NOT EXISTS (SELECT 1 FROM ledger t WHERE id = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'ledger' AND p.source_column = 'settled_delta'
    AND p.total_minor * 10000 <> (SELECT SUM(t.settled_delta_micros) FROM ledger t
      WHERE org_id = p.org_id)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM ledger t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'ledger'
    AND p.row_key = id AND p.source_column = 'held_delta'
  WHERE p.row_key IS NULL OR t.held_delta_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'ledger' AND p.source_column = 'held_delta'
    AND NOT EXISTS (SELECT 1 FROM ledger t WHERE id = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'ledger' AND p.source_column = 'held_delta'
    AND p.total_minor * 10000 <> (SELECT SUM(t.held_delta_micros) FROM ledger t
      WHERE org_id = p.org_id)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM wallet_credit_lots t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'wallet_credit_lots'
    AND p.row_key = json_array(org_id, ref) AND p.source_column = 'amount_minor'
  WHERE p.row_key IS NULL OR t.amount_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'wallet_credit_lots' AND p.source_column = 'amount_minor'
    AND NOT EXISTS (SELECT 1 FROM wallet_credit_lots t WHERE json_array(org_id, ref) = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'wallet_credit_lots' AND p.source_column = 'amount_minor'
    AND p.total_minor * 10000 <> (SELECT SUM(t.amount_micros) FROM wallet_credit_lots t
      WHERE org_id = p.org_id)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM wallet_credit_allocations t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'wallet_credit_allocations'
    AND p.row_key = json_array(org_id, debit_type, debit_ref, lot_ref) AND p.source_column = 'amount_minor'
  WHERE p.row_key IS NULL OR t.amount_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'wallet_credit_allocations' AND p.source_column = 'amount_minor'
    AND NOT EXISTS (SELECT 1 FROM wallet_credit_allocations t WHERE json_array(org_id, debit_type, debit_ref, lot_ref) = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'wallet_credit_allocations' AND p.source_column = 'amount_minor'
    AND p.total_minor * 10000 <> (SELECT SUM(t.amount_micros) FROM wallet_credit_allocations t
      WHERE org_id = p.org_id)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM org_wallet_holds t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'org_wallet_holds'
    AND p.row_key = json_array(org_id, ref) AND p.source_column = 'amount_minor'
  WHERE p.row_key IS NULL OR t.amount_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'org_wallet_holds' AND p.source_column = 'amount_minor'
    AND NOT EXISTS (SELECT 1 FROM org_wallet_holds t WHERE json_array(org_id, ref) = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'org_wallet_holds' AND p.source_column = 'amount_minor'
    AND p.total_minor * 10000 <> (SELECT SUM(t.amount_micros) FROM org_wallet_holds t
      WHERE org_id = p.org_id)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM org_wallet_holds t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'org_wallet_holds'
    AND p.row_key = json_array(org_id, ref) AND p.source_column = 'captured_minor'
  WHERE p.row_key IS NULL OR t.captured_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'org_wallet_holds' AND p.source_column = 'captured_minor'
    AND NOT EXISTS (SELECT 1 FROM org_wallet_holds t WHERE json_array(org_id, ref) = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'org_wallet_holds' AND p.source_column = 'captured_minor'
    AND p.total_minor * 10000 <> (SELECT SUM(t.captured_micros) FROM org_wallet_holds t
      WHERE org_id = p.org_id)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM org_wallet_holds t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'org_wallet_holds'
    AND p.row_key = json_array(org_id, ref) AND p.source_column = 'released_minor'
  WHERE p.row_key IS NULL OR t.released_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'org_wallet_holds' AND p.source_column = 'released_minor'
    AND NOT EXISTS (SELECT 1 FROM org_wallet_holds t WHERE json_array(org_id, ref) = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'org_wallet_holds' AND p.source_column = 'released_minor'
    AND p.total_minor * 10000 <> (SELECT SUM(t.released_micros) FROM org_wallet_holds t
      WHERE org_id = p.org_id)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM org_wallet_usage_records t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'org_wallet_usage_records'
    AND p.row_key = json_array(org_id, ref) AND p.source_column = 'amount_minor'
  WHERE p.row_key IS NULL OR t.amount_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'org_wallet_usage_records' AND p.source_column = 'amount_minor'
    AND NOT EXISTS (SELECT 1 FROM org_wallet_usage_records t WHERE json_array(org_id, ref) = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'org_wallet_usage_records' AND p.source_column = 'amount_minor'
    AND p.total_minor * 10000 <> (SELECT SUM(t.amount_micros) FROM org_wallet_usage_records t
      WHERE org_id = p.org_id)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM org_wallet_grant_snapshots t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'org_wallet_grant_snapshots'
    AND p.row_key = json_array(org_id, ref) AND p.source_column = 'amount_minor'
  WHERE p.row_key IS NULL OR t.amount_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'org_wallet_grant_snapshots' AND p.source_column = 'amount_minor'
    AND NOT EXISTS (SELECT 1 FROM org_wallet_grant_snapshots t WHERE json_array(org_id, ref) = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'org_wallet_grant_snapshots' AND p.source_column = 'amount_minor'
    AND p.total_minor * 10000 <> (SELECT SUM(t.amount_micros) FROM org_wallet_grant_snapshots t
      WHERE org_id = p.org_id)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM org_wallet_monthly_tariffs t
  LEFT JOIN money_cutover_preimage p ON p.source_table = 'org_wallet_monthly_tariffs'
    AND p.row_key = month AND p.source_column = 'amount_minor'
  WHERE p.row_key IS NULL OR t.amount_micros <> p.amount_minor * 10000
) AND NOT EXISTS (
  SELECT 1 FROM money_cutover_preimage p
  WHERE p.source_table = 'org_wallet_monthly_tariffs' AND p.source_column = 'amount_minor'
    AND NOT EXISTS (SELECT 1 FROM org_wallet_monthly_tariffs t WHERE month = p.row_key)
) THEN 1 ELSE 0 END;
INSERT INTO money_cutover_guard (singleton, valid)
SELECT NULL, CASE WHEN NOT EXISTS (
  SELECT 1 FROM money_cutover_aggregates p
  WHERE p.source_table = 'org_wallet_monthly_tariffs' AND p.source_column = 'amount_minor'
    AND p.total_minor * 10000 <> (SELECT SUM(t.amount_micros) FROM org_wallet_monthly_tariffs t
      WHERE '*' = p.org_id)
) THEN 1 ELSE 0 END;
-- Preserve the local row/aggregate evidence and reviewed dispositions after
-- the conversion. The protected external snapshot remains the cutover source.
CREATE TRIGGER money_cutover_preimage_no_insert BEFORE INSERT ON money_cutover_preimage
BEGIN
  SELECT RAISE(ABORT, 'money cutover proof is immutable');
END;
CREATE TRIGGER money_cutover_preimage_no_update BEFORE UPDATE ON money_cutover_preimage
BEGIN
  SELECT RAISE(ABORT, 'money cutover proof is immutable');
END;
CREATE TRIGGER money_cutover_preimage_no_delete BEFORE DELETE ON money_cutover_preimage
BEGIN
  SELECT RAISE(ABORT, 'money cutover proof is immutable');
END;
CREATE TRIGGER money_cutover_aggregates_no_insert BEFORE INSERT ON money_cutover_aggregates
BEGIN
  SELECT RAISE(ABORT, 'money cutover proof is immutable');
END;
CREATE TRIGGER money_cutover_aggregates_no_update BEFORE UPDATE ON money_cutover_aggregates
BEGIN
  SELECT RAISE(ABORT, 'money cutover proof is immutable');
END;
CREATE TRIGGER money_cutover_aggregates_no_delete BEFORE DELETE ON money_cutover_aggregates
BEGIN
  SELECT RAISE(ABORT, 'money cutover proof is immutable');
END;
CREATE TRIGGER wallet_lot_proofs_no_insert BEFORE INSERT ON wallet_credit_lot_classification_proofs
BEGIN
  SELECT RAISE(ABORT, 'reviewed lot disposition is immutable');
END;
CREATE TRIGGER wallet_lot_proofs_no_update BEFORE UPDATE ON wallet_credit_lot_classification_proofs
BEGIN
  SELECT RAISE(ABORT, 'reviewed lot disposition is immutable');
END;
CREATE TRIGGER wallet_lot_proofs_no_delete BEFORE DELETE ON wallet_credit_lot_classification_proofs
BEGIN
  SELECT RAISE(ABORT, 'reviewed lot disposition is immutable');
END;
CREATE TRIGGER money_unit_policy_no_update BEFORE UPDATE ON money_unit_policy
BEGIN
  SELECT RAISE(ABORT, 'money unit policy is immutable');
END;
CREATE TRIGGER money_unit_policy_no_delete BEFORE DELETE ON money_unit_policy
BEGIN
  SELECT RAISE(ABORT, 'money unit policy is immutable');
END;

DROP TABLE money_cutover_guard;
