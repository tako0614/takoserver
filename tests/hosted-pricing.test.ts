import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseBillingConfig } from "../src/billing-config.ts";
import {
  assertHostedPricingMatchesBilling,
  compilePricingAuthoring,
  HostedPricingError,
  parseHostedPricing,
  parsePersistedHostedPricing,
} from "../src/hosted-pricing.ts";

function sharedAuthoring(sourcePath = "../config/shared-hosted-pricing.json") {
  const sharedPricing = JSON.parse(readFileSync(new URL(sourcePath, import.meta.url), "utf8"));
  sharedPricing.plans[0].stripePriceId = "price_final10";
  sharedPricing.plans[1].stripePriceId = "price_final50";
  const meters = Object.fromEntries(
    Object.entries(
      sharedPricing.meters as Record<
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
  return {
    authoringVersion: 2,
    sharedPricing,
    planIds: { free: "free", usage: "usage" },
    billingConfig: {
      schemaVersion: 1,
      revision: sharedPricing.revision,
      effectiveAt: "2026-10-14T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86400,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {
        "hosted-10": { includedMinor: 2000, stripePriceId: "price_final10" },
        "hosted-50": { includedMinor: 10000, stripePriceId: "price_final50" },
      },
      meters,
    },
    checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
  };
}

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
  test("pins the retained reviewed v2 source bytes to their original publication", () => {
    const bytes = readFileSync(
      new URL(
        "../config/shared-hosted-pricing-revisions/hosted-20261014-final-v1.json",
        import.meta.url,
      ),
    );
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "ada89b3dd815a9e2d24d166f99a64f47b74a249ead5ae884fb019952d8d1b31d",
    );
  });

  test("retains the published Container v1 bytes and original egress terms across the v2 correction", () => {
    const sourcePath =
      "../config/shared-hosted-pricing-revisions/hosted-20261015-container-proposed-v1.json";
    expect(
      createHash("sha256")
        .update(readFileSync(new URL(sourcePath, import.meta.url)))
        .digest("hex"),
    ).toBe("4fc49292e0a04c8656f57b9204b26e4bbdba23316b1ef74b907e0d3e1f3d4401");
    const original = sharedAuthoring(sourcePath);
    const bytes = JSON.stringify(original);
    const retained = parsePersistedHostedPricing(bytes, original.sharedPricing.revision);
    expect(retained?.environment.TAKOSERVER_HOSTED_PRICING).toBe(bytes);
    const historical = parseBillingConfig(retained?.environment.TAKOSERVER_BILLING_CONFIG);
    expect(historical?.revision).toBe("hosted-20261015-container-proposed-v1");
    expect(historical?.meters["container.egress"]).toEqual({
      unit: "GB",
      rate: { numeratorMicros: "150000", denominator: "1" },
    });
    const current = sharedAuthoring();
    const compiled = compilePricingAuthoring({
      ...current,
      billingConfig: {
        ...current.billingConfig,
        effectiveAt: "2026-10-15T00:00:00.000Z",
        history: [original.billingConfig],
      },
    });
    const tariff = parseBillingConfig(compiled.environment.TAKOSERVER_BILLING_CONFIG);
    expect(tariff?.revision).toBe("hosted-20261015-container-proposed-v2");
    expect(tariff?.meters["container.egress"]).toEqual({
      unit: "GB",
      rate: { numeratorMicros: "75000", denominator: "1" },
    });
    expect(tariff?.history?.[0]?.meters).toEqual(original.billingConfig.meters);
    expect(() => compilePricingAuthoring(original)).toThrow(/reviewed source/u);
    expect(() => parseHostedPricing(bytes)).toThrow(HostedPricingError);
    original.sharedPricing.meters["container.egress"].cloudflareCostMicros = "25000";
    const changed = original.billingConfig.meters["container.egress"];
    if (!changed) throw new Error("missing retained Container egress fixture");
    changed.rate.numeratorMicros = "75000";
    expect(() =>
      parsePersistedHostedPricing(JSON.stringify(original), original.sharedPricing.revision),
    ).toThrow(HostedPricingError);
  });

  test("rejects self-consistent v2 cash, allowance, identity, markup, meter, and warning drift", () => {
    const changedCash = sharedAuthoring();
    changedCash.sharedPricing.plans[0].monthlyPriceMicros = "1000000";
    expect(() => compilePricingAuthoring(changedCash)).toThrow(/reviewed source/u);
    expect(() => parseHostedPricing(JSON.stringify(changedCash))).toThrow(HostedPricingError);

    const changedAllowance = sharedAuthoring();
    changedAllowance.sharedPricing.plans[0].includedMicros = "21000000";
    changedAllowance.billingConfig.plans["hosted-10"].includedMinor = 2100;
    expect(() => compilePricingAuthoring(changedAllowance)).toThrow(/reviewed source/u);

    const changedFree = sharedAuthoring();
    changedFree.sharedPricing.freeIncludedMicros = "1000000";
    changedFree.billingConfig.freeIncludedMinor = 100;
    expect(() => compilePricingAuthoring(changedFree)).toThrow(/reviewed source/u);

    const changedId = sharedAuthoring();
    changedId.sharedPricing.plans[0].planId = "hosted-1";
    const plans = changedId.billingConfig.plans as Record<
      string,
      {
        includedMinor: number;
        stripePriceId: string;
      }
    >;
    plans["hosted-1"] = { includedMinor: 2000, stripePriceId: "price_final10" };
    delete plans["hosted-10"];
    expect(() => compilePricingAuthoring(changedId)).toThrow(/reviewed source/u);

    const changedMarkup = sharedAuthoring();
    changedMarkup.sharedPricing.markupMultiplier = 2;
    for (const meter of Object.values(changedMarkup.billingConfig.meters)) {
      meter.rate.numeratorMicros = ((BigInt(meter.rate.numeratorMicros) / 3n) * 2n).toString();
    }
    expect(() => compilePricingAuthoring(changedMarkup)).toThrow(/reviewed source/u);

    const changedMeter = sharedAuthoring();
    changedMeter.sharedPricing.meters["wfp.requests"].cloudflareCostMicros = "400000";
    const requestMeter = changedMeter.billingConfig.meters["wfp.requests"];
    if (!requestMeter) throw new Error("missing request meter fixture");
    requestMeter.rate.numeratorMicros = "1200000";
    expect(() => compilePricingAuthoring(changedMeter)).toThrow(/reviewed source/u);

    const changedWarning = sharedAuthoring();
    changedWarning.sharedPricing.warningBasisPoints = [7000, 9500];
    expect(() => compilePricingAuthoring(changedWarning)).toThrow(/reviewed source/u);
  });

  test("binds both finalized plans, exact 3x meters, and Free allowance to the tariff", () => {
    const authored = sharedAuthoring();
    const pricing = compilePricingAuthoring(authored);
    expect(pricing.kind).toBe("takoserver.pricing-preview@v2");
    expect(pricing.hostedPlanTable.plans.map((plan) => plan.planId)).toEqual([
      "free",
      "hosted-10",
      "hosted-50",
      "usage",
    ]);
    expect(
      pricing.stripeMonthlyReview.map((row) => [row.planKey, row.expectedAmountMinor]),
    ).toEqual([
      ["hosted-10", 1000],
      ["hosted-50", 5000],
    ]);
    expect(pricing.activation).toBe("stripe-test-price-verification-required");
    const billing = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
    expect(() => assertHostedPricingMatchesBilling(pricing, billing)).not.toThrow();
    authored.sharedPricing.plans[1].stripePriceId = null;
    expect(() => compilePricingAuthoring(authored)).toThrow(/requires a Stripe Price ID/u);
    expect(() => parseHostedPricing(JSON.stringify(authored))).toThrow(HostedPricingError);
    authored.sharedPricing.plans[1].stripePriceId = "price_final50";
    authored.billingConfig.plans["hosted-50"].includedMinor = 9900;
    expect(() => compilePricingAuthoring(authored)).toThrow(/plans disagree/u);
    authored.billingConfig.plans["hosted-50"].includedMinor = 10000;
    const requestMeter = authored.billingConfig.meters["wfp.requests"];
    if (!requestMeter) throw new Error("missing request meter fixture");
    requestMeter.rate.numeratorMicros = "1";
    expect(() => compilePricingAuthoring(authored)).toThrow(/meters disagree/u);
  });

  test("requires the reviewed Container units and exact rational rates at runtime", () => {
    const authored = sharedAuthoring();
    const pricing = compilePricingAuthoring(authored);
    const billing = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
    expect(billing?.meters["container.cpu"]).toEqual({
      unit: "vCPU-second",
      rate: { numeratorMicros: "60", denominator: "1" },
    });
    expect(billing?.meters["container.memory"]).toEqual({
      unit: "GiB-second",
      rate: { numeratorMicros: "7500", denominator: "1000" },
    });
    expect(billing?.meters["container.egress"]).toEqual({
      unit: "GB",
      rate: { numeratorMicros: "75000", denominator: "1" },
    });
    expect(billing?.meters["container.image-storage"]).toEqual({
      unit: "GB-month",
      rate: { numeratorMicros: "45000", denominator: "1" },
    });

    for (const key of [
      "container.cpu",
      "container.memory",
      "container.egress",
      "container.image-storage",
    ]) {
      const missing = sharedAuthoring();
      delete missing.billingConfig.meters[key];
      expect(() => compilePricingAuthoring(missing)).toThrow(/meters disagree/u);
    }

    for (const [field, value] of [
      ["unit", "GB-second"],
      ["numeratorMicros", "8"],
      ["denominator", "1"],
    ] as const) {
      const changed = sharedAuthoring();
      const memory = changed.billingConfig.meters["container.memory"];
      if (!memory) throw new Error("missing Container memory fixture");
      if (field === "unit") memory.unit = value;
      else memory.rate[field] = value;
      expect(() => compilePricingAuthoring(changed)).toThrow(/meters disagree/u);
    }
  });

  test("rejects self-consistent Container source drift rather than authorizing another tariff", () => {
    for (const field of ["cost", "quantity", "unit"] as const) {
      const changed = sharedAuthoring();
      const sourceMemory = changed.sharedPricing.meters["container.memory"];
      const runtimeMemory = changed.billingConfig.meters["container.memory"];
      if (!sourceMemory || !runtimeMemory) throw new Error("missing Container memory fixture");
      if (field === "cost") {
        sourceMemory.cloudflareCostMicros = "2600";
        runtimeMemory.rate.numeratorMicros = "7800";
      } else if (field === "quantity") {
        sourceMemory.quantity = "100";
        runtimeMemory.rate.denominator = "100";
      } else {
        sourceMemory.unit = "GB-second";
        runtimeMemory.unit = "GB-second";
      }
      expect(() => compilePricingAuthoring(changed)).toThrow(/reviewed source/u);
      expect(() => parseHostedPricing(JSON.stringify(changed))).toThrow(HostedPricingError);
    }
  });

  test("retains original meter tuples in a prior tariff when the Container revision is authored", () => {
    const authored = sharedAuthoring();
    const historical = {
      ...structuredClone(authored.billingConfig),
      revision: "hosted-20261014-final-v1",
      meters: Object.fromEntries(
        Object.entries(authored.billingConfig.meters).filter(
          ([key]) => !key.startsWith("container."),
        ),
      ),
    };
    const pricing = compilePricingAuthoring({
      ...authored,
      billingConfig: {
        ...authored.billingConfig,
        effectiveAt: "2026-10-15T00:00:00.000Z",
        history: [historical],
      },
    });
    const billing = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
    expect(billing?.revision).toBe("hosted-20261015-container-proposed-v2");
    expect(billing?.history?.[0]?.revision).toBe("hosted-20261014-final-v1");
    expect(billing?.history?.[0]?.meters).toEqual(historical.meters);
    expect(billing?.history?.[0]?.meters["container.memory"]).toBeUndefined();
    expect(billing?.history?.[0]?.meters["r2.storage"]).toEqual({
      unit: "GB-month",
      rate: { numeratorMicros: "45000", denominator: "1" },
    });
  });

  test("reads retained v2 invoice and phase terms after a new source publication without admitting the old source", () => {
    const old = sharedAuthoring(
      "../config/shared-hosted-pricing-revisions/hosted-20261014-final-v1.json",
    );
    old.sharedPricing.plans[0].stripePriceId = "price_retained10";
    old.billingConfig.plans["hosted-10"].stripePriceId = "price_retained10";
    const historical = {
      ...old,
      billingConfig: {
        ...old.billingConfig,
        holdTtlSeconds: 7200,
        purchaseCreditExpiry: { kind: "fixed-duration", seconds: 86400 },
      },
    };
    const originalBytes = JSON.stringify(historical);
    const current = compilePricingAuthoring(sharedAuthoring());
    expect(
      parseBillingConfig(current.environment.TAKOSERVER_BILLING_CONFIG)?.meters["container.memory"],
    ).toBeDefined();
    const retained = parsePersistedHostedPricing(originalBytes, "hosted-20261014-final-v1");
    expect(retained?.environment.TAKOSERVER_HOSTED_PRICING).toBe(originalBytes);
    expect(retained?.stripeMonthlyReview[0]).toEqual({
      planKey: "hosted-10",
      stripePriceId: "price_retained10",
      expectedAmountMinor: 1000,
      currency: "USD",
      interval: "month",
    });
    const tariff = parseBillingConfig(retained?.environment.TAKOSERVER_BILLING_CONFIG);
    expect(tariff?.plans["hosted-10"]).toEqual({
      includedMinor: 2000,
      stripePriceId: "price_retained10",
    });
    expect(tariff?.plans["hosted-50"]?.includedMinor).toBe(10000);
    expect(tariff?.meters["r2.storage"]).toEqual({
      unit: "GB-month",
      rate: { numeratorMicros: "45000", denominator: "1" },
    });
    expect(tariff?.meters["container.memory"]).toBeUndefined();
    expect(tariff?.holdTtlSeconds).toBe(7200);
    expect(tariff?.purchaseCreditExpiry).toEqual({ kind: "fixed-duration", seconds: 86400 });
    expect(() => compilePricingAuthoring(historical)).toThrow(/reviewed source/u);
    expect(() => parseHostedPricing(originalBytes)).toThrow(HostedPricingError);
    expect(() =>
      assertHostedPricingMatchesBilling(retained as NonNullable<typeof retained>, tariff),
    ).toThrow(HostedPricingError);
  });

  test("historical v2 reading rejects unknown revisions, transplanted terms and self-consistent price drift", () => {
    const sourcePath = "../config/shared-hosted-pricing-revisions/hosted-20261014-final-v1.json";
    const old = sharedAuthoring(sourcePath);
    const bytes = JSON.stringify(old);
    expect(() => parsePersistedHostedPricing(bytes, "other-revision")).toThrow(HostedPricingError);
    const unknown = sharedAuthoring(sourcePath);
    unknown.sharedPricing.revision = "unreviewed-r1";
    unknown.billingConfig.revision = "unreviewed-r1";
    expect(() => parsePersistedHostedPricing(JSON.stringify(unknown), "unreviewed-r1")).toThrow(
      HostedPricingError,
    );
    const transplant = sharedAuthoring(sourcePath);
    transplant.sharedPricing.revision = "hosted-20261015-container-proposed-v2";
    transplant.billingConfig.revision = transplant.sharedPricing.revision;
    expect(() =>
      parsePersistedHostedPricing(JSON.stringify(transplant), transplant.sharedPricing.revision),
    ).toThrow(HostedPricingError);
    const cash = sharedAuthoring(sourcePath);
    cash.sharedPricing.plans[0].monthlyPriceMicros = "1000000";
    expect(() =>
      parsePersistedHostedPricing(JSON.stringify(cash), cash.sharedPricing.revision),
    ).toThrow(HostedPricingError);
    const included = sharedAuthoring(sourcePath);
    included.sharedPricing.plans[0].includedMicros = "21000000";
    included.billingConfig.plans["hosted-10"].includedMinor = 2100;
    expect(() =>
      parsePersistedHostedPricing(JSON.stringify(included), included.sharedPricing.revision),
    ).toThrow(HostedPricingError);
    const meter = sharedAuthoring(sourcePath);
    meter.sharedPricing.meters["r2.storage"].cloudflareCostMicros = "16000";
    const runtimeMeter = meter.billingConfig.meters["r2.storage"];
    if (!runtimeMeter) throw new Error("missing retained meter fixture");
    runtimeMeter.rate.numeratorMicros = "48000";
    expect(() =>
      parsePersistedHostedPricing(JSON.stringify(meter), meter.sharedPricing.revision),
    ).toThrow(HostedPricingError);
  });

  test("persisted reader preserves strict legacy/current parsing and binds its expected revision", () => {
    const current = sharedAuthoring();
    const legacy = authoring();
    for (const authored of [current, legacy]) {
      const raw = JSON.stringify(authored);
      expect(parsePersistedHostedPricing(raw, authored.billingConfig.revision)).toEqual(
        parseHostedPricing(raw),
      );
      expect(() => parsePersistedHostedPricing(raw, "wrong-revision")).toThrow(HostedPricingError);
    }
    expect(parsePersistedHostedPricing(undefined, "absent")).toBeUndefined();
    expect(() =>
      parsePersistedHostedPricing('{"authoringVersion":2,"authoringVersion":2}', "absent"),
    ).toThrow(HostedPricingError);
  });

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
