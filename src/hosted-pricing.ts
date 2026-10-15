import committedSharedHostedPricing from "../config/shared-hosted-pricing.json" with {
  type: "json",
};
import retainedSharedHostedPricingV1 from "../config/shared-hosted-pricing-revisions/hosted-20261014-final-v1.json" with {
  type: "json",
};
import { type BillingConfig, BillingConfigError, parseBillingConfig } from "./billing-config.ts";
import { canonicalJson } from "./json.ts";
import { MoneyError, minorToMicros } from "./money.ts";
import {
  PAYMENT_SETTING_VARIABLES,
  PaymentSettingsError,
  validatePaymentSettings,
} from "./payment-settings.ts";
import { parseSharedHostedPricing, SharedHostedPricingError } from "./shared-hosted-pricing.ts";
import { parseStrictJson } from "./strict-json.ts";

const committedSharedPricing = parseSharedHostedPricing(committedSharedHostedPricing);
const committedSharedTerms = sharedTermsWithoutStripeIds(committedSharedPricing);
const retainedSharedTerms = new Map<string, string>();
for (const source of [retainedSharedHostedPricingV1, committedSharedHostedPricing]) {
  const reviewed = parseSharedHostedPricing(source);
  if (
    reviewed.plans.some((plan) => plan.stripePriceId !== null) ||
    retainedSharedTerms.has(reviewed.revision)
  )
    throw new Error("Reviewed pricing revision registry is invalid");
  retainedSharedTerms.set(reviewed.revision, sharedTermsWithoutStripeIds(reviewed));
}

function sharedTermsWithoutStripeIds(pricing: ReturnType<typeof parseSharedHostedPricing>): string {
  return canonicalJson({
    ...pricing,
    plans: pricing.plans.map((plan) => {
      const terms: Record<string, unknown> = { ...plan };
      delete terms.stripePriceId;
      return terms;
    }),
  });
}

export const PRICING_AUTHORING_MAX_BYTES = 1_048_576;
export const HOSTED_PRICING_MAX_BYTES = 262_144;

export interface PricingPreview {
  readonly kind: "takoserver.pricing-preview@v1" | "takoserver.pricing-preview@v2";
  readonly validation: "host-billing-config-valid";
  readonly mode: "preview";
  readonly activation:
    | "pending-unified-billing-runtime-alignment"
    | "stripe-test-price-verification-required";
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
    readonly plans: readonly (
      | {
          readonly planId: string;
          readonly tier: "free";
          readonly resourceScope: "edge";
          readonly configuredMonthlyCreditMinor: number;
          readonly edgeAllowance: "pending-owner-runtime-policy";
        }
      | {
          readonly planId: string;
          readonly tier: "subscription";
          readonly monthlyAmountMinor: number;
          readonly includedCreditMinor: number;
          readonly stripePriceId: string;
        }
      | {
          readonly planId: string;
          readonly tier: "usage";
          readonly checkoutMinimumMinor: number;
          readonly checkoutMaximumMinor: number;
          readonly meters: Readonly<Record<string, unknown>>;
        }
    )[];
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
  if (root.authoringVersion === 2) return compileSharedRuntimePricing(root);
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
  try {
    for (const snapshot of [billingConfig, ...(billingConfig.history ?? [])]) {
      minorToMicros(snapshot.freeIncludedMinor);
      for (const plan of Object.values(snapshot.plans)) minorToMicros(plan.includedMinor);
    }
  } catch (error) {
    if (error instanceof MoneyError)
      fail("billingConfig grant amounts must fit the USD-micros ledger");
    throw error;
  }

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
  try {
    minorToMicros(expectedAmountMinor);
  } catch (error) {
    if (error instanceof MoneyError) fail("monthly consideration must fit the USD-micros ledger");
    throw error;
  }
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

/** Binds the final shared USD source to a strict two-plan Host tariff. */
function compileSharedRuntimePricing(
  root: Record<string, unknown>,
  reviewedTerms = committedSharedTerms,
): PricingPreview {
  exactKeys(
    root,
    ["authoringVersion", "sharedPricing", "billingConfig", "checkout", "planIds"],
    "$",
  );
  let shared: ReturnType<typeof parseSharedHostedPricing>;
  try {
    shared = parseSharedHostedPricing(root.sharedPricing);
  } catch (error) {
    if (error instanceof SharedHostedPricingError) fail("sharedPricing is invalid");
    throw error;
  }
  if (
    committedSharedPricing.plans.some((plan) => plan.stripePriceId !== null) ||
    sharedTermsWithoutStripeIds(shared) !== reviewedTerms
  )
    fail("sharedPricing differs from the reviewed source");
  const plans = shared.plans.map((plan) => {
    if (plan.stripePriceId === null)
      fail(`sharedPricing plan ${plan.planId} requires a Stripe Price ID`);
    if (/replace[\s_-]*me/iu.test(plan.stripePriceId))
      fail("sharedPricing contains an unresolved Stripe Price placeholder");
    const monthlyAmountMinor = microsToMinor(plan.monthlyPriceMicros, "monthly price");
    const includedCreditMinor = microsToMinor(plan.includedMicros, "included allowance");
    return { ...plan, stripePriceId: plan.stripePriceId, monthlyAmountMinor, includedCreditMinor };
  });
  const ids = objectAt(root.planIds, "planIds");
  exactKeys(ids, ["free", "usage"], "planIds");
  for (const id of [ids.free, ids.usage]) {
    if (typeof id !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/u.test(id))
      fail("planIds values must be valid lowercase plan IDs");
  }
  if (new Set([ids.free, ids.usage, ...plans.map((plan) => plan.planId)]).size !== 4)
    fail("planIds values must be unique");
  const rawBillingConfig = objectAt(root.billingConfig, "billingConfig");
  let billing: BillingConfig | undefined;
  try {
    billing = parseBillingConfig(JSON.stringify(rawBillingConfig));
  } catch (error) {
    if (error instanceof BillingConfigError)
      fail("billingConfig is invalid under Host billing configuration rules");
    throw error;
  }
  if (!billing) fail("billingConfig is required");
  if (
    billing.revision !== shared.revision ||
    billing.freeIncludedMinor !== microsToMinor(shared.freeIncludedMicros, "free allowance")
  )
    fail("billingConfig revision or Free allowance disagrees with sharedPricing");
  if (
    Object.keys(billing.plans).length !== plans.length ||
    plans.some(
      (plan) =>
        billing.plans[plan.planId]?.includedMinor !== plan.includedCreditMinor ||
        billing.plans[plan.planId]?.stripePriceId !== plan.stripePriceId,
    )
  )
    fail("billingConfig plans disagree with sharedPricing");
  const expectedMeters = Object.entries(shared.meters).filter(
    ([, meter]) => meter.cloudflareCostMicros !== "0",
  );
  if (
    Object.keys(billing.meters).length !== expectedMeters.length ||
    expectedMeters.some(([key, meter]) => {
      const actual = billing.meters[key];
      return (
        !actual ||
        actual.stripePriceId !== undefined ||
        actual.unit !== meter.unit ||
        BigInt(actual.rate.numeratorMicros) !==
          BigInt(meter.cloudflareCostMicros) * BigInt(shared.markupMultiplier) ||
        BigInt(actual.rate.denominator) !== BigInt(meter.quantity)
      );
    })
  )
    fail("billingConfig meters disagree with sharedPricing");
  try {
    for (const snapshot of [billing, ...(billing.history ?? [])]) {
      minorToMicros(snapshot.freeIncludedMinor);
      for (const plan of Object.values(snapshot.plans)) minorToMicros(plan.includedMinor);
    }
  } catch (error) {
    if (error instanceof MoneyError)
      fail("billingConfig grant amounts must fit the USD-micros ledger");
    throw error;
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
    if (error instanceof PaymentSettingsError) fail("checkout bounds are invalid");
    throw error;
  }
  const hostedConfiguration = JSON.stringify(root);
  if (new TextEncoder().encode(hostedConfiguration).byteLength > HOSTED_PRICING_MAX_BYTES)
    fail("Hosted pricing exceeds the runtime configuration limit");
  return {
    kind: "takoserver.pricing-preview@v2",
    validation: "host-billing-config-valid",
    mode: "preview",
    activation: "stripe-test-price-verification-required",
    environment: {
      TAKOSERVER_BILLING_CONFIG: JSON.stringify(rawBillingConfig),
      TAKOSERVER_HOSTED_PRICING: hostedConfiguration,
      [PAYMENT_SETTING_VARIABLES.checkoutMinimumMinor]: String(minimumMinor),
      [PAYMENT_SETTING_VARIABLES.checkoutMaximumMinor]: String(maximumMinor),
    },
    stripeMonthlyReview: plans.map((plan) => ({
      planKey: plan.planId,
      stripePriceId: plan.stripePriceId,
      expectedAmountMinor: plan.monthlyAmountMinor,
      currency: "USD" as const,
      interval: "month" as const,
    })),
    hostedPlanTable: {
      scope: "hosted",
      products: ["takosumi-hosted", "takoserver"],
      balanceScope: "organization",
      plans: [
        {
          planId: ids.free as string,
          tier: "free",
          resourceScope: "edge",
          configuredMonthlyCreditMinor: billing.freeIncludedMinor,
          edgeAllowance: "pending-owner-runtime-policy",
        },
        ...plans.map((plan) => ({
          planId: plan.planId,
          tier: "subscription" as const,
          monthlyAmountMinor: plan.monthlyAmountMinor,
          includedCreditMinor: plan.includedCreditMinor,
          stripePriceId: plan.stripePriceId,
        })),
        {
          planId: ids.usage as string,
          tier: "usage",
          checkoutMinimumMinor: minimumMinor,
          checkoutMaximumMinor: maximumMinor,
          meters: billing.meters,
        },
      ],
      consumptionOrder: ["free", "subscription", "purchased", "postpaid"],
    },
  };
}

function microsToMinor(value: string, name: string): number {
  const micros = BigInt(value);
  if (micros % 10_000n !== 0n || micros / 10_000n > BigInt(Number.MAX_SAFE_INTEGER))
    fail(`${name} cannot be represented at the Stripe cents boundary`);
  return Number(micros / 10_000n);
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

/**
 * Reads an already persisted immutable pricing snapshot against the explicit
 * reviewed revision registry. Never use this for admission/configuration or to
 * register caller-supplied history. The caller must still compare the complete
 * compiled snapshot with its persisted bytes and preserve its original custody.
 */
export function parsePersistedHostedPricing(
  raw: string | undefined,
  expectedRevision: string,
): HostedPricing | undefined {
  if (raw === undefined) return undefined;
  try {
    const root = objectAt(
      parseStrictJson(new TextEncoder().encode(raw), HOSTED_PRICING_MAX_BYTES),
      "$",
    );
    let pricing: HostedPricing;
    if (root.authoringVersion === 2) {
      const source = objectAt(root.sharedPricing, "sharedPricing");
      if (source.revision !== expectedRevision) throw new HostedPricingError();
      const terms = retainedSharedTerms.get(expectedRevision);
      if (!terms) throw new HostedPricingError();
      pricing = compileSharedRuntimePricing(root, terms);
    } else {
      // Preserve the original strict v1 contract; only v2 has a shared-source registry.
      pricing = compilePricingAuthoring(root);
    }
    const tariff = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
    if (!tariff || tariff.revision !== expectedRevision) throw new HostedPricingError();
    return pricing;
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
