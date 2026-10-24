import { WorkerEntrypoint } from "cloudflare:workers";
import { createAccounts } from "../../src/auth.ts";
import { createControlRoutes } from "../../src/control.ts";
import type {
  HostedBrowserBillingCurrentSelection,
  HostedBrowserBillingScope,
} from "../../src/financial-hosted-browser-continuation.ts";
import { parseHostedBrowserBillingOriginal } from "../../src/financial-hosted-browser-continuation.ts";
import type {
  HostedBrowserBillingLookup,
  HostedBrowserLiveAuthorizationTarget,
  HostedBrowserLiveSelectionTarget,
} from "../../src/financial-hosted-browser-rpc.ts";
import { createOrgTopUps, type TopUpSession } from "../../src/org-top-up.ts";
import { createSharedAuthSession } from "../../src/shared-auth-session.ts";
import {
  createSharedAuthFinalSessionStore,
  createSharedAuthSessionStore,
} from "../../src/shared-auth-session-store.ts";
import { createD1Sql, type D1DatabaseLike } from "../../src/sql-d1.ts";
import {
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_PERSONAL,
} from "../helpers/shared-auth-session-issuer.ts";

const NOW = 1_800_000_000_000;
const PRINCIPAL = "native-consumer-principal";
const ORGANIZATION = "native-consumer-organization";
const WORKSPACE_REF = "native-consumer-workspace-ref";
const REFERENCE = `takosumi:topup:${"a".repeat(64)}`;

function originalFor(kind: string, amountMinor = 50) {
  return parseHostedBrowserBillingOriginal({
    contractVersion: "hosted-browser-v1",
    scope: {
      continuationRef: kind.repeat(64),
      canonicalAccountId: SESSION_TEST_ACCOUNT,
      workspaceId: SESSION_TEST_PERSONAL.id,
      workspaceRef: WORKSPACE_REF,
      organizationId: ORGANIZATION,
      billingSourceRef: "fixture-source",
      sourceEpoch: "fixture-epoch",
    },
    action: {
      family: "topup",
      request: {
        workspaceId: SESSION_TEST_PERSONAL.id,
        operationKey: `fixture-operation-${kind}`,
        amountMinor,
        checkoutConsent: "interactive-checkout",
      },
      claim: {
        ownerId: "historical-owner-only",
        organizationId: ORGANIZATION,
        billingSourceRef: "fixture-source",
        operationKey: `fixture-operation-${kind}`,
        reference: REFERENCE,
        amountMinor,
      },
    },
  });
}

function scopeFor(kind: string): HostedBrowserBillingScope {
  return {
    continuationRef: kind.repeat(64),
    canonicalAccountId: SESSION_TEST_ACCOUNT,
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
    organizationId: ORGANIZATION,
    billingSourceRef: "fixture-source",
    sourceEpoch: "fixture-epoch",
  };
}

function acceptedFor(kind: string, original = originalFor(kind)) {
  return {
    family: "topup",
    command: {
      ...original.action.claim,
      purpose: "usd-top-up",
      generation: 1,
      previousOperationKey: null,
      terminalReference: null,
      terminalState: null,
    },
  };
}

interface Env {
  AUTH_DB: { withSession(constraint: "first-primary"): D1DatabaseLike };
  ISSUER: { fetch(request: Request): Promise<Response> };
  REVOKER: { fetch(request: Request): Promise<Response> };
  EVENTS: { fetch(request: Request): Promise<Response> };
  HOSTED: {
    prepareBrowserBillingContinuation(
      input: HostedBrowserBillingLookup,
      selection: HostedBrowserLiveSelectionTarget,
    ): Promise<unknown>;
    readBrowserBillingContinuation(input: HostedBrowserBillingLookup): Promise<unknown>;
    claimBrowserBillingContinuation(
      input: HostedBrowserBillingLookup,
      authorization: HostedBrowserLiveAuthorizationTarget,
    ): Promise<unknown>;
    recordBrowserBillingContinuationOutcome(input: unknown): Promise<unknown>;
    fixtureState(): Promise<unknown>;
  };
}

// Fixture transport state only. This is not Hosted's durable CAS or authority.
const dispatched = new Set<string>();
const sessions = new Map<string, TopUpSession>();
const processor = { create: 0, read: 0, recover: 0 };
const prepared = new Map<string, ReturnType<typeof originalFor>>();
const hostedFixtureState: {
  callback: { continuationRef: string; scope: HostedBrowserBillingScope; choice: unknown } | null;
  callbackAttempted: boolean;
  callbackRejected: boolean;
} = {
  callback: null,
  callbackAttempted: false,
  callbackRejected: false,
};

/** Named native Hosted counterpart with closed DATA, not a product implementation. */
export class Hosted extends WorkerEntrypoint<Env> {
  async prepareBrowserBillingContinuation(
    input: HostedBrowserBillingLookup,
    selection: HostedBrowserLiveSelectionTarget,
  ) {
    const kind = input.continuationRef[0] ?? "";
    if (kind !== "0" && kind !== "1") return { kind: "unavailable" };
    const scope = scopeFor(kind);
    const callbackScope =
      kind === "1" ? { ...scope, organizationId: "different-native-organization" } : scope;
    hostedFixtureState.callbackAttempted = true;
    hostedFixtureState.callback = {
      continuationRef: input.continuationRef,
      scope: callbackScope,
      choice: null,
    };
    let current: HostedBrowserBillingCurrentSelection;
    try {
      current = await selection.readSelectionCurrent(callbackScope);
    } catch {
      hostedFixtureState.callbackRejected = true;
      throw new Error("fixture live selection callback rejected");
    }
    hostedFixtureState.callback = {
      continuationRef: input.continuationRef,
      scope: callbackScope,
      choice: current,
    };
    if (kind === "1") throw new Error("mismatched native callback unexpectedly succeeded");
    if (current.kind !== "topup" || current.checkoutConsent !== "interactive-checkout")
      throw new Error("fixture current selection does not match the accepted TopUp choice");
    const original = originalFor(kind, current.amountMinor);
    prepared.set(input.continuationRef, original);
    return { kind: "prepared", original };
  }

  async fixtureState() {
    return {
      ...hostedFixtureState,
      preparedOriginal: prepared.get("0".repeat(64)) ?? null,
    };
  }

  async readBrowserBillingContinuation(input: HostedBrowserBillingLookup) {
    const kind = input.continuationRef[0] ?? "";
    const saved = prepared.get(input.continuationRef);
    if (saved)
      return {
        kind: "payment",
        original: saved,
        custody: dispatched.has(input.continuationRef)
          ? { phase: "dispatch-started", accepted: acceptedFor(kind, saved) }
          : { phase: "prepared" },
      };
    if (kind === "0" || kind === "1")
      return { kind: "view", contractVersion: "hosted-browser-v1", scope: scopeFor(kind) };
    const original = originalFor(kind);
    if (kind === "d")
      return { kind: "view", contractVersion: "hosted-browser-v1", scope: original.scope };
    return {
      kind: "payment",
      original,
      custody: dispatched.has(input.continuationRef)
        ? { phase: "dispatch-started", accepted: acceptedFor(kind) }
        : { phase: "prepared" },
    };
  }

  async claimBrowserBillingContinuation(
    input: HostedBrowserBillingLookup,
    authorization: HostedBrowserLiveAuthorizationTarget,
  ) {
    const kind = input.continuationRef[0] ?? "";
    const original = prepared.get(input.continuationRef) ?? originalFor(kind);
    await authorization.assertOriginalCurrent(original);
    if (kind === "b")
      return {
        kind: "accepted-history",
        original,
        custody: { phase: "dispatch-started", accepted: acceptedFor(kind) },
      };
    if (kind === "c") return { kind: "unknown" };
    if (kind === "e") {
      const revoked = await this.env.REVOKER.fetch(new Request("https://fixture.invalid/revoke"));
      if (revoked.status !== 204) throw new Error("local Owner revocation did not complete");
    }
    dispatched.add(input.continuationRef);
    return { kind: "fresh-dispatch", original, accepted: acceptedFor(kind, original) };
  }

  async recordBrowserBillingContinuationOutcome(input: {
    continuationRef: string;
    original: ReturnType<typeof originalFor>;
    outcome: { kind: string };
  }) {
    const payload = {
      selector: input.continuationRef,
      ...(input.continuationRef[0] === "0" ? { original: input.original } : {}),
      outcome: input.outcome,
    };
    const event = await this.env.EVENTS.fetch(
      new Request("https://fixture.invalid/record", {
        method: "POST",
        body: JSON.stringify(payload),
      }),
    );
    if (event.status !== 204) throw new Error("local outcome observer failed");
    return { kind: "recorded" };
  }
}

/** Local route only; no production mount, processor realm, or Hosted CAS. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/test/processor") return Response.json(processor);
    if (url.pathname === "/test/hosted") return Response.json(await env.HOSTED.fixtureState());
    const testOrigin = request.headers.get("x-test-origin");
    if (testOrigin !== null) {
      const headers = new Headers(request.headers);
      headers.delete("x-test-origin");
      headers.set("origin", testOrigin);
      request = new Request(request, { headers });
    }
    const sql = createD1Sql(env.AUTH_DB.withSession("first-primary"), {
      acknowledgement: "explicit-d1-result",
    });
    const sharedAuth = createSharedAuthSession({
      config: SESSION_TEST_CONFIG,
      consoleOrigin: SESSION_TEST_CONSOLE,
      encryptionKey: new Uint8Array(32).fill(7),
      now: () => NOW,
      store: () => createSharedAuthSessionStore(sql),
      finalStore: () => createSharedAuthFinalSessionStore(sql),
      fetch: (outgoing) => env.ISSUER.fetch(outgoing),
      principals: {
        async resolve(input) {
          if (input.accountId !== SESSION_TEST_ACCOUNT)
            throw new Error("foreign synthetic account");
          return { accountId: input.accountId, principalId: PRINCIPAL };
        },
      },
      organizations: {
        async pin(input) {
          return input;
        },
      },
    });
    if (url.pathname.startsWith("/auth/"))
      return (await sharedAuth.fetch(request)) ?? new Response(null, { status: 404 });
    const accounts = createAccounts({
      sql,
      clock: () => new Date(NOW),
      identity: {
        async verify() {
          throw new Error("unused local Accounts reader identity");
        },
      },
    });
    const topups = createOrgTopUps({
      sql,
      clock: () => new Date(NOW),
      consoleOrigin: SESSION_TEST_CONSOLE,
      bounds: { minimumMinor: 50, maximumMinor: 5000 },
      // This explicitly synthetic pin exercises OrgTopUps. It does not qualify
      // any financial realm, customer custody, or deployment composition.
      pin: async () => ({
        customerId: "cus_native_fixture",
        accountId: "acct_nativefixture",
        livemode: false,
        financialRealm: "local-fixture-only",
        pricingRevision: "local-fixture-r1",
        purchaseCreditExpiry: { kind: "none" },
      }),
      client: {
        async create(command) {
          processor.create++;
          if (request.headers.get("x-test-unknown-ack") === "yes")
            throw new Error("local processor ACK unknown after dispatch");
          const session: TopUpSession = {
            ...command,
            id: "cs_native_fixture",
            url: "https://checkout.stripe.com/c/pay/cs_native_fixture",
            status: "open",
            paymentStatus: "unpaid",
            mode: "payment",
          };
          sessions.set(session.id, session);
          return session;
        },
        async read(sessionId) {
          processor.read++;
          return sessions.get(sessionId) ?? null;
        },
        async recover() {
          processor.recover++;
          return null;
        },
      },
    });
    const control = createControlRoutes({
      publicOrigin: SESSION_TEST_CONFIG.publicOrigin,
      consoleOrigin: SESSION_TEST_CONSOLE,
      sharedAuth,
      accounts,
      hostedBrowserBillingRpc: env.HOSTED,
      checkout: topups,
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
    });
    const response =
      (await control(request, new URL(request.url))) ?? new Response(null, { status: 404 });
    if (url.pathname.endsWith("/wallet/checkout")) {
      // Same-request diagnostics read the actual owning command table before
      // the local platform proxy can close on a denied RPC response.
      const count = (await sql.query("SELECT COUNT(*) AS count FROM stripe_top_up_commands"))[0]
        ?.count;
      const originalRow =
        (
          await sql.query(
            `SELECT org_id, reference, fingerprint, command_json, stripe_key, state,
                  session_id, session_url, dispatched_at, created_at, updated_at
           FROM stripe_top_up_commands WHERE org_id = ? AND reference = ?`,
            [ORGANIZATION, REFERENCE],
          )
        )[0] ?? null;
      const headers = new Headers(response.headers);
      headers.set("x-fixture-command-count", String(count));
      headers.set("x-fixture-original-row", JSON.stringify(originalRow));
      headers.set("x-fixture-processor-create", String(processor.create));
      headers.set("x-fixture-processor-read", String(processor.read));
      headers.set("x-fixture-processor-recover", String(processor.recover));
      return new Response(response.body, { status: response.status, headers });
    }
    return response;
  },
};
