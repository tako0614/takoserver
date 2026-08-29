import {
  assertFormAuthorityOperatorScope,
  type FormAuthorityGatewayAction,
  FormAuthorityOperatorProofError,
  formAuthorityActionPath,
  type SignedFormAuthorityRpcInvocation,
  signedFormAuthorityRpcInvocation,
  verifyFormAuthorityOperatorAssertion,
} from "./form-authority-operator-proof.ts";
import { isSha256Digest } from "./json.ts";
import { isPublicHostIdentity, type PublicHostIdentityRpc } from "./public-host-identity.ts";
import { parseStrictJson } from "./strict-json.ts";

const MAX_BODY_BYTES = 2 * 1_024 * 1_024;
const MAX_ASSERTION_BYTES = 12 * 1_024;

export interface FormAuthorityRpc {
  plan(invocation: SignedFormAuthorityRpcInvocation): Promise<unknown>;
  apply(invocation: SignedFormAuthorityRpcInvocation): Promise<unknown>;
  readback(invocation: SignedFormAuthorityRpcInvocation): Promise<unknown>;
}

export interface IntegrationFormAuthorityGatewayEnv {
  readonly TAKOSERVER_ENVIRONMENT: string;
  readonly TAKOSERVER_FORM_AUTHORITY_HOST_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: string;
  readonly TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST: string;
  readonly TAKOSERVER_PUBLIC_WORKER_VERSION_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: string;
  readonly FORM_AUTHORITY: FormAuthorityRpc;
  readonly PUBLIC_HOST_IDENTITY: PublicHostIdentityRpc;
}

export async function handleIntegrationFormAuthorityGateway(
  request: Request,
  env: IntegrationFormAuthorityGatewayEnv,
  clock: () => Date = () => new Date(),
): Promise<Response> {
  // Observable ordering is intentional: no identity, credential, or service
  // binding is read outside the exact integration environment.
  if (env.TAKOSERVER_ENVIRONMENT !== "integration") {
    return response(503, "integration_only");
  }
  try {
    const url = new URL(request.url);
    const origin = exactOrigin(env.TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN);
    const action = gatewayAction(url.pathname);
    if (url.origin !== origin || url.search || request.method !== "POST" || !action) {
      return response(404, "not_found");
    }
    if (request.headers.get("content-type") !== "application/json") {
      return response(415, "unsupported_media_type");
    }
    assertDeclaredBodySize(request);
    const assertion = bearer(request.headers.get("authorization"));
    const body = parseStrictJson(await boundedBody(request), MAX_BODY_BYTES);
    if (!isRecord(body)) return response(400, "invalid_request");
    const hostId = env.TAKOSERVER_FORM_AUTHORITY_HOST_ID;
    const workerArtifactDigest = env.TAKOSERVER_PUBLIC_WORKER_ARTIFACT_DIGEST;
    const publicWorkerVersionId = env.TAKOSERVER_PUBLIC_WORKER_VERSION_ID;
    if (
      hostId.length === 0 ||
      hostId.length > 255 ||
      !isSha256Digest(workerArtifactDigest) ||
      !workerVersion(publicWorkerVersionId)
    ) {
      return response(503, "identity_unavailable");
    }
    try {
      await verifyFormAuthorityOperatorAssertion({
        assertion,
        action,
        path: formAuthorityActionPath(action),
        body,
        identity: {
          environment: "integration",
          hostId,
          workerArtifactDigest,
          publicWorkerVersionId,
        },
        publicJwk: env.TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK,
        clock,
      });
      assertFormAuthorityOperatorScope({
        action,
        body,
        expected: {
          tenantId: env.TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID,
          space: env.TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE,
        },
      });
    } catch (error) {
      if (
        error instanceof FormAuthorityOperatorProofError &&
        error.code === "identity_unavailable"
      ) {
        return response(503, "identity_unavailable");
      }
      if (
        error instanceof FormAuthorityOperatorProofError &&
        error.code === "operator_scope_mismatch"
      ) {
        return response(403, "operator_scope_mismatch");
      }
      return response(401, "invalid_operator_assertion");
    }
    const live = await env.PUBLIC_HOST_IDENTITY.identity();
    if (
      !isPublicHostIdentity(live) ||
      live.hostId !== hostId ||
      live.workerVersionId !== publicWorkerVersionId
    ) {
      return response(409, "public_host_drift");
    }
    let result: unknown;
    const rpcInvocation = signedFormAuthorityRpcInvocation({ action, assertion, body });
    switch (action) {
      case "plan":
        result = await env.FORM_AUTHORITY.plan(rpcInvocation);
        break;
      case "apply":
        result = await env.FORM_AUTHORITY.apply(rpcInvocation);
        break;
      case "readback":
        result = await env.FORM_AUTHORITY.readback(rpcInvocation);
        break;
    }
    return Response.json(result, {
      status: 200,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch (error) {
    const code = operatorErrorCode(error);
    const status =
      code === "invalid_operator_assertion"
        ? 401
        : code === "operator_scope_mismatch"
          ? 403
          : code === "request_too_large"
            ? 413
            : code === "identity_unavailable"
              ? 503
              : 400;
    return response(status, code);
  }
}

function gatewayAction(path: string): FormAuthorityGatewayAction | null {
  switch (path) {
    case "/v1/plan":
      return "plan";
    case "/v1/apply":
      return "apply";
    case "/v1/readback":
      return "readback";
    default:
      return null;
  }
}

async function boundedBody(request: Request): Promise<Uint8Array> {
  assertDeclaredBodySize(request);
  if (!request.body) throw new TypeError("invalid_request");
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new TypeError("request_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function assertDeclaredBodySize(request: Request): void {
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > MAX_BODY_BYTES)) {
    throw new TypeError("request_too_large");
  }
}

function bearer(value: string | null): string {
  if (!value || value.length > MAX_ASSERTION_BYTES || !value.startsWith("Bearer ")) {
    throw new TypeError("invalid_operator_assertion");
  }
  const assertion = value.slice("Bearer ".length);
  if (!assertion || assertion.includes(" ")) throw new TypeError("invalid_operator_assertion");
  return assertion;
}

function exactOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    url.hostname.endsWith(".workers.dev")
  ) {
    throw new TypeError("identity_unavailable");
  }
  return url.origin;
}

function workerVersion(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function operatorErrorCode(error: unknown): string {
  if (error instanceof TypeError && /^[a-z_]+$/u.test(error.message)) return error.message;
  if (
    isRecord(error) &&
    typeof error.code === "string" &&
    /^[a-z][a-z0-9_]{0,63}$/u.test(error.code)
  ) {
    return error.code;
  }
  return "invalid_request";
}

function response(status: number, code: string): Response {
  return Response.json(
    { error: { code } },
    {
      status,
      headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
    },
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
