import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createLedger } from "../src/ledger.ts";
import { createOrgBilling } from "../src/org-billing.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";

const ORG = "paid_free_org";
const START = "2026-10-10T00:00:00.000Z";
const END = "2026-10-20T00:00:00.000Z";

function freeConfig() {
  const config = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "free-r1",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {},
    }),
  );
  if (!config) throw new Error("missing config");
  return config;
}

function fixture() {
  const sql = createEphemeralSql();
  let instant = "2026-10-05T00:00:00.000Z";
  const clock = () => new Date(instant);
  const config = freeConfig();
  const ledger = createLedger(sql, clock, { hostedPaidFreeExclusion: true });
  const billing = createOrgBilling({ sql, clock, ledger, config, hostedPaidFreeExclusion: true });
  const stripe = createStripeBillingStore({ sql, clock });
  return {
    sql,
    clock,
    config,
    ledger,
    billing,
    stripe,
    time(value: string) {
      instant = value;
    },
    async paid(organizationId = ORG) {
      const grant = {
        organizationId,
        fundingRef: `stripe:invoice:in_${organizationId}`,
        kind: "plan-included" as const,
        amountMicros: 20_000_000,
        expiresAt: END,
        sourceType: "invoice" as const,
        sourceId: `in_${organizationId}`,
        chargeId: `ch_${organizationId}`,
        customerId: `cus_${organizationId}`,
        subscriptionId: `sub_${organizationId}`,
        planKey: "starter",
        pricingRevision: "free-r1",
        stripePriceId: "price_starter",
        periodStart: START,
        periodEnd: END,
        considerationMicros: 1_000_000,
      };
      await stripe.grant(grant);
      return grant;
    },
  };
}

test("verified paid period excludes earlier Free from new allocations without revoking it", async () => {
  const f = fixture();
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_500_000);
  f.time(START);
  await f.paid();
  const wallet = await f.billing.wallet(ORG);
  expect(wallet.availableMicros).toBe(20_000_000);
  expect(
    (
      await f.sql.query(
        "SELECT amount_micros FROM wallet_credit_lots WHERE org_id = ? AND consumption_class = 'free'",
        [ORG],
      )
    ).length,
  ).toBe(1);
  await f.billing.hold({
    organizationId: ORG,
    reference: "paid-hold",
    amountMicros: 100_000,
    pricingRevision: "free-r1",
    measurementFingerprint: "paid-hold",
  });
  expect(
    (
      await f.sql.query(
        "SELECT lot_ref FROM wallet_credit_allocations WHERE org_id = ? AND debit_type = 'hold' AND debit_ref = ?",
        [ORG, "org-hold:paid-hold"],
      )
    )[0]?.lot_ref,
  ).toBe(`stripe:invoice:in_${ORG}`);
  f.time(END);
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_500_000);
});

test("paid first postpones the monthly Free fund until coverage ends in the same UTC month", async () => {
  const f = fixture();
  f.time(START);
  await f.paid();
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(20_000_000);
  expect(
    (
      await f.sql.query(
        "SELECT 1 FROM wallet_credit_lots WHERE org_id = ? AND consumption_class = 'free'",
        [ORG],
      )
    ).length,
  ).toBe(0);
  f.time(END);
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_500_000);
  expect(
    (
      await f.sql.query(
        "SELECT 1 FROM wallet_credit_lots WHERE org_id = ? AND consumption_class = 'free'",
        [ORG],
      )
    ).length,
  ).toBe(1);
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_500_000);
});

test("old Free reservations retain capture and release history across a paid transition", async () => {
  const f = fixture();
  f.time("2026-10-09T23:59:30.000Z");
  await f.billing.wallet(ORG);
  await f.billing.hold({
    organizationId: ORG,
    reference: "old-free",
    amountMicros: 500_000,
    pricingRevision: "free-r1",
    measurementFingerprint: "old-free",
  });
  f.time("2026-10-10T00:00:01.000Z");
  await f.paid();
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(20_000_000);
  expect(
    await f.billing.capture({
      organizationId: ORG,
      reference: "old-free",
      amountMicros: 300_000,
      actualMicros: "300000",
      measurementFingerprint: "actual-old-free",
    }),
  ).toMatchObject({ status: "captured", capturedMicros: 300_000, releasedMicros: 200_000 });
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(20_000_000);
  expect(
    (
      await f.sql.query(
        "SELECT lot_ref FROM wallet_credit_allocations WHERE org_id = ? AND debit_type = 'capture' AND debit_ref = ?",
        [ORG, "org-hold:old-free"],
      )
    )[0]?.lot_ref,
  ).toBe(`free:${ORG}:2026-10`);
  f.time(END);
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_200_000);
});

test("partial refund remains paid; full refund restores Free only after the fence clears", async () => {
  const f = fixture();
  f.time(START);
  const grant = await f.paid();
  const partialFence = await f.stripe.freezeFunding(ORG, grant.fundingRef);
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(0);
  await f.stripe.refund({
    refundId: "re_partial",
    grant,
    amountMicros: 500_000,
    cumulativeRefundedMicros: 500_000,
    fenceGeneration: partialFence,
  });
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(10_000_000);
  const fullFence = await f.stripe.freezeFunding(ORG, grant.fundingRef);
  await f.stripe.refund({
    refundId: "re_final",
    grant,
    amountMicros: 500_000,
    cumulativeRefundedMicros: 1_000_000,
    fenceGeneration: fullFence,
    releaseFreeze: false,
  });
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(0);
  await f.stripe.unfreezeFunding({
    organizationId: ORG,
    fundingRef: grant.fundingRef,
    fenceGeneration: fullFence,
    cumulativeRefundedMicros: 1_000_000,
  });
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_500_000);
});

test("a verified grant arriving between the Free lookup and batch cannot create a Free lot", async () => {
  const f = fixture();
  f.time(START);
  let interleaved = false;
  const racingSql: Sql = {
    query: (query, params) => f.sql.query(query, params),
    run: (query, params) => f.sql.run(query, params),
    async batch(statements) {
      if (
        !interleaved &&
        statements.some((statement) =>
          statement.sql.includes("INSERT OR IGNORE INTO wallet_credit_lots"),
        )
      ) {
        interleaved = true;
        await f.paid();
      }
      return f.sql.batch(statements);
    },
  };
  const ledger = createLedger(racingSql, f.clock, { hostedPaidFreeExclusion: true });
  expect(
    (
      await ledger.fund({
        organizationId: ORG,
        fundingRef: `free:${ORG}:2026-10`,
        amountMicros: 1_500_000,
        kind: "plan-included",
        consumptionClass: "free",
        expiresAt: "2026-11-01T00:00:00.000Z",
      })
    ).availableMicros,
  ).toBe(20_000_000);
  expect(interleaved).toBe(true);
  expect(
    (
      await f.sql.query(
        "SELECT 1 FROM wallet_credit_lots WHERE org_id = ? AND consumption_class = 'free'",
        [ORG],
      )
    ).length,
  ).toBe(0);
});

test("a conflicting Free reference cannot be reported as a paid-period skip", async () => {
  const f = fixture();
  f.time(START);
  const reference = `free:${ORG}:2026-10`;
  let interleaved = false;
  const racingSql: Sql = {
    query: (query, params) => f.sql.query(query, params),
    run: (query, params) => f.sql.run(query, params),
    async batch(statements) {
      if (
        !interleaved &&
        statements.some((statement) =>
          statement.sql.includes("INSERT OR IGNORE INTO wallet_credit_lots"),
        )
      ) {
        interleaved = true;
        await f.paid();
        await createLedger(f.sql, f.clock).fund({
          organizationId: ORG,
          fundingRef: reference,
          amountMicros: 2_000_000,
          kind: "plan-included",
          consumptionClass: "free",
          expiresAt: "2026-11-01T00:00:00.000Z",
        });
      }
      return f.sql.batch(statements);
    },
  };
  const ledger = createLedger(racingSql, f.clock, { hostedPaidFreeExclusion: true });
  await expect(
    ledger.fund({
      organizationId: ORG,
      fundingRef: reference,
      amountMicros: 1_500_000,
      kind: "plan-included",
      consumptionClass: "free",
      expiresAt: "2026-11-01T00:00:00.000Z",
    }),
  ).rejects.toMatchObject({ code: "conservation_violated" });
  expect(interleaved).toBe(true);
});

test("a grant racing an allocation batch rolls back the Free choice and retry uses paid credit", async () => {
  const f = fixture();
  await f.billing.wallet(ORG);
  f.time(START);
  let interleaved = false;
  const racingSql: Sql = {
    query: (query, params) => f.sql.query(query, params),
    run: (query, params) => f.sql.run(query, params),
    async batch(statements) {
      if (
        !interleaved &&
        statements.some((statement) => statement.sql.includes("INSERT INTO org_wallet_holds"))
      ) {
        interleaved = true;
        await f.paid();
      }
      return f.sql.batch(statements);
    },
  };
  const ledger = createLedger(racingSql, f.clock, { hostedPaidFreeExclusion: true });
  const billing = createOrgBilling({
    sql: racingSql,
    clock: f.clock,
    ledger,
    config: f.config,
    hostedPaidFreeExclusion: true,
  });
  const hold = {
    organizationId: ORG,
    reference: "racing-hold",
    amountMicros: 100_000,
    pricingRevision: "free-r1",
    measurementFingerprint: "racing-hold",
  };
  await expect(billing.hold(hold)).rejects.toMatchObject({
    code: "billing_unavailable",
    status: 503,
  });
  expect(interleaved).toBe(true);
  expect(
    await f.sql
      .query("SELECT 1 FROM wallet_credit_allocations WHERE org_id = ? AND debit_ref = ?", [
        ORG,
        "org-hold:racing-hold",
      ])
      .then((rows) => rows.length),
  ).toBe(0);
  expect((await billing.hold(hold)).status).toBe("live");
  expect(
    (
      await f.sql.query(
        "SELECT lot_ref FROM wallet_credit_allocations WHERE org_id = ? AND debit_ref = ?",
        [ORG, "org-hold:racing-hold"],
      )
    )[0]?.lot_ref,
  ).toBe(`stripe:invoice:in_${ORG}`);
});

test("another Organization's proof and a malformed invoice never suppress this Organization's Free", async () => {
  const f = fixture();
  f.time(START);
  const other = await f.paid("other_org");
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_500_000);
  await expect(
    f.stripe.grant({
      ...other,
      organizationId: ORG,
      fundingRef: "bad-proof",
      sourceId: "in_bad",
      chargeId: "ch_bad",
      subscriptionId: "sub_bad",
      periodStart: null,
    }),
  ).rejects.toThrow();
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_500_000);
});

test("a pending invoice refund fence blocks Free even before its grant settles", async () => {
  const f = fixture();
  f.time(START);
  const reference = "stripe:invoice:in_pending";
  const generation = await f.stripe.freezeFunding(ORG, reference);
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(0);
  expect(
    (
      await f.sql.query(
        "SELECT 1 FROM wallet_credit_lots WHERE org_id = ? AND consumption_class = 'free'",
        [ORG],
      )
    ).length,
  ).toBe(0);
  await f.stripe.unfreezeFunding({
    organizationId: ORG,
    fundingRef: reference,
    fenceGeneration: generation,
    cumulativeRefundedMicros: 0,
  });
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_500_000);
});

test("a purchased-only refund fence does not remove the monthly Free allowance", async () => {
  const f = fixture();
  f.time(START);
  await f.stripe.grant({
    organizationId: ORG,
    fundingRef: "stripe:cs_purchase",
    kind: "purchased",
    amountMicros: 1_000_000,
    expiresAt: null,
    sourceType: "checkout",
    sourceId: "cs_purchase",
    chargeId: "ch_purchase",
    customerId: null,
    subscriptionId: null,
    planKey: null,
    pricingRevision: null,
    stripePriceId: null,
    periodStart: null,
    periodEnd: null,
    considerationMicros: 1_000_000,
  });
  await f.stripe.freezeFunding(ORG, "stripe:cs_purchase");
  expect((await f.billing.wallet(ORG)).availableMicros).toBe(1_500_000);
});

test("legacy self-host billing and purchased funds retain Free allocation without Hosted authority", async () => {
  const f = fixture();
  const ledger = createLedger(f.sql, f.clock);
  const billing = createOrgBilling({ sql: f.sql, clock: f.clock, ledger, config: f.config });
  f.time(START);
  await f.paid("legacy_org");
  expect((await billing.wallet("legacy_org")).availableMicros).toBe(21_500_000);
  await ledger.fund({
    organizationId: "legacy_org",
    fundingRef: "purchase",
    amountMicros: 1_000_000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  await billing.hold({
    organizationId: "legacy_org",
    reference: "legacy-hold",
    amountMicros: 100_000,
    pricingRevision: "free-r1",
    measurementFingerprint: "legacy-hold",
  });
  expect(
    (
      await f.sql.query(
        "SELECT lot_ref FROM wallet_credit_allocations WHERE org_id = ? AND debit_ref = ?",
        ["legacy_org", "org-hold:legacy-hold"],
      )
    )[0]?.lot_ref,
  ).toBe("free:legacy_org:2026-10");
});

test("self-host wallets continue on the pre-0095 schema without resolving paid tables", async () => {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    if (migration.name === "0095_stripe_billing.sql") break;
    database.exec(migration.sql);
  }
  const sql = createSqliteSql(database);
  const clock = () => new Date(START);
  const config = freeConfig();
  const ledger = createLedger(sql, clock);
  const billing = createOrgBilling({ sql, clock, ledger, config });
  expect((await billing.wallet("pre95_org")).availableMicros).toBe(1_500_000);
  await ledger.fund({
    organizationId: "pre95_org",
    fundingRef: "purchase",
    amountMicros: 1_000_000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  await billing.hold({
    organizationId: "pre95_org",
    reference: "pre95-hold",
    amountMicros: 100_000,
    pricingRevision: "free-r1",
    measurementFingerprint: "pre95-hold",
  });
  expect(
    (
      await sql.query(
        "SELECT lot_ref FROM wallet_credit_allocations WHERE org_id = ? AND debit_ref = ?",
        ["pre95_org", "org-hold:pre95-hold"],
      )
    )[0]?.lot_ref,
  ).toBe("free:pre95_org:2026-10");
});
