import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
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
};

function object(id: string, type: string, extra: ObjectRecord = {}): ObjectRecord {
  return { id, object: type, livemode: false, ...extra };
}

function pricing() {
  const billingConfig = {
    schemaVersion: 1,
    revision: REVISION,
    effectiveAt: "2026-10-01T00:00:00.000Z",
    currency: "USD",
    holdTtlSeconds: 86_400,
    freeIncludedMinor: 0,
    purchaseCreditExpiry: { kind: "none" },
    plans: { [PLAN_KEY]: { includedMinor: INCLUDED_MINOR, stripePriceId: PRICE } },
    meters: {},
  };
  const authored = {
    authoringVersion: 1,
    planIds: { free: "free", subscription: PLAN_KEY, usage: "usage" },
    billingConfig,
    checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
    stripeMonthlyReview: {
      [PLAN_KEY]: { expectedAmountMinor: MONTHLY_MINOR, currency: "USD", interval: "month" },
    },
  };
  return compilePricingAuthoring(authored);
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

function initialState(): State {
  return {
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
  };
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
    if (value !== null) filtered = filtered.filter((item) => item[filter] === value);
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
          metadata: {
            organizationId: form.get("metadata[organizationId]"),
            takoserverPurpose: form.get("metadata[takoserverPurpose]"),
          },
        });
        state.customers.set(id, created);
        return Response.json(created);
      }
      if (url.pathname === "/v1/checkout/sessions") {
        const id = `cs_created_${state.nextCheckout++}`;
        const created = object(id, "checkout.session", {
          url: `https://checkout.stripe.com/c/pay/${id}`,
          mode: form.get("mode"),
          status: "open",
          customer: form.get("customer"),
          metadata: {
            organizationId: form.get("metadata[organizationId]"),
            planKey: form.get("metadata[planKey]"),
            pricingRevision: form.get("metadata[pricingRevision]"),
            takoserverPurpose: form.get("metadata[takoserverPurpose]"),
          },
        });
        state.sessions.set(id, created);
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

async function fixture(hostedPricing = pricing()) {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) database.exec(migration.sql);
  if (!MIGRATIONS.some((migration) => migration.name === "0093_stripe_billing.sql")) {
    database.exec(
      await Bun.file(new URL("../migrations/0093_stripe_billing.sql", import.meta.url)).text(),
    );
  }
  const sql = createSqliteSql(database);
  const now = () => new Date(NOW);
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
  const state = initialState();
  const setup = resolvePayment({
    hostedPricing,
    stripeSecretKey: KEY,
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
  test("paid recurring invoice credits once by invoice identity across event IDs and reconciliation", async () => {
    const h = await fixture();
    const first = await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect(first.status).toBe(200);
    const secondEvent = event("invoice.paid", "in_billing_test", "invoice");
    const second = await deliver(h.app, secondEvent);
    expect(second.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: INCLUDED_MINOR });
    expect(
      await h.sql.query(
        "SELECT funding_ref, kind, amount_minor, expires_at, period_start, period_end, pricing_revision FROM stripe_billing_grants",
      ),
    ).toEqual([
      {
        funding_ref: "stripe:invoice:in_billing_test",
        kind: "plan-included",
        amount_minor: INCLUDED_MINOR,
        expires_at: "2026-11-01T00:00:00.000Z",
        period_start: "2026-10-01T00:00:00.000Z",
        period_end: "2026-11-01T00:00:00.000Z",
        pricing_revision: REVISION,
      },
    ]);
    await h.sql.run("DELETE FROM stripe_events WHERE event_id = ?", [String(secondEvent.id)]);
    const report = await h.reconcile();
    expect(report.billing?.handlerVersion).toBe(1);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: INCLUDED_MINOR });
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
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: 0 });
    expect((await h.subscriptions.read(ORG))?.status).toBe("past_due");
    h.state.invoices.set("in_billing_test", invoice("in_billing_test"));
    const paid = await deliver(
      h.app,
      event("invoice.payment_failed", "in_billing_test", "invoice"),
    );
    expect(paid.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: INCLUDED_MINOR });
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
    expect((await h.ledger.wallet(ORG)).settledMinor).toBe(INCLUDED_MINOR);
    expect(
      (
        await h.sql.query("SELECT expires_at FROM wallet_credit_lots WHERE ref = ?", [
          "stripe:invoice:in_billing_test",
        ])
      )[0]?.expires_at,
    ).toBe("2026-11-01T00:00:00.000Z");
  });

  test("deferred signed event is revisited from Stripe history after its object becomes available", async () => {
    const h = await fixture();
    h.state.invoices.delete("in_billing_test");
    const historicalEvent = event("invoice.paid", "in_billing_test", "invoice");
    h.state.events.set(String(historicalEvent.id), historicalEvent);

    const deferred = await deliver(h.app, historicalEvent);
    expect(deferred.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: 0 });
    expect(
      await h.sql.query("SELECT outcome, handler_version FROM stripe_events WHERE event_id = ?", [
        String(historicalEvent.id),
      ]),
    ).toEqual([{ outcome: "deferred", handler_version: 0 }]);

    h.state.invoices.set("in_billing_test", invoice("in_billing_test"));
    const report = await h.reconcile();
    expect(report.billing?.handlerVersion).toBe(1);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: INCLUDED_MINOR });
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
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: INCLUDED_MINOR });
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
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: 0 });
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
        "SELECT target_revoked_minor, debit_minor FROM stripe_billing_refunds WHERE refund_id = ?",
        ["re_page_during_retry"],
      ),
    ).toEqual([{ target_revoked_minor: 240, debit_minor: 240 }]);

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
        "SELECT target_revoked_minor, debit_minor FROM stripe_billing_refunds WHERE refund_id = ?",
        ["re_hosted_during_legacy_failure"],
      ),
    ).toEqual([{ target_revoked_minor: 240, debit_minor: 240 }]);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMinor: INCLUDED_MINOR - 240,
      availableMinor: INCLUDED_MINOR - 240,
    });
    expect(
      await h.sql.query("SELECT cursor FROM stripe_billing_reconcile WHERE stream = ?", [
        "refunds",
      ]),
    ).toEqual([{ cursor: null }]);
  });

  test("rejects noncanonical invoice, customer, account and period facts without funding", async () => {
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
      expect((await h.ledger.wallet(ORG)).settledMinor, label).toBe(0);
      expect(
        await h.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_grants"),
        label,
      ).toEqual([{ count: 0 }]);
    }
  });

  test("ignores signed live-mode and connected-account events before any Stripe object read", async () => {
    for (const mode of [{ livemode: true }, { account: "acct_connected" }]) {
      const h = await fixture();
      const response = await deliver(
        h.app,
        event("invoice.paid", "in_billing_test", "invoice", mode),
      );
      expect(response.status).toBe(200);
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
      settledMinor: INCLUDED_MINOR,
      frozenMinor: INCLUDED_MINOR,
      availableMinor: 0,
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
      settledMinor: INCLUDED_MINOR,
      frozenMinor: 0,
      availableMinor: INCLUDED_MINOR,
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
    expect((await h.ledger.wallet(ORG)).settledMinor).toBe(INCLUDED_MINOR - 240);
    expect(
      await h.sql.query(
        "SELECT refund_id, target_revoked_minor, debit_minor, receivable_minor FROM stripe_billing_refunds",
      ),
    ).toEqual([
      {
        refund_id: "re_billing_test",
        target_revoked_minor: 240,
        debit_minor: 240,
        receivable_minor: 0,
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
      settledMinor: INCLUDED_MINOR,
      availableMinor: 0,
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
      settledMinor: INCLUDED_MINOR - 240,
      availableMinor: INCLUDED_MINOR - 240,
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
      settledMinor: INCLUDED_MINOR - 240,
      frozenMinor: INCLUDED_MINOR - 240,
      availableMinor: 0,
    });
    expect(
      await h.sql.query("SELECT refund_id, cumulative_refunded_minor FROM stripe_billing_refunds"),
    ).toEqual([{ refund_id: "re_succeeded_partial", cumulative_refunded_minor: 25 }]);

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
      settledMinor: INCLUDED_MINOR - 240,
      frozenMinor: 0,
      availableMinor: INCLUDED_MINOR - 240,
    });
  });

  test("keeps a lot frozen while the charge refund total is ahead of successful refund objects", async () => {
    const h = await fixture();
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 25 }));
    const lagging = await deliver(h.app, event("invoice.paid", "in_billing_test", "invoice"));
    expect(lagging.status).toBe(200);
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: 0, availableMinor: 0 });
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
      settledMinor: INCLUDED_MINOR - 240,
      availableMinor: INCLUDED_MINOR - 240,
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
      await h.ledger.debitUsage({ organizationId: ORG, reference: "run-spend", amountMinor: 500 }),
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
        "SELECT target_revoked_minor, debit_minor, receivable_minor FROM stripe_billing_refunds",
      ),
    ).toEqual([{ target_revoked_minor: 240, debit_minor: 240, receivable_minor: 0 }]);

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
        "SELECT refund_id, target_revoked_minor, debit_minor, receivable_minor FROM stripe_billing_refunds ORDER BY cumulative_refunded_minor",
      ),
    ).toEqual([
      { refund_id: "re_partial", target_revoked_minor: 240, debit_minor: 240, receivable_minor: 0 },
      {
        refund_id: "re_final",
        target_revoked_minor: INCLUDED_MINOR,
        debit_minor: 460,
        receivable_minor: 500,
      },
    ]);
    expect(await h.ledger.wallet(ORG)).toMatchObject({
      settledMinor: 0,
      refundReceivableMinor: 500,
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
      await h.sql.query("SELECT refund_id, cumulative_refunded_minor FROM stripe_billing_refunds"),
    ).toEqual([{ refund_id: "re_b", cumulative_refunded_minor: 25 }]);

    h.state.refunds.set("re_a", { ...refundA, status: "succeeded" });
    h.state.charges.set("ch_billing_test", charge({ amount_refunded: 50 }));
    expect((await deliver(h.app, event("refund.updated", "re_a", "refund"))).status).toBe(200);
    expect(
      await h.sql.query(
        "SELECT refund_id, cumulative_refunded_minor, target_revoked_minor FROM stripe_billing_refunds ORDER BY cumulative_refunded_minor",
      ),
    ).toEqual([
      { refund_id: "re_b", cumulative_refunded_minor: 25, target_revoked_minor: 240 },
      { refund_id: "re_a", cumulative_refunded_minor: 50, target_revoked_minor: 480 },
    ]);
    expect((await h.ledger.wallet(ORG)).settledMinor).toBe(INCLUDED_MINOR - 480);
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
      await h.ledger.hold({ organizationId: ORG, reference: "live-run-hold", amountMinor: 500 }),
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
      settledMinor: 0,
      heldMinor: 0,
      availableMinor: 0,
    });
    expect(
      await h.sql.query(
        "SELECT type, held_delta FROM ledger WHERE ref = ? ORDER BY created_at, id",
        ["live-run-hold"],
      ),
    ).toContainEqual({ type: "release", held_delta: -500 });
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
        "SELECT target_revoked_minor FROM stripe_billing_refunds WHERE refund_id = ?",
        ["re_full_subscription"],
      ),
    ).toEqual([{ target_revoked_minor: INCLUDED_MINOR }]);
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
    expect((await h.ledger.wallet(ORG)).availableMinor).toBe(0);
    expect(
      await h.sql.query(
        "SELECT funding_ref, amount_minor, expires_at FROM stripe_billing_grants WHERE source_id = ?",
        ["in_billing_test"],
      ),
    ).toEqual([
      {
        funding_ref: "stripe:invoice:in_billing_test",
        amount_minor: INCLUDED_MINOR,
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
      await h.sql.query("SELECT funding_ref, kind, amount_minor FROM stripe_billing_grants"),
    ).toEqual([{ funding_ref: "stripe:cs_purchase_test", kind: "purchased", amount_minor: 500 }]);
    expect((await h.ledger.wallet(ORG)).settledMinor).toBe(500);
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
    expect((await h.ledger.wallet(ORG)).availableMinor).toBe(1000);
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
    expect((await h.ledger.wallet(ORG)).settledMinor).toBe(0);
    expect(await h.sql.query("SELECT funding_ref FROM stripe_billing_grants")).toEqual([
      { funding_ref: "stripe:invoice:in_billing_test" },
    ]);
    expect(
      await h.sql.query("SELECT target_revoked_minor, debit_minor FROM stripe_billing_refunds"),
    ).toEqual([{ target_revoked_minor: INCLUDED_MINOR, debit_minor: INCLUDED_MINOR }]);
  });

  test("creates a customer and subscription Checkout idempotently from the configured plan", async () => {
    const h = await fixture();
    expect(h.subscriptions.planTable).toEqual(pricing().hostedPlanTable);
    await h.sql.run("DELETE FROM stripe_billing_customers WHERE org_id = ?", [ORG]);
    const input = { organizationId: ORG, reference: "hosted-subscription-001", planKey: PLAN_KEY };
    const first = await h.subscriptions.begin(input);
    const second = await h.subscriptions.begin(input);
    expect(first).toEqual(second);
    expect(first.url).toMatch(/^https:\/\/checkout\.stripe\.com\//u);
    const customerPosts = h.state.requests.filter(
      (request) => request.method === "POST" && new URL(request.url).pathname === "/v1/customers",
    );
    const checkoutPosts = h.state.requests.filter(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
    );
    expect(customerPosts).toHaveLength(1);
    expect(checkoutPosts).toHaveLength(1);
    expect((await checkoutPosts[0]?.clone().text()) ?? "").toContain("mode=subscription");
    expect(
      await h.sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id = ?", [ORG]),
    ).toEqual([{ customer_id: "cus_created_1" }]);
    await expect(
      h.subscriptions.begin({ ...input, planKey: "unconfigured" }),
    ).rejects.toMatchObject({ code: "unknown_plan" });
    await expect(
      h.subscriptions.begin({
        ...input,
        reference: "hosted-subscription-001",
        planKey: "unconfigured",
      }),
    ).rejects.toMatchObject({ code: "unknown_plan" });
  });

  test("allows only one pending subscription Checkout across concurrent references", async () => {
    const h = await fixture();
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
        "SELECT reference, session_id FROM stripe_billing_checkouts WHERE org_id = ?",
        [ORG],
      ),
    ).toHaveLength(1);
  });

  test("repairs a committed Checkout reservation after its session ID write fails without duplicating Stripe POST", async () => {
    const h = await fixture();
    const originalRun = h.sql.run.bind(h.sql);
    let failReservationWrite = true;
    h.sql.run = async (statement, params) => {
      if (
        failReservationWrite &&
        statement.startsWith("UPDATE stripe_billing_checkouts SET session_id")
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
    await expect(h.subscriptions.begin(input)).rejects.toBeInstanceOf(SqlError);
    expect(
      await h.sql.query(
        "SELECT session_id FROM stripe_billing_checkouts WHERE org_id = ? AND reference = ?",
        [ORG, input.reference],
      ),
    ).toEqual([{ session_id: null }]);
    const firstCheckoutPosts = h.state.requests.filter(
      (request) =>
        request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
    );
    expect(firstCheckoutPosts).toHaveLength(1);

    const repaired = await h.subscriptions.begin(input);
    expect(repaired.url).toBe("https://checkout.stripe.com/c/pay/cs_created_1");
    expect(
      await h.sql.query(
        "SELECT session_id FROM stripe_billing_checkouts WHERE org_id = ? AND reference = ?",
        [ORG, input.reference],
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

  test("replays a committed Checkout command after subscription activation with its original URL", async () => {
    const h = await fixture();
    const input = {
      organizationId: ORG,
      reference: "hosted-subscription-replay",
      planKey: PLAN_KEY,
    };
    const first = await h.subscriptions.begin(input);
    h.state.subscriptions.set(SUBSCRIPTION, subscription());
    expect(
      (await deliver(h.app, event("customer.subscription.updated", SUBSCRIPTION, "subscription")))
        .status,
    ).toBe(200);
    const replay = await h.subscriptions.begin(input);
    expect(replay).toEqual(first);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" && new URL(request.url).pathname === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
  });

  test("permits a new Checkout reference only after Stripe confirms the prior session is expired or its subscription canceled", async () => {
    const h = await fixture();
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
    h.state.subscriptions.set(SUBSCRIPTION, subscription({ status: "active" }));
    await expect(
      h.subscriptions.begin({
        organizationId: ORG,
        reference: "hosted-subscription-new",
        planKey: PLAN_KEY,
      }),
    ).rejects.toMatchObject({ code: "subscription_checkout_pending" });

    h.state.subscriptions.set(SUBSCRIPTION, subscription({ status: "canceled" }));
    expect(
      (await deliver(h.app, event("customer.subscription.deleted", SUBSCRIPTION, "subscription")))
        .status,
    ).toBe(200);
    const next = await h.subscriptions.begin({
      organizationId: ORG,
      reference: "hosted-subscription-new",
      planKey: PLAN_KEY,
    });
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
    });
    const second = await h.subscriptions.change({
      organizationId: ORG,
      reference: "cancel-subscription-001",
      cancelAtPeriodEnd: true,
    });
    expect(first).toMatchObject({
      subscriptionId: SUBSCRIPTION,
      status: "active",
      cancelAtPeriodEnd: true,
    });
    expect(second).toEqual(first);
    expect(
      h.state.requests.filter(
        (request) =>
          request.method === "POST" &&
          new URL(request.url).pathname === `/v1/subscriptions/${SUBSCRIPTION}`,
      ),
    ).toHaveLength(1);
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
    expect(await h.ledger.wallet(ORG)).toMatchObject({ settledMinor: 0 });
  });
});
