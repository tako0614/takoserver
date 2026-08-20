import { describe, expect, test } from "bun:test";

import { createTakosIdIdentity, TakosIdIdentityError } from "../src/takos-id-identity.ts";

const ISSUER = "https://id.takos.test";
const CLIENT_ID = "takoserver";

const encode = (value: unknown): string =>
  Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

const fixture = async () => {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const sign = async (claims: Record<string, unknown>) => {
    const header = encode({ alg: "ES256", kid: "takos-id-test", typ: "JWT" });
    const payload = encode(claims);
    const unsigned = `${header}.${payload}`;
    const signature = await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      pair.privateKey,
      new TextEncoder().encode(unsigned),
    );
    return `${unsigned}.${Buffer.from(signature).toString("base64url")}`;
  };
  const fetch = async (request: Request) => {
    if (request.url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, jwks_uri: `${ISSUER}/.well-known/jwks.json` });
    }
    if (request.url === `${ISSUER}/.well-known/jwks.json`) {
      return Response.json({ keys: [{ ...jwk, kid: "takos-id-test", alg: "ES256", use: "sig" }] });
    }
    return new Response(null, { status: 404 });
  };
  return { sign, fetch };
};

describe("Takos ID identity verifier", () => {
  test("accepts only an exact Takos ID pairwise ID token for this product", async () => {
    const { sign, fetch } = await fixture();
    const now = new Date("2026-08-20T10:00:00.000Z");
    const verifier = createTakosIdIdentity({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetch,
      clock: () => now,
    });
    const assertion = await sign({
      iss: ISSUER,
      aud: CLIENT_ID,
      sub: "pairwise-takoserver-subject",
      iat: Math.floor(now.getTime() / 1_000),
      exp: Math.floor(now.getTime() / 1_000) + 300,
      email: "owner@example.test",
      email_verified: true,
      name: "Owner",
      organizations: [{ id: "org_legal", name: "Example Ltd.", role: "owner" }],
    });

    expect(await verifier.verify({ provider: "takos-id", assertion, method: "oidc" })).toEqual({
      providerSubject: "pairwise-takoserver-subject",
      email: "owner@example.test",
      displayName: "Owner",
      organizations: [{ id: "org_legal", name: "Example Ltd.", role: "owner" }],
    });
  });

  test("rejects a valid token minted for Takosumi", async () => {
    const { sign, fetch } = await fixture();
    const now = new Date("2026-08-20T10:00:00.000Z");
    const verifier = createTakosIdIdentity({
      issuer: ISSUER,
      clientId: CLIENT_ID,
      fetch,
      clock: () => now,
    });
    const assertion = await sign({
      iss: ISSUER,
      aud: "takosumi",
      sub: "pairwise-takosumi-subject",
      iat: Math.floor(now.getTime() / 1_000),
      exp: Math.floor(now.getTime() / 1_000) + 300,
      email: "owner@example.test",
      email_verified: true,
    });

    await expect(
      verifier.verify({ provider: "takos-id", assertion, method: "oidc" }),
    ).rejects.toEqual(new TakosIdIdentityError("wrong_audience"));
  });
});
