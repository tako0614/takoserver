import { describe, expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import {
  createSharedAuthSession,
  type SharedAuthPrincipalProjection,
  SharedAuthSessionError,
} from "../src/shared-auth-session.ts";
import {
  createSharedAuthSessionStore,
  type SharedAuthSessionStore,
} from "../src/shared-auth-session-store.ts";
import { createSharedAuthSessionStoreD1Fixture } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_ORGANIZATION,
  SESSION_TEST_PERSONAL,
} from "./helpers/shared-auth-session-issuer.ts";

const INITIAL_TIME = 1_800_000_000_000;
const LOCAL_PRINCIPAL = "retained-local-takoserver-principal-123";
const ATTEMPT_COOKIE = "__Host-takoserver_oidc_attempt";
const SESSION_COOKIE = "__Host-takoserver_shared_session";

function cookie(response: Response, name: string): string {
  const value = response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0] ?? "")
    .find((item) => item.startsWith(`${name}=`));
  if (!value || value === `${name}=`) throw new Error(`missing test cookie: ${name}`);
  return value;
}

async function fixture(
  options: {
    wrapStore?: (store: SharedAuthSessionStore) => SharedAuthSessionStore;
    send?: (request: Request, send: (request: Request) => Promise<Response>) => Promise<Response>;
  } = {},
) {
  const d1 = await createSharedAuthSessionStoreD1Fixture();
  let stamp = INITIAL_TIME;
  try {
    const issuer = await createSharedSessionTestIssuer(() => stamp);
    const principalInputs: Parameters<SharedAuthPrincipalProjection["resolve"]>[0][] = [];
    const pins: { workspaceId: string; workspaceRef: string; organizationId: string }[] = [];
    const control = {
      principalAccount: SESSION_TEST_ACCOUNT,
      principalId: LOCAL_PRINCIPAL,
      onPin: undefined as (() => Promise<void>) | undefined,
    };
    const runtime = createSharedAuthSession({
      config: SESSION_TEST_CONFIG,
      consoleOrigin: SESSION_TEST_CONSOLE,
      encryptionKey: new Uint8Array(32).fill(7),
      now: () => stamp,
      store: () => {
        const store = createSharedAuthSessionStore(d1.sql);
        return options.wrapStore ? options.wrapStore(store) : store;
      },
      fetch: async (request) =>
        options.send ? await options.send(request, issuer.send) : await issuer.send(request),
      principals: {
        async resolve(input) {
          principalInputs.push(input);
          return { accountId: control.principalAccount, principalId: control.principalId };
        },
      },
      organizations: {
        async pin(input) {
          pins.push(input);
          await control.onPin?.();
          return input;
        },
      },
    });
    async function request(path: string, init: RequestInit = {}): Promise<Response> {
      const response = await runtime.fetch(
        new Request(`${SESSION_TEST_CONFIG.publicOrigin}${path}`, init),
      );
      if (!response) throw new Error("unmounted test route");
      return response;
    }
    async function login() {
      const response = await request("/auth/oidc/login");
      const location = response.headers.get("location");
      if (response.status !== 303 || !location) throw new Error("test login did not start");
      const browserCookie = cookie(response, ATTEMPT_COOKIE);
      const callbackUrl = issuer.authorize(location);
      return { response, location: new URL(location), browserCookie, callbackUrl };
    }
    async function callback(input: { browserCookie: string; callbackUrl: string }) {
      const response = await runtime.fetch(
        new Request(input.callbackUrl, { headers: { cookie: input.browserCookie } }),
      );
      if (!response) throw new Error("unmounted test callback");
      return response;
    }
    async function signedIn() {
      const started = await login();
      const response = await callback(started);
      if (response.status !== 303)
        throw new Error(`test callback failed: ${response.status} ${await response.text()}`);
      const sessionCookie = cookie(response, SESSION_COOKIE);
      const digest = await bytesDigest(
        new TextEncoder().encode(sessionCookie.slice(`${SESSION_COOKIE}=`.length)),
      );
      return { ...started, response, sessionCookie, digest };
    }
    function sessionRequest(sessionCookie: string) {
      return new Request(`${SESSION_TEST_CONFIG.publicOrigin}/control/test-resource`, {
        headers: { cookie: sessionCookie, origin: SESSION_TEST_CONSOLE },
      });
    }
    return {
      d1,
      issuer,
      runtime,
      request,
      login,
      callback,
      signedIn,
      sessionRequest,
      principalInputs,
      pins,
      control,
      setTime(value: number) {
        stamp = value;
      },
      now: () => stamp,
      dispose: () => d1.runtime.dispose(),
    };
  } catch (error) {
    await d1.runtime.dispose();
    throw error;
  }
}

describe("staging shared session against native D1 and signed issuer HTTP", () => {
  test("API callback owns a host cookie and bootstraps a canonical personal Workspace before ACTIVE", async () => {
    const f = await fixture();
    try {
      let activeAtBootstrap: unknown;
      f.issuer.control.onBootstrap = async () => {
        activeAtBootstrap = await f.d1.sql.query("SELECT digest FROM shared_auth_sessions");
      };
      const started = await f.login();
      expect(started.response.headers.get("set-cookie")).toContain(
        "Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=300",
      );
      expect(started.response.headers.get("set-cookie")).not.toContain("Domain=");
      expect(started.location.searchParams.get("redirect_uri")).toBe(
        `${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/callback`,
      );
      expect(started.location.searchParams.get("scope")).toBe("openid email offline_access");
      expect(started.location.searchParams.get("state")).toHaveLength(43);
      expect(started.location.searchParams.get("nonce")).toHaveLength(43);
      expect(started.location.searchParams.get("code_challenge")).toHaveLength(43);
      expect(started.location.searchParams.get("code_challenge_method")).toBe("S256");
      const attempts = await f.d1.sql.query("SELECT payload FROM shared_auth_attempts");
      expect(attempts).toHaveLength(1);
      expect(JSON.stringify(attempts)).not.toContain(started.location.searchParams.get("state"));
      expect(JSON.stringify(attempts)).not.toContain(started.location.searchParams.get("nonce"));

      const response = await f.callback(started);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${SESSION_TEST_CONSOLE}/`);
      expect(response.headers.get("location")).not.toContain("token");
      const sessionCookie = cookie(response, SESSION_COOKIE);
      const setCookies = response.headers.getSetCookie();
      expect(setCookies).toContain(
        `${ATTEMPT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
      expect(setCookies.find((item) => item.startsWith(SESSION_COOKIE))).toContain(
        "Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=604800",
      );
      expect(setCookies.join(";")).not.toContain("Domain=");
      expect(activeAtBootstrap).toEqual([]);
      expect(await f.d1.sql.query("SELECT digest FROM shared_auth_attempts")).toEqual([]);
      const sessions = await f.d1.sql.query(
        "SELECT account_id, principal_id, workspace_id, payload, status FROM shared_auth_sessions",
      );
      expect(sessions).toHaveLength(1);
      expect(sessions[0]).toMatchObject({
        account_id: SESSION_TEST_ACCOUNT,
        principal_id: LOCAL_PRINCIPAL,
        workspace_id: SESSION_TEST_PERSONAL.id,
        status: "active",
      });
      for (const issued of f.issuer.issued) {
        expect(JSON.stringify(sessions)).not.toContain(issued.accessToken);
        expect(JSON.stringify(sessions)).not.toContain(issued.refreshToken);
        expect(setCookies.join(";")).not.toContain(issued.accessToken);
      }
      const context = await f.runtime.authenticate(f.sessionRequest(sessionCookie));
      expect(context).toEqual({
        actor: {
          hostPrincipalId: LOCAL_PRINCIPAL,
          principalId: LOCAL_PRINCIPAL,
          kind: "session",
          scopes: [],
        },
        accountId: SESSION_TEST_ACCOUNT,
        workspace: SESSION_TEST_PERSONAL,
        provenance: {
          kind: "shared-account-session",
          issuer: SESSION_TEST_CONFIG.issuer,
          clientId: SESSION_TEST_CONFIG.clientId,
          subject: SESSION_TEST_ACCOUNT,
          sessionId: f.issuer.sessionId,
          authTime: f.issuer.authTime,
        },
      });
      expect(f.principalInputs[0]).toEqual({
        issuer: SESSION_TEST_CONFIG.issuer,
        clientId: SESSION_TEST_CONFIG.clientId,
        subject: SESSION_TEST_ACCOUNT,
        sessionId: f.issuer.sessionId,
        authTime: f.issuer.authTime,
        accountId: SESSION_TEST_ACCOUNT,
        workspaceId: SESSION_TEST_PERSONAL.id,
      });
      expect(JSON.stringify(f.principalInputs)).not.toContain(f.issuer.control.email);
      const directory = f.issuer.requests.filter((r) =>
        r.url.pathname.startsWith("/api/v1/account/shared-workspaces"),
      );
      expect(directory[0]?.url.pathname).toEndWith("/bootstrap");
      expect(directory[0]?.method).toBe("POST");
      expect(directory[0]?.body).toBe("{}");
      expect(directory[1]?.url.searchParams.get("selectedWorkspaceId")).toBe(
        SESSION_TEST_PERSONAL.id,
      );
      for (const request of directory) {
        expect(request.headers.get("authorization")).toBe(
          `Bearer ${f.issuer.issued[0]?.accessToken}`,
        );
        expect(request.headers.has("cookie")).toBe(false);
        expect(request.redirect).toBe("manual");
      }
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("Console session confirmation uses exact credentialed CORS and logout requires its Origin", async () => {
    const f = await fixture();
    try {
      const signedIn = await f.signedIn();
      const confirmed = await f.request("/auth/oidc/session", {
        headers: { cookie: signedIn.sessionCookie, origin: SESSION_TEST_CONSOLE },
      });
      expect(confirmed.status).toBe(200);
      expect(await confirmed.json()).toEqual({ authenticated: true });
      expect(confirmed.headers.get("access-control-allow-origin")).toBe(SESSION_TEST_CONSOLE);
      expect(confirmed.headers.get("access-control-allow-credentials")).toBe("true");
      expect(confirmed.headers.get("cache-control")).toBe("private, no-store");
      const preflight = await f.request("/auth/oidc/logout", {
        method: "OPTIONS",
        headers: {
          origin: SESSION_TEST_CONSOLE,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type",
        },
      });
      expect(preflight.status).toBe(204);
      for (const origin of [
        undefined,
        "https://untrusted.example.test",
        SESSION_TEST_CONFIG.publicOrigin,
      ]) {
        const headers = new Headers({ cookie: signedIn.sessionCookie });
        if (origin) headers.set("origin", origin);
        const response = await f.request("/auth/oidc/logout", { method: "POST", headers });
        expect(response.status).toBe(400);
        expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("active");
        expect(response.headers.has("set-cookie")).toBe(false);
      }
      const foreign = await f.request("/auth/oidc/session", {
        headers: { cookie: signedIn.sessionCookie, origin: "https://untrusted.example.test" },
      });
      expect(foreign.status).toBe(400);
      expect(foreign.headers.has("access-control-allow-origin")).toBe(false);
      const withBearer = await f.request("/auth/oidc/session", {
        headers: { cookie: signedIn.sessionCookie, authorization: "Bearer browser-value" },
      });
      expect(withBearer.status).toBe(400);
      expect(
        await f.runtime.fetch(new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/legacy`)),
      ).toBeNull();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("callback is browser-bound and a state mismatch burns the attempt before any exchange", async () => {
    const f = await fixture();
    try {
      const started = await f.login();
      const stranger = await f.callback({
        ...started,
        browserCookie: `${ATTEMPT_COOKIE}=${"x".repeat(43)}`,
      });
      expect(stranger.status).toBe(400);
      expect(await f.d1.sql.query("SELECT digest FROM shared_auth_attempts")).toHaveLength(1);
      const wrongState = new URL(started.callbackUrl);
      wrongState.searchParams.set("state", "wrong-state");
      expect((await f.callback({ ...started, callbackUrl: wrongState.toString() })).status).toBe(
        400,
      );
      expect(await f.d1.sql.query("SELECT digest FROM shared_auth_attempts")).toEqual([]);
      expect((await f.callback(started)).status).toBe(400);
      expect(f.issuer.requests.some((r) => r.url.pathname === "/oauth/token")).toBe(false);
      const next = await f.signedIn();
      expect((await f.callback(next)).status).toBe(400);
      expect(f.issuer.issued).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("a failed canonical bootstrap retains the acquired grant for revocation and creates no session", async () => {
    const f = await fixture();
    try {
      f.issuer.control.bootstrapEnabled = false;
      const started = await f.login();
      const response = await f.callback(started);
      expect(response.status).toBe(403);
      expect(response.headers.getSetCookie().some((item) => item.startsWith(SESSION_COOKIE))).toBe(
        false,
      );
      expect(await f.d1.sql.query("SELECT digest FROM shared_auth_sessions")).toEqual([]);
      expect(await f.d1.store.listPendingRevocations(f.now(), 2)).toHaveLength(1);
      expect(await f.runtime.retryRevocations()).toEqual({ completed: 1, pending: 0 });
      const acquired = f.issuer.issued[0];
      if (!acquired) throw new Error("missing acquired synthetic grant");
      expect([...f.issuer.revoked].sort()).toEqual(
        [acquired.accessToken, acquired.refreshToken].sort(),
      );
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("live membership removal refuses retained owner records on every request", async () => {
    const f = await fixture();
    try {
      const signedIn = await f.signedIn();
      expect(
        (await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie)))?.workspace.owner,
      ).toBe(true);
      f.issuer.control.member = false;
      await expect(
        f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie)),
      ).rejects.toMatchObject({
        code: "workspace_forbidden",
      });
      expect(f.principalInputs).toHaveLength(2);
      expect(
        f.issuer.requests.filter((r) => r.url.pathname === "/api/v1/account/shared-workspaces"),
      ).toHaveLength(3);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test.each(["disabled", "canonical-account-changed", "principal-conflict"])(
    "%s cannot keep a local session or relink through the same verified email",
    async (scenario) => {
      const f = await fixture();
      try {
        const signedIn = await f.signedIn();
        if (scenario === "disabled") f.issuer.control.userinfoEnabled = false;
        if (scenario === "canonical-account-changed")
          f.issuer.control.userinfoAccount = "another-canonical-account";
        if (scenario === "principal-conflict")
          f.control.principalAccount = "another-canonical-account";
        expect(await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie))).toBeNull();
        expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("revocation_pending");
        expect(await f.d1.store.listPendingRevocations(f.now(), 2)).toHaveLength(1);
        expect(f.issuer.issued).toHaveLength(1);
        expect(JSON.stringify(f.principalInputs)).not.toContain(f.issuer.control.email);
        expect(await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie))).toBeNull();
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  test("concurrent stale requests perform one rotating refresh and a loser cannot authorize while CHECKING", async () => {
    const f = await fixture();
    try {
      const signedIn = await f.signedIn();
      f.setTime(INITIAL_TIME + 280_000);
      let release: () => void = () => {};
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      let observed: () => void = () => {};
      const refreshing = new Promise<void>((resolve) => {
        observed = resolve;
      });
      f.issuer.control.onRefresh = async () => {
        observed();
        await blocked;
      };
      const winning = f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie));
      await refreshing;
      try {
        await expect(
          f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie)),
        ).rejects.toBeInstanceOf(SharedAuthSessionError);
        expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("checking");
      } finally {
        release();
      }
      expect((await winning)?.accountId).toBe(SESSION_TEST_ACCOUNT);
      expect(
        f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token"),
      ).toHaveLength(1);
      expect(f.issuer.issued).toHaveLength(2);
      expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("active");
      expect(await f.d1.store.listPendingRevocations(f.now(), 2)).toEqual([]);
      expect(
        (await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie)))?.accountId,
      ).toBe(SESSION_TEST_ACCOUNT);
      expect(
        f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token"),
      ).toHaveLength(1);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test.each(["before-commit", "after-commit"])(
    "unknown completion ACK %s retains the fresh rotated grant and never retries refresh/completion",
    async (failure) => {
      let completions = 0;
      const f = await fixture({
        wrapStore: (store) => ({
          ...store,
          async completeSession(digest, version, update) {
            completions += 1;
            if (failure === "after-commit") await store.completeSession(digest, version, update);
            throw new Error("synthetic lost durable acknowledgement");
          },
        }),
      });
      try {
        const signedIn = await f.signedIn();
        f.setTime(INITIAL_TIME + 280_000);
        await expect(
          f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie)),
        ).rejects.toThrow();
        expect(completions).toBe(1);
        expect(
          f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token"),
        ).toHaveLength(1);
        expect(f.issuer.issued).toHaveLength(2);
        expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("revocation_pending");
        expect(await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie))).toBeNull();
        const pending = await f.d1.store.listPendingRevocations(f.now(), 2);
        expect(pending.length).toBeGreaterThanOrEqual(1);
        expect(JSON.stringify(pending)).not.toContain(f.issuer.issued[1]?.refreshToken);
        await f.runtime.retryRevocations(2);
        await f.runtime.retryRevocations(2);
        const rotated = f.issuer.issued[1];
        if (!rotated) throw new Error("missing rotated synthetic grant");
        expect(f.issuer.revoked).toContain(rotated.accessToken);
        expect(f.issuer.revoked).toContain(rotated.refreshToken);
        expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("revoked");
        expect(completions).toBe(1);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  test("unknown committed claim ACK stays CHECKING without refresh replay and explicit logout recovers custody", async () => {
    let claims = 0;
    const f = await fixture({
      wrapStore: (store) => ({
        ...store,
        async claimSession(digest, version, now) {
          claims += 1;
          await store.claimSession(digest, version, now);
          throw new Error("synthetic lost claim acknowledgement");
        },
      }),
    });
    try {
      const signedIn = await f.signedIn();
      f.setTime(INITIAL_TIME + 280_000);
      await expect(
        f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie)),
      ).rejects.toThrow();
      expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("checking");
      const confirmation = await f.request("/auth/oidc/session", {
        headers: { cookie: signedIn.sessionCookie, origin: SESSION_TEST_CONSOLE },
      });
      expect(confirmation.status).toBe(503);
      expect(await confirmation.json()).toEqual({ error: { code: "session_unavailable" } });
      expect(claims).toBe(1);
      expect(f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token")).toEqual(
        [],
      );
      expect(
        (
          await f.request("/auth/oidc/logout", {
            method: "POST",
            headers: { cookie: signedIn.sessionCookie, origin: SESSION_TEST_CONSOLE },
          })
        ).status,
      ).toBe(204);
      expect(await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie))).toBeNull();
      expect(await f.runtime.retryRevocations()).toEqual({ completed: 1, pending: 0 });
      expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("revoked");
      const acquired = f.issuer.issued[0];
      if (!acquired) throw new Error("missing acquired synthetic grant");
      expect(f.issuer.revoked).toContain(acquired.refreshToken);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("lost refresh response after issuer rotation retains old-handle revocation and never repeats refresh", async () => {
    const f = await fixture({
      async send(request, send) {
        const response = await send(request);
        if (
          new URL(request.url).pathname === "/oauth/token" &&
          new URLSearchParams(await request.clone().text()).get("grant_type") === "refresh_token"
        )
          throw new Error("synthetic response lost after issuer rotated");
        return response;
      },
    });
    try {
      const signedIn = await f.signedIn();
      f.setTime(INITIAL_TIME + 280_000);
      const response = await f.request("/auth/oidc/session", {
        headers: { cookie: signedIn.sessionCookie, origin: SESSION_TEST_CONSOLE },
      });
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: { code: "session_unavailable" } });
      expect(f.issuer.issued).toHaveLength(2);
      expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("revocation_pending");
      expect(await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie))).toBeNull();
      expect(
        f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token"),
      ).toHaveLength(1);
      await f.runtime.retryRevocations(2);
      const acquired = f.issuer.issued[0];
      if (!acquired) throw new Error("missing acquired synthetic grant");
      // This proves the RP sends the old handle for recovery. Current-family
      // revocation by a spent handle is an issuer-owned contract/test proof.
      expect(f.issuer.revoked).toContain(acquired.refreshToken);
      expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("revoked");
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("logout denies locally before unavailable issuer revocation and maintenance survives a restart", async () => {
    const f = await fixture();
    try {
      const signedIn = await f.signedIn();
      f.issuer.control.revocationAvailable = false;
      const response = await f.request("/auth/oidc/logout", {
        method: "POST",
        headers: { cookie: signedIn.sessionCookie, origin: SESSION_TEST_CONSOLE },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("set-cookie")).toBe(
        `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
      expect(f.issuer.requests.filter((r) => r.url.pathname === "/oauth/revoke")).toEqual([]);
      expect(await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie))).toBeNull();
      expect(await f.runtime.retryRevocations()).toEqual({ completed: 0, pending: 1 });
      expect(
        (await createSharedAuthSessionStore(f.d1.sql).readSession(signedIn.digest))?.status,
      ).toBe("revocation_pending");
      expect(await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie))).toBeNull();
      f.issuer.control.revocationAvailable = true;
      f.setTime(f.now() + 30_000);
      expect(await f.runtime.retryRevocations()).toEqual({ completed: 1, pending: 0 });
      const acquired = f.issuer.issued[0];
      if (!acquired) throw new Error("missing acquired synthetic grant");
      expect([...f.issuer.revoked].sort()).toEqual(
        [acquired.accessToken, acquired.refreshToken].sort(),
      );
      expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("revoked");
      expect(await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie))).toBeNull();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test.each(["before-commit", "after-commit"])(
    "unknown callback creation ACK %s preserves orphan grant custody and returns no usable cookie",
    async (failure) => {
      let creations = 0;
      const f = await fixture({
        wrapStore: (store) => ({
          ...store,
          async createSession(record) {
            creations += 1;
            if (failure === "after-commit") await store.createSession(record);
            throw new Error("synthetic lost callback acknowledgement");
          },
        }),
      });
      try {
        const started = await f.login();
        const response = await f.callback(started);
        expect(response.status).toBe(503);
        expect(
          response.headers.getSetCookie().some((item) => item.startsWith(SESSION_COOKIE)),
        ).toBe(false);
        expect(creations).toBe(1);
        expect((await f.callback(started)).status).toBe(400);
        expect(f.issuer.issued).toHaveLength(1);
        const rows = await f.d1.sql.query("SELECT status FROM shared_auth_sessions");
        expect(rows).toEqual(failure === "after-commit" ? [{ status: "revocation_pending" }] : []);
        expect((await f.d1.store.listPendingRevocations(f.now(), 2)).length).toBeGreaterThanOrEqual(
          1,
        );
        await f.runtime.retryRevocations(2);
        await f.runtime.retryRevocations(2);
        const issued = f.issuer.issued[0];
        if (!issued) throw new Error("missing acquired synthetic grant");
        expect(f.issuer.revoked).toContain(issued.accessToken);
        expect(f.issuer.revoked).toContain(issued.refreshToken);
        expect(await f.d1.store.listPendingRevocations(f.now(), 2)).toEqual([]);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  test("encrypted grant custody binds the browser session digest and refuses ciphertext transplant", async () => {
    const f = await fixture();
    try {
      const first = await f.signedIn();
      const second = await f.signedIn();
      const secondRow = await f.d1.store.readSession(second.digest);
      if (!secondRow) throw new Error("missing second test session");
      await f.d1.sql.run("UPDATE shared_auth_sessions SET payload = ? WHERE digest = ?", [
        secondRow.payload,
        first.digest,
      ]);
      const requestsBefore = f.issuer.requests.length;
      expect(await f.runtime.authenticate(f.sessionRequest(first.sessionCookie))).toBeNull();
      expect(f.issuer.requests).toHaveLength(requestsBefore);
      expect((await f.d1.store.readSession(first.digest))?.status).toBe("revocation_pending");
      expect(
        (await f.runtime.authenticate(f.sessionRequest(second.sessionCookie)))?.accountId,
      ).toBe(SESSION_TEST_ACCOUNT);
      expect((await f.d1.store.readSession(second.digest))?.status).toBe("active");
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("shared Workspace billing tuple is pinned only after current membership and checked again after await", async () => {
    const f = await fixture();
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.workspaceOrganization(
        f.sessionRequest(signedIn.sessionCookie),
        SESSION_TEST_ORGANIZATION.id,
      );
      expect(context).toMatchObject({
        accountId: SESSION_TEST_ACCOUNT,
        workspace: SESSION_TEST_ORGANIZATION,
        actor: { scopes: [], principalId: LOCAL_PRINCIPAL },
        workspaceId: SESSION_TEST_ORGANIZATION.id,
        workspaceRef: "immutable-shared-workspace-ref-456",
        organizationId: "retained-takoserver-organization-789",
      });
      expect(f.pins).toHaveLength(1);
      f.control.onPin = async () => {
        f.issuer.control.member = false;
      };
      await expect(
        f.runtime.workspaceOrganization(
          f.sessionRequest(signedIn.sessionCookie),
          SESSION_TEST_ORGANIZATION.id,
        ),
      ).rejects.toMatchObject({ code: "workspace_forbidden" });
      expect(f.pins).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("idle and absolute lifetime expire independently of rotating access tokens", async () => {
    const f = await fixture();
    try {
      const idle = await f.signedIn();
      f.setTime(INITIAL_TIME + 12 * 60 * 60 * 1000);
      expect(await f.runtime.authenticate(f.sessionRequest(idle.sessionCookie))).toBeNull();
      expect((await f.d1.store.readSession(idle.digest))?.status).toBe("revocation_pending");
      const absolute = await f.signedIn();
      const expiresAt = (await f.d1.store.readSession(absolute.digest))?.absoluteExpiresAt;
      if (!expiresAt) throw new Error("missing test session deadline");
      f.setTime(expiresAt - 1);
      await f.d1.sql.run("UPDATE shared_auth_sessions SET last_used_at = ? WHERE digest = ?", [
        f.now(),
        absolute.digest,
      ]);
      f.setTime(expiresAt);
      expect(await f.runtime.authenticate(f.sessionRequest(absolute.sessionCookie))).toBeNull();
      expect((await f.d1.store.readSession(absolute.digest))?.status).toBe("revocation_pending");
      expect(f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token")).toEqual(
        [],
      );
    } finally {
      await f.dispose();
    }
  }, 30_000);
});
