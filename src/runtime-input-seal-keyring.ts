import type { RuntimeInputSealKey } from "./runtime-input-preparations.ts";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RAW_AES_256 = /^[A-Za-z0-9_-]{43}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
export const MAX_RUNTIME_INPUT_SEAL_PREVIOUS_KEYS = 2;

export interface RuntimeInputSealKeyRingDescriptor {
  readonly currentKeyId: string;
  readonly previousKeyIds: readonly string[];
  readonly commitment: `sha256:${string}`;
}

export interface RuntimeInputSealKeyRing {
  readonly current: RuntimeInputSealKey;
  readonly previous?: readonly RuntimeInputSealKey[];
}

interface EncodedKey {
  readonly id: string;
  readonly key: string;
}

interface EncodedKeyRing {
  readonly current: EncodedKey;
  readonly previous: readonly EncodedKey[];
  readonly canonical: string;
}

/** Parses the closed, non-secret deploy/runtime identity for one key ring. */
export function parseRuntimeInputSealKeyRingDescriptor(
  value: unknown,
): RuntimeInputSealKeyRingDescriptor {
  const descriptor = exactRecord(
    value,
    ["currentKeyId", "previousKeyIds", "commitment"],
    ["currentKeyId", "previousKeyIds", "commitment"],
  );
  if (
    typeof descriptor.currentKeyId !== "string" ||
    !KEY_ID.test(descriptor.currentKeyId) ||
    !Array.isArray(descriptor.previousKeyIds) ||
    descriptor.previousKeyIds.length > MAX_RUNTIME_INPUT_SEAL_PREVIOUS_KEYS ||
    !descriptor.previousKeyIds.every((id) => typeof id === "string" && KEY_ID.test(id)) ||
    typeof descriptor.commitment !== "string" ||
    !SHA256.test(descriptor.commitment)
  ) {
    throw invalidKeyRing();
  }
  const previousKeyIds = descriptor.previousKeyIds as string[];
  if (new Set([descriptor.currentKeyId, ...previousKeyIds]).size !== previousKeyIds.length + 1) {
    throw invalidKeyRing();
  }
  return {
    currentKeyId: descriptor.currentKeyId,
    previousKeyIds: [...previousKeyIds],
    commitment: descriptor.commitment as `sha256:${string}`,
  };
}

/**
 * Validates canonical secret bytes without returning any key material.
 *
 * Deploy code uses this small interface to bind an owned private file to the
 * non-secret target descriptor before the file may enter a sealed Wrangler
 * secrets file.
 */
export async function inspectCanonicalRuntimeInputSealKeyRing(
  raw: string,
): Promise<RuntimeInputSealKeyRingDescriptor> {
  const encoded = parseCanonicalEncodedKeyRing(raw);
  for (const candidate of [encoded.current, ...encoded.previous]) {
    const bytes = decodeKey(candidate.key);
    bytes.fill(0);
  }
  return await descriptorFor(encoded);
}

/**
 * Parses the one operator-private runtime-input key ring and proves its exact
 * non-secret deployment identity before importing any key for use.
 *
 * The JSON bytes are canonical and closed so whitespace, reordered members,
 * or a misspelled rotation field cannot silently select different authority.
 * Raw key bytes are imported into non-extractable WebCrypto keys and then
 * overwritten. Errors never contain the private bytes.
 */
export async function parseRuntimeInputSealKeyRing(
  raw: string,
  expectedValue: unknown,
): Promise<RuntimeInputSealKeyRing> {
  const expected = parseRuntimeInputSealKeyRingDescriptor(expectedValue);
  const encoded = parseCanonicalEncodedKeyRing(raw);
  const actual = await descriptorFor(encoded);
  if (!sameDescriptor(actual, expected)) throw invalidKeyRing();

  const imported: RuntimeInputSealKey[] = [];
  for (const candidate of [encoded.current, ...encoded.previous]) {
    const bytes = decodeKey(candidate.key);
    try {
      const key = await crypto.subtle.importKey(
        "raw",
        bytes,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
      imported.push({ keyId: candidate.id, key });
    } catch {
      throw invalidKeyRing();
    } finally {
      bytes.fill(0);
    }
  }
  const current = imported[0];
  if (!current) throw invalidKeyRing();
  const previous = imported.slice(1);
  return {
    current,
    ...(previous.length === 0 ? {} : { previous }),
  };
}

function parseCanonicalEncodedKeyRing(raw: string): EncodedKeyRing {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidKeyRing();
  }
  const ring = exactRecord(value, ["current", "previous"], ["current"]);
  const previousValue = ring.previous ?? [];
  if (
    !Array.isArray(previousValue) ||
    previousValue.length > MAX_RUNTIME_INPUT_SEAL_PREVIOUS_KEYS
  ) {
    throw invalidKeyRing();
  }
  const current = parseEncodedKey(ring.current);
  const previous = previousValue.map(parseEncodedKey);
  const ids = [current, ...previous].map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) throw invalidKeyRing();
  const canonical = JSON.stringify({
    current,
    ...(previous.length === 0 ? {} : { previous }),
  });
  if (raw !== canonical) throw invalidKeyRing();
  return { current, previous, canonical };
}

async function descriptorFor(encoded: EncodedKeyRing): Promise<RuntimeInputSealKeyRingDescriptor> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(encoded.canonical));
  return {
    currentKeyId: encoded.current.id,
    previousKeyIds: encoded.previous.map(({ id }) => id),
    commitment: `sha256:${hex(new Uint8Array(digest))}`,
  };
}

function sameDescriptor(
  left: RuntimeInputSealKeyRingDescriptor,
  right: RuntimeInputSealKeyRingDescriptor,
): boolean {
  return (
    left.currentKeyId === right.currentKeyId &&
    left.commitment === right.commitment &&
    JSON.stringify(left.previousKeyIds) === JSON.stringify(right.previousKeyIds)
  );
}

function parseEncodedKey(value: unknown): EncodedKey {
  const record = exactRecord(value, ["id", "key"], ["id", "key"]);
  if (
    typeof record.id !== "string" ||
    !KEY_ID.test(record.id) ||
    typeof record.key !== "string" ||
    !RAW_AES_256.test(record.key)
  ) {
    throw invalidKeyRing();
  }
  return { id: record.id, key: record.key };
}

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw invalidKeyRing();
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key) => !allowed.includes(key)) ||
    required.some((key) => !Object.hasOwn(record, key))
  ) {
    throw invalidKeyRing();
  }
  return record;
}

function decodeKey(value: string): Uint8Array<ArrayBuffer> {
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}`.padEnd(44, "=");
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw invalidKeyRing();
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32 || encodeKey(bytes) !== value) {
    bytes.fill(0);
    throw invalidKeyRing();
  }
  return bytes;
}

function encodeKey(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function invalidKeyRing(): TypeError {
  return new TypeError("runtime input seal key ring is invalid");
}
