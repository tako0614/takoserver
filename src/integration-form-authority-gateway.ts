import {
  type ExactArtifactRecoveryGatewayAction,
  ExactArtifactRecoveryOperatorProofError,
  exactArtifactRecoveryActionPath,
  type SignedExactArtifactRecoveryRpcInvocation,
  signedExactArtifactRecoveryRpcInvocation,
  verifyExactArtifactRecoveryOperatorAssertion,
} from "./exact-artifact-recovery-operator-proof.ts";
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

export interface ExactArtifactRecoveryRpc {
  identity(): Promise<unknown>;
  status(invocation: SignedExactArtifactRecoveryRpcInvocation): Promise<unknown>;
  apply(invocation: SignedExactArtifactRecoveryRpcInvocation): Promise<unknown>;
  purge(invocation: SignedExactArtifactRecoveryRpcInvocation): Promise<unknown>;
}

export interface IntegrationFormAuthorityGatewayEnv {
  readonly TAKOSERVER_ENVIRONMENT: string;
  readonly TAKOSERVER_FORM_AUTHORITY_HOST_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID: string;
  readonly TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: string;
  readonly FORM_AUTHORITY: FormAuthorityRpc;
  readonly PUBLIC_HOST_IDENTITY: PublicHostIdentityRpc;
  readonly EXACT_ARTIFACT_RECOVERY?: ExactArtifactRecoveryRpc;
  readonly TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST?: string;
  readonly TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID?: string;
}

/** Runtime boundary shared by the ordinary and temporary target-generated gateway closures. */
export function integrationFormAuthorityGatewayEnv(
  value: unknown,
): IntegrationFormAuthorityGatewayEnv {
  if (!isRecord(value)) throw new TypeError("integration Form authority gateway Env is invalid");
  const formAuthority = value.FORM_AUTHORITY;
  const publicIdentity = value.PUBLIC_HOST_IDENTITY;
  const recovery = value.EXACT_ARTIFACT_RECOVERY;
  const requestDigest = value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST;
  const recoveryWorkerVersionId = value.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID;
  if (
    typeof value.TAKOSERVER_ENVIRONMENT !== "string" ||
    typeof value.TAKOSERVER_FORM_AUTHORITY_HOST_ID !== "string" ||
    typeof value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN !== "string" ||
    typeof value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK !== "string" ||
    typeof value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID !== "string" ||
    typeof value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE !== "string" ||
    !isFormAuthorityRpc(formAuthority) ||
    !isPublicHostIdentityRpc(publicIdentity) ||
    (recovery === undefined) !== (requestDigest === undefined) ||
    (recovery === undefined) !== (recoveryWorkerVersionId === undefined) ||
    (recovery !== undefined &&
      (!isExactArtifactRecoveryRpc(recovery) ||
        typeof requestDigest !== "string" ||
        typeof recoveryWorkerVersionId !== "string"))
  ) {
    throw new TypeError("integration Form authority gateway Env is invalid");
  }
  return {
    TAKOSERVER_ENVIRONMENT: value.TAKOSERVER_ENVIRONMENT,
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: value.TAKOSERVER_FORM_AUTHORITY_HOST_ID,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN: value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_ORIGIN,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK:
      value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID:
      value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_TENANT_ID,
    TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE: value.TAKOSERVER_FORM_AUTHORITY_OPERATOR_SPACE,
    FORM_AUTHORITY: formAuthority,
    PUBLIC_HOST_IDENTITY: publicIdentity,
    ...(recovery === undefined
      ? {}
      : {
          EXACT_ARTIFACT_RECOVERY: recovery,
          TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST: requestDigest as string,
          TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID: recoveryWorkerVersionId as string,
        }),
  };
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
    const formAction = gatewayAction(url.pathname);
    const recoveryAction = recoveryGatewayAction(url.pathname);
    if (
      url.origin !== origin ||
      url.search ||
      request.method !== "POST" ||
      (!formAction && !recoveryAction)
    ) {
      return response(404, "not_found");
    }
    if (recoveryAction && !env.EXACT_ARTIFACT_RECOVERY) return response(404, "not_found");
    if (request.headers.get("content-type") !== "application/json") {
      return response(415, "unsupported_media_type");
    }
    assertDeclaredBodySize(request);
    const assertion = bearer(request.headers.get("authorization"));
    const body = parseStrictJson(await boundedBody(request), MAX_BODY_BYTES);
    if (!isRecord(body)) return response(400, "invalid_request");
    let live: unknown;
    try {
      live = await env.PUBLIC_HOST_IDENTITY.identity();
    } catch {
      return response(503, "identity_unavailable");
    }
    if (!isPublicHostIdentity(live)) {
      return response(503, "identity_unavailable");
    }
    const hostId = env.TAKOSERVER_FORM_AUTHORITY_HOST_ID;
    if (hostId.length === 0 || hostId.length > 255) {
      return response(503, "identity_unavailable");
    }
    if (live.hostId !== hostId) return response(409, "public_host_drift");
    if (recoveryAction) {
      return await handleExactArtifactRecoveryGateway({
        action: recoveryAction,
        assertion,
        body,
        env,
        live,
        hostId,
        clock,
      });
    }
    const action = formAction;
    if (!action) return response(404, "not_found");
    try {
      await verifyFormAuthorityOperatorAssertion({
        assertion,
        action,
        path: formAuthorityActionPath(action),
        body,
        identity: {
          environment: "integration",
          hostId,
          workerArtifactDigest: live.workerArtifactDigest,
          publicWorkerVersionId: live.workerVersionId,
          implementationDigest: live.implementationDigest,
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

async function handleExactArtifactRecoveryGateway(input: {
  readonly action: ExactArtifactRecoveryGatewayAction;
  readonly assertion: string;
  readonly body: Readonly<Record<string, unknown>>;
  readonly env: IntegrationFormAuthorityGatewayEnv;
  readonly live: {
    readonly hostId: string;
    readonly workerArtifactDigest: `sha256:${string}`;
    readonly workerVersionId: string;
    readonly implementationDigest: `sha256:${string}`;
  };
  readonly hostId: string;
  readonly clock: () => Date;
}): Promise<Response> {
  const binding = input.env.EXACT_ARTIFACT_RECOVERY;
  const requestDigest = input.env.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_REQUEST_DIGEST;
  const workerVersionId = input.env.TAKOSERVER_EXACT_ARTIFACT_RECOVERY_WORKER_VERSION_ID;
  if (!binding || !requestDigest || !workerVersionId || !isSha256Digest(requestDigest)) {
    return response(503, "identity_unavailable");
  }
  let target: unknown;
  try {
    target = await binding.identity();
  } catch {
    return response(503, "identity_unavailable");
  }
  if (
    !isRecord(target) ||
    target.kind !== "takoserver.exact-artifact-recovery-worker-identity@v1" ||
    target.requestDigest !== requestDigest ||
    target.workerVersionId !== workerVersionId
  ) {
    return response(409, "recovery_worker_drift");
  }
  try {
    await verifyExactArtifactRecoveryOperatorAssertion({
      assertion: input.assertion,
      action: input.action,
      body: input.body,
      identity: {
        environment: "integration",
        hostId: input.hostId,
        workerArtifactDigest: input.live.workerArtifactDigest,
        publicWorkerVersionId: input.live.workerVersionId,
        implementationDigest: input.live.implementationDigest,
        requestDigest,
        recoveryWorkerVersionId: workerVersionId,
      },
      publicJwk: input.env.TAKOSERVER_FORM_AUTHORITY_OPERATOR_PUBLIC_JWK,
      clock: input.clock,
    });
  } catch (error) {
    if (
      error instanceof ExactArtifactRecoveryOperatorProofError &&
      error.code === "identity_unavailable"
    ) {
      return response(503, "identity_unavailable");
    }
    if (
      error instanceof ExactArtifactRecoveryOperatorProofError &&
      error.code === "operator_scope_mismatch"
    ) {
      return response(403, "operator_scope_mismatch");
    }
    return response(401, "invalid_operator_assertion");
  }
  const invocation = signedExactArtifactRecoveryRpcInvocation({
    action: input.action,
    assertion: input.assertion,
    body: input.body,
  });
  let result: unknown;
  try {
    switch (input.action) {
      case "status":
        result = await binding.status(invocation);
        break;
      case "apply":
        result = await binding.apply(invocation);
        break;
      case "purge":
        result = await binding.purge(invocation);
        break;
    }
  } catch (error) {
    const code = error instanceof Error ? error.message : "invalid_request";
    if (code === "state_conflict") return response(409, code);
    if (code === "identity_unavailable") return response(503, code);
    return response(400, "invalid_request");
  }
  return Response.json(result, {
    status: 200,
    headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" },
  });
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

function recoveryGatewayAction(path: string): ExactArtifactRecoveryGatewayAction | null {
  for (const action of ["status", "apply", "purge"] as const) {
    if (path === exactArtifactRecoveryActionPath(action)) return action;
  }
  return null;
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

function isFormAuthorityRpc(value: unknown): value is FormAuthorityRpc {
  return (
    isRecord(value) &&
    typeof value.plan === "function" &&
    typeof value.apply === "function" &&
    typeof value.readback === "function"
  );
}

function isPublicHostIdentityRpc(value: unknown): value is PublicHostIdentityRpc {
  return isRecord(value) && typeof value.identity === "function";
}

function isExactArtifactRecoveryRpc(value: unknown): value is ExactArtifactRecoveryRpc {
  return (
    isRecord(value) &&
    typeof value.identity === "function" &&
    typeof value.status === "function" &&
    typeof value.apply === "function" &&
    typeof value.purge === "function"
  );
}
