import { beforeEach, describe, expect, test } from "bun:test";
import { GOOGLE_IDENTITY_ISSUERS } from "../src/google-identity.ts";
import {
  assertIdentityVerificationCaptureReader,
  type IdentitySetup,
  resolveIdentity,
} from "../src/identity-setup.ts";
import { base64UrlEncode } from "../src/json.ts";

const NOW = Date.UTC(2026, 9, 15, 12);
const AUDIENCE = "https://api.identity-origin.test";
let signingKey: CryptoKey;
let setup: IdentitySetup;

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString("base64url");

beforeEach(async () => {
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  signingKey = pair.privateKey;
  const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  setup = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(jwk.x) },
    operatorAudience: AUDIENCE,
    clock: () => new Date(NOW),
  });
});

async function signed(key = signingKey, changes: Record<string, unknown> = {}) {
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        purpose: "sign-in",
        aud: AUDIENCE,
        provider: "google",
        subject: "subject-1",
        email: "person@example.test",
        displayName: "Person",
        iat: NOW / 1000,
        exp: NOW / 1000 + 300,
        ...changes,
      }),
    ),
  );
  const signature = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(payload));
  return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function input() {
  return { provider: "google" as const, assertion: await signed(), audience: AUDIENCE };
}

describe("actual selected identity verification observations", () => {
  test("captures successful real signature verification without replacing ordinary verify", async () => {
    const claimedDomain = { body: ["caller-domain"], digest: "sha256:00" };
    const original = { ...(await input()), verificationDomain: claimedDomain };
    const ordinary = await setup.verifier.verify(original);
    const result = await setup.verifier.captureVerifiedIdentity(original);
    expect(result.verified).toEqual(ordinary);
    expect(ordinary.singleUse?.namespace).toBe("operator-sign-in");
    const observation = setup.verifier.inspectVerifiedIdentityCapture(result.capture);
    expect(observation).toMatchObject({
      provider: "google",
      method: "operator-assertion",
      providerSubject: "subject-1",
      email: "person@example.test",
      displayName: "Person",
      verifiedAt: new Date(NOW).toISOString(),
      verificationAuthority: { kind: "operator-assertion", audience: AUDIENCE },
    });
    expect(observation?.verificationAuthority).toMatchObject({
      publicKeyJwk: { kty: "OKP", crv: "Ed25519" },
    });
    expect(Object.isFrozen(observation?.verificationAuthority)).toBe(true);
    if (observation?.verificationAuthority.kind === "operator-assertion") {
      expect(Object.isFrozen(observation.verificationAuthority.publicKeyJwk)).toBe(true);
      expect(observation.verificationDomain.body).toEqual([
        "takoserver.identity-verification-domain.v1",
        "google",
        "operator-assertion",
        AUDIENCE,
        "OKP",
        "Ed25519",
        observation.verificationAuthority.publicKeyJwk.x,
      ]);
    }
    expect(observation?.assertionDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(observation?.verificationDomain.digest).toMatch(/^sha256:[a-f0-9]{64}$/u);
    const domainBytes = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(observation?.verificationDomain.body)),
    );
    expect(observation?.verificationDomain.digest).toBe(
      `sha256:${Buffer.from(domainBytes).toString("hex")}`,
    );
    expect(observation?.verificationDomain).not.toEqual(claimedDomain);
    expect(Object.isFrozen(observation?.verificationDomain)).toBe(true);
    expect(Object.isFrozen(observation?.verificationDomain.body)).toBe(true);
    expect(JSON.stringify(observation?.verificationDomain.body)).not.toContain(original.assertion);
    expect(JSON.stringify(observation?.verificationDomain.body)).not.toContain("subject-1");
    expect(Object.isFrozen(observation)).toBe(true);
    expect(JSON.stringify(result.capture)).toBe("{}");
    expect(JSON.stringify(observation)).not.toContain(original.assertion);
    expect(Object.keys(observation ?? {})).not.toContain("singleUse");
    expect(() => assertIdentityVerificationCaptureReader(setup.verifier)).not.toThrow();
  });

  test("refuses a genuine observation from another actual verifier and all copies", async () => {
    const result = await setup.verifier.captureVerifiedIdentity(await input());
    const observation = setup.verifier.inspectVerifiedIdentityCapture(result.capture);
    const key = await crypto.subtle.exportKey("jwk", signingKey);
    const other = resolveIdentity({
      operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(key.x) },
      operatorAudience: AUDIENCE,
      clock: () => new Date(NOW),
    });
    const otherCapture = await other.verifier.captureVerifiedIdentity(await input());
    expect(
      other.verifier.inspectVerifiedIdentityCapture(otherCapture.capture)?.verificationDomain,
    ).toEqual(observation?.verificationDomain);
    expect(other.verifier.inspectVerifiedIdentityCapture(result.capture)).toBeNull();
    expect(setup.verifier.inspectVerifiedIdentityCapture(otherCapture.capture)).toBeNull();
    expect(setup.verifier.inspectVerifiedIdentityCapture({ ...result.capture })).toBeNull();
    expect(
      setup.verifier.inspectVerifiedIdentityCapture({
        ...result.capture,
        verificationDomain: observation?.verificationDomain,
      }),
    ).toBeNull();
    expect(setup.verifier.inspectVerifiedIdentityCapture(result.verified)).toBeNull();
    expect(
      setup.verifier.inspectVerifiedIdentityCapture(structuredClone(result.capture)),
    ).toBeNull();
    expect(() => assertIdentityVerificationCaptureReader({ ...setup.verifier })).toThrow();
    expect(() => assertIdentityVerificationCaptureReader(new Proxy(setup.verifier, {}))).toThrow();
  });

  test("does not accept a fake reader or execute its getters/self-assertion", () => {
    let reads = 0;
    const fake = {
      get verify() {
        reads++;
        return () => true;
      },
      get captureVerifiedIdentity() {
        reads++;
        return () => true;
      },
      assert() {
        reads++;
        return true;
      },
    };
    expect(() => assertIdentityVerificationCaptureReader(fake)).toThrow();
    expect(reads).toBe(0);
  });

  test("replacement accessors are refused without evaluating them", async () => {
    const result = await setup.verifier.captureVerifiedIdentity(await input());
    let reads = 0;
    const original = setup.verifier.verify;
    Object.defineProperty(setup.verifier, "verify", {
      configurable: true,
      get() {
        reads++;
        return original;
      },
    });
    expect(() => assertIdentityVerificationCaptureReader(setup.verifier)).toThrow();
    expect(() => setup.verifier.inspectVerifiedIdentityCapture(result.capture)).toThrow();
    expect(reads).toBe(0);
  });

  test("invalid signatures cannot mint an observation", async () => {
    const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    await expect(
      setup.verifier.captureVerifiedIdentity({
        provider: "google",
        assertion: await signed(other.privateKey),
        audience: AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
    expect(setup.verifier.inspectVerifiedIdentityCapture({})).toBeNull();
  });

  test("a caller getter cannot temporarily replace verification and mint forged metadata", async () => {
    const assertion = await signed();
    const original = setup.verifier.verify;
    let fakeCalls = 0;
    const originalInput = {
      provider: "google" as const,
      audience: AUDIENCE,
      get assertion() {
        setup.verifier.verify = async () => {
          fakeCalls++;
          setup.verifier.verify = original;
          return { providerSubject: "forged", email: "forged@example.test", displayName: "Forged" };
        };
        return assertion;
      },
    };
    await expect(setup.verifier.captureVerifiedIdentity(originalInput)).rejects.toMatchObject({
      code: "invalid",
    });
    expect(fakeCalls).toBe(0);
  });

  test("changed reader methods after awaited verification refuse capture", async () => {
    const original = setup.verifier.captureVerifiedIdentity;
    const pending = original.call(setup.verifier, await input());
    setup.verifier.captureVerifiedIdentity = async () => {
      throw new Error("replacement must not be called");
    };
    await expect(pending).rejects.toMatchObject({ code: "invalid" });
  });

  test("captures the selected Takos ID issuer and client after real discovery and signature checks", async () => {
    const issuer = "https://id.identity-origin.test";
    const otherIssuer = "https://other-id.identity-origin.test";
    const clientId = "takoserver-client";
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
      "sign",
      "verify",
    ]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new Request(input).url;
        for (const selectedIssuer of [issuer, otherIssuer]) {
          if (url === `${selectedIssuer}/.well-known/openid-configuration`) {
            return Response.json({
              issuer: selectedIssuer,
              jwks_uri: `${selectedIssuer}/.well-known/jwks.json`,
            });
          }
          if (url === `${selectedIssuer}/.well-known/jwks.json`) {
            return Response.json({
              keys: [{ ...jwk, kid: "selected-key", alg: "ES256", use: "sig" }],
            });
          }
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const sign = async (aud: string, signedIssuer = issuer) => {
      const unsigned = `${encode({ alg: "ES256", kid: "selected-key" })}.${encode({
        iss: signedIssuer,
        aud,
        sub: "pairwise-subject",
        email: "owner@example.test",
        email_verified: true,
        iat: NOW / 1000,
        exp: NOW / 1000 + 300,
      })}`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        pair.privateKey,
        new TextEncoder().encode(unsigned),
      );
      return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
    };
    try {
      const selected = resolveIdentity({
        takosId: { issuer, clientId },
        clock: () => new Date(NOW),
      });
      const capture = await selected.verifier.captureVerifiedIdentity({
        provider: "takos-id",
        method: "oidc",
        assertion: await sign(clientId),
      });
      expect(capture.verified.providerSubject).toBe("pairwise-subject");
      expect(selected.verifier.inspectVerifiedIdentityCapture(capture.capture)).toMatchObject({
        provider: "takos-id",
        method: "oidc",
        providerSubject: "pairwise-subject",
        verificationAuthority: { kind: "takos-id-oidc", issuer, clientId },
      });
      const firstDomain = selected.verifier.inspectVerifiedIdentityCapture(
        capture.capture,
      )?.verificationDomain;
      expect(firstDomain?.body).toEqual([
        "takoserver.identity-verification-domain.v1",
        "takos-id",
        "oidc",
        issuer,
        clientId,
      ]);
      const differentIssuer = resolveIdentity({
        takosId: { issuer: otherIssuer, clientId },
        clock: () => new Date(NOW),
      });
      const issuerCapture = await differentIssuer.verifier.captureVerifiedIdentity({
        provider: "takos-id",
        method: "oidc",
        assertion: await sign(clientId, otherIssuer),
      });
      expect(issuerCapture.verified.providerSubject).toBe(capture.verified.providerSubject);
      expect(
        differentIssuer.verifier.inspectVerifiedIdentityCapture(issuerCapture.capture)
          ?.verificationDomain.digest,
      ).not.toBe(firstDomain?.digest);
      const differentClient = resolveIdentity({
        takosId: { issuer, clientId: "another-client" },
        clock: () => new Date(NOW),
      });
      const clientCapture = await differentClient.verifier.captureVerifiedIdentity({
        provider: "takos-id",
        method: "oidc",
        assertion: await sign("another-client"),
      });
      expect(clientCapture.verified.providerSubject).toBe(capture.verified.providerSubject);
      expect(
        differentClient.verifier.inspectVerifiedIdentityCapture(clientCapture.capture)
          ?.verificationDomain.digest,
      ).not.toBe(firstDomain?.digest);
      await expect(
        selected.verifier.captureVerifiedIdentity({
          provider: "takos-id",
          method: "oidc",
          assertion: await sign("another-client"),
          verificationAuthority: { kind: "takos-id-oidc", issuer, clientId },
        } as Parameters<typeof selected.verifier.captureVerifiedIdentity>[0]),
      ).rejects.toMatchObject({
        code: "wrong_audience",
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("records Google's fixed issuer policy and selected client after real RSA verification", async () => {
    const clientId = "selected-google-client";
    let now = NOW;
    const pair = await crypto.subtle.generateKey(
      {
        name: "RSASSA-PKCS1-v1_5",
        modulusLength: 2048,
        publicExponent: new Uint8Array([1, 0, 1]),
        hash: "SHA-256",
      },
      true,
      ["sign", "verify"],
    );
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const originalFetch = globalThis.fetch;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new Request(input).url;
        if (url === "https://www.googleapis.com/oauth2/v3/certs") {
          return Response.json({ keys: [{ kty: "RSA", kid: "google-key", n: jwk.n, e: jwk.e }] });
        }
        throw new Error(`unexpected fetch ${url}`);
      },
      { preconnect: originalFetch.preconnect },
    );
    const sign = async (
      aud: string,
      email = "owner@example.test",
      issuer = "accounts.google.com",
      nonce?: string,
    ) => {
      const unsigned = `${encode({ alg: "RS256", kid: "google-key" })}.${encode({
        iss: issuer,
        aud,
        sub: "google-subject",
        email,
        name: email,
        email_verified: true,
        iat: NOW / 1000,
        exp: NOW / 1000 + 300,
        ...(nonce === undefined ? {} : { nonce }),
      })}`;
      const signature = await crypto.subtle.sign(
        "RSASSA-PKCS1-v1_5",
        pair.privateKey,
        new TextEncoder().encode(unsigned),
      );
      return `${unsigned}.${base64UrlEncode(new Uint8Array(signature))}`;
    };
    try {
      const selected = resolveIdentity({ googleClientId: clientId, clock: () => new Date(now) });
      const capture = await selected.verifier.captureVerifiedIdentity({
        provider: "google",
        method: "oidc",
        assertion: await sign(clientId, "owner@example.test", "accounts.google.com", "nonce-one"),
        nonce: "nonce-one",
      });
      expect(capture.verified.providerSubject).toBe("google-subject");
      const observation = selected.verifier.inspectVerifiedIdentityCapture(capture.capture);
      expect(observation).toMatchObject({
        provider: "google",
        method: "oidc",
        providerSubject: "google-subject",
        verificationAuthority: {
          kind: "google-oidc",
          clientId,
          acceptedIssuerPolicy: ["accounts.google.com", "https://accounts.google.com"],
        },
      });
      if (observation?.verificationAuthority.kind === "google-oidc") {
        expect(observation.verificationAuthority.acceptedIssuerPolicy).toBe(
          GOOGLE_IDENTITY_ISSUERS,
        );
        expect(Object.isFrozen(observation.verificationAuthority.acceptedIssuerPolicy)).toBe(true);
      }
      expect(observation?.verificationDomain.body).toEqual([
        "takoserver.identity-verification-domain.v1",
        "google",
        "oidc",
        ...GOOGLE_IDENTITY_ISSUERS,
        clientId,
      ]);
      now += 1_000;
      const laterAssertion = await sign(
        clientId,
        "changed@example.test",
        "https://accounts.google.com",
        "nonce-two",
      );
      const laterCapture = await selected.verifier.captureVerifiedIdentity({
        provider: "google",
        method: "oidc",
        assertion: laterAssertion,
        nonce: "nonce-two",
      });
      const later = selected.verifier.inspectVerifiedIdentityCapture(laterCapture.capture);
      expect(later?.providerSubject).toBe(observation?.providerSubject);
      expect(later?.verificationDomain).toEqual(observation?.verificationDomain);
      expect(later?.assertionDigest).not.toBe(observation?.assertionDigest);
      expect(later?.verifiedAt).not.toBe(observation?.verifiedAt);
      expect(later?.email).not.toBe(observation?.email);
      expect(later?.displayName).not.toBe(observation?.displayName);
      expect(JSON.stringify(later?.verificationDomain.body)).not.toContain(laterAssertion);
      expect(JSON.stringify(later?.verificationDomain.body)).not.toContain("nonce-two");
      expect(Object.isFrozen(later?.verificationDomain)).toBe(true);
      expect(Object.isFrozen(later?.verificationDomain.body)).toBe(true);
      const anotherClient = resolveIdentity({
        googleClientId: "another-client",
        clock: () => new Date(NOW),
      });
      const otherCapture = await anotherClient.verifier.captureVerifiedIdentity({
        provider: "google",
        method: "oidc",
        assertion: await sign("another-client"),
      });
      expect(otherCapture.verified.providerSubject).toBe(capture.verified.providerSubject);
      expect(
        anotherClient.verifier.inspectVerifiedIdentityCapture(otherCapture.capture)
          ?.verificationDomain.digest,
      ).not.toBe(observation?.verificationDomain.digest);
      await expect(
        selected.verifier.captureVerifiedIdentity({
          provider: "google",
          method: "oidc",
          assertion: await sign("another-client"),
        }),
      ).rejects.toMatchObject({ code: "wrong_audience" });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("operator key mutation after construction cannot change verification or the recorded key", async () => {
    const first = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const second = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const firstJwk = await crypto.subtle.exportKey("jwk", first.publicKey);
    const secondJwk = await crypto.subtle.exportKey("jwk", second.publicKey);
    const publicKeyJwk = { kty: "OKP", crv: "Ed25519", x: String(firstJwk.x) };
    const selected = resolveIdentity({
      operatorPublicKeyJwk: publicKeyJwk,
      operatorAudience: AUDIENCE,
      clock: () => new Date(NOW),
    });
    publicKeyJwk.x = String(secondJwk.x);
    const firstPayload = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          purpose: "sign-in",
          aud: AUDIENCE,
          provider: "google",
          subject: "stable-subject",
          email: "owner@example.test",
          displayName: "Owner",
          iat: NOW / 1000,
          exp: NOW / 1000 + 300,
        }),
      ),
    );
    const assertion = async (key: CryptoKey) =>
      `${firstPayload}.${base64UrlEncode(
        new Uint8Array(
          await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(firstPayload)),
        ),
      )}`;
    await expect(
      selected.verifier.captureVerifiedIdentity({
        provider: "google",
        audience: AUDIENCE,
        assertion: await assertion(second.privateKey),
      }),
    ).rejects.toMatchObject({
      code: "invalid_signature",
    });
    const capture = await selected.verifier.captureVerifiedIdentity({
      provider: "google",
      audience: AUDIENCE,
      assertion: await assertion(first.privateKey),
    });
    expect(
      selected.verifier.inspectVerifiedIdentityCapture(capture.capture)?.verificationAuthority,
    ).toEqual({
      kind: "operator-assertion",
      audience: AUDIENCE,
      publicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(firstJwk.x) },
    });
    const originalDomain = selected.verifier.inspectVerifiedIdentityCapture(
      capture.capture,
    )?.verificationDomain;
    const anotherKey = resolveIdentity({
      operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(secondJwk.x) },
      operatorAudience: AUDIENCE,
      clock: () => new Date(NOW),
    });
    const keyCapture = await anotherKey.verifier.captureVerifiedIdentity({
      provider: "google",
      audience: AUDIENCE,
      assertion: await assertion(second.privateKey),
    });
    expect(keyCapture.verified.providerSubject).toBe(capture.verified.providerSubject);
    expect(
      anotherKey.verifier.inspectVerifiedIdentityCapture(keyCapture.capture)?.verificationDomain
        .digest,
    ).not.toBe(originalDomain?.digest);
    const otherAudience = "https://other.identity-origin.test";
    const otherPayload = base64UrlEncode(
      new TextEncoder().encode(
        JSON.stringify({
          purpose: "sign-in",
          aud: otherAudience,
          provider: "google",
          subject: "stable-subject",
          email: "owner@example.test",
          displayName: "Owner",
          iat: NOW / 1000,
          exp: NOW / 1000 + 300,
        }),
      ),
    );
    const otherSignature = await crypto.subtle.sign(
      "Ed25519",
      first.privateKey,
      new TextEncoder().encode(otherPayload),
    );
    const anotherAudience = resolveIdentity({
      operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(firstJwk.x) },
      operatorAudience: otherAudience,
      clock: () => new Date(NOW),
    });
    const audienceCapture = await anotherAudience.verifier.captureVerifiedIdentity({
      provider: "google",
      audience: otherAudience,
      assertion: `${otherPayload}.${base64UrlEncode(new Uint8Array(otherSignature))}`,
    });
    expect(audienceCapture.verified.providerSubject).toBe(capture.verified.providerSubject);
    expect(
      anotherAudience.verifier.inspectVerifiedIdentityCapture(audienceCapture.capture)
        ?.verificationDomain.digest,
    ).not.toBe(originalDomain?.digest);
  });
});
