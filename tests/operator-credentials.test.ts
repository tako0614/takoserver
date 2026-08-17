import { beforeEach, describe, expect, test } from "bun:test";
import { base64UrlEncode } from "../src/json.ts";
import {
  createOperatorIdentity,
  createOperatorSettlement,
  OperatorAssertionError,
} from "../src/operator-credentials.ts";

let signingKey: CryptoKey;
let publicKeyJwk: { kty: string; crv: string; x: string };
let now: number;
const clock = () => new Date(now);

beforeEach(async () => {
  now = Date.UTC(2026, 7, 17, 12, 0, 0);
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  signingKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  publicKeyJwk = { kty: "OKP", crv: "Ed25519", x: String(jwk.x) };
});

async function assert(claims: Record<string, unknown>, key = signingKey): Promise<string> {
  const issuedAt = Math.floor(now / 1_000);
  const payload = base64UrlEncode(
    new TextEncoder().encode(JSON.stringify({ iat: issuedAt, exp: issuedAt + 300, ...claims })),
  );
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

const SIGN_IN = {
  purpose: "sign-in",
  provider: "google",
  subject: "operator-1",
  email: "owner@example.com",
  displayName: "Owner",
};

const FUNDING = {
  purpose: "funding",
  organizationId: "org_a",
  fundingRef: "credit-1",
  amountMinor: 10_000,
  currency: "USD",
};

describe("operator sign-in", () => {
  test("accepts exactly what the operator signed", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, clock });
    const verified = await identity.verify({
      provider: "google",
      assertion: await assert(SIGN_IN),
    });
    expect(verified).toEqual({
      providerSubject: "operator-1",
      email: "owner@example.com",
      displayName: "Owner",
    });
  });

  test("refuses a signature from any other key", async () => {
    const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const identity = createOperatorIdentity({ publicKeyJwk, clock });
    await expect(
      identity.verify({ provider: "google", assertion: await assert(SIGN_IN, other.privateKey) }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  test("refuses a tampered claim even with a valid-looking shape", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, clock });
    const original = await assert(SIGN_IN);
    const [payload, signature] = original.split(".");
    const forged = JSON.parse(
      new TextDecoder().decode(Buffer.from(payload ?? "", "base64url")),
    ) as Record<string, unknown>;
    forged.email = "intruder@example.com";
    const swapped = `${base64UrlEncode(new TextEncoder().encode(JSON.stringify(forged)))}.${signature}`;
    await expect(identity.verify({ provider: "google", assertion: swapped })).rejects.toMatchObject(
      { code: "invalid_signature" },
    );
  });

  test("will not let a funding assertion sign anybody in", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, clock });
    await expect(
      identity.verify({ provider: "google", assertion: await assert(FUNDING) }),
    ).rejects.toMatchObject({ code: "wrong_purpose" });
  });

  test("refuses an assertion for a different provider", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, clock });
    await expect(
      identity.verify({ provider: "github", assertion: await assert(SIGN_IN) }),
    ).rejects.toMatchObject({ code: "wrong_purpose" });
  });

  test("stops accepting an assertion once it expires", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, clock });
    const assertion = await assert(SIGN_IN);
    now += 301_000;
    await expect(identity.verify({ provider: "google", assertion })).rejects.toMatchObject({
      code: "expired",
    });
  });
});

describe("operator funding", () => {
  test("credits the amount the operator vouched for", async () => {
    const settlement = createOperatorSettlement({ publicKeyJwk, clock });
    expect(
      await settlement.verify({ organizationId: "org_a", settlementProof: await assert(FUNDING) }),
    ).toEqual({ fundingRef: "credit-1", amountMinor: 10_000, currency: "USD" });
  });

  test("cannot be redirected at another organization's wallet", async () => {
    const settlement = createOperatorSettlement({ publicKeyJwk, clock });
    await expect(
      settlement.verify({ organizationId: "org_b", settlementProof: await assert(FUNDING) }),
    ).rejects.toMatchObject({ code: "wrong_purpose" });
  });

  test("refuses a nonsense amount", async () => {
    const settlement = createOperatorSettlement({ publicKeyJwk, clock });
    for (const amountMinor of [0, -1, 1.5]) {
      await expect(
        settlement.verify({
          organizationId: "org_a",
          settlementProof: await assert({ ...FUNDING, amountMinor }),
        }),
      ).rejects.toBeInstanceOf(OperatorAssertionError);
    }
  });

  test("refuses anything that is not a well-formed assertion", async () => {
    const settlement = createOperatorSettlement({ publicKeyJwk, clock });
    for (const settlementProof of ["", "not-an-assertion", "a.b.c", "!!!.???"]) {
      await expect(
        settlement.verify({ organizationId: "org_a", settlementProof }),
      ).rejects.toBeInstanceOf(OperatorAssertionError);
    }
  });
});
