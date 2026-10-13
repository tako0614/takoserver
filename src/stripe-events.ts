import {
  type FundingCredit,
  type FundingCreditOutcome,
  type FundingReconcileReport,
  type PaymentEventContext,
  PaymentEventError,
  type PaymentEventOutcome,
  type PaymentEventReceipt,
  type PaymentEvents,
} from "./payment-events.ts";
import type { Clock, Sql } from "./ports.ts";
import {
  type CheckoutSession,
  checkoutSessionFunding,
  type StripeClient,
  StripeSettlementError,
} from "./stripe-settlement.ts";

/**
 * Stripe's webhook, routed by event type, and the reconcile pass behind it.
 *
 * A webhook body is authenticated by its signature and then used for exactly
 * two facts: which event this is (for deduplication) and which Stripe object
 * it concerns. Everything that moves money — whether it is paid, how much, in
 * what currency, for which organization, over which period — is read back
 * from the Stripe API with this deployment's key. A forged body cannot pass
 * the signature, and a genuine but stale or replayed one cannot change what
 * Stripe now says about the object.
 *
 * Event types fall into three groups. A handler acts on the type. A deferred
 * type is one a later capability will act on (subscription grants, invoices,
 * refunds): it is recorded with its object id and acknowledged so Stripe stops
 * retrying, and a future handler re-reads the object. Anything else is
 * recorded as unsupported and acknowledged. No type is silently dropped.
 */

/** Largest webhook body read. Stripe's Checkout events are a few kilobytes. */
export const STRIPE_WEBHOOK_MAX_BYTES = 256 * 1_024;
/** Stripe's own default signature tolerance. */
export const DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS = 300;
/** Long enough for delayed payment methods to settle after Checkout completes. */
export const DEFAULT_STRIPE_RECONCILE_LOOKBACK_SECONDS = 7 * 24 * 60 * 60;

const RECONCILE_PAGE_SIZE = 100;
const RECONCILE_MAX_PAGES = 10;
const SIGNATURE_HEADER_MAX_LENGTH = 4_096;
/** 9999-12-31T23:59:59Z: the last instant a recorded timestamp can name. */
const LATEST_EVENT_SECONDS = 253_402_300_799;

export type StripeSignatureFailure = "missing" | "malformed" | "mismatch" | "outside_tolerance";

export class StripeSignatureError extends Error {
  constructor(readonly reason: StripeSignatureFailure) {
    super(reason);
    this.name = "StripeSignatureError";
  }
}

/**
 * Verifies a `Stripe-Signature` header against the exact bytes received.
 *
 * The signed payload is `<t>.<raw body>`; any `v1` HMAC-SHA256 that matches
 * is accepted (Stripe sends several while an endpoint secret is rolled), and
 * other schemes are ignored. The timestamp is signed, so the tolerance bounds
 * how long a captured delivery can be replayed.
 */
export async function verifyStripeSignature(input: {
  readonly payload: Uint8Array;
  readonly header: string | null;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly toleranceSeconds: number;
}): Promise<void> {
  const { header } = input;
  if (!header) throw new StripeSignatureError("missing");
  if (header.length > SIGNATURE_HEADER_MAX_LENGTH) throw new StripeSignatureError("malformed");
  let timestamp: string | undefined;
  const signatures: string[] = [];
  for (const part of header.split(",")) {
    const separator = part.indexOf("=");
    if (separator < 1) throw new StripeSignatureError("malformed");
    const key = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (key === "t") {
      if (timestamp !== undefined || !/^[0-9]{1,12}$/u.test(value)) {
        throw new StripeSignatureError("malformed");
      }
      timestamp = value;
    } else if (key === "v1") {
      if (!/^[0-9a-f]{64}$/u.test(value)) throw new StripeSignatureError("malformed");
      signatures.push(value);
    }
  }
  if (timestamp === undefined || signatures.length === 0) {
    throw new StripeSignatureError("malformed");
  }

  const encoder = new TextEncoder();
  const prefix = encoder.encode(`${timestamp}.`);
  const signed = new Uint8Array(prefix.byteLength + input.payload.byteLength);
  signed.set(prefix, 0);
  signed.set(input.payload, prefix.byteLength);
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, signed));
  if (!signatures.some((candidate) => sameBytes(expected, hexBytes(candidate)))) {
    throw new StripeSignatureError("mismatch");
  }
  if (Math.abs(input.nowSeconds - Number(timestamp)) > input.toleranceSeconds) {
    throw new StripeSignatureError("outside_tolerance");
  }
}

function hexBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/** Compares every byte, so the time taken does not say how much matched. */
function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  let difference = 0;
  for (let index = 0; index < left.byteLength; index += 1) {
    difference |= (left[index] as number) ^ (right[index] as number);
  }
  return difference === 0;
}

/** The two facts a verified body is trusted for, plus what is recorded about it. */
export interface StripeEventEnvelope {
  readonly id: string;
  readonly type: string;
  readonly livemode: boolean;
  /** Unix seconds. */
  readonly created: number;
  readonly objectId: string | null;
  readonly objectType: string | null;
}

export function parseStripeEventEnvelope(payload: Uint8Array): StripeEventEnvelope {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(payload));
  } catch {
    throw new PaymentEventError("malformed_event");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new PaymentEventError("malformed_event");
  }
  const event = value as Record<string, unknown>;
  const data = event.data;
  const object =
    typeof data === "object" && data !== null && !Array.isArray(data)
      ? (data as Record<string, unknown>).object
      : undefined;
  const fields =
    typeof object === "object" && object !== null && !Array.isArray(object)
      ? (object as Record<string, unknown>)
      : {};
  if (
    event.object !== "event" ||
    typeof event.id !== "string" ||
    !/^evt_[A-Za-z0-9_]{1,250}$/u.test(event.id) ||
    typeof event.type !== "string" ||
    !/^[a-z0-9_]+(?:\.[a-z0-9_]+){1,5}$/u.test(event.type) ||
    event.type.length > 128 ||
    typeof event.livemode !== "boolean" ||
    typeof event.created !== "number" ||
    !Number.isSafeInteger(event.created) ||
    event.created <= 0 ||
    event.created > LATEST_EVENT_SECONDS ||
    (fields.id !== undefined &&
      (typeof fields.id !== "string" || fields.id.length < 1 || fields.id.length > 255)) ||
    (fields.object !== undefined &&
      (typeof fields.object !== "string" || fields.object.length > 64))
  ) {
    throw new PaymentEventError("malformed_event");
  }
  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    created: event.created,
    objectId: typeof fields.id === "string" ? fields.id : null,
    objectType: typeof fields.object === "string" ? fields.object : null,
  };
}

/** What a handler may use. The event body is not in it beyond the envelope. */
export interface StripeEventHandlerContext {
  readonly client: StripeClient;
  readonly currency: "USD";
  readonly credit: FundingCredit;
}

export interface StripeEventHandling {
  readonly outcome: Extract<PaymentEventOutcome, "credited" | "ignored">;
  readonly detail: string;
}

/**
 * Acts on one verified event. It must re-read its object from Stripe; a
 * throw leaves the event retryable (`received`) and asks Stripe to redeliver.
 */
export type StripeEventHandler = (
  event: StripeEventEnvelope,
  context: StripeEventHandlerContext,
) => Promise<StripeEventHandling>;

/**
 * Credits a Checkout Session from Stripe's current record of it. A session
 * completed with a delayed payment method is not paid yet; its later
 * `async_payment_succeeded` event (or the reconcile pass) credits it.
 */
export const creditCheckoutSessionEvent: StripeEventHandler = async (event, context) => {
  if (event.objectType !== "checkout.session" || event.objectId === null) {
    return { outcome: "ignored", detail: "unexpected_object" };
  }
  const session = await context.client.checkoutSession(event.objectId);
  if (session === null) return { outcome: "ignored", detail: "unknown_session" };
  if (session.id !== event.objectId) return { outcome: "ignored", detail: "unexpected_object" };
  return await creditSession(session, context);
};

async function creditSession(
  session: CheckoutSession,
  context: Pick<StripeEventHandlerContext, "currency" | "credit">,
): Promise<StripeEventHandling> {
  let funding: ReturnType<typeof checkoutSessionFunding>;
  try {
    funding = checkoutSessionFunding(session, { currency: context.currency });
  } catch (error) {
    if (error instanceof StripeSettlementError) return { outcome: "ignored", detail: error.code };
    throw error;
  }
  const credited = await context.credit(funding);
  return credited === "unknown_organization"
    ? { outcome: "ignored", detail: credited }
    : { outcome: "credited", detail: credited };
}

/** Event types this Host acts on, and the one place a new one is added. */
export const STRIPE_EVENT_HANDLERS: Readonly<Record<string, StripeEventHandler>> = Object.freeze({
  "checkout.session.completed": creditCheckoutSessionEvent,
  "checkout.session.async_payment_succeeded": creditCheckoutSessionEvent,
});

/**
 * Recognised for subscription credit lots, invoice settlement and refunds,
 * which are not built yet. Moving a type from here into the handler table is
 * the whole change: its recorded rows keep the object id a handler re-reads.
 */
export const STRIPE_DEFERRED_EVENT_TYPES: ReadonlySet<string> = Object.freeze(
  new Set([
    "invoice.paid",
    "invoice.payment_failed",
    "customer.subscription.updated",
    "customer.subscription.deleted",
    "charge.refunded",
  ]),
);

export interface StripeEventsOptions {
  readonly client: StripeClient;
  readonly currency?: "USD";
  /** Absent: notifications are not received, and only the reconcile pass runs. */
  readonly webhook?: {
    readonly secret: string;
    readonly toleranceSeconds?: number;
  };
  readonly reconcileLookbackSeconds?: number;
  /** Override for tests and for a later capability; defaults to the table above. */
  readonly handlers?: Readonly<Record<string, StripeEventHandler>>;
  readonly deferredTypes?: ReadonlySet<string>;
}

export function createStripeEvents(
  options: StripeEventsOptions,
  context: PaymentEventContext,
): PaymentEvents {
  const currency = options.currency ?? "USD";
  const handlers = options.handlers ?? STRIPE_EVENT_HANDLERS;
  const deferredTypes = options.deferredTypes ?? STRIPE_DEFERRED_EVENT_TYPES;
  const handlerContext: StripeEventHandlerContext = {
    client: options.client,
    currency,
    credit: context.credit,
  };
  const ledger = createStripeEventLedger(context.sql, context.clock);
  const lookbackSeconds =
    options.reconcileLookbackSeconds ?? DEFAULT_STRIPE_RECONCILE_LOOKBACK_SECONDS;
  const webhook = options.webhook;

  const route = async (
    event: StripeEventEnvelope,
  ): Promise<StripeEventHandling | "deferred" | "unsupported"> => {
    const handler = Object.hasOwn(handlers, event.type) ? handlers[event.type] : undefined;
    if (handler) return await handler(event, handlerContext);
    return deferredTypes.has(event.type) ? "deferred" : "unsupported";
  };

  return {
    ...(webhook
      ? {
          async receive({ payload, signature }): Promise<PaymentEventReceipt> {
            if (payload.byteLength > STRIPE_WEBHOOK_MAX_BYTES) {
              throw new PaymentEventError("payload_too_large");
            }
            try {
              await verifyStripeSignature({
                payload,
                header: signature,
                secret: webhook.secret,
                nowSeconds: Math.floor(context.clock().getTime() / 1_000),
                toleranceSeconds:
                  webhook.toleranceSeconds ?? DEFAULT_STRIPE_WEBHOOK_TOLERANCE_SECONDS,
              });
            } catch (error) {
              if (error instanceof StripeSignatureError) {
                // Which check failed is for the operator's log, not the sender.
                console.warn(
                  JSON.stringify({
                    event: "takoserver.stripe.webhook_refused",
                    reason: error.reason,
                  }),
                );
                throw new PaymentEventError("invalid_signature");
              }
              throw error;
            }
            const event = parseStripeEventEnvelope(payload);
            const settled = await ledger.settled(event.id);
            if (settled !== null) {
              return {
                eventId: event.id,
                type: event.type,
                outcome: settled.outcome,
                detail: settled.detail,
                duplicate: true,
              };
            }
            await ledger.record(event);
            let routed: Awaited<ReturnType<typeof route>>;
            try {
              routed = await route(event);
            } catch (error) {
              // The row stays `received`: Stripe redelivers and this runs again.
              if (error instanceof StripeSettlementError && error.code === "unavailable") {
                throw new PaymentEventError("unavailable");
              }
              throw error;
            }
            const outcome: PaymentEventOutcome =
              typeof routed === "string" ? routed : routed.outcome;
            const detail = typeof routed === "string" ? null : routed.detail;
            await ledger.settle(event.id, outcome, detail);
            return { eventId: event.id, type: event.type, outcome, detail, duplicate: false };
          },
        }
      : {}),

    async reconcile(): Promise<FundingReconcileReport> {
      const cutoff = Math.floor(context.clock().getTime() / 1_000) - lookbackSeconds;
      let examined = 0;
      let credited = 0;
      let alreadyCredited = 0;
      let unknownOrganization = 0;
      const skipped: Record<string, number> = {};
      const creditedRefs: string[] = [];
      let truncated = false;
      let startingAfter: string | undefined;
      pages: for (let page = 0; ; page += 1) {
        if (page === RECONCILE_MAX_PAGES) {
          truncated = true;
          break;
        }
        const listed = await options.client.listCheckoutSessions({
          status: "complete",
          limit: RECONCILE_PAGE_SIZE,
          ...(startingAfter === undefined ? {} : { startingAfter }),
        });
        for (const session of listed.sessions) {
          if (typeof session.created !== "number" || typeof session.id !== "string") {
            skipped.malformed = (skipped.malformed ?? 0) + 1;
            continue;
          }
          // Stripe lists newest first: the first one older than the window ends it.
          if (session.created < cutoff) break pages;
          examined += 1;
          let funding: ReturnType<typeof checkoutSessionFunding>;
          try {
            funding = checkoutSessionFunding(session, { currency });
          } catch (error) {
            if (!(error instanceof StripeSettlementError)) throw error;
            skipped[error.code] = (skipped[error.code] ?? 0) + 1;
            continue;
          }
          const outcome: FundingCreditOutcome = await context.credit(funding);
          if (outcome === "credited") {
            credited += 1;
            creditedRefs.push(funding.fundingRef);
          } else if (outcome === "already_credited") alreadyCredited += 1;
          else unknownOrganization += 1;
        }
        const last = listed.sessions.at(-1);
        if (!listed.hasMore || typeof last?.id !== "string") break;
        startingAfter = last.id;
      }
      if (credited > 0) {
        // Each of these was paid and had not been credited by the console's
        // return or a webhook: worth knowing about, never worth hiding.
        console.warn(
          JSON.stringify({ event: "takoserver.stripe.reconciled", fundingRefs: creditedRefs }),
        );
      }
      if (truncated) {
        console.warn(
          JSON.stringify({
            event: "takoserver.stripe.reconcile_truncated",
            examined,
            hint: "more completed Checkout Sessions in the window than one pass reads",
          }),
        );
      }
      return { examined, credited, alreadyCredited, unknownOrganization, skipped, truncated };
    },
  };
}

interface StripeEventLedger {
  settled(
    eventId: string,
  ): Promise<{ readonly outcome: PaymentEventOutcome; readonly detail: string | null } | null>;
  record(event: StripeEventEnvelope): Promise<void>;
  settle(eventId: string, outcome: PaymentEventOutcome, detail: string | null): Promise<void>;
}

const SETTLED_OUTCOMES: ReadonlySet<string> = new Set([
  "credited",
  "ignored",
  "deferred",
  "unsupported",
]);

function createStripeEventLedger(sql: Sql, clock: Clock): StripeEventLedger {
  return {
    async settled(eventId) {
      const rows = await sql.query(
        "SELECT outcome, outcome_detail FROM stripe_events WHERE event_id = ?",
        [eventId],
      );
      const row = rows[0];
      if (!row || !SETTLED_OUTCOMES.has(String(row.outcome))) return null;
      return {
        outcome: String(row.outcome) as PaymentEventOutcome,
        detail: row.outcome_detail === null ? null : String(row.outcome_detail),
      };
    },
    async record(event) {
      await sql.run(
        `INSERT OR IGNORE INTO stripe_events
           (event_id, type, livemode, object_id, event_created_at, received_at, outcome)
         VALUES (?, ?, ?, ?, ?, ?, 'received')`,
        [
          event.id,
          event.type,
          event.livemode ? 1 : 0,
          event.objectId,
          new Date(event.created * 1_000).toISOString(),
          clock().toISOString(),
        ],
      );
    },
    async settle(eventId, outcome, detail) {
      // Guarded: a concurrent delivery that already settled keeps its answer.
      await sql.run(
        `UPDATE stripe_events SET outcome = ?, outcome_detail = ?, settled_at = ?
         WHERE event_id = ? AND outcome = 'received'`,
        [outcome, detail, clock().toISOString(), eventId],
      );
    },
  };
}
