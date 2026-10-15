import { canonicalDigest } from "./json.ts";
import { parseStrictJson } from "./strict-json.ts";

/** Local data recipe, separate from existing processor and Accounts domains. */
export const SHARED_FINANCIAL_ACTION_VERSION = "takoserver-shared-financial-action-v1";

interface ActionReference {
  readonly organizationId: string;
  readonly reference: string;
}

/** Existing public body fields plus local action kind and path Organization. */
export type SharedFinancialAction = ActionReference &
  (
    | { readonly kind: "topup"; readonly amountMinor: number }
    | { readonly kind: "subscription-start"; readonly planKey: string }
    | { readonly kind: "card-setup"; readonly setupDisclosureRevision: string }
    | {
        readonly kind: "plan-change";
        readonly planKey: string;
        readonly expectedSubscriptionRef: string;
      }
    | {
        readonly kind: "cancel";
        readonly cancelAtPeriodEnd: true;
        readonly expectedSubscriptionRef: string;
      }
  );

export interface SharedFinancialActionIdentity {
  readonly version: typeof SHARED_FINANCIAL_ACTION_VERSION;
  readonly action: SharedFinancialAction;
  readonly requestFingerprint: `sha256:${string}`;
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SUBSCRIPTION_REFERENCE = /^sra_[0-9a-f]{64}$/u;
const COMMON_FIELDS = ["kind", "organizationId", "reference"];

function invalid(): never {
  throw new TypeError("invalid shared financial action");
}

function snapshot(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") invalid();
    const descriptor = descriptors[key];
    if (!descriptor || !Object.hasOwn(descriptor, "value") || descriptor.enumerable !== true)
      invalid();
    result[key] = descriptor.value;
  }
  return result;
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): void {
  const keys = Object.keys(value);
  const expected = [...COMMON_FIELDS, ...fields];
  if (keys.length !== expected.length || expected.some((key) => !Object.hasOwn(value, key)))
    invalid();
}

function reference(value: unknown): string {
  if (typeof value !== "string" || !REFERENCE.test(value)) invalid();
  return value;
}

function subscriptionReference(value: unknown): string {
  if (typeof value !== "string" || !SUBSCRIPTION_REFERENCE.test(value)) invalid();
  return value;
}

function text(value: unknown, limit: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > limit) invalid();
  // Keep the existing HTTP parser's Unicode-scalar constraint without adding
  // current plan membership or another lexical plan-key policy.
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  try {
    parseStrictJson(bytes, bytes.byteLength);
  } catch {
    invalid();
  }
  return value;
}

/**
 * Detaches closed public request data synchronously. It neither selects terms
 * nor establishes credential, consent, payer, replay or admission authority.
 */
export function parseSharedFinancialAction(input: unknown): SharedFinancialAction {
  const value = snapshot(input);
  const organizationId = reference(value.organizationId);
  const originalReference = reference(value.reference);
  const common = { organizationId, reference: originalReference };
  switch (value.kind) {
    case "topup": {
      exactFields(value, ["amountMinor"]);
      const amountMinor = value.amountMinor;
      if (typeof amountMinor !== "number" || !Number.isSafeInteger(amountMinor) || amountMinor <= 0)
        invalid();
      // Public route validation only. New-command purchase bounds and the
      // writer's representable micro amount remain separate selections.
      return Object.freeze({ ...common, kind: "topup", amountMinor });
    }
    case "subscription-start":
      exactFields(value, ["planKey"]);
      return Object.freeze({
        ...common,
        kind: "subscription-start",
        planKey: text(value.planKey, 1024),
      });
    case "card-setup":
      exactFields(value, ["setupDisclosureRevision"]);
      return Object.freeze({
        ...common,
        kind: "card-setup",
        setupDisclosureRevision: reference(value.setupDisclosureRevision),
      });
    case "plan-change":
      exactFields(value, ["planKey", "expectedSubscriptionRef"]);
      return Object.freeze({
        ...common,
        kind: "plan-change",
        planKey: text(value.planKey, 64),
        expectedSubscriptionRef: subscriptionReference(value.expectedSubscriptionRef),
      });
    case "cancel":
      exactFields(value, ["cancelAtPeriodEnd", "expectedSubscriptionRef"]);
      if (value.cancelAtPeriodEnd !== true) invalid();
      return Object.freeze({
        ...common,
        kind: "cancel",
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: subscriptionReference(value.expectedSubscriptionRef),
      });
    default:
      invalid();
  }
}

/**
 * New local recipe: canonicalDigest([version, detachedAction]). Existing
 * reference lookup and original selected terms remain the caller's concern;
 * this identity does not replace any legacy processor fingerprint or key.
 */
export async function createSharedFinancialActionIdentity(
  input: unknown,
): Promise<SharedFinancialActionIdentity> {
  const action = parseSharedFinancialAction(input);
  const requestFingerprint = await canonicalDigest([SHARED_FINANCIAL_ACTION_VERSION, action]);
  return Object.freeze({ version: SHARED_FINANCIAL_ACTION_VERSION, action, requestFingerprint });
}
