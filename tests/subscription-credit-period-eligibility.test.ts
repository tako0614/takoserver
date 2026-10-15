import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { parseBillingConfig } from "../src/billing-config.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  createLedger,
  prepareLedgerAllocation,
  stripeInvoiceGrantSchemaReady,
  stripeRefundSchemaReady,
} from "../src/ledger.ts";
import { createOrgBilling } from "../src/org-billing.ts";
import { createOrgLimitPolicy } from "../src/org-limit-policy.ts";
import { type Row, type Sql, SqlError } from "../src/ports.ts";
import {
  compileSharedHostedPricing,
  parseSharedHostedPricing,
} from "../src/shared-hosted-pricing.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { type BillingGrant, createStripeBillingStore } from "../src/stripe-billing-store.ts";

const BEFORE = "2026-10-14T12:00:00.000Z";
const START = "2026-11-01T00:00:00.000Z";
const END = "2026-12-01T00:00:00.000Z";
const ORG = "org_credit_period";

function canonicalConfig() {
  const source = compileSharedHostedPricing(
    parseSharedHostedPricing(
      JSON.parse(
        readFileSync(new URL("../config/shared-hosted-pricing.json", import.meta.url), "utf8"),
      ),
    ),
  );
  const config = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: source.organizationAllowance.sourceRevision,
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86400,
      freeIncludedMinor: Number(source.organizationAllowance.freeIncludedMicros) / 10000,
      purchaseCreditExpiry: { kind: "none" },
      plans: Object.fromEntries(
        source.plans.map((plan) => [
          plan.planId,
          {
            includedMinor: Number(plan.includedMicros) / 10000,
            stripePriceId: `price_test${plan.planId.replaceAll("-", "")}`,
          },
        ]),
      ),
      meters: Object.fromEntries(
        Object.entries(source.usageRates)
          .filter(([, rate]) => rate.numeratorMicros !== "0")
          .map(([key, rate]) => [
            key,
            {
              unit: rate.unit,
              rate: { numeratorMicros: rate.numeratorMicros, denominator: rate.denominator },
            },
          ]),
      ),
    }),
  );
  const plan = source.plans.find((plan) => plan.planId === "hosted-10");
  if (!config || !plan) throw new Error("canonical shared tariff missing");
  return { config, plan };
}

async function fixture() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  const sql = createSqliteSql(db);
  let time = START;
  const clock = () => new Date(time);
  const policy = createOrgLimitPolicy({ sql, clock });
  const ledger = createLedger(sql, clock, {
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver: policy.prepareAdmission.bind(policy),
  });
  const { config, plan } = canonicalConfig();
  const billing = createOrgBilling({
    sql,
    clock,
    ledger,
    config,
    hostedPaidFreeExclusion: true,
    limitPolicy: policy,
  });
  const store = createStripeBillingStore({ sql, clock });
  const grant: BillingGrant = {
    organizationId: ORG,
    fundingRef: "stripe:invoice:in_credit_period",
    kind: "plan-included",
    amountMicros: Number(plan.includedMicros),
    expiresAt: END,
    sourceType: "invoice",
    sourceId: "in_credit_period",
    chargeId: "ch_credit_period",
    customerId: "cus_credit_period",
    subscriptionId: "sub_credit_period",
    planKey: plan.planId,
    pricingRevision: config.revision,
    stripePriceId: config.plans[plan.planId]?.stripePriceId ?? null,
    periodStart: START,
    periodEnd: END,
    considerationMicros: Number(plan.monthlyPriceMicros),
  };
  // Legitimate actual store funding while inside its original service period.
  // Rewinding only the synthetic clock later represents retained prefunded data.
  await store.grant(grant);
  return {
    db,
    sql,
    clock,
    ledger,
    billing,
    policy,
    store,
    grant,
    config,
    setTime: (value: string) => {
      time = value;
    },
  };
}

function hold(f: Awaited<ReturnType<typeof fixture>>, reference: string, amountMicros: number) {
  return {
    organizationId: ORG,
    reference,
    amountMicros,
    pricingRevision: f.config.revision,
    measurementFingerprint: reference,
  };
}

describe("Invoice credit service-period eligibility", () => {
  test("retained future invoice credit preserves history but exposes only Free until the exact start", async () => {
    const f = await fixture();
    const originalLots = await f.sql.query("SELECT * FROM wallet_credit_lots WHERE ref = ?", [
      f.grant.fundingRef,
    ]);
    const originalGrants = await f.sql.query("SELECT * FROM stripe_billing_grants");
    const originalFunding = await f.sql.query(
      "SELECT * FROM ledger WHERE type = 'funding' AND ref = ?",
      [f.grant.fundingRef],
    );
    f.setTime(BEFORE);
    expect(await f.billing.wallet(ORG)).toMatchObject({
      availableMicros: 1_500_000,
      heldMicros: 0,
    });
    expect(await f.billing.usageSummary(ORG)).toMatchObject({
      periodKind: "free",
      effectiveIncludedMicros: 1_500_000,
    });
    const first = await f.billing.lots(ORG, 1);
    expect(first.lots[0]).toMatchObject({ consumptionClass: "free", availableMicros: 1_500_000 });
    expect(first.cursor).not.toBeNull();
    const second = await f.billing.lots(ORG, 1, first.cursor ?? undefined);
    expect(second.lots[0]).toMatchObject({
      reference: f.grant.fundingRef,
      amountMicros: 20_000_000,
      remainingMicros: 20_000_000,
      availableMicros: 0,
    });
    expect(
      await f.ledger.hold({
        organizationId: ORG,
        reference: "before-period",
        amountMicros: 1_500_001,
      }),
    ).toBe(false);
    expect(
      await f.ledger.debitUsage({
        organizationId: ORG,
        reference: "before-usage",
        amountMicros: 1_500_001,
      }),
    ).toBe(false);
    await expect(f.billing.hold(hold(f, "before-api", 1_500_001))).rejects.toMatchObject({
      code: "insufficient_funds",
      status: 402,
    });
    expect(await f.sql.query("SELECT * FROM wallet_credit_allocations")).toEqual([]);
    expect(
      await f.sql.query("SELECT * FROM wallet_credit_lots WHERE ref = ?", [f.grant.fundingRef]),
    ).toEqual(originalLots);
    expect(await f.sql.query("SELECT * FROM stripe_billing_grants")).toEqual(originalGrants);
    expect(
      await f.sql.query("SELECT * FROM ledger WHERE type = 'funding' AND ref = ?", [
        f.grant.fundingRef,
      ]),
    ).toEqual(originalFunding);
    f.setTime(START);
    expect(await f.billing.wallet(ORG)).toMatchObject({ availableMicros: 20_000_000 });
    expect(await f.billing.usageSummary(ORG)).toMatchObject({
      periodKind: "paid",
      effectiveIncludedMicros: 20_000_000,
    });
    expect(
      await f.ledger.hold({ organizationId: ORG, reference: "at-start", amountMicros: 1 }),
    ).toBe(true);
    expect(
      await f.sql.query(
        "SELECT lot_ref, amount_micros FROM wallet_credit_allocations WHERE debit_ref = 'at-start'",
      ),
    ).toEqual([{ lot_ref: f.grant.fundingRef, amount_micros: 1 }]);
    f.db.close();
  });

  test("original pinned holds replay, capture and release after clock rewind without exposing future remainder", async () => {
    const f = await fixture();
    const request = hold(f, "original-api", 1000);
    const original = await f.billing.hold(request);
    expect(
      await f.ledger.hold({
        organizationId: ORG,
        reference: "original-low-level",
        amountMicros: 2000,
      }),
    ).toBe(true);
    f.setTime(BEFORE);
    expect(await f.billing.wallet(ORG)).toMatchObject({
      settledMicros: 1_503_000,
      heldMicros: 3000,
      availableMicros: 1_500_000,
    });
    expect(await f.billing.hold(request)).toEqual(original);
    expect(
      await f.ledger.hold({
        organizationId: ORG,
        reference: "original-low-level",
        amountMicros: 2000,
      }),
    ).toBe(true);
    expect(
      await f.billing.capture({
        organizationId: ORG,
        reference: request.reference,
        amountMicros: 700,
        actualMicros: "700",
        measurementFingerprint: "closed-original",
      }),
    ).toMatchObject({ status: "captured", capturedMicros: 700, releasedMicros: 300 });
    await f.ledger.release({
      organizationId: ORG,
      reference: "original-low-level",
      amountMicros: 2000,
    });
    expect(await f.billing.wallet(ORG)).toMatchObject({
      settledMicros: 1_500_000,
      heldMicros: 0,
      availableMicros: 1_500_000,
    });
    expect(
      (await f.billing.lots(ORG)).lots.find((lot) => lot.reference === f.grant.fundingRef),
    ).toMatchObject({ amountMicros: 20_000_000, remainingMicros: 19_999_300, availableMicros: 0 });
    f.db.close();
  });

  test("funding conservation and refund frozen totals do not subtract unavailable future credit", async () => {
    const f = await fixture();
    expect(
      await f.ledger.hold({
        organizationId: ORG,
        reference: "held-old-period",
        amountMicros: 1000,
      }),
    ).toBe(true);
    f.setTime(BEFORE);
    await f.store.freezeFunding(ORG, f.grant.fundingRef);
    expect(await f.ledger.wallet(ORG)).toMatchObject({
      settledMicros: 1000,
      heldMicros: 1000,
      frozenMicros: 0,
      availableMicros: 0,
    });
    expect(
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "other-independent-funding",
        kind: "purchased",
        consumptionClass: "purchased",
        amountMicros: 5000,
      }),
    ).toMatchObject({
      settledMicros: 6000,
      heldMicros: 1000,
      frozenMicros: 0,
      availableMicros: 5000,
    });
    await f.ledger.release({
      organizationId: ORG,
      reference: "held-old-period",
      amountMicros: 1000,
    });
    expect(await f.ledger.wallet(ORG)).toMatchObject({
      settledMicros: 5000,
      heldMicros: 0,
      frozenMicros: 0,
      availableMicros: 5000,
    });
    f.db.close();
  });

  test("at service-period end new admission stops while a live original allocation settles", async () => {
    const f = await fixture();
    f.setTime("2026-11-30T12:00:00.000Z");
    const request = hold(f, "end-boundary", 1000);
    await f.billing.hold(request);
    f.setTime(END);
    expect(await f.ledger.wallet(ORG)).toMatchObject({
      settledMicros: 1000,
      heldMicros: 1000,
      availableMicros: 0,
    });
    expect(
      await f.ledger.debitUsage({ organizationId: ORG, reference: "after-end", amountMicros: 1 }),
    ).toBe(false);
    expect(
      await f.billing.capture({
        organizationId: ORG,
        reference: request.reference,
        amountMicros: 1000,
        actualMicros: "1000",
        measurementFingerprint: "end-capture",
      }),
    ).toMatchObject({ status: "captured", capturedMicros: 1000 });
    // The terminal API also prepares December's legitimate Free entitlement.
    expect(await f.ledger.wallet(ORG)).toMatchObject({ heldMicros: 0, availableMicros: 1_500_000 });
    expect(
      (await f.billing.lots(ORG)).lots.find((lot) => lot.reference === f.grant.fundingRef),
    ).toMatchObject({ remainingMicros: 19_999_000, availableMicros: 0 });
    f.db.close();
  });

  test("atomic allocation refuses stale advisory rows from the lot's previously eligible period", async () => {
    const f = await fixture();
    let prior: readonly Row[] = [];
    const recording: Sql = {
      async query(statement, params) {
        const rows = await f.sql.query(statement, params);
        if (statement.includes("SELECT l.ref,")) prior = rows;
        return rows;
      },
      run: (statement, params) => f.sql.run(statement, params),
      batch: (statements) => f.sql.batch(statements),
    };
    const allocation = {
      organizationId: ORG,
      type: "hold" as const,
      reference: "stale",
      amountMicros: 1,
      settledDeltaMicros: 0,
      heldDeltaMicros: 1,
      now: START,
    };
    await prepareLedgerAllocation(recording, allocation);
    expect(prior).toHaveLength(1);
    f.setTime(BEFORE);
    const stale: Sql = {
      query: (statement, params) =>
        statement.includes("SELECT l.ref,")
          ? Promise.resolve(prior)
          : f.sql.query(statement, params),
      run: (statement, params) => f.sql.run(statement, params),
      batch: (statements) => f.sql.batch(statements),
    };
    const statements = await prepareLedgerAllocation(stale, { ...allocation, now: BEFORE });
    await expect(f.sql.batch(statements)).rejects.toBeInstanceOf(SqlError);
    expect(await f.sql.query("SELECT * FROM wallet_credit_allocations")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM ledger WHERE type = 'hold'")).toEqual([]);
    f.db.close();
  });

  test("pre-0095 and refund-only schemas keep independent wallets without resolving an absent grant table", async () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) {
      if (migration.name >= "0095") break;
      db.exec(migration.sql);
    }
    const sql = createSqliteSql(db);
    const ledger = createLedger(sql, () => new Date(BEFORE));
    expect(await stripeInvoiceGrantSchemaReady(sql)).toBe(false);
    expect(
      await ledger.fund({
        organizationId: ORG,
        fundingRef: "legacy-wallet",
        consumptionClass: "subscription",
        kind: "plan-included",
        amountMicros: 100,
      }),
    ).toMatchObject({ availableMicros: 100 });
    expect(
      await ledger.hold({ organizationId: ORG, reference: "legacy-hold", amountMicros: 30 }),
    ).toBe(true);
    await sql.run(
      "CREATE TABLE stripe_billing_refunds (org_id TEXT, funding_ref TEXT, refund_id TEXT, debit_micros INTEGER, expired_micros INTEGER, receivable_micros INTEGER, created_at TEXT)",
    );
    await sql.run(
      "CREATE TABLE stripe_billing_fences (org_id TEXT, funding_ref TEXT, active INTEGER)",
    );
    // A newly composed connection sees both refund tables, but not grant proofs.
    const refundSql = createSqliteSql(db);
    expect(await stripeRefundSchemaReady(refundSql)).toBe(true);
    expect(await stripeInvoiceGrantSchemaReady(refundSql)).toBe(false);
    const refundLedger = createLedger(refundSql, () => new Date(BEFORE));
    expect(await refundLedger.wallet(ORG)).toMatchObject({
      settledMicros: 100,
      heldMicros: 30,
      availableMicros: 70,
    });
    expect(
      await refundLedger.debitUsage({
        organizationId: ORG,
        reference: "legacy-usage",
        amountMicros: 10,
      }),
    ).toBe(true);
    await refundLedger.release({ organizationId: ORG, reference: "legacy-hold", amountMicros: 30 });
    expect(await refundLedger.wallet(ORG)).toMatchObject({ availableMicros: 90 });
    db.close();
  });

  test("a partial grant table fails closed and a later additive shape is observed on the same Sql port", async () => {
    const db = new Database(":memory:");
    const sql = createSqliteSql(db);
    expect(await stripeInvoiceGrantSchemaReady(sql)).toBe(false);
    await sql.run("CREATE TABLE stripe_billing_grants (org_id TEXT)");
    await expect(stripeInvoiceGrantSchemaReady(sql)).rejects.toMatchObject({
      code: "conservation_violated",
    });
    for (const column of ["funding_ref", "source_type", "period_start", "period_end"]) {
      await sql.run(`ALTER TABLE stripe_billing_grants ADD COLUMN ${column} TEXT`);
    }
    expect(await stripeInvoiceGrantSchemaReady(sql)).toBe(true);
    db.close();
  });
});
