import type { FinancialHostedBrowserRequestOriginal } from "./financial-hosted-browser-request.ts";
import {
  parseSharedFinancialAction,
  type SharedFinancialAction,
} from "./shared-financial-action.ts";

/** Server-owned mirror of Hosted's published browser DATA ABI. No Hosted source import. */
export const HOSTED_BROWSER_BILLING_CONTRACT = "hosted-browser-v1" as const;

export interface HostedBrowserBillingScope {
  readonly continuationRef: string;
  readonly canonicalAccountId: string;
  readonly workspaceId: string;
  readonly workspaceRef: string;
  readonly organizationId: string;
  readonly billingSourceRef: string;
  readonly sourceEpoch: string;
}

interface HostedBrowserBillingBaseClaim {
  readonly ownerId: string;
  readonly organizationId: string;
  readonly billingSourceRef: string;
  readonly operationKey: string;
  readonly reference: string;
}

export type HostedBrowserBillingAction =
  | {
      readonly family: "topup";
      readonly request: {
        readonly workspaceId: string;
        readonly operationKey: string;
        readonly amountMinor: number;
        readonly checkoutConsent: "interactive-checkout";
        readonly expectedOperationKey?: string;
      };
      readonly claim: HostedBrowserBillingBaseClaim & { readonly amountMinor: number };
    }
  | {
      readonly family: "subscription";
      readonly request: {
        readonly workspaceId: string;
        readonly operationKey: string;
        readonly planKey: string;
        readonly consent: "subscription-checkout";
        readonly expectedOperationKey?: string;
        readonly reconcileOriginalConsent?:
          | "retry-original-subscription"
          | "check-original-subscription";
      };
      readonly claim: HostedBrowserBillingBaseClaim & {
        readonly sourceEpoch: string;
        readonly kind: "start";
        readonly planKey: string;
      };
    }
  | {
      readonly family: "subscription";
      readonly request: {
        readonly workspaceId: string;
        readonly operationKey: string;
        readonly consent: "cancel-subscription";
        readonly expectedOperationKey?: string;
      };
      readonly claim: HostedBrowserBillingBaseClaim & {
        readonly sourceEpoch: string;
        readonly kind: "cancel";
        readonly expectedSubscriptionRef: string;
      };
    }
  | {
      readonly family: "subscription";
      readonly request: {
        readonly workspaceId: string;
        readonly operationKey: string;
        readonly planKey: string;
        readonly consent: "change-subscription-plan";
        readonly expectedOperationKey?: string;
      };
      readonly claim: HostedBrowserBillingBaseClaim & {
        readonly sourceEpoch: string;
        readonly kind: "change-plan";
        readonly planKey: string;
        readonly expectedSubscriptionRef: string;
      };
    };

export interface HostedBrowserBillingOriginal {
  readonly contractVersion: typeof HOSTED_BROWSER_BILLING_CONTRACT;
  readonly scope: HostedBrowserBillingScope;
  readonly action: HostedBrowserBillingAction;
}

export type HostedBrowserBillingChoice =
  | {
      readonly kind: "topup";
      readonly amountMinor: number;
      readonly checkoutConsent: "interactive-checkout";
    }
  | {
      readonly kind: "start";
      readonly planKey: string;
      readonly consent: "subscription-checkout";
      readonly reconcileOriginalConsent?:
        | "retry-original-subscription"
        | "check-original-subscription";
    }
  | { readonly kind: "cancel"; readonly consent: "cancel-subscription" }
  | {
      readonly kind: "change-plan";
      readonly planKey: string;
      readonly consent: "change-subscription-plan";
    };

export type HostedBrowserBillingCurrentSelection =
  | Extract<HostedBrowserBillingChoice, { readonly kind: "topup" | "start" }>
  | (Extract<HostedBrowserBillingChoice, { readonly kind: "cancel" | "change-plan" }> & {
      readonly expectedSubscriptionRef: string;
    });

export class HostedBrowserContinuationError extends Error {
  constructor(readonly code: "invalid" | "unavailable") {
    super(`hosted_browser_continuation_${code}`);
    this.name = "HostedBrowserContinuationError";
  }
}

function invalid(): never {
  throw new HostedBrowserContinuationError("invalid");
}

function record(
  value: unknown,
  required: readonly string[],
  optional: readonly string[] = [],
  allowRpcDisposer = false,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" &&
        !(
          allowRpcDisposer &&
          key === Symbol.dispose &&
          typeof Object.getOwnPropertyDescriptor(value, Symbol.dispose)?.value === "function"
        ),
    ) ||
    required.some((key) => !Object.hasOwn(descriptors, key)) ||
    keys.some((key) => typeof key === "string" && ![...required, ...optional].includes(key)) ||
    Object.values(descriptors).some(
      (descriptor) => !("value" in descriptor) || !descriptor.enumerable,
    )
  )
    invalid();
  return Object.fromEntries(
    Object.entries(descriptors).map(([key, descriptor]) => [key, descriptor.value]),
  );
}

function field(value: unknown, pattern: RegExp, maximum = 512): string {
  if (typeof value !== "string" || value.length > maximum || pattern.exec(value)?.[0] !== value)
    invalid();
  return value;
}

const OPAQUE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const OPERATION = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,95}$/u;
const PLAN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/u;
const TOPUP_REF = /^takosumi:topup:[0-9a-f]{64}$/u;
const SUBSCRIPTION_REF = /^takosumi:subscription:[0-9a-f]{64}$/u;
const SUBSCRIPTION_TARGET = /^sra_[0-9a-f]{64}$/u;
const SELECTOR = /^[0-9a-f]{64}$/u;

/** Exact browser choice; account, scope, key, reference and target never come from this body. */
export function parseHostedBrowserBillingChoice(value: unknown): HostedBrowserBillingChoice {
  const root = record(
    value,
    ["kind"],
    ["amountMinor", "checkoutConsent", "planKey", "consent", "reconcileOriginalConsent"],
  );
  if (root.kind === "topup") {
    record(value, ["kind", "amountMinor", "checkoutConsent"]);
    if (
      !Number.isSafeInteger(root.amountMinor) ||
      (root.amountMinor as number) < 1 ||
      root.checkoutConsent !== "interactive-checkout"
    )
      invalid();
    return Object.freeze({
      kind: "topup",
      amountMinor: root.amountMinor as number,
      checkoutConsent: "interactive-checkout",
    });
  }
  if (root.kind === "start") {
    record(value, ["kind", "planKey", "consent"], ["reconcileOriginalConsent"]);
    if (root.consent !== "subscription-checkout") invalid();
    const planKey = field(root.planKey, PLAN, 64);
    const reconcile = root.reconcileOriginalConsent;
    if (
      reconcile !== undefined &&
      reconcile !== "retry-original-subscription" &&
      reconcile !== "check-original-subscription"
    )
      invalid();
    return Object.freeze({
      kind: "start",
      planKey,
      consent: "subscription-checkout",
      ...(reconcile === undefined ? {} : { reconcileOriginalConsent: reconcile }),
    });
  }
  if (root.kind === "cancel") {
    record(value, ["kind", "consent"]);
    if (root.consent !== "cancel-subscription") invalid();
    return Object.freeze({ kind: "cancel", consent: "cancel-subscription" });
  }
  if (root.kind === "change-plan") {
    record(value, ["kind", "planKey", "consent"]);
    if (root.consent !== "change-subscription-plan") invalid();
    return Object.freeze({
      kind: "change-plan",
      planKey: field(root.planKey, PLAN, 64),
      consent: "change-subscription-plan",
    });
  }
  invalid();
}

export function sameHostedBrowserBillingScope(
  left: HostedBrowserBillingScope,
  right: unknown,
): boolean {
  try {
    const selected = parseHostedBrowserBillingScope(right);
    return Object.keys(left).every(
      (key) =>
        left[key as keyof HostedBrowserBillingScope] ===
        selected[key as keyof HostedBrowserBillingScope],
    );
  } catch {
    return false;
  }
}

export function parseHostedBrowserBillingScope(value: unknown): HostedBrowserBillingScope {
  const raw = record(value, [
    "continuationRef",
    "canonicalAccountId",
    "workspaceId",
    "workspaceRef",
    "organizationId",
    "billingSourceRef",
    "sourceEpoch",
  ]);
  return Object.freeze({
    continuationRef: field(raw.continuationRef, SELECTOR, 64),
    canonicalAccountId: field(raw.canonicalAccountId, OPAQUE),
    workspaceId: field(raw.workspaceId, OPAQUE),
    workspaceRef: field(raw.workspaceRef, OPAQUE),
    organizationId: field(raw.organizationId, OPAQUE),
    billingSourceRef: field(raw.billingSourceRef, OPAQUE),
    sourceEpoch: field(raw.sourceEpoch, OPAQUE),
  });
}

function action(value: unknown, selected: HostedBrowserBillingScope): HostedBrowserBillingAction {
  const raw = record(value, ["family", "request", "claim"]);
  const claimBase = ["ownerId", "organizationId", "billingSourceRef", "operationKey", "reference"];
  const requestBase = ["workspaceId", "operationKey"];
  if (raw.family === "topup") {
    const request = record(
      raw.request,
      [...requestBase, "amountMinor", "checkoutConsent"],
      ["expectedOperationKey"],
    );
    const claim = record(raw.claim, [...claimBase, "amountMinor"]);
    if (request.checkoutConsent !== "interactive-checkout") invalid();
    const amountMinor = request.amountMinor;
    if (
      !Number.isSafeInteger(amountMinor) ||
      (amountMinor as number) < 1 ||
      claim.amountMinor !== amountMinor
    )
      invalid();
    const parsedRequest = Object.freeze({
      workspaceId: field(request.workspaceId, OPAQUE),
      operationKey: field(request.operationKey, OPERATION),
      amountMinor: amountMinor as number,
      checkoutConsent: "interactive-checkout" as const,
      ...(Object.hasOwn(request, "expectedOperationKey")
        ? { expectedOperationKey: field(request.expectedOperationKey, OPERATION) }
        : {}),
    });
    const parsedClaim = Object.freeze({
      ownerId: field(claim.ownerId, OPAQUE),
      organizationId: field(claim.organizationId, OPAQUE),
      billingSourceRef: field(claim.billingSourceRef, OPAQUE),
      operationKey: field(claim.operationKey, OPERATION),
      reference: field(claim.reference, TOPUP_REF),
      amountMinor: amountMinor as number,
    });
    if (
      parsedRequest.workspaceId !== selected.workspaceId ||
      parsedRequest.operationKey !== parsedClaim.operationKey ||
      parsedClaim.organizationId !== selected.organizationId ||
      parsedClaim.billingSourceRef !== selected.billingSourceRef
    )
      invalid();
    return Object.freeze({ family: "topup", request: parsedRequest, claim: parsedClaim });
  }
  if (raw.family !== "subscription") invalid();
  const kind = record(raw.claim, claimBase, [
    "kind",
    "sourceEpoch",
    "planKey",
    "expectedSubscriptionRef",
  ]).kind;
  if (kind !== "start" && kind !== "cancel" && kind !== "change-plan") invalid();
  const claim = record(raw.claim, [
    ...claimBase,
    "kind",
    "sourceEpoch",
    ...(kind === "start" || kind === "change-plan" ? ["planKey"] : []),
    ...(kind === "cancel" || kind === "change-plan" ? ["expectedSubscriptionRef"] : []),
  ]);
  const expectedRequestKeys =
    kind === "cancel" ? [...requestBase, "consent"] : [...requestBase, "planKey", "consent"];
  const request = record(
    raw.request,
    expectedRequestKeys,
    kind === "start"
      ? ["expectedOperationKey", "reconcileOriginalConsent"]
      : ["expectedOperationKey"],
  );
  const expectedConsent =
    kind === "start"
      ? "subscription-checkout"
      : kind === "cancel"
        ? "cancel-subscription"
        : "change-subscription-plan";
  if (request.consent !== expectedConsent) invalid();
  const workspaceId = field(request.workspaceId, OPAQUE);
  const operationKey = field(request.operationKey, OPERATION);
  const parsedClaimBase = {
    ownerId: field(claim.ownerId, OPAQUE),
    organizationId: field(claim.organizationId, OPAQUE),
    billingSourceRef: field(claim.billingSourceRef, OPAQUE),
    sourceEpoch: field(claim.sourceEpoch, OPAQUE),
    operationKey: field(claim.operationKey, OPERATION),
    reference: field(claim.reference, SUBSCRIPTION_REF),
  };
  if (
    workspaceId !== selected.workspaceId ||
    operationKey !== parsedClaimBase.operationKey ||
    parsedClaimBase.organizationId !== selected.organizationId ||
    parsedClaimBase.billingSourceRef !== selected.billingSourceRef ||
    parsedClaimBase.sourceEpoch !== selected.sourceEpoch
  )
    invalid();
  const expectedOperationKey = Object.hasOwn(request, "expectedOperationKey")
    ? field(request.expectedOperationKey, OPERATION)
    : undefined;
  if (kind === "start") {
    const planKey = field(request.planKey, PLAN, 64);
    if (
      claim.planKey !== planKey ||
      (expectedOperationKey === undefined) !== !Object.hasOwn(request, "reconcileOriginalConsent")
    )
      invalid();
    const reconcileOriginalConsent = request.reconcileOriginalConsent;
    if (
      expectedOperationKey !== undefined &&
      reconcileOriginalConsent !== "retry-original-subscription" &&
      reconcileOriginalConsent !== "check-original-subscription"
    )
      invalid();
    return Object.freeze({
      family: "subscription",
      request: Object.freeze({
        workspaceId,
        operationKey,
        planKey,
        consent: "subscription-checkout",
        ...(expectedOperationKey === undefined
          ? {}
          : {
              expectedOperationKey,
              reconcileOriginalConsent: reconcileOriginalConsent as
                | "retry-original-subscription"
                | "check-original-subscription",
            }),
      }),
      claim: Object.freeze({ ...parsedClaimBase, kind: "start", planKey }),
    });
  }
  if (kind === "cancel") {
    const expectedSubscriptionRef = field(claim.expectedSubscriptionRef, SUBSCRIPTION_TARGET);
    return Object.freeze({
      family: "subscription",
      request: Object.freeze({
        workspaceId,
        operationKey,
        consent: "cancel-subscription",
        ...(expectedOperationKey === undefined ? {} : { expectedOperationKey }),
      }),
      claim: Object.freeze({ ...parsedClaimBase, kind: "cancel", expectedSubscriptionRef }),
    });
  }
  const planKey = field(request.planKey, PLAN, 64);
  if (claim.planKey !== planKey) invalid();
  const expectedSubscriptionRef = field(claim.expectedSubscriptionRef, SUBSCRIPTION_TARGET);
  return Object.freeze({
    family: "subscription",
    request: Object.freeze({
      workspaceId,
      operationKey,
      planKey,
      consent: "change-subscription-plan",
      ...(expectedOperationKey === undefined ? {} : { expectedOperationKey }),
    }),
    claim: Object.freeze({
      ...parsedClaimBase,
      kind: "change-plan",
      planKey,
      expectedSubscriptionRef,
    }),
  });
}

/** Detaches all Hosted original fields. A syntactically valid DTO is still DATA. */
export function parseHostedBrowserBillingOriginal(input: unknown): HostedBrowserBillingOriginal {
  const raw = record(input, ["contractVersion", "scope", "action"]);
  if (raw.contractVersion !== HOSTED_BROWSER_BILLING_CONTRACT) invalid();
  const selected = parseHostedBrowserBillingScope(raw.scope);
  return Object.freeze({
    contractVersion: HOSTED_BROWSER_BILLING_CONTRACT,
    scope: selected,
    action: action(raw.action, selected),
  });
}

/** Exact clone-safe original comparison, including Hosted source/epoch/claim/request. */
export function sameHostedBrowserBillingOriginal(
  left: HostedBrowserBillingOriginal,
  right: unknown,
): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(parseHostedBrowserBillingOriginal(right));
  } catch {
    return false;
  }
}

/** Exact existing Server body selection; never a new browser payment vocabulary. */
export function assertHostedBrowserBillingBody(
  method: string,
  body: unknown,
  original: HostedBrowserBillingOriginal,
): SharedFinancialAction {
  const selected = toFinancialHostedBrowserRequestOriginal(original).action;
  const raw = record(
    body,
    selected.kind === "topup"
      ? ["reference", "amountMinor"]
      : selected.kind === "subscription-start"
        ? ["reference", "planKey"]
        : selected.kind === "plan-change"
          ? ["reference", "planKey", "expectedSubscriptionRef"]
          : ["reference", "cancelAtPeriodEnd", "expectedSubscriptionRef"],
  );
  if (
    ((selected.kind === "topup" || selected.kind === "subscription-start") && method !== "POST") ||
    ((selected.kind === "plan-change" || selected.kind === "cancel") && method !== "PATCH")
  )
    invalid();
  let candidate: SharedFinancialAction;
  try {
    candidate = parseSharedFinancialAction({
      kind: selected.kind,
      organizationId: selected.organizationId,
      ...raw,
    });
  } catch {
    invalid();
  }
  if (JSON.stringify(candidate) !== JSON.stringify(selected)) invalid();
  return selected;
}

/** Maps the full Hosted original to the smaller existing RP/Owner producer DATA. */
export function toFinancialHostedBrowserRequestOriginal(
  original: HostedBrowserBillingOriginal,
): FinancialHostedBrowserRequestOriginal {
  const { scope: selected, action: chosen } = original;
  const common = { organizationId: selected.organizationId, reference: chosen.claim.reference };
  const action: SharedFinancialAction =
    chosen.family === "topup"
      ? { ...common, kind: "topup", amountMinor: chosen.claim.amountMinor }
      : chosen.claim.kind === "start"
        ? { ...common, kind: "subscription-start", planKey: chosen.claim.planKey }
        : chosen.claim.kind === "cancel"
          ? {
              ...common,
              kind: "cancel",
              cancelAtPeriodEnd: true,
              expectedSubscriptionRef: chosen.claim.expectedSubscriptionRef,
            }
          : {
              ...common,
              kind: "plan-change",
              planKey: chosen.claim.planKey,
              expectedSubscriptionRef: chosen.claim.expectedSubscriptionRef,
            };
  return Object.freeze({
    action: parseSharedFinancialAction(action),
    workspaceId: selected.workspaceId,
    workspaceRef: selected.workspaceRef,
  });
}

export interface HostedBrowserContinuationMetadata {
  readonly continuation: {
    readonly contractVersion: typeof HOSTED_BROWSER_BILLING_CONTRACT;
    readonly continuationRef: string;
    readonly kind: "view" | "payment";
    readonly workspaceId: string;
    readonly workspaceRef: string;
    readonly organizationId: string;
    readonly operation: null | {
      readonly action: "topup" | "subscription-start" | "cancel" | "plan-change";
      readonly method: "POST" | "PATCH";
      readonly path: string;
      readonly body: Readonly<Record<string, unknown>>;
    };
    readonly phase: null | "prepared" | "dispatch-started" | "outcome-recorded";
  };
}

/** Browser-facing operation is derived from the validated Hosted original. */
export function hostedBrowserContinuationMetadata(
  selected:
    | { readonly kind: "view"; readonly scope: HostedBrowserBillingScope }
    | {
        readonly kind: "payment";
        readonly original: HostedBrowserBillingOriginal;
        readonly custody: { readonly phase: "prepared" | "dispatch-started" | "outcome-recorded" };
      },
): HostedBrowserContinuationMetadata {
  const scope = selected.kind === "view" ? selected.scope : selected.original.scope;
  if (selected.kind === "view")
    return {
      continuation: {
        contractVersion: HOSTED_BROWSER_BILLING_CONTRACT,
        continuationRef: scope.continuationRef,
        kind: "view",
        workspaceId: scope.workspaceId,
        workspaceRef: scope.workspaceRef,
        organizationId: scope.organizationId,
        operation: null,
        phase: null,
      },
    };
  const action = toFinancialHostedBrowserRequestOriginal(selected.original).action;
  if (action.kind === "card-setup") invalid();
  const operation =
    action.kind === "topup"
      ? {
          action: action.kind,
          method: "POST" as const,
          path: `/v1/organizations/${scope.organizationId}/wallet/checkout`,
          body: { reference: action.reference, amountMinor: action.amountMinor },
        }
      : action.kind === "subscription-start"
        ? {
            action: action.kind,
            method: "POST" as const,
            path: `/v1/organizations/${scope.organizationId}/payments/subscription`,
            body: { reference: action.reference, planKey: action.planKey },
          }
        : action.kind === "cancel"
          ? {
              action: action.kind,
              method: "PATCH" as const,
              path: `/v1/organizations/${scope.organizationId}/payments/subscription`,
              body: {
                reference: action.reference,
                cancelAtPeriodEnd: true,
                expectedSubscriptionRef: action.expectedSubscriptionRef,
              },
            }
          : {
              action: action.kind,
              method: "PATCH" as const,
              path: `/v1/organizations/${scope.organizationId}/payments/subscription`,
              body: {
                reference: action.reference,
                planKey: action.planKey,
                expectedSubscriptionRef: action.expectedSubscriptionRef,
              },
            };
  return {
    continuation: {
      contractVersion: HOSTED_BROWSER_BILLING_CONTRACT,
      continuationRef: scope.continuationRef,
      kind: "payment",
      workspaceId: scope.workspaceId,
      workspaceRef: scope.workspaceRef,
      organizationId: scope.organizationId,
      operation,
      phase: selected.custody.phase,
    },
  };
}
