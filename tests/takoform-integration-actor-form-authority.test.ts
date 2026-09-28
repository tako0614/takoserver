import { expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { edgeProviderOffering } from "../src/edge-forms.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { CloudflareProviderExecutorRpc } from "../src/providers/cloudflare-provider-executor-port.ts";
import { CloudflareProviderProxy } from "../src/providers/cloudflare-provider-proxy.ts";
import {
  derivePublicFormImplementationIdentity,
  publicFormCapabilityManifest,
} from "../src/public-worker-implementation.ts";
import {
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../src/takoform/admission.ts";
import type { FormAuthorityVerificationEvidence } from "../src/takoform/form-authority-verification.ts";
import { createIntegrationFixtureEvidenceVerifier } from "../src/takoform/form-authority-verification.ts";
import { selectTakoformCandidates } from "../src/takoform/forward-candidates.ts";
import {
  createExactFormPackageSource,
  createFormAuthorityComposition,
  createIntegrationActorFormAuthorityComposition,
  type FormAuthorityEndpointConfiguration,
} from "../src/takoform/host-admission-endpoint.ts";

const digest = (digit: string) => `sha256:${digit.repeat(64)}` as const;
const actor = selectTakoformCandidates("actor-forward").forms.find(
  (form) => form.identity.formRef.kind === "ActorNamespace",
);
if (!actor?.identity.packageDigest || !actor.workerClassRuntime?.runtimeClassRef) {
  throw new Error("forward Actor package is unavailable");
}
const packageIdentity = {
  formRef: actor.identity.formRef,
  packageDigest: actor.identity.packageDigest,
};
// Concrete credential-free proxy; no provider RPC is exercised by these
// authority-construction and read-only planning checks.
const actorProvider = new CloudflareProviderProxy({
  providerInstallationId: "cloudflare.integration",
  managedBaseDomain: "apps.example.test",
  offerings: [edgeProviderOffering(actor, { id: "cloudflare.technical.actor-forward.v1" })],
  workerClassRuntimeContracts: [
    {
      ...packageIdentity,
      runtimeClassRef: actor.workerClassRuntime.runtimeClassRef,
    },
  ],
  binding: {} as CloudflareProviderExecutorRpc,
});
const payload = digest("a");
const capabilities = publicFormCapabilityManifest("actor-forward");
const semantic = await derivePublicFormImplementationIdentity({
  implementationPayloadDigest: payload,
  capabilities,
  candidate: "actor-forward",
  actorProvider,
});
const configuration: FormAuthorityEndpointConfiguration = {
  environment: "integration",
  hostId: "actor-source-qualification",
  workerArtifactDigest: digest("b"),
  publicWorkerVersionId: "11111111-1111-4111-8111-111111111111",
  implementationPayloadDigest: payload,
  implementationDigest: semantic.implementationDigest,
  capabilities,
};
const evidence: FormAuthorityVerificationEvidence = {
  publisher: {
    publisherKey: "actor-source-fixture",
    policyDigest: digest("1"),
    policy: { apiVersion: "policy.forms.takoform.com/v1", mode: "integration-fixture" },
    oidcIssuer: "https://issuer.example.test",
    sourceRepository: "https://github.com/example/forms",
    workflow: ".github/workflows/integration.yml",
    ref: "refs/heads/integration",
    identity: "actor-source-fixture",
    trustedRootDigest: digest("2"),
    sourceCommit: "a".repeat(40),
    workflowCommit: "b".repeat(40),
    buildConfigCommit: "c".repeat(40),
    repositoryIdentifier: "repo:example/forms",
    ownerIdentifier: "owner:example",
    group: "edge.forms.takoform.com",
    namespaceGrantDigest: digest("3"),
  },
  checkpoint: {
    apiVersion: TAKOFORM_REVOCATION_V1,
    sequence: 0,
    digest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
    entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
    previousDigest: null,
  },
  packageBundleDigests: [{ ...packageIdentity, bundleDigest: digest("4") }],
};

function options() {
  const sql = createEphemeralSql();
  const objects = createMemoryObjectStore();
  const publicHostIdentity = {
    async identity() {
      return {
        kind: "takoserver.public-host-identity@v2" as const,
        hostId: configuration.hostId,
        workerVersionId: configuration.publicWorkerVersionId,
        workerArtifactDigest: configuration.workerArtifactDigest,
        implementationPayloadDigest: payload,
        capabilityDigest: semantic.capabilityDigest,
        implementationDigest: semantic.implementationDigest,
      };
    },
  };
  return {
    configuration,
    bindings: { sql, objects, publicHostIdentity },
    verifier: createIntegrationFixtureEvidenceVerifier({ packages: [packageIdentity] }),
    packages: createExactFormPackageSource([{ ...packageIdentity, files: [] }]),
    packageSet: [packageIdentity],
    expectedEvidence: evidence,
    actorProvider,
  };
}

test("ordinary Host authority never infers unpublished Actor from forward capabilities", async () => {
  await expect(createFormAuthorityComposition(options())).rejects.toMatchObject({
    code: "identity_mismatch",
  });
});

test("source-only Actor authority rejects production and released verifier", async () => {
  const input = options();
  await expect(
    createIntegrationActorFormAuthorityComposition({
      ...input,
      configuration: { ...configuration, environment: "production" },
    }),
  ).rejects.toMatchObject({ code: "production_not_ready" });
  await expect(
    createIntegrationActorFormAuthorityComposition({
      ...input,
      verifier: { ...input.verifier, readiness: { available: true, released: true } },
    }),
  ).rejects.toMatchObject({ code: "production_not_ready" });
});

test("Actor authority refuses mismatched build identity and package closure", async () => {
  const input = options();
  await expect(
    createIntegrationActorFormAuthorityComposition({
      ...input,
      configuration: { ...configuration, implementationDigest: digest("c") },
    }),
  ).rejects.toMatchObject({ code: "identity_mismatch" });
  await expect(
    createIntegrationActorFormAuthorityComposition({
      ...input,
      packageSet: [{ ...packageIdentity, packageDigest: digest("d") }],
    }),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

test("source-only Actor authority uses the real coordinator and fences live public identity", async () => {
  const input = options();
  const composition = await createIntegrationActorFormAuthorityComposition(input);
  const request = {
    kind: "takoserver.form-authority-plan-request@v2" as const,
    ...composition.identity,
    activation: {
      kind: "space" as const,
      tenantId: "tenant-actor",
      space: "space-actor",
      desiredActive: false,
    },
    evidence: input.expectedEvidence,
    actor: "integration-test",
    reason: "read-only source qualification",
  };
  const plan = await composition.endpoint.plan(request);
  expect(plan.packages).toEqual([
    expect.objectContaining({
      formRef: packageIdentity.formRef,
      packageDigest: packageIdentity.packageDigest,
      operations: expect.arrayContaining(["create", "read", "delete", "observe"]),
    }),
  ]);
  const readback = await composition.endpoint.readback(request);
  expect(readback.forms[0]?.installed).toBe(false);
  input.bindings.publicHostIdentity.identity = async () => ({
    ...(await options().bindings.publicHostIdentity.identity()),
    implementationDigest: digest("f"),
  });
  await expect(composition.endpoint.plan(request)).rejects.toMatchObject({
    code: "identity_mismatch",
  });
});
