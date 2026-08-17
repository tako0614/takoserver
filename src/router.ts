import type { ControlRoutes } from "./control.ts";
import { openApiDocument } from "./openapi.ts";
import type { TakoformHost } from "./takoform/types.ts";

/**
 * The single HTTP entry: discovery, the direct control plane, and the two
 * Takoform lanes behind one dispatch.
 *
 * Order matters. The Takoform Host is offered the request first because it owns
 * a whole path prefix and answers `null` for anything outside it; the control
 * plane then claims `/v1`; everything else is either a documented public page
 * or a 404.
 */

export interface CreateRouterOptions {
  readonly control: ControlRoutes;
  readonly takoformHost?: TakoformHost;
  readonly publicOrigin: string;
  /**
   * Where this deployment's console is served, if it has one.
   *
   * Absent is a real answer. A deployment with no console is a complete
   * product — the API, the CLI and the Takoform provider are the whole of it
   * for anyone integrating — and pointing discovery at a page that is not a
   * console is worse than admitting there is none.
   */
  readonly consoleOrigin?: string;
}

export type Router = (request: Request) => Promise<Response>;

export function createRouter(options: CreateRouterOptions): Router {
  const origin = httpsOrigin(options.publicOrigin);
  const route = dispatch(options, origin);

  return async (request) => {
    // A browser asking whether it may make the real call. Answering it is the
    // whole of preflight; nothing is routed and nothing is authenticated.
    if (request.method === "OPTIONS" && request.headers.get("origin")) {
      return new Response(null, { status: 204, headers: crossOrigin(request) });
    }
    const response = await route(request);
    if (!request.headers.get("origin")) return response;
    const answered = new Response(response.body, response);
    for (const [name, value] of Object.entries(crossOrigin(request))) {
      answered.headers.set(name, value);
    }
    return answered;
  };
}

/**
 * Cross-origin access.
 *
 * The console runs on its own hostname, and so does anybody else's tool, so an
 * API that refuses other origins is an API only servers can call. Any origin may
 * ask here, because authority is a bearer token a browser never attaches by
 * itself: a hostile page can issue the request and will not have the token to
 * put in it.
 *
 * Credentials are never allowed, and that is what keeps the sentence above
 * true. Permit them and a cookie would ride along unasked, which is exactly the
 * request a hostile page can make.
 */
function crossOrigin(request: Request): Record<string, string> {
  const asked = request.headers.get("access-control-request-headers");
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    // Reflected rather than listed: the Takoform lanes are a frozen contract
    // carrying headers of their own, and a list here would quietly become the
    // shorter of the two.
    "access-control-allow-headers":
      asked && asked.length <= 1_024 ? asked : "authorization, content-type",
    // ETag is a fence a caller must present back, so it is useless unless a
    // browser can read it.
    "access-control-expose-headers": "etag, location, retry-after",
    "access-control-max-age": "600",
    vary: "origin, access-control-request-headers",
  };
}

function dispatch(options: CreateRouterOptions, origin: string): Router {
  const console = options.consoleOrigin === undefined ? null : httpsOrigin(options.consoleOrigin);
  return async (request) => {
    const url = new URL(request.url);

    if (options.takoformHost) {
      const handled = await options.takoformHost.handle(request);
      if (handled) return handled;
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(landingPage(console), {
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    }
    if (request.method === "GET" && url.pathname === "/openapi.json") {
      return Response.json(openApiDocument);
    }
    if (request.method === "GET" && url.pathname === "/.well-known/takoserver") {
      return Response.json({
        product: "takoserver",
        apiVersion: "v1",
        endpoints: {
          api: origin,
          ...(console ? { console } : {}),
          openapi: `${origin}/openapi.json`,
          takoform: `${origin}/apis/forms.takoform.com/v1alpha3`,
        },
      });
    }
    if (
      request.method === "GET" &&
      (url.pathname === "/.well-known/takoform/v1beta1" ||
        url.pathname === "/.well-known/takoform/v1alpha3")
    ) {
      if (!options.takoformHost) return notFound();
      const lane = url.pathname.endsWith("v1beta1") ? "v1beta1" : "v1alpha3";
      return Response.json(discovery(origin, lane));
    }

    const control = await options.control(request, url);
    if (control) return control;

    return notFound();
  };
}

function discovery(origin: string, lane: "v1beta1" | "v1alpha3"): Record<string, unknown> {
  const base = `${origin}/apis/forms.takoform.com/${lane}`;
  return {
    api_versions: [`forms.takoform.com/${lane}`],
    features: {
      service_forms: true,
      exact_form_ref: true,
      optimistic_concurrency: true,
      idempotent_lifecycle: true,
      operations: true,
      artifact_upload: true,
      support_profiles: true,
    },
    endpoints: {
      api: base,
      artifacts: `${base}/artifacts`,
      operations: `${base}/operations`,
      support: `${base}/support`,
    },
  };
}

function notFound(): Response {
  return Response.json({ error: { code: "not_found", message: "not found" } }, { status: 404 });
}

/**
 * The advertised origin must be a bare HTTPS origin. Loopback is allowed so a
 * self-hosted server can be developed against without inventing a certificate.
 */
function httpsOrigin(value: string): string {
  const url = new URL(value);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1";
  if (
    (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new TypeError("public origin must be a bare HTTPS origin");
  }
  return url.origin;
}

/**
 * What the API serves at its own root.
 *
 * Not a console — the console is a separate deployment on its own hostname.
 * This is the page a person lands on after typing the API's address, so its
 * whole job is to say what this is and where everything actually lives.
 *
 * Inline and self-contained: an API answering its own root should not need a
 * second request to render one screen.
 */
function landingPage(consoleOrigin: string | null): string {
  const console_ = consoleOrigin
    ? `<a class="cta" href="${consoleOrigin}">Open the console</a>`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Takoserver</title>
<meta name="description" content="A prepaid resource platform. Declare infrastructure with Takoform.">
<meta name="color-scheme" content="light dark">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 34 34'%3E%3Crect width='34' height='34' fill='%23b0301f'/%3E%3C/svg%3E">
<style>
:root {
  color-scheme: light;
  --ink: #0e0e10; --ink-2: #6e7076; --line: #e6e6e8;
  --bg: #ffffff; --bg-2: #f6f6f7; --accent: #b0301f; --face: #17100f;
}
@media (prefers-color-scheme: dark) {
  :root {
    color-scheme: dark;
    --ink: #f2f2f3; --ink-2: #8a8c93; --line: #232327;
    --bg: #0b0b0c; --bg-2: #101012; --accent: #e0533c; --face: #0b0b0c;
  }
}
* { box-sizing: border-box; }
body {
  margin: 0; background: var(--bg); color: var(--ink);
  font: 400 15px/1.6 ui-sans-serif, system-ui, -apple-system, "Segoe UI", "Hiragino Sans", sans-serif;
  letter-spacing: -0.006em; -webkit-font-smoothing: antialiased;
}
main { max-width: 46rem; margin: 0 auto; padding: 88px 24px 96px; }
h1 { margin: 22px 0 0; font-size: 34px; font-weight: 600; letter-spacing: -0.035em; }
p.lede { margin: 12px 0 0; color: var(--ink-2); font-size: 16px; max-width: 34rem; }
.cta {
  display: inline-flex; align-items: center; margin-top: 28px; padding: 9px 16px;
  border-radius: 6px; background: var(--accent); color: #fff;
  font-size: 14px; font-weight: 500; text-decoration: none;
}
.cta:hover { filter: brightness(1.08); }
ul { margin: 44px 0 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
li { border-bottom: 1px solid var(--line); }
li a {
  display: flex; justify-content: space-between; gap: 16px; align-items: baseline;
  padding: 14px 2px; color: inherit; text-decoration: none;
}
li a:hover { background: var(--bg-2); }
li span { color: var(--ink-2); font-size: 13px; }
code { font-family: ui-monospace, "SF Mono", Menlo, monospace; font-size: 13px; }
footer { margin-top: 56px; color: var(--ink-2); font-size: 13px; }
</style>
</head>
<body>
<main>
<svg viewBox="0 0 34 34" width="44" height="44" shape-rendering="crispEdges" aria-hidden="true"><rect x="9" y="0" width="17" height="8" fill="var(--accent)"/><rect x="8" y="1" width="1" height="30" fill="var(--accent)"/><rect x="26" y="1" width="1" height="33" fill="var(--accent)"/><rect x="7" y="2" width="1" height="30" fill="var(--accent)"/><rect x="27" y="2" width="1" height="30" fill="var(--accent)"/><rect x="6" y="3" width="1" height="31" fill="var(--accent)"/><rect x="28" y="3" width="1" height="22" fill="var(--accent)"/><rect x="29" y="4" width="1" height="20" fill="var(--accent)"/><rect x="5" y="5" width="1" height="29" fill="var(--accent)"/><rect x="4" y="6" width="1" height="15" fill="var(--accent)"/><rect x="30" y="6" width="1" height="17" fill="var(--accent)"/><rect x="3" y="7" width="1" height="13" fill="var(--accent)"/><rect x="31" y="7" width="1" height="15" fill="var(--accent)"/><rect x="2" y="8" width="1" height="9" fill="var(--accent)"/><rect x="9" y="8" width="4" height="23" fill="var(--accent)"/><rect x="15" y="8" width="5" height="3" fill="var(--accent)"/><rect x="22" y="8" width="4" height="23" fill="var(--accent)"/><rect x="32" y="8" width="1" height="13" fill="var(--accent)"/><rect x="1" y="10" width="1" height="4" fill="var(--accent)"/><rect x="13" y="10" width="2" height="21" fill="var(--accent)"/><rect x="20" y="10" width="2" height="24" fill="var(--accent)"/><rect x="33" y="10" width="1" height="10" fill="var(--accent)"/><rect x="17" y="11" width="3" height="20" fill="var(--accent)"/><rect x="16" y="12" width="1" height="1" fill="var(--accent)"/><rect x="15" y="14" width="1" height="20" fill="var(--accent)"/><rect x="16" y="16" width="1" height="18" fill="var(--accent)"/><rect x="0" y="20" width="3" height="2" fill="var(--accent)"/><rect x="1" y="22" width="2" height="2" fill="var(--accent)"/><rect x="3" y="23" width="2" height="8" fill="var(--accent)"/><rect x="2" y="24" width="1" height="2" fill="var(--accent)"/><rect x="28" y="27" width="1" height="4" fill="var(--accent)"/><rect x="29" y="28" width="1" height="3" fill="var(--accent)"/><rect x="2" y="29" width="1" height="2" fill="var(--accent)"/><rect x="30" y="29" width="1" height="2" fill="var(--accent)"/><rect x="1" y="30" width="1" height="1" fill="var(--accent)"/><rect x="31" y="30" width="1" height="1" fill="var(--accent)"/><rect x="10" y="31" width="3" height="1" fill="var(--accent)"/><rect x="17" y="31" width="1" height="1" fill="var(--accent)"/><rect x="22" y="31" width="1" height="1" fill="var(--accent)"/><rect x="25" y="31" width="1" height="3" fill="var(--accent)"/><rect x="10" y="32" width="2" height="2" fill="var(--accent)"/><rect x="13" y="8" width="2" height="2" fill="var(--face)"/><rect x="20" y="8" width="2" height="2" fill="var(--face)"/><rect x="15" y="11" width="2" height="1" fill="var(--face)"/><rect x="15" y="12" width="1" height="2" fill="var(--face)"/><rect x="16" y="13" width="1" height="3" fill="var(--face)"/></svg>
<h1>Takoserver</h1>
<p class="lede">A prepaid resource platform. Declare what you need with Takoform,
fund a wallet, and pay only for what is actually provisioned.</p>
${console_}
<ul>
<li><a href="/openapi.json"><code>/openapi.json</code><span>API description</span></a></li>
<li><a href="/.well-known/takoserver"><code>/.well-known/takoserver</code><span>Product discovery</span></a></li>
<li><a href="/.well-known/takoform/v1alpha3"><code>/.well-known/takoform/v1alpha3</code><span>Takoform Host discovery</span></a></li>
</ul>
<footer>takoserver.com</footer>
</main>
</body>
</html>
`;
}
