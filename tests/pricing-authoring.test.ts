import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compilePricingAuthoring, PricingAuthoringError } from "../scripts/pricing/compile.ts";

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
      plans: {
        starter: {
          includedMinor: 1200,
          stripePriceId: "price_month123",
        },
      },
      meters: {
        "takosumi.storage.byte-hours": {
          unit: "byte-hour",
          rate: { numeratorMicros: "1", denominator: "1000" },
        },
      },
      history: [
        {
          schemaVersion: 1,
          revision: "candidate-r2",
          effectiveAt: "2026-10-12T00:00:00.000Z",
          currency: "USD",
          holdTtlSeconds: 86_400,
          freeIncludedMinor: 200,
          purchaseCreditExpiry: { kind: "none" },
          plans: {},
          meters: {},
        },
      ],
    },
    checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
    stripeMonthlyReview: {
      starter: { expectedAmountMinor: 125, currency: "USD", interval: "month" },
    },
  };
}

describe("pricing authoring preview", () => {
  test("projects replaceable values and preserves canonical tariff history verbatim", () => {
    const first = authoring();
    delete (first.billingConfig as Partial<typeof first.billingConfig>).holdTtlSeconds;
    const output = compilePricingAuthoring(first);
    expect(output.kind).toBe("takoserver.pricing-preview@v1");
    expect(output.mode).toBe("preview");
    expect(output.validation).toBe("host-billing-config-valid");
    expect(output.activation).toBe("pending-unified-billing-runtime-alignment");
    expect(JSON.parse(output.environment.TAKOSERVER_BILLING_CONFIG ?? "null")).toEqual(
      first.billingConfig,
    );
    expect(
      JSON.parse(output.environment.TAKOSERVER_BILLING_CONFIG ?? "null").holdTtlSeconds,
    ).toBeUndefined();
    expect(output.stripeMonthlyReview).toEqual([
      {
        planKey: "starter",
        stripePriceId: "price_month123",
        expectedAmountMinor: 125,
        currency: "USD",
        interval: "month",
      },
    ]);

    const changed = authoring();
    changed.billingConfig.plans.starter.includedMinor = 9900;
    changed.billingConfig.freeIncludedMinor = 499;
    changed.stripeMonthlyReview.starter.expectedAmountMinor = 499;
    const changedOutput = compilePricingAuthoring(changed);
    expect(changedOutput.environment.TAKOSERVER_BILLING_CONFIG).not.toBe(
      output.environment.TAKOSERVER_BILLING_CONFIG,
    );
    expect(changedOutput.stripeMonthlyReview[0]?.expectedAmountMinor).toBe(499);
    expect(
      JSON.parse(changedOutput.environment.TAKOSERVER_BILLING_CONFIG ?? "null").history,
    ).toEqual(first.billingConfig.history);
    expect(
      JSON.parse(changedOutput.environment.TAKOSERVER_BILLING_CONFIG ?? "null").meters,
    ).toEqual(first.billingConfig.meters);

    const table = output.hostedPlanTable;
    expect(table).toEqual({
      scope: "hosted",
      products: ["takosumi-hosted", "takoserver"],
      balanceScope: "organization",
      plans: [
        {
          planId: "free",
          tier: "free",
          resourceScope: "edge",
          configuredMonthlyCreditMinor: 300,
          edgeAllowance: "pending-owner-runtime-policy",
        },
        {
          planId: "starter",
          tier: "subscription",
          monthlyAmountMinor: 125,
          includedCreditMinor: 1200,
          stripePriceId: "price_month123",
        },
        {
          planId: "usage",
          tier: "usage",
          checkoutMinimumMinor: 50,
          checkoutMaximumMinor: 99_999_999,
          meters: first.billingConfig.meters,
        },
      ],
      consumptionOrder: ["free", "subscription", "purchased", "postpaid"],
    });
    expect(table.products).toEqual(["takosumi-hosted", "takoserver"]);

    const renamed = authoring();
    renamed.planIds = { free: "basic", subscription: "team-monthly", usage: "metered" };
    renamed.billingConfig.plans = {
      "team-monthly": { includedMinor: 1200, stripePriceId: "price_month123" },
    } as unknown as typeof renamed.billingConfig.plans;
    renamed.stripeMonthlyReview = {
      "team-monthly": { expectedAmountMinor: 300, currency: "USD", interval: "month" },
    } as unknown as typeof renamed.stripeMonthlyReview;
    const renamedOutput = compilePricingAuthoring(renamed);
    expect(renamedOutput.hostedPlanTable.plans.map((plan) => plan.planId)).toEqual([
      "basic",
      "team-monthly",
      "metered",
    ]);
    expect(renamedOutput.hostedPlanTable.plans[1]).toMatchObject({ monthlyAmountMinor: 300 });

    const expiryChanged = authoring();
    (expiryChanged.billingConfig as Record<string, unknown>).purchaseCreditExpiry = {
      kind: "fixed-duration",
      seconds: 7200,
    };
    expect(compilePricingAuthoring(expiryChanged).hostedPlanTable.consumptionOrder).toEqual(
      table.consumptionOrder,
    );
  });

  test("requires exact input, plan and review fields and explicit safe amounts", () => {
    const unknown = authoring() as ReturnType<typeof authoring> & Record<string, unknown>;
    unknown.extra = true;
    expect(() => compilePricingAuthoring(unknown)).toThrow(PricingAuthoringError);

    const unknownOrder = authoring() as ReturnType<typeof authoring> & Record<string, unknown>;
    unknownOrder.consumptionOrder = ["subscription", "free"];
    expect(() => compilePricingAuthoring(unknownOrder)).toThrow("unknown field");

    const missingIds = authoring();
    delete (missingIds as unknown as Record<string, unknown>).planIds;
    expect(() => compilePricingAuthoring(missingIds)).toThrow("planIds is required");

    for (const planIds of [
      { free: "free", subscription: "starter", usage: "starter" },
      { free: "bad ID", subscription: "starter", usage: "usage" },
    ]) {
      const invalidIds = authoring();
      invalidIds.planIds = planIds;
      expect(() => compilePricingAuthoring(invalidIds)).toThrow("planIds");
    }

    const mismatchedPlanId = authoring();
    mismatchedPlanId.planIds.subscription = "different";
    expect(() => compilePricingAuthoring(mismatchedPlanId)).toThrow(
      "billingConfig.plans must contain exactly the planIds.subscription key",
    );

    const missingBound = authoring();
    delete (missingBound.checkout as Partial<typeof missingBound.checkout>).maximumMinor;
    expect(() => compilePricingAuthoring(missingBound)).toThrow(
      "checkout.maximumMinor is required",
    );

    const mismatchedReview = authoring();
    delete (
      mismatchedReview.stripeMonthlyReview as Partial<typeof mismatchedReview.stripeMonthlyReview>
    ).starter;
    expect(() => compilePricingAuthoring(mismatchedReview)).toThrow(
      "stripeMonthlyReview.starter is required",
    );

    const invalidPlan = authoring();
    invalidPlan.billingConfig.plans.starter.includedMinor = Number.MAX_SAFE_INTEGER + 1;
    expect(() => compilePricingAuthoring(invalidPlan)).toThrow(
      "billingConfig is invalid under Host billing configuration rules",
    );

    const freeOnly = authoring();
    freeOnly.billingConfig.plans = {} as typeof freeOnly.billingConfig.plans;
    freeOnly.stripeMonthlyReview = {} as typeof freeOnly.stripeMonthlyReview;
    expect(() => compilePricingAuthoring(freeOnly)).toThrow("planIds.subscription key");
  });

  test("validates root free credit, plan credit and monthly review amounts independently", () => {
    const missingFree = authoring();
    delete (missingFree.billingConfig as Partial<typeof missingFree.billingConfig>)
      .freeIncludedMinor;
    expect(() => compilePricingAuthoring(missingFree)).toThrow(
      "billingConfig is invalid under Host billing configuration rules",
    );

    const missingPlanAmount = authoring();
    delete (
      missingPlanAmount.billingConfig.plans.starter as Partial<
        typeof missingPlanAmount.billingConfig.plans.starter
      >
    ).includedMinor;
    expect(() => compilePricingAuthoring(missingPlanAmount)).toThrow(
      "billingConfig is invalid under Host billing configuration rules",
    );

    for (const amount of [-1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const free = authoring();
      free.billingConfig.freeIncludedMinor = amount;
      expect(() => compilePricingAuthoring(free)).toThrow(
        "billingConfig is invalid under Host billing configuration rules",
      );
      const included = authoring();
      included.billingConfig.plans.starter.includedMinor = amount;
      expect(() => compilePricingAuthoring(included)).toThrow(
        "billingConfig is invalid under Host billing configuration rules",
      );
    }

    const oneMinorUnitPrice = authoring();
    oneMinorUnitPrice.stripeMonthlyReview.starter.expectedAmountMinor = 1;
    expect(
      compilePricingAuthoring(oneMinorUnitPrice).stripeMonthlyReview[0]?.expectedAmountMinor,
    ).toBe(1);

    for (const amount of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      const review = authoring();
      review.stripeMonthlyReview.starter.expectedAmountMinor = amount;
      expect(() => compilePricingAuthoring(review)).toThrow(
        "expectedAmountMinor must be a positive safe integer",
      );
    }
  });

  test("rejects unsupported checkout values, malformed Stripe IDs and unresolved placeholders", () => {
    const invalidCheckout = authoring();
    invalidCheckout.checkout.minimumMinor = 49;
    expect(() => compilePricingAuthoring(invalidCheckout)).toThrow(
      "outside supported payment bounds",
    );

    const invertedCheckout = authoring();
    invertedCheckout.checkout.minimumMinor = 100;
    invertedCheckout.checkout.maximumMinor = 50;
    expect(() => compilePricingAuthoring(invertedCheckout)).toThrow(
      "outside supported payment bounds",
    );

    const excessiveCheckout = authoring();
    excessiveCheckout.checkout.maximumMinor = 100_000_000;
    expect(() => compilePricingAuthoring(excessiveCheckout)).toThrow(
      "outside supported payment bounds",
    );

    const invalidPrice = authoring();
    invalidPrice.billingConfig.plans.starter.stripePriceId = "price_looks-valid-but-has-dash";
    expect(() => compilePricingAuthoring(invalidPrice)).toThrow(
      "billingConfig is invalid under Host billing configuration rules",
    );

    const placeholder = authoring();
    placeholder.billingConfig.meters["takosumi.storage.byte-hours"].unit = "REPLACE_ME";
    expect(() => compilePricingAuthoring(placeholder)).toThrow(
      "unresolved replacement placeholder",
    );

    const unresolved = authoring();
    unresolved.billingConfig.history[0] = null as never;
    expect(() => compilePricingAuthoring(unresolved)).toThrow("unresolved null placeholder");

    const extraReview = authoring();
    (extraReview.stripeMonthlyReview as Record<string, unknown>).unexpected = {
      expectedAmountMinor: 1,
      currency: "USD",
      interval: "month",
    };
    expect(() => compilePricingAuthoring(extraReview)).toThrow("unknown field");

    const unknownReviewField = authoring();
    (unknownReviewField.stripeMonthlyReview.starter as Record<string, unknown>).comment =
      "reviewed";
    expect(() => compilePricingAuthoring(unknownReviewField)).toThrow("unknown field");

    const wrongReviewCurrency = authoring();
    wrongReviewCurrency.stripeMonthlyReview.starter.currency = "eur" as "USD";
    expect(() => compilePricingAuthoring(wrongReviewCurrency)).toThrow("currency must be USD");

    const wrongReviewInterval = authoring();
    wrongReviewInterval.stripeMonthlyReview.starter.interval = "year" as "month";
    expect(() => compilePricingAuthoring(wrongReviewInterval)).toThrow("interval must be month");
  });

  test("delegates tariff schema and historical validation to the Host parser safely", () => {
    const unknownBillingField = authoring();
    (unknownBillingField.billingConfig as Record<string, unknown>).BAD_SECRET_FIELD = "value";
    expect(() => compilePricingAuthoring(unknownBillingField)).toThrow(
      "billingConfig is invalid under Host billing configuration rules",
    );

    const invalidHistory = authoring();
    const invalidSnapshot = invalidHistory.billingConfig.history[0];
    if (!invalidSnapshot) throw new Error("test fixture must include a history snapshot");
    invalidSnapshot.effectiveAt = "2026-10-13T00:00:00.000Z";
    expect(() => compilePricingAuthoring(invalidHistory)).toThrow(
      "billingConfig is invalid under Host billing configuration rules",
    );
  });

  test("CLI emits JSON on success and no output or input contents on rejected files", async () => {
    const directory = await mkdtemp(join(tmpdir(), "pricing-authoring-"));
    try {
      const validPath = join(directory, "valid.json");
      await writeFile(validPath, JSON.stringify(authoring()));
      const success = spawnSync(
        process.execPath,
        ["--no-env-file", "scripts/pricing/preview.ts", validPath],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );
      expect(success.status).toBe(0);
      expect(JSON.parse(success.stdout)).toEqual(compilePricingAuthoring(authoring()));

      const invalidPath = join(directory, "invalid.json");
      const malformedWithSecret =
        '{"authoringVersion":1,"secret":"DO_NOT_LEAK","authoringVersion":1}';
      await writeFile(invalidPath, malformedWithSecret);
      const failure = spawnSync(
        process.execPath,
        ["--no-env-file", "scripts/pricing/preview.ts", invalidPath],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );
      expect(failure.status).toBe(1);
      expect(failure.stdout).toBe("");
      expect(failure.stderr).toContain("valid UTF-8 JSON");
      expect(failure.stderr).not.toContain("DO_NOT_LEAK");

      const rawParserKeyPath = join(directory, "raw-parser-key.json");
      const invalidMeterKey = authoring();
      invalidMeterKey.billingConfig.meters = {
        SECRET_KEY_PATH: {
          unit: "byte-hour",
          rate: { numeratorMicros: "1", denominator: "1000" },
        },
      } as unknown as typeof invalidMeterKey.billingConfig.meters;
      await writeFile(rawParserKeyPath, JSON.stringify(invalidMeterKey));
      const rawParserKey = spawnSync(
        process.execPath,
        ["--no-env-file", "scripts/pricing/preview.ts", rawParserKeyPath],
        { cwd: process.cwd(), encoding: "utf8" },
      );
      expect(rawParserKey.status).toBe(1);
      expect(rawParserKey.stdout).toBe("");
      expect(rawParserKey.stderr).toContain(
        "billingConfig is invalid under Host billing configuration rules",
      );
      expect(rawParserKey.stderr).not.toContain("SECRET_KEY_PATH");

      const invalidUtf8Path = join(directory, "invalid-utf8.json");
      await writeFile(invalidUtf8Path, new Uint8Array([0xff, 0xfe]));
      const invalidUtf8 = spawnSync(
        process.execPath,
        ["--no-env-file", "scripts/pricing/preview.ts", invalidUtf8Path],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );
      expect(invalidUtf8.status).toBe(1);
      expect(invalidUtf8.stdout).toBe("");
      expect(invalidUtf8.stderr).toContain("valid UTF-8 JSON");

      const placeholderPath = join(directory, "placeholder.json");
      await writeFile(placeholderPath, await readFile("examples/pricing.placeholder.json"));
      const placeholder = spawnSync(
        process.execPath,
        ["--no-env-file", "scripts/pricing/preview.ts", placeholderPath],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );
      expect(placeholder.status).toBe(1);
      expect(placeholder.stdout).toBe("");
      expect(placeholder.stderr).toContain("unresolved");

      const oversizedPath = join(directory, "oversized.json");
      await writeFile(oversizedPath, new Uint8Array(1_048_577));
      const oversized = spawnSync(
        process.execPath,
        ["--no-env-file", "scripts/pricing/preview.ts", oversizedPath],
        {
          cwd: process.cwd(),
          encoding: "utf8",
        },
      );
      expect(oversized.status).toBe(1);
      expect(oversized.stdout).toBe("");
      expect(oversized.stderr).toContain("1048576-byte limit");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
