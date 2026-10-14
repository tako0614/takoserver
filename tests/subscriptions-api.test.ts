import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import type { Accounts, Actor, ApiKeyScope } from "../src/auth.ts";
import { AuthError } from "../src/auth.ts";
import { controlErrorResponse, createControlRoutes } from "../src/control.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { openApiDocument } from "../src/openapi.ts";
import { resolvePayment } from "../src/payment-setup.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import {
  assertStripeBillingSchema,
  StripeBillingError,
  type SubscriptionPayments,
} from "../src/stripe-billing.ts";

const ORG = "org_subscriptions";
const pricing = compilePricingAuthoring({
  authoringVersion: 1,
  billingConfig: {
    schemaVersion: 1,
    revision: "subscription-test",
    effectiveAt: "2026-10-01T00:00:00.000Z",
    currency: "USD",
    freeIncludedMinor: 0,
    purchaseCreditExpiry: { kind: "none" },
    plans: { configured: { includedMinor: 400, stripePriceId: "price_test" } },
    meters: {},
  },
  checkout: { minimumMinor: 50, maximumMinor: 5000 },
  planIds: { free: "edge_test", subscription: "configured", usage: "metered_test" },
  stripeMonthlyReview: {
    configured: { expectedAmountMinor: 1200, currency: "USD", interval: "month" },
  },
});
function fixture(
  enabled = true,
  planTable: SubscriptionPayments["planTable"] = pricing.hostedPlanTable,
) {
  const calls: string[] = [];
  const scopes: Record<string, readonly ApiKeyScope[]> = {
    reader: ["wallet:read"],
    payer: ["payments:write"],
    walletWriter: ["wallet:write"],
    wrongOrg: ["payments:write", "wallet:read"],
  };
  const service: SubscriptionPayments = {
    planTable,
    async read(org) {
      calls.push(`read:${org}`);
      return null;
    },
    async begin(input) {
      calls.push(`begin:${input.organizationId}:${input.reference}:${input.planKey}`);
      return { url: "https://checkout.stripe.com/c/pay/test" };
    },
    async change(input) {
      calls.push(`change:${input.organizationId}:${input.reference}:${input.cancelAtPeriodEnd}`);
      return null;
    },
  };
  const route = createControlRoutes({
    publicOrigin: "https://host.test",
    accounts: {
      async authenticate(header: string | null) {
        const token = header?.replace(/^Bearer /u, "");
        if (token === "owner") return { kind: "session", principalId: "owner" } as Actor;
        return token && scopes[token]
          ? ({
              kind: "api_key",
              organizationId: token === "wrongOrg" ? "org_other" : ORG,
              scopes: scopes[token],
            } as Actor)
          : null;
      },
      async requireOwner(_actor: Actor, org: string) {
        if (org !== ORG) throw new AuthError("permission_denied");
      },
    } as unknown as Accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger: {} as never,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
    clock: () => new Date("2026-10-13T12:00:00.000Z"),
    ...(enabled ? { subscriptions: service } : {}),
  });
  async function request(
    method: string,
    token?: string,
    body?: unknown,
    path = `/v1/organizations/${ORG}/payments/subscription`,
  ) {
    const url = new URL(path, "https://host.test");
    try {
      return await route(
        new Request(url, {
          method,
          headers: {
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            "content-type": "application/json",
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
        url,
      );
    } catch (error) {
      return controlErrorResponse(error);
    }
  }
  return { calls, request };
}

test("subscription routes enforce distinct read/payment authority and Organization binding before service access", async () => {
  const f = fixture();
  expect((await f.request("GET"))?.status).toBe(401);
  expect((await f.request("GET", "wrongOrg"))?.status).toBe(403);
  expect(
    (await f.request("POST", "walletWriter", { reference: "one", planKey: "configured" }))?.status,
  ).toBe(403);
  expect(
    (await f.request("POST", "reader", { reference: "one", planKey: "configured" }))?.status,
  ).toBe(403);
  expect(
    (await f.request("PATCH", "wrongOrg", { reference: "one", cancelAtPeriodEnd: true }))?.status,
  ).toBe(403);
  expect(f.calls).toEqual([]);
  const read = await f.request("GET", "reader");
  expect(read?.status).toBe(200);
  expect(await read?.json()).toEqual({ subscription: null, planTable: pricing.hostedPlanTable });
  expect(
    (await f.request("POST", "payer", { reference: "one", planKey: "configured" }))?.status,
  ).toBe(201);
  expect(
    (await f.request("PATCH", "payer", { reference: "two", cancelAtPeriodEnd: true }))?.status,
  ).toBe(200);
  expect(f.calls).toEqual([`read:${ORG}`, `begin:${ORG}:one:configured`, `change:${ORG}:two:true`]);
});

test("owner access works, request amounts are refused and disabled feature exposes no subscription operation", async () => {
  const f = fixture();
  expect(
    (await f.request("POST", "owner", { reference: "owner_one", planKey: "configured" }))?.status,
  ).toBe(201);
  expect(
    (
      await f.request("POST", "payer", {
        reference: "money",
        planKey: "configured",
        includedMinor: 999,
      })
    )?.status,
  ).toBe(400);
  expect(
    (await f.request("PATCH", "payer", { reference: "cancel", cancelAtPeriodEnd: "true" }))?.status,
  ).toBe(400);
  expect(f.calls).toHaveLength(1);
  const off = fixture(false);
  expect((await off.request("GET", "reader"))?.status).toBe(404);
  expect(
    (await off.request("POST", "payer", { reference: "one", planKey: "configured" }))?.status,
  ).toBe(404);
  expect(off.calls).toEqual([]);
  expect(
    (await f.request("POST", "payer", {}, `/v1/organizations/${ORG}/payments/refund`))?.status,
  ).toBe(404);
  expect(controlErrorResponse(new StripeBillingError("payment_unavailable")).status).toBe(503);
});

test("hosted activation requires explicit test-mode credentials", () => {
  expect(() => resolvePayment({ hostedPricing: pricing })).toThrow(
    "Hosted billing requires Stripe test mode",
  );
  expect(() => resolvePayment({ hostedPricing: pricing, stripeSecretKey: "sk_live_fake" })).toThrow(
    "Invalid Stripe billing client configuration",
  );
  expect(
    resolvePayment({ hostedPricing: pricing, stripeSecretKey: "sk_test_fake" }).events,
  ).toBeFunction();
  expect(resolvePayment({})).toEqual({});
});

test("hosted startup rejects a complete table inventory with obsolete Stripe credit units", async () => {
  const database = new Database(":memory:");
  try {
    for (const migration of MIGRATIONS)
      database.exec(
        migration.name === "0095_stripe_billing.sql"
          ? migration.sql.replaceAll("amount_micros", "amount_minor")
          : migration.sql,
      );
    const sql = createSqliteSql(database);
    await expect(assertStripeBillingSchema(sql)).rejects.toMatchObject({
      code: "stripe_billing_schema_not_ready",
    });
    expect(await sql.query("SELECT COUNT(*) AS count FROM stripe_billing_pricing")).toEqual([
      { count: 0 },
    ]);
  } finally {
    database.close();
  }
});

test("OpenAPI publishes subscription scope, request and refund projection contracts", () => {
  const document = openApiDocument;
  const path = document.paths["/v1/organizations/{organizationId}/payments/subscription"] as Record<
    string,
    Record<string, unknown>
  >;
  expect(path.get?.["x-required-scopes"]).toEqual(["wallet:read"]);
  expect(path.post?.["x-required-scopes"]).toEqual(["payments:write"]);
  expect(path.patch?.["x-required-scopes"]).toEqual(["payments:write"]);
  expect(document.components.schemas).toHaveProperty("HostedPlanTable");
  expect(document.components.schemas).toHaveProperty("SubscriptionProjection");
  expect(JSON.stringify(document.components.schemas.WalletResponse)).toContain("refund_receivable");
  expect(JSON.stringify(document.components.schemas.WalletHoldReceipt)).toContain("closureReason");
});

test("subscription HTTP publishes legacy and two-choice tables within the OpenAPI row contract", async () => {
  const source = await Bun.file(
    new URL("../config/shared-hosted-pricing.json", import.meta.url),
  ).json();
  source.plans[0].stripePriceId = "price_api10";
  source.plans[1].stripePriceId = "price_api50";
  const meters = Object.fromEntries(
    Object.entries(
      source.meters as Record<
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
  const shared = compilePricingAuthoring({
    authoringVersion: 2,
    sharedPricing: source,
    planIds: { free: "free", usage: "usage" },
    billingConfig: {
      schemaVersion: 1,
      revision: source.revision,
      effectiveAt: "2026-10-14T00:00:00.000Z",
      currency: "USD",
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {
        "hosted-10": { includedMinor: 2000, stripePriceId: "price_api10" },
        "hosted-50": { includedMinor: 10000, stripePriceId: "price_api50" },
      },
      meters,
    },
    checkout: { minimumMinor: 50, maximumMinor: 5000 },
  });
  const schema = openApiDocument.components.schemas.HostedPlanTable.properties.plans;
  for (const table of [pricing.hostedPlanTable, shared.hostedPlanTable]) {
    const response = await fixture(true, table).request("GET", "reader");
    expect(response?.status).toBe(200);
    const body = await response?.json();
    expect(body).toEqual({ subscription: null, planTable: table });
    expect(table.plans.length).toBeGreaterThanOrEqual(schema.minItems);
    expect(table.plans.length).toBeLessThanOrEqual(schema.maxItems);
    for (const plan of table.plans) {
      const variant = schema.items.oneOf.find((row) => row.properties.tier.const === plan.tier);
      expect(variant).toBeDefined();
      expect(Object.keys(plan).sort()).toEqual([...(variant?.required ?? [])].sort());
    }
  }
  expect(shared.hostedPlanTable.plans.map((plan) => plan.tier)).toEqual([
    "free",
    "subscription",
    "subscription",
    "usage",
  ]);
  expect(
    shared.hostedPlanTable.plans
      .filter((plan) => plan.tier === "subscription")
      .map((plan) => [plan.planId, plan.monthlyAmountMinor, plan.includedCreditMinor]),
  ).toEqual([
    ["hosted-10", 1000, 2000],
    ["hosted-50", 5000, 10000],
  ]);
});
