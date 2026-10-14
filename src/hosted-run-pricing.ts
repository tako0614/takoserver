import {
  type BillingConfig,
  parseBillingConfig,
  selectCurrentBillingConfig,
} from "./billing-config.ts";
import { canonicalJson, isSha256Digest } from "./json.ts";
import { addRational, ceilPricedMicros, rational } from "./meter-pricing.ts";

export const MAX_HOSTED_RUN_MEASUREMENTS = 128;

export interface HostedRunQuoteInput {
  readonly organizationId: string;
  readonly reference: string;
  readonly workspaceRef: string;
  readonly product: "takoserver" | "takosumi-hosted";
}

/** Closed segments use tariff meter names and their declared units, without aliases. */
export interface HostedRunMeasurement {
  readonly meter: string;
  readonly quantityUnit: string;
  readonly quantity: string;
  readonly periodStart: string;
  readonly periodEnd: string;
}

export interface HostedRunClosedInput {
  readonly organizationId: string;
  readonly reference: string;
  readonly workspaceRef: string;
  readonly applyReference: string;
  readonly closedMeasurements: readonly HostedRunMeasurement[];
  readonly pricingVersion: string;
}

/** Persisted by the authenticated Run owner before this pricing port is called. */
export interface HostedRunQuoteProof extends HostedRunQuoteInput {
  readonly requestFingerprint: `sha256:${string}`;
  readonly quotedAt: string;
  readonly pricingVersion: string;
  readonly estimatedMeasurements: readonly HostedRunMeasurement[];
}

/** The Run owner attests the entire closed measurement set, including zero use. */
export interface HostedRunClosedProof extends HostedRunQuoteInput {
  readonly requestFingerprint: `sha256:${string}`;
  readonly applyReference: string;
  readonly pricingVersion: string;
  readonly closedAt: string;
  readonly closedMeasurements: readonly HostedRunMeasurement[];
}

/**
 * Trusted server composition only. Readers must verify the immutable Run request,
 * Workspace-to-Org delegation and complete runner/storage receipt custody. They
 * return persisted proof, never a reconstruction from this caller's amounts.
 */
export interface HostedRunPricingCustody {
  readQuote(input: HostedRunQuoteInput): Promise<HostedRunQuoteProof | null>;
  readClosed(input: {
    readonly organizationId: string;
    readonly reference: string;
    readonly workspaceRef: string;
    readonly applyReference: string;
  }): Promise<HostedRunClosedProof | null>;
}

export interface HostedRunPricing {
  quoteRun(input: HostedRunQuoteInput): Promise<{
    readonly estimatedUsdMicros: string;
    readonly pricingVersion: string;
  }>;
  rateClosedRun(input: HostedRunClosedInput): Promise<{
    readonly actualUsdMicros: string;
    readonly pricingVersion: string;
  }>;
}

export class HostedRunPricingError extends Error {
  constructor(
    readonly code:
      | "invalid_request"
      | "custody_unavailable"
      | "custody_mismatch"
      | "pricing_unavailable"
      | "invalid_measurement"
      | "amount_overflow",
  ) {
    super(code);
    this.name = "HostedRunPricingError";
  }
}

/**
 * Read-only adapter over the existing validated tariff and exact pricing fold.
 * It creates no quote, hold, measurement, money receipt or provider side effect.
 * No usable default custody source exists: an uncomposed port refuses both calls.
 */
export function createHostedRunPricing(options: {
  readonly billingConfig: BillingConfig;
  readonly custody?: HostedRunPricingCustody;
}): HostedRunPricing {
  const parsed = parseBillingConfig(canonicalJson(options.billingConfig));
  if (!parsed) fail("pricing_unavailable");
  const config: BillingConfig = parsed;
  const snapshots = [config, ...(config.history ?? [])];
  const custody = options.custody;

  function price(
    pricingVersion: string,
    measurements: readonly HostedRunMeasurement[],
    quotedAt: string,
  ): string {
    const tariff = selectCurrentBillingConfig([config], quotedAt);
    if (!tariff || tariff.revision !== pricingVersion) fail("pricing_unavailable");
    let total = rational(0n);
    for (const measurement of measurements) {
      if (
        selectCurrentBillingConfig([config], measurement.periodStart)?.revision !==
          pricingVersion ||
        snapshots.some(
          (snapshot) =>
            snapshot.effectiveAt > measurement.periodStart &&
            snapshot.effectiveAt < measurement.periodEnd,
        )
      )
        fail("pricing_unavailable");
      const meter = Object.hasOwn(tariff.meters, measurement.meter)
        ? tariff.meters[measurement.meter]
        : undefined;
      if (!meter) fail("pricing_unavailable");
      const [whole = "0", fraction = ""] = measurement.quantity.split(".");
      const quantity = BigInt(whole + fraction);
      let unitDivisor = 1n;
      if (meter.unit === "byte-hour") {
        if (measurement.quantityUnit !== "byte-millisecond" || fraction !== "")
          fail("invalid_measurement");
        unitDivisor = 3600000n;
      } else if (measurement.quantityUnit !== meter.unit) {
        fail("invalid_measurement");
      }
      total = addRational(
        total,
        rational(
          quantity * BigInt(meter.rate.numeratorMicros),
          10n ** BigInt(fraction.length) * BigInt(meter.rate.denominator) * unitDivisor,
        ),
      );
    }
    try {
      return String(ceilPricedMicros(total));
    } catch {
      fail("amount_overflow");
    }
  }

  return {
    async quoteRun(input) {
      exact(input, ["organizationId", "reference", "workspaceRef", "product"]);
      const subject = quoteSubject(input);
      if (!custody) fail("custody_unavailable");
      const stored = await custody.readQuote(Object.freeze(subject));
      if (!stored) fail("custody_unavailable");
      const proof = quoteProof(stored);
      if (canonicalJson(quoteSubject(proof)) !== canonicalJson(subject)) fail("custody_mismatch");
      return {
        estimatedUsdMicros: price(
          proof.pricingVersion,
          proof.estimatedMeasurements,
          proof.quotedAt,
        ),
        pricingVersion: proof.pricingVersion,
      };
    },
    async rateClosedRun(input) {
      exact(input, [
        "organizationId",
        "reference",
        "workspaceRef",
        "applyReference",
        "closedMeasurements",
        "pricingVersion",
      ]);
      const subject = {
        organizationId: opaque(input.organizationId),
        reference: opaque(input.reference),
        workspaceRef: opaque(input.workspaceRef),
        applyReference: opaque(input.applyReference),
      };
      const pricingVersion = opaque(input.pricingVersion);
      const supplied = measurements(input.closedMeasurements);
      if (!custody) fail("custody_unavailable");
      const stored = await custody.readClosed(Object.freeze(subject));
      if (!stored) fail("custody_unavailable");
      const proof = closedProof(stored);
      if (
        canonicalJson({
          organizationId: proof.organizationId,
          reference: proof.reference,
          workspaceRef: proof.workspaceRef,
          applyReference: proof.applyReference,
        }) !== canonicalJson(subject) ||
        proof.pricingVersion !== pricingVersion ||
        canonicalJson(proof.closedMeasurements) !== canonicalJson(supplied)
      )
        fail("custody_mismatch");
      const quote = await custody.readQuote(Object.freeze(quoteSubject(proof)));
      if (!quote) fail("custody_unavailable");
      const admission = quoteProof(quote);
      if (
        canonicalJson(quoteSubject(admission)) !== canonicalJson(quoteSubject(proof)) ||
        admission.requestFingerprint !== proof.requestFingerprint ||
        admission.pricingVersion !== pricingVersion ||
        admission.quotedAt > proof.closedAt
      )
        fail("custody_mismatch");
      return {
        actualUsdMicros: price(pricingVersion, proof.closedMeasurements, admission.quotedAt),
        pricingVersion,
      };
    },
  };
}

function quoteSubject(input: HostedRunQuoteInput): HostedRunQuoteInput {
  if (input.product !== "takoserver" && input.product !== "takosumi-hosted")
    fail("invalid_request");
  return {
    organizationId: opaque(input.organizationId),
    reference: opaque(input.reference),
    workspaceRef: opaque(input.workspaceRef),
    product: input.product,
  };
}

function quoteProof(input: HostedRunQuoteProof): HostedRunQuoteProof {
  if (!isSha256Digest(input.requestFingerprint)) fail("custody_mismatch");
  return {
    ...quoteSubject(input),
    requestFingerprint: input.requestFingerprint,
    quotedAt: instant(input.quotedAt),
    pricingVersion: opaque(input.pricingVersion),
    estimatedMeasurements: measurements(input.estimatedMeasurements),
  };
}

function closedProof(input: HostedRunClosedProof): HostedRunClosedProof {
  if (!isSha256Digest(input.requestFingerprint)) fail("custody_mismatch");
  const closedAt = instant(input.closedAt);
  const closedMeasurements = measurements(input.closedMeasurements);
  if (closedMeasurements.some((measurement) => measurement.periodEnd > closedAt))
    fail("custody_mismatch");
  return {
    ...quoteSubject(input),
    requestFingerprint: input.requestFingerprint,
    applyReference: opaque(input.applyReference),
    pricingVersion: opaque(input.pricingVersion),
    closedAt,
    closedMeasurements,
  };
}

function measurements(input: readonly HostedRunMeasurement[]): readonly HostedRunMeasurement[] {
  if (!Array.isArray(input) || input.length > MAX_HOSTED_RUN_MEASUREMENTS)
    fail("invalid_measurement");
  const keys = new Set<string>();
  return input.map((entry) => {
    exact(entry, ["meter", "quantityUnit", "quantity", "periodStart", "periodEnd"]);
    if (
      typeof entry.meter !== "string" ||
      !/^[a-z][a-z0-9.-]{0,127}$/u.test(entry.meter) ||
      entry.meter.includes("..") ||
      typeof entry.quantityUnit !== "string" ||
      !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(entry.quantityUnit) ||
      typeof entry.quantity !== "string" ||
      entry.quantity.length > 256 ||
      !/^(0|[1-9][0-9]*)(\.[0-9]{0,17}[1-9])?$/u.test(entry.quantity)
    )
      fail("invalid_measurement");
    const periodStart = instant(entry.periodStart);
    const periodEnd = instant(entry.periodEnd);
    if (periodStart >= periodEnd || Date.parse(periodEnd) - Date.parse(periodStart) > 31 * 86400000)
      fail("invalid_measurement");
    const key = canonicalJson([entry.meter, periodStart, periodEnd]);
    if (keys.has(key)) fail("invalid_measurement");
    keys.add(key);
    return {
      meter: entry.meter,
      quantityUnit: entry.quantityUnit,
      quantity: entry.quantity,
      periodStart,
      periodEnd,
    };
  });
}

function opaque(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value))
    fail("invalid_request");
  return value;
}

function instant(value: string): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid_measurement");
  return value;
}

function exact(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request");
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    fail("invalid_request");
}

function fail(code: HostedRunPricingError["code"]): never {
  throw new HostedRunPricingError(code);
}
