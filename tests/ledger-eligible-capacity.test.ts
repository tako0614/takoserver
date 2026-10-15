import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  createLedger,
  type LedgerEligibleCapacityInput,
  prepareLedgerAllocation,
  prepareLedgerEligibleCapacity,
  stripeRefundSource,
} from "../src/ledger.ts";
import { createOrgLimitPolicy } from "../src/org-limit-policy.ts";
import { type Row, type Sql, SqlError } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { type BillingGrant, createStripeBillingStore } from "../src/stripe-billing-store.ts";

const ORG = "org_eligible_capacity";
const NOW = "2026-10-14T00:00:00.000Z";
const START = "2026-11-01T00:00:00.000Z";
const END = "2026-12-01T00:00:00.000Z";

function fixture(through = "0099", beforeCutover?: (db: Database) => void) {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    if (migration.name.slice(0, 4) <= through) {
      db.exec(migration.sql);
      if (migration.name === "0093_wallet_credit_classification_proofs.sql") beforeCutover?.(db);
    }
  }
  const sql = createSqliteSql(db);
  let instant = NOW;
  const clock = () => new Date(instant);
  return {
    db,
    sql,
    ledger: createLedger(sql, clock, { hostedPaidFreeExclusion: true }),
    policy: createOrgLimitPolicy({ sql, clock }),
    store: createStripeBillingStore({ sql, clock }),
    setTime(value: string) {
      instant = value;
    },
  };
}

async function capacity(sql: Sql, input: Partial<LedgerEligibleCapacityInput> = {}) {
  const prepared = await prepareLedgerEligibleCapacity(sql, {
    organizationId: ORG,
    now: NOW,
    amountMicros: 1,
    ...input,
  });
  return prepared.decode(await sql.query(prepared.statement.sql, prepared.statement.params));
}

function checkout(): BillingGrant {
  return {
    organizationId: ORG,
    fundingRef: "stripe:cs_capacity",
    kind: "purchased",
    amountMicros: 100,
    expiresAt: END,
    sourceType: "checkout",
    sourceId: "cs_capacity",
    chargeId: "ch_capacity",
    customerId: "cus_capacity",
    subscriptionId: null,
    planKey: null,
    pricingRevision: null,
    stripePriceId: null,
    periodStart: null,
    periodEnd: null,
    considerationMicros: 100,
  };
}

function allocation(reference: string, amountMicros: number, now = NOW) {
  return {
    organizationId: ORG,
    type: "hold" as const,
    reference,
    amountMicros,
    settledDeltaMicros: 0,
    heldDeltaMicros: amountMicros,
    now,
  };
}

describe("shared ledger eligible capacity", () => {
  test("counts exact cutover proof while refusing an unproven direct lot of the same class", async () => {
    const f = fixture("0099", (db) => {
      for (const [ref, minor, consumptionClass] of [
        ["legacy-free", 1, "free"],
        ["legacy-purchase", 3, "purchased"],
      ] as const) {
        db.query(`INSERT INTO wallet_credit_lots
          (org_id, ref, kind, amount_minor, expires_at, created_at)
          VALUES (?, ?, 'direct', ?, NULL, ?)`).run(ORG, ref, minor, NOW);
        db.query(`INSERT INTO ledger
          (id, org_id, type, ref, settled_delta, held_delta, created_at)
          VALUES (?, ?, 'funding', ?, ?, 0, ?)`).run(`funding:${ref}`, ORG, ref, minor, NOW);
        db.query(`INSERT INTO wallet_credit_lot_classification_proofs
          (org_id, ref, original_kind, original_amount_minor, original_expires_at,
           consumption_class, evidence_ref, reviewed_at)
          VALUES (?, ?, 'direct', ?, NULL, ?, 'operator-reviewed-proof', ?)`).run(
          ORG,
          ref,
          minor,
          consumptionClass,
          NOW,
        );
      }
    });
    try {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "unknown",
        kind: "direct",
        consumptionClass: "purchased",
        amountMicros: 100_000,
      });
      expect(
        await capacity(f.sql, {
          amountMicros: 10_001,
          allocationAdmission: await f.policy.prepareAdmission(ORG),
        }),
      ).toMatchObject({ eligibleMicros: 10_000, deficitMicros: 1 });
      await f.policy.change({
        organizationId: ORG,
        authorizedPrincipal: "session:owner",
        reference: "prepaid",
        onLimit: "prepaid",
      });
      const prepaid = await f.policy.prepareAdmission(ORG);
      expect(
        await capacity(f.sql, { amountMicros: 40_001, allocationAdmission: prepaid }),
      ).toMatchObject({ eligibleMicros: 40_000, deficitMicros: 1 });
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "proven",
          amountMicros: 40_000,
          allocationAdmission: prepaid,
        }),
      ).toBe(true);
      expect(await capacity(f.sql, { allocationAdmission: prepaid })).toMatchObject({
        eligibleMicros: 0,
        deficitMicros: 1,
      });
      expect((await f.ledger.wallet(ORG)).availableMicros).toBe(100_000);
    } finally {
      f.db.close();
    }
  });

  test("shares class, provenance, expiry and Org isolation with actual allocation", async () => {
    const f = fixture();
    try {
      for (const lot of [
        { fundingRef: "free", kind: "plan-included", consumptionClass: "free", amountMicros: 10 },
        {
          fundingRef: "included",
          kind: "plan-included",
          consumptionClass: "subscription",
          amountMicros: 20,
        },
        {
          fundingRef: "purchase",
          kind: "purchased",
          consumptionClass: "purchased",
          amountMicros: 40,
        },
        { fundingRef: "unknown", kind: "direct", consumptionClass: "free", amountMicros: 50 },
        {
          fundingRef: "expired",
          kind: "purchased",
          consumptionClass: "purchased",
          amountMicros: 70,
          expiresAt: NOW,
        },
      ] as const)
        await f.ledger.fund({ organizationId: ORG, ...lot });
      await f.ledger.fund({
        organizationId: "other_org",
        fundingRef: "other",
        kind: "purchased",
        consumptionClass: "purchased",
        amountMicros: 999,
      });
      const stop = await f.policy.prepareAdmission(ORG);
      expect(await capacity(f.sql, { amountMicros: 31, allocationAdmission: stop })).toEqual({
        eligibleMicros: 30,
        deficitMicros: 1,
        refundReceivableBlocked: false,
      });
      expect(await capacity(f.sql, { amountMicros: 121 })).toEqual({
        eligibleMicros: 120,
        deficitMicros: 1,
        refundReceivableBlocked: false,
      });
      expect(await f.sql.query("SELECT * FROM wallet_credit_allocations")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "short",
          amountMicros: 31,
          allocationAdmission: stop,
        }),
      ).toBe(false);
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "reserved",
          amountMicros: 12,
          allocationAdmission: stop,
        }),
      ).toBe(true);
      expect(await capacity(f.sql, { amountMicros: 19, allocationAdmission: stop })).toMatchObject({
        eligibleMicros: 18,
        deficitMicros: 1,
      });
      expect(
        await f.sql.query(
          "SELECT lot_ref, amount_micros FROM wallet_credit_allocations ORDER BY lot_ref",
        ),
      ).toEqual([
        { lot_ref: "free", amount_micros: 10 },
        { lot_ref: "included", amount_micros: 2 },
      ]);
      await f.ledger.capture({ organizationId: ORG, reference: "reserved", amountMicros: 12 });
      expect(await capacity(f.sql, { allocationAdmission: stop })).toMatchObject({
        eligibleMicros: 18,
        deficitMicros: 0,
      });
      await f.policy.change({
        organizationId: ORG,
        authorizedPrincipal: "session:owner",
        reference: "prepaid",
        onLimit: "prepaid",
      });
      const prepaid = await f.policy.prepareAdmission(ORG);
      expect(
        await capacity(f.sql, { amountMicros: 59, allocationAdmission: prepaid }),
      ).toMatchObject({ eligibleMicros: 58, deficitMicros: 1 });
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "spend",
          amountMicros: 58,
          allocationAdmission: prepaid,
        }),
      ).toBe(true);
      expect(await capacity(f.sql, { allocationAdmission: prepaid })).toMatchObject({
        eligibleMicros: 0,
        deficitMicros: 1,
      });
    } finally {
      f.db.close();
    }
  });

  test("excludes future invoice credit and current paid Free while preserving pinned capture", async () => {
    const f = fixture();
    try {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "free",
        kind: "plan-included",
        consumptionClass: "free",
        amountMicros: 10,
        expiresAt: END,
      });
      f.setTime(START);
      const invoice: BillingGrant = {
        ...checkout(),
        fundingRef: "stripe:invoice:in_capacity",
        sourceType: "invoice",
        sourceId: "in_capacity",
        chargeId: "ch_invoice_capacity",
        kind: "plan-included",
        amountMicros: 200,
        considerationMicros: 100,
        subscriptionId: "sub_capacity",
        planKey: "configured-plan",
        pricingRevision: "configured-revision",
        stripePriceId: "price_configured",
        periodStart: START,
        periodEnd: END,
      };
      await f.store.grant(invoice);
      const admission = await f.policy.prepareAdmission(ORG);
      const options = { allocationAdmission: admission, hostedPaidFreeExclusion: true };
      expect(await capacity(f.sql, { ...options, amountMicros: 11 })).toMatchObject({
        eligibleMicros: 10,
        deficitMicros: 1,
      });
      expect(await capacity(f.sql, { ...options, now: START, amountMicros: 201 })).toMatchObject({
        eligibleMicros: 200,
        deficitMicros: 1,
      });
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "invoice-hold",
          amountMicros: 20,
          allocationAdmission: admission,
        }),
      ).toBe(true);
      f.setTime(NOW);
      expect(await capacity(f.sql, { ...options, amountMicros: 11 })).toMatchObject({
        eligibleMicros: 10,
        deficitMicros: 1,
      });
      await f.ledger.capture({ organizationId: ORG, reference: "invoice-hold", amountMicros: 20 });
      expect(await capacity(f.sql, { ...options, now: START })).toMatchObject({
        eligibleMicros: 180,
        deficitMicros: 0,
      });
      expect(await capacity(f.sql, { ...options, now: END })).toMatchObject({
        eligibleMicros: 0,
        deficitMicros: 1,
      });
      expect(
        await f.sql.query("SELECT amount_micros FROM wallet_credit_lots WHERE ref = ?", [
          invoice.fundingRef,
        ]),
      ).toEqual([{ amount_micros: 200 }]);
    } finally {
      f.db.close();
    }
  });

  test("subtracts used/held allocations and actual refunds, with debt distinct from a cash deficit", async () => {
    const f = fixture();
    try {
      const grant = checkout();
      await f.store.grant(grant);
      expect(
        await f.ledger.debitUsage({ organizationId: ORG, reference: "used", amountMicros: 80 }),
      ).toBe(true);
      expect(
        await f.ledger.hold({ organizationId: ORG, reference: "held", amountMicros: 10 }),
      ).toBe(true);
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "other",
        kind: "purchased",
        consumptionClass: "purchased",
        amountMicros: 40,
      });
      expect(await capacity(f.sql, { amountMicros: 51 })).toMatchObject({
        eligibleMicros: 50,
        deficitMicros: 1,
      });
      let generation = await f.store.freezeFunding(ORG, grant.fundingRef);
      expect(await capacity(f.sql)).toMatchObject({ eligibleMicros: 40, deficitMicros: 0 });
      expect(
        await f.store.refund({
          refundId: "re_partial_capacity",
          grant,
          amountMicros: 10,
          cumulativeRefundedMicros: 10,
          fenceGeneration: generation,
        }),
      ).toMatchObject({ debitMicros: 10, receivableMicros: 0 });
      expect(await capacity(f.sql, { amountMicros: 51 })).toMatchObject({
        eligibleMicros: 50,
        deficitMicros: 1,
      });
      expect((await f.ledger.wallet(ORG)).heldMicros).toBe(0);
      const planned = await prepareLedgerAllocation(f.sql, allocation("before-debt", 1));
      generation = await f.store.freezeFunding(ORG, grant.fundingRef);
      expect(
        await f.store.refund({
          refundId: "re_full_capacity",
          grant,
          amountMicros: 90,
          cumulativeRefundedMicros: 100,
          fenceGeneration: generation,
        }),
      ).toMatchObject({ debitMicros: 10, receivableMicros: 80 });
      expect(await capacity(f.sql, { amountMicros: 41 })).toEqual({
        eligibleMicros: 40,
        deficitMicros: null,
        refundReceivableBlocked: true,
      });
      await expect(f.sql.batch(planned)).rejects.toBeInstanceOf(SqlError);
      expect(
        await f.ledger.hold({ organizationId: ORG, reference: "debt-blocked", amountMicros: 1 }),
      ).toBe(false);
      expect(await f.sql.query("SELECT * FROM ledger WHERE ref = 'before-debt'")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("capacity snapshots confer no policy or allocation authority across a competing batch", async () => {
    const f = fixture();
    try {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "purchase",
        kind: "purchased",
        consumptionClass: "purchased",
        amountMicros: 100,
      });
      await f.policy.change({
        organizationId: ORG,
        authorizedPrincipal: "session:owner",
        reference: "prepaid",
        onLimit: "prepaid",
      });
      const prepaid = await f.policy.prepareAdmission(ORG);
      const input = { ...allocation("first", 60), allocationAdmission: prepaid };
      expect(await capacity(f.sql, input)).toMatchObject({ eligibleMicros: 100, deficitMicros: 0 });
      const first = await prepareLedgerAllocation(f.sql, input);
      const second = await prepareLedgerAllocation(f.sql, { ...input, reference: "second" });
      await f.sql.batch(first);
      await expect(f.sql.batch(second)).rejects.toBeInstanceOf(SqlError);
      expect(
        await capacity(f.sql, { amountMicros: 60, allocationAdmission: prepaid }),
      ).toMatchObject({ eligibleMicros: 40, deficitMicros: 20 });
      const stalePolicy = await prepareLedgerAllocation(f.sql, {
        ...allocation("stale-policy", 1),
        allocationAdmission: prepaid,
      });
      await f.policy.change({
        organizationId: ORG,
        authorizedPrincipal: "session:owner",
        reference: "stop",
        onLimit: "stop",
      });
      await expect(f.sql.batch(stalePolicy)).rejects.toBeInstanceOf(SqlError);
      expect(
        await capacity(f.sql, { allocationAdmission: await f.policy.prepareAdmission(ORG) }),
      ).toMatchObject({ eligibleMicros: 0, deficitMicros: 1 });
      await f.ledger.release({ organizationId: ORG, reference: "first", amountMicros: 60 });
      expect(await capacity(f.sql)).toMatchObject({ eligibleMicros: 100, deficitMicros: 0 });
    } finally {
      f.db.close();
    }
  });

  test("atomic allocation rejects advisory capacity retained from before the expiry boundary", async () => {
    const f = fixture();
    try {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "expires",
        kind: "purchased",
        consumptionClass: "purchased",
        amountMicros: 100,
        expiresAt: START,
      });
      let before: readonly Row[] = [];
      const recording: Sql = {
        async query(statement, params) {
          const rows = await f.sql.query(statement, params);
          if (statement.includes("SELECT l.ref,")) before = rows;
          return rows;
        },
        run: (statement, params) => f.sql.run(statement, params),
        batch: (statements) => f.sql.batch(statements),
      };
      await prepareLedgerAllocation(recording, allocation("old", 1));
      expect(before).toHaveLength(1);
      expect(await capacity(f.sql, { now: START })).toMatchObject({
        eligibleMicros: 0,
        deficitMicros: 1,
      });
      const stale: Sql = {
        ...recording,
        query: (statement, params) =>
          statement.includes("SELECT l.ref,")
            ? Promise.resolve(before)
            : f.sql.query(statement, params),
      };
      await expect(
        f.sql.batch(await prepareLedgerAllocation(stale, allocation("expired", 1, START))),
      ).rejects.toBeInstanceOf(SqlError);
      expect(await f.sql.query("SELECT * FROM wallet_credit_allocations")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM ledger WHERE type = 'hold'")).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("pre-Stripe schemas retain standalone allocation and checked zero/maximum deficits", async () => {
    const f = fixture("0094");
    const standalone = createLedger(f.sql, () => new Date(NOW));
    try {
      expect(await stripeRefundSource(f.sql)).toBeNull();
      expect(await capacity(f.sql, { amountMicros: Number.MAX_SAFE_INTEGER })).toEqual({
        eligibleMicros: 0,
        deficitMicros: Number.MAX_SAFE_INTEGER,
        refundReceivableBlocked: false,
      });
      expect(await capacity(f.sql, { amountMicros: 0 })).toMatchObject({
        eligibleMicros: 0,
        deficitMicros: 0,
      });
      await standalone.fund({
        organizationId: ORG,
        fundingRef: "legacy",
        kind: "direct",
        consumptionClass: "purchased",
        amountMicros: 100,
      });
      expect(await capacity(f.sql, { amountMicros: 101 })).toMatchObject({
        eligibleMicros: 100,
        deficitMicros: 1,
      });
      expect(
        await standalone.hold({ organizationId: ORG, reference: "legacy-hold", amountMicros: 100 }),
      ).toBe(true);
      expect(await capacity(f.sql)).toMatchObject({ eligibleMicros: 0, deficitMicros: 1 });
      for (const amountMicros of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1])
        await expect(
          prepareLedgerEligibleCapacity(f.sql, { organizationId: ORG, now: NOW, amountMicros }),
        ).rejects.toMatchObject({ code: "invalid_amount" });
      const prepared = await prepareLedgerEligibleCapacity(f.sql, {
        organizationId: ORG,
        now: NOW,
        amountMicros: 1,
      });
      expect(() => prepared.decode([])).toThrow();
      expect(() =>
        prepared.decode([{ eligible_micros: 0, deficit_micros: 2, receivable_blocked: 0 }]),
      ).toThrow();
      expect(() =>
        prepared.decode([
          {
            eligible_micros: Number.MAX_SAFE_INTEGER + 1,
            deficit_micros: 0,
            receivable_blocked: 0,
          },
        ]),
      ).toThrow();
      const stripeMigration = MIGRATIONS.find(({ name }) => name === "0095_stripe_billing.sql");
      if (!stripeMigration) throw new Error("Stripe migration missing");
      f.db.exec(stripeMigration.sql);
      expect(await stripeRefundSource(f.sql)).toBe("stripe_billing_refunds");
      expect(await capacity(f.sql)).toMatchObject({ eligibleMicros: 0, deficitMicros: 1 });
    } finally {
      f.db.close();
    }
  });

  test("a standalone seeded union view is not a qualified refund source", async () => {
    const f = fixture();
    try {
      expect(await stripeRefundSource(f.sql)).toBe("stripe_billing_refunds");
      await f.sql.run(
        "CREATE VIEW stripe_billing_refund_receipts_all AS SELECT * FROM stripe_billing_refunds",
      );
      await expect(stripeRefundSource(f.sql)).rejects.toMatchObject({
        code: "conservation_violated",
      });
      await expect(capacity(f.sql)).rejects.toMatchObject({ code: "conservation_violated" });
      await expect(f.ledger.wallet(ORG)).rejects.toMatchObject({ code: "conservation_violated" });
    } finally {
      f.db.close();
    }
  });
});
