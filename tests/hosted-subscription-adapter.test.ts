import { describe, expect, test } from "bun:test";
import sharedPricing from "../config/shared-hosted-pricing.json";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import {
  assertHostedSubscriptionAdapterSchema,
  createHostedSubscriptionAdapter,
} from "../src/hosted-subscription-adapter.ts";
import {
  createStripeBilling,
  type StripeBillingSubscriptionExtensionContext,
} from "../src/stripe-billing.ts";
import {
  createStripeBillingClient,
  type StripeBillingObject,
} from "../src/stripe-billing-client.ts";
import { createStripeCustomerCustody } from "../src/stripe-customer-custody.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

const ORG = "org_actual_phase";
const SUB = "sub_actual_phase";
const START = "2026-10-01T00:00:00.000Z";
const NEXT = "2026-11-01T00:00:00.000Z";
const AFTER = "2026-12-01T00:00:00.000Z";
const unix = (at: string) => Date.parse(at) / 1000;
const clone = <T>(value: T): T => structuredClone(value);

async function fixture() {
  const { db, sql } = await createHostedBillingRealmTestDatabase();
  let at = START;
  const clock = () => new Date(at);
  await sql.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,?,?,?)", [
    ORG,
    "Actual phase",
    "prn_actual",
    START,
  ]);
  await seedHostedBillingRealmTestPin(sql, {
    accountId: "acct_actualphase",
    billingAuthority: "actual-phase-test",
  });
  const source = {
    ...clone(sharedPricing),
    plans: sharedPricing.plans.map((plan, index) => ({
      ...plan,
      stripePriceId: `price_actual${index === 0 ? "10" : "50"}`,
    })),
  };
  const pricing = compilePricingAuthoring({
    authoringVersion: 2,
    sharedPricing: source,
    planIds: { free: "free", usage: "usage" },
    billingConfig: {
      schemaVersion: 1,
      revision: source.revision,
      effectiveAt: START,
      currency: "USD",
      holdTtlSeconds: 300,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: Object.fromEntries(
        source.plans.map((plan) => [
          plan.planId,
          {
            includedMinor: Number(BigInt(plan.includedMicros) / 10000n),
            stripePriceId: plan.stripePriceId,
          },
        ]),
      ),
      meters: Object.fromEntries(
        Object.entries(source.meters)
          .filter(([, meter]) => meter.cloudflareCostMicros !== "0")
          .map(([name, meter]) => [
            name,
            {
              unit: meter.unit,
              rate: {
                numeratorMicros: (BigInt(meter.cloudflareCostMicros) * 3n).toString(),
                denominator: meter.quantity,
              },
            },
          ]),
      ),
    },
    checkout: { minimumMinor: 50, maximumMinor: 10000 },
  });
  const customers = new Map<string, StripeBillingObject>();
  const sessions = new Map<string, StripeBillingObject>();
  const subscriptions = new Map<string, StripeBillingObject>();
  const invoices = new Map<string, StripeBillingObject>();
  const charges = new Map<string, StripeBillingObject>();
  const refunds = new Map<string, StripeBillingObject>();
  const schedules = new Map<string, StripeBillingObject>();
  const calls: {
    method: string;
    path: string;
    key: string | null;
    form: Record<string, string>;
  }[] = [];
  let lose: "schedule" | "release" | null = null;
  let createGate: { entered(): void; resume: Promise<void> } | null = null;
  const nested = (form: Record<string, string>, prefix: string) =>
    Object.fromEntries(
      Object.entries(form)
        .filter(([name]) => name.startsWith(`${prefix}[`))
        .map(([name, value]) => [name.slice(prefix.length + 1, -1), value]),
    );
  const client = createStripeBillingClient({
    secretKey: "sk_test_actual_phase_never_a_credential",
    async fetch(request) {
      const url = new URL(request.url),
        path = url.pathname;
      const form = Object.fromEntries(new URLSearchParams(await request.text()));
      calls.push({
        method: request.method,
        path,
        key: request.headers.get("idempotency-key"),
        form,
      });
      if (request.method === "GET") {
        if (path === "/v1/account")
          return Response.json({ id: "acct_actualphase", object: "account" });
        const plan = source.plans.find((item) => path === `/v1/prices/${item.stripePriceId}`);
        if (plan)
          return Response.json({
            id: plan.stripePriceId,
            object: "price",
            livemode: false,
            active: true,
            currency: "usd",
            type: "recurring",
            billing_scheme: "per_unit",
            unit_amount: Number(BigInt(plan.monthlyPriceMicros) / 10000n),
            recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
          });
        if (path.endsWith("/line_items")) {
          const session = sessions.get(path.split("/").at(-2) ?? "");
          return Response.json({
            data: [
              {
                id: "li_actual",
                object: "item",
                price:
                  (session?.metadata as Record<string, unknown>)?.planKey === "hosted-50"
                    ? "price_actual50"
                    : "price_actual10",
                quantity: 1,
              },
            ],
            has_more: false,
          });
        }
        for (const [collection, rows] of [
          ["customers", customers],
          ["checkout/sessions", sessions],
          ["subscriptions", subscriptions],
          ["invoices", invoices],
          ["charges", charges],
          ["refunds", refunds],
          ["subscription_schedules", schedules],
        ] as const) {
          if (path === `/v1/${collection}`) {
            let data = [...rows.values()];
            if (collection === "refunds")
              data = data.filter(
                (row) =>
                  !url.searchParams.has("charge") || row.charge === url.searchParams.get("charge"),
              );
            if (collection === "checkout/sessions" && url.searchParams.has("payment_intent"))
              data = data.filter(
                (row) => row.payment_intent === url.searchParams.get("payment_intent"),
              );
            return Response.json({ data, has_more: false });
          }
          if (path.startsWith(`/v1/${collection}/`)) {
            const found = rows.get(path.slice(`/v1/${collection}/`.length));
            return found ? Response.json(found) : new Response("", { status: 404 });
          }
        }
        if (path === "/v1/events") return Response.json({ data: [], has_more: false });
        return new Response("", { status: 404 });
      }
      expect(request.headers.get("idempotency-key")).toBeTruthy();
      if (path === "/v1/customers") {
        const customer: StripeBillingObject = {
          id: "cus_actual_phase",
          object: "customer",
          livemode: false,
          metadata: nested(form, "metadata"),
        };
        customers.set(customer.id, customer);
        return Response.json(customer);
      }
      if (path === "/v1/checkout/sessions") {
        const session: StripeBillingObject = {
          id: "cs_actual_phase",
          object: "checkout.session",
          livemode: false,
          mode: "subscription",
          customer: form.customer,
          client_reference_id: form.client_reference_id,
          metadata: nested(form, "metadata"),
          status: "open",
          payment_status: "unpaid",
          subscription: null,
          invoice: null,
          after_expiration: null,
          recovered_from: null,
          currency: "usd",
          amount_subtotal: 1000,
          amount_total: 1000,
          created: unix(at),
          expires_at: unix(at) + 3600,
          url: "https://checkout.stripe.com/c/pay/cs_actual_phase",
        };
        sessions.set(session.id, session);
        return Response.json(session);
      }
      const sub = subscriptions.get(SUB);
      if (!sub) throw new Error("subscription missing before schedule/cancellation");
      if (path === "/v1/subscription_schedules") {
        createGate?.entered();
        if (createGate) await createGate.resume;
        expect(form).toEqual({ from_subscription: SUB });
        const schedule: StripeBillingObject = {
          id: "sub_sched_actual",
          object: "subscription_schedule",
          livemode: false,
          customer: sub.customer,
          subscription: SUB,
          status: "active",
          end_behavior: "release",
          metadata: {},
          default_settings: {},
          phases: [
            {
              start_date: sub.current_period_start,
              end_date: sub.current_period_end,
              currency: "usd",
              items: [{ price: "price_actual10", quantity: 1 }],
              metadata: {},
              proration_behavior: "create_prorations",
            },
          ],
        };
        schedules.set(schedule.id, schedule);
        sub.schedule = schedule.id;
        return Response.json(schedule);
      }
      if (path === "/v1/subscription_schedules/sub_sched_actual") {
        const schedule = schedules.get("sub_sched_actual");
        if (!schedule) throw new Error("schedule missing");
        schedule.phases = [0, 1].map((index) => ({
          start_date: Number(form[`phases[${index}][start_date]`]),
          end_date: Number(form[`phases[${index}][end_date]`]),
          currency: "usd",
          items: [
            {
              price: form[`phases[${index}][items][0][price]`],
              quantity: Number(form[`phases[${index}][items][0][quantity]`]),
            },
          ],
          metadata: nested(form, `phases[${index}][metadata]`),
          proration_behavior: form[`phases[${index}][proration_behavior]`],
        }));
        schedule.end_behavior = form.end_behavior;
        schedule.metadata = nested(form, "metadata");
        if (lose === "schedule") {
          lose = null;
          throw new Error("lost scheduling ACK");
        }
        return Response.json(schedule);
      }
      if (path === "/v1/subscription_schedules/sub_sched_actual/release") {
        const schedule = schedules.get("sub_sched_actual");
        if (!schedule) throw new Error("schedule missing");
        schedule.status = "released";
        schedule.subscription = null;
        schedule.released_subscription = SUB;
        schedule.released_at = unix(at);
        sub.schedule = null;
        if (lose === "release") {
          lose = null;
          throw new Error("lost release ACK");
        }
        return Response.json(schedule);
      }
      if (path === `/v1/subscriptions/${SUB}`) {
        expect(form).toEqual({ cancel_at_period_end: "true" });
        sub.cancel_at_period_end = true;
        return Response.json(sub);
      }
      throw new Error(`unexpected mutation ${path}`);
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: {
      accountId: "acct_actualphase",
      mode: "test",
      billingAuthority: "actual-phase-test",
    },
    prices: source.plans.map((plan) => ({
      priceId: plan.stripePriceId,
      monthlyAmountMinor: Number(BigInt(plan.monthlyPriceMicros) / 10000n),
    })),
  });
  const customerCustody = createStripeCustomerCustody({ sql, clock, client, realm });
  let context!: StripeBillingSubscriptionExtensionContext;
  const makeWriter = () =>
    createStripeBilling({
      client,
      realm,
      pricing,
      consoleOrigin: "https://console.example.test",
      ensureCustomer: customerCustody.ensure,
      context: {
        sql,
        clock,
        async credit() {
          throw new Error("parallel grant writer forbidden");
        },
        async creditedFunding() {
          return new Set<string>();
        },
      },
      subscriptionExtensions(ctx) {
        context = ctx;
        return createHostedSubscriptionAdapter({ context: ctx, realm });
      },
    });
  let writer = makeWriter();
  let sequence = 0;
  const deliver = async (type: string, objectId: string) => {
    const handler = writer.handlers[type];
    if (!handler) throw new Error("missing original writer handler");
    return await handler(
      {
        id: `evt_actual_${++sequence}`,
        type,
        objectId,
        objectType: type.startsWith("invoice.")
          ? "invoice"
          : type.startsWith("customer.subscription.")
            ? "subscription"
            : "checkout.session",
        livemode: false,
        created: unix(at),
      },
      {
        currency: "USD",
        mode: "test",
        client: {
          checkoutSession: (id) => client.get("checkout/sessions", id),
          async listCheckoutSessions(input) {
            const page = await client.list("checkout/sessions", input);
            return { sessions: page.data, hasMore: page.hasMore };
          },
        },
        async credit() {
          throw new Error("parallel grant writer forbidden");
        },
      },
    );
  };
  const invoice = (
    id: string,
    planKey: "hosted-10" | "hosted-50",
    start: string,
    end: string,
    paid = true,
  ) => {
    const amount = planKey === "hosted-10" ? 1000 : 5000;
    const metadata = {
      organizationId: ORG,
      takoserverPurpose: "hosted_subscription",
      planKey,
      pricingRevision: source.revision,
    };
    const record: StripeBillingObject = {
      id,
      object: "invoice",
      livemode: false,
      customer: "cus_actual_phase",
      subscription: SUB,
      currency: "usd",
      status: paid ? "paid" : "open",
      paid,
      paid_out_of_band: false,
      amount_remaining: paid ? 0 : amount,
      amount_paid: paid ? amount : 0,
      total: amount,
      total_excluding_tax: amount,
      billing_reason: start === START ? "subscription_create" : "subscription_cycle",
      charge: paid ? `ch_${id}` : null,
      metadata: {},
      subscription_details: { metadata },
      lines: {
        has_more: false,
        data: [
          {
            type: "subscription",
            proration: false,
            quantity: 1,
            subscription: SUB,
            price: planKey === "hosted-10" ? "price_actual10" : "price_actual50",
            period: { start: unix(start), end: unix(end) },
          },
        ],
      },
    };
    invoices.set(id, record);
    if (paid)
      charges.set(`ch_${id}`, {
        id: `ch_${id}`,
        object: "charge",
        livemode: false,
        invoice: id,
        customer: "cus_actual_phase",
        currency: "usd",
        amount,
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        refunded: false,
        amount_refunded: 0,
        refunds: { data: [], has_more: false },
      });
    return record;
  };
  const begin = async () => {
    const open = await writer.subscriptions.begin({
      organizationId: ORG,
      reference: "original-start",
      planKey: "hosted-10",
    });
    expect(open.state).toBe("open");
    expect(customers.size).toBe(1);
    const session = sessions.get("cs_actual_phase");
    if (!session) throw new Error("missing genuine Checkout");
    session.status = "complete";
    session.payment_status = "paid";
    session.subscription = SUB;
    session.invoice = "in_actual_first";
    subscriptions.set(SUB, {
      id: SUB,
      object: "subscription",
      livemode: false,
      customer: session.customer,
      currency: "usd",
      metadata: session.metadata,
      status: "active",
      cancel_at_period_end: false,
      current_period_start: unix(START),
      current_period_end: unix(NEXT),
      start_date: unix(START),
      billing_cycle_anchor: unix(START),
      schedule: null,
      items: { has_more: false, data: [{ id: "si_actual", price: "price_actual10", quantity: 1 }] },
    });
    invoice("in_actual_first", "hosted-10", START, NEXT);
    expect(await deliver("checkout.session.completed", session.id)).toMatchObject({
      outcome: "applied",
    });
    const associated = await writer.subscriptions.begin({
      organizationId: ORG,
      reference: "original-start",
      planKey: "hosted-10",
    });
    if (associated.state !== "associated") throw new Error("genuine custody association missing");
    expect(await deliver("invoice.paid", "in_actual_first")).toMatchObject({ outcome: "applied" });
    at = "2026-10-15T00:00:00.000Z";
    return associated.subscriptionRef;
  };
  const change = (expectedSubscriptionRef: string) => {
    if (!writer.subscriptionPlans) throw new Error("missing actual extension");
    return writer.subscriptionPlans.change({
      organizationId: ORG,
      reference: "actual-upgrade",
      expectedSubscriptionRef,
      planKey: "hosted-50",
    });
  };
  return {
    db,
    sql,
    calls,
    realm,
    client,
    makeWriter,
    get context() {
      return context;
    },
    get writer() {
      return writer;
    },
    sessions,
    customers,
    subscriptions,
    schedules,
    invoices,
    charges,
    refunds,
    begin,
    change,
    deliver,
    invoice,
    now(value: string) {
      at = value;
    },
    restart() {
      writer = makeWriter();
    },
    lose(value: "schedule" | "release") {
      lose = value;
    },
    gate(value: { entered(): void; resume: Promise<void> }) {
      createGate = value;
    },
    activate() {
      at = NEXT;
      const sub = subscriptions.get(SUB);
      if (!sub) throw new Error("missing subscription");
      sub.current_period_start = unix(NEXT);
      sub.current_period_end = unix(AFTER);
      sub.metadata = { ...(sub.metadata as Record<string, unknown>), planKey: "hosted-50" };
      sub.items = {
        has_more: false,
        data: [{ id: "si_actual", price: "price_actual50", quantity: 1 }],
      };
    },
  };
}

describe("genuine Hosted subscription adapter and original grant writer", () => {
  test("completed Checkout cannot mint a native association after its bound Customer realm contradicts the pin", async () => {
    const f = await fixture();
    try {
      const start = { organizationId: ORG, reference: "original-start", planKey: "hosted-10" };
      expect(await f.writer.subscriptions.begin(start)).toMatchObject({ state: "open" });
      const session = f.sessions.get("cs_actual_phase"),
        customer = f.customers.get("cus_actual_phase");
      if (!session || !customer) throw new Error("missing original Checkout/Customer");
      session.status = "complete";
      session.payment_status = "paid";
      session.subscription = SUB;
      session.invoice = "in_actual_first";
      f.subscriptions.set(SUB, {
        id: SUB,
        object: "subscription",
        livemode: false,
        customer: session.customer,
        currency: "usd",
        metadata: session.metadata,
        status: "active",
        cancel_at_period_end: false,
        current_period_start: unix(START),
        current_period_end: unix(NEXT),
        start_date: unix(START),
        billing_cycle_anchor: unix(START),
        schedule: null,
        items: {
          has_more: false,
          data: [{ id: "si_actual", price: "price_actual10", quantity: 1 }],
        },
      });
      f.invoice("in_actual_first", "hosted-10", START, NEXT);
      const original = clone(customer.metadata);
      customer.metadata = {
        ...(customer.metadata as Record<string, unknown>),
        financialRealm: "foreign-financial-realm",
      };
      expect(await f.deliver("checkout.session.completed", session.id)).toMatchObject({
        outcome: "deferred",
      });
      await expect(f.writer.subscriptions.begin(start)).rejects.toMatchObject({ status: 503 });
      expect(await f.sql.query("SELECT * FROM stripe_billing_associations")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM stripe_billing_grants")).toEqual([]);
      customer.metadata = original;
      expect(await f.writer.subscriptions.begin(start)).toMatchObject({ state: "associated" });
      expect(
        f.calls.filter((call) => call.method === "POST" && call.path === "/v1/checkout/sessions"),
      ).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
  test("fresh Customer account/realm contradictions block plan, cancellation, invoice and reconciliation through the original writer", async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      const customer = f.customers.get("cus_actual_phase");
      if (!customer) throw new Error("missing original Customer");
      customer.metadata = {
        ...(customer.metadata as Record<string, unknown>),
        stripeAccountId: "acct_foreign",
        financialRealm: "foreign-financial-realm",
      };
      const before = f.calls.filter((call) => call.method === "POST").length;
      await expect(f.change(ref)).rejects.toMatchObject({
        code: "customer_binding_unresolved",
        status: 503,
      });
      await expect(
        f.writer.subscriptions.change({
          organizationId: ORG,
          reference: "contradictory-cancel",
          expectedSubscriptionRef: ref,
          cancelAtPeriodEnd: true,
        }),
      ).rejects.toMatchObject({ status: 503 });
      expect(await f.deliver("invoice.paid", "in_actual_first")).toMatchObject({
        outcome: "deferred",
        detail: "subscription_terms_unresolved",
      });
      expect(await f.deliver("customer.subscription.updated", SUB)).toMatchObject({
        outcome: "deferred",
      });
      expect((await f.writer.reconcile()).unresolved).toBeGreaterThan(0);
      expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(before);
      expect(await f.sql.query("SELECT * FROM stripe_billing_plan_changes")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM stripe_subscription_cancellation_intents")).toEqual(
        [],
      );
      expect(await f.sql.query("SELECT * FROM stripe_billing_grants")).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });

  test("Customer drift while schedule creation is in flight holds the frozen command before update and across restart", async () => {
    const f = await fixture();
    let resume!: () => void, entered!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    try {
      const ref = await f.begin();
      f.gate({ entered, resume: gate });
      const pending = f.change(ref);
      await seen;
      const customer = f.customers.get("cus_actual_phase");
      if (!customer) throw new Error("missing Customer");
      const metadata = clone(customer.metadata);
      customer.metadata = {
        ...(customer.metadata as Record<string, unknown>),
        stripeAccountId: "acct_foreign",
        financialRealm: "foreign-financial-realm",
      };
      resume();
      await expect(pending).rejects.toMatchObject({
        code: "customer_binding_unresolved",
        status: 503,
      });
      const pinned = await f.sql.query(
        "SELECT fingerprint,frozen_json,desired_json FROM stripe_billing_plan_changes",
      );
      expect(await f.sql.query("SELECT state FROM stripe_billing_plan_changes")).toEqual([
        { state: "pending" },
      ]);
      expect(
        f.calls.filter(
          (call) =>
            call.method === "POST" && call.path === "/v1/subscription_schedules/sub_sched_actual",
        ),
      ).toHaveLength(0);
      expect(
        await f.sql.query(
          "SELECT * FROM stripe_billing_subscription_terms WHERE command_reference IS NOT NULL",
        ),
      ).toEqual([]);
      f.restart();
      await expect(f.change(ref)).rejects.toMatchObject({ status: 503 });
      expect((await f.writer.reconcile()).unresolved).toBeGreaterThan(0);
      expect(
        f.calls.filter(
          (call) => call.method === "POST" && call.path.startsWith("/v1/subscription_schedules"),
        ),
      ).toHaveLength(1);
      expect(
        await f.sql.query(
          "SELECT fingerprint,frozen_json,desired_json FROM stripe_billing_plan_changes",
        ),
      ).toEqual(pinned);
      customer.metadata = metadata;
      expect(await f.change(ref)).toMatchObject({ state: "verified" });
      expect(
        f.calls.filter(
          (call) => call.method === "POST" && call.path === "/v1/subscription_schedules",
        ),
      ).toHaveLength(1);
      expect(
        f.calls.filter(
          (call) =>
            call.method === "POST" && call.path === "/v1/subscription_schedules/sub_sched_actual",
        ),
      ).toHaveLength(1);
      expect(
        await f.sql.query(
          "SELECT fingerprint,frozen_json,desired_json FROM stripe_billing_plan_changes",
        ),
      ).toEqual(pinned);
    } finally {
      resume();
      f.db.close();
    }
  });

  test.each([{ object: "price" }, { deleted: true }, { id: "cus_foreign" }, { livemode: true }])(
    "the actual plan adapter rejects an invalid authoritative Customer identity before a schedule effect: %j",
    async (contradiction) => {
      const f = await fixture();
      try {
        const ref = await f.begin();
        const customer = f.customers.get("cus_actual_phase");
        if (!customer) throw new Error("missing Customer");
        Object.assign(customer, contradiction);
        const before = f.calls.filter((call) => call.method === "POST").length;
        await expect(f.change(ref)).rejects.toThrow();
        expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(before);
        expect(await f.sql.query("SELECT * FROM stripe_billing_plan_changes")).toEqual([]);
      } finally {
        f.db.close();
      }
    },
  );
  test("uses service-period history for renewal and delayed invoices, then releases before native true-only cancellation", async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      const original = await f.sql.query("SELECT * FROM stripe_billing_associations");
      expect(await f.change(ref)).toMatchObject({
        state: "verified",
        subscriptionRef: ref,
        pendingChange: { planKey: "hosted-50", effectiveAt: NEXT },
      });
      expect(
        await f.sql.query("SELECT source_id,amount_micros FROM stripe_billing_grants"),
      ).toEqual([{ source_id: "in_actual_first", amount_micros: 20000000 }]);
      f.activate();
      const sub = f.subscriptions.get(SUB);
      if (!sub) throw new Error("sub missing");
      sub.status = "past_due";
      f.invoice("in_actual_renewal", "hosted-50", NEXT, AFTER, false);
      expect(await f.deliver("invoice.payment_failed", "in_actual_renewal")).toMatchObject({
        outcome: "applied",
      });
      expect(await f.sql.query("SELECT * FROM stripe_billing_grants")).toHaveLength(1);
      expect(await f.deliver("invoice.paid", "in_actual_first")).toMatchObject({
        outcome: "applied",
      });
      expect(await f.sql.query("SELECT * FROM stripe_billing_grants")).toHaveLength(1);
      sub.status = "active";
      f.invoice("in_actual_renewal", "hosted-50", NEXT, AFTER);
      expect(await f.deliver("invoice.paid", "in_actual_renewal")).toMatchObject({
        outcome: "applied",
      });
      expect(await f.deliver("invoice.paid", "in_actual_renewal")).toMatchObject({
        outcome: "applied",
      });
      expect(
        await f.sql.query(
          "SELECT source_id,amount_micros,stripe_price_id,period_start,period_end FROM stripe_billing_grants ORDER BY period_start",
        ),
      ).toEqual([
        {
          source_id: "in_actual_first",
          amount_micros: 20000000,
          stripe_price_id: "price_actual10",
          period_start: START,
          period_end: NEXT,
        },
        {
          source_id: "in_actual_renewal",
          amount_micros: 100000000,
          stripe_price_id: "price_actual50",
          period_start: NEXT,
          period_end: AFTER,
        },
      ]);
      expect(
        await f.writer.subscriptions.begin({
          organizationId: ORG,
          reference: "original-start",
          planKey: "hosted-10",
        }),
      ).toMatchObject({ state: "associated", subscriptionRef: ref });
      expect(
        await f.writer.subscriptions.change({
          organizationId: ORG,
          reference: "actual-cancel",
          expectedSubscriptionRef: ref,
          cancelAtPeriodEnd: true,
        }),
      ).toMatchObject({ state: "verified", subscriptionRef: ref, effectiveAt: AFTER });
      const effects = f.calls.filter((call) => call.method === "POST");
      expect(effects.slice(-2).map((call) => call.path)).toEqual([
        "/v1/subscription_schedules/sub_sched_actual/release",
        `/v1/subscriptions/${SUB}`,
      ]);
      expect(effects.some((call) => call.path.endsWith("/cancel"))).toBe(false);
      expect(await f.sql.query("SELECT * FROM stripe_billing_associations")).toEqual(original);
      expect(
        await f.sql.query("SELECT * FROM stripe_billing_subscription_term_revocations"),
      ).toEqual([]);
      expect(await f.deliver("invoice.paid", "in_actual_first")).toMatchObject({
        outcome: "applied",
      });
      expect(await f.sql.query("SELECT * FROM stripe_billing_grants")).toHaveLength(2);
      const charge = f.charges.get("ch_in_actual_first");
      if (!charge) throw new Error("missing historical charge");
      charge.amount_refunded = 500;
      const refund = {
        id: "re_actual_old",
        object: "refund",
        livemode: false,
        charge: charge.id,
        currency: "usd",
        amount: 500,
        status: "succeeded",
        created: unix(NEXT) + 100,
      };
      f.refunds.set(refund.id, refund);
      charge.refunds = { data: [refund], has_more: false };
      expect(await f.deliver("refund.updated", refund.id)).toMatchObject({ outcome: "applied" });
      expect(
        await f.sql.query(
          "SELECT target_revoked_micros,debit_micros,receivable_micros,expired_micros FROM stripe_billing_refunds",
        ),
      ).toEqual([
        {
          target_revoked_micros: 10000000,
          debit_micros: 0,
          receivable_micros: 0,
          expired_micros: 10000000,
        },
      ]);
      expect(await f.writer.reconcile()).toMatchObject({ unresolved: 0 });
      expect(
        await f.sql.query(
          "SELECT amount_micros FROM stripe_billing_grants WHERE source_id='in_actual_renewal'",
        ),
      ).toEqual([{ amount_micros: 100000000 }]);
      expect(
        f.calls.filter(
          (call) => call.method === "POST" && call.path === `/v1/subscriptions/${SUB}`,
        ),
      ).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });

  test("release before renewal revokes only future commercial proof and rejects a future paid invoice claiming it", async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      await f.change(ref);
      expect(
        await f.writer.subscriptions.change({
          organizationId: ORG,
          reference: "cancel-before-boundary",
          expectedSubscriptionRef: ref,
          cancelAtPeriodEnd: true,
        }),
      ).toMatchObject({ state: "verified", effectiveAt: NEXT });
      expect(
        await f.sql.query(
          "SELECT effective_at,released_at FROM stripe_billing_subscription_term_revocations",
        ),
      ).toEqual([{ effective_at: NEXT, released_at: "2026-10-15T00:00:00.000Z" }]);
      f.invoice("in_invalid_future", "hosted-50", NEXT, AFTER);
      expect(await f.deliver("invoice.paid", "in_invalid_future")).toMatchObject({
        outcome: "deferred",
        detail: "subscription_terms_unresolved",
      });
      expect(await f.sql.query("SELECT source_id FROM stripe_billing_grants")).toEqual([
        { source_id: "in_actual_first" },
      ]);
    } finally {
      f.db.close();
    }
  });

  test("known schedule update and release lost ACKs recover through actual custody after restart without repeated effects", async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      f.lose("schedule");
      expect(await f.change(ref)).toMatchObject({ state: "pending" });
      f.restart();
      expect(await f.change(ref)).toMatchObject({ state: "verified" });
      f.lose("release");
      const cancel = () =>
        f.writer.subscriptions.change({
          organizationId: ORG,
          reference: "lost-release",
          expectedSubscriptionRef: ref,
          cancelAtPeriodEnd: true,
        });
      expect(await cancel()).toMatchObject({ state: "pending" });
      expect(
        f.calls.filter(
          (call) => call.method === "POST" && call.path === `/v1/subscriptions/${SUB}`,
        ),
      ).toHaveLength(0);
      f.restart();
      expect(await cancel()).toMatchObject({ state: "verified" });
      expect(await cancel()).toMatchObject({ state: "verified" });
      for (const path of [
        "/v1/subscription_schedules",
        "/v1/subscription_schedules/sub_sched_actual",
        "/v1/subscription_schedules/sub_sched_actual/release",
        `/v1/subscriptions/${SUB}`,
      ])
        expect(f.calls.filter((call) => call.method === "POST" && call.path === path)).toHaveLength(
          1,
        );
      expect(
        await f.sql.query("SELECT state FROM stripe_subscription_cancellation_intents"),
      ).toEqual([{ state: "verified" }]);
    } finally {
      f.db.close();
    }
  });

  test("a durable in-flight plan command fences native cancellation and another Checkout before either remote effect", async () => {
    const f = await fixture();
    let resume!: () => void, entered!: () => void;
    const seen = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      resume = resolve;
    });
    try {
      const ref = await f.begin();
      f.gate({ entered, resume: gate });
      const pending = f.change(ref);
      await seen;
      await expect(
        f.writer.subscriptions.change({
          organizationId: ORG,
          reference: "racing-cancel",
          expectedSubscriptionRef: ref,
          cancelAtPeriodEnd: true,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        f.writer.subscriptions.begin({
          organizationId: ORG,
          reference: "racing-start",
          planKey: "hosted-50",
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await f.sql.query("SELECT * FROM stripe_subscription_cancellation_intents")).toEqual(
        [],
      );
      expect(
        f.calls.filter(
          (call) => call.method === "POST" && call.path === `/v1/subscriptions/${SUB}`,
        ),
      ).toHaveLength(0);
      expect(
        f.calls.filter((call) => call.method === "POST" && call.path === "/v1/checkout/sessions"),
      ).toHaveLength(1);
      resume();
      expect(await pending).toMatchObject({ state: "verified" });
    } finally {
      resume();
      f.db.close();
    }
  });

  test("the extension rejects forged context and realm identities; boot verifies literal durable definitions", async () => {
    const f = await fixture();
    try {
      expect(() =>
        createHostedSubscriptionAdapter({ context: { ...f.context }, realm: f.realm }),
      ).toThrow("subscription_extension_unqualified");
      expect(() =>
        createHostedSubscriptionAdapter({ context: f.context, realm: { ...f.realm } }),
      ).toThrow("financial_realm_unqualified");
      await expect(assertHostedSubscriptionAdapterSchema(f.sql)).resolves.toBeUndefined();
      await f.sql.run("DROP TRIGGER stripe_billing_subscription_terms_no_update");
      await f.sql.run(
        "CREATE TRIGGER stripe_billing_subscription_terms_no_update BEFORE UPDATE ON stripe_billing_subscription_terms BEGIN SELECT 1; END",
      );
      await expect(assertHostedSubscriptionAdapterSchema(f.sql)).rejects.toMatchObject({
        code: "billing_schema_not_ready",
      });
      expect(f.calls.filter((call) => call.method === "POST")).toEqual([]);
    } finally {
      f.db.close();
    }
  });
});
