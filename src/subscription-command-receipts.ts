/** Retained command results; these never establish current paid coverage. */
export const SUBSCRIPTION_COMMAND_RECEIPT_VERSION = "hosted-subscription-command-v1";

export type SubscriptionCommandKind = "start" | "cancel" | "plan-change";

export interface SubscriptionScheduledChange {
  readonly planKey: string;
  readonly pricingRevision: string;
  readonly effectiveAt: string;
}

export interface SubscriptionStartCommandDescriptor {
  readonly organizationId: string;
  readonly reference: string;
  readonly kind: "start";
  readonly state: "pending" | "open" | "associated" | "expired" | "invalidated";
  readonly planKey: string;
  readonly pricingRevision: string;
  readonly subscriptionRef: string | null;
  readonly checkout: { readonly url: string } | null;
}

export interface SubscriptionCancellationCommandDescriptor {
  readonly organizationId: string;
  readonly reference: string;
  readonly kind: "cancel";
  readonly state: "pending" | "verified";
  readonly subscriptionRef: string;
  readonly planKey: string | null;
  readonly pricingRevision: string | null;
  readonly effectiveAt: string | null;
  /** Verified cancellation acknowledges scheduling, not target termination. */
  readonly lifecycle: "pending" | "scheduled";
}

export interface SubscriptionPlanCommandDescriptor {
  readonly organizationId: string;
  readonly reference: string;
  readonly kind: "plan-change";
  readonly state: "pending" | "verified";
  readonly subscriptionRef: string;
  readonly planKey: string;
  readonly pricingRevision: string;
  readonly effectiveAt: string;
  /** Original acknowledged tuple, retained after activation or revocation. */
  readonly pendingChange: SubscriptionScheduledChange | null;
  readonly lifecycle: "pending" | "scheduled" | "activated" | "revoked";
}

export interface SubscriptionCommandReceipt {
  readonly contractVersion: typeof SUBSCRIPTION_COMMAND_RECEIPT_VERSION;
  readonly organizationId: string;
  readonly reference: string;
  readonly kind: SubscriptionCommandKind;
  readonly state:
    | SubscriptionStartCommandDescriptor["state"]
    | SubscriptionCancellationCommandDescriptor["state"];
  readonly subscriptionRef: string | null;
  readonly planKey: string | null;
  readonly pricingRevision: string | null;
  readonly checkout: { readonly url: string } | null;
  readonly effectiveAt: string | null;
  readonly pendingChange: SubscriptionScheduledChange | null;
  readonly lifecycle:
    | SubscriptionStartCommandDescriptor["state"]
    | SubscriptionPlanCommandDescriptor["lifecycle"];
}

export class SubscriptionCommandReceiptError extends Error {
  constructor(readonly code: "invalid_argument" | "unavailable") {
    super(code);
    this.name = "SubscriptionCommandReceiptError";
  }
}

export interface SubscriptionCommandReceipts {
  read(input: {
    readonly organizationId: string;
    readonly kind: SubscriptionCommandKind;
    readonly reference: string;
  }): Promise<SubscriptionCommandReceipt | null>;
}

const REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const TARGET = /^sra_[0-9a-f]{64}$/u;
const text = (value: unknown, maximum: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= maximum;
const instant = (value: unknown): value is string =>
  typeof value === "string" &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
  Number.isFinite(Date.parse(value)) &&
  new Date(value).toISOString() === value;

function validCancellation(value: SubscriptionCancellationCommandDescriptor): boolean {
  return (
    TARGET.test(value.subscriptionRef) &&
    (value.state === "pending"
      ? value.lifecycle === "pending" && value.effectiveAt === null
      : value.state === "verified" && value.lifecycle === "scheduled" && instant(value.effectiveAt))
  );
}

/**
 * Captures only the owning pure history readers. No clock, processor client,
 * mutation port, management gate or default recovery behavior is available.
 */
export function createSubscriptionCommandReceipts(options: {
  readonly readStart: (
    organizationId: string,
    reference: string,
  ) => Promise<SubscriptionStartCommandDescriptor | null>;
  readonly readNativeCancel: (
    organizationId: string,
    reference: string,
  ) => Promise<SubscriptionCancellationCommandDescriptor | null>;
  readonly readExtension: (
    organizationId: string,
    reference: string,
    kind: "cancel" | "plan-change",
  ) => Promise<
    SubscriptionCancellationCommandDescriptor | SubscriptionPlanCommandDescriptor | null
  >;
}): SubscriptionCommandReceipts {
  const { readStart, readNativeCancel, readExtension } = options;
  const unavailable = (): never => {
    throw new SubscriptionCommandReceiptError("unavailable");
  };
  return Object.freeze({
    async read(input: Parameters<SubscriptionCommandReceipts["read"]>[0]) {
      const { organizationId, reference, kind } = input;
      if (
        typeof organizationId !== "string" ||
        typeof reference !== "string" ||
        !REFERENCE.test(organizationId) ||
        !REFERENCE.test(reference) ||
        !["start", "cancel", "plan-change"].includes(kind)
      )
        throw new SubscriptionCommandReceiptError("invalid_argument");
      let original:
        | SubscriptionStartCommandDescriptor
        | SubscriptionCancellationCommandDescriptor
        | SubscriptionPlanCommandDescriptor
        | null;
      const matchesOriginal = (
        value:
          | SubscriptionStartCommandDescriptor
          | SubscriptionCancellationCommandDescriptor
          | SubscriptionPlanCommandDescriptor,
      ): boolean =>
        value.organizationId === organizationId &&
        value.reference === reference &&
        value.kind === kind &&
        (value.planKey === null || text(value.planKey, 64)) &&
        (value.pricingRevision === null || text(value.pricingRevision, 512)) &&
        (value.subscriptionRef === null || TARGET.test(value.subscriptionRef));
      try {
        original =
          kind === "start"
            ? await readStart(organizationId, reference)
            : await readExtension(organizationId, reference, kind);
        if (kind === "cancel") {
          if (
            original !== null &&
            (!matchesOriginal(original) ||
              original.kind !== "cancel" ||
              !validCancellation(original))
          )
            return unavailable();
          const native = await readNativeCancel(organizationId, reference);
          if (native !== null && (!matchesOriginal(native) || !validCancellation(native)))
            return unavailable();
          if (original !== null) {
            if (
              original.kind !== "cancel" ||
              (native !== null && original.subscriptionRef !== native.subscriptionRef) ||
              (original.state === "verified" &&
                (native?.state !== "verified" || original.effectiveAt !== native.effectiveAt))
            )
              return unavailable();
          } else original = native;
        }
      } catch {
        return unavailable();
      }
      if (original === null) return null;
      if (!matchesOriginal(original)) return unavailable();
      let checkout: SubscriptionCommandReceipt["checkout"] = null;
      let effectiveAt: string | null = null;
      let pendingChange: SubscriptionScheduledChange | null = null;
      let lifecycle: SubscriptionCommandReceipt["lifecycle"];
      if (original.kind === "start") {
        if (
          !["pending", "open", "associated", "expired", "invalidated"].includes(original.state) ||
          !text(original.planKey, 64) ||
          !text(original.pricingRevision, 512) ||
          (original.state === "associated") !== (original.subscriptionRef !== null)
        )
          return unavailable();
        if (original.checkout !== null) {
          try {
            const url = new URL(original.checkout.url);
            if (
              url.origin !== "https://checkout.stripe.com" ||
              url.username ||
              url.password ||
              !["open", "associated"].includes(original.state)
            )
              return unavailable();
            checkout = Object.freeze({ url: original.checkout.url });
          } catch {
            return unavailable();
          }
        }
        if (original.state === "open" && checkout === null) return unavailable();
        lifecycle = original.state;
      } else {
        if (
          !TARGET.test(original.subscriptionRef) ||
          !["pending", "verified"].includes(original.state) ||
          (original.effectiveAt !== null && !instant(original.effectiveAt))
        )
          return unavailable();
        effectiveAt = original.effectiveAt;
        lifecycle = original.lifecycle;
        if (original.state === "pending" && lifecycle !== "pending") return unavailable();
        if (original.kind === "cancel") {
          if (!validCancellation(original)) return unavailable();
        } else {
          if (
            !text(original.planKey, 64) ||
            !text(original.pricingRevision, 512) ||
            !instant(effectiveAt) ||
            !["pending", "scheduled", "activated", "revoked"].includes(lifecycle) ||
            (original.state === "verified" && lifecycle === "pending")
          )
            return unavailable();
          const change = original.pendingChange;
          if (change !== null) {
            if (
              change.planKey !== original.planKey ||
              change.pricingRevision !== original.pricingRevision ||
              change.effectiveAt !== effectiveAt ||
              original.state !== "verified"
            )
              return unavailable();
            pendingChange = Object.freeze({
              planKey: change.planKey,
              pricingRevision: change.pricingRevision,
              effectiveAt: change.effectiveAt,
            });
          }
          if (original.state === "verified" && pendingChange === null) return unavailable();
        }
      }
      return Object.freeze({
        contractVersion: SUBSCRIPTION_COMMAND_RECEIPT_VERSION,
        organizationId,
        reference,
        kind,
        state: original.state,
        subscriptionRef: original.subscriptionRef,
        planKey: original.planKey,
        pricingRevision: original.pricingRevision,
        checkout,
        effectiveAt,
        pendingChange,
        lifecycle,
      });
    },
  });
}
