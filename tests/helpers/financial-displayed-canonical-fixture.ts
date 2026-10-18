import { expect } from "bun:test";
import sharedPricing from "../../config/shared-hosted-pricing.json";
import { MIGRATIONS } from "../../src/db-schema.ts";
import { verifyHostedBillingFinancialRealm } from "../../src/hosted-billing-realm.ts";
import { compilePricingAuthoring } from "../../src/hosted-pricing.ts";
import { createHostedSubscriptionAdapter } from "../../src/hosted-subscription-adapter.ts";
import {
  createStripeBilling,
  type StripeBillingSubscriptionExtensionContext,
} from "../../src/stripe-billing.ts";
import {
  createStripeBillingClient,
  type StripeBillingObject,
} from "../../src/stripe-billing-client.ts";
import { createStripeCustomerCustody } from "../../src/stripe-customer-custody.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./hosted-billing-realm-fixture.ts";

export const ORG = "org_actual_phase";
export const SUB = "sub_actual_phase";
export const START = "2026-10-01T00:00:00.000Z";
export const NEXT = "2026-11-01T00:00:00.000Z";
export const AFTER = "2026-12-01T00:00:00.000Z";
const unix = (at: string) => Date.parse(at) / 1000;
const clone = <T>(value: T): T => structuredClone(value);

export async function fixture() {
  let SUB = "sub_actual_phase",
    SESSION = "cs_actual_phase",
    START_REF = "original-start",
    FIRST_INVOICE = "in_actual_first";
  let START = "2026-10-01T00:00:00.000Z",
    NEXT = "2026-11-01T00:00:00.000Z",
    AFTER = "2026-12-01T00:00:00.000Z";
  const { db, sql } = await createHostedBillingRealmTestDatabase();
  // The original adapter fixture stops at public0099. This separate canonical
  // fixture adds the exact published0100 needed by the real on-demand factory.
  const onDemandMigration = MIGRATIONS.find(
    (migration) => migration.name === "0100_hosted_on_demand.sql",
  );
  if (!onDemandMigration) throw new Error("published on-demand fixture SQL missing");
  db.exec(onDemandMigration.sql);
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
    clock,
    pricing,
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

export function operatorConfiguration() {
  return {
    terms: {
      termsRevision: "on-demand-composition-terms-v1",
      consentRevision: "on-demand-composition-consent-v1",
      currency: "USD",
      validity: {
        validFrom: "2026-10-01T00:00:00.000Z",
        validUntil: "2026-11-01T00:00:00.000Z",
      },
      replenishment: {
        trigger: "eligible-credit-deficit",
        rule: "ceil-deficit-to-quantum-with-minimum",
        fundingQuantumMinor: 25,
        minimumChargeMinor: 50,
        maximumChargeMinor: 1000,
      },
      cashCapBounds: { minimumMinor: 50, maximumMinor: 10000 },
      purchaseCreditExpiry: { kind: "none" },
    },
    cardSetupReturnUrls: {
      successUrl: "https://console.example.test/wallet/card-saved",
      cancelUrl: "https://console.example.test/wallet/card-canceled",
    },
    setupDisclosureRevision: "save-card-composition-v1",
  };
}
