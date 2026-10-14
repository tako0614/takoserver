import type { OrganizationSubscription, SubscriptionCheckoutStart } from "./api.ts";
import { signal } from "./reactive.ts";
import type { SubscriptionIntentIdentity, SubscriptionIntentScope } from "./subscription-intent.ts";

export interface SubscriptionCheckoutScope extends SubscriptionIntentScope {
  readonly principalId: string;
}

export interface SubscriptionCheckoutBrowser {
  readLocation(): { readonly pathname: string; readonly search: string; readonly hash: string };
  replaceLocation(url: string): void;
  assign(url: string): void;
}

export type SubscriptionCheckoutState =
  | { readonly status: "idle" }
  | { readonly status: "busy" }
  | { readonly status: "redirecting" }
  | { readonly status: "pending" }
  | { readonly status: "uncertain" }
  | { readonly status: "associated" }
  | { readonly status: "cancelled" }
  | { readonly status: "expired" }
  | { readonly status: "missing_intent" }
  | { readonly status: "target_mismatch" }
  | { readonly status: "intent_conflict" }
  | { readonly status: "error" };

export interface SubscriptionCheckoutControllerOptions {
  readonly organizationId: string;
  readonly getScope: () => SubscriptionCheckoutScope | null;
  readonly intents: {
    peekScope(
      scope: SubscriptionIntentScope,
    ): { readonly planKey: string; readonly reference: string } | null;
    getOrCreate(
      identity: SubscriptionIntentIdentity,
      stillOwnsScope?: () => boolean,
    ): Promise<string>;
    resetAfterExpiredCheckout(
      identity: SubscriptionIntentIdentity,
      reference: string,
      stillOwnsScope?: () => boolean,
    ): Promise<void>;
    rotateAfterTerminalAssociation(
      identity: SubscriptionIntentIdentity,
      reference: string,
      stillOwnsScope?: () => boolean,
    ): Promise<string>;
  };
  readonly api: {
    subscription(organizationId: string): Promise<OrganizationSubscription>;
    beginSubscription(
      organizationId: string,
      reference: string,
      planKey: string,
    ): Promise<SubscriptionCheckoutStart>;
  };
  readonly browser: SubscriptionCheckoutBrowser;
  readonly onSubscriptionRefresh: () => void;
}

/** Keeps Checkout retry/return on one durable reference without asserting paid coverage. */
export function createSubscriptionCheckoutController(
  options: SubscriptionCheckoutControllerOptions,
) {
  const identity = (): Omit<SubscriptionCheckoutScope, "principalId"> | null => {
    const scope = options.getScope();
    if (
      !scope ||
      scope.organizationId !== options.organizationId ||
      scope.principalId !== scope.ownerPrincipalId
    )
      return null;
    return { organizationId: scope.organizationId, ownerPrincipalId: scope.ownerPrincipalId };
  };

  let initial: SubscriptionCheckoutState = { status: "idle" };
  const initialScope = identity();
  if (initialScope) {
    try {
      if (options.intents.peekScope(initialScope)) initial = { status: "uncertain" };
    } catch {
      initial = { status: "error" };
    }
  }
  const current = signal<SubscriptionCheckoutState>(initial);
  let inFlight = false;
  let expiredIdentity: SubscriptionIntentIdentity | null = null;
  let expiredReference: string | null = null;
  let expiredCheckoutId: string | null = null;

  const ownsScope = (expected: SubscriptionIntentScope): boolean => {
    const active = identity();
    return (
      active?.organizationId === expected.organizationId &&
      active.ownerPrincipalId === expected.ownerPrincipalId
    );
  };

  const removeReturnQuery = (): void => {
    const location = options.browser.readLocation();
    const parameters = new URLSearchParams(location.search);
    if (!parameters.has("subscription")) return;
    parameters.delete("subscription");
    const query = parameters.toString();
    options.browser.replaceLocation(
      `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
    );
  };

  async function submit(planKey: string, explicitNew: boolean): Promise<void> {
    const scope = identity();
    if (
      !scope ||
      inFlight ||
      current().status === "intent_conflict" ||
      current().status === "missing_intent" ||
      (current().status === "expired" && !explicitNew)
    )
      return;
    inFlight = true;
    current.set({ status: "busy" });
    let requestStarted = false;
    const intent: SubscriptionIntentIdentity = { ...scope, planKey };
    try {
      const reference = await options.intents.getOrCreate(intent);
      if (!ownsScope(scope)) return;
      requestStarted = true;
      const result = await options.api.beginSubscription(scope.organizationId, reference, planKey);
      if (!ownsScope(scope)) return;
      if (result.status === 202 && result.checkout.state === "pending") {
        current.set({ status: "pending" });
        return;
      }
      if (result.status === 200 && result.checkout.state === "expired") {
        expiredIdentity = intent;
        expiredReference = reference;
        expiredCheckoutId = result.checkout.id;
        current.set({ status: "expired" });
        return;
      }
      if (result.status === 200 && result.checkout.state === "associated") {
        current.set({ status: "associated" });
        options.onSubscriptionRefresh();
        return;
      }
      if (result.status !== 201 || result.checkout.state !== "open") {
        current.set({ status: "uncertain" });
        return;
      }
      const url = safeCheckoutUrl(result.checkout.url);
      if (!url) {
        current.set({ status: "uncertain" });
        return;
      }
      current.set({ status: "redirecting" });
      options.browser.assign(url);
    } catch (error) {
      if (!ownsScope(scope)) return;
      current.set(
        isIntentConflict(error)
          ? { status: "intent_conflict" }
          : { status: requestStarted ? "uncertain" : "error" },
      );
    } finally {
      inFlight = false;
    }
  }

  async function handleReturn(): Promise<void> {
    const parameters = new URLSearchParams(options.browser.readLocation().search);
    const returned = parameters.get("subscription");
    if (returned === null) return;
    const scope = identity();
    if (returned === "cancelled") {
      if (!scope) return;
      try {
        current.set(
          options.intents.peekScope(scope) ? { status: "cancelled" } : { status: "missing_intent" },
        );
      } catch {
        current.set({ status: "error" });
      }
      return;
    }
    if (!scope || inFlight || !isStripeSessionId(returned)) return;
    let stored: { readonly planKey: string; readonly reference: string } | null;
    try {
      stored = options.intents.peekScope(scope);
    } catch {
      current.set({ status: "error" });
      return;
    }
    if (!stored) {
      current.set({ status: "missing_intent" });
      return;
    }
    inFlight = true;
    current.set({ status: "busy" });
    try {
      const result = await options.api.beginSubscription(
        scope.organizationId,
        stored.reference,
        stored.planKey,
      );
      if (!ownsScope(scope)) return;
      if (
        result.status === 200 &&
        result.checkout.state === "associated" &&
        result.checkout.id === returned
      ) {
        removeReturnQuery();
        current.set({ status: "associated" });
        options.onSubscriptionRefresh();
        return;
      }
      if (result.status === 202 && result.checkout.state === "pending") {
        current.set({ status: "pending" });
        return;
      }
      if (
        result.status === 200 &&
        result.checkout.state === "expired" &&
        result.checkout.id === returned
      ) {
        expiredIdentity = { ...scope, planKey: stored.planKey };
        expiredReference = stored.reference;
        expiredCheckoutId = result.checkout.id;
        current.set({ status: "expired" });
        return;
      }
      current.set({ status: "uncertain" });
    } catch {
      if (ownsScope(scope)) current.set({ status: "uncertain" });
    } finally {
      inFlight = false;
    }
  }

  async function startTerminalRepurchase(
    planKey: string,
    expectedSubscriptionRef: string,
  ): Promise<void> {
    const scope = identity();
    if (!scope || inFlight) return;
    const advancingExpired = current().status === "expired";
    inFlight = true;
    current.set({ status: "busy" });
    let requestStarted = false;
    const intent: SubscriptionIntentIdentity = { ...scope, planKey };
    try {
      const before = await options.api.subscription(scope.organizationId);
      if (!ownsScope(scope)) return;
      if (!isExpectedTerminal(before, expectedSubscriptionRef)) {
        current.set({ status: "target_mismatch" });
        options.onSubscriptionRefresh();
        return;
      }

      const stored = options.intents.peekScope(scope);
      if (!ownsScope(scope)) return;
      if (stored && stored.planKey !== planKey) {
        current.set({ status: "intent_conflict" });
        return;
      }

      let reference: string;
      if (advancingExpired) {
        const exactExpiredIntent = expiredIdentity;
        const exactExpiredReference = expiredReference;
        const exactExpiredCheckoutId = expiredCheckoutId;
        if (
          !exactExpiredIntent ||
          !exactExpiredReference ||
          !exactExpiredCheckoutId ||
          exactExpiredIntent.organizationId !== scope.organizationId ||
          exactExpiredIntent.ownerPrincipalId !== scope.ownerPrincipalId ||
          exactExpiredIntent.planKey !== planKey ||
          !isStripeSessionId(exactExpiredCheckoutId) ||
          stored?.reference !== exactExpiredReference ||
          stored.planKey !== planKey
        ) {
          current.set({ status: "intent_conflict" });
          return;
        }
        await options.intents.resetAfterExpiredCheckout(
          exactExpiredIntent,
          exactExpiredReference,
          () => ownsScope(scope),
        );
        if (!ownsScope(scope)) return;
        expiredIdentity = null;
        expiredReference = null;
        expiredCheckoutId = null;
        reference = await options.intents.getOrCreate(intent, () => ownsScope(scope));
      } else if (stored) {
        requestStarted = true;
        const replay = await options.api.beginSubscription(
          scope.organizationId,
          stored.reference,
          stored.planKey,
        );
        if (!ownsScope(scope)) return;
        if (replay.status === 202 && replay.checkout.state === "pending") {
          current.set({ status: "pending" });
          return;
        }
        if (replay.status === 201 && replay.checkout.state === "open") {
          // An open old Checkout is not proof that its subscription is
          // terminal. Keep its reference and do not redirect into that flow.
          current.set({ status: "uncertain" });
          return;
        }
        if (replay.status === 200 && replay.checkout.state === "expired") {
          expiredIdentity = intent;
          expiredReference = stored.reference;
          expiredCheckoutId = replay.checkout.id;
          current.set({ status: "expired" });
          return;
        }
        if (
          replay.status !== 200 ||
          replay.checkout.state !== "associated" ||
          replay.checkout.subscriptionRef !== expectedSubscriptionRef
        ) {
          current.set({ status: "target_mismatch" });
          options.onSubscriptionRefresh();
          return;
        }

        const after = await options.api.subscription(scope.organizationId);
        if (!ownsScope(scope)) return;
        if (!isExpectedTerminal(after, expectedSubscriptionRef)) {
          current.set({ status: "target_mismatch" });
          options.onSubscriptionRefresh();
          return;
        }
        reference = await options.intents.rotateAfterTerminalAssociation(
          intent,
          stored.reference,
          () => ownsScope(scope),
        );
      } else {
        // A click on the terminal-state action is the authorization boundary
        // for creating a first local intent; a page read never creates one.
        reference = await options.intents.getOrCreate(intent, () => ownsScope(scope));
      }

      if (!ownsScope(scope)) return;
      requestStarted = true;
      const result = await options.api.beginSubscription(scope.organizationId, reference, planKey);
      if (!ownsScope(scope)) return;
      if (result.status === 202 && result.checkout.state === "pending") {
        current.set({ status: "pending" });
        return;
      }
      if (result.status === 200 && result.checkout.state === "expired") {
        expiredIdentity = intent;
        expiredReference = reference;
        expiredCheckoutId = result.checkout.id;
        current.set({ status: "expired" });
        return;
      }
      if (result.status === 200 && result.checkout.state === "associated") {
        current.set({ status: "associated" });
        options.onSubscriptionRefresh();
        return;
      }
      if (result.status !== 201 || result.checkout.state !== "open") {
        current.set({ status: "uncertain" });
        return;
      }
      const url = safeCheckoutUrl(result.checkout.url);
      if (!url) {
        current.set({ status: "uncertain" });
        return;
      }
      current.set({ status: "redirecting" });
      options.browser.assign(url);
    } catch (error) {
      if (!ownsScope(scope)) return;
      current.set(
        isIntentConflict(error)
          ? { status: "intent_conflict" }
          : { status: requestStarted ? "uncertain" : "error" },
      );
    } finally {
      inFlight = false;
    }
  }

  return {
    state: () => current(),
    start: (planKey: string) => submit(planKey, false),
    handleReturn,
    retryReturn: handleReturn,
    async startNewPurchase(planKey: string, expectedSubscriptionRef?: string): Promise<void> {
      if (expectedSubscriptionRef !== undefined) {
        await startTerminalRepurchase(planKey, expectedSubscriptionRef);
        return;
      }
      if (current().status !== "expired" || inFlight) return;
      const scope = identity();
      const intent = expiredIdentity;
      const reference = expiredReference;
      const checkoutId = expiredCheckoutId;
      if (
        !scope ||
        !intent ||
        !reference ||
        intent.organizationId !== scope.organizationId ||
        intent.ownerPrincipalId !== scope.ownerPrincipalId ||
        intent.planKey !== planKey ||
        !checkoutId ||
        !isStripeSessionId(checkoutId)
      )
        return;
      inFlight = true;
      current.set({ status: "busy" });
      try {
        await options.intents.resetAfterExpiredCheckout(intent, reference, () => ownsScope(scope));
        if (!ownsScope(scope)) return;
        expiredIdentity = null;
        expiredReference = null;
        expiredCheckoutId = null;
        current.set({ status: "idle" });
      } catch {
        if (ownsScope(scope)) current.set({ status: "intent_conflict" });
        return;
      } finally {
        inFlight = false;
      }
      await submit(planKey, false);
    },
  };
}

function isExpectedTerminal(result: OrganizationSubscription, subscriptionRef: string): boolean {
  const subscription = result.subscription;
  return (
    subscription !== null &&
    subscription.subscriptionRef === subscriptionRef &&
    (subscription.status === "canceled" || subscription.status === "incomplete_expired")
  );
}

function safeCheckoutUrl(value: string): string | null {
  try {
    const parsed = new URL(value);
    return parsed.origin === "https://checkout.stripe.com" ? parsed.href : null;
  } catch {
    return null;
  }
}

function isStripeSessionId(value: string): boolean {
  return /^cs_[A-Za-z0-9_]{1,240}$/u.test(value);
}

function isIntentConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "intent_scope_mismatch" || error.code === "intent_reference_mismatch")
  );
}
