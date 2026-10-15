import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createLedger } from "../src/ledger.ts";
import { createOrgBilling } from "../src/org-billing.ts";
import { readOrgUsageSummary } from "../src/org-usage-summary.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";

const ORG = "usage_summary_org";
const PAID_START = "2026-10-10T00:00:00.000Z";
const PAID_END = "2026-10-20T00:00:00.000Z";

function config(effectiveAt = "2026-09-01T00:00:00.000Z") {
  const parsed = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "usage-r1",
      effectiveAt,
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {},
    }),
  );
  if (!parsed) throw new Error("test tariff missing");
  return parsed;
}

function fixture() {
  const sql = createEphemeralSql();
  let instant = "2026-10-05T00:00:00.000Z";
  const clock = () => new Date(instant);
  const ledger = createLedger(sql, clock, { hostedPaidFreeExclusion: true });
  const billing = createOrgBilling({
    sql,
    clock,
    ledger,
    config: config(),
    hostedPaidFreeExclusion: true,
  });
  const stripe = createStripeBillingStore({ sql, clock });
  const grant = {
    organizationId: ORG,
    fundingRef: `stripe:invoice:in_${ORG}`,
    kind: "plan-included" as const,
    amountMicros: 20_000_000,
    expiresAt: PAID_END,
    sourceType: "invoice" as const,
    sourceId: `in_${ORG}`,
    chargeId: `ch_${ORG}`,
    customerId: `cus_${ORG}`,
    subscriptionId: `sub_${ORG}`,
    planKey: "starter",
    pricingRevision: "usage-r1",
    stripePriceId: "price_starter",
    periodStart: PAID_START,
    periodEnd: PAID_END,
    considerationMicros: 1_000_000,
  };
  return {
    sql,
    ledger,
    billing,
    stripe,
    grant,
    time(value: string) {
      instant = value;
    },
    async paid() {
      await stripe.grant(grant);
    },
  };
}

test("current Free period counts only its live holds and spending; purchased credit stays separate", async () => {
  const f = fixture();
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "purchase",
    amountMicros: 2_000_000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    periodKind: "free",
    periodStart: "2026-10-01T00:00:00.000Z",
    nextResetAt: "2026-11-01T00:00:00.000Z",
    effectiveIncludedMicros: 1_500_000,
    availableMicros: 1_500_000,
    purchasedAvailableMicros: 2_000_000,
    utilizationBasisPoints: 0,
  });
  await f.billing.hold({
    organizationId: ORG,
    reference: "eighty",
    amountMicros: 1_200_000,
    pricingRevision: "usage-r1",
    measurementFingerprint: "eighty",
  });
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    heldMicros: 1_200_000,
    availableMicros: 300_000,
    utilizationBasisPoints: 8_000,
    reached80Percent: true,
    reached95Percent: false,
    limitReached: false,
  });
  await f.billing.release(ORG, "eighty");
  expect((await f.billing.usageSummary(ORG)).utilizationBasisPoints).toBe(0);
  await f.billing.hold({
    organizationId: ORG,
    reference: "ninety-five",
    amountMicros: 1_425_000,
    pricingRevision: "usage-r1",
    measurementFingerprint: "ninety-five",
  });
  await f.billing.capture({
    organizationId: ORG,
    reference: "ninety-five",
    amountMicros: 1_425_000,
    actualMicros: "1425000",
    measurementFingerprint: "capture",
  });
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    usedMicros: 1_425_000,
    heldMicros: 0,
    availableMicros: 75_000,
    utilizationBasisPoints: 9_500,
    reached95Percent: true,
    purchasedAvailableMicros: 2_000_000,
  });
  f.time("2026-11-01T00:00:00.000Z");
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    periodStart: "2026-11-01T00:00:00.000Z",
    usedMicros: 0,
    effectiveIncludedMicros: 1_500_000,
    utilizationBasisPoints: 0,
  });
});

test("paid proof supplies its own period and ignores earlier Free allocations", async () => {
  const f = fixture();
  f.time("2026-10-09T23:59:30.000Z");
  await f.billing.hold({
    organizationId: ORG,
    reference: "old-free",
    amountMicros: 300_000,
    pricingRevision: "usage-r1",
    measurementFingerprint: "old-free",
  });
  f.time(PAID_START);
  await f.paid();
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    periodKind: "paid",
    periodStart: PAID_START,
    periodEnd: PAID_END,
    nextResetAt: PAID_END,
    originalIncludedMicros: 20_000_000,
    effectiveIncludedMicros: 20_000_000,
    usedMicros: 0,
    heldMicros: 0,
  });
  await f.billing.capture({
    organizationId: ORG,
    reference: "old-free",
    amountMicros: 300_000,
    actualMicros: "300000",
    measurementFingerprint: "capture-old-free",
  });
  f.time(PAID_END);
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    periodKind: "free",
    usedMicros: 300_000,
    availableMicros: 1_200_000,
    nextResetAt: "2026-11-01T00:00:00.000Z",
  });
});

test("a direct Free-class lot is not reported as spendable extra credit during paid coverage", async () => {
  const f = fixture();
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "old-direct-free",
    amountMicros: 1_000_000,
    kind: "direct",
    consumptionClass: "free",
  });
  f.time(PAID_START);
  await f.paid();
  expect((await f.billing.usageSummary(ORG)).directAvailableMicros).toBe(0);
  f.time(PAID_END);
  expect((await f.billing.usageSummary(ORG)).directAvailableMicros).toBe(1_000_000);
});

test("legacy direct-origin purchased credit is counted once as purchased-class availability", async () => {
  const f = fixture();
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "legacy-checkout",
    amountMicros: 750_000,
    kind: "direct",
    consumptionClass: "purchased",
  });
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    purchasedAvailableMicros: 750_000,
    directAvailableMicros: 0,
  });
});

test("paid-first summary has no Free lot; partial refund reduces the denominator, pending and full refund fail closed", async () => {
  const f = fixture();
  f.time(PAID_START);
  await f.paid();
  expect((await f.billing.usageSummary(ORG)).periodKind).toBe("paid");
  expect(
    (
      await f.sql.query(
        "SELECT 1 FROM wallet_credit_lots WHERE org_id = ? AND consumption_class = 'free'",
        [ORG],
      )
    ).length,
  ).toBe(0);
  let generation = await f.stripe.freezeFunding(ORG, f.grant.fundingRef);
  await expect(f.billing.usageSummary(ORG)).rejects.toMatchObject({ status: 503 });
  await f.stripe.refund({
    refundId: "re_half",
    grant: f.grant,
    amountMicros: 500_000,
    cumulativeRefundedMicros: 500_000,
    fenceGeneration: generation,
  });
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    periodKind: "paid",
    effectiveIncludedMicros: 10_000_000,
    revokedMicros: 10_000_000,
    availableMicros: 10_000_000,
  });
  generation = await f.stripe.freezeFunding(ORG, f.grant.fundingRef);
  await f.stripe.refund({
    refundId: "re_full",
    grant: f.grant,
    amountMicros: 500_000,
    cumulativeRefundedMicros: 1_000_000,
    fenceGeneration: generation,
    releaseFreeze: false,
  });
  await expect(f.billing.usageSummary(ORG)).rejects.toMatchObject({ status: 503 });
  await f.stripe.unfreezeFunding({
    organizationId: ORG,
    fundingRef: f.grant.fundingRef,
    fenceGeneration: generation,
    cumulativeRefundedMicros: 1_000_000,
  });
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    periodKind: "free",
    effectiveIncludedMicros: 1_500_000,
    revokedMicros: 0,
  });
});

test("refund of already-used paid credit caps utilization without inventing availability", async () => {
  const f = fixture();
  f.time(PAID_START);
  await f.paid();
  await f.billing.hold({
    organizationId: ORG,
    reference: "used-before-refund",
    amountMicros: 15_000_000,
    pricingRevision: "usage-r1",
    measurementFingerprint: "used-before-refund",
  });
  await f.billing.capture({
    organizationId: ORG,
    reference: "used-before-refund",
    amountMicros: 15_000_000,
    actualMicros: "15000000",
    measurementFingerprint: "capture",
  });
  const generation = await f.stripe.freezeFunding(ORG, f.grant.fundingRef);
  await f.stripe.refund({
    refundId: "re_consumed",
    grant: f.grant,
    amountMicros: 500_000,
    cumulativeRefundedMicros: 500_000,
    fenceGeneration: generation,
  });
  expect(await f.billing.usageSummary(ORG)).toMatchObject({
    periodKind: "paid",
    effectiveIncludedMicros: 10_000_000,
    usedMicros: 15_000_000,
    revokedMicros: 10_000_000,
    availableMicros: 0,
    utilizationBasisPoints: 10_000,
    reached80Percent: true,
    reached95Percent: true,
    limitReached: true,
  });
});

test("first-month frozen zero is honest; corrupt snapshots and unsafe money fail closed", async () => {
  const zeroFixture = fixture();
  const delayed = createOrgBilling({
    sql: zeroFixture.sql,
    clock: () => new Date("2026-10-15T00:00:00.000Z"),
    ledger: zeroFixture.ledger,
    config: config("2026-10-10T00:00:00.000Z"),
    hostedPaidFreeExclusion: true,
  });
  const zero = await delayed.usageSummary("zero_org");
  expect(zero).toMatchObject({
    effectiveIncludedMicros: 0,
    availableMicros: 0,
    utilizationBasisPoints: 0,
    limitReached: true,
    reached80Percent: false,
    reached95Percent: false,
  });
  const f = fixture();
  await f.billing.usageSummary(ORG);
  await f.sql.run("UPDATE org_wallet_grant_snapshots SET amount_micros = ? WHERE org_id = ?", [
    Number.MAX_SAFE_INTEGER + 1,
    ORG,
  ]);
  await expect(f.billing.usageSummary(ORG)).rejects.toMatchObject({ status: 503 });
});

test("an unsafe purchased aggregate cannot wrap or hide included-credit exhaustion", async () => {
  const f = fixture();
  await f.billing.usageSummary(ORG);
  for (const ref of ["large-a", "large-b"]) {
    await f.sql.run(
      `INSERT INTO wallet_credit_lots
        (org_id, ref, kind, amount_micros, consumption_class, expires_at, created_at)
        VALUES (?, ?, 'purchased', ?, 'purchased', NULL, ?)`,
      [ORG, ref, 5_000_000_000_000_000, "2026-10-05T00:00:00.000Z"],
    );
  }
  await expect(
    readOrgUsageSummary({
      sql: f.sql,
      organizationId: ORG,
      instant: "2026-10-05T00:00:00.000Z",
      hostedPaidFreeExclusion: true,
    }),
  ).rejects.toMatchObject({ message: "billing_unavailable" });
});

test("a pending invoice fence before grant fails closed; another Organization's proof does not apply", async () => {
  const f = fixture();
  f.time(PAID_START);
  await f.stripe.grant({
    ...f.grant,
    organizationId: "another_org",
    fundingRef: "stripe:invoice:in_other",
    sourceId: "in_other",
    chargeId: "ch_other",
    customerId: "cus_other",
    subscriptionId: "sub_other",
  });
  expect((await f.billing.usageSummary(ORG)).periodKind).toBe("free");
  const ref = "stripe:invoice:in_pending";
  const generation = await f.stripe.freezeFunding(ORG, ref);
  await expect(f.billing.usageSummary(ORG)).rejects.toMatchObject({ status: 503 });
  await f.stripe.unfreezeFunding({
    organizationId: ORG,
    fundingRef: ref,
    fenceGeneration: generation,
    cumulativeRefundedMicros: 0,
  });
  expect((await f.billing.usageSummary(ORG)).periodKind).toBe("free");
});

test("self-hosted pre-0095 summary reads Free and purchased lots without paid tables", async () => {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    if (migration.name === "0095_stripe_billing.sql") break;
    database.exec(migration.sql);
  }
  const sql = createSqliteSql(database);
  const clock = () => new Date(PAID_START);
  const ledger = createLedger(sql, clock);
  const billing = createOrgBilling({ sql, clock, ledger, config: config() });
  await ledger.fund({
    organizationId: ORG,
    fundingRef: "purchase",
    amountMicros: 2_000_000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  expect(await billing.usageSummary(ORG)).toMatchObject({
    periodKind: "free",
    effectiveIncludedMicros: 1_500_000,
    purchasedAvailableMicros: 2_000_000,
  });
});
