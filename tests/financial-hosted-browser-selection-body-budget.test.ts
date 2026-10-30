import { expect, test } from "bun:test";
import type { Accounts } from "../src/auth.ts";
import {
  createFinancialHostedBrowserSelection,
  FinancialHostedBrowserSelectionUnavailable,
} from "../src/financial-hosted-browser-selection.ts";
import { MAX_JSON_REQUEST_BODY_BYTES } from "../src/request-body.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import type { SharedAuthSession } from "../src/shared-auth-session.ts";
import { instrumentedBodyStream } from "./helpers/instrumented-body-stream.ts";

// The selection producer re-reads the original prepare POST body to bind the
// caller's choice to the bytes actually sent. That re-read must hold the JSON
// budget by itself, not only because the current control route happened to
// bound a sibling clone first. No authority is reached: every receiver below
// is an unreachable counter, and the body is inert filler.

const CHUNK_BYTES = 4 * 1_024;
const TOTAL_CHUNKS = 1_024;
const SELECTOR = "a".repeat(64);

function unreachable() {
  let calls = 0;
  const refuse = async () => {
    calls++;
    throw new Error("unreachable authority in a body budget test");
  };
  const sharedAuth = {
    authenticate: refuse,
    observeFinalWorkspaceOrganization: refuse,
    finalSessionSelection: refuse,
  } as unknown as SharedAuthSession;
  const accounts = { principal: refuse, requireOwner: refuse } as unknown as Accounts;
  return { sharedAuth, accounts, calls: () => calls };
}

test("an over-budget prepare body is refused by the producer without being drained", async () => {
  const { sharedAuth, accounts, calls } = unreachable();
  const { stream, counters, totalBytes } = instrumentedBodyStream({
    chunkBytes: CHUNK_BYTES,
    totalChunks: TOTAL_CHUNKS,
  });
  const request = new Request(
    `${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/v1/billing/hosted-continuations/${SELECTOR}`,
    {
      method: "POST",
      headers: {
        origin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
        cookie: "__Host-takoserver_shared_session=inert",
        "content-type": "application/json",
      },
      body: stream,
      duplex: "half",
    } as RequestInit,
  );
  expect(totalBytes).toBeGreaterThan(4 * MAX_JSON_REQUEST_BODY_BYTES);
  await Bun.sleep(0);
  const before = counters.pulls;
  const selection = createFinancialHostedBrowserSelection({
    request,
    scope: {
      continuationRef: SELECTOR,
      canonicalAccountId: "canonical-account-123",
      workspaceId: "personal-workspace-123",
      workspaceRef: "workspace-ref-selection",
      organizationId: "org-browser-selection",
      billingSourceRef: "source-a",
      sourceEpoch: "epoch-a",
    },
    choice: { kind: "topup", amountMinor: 50, checkoutConsent: "interactive-checkout" },
    sharedAuth,
    accounts,
    qualifiedConsoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const refusalDeadline = new Promise<"waited">((resolve) => {
    timer = setTimeout(() => resolve("waited"), 1_000);
  });
  try {
    // The refusal must not wait for the caller's unread original branch.
    const outcome = await Promise.race([
      selection.then(
        () => "accepted" as const,
        (error: unknown) => error,
      ),
      refusalDeadline,
    ]);
    expect(outcome).toBeInstanceOf(FinancialHostedBrowserSelectionUnavailable);
    // A full drain would pull every chunk beyond the construction baseline.
    expect(counters.pulls - before).toBeLessThan(TOTAL_CHUNKS / 4);
    expect(calls()).toBe(0);
    // The caller's original branch stays unread and owned by the caller.
    expect(request.bodyUsed).toBe(false);
  } finally {
    clearTimeout(timer);
    // Cancel the caller-owned branch only after the assertion, so cleanup
    // cannot satisfy the behaviour under test.
    await request.body?.cancel();
    await selection.catch(() => undefined);
  }
});
