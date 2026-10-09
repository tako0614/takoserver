import type { RuntimeInputSealKey } from "./runtime-input-preparations.ts";
import {
  type V2PrivateInputCustody,
  type V2PrivateInputKey,
  validatePrivateInputCustody,
} from "./takoform-v2/private-inputs.ts";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const RAW_AES_256 = /^[A-Za-z0-9_-]{43}$/u;
const MAX_PREVIOUS_KEYS = 2;
const encoder = new TextEncoder();
const V2_CUSTODY_SALT = encoder.encode("takoserver/selfhost/v2/private-input-custody@v1");
const V2_TRANSFER_INFO = encoder.encode("transfer/AES-256-GCM@v1");
const V2_COMPARISON_INFO = encoder.encode("comparison/HMAC-SHA-256@v1");
const V2_TRANSFER_TTL_SECONDS = 300;

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
  return (await parseKeyRing(raw, false)).sealKeys;
}

/** Import the same validated operator ring once for legacy and v2 custody. */
export async function parseRuntimeInputKeyAuthority(raw: string): Promise<{
  readonly sealKeys: RuntimeInputSealKeyRing;
  readonly privateInputCustody: V2PrivateInputCustody;
}> {
  const parsed = await parseKeyRing(raw, true);
  if (!parsed.privateInputCustody) throw invalidKeyRing();
  return { sealKeys: parsed.sealKeys, privateInputCustody: parsed.privateInputCustody };
}

async function parseKeyRing(
  raw: string,
  withPrivateCustody: boolean,
): Promise<{
  readonly sealKeys: RuntimeInputSealKeyRing;
  readonly privateInputCustody?: V2PrivateInputCustody;
}> {
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
  const transfer: V2PrivateInputKey[] = [];
  const comparison: V2PrivateInputKey[] = [];
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
      if (withPrivateCustody) {
        const base = await crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
        const [transferKey, comparisonKey] = await Promise.all([
          crypto.subtle.deriveKey(
            { name: "HKDF", hash: "SHA-256", salt: V2_CUSTODY_SALT, info: V2_TRANSFER_INFO },
            base,
            { name: "AES-GCM", length: 256 },
            false,
            ["encrypt", "decrypt"],
          ),
          crypto.subtle.deriveKey(
            { name: "HKDF", hash: "SHA-256", salt: V2_CUSTODY_SALT, info: V2_COMPARISON_INFO },
            base,
            { name: "HMAC", hash: "SHA-256", length: 256 },
            false,
            ["sign", "verify"],
          ),
        ]);
        transfer.push({ id: candidate.id, key: transferKey });
        comparison.push({ id: candidate.id, key: comparisonKey });
      }
    } catch {
      throw invalidKeyRing();
    } finally {
      bytes.fill(0);
    }
  }
  const current = imported[0];
  if (!current) throw invalidKeyRing();
  const previous = imported.slice(1);
  const sealKeys = { current, ...(previous.length === 0 ? {} : { previous }) };
  if (!withPrivateCustody) return { sealKeys };
  const transferCurrent = transfer[0];
  const comparisonCurrent = comparison[0];
  if (!transferCurrent || !comparisonCurrent) throw invalidKeyRing();
  const privateInputCustody: V2PrivateInputCustody = {
    transfer: {
      current: transferCurrent,
      ...(transfer.length > 1 ? { previous: transfer.slice(1) } : {}),
    },
    comparison: {
      current: comparisonCurrent,
      ...(comparison.length > 1 ? { previous: comparison.slice(1) } : {}),
    },
    transferTtlSeconds: V2_TRANSFER_TTL_SECONDS,
  };
  validatePrivateInputCustody(privateInputCustody);
  return { sealKeys, privateInputCustody };
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
