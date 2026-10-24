import { afterEach, expect, test } from "bun:test";
import { createAccounts } from "../src/auth.ts";
import {
  createFinancialHostedBrowserSelection,
  FinancialHostedBrowserSelectionUnavailable,
} from "../src/financial-hosted-browser-selection.ts";
import { createSharedAuthSession } from "../src/shared-auth-session.ts";
import {
  createSharedAuthFinalSessionStore,
  createSharedAuthSessionStore,
} from "../src/shared-auth-session-store.ts";
import { createD1Sql, type D1DatabaseLike } from "../src/sql-d1.ts";
import type { SubscriptionPayments } from "../src/stripe-billing.ts";
import { createSharedAuthSessionStoreD1Fixture } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_PERSONAL,
} from "./helpers/shared-auth-session-issuer.ts";

const NOW = 1_800_000_000_000;
const ORG = "org-browser-selection";
const PRINCIPAL = "principal-browser-selection";
const WORKSPACE_REF = "workspace-ref-selection";
const SELECTOR = "a".repeat(64);
const TARGET_A = `sra_${"a".repeat(64)}`;
const TARGET_B = `sra_${"b".repeat(64)}`;
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
  const scope = {
    continuationRef: SELECTOR,
    canonicalAccountId: SESSION_TEST_ACCOUNT,
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORG,
    billingSourceRef: "source-a",
    sourceEpoch: "epoch-a",
  };
  let target: string | null = TARGET_A;
  let reads = 0;
  let blockedRead: { readonly entered: () => void; readonly wait: Promise<void> } | null = null;
  const subscriptions: SubscriptionPayments = {
    planTable: {
      scope: "hosted",
      products: ["takosumi-hosted", "takoserver"],
      balanceScope: "organization",
      plans: [
        {
          planId: "starter",
          tier: "subscription",
          monthlyAmountMinor: 1000,
          includedCreditMinor: 0,
          stripePriceId: "price_synthetic",
        },
      ],
      consumptionOrder: ["free", "subscription", "purchased", "postpaid"],
    },
    async read(organizationId) {
      reads++;
      const blocked = blockedRead;
      if (blocked) {
        blockedRead = null;
        blocked.entered();
        await blocked.wait;
      }
      return target === null ? null : { organizationId, subscriptionRef: target };
    },
    async begin() {
      throw new Error("no business effect in selection test");
    },
    async change() {
      throw new Error("no business effect in selection test");
    },
  };
  const checkout = {
    referenceRequired: true as const,
    bounds: { minimumMinor: 1, maximumMinor: 1000 },
    async begin() {
      throw new Error("no business effect in selection test");
    },
  };
  function request(choice: unknown, options: { origin?: string; cookie?: string } = {}) {
    return new Request(
      `${SESSION_TEST_CONFIG.publicOrigin}/v1/billing/hosted-continuations/${SELECTOR}`,
      {
        method: "POST",
        headers: {
          origin: options.origin ?? SESSION_TEST_CONSOLE,
          cookie: options.cookie ?? browserCookie,
          "content-type": "application/json",
        },
        body: JSON.stringify(choice),
      },
    );
  }
  return {
    sql,
    accounts,
    sharedAuth,
    scope,
    subscriptions,
    checkout,
    request,
    reads: () => reads,
    pauseNextRead() {
      let enteredResolve = () => {};
      let releaseResolve = () => {};
      const entered = new Promise<void>((resolve) => {
        enteredResolve = resolve;
      });
      const wait = new Promise<void>((resolve) => {
        releaseResolve = resolve;
      });
      blockedRead = { entered: enteredResolve, wait };
      return { entered, release: releaseResolve };
    },
    setTarget(value: string | null) {
      target = value;
    },
  };
}

test("real signed RP and D1 Owner keep top-up choice and configured bounds current", async () => {
  const f = await fixture();
  const choice = {
    kind: "topup",
    amountMinor: 50,
    checkoutConsent: "interactive-checkout",
  } as const;
  const request = f.request(choice);
  const producer = await createFinancialHostedBrowserSelection({
    request,
    scope: f.scope,
    choice,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
    checkout: f.checkout,
  });
  expect(await producer.readSelectionCurrent(structuredClone(f.scope))).toEqual(choice);
  expect(f.reads()).toBe(0);
  f.checkout.bounds.maximumMinor = 40;
  await expect(producer.readSelectionCurrent(f.scope)).rejects.toThrow(
    FinancialHostedBrowserSelectionUnavailable,
  );
  producer.dispose();
});

test("cancel target comes only from current configured subscription read and drift denies", async () => {
  const f = await fixture();
  const choice = { kind: "cancel", consent: "cancel-subscription" } as const;
  const producer = await createFinancialHostedBrowserSelection({
    request: f.request(choice),
    scope: f.scope,
    choice,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
    subscriptions: f.subscriptions,
  });
  expect(await producer.readSelectionCurrent(f.scope)).toEqual({
    ...choice,
    expectedSubscriptionRef: TARGET_A,
  });
  expect(f.reads()).toBeGreaterThan(1);
  await expect(
    producer.readSelectionCurrent({
      ...f.scope,
      organizationId: "other-org",
    }),
  ).rejects.toThrow(FinancialHostedBrowserSelectionUnavailable);
  f.setTarget(TARGET_B);
  await expect(producer.readSelectionCurrent(f.scope)).rejects.toThrow(
    FinancialHostedBrowserSelectionUnavailable,
  );
  producer.dispose();
});

test("Owner revoked during the actual subscription read cannot return a current target", async () => {
  const f = await fixture();
  const choice = { kind: "cancel", consent: "cancel-subscription" } as const;
  const producer = await createFinancialHostedBrowserSelection({
    request: f.request(choice),
    scope: f.scope,
    choice,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
    subscriptions: f.subscriptions,
  });
  const barrier = f.pauseNextRead();
  const pending = producer.readSelectionCurrent(f.scope);
  await barrier.entered;
  await f.sql.run("UPDATE orgs SET owner_principal_id=? WHERE id=?", [
    "other-principal",
    f.scope.organizationId,
  ]);
  barrier.release();
  await expect(pending).rejects.toThrow(FinancialHostedBrowserSelectionUnavailable);
  producer.dispose();
});

test("start and plan change select only configured plan and actual current target", async () => {
  const f = await fixture();
  const start = {
    kind: "start",
    planKey: "starter",
    consent: "subscription-checkout",
  } as const;
  const startProducer = await createFinancialHostedBrowserSelection({
    request: f.request(start),
    scope: f.scope,
    choice: start,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
    subscriptions: f.subscriptions,
  });
  expect(await startProducer.readSelectionCurrent(f.scope)).toEqual(start);
  startProducer.dispose();
  await expect(
    createFinancialHostedBrowserSelection({
      request: f.request({ ...start, planKey: "unconfigured" }),
      scope: f.scope,
      choice: { ...start, planKey: "unconfigured" },
      sharedAuth: f.sharedAuth,
      accounts: f.accounts,
      qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
      subscriptions: f.subscriptions,
    }),
  ).rejects.toThrow(FinancialHostedBrowserSelectionUnavailable);

  const change = {
    kind: "change-plan",
    planKey: "starter",
    consent: "change-subscription-plan",
  } as const;
  const changeProducer = await createFinancialHostedBrowserSelection({
    request: f.request(change),
    scope: f.scope,
    choice: change,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
    subscriptions: f.subscriptions,
  });
  expect(await changeProducer.readSelectionCurrent(f.scope)).toEqual({
    ...change,
    expectedSubscriptionRef: TARGET_A,
  });
  changeProducer.dispose();
});

test("missing target, removed Owner, foreign Origin and disposal deny selection", async () => {
  const f = await fixture();
  const choice = {
    kind: "change-plan",
    planKey: "starter",
    consent: "change-subscription-plan",
  } as const;
  f.setTarget(null);
  await expect(
    createFinancialHostedBrowserSelection({
      request: f.request(choice),
      scope: f.scope,
      choice,
      sharedAuth: f.sharedAuth,
      accounts: f.accounts,
      qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
      subscriptions: f.subscriptions,
    }),
  ).rejects.toThrow(FinancialHostedBrowserSelectionUnavailable);
  f.setTarget(TARGET_A);
  await expect(
    createFinancialHostedBrowserSelection({
      request: f.request(choice, { origin: "https://foreign.test" }),
      scope: f.scope,
      choice,
      sharedAuth: f.sharedAuth,
      accounts: f.accounts,
      qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
      subscriptions: f.subscriptions,
    }),
  ).rejects.toThrow(FinancialHostedBrowserSelectionUnavailable);
  const producer = await createFinancialHostedBrowserSelection({
    request: f.request(choice),
    scope: f.scope,
    choice,
    sharedAuth: f.sharedAuth,
    accounts: f.accounts,
    qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
    subscriptions: f.subscriptions,
  });
  await f.sql.run("UPDATE orgs SET owner_principal_id=? WHERE id=?", [
    "other-principal",
    f.scope.organizationId,
  ]);
  await expect(producer.readSelectionCurrent(f.scope)).rejects.toThrow(
    FinancialHostedBrowserSelectionUnavailable,
  );
  producer.dispose();
  await expect(producer.readSelectionCurrent(f.scope)).rejects.toThrow(
    FinancialHostedBrowserSelectionUnavailable,
  );
});

test("producer refuses a choice detached from the original selection POST body", async () => {
  const f = await fixture();
  await expect(
    createFinancialHostedBrowserSelection({
      request: f.request({
        kind: "topup",
        amountMinor: 51,
        checkoutConsent: "interactive-checkout",
      }),
      scope: f.scope,
      choice: { kind: "topup", amountMinor: 50, checkoutConsent: "interactive-checkout" },
      sharedAuth: f.sharedAuth,
      accounts: f.accounts,
      qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
      checkout: f.checkout,
    }),
  ).rejects.toThrow(FinancialHostedBrowserSelectionUnavailable);
});
