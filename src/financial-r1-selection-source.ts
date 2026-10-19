import { type BillingConfig, parseBillingConfig } from "./billing-config.ts";
import {
  captureFinancialDisplayInput,
  type FinancialDisplayedTermsR1,
} from "./financial-displayed-terms.ts";
import {
  assertHostedBillingComposition,
  type HostedBillingComposition,
} from "./hosted-billing-composition.ts";
import { canonicalJson } from "./json.ts";
import type { PaymentEventContext } from "./payment-events.ts";
import {
  createSharedFinancialActionIdentity,
  parseSharedFinancialAction,
  type SharedFinancialAction,
  type SharedFinancialActionIdentity,
} from "./shared-financial-action.ts";
import { FinancialRetainedR1Error } from "./shared-financial-retained-r1.ts";

/** Live DATA provenance only. This is not a registration, Principal, consent or R1 admission witness. */
export interface CanonicalFinancialR1SelectionData {
  readonly actionIdentity: SharedFinancialActionIdentity;
  readonly displayed: FinancialDisplayedTermsR1;
  /** Actual captured Financial clock, after the exact selection; not a freshness/authority proof. */
  readonly selectedAt: number;
}
export interface CanonicalFinancialR1SelectionOptions {
  readonly composition: HostedBillingComposition;
  readonly context: PaymentEventContext;
  readonly billingConfig: BillingConfig;
}
function unavailable(cause?: unknown): never {
  throw new FinancialRetainedR1Error("unavailable", cause === undefined ? undefined : { cause });
}
function data(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") return unavailable();
  const property = Object.getOwnPropertyDescriptor(value, key);
  if (!property || !("value" in property) || !property.enumerable) return unavailable();
  return property.value;
}
function matches(
  identity: SharedFinancialActionIdentity,
  displayed: FinancialDisplayedTermsR1,
): boolean {
  const action = identity.action,
    economic = displayed.economic;
  switch (action.kind) {
    case "topup":
      return economic.kind === action.kind && economic.amountMinor === action.amountMinor;
    case "subscription-start":
      return economic.kind === action.kind && economic.planKey === action.planKey;
    case "card-setup":
      return (
        economic.kind === action.kind &&
        economic.setupDisclosureRevision === action.setupDisclosureRevision
      );
    case "plan-change":
      return (
        economic.kind === action.kind &&
        economic.planKey === action.planKey &&
        economic.expectedSubscriptionRef === action.expectedSubscriptionRef
      );
    case "cancel":
      return (
        economic.kind === action.kind &&
        economic.cancelAtPeriodEnd === action.cancelAtPeriodEnd &&
        economic.expectedSubscriptionRef === action.expectedSubscriptionRef
      );
  }
}

/**
 * Binds existing closed action identity to the real canonical displayed selection.
 * The actual composition creates its own payment assembly; no caller selector/assembly is accepted.
 * selectNewActionData is NEW-selection DATA, never a historical replay or a registered source.
 * A future issuer must read immutable originals before calling it and own its SQL currentness CAS.
 */
export function createCanonicalFinancialR1SelectionSource(
  options: CanonicalFinancialR1SelectionOptions,
) {
  const composition = data(options, "composition") as HostedBillingComposition;
  const suppliedContext = data(options, "context") as PaymentEventContext;
  const suppliedConfig = data(options, "billingConfig") as BillingConfig;
  const sql = data(suppliedContext, "sql") as PaymentEventContext["sql"];
  const clock = data(suppliedContext, "clock") as PaymentEventContext["clock"];
  const credit = data(suppliedContext, "credit") as PaymentEventContext["credit"];
  const creditedFunding = data(
    suppliedContext,
    "creditedFunding",
  ) as PaymentEventContext["creditedFunding"];
  if (
    typeof clock !== "function" ||
    typeof credit !== "function" ||
    typeof creditedFunding !== "function"
  )
    unavailable();
  const configFields = [
    "schemaVersion",
    "revision",
    "effectiveAt",
    "currency",
    "holdTtlSeconds",
    "freeIncludedMinor",
    "purchaseCreditExpiry",
    "plans",
    "meters",
  ];
  if (!suppliedConfig || typeof suppliedConfig !== "object") return unavailable();
  if (Object.hasOwn(suppliedConfig, "history")) configFields.push("history");
  let billingConfig: BillingConfig;
  try {
    const parsed = parseBillingConfig(
      canonicalJson(captureFinancialDisplayInput(suppliedConfig, configFields)),
    );
    if (!parsed) return unavailable();
    billingConfig = parsed;
    assertHostedBillingComposition(composition, { sql, clock, billingConfig });
  } catch (error) {
    return unavailable(error);
  }
  if (!composition.paymentActivation) return unavailable();
  // Retain the original context methods and receivers. Selection never calls either funding port.
  const context: PaymentEventContext = Object.freeze({
    sql,
    clock,
    credit(input: Parameters<PaymentEventContext["credit"]>[0]) {
      return Reflect.apply(credit, suppliedContext, [input]);
    },
    creditedFunding(fundings: Parameters<PaymentEventContext["creditedFunding"]>[0]) {
      return Reflect.apply(creditedFunding, suppliedContext, [fundings]);
    },
  });
  const createPayments = composition.createPayments;
  const payments = Reflect.apply(createPayments, composition, [context]);
  const topup = composition.selectTopUpDisplayedTermsR1,
    card = composition.selectCardSetupDisplayedTermsR1;
  const start = payments.selectSubscriptionStartDisplayedTermsR1,
    plan = payments.preparePlanChangeDisplayedTermsR1,
    cancel = payments.prepareCancellationDisplayedTermsR1;
  if ([topup, card, start, plan, cancel].some((value) => typeof value !== "function"))
    return unavailable();
  const originalData = new WeakSet<object>(); // Origin of DATA only; never a persisted or authority credential.
  function currentOrigin() {
    assertHostedBillingComposition(composition, { sql, clock, billingConfig });
  }
  return Object.freeze({
    async selectNewActionData(
      input: SharedFinancialAction,
    ): Promise<CanonicalFinancialR1SelectionData> {
      let action: SharedFinancialAction;
      try {
        action = parseSharedFinancialAction(input);
      } catch (cause) {
        throw new FinancialRetainedR1Error("invalid_request", { cause });
      }
      currentOrigin();
      const actionIdentity = await createSharedFinancialActionIdentity(action);
      let displayed: FinancialDisplayedTermsR1;
      const common = { organizationId: action.organizationId, reference: action.reference };
      switch (action.kind) {
        case "topup":
          displayed = await Reflect.apply(topup, composition, [
            { ...common, amountMinor: action.amountMinor },
          ]);
          break;
        case "subscription-start":
          displayed = await Reflect.apply(start, payments, [
            { ...common, planKey: action.planKey },
          ]);
          break;
        case "card-setup":
          displayed = await Reflect.apply(card, composition, []);
          break;
        case "plan-change":
          displayed = await Reflect.apply(plan, payments, [
            {
              ...common,
              expectedSubscriptionRef: action.expectedSubscriptionRef,
              planKey: action.planKey,
            },
          ]);
          break;
        case "cancel":
          displayed = await Reflect.apply(cancel, payments, [
            {
              ...common,
              expectedSubscriptionRef: action.expectedSubscriptionRef,
            },
          ]);
          break;
      }
      currentOrigin();
      if (!matches(actionIdentity, displayed)) throw new FinancialRetainedR1Error("conflict");
      const selectedAt = clock().getTime();
      if (!Number.isSafeInteger(selectedAt) || selectedAt < 0) return unavailable();
      const result = Object.freeze({ actionIdentity, displayed, selectedAt });
      originalData.add(result);
      return result;
    },
    /** Same-live-source DATA origin only. No SQL registration/currentness, Root permission or history is established. */
    assertData(value: unknown): void {
      currentOrigin();
      if (!value || typeof value !== "object" || !originalData.has(value)) unavailable();
    },
  });
}
