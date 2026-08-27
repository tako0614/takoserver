import { describe, expect, test } from "bun:test";
import { shouldProbeLiveSigning } from "../scripts/deploy/preflight.ts";
import { verifyJwtSignature } from "../scripts/deploy/signing-authority.ts";

describe("deploy signing authority", () => {
  test("defers only the first sponsorship proof until the new Version is live", () => {
    expect(shouldProbeLiveSigning(true, "version-old", false)).toBeFalse();
    expect(shouldProbeLiveSigning(true, "version-current", true)).toBeTrue();
    expect(shouldProbeLiveSigning(false, "version-current", false)).toBeTrue();
  });

  test("accepts only a JWT made by the exact active key id and public key", async () => {
    const expected = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const stale = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", expected.publicKey);
    const header = encode({ alg: "EdDSA", kid: "key-current", typ: "takoserver-token+jwt" });
    const payload = encode({ aud: "takoform.run", exp: 2, iat: 1, iss: "https://example.test" });
    const input = `${header}.${payload}`;
    const currentToken = `${input}.${encodeBytes(
      await crypto.subtle.sign("Ed25519", expected.privateKey, new TextEncoder().encode(input)),
    )}`;
    const staleToken = `${input}.${encodeBytes(
      await crypto.subtle.sign("Ed25519", stale.privateKey, new TextEncoder().encode(input)),
    )}`;

    expect(await verifyJwtSignature(currentToken, "key-current", publicJwk)).toBe(true);
    expect(await verifyJwtSignature(staleToken, "key-current", publicJwk)).toBe(false);
    expect(await verifyJwtSignature(currentToken, "key-other", publicJwk)).toBe(false);
  });
});

function encode(value: unknown): string {
  return encodeBytes(new TextEncoder().encode(JSON.stringify(value)));
}

function encodeBytes(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
}
