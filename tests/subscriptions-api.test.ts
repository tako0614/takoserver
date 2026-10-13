import { expect, test } from "bun:test";
import type { Accounts, Actor, ApiKeyScope } from "../src/auth.ts";
import { AuthError } from "../src/auth.ts";
import { controlErrorResponse, createControlRoutes } from "../src/control.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { openApiDocument } from "../src/openapi.ts";
import { resolvePayment } from "../src/payment-setup.ts";
import { StripeBillingError, type SubscriptionPayments } from "../src/stripe-billing.ts";

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
function fixture(enabled = true) {
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
