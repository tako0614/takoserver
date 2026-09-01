import { describe, expect, test } from "bun:test";
import { bytesDigest, canonicalDigest } from "../src/json.ts";
import {
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../src/takoform/admission.ts";
import {
  createReleasedCoreFormAuthorityEvidenceVerifier,
  type FormAuthorityVerificationEvidence,
  readReleasedCoreVerifierIdentity,
  TAKOFORM_CORE_COMMIT,
  TAKOFORM_CORE_VERIFIER_PROTOCOL,
  TAKOFORM_CORE_VERSION,
  type TakoformCoreVerifierContainerNamespace,
} from "../src/takoform/form-authority-verification.ts";
import type { FormPackageInput } from "../src/takoform/form-packages.ts";

const sourceCommit = "0123456789abcdef0123456789abcdef01234567";
const artifactDigest = digest("a");
const POLICY = { policy: true } as const;
const RAW_POLICY = '{"policy":true}';
const POLICY_DIGEST = await canonicalDigest(POLICY);
const RAW_POLICY_DIGEST = await bytesDigest(new TextEncoder().encode(RAW_POLICY));

describe("released Takoform Core verifier adapter", () => {
  test("sends one raw set closure and accepts only exact artifact, publisher, checkpoint, and package evidence", async () => {
    const packages = [packageInput("ModuleWorker", "9"), packageInput("WorkerBundle", "7")];
    const evidence = trustEvidence(packages);
    const calls: Request[] = [];
    const verifier = createReleasedCoreFormAuthorityEvidenceVerifier({
      containers: namespace(async (input, init) => {
        calls.push(new Request(input, init));
        return Response.json(coreResponse(packages, evidence));
      }),
      containerName: "production:https://takoserver.example",
      artifactDigest,
    });

    const previousCheckpoint = {
      checkpointApiVersion: "trust.forms.takoform.com/v1",
      sequence: 0,
      digest: digest("b"),
      entriesDigest: digest("c"),
    } as const;
    const verified = await verifier.verifySet({
      environment: "production",
      hostId: "https://takoserver.example",
      packages,
      evidence,
      previousCheckpoint,
    });

    expect(verified).toEqual({ verificationMode: "released-core", evidence });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("http://takoform-core-verifier/v1/verify-set");
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.headers.get("content-type")).toBe("application/json");
    const body = (await calls[0]?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
      expectedSourceCommit: sourceCommit,
      previousCheckpoint,
      packages: packages.map((pkg) => ({ packageDigest: pkg.packageDigest, formRef: pkg.formRef })),
    });
    expect(decodeBase64(String(body.publisherPolicy))).toBe('{"policy":true}');
    expect(decodeBase64(String(body.trustedRoot))).toBe('{"root":true}');
    expect(decodeBase64(String(body.checkpoint))).toBe('{"checkpoint":true}');
    expect(decodeBase64(String(body.checkpointBundle))).toBe('{"bundle":"checkpoint"}');
    const sentPackages = body.packages as Array<Record<string, unknown>>;
    expect(sentPackages.map((entry) => decodeBase64(String(entry.bundle)))).toEqual([
      '{"bundle":"9"}',
      '{"bundle":"7"}',
    ]);
    expect(sentPackages.map((entry) => JSON.parse(decodeBase64(String(entry.index))))).toEqual(
      packages.map((pkg) => pkg.manifest),
    );
  });

  test("fails closed for missing, duplicate, extra, or ambiguous package bundle evidence", async () => {
    const packages = [packageInput("ModuleWorker", "9"), packageInput("WorkerBundle", "7")];
    const base = trustEvidence(packages);
    const verifier = createReleasedCoreFormAuthorityEvidenceVerifier({
      containers: namespace(async () => Response.json(coreResponse(packages, base))),
      containerName: "production:https://takoserver.example",
      artifactDigest,
    });
    const variants: FormAuthorityVerificationEvidence["packageBundleDigests"][] = [
      base.packageBundleDigests.slice(0, 1),
      [base.packageBundleDigests[0]!, base.packageBundleDigests[0]!],
      [...base.packageBundleDigests, { packageDigest: digest("f"), bundleDigest: digest("e") }],
      base.packageBundleDigests.map((entry) => ({ ...entry, formRef: packages[0]!.formRef })),
    ];

    for (const packageBundleDigests of variants) {
      await expect(
        verifier.verifySet({
          environment: "production",
          hostId: "https://takoserver.example",
          packages,
          evidence: { ...base, packageBundleDigests },
        }),
      ).rejects.toMatchObject({ code: "verification_evidence_refused" });
    }
  });

  test("rejects stale artifacts and any mismatched or non-exact Core response", async () => {
    const packages = [packageInput("ModuleWorker", "9")];
    const evidence = trustEvidence(packages);
    const exact = coreResponse(packages, evidence);
    const variants = [
      { ...exact, identity: { ...exact.identity, artifactDigest: digest("b") } },
      { ...exact, publisher: { ...exact.publisher, sourceCommit: "f".repeat(40) } },
      { ...exact, checkpoint: { ...exact.checkpoint, bundleDigest: digest("b") } },
      { ...exact, packages: [{ ...exact.packages[0]!, bundleDigest: digest("b") }] },
      { ...exact, packages: exact.packages.slice(0, 0) },
      { ...exact, unexpected: true },
    ];

    for (const response of variants) {
      const verifier = createReleasedCoreFormAuthorityEvidenceVerifier({
        containers: namespace(async () => Response.json(response)),
        containerName: "production:https://takoserver.example",
        artifactDigest,
      });
      await expect(
        verifier.verifySet({
          environment: "production",
          hostId: "https://takoserver.example",
          packages,
          evidence,
        }),
      ).rejects.toBeInstanceOf(Error);
    }
  });

  test("reads only the exact released Container identity", async () => {
    const exact = releasedIdentity();
    const readback = await readReleasedCoreVerifierIdentity({
      containers: namespace(async () => Response.json(exact)),
      containerName: "production:https://takoserver.example",
      artifactDigest,
    });
    expect(readback).toEqual(exact);

    await expect(
      readReleasedCoreVerifierIdentity({
        containers: namespace(async () => Response.json({ ...exact, extra: true })),
        containerName: "production:https://takoserver.example",
        artifactDigest,
      }),
    ).rejects.toMatchObject({ code: "artifact_mismatch" });
  });
});

function namespace(
  fetcher: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): TakoformCoreVerifierContainerNamespace {
  const id = { toString: () => "test-container-id", equals: () => true };
  return { idFromName: () => id, get: () => ({ fetch: fetcher }) };
}

function packageInput(kind: string, marker: string): FormPackageInput {
  const formRef = {
    apiVersion: "edge.forms.takoform.com",
    kind,
    definitionVersion: "1.0.0",
    schemaDigest: digest("8"),
  } as const;
  const manifest = {
    apiVersion: "packages.forms.takoform.com/v1alpha5",
    kind: "FormPackage",
    formRef,
    definitionPath: "definition.json",
    files: [{ path: "definition.json", digest: digest("5"), size: 2 }],
  } as const;
  return {
    packageDigest: digest(marker),
    formRef,
    manifest,
    files: [{ path: "definition.json", bytes: new TextEncoder().encode("{}") }],
  };
}

function trustEvidence(packages: readonly FormPackageInput[]): FormAuthorityVerificationEvidence {
  return {
    publisher: {
      publisherKey: "takoform-forms-main",
      policyDigest: POLICY_DIGEST,
      policy: { ...POLICY },
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
      group: "edge.forms.takoform.com",
      namespaceGrantDigest: digest("3"),
    },
    checkpoint: {
      apiVersion: "trust.forms.takoform.com/v1",
      sequence: 0,
      digest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
      entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
      previousDigest: null,
      revokedPackageDigests: [],
    },
    core: {
      protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
      expectedSourceCommit: sourceCommit,
      publisherPolicy: RAW_POLICY,
      trustedRoot: '{"root":true}',
      checkpoint: '{"checkpoint":true}',
      checkpointBundle: '{"bundle":"checkpoint"}',
      packageBundles: packages.map((pkg) => ({
        formRef: pkg.formRef,
        packageDigest: pkg.packageDigest,
        bundle: `{"bundle":"${pkg.packageDigest.at(-1)}"}`,
      })),
    },
    checkpointBundleDigest: digest("6"),
    packageBundleDigests: packages.map((pkg, index) => ({
      formRef: pkg.formRef,
      packageDigest: pkg.packageDigest,
      bundleDigest: digest(index === 0 ? "d" : "e"),
    })),
  };
}

function coreResponse(
  packages: readonly FormPackageInput[],
  evidence: FormAuthorityVerificationEvidence,
) {
  return {
    identity: releasedIdentity(),
    publisher: {
      policyDigest: RAW_POLICY_DIGEST,
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
      previousDigest: evidence.checkpoint.previousDigest,
      bundleDigest: evidence.checkpointBundleDigest,
      revokedPackageDigests: [],
    },
    packages: packages.map((pkg, index) => ({
      packageDigest: pkg.packageDigest,
      formRef: pkg.formRef,
      bundleDigest: evidence.packageBundleDigests[index]!.bundleDigest,
    })),
  };
}

function releasedIdentity() {
  return {
    protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
    coreVersion: TAKOFORM_CORE_VERSION,
    coreCommit: TAKOFORM_CORE_COMMIT,
    artifactDigest,
  } as const;
}

function decodeBase64(value: string): string {
  return new TextDecoder().decode(
    Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),
  );
}

function digest(character: string): `sha256:${string}` {
  return `sha256:${character.repeat(64)}`;
}
