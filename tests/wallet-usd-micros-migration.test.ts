import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/db-schema.ts";

const preparation = readFileSync(
  new URL("../migrations/0093_wallet_credit_classification_proofs.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../migrations/0094_wallet_usd_micros.sql", import.meta.url),
  "utf8",
);

function baseline(): Database {
  const database = new Database(":memory:");
  for (const entry of MIGRATIONS.filter(({ name }) => name <= "0092_org_wallet_lifecycle.sql")) {
    database.exec(entry.sql);
  }
  return database;
}

function prepare(database: Database): void {
  database.exec(preparation);
}

// Match the production runner's statement boundary, including trigger bodies.
function statements(sql: string): string[] {
  const result: string[] = [];
  let rest = sql.replace(/^\s*--.*$/gmu, "").trim();
  while (rest) {
    if (/^CREATE\s+TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end) throw new Error("incomplete trigger");
      const boundary = (end.index ?? 0) + end[0].length;
      result.push(rest.slice(0, boundary));
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      result.push(rest);
      break;
    }
    result.push(rest.slice(0, boundary).trim());
    rest = rest.slice(boundary + 1).trim();
  }
  return result.filter(Boolean);
}

function apply(database: Database): void {
  database.exec("BEGIN IMMEDIATE");
  try {
    for (const statement of statements(migration)) database.exec(statement);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function fundedLot(database: Database, kind = "purchased", amount = 7): void {
  database
    .query(`INSERT INTO wallet_credit_lots
    (org_id, ref, kind, amount_minor, expires_at, created_at)
    VALUES ('org_a', 'lot_a', ?, ?, NULL, '2026-01-01T00:00:00.000Z')`)
    .run(kind, amount);
  database
    .query(`INSERT INTO ledger
    (id, org_id, type, ref, settled_delta, held_delta, created_at)
    VALUES ('entry_a', 'org_a', 'funding', 'lot_a', ?, 0, '2026-01-01T00:00:00.000Z')`)
    .run(amount);
}

function proof(database: Database, kind: string, amount: number, consumptionClass: string): void {
  database
    .query(`INSERT INTO wallet_credit_lot_classification_proofs
    VALUES ('org_a', 'lot_a', ?, ?, NULL, ?, 'reviewed-snapshot-0001',
      '2026-10-14T00:00:00.000Z')`)
    .run(kind, amount, consumptionClass);
}

function hasOldLedgerColumn(database: Database): boolean {
  return (database.query("PRAGMA table_info(ledger)").all() as { name: string }[]).some(
    (row) => row.name === "settled_delta",
  );
}

describe("0093 preparation and 0094 wallet unit cutover", () => {
  test("fresh migration declares units and requires explicit new writer epochs", () => {
    const database = baseline();
    prepare(database);
    apply(database);
    expect(database.query("SELECT ledger_unit FROM money_unit_policy").get()).toEqual({
      ledger_unit: "usd-micros-v2",
    });
    expect(hasOldLedgerColumn(database)).toBe(false);
    expect(() =>
      database.exec(`INSERT INTO usage_events
      (request_id, org_id, resource_uid, meter, quantity, amount_micros, created_at)
      VALUES ('usage-1', 'org_a', 'res', 'meter', 1, 1, '2026-01-01')`),
    ).toThrow();
    database.exec(`INSERT INTO usage_events
      (request_id, org_id, resource_uid, meter, quantity, amount_micros, created_at,
       amount_unit, amount_numerator_micros, amount_denominator)
      VALUES ('usage-1', 'org_a', 'res', 'meter', 1, 1, '2026-01-01',
        'usd-micros-v2', '3', '2')`);
    expect(database.query("SELECT amount_micros, amount_unit FROM usage_events").get()).toEqual({
      amount_micros: 1,
      amount_unit: "usd-micros-v2",
    });
    database.close();
  });

  test("converts row and aggregate cents exactly while preserving old decisions", () => {
    const database = baseline();
    prepare(database);
    fundedLot(database, "direct", 7);
    proof(database, "direct", 7, "free");
    database.exec(`INSERT INTO ledger VALUES
      ('hold_a', 'org_a', 'hold', 'h1', 0, 5, '2026-01-02'),
      ('capture_a', 'org_a', 'capture', 'h1', -3, -3, '2026-01-03'),
      ('release_a', 'org_a', 'release', 'h1', 0, -2, '2026-01-04')`);
    database.exec(`INSERT INTO wallet_credit_allocations
      (org_id, debit_type, debit_ref, lot_ref, amount_minor, created_at)
      VALUES ('org_a', 'capture', 'h1', 'lot_a', 3, '2026-01-03')`);
    database.exec(`INSERT INTO org_wallet_holds
      (org_id, ref, ledger_ref, amount_minor, fingerprint, pricing_revision,
       created_at, expires_at, state, captured_minor, released_minor,
       capture_fingerprint, actual_micros, closed_at)
      VALUES ('org_a', 'h1', 'h1', 5, 'old-hold-fingerprint', 'revision-1',
       '2026-01-02', '2026-01-05', 'captured', 3, 2,
       'old-capture-fingerprint', '30000', '2026-01-03')`);
    database.exec(`INSERT INTO usage_events
      (request_id, org_id, resource_uid, meter, quantity, amount_micros, created_at, rollup_id)
      VALUES ('old-request', 'org_a', 'resource', 'meter', 1, 250, '2026-01-01', 'rollup-1')`);
    apply(database);
    expect(
      database.query("SELECT kind, consumption_class, amount_micros FROM wallet_credit_lots").get(),
    ).toEqual({
      kind: "direct",
      consumption_class: "free",
      amount_micros: 70_000,
    });
    expect(
      database
        .query("SELECT type, settled_delta_micros, held_delta_micros FROM ledger ORDER BY id")
        .all(),
    ).toEqual([
      { type: "capture", settled_delta_micros: -30_000, held_delta_micros: -30_000 },
      { type: "funding", settled_delta_micros: 70_000, held_delta_micros: 0 },
      { type: "hold", settled_delta_micros: 0, held_delta_micros: 50_000 },
      { type: "release", settled_delta_micros: 0, held_delta_micros: -20_000 },
    ]);
    expect(
      database
        .query(`SELECT amount_micros, captured_micros, released_micros,
      fingerprint, capture_fingerprint, money_policy FROM org_wallet_holds`)
        .get(),
    ).toEqual({
      amount_micros: 50_000,
      captured_micros: 30_000,
      released_micros: 20_000,
      fingerprint: "old-hold-fingerprint",
      capture_fingerprint: "old-capture-fingerprint",
      money_policy: "usd-cents-v1",
    });
    expect(database.query("SELECT amount_micros, amount_unit FROM usage_events").get()).toEqual({
      amount_micros: 250,
      amount_unit: "microcent-v1",
    });
    expect(() =>
      database.exec(`UPDATE usage_events SET amount_unit = 'usd-micros-v2'
      WHERE request_id = 'old-request'`),
    ).toThrow();
    database.exec(`UPDATE usage_events SET rollup_id = 'rollup-2'
      WHERE request_id = 'old-request'`);
    expect(
      database
        .query(
          "SELECT total_minor FROM money_cutover_aggregates WHERE source_table='ledger' AND source_column='settled_delta'",
        )
        .get(),
    ).toEqual({ total_minor: 4 });
    expect(database.query("SELECT COUNT(*) AS count FROM money_cutover_preimage").get()).toEqual({
      count: 13,
    });
    expect(() =>
      database.exec(`UPDATE org_wallet_holds SET fingerprint = 'new' WHERE ref = 'h1'`),
    ).toThrow();
    expect(() =>
      database.exec(`UPDATE wallet_credit_lot_classification_proofs
      SET consumption_class = 'subscription' WHERE ref = 'lot_a'`),
    ).toThrow();
    expect(() =>
      database.exec(`UPDATE wallet_credit_lots
      SET consumption_class = 'subscription' WHERE ref = 'lot_a'`),
    ).toThrow();
    expect(() =>
      database.exec(`UPDATE wallet_credit_lots
      SET kind = 'plan-included' WHERE ref = 'lot_a'`),
    ).toThrow();
    expect(() =>
      database.exec(`UPDATE wallet_credit_lots
      SET amount_micros = 1 WHERE ref = 'lot_a'`),
    ).toThrow();
    expect(() =>
      database.exec(`UPDATE ledger SET settled_delta_micros = 1
      WHERE id = 'entry_a'`),
    ).toThrow();
    expect(() => database.exec(`DELETE FROM ledger WHERE id = 'entry_a'`)).toThrow();
    expect(() => database.exec(`DELETE FROM money_cutover_preimage`)).toThrow();
    database.close();
  });

  test("refuses an unclassified direct lot without changing the old schema", () => {
    const database = baseline();
    prepare(database);
    fundedLot(database, "direct");
    expect(() => apply(database)).toThrow();
    expect(hasOldLedgerColumn(database)).toBe(true);
    expect(database.query("SELECT amount_minor FROM wallet_credit_lots").get()).toEqual({
      amount_minor: 7,
    });
    database.close();
  });

  test("refuses stale classification, open holds, pending usage, and unrolled old measurements", () => {
    for (const blocker of [
      "stale-proof",
      "open-hold",
      "stranded-hold-allocation",
      "pending-usage",
      "unrolled-usage",
      "pending-ai",
    ]) {
      const database = baseline();
      prepare(database);
      fundedLot(database, "direct");
      proof(database, "direct", blocker === "stale-proof" ? 6 : 7, "purchased");
      if (blocker === "open-hold")
        database.exec(`INSERT INTO org_wallet_holds
        (org_id, ref, ledger_ref, amount_minor, created_at, expires_at, state)
        VALUES ('org_a', 'h1', 'h1', 1, '2026-01-01', '2026-01-02', 'live')`);
      if (blocker === "stranded-hold-allocation") {
        database.exec(`INSERT INTO ledger VALUES
          ('hold_h1', 'org_a', 'hold', 'h1', 0, 1, '2026-01-02'),
          ('release_h1', 'org_a', 'release', 'h1', 0, -1, '2026-01-03')`);
        database.exec(`INSERT INTO wallet_credit_allocations
          (org_id, debit_type, debit_ref, lot_ref, amount_minor, created_at)
          VALUES ('org_a', 'hold', 'h1', 'lot_a', 1, '2026-01-02')`);
      }
      if (blocker === "pending-usage")
        database.exec(`INSERT INTO org_wallet_usage_records
        (org_id, ref, fingerprint, pricing_revision, meter, quantity, quantity_unit,
         period_start, period_end, rate_numerator_micros, rate_denominator,
         amount_minor, state, created_at)
        VALUES ('org_a', 'u1', 'fingerprint', 'revision', 'meter', '1', 'unit',
         '2026-01-01', '2026-01-02', '1', '1', 1, 'pending', '2026-01-02')`);
      if (blocker === "unrolled-usage")
        database.exec(`INSERT INTO usage_events
        (request_id, org_id, resource_uid, meter, quantity, amount_micros, created_at)
        VALUES ('u1', 'org_a', 'res', 'meter', 1, 100, '2026-01-01')`);
      if (blocker === "pending-ai")
        database.exec(`INSERT INTO idempotency
        (scope_key, fingerprint, status, body_json, expires_at)
        VALUES ('ai:org_a:request', 'fingerprint', 101, '{}', 1)`);
      expect(() => apply(database)).toThrow();
      expect(hasOldLedgerColumn(database)).toBe(true);
      database.close();
    }
  });

  test("refuses row and aggregate safe-integer overflow before mutation", () => {
    for (const amount of [900_719_925_475, 500_000_000_000]) {
      const database = baseline();
      prepare(database);
      fundedLot(database, "purchased", amount);
      if (amount === 500_000_000_000) {
        database.exec(`INSERT INTO wallet_credit_lots
          (org_id, ref, kind, amount_minor, created_at)
          VALUES ('org_a', 'lot_b', 'purchased', 500000000000, '2026-01-01')`);
        database.exec(`INSERT INTO ledger
          (id, org_id, type, ref, settled_delta, held_delta, created_at)
          VALUES ('entry_b', 'org_a', 'funding', 'lot_b', 500000000000, 0, '2026-01-01')`);
      }
      expect(() => apply(database)).toThrow();
      expect(hasOldLedgerColumn(database)).toBe(true);
      database.close();
    }
  });

  test("refuses coherent fractional predecessor funding without changing the old epoch", () => {
    const database = baseline();
    prepare(database);
    // Both sides of the old funding conservation check agree. SQLite still
    // stores these INTEGER-affinity columns as REAL, so equality alone cannot
    // prove that the predecessor amount was an integral cent.
    fundedLot(database, "purchased", 7.25);
    expect(
      database.query("SELECT typeof(amount_minor) AS unit FROM wallet_credit_lots").get(),
    ).toEqual({ unit: "real" });
    expect(database.query("SELECT typeof(settled_delta) AS unit FROM ledger").get()).toEqual({
      unit: "real",
    });

    expect(() => apply(database)).toThrow();
    expect(hasOldLedgerColumn(database)).toBe(true);
    expect(database.query("SELECT amount_minor FROM wallet_credit_lots").get()).toEqual({
      amount_minor: 7.25,
    });
    expect(database.query("SELECT settled_delta FROM ledger").get()).toEqual({
      settled_delta: 7.25,
    });
    expect(
      database.query("SELECT name FROM sqlite_schema WHERE name = 'money_cutover_preimage'").get(),
    ).toBeNull();
    expect(
      database.query("SELECT name FROM sqlite_schema WHERE name = 'money_unit_policy'").get(),
    ).toBeNull();
    database.close();
  });

  test("refuses fractional cents in old allocations and lifecycle receipts", () => {
    const fixtures = [
      {
        name: "allocation",
        setup: `INSERT INTO wallet_credit_lots
          (org_id, ref, kind, amount_minor, created_at)
          VALUES ('org_a', 'lot_a', 'purchased', 7, '2026-01-01'),
                 ('org_a', 'lot_b', 'purchased', 7, '2026-01-01');
          INSERT INTO ledger VALUES
            ('fund_a', 'org_a', 'funding', 'lot_a', 7, 0, '2026-01-01'),
            ('fund_b', 'org_a', 'funding', 'lot_b', 7, 0, '2026-01-01'),
            ('hold_a', 'org_a', 'hold', 'h1', 0, 1, '2026-01-02'),
            ('capture_a', 'org_a', 'capture', 'h1', -1, -1, '2026-01-03');
          INSERT INTO wallet_credit_allocations
            (org_id, debit_type, debit_ref, lot_ref, amount_minor, created_at)
            VALUES ('org_a', 'capture', 'h1', 'lot_a', 0.5, '2026-01-03'),
                   ('org_a', 'capture', 'h1', 'lot_b', 0.5, '2026-01-03');`,
        read: "SELECT typeof(amount_minor) AS unit FROM wallet_credit_allocations LIMIT 1",
      },
      {
        name: "closed hold",
        setup: `INSERT INTO org_wallet_holds
          (org_id, ref, ledger_ref, amount_minor, created_at, state,
           captured_minor, released_minor, closed_at)
          VALUES ('org_a', 'h1', 'h1', 1, '2026-01-01', 'released',
                  0.5, 0.5, '2026-01-02');`,
        read: "SELECT typeof(captured_minor) AS unit FROM org_wallet_holds",
      },
      {
        name: "paid usage receipt",
        setup: `INSERT INTO org_wallet_usage_records
          (org_id, ref, fingerprint, pricing_revision, meter, quantity,
           quantity_unit, period_start, period_end, rate_numerator_micros,
           rate_denominator, amount_minor, state, created_at, paid_at)
          VALUES ('org_a', 'u1', 'fingerprint', 'revision', 'meter', '1',
                  'unit', '2026-01-01', '2026-01-02', '1', '1',
                  0.5, 'paid', '2026-01-02', '2026-01-02');`,
        read: "SELECT typeof(amount_minor) AS unit FROM org_wallet_usage_records",
      },
      {
        name: "grant snapshot",
        setup: `INSERT INTO org_wallet_grant_snapshots
          (org_id, ref, pricing_revision, amount_minor, expires_at, created_at)
          VALUES ('org_a', 'g1', 'revision', 0.5, '2026-02-01', '2026-01-01');`,
        read: "SELECT typeof(amount_minor) AS unit FROM org_wallet_grant_snapshots",
      },
      {
        name: "monthly tariff",
        setup: `INSERT INTO org_wallet_monthly_tariffs
          (month, pricing_revision, amount_minor, expires_at, created_at)
          VALUES ('2026-01', 'revision', 0.5, '2026-02-01', '2026-01-01');`,
        read: "SELECT typeof(amount_minor) AS unit FROM org_wallet_monthly_tariffs",
      },
    ];
    for (const fixture of fixtures) {
      const database = baseline();
      prepare(database);
      database.exec(fixture.setup);
      expect(database.query(fixture.read).get()).toEqual({ unit: "real" });
      expect(() => apply(database)).toThrow();
      expect(hasOldLedgerColumn(database)).toBe(true);
      expect(database.query(fixture.read).get()).toEqual({ unit: "real" });
      expect(
        database
          .query("SELECT name FROM sqlite_schema WHERE name = 'money_cutover_preimage'")
          .get(),
      ).toBeNull();
      database.close();
    }
  });

  test("refuses fractional historical microcents and unsafe old usage rows", () => {
    for (const amount of [0.5, 9_007_199_254_740_992]) {
      const database = baseline();
      prepare(database);
      database
        .query(`INSERT INTO usage_events
        (request_id, org_id, resource_uid, meter, quantity, amount_micros, created_at, rollup_id)
        VALUES ('u1', 'org_a', 'res', 'meter', 1, ?, '2026-01-01', 'roll_zero')`)
        .run(amount);
      expect(() => apply(database)).toThrow();
      expect(hasOldLedgerColumn(database)).toBe(true);
      expect(
        database.query("SELECT amount_micros FROM usage_events WHERE request_id = 'u1'").get(),
      ).toEqual({ amount_micros: amount });
      expect(
        database
          .query("SELECT name FROM sqlite_schema WHERE name = 'money_cutover_preimage'")
          .get(),
      ).toBeNull();
      database.close();
    }
  });

  test("refuses indeterminate Stripe and reseller settlement intents", () => {
    for (const blocker of ["stripe-received", "stripe-deferred", "reseller-pending"]) {
      const database = baseline();
      prepare(database);
      if (blocker.startsWith("stripe")) {
        database
          .query(`INSERT INTO stripe_events
          (event_id, type, livemode, event_created_at, received_at, outcome, settled_at)
          VALUES ('evt_pending', 'checkout.session.completed', 0,
            '2026-01-01', '2026-01-01', ?, ?)`)
          .run(
            blocker === "stripe-received" ? "received" : "deferred",
            blocker === "stripe-received" ? null : "2026-01-01",
          );
      } else {
        database.exec(`INSERT INTO reseller_settlement_intents
          (idempotency_key, org_id, tenant_ref, reservation_id, offering_id,
           meter, quantity, amount_minor, state, created_at, updated_at)
          VALUES ('key', 'org_a', 'tenant', 'reservation', 'offering',
            'meter', 1, 1, 'pending', 1, 1)`);
      }
      expect(() => apply(database)).toThrow();
      expect(hasOldLedgerColumn(database)).toBe(true);
      database.close();
    }
  });

  test("refuses a claimed positive old usage rollup without its exact debit", () => {
    for (const chargedMinor of [0, 1]) {
      const database = baseline();
      prepare(database);
      fundedLot(database, "purchased", 10);
      database.exec(`INSERT INTO usage_events
        (request_id, org_id, resource_uid, meter, quantity, amount_micros, created_at, rollup_id)
        VALUES ('u1', 'org_a', 'res', 'meter', 1, 1500000, '2026-01-01', 'roll_old')`);
      if (chargedMinor > 0) {
        database.exec(`INSERT INTO ledger VALUES
          ('debit_old', 'org_a', 'usage_debit', 'roll_old', -1, 0, '2026-01-02')`);
        database.exec(`INSERT INTO wallet_credit_allocations
          (org_id, debit_type, debit_ref, lot_ref, amount_minor, created_at)
          VALUES ('org_a', 'usage_debit', 'roll_old', 'lot_a', 1, '2026-01-02')`);
      }
      expect(() => apply(database)).toThrow();
      expect(hasOldLedgerColumn(database)).toBe(true);
      expect(
        database.query("SELECT amount_micros FROM usage_events WHERE request_id='u1'").get(),
      ).toEqual({ amount_micros: 1_500_000 });
      database.close();
    }
  });

  test("preserves paid positive and rounded-zero old microcent groups", () => {
    const database = baseline();
    prepare(database);
    fundedLot(database, "purchased", 10);
    database.exec(`INSERT INTO usage_events
      (request_id, org_id, resource_uid, meter, quantity, amount_micros, created_at, rollup_id)
      VALUES
        ('u1', 'org_a', 'res', 'meter', 1, 1000000, '2026-01-01', 'roll_paid'),
        ('u2', 'org_a', 'res', 'meter', 1, 500000, '2026-01-01', 'roll_paid'),
        ('u3', 'org_a', 'res', 'meter', 1, 499999, '2026-01-01', 'roll_zero')`);
    database.exec(`INSERT INTO ledger VALUES
      ('debit_paid', 'org_a', 'usage_debit', 'roll_paid', -2, 0, '2026-01-02')`);
    database.exec(`INSERT INTO wallet_credit_allocations
      (org_id, debit_type, debit_ref, lot_ref, amount_minor, created_at)
      VALUES ('org_a', 'usage_debit', 'roll_paid', 'lot_a', 2, '2026-01-02')`);
    apply(database);
    expect(
      database
        .query(`SELECT ref, settled_delta_micros FROM ledger
      WHERE type = 'usage_debit'`)
        .all(),
    ).toEqual([{ ref: "roll_paid", settled_delta_micros: -20_000 }]);
    expect(
      database
        .query(`SELECT request_id, amount_micros, amount_unit FROM usage_events
      ORDER BY request_id`)
        .all(),
    ).toEqual([
      { request_id: "u1", amount_micros: 1_000_000, amount_unit: "microcent-v1" },
      { request_id: "u2", amount_micros: 500_000, amount_unit: "microcent-v1" },
      { request_id: "u3", amount_micros: 499_999, amount_unit: "microcent-v1" },
    ]);
    database.close();
  });

  test("refuses unit cutover without the separately prepared 0093 schema", () => {
    const database = baseline();
    fundedLot(database, "direct");
    expect(() => apply(database)).toThrow();
    expect(hasOldLedgerColumn(database)).toBe(true);
    expect(
      database.query("SELECT name FROM sqlite_schema WHERE name = 'money_unit_policy'").get(),
    ).toBeNull();
    database.close();
  });
});
