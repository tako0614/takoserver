import { canonicalJson } from "../json.ts";

export type V2PrivateInputMap = Readonly<Record<string, string>>;

export interface V2PrivateInputKey {
  readonly id: string;
  /** Imported by the operator, non-extractable, with only the required WebCrypto usages. */
  readonly key: CryptoKey;
}

export interface V2PrivateInputCustody {
  readonly transfer: {
    readonly current: V2PrivateInputKey;
    readonly previous?: readonly V2PrivateInputKey[];
  };
  readonly comparison: {
    readonly current: V2PrivateInputKey;
    readonly previous?: readonly V2PrivateInputKey[];
  };
  /** Temporary transfer lifetime; comparison material is retained independently. */
  readonly transferTtlSeconds: number;
}

export interface V2SealedPrivateInputs {
  readonly namesJson: string;
  readonly comparisonKeyId: string;
  readonly comparisonTag: string;
  readonly transferKeyId: string;
  readonly transferNonce: string;
  readonly transferCiphertext: string;
  readonly transferExpiresAtMs: number;
}

export interface V2PrivateInputBinding {
  readonly operationId: string;
  readonly principal: string;
  readonly resourceUid: string;
  readonly generation: number;
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const encoder = new TextEncoder();

export function validatePrivateInputCustody(custody: V2PrivateInputCustody): void {
  if (!Number.isSafeInteger(custody.transferTtlSeconds) || custody.transferTtlSeconds < 1) {
    throw new TypeError("invalid v2 private input transfer lifetime");
  }
  validateRing(custody.transfer, "AES-GCM", "encrypt", "decrypt");
  validateRing(custody.comparison, "HMAC", "sign", "verify");
}

function validateRing(
  ring: { readonly current: V2PrivateInputKey; readonly previous?: readonly V2PrivateInputKey[] },
  algorithm: string,
  firstUsage: "encrypt" | "sign",
  secondUsage: "decrypt" | "verify",
): void {
  const keys = [ring.current, ...(ring.previous ?? [])];
  if (keys.length === 0 || keys.some((entry) => !entry || !ID.test(entry.id))) {
    throw new TypeError("invalid v2 private input key ring");
  }
  if (new Set(keys.map((entry) => entry.id)).size !== keys.length) {
    throw new TypeError("duplicate v2 private input key id");
  }
  for (const { key } of keys) {
    if (!(key instanceof CryptoKey)) throw new TypeError("invalid v2 private input key");
    const keyAlgorithm = key.algorithm as {
      readonly name: string;
      readonly hash?: { readonly name: string };
      readonly length?: number;
    };
    if (
      key.type !== "secret" ||
      key.extractable ||
      keyAlgorithm.name !== algorithm ||
      !key.usages.includes(firstUsage) ||
      !key.usages.includes(secondUsage) ||
      (algorithm === "HMAC" && keyAlgorithm.hash?.name !== "SHA-256") ||
      (algorithm === "HMAC" && (keyAlgorithm.length ?? 0) < 256) ||
      (algorithm === "AES-GCM" && keyAlgorithm.length !== 256)
    ) {
      throw new TypeError("invalid v2 private input key");
    }
  }
}

export function parsePrivateInputMap(value: unknown): V2PrivateInputMap {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("invalid private input map");
  }
  const record = value as Record<string, unknown>;
  for (const [name, secret] of Object.entries(record)) {
    if (typeof name !== "string" || typeof secret !== "string") {
      throw new TypeError("invalid private input map");
    }
  }
  return record as V2PrivateInputMap;
}

export async function sealPrivateInputs(
  custody: V2PrivateInputCustody,
  binding: V2PrivateInputBinding,
  inputs: V2PrivateInputMap,
  nowMs: number,
): Promise<V2SealedPrivateInputs> {
  const value = canonicalJson(inputs);
  const aad = bindingBytes(binding);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const [tag, ciphertext] = await Promise.all([
    crypto.subtle.sign("HMAC", custody.comparison.current.key, comparisonBytes(aad, value)),
    crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: aad },
      custody.transfer.current.key,
      encoder.encode(value),
    ),
  ]);
  const encodedTag = encode(tag);
  // Authenticate the retained comparison bytes themselves. A removed or
  // misconfigured historical key must be distinguishable from a changed input.
  const materialAuthenticator = await crypto.subtle.sign(
    "HMAC",
    custody.comparison.current.key,
    comparisonMaterialBytes(encodedTag),
  );
  return {
    namesJson: canonicalJson(Object.keys(inputs).sort()),
    comparisonKeyId: custody.comparison.current.id,
    comparisonTag: `${encodedTag}.${encode(materialAuthenticator)}`,
    transferKeyId: custody.transfer.current.id,
    transferNonce: encode(nonce),
    transferCiphertext: encode(ciphertext),
    transferExpiresAtMs: nowMs + custody.transferTtlSeconds * 1000,
  };
}

export async function matchesPrivateInputs(
  custody: V2PrivateInputCustody,
  binding: V2PrivateInputBinding,
  comparisonKeyId: string,
  comparisonTag: string,
  inputs: V2PrivateInputMap,
): Promise<boolean | null> {
  const key = lookup(custody.comparison, comparisonKeyId);
  if (!key) return null;
  const tag = await verifiedComparisonTag(key, comparisonTag);
  if (!tag) return null;
  try {
    return await crypto.subtle.verify(
      "HMAC",
      key,
      tag,
      comparisonBytes(bindingBytes(binding), canonicalJson(inputs)),
    );
  } catch {
    return null;
  }
}

export async function hasPrivateComparisonMaterial(
  custody: V2PrivateInputCustody,
  id: string,
  tag: string,
): Promise<boolean> {
  const key = lookup(custody.comparison, id);
  return key !== null && (await verifiedComparisonTag(key, tag)) !== null;
}

async function verifiedComparisonTag(
  key: CryptoKey,
  material: string,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const parts = material.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  try {
    const verified = await crypto.subtle.verify(
      "HMAC",
      key,
      decode(parts[1]),
      comparisonMaterialBytes(parts[0]),
    );
    return verified ? decode(parts[0]) : null;
  } catch {
    return null;
  }
}

export async function unsealPrivateInputs(
  custody: V2PrivateInputCustody,
  binding: V2PrivateInputBinding,
  keyId: string,
  nonce: string,
  ciphertext: string,
): Promise<V2PrivateInputMap | null> {
  const key = lookup(custody.transfer, keyId);
  if (!key) return null;
  try {
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: decode(nonce), additionalData: bindingBytes(binding) },
      key,
      decode(ciphertext),
    );
    return parsePrivateInputMap(
      JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(plain)),
    );
  } catch {
    return null;
  }
}

function lookup(
  ring: { readonly current: V2PrivateInputKey; readonly previous?: readonly V2PrivateInputKey[] },
  id: string,
): CryptoKey | null {
  return [ring.current, ...(ring.previous ?? [])].find((entry) => entry.id === id)?.key ?? null;
}

function bindingBytes(binding: V2PrivateInputBinding): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    encoder.encode(canonicalJson(["forms.takoform.com/v2/private-inputs", binding])),
  );
}

function comparisonBytes(aad: Uint8Array, value: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(encoder.encode(canonicalJson([new TextDecoder().decode(aad), value])));
}

function comparisonMaterialBytes(tag: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(
    encoder.encode(canonicalJson(["forms.takoform.com/v2/comparison-material@v1", tag])),
  );
}

function encode(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decode(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
