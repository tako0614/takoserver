import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { canonicalDigest, isJsonObject, type JsonObject } from "../../src/json.ts";
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
import { createFormPackageStore } from "../../src/takoform/form-packages.ts";
import { takoformActivationAudience } from "../../src/takoform/host-authority.ts";
import type { InstalledTakoformForm } from "../../src/takoform/types.ts";

export const SELFHOST_CONTAINER_ENDPOINT_CANDIDATE_SHA256 =
  "968d2085828e9c3d6340b9ba0a3343f2a9a77b77958760dd34c9128132717eca";
export const SELFHOST_CONTAINER_ENDPOINT_PACKAGE_DIGEST =
  "sha256:c5ee452369ddafc1ba15d76adcdcc1611ff558d2e385a3f1f6379a4cce86b288" as const;
export const SELFHOST_CONTAINER_ENDPOINT_FORM_REF = {
  apiVersion: "edge.forms.takoform.com",
  kind: "ContainerEndpoint",
  definitionVersion: "0.1.0",
  schemaDigest: "sha256:c32e716d9185026fce7ae105d14035d75fa64ec7322483122126b95db902b336",
} as const;

interface Artifact {
  readonly publicationStatus: string;
  readonly form: { readonly definition: unknown };
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

/** Exact unpublished package bytes, with a synthetic external-Core trust boundary in tests. */
export async function loadVerifiedLocalContainerEndpointCandidate(path: string): Promise<{
  readonly form: InstalledTakoformForm;
  readonly package: {
    readonly packageDigest: typeof SELFHOST_CONTAINER_ENDPOINT_PACKAGE_DIGEST;
    readonly formRef: typeof SELFHOST_CONTAINER_ENDPOINT_FORM_REF;
    readonly manifest: JsonObject;
    readonly files: readonly {
      readonly path: string;
      readonly digest: `sha256:${string}`;
      readonly mediaType?: string;
      readonly bytes: Uint8Array;
    }[];
  };
}> {
  const bytes = await readFile(path);
  if (
    createHash("sha256").update(bytes).digest("hex") !==
    SELFHOST_CONTAINER_ENDPOINT_CANDIDATE_SHA256
  )
    throw new Error("local ContainerEndpoint candidate artifact digest mismatch");
  const artifact = JSON.parse(bytes.toString("utf8")) as Artifact;
  if (
    artifact.publicationStatus !== "UNPUBLISHED" ||
    artifact.package.packageDigest !== SELFHOST_CONTAINER_ENDPOINT_PACKAGE_DIGEST
  )
    throw new Error("local ContainerEndpoint package identity mismatch");
  const form = await installedFormFromDefinition(
    artifact.form.definition,
    SELFHOST_CONTAINER_ENDPOINT_FORM_REF,
    SELFHOST_CONTAINER_ENDPOINT_PACKAGE_DIGEST,
  );
  if (!form) throw new Error("local ContainerEndpoint Form definition is invalid");
  const manifest = JSON.parse(artifact.package.packageIndexJson) as unknown;
  if (
    !isJsonObject(manifest) ||
    (await canonicalDigest(manifest)) !== SELFHOST_CONTAINER_ENDPOINT_PACKAGE_DIGEST
  )
    throw new Error("local ContainerEndpoint package index is invalid");
  const files = artifact.package.files.map((file) => ({
    path: file.path,
    digest: file.digest as `sha256:${string}`,
    ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
    bytes: new TextEncoder().encode(file.content),
  }));
  if (
    files.length === 0 ||
    files.some(
      (file, index) =>
        file.bytes.byteLength !== artifact.package.files[index]?.size ||
        file.digest !== artifact.package.files[index]?.digest,
    )
  )
    throw new Error("local ContainerEndpoint package closure is invalid");
  return {
    form,
    package: {
      packageDigest: SELFHOST_CONTAINER_ENDPOINT_PACKAGE_DIGEST,
      formRef: SELFHOST_CONTAINER_ENDPOINT_FORM_REF,
      manifest,
      files,
    },
  };
}

const fixtureDigest = (character: string): AdmissionDigest =>
  `sha256:${character.repeat(64)}` as AdmissionDigest;

/** Synthetic local admission through the ordinary append-only Host authority, never publisher trust. */
export async function installLocalContainerEndpointCandidateForTest(input: {
  readonly sql: Sql;
  readonly objects: ObjectStore;
  readonly hostId: string;
  readonly candidate: Awaited<ReturnType<typeof loadVerifiedLocalContainerEndpointCandidate>>;
}): Promise<void> {
  const handles = createAdmissionHandleIssuer();
  const writer = createFormAdmissionStore({
    sql: input.sql,
    objects: input.objects,
    packages: createFormPackageStore(input.objects),
    handles,
  });
  const publisher: AdmissionPublisherPin = {
    publisherKey: "synthetic-local-container-endpoint-fixture",
    policyDigest: fixtureDigest("4"),
    policy: { apiVersion: "fixture.synthetic-external-verifier/v1", purpose: "local-test-only" },
    oidcIssuer: "https://synthetic-fixture.invalid",
    sourceRepository: "https://example.invalid/unpublished-container-endpoint-fixture",
    workflow: "fixture-only",
    ref: "refs/heads/local-test-fixture",
    identity: "synthetic-test-issuer",
    trustedRootDigest: fixtureDigest("5"),
    sourceCommit: "dddddddddddddddddddddddddddddddddddddddd",
    workflowCommit: "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
    buildConfigCommit: "ffffffffffffffffffffffffffffffffffffffff",
    repositoryIdentifier: "fixture:unpublished-container-endpoint",
    ownerIdentifier: "fixture:local-test-only",
    group: SELFHOST_CONTAINER_ENDPOINT_FORM_REF.apiVersion,
    namespaceGrantDigest: fixtureDigest("6"),
  };
  const allow = await writer.execute({
    kind: "AllowPublisher",
    publisher,
    actor: "test-fixture",
    reason: "synthetic verifier input for exact unpublished ContainerEndpoint candidate",
  });
  const checkpoint = await writer.execute({
    kind: "AppendCheckpoint",
    publisherKey: publisher.publisherKey as string,
    checkpointApiVersion: TAKOFORM_REVOCATION_V1,
    policyDigest: publisher.policyDigest,
    policyEventDigest: allow.eventDigest,
    sequence: 0,
    checkpointDigest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
    entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
    previousCheckpointDigest: null,
    actor: "test-fixture",
    reason: "synthetic checkpoint for local ContainerEndpoint candidate only",
  });
  const pkg = input.candidate.package;
  const report: AdmissionReport = {
    status: "admitted",
    operation: "install",
    package: {
      packageDigest: pkg.packageDigest,
      formRef: pkg.formRef,
      fileCount: pkg.files.length,
      payloadBytes: pkg.files.reduce((size, file) => size + file.bytes.byteLength, 0),
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
    namespace: { group: publisher.group, namespaceGrantDigest: publisher.namespaceGrantDigest },
    signature: {
      subjectDigest: pkg.packageDigest,
      bundleDigest: allow.eventDigest,
      trustedRootDigest: publisher.trustedRootDigest,
    },
    revocation: {
      checkpointApiVersion: TAKOFORM_REVOCATION_V1,
      sequence: 0,
      checkpointDigest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
      entriesDigest: TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
      revoked: false,
    },
    checks: [{ code: "synthetic-test-external-verifier", passed: true }],
  };
  const claims: AdmissionHandleClaims = {
    operation: "install",
    packageDigest: pkg.packageDigest,
    formRef: pkg.formRef,
    publisherKey: publisher.publisherKey as string,
    publisher,
    policyEventDigest: allow.eventDigest,
    checkpointApiVersion: TAKOFORM_REVOCATION_V1,
    checkpointSequence: 0,
    checkpointDigest: TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
    checkpointEventDigest: checkpoint.eventDigest,
    report,
  };
  await writer.execute({
    kind: "InstallPackage",
    package: pkg,
    handle: handles.issue(claims),
    implementationDigest: fixtureDigest("a"),
    actor: "test-fixture",
    reason: "install exact unpublished ContainerEndpoint candidate for this local Host test",
  });
  await writer.execute({
    kind: "SetSupport",
    formRef: pkg.formRef,
    packageDigest: pkg.packageDigest,
    implementationDigest: fixtureDigest("a"),
    supported: true,
    profile: { kind: "takoserver.form-support@v2", implementationDigest: fixtureDigest("a") },
    operations: ["create", "read", "delete", "observe"],
    actor: "test-fixture",
    reason: "local fixture only, not published support",
  });
  await writer.execute({
    kind: "SetActivation",
    formRef: pkg.formRef,
    packageDigest: pkg.packageDigest,
    implementationDigest: fixtureDigest("a"),
    active: true,
    audience: takoformActivationAudience("host", { hostId: input.hostId }),
    actor: "test-fixture",
    reason: "explicit local selection of unpublished ContainerEndpoint",
  });
}
