import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { miniflareServiceBinding } from "./helpers/miniflare-service-binding.ts";
import { SHARED_AUTH_TEST_ONLY_DDL } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_PERSONAL,
} from "./helpers/shared-auth-session-issuer.ts";

const NOW = 1_800_000_000_000;
const PRINCIPAL = "native-browser-principal";
const ORGANIZATION = "native-browser-organization";
const WORKSPACE_REF = "native-browser-workspace-ref";
const COOKIE = "__Host-takoserver_shared_session";

function cookie(response: { headers: { getSetCookie(): string[] } }, name: string): string {
  const value = response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0] ?? "")
    .find((item) => item.startsWith(`${name}=`));
  if (!value || value === `${name}=`) throw new Error(`missing ${name}`);
  return value;
}

async function fixture() {
  const issuer = await createSharedSessionTestIssuer(() => NOW);
  issuer.control.personalBillingOrganization = {
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORGANIZATION,
  };
  const built = await Bun.build({
    entrypoints: [
      new URL("./fixtures/financial-hosted-browser-rpc-worker.ts", import.meta.url).pathname,
    ],
    target: "browser",
    format: "esm",
    minify: false,
    external: ["cloudflare:workers"],
  });
  const output = built.outputs[0];
  if (!built.success || built.outputs.length !== 1 || !output)
    throw new Error(`native browser fixture build failed: ${built.logs.join("\n")}`);
  const contents = await output.text();
  let databaseForRevocation: Awaited<ReturnType<Miniflare["getD1Database"]>> | undefined;
  let completedRevocations = 0;
  let callbackPhase = false;
  let signalCallbackAwaiting: (() => void) | undefined;
  const callbackAwaiting = new Promise<void>((resolve) => {
    signalCallbackAwaiting = resolve;
  });
  let releaseCallback: (() => void) | undefined;
  const callbackRelease = new Promise<void>((resolve) => {
    releaseCallback = resolve;
  });
  issuer.control.onPersonalBillingOrganization = async () => {
    if (!callbackPhase) return;
    signalCallbackAwaiting?.();
    await callbackRelease;
  };
  const gate = async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path === "/entered") callbackPhase = true;
    else if (path === "/wait") await callbackAwaiting;
    else if (path === "/release") {
      callbackPhase = false;
      releaseCallback?.();
    } else return new Response(null, { status: 404 });
    return new Response(null, { status: 204 });
  };
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "native-browser-caller",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
          env: {
            AUTH_DB: { type: "d1", id: "native-browser-accounts" },
            ISSUER: { type: "fetcher", handler: issuer.send },
            GATE: { type: "fetcher", handler: gate },
            HOSTED: miniflareServiceBinding("worker", "native-browser-hosted", "Hosted"),
          },
          triggers: [],
        },
      },
      {
        config: {
          name: "native-browser-hosted",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
          env: {
            AUTH_DB: { type: "d1", id: "native-browser-accounts" },
            GATE: { type: "fetcher", handler: gate },
            REVOKER: {
              type: "fetcher",
              handler: async () => {
                if (!databaseForRevocation) throw new Error("local D1 fixture is not ready");
                await databaseForRevocation
                  .prepare(
                    "UPDATE org_memberships SET role = 'member' WHERE org_id = ? AND principal_id = ?",
                  )
                  .bind(ORGANIZATION, PRINCIPAL)
                  .run();
                completedRevocations++;
                return new Response(null, { status: 204 });
              },
            },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    databaseForRevocation = await runtime.getD1Database("AUTH_DB", "native-browser-caller");
    const database = databaseForRevocation.withSession("first-primary");
    for (const ddl of SHARED_AUTH_TEST_ONLY_DDL) await database.prepare(ddl).run();
    await database
      .prepare(`CREATE TABLE principals (
      id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
      email TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL
    )`)
      .run();
    await database
      .prepare(`CREATE TABLE orgs (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`)
      .run();
    await database
      .prepare(`CREATE TABLE org_memberships (
      org_id TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL,
      created_at TEXT NOT NULL, PRIMARY KEY (org_id, principal_id)
    )`)
      .run();
    await database
      .prepare("INSERT INTO principals VALUES (?,'shared-account',?,'','',?)")
      .bind(PRINCIPAL, `${PRINCIPAL}-binding`, new Date(NOW).toISOString())
      .run();
    await database
      .prepare("INSERT INTO orgs VALUES (?,'Owned',?,?)")
      .bind(ORGANIZATION, PRINCIPAL, new Date(NOW).toISOString())
      .run();
    await database
      .prepare("INSERT INTO org_memberships VALUES (?,?,'owner',?)")
      .bind(ORGANIZATION, PRINCIPAL, new Date(NOW).toISOString())
      .run();
    const worker = await runtime.getWorker("native-browser-caller");
    const send = (
      path: string,
      init: { method?: string; headers?: Record<string, string>; body?: string } = {},
    ) =>
      worker.fetch(`${SESSION_TEST_CONFIG.publicOrigin}${path}`, { redirect: "manual", ...init });
    const login = await send("/auth/oidc/login");
    if (login.status !== 303) throw new Error(`native login failed: ${login.status}`);
    const callback = new URL(issuer.authorize(login.headers.get("location") ?? ""));
    const signed = await send(callback.pathname + callback.search, {
      headers: { cookie: cookie(login, "__Host-takoserver_oidc_attempt") },
    });
    if (signed.status !== 303) throw new Error(`native callback failed: ${signed.status}`);
    const browserCookie = cookie(signed, COOKIE);
    return {
      runtime,
      database,
      completedRevocations: () => completedRevocations,
      claim(kind: "a" | "b" | "c" | "d" | "e") {
        return send(`/test/claim/${kind}`, {
          method: "POST",
          headers: {
            cookie: browserCookie,
            "x-test-origin": SESSION_TEST_CONSOLE,
            "content-type": "application/json",
          },
          body: JSON.stringify({ reference: `takosumi:topup:${"a".repeat(64)}`, amountMinor: 50 }),
        });
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test("named native Hosted RPC invokes the real prototype callback; closing its wrapper retains only the owning request producer", async () => {
  const f = await fixture();
  try {
    const response = await f.claim("a");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: "fresh-dispatch",
      prototypeVisible: true,
      producerAfterRemote: "current",
      closedRemote: "unavailable",
      closedProducer: "unavailable",
    });
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("current D1 Owner revocation during awaited native claim denies the callback", async () => {
  const f = await fixture();
  try {
    const response = await f.claim("b");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: "unavailable",
      prototypeVisible: true,
      producerAfterRemote: "unavailable",
      closedRemote: "unavailable",
      closedProducer: "unavailable",
    });
    expect(f.completedRevocations()).toBe(1);
    const owner = await f.database
      .prepare("SELECT role FROM org_memberships WHERE org_id = ?")
      .bind(ORGANIZATION)
      .first<{ role: string }>();
    expect(owner?.role).toBe("member");
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("a callback awaiting real RP state denies when its wrapper closes but producer stays current", async () => {
  const f = await fixture();
  try {
    const response = await f.claim("c");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      result: "unavailable",
      prototypeVisible: true,
      producerAfterRemote: "current",
      closedRemote: "unavailable",
      closedProducer: "unavailable",
    });
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("native accepted history stays distinct from fresh dispatch", async () => {
  const f = await fixture();
  try {
    const accepted = await f.claim("e");
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({
      result: "accepted-history",
      prototypeVisible: true,
      producerAfterRemote: "current",
    });
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("unknown native claim cannot become fresh dispatch", async () => {
  const f = await fixture();
  try {
    const response = await f.claim("d");
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      result: "unavailable",
      prototypeVisible: true,
      producerAfterRemote: "current",
      closedRemote: "unavailable",
      closedProducer: "unavailable",
    });
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);
