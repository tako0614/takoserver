import type { TakoformInterfaceRef } from "./interface-ref.ts";

export const ACTOR_ABI_INTERFACE_REFS = Object.freeze({
  legacy: Object.freeze({
    apiVersion: "interfaces.takoform.com/v1alpha1",
    name: "worker.actor",
    version: "1.0.0",
    schemaDigest: "sha256:f5428fb587de80261dd7363dc5b8a3f4aab7e469fa1b5fce8441ad9acbec8218",
  } satisfies TakoformInterfaceRef),
  v2: Object.freeze({
    apiVersion: "interfaces.takoform.com/v1alpha1",
    name: "worker.actor",
    version: "2.0.0",
    schemaDigest: "sha256:f4d70bb6d63c436e43b2e6cc50069fa6ed68eca68aea2fbc10a77969738db156",
  } satisfies TakoformInterfaceRef),
});

export type ActorAbiRefKind = keyof typeof ACTOR_ABI_INTERFACE_REFS;

export interface ParsedActorAbiRef {
  readonly kind: ActorAbiRefKind;
  readonly ref: TakoformInterfaceRef;
}

const safeArrayIsArray = Array.isArray;
const safeGetOwnPropertyDescriptor = Object.getOwnPropertyDescriptor;
const safeHasOwn = Object.hasOwn;
const safeObjectCreate = Object.create;
const safeObjectEntries = Object.entries;
const safeObjectFreeze = Object.freeze;
const safeOwnKeys = Reflect.ownKeys;

/** Accepts only complete selected Actor identities; never falls back by name or version. */
export function parseActorAbiRef(value: unknown): ParsedActorAbiRef | null {
  try {
    if ((typeof value !== "object" || value === null) && typeof value !== "function") return null;
    if (safeArrayIsArray(value)) return null;
    const ownKeys = safeOwnKeys(value);
    if (ownKeys.length !== 4) return null;
    for (let index = 0; index < ownKeys.length; index += 1) {
      if (typeof ownKeys[index] !== "string") return null;
    }
    if (
      !hasName(ownKeys as string[], "apiVersion") ||
      !hasName(ownKeys as string[], "name") ||
      !hasName(ownKeys as string[], "version") ||
      !hasName(ownKeys as string[], "schemaDigest")
    ) {
      return null;
    }
    const record = safeObjectCreate(null) as Record<string, unknown>;
    for (let index = 0; index < ownKeys.length; index += 1) {
      const name = ownKeys[index];
      if (typeof name !== "string") return null;
      const descriptor = safeGetOwnPropertyDescriptor(value, name);
      if (descriptor === undefined || !safeHasOwn(descriptor, "value")) return null;
      record[name] = descriptor.value;
    }

    const entries = safeObjectEntries(ACTOR_ABI_INTERFACE_REFS) as Array<
      [ActorAbiRefKind, TakoformInterfaceRef]
    >;
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index];
      if (!entry) continue;
      const [kind, expected] = entry;
      if (
        record.apiVersion === expected.apiVersion &&
        record.name === expected.name &&
        record.version === expected.version &&
        record.schemaDigest === expected.schemaDigest
      ) {
        return safeObjectFreeze({ kind, ref: expected });
      }
    }
  } catch {
    // Proxy traps and malformed descriptors are not a contract identity.
  }
  return null;
}

function hasName(names: readonly string[], expected: string): boolean {
  for (let index = 0; index < names.length; index += 1) {
    if (names[index] === expected) return true;
  }
  return false;
}
