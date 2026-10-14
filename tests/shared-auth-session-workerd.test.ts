import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { SHARED_AUTH_TEST_ONLY_DDL } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
} from "./helpers/shared-auth-session-issuer.ts";

const NOW = 1_800_000_000_000;
const api = SESSION_TEST_CONFIG.publicOrigin;

async function fixture() {
  let now = NOW;
  const issuer = await createSharedSessionTestIssuer(() => now);
  const build = await Bun.build({
    entrypoints: [new URL("./fixtures/shared-auth-session-worker.ts", import.meta.url).pathname],
    target: "browser",
    format: "esm",
    minify: false,
  });
  const output = build.outputs[0];
  if (!build.success || build.outputs.length !== 1 || !output)
    throw new Error("Session fixture build failed");
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "shared-session-native",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: await output.text() } },
          },
          env: {
            AUTH_DB: { type: "d1", id: "shared-session-native-test" },
            ISSUER: { type: "fetcher", handler: issuer.send },
            NOW: { type: "text", value: String(NOW) },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = (await runtime.getD1Database("AUTH_DB")).withSession("first-primary");
    for (const ddl of SHARED_AUTH_TEST_ONLY_DDL) await database.prepare(ddl).run();
    const worker = await runtime.getWorker("shared-session-native");
    const send = (path: string, init: { method?: string; headers?: Record<string, string> } = {}) =>
      worker.fetch(`${api}${path}`, { redirect: "manual", ...init });
    return {
      runtime,
      database,
      issuer,
      send,
      advance(value: number) {
        now = value;
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

function findCookie(response: { headers: { getSetCookie(): string[] } }, name: string): string {
  const value = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  if (!value) throw new Error("Expected host-only test cookie");
  return value.split(";")[0] ?? "";
}

test("workerd session seals attempts/grants and authenticates with real D1 across requests", async () => {
  const f = await fixture();
  try {
    const login = await f.send("/auth/oidc/login");
    expect(login.status).toBe(303);
    const attempt = findCookie(login, "__Host-takoserver_oidc_attempt");
    const callback = f.issuer.authorize(login.headers.get("location") ?? "");
    const result = await f.send(new URL(callback).pathname + new URL(callback).search, {
      headers: { cookie: attempt },
    });
    expect(result.status).toBe(303);
    expect(result.headers.get("location")).toBe(`${SESSION_TEST_CONSOLE}/`);
    const cookie = findCookie(result, "__Host-takoserver_shared_session");
    const body = await (await f.send("/test/context", { headers: { cookie } })).json();
    expect(body).toMatchObject({
      accountId: "canonical-account-123",
      actor: { principalId: "retained-local-principal", kind: "session", scopes: [] },
      provenance: { kind: "shared-account-session" },
    });
    const stored = await f.database
      .prepare("SELECT payload FROM shared_auth_sessions")
      .first<{ payload: string }>();
    const issued = f.issuer.issued[0];
    if (!stored || !issued) throw new Error("Expected sealed native grant");
    expect(stored.payload).not.toContain(issued.refreshToken);
    expect(stored.payload).not.toContain(issued.accessToken);
    expect(
      (
        await f.send(new URL(callback).pathname + new URL(callback).search, {
          headers: { cookie: attempt },
        })
      ).status,
    ).toBe(400);
    f.advance(NOW + 280_000);
    const refreshed = await f.send("/test/context", {
      headers: { cookie, "x-test-clock": String(NOW + 280_000) },
    });
    expect(refreshed.status).toBe(200);
    expect(await refreshed.json()).toMatchObject({ accountId: "canonical-account-123" });
    expect(f.issuer.issued).toHaveLength(2);
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("workerd logout immediately denies and drains its durable revocation separately", async () => {
  const f = await fixture();
  try {
    const login = await f.send("/auth/oidc/login");
    const callback = new URL(f.issuer.authorize(login.headers.get("location") ?? ""));
    const result = await f.send(callback.pathname + callback.search, {
      headers: { cookie: findCookie(login, "__Host-takoserver_oidc_attempt") },
    });
    const cookie = findCookie(result, "__Host-takoserver_shared_session");
    f.issuer.control.revocationAvailable = false;
    const logout = await f.send("/auth/oidc/logout", {
      method: "POST",
      headers: { cookie, "x-test-origin": SESSION_TEST_CONSOLE },
    });
    expect(logout.status).toBe(204);
    expect(logout.headers.get("access-control-allow-origin")).toBe(SESSION_TEST_CONSOLE);
    expect(f.issuer.revoked).toHaveLength(0);
    expect(await (await f.send("/test/context", { headers: { cookie } })).json()).toBeNull();
    expect(await (await f.send("/test/drain")).json()).toEqual({ completed: 0, pending: 1 });
    f.issuer.control.revocationAvailable = true;
    f.advance(NOW + 30_001);
    expect(
      await (
        await f.send("/test/drain", { headers: { "x-test-clock": String(NOW + 30_001) } })
      ).json(),
    ).toEqual({ completed: 1, pending: 0 });
    expect(f.issuer.revoked).toHaveLength(2);
    const row = await f.database
      .prepare("SELECT status FROM shared_auth_sessions")
      .first<{ status: string }>();
    expect(row?.status).toBe("revoked");
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);
