import { createSharedAuthFinancialConsentRequestHandler } from "./shared-auth-financial-consent.ts";
import { SharedAuthFinancialConsentOriginalReadError } from "./shared-auth-financial-consent-store.ts";
import type { WorkerRequestSql } from "./worker-request-composition.ts";

/** RP consent page: GET renders the retained R1 action and terms, and the
 * page's own form POSTs back to the same URL. Root mounts this on its request
 * graph after the request observation; RP owns everything behind it. */
export const SHARED_AUTH_FINANCIAL_CONSENT_PATH = "/auth/financial/consent";

const PAGE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

export function isSharedAuthFinancialConsentRequest(request: Request): boolean {
  return new URL(request.url).pathname === SHARED_AUTH_FINANCIAL_CONSENT_PATH;
}

/** Exactly `workspace` and `challenge`, once each; nothing else selects a row. */
function selection(
  url: URL,
): { readonly workspaceId: string; readonly challengeRef: string } | null {
  const keys = [...url.searchParams.keys()];
  const workspaceId = url.searchParams.get("workspace");
  const challengeRef = url.searchParams.get("challenge");
  if (
    keys.length !== 2 ||
    url.searchParams.getAll("workspace").length !== 1 ||
    url.searchParams.getAll("challenge").length !== 1 ||
    !workspaceId ||
    !challengeRef
  )
    return null;
  return { workspaceId, challengeRef };
}

function page(status: number, html: string): Response {
  return new Response(html, {
    status,
    headers: { ...PAGE_HEADERS, "content-type": "text/html; charset=utf-8" },
  });
}

function refused(error: unknown): Response {
  const code = error instanceof SharedAuthFinancialConsentOriginalReadError ? error.code : null;
  const status = code === "invalid_request" ? 400 : code === "custody_conflict" ? 409 : 503;
  return page(
    status,
    '<!doctype html><html lang="en"><meta charset="utf-8"><title>Financial action unavailable</title><main><h1>This financial action is unavailable</h1><p>Nothing was approved.</p></main></html>',
  );
}

/** One request, one handler on Root's connection. POST runs the prepared
 * preflight, the identity proof, its load/current evidence and the
 * affirmative capture in order; every step is one-attempt and fails closed. */
export async function handleSharedAuthFinancialConsentRequest(
  connection: WorkerRequestSql,
  request: Request,
): Promise<Response> {
  const url = new URL(request.url);
  const selected = selection(url);
  if (url.pathname !== SHARED_AUTH_FINANCIAL_CONSENT_PATH || !selected)
    return refused(new SharedAuthFinancialConsentOriginalReadError("invalid_request"));
  if (request.method !== "GET" && request.method !== "POST")
    return new Response(null, { status: 405, headers: { ...PAGE_HEADERS, allow: "GET, POST" } });
  const { workspaceId, challengeRef } = selected;
  try {
    const handler = createSharedAuthFinancialConsentRequestHandler(connection);
    if (request.method === "GET") {
      const view = await handler.prepareFinancialR1ConsentView(request, workspaceId, challengeRef);
      return page(200, view.html);
    }
    const prepared = await handler.readPreparedFinancialR1SubmissionData(
      request,
      workspaceId,
      challengeRef,
    );
    await handler.provePreparedFinancialR1Identity(request, workspaceId, challengeRef, prepared);
    await handler.readPreparedFinancialR1IdentityEvidence(
      request,
      workspaceId,
      challengeRef,
      prepared,
    );
    const original = await handler.capturePreparedFinancialR1Consent(
      request,
      workspaceId,
      challengeRef,
      prepared,
    );
    // The consent proof ref is the stored canonical consentRef the Financial
    // consumer selects by; it is a reference, not a bearer of authority.
    const consentProofRef = original.command.key.consentRef;
    return page(
      200,
      `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="takoserver-consent-proof-ref" content="${consentProofRef}"><title>Financial action approved</title><main><h1>Approved</h1><p>Your approval was recorded.</p></main></html>`,
    );
  } catch (error) {
    return refused(error);
  }
}
