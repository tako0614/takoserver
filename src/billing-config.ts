import { parseStrictJson } from "./strict-json.ts";

/**
 * Pure parser and integer pricing helpers for the Organization billing tariff.
 *
 * `TAKOSERVER_BILLING_CONFIG` is JSON with this shape:
 *
 * ```json
 * {
 *   "schemaVersion": 1,
 *   "revision": "2026-10-13.1",
 *   "effectiveAt": "2026-10-13T00:00:00.000Z",
 *   "currency": "USD",
 *   "holdTtlSeconds": 86400,
 *   "freeIncludedMinor": 0,
 *   "purchaseCreditExpiry": { "kind": "none" },
 *   "plans": { "starter": { "includedMinor": 0, "stripePriceId": "price_example1" } },
 *   "meters": {
 *     "takosumi.storage.byte-hours": {
 *       "unit": "byte-hour",
 *       "rate": { "numeratorMicros": "1", "denominator": "1000" },
 *       "stripePriceId": "price_example2"
 *     }
 *   }
 * }
 * ```
 *
 * Rates are exact USD micros per meter unit. The parser deliberately performs
 * no environment, filesystem, clock, or Stripe access. Callers choose and
 * persist the selected revision with each immutable billing receipt.
 */

export const BILLING_CONFIG_ENVIRONMENT_VARIABLE = "TAKOSERVER_BILLING_CONFIG";
export const BILLING_CONFIG_SCHEMA_VERSION = 1;
export const MIN_HOLD_TTL_SECONDS = 60;
export const MAX_HOLD_TTL_SECONDS = 7 * 24 * 60 * 60;
export const DEFAULT_HOLD_TTL_SECONDS = 24 * 60 * 60;
const BASIS_POINT_DENOMINATOR = 10_000n;
const MAX_CONFIG_STRING_LENGTH = 512;
const MAX_RATE_INTEGER_DIGITS = 256;
const MAX_AMOUNT_INTEGER_DIGITS = 256;
const MAX_BILLING_CONFIG_BYTES = 262_144;

export interface BillingRate {
  /** Positive integer micros per unit, encoded as canonical decimal text. */
  readonly numeratorMicros: string;
  /** Positive integer denominator, encoded as canonical decimal text. */
  readonly denominator: string;
}

export interface BillingPlan {
  /** Monthly plan entitlement in USD cents. */
  readonly includedMinor: number;
  readonly stripePriceId: string;
}

export interface BillingMeter {
  readonly unit: string;
  readonly rate: BillingRate;
  /** Optional Stripe identity for meters that also have an after-use price. */
  readonly stripePriceId?: string;
}

export type PurchaseCreditExpiry =
  | { readonly kind: "none" }
  | { readonly kind: "fixed-duration"; readonly seconds: number };

export interface BillingConfig {
  readonly schemaVersion: 1;
  readonly revision: string;
  readonly effectiveAt: string;
  readonly currency: "USD";
  readonly holdTtlSeconds: number;
  /** Monthly free entitlement per eligible Organization in USD cents. */
  readonly freeIncludedMinor: number;
  readonly purchaseCreditExpiry: PurchaseCreditExpiry;
  readonly plans: Readonly<Record<string, BillingPlan>>;
  readonly meters: Readonly<Record<string, BillingMeter>>;
  /** Prior immutable revisions retained for period-start and replay pricing. */
  readonly history?: readonly BillingConfigRevision[];
}

/** A complete historical revision; historical entries cannot nest their own history. */
export type BillingConfigRevision = Omit<BillingConfig, "history">;

export class BillingConfigError extends Error {
  constructor(
    readonly path: string,
    reason: string,
  ) {
    super(`invalid billing config at ${path}: ${reason}`);
    this.name = "BillingConfigError";
  }
}

/** Missing or blank configuration disables billing; malformed configuration fails closed. */
export function parseBillingConfig(raw: string | undefined): BillingConfig | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;

  let parsed: unknown;
  try {
    parsed = parseStrictJson(new TextEncoder().encode(raw), MAX_BILLING_CONFIG_BYTES);
  } catch {
    throw new BillingConfigError("$", "expected strict JSON within the size limit");
  }
  const root = record(parsed, "$", [
    "schemaVersion",
    "revision",
    "effectiveAt",
    "currency",
    "holdTtlSeconds",
    "freeIncludedMinor",
    "purchaseCreditExpiry",
    "plans",
    "meters",
    "history",
  ]);
  const { history: rawHistory, ...currentSnapshot } = root;
  const current = parseBillingConfigSnapshot(currentSnapshot, "$");
  if (rawHistory === undefined) return current;
  if (!Array.isArray(rawHistory)) throw new BillingConfigError("history", "must be an array");
  const history = rawHistory.map((entry, index) =>
    parseBillingConfigSnapshot(entry, `history[${index}]`),
  );
  validateConfigHistory([current, ...history]);
  if (history.some((revision) => revision.effectiveAt >= current.effectiveAt)) {
    throw new BillingConfigError(
      "history",
      "historical revisions must predate the current revision",
    );
  }
  return { ...current, history };
}

function parseBillingConfigSnapshot(value: unknown, path: string): BillingConfigRevision {
  const root = record(value, path, [
    "schemaVersion",
    "revision",
    "effectiveAt",
    "currency",
    "holdTtlSeconds",
    "freeIncludedMinor",
    "purchaseCreditExpiry",
    "plans",
    "meters",
  ]);
  if (root.schemaVersion !== BILLING_CONFIG_SCHEMA_VERSION) {
    throw new BillingConfigError(`${path}.schemaVersion`, "unsupported schema version");
  }
  const revision = stringValue(
    root.revision,
    `${path}.revision`,
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u,
  );
  const effectiveAt = canonicalIsoDateTime(root.effectiveAt, `${path}.effectiveAt`);
  if (root.currency !== "USD") throw new BillingConfigError(`${path}.currency`, "must be USD");
  const holdTtlSeconds = safeInteger(
    root.holdTtlSeconds === undefined ? DEFAULT_HOLD_TTL_SECONDS : root.holdTtlSeconds,
    `${path}.holdTtlSeconds`,
    MIN_HOLD_TTL_SECONDS,
    MAX_HOLD_TTL_SECONDS,
  );
  const freeIncludedMinor = safeInteger(root.freeIncludedMinor, `${path}.freeIncludedMinor`, 0);
  const purchaseCreditExpiry = parsePurchaseCreditExpiry(root.purchaseCreditExpiry, path);
  const plans = parsePlans(root.plans, path);
  const meters = parseMeters(root.meters, path);
  const priceIds = new Set<string>();
  for (const [key, plan] of Object.entries(plans)) {
    addUniquePriceId(priceIds, plan.stripePriceId, `${path}.plans.${key}.stripePriceId`);
  }
  for (const [key, meter] of Object.entries(meters)) {
    if (meter.stripePriceId)
      addUniquePriceId(priceIds, meter.stripePriceId, `${path}.meters.${key}.stripePriceId`);
  }

  return {
    schemaVersion: BILLING_CONFIG_SCHEMA_VERSION,
    revision,
    effectiveAt,
    currency: "USD",
    holdTtlSeconds,
    freeIncludedMinor,
    purchaseCreditExpiry,
    plans,
    meters,
  };
}

/** Returns the newest effective frozen revision at `at`; ties are ambiguous and rejected. */
export function selectCurrentBillingConfig(
  configs: readonly BillingConfig[],
  at: string,
): BillingConfig | undefined {
  const instant = canonicalIsoDateTime(at, "at");
  const flattened: BillingConfigRevision[] = [];
  for (const config of configs) {
    flattened.push(config);
    if (config.history) flattened.push(...config.history);
  }
  validateConfigHistory(flattened);
  const candidates = flattened.filter((config) => config.effectiveAt <= instant);
  candidates.sort((left, right) => left.effectiveAt.localeCompare(right.effectiveAt));
  const latest = candidates.at(-1);
  return latest;
}

function validateConfigHistory(configs: readonly BillingConfigRevision[]): void {
  const revisions = new Set<string>();
  const effectiveTimes = new Set<string>();
  for (const config of configs) {
    if (revisions.has(config.revision)) {
      throw new BillingConfigError("revision", "duplicate revision in configuration history");
    }
    if (effectiveTimes.has(config.effectiveAt)) {
      throw new BillingConfigError(
        "effectiveAt",
        "multiple revisions have the same effective time",
      );
    }
    revisions.add(config.revision);
    effectiveTimes.add(config.effectiveAt);
  }
}

/** Computes a final hold directly from estimate micros and basis-point headroom. */
export function ceilHoldMicros(estimatedMicros: string, headroomBasisPoints: number): number {
  const estimate = canonicalUnsignedInteger(estimatedMicros, "estimatedMicros");
  if (!Number.isSafeInteger(headroomBasisPoints) || headroomBasisPoints < 0) {
    throw new BillingConfigError("headroomBasisPoints", "must be a nonnegative safe integer");
  }
  const numerator = estimate * (10_000n + BigInt(headroomBasisPoints));
  const amountMicros =
    numerator === 0n ? 0n : (numerator + BASIS_POINT_DENOMINATOR - 1n) / BASIS_POINT_DENOMINATOR;
  return bigintToSafeInteger(amountMicros, "hold amountMicros");
}

/**
 * Prices an integer quantity at an exact micros-per-unit rational rate and
 * quantizes upward once at the whole measured Run or closed-period boundary.
 * Callers aggregate samples exactly before invoking this function.
 */
export function computeMeterAmountMicros(
  quantity: bigint,
  rate: BillingRate,
  quantityDenominator = 1n,
): number {
  if (quantity < 0n) throw new BillingConfigError("quantity", "must be a nonnegative integer");
  if (quantityDenominator <= 0n) {
    throw new BillingConfigError("quantityDenominator", "must be a positive integer");
  }
  const numeratorMicros = canonicalUnsignedInteger(rate.numeratorMicros, "rate.numeratorMicros");
  const denominator = canonicalUnsignedInteger(rate.denominator, "rate.denominator");
  if (numeratorMicros === 0n)
    throw new BillingConfigError("rate.numeratorMicros", "must be positive");
  if (denominator === 0n) throw new BillingConfigError("rate.denominator", "must be positive");
  const microsNumerator = quantity * numeratorMicros;
  const microsDenominator = denominator * quantityDenominator;
  return bigintToSafeInteger(
    (microsNumerator + microsDenominator - 1n) / microsDenominator,
    "meter amountMicros",
  );
}

function parsePurchaseCreditExpiry(value: unknown, path: string): PurchaseCreditExpiry {
  const expiryPath = `${path}.purchaseCreditExpiry`;
  const expiry = record(value, expiryPath, ["kind", "seconds"]);
  if (expiry.kind === "none") {
    if (Object.hasOwn(expiry, "seconds")) {
      throw new BillingConfigError(`${expiryPath}.seconds`, "is not allowed for kind none");
    }
    return { kind: "none" };
  }
  if (expiry.kind === "fixed-duration") {
    return {
      kind: "fixed-duration",
      seconds: safeInteger(expiry.seconds, `${expiryPath}.seconds`, 1),
    };
  }
  throw new BillingConfigError(`${expiryPath}.kind`, "must be none or fixed-duration");
}

function parsePlans(value: unknown, path: string): Readonly<Record<string, BillingPlan>> {
  const source = record(value, `${path}.plans`);
  const output: Record<string, BillingPlan> = {};
  for (const [key, valueForKey] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(key)) {
      throw new BillingConfigError(`${path}.plans.${key}`, "invalid plan key");
    }
    const planPath = `${path}.plans.${key}`;
    const plan = record(valueForKey, planPath, ["includedMinor", "stripePriceId"]);
    output[key] = {
      includedMinor: safeInteger(plan.includedMinor, `${planPath}.includedMinor`, 0),
      stripePriceId: stringValue(
        plan.stripePriceId,
        `${planPath}.stripePriceId`,
        /^price_[A-Za-z0-9]+$/u,
      ),
    };
  }
  return output;
}

function parseMeters(value: unknown, path: string): Readonly<Record<string, BillingMeter>> {
  const source = record(value, `${path}.meters`);
  const output: Record<string, BillingMeter> = {};
  for (const [key, valueForKey] of Object.entries(source)) {
    if (!/^[a-z][a-z0-9.-]{0,127}$/u.test(key) || key.includes("..")) {
      throw new BillingConfigError(`${path}.meters.${key}`, "invalid meter key");
    }
    const meterPath = `${path}.meters.${key}`;
    const meter = record(valueForKey, meterPath, ["unit", "rate", "stripePriceId"]);
    const rate = record(meter.rate, `${meterPath}.rate`, ["numeratorMicros", "denominator"]);
    const numeratorMicros = decimalString(
      rate.numeratorMicros,
      `${meterPath}.rate.numeratorMicros`,
    );
    const denominator = decimalString(rate.denominator, `${meterPath}.rate.denominator`);
    if (BigInt(numeratorMicros) === 0n) {
      throw new BillingConfigError(`${meterPath}.rate.numeratorMicros`, "must be positive");
    }
    if (BigInt(denominator) === 0n) {
      throw new BillingConfigError(`${meterPath}.rate.denominator`, "must be positive");
    }
    output[key] = {
      unit: stringValue(meter.unit, `${meterPath}.unit`, /^[A-Za-z][A-Za-z0-9._-]{0,63}$/u),
      rate: { numeratorMicros, denominator },
      ...(meter.stripePriceId === undefined
        ? {}
        : {
            stripePriceId: stringValue(
              meter.stripePriceId,
              `${meterPath}.stripePriceId`,
              /^price_[A-Za-z0-9]+$/u,
            ),
          }),
    };
  }
  return output;
}

function addUniquePriceId(seen: Set<string>, priceId: string, path: string): void {
  if (seen.has(priceId)) throw new BillingConfigError(path, "Stripe price ID must be unique");
  seen.add(priceId);
}

function record(
  value: unknown,
  path: string,
  allowedKeys?: readonly string[],
): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new BillingConfigError(path, "must be an object");
  }
  const result = value as Record<string, unknown>;
  if (allowedKeys) {
    for (const key of Object.keys(result)) {
      if (!allowedKeys.includes(key)) throw new BillingConfigError(`${path}.${key}`, "unknown key");
    }
  }
  return result;
}

function stringValue(value: unknown, path: string, pattern: RegExp): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_CONFIG_STRING_LENGTH ||
    !pattern.test(value)
  ) {
    throw new BillingConfigError(path, "invalid string");
  }
  return value;
}

function decimalString(value: unknown, path: string): string {
  if (
    typeof value !== "string" ||
    value.length > MAX_RATE_INTEGER_DIGITS ||
    !/^(0|[1-9][0-9]*)$/u.test(value)
  ) {
    throw new BillingConfigError(path, "must be a canonical unsigned decimal integer string");
  }
  return value;
}

function canonicalUnsignedInteger(value: string, path: string): bigint {
  if (
    typeof value !== "string" ||
    value.length > MAX_AMOUNT_INTEGER_DIGITS ||
    !/^(0|[1-9][0-9]*)$/u.test(value)
  ) {
    throw new BillingConfigError(path, "must be a canonical unsigned decimal integer string");
  }
  return BigInt(value);
}

function safeInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum = Number.MAX_SAFE_INTEGER,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new BillingConfigError(path, "must be a safe integer in range");
  }
  return value as number;
}

function canonicalIsoDateTime(value: unknown, path: string): string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw new BillingConfigError(path, "must be canonical UTC ISO date-time with milliseconds");
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    throw new BillingConfigError(path, "must be a valid canonical UTC ISO date-time");
  }
  return value;
}

function bigintToSafeInteger(value: bigint, path: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER))
    throw new BillingConfigError(path, "exceeds safe integer range");
  return Number(value);
}
