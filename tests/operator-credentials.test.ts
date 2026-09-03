import { beforeEach, describe, expect, test } from "bun:test";
import { resolveIdentity } from "../src/identity-setup.ts";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";
import { base64UrlEncode } from "../src/json.ts";
import {
  createOperatorIdentity,
  createOperatorSettlement,
  OPERATOR_PROVIDERS,
  OperatorAssertionError,
} from "../src/operator-credentials.ts";

let signingKey: CryptoKey;
let publicKeyJwk: { kty: string; crv: string; x: string };
let now: number;
const clock = () => new Date(now);
const OPERATOR_AUDIENCE = "https://api.takoserver.test";

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
  aud: OPERATOR_AUDIENCE,
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
    const identity = createOperatorIdentity({
      publicKeyJwk,
      audience: OPERATOR_AUDIENCE,
      clock,
    });
    const verified = await identity.verify({
      provider: "google",
      assertion: await assert(SIGN_IN),
      audience: OPERATOR_AUDIENCE,
    });
    expect(verified).toEqual({
      providerSubject: "operator-1",
      email: "owner@example.com",
      displayName: "Owner",
    });
  });

  test("refuses a signature from any other key", async () => {
    const other = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const identity = createOperatorIdentity({ publicKeyJwk, audience: OPERATOR_AUDIENCE, clock });
    await expect(
      identity.verify({
        provider: "google",
        assertion: await assert(SIGN_IN, other.privateKey),
        audience: OPERATOR_AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  test("refuses a tampered claim even with a valid-looking shape", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, audience: OPERATOR_AUDIENCE, clock });
    const original = await assert(SIGN_IN);
    const [payload, signature] = original.split(".");
    const forged = JSON.parse(
      new TextDecoder().decode(Buffer.from(payload ?? "", "base64url")),
    ) as Record<string, unknown>;
    forged.email = "intruder@example.com";
    const swapped = `${base64UrlEncode(new TextEncoder().encode(JSON.stringify(forged)))}.${signature}`;
    await expect(
      identity.verify({ provider: "google", assertion: swapped, audience: OPERATOR_AUDIENCE }),
    ).rejects.toMatchObject({ code: "invalid_signature" });
  });

  test("will not let a funding assertion sign anybody in", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, audience: OPERATOR_AUDIENCE, clock });
    await expect(
      identity.verify({
        provider: "google",
        assertion: await assert(FUNDING),
        audience: OPERATOR_AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: "wrong_purpose" });
  });

  test("refuses an assertion for a different provider", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, audience: OPERATOR_AUDIENCE, clock });
    await expect(
      identity.verify({
        provider: "github",
        assertion: await assert(SIGN_IN),
        audience: OPERATOR_AUDIENCE,
      }),
    ).rejects.toMatchObject({ code: "wrong_purpose" });
  });

  test("stops accepting an assertion once it expires", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, audience: OPERATOR_AUDIENCE, clock });
    const assertion = await assert(SIGN_IN);
    now += 301_000;
    await expect(
      identity.verify({ provider: "google", assertion, audience: OPERATOR_AUDIENCE }),
    ).rejects.toMatchObject({ code: "expired" });
  });

  test("rejects a valid assertion replayed at a different Host audience", async () => {
    const identity = createOperatorIdentity({
      publicKeyJwk,
      audience: OPERATOR_AUDIENCE,
      clock,
    });
    const assertion = await assert(SIGN_IN);
    await expect(
      identity.verify({
        provider: "google",
        assertion,
        audience: "https://api.other-host.test",
      }),
    ).rejects.toMatchObject({ code: "wrong_audience" });
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

/**
 * Signing in as the account that actually owns the organization.
 *
 * `org_takosumi_hosted_staging`'s sole owner principal is a `github` one, and
 * the durable organization API key surface could not reach it: the Worker
 * registered `google:operator-assertion` alone, so `github` fell through to the
 * router's catch-all as an unhandled 500 and `google` landed on a principal
 * that owns nothing. Both halves are settled here over real HTTP.
 */
describe("operator sign-in over HTTP", () => {
  const ORIGIN = "https://api.takoserver.test";

  function newApp() {
    const setup = resolveIdentity({
      operatorPublicKeyJwk: publicKeyJwk,
      operatorAudience: ORIGIN,
      clock,
    });
    return buildApp({
      sql: createEphemeralSql(),
      objects: createMemoryObjectStore(),
      identity: setup.verifier,
      identityProviders: setup.providers,
      settlement: createOperatorSettlement({ publicKeyJwk, clock }),
      publicOrigin: ORIGIN,
      forms: [],
      hostForms: [],
      driver: new InMemoryTakoformResourceDriver(),
      offerings: [],
    });
  }

  async function call(
    app: ReturnType<typeof newApp>,
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<{ readonly status: number; readonly body: Record<string, unknown> }> {
    const response = await app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method,
        headers: body === undefined ? headers : { ...headers, "content-type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      }),
    );
    const text = await response.text();
    return { status: response.status, body: text ? JSON.parse(text) : {} };
  }

  test("mints an organization key for a GitHub-owned organization", async () => {
    const app = newApp();
    const session = await call(app, "POST", "/v1/sessions", {
      provider: "github",
      method: "operator-assertion",
      assertion: await assert({ ...SIGN_IN, provider: "github", subject: "staging-operator" }),
    });
    expect(session.status).toBe(200);
    expect(session.body.principal).toMatchObject({
      provider: "github",
      providerSubject: "staging-operator",
    });
    const owner = { authorization: `Bearer ${String(session.body.sessionToken)}` };

    const organization = await call(app, "POST", "/v1/organizations", { name: "Hosted" }, owner);
    expect(organization.status).toBe(201);
    const organizationId = String((organization.body.organization as { id: string }).id);

    const key = await call(
      app,
      "POST",
      `/v1/organizations/${organizationId}/api-keys`,
      { name: "reservation", scopes: ["resources:write"], expiresInSeconds: 3_600 },
      owner,
    );
    expect(key.status).toBe(201);
    expect(typeof key.body.secret).toBe("string");
  });

  test("advertises exactly the providers it will verify an assertion for", async () => {
    const providers = await call(newApp(), "GET", "/v1/identity/providers");
    expect(providers.status).toBe(200);
    expect(providers.body.providers).toEqual(
      OPERATOR_PROVIDERS.map((id) => ({
        id,
        displayName: "Operator assertion",
        method: "operator-assertion",
      })),
    );
  });

  test("refuses an unregistered provider with a stable 4xx rather than a 500", async () => {
    const refused = await call(newApp(), "POST", "/v1/sessions", {
      provider: "takos-id",
      method: "operator-assertion",
      assertion: await assert({ ...SIGN_IN, provider: "takos-id" }),
    });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ error: { code: "invalid" } });
  });
});
