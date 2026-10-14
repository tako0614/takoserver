import { describe, expect, test } from "bun:test";
import type { HostedPricing } from "../src/hosted-pricing.ts";
import {
  configuredSubscriptionPlanByKey,
  configuredSubscriptionPlanByPrice,
} from "../src/stripe-billing.ts";

type Plan = HostedPricing["hostedPlanTable"]["plans"][number];
type PaidPlan = Extract<Plan, { readonly tier: "subscription" }>;

const basic: PaidPlan = {
  tier: "subscription",
  planId: "hosted-10",
  monthlyAmountMinor: 1000,
  includedCreditMinor: 2000,
  stripePriceId: "price_basic",
};
const pro: PaidPlan = {
  tier: "subscription",
  planId: "hosted-50",
  monthlyAmountMinor: 5000,
  includedCreditMinor: 10000,
  stripePriceId: "price_pro",
};
const free: Plan = {
  tier: "free",
  planId: "free",
  resourceScope: "edge",
  configuredMonthlyCreditMinor: 150,
  edgeAllowance: "pending-owner-runtime-policy",
};
const usage: Plan = {
  tier: "usage",
  planId: "usage",
  checkoutMinimumMinor: 50,
  checkoutMaximumMinor: 99999999,
  meters: {},
};

describe("configured subscription identities", () => {
  test("each paid identity retains its own cash price and included credit after reordering", () => {
    for (const plans of [
      [free, basic, pro, usage],
      [usage, pro, free, basic],
    ]) {
      expect(configuredSubscriptionPlanByKey(plans, "hosted-10")).toEqual(basic);
      expect(configuredSubscriptionPlanByKey(plans, "hosted-50")).toEqual(pro);
      expect(configuredSubscriptionPlanByPrice(plans, "price_basic")).toEqual(basic);
      expect(configuredSubscriptionPlanByPrice(plans, "price_pro")).toEqual(pro);
    }
  });

  test("free, usage, unknown and non-string identities cannot select a paid plan", () => {
    const plans = [free, basic, pro, usage];
    for (const key of ["free", "usage", "missing", null, 1, { id: "hosted-50" }]) {
      expect(configuredSubscriptionPlanByKey(plans, key)).toBeUndefined();
    }
    for (const id of ["price_missing", null, 1, { id: "price_pro" }]) {
      expect(configuredSubscriptionPlanByPrice(plans, id)).toBeUndefined();
    }
  });

  test("an ambiguous plan identity does not silently choose the first row", () => {
    const duplicate = { ...pro, planId: basic.planId };
    expect(configuredSubscriptionPlanByKey([basic, duplicate], basic.planId)).toBeUndefined();
    expect(
      configuredSubscriptionPlanByKey([basic, { ...free, planId: basic.planId }], basic.planId),
    ).toBeUndefined();
  });

  test("an ambiguous Stripe Price cannot select a consideration or grant", () => {
    const duplicate = { ...pro, stripePriceId: basic.stripePriceId };
    expect(
      configuredSubscriptionPlanByPrice([basic, duplicate], basic.stripePriceId),
    ).toBeUndefined();
  });

  test("a nonpaid row cannot make an injected Price authoritative", () => {
    const injected = { ...free, stripePriceId: pro.stripePriceId };
    expect(configuredSubscriptionPlanByPrice([injected], pro.stripePriceId)).toBeUndefined();
  });

  test("a paid invoice's historical table keeps its old Price and entitlement", () => {
    const historical = {
      ...basic,
      stripePriceId: "price_oldbasic",
      includedCreditMinor: 1200,
    };
    const originalSnapshot = [free, historical, usage];
    const currentSnapshot = [free, pro, basic, usage];
    expect(configuredSubscriptionPlanByKey(originalSnapshot, basic.planId)).toEqual(historical);
    expect(configuredSubscriptionPlanByPrice(originalSnapshot, historical.stripePriceId)).toEqual(
      historical,
    );
    expect(
      configuredSubscriptionPlanByPrice(currentSnapshot, historical.stripePriceId),
    ).toBeUndefined();
    expect(configuredSubscriptionPlanByKey(currentSnapshot, basic.planId)).toEqual(basic);
  });
});
