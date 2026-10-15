import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { canonicalJson } from "../src/json.ts";
import {
  assertOrgLimitPolicySchema,
  assertOrgPostpaidLaunchGate,
  createOrgCashExposureReservations,
  createOrgLimitPolicy,
  OrgLimitPolicyError,
  type OrgUsageWarning,
  type OrgUsageWarningTransport,
  PREPAID_CONSENT_REVISION,
} from "../src/org-limit-policy.ts";
import { type OrgUsageSummary, orgUsageSummaryReadStatement } from "../src/org-usage-summary.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";

function fixture() {
  const sql = createEphemeralSql();
  let time = "2026-10-15T12:00:00.000Z";
  const clock = () => new Date(time);
  return {
    sql,
    clock,
    policy: createOrgLimitPolicy({ sql, clock }),
    cash: createOrgCashExposureReservations({ sql, clock }),
    setTime: (value: string) => {
      time = value;
    },
  };
}

const prepaid = {
  organizationId: "org_a",
  authorizedPrincipal: "session:prn_a",
  reference: "policy_1",
  onLimit: "prepaid" as const,
};

async function errorCode(promise: Promise<unknown>, code: string, status = 409) {
  try {
    await promise;
    throw new Error("expected policy failure");
  } catch (error) {
    expect(error).toBeInstanceOf(OrgLimitPolicyError);
    expect(error).toMatchObject({ code, status });
  }
}

function lostAckSql(sql: Sql): Sql {
  let lose = true;
  return {
    query: (statement, params) => sql.query(statement, params),
    run: (statement, params) => sql.run(statement, params),
    async batch(statements) {
      const result = await sql.batch(statements);
      if (lose) {
        lose = false;
        throw new SqlError("unavailable", "lost acknowledgement after commit");
      }
      return result;
    },
  };
}

function summary(overrides: Partial<OrgUsageSummary> = {}): OrgUsageSummary {
  return {
    organizationId: "org_a",
    currency: "USD",
    unit: "USD-micros",
    periodKind: "free",
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    nextResetAt: "2026-11-01T00:00:00.000Z",
    originalIncludedMicros: 100,
    effectiveIncludedMicros: 100,
    usedMicros: 79,
    heldMicros: 1,
    availableMicros: 20,
    revokedMicros: 0,
    // Observer verifies the actual integer amounts rather than trusting these flags.
    utilizationBasisPoints: 0,
    reached80Percent: false,
    reached95Percent: false,
    limitReached: false,
    purchasedAvailableMicros: 10000,
    directAvailableMicros: 10000,
    ...overrides,
  };
}

function transport() {
  const delivered = new Map<string, OrgUsageWarning>();
  const attempts: string[] = [];
  const port: OrgUsageWarningTransport = {
    async deliver(warning, key) {
      attempts.push(key);
      delivered.set(key, warning);
      return { deliveryReference: `notification_${delivered.size}` };
    },
  };
  return { port, delivered, attempts };
}

async function freeEntitlement(f: ReturnType<typeof fixture>, amount = 100) {
  const at = f.clock().toISOString();
  await f.sql.batch([
    {
      sql: "INSERT INTO org_wallet_monthly_tariffs (month, pricing_revision, amount_micros, expires_at, created_at, money_policy) VALUES ('2026-10', 'r1', ?, '2026-11-01T00:00:00.000Z', ?, 'usd-micros-v2')",
      params: [amount, at],
    },
    {
      sql: "INSERT INTO org_wallet_grant_snapshots (org_id, ref, pricing_revision, amount_micros, expires_at, created_at, money_policy) VALUES ('org_a', 'free:org_a:2026-10', 'r1', ?, '2026-11-01T00:00:00.000Z', ?, 'usd-micros-v2')",
      params: [amount, at],
    },
    ...(amount > 0
      ? [
          {
            sql: "INSERT INTO wallet_credit_lots (org_id, ref, kind, amount_micros, expires_at, created_at, consumption_class) VALUES ('org_a', 'free:org_a:2026-10', 'plan-included', ?, '2026-11-01T00:00:00.000Z', ?, 'free')",
            params: [amount, at],
          },
        ]
      : []),
  ]);
}

function allocation(f: ReturnType<typeof fixture>, amount: number) {
  return {
    sql: "INSERT INTO wallet_credit_allocations (org_id, debit_type, debit_ref, lot_ref, amount_micros, created_at) VALUES ('org_a', 'hold', 'transient', 'free:org_a:2026-10', ?, ?)",
    params: [amount, f.clock().toISOString()],
  };
}

function atomicWarnings(f: ReturnType<typeof fixture>) {
  const input = {
    organizationId: "org_a",
    instant: f.clock().toISOString(),
    hostedPaidFreeExclusion: true,
  };
  return f.policy.warningStatements({ ...input, summaryRead: orgUsageSummaryReadStatement(input) });
}

describe("Hosted Organization limit consent", () => {
  test("operator postpaid gate defaults off and synchronously refuses unqualified or invalid flags before dependencies", () => {
    const calls = { query: 0, run: 0, batch: 0, clock: 0 };
    const sql: Sql = {
      async query() {
        calls.query += 1;
        throw new Error("SQL must not run");
      },
      async run() {
        calls.run += 1;
        throw new Error("SQL must not run");
      },
      async batch() {
        calls.batch += 1;
        throw new Error("SQL must not run");
      },
    };
    const clock = () => {
      calls.clock += 1;
      throw new Error("clock must not run");
    };
    expect(typeof createOrgLimitPolicy({ sql, clock }).change).toBe("function");
    expect(typeof createOrgLimitPolicy({ sql, clock, postpaidEnabled: false }).change).toBe(
      "function",
    );
    expect(() => assertOrgPostpaidLaunchGate(undefined)).not.toThrow();
    expect(() => assertOrgPostpaidLaunchGate(false)).not.toThrow();
    for (const value of [true, null, 0, 1, "true", "false", {}, []]) {
      const expected = value === true ? "postpaid_not_qualified" : "invalid_postpaid_enabled";
      for (const invoke of [
        () => assertOrgPostpaidLaunchGate(value),
        () => createOrgLimitPolicy({ sql, clock, postpaidEnabled: value as boolean }),
      ]) {
        try {
          invoke();
          throw new Error("expected synchronous launch refusal");
        } catch (error) {
          expect(error).toBeInstanceOf(OrgLimitPolicyError);
          expect(error).toMatchObject({ code: expected, status: 503 });
        }
      }
    }
    expect(calls).toEqual({ query: 0, run: 0, batch: 0, clock: 0 });
  });

  test("explicit flag off preserves stop/prepaid behavior and cannot replay unsupported mode activation", async () => {
    const f = fixture();
    const policy = createOrgLimitPolicy({ sql: f.sql, clock: f.clock, postpaidEnabled: false });
    expect(await policy.read("org_a")).toMatchObject({
      onLimit: "stop",
      capabilities: { postpaid: false, "on-demand": false },
    });
    const original = await policy.change(prepaid);
    await policy.change({ ...prepaid, reference: "policy_2", onLimit: "stop" });
    expect(await policy.change(prepaid)).toEqual(original);
    for (const onLimit of ["postpaid", "on-demand"] as const) {
      const change = {
        ...prepaid,
        reference: `old_${onLimit}`,
        onLimit,
        cashCapMinor: 1000,
        consentRevision: "historical-charge-terms",
      };
      const result = {
        ...original,
        onLimit,
        cashCapMinor: 1000,
        consentRevision: change.consentRevision,
        capabilities: { ...original.capabilities, [onLimit]: true },
      };
      await f.sql.run(
        "INSERT INTO org_wallet_limit_policy_commands (org_id, ref, authorized_principal, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
        [
          change.organizationId,
          change.reference,
          change.authorizedPrincipal,
          canonicalJson(change),
          canonicalJson(result),
          f.clock().toISOString(),
        ],
      );
      let queried = 0;
      const noLookup: Sql = {
        async query() {
          queried += 1;
          throw new Error("unsupported replay must not consult a receipt");
        },
        run: (statement, params) => f.sql.run(statement, params),
        batch: (statements) => f.sql.batch(statements),
      };
      await errorCode(
        createOrgLimitPolicy({ sql: noLookup, clock: f.clock, postpaidEnabled: false }).change(
          change,
        ),
        "limit_mode_unavailable",
      );
      expect(queried).toBe(0);
      expect(await policy.read("org_a")).toMatchObject({
        onLimit: "stop",
        capabilities: { postpaid: false, "on-demand": false },
      });
    }
    expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
  });

  test("flag off rejects a seeded postpaid policy and falsely active capabilities in an old supported-mode receipt", async () => {
    const f = fixture();
    const policy = createOrgLimitPolicy({ sql: f.sql, clock: f.clock, postpaidEnabled: false });
    await f.sql.run(
      "INSERT INTO org_wallet_limit_policies (org_id, on_limit, policy_version, consent_revision, cash_cap_minor, authorized_principal, updated_at) VALUES ('org_b', 'postpaid', 1, 'historical-postpaid-v1', 1000, 'session:prn_b', ?)",
      [f.clock().toISOString()],
    );
    const originalRow = await f.sql.query(
      "SELECT * FROM org_wallet_limit_policies WHERE org_id = 'org_b'",
    );
    await errorCode(policy.read("org_b"), "limit_mode_unavailable");
    await errorCode(policy.prepareAdmission("org_b"), "limit_mode_unavailable");
    const view = await policy.read("org_a");
    await f.sql.run(
      "INSERT INTO org_wallet_limit_policy_commands (org_id, ref, authorized_principal, fingerprint, result_json, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [
        prepaid.organizationId,
        prepaid.reference,
        prepaid.authorizedPrincipal,
        canonicalJson(prepaid),
        canonicalJson({
          ...view,
          onLimit: "prepaid",
          capabilities: { ...view.capabilities, postpaid: true },
        }),
        f.clock().toISOString(),
      ],
    );
    await errorCode(policy.change(prepaid), "limit_mode_unavailable");
    expect(
      await f.sql.query("SELECT * FROM org_wallet_limit_policies WHERE org_id = 'org_b'"),
    ).toEqual(originalRow);
    expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
  });
  test("startup refuses missing durable policy guards even when every table exists", async () => {
    const f = fixture();
    await f.sql.run("DROP TRIGGER org_wallet_limit_policy_commands_no_update");
    await errorCode(assertOrgLimitPolicySchema(f.sql), "billing_schema_not_ready", 503);
  });
  test("free has stop by default; explicit prepaid does not require or create a card", async () => {
    const f = fixture();
    await assertOrgLimitPolicySchema(f.sql);
    expect(await f.policy.read("org_a")).toEqual({
      onLimit: "stop",
      capabilities: { stop: true, prepaid: true, postpaid: false, "on-demand": false },
      consentRevision: null,
      cashCapMinor: null,
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
    });
    expect(await f.policy.prepareAdmission("org_a")).toMatchObject({
      onLimit: "stop",
      policyVersion: 0,
      consentRevision: null,
      allowPurchasedCredit: false,
    });
    expect(await f.policy.change(prepaid)).toMatchObject({
      onLimit: "prepaid",
      consentRevision: PREPAID_CONSENT_REVISION,
      cashCapMinor: null,
    });
    expect(await f.policy.prepareAdmission("org_a")).toMatchObject({
      onLimit: "prepaid",
      policyVersion: 1,
      consentRevision: PREPAID_CONSENT_REVISION,
      allowPurchasedCredit: true,
    });
    expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual([]);
  });

  test("unsupported modes and missing consent fail visibly without commands or exposure", async () => {
    const f = fixture();
    for (const onLimit of ["on-demand", "postpaid"] as const) {
      await errorCode(
        f.policy.change({
          ...prepaid,
          onLimit,
          cashCapMinor: 1000,
          consentRevision: "off-session-v1",
        }),
        "limit_mode_unavailable",
      );
      await errorCode(f.policy.change({ ...prepaid, onLimit }), "invalid_cash_cap", 400);
      await errorCode(
        f.policy.change({ ...prepaid, onLimit, cashCapMinor: 1000 }),
        "invalid_payment_principal",
        400,
      );
    }
    await errorCode(
      f.policy.change({ ...prepaid, cashCapMinor: 1000 }),
      "invalid_limit_policy",
      400,
    );
    await errorCode(
      f.policy.change({ ...prepaid, consentRevision: "saved-card-is-not-consent" }),
      "invalid_limit_policy",
      400,
    );
    await errorCode(
      f.policy.change({ ...prepaid, extra: true } as typeof prepaid),
      "invalid_limit_policy",
      400,
    );
    expect(await f.sql.query("SELECT * FROM org_wallet_limit_policies")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM org_wallet_limit_policy_commands")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM org_wallet_cash_cap_buckets")).toEqual([]);
  });

  test("the exact actor-bound command survives later stop and month rollover", async () => {
    const f = fixture();
    const original = await f.policy.change(prepaid);
    await errorCode(
      f.policy.change({ ...prepaid, authorizedPrincipal: "api_key:service_b" }),
      "reference_conflict",
    );
    await errorCode(f.policy.change({ ...prepaid, onLimit: "stop" }), "reference_conflict");
    await f.policy.change({ ...prepaid, reference: "policy_2", onLimit: "stop" });
    f.setTime("2026-11-01T00:00:00.000Z");
    expect(await f.policy.read("org_a")).toMatchObject({
      onLimit: "stop",
      periodStart: "2026-11-01T00:00:00.000Z",
    });
    expect(await f.policy.change(prepaid)).toEqual(original);
    expect(await f.policy.read("org_b")).toMatchObject({ onLimit: "stop" });
    const receipts = await f.sql.query(
      "SELECT authorized_principal FROM org_wallet_limit_policy_commands WHERE org_id = 'org_a'",
    );
    expect(receipts).toEqual([
      { authorized_principal: "session:prn_a" },
      { authorized_principal: "session:prn_a" },
    ]);
  });

  test("concurrent same-command election and a database lost ACK retain one version", async () => {
    const f = fixture();
    const other = createOrgLimitPolicy({ sql: f.sql, clock: f.clock });
    const results = await Promise.all([f.policy.change(prepaid), other.change(prepaid)]);
    expect(results[0]).toEqual(results[1]);
    expect(await f.sql.query("SELECT policy_version FROM org_wallet_limit_policies")).toEqual([
      { policy_version: 1 },
    ]);
    const uncertain = createOrgLimitPolicy({ sql: lostAckSql(f.sql), clock: f.clock });
    const stop = { ...prepaid, reference: "policy_2", onLimit: "stop" as const };
    const stopped = await uncertain.change(stop);
    expect(await uncertain.change(stop)).toEqual(stopped);
    expect(await f.sql.query("SELECT policy_version FROM org_wallet_limit_policies")).toEqual([
      { policy_version: 2 },
    ]);
  });

  test("competing distinct commands cannot both commit from the same policy version", async () => {
    const f = fixture();
    const results = await Promise.allSettled([
      f.policy.change(prepaid),
      f.policy.change({ ...prepaid, reference: "policy_2", onLimit: "stop" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(
      await f.sql.query("SELECT COUNT(*) AS count FROM org_wallet_limit_policy_commands"),
    ).toEqual([{ count: 1 }]);
  });

  test("policy revocation rolls back a stale admission and its new money effect", async () => {
    const f = fixture();
    await f.policy.change(prepaid);
    const admission = await f.policy.prepareAdmission("org_a");
    await f.policy.change({ ...prepaid, reference: "policy_2", onLimit: "stop" });
    await expect(
      f.sql.batch([
        admission.guard,
        {
          sql: "INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at) VALUES ('led_new', 'org_a', 'hold', 'new', 0, 10, ?)",
          params: [f.clock().toISOString()],
        },
        admission.cleanup,
      ]),
    ).rejects.toBeInstanceOf(SqlError);
    expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
    expect(await f.policy.prepareAdmission("org_a")).toMatchObject({
      policyVersion: 2,
      allowPurchasedCredit: false,
    });
  });

  test("an unsupported stored policy cannot turn into active prepaid or silently stop", async () => {
    const f = fixture();
    await seedOnDemand(f.sql);
    await errorCode(f.policy.read("org_a"), "limit_mode_unavailable");
    await errorCode(f.policy.prepareAdmission("org_a"), "limit_mode_unavailable");
  });
});

describe("Frozen entitlement warning outbox", () => {
  test("atomic paid warning uses the refunded net allowance and original invoice interval", async () => {
    const f = fixture();
    await freeEntitlement(f);
    const stripe = createStripeBillingStore({ sql: f.sql, clock: f.clock });
    const grant = {
      organizationId: "org_a",
      fundingRef: "stripe:invoice:in_warning",
      kind: "plan-included" as const,
      amountMicros: 2000,
      expiresAt: "2026-11-14T12:00:00.000Z",
      sourceType: "invoice" as const,
      sourceId: "in_warning",
      chargeId: "ch_warning",
      customerId: "cus_warning",
      subscriptionId: "sub_warning",
      planKey: "starter",
      pricingRevision: "r1",
      stripePriceId: "price_starter",
      periodStart: "2026-10-14T12:00:00.000Z",
      periodEnd: "2026-11-14T12:00:00.000Z",
      considerationMicros: 2000,
    };
    await stripe.grant(grant);
    const fenceGeneration = await stripe.freezeFunding("org_a", grant.fundingRef);
    await stripe.refund({
      refundId: "re_warning_half",
      grant,
      amountMicros: 1000,
      cumulativeRefundedMicros: 1000,
      fenceGeneration,
    });
    await f.sql.batch([
      {
        sql: "INSERT INTO wallet_credit_allocations (org_id, debit_type, debit_ref, lot_ref, amount_micros, created_at) VALUES ('org_a', 'hold', 'paid_transient', ?, 800, ?)",
        params: [grant.fundingRef, f.clock().toISOString()],
      },
      ...atomicWarnings(f),
    ]);
    const rows = await f.sql.query("SELECT payload_json FROM org_wallet_usage_warnings");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(String(rows[0]?.payload_json))).toMatchObject({
      periodKind: "paid",
      periodStart: grant.periodStart,
      periodEnd: grant.periodEnd,
      thresholdBasisPoints: 8000,
      effectiveIncludedMicros: "1000",
      heldMicros: "800",
    });
  });
  test("atomic post-allocation warning survives a transient hold released before any summary GET", async () => {
    const f = fixture();
    await freeEntitlement(f);
    await f.sql.batch([allocation(f, 80), ...atomicWarnings(f)]);
    await f.sql.batch([
      {
        sql: "DELETE FROM wallet_credit_allocations WHERE org_id = 'org_a' AND debit_ref = 'transient'",
      },
      ...atomicWarnings(f),
    ]);
    const rows = await f.sql.query(
      "SELECT threshold_basis_points, payload_json FROM org_wallet_usage_warnings",
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.threshold_basis_points).toBe(8000);
    expect(JSON.parse(String(rows[0]?.payload_json))).toMatchObject({
      heldMicros: "80",
      usedMicros: "0",
      periodKind: "free",
      effectiveIncludedMicros: "100",
    });
    expect(await f.policy.dispatchWarnings(transport().port)).toBe(1);
  });

  test("a failed money batch rolls back allocation and threshold outbox together", async () => {
    const f = fixture();
    await freeEntitlement(f);
    await expect(
      f.sql.batch([
        allocation(f, 95),
        ...atomicWarnings(f),
        { sql: "INSERT INTO wallet_allocation_guards (id, valid) VALUES ('reject', 0)" },
      ]),
    ).rejects.toBeInstanceOf(SqlError);
    expect(await f.sql.query("SELECT * FROM wallet_credit_allocations")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM org_wallet_usage_warnings")).toEqual([]);
  });

  test("atomic 80/95 thresholds are exact at safe-integer scale without REAL multiplication", async () => {
    const f = fixture();
    const amount = Number.MAX_SAFE_INTEGER;
    await freeEntitlement(f, amount);
    const threshold80 = Number((BigInt(amount) * 4n + 4n) / 5n);
    const threshold95 = Number((BigInt(amount) * 19n + 19n) / 20n);
    for (const held of [threshold80 - 1, threshold80, threshold95 - 1, threshold95]) {
      await f.sql.batch([
        {
          sql: "DELETE FROM wallet_credit_allocations WHERE org_id = 'org_a' AND debit_ref = 'transient'",
        },
        allocation(f, held),
        ...atomicWarnings(f),
      ]);
      const expected = held < threshold80 ? 0 : held < threshold95 ? 1 : 2;
      expect(await f.sql.query("SELECT COUNT(*) AS count FROM org_wallet_usage_warnings")).toEqual([
        { count: expected },
      ]);
    }
  });

  test("absent or zero current entitlement during terminal settlement creates no warning", async () => {
    const f = fixture();
    await f.sql.batch(atomicWarnings(f));
    await freeEntitlement(f, 0);
    await f.sql.batch(atomicWarnings(f));
    expect(await f.sql.query("SELECT * FROM org_wallet_usage_warnings")).toEqual([]);
  });
  test("corrupt retained warning proof is rejected before acquiring a claim", async () => {
    const f = fixture();
    await f.sql.run(
      "INSERT INTO org_wallet_usage_warnings (org_id, period_start, period_end, threshold_basis_points, payload_json, state, created_at) VALUES ('org_a', '2026-10-01T00:00:00.000Z', '2026-11-01T00:00:00.000Z', 8000, 'null', 'pending', '2026-10-15T12:00:00.000Z')",
    );
    await errorCode(f.policy.dispatchWarnings(transport().port), "billing_policy_unavailable", 503);
    expect(await f.sql.query("SELECT state, claim_token FROM org_wallet_usage_warnings")).toEqual([
      { state: "pending", claim_token: null },
    ]);
  });
  test("80/95 use held + used and deduplicate retries, restart, releases and foreign Org", async () => {
    const f = fixture();
    await Promise.all([
      f.policy.observeUsageSummary(summary()),
      f.policy.observeUsageSummary(summary()),
    ]);
    await f.policy.observeUsageSummary(summary({ usedMicros: 95, heldMicros: 0 }));
    await createOrgLimitPolicy({ sql: f.sql, clock: f.clock }).observeUsageSummary(
      summary({ usedMicros: 0, heldMicros: 0 }),
    );
    await f.policy.observeUsageSummary(summary({ organizationId: "org_b" }));
    const rows = await f.sql.query(
      "SELECT org_id, threshold_basis_points, payload_json FROM org_wallet_usage_warnings ORDER BY org_id, threshold_basis_points",
    );
    expect(rows.map((row) => [row.org_id, row.threshold_basis_points])).toEqual([
      ["org_a", 8000],
      ["org_a", 9500],
      ["org_b", 8000],
    ]);
    expect(JSON.parse(String(rows[0]?.payload_json))).toMatchObject({
      usedMicros: "79",
      heldMicros: "1",
    });
    const delivery = transport();
    expect(await f.policy.dispatchWarnings(delivery.port)).toBe(3);
    expect(await f.policy.dispatchWarnings(delivery.port)).toBe(0);
    expect(delivery.delivered.size).toBe(3);
  });

  test("warnings are unique in the original paid service period, separately from UTC cap month", async () => {
    const f = fixture();
    const paid = summary({
      periodKind: "paid",
      periodStart: "2026-10-15T10:00:00.000Z",
      periodEnd: "2026-11-15T10:00:00.000Z",
      nextResetAt: "2026-11-15T10:00:00.000Z",
      usedMicros: 95,
      heldMicros: 0,
    });
    await f.policy.observeUsageSummary(paid);
    f.setTime("2026-11-01T00:00:00.000Z");
    await f.policy.observeUsageSummary(paid);
    await f.policy.observeUsageSummary(
      summary({
        periodStart: "2026-11-01T00:00:00.000Z",
        periodEnd: "2026-12-01T00:00:00.000Z",
        nextResetAt: "2026-12-01T00:00:00.000Z",
      }),
    );
    expect(await f.sql.query("SELECT COUNT(*) AS count FROM org_wallet_usage_warnings")).toEqual([
      { count: 3 },
    ]);
    expect(await f.policy.read("org_a")).toMatchObject({ periodStart: "2026-11-01T00:00:00.000Z" });
  });

  test("zero allowance does not warn and aggregate overflow cannot create warning evidence", async () => {
    const f = fixture();
    await f.policy.observeUsageSummary(
      summary({ effectiveIncludedMicros: 0, usedMicros: 0, heldMicros: 0 }),
    );
    await f.policy.observeUsageSummary(summary({ usedMicros: 78, heldMicros: 1 }));
    await errorCode(
      f.policy.observeUsageSummary(summary({ usedMicros: Number.MAX_SAFE_INTEGER, heldMicros: 1 })),
      "billing_policy_unavailable",
      503,
    );
    expect(await f.sql.query("SELECT * FROM org_wallet_usage_warnings")).toEqual([]);
  });

  test("a missing transport cannot claim or deliver an outbox entry", async () => {
    const f = fixture();
    await f.policy.observeUsageSummary(summary());
    await errorCode(
      f.policy.dispatchWarnings(undefined as unknown as OrgUsageWarningTransport),
      "warning_transport_unavailable",
      503,
    );
    expect(
      await f.sql.query("SELECT state, claim_token, delivered_at FROM org_wallet_usage_warnings"),
    ).toEqual([{ state: "pending", claim_token: null, delivered_at: null }]);
  });

  test("concurrent dispatch claims one sender; lost ACK retries the original transport key", async () => {
    const f = fixture();
    await f.policy.observeUsageSummary(summary());
    const delivery = transport();
    const results = await Promise.all([
      f.policy.dispatchWarnings(delivery.port),
      f.policy.dispatchWarnings(delivery.port),
    ]);
    expect(results.reduce((sum, value) => sum + value, 0)).toBe(1);
    expect(delivery.attempts).toHaveLength(1);
    await f.policy.observeUsageSummary(summary({ usedMicros: 95, heldMicros: 0 }));
    let uncertain = true;
    const lost: OrgUsageWarningTransport = {
      async deliver(warning, key) {
        const ack = await delivery.port.deliver(warning, key);
        if (uncertain) {
          uncertain = false;
          throw new Error("transport lost ACK");
        }
        return ack;
      },
    };
    await expect(f.policy.dispatchWarnings(lost)).rejects.toThrow("transport lost ACK");
    expect(
      await f.sql.query(
        "SELECT state, delivered_at FROM org_wallet_usage_warnings WHERE threshold_basis_points = 9500",
      ),
    ).toEqual([{ state: "dispatching", delivered_at: null }]);
    expect(await f.policy.dispatchWarnings(lost)).toBe(0);
    f.setTime("2026-10-15T12:01:00.000Z");
    expect(await createOrgLimitPolicy({ sql: f.sql, clock: f.clock }).dispatchWarnings(lost)).toBe(
      1,
    );
    expect(delivery.attempts[1]).toBe(delivery.attempts[2]);
    expect(delivery.delivered.size).toBe(2);
  });

  test("a transport without an authoritative ACK retains the claim for reconciliation", async () => {
    const f = fixture();
    await f.policy.observeUsageSummary(summary());
    const bad = { deliver: async () => undefined } as unknown as OrgUsageWarningTransport;
    await errorCode(f.policy.dispatchWarnings(bad), "warning_delivery_unacknowledged", 503);
    expect(await f.sql.query("SELECT state, delivered_at FROM org_wallet_usage_warnings")).toEqual([
      { state: "dispatching", delivered_at: null },
    ]);
  });
});

// This deliberately represents persisted consent owned by a future qualified
// funding implementation. It does not enable the public unsupported mode.
async function seedOnDemand(sql: Sql, cap = 1000) {
  await sql.run(
    "INSERT INTO org_wallet_limit_policies (org_id, on_limit, policy_version, consent_revision, cash_cap_minor, authorized_principal, updated_at) VALUES ('org_a', 'on-demand', 1, 'off-session-v1', ?, 'session:prn_a', '2026-10-15T12:00:00.000Z')",
    [cap],
  );
}

const exposure = {
  organizationId: "org_a",
  reference: "cash_1",
  policyVersion: 1,
  consentRevision: "off-session-v1",
  amountMinor: 600,
};

describe("Internal cash cap exposure bookkeeping", () => {
  test("a verified failed intent releases only its reservation; one paid source cannot settle twice", async () => {
    const f = fixture();
    await seedOnDemand(f.sql);
    await f.cash.reserve(exposure);
    const released = await f.cash.resolve({
      organizationId: "org_a",
      reference: "cash_1",
      status: "released",
      sourceReference: "pi_failed",
    });
    expect(await f.cash.reserve(exposure)).toEqual(released);
    await f.cash.reserve({ ...exposure, reference: "cash_2" });
    await f.cash.resolve({
      organizationId: "org_a",
      reference: "cash_2",
      status: "paid",
      sourceReference: "pi_paid",
    });
    await f.cash.reserve({ ...exposure, reference: "cash_3", amountMinor: 400 });
    await errorCode(
      f.cash.resolve({
        organizationId: "org_a",
        reference: "cash_3",
        status: "paid",
        sourceReference: "pi_paid",
      }),
      "billing_policy_unavailable",
      503,
    );
    expect(
      await f.sql.query("SELECT ref, status FROM org_wallet_cash_exposures ORDER BY ref"),
    ).toEqual([
      { ref: "cash_1", status: "released" },
      { ref: "cash_2", status: "paid" },
      { ref: "cash_3", status: "reserved" },
    ]);
  });
  test("no stored off-session consent means no cash reservation, including prepaid", async () => {
    const f = fixture();
    await errorCode(f.cash.reserve(exposure), "off_session_consent_required");
    await f.policy.change(prepaid);
    await errorCode(f.cash.reserve(exposure), "off_session_consent_required");
    expect(await f.sql.query("SELECT * FROM org_wallet_cash_cap_buckets")).toEqual([]);
  });

  test("concurrent reservations elect one pending command and paid cash consumes cap even without a hold", async () => {
    const f = fixture();
    await seedOnDemand(f.sql);
    const results = await Promise.allSettled([
      f.cash.reserve(exposure),
      f.cash.reserve({ ...exposure, reference: "cash_2" }),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    const rows = await f.sql.query("SELECT ref FROM org_wallet_cash_exposures");
    const reference = String(rows[0]?.ref);
    await f.cash.resolve({
      organizationId: "org_a",
      reference,
      status: "paid",
      sourceReference: "pi_1",
    });
    await errorCode(
      f.cash.reserve({ ...exposure, reference: "cash_3", amountMinor: 401 }),
      "cash_cap_or_exposure_conflict",
    );
    await f.cash.reserve({ ...exposure, reference: "cash_4", amountMinor: 400 });
    expect(
      await f.sql.query(
        "SELECT SUM(amount_minor) AS total FROM org_wallet_cash_exposures WHERE status IN ('reserved', 'paid')",
      ),
    ).toEqual([{ total: 1000 }]);
    expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
  });

  test("month rollover preserves unknown original exposure and blocks a fresh charge until readback", async () => {
    const f = fixture();
    f.setTime("2026-10-31T23:59:59.000Z");
    await seedOnDemand(f.sql);
    const original = await f.cash.reserve(exposure);
    f.setTime("2026-11-01T00:00:00.000Z");
    expect(await f.cash.reserve(exposure)).toEqual(original);
    await errorCode(
      f.cash.reserve({ ...exposure, reference: "cash_2" }),
      "cash_cap_or_exposure_conflict",
    );
    await errorCode(
      f.policy.change({ ...prepaid, reference: "stop_pending", onLimit: "stop" }),
      "limit_policy_conflict",
    );
    await f.cash.resolve({
      organizationId: "org_a",
      reference: "cash_1",
      status: "paid",
      sourceReference: "pi_october",
    });
    const november = await f.cash.reserve({ ...exposure, reference: "cash_2" });
    expect(november.periodStart).toBe("2026-11-01T00:00:00.000Z");
    expect(
      await f.sql.query(
        "SELECT period_start FROM org_wallet_cash_cap_buckets ORDER BY period_start",
      ),
    ).toEqual([
      { period_start: "2026-10-01T00:00:00.000Z" },
      { period_start: "2026-11-01T00:00:00.000Z" },
    ]);
    expect((await f.cash.reserve(exposure)).periodStart).toBe(original.periodStart);
  });

  test("lost database ACK preserves reservation; only original-source terminal outcome changes it once", async () => {
    const f = fixture();
    await seedOnDemand(f.sql);
    const uncertain = createOrgCashExposureReservations({ sql: lostAckSql(f.sql), clock: f.clock });
    const retained = await uncertain.reserve(exposure);
    expect(retained.status).toBe("reserved");
    expect(await uncertain.reserve(exposure)).toEqual(retained);
    await errorCode(uncertain.reserve({ ...exposure, amountMinor: 601 }), "reference_conflict");
    const paid = await uncertain.resolve({
      organizationId: "org_a",
      reference: "cash_1",
      status: "paid",
      sourceReference: "pi_1",
    });
    expect(
      await uncertain.resolve({
        organizationId: "org_a",
        reference: "cash_1",
        status: "paid",
        sourceReference: "pi_1",
      }),
    ).toEqual(paid);
    await errorCode(
      uncertain.resolve({
        organizationId: "org_a",
        reference: "cash_1",
        status: "released",
        sourceReference: "pi_1",
      }),
      "reference_conflict",
    );
    await errorCode(
      uncertain.resolve({
        organizationId: "org_b",
        reference: "cash_1",
        status: "paid",
        sourceReference: "pi_1",
      }),
      "cash_exposure_not_found",
      404,
    );
  });

  test("unsafe cash values cannot create an imprecise cap reservation", async () => {
    const f = fixture();
    await seedOnDemand(f.sql);
    await errorCode(
      f.cash.reserve({ ...exposure, amountMinor: Number.MAX_SAFE_INTEGER }),
      "invalid_cash_cap",
      400,
    );
    await errorCode(f.cash.reserve({ ...exposure, amountMinor: 0 }), "invalid_cash_cap", 400);
    expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual([]);
  });
});
