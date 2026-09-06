import { describe, expect, test } from "bun:test";
import { resolveIdentity } from "../src/identity-setup.ts";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";

const PUBLIC_ORIGIN = "https://api.selfhost.test";
const BACKEND_ORIGIN = "http://api.selfhost.test";
const CONSOLE_ORIGIN = "https://console.selfhost.test";

async function fixture(publicOrigin = PUBLIC_ORIGIN) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
  const identity = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(publicJwk.x) },
    operatorAudience: publicOrigin,
  });
  const app = buildApp({
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity: identity.verifier,
    identityProviders: identity.providers,
    settlement: {
      async verify(): Promise<never> {
        throw new Error("funding is outside this authentication test");
      },
    },
    publicOrigin,
    consoleOrigin: CONSOLE_ORIGIN,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
  });
  return {
    app,
    async assertion(audience = publicOrigin) {
      return await signOperatorAssertion({
        privateJwk,
        claims: {
          purpose: "sign-in",
          aud: audience,
          provider: "google",
          subject: "selfhost-operator",
          email: "operator@example.test",
          displayName: "Operator",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
    },
  };
}

function request(
  origin: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
  method = "POST",
) {
  return new Request(`${origin}${path}`, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function signIn(assertion: string) {
  return { provider: "google", method: "operator-assertion", assertion };
}

describe("control authentication behind a TLS front end", () => {
  test("the configured HTTPS audience survives the backend HTTP transport", async () => {
    const { app, assertion } = await fixture();
    const response = await app.fetch(
      request(BACKEND_ORIGIN, "/v1/sessions", signIn(await assertion())),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.principal.providerSubject).toBe("selfhost-operator");
    expect(typeof body.sessionToken).toBe("string");
  });

  test("existing-owner proof uses the same canonical audience", async () => {
    const { app, assertion } = await fixture();
    const signed = await assertion();
    const sessionResponse = await app.fetch(request(PUBLIC_ORIGIN, "/v1/sessions", signIn(signed)));
    expect(sessionResponse.status).toBe(200);
    const session = await sessionResponse.json();
    const organizationResponse = await app.fetch(
      request(
        PUBLIC_ORIGIN,
        "/v1/organizations",
        { name: "Local organization" },
        {
          authorization: `Bearer ${session.sessionToken}`,
        },
      ),
    );
    expect(organizationResponse.status).toBe(201);
    const { organization } = await organizationResponse.json();
    const proof = await app.fetch(
      request(BACKEND_ORIGIN, "/v1/operator-owner-proof", {
        ...signIn(await assertion()),
        organizationId: organization.id,
      }),
    );
    expect(proof.status).toBe(200);
    expect((await proof.json()).organization.id).toBe(organization.id);
  });

  test("TLS-front session and deletion cookies stay Secure without weakening the console gate", async () => {
    const { app, assertion } = await fixture();
    const response = await app.fetch(
      request(BACKEND_ORIGIN, "/v1/sessions", signIn(await assertion()), {
        origin: CONSOLE_ORIGIN,
        "x-forwarded-proto": "http",
      }),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).sessionToken).toBeUndefined();
    const cookie = response.headers.get("set-cookie");
    expect(cookie?.includes("; Secure")).toBe(true);
    const sessionCookie = cookie?.split(";")[0] ?? "";
    const crossOrigin = await app.fetch(
      request(
        BACKEND_ORIGIN,
        "/v1/session",
        undefined,
        {
          origin: "https://unrelated.example.test",
          cookie: sessionCookie,
        },
        "DELETE",
      ),
    );
    expect(crossOrigin.status).toBe(401);
    const deleted = await app.fetch(
      request(
        BACKEND_ORIGIN,
        "/v1/session",
        undefined,
        {
          origin: CONSOLE_ORIGIN,
          cookie: sessionCookie,
        },
        "DELETE",
      ),
    );
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("set-cookie")?.includes("; Secure")).toBe(true);
    expect(deleted.headers.get("set-cookie")?.includes("Max-Age=0")).toBe(true);
  });

  test("request host and forwarding headers cannot choose the signed audience", async () => {
    const { app, assertion } = await fixture();
    const otherOrigin = "https://unrelated.example.test";
    const response = await app.fetch(
      request("http://127.0.0.1:18787", "/v1/sessions", signIn(await assertion(otherOrigin)), {
        host: "unrelated.example.test",
        forwarded: "host=unrelated.example.test;proto=https",
        "x-forwarded-host": "unrelated.example.test",
        "x-forwarded-proto": "https",
      }),
    );
    expect(response.status).toBe(401);
    expect(response.headers.has("set-cookie")).toBe(false);
    expect((await response.json()).error.code).toBe("unauthenticated");
    const canonical = await app.fetch(
      request("http://127.0.0.1:18787", "/v1/sessions", signIn(await assertion()), {
        host: "unrelated.example.test",
        forwarded: "host=unrelated.example.test;proto=https",
        "x-forwarded-host": "unrelated.example.test",
        "x-forwarded-proto": "https",
      }),
    );
    expect(canonical.status).toBe(200);
  });

  test("an explicitly HTTP local deployment retains non-Secure cookies", async () => {
    const origin = "http://localhost:8787";
    const { app, assertion } = await fixture(origin);
    const response = await app.fetch(
      request(origin, "/v1/sessions", signIn(await assertion()), { origin: CONSOLE_ORIGIN }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.has("set-cookie")).toBe(true);
    expect(response.headers.get("set-cookie")?.includes("; Secure")).toBe(false);
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const deleted = await app.fetch(
      request(origin, "/v1/session", undefined, { origin: CONSOLE_ORIGIN, cookie }, "DELETE"),
    );
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("set-cookie")?.includes("; Secure")).toBe(false);
  });
});
