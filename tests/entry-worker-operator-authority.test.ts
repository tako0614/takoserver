import { describe, expect, test } from "bun:test";
import { operatorCredentialKeys, workerCredentials } from "../src/entry-worker.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";

const LEGACY = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "legacy" });
const IDENTITY = JSON.stringify({ kty: "OKP", crv: "Ed25519", x: "identity" });
const ORIGIN = "https://api.example.test";

describe("Worker operator authority", () => {
  test("keeps the legacy key compatible with login and funding", () => {
    expect(operatorCredentialKeys({ OPERATOR_PUBLIC_JWK: LEGACY })).toEqual({
      identity: { kty: "OKP", crv: "Ed25519", x: "legacy" },
      settlement: { kty: "OKP", crv: "Ed25519", x: "legacy" },
    });
  });

  test("an identity-only key cannot authorize wallet funding", () => {
    expect(operatorCredentialKeys({ OPERATOR_IDENTITY_PUBLIC_JWK: IDENTITY })).toEqual({
      identity: { kty: "OKP", crv: "Ed25519", x: "identity" },
    });
  });

  test("a dedicated identity key does not inherit legacy settlement authority", () => {
    expect(
      operatorCredentialKeys({
        OPERATOR_PUBLIC_JWK: LEGACY,
        OPERATOR_IDENTITY_PUBLIC_JWK: IDENTITY,
      }),
    ).toEqual({
      identity: { kty: "OKP", crv: "Ed25519", x: "identity" },
      settlement: { kty: "OKP", crv: "Ed25519", x: "legacy" },
    });
  });

  test("the composed Worker refuses funding signed by an identity-only key", async () => {
    const key = await keyPair();
    const settlement = workerCredentials(
      {
        OPERATOR_IDENTITY_PUBLIC_JWK: JSON.stringify(key.publicJwk),
      },
      ORIGIN,
    ).settlement;
    const proof = await fundingProof(key.privateJwk);

    await expect(
      settlement.verify({ organizationId: "org_fixture", settlementProof: proof }),
    ).rejects.toThrow("settlement credentials are not configured");
  });

  test("the composed Worker retains legacy signed funding compatibility", async () => {
    const key = await keyPair();
    const settlement = workerCredentials(
      {
        OPERATOR_PUBLIC_JWK: JSON.stringify(key.publicJwk),
      },
      ORIGIN,
    ).settlement;
    const proof = await fundingProof(key.privateJwk);

    await expect(
      settlement.verify({ organizationId: "org_fixture", settlementProof: proof }),
    ).resolves.toEqual({
      fundingRef: "fixture-funding",
      amountMinor: 100,
      currency: "USD",
    });
  });
});

async function keyPair(): Promise<{
  readonly publicJwk: JsonWebKey;
  readonly privateJwk: JsonWebKey;
}> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  return {
    publicJwk: await crypto.subtle.exportKey("jwk", pair.publicKey),
    privateJwk: await crypto.subtle.exportKey("jwk", pair.privateKey),
  };
}

async function fundingProof(privateJwk: JsonWebKey): Promise<string> {
  return await signOperatorAssertion({
    privateJwk: JSON.stringify(privateJwk),
    claims: {
      purpose: "funding",
      organizationId: "org_fixture",
      fundingRef: "fixture-funding",
      amountMinor: 100,
      currency: "USD",
    },
    nowSeconds: Math.floor(Date.now() / 1_000),
    lifetimeSeconds: 60,
  });
}
