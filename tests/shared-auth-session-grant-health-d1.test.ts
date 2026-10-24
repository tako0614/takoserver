// TASK-0110 R20 grant-health revocation (20:24:44Z) through the REAL Root
// session code: authenticate -> claimSession -> refresh -> introspect ->
// userinfo -> completeSession on a local Miniflare D1 with the served schema.
// The issuer double follows the Accounts shared-account refresh contract
// (every refresh returns a signed ID token with the original nonce/sid/auth_time).
// Synthetic DATA only; no live issuer, D1, SSO or deploy.
import { afterEach, describe, expect, test } from "bun:test";
import { bytesDigest } from "../src/json.ts";
import { SharedAuthOidcError } from "../src/shared-auth-oidc-client.ts";
import { createSharedAuthSession, SharedAuthSessionError } from "../src/shared-auth-session.ts";
import {
  createSharedAuthFinalSessionStore,
  createSharedAuthSessionStore,
  type SharedAuthSessionStore,
} from "../src/shared-auth-session-store.ts";
import {
  createServedSchemaD1,
  SERVED_SQL_MODES,
  type ServedSqlMode,
} from "./helpers/served-schema-d1.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_PERSONAL_ORGANIZATION,
} from "./helpers/shared-auth-session-issuer.ts";

const ATTEMPT_COOKIE = "__Host-takoserver_oidc_attempt";
const SESSION_COOKIE = "__Host-takoserver_shared_session";
const MARKER = "takoserver.shared_auth.grant_health.failure.v1";
const at = (value: string) => Date.parse(value);
const LOGIN = at("2026-10-22T18:14:50.000Z");
// Observed R20 request schedule; 20:24:37 follows a 14 minute idle gap.
const SCHEDULE = [
  "2026-10-22T18:37:00.000Z",
  "2026-10-22T20:06:40.000Z",
  "2026-10-22T20:10:03.000Z",
  "2026-10-22T20:10:37.000Z",
] as const;
const FAILING = at("2026-10-22T20:24:37.000Z");

const disposers: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const dispose of disposers.splice(0)) await dispose();
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
  mode: ServedSqlMode,
  options: {
    send?: (request: Request, send: (request: Request) => Promise<Response>) => Promise<Response>;
    wrapStore?: (store: SharedAuthSessionStore) => SharedAuthSessionStore;
  } = {},
) {
  const d1 = await createServedSchemaD1(mode);
  disposers.push(() => d1.runtime.dispose());
  let stamp = LOGIN;
  const issuer = await createSharedSessionTestIssuer(() => stamp, {
    accountsRefreshContract: true,
  });
  issuer.control.personalBillingOrganization = SESSION_TEST_PERSONAL_ORGANIZATION;
  const store = createSharedAuthSessionStore(d1.sql);
  const runtime = createSharedAuthSession({
    config: SESSION_TEST_CONFIG,
    consoleOrigin: SESSION_TEST_CONSOLE,
    encryptionKey: new Uint8Array(32).fill(7),
    now: () => stamp,
    store: () => (options.wrapStore ? options.wrapStore(store) : store),
    finalStore: () => createSharedAuthFinalSessionStore(d1.sql),
    fetch: async (request) =>
      options.send ? await options.send(request, issuer.send) : await issuer.send(request),
    principals: {
      async resolve() {
        return { accountId: SESSION_TEST_ACCOUNT, principalId: "retained-local-principal-r20" };
      },
    },
    organizations: {
      async pin(input) {
        return input;
      },
    },
  });
  async function signedIn() {
    const login = await runtime.fetch(
      new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/login`),
    );
    const location = login?.headers.get("location");
    if (login?.status !== 303 || !location) throw new Error("test login did not start");
    const callback = await runtime.fetch(
      new Request(issuer.authorize(location), {
        headers: { cookie: cookie(login, ATTEMPT_COOKIE) },
      }),
    );
    if (callback?.status !== 303) throw new Error(`test callback failed: ${callback?.status}`);
    const sessionCookie = cookie(callback, SESSION_COOKIE);
    const digest = await bytesDigest(
      new TextEncoder().encode(sessionCookie.slice(`${SESSION_COOKIE}=`.length)),
    );
    return { sessionCookie, digest };
  }
  const get = (sessionCookie: string) =>
    runtime.authenticate(
      new Request(`${SESSION_TEST_CONFIG.publicOrigin}/v1/me`, {
        headers: { cookie: sessionCookie, origin: SESSION_TEST_CONSOLE },
      }),
    );
  const refreshes = () =>
    issuer.requests.filter(
      (request) =>
        request.url.pathname === "/oauth/token" &&
        request.form.get("grant_type") === "refresh_token",
    );
  const pending = async () =>
    (
      await d1.raw.query(
        "SELECT id, session_digest, status FROM shared_auth_revocations ORDER BY id",
      )
    ).map((row) => ({ id: row.id, status: row.status }));
  return {
    d1,
    issuer,
    runtime,
    store,
    signedIn,
    get,
    refreshes,
    pending,
    setTime(value: number) {
      stamp = value;
    },
  };
}

/** Drives the observed R20 schedule up to (not including) the failing GET. */
async function beforeFailure(f: Awaited<ReturnType<typeof fixture>>) {
  const session = await f.signedIn();
  for (const instant of SCHEDULE) {
    f.setTime(at(instant));
    expect((await f.get(session.sessionCookie))?.accountId).toBe(SESSION_TEST_ACCOUNT);
  }
  const row = await f.store.readSession(session.digest);
  if (row?.status !== "active") throw new Error("schedule did not leave an active session");
  return { ...session, version: row.version };
}

async function captureErrors<T>(run: () => Promise<T>): Promise<{ result: T; logged: string[] }> {
  const original = console.error;
  const logged: string[] = [];
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  try {
    return { result: await run(), logged };
  } finally {
    console.error = original;
  }
}

describe("R20 grant health on the served schema against the Accounts refresh contract", () => {
  for (const mode of SERVED_SQL_MODES) {
    test(`${mode}: the 14 minute idle gap refreshes with a signed ID token and stays active`, async () => {
      const f = await fixture(mode);
      const session = await beforeFailure(f);
      // 18:37 and 20:06:40 refreshed; 20:10:03 introspected the 20:06:40 access.
      expect(f.refreshes()).toHaveLength(2);
      f.setTime(FAILING);
      const { result, logged } = await captureErrors(() => f.get(session.sessionCookie));
      expect(result?.accountId).toBe(SESSION_TEST_ACCOUNT);
      expect(f.refreshes()).toHaveLength(3);
      // The Accounts-shaped refresh response really carried an ID token Root verified.
      expect(f.issuer.requests.slice(-6).map((request) => request.url.pathname)).toContain(
        "/oauth/jwks",
      );
      const row = await f.store.readSession(session.digest);
      expect(row).toMatchObject({ status: "active", grantCheckedAt: FAILING, lastUsedAt: FAILING });
      // claim + complete + touch.
      expect(row?.version).toBe(session.version + 3);
      expect(await f.pending()).toEqual([]);
      expect(logged.filter((line) => line.includes(MARKER))).toEqual([]);
    }, 60_000);
  }

  // Every in-fence failure leaves the live fingerprint: revocation_pending,
  // version claimed+1, and exactly the two uncertain rows. Only the outcome
  // differs: session_invalid/oidc_invalid end as null (401). Given the live
  // fingerprint plus 503, only oidc_unavailable (deadline, transport, 5xx) or a
  // non-OIDC completion failure remains. A queueRevocation/revokeSession throw or
  // a claim miss would also be 503, but without this fingerprint.
  const cases: {
    name: string;
    step: "refresh" | "introspect" | "userinfo" | "complete";
    refreshed: boolean;
    http: 401 | 503;
    failureClass: "session" | "oidc" | "unknown";
    code: string;
    deadline?: true;
    send?: (request: Request, send: (request: Request) => Promise<Response>) => Promise<Response>;
    wrapStore?: (store: SharedAuthSessionStore) => SharedAuthSessionStore;
  }[] = [
    {
      name: "refresh past the 5 s deadline after the issuer rotated",
      step: "refresh",
      // Root never received the rotated grant: the uncertain row holds the old one.
      refreshed: false,
      http: 503,
      failureClass: "oidc",
      code: "oidc_unavailable",
      deadline: true,
      async send(request, send) {
        const response = await send(request);
        if (new URL(request.url).pathname !== "/oauth/token") return response;
        await new Promise((resolve) => request.signal.addEventListener("abort", resolve));
        throw new DOMException("aborted", "AbortError");
      },
    },
    {
      name: "refresh refused with invalid_grant",
      step: "refresh",
      refreshed: false,
      http: 401,
      failureClass: "oidc",
      code: "oidc_invalid",
      async send(request, send) {
        if (new URL(request.url).pathname === "/oauth/token")
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return await send(request);
      },
    },
    {
      name: "introspection 5xx after rotation",
      step: "introspect",
      refreshed: true,
      http: 503,
      failureClass: "oidc",
      code: "oidc_unavailable",
      async send(request, send) {
        if (new URL(request.url).pathname === "/oauth/introspect")
          return new Response(null, { status: 503 });
        return await send(request);
      },
    },
    {
      name: "introspection active=false after rotation",
      step: "introspect",
      refreshed: true,
      http: 401,
      failureClass: "session",
      code: "session_invalid",
      async send(request, send) {
        if (new URL(request.url).pathname === "/oauth/introspect")
          return Response.json({ active: false });
        return await send(request);
      },
    },
    {
      name: "userinfo 401 after rotation",
      step: "userinfo",
      refreshed: true,
      http: 401,
      failureClass: "oidc",
      code: "oidc_invalid",
      async send(request, send) {
        if (new URL(request.url).pathname === "/oauth/userinfo")
          return Response.json({ error: "invalid_token" }, { status: 401 });
        return await send(request);
      },
    },
    {
      name: "completion with an unknown acknowledgement",
      step: "complete",
      refreshed: true,
      http: 503,
      failureClass: "unknown",
      code: "unknown",
      wrapStore: (store) => ({
        ...store,
        async completeSession() {
          throw new Error("synthetic lost completion acknowledgement");
        },
      }),
    },
  ];

  for (const c of cases)
    test(`fresh-native: ${c.name} leaves the live fence fingerprint and a localizing marker`, async () => {
      let failing = false;
      const f = await fixture("fresh-native", {
        send: async (request, send) =>
          failing && c.send ? await c.send(request, send) : await send(request),
        wrapStore: (store) =>
          c.wrapStore ? withFailing(store, () => failing, c.wrapStore) : store,
      });
      const session = await beforeFailure(f);
      f.setTime(FAILING);
      failing = true;
      const started = Date.now();
      const { result, logged } = await captureErrors(async () => {
        try {
          return { returned: await f.get(session.sessionCookie) };
        } catch (error) {
          return { thrown: error };
        }
      });
      const elapsed = Date.now() - started;
      failing = false;
      // authenticateWith converts session_invalid and oidc_invalid into null
      // (control.ts /v1/me: 401). requestActor maps any other rejection, apart
      // from a thrown session_invalid (401) or workspace_forbidden (403), to 503.
      const http =
        "returned" in result
          ? result.returned === null
            ? 401
            : 200
          : result.thrown instanceof SharedAuthSessionError &&
              result.thrown.code === "session_invalid"
            ? 401
            : result.thrown instanceof SharedAuthSessionError &&
                result.thrown.code === "workspace_forbidden"
              ? 403
              : 503;
      expect(http).toBe(c.http);
      // The fence's own 401s are the outer null conversion, not a thrown error.
      if (c.http === 401) expect("returned" in result && result.returned === null).toBe(true);
      if (c.http === 503 && c.failureClass === "oidc")
        expect("thrown" in result && result.thrown).toBeInstanceOf(SharedAuthOidcError);
      const row = await f.store.readSession(session.digest);
      expect(row?.status).toBe("revocation_pending");
      expect(row?.version).toBe(session.version + 2);
      expect(await f.pending()).toEqual([
        { id: `${session.digest}:uncertain:${session.version + 1}`, status: "pending" },
        { id: `uncertain:${session.digest}:${session.version + 1}`, status: "pending" },
      ]);
      expect(await f.get(session.sessionCookie)).toBeNull();
      const markers = logged
        .filter((line) => line.includes(MARKER))
        .map((line) => JSON.parse(line));
      expect(markers).toHaveLength(1);
      const { stepMs, ...marker } = markers[0];
      expect(marker).toEqual({
        marker: MARKER,
        step: c.step,
        refreshed: c.refreshed,
        class: c.failureClass,
        code: c.code,
      });
      expect(Number.isSafeInteger(stepMs) && stepMs >= 0 && stepMs <= elapsed).toBe(true);
      if (c.deadline) expect(stepMs).toBeGreaterThanOrEqual(4900);
      else expect(stepMs).toBeLessThan(4900);
      expect(JSON.stringify(markers)).not.toContain("synthetic-");
    }, 60_000);
});

function withFailing(
  store: SharedAuthSessionStore,
  failing: () => boolean,
  wrap: (store: SharedAuthSessionStore) => SharedAuthSessionStore,
): SharedAuthSessionStore {
  const wrapped = wrap(store);
  return {
    ...store,
    async completeSession(...args) {
      return failing()
        ? await wrapped.completeSession(...args)
        : await store.completeSession(...args);
    },
  };
}
