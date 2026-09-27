import {
  authenticateExistingSpaceOperatorAssertion,
  type ExistingSpaceOperatorAction,
  type ExistingSpaceOperatorIdentity,
  existingSpaceOperatorOrigin,
  existingSpaceOperatorPath,
  verifyExistingSpaceOperatorClaims,
} from "./existing-space-operator-proof.ts";
import { isFormAuthorityCoreVerifierIdentity } from "./form-authority-identity-probe.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { isPublicHostIdentity, type PublicHostIdentityRpc } from "./public-host-identity.ts";
import { parseStrictJson } from "./strict-json.ts";
import { isSpaceId } from "./takoform/space-id.ts";

export interface ExistingSpaceOperatorRpc {
  verifierIdentity(): Promise<unknown>;
  reconcileExistingSpaces(
    request: {
      readonly policyDigest: string;
      readonly spaces: readonly string[];
    },
    expected: ExistingSpaceOperatorFence,
  ): Promise<unknown>;
  readback(request: unknown): Promise<unknown>;
}

export interface ExistingSpaceOperatorFence {
  readonly identity: Omit<
    ExistingSpaceOperatorIdentity,
    "origin" | "policyDigest" | "authorityWorkerVersionId"
  >;
  readonly authorityWorkerVersionId: string;
}

/** Runtime port, not a second Worker binding declaration. No storage or provider authority. */
export interface ExistingSpaceOperatorRuntime {
  readonly TAKOSERVER_ENVIRONMENT: string;
  readonly TAKOSERVER_FORM_AUTHORITY_HOST_ID: string;
  readonly TAKOSERVER_EXISTING_SPACE_OPERATOR_ORIGIN: string;
  readonly TAKOSERVER_EXISTING_SPACE_OPERATOR_PUBLIC_JWK: string;
  readonly TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY: string;
  readonly PUBLIC_HOST_IDENTITY: PublicHostIdentityRpc;
  readonly FORM_AUTHORITY: ExistingSpaceOperatorRpc;
}

export function existingSpaceOperatorRuntime(value: unknown): ExistingSpaceOperatorRuntime {
  if (!record(value)) throw new TypeError("invalid operator runtime");
  const authority = value.FORM_AUTHORITY;
  const host = value.PUBLIC_HOST_IDENTITY;
  if (
    !record(authority) ||
    typeof authority.verifierIdentity !== "function" ||
    typeof authority.reconcileExistingSpaces !== "function" ||
    typeof authority.readback !== "function" ||
    !record(host) ||
    typeof host.identity !== "function"
  )
    throw new TypeError("invalid operator bindings");
  for (const name of [
    "TAKOSERVER_ENVIRONMENT",
    "TAKOSERVER_FORM_AUTHORITY_HOST_ID",
    "TAKOSERVER_EXISTING_SPACE_OPERATOR_ORIGIN",
    "TAKOSERVER_EXISTING_SPACE_OPERATOR_PUBLIC_JWK",
    "TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY",
  ]) {
    if (typeof value[name] !== "string") throw new TypeError("invalid operator configuration");
  }
  // These structural checks bridge generated Service bindings and the narrow
  // runtime port without importing the privileged authority's implementation.
  return value as unknown as ExistingSpaceOperatorRuntime;
}

/** Two closed operations. This is not the Host API or a plan/apply proxy. */
export async function handleExistingSpaceOperator(
  request: Request,
  env: ExistingSpaceOperatorRuntime,
  clock: () => Date = () => new Date(),
): Promise<Response> {
  let action: ExistingSpaceOperatorAction;
  let body: Record<string, unknown>;
  let fence: ExistingSpaceOperatorFence;
  try {
    const url = new URL(request.url);
    const origin = existingSpaceOperatorOrigin(env.TAKOSERVER_EXISTING_SPACE_OPERATOR_ORIGIN);
    if (url.origin !== origin || url.search || request.method !== "POST")
      return failure(404, "not_found");
    if (url.pathname === existingSpaceOperatorPath("reconcile")) action = "reconcile";
    else if (url.pathname === existingSpaceOperatorPath("readback")) action = "readback";
    else return failure(404, "not_found");
    if (request.headers.get("content-type") !== "application/json")
      return failure(415, "unsupported_media_type");
    const authorization = request.headers.get("authorization");
    if (
      !authorization?.startsWith("Bearer ") ||
      authorization.length > 8192 ||
      authorization.slice(7).includes(" ")
    ) {
      return failure(401, "invalid_operator_assertion");
    }
    const value = parseStrictJson(await boundedOperatorBody(request), 2 * 1024 * 1024);
    if (!record(value)) return failure(400, "invalid_request");
    body = value;
    let claims: Readonly<Record<string, unknown>>;
    try {
      // Unauthenticated input must never wake the released verifier container.
      claims = await authenticateExistingSpaceOperatorAssertion({
        assertion: authorization.slice(7),
        publicJwk: env.TAKOSERVER_EXISTING_SPACE_OPERATOR_PUBLIC_JWK,
        clock,
      });
    } catch {
      return failure(401, "invalid_operator_assertion");
    }
    // Target parsing and the authority own full Form validation. The bridge
    // checks only its sealed canonical policy envelope; importing the domain
    // parser here would pull package-storage writers into this transport.
    const policy = parseStrictJson(
      new TextEncoder().encode(env.TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY),
      2 * 1024 * 1024,
    );
    if (
      !record(policy) ||
      Object.keys(policy).sort().join() !== "forms,kind,organizationId" ||
      policy.kind !== "takoserver.space-form-admission-policy@v1" ||
      typeof policy.organizationId !== "string" ||
      !policy.organizationId ||
      !Array.isArray(policy.forms) ||
      policy.forms.length === 0 ||
      canonicalJson(policy) !== env.TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY
    )
      return failure(503, "identity_unavailable");
    const policyDigest = await canonicalDigest(policy);
    const live = await env.PUBLIC_HOST_IDENTITY.identity();
    if (!isPublicHostIdentity(live) || live.hostId !== env.TAKOSERVER_FORM_AUTHORITY_HOST_ID)
      return failure(409, "public_host_drift");
    const authority = await env.FORM_AUTHORITY.verifierIdentity();
    if (!isFormAuthorityCoreVerifierIdentity(authority))
      return failure(503, "identity_unavailable");
    const environment = env.TAKOSERVER_ENVIRONMENT;
    if (
      environment !== "integration" &&
      environment !== "production" &&
      environment !== "rehearsal"
    )
      return failure(503, "identity_unavailable");
    const identity = {
      environment,
      hostId: live.hostId,
      workerArtifactDigest: live.workerArtifactDigest,
      publicWorkerVersionId: live.workerVersionId,
      capabilityDigest: live.capabilityDigest,
      implementationDigest: live.implementationDigest,
    } as const;
    fence = { identity, authorityWorkerVersionId: authority.authorityWorkerVersionId };
    try {
      await verifyExistingSpaceOperatorClaims({
        claims,
        clock,
        action,
        body,
        identity: {
          ...identity,
          policyDigest,
          origin,
          authorityWorkerVersionId: authority.authorityWorkerVersionId,
        },
      });
    } catch {
      return failure(401, "invalid_operator_assertion");
    }
    if (action === "reconcile") {
      if (
        Object.keys(body).sort().join() !== "policyDigest,spaces" ||
        body.policyDigest !== policyDigest ||
        !Array.isArray(body.spaces) ||
        body.spaces.length < 1 ||
        body.spaces.length > 100 ||
        !body.spaces.every((space) => typeof space === "string" && isSpaceId(space)) ||
        new Set(body.spaces).size !== body.spaces.length
      )
        return failure(400, "invalid_request");
    } else {
      // readback uses the existing v2 plan-request shape; it does not create a plan.
      const { kind, activation, evidence, actor, reason, ...requestedIdentity } = body;
      if (
        kind !== "takoserver.form-authority-plan-request@v2" ||
        !record(activation) ||
        Object.keys(activation).sort().join() !== "desiredActive,kind,space,tenantId" ||
        activation.kind !== "space" ||
        activation.tenantId !== policy.organizationId ||
        activation.desiredActive !== true ||
        typeof activation.space !== "string" ||
        !isSpaceId(activation.space) ||
        typeof actor !== "string" ||
        typeof reason !== "string" ||
        !record(evidence) ||
        canonicalJson(requestedIdentity) !== canonicalJson(identity)
      )
        return failure(400, "invalid_request");
    }
  } catch {
    return failure(503, "identity_unavailable");
  }
  // Once entered, a rejection can follow partial durable work. Never relabel it
  // as a pre-mutation failure, retry, or roll it back.
  try {
    const result =
      action === "reconcile"
        ? await env.FORM_AUTHORITY.reconcileExistingSpaces(
            body as { policyDigest: string; spaces: string[] },
            fence,
          )
        : await env.FORM_AUTHORITY.readback(body);
    return Response.json(result, { headers: headers() });
  } catch {
    return failure(
      502,
      action === "reconcile" ? "reconciliation_indeterminate" : "readback_unavailable",
    );
  }
}

export async function boundedOperatorBody(
  value: Request | Response,
  max = 2 * 1024 * 1024,
): Promise<Uint8Array> {
  const declared = value.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > max))
    throw new TypeError("request_too_large");
  if (!value.body) throw new TypeError("invalid_request");
  const reader = value.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > max) {
        await reader.cancel();
        throw new TypeError("request_too_large");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function headers() {
  return { "cache-control": "no-store", "x-content-type-options": "nosniff" };
}
function failure(status: number, code: string) {
  return Response.json({ error: { code } }, { status, headers: headers() });
}
