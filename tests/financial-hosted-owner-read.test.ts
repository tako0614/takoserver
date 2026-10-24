import { afterEach, expect, test } from "bun:test";
import { createAccounts } from "../src/auth.ts";
import {
  createFinancialHostedOwnerRead,
  type FinancialHostedOwnerReadScope,
  FinancialHostedOwnerReadUnavailable,
} from "../src/financial-hosted-owner-read.ts";
import { createSharedAuthSession } from "../src/shared-auth-session.ts";
import {
  createSharedAuthFinalSessionStore,
  createSharedAuthSessionStore,
} from "../src/shared-auth-session-store.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";
import { createSharedAuthSessionStoreD1Fixture } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_PERSONAL,
} from "./helpers/shared-auth-session-issuer.ts";

const NOW = 1_800_000_000_000;
const ORG = "org-owner-read";
const PRINCIPAL = "principal-owner-read";
const WORKSPACE_REF = "workspace-ref-owner-read";
const SELECTOR = "a".repeat(64);
const disposables: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  for (const item of disposables.splice(0)) await item.dispose();
});

function cookie(response: Response, name: string): string {
  const value = response.headers
    .getSetCookie()
    .map((part) => part.split(";")[0] ?? "")
    .find((part) => part.startsWith(`${name}=`));
  if (!value || value === `${name}=`) throw new Error("missing actual shared session");
  return value;
}

async function fixture() {
  const d1 = await createSharedAuthSessionStoreD1Fixture();
  disposables.push(d1.runtime);
  const database = await d1.runtime.getD1Database("AUTH_DB");
  const sql = createD1Sql(database.withSession("first-primary") as unknown as D1DatabaseLike, {
    acknowledgement: "explicit-d1-result",
  });
  await sql.run(`CREATE TABLE principals (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, provider_subject TEXT NOT NULL,
    email TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL
  )`);
  await sql.run(`CREATE TABLE orgs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, owner_principal_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`);
  await sql.run(`CREATE TABLE org_memberships (
    org_id TEXT NOT NULL, principal_id TEXT NOT NULL, role TEXT NOT NULL,
    created_at TEXT NOT NULL, PRIMARY KEY (org_id, principal_id)
  )`);
  await sql.run("INSERT INTO principals VALUES (?,'shared-account',?,'','',?)", [
    PRINCIPAL,
    "synthetic-binding",
    new Date(NOW).toISOString(),
  ]);
  await sql.run("INSERT INTO orgs VALUES (?,'Owned',?,?)", [
    ORG,
    PRINCIPAL,
    new Date(NOW).toISOString(),
  ]);
  await sql.run("INSERT INTO org_memberships VALUES (?,?,'owner',?)", [
    ORG,
    PRINCIPAL,
    new Date(NOW).toISOString(),
  ]);
  const issuer = await createSharedSessionTestIssuer(() => NOW);
  issuer.control.personalBillingOrganization = {
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORG,
  };
  const accounts = createAccounts({
    sql,
    clock: () => new Date(NOW),
    identity: {
      async verify() {
        throw new Error("unused local identity");
      },
    },
  });
  const sharedAuth = createSharedAuthSession({
    config: SESSION_TEST_CONFIG,
    consoleOrigin: SESSION_TEST_CONSOLE,
    encryptionKey: new Uint8Array(32).fill(7),
    now: () => NOW,
    store: () => createSharedAuthSessionStore(sql),
    finalStore: () => createSharedAuthFinalSessionStore(sql),
    fetch: issuer.send,
    principals: {
      async resolve(input) {
        if (input.accountId !== SESSION_TEST_ACCOUNT) throw new Error("foreign account");
        return { accountId: input.accountId, principalId: PRINCIPAL };
      },
    },
    organizations: {
      async pin(input) {
        return input;
      },
    },
  });
  const login = await sharedAuth.fetch(
    new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/login`),
  );
  if (login?.status !== 303) throw new Error("login failed");
  const location = login.headers.get("location");
  if (!location) throw new Error("missing redirect");
  const callback = await sharedAuth.fetch(
    new Request(issuer.authorize(location), {
      headers: { cookie: cookie(login, "__Host-takoserver_oidc_attempt") },
    }),
  );
  if (callback?.status !== 303) throw new Error("callback failed");
  const browserCookie = cookie(callback, "__Host-takoserver_shared_session");
  const scope: FinancialHostedOwnerReadScope = {
    canonicalAccountId: SESSION_TEST_ACCOUNT,
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORG,
  };
  function request(options: { cookie?: string; origin?: string; authorization?: string } = {}) {
    return new Request(
      `${SESSION_TEST_CONFIG.publicOrigin}/v1/billing/hosted-continuations/${SELECTOR}`,
      {
        headers: {
          origin: options.origin ?? SESSION_TEST_CONSOLE,
          cookie: options.cookie ?? browserCookie,
          ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
        },
      },
    );
  }
  return { sql, accounts, sharedAuth, scope, request };
}

test("same signed RP Request reads current Principal and Owner; later owner loss denies", async () => {
  const f = await fixture();
  const request = f.request();
  const read = await createFinancialHostedOwnerRead({
    request,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
  });
  expect(Object.isFrozen(read)).toBe(true);
  expect(Object.isFrozen(Object.getPrototypeOf(read))).toBe(true);
  expect(read.accountId).toBe(SESSION_TEST_ACCOUNT);
  await read.assertCurrent(request, f.scope);
  await f.sql.run("UPDATE orgs SET owner_principal_id='principal-other' WHERE id=?", [ORG]);
  await expect(read.assertCurrent(request, f.scope)).rejects.toMatchObject({
    name: "AuthError",
    code: "not_found",
  });
});

for (const [label, change, error] of [
  ["foreign account", { canonicalAccountId: "foreign-account" }, "unavailable"],
  ["foreign Workspace", { workspaceId: "foreign-workspace" }, "permission_denied"],
  ["foreign Workspace ref", { workspaceRef: "foreign-workspace-ref" }, "unavailable"],
  ["foreign Organization", { organizationId: "foreign-org" }, "unavailable"],
] as const) {
  test(`${label} cannot pass the actual RP observation`, async () => {
    const f = await fixture();
    const request = f.request();
    const read = await createFinancialHostedOwnerRead({
      request,
      sharedAuth: f.sharedAuth,
      accounts: f.accounts,
      qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
    });
    if (error === "permission_denied") {
      await expect(read.assertCurrent(request, { ...f.scope, ...change })).rejects.toMatchObject({
        name: "AuthError",
        code: "permission_denied",
      });
    } else {
      await expect(read.assertCurrent(request, { ...f.scope, ...change })).rejects.toBeInstanceOf(
        FinancialHostedOwnerReadUnavailable,
      );
    }
  });
}

test("first full scope is pinned; cloned Request and changed receiver are refused", async () => {
  const f = await fixture();
  const request = f.request();
  const read = await createFinancialHostedOwnerRead({
    request,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
  });
  await read.assertCurrent(request, f.scope);
  await expect(read.assertCurrent(request.clone(), f.scope)).rejects.toBeInstanceOf(
    FinancialHostedOwnerReadUnavailable,
  );
  await expect(
    read.assertCurrent(request, { ...f.scope, workspaceRef: "workspace-ref-other" }),
  ).rejects.toBeInstanceOf(FinancialHostedOwnerReadUnavailable);
  Object.defineProperty(f.accounts, "principal", { value: async () => null });
  await expect(read.assertCurrent(request, f.scope)).rejects.toBeInstanceOf(
    FinancialHostedOwnerReadUnavailable,
  );
});

test("scope values must be own data and accessors are never invoked", async () => {
  const f = await fixture();
  const request = f.request();
  const read = await createFinancialHostedOwnerRead({
    request,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
  });
  let invoked = 0;
  const scope = { ...f.scope };
  Object.defineProperty(scope, "workspaceRef", {
    get() {
      invoked++;
      return WORKSPACE_REF;
    },
  });
  await expect(read.assertCurrent(request, scope)).rejects.toBeInstanceOf(
    FinancialHostedOwnerReadUnavailable,
  );
  expect(invoked).toBe(0);
});

test("Request headers changed during the real observer await are refused", async () => {
  const f = await fixture();
  const request = f.request();
  const actualObserve = f.sharedAuth.observeFinalWorkspaceOrganization;
  let entered!: () => void;
  let release!: () => void;
  const waiting = new Promise<void>((resolve) => (entered = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  Object.defineProperty(f.sharedAuth, "observeFinalWorkspaceOrganization", {
    configurable: true,
    value: async (...args: Parameters<typeof actualObserve>) => {
      entered();
      await gate;
      return Reflect.apply(actualObserve, f.sharedAuth, args);
    },
  });
  const read = await createFinancialHostedOwnerRead({
    request,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
  });
  const pending = read.assertCurrent(request, f.scope);
  await waiting;
  request.headers.set("x-drift", "changed");
  release();
  await expect(pending).rejects.toBeInstanceOf(FinancialHostedOwnerReadUnavailable);
});

test("missing shared cookie, mixed credential and foreign Origin refuse before authenticate", async () => {
  const f = await fixture();
  for (const request of [
    f.request({ cookie: "" }),
    f.request({ cookie: "takoserver_session=legacy" }),
    f.request({ authorization: "Bearer other" }),
    f.request({ origin: "https://foreign.example" }),
  ]) {
    await expect(
      createFinancialHostedOwnerRead({
        request,
        sharedAuth: f.sharedAuth,
        accounts: f.accounts,
        qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
      }),
    ).rejects.toMatchObject({ name: "AuthError", code: "unauthenticated" });
  }
});
