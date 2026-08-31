import { isPublicHostIdentity, type PublicHostIdentityRpc } from "./public-host-identity.ts";

export const FORM_AUTHORITY_IDENTITY_PROBE_PATH = "/v1/public-host-identity";
export const FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH = "/v1/core-verifier-identity";
export const FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND =
  "takoserver.form-authority-core-verifier-identity@v1";

export interface FormAuthorityCoreVerifierIdentityRpc {
  verifierIdentity(): Promise<unknown>;
}

/** Sanitized live proof returned by the route-less authority's named RPC. */
export interface FormAuthorityCoreVerifierIdentity {
  readonly kind: typeof FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND;
  readonly authorityWorkerVersionId: string;
  readonly verifier: {
    readonly protocol: "takoserver.takoform-core-verifier@v1";
    readonly coreVersion: "v1.1.0";
    readonly coreCommit: "e0e48b864de2a127a255cb0574d37bbb0f1cac29";
    readonly artifactDigest: `sha256:${string}`;
  };
}

export interface FormAuthorityIdentityProbeEnv {
  readonly TAKOSERVER_FORM_AUTHORITY_HOST_ID: string;
  readonly PUBLIC_HOST_IDENTITY: PublicHostIdentityRpc;
  readonly FORM_AUTHORITY: FormAuthorityCoreVerifierIdentityRpc;
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
  if (request.method !== "GET" || url.search !== "") {
    return jsonError(404, "not_found");
  }
  if (url.pathname === FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_PATH) {
    try {
      const identity = await env.FORM_AUTHORITY.verifierIdentity();
      if (!isFormAuthorityCoreVerifierIdentity(identity)) {
        return jsonError(503, "verifier_unavailable");
      }
      return Response.json(identity, { status: 200, headers: responseHeaders() });
    } catch {
      return jsonError(503, "verifier_unavailable");
    }
  }
  if (url.pathname !== FORM_AUTHORITY_IDENTITY_PROBE_PATH) {
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

export function isFormAuthorityCoreVerifierIdentity(
  value: unknown,
): value is FormAuthorityCoreVerifierIdentity {
  if (!isRecord(value) || !hasExactKeys(value, ["kind", "authorityWorkerVersionId", "verifier"])) {
    return false;
  }
  if (
    value.kind !== FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND ||
    typeof value.authorityWorkerVersionId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      value.authorityWorkerVersionId,
    ) ||
    !isRecord(value.verifier) ||
    !hasExactKeys(value.verifier, ["protocol", "coreVersion", "coreCommit", "artifactDigest"])
  ) {
    return false;
  }
  return (
    value.verifier.protocol === "takoserver.takoform-core-verifier@v1" &&
    value.verifier.coreVersion === "v1.1.0" &&
    value.verifier.coreCommit === "e0e48b864de2a127a255cb0574d37bbb0f1cac29" &&
    typeof value.verifier.artifactDigest === "string" &&
    /^sha256:[0-9a-f]{64}$/u.test(value.verifier.artifactDigest)
  );
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

function hasExactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
