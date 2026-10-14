import { describe, expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import {
  assertHostedPricingMatchesBilling,
  compilePricingAuthoring,
  HostedPricingError,
  parseHostedPricing,
} from "../src/hosted-pricing.ts";

function authoring() {
  return {
    authoringVersion: 1,
    planIds: { free: "free", subscription: "starter", usage: "usage" },
    billingConfig: {
      schemaVersion: 1,
      revision: "candidate-r3",
      effectiveAt: "2026-10-13T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86_400,
      freeIncludedMinor: 300,
      purchaseCreditExpiry: { kind: "none" },
      plans: { starter: { includedMinor: 1200, stripePriceId: "price_month123" } },
      meters: {
        "takosumi.storage.byte-hours": {
          unit: "byte-hour",
          rate: { numeratorMicros: "1", denominator: "1000" },
        },
      },
      history: [],
    },
    checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
    stripeMonthlyReview: {
      starter: { expectedAmountMinor: 125, currency: "USD", interval: "month" },
    },
  };
}

describe("hosted pricing runtime policy", () => {
  test("rejects unrepresentable current and historical grants before activating Checkout", () => {
    const tooLarge = Math.floor(Number.MAX_SAFE_INTEGER / 10_000) + 1;
    const current = authoring();
    current.billingConfig.plans.starter.includedMinor = tooLarge;
    expect(() => compilePricingAuthoring(current)).toThrow(
      "grant amounts must fit the USD-micros ledger",
    );
    expect(() => parseHostedPricing(JSON.stringify(current))).toThrow(HostedPricingError);
    const history = authoring();
    const old = {
      ...history.billingConfig,
      revision: "old",
      effectiveAt: "2026-09-01T00:00:00.000Z",
      plans: { starter: { includedMinor: tooLarge, stripePriceId: "price_old" } },
    };
    const { history: ignored, ...snapshot } = old;
    void ignored;
    expect(() =>
      parseHostedPricing(
        JSON.stringify({
          ...history,
          billingConfig: { ...history.billingConfig, history: [snapshot] },
        }),
      ),
    ).toThrow(HostedPricingError);
    const valid = authoring();
    valid.billingConfig.plans.starter.includedMinor = tooLarge - 1;
    expect(() => parseHostedPricing(JSON.stringify(valid))).not.toThrow();
  });

  test("parses shared authored pricing and binds exactly the input to its environment", () => {
    const input = authoring();
    const parsed = parseHostedPricing(JSON.stringify(input));
    expect(parsed).toBeDefined();
    expect(parseHostedPricing(undefined)).toBeUndefined();
    expect(parsed?.environment.TAKOSERVER_HOSTED_PRICING).toBe(JSON.stringify(input));
    expect(JSON.parse(parsed?.environment.TAKOSERVER_BILLING_CONFIG ?? "null")).toEqual(
      input.billingConfig,
    );
    expect(parsed?.hostedPlanTable.products).toEqual(["takosumi-hosted", "takoserver"]);
    expect(parsed?.hostedPlanTable.plans.map((plan) => plan.planId)).toEqual([
      input.planIds.free,
      input.planIds.subscription,
      input.planIds.usage,
    ]);
  });

  test("rejects malformed, oversized, and invalid tariff inputs with a safe error", () => {
    expect(() => parseHostedPricing('{"planIds":{"raw":"SECRET_PATH"}}')).toThrow(
      HostedPricingError,
    );
    try {
      parseHostedPricing('{"planIds":{"raw":"SECRET_PATH"}}');
    } catch (error) {
      expect(String(error)).not.toContain("SECRET_PATH");
    }

    const invalidBilling = authoring();
    (invalidBilling.billingConfig as Record<string, unknown>).SECRET_PATH_KEY = "value";
    expect(() => parseHostedPricing(JSON.stringify(invalidBilling))).toThrow(HostedPricingError);

    const valid = JSON.stringify(authoring());
    const oversized = `${valid}${" ".repeat(262_145 - new TextEncoder().encode(valid).byteLength)}`;
    expect(() => parseHostedPricing(oversized)).toThrow(HostedPricingError);
  });

  test("rejects missing or changed runtime billing, table, meter, and price state", () => {
    const pricing = parseHostedPricing(JSON.stringify(authoring()));
    if (!pricing) throw new Error("pricing fixture must parse");
    const billing = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
    if (!billing) throw new Error("billing fixture must parse");
    expect(() => assertHostedPricingMatchesBilling(pricing, billing)).not.toThrow();
    expect(() => assertHostedPricingMatchesBilling(pricing, undefined)).toThrow(HostedPricingError);

    const changedRevision = { ...billing, revision: "different-revision" };
    expect(() => assertHostedPricingMatchesBilling(pricing, changedRevision)).toThrow(
      HostedPricingError,
    );

    const subscriptionPlan = billing.plans.starter;
    if (!subscriptionPlan) throw new Error("billing fixture must include its plan");
    const changedPrice = {
      ...billing,
      plans: {
        ...billing.plans,
        starter: { ...subscriptionPlan, stripePriceId: "price_changed" },
      },
    };
    expect(() => assertHostedPricingMatchesBilling(pricing, changedPrice)).toThrow(
      HostedPricingError,
    );

    const changedMeter = {
      ...billing,
      meters: {
        ...billing.meters,
        "takosumi.storage.byte-hours": {
          unit: "byte-hour",
          rate: { numeratorMicros: "2", denominator: "1000" },
        },
      },
    };
    expect(() => assertHostedPricingMatchesBilling(pricing, changedMeter)).toThrow(
      HostedPricingError,
    );

    const changedTable = {
      ...pricing,
      hostedPlanTable: {
        ...pricing.hostedPlanTable,
        plans: [
          pricing.hostedPlanTable.plans[0],
          { ...pricing.hostedPlanTable.plans[1], monthlyAmountMinor: 1 },
          pricing.hostedPlanTable.plans[2],
        ],
      },
    } as typeof pricing;
    expect(() => assertHostedPricingMatchesBilling(changedTable, billing)).toThrow(
      HostedPricingError,
    );

    const changedManifest = {
      ...pricing,
      stripeMonthlyReview: [{ ...pricing.stripeMonthlyReview[0], expectedAmountMinor: 2 }],
    } as typeof pricing;
    expect(() => assertHostedPricingMatchesBilling(changedManifest, billing)).toThrow(
      HostedPricingError,
    );
  });
});
