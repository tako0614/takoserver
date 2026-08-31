import type { RuntimeInputSealKey } from "./runtime-input-preparations.ts";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RAW_AES_256 = /^[A-Za-z0-9_-]{43}$/u;
const MAX_PREVIOUS_KEYS = 2;

export interface RuntimeInputSealKeyRing {
  readonly current: RuntimeInputSealKey;
  readonly previous?: readonly RuntimeInputSealKey[];
}

/**
 * Parses the one operator-private runtime-input key ring.
 *
 * The JSON shape is deliberately closed so a misspelled rotation field cannot
 * silently start a deployment with a different key authority. Raw key bytes
 * are imported into non-extractable WebCrypto keys and then overwritten.
 */
export async function parseRuntimeInputSealKeyRing(raw: string): Promise<RuntimeInputSealKeyRing> {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw invalidKeyRing();
  }
  const ring = exactRecord(value, ["current", "previous"], ["current"]);
  const previousValue = ring.previous ?? [];
  if (!Array.isArray(previousValue) || previousValue.length > MAX_PREVIOUS_KEYS) {
    throw invalidKeyRing();
  }
  const encoded = [ring.current, ...previousValue].map(parseEncodedKey);
  const ids = encoded.map((candidate) => candidate.id);
  if (new Set(ids).size !== ids.length) throw invalidKeyRing();

  const imported: RuntimeInputSealKey[] = [];
  for (const candidate of encoded) {
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

function parseEncodedKey(value: unknown): { readonly id: string; readonly key: string } {
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
  const padded = `${value.replaceAll("-", "+").replaceAll("_", "/")}=`;
  let decoded: string;
  try {
    decoded = atob(padded);
  } catch {
    throw invalidKeyRing();
  }
  const bytes = Uint8Array.from(decoded, (character) => character.charCodeAt(0));
  if (bytes.byteLength !== 32 || encodeKey(bytes) !== value) throw invalidKeyRing();
  return bytes;
}

function encodeKey(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function invalidKeyRing(): TypeError {
  return new TypeError("runtime input seal key ring is invalid");
}
