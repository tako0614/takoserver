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

export type StripeSettlementErrorCode =
  | "unknown_session"
  | "not_paid"
  | "wrong_organization"
  | "wrong_currency"
  | "unavailable";

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

interface CheckoutSession {
  readonly id?: unknown;
  readonly payment_status?: unknown;
  readonly amount_total?: unknown;
  readonly currency?: unknown;
  readonly metadata?: { readonly organizationId?: unknown } | null;
}

export function createStripeSettlement(options: StripeOptions): FundingSettlementVerifier {
  const stripe = createStripeClient(options);
  const currency = (options.currency ?? "USD").toLowerCase();

  return {
    async verify({ organizationId, settlementProof }) {
      const session = await stripe.checkoutSession(settlementProof);
      if (!session) throw new StripeSettlementError("unknown_session");

      if (session.payment_status !== "paid") throw new StripeSettlementError("not_paid");
      if (session.metadata?.organizationId !== organizationId) {
        throw new StripeSettlementError("wrong_organization");
      }
      if (typeof session.currency !== "string" || session.currency.toLowerCase() !== currency) {
        throw new StripeSettlementError("wrong_currency");
      }
      if (typeof session.amount_total !== "number" || session.amount_total <= 0) {
        throw new StripeSettlementError("not_paid");
      }

      return {
        // Stripe's minor units are the ledger's minor units, so nothing is
        // converted here — a conversion is a place for a factor of a hundred
        // to go missing.
        amountMinor: session.amount_total,
        fundingRef: `stripe:${String(session.id)}`,
        currency: "USD",
      };
    },
  };
}

export interface StripeClient {
  checkoutSession(id: string): Promise<CheckoutSession | null>;
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
      if (!/^cs_[A-Za-z0-9_]{1,255}$/u.test(id)) return null;
      return (await call("GET", `/checkout/sessions/${id}`)) as CheckoutSession | null;
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
        "payment_intent_data[metadata][organizationId]": organizationId,
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
