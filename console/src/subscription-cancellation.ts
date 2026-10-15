import type { SubscriptionCancellationReceipt } from "./api.ts";
import { signal } from "./reactive.ts";
import type { SubscriptionCancelIntentIdentity } from "./subscription-cancel-intent.ts";

export type SubscriptionCancellationState =
  | { readonly status: "idle" }
  | { readonly status: "busy" }
  | { readonly status: "pending" }
  | { readonly status: "uncertain" }
  | { readonly status: "verified"; readonly effectiveAt: string }
  | { readonly status: "error" }
  | { readonly status: "intent_conflict" }
  | { readonly status: "target_mismatch" };

export interface SubscriptionCancellationControllerOptions {
  readonly organizationId: string;
  readonly getScope: () => SubscriptionCancelIntentIdentity | null;
  readonly intents: {
    peek(identity: SubscriptionCancelIntentIdentity): string | null;
    getOrCreate(identity: SubscriptionCancelIntentIdentity): Promise<string>;
    resetAfterVerifiedCancellation(
      identity: SubscriptionCancelIntentIdentity,
      reference: string,
      receipt: SubscriptionCancellationReceipt,
    ): Promise<void>;
  };
  readonly api: {
    cancelSubscription(
      organizationId: string,
      reference: string,
      expectedSubscriptionRef: string,
    ): Promise<SubscriptionCancellationReceipt>;
  };
  readonly onRefresh: () => void;
}

/** Keeps cancellation retries target-bound and never treats an unknown ACK as scheduled. */
export function createSubscriptionCancellationController(
  options: SubscriptionCancellationControllerOptions,
) {
  const initialScope = options.getScope();
  let initial: SubscriptionCancellationState = { status: "idle" };
  if (initialScope?.organizationId === options.organizationId) {
    try {
      if (options.intents.peek(initialScope) !== null) initial = { status: "uncertain" };
    } catch {
      initial = { status: "error" };
    }
  }
  const current = signal<SubscriptionCancellationState>(initial);
  let inFlight = false;

  const identity = (): SubscriptionCancelIntentIdentity | null => {
    const scope = options.getScope();
    return scope?.organizationId === options.organizationId ? scope : null;
  };

  const ownsTarget = (expected: SubscriptionCancelIntentIdentity): boolean => {
    const active = identity();
    return (
      active?.organizationId === expected.organizationId &&
      active.ownerPrincipalId === expected.ownerPrincipalId &&
      active.subscriptionRef === expected.subscriptionRef
    );
  };

  async function cancel(): Promise<void> {
    const scope = identity();
    if (!scope || inFlight || current().status === "verified") return;
    inFlight = true;
    current.set({ status: "busy" });
    let requestStarted = false;
    try {
      const reference = await options.intents.getOrCreate(scope);
      if (!ownsTarget(scope)) return;
      requestStarted = true;
      const receipt = await options.api.cancelSubscription(
        scope.organizationId,
        reference,
        scope.subscriptionRef,
      );
      if (!ownsTarget(scope)) return;
      if (receipt.subscriptionRef !== scope.subscriptionRef) {
        current.set({ status: "target_mismatch" });
        options.onRefresh();
        return;
      }
      if (receipt.state === "pending") {
        current.set({ status: "pending" });
        return;
      }
      if (receipt.state !== "verified" || !isCanonicalTimestamp(receipt.effectiveAt)) {
        current.set({ status: "uncertain" });
        return;
      }
      current.set({ status: "verified", effectiveAt: receipt.effectiveAt });
      try {
        await options.intents.resetAfterVerifiedCancellation(scope, reference, receipt);
      } catch {
        // The exact provider result remains confirmed; retaining the local key is safe.
      }
      if (ownsTarget(scope)) options.onRefresh();
    } catch (error) {
      if (!ownsTarget(scope)) return;
      if (isTargetConflict(error)) {
        current.set({ status: "target_mismatch" });
        options.onRefresh();
        return;
      }
      current.set(
        isIntentConflict(error)
          ? { status: "intent_conflict" }
          : { status: requestStarted ? "uncertain" : "error" },
      );
    } finally {
      inFlight = false;
    }
  }

  return { state: () => current(), cancel, retry: cancel };
}

function isCanonicalTimestamp(value: string): boolean {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function isIntentConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "intent_scope_mismatch" ||
      error.code === "intent_reference_mismatch" ||
      error.code === "reference_conflict")
  );
}

function isTargetConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "subscription_management_conflict"
  );
}
