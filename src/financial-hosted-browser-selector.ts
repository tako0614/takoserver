/** Browser locator only. This module neither authenticates nor grants a payment. */
export const HOSTED_BROWSER_CONTINUATION_HEADER = "Takoserver-Billing-Continuation";

const HEADER_VALUE = /^hosted-browser-v1\.([0-9a-f]{64})$/u;
const SELECTOR = /^[0-9a-f]{64}$/u;
const METADATA_PREFIX = "/v1/billing/hosted-continuations";
const METADATA = /^\/v1\/billing\/hosted-continuations\/([^/]+)$/u;
const CHECKOUT = /^\/v1\/organizations\/[^/]+\/wallet\/checkout$/u;
const CHECKOUT_RECEIPT = /^\/v1\/organizations\/[^/]+\/wallet\/checkout\/[^/]+$/u;
const SUBSCRIPTION = /^\/v1\/organizations\/[^/]+\/payments\/subscription$/u;
const SUBSCRIPTION_RECEIPT =
  /^\/v1\/organizations\/[^/]+\/payments\/subscription\/commands\/[^/]+\/[^/]+$/u;

export type HostedBrowserSelectorRoute =
  | "metadata"
  | "prepare"
  | "checkout"
  | "checkout-receipt"
  | "subscription"
  | "subscription-receipt";

export type HostedBrowserSelectorSelection =
  | { readonly kind: "ordinary" }
  | { readonly kind: "invalid" }
  | {
      readonly kind: "selected";
      readonly selector: string;
      readonly route: HostedBrowserSelectorRoute;
    };

function existingRoute(method: string, path: string): HostedBrowserSelectorRoute | null {
  if (method === "POST" && CHECKOUT.test(path)) return "checkout";
  if (method === "GET" && CHECKOUT_RECEIPT.test(path)) return "checkout-receipt";
  if ((method === "GET" || method === "POST" || method === "PATCH") && SUBSCRIPTION.test(path))
    return "subscription";
  if (method === "GET" && SUBSCRIPTION_RECEIPT.test(path)) return "subscription-receipt";
  return null;
}

/**
 * Selects only the closed browser mode before any ordinary route/auth/effect.
 * A valid selector remains unavailable until the native Hosted supplier exists.
 */
export function selectHostedBrowserContinuation(
  request: Request,
  url: URL,
): HostedBrowserSelectorSelection {
  const hasHeader = request.headers.has(HOSTED_BROWSER_CONTINUATION_HEADER);
  const metadataPath =
    url.pathname === METADATA_PREFIX || url.pathname.startsWith(`${METADATA_PREFIX}/`);
  if (hasHeader) {
    // Headers combines duplicate field lines with commas. The full closed
    // grammar also rejects whitespace, unknown versions and extra values.
    const value = request.headers.get(HOSTED_BROWSER_CONTINUATION_HEADER) ?? "";
    const match = HEADER_VALUE.exec(value);
    if (!match || match[0] !== value || metadataPath) return { kind: "invalid" };
    const route = existingRoute(request.method, url.pathname);
    if (!route) return { kind: "invalid" };
    return { kind: "selected", selector: match[1] ?? "", route };
  }
  if (metadataPath) {
    const match = METADATA.exec(url.pathname);
    const selector = match?.[1] ?? "";
    const exactSelector = SELECTOR.exec(selector);
    if (
      (request.method !== "GET" && request.method !== "POST") ||
      url.searchParams.size !== 0 ||
      !match ||
      exactSelector?.[0] !== selector
    )
      return { kind: "invalid" };
    return {
      kind: "selected",
      selector,
      route: request.method === "POST" ? "prepare" : "metadata",
    };
  }
  return { kind: "ordinary" };
}
