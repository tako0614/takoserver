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
  let SUB = "sub_actual_phase",
    SESSION = "cs_actual_phase",
    START_REF = "original-start",
    FIRST_INVOICE = "in_actual_first";
  let START = "2026-10-01T00:00:00.000Z",
    NEXT = "2026-11-01T00:00:00.000Z",
    AFTER = "2026-12-01T00:00:00.000Z";
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
  let lose: "schedule" | "release" | "native-cancel" | null = null;
  let unknownNativeReadback = false;
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
        if (unknownNativeReadback && path === `/v1/subscriptions/${SUB}`)
          return new Response("unknown native cancel acknowledgement", { status: 503 });
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
          id: SESSION,
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
          url: `https://checkout.stripe.com/c/pay/${SESSION}`,
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
        if (lose === "native-cancel") {
          lose = null;
          unknownNativeReadback = true;
          throw new Error("lost native cancellation acknowledgement");
        }
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
      reference: START_REF,
      planKey: "hosted-10",
    });
    expect(open.state).toBe("open");
    expect(customers.size).toBe(1);
    const session = sessions.get(SESSION);
    if (!session) throw new Error("missing genuine Checkout");
    session.status = "complete";
    session.payment_status = "paid";
    session.subscription = SUB;
    session.invoice = FIRST_INVOICE;
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
    invoice(FIRST_INVOICE, "hosted-10", START, NEXT);
    expect(await deliver("checkout.session.completed", session.id)).toMatchObject({
      outcome: "applied",
    });
    const associated = await writer.subscriptions.begin({
      organizationId: ORG,
      reference: START_REF,
      planKey: "hosted-10",
    });
    if (associated.state !== "associated") throw new Error("genuine custody association missing");
    expect(await deliver("invoice.paid", FIRST_INVOICE)).toMatchObject({ outcome: "applied" });
    at = new Date(Date.parse(START) + 14 * 86400000).toISOString();
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
    lose(value: "schedule" | "release" | "native-cancel") {
      lose = value;
    },
    recoverNativeCancellation() {
      unknownNativeReadback = false;
    },
    gate(value: { entered(): void; resume: Promise<void> }) {
      createGate = value;
    },
    replaceSubscription() {
      SUB = "sub_second_phase";
      SESSION = "cs_second_phase";
      START_REF = "second-start";
      FIRST_INVOICE = "in_second_first";
      START = NEXT;
      NEXT = AFTER;
      AFTER = "2027-01-01T00:00:00.000Z";
      at = START;
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
  test("the same phase-owned native cancellation recovers its original unknown ACK and finalizes the phase command without another effect", async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      await f.change(ref);
      f.lose("native-cancel");
      const request = {
        organizationId: ORG,
        reference: "phase-native-unknown",
        expectedSubscriptionRef: ref,
        cancelAtPeriodEnd: true,
      };
      expect(await f.writer.subscriptions.change(request)).toEqual({
        state: "pending",
        subscriptionRef: ref,
      });
      expect(await f.context.custody.readCancelCommand(ORG, request.reference)).toMatchObject({
        state: "pending",
        subscriptionRef: ref,
      });
      expect(
        await f.writer.subscriptionPlans?.readCommand(ORG, request.reference, "cancel"),
      ).toMatchObject({ state: "pending", subscriptionRef: ref });
      const posts = f.calls.filter((call) => call.method === "POST").length;
      expect(await f.writer.subscriptions.change(request)).toEqual({
        state: "pending",
        subscriptionRef: ref,
      });
      expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(posts);
      f.recoverNativeCancellation();
      expect(await f.writer.subscriptions.change(request)).toMatchObject({
        state: "verified",
        subscriptionRef: ref,
        effectiveAt: NEXT,
      });
      expect(
        await f.writer.subscriptionPlans?.readCommand(ORG, request.reference, "cancel"),
      ).toMatchObject({ state: "verified", subscriptionRef: ref, effectiveAt: NEXT });
      expect(await f.context.custody.readCancelCommand(ORG, request.reference)).toMatchObject({
        state: "verified",
        subscriptionRef: ref,
        effectiveAt: NEXT,
      });
      expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(posts);
    } finally {
      f.db.close();
    }
  });
  test("a native cancellation with unknown ACK retains its original pending identity without a phase command or another effect", async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      f.lose("native-cancel");
      const request = {
        organizationId: ORG,
        reference: "unknown-original",
        expectedSubscriptionRef: ref,
        cancelAtPeriodEnd: true,
      };
      expect(await f.writer.subscriptions.change(request)).toEqual({
        state: "pending",
        subscriptionRef: ref,
      });
      const saved = await f.context.custody.readCancelCommand(ORG, request.reference);
      expect(saved).toMatchObject({
        state: "pending",
        lifecycle: "pending",
        subscriptionRef: ref,
        effectiveAt: null,
      });
      const posts = f.calls.filter((call) => call.method === "POST").length;
      expect(await f.writer.subscriptions.change(request)).toEqual({
        state: "pending",
        subscriptionRef: ref,
      });
      expect(await f.writer.subscriptionPlans?.cancelPendingChange(request)).toEqual({
        state: "pending",
        subscriptionRef: ref,
      });
      await expect(
        f.writer.subscriptions.change({
          ...request,
          expectedSubscriptionRef: `sra_${"b".repeat(64)}`,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(posts);
      expect(await f.sql.query("SELECT * FROM stripe_billing_plan_changes")).toEqual([]);
      expect(await f.context.custody.readCancelCommand(ORG, request.reference)).toEqual(saved);
    } finally {
      f.db.close();
    }
  });
  test("a retained native cancellation reference for A cannot prepare or release B's plan schedule", async () => {
    const f = await fixture();
    try {
      const refA = await f.begin();
      const original = await f.writer.subscriptions.change({
        organizationId: ORG,
        reference: "same-original",
        expectedSubscriptionRef: refA,
        cancelAtPeriodEnd: true,
      });
      expect(original).toMatchObject({
        state: "verified",
        subscriptionRef: refA,
        effectiveAt: NEXT,
      });
      const saved = await f.context.custody.readCancelCommand(ORG, "same-original");
      const subA = f.subscriptions.get(SUB);
      if (!subA) throw new Error("original A missing");
      subA.status = "canceled";
      subA.ended_at = unix(NEXT);
      subA.canceled_at = unix(NEXT);
      f.now(NEXT);
      expect(await f.deliver("customer.subscription.updated", SUB)).toMatchObject({
        outcome: "applied",
      });
      f.replaceSubscription();
      const refB = await f.begin();
      expect(refB).not.toBe(refA);
      expect(await f.change(refB)).toMatchObject({
        state: "verified",
        pendingChange: { effectiveAt: AFTER },
      });
      const tables = [
        "stripe_billing_plan_changes",
        "stripe_billing_plan_change_slots",
        "stripe_billing_plan_change_steps",
        "stripe_billing_subscription_term_revocations",
        "stripe_subscription_cancellation_intents",
        "stripe_billing_grants",
      ];
      const snapshot = async () =>
        Object.fromEntries(
          await Promise.all(
            tables.map(async (table) => [table, await f.sql.query(`SELECT * FROM ${table}`)]),
          ),
        );
      const before = await snapshot(),
        posts = f.calls.filter((call) => call.method === "POST").length;
      await expect(
        f.writer.subscriptions.change({
          organizationId: ORG,
          reference: "same-original",
          expectedSubscriptionRef: refB,
          cancelAtPeriodEnd: true,
        }),
      ).rejects.toMatchObject({ status: 409 });
      await expect(
        f.writer.subscriptionPlans?.cancelPendingChange({
          organizationId: ORG,
          reference: "same-original",
          expectedSubscriptionRef: refB,
        }),
      ).rejects.toMatchObject({ status: 409 });
      expect(await snapshot()).toEqual(before);
      expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(posts);
      expect(f.subscriptions.get("sub_second_phase")?.cancel_at_period_end).toBe(false);
      expect(f.subscriptions.get("sub_second_phase")?.schedule).toBe("sub_sched_actual");
      expect(await f.context.custody.readCancelCommand(ORG, "same-original")).toEqual(saved);
      expect(
        await f.writer.subscriptionPlans?.readCommand(ORG, "same-original", "cancel"),
      ).toBeNull();
      expect(
        await f.writer.subscriptions.change({
          organizationId: ORG,
          reference: "fresh-B-cancel",
          expectedSubscriptionRef: refB,
          cancelAtPeriodEnd: true,
        }),
      ).toMatchObject({ state: "verified", subscriptionRef: refB, effectiveAt: AFTER });
      expect(await f.context.custody.readCancelCommand(ORG, "same-original")).toEqual(saved);
    } finally {
      f.db.close();
    }
  });

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

// Preparation DATA is exercised through the actual writer-owned extension graph.
// The processor in this fixture is explicit fake transport; no Root authority is asserted.
async function cancellationCommandRows(f: Awaited<ReturnType<typeof fixture>>) {
  return await Promise.all([
    f.sql.query("SELECT * FROM stripe_subscription_cancellation_intents ORDER BY id"),
    f.sql.query("SELECT * FROM stripe_billing_plan_changes ORDER BY org_id,reference"),
    f.sql.query("SELECT * FROM stripe_billing_plan_change_slots ORDER BY org_id"),
    f.sql.query("SELECT * FROM stripe_billing_plan_change_steps ORDER BY org_id,reference,step"),
  ]);
}

describe("CANCEL economic preparation DATA across both actual command branches", () => {
  for (const phase of [false, true]) {
    const branch = phase ? "pending-plan-change" : "legacy";
    test(`${branch}: observes the exact tuple without a new command, slot or provider mutation, then preserves the direct command`, async () => {
      const f = await fixture();
      try {
        const ref = await f.begin();
        if (phase) await f.change(ref);
        const prepare = f.writer.prepareCancellationEconomicR1;
        if (!prepare) throw new Error("missing qualified cancellation DATA selector");
        const planMethods = f.writer.subscriptionPlans ?? {};
        expect("preparePendingCancellationEconomicR1" in planMethods).toBe(false);
        const before = await cancellationCommandRows(f);
        const calls = f.calls.length;
        const generation = (
          await f.sql.query(
            "SELECT association_generation FROM stripe_billing_associations WHERE subscription_id=?",
            [SUB],
          )
        )[0]?.association_generation;
        if (
          typeof generation !== "number" ||
          !Number.isSafeInteger(generation) ||
          generation < 0
        )
          throw new Error("invalid original association generation");
        const input = {
          organizationId: ORG,
          reference: `prepare-${branch}`,
          expectedSubscriptionRef: ref,
        };
        const selected = await prepare(input);
        expect(selected).toEqual({
          kind: "cancel",
          expectedSubscriptionRef: ref,
          targetSubscriptionId: SUB,
          targetGeneration: generation,
          branch,
          pendingReference: phase ? "actual-upgrade" : null,
          scheduleId: phase ? "sub_sched_actual" : null,
          cancelAtPeriodEnd: true,
        });
        expect(Object.isFrozen(selected)).toBe(true);
        expect(await cancellationCommandRows(f)).toEqual(before);
        expect(
          f.calls
            .slice(calls)
            .some((call) => call.method === "GET" && call.path === `/v1/subscriptions/${SUB}`),
        ).toBe(true);
        expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
        expect(
          await f.writer.subscriptions.change({ ...input, cancelAtPeriodEnd: true }),
        ).toMatchObject({
          state: "verified",
          subscriptionRef: ref,
          effectiveAt: NEXT,
        });
        const original = await cancellationCommandRows(f);
        await expect(prepare(input)).rejects.toMatchObject({
          code: "subscription_management_conflict",
        });
        expect(await cancellationCommandRows(f)).toEqual(original);
        expect(
          f.calls.filter(
            (call) => call.method === "POST" && call.path === `/v1/subscriptions/${SUB}`,
          ),
        ).toHaveLength(1);
      } finally {
        f.db.close();
      }
    });

    test(`${branch}: a wrong expected target creates no command and never dispatches`, async () => {
      const f = await fixture();
      try {
        const ref = await f.begin();
        if (phase) await f.change(ref);
        const before = await cancellationCommandRows(f);
        const calls = f.calls.length;
        await expect(
          f.writer.prepareCancellationEconomicR1?.({
            organizationId: ORG,
            reference: `wrong-${branch}`,
            expectedSubscriptionRef: `sra_${"0".repeat(64)}`,
          }),
        ).rejects.toBeTruthy();
        expect(await cancellationCommandRows(f)).toEqual(before);
        expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
      } finally {
        f.db.close();
      }
    });

    test(`${branch}: an original unknown cancellation remains original GET-only recovery across restart`, async () => {
      const f = await fixture();
      try {
        const ref = await f.begin();
        if (phase) await f.change(ref);
        const input = {
          organizationId: ORG,
          reference: `unknown-${branch}`,
          expectedSubscriptionRef: ref,
          cancelAtPeriodEnd: true,
        };
        f.lose("native-cancel");
        expect(await f.writer.subscriptions.change(input)).toEqual({
          state: "pending",
          subscriptionRef: ref,
        });
        const original = await cancellationCommandRows(f);
        const posts = f.calls.filter((call) => call.method === "POST");
        f.restart();
        await expect(f.writer.prepareCancellationEconomicR1?.(input)).rejects.toMatchObject({
          code: "subscription_management_conflict",
        });
        expect(await cancellationCommandRows(f)).toEqual(original);
        await expect(
          f.writer.prepareCancellationEconomicR1?.({ ...input, reference: `another-${branch}` }),
        ).rejects.toBeTruthy();
        expect(await cancellationCommandRows(f)).toEqual(original);
        expect(await f.writer.subscriptions.change(input)).toEqual({
          state: "pending",
          subscriptionRef: ref,
        });
        expect(f.calls.filter((call) => call.method === "POST")).toEqual(posts);
        f.recoverNativeCancellation();
        expect(await f.writer.subscriptions.change(input)).toMatchObject({
          state: "verified",
          subscriptionRef: ref,
          effectiveAt: NEXT,
        });
        expect(f.calls.filter((call) => call.method === "POST")).toEqual(posts);
        expect(await f.writer.subscriptions.change(input)).toMatchObject({
          state: "verified",
          subscriptionRef: ref,
          effectiveAt: NEXT,
        });
        expect(f.calls.filter((call) => call.method === "POST")).toEqual(posts);
      } finally {
        f.db.close();
      }
    });

    test(`${branch}: native readback failure refuses DATA without dispatch or new custody`, async () => {
      const f = await fixture();
      try {
        const ref = await f.begin();
        if (phase) await f.change(ref);
        const original = f.subscriptions.get(SUB);
        f.subscriptions.delete(SUB);
        const before = await cancellationCommandRows(f);
        const calls = f.calls.length;
        await expect(
          f.writer.prepareCancellationEconomicR1?.({
            organizationId: ORG,
            reference: `native-missing-${branch}`,
            expectedSubscriptionRef: ref,
          }),
        ).rejects.toBeTruthy();
        expect(await cancellationCommandRows(f)).toEqual(before);
        expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
        if (original) f.subscriptions.set(SUB, original);
      } finally {
        f.db.close();
      }
    });
  }

  test("an unverified real phase slot refuses preparation while its original workflow owns dispatch", async () => {
    const f = await fixture();
    let release!: () => void;
    let pending: ReturnType<typeof f.change> | undefined;
    try {
      const ref = await f.begin();
      let entered!: () => void;
      const waiting = new Promise<void>((resolve) => {
        entered = resolve;
      });
      f.gate({
        entered,
        resume: new Promise<void>((resolve) => {
          release = resolve;
        }),
      });
      pending = f.change(ref);
      await waiting;
      const before = await cancellationCommandRows(f);
      const posts = f.calls.filter((call) => call.method === "POST");
      await expect(
        f.writer.prepareCancellationEconomicR1?.({
          organizationId: ORG,
          reference: "blocked-pending-slot",
          expectedSubscriptionRef: ref,
        }),
      ).rejects.toMatchObject({ code: "subscription_management_conflict" });
      expect(await cancellationCommandRows(f)).toEqual(before);
      expect(f.calls.filter((call) => call.method === "POST")).toEqual(posts);
    } finally {
      release?.();
      await pending;
      f.db.close();
    }
  });

  test("a verified pending slot cannot substitute a different or missing native schedule", async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      await f.change(ref);
      const sub = f.subscriptions.get(SUB);
      if (!sub) throw new Error("missing original subscription");
      sub.schedule = null;
      const before = await cancellationCommandRows(f);
      const calls = f.calls.length;
      await expect(
        f.writer.prepareCancellationEconomicR1?.({
          organizationId: ORG,
          reference: "wrong-schedule",
          expectedSubscriptionRef: ref,
        }),
      ).rejects.toMatchObject({ code: "schedule_readback_mismatch" });
      expect(await cancellationCommandRows(f)).toEqual(before);
      expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("legacy preparation refuses a native cancellation already scheduled before selection", async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      const native = f.subscriptions.get(SUB);
      if (!native) throw new Error("missing native subscription");
      native.cancel_at_period_end = true;
      const before = await cancellationCommandRows(f);
      const calls = f.calls.length;
      await expect(
        f.writer.prepareCancellationEconomicR1?.({
          organizationId: ORG,
          reference: "already-scheduled-native",
          expectedSubscriptionRef: ref,
        }),
      ).rejects.toMatchObject({ code: "subscription_management_conflict" });
      expect(await cancellationCommandRows(f)).toEqual(before);
      expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
    } finally {
      f.db.close();
    }
  });

  test("the NEW request tuple is captured before readiness awaits and invalid expected refs never dispatch", async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      const input = {
        organizationId: ORG,
        reference: "captured-original-cancel",
        expectedSubscriptionRef: ref,
      };
      const selecting = f.writer.prepareCancellationEconomicR1?.(input);
      input.expectedSubscriptionRef = `sra_${"0".repeat(64)}`;
      input.reference = "mutated-cancel";
      expect(await selecting).toMatchObject({
        expectedSubscriptionRef: ref,
        targetSubscriptionId: SUB,
        branch: "legacy",
      });
      const before = await cancellationCommandRows(f);
      const calls = f.calls.length;
      await expect(
        f.writer.prepareCancellationEconomicR1?.({
          organizationId: ORG,
          reference: "invalid-ref",
          expectedSubscriptionRef: "sub_raw_not_an_owner_ref",
        }),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      expect(await cancellationCommandRows(f)).toEqual(before);
      expect(f.calls.slice(calls)).toEqual([]);
    } finally {
      f.db.close();
    }
  });
});

for (const phase of [false, true]) {
  test(`CANCEL DATA retains the ${phase ? "phase" : "legacy"} current-period Clock refusal`, async () => {
    const f = await fixture();
    try {
      const ref = await f.begin();
      if (phase) await f.change(ref);
      f.now(NEXT);
      const before = await cancellationCommandRows(f);
      const calls = f.calls.length;
      await expect(
        f.writer.prepareCancellationEconomicR1?.({
          organizationId: ORG,
          reference: `expired-${phase ? "phase" : "legacy"}`,
          expectedSubscriptionRef: ref,
        }),
      ).rejects.toBeTruthy();
      expect(await cancellationCommandRows(f)).toEqual(before);
      expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
    } finally {
      f.db.close();
    }
  });
}
