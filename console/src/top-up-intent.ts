/** Storage boundary for one durable hosted top-up Checkout reference. */
export interface TopUpIntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface TopUpIntentScope {
  readonly organizationId: string;
  readonly ownerPrincipalId: string;
}

export interface TopUpIntentIdentity extends TopUpIntentScope {
  readonly amountMinor: number;
}

export interface TopUpIntentRecord {
  readonly reference: string;
  readonly amountMinor: number;
}

/** The only receipt states that conclude a top-up reference. */
export interface ConclusiveTopUpReceipt {
  readonly reference: string;
  readonly state: "paid" | "expired";
}

export type TopUpIntentLock = <T>(name: string, operation: () => T | Promise<T>) => Promise<T>;

export interface TopUpIntentStoreOptions {
  readonly storage: TopUpIntentStorage;
  readonly uuid: () => string;
  readonly lock?: TopUpIntentLock;
}

export type TopUpIntentStoreErrorCode =
  | "invalid_identity"
  | "invalid_stored_intent"
  | "intent_scope_mismatch"
  | "invalid_reference"
  | "invalid_receipt"
  | "storage_unavailable"
  | "exclusive_lock_unavailable"
  | "intent_amount_mismatch"
  | "intent_reference_mismatch";

export class TopUpIntentStoreError extends Error {
  constructor(readonly code: TopUpIntentStoreErrorCode) {
    super(code);
    this.name = "TopUpIntentStoreError";
  }
}

interface StoredIntent extends TopUpIntentIdentity {
  readonly version: 1;
  readonly reference: string;
}

/**
 * One unresolved hosted top-up per owner and Organization. The server
 * fingerprints the original command, so a reference is never reused with a
 * different amount. Browser storage retains custody of ambiguous requests; only
 * a conclusive `paid` or `expired` receipt for the exact stored reference can
 * authorize the compare-and-remove path.
 */
export function createTopUpIntentStore(options: TopUpIntentStoreOptions) {
  return {
    peek(scope: TopUpIntentScope): TopUpIntentRecord | null {
      validateScope(scope);
      const serialized = read(options.storage, storageKey(scope));
      if (serialized === null) return null;
      const stored = decode(serialized, scope);
      return { reference: stored.reference, amountMinor: stored.amountMinor };
    },

    async getOrCreate(
      identity: TopUpIntentIdentity,
      stillOwnsScope?: () => boolean,
    ): Promise<string> {
      validateIdentity(identity);
      const key = storageKey(identity);
      const existing = read(options.storage, key);
      if (existing !== null) return matching(decode(existing, identity), identity).reference;
      return withExclusiveLock(options.lock, key, () => {
        if (stillOwnsScope && !stillOwnsScope())
          throw new TopUpIntentStoreError("intent_scope_mismatch");
        const current = read(options.storage, key);
        if (current !== null) return matching(decode(current, identity), identity).reference;
        const reference = `console-top-up-${options.uuid()}`;
        if (!isBillingReference(reference)) throw new TopUpIntentStoreError("invalid_reference");
        write(
          options.storage,
          key,
          JSON.stringify({ version: 1, ...identity, reference } satisfies StoredIntent),
        );
        return reference;
      });
    },

    async removeAfterConclusiveReceipt(
      scope: TopUpIntentScope,
      receipt: ConclusiveTopUpReceipt,
      stillOwnsScope?: () => boolean,
    ): Promise<void> {
      validateScope(scope);
      if (!receipt || (receipt.state !== "paid" && receipt.state !== "expired"))
        throw new TopUpIntentStoreError("invalid_receipt");
      if (typeof receipt.reference !== "string" || !isBillingReference(receipt.reference))
        throw new TopUpIntentStoreError("invalid_reference");
      const key = storageKey(scope);
      await withExclusiveLock(options.lock, key, () => {
        if (stillOwnsScope && !stillOwnsScope())
          throw new TopUpIntentStoreError("intent_scope_mismatch");
        const serialized = read(options.storage, key);
        if (serialized === null) throw new TopUpIntentStoreError("intent_reference_mismatch");
        if (decode(serialized, scope).reference !== receipt.reference)
          throw new TopUpIntentStoreError("intent_reference_mismatch");
        try {
          options.storage.removeItem(key);
        } catch {
          throw new TopUpIntentStoreError("storage_unavailable");
        }
      });
    },
  };
}

export function browserTopUpIntentLock(): TopUpIntentLock {
  return async <T>(name: string, operation: () => T | Promise<T>): Promise<T> => {
    if (typeof navigator === "undefined" || typeof navigator.locks?.request !== "function")
      throw new TopUpIntentStoreError("exclusive_lock_unavailable");
    return navigator.locks.request(
      `takoserver.hosted-top-up-intent:${name}`,
      { mode: "exclusive" },
      () => operation(),
    );
  };
}

function validateIdentity(identity: TopUpIntentIdentity): void {
  validateScope(identity);
  if (!isAmountMinor(identity.amountMinor)) throw new TopUpIntentStoreError("invalid_identity");
}

function validateScope(scope: TopUpIntentScope): void {
  if (!scope || !isNonEmpty(scope.organizationId) || !isNonEmpty(scope.ownerPrincipalId))
    throw new TopUpIntentStoreError("invalid_identity");
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isAmountMinor(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function storageKey(scope: TopUpIntentScope): string {
  return `takoserver.hosted-top-up-intent.v1:${encodeURIComponent(scope.ownerPrincipalId)}:${encodeURIComponent(scope.organizationId)}`;
}

function read(storage: TopUpIntentStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    throw new TopUpIntentStoreError("storage_unavailable");
  }
}

function write(storage: TopUpIntentStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    throw new TopUpIntentStoreError("storage_unavailable");
  }
}

async function withExclusiveLock<T>(
  lock: TopUpIntentLock | undefined,
  name: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!lock) throw new TopUpIntentStoreError("exclusive_lock_unavailable");
  try {
    return await lock(name, operation);
  } catch (error) {
    if (error instanceof TopUpIntentStoreError) throw error;
    throw new TopUpIntentStoreError("exclusive_lock_unavailable");
  }
}

function matching(stored: StoredIntent, identity: TopUpIntentIdentity): StoredIntent {
  if (stored.amountMinor !== identity.amountMinor)
    throw new TopUpIntentStoreError("intent_amount_mismatch");
  return stored;
}

function decode(serialized: string, scope: TopUpIntentScope): StoredIntent {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new TopUpIntentStoreError("invalid_stored_intent");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new TopUpIntentStoreError("invalid_stored_intent");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.organizationId !== "string" ||
    typeof record.ownerPrincipalId !== "string" ||
    typeof record.reference !== "string" ||
    !isAmountMinor(record.amountMinor)
  )
    throw new TopUpIntentStoreError("invalid_stored_intent");
  if (
    record.organizationId !== scope.organizationId ||
    record.ownerPrincipalId !== scope.ownerPrincipalId
  )
    throw new TopUpIntentStoreError("intent_scope_mismatch");
  if (!isBillingReference(record.reference))
    throw new TopUpIntentStoreError("invalid_stored_intent");
  return {
    version: 1,
    organizationId: record.organizationId,
    ownerPrincipalId: record.ownerPrincipalId,
    amountMinor: record.amountMinor,
    reference: record.reference,
  };
}

function isBillingReference(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
