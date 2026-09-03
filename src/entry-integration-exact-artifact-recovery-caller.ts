import { parseStrictJson } from "./strict-json.ts";

const MAXIMUM_BODY_BYTES = 256 * 1_024;

interface RecoveryRpcBinding {
  recoverExactFailedRunArtifact(input: unknown): Promise<unknown>;
}

interface Env {
  readonly ARTIFACT_RECOVERY: RecoveryRpcBinding;
  readonly TAKOSERVER_ARTIFACT_RECOVERY_CALLER_TOKEN: string;
}

/**
 * Ephemeral `wrangler dev --remote` bridge. It is reached only through the
 * loopback proxy, has one random per-process bearer, and owns no storage
 * binding. Its sole capability is the named RPC on the already-live Worker.
 */
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (
      request.headers.get("authorization") !==
      `Bearer ${env.TAKOSERVER_ARTIFACT_RECOVERY_CALLER_TOKEN}`
    ) {
      return new Response(null, { status: 404 });
    }
    if (request.method === "GET" && url.pathname === "/__ready" && url.search === "") {
      return new Response(null, { status: 204 });
    }
    if (
      request.method !== "POST" ||
      url.pathname !== "/invoke" ||
      url.search !== "" ||
      request.headers.get("content-type") !== "application/json"
    ) {
      return new Response(null, { status: 404 });
    }
    const declared = request.headers.get("content-length");
    if (
      declared !== null &&
      (!/^[0-9]+$/u.test(declared) || Number(declared) > MAXIMUM_BODY_BYTES)
    ) {
      return new Response(null, { status: 413 });
    }
    const body = await request.text();
    if (new TextEncoder().encode(body).byteLength > MAXIMUM_BODY_BYTES) {
      return new Response(null, { status: 413 });
    }
    let input: unknown;
    try {
      input = parseStrictJson(new TextEncoder().encode(body), MAXIMUM_BODY_BYTES);
    } catch {
      return new Response(null, { status: 400 });
    }
    try {
      return Response.json(await env.ARTIFACT_RECOVERY.recoverExactFailedRunArtifact(input));
    } catch (error) {
      return Response.json(
        {
          error: error instanceof Error ? error.message : "artifact recovery RPC failed",
        },
        { status: 502 },
      );
    }
  },
};
