import { sha256 } from "@noble/hashes/sha2.js";

const SafeReflectApply = Reflect.apply;
const SafeObjectFreeze = Object.freeze;
const SafeObjectGetPrototypeOf = Object.getPrototypeOf;
const SafeStringCharCodeAt = String.prototype.charCodeAt;
const SafeUint8Array = Uint8Array;
const CapturedCrypto = globalThis.crypto;
const CapturedCryptoGetRandomValues = CapturedCrypto
  ? (SafeObjectGetPrototypeOf(CapturedCrypto)?.getRandomValues ?? CapturedCrypto.getRandomValues)
  : undefined;

const NAME_DOMAIN = new SafeUint8Array([
  116, 97, 107, 111, 115, 101, 114, 118, 101, 114, 46, 97, 99, 116, 111, 114, 46, 110, 97, 109, 101,
  46, 118, 49, 0,
]);
const HEX = "0123456789abcdef";
const MAX_NAME_CODEPOINTS = 2048;
const MAX_ID_CODEPOINTS = 256;
const UNIQUE_ID_BYTES = 32;

export type ActorAddressingErrorCode = "invalid_name" | "backend_unavailable";

export class ActorAddressingError extends Error {
  readonly code: ActorAddressingErrorCode;

  constructor(code: ActorAddressingErrorCode) {
    super(code);
    this.name = "ActorAddressingError";
    this.code = code;
  }
}

export interface ActorAddressing {
  idFromName(name: string): string;
  newUniqueId(): string;
  isValidActorId(value: unknown): boolean;
}

export interface ActorAddressingOptions {
  /** Trusted host-only randomness seam. `null` deliberately disables minting. */
  readonly randomBytes?: ((target: Uint8Array) => void) | null;
}

function codePointCountAtMost(value: string, limit: number): number | null {
  let codePoints = 0;
  let unitIndex = 0;

  while (unitIndex < value.length) {
    const first = SafeReflectApply(SafeStringCharCodeAt, value, [unitIndex]) as number;
    unitIndex += 1;
    if (first >= 0xd800 && first <= 0xdbff && unitIndex < value.length) {
      const second = SafeReflectApply(SafeStringCharCodeAt, value, [unitIndex]) as number;
      if (second >= 0xdc00 && second <= 0xdfff) unitIndex += 1;
    }
    codePoints += 1;
    if (codePoints > limit) return null;
  }

  return codePoints;
}

function hex(bytes: Uint8Array): string {
  let output = "";
  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index] ?? 0;
    output += (HEX[byte >>> 4] ?? "0") + (HEX[byte & 0x0f] ?? "0");
  }
  return output;
}

function defaultRandomBytes(target: Uint8Array): void {
  if (!CapturedCrypto || typeof CapturedCryptoGetRandomValues !== "function")
    throw new ActorAddressingError("backend_unavailable");
  SafeReflectApply(CapturedCryptoGetRandomValues, CapturedCrypto, [target]);
}

/**
 * Host-owned opaque Actor addressing. The name hash is an internal encoding;
 * it is not a portable identity format for Forms or another product.
 */
export function createActorAddressing(options?: ActorAddressingOptions): ActorAddressing {
  const randomBytes = options?.randomBytes === undefined ? defaultRandomBytes : options.randomBytes;

  const idFromName = (name: string): string => {
    if (typeof name !== "string") throw new ActorAddressingError("invalid_name");
    const count = codePointCountAtMost(name, MAX_NAME_CODEPOINTS);
    if (count === null || count < 1) throw new ActorAddressingError("invalid_name");

    const input = new SafeUint8Array(NAME_DOMAIN.length + name.length * 2);
    for (let index = 0; index < NAME_DOMAIN.length; index += 1) {
      input[index] = NAME_DOMAIN[index] ?? 0;
    }
    for (let index = 0; index < name.length; index += 1) {
      const codeUnit = SafeReflectApply(SafeStringCharCodeAt, name, [index]) as number;
      const outputOffset = NAME_DOMAIN.length + index * 2;
      input[outputOffset] = codeUnit & 0xff;
      input[outputOffset + 1] = codeUnit >>> 8;
    }

    return `n1_${hex(sha256(input))}`;
  };

  const newUniqueId = (): string => {
    if (typeof randomBytes !== "function") throw new ActorAddressingError("backend_unavailable");
    const bytes = new SafeUint8Array(UNIQUE_ID_BYTES);
    try {
      randomBytes(bytes);
    } catch {
      throw new ActorAddressingError("backend_unavailable");
    }
    return `u1_${hex(bytes)}`;
  };

  const isValidActorId = (value: unknown): boolean =>
    typeof value === "string" &&
    codePointCountAtMost(value, MAX_ID_CODEPOINTS) !== null &&
    value.length > 0;

  return SafeObjectFreeze({ idFromName, newUniqueId, isValidActorId });
}
