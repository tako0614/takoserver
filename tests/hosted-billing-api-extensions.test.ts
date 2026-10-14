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
import {
  createOrgTopUps,
  OrgTopUpError,
  type TopUpClient,
  type TopUpSession,
} from "../src/org-top-up.ts";
import { OrgWorkspaceUsageError } from "../src/org-workspace-usage.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { SubscriptionPlanChangeError } from "../src/stripe-subscription-plan-change.ts";
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
  expect(schemas.WalletWorkspaceUsageResponse.required).toContain("usageSummary");
  expect(schemas.WalletWorkspaceUsageResponse.properties.totalsScope.const).toBe("organization");
  expect(schemas.ChangeWalletLimitPolicyRequest.oneOf).toHaveLength(2);
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
