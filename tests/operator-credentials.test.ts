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
import type { Sql } from "../src/ports.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

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
    expect(verified).toMatchObject({
      providerSubject: "operator-1",
      email: "owner@example.com",
      displayName: "Owner",
    });
  });

  test("names the signed payload as the single-use key the session exchange spends", async () => {
    const identity = createOperatorIdentity({ publicKeyJwk, audience: OPERATOR_AUDIENCE, clock });
    const assertion = await assert(SIGN_IN);
    const [payload] = assertion.split(".");
    const digest = new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload ?? "")),
    );
    const verified = await identity.verify({
      provider: "google",
      assertion,
      audience: OPERATOR_AUDIENCE,
    });
    expect(verified.singleUse).toEqual({
      namespace: "operator-sign-in",
      digest: `sha256:${Buffer.from(digest).toString("hex")}`,
      expiresAtEpochSeconds: Math.floor(now / 1_000) + 300,
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

  function newApp(sql: Sql = createEphemeralSql()) {
    const setup = resolveIdentity({
      operatorPublicKeyJwk: publicKeyJwk,
      operatorAudience: ORIGIN,
      clock,
    });
    return buildApp({
      v2: TEST_TAKOFORM_V2_CONFIG,
      sql,
      clock,
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

  /**
   * The printed first-boot assertion lands in journald, container logs and
   * terminal scrollback. Once the operator has exchanged it, anybody who can
   * read those logs must not be able to exchange it again for a second
   * twelve-hour operator session while it is still inside its lifetime.
   */
  describe("single use", () => {
    const signInWith = (assertion: string) => ({
      provider: "google",
      method: "operator-assertion",
      assertion,
    });

    test("opens exactly one session and refuses the replay without a bearer", async () => {
      const app = newApp();
      const assertion = await assert(SIGN_IN);
      const first = await call(app, "POST", "/v1/sessions", signInWith(assertion));
      expect(first.status).toBe(200);
      expect(typeof first.body.sessionToken).toBe("string");

      const replay = await call(app, "POST", "/v1/sessions", signInWith(assertion));
      expect(replay.status).toBe(401);
      expect(replay.body).toMatchObject({ error: { code: "unauthenticated" } });
      expect(replay.body.sessionToken).toBeUndefined();

      // A fresh assertion for the same operator is still a way in.
      now += 1_000;
      const fresh = await call(app, "POST", "/v1/sessions", signInWith(await assert(SIGN_IN)));
      expect(fresh.status).toBe(200);
    });

    test("concurrent exchanges of one assertion issue exactly one session", async () => {
      const app = newApp();
      const assertion = await assert(SIGN_IN);
      const results = await Promise.all(
        Array.from({ length: 4 }, () => call(app, "POST", "/v1/sessions", signInWith(assertion))),
      );
      expect(results.map((result) => result.status).sort()).toEqual([200, 401, 401, 401]);
    });

    test("an owner proof does not spend the assertion its session exchange then redeems", async () => {
      const app = newApp();
      const owner = await call(app, "POST", "/v1/sessions", signInWith(await assert(SIGN_IN)));
      const organization = await call(
        app,
        "POST",
        "/v1/organizations",
        { name: "Owned" },
        { authorization: `Bearer ${String(owner.body.sessionToken)}` },
      );
      const organizationId = String((organization.body.organization as { id: string }).id);

      now += 1_000;
      const assertion = await assert(SIGN_IN);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const proof = await call(app, "POST", "/v1/operator-owner-proof", {
          ...signInWith(assertion),
          organizationId,
        });
        expect(proof.status).toBe(200);
      }
      expect((await call(app, "POST", "/v1/sessions", signInWith(assertion))).status).toBe(200);
      expect((await call(app, "POST", "/v1/sessions", signInWith(assertion))).status).toBe(401);
    });

    test("an assertion refused for another reason is not spent", async () => {
      const app = newApp();
      const assertion = await assert(SIGN_IN);
      const wrongProvider = await call(app, "POST", "/v1/sessions", {
        ...signInWith(assertion),
        provider: "github",
      });
      expect(wrongProvider.status).toBe(401);
      expect((await call(app, "POST", "/v1/sessions", signInWith(assertion))).status).toBe(200);
    });

    test("forgets a spent assertion only well after it can no longer be presented", async () => {
      const sql = createEphemeralSql();
      const app = newApp(sql);
      const spent = async () =>
        (
          await sql.query(
            "SELECT grant_id FROM runtime_grant_replays WHERE grant_id LIKE 'operator-sign-in:%'",
          )
        ).length;
      const assertion = await assert(SIGN_IN);
      expect((await call(app, "POST", "/v1/sessions", signInWith(assertion))).status).toBe(200);
      expect(await spent()).toBe(1);

      // Inside its lifetime the replay is refused by the spent entry.
      now += 299_000;
      expect((await call(app, "POST", "/v1/sessions", signInWith(assertion))).status).toBe(401);
      expect(await spent()).toBe(1);

      // Just past expiry the entry is kept: a verifier clock running behind
      // this store's must not find it gone.
      now += 2_000;
      expect(
        (await call(app, "POST", "/v1/sessions", signInWith(await assert(SIGN_IN)))).status,
      ).toBe(200);
      expect(await spent()).toBe(2);

      // Past the skew margin, the next exchange prunes it and nothing younger.
      const [first] = (
        await sql.query(
          "SELECT grant_id FROM runtime_grant_replays ORDER BY consumed_at_epoch_seconds",
        )
      ).map((row) => String(row.grant_id));
      now += 301_000;
      expect(
        (await call(app, "POST", "/v1/sessions", signInWith(await assert(SIGN_IN)))).status,
      ).toBe(200);
      const remaining = (await sql.query("SELECT grant_id FROM runtime_grant_replays")).map((row) =>
        String(row.grant_id),
      );
      expect(remaining).toHaveLength(2);
      expect(remaining).not.toContain(first);
    });

    test("pruning touches only spent sign-in assertions, never another key space", async () => {
      const sql = createEphemeralSql();
      const app = newApp(sql);
      // An expired entry of another owner of the replay cache.
      await sql.run(
        `INSERT INTO runtime_grant_replays
           (grant_id, expires_at_epoch_seconds, consumed_at_epoch_seconds)
         VALUES ('runtime-grant-jti-1', 2, 1)`,
      );
      expect(
        (await call(app, "POST", "/v1/sessions", signInWith(await assert(SIGN_IN)))).status,
      ).toBe(200);
      const ids = (await sql.query("SELECT grant_id FROM runtime_grant_replays")).map((row) =>
        String(row.grant_id),
      );
      expect(ids).toContain("runtime-grant-jti-1");
      expect(ids.filter((id) => id.startsWith("operator-sign-in:sha256:"))).toHaveLength(1);
    });

    test("a store clock ahead of the verifier's still spends the assertion once", async () => {
      // The verifier decides expiry on its own clock; the store must not
      // refuse a credential the verifier accepted, nor record one it cannot
      // keep for the verifier's remaining lifetime.
      const setup = resolveIdentity({
        operatorPublicKeyJwk: publicKeyJwk,
        operatorAudience: ORIGIN,
        clock,
      });
      const app = buildApp({
        v2: TEST_TAKOFORM_V2_CONFIG,
        sql: createEphemeralSql(),
        clock: () => new Date(now + 3_600_000),
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
      const assertion = await assert(SIGN_IN);
      expect((await call(app, "POST", "/v1/sessions", signInWith(assertion))).status).toBe(200);
      expect((await call(app, "POST", "/v1/sessions", signInWith(assertion))).status).toBe(401);
    });
  });
});
