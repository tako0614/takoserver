import type { Ledger } from "./ledger.ts";
import type { Clock, Sql } from "./ports.ts";

/**
 * Payments this Host learns about without the payer coming back.
 *
 * Funding used to happen only when the console returned from Checkout and
 * presented the session id. A closed tab, a lost redirect or a payment method
 * that settles days later left money collected and nothing credited. Two
 * paths close that gap and both end here: the processor's signed
 * notification, and a periodic pass that asks the processor what it settled.
 *
 * Neither path trusts what it was told. Each re-reads the payment from the
 * processor and credits through the same funding reference the console's
 * return uses, so the ledger's uniqueness makes every path and every replay
 * credit once.
 */

/** A payment the processor itself reports as settled. */
export interface SettledFunding {
  readonly organizationId: string;
  readonly fundingRef: string;
  readonly amountMinor: number;
  readonly currency: "USD";
}

export type FundingCreditOutcome = "credited" | "already_credited" | "unknown_organization";

/** Credits one settled payment, at most once per funding reference. */
export type FundingCredit = (funding: SettledFunding) => Promise<FundingCreditOutcome>;

/** What the composition hands a processor: storage, time, and the one way to credit. */
export interface PaymentEventContext {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly credit: FundingCredit;
}

/** `received` never leaves the processor; a receipt states a settled outcome. */
export type PaymentEventOutcome = "credited" | "ignored" | "deferred" | "unsupported";

export interface PaymentEventReceipt {
  readonly eventId: string;
  readonly type: string;
  readonly outcome: PaymentEventOutcome;
  /** Short machine reason, never an amount, an organization or a processor message. */
  readonly detail: string | null;
  /** True when an earlier delivery of the same event already settled it. */
  readonly duplicate: boolean;
}

export interface FundingReconcileReport {
  readonly examined: number;
  readonly credited: number;
  readonly alreadyCredited: number;
  readonly unknownOrganization: number;
  /** Payments that do not credit, by reason (not paid yet, another currency, …). */
  readonly skipped: Readonly<Record<string, number>>;
  /** The window held more payments than one pass reads. */
  readonly truncated: boolean;
}

export interface PaymentEvents {
  /**
   * Authenticates and handles one processor notification. Present only where
   * the processor's signing secret is configured; absent, the route that
   * would receive notifications is not served.
   */
  readonly receive?: (input: {
    readonly payload: Uint8Array;
    readonly signature: string | null;
  }) => Promise<PaymentEventReceipt>;
  /** Credits what the processor settled recently and this Host has not. */
  reconcile(): Promise<FundingReconcileReport>;
}

export type PaymentEventErrorCode =
  | "invalid_signature"
  | "malformed_event"
  | "payload_too_large"
  | "unavailable";

/**
 * Processor-neutral refusals. `unavailable` asks the sender to retry; the
 * others are final for that delivery.
 */
export class PaymentEventError extends Error {
  constructor(readonly code: PaymentEventErrorCode) {
    super(code);
    this.name = "PaymentEventError";
  }
}

/**
 * The only way a notification or a reconcile pass moves money.
 *
 * The organization comes from the processor's record, so it must exist here:
 * a payment that names an organization this deployment does not have (another
 * deployment sharing the account, or a deleted organization) credits nothing.
 */
export function createFundingCredit(input: {
  readonly ledger: Pick<Ledger, "fund" | "hasFunding">;
  readonly organizationExists: (organizationId: string) => Promise<boolean>;
}): FundingCredit {
  return async (funding) => {
    if (!(await input.organizationExists(funding.organizationId))) return "unknown_organization";
    const reference = { organizationId: funding.organizationId, fundingRef: funding.fundingRef };
    if (await input.ledger.hasFunding(reference)) return "already_credited";
    // A concurrent path may credit between the check and here; the ledger's
    // unique funding reference turns that race into a no-op, not a second credit.
    await input.ledger.fund({ ...reference, amountMinor: funding.amountMinor });
    return "credited";
  };
}
