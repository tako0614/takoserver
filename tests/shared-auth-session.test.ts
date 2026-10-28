import { describe, expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import {
  createSharedAuthSession,
  type SharedAuthFinancialProofReceiver,
  type SharedAuthPrincipalProjection,
  SharedAuthSessionError,
} from "../src/shared-auth-session.ts";
import {
  createSharedAuthFinalSessionStore,
  createSharedAuthSessionStore,
  type OidcSessionRecord,
  type SharedAuthFinalSessionStore,
  type SharedAuthSessionStore,
} from "../src/shared-auth-session-store.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";
import { beginNativeFixturePhase } from "./helpers/native-fixture-phase.ts";
import { createSharedAuthSessionStoreD1Fixture } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_ORGANIZATION,
  SESSION_TEST_PERSONAL,
  SESSION_TEST_PERSONAL_ORGANIZATION,
} from "./helpers/shared-auth-session-issuer.ts";

const INITIAL_TIME = 1_800_000_000_000;
const LOCAL_PRINCIPAL = "retained-local-takoserver-principal-123";
const ATTEMPT_COOKIE = "__Host-takoserver_oidc_attempt";
const SESSION_COOKIE = "__Host-takoserver_shared_session";
const LEGACY_SESSION_COOKIE = "takoserver_session";

const pinnedOrigins = {
  issuer: SESSION_TEST_CONFIG.issuer,
  publicOrigin: SESSION_TEST_CONFIG.publicOrigin,
  consoleOrigin: SESSION_TEST_CONSOLE,
};
const rejectedOrigins = Object.entries(pinnedOrigins).flatMap(([field, origin]) => {
  const hostname = new URL(origin).hostname;
  return [
    [`${field} arbitrary alias`, { [field]: "https://stage-alias.example.test" }],
    [`${field} subdomain`, { [field]: `https://alias.${hostname}` }],
    [`${field} trailing dot`, { [field]: `https://${hostname}.` }],
    [`${field} explicit default port`, { [field]: `${origin}:443` }],
    [`${field} alternate port`, { [field]: `${origin}:8443` }],
    ...Object.values(pinnedOrigins)
      .filter((other) => other !== origin)
      .map((other) => [`${field} swapped to ${other}`, { [field]: other }]),
  ] as [string, Record<string, string>][];
});

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
    wrapFinalStore?: (store: SharedAuthFinalSessionStore) => SharedAuthFinalSessionStore;
    financialProof?: SharedAuthFinancialProofReceiver;
    send?: (request: Request, send: (request: Request) => Promise<Response>) => Promise<Response>;
  } = {},
) {
  const recordPhase = beginNativeFixturePhase("shared-auth");
  recordPhase("fixture_begin");
  recordPhase("d1_fixture_begin");
  const d1 = await createSharedAuthSessionStoreD1Fixture(recordPhase);
  recordPhase("d1_fixture_ready");
  let stamp = INITIAL_TIME;
  try {
    // This source targets the owner's adopted strict-driver ABI. It must be
    // integrated and genuinely verified in native D1 before these tests run.
    recordPhase("native_d1_begin");
    const database = await d1.runtime.getD1Database("AUTH_DB");
    recordPhase("native_d1_ready");
    d1.sql = createD1Sql(database.withSession("first-primary") as unknown as D1DatabaseLike, {
      acknowledgement: "explicit-d1-result",
    });
    d1.store = createSharedAuthSessionStore(d1.sql);
    const issuer = await createSharedSessionTestIssuer(() => stamp);
    recordPhase("issuer_ready");
    // The issuer helper has no personal billing Organization by default. This
    // fixture opts in to an explicit authenticated response for positive logins.
    issuer.control.personalBillingOrganization = SESSION_TEST_PERSONAL_ORGANIZATION;
    const principalInputs: Parameters<SharedAuthPrincipalProjection["resolve"]>[0][] = [];
    const pins: { workspaceId: string; workspaceRef: string; organizationId: string }[] = [];
    const control = {
      principalAccount: SESSION_TEST_ACCOUNT,
      principalId: LOCAL_PRINCIPAL,
      onPin: undefined as (() => Promise<void>) | undefined,
    };
    const composition: Parameters<typeof createSharedAuthSession>[0] = {
      config: SESSION_TEST_CONFIG,
      consoleOrigin: SESSION_TEST_CONSOLE,
      encryptionKey: new Uint8Array(32).fill(7),
      now: () => stamp,
      store: () => {
        const store = createSharedAuthSessionStore(d1.sql);
        return options.wrapStore ? options.wrapStore(store) : store;
      },
      finalStore: () => {
        const store = createSharedAuthFinalSessionStore(d1.sql);
        return options.wrapFinalStore ? options.wrapFinalStore(store) : store;
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
      ...(options.financialProof === undefined ? {} : { financialProof: options.financialProof }),
    };
    const runtime = createSharedAuthSession(composition);
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
      recordPhase("callback_begin");
      const response = await runtime.fetch(
        new Request(input.callbackUrl, { headers: { cookie: input.browserCookie } }),
      );
      recordPhase("callback_ready");
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
    recordPhase("fixture_ready");
    return {
      d1,
      issuer,
      runtime,
      composition,
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
      dispose: async () => {
        recordPhase("dispose_begin");
        await d1.runtime.dispose();
        recordPhase("dispose_ready");
      },
    };
  } catch (error) {
    await d1.runtime.dispose();
    throw error;
  }
}

describe("staging shared session against native D1 and signed issuer HTTP", () => {
  test.each(rejectedOrigins)(
    "refuses %s before network, store or principal side effects",
    (_name, changes) => {
      const calls = { fetch: 0, store: 0, principal: 0 };
      expect(() =>
        createSharedAuthSession({
          config: {
            ...SESSION_TEST_CONFIG,
            issuer: changes.issuer ?? SESSION_TEST_CONFIG.issuer,
            publicOrigin: changes.publicOrigin ?? SESSION_TEST_CONFIG.publicOrigin,
          },
          consoleOrigin: changes.consoleOrigin ?? SESSION_TEST_CONSOLE,
          encryptionKey: new Uint8Array(32).fill(7),
          store: () => {
            calls.store += 1;
            throw new Error("configuration reached store");
          },
          fetch: async () => {
            calls.fetch += 1;
            throw new Error("configuration reached network");
          },
          principals: {
            async resolve() {
              calls.principal += 1;
              throw new Error("configuration reached principal projection");
            },
          },
        }),
      ).toThrow(TypeError);
      expect(calls).toEqual({ fetch: 0, store: 0, principal: 0 });
    },
  );

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

      const response = await f.callback({
        ...started,
        browserCookie: `${started.browserCookie}; ${LEGACY_SESSION_COOKIE}=legacy_B`,
      });
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${SESSION_TEST_CONSOLE}/`);
      expect(response.headers.get("location")).not.toContain("token");
      const sessionCookie = cookie(response, SESSION_COOKIE);
      const setCookies = response.headers.getSetCookie();
      expect(setCookies).toContain(
        `${ATTEMPT_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      );
      expect(setCookies).toContain(
        `${LEGACY_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
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

  test("callback bootstrap transport failure emits closed records and keeps grant cleanup", async () => {
    const f = await fixture();
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      f.issuer.control.onBootstrap = async () => {
        throw new Error("private callback code, bearer token and SQL text must not be logged");
      };
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie().some((item) => item.startsWith(SESSION_COOKIE))).toBe(
        false,
      );
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.directory.bootstrap.failure.v1",
            reason: "transport",
            status: null,
          }),
        ],
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "bootstrap",
            class: "session",
            code: "session_unavailable",
          }),
        ],
      ]);
      expect((await f.d1.store.listPendingRevocations(f.now(), 2)).length).toBeGreaterThanOrEqual(
        1,
      );
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test("fresh callback bootstrap HTTP 503 emits one bounded Directory result", async () => {
    let bootstrapCalls = 0;
    const f = await fixture({
      send: async (request, send) => {
        if (new URL(request.url).pathname.endsWith("/shared-workspaces/bootstrap")) {
          bootstrapCalls += 1;
          return new Response("private upstream body", { status: 503 });
        }
        return await send(request);
      },
    });
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie().some((item) => item.startsWith(SESSION_COOKIE))).toBe(
        false,
      );
      expect(bootstrapCalls).toBe(1);
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.directory.bootstrap.failure.v1",
            reason: "http_non_ok",
            status: 503,
          }),
        ],
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "bootstrap",
            class: "session",
            code: "session_unavailable",
          }),
        ],
      ]);
      expect((await f.d1.store.listPendingRevocations(f.now(), 2)).length).toBeGreaterThanOrEqual(
        1,
      );
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test.each([400, 429, 530])(
    "fresh callback bootstrap HTTP %i retains the actual bounded status",
    async (status) => {
      const f = await fixture({
        send: async (request, send) =>
          new URL(request.url).pathname.endsWith("/shared-workspaces/bootstrap")
            ? new Response("private response body", { status })
            : await send(request),
      });
      const originalConsoleError = console.error;
      const emitted: unknown[][] = [];
      try {
        const started = await f.login();
        console.error = (...args: unknown[]) => {
          emitted.push(args);
        };
        const response = await f.callback(started);
        expect(response.status).toBe(503);
        expect(emitted).toEqual([
          [
            JSON.stringify({
              marker: "takoserver.shared_auth.directory.bootstrap.failure.v1",
              reason: "http_non_ok",
              status,
            }),
          ],
          [
            JSON.stringify({
              marker: "takoserver.shared_auth.callback.failure.v1",
              phase: "bootstrap",
              class: "session",
              code: "session_unavailable",
            }),
          ],
        ]);
      } finally {
        console.error = originalConsoleError;
        await f.dispose();
      }
    },
    30_000,
  );

  test("fresh callback bootstrap transport failure emits no exception text or HTTP status", async () => {
    const f = await fixture({
      send: async (request, send) => {
        if (new URL(request.url).pathname.endsWith("/shared-workspaces/bootstrap"))
          throw new Error("private bearer, callback code and SQL text");
        return await send(request);
      },
    });
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.directory.bootstrap.failure.v1",
            reason: "transport",
            status: null,
          }),
        ],
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "bootstrap",
            class: "session",
            code: "session_unavailable",
          }),
        ],
      ]);
      expect((await f.d1.store.listPendingRevocations(f.now(), 2)).length).toBeGreaterThanOrEqual(
        1,
      );
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test("a later Directory Workspace GET failure has no bootstrap request marker", async () => {
    const f = await fixture({
      send: async (request, send) => {
        const url = new URL(request.url);
        return url.pathname === "/api/v1/account/shared-workspaces" &&
          url.searchParams.has("selectedWorkspaceId")
          ? new Response(null, { status: 503 })
          : await send(request);
      },
    });
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "workspace",
            class: "session",
            code: "session_unavailable",
          }),
        ],
      ]);
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test.each([400, 429, 503, 530])(
    "fresh callback Organization GET HTTP %i reports its bounded failure without a session",
    async (status) => {
      const f = await fixture({
        send: async (request, send) =>
          new URL(request.url).pathname.endsWith(
            `/${SESSION_TEST_PERSONAL.id}/billing-organization`,
          )
            ? new Response("private Organization body", { status })
            : await send(request),
      });
      const originalConsoleError = console.error;
      const emitted: unknown[][] = [];
      try {
        const started = await f.login();
        console.error = (...args: unknown[]) => {
          emitted.push(args);
        };
        const response = await f.callback(started);
        expect(response.status).toBe(503);
        expect(emitted).toEqual([
          [
            JSON.stringify({
              marker: "takoserver.shared_auth.organization.failure.v1",
              reason: "http_non_ok",
              status,
            }),
          ],
          [
            JSON.stringify({
              marker: "takoserver.shared_auth.callback.failure.v1",
              phase: "organization",
              class: "session",
              code: "session_unavailable",
            }),
          ],
        ]);
        expect(await f.d1.sql.query("SELECT digest FROM shared_auth_sessions")).toEqual([]);
        expect(await f.d1.store.listPendingRevocations(f.now(), 2)).toHaveLength(1);
      } finally {
        console.error = originalConsoleError;
        await f.dispose();
      }
    },
    30_000,
  );

  test("fresh callback Organization transport failure reports no private exception text", async () => {
    const f = await fixture({
      send: async (request, send) => {
        if (
          new URL(request.url).pathname.endsWith(
            `/${SESSION_TEST_PERSONAL.id}/billing-organization`,
          )
        )
          throw new Error("private bearer token and Organization response must not appear");
        return await send(request);
      },
    });
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.organization.failure.v1",
            reason: "transport",
            status: null,
          }),
        ],
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "organization",
            class: "session",
            code: "session_unavailable",
          }),
        ],
      ]);
      expect(JSON.stringify(emitted)).not.toContain("private bearer token");
      expect(await f.d1.sql.query("SELECT digest FROM shared_auth_sessions")).toEqual([]);
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test("fresh callback Organization body deadline reports only after the GET rejects", async () => {
    let cancelled = false;
    const f = await fixture({
      send: async (request, send) => {
        if (
          !new URL(request.url).pathname.endsWith(
            `/${SESSION_TEST_PERSONAL.id}/billing-organization`,
          )
        )
          return await send(request);
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(cancelled).toBe(true);
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.organization.failure.v1",
            reason: "deadline",
            status: null,
          }),
        ],
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "organization",
            class: "session",
            code: "session_unavailable",
          }),
        ],
      ]);
      expect(await f.d1.sql.query("SELECT digest FROM shared_auth_sessions")).toEqual([]);
      expect(await f.d1.store.listPendingRevocations(f.now(), 2)).toHaveLength(1);
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test("fresh callback Organization post-GET source drift reports only its closed reason", async () => {
    const f = await fixture();
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      f.issuer.control.onPersonalBillingOrganization = async () => {
        f.composition.principals.resolve = async () => {
          throw new Error("mutable principal method must never replace the original");
        };
      };
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.organization.failure.v1",
            reason: "source_drift",
            status: null,
          }),
        ],
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "organization",
            class: "session",
            code: "session_unavailable",
          }),
        ],
      ]);
      expect(await f.d1.sql.query("SELECT digest FROM shared_auth_sessions")).toEqual([]);
      expect(await f.d1.store.listPendingRevocations(f.now(), 2)).toHaveLength(1);
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test.each([
    [401, 400, "session_invalid"],
    [403, 403, "workspace_forbidden"],
    [404, 403, "workspace_forbidden"],
  ] as const)(
    "fresh callback Organization GET HTTP %i preserves its non-unavailable classification",
    async (upstreamStatus, callbackStatus, code) => {
      const f = await fixture({
        send: async (request, send) =>
          new URL(request.url).pathname.endsWith(
            `/${SESSION_TEST_PERSONAL.id}/billing-organization`,
          )
            ? new Response(null, { status: upstreamStatus })
            : await send(request),
      });
      const originalConsoleError = console.error;
      const emitted: unknown[][] = [];
      try {
        const started = await f.login();
        console.error = (...args: unknown[]) => {
          emitted.push(args);
        };
        const response = await f.callback(started);
        expect(response.status).toBe(callbackStatus);
        expect(emitted).toEqual([
          [
            JSON.stringify({
              marker: "takoserver.shared_auth.callback.failure.v1",
              phase: "organization",
              class: "session",
              code,
            }),
          ],
        ]);
        expect(await f.d1.sql.query("SELECT digest FROM shared_auth_sessions")).toEqual([]);
      } finally {
        console.error = originalConsoleError;
        await f.dispose();
      }
    },
    30_000,
  );

  test("Organization diagnostic sink failure preserves the callback error and grant custody", async () => {
    const f = await fixture({
      send: async (request, send) =>
        new URL(request.url).pathname.endsWith(`/${SESSION_TEST_PERSONAL.id}/billing-organization`)
          ? new Response(null, { status: 503 })
          : await send(request),
    });
    const originalConsoleError = console.error;
    try {
      const started = await f.login();
      console.error = () => {
        throw new Error("private diagnostic sink failure");
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie().some((item) => item.startsWith(SESSION_COOKIE))).toBe(
        false,
      );
      expect(await f.d1.sql.query("SELECT digest FROM shared_auth_sessions")).toEqual([]);
      expect(await f.d1.store.listPendingRevocations(f.now(), 2)).toHaveLength(1);
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test("a diagnostic-only status accessor failure cannot replace the mapped bootstrap error", async () => {
    let statusReads = 0;
    const f = await fixture({
      send: async (request, send) => {
        if (!new URL(request.url).pathname.endsWith("/shared-workspaces/bootstrap"))
          return await send(request);
        const response = new Response(null, { status: 530 });
        Object.defineProperty(response, "status", {
          get() {
            statusReads += 1;
            if (statusReads > 3) throw new Error("private status accessor failed");
            return 530;
          },
        });
        return response;
      },
    });
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(statusReads).toBe(4);
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.directory.bootstrap.failure.v1",
            reason: "http_non_ok",
            status: null,
          }),
        ],
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "bootstrap",
            class: "session",
            code: "session_unavailable",
          }),
        ],
      ]);
      expect((await f.d1.store.listPendingRevocations(f.now(), 2)).length).toBeGreaterThanOrEqual(
        1,
      );
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test("a failing bootstrap diagnostic sink cannot change callback or grant cleanup", async () => {
    const f = await fixture({
      send: async (request, send) =>
        new URL(request.url).pathname.endsWith("/shared-workspaces/bootstrap")
          ? new Response(null, { status: 503 })
          : await send(request),
    });
    const originalConsoleError = console.error;
    try {
      const started = await f.login();
      console.error = () => {
        throw new Error("diagnostic sink unavailable");
      };
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(response.headers.getSetCookie().some((item) => item.startsWith(SESSION_COOKIE))).toBe(
        false,
      );
      expect((await f.d1.store.listPendingRevocations(f.now(), 2)).length).toBeGreaterThanOrEqual(
        1,
      );
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test("bootstrap body deadline emits once after the request actually rejects", async () => {
    let cancelled = false;
    const f = await fixture({
      send: async (request, send) => {
        if (!new URL(request.url).pathname.endsWith("/shared-workspaces/bootstrap"))
          return await send(request);
        return new Response(
          new ReadableStream<Uint8Array>({
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { "content-type": "application/json" } },
        );
      },
    });
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const beforeCallback = Date.now();
      const response = await f.callback(started);
      expect(response.status).toBe(503);
      expect(Date.now() - beforeCallback).toBeLessThan(6500);
      expect(cancelled).toBe(true);
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.directory.bootstrap.failure.v1",
            reason: "deadline",
            status: null,
          }),
        ],
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "bootstrap",
            class: "session",
            code: "session_unavailable",
          }),
        ],
      ]);
      expect((await f.d1.store.listPendingRevocations(f.now(), 2)).length).toBeGreaterThanOrEqual(
        1,
      );
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test("successful bootstrap never emits a late Directory failure after its timer window", async () => {
    const f = await fixture();
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const signedIn = await f.signedIn();
      expect(signedIn.response.status).toBe(303);
      await Bun.sleep(5100);
      expect(emitted).toEqual([]);
    } finally {
      console.error = originalConsoleError;
      await f.dispose();
    }
  }, 30_000);

  test.each(["captured", "emitter-throws"])(
    "callback creation ACK loss keeps cleanup when diagnostic %s",
    async (diagnostic) => {
      const privateFailure = {
        get name(): never {
          throw new Error("private name accessor");
        },
        get code(): never {
          throw new Error("private code accessor");
        },
        get message(): never {
          throw new Error("private message accessor");
        },
        get stack(): never {
          throw new Error("private stack accessor");
        },
      };
      const f = await fixture({
        wrapStore: (store) => ({
          ...store,
          async createSession(record) {
            await store.createSession(record);
            throw privateFailure;
          },
        }),
      });
      const originalConsoleError = console.error;
      const emitted: unknown[][] = [];
      try {
        const started = await f.login();
        console.error = (...args: unknown[]) => {
          if (diagnostic === "emitter-throws") throw new Error("diagnostic sink failed");
          emitted.push(args);
        };
        const response = await f.callback(started);
        expect(response.status).toBe(503);
        expect(
          response.headers.getSetCookie().some((item) => item.startsWith(SESSION_COOKIE)),
        ).toBe(false);
        expect(await f.d1.sql.query("SELECT status FROM shared_auth_sessions")).toEqual([
          { status: "revocation_pending" },
        ]);
        expect((await f.d1.store.listPendingRevocations(f.now(), 2)).length).toBeGreaterThanOrEqual(
          1,
        );
        expect(emitted).toEqual(
          diagnostic === "emitter-throws"
            ? []
            : [
                [
                  JSON.stringify({
                    marker: "takoserver.shared_auth.callback.failure.v1",
                    phase: "session_write",
                    class: "unknown",
                    code: "unknown",
                  }),
                ],
              ],
        );
      } finally {
        console.error = originalConsoleError;
        await f.dispose();
      }
    },
    30_000,
  );

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
    const originalConsoleError = console.error;
    const emitted: unknown[][] = [];
    try {
      f.issuer.control.bootstrapEnabled = false;
      const started = await f.login();
      console.error = (...args: unknown[]) => {
        emitted.push(args);
      };
      const response = await f.callback(started);
      expect(response.status).toBe(403);
      expect(emitted).toEqual([
        [
          JSON.stringify({
            marker: "takoserver.shared_auth.callback.failure.v1",
            phase: "bootstrap",
            class: "session",
            code: "workspace_forbidden",
          }),
        ],
      ]);
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
      console.error = originalConsoleError;
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

  test.each([
    "takoserver_session=legacy_B",
    "takoserver_session=",
    "takoserver_session=%not-a-credential",
    "takoserver_session",
  ])(
    "shared logout refuses a legacy-only named cookie %j without effects",
    async (legacy) => {
      let revocations = 0;
      const f = await fixture({
        wrapStore: (store) => ({
          ...store,
          async revokeSession(digest, stamp) {
            revocations += 1;
            return store.revokeSession(digest, stamp);
          },
        }),
      });
      try {
        const signedIn = await f.signedIn();
        const requestsBefore = f.issuer.requests.length;
        const response = await f.request("/auth/oidc/logout", {
          method: "POST",
          headers: { cookie: `unrelated=value; ${legacy}`, origin: SESSION_TEST_CONSOLE },
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: { code: "session_invalid" } });
        expect(response.headers.has("set-cookie")).toBe(false);
        expect(revocations).toBe(0);
        expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("active");
        expect(f.issuer.requests.length).toBe(requestsBefore);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  test("shared logout remains idempotent without either named cookie", async () => {
    const f = await fixture();
    try {
      for (const otherCookie of [
        undefined,
        "takoserver_session_suffix=x; prefix_takoserver_session=x",
      ]) {
        const headers = new Headers({ origin: SESSION_TEST_CONSOLE });
        if (otherCookie !== undefined) headers.set("cookie", otherCookie);
        const response = await f.request("/auth/oidc/logout", { method: "POST", headers });
        expect(response.status).toBe(204);
        expect(response.headers.getSetCookie()).toEqual([
          `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
          `${LEGACY_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
        ]);
      }
      expect(f.issuer.requests).toEqual([]);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("shared-only logout still revokes its own session", async () => {
    const f = await fixture();
    try {
      const signedIn = await f.signedIn();
      const response = await f.request("/auth/oidc/logout", {
        method: "POST",
        headers: { cookie: signedIn.sessionCookie, origin: SESSION_TEST_CONSOLE },
      });
      expect(response.status).toBe(204);
      expect(response.headers.getSetCookie()).toEqual([
        `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
        `${LEGACY_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      ]);
      expect((await f.d1.store.readSession(signedIn.digest))?.status).toBe("revocation_pending");
      expect(await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie))).toBeNull();
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
        headers: {
          cookie: `${signedIn.sessionCookie}; ${LEGACY_SESSION_COOKIE}=legacy_B`,
          origin: SESSION_TEST_CONSOLE,
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.getSetCookie()).toEqual([
        `${SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
        `${LEGACY_SESSION_COOKIE}=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0`,
      ]);
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
        const response = await f.callback({
          ...started,
          browserCookie: `${started.browserCookie}; ${LEGACY_SESSION_COOKIE}=legacy_B`,
        });
        expect(response.status).toBe(503);
        expect(
          response.headers.getSetCookie().some((item) => item.startsWith(SESSION_COOKIE)),
        ).toBe(false);
        expect(
          response.headers
            .getSetCookie()
            .some((item) => item.startsWith(`${LEGACY_SESSION_COOKIE}=`)),
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

  test("absent private finalStore is unavailable without invoking ordinary store or network", async () => {
    const f = await fixture();
    try {
      const signedIn = await f.signedIn();
      const { finalStore, ...ordinary } = f.composition;
      expect(typeof finalStore).toBe("function");
      let ordinaryCalls = 0;
      let networkCalls = 0;
      const withoutFinal = createSharedAuthSession({
        ...ordinary,
        store() {
          ordinaryCalls += 1;
          throw new Error("ordinary store cannot substitute for final observation");
        },
        async fetch() {
          networkCalls += 1;
          throw new Error("missing final store cannot start a network operation");
        },
      });
      await expect(
        withoutFinal.observeFinalSession(f.sessionRequest(signedIn.sessionCookie)),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      await expect(
        withoutFinal.observeFinalWorkspaceOrganization(
          f.sessionRequest(signedIn.sessionCookie),
          SESSION_TEST_ORGANIZATION.id,
        ),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(ordinaryCalls).toBe(0);
      expect(networkCalls).toBe(0);
      expect((await f.d1.store.readSession(signedIn.digest))?.version).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("only this factory's original frozen context carries its actual final primary selection", async () => {
    const f = await fixture();
    try {
      const other = createSharedAuthSession(f.composition);
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      if (!context) throw new Error("missing real authenticated context");
      const row = await f.d1.store.readSession(signedIn.digest);
      const selected = f.runtime.finalSessionSelection(context);
      if (!row || !selected) throw new Error("missing acknowledged final primary selection");
      expect(selected).toEqual({
        sessionDigest: row.digest,
        sessionVersion: row.version,
        accountId: row.accountId,
        principalId: row.principalId,
        sessionWorkspaceId: row.workspaceId,
        selectedWorkspaceId: context.workspace.id,
        identity: {
          issuer: context.provenance.issuer,
          clientId: context.provenance.clientId,
          subject: context.provenance.subject,
          sessionId: context.provenance.sessionId,
          authTime: context.provenance.authTime,
        },
        createdAt: row.createdAt,
        lastUsedAt: row.lastUsedAt,
        grantCheckedAt: row.grantCheckedAt,
        absoluteExpiresAt: row.absoluteExpiresAt,
        observedAt: f.now(),
      });
      for (const value of [
        context,
        context.actor,
        context.actor.scopes,
        context.workspace,
        context.workspace.roles,
        context.provenance,
        selected,
        selected.identity,
      ])
        expect(Object.isFrozen(value)).toBe(true);
      expect(f.runtime.finalSessionSelection(context)).toBe(selected);
      expect(f.runtime.finalSessionSelection({ ...context })).toBeNull();
      expect(f.runtime.finalSessionSelection(structuredClone(context))).toBeNull();
      expect(f.runtime.finalSessionSelection(selected)).toBeNull();
      expect(f.runtime.finalSessionSelection(null)).toBeNull();
      expect(other.finalSessionSelection(context)).toBeNull();
      expect(JSON.stringify(context)).not.toContain(signedIn.digest);
      expect(JSON.stringify(selected)).not.toContain(row.payload);
      expect(JSON.stringify(selected)).not.toContain(f.issuer.issued[0]?.accessToken ?? "missing");
      const publicSession = await f.request("/auth/oidc/session", {
        headers: { cookie: signedIn.sessionCookie },
      });
      expect(await publicSession.json()).toEqual({ authenticated: true });
      expect(
        await f.runtime.fetch(
          new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/finalSessionSelection`),
        ),
      ).toBeNull();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("strict-connected known-zero reloads once and selects its own actual guarded retouch image", async () => {
    let touches = 0;
    let reads = 0;
    const images: (OidcSessionRecord | null)[] = [];
    const f = await fixture({
      wrapFinalStore: (store) => ({
        ...store,
        async readSession(digest) {
          reads += 1;
          return await store.readSession(digest);
        },
        async touchSessionAndSelect(digest, version, stamp) {
          touches += 1;
          if (touches === 1) await store.touchSession(digest, version, stamp);
          const selected = await store.touchSessionAndSelect(digest, version, stamp);
          images.push(selected);
          return selected;
        },
      }),
    });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      expect(touches).toBe(2);
      expect(reads).toBe(2);
      expect(images[0]).toBeNull();
      expect(images[1]?.version).toBe(2);
      expect(selected?.sessionVersion).toBe(images[1]?.version);
      expect(selected?.sessionDigest).toBe(images[1]?.digest);
      expect((await f.d1.store.readSession(signedIn.digest))?.version).toBe(2);
      expect(f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token")).toEqual(
        [],
      );
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("a strict-connected second known miss is unavailable without a third read or touch", async () => {
    let touches = 0;
    let reads = 0;
    const f = await fixture({
      wrapFinalStore: (store) => ({
        ...store,
        async readSession(digest) {
          reads += 1;
          return await store.readSession(digest);
        },
        async touchSessionAndSelect(digest, version, stamp) {
          touches += 1;
          await store.touchSession(digest, version, stamp);
          return await store.touchSessionAndSelect(digest, version, stamp);
        },
      }),
    });
    try {
      const signedIn = await f.signedIn();
      await expect(
        f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie)),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(touches).toBe(2);
      expect(reads).toBe(2);
      expect((await f.d1.store.readSession(signedIn.digest))?.version).toBe(2);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("lost acknowledgement after a compatible guarded retouch never triggers a third write", async () => {
    let touches = 0;
    let reads = 0;
    const f = await fixture({
      wrapFinalStore: (store) => ({
        ...store,
        async readSession(digest) {
          reads += 1;
          return await store.readSession(digest);
        },
        async touchSessionAndSelect(digest, version, stamp) {
          touches += 1;
          if (touches === 1) await store.touchSession(digest, version, stamp);
          const selected = await store.touchSessionAndSelect(digest, version, stamp);
          if (touches === 2) throw new Error("synthetic ACK lost after real guarded retouch");
          return selected;
        },
      }),
    });
    try {
      const signedIn = await f.signedIn();
      await expect(
        f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie)),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(touches).toBe(2);
      expect(reads).toBe(2);
      expect((await f.d1.store.readSession(signedIn.digest))?.version).toBe(2);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("ordinary RP preserves its existing compatible touch race without minting a final selection", async () => {
    let touches = 0;
    const f = await fixture({
      wrapStore: (store) => ({
        ...store,
        async touchSession(digest, version, stamp) {
          touches += 1;
          if (touches === 1) await store.touchSession(digest, version, stamp);
          return await store.touchSession(digest, version, stamp);
        },
      }),
    });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie));
      expect(context?.accountId).toBe(SESSION_TEST_ACCOUNT);
      expect(touches).toBe(2);
      expect((await f.d1.store.readSession(signedIn.digest))?.version).toBe(2);
      expect(f.runtime.finalSessionSelection(context)).toBeNull();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test.each(["before", "after"] as const)(
    "unknown %s-commit touch response yields no context, reload or resend",
    async (phase) => {
      let touches = 0;
      let reads = 0;
      const f = await fixture({
        wrapFinalStore: (store) => ({
          ...store,
          async readSession(digest) {
            reads += 1;
            return await store.readSession(digest);
          },
          async touchSessionAndSelect(digest, version, stamp) {
            touches += 1;
            if (phase === "after") await store.touchSessionAndSelect(digest, version, stamp);
            throw new Error("synthetic lost final touch acknowledgement");
          },
        }),
      });
      try {
        const signedIn = await f.signedIn();
        await expect(
          f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie)),
        ).rejects.toMatchObject({ code: "session_unavailable" });
        expect(touches).toBe(1);
        expect(reads).toBe(1);
        const row = await f.d1.store.readSession(signedIn.digest);
        expect(row?.version).toBe(phase === "after" ? 1 : 0);
        expect(row?.status).toBe("active");
        expect(f.runtime.finalSessionSelection(row)).toBeNull();
        expect(
          f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token"),
        ).toEqual([]);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  test("a later real primary write cannot replace this invocation's selected row image", async () => {
    const f = await fixture({
      wrapFinalStore: (store) => ({
        ...store,
        async touchSessionAndSelect(digest, version, stamp) {
          const selected = await store.touchSessionAndSelect(digest, version, stamp);
          if (selected) await store.touchSession(digest, selected.version, stamp);
          return selected;
        },
      }),
    });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing actual original post-touch row");
      const row = await f.d1.store.readSession(signedIn.digest);
      expect(selected.sessionVersion).toBe(1);
      expect(row?.version).toBe(2);
      // A local test-only CAS demonstrates staleness; it is not a Financial admission.
      const stale = await f.d1.sql.run(
        "UPDATE shared_auth_sessions SET last_used_at = last_used_at WHERE digest = ? AND version = ? AND status = 'active' RETURNING *",
        [selected.sessionDigest, selected.sessionVersion],
      );
      expect(stale).toMatchObject({ changes: 0, rows: [] });
      expect(f.runtime.finalSessionSelection(context)).toBe(selected);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("malformed post-touch identity, payload, time or version images never mint a selection", async () => {
    let alter: ((row: OidcSessionRecord) => Partial<OidcSessionRecord>) | undefined;
    let touches = 0;
    const f = await fixture({
      wrapFinalStore: (store) => ({
        ...store,
        async touchSessionAndSelect(digest, version, stamp) {
          touches += 1;
          const selected = await store.touchSessionAndSelect(digest, version, stamp);
          // Only this outer acknowledgement is synthetic; every write is real D1.
          return selected && alter ? { ...selected, ...alter(selected) } : selected;
        },
      }),
    });
    const changes: readonly ((row: OidcSessionRecord) => Partial<OidcSessionRecord>)[] = [
      () => ({ digest: `sha256:${"d".repeat(64)}` }),
      () => ({ accountId: "different-canonical-account" }),
      () => ({ principalId: "different-local-principal" }),
      () => ({ workspaceId: "different-stored-workspace" }),
      () => ({ payload: "synthetic-different-encrypted-payload" }),
      (row) => ({ createdAt: row.createdAt - 1 }),
      (row) => ({ absoluteExpiresAt: row.absoluteExpiresAt - 1 }),
      (row) => ({ grantCheckedAt: row.grantCheckedAt + 1 }),
      (row) => ({ lastUsedAt: row.lastUsedAt - 1 }),
      (row) => ({ version: row.version + 1 }),
      () => ({ status: "checking" }),
    ];
    try {
      for (const change of changes) {
        const signedIn = await f.signedIn();
        f.setTime(f.now() + 10);
        alter = change;
        const before = touches;
        await expect(
          f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie)),
        ).rejects.toMatchObject({ code: "session_unavailable" });
        expect(touches - before).toBe(1);
        expect((await f.d1.store.readSession(signedIn.digest))?.version).toBe(1);
      }
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test.each(["payload", "grant_checked_at"] as const)(
    "a real competing %s change is not a compatible acknowledged touch race",
    async (column) => {
      let mutate: ((digest: string) => Promise<void>) | undefined;
      let touches = 0;
      const f = await fixture({
        wrapFinalStore: (store) => ({
          ...store,
          async touchSessionAndSelect(digest, version, stamp) {
            touches += 1;
            await store.touchSession(digest, version, stamp);
            await mutate?.(digest);
            return await store.touchSessionAndSelect(digest, version, stamp);
          },
        }),
      });
      try {
        const signedIn = await f.signedIn();
        f.setTime(f.now() + 10);
        mutate = async (digest) => {
          await f.d1.sql.run(`UPDATE shared_auth_sessions SET ${column} = ? WHERE digest = ?`, [
            column === "payload" ? "synthetic-replaced-ciphertext" : f.now(),
            digest,
          ]);
        };
        await expect(
          f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie)),
        ).rejects.toMatchObject({ code: "session_unavailable" });
        expect(touches).toBe(1);
        expect((await f.d1.store.readSession(signedIn.digest))?.version).toBe(1);
        expect(
          f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token"),
        ).toEqual([]);
      } finally {
        await f.dispose();
      }
    },
    30_000,
  );

  test("real issuer rotation settles before the actual final touch is selected", async () => {
    const f = await fixture();
    try {
      const signedIn = await f.signedIn();
      f.setTime(INITIAL_TIME + 5 * 60 * 1000 + 1);
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      const row = await f.d1.store.readSession(signedIn.digest);
      expect(row?.version).toBe(3);
      expect(selected?.sessionVersion).toBe(row?.version);
      expect(selected?.lastUsedAt).toBe(row?.lastUsedAt);
      expect(selected?.grantCheckedAt).toBe(row?.grantCheckedAt);
      expect(
        f.issuer.requests.filter((r) => r.form.get("grant_type") === "refresh_token"),
      ).toHaveLength(1);
      expect(JSON.stringify(selected)).not.toContain(f.issuer.issued[1]?.refreshToken ?? "missing");
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("final Organization result has its own provenance and cannot switch cookie or owner ports during pin", async () => {
    const f = await fixture();
    try {
      const first = await f.signedIn();
      const second = await f.signedIn();
      const request = new Request(`${SESSION_TEST_CONFIG.publicOrigin}/control/test-resource`, {
        method: "POST",
        headers: { cookie: first.sessionCookie, origin: SESSION_TEST_CONSOLE },
        body: "private test payment body",
      });
      f.control.onPin = async () => {
        request.headers.set("cookie", second.sessionCookie);
        Object.defineProperty(f.composition, "store", {
          value: () => {
            throw new Error("mutable options store must not be resolved again");
          },
        });
        Object.defineProperty(f.composition, "finalStore", {
          value: () => {
            throw new Error("mutable final store must not be resolved again");
          },
        });
        f.composition.principals.resolve = async () => {
          throw new Error("mutable principal method must not be resolved again");
        };
        if (f.composition.organizations)
          f.composition.organizations.pin = async () => {
            throw new Error("mutable pin method must not be resolved again");
          };
      };
      const context = await f.runtime.observeFinalWorkspaceOrganization(
        request,
        SESSION_TEST_ORGANIZATION.id,
      );
      const selected = f.runtime.finalSessionSelection(context);
      const firstRow = await f.d1.store.readSession(first.digest);
      expect(selected?.sessionDigest).toBe(first.digest);
      expect(selected?.sessionVersion).toBe(firstRow?.version);
      expect(firstRow?.version).toBe(2);
      expect(selected?.sessionWorkspaceId).toBe(SESSION_TEST_PERSONAL.id);
      expect(selected?.selectedWorkspaceId).toBe(SESSION_TEST_ORGANIZATION.id);
      expect((await f.d1.store.readSession(second.digest))?.version).toBe(0);
      expect(context?.organizationId).toBe("retained-takoserver-organization-789");
      expect(Object.isFrozen(context)).toBe(true);
      expect(request.bodyUsed).toBe(false);
      expect(await request.text()).toBe("private test payment body");
      expect(f.runtime.finalSessionSelection({ ...context })).toBeNull();
      // The original pin callable, captured once, also survives a later invocation.
      expect(
        await f.runtime.observeFinalWorkspaceOrganization(
          f.sessionRequest(first.sessionCookie),
          SESSION_TEST_ORGANIZATION.id,
        ),
      ).not.toBeNull();
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("financial proof uses the second acknowledged final grant, not the first workspace selection", async () => {
    const calls: { receiver: unknown; accessToken: string; challengeRef: string }[] = [];
    const financialProof: SharedAuthFinancialProofReceiver = {
      async prove(input) {
        calls.push({ receiver: this, ...input });
        return { proofRef: "accounts-proof-organization" };
      },
    };
    const f = await fixture({ financialProof });
    try {
      const signedIn = await f.signedIn();
      f.control.onPin = async () => f.setTime(INITIAL_TIME + 5 * 60 * 1000 + 1);
      const context = await f.runtime.observeFinalWorkspaceOrganization(
        f.sessionRequest(signedIn.sessionCookie),
        SESSION_TEST_ORGANIZATION.id,
      );
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing second final selection");
      expect(selected.selectedWorkspaceId).toBe(SESSION_TEST_ORGANIZATION.id);
      expect(f.issuer.issued).toHaveLength(2);
      const refreshed = f.issuer.issued[1]?.accessToken;
      if (!refreshed) throw new Error("missing refreshed grant");
      const requestsBefore = f.issuer.requests.length;
      const versionBefore = (await f.d1.store.readSession(signedIn.digest))?.version;
      const proof = await f.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-org");
      expect(proof).toEqual({ proofRef: "accounts-proof-organization" });
      expect(Object.isFrozen(proof)).toBe(true);
      expect(calls).toEqual([
        { receiver: financialProof, accessToken: refreshed, challengeRef: "challenge-org" },
      ]);
      expect(JSON.stringify(selected)).not.toContain(refreshed);
      expect(JSON.stringify(proof)).not.toContain(refreshed);
      expect(f.issuer.requests).toHaveLength(requestsBefore);
      expect((await f.d1.store.readSession(signedIn.digest))?.version).toBe(versionBefore);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("financial proof denies an absent binding and foreign, ordinary or cloned selections", async () => {
    let calls = 0;
    const f = await fixture();
    const g = await fixture({
      financialProof: {
        async prove() {
          calls += 1;
          return { proofRef: "unused" };
        },
      },
    });
    try {
      const signedIn = await f.signedIn();
      const final = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(final);
      if (!selected) throw new Error("missing final selection");
      await expect(
        f.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-r1"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      await expect(
        g.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-r1"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      await expect(
        f.runtime.proveFinalSessionFinancialIdentity({ ...selected }, "challenge-r1"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      const ordinary = await f.runtime.authenticate(f.sessionRequest(signedIn.sessionCookie));
      expect(f.runtime.finalSessionSelection(ordinary)).toBeNull();
      await expect(
        g.runtime.proveFinalSessionFinancialIdentity(ordinary as never, "challenge-r1"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(calls).toBe(0);
    } finally {
      await f.dispose();
      await g.dispose();
    }
  }, 30_000);

  test("financial proof registers one attempt before dispatch and keeps unknown rejection", async () => {
    let calls = 0;
    let rejectRemote: (reason: Error) => void = () => {};
    const pending = new Promise<unknown>((_resolve, reject) => {
      rejectRemote = reject;
    });
    const f = await fixture({
      financialProof: {
        prove() {
          calls += 1;
          return pending;
        },
      },
    });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      const first = f.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-unknown");
      const second = f.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-unknown");
      expect(second).toBe(first);
      await Promise.resolve();
      expect(calls).toBe(1);
      rejectRemote(new Error("unknown remote acknowledgement"));
      await expect(first).rejects.toMatchObject({ code: "session_unavailable" });
      await expect(
        f.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-unknown"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(calls).toBe(1);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("financial proof load/current read only this receiver's own proof once each", async () => {
    const calls: { method: string; receiver: unknown; input: unknown }[] = [];
    const proofData = (status: string, proofRef: string, challengeRef: string) => ({
      v: 1,
      status,
      proof: { v: 1, proofRef, challenge: { challengeRef, nested: [1, "x"] } },
      ...(status === "current" ? { observedAt: 7 } : {}),
    });
    const financialProof: SharedAuthFinancialProofReceiver = {
      async prove(input) {
        calls.push({ method: "prove", receiver: this, input });
        return { proofRef: "accounts-proof-held" };
      },
      async loadFinancialIdentityProof(input) {
        calls.push({ method: "load", receiver: this, input });
        return proofData("found", input.proofRef, input.challengeRef);
      },
      async verifyCurrentFinancialIdentityProof(input) {
        calls.push({ method: "current", receiver: this, input });
        return proofData("current", input.proofRef, input.challengeRef);
      },
    };
    const f = await fixture({ financialProof });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      // Order is enforced before any dispatch: no load before prove, no current before load.
      await expect(
        f.runtime.loadFinalSessionFinancialIdentityProof(selected, "challenge-held"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      await expect(
        f.runtime.verifyCurrentFinalSessionFinancialIdentityProof(selected, "challenge-held"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(calls).toHaveLength(0);
      const requestsBefore = f.issuer.requests.length;
      const versionBefore = (await f.d1.store.readSession(signedIn.digest))?.version;
      await f.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-held");
      await expect(
        f.runtime.verifyCurrentFinalSessionFinancialIdentityProof(selected, "challenge-held"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      const load = f.runtime.loadFinalSessionFinancialIdentityProof(selected, "challenge-held");
      expect(f.runtime.loadFinalSessionFinancialIdentityProof(selected, "challenge-held")).toBe(
        load,
      );
      const loaded = await load;
      const current = await f.runtime.verifyCurrentFinalSessionFinancialIdentityProof(
        selected,
        "challenge-held",
      );
      await f.runtime.verifyCurrentFinalSessionFinancialIdentityProof(selected, "challenge-held");
      const request = { v: 1, proofRef: "accounts-proof-held", challengeRef: "challenge-held" };
      expect(calls.map(({ method, receiver, input }) => [method, receiver, input])).toEqual([
        ["prove", financialProof, expect.anything()],
        ["load", financialProof, request],
        ["current", financialProof, request],
      ]);
      expect(Object.isFrozen(calls[1]?.input)).toBe(true);
      expect(loaded).toEqual(proofData("found", "accounts-proof-held", "challenge-held"));
      expect(current).toEqual(proofData("current", "accounts-proof-held", "challenge-held"));
      const proof = (current as { proof: { challenge: { nested: unknown[] } } }).proof;
      expect(Object.isFrozen(current)).toBe(true);
      expect(Object.isFrozen(proof.challenge.nested)).toBe(true);
      const token = f.issuer.issued[0]?.accessToken ?? "missing";
      expect(JSON.stringify([calls[1]?.input, loaded, current])).not.toContain(token);
      expect(f.issuer.requests).toHaveLength(requestsBefore);
      expect((await f.d1.store.readSession(signedIn.digest))?.version).toBe(versionBefore);
      // Another challenge, a cloned selection or a prove-only receiver has no held proof.
      await expect(
        f.runtime.loadFinalSessionFinancialIdentityProof(selected, "challenge-other"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      await expect(
        f.runtime.loadFinalSessionFinancialIdentityProof({ ...selected }, "challenge-held"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(calls).toHaveLength(3);
    } finally {
      await f.dispose();
    }
    let proveOnlyCalls = 0;
    const g = await fixture({
      financialProof: {
        async prove() {
          proveOnlyCalls += 1;
          return { proofRef: "accounts-proof-only" };
        },
      },
    });
    try {
      const signedIn = await g.signedIn();
      const context = await g.runtime.observeFinalSession(g.sessionRequest(signedIn.sessionCookie));
      const selected = g.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      await g.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-only");
      await expect(
        g.runtime.loadFinalSessionFinancialIdentityProof(selected, "challenge-only"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(proveOnlyCalls).toBe(1);
    } finally {
      await g.dispose();
    }
  }, 30_000);

  test("financial proof load/current keep unknown, crossed and getter results sticky", async () => {
    let loads = 0;
    let currents = 0;
    let getterCalls = 0;
    let mode: "unknown" | "crossed" | "getter" = "unknown";
    const f = await fixture({
      financialProof: {
        async prove({ challengeRef }) {
          return { proofRef: `proof-${challengeRef}` };
        },
        async loadFinancialIdentityProof(input) {
          loads += 1;
          if (mode === "unknown") throw new Error("unknown load acknowledgement");
          if (mode === "crossed")
            return {
              v: 1,
              status: "found",
              proof: {
                v: 1,
                proofRef: "proof-other",
                challenge: { challengeRef: input.challengeRef },
              },
            };
          const proof = { v: 1, proofRef: input.proofRef };
          Object.defineProperty(proof, "challenge", {
            enumerable: true,
            get() {
              getterCalls += 1;
              return { challengeRef: input.challengeRef };
            },
          });
          return { v: 1, status: "found", proof };
        },
        async verifyCurrentFinancialIdentityProof() {
          currents += 1;
          return {};
        },
      },
    });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      for (const [index, next] of (["unknown", "crossed", "getter"] as const).entries()) {
        mode = next;
        const challengeRef = `challenge-${next}`;
        await f.runtime.proveFinalSessionFinancialIdentity(selected, challengeRef);
        const first = f.runtime.loadFinalSessionFinancialIdentityProof(selected, challengeRef);
        await expect(first).rejects.toMatchObject({ code: "session_unavailable" });
        expect(f.runtime.loadFinalSessionFinancialIdentityProof(selected, challengeRef)).toBe(
          first,
        );
        await expect(
          f.runtime.verifyCurrentFinalSessionFinancialIdentityProof(selected, challengeRef),
        ).rejects.toMatchObject({ code: "session_unavailable" });
        expect(loads).toBe(index + 1);
      }
      expect(currents).toBe(0);
      expect(getterCalls).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("financial proof load/current reject prototype keys, crossed challenge, drift and failed current", async () => {
    let loads = 0;
    let currents = 0;
    let disposed = 0;
    let mode: "proto" | "challenge" | "current" | "drift" = "proto";
    const found = (proofRef: string, challengeRef: string) => ({
      v: 1,
      status: "found",
      proof: { v: 1, proofRef, challenge: { challengeRef } },
    });
    const financialProof: SharedAuthFinancialProofReceiver = {
      async prove({ challengeRef }) {
        return { proofRef: `proof-${challengeRef}` };
      },
      async loadFinancialIdentityProof(input) {
        loads += 1;
        if (mode === "proto")
          return JSON.parse(
            `{"__proto__":${JSON.stringify(found(input.proofRef, input.challengeRef))}}`,
          );
        if (mode === "challenge") return found(input.proofRef, "challenge-other");
        const response = found(input.proofRef, input.challengeRef);
        Object.defineProperty(response, Symbol.dispose, {
          value() {
            disposed += 1;
          },
        });
        return response;
      },
      async verifyCurrentFinancialIdentityProof() {
        currents += 1;
        return { v: 1, status: "not-current" };
      },
    };
    const f = await fixture({ financialProof });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      for (const next of ["proto", "challenge"] as const) {
        mode = next;
        await f.runtime.proveFinalSessionFinancialIdentity(selected, `challenge-${next}`);
        await expect(
          f.runtime.loadFinalSessionFinancialIdentityProof(selected, `challenge-${next}`),
        ).rejects.toMatchObject({ code: "session_unavailable" });
        await expect(
          f.runtime.verifyCurrentFinalSessionFinancialIdentityProof(selected, `challenge-${next}`),
        ).rejects.toMatchObject({ code: "session_unavailable" });
      }
      expect([loads, currents]).toEqual([2, 0]);
      mode = "current";
      await f.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-current");
      expect(
        await f.runtime.loadFinalSessionFinancialIdentityProof(selected, "challenge-current"),
      ).toEqual(found("proof-challenge-current", "challenge-current"));
      expect(disposed).toBe(1);
      const failed = f.runtime.verifyCurrentFinalSessionFinancialIdentityProof(
        selected,
        "challenge-current",
      );
      await expect(failed).rejects.toMatchObject({ code: "session_unavailable" });
      expect(
        f.runtime.verifyCurrentFinalSessionFinancialIdentityProof(selected, "challenge-current"),
      ).toBe(failed);
      expect([loads, currents]).toEqual([3, 1]);
      // Replacing the captured load transport after construction stops dispatch.
      mode = "drift";
      await f.runtime.proveFinalSessionFinancialIdentity(selected, "challenge-drift");
      Object.defineProperty(financialProof, "loadFinancialIdentityProof", {
        configurable: true,
        value: async () => found("proof-challenge-drift", "challenge-drift"),
      });
      await expect(
        f.runtime.loadFinalSessionFinancialIdentityProof(selected, "challenge-drift"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(loads).toBe(3);
    } finally {
      await f.dispose();
    }
    await expect(
      fixture({
        financialProof: {
          prove: async () => ({ proofRef: "unused" }),
          loadFinancialIdentityProof: "not-a-method" as never,
        },
      }),
    ).rejects.toThrow(TypeError);
  }, 30_000);

  test("financial proof accepts only detached DATA and releases the same RPC response once", async () => {
    const calls: string[] = [];
    const disposed: object[] = [];
    const financialProof: SharedAuthFinancialProofReceiver = {
      async prove({ challengeRef }) {
        calls.push(challengeRef);
        const response = { proofRef: `proof-${challengeRef}` };
        Object.defineProperty(response, Symbol.dispose, {
          value: function (this: typeof response) {
            disposed.push(this);
            this.proofRef = "changed-after-detachment";
          },
          enumerable: false,
        });
        if (challengeRef === "invalid")
          Object.defineProperty(response, "extra", { value: true, enumerable: true });
        return response;
      },
    };
    const f = await fixture({ financialProof });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      expect(await f.runtime.proveFinalSessionFinancialIdentity(selected, "valid")).toEqual({
        proofRef: "proof-valid",
      });
      await expect(
        f.runtime.proveFinalSessionFinancialIdentity(selected, "invalid"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      await expect(
        f.runtime.proveFinalSessionFinancialIdentity(selected, "invalid"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(calls).toEqual(["valid", "invalid"]);
      expect(disposed).toHaveLength(2);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("an inherited RPC method is captured without an own-property prerequisite", async () => {
    const prototype = {
      async prove({
        challengeRef,
      }: {
        readonly accessToken: string;
        readonly challengeRef: string;
      }) {
        return { proofRef: `proof-${challengeRef}` };
      },
    };
    const financialProof = Object.create(prototype) as SharedAuthFinancialProofReceiver;
    const f = await fixture({ financialProof });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      expect(Object.hasOwn(financialProof, "prove")).toBe(false);
      expect(await f.runtime.proveFinalSessionFinancialIdentity(selected, "inherited")).toEqual({
        proofRef: "proof-inherited",
      });
      prototype.prove = async () => ({ proofRef: "changed" });
      await expect(
        f.runtime.proveFinalSessionFinancialIdentity(selected, "after-prototype-change"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("a complete descriptorless synthetic receiver uses only its construction-time callable", async () => {
    let lookups = 0;
    let calls = 0;
    const financialProof = new Proxy(Object.create(null) as SharedAuthFinancialProofReceiver, {
      get(_target, name) {
        if (name !== "prove") return undefined;
        lookups++;
        if (lookups > 1) throw Error("unexpected dynamic method relookup");
        return async () => {
          calls++;
          return { proofRef: "synthetic-dynamic-proof" };
        };
      },
    });
    const f = await fixture({ financialProof });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      expect(
        await f.runtime.proveFinalSessionFinancialIdentity(selected, "dynamic-challenge"),
      ).toEqual({ proofRef: "synthetic-dynamic-proof" });
      expect(lookups).toBe(1);
      expect(calls).toBe(1);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("a prove method beyond the bounded prototype chain cannot receive the grant", async () => {
    let calls = 0;
    let prototype: object = {
      async prove() {
        calls += 1;
        return { proofRef: "unbounded" };
      },
    };
    for (let depth = 0; depth < 17; depth += 1) prototype = Object.create(prototype);
    const financialProof = Object.create(prototype) as SharedAuthFinancialProofReceiver;
    const f = await fixture({ financialProof });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      await expect(
        f.runtime.proveFinalSessionFinancialIdentity(selected, "deep-method"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(calls).toBe(0);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("a deep inherited method changed while pending cannot publish its proofRef", async () => {
    let calls = 0;
    let complete: (result: unknown) => void = () => {};
    const response = new Promise<unknown>((resolve) => {
      complete = resolve;
    });
    const owner = {
      prove() {
        calls += 1;
        return response;
      },
    };
    let prototype: object = owner;
    for (let depth = 0; depth < 14; depth += 1) prototype = Object.create(prototype);
    const financialProof = Object.create(prototype) as SharedAuthFinancialProofReceiver;
    const f = await fixture({ financialProof });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      const attempted = f.runtime.proveFinalSessionFinancialIdentity(selected, "deep-drift");
      await Promise.resolve();
      expect(calls).toBe(1);
      owner.prove = async () => ({ proofRef: "substituted" });
      complete({ proofRef: "ack-after-drift" });
      await expect(attempted).rejects.toMatchObject({ code: "session_unavailable" });
      await expect(
        f.runtime.proveFinalSessionFinancialIdentity(selected, "deep-drift"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(calls).toBe(1);
    } finally {
      await f.dispose();
    }
  }, 30_000);

  test("late RPC method drift rejects the awaited result without dispatch replay", async () => {
    let dispatches = 0;
    let complete: (result: unknown) => void = () => {};
    const response = new Promise<unknown>((resolve) => {
      complete = resolve;
    });
    const financialProof: SharedAuthFinancialProofReceiver = {
      prove() {
        dispatches += 1;
        return response;
      },
    };
    const f = await fixture({ financialProof });
    try {
      const signedIn = await f.signedIn();
      const context = await f.runtime.observeFinalSession(f.sessionRequest(signedIn.sessionCookie));
      const selected = f.runtime.finalSessionSelection(context);
      if (!selected) throw new Error("missing final selection");
      const attempted = f.runtime.proveFinalSessionFinancialIdentity(selected, "late-drift");
      await Promise.resolve();
      expect(dispatches).toBe(1);
      financialProof.prove = async () => ({ proofRef: "substituted" });
      complete({ proofRef: "real-ack" });
      await expect(attempted).rejects.toMatchObject({ code: "session_unavailable" });
      await expect(
        f.runtime.proveFinalSessionFinancialIdentity(selected, "late-drift"),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(dispatches).toBe(1);
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
