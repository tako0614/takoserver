import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  BillingHttp,
  parseBusinessInput,
  runStart,
  runVerify,
} from "../scripts/hosted-billing-business-e2e.ts";
import { createAccounts } from "../src/auth.ts";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { type CustodiedSubscriptionPayments, createControlRoutes } from "../src/control.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { createLedger } from "../src/ledger.ts";
import { createOrgBilling } from "../src/org-billing.ts";
import { createOrgTopUps, type TopUpSession } from "../src/org-top-up.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { createSubscriptionCommandReceipts } from "../src/subscription-command-receipts.ts";
import { createSubscriptionCustody } from "../src/subscription-custody.ts";

const ORIGIN = "https://api.test";
const NOW = "2026-10-15T12:00:00.000Z";
const OUTPUT = process.env.TAKOSERVER_BILLING_E2E_TEST_TMPDIR ?? tmpdir();
const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

/** The control router, Accounts, wallet, Checkout custody and SQL are real. The
 * processor transport below is a local TEST double; it cannot prove Stripe delivery. */
test("the business client reaches the actual authenticated billing routes and original SQL readbacks", async () => {
  mkdirSync(OUTPUT, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(OUTPUT, "control-route-"));
  directories.push(directory);
  const sql = createEphemeralSql();
  const clock = () => new Date(NOW);
  let sequence = 0;
  const accounts = createAccounts({
    sql,
    clock,
    randomSecret: () => `local-route-session-${sequence++}`,
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
  const session = await accounts.signIn({ provider: "google", assertion: "route-owner" });
  const pricing = compilePricingAuthoring({
    authoringVersion: 1,
    billingConfig: {
      schemaVersion: 1,
      revision: "route-r1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      freeIncludedMinor: 150,
      holdTtlSeconds: 300,
      purchaseCreditExpiry: { kind: "none" },
      plans: { configured: { includedMinor: 2000, stripePriceId: "price_route" } },
      meters: { requests: { unit: "request", rate: { numeratorMicros: "1", denominator: "1" } } },
    },
    checkout: { minimumMinor: 50, maximumMinor: 5000 },
    planIds: { free: "free", subscription: "configured", usage: "usage" },
    stripeMonthlyReview: {
      configured: { expectedAmountMinor: 1000, currency: "USD", interval: "month" },
    },
  });
  const config = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
  if (!config) throw new Error("fixture pricing unavailable");
  const ledger = createLedger(sql, clock, { hostedPaidFreeExclusion: true });
  const billing = createOrgBilling({ sql, clock, ledger, config, hostedPaidFreeExclusion: true });
  const topupSessions = new Map<string, TopUpSession>();
  const topupCalls: string[] = [];
  const topups = createOrgTopUps({
    sql,
    clock,
    consoleOrigin: "https://console.test",
    bounds: { minimumMinor: 50, maximumMinor: 5000 },
    pin: async () => ({
      customerId: "cus_route",
      accountId: "acct_route",
      financialRealm: "route-test",
      livemode: false,
      pricingRevision: config.revision,
      purchaseCreditExpiry: config.purchaseCreditExpiry,
    }),
    client: {
      async create(command) {
        topupCalls.push(command.reference);
        const session: TopUpSession = {
          ...command,
          id: `cs_${command.reference}`,
          url: `https://checkout.stripe.com/c/pay/cs_${command.reference}`,
          status: "open",
          paymentStatus: "unpaid",
          mode: "payment",
        };
        topupSessions.set(session.id, session);
        return session;
      },
      async read(id) {
        return topupSessions.get(id) ?? null;
      },
      async recover(command) {
        return topupSessions.get(`cs_${command.reference}`) ?? null;
      },
    },
  });
  const nativeSessions = new Map<string, Record<string, unknown>>();
  const nativeCalls: string[] = [];
  const stripe = createStripeBillingClient({
    secretKey: "sk_test_local_route_only",
    mode: "test",
    async fetch(request) {
      const url = new URL(request.url);
      nativeCalls.push(`${request.method} ${url.pathname}`);
      if (request.method === "POST" && url.pathname === "/v1/checkout/sessions") {
        const form = new URLSearchParams(await request.text());
        const id = "cs_route_subscription";
        const metadata = Object.fromEntries(
          [...form.entries()]
            .filter(([key]) => key.startsWith("metadata["))
            .map(([key, value]) => [key.slice(9, -1), value]),
        );
        const session = {
          id,
          object: "checkout.session",
          livemode: false,
          mode: "subscription",
          customer: form.get("customer"),
          client_reference_id: form.get("client_reference_id"),
          metadata,
          status: "open",
          payment_status: "unpaid",
          subscription: null,
          invoice: null,
          after_expiration: null,
          recovered_from: null,
          currency: "usd",
          amount_subtotal: 1000,
          amount_total: 1000,
          created: Date.parse(NOW) / 1000,
          expires_at: Date.parse(NOW) / 1000 + 3600,
          url: `https://checkout.stripe.com/c/pay/${id}`,
        };
        nativeSessions.set(id, session);
        return Response.json(session);
      }
      if (request.method === "GET" && url.pathname === "/v1/checkout/sessions")
        return Response.json({ data: [...nativeSessions.values()], has_more: false });
      if (
        request.method === "GET" &&
        url.pathname === "/v1/checkout/sessions/cs_route_subscription"
      )
        return Response.json(nativeSessions.get("cs_route_subscription"));
      if (request.method === "GET" && url.pathname.endsWith("/line_items"))
        return Response.json({
          data: [{ id: "li_route", object: "item", price: "price_route", quantity: 1 }],
          has_more: false,
        });
      throw new Error(`unexpected local processor operation ${request.method} ${url.pathname}`);
    },
  });
  const custody = createSubscriptionCustody({
    sql,
    client: stripe,
    clock,
    consoleOrigin: "https://console.test",
    plans: [
      {
        planId: "configured",
        stripePriceId: "price_route",
        monthlyAmountMinor: 1000,
        includedCreditMinor: 2000,
      },
    ],
    pricingRevision: config.revision,
    effectiveAt: "2026-10-01T00:00:00.000Z",
    validatePrice: async () => {},
    validateCustomer: async () => {},
    isConclusivePreflightFailure: () => false,
  });
  const payments: CustodiedSubscriptionPayments = {
    planTable: pricing.hostedPlanTable,
    read: async () => null,
    begin: (input) => custody.begin(input.organizationId, input.reference, input.planKey),
    change: async () => {
      throw new Error("cancellation is outside this route regression");
    },
  };
  const receipts = createSubscriptionCommandReceipts({
    readStart: custody.readStartCommand,
    readNativeCancel: custody.readCancelCommand,
    readExtension: async () => null,
  });
  const route = createControlRoutes({
    publicOrigin: ORIGIN,
    accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger,
    billing,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {
      async verify() {
        throw new Error("no external settlement in this test");
      },
    },
    clock,
    hostedBilling: true,
    checkout: topups,
    subscriptionCustody: payments,
    subscriptionCommandReceipts: receipts,
  });
  const requests: string[] = [];
  const client = new BillingHttp(ORIGIN, session.sessionToken, async (request) => {
    const url = new URL(request.url);
    requests.push(`${request.method} ${url.pathname}`);
    const response = await route(request, url);
    if (!response) throw new Error(`unhandled product route: ${url.pathname}`);
    return response;
  });
  const inputRaw = JSON.stringify({
    kind: "takoserver.hosted-billing-business-e2e-input@v1",
    sourceHead: "a".repeat(40),
    targetSha256: `sha256:${"b".repeat(64)}`,
    usage: {
      reference: "usage_route",
      workspaceRef: "workspace_route",
      meter: "requests",
      quantityUnit: "request",
      quantity: "7",
      periodStart: "2026-10-14T00:00:00.000Z",
      periodEnd: "2026-10-14T01:00:00.000Z",
      pricingRevision: config.revision,
      expectedMicros: "7",
      measurementFingerprint: "measurement_route",
    },
    subscription: { reference: "subscription_route", planKey: "configured" },
    topup: { reference: "topup_route", amountMinor: 500 },
  });
  parseBusinessInput(inputRaw);
  const options = {
    journalPath: join(directory, "original.jsonl"),
    handoffPath: join(directory, "checkout"),
    inputRaw,
    targetSha256: `sha256:${"b".repeat(64)}`,
    origin: ORIGIN,
    client,
  };
  await expect(
    new BillingHttp(ORIGIN, "not-a-session", async (request) => {
      const url = new URL(request.url);
      return (await route(request, url)) ?? new Response(null, { status: 404 });
    }).request("GET", "/v1/me"),
  ).rejects.toThrow("HTTP 401");
  await runStart(options);
  const postCount = requests.filter((request) => request.startsWith("POST")).length;
  rmSync(`${options.handoffPath}.subscription.url`);
  const result = await runVerify(options);
  expect(result).toMatchObject({
    usagePublicFieldsMatch: true,
    workspaceRead: true,
    topupAmountProven: true,
    subscriptionCommandState: "open",
    topupState: "ready",
    webhookProven: false,
  });
  expect(requests.filter((request) => request.startsWith("POST"))).toEqual([
    "POST /v1/organizations/personal",
    expect.stringMatching(/\/wallet\/usage-records$/u),
    expect.stringMatching(/\/payments\/subscription$/u),
    expect.stringMatching(/\/wallet\/checkout$/u),
  ]);
  expect(await sql.query("SELECT ref,workspace_ref FROM org_wallet_usage_records")).toEqual([
    { ref: "usage_route", workspace_ref: "workspace_route" },
  ]);
  expect(await sql.query("SELECT reference FROM stripe_top_up_commands")).toEqual([
    { reference: "topup_route" },
  ]);
  expect(await sql.query("SELECT plan_key FROM stripe_subscription_checkout_intents")).toEqual([
    { plan_key: "configured" },
  ]);
  expect(topupCalls).toEqual(["topup_route"]);
  expect(nativeCalls).toContain("POST /v1/checkout/sessions");
  expect(requests.filter((request) => request.startsWith("POST"))).toHaveLength(postCount);
  expect(readFileSync(`${options.handoffPath}.subscription.url`, "utf8")).toContain(
    "cs_route_subscription",
  );
});
