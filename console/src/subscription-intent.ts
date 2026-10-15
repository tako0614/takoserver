/** Storage boundary for one durable hosted-subscription Checkout reference. */
export interface SubscriptionIntentStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface SubscriptionIntentIdentity {
  readonly organizationId: string;
  readonly ownerPrincipalId: string;
  readonly planKey: string;
}

export interface SubscriptionIntentScope {
  readonly organizationId: string;
  readonly ownerPrincipalId: string;
}

export interface SubscriptionIntentRecord {
  readonly planKey: string;
  readonly reference: string;
}

export type SubscriptionIntentLock = <T>(
  name: string,
  operation: () => T | Promise<T>,
) => Promise<T>;

export interface SubscriptionIntentStoreOptions {
  readonly storage: SubscriptionIntentStorage;
  readonly uuid: () => string;
  readonly lock?: SubscriptionIntentLock;
}

export type SubscriptionIntentStoreErrorCode =
  | "invalid_identity"
  | "invalid_stored_intent"
  | "intent_scope_mismatch"
  | "invalid_reference"
  | "storage_unavailable"
  | "exclusive_lock_unavailable"
  | "intent_reference_mismatch";

export class SubscriptionIntentStoreError extends Error {
  constructor(readonly code: SubscriptionIntentStoreErrorCode) {
    super(code);
    this.name = "SubscriptionIntentStoreError";
  }
}

interface StoredIntent extends SubscriptionIntentIdentity {
  readonly version: 1;
  readonly reference: string;
}

/**
 * Browser storage retains custody of ambiguous requests. Only a conclusive
 * server `expired` receipt can authorize the explicit compare-and-remove path.
 */
export function createSubscriptionIntentStore(options: SubscriptionIntentStoreOptions) {
  return {
    peekScope(scope: SubscriptionIntentScope): SubscriptionIntentRecord | null {
      validateScope(scope);
      const serialized = read(options.storage, storageKey(scope));
      return serialized === null ? null : decodeForScope(serialized, scope);
    },

    peek(identity: SubscriptionIntentIdentity): string | null {
      validateIdentity(identity);
      const serialized = read(options.storage, storageKey(identity));
      return serialized === null ? null : decode(serialized, identity).reference;
    },

    async getOrCreate(
      identity: SubscriptionIntentIdentity,
      stillOwnsScope?: () => boolean,
    ): Promise<string> {
      validateIdentity(identity);
      const key = storageKey(identity);
      const existing = read(options.storage, key);
      if (existing !== null) return decode(existing, identity).reference;
      return withExclusiveLock(options.lock, key, () => {
        if (stillOwnsScope && !stillOwnsScope())
          throw new SubscriptionIntentStoreError("intent_scope_mismatch");
        const current = read(options.storage, key);
        if (current !== null) return decode(current, identity).reference;
        const reference = `console-subscription-${options.uuid()}`;
        if (!isBillingReference(reference))
          throw new SubscriptionIntentStoreError("invalid_reference");
        write(
          options.storage,
          key,
          JSON.stringify({ version: 1, ...identity, reference } satisfies StoredIntent),
        );
        return reference;
      });
    },

    async resetAfterExpiredCheckout(
      identity: SubscriptionIntentIdentity,
      reference: string,
      stillOwnsScope?: () => boolean,
    ): Promise<void> {
      validateIdentity(identity);
      if (!isBillingReference(reference))
        throw new SubscriptionIntentStoreError("invalid_reference");
      const key = storageKey(identity);
      await withExclusiveLock(options.lock, key, () => {
        if (stillOwnsScope && !stillOwnsScope())
          throw new SubscriptionIntentStoreError("intent_scope_mismatch");
        const serialized = read(options.storage, key);
        if (serialized === null)
          throw new SubscriptionIntentStoreError("intent_reference_mismatch");
        if (decode(serialized, identity).reference !== reference)
          throw new SubscriptionIntentStoreError("intent_reference_mismatch");
        try {
          options.storage.removeItem(key);
        } catch {
          throw new SubscriptionIntentStoreError("storage_unavailable");
        }
      });
    },

    /**
     * Rotates a terminal subscription's associated intent only when the
     * persisted reference still matches. Tabs that already observed the same
     * association share the one reference written by the first tab.
     */
    async rotateAfterTerminalAssociation(
      identity: SubscriptionIntentIdentity,
      reference: string,
      stillOwnsScope?: () => boolean,
    ): Promise<string> {
      validateIdentity(identity);
      if (!isBillingReference(reference))
        throw new SubscriptionIntentStoreError("invalid_reference");
      const key = storageKey(identity);
      return withExclusiveLock(options.lock, key, () => {
        if (stillOwnsScope && !stillOwnsScope())
          throw new SubscriptionIntentStoreError("intent_scope_mismatch");
        const serialized = read(options.storage, key);
        if (serialized === null)
          throw new SubscriptionIntentStoreError("intent_reference_mismatch");
        const current = decode(serialized, identity);
        if (current.reference !== reference) return current.reference;
        const nextReference = `console-subscription-${options.uuid()}`;
        if (!isBillingReference(nextReference) || nextReference === reference)
          throw new SubscriptionIntentStoreError("invalid_reference");
        write(
          options.storage,
          key,
          JSON.stringify({
            ...identity,
            version: 1,
            reference: nextReference,
          } satisfies StoredIntent),
        );
        return nextReference;
      });
    },
  };
}

export function browserSubscriptionIntentLock(): SubscriptionIntentLock {
  return async <T>(name: string, operation: () => T | Promise<T>): Promise<T> => {
    if (typeof navigator === "undefined" || typeof navigator.locks?.request !== "function")
      throw new SubscriptionIntentStoreError("exclusive_lock_unavailable");
    return navigator.locks.request(
      `takoserver.hosted-subscription-intent:${name}`,
      { mode: "exclusive" },
      () => operation(),
    );
  };
}

function validateIdentity(identity: SubscriptionIntentIdentity): void {
  if (
    !identity ||
    !isNonEmpty(identity.organizationId) ||
    !isNonEmpty(identity.ownerPrincipalId) ||
    typeof identity.planKey !== "string" ||
    !/^[a-z][a-z0-9_-]{0,63}$/u.test(identity.planKey)
  )
    throw new SubscriptionIntentStoreError("invalid_identity");
}

function validateScope(scope: SubscriptionIntentScope): void {
  if (!scope || !isNonEmpty(scope.organizationId) || !isNonEmpty(scope.ownerPrincipalId))
    throw new SubscriptionIntentStoreError("invalid_identity");
}

function isNonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function storageKey(identity: SubscriptionIntentScope): string {
  return `takoserver.hosted-subscription-intent.v1:${encodeURIComponent(identity.ownerPrincipalId)}:${encodeURIComponent(identity.organizationId)}`;
}

function read(storage: SubscriptionIntentStorage, key: string): string | null {
  try {
    return storage.getItem(key);
  } catch {
    throw new SubscriptionIntentStoreError("storage_unavailable");
  }
}

function write(storage: SubscriptionIntentStorage, key: string, value: string): void {
  try {
    storage.setItem(key, value);
  } catch {
    throw new SubscriptionIntentStoreError("storage_unavailable");
  }
}

async function withExclusiveLock<T>(
  lock: SubscriptionIntentLock | undefined,
  name: string,
  operation: () => T | Promise<T>,
): Promise<T> {
  if (!lock) throw new SubscriptionIntentStoreError("exclusive_lock_unavailable");
  try {
    return await lock(name, operation);
  } catch (error) {
    if (error instanceof SubscriptionIntentStoreError) throw error;
    throw new SubscriptionIntentStoreError("exclusive_lock_unavailable");
  }
}

function decode(serialized: string, identity: SubscriptionIntentIdentity): StoredIntent {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new SubscriptionIntentStoreError("invalid_stored_intent");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SubscriptionIntentStoreError("invalid_stored_intent");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.organizationId !== "string" ||
    typeof record.ownerPrincipalId !== "string" ||
    typeof record.planKey !== "string" ||
    typeof record.reference !== "string"
  )
    throw new SubscriptionIntentStoreError("invalid_stored_intent");
  if (
    record.organizationId !== identity.organizationId ||
    record.ownerPrincipalId !== identity.ownerPrincipalId ||
    record.planKey !== identity.planKey
  )
    throw new SubscriptionIntentStoreError("intent_scope_mismatch");
  if (!isBillingReference(record.reference))
    throw new SubscriptionIntentStoreError("invalid_stored_intent");
  return {
    version: 1,
    organizationId: record.organizationId,
    ownerPrincipalId: record.ownerPrincipalId,
    planKey: record.planKey,
    reference: record.reference,
  };
}

function decodeForScope(
  serialized: string,
  scope: SubscriptionIntentScope,
): SubscriptionIntentRecord {
  let value: unknown;
  try {
    value = JSON.parse(serialized) as unknown;
  } catch {
    throw new SubscriptionIntentStoreError("invalid_stored_intent");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new SubscriptionIntentStoreError("invalid_stored_intent");
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    typeof record.organizationId !== "string" ||
    typeof record.ownerPrincipalId !== "string" ||
    typeof record.planKey !== "string" ||
    typeof record.reference !== "string"
  )
    throw new SubscriptionIntentStoreError("invalid_stored_intent");
  if (
    record.organizationId !== scope.organizationId ||
    record.ownerPrincipalId !== scope.ownerPrincipalId
  )
    throw new SubscriptionIntentStoreError("intent_scope_mismatch");
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(record.planKey) || !isBillingReference(record.reference))
    throw new SubscriptionIntentStoreError("invalid_stored_intent");
  return { planKey: record.planKey, reference: record.reference };
}

function isBillingReference(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(value);
}
