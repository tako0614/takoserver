import { type BillingConfig, BillingConfigError, parseBillingConfig } from "./billing-config.ts";
import { canonicalJson } from "./json.ts";
import {
  PAYMENT_SETTING_VARIABLES,
  PaymentSettingsError,
  validatePaymentSettings,
} from "./payment-settings.ts";
import { parseStrictJson } from "./strict-json.ts";

export const PRICING_AUTHORING_MAX_BYTES = 1_048_576;
export const HOSTED_PRICING_MAX_BYTES = 262_144;

export interface PricingPreview {
  readonly kind: "takoserver.pricing-preview@v1";
  readonly validation: "host-billing-config-valid";
  readonly mode: "preview";
  readonly activation: "pending-unified-billing-runtime-alignment";
  readonly environment: Readonly<Record<string, string>>;
  readonly stripeMonthlyReview: readonly {
    readonly planKey: string;
    readonly stripePriceId: string;
    readonly expectedAmountMinor: number;
    readonly currency: "USD";
    readonly interval: "month";
  }[];
  readonly hostedPlanTable: {
    readonly scope: "hosted";
    readonly products: readonly ["takosumi-hosted", "takoserver"];
    readonly balanceScope: "organization";
    readonly plans: readonly [
      {
        readonly planId: string;
        readonly tier: "free";
        readonly resourceScope: "edge";
        readonly configuredMonthlyCreditMinor: number;
        readonly edgeAllowance: "pending-owner-runtime-policy";
      },
      {
        readonly planId: string;
        readonly tier: "subscription";
        readonly monthlyAmountMinor: number;
        readonly includedCreditMinor: number;
        readonly stripePriceId: string;
      },
      {
        readonly planId: string;
        readonly tier: "usage";
        readonly checkoutMinimumMinor: number;
        readonly checkoutMaximumMinor: number;
        readonly meters: Readonly<Record<string, unknown>>;
      },
    ];
    readonly consumptionOrder: readonly ["free", "subscription", "purchased", "postpaid"];
  };
}

export class PricingAuthoringError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PricingAuthoringError";
  }
}

export class HostedPricingError extends Error {
  constructor() {
    super("Invalid hosted pricing configuration");
    this.name = "HostedPricingError";
  }
}

/** Projects one shared hosted-plan table from operator-selected configuration. */
export function compilePricingAuthoring(input: unknown): PricingPreview {
  const root = objectAt(input, "$");
  exactKeys(
    root,
    ["authoringVersion", "billingConfig", "checkout", "planIds", "stripeMonthlyReview"],
    "$",
  );
  if (root.authoringVersion !== 1) fail("authoringVersion must be 1");
  rejectPlaceholders(root);

  const rawBillingConfig = objectAt(root.billingConfig, "billingConfig");
  let billingConfig: ReturnType<typeof parseBillingConfig>;
  try {
    billingConfig = parseBillingConfig(JSON.stringify(rawBillingConfig));
  } catch (error) {
    if (error instanceof BillingConfigError) {
      fail("billingConfig is invalid under Host billing configuration rules");
    }
    fail("billingConfig could not be validated by the Host billing configuration parser");
  }
  if (!billingConfig) fail("billingConfig is required");

  const planIds = parsePlanIds(root.planIds);
  const configuredPlanKeys = Object.keys(billingConfig.plans).sort();
  if (configuredPlanKeys.length !== 1 || configuredPlanKeys[0] !== planIds.subscription) {
    fail("billingConfig.plans must contain exactly the planIds.subscription key");
  }
  const subscriptionPlan = billingConfig.plans[planIds.subscription];
  if (!subscriptionPlan) fail("billingConfig.plans is missing planIds.subscription");

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
  exactKeys(review, [planIds.subscription], "stripeMonthlyReview");
  const row = objectAt(review[planIds.subscription], `stripeMonthlyReview.${planIds.subscription}`);
  exactKeys(
    row,
    ["expectedAmountMinor", "currency", "interval"],
    `stripeMonthlyReview.${planIds.subscription}`,
  );
  const expectedAmountMinor = safePositiveInteger(
    row.expectedAmountMinor,
    `stripeMonthlyReview.${planIds.subscription}.expectedAmountMinor`,
  );
  if (row.currency !== "USD") {
    fail(`stripeMonthlyReview.${planIds.subscription}.currency must be USD`);
  }
  if (row.interval !== "month") {
    fail(`stripeMonthlyReview.${planIds.subscription}.interval must be month`);
  }

  const canonicalBillingConfig = JSON.stringify(rawBillingConfig);
  const hostedConfiguration = JSON.stringify(root);
  if (new TextEncoder().encode(hostedConfiguration).byteLength > HOSTED_PRICING_MAX_BYTES)
    throw new PricingAuthoringError("Hosted pricing exceeds the runtime configuration limit");
  return {
    kind: "takoserver.pricing-preview@v1",
    validation: "host-billing-config-valid",
    mode: "preview",
    activation: "pending-unified-billing-runtime-alignment",
    environment: {
      TAKOSERVER_BILLING_CONFIG: canonicalBillingConfig,
      TAKOSERVER_HOSTED_PRICING: hostedConfiguration,
      [PAYMENT_SETTING_VARIABLES.checkoutMinimumMinor]: String(minimumMinor),
      [PAYMENT_SETTING_VARIABLES.checkoutMaximumMinor]: String(maximumMinor),
    },
    stripeMonthlyReview: [
      {
        planKey: planIds.subscription,
        stripePriceId: subscriptionPlan.stripePriceId,
        expectedAmountMinor,
        currency: "USD",
        interval: "month",
      },
    ],
    hostedPlanTable: {
      scope: "hosted",
      products: ["takosumi-hosted", "takoserver"],
      balanceScope: "organization",
      plans: [
        {
          planId: planIds.free,
          tier: "free",
          resourceScope: "edge",
          configuredMonthlyCreditMinor: billingConfig.freeIncludedMinor,
          edgeAllowance: "pending-owner-runtime-policy",
        },
        {
          planId: planIds.subscription,
          tier: "subscription",
          monthlyAmountMinor: expectedAmountMinor,
          includedCreditMinor: subscriptionPlan.includedMinor,
          stripePriceId: subscriptionPlan.stripePriceId,
        },
        {
          planId: planIds.usage,
          tier: "usage",
          checkoutMinimumMinor: minimumMinor,
          checkoutMaximumMinor: maximumMinor,
          meters: billingConfig.meters,
        },
      ],
      consumptionOrder: ["free", "subscription", "purchased", "postpaid"],
    },
  };
}

export type HostedPricing = ReturnType<typeof compilePricingAuthoring>;

/** Parses an enabled shared hosted-pricing policy from its bounded environment value. */
export function parseHostedPricing(raw?: string): HostedPricing | undefined {
  if (raw === undefined) return undefined;
  try {
    const parsed = parseStrictJson(new TextEncoder().encode(raw), HOSTED_PRICING_MAX_BYTES);
    return compilePricingAuthoring(parsed);
  } catch {
    throw new HostedPricingError();
  }
}

/** Ensures the preview table, embedded billing tariff, and runtime tariff still agree. */
export function assertHostedPricingMatchesBilling(
  pricing: HostedPricing,
  billing: BillingConfig | undefined,
): void {
  try {
    if (!billing) throw new HostedPricingError();
    const parsed = parseHostedPricing(pricing.environment.TAKOSERVER_HOSTED_PRICING);
    if (!parsed || canonicalJson(pricing) !== canonicalJson(parsed)) {
      throw new HostedPricingError();
    }
    const authoredBilling = parseBillingConfig(parsed.environment.TAKOSERVER_BILLING_CONFIG);
    const activeBilling = parseBillingConfig(JSON.stringify(billing));
    if (
      !authoredBilling ||
      !activeBilling ||
      canonicalJson(authoredBilling) !== canonicalJson(activeBilling)
    ) {
      throw new HostedPricingError();
    }
  } catch {
    throw new HostedPricingError();
  }
}

function parsePlanIds(value: unknown): { free: string; subscription: string; usage: string } {
  const ids = objectAt(value, "planIds");
  exactKeys(ids, ["free", "subscription", "usage"], "planIds");
  const values = [ids.free, ids.subscription, ids.usage];
  for (const id of values) {
    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(id)) {
      fail("planIds values must be valid lowercase plan IDs");
    }
  }
  if (new Set(values).size !== values.length) fail("planIds values must be unique");
  return {
    free: ids.free as string,
    subscription: ids.subscription as string,
    usage: ids.usage as string,
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
