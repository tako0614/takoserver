import type { FundingSettlementVerifier } from "./ledger.ts";

/**
 * Funding a wallet with money that actually arrived.
 *
 * Until now the only way to credit a wallet was an assertion the operator
 * signed, which is honest and does not scale past the operator. This is the
 * other half: a customer pays through Stripe Checkout, and the proof they bring
 * back is the session's identifier — not an amount.
 *
 * The caller never states how much arrived. That is the whole point of a
 * settlement verifier: the amount comes from asking Stripe what it collected,
 * so a customer cannot credit themselves by claiming a larger number, and a bug
 * in the console cannot credit anyone by sending the wrong one.
 *
 * Three things are checked and none is optional:
 *
 * - The session is **paid**. An open or expired one has collected nothing.
 * - It belongs to **this organization**, by the metadata written when it was
 *   created. Without that, one customer's payment identifier would credit
 *   another customer's wallet — and identifiers travel, in support threads and
 *   in browser history.
 * - The currency is the one the ledger keeps. Crediting 5,000 of something
 *   else as 5,000 USD is a way to buy dollars cheaply.
 *
 * The funding reference is the session id, so the ledger's uniqueness makes a
 * replay credit exactly once. Presenting the same proof twice is not an error;
 * it simply does nothing the second time.
 */

const STRIPE_API = "https://api.stripe.com/v1";
/**
 * Pinned, so the fields read here (`latest_charge` and its refund and dispute
 * state) do not depend on whatever default version the account carries.
 */
export const STRIPE_API_VERSION = "2024-06-20";

/** Stripe Checkout Session ids; short enough that `stripe:<id>` fits a ledger reference. */
const CHECKOUT_SESSION_ID = /^cs_[A-Za-z0-9_]{1,240}$/u;

export type StripeSettlementErrorCode =
  | "unknown_session"
  | "not_paid"
  | "wrong_organization"
  | "wrong_currency"
  /** Paid, then refunded in whole or part, or disputed: there is nothing to credit. */
  | "refunded"
  /** Not a one-off wallet top-up this Host created (another mode, or no Host marker). */
  | "not_wallet_funding"
  /** Stripe's record did not carry the payment it must be checked against. */
  | "unverifiable_payment"
  | "unavailable";

/** Written into every Checkout Session this Host creates, and read back before crediting. */
export const WALLET_FUNDING_PURPOSE = "wallet_funding";

/**
 * The payment behind a session is read with it. Stripe leaves a session
 * `paid` after a refund or a dispute, so the charge is the record that says
 * whether the money is still there.
 */
const SESSION_EXPANSION = "payment_intent.latest_charge";

export class StripeSettlementError extends Error {
  constructor(readonly code: StripeSettlementErrorCode) {
    super(code);
    this.name = "StripeSettlementError";
  }
}

export interface StripeOptions {
  /** Stripe secret key. A secret, and the only credential here. */
  readonly secretKey: string;
  readonly currency?: "USD";
  readonly apiOrigin?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** Stripe's record of one Checkout Session, as far as funding reads it. */
export interface CheckoutSession {
  readonly id?: unknown;
  readonly mode?: unknown;
  readonly payment_status?: unknown;
  readonly amount_total?: unknown;
  readonly currency?: unknown;
  /** Unix seconds; ordering for the reconcile window. */
  readonly created?: unknown;
  readonly metadata?: {
    readonly organizationId?: unknown;
    readonly takoserverPurpose?: unknown;
  } | null;
  /** Expanded with its latest charge by every read this client makes. */
  readonly payment_intent?: unknown;
}

/** What a paid Checkout Session credits, decided only from Stripe's record of it. */
export interface CheckoutSessionFunding {
  readonly organizationId: string;
  readonly fundingRef: string;
  readonly amountMinor: number;
  readonly currency: "USD";
}

/**
 * The one decision about whether a Checkout Session credits a wallet.
 *
 * The console's return, the webhook and the reconcile pass all reach it with
 * a session Stripe itself returned — never with an event body or a caller's
 * claim — so there is one set of checks to keep correct, not three. With an
 * expected organization the session must name exactly that one; without one
 * (a webhook or a reconcile, where nobody presented it) it must name some
 * organization, and the caller decides whether that organization is real.
 */
export function checkoutSessionFunding(
  session: CheckoutSession,
  options: {
    readonly currency?: "USD";
    readonly expectedOrganizationId?: string;
    /**
     * Paths nobody presented (webhook, reconcile) credit only sessions this
     * Host marked at creation, so a Payment Link, a dashboard session or a
     * later subscription Checkout in the same account is never a top-up.
     */
    readonly requireHostMarker?: boolean;
  } = {},
): CheckoutSessionFunding {
  const currency = (options.currency ?? "USD").toLowerCase();
  if (typeof session.id !== "string" || !CHECKOUT_SESSION_ID.test(session.id)) {
    throw new StripeSettlementError("unknown_session");
  }
  // Decided first where nobody presented the session: a payment this Host did
  // not create is not a failed top-up, and must not read as money left behind.
  if (
    options.requireHostMarker === true &&
    (session.mode !== "payment" || session.metadata?.takoserverPurpose !== WALLET_FUNDING_PURPOSE)
  ) {
    throw new StripeSettlementError("not_wallet_funding");
  }
  if (session.payment_status !== "paid") throw new StripeSettlementError("not_paid");
  const organizationId = session.metadata?.organizationId;
  if (
    typeof organizationId !== "string" ||
    organizationId.length === 0 ||
    organizationId.length > 128 ||
    (options.expectedOrganizationId !== undefined &&
      organizationId !== options.expectedOrganizationId)
  ) {
    throw new StripeSettlementError("wrong_organization");
  }
  if (typeof session.currency !== "string" || session.currency.toLowerCase() !== currency) {
    throw new StripeSettlementError("wrong_currency");
  }
  if (
    typeof session.amount_total !== "number" ||
    !Number.isSafeInteger(session.amount_total) ||
    session.amount_total <= 0
  ) {
    throw new StripeSettlementError("not_paid");
  }
  if (session.mode !== "payment") throw new StripeSettlementError("not_wallet_funding");
  assertPaymentStillHeld(session.payment_intent);
  return {
    organizationId,
    // Stripe's minor units are the ledger's minor units, so nothing is
    // converted here — a conversion is a place for a factor of a hundred
    // to go missing.
    amountMinor: session.amount_total,
    fundingRef: `stripe:${session.id}`,
    currency: "USD",
  };
}

/**
 * The money is still there: the payment succeeded and its charge is neither
 * refunded (in any part) nor disputed. A session whose payment cannot be read
 * is not credited on trust.
 */
function assertPaymentStillHeld(intent: unknown): void {
  if (typeof intent !== "object" || intent === null) {
    throw new StripeSettlementError("unverifiable_payment");
  }
  const { status, latest_charge: charge } = intent as Record<string, unknown>;
  if (status !== "succeeded" || typeof charge !== "object" || charge === null) {
    throw new StripeSettlementError("unverifiable_payment");
  }
  const { refunded, amount_refunded: amountRefunded, disputed } = charge as Record<string, unknown>;
  if (refunded !== false || amountRefunded !== 0 || disputed !== false) {
    throw new StripeSettlementError("refunded");
  }
}

export function createStripeSettlement(options: StripeOptions): FundingSettlementVerifier {
  const stripe = createStripeClient(options);

  return {
    async verify({ organizationId, settlementProof }) {
      const session = await stripe.checkoutSession(settlementProof);
      if (!session) throw new StripeSettlementError("unknown_session");
      const funding = checkoutSessionFunding(session, {
        ...(options.currency ? { currency: options.currency } : {}),
        expectedOrganizationId: organizationId,
      });
      return {
        amountMinor: funding.amountMinor,
        fundingRef: funding.fundingRef,
        currency: funding.currency,
      };
    },
  };
}

export interface CheckoutSessionPage {
  readonly sessions: readonly CheckoutSession[];
  readonly hasMore: boolean;
}

export interface StripeClient {
  checkoutSession(id: string): Promise<CheckoutSession | null>;
  /** Newest first, as Stripe lists them; `startingAfter` continues a listing. */
  listCheckoutSessions(input: {
    readonly status: "complete";
    readonly limit: number;
    readonly startingAfter?: string;
  }): Promise<CheckoutSessionPage>;
  createCheckoutSession(input: {
    readonly organizationId: string;
    readonly amountMinor: number;
    readonly successUrl: string;
    readonly cancelUrl: string;
  }): Promise<{ readonly id: string; readonly url: string }>;
}

export function createStripeClient(options: StripeOptions): StripeClient {
  const origin = options.apiOrigin ?? STRIPE_API;
  const send = options.fetch ?? ((request: Request) => fetch(request));
  const currency = (options.currency ?? "USD").toLowerCase();

  const call = async (
    method: "GET" | "POST",
    path: string,
    form?: Record<string, string>,
  ): Promise<Record<string, unknown> | null> => {
    let response: Response;
    try {
      response = await send(
        new Request(`${origin}${path}`, {
          method,
          headers: {
            authorization: `Bearer ${options.secretKey}`,
            "stripe-version": STRIPE_API_VERSION,
            ...(form ? { "content-type": "application/x-www-form-urlencoded" } : {}),
          },
          ...(form ? { body: new URLSearchParams(form).toString() } : {}),
        }),
      );
    } catch {
      throw new StripeSettlementError("unavailable");
    }
    if (response.status === 404) return null;
    if (!response.ok) {
      // Stripe's own message describes an integration to somebody holding the
      // secret key. It is logged, never returned.
      const detail = await response.text().catch(() => "");
      console.error(
        JSON.stringify({
          event: "takoserver.stripe.refused",
          path,
          status: response.status,
          detail: detail.slice(0, 512),
        }),
      );
      throw new StripeSettlementError("unavailable");
    }
    return (await response.json().catch(() => null)) as Record<string, unknown> | null;
  };

  return {
    async checkoutSession(id) {
      if (!CHECKOUT_SESSION_ID.test(id)) return null;
      const query = new URLSearchParams({ "expand[]": SESSION_EXPANSION });
      return (await call(
        "GET",
        `/checkout/sessions/${id}?${query.toString()}`,
      )) as CheckoutSession | null;
    },

    async listCheckoutSessions({ status, limit, startingAfter }) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > 100 ||
        (startingAfter !== undefined && !CHECKOUT_SESSION_ID.test(startingAfter))
      ) {
        throw new StripeSettlementError("unavailable");
      }
      const query = new URLSearchParams({
        status,
        limit: String(limit),
        "expand[]": `data.${SESSION_EXPANSION}`,
      });
      if (startingAfter !== undefined) query.set("starting_after", startingAfter);
      const listed = await call("GET", `/checkout/sessions?${query.toString()}`);
      if (
        !listed ||
        !Array.isArray(listed.data) ||
        typeof listed.has_more !== "boolean" ||
        !listed.data.every((item) => typeof item === "object" && item !== null)
      ) {
        throw new StripeSettlementError("unavailable");
      }
      return { sessions: listed.data as CheckoutSession[], hasMore: listed.has_more };
    },

    async createCheckoutSession({ organizationId, amountMinor, successUrl, cancelUrl }) {
      const created = await call("POST", "/checkout/sessions", {
        mode: "payment",
        success_url: successUrl,
        cancel_url: cancelUrl,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": currency,
        "line_items[0][price_data][unit_amount]": String(amountMinor),
        "line_items[0][price_data][product_data][name]": "Takoserver credit",
        // The organization is written by us at creation and read back at
        // verification. It is what stops one customer's payment from crediting
        // another customer's wallet.
        "metadata[organizationId]": organizationId,
        "metadata[takoserverPurpose]": WALLET_FUNDING_PURPOSE,
        "payment_intent_data[metadata][organizationId]": organizationId,
        "payment_intent_data[metadata][takoserverPurpose]": WALLET_FUNDING_PURPOSE,
      });
      const id = created?.id;
      const url = created?.url;
      if (typeof id !== "string" || typeof url !== "string") {
        throw new StripeSettlementError("unavailable");
      }
      return { id, url };
    },
  };
}
