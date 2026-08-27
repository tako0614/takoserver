import type { JsonObject, JsonValue } from "./ports.ts";

const MAX_DOCUMENT_BYTES = 32 * 1024;
const MAX_DEPTH = 16;
const MAX_NODES = 1_024;
const MAX_ARRAY_ITEMS = 128;
const MAX_OBJECT_ENTRIES = 128;
const MAX_KEY_BYTES = 256;
const MAX_STRING_BYTES = 8_192;

/**
 * Opaque, signed authority carried only by a short-lived Takoform Run token.
 *
 * Takoserver deliberately does not interpret the owning host's request
 * schema. The selected materializer re-reads and validates its canonical
 * control-plane record immediately before returning exact Worker bindings.
 */
export type RuntimeMaterializationAuthority = JsonObject;

/**
 * The materializer input is reused byte-for-byte for activation after the
 * immutable Worker Version upload. Keeping one value for both calls prevents
 * a retry from accidentally activating a different request, resource,
 * origin, or binding set than the one whose secret values were uploaded.
 */
export interface RuntimeMaterializationInput {
  readonly request: RuntimeMaterializationAuthority;
  readonly resourceName: string;
  readonly scriptName: string;
  readonly publicOrigin: string;
  readonly bindings: readonly string[];
}

/**
 * Values exist only long enough to build one immutable Worker Version. A
 * materializer may also return an opaque receipt for host-side mutations it
 * made while deriving those values. Takoserver never interprets the receipt;
 * it only returns it to the same private materializer if the Version upload
 * does not complete.
 */
export interface RuntimeMaterializationResult {
  readonly values: Readonly<Record<string, string>>;
  readonly rollbackReceipt?: string;
}

/** Private provider-composition capability; no public HTTP route is implied. */
export interface RuntimeMaterializer {
  materializeRuntimeBindings(
    input: RuntimeMaterializationInput,
  ): Promise<RuntimeMaterializationResult>;
  /**
   * Idempotently activates the host-side record for the uploaded Version.
   * This runs only after the provider has a valid immutable Version id; a
   * refusal therefore cannot be mistaken for a successful provider apply.
   */
  commitRuntimeBindings(input: RuntimeMaterializationInput): Promise<void>;
  rollbackRuntimeBindings(input: {
    readonly request: RuntimeMaterializationAuthority;
    readonly rollbackReceipt: string;
  }): Promise<void>;
}

/**
 * Bounds an otherwise opaque JSON authority before it enters a signed token.
 * This is transport validation, not ownership of the external contract.
 */
export function boundedRuntimeMaterialization(value: unknown): RuntimeMaterializationAuthority {
  let nodes = 0;
  const visit = (candidate: unknown, depth: number): JsonValue => {
    nodes += 1;
    if (nodes > MAX_NODES || depth > MAX_DEPTH) invalid();
    if (
      candidate === null ||
      typeof candidate === "boolean" ||
      (typeof candidate === "number" && Number.isFinite(candidate))
    ) {
      return candidate as null | boolean | number;
    }
    if (typeof candidate === "string") {
      if (bytes(candidate) > MAX_STRING_BYTES || hasDisallowedTextControl(candidate)) {
        invalid();
      }
      return candidate;
    }
    if (Array.isArray(candidate)) {
      if (candidate.length > MAX_ARRAY_ITEMS) invalid();
      return candidate.map((entry) => visit(entry, depth + 1));
    }
    if (typeof candidate !== "object" || candidate === null) invalid();
    const prototype = Object.getPrototypeOf(candidate);
    if (prototype !== Object.prototype && prototype !== null) invalid();
    const entries = Object.entries(candidate as Record<string, unknown>);
    if (entries.length > MAX_OBJECT_ENTRIES) invalid();
    const result: Record<string, JsonValue> = {};
    for (const [key, entry] of entries) {
      if (
        key.length === 0 ||
        bytes(key) > MAX_KEY_BYTES ||
        hasAnyControl(key) ||
        Object.hasOwn(result, key)
      ) {
        invalid();
      }
      result[key] = visit(entry, depth + 1);
    }
    return result;
  };
  const parsed = visit(value, 0);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) invalid();
  const encoded = JSON.stringify(parsed);
  if (bytes(encoded) > MAX_DOCUMENT_BYTES) invalid();
  return parsed as RuntimeMaterializationAuthority;
}

function bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function hasDisallowedTextControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return (
      code === 0x7f ||
      code <= 0x08 ||
      code === 0x0b ||
      code === 0x0c ||
      (code >= 0x0e && code <= 0x1f)
    );
  });
}

function hasAnyControl(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || code === 0x7f;
  });
}

function invalid(): never {
  throw new TypeError("runtime materialization authority is invalid");
}
