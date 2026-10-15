import type { Checkout } from "./control.ts";
import type { HostedPricing } from "./hosted-pricing.ts";
import type { FundingSettlementVerifier } from "./ledger.ts";
import { OrgTopUpError, type OrgTopUps } from "./org-top-up.ts";
import type { PaymentEventContext, PaymentEvents } from "./payment-events.ts";
import {
  DEFAULT_CHECKOUT_MAXIMUM_MINOR,
  DEFAULT_CHECKOUT_MINIMUM_MINOR,
  type PaymentSettings,
  validatePaymentSettings,
} from "./payment-settings.ts";
import { createStripeBilling } from "./stripe-billing.ts";
import { createStripeBillingClient } from "./stripe-billing-client.ts";
import {
  createStripeEvents,
  DEFAULT_STRIPE_RECONCILE_LOOKBACK_SECONDS,
  DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS,
} from "./stripe-events.ts";
import { parseStripeMode, type StripeMode } from "./stripe-mode-realm.ts";
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
 * take money and credit nothing. The reconcile pass comes with them, so a
 * payment whose payer never returned is still credited; the webhook is added
 * only where its signing secret is configured.
 *
 * Starting a Checkout needs somewhere to send the payer back to, so without a
 * console origin the route that begins one is not served. Verifying and
 * crediting payments does not: the key alone serves the console's return
 * verification, the webhook and the reconcile pass.
 */

export interface PaymentSetupOptions {
  readonly hostedPricing?: HostedPricing | undefined;
  /** Deployment-wide financial realm; absence selects TEST, never the key prefix. */
  readonly stripeMode?: StripeMode | undefined;
  /** Hosted Checkout requires the owning durable customer/realm custody capability. */
  readonly topUps?: OrgTopUps | undefined;
  /** Stripe secret key. Its presence is what turns payment on. */
  readonly stripeSecretKey?: string | undefined;
  /** Signing secret of this deployment's Stripe webhook endpoint. */
  readonly stripeWebhookSecret?: string | undefined;
  /** Where a completed payment returns the person to. */
  readonly consoleOrigin?: string | undefined;
  /** Operator settings; each one absent takes its documented default. */
  readonly settings?: PaymentSettings | undefined;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export interface PaymentSetup {
  readonly settlement?: FundingSettlementVerifier;
  readonly checkout?: Checkout;
  /** Built by the composition, which owns the ledger the events credit. */
  readonly events?: (context: PaymentEventContext) => PaymentEvents;
}

export function resolvePayment(options: PaymentSetupOptions): PaymentSetup {
  // Settings are checked even where payment is off, so a typo surfaces at
  // startup instead of on the day Stripe is turned on.
  const settings = validatePaymentSettings(options.settings ?? {});
  const mode = parseStripeMode(options.stripeMode);
  const key = options.stripeSecretKey;
  if (!key) {
    if (options.hostedPricing) throw new TypeError("Hosted billing requires a Stripe key");
    return {};
  }
  const billingClient = options.hostedPricing
    ? createStripeBillingClient({
        secretKey: key,
        mode,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      })
    : undefined;

  const stripeOptions = {
    secretKey: key,
    mode,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  };
  const client = createStripeClient(stripeOptions);
  const consoleOrigin = options.consoleOrigin;
  const webhookSecret = options.stripeWebhookSecret?.trim();

  return {
    settlement: createStripeSettlement(stripeOptions),
    ...(consoleOrigin === undefined || consoleOrigin === ""
      ? {}
      : options.hostedPricing
        ? options.topUps
          ? { checkout: createHostedCheckout(options.topUps) }
          : {}
        : { checkout: createCheckout(client, consoleOrigin, settings) }),
    events: (context) => {
      const hosted =
        billingClient && options.hostedPricing
          ? createStripeBilling({
              client: billingClient,
              context,
              pricing: options.hostedPricing,
              mode,
              consoleOrigin,
            })
          : undefined;
      const events = createStripeEvents(
        {
          client,
          mode,
          ...(hosted ? { handlers: hosted.handlers, handlerVersion: 1 } : {}),
          reconcileLookbackSeconds:
            settings.reconcileLookbackSeconds ?? DEFAULT_STRIPE_RECONCILE_LOOKBACK_SECONDS,
          ...(webhookSecret
            ? {
                webhook: {
                  secret: webhookSecret,
                  toleranceSeconds:
                    settings.webhookToleranceSeconds ?? DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS,
                },
              }
            : {}),
        },
        hosted ? { ...context, credit: hosted.creditFunding } : context,
      );
      return hosted
        ? {
            ...events,
            subscriptions: hosted.subscriptions,
            creditFunding: hosted.creditFunding,
            async reconcile() {
              // A malformed legacy Checkout must not starve hosted refunds.
              // Inspect both streams before surfacing either failure.
              const [funding, billing] = await Promise.allSettled([
                events.reconcile(),
                hosted.reconcile(),
              ]);
              if (funding.status === "rejected") throw funding.reason;
              if (billing.status === "rejected") throw billing.reason;
              return { ...funding.value, billing: billing.value };
            },
          }
        : events;
    },
  };
}

function createHostedCheckout(topUps: OrgTopUps): Checkout {
  return {
    bounds: topUps.bounds,
    referenceRequired: true,
    receipt: topUps.receipt.bind(topUps),
    async begin({ organizationId, amountMinor, reference }) {
      if (reference === undefined) throw new OrgTopUpError("invalid_argument");
      return await topUps.begin({ organizationId, amountMinor, reference });
    },
  };
}

function createCheckout(
  client: ReturnType<typeof createStripeClient>,
  consoleOrigin: string,
  settings: PaymentSettings,
): Checkout {
  return {
    bounds: {
      minimumMinor: settings.checkoutMinimumMinor ?? DEFAULT_CHECKOUT_MINIMUM_MINOR,
      maximumMinor: settings.checkoutMaximumMinor ?? DEFAULT_CHECKOUT_MAXIMUM_MINOR,
    },
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
  };
}
