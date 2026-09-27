import { normalizeGeneratedEd25519PrivateJwk } from "../../src/ed25519-private-jwk.ts";
import type { ExistingSpaceOperatorRuntime } from "../../src/existing-space-operator.ts";
import {
  type ExistingSpaceOperatorIdentity,
  existingSpaceOperatorClaims,
} from "../../src/existing-space-operator-proof.ts";
import { FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND } from "../../src/form-authority-identity-probe.ts";
import { canonicalJson } from "../../src/json.ts";
import { signOperatorAssertion } from "../../src/operator-key.ts";
import type { FormAuthorityPlanRequest } from "../../src/takoform/host-admission-coordinator.ts";
import { loadPublisherSetClosure } from "../../src/takoform/publisher-set-closure.ts";
import { spaceAdmissionPolicyDigest } from "../../src/takoform/space-admission-policy.ts";

export const OPERATOR_NOW = new Date("2026-09-27T09:00:00Z");
export const OPERATOR_COMMIT = "a".repeat(40);
export const OPERATOR_DIGEST = `sha256:${"b".repeat(64)}` as const;
export const OPERATOR_VERSION = "11111111-1111-4111-8111-111111111111";
export async function existingSpaceOperatorFixture() {
  const pair = (await crypto.subtle.generateKey("Ed25519", true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const privateJwk = normalizeGeneratedEd25519PrivateJwk(
    await crypto.subtle.exportKey("jwk", pair.privateKey),
  );
  const publicJwk = { kty: "OKP", crv: "Ed25519", x: privateJwk.x as string } as const;
  const closure = await loadPublisherSetClosure();
  const first = closure.packageSet[0];
  if (!first) throw new Error("publisher closure missing");
  const policy = {
    kind: "takoserver.space-form-admission-policy@v1",
    organizationId: "org_operator",
    forms: [{ formRef: first.formRef, packageDigest: first.packageDigest }],
  } as const;
  const policyDigest = await spaceAdmissionPolicyDigest(policy);
  const identity: ExistingSpaceOperatorIdentity = {
    environment: "integration",
    hostId: "https://api.example.test",
    origin: "https://operator.example.test",
    policyDigest,
    authorityWorkerVersionId: OPERATOR_VERSION,
    publicWorkerVersionId: OPERATOR_VERSION,
    workerArtifactDigest: OPERATOR_DIGEST,
    capabilityDigest: OPERATOR_DIGEST,
    implementationDigest: OPERATOR_DIGEST,
  };
  const {
    origin: _origin,
    policyDigest: _policy,
    authorityWorkerVersionId: _version,
    ...formIdentity
  } = identity;
  const request = { policyDigest, spaces: ["space-existing", "space-other"] };
  const calls: string[] = [];
  const readRequest: FormAuthorityPlanRequest = {
    ...formIdentity,
    kind: "takoserver.form-authority-plan-request@v2",
    activation: {
      kind: "space",
      tenantId: policy.organizationId,
      space: request.spaces[0] as string,
      desiredActive: true,
    },
    evidence: closure.evidence,
    actor: "operator",
    reason: "test readback",
  };
  const env: ExistingSpaceOperatorRuntime = {
    TAKOSERVER_ENVIRONMENT: "integration",
    TAKOSERVER_FORM_AUTHORITY_HOST_ID: identity.hostId,
    TAKOSERVER_EXISTING_SPACE_OPERATOR_ORIGIN: identity.origin,
    TAKOSERVER_EXISTING_SPACE_OPERATOR_PUBLIC_JWK: canonicalJson(publicJwk),
    TAKOSERVER_MANAGED_SPACE_ADMISSION_POLICY: canonicalJson(policy),
    PUBLIC_HOST_IDENTITY: {
      identity: async () => ({
        kind: "takoserver.public-host-identity@v2",
        hostId: identity.hostId,
        workerVersionId: identity.publicWorkerVersionId,
        workerArtifactDigest: identity.workerArtifactDigest,
        capabilityDigest: identity.capabilityDigest,
        implementationDigest: identity.implementationDigest,
        implementationPayloadDigest: OPERATOR_DIGEST,
      }),
    },
    FORM_AUTHORITY: {
      verifierIdentity: async () => ({
        kind: FORM_AUTHORITY_CORE_VERIFIER_IDENTITY_KIND,
        authorityWorkerVersionId: OPERATOR_VERSION,
        verifier: {
          protocol: "takoserver.takoform-core-verifier@v1",
          coreVersion: "v1.1.0",
          coreCommit: "e0e48b864de2a127a255cb0574d37bbb0f1cac29",
          artifactDigest: OPERATOR_DIGEST,
        },
      }),
      reconcileExistingSpaces: async (body, expected) => {
        if (
          canonicalJson(expected) !==
          canonicalJson({ identity: formIdentity, authorityWorkerVersionId: OPERATOR_VERSION })
        )
          throw new Error("identity fence missing");
        calls.push("reconcile");
        return {
          policyDigest,
          identity: formIdentity,
          spaces: body.spaces.map((space) => ({ space, forms: [] })),
        };
      },
      readback: async (body) => {
        calls.push("readback");
        return {
          kind: "takoserver.form-authority-readback@v2",
          identity: formIdentity,
          activation: (body as FormAuthorityPlanRequest).activation,
          forms: closure.packageSet.map((entry) => ({
            ...entry,
            operations: [],
            installed: false,
            supported: false,
            activationHead: {
              present: false,
              active: false,
              implementationDigest: null,
              eventDigest: null,
            },
          })),
          currentHeads: [],
          currentHeadDigest: OPERATOR_DIGEST,
        };
      },
    },
  };
  const sign = async (
    action: "reconcile" | "readback",
    body: unknown,
    overrides: Record<string, unknown> = {},
  ) =>
    signOperatorAssertion({
      privateJwk: JSON.stringify(privateJwk),
      nowSeconds: OPERATOR_NOW.getTime() / 1000,
      lifetimeSeconds: 60,
      claims: { ...(await existingSpaceOperatorClaims({ action, body, identity })), ...overrides },
    });
  return {
    privateJwk,
    publicJwk,
    policy,
    policyDigest,
    identity,
    formIdentity,
    request,
    readRequest,
    env,
    calls,
    sign,
  };
}
