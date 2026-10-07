import { base64UrlDecode, base64UrlEncode, canonicalJson } from "../json.ts";
import { parseWorkerVersionSpec, WORKER_VERSION_FORM_URL } from "./forms/worker-specs.ts";

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const ENCODER = new TextEncoder();

function ownedBytes(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const owned = new Uint8Array(new ArrayBuffer(bytes.byteLength));
  owned.set(bytes);
  return owned;
}

export interface V2WorkerVersionPrivateIdentity {
  readonly principal: string;
  readonly space: string;
  readonly name: string;
  readonly form: string;
  readonly resourceUid: string;
  readonly spec: unknown;
}

export interface V2WorkerVersionConfiguredKeyring {
  readonly current: Readonly<{ keyId: string; key: CryptoKey }>;
  keyForDecryption(keyId: string): CryptoKey | undefined;
}

export type V2WorkerVersionSealedInputs = Readonly<{
  keyId: string;
  nonce: string;
  ciphertext: string;
}>;

function keyIsUsable(key: CryptoKey | undefined): key is CryptoKey {
  if (!key) return false;
  const algorithm = key.algorithm as { readonly name: string; readonly length?: number };
  return (
    algorithm.name === "AES-GCM" &&
    algorithm.length === 256 &&
    !key.extractable &&
    key.usages.includes("encrypt") &&
    key.usages.includes("decrypt")
  );
}

function identityParts(input: V2WorkerVersionPrivateIdentity): {
  readonly names: readonly string[];
  readonly aad: Uint8Array<ArrayBuffer>;
} {
  if (
    input.form !== WORKER_VERSION_FORM_URL ||
    !input.principal ||
    !input.space ||
    !input.name ||
    !input.resourceUid
  ) {
    throw new TypeError("invalid WorkerVersion configured input identity");
  }
  const spec = parseWorkerVersionSpec(input.spec);
  return {
    names: [...spec.requiredSensitiveVars],
    aad: ownedBytes(
      ENCODER.encode(
        canonicalJson([
          "takoserver.v2-worker-version-configured-inputs@v1",
          input.principal,
          input.space,
          input.form,
          input.resourceUid,
          input.name,
          canonicalJson(spec),
        ]),
      ),
    ),
  };
}

function exactValues(
  values: Readonly<Record<string, string>> | undefined,
  names: readonly string[],
): values is Readonly<Record<string, string>> {
  if (!values) return names.length === 0;
  const supplied = Object.keys(values).sort();
  const required = [...names].sort();
  return (
    supplied.length === required.length &&
    supplied.every(
      (name, index) =>
        name === required[index] && typeof values[name] === "string" && values[name].length > 0,
    )
  );
}

function sameValue(left: string, right: string): boolean {
  // TextEncoder replaces lone surrogates, so compare exact JS string identity.
  let difference = left.length ^ right.length;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    difference |=
      (index < left.length ? left.charCodeAt(index) : 0) ^
      (index < right.length ? right.charCodeAt(index) : 0);
  }
  return difference === 0;
}

/** Operator-key custody; callers persist only authenticated ciphertext. */
export function createV2WorkerVersionConfiguredInputSealer(
  keyring: V2WorkerVersionConfiguredKeyring,
) {
  if (
    !keyring ||
    !KEY_ID.test(keyring.current?.keyId ?? "") ||
    !keyIsUsable(keyring.current.key) ||
    keyring.keyForDecryption(keyring.current.keyId) !== keyring.current.key
  ) {
    throw new TypeError("v2 WorkerVersion requires an explicit nonextractable AES-256-GCM keyring");
  }
  const current = Object.freeze({ ...keyring.current });
  const keyForDecryption = keyring.keyForDecryption.bind(keyring);
  return {
    async seal(
      identity: V2WorkerVersionPrivateIdentity,
      values: Readonly<Record<string, string>> | undefined,
    ): Promise<V2WorkerVersionSealedInputs | null> {
      const { names, aad } = identityParts(identity);
      if (!exactValues(values, names)) {
        aad.fill(0);
        throw new TypeError("WorkerVersion private inputs must be a complete nonempty map");
      }
      if (names.length === 0) {
        aad.fill(0);
        return null;
      }
      const ordered = Object.fromEntries(names.map((name) => [name, values?.[name]]));
      const plaintext = ownedBytes(ENCODER.encode(JSON.stringify(ordered)));
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      try {
        const ciphertext = await crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: aad },
          current.key,
          plaintext,
        );
        return Object.freeze({
          keyId: current.keyId,
          nonce: base64UrlEncode(nonce),
          ciphertext: base64UrlEncode(new Uint8Array(ciphertext)),
        });
      } finally {
        plaintext.fill(0);
        aad.fill(0);
      }
    },
    async open(
      identity: V2WorkerVersionPrivateIdentity,
      sealed: V2WorkerVersionSealedInputs,
    ): Promise<Readonly<Record<string, string>> | null> {
      let aad: Uint8Array<ArrayBuffer> | undefined;
      let plaintext: Uint8Array | undefined;
      try {
        const parts = identityParts(identity);
        aad = parts.aad;
        if (!sealed || !KEY_ID.test(sealed.keyId)) return null;
        const key = keyForDecryption(sealed.keyId);
        if (!key || !keyIsUsable(key)) return null;
        const decodedNonce = base64UrlDecode(sealed.nonce);
        const decodedCiphertext = base64UrlDecode(sealed.ciphertext);
        const nonce = decodedNonce ? ownedBytes(decodedNonce) : null;
        const ciphertext = decodedCiphertext ? ownedBytes(decodedCiphertext) : null;
        if (nonce?.length !== 12 || !ciphertext || ciphertext.length < 17) return null;
        plaintext = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: "AES-GCM", iv: nonce, additionalData: aad },
            key,
            ciphertext,
          ),
        );
        const parsed: unknown = JSON.parse(
          new TextDecoder("utf-8", { fatal: true }).decode(plaintext),
        );
        if (
          !parsed ||
          typeof parsed !== "object" ||
          Array.isArray(parsed) ||
          !exactValues(parsed as Record<string, string>, parts.names)
        ) {
          return null;
        }
        return Object.freeze({ ...(parsed as Record<string, string>) });
      } catch {
        return null;
      } finally {
        aad?.fill(0);
        plaintext?.fill(0);
      }
    },
    async compare(
      identity: V2WorkerVersionPrivateIdentity,
      sealed: V2WorkerVersionSealedInputs,
      proposed: Readonly<Record<string, string>> | undefined,
    ): Promise<"matched" | "mismatched" | "unavailable"> {
      const currentInputs = await this.open(identity, sealed);
      if (!currentInputs) return "unavailable";
      const { names, aad } = identityParts(identity);
      aad.fill(0);
      if (!exactValues(proposed, names)) return "mismatched";
      let matched = true;
      for (const name of names) {
        matched = sameValue(currentInputs[name] ?? "", proposed?.[name] ?? "") && matched;
      }
      return matched ? "matched" : "mismatched";
    },
  };
}
