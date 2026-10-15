import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createLedger, stripeRefundSource } from "../src/ledger.ts";
import { createOrgBilling, OrgBillingError } from "../src/org-billing.ts";
import { createOrgLimitPolicy } from "../src/org-limit-policy.ts";
import { orgUsageSummaryReadStatement } from "../src/org-usage-summary.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { type BillingGrant, createStripeBillingStore } from "../src/stripe-billing-store.ts";
import {
  type StripeOnDemandFundingExpected,
  type StripeOnDemandFundingProof,
  verifyStripeOnDemandFunding,
} from "../src/stripe-on-demand-verification.ts";

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
    readonly freeIncludedMinor?: number;
    readonly wrap?: (sql: Sql) => Sql;
  } = {},
) {
  const db = new Database(":memory:");
  if (!MIGRATIONS.some((migration) => migration.name === "0100_hosted_on_demand.sql"))
    throw new Error("canonical 0100 is required for refund projection tests");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  const originalSql = createSqliteSql(db);
  const sql = options.wrap?.(originalSql) ?? originalSql;
  let instant = fundedAt;
  let clockCalls = 0;
  const clock = () => {
    clockCalls++;
    return new Date(instant);
  };
  const store = createStripeBillingStore({ sql, clock });
  const ledger = createLedger(sql, clock, { hostedPaidFreeExclusion: true });
  const config = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "projection-r1",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86_400,
      freeIncludedMinor: options.freeIncludedMinor ?? 0,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: { requests: { unit: "request", rate: { numeratorMicros: "1", denominator: "1" } } },
    }),
  );
  if (!config) throw new Error("projection tariff missing");
  const policy = createOrgLimitPolicy({ sql, clock });
  const billingFor = (billingSql: Sql = sql) =>
    createOrgBilling({
      sql: billingSql,
      clock,
      ledger: createLedger(billingSql, clock, { hostedPaidFreeExclusion: true }),
      config,
      hostedPaidFreeExclusion: true,
      requireWorkspaceAttribution: true,
      limitPolicy: policy,
    });
  const billing = billingFor();
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
    clock,
    config,
    policy,
    billing,
    billingFor,
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

const ORG = "org_store";
function hold(reference: string, amountMicros: number, workspaceRef = "ws_projection") {
  return {
    organizationId: ORG,
    reference,
    amountMicros,
    workspaceRef,
    pricingRevision: "projection-r1",
    measurementFingerprint: "original-estimate",
  };
}
function capture(reference: string, amountMicros: number) {
  return {
    organizationId: ORG,
    reference,
    amountMicros,
    actualMicros: String(amountMicros),
    measurementFingerprint: "actual",
  };
}
function usage(reference: string, amountMicros: number, workspaceRef = "ws_projection") {
  return {
    organizationId: ORG,
    reference,
    workspaceRef,
    meter: "requests",
    quantity: String(amountMicros),
    quantityUnit: "request",
    expectedMicros: amountMicros,
    pricingRevision: "projection-r1",
    periodStart: "2026-10-15T11:00:00.000Z",
    periodEnd: "2026-10-15T12:00:00.000Z",
    measurementFingerprint: "closed",
  };
}
async function prepaid(f: Awaited<ReturnType<typeof fixture>>) {
  // Existing ordinary prepaid consent after the original cap is paid. This
  // fixture never exercises fresh off-session admission or provider transport.
  await f.policy.change({
    organizationId: ORG,
    reference: "ordinary_prepaid",
    onLimit: "prepaid",
    authorizedPrincipal: "session:store-owner",
  });
}
async function errorCode(operation: Promise<unknown>, code: string, status = 409) {
  try {
    await operation;
    throw new Error("expected refusal");
  } catch (error) {
    expect(error).toBeInstanceOf(OrgBillingError);
    expect(error).toMatchObject({ code, status });
  }
}
async function receiptCounts(sql: Sql) {
  return (
    await sql.query(`SELECT
    (SELECT COUNT(*) FROM stripe_billing_on_demand_funding) AS native_funding,
    (SELECT COUNT(*) FROM stripe_billing_on_demand_refunds) AS native_refunds,
    (SELECT COUNT(*) FROM stripe_billing_grants WHERE funding_ref = 'stripe:on-demand:store') AS legacy_funding,
    (SELECT COUNT(*) FROM stripe_billing_refunds WHERE funding_ref = 'stripe:on-demand:store') AS legacy_refunds,
    (SELECT COUNT(*) FROM ledger WHERE type = 'funding' AND ref = 'stripe:on-demand:store') AS funding_entries,
    (SELECT COUNT(*) FROM wallet_credit_lots WHERE ref = 'stripe:on-demand:store') AS lots`)
  )[0];
}
async function refundAll(f: Awaited<ReturnType<typeof fixture>>, grant: BillingGrant) {
  const generation = await f.store.freezeFunding(ORG, grant.fundingRef);
  return f.refund(grant, "re_projection_full", 10, 10, generation);
}

test("original PI unused refunds project once into wallet/lots and a frozen same-snapshot Workspace summary", async () => {
  let maxParams = 0;
  const f = await fixture({
    seconds: null,
    wrap(sql) {
      const count = (params: readonly unknown[] | undefined) => {
        maxParams = Math.max(maxParams, params?.length ?? 0);
      };
      return {
        query(query, params) {
          count(params);
          return sql.query(query, params);
        },
        run(query, params) {
          count(params);
          return sql.run(query, params);
        },
        batch(statements) {
          for (const statement of statements) count(statement.params);
          return sql.batch(statements);
        },
      };
    },
  });
  try {
    const grant = await f.fund();
    await prepaid(f);
    expect(await stripeRefundSource(f.sql)).toBe("stripe_billing_refund_receipts_all");
    expect((await f.policy.read(ORG)).capabilities["on-demand"]).toBe(false);
    await f.billing.hold(hold("snapshot_a", 0, "ws_a"));
    await f.billing.hold(hold("snapshot_b", 0, "ws_b"));
    const initial = await f.billing.workspaceUsage(ORG, { limit: 1 });
    expect(initial.usageSummary.purchasedAvailableMicros).toBe(100000);
    expect(initial.cursor).not.toBeNull();
    const generation = await f.store.freezeFunding(ORG, grant.fundingRef);
    expect(await f.billing.wallet(ORG)).toMatchObject({ availableMicros: 0, frozenMicros: 100000 });
    expect((await f.billing.usageSummary(ORG)).purchasedAvailableMicros).toBe(0);
    const first = await f.refund(grant, "re_projection_partial", 3, 3, generation);
    expect(first).toMatchObject({ debitMicros: 30000, receivableMicros: 0, expiredMicros: 0 });
    expect(await f.billing.wallet(ORG)).toMatchObject({
      settledMicros: 70000,
      heldMicros: 0,
      availableMicros: 70000,
      frozenMicros: 0,
    });
    expect(
      (await f.billing.lots(ORG)).lots.find((lot) => lot.reference === grant.fundingRef),
    ).toMatchObject({
      spentMicros: 0,
      revokedMicros: 30000,
      remainingMicros: 70000,
      availableMicros: 70000,
    });
    expect((await f.billing.usageSummary(ORG)).purchasedAvailableMicros).toBe(70000);
    const continuation = await f.billing.workspaceUsage(ORG, { cursor: initial.cursor ?? "" });
    expect(continuation.usageSummary).toEqual(initial.usageSummary);
    expect(continuation.totals).toEqual(initial.totals);
    expect((await f.billing.workspaceUsage(ORG)).usageSummary.purchasedAvailableMicros).toBe(70000);
    const nextGeneration = await f.store.freezeFunding(ORG, grant.fundingRef);
    await f.refund(grant, "re_projection_remaining", 7, 10, nextGeneration);
    expect((await f.billing.wallet(ORG)).availableMicros).toBe(0);
    expect((await f.billing.usageSummary(ORG)).purchasedAvailableMicros).toBe(0);
    expect(await receiptCounts(f.sql)).toEqual({
      native_funding: 1,
      native_refunds: 2,
      legacy_funding: 0,
      legacy_refunds: 0,
      funding_entries: 1,
      lots: 1,
    });
    const refundEvents = (await f.billing.wallet(ORG)).entries.filter(
      (entry) =>
        entry.type === "refund_debit" ||
        entry.type === "refund_receivable" ||
        entry.type === "revoked_after_expiry",
    );
    expect(
      refundEvents
        .map(({ type, reference, settledDeltaMicros, heldDeltaMicros }) => ({
          type,
          reference,
          settledDeltaMicros,
          heldDeltaMicros,
        }))
        .sort((a, b) => a.reference.localeCompare(b.reference)),
    ).toEqual([
      {
        type: "refund_debit",
        reference: "re_projection_partial",
        settledDeltaMicros: -30000,
        heldDeltaMicros: 0,
      },
      {
        type: "refund_debit",
        reference: "re_projection_remaining",
        settledDeltaMicros: -70000,
        heldDeltaMicros: 0,
      },
    ]);
    expect(
      await f.sql.query(
        "SELECT * FROM ledger WHERE org_id = ? AND type IN ('refund_debit','refund_receivable','revoked_after_expiry')",
        [ORG],
      ),
    ).toEqual([]);
    expect(await f.fund(f.native(10, fundedAt))).toEqual(grant);
    expect(maxParams).toBeLessThanOrEqual(100);
  } finally {
    f.db.close();
  }
});

test("held/used PI refund keeps measured usage once, releases the original hold and blocks admission on its own debt", async () => {
  const f = await fixture({ seconds: null });
  try {
    const grant = await f.fund();
    await prepaid(f);
    await f.billing.hold(hold("spent", 60000, "ws_spent"));
    const captured = await f.billing.capture(capture("spent", 40000));
    await f.billing.hold(hold("reserved", 50000, "ws_reserved"));
    const pending = usage("unpaid", 200000, "ws_unpaid");
    expect((await f.billing.usage(pending)).status).toBe("pending");
    const before = await f.billing.workspaceUsage(ORG, { limit: 1 });
    expect(before.totals).toEqual({ usedMicros: 40000, heldMicros: 50000, pendingMicros: 200000 });
    const refunded = await refundAll(f, grant);
    expect(refunded).toMatchObject({
      debitMicros: 60000,
      receivableMicros: 40000,
      expiredMicros: 0,
      targetRevokedMicros: 100000,
    });
    expect(await f.billing.wallet(ORG)).toMatchObject({
      settledMicros: 0,
      heldMicros: 0,
      availableMicros: 0,
      refundReceivableMicros: 40000,
    });
    expect(
      (await f.billing.lots(ORG)).lots.find((lot) => lot.reference === grant.fundingRef),
    ).toMatchObject({
      spentMicros: 40000,
      revokedMicros: 60000,
      heldMicros: 0,
      availableMicros: 0,
    });
    expect(await f.billing.readHold(ORG, "reserved")).toMatchObject({
      status: "released",
      closureReason: "refund",
      workspaceRef: "ws_reserved",
    });
    expect(await f.billing.capture(capture("spent", 40000))).toEqual(captured);
    const after = await f.billing.workspaceUsage(ORG);
    expect(after.totals).toEqual({ usedMicros: 40000, heldMicros: 0, pendingMicros: 200000 });
    expect(after.usageSummary.purchasedAvailableMicros).toBe(0);
    expect((await f.billing.workspaceUsage(ORG, { cursor: before.cursor ?? "" })).totals).toEqual(
      before.totals,
    );
    // Existing pending work keeps its original hold-admission error priority.
    await errorCode(f.billing.hold(hold("debt_zero_hold", 0)), "outstanding_usage");
    await errorCode(f.billing.usage(usage("debt_zero_usage", 0)), "refund_receivable");
    await errorCode(f.billing.usage(pending), "refund_receivable");
    expect(
      (
        await f.sql.query(
          "SELECT state FROM org_wallet_usage_records WHERE org_id = ? AND ref = ?",
          [ORG, pending.reference],
        )
      )[0]?.state,
    ).toBe("pending");
    expect(
      (await f.billing.wallet(ORG)).entries
        .filter(
          (entry) =>
            entry.type === "refund_debit" ||
            entry.type === "refund_receivable" ||
            entry.type === "revoked_after_expiry",
        )
        .map(({ type, reference, settledDeltaMicros, heldDeltaMicros }) => ({
          type,
          reference,
          settledDeltaMicros,
          heldDeltaMicros,
        }))
        .sort((a, b) => a.type.localeCompare(b.type)),
    ).toEqual([
      {
        type: "refund_debit",
        reference: "re_projection_full",
        settledDeltaMicros: -60000,
        heldDeltaMicros: 0,
      },
      {
        type: "refund_receivable",
        reference: "re_projection_full",
        settledDeltaMicros: 0,
        heldDeltaMicros: 0,
      },
    ]);
    expect(
      await f.sql.query(
        "SELECT * FROM ledger WHERE org_id = ? AND type IN ('refund_debit','refund_receivable','revoked_after_expiry')",
        [ORG],
      ),
    ).toEqual([]);
    expect(await receiptCounts(f.sql)).toMatchObject({
      native_funding: 1,
      native_refunds: 1,
      legacy_refunds: 0,
      funding_entries: 1,
      lots: 1,
    });
  } finally {
    f.db.close();
  }
});

test("expired PI credit is revoked after expiry and never becomes fresh spendable credit on release", async () => {
  const f = await fixture({ seconds: 60 });
  try {
    const grant = await f.fund();
    await prepaid(f);
    await f.billing.hold(hold("expired_hold", 10000));
    if (!grant.expiresAt) throw new Error("finite source expiry required");
    f.setNow(grant.expiresAt);
    expect(await f.billing.wallet(ORG)).toMatchObject({ heldMicros: 10000, availableMicros: 0 });
    const refunded = await refundAll(f, grant);
    expect(refunded).toMatchObject({ debitMicros: 0, receivableMicros: 0, expiredMicros: 100000 });
    expect(await f.billing.wallet(ORG)).toMatchObject({
      settledMicros: 0,
      heldMicros: 0,
      availableMicros: 0,
      refundReceivableMicros: 0,
    });
    expect(
      (await f.billing.lots(ORG)).lots.find((lot) => lot.reference === grant.fundingRef),
    ).toMatchObject({
      revokedMicros: 100000,
      heldMicros: 0,
      availableMicros: 0,
      expiresAt: grant.expiresAt,
    });
    expect((await f.billing.usageSummary(ORG)).purchasedAvailableMicros).toBe(0);
    expect(await f.billing.release(ORG, "expired_hold")).toMatchObject({
      status: "released",
      closureReason: "refund",
    });
    expect((await f.billing.workspaceUsage(ORG)).totals).toEqual({
      usedMicros: 0,
      heldMicros: 0,
      pendingMicros: 0,
    });
    expect(
      (
        await f.sql.query(
          "SELECT COUNT(*) AS count FROM ledger WHERE org_id = ? AND type = 'refund_debit'",
          [ORG],
        )
      )[0]?.count,
    ).toBe(0);
    expect(
      (await f.billing.wallet(ORG)).entries
        .filter(
          (entry) =>
            entry.type === "refund_debit" ||
            entry.type === "refund_receivable" ||
            entry.type === "revoked_after_expiry",
        )
        .map(({ type, reference, settledDeltaMicros, heldDeltaMicros }) => ({
          type,
          reference,
          settledDeltaMicros,
          heldDeltaMicros,
        })),
    ).toEqual([
      {
        type: "revoked_after_expiry",
        reference: "re_projection_full",
        settledDeltaMicros: 0,
        heldDeltaMicros: 0,
      },
    ]);
    expect(
      await f.sql.query(
        "SELECT * FROM ledger WHERE org_id = ? AND type IN ('refund_debit','refund_receivable','revoked_after_expiry')",
        [ORG],
      ),
    ).toEqual([]);
  } finally {
    f.db.close();
  }
});

for (const admission of ["hold", "new-usage", "pending-usage"] as const) {
  test(`PI debt arriving after ${admission} precheck atomically rejects the source mutation`, async () => {
    const f = await fixture({ seconds: null });
    try {
      const grant = await f.fund();
      await prepaid(f);
      await f.billing.usage(usage("already_consumed", 60000));
      const command = usage("racing_usage", 0, "ws_race");
      if (admission === "pending-usage") {
        const stopBeforePayment: Sql = {
          query: (s, p) => f.sql.query(s, p),
          run: (s, p) => f.sql.run(s, p),
          batch(statements) {
            if (
              statements.some((statement) =>
                statement.sql.includes("UPDATE org_wallet_usage_records SET state = 'paid'"),
              )
            )
              throw new SqlError("unavailable", "fixture payment batch never began");
            return f.sql.batch(statements);
          },
        };
        await errorCode(f.billingFor(stopBeforePayment).usage(command), "billing_unavailable", 503);
      }
      let injected = false;
      const interleaved: Sql = {
        query: (s, p) => f.sql.query(s, p),
        run: (s, p) => f.sql.run(s, p),
        async batch(statements) {
          const match =
            admission === "hold"
              ? "INSERT INTO org_wallet_holds"
              : admission === "new-usage"
                ? "INSERT INTO org_wallet_usage_records"
                : "UPDATE org_wallet_usage_records SET state = 'paid'";
          if (!injected && statements.some((statement) => statement.sql.includes(match))) {
            injected = true;
            await refundAll(f, grant);
          }
          return f.sql.batch(statements);
        },
      };
      const billing = f.billingFor(interleaved);
      await errorCode(
        admission === "hold"
          ? billing.hold(hold("racing_hold", 0, "ws_race"))
          : billing.usage(command),
        "refund_receivable",
      );
      expect(injected).toBe(true);
      expect(await f.billing.wallet(ORG)).toMatchObject({
        availableMicros: 0,
        refundReceivableMicros: 60000,
      });
      expect(
        await f.sql.query(
          "SELECT ref FROM org_wallet_holds WHERE org_id = ? AND ref = 'racing_hold'",
          [ORG],
        ),
      ).toEqual([]);
      expect(
        await f.sql.query(
          "SELECT state FROM org_wallet_usage_records WHERE org_id = ? AND ref = ?",
          [ORG, command.reference],
        ),
      ).toEqual(admission === "pending-usage" ? [{ state: "pending" }] : []);
      expect(await f.sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
      expect(await receiptCounts(f.sql)).toMatchObject({
        native_refunds: 1,
        legacy_refunds: 0,
        funding_entries: 1,
      });
    } finally {
      f.db.close();
    }
  });
}

test("refund source is pinned into the atomic warning and Workspace summary without changing the included allowance", async () => {
  const f = await fixture({ seconds: null, freeIncludedMinor: 150 });
  try {
    const grant = await f.fund();
    await prepaid(f);
    const first = await f.billing.hold(hold("warning_original", 1200000));
    expect(first.status).toBe("live");
    const initialWarning = await f.sql.query(
      "SELECT payload_json FROM org_wallet_usage_warnings WHERE org_id = ?",
      [ORG],
    );
    expect(initialWarning).toHaveLength(1);
    expect(JSON.parse(String(initialWarning[0]?.payload_json))).toMatchObject({
      effectiveIncludedMicros: "1500000",
      heldMicros: "1200000",
      thresholdBasisPoints: 8000,
    });
    await refundAll(f, grant);
    await f.billing.release(ORG, "warning_original");
    const observed: SqlStatement[] = [];
    const original = f.policy.warningStatements.bind(f.policy);
    const observer = {
      ...f.policy,
      warningStatements(input: Parameters<typeof original>[0]) {
        observed.push(input.summaryRead);
        return original(input);
      },
    };
    const billing = createOrgBilling({
      sql: f.sql,
      clock: f.clock,
      ledger: f.ledger,
      config: f.config,
      hostedPaidFreeExclusion: true,
      requireWorkspaceAttribution: true,
      limitPolicy: observer,
    });
    await billing.hold(hold("warning_after_refund", 1425000));
    expect(observed).toHaveLength(1);
    expect(observed[0]?.sql).toContain("stripe_billing_refund_receipts_all");
    const summaryRead = observed[0];
    if (!summaryRead) throw new Error("atomic summary statement missing");
    const raw = (await f.sql.query(summaryRead.sql, summaryRead.params))[0];
    expect(raw?.purchased_available).toBe(0);
    const summary = await billing.usageSummary(ORG);
    expect(summary).toMatchObject({
      effectiveIncludedMicros: 1500000,
      purchasedAvailableMicros: 0,
      heldMicros: 1425000,
      utilizationBasisPoints: 9500,
    });
    const workspaces = await billing.workspaceUsage(ORG);
    expect(workspaces.usageSummary).toEqual(summary);
    expect(
      await f.sql.query(
        "SELECT threshold_basis_points FROM org_wallet_usage_warnings WHERE org_id = ? ORDER BY threshold_basis_points",
        [ORG],
      ),
    ).toEqual([{ threshold_basis_points: 8000 }, { threshold_basis_points: 9500 }]);
    const pure = orgUsageSummaryReadStatement({
      organizationId: ORG,
      instant: fundedAt,
      hostedPaidFreeExclusion: true,
      refundSource: await stripeRefundSource(f.sql),
    });
    expect((await f.sql.query(pure.sql, pure.params))[0]?.purchased_available).toBe(0);
  } finally {
    f.db.close();
  }
});

test("an impostor union view refuses projections and new writes without proving activation", async () => {
  const f = await fixture({ seconds: null, freeIncludedMinor: 150 });
  try {
    await f.fund();
    await prepaid(f);
    await f.billing.usageSummary(ORG);
    const before = await receiptCounts(f.sql);
    f.db.exec(
      "DROP VIEW stripe_billing_refund_receipts_all; CREATE VIEW stripe_billing_refund_receipts_all AS SELECT refund_id,org_id,funding_ref,amount_micros,cumulative_refunded_micros,target_revoked_micros,debit_micros,receivable_micros,expired_micros,created_at FROM stripe_billing_refunds",
    );
    await expect(stripeRefundSource(f.sql)).rejects.toMatchObject({
      code: "conservation_violated",
    });
    await errorCode(f.billing.usageSummary(ORG), "billing_unavailable", 503);
    await errorCode(f.billing.workspaceUsage(ORG), "billing_unavailable", 503);
    await errorCode(f.billing.lots(ORG), "billing_unavailable", 503);
    await errorCode(f.billing.hold(hold("unqualified", 0)), "billing_unavailable", 503);
    await errorCode(f.billing.usage(usage("unqualified", 0)), "billing_unavailable", 503);
    expect(await receiptCounts(f.sql)).toEqual(before);
    expect((await f.policy.read(ORG)).capabilities["on-demand"]).toBe(false);
  } finally {
    f.db.close();
  }
});

test("PI refunds never become invoice credit or change the original paid/Free entitlement", async () => {
  const f = await fixture({ seconds: null, freeIncludedMinor: 150 });
  try {
    const original = await f.fund();
    await prepaid(f);
    const invoice: BillingGrant = {
      organizationId: ORG,
      fundingRef: "stripe:invoice:in_projection",
      kind: "plan-included",
      amountMicros: 2000000,
      expiresAt: "2026-10-20T00:00:00.000Z",
      sourceType: "invoice",
      sourceId: "in_projection",
      chargeId: "ch_invoice_projection",
      customerId: f.expected.customerId,
      subscriptionId: "sub_projection",
      planKey: "starter",
      pricingRevision: "projection-r1",
      stripePriceId: "price_projection",
      periodStart: "2026-10-10T00:00:00.000Z",
      periodEnd: "2026-10-20T00:00:00.000Z",
      considerationMicros: 1000000,
    };
    await f.store.grant(invoice);
    const initial = await f.billing.usageSummary(ORG);
    expect(initial).toMatchObject({
      periodKind: "paid",
      originalIncludedMicros: 2000000,
      effectiveIncludedMicros: 2000000,
      purchasedAvailableMicros: 100000,
    });
    await refundAll(f, original);
    expect(await f.billing.usageSummary(ORG)).toMatchObject({
      periodKind: "paid",
      effectiveIncludedMicros: 2000000,
      revokedMicros: 0,
      purchasedAvailableMicros: 0,
    });
    expect(await f.billing.wallet(ORG)).toMatchObject({
      settledMicros: 2000000,
      availableMicros: 2000000,
    });
    const generation = await f.store.freezeFunding(ORG, invoice.fundingRef);
    await f.store.refund({
      grant: invoice,
      refundId: "re_invoice_projection",
      amountMicros: 1000000,
      cumulativeRefundedMicros: 1000000,
      fenceGeneration: generation,
    });
    expect(await f.billing.usageSummary(ORG)).toMatchObject({
      periodKind: "free",
      effectiveIncludedMicros: 1500000,
      purchasedAvailableMicros: 0,
    });
    expect(
      await f.sql.query(
        "SELECT source_type,source_id FROM stripe_billing_grants WHERE org_id = ?",
        [ORG],
      ),
    ).toEqual([{ source_type: "invoice", source_id: "in_projection" }]);
    expect(await receiptCounts(f.sql)).toMatchObject({
      native_funding: 1,
      native_refunds: 1,
      legacy_funding: 0,
      legacy_refunds: 0,
    });
  } finally {
    f.db.close();
  }
});

test("the pre-0100 standalone schema keeps the legacy original refund projection and receipt replay", async () => {
  const db = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS.filter((entry) => Number(entry.name.slice(0, 4)) < 100))
      db.exec(migration.sql);
    const sql = createSqliteSql(db);
    const clock = () => new Date(fundedAt);
    const store = createStripeBillingStore({ sql, clock });
    const ledger = createLedger(sql, clock);
    const config = parseBillingConfig(
      JSON.stringify({
        schemaVersion: 1,
        revision: "projection-r1",
        effectiveAt: "2026-09-01T00:00:00.000Z",
        currency: "USD",
        holdTtlSeconds: 60,
        freeIncludedMinor: 0,
        purchaseCreditExpiry: { kind: "none" },
        plans: {},
        meters: {},
      }),
    );
    if (!config) throw new Error("legacy tariff missing");
    const billing = createOrgBilling({ sql, clock, ledger, config });
    const grant: BillingGrant = {
      organizationId: ORG,
      fundingRef: "stripe:cs_legacy_projection",
      kind: "purchased",
      amountMicros: 50000,
      expiresAt: null,
      sourceType: "checkout",
      sourceId: "cs_legacy_projection",
      chargeId: "ch_legacy_projection",
      customerId: null,
      subscriptionId: null,
      planKey: null,
      pricingRevision: null,
      stripePriceId: null,
      periodStart: null,
      periodEnd: null,
      considerationMicros: 50000,
    };
    await store.grant(grant);
    const command = hold("legacy_unattributed", 10000);
    const { workspaceRef: _unused, ...unattributed } = command;
    const admitted = await billing.hold(unattributed);
    const generation = await store.freezeFunding(ORG, grant.fundingRef);
    const refund = await store.refund({
      grant,
      refundId: "re_legacy_projection",
      amountMicros: 20000,
      cumulativeRefundedMicros: 20000,
      fenceGeneration: generation,
    });
    expect(await stripeRefundSource(sql)).toBe("stripe_billing_refunds");
    expect(await billing.wallet(ORG)).toMatchObject({
      settledMicros: 30000,
      heldMicros: 0,
      availableMicros: 30000,
    });
    expect((await billing.lots(ORG)).lots[0]).toMatchObject({
      reference: grant.fundingRef,
      revokedMicros: 20000,
      availableMicros: 30000,
    });
    expect((await billing.usageSummary(ORG)).purchasedAvailableMicros).toBe(30000);
    expect(await billing.hold(unattributed)).toMatchObject({
      reference: admitted.reference,
      workspaceRef: null,
      status: "released",
      closureReason: "refund",
    });
    expect(
      await store.refund({
        grant,
        refundId: "re_legacy_projection",
        amountMicros: 20000,
        cumulativeRefundedMicros: 20000,
        fenceGeneration: generation,
      }),
    ).toEqual(refund);
    expect(
      await sql.query(
        "SELECT name FROM sqlite_schema WHERE name = 'stripe_billing_refund_receipts_all'",
      ),
    ).toEqual([]);
  } finally {
    db.close();
  }
});
