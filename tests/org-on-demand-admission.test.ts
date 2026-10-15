import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { createLedger } from "../src/ledger.ts";
import {
  createOrgBilling,
  readOrgBillingFreshAdmissionOrigin,
  type UsageInput,
} from "../src/org-billing.ts";
import { createOrgLimitPolicy } from "../src/org-limit-policy.ts";
import { parseOrgOnDemandTerms } from "../src/org-on-demand-terms.ts";
import type { Sql, SqlStatement } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";
import { createStripeOnDemand } from "../src/stripe-on-demand.ts";

const ORG = "org_fresh_admission";
const CUSTOMER = "cus_fresh_admission";
const METHOD = "pm_fresh_admission";
const AT = "2026-10-15T12:00:00.000Z";
const HOLD = {
  organizationId: ORG,
  reference: "hold-1",
  workspaceRef: "ws_fresh",
  amountMicros: 10_000,
  pricingRevision: "fresh-r1",
  measurementFingerprint: "quote-original",
};
const USAGE: UsageInput = {
  organizationId: ORG,
  reference: "usage-1",
  workspaceRef: "ws_usage",
  meter: "requests",
  quantity: "1",
  quantityUnit: "request",
  periodStart: "2026-10-15T11:00:00.000Z",
  periodEnd: AT,
  pricingRevision: "fresh-r1",
  expectedMicros: 10_000,
  measurementFingerprint: "closed-original",
};

async function fixture() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  const base = createSqliteSql(db);
  let at = AT;
  let afterPrepare: (() => Promise<void>) | undefined;
  let afterFunding: (() => Promise<void>) | undefined;
  const sql: Sql = {
    query: (statement, params) => base.query(statement, params),
    run: (statement, params) => base.run(statement, params),
    async batch(statements: readonly SqlStatement[]) {
      const result = await base.batch(statements);
      if (
        afterPrepare &&
        statements.some((statement) =>
          /INSERT\s+INTO\s+stripe_billing_on_demand_commands/u.test(statement.sql),
        )
      ) {
        const next = afterPrepare;
        afterPrepare = undefined;
        await next();
      }
      if (
        afterFunding &&
        statements.some((statement) =>
          /INSERT\s+INTO\s+stripe_billing_on_demand_funding/u.test(statement.sql),
        )
      ) {
        const next = afterFunding;
        afterFunding = undefined;
        await next();
      }
      return result;
    },
  };
  const clock = () => new Date(at);
  await sql.run("INSERT INTO stripe_mode_realm VALUES(1,'test',?)", [AT]);
  await sql.run(
    "INSERT INTO stripe_billing_account_realms VALUES(1,'acct_freshadmission','test','fresh-test',?)",
    [AT],
  );
  await sql.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,?,?,?)", [
    ORG,
    "Fresh admission",
    "principal_fresh",
    AT,
  ]);
  await sql.run("INSERT INTO stripe_billing_customers VALUES(?,?,?)", [ORG, CUSTOMER, AT]);
  const native = new Map<string, Record<string, unknown>>();
  const posts: URLSearchParams[] = [];
  const gets: string[] = [];
  let hideOriginal = false,
    loseAck = false,
    cardAvailable = true;
  const client = createStripeBillingClient({
    secretKey: "sk_test_fresh_admission_fixture",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET") {
        gets.push(url.pathname);
        if (url.pathname === "/v1/account")
          return Response.json({ id: "acct_freshadmission", object: "account" });
        if (url.pathname === "/v1/prices/price_fresh")
          return Response.json({
            id: "price_fresh",
            object: "price",
            livemode: false,
            currency: "usd",
            type: "recurring",
            billing_scheme: "per_unit",
            unit_amount: 1000,
            recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
          });
        if (url.pathname === `/v1/customers/${CUSTOMER}`)
          return Response.json({ id: CUSTOMER, object: "customer", livemode: false, metadata: {} });
        if (url.pathname === `/v1/payment_methods/${METHOD}` && cardAvailable)
          return Response.json({
            id: METHOD,
            object: "payment_method",
            livemode: false,
            customer: CUSTOMER,
            type: "card",
            card: { exp_month: 12, exp_year: 2030 },
          });
        if (url.pathname === "/v1/payment_intents")
          return Response.json({
            data: hideOriginal
              ? []
              : [...native.values()].filter((row) => row.object === "payment_intent"),
            has_more: false,
          });
        const value = native.get(url.pathname.split("/").at(-1) ?? "");
        return value && !hideOriginal ? Response.json(value) : new Response("", { status: 404 });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/payment_intents")
        throw new Error("Unexpected native mutation");
      const form = new URLSearchParams(await request.text());
      posts.push(form);
      const id = `pi_fresh_${posts.length}`,
        chargeId = `ch_fresh_${posts.length}`;
      const amount = Number(form.get("amount"));
      const metadata = Object.fromEntries(
        [...form]
          .filter(([key]) => key.startsWith("metadata["))
          .map(([key, value]) => [key.slice(9, -1), value]),
      );
      const intent = {
        id,
        object: "payment_intent",
        livemode: false,
        status: "succeeded",
        customer: CUSTOMER,
        payment_method: METHOD,
        currency: "usd",
        amount,
        amount_received: amount,
        amount_capturable: 0,
        latest_charge: chargeId,
        metadata,
      };
      native.set(id, intent);
      native.set(chargeId, {
        id: chargeId,
        object: "charge",
        livemode: false,
        payment_intent: id,
        payment_method: METHOD,
        payment_method_details: { type: "card" },
        customer: CUSTOMER,
        currency: "usd",
        amount,
        amount_captured: amount,
        paid: true,
        captured: true,
        status: "succeeded",
        disputed: false,
        amount_refunded: 0,
        refunded: false,
      });
      if (loseAck) {
        loseAck = false;
        throw new Error("Lost native acknowledgement");
      }
      return Response.json(intent);
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: "acct_freshadmission", mode: "test", billingAuthority: "fresh-test" },
    prices: [{ priceId: "price_fresh", monthlyAmountMinor: 1000 }],
  });
  const config = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "fresh-r1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: 0,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {
        requests: { unit: "request", rate: { numeratorMicros: "10000", denominator: "1" } },
      },
    }),
  );
  if (!config) throw new Error("Missing billing config");
  const terms = parseOrgOnDemandTerms({
    termsRevision: "fresh-terms-r1",
    consentRevision: "fresh-consent-r1",
    currency: "USD",
    validity: { validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z" },
    replenishment: {
      trigger: "eligible-credit-deficit",
      rule: "ceil-deficit-to-quantum-with-minimum",
      fundingQuantumMinor: 25,
      minimumChargeMinor: 50,
      maximumChargeMinor: 1000,
    },
    cashCapBounds: { minimumMinor: 1, maximumMinor: 10000 },
    purchaseCreditExpiry: { kind: "fixed-duration", seconds: 86400 },
  });
  const store = createStripeBillingStore({ sql, clock });
  const service = await createStripeOnDemand({
    sql,
    clock,
    client,
    realm,
    store,
    billingConfig: config,
    terms,
  });
  const policy = createOrgLimitPolicy({ sql, clock, onDemand: service });
  const ledger = createLedger(sql, clock);
  const makeBilling = (funding = true) =>
    createOrgBilling({
      sql,
      clock,
      ledger,
      config: JSON.parse(JSON.stringify(config)),
      limitPolicy: policy,
      hostedPaidFreeExclusion: true,
      requireWorkspaceAttribution: true,
      ...(funding ? { admissionFunding: service } : {}),
    });
  return {
    db,
    sql,
    clock,
    config,
    service,
    policy,
    ledger,
    posts,
    gets,
    makeBilling,
    billing: makeBilling(),
    async consent() {
      await policy.change({
        organizationId: ORG,
        reference: "consent-1",
        authorizedPrincipal: "session:principal_fresh",
        onLimit: "on-demand",
        cashCapMinor: 10000,
        termsRevision: terms.termsRevision,
        consentRevision: terms.consentRevision,
        paymentMethodId: METHOD,
      });
    },
    afterPrepare(action: () => Promise<void>) {
      afterPrepare = action;
    },
    afterFunding(action: () => Promise<void>) {
      afterFunding = action;
    },
    loseAck() {
      loseAck = true;
      hideOriginal = true;
    },
    setTime(value: string) {
      at = value;
    },
    disableCard() {
      cardAvailable = false;
    },
  };
}

describe("genuine OrgBilling fund-before-admit boundary", () => {
  test("fresh hold and measured usage fund their real local receipt once", async () => {
    for (const namespace of ["hold", "usage"] as const) {
      const f = await fixture();
      await f.consent();
      const receipt =
        namespace === "hold" ? await f.billing.hold(HOLD) : await f.billing.usage(USAGE);
      expect(receipt).toMatchObject({
        status: namespace === "hold" ? "live" : "paid",
        amountMicros: 10_000,
      });
      expect(f.posts).toHaveLength(1);
      const commands = await f.sql.query(
        "SELECT admission_json FROM stripe_billing_on_demand_commands",
      );
      const origin = JSON.parse(String(commands[0]?.admission_json));
      expect(origin.namespace).toBe(namespace === "hold" ? "org-hold" : "org-usage");
      expect(origin.fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/u);
      expect(origin.receiptFingerprint).toBe(
        namespace === "hold"
          ? JSON.stringify([10_000, "fresh-r1", "quote-original", { workspaceRef: "ws_fresh" }])
          : JSON.stringify([
              "requests",
              "1",
              "request",
              USAGE.periodStart,
              USAGE.periodEnd,
              "fresh-r1",
              10_000,
              "closed-original",
              { workspaceRef: "ws_usage" },
            ]),
      );
      expect(
        await f.sql.query(
          "SELECT workspace_ref FROM org_wallet_workspace_bindings WHERE org_id=?",
          [ORG],
        ),
      ).toEqual([{ workspace_ref: namespace === "hold" ? "ws_fresh" : "ws_usage" }]);
      const replay =
        namespace === "hold" ? await f.billing.hold(HOLD) : await f.billing.usage(USAGE);
      expect(replay).toEqual(receipt);
      expect(f.posts).toHaveLength(1);
      f.db.close();
    }
  });

  test("accepted receipt wins after withdrawal and card loss; capture/release never charge", async () => {
    const f = await fixture();
    await f.consent();
    const accepted = await f.billing.hold(HOLD);
    await f.policy.change({
      organizationId: ORG,
      reference: "stop",
      authorizedPrincipal: "session:principal_fresh",
      onLimit: "stop",
    });
    f.disableCard();
    const reads = f.gets.length;
    expect(await f.billing.hold(HOLD)).toEqual(accepted);
    expect(
      await f.billing.capture({
        organizationId: ORG,
        reference: HOLD.reference,
        amountMicros: 10_000,
        actualMicros: "10000",
        measurementFingerprint: "capture-original",
      }),
    ).toMatchObject({ status: "captured" });
    expect(await f.billing.release(ORG, HOLD.reference)).toMatchObject({ status: "captured" });
    expect(f.gets.length).toBe(reads);
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });

  test("zero work and accepted pending usage never invoke fresh cash", async () => {
    const f = await fixture();
    await f.consent();
    expect(await f.billing.hold({ ...HOLD, reference: "zero", amountMicros: 0 })).toMatchObject({
      status: "live",
    });
    const pending = await f.makeBilling(false).usage(USAGE);
    expect(pending.status).toBe("pending");
    expect(await f.billing.usage(USAGE)).toEqual(pending);
    expect(f.posts).toHaveLength(0);
    expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands")).toEqual([]);
    f.db.close();
  });

  test("unknown ACK remains original across month rollover without another POST", async () => {
    const f = await fixture();
    await f.consent();
    f.loseAck();
    await expect(f.billing.hold(HOLD)).rejects.toMatchObject({ code: "on_demand_pending" });
    f.setTime("2026-11-01T00:00:00.000Z");
    await expect(f.billing.hold(HOLD)).rejects.toMatchObject({ code: "on_demand_pending" });
    expect(f.posts).toHaveLength(1);
    expect(await f.sql.query("SELECT status,period_start FROM org_wallet_cash_exposures")).toEqual([
      { status: "reserved", period_start: "2026-10-01T00:00:00.000Z" },
    ]);
    expect(await f.sql.query("SELECT * FROM org_wallet_holds")).toEqual([]);
    f.db.close();
  });

  test("a funding race removes the real deficit before native dispatch", async () => {
    const f = await fixture();
    await f.consent();
    f.afterPrepare(async () => {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "other-funding",
        kind: "purchased",
        amountMicros: 20_000,
        consumptionClass: "purchased",
      });
    });
    expect(await f.billing.hold(HOLD)).toMatchObject({ status: "live" });
    expect(f.posts).toHaveLength(0);
    expect(await f.sql.query("SELECT state FROM stripe_billing_on_demand_commands")).toEqual([
      { state: "abandoned" },
    ]);
    f.db.close();
  });

  test("paid funding followed by policy withdrawal never starts a second cash loop", async () => {
    const f = await fixture();
    await f.consent();
    f.afterFunding(async () => {
      await f.policy.change({
        organizationId: ORG,
        reference: "withdraw-after-paid",
        authorizedPrincipal: "session:principal_fresh",
        onLimit: "stop",
      });
    });
    await expect(f.billing.hold(HOLD)).rejects.toMatchObject({ code: "insufficient_funds" });
    expect(f.posts).toHaveLength(1);
    expect(await f.sql.query("SELECT status FROM org_wallet_cash_exposures")).toEqual([
      { status: "paid" },
    ]);
    expect(await f.sql.query("SELECT * FROM org_wallet_holds")).toEqual([]);
    f.db.close();
  });

  test("mutating caller options after an admission starts cannot redirect a genuine origin", async () => {
    const f = await fixture();
    await f.consent();
    const options = {
      sql: f.sql,
      clock: f.clock,
      ledger: f.ledger,
      config: f.config,
      limitPolicy: f.policy,
      hostedPaidFreeExclusion: true,
      requireWorkspaceAttribution: true,
      admissionFunding: f.service,
    };
    const billing = createOrgBilling(options);
    const leaked: unknown[] = [];
    const pending = billing.hold(HOLD);
    options.admissionFunding = {
      ...f.service,
      async beforeNewAdmission(token: unknown) {
        leaked.push(
          readOrgBillingFreshAdmissionOrigin(token, {
            sql: f.sql,
            clock: f.clock,
            billingConfig: f.config,
          }),
        );
        throw new Error("Unqualified replacement received a genuine origin");
      },
    };
    expect(await pending).toMatchObject({ status: "live", amountMicros: 10_000 });
    expect(f.posts).toHaveLength(1);
    expect(leaked).toEqual([]);
    f.db.close();
  });

  test("casts, copied persisted admission labels and unrelated clocks cannot mint fresh authority", async () => {
    const f = await fixture();
    await f.consent();
    expect(() =>
      readOrgBillingFreshAdmissionOrigin(
        { namespace: "org-hold", organizationId: ORG, reference: HOLD.reference },
        { sql: f.sql, clock: f.clock, billingConfig: f.config },
      ),
    ).toThrow();
    expect(() =>
      createOrgBilling({
        sql: f.sql,
        clock: () => f.clock(),
        ledger: f.ledger,
        config: f.config,
        admissionFunding: f.service,
      }),
    ).toThrow();
    await f.billing.hold(HOLD);
    const rows = await f.sql.query("SELECT admission_json FROM stripe_billing_on_demand_commands");
    await expect(
      f.service.beforeNewAdmission(JSON.parse(String(rows[0]?.admission_json))),
    ).rejects.toMatchObject({ code: "billing_unavailable" });
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });
});
