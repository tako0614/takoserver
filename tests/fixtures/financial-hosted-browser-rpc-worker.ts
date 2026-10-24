import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createFinancialHostedOwnerRead,
  createHostedBrowserBillingRpcClient,
} from "@takoserver/core/financial-request-origin";
import { createAccounts } from "../../src/auth.ts";
import {
  parseHostedBrowserBillingOriginal,
  toFinancialHostedBrowserRequestOriginal,
} from "../../src/financial-hosted-browser-continuation.ts";
import { createFinancialHostedBrowserRequestAuthorization } from "../../src/financial-hosted-browser-request.ts";
import {
  createHostedBrowserLiveAuthorizationTarget,
  createHostedBrowserLiveReadTarget,
  type HostedBrowserBillingLookup,
  type HostedBrowserLiveAuthorizationTarget,
  type HostedBrowserLiveReadTarget,
} from "../../src/financial-hosted-browser-rpc.ts";
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
const PRINCIPAL = "native-browser-principal";
const ORGANIZATION = "native-browser-organization";
const WORKSPACE_REF = "native-browser-workspace-ref";
const HEX = "a".repeat(64);

function originalFor(kind: string, selector = kind.repeat(64)) {
  return parseHostedBrowserBillingOriginal({
    contractVersion: "hosted-browser-v1",
    scope: {
      continuationRef: selector,
      canonicalAccountId: SESSION_TEST_ACCOUNT,
      workspaceId: SESSION_TEST_PERSONAL.id,
      workspaceRef: WORKSPACE_REF,
      organizationId: ORGANIZATION,
      billingSourceRef: "native-browser-source",
      sourceEpoch: "native-browser-epoch",
    },
    action: {
      family: "topup",
      request: {
        workspaceId: SESSION_TEST_PERSONAL.id,
        operationKey: `native-browser-operation-${kind}`,
        amountMinor: 50,
        checkoutConsent: "interactive-checkout",
      },
      claim: {
        ownerId: "historical-owner-only",
        organizationId: ORGANIZATION,
        billingSourceRef: "native-browser-source",
        operationKey: `native-browser-operation-${kind}`,
        reference: `takosumi:topup:${HEX}`,
        amountMinor: 50,
      },
    },
  });
}

interface Env {
  AUTH_DB: {
    withSession(constraint: "first-primary"): D1DatabaseLike;
    prepare(sql: string): { run(): Promise<unknown> };
  };
  ISSUER: { fetch(request: Request): Promise<Response> };
  REVOKER: { fetch(request: Request): Promise<Response> };
  GATE: { fetch(request: Request): Promise<Response> };
  HOSTED: {
    readBrowserBillingContinuation(
      input: HostedBrowserBillingLookup,
      liveRead?: HostedBrowserLiveReadTarget,
    ): Promise<unknown>;
    claimBrowserBillingContinuation(
      input: HostedBrowserBillingLookup,
      authorization: HostedBrowserLiveAuthorizationTarget,
    ): Promise<unknown>;
    recordBrowserBillingContinuationOutcome(input: unknown): Promise<unknown>;
  };
}

function errorCode(error: unknown): string {
  return error && typeof error === "object" && "code" in error
    ? String(error.code)
    : error instanceof Error
      ? error.name
      : String(error);
}

/** Local Hosted fixture: it calls the real transferred prototype callback. */
export class Hosted extends WorkerEntrypoint<Env> {
  async readBrowserBillingContinuation(
    input: HostedBrowserBillingLookup,
    liveRead?: HostedBrowserLiveReadTarget,
  ) {
    const mode = input.continuationRef.slice(-2);
    const scope = {
      continuationRef: input.continuationRef,
      canonicalAccountId: input.canonicalAccountId,
      workspaceId: SESSION_TEST_PERSONAL.id,
      workspaceRef: WORKSPACE_REF,
      organizationId: ORGANIZATION,
      billingSourceRef: "native-browser-source",
      sourceEpoch: "native-browser-epoch",
    };
    const view = { kind: "view", contractVersion: "hosted-browser-v1", scope };
    if (mode === "a9") return { kind: "denied" };
    if (mode === "a5") return view;
    if (!liveRead || typeof liveRead.assertReadCurrent !== "function")
      throw new Error("native read callback prototype method is invisible");
    if (mode === "b2") {
      try {
        await liveRead.assertReadCurrent({ ...scope, continuationRef: "b".repeat(64) });
      } catch {
        // A mismatched selector cannot be laundered into this lookup's view.
      }
      return view;
    }
    if (mode === "a7" || mode === "b3" || mode === "b4") {
      const entered = await this.env.GATE.fetch(new Request("https://fixture.invalid/entered"));
      if (entered.status !== 204) throw new Error("local read callback barrier failed");
    }
    if (mode === "a2") {
      const revoked = await this.env.REVOKER.fetch(new Request("https://fixture.invalid/revoke"));
      if (revoked.status !== 204) throw new Error("local read Owner revocation failed");
    }
    if (mode === "a3") {
      await liveRead.assertReadCurrent(scope);
      try {
        await liveRead.assertReadCurrent({ ...scope, workspaceRef: "different-ref" });
      } catch {
        // A real Hosted caller may catch a failed callback. It cannot reuse the first success.
      }
      return view;
    }
    if (mode === "a6") {
      await liveRead.assertReadCurrent(scope);
      const revoked = await this.env.REVOKER.fetch(new Request("https://fixture.invalid/revoke"));
      if (revoked.status !== 204) throw new Error("local read Owner revocation failed");
      try {
        await liveRead.assertReadCurrent(scope);
      } catch {
        // Do not let a prior success authorize this apparent positive response.
      }
      return view;
    }
    await liveRead.assertReadCurrent(scope);
    if (mode === "b7") {
      const dispose = (liveRead as HostedBrowserLiveReadTarget & { [Symbol.dispose](): void })[
        Symbol.dispose
      ];
      if (typeof dispose !== "function") throw new Error("native read disposer is unavailable");
      Reflect.apply(dispose, liveRead, []);
      let rejected = false;
      try {
        await liveRead.assertReadCurrent(scope);
      } catch {
        rejected = true;
      }
      if (!rejected) throw new Error("native callback survived completed release");
      return view;
    }
    if (mode === "a1")
      return {
        kind: "payment",
        original: originalFor("f", input.continuationRef),
        custody: { phase: "prepared" },
      };
    if (mode === "a4") return { ...view, scope: { ...scope, sourceEpoch: "different-epoch" } };
    return view;
  }

  async recordBrowserBillingContinuationOutcome() {
    return { kind: "unavailable" };
  }

  async claimBrowserBillingContinuation(
    input: HostedBrowserBillingLookup,
    authorization: HostedBrowserLiveAuthorizationTarget,
  ) {
    const kind = input.continuationRef[0] ?? "";
    const original = originalFor(kind);
    if (typeof authorization.assertOriginalCurrent !== "function")
      throw new Error("native callback prototype method is invisible");
    // Mark this Hosted callback phase before invoking the real transferred
    // callback. The caller waits until its RP read is actually awaiting.
    if (kind === "c") {
      const entered = await this.env.GATE.fetch(new Request("https://fixture.invalid/entered"));
      if (entered.status !== 204) throw new Error("local callback barrier failed");
    }
    if (kind === "b") {
      const revoked = await this.env.REVOKER.fetch(new Request("https://fixture.invalid/revoke"));
      if (revoked.status !== 204) throw new Error("local Owner revocation did not finish");
    }
    await authorization.assertOriginalCurrent(original);
    if (kind === "d") return { kind: "unknown" };
    const accepted = {
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
    if (kind === "e")
      return {
        kind: "accepted-history",
        original,
        custody: { phase: "dispatch-started", accepted },
      };
    return {
      kind: "fresh-dispatch",
      original,
      accepted,
    };
  }
}

/** Local route only; product entrypoints and real Hosted authority are not mounted. */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
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
    const url = new URL(request.url);
    if (url.pathname.startsWith("/auth/"))
      return (await sharedAuth.fetch(request)) ?? new Response(null, { status: 404 });
    if (url.pathname.startsWith("/test/read/")) {
      const mode = url.pathname.slice("/test/read/".length);
      if (!/^(?:a[0-9]|b[0-7])$/u.test(mode)) return new Response(null, { status: 404 });
      const accounts = createAccounts({
        sql,
        clock: () => new Date(NOW),
        identity: {
          async verify() {
            throw new Error("not used by native Accounts reader");
          },
        },
      });
      const ownerRead = await createFinancialHostedOwnerRead({
        request,
        sharedAuth,
        accounts,
        qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
      });
      const lookup = {
        continuationRef: `${"a".repeat(62)}${mode}`,
        canonicalAccountId: SESSION_TEST_ACCOUNT,
      };
      const client = createHostedBrowserBillingRpcClient(env.HOSTED);
      if (mode === "a7" || mode === "a8" || mode === "b5" || mode === "b6") {
        const remote = await createHostedBrowserLiveReadTarget(ownerRead, request, lookup, lookup);
        const prototypeVisible =
          !Object.hasOwn(remote.target, "assertReadCurrent") &&
          typeof remote.target.assertReadCurrent === "function";
        const scope = {
          ...lookup,
          workspaceId: SESSION_TEST_PERSONAL.id,
          workspaceRef: WORKSPACE_REF,
          organizationId: ORGANIZATION,
          billingSourceRef: "native-browser-source",
          sourceEpoch: "native-browser-epoch",
        };
        let result: string;
        try {
          if (mode === "a7" || mode === "b5" || mode === "b6") {
            if (mode !== "a7") {
              const entered = await env.GATE.fetch(new Request("https://fixture.invalid/entered"));
              if (entered.status !== 204) throw new Error("local callback barrier failed");
            }
            const pending =
              mode === "a7"
                ? env.HOSTED.readBrowserBillingContinuation(lookup, remote.target)
                : remote.target.assertReadCurrent(scope);
            const entered = await env.GATE.fetch(new Request("https://fixture.invalid/wait"));
            if (entered.status !== 204) throw new Error("local callback wait failed");
            let second: string | undefined;
            if (mode === "a7") remote.disposeRemote();
            if (mode === "b5") scope.sourceEpoch = "mutated-epoch";
            if (mode === "b6") {
              try {
                await remote.target.assertReadCurrent(scope);
                second = "allowed";
              } catch (error) {
                second = errorCode(error);
              }
            }
            const released = await env.GATE.fetch(new Request("https://fixture.invalid/release"));
            if (released.status !== 204) throw new Error("local callback release failed");
            try {
              await pending;
              result = "allowed";
            } catch (error) {
              result = errorCode(error);
            }
            if (second) result = `${result}/${second}`;
          } else {
            remote.disposeRemote();
            try {
              await remote.target.assertReadCurrent(scope);
              result = "allowed";
            } catch (error) {
              result = errorCode(error);
            }
          }
        } finally {
          remote.disposeRemote();
        }
        return Response.json({ result, prototypeVisible, completed: remote.completedFor(scope) });
      }
      let result: string;
      try {
        let pending: ReturnType<typeof client.readWithCurrentOwner>;
        if (mode === "b3" || mode === "b4") {
          pending = client.readWithCurrentOwner(lookup, ownerRead, request);
          const entered = await env.GATE.fetch(new Request("https://fixture.invalid/wait"));
          if (entered.status !== 204) throw new Error("local callback wait failed");
          if (mode === "b3") lookup.continuationRef = "b".repeat(64);
          else request.headers.set("x-drift", "changed");
          const released = await env.GATE.fetch(new Request("https://fixture.invalid/release"));
          if (released.status !== 204) throw new Error("local callback release failed");
        } else {
          pending = client.readWithCurrentOwner(
            mode === "b1" ? { ...lookup, canonicalAccountId: "foreign-account" } : lookup,
            ownerRead,
            mode === "b0" ? request.clone() : request,
          );
        }
        const selected = await pending;
        result = selected.kind;
      } catch (error) {
        result = errorCode(error);
      }
      return Response.json({ result });
    }
    if (!url.pathname.startsWith("/test/claim/")) return new Response(null, { status: 404 });
    const kind = url.pathname.slice("/test/claim/".length);
    if (!/^[abcde]$/u.test(kind)) return new Response(null, { status: 404 });
    const original = originalFor(kind);
    const accounts = createAccounts({
      sql,
      clock: () => new Date(NOW),
      identity: {
        async verify() {
          throw new Error("not used by native Accounts reader");
        },
      },
    });
    const producer = await createFinancialHostedBrowserRequestAuthorization({
      request,
      sharedAuth,
      accounts,
      qualifiedConsoleOrigin: SESSION_TEST_CONSOLE,
      original: toFinancialHostedBrowserRequestOriginal(original),
    });
    try {
      const remote = await createHostedBrowserLiveAuthorizationTarget(producer, original);
      const client = createHostedBrowserBillingRpcClient(env.HOSTED);
      const lookup = {
        continuationRef: original.scope.continuationRef,
        canonicalAccountId: original.scope.canonicalAccountId,
      };
      const prototypeVisible =
        !Object.hasOwn(remote.target, "assertOriginalCurrent") &&
        typeof remote.target.assertOriginalCurrent === "function";
      let result: string;
      try {
        const pending = client.claim(lookup, remote.target, original);
        if (kind === "c") {
          const entered = await env.GATE.fetch(new Request("https://fixture.invalid/wait"));
          if (entered.status !== 204) throw new Error("local callback barrier failed");
          remote.disposeRemote();
          const released = await env.GATE.fetch(new Request("https://fixture.invalid/release"));
          if (released.status !== 204) throw new Error("local callback release failed");
        }
        try {
          result = (await pending).kind;
        } catch (error) {
          result = errorCode(error);
        }
      } finally {
        remote.disposeRemote();
      }
      let producerAfterRemote: string;
      try {
        await producer.assertOriginalCurrent(toFinancialHostedBrowserRequestOriginal(original));
        producerAfterRemote = "current";
      } catch (error) {
        producerAfterRemote = errorCode(error);
      }
      let closedRemote: string;
      try {
        if (kind === "a") await client.claim(lookup, remote.target, original);
        else await remote.target.assertOriginalCurrent(original);
        closedRemote = "allowed";
      } catch (error) {
        closedRemote = errorCode(error);
      }
      producer.dispose();
      let closedProducer: string;
      try {
        await producer.assertOriginalCurrent(toFinancialHostedBrowserRequestOriginal(original));
        closedProducer = "allowed";
      } catch (error) {
        closedProducer = errorCode(error);
      }
      return Response.json({
        result,
        prototypeVisible,
        producerAfterRemote,
        closedRemote,
        closedProducer,
      });
    } finally {
      producer.dispose();
    }
  },
};
