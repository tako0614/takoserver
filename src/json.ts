import type { JsonObject, JsonValue } from "./ports.ts";

export type { JsonObject, JsonValue };

/**
 * Deterministic JSON with object keys sorted at every depth.
 *
 * This function is load-bearing for the frozen Takoform wire contract: prepare
 * digests, replay fingerprints, and offering digests are all SHA-256 over its
 * output, and a released provider already pins those hashes. Its behaviour may
 * never change — not the key ordering, not the number formatting, not the
 * treatment of `undefined`. It exists exactly once for that reason; five
 * copy-pasted versions used to be five chances to drift apart.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

/** SHA-256 of the canonical encoding, as the `sha256:<hex>` form used on the wire. */
export async function canonicalDigest(value: unknown): Promise<`sha256:${string}`> {
  return `sha256:${await hex(new TextEncoder().encode(canonicalJson(value)))}`;
}

/** SHA-256 of raw bytes, as `sha256:<hex>`. Used for request bodies and blobs. */
export async function bytesDigest(bytes: ArrayBuffer | Uint8Array): Promise<`sha256:${string}`> {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  return `sha256:${await hex(view)}`;
}

export function isSha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

export function isJsonObject(value: unknown): value is JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

export function base64UrlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Strict: rejects any encoding that is not the canonical base64url of its bytes. */
export function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/u.test(value)) return null;
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  let binary: string;
  try {
    binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  } catch {
    return null;
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return base64UrlEncode(bytes) === value ? bytes : null;
}

async function hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
