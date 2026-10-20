import { base64UrlEncode } from "../../src/json.ts";
import type { SharedAuthOidcConfig } from "../../src/shared-auth-oidc-client.ts";
import type { SharedWorkspaceChoice } from "../../src/shared-auth-session.ts";

export const SESSION_TEST_CONFIG: SharedAuthOidcConfig = {
  environment: "staging",
  issuer: "https://auth-staging.takos.jp",
  publicOrigin:
    "https://integration-money-8732b77a789fd563406269261bf09e71.shoutatomiyama0614.workers.dev",
  clientId: "takoserver-console-staging-v1",
  clientSecret: "synthetic-test-only:client+credential",
};
export const SESSION_TEST_CONSOLE =
  "https://takoserver-console-integration.shoutatomiyama0614.workers.dev";
export const SESSION_TEST_ACCOUNT = "canonical-account-123";
export const SESSION_TEST_PERSONAL: SharedWorkspaceChoice = {
  id: "personal-workspace-123",
  handle: "personal-123",
  displayName: "Personal Workspace",
  type: "personal",
  roles: ["owner"],
  owner: true,
};
export const SESSION_TEST_PERSONAL_ORGANIZATION = Object.freeze({
  workspaceId: SESSION_TEST_PERSONAL.id,
  workspaceRef: "immutable-personal-workspace-ref-123",
  organizationId: "retained-takoserver-personal-organization-123",
});
export const SESSION_TEST_ORGANIZATION: SharedWorkspaceChoice = {
  id: "organization-workspace-456",
  handle: "organization-456",
  displayName: "Organization Workspace",
  type: "organization",
  roles: ["member"],
  owner: false,
};

/** Synthetic HTTP issuer with real signatures, PKCE and single-use refreshes. */
export async function createSharedSessionTestIssuer(now: () => number) {
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const publicKey = {
    ...(await crypto.subtle.exportKey("jwk", keys.publicKey)),
    alg: "ES256",
    kid: "session-test-key",
    use: "sig",
  };
  const sessionId = "accounts-session-123";
  const authTime = Math.floor(now() / 1000) - 60;
  const codes = new Map<string, { nonce: string; challenge: string }>();
  const accesses = new Map<string, { expiresAt: number; active: boolean }>();
  const refreshes = new Map<string, boolean>();
  let sequence = 0;
  const control = {
    userinfoAccount: SESSION_TEST_ACCOUNT,
    userinfoEnabled: true,
    introspectionEnabled: true,
    bootstrapEnabled: true,
    bootstrapOwner: SESSION_TEST_ACCOUNT,
    member: true,
    revocationAvailable: true,
    email: "untrusted-existing-customer@example.test",
    onRefresh: undefined as (() => Promise<void>) | undefined,
    onBootstrap: undefined as (() => Promise<void>) | undefined,
    personalBillingOrganization: undefined as Record<string, unknown> | undefined,
    onPersonalBillingOrganization: undefined as (() => Promise<void>) | undefined,
  };
  const requests: {
    url: URL;
    method: string;
    headers: Headers;
    body: string;
    form: URLSearchParams;
    redirect: RequestRedirect;
  }[] = [];
  const issued: { accessToken: string; refreshToken: string }[] = [];
  const revoked: string[] = [];

  async function token(nonce?: string) {
    sequence += 1;
    const accessToken = `synthetic-access-${sequence}`;
    const refreshToken = `synthetic-refresh-${sequence}`;
    accesses.set(accessToken, { expiresAt: now() + 300_000, active: true });
    refreshes.set(refreshToken, true);
    issued.push({ accessToken, refreshToken });
    let idToken: string | undefined;
    if (nonce) {
      const header = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({ alg: "ES256", typ: "JWT", kid: "session-test-key" }),
        ),
      );
      const claims = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            iss: SESSION_TEST_CONFIG.issuer,
            aud: SESSION_TEST_CONFIG.clientId,
            sub: SESSION_TEST_ACCOUNT,
            sid: sessionId,
            auth_time: authTime,
            iat: Math.floor(now() / 1000),
            exp: Math.floor(now() / 1000) + 300,
            nonce,
          }),
        ),
      );
      const signingInput = `${header}.${claims}`;
      const signature = await crypto.subtle.sign(
        { name: "ECDSA", hash: "SHA-256" },
        keys.privateKey,
        new TextEncoder().encode(signingInput),
      );
      idToken = `${signingInput}.${base64UrlEncode(signature)}`;
    }
    return {
      ...(idToken ? { id_token: idToken } : {}),
      token_type: "Bearer",
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: 300,
      scope: "openid email offline_access",
    };
  }

  function active(access: string) {
    const value = accesses.get(access);
    return value?.active === true && value.expiresAt > now();
  }
  function denied() {
    return Response.json({ error: "invalid_token" }, { status: 401 });
  }

  return {
    control,
    requests,
    issued,
    revoked,
    sessionId,
    authTime,
    authorize(location: string | URL) {
      const url = new URL(location);
      if (
        url.origin !== SESSION_TEST_CONFIG.issuer ||
        url.pathname !== "/oauth/authorize" ||
        url.searchParams.get("client_id") !== SESSION_TEST_CONFIG.clientId ||
        url.searchParams.get("redirect_uri") !==
          `${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/callback` ||
        url.searchParams.get("code_challenge_method") !== "S256"
      )
        throw new Error("unexpected synthetic authorization request");
      const nonce = url.searchParams.get("nonce"),
        challenge = url.searchParams.get("code_challenge"),
        state = url.searchParams.get("state");
      if (!nonce || !challenge || !state) throw new Error("missing authorization binding");
      const code = `synthetic-code-${crypto.randomUUID()}`;
      codes.set(code, { nonce, challenge });
      return `${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/callback?${new URLSearchParams({ code, state, iss: SESSION_TEST_CONFIG.issuer })}`;
    },
    async send(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const body = request.method === "POST" ? await request.clone().text() : "";
      const form = new URLSearchParams(body);
      requests.push({
        url,
        method: request.method,
        headers: new Headers(request.headers),
        body,
        form,
        redirect: request.redirect,
      });
      if (url.origin !== SESSION_TEST_CONFIG.issuer) throw new Error("foreign issuer origin");
      if (url.pathname === "/oauth/jwks") return Response.json({ keys: [publicKey] });
      const auth = request.headers.get("authorization");
      const fields = new URLSearchParams({
        id: SESSION_TEST_CONFIG.clientId,
        secret: SESSION_TEST_CONFIG.clientSecret,
      })
        .toString()
        .split("&")
        .map((part) => part.slice(part.indexOf("=") + 1));
      const expectedBasic = `Basic ${btoa(`${fields[0]}:${fields[1]}`)}`;
      if (["/oauth/token", "/oauth/introspect", "/oauth/revoke"].includes(url.pathname)) {
        if (auth !== expectedBasic) throw new Error("unauthenticated synthetic client");
      }
      if (url.pathname === "/oauth/token") {
        if (form.get("grant_type") === "authorization_code") {
          const code = form.get("code") ?? "";
          const authorization = codes.get(code);
          codes.delete(code);
          const challenge = base64UrlEncode(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode(form.get("code_verifier") ?? ""),
            ),
          );
          if (
            !authorization ||
            authorization.challenge !== challenge ||
            form.get("redirect_uri") !== `${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/callback`
          )
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          return Response.json(await token(authorization.nonce));
        }
        if (form.get("grant_type") === "refresh_token") {
          const refresh = form.get("refresh_token") ?? "";
          if (refreshes.get(refresh) !== true)
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          refreshes.set(refresh, false);
          await control.onRefresh?.();
          return Response.json(await token());
        }
        throw new Error("unknown synthetic grant type");
      }
      if (url.pathname === "/oauth/introspect") {
        const access = form.get("token") ?? "";
        if (!active(access) || !control.introspectionEnabled)
          return Response.json({ active: false });
        return Response.json({
          active: true,
          token_use: "oauth_access",
          client_id: SESSION_TEST_CONFIG.clientId,
          aud: SESSION_TEST_CONFIG.clientId,
          sub: SESSION_TEST_ACCOUNT,
          exp: Math.floor((accesses.get(access)?.expiresAt ?? 0) / 1000),
          scope: "openid email offline_access",
        });
      }
      if (url.pathname === "/oauth/revoke") {
        if (!control.revocationAvailable)
          return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
        const value = form.get("token") ?? "";
        revoked.push(value);
        const access = accesses.get(value);
        if (access) access.active = false;
        if (refreshes.has(value)) refreshes.set(value, false);
        return new Response(null, { status: 200 });
      }
      const access = auth?.startsWith("Bearer ") ? auth.slice(7) : "";
      if (!active(access)) return denied();
      if (url.pathname === "/oauth/userinfo") {
        if (!control.userinfoEnabled) return denied();
        return Response.json({
          sub: control.userinfoAccount,
          aud: SESSION_TEST_CONFIG.clientId,
          scope: "openid email offline_access",
          email: control.email,
          email_verified: true,
        });
      }
      if (url.pathname === "/api/v1/account/shared-workspaces/bootstrap") {
        await control.onBootstrap?.();
        if (!control.bootstrapEnabled)
          return Response.json({ error: "workspace_suspended" }, { status: 403 });
        return Response.json({
          workspace: {
            ...SESSION_TEST_PERSONAL,
            ownerUserId: control.bootstrapOwner,
            createdAt: now(),
            updatedAt: now(),
          },
        });
      }
      if (url.pathname === "/api/v1/account/shared-workspaces") {
        if (!control.member)
          return Response.json({ error: "workspace_forbidden" }, { status: 403 });
        const selected =
          url.searchParams.get("selectedWorkspaceId") === SESSION_TEST_PERSONAL.id
            ? SESSION_TEST_PERSONAL
            : url.searchParams.get("selectedWorkspaceId") === SESSION_TEST_ORGANIZATION.id
              ? SESSION_TEST_ORGANIZATION
              : null;
        if (!selected) return Response.json({ error: "workspace_forbidden" }, { status: 403 });
        return Response.json({
          accountId: SESSION_TEST_ACCOUNT,
          personalWorkspaceId: SESSION_TEST_PERSONAL.id,
          activeWorkspace: selected,
          choices: [selected],
          nextCursor: null,
        });
      }
      if (
        url.pathname ===
        `/api/v1/account/shared-workspaces/${SESSION_TEST_ORGANIZATION.id}/billing-organization`
      ) {
        if (!control.member)
          return Response.json({ error: "workspace_forbidden" }, { status: 403 });
        return Response.json({
          workspaceId: SESSION_TEST_ORGANIZATION.id,
          workspaceRef: "immutable-shared-workspace-ref-456",
          organizationId: "retained-takoserver-organization-789",
        });
      }
      if (
        url.pathname ===
        `/api/v1/account/shared-workspaces/${SESSION_TEST_PERSONAL.id}/billing-organization`
      ) {
        await control.onPersonalBillingOrganization?.();
        if (!control.member)
          return Response.json({ error: "workspace_forbidden" }, { status: 403 });
        if (!control.personalBillingOrganization)
          return Response.json({ error: "organization_unavailable" }, { status: 404 });
        return Response.json(control.personalBillingOrganization);
      }
      throw new Error(`unexpected synthetic issuer path: ${url.pathname}`);
    },
  };
}
