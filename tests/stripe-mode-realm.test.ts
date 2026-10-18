import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectStripeModeRealm } from "../scripts/deploy/stripe-mode-realm.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { MONEY_CUTOVER_FINANCIAL_TABLES } from "../src/money-cutover-sql.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  assertStripeModeRealm,
  claimFreshStripeModeRealm,
  hasImmutableStripeModeRealmSchema,
  parseStripeMode,
  STRIPE_MODE_REALM_SCHEMA_QUERY,
  StripeModeRealmError,
} from "../src/stripe-mode-realm.ts";

async function openFileSql(path: string) {
  const db = new Database(path);
  for (const migration of MIGRATIONS) {
    if (migration.name === "0098_stripe_mode_realm.sql") continue;
    db.exec(migration.sql);
  }
  db.exec(
    await Bun.file(new URL("../migrations/0098_stripe_mode_realm.sql", import.meta.url)).text(),
  );
  return { db, sql: createSqliteSql(db) };
}

test("Stripe mode parsing defaults only an absent value to test", () => {
  expect(parseStripeMode(undefined)).toBe("test");
  expect(parseStripeMode("test")).toBe("test");
  expect(parseStripeMode("live")).toBe("live");
  for (const value of ["", null, "LIVE", "sandbox", 0]) {
    expect(() => parseStripeMode(value)).toThrow(StripeModeRealmError);
  }
});

test("a fresh source can be claimed and the pin survives restart without allowing a mode switch", async () => {
  const directory = mkdtempSync(join(tmpdir(), "takos-stripe-mode-"));
  const path = join(directory, "control.sqlite");
  try {
    const first = await openFileSql(path);
    await first.sql.run(
      "INSERT INTO principals (id, provider, provider_subject, email, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      ["principal_1", "google", "subject_1", "a@example.test", "A", "2026-10-14T00:00:00.000Z"],
    );
    await claimFreshStripeModeRealm(first.sql, "test");
    first.db.close();

    const restartedDb = new Database(path);
    const restarted = createSqliteSql(restartedDb);
    await assertStripeModeRealm(restarted, "test");
    await expect(claimFreshStripeModeRealm(restarted, "live")).rejects.toMatchObject({
      code: "mode_mismatch",
    });
    await expect(
      restarted.run("UPDATE stripe_mode_realm SET mode = 'live' WHERE singleton = 1"),
    ).rejects.toBeTruthy();
    await expect(
      restarted.run("DELETE FROM stripe_mode_realm WHERE singleton = 1"),
    ).rejects.toBeTruthy();
    expect(await restarted.query("SELECT singleton, mode FROM stripe_mode_realm")).toEqual([
      { singleton: 1, mode: "test" },
    ]);
    restartedDb.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("concurrent SQLite claims converge on one immutable pin", async () => {
  const directory = mkdtempSync(join(tmpdir(), "takos-stripe-mode-race-"));
  const path = join(directory, "control.sqlite");
  try {
    const first = await openFileSql(path);
    const secondDb = new Database(path);
    const second = createSqliteSql(secondDb);
    await Promise.all([
      claimFreshStripeModeRealm(first.sql, "live"),
      claimFreshStripeModeRealm(second, "live"),
    ]);
    await expect(claimFreshStripeModeRealm(first.sql, "test")).rejects.toMatchObject({
      code: "mode_mismatch",
    });
    expect(await second.query("SELECT mode FROM stripe_mode_realm WHERE singleton = 1")).toEqual([
      { mode: "live" },
    ]);
    first.db.close();
    secondDb.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("an unpinned database with any wallet or Stripe history refuses without changing rows", async () => {
  const directory = mkdtempSync(join(tmpdir(), "takos-stripe-mode-history-"));
  const path = join(directory, "control.sqlite");
  try {
    const { db, sql } = await openFileSql(path);
    db.exec(`INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
      VALUES ('ledger_1', 'org_1', 'funding', 'legacy', 100, 0, '2026-10-14T00:00:00.000Z')`);
    db.exec(`INSERT INTO stripe_events
      (event_id, type, livemode, object_id, event_created_at, received_at, outcome, settled_at)
      VALUES ('evt_old1', 'checkout.session.completed', 0, 'cs_test_old',
      '2026-10-14T00:00:00.000Z', '2026-10-14T00:00:00.000Z', 'ignored', '2026-10-14T00:00:00.000Z')`);
    db.exec(`INSERT INTO idempotency (scope_key, fingerprint, status, expires_at)
      VALUES ('ai:legacy', 'legacy', 200, 1)`);

    await expect(claimFreshStripeModeRealm(sql, "test")).rejects.toMatchObject({
      code: "legacy_history",
    });
    await expect(claimFreshStripeModeRealm(sql, "live")).rejects.toMatchObject({
      code: "legacy_history",
    });
    expect(await sql.query("SELECT id, settled_delta_micros FROM ledger")).toEqual([
      { id: "ledger_1", settled_delta_micros: 100 },
    ]);
    expect(await sql.query("SELECT event_id, livemode FROM stripe_events")).toEqual([
      { event_id: "evt_old1", livemode: 0 },
    ]);
    expect(await sql.query("SELECT scope_key FROM idempotency")).toEqual([
      { scope_key: "ai:legacy" },
    ]);
    expect(await sql.query("SELECT singleton FROM stripe_mode_realm")).toEqual([]);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("missing pin schema fails closed", async () => {
  const db = new Database(":memory:");
  const sql = createSqliteSql(db);
  await expect(assertStripeModeRealm(sql, "test")).rejects.toBeTruthy();
  await expect(claimFreshStripeModeRealm(sql, "test")).rejects.toBeTruthy();
  db.close();
});

test("a pin without the immutable schema cannot authorize financial serving", async () => {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  const sql = createSqliteSql(db);
  await claimFreshStripeModeRealm(sql, "live");
  db.exec("DROP TRIGGER stripe_mode_realm_no_delete");
  await expect(assertStripeModeRealm(sql, "live")).rejects.toMatchObject({
    code: "unsafe_schema",
  });
  db.close();
});

test("fresh claiming does not create a pin when the immutability trigger is absent", async () => {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  db.exec("DROP TRIGGER stripe_mode_realm_no_update");
  const sql = createSqliteSql(db);
  await expect(claimFreshStripeModeRealm(sql, "live")).rejects.toMatchObject({
    code: "unsafe_schema",
  });
  expect(await sql.query("SELECT mode FROM stripe_mode_realm")).toEqual([]);
  db.close();
});

test("the canonical 0098 source produces the exact accepted table and unconditional triggers", () => {
  const db = new Database(":memory:");
  const migration = MIGRATIONS.find((item) => item.name === "0098_stripe_mode_realm.sql");
  expect(migration).toBeDefined();
  db.exec(migration?.sql ?? "");
  const schema = db.query(STRIPE_MODE_REALM_SCHEMA_QUERY).all() as {
    type: string;
    name: string;
    sql: string;
  }[];
  expect(hasImmutableStripeModeRealmSchema(schema)).toBe(true);
  expect(inspectStripeModeRealm({ schema, pins: [{ mode: "test" }] }, "test").ready).toBe(true);
  const weakenedTable = schema.map((row) =>
    row.name === "stripe_mode_realm"
      ? { ...row, sql: row.sql.replace("CHECK (mode IN ('test', 'live'))", "") }
      : row,
  );
  expect(hasImmutableStripeModeRealmSchema(weakenedTable)).toBe(false);
  db.close();
});

test("a disguised non-enforcing trigger cannot authorize runtime, migration, or deploy", async () => {
  for (const replacement of [
    `CREATE TRIGGER stripe_mode_realm_no_update BEFORE UPDATE ON stripe_mode_realm
WHEN 0 BEGIN SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable'); END`,
    `CREATE TRIGGER stripe_mode_realm_no_update BEFORE UPDATE OF pinned_at ON stripe_mode_realm
BEGIN SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable'); END`,
    `CREATE TRIGGER stripe_mode_realm_no_update BEFORE UPDATE ON stripe_mode_realm
BEGIN SELECT 1; -- RAISE(ABORT, 'Stripe mode realm pin is immutable')
END`,
  ]) {
    const db = new Database(":memory:");
    migrateSqlite(db, { stripeMode: "test" });
    db.exec("DROP TRIGGER stripe_mode_realm_no_update");
    db.exec(replacement);
    const sql = createSqliteSql(db);
    const schema = db.query(STRIPE_MODE_REALM_SCHEMA_QUERY).all() as {
      type: string;
      name: string;
      sql: string;
    }[];
    expect(hasImmutableStripeModeRealmSchema(schema)).toBe(false);
    await expect(assertStripeModeRealm(sql, "test")).rejects.toMatchObject({
      code: "unsafe_schema",
    });
    expect(() => migrateSqlite(db, { stripeMode: "test" })).toThrow(
      "Stripe realm immutability is unavailable",
    );
    expect(inspectStripeModeRealm({ schema, pins: [{ mode: "test" }] }, "test")).toMatchObject({
      ready: false,
      reason: "unsafe_schema",
    });
    expect(db.query("SELECT mode FROM stripe_mode_realm").all()).toEqual([{ mode: "test" }]);
    db.close();
  }
});

// The following source cases require the exact Root v4 owner module overlay;
// this private packet does not execute them or mint a held context.
import {
  buildMoneyD1StripeRealmPolicyTuplePredicateData,
  classifyMoneyD1StripeRealmCensus,
  classifyMoneyD1StripeRealmPolicyTupleData,
  inspectMoneyD1StripeRealmTransition,
  MoneyRealmDiagnosticError,
} from "../scripts/deploy/stripe-mode-realm.ts";
import { STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES } from "../src/stripe-mode-realm.ts";

function sourceCensus(names: readonly string[], nonzero: Readonly<Record<string, number>> = {}) {
  return {
    tableInventory: [...names].sort(),
    rowCounts: Object.fromEntries(names.map((name) => [name, nonzero[name] ?? 0])),
  };
}

test("held realm census classifies every Financial named table without requiring all 42 at original92", () => {
  expect(STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES).toHaveLength(42);
  const all = classifyMoneyD1StripeRealmCensus(sourceCensus(STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES));
  expect(all.totals.known_financial).toEqual({ tables: 42, rows: 0, nonzeroTables: 0 });
  expect(all.totals.unknown_financial_prefix.tables).toBe(0);
  const original92 = classifyMoneyD1StripeRealmCensus(
    sourceCensus(["ledger", "stripe_events", "wallet_credit_lots"], { ledger: 3 }),
  );
  expect(original92.totals.known_financial).toEqual({ tables: 3, rows: 3, nonzeroTables: 1 });
  expect(original92.observations.map((item) => item.name)).toEqual([
    "ledger",
    "stripe_events",
    "wallet_credit_lots",
  ]);
});

test("all eight Financial prefixes classify unknown zero and nonzero tables as unresolved observations", () => {
  const names = [
    "stripe_future",
    "wallet_future",
    "org_wallet_future",
    "money_future",
    "usage_future",
    "reseller_settlement_future",
    "provider_meter_future",
    "sponsorship_future",
  ];
  const zero = classifyMoneyD1StripeRealmCensus(sourceCensus(names));
  expect(zero.totals.unknown_financial_prefix).toEqual({
    tables: 8,
    rows: 0,
    nonzeroTables: 0,
  });
  expect(
    zero.observations.every((item) => item.classification === "unknown_financial_prefix"),
  ).toBe(true);
  const nonzero = classifyMoneyD1StripeRealmCensus(sourceCensus(names, { wallet_future: 2 }));
  expect(nonzero.totals.unknown_financial_prefix).toEqual({
    tables: 8,
    rows: 2,
    nonzeroTables: 1,
  });
  const uppercase = classifyMoneyD1StripeRealmCensus(sourceCensus(["STRIPE_FUTURE"]));
  expect(uppercase.observations[0]?.classification).toBe("unknown_financial_prefix");
});

test("seeded and pin tables remain control observations; outside vocabulary is unclassified even at zero", () => {
  const result = classifyMoneyD1StripeRealmCensus(
    sourceCensus(["money_unit_policy", "stripe_mode_realm", "principals"], {
      money_unit_policy: 1,
    }),
  );
  expect(result.totals.control_unqualified).toEqual({ tables: 2, rows: 1, nonzeroTables: 1 });
  expect(result.totals.outside_vocabulary).toEqual({ tables: 1, rows: 0, nonzeroTables: 0 });
  expect(result.observations.find((item) => item.name === "principals")?.classification).toBe(
    "outside_vocabulary",
  );
});

test("census rejects missing, extra, duplicate, unsorted, sparse and unsafe observations", () => {
  const bad = [
    { tableInventory: ["ledger"], rowCounts: {} },
    { tableInventory: ["ledger"], rowCounts: { ledger: 0, extra: 0 } },
    { tableInventory: ["ledger", "ledger"], rowCounts: { ledger: 0 } },
    {
      tableInventory: ["wallet_credit_lots", "ledger"],
      rowCounts: { wallet_credit_lots: 0, ledger: 0 },
    },
    { tableInventory: ["ledger", , "quotes"], rowCounts: { ledger: 0, quotes: 0 } },
    { tableInventory: ["unsafe-name"], rowCounts: { "unsafe-name": 0 } },
    { tableInventory: ["ledger"], rowCounts: { ledger: -1 } },
    { tableInventory: ["ledger"], rowCounts: { ledger: 0.5 } },
    { tableInventory: ["ledger"], rowCounts: { ledger: Number.MAX_SAFE_INTEGER + 1 } },
    { tableInventory: ["ledger"], rowCounts: { ledger: Number.NaN } },
  ];
  for (const value of bad) expect(() => classifyMoneyD1StripeRealmCensus(value)).toThrow();
  const getterCounts = Object.defineProperty({}, "ledger", {
    enumerable: true,
    get() {
      throw new Error("getter executed");
    },
  });
  expect(() =>
    classifyMoneyD1StripeRealmCensus({
      tableInventory: ["ledger"],
      rowCounts: getterCounts,
    }),
  ).toThrow("Financial realm census is malformed");
  const getterInventory = Object.defineProperty({}, "tableInventory", {
    enumerable: true,
    get() {
      throw new Error("getter executed");
    },
  });
  expect(() => classifyMoneyD1StripeRealmCensus(getterInventory)).toThrow(
    "Financial realm census is malformed",
  );
});

test("forged, copied and JSON held contexts are rejected before Financial facts access", async () => {
  let factReads = 0;
  const forged = Object.defineProperty(
    {
      kind: "takoserver.money-held-convert-context@v1",
    },
    "facts",
    {
      enumerable: true,
      get() {
        factReads += 1;
        throw new Error("Financial read happened");
      },
    },
  );
  for (const context of [
    forged,
    { kind: forged.kind, facts: {} },
    JSON.parse(JSON.stringify({ kind: forged.kind, facts: {} })),
  ]) {
    await expect(inspectMoneyD1StripeRealmTransition(context)).rejects.toBeInstanceOf(
      MoneyRealmDiagnosticError,
    );
  }
  expect(factReads).toBe(0);
  try {
    await inspectMoneyD1StripeRealmTransition(forged);
    throw new Error("forged context unexpectedly accepted");
  } catch (error) {
    expect(error).toBeInstanceOf(MoneyRealmDiagnosticError);
    expect((error as MoneyRealmDiagnosticError).cause).toBeDefined();
    expect((error as Error).message).toBe("Financial realm diagnostic is unavailable");
  }
  expect(factReads).toBe(0);
});

test("current94 conversion-like and control table names receive no name-based exemption", () => {
  const current94 = classifyMoneyD1StripeRealmCensus(
    sourceCensus(
      [
        "money_cutover_preimage",
        "money_cutover_aggregates",
        "money_unit_policy",
        "stripe_mode_realm",
      ],
      {
        money_cutover_preimage: 1,
        money_cutover_aggregates: 1,
        money_unit_policy: 1,
        stripe_mode_realm: 1,
      },
    ),
  );
  expect(current94.totals.known_financial).toEqual({ tables: 2, rows: 2, nonzeroTables: 2 });
  expect(current94.totals.control_unqualified).toEqual({ tables: 2, rows: 2, nonzeroTables: 2 });
  expect(current94.observations.every((item) => item.rows === 1)).toBe(true);
});

test("array decorations, casefold duplicates, count getter and aggregate overflow fail closed", () => {
  const decorated = ["ledger"];
  Object.defineProperty(decorated, "extra", { value: 1 });
  const invalid = [
    { tableInventory: decorated, rowCounts: { ledger: 0 } },
    { tableInventory: ["LEDGER", "ledger"], rowCounts: { LEDGER: 0, ledger: 0 } },
    {
      tableInventory: ["ledger", "quotes"],
      rowCounts: {
        ledger: Number.MAX_SAFE_INTEGER,
        quotes: 1,
      },
    },
  ];
  for (const value of invalid) expect(() => classifyMoneyD1StripeRealmCensus(value)).toThrow();
});

test("a proxy with readable-looking facts still fails Root identity before Financial fact access", async () => {
  let factReads = 0;
  const forged = new Proxy(
    {},
    {
      get(_target, key) {
        if (key === "facts") factReads += 1;
        return undefined;
      },
    },
  );
  await expect(inspectMoneyD1StripeRealmTransition(forged)).rejects.toBeInstanceOf(
    MoneyRealmDiagnosticError,
  );
  expect(factReads).toBe(0);
});

test("the seven fixed preimage source tables are distinct observed zero-origin obligations", () => {
  const sources = [
    "ledger",
    "wallet_credit_lots",
    "wallet_credit_allocations",
    "org_wallet_holds",
    "org_wallet_usage_records",
    "org_wallet_grant_snapshots",
    "org_wallet_monthly_tariffs",
  ];
  const empty = classifyMoneyD1StripeRealmCensus(sourceCensus(sources));
  expect(empty.observations.map((item) => item.name)).toEqual([...sources].sort());
  expect(empty.totals.known_financial).toEqual({ tables: 7, rows: 0, nonzeroTables: 0 });
  const occupied = classifyMoneyD1StripeRealmCensus(sourceCensus(sources, { org_wallet_holds: 1 }));
  expect(occupied.totals.known_financial).toEqual({ tables: 7, rows: 1, nonzeroTables: 1 });
  const missing = classifyMoneyD1StripeRealmCensus(sourceCensus(sources.slice(1)));
  expect(missing.observations.find((item) => item.name === "ledger")).toBeUndefined();
  // A missing 0092 table is not silently read as a zero count by the classifier.
});

test("four named current94 rows remain observations when Root context is only structural data", async () => {
  const names = [
    "money_cutover_preimage",
    "money_cutover_aggregates",
    "wallet_credit_lot_classification_proofs",
    "money_cutover_freeze",
  ];
  const observed = classifyMoneyD1StripeRealmCensus(
    sourceCensus(names, {
      money_cutover_preimage: 1,
      money_cutover_aggregates: 1,
      wallet_credit_lot_classification_proofs: 1,
      money_cutover_freeze: 1,
    }),
  );
  expect(observed.totals.known_financial.rows).toBe(3);
  expect(observed.totals.unknown_financial_prefix.rows).toBe(1);
  let factReads = 0;
  const structural = Object.defineProperty(
    {
      kind: "takoserver.money-held-convert-context@v1",
    },
    "facts",
    {
      get() {
        factReads += 1;
        return { original92: {}, converted94: {}, current94: {} };
      },
    },
  );
  await expect(inspectMoneyD1StripeRealmTransition(structural)).rejects.toBeInstanceOf(
    MoneyRealmDiagnosticError,
  );
  expect(factReads).toBe(0);
});

test("named permit, authorized epoch and policy rows remain distinct census observations", () => {
  const names = [
    "money_cutover_writer_permit",
    "money_cutover_authorized_epoch",
    "money_unit_policy",
  ];
  const observed = classifyMoneyD1StripeRealmCensus(
    sourceCensus(names, {
      money_cutover_authorized_epoch: 1,
      money_unit_policy: 1,
    }),
  );
  expect(observed.totals.unknown_financial_prefix).toEqual({
    tables: 2,
    rows: 1,
    nonzeroTables: 1,
  });
  expect(observed.totals.control_unqualified).toEqual({
    tables: 1,
    rows: 1,
    nonzeroTables: 1,
  });
  expect(
    observed.observations.find((item) => item.name === "money_cutover_writer_permit")?.rows,
  ).toBe(0);
  const missingPermit = classifyMoneyD1StripeRealmCensus(sourceCensus(names.slice(1)));
  expect(
    missingPermit.observations.find((item) => item.name === "money_cutover_writer_permit"),
  ).toBeUndefined();
});

test("a structural policy tuple cannot authenticate the Root-held context", async () => {
  let factReads = 0;
  const structural = Object.defineProperty(
    {
      kind: "takoserver.money-held-convert-context@v1",
    },
    "facts",
    {
      get() {
        factReads += 1;
        return {
          current94: { rowCounts: { money_unit_policy: 1 } },
          expectedPolicy: {
            ledger_unit: "usd-micros-v2",
            historical_usage_unit: "microcent-v1",
            cash_unit: "usd-cents-v1",
          },
        };
      },
    },
  );
  await expect(inspectMoneyD1StripeRealmTransition(structural)).rejects.toBeInstanceOf(
    MoneyRealmDiagnosticError,
  );
  expect(factReads).toBe(0);
});

import {
  assessMoneyD1StripeRealmHistoryData,
  prepareMoneyD1StripeRealmTransition,
} from "../scripts/deploy/stripe-mode-realm.ts";

const modelDigest = (value: number) => `sha256:${value.toString(16).padStart(64, "0")}`;
type RealmHistoryFacts = Parameters<typeof assessMoneyD1StripeRealmHistoryData>[0];

/**
 * Synthetic DATA for pure source predicates only. This deliberately omits the
 * physical/native owner graph and never constructs or qualifies a Root context.
 * Positive authentic Root preparation/second-assert drift remains UNRUN.
 */
const REALM_POST94_STAGE_TABLES = [
  "stripe_billing_associations",
  "stripe_billing_checkouts",
  "stripe_billing_commands",
  "stripe_billing_customers",
  "stripe_billing_fences",
  "stripe_billing_grants",
  "stripe_billing_object_claims",
  "stripe_billing_price_identity",
  "stripe_billing_price_identity_checks",
  "stripe_billing_pricing",
  "stripe_billing_reconcile",
  "stripe_billing_reconcile_failures",
  "stripe_billing_refund_observations",
  "stripe_billing_refunds",
  "stripe_billing_subscriptions",
  "stripe_subscription_cancellation_intents",
  "stripe_subscription_checkout_intents",
  "stripe_subscription_custody_reconcile",
] as const;

function realmHistoryDataModel(): RealmHistoryFacts {
  const known = [
    ...new Set(
      [...STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES, ...MONEY_CUTOVER_FINANCIAL_TABLES].filter(
        (name) => !new Set<string>(REALM_POST94_STAGE_TABLES).has(name),
      ),
    ),
    "principals",
  ];
  const original = sourceCensus(known, { principals: 3 });
  const converted = sourceCensus(
    [
      ...known,
      "money_cutover_freeze",
      "money_cutover_writer_permit",
      "money_cutover_authorized_epoch",
      "money_unit_policy",
    ],
    {
      principals: 3,
      money_cutover_freeze: 1,
      money_cutover_authorized_epoch: 1,
      money_unit_policy: 1,
    },
  );
  const shared = {
    preimageDigest: modelDigest(3),
    aggregateDigest: modelDigest(4),
    financialDigest: modelDigest(5),
  };
  return {
    schemaPhase: "0094-fenced",
    selectedStripeMode: "test",
    previousWriterEpoch: modelDigest(10),
    nextWriterEpoch: modelDigest(11),
    original92: {
      ...original,
      ...shared,
      sourceDigest: modelDigest(92),
      backupDigest: modelDigest(1),
      identityDigest: modelDigest(12),
      allDataDigest: modelDigest(13),
    },
    converted94: {
      ...converted,
      ...shared,
      sourceDigest: modelDigest(94),
      backupDigest: modelDigest(2),
      identityDigest: modelDigest(14),
      allDataDigest: modelDigest(15),
    },
    current94: {
      ...structuredClone(converted),
      allDataDigest: modelDigest(15),
      schemaShapeDigest: modelDigest(16),
      freezeBindingDigest: modelDigest(17),
      authorizedWriterEpoch: modelDigest(10),
    },
    conversion: {
      source94Digest: modelDigest(94),
      originDigest: modelDigest(18),
      convertBindingDigest: modelDigest(23),
      convertPostDigest: modelDigest(19),
      convertImportDigest: modelDigest(33),
      freezeBindingDigest: modelDigest(17),
      preimageDigest: modelDigest(3),
      aggregateDigest: modelDigest(4),
      classificationDigest: modelDigest(6),
      classifications: [],
      writerDigest: modelDigest(7),
      retained: ["freeze", "prepare", "classify", "convert"].map((phase, index) => ({
        phase,
        bindingDigest: modelDigest(20 + index),
        receiptDigest: modelDigest(40 + index),
        importDigest: modelDigest(30 + index),
        sourceDigest: modelDigest(index === 3 ? 94 : 93),
      })),
    },
  } as unknown as RealmHistoryFacts;
}

function modelStageRows(
  facts: RealmHistoryFacts,
  stage: "original92" | "converted94" | "current94",
  name: string,
  count: number,
) {
  const selected = facts[stage];
  const names = selected.tableInventory.includes(name)
    ? [...selected.tableInventory]
    : [...selected.tableInventory, name].sort();
  Object.assign(selected, {
    tableInventory: names,
    rowCounts: { ...selected.rowCounts, [name]: count },
  });
}

test("pure history DATA satisfies zero-origin and six conversion predicates while policy stays unproven", () => {
  const result = assessMoneyD1StripeRealmHistoryData(realmHistoryDataModel());
  expect(result.zeroOrigin).toBe("source_predicates_satisfied");
  expect(result.convertedHistoryExceptPolicy).toBe("source_predicates_satisfied");
  expect(result.refusals).toEqual([]);
  expect(result.policyTuple).toBe("not_established");
  expect(
    result.namedArtifacts.filter(
      (item) => item.sourceEvidence === "consistent_with_fixed_root_checks",
    ),
  ).toHaveLength(6);
  expect(result.namedArtifacts.find((item) => item.artifact === "money_unit_policy")).toMatchObject(
    { currentRows: 1, sourceEvidence: "not_established" },
  );
  expect(Object.isFrozen(result.census.current94.observations)).toBe(true);
});

test("each of the 42 actual Financial vocabulary tables refuses nonzero original history", () => {
  expect(STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES).toHaveLength(42);
  for (const name of STRIPE_REALM_AMBIGUOUS_HISTORY_TABLES) {
    const facts = realmHistoryDataModel();
    modelStageRows(facts, "original92", name, 1);
    const result = assessMoneyD1StripeRealmHistoryData(facts);
    expect(result.zeroOrigin).toBe("refused");
    expect(result.refusals).toContain("original92_financial_rows");
  }
});

test("unknown Financial-prefix tables refuse in every phase even with zero rows", () => {
  for (const stage of ["original92", "converted94", "current94"] as const) {
    for (const prefix of [
      "stripe_",
      "wallet_",
      "org_wallet_",
      "money_",
      "usage_",
      "reseller_settlement_",
      "provider_meter_",
      "sponsorship_",
    ]) {
      for (const count of [0, 1]) {
        const facts = realmHistoryDataModel();
        modelStageRows(facts, stage, `${prefix}unrecognized_history`, count);
        const result = assessMoneyD1StripeRealmHistoryData(facts);
        expect(result.refusals).toContain(`${stage}_unknown_financial_prefix`);
        expect(result.convertedHistoryExceptPolicy).toBe("refused");
      }
    }
  }
});

test("a missing actual preimage source is not replaced with a synthetic zero count", () => {
  const facts = realmHistoryDataModel();
  const { ledger: _missing, ...rowCounts } = facts.original92.rowCounts;
  Object.assign(facts.original92, {
    rowCounts,
    tableInventory: facts.original92.tableInventory.filter((name) => name !== "ledger"),
  });
  const result = assessMoneyD1StripeRealmHistoryData(facts);
  expect(result.zeroOrigin).toBe("refused");
  expect(result.refusals).toContain("original92_required_source_missing");
});

test("non-Financial principal rows remain in the complete DATA census without becoming financial history", () => {
  const result = assessMoneyD1StripeRealmHistoryData(realmHistoryDataModel());
  for (const stage of ["original92", "converted94", "current94"] as const) {
    expect(result.census[stage].observations.find((item) => item.name === "principals")).toEqual({
      name: "principals",
      rows: 3,
      classification: "outside_vocabulary",
    });
  }
  expect(result.zeroOrigin).toBe("source_predicates_satisfied");
});

test("equal protected/current arbitrary Financial rows do not acquire conversion provenance", () => {
  const facts = realmHistoryDataModel();
  modelStageRows(facts, "converted94", "stripe_events", 1);
  modelStageRows(facts, "current94", "stripe_events", 1);
  const result = assessMoneyD1StripeRealmHistoryData(facts);
  expect(result.zeroOrigin).toBe("source_predicates_satisfied");
  expect(result.refusals).toContain("converted94_financial_rows_unbound");
  expect(result.refusals).toContain("current94_financial_rows_unbound");
  expect(result.convertedHistoryExceptPolicy).toBe("refused");
});

test("original-to-conversion source, retained command and freeze or epoch mismatches refuse", () => {
  const changes: ((facts: RealmHistoryFacts) => void)[] = [
    (facts) => Object.assign(facts.conversion, { source94Digest: modelDigest(999) }),
    (facts) => Object.assign(facts.conversion.retained[3]!, { bindingDigest: modelDigest(999) }),
    (facts) => Object.assign(facts.conversion.retained[3]!, { importDigest: modelDigest(999) }),
    (facts) => Object.assign(facts.conversion.retained[0]!, { phase: "prepare" }),
    (facts) => Object.assign(facts.conversion, { preimageDigest: modelDigest(999) }),
    (facts) => Object.assign(facts.converted94, { aggregateDigest: modelDigest(999) }),
    (facts) => Object.assign(facts.current94, { freezeBindingDigest: modelDigest(999) }),
    (facts) => Object.assign(facts.current94, { authorizedWriterEpoch: facts.nextWriterEpoch }),
  ];
  for (const change of changes) {
    const facts = realmHistoryDataModel();
    change(facts);
    expect(assessMoneyD1StripeRealmHistoryData(facts).convertedHistoryExceptPolicy).toBe("refused");
  }
});

test("all-table counts, inventory and whole typed bytes must match protected94 and current94", () => {
  for (const change of [
    (facts: RealmHistoryFacts) => modelStageRows(facts, "current94", "principals", 4),
    (facts: RealmHistoryFacts) => modelStageRows(facts, "current94", "unrelated_new_table", 0),
    (facts: RealmHistoryFacts) =>
      Object.assign(facts.current94, { allDataDigest: modelDigest(999) }),
  ]) {
    const facts = realmHistoryDataModel();
    change(facts);
    expect(assessMoneyD1StripeRealmHistoryData(facts).refusals).toContain(
      "protected_current_census_differs",
    );
  }
});

test("a singleton policy count or an extra purported tuple never authenticates its value", () => {
  const facts = realmHistoryDataModel();
  Object.assign(facts, {
    expectedPolicy: {
      singleton: 1,
      ledger_unit: "usd-micros-v2",
      historical_usage_unit: "microcent-v1",
      cash_unit: "usd-cents-v1",
    },
  });
  expect(assessMoneyD1StripeRealmHistoryData(facts).policyTuple).toBe("not_established");
  for (const count of [0, 2]) {
    const altered = realmHistoryDataModel();
    modelStageRows(altered, "converted94", "money_unit_policy", count);
    modelStageRows(altered, "current94", "money_unit_policy", count);
    expect(assessMoneyD1StripeRealmHistoryData(altered).refusals).toContain(
      "policy_row_count_unexpected",
    );
  }
});

test("original controls and any pre-suffix realm table cannot become TEST evidence", () => {
  const facts = realmHistoryDataModel();
  modelStageRows(facts, "original92", "money_unit_policy", 1);
  expect(assessMoneyD1StripeRealmHistoryData(facts).refusals).toContain(
    "original92_control_rows_unqualified",
  );
  for (const stage of ["original92", "converted94", "current94"] as const) {
    const altered = realmHistoryDataModel();
    modelStageRows(altered, stage, "stripe_mode_realm", 0);
    expect(assessMoneyD1StripeRealmHistoryData(altered).refusals).toContain(
      "pre_suffix_realm_table_present",
    );
  }
});

test("preparation authenticates Root identity before facts and refuses forged or copied DATA", async () => {
  let factReads = 0;
  const forged = Object.defineProperty(
    { kind: "takoserver.money-held-convert-context@v1" },
    "facts",
    {
      get() {
        factReads += 1;
        throw new Error("Financial facts read before Root assertion");
      },
    },
  );
  const data = { kind: "takoserver.money-held-convert-context@v1", facts: realmHistoryDataModel() };
  for (const context of [forged, data, { ...data }, JSON.parse(JSON.stringify(data))]) {
    await expect(prepareMoneyD1StripeRealmTransition(context)).rejects.toBeInstanceOf(
      MoneyRealmDiagnosticError,
    );
  }
  expect(factReads).toBe(0);
});

test("all 20 actual Money source tables are classified, including exact issuance zero-origin DATA", () => {
  expect(MONEY_CUTOVER_FINANCIAL_TABLES).toHaveLength(20);
  const census = classifyMoneyD1StripeRealmCensus(sourceCensus(MONEY_CUTOVER_FINANCIAL_TABLES));
  expect(census.totals.known_financial).toEqual({ tables: 20, rows: 0, nonzeroTables: 0 });
  expect(census.totals.unknown_financial_prefix.tables).toBe(0);
  const result = assessMoneyD1StripeRealmHistoryData(realmHistoryDataModel());
  expect(
    result.census.original92.observations.find(
      (item) => item.name === "sponsorship_credential_issuance_operations",
    ),
  ).toEqual({
    name: "sponsorship_credential_issuance_operations",
    rows: 0,
    classification: "known_financial",
  });
  expect(result.zeroOrigin).toBe("source_predicates_satisfied");
  expect(result.policyTuple).toBe("not_established");
});

test("exact issuance history and similarly named unknown tables cannot use the zero-origin route", () => {
  const name = "sponsorship_credential_issuance_operations";
  const original = realmHistoryDataModel();
  modelStageRows(original, "original92", name, 1);
  expect(assessMoneyD1StripeRealmHistoryData(original).refusals).toContain(
    "original92_financial_rows",
  );
  const converted = realmHistoryDataModel();
  modelStageRows(converted, "converted94", name, 1);
  modelStageRows(converted, "current94", name, 1);
  const result = assessMoneyD1StripeRealmHistoryData(converted);
  expect(result.refusals).toContain("converted94_financial_rows_unbound");
  expect(result.refusals).toContain("current94_financial_rows_unbound");
  for (const unknown of [`${name}_future`, "sponsorship_credential_issuance_operation"]) {
    const census = classifyMoneyD1StripeRealmCensus(sourceCensus([unknown]));
    expect(census.observations[0]?.classification).toBe("unknown_financial_prefix");
    const facts = realmHistoryDataModel();
    modelStageRows(facts, "original92", unknown, 0);
    expect(assessMoneyD1StripeRealmHistoryData(facts).refusals).toContain(
      "original92_unknown_financial_prefix",
    );
  }
});

// Independent synthetic rows for the four values selected by the existing Money
// guard. Recognition here is DATA, not evidence that Root observed this row.
function policyTupleDataRow() {
  return {
    singleton: 1,
    ledger_unit: "usd-micros-v2",
    historical_usage_unit: "microcent-v1",
    cash_unit: "usd-cents-v1",
  };
}

test("policy tuple DATA is detached and immutable after its caller row changes", () => {
  const row = policyTupleDataRow();
  const rows = [row];
  const result = classifyMoneyD1StripeRealmPolicyTupleData(rows);
  expect(result.scope).toBe("financial-policy-tuple-data-only");
  expect(result.classification).toBe("expected_tuple_data");
  if (result.classification !== "expected_tuple_data")
    throw Error("expected fixture tuple missing");
  expect(Object.is(result.tuple, row)).toBe(false);
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.tuple)).toBe(true);
  row.cash_unit = "caller-replaced-cash-unit";
  expect(result.tuple.cash_unit).toBe("usd-cents-v1");
  expect(classifyMoneyD1StripeRealmPolicyTupleData(rows).classification).toBe("refused");
  rows.push(policyTupleDataRow());
  expect(classifyMoneyD1StripeRealmPolicyTupleData(rows).classification).toBe("refused");
  expect(Reflect.set(result.tuple, "cash_unit", "caller-replaced-cash-unit")).toBe(false);
  expect(Reflect.set(result, "classification", "established")).toBe(false);
  expect(result.classification).toBe("expected_tuple_data");
});

test("closed policy tuple DATA refuses malformed rows and every changed field", () => {
  const fields = ["singleton", "ledger_unit", "historical_usage_unit", "cash_unit"] as const;
  for (const field of fields) {
    const missing: Record<string, unknown> = policyTupleDataRow();
    delete missing[field];
    expect(classifyMoneyD1StripeRealmPolicyTupleData([missing]).classification).toBe("refused");
    for (const wrong of [null, undefined, false, 0, "wrong-unit"]) {
      expect(
        classifyMoneyD1StripeRealmPolicyTupleData([{ ...policyTupleDataRow(), [field]: wrong }])
          .classification,
      ).toBe("refused");
    }
  }
  expect(
    classifyMoneyD1StripeRealmPolicyTupleData([{ ...policyTupleDataRow(), singleton: "1" }])
      .classification,
  ).toBe("refused");
  const inherited: unknown = Object.create(policyTupleDataRow());
  const inheritedPrototype: unknown = Object.assign(
    Object.create({ other: "inherited" }),
    policyTupleDataRow(),
  );
  const symbolRow = Object.assign(policyTupleDataRow(), { [Symbol("extra")]: 1 });
  const decorated = Object.assign([policyTupleDataRow()], { extra: 1 });
  const sparse = Array(1);
  for (const malformed of [
    null,
    {},
    [],
    [null],
    [policyTupleDataRow(), policyTupleDataRow()],
    [{ ...policyTupleDataRow(), extra: 1 }],
    [inherited],
    [inheritedPrototype],
    [symbolRow],
    decorated,
    sparse,
  ]) {
    const result = classifyMoneyD1StripeRealmPolicyTupleData(malformed);
    expect(result.classification).toBe("refused");
    expect(result.tuple).toBeNull();
    expect(Object.isFrozen(result)).toBe(true);
  }
});

test("policy tuple DATA never invokes row or array getters to recognize a value", () => {
  let getters = 0;
  for (const field of ["singleton", "ledger_unit", "historical_usage_unit", "cash_unit"] as const) {
    const original = policyTupleDataRow();
    const row = Object.defineProperty(policyTupleDataRow(), field, {
      enumerable: true,
      get() {
        getters++;
        return original[field];
      },
    });
    expect(classifyMoneyD1StripeRealmPolicyTupleData([row]).classification).toBe("refused");
  }
  const rows = Object.defineProperty([policyTupleDataRow()], "0", {
    enumerable: true,
    get() {
      getters++;
      return policyTupleDataRow();
    },
  });
  expect(classifyMoneyD1StripeRealmPolicyTupleData(rows).classification).toBe("refused");
  expect(getters).toBe(0);
});

test("fixed policy predicate DATA has immutable ordered binds and accepts no caller input", () => {
  const first = buildMoneyD1StripeRealmPolicyTuplePredicateData();
  const second = buildMoneyD1StripeRealmPolicyTuplePredicateData();
  expect(first.scope).toBe("financial-policy-tuple-predicate-data-only");
  expect(first.params).toEqual([1, "usd-micros-v2", "microcent-v1", "usd-cents-v1"]);
  expect(first).toEqual(second);
  expect(Object.is(first, second)).toBe(false);
  expect(Object.is(first.params, second.params)).toBe(false);
  expect(Object.isFrozen(first)).toBe(true);
  expect(Object.isFrozen(first.params)).toBe(true);
  expect(Reflect.set(first.params, "0", 2)).toBe(false);
  expect(Reflect.set(first, "sql", "caller SQL")).toBe(false);
  let callbacks = 0,
    getters = 0;
  const callback = () => {
    callbacks++;
    return policyTupleDataRow();
  };
  const caller = Object.defineProperty({}, "sql", {
    get() {
      getters++;
      return "caller SQL";
    },
  });
  for (const payload of ["caller SQL", { table: "caller_table" }, [1, 2, 3, 4], callback, caller]) {
    let failure: unknown;
    try {
      Reflect.apply(buildMoneyD1StripeRealmPolicyTuplePredicateData, undefined, [payload]);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(TypeError);
    if (!(failure instanceof TypeError)) throw Error("fixed predicate input rejection missing");
    expect(failure.message).toBe("Financial policy predicate accepts no input");
  }
  expect(callbacks).toBe(0);
  expect(getters).toBe(0);
  expect(second.params).toEqual([1, "usd-micros-v2", "microcent-v1", "usd-cents-v1"]);
});

test("policy DATA cannot qualify history or a forged Root context", async () => {
  const policyData = classifyMoneyD1StripeRealmPolicyTupleData([policyTupleDataRow()]);
  const predicateData = buildMoneyD1StripeRealmPolicyTuplePredicateData();
  expect(policyData.classification).toBe("expected_tuple_data");
  const facts = realmHistoryDataModel();
  expect(assessMoneyD1StripeRealmHistoryData(facts).policyTuple).toBe("not_established");
  let factReads = 0;
  const forged = Object.defineProperty(
    { kind: "takoserver.money-held-convert-context@v1", policyData, predicateData },
    "facts",
    {
      get() {
        factReads++;
        return facts;
      },
    },
  );
  await expect(prepareMoneyD1StripeRealmTransition(forged)).rejects.toBeInstanceOf(
    MoneyRealmDiagnosticError,
  );
  expect(factReads).toBe(0);
});

import {
  compileMoneyD1StripeRealmPinDraftData,
  readMoneyD1StripeRealmPinSourceDraft,
} from "../scripts/deploy/stripe-mode-realm.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
} from "../src/money-cutover-sql.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";

/** Capture canonical <=94 facts before applying the complete existing95-98 suffix.
 * This fixture never constructs an original native Root context or mode proof. */
async function realmPinDraftFixture() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    if (migration.name.slice(0, 4) <= "0094") db.exec(migration.sql);
  }
  db.exec(MONEY_CUTOVER_FREEZE_DDL);
  db.exec(MONEY_CUTOVER_PERMIT_DDL);
  db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
  const sql = createSqliteSql(db);
  const facts = realmHistoryDataModel();
  await sql.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [
    facts.previousWriterEpoch,
  ]);
  await sql.run("INSERT INTO money_cutover_freeze VALUES (1, ?, ?, ?, ?, ?)", [
    facts.current94.freezeBindingDigest,
    facts.conversion.originDigest,
    facts.original92.backupDigest,
    facts.conversion.writerDigest,
    facts.original92.sourceDigest,
  ]);
  const rows = await sql.query(
    "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  const names = rows.map((row) => {
    if (typeof row.name !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(row.name))
      throw new Error("unexpected fixture table name");
    return row.name;
  });
  const counts: Record<string, number> = {};
  for (const name of names) {
    const count = (await sql.query(`SELECT count(*) AS n FROM "${name}"`))[0]?.n;
    if (typeof count !== "number" || !Number.isSafeInteger(count))
      throw new Error("bad fixture count");
    counts[name] = count;
  }
  const originalNames = names.filter(
    (name) =>
      ![
        "money_unit_policy",
        "money_cutover_freeze",
        "money_cutover_writer_permit",
        "money_cutover_authorized_epoch",
      ].includes(name),
  );
  Object.assign(facts.original92, sourceCensus(originalNames));
  Object.assign(facts.converted94, sourceCensus(names, counts));
  Object.assign(facts.current94, sourceCensus(names, counts), {
    applied: MIGRATIONS.filter((migration) => migration.name.slice(0, 4) <= "0094").map(
      (migration) => migration.name,
    ),
  });
  for (const migration of MIGRATIONS) {
    const ordinal = migration.name.slice(0, 4);
    if (ordinal >= "0095" && ordinal <= "0097") db.exec(migration.sql);
  }
  const pin = MIGRATIONS.find((migration) => migration.name === "0098_stripe_mode_realm.sql");
  if (!pin) throw new Error("canonical pin migration unavailable");
  db.exec(pin.sql);
  const draft = compileMoneyD1StripeRealmPinDraftData(facts);
  expect(await sql.query(draft.statements[0].sql, draft.statements[0].params)).toEqual([
    { required_financial_realm: 1 },
  ]);
  return { db, sql, facts, draft };
}

/** The prefix oracle has a distinct JSON-path error if it has not been reached.
 * Only the candidate's malformed-JSON SQL error satisfies the late-fault oracle. */
async function expectRealmDraftRollback(sql: Sql, statements: readonly SqlStatement[]) {
  const prefix = {
    sql: `INSERT INTO principals (id,provider,provider_subject,email,display_name,created_at)
      VALUES ('financial:prefix','google','financial:prefix','fixture@invalid.example','fixture','2026-10-18T00:00:00.000Z')`,
  };
  const prefixReached = {
    sql: `SELECT json_extract('[1]', CASE WHEN EXISTS (
      SELECT 1 FROM principals WHERE id='financial:prefix' AND provider_subject='financial:prefix'
    ) THEN '$[0]' ELSE 'financial-prefix-not-reached' END) AS fixture_prefix_reached`,
  };
  let failure: unknown;
  try {
    await sql.batch([prefix, prefixReached, ...statements]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SqlError);
  if (!(failure instanceof SqlError)) throw new Error("expected candidate SQL failure");
  expect(failure.code).toBe("unavailable");
  expect(failure.message.toLowerCase()).toContain("malformed json");
  expect(await sql.query("SELECT id FROM principals WHERE id='financial:prefix'")).toEqual([]);
}

test("realm draft DATA refuses nonzero history, unknown zero tables and non-TEST selection", () => {
  const unknown = realmHistoryDataModel();
  modelStageRows(unknown, "converted94", "stripe_unrecognized_pin_source", 0);
  modelStageRows(unknown, "current94", "stripe_unrecognized_pin_source", 0);
  const historical = realmHistoryDataModel();
  modelStageRows(historical, "original92", "ledger", 1);
  const otherMode = realmHistoryDataModel();
  Object.assign(otherMode, { selectedStripeMode: "live" });
  for (const facts of [unknown, historical, otherMode]) {
    expect(() => compileMoneyD1StripeRealmPinDraftData(facts)).toThrow(
      "Financial realm census is malformed",
    );
  }
});

test("realm draft DATA detaches all facts and ordered bind vectors without a permission", () => {
  const facts = realmHistoryDataModel();
  const draft = compileMoneyD1StripeRealmPinDraftData(facts);
  const source = draft.sourceFactsJson;
  Object.assign(facts.current94.rowCounts, { ledger: 9 });
  Object.assign(facts, { previousWriterEpoch: modelDigest(999) });
  expect(draft.sourceFactsJson).toBe(source);
  expect(draft.scope).toBe("financial-realm-pin-source-data-only");
  expect(draft.contribution).toBe(null);
  expect(draft.normalWorkerMode).toBe("not_established");
  expect(draft.statements).toHaveLength(3);
  expect(draft.statements[0].params.slice(0, 4)).toEqual([
    1,
    "usd-micros-v2",
    "microcent-v1",
    "usd-cents-v1",
  ]);
  expect(draft.statements[0].params).toEqual(draft.statements[2].params);
  expect(draft.statements[0].params.length).toBeLessThanOrEqual(100);
  expect(draft.statements[1].params).toEqual([]);
  expect(Reflect.set(draft.statements[0].params, "0", 2)).toBe(false);
  expect(Reflect.set(draft.statements[1], "sql", "caller SQL")).toBe(false);
  expect(Object.isFrozen(draft)).toBe(true);
  // Descriptor side effects mutate the borrowed DTO only AFTER its old epoch
  // was encoded. SQL must be built from the same detached encoded observation.
  const borrowed = realmHistoryDataModel();
  Object.assign(borrowed, { zzMutation: 0 });
  let descriptors = 0;
  const changing = new Proxy(borrowed, {
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Reflect.getOwnPropertyDescriptor(target, key);
      if (key === "zzMutation" && ++descriptors === 2) {
        Object.assign(target, { previousWriterEpoch: modelDigest(999) });
      }
      return descriptor;
    },
  });
  const captured = compileMoneyD1StripeRealmPinDraftData(changing);
  expect(borrowed.previousWriterEpoch).toBe(modelDigest(999));
  expect(captured.sourceFactsJson).toContain(modelDigest(10));
  expect(captured.sourceFactsJson).not.toContain(modelDigest(999));
  expect(captured.statements[0].params).toContain(modelDigest(10));
  expect(captured.statements[0].params).not.toContain(modelDigest(999));
});

test("realm draft internal source encoding binds large own DATA without a public wire cap", () => {
  const facts = realmHistoryDataModel();
  const extra = { retainedSourceNote: "x".repeat(32768) };
  Object.assign(facts, { syntheticEncodingOnly: extra });
  const draft = compileMoneyD1StripeRealmPinDraftData(facts);
  extra.retainedSourceNote = "changed";
  expect(draft.sourceFactsJson).toContain("x".repeat(32768));
  expect(draft.sourceFactsJson).not.toContain("changed");
  let reads = 0;
  Object.defineProperty(facts, "getter", {
    enumerable: true,
    get() {
      reads++;
      return 1;
    },
  });
  expect(() => compileMoneyD1StripeRealmPinDraftData(facts)).toThrow();
  expect(reads).toBe(0);
});

test("realm source draft SQL pins exact singleton TEST with three returned DB metadata fields", async () => {
  const f = await realmPinDraftFixture();
  try {
    const result = await f.sql.batch(f.draft.statements);
    expect(result).toHaveLength(3);
    const pinResult = result[1];
    if (pinResult === undefined) throw new Error("realm pin INSERT result is missing");
    expect(result[0]?.rows).toEqual([{ required_financial_realm: 1 }]);
    expect(result[2]?.rows).toEqual([{ required_financial_realm: 1 }]);
    const row = pinResult.rows[0];
    expect(Object.keys(row ?? {}).sort()).toEqual(["mode", "pinned_at", "singleton"]);
    expect(row).toMatchObject({ singleton: 1, mode: "test" });
    expect(row?.pinned_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u);
    expect(await f.sql.query("SELECT singleton, mode, pinned_at FROM stripe_mode_realm")).toEqual(
      pinResult.rows,
    );
  } finally {
    f.db.close();
  }
});

test("realm source draft fixed policy or full freeze bind mismatch causes SQL error and rolls back prefix", async () => {
  const f = await realmPinDraftFixture();
  try {
    // Negative SQL DATA only: compiler output stays immutable and accepts no
    // caller tuple. Do not relax the canonical table's own CHECK constraints.
    expect(await f.sql.query("SELECT cash_unit FROM money_unit_policy")).toEqual([
      { cash_unit: "usd-cents-v1" },
    ]);
    const [pre, insert, post] = f.draft.statements;
    const positions = [
      3,
      ...Array.from({ length: 5 }, (_, index) => pre.params.length - 5 + index),
    ];
    for (const position of positions) {
      const wrong = [...pre.params];
      wrong[position] = "wrong-unit-or-freeze-source";
      await expectRealmDraftRollback(f.sql, [{ sql: pre.sql, params: wrong }, insert, post]);
    }
    expect(await f.sql.query("SELECT * FROM stripe_mode_realm")).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("realm pre-assert rejects extra INSERT RAISE IGNORE outside its trigger and rolls back prefix", async () => {
  const f = await realmPinDraftFixture();
  try {
    f.db.exec(
      "CREATE TRIGGER financial_test_ignore_pin BEFORE INSERT ON stripe_mode_realm BEGIN SELECT RAISE(IGNORE); END",
    );
    expect(
      await f.sql.query("SELECT name FROM sqlite_schema WHERE name='financial_test_ignore_pin'"),
    ).toEqual([{ name: "financial_test_ignore_pin" }]);
    const ignored = await f.sql.run(f.draft.statements[1].sql, f.draft.statements[1].params);
    expect(ignored.rows).toEqual([]);
    expect(ignored.changes).toBe(0);
    await expectRealmDraftRollback(f.sql, f.draft.statements);
    expect(await f.sql.query("SELECT * FROM stripe_mode_realm")).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("realm occupied pin refuses another fragment and retains the exact original metadata", async () => {
  const f = await realmPinDraftFixture();
  try {
    const result = await f.sql.batch(f.draft.statements);
    const pinResult = result[1];
    if (pinResult === undefined) throw new Error("realm pin INSERT result is missing");
    const original = pinResult.rows;
    expect(original).toHaveLength(1);
    await expectRealmDraftRollback(f.sql, f.draft.statements);
    expect(await f.sql.query("SELECT singleton, mode, pinned_at FROM stripe_mode_realm")).toEqual(
      original,
    );
  } finally {
    f.db.close();
  }
});

test("realm post-assert refuses SQLite changes zero after forbidden interposition and rolls back pin", async () => {
  const f = await realmPinDraftFixture();
  try {
    const [pre, insert, post] = f.draft.statements;
    await expectRealmDraftRollback(f.sql, [
      pre,
      insert,
      {
        sql: "DELETE FROM principals WHERE id='not-present-fixture-row'",
      },
      post,
    ]);
    expect(await f.sql.query("SELECT * FROM stripe_mode_realm")).toEqual([]);
  } finally {
    f.db.close();
  }
});

test("realm source draft noncanonical pin schema fails before pin and prefix commit", async () => {
  for (const corrupted of ["missing", "body", "extra-index"] as const) {
    const f = await realmPinDraftFixture();
    try {
      if (corrupted === "extra-index") {
        f.db.exec("CREATE INDEX financial_test_extra_pin_index ON stripe_mode_realm(mode)");
      } else {
        f.db.exec("DROP TRIGGER stripe_mode_realm_no_delete");
        if (corrupted === "body")
          f.db.exec(
            "CREATE TRIGGER stripe_mode_realm_no_delete BEFORE DELETE ON stripe_mode_realm BEGIN SELECT 1; END",
          );
      }
      await expectRealmDraftRollback(f.sql, f.draft.statements);
      expect(await f.sql.query("SELECT * FROM stripe_mode_realm")).toEqual([]);
    } finally {
      f.db.close();
    }
  }
});

test("real curated Root assertion refuses forged changing context before any draft facts getter", async () => {
  let reads = 0;
  const forged = Object.defineProperty(
    { kind: "takoserver.money-held-convert-context@v1" },
    "facts",
    {
      get() {
        reads++;
        return realmHistoryDataModel();
      },
    },
  );
  const pending = readMoneyD1StripeRealmPinSourceDraft(forged);
  Object.assign(forged, { changedDuringAwait: true });
  await expect(pending).rejects.toBeInstanceOf(MoneyRealmDiagnosticError);
  expect(reads).toBe(0);
  // Authentic native-positive/after-Root-await drift stays UNPREPARED/UNRUN:
  // no local context map, mock assertion, callback issuer or fake native factory.
});

test("canonical sponsorship cutover tables are finite Financial DATA and retain nonzero history refusal", () => {
  for (const name of [
    "sponsorship_cutover_operation_starts",
    "sponsorship_cutover_operation_completions",
  ]) {
    expect(classifyMoneyD1StripeRealmCensus(sourceCensus([name])).observations).toEqual([
      { name, rows: 0, classification: "known_financial" },
    ]);
    const zero = realmHistoryDataModel();
    for (const stage of ["original92", "converted94", "current94"] as const)
      modelStageRows(zero, stage, name, 0);
    const clean = assessMoneyD1StripeRealmHistoryData(zero);
    expect(clean.zeroOrigin).toBe("source_predicates_satisfied");
    expect(clean.convertedHistoryExceptPolicy).toBe("source_predicates_satisfied");
    expect(clean.policyTuple).toBe("not_established");
    for (const stage of ["original92", "converted94", "current94"] as const) {
      const nonzero = structuredClone(zero);
      modelStageRows(nonzero, stage, name, 1);
      const rejected = assessMoneyD1StripeRealmHistoryData(nonzero);
      expect(rejected.refusals).toContain(
        stage === "original92" ? "original92_financial_rows" : `${stage}_financial_rows_unbound`,
      );
      expect(rejected.convertedHistoryExceptPolicy).toBe("refused");
      const unknown = structuredClone(zero);
      modelStageRows(unknown, stage, `${name}_future`, 0);
      const refused = assessMoneyD1StripeRealmHistoryData(unknown);
      expect(refused.refusals).toContain(`${stage}_unknown_financial_prefix`);
      expect(refused.convertedHistoryExceptPolicy).toBe("refused");
    }
  }
});

import {
  compileMoneyD1StripeRealmNormalModeDraftData,
  readMoneyD1StripeRealmNormalModePinSourceDraft,
} from "../scripts/deploy/stripe-mode-realm.ts";

/** Synthetic DATA only; the real Root assertion must reject these shapes. */
function realmNormalModeDataModel() {
  const facts = realmHistoryDataModel();
  const storage = {
    accountId: "synthetic-account",
    databaseId: "synthetic-database-id",
    databaseName: "synthetic-database",
    bucketName: "synthetic-bucket",
  };
  Object.assign(facts, { storage });
  const mode: Parameters<typeof compileMoneyD1StripeRealmNormalModeDraftData>[1] = {
    kind: "takoserver.money-held-normal-worker-mode-facts@v1",
    ...storage,
    workerName: "synthetic-normal-worker",
    previousWriterEpoch: facts.previousWriterEpoch,
    nextWriterEpoch: facts.nextWriterEpoch,
    heldConvertDigest: modelDigest(50),
    convertBindingDigest: facts.conversion.convertBindingDigest,
    converted94BackupDigest: facts.converted94.backupDigest,
    versionId: "synthetic-native-version",
    sourceCommit: "1".repeat(40),
    moduleDigest: modelDigest(51),
    sourceArtifactDigest: modelDigest(52),
    sourceArtifactBytes: 1200,
    sourceArtifactFiles: 3,
    sourceTreeDigest: modelDigest(53),
    dependencyClosureDigest: modelDigest(54),
    toolClosureDigest: modelDigest(55),
    nativeBindingDigest: modelDigest(56),
    stripeMode: "test",
    modeEvidence: "explicit-native-test",
    entrySourceDigest: modelDigest(57),
    entryModuleSourceDigest: modelDigest(58),
    parserSourceDigest: modelDigest(59),
    parserFunctionDigest: modelDigest(60),
  };
  return { facts, mode };
}

test("normal mode draft DATA preserves exact three statements and all27 native/source fields", () => {
  const { facts, mode } = realmNormalModeDataModel();
  const pin = compileMoneyD1StripeRealmPinDraftData(facts);
  for (const modeEvidence of [
    "explicit-native-test",
    "verified-source-default-test-native-absence",
  ] as const) {
    const draft = compileMoneyD1StripeRealmNormalModeDraftData(facts, { ...mode, modeEvidence });
    expect(draft.pin).toEqual(pin);
    expect(draft.pin.statements.map((item) => item.params.length)).toEqual(
      pin.statements.map((item) => item.params.length),
    );
    expect(JSON.parse(draft.modeFactsJson)).toEqual({ ...mode, modeEvidence });
    expect(Object.keys(JSON.parse(draft.modeFactsJson))).toHaveLength(27);
    expect(draft.contribution).toBeNull();
    expect(draft.pin.contribution).toBeNull();
    expect(draft.pin.normalWorkerMode).toBe("not_established");
  }
});

test("normal mode draft DATA rejects crossed storage, epochs, conversion and protected backup", () => {
  const { facts, mode } = realmNormalModeDataModel();
  for (const field of [
    "accountId",
    "databaseId",
    "databaseName",
    "bucketName",
    "previousWriterEpoch",
    "nextWriterEpoch",
    "convertBindingDigest",
    "converted94BackupDigest",
  ] as const) {
    expect(() =>
      compileMoneyD1StripeRealmNormalModeDraftData(facts, {
        ...mode,
        [field]: modelDigest(99),
      }),
    ).toThrow();
  }
  const missing = structuredClone(facts);
  Reflect.deleteProperty(missing, "storage");
  expect(() => compileMoneyD1StripeRealmNormalModeDraftData(missing, mode)).toThrow();
});

test("normal mode draft DATA rejects malformed mode metadata without relaxing the old history gate", () => {
  const { facts, mode } = realmNormalModeDataModel();
  for (const field of Object.keys(mode)) {
    const missing = { ...mode };
    Reflect.deleteProperty(missing, field);
    expect(() => compileMoneyD1StripeRealmNormalModeDraftData(facts, missing)).toThrow();
  }
  for (const change of [
    { stripeMode: "live" },
    { modeEvidence: "source-default-only" },
    { sourceCommit: "not-an-exact-commit" },
    { sourceArtifactBytes: 0 },
    { sourceArtifactFiles: 0 },
    { sourceArtifactBytes: 1.5 },
    { sourceTreeDigest: "sha256:xyz" },
    { heldConvertDigest: "" },
    { parserFunctionDigest: "not-a-digest" },
    { workerName: "" },
    { versionId: "" },
    { ready: true },
  ]) {
    expect(() =>
      compileMoneyD1StripeRealmNormalModeDraftData(facts, Object.assign({}, mode, change)),
    ).toThrow();
  }
  const historical = structuredClone(facts);
  modelStageRows(historical, "original92", "ledger", 1);
  expect(() => compileMoneyD1StripeRealmNormalModeDraftData(historical, mode)).toThrow();
});

test("normal mode draft DATA snapshots mode and held inputs without invoking getters", () => {
  const { facts, mode } = realmNormalModeDataModel();
  const draft = compileMoneyD1StripeRealmNormalModeDraftData(facts, mode);
  const before = JSON.stringify(draft);
  Object.assign(mode, { moduleDigest: modelDigest(99) });
  Object.assign(facts.storage, { databaseId: "changed-later" });
  expect(JSON.stringify(draft)).toBe(before);
  expect(Object.isFrozen(draft)).toBe(true);
  expect(Object.isFrozen(draft.pin.statements)).toBe(true);
  let reads = 0;
  const fresh = realmNormalModeDataModel();
  const accessor = Object.defineProperty({ ...fresh.mode }, "moduleDigest", {
    enumerable: true,
    get() {
      reads++;
      return modelDigest(51);
    },
  });
  expect(() => compileMoneyD1StripeRealmNormalModeDraftData(fresh.facts, accessor)).toThrow();
  expect(reads).toBe(0);
});

test("normal mode original Root assertion rejects matching DTOs, copies and inheritance", async () => {
  const { facts, mode } = realmNormalModeDataModel();
  expect(compileMoneyD1StripeRealmNormalModeDraftData(facts, mode).contribution).toBeNull();
  const context = { kind: "takoserver.money-held-convert-context@v1", facts };
  const preparation = {
    kind: "takoserver.money-held-normal-worker-mode-preparation@v1",
    facts: mode,
    bindingDigest: modelDigest(61),
  };
  for (const candidate of [
    preparation,
    Object.freeze({ ...preparation }),
    structuredClone(preparation),
    JSON.parse(JSON.stringify(preparation)),
    Object.create(preparation),
    undefined,
  ]) {
    await expect(
      readMoneyD1StripeRealmNormalModePinSourceDraft(context, candidate),
    ).rejects.toBeInstanceOf(MoneyRealmDiagnosticError);
  }
});

test("normal mode original Root assertion rejects before any context or preparation facts getter", async () => {
  let reads = 0;
  const context = Object.defineProperty({}, "facts", {
    get() {
      reads++;
      throw new Error("context getter must not run");
    },
  });
  const preparation = Object.defineProperties(
    {},
    {
      facts: {
        get() {
          reads++;
          throw new Error("mode getter must not run");
        },
      },
      bindingDigest: {
        get() {
          reads++;
          throw new Error("digest getter must not run");
        },
      },
    },
  );
  await expect(
    readMoneyD1StripeRealmNormalModePinSourceDraft(context, preparation),
  ).rejects.toBeInstanceOf(MoneyRealmDiagnosticError);
  expect(reads).toBe(0);
});

import {
  assertMoneyD1StripeRealmPinContributionCurrent,
  readMoneyD1StripeRealmPinContribution,
} from "../scripts/deploy/stripe-mode-realm.ts";

test("realm contribution producer refuses forged original members before their facts getters", async () => {
  let reads = 0;
  const context = Object.defineProperty({}, "facts", {
    get() {
      reads++;
      throw new Error("untrusted held getter");
    },
  });
  const preparation = Object.defineProperties(
    {},
    {
      facts: {
        get() {
          reads++;
          throw new Error("untrusted mode getter");
        },
      },
      bindingDigest: {
        get() {
          reads++;
          throw new Error("untrusted digest getter");
        },
      },
    },
  );
  await expect(readMoneyD1StripeRealmPinContribution(context, preparation)).rejects.toBeInstanceOf(
    MoneyRealmDiagnosticError,
  );
  expect(reads).toBe(0);
  for (const [held, mode] of [
    [{}, {}],
    [null, null],
    [undefined, undefined],
  ]) {
    await expect(readMoneyD1StripeRealmPinContribution(held, mode)).rejects.toBeInstanceOf(
      MoneyRealmDiagnosticError,
    );
  }
});

test("realm contribution origin cannot be minted by matching compiler DATA or static metadata", async () => {
  const { facts, mode } = realmNormalModeDataModel();
  const data = compileMoneyD1StripeRealmNormalModeDraftData(facts, mode);
  const context = { kind: "takoserver.money-held-convert-context@v1", facts };
  const preparation = {
    kind: "takoserver.money-held-normal-worker-mode-preparation@v1",
    facts: mode,
    bindingDigest: modelDigest(61),
  };
  const fake = Object.freeze({
    kind: "takoserver.financial-stripe-realm-pin-contribution@v1",
    scope: "fixed-financial-fragment-not-dispatch-permission",
    sourceBindingDigest: modelDigest(62),
    modePreparationDigest: preparation.bindingDigest,
    writerEpochBeforeRotation: facts.previousWriterEpoch,
    statements: data.pin.statements,
    placement: "same-sealed-one-after-0098-schema-before-epoch-rotation",
  });
  for (const artifact of [
    data,
    fake,
    { ...fake },
    JSON.parse(JSON.stringify(fake)),
    Object.create(fake),
  ]) {
    await expect(
      assertMoneyD1StripeRealmPinContributionCurrent(artifact, context, preparation),
    ).rejects.toBeInstanceOf(MoneyRealmDiagnosticError);
  }
  await expect(readMoneyD1StripeRealmPinContribution(context, preparation)).rejects.toBeInstanceOf(
    MoneyRealmDiagnosticError,
  );
  expect(data.pin.statements).toHaveLength(3);
  expect(data.contribution).toBeNull();
});

test("realm contribution origin refusal invokes no artifact getters or Proxy traps", async () => {
  let traps = 0;
  const getter = Object.defineProperty({}, "statements", {
    get() {
      traps++;
      throw new Error("artifact getter");
    },
  });
  const proxy = new Proxy(
    {},
    {
      get() {
        traps++;
        throw new Error("artifact get trap");
      },
      getPrototypeOf() {
        traps++;
        throw new Error("artifact prototype trap");
      },
      ownKeys() {
        traps++;
        throw new Error("artifact own keys trap");
      },
      getOwnPropertyDescriptor() {
        traps++;
        throw new Error("artifact descriptor trap");
      },
    },
  );
  const untrustedContext = Object.defineProperty({}, "facts", {
    get() {
      traps++;
      throw new Error("context getter");
    },
  });
  for (const artifact of [getter, proxy, Object.create(getter), undefined, null]) {
    await expect(
      assertMoneyD1StripeRealmPinContributionCurrent(artifact, untrustedContext, untrustedContext),
    ).rejects.toBeInstanceOf(MoneyRealmDiagnosticError);
  }
  expect(traps).toBe(0);
  // Genuine positive creation, mismatched genuine members, post-await drift,
  // actual ONE adjacency/rollback and post-import unknown remain UNQUALIFIED.
});

test("realm post-suffix inventory accepts exactly canonical zero stage additions", async () => {
  const f = await realmPinDraftFixture();
  try {
    const result = await f.sql.batch(f.draft.statements);
    expect(result[0]?.rows).toEqual([{ required_financial_realm: 1 }]);
    expect(result[1]?.rows).toHaveLength(1);
    expect(result[2]?.rows).toEqual([{ required_financial_realm: 1 }]);
    expect(f.draft.statements[0].params.length).toBeLessThanOrEqual(100);
    expect(f.draft.statements[2].params).toEqual(f.draft.statements[0].params);
  } finally {
    f.db.close();
  }
});

test("realm post-suffix inventory refuses stage tables already present in held94", () => {
  for (const name of REALM_POST94_STAGE_TABLES) {
    for (const observed of [name, name.toUpperCase()]) {
      const facts = realmHistoryDataModel();
      modelStageRows(facts, "converted94", observed, 0);
      modelStageRows(facts, "current94", observed, 0);
      expect(() => compileMoneyD1StripeRealmPinDraftData(facts)).toThrow();
    }
  }
});

test("realm post-suffix inventory refuses each missing stage table with prefix rollback", async () => {
  for (const name of REALM_POST94_STAGE_TABLES) {
    const f = await realmPinDraftFixture();
    try {
      f.db.exec(`DROP TABLE "${name}"`);
      let failure: unknown;
      try {
        await f.sql.batch([
          {
            sql: "INSERT INTO principals (id,provider,provider_subject,email,display_name,created_at) VALUES ('stage:prefix','google','stage:prefix','fixture@invalid.example','fixture','2026-10-18T00:00:00.000Z')",
          },
          ...f.draft.statements,
        ]);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(SqlError);
      expect(await f.sql.query("SELECT id FROM principals WHERE id='stage:prefix'")).toEqual([]);
      expect(await f.sql.query("SELECT singleton FROM stripe_mode_realm")).toEqual([]);
    } finally {
      f.db.close();
    }
  }
});

test("realm post-suffix inventory refuses rows in each added table before and after the pin", async () => {
  for (const name of REALM_POST94_STAGE_TABLES) {
    const f = await realmPinDraftFixture();
    try {
      // Controlled SQL fault DATA isolates each count guard, without having to
      // fabricate a valid business command for eighteen unrelated row schemas.
      f.db.exec(`DROP TABLE "${name}"; CREATE TABLE "${name}" (fixture_row TEXT);`);
      await expectRealmDraftRollback(f.sql, [
        { sql: `INSERT INTO "${name}" VALUES ('unexpected')` },
        ...f.draft.statements,
      ]);
      expect(await f.sql.query(`SELECT * FROM "${name}"`)).toEqual([]);
      await expectRealmDraftRollback(f.sql, [
        f.draft.statements[0],
        f.draft.statements[1],
        { sql: `INSERT INTO "${name}" VALUES ('late-unexpected')` },
        f.draft.statements[2],
      ]);
      expect(await f.sql.query(`SELECT * FROM "${name}"`)).toEqual([]);
      expect(await f.sql.query("SELECT singleton FROM stripe_mode_realm")).toEqual([]);
    } finally {
      f.db.close();
    }
  }
});
