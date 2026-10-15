import type { PurchaseCreditExpiry } from "./billing-config.ts";
import { MICROS_PER_MINOR, minorToMicros, parseUnsignedMicros } from "./money.ts";

const REVISION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_INSTANT_MS = 253402300799000;
const MAX_EXPIRY_SECONDS = 253402300799;

export interface OrgOnDemandTerms {
  readonly termsRevision: string;
  readonly consentRevision: string;
  readonly currency: "USD";
  /** Inclusive start and exclusive end, supplied by the operator. */
  readonly validity: {
    readonly validFrom: string;
    readonly validUntil: string;
  };
  readonly replenishment: {
    readonly trigger: "eligible-credit-deficit";
    /** Positive deficits round up to a quantum, then up to the explicit minimum. */
    readonly rule: "ceil-deficit-to-quantum-with-minimum";
    readonly fundingQuantumMinor: number;
    readonly minimumChargeMinor: number;
    readonly maximumChargeMinor: number;
  };
  /** Bounds only: these terms never select the user's monthly cash cap. */
  readonly cashCapBounds: {
    readonly minimumMinor: number;
    readonly maximumMinor: number;
  };
  readonly purchaseCreditExpiry: PurchaseCreditExpiry;
}

export interface OrgOnDemandFundingCalculation {
  readonly kind: "none" | "single-charge";
  /** Includes the exact rule and its minimum floor for disclosure and persistence. */
  readonly terms: OrgOnDemandTerms;
  readonly evaluatedAt: string;
  readonly deficitMicros: string;
  readonly amountMinor: number;
  /** Face value, without a bonus or an assumed future invoice payment. */
  readonly creditMicros: number;
}

export class OrgOnDemandTermsError extends Error {
  constructor(
    readonly code:
      | "invalid_terms"
      | "invalid_argument"
      | "terms_not_valid"
      | "maximum_charge_exceeded"
      | "expiry_overflow",
  ) {
    super(code);
    this.name = "OrgOnDemandTermsError";
  }
}

type ErrorCode = OrgOnDemandTermsError["code"];

function fail(code: ErrorCode): never {
  throw new OrgOnDemandTermsError(code);
}

function exact(value: unknown, keys: readonly string[], code: ErrorCode): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(code);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.length !== keys.length || ownKeys.some((key) => !keys.includes(String(key))))
    fail(code);
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail(code);
  }
  return value as Record<string, unknown>;
}

function revision(value: unknown): string {
  if (typeof value !== "string" || !REVISION.test(value)) fail("invalid_terms");
  return value;
}

function instant(value: unknown, code: ErrorCode): number {
  if (typeof value !== "string" || !INSTANT.test(value)) fail(code);
  const milliseconds = Date.parse(value);
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds > MAX_INSTANT_MS ||
    new Date(milliseconds).toISOString() !== value
  )
    fail(code);
  return milliseconds;
}

function positiveMinor(value: unknown, code: ErrorCode): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) fail(code);
  try {
    minorToMicros(value);
  } catch {
    fail(code);
  }
  return value;
}

/**
 * Strict operator input only; every field is required and no default is selected.
 * Validation freezes a defensive copy, but grants no consent, card qualification,
 * charge authority, fresh-admission authority or runtime capability.
 */
export function parseOrgOnDemandTerms(input: unknown): OrgOnDemandTerms {
  const value = exact(
    input,
    [
      "termsRevision",
      "consentRevision",
      "currency",
      "validity",
      "replenishment",
      "cashCapBounds",
      "purchaseCreditExpiry",
    ],
    "invalid_terms",
  );
  const termsRevision = revision(value.termsRevision);
  const consentRevision = revision(value.consentRevision);
  if (value.currency !== "USD") fail("invalid_terms");
  const validity = exact(value.validity, ["validFrom", "validUntil"], "invalid_terms");
  const from = instant(validity.validFrom, "invalid_terms");
  const until = instant(validity.validUntil, "invalid_terms");
  if (from >= until) fail("invalid_terms");
  const replenishment = exact(
    value.replenishment,
    ["trigger", "rule", "fundingQuantumMinor", "minimumChargeMinor", "maximumChargeMinor"],
    "invalid_terms",
  );
  if (
    replenishment.trigger !== "eligible-credit-deficit" ||
    replenishment.rule !== "ceil-deficit-to-quantum-with-minimum"
  )
    fail("invalid_terms");
  const fundingQuantumMinor = positiveMinor(replenishment.fundingQuantumMinor, "invalid_terms");
  const minimumChargeMinor = positiveMinor(replenishment.minimumChargeMinor, "invalid_terms");
  const maximumChargeMinor = positiveMinor(replenishment.maximumChargeMinor, "invalid_terms");
  // This supported rule requires both bounds to be whole funding quanta.
  if (
    minimumChargeMinor > maximumChargeMinor ||
    minimumChargeMinor % fundingQuantumMinor !== 0 ||
    maximumChargeMinor % fundingQuantumMinor !== 0
  )
    fail("invalid_terms");
  const bounds = exact(value.cashCapBounds, ["minimumMinor", "maximumMinor"], "invalid_terms");
  const minimumMinor = positiveMinor(bounds.minimumMinor, "invalid_terms");
  const maximumMinor = positiveMinor(bounds.maximumMinor, "invalid_terms");
  if (minimumMinor > maximumMinor) fail("invalid_terms");
  const expiryValue = value.purchaseCreditExpiry;
  if (typeof expiryValue !== "object" || expiryValue === null) fail("invalid_terms");
  const kind = Object.getOwnPropertyDescriptor(expiryValue, "kind")?.value as unknown;
  let purchaseCreditExpiry: PurchaseCreditExpiry;
  if (kind === "none") {
    exact(expiryValue, ["kind"], "invalid_terms");
    purchaseCreditExpiry = Object.freeze({ kind: "none" });
  } else {
    const expiry = exact(expiryValue, ["kind", "seconds"], "invalid_terms");
    if (
      expiry.kind !== "fixed-duration" ||
      typeof expiry.seconds !== "number" ||
      !Number.isSafeInteger(expiry.seconds) ||
      expiry.seconds <= 0 ||
      expiry.seconds > MAX_EXPIRY_SECONDS
    )
      fail("invalid_terms");
    purchaseCreditExpiry = Object.freeze({ kind: "fixed-duration", seconds: expiry.seconds });
  }
  return Object.freeze({
    termsRevision,
    consentRevision,
    currency: "USD",
    validity: Object.freeze({
      validFrom: validity.validFrom as string,
      validUntil: validity.validUntil as string,
    }),
    replenishment: Object.freeze({
      trigger: "eligible-credit-deficit",
      rule: "ceil-deficit-to-quantum-with-minimum",
      fundingQuantumMinor,
      minimumChargeMinor,
      maximumChargeMinor,
    }),
    cashCapBounds: Object.freeze({ minimumMinor, maximumMinor }),
    purchaseCreditExpiry,
  });
}

/** Checks an explicitly supplied cap, without choosing it or reserving any cash. */
export function validateOrgOnDemandCashCap(terms: OrgOnDemandTerms, cashCapMinor: number): number {
  const frozen = parseOrgOnDemandTerms(terms);
  const cap = positiveMinor(cashCapMinor, "invalid_argument");
  if (cap < frozen.cashCapBounds.minimumMinor || cap > frozen.cashCapBounds.maximumMinor)
    fail("invalid_argument");
  return cap;
}

/**
 * One calculation, never a charge loop. The common owner supplies the genuine
 * eligible-credit deficit and guards consent, current capacity and cap atomically.
 * Positive funding = max(minimum, ceil(ceil(deficitMicros / 10000) / quantum) * quantum).
 * A zero deficit requires no funding and never incurs the minimum.
 */
export function calculateOrgOnDemandFunding(
  terms: OrgOnDemandTerms,
  input: { readonly deficitMicros: string; readonly evaluatedAt: string },
): OrgOnDemandFundingCalculation {
  const frozen = parseOrgOnDemandTerms(terms);
  const request = exact(input, ["deficitMicros", "evaluatedAt"], "invalid_argument");
  const evaluated = instant(request.evaluatedAt, "invalid_argument");
  if (
    evaluated < Date.parse(frozen.validity.validFrom) ||
    evaluated >= Date.parse(frozen.validity.validUntil)
  )
    fail("terms_not_valid");
  let deficit: bigint;
  try {
    if (typeof request.deficitMicros !== "string") fail("invalid_argument");
    deficit = BigInt(parseUnsignedMicros(request.deficitMicros));
  } catch {
    fail("invalid_argument");
  }
  const { fundingQuantumMinor, minimumChargeMinor, maximumChargeMinor } = frozen.replenishment;
  const cents = (deficit + MICROS_PER_MINOR - 1n) / MICROS_PER_MINOR;
  const quantum = BigInt(fundingQuantumMinor);
  const rounded = ((cents + quantum - 1n) / quantum) * quantum;
  const amount =
    deficit === 0n
      ? 0n
      : rounded < BigInt(minimumChargeMinor)
        ? BigInt(minimumChargeMinor)
        : rounded;
  if (amount > BigInt(maximumChargeMinor)) fail("maximum_charge_exceeded");
  const amountMinor = Number(amount);
  return Object.freeze({
    kind: amount === 0n ? "none" : "single-charge",
    terms: frozen,
    evaluatedAt: request.evaluatedAt as string,
    deficitMicros: String(deficit),
    amountMinor,
    creditMicros: minorToMicros(amountMinor),
  });
}

/**
 * Called only with the common store's explicitly chosen first verified funding
 * instant. That owner must read a saved original before computing, persist this
 * result atomically with the funding/lot/ledger, and never recompute on replay.
 * Late success uses the frozen policy even after the terms validity has ended.
 */
export function resolveOrgOnDemandCreditExpiry(
  terms: OrgOnDemandTerms,
  firstVerifiedFundingAt: string,
): { readonly firstVerifiedFundingAt: string; readonly creditExpiresAt: string | null } {
  const frozen = parseOrgOnDemandTerms(terms);
  const funded = instant(firstVerifiedFundingAt, "invalid_argument");
  let creditExpiresAt: string | null = null;
  if (frozen.purchaseCreditExpiry.kind === "fixed-duration") {
    const expires = BigInt(funded) + BigInt(frozen.purchaseCreditExpiry.seconds) * 1000n;
    if (expires > BigInt(MAX_INSTANT_MS)) fail("expiry_overflow");
    creditExpiresAt = new Date(Number(expires)).toISOString();
  }
  return Object.freeze({ firstVerifiedFundingAt, creditExpiresAt });
}
