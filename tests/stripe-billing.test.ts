import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { readFileSync } from "node:fs";
import { compilePricingAuthoring } from "../scripts/pricing/compile.ts";
import { buildApp } from "../src/app.ts";
import type { ExternalIdentityVerifier } from "../src/auth.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createLedger } from "../src/ledger.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { FundingReconcileReport, PaymentEvents } from "../src/payment-events.ts";
import { resolvePayment } from "../src/payment-setup.ts";
import { SqlError } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import type { SubscriptionPayments } from "../src/stripe-billing.ts";
import { createStripeBilling } from "../src/stripe-billing.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { claimFreshStripeModeRealm, type StripeMode } from "../src/stripe-mode-realm.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

const ORG = "org_billing_test";
const CUSTOMER = "cus_billing_test";
const SUBSCRIPTION = "sub_billing_test";
const PRICE = "price_month123";
const SECRET = "whsec_stripe_billing_test_secret_12345";
const KEY = "sk_test_stripe_billing_test_key_12345";
const NOW = new Date("2026-10-14T12:00:00.000Z");
const PERIOD_START = Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1_000);
const PERIOD_END = Math.floor(Date.parse("2026-11-01T00:00:00.000Z") / 1_000);
const REVISION = "candidate-r3";
const PLAN_KEY = "starter";
const INCLUDED_MINOR = 1200;
const MONTHLY_MINOR = 125;
const MICROS_PER_MINOR = 10_000;
const INCLUDED_MICROS = INCLUDED_MINOR * MICROS_PER_MINOR;

function micros(minor: number): number {
  return minor * MICROS_PER_MINOR;
}

type ObjectRecord = Record<string, unknown>;
type State = {
  customers: Map<string, ObjectRecord>;
  prices: Map<string, ObjectRecord>;
  subscriptions: Map<string, ObjectRecord>;
  invoices: Map<string, ObjectRecord>;
  charges: Map<string, ObjectRecord>;
  refunds: Map<string, ObjectRecord>;
  sessions: Map<string, ObjectRecord>;
  events: Map<string, ObjectRecord>;
  invoicePages: { readonly data: readonly ObjectRecord[]; readonly has_more: boolean }[];
  requests: Request[];
  failOnce: Set<string>;
  failAlways: Set<string>;
  nextCustomer: number;
  nextCheckout: number;
  loseCheckoutAck: boolean;
  loseCancelAck: boolean;
  sessionLines: Map<string, ObjectRecord[]>;
  checkoutPostGate?: { readonly entered: () => void; readonly resume: Promise<void> };
  mode: StripeMode;
};

function object(id: string, type: string, extra: ObjectRecord = {}): ObjectRecord {
  return { id, object: type, livemode: false, ...extra };
}

function pricing(
  revisionOrIncluded: string | number = REVISION,
  includedOrMonthly = INCLUDED_MINOR,
) {
  const revision = typeof revisionOrIncluded === "string" ? revisionOrIncluded : REVISION;
  const includedMinor =
    typeof revisionOrIncluded === "string" ? includedOrMonthly : revisionOrIncluded;
  const monthlyMinor = typeof revisionOrIncluded === "number" ? includedOrMonthly : MONTHLY_MINOR;
  const billingConfig = {
    schemaVersion: 1,
    revision,
    effectiveAt: "2026-10-01T00:00:00.000Z",
    currency: "USD",
    holdTtlSeconds: 86_400,
    freeIncludedMinor: 0,
    purchaseCreditExpiry: { kind: "none" },
    plans: { [PLAN_KEY]: { includedMinor, stripePriceId: PRICE } },
    meters: {},
  };
  const authored = {
    authoringVersion: 1,
    planIds: { free: "free", subscription: PLAN_KEY, usage: "usage" },
    billingConfig,
    checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
    stripeMonthlyReview: {
      [PLAN_KEY]: { expectedAmountMinor: monthlyMinor, currency: "USD", interval: "month" },
    },
  };
  return compilePricingAuthoring(authored);
}

function twoPlanPricing() {
  const shared = JSON.parse(
    readFileSync(new URL("../config/shared-hosted-pricing.json", import.meta.url), "utf8"),
  );
  shared.plans[0].stripePriceId = "price_final10";
  shared.plans[1].stripePriceId = "price_final50";
  const meters = Object.fromEntries(
    Object.entries(
      shared.meters as Record<
        string,
        { unit: string; cloudflareCostMicros: string; quantity: string }
      >,
    )
      .filter(([, meter]) => meter.cloudflareCostMicros !== "0")
      .map(([key, meter]) => [
        key,
        {
          unit: meter.unit,
          rate: {
            numeratorMicros: (BigInt(meter.cloudflareCostMicros) * 3n).toString(),
            denominator: meter.quantity,
          },
        },
      ]),
  );
  return compilePricingAuthoring({
    authoringVersion: 2,
    sharedPricing: shared,
    planIds: { free: "free", usage: "usage" },
    billingConfig: {
      schemaVersion: 1,
      revision: shared.revision,
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86400,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {
        "hosted-10": { includedMinor: 2000, stripePriceId: "price_final10" },
        "hosted-50": { includedMinor: 10000, stripePriceId: "price_final50" },
      },
      meters,
    },
    checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
  });
}

function setTwoPlanPrices(state: State): void {
  for (const [id, amount] of [
    ["price_final10", 1000],
    ["price_final50", 5000],
  ] as const) {
    state.prices.set(
      id,
      object(id, "price", {
        active: true,
        currency: "usd",
        type: "recurring",
        billing_scheme: "per_unit",
        unit_amount: amount,
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      }),
    );
  }
}

function subscription(overrides: ObjectRecord = {}): ObjectRecord {
  return object(SUBSCRIPTION, "subscription", {
    customer: CUSTOMER,
    metadata: {
      organizationId: ORG,
      takoserverPurpose: "hosted_subscription",
      planKey: PLAN_KEY,
      pricingRevision: REVISION,
    },
    status: "active",
    currency: "usd",
    cancel_at_period_end: false,
    current_period_start: PERIOD_START,
    current_period_end: PERIOD_END,
    items: {
      has_more: false,
      data: [{ id: "si_test", object: "subscription_item", quantity: 1, price: PRICE }],
    },
    ...overrides,
  });
}

function invoice(id: string, overrides: ObjectRecord = {}): ObjectRecord {
  return object(id, "invoice", {
    customer: CUSTOMER,
    subscription: SUBSCRIPTION,
    status: "paid",
    paid: true,
    paid_out_of_band: false,
    amount_remaining: 0,
    billing_reason: "subscription_cycle",
    subscription_details: {
      metadata: {
        organizationId: ORG,
        takoserverPurpose: "hosted_subscription",
        planKey: PLAN_KEY,
        pricingRevision: REVISION,
      },
    },
    lines: {
      has_more: false,
      data: [
        {
          id: `il_${id}`,
          object: "line_item",
          type: "subscription",
          proration: false,
          quantity: 1,
          subscription: SUBSCRIPTION,
          price: PRICE,
          period: { start: PERIOD_START, end: PERIOD_END },
        },
      ],
    },
    currency: "usd",
    amount_paid: MONTHLY_MINOR,
    total: MONTHLY_MINOR,
    total_excluding_tax: MONTHLY_MINOR,
    amount_shipping: 0,
    starting_balance: 0,
    ending_balance: 0,
    post_payment_credit_notes_amount: 0,
    pre_payment_credit_notes_amount: 0,
    charge: "ch_billing_test",
    ...overrides,
  });
}

function charge(overrides: ObjectRecord = {}): ObjectRecord {
  return object("ch_billing_test", "charge", {
    customer: CUSTOMER,
    invoice: "in_billing_test",
    currency: "usd",
    paid: true,
    status: "succeeded",
    captured: true,
    disputed: false,
    amount: MONTHLY_MINOR,
    amount_refunded: 0,
    payment_intent: "pi_billing_test",
    ...overrides,
  });
}

function initialState(mode: StripeMode = "test"): State {
  const state: State = {
    customers: new Map([
      [
        CUSTOMER,
        object(CUSTOMER, "customer", {
          metadata: { organizationId: ORG, takoserverPurpose: "hosted_subscription" },
        }),
      ],
    ]),
    prices: new Map([
      [
        PRICE,
        object(PRICE, "price", {
          active: true,
          currency: "usd",
          type: "recurring",
          billing_scheme: "per_unit",
          unit_amount: MONTHLY_MINOR,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        }),
      ],
    ]),
    subscriptions: new Map([[SUBSCRIPTION, subscription()]]),
    invoices: new Map([["in_billing_test", invoice("in_billing_test")]]),
    charges: new Map([["ch_billing_test", charge()]]),
    refunds: new Map(),
    sessions: new Map(),
    events: new Map(),
    invoicePages: [],
    requests: [],
    failOnce: new Set(),
    failAlways: new Set(),
    nextCustomer: 1,
    nextCheckout: 1,
    loseCheckoutAck: false,
    loseCancelAck: false,
    sessionLines: new Map(),
    mode,
  };
  if (mode === "live") {
    for (const records of [
      state.customers,
      state.prices,
      state.subscriptions,
      state.invoices,
      state.charges,
    ]) {
      for (const [id, record] of records) records.set(id, { ...record, livemode: true });
    }
  }
  return state;
}

function idFromPath(url: URL, collection: string): string | undefined {
  const prefix = `/v1/${collection}/`;
  return url.pathname.startsWith(prefix)
    ? decodeURIComponent(url.pathname.slice(prefix.length))
    : undefined;
}

function listPage(
  items: readonly ObjectRecord[],
  url: URL,
): { readonly data: readonly ObjectRecord[]; readonly has_more: boolean } {
  let filtered = [...items];
  for (const filter of ["charge", "payment_intent", "customer", "subscription"] as const) {
    const value = url.searchParams.get(filter);
    if (value !== null)
      filtered = filtered.filter((item) =>
        filter === "payment_intent" &&
        item.payment_intent &&
        typeof item.payment_intent === "object"
          ? (item.payment_intent as ObjectRecord).id === value
          : item[filter] === value,
      );
  }
  const cursor = url.searchParams.get("starting_after");
  if (cursor !== null) {
    const index = filtered.findIndex((item) => item.id === cursor);
    filtered = index < 0 ? [] : filtered.slice(index + 1);
  }
  const limit = Number(url.searchParams.get("limit") ?? 100);
  return { data: filtered.slice(0, limit), has_more: filtered.length > limit };
}

function fakeStripe(state: State) {
  const fetch = async (request: Request): Promise<Response> => {
    state.requests.push(request.clone());
    const url = new URL(request.url);
    const collection = url.pathname.split("/")[2] ?? "";
    if (state.failAlways.has(url.pathname) || state.failOnce.delete(url.pathname))
      return new Response("temporary Stripe outage", { status: 503 });
    const id =
      collection === "checkout" && url.pathname.startsWith("/v1/checkout/sessions/")
        ? decodeURIComponent(url.pathname.slice("/v1/checkout/sessions/".length))
        : idFromPath(url, collection);
    const lookup = (items: Map<string, ObjectRecord>, key: string | undefined) => {
      const found = key === undefined ? undefined : items.get(key);
      return found ? Response.json(found) : new Response("", { status: 404 });
    };
    if (request.method === "GET") {
      const lines = url.pathname.match(
        /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)\/line_items$/u,
      );
      if (lines?.[1]) {
        const session = state.sessions.get(lines[1]);
        if (!session) return new Response("", { status: 404 });
        return Response.json({
          object: "list",
          has_more: false,
          data: state.sessionLines.get(lines[1]) ?? [
            { id: `li_${lines[1]}`, price: { id: PRICE }, quantity: 1 },
          ],
        });
      }
      if (collection === "checkout" && url.pathname === "/v1/checkout/sessions") {
        return Response.json(listPage([...state.sessions.values()], url));
      }
      if (collection === "checkout" && id !== undefined) return lookup(state.sessions, id);
      if (collection === "customers" && id !== undefined) return lookup(state.customers, id);
      if (collection === "prices" && id !== undefined) return lookup(state.prices, id);
      if (collection === "subscriptions" && id !== undefined)
        return lookup(state.subscriptions, id);
      if (collection === "invoices" && id !== undefined) return lookup(state.invoices, id);
      if (collection === "charges" && id !== undefined) return lookup(state.charges, id);
      if (collection === "refunds" && id !== undefined) return lookup(state.refunds, id);
      if (collection === "events" && id !== undefined) return lookup(state.events, id);
      if (collection === "invoices" && state.invoicePages.length > 0)
        return Response.json(state.invoicePages.shift() ?? { data: [], has_more: false });
      if (collection === "invoices")
        return Response.json(listPage([...state.invoices.values()], url));
      if (collection === "subscriptions")
        return Response.json(listPage([...state.subscriptions.values()], url));
      if (collection === "refunds")
        return Response.json(listPage([...state.refunds.values()], url));
      return new Response("unknown fake endpoint", { status: 400 });
    }
    if (request.method === "POST") {
      const form = new URLSearchParams(await request.text());
      if (url.pathname === "/v1/customers") {
        const id = `cus_created_${state.nextCustomer++}`;
        const created = object(id, "customer", {
          livemode: state.mode === "live",
          metadata: {
            organizationId: form.get("metadata[organizationId]"),
            takoserverPurpose: form.get("metadata[takoserverPurpose]"),
          },
        });
        state.customers.set(id, created);
        return Response.json(created);
      }
      if (url.pathname === "/v1/checkout/sessions") {
        state.checkoutPostGate?.entered();
        if (state.checkoutPostGate) await state.checkoutPostGate.resume;
        const id = `cs_created_${state.nextCheckout++}`;
        const priceId = form.get("line_items[0][price]") ?? PRICE;
        const price = state.prices.get(priceId);
        const amount = Number(price?.unit_amount ?? MONTHLY_MINOR);
        let customerId = form.get("customer");
        if (!customerId) {
          customerId = `cus_created_${state.nextCustomer++}`;
          state.customers.set(
            customerId,
            object(customerId, "customer", { livemode: state.mode === "live", metadata: {} }),
          );
        }
        const created = object(id, "checkout.session", {
          livemode: state.mode === "live",
          url: `https://checkout.stripe.com/c/pay/${id}`,
          mode: form.get("mode"),
          status: "open",
          payment_status: "unpaid",
          currency: "usd",
          amount_subtotal: amount,
          amount_total: amount,
          client_reference_id: form.get("client_reference_id"),
          customer: customerId,
          subscription: null,
          invoice: null,
          after_expiration: null,
          recovered_from: null,
          metadata: {
            organizationId: form.get("metadata[organizationId]"),
            subscriptionCheckoutIntentId: form.get("metadata[subscriptionCheckoutIntentId]"),
            planKey: form.get("metadata[planKey]"),
            pricingRevision: form.get("metadata[pricingRevision]"),
            takoserverPurpose: form.get("metadata[takoserverPurpose]"),
          },
        });
        state.sessions.set(id, created);
        state.sessionLines.set(id, [{ id: `li_${id}`, price: { id: priceId }, quantity: 1 }]);
        if (state.loseCheckoutAck) {
          state.loseCheckoutAck = false;
          return new Response("lost acknowledgement", { status: 503 });
        }
        return Response.json(created);
      }
      const subscriptionId = idFromPath(url, "subscriptions");
      if (subscriptionId !== undefined) {
        const current = state.subscriptions.get(subscriptionId);
        if (!current) return new Response("", { status: 404 });
        const updated = {
          ...current,
          cancel_at_period_end: form.get("cancel_at_period_end") === "true",
          ...(form.get("cancel_at_period_end") === "false" ? { status: "active" } : {}),
          ...(form.get("cancel_at_period_end") === "true" ? { status: "active" } : {}),
        };
        state.subscriptions.set(subscriptionId, updated);
        if (state.loseCancelAck) {
          state.loseCancelAck = false;
          state.failOnce.add(url.pathname);
          return new Response("lost acknowledgement", { status: 503 });
        }
        return Response.json(updated);
      }
    }
    return new Response("unknown fake endpoint", { status: 400 });
  };
  return fetch;
}

const identity: ExternalIdentityVerifier = {
  async verify() {
    return {
      providerSubject: "stripe-billing-test",
      email: "billing@example.test",
      displayName: "Billing Test",
    };
  },
};

async function fixture(
  hostedPricing = pricing(),
  now: () => Date = () => new Date(NOW),
  mode: StripeMode = "test",
) {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  const sql = createSqliteSql(database);
  const originalPricing = hostedPricing.hostedPlanTable.plans.some(
    (plan) => plan.planId === PLAN_KEY,
  )
    ? hostedPricing
    : pricing();
  const originalPlan = originalPricing.hostedPlanTable.plans.find(
    (plan) => plan.planId === PLAN_KEY,
  );
  const originalBillingJson = originalPricing.environment.TAKOSERVER_BILLING_CONFIG;
  if (!originalBillingJson) throw new Error("missing original fixture billing config");
  const originalBilling = JSON.parse(originalBillingJson);
  if (originalPlan?.tier !== "subscription") throw new Error("missing original fixture plan");
  await claimFreshStripeModeRealm(sql, mode);
  await sql.run("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)", [
    ORG,
    "Billing Test",
    "prn_billing_test",
    NOW.toISOString(),
  ]);
  await sql.run(
    "INSERT INTO stripe_billing_customers (org_id, customer_id, created_at) VALUES (?, ?, ?)",
    [ORG, CUSTOMER, NOW.toISOString()],
  );
  await sql.run(
    `INSERT INTO stripe_subscription_checkout_intents
     (id, org_id, request_key_digest, fingerprint, plan_key, pricing_revision, price_id, price_amount_minor,
      included_minor, livemode, customer_id, state, session_id, subscription_id, created_at, updated_at)
     VALUES ('sci_historical', ?, 'historical', 'historical', ?, ?, ?, ?, ?, ?, ?, 'associated', 'cs_historical', ?, ?, ?)`,
    [
      ORG,
      PLAN_KEY,
      originalBilling.revision,
      originalPlan.stripePriceId,
      originalPlan.monthlyAmountMinor,
      originalPlan.includedCreditMinor,
      Number(mode === "live"),
      CUSTOMER,
      SUBSCRIPTION,
      NOW.toISOString(),
      NOW.toISOString(),
    ],
  );
  await sql.run(
    `INSERT INTO stripe_billing_associations
     (subscription_id, org_id, customer_id, livemode, plan_key, pricing_revision, price_id,
      price_amount_minor, included_minor, session_id, association_generation, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'cs_historical', 1, ?)`,
    [
      SUBSCRIPTION,
      ORG,
      CUSTOMER,
      Number(mode === "live"),
      PLAN_KEY,
      originalBilling.revision,
      originalPlan.stripePriceId,
      originalPlan.monthlyAmountMinor,
      originalPlan.includedCreditMinor,
      NOW.toISOString(),
    ],
  );
  const state = initialState(mode);
  const setup = resolvePayment({
    hostedPricing,
    stripeMode: mode,
    stripeSecretKey: mode === "live" ? "sk_live_stripe_billing_test_key_12345" : KEY,
    stripeWebhookSecret: SECRET,
    consoleOrigin: "https://console.example.test",
    fetch: fakeStripe(state),
  });
  if (!setup.events || !setup.settlement) throw new Error("payment setup unexpectedly disabled");
  let events: PaymentEvents | undefined;
  const app = buildApp({
    v2: TEST_TAKOFORM_V2_CONFIG,
    sql,
    objects: createMemoryObjectStore(),
    identity,
    settlement: setup.settlement,
    ...(setup.checkout ? { checkout: setup.checkout } : {}),
    paymentEvents: (context) => {
      events = setup.events?.(context);
      if (!events) throw new Error("payment events unexpectedly disabled");
      return events;
    },
    publicOrigin: "https://api.example.test",
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    clock: now,
  });
  if (!events?.subscriptions) throw new Error("subscriptions unexpectedly disabled");
  return {
    app,
    database,
    sql,
    state,
    events,
    subscriptions: events.subscriptions as SubscriptionPayments,
    reconcile: events.reconcile as () => Promise<FundingReconcileReport>,
    ledger: createLedger(sql, now),
  };
}

async function clearHistoricalSubscription(h: Awaited<ReturnType<typeof fixture>>) {
  await h.sql.run("DELETE FROM stripe_billing_associations WHERE org_id = ?", [ORG]);
  await h.sql.run("DELETE FROM stripe_subscription_checkout_intents WHERE org_id = ?", [ORG]);
}
let sequence = 0;
function event(
  type: string,
  objectId: string,
  objectType: string,
  envelopeOverrides: ObjectRecord = {},
): ObjectRecord {
  sequence += 1;
  return {
    id: `evt_billing_${sequence}`,
    object: "event",
    api_version: "2026-09-30",
    type,
    livemode: false,
    created: Math.floor(NOW.getTime() / 1_000) - 5,
    ...envelopeOverrides,
    // Event snapshots are intentionally wrong; handlers must fetch authoritative objects.
    data: {
      object: {
        id: objectId,
        object: objectType,
        livemode: envelopeOverrides.livemode ?? false,
        amount_paid: 999_999_999,
        amount: 999_999_999,
        currency: "jpy",
        customer: "cus_attacker",
        subscription: "sub_attacker",
      },
    },
  };
}

function signature(body: string): string {
  const timestamp = Math.floor(NOW.getTime() / 1_000);
  const digest = createHmac("sha256", SECRET).update(`${timestamp}.${body}`).digest("hex");
  return `t=${timestamp},v1=${digest}`;
}

async function deliver(app: { fetch(request: Request): Promise<Response> }, payload: ObjectRecord) {
  const body = JSON.stringify(payload);
  return await app.fetch(
    new Request("https://api.example.test/v1/payments/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": signature(body) },
      body,
    }),
  );
}

async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}

describe("Hosted Stripe billing service", () => {
  test("a competing plan observes the original prepared intent without invalidating or replacing it", async () => {
    const h = await fixture(twoPlanPricing());
    await clearHistoricalSubscription(h);
    setTwoPlanPrices(h.state);
    const originalRun = h.sql.run.bind(h.sql);
    let signalPersisted!: () => void;
    const persisted = new Promise<void>((resolve) => {
      signalPersisted = resolve;
    });
    let releaseInsert!: () => void;
    const resume = new Promise<void>((resolve) => {
      releaseInsert = resolve;
    });
    let pauseFirst = true;
    h.sql.run = async (statement, params) => {
      const result = await originalRun(statement, params);
      if (
        pauseFirst &&
        statement.startsWith("INSERT OR IGNORE INTO stripe_subscription_checkout_intents")
      ) {
        pauseFirst = false;
        signalPersisted();
        await resume;
      }
      return result;
    };
    const firstInput = { organizationId: ORG, reference: "prepared10", planKey: "hosted-10" };
    const first = h.subscriptions.begin(firstInput);
    await persisted;
    expect(
      await h.sql.query(
        "SELECT plan_key, state FROM stripe_subscription_checkout_intents WHERE org_id = ?",
        [ORG],
      ),
    ).toEqual([{ plan_key: "hosted-10", state: "prepared" }]);
    await expect(
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "competing50",
        planKey: "hosted-50",
      }),
    ).rejects.toThrow("subscription_checkout_pending");
    expect(
      await h.sql.query(
        "SELECT plan_key, state FROM stripe_subscription_checkout_intents WHERE org_id = ?",
        [ORG],
      ),
    ).toEqual([{ plan_key: "hosted-10", state: "session_known" }]);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    releaseInsert();
    const opened = await first;
    expect(opened.state).toBe("open");
    expect(await h.subscriptions.begin(firstInput)).toEqual(opened);
    expect(
      await h.sql.query(
        "SELECT plan_key FROM stripe_subscription_checkout_intents WHERE org_id = ?",
        [ORG],
      ),
    ).toEqual([{ plan_key: "hosted-10" }]);
  });

  test("same-reference insert race rejects the losing different plan without another Checkout POST", async () => {
    const h = await fixture(twoPlanPricing());
    await clearHistoricalSubscription(h);
    setTwoPlanPrices(h.state);
    const originalRun = h.sql.run.bind(h.sql);
    const winnerInput = { organizationId: ORG, reference: "same-reference", planKey: "hosted-10" };
    let winner: Awaited<ReturnType<SubscriptionPayments["begin"]>> | undefined;
    let inject = true;
    h.sql.run = async (statement, params) => {
      if (
        inject &&
        statement.startsWith("INSERT OR IGNORE INTO stripe_subscription_checkout_intents")
      ) {
        inject = false;
        winner = await h.subscriptions.begin(winnerInput);
      }
      return await originalRun(statement, params);
    };
    await expect(
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "same-reference",
        planKey: "hosted-50",
      }),
    ).rejects.toThrow("reference_conflict");
    if (!winner) throw new Error("Winning Checkout unexpectedly missing");
    expect(winner?.state).toBe("open");
    expect(await h.subscriptions.begin(winnerInput)).toEqual(winner);
    expect(
      await h.sql.query(
        "SELECT plan_key FROM stripe_subscription_checkout_intents WHERE org_id = ?",
        [ORG],
      ),
    ).toEqual([{ plan_key: "hosted-10" }]);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
  });

  test("keeps one cross-plan Checkout slot and replays an expired other-plan reference", async () => {
    const h = await fixture(twoPlanPricing());
    await clearHistoricalSubscription(h);
    setTwoPlanPrices(h.state);
    let signalPost!: () => void;
    const entered = new Promise<void>((resolve) => {
      signalPost = resolve;
    });
    let releasePost!: () => void;
    const resume = new Promise<void>((resolve) => {
      releasePost = resolve;
    });
    h.state.checkoutPostGate = { entered: signalPost, resume };
    const first = h.subscriptions.begin({
      organizationId: ORG,
      reference: "first10",
      planKey: "hosted-10",
    });
    await entered;
    await expect(
      h.subscriptions.begin({ organizationId: ORG, reference: "second50", planKey: "hosted-50" }),
    ).rejects.toThrow("subscription_checkout_pending");
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    expect(
      await h.sql.query(
        "SELECT plan_key, state FROM stripe_subscription_checkout_intents WHERE org_id = ?",
        [ORG],
      ),
    ).toMatchObject([{ plan_key: "hosted-10", state: "dispatched" }]);
    expect(
      await h.sql.query(
        "SELECT plan_key, price_id FROM stripe_billing_price_identity WHERE livemode = 0 ORDER BY plan_key",
      ),
    ).toEqual([
      { plan_key: "hosted-10", price_id: "price_final10" },
      { plan_key: "hosted-50", price_id: "price_final50" },
    ]);
    releasePost();
    const opened = await first;
    expect(opened.state).toBe("open");
    expect(
      await h.subscriptions.begin({
        organizationId: ORG,
        reference: "first10",
        planKey: "hosted-10",
      }),
    ).toEqual(opened);
    await expect(
      h.subscriptions.begin({ organizationId: ORG, reference: "first10", planKey: "hosted-50" }),
    ).rejects.toThrow("reference_conflict");
    const session = h.state.sessions.get(opened.id);
    if (!session) throw new Error("Checkout session unexpectedly missing");
    h.state.sessions.set(opened.id, { ...session, status: "expired" });
    const expired = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "first10",
      planKey: "hosted-10",
    });
    expect(expired).toEqual({ id: opened.id, state: "expired" });
    const second = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "second50",
      planKey: "hosted-50",
    });
    expect(second.state).toBe("open");
    expect(
      await h.subscriptions.begin({
        organizationId: ORG,
        reference: "first10",
        planKey: "hosted-10",
      }),
    ).toEqual(expired);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(2);
    expect(
      await h.sql.query(
        "SELECT plan_key, state FROM stripe_subscription_checkout_intents WHERE org_id = ? ORDER BY created_at, id",
        [ORG],
      ),
    ).toHaveLength(2);
  });
  test("selects the requested paid tier, verifies its TEST Price, and grants only the pinned invoice tier", async () => {
    const h = await fixture(twoPlanPricing());
    await clearHistoricalSubscription(h);
    h.state.prices.set(
      "price_final50",
      object("price_final50", "price", {
        active: true,
        currency: "usd",
        type: "recurring",
        billing_scheme: "per_unit",
        unit_amount: 5000,
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      }),
    );
    h.state.prices.set(
      "price_final10",
      object("price_final10", "price", {
        active: true,
        currency: "usd",
        type: "recurring",
        billing_scheme: "per_unit",
        unit_amount: 1000,
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      }),
    );
    h.state.prices.set("price_final50", {
      ...h.state.prices.get("price_final50"),
      unit_amount: 4999,
    });
    await expect(
      h.subscriptions.begin({ organizationId: ORG, reference: "final50", planKey: "hosted-50" }),
    ).rejects.toThrow("unsupported_plan");
    h.state.prices.set("price_final50", {
      ...h.state.prices.get("price_final50"),
      unit_amount: 5000,
    });
    const checkout = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "final50",
      planKey: "hosted-50",
    });
    if (checkout.state !== "open") throw new Error("Checkout unexpectedly not open");
    expect(checkout.url).toContain("checkout.stripe.com");
    const post = h.state.requests.find(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
    );
    expect(await post?.text()).toContain("price_final50");
    const revision = "hosted-20261015-container-proposed-v1";
    h.state.subscriptions.set(
      SUBSCRIPTION,
      subscription({
        metadata: {
          organizationId: ORG,
          takoserverPurpose: "hosted_subscription",
          planKey: "hosted-50",
          pricingRevision: revision,
        },
        items: {
          has_more: false,
          data: [
            { id: "si_test", object: "subscription_item", quantity: 1, price: "price_final50" },
          ],
        },
      }),
    );
    const session = h.state.sessions.get(checkout.id);
    if (!session) throw new Error("Checkout session unexpectedly missing");
    h.state.sessions.set(checkout.id, {
      ...session,
      status: "complete",
      payment_status: "paid",
      subscription: SUBSCRIPTION,
    });
    expect(
      (await deliver(h.app, event("checkout.session.completed", checkout.id, "checkout.session")))
        .status,
    ).toBe(200);
    const pinned = {
      organizationId: ORG,
      takoserverPurpose: "hosted_subscription",
      planKey: "hosted-50",
      pricingRevision: revision,
    };
    h.state.invoices.set(
      "in_billing_test",
      invoice("in_billing_test", {
        subscription_details: { metadata: pinned },
        lines: {
          has_more: false,
          data: [
            {
              id: "il_billing_test",
              object: "line_item",
              type: "subscription",
              proration: false,
              quantity: 1,
              subscription: SUBSCRIPTION,
              price: "price_final50",
              period: { start: PERIOD_START, end: PERIOD_END },
            },
          ],
        },
        amount_paid: 5000,
        total: 5000,
        total_excluding_tax: 5000,
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount: 5000 }));
    expect((await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"))).status).toBe(
      200,
    );
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(100_000_000);
    const grant = await h.sql.query(
      "SELECT amount_micros, plan_key, stripe_price_id FROM stripe_billing_grants WHERE org_id = ?",
      [ORG],
    );
    expect(grant).toMatchObject([
      { amount_micros: 100_000_000, plan_key: "hosted-50", stripe_price_id: "price_final50" },
    ]);
    h.state.prices.set("price_final50", {
      ...h.state.prices.get("price_final50"),
      active: false,
    });
    h.state.refunds.set(
      "re_final50",
      object("re_final50", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 5000,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount: 5000, amount_refunded: 5000 }));
    expect((await deliver(h.app, event("refund.updated", "re_final50", "refund"))).status).toBe(
      200,
    );
    expect(
      await h.sql.query(
        "SELECT target_revoked_micros FROM stripe_billing_refunds WHERE refund_id = ?",
        ["re_final50"],
      ),
    ).toEqual([{ target_revoked_micros: 100_000_000 }]);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(0);
  });
  test("ignores unrelated paid manual invoices and refunds without leaving reconciliation failures", async () => {
    const h = await fixture();
    const manualInvoice = "in_manual_other";
    const manualCharge = "ch_manual_other";
    const manualRefund = "re_manual_other";
    h.state.invoices.set(
      manualInvoice,
      invoice(manualInvoice, {
        customer: "cus_manual_other",
        subscription: null,
        subscription_details: null,
        billing_reason: "manual",
        charge: manualCharge,
      }),
    );
    h.state.charges.set(
      manualCharge,
      object(manualCharge, "charge", {
        customer: "cus_manual_other",
        invoice: manualInvoice,
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: MONTHLY_MINOR,
        amount_refunded: 25,
        payment_intent: "pi_manual_other",
      }),
    );
    h.state.refunds.set(
      manualRefund,
      object(manualRefund, "refund", {
        charge: manualCharge,
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );

    for (const [type, id, kind] of [
      ["invoice.paid", manualInvoice, "invoice"],
      ["refund.updated", manualRefund, "refund"],
    ] as const) {
      const payload = event(type, id, kind);
      expect((await deliver(h.app, payload)).status).toBe(200);
      expect(
        await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
          String(payload.id),
        ]),
      ).toEqual([{ outcome: "ignored" }]);
    }
    const report = await h.reconcile();
    expect(report.billing?.unresolved).toBe(0);
    expect(
      await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_reconcile_failures"),
    ).toEqual([{ count: 0 }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_refunds")).toEqual([
      { count: 0 },
    ]);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(INCLUDED_MICROS);
  });

  test("ignores unmarked foreign subscription invoices while retaining malformed hosted claims", async () => {
    const h = await fixture();
    const foreignSub = "sub_foreign_other";
    const foreignInvoice = "in_foreign_other";
    h.state.subscriptions.set(
      foreignSub,
      subscription({ id: foreignSub, customer: "cus_foreign_other", metadata: {} }),
    );
    h.state.invoices.set(
      foreignInvoice,
      invoice(foreignInvoice, {
        customer: "cus_foreign_other",
        subscription: foreignSub,
        subscription_details: { metadata: {} },
        charge: "ch_foreign_other",
      }),
    );
    const unrelated = event("invoice.paid", foreignInvoice, "invoice");
    expect((await deliver(h.app, unrelated)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(unrelated.id),
      ]),
    ).toEqual([{ outcome: "ignored" }]);
    expect((await h.reconcile()).billing?.unresolved).toBe(0);
    const ambiguousSub = "sub_ambiguous_other";
    const ambiguousInvoice = "in_ambiguous_other";
    h.state.subscriptions.set(ambiguousSub, subscription({ id: ambiguousSub, metadata: {} }));
    h.state.invoices.set(
      ambiguousInvoice,
      invoice(ambiguousInvoice, {
        subscription: ambiguousSub,
        subscription_details: { metadata: {} },
      }),
    );
    const ambiguousEvent = event("invoice.paid", ambiguousInvoice, "invoice");
    expect((await deliver(h.app, ambiguousEvent)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(ambiguousEvent.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    const malformed = "in_host_missing_pin";
    h.state.invoices.set(malformed, invoice(malformed, { subscription_details: null }));
    const hostEvent = event("invoice.paid", malformed, "invoice");
    expect((await deliver(h.app, hostEvent)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(hostEvent.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    const report = await h.reconcile();
    expect(report.billing?.unresolved).toBeGreaterThan(0);
    expect(
      await h.sql.query("SELECT source_id FROM stripe_billing_grants WHERE source_id = ?", [
        foreignInvoice,
      ]),
    ).toEqual([]);
    expect(
      await h.sql.query("SELECT source_id FROM stripe_billing_grants WHERE source_id = ?", [
        malformed,
      ]),
    ).toEqual([]);
  });

  test("defers a refund before grant when the hosted invoice pin is missing", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_billing_test",
      invoice("in_billing_test", { subscription_details: null }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));
    h.state.refunds.set(
      "re_host_missing_pin",
      object("re_host_missing_pin", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    const payload = event("refund.updated", "re_host_missing_pin", "refund");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    expect((await h.reconcile()).billing?.unresolved).toBeGreaterThan(0);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants")).toEqual([
      { count: 0 },
    ]);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(0);
  });

  test("settles a known funded grant refund after invoice and subscription markers disappear", async () => {
    const h = await fixture();
    expect((await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"))).status).toBe(
      200,
    );
    h.state.invoices.set(
      "in_billing_test",
      invoice("in_billing_test", { subscription_details: null }),
    );
    h.state.subscriptions.set(SUBSCRIPTION, subscription({ metadata: {} }));
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));
    h.state.refunds.set(
      "re_known_grant",
      object("re_known_grant", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    const payload = event("refund.updated", "re_known_grant", "refund");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(await h.sql.query("SELECT refund_id FROM stripe_billing_refunds")).toEqual([
      { refund_id: "re_known_grant" },
    ]);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(INCLUDED_MICROS - micros(240));
    expect(await h.sql.query("SELECT funding_ref FROM stripe_billing_grants")).toEqual([
      { funding_ref: "stripe:invoice:in_billing_test" },
    ]);
  });

  test("retains legacy wallet funding when its charge later points at an unrelated invoice", async () => {
    const h = await fixture();
    const sessionId = "cs_legacy_wallet";
    const chargeId = "ch_legacy_wallet";
    const invoiceId = "in_legacy_wallet_other";
    h.state.sessions.set(
      sessionId,
      object(sessionId, "checkout.session", {
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 500,
        currency: "usd",
        created: Math.floor(NOW.getTime() / 1_000),
        customer: null,
        metadata: { organizationId: ORG, takoserverPurpose: "wallet_funding" },
        payment_intent: {
          id: "pi_legacy_wallet",
          object: "payment_intent",
          livemode: false,
          status: "succeeded",
          latest_charge: chargeId,
        },
      }),
    );
    h.state.charges.set(
      chargeId,
      object(chargeId, "charge", {
        customer: null,
        invoice: null,
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: 500,
        amount_refunded: 0,
        payment_intent: "pi_legacy_wallet",
      }),
    );
    await h.sql.run(
      "INSERT INTO wallet_credit_lots (org_id, ref, kind, consumption_class, amount_micros, expires_at, created_at) VALUES (?, ?, 'direct', 'purchased', ?, NULL, ?)",
      [ORG, `stripe:${sessionId}`, micros(500), NOW.toISOString()],
    );
    await h.sql.run(
      "INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at) VALUES (?, ?, 'funding', ?, ?, 0, ?)",
      ["led_legacy_wallet", ORG, `stripe:${sessionId}`, micros(500), NOW.toISOString()],
    );
    h.state.invoices.set(
      invoiceId,
      invoice(invoiceId, {
        customer: null,
        subscription: null,
        subscription_details: null,
        billing_reason: "manual",
        charge: chargeId,
      }),
    );
    h.state.charges.set(
      chargeId,
      object(chargeId, "charge", {
        customer: null,
        invoice: invoiceId,
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: 500,
        amount_refunded: 125,
        payment_intent: "pi_legacy_wallet",
      }),
    );
    h.state.refunds.set(
      "re_legacy_wallet",
      object("re_legacy_wallet", "refund", {
        charge: chargeId,
        currency: "usd",
        amount: 125,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    const payload = event("refund.updated", "re_legacy_wallet", "refund");
    const response = await deliver(h.app, payload);
    expect(response.status, await response.text()).toBe(200);
    expect(
      await h.sql.query("SELECT outcome, outcome_detail FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "applied", outcome_detail: "refund_settled" }]);
    expect(await h.sql.query("SELECT refund_id FROM stripe_billing_refunds")).toEqual([
      { refund_id: "re_legacy_wallet" },
    ]);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(micros(375));
  });

  test("freezes a legacy wallet lot when its Checkout marker disappears", async () => {
    const h = await fixture();
    const sessionId = "cs_legacy_missing_marker";
    const chargeId = "ch_legacy_missing_marker";
    await h.sql.run(
      "INSERT INTO wallet_credit_lots (org_id, ref, kind, consumption_class, amount_micros, expires_at, created_at) VALUES (?, ?, 'direct', 'purchased', ?, NULL, ?)",
      [ORG, `stripe:${sessionId}`, micros(500), NOW.toISOString()],
    );
    await h.sql.run(
      "INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at) VALUES (?, ?, 'funding', ?, ?, 0, ?)",
      ["led_legacy_missing_marker", ORG, `stripe:${sessionId}`, micros(500), NOW.toISOString()],
    );
    h.state.sessions.set(
      sessionId,
      object(sessionId, "checkout.session", {
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 500,
        currency: "usd",
        created: Math.floor(NOW.getTime() / 1_000),
        customer: null,
        metadata: {},
        payment_intent: {
          id: "pi_legacy_missing_marker",
          object: "payment_intent",
          livemode: false,
          status: "succeeded",
          latest_charge: chargeId,
        },
      }),
    );
    h.state.charges.set(
      chargeId,
      object(chargeId, "charge", {
        customer: null,
        invoice: null,
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: 500,
        amount_refunded: 125,
        payment_intent: "pi_legacy_missing_marker",
      }),
    );
    h.state.refunds.set(
      "re_legacy_missing_marker",
      object("re_legacy_missing_marker", "refund", {
        charge: chargeId,
        currency: "usd",
        amount: 125,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    const payload = event("refund.updated", "re_legacy_missing_marker", "refund");
    const response = await deliver(h.app, payload);
    expect(response.status, await response.text()).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    expect(
      await h.sql.query(
        "SELECT active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
        [ORG, `stripe:${sessionId}`],
      ),
    ).toEqual([{ active: 1 }]);
    expect((await h.ledger.wallet(ORG)).availableMicros).toBe(0);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_refunds")).toEqual([
      { count: 0 },
    ]);
  });

  test("defers a bound-customer refund without an invoice or Checkout source", async () => {
    const h = await fixture();
    h.state.charges.set(
      "ch_bound_missing_source",
      object("ch_bound_missing_source", "charge", {
        customer: CUSTOMER,
        invoice: null,
        currency: "usd",
        amount: 500,
        amount_refunded: 125,
        payment_intent: "pi_bound_missing_source",
      }),
    );
    h.state.refunds.set(
      "re_bound_missing_source",
      object("re_bound_missing_source", "refund", {
        charge: "ch_bound_missing_source",
        currency: "usd",
      }),
    );
    const payload = event("refund.updated", "re_bound_missing_source", "refund");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome, outcome_detail FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred", outcome_detail: "ambiguous_refund_allocation" }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants")).toEqual([
      { count: 0 },
    ]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_refunds")).toEqual([
      { count: 0 },
    ]);
  });

  test("defers a bound-customer invoice missing its subscription pointer", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_bound_missing_subscription",
      invoice("in_bound_missing_subscription", {
        customer: CUSTOMER,
        subscription: null,
        subscription_details: null,
        billing_reason: "manual",
      }),
    );
    const payload = event("invoice.paid", "in_bound_missing_subscription", "invoice");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants")).toEqual([
      { count: 0 },
    ]);
  });

  test("ignores an unmarked payment refund when no wallet source exists", async () => {
    const h = await fixture();
    h.state.sessions.set(
      "cs_other_payment",
      object("cs_other_payment", "checkout.session", {
        mode: "payment",
        currency: "usd",
        metadata: {},
        payment_intent: {
          id: "pi_other_payment",
          object: "payment_intent",
          livemode: false,
          status: "succeeded",
          latest_charge: "ch_other_payment",
        },
      }),
    );
    h.state.charges.set(
      "ch_other_payment",
      object("ch_other_payment", "charge", {
        customer: null,
        invoice: null,
        currency: "usd",
        amount: 500,
        amount_refunded: 125,
        payment_intent: "pi_other_payment",
      }),
    );
    h.state.refunds.set(
      "re_other_payment",
      object("re_other_payment", "refund", { charge: "ch_other_payment", currency: "usd" }),
    );
    const payload = event("refund.updated", "re_other_payment", "refund");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "ignored" }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_fences")).toEqual([
      { count: 0 },
    ]);
  });

  test("ignores unrelated subscription Checkout without hiding a hosted subscription claim", async () => {
    const h = await fixture();
    h.state.subscriptions.set(
      "sub_other_checkout",
      subscription({ id: "sub_other_checkout", customer: "cus_other_checkout", metadata: {} }),
    );
    h.state.sessions.set(
      "cs_other_subscription",
      object("cs_other_subscription", "checkout.session", {
        mode: "subscription",
        subscription: "sub_other_checkout",
        metadata: {},
      }),
    );
    const other = event("checkout.session.completed", "cs_other_subscription", "checkout.session");
    expect((await deliver(h.app, other)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [String(other.id)]),
    ).toEqual([{ outcome: "ignored" }]);
    h.state.sessions.set(
      "cs_host_missing_marker",
      object("cs_host_missing_marker", "checkout.session", {
        mode: "subscription",
        subscription: SUBSCRIPTION,
        metadata: {},
      }),
    );
    const host = event("checkout.session.completed", "cs_host_missing_marker", "checkout.session");
    expect((await deliver(h.app, host)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [String(host.id)]),
    ).toEqual([{ outcome: "deferred" }]);
  });

  test("fresh LIVE realm credits a paid invoice once and revokes only its original lot", async () => {
    const h = await fixture(pricing(), () => new Date(NOW), "live");
    const wrong = event("invoice.paid", "in_billing_test", "invoice");
    expect((await deliver(h.app, wrong)).status).toBe(400);
    expect(
      await h.sql.query("SELECT event_id FROM stripe_events WHERE event_id = ?", [
        wrong.id as string,
      ]),
    ).toEqual([]);

    const paid = { ...wrong, livemode: true };
    expect((await deliver(h.app, paid)).status).toBe(200);
    expect((await deliver(h.app, paid)).status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: INCLUDED_MICROS });
    expect(await h.sql.query("SELECT source_type, funding_ref FROM stripe_billing_grants")).toEqual(
      [{ source_type: "invoice", funding_ref: "stripe:invoice:in_billing_test" }],
    );
    expect(await h.sql.query("SELECT mode FROM stripe_mode_realm WHERE singleton = 1")).toEqual([
      { mode: "live" },
    ]);

    const { livemode: _ignored, ...refundWithoutMode } = object("re_live_full", "refund", {
      charge: "ch_billing_test",
      currency: "usd",
      amount: MONTHLY_MINOR,
      created: 1_791_871_100,
      status: "succeeded",
    });
    h.state.refunds.set("re_live_full", refundWithoutMode);
    h.state.charges.set("ch_billing_test", {
      ...charge({ amount_refunded: MONTHLY_MINOR }),
      livemode: true,
    });
    expect(
      (
        await deliver(
          h.app,
          event("charge.refunded", "ch_billing_test", "charge", { livemode: true }),
        )
      ).status,
    ).toBe(200);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(0);
    expect(await h.sql.query("SELECT funding_ref FROM stripe_billing_refunds")).toEqual([
      { funding_ref: "stripe:invoice:in_billing_test" },
    ]);
    expect(h.state.requests.filter((request) => request.method === "POST")).toEqual([]);
  });

  test("paid recurring invoice credits once by invoice identity across event IDs and reconciliation", async () => {
    const h = await fixture();
    const first = await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect(first.status).toBe(200);
    const secondEvent = event("invoice.paid", "in_billing_test", "invoice");
    const second = await deliver(h.app, secondEvent);
    expect(second.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: INCLUDED_MICROS });
    expect(
      await h.sql.query(
        "SELECT funding_ref, kind, amount_micros, consumption_class, consideration_micros, expires_at, period_start, period_end, pricing_revision FROM stripe_billing_grants",
      ),
    ).toEqual([
      {
        funding_ref: "stripe:invoice:in_billing_test",
        kind: "plan-included",
        amount_micros: INCLUDED_MICROS,
        consumption_class: "subscription",
        consideration_micros: micros(MONTHLY_MINOR),
        expires_at: "2026-11-01T00:00:00.000Z",
        period_start: "2026-10-01T00:00:00.000Z",
        period_end: "2026-11-01T00:00:00.000Z",
        pricing_revision: REVISION,
      },
    ]);
    await h.sql.run("DELETE FROM stripe_events WHERE event_id = ?", [String(secondEvent.id)]);
    const report = await h.reconcile();
    expect(report.billing?.handlerVersion).toBe(1);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: INCLUDED_MICROS });
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants")).toEqual([
      { count: 1 },
    ]);
  });

  test("authoritative invoice and subscription state overrides inverted webhook order", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_billing_test",
      invoice("in_billing_test", {
        status: "open",
        paid: false,
        paid_out_of_band: false,
        amount_remaining: MONTHLY_MINOR,
      }),
    );
    h.state.subscriptions.set(SUBSCRIPTION, subscription({ status: "past_due" }));
    const failure = await deliver(
      h.app,
      event("invoice.payment_failed", "in_billing_test", "invoice"),
    );
    expect(failure.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: 0 });
    expect((await h.subscriptions.read(ORG))?.status).toBe("past_due");
    h.state.invoices.set("in_billing_test", invoice("in_billing_test"));
    const paid = await deliver(
      h.app,
      event("invoice.payment_failed", "in_billing_test", "invoice"),
    );
    expect(paid.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: INCLUDED_MICROS });
    h.state.subscriptions.set(
      SUBSCRIPTION,
      subscription({ status: "canceled", cancel_at_period_end: true }),
    );
    const canceled = await deliver(
      h.app,
      event("customer.subscription.deleted", SUBSCRIPTION, "subscription"),
    );
    expect(canceled.status).toBe(200);
    expect((await h.subscriptions.read(ORG))?.status).toBe("canceled");
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(INCLUDED_MICROS);
    expect(
      (
        await h.sql.query("SELECT expires_at FROM wallet_credit_lots WHERE ref = ?", [
          "stripe:invoice:in_billing_test",
        ])
      )[0]?.expires_at,
    ).toBe("2026-11-01T00:00:00.000Z");
  });

  test("failed Hosted invoice without a subscription pointer is deferred", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_failed_missing_subscription",
      invoice("in_failed_missing_subscription", {
        status: "open",
        paid: false,
        amount_remaining: MONTHLY_MINOR,
        subscription: null,
      }),
    );
    const payload = event("invoice.payment_failed", "in_failed_missing_subscription", "invoice");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants")).toEqual([
      { count: 0 },
    ]);
  });

  test("failed invoice with a Hosted pin cannot project a foreign subscription", async () => {
    const h = await fixture();
    const foreign = "sub_failed_foreign";
    h.state.subscriptions.set(
      foreign,
      subscription({ id: foreign, customer: "cus_failed_foreign", metadata: {} }),
    );
    h.state.invoices.set(
      "in_failed_foreign",
      invoice("in_failed_foreign", {
        status: "open",
        paid: false,
        amount_remaining: MONTHLY_MINOR,
        customer: "cus_failed_foreign",
        subscription: foreign,
      }),
    );
    const payload = event("invoice.payment_failed", "in_failed_foreign", "invoice");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_subscriptions")).toEqual(
      [{ count: 0 }],
    );
  });

  test("failed invoice with a known association rejects a contradictory customer", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_failed_wrong_customer",
      invoice("in_failed_wrong_customer", {
        status: "open",
        paid: false,
        amount_remaining: MONTHLY_MINOR,
        customer: "cus_failed_wrong_customer",
      }),
    );
    const payload = event("invoice.payment_failed", "in_failed_wrong_customer", "invoice");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_subscriptions")).toEqual(
      [{ count: 0 }],
    );
  });

  test("failed invoice with a known association rejects contradictory pinned terms", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_failed_wrong_terms",
      invoice("in_failed_wrong_terms", {
        status: "open",
        paid: false,
        amount_remaining: MONTHLY_MINOR,
        subscription_details: {
          metadata: {
            organizationId: ORG,
            takoserverPurpose: "hosted_subscription",
            planKey: PLAN_KEY,
            pricingRevision: "foreign-revision",
          },
        },
      }),
    );
    const payload = event("invoice.payment_failed", "in_failed_wrong_terms", "invoice");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_subscriptions")).toEqual(
      [{ count: 0 }],
    );
  });

  test("failed invoice rejects an invoice metadata claim that contradicts its pin", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_failed_wrong_claim",
      invoice("in_failed_wrong_claim", {
        status: "open",
        paid: false,
        amount_remaining: MONTHLY_MINOR,
        metadata: { organizationId: "org_foreign_claim" },
      }),
    );
    const payload = event("invoice.payment_failed", "in_failed_wrong_claim", "invoice");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_subscriptions")).toEqual(
      [{ count: 0 }],
    );
  });

  test("paid invoice cannot grant credit with a contradictory invoice metadata claim", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_billing_test",
      invoice("in_billing_test", { metadata: { organizationId: "org_foreign_claim" } }),
    );
    const payload = event("invoice.paid", "in_billing_test", "invoice");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "deferred" }]);
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants")).toEqual([
      { count: 0 },
    ]);
  });

  test("unrelated failed invoice remains ignored", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_unrelated_failed",
      invoice("in_unrelated_failed", {
        status: "open",
        paid: false,
        amount_remaining: MONTHLY_MINOR,
        customer: "cus_unrelated_failed",
        subscription: null,
        subscription_details: null,
        billing_reason: "manual",
      }),
    );
    const payload = event("invoice.payment_failed", "in_unrelated_failed", "invoice");
    expect((await deliver(h.app, payload)).status).toBe(200);
    expect(
      await h.sql.query("SELECT outcome FROM stripe_events WHERE event_id = ?", [
        String(payload.id),
      ]),
    ).toEqual([{ outcome: "ignored" }]);
  });

  test("deferred signed event is revisited from Stripe history after its object becomes available", async () => {
    const h = await fixture();
    h.state.invoices.delete("in_billing_test");
    const historicalEvent = event("invoice.paid", "in_billing_test", "invoice");
    h.state.events.set(String(historicalEvent.id), historicalEvent);

    const deferred = await deliver(h.app, historicalEvent);
    expect(deferred.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: 0 });
    expect(
      await h.sql.query("SELECT outcome, handler_version FROM stripe_events WHERE event_id = ?", [
        String(historicalEvent.id),
      ]),
    ).toEqual([{ outcome: "deferred", handler_version: 0 }]);

    h.state.invoices.set("in_billing_test", invoice("in_billing_test"));
    const report = await h.reconcile();
    expect(report.billing?.handlerVersion).toBe(1);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: INCLUDED_MICROS });
    expect(
      h.state.requests.some(
        (request) =>
          request.method === "GET" &&
          new URL(request.url).pathname === `/v1/events/${String(historicalEvent.id)}`,
      ),
    ).toBe(true);
    expect(
      await h.sql.query("SELECT outcome, handler_version FROM stripe_events WHERE event_id = ?", [
        String(historicalEvent.id),
      ]),
    ).toEqual([{ outcome: "applied", handler_version: 1 }]);
  });

  test("reconciles an acknowledged invoice after the remote Event leaves Stripe history", async () => {
    const h = await fixture();
    await h.sql.run(
      "INSERT INTO stripe_billing_reconcile (stream, cursor, cycle_started_at, updated_at) VALUES (?, ?, ?, ?)",
      ["invoices", "in_billing_test", NOW.toISOString(), NOW.toISOString()],
    );
    await h.sql.run(
      "INSERT INTO stripe_events (event_id, type, livemode, object_id, event_created_at, received_at, outcome, outcome_detail, settled_at, handler_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "evt_old_invoice",
        "invoice.paid",
        0,
        "in_billing_test",
        "2026-01-01T00:00:00.000Z",
        NOW.toISOString(),
        "deferred",
        "legacy_deferred",
        NOW.toISOString(),
        0,
      ],
    );

    const report = await h.reconcile();
    expect(report.billing?.applied).toBeGreaterThanOrEqual(1);
    expect(report.billing?.unresolved).toBe(0);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: INCLUDED_MICROS });
    expect(
      await h.sql.query("SELECT outcome, handler_version FROM stripe_events WHERE event_id = ?", [
        "evt_old_invoice",
      ]),
    ).toEqual([{ outcome: "applied", handler_version: 1 }]);
    expect(
      await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants WHERE source_id = ?", [
        "in_billing_test",
      ]),
    ).toEqual([{ count: 1 }]);
  });

  test("missing historical Event cannot bypass connected-account invoice guards", async () => {
    const h = await fixture();
    h.state.invoices.set(
      "in_billing_test",
      invoice("in_billing_test", { on_behalf_of: "acct_connected" }),
    );
    await h.sql.run(
      "INSERT INTO stripe_billing_reconcile (stream, cursor, cycle_started_at, updated_at) VALUES (?, ?, ?, ?)",
      ["invoices", "in_billing_test", NOW.toISOString(), NOW.toISOString()],
    );
    await h.sql.run(
      "INSERT INTO stripe_events (event_id, type, livemode, object_id, event_created_at, received_at, outcome, outcome_detail, settled_at, handler_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "evt_old_connected",
        "invoice.paid",
        0,
        "in_billing_test",
        "2026-01-01T00:00:00.000Z",
        NOW.toISOString(),
        "deferred",
        "legacy_deferred",
        NOW.toISOString(),
        0,
      ],
    );

    const report = await h.reconcile();
    expect(report.billing?.unresolved).toBeGreaterThan(0);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: 0 });
    expect(
      await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants WHERE source_id = ?", [
        "in_billing_test",
      ]),
    ).toEqual([{ count: 0 }]);
    expect(
      await h.sql.query("SELECT outcome, handler_version FROM stripe_events WHERE event_id = ?", [
        "evt_old_connected",
      ]),
    ).toEqual([{ outcome: "deferred", handler_version: 0 }]);
  });

  test("keeps reconciliation errors visible across page boundaries until a full clean sweep", async () => {
    const h = await fixture();
    const badId = "in_page_quarantined";
    const page: ObjectRecord[] = [
      invoice(badId, { currency: "jpy" }),
      ...Array.from({ length: 99 }, (_, index) =>
        invoice(`in_page_open_${String(index).padStart(3, "0")}`, {
          status: "open",
          paid: false,
          paid_out_of_band: false,
          amount_remaining: MONTHLY_MINOR,
          subscription: null,
          subscription_details: null,
          customer: "cus_page_other",
          billing_reason: "manual",
        }),
      ),
    ];
    for (const item of page) h.state.invoices.set(String(item.id), item);
    h.state.invoicePages.push({ data: page, has_more: true });

    const first = await h.reconcile();
    expect(first.billing?.unresolved).toBeGreaterThan(0);
    expect(first.billing?.truncated).toBe(true);
    const second = await h.reconcile();
    expect(second.billing?.unresolved).toBeGreaterThan(0);
    expect(second.billing?.truncated).toBe(false);

    const repaired = invoice(badId);
    h.state.invoices.set(badId, repaired);
    h.state.charges.set("ch_billing_test", charge({ invoice: badId }));
    h.state.invoicePages.push({ data: [repaired, ...page.slice(1)], has_more: true });
    const cleanFirstPage = await h.reconcile();
    expect(cleanFirstPage.billing?.unresolved).toBeGreaterThan(0);
    expect(cleanFirstPage.billing?.truncated).toBe(true);
    const cleanFinalPage = await h.reconcile();
    expect(cleanFinalPage.billing?.unresolved).toBe(0);
    expect(cleanFinalPage.billing?.truncated).toBe(false);
  });

  test("queues one failed object without blocking the invoice page, later page, or hosted refunds", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    h.state.refunds.set(
      "re_page_during_retry",
      object("re_page_during_retry", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));

    const badId = "in_page_unavailable";
    const originalLine = (invoice(badId).lines as { data: ObjectRecord[] }).data[0] as ObjectRecord;
    const bad = invoice(badId, {
      charge: "ch_page_unavailable",
      lines: {
        has_more: false,
        data: [
          {
            ...originalLine,
            period: {
              start: Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1_000),
              end: Math.floor(Date.parse("2026-10-01T00:00:00.000Z") / 1_000),
            },
          },
        ],
      },
    });
    h.state.invoices.set(badId, bad);
    h.state.charges.set(
      "ch_page_unavailable",
      object("ch_page_unavailable", "charge", {
        customer: CUSTOMER,
        invoice: badId,
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: MONTHLY_MINOR,
        amount_refunded: 0,
        payment_intent: "pi_page_unavailable",
      }),
    );
    const page: ObjectRecord[] = [
      bad,
      ...Array.from({ length: 99 }, (_, index) =>
        invoice(`in_retry_open_${String(index).padStart(3, "0")}`, {
          status: "open",
          paid: false,
          paid_out_of_band: false,
          amount_remaining: MONTHLY_MINOR,
          subscription: null,
          subscription_details: null,
          customer: "cus_page_other",
          billing_reason: "manual",
        }),
      ),
    ];
    for (const item of page) h.state.invoices.set(String(item.id), item);
    h.state.invoicePages.push({ data: page, has_more: true });
    h.state.failAlways.add(`/v1/invoices/${badId}`);

    const first = await h.reconcile();
    expect(first.billing?.unresolved).toBeGreaterThan(0);
    expect(first.billing?.truncated).toBe(true);
    expect(
      await h.sql.query("SELECT event_type, object_id FROM stripe_billing_reconcile_failures"),
    ).toEqual([{ event_type: "invoice.paid", object_id: badId }]);
    expect(
      await h.sql.query("SELECT cursor FROM stripe_billing_reconcile WHERE stream = ?", [
        "invoices",
      ]),
    ).toEqual([{ cursor: String(page.at(-1)?.id) }]);
    expect(
      await h.sql.query(
        "SELECT target_revoked_micros, debit_micros FROM stripe_billing_refunds WHERE refund_id = ?",
        ["re_page_during_retry"],
      ),
    ).toEqual([{ target_revoked_micros: micros(240), debit_micros: micros(240) }]);

    const nextPage = await h.reconcile();
    expect(nextPage.billing?.unresolved).toBeGreaterThan(0);
    expect(nextPage.billing?.truncated).toBe(false);
    h.state.failAlways.delete(`/v1/invoices/${badId}`);
    await h.reconcile();
    expect(
      await h.sql.query(
        "SELECT COUNT(*) AS count FROM stripe_billing_reconcile_failures WHERE event_type = ? AND object_id = ?",
        ["invoice.paid", badId],
      ),
    ).toEqual([{ count: 0 }]);
  });

  test("continues to hosted refunds when an invoice period conflict and legacy Checkout outage occur", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    h.state.invoices.set(
      "in_conflicting_period",
      invoice("in_conflicting_period", { charge: "ch_conflicting_period" }),
    );
    h.state.charges.set(
      "ch_conflicting_period",
      object("ch_conflicting_period", "charge", {
        customer: CUSTOMER,
        invoice: "in_conflicting_period",
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: MONTHLY_MINOR,
        amount_refunded: 0,
        payment_intent: "pi_conflicting_period",
      }),
    );
    h.state.refunds.set(
      "re_hosted_during_legacy_failure",
      object("re_hosted_during_legacy_failure", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));
    h.state.sessions.set(
      "cs_legacy_invalid",
      object("cs_legacy_invalid", "checkout.session", {
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        created: Math.floor(NOW.getTime() / 1_000),
        amount_total: 0,
        currency: "usd",
        metadata: {},
      }),
    );
    h.state.failOnce.add("/v1/checkout/sessions");

    await expect(h.reconcile()).rejects.toBeDefined();
    expect(
      await h.sql.query(
        "SELECT target_revoked_micros, debit_micros FROM stripe_billing_refunds WHERE refund_id = ?",
        ["re_hosted_during_legacy_failure"],
      ),
    ).toEqual([{ target_revoked_micros: micros(240), debit_micros: micros(240) }]);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: INCLUDED_MICROS - micros(240),
      availableMicros: INCLUDED_MICROS - micros(240),
    });
    expect(
      await h.sql.query("SELECT cursor FROM stripe_billing_reconcile WHERE stream = ?", [
        "refunds",
      ]),
    ).toEqual([{ cursor: null }]);
  });

  test("queued retry bookkeeping failures remain unresolved without starving refunds", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    const badId = "in_retry_bookkeeping_failure";
    h.state.invoices.set(badId, invoice(badId, { currency: "jpy" }));
    await h.sql.run(
      "INSERT INTO stripe_billing_reconcile_failures (event_type, object_id, error_code, attempt_sequence, updated_at) VALUES (?, ?, ?, 1, ?)",
      ["invoice.paid", badId, "wrong_currency", NOW.toISOString()],
    );
    const originalRun = h.sql.run.bind(h.sql);
    h.sql.run = async (statement, params) => {
      if (
        statement.includes("INSERT INTO stripe_billing_reconcile_failures") &&
        params?.[1] === badId
      )
        throw new SqlError("unavailable", "injected retry bookkeeping failure");
      return originalRun(statement, params);
    };
    h.state.refunds.set(
      "re_retry_independent",
      object("re_retry_independent", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: MONTHLY_MINOR,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: MONTHLY_MINOR }));
    const report = await h.reconcile();
    expect(report.billing?.unresolved).toBeGreaterThan(0);
    expect(report.billing?.truncated).toBe(true);
    expect(await h.sql.query("SELECT refund_id FROM stripe_billing_refunds")).toEqual([
      { refund_id: "re_retry_independent" },
    ]);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(0);
  });

  test(
    "rejects noncanonical invoice, customer, account and period facts without funding",
    async () => {
      const cases: readonly [string, ObjectRecord][] = [
        ["currency", invoice("in_billing_test", { currency: "jpy" })],
        ["wrong customer", invoice("in_billing_test", { customer: "cus_other" })],
        [
          "extra line",
          invoice("in_billing_test", {
            lines: {
              has_more: false,
              data: [
                ...(invoice("in_billing_test").lines as { data: ObjectRecord[] }).data,
                { id: "il_extra" },
              ],
            },
          }),
        ],
        [
          "proration",
          invoice("in_billing_test", {
            lines: {
              has_more: false,
              data: [
                {
                  ...((invoice("in_billing_test").lines as { data: ObjectRecord[] })
                    .data[0] as ObjectRecord),
                  proration: true,
                },
              ],
            },
          }),
        ],
        [
          "wrong period",
          invoice("in_billing_test", {
            lines: {
              has_more: false,
              data: [
                {
                  ...((invoice("in_billing_test").lines as { data: ObjectRecord[] })
                    .data[0] as ObjectRecord),
                  period: { start: PERIOD_END, end: PERIOD_START },
                },
              ],
            },
          }),
        ],
        [
          "Connect transfer",
          invoice("in_billing_test", { transfer_data: { destination: "acct_foreign" } }),
        ],
      ];
      for (const [label, invalid] of cases) {
        const h = await fixture();
        h.state.invoices.set("in_billing_test", invalid);
        const response = await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
        expect(response.status, label).toBe(200);
        expect((await h.ledger.wallet(ORG)).settledMicros, label).toBe(0);
        expect(
          await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants"),
          label,
        ).toEqual([{ count: 0 }]);
      }
    },
    { timeout: 15_000 },
  );

  test("rejects wrong-mode events before ID occupancy and ignores connected-account events", async () => {
    for (const mode of [{ livemode: true }, { account: "acct_connected" }]) {
      const h = await fixture();
      const response = await deliver(
        h.app,
        event("invoice.paid", "in_billing_test", "invoice", mode),
      );
      expect(response.status).toBe(mode.livemode === true ? 400 : 200);
      if (mode.livemode === true)
        expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_events")).toEqual([
          { count: 0 },
        ]);
      expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants")).toEqual([
        { count: 0 },
      ]);
      expect(h.state.requests).toEqual([]);
    }
  });

  test("records pending refunds without revoking credit and later applies only the successful refund", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    h.state.refunds.set(
      "re_billing_test",
      object("re_billing_test", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "pending",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 0 }));
    const pending = await deliver(h.app, event("refund.created", "re_billing_test", "refund"));
    expect(pending.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: INCLUDED_MICROS,
      frozenMicros: INCLUDED_MICROS,
      availableMicros: 0,
    });
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_refunds")).toEqual([
      { count: 0 },
    ]);

    h.state.refunds.set(
      "re_billing_test",
      object("re_billing_test", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "failed",
      }),
    );
    const failed = await deliver(h.app, event("refund.failed", "re_billing_test", "refund"));
    expect(failed.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: INCLUDED_MICROS,
      frozenMicros: 0,
      availableMicros: INCLUDED_MICROS,
    });
    expect(await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_refunds")).toEqual([
      { count: 0 },
    ]);

    h.state.refunds.set(
      "re_billing_test",
      object("re_billing_test", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));
    const succeeded = await deliver(h.app, event("refund.updated", "re_billing_test", "refund"));
    expect(succeeded.status).toBe(200);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(INCLUDED_MICROS - micros(240));
    expect(
      await h.sql.query(
        "SELECT refund_id, target_revoked_micros, debit_micros, receivable_micros FROM stripe_billing_refunds",
      ),
    ).toEqual([
      {
        refund_id: "re_billing_test",
        target_revoked_micros: micros(240),
        debit_micros: micros(240),
        receivable_micros: 0,
      },
    ]);
  });

  test("keeps credit frozen across a transient refund-scan failure and clears it after a complete retry", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    h.state.refunds.set(
      "re_retry",
      object("re_retry", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));
    h.state.failOnce.add("/v1/refunds");

    const interrupted = await deliver(h.app, event("refund.updated", "re_retry", "refund"));
    expect(interrupted.status).toBe(503);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: INCLUDED_MICROS,
      availableMicros: 0,
    });
    expect(
      await h.sql.query(
        "SELECT active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
        [ORG, "stripe:invoice:in_billing_test"],
      ),
    ).toEqual([{ active: 1 }]);

    const retried = await deliver(h.app, event("refund.updated", "re_retry", "refund"));
    expect(retried.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: INCLUDED_MICROS - micros(240),
      availableMicros: INCLUDED_MICROS - micros(240),
    });
    expect(
      await h.sql.query(
        "SELECT active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
        [ORG, "stripe:invoice:in_billing_test"],
      ),
    ).toEqual([{ active: 0 }]);
  });

  test("keeps the remaining lot frozen while any refund is pending beside a successful partial refund", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    h.state.refunds.set(
      "re_pending_partial",
      object("re_pending_partial", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_100,
        status: "pending",
      }),
    );
    h.state.refunds.set(
      "re_succeeded_partial",
      object("re_succeeded_partial", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));

    const partial = await deliver(h.app, event("refund.updated", "re_succeeded_partial", "refund"));
    expect(partial.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: INCLUDED_MICROS - micros(240),
      frozenMicros: INCLUDED_MICROS - micros(240),
      availableMicros: 0,
    });
    expect(
      await h.sql.query("SELECT refund_id, cumulative_refunded_micros FROM stripe_billing_refunds"),
    ).toEqual([{ refund_id: "re_succeeded_partial", cumulative_refunded_micros: micros(25) }]);

    h.state.refunds.set(
      "re_pending_partial",
      object("re_pending_partial", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_100,
        status: "failed",
      }),
    );
    const terminal = await deliver(h.app, event("refund.failed", "re_pending_partial", "refund"));
    expect(terminal.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: INCLUDED_MICROS - micros(240),
      frozenMicros: 0,
      availableMicros: INCLUDED_MICROS - micros(240),
    });
  });

  test("keeps a lot frozen while the charge refund total is ahead of successful refund objects", async () => {
    const h = await fixture();
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));
    const lagging = await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect(lagging.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: 0, availableMicros: 0 });
    expect(
      await h.sql.query(
        "SELECT outcome, outcome_detail FROM stripe_events ORDER BY event_id DESC LIMIT 1",
      ),
    ).toEqual([{ outcome: "deferred", outcome_detail: "refund_total_unresolved" }]);
    expect(
      await h.sql.query(
        "SELECT active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
        [ORG, "stripe:invoice:in_billing_test"],
      ),
    ).toEqual([{ active: 1 }]);

    h.state.refunds.set(
      "re_delayed_success",
      object("re_delayed_success", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    const retried = await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect(retried.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: INCLUDED_MICROS - micros(240),
      availableMicros: INCLUDED_MICROS - micros(240),
    });
    expect(
      await h.sql.query(
        "SELECT active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
        [ORG, "stripe:invoice:in_billing_test"],
      ),
    ).toEqual([{ active: 0 }]);
  });

  test("partial cumulative refund revokes the floor target, then final refund revokes the exact lot", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect(
      await h.ledger.debitUsage({
        organizationId: ORG,
        reference: "run-spend",
        amountMicros: micros(500),
      }),
    ).toBe(true);
    h.state.refunds.set(
      "re_partial",
      object("re_partial", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 25,
        created: 1_791_871_100,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));
    expect(
      (await deliver(h.app, event("charge.refunded", "ch_billing_test", "charge"))).status,
    ).toBe(200);
    expect(
      await h.sql.query(
        "SELECT target_revoked_micros, debit_micros, receivable_micros FROM stripe_billing_refunds",
      ),
    ).toEqual([
      { target_revoked_micros: micros(240), debit_micros: micros(240), receivable_micros: 0 },
    ]);

    h.state.refunds.set(
      "re_final",
      object("re_final", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 100,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 125 }));
    expect((await deliver(h.app, event("refund.updated", "re_final", "refund"))).status).toBe(200);
    expect(
      await h.sql.query(
        "SELECT refund_id, target_revoked_micros, debit_micros, receivable_micros FROM stripe_billing_refunds ORDER BY cumulative_refunded_micros",
      ),
    ).toEqual([
      {
        refund_id: "re_partial",
        target_revoked_micros: micros(240),
        debit_micros: micros(240),
        receivable_micros: 0,
      },
      {
        refund_id: "re_final",
        target_revoked_micros: INCLUDED_MICROS,
        debit_micros: micros(460),
        receivable_micros: micros(500),
      },
    ]);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: 0,
      refundReceivableMicros: micros(500),
    });
  });

  test("refund prorates fractional credit to micros and records a one-micro receivable", async () => {
    const h = await fixture(pricing(1, 2));
    h.state.prices.set(
      PRICE,
      object(PRICE, "price", {
        currency: "usd",
        type: "recurring",
        billing_scheme: "per_unit",
        unit_amount: 2,
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      }),
    );
    h.state.invoices.set(
      "in_billing_test",
      invoice("in_billing_test", {
        amount_paid: 2,
        total: 2,
        total_excluding_tax: 2,
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount: 2 }));

    const credited = await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect(credited.status).toBe(200);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(micros(1));
    expect(
      await h.ledger.debitUsage({
        organizationId: ORG,
        reference: "one-micro-over-half-refund",
        amountMicros: 5_001,
      }),
    ).toBe(true);

    h.state.refunds.set(
      "re_half_cent",
      object("re_half_cent", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 1,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount: 2, amount_refunded: 1 }));
    const refunded = await deliver(h.app, event("refund.updated", "re_half_cent", "refund"));
    expect(refunded.status).toBe(200);
    expect(
      await h.sql.query(
        "SELECT amount_micros, cumulative_refunded_micros, target_revoked_micros, debit_micros, receivable_micros, expired_micros FROM stripe_billing_refunds WHERE refund_id = ?",
        ["re_half_cent"],
      ),
    ).toEqual([
      {
        amount_micros: micros(1),
        cumulative_refunded_micros: micros(1),
        target_revoked_micros: 5_000,
        debit_micros: 4_999,
        receivable_micros: 1,
        expired_micros: 0,
      },
    ]);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: 0,
      refundReceivableMicros: 1,
    });
  });

  test("later-created refund can succeed first, then an earlier pending refund is appended without rewriting its receipt", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    const refundA = object("re_a", "refund", {
      charge: "ch_billing_test",
      currency: "usd",
      amount: 25,
      created: 1_791_871_100,
      status: "pending",
    });
    const refundB = object("re_b", "refund", {
      charge: "ch_billing_test",
      currency: "usd",
      amount: 25,
      created: 1_791_871_200,
      status: "succeeded",
    });
    h.state.refunds.set("re_a", refundA);
    h.state.refunds.set("re_b", refundB);
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));
    expect((await deliver(h.app, event("refund.updated", "re_b", "refund"))).status).toBe(200);
    expect(
      await h.sql.query("SELECT refund_id, cumulative_refunded_micros FROM stripe_billing_refunds"),
    ).toEqual([{ refund_id: "re_b", cumulative_refunded_micros: micros(25) }]);

    h.state.refunds.set("re_a", { ...refundA, status: "succeeded" });
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 50 }));
    expect((await deliver(h.app, event("refund.updated", "re_a", "refund"))).status).toBe(200);
    expect(
      await h.sql.query(
        "SELECT refund_id, cumulative_refunded_micros, target_revoked_micros FROM stripe_billing_refunds ORDER BY cumulative_refunded_micros",
      ),
    ).toEqual([
      {
        refund_id: "re_b",
        cumulative_refunded_micros: micros(25),
        target_revoked_micros: micros(240),
      },
      {
        refund_id: "re_a",
        cumulative_refunded_micros: micros(50),
        target_revoked_micros: micros(480),
      },
    ]);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(INCLUDED_MICROS - micros(480));
    expect(
      await h.sql.query(
        "SELECT active FROM stripe_billing_fences WHERE org_id = ? AND funding_ref = ?",
        [ORG, "stripe:invoice:in_billing_test"],
      ),
    ).toEqual([{ active: 0 }]);
  });

  test("refund closes a live hold against the revoked lot", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect(
      await h.ledger.hold({
        organizationId: ORG,
        reference: "live-run-hold",
        amountMicros: micros(500),
      }),
    ).toBe(true);
    h.state.refunds.set(
      "re_full_hold",
      object("re_full_hold", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: MONTHLY_MINOR,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: MONTHLY_MINOR }));
    const response = await deliver(h.app, event("charge.refunded", "ch_billing_test", "charge"));
    expect(response.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMicros: 0,
      heldMicros: 0,
      availableMicros: 0,
    });
    expect(
      await h.sql.query(
        "SELECT type, held_delta_micros FROM ledger WHERE ref = ? ORDER BY created_at, id",
        ["live-run-hold"],
      ),
    ).toContainEqual({ type: "release", held_delta_micros: -micros(500) });
    expect(
      await h.sql.query(
        "SELECT COUNT(*) AS count FROM wallet_credit_allocations WHERE org_id = ? AND lot_ref = ? AND debit_type = 'hold'",
        [ORG, "stripe:invoice:in_billing_test"],
      ),
    ).toEqual([{ count: 0 }]);
  });

  test("read disables paid features immediately after a committed full refund even if subscription refresh fails", async () => {
    const h = await fixture();
    await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect((await h.subscriptions.read(ORG))?.paidFeatures).toBe(true);
    h.state.refunds.set(
      "re_full_subscription",
      object("re_full_subscription", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: MONTHLY_MINOR,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: MONTHLY_MINOR }));
    h.state.failOnce.add(`/v1/subscriptions/${SUBSCRIPTION}`);

    const response = await deliver(
      h.app,
      event("refund.updated", "re_full_subscription", "refund"),
    );
    expect(response.status).toBe(503);
    expect(
      await h.sql.query(
        "SELECT target_revoked_micros FROM stripe_billing_refunds WHERE refund_id = ?",
        ["re_full_subscription"],
      ),
    ).toEqual([{ target_revoked_micros: INCLUDED_MICROS }]);
    expect(await h.subscriptions.read(ORG)).toMatchObject({
      status: "active",
      paidFeatures: false,
      paidThrough: null,
    });
  });

  test("late paid invoice credits its original period but the expired lot is unavailable", async () => {
    const h = await fixture();
    const oldStart = Math.floor(Date.parse("2026-08-01T00:00:00.000Z") / 1_000);
    const oldEnd = Math.floor(Date.parse("2026-09-01T00:00:00.000Z") / 1_000);
    const historical = invoice("in_billing_test", {
      lines: {
        has_more: false,
        data: [
          {
            ...((invoice("in_billing_test").lines as { data: ObjectRecord[] })
              .data[0] as ObjectRecord),
            period: { start: oldStart, end: oldEnd },
          },
        ],
      },
    });
    h.state.invoices.set("in_billing_test", historical);
    const response = await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect(response.status).toBe(200);
    expect((await h.ledger.wallet(ORG)).availableMicros).toBe(0);
    expect(
      await h.sql.query(
        "SELECT funding_ref, amount_micros, expires_at FROM stripe_billing_grants WHERE source_id = ?",
        ["in_billing_test"],
      ),
    ).toEqual([
      {
        funding_ref: "stripe:invoice:in_billing_test",
        amount_micros: INCLUDED_MICROS,
        expires_at: "2026-09-01T00:00:00.000Z",
      },
    ]);
  });

  test("one-time Checkout remains purchased funding and never gets an invoice entitlement", async () => {
    const h = await fixture();
    h.state.sessions.set(
      "cs_purchase_test",
      object("cs_purchase_test", "checkout.session", {
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 500,
        currency: "usd",
        created: Math.floor(NOW.getTime() / 1_000),
        customer: null,
        metadata: { organizationId: ORG, takoserverPurpose: "wallet_funding" },
        payment_intent: {
          id: "pi_purchase_test",
          livemode: false,
          status: "succeeded",
          latest_charge: "ch_purchase_test",
        },
      }),
    );
    h.state.charges.set(
      "ch_purchase_test",
      object("ch_purchase_test", "charge", {
        customer: null,
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: 500,
        amount_refunded: 0,
        payment_intent: "pi_purchase_test",
      }),
    );
    const response = await deliver(
      h.app,
      event("checkout.session.completed", "cs_purchase_test", "checkout.session"),
    );
    expect(response.status).toBe(200);
    expect(
      await h.sql.query("SELECT funding_ref, kind, amount_micros FROM stripe_billing_grants"),
    ).toEqual([
      { funding_ref: "stripe:cs_purchase_test", kind: "purchased", amount_micros: micros(500) },
    ]);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(micros(500));
  });

  test("first settlement uses the Checkout creation revision retained in pricing history", async () => {
    const current = pricing();
    const authored = JSON.parse(current.environment.TAKOSERVER_HOSTED_PRICING ?? "") as Record<
      string,
      unknown
    >;
    const currentConfig = JSON.parse(current.environment.TAKOSERVER_BILLING_CONFIG ?? "") as Record<
      string,
      unknown
    >;
    const historical = {
      ...currentConfig,
      revision: "candidate-r2",
      effectiveAt: "2026-07-01T00:00:00.000Z",
      purchaseCreditExpiry: { kind: "fixed-duration", seconds: 2_592_000 },
    };
    const revised = {
      ...currentConfig,
      revision: "candidate-r4",
      purchaseCreditExpiry: { kind: "none" },
      history: [historical],
    };
    const hostedPricing = compilePricingAuthoring({
      ...authored,
      billingConfig: revised,
    });
    const h = await fixture(hostedPricing);
    const oldCreated = Math.floor(Date.parse("2026-08-01T00:00:00.000Z") / 1_000);
    h.state.sessions.set(
      "cs_history_purchase",
      object("cs_history_purchase", "checkout.session", {
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 500,
        currency: "usd",
        created: oldCreated,
        customer: null,
        metadata: { organizationId: ORG, takoserverPurpose: "wallet_funding" },
        payment_intent: {
          id: "pi_history_purchase",
          livemode: false,
          status: "succeeded",
          latest_charge: "ch_history_purchase",
        },
      }),
    );
    h.state.charges.set(
      "ch_history_purchase",
      object("ch_history_purchase", "charge", {
        customer: null,
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: 500,
        amount_refunded: 0,
        payment_intent: "pi_history_purchase",
      }),
    );
    h.state.sessions.set(
      "cs_current_purchase",
      object("cs_current_purchase", "checkout.session", {
        mode: "payment",
        status: "complete",
        payment_status: "paid",
        amount_total: 500,
        currency: "usd",
        created: Math.floor(Date.parse("2026-10-10T00:00:00.000Z") / 1_000),
        customer: null,
        metadata: { organizationId: ORG, takoserverPurpose: "wallet_funding" },
        payment_intent: {
          id: "pi_current_purchase",
          livemode: false,
          status: "succeeded",
          latest_charge: "ch_current_purchase",
        },
      }),
    );
    h.state.charges.set(
      "ch_current_purchase",
      object("ch_current_purchase", "charge", {
        customer: null,
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: 500,
        amount_refunded: 0,
        payment_intent: "pi_current_purchase",
      }),
    );

    expect(
      (
        await deliver(
          h.app,
          event("checkout.session.completed", "cs_history_purchase", "checkout.session"),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await deliver(
          h.app,
          event(
            "checkout.session.async_payment_succeeded",
            "cs_history_purchase",
            "checkout.session",
          ),
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await deliver(
          h.app,
          event("checkout.session.completed", "cs_current_purchase", "checkout.session"),
        )
      ).status,
    ).toBe(200);
    expect(
      await h.sql.query(
        "SELECT source_id, pricing_revision, expires_at FROM stripe_billing_grants WHERE source_type = 'checkout' ORDER BY source_id",
      ),
    ).toEqual([
      {
        source_id: "cs_current_purchase",
        pricing_revision: "candidate-r4",
        expires_at: null,
      },
      {
        source_id: "cs_history_purchase",
        pricing_revision: "candidate-r2",
        expires_at: new Date(NOW.getTime() + 2_592_000_000).toISOString(),
      },
    ]);
    expect((await h.ledger.wallet(ORG)).availableMicros).toBe(micros(1000));
  });

  test("refund arriving before invoice grant resolves the original paid invoice first", async () => {
    const h = await fixture();
    h.state.refunds.set(
      "re_before_grant",
      object("re_before_grant", "refund", {
        charge: "ch_billing_test",
        currency: "usd",
        amount: 125,
        created: 1_791_871_200,
        status: "succeeded",
      }),
    );
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 125 }));
    const response = await deliver(h.app, event("charge.refunded", "ch_billing_test", "charge"));
    expect(response.status).toBe(200);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(0);
    expect(await h.sql.query("SELECT funding_ref FROM stripe_billing_grants")).toEqual([
      { funding_ref: "stripe:invoice:in_billing_test" },
    ]);
    expect(
      await h.sql.query("SELECT target_revoked_micros, debit_micros FROM stripe_billing_refunds"),
    ).toEqual([{ target_revoked_micros: INCLUDED_MICROS, debit_micros: INCLUDED_MICROS }]);
  });

  test("creates a customer and subscription Checkout idempotently from the configured plan", async () => {
    const h = await fixture();
    expect(h.subscriptions.planTable).toEqual(pricing().hostedPlanTable);
    await clearHistoricalSubscription(h);
    await h.sql.run("DELETE FROM stripe_billing_customers WHERE org_id = ?", [ORG]);
    const input = { organizationId: ORG, reference: "hosted-subscription-001", planKey: PLAN_KEY };
    const first = await h.subscriptions.begin(input);
    const second = await h.subscriptions.begin(input);
    expect(first).toEqual(second);
    if (first.state !== "open") throw new Error("expected open Checkout receipt");
    expect(first.url).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
    const customerPosts = h.state.requests.filter(
      (request) => request.method === "POST" && new URL(request.url).pathname === "/v1/customers",
    );
    const checkoutPosts = h.state.requests.filter(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
    );
    expect(customerPosts).toHaveLength(0);
    expect(checkoutPosts).toHaveLength(1);
    expect((await checkoutPosts[0]?.clone().text()) ?? "").toContain("mode=subscription");
    expect(
      await h.sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?", [ORG]),
    ).toEqual([]);
    await expect(
      h.subscriptions.begin({ ...input, reference: "new-reference", planKey: "unconfigured" }),
    ).rejects.toMatchObject({ code: "unknown_plan" });
    await expect(
      h.subscriptions.begin({
        ...input,
        reference: "hosted-subscription-001",
        planKey: "unconfigured",
      }),
    ).rejects.toMatchObject({ code: "reference_conflict" });
  });

  test("allows only one pending subscription Checkout across concurrent references", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    const attempts = await Promise.allSettled([
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "hosted-subscription-a",
        planKey: PLAN_KEY,
      }),
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "hosted-subscription-b",
        planKey: PLAN_KEY,
      }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      code: "subscription_checkout_pending",
    });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    expect(
      await h.sql.query(
        "SELECT id, session_id FROM stripe_subscription_checkout_intents WHERE org_id = ? AND state = 'session_known'",
        [ORG],
      ),
    ).toHaveLength(1);
  });

  test("repairs a committed Checkout reservation after its session ID write fails without duplicating Stripe POST", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    const originalRun = h.sql.run.bind(h.sql);
    let failReservationWrite = true;
    h.sql.run = async (statement, params) => {
      if (
        failReservationWrite &&
        statement.startsWith("UPDATE stripe_subscription_checkout_intents SET session_id")
      ) {
        failReservationWrite = false;
        throw new SqlError("unavailable", "injected local write failure");
      }
      return await originalRun(statement, params);
    };
    const input = {
      organizationId: ORG,
      reference: "hosted-checkout-repair",
      planKey: PLAN_KEY,
    };
    expect(await h.subscriptions.begin(input)).toMatchObject({ state: "pending" });
    expect(
      await h.sql.query(
        "SELECT session_id FROM stripe_subscription_checkout_intents WHERE org_id = ? AND request_key_digest <> 'historical'",
        [ORG],
      ),
    ).toEqual([{ session_id: null }]);
    const firstCheckoutPosts = h.state.requests.filter(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
    );
    expect(firstCheckoutPosts).toHaveLength(1);

    const repaired = await h.subscriptions.begin(input);
    expect(repaired).toMatchObject({
      state: "open",
      url: "https://checkout.stripe.com/c/pay/cs_created_1",
    });
    expect(
      await h.sql.query(
        "SELECT session_id FROM stripe_subscription_checkout_intents WHERE org_id = ? AND request_key_digest <> 'historical'",
        [ORG],
      ),
    ).toEqual([{ session_id: "cs_created_1" }]);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);

    h.state.sessions.set("cs_created_1", {
      ...h.state.sessions.get("cs_created_1"),
      status: "expired",
    });
    await h.subscriptions.begin({
      ...input,
      reference: "hosted-checkout-after-expiry",
    });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(2);
  });

  test("permits a new Checkout reference only after exact expired and unpaid Session proof", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    const first = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "hosted-subscription-old",
      planKey: PLAN_KEY,
    });
    const oldSession = h.state.sessions.get("cs_created_1");
    expect(oldSession).toBeDefined();
    await expect(
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "hosted-subscription-new",
        planKey: PLAN_KEY,
      }),
    ).rejects.toMatchObject({ code: "subscription_checkout_pending" });

    h.state.sessions.set("cs_created_1", { ...oldSession, status: "complete" });

    await expect(
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "hosted-subscription-new",
        planKey: PLAN_KEY,
      }),
    ).rejects.toMatchObject({ code: "subscription_checkout_pending" });

    h.state.sessions.set("cs_created_1", {
      ...oldSession,
      status: "expired",
      payment_status: "unpaid",
    });
    const next = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "hosted-subscription-new",
      planKey: PLAN_KEY,
    });
    if (first.state !== "open" || next.state !== "open")
      throw new Error("expected open Checkout receipts");
    expect(next.url).not.toBe(first.url);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(2);
  });

  test("subscription command preserves identity and idempotently schedules cancellation", async () => {
    const h = await fixture();
    expect(
      (await deliver(h.app, event("customer.subscription.updated", SUBSCRIPTION, "subscription")))
        .status,
    ).toBe(200);
    const first = await h.subscriptions.change({
      organizationId: ORG,
      reference: "cancel-subscription-001",
      cancelAtPeriodEnd: true,
      expectedSubscriptionRef: String((await h.subscriptions.read(ORG))?.subscriptionRef),
    });
    const second = await h.subscriptions.change({
      organizationId: ORG,
      reference: "cancel-subscription-001",
      cancelAtPeriodEnd: true,
      expectedSubscriptionRef: String((await h.subscriptions.read(ORG))?.subscriptionRef),
    });
    expect(first).toMatchObject({ state: "verified", effectiveAt: "2026-11-01T00:00:00.000Z" });
    expect(second).toEqual(first);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === `/v1/subscriptions/${SUBSCRIPTION}`,
      ),
    ).toHaveLength(1);
  });

  test("Checkout lost ACK recovers the exact Session by list/readback without another POST", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    h.state.loseCheckoutAck = true;
    const input = { organizationId: ORG, reference: "lost-checkout-ack", planKey: PLAN_KEY };
    const first = await h.subscriptions.begin(input);
    expect(first.state).toBe("pending");
    expect(first.id).toMatch(/^sci_/u);
    const replay = await h.subscriptions.begin(input);
    expect(replay).toMatchObject({ state: "open", id: "cs_created_1" });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    expect(
      await h.sql.query(
        "SELECT state, session_id FROM stripe_subscription_checkout_intents WHERE id = ?",
        [first.id],
      ),
    ).toEqual([{ state: "session_known", session_id: "cs_created_1" }]);
  });

  test("LIVE Checkout and cancellation unknown ACKs recover by GET without a second POST", async () => {
    const checkout = await fixture(pricing(), () => new Date(NOW), "live");
    await clearHistoricalSubscription(checkout);
    checkout.state.loseCheckoutAck = true;
    const begin = {
      organizationId: ORG,
      reference: "live-lost-checkout-ack",
      planKey: PLAN_KEY,
    };
    const pending = await checkout.subscriptions.begin(begin);
    expect(pending.state).toBe("pending");
    expect(await checkout.subscriptions.begin(begin)).toMatchObject({
      state: "open",
      id: "cs_created_1",
    });
    expect(
      await checkout.sql.query(
        "SELECT livemode, state, session_id FROM stripe_subscription_checkout_intents WHERE id = ?",
        [pending.id],
      ),
    ).toEqual([{ livemode: 1, state: "session_known", session_id: "cs_created_1" }]);
    expect(
      checkout.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);

    const cancellation = await fixture(pricing(), () => new Date(NOW), "live");
    expect(
      (
        await deliver(
          cancellation.app,
          event("customer.subscription.updated", SUBSCRIPTION, "subscription", { livemode: true }),
        )
      ).status,
    ).toBe(200);
    const subscriptionRef = String((await cancellation.subscriptions.read(ORG))?.subscriptionRef);
    cancellation.state.loseCancelAck = true;
    const change = {
      organizationId: ORG,
      reference: "live-lost-cancellation-ack",
      cancelAtPeriodEnd: true,
      expectedSubscriptionRef: subscriptionRef,
    };
    expect(await cancellation.subscriptions.change(change)).toMatchObject({ state: "pending" });
    expect(await cancellation.subscriptions.change(change)).toMatchObject({ state: "verified" });
    expect(
      cancellation.state.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === `/v1/subscriptions/${SUBSCRIPTION}`,
      ),
    ).toHaveLength(1);
  });

  test("conclusively stale prepared Checkout is invalidated without POST and frees the org slot", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    const originalRun = h.sql.run.bind(h.sql);
    h.sql.run = async (statement, params) =>
      statement.startsWith("UPDATE stripe_subscription_checkout_intents SET state = 'dispatched'")
        ? { rows: [], changes: 0 }
        : await originalRun(statement, params);
    const input = { organizationId: ORG, reference: "prepared-recheck", planKey: PLAN_KEY };
    await expect(h.subscriptions.begin(input)).rejects.toMatchObject({
      code: "subscription_checkout_pending",
    });
    h.sql.run = originalRun;
    await h.reconcile();
    expect(
      await h.sql.query("SELECT state FROM stripe_subscription_checkout_intents WHERE org_id = ?", [
        ORG,
      ]),
    ).toEqual([{ state: "prepared" }]);
    h.state.prices.set(PRICE, { ...h.state.prices.get(PRICE), unit_amount: MONTHLY_MINOR + 1 });
    await expect(h.subscriptions.begin(input)).rejects.toMatchObject({
      code: "subscription_checkout_invalidated",
    });
    expect(
      await h.sql.query("SELECT state FROM stripe_subscription_checkout_intents WHERE org_id = ?", [
        ORG,
      ]),
    ).toEqual([{ state: "invalidated" }]);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(0);
    h.state.prices.set(PRICE, { ...h.state.prices.get(PRICE), unit_amount: MONTHLY_MINOR });
    expect(
      await h.subscriptions.begin({
        organizationId: ORG,
        reference: "fresh-after-invalidation",
        planKey: PLAN_KEY,
      }),
    ).toMatchObject({ state: "open", id: "cs_created_1" });
    await expect(h.subscriptions.begin(input)).rejects.toMatchObject({
      code: "subscription_checkout_invalidated",
    });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
  });

  test("transient Price read keeps prepared custody while changed customer conclusively invalidates it", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    const originalRun = h.sql.run.bind(h.sql);
    h.sql.run = async (statement, params) =>
      statement.startsWith("UPDATE stripe_subscription_checkout_intents SET state = 'dispatched'")
        ? { rows: [], changes: 0 }
        : await originalRun(statement, params);
    const input = { organizationId: ORG, reference: "prepared-customer", planKey: PLAN_KEY };
    await expect(h.subscriptions.begin(input)).rejects.toMatchObject({
      code: "subscription_checkout_pending",
    });
    h.sql.run = originalRun;
    h.state.failOnce.add(`/v1/prices/${PRICE}`);
    await expect(h.subscriptions.begin(input)).rejects.toBeDefined();
    expect(
      await h.sql.query("SELECT state FROM stripe_subscription_checkout_intents WHERE org_id = ?", [
        ORG,
      ]),
    ).toEqual([{ state: "prepared" }]);
    await originalRun(
      "UPDATE stripe_billing_customers SET customer_id = 'cus_other' WHERE org_id = ?",
      [ORG],
    );
    h.state.customers.set(
      "cus_other",
      object("cus_other", "customer", {
        metadata: { organizationId: ORG, takoserverPurpose: "hosted_subscription" },
      }),
    );
    await expect(h.subscriptions.begin(input)).rejects.toMatchObject({
      code: "subscription_checkout_invalidated",
    });
    expect(
      await h.subscriptions.begin({
        organizationId: ORG,
        reference: "new-customer",
        planKey: PLAN_KEY,
      }),
    ).toMatchObject({ state: "open", id: "cs_created_1" });
    expect(h.state.sessions.get("cs_created_1")?.customer).toBe("cus_other");
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
  });

  test("a Price identity cannot be reused for different registered cash or inclusion terms", async () => {
    const h = await fixture();
    await h.sql.run(
      `INSERT OR IGNORE INTO stripe_billing_price_identity
       (livemode,price_id,plan_key,amount_minor,included_minor,period_months) VALUES (0,?,?,?,?,1)`,
      [PRICE, PLAN_KEY, MONTHLY_MINOR + 1, INCLUDED_MINOR],
    );
    await expect(
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "price-identity-conflict",
        planKey: PLAN_KEY,
      }),
    ).rejects.toMatchObject({ code: "price_identity_conflict" });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(0);
  });

  test("rejected later pricing revision leaves the durable R1 snapshot unchanged and R1 can restart", async () => {
    const h = await fixture();
    await h.subscriptions.read(ORG);
    const before = await h.sql.query(
      "SELECT revision,config_json FROM stripe_billing_pricing ORDER BY revision",
    );
    const identities = await h.sql.query(
      "SELECT * FROM stripe_billing_price_identity ORDER BY price_id",
    );
    const context = {
      sql: h.sql,
      clock: () => new Date(NOW),
      credit: async () => "already_credited" as const,
      creditedFunding: async () => new Set<string>(),
    };
    const client = createStripeBillingClient({ secretKey: KEY, fetch: fakeStripe(h.state) });
    const changed = createStripeBilling({
      client,
      context,
      pricing: pricing("candidate-r4", INCLUDED_MINOR + 1),
      consoleOrigin: "https://console.example.test",
    });
    await expect(changed.subscriptions.read(ORG)).rejects.toMatchObject({
      code: "price_identity_conflict",
    });
    expect(
      await h.sql.query(
        "SELECT revision,config_json FROM stripe_billing_pricing ORDER BY revision",
      ),
    ).toEqual(before);
    expect(
      await h.sql.query("SELECT * FROM stripe_billing_price_identity ORDER BY price_id"),
    ).toEqual(identities);
    const restarted = createStripeBilling({
      client,
      context,
      pricing: pricing(),
      consoleOrigin: "https://console.example.test",
    });
    expect(await restarted.subscriptions.read(ORG)).toBeNull();
  });

  test("reconcile alone recovers dispatched Checkout and cancellation without another POST", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    h.state.loseCheckoutAck = true;
    const started = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "background-checkout",
      planKey: PLAN_KEY,
    });
    expect(started.state).toBe("pending");
    await h.reconcile();
    expect(
      await h.sql.query(
        "SELECT state,session_id FROM stripe_subscription_checkout_intents WHERE id = ?",
        [started.id],
      ),
    ).toEqual([{ state: "session_known", session_id: "cs_created_1" }]);
    const session = h.state.sessions.get("cs_created_1");
    h.state.sessions.set("cs_created_1", {
      ...session,
      status: "complete",
      payment_status: "paid",
      subscription: "sub_created_1",
    });
    h.state.subscriptions.set("sub_created_1", subscription({ id: "sub_created_1" }));
    await h.reconcile();
    expect(
      await h.sql.query("SELECT state FROM stripe_subscription_checkout_intents WHERE id = ?", [
        started.id,
      ]),
    ).toEqual([{ state: "associated" }]);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    const cancellation = await fixture();
    expect(
      (
        await deliver(
          cancellation.app,
          event("customer.subscription.updated", SUBSCRIPTION, "subscription"),
        )
      ).status,
    ).toBe(200);
    const ref = String((await cancellation.subscriptions.read(ORG))?.subscriptionRef);
    cancellation.state.loseCancelAck = true;
    expect(
      await cancellation.subscriptions.change({
        organizationId: ORG,
        reference: "background-cancel",
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: ref,
      }),
    ).toMatchObject({ state: "pending" });
    await cancellation.reconcile();
    expect(
      await cancellation.sql.query(
        "SELECT state FROM stripe_subscription_cancellation_intents WHERE org_id = ?",
        [ORG],
      ),
    ).toEqual([{ state: "verified" }]);
    expect(
      cancellation.state.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === `/v1/subscriptions/${SUBSCRIPTION}`,
      ),
    ).toHaveLength(1);
  });

  test("reconcile reports all outstanding custody rows after a fresh handle crosses its 100-row cursor", async () => {
    const h = await fixture();
    await h.subscriptions.read(ORG);
    await h.sql.batch(
      Array.from({ length: 101 }, (_, index) => ({
        sql: `INSERT INTO stripe_subscription_checkout_intents
          (id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,
           included_minor,livemode,state,created_at,updated_at)
          VALUES (?,?,'bulk','unverified',?,?,?,?,?,0,'dispatched',?,?)`,
        params: [
          `sci_bulk_${String(index).padStart(3, "0")}`,
          `org_bulk_${index}`,
          PLAN_KEY,
          REVISION,
          PRICE,
          MONTHLY_MINOR,
          INCLUDED_MINOR,
          NOW.toISOString(),
          NOW.toISOString(),
        ],
      })),
    );
    const first = await h.reconcile();
    expect(first.billing?.truncated).toBe(true);
    expect(first.billing?.unresolved).toBeGreaterThanOrEqual(101);
    expect(
      await h.sql.query(
        "SELECT cursor FROM stripe_subscription_custody_reconcile WHERE stream = 'checkout'",
      ),
    ).toEqual([{ cursor: "sci_bulk_099" }]);
    // Simulate a separately verified last row while the first hundred still await proof.
    await h.sql.run(
      "UPDATE stripe_subscription_checkout_intents SET state = 'expired', session_id = 'cs_bulk_100' WHERE id = 'sci_bulk_100'",
    );
    const fresh = createStripeBilling({
      client: createStripeBillingClient({ secretKey: KEY, fetch: fakeStripe(h.state) }),
      context: {
        sql: h.sql,
        clock: () => new Date(NOW),
        credit: async () => "already_credited" as const,
        creditedFunding: async () => new Set<string>(),
      },
      pricing: pricing(),
      consoleOrigin: "https://console.example.test",
    });
    const second = await fresh.reconcile();
    expect(second.truncated).toBe(false);
    expect(second.unresolved).toBeGreaterThanOrEqual(100);
    expect(
      await h.sql.query(
        "SELECT cursor FROM stripe_subscription_custody_reconcile WHERE stream = 'checkout'",
      ),
    ).toEqual([{ cursor: null }]);
  });

  test("lost Checkout ACK traverses every bounded page before binding a delayed visible Session", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    h.state.loseCheckoutAck = true;
    const input = { organizationId: ORG, reference: "lost-ack-many-pages", planKey: PLAN_KEY };
    const pending = await h.subscriptions.begin(input);
    expect(pending.state).toBe("pending");
    const exact = h.state.sessions.get("cs_created_1");
    expect(exact).toBeDefined();
    h.state.sessions = new Map([
      ...Array.from(
        { length: 101 },
        (_, index) =>
          [
            `cs_noise_${index}`,
            object(`cs_noise_${index}`, "checkout.session", {
              metadata: {},
              client_reference_id: "not_ours",
            }),
          ] as const,
      ),
      ["cs_created_1", exact as ObjectRecord],
    ]);
    const replay = await h.subscriptions.begin(input);
    expect(replay).toMatchObject({ state: "open", id: "cs_created_1" });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "GET" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ).length,
    ).toBeGreaterThanOrEqual(3);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
  });

  test("Checkout association binds its first customer and subscription only after exact paid proof", async () => {
    const h = await fixture();
    await h.sql.run("DELETE FROM stripe_billing_associations WHERE org_id = ?", [ORG]);
    await h.sql.run("DELETE FROM stripe_subscription_checkout_intents WHERE org_id = ?", [ORG]);
    await h.sql.run("DELETE FROM stripe_billing_customers WHERE org_id = ?", [ORG]);
    const first = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "associate-first",
      planKey: PLAN_KEY,
    });
    expect(first.state).toBe("open");
    const session = h.state.sessions.get(first.id);
    expect(session?.customer).toBe("cus_created_1");
    expect(
      await h.sql.query("SELECT * FROM stripe_billing_customers WHERE org_id = ?", [ORG]),
    ).toEqual([]);
    h.state.sessions.set(first.id, {
      ...session,
      status: "complete",
      payment_status: "paid",
      subscription: "sub_created_1",
    });
    h.state.subscriptions.set(
      "sub_created_1",
      subscription({ id: "sub_created_1", customer: "cus_created_1" }),
    );
    const immediate = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "associate-first",
      planKey: PLAN_KEY,
    });
    expect(immediate).toMatchObject({ id: first.id, state: "associated" });
    if (immediate.state !== "associated") throw new Error("expected associated Checkout");
    expect(immediate.subscriptionRef).toMatch(/^sra_[0-9a-f]{64}$/u);
    const delivered = await deliver(
      h.app,
      event("checkout.session.completed", first.id, "checkout.session"),
    );
    expect(delivered.status).toBe(200);
    expect(
      await h.sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?", [ORG]),
    ).toEqual([{ customer_id: "cus_created_1" }]);
    expect(
      await h.sql.query(
        "SELECT org_id, customer_id, session_id FROM stripe_billing_associations WHERE subscription_id = ?",
        ["sub_created_1"],
      ),
    ).toEqual([{ org_id: ORG, customer_id: "cus_created_1", session_id: first.id }]);
    expect((await h.subscriptions.read(ORG))?.subscriptionRef).toBe(immediate.subscriptionRef);
    expect(
      await h.subscriptions.begin({
        organizationId: ORG,
        reference: "associate-first",
        planKey: PLAN_KEY,
      }),
    ).toEqual(immediate);
    await expect(
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "associate-second",
        planKey: PLAN_KEY,
      }),
    ).rejects.toMatchObject({ code: "subscription_checkout_pending" });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    h.state.subscriptions.set(
      "sub_created_1",
      subscription({ id: "sub_created_1", customer: "cus_created_1", status: "canceled" }),
    );
    expect(
      (
        await deliver(
          h.app,
          event("customer.subscription.deleted", "sub_created_1", "subscription"),
        )
      ).status,
    ).toBe(200);
    const second = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "associate-second",
      planKey: PLAN_KEY,
    });
    expect(second).toMatchObject({ state: "open", id: "cs_created_2" });
    const secondSession = h.state.sessions.get(second.id);
    expect(secondSession?.customer).toBe("cus_created_1");
    h.state.sessions.set(second.id, {
      ...secondSession,
      status: "complete",
      payment_status: "paid",
      subscription: "sub_created_2",
    });
    h.state.subscriptions.set(
      "sub_created_2",
      subscription({ id: "sub_created_2", customer: "cus_created_1" }),
    );
    expect(
      (await deliver(h.app, event("checkout.session.completed", second.id, "checkout.session")))
        .status,
    ).toBe(200);
    expect((await h.subscriptions.read(ORG))?.subscriptionId).toBe("sub_created_2");
    const currentRef = (await h.subscriptions.read(ORG))?.subscriptionRef;
    expect(currentRef).not.toBe(immediate.subscriptionRef);
    expect(
      await h.subscriptions.begin({
        organizationId: ORG,
        reference: "associate-first",
        planKey: PLAN_KEY,
      }),
    ).toEqual(immediate);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(2);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(0);
    h.state.subscriptions.set(
      "sub_created_2",
      subscription({ id: "sub_created_2", customer: "cus_created_1", status: "canceled" }),
    );
    expect(
      (
        await deliver(
          h.app,
          event("customer.subscription.deleted", "sub_created_2", "subscription"),
        )
      ).status,
    ).toBe(200);
    const third = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "associate-third",
      planKey: PLAN_KEY,
    });
    expect(third).toMatchObject({ state: "open", id: "cs_created_3" });
    expect(
      await h.sql.query(
        "SELECT subscription_id, association_generation FROM stripe_billing_associations WHERE org_id = ? ORDER BY association_generation",
        [ORG],
      ),
    ).toEqual([
      { subscription_id: "sub_created_1", association_generation: 1 },
      { subscription_id: "sub_created_2", association_generation: 2 },
    ]);
    await h.sql.run(
      "INSERT INTO stripe_billing_customers (org_id, customer_id, created_at) VALUES ('org_foreign', 'cus_foreign', ?)",
      [NOW.toISOString()],
    );
    const replayA = () =>
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "associate-first",
        planKey: PLAN_KEY,
      });
    await h.sql.run(
      "UPDATE stripe_billing_associations SET org_id = 'org_foreign' WHERE subscription_id = 'sub_created_1'",
    );
    await expect(replayA()).rejects.toMatchObject({ code: "subscription_checkout_unresolved" });
    await h.sql.run(
      "UPDATE stripe_billing_associations SET org_id = ? WHERE subscription_id = 'sub_created_1'",
      [ORG],
    );
    await h.sql.run(
      "UPDATE stripe_billing_associations SET plan_key = 'wrong' WHERE subscription_id = 'sub_created_1'",
    );
    await expect(replayA()).rejects.toMatchObject({ code: "subscription_checkout_unresolved" });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(3);
    expect((await h.ledger.wallet(ORG)).settledMicros).toBe(0);
  });

  test("customer binding conflict and foreign Checkout line refuse association without money writes", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    const first = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "conflicting-customer",
      planKey: PLAN_KEY,
    });
    const session = h.state.sessions.get(first.id);
    h.state.sessions.set(first.id, {
      ...session,
      status: "complete",
      payment_status: "paid",
      subscription: "sub_created_1",
      customer: "cus_foreign",
    });
    h.state.subscriptions.set(
      "sub_created_1",
      subscription({ id: "sub_created_1", customer: "cus_foreign" }),
    );
    await h.sql.run(
      "INSERT INTO stripe_billing_customers (org_id, customer_id, created_at) VALUES ('org_foreign', 'cus_foreign', ?)",
      [NOW.toISOString()],
    );
    expect(
      (await deliver(h.app, event("checkout.session.completed", first.id, "checkout.session")))
        .status,
    ).toBe(200);
    expect(
      await h.sql.query("SELECT * FROM stripe_billing_associations WHERE subscription_id = ?", [
        "sub_created_1",
      ]),
    ).toEqual([]);
    h.state.sessionLines.set(first.id, [
      { id: "li_wrong", price: { id: "price_wrong" }, quantity: 1 },
    ]);
    expect(
      (
        await h.subscriptions.begin({
          organizationId: ORG,
          reference: "conflicting-customer",
          planKey: PLAN_KEY,
        })
      ).state,
    ).toBe("pending");
    expect(
      await h.sql.query("SELECT * FROM stripe_billing_grants WHERE source_id = ?", [first.id]),
    ).toEqual([]);
  });

  test("first-Checkout customer binding race fails closed instead of adopting the wrong customer", async () => {
    const h = await fixture();
    await clearHistoricalSubscription(h);
    await h.sql.run("DELETE FROM stripe_billing_customers WHERE org_id = ?", [ORG]);
    const first = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "customer-race",
      planKey: PLAN_KEY,
    });
    expect(first.state).toBe("open");
    await h.sql.run(
      "INSERT INTO stripe_billing_customers (org_id, customer_id, created_at) VALUES (?, 'cus_conflict', ?)",
      [ORG, NOW.toISOString()],
    );
    h.state.sessions.set(first.id, {
      ...h.state.sessions.get(first.id),
      status: "complete",
      payment_status: "paid",
      subscription: "sub_created_1",
    });
    h.state.subscriptions.set(
      "sub_created_1",
      subscription({ id: "sub_created_1", customer: "cus_created_1" }),
    );
    expect(
      (await deliver(h.app, event("checkout.session.completed", first.id, "checkout.session")))
        .status,
    ).toBe(200);
    expect(
      await h.sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?", [ORG]),
    ).toEqual([{ customer_id: "cus_conflict" }]);
    expect(
      await h.sql.query("SELECT * FROM stripe_billing_associations WHERE subscription_id = ?", [
        "sub_created_1",
      ]),
    ).toEqual([]);
  });

  test("delayed invoice keeps its historical A binding after the current subscription projection becomes B", async () => {
    const h = await fixture();
    await h.sql.run(
      `INSERT INTO stripe_subscription_checkout_intents
       (id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,state,session_id,subscription_id,created_at,updated_at)
       VALUES ('sci_new',?, 'new', 'new', ?, ?, ?, ?, ?, 0, ?, 'associated', 'cs_new', 'sub_new', ?, ?)`,
      [
        ORG,
        PLAN_KEY,
        REVISION,
        PRICE,
        MONTHLY_MINOR,
        INCLUDED_MINOR,
        CUSTOMER,
        NOW.toISOString(),
        NOW.toISOString(),
      ],
    );
    await h.sql.run(
      `INSERT INTO stripe_billing_associations
       (subscription_id,org_id,customer_id,livemode,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,session_id,association_generation,created_at)
       VALUES ('sub_new', ?, ?, 0, ?, ?, ?, ?, ?, 'cs_new', 2, ?)`,
      [ORG, CUSTOMER, PLAN_KEY, REVISION, PRICE, MONTHLY_MINOR, INCLUDED_MINOR, NOW.toISOString()],
    );
    h.state.subscriptions.set("sub_new", subscription({ id: "sub_new" }));
    expect(
      (await deliver(h.app, event("customer.subscription.updated", "sub_new", "subscription")))
        .status,
    ).toBe(200);
    expect((await h.subscriptions.read(ORG))?.subscriptionId).toBe("sub_new");
    h.state.subscriptions.set("sub_new", subscription({ id: "sub_new", status: "canceled" }));
    expect(
      (await deliver(h.app, event("customer.subscription.deleted", "sub_new", "subscription")))
        .status,
    ).toBe(200);
    expect((await h.subscriptions.read(ORG))?.status).toBe("canceled");
    // An old, valid A event must not roll the terminal B projection backward.
    expect(
      (await deliver(h.app, event("customer.subscription.updated", SUBSCRIPTION, "subscription")))
        .status,
    ).toBe(200);
    expect((await h.subscriptions.read(ORG))?.subscriptionId).toBe("sub_new");
    expect(
      await h.subscriptions.begin({
        organizationId: ORG,
        reference: "after-terminal-b",
        planKey: PLAN_KEY,
      }),
    ).toMatchObject({ state: "open" });
    expect((await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"))).status).toBe(
      200,
    );
    expect(
      await h.sql.query(
        "SELECT subscription_id, org_id, funding_ref FROM stripe_billing_grants WHERE source_id = 'in_billing_test'",
      ),
    ).toEqual([
      { subscription_id: SUBSCRIPTION, org_id: ORG, funding_ref: "stripe:invoice:in_billing_test" },
    ]);
    expect((await h.subscriptions.read(ORG))?.subscriptionId).toBe("sub_new");
  });

  test("lost cancellation ACK is GET-only pending then target-bound verified; stale A to B replay is refused", async () => {
    const h = await fixture();
    expect(
      (await deliver(h.app, event("customer.subscription.updated", SUBSCRIPTION, "subscription")))
        .status,
    ).toBe(200);
    const ref = String((await h.subscriptions.read(ORG))?.subscriptionRef);
    h.state.loseCancelAck = true;
    const input = {
      organizationId: ORG,
      reference: "cancel-lost-ack",
      cancelAtPeriodEnd: true,
      expectedSubscriptionRef: ref,
    };
    const pending = await h.subscriptions.change(input);
    expect(pending).toEqual({ state: "pending", subscriptionRef: ref });
    const verified = await h.subscriptions.change(input);
    expect(verified).toEqual({
      state: "verified",
      subscriptionRef: ref,
      effectiveAt: "2026-11-01T00:00:00.000Z",
    });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === `/v1/subscriptions/${SUBSCRIPTION}`,
      ),
    ).toHaveLength(1);
    await h.sql.run(
      "UPDATE stripe_billing_subscriptions SET subscription_id = 'sub_new_target' WHERE org_id = ?",
      [ORG],
    );
    await expect(h.subscriptions.change(input)).rejects.toMatchObject({
      code: "subscription_management_conflict",
    });
    await expect(
      h.subscriptions.change({ ...input, reference: "cancel-new-key" }),
    ).rejects.toMatchObject({ code: "subscription_management_conflict" });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === `/v1/subscriptions/${SUBSCRIPTION}`,
      ),
    ).toHaveLength(1);
  });

  test("terminal cancellation accepts Stripe's same-second proof but rejects the preceding second", async () => {
    let observedNow = new Date("2026-10-14T12:00:00.987Z");
    const h = await fixture(pricing(), () => observedNow);
    expect(
      (await deliver(h.app, event("customer.subscription.updated", SUBSCRIPTION, "subscription")))
        .status,
    ).toBe(200);
    const ref = String((await h.subscriptions.read(ORG))?.subscriptionRef);
    h.state.loseCancelAck = true;
    const input = {
      organizationId: ORG,
      reference: "terminal-second",
      cancelAtPeriodEnd: true,
      expectedSubscriptionRef: ref,
    };
    expect(await h.subscriptions.change(input)).toMatchObject({ state: "pending" });
    observedNow = new Date("2026-11-01T00:00:01.000Z");
    h.state.subscriptions.set(
      SUBSCRIPTION,
      subscription({
        status: "canceled",
        cancel_at_period_end: true,
        ended_at: PERIOD_END,
        canceled_at: Math.floor(Date.parse("2026-10-14T12:00:00.987Z") / 1000) - 1,
      }),
    );
    expect(await h.subscriptions.change(input)).toMatchObject({ state: "pending" });
    h.state.subscriptions.set(
      SUBSCRIPTION,
      subscription({
        status: "canceled",
        cancel_at_period_end: true,
        ended_at: PERIOD_END,
        canceled_at: Math.floor(Date.parse("2026-10-14T12:00:00.987Z") / 1000),
      }),
    );
    expect(await h.subscriptions.change(input)).toEqual({
      state: "verified",
      subscriptionRef: ref,
      effectiveAt: "2026-11-01T00:00:00.000Z",
    });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === `/v1/subscriptions/${SUBSCRIPTION}`,
      ),
    ).toHaveLength(1);
  });

  test("cancellation permits archived exact Price but refuses changed historical amount", async () => {
    const h = await fixture();
    expect(
      (await deliver(h.app, event("customer.subscription.updated", SUBSCRIPTION, "subscription")))
        .status,
    ).toBe(200);
    const ref = String((await h.subscriptions.read(ORG))?.subscriptionRef);
    h.state.prices.set(PRICE, { ...h.state.prices.get(PRICE), active: false });
    expect(
      await h.subscriptions.change({
        organizationId: ORG,
        reference: "inactive-price",
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: ref,
      }),
    ).toMatchObject({ state: "verified", subscriptionRef: ref });
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === `/v1/subscriptions/${SUBSCRIPTION}`,
      ),
    ).toHaveLength(1);
    const changed = await fixture();
    expect(
      (
        await deliver(
          changed.app,
          event("customer.subscription.updated", SUBSCRIPTION, "subscription"),
        )
      ).status,
    ).toBe(200);
    const changedRef = String((await changed.subscriptions.read(ORG))?.subscriptionRef);
    changed.state.prices.set(PRICE, {
      ...changed.state.prices.get(PRICE),
      unit_amount: MONTHLY_MINOR + 1,
    });
    await expect(
      changed.subscriptions.change({
        organizationId: ORG,
        reference: "changed-price",
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: changedRef,
      }),
    ).rejects.toMatchObject({ reason: "unsupported_plan" });
    expect(
      await h.sql.query("SELECT * FROM stripe_billing_grants WHERE source_type = 'invoice'"),
    ).toEqual([]);
  });

  test("INSERT-race verified A replay rechecks the current B target before any POST", async () => {
    const h = await fixture();
    expect(
      (await deliver(h.app, event("customer.subscription.updated", SUBSCRIPTION, "subscription")))
        .status,
    ).toBe(200);
    const ref = String((await h.subscriptions.read(ORG))?.subscriptionRef);
    const originalRun = h.sql.run.bind(h.sql);
    let interleaved = false;
    h.sql.run = async (statement, params) => {
      if (
        !interleaved &&
        statement.startsWith("INSERT OR IGNORE INTO stripe_subscription_cancellation_intents")
      ) {
        interleaved = true;
        const committed = await originalRun(statement, params);
        expect(committed.changes).toBe(1);
        await originalRun(
          "UPDATE stripe_subscription_cancellation_intents SET state = 'verified', effective_at = ? WHERE org_id = ?",
          ["2026-11-01T00:00:00.000Z", ORG],
        );
        await originalRun(
          "UPDATE stripe_billing_subscriptions SET subscription_id = 'sub_new_target' WHERE org_id = ?",
          [ORG],
        );
        return { rows: committed.rows, changes: 0 };
      }
      return await originalRun(statement, params);
    };
    await expect(
      h.subscriptions.change({
        organizationId: ORG,
        reference: "cancel-race",
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: ref,
      }),
    ).rejects.toMatchObject({ code: "subscription_management_conflict" });
    expect(interleaved).toBe(true);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === `/v1/subscriptions/${SUBSCRIPTION}`,
      ),
    ).toHaveLength(0);
    expect(
      await h.sql.query(
        "SELECT state, subscription_id FROM stripe_subscription_cancellation_intents WHERE org_id = ?",
        [ORG],
      ),
    ).toEqual([{ state: "verified", subscription_id: SUBSCRIPTION }]);
  });
  test("returns signed webhook errors without leaking Stripe diagnostics", async () => {
    const h = await fixture();
    const body = event("invoice.paid", "in_billing_test", "invoice");
    const serialized = JSON.stringify(body);
    const badSignature = await h.app.fetch(
      new Request("https://api.example.test/v1/payments/stripe/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature(serialized).replace(/v1=.*/u, `v1=${"0".repeat(64)}`),
        },
        body: serialized,
      }),
    );
    expect(badSignature.status).toBe(400);
    expect(await errorCode(badSignature)).toBe("invalid_signature");
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMicros: 0 });
  });
});
