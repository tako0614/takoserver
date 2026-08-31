import { describe, expect, test } from "bun:test";
import {
  createReleasedCoreFormAuthorityEvidenceVerifier,
  type FormAuthorityVerificationEvidence,
  TAKOFORM_CORE_COMMIT,
  TAKOFORM_CORE_VERIFIER_PROTOCOL,
  TAKOFORM_CORE_VERSION,
  type TakoformCoreVerifierContainerNamespace,
} from "../src/takoform/form-authority-verification.ts";
import type { FormPackageInput } from "../src/takoform/form-packages.ts";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";

describe("released Takoform Core verifier adapter", () => {
  test("sends one raw set closure and accepts only exact artifact/Core evidence", async () => {
    const pkg = packageInput();
    const evidence = trustEvidence(pkg.packageDigest);
    const calls: unknown[] = [];
    const containers = namespace(async (_input, init) => {
      calls.push(JSON.parse(String(init?.body)));
      return Response.json(coreResponse(pkg, evidence));
    });
    const verifier = createReleasedCoreFormAuthorityEvidenceVerifier({
      containers,
      containerName: "production:takoserver.example",
      artifactDigest: digest("a"),
    });

    const verified = await verifier.verifySet({
      environment: "production",
      hostId: "takoserver.example",
      packages: [pkg],
      evidence,
      previousCheckpoint: null,
    });

    expect(verified.verificationMode).toBe("released-core");
    expect(verified.evidence).toEqual(evidence);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
      expectedSourceCommit: sourceCommit,
      previousCheckpoint: null,
      packages: [{ packageDigest: pkg.packageDigest, formRef: pkg.formRef }],
    });
  });

  test("fails closed when a stale container reports a different artifact", async () => {
    const pkg = packageInput();
    const evidence = trustEvidence(pkg.packageDigest);
    const response = coreResponse(pkg, evidence);
    response.identity.artifactDigest = digest("b");
    const verifier = createReleasedCoreFormAuthorityEvidenceVerifier({
      containers: namespace(async () => Response.json(response)),
      containerName: "production:takoserver.example",
      artifactDigest: digest("a"),
    });

    await expect(
      verifier.verifySet({
        environment: "production",
        hostId: "takoserver.example",
        packages: [pkg],
        evidence,
        previousCheckpoint: null,
      }),
    ).rejects.toMatchObject({ code: "artifact_mismatch" });
  });
});

function namespace(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): TakoformCoreVerifierContainerNamespace {
  const id = {
    toString: () => "test-container-id",
    equals: () => true,
  };
  return {
    idFromName: () => id,
    get: () => ({ fetch: fetcher }),
  };
}

function packageInput(): FormPackageInput {
  const formRef = {
    apiVersion: "edge.forms.takoform.com/v1alpha3",
    kind: "ModuleWorker",
    definitionVersion: "1.0.0",
    schemaDigest: digest("8"),
  } as const;
  const manifest = {
    apiVersion: "packages.forms.takoform.com/v1alpha1",
    kind: "FormPackage",
    formRef,
    files: [{ path: "definition.json", digest: digest("5"), size: 2 }],
  };
  return {
    packageDigest: digest("9"),
    formRef,
    manifest,
    files: [{ path: "definition.json", bytes: new TextEncoder().encode("{}") }],
  };
}

function trustEvidence(packageDigest: `sha256:${string}`): FormAuthorityVerificationEvidence {
  return {
    publisher: {
      publisherKey: "takoform-forms-main",
      policyDigest: digest("1"),
      policy: { policy: true },
      oidcIssuer: "https://token.actions.githubusercontent.com",
      sourceRepository: "https://github.com/tako0614/takoform-forms",
      workflow: "https://github.com/tako0614/takoform-forms/.github/workflows/publish.yml",
      ref: "refs/heads/main",
      identity:
        "https://github.com/tako0614/takoform-forms/.github/workflows/publish.yml@refs/heads/main",
      trustedRootDigest: digest("2"),
      sourceCommit,
      workflowCommit: sourceCommit,
      buildConfigCommit: sourceCommit,
      repositoryIdentifier: "repo:fixture",
      ownerIdentifier: "owner:fixture",
      group: "edge.forms.takoform.com/v1alpha3",
      namespaceGrantDigest: digest("3"),
    },
    checkpoint: {
      apiVersion: "trust.forms.takoform.com/v1",
      sequence: 0,
      digest: digest("4"),
      entriesDigest: digest("5"),
      previousDigest: null,
      revokedPackageDigests: [],
    },
    core: {
      protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
      expectedSourceCommit: sourceCommit,
      publisherPolicy: '{"policy":true}',
      trustedRoot: '{"root":true}',
      checkpoint: '{"checkpoint":true}',
      checkpointBundle: '{"bundle":"checkpoint"}',
      packageBundles: [{ packageDigest, bundle: '{"bundle":"package"}' }],
    },
    checkpointBundleDigest: digest("7"),
    packageBundleDigests: [{ packageDigest, bundleDigest: digest("6") }],
    bundleDigest: digest("6"),
  };
}

function coreResponse(pkg: FormPackageInput, evidence: FormAuthorityVerificationEvidence) {
  return {
    identity: {
      protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
      coreVersion: TAKOFORM_CORE_VERSION,
      coreCommit: TAKOFORM_CORE_COMMIT,
      artifactDigest: digest("a"),
    },
    publisher: {
      policyDigest: evidence.publisher.policyDigest,
      trustedRootDigest: evidence.publisher.trustedRootDigest,
      oidcIssuer: evidence.publisher.oidcIssuer,
      sourceRepository: evidence.publisher.sourceRepository,
      workflow: evidence.publisher.workflow,
      ref: evidence.publisher.ref,
      identity: evidence.publisher.identity,
      sourceCommit,
      workflowCommit: sourceCommit,
      buildConfigCommit: sourceCommit,
    },
    checkpoint: {
      checkpointApiVersion: evidence.checkpoint.apiVersion,
      sequence: evidence.checkpoint.sequence,
      digest: evidence.checkpoint.digest,
      entriesDigest: evidence.checkpoint.entriesDigest,
      bundleDigest: evidence.checkpointBundleDigest,
      revokedPackageDigests: [],
    },
    packages: [
      {
        packageDigest: pkg.packageDigest,
        formRef: pkg.formRef,
        bundleDigest: evidence.packageBundleDigests?.[0]?.bundleDigest,
      },
    ],
  };
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
