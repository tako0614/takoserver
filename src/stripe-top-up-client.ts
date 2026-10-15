import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { minorToMicros } from "./money.ts";
import {
  OrgTopUpError,
  type TopUpClient,
  type TopUpCommand,
  type TopUpSession,
} from "./org-top-up.ts";
import type { Sql } from "./ports.ts";
import type { StripeBillingClient, StripeBillingObject } from "./stripe-billing-client.ts";
import { verifyStripeCustomerBinding } from "./stripe-customer-custody.ts";

const MAX_RECOVERY_PAGES = 10;
const SESSION = /^cs_[A-Za-z0-9_]{1,240}$/u;

interface Context {
  readonly sql: Sql;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
}

function fail(code: OrgTopUpError["code"]): never {
  throw new OrgTopUpError(code);
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("conflict");
  return value as Record<string, unknown>;
}
function noConnect(value: Record<string, unknown>): void {
  if (["on_behalf_of", "transfer_data", "application", "account"].some((key) => value[key] != null))
    fail("conflict");
}
function id(value: unknown): unknown {
  return typeof value === "string" ? value : record(value).id;
}
function assertRealm(context: Context, command: TopUpCommand): void {
  assertHostedBillingFinancialRealm(context.realm, {
    sql: context.sql,
    client: context.client,
    billingAuthority: context.realm.billingAuthority,
  });
  if (
    command.accountId !== context.realm.accountId ||
    command.livemode !== context.realm.livemode ||
    command.financialRealm !== context.realm.financialRealm ||
    command.currency !== "USD" ||
    command.purpose !== "wallet_funding" ||
    command.amountMicros !== minorToMicros(command.amountMinor)
  )
    fail("conflict");
}
async function commandMetadata(command: TopUpCommand): Promise<Record<string, string>> {
  return {
    organizationId: command.organizationId,
    takoserverPurpose: command.purpose,
    topUpReference: command.reference,
    stripeAccountId: command.accountId,
    financialRealm: command.financialRealm,
    pricingRevision: command.pricingRevision,
    purchaseCreditExpiry: canonicalJson(command.purchaseCreditExpiry),
    topUpCommandDigest: await canonicalDigest(command),
  };
}

/** The existing funding writer verifies this original tuple before granting cash. */
export async function assertTopUpSessionCommand(
  context: Context,
  session: StripeBillingObject,
  command: TopUpCommand,
): Promise<TopUpSession> {
  assertRealm(context, command);
  await verifyStripeCustomerBinding(context, command.organizationId, command.customerId);
  noConnect(session);
  const metadata = record(session.metadata);
  const expected = await commandMetadata(command);
  if (
    !SESSION.test(session.id) ||
    session.object !== "checkout.session" ||
    session.livemode !== command.livemode ||
    session.mode !== "payment" ||
    id(session.customer) !== command.customerId ||
    session.currency !== "usd" ||
    session.amount_total !== command.amountMinor ||
    Object.entries(expected).some(([key, value]) => metadata[key] !== value) ||
    !["open", "complete", "expired"].includes(String(session.status)) ||
    !["paid", "unpaid", "no_payment_required"].includes(String(session.payment_status))
  )
    fail("conflict");
  if (session.payment_intent !== null && typeof session.payment_intent === "object") {
    const intent = record(session.payment_intent);
    noConnect(intent);
    const intentMetadata = record(intent.metadata);
    if (
      intent.livemode !== command.livemode ||
      id(intent.customer) !== command.customerId ||
      intent.currency !== "usd" ||
      intent.amount !== command.amountMinor ||
      Object.entries(expected).some(([key, value]) => intentMetadata[key] !== value)
    )
      fail("conflict");
  }
  const url = session.url == null ? null : String(session.url);
  if (url !== null) {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      fail("conflict");
    }
    if (
      parsed.origin !== "https://checkout.stripe.com" ||
      !parsed.pathname.startsWith("/c/pay/") ||
      parsed.username ||
      parsed.password
    )
      fail("conflict");
  }
  return {
    id: session.id,
    url,
    status: session.status as TopUpSession["status"],
    paymentStatus: session.payment_status as TopUpSession["paymentStatus"],
    organizationId: command.organizationId,
    reference: command.reference,
    amountMinor: command.amountMinor,
    currency: "USD",
    purpose: command.purpose,
    mode: "payment",
    customerId: command.customerId,
    accountId: command.accountId,
    livemode: command.livemode,
    financialRealm: command.financialRealm,
    pricingRevision: command.pricingRevision,
    purchaseCreditExpiry: command.purchaseCreditExpiry,
  };
}

/** Expiry begins only at the first verified funding instant; replays use the saved grant. */
export function frozenTopUpExpiry(command: TopUpCommand, firstFundedAt: string): string | null {
  const funded = Date.parse(firstFundedAt);
  if (!Number.isFinite(funded) || new Date(funded).toISOString() !== firstFundedAt)
    fail("conflict");
  if (command.purchaseCreditExpiry.kind === "none") return null;
  if (
    command.purchaseCreditExpiry.kind !== "fixed-duration" ||
    !Number.isSafeInteger(command.purchaseCreditExpiry.seconds) ||
    command.purchaseCreditExpiry.seconds <= 0
  )
    fail("conflict");
  const expires = funded + command.purchaseCreditExpiry.seconds * 1000;
  if (!Number.isSafeInteger(expires) || expires > 253402300799000) fail("conflict");
  return new Date(expires).toISOString();
}

/** Uses the one existing Stripe transport and genuine readonly qualified realm. */
export function createStripeTopUpClient(context: Context): TopUpClient {
  assertHostedBillingFinancialRealm(context.realm, {
    sql: context.sql,
    client: context.client,
    billingAuthority: context.realm.billingAuthority,
  });
  async function customer(command: TopUpCommand): Promise<void> {
    assertRealm(context, command);
    await verifyStripeCustomerBinding(context, command.organizationId, command.customerId);
  }
  return {
    async create(command, stripeKey) {
      await customer(command);
      const metadata = { ...(await commandMetadata(command)), topUpIdempotencyKey: stripeKey };
      const form: Record<string, string> = {
        mode: "payment",
        customer: command.customerId,
        success_url: command.successUrl,
        cancel_url: command.cancelUrl,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": "usd",
        "line_items[0][price_data][unit_amount]": String(command.amountMinor),
        "line_items[0][price_data][product_data][name]": "Takoserver credit",
      };
      for (const [key, value] of Object.entries(metadata)) {
        form[`metadata[${key}]`] = value;
        form[`payment_intent_data[metadata][${key}]`] = value;
      }
      const session = await context.client.post("checkout/sessions", {
        form,
        idempotencyKey: stripeKey,
      });
      return await assertTopUpSessionCommand(context, session, command);
    },
    async read(sessionId, command) {
      await customer(command);
      const session = await context.client.get("checkout/sessions", sessionId, {
        expand: ["payment_intent.latest_charge"],
      });
      return session === null ? null : await assertTopUpSessionCommand(context, session, command);
    },
    async recover(command, stripeKey) {
      await customer(command);
      let after: string | undefined;
      let match: StripeBillingObject | null = null;
      const seen = new Set<string>();
      for (let page = 0; page < MAX_RECOVERY_PAGES; page++) {
        const listed = await context.client.list("checkout/sessions", {
          customer: command.customerId,
          limit: 100,
          ...(after === undefined ? {} : { startingAfter: after }),
        });
        for (const candidate of listed.data) {
          if (seen.has(candidate.id)) fail("reconciliation_required");
          seen.add(candidate.id);
          const metadata = candidate.metadata == null ? {} : record(candidate.metadata);
          if (
            metadata.topUpIdempotencyKey === stripeKey ||
            (metadata.organizationId === command.organizationId &&
              metadata.topUpReference === command.reference)
          ) {
            if (match !== null) fail("reconciliation_required");
            await assertTopUpSessionCommand(context, candidate, command);
            match = candidate;
          }
        }
        if (!listed.hasMore) return match === null ? null : await this.read(match.id, command);
        after = listed.data.at(-1)?.id;
        if (after === undefined) fail("reconciliation_required");
      }
      fail("reconciliation_required");
    },
  };
}
