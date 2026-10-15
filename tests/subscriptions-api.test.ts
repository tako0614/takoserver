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
const EXPECTED_REF = `sra_${"a".repeat(64)}`;
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
  receipts: {
    checkout?: "open" | "pending" | "associated" | "expired";
    cancellation?: "pending" | "verified";
  } = {},
) {
  const calls: string[] = [];
  const scopes: Record<string, readonly ApiKeyScope[]> = {
    reader: ["wallet:read"],
    payer: ["payments:write"],
    walletWriter: ["wallet:write"],
    wrongOrg: ["payments:write", "wallet:read"],
  };
  const service: SubscriptionPayments = {
    planTable: pricing.hostedPlanTable,
    async read(org) {
      calls.push(`read:${org}`);
      return null;
    },
    async begin(input) {
      calls.push(`begin:${input.organizationId}:${input.reference}:${input.planKey}`);
      if (receipts.checkout === "pending") return { id: "sci_test", state: "pending" };
      if (receipts.checkout === "associated")
        return { id: "cs_test", state: "associated", subscriptionRef: EXPECTED_REF };
      if (receipts.checkout === "expired") return { id: "cs_test", state: "expired" };
      return { id: "cs_test", state: "open", url: "https://checkout.stripe.com/c/pay/test" };
    },
    async change(input) {
      calls.push(
        `change:${input.organizationId}:${input.reference}:${input.cancelAtPeriodEnd}:${input.expectedSubscriptionRef}`,
      );
      if (input.expectedSubscriptionRef !== EXPECTED_REF)
        throw new StripeBillingError("subscription_management_conflict", 409);
      if (receipts.cancellation === "pending")
        return { state: "pending", subscriptionRef: EXPECTED_REF };
      return {
        state: "verified",
        subscriptionRef: EXPECTED_REF,
        effectiveAt: "2026-11-01T00:00:00.000Z",
      };
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
    (
      await f.request("PATCH", "payer", {
        reference: "two",
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: EXPECTED_REF,
      })
    )?.status,
  ).toBe(200);
  expect(f.calls).toEqual([
    `read:${ORG}`,
    `begin:${ORG}:one:configured`,
    `change:${ORG}:two:true:${EXPECTED_REF}`,
  ]);
});

test("cancellation requires an exact current target and true-only period-end intent", async () => {
  const f = fixture();
  for (const body of [
    { reference: "missing", cancelAtPeriodEnd: true },
    { reference: "malformed", cancelAtPeriodEnd: true, expectedSubscriptionRef: "sra_expected" },
    { reference: "false", cancelAtPeriodEnd: false, expectedSubscriptionRef: EXPECTED_REF },
    { reference: "string", cancelAtPeriodEnd: "true", expectedSubscriptionRef: EXPECTED_REF },
  ]) {
    expect((await f.request("PATCH", "payer", body))?.status).toBe(400);
  }
  expect(f.calls).toEqual([]);
  const stale = await f.request("PATCH", "payer", {
    reference: "stale",
    cancelAtPeriodEnd: true,
    expectedSubscriptionRef: `sra_${"b".repeat(64)}`,
  });
  expect(stale?.status).toBe(409);
  expect(f.calls).toEqual([`change:${ORG}:stale:true:sra_${"b".repeat(64)}`]);
});

test("subscription routes distinguish pending, open, associated, expired, and verified receipts", async () => {
  for (const [state, status] of [
    ["pending", 202],
    ["open", 201],
    ["associated", 200],
    ["expired", 200],
  ] as const) {
    const f = fixture(true, { checkout: state });
    const response = await f.request("POST", "payer", { reference: state, planKey: "configured" });
    expect(response?.status).toBe(status);
    const body = await response?.json();
    expect(body).toMatchObject({ checkout: { state } });
    if (state === "associated") {
      expect(body).toEqual({
        checkout: { state: "associated", id: "cs_test", subscriptionRef: EXPECTED_REF },
      });
    }
  }
  for (const [state, status] of [
    ["pending", 202],
    ["verified", 200],
  ] as const) {
    const f = fixture(true, { cancellation: state });
    const response = await f.request("PATCH", "payer", {
      reference: state,
      cancelAtPeriodEnd: true,
      expectedSubscriptionRef: EXPECTED_REF,
    });
    expect(response?.status).toBe(status);
    expect(await response?.json()).toMatchObject({
      cancellation: { state, subscriptionRef: EXPECTED_REF },
    });
    expect(f.calls).toEqual([`change:${ORG}:${state}:true:${EXPECTED_REF}`]);
  }
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

test("hosted activation requires credentials matching the selected Stripe mode", () => {
  expect(() => resolvePayment({ hostedPricing: pricing })).toThrow(
    "Hosted billing requires a Stripe key",
  );
  expect(() => resolvePayment({ hostedPricing: pricing, stripeSecretKey: "sk_live_fake" })).toThrow(
    "Invalid Stripe billing client configuration",
  );
  expect(() =>
    resolvePayment({ hostedPricing: pricing, stripeMode: "live", stripeSecretKey: "sk_test_fake" }),
  ).toThrow("Invalid Stripe billing client configuration");
  expect(
    resolvePayment({ hostedPricing: pricing, stripeSecretKey: "sk_test_fake" }).events,
  ).toBeFunction();
  expect(
    resolvePayment({ hostedPricing: pricing, stripeMode: "live", stripeSecretKey: "sk_live_fake" })
      .events,
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
  const planRows = document.components.schemas.HostedPlanTable.properties.plans;
  expect(planRows.minItems).toBe(3);
  expect(planRows.maxItems).toBe(4);
  expect(
    planRows.oneOf.map((shape) => shape.prefixItems.map((item) => item.properties.tier.const)),
  ).toEqual([
    ["free", "subscription", "usage"],
    ["free", "subscription", "subscription", "usage"],
  ]);
  expect(document.components.schemas).toHaveProperty("SubscriptionProjection");
  expect(JSON.stringify(document.components.schemas.WalletResponse)).toContain("refund_receivable");
  expect(JSON.stringify(document.components.schemas.WalletHoldReceipt)).toContain("closureReason");
});
