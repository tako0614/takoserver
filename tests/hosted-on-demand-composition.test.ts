import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import sharedPricing from "../config/shared-hosted-pricing.json";
import { type App, buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import {
  createCanonicalHostedBillingComposition,
  createHostedBillingComposition,
  type HostedBillingComposition,
  type HostedOnDemandConfiguration,
} from "../src/hosted-billing-composition.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createStripeBilling } from "../src/stripe-billing.ts";
import {
  createStripeBillingClient,
  type StripeBillingObject,
} from "../src/stripe-billing-client.ts";
import type { StripeBillingStore } from "../src/stripe-billing-store.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

const START = "2026-10-15T12:00:00.000Z";
const ACCOUNT = "acct_ondemandcomposition";
const DISCLOSURE = "save-card-composition-v1";
const WEBHOOK_SECRET = "whsec_on_demand_composition_fixture";
const NO_WARNINGS = { state: "unavailable", reason: "transport-not-composed" } as const;

// Explicit fixture values; no runtime default or operator configuration is chosen.
function operatorConfiguration(): HostedOnDemandConfiguration {
  return {
    terms: {
      termsRevision: "on-demand-composition-terms-v1",
      consentRevision: "on-demand-composition-consent-v1",
      currency: "USD",
      validity: { validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2026-11-01T00:00:00.000Z" },
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
    setupDisclosureRevision: DISCLOSURE,
  };
}

async function fixture() {
  const sql = createEphemeralSql();
  let time = Date.parse(START),
    nextPending = false;
  const clock = () => new Date(time);
  const shared = {
    ...structuredClone(sharedPricing),
    plans: sharedPricing.plans.map((plan, index) => ({
      ...plan,
      stripePriceId: `price_composed${index}`,
    })),
  };
  const pricing = compilePricingAuthoring({
    authoringVersion: 2,
    sharedPricing: shared,
    planIds: { free: "free", usage: "usage" },
    checkout: { minimumMinor: 50, maximumMinor: 10000 },
    billingConfig: {
      schemaVersion: 1,
      revision: shared.revision,
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 300,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: Object.fromEntries(
        shared.plans.map((plan) => [
          plan.planId,
          {
            includedMinor: Number(BigInt(plan.includedMicros) / 10000n),
            stripePriceId: plan.stripePriceId,
          },
        ]),
      ),
      meters: Object.fromEntries(
        Object.entries(shared.meters)
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
  });
  const billingConfig = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
  if (!billingConfig) throw Error("fixture tariff missing");
  await sql.run("INSERT INTO stripe_mode_realm VALUES (1, 'test', ?)", [START]);
  await sql.run(
    "INSERT INTO stripe_billing_account_realms VALUES (1, ?, 'test', 'on-demand-composition', ?)",
    [ACCOUNT, START],
  );
  const customers = new Map<string, StripeBillingObject>();
  const sessions = new Map<string, StripeBillingObject>();
  const setupIntents = new Map<string, StripeBillingObject>();
  const intents = new Map<string, StripeBillingObject>();
  const charges = new Map<string, StripeBillingObject>();
  const refunds = new Map<string, StripeBillingObject>();
  const calls: { method: string; path: string }[] = [];
  const metadata = (form: URLSearchParams) =>
    Object.fromEntries(
      [...form.entries()]
        .filter(([key]) => key.startsWith("metadata["))
        .map(([key, value]) => [key.slice(9, -1), value]),
    );
  const client = createStripeBillingClient({
    secretKey: "sk_test_on_demand_composition_fixture",
    async fetch(request) {
      const url = new URL(request.url),
        path = url.pathname;
      calls.push({ method: request.method, path });
      if (path === "/v1/account") return Response.json({ id: ACCOUNT, object: "account" });
      const price = shared.plans.find((plan) => path === `/v1/prices/${plan.stripePriceId}`);
      if (price)
        return Response.json({
          id: price.stripePriceId,
          object: "price",
          livemode: false,
          active: true,
          currency: "usd",
          unit_amount: Number(BigInt(price.monthlyPriceMicros) / 10000n),
          type: "recurring",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      if (request.method === "POST") {
        const form = new URLSearchParams(await request.text());
        if (path === "/v1/customers") {
          const customer = {
            id: "cus_composed",
            object: "customer",
            livemode: false,
            metadata: metadata(form),
          };
          customers.set(customer.id, customer);
          return Response.json(customer);
        }
        if (path === "/v1/checkout/sessions") {
          if (form.get("mode") !== "setup") throw Error("composition attempted non-setup Checkout");
          const session: StripeBillingObject = {
            id: `cs_composed_${sessions.size + 1}`,
            object: "checkout.session",
            mode: "setup",
            livemode: false,
            metadata: metadata(form),
            customer: form.get("customer"),
            status: "open",
            setup_intent: null,
            payment_intent: null,
            subscription: null,
            invoice: null,
            amount_subtotal: null,
            amount_total: null,
            payment_method_types: ["card"],
            success_url: form.get("success_url"),
            cancel_url: form.get("cancel_url"),
            created: Math.floor(time / 1000),
            url: "https://checkout.stripe.com/c/setup/composed",
          };
          sessions.set(session.id, session);
          return Response.json(session);
        }
        if (path === "/v1/payment_intents") {
          const id = `pi_composed_${intents.size + 1}`,
            chargeId = `ch_composed_${intents.size + 1}`;
          const amount = Number(form.get("amount"));
          const charge: StripeBillingObject = {
            id: chargeId,
            object: "charge",
            livemode: false,
            payment_intent: id,
            payment_method: form.get("payment_method"),
            customer: form.get("customer"),
            currency: "usd",
            amount,
            amount_captured: amount,
            amount_refunded: 0,
            refunded: false,
            paid: true,
            captured: true,
            status: "succeeded",
            disputed: false,
            invoice: null,
            payment_method_details: { type: "card" },
            metadata: {},
          };
          const intent: StripeBillingObject = {
            id,
            object: "payment_intent",
            livemode: false,
            metadata: metadata(form),
            customer: form.get("customer"),
            payment_method: form.get("payment_method"),
            currency: "usd",
            amount,
            status: nextPending ? "processing" : "succeeded",
            amount_received: nextPending ? 0 : amount,
            amount_capturable: 0,
            latest_charge: nextPending ? null : charge,
            invoice: null,
          };
          charges.set(chargeId, charge);
          intents.set(id, intent);
          nextPending = false;
          return Response.json(intent);
        }
        throw Error(`unexpected mutation ${path}`);
      }
      if (path === "/v1/payment_methods/pm_composed")
        return Response.json({
          id: "pm_composed",
          object: "payment_method",
          livemode: false,
          type: "card",
          customer: "cus_composed",
          card: { exp_month: 12, exp_year: 2030 },
        });
      for (const [collection, values] of [
        ["customers", customers],
        ["checkout/sessions", sessions],
        ["setup_intents", setupIntents],
        ["payment_intents", intents],
        ["charges", charges],
        ["refunds", refunds],
      ] as const) {
        if (path === `/v1/${collection}`)
          return Response.json({ data: [...values.values()], has_more: false });
        if (path.startsWith(`/v1/${collection}/`)) {
          const object = values.get(path.slice(collection.length + 5));
          return object ? Response.json(object) : new Response(null, { status: 404 });
        }
      }
      if (["/v1/invoices", "/v1/subscriptions", "/v1/events"].includes(path))
        return Response.json({ data: [], has_more: false });
      throw Error(`unexpected read ${path}`);
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: ACCOUNT, mode: "test", billingAuthority: "on-demand-composition" },
    prices: shared.plans.map((plan) => ({
      priceId: plan.stripePriceId,
      monthlyAmountMinor: Number(BigInt(plan.monthlyPriceMicros) / 10000n),
    })),
  });
  const identity = {
    async verify() {
      return {
        providerSubject: "composed-owner",
        email: "owner@example.test",
        displayName: "Owner",
      };
    },
  };
  const accounts = createAccounts({ sql, clock, identity });
  const login = await accounts.signIn({ provider: "google", assertion: "fixture" });
  const actor = await accounts.authenticate(`Bearer ${login.sessionToken}`);
  if (!actor) throw Error("fixture owner missing");
  const organization = await accounts.createOrganization({ actor, name: "Composed" });
  const options = {
    sql,
    clock,
    client,
    realm,
    pricing,
    billingConfig,
    consoleOrigin: "https://console.example.test",
    warnings: NO_WARNINGS,
    webhookSecret: WEBHOOK_SECRET,
  };
  const app = (hostedBilling: HostedBillingComposition) =>
    buildApp({
      sql,
      clock,
      identity,
      hostedBilling,
      billingConfig: structuredClone(billingConfig),
      objects: createMemoryObjectStore(),
      settlement: {
        async verify() {
          throw Error("legacy funding must not run");
        },
      },
      publicOrigin: "https://api.example.test",
      v2: TEST_TAKOFORM_V2_CONFIG,
      forms: [],
      hostForms: [],
      offerings: [],
      driver: new InMemoryTakoformResourceDriver(),
    });
  return {
    ...options,
    options,
    calls,
    organization,
    actor,
    app,
    makeApp: app,
    sessions,
    intents,
    charges,
    refunds,
    pendingNextCharge() {
      nextPending = true;
    },
    advance(value: string) {
      time = Date.parse(value);
    },
    completeSetup() {
      const session = sessions.values().next().value;
      if (!session) throw Error("setup Session missing");
      session.status = "complete";
      session.setup_intent = "seti_composed";
      setupIntents.set("seti_composed", {
        id: "seti_composed",
        object: "setup_intent",
        livemode: false,
        status: "succeeded",
        usage: "off_session",
        customer: "cus_composed",
        payment_method: "pm_composed",
        payment_method_types: ["card"],
        metadata: session.metadata,
      });
      return session.id;
    },
    settleIntent(id = "pi_composed_1") {
      const intent = intents.get(id),
        charge = charges.get(id.replace("pi_", "ch_"));
      if (!intent || !charge) throw Error("original intent missing");
      intent.status = "succeeded";
      intent.amount_received = intent.amount;
      intent.latest_charge = charge;
      return intent;
    },
    async event(
      target: App,
      type: string,
      objectId: string,
      eventId = `evt_${type.replaceAll(".", "_")}`,
    ) {
      const payload = JSON.stringify({
        id: eventId,
        object: "event",
        type,
        livemode: false,
        created: Math.floor(time / 1000),
        data: {
          object: {
            id: objectId,
            object: type.startsWith("checkout")
              ? "checkout.session"
              : type.startsWith("payment_intent")
                ? "payment_intent"
                : "charge",
          },
        },
      });
      const timestamp = Math.floor(time / 1000);
      const signature = createHmac("sha256", WEBHOOK_SECRET)
        .update(`${timestamp}.${payload}`)
        .digest("hex");
      return await target.fetch(
        new Request("https://api.example.test/v1/payments/stripe/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": `t=${timestamp},v1=${signature}`,
          },
          body: payload,
        }),
      );
    },
    hold(reference: string) {
      return {
        organizationId: organization.id,
        reference,
        amountMicros: 1_500_001,
        pricingRevision: billingConfig.revision,
        measurementFingerprint: "one-micro-deficit",
        workspaceRef: "workspace_composed",
      };
    },
  };
}

async function enabled() {
  const f = await fixture();
  const composition = await createCanonicalHostedBillingComposition({
    ...f.options,
    onDemand: operatorConfiguration(),
  });
  const app = f.app(composition);
  return { ...f, composition, app };
}

async function savedCard(f: Awaited<ReturnType<typeof enabled>>) {
  if (!f.composition.cardSetup) throw Error("card setup missing");
  await f.composition.cardSetup.begin({
    organizationId: f.organization.id,
    reference: "save-card",
    authorizedPrincipal: `session:${f.actor.principalId}`,
    setupDisclosureRevision: DISCLOSURE,
  });
  const sessionId = f.completeSetup();
  expect((await f.event(f.app, "checkout.session.completed", sessionId)).status).toBe(200);
  return await f.composition.cardSetup.readSelection(f.organization.id, "save-card");
}

async function consent(f: Awaited<ReturnType<typeof enabled>>) {
  const selected = await savedCard(f);
  if (!selected || !f.composition.onDemand)
    throw Error("selected card or on-demand service missing");
  const terms = f.composition.onDemand.readTerms();
  await f.composition.limitPolicy.change({
    organizationId: f.organization.id,
    reference: "consent",
    authorizedPrincipal: `session:${f.actor.principalId}`,
    onLimit: "on-demand",
    cashCapMinor: 500,
    termsRevision: terms.termsRevision,
    consentRevision: terms.consentRevision,
    paymentMethodId: selected.paymentMethodId,
    setupIntentId: selected.setupIntentId,
  });
}

describe("canonical Hosted on-demand composition", () => {
  test("unconfigured canonical and wallet-only compositions preserve disabled fresh charging", async () => {
    const f = await fixture();
    const canonical = await createCanonicalHostedBillingComposition(f.options);
    const local = await createHostedBillingComposition({
      sql: f.sql,
      clock: f.clock,
      billingConfig: f.billingConfig,
      paymentActivation: false,
      warnings: NO_WARNINGS,
    });
    for (const composition of [canonical, local]) {
      expect(composition.status).toMatchObject({
        onDemand: false,
        cardSetup: false,
        postpaid: false,
        launchReady: false,
      });
      expect(composition.onDemand).toBeUndefined();
      expect(composition.cardSetup).toBeUndefined();
      expect(
        (await composition.limitPolicy.read(f.organization.id)).capabilities["on-demand"],
      ).toBe(false);
    }
    expect(canonical.status).toMatchObject({
      topUps: true,
      subscriptionStart: true,
      subscriptionCancellation: true,
      subscriptionPlanChange: true,
    });
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("explicit configuration binds ports and a semantically equal app tariff without selecting consent or cap", async () => {
    const f = await enabled();
    expect(f.app.hostedBilling).toMatchObject({
      onDemand: true,
      cardSetup: true,
      postpaid: false,
      launchReady: false,
    });
    expect(f.composition.setupDisclosureRevision).toBe(DISCLOSURE);
    expect(await f.composition.limitPolicy.read(f.organization.id)).toMatchObject({
      onLimit: "stop",
      cashCapMinor: null,
    });
    expect(() => f.makeApp({ ...f.composition } as HostedBillingComposition)).toThrow(
      "does not belong",
    );
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("omitted terms or implicit funding bounds refuse startup", async () => {
    const f = await fixture();
    for (const invalid of [
      null,
      {},
      { ...operatorConfiguration(), terms: {} },
      { ...operatorConfiguration(), setupDisclosureRevision: "" },
      { ...operatorConfiguration(), setupDisclosureRevision: "a".repeat(129) },
    ]) {
      await expect(
        createCanonicalHostedBillingComposition({
          ...f.options,
          onDemand: invalid as HostedOnDemandConfiguration,
        }),
      ).rejects.toThrow();
    }
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("setup Checkout is recovered by signed webhook without funding or charging consent", async () => {
    const f = await enabled();
    const selected = await savedCard(f);
    expect(selected?.paymentMethodId).toBe("pm_composed");
    expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
    expect((await f.composition.limitPolicy.read(f.organization.id)).onLimit).toBe("stop");
    expect(
      f.calls.filter((call) => call.path === "/v1/payment_intents" && call.method === "POST"),
    ).toHaveLength(0);
  });

  test("fresh canonical admission funds one genuine deficit and exact replay creates no second charge", async () => {
    const f = await enabled();
    await consent(f);
    const hold = f.hold("fresh-hold");
    expect(await f.app.orgBilling?.hold(hold)).toMatchObject({ status: "live" });
    expect(await f.app.orgBilling?.hold(hold)).toMatchObject({ status: "live" });
    expect(
      f.calls.filter((call) => call.path === "/v1/payment_intents" && call.method === "POST"),
    ).toHaveLength(1);
    expect(await f.sql.query("SELECT amount_micros FROM stripe_billing_on_demand_funding")).toEqual(
      [{ amount_micros: 500_000 }],
    );
  });

  test("PI webhook drains a dispatched original after terms expire without another POST", async () => {
    const f = await enabled();
    await consent(f);
    f.pendingNextCharge();
    await expect(f.app.orgBilling?.hold(f.hold("pending-hold"))).rejects.toThrow();
    const writes = f.calls.filter((call) => call.method === "POST").length;
    f.settleIntent();
    f.advance("2026-11-02T00:00:00.000Z");
    const response = await f.event(f.app, "payment_intent.succeeded", "pi_composed_1");
    expect(response.status).toBe(200);
    expect(await f.sql.query("SELECT amount_micros FROM stripe_billing_on_demand_funding")).toEqual(
      [{ amount_micros: 500_000 }],
    );
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(writes);
    expect((await f.event(f.app, "payment_intent.succeeded", "pi_composed_1")).status).toBe(200);
    expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_funding")).toHaveLength(1);
  });

  test("unknown PI and setup originals cannot prepare commands or start remote effects", async () => {
    const f = await enabled();
    f.intents.set("pi_unrelated", {
      id: "pi_unrelated",
      object: "payment_intent",
      livemode: false,
      metadata: { organizationId: f.organization.id, reference: "forged" },
    });
    f.sessions.set("cs_unrelated", {
      id: "cs_unrelated",
      object: "checkout.session",
      livemode: false,
      mode: "setup",
      metadata: {},
    });
    for (const [type, id] of [
      ["payment_intent.succeeded", "pi_unrelated"],
      ["checkout.session.completed", "cs_unrelated"],
    ] as const)
      expect((await f.event(f.app, type, id)).status).toBe(200);
    expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM stripe_billing_card_setup_commands")).toEqual([]);
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  });

  test("refund before first PI funding drains the same fenced original and cannot grant gross credit twice", async () => {
    const f = await enabled();
    await consent(f);
    f.pendingNextCharge();
    await expect(f.app.orgBilling?.hold(f.hold("refund-before-funding"))).rejects.toThrow();
    f.settleIntent();
    const charge = f.charges.get("ch_composed_1");
    if (!charge) throw Error("native original Charge missing");
    charge.amount_refunded = 50;
    charge.refunded = true;
    f.refunds.set("re_composed", {
      id: "re_composed",
      object: "refund",
      livemode: false,
      charge: charge.id,
      currency: "usd",
      amount: 50,
      status: "succeeded",
      created: Math.floor(Date.parse(START) / 1000),
    });
    const writes = f.calls.filter((call) => call.method === "POST").length;
    expect((await f.event(f.app, "charge.refunded", charge.id)).status).toBe(200);
    expect(
      (await f.event(f.app, "charge.refunded", charge.id, "evt_refund_distinct_delivery")).status,
    ).toBe(200);
    expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_funding")).toHaveLength(1);
    expect(await f.sql.query("SELECT amount_micros FROM stripe_billing_on_demand_refunds")).toEqual(
      [{ amount_micros: 500_000 }],
    );
    expect((await f.app.orgBilling?.wallet(f.organization.id))?.settledMicros).toBe(1_500_000);
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(writes);
  });

  test("scheduled reconciliation drains existing originals with GET-only after current terms expire", async () => {
    const f = await enabled();
    await consent(f);
    f.pendingNextCharge();
    await expect(f.app.orgBilling?.hold(f.hold("scheduler-original"))).rejects.toThrow();
    f.settleIntent();
    f.advance("2026-11-02T00:00:00.000Z");
    const writes = f.calls.filter((call) => call.method === "POST").length;
    expect(await f.app.reconcilePayments()).not.toBeNull();
    expect(await f.sql.query("SELECT amount_micros FROM stripe_billing_on_demand_funding")).toEqual(
      [{ amount_micros: 500_000 }],
    );
    expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(writes);
  });

  test("an object-shaped foreign store cannot enter the existing payment writer", async () => {
    const f = await fixture();
    expect(() =>
      createStripeBilling({
        client: f.client,
        pricing: f.pricing,
        realm: f.realm,
        context: {
          sql: f.sql,
          clock: f.clock,
          async credit() {
            return "credited";
          },
          async creditedFunding() {
            return new Set();
          },
        },
        store: {} as StripeBillingStore,
      }),
    ).toThrow();
  });
});
