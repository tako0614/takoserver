import worker, { type WorkerEnv } from "../../src/entry-worker.ts";

/** Local-only trigger so the real entry's scheduled pass runs inside workerd. */
export default {
  async fetch(
    request: Request,
    env: WorkerEnv,
    context: { waitUntil(work: Promise<unknown>): void },
  ): Promise<Response> {
    const localUrl = new URL(request.url);
    if (localUrl.pathname === "/__test/run-scheduled") {
      await worker.scheduled({}, env);
      return new Response(null, { status: 204 });
    }
    // Miniflare dispatches through an HTTP loopback URL. Reconstitute the
    // configured HTTPS authority that the real Cloudflare edge passes through.
    const canonicalUrl = new URL(`${localUrl.pathname}${localUrl.search}`, env.PUBLIC_ORIGIN);
    const body =
      request.method === "GET" || request.method === "HEAD"
        ? undefined
        : await request.arrayBuffer();
    return worker.fetch(
      new Request(canonicalUrl, {
        method: request.method,
        headers: request.headers,
        ...(body ? { body } : {}),
      }),
      env,
      context,
    );
  },
};
