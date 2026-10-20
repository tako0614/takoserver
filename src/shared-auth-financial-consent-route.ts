import { createSharedAuthFinancialConsentRequestHandler } from "./shared-auth-financial-consent.ts";
import { SharedAuthFinancialConsentOriginalReadError } from "./shared-auth-financial-consent-store.ts";
import type { WorkerRequestSql } from "./worker-request-composition.ts";

/** RP consent page: GET renders the retained R1 action and terms, and the
 * page's own form POSTs back to the same URL. Root mounts this on its request
 * graph after the request observation; RP owns everything behind it. */
export const SHARED_AUTH_FINANCIAL_CONSENT_PATH = "/auth/financial/consent";
/** Fixed continuation on the configured console after an approval: its billing
 * page re-issues the held payment reference. No data or caller return URL. */
export const SHARED_AUTH_FINANCIAL_CONSENT_RETURN = "/billing?consent=returned";

/** The same checks the console billing redirect applies to its origin. */
function consoleReturn(consoleOrigin: string | undefined): string | null {
  if (typeof consoleOrigin !== "string") return null;
  try {
    const origin = new URL(consoleOrigin);
    if (
      origin.origin !== consoleOrigin ||
      origin.username ||
      origin.password ||
      !["https:", "http:"].includes(origin.protocol)
    )
      return null;
    return `${origin.origin}${SHARED_AUTH_FINANCIAL_CONSENT_RETURN}`;
  } catch {
    return null;
  }
}

const PAGE_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy":
    "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
  // The page's own form POST must carry this origin: a no-referrer page makes
  // browsers send `Origin: null`, which the POST preflight refuses.
  "referrer-policy": "same-origin",
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

/** form-action also governs the redirect that answers the form POST, so the
 * consent page names the validated console origin its 303 continues to. */
function page(status: number, html: string, consoleOrigin?: string): Response {
  const target = consoleReturn(consoleOrigin) === null ? "" : ` ${consoleOrigin}`;
  return new Response(html, {
    status,
    headers: {
      ...PAGE_HEADERS,
      "content-security-policy": `default-src 'none'; form-action 'self'${target}; frame-ancestors 'none'; base-uri 'none'`,
      "content-type": "text/html; charset=utf-8",
    },
  });
}

/** The page's own GET, built from server constants and the selected pair only;
 * there is no caller-supplied return URL. */
function pageLocation(workspaceId: string, challengeRef: string): string {
  const query = new URLSearchParams({ workspace: workspaceId, challenge: challengeRef });
  return `${SHARED_AUTH_FINANCIAL_CONSENT_PATH}?${query.toString()}`;
}

function refused(error: unknown, recheck?: string): Response {
  const code = error instanceof SharedAuthFinancialConsentOriginalReadError ? error.code : null;
  if (code === "invalid_request")
    return page(
      400,
      '<!doctype html><html lang="en"><meta charset="utf-8"><title>Financial action unavailable</title><main><h1>This financial action is unavailable</h1><p>Nothing was approved.</p></main></html>',
    );
  // An unknown outcome may still have committed: never claim it did not, and
  // recover only by reading this page again (GET), never by resubmitting.
  const link = recheck === undefined ? "" : `<p><a href="${recheck}">Check again</a></p>`;
  return page(
    code === "custody_conflict" ? 409 : 503,
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>Approval not confirmed</title><main><h1>We could not confirm this approval</h1><p>Do not submit it again. Reload this page to see whether it was recorded.</p>${link}</main></html>`,
  );
}

/** One request, one handler on Root's connection. POST runs the prepared
 * preflight, the identity proof, its load/current evidence and the
 * affirmative capture in order; every step is one-attempt and fails closed. */
export async function handleSharedAuthFinancialConsentRequest(
  connection: WorkerRequestSql,
  request: Request,
  consoleOrigin: string | undefined,
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
      return page(200, view.html, consoleOrigin);
    }
    // Without a valid configured console there is no continuation: refuse
    // before any effect rather than fall back to a relative path.
    const continuation = consoleReturn(consoleOrigin);
    if (continuation === null)
      return refused(new SharedAuthFinancialConsentOriginalReadError("unavailable"));
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
    await handler.capturePreparedFinancialR1Consent(request, workspaceId, challengeRef, prepared);
    // Post/Redirect/Get to the fixed billing continuation. Financial derives
    // the consent proof ref from its retained R1; nothing is carried here.
    return new Response(null, {
      status: 303,
      headers: { ...PAGE_HEADERS, location: continuation },
    });
  } catch (error) {
    return refused(
      error,
      request.method === "POST" ? pageLocation(workspaceId, challengeRef) : undefined,
    );
  }
}
