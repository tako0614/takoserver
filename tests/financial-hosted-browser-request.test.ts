import { afterEach, expect, test } from "bun:test";
import { createAccounts } from "../src/auth.ts";
import {
  createFinancialHostedBrowserRequestAuthorization,
  type FinancialHostedBrowserRequestOriginal,
  FinancialHostedBrowserRequestUnavailable,
} from "../src/financial-hosted-browser-request.ts";
import { bytesDigest } from "../src/json.ts";
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
const PRINCIPAL_A = "shared-principal-a";
const PRINCIPAL_B = "shared-principal-b";
const ORG_A = "org-browser-owner-a";
const ORG_B = "org-browser-owner-b";
const WORKSPACE_REF = "workspace-browser-ref-a";
const COOKIE = "__Host-takoserver_shared_session";

function cookie(response: Response, name: string): string {
  const value = response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0] ?? "")
    .find((item) => item.startsWith(`${name}=`));
  if (!value || value === `${name}=`) throw new Error(`missing ${name}`);
  return value;
}

const disposables: { dispose(): Promise<void> }[] = [];
afterEach(async () => {
  for (const item of disposables.splice(0)) await item.dispose();
});

async function fixture() {
  const d1 = await createSharedAuthSessionStoreD1Fixture();
  disposables.push(d1.runtime);
  const database = await d1.runtime.getD1Database("AUTH_DB");
  const sql = createD1Sql(database.withSession("first-primary") as unknown as D1DatabaseLike, {
    acknowledgement: "explicit-d1-result",
  });
  // Only the real Accounts readers used by this unmounted producer need these
  // local D1 rows. The synthetic signed issuer and local projection do not
  // claim deployed Principal enrollment or a genuine Accounts human proof.
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
  for (const [principalId, orgId] of [
    [PRINCIPAL_A, ORG_A],
    [PRINCIPAL_B, ORG_B],
  ] as const) {
    await sql.run(
      "INSERT INTO principals (id,provider,provider_subject,email,display_name,created_at) VALUES (?,'shared-account',?,'','',?)",
      [principalId, `${principalId}-binding`, new Date(NOW).toISOString()],
    );
    await sql.run(
      "INSERT INTO orgs (id,name,owner_principal_id,created_at) VALUES (?,'Owned',?,?)",
      [orgId, principalId, new Date(NOW).toISOString()],
    );
    await sql.run(
      "INSERT INTO org_memberships (org_id,principal_id,role,created_at) VALUES (?,?,'owner',?)",
      [orgId, principalId, new Date(NOW).toISOString()],
    );
  }
  let now = NOW;
  const issuer = await createSharedSessionTestIssuer(() => now);
  issuer.control.personalBillingOrganization = {
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORG_A,
  };
  const accounts = createAccounts({
    sql,
    clock: () => new Date(now),
    identity: {
      async verify() {
        throw new Error("not used by this real Accounts reader test");
      },
    },
  });
  const sharedAuth = createSharedAuthSession({
    config: SESSION_TEST_CONFIG,
    consoleOrigin: SESSION_TEST_CONSOLE,
    encryptionKey: new Uint8Array(32).fill(7),
    now: () => now,
    store: () => createSharedAuthSessionStore(sql),
    finalStore: () => createSharedAuthFinalSessionStore(sql),
    fetch: issuer.send,
    principals: {
      async resolve(input) {
        if (input.accountId !== SESSION_TEST_ACCOUNT) throw new Error("foreign account");
        return { accountId: input.accountId, principalId: PRINCIPAL_A };
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
  if (!location) throw new Error("missing location");
  const callback = await sharedAuth.fetch(
    new Request(issuer.authorize(location), {
      headers: { cookie: cookie(login, "__Host-takoserver_oidc_attempt") },
    }),
  );
  if (callback?.status !== 303) throw new Error("callback failed");
  const browserCookie = cookie(callback, COOKIE);
  const original: FinancialHostedBrowserRequestOriginal = {
    action: { kind: "topup", organizationId: ORG_A, reference: "topup-a", amountMinor: 50 },
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
  };
  const request = new Request(
    `${SESSION_TEST_CONFIG.publicOrigin}/v1/organizations/${ORG_A}/wallet/topups`,
    {
      method: "POST",
      headers: {
        cookie: browserCookie,
        origin: SESSION_TEST_CONSOLE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ reference: "topup-a", amountMinor: 50 }),
    },
  );
  const input = {
    request,
    sharedAuth,
    accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
    original,
  };
  return {
    d1,
    sql,
    issuer,
    accounts,
    sharedAuth,
    request,
    browserCookie,
    original,
    input,
    setTime(value: number) {
      now = value;
    },
  };
}

async function denied(task: () => Promise<unknown>) {
  await expect(task()).rejects.toBeInstanceOf(FinancialHostedBrowserRequestUnavailable);
}

test("real signed RP and D1 Accounts Owner can reassert the same browser original; detached clone is accepted", async () => {
  const f = await fixture();
  const auth = await createFinancialHostedBrowserRequestAuthorization(f.input);
  await auth.assertOriginalCurrent(structuredClone(f.original));
  await auth.assertOriginalCurrent(structuredClone(f.original));
  expect(
    (await f.sql.query("SELECT role FROM org_memberships WHERE org_id = ?", [ORG_A]))[0]?.role,
  ).toBe("owner");
  auth.dispose();
  await denied(() => auth.assertOriginalCurrent(f.original));
});

test("another Principal owning another Organization cannot use the RP account's original", async () => {
  const f = await fixture();
  await denied(() =>
    createFinancialHostedBrowserRequestAuthorization({
      ...f.input,
      original: { ...f.original, action: { ...f.original.action, organizationId: ORG_B } },
    }),
  );
});

test("current Workspace/Organization selection and detached financial fields stay fixed", async () => {
  const f = await fixture();
  const auth = await createFinancialHostedBrowserRequestAuthorization(f.input);
  await denied(() =>
    auth.assertOriginalCurrent({ ...f.original, workspaceRef: "other-workspace-ref" }),
  );
  await denied(() => auth.assertOriginalCurrent({ ...f.original, workspaceId: "other-workspace" }));
  await denied(() =>
    auth.assertOriginalCurrent({
      ...f.original,
      action: {
        kind: "topup",
        organizationId: ORG_A,
        reference: "topup-a",
        amountMinor: 51,
      },
    }),
  );
  f.issuer.control.personalBillingOrganization = {
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORG_B,
  };
  await denied(() => auth.assertOriginalCurrent(f.original));
});

test("a confirmed subscription plan is held as exact action DATA", async () => {
  const f = await fixture();
  const original: FinancialHostedBrowserRequestOriginal = {
    ...f.original,
    action: {
      kind: "subscription-start",
      organizationId: ORG_A,
      reference: "subscription-a",
      planKey: "starter-plan",
    },
  };
  const request = new Request(
    `${SESSION_TEST_CONFIG.publicOrigin}/v1/organizations/${ORG_A}/subscription`,
    {
      method: "POST",
      headers: { cookie: f.browserCookie, origin: SESSION_TEST_CONSOLE },
      body: JSON.stringify({ reference: "subscription-a", planKey: "starter-plan" }),
    },
  );
  const auth = await createFinancialHostedBrowserRequestAuthorization({
    ...f.input,
    request,
    original,
  });
  await auth.assertOriginalCurrent(structuredClone(original));
  await denied(() =>
    auth.assertOriginalCurrent({
      ...original,
      action: {
        kind: "subscription-start",
        organizationId: ORG_A,
        reference: "subscription-a",
        planKey: "other-plan",
      },
    }),
  );
});

test("actual shared RP permits a PATCH cancellation original and rejects wrong method", async () => {
  const f = await fixture();
  const original: FinancialHostedBrowserRequestOriginal = {
    ...f.original,
    action: {
      kind: "cancel",
      organizationId: ORG_A,
      reference: "subscription-cancel-a",
      cancelAtPeriodEnd: true,
      expectedSubscriptionRef: `sra_${"a".repeat(64)}`,
    },
  };
  const url = `${SESSION_TEST_CONFIG.publicOrigin}/v1/organizations/${ORG_A}/payments/subscription`;
  const headers = { cookie: f.browserCookie, origin: SESSION_TEST_CONSOLE };
  const patch = new Request(url, {
    method: "PATCH",
    headers,
    body: JSON.stringify(original.action),
  });
  const auth = await createFinancialHostedBrowserRequestAuthorization({
    ...f.input,
    request: patch,
    original,
  });
  await auth.assertOriginalCurrent(structuredClone(original));
  await denied(() =>
    createFinancialHostedBrowserRequestAuthorization({
      ...f.input,
      request: new Request(url, { method: "POST", headers }),
      original,
    }),
  );
});

test("header drift, explicit credential and foreign Origin fail before current Owner", async () => {
  const f = await fixture();
  const auth = await createFinancialHostedBrowserRequestAuthorization(f.input);
  f.request.headers.set("x-drift", "changed");
  await denied(() => auth.assertOriginalCurrent(f.original));
  auth.dispose();
  for (const headers of [
    { cookie: f.browserCookie, origin: SESSION_TEST_CONSOLE, authorization: "" },
    { cookie: f.browserCookie, origin: "https://foreign.example.test" },
    { cookie: `${f.browserCookie}; takoserver_session=legacy`, origin: SESSION_TEST_CONSOLE },
  ]) {
    const request = new Request(f.request.url, { method: "POST", headers });
    await denied(() => createFinancialHostedBrowserRequestAuthorization({ ...f.input, request }));
  }
});

test("live Owner removal and RP logout invalidate existing custody", async () => {
  const f = await fixture();
  const auth = await createFinancialHostedBrowserRequestAuthorization(f.input);
  await f.sql.run("DELETE FROM org_memberships WHERE org_id = ? AND principal_id = ?", [
    ORG_A,
    PRINCIPAL_A,
  ]);
  await denied(() => auth.assertOriginalCurrent(f.original));
  await f.sql.run(
    "INSERT INTO org_memberships (org_id,principal_id,role,created_at) VALUES (?,?,'owner',?)",
    [ORG_A, PRINCIPAL_A, new Date(NOW).toISOString()],
  );
  const second = await createFinancialHostedBrowserRequestAuthorization(f.input);
  const logout = await f.sharedAuth.fetch(
    new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/logout`, {
      method: "POST",
      headers: { cookie: f.browserCookie, origin: SESSION_TEST_CONSOLE },
    }),
  );
  expect(logout?.status).toBe(204);
  await denied(() => second.assertOriginalCurrent(f.original));
  const digest = await bytesDigest(
    new TextEncoder().encode(f.browserCookie.slice(`${COOKIE}=`.length)),
  );
  expect(
    (await f.sql.query("SELECT status FROM shared_auth_sessions WHERE digest = ?", [digest]))[0]
      ?.status,
  ).toBe("revocation_pending");
});
