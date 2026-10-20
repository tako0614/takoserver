import { describe, expect, test } from "bun:test";
import { createAccounts } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createControlRoutes } from "../src/control.ts";
import { bytesDigest } from "../src/json.ts";
import { createSharedAuthSession } from "../src/shared-auth-session.ts";
import { createSharedAuthSessionStore } from "../src/shared-auth-session-store.ts";
import { SHARED_AUTH_TEST_ONLY_DDL } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_PERSONAL_ORGANIZATION,
} from "./helpers/shared-auth-session-issuer.ts";

const NOW = 1_800_000_000_000;
const SHARED_COOKIE = "__Host-takoserver_shared_session";

function cookie(response: Response, name: string): string {
  const value = response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0] ?? "")
    .find((item) => item.startsWith(`${name}=`));
  if (!value) throw new Error(`missing ${name}`);
  return value;
}

async function fixture() {
  const sql = createEphemeralSql();
  for (const statement of SHARED_AUTH_TEST_ONLY_DDL) await sql.run(statement);
  let now = NOW;
  const clock = () => new Date(now);
  const issuer = await createSharedSessionTestIssuer(() => now);
  issuer.control.personalBillingOrganization = SESSION_TEST_PERSONAL_ORGANIZATION;
  const accounts = createAccounts({
    sql,
    clock,
    identity: {
      async verify({ assertion }) {
        return {
          providerSubject: assertion,
          email: `${assertion}@local.example.test`,
          displayName: assertion,
        };
      },
    },
  });
  const signed = await accounts.signIn({ provider: "google", assertion: "retained-owner" });
  const owner = await accounts.authenticate(`Bearer ${signed.sessionToken}`);
  if (!owner) throw new Error("missing local owner");
  const organization = await accounts.createOrganization({ actor: owner, name: "Owned" });
  const sharedAuth = createSharedAuthSession({
    config: SESSION_TEST_CONFIG,
    consoleOrigin: SESSION_TEST_CONSOLE,
    encryptionKey: new Uint8Array(32).fill(7),
    now: () => now,
    store: () => createSharedAuthSessionStore(sql),
    fetch: issuer.send,
    // Local test projection: the synthetic signed issuer selects the retained
    // Server principal. It makes no claim about a deployed Accounts binding.
    principals: {
      async resolve(input) {
        return { accountId: input.accountId, principalId: signed.principal.id };
      },
    },
    organizations: {
      async pin(input) {
        return input;
      },
    },
  });
  const checkoutCalls: string[] = [];
  const control = createControlRoutes({
    publicOrigin: SESSION_TEST_CONFIG.publicOrigin,
    consoleOrigin: SESSION_TEST_CONSOLE,
    sharedAuth,
    accounts,
    inventory: {} as never,
    deployments: {} as never,
    attachments: {} as never,
    migrations: {} as never,
    forms: [],
    identityProviders: [],
    ledger: {} as never,
    catalog: {} as never,
    reseller: {} as never,
    tokens: {} as never,
    settlement: {} as never,
    clock,
    checkout: {
      referenceRequired: true,
      bounds: { minimumMinor: 1, maximumMinor: 1000 },
      async begin(input) {
        checkoutCalls.push(input.organizationId);
        return { url: "https://checkout.local.example.test/session" };
      },
    },
  });
  async function fetch(
    path: string,
    options: {
      method?: string;
      cookie?: string;
      origin?: string;
      authorization?: string;
      body?: unknown;
    } = {},
  ) {
    const request = new Request(`${SESSION_TEST_CONFIG.publicOrigin}${path}`, {
      method: options.method ?? "GET",
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const response = await control(request, new URL(request.url));
    if (!response) throw new Error("unhandled control route");
    return response;
  }
  async function sharedCookie() {
    const login = await sharedAuth.fetch(
      new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/login`),
    );
    if (login?.status !== 303) throw new Error("login failed");
    const location = login.headers.get("location");
    if (!location) throw new Error("missing location");
    const callback = await sharedAuth.fetch(
      new Request(issuer.authorize(location), {
        headers: { cookie: cookie(login, "__Host-takoserver_oidc_attempt") },
      }),
    );
    if (callback?.status !== 303) throw new Error("callback failed");
    return cookie(callback, SHARED_COOKIE);
  }
  return {
    sql,
    accounts,
    signed,
    organization,
    sharedAuth,
    issuer,
    fetch,
    sharedCookie,
    checkoutCalls,
    setTime(value: number) {
      now = value;
    },
  };
}

describe("same-request shared RP admission in Owner HTTP", () => {
  test("shared session reaches me, owner GET and the actual checkout POST; live owner removal blocks POST", async () => {
    const f = await fixture();
    const cookie = await f.sharedCookie();
    const headers = { cookie, origin: SESSION_TEST_CONSOLE };
    const me = await f.fetch("/v1/me", headers);
    expect(me.status).toBe(200);
    expect((await me.json()).principal.id).toBe(f.signed.principal.id);
    const created = await f.fetch("/v1/organizations", {
      ...headers,
      method: "POST",
      body: { name: "Another local organization" },
    });
    expect(created.status).toBe(201);
    // The local Accounts personal-organization producer still applies its
    // generic-ownership rule after shared-session admission.
    expect(
      (await f.fetch("/v1/organizations/personal", { ...headers, method: "POST", body: {} }))
        .status,
    ).toBe(503);
    const keysPath = `/v1/organizations/${f.organization.id}/api-keys`;
    expect((await f.fetch(keysPath, headers)).status).toBe(200);
    const checkoutPath = `/v1/organizations/${f.organization.id}/wallet/checkout`;
    expect(
      (
        await f.fetch(checkoutPath, {
          ...headers,
          method: "POST",
          body: { reference: "checkout-1", amountMinor: 50 },
        })
      ).status,
    ).toBe(201);
    expect(f.checkoutCalls).toEqual([f.organization.id]);
    await f.sql.run("DELETE FROM org_memberships WHERE org_id = ? AND principal_id = ?", [
      f.organization.id,
      f.signed.principal.id,
    ]);
    const denied = await f.fetch(checkoutPath, {
      ...headers,
      method: "POST",
      body: { reference: "checkout-2", amountMinor: 50 },
    });
    expect(denied.status).toBe(404);
    expect(f.checkoutCalls).toEqual([f.organization.id]);
  });

  test("origin and selected credential boundaries fail closed without falling back", async () => {
    const f = await fixture();
    const shared = await f.sharedCookie();
    const path = `/v1/organizations/${f.organization.id}/api-keys`;
    for (const origin of [undefined, "https://foreign.example.test"]) {
      expect(
        (await f.fetch(path, { cookie: shared, ...(origin === undefined ? {} : { origin }) }))
          .status,
      ).toBe(401);
    }
    for (const authorization of ["", "Bearer invalid"]) {
      expect(
        (await f.fetch(path, { cookie: shared, origin: SESSION_TEST_CONSOLE, authorization }))
          .status,
      ).toBe(401);
    }
    expect(
      (
        await f.fetch(path, {
          cookie: `${shared}; takoserver_session=invalid`,
          origin: SESSION_TEST_CONSOLE,
        })
      ).status,
    ).toBe(401);
    expect(
      (await f.fetch(path, { cookie: "takoserver_session=invalid", origin: SESSION_TEST_CONSOLE }))
        .status,
    ).toBe(401);
    expect(
      (
        await f.fetch(path, {
          cookie: shared.replace(SHARED_COOKIE, "__Host-hosted_session"),
          origin: SESSION_TEST_CONSOLE,
        })
      ).status,
    ).toBe(401);
    expect((await f.fetch(path, { authorization: `Bearer ${f.signed.sessionToken}` })).status).toBe(
      200,
    );
    expect(
      (
        await f.fetch(path, {
          cookie: `takoserver_session=${f.signed.sessionToken}`,
          origin: SESSION_TEST_CONSOLE,
        })
      ).status,
    ).toBe(200);
  });

  test("malformed, unknown, revoked and expired shared sessions cannot act; API key scope stays independent", async () => {
    const f = await fixture();
    const shared = await f.sharedCookie();
    const path = `/v1/organizations/${f.organization.id}/wallet/checkout`;
    const act = (value: string) =>
      f.fetch(path, {
        method: "POST",
        cookie: value,
        origin: SESSION_TEST_CONSOLE,
        body: { reference: "checkout-1", amountMinor: 50 },
      });
    expect((await act(`${SHARED_COOKIE}=garbage`)).status).toBe(401);
    expect((await act(`${SHARED_COOKIE}=${"a".repeat(64)}`)).status).toBe(401);
    const owner = await f.accounts.authenticate(`Bearer ${f.signed.sessionToken}`);
    if (!owner) throw new Error("missing local owner");
    const key = await f.accounts.createApiKey({
      actor: owner,
      organizationId: f.organization.id,
      name: "No payments",
      scopes: ["wallet:read"],
      expiresInSeconds: 3600,
    });
    expect(await f.accounts.authenticate(`Bearer ${key.secret}`)).toMatchObject({
      kind: "api_key",
    });
    expect(
      (
        await f.fetch(path, {
          method: "POST",
          authorization: `Bearer ${key.secret}`,
          cookie: shared,
          origin: SESSION_TEST_CONSOLE,
          body: { reference: "checkout-1", amountMinor: 50 },
        })
      ).status,
    ).toBe(403);
    const digest = await bytesDigest(
      new TextEncoder().encode(shared.slice(`${SHARED_COOKIE}=`.length)),
    );
    await createSharedAuthSessionStore(f.sql).revokeSession(digest, NOW);
    expect((await act(shared)).status).toBe(401);
    const fresh = await f.sharedCookie();
    f.setTime(NOW + 8 * 24 * 60 * 60 * 1000);
    expect((await act(fresh)).status).toBe(401);
    expect(f.checkoutCalls).toEqual([]);
  });

  test("current Workspace denial is 403 and unavailable custody is a generic 503", async () => {
    const f = await fixture();
    const shared = await f.sharedCookie();
    const request = () =>
      f.fetch(`/v1/organizations/${f.organization.id}/api-keys`, {
        cookie: shared,
        origin: SESSION_TEST_CONSOLE,
      });
    f.issuer.control.member = false;
    const forbidden = await request();
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error.code).toBe("permission_denied");
    f.issuer.control.member = true;
    await f.sql.run("DROP TABLE shared_auth_sessions");
    const unavailable = await request();
    expect(unavailable.status).toBe(503);
    expect((await unavailable.json()).error.code).toBe("backend_unavailable");
  });

  test("construction captures the original RP callable and its receiver", async () => {
    const f = await fixture();
    const shared = await f.sharedCookie();
    f.sharedAuth.authenticate = async () => null;
    const response = await f.fetch("/v1/me", {
      cookie: shared,
      origin: SESSION_TEST_CONSOLE,
    });
    expect(response.status).toBe(200);
  });
});
