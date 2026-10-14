import { describe, expect, test } from "bun:test";
import { base64UrlEncode } from "../src/json.ts";
import {
  createSharedAuthOidcClient,
  type SharedAuthGrant,
  type SharedAuthOidcConfig,
  SharedAuthOidcError,
} from "../src/shared-auth-oidc-client.ts";

const stamp = 1792022400000;
const nonce = "test-nonce";
const verifier = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG";
const config: SharedAuthOidcConfig = {
  environment: "staging",
  issuer: "https://auth-staging.example.test",
  publicOrigin: "https://console-staging.example.test",
  clientId: "takoserver-console-staging-v1",
  clientSecret: "test-only:client+credential/α",
};

async function fixture(
  options: {
    readonly claims?: Record<string, unknown>;
    readonly header?: Record<string, unknown>;
    readonly jwks?: (key: Record<string, unknown>) => unknown;
    readonly tokens?: (token: string, form: URLSearchParams) => unknown;
    readonly introspection?: Record<string, unknown>;
    readonly userinfo?: Record<string, unknown>;
    readonly send?: (request: Request, response: () => Promise<Response>) => Promise<Response>;
  } = {},
) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const key: Record<string, unknown> = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    alg: "ES256",
    kid: "stage-key",
    use: "sig",
  };
  const seconds = stamp / 1000;
  const claims: Record<string, unknown> = {
    iss: config.issuer,
    aud: config.clientId,
    sub: "account-canonical-123",
    sid: "accounts-session-123",
    auth_time: seconds - 60,
    iat: seconds,
    exp: seconds + 300,
    nonce,
    ...options.claims,
  };
  const token = await sign(
    keys.privateKey,
    JSON.stringify({ alg: "ES256", typ: "JWT", kid: "stage-key", ...options.header }),
    JSON.stringify(claims),
  );
  const requests: {
    url: string;
    method: string;
    headers: Headers;
    form: URLSearchParams;
    redirect: RequestRedirect;
    signal: AbortSignal;
  }[] = [];
  const client = createSharedAuthOidcClient({
    config,
    now: () => stamp,
    fetch: async (request) => {
      const form = new URLSearchParams(
        request.method === "POST" ? await request.clone().text() : "",
      );
      requests.push({
        url: request.url,
        method: request.method,
        headers: request.headers,
        form,
        redirect: request.redirect,
        signal: request.signal,
      });
      const response = async () => {
        const path = new URL(request.url).pathname;
        if (path === "/oauth/jwks") return Response.json(options.jwks?.(key) ?? { keys: [key] });
        if (path === "/oauth/token")
          return Response.json(
            options.tokens?.(token, form) ?? {
              id_token: token,
              token_type: "Bearer",
              access_token: "test-access",
              refresh_token: "test-refresh",
              expires_in: 300,
              scope: "openid email offline_access",
            },
          );
        if (path === "/oauth/introspect")
          return Response.json(
            options.introspection ?? {
              active: true,
              token_use: "oauth_access",
              client_id: config.clientId,
              aud: config.clientId,
              sub: claims.sub,
              exp: seconds + 300,
              scope: "openid email offline_access",
            },
          );
        if (path === "/oauth/userinfo")
          return Response.json(
            options.userinfo ?? {
              sub: claims.sub,
              aud: config.clientId,
              scope: "openid email offline_access",
            },
          );
        if (path === "/oauth/revoke") return new Response(null, { status: 200 });
        throw new Error("unexpected request");
      };
      return options.send ? await options.send(request, response) : await response();
    },
  });
  return { client, requests, token, key, keys, claims };
}

async function sign(key: CryptoKey, header: string, claims: string) {
  const content = `${base64UrlEncode(new TextEncoder().encode(header))}.${base64UrlEncode(new TextEncoder().encode(claims))}`;
  return `${content}.${base64UrlEncode(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, new TextEncoder().encode(content)))}`;
}

const previous: SharedAuthGrant = {
  issuer: config.issuer,
  clientId: config.clientId,
  subject: "account-canonical-123",
  sessionId: "accounts-session-123",
  authTime: stamp / 1000 - 60,
  accessToken: "old-access",
  refreshToken: "old-refresh",
  accessExpiresAt: stamp - 1,
  nonce,
};

describe("first-party staging OIDC protocol", () => {
  test("requests server code flow, S256, nonce, consent and offline access", async () => {
    const { client } = await fixture();
    const url = new URL(await client.authorizationUrl({ state: "test-state", nonce, verifier }));
    expect(url.origin).toBe(config.issuer);
    expect(url.pathname).toBe("/oauth/authorize");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId,
      redirect_uri: `${config.publicOrigin}/auth/oidc/callback`,
      response_type: "code",
      scope: "openid email offline_access",
      state: "test-state",
      nonce,
      code_challenge: base64UrlEncode(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
      ),
      code_challenge_method: "S256",
      prompt: "consent",
    });
    expect(JSON.stringify(client.config)).not.toContain(config.clientSecret);
  });

  test("exchanges a signed ID token and keeps the canonical subject without email linking", async () => {
    const { client, requests } = await fixture({
      claims: { email: "same-as-legacy@example.test", email_verified: true, name: "Person" },
    });
    const result = await client.exchange("test-code", verifier, nonce);
    expect(result).toEqual({
      ...previous,
      accessToken: "test-access",
      refreshToken: "test-refresh",
      accessExpiresAt: stamp + 300000,
    });
    expect(result).not.toHaveProperty("email");
    expect(result).not.toHaveProperty("organizations");
    const exchange = requests[0];
    expect(exchange?.form.get("client_id")).toBeNull();
    expect(exchange?.form.get("client_secret")).toBeNull();
    expect(Object.fromEntries(exchange?.form ?? [])).toEqual({
      grant_type: "authorization_code",
      code: "test-code",
      redirect_uri: `${config.publicOrigin}/auth/oidc/callback`,
      code_verifier: verifier,
    });
    const basic = atob((exchange?.headers.get("authorization") ?? "").slice(6));
    const [clientId, secret] = basic
      .split(":")
      .map((part) => new URLSearchParams(`v=${part}`).get("v"));
    expect([clientId, secret]).toEqual([config.clientId, config.clientSecret]);
    expect(requests[1]?.headers.has("authorization")).toBe(false);
    expect(requests.every((request) => request.redirect === "manual")).toBe(true);
  });

  test.each([
    ["issuer", { iss: "https://other.example.test" }],
    ["audience", { aud: "takosumi-hosted-staging-v1" }],
    ["audience array", { aud: [config.clientId] }],
    ["authorized party", { azp: "another-client" }],
    ["nonce", { nonce: "other-nonce" }],
    ["missing nonce", { nonce: undefined }],
    ["missing subject", { sub: undefined }],
    ["empty subject", { sub: "" }],
    ["missing session", { sid: undefined }],
    ["missing authentication time", { auth_time: undefined }],
    ["fractional authentication time", { auth_time: 1.2 }],
    ["future authentication time", { auth_time: stamp / 1000 + 31 }],
    ["expired", { exp: stamp / 1000 }],
    ["future issue time", { iat: stamp / 1000 + 31 }],
    ["long ID lifetime", { exp: stamp / 1000 + 301 }],
    ["invalid ordering", { exp: stamp / 1000 + 300, iat: stamp / 1000 + 300 }],
    ["product roles", { roles: ["owner"] }],
    ["product organization", { organizations: [{ id: "org-other", role: "owner" }] }],
    ["product workspace", { workspaceId: "workspace-other" }],
    ["Takosumi authority", { takosumi: { role: "owner" } }],
  ])("rejects %s in a cryptographically valid ID token", async (_name, claims) => {
    const { client } = await fixture({ claims });
    await expect(client.exchange("test-code", verifier, nonce)).rejects.toMatchObject({
      code: "oidc_invalid",
    });
  });

  test.each([
    ["unsigned", { alg: "none" }],
    ["other algorithm", { alg: "RS256" }],
    ["missing type", { typ: undefined }],
    ["remote key", { jku: "https://other.example.test/keys" }],
    ["critical extension", { crit: ["example"] }],
    ["unknown key", { kid: "unknown" }],
  ])("rejects %s JOSE header", async (_name, header) => {
    const { client } = await fixture({ header });
    await expect(client.exchange("test-code", verifier, nonce)).rejects.toMatchObject({
      code: "oidc_invalid",
    });
  });

  test.each([
    ["duplicate kid", (key: Record<string, unknown>) => ({ keys: [key, key] })],
    ["private key", (key: Record<string, unknown>) => ({ keys: [{ ...key, d: "test-only" }] })],
    [
      "key operation",
      (key: Record<string, unknown>) => ({ keys: [{ ...key, key_ops: ["sign"] }] }),
    ],
    ["wrong curve", (key: Record<string, unknown>) => ({ keys: [{ ...key, crv: "P-384" }] })],
    ["encryption purpose", (key: Record<string, unknown>) => ({ keys: [{ ...key, use: "enc" }] })],
  ])("rejects %s JWKS", async (_name, jwks) => {
    const { client } = await fixture({ jwks });
    await expect(client.exchange("test-code", verifier, nonce)).rejects.toMatchObject({
      code: "oidc_invalid",
    });
  });

  test("rejects an ID token signed by a different key", async () => {
    const other = await fixture();
    const { client } = await fixture({
      tokens: () => ({
        id_token: other.token,
        token_type: "Bearer",
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 300,
        scope: "openid offline_access",
      }),
    });
    await expect(client.exchange("test-code", verifier, nonce)).rejects.toMatchObject({
      code: "oidc_invalid",
    });
  });

  test("rejects duplicate JWT claims instead of applying JSON last-wins", async () => {
    const other = await fixture();
    const duplicate = await sign(
      other.keys.privateKey,
      JSON.stringify({ alg: "ES256", typ: "JWT", kid: "stage-key" }),
      `{"iss":"wrong",${JSON.stringify(other.claims).slice(1)}`,
    );
    const { client } = await fixture({
      tokens: () => ({
        id_token: duplicate,
        token_type: "Bearer",
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 300,
        scope: "openid offline_access",
      }),
    });
    await expect(client.exchange("test-code", verifier, nonce)).rejects.toMatchObject({
      code: "oidc_invalid",
    });
  });

  test.each([
    ["Bearer type", { token_type: "bearer" }],
    ["missing refresh", { refresh_token: undefined }],
    ["zero expiry", { expires_in: 0 }],
    ["long expiry", { expires_in: 301 }],
    ["missing openid", { scope: "email offline_access" }],
    ["missing offline", { scope: "openid email" }],
    ["product scope", { scope: "openid offline_access organization:owner" }],
    ["duplicate scope", { scope: "openid offline_access openid" }],
  ])("rejects invalid token response %s", async (_name, changes) => {
    const { client } = await fixture({
      tokens: (token) => ({
        id_token: token,
        token_type: "Bearer",
        access_token: "test-access",
        refresh_token: "test-refresh",
        expires_in: 300,
        scope: "openid offline_access",
        ...changes,
      }),
    });
    await expect(client.exchange("test-code", verifier, nonce)).rejects.toMatchObject({
      code: "oidc_invalid",
    });
  });

  test("accepts rotating refresh with no new ID token and preserves original identity", async () => {
    const { client, requests } = await fixture({
      tokens: () => ({
        token_type: "Bearer",
        access_token: "new-access",
        refresh_token: "new-refresh",
        expires_in: 300,
        scope: "openid offline_access",
      }),
    });
    const value = await client.refresh(previous);
    expect(value).toEqual({
      ...previous,
      accessToken: "new-access",
      refreshToken: "new-refresh",
      accessExpiresAt: stamp + 300000,
    });
    expect(requests).toHaveLength(1);
    expect(Object.fromEntries(requests[0]?.form ?? [])).toEqual({
      grant_type: "refresh_token",
      refresh_token: previous.refreshToken,
    });
  });

  test.each([
    ["subject change", { sub: "account-other" }],
    ["session change", { sid: "session-other" }],
    ["authentication time change", { auth_time: stamp / 1000 - 1 }],
  ])("rejects refresh %s", async (_name, claims) => {
    const { client } = await fixture({ claims });
    await expect(client.refresh(previous)).rejects.toMatchObject({ code: "oidc_invalid" });
  });

  test("rejects a nonrotated refresh token", async () => {
    const { client } = await fixture({
      tokens: () => ({
        token_type: "Bearer",
        access_token: "new-access",
        refresh_token: previous.refreshToken,
        expires_in: 300,
        scope: "openid offline_access",
      }),
    });
    await expect(client.refresh(previous)).rejects.toMatchObject({ code: "oidc_invalid" });
  });

  test("checks activity and revokes both tokens through authenticated server HTTP", async () => {
    const { client, requests } = await fixture();
    expect(await client.active(previous)).toBe(true);
    await client.revoke(previous);
    expect(requests.map((item) => new URL(item.url).pathname)).toEqual([
      "/oauth/introspect",
      "/oauth/revoke",
      "/oauth/revoke",
    ]);
    expect(requests.every((item) => item.headers.get("authorization")?.startsWith("Basic "))).toBe(
      true,
    );
    expect(requests[1]?.form.get("token_type_hint")).toBe("refresh_token");
    expect(requests[2]?.form.get("token_type_hint")).toBe("access_token");
  });

  test("resolves the current canonical account with client-bound issuer UserInfo", async () => {
    const { client, requests } = await fixture({
      userinfo: {
        sub: previous.subject,
        aud: config.clientId,
        scope: "openid email offline_access",
        email: "legacy@example.test",
        email_verified: true,
        name: "Person",
      },
    });
    expect(await client.canonicalAccount(previous)).toEqual({ accountId: previous.subject });
    expect(requests[0]?.url).toBe(`${config.issuer}/oauth/userinfo`);
    expect(requests[0]?.method).toBe("GET");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${previous.accessToken}`);
    expect(requests[0]?.headers.get("authorization")).not.toContain(config.clientSecret);
  });

  test.each([
    { sub: "another-account" },
    { aud: "takosumi-hosted-staging-v1" },
    { aud: [config.clientId] },
    { scope: "openid email" },
    { scope: "openid offline_access organizations" },
    { role: "owner" },
    { workspaceId: "another-workspace" },
    { takosumi: { owner: true } },
  ])("rejects mismatched or product authority UserInfo %j", async (changes) => {
    const { client } = await fixture({
      userinfo: {
        sub: previous.subject,
        aud: config.clientId,
        scope: "openid offline_access",
        ...changes,
      },
    });
    await expect(client.canonicalAccount(previous)).rejects.toMatchObject({ code: "oidc_invalid" });
  });

  test("rejects disabled or merged-away account credentials without trying another account", async () => {
    const { client, requests } = await fixture({
      send: async () => Response.json({ error: "invalid_token" }, { status: 401 }),
    });
    await expect(client.canonicalAccount(previous)).rejects.toMatchObject({ code: "oidc_invalid" });
    expect(requests).toHaveLength(1);
  });

  test.each([
    { active: false },
    { active: "true" },
    { token_use: "session" },
    { client_id: "other" },
    { aud: [config.clientId] },
    { sub: "other" },
    { exp: stamp / 1000 },
    { scope: "openid offline_access org:owner" },
    { organizations: ["other"] },
    { takosumi: { owner: true } },
  ])("fails closed for inactive or mismatched introspection %j", async (changes) => {
    const { client } = await fixture({
      introspection: {
        active: true,
        token_use: "oauth_access",
        client_id: config.clientId,
        aud: config.clientId,
        sub: previous.subject,
        exp: stamp / 1000 + 300,
        scope: "openid offline_access",
        ...changes,
      },
    });
    expect(await client.active(previous)).toBe(false);
  });

  test("refuses cross-client grants before sending any request", async () => {
    const { client, requests } = await fixture();
    await expect(client.refresh({ ...previous, clientId: "other" })).rejects.toBeInstanceOf(
      SharedAuthOidcError,
    );
    await expect(
      client.active({ ...previous, issuer: "https://other.example.test" }),
    ).rejects.toBeInstanceOf(SharedAuthOidcError);
    expect(requests).toHaveLength(0);
  });

  test.each([
    "https://auth.takos.jp",
    "https://auth.takos.jp.",
    "https://app.takosumi.com",
    "https://console.takoserver.com",
    "http://auth.example.test",
    "https://auth.example.test/",
    "https://auth.example.test/path",
    "https://user@auth.example.test",
    "https://auth.example.test?query",
    "https://auth.example.test#hash",
  ])("refuses non-staging or inexact issuer %s", (issuer) => {
    expect(() => createSharedAuthOidcClient({ config: { ...config, issuer } })).toThrow(TypeError);
  });

  test("refuses production client, environment, public origin and same-origin composition", () => {
    for (const changes of [
      { environment: "production" },
      { clientId: "takoserver-console-production-v1" },
      { publicOrigin: "https://console.takoserver.com" },
      { publicOrigin: "https://console.takoserver.com." },
      { publicOrigin: config.issuer },
    ]) {
      expect(() =>
        createSharedAuthOidcClient({ config: { ...config, ...changes } as SharedAuthOidcConfig }),
      ).toThrow(TypeError);
    }
  });

  test("does not send malformed code, nonce or verifier", async () => {
    const { client, requests } = await fixture();
    await expect(client.exchange("", verifier, nonce)).rejects.toMatchObject({
      code: "oidc_invalid",
    });
    await expect(client.exchange("test-code", "short", nonce)).rejects.toMatchObject({
      code: "oidc_invalid",
    });
    await expect(client.authorizationUrl({ state: "", nonce, verifier })).rejects.toMatchObject({
      code: "oidc_invalid",
    });
    expect(requests).toHaveLength(0);
  });

  test.each([
    [
      "oversized body",
      () => new Response(" ".repeat(65537), { headers: { "content-type": "application/json" } }),
    ],
    [
      "duplicate members",
      () =>
        new Response('{"token_type":"Bearer","token_type":"Bearer"}', {
          headers: { "content-type": "application/json" },
        }),
    ],
    ["wrong media type", () => new Response("{}", { headers: { "content-type": "text/html" } })],
    [
      "invalid utf8",
      () =>
        new Response(new Uint8Array([0xff]), { headers: { "content-type": "application/json" } }),
    ],
    ["array body", () => Response.json([])],
    [
      "redirect",
      () =>
        new Response(null, { status: 302, headers: { location: "https://other.example.test" } }),
    ],
  ])("bounds and validates %s", async (_name, response) => {
    const { client } = await fixture({ send: async () => response() });
    await expect(client.exchange("test-code", verifier, nonce)).rejects.toMatchObject({
      code: "oidc_invalid",
    });
  });

  test("classifies transport failure without leaking diagnostics or credentials", async () => {
    const { client } = await fixture({
      send: async () => {
        throw new Error(`untrusted server message ${config.clientSecret}`);
      },
    });
    try {
      await client.exchange("test-code", verifier, nonce);
      throw new Error("expected rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(SharedAuthOidcError);
      expect(String(error)).toBe("SharedAuthOidcError: oidc_unavailable");
    }
  });

  test("bounds a response body that stalls after headers to five seconds", async () => {
    let cancelled = false;
    const { client } = await fixture({
      send: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        ),
    });
    const started = Date.now();
    await expect(client.exchange("test-code", verifier, nonce)).rejects.toMatchObject({
      code: "oidc_unavailable",
    });
    expect(cancelled).toBe(true);
    expect(Date.now() - started).toBeLessThan(6000);
  }, 7000);
});
