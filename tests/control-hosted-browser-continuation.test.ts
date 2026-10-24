import { afterEach, expect, test } from "bun:test";
import { createAccounts } from "../src/auth.ts";
import { createControlRoutes } from "../src/control.ts";
import { HOSTED_BROWSER_CONTINUATION_HEADER } from "../src/financial-hosted-browser-selector.ts";
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
  SESSION_TEST_ORGANIZATION,
  SESSION_TEST_PERSONAL,
} from "./helpers/shared-auth-session-issuer.ts";

const NOW = 1_800_000_000_000;
const ORG = "org-browser-continuation";
const PRINCIPAL = "principal-browser-continuation";
const WORKSPACE_REF = "workspace-ref-continuation";
const SELECTOR = "a".repeat(64);
const TOPUP_REF = `takosumi:topup:${SELECTOR}`;
const disposables: { dispose(): Promise<void> }[] = [];

afterEach(async () => {
  for (const item of disposables.splice(0)) await item.dispose();
});

function cookie(response: Response, name: string): string {
  const value = response.headers
    .getSetCookie()
    .map((item) => item.split(";")[0] ?? "")
    .find((item) => item.startsWith(`${name}=`));
  if (!value || value === `${name}=`) throw new Error(`missing ${name}`);
  return value;
}

async function fixture(selectedOrganization = false, nullSubscription = false) {
  const organizationId = selectedOrganization ? "retained-takoserver-organization-789" : ORG;
  const workspaceId = selectedOrganization
    ? SESSION_TEST_ORGANIZATION.id
    : SESSION_TEST_PERSONAL.id;
  const workspaceRef = selectedOrganization ? "immutable-shared-workspace-ref-456" : WORKSPACE_REF;
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
    organizationId,
    PRINCIPAL,
    new Date(NOW).toISOString(),
  ]);
  await sql.run("INSERT INTO org_memberships VALUES (?,?,'owner',?)", [
    organizationId,
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
  let observeCalls = 0;
  const actualObserve = sharedAuth.observeFinalWorkspaceOrganization;
  Object.defineProperty(sharedAuth, "observeFinalWorkspaceOrganization", {
    value: (...args: Parameters<typeof actualObserve>) => {
      observeCalls++;
      return Reflect.apply(actualObserve, sharedAuth, args);
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
  const scope = {
    continuationRef: SELECTOR,
    canonicalAccountId: SESSION_TEST_ACCOUNT,
    workspaceId,
    workspaceRef,
    organizationId,
    billingSourceRef: "source-a",
    sourceEpoch: "epoch-a",
  };
  const original = {
    contractVersion: "hosted-browser-v1",
    scope,
    action: {
      family: "topup",
      request: {
        workspaceId: scope.workspaceId,
        operationKey: "operation-a",
        amountMinor: 50,
        checkoutConsent: "interactive-checkout",
      },
      claim: {
        ownerId: "historical-owner",
        organizationId,
        billingSourceRef: scope.billingSourceRef,
        operationKey: "operation-a",
        reference: TOPUP_REF,
        amountMinor: 50,
      },
    },
  };
  let result: unknown = { kind: "view", contractVersion: "hosted-browser-v1", scope };
  const calls = { read: 0, claim: 0, effect: 0 };
  let subscriptionReads = 0;
  // A controlled DATA transport stub tests the Server HTTP fence. It is not a
  // native Hosted endpoint or proof of Hosted's own current source validation.
  const control = createControlRoutes({
    publicOrigin: SESSION_TEST_CONFIG.publicOrigin,
    consoleOrigin: SESSION_TEST_CONSOLE,
    sharedAuth,
    accounts,
    hostedBrowserBillingRpc: {
      async readBrowserBillingContinuation() {
        calls.read++;
        return result;
      },
      async claimBrowserBillingContinuation() {
        calls.claim++;
        throw new Error("no native Hosted endpoint");
      },
      async recordBrowserBillingContinuationOutcome() {
        throw new Error("no native Hosted endpoint");
      },
    },
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
    clock: () => new Date(NOW),
    checkout: {
      referenceRequired: true,
      bounds: { minimumMinor: 1, maximumMinor: 1000 },
      async begin() {
        calls.effect++;
        return { url: "https://checkout.example.test/session" };
      },
    },
    ...(nullSubscription
      ? {
          subscriptionCustody: {
            planTable: {
              scope: "hosted" as const,
              products: ["takosumi-hosted", "takoserver"],
              balanceScope: "organization" as const,
              plans: [],
              consumptionOrder: ["free", "subscription", "purchased", "postpaid"],
            },
            async read() {
              subscriptionReads++;
              return null;
            },
            async begin() {
              throw new Error("unreachable subscription begin");
            },
            async change() {
              throw new Error("unreachable subscription change");
            },
          },
        }
      : {}),
  });
  async function send(
    path: string,
    method = "GET",
    options: {
      readonly cookie?: string;
      readonly origin?: string;
      readonly authorization?: string;
      readonly selected?: boolean;
      readonly body?: unknown;
    } = {},
  ): Promise<Response> {
    const request = new Request(`${SESSION_TEST_CONFIG.publicOrigin}${path}`, {
      method,
      headers: {
        ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
        ...(options.origin === undefined ? {} : { origin: options.origin }),
        ...(options.authorization === undefined ? {} : { authorization: options.authorization }),
        ...(options.selected
          ? { [HOSTED_BROWSER_CONTINUATION_HEADER]: `hosted-browser-v1.${SELECTOR}` }
          : {}),
        ...(options.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
    });
    const response = await control(request, new URL(request.url));
    if (!response) throw new Error("route missing");
    return response;
  }
  return {
    browserCookie,
    scope,
    original,
    calls,
    observeCalls: () => observeCalls,
    subscriptionReads: () => subscriptionReads,
    send,
    async revokeOwner() {
      await sql.run(
        "UPDATE org_memberships SET role = 'member' WHERE org_id = ? AND principal_id = ?",
        [organizationId, PRINCIPAL],
      );
    },
    selectPayment() {
      result = { kind: "payment", original, custody: { phase: "prepared" } };
    },
    selectHistory() {
      result = {
        kind: "payment",
        original,
        custody: {
          phase: "dispatch-started",
          accepted: {
            family: "topup",
            command: {
              ...original.action.claim,
              purpose: "usd-top-up",
              generation: 1,
              previousOperationKey: null,
              terminalReference: null,
              terminalState: null,
            },
          },
        },
      };
    },
    refuse(kind: "denied" | "invalid" | "conflict" | "unavailable") {
      result = { kind };
    },
    selectCancellation() {
      result = {
        kind: "payment",
        original: {
          contractVersion: "hosted-browser-v1",
          scope,
          action: {
            family: "subscription",
            request: {
              workspaceId: scope.workspaceId,
              operationKey: "operation-c",
              consent: "cancel-subscription",
            },
            claim: {
              ownerId: "historical-owner",
              organizationId: scope.organizationId,
              billingSourceRef: scope.billingSourceRef,
              sourceEpoch: scope.sourceEpoch,
              kind: "cancel",
              operationKey: "operation-c",
              reference: `takosumi:subscription:${SELECTOR}`,
              expectedSubscriptionRef: `sra_${SELECTOR}`,
            },
          },
        },
        custody: { phase: "prepared" },
      };
    },
  };
}

test("signed RP and real Accounts Owner yield only the closed view/payment metadata DTO", async () => {
  const f = await fixture();
  const path = `/v1/billing/hosted-continuations/${SELECTOR}`;
  const auth = { cookie: f.browserCookie, origin: SESSION_TEST_CONSOLE };
  const view = await f.send(path, "GET", auth);
  expect(view.status).toBe(200);
  expect((await view.json()).continuation).toEqual({
    contractVersion: "hosted-browser-v1",
    continuationRef: SELECTOR,
    kind: "view",
    workspaceId: f.scope.workspaceId,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORG,
    operation: null,
    phase: null,
  });
  f.selectPayment();
  const payment = await f.send(path, "GET", auth);
  expect(payment.status).toBe(200);
  expect((await payment.json()).continuation).toEqual({
    contractVersion: "hosted-browser-v1",
    continuationRef: SELECTOR,
    kind: "payment",
    workspaceId: f.scope.workspaceId,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORG,
    phase: "prepared",
    operation: {
      action: "topup",
      method: "POST",
      path: `/v1/organizations/${ORG}/wallet/checkout`,
      body: { reference: TOPUP_REF, amountMinor: 50 },
    },
  });
  expect(f.calls).toEqual({ read: 2, claim: 0, effect: 0 });
});

test("metadata and preparation refuse another canonical account or selected scope before disclosure", async () => {
  const f = await fixture();
  const path = `/v1/billing/hosted-continuations/${SELECTOR}`;
  const auth = { cookie: f.browserCookie, origin: SESSION_TEST_CONSOLE };
  for (const field of ["canonicalAccountId", "workspaceRef", "organizationId"] as const) {
    const original = f.scope[field];
    f.scope[field] = `foreign-${original}`;
    for (const method of ["GET", "POST"]) {
      const response = await f.send(path, method, {
        ...auth,
        ...(method === "POST"
          ? { body: { kind: "topup", amountMinor: 50, checkoutConsent: "interactive-checkout" } }
          : {}),
      });
      expect(response.status).toBe(503);
      const body = await response.json();
      expect(body).toMatchObject({ error: { code: "backend_unavailable" } });
      expect(body).not.toHaveProperty("continuation");
      expect(f.calls.claim).toBe(0);
      expect(f.calls.effect).toBe(0);
    }
    f.scope[field] = original;
  }
  expect(f.calls).toEqual({ read: 6, claim: 0, effect: 0 });
});

test("metadata and preparation recheck real Accounts ownership before disclosure", async () => {
  const f = await fixture();
  await f.revokeOwner();
  const path = `/v1/billing/hosted-continuations/${SELECTOR}`;
  for (const method of ["GET", "POST"]) {
    const response = await f.send(path, method, {
      cookie: f.browserCookie,
      origin: SESSION_TEST_CONSOLE,
      ...(method === "POST"
        ? { body: { kind: "topup", amountMinor: 50, checkoutConsent: "interactive-checkout" } }
        : {}),
    });
    expect(response.status).toBe(404);
    const body = await response.json();
    expect(body).toMatchObject({ error: { code: "not_found" } });
    expect(body).not.toHaveProperty("continuation");
    expect(f.calls.claim).toBe(0);
    expect(f.calls.effect).toBe(0);
  }
  expect(f.calls).toEqual({ read: 2, claim: 0, effect: 0 });
});

test("initial session Workspace can differ from the genuinely selected Organization Workspace", async () => {
  const f = await fixture(true);
  const response = await f.send(`/v1/billing/hosted-continuations/${SELECTOR}`, "GET", {
    cookie: f.browserCookie,
    origin: SESSION_TEST_CONSOLE,
  });
  expect(response.status).toBe(200);
  expect((await response.json()).continuation).toMatchObject({
    kind: "view",
    workspaceId: SESSION_TEST_ORGANIZATION.id,
    workspaceRef: "immutable-shared-workspace-ref-456",
    organizationId: "retained-takoserver-organization-789",
  });
});

test("metadata POST accepts only a closed choice and fails closed without native prepare", async () => {
  const f = await fixture();
  const path = `/v1/billing/hosted-continuations/${SELECTOR}`;
  const auth = { cookie: f.browserCookie, origin: SESSION_TEST_CONSOLE };
  const injected = await f.send(path, "POST", {
    ...auth,
    body: {
      kind: "topup",
      amountMinor: 50,
      checkoutConsent: "interactive-checkout",
      organizationId: ORG,
    },
  });
  expect(injected.status).toBe(400);
  const unavailable = await f.send(path, "POST", {
    ...auth,
    body: { kind: "topup", amountMinor: 50, checkoutConsent: "interactive-checkout" },
  });
  expect(unavailable.status).toBe(503);
  expect((await unavailable.json()).error.code).toBe("backend_unavailable");
  f.selectPayment();
  expect(
    (
      await f.send(path, "POST", {
        ...auth,
        body: { kind: "topup", amountMinor: 50, checkoutConsent: "interactive-checkout" },
      })
    ).status,
  ).toBe(409);
  expect(f.calls).toEqual({ read: 2, claim: 0, effect: 0 });
});

test("real shared RP with a missing current subscription target returns backend unavailable", async () => {
  const f = await fixture(false, true);
  const response = await f.send(`/v1/billing/hosted-continuations/${SELECTOR}`, "POST", {
    cookie: f.browserCookie,
    origin: SESSION_TEST_CONSOLE,
    body: { kind: "cancel", consent: "cancel-subscription" },
  });
  expect(response.status).toBe(503);
  expect((await response.json()).error.code).toBe("backend_unavailable");
  expect(f.subscriptionReads()).toBe(1);
  expect(f.calls).toEqual({ read: 1, claim: 0, effect: 0 });
});

test("selected POST binds exact path/body and never dispatches through a non-native test supplier", async () => {
  const f = await fixture();
  f.selectPayment();
  const auth = { cookie: f.browserCookie, origin: SESSION_TEST_CONSOLE, selected: true };
  const wrongPath = await f.send("/v1/organizations/other-org/wallet/checkout", "POST", {
    ...auth,
    body: { reference: TOPUP_REF, amountMinor: 50 },
  });
  expect(wrongPath.status).toBe(400);
  const wrongBody = await f.send(`/v1/organizations/${ORG}/wallet/checkout`, "POST", {
    ...auth,
    body: { reference: TOPUP_REF, amountMinor: 51 },
  });
  expect(wrongBody.status).toBe(400);
  const firstFailure = await f.send(`/v1/organizations/${ORG}/wallet/checkout`, "POST", {
    ...auth,
    body: { reference: TOPUP_REF, amountMinor: 50 },
  });
  expect(firstFailure.status).toBe(503);
  expect(f.calls.effect).toBe(0);
});

test("missing local effect and receipt ports refuse before a durable Hosted claim", async () => {
  const f = await fixture();
  f.selectPayment();
  const response = await f.send(`/v1/organizations/${ORG}/wallet/checkout`, "POST", {
    cookie: f.browserCookie,
    origin: SESSION_TEST_CONSOLE,
    selected: true,
    body: { reference: TOPUP_REF, amountMinor: 50 },
  });
  expect(response.status).toBe(503);
  // The one observation is the initial selected-scope Owner check. The final
  // authorization producer would observe again before any native claim.
  expect(f.observeCalls()).toBe(1);
  expect(f.calls).toEqual({ read: 1, claim: 0, effect: 0 });

  const cancellation = await fixture();
  cancellation.selectCancellation();
  const cancel = await cancellation.send(
    `/v1/organizations/${ORG}/payments/subscription`,
    "PATCH",
    {
      cookie: cancellation.browserCookie,
      origin: SESSION_TEST_CONSOLE,
      selected: true,
      body: {
        reference: `takosumi:subscription:${SELECTOR}`,
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: `sra_${SELECTOR}`,
      },
    },
  );
  expect(cancel.status).toBe(503);
  expect(cancellation.observeCalls()).toBe(1);
  expect(cancellation.calls).toEqual({ read: 1, claim: 0, effect: 0 });
});

test("selected PATCH cancellation stays on the original PATCH route and fails before effect", async () => {
  const f = await fixture();
  f.selectCancellation();
  const path = `/v1/organizations/${ORG}/payments/subscription`;
  const auth = { cookie: f.browserCookie, origin: SESSION_TEST_CONSOLE, selected: true };
  const body = {
    reference: `takosumi:subscription:${SELECTOR}`,
    cancelAtPeriodEnd: true,
    expectedSubscriptionRef: `sra_${SELECTOR}`,
  };
  expect((await f.send(path, "POST", { ...auth, body })).status).toBe(400);
  expect((await f.send(path, "PATCH", { ...auth, body })).status).toBe(503);
  expect(f.calls.effect).toBe(0);
});

test("accepted history is read-only and selected POST returns conflict before claim", async () => {
  const f = await fixture();
  f.selectHistory();
  const response = await f.send(`/v1/organizations/${ORG}/wallet/checkout`, "POST", {
    cookie: f.browserCookie,
    origin: SESSION_TEST_CONSOLE,
    selected: true,
    body: { reference: TOPUP_REF, amountMinor: 50 },
  });
  expect(response.status).toBe(409);
  expect(f.calls.claim).toBe(0);
  expect(f.calls.effect).toBe(0);
});

test("selected metadata denies foreign Origin and automatic legacy/shared mode ambiguity", async () => {
  const f = await fixture();
  const path = `/v1/billing/hosted-continuations/${SELECTOR}`;
  expect(
    (await f.send(path, "GET", { cookie: f.browserCookie, origin: "https://other.test" })).status,
  ).toBe(401);
  expect(
    (
      await f.send(path, "GET", {
        cookie: `${f.browserCookie}; takoserver_session=legacy`,
        origin: SESSION_TEST_CONSOLE,
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await f.send(path, "GET", {
        cookie: f.browserCookie,
        origin: SESSION_TEST_CONSOLE,
        authorization: "",
      })
    ).status,
  ).toBe(401);
  expect(f.calls).toEqual({ read: 0, claim: 0, effect: 0 });
  expect(
    (
      await f.send(`${path}?extra=1`, "GET", {
        cookie: f.browserCookie,
        origin: SESSION_TEST_CONSOLE,
      })
    ).status,
  ).toBe(400);
});

test("closed Hosted refusal tags map to existing generic statuses without an effect", async () => {
  const f = await fixture();
  const path = `/v1/billing/hosted-continuations/${SELECTOR}`;
  for (const [kind, status] of [
    ["denied", 403],
    ["invalid", 400],
    ["conflict", 409],
    ["unavailable", 503],
  ] as const) {
    f.refuse(kind);
    const response = await f.send(path, "GET", {
      cookie: f.browserCookie,
      origin: SESSION_TEST_CONSOLE,
    });
    expect(response.status).toBe(status);
  }
  expect(f.calls.effect).toBe(0);
});
