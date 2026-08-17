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
}

export type Router = (request: Request) => Promise<Response>;

export function createRouter(options: CreateRouterOptions): Router {
  const origin = httpsOrigin(options.publicOrigin);

  return async (request) => {
    const url = new URL(request.url);

    if (options.takoformHost) {
      const handled = await options.takoformHost.handle(request);
      if (handled) return handled;
    }

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(CONSOLE_HTML, {
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
          console: `${origin}/`,
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

const CONSOLE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Takoserver</title>
<style>
:root { color-scheme: light dark; }
body { margin: 0; padding: 3rem 1.5rem; font: 16px/1.6 system-ui, sans-serif; }
main { max-width: 42rem; margin: 0 auto; }
code { font-family: ui-monospace, monospace; }
a { color: inherit; }
</style>
</head>
<body>
<main>
<h1>Takoserver</h1>
<p>An independent prepaid resource platform. Declare resources with Takoform,
fund a wallet, and reserve capacity.</p>
<ul>
<li><a href="/openapi.json">OpenAPI document</a></li>
<li><a href="/.well-known/takoserver">Product discovery</a></li>
<li><a href="/.well-known/takoform/v1alpha3">Takoform Host discovery</a></li>
</ul>
</main>
</body>
</html>
`;
