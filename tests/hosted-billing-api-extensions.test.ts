import { expect, test } from "bun:test";
import { type AppPorts, buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import {
  type CreateControlRoutesOptions,
  type CustodiedSubscriptionPayments,
  controlErrorResponse,
  createControlRoutes,
} from "../src/control.ts";
import { classifyRefusal } from "../src/error-envelope.ts";
import {
  createCanonicalHostedBillingComposition,
  createHostedBillingComposition,
} from "../src/hosted-billing-composition.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { createLedger } from "../src/ledger.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { openApiDocument } from "../src/openapi.ts";
import { createOrgBilling } from "../src/org-billing.ts";
import { createOrgLimitPolicy, OrgLimitPolicyError } from "../src/org-limit-policy.ts";
import { parseOrgOnDemandTerms } from "../src/org-on-demand-terms.ts";
import {
  createOrgTopUps,
  OrgTopUpError,
  type TopUpClient,
  type TopUpSession,
} from "../src/org-top-up.ts";
import { OrgWorkspaceUsageError } from "../src/org-workspace-usage.ts";
import type { Sql } from "../src/ports.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { StripeCardSetupError, type StripeCardSetupReceipt } from "../src/stripe-card-setup.ts";
import { SubscriptionPlanChangeError } from "../src/stripe-subscription-plan-change.ts";
import {
  SUBSCRIPTION_COMMAND_RECEIPT_VERSION,
  type SubscriptionCommandReceipt,
  SubscriptionCommandReceiptError,
} from "../src/subscription-command-receipts.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

const START = "2026-10-15T12:00:00.000Z";
const TARGET = `sra_${"a".repeat(64)}`;
const URL = "https://checkout.stripe.com/c/pay/test_checkout";
const BILLING_CONFIG = {
  schemaVersion: 1,
  revision: "api-extension-r1",
  effectiveAt: "2026-09-01T00:00:00.000Z",
  currency: "USD",
  freeIncludedMinor: 150,
  holdTtlSeconds: 86_400,
  purchaseCreditExpiry: { kind: "none" },
  plans: { configured: { includedMinor: 2000, stripePriceId: "price_apiExtensions" } },
  meters: { requests: { unit: "request", rate: { numeratorMicros: "1", denominator: "1" } } },
} as const;
const PRICING = compilePricingAuthoring({
  authoringVersion: 1,
  billingConfig: BILLING_CONFIG,
  checkout: { minimumMinor: 50, maximumMinor: 5000 },
  planIds: { free: "free", subscription: "configured", usage: "usage" },
  stripeMonthlyReview: {
    configured: { expectedAmountMinor: 1000, currency: "USD", interval: "month" },
  },
});

async function fixture(createOrganization = true) {
  const sql = createEphemeralSql();
  let time = START;
  let sequence = 0;
  const clock = () => new Date(time);
  const accounts = createAccounts({
    sql,
    clock,
    randomSecret: () => `test_only_billing_bearer_${sequence++}`,
    identity: {
      async verify({ assertion }) {
        return {
          providerSubject: assertion,
          email: "local@example.test",
          displayName: "Local owner",
        };
      },
    },
  });
  const signIn = await accounts.signIn({ provider: "google", assertion: "local-owner" });
  const owner = await accounts.authenticate(`Bearer ${signIn.sessionToken}`);
  if (!owner) throw new Error("local fixture owner unavailable");
  const organization = createOrganization
    ? await accounts.createOrganization({ actor: owner, name: "Company" })
    : null;
  const tokens: Record<string, string> = { owner: signIn.sessionToken };
  const keyIds: Record<string, string> = {};
  if (organization) {
    for (const [name, scopes] of [
      ["reader", ["wallet:read"]],
      ["payer", ["payments:write"]],
      ["walletWriter", ["wallet:write"]],
      ["usageWriter", ["usage:write"]],
    ] as const) {
      const issued = await accounts.createApiKey({
        actor: owner,
        organizationId: organization.id,
        name,
        scopes,
        expiresInSeconds: 3600,
      });
      tokens[name] = issued.secret;
      keyIds[name] = issued.apiKey.id;
    }
    const other = await accounts.createOrganization({ actor: owner, name: "Other Company" });
    const issued = await accounts.createApiKey({
      actor: owner,
      organizationId: other.id,
      name: "foreign",
      scopes: ["wallet:read", "payments:write"],
      expiresInSeconds: 3600,
    });
    tokens.foreign = issued.secret;
  }
  const config = parseBillingConfig(JSON.stringify(BILLING_CONFIG));
  if (!config) throw new Error("fixture tariff missing");
  const ledger = createLedger(sql, clock, { hostedPaidFreeExclusion: true });
  const limitPolicy = createOrgLimitPolicy({ sql, clock });
  const billing = createOrgBilling({
    sql,
    clock,
    ledger,
    config,
    limitPolicy,
    hostedPaidFreeExclusion: true,
  });
  const remoteCalls: string[] = [];
  const sessions = new Map<string, TopUpSession>();
  const processor: TopUpClient = {
    async create(command) {
      remoteCalls.push(command.reference);
      const session: TopUpSession = {
        ...command,
        id: `cs_${command.reference}`,
        url: URL,
        status: "open",
        paymentStatus: "unpaid",
        mode: "payment",
      };
      sessions.set(session.id, session);
      return session;
    },
    async read(id) {
      return sessions.get(id) ?? null;
    },
    async recover(command) {
      return sessions.get(`cs_${command.reference}`) ?? null;
    },
  };
  const topUps = createOrgTopUps({
    sql,
    clock,
    client: processor,
    consoleOrigin: "https://console.test",
    bounds: { minimumMinor: 50, maximumMinor: 5000 },
    pin: async () => ({
      customerId: "cus_api_extensions",
      accountId: "acct_api_extensions",
      financialRealm: "test-api-realm",
      livemode: false,
      pricingRevision: config.revision,
      purchaseCreditExpiry: config.purchaseCreditExpiry,
    }),
  });
  const base: CreateControlRoutesOptions = {
    publicOrigin: "https://api.test",
    accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger,
    billing,
    limitPolicy,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {
      async verify() {
        throw new Error("unqualified funding must not run");
      },
    },
    clock,
    hostedBilling: true,
    checkout: topUps,
  };
  const makeRoute = (overrides: Partial<CreateControlRoutesOptions> = {}) =>
    createControlRoutes({ ...base, ...overrides });
  const route = makeRoute();
  const request = async (
    method: string,
    path: string,
    token?: string,
    body?: unknown,
    handler = route,
  ) => {
    const url = new globalThis.URL(path, "https://api.test");
    const response = await handler(
      new Request(url, {
        method,
        headers: {
          ...(token ? { authorization: `Bearer ${tokens[token] ?? token}` } : {}),
          "content-type": "application/json",
        },
        ...(body === undefined
          ? {}
          : { body: typeof body === "string" ? body : JSON.stringify(body) }),
      }),
      url,
    );
    if (!response) throw new Error("declared billing route was not handled");
    return response;
  };
  const org = organization?.id ?? "org_uncreated";
  const wallet = `/v1/organizations/${org}/wallet`;
  return {
    sql,
    accounts,
    owner,
    org,
    wallet,
    keyIds,
    billing,
    remoteCalls,
    sessions,
    base,
    makeRoute,
    request,
    setTime(value: string) {
      time = value;
    },
  };
}

test("personal Organization HTTP retries and concurrency elect one local mapping without money", async () => {
  const f = await fixture(false);
  const responses = await Promise.all(
    Array.from({ length: 8 }, () => f.request("POST", "/v1/organizations/personal", "owner", {})),
  );
  expect(responses.filter((response) => response.status === 201)).toHaveLength(1);
  expect(responses.filter((response) => response.status === 200)).toHaveLength(7);
  const bodies = await Promise.all(responses.map((response) => response.json()));
  expect(new Set(bodies.map((body) => body.organization.id)).size).toBe(1);
  expect(bodies[0].organization.ownerPrincipalId).toBe(f.owner.principalId);
  expect(await f.sql.query("SELECT COUNT(*) AS count FROM ledger")).toEqual([{ count: 0 }]);
  expect(await f.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_customers")).toEqual([
    { count: 0 },
  ]);
});

test("personal Org authorizes before parsing and refuses body impersonation and generic adoption", async () => {
  const f = await fixture();
  expect((await f.request("POST", "/v1/organizations/personal", undefined, "{")).status).toBe(401);
  expect((await f.request("POST", "/v1/organizations/personal", "payer", "{")).status).toBe(401);
  expect(
    (
      await f.request("POST", "/v1/organizations/personal", "owner", {
        principalId: f.owner.principalId,
      })
    ).status,
  ).toBe(400);
  const unavailable = await f.request("POST", "/v1/organizations/personal", "owner", {});
  expect(unavailable.status).toBe(503);
  expect((await unavailable.json()).error.code).toBe("billing_unavailable");
  expect(await f.sql.query("SELECT COUNT(*) AS count FROM personal_organizations")).toEqual([
    { count: 0 },
  ]);
});

test("Hosted top-up requires payment authority and a bounded reference before dispatch", async () => {
  const f = await fixture();
  for (const token of [undefined, "reader", "walletWriter", "foreign"]) {
    expect((await f.request("POST", `${f.wallet}/checkout`, token, "{")).status).toBe(
      token === undefined ? 401 : 403,
    );
  }
  for (const body of [
    { amountMinor: 100 },
    { reference: "purchase", amountMinor: 49 },
    { reference: "bad/ref", amountMinor: 100 },
    { reference: "purchase", amountMinor: 100, returnUrl: "https://evil.test" },
  ]) {
    expect((await f.request("POST", `${f.wallet}/checkout`, "payer", body)).status).toBe(400);
  }
  expect(f.remoteCalls).toEqual([]);
});

test("Hosted top-up replays the actual durable core receipt and reads only within its Organization", async () => {
  const f = await fixture();
  const purchase = { reference: "purchase_one", amountMinor: 123 };
  for (let i = 0; i < 2; i++) {
    const response = await f.request("POST", `${f.wallet}/checkout`, "payer", purchase);
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ checkout: { url: URL } });
  }
  expect(f.remoteCalls).toEqual(["purchase_one"]);
  expect(
    (await f.request("POST", `${f.wallet}/checkout`, "payer", { ...purchase, amountMinor: 124 }))
      .status,
  ).toBe(409);
  const read = await f.request("GET", `${f.wallet}/checkout/purchase_one`, "reader");
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({
    reference: "purchase_one",
    state: "ready",
    checkout: { url: URL },
  });
  expect((await f.request("GET", `${f.wallet}/checkout/purchase_one`, "foreign")).status).toBe(403);
  expect((await f.request("GET", `${f.wallet}/checkout/purchase_one`, "payer")).status).toBe(403);
  expect((await f.request("GET", `${f.wallet}/checkout/unknown`, "reader")).status).toBe(404);
  expect(await f.sql.query("SELECT COUNT(*) AS count FROM ledger")).toEqual([{ count: 0 }]);
});

test("independent legacy top-up keeps its owner-only body and response while Hosted refuses fallback", async () => {
  const f = await fixture();
  const legacy = {
    bounds: { minimumMinor: 50, maximumMinor: 5000 },
    async begin() {
      return { url: URL };
    },
  };
  const standalone = { ...f.base, checkout: legacy };
  delete standalone.hostedBilling;
  const route = createControlRoutes(standalone);
  expect(
    (await f.request("POST", `${f.wallet}/checkout`, "payer", { amountMinor: 100 }, route)).status,
  ).toBe(401);
  const response = await f.request(
    "POST",
    `${f.wallet}/checkout`,
    "owner",
    { amountMinor: 100 },
    route,
  );
  expect(response.status).toBe(201);
  expect(await response.json()).toEqual({ checkout: { url: URL } });
  for (const amountMinor of [49, 5001])
    expect(
      (await f.request("POST", `${f.wallet}/checkout`, "owner", { amountMinor }, route)).status,
    ).toBe(400);
  expect(
    (
      await f.request(
        "POST",
        `${f.wallet}/checkout`,
        "owner",
        { reference: "new", amountMinor: 100 },
        route,
      )
    ).status,
  ).toBe(400);
  expect(
    (await f.request("GET", `${f.wallet}/checkout/unknown`, "reader", undefined, route)).status,
  ).toBe(404);
  expect(
    (
      await f.request(
        "POST",
        `${f.wallet}/checkout`,
        "payer",
        "{",
        f.makeRoute({ checkout: legacy }),
      )
    ).status,
  ).toBe(404);
  expect((await f.request("POST", `${f.wallet}/funding`, "owner", "{")).status).toBe(404);
});

test("canonical top-up HTTP replay keeps its original command after current bounds narrow", async () => {
  const f = await fixture();
  await f.sql.run("INSERT INTO stripe_mode_realm VALUES (1, 'test', ?)", [START]);
  await f.sql.run(
    "INSERT INTO stripe_billing_account_realms VALUES (1, 'acct_apiExtensions', 'test', 'api-extensions-test', ?)",
    [START],
  );
  const remoteRequests: Request[] = [];
  const customers = new Map<string, Record<string, unknown>>();
  const sessions = new Map<string, Record<string, unknown>>();
  const metadata = (form: URLSearchParams) =>
    Object.fromEntries(
      [...form.entries()]
        .filter(([name]) => name.startsWith("metadata["))
        .map(([name, value]) => [name.slice("metadata[".length, -1), value]),
    );
  const nativeFetch = async (request: Request) => {
    remoteRequests.push(request);
    const url = new globalThis.URL(request.url);
    if (request.method === "GET" && url.pathname === "/v1/account")
      return Response.json({ id: "acct_apiExtensions", object: "account" });
    if (request.method === "GET" && url.pathname === "/v1/prices/price_apiExtensions")
      return Response.json({
        id: "price_apiExtensions",
        object: "price",
        livemode: false,
        active: true,
        currency: "usd",
        unit_amount: 1000,
        type: "recurring",
        billing_scheme: "per_unit",
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      });
    if (request.method === "POST" && url.pathname === "/v1/customers") {
      const form = new URLSearchParams(await request.clone().text());
      const customer = {
        id: "cus_apiExtensionsReplay",
        object: "customer",
        livemode: false,
        metadata: metadata(form),
      };
      customers.set(customer.id, customer);
      return Response.json(customer);
    }
    if (request.method === "GET" && url.pathname === "/v1/customers/cus_apiExtensionsReplay")
      return Response.json(customers.get("cus_apiExtensionsReplay"));
    if (request.method === "POST" && url.pathname === "/v1/checkout/sessions") {
      const form = new URLSearchParams(await request.clone().text());
      const session = {
        id: "cs_apiExtensionsReplay",
        object: "checkout.session",
        livemode: false,
        mode: form.get("mode"),
        customer: form.get("customer"),
        amount_total: Number(form.get("line_items[0][price_data][unit_amount]")),
        currency: "usd",
        metadata: metadata(form),
        status: "open",
        payment_status: "unpaid",
        payment_intent: null,
        url: URL,
      };
      sessions.set(session.id, session);
      return Response.json(session);
    }
    if (request.method === "GET" && url.pathname === "/v1/checkout/sessions/cs_apiExtensionsReplay")
      return Response.json(sessions.get("cs_apiExtensionsReplay"));
    throw new Error(`unexpected native request: ${request.method} ${url.pathname}`);
  };
  const client = createStripeBillingClient({
    secretKey: "sk_test_api_extensions_fixture",
    mode: "test",
    fetch: nativeFetch,
  });
  const assemble = async (
    minimumMinor: number,
    maximumMinor: number,
    revision: string = BILLING_CONFIG.revision,
  ) => {
    const pricing = compilePricingAuthoring({
      authoringVersion: 1,
      billingConfig:
        revision === BILLING_CONFIG.revision
          ? BILLING_CONFIG
          : {
              ...BILLING_CONFIG,
              revision,
              effectiveAt: START,
              history: [BILLING_CONFIG],
            },
      checkout: { minimumMinor, maximumMinor },
      planIds: { free: "free", subscription: "configured", usage: "usage" },
      stripeMonthlyReview: {
        configured: { expectedAmountMinor: 1000, currency: "USD", interval: "month" },
      },
    });
    const billingConfig = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
    if (!billingConfig) throw new Error("fixture billing config unavailable");
    const realm = await verifyHostedBillingFinancialRealm({
      sql: f.sql,
      reader: { client },
      expected: {
        accountId: "acct_apiExtensions",
        mode: "test",
        billingAuthority: "api-extensions-test",
      },
      prices: [{ priceId: "price_apiExtensions", monthlyAmountMinor: 1000 }],
    });
    const hostedBilling = await createCanonicalHostedBillingComposition({
      sql: f.sql,
      clock: f.base.clock,
      billingConfig,
      pricing,
      client,
      realm,
      consoleOrigin: "https://console.test",
      warnings: { state: "unavailable", reason: "transport-not-composed" },
      webhookSecret: "whsec_api_extensions_fixture",
    });
    return buildApp({
      sql: f.sql,
      clock: f.base.clock,
      billingConfig,
      hostedBilling,
      publicOrigin: "https://api.test",
      consoleOrigin: "https://console.test",
      objects: createMemoryObjectStore(),
      identity: {
        async verify() {
          throw new Error("existing local session only");
        },
      },
      settlement: f.base.settlement,
      v2: TEST_TAKOFORM_V2_CONFIG,
      forms: [],
      hostForms: [],
      offerings: [],
      driver: new InMemoryTakoformResourceDriver(),
    });
  };
  const original = await assemble(50, 5000);
  const subscriptionPath = `/v1/organizations/${f.org}/payments/subscription`;
  const originalPlan = await f.request("GET", subscriptionPath, "reader", undefined, (request) =>
    original.fetch(request),
  );
  expect(originalPlan.status).toBe(200);
  expect(
    (await originalPlan.json()).planTable.plans.find(
      (plan: { tier: string }) => plan.tier === "usage",
    ),
  ).toMatchObject({
    checkoutMinimumMinor: 50,
    checkoutMaximumMinor: 5000,
  });
  const originalCatalog = await f.sql.query(
    "SELECT revision, config_json FROM stripe_billing_pricing WHERE revision = ?",
    [BILLING_CONFIG.revision],
  );
  expect(originalCatalog).toHaveLength(1);
  const path = `${f.wallet}/checkout`;
  const purchase = { reference: "original-purchase", amountMinor: 500 };
  const first = await f.request("POST", path, "payer", purchase, (request) =>
    original.fetch(request),
  );
  expect(first.status).toBe(201);
  expect(await first.json()).toEqual({ checkout: { url: URL } });
  const storedBefore = await f.sql.query(
    "SELECT reference, command_json, fingerprint, stripe_key, session_id FROM stripe_top_up_commands WHERE org_id = ?",
    [f.org],
  );
  expect(storedBefore).toHaveLength(1);
  const effectsBefore = remoteRequests.filter((request) => request.method === "POST");
  expect(effectsBefore.map((request) => new globalThis.URL(request.url).pathname)).toEqual([
    "/v1/customers",
    "/v1/checkout/sessions",
  ]);
  expect(effectsBefore.every((request) => request.headers.has("idempotency-key"))).toBe(true);

  const restarted = await assemble(50, 100, "api-extension-r2");
  const currentPlan = await f.request("GET", subscriptionPath, "reader", undefined, (request) =>
    restarted.fetch(request),
  );
  expect(currentPlan.status).toBe(200);
  expect(
    (await currentPlan.json()).planTable.plans.find(
      (plan: { tier: string }) => plan.tier === "usage",
    ),
  ).toMatchObject({
    checkoutMinimumMinor: 50,
    checkoutMaximumMinor: 100,
  });
  expect(
    await f.sql.query(
      "SELECT revision, config_json FROM stripe_billing_pricing WHERE revision = ?",
      [BILLING_CONFIG.revision],
    ),
  ).toEqual(originalCatalog);
  expect(
    await f.sql.query("SELECT revision FROM stripe_billing_pricing ORDER BY revision"),
  ).toEqual([{ revision: BILLING_CONFIG.revision }, { revision: "api-extension-r2" }]);
  const replay = await f.request("POST", path, "payer", purchase, (request) =>
    restarted.fetch(request),
  );
  expect(replay.status).toBe(201);
  expect(await replay.json()).toEqual({ checkout: { url: URL } });
  expect(
    await f.sql.query(
      "SELECT reference, command_json, fingerprint, stripe_key, session_id FROM stripe_top_up_commands WHERE org_id = ?",
      [f.org],
    ),
  ).toEqual(storedBefore);
  expect(remoteRequests.filter((request) => request.method === "POST")).toEqual(effectsBefore);

  const beforeRefusals = remoteRequests.length;
  const changed = await f.request(
    "POST",
    path,
    "payer",
    { ...purchase, amountMinor: 600 },
    (request) => restarted.fetch(request),
  );
  expect(changed.status).toBe(409);
  expect((await changed.json()).error.code).toBe("conflict");
  const fresh = await f.accounts.createOrganization({
    actor: f.owner,
    name: "Fresh customer boundary",
  });
  const freshPath = `/v1/organizations/${fresh.id}/wallet/checkout`;
  for (const amountMinor of [500, 0, -1, 1.5, "500", Number.MAX_SAFE_INTEGER + 1]) {
    const refused = await f.request(
      "POST",
      freshPath,
      "owner",
      { reference: "new-purchase", amountMinor },
      (request) => restarted.fetch(request),
    );
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.code).toBe("invalid_argument");
  }
  expect(remoteRequests).toHaveLength(beforeRefusals);
  for (const table of [
    "stripe_top_up_commands",
    "stripe_billing_customer_commands",
    "stripe_billing_customers",
  ])
    expect(await f.sql.query(`SELECT * FROM ${table} WHERE org_id = ?`, [fresh.id])).toEqual([]);
  expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
});

test("limit policy HTTP commands audit the exact API key and preserve the original replay", async () => {
  const f = await fixture();
  const initial = await f.request("GET", `${f.wallet}/limit-policy`, "reader");
  expect(initial.status).toBe(200);
  expect(await initial.json()).toMatchObject({
    onLimit: "stop",
    capabilities: { stop: true, prepaid: true, "on-demand": false, postpaid: false },
    cashCapMinor: null,
    consentRevision: null,
  });
  const prepaid = { reference: "consent", onLimit: "prepaid" };
  const first = await f.request("PATCH", `${f.wallet}/limit-policy`, "payer", prepaid);
  expect(first.status).toBe(200);
  const original = await first.json();
  expect(original.onLimit).toBe("prepaid");
  const audit = (
    await f.sql.query(
      "SELECT authorized_principal FROM org_wallet_limit_policy_commands WHERE org_id = ? AND ref = 'consent'",
      [f.org],
    )
  )[0];
  expect(audit?.authorized_principal).toBe(`api_key:api-key:${f.keyIds.payer}`);
  expect(
    (
      await f.request("PATCH", `${f.wallet}/limit-policy`, "owner", {
        reference: "stop",
        onLimit: "stop",
      })
    ).status,
  ).toBe(200);
  const replay = await f.request("PATCH", `${f.wallet}/limit-policy`, "payer", prepaid);
  expect(await replay.json()).toEqual(original);
  expect((await f.request("PATCH", `${f.wallet}/limit-policy`, "owner", prepaid)).status).toBe(409);
});

test("limit policy denies scopes before JSON and rejects unavailable modes without writes", async () => {
  const f = await fixture();
  for (const token of ["walletWriter", "reader", "foreign"])
    expect((await f.request("PATCH", `${f.wallet}/limit-policy`, token, "{")).status).toBe(403);
  for (const body of [
    { reference: "one", onLimit: "other" },
    { reference: "one", onLimit: "prepaid", consentRevision: "caller" },
    { reference: "one", onLimit: "on-demand" },
    { reference: "one", onLimit: "postpaid", cashCapMinor: -1, consentRevision: "v1" },
  ]) {
    expect((await f.request("PATCH", `${f.wallet}/limit-policy`, "payer", body)).status).toBe(400);
  }
  for (const onLimit of ["on-demand", "postpaid"])
    expect(
      (
        await f.request("PATCH", `${f.wallet}/limit-policy`, "payer", {
          reference: onLimit,
          onLimit,
          cashCapMinor: 1000,
          consentRevision: "reviewed-v1",
          ...(onLimit === "on-demand"
            ? { termsRevision: "reviewed-terms-v1", paymentMethodId: "pm_existing_card" }
            : {}),
        })
      ).status,
    ).toBe(409);
  expect(await f.sql.query("SELECT COUNT(*) AS count FROM org_wallet_limit_policies")).toEqual([
    { count: 0 },
  ]);
  expect(
    await f.sql.query("SELECT COUNT(*) AS count FROM org_wallet_limit_policy_commands"),
  ).toEqual([{ count: 0 }]);
});

test("on-demand HTTP routes authenticate before capability lookup or body parsing", async () => {
  const f = await fixture();
  for (const [method, suffix, denied] of [
    ["GET", "terms", "payer"],
    ["GET", "card-setup/original", "payer"],
    ["POST", "card-setup", "reader"],
  ] as const) {
    const path = `${f.wallet}/on-demand/${suffix}`;
    for (const token of [undefined, "foreign", denied]) {
      const response = await f.request(method, path, token, method === "POST" ? "{" : undefined);
      expect(response.status).toBe(token === undefined ? 401 : 403);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    }
    const response = await f.request(method, path, method === "POST" ? "payer" : "reader");
    expect(response.status).toBe(404);
  }
  expect(f.remoteCalls).toEqual([]);
});

test("on-demand terms disclose the explicit rule without granting consent", async () => {
  const f = await fixture();
  const terms = parseOrgOnDemandTerms({
    termsRevision: "terms-api:v1",
    consentRevision: "consent-api:v1",
    currency: "USD",
    validity: { validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2026-12-01T00:00:00.000Z" },
    replenishment: {
      trigger: "eligible-credit-deficit",
      rule: "ceil-deficit-to-quantum-with-minimum",
      fundingQuantumMinor: 50,
      minimumChargeMinor: 50,
      maximumChargeMinor: 500,
    },
    cashCapBounds: { minimumMinor: 50, maximumMinor: 5000 },
    purchaseCreditExpiry: { kind: "none" },
  });
  let reads = 0;
  const route = f.makeRoute({
    setupDisclosureRevision: "setup-api:v1",
    onDemand: {
      readTerms() {
        reads++;
        return terms;
      },
    },
  });
  expect(
    (await f.request("GET", `${f.wallet}/on-demand/terms`, "foreign", undefined, route)).status,
  ).toBe(403);
  expect(reads).toBe(0);
  const response = await f.request(
    "GET",
    `${f.wallet}/on-demand/terms`,
    "reader",
    undefined,
    route,
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({ terms, setupDisclosureRevision: "setup-api:v1" });
  expect(reads).toBe(1);
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(await f.sql.query("SELECT COUNT(*) AS n FROM org_wallet_limit_policy_commands")).toEqual([
    { n: 0 },
  ]);
});

test("on-demand HTTP accepts published colon revisions and binds the payment principal", async () => {
  const f = await fixture();
  const policy = f.base.limitPolicy;
  if (!policy) throw new Error("fixture policy missing");
  const changes: unknown[] = [];
  const route = f.makeRoute({
    limitPolicy: {
      ...policy,
      async change(input) {
        changes.push(input);
        return await policy.read(input.organizationId);
      },
    },
  });
  const body = {
    reference: "consent:original",
    onLimit: "on-demand",
    cashCapMinor: 500,
    consentRevision: "consent-api:v1",
    termsRevision: "terms-api:v1",
    paymentMethodId: "pm_registered",
    setupIntentId: "seti_registered",
  };
  expect((await f.request("PATCH", `${f.wallet}/limit-policy`, "reader", body, route)).status).toBe(
    403,
  );
  expect(changes).toEqual([]);
  expect((await f.request("PATCH", `${f.wallet}/limit-policy`, "payer", body, route)).status).toBe(
    200,
  );
  expect(changes).toEqual([
    { ...body, organizationId: f.org, authorizedPrincipal: expect.stringMatching(/^[^:]+:.+$/u) },
  ]);
  expect(await f.sql.query("SELECT COUNT(*) AS n FROM org_wallet_limit_policy_commands")).toEqual([
    { n: 0 },
  ]);
});

test("only card setup begin exposes transient actions and the completed card selector", async () => {
  const f = await fixture();
  const originals = new Set<string>();
  const calls: { operation: string; input?: unknown }[] = [];
  let verified = false;
  const receipt = (reference: string): StripeCardSetupReceipt => ({
    reference,
    state: verified ? "succeeded" : "original-known",
    setupDisclosureRevision: "setup-api:v1",
    sessionExpired: false,
    observedAt: START,
  });
  const cardSetup: NonNullable<CreateControlRoutesOptions["cardSetup"]> = {
    async begin(input) {
      calls.push({ operation: "begin", input });
      originals.add(input.reference);
      return {
        receipt: { ...receipt(input.reference), client_secret: "test_only_private" },
        checkout: verified ? null : { url: URL, internal: "not_public" },
      };
    },
    async read(organizationId, reference) {
      expect(organizationId).toBe(f.org);
      calls.push({ operation: "read" });
      return originals.has(reference)
        ? { ...receipt(reference), url: URL, client_secret: "test_only_private" }
        : null;
    },
    async recoverOriginal() {
      throw new Error("GET route must not invoke recovery");
    },
    async readSelection(organizationId) {
      return verified
        ? {
            organizationId,
            customerId: "cus_private",
            paymentMethodId: "pm_registered",
            setupIntentId: "seti_registered",
          }
        : null;
    },
  };
  const route = f.makeRoute({ cardSetup, setupDisclosureRevision: "setup-api:v1" });
  const path = `${f.wallet}/on-demand/card-setup`;
  expect((await f.request("POST", path, "foreign", "{", route)).status).toBe(403);
  expect((await f.request("POST", path, "reader", "{", route)).status).toBe(403);
  expect(calls).toEqual([]);
  expect(
    (
      await f.request(
        "POST",
        path,
        "payer",
        { reference: "card", setupDisclosureRevision: "stale" },
        route,
      )
    ).status,
  ).toBe(409);
  expect(calls.filter((call) => call.operation === "begin")).toHaveLength(0);
  calls.length = 0;
  const body = { reference: "card", setupDisclosureRevision: "setup-api:v1" };
  const begin = await f.request("POST", path, "payer", body, route);
  expect(begin.status).toBe(200);
  expect(await begin.json()).toEqual({
    receipt: receipt("card"),
    checkout: { url: URL },
    selection: null,
  });
  expect(calls.find((call) => call.operation === "begin")?.input).toMatchObject({
    organizationId: f.org,
    reference: "card",
    setupDisclosureRevision: "setup-api:v1",
    authorizedPrincipal: expect.stringMatching(/^[^:]+:.+$/u),
  });
  verified = true;
  calls.length = 0;
  const read = await f.request("GET", `${path}/card`, "reader", undefined, route);
  expect(await read.json()).toEqual({ cardSetup: receipt("card") });
  expect(calls).toEqual([{ operation: "read" }]);
  const replay = await f.request("POST", path, "payer", body, route);
  expect(await replay.json()).toEqual({
    receipt: receipt("card"),
    checkout: null,
    selection: { paymentMethodId: "pm_registered", setupIntentId: "seti_registered" },
  });
  expect(replay.headers.get("cache-control")).toBe("private, no-store");
  const changed = await f.request(
    "POST",
    path,
    "payer",
    { ...body, authorizedPrincipal: "caller" },
    route,
  );
  expect(changed.status).toBe(400);
});

test("original card setup disclosure survives publication of a new revision", async () => {
  const f = await fixture();
  const receipt: StripeCardSetupReceipt = {
    reference: "old",
    state: "pending",
    setupDisclosureRevision: "old-disclosure",
    sessionExpired: false,
    observedAt: null,
  };
  const cardSetup: NonNullable<CreateControlRoutesOptions["cardSetup"]> = {
    async read() {
      return receipt;
    },
    async begin(input) {
      expect(input.setupDisclosureRevision).toBe("old-disclosure");
      return { receipt, checkout: null };
    },
    async readSelection() {
      return null;
    },
    async recoverOriginal() {
      throw new Error("unexpected recovery");
    },
  };
  const route = f.makeRoute({ cardSetup, setupDisclosureRevision: "new-disclosure" });
  const response = await f.request(
    "POST",
    `${f.wallet}/on-demand/card-setup`,
    "payer",
    { reference: "old", setupDisclosureRevision: "old-disclosure" },
    route,
  );
  expect(response.status).toBe(200);
  const failure = controlErrorResponse(new StripeCardSetupError("reconciliation_required"));
  expect(failure.status).toBe(503);
  expect(await failure.json()).toMatchObject({
    error: { code: "billing_unavailable", retryable: false },
  });
});

function hold(reference: string, workspaceRef: string, amountMicros = "100") {
  return {
    reference,
    workspaceRef,
    amountMicros,
    pricingRevision: BILLING_CONFIG.revision,
    measurementFingerprint: "estimate",
  };
}

test("Workspace hold and closed usage preserve explicit attribution and serialize micros as strings", async () => {
  const f = await fixture();
  const held = await f.request(
    "POST",
    `${f.wallet}/holds`,
    "walletWriter",
    hold("operation", "workspace_one"),
  );
  expect(held.status).toBe(201);
  expect((await held.json()).hold).toMatchObject({
    workspaceRef: "workspace_one",
    amountMicros: "100",
    capturedMicros: "0",
    attributionPeriodStart: "2026-10-01T00:00:00.000Z",
  });
  const captureBody = { amountMicros: "60", actualMicros: "60", measurementFingerprint: "actual" };
  expect(
    (
      await f.request("POST", `${f.wallet}/holds/operation/capture`, "walletWriter", {
        ...captureBody,
        workspaceRef: "other_workspace",
      })
    ).status,
  ).toBe(400);
  const capture = await f.request(
    "POST",
    `${f.wallet}/holds/operation/capture`,
    "walletWriter",
    captureBody,
  );
  expect((await capture.json()).hold).toMatchObject({
    workspaceRef: "workspace_one",
    capturedMicros: "60",
    releasedMicros: "40",
  });
  const usage = await f.request("POST", `${f.wallet}/usage-records`, "usageWriter", {
    reference: "closed",
    workspaceRef: "workspace_one",
    meter: "requests",
    quantity: "7",
    quantityUnit: "request",
    periodStart: "2026-10-14T00:00:00.000Z",
    periodEnd: "2026-10-14T01:00:00.000Z",
    pricingRevision: BILLING_CONFIG.revision,
    expectedMicros: "7",
    measurementFingerprint: "closed",
  });
  expect(usage.status).toBe(201);
  expect((await usage.json()).usageRecord).toMatchObject({
    workspaceRef: "workspace_one",
    amountMicros: "7",
    status: "paid",
  });
  const page = await f.request("GET", `${f.wallet}/usage-summary/workspaces`, "reader");
  expect(page.status).toBe(200);
  expect(await page.json()).toMatchObject({
    totalsScope: "organization",
    totals: { usedMicros: "67", heldMicros: "0", pendingMicros: "0" },
    workspaces: [
      { workspaceRef: "workspace_one", usedMicros: "67", heldMicros: "0", pendingMicros: "0" },
    ],
    usageSummary: { usedMicros: "67", originalIncludedMicros: "1500000" },
  });
});

test("Workspace HTTP pagination freezes totals and rejects expired continuation after cleanup", async () => {
  const f = await fixture();
  for (const [reference, workspaceRef] of [
    ["one", "workspace_a"],
    ["two", "workspace_b"],
  ] as const)
    expect(
      (await f.request("POST", `${f.wallet}/holds`, "walletWriter", hold(reference, workspaceRef)))
        .status,
    ).toBe(201);
  const first = await f.request("GET", `${f.wallet}/usage-summary/workspaces?limit=1`, "reader");
  const snapshot = await first.json();
  expect(snapshot.cursor).toBeString();
  expect(snapshot.totals.heldMicros).toBe("200");
  expect((await f.request("POST", `${f.wallet}/holds/two/release`, "walletWriter")).status).toBe(
    200,
  );
  const second = await f.request(
    "GET",
    `${f.wallet}/usage-summary/workspaces?cursor=${encodeURIComponent(snapshot.cursor)}`,
    "reader",
  );
  expect(second.status).toBe(200);
  expect((await second.json()).totals).toEqual(snapshot.totals);
  f.setTime("2026-10-15T12:11:00.000Z");
  // Authenticate the owner session because short-lived API keys may expire independently.
  expect((await f.request("GET", `${f.wallet}/usage-summary/workspaces`, "owner")).status).toBe(
    200,
  );
  const expired = await f.request(
    "GET",
    `${f.wallet}/usage-summary/workspaces?cursor=${encodeURIComponent(snapshot.cursor)}`,
    "owner",
  );
  expect(expired.status).toBe(409);
  expect((await expired.json()).error).toMatchObject({ code: "expired", retryable: false });
});

test("Workspace query validation and exact Organization auth precede snapshot access", async () => {
  const f = await fixture();
  expect(
    (await f.request("GET", `${f.wallet}/usage-summary/workspaces?limit=bad`, "foreign")).status,
  ).toBe(403);
  expect((await f.request("GET", `${f.wallet}/usage-summary/workspaces`, "payer")).status).toBe(
    403,
  );
  for (const query of [
    "limit=0",
    "limit=101",
    "limit=01",
    "limit=1&limit=2",
    "cursor=",
    "cursor=a&cursor=b",
    "workspaceRef=a&workspaceRef=b",
    "workspaceRef=bad%2Fref",
    "cursor=a&workspaceRef=a",
    "unexpected=a",
  ]) {
    expect(
      (await f.request("GET", `${f.wallet}/usage-summary/workspaces?${query}`, "reader")).status,
    ).toBe(400);
  }
  expect(await f.sql.query("SELECT COUNT(*) AS count FROM org_wallet_workspace_snapshots")).toEqual(
    [{ count: 0 }],
  );
});

test("absent extension capabilities authenticate before parsing or exposing their absence", async () => {
  const f = await fixture();
  const options = { ...f.base };
  delete options.billing;
  delete options.limitPolicy;
  delete options.checkout;
  const route = createControlRoutes(options);
  for (const path of [
    `${f.wallet}/usage-summary/workspaces?limit=bad`,
    `${f.wallet}/limit-policy`,
    `${f.wallet}/checkout/unknown`,
  ]) {
    expect((await f.request("GET", path, undefined, undefined, route)).status).toBe(401);
    expect((await f.request("GET", path, "foreign", undefined, route)).status).toBe(403);
    expect((await f.request("GET", path, "reader", undefined, route)).status).toBe(404);
  }
  expect(
    (await f.request("PATCH", `${f.wallet}/limit-policy`, "walletWriter", "{", route)).status,
  ).toBe(403);
  expect((await f.request("PATCH", `${f.wallet}/limit-policy`, "payer", "{", route)).status).toBe(
    404,
  );
  expect((await f.request("POST", `${f.wallet}/checkout`, "payer", "{", route)).status).toBe(404);
});

test("only the qualified app publishes Hosted billing capabilities and reuses its plan bounds", async () => {
  const f = await fixture();
  const billingConfig = parseBillingConfig(PRICING.environment.TAKOSERVER_BILLING_CONFIG);
  if (!billingConfig) throw new Error("missing fixture billing config");
  const ports: AppPorts = {
    sql: f.sql,
    clock: f.base.clock,
    billingConfig,
    objects: createMemoryObjectStore(),
    identity: {
      async verify() {
        throw new Error("identity not used by this existing-session read");
      },
    },
    settlement: f.base.settlement,
    publicOrigin: "https://api.test",
    consoleOrigin: "https://console.test",
    v2: TEST_TAKOFORM_V2_CONFIG,
    forms: [],
    hostForms: [],
    offerings: [],
    driver: new InMemoryTakoformResourceDriver(),
  };
  const warnings = { state: "unavailable", reason: "transport-not-composed" } as const;
  const walletOnly = await createHostedBillingComposition({
    sql: f.sql,
    clock: f.base.clock,
    billingConfig,
    paymentActivation: false,
    warnings,
  });
  const path = `/v1/organizations/${f.org}/payments/subscription`;
  const walletApp = buildApp({ ...ports, hostedBilling: walletOnly });
  const walletResponse = await f.request("GET", path, "reader", undefined, (request) =>
    walletApp.fetch(request),
  );
  expect(walletResponse.status).toBe(404);
  expect(await walletResponse.json()).not.toHaveProperty("billingCapabilities");
  expect(
    (
      await f.request("GET", `${path}/commands/start/original`, "reader", undefined, (request) =>
        walletApp.fetch(request),
      )
    ).status,
  ).toBe(404);

  const legacyPayments: CustodiedSubscriptionPayments = {
    planTable: PRICING.hostedPlanTable,
    async read() {
      return null;
    },
    async begin() {
      return { state: "pending", id: "sci_legacy" };
    },
    async change() {
      return { state: "pending", subscriptionRef: TARGET };
    },
  };
  const legacyApp = buildApp({
    ...ports,
    paymentEvents: () => ({
      subscriptions: legacyPayments,
      async reconcile() {
        throw new Error("read must not reconcile payments");
      },
    }),
  });
  const legacyResponse = await f.request("GET", path, "reader", undefined, (request) =>
    legacyApp.fetch(request),
  );
  expect(legacyResponse.status).toBe(200);
  expect(await legacyResponse.json()).toEqual({
    subscription: null,
    planTable: PRICING.hostedPlanTable,
  });
  expect(
    (
      await f.request("GET", `${path}/commands/start/original`, "reader", undefined, (request) =>
        legacyApp.fetch(request),
      )
    ).status,
  ).toBe(404);

  await f.sql.run("INSERT INTO stripe_mode_realm VALUES (1, 'test', ?)", [START]);
  await f.sql.run(
    "INSERT INTO stripe_billing_account_realms VALUES (1, 'acct_apiExtensions', 'test', 'api-extensions-test', ?)",
    [START],
  );
  const remoteRequests: Request[] = [];
  const client = createStripeBillingClient({
    secretKey: "sk_test_api_extensions_fixture",
    mode: "test",
    async fetch(request) {
      remoteRequests.push(request);
      const url = new globalThis.URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/account")
        return Response.json({ id: "acct_apiExtensions", object: "account" });
      if (request.method === "GET" && url.pathname === "/v1/prices/price_apiExtensions")
        return Response.json({
          id: "price_apiExtensions",
          object: "price",
          livemode: false,
          active: true,
          currency: "usd",
          unit_amount: 1000,
          type: "recurring",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      throw new Error(`unexpected processor request: ${request.method} ${url.pathname}`);
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql: f.sql,
    reader: { client },
    expected: {
      accountId: "acct_apiExtensions",
      billingAuthority: "api-extensions-test",
      mode: "test",
    },
    prices: [{ priceId: "price_apiExtensions", monthlyAmountMinor: 1000 }],
  });
  const hostedBilling = await createCanonicalHostedBillingComposition({
    sql: f.sql,
    clock: f.base.clock,
    billingConfig,
    pricing: PRICING,
    client,
    realm,
    consoleOrigin: "https://console.test",
    warnings,
    webhookSecret: "whsec_api_extensions_fixture",
  });
  const qualifiedApp = buildApp({ ...ports, hostedBilling });
  const response = await f.request("GET", path, "reader", undefined, (request) =>
    qualifiedApp.fetch(request),
  );
  expect(response.status).toBe(200);
  const body = await response.json();
  expect(body.billingCapabilities).toEqual({
    contractVersion: "hosted-billing-v1",
    topUps: true,
    subscriptionStart: true,
    subscriptionCancellation: true,
    subscriptionPlanChange: true,
  });
  expect(Object.keys(body).sort()).toEqual([
    "billingCapabilities",
    "pendingChange",
    "planTable",
    "subscription",
  ]);
  expect(body.planTable).toEqual(PRICING.hostedPlanTable);
  expect(
    body.planTable.plans.find((plan: { tier: string }) => plan.tier === "usage"),
  ).toMatchObject({
    checkoutMinimumMinor: 50,
    checkoutMaximumMinor: 5000,
  });
  expect(JSON.stringify(body)).not.toContain("launchReady");
  expect(JSON.stringify(body)).not.toContain("paymentPrerequisites");
  expect(remoteRequests.map((request) => request.method)).toEqual(["GET", "GET"]);
});

test("subscription command receipt reads authorize before lookup and reject malformed path fields", async () => {
  const f = await fixture();
  const calls: unknown[] = [];
  const receiptPort = {
    async read(input: {
      organizationId: string;
      kind: "start" | "cancel" | "plan-change";
      reference: string;
    }) {
      calls.push(input);
      return null;
    },
  };
  const route = f.makeRoute({ subscriptionCommandReceipts: receiptPort });
  const prefix = `/v1/organizations/${f.org}/payments/subscription/commands`;
  for (const [token, status] of [
    [undefined, 401],
    ["payer", 403],
    ["foreign", 403],
  ] as const) {
    const response = await f.request("GET", `${prefix}/invalid/%`, token, undefined, route);
    expect(response.status).toBe(status);
  }
  expect(calls).toEqual([]);
  for (const suffix of [
    "invalid/original",
    "START/original",
    "%73tart/original",
    "start/%",
    "start/%2Foriginal",
    "start/%252F",
    "start/%00",
    `start/${"a".repeat(129)}`,
    "start/original?resume=true",
  ])
    expect((await f.request("GET", `${prefix}/${suffix}`, "reader", undefined, route)).status).toBe(
      400,
    );
  expect(calls).toEqual([]);
  for (const kind of ["start", "cancel", "plan-change"] as const) {
    const missing = await f.request(
      "GET",
      `${prefix}/${kind}/original%3Acommand`,
      "reader",
      undefined,
      route,
    );
    expect(missing.status).toBe(404);
    expect((await missing.json()).error.code).toBe("not_found");
    expect(calls.at(-1)).toEqual({ organizationId: f.org, kind, reference: "original:command" });
  }
  const before = calls.length;
  const standalone = { ...f.base, subscriptionCommandReceipts: receiptPort };
  delete standalone.hostedBilling;
  for (const handler of [f.makeRoute(), createControlRoutes(standalone)])
    expect(
      (await f.request("GET", `${prefix}/start/original`, "reader", undefined, handler)).status,
    ).toBe(404);
  expect(calls).toHaveLength(before);
  const owner = await f.request("GET", `${prefix}/start/original`, "owner", undefined, route);
  expect(owner.status).toBe(404);
  expect(calls).toHaveLength(before + 1);
});

test("saved command receipt HTTP preserves closed nullable fields and original lifecycle facts", async () => {
  const f = await fixture();
  const effectiveAt = "2026-11-01T00:00:00.000Z";
  const pendingChange = {
    planKey: "configured",
    pricingRevision: BILLING_CONFIG.revision,
    effectiveAt,
  };
  const base: SubscriptionCommandReceipt = {
    contractVersion: SUBSCRIPTION_COMMAND_RECEIPT_VERSION,
    organizationId: f.org,
    reference: "original",
    kind: "start",
    state: "pending",
    subscriptionRef: null,
    planKey: "configured",
    pricingRevision: BILLING_CONFIG.revision,
    checkout: null,
    effectiveAt: null,
    pendingChange: null,
    lifecycle: "pending",
  };
  const receipts: SubscriptionCommandReceipt[] = [
    ...(["pending", "open", "associated", "expired", "invalidated"] as const).map((state) => ({
      ...base,
      reference: `start-${state}`,
      state,
      lifecycle: state,
      subscriptionRef: state === "associated" ? TARGET : null,
      checkout: state === "open" || state === "associated" ? { url: URL } : null,
    })),
    ...(["pending", "verified"] as const).map((state) => ({
      ...base,
      reference: `cancel-${state}`,
      kind: "cancel" as const,
      state,
      subscriptionRef: TARGET,
      planKey: null,
      pricingRevision: null,
      effectiveAt: state === "pending" ? null : effectiveAt,
      lifecycle: state === "pending" ? ("pending" as const) : ("scheduled" as const),
    })),
    ...(["pending", "scheduled", "activated", "revoked"] as const).map((lifecycle) => ({
      ...base,
      reference: `plan-${lifecycle}`,
      kind: "plan-change" as const,
      state: lifecycle === "pending" ? ("pending" as const) : ("verified" as const),
      subscriptionRef: TARGET,
      effectiveAt,
      lifecycle,
      pendingChange: lifecycle === "pending" ? null : pendingChange,
    })),
  ];
  let lookups = 0;
  const route = f.makeRoute({
    subscriptionCommandReceipts: {
      async read(input) {
        lookups++;
        return (
          receipts.find(
            (receipt) =>
              receipt.organizationId === input.organizationId &&
              receipt.kind === input.kind &&
              receipt.reference === input.reference,
          ) ?? null
        );
      },
    },
    subscriptionCustody: {
      planTable: PRICING.hostedPlanTable,
      async read() {
        throw new Error("saved receipt GET attempted current subscription read/registration");
      },
      async begin() {
        throw new Error("saved receipt GET attempted start resume");
      },
      async change() {
        throw new Error("saved receipt GET attempted cancellation");
      },
    },
    subscriptionPlans: {
      async pending() {
        throw new Error("saved receipt GET attempted plan reconciliation");
      },
      async change() {
        throw new Error("saved receipt GET attempted plan mutation");
      },
    },
  });
  for (const receipt of receipts) {
    const response = await f.request(
      "GET",
      `/v1/organizations/${f.org}/payments/subscription/commands/${receipt.kind}/${receipt.reference}`,
      "reader",
      undefined,
      route,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ receipt });
    expect(Object.keys(receipt).sort()).toEqual([
      "checkout",
      "contractVersion",
      "effectiveAt",
      "kind",
      "lifecycle",
      "organizationId",
      "pendingChange",
      "planKey",
      "pricingRevision",
      "reference",
      "state",
      "subscriptionRef",
    ]);
  }
  expect(lookups).toBe(receipts.length);
  expect(f.remoteCalls).toEqual([]);
  expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
  const unavailable = f.makeRoute({
    subscriptionCommandReceipts: {
      async read() {
        throw new SubscriptionCommandReceiptError("unavailable");
      },
    },
  });
  const refused = await f.request(
    "GET",
    `/v1/organizations/${f.org}/payments/subscription/commands/start/original`,
    "reader",
    undefined,
    unavailable,
  );
  expect(refused.status).toBe(503);
  expect((await refused.json()).error.code).toBe("billing_unavailable");
});

test("actual composed saved start receipt survives lost acknowledgement without native or SQL writes", async () => {
  const f = await fixture();
  await f.sql.run("INSERT INTO stripe_mode_realm VALUES (1, 'test', ?)", [START]);
  await f.sql.run(
    "INSERT INTO stripe_billing_account_realms VALUES (1, 'acct_apiExtensions', 'test', 'api-extensions-test', ?)",
    [START],
  );
  let readOnly = false;
  let attemptedWrites = 0;
  const sql: Sql = {
    async query(statement, params) {
      if (readOnly && !/^(SELECT|PRAGMA)\b/iu.test(statement.trim())) {
        attemptedWrites++;
        throw new Error("saved command GET attempted write through SQL.query");
      }
      return await f.sql.query(statement, params);
    },
    async run(statement, params) {
      if (readOnly) {
        attemptedWrites++;
        throw new Error("saved command GET attempted SQL.run");
      }
      return await f.sql.run(statement, params);
    },
    async batch(statements) {
      if (readOnly) {
        attemptedWrites++;
        throw new Error("saved command GET attempted SQL.batch");
      }
      return await f.sql.batch(statements);
    },
  };
  const remoteRequests: Request[] = [];
  let attemptedNative = 0;
  let customer: Record<string, unknown> | undefined;
  const client = createStripeBillingClient({
    secretKey: "sk_test_api_extensions_fixture",
    mode: "test",
    async fetch(request) {
      if (readOnly) {
        attemptedNative++;
        throw new Error("saved command GET attempted processor read or mutation");
      }
      remoteRequests.push(request);
      const url = new globalThis.URL(request.url);
      if (request.method === "GET" && url.pathname === "/v1/account")
        return Response.json({ id: "acct_apiExtensions", object: "account" });
      if (request.method === "GET" && url.pathname === "/v1/prices/price_apiExtensions")
        return Response.json({
          id: "price_apiExtensions",
          object: "price",
          livemode: false,
          active: true,
          currency: "usd",
          unit_amount: 1000,
          type: "recurring",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      if (request.method === "POST" && url.pathname === "/v1/customers") {
        const form = new URLSearchParams(await request.clone().text());
        customer = {
          id: "cus_apiExtensionsCommand",
          object: "customer",
          livemode: false,
          metadata: Object.fromEntries(
            [...form.entries()]
              .filter(([key]) => key.startsWith("metadata["))
              .map(([key, value]) => [key.slice(9, -1), value]),
          ),
        };
        return Response.json(customer);
      }
      if (request.method === "GET" && url.pathname === "/v1/customers/cus_apiExtensionsCommand")
        return Response.json(customer);
      if (request.method === "POST" && url.pathname === "/v1/checkout/sessions")
        throw new Error("local processor accepted request but acknowledgement was lost");
      throw new Error(`unexpected native request: ${request.method} ${url.pathname}`);
    },
  });
  const billingConfig = parseBillingConfig(PRICING.environment.TAKOSERVER_BILLING_CONFIG);
  if (!billingConfig) throw new Error("fixture billing config unavailable");
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: {
      accountId: "acct_apiExtensions",
      mode: "test",
      billingAuthority: "api-extensions-test",
    },
    prices: [{ priceId: "price_apiExtensions", monthlyAmountMinor: 1000 }],
  });
  const hostedBilling = await createCanonicalHostedBillingComposition({
    sql,
    clock: f.base.clock,
    billingConfig,
    pricing: PRICING,
    client,
    realm,
    consoleOrigin: "https://console.test",
    webhookSecret: "whsec_api_extensions_fixture",
    warnings: { state: "unavailable", reason: "transport-not-composed" },
  });
  const ports: AppPorts = {
    sql,
    clock: f.base.clock,
    billingConfig,
    hostedBilling,
    objects: createMemoryObjectStore(),
    identity: {
      async verify() {
        throw new Error("existing local session only");
      },
    },
    settlement: f.base.settlement,
    publicOrigin: "https://api.test",
    consoleOrigin: "https://console.test",
    v2: TEST_TAKOFORM_V2_CONFIG,
    forms: [],
    hostForms: [],
    offerings: [],
    driver: new InMemoryTakoformResourceDriver(),
  };
  const original = buildApp(ports);
  const subscriptionPath = `/v1/organizations/${f.org}/payments/subscription`;
  const command = { reference: "lost-ack-original", planKey: "configured" };
  const started = await f.request("POST", subscriptionPath, "payer", command, (request) =>
    original.fetch(request),
  );
  expect(started.status).toBe(202);
  expect((await started.json()).checkout.state).toBe("pending");
  expect(
    remoteRequests.filter(
      (request) =>
        request.method === "POST" &&
        new globalThis.URL(request.url).pathname === "/v1/checkout/sessions",
    ),
  ).toHaveLength(1);
  const originalRows = await f.sql.query(
    "SELECT * FROM stripe_subscription_checkout_intents WHERE org_id = ?",
    [f.org],
  );
  const originalCatalog = await f.sql.query("SELECT * FROM stripe_billing_pricing");
  expect(originalRows).toHaveLength(1);
  expect(originalRows[0]?.state).toBe("dispatched");
  const other = await f.accounts.createOrganization({ actor: f.owner, name: "Receipt isolation" });
  const otherReader = await f.accounts.createApiKey({
    actor: f.owner,
    organizationId: other.id,
    name: "Receipt reader",
    scopes: ["wallet:read"],
    expiresInSeconds: 3600,
  });
  const restarted = buildApp(ports);
  const before = remoteRequests.length;
  readOnly = true;
  const read = await f.request(
    "GET",
    `${subscriptionPath}/commands/start/${command.reference}`,
    "reader",
    undefined,
    (request) => restarted.fetch(request),
  );
  expect(read.status).toBe(200);
  expect(await read.json()).toEqual({
    receipt: {
      contractVersion: SUBSCRIPTION_COMMAND_RECEIPT_VERSION,
      organizationId: f.org,
      reference: command.reference,
      kind: "start",
      state: "pending",
      subscriptionRef: null,
      planKey: command.planKey,
      pricingRevision: BILLING_CONFIG.revision,
      checkout: null,
      effectiveAt: null,
      pendingChange: null,
      lifecycle: "pending",
    },
  });
  const originalReceiptPath = `${subscriptionPath}/commands/start/${command.reference}`;
  for (const [token, status] of [
    [undefined, 401],
    ["payer", 403],
    ["foreign", 403],
  ] as const)
    expect(
      (
        await f.request("GET", originalReceiptPath, token, undefined, (request) =>
          restarted.fetch(request),
        )
      ).status,
    ).toBe(status);
  const ownerRead = await f.request("GET", originalReceiptPath, "owner", undefined, (request) =>
    restarted.fetch(request),
  );
  expect(ownerRead.status).toBe(200);
  expect((await ownerRead.json()).receipt.reference).toBe(command.reference);
  const otherRead = await f.request(
    "GET",
    `/v1/organizations/${other.id}/payments/subscription/commands/start/${command.reference}`,
    otherReader.secret,
    undefined,
    (request) => restarted.fetch(request),
  );
  expect(otherRead.status).toBe(404);
  expect(await otherRead.json()).not.toHaveProperty("receipt");
  for (const kind of ["start", "cancel", "plan-change"] as const)
    expect(
      (
        await f.request(
          "GET",
          `${subscriptionPath}/commands/${kind}/never-recorded`,
          "reader",
          undefined,
          (request) => restarted.fetch(request),
        )
      ).status,
    ).toBe(404);
  expect(attemptedWrites).toBe(0);
  expect(attemptedNative).toBe(0);
  expect(remoteRequests).toHaveLength(before);
  expect(
    await f.sql.query("SELECT * FROM stripe_subscription_checkout_intents WHERE org_id = ?", [
      f.org,
    ]),
  ).toEqual(originalRows);
  expect(await f.sql.query("SELECT * FROM stripe_billing_pricing")).toEqual(originalCatalog);
  expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
});

test("qualified subscription custody retains its actual start and cancellation HTTP receipts", async () => {
  const f = await fixture();
  let started: Awaited<ReturnType<CustodiedSubscriptionPayments["begin"]>> = {
    state: "pending",
    id: "sci_test",
  };
  let cancellation: Awaited<ReturnType<CustodiedSubscriptionPayments["change"]>> = {
    state: "pending",
    subscriptionRef: TARGET,
  };
  const calls: unknown[] = [];
  const subscriptionCustody: CustodiedSubscriptionPayments = {
    planTable: PRICING.hostedPlanTable,
    async read() {
      return { subscriptionRef: TARGET };
    },
    async begin(input) {
      calls.push(input);
      return started;
    },
    async change(input) {
      calls.push(input);
      return cancellation;
    },
  };
  const route = f.makeRoute({ subscriptionCustody });
  const path = `/v1/organizations/${f.org}/payments/subscription`;
  for (const [receipt, status] of [
    [{ state: "pending", id: "sci_test" }, 202],
    [{ state: "open", id: "cs_test", url: URL }, 201],
    [{ state: "associated", id: "cs_test", subscriptionRef: TARGET }, 200],
    [{ state: "expired", id: "cs_test" }, 200],
  ] as const) {
    started = receipt;
    const response = await f.request(
      "POST",
      path,
      "payer",
      { reference: "start", planKey: "configured" },
      route,
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ checkout: receipt });
  }
  const action = { reference: "cancel", cancelAtPeriodEnd: true, expectedSubscriptionRef: TARGET };
  const pending = await f.request("PATCH", path, "payer", action, route);
  expect(pending.status).toBe(202);
  expect(await pending.json()).toEqual({ cancellation });
  cancellation = {
    state: "verified",
    subscriptionRef: TARGET,
    effectiveAt: "2026-11-01T00:00:00.000Z",
  };
  const verified = await f.request("PATCH", path, "payer", action, route);
  expect(verified.status).toBe(200);
  expect(await verified.json()).toEqual({ cancellation });
  expect(calls[calls.length - 1]).toMatchObject({
    expectedSubscriptionRef: TARGET,
    cancelAtPeriodEnd: true,
  });
});

test("subscription plan action is exclusive, target-pinned and unavailable without qualification", async () => {
  const f = await fixture();
  const calls: unknown[] = [];
  const subscriptionCustody: CustodiedSubscriptionPayments = {
    planTable: PRICING.hostedPlanTable,
    async read() {
      return null;
    },
    async begin() {
      return { state: "pending", id: "sci_test" };
    },
    async change() {
      return { state: "pending", subscriptionRef: TARGET };
    },
  };
  const path = `/v1/organizations/${f.org}/payments/subscription`;
  const action = { reference: "change", planKey: "configured", expectedSubscriptionRef: TARGET };
  const unavailable = f.makeRoute({ subscriptionCustody });
  expect((await f.request("PATCH", path, "payer", action, unavailable)).status).toBe(409);
  const pendingChange = {
    planKey: "configured",
    pricingRevision: BILLING_CONFIG.revision,
    effectiveAt: "2026-11-01T00:00:00.000Z",
  };
  const route = f.makeRoute({
    subscriptionCustody,
    subscriptionPlans: {
      async pending() {
        return pendingChange;
      },
      async change(input) {
        calls.push(input);
        return { state: "verified", subscriptionRef: TARGET, pendingChange };
      },
    },
  });
  for (const body of [
    { ...action, cancelAtPeriodEnd: true },
    { ...action, expectedSubscriptionRef: "sub_raw_provider" },
    { ...action, unknown: true },
    { reference: "cancel", cancelAtPeriodEnd: false, expectedSubscriptionRef: TARGET },
  ])
    expect((await f.request("PATCH", path, "payer", body, route)).status).toBe(400);
  expect((await f.request("PATCH", path, "walletWriter", "{", route)).status).toBe(403);
  expect(calls).toEqual([]);
  const response = await f.request("PATCH", path, "payer", action, route);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    planChange: { state: "verified", subscriptionRef: TARGET, pendingChange },
  });
  expect(
    (await (await f.request("GET", path, "reader", undefined, route)).json()).pendingChange,
  ).toEqual(pendingChange);
  const pendingRoute = f.makeRoute({
    subscriptionCustody,
    subscriptionPlans: {
      async pending() {
        return null;
      },
      async change() {
        return { state: "pending", subscriptionRef: TARGET };
      },
    },
  });
  const pending = await f.request("PATCH", path, "payer", action, pendingRoute);
  expect(pending.status).toBe(202);
  expect(await pending.json()).toEqual({
    planChange: { state: "pending", subscriptionRef: TARGET },
  });
});

test("Hosted uses its qualified port while all subscription modes require the canonical target", async () => {
  const f = await fixture();
  let calls = 0;
  const subscriptions: CustodiedSubscriptionPayments = {
    planTable: PRICING.hostedPlanTable,
    async read() {
      calls++;
      return null;
    },
    async begin() {
      calls++;
      return { state: "open", id: "cs_test", url: URL };
    },
    async change() {
      calls++;
      return {
        state: "verified",
        subscriptionRef: TARGET,
        effectiveAt: "2026-11-01T00:00:00.000Z",
      };
    },
  };
  const path = `/v1/organizations/${f.org}/payments/subscription`;
  const hosted = f.makeRoute({ subscriptions });
  expect((await f.request("POST", path, "payer", "{", hosted)).status).toBe(404);
  expect(
    (
      await f.request(
        "PATCH",
        path,
        "payer",
        { reference: "cancel", cancelAtPeriodEnd: true },
        hosted,
      )
    ).status,
  ).toBe(404);
  expect(calls).toBe(0);
  const standalone = { ...f.base, subscriptions };
  delete standalone.hostedBilling;
  const route = createControlRoutes(standalone);
  expect(
    (
      await f.request(
        "PATCH",
        path,
        "payer",
        { reference: "cancel", cancelAtPeriodEnd: false, expectedSubscriptionRef: TARGET },
        route,
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await f.request(
        "PATCH",
        path,
        "payer",
        { reference: "cancel", cancelAtPeriodEnd: true },
        route,
      )
    ).status,
  ).toBe(400);
  expect(calls).toBe(0);
  const canonical = await f.request(
    "PATCH",
    path,
    "payer",
    { reference: "cancel", cancelAtPeriodEnd: true, expectedSubscriptionRef: TARGET },
    route,
  );
  expect(canonical.status).toBe(200);
  expect(await canonical.json()).toEqual({
    cancellation: {
      state: "verified",
      subscriptionRef: TARGET,
      effectiveAt: "2026-11-01T00:00:00.000Z",
    },
  });
  expect(calls).toBe(1);
});

test("new service refusals use the existing closed canonical error envelope", async () => {
  for (const [error, status, code] of [
    [new OrgTopUpError("reconciliation_required"), 409, "conflict"],
    [new OrgTopUpError("unavailable"), 503, "billing_unavailable"],
    [new OrgWorkspaceUsageError("workspace_snapshot_expired", 409), 409, "expired"],
    [new OrgLimitPolicyError("limit_mode_unavailable", 409), 409, "conflict"],
    [new SubscriptionCommandReceiptError("unavailable"), 503, "billing_unavailable"],
    [new SubscriptionPlanChangeError("subscription_plan_unavailable", 409), 409, "conflict"],
    [new SubscriptionPlanChangeError("subscription_target_changed", 409), 409, "conflict"],
    [
      new SubscriptionPlanChangeError("subscription_target_changed", 503),
      503,
      "billing_unavailable",
    ],
  ] as const) {
    const response = controlErrorResponse(error);
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(Object.keys(body.error).sort()).toEqual(["code", "message", "requestId", "retryable"]);
    expect(body.error.code).toBe(code);
    expect(classifyRefusal(code, status)).not.toBe("unclassified");
  }
});

test("OpenAPI publishes actual optional Hosted DTOs and exclusive receipt states", () => {
  const document = openApiDocument;
  for (const path of [
    "/v1/organizations/personal",
    "/v1/organizations/{organizationId}/wallet/usage-summary/workspaces",
    "/v1/organizations/{organizationId}/wallet/limit-policy",
    "/v1/organizations/{organizationId}/wallet/checkout/{reference}",
    "/v1/organizations/{organizationId}/payments/subscription/commands/{kind}/{reference}",
  ])
    expect(document.paths).toHaveProperty(path);
  const schemas = document.components.schemas;
  expect(schemas.SubscriptionResponse.required).not.toContain("billingCapabilities");
  expect(schemas.SubscriptionResponse.properties.billingCapabilities).toEqual({
    $ref: "#/components/schemas/HostedBillingCapabilities",
  });
  expect(schemas.HostedBillingCapabilities.properties.contractVersion.const).toBe(
    "hosted-billing-v1",
  );
  expect(Object.keys(schemas.HostedBillingCapabilities.properties).sort()).toEqual([
    "contractVersion",
    "subscriptionCancellation",
    "subscriptionPlanChange",
    "subscriptionStart",
    "topUps",
  ]);
  expect(schemas.SubscriptionCommandReceipt.additionalProperties).toBe(false);
  expect(schemas.SubscriptionCommandReceiptResponse.required).toEqual(["receipt"]);
  expect(schemas.SubscriptionCommandReceipt.properties.contractVersion.const).toBe(
    SUBSCRIPTION_COMMAND_RECEIPT_VERSION,
  );
  expect(schemas.SubscriptionCommandReceipt.oneOf).toHaveLength(9);
  const scheduledCancel = schemas.SubscriptionCommandReceipt.oneOf.find(
    (branch) =>
      branch.properties.kind.const === "cancel" && branch.properties.state.const === "verified",
  );
  expect(scheduledCancel?.properties.lifecycle).toEqual({ const: "scheduled" });
  expect(scheduledCancel?.properties.pendingChange).toEqual({ type: "null" });
  const verifiedPlan = schemas.SubscriptionCommandReceipt.oneOf.find(
    (branch) =>
      branch.properties.kind.const === "plan-change" &&
      branch.properties.state.const === "verified",
  );
  expect(verifiedPlan?.properties.lifecycle).toEqual({
    enum: ["scheduled", "activated", "revoked"],
  });
  expect(verifiedPlan?.properties.pendingChange).toHaveProperty("required", [
    "planKey",
    "pricingRevision",
    "effectiveAt",
  ]);
  expect(schemas.WalletWorkspaceUsageResponse.required).toContain("usageSummary");
  expect(schemas.WalletWorkspaceUsageResponse.properties.totalsScope.const).toBe("organization");
  expect(schemas.ChangeWalletLimitPolicyRequest.oneOf).toHaveLength(3);
  expect(schemas.ChangeSubscriptionRequest.properties.cancelAtPeriodEnd.const).toBe(true);
  expect(schemas.SubscriptionPlanChangeRequest.required).toContain("expectedSubscriptionRef");
  expect(schemas.WalletHoldReceipt.properties).toHaveProperty("workspaceRef");
  expect(schemas.CaptureWalletHoldRequest.properties).not.toHaveProperty("workspaceRef");
  const subscription = document.paths[
    "/v1/organizations/{organizationId}/payments/subscription"
  ] as Record<string, { responses: Record<string, unknown> }>;
  expect(subscription.post?.responses).toHaveProperty("202");
  expect(subscription.patch?.responses).toHaveProperty("202");
  expect(schemas.WalletLimitPolicy.properties.capabilities.properties.postpaid.const).toBe(false);
});
