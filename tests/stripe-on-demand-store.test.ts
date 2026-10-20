import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  createLedger,
  prepareLedgerAllocation,
  prepareLedgerEligibleCapacity,
} from "../src/ledger.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  assertStripeBillingStoreOrigin,
  type BillingGrant,
  createStripeBillingStore,
} from "../src/stripe-billing-store.ts";
import {
  type StripeOnDemandFundingExpected,
  type StripeOnDemandFundingProof,
  verifyStripeOnDemandFunding,
} from "../src/stripe-on-demand-verification.ts";
import { migratedDatabase } from "./helpers/migrated-database.ts";

const preparedAt = "2026-10-15T12:00:00.000Z";
const dispatchedAt = "2026-10-15T12:00:01.000Z";
const observedAt = "2026-10-15T12:00:02.123Z";
const fundedAt = "2026-10-15T12:00:03.456Z";

function insert(table: string, values: Record<string, string | number | null>): SqlStatement {
  const keys = Object.keys(values);
  return {
    sql: `INSERT INTO ${table} (${keys.join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
    params: Object.values(values),
  };
}

// These rows are a durable-command fixture for the store boundary. They are
// not evidence of authenticated consent, fresh admission or a provider POST.
async function fixture(
  options: {
    readonly seconds?: number | null;
    readonly extended?: boolean;
    readonly wrap?: (sql: Sql) => Sql;
  } = {},
) {
  const db = migratedDatabase(options.extended === false ? 99 : MIGRATIONS.length);
  const originalSql = createSqliteSql(db);
  const sql = options.wrap?.(originalSql) ?? originalSql;
  let instant = fundedAt;
  let clockCalls = 0;
  const clock = () => {
    clockCalls++;
    return new Date(instant);
  };
  const store = createStripeBillingStore({ sql, clock });
  const ledger = createLedger(sql, clock);
  const metadata = {
    organizationId: "org_store",
    reference: "onDemand",
    fingerprint: "original-fingerprint",
    fundingRef: "stripe:on-demand:store",
    stripeAccountId: "acct_STORE",
    financialRealm: `realm:${"a".repeat(64)}`,
    billingAuthority: "store.test",
  };
  const expected: StripeOnDemandFundingExpected = {
    organizationId: metadata.organizationId,
    reference: metadata.reference,
    fingerprint: metadata.fingerprint,
    fundingRef: metadata.fundingRef,
    accountId: metadata.stripeAccountId,
    mode: "test",
    financialRealm: metadata.financialRealm,
    billingAuthority: metadata.billingAuthority,
    customerId: "cus_store",
    paymentMethodId: "pm_store",
    paymentIntentId: "pi_store",
    chargeId: "ch_store",
    currency: "USD",
    amountMinor: 10,
    observedAt,
    metadata,
  };
  const native = (refundedAmountMinor = 0, readAt = observedAt): StripeOnDemandFundingProof =>
    verifyStripeOnDemandFunding(
      { ...expected, observedAt: readAt },
      {
        paymentIntent: {
          object: "payment_intent",
          id: expected.paymentIntentId,
          livemode: false,
          status: "succeeded",
          customer: expected.customerId,
          payment_method: expected.paymentMethodId,
          currency: "usd",
          amount: 10,
          amount_received: 10,
          amount_capturable: 0,
          latest_charge: expected.chargeId,
          metadata,
        },
        charge: {
          object: "charge",
          id: expected.chargeId,
          livemode: false,
          status: "succeeded",
          payment_intent: expected.paymentIntentId,
          payment_method: expected.paymentMethodId,
          customer: expected.customerId,
          currency: "usd",
          amount: 10,
          amount_captured: 10,
          paid: true,
          captured: true,
          disputed: false,
          amount_refunded: refundedAmountMinor,
          refunded: refundedAmountMinor === 10,
          payment_method_details: { type: "card" },
        },
      },
    );
  const command = {
    org_id: expected.organizationId,
    reference: expected.reference,
    admission_json: JSON.stringify({
      organizationId: expected.organizationId,
      namespace: "store-fixture",
      reference: "hold-original",
      fingerprint: "original-admission",
    }),
    exposure_ref: "exposure-original",
    funding_ref: expected.fundingRef,
    fingerprint: expected.fingerprint,
    account_id: expected.accountId,
    mode: expected.mode,
    billing_authority: expected.billingAuthority,
    customer_id: expected.customerId,
    payment_method_id: expected.paymentMethodId,
    setup_intent_id: null,
    authorized_principal: "session:store-owner",
    consent_revision: "consent-original",
    terms_revision: "terms-original",
    terms_json: JSON.stringify({ revision: "terms-original" }),
    consent_json: JSON.stringify({ revision: "consent-original" }),
    request_json: JSON.stringify({
      amount: 10,
      currency: "usd",
      customer: expected.customerId,
      payment_method: expected.paymentMethodId,
      off_session: true,
      confirm: true,
      metadata,
    }),
    policy_version: 1,
    cap_minor: 100,
    period_start: "2026-10-01T00:00:00.000Z",
    period_end: "2026-11-01T00:00:00.000Z",
    amount_minor: 10,
    credit_expiry_kind: options.seconds === null ? "none" : "fixed-duration",
    credit_expiry_seconds: options.seconds === null ? null : (options.seconds ?? 3600),
    terms_expires_at: "2026-10-16T00:00:00.000Z",
    stripe_key: "original-stripe-key",
    state: "prepared",
    dispatched_at: null,
    payment_intent_id: null,
    created_at: preparedAt,
  };
  if (options.extended !== false) {
    await sql.batch([
      insert("stripe_mode_realm", { singleton: 1, mode: "test", pinned_at: preparedAt }),
      insert("stripe_billing_account_realms", {
        singleton: 1,
        account_id: expected.accountId,
        mode: "test",
        billing_authority: expected.billingAuthority,
        created_at: preparedAt,
      }),
      insert("stripe_billing_customers", {
        org_id: expected.organizationId,
        customer_id: expected.customerId,
        created_at: preparedAt,
      }),
      insert("org_wallet_limit_policies", {
        org_id: expected.organizationId,
        on_limit: "on-demand",
        policy_version: 1,
        consent_revision: command.consent_revision,
        cash_cap_minor: 100,
        authorized_principal: command.authorized_principal,
        updated_at: preparedAt,
      }),
      insert("org_wallet_cash_cap_buckets", {
        org_id: expected.organizationId,
        period_start: command.period_start,
        period_end: command.period_end,
      }),
      insert("org_wallet_cash_exposures", {
        org_id: expected.organizationId,
        ref: command.exposure_ref,
        period_start: command.period_start,
        period_end: command.period_end,
        policy_version: 1,
        consent_revision: command.consent_revision,
        amount_minor: 10,
        status: "reserved",
        source_ref: null,
        created_at: preparedAt,
        closed_at: null,
      }),
      insert("stripe_billing_on_demand_commands", command),
    ]);
    await sql.batch([
      insert("stripe_billing_on_demand_attempts", {
        org_id: expected.organizationId,
        reference: expected.reference,
        sequence: 1,
        kind: "first-dispatch",
        detail_json: "{}",
        created_at: dispatchedAt,
        first_dispatch_at: dispatchedAt,
      }),
      {
        sql: "UPDATE stripe_billing_on_demand_commands SET state='dispatched',dispatched_at=? WHERE org_id=? AND reference=?",
        params: [dispatchedAt, expected.organizationId, expected.reference],
      },
    ]);
  }
  const fund = (proof = native()) =>
    store.grantOnDemand({
      organizationId: expected.organizationId,
      reference: expected.reference,
      expectedCommandFingerprint: expected.fingerprint,
      native: proof,
    });
  const refund = (
    grant: BillingGrant,
    refundId: string,
    amountMinor: number,
    cumulativeMinor: number,
    fenceGeneration: number,
    releaseFreeze = true,
  ) =>
    store.refund({
      grant,
      refundId,
      amountMicros: amountMinor * 10000,
      cumulativeRefundedMicros: cumulativeMinor * 10000,
      fenceGeneration,
      releaseFreeze,
      native: native(cumulativeMinor, instant),
    });
  return {
    db,
    sql,
    originalSql,
    store,
    ledger,
    expected,
    native,
    command,
    fund,
    refund,
    setNow(value: string) {
      instant = value;
    },
    clockCalls: () => clockCalls,
  };
}

async function snapshot(sql: Sql) {
  const tables = [
    "wallet_credit_lots",
    "ledger",
    "wallet_credit_allocations",
    "stripe_billing_grants",
    "stripe_billing_refunds",
    "stripe_billing_on_demand_commands",
    "stripe_billing_on_demand_terminals",
    "stripe_billing_on_demand_funding",
    "stripe_billing_on_demand_refunds",
    "org_wallet_cash_exposures",
    "wallet_allocation_guards",
  ];
  return Promise.all(tables.map((table) => sql.query(`SELECT * FROM ${table} ORDER BY rowid`)));
}
function checkout(chargeId = "ch_legacy"): BillingGrant {
  return {
    organizationId: "org_store",
    fundingRef: "stripe:cs_legacy",
    kind: "purchased",
    amountMicros: 50000,
    expiresAt: null,
    sourceType: "checkout",
    sourceId: "cs_legacy",
    chargeId,
    customerId: "cus_store",
    subscriptionId: null,
    planKey: null,
    pricingRevision: null,
    stripePriceId: null,
    periodStart: null,
    periodEnd: null,
    considerationMicros: 50000,
  };
}

describe("common store original on-demand funding and refunds", () => {
  test("only the factory's exact SQL and clock identity establishes store origin", async () => {
    const db = new Database(":memory:");
    try {
      const sql = createSqliteSql(db);
      const clock = () => new Date(fundedAt);
      const store = createStripeBillingStore({ sql, clock });
      expect(() => assertStripeBillingStoreOrigin(store, { sql, clock })).not.toThrow();
      const original = store.grantOnDemand;
      expect(Reflect.set(store, "grantOnDemand", async () => null)).toBe(false);
      expect(store.grantOnDemand).toBe(original);
      expect(() =>
        Object.defineProperty(store, "grantOnDemand", { value: async () => null }),
      ).toThrow(TypeError);
      expect(() => assertStripeBillingStoreOrigin({ ...store }, { sql, clock })).toThrow(
        "invalid_store_origin",
      );
      expect(() => assertStripeBillingStoreOrigin(store, { sql: { ...sql }, clock })).toThrow(
        "invalid_store_origin",
      );
      expect(() =>
        assertStripeBillingStoreOrigin(store, { sql, clock: () => new Date(fundedAt) }),
      ).toThrow("invalid_store_origin");
    } finally {
      db.close();
    }
  });

  test("one store instant fixes funding/lot/ledger expiry; late replay returns the saved original", async () => {
    const f = await fixture();
    try {
      const calls = f.clockCalls();
      const grant = await f.fund();
      expect(f.clockCalls() - calls).toBe(1);
      expect(grant).toMatchObject({
        sourceType: "payment-intent",
        sourceId: "pi_store",
        amountMicros: 100000,
        considerationMicros: 100000,
        expiresAt: "2026-10-15T13:00:03.456Z",
      });
      expect(await f.store.grantForSource("payment-intent", "pi_store")).toEqual(grant);
      expect(await f.store.grantsForCharge("ch_store")).toEqual([grant]);
      expect(
        await f.sql.query("SELECT state,payment_intent_id FROM stripe_billing_on_demand_commands"),
      ).toEqual([{ state: "paid", payment_intent_id: "pi_store" }]);
      expect(
        await f.sql.query("SELECT status,source_ref,closed_at FROM org_wallet_cash_exposures"),
      ).toEqual([{ status: "paid", source_ref: "pi_store", closed_at: fundedAt }]);
      expect(
        await f.sql.query("SELECT amount_micros,expires_at,created_at FROM wallet_credit_lots"),
      ).toEqual([{ amount_micros: 100000, expires_at: grant.expiresAt, created_at: fundedAt }]);
      expect(
        await f.sql.query(
          "SELECT settled_delta_micros,created_at FROM ledger WHERE type='funding'",
        ),
      ).toEqual([{ settled_delta_micros: 100000, created_at: fundedAt }]);
      expect(
        await f.sql.query("SELECT expires_at,created_at FROM stripe_billing_on_demand_funding"),
      ).toEqual([{ expires_at: grant.expiresAt, created_at: fundedAt }]);
      const before = await snapshot(f.sql);
      f.setNow("2027-04-01T00:00:00.000Z");
      const beforeReplay = f.clockCalls();
      expect(await f.fund(f.native(0, "2027-04-01T00:00:00.000Z"))).toEqual(grant);
      expect(f.clockCalls()).toBe(beforeReplay);
      expect(await snapshot(f.sql)).toEqual(before);
    } finally {
      f.db.close();
    }
  });

  test("late original success drains after policy withdrawal/term expiry without extending frozen duration", async () => {
    const f = await fixture({ seconds: 90 });
    try {
      // Direct future-writer witness only; current policy writer presently refuses
      // withdrawal while reserved exposure exists. No admission claim is made.
      await f.sql.run(
        "UPDATE org_wallet_limit_policies SET on_limit='stop',policy_version=2,consent_revision=NULL,cash_cap_minor=NULL WHERE org_id='org_store'",
      );
      f.setNow("2026-11-01T00:00:00.789Z");
      const grant = await f.fund(f.native(0, "2026-11-01T00:00:00.123Z"));
      expect(grant.expiresAt).toBe("2026-11-01T00:01:30.789Z");
      expect(
        await f.sql.query(
          "SELECT period_start,period_end,status,amount_minor FROM org_wallet_cash_exposures",
        ),
      ).toEqual([
        {
          period_start: "2026-10-01T00:00:00.000Z",
          period_end: "2026-11-01T00:00:00.000Z",
          status: "paid",
          amount_minor: 10,
        },
      ]);
      expect(
        await f.sql.query(
          "SELECT terms_revision,policy_version FROM stripe_billing_on_demand_commands",
        ),
      ).toEqual([{ terms_revision: "terms-original", policy_version: 1 }]);
    } finally {
      f.db.close();
    }
  });

  test("none expiry remains null; the new source cannot enter the legacy grant writer", async () => {
    const f = await fixture({ seconds: null });
    try {
      const grant = await f.fund();
      expect(grant.expiresAt).toBeNull();
      await expect(f.store.grant(grant)).rejects.toMatchObject({ code: "invalid_grant" });
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type='funding'")).toEqual([
        { n: 1 },
      ]);
    } finally {
      f.db.close();
    }
  });

  test("changed original tuples, future observations and delayed expiry overflow leave every row unchanged", async () => {
    const f = await fixture();
    try {
      const before = await snapshot(f.sql);
      for (const override of [
        { customerId: "cus_other" },
        { financialRealm: "realm:other" },
        { fundingRef: "other" },
        { fingerprint: "other" },
        { amountMinor: 11 },
        { paymentMethodId: "pm_other" },
        { accountId: "acct_OTHER" },
        { billingAuthority: "other" },
      ]) {
        await expect(f.fund({ ...f.native(), ...override })).rejects.toMatchObject({
          code: "grant_conflict",
        });
        expect(await snapshot(f.sql)).toEqual(before);
      }
      await expect(f.fund(f.native(0, "2026-10-16T00:00:00.000Z"))).rejects.toMatchObject({
        code: "invalid_time",
      });
      f.setNow("9999-12-31T23:59:00.000Z");
      await expect(f.fund()).rejects.toMatchObject({ code: "invalid_expiry" });
      expect(await snapshot(f.sql)).toEqual(before);
    } finally {
      f.db.close();
    }
  });

  test("the store serializes only closed known proof fields", async () => {
    const f = await fixture();
    try {
      await f.fund({
        ...f.native(),
        client_secret: "never-persist",
        card: { number: "never-persist" },
        metadata: { arbitrary: "never-persist" },
      } as StripeOnDemandFundingProof);
      const rows = await f.sql.query(
        "SELECT native_receipt_json FROM stripe_billing_on_demand_terminals",
      );
      expect(JSON.parse(String(rows[0]?.native_receipt_json))).toEqual(f.native());
      expect(String(rows[0]?.native_receipt_json)).not.toContain("never-persist");
    } finally {
      f.db.close();
    }
  });

  test("terminal, money, receipt and both paid closures roll back together", async () => {
    const f = await fixture();
    try {
      const before = await snapshot(f.sql);
      f.db.exec(
        "CREATE TRIGGER test_paid_failure BEFORE UPDATE OF state ON stripe_billing_on_demand_commands WHEN NEW.state='paid' BEGIN SELECT RAISE(ABORT,'constraint: injected terminal closure failure'); END",
      );
      await expect(f.fund()).rejects.toMatchObject({ code: "constraint" });
      expect(await snapshot(f.sql)).toEqual(before);
      f.db.exec("DROP TRIGGER test_paid_failure");
      await f.fund();
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type='funding'")).toEqual([
        { n: 1 },
      ]);
    } finally {
      f.db.close();
    }
  });

  test("lost database acknowledgement and racing store clocks retain one original receipt", async () => {
    let lose = true;
    const f = await fixture({
      wrap: (sql) => ({
        ...sql,
        async batch(statements) {
          const result = await sql.batch(statements);
          if (
            lose &&
            statements.some((s) => s.sql.includes("INSERT INTO stripe_billing_on_demand_funding"))
          ) {
            lose = false;
            throw new SqlError("unavailable", "lost local acknowledgement");
          }
          return result;
        },
      }),
    });
    try {
      const secondStore = createStripeBillingStore({
        sql: f.sql,
        clock: () => new Date("2026-10-15T12:00:04.999Z"),
      });
      const results = await Promise.all([
        f.fund(),
        secondStore.grantOnDemand({
          organizationId: f.expected.organizationId,
          reference: f.expected.reference,
          expectedCommandFingerprint: f.expected.fingerprint,
          native: f.native(),
        }),
      ]);
      const first = results[0];
      expect(results).toEqual([first, first]);
      const original = (
        await f.sql.query("SELECT created_at FROM stripe_billing_on_demand_funding")
      )[0];
      expect(first?.expiresAt).toBe(
        new Date(Date.parse(String(original?.created_at)) + 3600000).toISOString(),
      );
      f.setNow("2026-12-01T00:00:00.000Z");
      expect(await f.fund(f.native(0, "2026-12-01T00:00:00.000Z"))).toEqual(first);
      expect(
        await f.sql.query("SELECT COUNT(*) AS n FROM stripe_billing_on_demand_funding"),
      ).toEqual([{ n: 1 }]);
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type='funding'")).toEqual([
        { n: 1 },
      ]);
    } finally {
      f.db.close();
    }
  });

  test("legacy/new Charge collisions reject both insertion orders without partial money", async () => {
    for (const order of ["old-first", "new-first"]) {
      const f = await fixture();
      try {
        if (order === "old-first") await f.store.grant(checkout("ch_store"));
        else await f.fund();
        const before = await snapshot(f.sql);
        if (order === "old-first")
          await expect(f.fund()).rejects.toMatchObject({ code: "constraint" });
        else
          await expect(f.store.grant(checkout("ch_store"))).rejects.toMatchObject({
            code: "constraint",
          });
        expect(await snapshot(f.sql)).toEqual(before);
        expect((await f.store.grantsForCharge("ch_store")).length).toBe(1);
      } finally {
        f.db.close();
      }
    }
  });

  test("unused partial/full refunds keep original face value and cumulative idempotent receipts", async () => {
    const f = await fixture();
    try {
      const grant = await f.fund();
      const generation = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      const first = await f.refund(grant, "re_part", 3, 3, generation, false);
      const second = await f.refund(grant, "re_rest", 7, 10, generation, false);
      expect(first).toMatchObject({
        debitMicros: 30000,
        receivableMicros: 0,
        expiredMicros: 0,
        targetRevokedMicros: 30000,
      });
      expect(second).toMatchObject({
        debitMicros: 70000,
        receivableMicros: 0,
        expiredMicros: 0,
        targetRevokedMicros: 100000,
      });
      const before = await snapshot(f.sql);
      f.setNow("2026-12-01T00:00:00.000Z");
      expect(await f.refund(grant, "re_rest", 7, 10, generation, false)).toEqual(second);
      expect(await snapshot(f.sql)).toEqual(before);
      await f.store.unfreezeFunding({
        organizationId: grant.organizationId,
        fundingRef: grant.fundingRef,
        fenceGeneration: generation,
        cumulativeRefundedMicros: 100000,
      });
      expect(await f.sql.query("SELECT active FROM stripe_billing_fences")).toEqual([
        { active: 0 },
      ]);
      expect(await f.sql.query("SELECT amount_micros FROM wallet_credit_lots")).toEqual([
        { amount_micros: 100000 },
      ]);
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM stripe_billing_refunds")).toEqual([
        { n: 0 },
      ]);
      expect(
        await f.sql.query(
          "SELECT SUM(amount_micros) AS amount,SUM(debit_micros) AS debit FROM stripe_billing_refund_receipts_all",
        ),
      ).toEqual([{ amount: 100000, debit: 100000 }]);
    } finally {
      f.db.close();
    }
  });

  test("used credit and held refunds feed the common wallet, capacity and atomic debt guards", async () => {
    const f = await fixture();
    try {
      const grant = await f.fund();
      const capacity = async (amountMicros: number) => {
        const prepared = await prepareLedgerEligibleCapacity(f.sql, {
          organizationId: grant.organizationId,
          now: fundedAt,
          amountMicros,
        });
        return prepared.decode(
          await f.sql.query(prepared.statement.sql, prepared.statement.params),
        );
      };
      expect(
        await f.ledger.debitUsage({
          organizationId: grant.organizationId,
          reference: "usage",
          amountMicros: 60000,
        }),
      ).toBe(true);
      expect(
        await f.ledger.hold({
          organizationId: grant.organizationId,
          reference: "held",
          amountMicros: 20000,
        }),
      ).toBe(true);
      await f.store.grant(checkout());
      expect(await capacity(70001)).toEqual({
        eligibleMicros: 70000,
        deficitMicros: 1,
        refundReceivableBlocked: false,
      });
      const generation = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      expect(await capacity(50001)).toEqual({
        eligibleMicros: 50000,
        deficitMicros: 1,
        refundReceivableBlocked: false,
      });
      expect(await f.ledger.wallet(grant.organizationId)).toMatchObject({
        heldMicros: 20000,
        frozenMicros: 20000,
        availableMicros: 50000,
        refundReceivableMicros: 0,
      });
      // Under the active PI fence this plan can select only the unaffected legacy lot.
      // The later failure therefore proves the Org debt guard, not merely PI-lot CAS.
      const beforeDebt = await prepareLedgerAllocation(f.sql, {
        organizationId: grant.organizationId,
        type: "hold",
        reference: "before-debt",
        amountMicros: 1,
        settledDeltaMicros: 0,
        heldDeltaMicros: 1,
        now: fundedAt,
      });
      const receipt = await f.refund(grant, "re_used", 10, 10, generation);
      expect(receipt).toMatchObject({
        debitMicros: 40000,
        receivableMicros: 60000,
        expiredMicros: 0,
      });
      expect(await capacity(50001)).toEqual({
        eligibleMicros: 50000,
        deficitMicros: null,
        refundReceivableBlocked: true,
      });
      const wallet = await f.ledger.wallet(grant.organizationId);
      expect(wallet).toMatchObject({
        settledMicros: 50000,
        heldMicros: 0,
        frozenMicros: 0,
        availableMicros: 50000,
        refundReceivableMicros: 60000,
      });
      expect(
        wallet.entries.filter((e) => e.type === "refund_debit" && e.reference === "re_used"),
      ).toHaveLength(1);
      expect(
        wallet.entries.find((e) => e.type === "refund_debit" && e.reference === "re_used")
          ?.settledDeltaMicros,
      ).toBe(-40000);
      expect(
        wallet.entries.filter((e) => e.type === "refund_receivable" && e.reference === "re_used"),
      ).toHaveLength(1);
      await expect(f.sql.batch(beforeDebt)).rejects.toBeInstanceOf(SqlError);
      expect(await f.sql.query("SELECT * FROM ledger WHERE ref='before-debt'")).toEqual([]);
      expect(
        await f.sql.query("SELECT * FROM wallet_credit_allocations WHERE debit_type='hold'"),
      ).toEqual([]);
      expect(
        await f.ledger.hold({
          organizationId: grant.organizationId,
          reference: "debt-new",
          amountMicros: 1,
        }),
      ).toBe(false);
      expect(
        await f.ledger.debitUsage({
          organizationId: grant.organizationId,
          reference: "debt-new",
          amountMicros: 1,
        }),
      ).toBe(false);
      expect(
        await f.sql.query(
          "SELECT held_delta_micros FROM ledger WHERE type='release' AND ref='held'",
        ),
      ).toEqual([{ held_delta_micros: -20000 }]);
      expect(
        await f.sql.query("SELECT amount_micros FROM wallet_credit_lots WHERE ref=?", [
          checkout().fundingRef,
        ]),
      ).toEqual([{ amount_micros: 50000 }]);
      expect(
        await f.sql.query(
          "SELECT settled_delta_micros FROM ledger WHERE type='funding' ORDER BY settled_delta_micros",
        ),
      ).toEqual([{ settled_delta_micros: 50000 }, { settled_delta_micros: 100000 }]);
      expect(
        await f.sql.query(
          "SELECT * FROM ledger WHERE type IN ('refund_debit','refund_receivable')",
        ),
      ).toEqual([]);
      expect(await f.sql.query("SELECT * FROM stripe_billing_refunds")).toEqual([]);
      expect(
        await f.sql.query("SELECT COUNT(*) AS n FROM stripe_billing_on_demand_refunds"),
      ).toEqual([{ n: 1 }]);
      expect(await f.sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("expired unused credit is revoked without new debt", async () => {
    const f = await fixture({ seconds: 1 });
    try {
      const grant = await f.fund();
      f.setNow("2026-10-15T12:00:05.000Z");
      const generation = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      expect(await f.refund(grant, "re_expired", 10, 10, generation)).toMatchObject({
        debitMicros: 0,
        receivableMicros: 0,
        expiredMicros: 100000,
      });
      expect(await f.sql.query("SELECT amount_micros,expires_at FROM wallet_credit_lots")).toEqual([
        { amount_micros: 100000, expires_at: grant.expiresAt },
      ]);
    } finally {
      f.db.close();
    }
  });

  test("refunded-before-first-funding requires an active original fence; incomplete drain cannot unfreeze", async () => {
    const f = await fixture();
    try {
      const before = await snapshot(f.sql);
      await expect(f.fund(f.native(5))).rejects.toMatchObject({ code: "constraint" });
      expect(await snapshot(f.sql)).toEqual(before);
      const generation = await f.store.freezeFunding(
        f.expected.organizationId,
        f.expected.fundingRef,
      );
      const grant = await f.fund(f.native(5));
      expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
      await expect(
        f.store.unfreezeFunding({
          organizationId: grant.organizationId,
          fundingRef: grant.fundingRef,
          fenceGeneration: generation,
          cumulativeRefundedMicros: 0,
        }),
      ).rejects.toMatchObject({ code: "refund_out_of_order" });
      await expect(
        f.store.refund({
          grant,
          refundId: "re_incomplete",
          amountMicros: 10000,
          cumulativeRefundedMicros: 10000,
          fenceGeneration: generation,
          native: f.native(5),
        }),
      ).rejects.toMatchObject({ code: "refund_drain_incomplete" });
      await expect(
        f.store.unfreezeFunding({
          organizationId: grant.organizationId,
          fundingRef: grant.fundingRef,
          fenceGeneration: generation,
          cumulativeRefundedMicros: 50000,
        }),
      ).rejects.toMatchObject({ code: "refund_out_of_order" });
      await f.refund(grant, "re_prior", 5, 5, generation, false);
      await f.store.unfreezeFunding({
        organizationId: grant.organizationId,
        fundingRef: grant.fundingRef,
        fenceGeneration: generation,
        cumulativeRefundedMicros: 50000,
      });
      expect(await f.sql.query("SELECT active FROM stripe_billing_fences")).toEqual([
        { active: 0 },
      ]);
    } finally {
      f.db.close();
    }
  });

  test("a partial receipt retains the full native refund obligation across replay and unfreeze", async () => {
    const f = await fixture();
    try {
      const grant = await f.fund();
      const generation = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      const input = {
        grant,
        refundId: "re_observed",
        amountMicros: 10000,
        cumulativeRefundedMicros: 10000,
        fenceGeneration: generation,
        native: f.native(5),
        releaseFreeze: false,
      };
      const first = await f.store.refund(input);
      const before = await snapshot(f.sql);
      expect(
        await f.store.refund({ ...input, native: f.native(5, "2026-10-15T12:00:04.000Z") }),
      ).toEqual(first);
      await expect(
        f.store.unfreezeFunding({
          organizationId: grant.organizationId,
          fundingRef: grant.fundingRef,
          fenceGeneration: generation,
          cumulativeRefundedMicros: 10000,
        }),
      ).rejects.toMatchObject({ code: "refund_out_of_order" });
      expect(await snapshot(f.sql)).toEqual(before);
      expect(await f.sql.query("SELECT active FROM stripe_billing_fences")).toEqual([
        { active: 1 },
      ]);
      await f.refund(grant, "re_observedRest", 4, 5, generation);
      expect(await f.sql.query("SELECT active FROM stripe_billing_fences")).toEqual([
        { active: 0 },
      ]);
    } finally {
      f.db.close();
    }
  });

  test("new-source refunds reject stale generations, insufficient native cumulative and conflicting receipt IDs atomically", async () => {
    const f = await fixture();
    try {
      const grant = await f.fund();
      const old = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      const current = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      let before = await snapshot(f.sql);
      await expect(f.refund(grant, "re_stale", 1, 1, old)).rejects.toMatchObject({
        code: "constraint",
      });
      expect(await snapshot(f.sql)).toEqual(before);
      await expect(
        f.store.refund({
          grant,
          refundId: "re_unverified",
          amountMicros: 10000,
          cumulativeRefundedMicros: 10000,
          fenceGeneration: current,
          native: f.native(0),
        }),
      ).rejects.toMatchObject({ code: "invalid_native_proof" });
      expect(await snapshot(f.sql)).toEqual(before);
      await f.store.grant(checkout());
      const legacy = checkout();
      const legacyGeneration = await f.store.freezeFunding(
        legacy.organizationId,
        legacy.fundingRef,
      );
      await f.store.refund({
        grant: legacy,
        refundId: "re_collision",
        amountMicros: 10000,
        cumulativeRefundedMicros: 10000,
        fenceGeneration: legacyGeneration,
      });
      before = await snapshot(f.sql);
      await expect(f.refund(grant, "re_collision", 1, 1, current)).rejects.toMatchObject({
        code: "refund_conflict",
      });
      expect(await snapshot(f.sql)).toEqual(before);
    } finally {
      f.db.close();
    }
  });

  test("pre-extension legacy grants/refunds and ambiguous Charge history remain usable", async () => {
    const f = await fixture({ extended: false });
    try {
      const first = checkout();
      const second = { ...first, fundingRef: "stripe:cs_second", sourceId: "cs_second" };
      await f.store.grant(first);
      await f.store.grant(second);
      expect(await f.store.grantsForCharge(first.chargeId)).toEqual([first, second]);
      await expect(f.store.grantForCharge(first.chargeId)).rejects.toMatchObject({
        code: "ambiguous_charge",
      });
      const generation = await f.store.freezeFunding(first.organizationId, first.fundingRef);
      expect(
        await f.store.refund({
          grant: first,
          refundId: "re_legacy",
          amountMicros: 10000,
          cumulativeRefundedMicros: 10000,
          fenceGeneration: generation,
        }),
      ).toMatchObject({ debitMicros: 10000 });
      await expect(f.fund()).rejects.toMatchObject({ code: "on_demand_schema_unavailable" });
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM stripe_billing_refunds")).toEqual([
        { n: 1 },
      ]);
    } finally {
      f.db.close();
    }
  });
  test("higher refund observation from an existing grant survives another store's early unfreeze", async () => {
    const f = await fixture();
    try {
      const grant = await f.fund();
      const generation = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      expect(
        await f.fund({
          ...f.native(5),
          client_secret: "never-persist-observation",
          card: { secret: "never-persist-observation" },
        } as StripeOnDemandFundingProof),
      ).toEqual(grant);
      const observation = (
        await f.sql.query(
          "SELECT detail_json FROM stripe_billing_on_demand_attempts WHERE kind='readback'",
        )
      )[0];
      expect(JSON.parse(String(observation?.detail_json))).toEqual({
        kind: "native-refund-observation-v1",
        proof: f.native(5),
      });
      const originalRows = await snapshot(f.sql);
      expect(await f.fund(f.native(5, "2026-10-15T12:00:03.000Z"))).toEqual(grant);
      expect(await f.fund(f.native(3))).toEqual(grant);
      expect(
        await f.sql.query(
          "SELECT COUNT(*) AS n FROM stripe_billing_on_demand_attempts WHERE kind='readback'",
        ),
      ).toEqual([{ n: 1 }]);
      expect(await snapshot(f.sql)).toEqual(originalRows);
      const other = createStripeBillingStore({ sql: f.sql, clock: () => new Date(fundedAt) });
      await expect(
        other.unfreezeFunding({
          organizationId: grant.organizationId,
          fundingRef: grant.fundingRef,
          fenceGeneration: generation,
          cumulativeRefundedMicros: 0,
        }),
      ).rejects.toMatchObject({ code: "refund_out_of_order" });
      expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("higher refund observation from an immutable refund replay survives another store's early unfreeze", async () => {
    const f = await fixture();
    try {
      const grant = await f.fund();
      const generation = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      const input = {
        grant,
        refundId: "re_higher",
        amountMicros: 50000,
        cumulativeRefundedMicros: 50000,
        fenceGeneration: generation,
        releaseFreeze: false,
        native: f.native(5),
      };
      const original = await f.store.refund(input);
      const originalReceipt = await f.sql.query("SELECT * FROM stripe_billing_on_demand_refunds");
      expect(await f.store.refund({ ...input, native: f.native(8) })).toEqual(original);
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_refunds")).toEqual(
        originalReceipt,
      );
      expect(
        await f.sql.query(
          "SELECT json_extract(detail_json,'$.proof.refundedAmountMinor') AS amount FROM stripe_billing_on_demand_attempts WHERE kind='readback' ORDER BY sequence",
        ),
      ).toEqual([{ amount: 5 }, { amount: 8 }]);
      const other = createStripeBillingStore({ sql: f.sql, clock: () => new Date(fundedAt) });
      await expect(
        other.unfreezeFunding({
          organizationId: grant.organizationId,
          fundingRef: grant.fundingRef,
          fenceGeneration: generation,
          cumulativeRefundedMicros: 50000,
        }),
      ).rejects.toMatchObject({ code: "refund_out_of_order" });
      expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
      await f.refund(grant, "re_higherRest", 3, 8, generation, false);
      await other.unfreezeFunding({
        organizationId: grant.organizationId,
        fundingRef: grant.fundingRef,
        fenceGeneration: generation,
        cumulativeRefundedMicros: 80000,
      });
      expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(20000);
    } finally {
      f.db.close();
    }
  });

  test("a higher-refund grant losing the first funding race still persists its own observation", async () => {
    let readers = 0;
    let releaseReaders = () => {};
    const readersReady = new Promise<void>((resolve) => {
      releaseReaders = resolve;
    });
    let releaseFirst = () => {};
    const firstCommitted = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const f = await fixture({
      wrap: (sql) => ({
        ...sql,
        async query(text, params) {
          const rows = await sql.query(text, params);
          if (text.includes("WHERE f.payment_intent_id = ?") && rows.length === 0 && readers < 2) {
            readers++;
            if (readers === 2) releaseReaders();
            await readersReady;
          }
          return rows;
        },
        async batch(statements) {
          const terminal = statements.find((st) =>
            st.sql.includes("INSERT INTO stripe_billing_on_demand_terminals"),
          );
          const amount = terminal
            ? JSON.parse(String(terminal.params?.[10])).refundedAmountMinor
            : null;
          if (amount === 5) await firstCommitted;
          const result = await sql.batch(statements);
          if (amount === 0) releaseFirst();
          return result;
        },
      }),
    });
    try {
      const [first, loser] = await Promise.all([f.fund(), f.fund(f.native(5))]);
      expect(loser).toEqual(first);
      expect(
        await f.sql.query(
          "SELECT json_extract(native_receipt_json,'$.refundedAmountMinor') AS amount FROM stripe_billing_on_demand_terminals",
        ),
      ).toEqual([{ amount: 0 }]);
      expect(
        await f.sql.query(
          "SELECT json_extract(detail_json,'$.proof.refundedAmountMinor') AS amount FROM stripe_billing_on_demand_attempts WHERE kind='readback'",
        ),
      ).toEqual([{ amount: 5 }]);
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type='funding'")).toEqual([
        { n: 1 },
      ]);
      const fence = (await f.sql.query("SELECT generation,active FROM stripe_billing_fences"))[0];
      expect(fence?.active).toBe(1);
      await expect(
        f.store.unfreezeFunding({
          organizationId: first.organizationId,
          fundingRef: first.fundingRef,
          fenceGeneration: Number(fence?.generation),
          cumulativeRefundedMicros: 0,
        }),
      ).rejects.toMatchObject({ code: "refund_out_of_order" });
    } finally {
      f.db.close();
    }
  });

  test("an early partial-release refusal first persists the higher native obligation and fence", async () => {
    const f = await fixture();
    try {
      const grant = await f.fund();
      const before = await snapshot(f.sql);
      await expect(
        f.store.refund({
          grant,
          refundId: "re_earlyRelease",
          amountMicros: 50000,
          cumulativeRefundedMicros: 50000,
          fenceGeneration: 1,
          native: f.native(8),
        }),
      ).rejects.toMatchObject({ code: "refund_drain_incomplete" });
      expect(await snapshot(f.sql)).toEqual(before);
      expect(
        await f.sql.query(
          "SELECT json_extract(detail_json,'$.proof.refundedAmountMinor') AS amount FROM stripe_billing_on_demand_attempts WHERE kind='readback'",
        ),
      ).toEqual([{ amount: 8 }]);
      expect(await f.sql.query("SELECT generation,active FROM stripe_billing_fences")).toEqual([
        { generation: 1, active: 1 },
      ]);
      const other = createStripeBillingStore({ sql: f.sql, clock: () => new Date(fundedAt) });
      await expect(
        other.unfreezeFunding({
          organizationId: grant.organizationId,
          fundingRef: grant.fundingRef,
          fenceGeneration: 1,
          cumulativeRefundedMicros: 0,
        }),
      ).rejects.toMatchObject({ code: "refund_out_of_order" });
      expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("observation and fence activation roll back together; lost observation ACK reads the durable pair", async () => {
    let lose = false;
    const f = await fixture({
      wrap: (sql) => ({
        ...sql,
        async batch(statements) {
          const results = await sql.batch(statements);
          if (
            lose &&
            statements.some((st) =>
              st.sql.includes("INSERT INTO stripe_billing_on_demand_attempts"),
            )
          ) {
            lose = false;
            throw new SqlError("unavailable", "lost observation acknowledgement");
          }
          return results;
        },
      }),
    });
    try {
      const grant = await f.fund();
      f.db.exec(
        "CREATE TRIGGER test_observation_failure BEFORE INSERT ON stripe_billing_on_demand_attempts WHEN NEW.kind='readback' BEGIN SELECT RAISE(ABORT,'constraint: injected observation failure'); END",
      );
      await expect(f.fund(f.native(5))).rejects.toMatchObject({ code: "constraint" });
      expect(await f.sql.query("SELECT * FROM stripe_billing_fences")).toEqual([]);
      expect(
        await f.sql.query("SELECT * FROM stripe_billing_on_demand_attempts WHERE kind='readback'"),
      ).toEqual([]);
      f.db.exec("DROP TRIGGER test_observation_failure");
      lose = true;
      expect(await f.fund(f.native(5))).toEqual(grant);
      expect(await f.sql.query("SELECT active FROM stripe_billing_fences")).toEqual([
        { active: 1 },
      ]);
      expect(
        await f.sql.query(
          "SELECT COUNT(*) AS n FROM stripe_billing_on_demand_attempts WHERE kind='readback'",
        ),
      ).toEqual([{ n: 1 }]);
    } finally {
      f.db.close();
    }
  });

  test("an observation committed after unfreeze's advisory reads defeats its atomic stale floor", async () => {
    let armed = false;
    let observe: () => Promise<unknown> = async () => undefined;
    const f = await fixture({
      wrap: (sql) => ({
        ...sql,
        async batch(statements) {
          if (
            armed &&
            statements.some((st) => st.sql.includes("UPDATE stripe_billing_fences SET active = 0"))
          ) {
            armed = false;
            await observe();
          }
          return sql.batch(statements);
        },
      }),
    });
    try {
      const grant = await f.fund();
      const generation = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      observe = () => f.fund(f.native(5));
      armed = true;
      await expect(
        f.store.unfreezeFunding({
          organizationId: grant.organizationId,
          fundingRef: grant.fundingRef,
          fenceGeneration: generation,
          cumulativeRefundedMicros: 0,
        }),
      ).rejects.toBeInstanceOf(SqlError);
      expect(await f.sql.query("SELECT generation,active FROM stripe_billing_fences")).toEqual([
        { generation, active: 1 },
      ]);
      expect(
        await f.sql.query(
          "SELECT COUNT(*) AS n FROM stripe_billing_on_demand_attempts WHERE kind='readback'",
        ),
      ).toEqual([{ n: 1 }]);
      expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
    } finally {
      f.db.close();
    }
  });

  test("reactivating an inactive fence for a new observation invalidates only the old inactive generation", async () => {
    const f = await fixture();
    try {
      const grant = await f.fund();
      const old = await f.store.freezeFunding(grant.organizationId, grant.fundingRef);
      await f.store.unfreezeFunding({
        organizationId: grant.organizationId,
        fundingRef: grant.fundingRef,
        fenceGeneration: old,
        cumulativeRefundedMicros: 0,
      });
      await f.fund(f.native(5));
      expect(await f.sql.query("SELECT generation,active FROM stripe_billing_fences")).toEqual([
        { generation: old + 1, active: 1 },
      ]);
      await expect(
        f.store.unfreezeFunding({
          organizationId: grant.organizationId,
          fundingRef: grant.fundingRef,
          fenceGeneration: old,
          cumulativeRefundedMicros: 0,
        }),
      ).rejects.toMatchObject({ code: "freeze_changed" });
    } finally {
      f.db.close();
    }
  });
  test("generic tagged observation with missing original time is refused before a funding or MAX decision", async () => {
    const f = await fixture();
    try {
      const { observedAt: _omitted, ...malformed } = f.native(5);
      await f.sql.run(
        "INSERT INTO stripe_billing_on_demand_attempts(org_id,reference,sequence,kind,detail_json,created_at) VALUES(?,?,2,'readback',?,?)",
        [
          f.expected.organizationId,
          f.expected.reference,
          JSON.stringify({ kind: "native-refund-observation-v1", proof: malformed }),
          fundedAt,
        ],
      );
      const before = await snapshot(f.sql);
      await expect(f.fund()).rejects.toMatchObject({ code: "invalid_refund_observation" });
      expect(await snapshot(f.sql)).toEqual(before);
      expect(await f.sql.query("SELECT * FROM wallet_credit_lots")).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("generic valid positive observation before funding is fenced in the first money batch", async () => {
    const f = await fixture();
    try {
      const proof = f.native(5);
      await f.sql.run(
        "INSERT INTO stripe_billing_on_demand_attempts(org_id,reference,sequence,kind,detail_json,created_at) VALUES(?,?,2,'readback',?,?)",
        [
          f.expected.organizationId,
          f.expected.reference,
          JSON.stringify({ kind: "native-refund-observation-v1", proof }),
          fundedAt,
        ],
      );
      const grant = await f.fund();
      expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
      expect(await f.sql.query("SELECT active FROM stripe_billing_fences")).toEqual([
        { active: 1 },
      ]);
      expect(await f.fund(proof)).toEqual(grant);
      expect(
        await f.sql.query(
          "SELECT COUNT(*) AS n FROM stripe_billing_on_demand_attempts WHERE kind='readback'",
        ),
      ).toEqual([{ n: 1 }]);
      const generation = Number(
        (await f.sql.query("SELECT generation FROM stripe_billing_fences"))[0]?.generation,
      );
      await f.refund(grant, "re_genericOriginal", 5, 5, generation, false);
      await f.store.unfreezeFunding({
        organizationId: grant.organizationId,
        fundingRef: grant.fundingRef,
        fenceGeneration: generation,
        cumulativeRefundedMicros: 50000,
      });
      expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(50000);
      expect(
        await f.sql.query(
          "SELECT json_extract(native_receipt_json,'$.refundedAmountMinor') AS amount FROM stripe_billing_on_demand_terminals",
        ),
      ).toEqual([{ amount: 0 }]);
    } finally {
      f.db.close();
    }
  });
  test("generic tagged observations enforce closed keys, primitive types and canonical original time bounds", async () => {
    for (const variant of [
      "extra-wrapper",
      "extra-proof",
      "noncanonical-time",
      "before-dispatch",
      "after-readback",
      "cash-type",
      "foreign-customer",
    ]) {
      const f = await fixture();
      try {
        const proof: Record<string, unknown> = { ...f.native(5) };
        const detail: Record<string, unknown> = { kind: "native-refund-observation-v1", proof };
        if (variant === "extra-wrapper") detail.extra = true;
        if (variant === "extra-proof") proof.extra = true;
        if (variant === "noncanonical-time") proof.observedAt = "2026-10-15T12:00:02Z";
        if (variant === "before-dispatch") proof.observedAt = "2026-10-15T12:00:00.999Z";
        if (variant === "after-readback") proof.observedAt = "2026-10-15T12:00:04.000Z";
        if (variant === "cash-type") proof.refundedAmountMinor = "5";
        if (variant === "foreign-customer") proof.customerId = "cus_other";
        await f.sql.run(
          "INSERT INTO stripe_billing_on_demand_attempts(org_id,reference,sequence,kind,detail_json,created_at) VALUES(?,?,2,'readback',?,?)",
          [f.expected.organizationId, f.expected.reference, JSON.stringify(detail), fundedAt],
        );
        await expect(f.fund()).rejects.toMatchObject({ code: "invalid_refund_observation" });
        expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
        expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_funding")).toEqual([]);
      } finally {
        f.db.close();
      }
    }
  });

  test("an unpinned generic observation cannot substitute another PI or Charge for the incoming original", async () => {
    const f = await fixture();
    try {
      await f.sql.run(
        "INSERT INTO stripe_billing_on_demand_attempts(org_id,reference,sequence,kind,detail_json,created_at) VALUES(?,?,2,'readback',?,?)",
        [
          f.expected.organizationId,
          f.expected.reference,
          JSON.stringify({
            kind: "native-refund-observation-v1",
            proof: { ...f.native(5), paymentIntentId: "pi_other", chargeId: "ch_other" },
          }),
          fundedAt,
        ],
      );
      await expect(f.fund()).rejects.toMatchObject({ code: "grant_conflict" });
      expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("a generic observation racing the initial advisory read is qualified and fenced inside the money batch", async () => {
    for (const malformed of [false, true]) {
      let armed = false;
      let inject: () => Promise<unknown> = async () => undefined;
      const f = await fixture({
        wrap: (sql) => ({
          ...sql,
          async batch(statements) {
            if (
              armed &&
              statements.some((st) =>
                st.sql.includes("INSERT INTO stripe_billing_on_demand_terminals"),
              )
            ) {
              armed = false;
              await inject();
            }
            return sql.batch(statements);
          },
        }),
      });
      try {
        const proof: Record<string, unknown> = { ...f.native(5) };
        if (malformed) delete proof.observedAt;
        inject = () =>
          f.originalSql.run(
            "INSERT INTO stripe_billing_on_demand_attempts(org_id,reference,sequence,kind,detail_json,created_at) VALUES(?,?,2,'readback',?,?)",
            [
              f.expected.organizationId,
              f.expected.reference,
              JSON.stringify({ kind: "native-refund-observation-v1", proof }),
              fundedAt,
            ],
          );
        armed = true;
        if (malformed) {
          await expect(f.fund()).rejects.toBeInstanceOf(SqlError);
          expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
          expect(await f.sql.query("SELECT * FROM wallet_credit_lots")).toEqual([]);
        } else {
          const grant = await f.fund();
          expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
          expect(await f.sql.query("SELECT active FROM stripe_billing_fences")).toEqual([
            { active: 1 },
          ]);
        }
      } finally {
        f.db.close();
      }
    }
  });

  test("same or lower replay repairs a historical inactive fence while its stored obligation is undrained", async () => {
    const f = await fixture();
    try {
      const grant = await f.fund();
      await f.fund(f.native(5));
      const old = Number(
        (await f.sql.query("SELECT generation FROM stripe_billing_fences"))[0]?.generation,
      );
      // A pre-fix unsafe inactive fence is a historical-state fixture, not a new
      // refund/funding receipt or an authorized production correction.
      await f.originalSql.run(
        "UPDATE stripe_billing_fences SET active=0 WHERE org_id=? AND funding_ref=?",
        [grant.organizationId, grant.fundingRef],
      );
      const before = await snapshot(f.sql);
      expect(await f.fund(f.native(3))).toEqual(grant);
      expect(await snapshot(f.sql)).toEqual(before);
      expect(await f.sql.query("SELECT generation,active FROM stripe_billing_fences")).toEqual([
        { generation: old + 1, active: 1 },
      ]);
      expect(
        await f.sql.query(
          "SELECT COUNT(*) AS n FROM stripe_billing_on_demand_attempts WHERE kind='readback'",
        ),
      ).toEqual([{ n: 1 }]);
      expect((await f.ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
    } finally {
      f.db.close();
    }
  });
});
