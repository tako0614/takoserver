import { parseFormAuthorityOperatorPublicJwk } from "./form-authority-operator-proof.ts";
import { canonicalDigest, isSha256Digest } from "./json.ts";
import { createOperatorPurposeVerifier } from "./operator-credentials.ts";
import type { PublicHostIdentity } from "./public-host-identity.ts";

export const EXISTING_SPACE_OPERATOR_PURPOSE = "existing-space-reconciliation";
export type ExistingSpaceOperatorAction = "reconcile" | "readback";
export interface ExistingSpaceOperatorIdentity
  extends Pick<
    PublicHostIdentity,
    "hostId" | "workerArtifactDigest" | "capabilityDigest" | "implementationDigest"
  > {
  readonly environment: "integration" | "rehearsal" | "production";
  readonly publicWorkerVersionId: string;
  readonly authorityWorkerVersionId: string;
  readonly policyDigest: `sha256:${string}`;
  readonly origin: string;
}

export function existingSpaceOperatorPath(action: ExistingSpaceOperatorAction): string {
  return `/v1/existing-spaces/${action}`;
}

export function existingSpaceOperatorOrigin(value: string): string {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.origin !== value ||
    url.username ||
    url.password ||
    url.hostname.endsWith(".workers.dev")
  )
    throw new TypeError("identity_unavailable");
  return value;
}

export async function existingSpaceOperatorClaims(input: {
  readonly action: ExistingSpaceOperatorAction;
  readonly body: unknown;
  readonly identity: ExistingSpaceOperatorIdentity;
}): Promise<Record<string, unknown>> {
  const identity = input.identity;
  existingSpaceOperatorOrigin(identity.origin);
  if (
    !["integration", "rehearsal", "production"].includes(identity.environment) ||
    !identity.hostId ||
    identity.hostId.length > 255 ||
    !isSha256Digest(identity.workerArtifactDigest) ||
    !isSha256Digest(identity.capabilityDigest) ||
    !isSha256Digest(identity.implementationDigest) ||
    !isSha256Digest(identity.policyDigest) ||
    !uuid(identity.publicWorkerVersionId) ||
    !uuid(identity.authorityWorkerVersionId)
  ) {
    throw new TypeError("identity_unavailable");
  }
  return {
    purpose: EXISTING_SPACE_OPERATOR_PURPOSE,
    action: input.action,
    method: "POST",
    path: existingSpaceOperatorPath(input.action),
    bodyDigest: await canonicalDigest(input.body),
    ...identity,
  };
}

export async function authenticateExistingSpaceOperatorAssertion(input: {
  readonly assertion: string;
  readonly publicJwk: string;
  readonly clock: () => Date;
}): Promise<Readonly<Record<string, unknown>>> {
  return await createOperatorPurposeVerifier({
    publicKeyJwk: parseFormAuthorityOperatorPublicJwk(input.publicJwk),
    clock: input.clock,
    maxLifetimeSeconds: 120,
  }).verify(input.assertion, EXISTING_SPACE_OPERATOR_PURPOSE);
}

export async function verifyExistingSpaceOperatorClaims(input: {
  readonly claims: Readonly<Record<string, unknown>>;
  readonly action: ExistingSpaceOperatorAction;
  readonly body: unknown;
  readonly identity: ExistingSpaceOperatorIdentity;
  readonly clock: () => Date;
}): Promise<void> {
  // Core identity observation may wake a container. Recheck expiry at the
  // dispatch boundary, not merely before that potentially slow read.
  if (
    typeof input.claims.exp !== "number" ||
    input.claims.exp <= Math.floor(input.clock().getTime() / 1000)
  )
    throw new TypeError("invalid_operator_assertion");
  const expected = await existingSpaceOperatorClaims(input);
  const { iat: _iat, exp: _exp, ...actual } = input.claims;
  if ((await canonicalDigest(actual)) !== (await canonicalDigest(expected))) {
    throw new TypeError("invalid_operator_assertion");
  }
}

function uuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}
