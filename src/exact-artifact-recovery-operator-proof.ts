import {
  ARTIFACT_RECOVERY_APPLY_FORMAT,
  canonicalArtifactRecoveryRequest,
  type Digest,
} from "./artifact-recovery.ts";
import { canonicalDigest, isSha256Digest } from "./json.ts";
import { createOperatorPurposeVerifier } from "./operator-credentials.ts";

export type ExactArtifactRecoveryGatewayAction = "status" | "apply" | "purge";

export interface ExactArtifactRecoveryProofIdentity {
  readonly environment: "integration";
  readonly hostId: string;
  readonly workerArtifactDigest: Digest;
  readonly publicWorkerVersionId: string;
  readonly implementationDigest: Digest;
  readonly requestDigest: Digest;
  readonly recoveryWorkerVersionId: string;
}

export interface SignedExactArtifactRecoveryRpcInvocation {
  readonly kind: "takoserver.signed-exact-artifact-recovery-rpc@v1";
  readonly action: ExactArtifactRecoveryGatewayAction;
  readonly method: "POST";
  readonly path: `/v1/exact-artifact-recovery/${ExactArtifactRecoveryGatewayAction}`;
  readonly assertion: string;
  readonly body: unknown;
}

export class ExactArtifactRecoveryOperatorProofError extends Error {
  constructor(
    readonly code:
      | "identity_unavailable"
      | "invalid_operator_assertion"
      | "operator_scope_mismatch",
  ) {
    super(code);
    this.name = "ExactArtifactRecoveryOperatorProofError";
  }
}

export function exactArtifactRecoveryActionPath(
  action: ExactArtifactRecoveryGatewayAction,
): `/v1/exact-artifact-recovery/${ExactArtifactRecoveryGatewayAction}` {
  return `/v1/exact-artifact-recovery/${action}`;
}

export async function exactArtifactRecoveryRequestDigest(input: {
  readonly action: ExactArtifactRecoveryGatewayAction;
  readonly body: unknown;
}): Promise<Digest> {
  const request = recoveryRequestFromBody(input.action, input.body);
  return (await canonicalArtifactRecoveryRequest(request)).requestDigest;
}

export function signedExactArtifactRecoveryRpcInvocation(input: {
  readonly action: ExactArtifactRecoveryGatewayAction;
  readonly assertion: string;
  readonly body: unknown;
}): SignedExactArtifactRecoveryRpcInvocation {
  return {
    kind: "takoserver.signed-exact-artifact-recovery-rpc@v1",
    action: input.action,
    method: "POST",
    path: exactArtifactRecoveryActionPath(input.action),
    assertion: input.assertion,
    body: structuredClone(input.body),
  };
}

export async function verifyExactArtifactRecoveryOperatorAssertion(input: {
  readonly assertion: string;
  readonly action: ExactArtifactRecoveryGatewayAction;
  readonly body: unknown;
  readonly identity: ExactArtifactRecoveryProofIdentity;
  readonly publicJwk: string | Readonly<Record<string, unknown>>;
  readonly clock?: () => Date;
}): Promise<void> {
  validateIdentity(input.identity);
  const requestDigest = await exactArtifactRecoveryRequestDigest(input).catch(() => null);
  if (requestDigest !== input.identity.requestDigest) {
    throw new ExactArtifactRecoveryOperatorProofError("operator_scope_mismatch");
  }
  const publicJwk = parsePublicJwk(input.publicJwk);
  let claims: Readonly<Record<string, unknown>>;
  try {
    claims = await createOperatorPurposeVerifier({
      publicKeyJwk: publicJwk,
      ...(input.clock === undefined ? {} : { clock: input.clock }),
      maxLifetimeSeconds: 120,
    }).verify(input.assertion, "exact-artifact-recovery");
  } catch {
    throw new ExactArtifactRecoveryOperatorProofError("invalid_operator_assertion");
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
      "recoveryWorkerVersionId",
      "requestDigest",
      "workerArtifactDigest",
    ]) ||
    claims.action !== input.action ||
    claims.method !== "POST" ||
    claims.path !== exactArtifactRecoveryActionPath(input.action) ||
    claims.bodyDigest !== bodyDigest ||
    claims.environment !== input.identity.environment ||
    claims.hostId !== input.identity.hostId ||
    claims.workerArtifactDigest !== input.identity.workerArtifactDigest ||
    claims.publicWorkerVersionId !== input.identity.publicWorkerVersionId ||
    claims.implementationDigest !== input.identity.implementationDigest ||
    claims.requestDigest !== input.identity.requestDigest ||
    claims.recoveryWorkerVersionId !== input.identity.recoveryWorkerVersionId
  ) {
    throw new ExactArtifactRecoveryOperatorProofError("invalid_operator_assertion");
  }
}

export async function verifySignedExactArtifactRecoveryRpcInvocation(input: {
  readonly invocation: unknown;
  readonly expectedAction: ExactArtifactRecoveryGatewayAction;
  readonly identity: ExactArtifactRecoveryProofIdentity;
  readonly publicJwk: string | Readonly<Record<string, unknown>>;
  readonly clock?: () => Date;
}): Promise<unknown> {
  const invocation = input.invocation;
  if (
    !record(invocation) ||
    !exactKeys(invocation, ["action", "assertion", "body", "kind", "method", "path"]) ||
    invocation.kind !== "takoserver.signed-exact-artifact-recovery-rpc@v1" ||
    invocation.action !== input.expectedAction ||
    invocation.method !== "POST" ||
    invocation.path !== exactArtifactRecoveryActionPath(input.expectedAction) ||
    typeof invocation.assertion !== "string" ||
    invocation.assertion.length < 1 ||
    invocation.assertion.length > 12 * 1_024 ||
    !record(invocation.body)
  ) {
    throw new ExactArtifactRecoveryOperatorProofError("invalid_operator_assertion");
  }
  await verifyExactArtifactRecoveryOperatorAssertion({
    assertion: invocation.assertion,
    action: input.expectedAction,
    body: invocation.body,
    identity: input.identity,
    publicJwk: input.publicJwk,
    ...(input.clock === undefined ? {} : { clock: input.clock }),
  });
  return structuredClone(invocation.body);
}

function recoveryRequestFromBody(
  action: ExactArtifactRecoveryGatewayAction,
  body: unknown,
): unknown {
  if (action !== "apply") return body;
  if (
    !record(body) ||
    !exactKeys(body, ["kind", "planDigest", "request"]) ||
    body.kind !== ARTIFACT_RECOVERY_APPLY_FORMAT ||
    !isSha256Digest(body.planDigest)
  ) {
    throw new TypeError("invalid exact artifact recovery apply body");
  }
  return body.request;
}

function validateIdentity(identity: ExactArtifactRecoveryProofIdentity): void {
  if (
    identity.environment !== "integration" ||
    identity.hostId.length < 1 ||
    identity.hostId.length > 255 ||
    !isSha256Digest(identity.workerArtifactDigest) ||
    !isSha256Digest(identity.implementationDigest) ||
    !isSha256Digest(identity.requestDigest) ||
    !workerVersion(identity.publicWorkerVersionId) ||
    !workerVersion(identity.recoveryWorkerVersionId)
  ) {
    throw new ExactArtifactRecoveryOperatorProofError("identity_unavailable");
  }
}

function parsePublicJwk(input: string | Readonly<Record<string, unknown>>): {
  readonly kty: "OKP";
  readonly crv: "Ed25519";
  readonly x: string;
} {
  let value: unknown = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      throw new ExactArtifactRecoveryOperatorProofError("identity_unavailable");
    }
  }
  if (
    !record(value) ||
    !exactKeys(value, ["crv", "kty", "x"]) ||
    value.kty !== "OKP" ||
    value.crv !== "Ed25519" ||
    typeof value.x !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(value.x)
  ) {
    throw new ExactArtifactRecoveryOperatorProofError("identity_unavailable");
  }
  return { kty: "OKP", crv: "Ed25519", x: value.x };
}

function workerVersion(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function exactKeys(value: Readonly<Record<string, unknown>>, keys: readonly string[]): boolean {
  return JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function record(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
