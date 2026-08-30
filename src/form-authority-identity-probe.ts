import { isPublicHostIdentity, type PublicHostIdentityRpc } from "./public-host-identity.ts";

export const FORM_AUTHORITY_IDENTITY_PROBE_PATH = "/v1/public-host-identity";

export interface FormAuthorityIdentityProbeEnv {
  readonly TAKOSERVER_FORM_AUTHORITY_HOST_ID: string;
  readonly PUBLIC_HOST_IDENTITY: PublicHostIdentityRpc;
}

/**
 * Permanent, read-only HTTP bridge for deploy readback. The response is proof
 * that this request reached the public Worker's named identity RPC; the probe
 * has no storage, secret, mutation RPC, or target override of its own.
 */
export async function handleFormAuthorityIdentityProbe(
  request: Request,
  env: FormAuthorityIdentityProbeEnv,
): Promise<Response> {
  const url = new URL(request.url);
  if (
    request.method !== "GET" ||
    url.pathname !== FORM_AUTHORITY_IDENTITY_PROBE_PATH ||
    url.search !== ""
  ) {
    return jsonError(404, "not_found");
  }
  try {
    const identity = await env.PUBLIC_HOST_IDENTITY.identity();
    if (
      !isPublicHostIdentity(identity) ||
      identity.hostId !== env.TAKOSERVER_FORM_AUTHORITY_HOST_ID
    ) {
      return jsonError(503, "identity_unavailable");
    }
    return Response.json(identity, {
      status: 200,
      headers: responseHeaders(),
    });
  } catch {
    return jsonError(503, "identity_unavailable");
  }
}

function jsonError(status: number, code: string): Response {
  return Response.json({ error: { code } }, { status, headers: responseHeaders() });
}

function responseHeaders(): HeadersInit {
  return {
    "cache-control": "no-store",
    "content-type": "application/json; charset=UTF-8",
    "x-content-type-options": "nosniff",
  };
}
