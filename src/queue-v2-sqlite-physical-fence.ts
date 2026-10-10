const physicalFenceBrand: unique symbol = Symbol("SQLite locked physical set");

/** Minted only while every selected SQLite UID shard is locked and its original CREATE is proven. */
export interface SQLiteLockedPhysicalSet {
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly bindings: readonly Readonly<{ name: string; resourceUid: string }>[];
  /** Fails closed if retained beyond the store's locked callback. */
  assertHeld(): void;
  readonly [physicalFenceBrand]: true;
}

/** Internal Host mint. Never expose this constructor or its brand through package exports. */
export function mintSQLiteLockedPhysicalSet(input: {
  readonly targetKey: string;
  readonly principal: string;
  readonly space: string;
  readonly bindings: readonly Readonly<{ name: string; resourceUid: string }>[];
  readonly assertHeld: () => void;
}): SQLiteLockedPhysicalSet {
  return Object.freeze({
    targetKey: input.targetKey,
    principal: input.principal,
    space: input.space,
    bindings: input.bindings,
    assertHeld: input.assertHeld,
    [physicalFenceBrand]: true as const,
  });
}
