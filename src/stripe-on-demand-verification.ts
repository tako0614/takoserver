import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { minorToMicros } from "./money.ts";
import type { Sql } from "./ports.ts";
import type { StripeBillingClient } from "./stripe-billing-client.ts";
import { verifyStripeCustomerBinding } from "./stripe-customer-custody.ts";

export interface StripeOnDemandVerificationContext {
  readonly sql: Sql;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
}
export interface StripeOnDemandCardExpected {
  readonly organizationId: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly verifiedAt: string;
  /** Optional original setup provenance, never merchant cash consent. */
  readonly setupIntentId?: string;
}
export interface StripeOnDemandCardProof {
  readonly kind: "stripe-saved-card";
  readonly organizationId: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly setupIntentId: string | null;
  readonly accountId: string;
  readonly mode: "test";
  readonly financialRealm: string;
  readonly billingAuthority: string;
  readonly verifiedAt: string;
}
export interface StripeOnDemandOriginalMetadata {
  readonly organizationId: string;
  readonly reference: string;
  readonly fingerprint: string;
  readonly stripeAccountId: string;
  readonly financialRealm: string;
  readonly billingAuthority: string;
  readonly fundingRef: string;
}
export interface StripeOnDemandFundingExpected {
  readonly organizationId: string;
  readonly reference: string;
  readonly fingerprint: string;
  readonly fundingRef: string;
  readonly accountId: string;
  readonly mode: "test";
  readonly financialRealm: string;
  readonly billingAuthority: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly paymentIntentId: string;
  readonly chargeId: string;
  readonly currency: "USD";
  readonly amountMinor: number;
  readonly observedAt: string;
  readonly metadata: StripeOnDemandOriginalMetadata;
}
export interface StripeOnDemandFundingProof {
  readonly kind: "stripe-on-demand-funding";
  readonly sourceType: "payment-intent";
  readonly organizationId: string;
  readonly reference: string;
  readonly fingerprint: string;
  readonly fundingRef: string;
  readonly accountId: string;
  readonly mode: "test";
  readonly financialRealm: string;
  readonly billingAuthority: string;
  readonly customerId: string;
  readonly paymentMethodId: string;
  readonly paymentIntentId: string;
  readonly chargeId: string;
  readonly currency: "USD";
  readonly amountMinor: number;
  /** Original refunded consideration, not permission to grant its gross amount again. */
  readonly refundedAmountMinor: number;
  readonly observedAt: string;
}

export class StripeOnDemandVerificationError extends Error {
  constructor(
    readonly code:
      | "invalid_expected"
      | "unqualified_realm"
      | "customer_unavailable"
      | "card_unavailable"
      | "invalid_setup"
      | "invalid_funding"
      | "unavailable",
  ) {
    super(code);
    this.name = "StripeOnDemandVerificationError";
  }
}
type Code = StripeOnDemandVerificationError["code"];
const FUNDING_METADATA_KEYS = [
  "organizationId",
  "reference",
  "fingerprint",
  "fundingRef",
  "stripeAccountId",
  "financialRealm",
  "billingAuthority",
] as const;
function fail(code: Code): never {
  throw new StripeOnDemandVerificationError(code);
}
function record(value: unknown, code: Code): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(code);
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) fail(code);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor)) fail(code);
  }
  return value as Record<string, unknown>;
}
function id(value: unknown, prefix: string, code: Code): string {
  if (
    typeof value !== "string" ||
    value.length > 255 ||
    !value.startsWith(prefix) ||
    !/^[A-Za-z0-9_]+$/u.test(value.slice(prefix.length))
  )
    fail(code);
  return value;
}
function label(value: unknown, maximum: number, code: Code): string {
  if (
    typeof value !== "string" ||
    value.length > maximum ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(value)
  )
    fail(code);
  return value;
}
function instant(value: unknown): string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail("invalid_expected");
  return value;
}
function nativeObject(value: unknown, object: string, expectedId: string, code: Code) {
  const native = record(value, code);
  if (
    native.object !== object ||
    native.id !== expectedId ||
    native.livemode !== false ||
    native.deleted === true ||
    [
      "account",
      "application",
      "application_fee",
      "application_fee_amount",
      "on_behalf_of",
      "transfer_data",
      "transfer",
      "source_transfer",
      "destination",
    ].some((key) => native[key] != null)
  )
    fail(code);
  return native;
}

/**
 * Fresh saved-card observation only. It supplies no merchant consent, guarantee
 * of a future charge, fresh-admission authority or capability activation.
 * Original funding/setup drains must not require this current-card check.
 */
export async function verifyStripeOnDemandCard(
  context: StripeOnDemandVerificationContext,
  expected: StripeOnDemandCardExpected,
): Promise<StripeOnDemandCardProof> {
  try {
    record(expected, "invalid_expected");
    const organizationId = label(expected.organizationId, 128, "invalid_expected");
    const customerId = id(expected.customerId, "cus_", "invalid_expected");
    const paymentMethodId = id(expected.paymentMethodId, "pm_", "invalid_expected");
    const setupIntentId =
      expected.setupIntentId === undefined
        ? null
        : id(expected.setupIntentId, "seti_", "invalid_expected");
    const verifiedAt = instant(expected.verifiedAt);
    const { sql, client, realm } = context;
    const captured = { sql, client, realm };
    try {
      assertHostedBillingFinancialRealm(realm, {
        sql,
        client,
        billingAuthority: realm.billingAuthority,
      });
    } catch {
      fail("unqualified_realm");
    }
    const customer = async () => {
      try {
        await verifyStripeCustomerBinding(captured, organizationId, customerId);
      } catch {
        fail("customer_unavailable");
      }
    };
    await customer();
    const read = async (kind: "payment_methods" | "setup_intents", nativeId: string) => {
      try {
        return await client.get(kind, nativeId);
      } catch {
        return fail("unavailable");
      }
    };
    const method = nativeObject(
      await read("payment_methods", paymentMethodId),
      "payment_method",
      paymentMethodId,
      "card_unavailable",
    );
    if (method.customer !== customerId || method.type !== "card") fail("card_unavailable");
    const card = record(method.card, "card_unavailable");
    const month = card.exp_month;
    const year = card.exp_year;
    const date = new Date(verifiedAt);
    if (
      typeof month !== "number" ||
      !Number.isInteger(month) ||
      month < 1 ||
      month > 12 ||
      typeof year !== "number" ||
      !Number.isInteger(year) ||
      year < 1000 ||
      year > 9999 ||
      year * 12 + month < date.getUTCFullYear() * 12 + date.getUTCMonth() + 1
    )
      fail("card_unavailable");
    if (setupIntentId !== null) {
      const setup = nativeObject(
        await read("setup_intents", setupIntentId),
        "setup_intent",
        setupIntentId,
        "invalid_setup",
      );
      if (
        setup.status !== "succeeded" ||
        setup.usage !== "off_session" ||
        setup.customer !== customerId ||
        setup.payment_method !== paymentMethodId ||
        setup.attach_to_self === true
      )
        fail("invalid_setup");
    }
    // Detect association/customer drift across both asynchronous card reads.
    await customer();
    return Object.freeze({
      kind: "stripe-saved-card",
      organizationId,
      customerId,
      paymentMethodId,
      setupIntentId,
      accountId: realm.accountId,
      mode: realm.mode,
      financialRealm: realm.financialRealm,
      billingAuthority: realm.billingAuthority,
      verifiedAt,
    });
  } catch (error) {
    if (error instanceof StripeOnDemandVerificationError) throw error;
    return fail("unavailable");
  }
}

function original(expected: StripeOnDemandFundingExpected): StripeOnDemandFundingExpected {
  record(expected, "invalid_expected");
  label(expected.organizationId, 128, "invalid_expected");
  for (const value of [
    expected.reference,
    expected.fundingRef,
    expected.financialRealm,
    expected.billingAuthority,
  ])
    label(value, 256, "invalid_expected");
  label(expected.fingerprint, 512, "invalid_expected");
  id(expected.accountId, "acct_", "invalid_expected");
  id(expected.customerId, "cus_", "invalid_expected");
  id(expected.paymentMethodId, "pm_", "invalid_expected");
  id(expected.paymentIntentId, "pi_", "invalid_expected");
  id(expected.chargeId, "ch_", "invalid_expected");
  if (expected.currency !== "USD" || expected.mode !== "test" || expected.amountMinor <= 0)
    fail("invalid_expected");
  try {
    minorToMicros(expected.amountMinor);
  } catch {
    fail("invalid_expected");
  }
  instant(expected.observedAt);
  const metadata = record(expected.metadata, "invalid_expected");
  const bindings = {
    organizationId: expected.organizationId,
    reference: expected.reference,
    fingerprint: expected.fingerprint,
    fundingRef: expected.fundingRef,
    stripeAccountId: expected.accountId,
    financialRealm: expected.financialRealm,
    billingAuthority: expected.billingAuthority,
  };
  if (
    Reflect.ownKeys(metadata).length !== FUNDING_METADATA_KEYS.length ||
    FUNDING_METADATA_KEYS.some(
      (key) => !Object.hasOwn(metadata, key) || metadata[key] !== bindings[key],
    )
  )
    fail("invalid_expected");
  return expected;
}

/**
 * Pure original-source structural verification. The caller must retrieve these
 * objects through its qualified authenticated client and retain command/dispatch
 * custody. This receipt alone authorizes no POST, grant, cap closure or refund.
 * No current consent/card lookup occurs; already-paid original drains survive it.
 */
export function verifyStripeOnDemandFunding(
  expected: StripeOnDemandFundingExpected,
  objects: { readonly paymentIntent: unknown; readonly charge: unknown },
): StripeOnDemandFundingProof {
  try {
    const pinned = original(expected);
    record(objects, "invalid_funding");
    const intent = nativeObject(
      objects.paymentIntent,
      "payment_intent",
      pinned.paymentIntentId,
      "invalid_funding",
    );
    const metadata = record(intent.metadata, "invalid_funding");
    if (
      intent.status !== "succeeded" ||
      intent.customer !== pinned.customerId ||
      intent.payment_method !== pinned.paymentMethodId ||
      intent.currency !== "usd" ||
      intent.amount !== pinned.amountMinor ||
      intent.amount_received !== pinned.amountMinor ||
      intent.amount_capturable !== 0 ||
      intent.invoice != null ||
      FUNDING_METADATA_KEYS.some(
        (key) => !Object.hasOwn(metadata, key) || metadata[key] !== pinned.metadata[key],
      )
    )
      fail("invalid_funding");
    const charge = nativeObject(objects.charge, "charge", pinned.chargeId, "invalid_funding");
    const verifyCharge = (value: Record<string, unknown>) => {
      const refunded = value.amount_refunded;
      const details = record(value.payment_method_details, "invalid_funding");
      if (
        details.type !== "card" ||
        value.payment_intent !== pinned.paymentIntentId ||
        value.payment_method !== pinned.paymentMethodId ||
        value.customer !== pinned.customerId ||
        value.currency !== "usd" ||
        value.amount !== pinned.amountMinor ||
        value.amount_captured !== pinned.amountMinor ||
        value.paid !== true ||
        value.captured !== true ||
        value.status !== "succeeded" ||
        value.disputed !== false ||
        value.invoice != null ||
        typeof refunded !== "number" ||
        !Number.isSafeInteger(refunded) ||
        refunded < 0 ||
        refunded > pinned.amountMinor ||
        value.refunded !== (refunded === pinned.amountMinor)
      )
        fail("invalid_funding");
      return refunded;
    };
    let expandedRefundedAmountMinor: number | undefined;
    if (typeof intent.latest_charge === "string") {
      if (intent.latest_charge !== pinned.chargeId) fail("invalid_funding");
    } else {
      const expanded = nativeObject(
        intent.latest_charge,
        "charge",
        pinned.chargeId,
        "invalid_funding",
      );
      expandedRefundedAmountMinor = verifyCharge(expanded);
    }
    const refundedAmountMinor = verifyCharge(charge);
    // A stale separate read cannot discard refunded consideration already seen
    // on this same original Charge. Retain the uncertainty for the caller.
    if (
      expandedRefundedAmountMinor !== undefined &&
      refundedAmountMinor < expandedRefundedAmountMinor
    )
      fail("invalid_funding");
    return Object.freeze({
      kind: "stripe-on-demand-funding",
      sourceType: "payment-intent",
      organizationId: pinned.organizationId,
      reference: pinned.reference,
      fingerprint: pinned.fingerprint,
      fundingRef: pinned.fundingRef,
      accountId: pinned.accountId,
      mode: pinned.mode,
      financialRealm: pinned.financialRealm,
      billingAuthority: pinned.billingAuthority,
      customerId: pinned.customerId,
      paymentMethodId: pinned.paymentMethodId,
      paymentIntentId: pinned.paymentIntentId,
      chargeId: pinned.chargeId,
      currency: pinned.currency,
      amountMinor: pinned.amountMinor,
      refundedAmountMinor,
      observedAt: pinned.observedAt,
    });
  } catch (error) {
    if (error instanceof StripeOnDemandVerificationError) throw error;
    return fail("invalid_funding");
  }
}
