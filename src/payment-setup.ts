import type { Checkout } from "./control.ts";
import type { FundingSettlementVerifier } from "./ledger.ts";
import { createStripeClient, createStripeSettlement } from "./stripe-settlement.ts";

/**
 * How this deployment takes money, if it takes money.
 *
 * Absent is a real answer, and the one a fresh deployment gives. Where no
 * payment processor is configured, funding is the operator crediting a wallet
 * against a signature they wrote — which is honest, and does not scale past the
 * operator. The route that would begin a payment is then not served at all,
 * so a console cannot offer a checkout this deployment cannot complete.
 *
 * The verifier and the checkout are resolved together for the same reason
 * identity is: a deployment that can start a payment it cannot verify would
 * take money and credit nothing.
 */

export interface PaymentSetupOptions {
  /** Stripe secret key. Its presence is what turns payment on. */
  readonly stripeSecretKey?: string | undefined;
  /** Where a completed payment returns the person to. */
  readonly consoleOrigin?: string | undefined;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export interface PaymentSetup {
  readonly settlement?: FundingSettlementVerifier;
  readonly checkout?: Checkout;
}

/** A payment small enough to be a mistake, or large enough to be one. */
const MINIMUM_MINOR = 500;
const MAXIMUM_MINOR = 1_000_000;

export function resolvePayment(options: PaymentSetupOptions): PaymentSetup {
  const key = options.stripeSecretKey;
  if (!key || !options.consoleOrigin) return {};

  const stripeOptions = { secretKey: key, ...(options.fetch ? { fetch: options.fetch } : {}) };
  const client = createStripeClient(stripeOptions);
  const consoleOrigin = options.consoleOrigin;

  return {
    settlement: createStripeSettlement(stripeOptions),
    checkout: {
      bounds: { minimumMinor: MINIMUM_MINOR, maximumMinor: MAXIMUM_MINOR },
      async begin({ organizationId, amountMinor }) {
        const session = await client.createCheckoutSession({
          organizationId,
          amountMinor,
          // The session id travels back in the URL, which is what the console
          // presents as the proof. Nothing about the amount comes back with
          // it: the amount is asked of Stripe.
          successUrl: `${consoleOrigin}/billing?checkout={CHECKOUT_SESSION_ID}`,
          cancelUrl: `${consoleOrigin}/billing?checkout=cancelled`,
        });
        return { url: session.url };
      },
    },
  };
}
