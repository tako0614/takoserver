import type { Database } from "bun:sqlite";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import type { Sql } from "../src/ports.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  type StripeOnDemandCardExpected,
  type StripeOnDemandFundingExpected,
  type StripeOnDemandVerificationContext,
  StripeOnDemandVerificationError,
  verifyStripeOnDemandCard,
  verifyStripeOnDemandFunding,
} from "../src/stripe-on-demand-verification.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

const AT = "2026-10-15T00:00:00.000Z";
const CUSTOMER = "cus_verifier_fixture";
const METHOD = "pm_verifier_fixture";
const ACCOUNT = "acct_verifierfixture";
const MARKER = "fixture_private_native_value";
const CARD: StripeOnDemandCardExpected = {
  organizationId: "org_verifier",
  customerId: CUSTOMER,
  paymentMethodId: METHOD,
  verifiedAt: AT,
};
function customer() {
  return { id: CUSTOMER, object: "customer", livemode: false, metadata: {} };
}
function method() {
  return {
    id: METHOD,
    object: "payment_method",
    livemode: false,
    customer: CUSTOMER,
    type: "card",
    card: { exp_month: 10, exp_year: 2026, last4: MARKER, fingerprint: MARKER },
    billing_details: { name: MARKER },
    metadata: { private: MARKER },
  };
}
function setup() {
  return {
    id: "seti_verifier_fixture",
    object: "setup_intent",
    livemode: false,
    status: "succeeded",
    usage: "off_session",
    customer: CUSTOMER,
    payment_method: METHOD,
    client_secret: MARKER,
    metadata: {},
  };
}
function funding() {
  const expected: StripeOnDemandFundingExpected = {
    organizationId: "org_verifier",
    reference: "cash-command-original",
    fingerprint: "sha256:fixture-original",
    fundingRef: "on-demand:original",
    accountId: ACCOUNT,
    mode: "test",
    financialRealm: "realm:fixture",
    billingAuthority: "operator-fixture",
    customerId: CUSTOMER,
    paymentMethodId: METHOD,
    paymentIntentId: "pi_verifier_fixture",
    chargeId: "ch_verifier_fixture",
    currency: "USD",
    amountMinor: 1234,
    observedAt: AT,
    metadata: {
      organizationId: "org_verifier",
      reference: "cash-command-original",
      fingerprint: "sha256:fixture-original",
      stripeAccountId: ACCOUNT,
      financialRealm: "realm:fixture",
      billingAuthority: "operator-fixture",
      fundingRef: "on-demand:original",
    },
  };
  const paymentIntent: Record<string, unknown> = {
    id: expected.paymentIntentId,
    object: "payment_intent",
    livemode: false,
    status: "succeeded",
    customer: CUSTOMER,
    payment_method: METHOD,
    currency: "usd",
    amount: expected.amountMinor,
    amount_received: expected.amountMinor,
    amount_capturable: 0,
    latest_charge: expected.chargeId,
    invoice: null,
    metadata: { ...expected.metadata, unrelated: MARKER },
    client_secret: MARKER,
  };
  const charge: Record<string, unknown> = {
    id: expected.chargeId,
    object: "charge",
    livemode: false,
    payment_intent: expected.paymentIntentId,
    payment_method: METHOD,
    payment_method_details: { type: "card", card: { last4: MARKER } },
    customer: CUSTOMER,
    currency: "usd",
    amount: expected.amountMinor,
    amount_captured: expected.amountMinor,
    paid: true,
    captured: true,
    status: "succeeded",
    disputed: false,
    invoice: null,
    amount_refunded: 0,
    refunded: false,
    billing_details: { name: MARKER },
    failure_message: MARKER,
  };
  return { expected, paymentIntent, charge };
}

let db: Database;
let baseSql: Sql;
let context: StripeOnDemandVerificationContext;
let resources: Map<string, unknown>;
let requests: Request[];
let writes = 0;
let duringRead: ((path: string) => Promise<void>) | undefined;

beforeAll(async () => {
  const fixture = await createHostedBillingRealmTestDatabase();
  db = fixture.db;
  baseSql = fixture.sql;
  await seedHostedBillingRealmTestPin(baseSql, {
    accountId: ACCOUNT,
    billingAuthority: "operator-fixture",
  });
  const sql: Sql = {
    query: (...args) => baseSql.query(...args),
    run: (...args) => {
      writes++;
      return baseSql.run(...args);
    },
    batch: (...args) => {
      writes++;
      return baseSql.batch(...args);
    },
  };
  const client = createStripeBillingClient({
    secretKey: "sk_test_verification_fixture_not_a_credential",
    fetch: async (request) => {
      requests.push(request.clone());
      expect(request.method).toBe("GET");
      const path = new URL(request.url).pathname;
      if (path === "/v1/account") return Response.json({ id: ACCOUNT, object: "account" });
      if (path === "/v1/prices/price_verifier")
        return Response.json({
          id: "price_verifier",
          object: "price",
          livemode: false,
          currency: "usd",
          type: "recurring",
          active: true,
          billing_scheme: "per_unit",
          unit_amount: 1000,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      await duringRead?.(path);
      const value = resources.get(path);
      return value === undefined ? new Response("", { status: 404 }) : Response.json(value);
    },
  });
  requests = [];
  resources = new Map();
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: ACCOUNT, mode: "test", billingAuthority: "operator-fixture" },
    prices: [{ priceId: "price_verifier", monthlyAmountMinor: 1000 }],
  });
  context = { sql, client, realm };
  await baseSql.run(
    "INSERT INTO stripe_billing_customers (org_id, customer_id, created_at) VALUES (?, ?, ?)",
    [CARD.organizationId, CUSTOMER, AT],
  );
});
afterAll(() => db?.close());
beforeEach(async () => {
  requests = [];
  writes = 0;
  duringRead = undefined;
  resources = new Map([
    [`/v1/customers/${CUSTOMER}`, customer()],
    [`/v1/payment_methods/${METHOD}`, method()],
    ["/v1/setup_intents/seti_verifier_fixture", setup()],
  ]);
  await baseSql.run("UPDATE stripe_billing_customers SET customer_id=? WHERE org_id=?", [
    CUSTOMER,
    CARD.organizationId,
  ]);
});

describe("same-client saved card qualification", () => {
  test("uses the owning association and genuine reads, with optional SI and no merchant consent", async () => {
    const proof = await verifyStripeOnDemandCard(context, CARD);
    expect(proof).toEqual({
      kind: "stripe-saved-card",
      organizationId: CARD.organizationId,
      customerId: CUSTOMER,
      paymentMethodId: METHOD,
      setupIntentId: null,
      accountId: ACCOUNT,
      mode: "test",
      financialRealm: context.realm.financialRealm,
      billingAuthority: "operator-fixture",
      verifiedAt: AT,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(JSON.stringify(proof)).not.toContain(MARKER);
    expect(Object.keys(proof)).not.toContain("consentRevision");
    expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
      `/v1/customers/${CUSTOMER}`,
      `/v1/payment_methods/${METHOD}`,
      `/v1/customers/${CUSTOMER}`,
    ]);
    expect(writes).toBe(0);
    requests = [];
    const withSetup = await verifyStripeOnDemandCard(context, {
      ...CARD,
      setupIntentId: "seti_verifier_fixture",
    });
    expect(withSetup.setupIntentId).toBe("seti_verifier_fixture");
    expect(
      requests.some((request) => request.url.endsWith("/setup_intents/seti_verifier_fixture")),
    ).toBe(true);
    expect(writes).toBe(0);
  });

  test("treats a card as unexpired through its UTC expiration month only", async () => {
    expect(
      (await verifyStripeOnDemandCard(context, { ...CARD, verifiedAt: "2026-10-31T23:59:59.999Z" }))
        .paymentMethodId,
    ).toBe(METHOD);
    await expect(
      verifyStripeOnDemandCard(context, { ...CARD, verifiedAt: "2026-11-01T00:00:00.000Z" }),
    ).rejects.toMatchObject({ code: "card_unavailable" });
  });

  test.each([
    { customer: null },
    { customer: "cus_other" },
    { type: "sepa_debit" },
    { card: null },
    { deleted: true },
    { card: { exp_month: 9, exp_year: 2026 } },
    { card: { exp_month: 13, exp_year: 2027 } },
    { card: { exp_month: "10", exp_year: 2027 } },
    { card: { exp_month: 1, exp_year: 2027.5 } },
    { account: "acct_other" },
    { on_behalf_of: "acct_other" },
    { application: "ca_other" },
    { transfer_data: { destination: "acct_other" } },
    { application_fee_amount: 0 },
  ])("rejects detached, expired, malformed or contradictory saved cards", async (extra) => {
    resources.set(`/v1/payment_methods/${METHOD}`, { ...method(), ...extra });
    await expect(verifyStripeOnDemandCard(context, CARD)).rejects.toMatchObject({
      code: "card_unavailable",
    });
    expect(writes).toBe(0);
  });

  test("rejects missing/wrong-mode native PMs and a foreign Org before card retrieval", async () => {
    resources.delete(`/v1/payment_methods/${METHOD}`);
    await expect(verifyStripeOnDemandCard(context, CARD)).rejects.toMatchObject({
      code: "card_unavailable",
    });
    resources.set(`/v1/payment_methods/${METHOD}`, { ...method(), livemode: true });
    await expect(verifyStripeOnDemandCard(context, CARD)).rejects.toMatchObject({
      code: "unavailable",
    });
    requests = [];
    await expect(
      verifyStripeOnDemandCard(context, { ...CARD, organizationId: "org_foreign" }),
    ).rejects.toMatchObject({ code: "customer_unavailable" });
    expect(requests).toHaveLength(0);
  });

  test("rejects cloned realms and different SQL/client origins without any native read", async () => {
    for (const changed of [
      { ...context, realm: { ...context.realm } },
      { ...context, sql: { ...context.sql } },
      { ...context, client: { ...context.client } },
    ])
      await expect(verifyStripeOnDemandCard(changed, CARD)).rejects.toMatchObject({
        code: "unqualified_realm",
      });
    expect(requests).toHaveLength(0);
  });

  test.each([
    { status: "requires_action" },
    { status: "canceled" },
    { usage: "on_session" },
    { customer: "cus_other" },
    { payment_method: "pm_other" },
    { attach_to_self: true },
    { account: "acct_other" },
    { on_behalf_of: "acct_other" },
  ])("checks optional SI provenance against the exact customer and PM", async (extra) => {
    resources.set("/v1/setup_intents/seti_verifier_fixture", { ...setup(), ...extra });
    await expect(
      verifyStripeOnDemandCard(context, { ...CARD, setupIntentId: "seti_verifier_fixture" }),
    ).rejects.toMatchObject({ code: "invalid_setup" });
  });

  test("captures expected inputs and detects customer/association drift across asynchronous reads", async () => {
    const expected = { ...CARD };
    duringRead = async (path) => {
      if (path.includes("payment_methods")) {
        expected.customerId = "cus_changed";
        expected.paymentMethodId = "pm_changed";
        expected.verifiedAt = "2026-11-01T00:00:00.000Z";
      }
    };
    expect((await verifyStripeOnDemandCard(context, expected)).customerId).toBe(CUSTOMER);
    duringRead = async (path) => {
      if (path.includes("payment_methods"))
        await baseSql.run(
          "UPDATE stripe_billing_customers SET customer_id='cus_drift' WHERE org_id=?",
          [CARD.organizationId],
        );
    };
    await expect(verifyStripeOnDemandCard(context, CARD)).rejects.toMatchObject({
      code: "customer_unavailable",
    });
    expect(writes).toBe(0);
  });

  test("redacts native failures and validates original IDs/time before any lookup", async () => {
    duringRead = async () => {
      throw new Error(MARKER);
    };
    const failure: unknown = await verifyStripeOnDemandCard(context, CARD).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(StripeOnDemandVerificationError);
    expect(String(failure)).not.toContain(MARKER);
    expect(JSON.stringify(failure)).not.toContain(MARKER);
    requests = [];
    for (const extra of [
      { paymentMethodId: "pm_a/../other" },
      { verifiedAt: "2026-10-15" },
      { setupIntentId: "pi_wrong" },
    ])
      await expect(verifyStripeOnDemandCard(context, { ...CARD, ...extra })).rejects.toMatchObject({
        code: "invalid_expected",
      });
    expect(requests).toHaveLength(0);
  });
});

describe("pure original on-demand funding proof", () => {
  test("returns only immutable closed source fields and actual face value without looking up current card/consent", () => {
    const { expected, ...objects } = funding();
    const proof = verifyStripeOnDemandFunding(expected, objects);
    const { metadata: _, ...original } = expected;
    expect(proof).toEqual({
      ...original,
      kind: "stripe-on-demand-funding",
      sourceType: "payment-intent",
      refundedAmountMinor: 0,
    });
    expect(Object.isFrozen(proof)).toBe(true);
    expect(JSON.stringify(proof)).not.toContain(MARKER);
    expect(Object.keys(proof)).not.toContain("client_secret");
    expect(requests).toHaveLength(0);
    expect(writes).toBe(0);
  });

  test.each([0, 1, 1234])(
    "keeps original source and gross cash with %i refunded cents",
    (refunded) => {
      const { expected, paymentIntent, charge } = funding();
      charge.amount_refunded = refunded;
      charge.refunded = refunded === expected.amountMinor;
      expect(verifyStripeOnDemandFunding(expected, { paymentIntent, charge })).toMatchObject({
        amountMinor: 1234,
        refundedAmountMinor: refunded,
        paymentIntentId: expected.paymentIntentId,
        chargeId: expected.chargeId,
        fundingRef: expected.fundingRef,
      });
      expect(requests).toHaveLength(0);
    },
  );

  test.each([
    { status: "requires_action" },
    { status: "canceled" },
    { livemode: true },
    { customer: "cus_other" },
    { payment_method: "pm_other" },
    { latest_charge: "ch_other" },
    { currency: "eur" },
    { amount: 1233 },
    { amount_received: 1233 },
    { amount_capturable: 1 },
    { invoice: "in_other" },
    { application: "ca_other" },
    { on_behalf_of: "acct_other" },
    { transfer_data: { destination: "acct_other" } },
    { object: "setup_intent" },
  ])("rejects nonterminal or mismatched original PaymentIntents", (extra) => {
    const { expected, paymentIntent, charge } = funding();
    expect(() =>
      verifyStripeOnDemandFunding(expected, {
        paymentIntent: { ...paymentIntent, ...extra },
        charge,
      }),
    ).toThrow("invalid_funding");
  });

  test.each([
    { id: "ch_other" },
    { object: "payment_intent" },
    { payment_intent: "pi_other" },
    { payment_method: "pm_other" },
    { customer: "cus_other" },
    { livemode: true },
    { amount: 1233 },
    { amount_captured: 1233 },
    { currency: "eur" },
    { captured: false },
    { paid: false },
    { status: "failed" },
    { disputed: true },
    { invoice: "in_other" },
    { amount_refunded: -1 },
    { amount_refunded: 1235 },
    { amount_refunded: 0.5 },
    { refunded: true },
    { payment_method_details: { type: "sepa_debit" } },
    { account: "acct_other" },
    { application_fee: "fee_other" },
    { transfer: "tr_other" },
    { destination: "acct_other" },
  ])("rejects a foreign, partial, routing-ambiguous or inconsistent original Charge", (extra) => {
    const { expected, paymentIntent, charge } = funding();
    expect(() =>
      verifyStripeOnDemandFunding(expected, { paymentIntent, charge: { ...charge, ...extra } }),
    ).toThrow("invalid_funding");
  });

  test("checks an expanded latest_charge as well as the separately retrieved original", () => {
    const { expected, paymentIntent, charge } = funding();
    paymentIntent.latest_charge = { ...charge };
    expect(verifyStripeOnDemandFunding(expected, { paymentIntent, charge }).chargeId).toBe(
      expected.chargeId,
    );
    paymentIntent.latest_charge = { ...charge, customer: "cus_other" };
    expect(() => verifyStripeOnDemandFunding(expected, { paymentIntent, charge })).toThrow(
      "invalid_funding",
    );
  });

  test("rejects refunded consideration regression between native Charge observations", () => {
    const { expected, paymentIntent, charge } = funding();
    paymentIntent.latest_charge = {
      ...charge,
      amount_refunded: expected.amountMinor,
      refunded: true,
    };
    expect(() => verifyStripeOnDemandFunding(expected, { paymentIntent, charge })).toThrow(
      "invalid_funding",
    );
  });

  test.each(["separate", "expanded"])(
    "rejects source_transfer on the %s original Charge",
    (location) => {
      const { expected, paymentIntent, charge } = funding();
      if (location === "separate") charge.source_transfer = "tr_foreign_fixture";
      else paymentIntent.latest_charge = { ...charge, source_transfer: "tr_foreign_fixture" };
      expect(() => verifyStripeOnDemandFunding(expected, { paymentIntent, charge })).toThrow(
        "invalid_funding",
      );
    },
  );

  test.each([
    [0, 1],
    [0, 1234],
    [1, 1],
    [1234, 1234],
  ])("preserves monotonic refunded consideration from %i to %i", (expanded, separate) => {
    const { expected, paymentIntent, charge } = funding();
    paymentIntent.latest_charge = {
      ...charge,
      amount_refunded: expanded,
      refunded: expanded === expected.amountMinor,
    };
    charge.amount_refunded = separate;
    charge.refunded = separate === expected.amountMinor;
    expect(
      verifyStripeOnDemandFunding(expected, { paymentIntent, charge }).refundedAmountMinor,
    ).toBe(separate);
  });

  test("requires each frozen metadata binding and ignores unrelated native metadata in the receipt", () => {
    for (const key of [
      "organizationId",
      "reference",
      "fingerprint",
      "stripeAccountId",
      "financialRealm",
      "billingAuthority",
      "fundingRef",
    ]) {
      const { expected, paymentIntent, charge } = funding();
      paymentIntent.metadata = { ...expected.metadata, [key]: "contradictory" };
      expect(() => verifyStripeOnDemandFunding(expected, { paymentIntent, charge })).toThrow(
        "invalid_funding",
      );
    }
    const { expected, paymentIntent, charge } = funding();
    const { fundingRef: _, ...withoutFundingRef } = expected.metadata;
    expect(() =>
      verifyStripeOnDemandFunding(
        { ...expected, metadata: withoutFundingRef } as StripeOnDemandFundingExpected,
        { paymentIntent, charge },
      ),
    ).toThrow("invalid_expected");
    // Frozen data properties need not be enumerable; all seven must still match.
    Object.defineProperty(expected.metadata, "reference", { enumerable: false });
    paymentIntent.metadata = { ...expected.metadata, reference: "other" };
    expect(() => verifyStripeOnDemandFunding(expected, { paymentIntent, charge })).toThrow(
      "invalid_funding",
    );
  });

  test("refuses invalid expected tuples and open arbitrary metadata before claiming proof", () => {
    for (const change of [
      { organizationId: "org_other" },
      { reference: "other" },
      { fingerprint: "other" },
      { accountId: "acct_other" },
      { mode: "live" },
      { currency: "EUR" },
      { amountMinor: 0 },
      { amountMinor: 1.5 },
      { amountMinor: Number.MAX_SAFE_INTEGER },
      { observedAt: "2026-02-30T00:00:00.000Z" },
      { fundingRef: "other" },
      { metadata: {} },
      { metadata: { ...funding().expected.metadata, secret: MARKER } },
    ]) {
      const { expected, paymentIntent, charge } = funding();
      expect(() =>
        verifyStripeOnDemandFunding({ ...expected, ...change } as StripeOnDemandFundingExpected, {
          paymentIntent,
          charge,
        }),
      ).toThrow("invalid_expected");
    }
  });

  test("does not expose native bodies, accessor diagnostics or card details in failures", () => {
    const { expected, paymentIntent, charge } = funding();
    Object.defineProperty(paymentIntent, "status", {
      get: () => {
        throw new Error(MARKER);
      },
      enumerable: true,
    });
    const error: unknown = (() => {
      try {
        return verifyStripeOnDemandFunding(expected, { paymentIntent, charge });
      } catch (failure) {
        return failure;
      }
    })();
    expect(error).toBeInstanceOf(StripeOnDemandVerificationError);
    expect(String(error)).not.toContain(MARKER);
    expect(JSON.stringify(error)).not.toContain(MARKER);
    expect(requests).toHaveLength(0);
    expect(writes).toBe(0);
  });
});
