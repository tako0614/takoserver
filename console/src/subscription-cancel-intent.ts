/** Storage boundary for one cancellation request bound to one opaque target. */
export interface SubscriptionCancelIntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SubscriptionCancelIntentIdentity {
  readonly organizationId: string;
  readonly ownerPrincipalId: string;
  readonly subscriptionRef: string;
}

export type SubscriptionCancelIntentLock = <T>(
  name: string,
  operation: () => T | Promise<T>,
) => Promise<T>;

export interface SubscriptionCancelIntentStoreOptions {
  readonly storage: SubscriptionCancelIntentStorage;
  readonly uuid: () => string;
  readonly lock?: SubscriptionCancelIntentLock;
}

export type SubscriptionCancelIntentStoreErrorCode =
  | "invalid_identity"
  | "invalid_stored_intent"
  | "intent_scope_mismatch"
  | "invalid_reference"
  | "storage_unavailable"
  | "exclusive_lock_unavailable"
  | "intent_reference_mismatch"
  | "unverified_cancellation";

export class SubscriptionCancelIntentStoreError extends Error {
  constructor(readonly code: SubscriptionCancelIntentStoreErrorCode) {
    super(code);
    this.name = "SubscriptionCancelIntentStoreError";
  }
}

interface StoredIntent extends SubscriptionCancelIntentIdentity {
  readonly version: 1;
  readonly reference: string;
}

export interface VerifiedSubscriptionCancellation {
  readonly state: "verified";
  readonly subscriptionRef: string;
  readonly effectiveAt: string;
}

export type SubscriptionCancellationReceipt =
  | { readonly state: "pending"; readonly subscriptionRef: string }
  | VerifiedSubscriptionCancellation;

/** Pending and ambiguous requests keep their reference; only exact verified receipts retire it. */
export function createSubscriptionCancelIntentStore(options: SubscriptionCancelIntentStoreOptions) {
  return {
    peek(identity: SubscriptionCancelIntentIdentity): string | null {
      validateIdentity(identity);
      const serialized = read(options.storage, storageKey(identity));
      return serialized === null ? null : decode(serialized, identity).reference;
    },

    async getOrCreate(identity: SubscriptionCancelIntentIdentity): Promise<string> {
      validateIdentity(identity);
      const key = storageKey(identity);
      const existing = read(options.storage, key);
      if (existing !== null) return decode(existing, identity).reference;
      return withExclusiveLock(options.lock, key, () => {
        const current = read(options.storage, key);
        if (current !== null) return decode(current, identity).reference;
        const reference = `console-subscription-cancel-${options.uuid()}`;
        if (!isBillingReference(reference))
          throw new SubscriptionCancelIntentStoreError("invalid_reference");
        write(
          options.storage,
          key,
          JSON.stringify({ version: 1, ...identity, reference } satisfies StoredIntent),
        );
        return reference;
      });
    },

    async resetAfterVerifiedCancellation(
      identity: SubscriptionCancelIntentIdentity,
      reference: string,
      receipt: SubscriptionCancellationReceipt,
    ): Promise<void> {
      validateIdentity(identity);
      if (!isBillingReference(reference))
        throw new SubscriptionCancelIntentStoreError("invalid_reference");
      if (!isVerifiedFor(receipt, identity.subscriptionRef))
        throw new SubscriptionCancelIntentStoreError("unverified_cancellation");
      const key = storageKey(identity);
      await withExclusiveLock(options.lock, key, () => {
        const serialized = read(options.storage, key);
        if (serialized === null)
          throw new SubscriptionCancelIntentStoreError("intent_reference_mismatch");
        if (decode(serialized, identity).reference !== reference)
          throw new SubscriptionCancelIntentStoreError("intent_reference_mismatch");
        try {
          options.storage.removeItem(key);
        } catch {
          throw new SubscriptionCancelIntentStoreError("storage_unavailable");
        }
      });
    },
  };
}

export function browserSubscriptionCancelIntentLock(): SubscriptionCancelIntentLock {
  return async <T>(name: string, operation: () => T | Promise<T>): Promise<T> => {
    if (typeof navigator === "undefined" || typeof navigator.locks?.request !== "function")
      throw new SubscriptionCancelIntentStoreError("exclusive_lock_unavailable");
    return navigator.locks.request(
      `takoserver.hosted-subscription-cancel-intent:${name}`,
      { mode: "exclusive" },
      () => operation(),
    );
  };
}

function validateIdentity(identity: SubscriptionCancelIntentIdentity): void {
  if (
    !identity ||
    typeof identity.organizationId !== "string" ||
    identity.organizationId.length === 0 ||
    typeof identity.ownerPrincipalId !== "string" ||
    identity.ownerPrincipalId.length === 0 ||
    !isSubscriptionRef(identity.subscriptionRef)
  )
    throw new SubscriptionCancelIntentStoreError("invalid_identity");
}

function storageKey(identity: SubscriptionCancelIntentIdentity): string {
  return `takoserver.hosted-subscription-cancel-intent.v1:${encodeURIComponent(identity.ownerPrincipalId)}:${encodeURIComponent(identity.organizationId)}:${identity.subscriptionRef}`;
}

function read(storage: SubscriptionCancelIntentStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    throw new SubscriptionCancelIntentStoreError("storage_unavailable");
  }
}

function write(storage: SubscriptionCancelIntentStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    throw new SubscriptionCancelIntentStoreError("storage_unavailable");
  }
}

async function withExclusiveLock<T>(
  lock: SubscriptionCancelIntentLock | undefined,
  name: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!lock) throw new SubscriptionCancelIntentStoreError("exclusive_lock_unavailable");
  try {
    return await lock(name, operation);
  } catch (error) {
    if (error instanceof SubscriptionCancelIntentStoreError) throw error;
    throw new SubscriptionCancelIntentStoreError("exclusive_lock_unavailable");
  }
}

function decode(serialized: string, identity: SubscriptionCancelIntentIdentity): StoredIntent {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new SubscriptionCancelIntentStoreError("invalid_stored_intent");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SubscriptionCancelIntentStoreError("invalid_stored_intent");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.organizationId !== "string" ||
    typeof record.ownerPrincipalId !== "string" ||
    typeof record.subscriptionRef !== "string" ||
    typeof record.reference !== "string"
  )
    throw new SubscriptionCancelIntentStoreError("invalid_stored_intent");
  if (
    record.organizationId !== identity.organizationId ||
    record.ownerPrincipalId !== identity.ownerPrincipalId ||
    record.subscriptionRef !== identity.subscriptionRef
  )
    throw new SubscriptionCancelIntentStoreError("intent_scope_mismatch");
  if (!isBillingReference(record.reference))
    throw new SubscriptionCancelIntentStoreError("invalid_stored_intent");
  return {
    version: 1,
    organizationId: record.organizationId,
    ownerPrincipalId: record.ownerPrincipalId,
    subscriptionRef: record.subscriptionRef,
    reference: record.reference,
  };
}

function isBillingReference(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}

function isSubscriptionRef(value: string): boolean {
  return /^sra_[0-9a-f]{64}$/u.test(value);
}

function isVerifiedFor(
  receipt: SubscriptionCancellationReceipt,
  subscriptionRef: string,
): receipt is VerifiedSubscriptionCancellation {
  if (receipt.state !== "verified" || receipt.subscriptionRef !== subscriptionRef) return false;
  const date = new Date(receipt.effectiveAt);
  return Number.isFinite(date.getTime()) && date.toISOString() === receipt.effectiveAt;
}
