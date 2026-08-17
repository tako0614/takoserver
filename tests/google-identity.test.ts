import { describe, expect, test } from "bun:test";
import { createGoogleIdentity, GoogleIdentityError } from "../src/google-identity.ts";
import { base64UrlEncode } from "../src/json.ts";

/**
 * This module decides who somebody is, so every check it makes is worth a test
 * that fails when the check is removed. A verifier that only checks the
 * signature is not a weaker verifier — it is one that accepts tokens issued to
 * other applications, which is no verifier at all.
 */

const CLIENT_ID = "1234567890-takoserver.apps.googleusercontent.com";

async function issuer() {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as { n: string; e: string };

  const jwks = {
    keys: [{ kid: "test-key", kty: "RSA", alg: "RS256", use: "sig", n: jwk.n, e: jwk.e }],
  };
  let fetches = 0;
  const fetchJwks = async (): Promise<Response> => {
    fetches += 1;
    return Response.json(jwks);
  };

  const sign = async (claims: Record<string, unknown>, kid = "test-key"): Promise<string> => {
    const encode = (value: unknown) =>
      base64UrlEncode(new TextEncoder().encode(JSON.stringify(value)));
    const head = encode({ alg: "RS256", kid, typ: "JWT" });
    const body = encode(claims);
    const signature = await crypto.subtle.sign(
      "RSASSA-PKCS1-v1_5",
      pair.privateKey,
      new TextEncoder().encode(`${head}.${body}`) as unknown as BufferSource,
    );
    return `${head}.${body}.${base64UrlEncode(new Uint8Array(signature))}`;
  };

  const verifier = createGoogleIdentity({
    clientId: CLIENT_ID,
    clock: () => new Date(1_800_000_000_000),
    fetch: fetchJwks,
  });

  return { sign, verifier, fetchCount: () => fetches };
}

const seconds = Math.floor(1_800_000_000_000 / 1_000);

const claims = (overrides: Record<string, unknown> = {}) => ({
  iss: "https://accounts.google.com",
  aud: CLIENT_ID,
  sub: "108000000000000000001",
  email: "person@example.com",
  email_verified: true,
  name: "A Person",
  iat: seconds - 30,
  exp: seconds + 3_600,
  ...overrides,
});

describe("Google identity", () => {
  test("accepts a token Google issued to this application", async () => {
    const { sign, verifier } = await issuer();
    const identity = await verifier.verify({ provider: "google", assertion: await sign(claims()) });
    expect(identity).toEqual({
      providerSubject: "108000000000000000001",
      email: "person@example.com",
      displayName: "A Person",
    });
  });

  test("refuses a token issued to another application", async () => {
    const { sign, verifier } = await issuer();
    const assertion = await sign(claims({ aud: "someone-else.apps.googleusercontent.com" }));
    await expect(verifier.verify({ provider: "google", assertion })).rejects.toMatchObject({
      code: "wrong_audience",
    });
  });

  test("refuses a forged signature", async () => {
    const { sign, verifier } = await issuer();
    const token = await sign(claims());
    const [head, body] = token.split(".");
    const tampered = `${head}.${body}.${"A".repeat(342)}`;
    await expect(
      verifier.verify({ provider: "google", assertion: tampered }),
    ).rejects.toBeInstanceOf(GoogleIdentityError);
  });

  test("refuses a body swapped under a valid signature", async () => {
    const { sign, verifier } = await issuer();
    const token = await sign(claims());
    const [head, , signature] = token.split(".");
    const swapped = base64UrlEncode(
      new TextEncoder().encode(JSON.stringify(claims({ sub: "someone-else" }))),
    );
    await expect(
      verifier.verify({ provider: "google", assertion: `${head}.${swapped}.${signature}` }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  test("refuses an expired token and one issued in the future", async () => {
    const { sign, verifier } = await issuer();
    for (const overrides of [{ exp: seconds - 3_600 }, { iat: seconds + 3_600 }]) {
      const assertion = await sign(claims(overrides));
      await expect(verifier.verify({ provider: "google", assertion })).rejects.toMatchObject({
        code: "expired",
      });
    }
  });

  test("refuses another issuer wearing Google's shape", async () => {
    const { sign, verifier } = await issuer();
    const assertion = await sign(claims({ iss: "https://accounts.example.com" }));
    await expect(verifier.verify({ provider: "google", assertion })).rejects.toMatchObject({
      code: "wrong_issuer",
    });
  });

  test("refuses an address Google will not stand behind", async () => {
    const { sign, verifier } = await issuer();
    const assertion = await sign(claims({ email_verified: false }));
    await expect(verifier.verify({ provider: "google", assertion })).rejects.toMatchObject({
      code: "unverified_email",
    });
  });

  test("re-fetches once for an unknown key, and only once", async () => {
    const { sign, verifier, fetchCount } = await issuer();
    // The first verification fetches; a rotation would look like this.
    await verifier.verify({ provider: "google", assertion: await sign(claims()) });
    expect(fetchCount()).toBe(1);
    const strange = await sign(claims(), "a-key-that-does-not-exist");
    await expect(verifier.verify({ provider: "google", assertion: strange })).rejects.toMatchObject(
      {
        code: "unknown_key",
      },
    );
    // One refresh, not a retry loop a caller could drive at Google.
    expect(fetchCount()).toBe(2);
  });
});

/**
 * The advertised list and the verifier are built from one call, so a console
 * cannot be shown a way in that the server will not honour.
 */
describe("identity setup", () => {
  const OPERATOR_JWK = { kty: "OKP", crv: "Ed25519", x: "0".repeat(43) };

  test("advertises nothing when nothing is configured", async () => {
    const { resolveIdentity } = await import("../src/identity-setup.ts");
    const setup = resolveIdentity({});
    expect(setup.providers).toEqual([]);
    await expect(
      setup.verifier.verify({ provider: "google", assertion: "anything" }),
    ).rejects.toBeInstanceOf(Error);
  });

  test("names the operator path as what it is", async () => {
    const { resolveIdentity } = await import("../src/identity-setup.ts");
    const setup = resolveIdentity({ operatorPublicKeyJwk: OPERATOR_JWK });
    expect(setup.providers).toEqual([
      { id: "google", displayName: "Operator assertion", method: "operator-assertion" },
    ]);
  });

  test("offers Google first, and carries the client id a browser needs", async () => {
    const { resolveIdentity } = await import("../src/identity-setup.ts");
    const setup = resolveIdentity({
      googleClientId: CLIENT_ID,
      operatorPublicKeyJwk: OPERATOR_JWK,
    });
    expect(setup.providers.map((entry) => entry.method)).toEqual(["oidc", "operator-assertion"]);
    expect(setup.providers[0]).toMatchObject({ clientId: CLIENT_ID });
  });

  test("routes by the method the caller names rather than guessing", async () => {
    const { resolveIdentity } = await import("../src/identity-setup.ts");
    const setup = resolveIdentity({
      googleClientId: CLIENT_ID,
      operatorPublicKeyJwk: OPERATOR_JWK,
    });
    // An operator assertion is not a Google token; sent as one it must fail as
    // a Google token, so the message is about the thing the caller actually
    // presented.
    await expect(
      setup.verifier.verify({ provider: "google", assertion: "a.b.c", method: "oidc" }),
    ).rejects.toBeInstanceOf(GoogleIdentityError);
    await expect(
      setup.verifier.verify({
        provider: "google",
        assertion: "a.b.c",
        method: "operator-assertion",
      }),
    ).rejects.not.toBeInstanceOf(GoogleIdentityError);
  });
});
