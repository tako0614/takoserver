import { parseV2BaseUrl } from "./takoform-v2/identity.ts";

const V2_DISCOVERY_PATH = "/.well-known/takoform/v2";
const V2_API_PATH = "/apis/forms.takoform.com/v2";

export interface SelfhostTakoformV2IngressOptions {
  /** The operator's exact public HTTPS bare origin, never proxy-derived. */
  readonly publicOrigin: string;
  readonly appFetch: (request: Request) => Promise<Response>;
}

function isTakoformV2Path(path: string): boolean {
  return path === V2_DISCOVERY_PATH || path === V2_API_PATH || path.startsWith(`${V2_API_PATH}/`);
}

function matchesConfiguredAuthority(authority: string, expectedHost: string): boolean {
  if (authority.length === 0 || /[^\x21-\x7e]/u.test(authority) || /[\\/@?#,]/u.test(authority)) {
    return false;
  }
  try {
    const candidate = new URL(`https://${authority}/`);
    return (
      candidate.protocol === "https:" &&
      candidate.username === "" &&
      candidate.password === "" &&
      candidate.host.toLowerCase() === expectedHost.toLowerCase()
    );
  } catch {
    return false;
  }
}

/**
 * Adapt the existing HTTP Bun listener behind an operator TLS frontend for
 * v2 only. Both request authority sources must name the configured public
 * authority; forwarded headers are deliberately not consulted.
 */
export function createSelfhostTakoformV2Ingress(
  options: SelfhostTakoformV2IngressOptions,
): (request: Request) => Promise<Response> {
  const parsedOrigin = parseV2BaseUrl(options.publicOrigin);
  if (parsedOrigin.path !== "" || parsedOrigin.url.origin !== options.publicOrigin) {
    throw new TypeError("publicOrigin must be a canonical HTTPS bare origin");
  }
  const expectedHost = parsedOrigin.url.host;

  return async (request) => {
    const incomingUrl = new URL(request.url);
    if (!isTakoformV2Path(incomingUrl.pathname)) return options.appFetch(request);

    const hostHeader = request.headers.get("host");
    if (
      incomingUrl.username !== "" ||
      incomingUrl.password !== "" ||
      !matchesConfiguredAuthority(incomingUrl.host, expectedHost) ||
      hostHeader === null ||
      !matchesConfiguredAuthority(hostHeader, expectedHost)
    ) {
      return new Response(null, {
        status: 421,
        headers: { "cache-control": "no-store" },
      });
    }

    const canonicalUrl = `${parsedOrigin.url.origin}${incomingUrl.pathname}${incomingUrl.search}`;
    return options.appFetch(new Request(canonicalUrl, request));
  };
}
