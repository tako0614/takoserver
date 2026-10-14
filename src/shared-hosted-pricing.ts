const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const CANONICAL_INTEGER = /^(0|[1-9][0-9]*)$/u;
const PRODUCT_IDS = ["takoserver", "takosumi-hosted"] as const;

export interface SharedHostedPlan {
  readonly planId: string;
  readonly monthlyPriceMicros: string;
  readonly includedMicros: string;
  readonly stripePriceId: string | null;
}

export interface SharedHostedMeter {
  readonly unit: string;
  readonly cloudflareCostMicros: string;
  readonly quantity: string;
}

export interface SharedHostedPricing {
  readonly schemaVersion: 2;
  readonly products: readonly (typeof PRODUCT_IDS)[number][];
  readonly currency: "USD";
  readonly moneyUnit: "USD-micros";
  readonly revision: string;
  readonly freeIncludedMicros: string;
  readonly plans: readonly SharedHostedPlan[];
  readonly purchase: "face-value";
  readonly markupMultiplier: number;
  readonly warningBasisPoints: readonly number[];
  readonly defaultOnLimit: "stop";
  readonly postpaid: "unsupported";
  readonly freePaidStacking: false;
  readonly shortWindowLimits: null;
  readonly meters: Readonly<Record<string, SharedHostedMeter>>;
}

export interface CompiledSharedHostedPricing {
  readonly kind: "takoserver.shared-hosted-pricing-preview@v2";
  readonly mode: "preview";
  readonly revision: string;
  readonly products: SharedHostedPricing["products"];
  readonly currency: "USD";
  readonly moneyUnit: "USD-micros";
  readonly organizationAllowance: {
    readonly freeIncludedMicros: string;
    readonly sourceRevision: string;
    readonly stripePriceId: null;
  };
  readonly plans: readonly (SharedHostedPlan & { readonly sourceRevision: string })[];
  readonly usageRates: Readonly<
    Record<
      string,
      SharedHostedMeter & {
        readonly numeratorMicros: string;
        readonly denominator: string;
      }
    >
  >;
  readonly purchase: "face-value";
  readonly warningBasisPoints: readonly number[];
  readonly defaultOnLimit: "stop";
  readonly postpaid: "unsupported";
  readonly freePaidStacking: false;
  readonly shortWindowLimits: null;
  readonly unresolvedStripePricePlanIds: readonly string[];
  readonly activation: "pending-stripe-price-ids" | "preview-qualified";
}

export class SharedHostedPricingError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`invalid shared hosted pricing at ${path}: ${reason}`);
    this.name = "SharedHostedPricingError";
  }
}

/** Validates an untrusted source document without reading environment or runtime state. */
export function parseSharedHostedPricing(input: unknown): SharedHostedPricing {
  const root = objectAt(input, "$", [
    "schemaVersion",
    "products",
    "currency",
    "moneyUnit",
    "revision",
    "freeIncludedMicros",
    "plans",
    "purchase",
    "markupMultiplier",
    "warningBasisPoints",
    "defaultOnLimit",
    "postpaid",
    "freePaidStacking",
    "shortWindowLimits",
    "meters",
  ]);
  if (root.schemaVersion !== 2) fail("schemaVersion", "must be 2");
  if (
    !Array.isArray(root.products) ||
    root.products.length !== PRODUCT_IDS.length ||
    root.products.some((product, index) => product !== PRODUCT_IDS[index])
  ) {
    fail("products", "must be [takoserver, takosumi-hosted]");
  }
  if (root.currency !== "USD") fail("currency", "must be USD");
  if (root.moneyUnit !== "USD-micros") fail("moneyUnit", "must be USD-micros");
  const revision = stringAt(root.revision, "revision", /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
  const freeIncludedMicros = integerAt(root.freeIncludedMicros, "freeIncludedMicros", true);
  if (root.purchase !== "face-value") fail("purchase", "must be face-value");
  if (
    typeof root.markupMultiplier !== "number" ||
    !Number.isSafeInteger(root.markupMultiplier) ||
    root.markupMultiplier <= 0
  ) {
    fail("markupMultiplier", "must be a positive safe integer");
  }
  const markupMultiplier = root.markupMultiplier;
  if (root.defaultOnLimit !== "stop") fail("defaultOnLimit", "must be stop");
  if (root.postpaid !== "unsupported") fail("postpaid", "must be unsupported");
  if (root.freePaidStacking !== false) fail("freePaidStacking", "must be false");
  if (root.shortWindowLimits !== null) fail("shortWindowLimits", "must be null");

  if (!Array.isArray(root.warningBasisPoints) || root.warningBasisPoints.length === 0) {
    fail("warningBasisPoints", "must be a nonempty sorted array");
  }
  const warningBasisPoints: number[] = [];
  for (const [index, entry] of root.warningBasisPoints.entries()) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry) || entry <= 0 || entry > 10_000) {
      fail(`warningBasisPoints[${index}]`, "must be a positive basis-point integer at most 10000");
    }
    const previous = warningBasisPoints.at(-1);
    if (previous !== undefined && entry <= previous) {
      fail(`warningBasisPoints[${index}]`, "must be strictly increasing");
    }
    warningBasisPoints.push(entry);
  }

  if (!Array.isArray(root.plans) || root.plans.length !== 2) {
    fail("plans", "must contain exactly two subscription plans");
  }
  const planIds = new Set<string>();
  const stripeIds = new Set<string>();
  const plans = root.plans.map((value, index): SharedHostedPlan => {
    const path = `plans[${index}]`;
    const plan = objectAt(value, path, [
      "planId",
      "monthlyPriceMicros",
      "includedMicros",
      "stripePriceId",
    ]);
    const planId = stringAt(plan.planId, `${path}.planId`, /^[a-z][a-z0-9-]{0,63}$/u);
    if (planIds.has(planId)) fail(`${path}.planId`, "must be unique");
    planIds.add(planId);
    const monthlyPriceMicros = integerAt(
      plan.monthlyPriceMicros,
      `${path}.monthlyPriceMicros`,
      false,
    );
    const includedMicros = integerAt(plan.includedMicros, `${path}.includedMicros`, false);
    const stripePriceId = nullableStripePriceId(plan.stripePriceId, `${path}.stripePriceId`);
    if (stripePriceId !== null) {
      if (stripeIds.has(stripePriceId)) fail(`${path}.stripePriceId`, "must be unique");
      stripeIds.add(stripePriceId);
    }
    return { planId, monthlyPriceMicros, includedMicros, stripePriceId };
  });

  const sourceMeters = objectAt(root.meters, "meters");
  const meters: Record<string, SharedHostedMeter> = {};
  for (const [key, value] of Object.entries(sourceMeters)) {
    if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(key) || key.includes("..")) {
      fail(`meters.${key}`, "invalid meter key");
    }
    const path = `meters.${key}`;
    const meter = objectAt(value, path, ["unit", "cloudflareCostMicros", "quantity"]);
    const unit = stringAt(meter.unit, `${path}.unit`, /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u);
    const cloudflareCostMicros = integerAt(
      meter.cloudflareCostMicros,
      `${path}.cloudflareCostMicros`,
      true,
    );
    const quantity = integerAt(meter.quantity, `${path}.quantity`, false);
    const customerNumerator = BigInt(cloudflareCostMicros) * BigInt(markupMultiplier);
    if (customerNumerator > MAX_SAFE)
      fail(`${path}.cloudflareCostMicros`, "marked-up rate exceeds safe integer range");
    meters[key] = { unit, cloudflareCostMicros, quantity };
  }
  if (Object.keys(meters).length === 0) fail("meters", "must contain at least one rate");

  return {
    schemaVersion: 2,
    products: [...PRODUCT_IDS],
    currency: "USD",
    moneyUnit: "USD-micros",
    revision,
    freeIncludedMicros,
    plans,
    purchase: "face-value",
    markupMultiplier,
    warningBasisPoints,
    defaultOnLimit: "stop",
    postpaid: "unsupported",
    freePaidStacking: false,
    shortWindowLimits: null,
    meters,
  };
}

/** Compiles a validated source document into integer USD-micros preview data. */
export function compileSharedHostedPricing(
  pricing: SharedHostedPricing,
): CompiledSharedHostedPricing {
  const usageRates: Record<
    string,
    SharedHostedMeter & { readonly numeratorMicros: string; readonly denominator: string }
  > = {};
  for (const [key, meter] of Object.entries(pricing.meters)) {
    usageRates[key] = {
      ...meter,
      numeratorMicros: (
        BigInt(meter.cloudflareCostMicros) * BigInt(pricing.markupMultiplier)
      ).toString(),
      denominator: meter.quantity,
    };
  }
  const unresolvedStripePricePlanIds = pricing.plans
    .filter((plan) => plan.stripePriceId === null)
    .map((plan) => plan.planId);
  return {
    kind: "takoserver.shared-hosted-pricing-preview@v2",
    mode: "preview",
    revision: pricing.revision,
    products: pricing.products,
    currency: pricing.currency,
    moneyUnit: pricing.moneyUnit,
    organizationAllowance: {
      freeIncludedMicros: pricing.freeIncludedMicros,
      sourceRevision: pricing.revision,
      stripePriceId: null,
    },
    plans: pricing.plans.map((plan) => ({
      ...plan,
      sourceRevision: pricing.revision,
    })),
    usageRates,
    purchase: pricing.purchase,
    warningBasisPoints: pricing.warningBasisPoints,
    defaultOnLimit: pricing.defaultOnLimit,
    postpaid: pricing.postpaid,
    freePaidStacking: pricing.freePaidStacking,
    shortWindowLimits: pricing.shortWindowLimits,
    unresolvedStripePricePlanIds,
    activation:
      unresolvedStripePricePlanIds.length > 0 ? "pending-stripe-price-ids" : "preview-qualified",
  };
}

function objectAt(
  value: unknown,
  path: string,
  allowedKeys?: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  const object = value as Record<string, unknown>;
  if (allowedKeys) {
    for (const key of Object.keys(object)) {
      if (!allowedKeys.includes(key)) fail(`${path}.${key}`, "unknown key");
    }
  }
  return object;
}

function stringAt(value: unknown, path: string, pattern: RegExp): string {
  if (typeof value !== "string" || value.length > 256 || !pattern.test(value)) {
    fail(path, "invalid string");
  }
  return value;
}

function integerAt(value: unknown, path: string, allowZero: boolean): string {
  if (typeof value !== "string" || value.length > 256 || !CANONICAL_INTEGER.test(value)) {
    fail(path, "must be a canonical integer string of at most 256 digits");
  }
  const integer = BigInt(value);
  if ((!allowZero && integer === 0n) || integer > MAX_SAFE) {
    fail(
      path,
      allowZero ? "exceeds safe integer range" : "must be positive and within safe integer range",
    );
  }
  return value;
}

function nullableStripePriceId(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringAt(value, path, /^price_[A-Za-z0-9]+$/u);
}

function fail(path: string, reason: string): never {
  throw new SharedHostedPricingError(path, reason);
}
