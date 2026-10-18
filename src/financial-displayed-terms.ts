import {
  type BillingConfig,
  type PurchaseCreditExpiry,
  parseBillingConfig,
} from "./billing-config.ts";
import { base64UrlEncode, bytesDigest, canonicalJson } from "./json.ts";
import { type OrgOnDemandTerms, parseOrgOnDemandTerms } from "./org-on-demand-terms.ts";
import {
  FinancialRetainedR1Error,
  type SelectedEconomicR1,
  type SelectedTermsOriginal,
} from "./shared-financial-retained-r1.ts";
import { financialSourceRef } from "./shared-financial-source-contract.ts";

const MAX_TERMS_BYTES = 32_768;
const MEDIA_TYPE = "text/plain; charset=utf-8";
const LOCALE = "en";
const TERMS_RECIPE = "financial-terms-utf8-sha256-v1";

/** Financial-owned display DATA. This is not consent, registration, R1.prepare or admission permission. */
export interface FinancialDisplayedTermsR1 {
  readonly economic: SelectedEconomicR1;
  readonly selectedTerms: SelectedTermsOriginal;
  /** Encode this exact immutable string as UTF-8 for display; never re-render its fields. */
  readonly displayText: string;
}

export interface FinancialDisplayedTermsPolicy {
  readonly billingConfig: BillingConfig;
  readonly plans: readonly {
    readonly planKey: string;
    readonly priceId: string;
    readonly priceAmountMinor: number;
    readonly includedMinor: number;
  }[];
  readonly checkoutBounds: { readonly minimumMinor: number; readonly maximumMinor: number };
  readonly onDemand: {
    readonly setupDisclosureRevision: string;
    readonly terms: OrgOnDemandTerms;
  } | null;
  readonly postpaidEnabled: false;
}

type Code = FinancialRetainedR1Error["code"];
function fail(code: Code, cause?: unknown): never {
  throw new FinancialRetainedR1Error(code, cause === undefined ? undefined : { cause });
}

/** Own data only: do not execute getters/toJSON or retain aliases across any digest await. */
function detach(input: unknown, code: Code): unknown {
  let nodes = 50_000,
    bytes = 1_048_576;
  const ancestors = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (--nodes < 0 || depth > 24) fail(code);
    if (typeof value === "string") {
      const raw = new TextEncoder().encode(value);
      bytes -= raw.length;
      if (bytes < 0 || new TextDecoder("utf-8", { fatal: true }).decode(raw) !== value) fail(code);
      return value;
    }
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isSafeInteger(value) || Object.is(value, -0)) fail(code);
      return value;
    }
    if (!value || typeof value !== "object" || ancestors.has(value)) fail(code);
    const array = Array.isArray(value);
    if (
      array
        ? Object.getPrototypeOf(value) !== Array.prototype
        : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    )
      fail(code);
    const keys = Reflect.ownKeys(value);
    if (array && keys.length !== value.length + 1) fail(code);
    ancestors.add(value);
    try {
      const copy: Record<string, unknown> | unknown[] = array ? [] : Object.create(null);
      for (const key of keys) {
        if (array && key === "length") continue;
        if (typeof key !== "string") fail(code);
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) fail(code);
        Object.defineProperty(copy, key, {
          value: visit(descriptor.value, depth + 1),
          enumerable: true,
        });
      }
      return Object.freeze(copy);
    } finally {
      ancestors.delete(value);
    }
  }
  return visit(input, 0);
}
function exact(value: unknown, fields: readonly string[], code: Code): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Reflect.ownKeys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field))
  )
    fail(code);
  return value as Record<string, unknown>;
}
function ref(value: unknown, code: Code): string {
  return financialSourceRef(value) ? value : fail(code);
}
function integer(value: unknown, minimum: number, code: Code): number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum
    ? value
    : fail(code);
}
function usd(minor: number): string {
  const cents = BigInt(integer(minor, 0, "invalid_request"));
  return `USD ${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
function expiry(value: PurchaseCreditExpiry): string {
  return value.kind === "none"
    ? "no expiry"
    : `${value.seconds} seconds after first verified funding`;
}
function quoted(value: string): string {
  return JSON.stringify(value);
}

/** Detachment only, before invoking the existing selector; not a source/identity qualifier. */
export function captureFinancialDisplayInput<T extends object>(
  input: T,
  fields: readonly string[],
): Readonly<T> {
  return exact(detach(input, "invalid_request"), fields, "invalid_request") as Readonly<T>;
}

const FIELDS = {
  topup: [
    "kind",
    "amountMinor",
    "currency",
    "pricingRevision",
    "purchaseCreditExpiry",
    "minimumMinor",
    "maximumMinor",
  ],
  "subscription-start": [
    "kind",
    "planKey",
    "pricingRevision",
    "priceId",
    "priceAmountMinor",
    "includedMinor",
    "currency",
    "periodMonths",
  ],
  "card-setup": ["kind", "setupDisclosureRevision", "onDemandTermsRevision"],
  "plan-change": [
    "kind",
    "expectedSubscriptionRef",
    "targetSubscriptionId",
    "targetGeneration",
    "targetPeriodStart",
    "targetPeriodEnd",
    "planKey",
    "pricingRevision",
    "priceId",
    "priceAmountMinor",
    "includedMinor",
    "currency",
  ],
  cancel: [
    "kind",
    "expectedSubscriptionRef",
    "targetSubscriptionId",
    "targetGeneration",
    "branch",
    "pendingReference",
    "scheduleId",
    "cancelAtPeriodEnd",
  ],
} as const;

/**
 * Pure rendering component. The canonical composition below owns the real selector call;
 * a structurally valid DTO here does not qualify an economic source, caller or registration.
 * No body/terms DTO, policy default, locale override, clock, SQL or provider port is accepted.
 */
export function createFinancialDisplayedTermsSource(input: FinancialDisplayedTermsPolicy) {
  const raw = exact(
    detach(input, "unavailable"),
    ["billingConfig", "plans", "checkoutBounds", "onDemand", "postpaidEnabled"],
    "unavailable",
  );
  let billing: BillingConfig;
  let onDemand: FinancialDisplayedTermsPolicy["onDemand"];
  try {
    const parsed = parseBillingConfig(canonicalJson(raw.billingConfig));
    if (!parsed || raw.postpaidEnabled !== false) fail("unavailable");
    billing = parsed;
    if (raw.onDemand === null) onDemand = null;
    else {
      const configured = exact(raw.onDemand, ["setupDisclosureRevision", "terms"], "unavailable");
      onDemand = Object.freeze({
        setupDisclosureRevision: ref(configured.setupDisclosureRevision, "unavailable"),
        terms: parseOrgOnDemandTerms(configured.terms),
      });
    }
  } catch (error) {
    return fail("unavailable", error);
  }
  const bounds = exact(raw.checkoutBounds, ["minimumMinor", "maximumMinor"], "unavailable");
  const minimumMinor = integer(bounds.minimumMinor, 1, "unavailable");
  const maximumMinor = integer(bounds.maximumMinor, minimumMinor, "unavailable");
  if (!Array.isArray(raw.plans)) fail("unavailable");
  const plans = new Map<string, FinancialDisplayedTermsPolicy["plans"][number]>();
  for (const value of raw.plans) {
    const p = exact(
      value,
      ["planKey", "priceId", "priceAmountMinor", "includedMinor"],
      "unavailable",
    );
    const plan = Object.freeze({
      planKey: ref(p.planKey, "unavailable"),
      priceId: ref(p.priceId, "unavailable"),
      priceAmountMinor: integer(p.priceAmountMinor, 1, "unavailable"),
      includedMinor: integer(p.includedMinor, 0, "unavailable"),
    });
    if (
      plans.has(plan.planKey) ||
      billing.plans[plan.planKey]?.stripePriceId !== plan.priceId ||
      billing.plans[plan.planKey]?.includedMinor !== plan.includedMinor
    )
      fail("unavailable");
    plans.set(plan.planKey, plan);
  }

  function economic(selection: SelectedEconomicR1): SelectedEconomicR1 {
    const value = detach(selection, "invalid_request");
    if (!value || typeof value !== "object" || Array.isArray(value)) fail("invalid_request");
    const record = value as Record<string, unknown>;
    const kind = record.kind;
    if (typeof kind !== "string" || !Object.hasOwn(FIELDS, kind)) fail("invalid_request");
    const fields = FIELDS[kind as keyof typeof FIELDS];
    // These three fields belong only to the real topup/start selector result.
    // R1 already owns realm separately; its economic image has the existing exact fields.
    const metadata =
      (kind === "topup" || kind === "subscription-start") && Object.hasOwn(record, "accountId");
    exact(
      record,
      metadata ? [...fields, "accountId", "livemode", "financialRealm"] : fields,
      "invalid_request",
    );
    if (
      metadata &&
      (typeof record.accountId !== "string" ||
        record.livemode !== false ||
        typeof record.financialRealm !== "string")
    )
      fail("invalid_request");
    const e = Object.fromEntries(fields.map((field) => [field, record[field]]));
    if (kind === "topup") {
      const amount = integer(e.amountMinor, 1, "invalid_request");
      if (
        e.currency !== "USD" ||
        e.pricingRevision !== billing.revision ||
        e.minimumMinor !== minimumMinor ||
        e.maximumMinor !== maximumMinor ||
        amount < minimumMinor ||
        amount > maximumMinor ||
        canonicalJson(e.purchaseCreditExpiry) !== canonicalJson(billing.purchaseCreditExpiry)
      )
        fail("unavailable");
    } else if (kind === "subscription-start" || kind === "plan-change") {
      const plan = plans.get(ref(e.planKey, "invalid_request"));
      if (
        !plan ||
        e.currency !== "USD" ||
        e.pricingRevision !== billing.revision ||
        e.priceId !== plan.priceId ||
        e.priceAmountMinor !== plan.priceAmountMinor ||
        e.includedMinor !== plan.includedMinor ||
        (kind === "subscription-start" && e.periodMonths !== 1)
      )
        fail("unavailable");
      if (kind === "plan-change") {
        ref(e.expectedSubscriptionRef, "invalid_request");
        ref(e.targetSubscriptionId, "invalid_request");
        integer(e.targetGeneration, 0, "invalid_request");
        for (const instant of [e.targetPeriodStart, e.targetPeriodEnd]) {
          if (
            typeof instant !== "string" ||
            !Number.isSafeInteger(Date.parse(instant)) ||
            new Date(instant).toISOString() !== instant
          )
            fail("invalid_request");
        }
      }
    } else if (kind === "card-setup") {
      if (
        !onDemand ||
        e.setupDisclosureRevision !== onDemand.setupDisclosureRevision ||
        e.onDemandTermsRevision !== onDemand.terms.termsRevision
      )
        fail("unavailable");
    } else {
      ref(e.expectedSubscriptionRef, "invalid_request");
      ref(e.targetSubscriptionId, "invalid_request");
      integer(e.targetGeneration, 0, "invalid_request");
      if (
        (e.branch !== "legacy" && e.branch !== "pending-plan-change") ||
        e.cancelAtPeriodEnd !== true
      )
        fail("invalid_request");
      for (const value of [e.pendingReference, e.scheduleId])
        if (value !== null) ref(value, "invalid_request");
    }
    return Object.freeze(e) as unknown as SelectedEconomicR1;
  }

  return Object.freeze({
    async fromEconomic(selection: SelectedEconomicR1): Promise<FinancialDisplayedTermsR1> {
      const selected = economic(selection); // Detached before the first SHA await.
      const lines = ["Takoserver hosted billing selection", ""];
      switch (selected.kind) {
        case "topup":
          lines.push(
            "Action: add prepaid credit",
            `Payment and purchased credit face value: ${usd(selected.amountMinor)}`,
            `Purchase credit expiry: ${expiry(selected.purchaseCreditExpiry)}`,
            `Top-up bounds: ${usd(selected.minimumMinor)} to ${usd(selected.maximumMinor)}`,
          );
          break;
        case "subscription-start":
          lines.push(
            "Action: start subscription",
            `Plan: ${quoted(selected.planKey)}`,
            `Payment per ${selected.periodMonths} month: ${usd(selected.priceAmountMinor)}`,
            `Included credit per period: ${usd(selected.includedMinor)}`,
          );
          break;
        case "plan-change":
          lines.push(
            "Action: change subscription plan",
            `Selected plan: ${quoted(selected.planKey)}`,
            `Selected plan payment per month: ${usd(selected.priceAmountMinor)}`,
            `Selected plan included credit per period: ${usd(selected.includedMinor)}`,
            `Target period start: ${selected.targetPeriodStart}`,
            `Target period end: ${selected.targetPeriodEnd}`,
            `Change effective at target period end: ${selected.targetPeriodEnd}`,
          );
          break;
        case "cancel":
          lines.push(
            "Action: cancel subscription",
            "Cancel at period end: true",
            `Pending plan change: ${selected.branch === "pending-plan-change" ? "present" : "absent"}`,
          );
          break;
        case "card-setup": {
          if (!onDemand) return fail("unavailable");
          const terms = onDemand.terms,
            replenishment = terms.replenishment;
          lines.push(
            "Action: save a payment card",
            `Setup disclosure revision: ${quoted(selected.setupDisclosureRevision)}`,
            `On-demand terms revision: ${quoted(selected.onDemandTermsRevision)}`,
            `Separate on-demand consent revision: ${quoted(terms.consentRevision)}`,
            `On-demand terms valid from: ${terms.validity.validFrom}`,
            `On-demand terms valid until (exclusive): ${terms.validity.validUntil}`,
            `Replenishment trigger: ${replenishment.trigger}`,
            `Replenishment rule: ${replenishment.rule}`,
            `Funding quantum: ${usd(replenishment.fundingQuantumMinor)}`,
            `Minimum single charge: ${usd(replenishment.minimumChargeMinor)}`,
            `Maximum single charge: ${usd(replenishment.maximumChargeMinor)}`,
            `Monthly cash-cap selection bounds: ${usd(terms.cashCapBounds.minimumMinor)} to ${usd(terms.cashCapBounds.maximumMinor)}`,
            `On-demand purchased-credit expiry: ${expiry(terms.purchaseCreditExpiry)}`,
            "A saved card alone does not enable on-demand funding; a separate limit-policy choice is required.",
          );
          break;
        }
      }
      lines.push(
        "",
        `Configured pricing revision: ${quoted(billing.revision)}`,
        "Currency: USD",
        `Configured hold TTL in seconds: ${billing.holdTtlSeconds}`,
        "Postpaid: disabled",
        "Configured usage rates (exact microUSD per unit):",
      );
      for (const name of Object.keys(billing.meters).sort()) {
        const meter = billing.meters[name];
        if (!meter) return fail("unavailable");
        lines.push(
          `${quoted(name)}: ${meter.rate.numeratorMicros}/${meter.rate.denominator} microUSD per ${quoted(meter.unit)}`,
        );
      }
      const displayText = `${lines.join("\n")}\n`;
      const bytes = new TextEncoder().encode(displayText);
      if (
        bytes.length < 1 ||
        bytes.length > MAX_TERMS_BYTES ||
        new TextDecoder("utf-8", { fatal: true }).decode(bytes) !== displayText
      )
        return fail("unavailable");
      const digest = await bytesDigest(bytes);
      const terms: SelectedTermsOriginal = Object.freeze({
        ref: `terms:${digest.slice(7)}`,
        digest,
        mediaType: MEDIA_TYPE,
        locale: LOCALE,
        bodyUtf8Base64url: base64UrlEncode(bytes),
        bodyByteLength: bytes.length,
        digestRecipe: TERMS_RECIPE,
      });
      return Object.freeze({ economic: selected, selectedTerms: terms, displayText });
    },
  });
}
