import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { canonicalJson } from "../src/json.ts";
import {
  type ChangeOrgOnDemandPolicy,
  createOrgCashExposureReservations,
  createOrgLimitPolicy,
  readOrgOnDemandConsent,
} from "../src/org-limit-policy.ts";
import { parseOrgOnDemandTerms } from "../src/org-on-demand-terms.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";
import { createStripeOnDemand } from "../src/stripe-on-demand.ts";
import { verifyStripeOnDemandCard } from "../src/stripe-on-demand-verification.ts";
import { migratedDatabase } from "./helpers/migrated-database.ts";

const AT = "2026-10-15T12:00:00.000Z";
const ORG = "org_consent";
const CUSTOMER = "cus_consent";
const PM = "pm_consent";
const TERMS = {
  termsRevision: "operator-terms-r1",
  consentRevision: "merchant-consent-r1",
  currency: "USD",
  validity: { validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2027-02-01T00:00:00.000Z" },
  replenishment: {
    trigger: "eligible-credit-deficit",
    rule: "ceil-deficit-to-quantum-with-minimum",
    fundingQuantumMinor: 100,
    minimumChargeMinor: 100,
    maximumChargeMinor: 1000,
  },
  cashCapBounds: { minimumMinor: 100, maximumMinor: 10000 },
  purchaseCreditExpiry: { kind: "fixed-duration", seconds: 3600 },
};
const CHANGE: ChangeOrgOnDemandPolicy = {
  organizationId: ORG,
  authorizedPrincipal: "session:prn_consent",
  reference: "explicit-consent",
  onLimit: "on-demand",
  cashCapMinor: 5000,
  consentRevision: TERMS.consentRevision,
  termsRevision: TERMS.termsRevision,
  paymentMethodId: PM,
};

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const db = migratedDatabase();
  const base = createSqliteSql(db);
  let at = AT,
    cardAvailable = true,
    losePolicyAck = false;
  let batchGate: ((statements: readonly SqlStatement[]) => Promise<void>) | undefined;
  const sql: Sql = {
    query: (statement, params) => base.query(statement, params),
    run: (statement, params) => base.run(statement, params),
    async batch(statements) {
      await batchGate?.(statements);
      const result = await base.batch(statements);
      if (
        losePolicyAck &&
        statements.some((statement) =>
          statement.sql.startsWith("INSERT INTO org_wallet_limit_policy_commands"),
        )
      ) {
        losePolicyAck = false;
        throw new SqlError("unavailable", "lost local policy acknowledgement");
      }
      return result;
    },
  };
  const clock = () => new Date(at);
  await sql.run("INSERT INTO stripe_mode_realm VALUES(1,'test',?)", [AT]);
  await sql.run(
    "INSERT INTO stripe_billing_account_realms VALUES(1,'acct_consentfixture','test','consent-fixture',?)",
    [AT],
  );
  await sql.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,?,?,?)", [
    ORG,
    "Consent fixture",
    "prn_consent",
    AT,
  ]);
  await sql.run("INSERT INTO stripe_billing_customers VALUES(?,?,?)", [ORG, CUSTOMER, AT]);
  const calls: { method: string; path: string }[] = [];
  const client = createStripeBillingClient({
    secretKey: "sk_test_policy_fixture_never_a_credential",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({ method: request.method, path });
      if (request.method !== "GET")
        throw new Error("policy verification must never send a native mutation");
      if (path === "/v1/account")
        return Response.json({ id: "acct_consentfixture", object: "account" });
      if (path === "/v1/balance")
        return Response.json({ object: "balance", livemode: false, available: [], pending: [] });
      if (path === `/v1/customers/${CUSTOMER}`)
        return Response.json({
          id: CUSTOMER,
          object: "customer",
          livemode: false,
          metadata: { organizationId: ORG, takoserverPurpose: "hosted_subscription" },
        });
      if (path === "/v1/prices/price_consentfixture")
        return Response.json({
          id: "price_consentfixture",
          object: "price",
          livemode: false,
          active: true,
          currency: "usd",
          type: "recurring",
          billing_scheme: "per_unit",
          unit_amount: 1000,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      if (path === `/v1/payment_methods/${PM}` && cardAvailable)
        return Response.json({
          id: PM,
          object: "payment_method",
          livemode: false,
          type: "card",
          customer: CUSTOMER,
          card: {
            exp_month: 12,
            exp_year: 2030,
            last4: "must-not-persist",
            fingerprint: "must-not-persist",
          },
          billing_details: { name: "must-not-persist" },
        });
      if (path === "/v1/setup_intents/seti_consent")
        return Response.json({
          id: "seti_consent",
          object: "setup_intent",
          livemode: false,
          status: "succeeded",
          usage: "off_session",
          customer: CUSTOMER,
          payment_method: PM,
          client_secret: "must-not-persist",
        });
      return new Response("", { status: 404 });
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: {
      accountId: "acct_consentfixture",
      mode: "test",
      billingAuthority: "consent-fixture",
    },
    prices: [{ priceId: "price_consentfixture", monthlyAmountMinor: 1000 }],
  });
  const billingConfig = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "consent-pricing-r1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 300,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "fixed-duration", seconds: 3600 },
      plans: { "fixture-paid": { includedMinor: 2000, stripePriceId: "price_consentfixture" } },
      meters: { request: { unit: "request", rate: { numeratorMicros: "1", denominator: "1" } } },
    }),
  );
  if (!billingConfig) throw new Error("fixture billing config missing");
  const store = createStripeBillingStore({ sql, clock });
  const service = await createStripeOnDemand({
    sql,
    clock,
    client,
    realm,
    store,
    billingConfig,
    terms: parseOrgOnDemandTerms(TERMS),
  });
  const policy = createOrgLimitPolicy({ sql, clock, onDemand: service });
  const cash = createOrgCashExposureReservations({ sql, clock });
  const snapshot = async () =>
    Object.fromEntries(
      await Promise.all(
        [
          "org_wallet_limit_policies",
          "org_wallet_limit_policy_commands",
          "org_wallet_cash_exposures",
          "stripe_billing_on_demand_commands",
          "stripe_billing_on_demand_attempts",
          "stripe_billing_on_demand_abandonments",
        ].map(async (table) => [table, await sql.query(`SELECT * FROM ${table}`)]),
      ),
    );
  /** Synthetic never-dispatched original, under the real schema and actual accepted consent. No fresh admission authority or remote mutation is claimed. */
  async function prepared(reference = "cash-original") {
    const consent = await readOrgOnDemandConsent({ sql, organizationId: ORG });
    if (!consent) throw new Error("explicit active consent missing");
    const planned = await cash.prepareReservation(
      {
        organizationId: ORG,
        reference: `exposure-${reference}`,
        policyVersion: consent.policyVersion,
        consentRevision: consent.acceptedTerms.consentRevision,
        amountMinor: 100,
      },
      at,
    );
    const { organizationId: _org, reference: _ref, fingerprint: _fp, ...envelope } = consent;
    await sql.batch([
      ...planned.statements,
      {
        sql: `INSERT INTO stripe_billing_on_demand_commands
        (org_id,reference,admission_json,exposure_ref,funding_ref,fingerprint,account_id,mode,billing_authority,customer_id,payment_method_id,setup_intent_id,authorized_principal,consent_revision,terms_revision,terms_json,consent_json,request_json,policy_version,cap_minor,period_start,period_end,amount_minor,credit_expiry_kind,credit_expiry_seconds,terms_expires_at,stripe_key,state,created_at)
        VALUES(?,?,?,?,?,?,?,'test',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,'fixed-duration',3600,?,?,'prepared',?)`,
        params: [
          ORG,
          reference,
          canonicalJson({
            organizationId: ORG,
            namespace: "org-hold",
            reference: "fresh-original",
            fingerprint: "fresh-fingerprint",
          }),
          planned.receipt.reference,
          `on-demand-${reference}`,
          `fingerprint-${reference}`,
          realm.accountId,
          realm.billingAuthority,
          CUSTOMER,
          PM,
          null,
          CHANGE.authorizedPrincipal,
          TERMS.consentRevision,
          TERMS.termsRevision,
          canonicalJson(consent.acceptedTerms),
          canonicalJson(envelope),
          canonicalJson({
            currency: "usd",
            amount: 100,
            customer: CUSTOMER,
            payment_method: PM,
            off_session: true,
            confirm: true,
          }),
          consent.policyVersion,
          CHANGE.cashCapMinor,
          planned.receipt.periodStart,
          planned.receipt.periodEnd,
          100,
          planned.receipt.periodEnd,
          `stable-${reference}`,
          at,
        ],
      },
    ]);
    return { reference, version: consent.policyVersion };
  }
  /** The actual schema's first-attempt closure, with the same policy-version CAS used by the financial owner; no POST follows in this policy-only witness. */
  async function firstDispatch(reference: string, version: number) {
    const id = `test-${crypto.randomUUID()}`;
    await sql.batch([
      {
        sql: "INSERT INTO wallet_allocation_guards(id,valid) VALUES(?,CASE WHEN EXISTS(SELECT 1 FROM org_wallet_limit_policies WHERE org_id=? AND on_limit='on-demand' AND policy_version=?) AND EXISTS(SELECT 1 FROM stripe_billing_on_demand_commands WHERE org_id=? AND reference=? AND state='prepared') THEN 1 ELSE 0 END)",
        params: [id, ORG, version, ORG, reference],
      },
      {
        sql: "INSERT INTO stripe_billing_on_demand_attempts(org_id,reference,sequence,kind,detail_json,created_at,first_dispatch_at) VALUES(?,?,1,'first-dispatch','{}',?,?)",
        params: [ORG, reference, at, at],
      },
      {
        sql: "UPDATE stripe_billing_on_demand_commands SET state='dispatched',dispatched_at=? WHERE org_id=? AND reference=? AND state='prepared'",
        params: [at, ORG, reference],
      },
      { sql: "DELETE FROM wallet_allocation_guards WHERE id=?", params: [id] },
    ]);
  }
  return {
    db,
    sql,
    base,
    clock,
    client,
    realm,
    policy,
    service,
    cash,
    calls,
    snapshot,
    prepared,
    firstDispatch,
    time(value: string) {
      at = value;
    },
    card(value: boolean) {
      cardAvailable = value;
    },
    lostAck() {
      losePolicyAck = true;
    },
    gate(value: typeof batchGate) {
      batchGate = value;
    },
  };
}

describe("explicit on-demand policy consent", () => {
  test("first explicit stop persists its original plain receipt without manufacturing consent", async () => {
    const f = await fixture();
    try {
      const native = f.calls.length;
      const stop = {
        organizationId: ORG,
        authorizedPrincipal: CHANGE.authorizedPrincipal,
        reference: "explicit-first-stop",
        onLimit: "stop" as const,
      };
      const original = await f.policy.change(stop);
      expect(original).toMatchObject({
        onLimit: "stop",
        consentRevision: null,
        cashCapMinor: null,
      });
      const rows = await f.sql.query("SELECT * FROM org_wallet_limit_policy_commands");
      expect(rows).toHaveLength(1);
      expect(JSON.parse(String(rows[0]?.result_json))).toEqual(original);
      expect(await f.sql.query("SELECT policy_version FROM org_wallet_limit_policies")).toEqual([
        { policy_version: 1 },
      ]);
      const before = await f.snapshot();
      f.time("2028-01-01T00:00:00.000Z");
      f.card(false);
      expect(await f.policy.change(stop)).toEqual(original);
      expect(await f.snapshot()).toEqual(before);
      expect(await readOrgOnDemandConsent({ sql: f.sql, organizationId: ORG })).toBeNull();
      expect(f.calls).toHaveLength(native);
    } finally {
      f.db.close();
    }
  });

  test("saved card and optional successful setup remain separate from merchant consent", async () => {
    const f = await fixture();
    try {
      expect(
        await verifyStripeOnDemandCard(
          { sql: f.sql, client: f.client, realm: f.realm },
          {
            organizationId: ORG,
            customerId: CUSTOMER,
            paymentMethodId: PM,
            setupIntentId: "seti_consent",
            verifiedAt: AT,
          },
        ),
      ).toMatchObject({ paymentMethodId: PM, setupIntentId: "seti_consent" });
      expect(await f.policy.read(ORG)).toMatchObject({
        onLimit: "stop",
        consentRevision: null,
        cashCapMinor: null,
        capabilities: { "on-demand": true, postpaid: false },
      });
      expect(await f.policy.prepareAdmission(ORG)).toMatchObject({
        onLimit: "stop",
        allowPurchasedCredit: false,
      });
      expect(await f.sql.query("SELECT * FROM org_wallet_limit_policy_commands")).toEqual([]);
      const result = await f.policy.change({ ...CHANGE, setupIntentId: "seti_consent" });
      expect(result).toMatchObject({
        onLimit: "on-demand",
        consentRevision: TERMS.consentRevision,
        cashCapMinor: 5000,
      });
      const rows = await f.sql.query("SELECT * FROM org_wallet_limit_policy_commands");
      const envelope = JSON.parse(String(rows[0]?.result_json));
      expect(envelope).toMatchObject({
        kind: "org-limit-policy-consent-v1",
        version: 1,
        policyVersion: 1,
        authorizedPrincipal: CHANGE.authorizedPrincipal,
        acceptedAt: AT,
        publicResult: result,
        acceptedTerms: TERMS,
        selectedCardProof: {
          organizationId: ORG,
          customerId: CUSTOMER,
          paymentMethodId: PM,
          setupIntentId: "seti_consent",
        },
      });
      expect(String(rows[0]?.result_json)).not.toContain("must-not-persist");
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands")).toEqual([]);
      expect(f.calls.every((call) => call.method === "GET")).toBe(true);
    } finally {
      f.db.close();
    }
  });

  test("exact original payload and actor replay before current terms/card/month checks and changed payload refuses locally", async () => {
    const f = await fixture();
    try {
      const original = await f.policy.change(CHANGE);
      const saved = await f.snapshot();
      f.time("2028-01-01T00:00:00.000Z");
      f.card(false);
      const native = f.calls.length;
      expect(await f.policy.change(CHANGE)).toEqual(original);
      expect(await f.policy.prepareAdmission(ORG)).toMatchObject({
        onLimit: "on-demand",
        allowPurchasedCredit: true,
        policyVersion: 1,
      });
      for (const change of [
        { cashCapMinor: 6000 },
        { authorizedPrincipal: "session:prn_other" },
        { paymentMethodId: "pm_other" },
        { termsRevision: "different-terms" },
      ])
        await expect(f.policy.change({ ...CHANGE, ...change })).rejects.toMatchObject({
          code: "reference_conflict",
          status: 409,
        });
      expect(f.calls).toHaveLength(native);
      expect(await f.snapshot()).toEqual(saved);
    } finally {
      f.db.close();
    }
  });

  test("forged capability and a seeded receipt cannot bypass provenance before lookup", async () => {
    const f = await fixture();
    try {
      await f.policy.change(CHANGE);
      const ordinary = createOrgLimitPolicy({ sql: f.sql, clock: f.clock });
      await expect(ordinary.change(CHANGE)).rejects.toMatchObject({
        code: "limit_mode_unavailable",
        status: 409,
      });
      for (const onDemand of [true, () => f.service, { ...f.service }])
        expect(() =>
          createOrgLimitPolicy({
            sql: f.sql,
            clock: f.clock,
            onDemand: onDemand as typeof f.service,
          }),
        ).toThrow();
      expect(() =>
        createOrgLimitPolicy({ sql: f.sql, clock: () => f.clock(), onDemand: f.service }),
      ).toThrow();
      const otherDb = new Database(":memory:");
      try {
        expect(() =>
          createOrgLimitPolicy({
            sql: createSqliteSql(otherDb),
            clock: f.clock,
            onDemand: f.service,
          }),
        ).toThrow();
      } finally {
        otherDb.close();
      }
      const native = f.calls.length;
      await expect(
        createOrgLimitPolicy({
          sql: {
            query: async () => {
              throw new Error("unqualified replay consulted SQL");
            },
            run: f.sql.run,
            batch: f.sql.batch,
          },
          clock: f.clock,
        }).change(CHANGE),
      ).rejects.toMatchObject({ code: "limit_mode_unavailable" });
      expect(f.calls).toHaveLength(native);
    } finally {
      f.db.close();
    }
  });

  test("closed consent arm requires explicit terms, cap and card; failed qualification stores no consent", async () => {
    const f = await fixture();
    try {
      const native = f.calls.length;
      let accessorReads = 0;
      const accessor = { ...CHANGE };
      Object.defineProperty(accessor, "paymentMethodId", {
        enumerable: true,
        get() {
          accessorReads += 1;
          throw new Error("consent validator invoked an accessor");
        },
      });
      for (const input of [
        { ...CHANGE, termsRevision: undefined },
        { ...CHANGE, paymentMethodId: undefined },
        { ...CHANGE, cashCapMinor: undefined },
        { ...CHANGE, terms: TERMS },
        { ...CHANGE, cashCapMinor: 99 },
        Object.defineProperty({ ...CHANGE }, "hiddenExtra", { value: true }),
        { ...CHANGE, [Symbol("unrecognized")]: true },
        accessor,
      ])
        await expect(f.policy.change(input as ChangeOrgOnDemandPolicy)).rejects.toThrow();
      expect(accessorReads).toBe(0);
      expect(f.calls).toHaveLength(native);
      f.card(false);
      await expect(f.policy.change(CHANGE)).rejects.toMatchObject({ status: 503 });
      expect(await f.sql.query("SELECT * FROM org_wallet_limit_policy_commands")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM org_wallet_limit_policies")).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("reservation planning never self-commits and policy stop closes a prepared original in the same batch", async () => {
    const f = await fixture();
    try {
      await f.policy.change(CHANGE);
      const planned = await f.cash.prepareReservation(
        {
          organizationId: ORG,
          reference: "noncommitted",
          policyVersion: 1,
          consentRevision: TERMS.consentRevision,
          amountMinor: 100,
        },
        AT,
      );
      expect(planned.replay).toBe(false);
      expect(await f.cash.read(ORG, "noncommitted")).toBeNull();
      const original = await f.prepared();
      const native = f.calls.length;
      for (const change of [
        { ...CHANGE, reference: "new-cap", cashCapMinor: 6000 },
        { ...CHANGE, reference: "new-card", paymentMethodId: "pm_other" },
        {
          organizationId: ORG,
          authorizedPrincipal: CHANGE.authorizedPrincipal,
          reference: "prepaid-switch",
          onLimit: "prepaid" as const,
        },
      ])
        await expect(f.policy.change(change)).rejects.toMatchObject({ status: 409 });
      expect(f.calls).toHaveLength(native);
      const dispatchWaiting = deferred(),
        releaseDispatch = deferred();
      f.gate(async (statements) => {
        if (
          statements.some((statement) =>
            statement.sql.startsWith("INSERT INTO stripe_billing_on_demand_attempts"),
          )
        ) {
          dispatchWaiting.resolve();
          await releaseDispatch.promise;
        }
      });
      const concurrentDispatch = f.firstDispatch(original.reference, original.version);
      // Attach an ordinary rejection handler before releasing the competing batch.
      const dispatchOutcome = concurrentDispatch.then(
        () => null,
        (error: unknown) => error,
      );
      await dispatchWaiting.promise;
      f.lostAck();
      const stop = {
        organizationId: ORG,
        authorizedPrincipal: CHANGE.authorizedPrincipal,
        reference: "withdraw",
        onLimit: "stop" as const,
      };
      let result: Awaited<ReturnType<typeof f.policy.change>>;
      try {
        result = await f.policy.change(stop);
      } finally {
        releaseDispatch.resolve();
      }
      expect(await dispatchOutcome).toMatchObject({ code: "constraint" });
      f.gate(undefined);
      expect(result.onLimit).toBe("stop");
      expect(await f.policy.change(stop)).toEqual(result);
      expect(
        await f.sql.query(
          "SELECT state,dispatched_at,payment_intent_id FROM stripe_billing_on_demand_commands",
        ),
      ).toEqual([{ state: "abandoned", dispatched_at: null, payment_intent_id: null }]);
      expect(
        await f.sql.query(
          "SELECT reason,observed_policy_version FROM stripe_billing_on_demand_abandonments",
        ),
      ).toEqual([{ reason: "consent-withdrawn", observed_policy_version: 2 }]);
      expect(await f.sql.query("SELECT status,source_ref FROM org_wallet_cash_exposures")).toEqual([
        { status: "released", source_ref: null },
      ]);
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_attempts")).toEqual([]);
      expect(f.calls).toHaveLength(native);
    } finally {
      f.db.close();
    }
  });

  test("first dispatch winning withdrawal retains its original reserved unknown while stop succeeds", async () => {
    const f = await fixture();
    try {
      const originalConsent = await f.policy.change(CHANGE);
      const original = await f.prepared();
      const stopWaiting = deferred(),
        releaseStop = deferred();
      f.gate(async (statements) => {
        if (
          statements.some((statement) =>
            statement.sql.startsWith("INSERT INTO org_wallet_limit_policy_commands"),
          )
        ) {
          stopWaiting.resolve();
          await releaseStop.promise;
        }
      });
      const stopping = f.policy.change({
        organizationId: ORG,
        authorizedPrincipal: CHANGE.authorizedPrincipal,
        reference: "stop-after-first",
        onLimit: "stop",
      });
      await Promise.race([stopWaiting.promise, stopping]);
      let before: Awaited<ReturnType<Sql["query"]>>,
        exposure: Awaited<ReturnType<Sql["query"]>>,
        native: number;
      try {
        await f.firstDispatch(original.reference, original.version);
        before = await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands");
        exposure = await f.sql.query("SELECT * FROM org_wallet_cash_exposures");
        native = f.calls.length;
      } finally {
        releaseStop.resolve();
      }
      await stopping;
      f.gate(undefined);
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands")).toEqual(before);
      expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual(exposure);
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_abandonments")).toEqual([]);
      expect(await f.policy.prepareAdmission(ORG)).toMatchObject({
        onLimit: "stop",
        allowPurchasedCredit: false,
      });
      const stopped = await f.snapshot();
      expect(await f.policy.change(CHANGE)).toEqual(originalConsent);
      expect(await f.policy.read(ORG)).toMatchObject({ onLimit: "stop" });
      expect(await f.snapshot()).toEqual(stopped);
      expect(await readOrgOnDemandConsent({ sql: f.sql, organizationId: ORG })).toBeNull();
      expect(f.calls).toHaveLength(native);
    } finally {
      f.db.close();
    }
  });

  test("withdrawal in a later month retains the original dispatched unknown and its cash bucket", async () => {
    const f = await fixture();
    try {
      await f.policy.change(CHANGE);
      const original = await f.prepared();
      await f.firstDispatch(original.reference, original.version);
      const before = await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands"),
        exposure = await f.sql.query("SELECT * FROM org_wallet_cash_exposures"),
        native = f.calls.length;
      f.time("2026-11-01T00:00:00.000Z");
      f.card(false);
      const stop = await f.policy.change({
        organizationId: ORG,
        authorizedPrincipal: CHANGE.authorizedPrincipal,
        reference: "withdraw-later-month",
        onLimit: "stop",
      });
      expect(stop).toMatchObject({ onLimit: "stop", periodStart: "2026-11-01T00:00:00.000Z" });
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands")).toEqual(before);
      expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual(exposure);
      expect(exposure[0]).toMatchObject({
        status: "reserved",
        period_start: "2026-10-01T00:00:00.000Z",
        period_end: "2026-11-01T00:00:00.000Z",
      });
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_abandonments")).toEqual([]);
      expect(f.calls).toHaveLength(native);
    } finally {
      f.db.close();
    }
  });
});
