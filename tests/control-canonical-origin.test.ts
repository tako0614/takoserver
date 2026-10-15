import { describe, expect, test } from "bun:test";
import { createAccounts } from "../src/auth.ts";
import { createControlRoutes } from "../src/control.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

const PUBLIC_ORIGIN = "https://api.selfhost.test";
const BACKEND_ORIGIN = "http://api.selfhost.test";
const CONSOLE_ORIGIN = "https://console.selfhost.test";

async function assertionAuthority(publicOrigin: string) {
  const pair = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const privateJwk = JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey));
  const identity = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(publicJwk.x) },
    operatorAudience: publicOrigin,
  });
  return {
    identity,
    async assertion(audience = publicOrigin, subject = "selfhost-operator") {
      return await signOperatorAssertion({
        privateJwk,
        claims: {
          purpose: "sign-in",
          aud: audience,
          provider: "google",
          subject,
          email:
            subject === "selfhost-operator" ? "operator@example.test" : `${subject}@example.test`,
          displayName: "Operator",
        },
        nowSeconds: Math.floor(Date.now() / 1_000),
        lifetimeSeconds: 60,
      });
    },
  };
}

async function fixture(publicOrigin = PUBLIC_ORIGIN) {
  const { identity, assertion } = await assertionAuthority(publicOrigin);
  const app = buildApp({
    v2: TEST_TAKOFORM_V2_CONFIG,
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
  return { app, assertion };
}

async function controlOnlyFixture(publicOrigin: string) {
  const { identity, assertion } = await assertionAuthority(publicOrigin);
  const accounts = createAccounts({ sql: createEphemeralSql(), identity: identity.verifier });
  const control = createControlRoutes({
    publicOrigin,
    consoleOrigin: CONSOLE_ORIGIN,
    accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: identity.providers,
    ledger: {} as never,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
    clock: () => new Date(),
  });
  return {
    assertion,
    async fetch(request: Request): Promise<Response> {
      const response = await control(request, new URL(request.url));
      if (!response) throw new Error("control route did not handle the session request");
      return response;
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

  test("standalone HTTP control routes retain non-Secure cookies while the normal Host refuses HTTP", async () => {
    const origin = "http://localhost:8787";
    await expect(fixture(origin)).rejects.toThrow(
      "baseUrl must be an ASCII serialized absolute HTTPS URL",
    );
    // Control routes retain their standalone HTTP cookie contract. The normal
    // public Takoform v2 Host cannot be composed with an HTTP origin.
    const { fetch, assertion } = await controlOnlyFixture(origin);
    const response = await fetch(
      request(origin, "/v1/sessions", signIn(await assertion()), { origin: CONSOLE_ORIGIN }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.has("set-cookie")).toBe(true);
    expect(response.headers.get("set-cookie")?.includes("; Secure")).toBe(false);
    const cookie = response.headers.get("set-cookie")?.split(";")[0] ?? "";
    const deleted = await fetch(
      request(origin, "/v1/session", undefined, { origin: CONSOLE_ORIGIN, cookie }, "DELETE"),
    );
    expect(deleted.status).toBe(204);
    expect(deleted.headers.get("set-cookie")?.includes("; Secure")).toBe(false);
  });
});

const COOKIE_V2_FORM = "https://forms.example/fixture-only/console-cookie/1.0.0";
const V2_RESOURCES = "/apis/forms.takoform.com/v2/resources";

async function cookieV2Fixture(
  options: { consoleOrigin?: string } = { consoleOrigin: CONSOLE_ORIGIN },
) {
  const { identity, assertion } = await assertionAuthority(PUBLIC_ORIGIN);
  const app = buildApp({
    v2: TEST_TAKOFORM_V2_CONFIG,
    sql: createEphemeralSql(),
    objects: createMemoryObjectStore(),
    identity: identity.verifier,
    identityProviders: identity.providers,
    settlement: {
      async verify(): Promise<never> {
        throw new Error("funding is outside this authentication test");
      },
    },
    publicOrigin: PUBLIC_ORIGIN,
    ...options,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    v2FormFactory: () => ({
      [COOKIE_V2_FORM]: {
        validateCreate(spec) {
          if (typeof spec.value !== "string") throw new Error("fixture requires a string value");
        },
        validateUpdate(_previous, spec) {
          if (typeof spec.value !== "string") throw new Error("fixture requires a string value");
        },
        backend: {
          id: "console-cookie-fixture",
          targetKey: "console-cookie-fixture",
          async execute() {
            return { kind: "complete", observed: { fixtureOnly: true }, output: {} };
          },
          async reconcile() {
            return { kind: "complete", observed: { fixtureOnly: true }, output: {} };
          },
        },
      },
    }),
  });
  return { app, assertion };
}

async function cookieOrganization(
  app: ReturnType<typeof buildApp>,
  assertion: () => Promise<string>,
) {
  const session = await app.fetch(
    request(BACKEND_ORIGIN, "/v1/sessions", signIn(await assertion()), {
      origin: CONSOLE_ORIGIN,
    }),
  );
  expect(session.status).toBe(200);
  expect((await session.json()).sessionToken).toBeUndefined();
  const setCookie = session.headers.get("set-cookie");
  expect(setCookie).toContain("HttpOnly");
  const cookie = setCookie?.split(";")[0] ?? "";
  expect(cookie.startsWith("takoserver_session=")).toBe(true);
  const created = await app.fetch(
    request(
      BACKEND_ORIGIN,
      "/v1/organizations",
      { name: "Cookie organization" },
      {
        origin: CONSOLE_ORIGIN,
        cookie,
      },
    ),
  );
  expect(created.status).toBe(201);
  const { organization } = await created.json();
  return { cookie, organization, token: cookie.slice("takoserver_session=".length) };
}

describe("console cookie authentication through the composed v2 Host", () => {
  test("cookie sign-in and Org creation remain authenticated for v2 overview, write and explicit Bearer", async () => {
    const { app, assertion } = await cookieV2Fixture();
    const { cookie, organization, token } = await cookieOrganization(app, assertion);
    const headers = { origin: CONSOLE_ORIGIN, cookie, "takoform-organization": organization.id };
    const listing = await app.fetch(
      request(
        PUBLIC_ORIGIN,
        `${V2_RESOURCES}?space=${encodeURIComponent(organization.id)}`,
        undefined,
        headers,
        "GET",
      ),
    );
    expect(listing.status).toBe(200);
    expect((await listing.json()).items).toEqual([]);
    const created = await app.fetch(
      request(
        PUBLIC_ORIGIN,
        V2_RESOURCES,
        {
          form: COOKIE_V2_FORM,
          space: organization.id,
          name: "cookie-created",
          spec: { value: "one" },
        },
        { ...headers, "idempotency-key": "console-cookie-resource-create-001" },
      ),
    );
    expect(created.status).toBe(202);
    const operation = await created.json();
    const read = await app.fetch(
      request(PUBLIC_ORIGIN, `${V2_RESOURCES}/${operation.resourceUid}`, undefined, headers, "GET"),
    );
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ space: organization.id, name: "cookie-created" });
    const bearer = await app.fetch(
      request(
        PUBLIC_ORIGIN,
        `${V2_RESOURCES}?space=${encodeURIComponent(organization.id)}`,
        undefined,
        {
          origin: "https://unrelated.example.test",
          cookie: "takoserver_session=invalid",
          authorization: `Bearer ${token}`,
          "takoform-organization": organization.id,
        },
        "GET",
      ),
    );
    expect(bearer.status).toBe(200);
  });

  test("v1 and v2 reject cookie Origin spoofing, invalid explicit authorization and non-owned Org selection", async () => {
    const { app, assertion } = await cookieV2Fixture();
    const { cookie, organization } = await cookieOrganization(app, assertion);
    const invalidOrigins: Record<string, string>[] = [
      {},
      { origin: "null" },
      { origin: "https://unrelated.example.test" },
      { origin: `${CONSOLE_ORIGIN}/` },
      { origin: `${CONSOLE_ORIGIN}.attacker.test` },
      { origin: "https://sub.console.selfhost.test" },
      { origin: `${CONSOLE_ORIGIN}/attacker` },
      {
        forwarded: "host=console.selfhost.test;proto=https",
        "x-forwarded-host": "console.selfhost.test",
        "x-forwarded-proto": "https",
        "x-forwarded-origin": CONSOLE_ORIGIN,
      },
      { origin: "https://unrelated.example.test", "x-forwarded-origin": CONSOLE_ORIGIN },
      { origin: CONSOLE_ORIGIN, authorization: "Bearer invalid" },
      { origin: CONSOLE_ORIGIN, authorization: "Basic invalid" },
    ];
    for (const extra of invalidOrigins) {
      const headers = { cookie, "takoform-organization": organization.id, ...extra };
      expect(
        (await app.fetch(request(BACKEND_ORIGIN, "/v1/me", undefined, headers, "GET"))).status,
      ).toBe(401);
      expect(
        (
          await app.fetch(
            request(
              PUBLIC_ORIGIN,
              `${V2_RESOURCES}?space=${encodeURIComponent(organization.id)}`,
              undefined,
              headers,
              "GET",
            ),
          )
        ).status,
      ).toBe(401);
    }
    expect(
      (
        await app.fetch(
          request(
            PUBLIC_ORIGIN,
            V2_RESOURCES,
            undefined,
            { origin: CONSOLE_ORIGIN, cookie },
            "GET",
          ),
        )
      ).status,
    ).toBe(401);
    const foreign = await cookieOrganization(app, () =>
      assertion(PUBLIC_ORIGIN, "other-console-operator"),
    );
    expect(
      (
        await app.fetch(
          request(
            PUBLIC_ORIGIN,
            V2_RESOURCES,
            undefined,
            {
              origin: CONSOLE_ORIGIN,
              cookie,
              "takoform-organization": foreign.organization.id,
            },
            "GET",
          ),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          request(
            PUBLIC_ORIGIN,
            V2_RESOURCES,
            undefined,
            {
              origin: CONSOLE_ORIGIN,
              cookie,
              "takoform-organization": `${organization.id}-alias`,
            },
            "GET",
          ),
        )
      ).status,
    ).toBe(401);
  });

  test("unconfigured console Origin never enables cookie authentication while explicit Bearer still works", async () => {
    const { app, assertion } = await cookieV2Fixture({});
    const signedIn = await app.fetch(
      request(BACKEND_ORIGIN, "/v1/sessions", signIn(await assertion()), {
        origin: CONSOLE_ORIGIN,
      }),
    );
    expect(signedIn.status).toBe(200);
    expect(signedIn.headers.has("set-cookie")).toBe(false);
    const { sessionToken } = await signedIn.json();
    const created = await app.fetch(
      request(
        BACKEND_ORIGIN,
        "/v1/organizations",
        { name: "Bearer-only organization" },
        { authorization: `Bearer ${sessionToken}` },
      ),
    );
    expect(created.status).toBe(201);
    const { organization } = await created.json();
    const headers = {
      origin: CONSOLE_ORIGIN,
      cookie: `takoserver_session=${sessionToken}`,
      "takoform-organization": organization.id,
    };
    expect(
      (await app.fetch(request(PUBLIC_ORIGIN, V2_RESOURCES, undefined, headers, "GET"))).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          request(
            PUBLIC_ORIGIN,
            V2_RESOURCES,
            undefined,
            { ...headers, authorization: `Bearer ${sessionToken}` },
            "GET",
          ),
        )
      ).status,
    ).toBe(200);
  });

  test("revoked console cookies cannot reopen v2 overview or write resources", async () => {
    const { app, assertion } = await cookieV2Fixture();
    const { cookie, organization } = await cookieOrganization(app, assertion);
    const headers = { origin: CONSOLE_ORIGIN, cookie, "takoform-organization": organization.id };
    expect(
      (await app.fetch(request(BACKEND_ORIGIN, "/v1/session", undefined, headers, "DELETE")))
        .status,
    ).toBe(204);
    expect(
      (await app.fetch(request(PUBLIC_ORIGIN, V2_RESOURCES, undefined, headers, "GET"))).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          request(
            PUBLIC_ORIGIN,
            V2_RESOURCES,
            {
              form: COOKIE_V2_FORM,
              space: organization.id,
              name: "revoked",
              spec: { value: "one" },
            },
            { ...headers, "idempotency-key": "console-cookie-revoked-create-001" },
          ),
        )
      ).status,
    ).toBe(401);
  });
});
