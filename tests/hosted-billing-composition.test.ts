import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import sharedPricing from "../config/shared-hosted-pricing.json";
import type { AiGateway } from "../src/ai-port.ts";
import { type AppPorts, buildApp } from "../src/app.ts";
import { createAccounts, type ExternalIdentityVerifier } from "../src/auth.ts";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import {
  createCanonicalHostedBillingComposition,
  createHostedBillingComposition,
  type HostedBillingComposition,
  type HostedWarningDelivery,
} from "../src/hosted-billing-composition.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { createLedger } from "../src/ledger.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { OrgUsageWarning } from "../src/org-limit-policy.ts";
import type { Sql } from "../src/ports.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

const ORG = "org_composition";
const warningsUnavailable: HostedWarningDelivery = {
  state: "unavailable",
  reason: "transport-not-composed",
};

function fixture() {
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-10-15T12:00:00.000Z");
  const billingConfig = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "composition-r1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 300,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: { requests: { unit: "request", rate: { numeratorMicros: "1", denominator: "1" } } },
    }),
  );
  if (!billingConfig) throw new Error("missing fixture tariff");
  const ports: AppPorts = {
    sql,
    clock,
    billingConfig,
    objects: createMemoryObjectStore(),
    identity: {
      async verify() {
        throw new Error("identity not configured");
      },
    },
    settlement: {
      async verify() {
        throw new Error("settlement not configured");
      },
    },
    publicOrigin: "https://api.example.test",
    v2: TEST_TAKOFORM_V2_CONFIG,
    forms: [],
    hostForms: [],
    offerings: [],
    driver: new InMemoryTakoformResourceDriver(),
  };
  return {
    sql,
    ports,
    config: { sql, clock, billingConfig, paymentActivation: false as const },
    hold: (reference: string, amountMicros: number) => ({
      organizationId: ORG,
      reference,
      amountMicros,
      pricingRevision: billingConfig.revision,
      measurementFingerprint: "estimate",
      workspaceRef: "ws_composition",
    }),
  };
}

describe("Hosted wallet composition", () => {
  test("startup prequalification is read-only and declares payment authority unavailable", async () => {
    const f = fixture();
    const composition = await createHostedBillingComposition({
      ...f.config,
      warnings: warningsUnavailable,
    });
    expect(await f.sql.query("SELECT * FROM org_wallet_pricing_revisions")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM org_wallet_limit_policies")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM stripe_billing_customers")).toEqual([]);
    const app = buildApp({ ...f.ports, hostedBilling: composition });
    expect(app.hostedBilling).toMatchObject({
      state: "wallet-policy-only",
      launchReady: false,
      topUps: false,
      subscriptionStart: false,
      subscriptionCancellation: false,
      subscriptionPlanChange: false,
      warningDelivery: "unavailable",
    });
    expect(app.hostedBilling?.paymentPrerequisites).toContain("immutable-database-financial-realm");
  });

  test("an object-shaped stub or another SQL, clock or tariff cannot qualify startup", async () => {
    const f = fixture();
    const composition = await createHostedBillingComposition({
      ...f.config,
      warnings: warningsUnavailable,
    });
    const ports = { ...f.ports, hostedBilling: composition };
    expect(() =>
      buildApp({ ...ports, hostedBilling: { ...composition } as HostedBillingComposition }),
    ).toThrow("does not belong");
    expect(() => buildApp({ ...ports, sql: createEphemeralSql() })).toThrow("does not belong");
    expect(() => buildApp({ ...ports, clock: () => f.config.clock() })).toThrow("does not belong");
    expect(() =>
      buildApp({ ...ports, billingConfig: { ...f.config.billingConfig, revision: "changed" } }),
    ).toThrow("does not belong");
    const { billingConfig: _omitted, ...withoutTariff } = ports;
    expect(() => buildApp(withoutTariff)).toThrow("does not belong");
  });

  test("a legacy Checkout or payment event factory cannot bypass unavailable Hosted payments", async () => {
    const f = fixture();
    const composition = await createHostedBillingComposition({
      ...f.config,
      warnings: warningsUnavailable,
    });
    let called = false;
    const checkout = {
      bounds: { minimumMinor: 100, maximumMinor: 1000 },
      async begin() {
        called = true;
        return { url: "https://checkout.stripe.com/c/pay/legacy" };
      },
    };
    expect(() => buildApp({ ...f.ports, hostedBilling: composition, checkout })).toThrow(
      "canonical custody",
    );
    expect(() =>
      buildApp({
        ...f.ports,
        hostedBilling: composition,
        paymentEvents: () => {
          called = true;
          throw new Error("legacy factory");
        },
      }),
    ).toThrow("canonical custody");
    expect(called).toBe(false);
    expect(() => buildApp({ ...f.ports, checkout })).not.toThrow();
  });

  test("unresolved startup capabilities refuse before touching storage", async () => {
    const f = fixture();
    const unavailable = async () => {
      throw new Error("storage must not be used");
    };
    const sql: Sql = { query: unavailable, run: unavailable, batch: unavailable };
    await expect(
      createHostedBillingComposition({
        ...f.config,
        sql,
        paymentActivation: true as unknown as false,
        warnings: warningsUnavailable,
      }),
    ).rejects.toThrow("financial capabilities");
    await expect(
      createHostedBillingComposition({
        ...f.config,
        sql,
        warnings: { state: "configured" } as HostedWarningDelivery,
      }),
    ).rejects.toThrow("resolved at startup");
  });

  test("postpaid launch opt-in refuses before reading any financial startup inputs", async () => {
    let inputsRead = 0;
    const unavailable = () => {
      inputsRead++;
      throw new Error("financial startup inputs must not be accessed");
    };
    for (const [flag, code] of [
      [true, "postpaid_not_qualified"],
      ["true", "invalid_postpaid_enabled"],
      ["false", "invalid_postpaid_enabled"],
      [null, "invalid_postpaid_enabled"],
      [1, "invalid_postpaid_enabled"],
    ] as const) {
      const options = Object.defineProperties(
        { postpaidEnabled: flag },
        Object.fromEntries(
          ["sql", "clock", "billingConfig", "pricing", "client", "realm"].map((key) => [
            key,
            { get: unavailable },
          ]),
        ),
      );
      await expect(
        createHostedBillingComposition(
          options as unknown as Parameters<typeof createHostedBillingComposition>[0],
        ),
      ).rejects.toMatchObject({ code, status: 503 });
      await expect(
        createCanonicalHostedBillingComposition(
          options as unknown as Parameters<typeof createCanonicalHostedBillingComposition>[0],
        ),
      ).rejects.toMatchObject({ code, status: 503 });
    }
    expect(inputsRead).toBe(0);
  });

  test("omitted and explicit-off flags preserve the default stop policy", async () => {
    for (const postpaidEnabled of [undefined, false]) {
      const f = fixture();
      const composition = await createHostedBillingComposition({
        ...f.config,
        warnings: warningsUnavailable,
        postpaidEnabled,
      });
      expect(await composition.limitPolicy.read(ORG)).toMatchObject({
        onLimit: "stop",
        capabilities: { postpaid: false },
      });
      expect(await f.sql.query("SELECT * FROM org_wallet_limit_policy_commands")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual([]);
    }
  });

  test("missing durable policy guards fail startup even when the tables exist", async () => {
    const f = fixture();
    await f.sql.run("DROP TRIGGER org_wallet_limit_policy_version");
    await expect(
      createHostedBillingComposition({ ...f.config, warnings: warningsUnavailable }),
    ).rejects.toMatchObject({ code: "billing_schema_not_ready" });
  });

  test("the same composed policy enforces stop then explicit prepaid on the canonical wallet", async () => {
    const f = fixture();
    const composition = await createHostedBillingComposition({
      ...f.config,
      warnings: warningsUnavailable,
    });
    const app = buildApp({ ...f.ports, hostedBilling: composition });
    await createLedger(f.sql, f.config.clock).fund({
      organizationId: ORG,
      fundingRef: "original-purchase",
      kind: "purchased",
      consumptionClass: "purchased",
      amountMicros: 100_000,
    });
    const hold = f.hold("hold", 1_500_001);
    await expect(app.orgBilling?.hold(hold)).rejects.toMatchObject({ status: 402 });
    await composition.limitPolicy.change({
      organizationId: ORG,
      reference: "consent",
      authorizedPrincipal: "session:owner",
      onLimit: "prepaid",
    });
    expect(await app.orgBilling?.hold(hold)).toMatchObject({
      status: "live",
      amountMicros: 1_500_001,
    });
    expect(
      await f.sql.query(
        "SELECT lot_ref, amount_micros FROM wallet_credit_allocations WHERE org_id = ? AND lot_ref = ?",
        [ORG, "original-purchase"],
      ),
    ).toMatchObject([{ lot_ref: "original-purchase", amount_micros: 1 }]);
  });

  test("Hosted assembly requires explicit Workspace attribution for new admissions", async () => {
    const f = fixture();
    const composition = await createHostedBillingComposition({
      ...f.config,
      warnings: warningsUnavailable,
    });
    const app = buildApp({ ...f.ports, hostedBilling: composition });
    const { workspaceRef: _omitted, ...unattributed } = f.hold("missing_workspace", 1);
    await expect(app.orgBilling?.hold(unattributed)).rejects.toMatchObject({
      code: "invalid_reference",
      status: 400,
    });
    expect(
      await f.sql.query("SELECT * FROM wallet_credit_allocations WHERE org_id = ?", [ORG]),
    ).toEqual([]);
    expect(await app.orgBilling?.hold(f.hold("explicit_workspace", 1))).toMatchObject({
      status: "live",
      workspaceRef: "ws_composition",
    });
  });

  test("concurrent first data-plane use receives one eligible grant without a summary read", async () => {
    const f = fixture();
    const identity: ExternalIdentityVerifier = {
      async verify() {
        return {
          providerSubject: "first-use",
          email: "first-use@example.test",
          displayName: "First use",
        };
      },
    };
    const accounts = createAccounts({
      sql: f.sql,
      clock: f.config.clock,
      identity,
      randomId: () => crypto.randomUUID(),
    });
    const signedIn = await accounts.signIn({ provider: "google", assertion: "first-use" });
    const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
    if (!actor) throw new Error("fixture session missing");
    const organization = await accounts.createOrganization({ actor, name: "First use" });
    const key = await accounts.createApiKey({
      actor,
      organizationId: organization.id,
      name: "AI",
      scopes: ["ai:invoke"],
      expiresInSeconds: 3600,
    });
    const composition = await createHostedBillingComposition({
      ...f.config,
      warnings: warningsUnavailable,
    });
    let calls = 0;
    const ai: AiGateway = {
      models: [
        {
          id: "test",
          created: 1_787_054_400,
          ownedBy: "takoserver",
          limits: { maxInputTokens: 100, maxOutputTokens: 10 },
          price: { inputMinorPerMillionTokens: 100_000, outputMinorPerMillionTokens: 100_000 },
        },
      ],
      async chat() {
        calls++;
        return {
          id: `chat_${calls}`,
          object: "chat.completion",
          created: 1_787_054_400,
          model: "test",
          choices: [
            { index: 0, message: { role: "assistant", content: "hello" }, finish_reason: "stop" },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        };
      },
    };
    const app = buildApp({ ...f.ports, identity, ai, hostedBilling: composition });
    const invoke = (reference: string) =>
      app.fetch(
        new Request("https://api.example.test/v1/ai/chat/completions", {
          method: "POST",
          headers: {
            authorization: `Bearer ${key.secret}`,
            "content-type": "application/json",
            "idempotency-key": reference,
          },
          body: JSON.stringify({
            model: "test",
            messages: [{ role: "user", content: "Hi" }],
            max_tokens: 2,
          }),
        }),
      );
    const responses = await Promise.all([invoke("first_one"), invoke("first_two")]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(calls).toBe(2);
    expect(
      await f.sql.query("SELECT amount_micros FROM org_wallet_grant_snapshots WHERE org_id = ?", [
        organization.id,
      ]),
    ).toEqual([{ amount_micros: 1_500_000 }]);
    expect(await invoke("first_one")).toMatchObject({ status: 200 });
    expect(calls).toBe(2);
    expect((await app.orgBilling?.wallet(organization.id))?.settledMicros).toBe(1_490_000);
  });

  test("first internal admission during verified paid coverage does not stack Free", async () => {
    const f = fixture();
    const composition = await createHostedBillingComposition({
      ...f.config,
      warnings: warningsUnavailable,
    });
    const app = buildApp({ ...f.ports, hostedBilling: composition });
    await createStripeBillingStore({ sql: f.sql, clock: f.config.clock }).grant({
      organizationId: ORG,
      fundingRef: "stripe:invoice:in_paid",
      kind: "plan-included",
      amountMicros: 20_000_000,
      expiresAt: "2026-11-01T00:00:00.000Z",
      sourceType: "invoice",
      sourceId: "in_paid",
      chargeId: "ch_paid",
      customerId: "cus_paid",
      subscriptionId: "sub_paid",
      planKey: "starter",
      pricingRevision: f.config.billingConfig.revision,
      stripePriceId: "price_paid",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      considerationMicros: 10_000_000,
    });
    await app.orgBilling?.hold(f.hold("paid_hold", 1));
    expect(
      await f.sql.query(
        "SELECT * FROM wallet_credit_lots WHERE org_id = ? AND consumption_class = 'free'",
        [ORG],
      ),
    ).toEqual([]);
    expect((await app.orgBilling?.wallet(ORG))?.settledMicros).toBe(20_000_000);
    expect(
      await f.sql.query("SELECT lot_ref FROM wallet_credit_allocations WHERE org_id = ?", [ORG]),
    ).toEqual([{ lot_ref: "stripe:invoice:in_paid" }]);
  });

  test("the real outbox survives release and maintenance dispatches each warning once", async () => {
    const f = fixture();
    const delivered = new Map<string, OrgUsageWarning>();
    const composition = await createHostedBillingComposition({
      ...f.config,
      warnings: {
        state: "configured",
        transport: {
          async deliver(warning, key) {
            delivered.set(key, warning);
            return { deliveryReference: `notification_${delivered.size}` };
          },
        },
      },
    });
    const app = buildApp({ ...f.ports, hostedBilling: composition });
    await app.orgBilling?.hold(f.hold("hold_80", 1_200_000));
    await app.orgBilling?.usageSummary(ORG);
    await app.orgBilling?.hold(f.hold("hold_95", 225_000));
    await app.orgBilling?.usageSummary(ORG);
    await app.orgBilling?.release(ORG, "hold_95");
    await app.orgBilling?.release(ORG, "hold_80");
    expect(await app.maintenance.billingWarnings?.dispatchWarnings()).toBe(2);
    expect(await app.maintenance.billingWarnings?.dispatchWarnings()).toBe(0);
    expect([...delivered.values()].map((warning) => warning.thresholdBasisPoints).sort()).toEqual([
      8000, 9500,
    ]);
    expect(app.hostedBilling?.warningDelivery).toBe("configured");
  });

  test("declared unavailable transport preserves pending warning claims", async () => {
    const f = fixture();
    const composition = await createHostedBillingComposition({
      ...f.config,
      warnings: warningsUnavailable,
    });
    const app = buildApp({ ...f.ports, hostedBilling: composition });
    await app.orgBilling?.hold(f.hold("hold_80", 1_200_000));
    await app.orgBilling?.usageSummary(ORG);
    const pending = await f.sql.query("SELECT * FROM org_wallet_usage_warnings");
    expect(pending).toHaveLength(1);
    await expect(app.maintenance.billingWarnings?.dispatchWarnings()).rejects.toThrow(
      "transport is unavailable",
    );
    expect(await f.sql.query("SELECT * FROM org_wallet_usage_warnings")).toEqual(pending);
  });
});

async function financialFixture() {
  const f = fixture();
  const compiled = {
    ...structuredClone(sharedPricing),
    plans: sharedPricing.plans.map((plan, index) => ({
      ...plan,
      stripePriceId: `price_composition${index === 0 ? "10" : "50"}`,
    })),
  };
  const meters = Object.fromEntries(
    Object.entries(compiled.meters)
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
  );
  const pricing = compilePricingAuthoring({
    authoringVersion: 2,
    sharedPricing: compiled,
    planIds: { free: "free", usage: "usage" },
    billingConfig: {
      schemaVersion: 1,
      revision: compiled.revision,
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 300,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: Object.fromEntries(
        compiled.plans.map((plan) => [
          plan.planId,
          {
            includedMinor: Number(BigInt(plan.includedMicros) / 10_000n),
            stripePriceId: plan.stripePriceId,
          },
        ]),
      ),
      meters,
    },
    checkout: { minimumMinor: 50, maximumMinor: 10000 },
  });
  const billingConfig = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
  if (!billingConfig) throw new Error("missing financial tariff");
  await f.sql.run("INSERT INTO stripe_mode_realm VALUES (1, 'test', ?)", [
    f.config.clock().toISOString(),
  ]);
  await f.sql.run(
    "INSERT INTO stripe_billing_account_realms VALUES (1, 'acct_composition', 'test', 'composition-test', ?)",
    [f.config.clock().toISOString()],
  );
  const requests: Request[] = [];
  const customers = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const refunds = new Map<string, Record<string, unknown>>();
  const intentMetadata = new Map<string, Record<string, string>>();
  const lineItemPrices = new Map<string, string>();
  const keys = new Map<string, string>();
  const metadata = (form: URLSearchParams, prefix: string) =>
    Object.fromEntries(
      [...form.entries()]
        .filter(([name]) => name.startsWith(`${prefix}[`))
        .map(([name, value]) => [name.slice(prefix.length + 1, -1), value]),
    );
  const client = createStripeBillingClient({
    secretKey: "sk_test_composition_fixture",
    async fetch(request) {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/account")
        return Response.json({ id: "acct_composition", object: "account" });
      if (
        ["/v1/invoices", "/v1/subscriptions", "/v1/events"].includes(url.pathname) &&
        request.method === "GET"
      )
        return Response.json({ data: [], has_more: false });
      const price = compiled.plans.find(
        (plan) => url.pathname === `/v1/prices/${plan.stripePriceId}`,
      );
      if (price)
        return Response.json({
          id: price.stripePriceId,
          object: "price",
          livemode: false,
          active: true,
          currency: "usd",
          unit_amount: Number(BigInt(price.monthlyPriceMicros) / 10_000n),
          type: "recurring",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      if (request.method === "POST" && url.pathname === "/v1/customers") {
        const form = new URLSearchParams(await request.clone().text());
        const key = request.headers.get("idempotency-key");
        if (!key) throw new Error("missing stable key");
        let id = keys.get(key);
        if (!id) {
          id = `cus_composition${customers.size + 1}`;
          keys.set(key, id);
          customers.set(id, {
            id,
            object: "customer",
            livemode: false,
            metadata: metadata(form, "metadata"),
          });
        }
        return Response.json(customers.get(id));
      }
      if (url.pathname === "/v1/customers")
        return Response.json({ data: [...customers.values()], has_more: false });
      if (url.pathname.startsWith("/v1/customers/"))
        return Response.json(customers.get(url.pathname.split("/").at(-1) ?? ""));
      if (request.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        const form = new URLSearchParams(await request.clone().text());
        const key = request.headers.get("idempotency-key");
        if (!key) throw new Error("missing stable key");
        let id = keys.get(key);
        if (!id) {
          id = `cs_composition${sessions.size + 1}`;
          keys.set(key, id);
          const mode = form.get("mode");
          sessions.set(id, {
            id,
            object: "checkout.session",
            livemode: false,
            mode,
            client_reference_id: form.get("client_reference_id"),
            customer: form.get("customer"),
            amount_total:
              mode === "payment"
                ? Number(form.get("line_items[0][price_data][unit_amount]"))
                : 1000,
            amount_subtotal:
              mode === "payment"
                ? Number(form.get("line_items[0][price_data][unit_amount]"))
                : 1000,
            currency: "usd",
            metadata: metadata(form, "metadata"),
            status: "open",
            payment_status: "unpaid",
            payment_intent: null,
            subscription: null,
            invoice: null,
            after_expiration: null,
            recovered_from: null,
            created: Math.floor(f.config.clock().getTime() / 1000),
            expires_at: Number(
              form.get("expires_at") ?? Math.floor(f.config.clock().getTime() / 1000) + 3600,
            ),
            url: `https://checkout.stripe.com/c/pay/${id}`,
          });
          intentMetadata.set(id, metadata(form, "payment_intent_data[metadata]"));
          const priceId = form.get("line_items[0][price]");
          if (priceId) lineItemPrices.set(id, priceId);
        }
        return Response.json(sessions.get(id));
      }
      if (url.pathname === "/v1/checkout/sessions")
        return Response.json({ data: [...sessions.values()], has_more: false });
      if (url.pathname.endsWith("/line_items")) {
        const sessionId = url.pathname.split("/").at(-2) ?? "";
        return Response.json({
          data: [
            {
              id: "li_composition",
              object: "item",
              price: lineItemPrices.get(sessionId),
              quantity: 1,
            },
          ],
          has_more: false,
        });
      }
      if (url.pathname === "/v1/charges/ch_composition") {
        const paid = [...sessions.values()].find((session) => session.payment_status === "paid");
        const intent = paid?.payment_intent as Record<string, unknown> | undefined;
        return intent ? Response.json(intent.latest_charge) : new Response("", { status: 404 });
      }
      if (url.pathname === "/v1/refunds")
        return Response.json({ data: [...refunds.values()], has_more: false });
      if (url.pathname === "/v1/refunds/re_composition")
        return Response.json(refunds.get("re_composition"));
      const session = sessions.get(url.pathname.split("/").at(-1) ?? "");
      if (session) return Response.json(session);
      return new Response("", { status: 404 });
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql: f.sql,
    reader: { client },
    expected: { accountId: "acct_composition", mode: "test", billingAuthority: "composition-test" },
    prices: compiled.plans.map((plan) => ({
      priceId: plan.stripePriceId,
      monthlyAmountMinor: Number(BigInt(plan.monthlyPriceMicros) / 10_000n),
    })),
  });
  const identity: ExternalIdentityVerifier = {
    async verify() {
      return {
        providerSubject: "financial",
        email: "financial@example.test",
        displayName: "Financial",
      };
    },
  };
  const accounts = createAccounts({
    sql: f.sql,
    clock: f.config.clock,
    identity,
    randomId: () => crypto.randomUUID(),
  });
  const signedIn = await accounts.signIn({ provider: "google", assertion: "financial" });
  const actor = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
  if (!actor) throw new Error("financial fixture actor absent");
  const organization = await accounts.createOrganization({ actor, name: "Financial" });
  const options = {
    sql: f.sql,
    clock: f.config.clock,
    billingConfig,
    pricing,
    client,
    realm,
    consoleOrigin: "https://console.example.test",
    warnings: warningsUnavailable,
    webhookSecret: "whsec_composition_fixture",
  };
  return {
    ...f,
    options,
    requests,
    customers,
    sessions,
    accounts,
    actor,
    organization,
    token: signedIn.sessionToken,
    refund(sessionId: string) {
      const session = sessions.get(sessionId);
      const intent = session?.payment_intent as Record<string, unknown> | undefined;
      const charge = intent?.latest_charge as Record<string, unknown> | undefined;
      if (!session || !charge) throw new Error("paid source absent");
      charge.amount_refunded = session.amount_total;
      charge.refunded = true;
      refunds.set("re_composition", {
        id: "re_composition",
        object: "refund",
        livemode: false,
        status: "succeeded",
        amount: session.amount_total,
        currency: "usd",
        charge: "ch_composition",
        payment_intent: "pi_composition",
      });
    },
    settle(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("session absent");
      session.status = "complete";
      session.payment_status = "paid";
      session.payment_intent = {
        id: "pi_composition",
        object: "payment_intent",
        livemode: false,
        customer: session.customer,
        currency: "usd",
        amount: session.amount_total,
        amount_received: session.amount_total,
        status: "succeeded",
        metadata: intentMetadata.get(sessionId),
        latest_charge: {
          id: "ch_composition",
          object: "charge",
          livemode: false,
          customer: session.customer,
          currency: "usd",
          amount: session.amount_total,
          paid: true,
          status: "succeeded",
          captured: true,
          refunded: false,
          amount_refunded: 0,
          disputed: false,
          payment_intent: "pi_composition",
          invoice: null,
          refunds: { data: [], has_more: false },
        },
      };
    },
  };
}

describe("canonical Hosted financial composition", () => {
  test("uses one customer and the existing signed-webhook writer for first free-org top-up", async () => {
    const f = await financialFixture();
    const composition = await createCanonicalHostedBillingComposition({
      ...f.options,
      postpaidEnabled: false,
    });
    expect((await composition.limitPolicy.read(f.organization.id)).capabilities.postpaid).toBe(
      false,
    );
    const app = buildApp({
      ...f.ports,
      billingConfig: f.options.billingConfig,
      hostedBilling: composition,
    });
    expect(app.hostedBilling).toMatchObject({
      state: "test-payments-configured",
      topUps: true,
      subscriptionPlanChange: true,
      launchReady: false,
    });
    const begin = () =>
      app.fetch(
        new Request(
          `https://api.example.test/v1/organizations/${f.organization.id}/wallet/checkout`,
          {
            method: "POST",
            headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
            body: JSON.stringify({ reference: "first-topup", amountMinor: 500 }),
          },
        ),
      );
    const responses = await Promise.all([begin(), begin()]);
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    expect(f.customers.size).toBe(1);
    expect(f.sessions.size).toBe(1);
    const sessionId = [...f.sessions.keys()][0];
    if (!sessionId) throw new Error("Checkout session missing");
    f.settle(sessionId);
    const returned = await app.fetch(
      new Request(`https://api.example.test/v1/organizations/${f.organization.id}/wallet/funding`, {
        method: "POST",
        headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
        body: JSON.stringify({ settlementProof: sessionId }),
      }),
    );
    expect(returned.status).toBe(200);
    const payload = JSON.stringify({
      id: "evt_composition",
      object: "event",
      type: "checkout.session.completed",
      livemode: false,
      created: Math.floor(f.options.clock().getTime() / 1000),
      data: { object: { id: sessionId, object: "checkout.session" } },
    });
    const timestamp = Math.floor(f.options.clock().getTime() / 1000);
    const signature = `t=${timestamp},v1=${createHmac("sha256", f.options.webhookSecret).update(`${timestamp}.${payload}`).digest("hex")}`;
    const receive = () =>
      app.fetch(
        new Request("https://api.example.test/v1/payments/stripe/webhook", {
          method: "POST",
          headers: { "content-type": "application/json", "stripe-signature": signature },
          body: payload,
        }),
      );
    expect((await receive()).status).toBe(200);
    expect((await receive()).status).toBe(200);
    expect(await app.reconcilePayments()).toMatchObject({ alreadyCredited: 1 });
    expect(
      await f.sql.query(
        "SELECT amount_micros FROM stripe_billing_grants WHERE org_id = ? AND source_type = 'checkout'",
        [f.organization.id],
      ),
    ).toEqual([{ amount_micros: 5_000_000 }]);
    expect((await app.orgBilling?.wallet(f.organization.id))?.settledMicros).toBe(6_500_000);
  });

  test("rejects a cloned realm, changed Checkout bounds and missing webhook before remote effects", async () => {
    const f = await financialFixture();
    const before = f.requests.length;
    await expect(
      createCanonicalHostedBillingComposition({ ...f.options, realm: { ...f.options.realm } }),
    ).rejects.toMatchObject({ code: "unqualified_realm" });
    await expect(
      createCanonicalHostedBillingComposition({
        ...f.options,
        settings: { checkoutMinimumMinor: 100 },
      }),
    ).rejects.toThrow("Checkout bounds");
    await expect(
      createCanonicalHostedBillingComposition({ ...f.options, webhookSecret: "" }),
    ).rejects.toThrow("webhook capability");
    expect(f.requests).toHaveLength(before);
    expect(f.customers.size).toBe(0);
  });

  test("refuses active financial startup when a subscription history guard is missing", async () => {
    const f = await financialFixture();
    const requests = f.requests.length;
    await f.sql.run("DROP TRIGGER stripe_billing_subscription_terms_no_update");
    await expect(createCanonicalHostedBillingComposition(f.options)).rejects.toMatchObject({
      code: "billing_schema_not_ready",
      status: 503,
    });
    expect(f.requests).toHaveLength(requests);
    expect(f.customers.size).toBe(0);
  });

  test("refuses active financial startup when a customer or top-up custody guard is missing", async () => {
    for (const trigger of [
      "stripe_top_up_command_immutable",
      "stripe_billing_customer_commands_no_delete",
    ]) {
      const f = await financialFixture();
      const requests = f.requests.length;
      await f.sql.run(`DROP TRIGGER ${trigger}`);
      await expect(createCanonicalHostedBillingComposition(f.options)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(f.requests).toHaveLength(requests);
      expect(f.customers.size).toBe(0);
    }
  });

  test("return funding authorizes the exact Org and parses the body before processor reads", async () => {
    const f = await financialFixture();
    const hosted = await createCanonicalHostedBillingComposition(f.options);
    const app = buildApp({
      ...f.ports,
      billingConfig: f.options.billingConfig,
      hostedBilling: hosted,
    });
    const requests = f.requests.length;
    const command = (org: string, body: string, authorization?: string) =>
      app.fetch(
        new Request(`https://api.example.test/v1/organizations/${org}/wallet/funding`, {
          method: "POST",
          headers: {
            ...(authorization === undefined ? {} : { authorization }),
            "content-type": "application/json",
          },
          body,
        }),
      );
    expect((await command(f.organization.id, "{")).status).toBe(401);
    expect((await command("org_unknown", "{", `Bearer ${f.token}`)).status).toBe(404);
    expect((await command(f.organization.id, "{", `Bearer ${f.token}`)).status).toBe(400);
    expect(f.requests).toHaveLength(requests);
    expect(
      await f.sql.query("SELECT * FROM stripe_billing_grants WHERE org_id = ?", [
        f.organization.id,
      ]),
    ).toEqual([]);
  });

  test("public subscription start uses genuine custody and the same customer as top-up", async () => {
    const f = await financialFixture();
    const composition = await createCanonicalHostedBillingComposition(f.options);
    const app = buildApp({
      ...f.ports,
      billingConfig: f.options.billingConfig,
      hostedBilling: composition,
    });
    const command = (path: string, body: unknown) =>
      app.fetch(
        new Request(`https://api.example.test/v1/organizations/${f.organization.id}/${path}`, {
          method: "POST",
          headers: { authorization: `Bearer ${f.token}`, "content-type": "application/json" },
          body: JSON.stringify(body),
        }),
      );
    expect(
      (await command("wallet/checkout", { reference: "shared-customer", amountMinor: 500 })).status,
    ).toBe(201);
    const body = { reference: "start", planKey: "hosted-10" };
    const started = await command("payments/subscription", body);
    expect(started.status).toBe(201);
    const receipt = (await started.json()) as {
      checkout: { state: string; id: string; url: string };
    };
    expect(receipt.checkout.state).toBe("open");
    const replay = await command("payments/subscription", body);
    expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(receipt);
    expect(f.customers.size).toBe(1);
    expect(new Set([...f.sessions.values()].map((session) => session.customer)).size).toBe(1);
    expect(
      await f.sql.query("SELECT * FROM stripe_billing_grants WHERE org_id = ?", [
        f.organization.id,
      ]),
    ).toEqual([]);
  });

  test("an old top-up settles under its original expiry after a tariff rotation", async () => {
    const f = await financialFixture();
    let instant = "2026-10-15T12:00:00.000Z";
    const clock = () => new Date(instant);
    const legacyPricing = (
      revision: string,
      expiry: { kind: "none" } | { kind: "fixed-duration"; seconds: number },
      history?: unknown,
    ) =>
      compilePricingAuthoring({
        authoringVersion: 1,
        planIds: { free: "free", subscription: "starter", usage: "usage" },
        billingConfig: {
          schemaVersion: 1,
          revision,
          effectiveAt:
            revision === "historical-r1" ? "2026-10-01T00:00:00.000Z" : "2026-10-15T12:00:00.000Z",
          currency: "USD",
          holdTtlSeconds: 300,
          freeIncludedMinor: 150,
          purchaseCreditExpiry: expiry,
          plans: { starter: { includedMinor: 2000, stripePriceId: "price_composition10" } },
          meters: {},
          ...(history === undefined ? {} : { history }),
        },
        checkout: { minimumMinor: 50, maximumMinor: 10000 },
        stripeMonthlyReview: {
          starter: { expectedAmountMinor: 1000, currency: "USD", interval: "month" },
        },
      });
    const r1 = legacyPricing("historical-r1", { kind: "fixed-duration", seconds: 86400 });
    const r1Config = parseBillingConfig(r1.environment.TAKOSERVER_BILLING_CONFIG);
    if (!r1Config) throw new Error("R1 config absent");
    const realm = await verifyHostedBillingFinancialRealm({
      sql: f.sql,
      reader: { client: f.options.client },
      expected: {
        accountId: "acct_composition",
        mode: "test",
        billingAuthority: "composition-test",
      },
      prices: [{ priceId: "price_composition10", monthlyAmountMinor: 1000 }],
    });
    const optionsR1 = { ...f.options, clock, realm, pricing: r1, billingConfig: r1Config };
    const old = await createCanonicalHostedBillingComposition(optionsR1);
    if (!old.paymentActivation) throw new Error("financial fixture unavailable");
    await old.checkout.begin({
      organizationId: f.organization.id,
      reference: "original-expiry",
      amountMinor: 500,
    });
    const sessionId = [...f.sessions.keys()][0];
    if (!sessionId) throw new Error("original checkout absent");
    f.settle(sessionId);
    const r2 = legacyPricing("historical-r2", { kind: "none" }, [r1Config]);
    const r2Config = parseBillingConfig(r2.environment.TAKOSERVER_BILLING_CONFIG);
    if (!r2Config) throw new Error("R2 config absent");
    const active = await createCanonicalHostedBillingComposition({
      ...optionsR1,
      pricing: r2,
      billingConfig: r2Config,
    });
    const app = buildApp({ ...f.ports, clock, billingConfig: r2Config, hostedBilling: active });
    const receive = async (eventId: string, refund = false) => {
      const seconds = Math.floor(clock().getTime() / 1000);
      const body = JSON.stringify({
        id: eventId,
        object: "event",
        type: refund ? "charge.refunded" : "checkout.session.completed",
        livemode: false,
        created: seconds,
        data: {
          object: {
            id: refund ? "ch_composition" : sessionId,
            object: refund ? "charge" : "checkout.session",
          },
        },
      });
      const signature = createHmac("sha256", f.options.webhookSecret)
        .update(`${seconds}.${body}`)
        .digest("hex");
      return await app.fetch(
        new Request("https://api.example.test/v1/payments/stripe/webhook", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "stripe-signature": `t=${seconds},v1=${signature}`,
          },
          body,
        }),
      );
    };
    expect((await receive("evt_old_first")).status).toBe(200);
    const original = await f.sql.query(
      "SELECT amount_micros, expires_at, pricing_revision FROM stripe_billing_grants WHERE org_id = ?",
      [f.organization.id],
    );
    expect(original).toEqual([
      {
        amount_micros: 5_000_000,
        expires_at: "2026-10-16T12:00:00.000Z",
        pricing_revision: "historical-r1",
      },
    ]);
    instant = "2026-10-15T13:00:00.000Z";
    expect((await receive("evt_old_later")).status).toBe(200);
    expect(
      await f.sql.query(
        "SELECT amount_micros, expires_at, pricing_revision FROM stripe_billing_grants WHERE org_id = ?",
        [f.organization.id],
      ),
    ).toEqual(original);
    f.refund(sessionId);
    expect((await receive("evt_old_refunded", true)).status).toBe(200);
    expect(
      await f.sql.query(
        "SELECT target_revoked_micros FROM stripe_billing_refunds WHERE refund_id = 're_composition'",
      ),
    ).toEqual([{ target_revoked_micros: 5_000_000 }]);
    expect(
      await f.sql.query(
        "SELECT amount_micros, expires_at, pricing_revision FROM stripe_billing_grants WHERE org_id = ?",
        [f.organization.id],
      ),
    ).toEqual(original);
  });

  test("separate product service keys spend one Organization allowance and retain Workspace attribution", async () => {
    const f = await financialFixture();
    const hosted = await createCanonicalHostedBillingComposition(f.options);
    const app = buildApp({
      ...f.ports,
      billingConfig: f.options.billingConfig,
      hostedBilling: hosted,
    });
    const keys = await Promise.all(
      ["takoserver", "takosumi"].map((name) =>
        f.accounts.createApiKey({
          actor: f.actor,
          organizationId: f.organization.id,
          name,
          scopes: ["wallet:read", "wallet:write"],
          expiresInSeconds: 3600,
        }),
      ),
    );
    const responses = await Promise.all(
      keys.map((key, index) =>
        app.fetch(
          new Request(
            `https://api.example.test/v1/organizations/${f.organization.id}/wallet/holds`,
            {
              method: "POST",
              headers: {
                authorization: `Bearer ${key.secret}`,
                "content-type": "application/json",
              },
              body: JSON.stringify({
                reference: `product_${index}`,
                workspaceRef: `workspace_${index}`,
                amountMicros: "600000",
                pricingRevision: f.options.billingConfig.revision,
                measurementFingerprint: "estimate",
              }),
            },
          ),
        ),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([201, 201]);
    const summary = await app.orgBilling?.usageSummary(f.organization.id);
    expect(summary).toMatchObject({
      originalIncludedMicros: 1_500_000,
      heldMicros: 1_200_000,
      availableMicros: 300_000,
    });
    expect(
      await f.sql.query(
        "SELECT COUNT(*) AS grants FROM org_wallet_grant_snapshots WHERE org_id = ?",
        [f.organization.id],
      ),
    ).toEqual([{ grants: 1 }]);
    expect(
      await f.sql.query(
        "SELECT workspace_ref FROM org_wallet_holds WHERE org_id = ? ORDER BY workspace_ref",
        [f.organization.id],
      ),
    ).toEqual([{ workspace_ref: "workspace_0" }, { workspace_ref: "workspace_1" }]);
  });
});
