import type { TopUpCheckoutStart, TopUpReceipt } from "./api.ts";
import { signal } from "./reactive.ts";
import type {
  ConclusiveTopUpReceipt,
  TopUpIntentIdentity,
  TopUpIntentRecord,
  TopUpIntentScope,
} from "./top-up-intent.ts";

export interface TopUpCheckoutScope extends TopUpIntentScope {
  readonly principalId: string;
}

export interface TopUpCheckoutBrowser {
  readLocation(): { readonly pathname: string; readonly search: string; readonly hash: string };
  replaceLocation(url: string): void;
  assign(url: string): void;
}

export type TopUpCheckoutState =
  | { readonly status: "idle" }
  | { readonly status: "busy" }
  | { readonly status: "redirecting" }
  /** A stored payment exists and nothing has been asked about it yet. */
  | { readonly status: "unresolved"; readonly amountMinor: number }
  /** A new amount was chosen while a different stored payment is unresolved. */
  | { readonly status: "amount_conflict"; readonly amountMinor: number }
  | { readonly status: "pending" }
  | { readonly status: "ready"; readonly url: string }
  | { readonly status: "paid" }
  | { readonly status: "expired" }
  | { readonly status: "cancelled" }
  | { readonly status: "conflict" }
  /** The server refused a new payment before creating it; the stored intent was discarded. */
  | { readonly status: "rejected" }
  | { readonly status: "unavailable" }
  | { readonly status: "uncertain" }
  | { readonly status: "missing_intent" }
  | { readonly status: "error" };

export interface TopUpCheckoutControllerOptions {
  readonly organizationId: string;
  readonly getScope: () => TopUpCheckoutScope | null;
  readonly intents: {
    peek(scope: TopUpIntentScope): TopUpIntentRecord | null;
    getOrCreate(identity: TopUpIntentIdentity, stillOwnsScope?: () => boolean): Promise<string>;
    removeAfterConclusiveReceipt(
      scope: TopUpIntentScope,
      receipt: ConclusiveTopUpReceipt,
      stillOwnsScope?: () => boolean,
    ): Promise<void>;
  };
  readonly api: {
    beginTopUp(
      organizationId: string,
      reference: string,
      amountMinor: number,
    ): Promise<TopUpCheckoutStart>;
    topUpReceipt(organizationId: string, reference: string): Promise<TopUpReceipt>;
  };
  readonly browser: TopUpCheckoutBrowser;
  readonly onWalletRefresh: () => void;
}

/**
 * Keeps a hosted top-up's start, retry, return and consent return on one
 * durable reference. A return is answered by the server's receipt for that
 * reference; the console never settles funds itself.
 */
export function createTopUpCheckoutController(options: TopUpCheckoutControllerOptions) {
  const identity = (): TopUpIntentScope | null => {
    const scope = options.getScope();
    if (
      !scope ||
      scope.organizationId !== options.organizationId ||
      scope.principalId !== scope.ownerPrincipalId
    )
      return null;
    return { organizationId: scope.organizationId, ownerPrincipalId: scope.ownerPrincipalId };
  };

  let initial: TopUpCheckoutState = { status: "idle" };
  const initialScope = identity();
  if (initialScope) {
    try {
      const stored = options.intents.peek(initialScope);
      if (stored) initial = { status: "unresolved", amountMinor: stored.amountMinor };
    } catch {
      initial = { status: "error" };
    }
  }
  const current = signal<TopUpCheckoutState>(initial);
  let inFlight = false;

  const ownsScope = (expected: TopUpIntentScope): boolean => {
    const active = identity();
    return (
      active?.organizationId === expected.organizationId &&
      active.ownerPrincipalId === expected.ownerPrincipalId
    );
  };

  const removeQueryKey = (name: string): void => {
    const location = options.browser.readLocation();
    const parameters = new URLSearchParams(location.search);
    if (!parameters.has(name)) return;
    parameters.delete(name);
    const query = parameters.toString();
    options.browser.replaceLocation(
      `${location.pathname}${query ? `?${query}` : ""}${location.hash}`,
    );
  };

  /**
   * Applies one receipt for the stored reference. `paid` and `expired` are the
   * only conclusive answers; anything else keeps the intent. Returns true when
   * the reference is concluded and must not be begun again.
   */
  async function apply(
    scope: TopUpIntentScope,
    stored: TopUpIntentRecord,
    receipt: TopUpReceipt,
  ): Promise<boolean> {
    if (receipt.reference !== stored.reference) {
      current.set({ status: "uncertain" });
      return true;
    }
    if (receipt.state === "paid" || receipt.state === "expired") {
      try {
        await options.intents.removeAfterConclusiveReceipt(
          scope,
          { reference: stored.reference, state: receipt.state },
          () => ownsScope(scope),
        );
      } catch {
        // Another tab may already have concluded or replaced this intent. The
        // receipt is still the truth for this reference; nothing else is removed.
      }
      if (!ownsScope(scope)) return true;
      current.set({ status: receipt.state });
      if (receipt.state === "paid") options.onWalletRefresh();
      return true;
    }
    return false;
  }

  async function begin(
    scope: TopUpIntentScope,
    reference: string,
    amountMinor: number,
  ): Promise<void> {
    const started = await options.api.beginTopUp(scope.organizationId, reference, amountMinor);
    if (!ownsScope(scope)) return;
    const url = safeCheckoutUrl(started.checkout.url);
    if (!url) {
      current.set({ status: "uncertain" });
      return;
    }
    current.set({ status: "redirecting" });
    options.browser.assign(url);
  }

  /**
   * A new reference refused with `invalid_argument` (the server checks current
   * bounds before it stores anything) is concluded only when its receipt is
   * then not found. Any other answer keeps the intent.
   */
  async function settleRefused(scope: TopUpIntentScope, reference: string): Promise<boolean> {
    try {
      await options.api.topUpReceipt(scope.organizationId, reference);
      return false;
    } catch (error) {
      if (errorCode(error) !== "not_found") return false;
    }
    try {
      await options.intents.removeAfterConclusiveReceipt(
        scope,
        { reference, state: "never_created" },
        () => ownsScope(scope),
      );
    } catch {
      return false;
    }
    if (ownsScope(scope)) current.set({ status: "rejected" });
    return true;
  }

  function failed(scope: TopUpIntentScope, error: unknown, requestStarted: boolean): void {
    if (!ownsScope(scope)) return;
    const code = errorCode(error);
    if (code === "intent_amount_mismatch") {
      try {
        const stored = options.intents.peek(scope);
        current.set(
          stored
            ? { status: "amount_conflict", amountMinor: stored.amountMinor }
            : { status: "error" },
        );
      } catch {
        current.set({ status: "error" });
      }
      return;
    }
    if (requestStarted && code === "not_found") current.set({ status: "unavailable" });
    else if (requestStarted && code === "conflict") current.set({ status: "conflict" });
    else current.set({ status: requestStarted ? "uncertain" : "error" });
  }

  async function start(amountMinor: number): Promise<void> {
    const scope = identity();
    if (!scope || inFlight || !isAmountMinor(amountMinor)) return;
    inFlight = true;
    current.set({ status: "busy" });
    let requestStarted = false;
    let sent: string | null = null;
    try {
      const stored = options.intents.peek(scope);
      if (!ownsScope(scope)) return;
      if (stored && stored.amountMinor !== amountMinor) {
        // The server fingerprints the original command. A different amount is
        // never sent under the stored reference, and no second one is minted.
        current.set({ status: "amount_conflict", amountMinor: stored.amountMinor });
        return;
      }
      if (stored) {
        // A stored reference may already be paid or expired while nobody was
        // watching. Ask first, so a paid one is not reopened and an expired
        // one is concluded instead of refused.
        requestStarted = true;
        let receipt: TopUpReceipt | null = null;
        try {
          receipt = await options.api.topUpReceipt(scope.organizationId, stored.reference);
        } catch (error) {
          // Not found means the server holds no command yet; the same
          // reference and amount is the idempotent way to create it.
          if (errorCode(error) !== "not_found") throw error;
        }
        if (!ownsScope(scope)) return;
        if (receipt && (await apply(scope, stored, receipt))) return;
      }
      const reference = await options.intents.getOrCreate({ ...scope, amountMinor }, () =>
        ownsScope(scope),
      );
      if (!ownsScope(scope)) return;
      requestStarted = true;
      sent = reference;
      await begin(scope, reference, amountMinor);
    } catch (error) {
      if (
        sent !== null &&
        errorCode(error) === "invalid_argument" &&
        (await settleRefused(scope, sent))
      )
        return;
      failed(scope, error, requestStarted);
    } finally {
      inFlight = false;
    }
  }

  async function handleReturn(): Promise<void> {
    const returned = new URLSearchParams(options.browser.readLocation().search).get("checkout");
    if (returned === null) return;
    const scope = identity();
    if (!scope) return;
    if (returned === "cancelled") {
      // The stored intent stays: the next start with the same amount resumes
      // the same reference rather than creating a second payment.
      removeQueryKey("checkout");
      current.set({ status: "cancelled" });
      return;
    }
    if (inFlight || !isStripeSessionId(returned)) return;
    let stored: TopUpIntentRecord | null;
    try {
      stored = options.intents.peek(scope);
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
      const receipt = await options.api.topUpReceipt(scope.organizationId, stored.reference);
      if (!ownsScope(scope)) return;
      if (await apply(scope, stored, receipt)) {
        const concluded = current().status;
        if (concluded === "paid" || concluded === "expired") removeQueryKey("checkout");
        return;
      }
      const url = receipt.state === "ready" ? safeCheckoutUrl(receipt.checkout?.url ?? "") : null;
      current.set(url ? { status: "ready", url } : { status: "pending" });
    } catch {
      if (ownsScope(scope)) current.set({ status: "uncertain" });
    } finally {
      inFlight = false;
    }
  }

  /**
   * The explicit financial consent page returns to a fixed `?consent=returned`.
   * It carries no data and no destination; the payment it consented to is the
   * stored intent, resumed with exactly its reference and amount.
   */
  async function handleConsentReturn(): Promise<void> {
    const returned = new URLSearchParams(options.browser.readLocation().search).get("consent");
    if (returned !== "returned") return;
    removeQueryKey("consent");
    const scope = identity();
    if (!scope || inFlight) return;
    let stored: TopUpIntentRecord | null;
    try {
      stored = options.intents.peek(scope);
    } catch {
      current.set({ status: "error" });
      return;
    }
    if (!stored) return;
    // Same path as an explicit resume: the receipt is read first, so a payment
    // that settled meanwhile is not reopened, then the stored reference and
    // amount are begun again.
    await start(stored.amountMinor);
  }

  return {
    state: () => current(),
    start,
    handleReturn,
    handleConsentReturn,
    /** Follows an open Checkout the server already reported for this reference. */
    continueCheckout(): void {
      const state = current();
      const scope = identity();
      if (!scope || state.status !== "ready") return;
      const url = safeCheckoutUrl(state.url);
      if (!url) return;
      current.set({ status: "redirecting" });
      options.browser.assign(url);
    },
  };
}

function isAmountMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
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

function errorCode(error: unknown): string | null {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : null;
}
