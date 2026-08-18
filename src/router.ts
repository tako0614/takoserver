import type { ControlRoutes } from "./control.ts";
import type { DataAiRoutes } from "./data-ai.ts";
import { landingHtml } from "./landing.ts";
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
  readonly dataAi?: DataAiRoutes;
  readonly aiAvailable?: boolean;
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

    if (options.dataAi) {
      const served = await options.dataAi(request, url);
      if (served) return served;
    }

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
          ...(options.aiAvailable ? { ai: `${origin}/v1/ai` } : {}),
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

function landingPage(consoleOrigin: string | null): string {
  return landingHtml({ consoleOrigin, apiOrigin: null });
}
