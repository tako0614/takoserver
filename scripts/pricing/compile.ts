import {
  PAYMENT_SETTING_VARIABLES,
  PaymentSettingsError,
  validatePaymentSettings,
} from "../../src/payment-settings.ts";

export const PRICING_AUTHORING_MAX_BYTES = 1_048_576;

export interface PricingPreview {
  readonly kind: "takoserver.pricing-preview@v1";
  readonly validation: "requires-host-billing-config-validation";
  readonly mode: "preview";
  readonly environment: Readonly<Record<string, string>>;
  readonly stripeMonthlyReview: readonly {
    readonly planKey: string;
    readonly stripePriceId: string;
    readonly expectedAmountMinor: number;
    readonly currency: "USD";
    readonly interval: "month";
  }[];
}

export class PricingAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingAuthoringError";
  }
}

/**
 * Projects an authoring document without interpreting the Host's tariff policy.
 * billingConfig is carried through unchanged as a JSON value; the
 * Host billing-config validator remains the authority for its meaning.
 */
export function compilePricingAuthoring(input: unknown): PricingPreview {
  const root = objectAt(input, "$");
  exactKeys(root, ["authoringVersion", "billingConfig", "checkout", "stripeMonthlyReview"], "$");
  if (root.authoringVersion !== 1) fail("authoringVersion must be 1");

  rejectPlaceholders(root);

  const billingConfig = objectAt(root.billingConfig, "billingConfig");
  if (billingConfig.currency !== "USD") fail("billingConfig.currency must be USD");
  if (!Object.hasOwn(billingConfig, "freeIncludedMinor")) {
    fail("billingConfig.freeIncludedMinor is required");
  }
  safeNonnegativeInteger(billingConfig.freeIncludedMinor, "billingConfig.freeIncludedMinor");
  const plans = objectAt(billingConfig.plans, "billingConfig.plans");
  const planEntries = Object.entries(plans);
  for (const [planKey, rawPlan] of planEntries) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(planKey))
      fail("billingConfig.plans contains an invalid plan key");
    const planPath = `billingConfig.plans.${planKey}`;
    const plan = objectAt(rawPlan, planPath);
    exactKeys(plan, ["includedMinor", "stripePriceId"], planPath);
    safeNonnegativeInteger(plan.includedMinor, `billingConfig.plans.${planKey}.includedMinor`);
    if (
      typeof plan.stripePriceId !== "string" ||
      !/^price_[A-Za-z0-9]+$/u.test(plan.stripePriceId)
    ) {
      fail(`billingConfig.plans.${planKey}.stripePriceId must be a Stripe price ID`);
    }
  }

  const checkout = objectAt(root.checkout, "checkout");
  exactKeys(checkout, ["minimumMinor", "maximumMinor"], "checkout");
  const minimumMinor = safePositiveInteger(checkout.minimumMinor, "checkout.minimumMinor");
  const maximumMinor = safePositiveInteger(checkout.maximumMinor, "checkout.maximumMinor");
  try {
    validatePaymentSettings({
      checkoutMinimumMinor: minimumMinor,
      checkoutMaximumMinor: maximumMinor,
    });
  } catch (error) {
    if (error instanceof PaymentSettingsError) {
      fail(
        `checkout.${error.setting === "checkoutMinimumMinor" ? "minimumMinor" : "maximumMinor"} is outside supported payment bounds or the range is inverted`,
      );
    }
    throw error;
  }

  const review = objectAt(root.stripeMonthlyReview, "stripeMonthlyReview");
  const reviewKeys = Object.keys(review).sort();
  const planKeys = planEntries.map(([key]) => key).sort();
  if (JSON.stringify(reviewKeys) !== JSON.stringify(planKeys)) {
    fail("stripeMonthlyReview must contain exactly one row for every billingConfig.plans key");
  }
  const stripeMonthlyReview = planEntries.map(([planKey, rawPlan]) => {
    const row = objectAt(review[planKey], `stripeMonthlyReview.${planKey}`);
    exactKeys(
      row,
      ["expectedAmountMinor", "currency", "interval"],
      `stripeMonthlyReview.${planKey}`,
    );
    const expectedAmountMinor = safePositiveInteger(
      row.expectedAmountMinor,
      `stripeMonthlyReview.${planKey}.expectedAmountMinor`,
    );
    if (row.currency !== "USD") fail(`stripeMonthlyReview.${planKey}.currency must be USD`);
    if (row.interval !== "month") fail(`stripeMonthlyReview.${planKey}.interval must be month`);
    return {
      planKey,
      stripePriceId: (rawPlan as Record<string, unknown>).stripePriceId as string,
      expectedAmountMinor,
      currency: "USD" as const,
      interval: "month" as const,
    };
  });

  const canonicalBillingConfig = JSON.stringify(root.billingConfig);
  return {
    kind: "takoserver.pricing-preview@v1",
    validation: "requires-host-billing-config-validation",
    mode: "preview",
    environment: {
      TAKOSERVER_BILLING_CONFIG: canonicalBillingConfig,
      [PAYMENT_SETTING_VARIABLES.checkoutMinimumMinor]: String(minimumMinor),
      [PAYMENT_SETTING_VARIABLES.checkoutMaximumMinor]: String(maximumMinor),
    },
    stripeMonthlyReview,
  };
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${path} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  path: string,
): void {
  const expectedSet = new Set(expected);
  for (const key of Object.keys(value)) {
    if (!expectedSet.has(key)) fail(`${path} contains an unknown field`);
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) fail(`${path}.${key} is required`);
  }
}

function safeNonnegativeInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail(`${path} must be a nonnegative safe integer`);
  }
  return value as number;
}

function safePositiveInteger(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) {
    fail(`${path} must be a positive safe integer`);
  }
  return value as number;
}

function rejectPlaceholders(value: unknown): void {
  if (value === null) fail("Input contains an unresolved null placeholder");
  if (typeof value === "string" && /replace[\s_-]*me/iu.test(value)) {
    fail("Input contains an unresolved replacement placeholder");
  }
  if (Array.isArray(value)) {
    value.forEach(rejectPlaceholders);
  } else if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) rejectPlaceholders(entry);
  }
}

function fail(message: string): never {
  throw new PricingAuthoringError(message);
}
