import { canonicalDigest, isSha256Digest } from "./json.ts";
import { createOperatorPurposeVerifier } from "./operator-credentials.ts";

export type FormAuthorityGatewayAction = "plan" | "apply" | "readback";

export interface FormAuthorityProofIdentity {
  readonly environment: "integration";
  readonly hostId: string;
  readonly workerArtifactDigest: `sha256:${string}`;
  readonly publicWorkerVersionId: string;
  readonly implementationDigest: `sha256:${string}`;
}

export interface FormAuthorityOperatorScope {
  readonly tenantId: string;
  readonly space: string;
}

/**
 * Exact proof-bearing value crossing the private service-binding boundary.
 *
 * The gateway forwards the original operator assertion, not a gateway verdict.
 * The route-less authority Worker therefore authenticates the same method,
 * path, body and live public-Worker identity independently.
 */
export interface SignedFormAuthorityRpcInvocation {
  readonly kind: "takoserver.signed-form-authority-rpc@v2";
  readonly action: FormAuthorityGatewayAction;
  readonly method: "POST";
  readonly path: `/v1/${FormAuthorityGatewayAction}`;
  readonly assertion: string;
  readonly body: unknown;
}

export class FormAuthorityOperatorProofError extends Error {
  constructor(
    readonly code:
      | "identity_unavailable"
      | "invalid_operator_assertion"
      | "operator_scope_mismatch",
  ) {
    super(code);
    this.name = "FormAuthorityOperatorProofError";
  }
}

/**
 * Authorizes the signed body against the target-owned tenant/Space binding.
 * Apply nests the original plan request; plan and readback carry it directly.
 */
export function assertFormAuthorityOperatorScope(input: {
  readonly action: FormAuthorityGatewayAction;
  readonly body: unknown;
  readonly expected: FormAuthorityOperatorScope;
}): void {
  if (
    !boundedScopeIdentity(input.expected.tenantId) ||
    !boundedScopeIdentity(input.expected.space)
  ) {
    throw new FormAuthorityOperatorProofError("identity_unavailable");
  }
  const body = input.body;
  const request =
    input.action === "apply" && isRecord(body) && isRecord(body.request) ? body.request : body;
  const activation = isRecord(request) ? request.activation : undefined;
  if (
    !isRecord(activation) ||
    !exactKeys(activation, ["desiredActive", "kind", "space", "tenantId"]) ||
    activation.kind !== "space" ||
    typeof activation.desiredActive !== "boolean" ||
    activation.tenantId !== input.expected.tenantId ||
    activation.space !== input.expected.space
  ) {
    throw new FormAuthorityOperatorProofError("operator_scope_mismatch");
  }
}

export function formAuthorityActionPath(
  action: FormAuthorityGatewayAction,
): `/v1/${FormAuthorityGatewayAction}` {
  return `/v1/${action}`;
}

export function signedFormAuthorityRpcInvocation(input: {
  readonly action: FormAuthorityGatewayAction;
  readonly assertion: string;
  readonly body: unknown;
}): SignedFormAuthorityRpcInvocation {
  return {
    kind: "takoserver.signed-form-authority-rpc@v2",
    action: input.action,
    method: "POST",
    path: formAuthorityActionPath(input.action),
    assertion: input.assertion,
    body: structuredClone(input.body),
  };
}

export async function verifySignedFormAuthorityRpcInvocation(input: {
  readonly invocation: unknown;
  readonly expectedAction: FormAuthorityGatewayAction;
  readonly identity: FormAuthorityProofIdentity;
  readonly publicJwk: string | Readonly<Record<string, unknown>>;
  readonly clock?: () => Date;
}): Promise<unknown> {
  const invocation = input.invocation;
  if (
    !isRecord(invocation) ||
    !exactKeys(invocation, ["action", "assertion", "body", "kind", "method", "path"]) ||
    invocation.kind !== "takoserver.signed-form-authority-rpc@v2" ||
    invocation.action !== input.expectedAction ||
    invocation.method !== "POST" ||
    invocation.path !== formAuthorityActionPath(input.expectedAction) ||
    typeof invocation.assertion !== "string" ||
    invocation.assertion.length === 0 ||
    invocation.assertion.length > 12 * 1_024 ||
    !isRecord(invocation.body)
  ) {
    throw new FormAuthorityOperatorProofError("invalid_operator_assertion");
  }
  await verifyFormAuthorityOperatorAssertion({
    assertion: invocation.assertion,
    action: input.expectedAction,
    path: formAuthorityActionPath(input.expectedAction),
    body: invocation.body,
    identity: input.identity,
    publicJwk: input.publicJwk,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  return structuredClone(invocation.body);
}

export async function verifyFormAuthorityOperatorAssertion(input: {
  readonly assertion: string;
  readonly action: FormAuthorityGatewayAction;
  readonly path: `/v1/${FormAuthorityGatewayAction}`;
  readonly body: unknown;
  readonly identity: FormAuthorityProofIdentity;
  readonly publicJwk: string | Readonly<Record<string, unknown>>;
  readonly clock?: () => Date;
}): Promise<void> {
  validateProofIdentity(input.identity);
  const publicJwk = parseFormAuthorityOperatorPublicJwk(input.publicJwk);
  let claims: Readonly<Record<string, unknown>>;
  try {
    claims = await createOperatorPurposeVerifier({
      publicKeyJwk: publicJwk,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      maxLifetimeSeconds: 120,
    }).verify(input.assertion, "form-authority");
  } catch {
    throw new FormAuthorityOperatorProofError("invalid_operator_assertion");
  }
  const bodyDigest = await canonicalDigest(input.body);
  if (
    !exactKeys(claims, [
      "action",
      "bodyDigest",
      "environment",
      "exp",
      "hostId",
      "iat",
      "implementationDigest",
      "method",
      "path",
      "publicWorkerVersionId",
      "purpose",
      "workerArtifactDigest",
    ]) ||
    claims.action !== input.action ||
    claims.method !== "POST" ||
    claims.path !== input.path ||
    claims.bodyDigest !== bodyDigest ||
    claims.environment !== input.identity.environment ||
    claims.hostId !== input.identity.hostId ||
    claims.workerArtifactDigest !== input.identity.workerArtifactDigest ||
    claims.publicWorkerVersionId !== input.identity.publicWorkerVersionId ||
    claims.implementationDigest !== input.identity.implementationDigest
  ) {
    throw new FormAuthorityOperatorProofError("invalid_operator_assertion");
  }
}

export function parseFormAuthorityOperatorPublicJwk(
  input: string | Readonly<Record<string, unknown>>,
): { readonly kty: "OKP"; readonly crv: "Ed25519"; readonly x: string } {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new FormAuthorityOperatorProofError("identity_unavailable");
    }
  }
  if (
    !isRecord(value) ||
    !exactKeys(value, ["crv", "kty", "x"]) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.x)
  ) {
    throw new FormAuthorityOperatorProofError("identity_unavailable");
  }
  return { kty: value.kty, crv: value.crv, x: value.x };
}

function validateProofIdentity(identity: FormAuthorityProofIdentity): void {
  if (
    identity.environment !== "integration" ||
    identity.hostId.length === 0 ||
    identity.hostId.length > 255 ||
    !isSha256Digest(identity.workerArtifactDigest) ||
    !isSha256Digest(identity.implementationDigest) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      identity.publicWorkerVersionId,
    )
  ) {
    throw new FormAuthorityOperatorProofError("identity_unavailable");
  }
}

function boundedScopeIdentity(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 255 &&
    value.trim() === value &&
    ![...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  );
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
