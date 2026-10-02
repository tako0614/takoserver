import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalDigest, isJsonObject } from "../../src/json.ts";
import type { ObjectStore, Sql } from "../../src/ports.ts";
import {
  type AdmissionDigest,
  type AdmissionHandleClaims,
  type AdmissionPublisherPin,
  type AdmissionReport,
  createAdmissionHandleIssuer,
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
} from "../../src/takoform/admission.ts";
import { createFormAdmissionStore } from "../../src/takoform/admission-store.ts";
import { installedFormFromDefinition } from "../../src/takoform/form-definition.ts";
import { createFormPackageStore, type FormPackageInput } from "../../src/takoform/form-packages.ts";
import { takoformActivationAudience } from "../../src/takoform/host-authority.ts";
import type { InstalledTakoformForm } from "../../src/takoform/types.ts";

export const SELFHOST_CONTAINER_CANDIDATE_SHA256 =
  "7ab6dce1bbbfecc69f5732abd25100db83168c640e8d1054f5a708ad4ef6a0b2";
export const SELFHOST_CONTAINER_PACKAGE_DIGEST =
  "sha256:0fb3c53940180e3f661268e079f9dbc6667c4d1fbbc74b4561ebb5ffa2740d33" as const;
export const SELFHOST_CONTAINER_FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ContainerService",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:114d452395562573f46d9a879efa889ab42a3e43348d7db244e22df7d6e330e2",
} as const;

interface CandidateArtifact {
  readonly publicationStatus: string;
  readonly contractClosure: string;
  readonly form: {
    readonly definition: unknown;
  };
  readonly package: {
    readonly packageDigest: string;
    readonly packageIndexJson: string;
    readonly files: readonly {
      readonly path: string;
      readonly digest: string;
      readonly size: number;
      readonly mediaType?: string;
      readonly content: string;
    }[];
  };
}

export interface VerifiedLocalContainerCandidate {
  readonly form: InstalledTakoformForm;
  readonly package: FormPackageInput;
}

/**
 * Verify the exact content-addressed, unpublished local candidate. This is
 * structural/package verification for a test fixture, not publisher
 * authentication or a claim that the Form is published or supported.
 */
export async function loadVerifiedLocalContainerCandidate(
  artifactPath: string,
): Promise<VerifiedLocalContainerCandidate> {
  const bytes = await readFile(artifactPath);
  const artifactDigest = createHash("sha256").update(bytes).digest("hex");
  if (artifactDigest !== SELFHOST_CONTAINER_CANDIDATE_SHA256) {
    throw new Error("local ContainerService candidate artifact digest mismatch");
  }
  const artifact = JSON.parse(bytes.toString("utf8")) as CandidateArtifact;
  if (
    artifact.publicationStatus !== "UNPUBLISHED" ||
    artifact.contractClosure !==
      "form-only; container.http Interface and module-worker.container-http Binding are withheld" ||
    artifact.package.packageDigest !== SELFHOST_CONTAINER_PACKAGE_DIGEST
  ) {
    throw new Error(
      "local ContainerService candidate provenance does not match the reviewed artifact",
    );
  }
  const form = await installedFormFromDefinition(
    artifact.form.definition,
    SELFHOST_CONTAINER_FORM_REF,
    SELFHOST_CONTAINER_PACKAGE_DIGEST,
  );
  if (!form)
    throw new Error("local ContainerService Form definition failed canonical verification");

  const manifest = JSON.parse(artifact.package.packageIndexJson) as unknown;
  if (!isJsonObject(manifest)) throw new Error("local ContainerService package index is invalid");
  const files = artifact.package.files.map((file) => ({
    path: file.path,
    digest: file.digest as `sha256:${string}`,
    ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
    bytes: new TextEncoder().encode(file.content),
  }));
  if (
    (await canonicalDigest(manifest)) !== SELFHOST_CONTAINER_PACKAGE_DIGEST ||
    files.length === 0 ||
    files.some(
      (file, index) =>
        file.bytes.byteLength !== artifact.package.files[index]?.size ||
        file.digest !== artifact.package.files[index]?.digest,
    )
  ) {
    throw new Error("local ContainerService package closure failed identity checks");
  }
  return {
    form,
    package: {
      packageDigest: SELFHOST_CONTAINER_PACKAGE_DIGEST,
      formRef: SELFHOST_CONTAINER_FORM_REF,
      manifest,
      files,
    },
  };
}

const digest = (hex: string): AdmissionDigest => `sha256:${hex.repeat(64)}` as AdmissionDigest;
const IMPLEMENTATION_DIGEST = digest("a");

/**
 * Seed the ordinary append-only Host admission authority for the local test
 * candidate. The publisher/checkpoint claims below are synthetic fixture
 * inputs, analogous to a mocked external Core verifier; they are not evidence
 * of released-Core or publisher authenticity.
 */
export async function installLocalContainerCandidateForTest(input: {
  readonly sql: Sql;
  readonly objects: ObjectStore;
  readonly hostId: string;
  readonly candidate: VerifiedLocalContainerCandidate;
}): Promise<void> {
  const handles = createAdmissionHandleIssuer();
  const writer = createFormAdmissionStore({
    sql: input.sql,
    objects: input.objects,
    packages: createFormPackageStore(input.objects),
    handles,
  });
  const publisher: AdmissionPublisherPin = {
    publisherKey: "synthetic-local-container-fixture",
    policyDigest: digest("1"),
    policy: { apiVersion: "fixture.synthetic-external-verifier/v1", purpose: "local-test-only" },
    oidcIssuer: "https://synthetic-fixture.invalid",
    sourceRepository: "https://example.invalid/unpublished-container-fixture",
    workflow: "fixture-only",
    ref: "refs/heads/local-test-fixture",
    identity: "synthetic-test-issuer",
    trustedRootDigest: digest("2"),
    sourceCommit: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    workflowCommit: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    buildConfigCommit: "cccccccccccccccccccccccccccccccccccccccc",
    repositoryIdentifier: "fixture:unpublished-container-candidate",
    ownerIdentifier: "fixture:local-test-only",
    group: SELFHOST_CONTAINER_FORM_REF.apiVersion,
    namespaceGrantDigest: digest("3"),
  };
  const allow = await writer.execute({
    kind: "AllowPublisher",
    publisher,
    actor: "test-fixture",
    reason:
      "synthetic external-verifier input for the exact unpublished local ContainerService candidate",
  });
  const checkpointDigest = TAKOFORM_REVOCATION_V1_GENESIS_DIGEST;
  const entriesDigest = TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST;
  const checkpoint = await writer.execute({
    kind: "AppendCheckpoint",
    publisherKey: publisher.publisherKey as string,
    checkpointApiVersion: TAKOFORM_REVOCATION_V1,
    policyDigest: publisher.policyDigest,
    policyEventDigest: allow.eventDigest,
    sequence: 0,
    checkpointDigest,
    entriesDigest,
    previousCheckpointDigest: null,
    actor: "test-fixture",
    reason: "synthetic checkpoint for the local test candidate only",
  });
  const packageInput = input.candidate.package;
  const report: AdmissionReport = {
    status: "admitted",
    operation: "install",
    package: {
      packageDigest: packageInput.packageDigest as AdmissionDigest,
      formRef: packageInput.formRef,
      fileCount: packageInput.files.length,
      payloadBytes: packageInput.files.reduce((total, file) => {
        if (!(file.bytes instanceof Uint8Array))
          throw new Error("fixture package bytes are invalid");
        return total + file.bytes.byteLength;
      }, 0),
    },
    publisher: {
      policyDigest: publisher.policyDigest,
      oidcIssuer: publisher.oidcIssuer,
      sourceRepository: publisher.sourceRepository,
      workflow: publisher.workflow,
      ref: publisher.ref,
      identity: publisher.identity,
    },
    source: {
      sourceCommit: publisher.sourceCommit,
      workflowCommit: publisher.workflowCommit,
      buildConfigCommit: publisher.buildConfigCommit as string,
      repositoryIdentifier: publisher.repositoryIdentifier,
      ownerIdentifier: publisher.ownerIdentifier,
    },
    namespace: {
      group: publisher.group,
      namespaceGrantDigest: publisher.namespaceGrantDigest,
    },
    signature: {
      subjectDigest: packageInput.packageDigest as AdmissionDigest,
      bundleDigest: allow.eventDigest,
      trustedRootDigest: publisher.trustedRootDigest,
    },
    revocation: {
      checkpointApiVersion: TAKOFORM_REVOCATION_V1,
      sequence: 0,
      checkpointDigest,
      entriesDigest,
      revoked: false,
    },
    checks: [{ code: "synthetic-test-external-verifier", passed: true }],
  };
  const claims: AdmissionHandleClaims = {
    operation: "install",
    packageDigest: packageInput.packageDigest as AdmissionDigest,
    formRef: packageInput.formRef,
    publisherKey: publisher.publisherKey as string,
    publisher,
    policyEventDigest: allow.eventDigest,
    checkpointApiVersion: TAKOFORM_REVOCATION_V1,
    checkpointSequence: 0,
    checkpointDigest,
    checkpointEventDigest: checkpoint.eventDigest,
    report,
  };
  await writer.execute({
    kind: "InstallPackage",
    package: packageInput,
    handle: handles.issue(claims),
    implementationDigest: IMPLEMENTATION_DIGEST,
    actor: "test-fixture",
    reason:
      "install the exact unpublished local candidate into the ordinary durable Host authority for this test",
  });
  await writer.execute({
    kind: "SetSupport",
    formRef: packageInput.formRef,
    packageDigest: packageInput.packageDigest as AdmissionDigest,
    implementationDigest: IMPLEMENTATION_DIGEST,
    supported: true,
    profile: {
      kind: "takoserver.form-support@v2",
      implementationDigest: IMPLEMENTATION_DIGEST,
    },
    operations: ["create", "read", "update", "delete", "observe"],
    actor: "test-fixture",
    reason: "local test fixture only; not published support",
  });
  await writer.execute({
    kind: "SetActivation",
    formRef: packageInput.formRef,
    packageDigest: packageInput.packageDigest as AdmissionDigest,
    implementationDigest: IMPLEMENTATION_DIGEST,
    active: true,
    audience: takoformActivationAudience("host", { hostId: input.hostId }),
    actor: "test-fixture",
    reason: "explicit local test selection of the unpublished candidate",
  });
}
