import { canonicalDigest, canonicalJson, isJsonObject, isSha256Digest } from "../json.ts";
import type { AdmissionDigest, AdmissionPublisherPin } from "./admission.ts";
import {
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
  type TakoformRevocationCheckpointApiVersion,
} from "./admission.ts";
import type { FormPackageInput } from "./form-packages.ts";

export type FormAuthorityEnvironment = "integration" | "rehearsal" | "production";
export type FormAuthorityVerificationMode = "released-core" | "integration-fixture";

/** Serialized signature, provenance, namespace, and revocation evidence. */
export interface FormAuthorityVerificationEvidence {
  readonly publisher: AdmissionPublisherPin & { readonly publisherKey: string };
  readonly checkpoint: {
    readonly apiVersion: TakoformRevocationCheckpointApiVersion;
    readonly sequence: number;
    readonly digest: AdmissionDigest;
    readonly entriesDigest: AdmissionDigest;
    readonly previousDigest: AdmissionDigest | null;
    readonly revokedPackageDigests?: readonly AdmissionDigest[];
  };
  /** Exact released-Core inputs; Host namespace grants remain outside this closure. */
  readonly core?: {
    readonly protocol: "takoserver.takoform-core-verifier@v1";
    readonly expectedSourceCommit: string;
    readonly publisherPolicy: string;
    readonly trustedRoot: string;
    readonly checkpoint: string;
    readonly checkpointBundle: string;
    readonly packageBundles: readonly {
      readonly packageDigest: AdmissionDigest;
      readonly bundle: string;
    }[];
  };
  readonly checkpointBundleDigest?: AdmissionDigest;
  readonly packageBundleDigests?: readonly {
    readonly packageDigest: AdmissionDigest;
    readonly bundleDigest: AdmissionDigest;
  }[];
  /** Integration-fixture compatibility; released verification is per-package. */
  readonly bundleDigest: AdmissionDigest;
}

/**
 * Released Core or an integration fixture may verify evidence, but neither may
 * decide Takoserver Host policy or issue the Host-private admission handle.
 */
export interface VerifiedFormAuthorityEvidence {
  readonly verificationMode: FormAuthorityVerificationMode;
  readonly evidence: FormAuthorityVerificationEvidence;
}

export interface FormAuthorityVerificationReadiness {
  readonly available: boolean;
  readonly released: boolean;
}

export interface FormAuthorityEvidenceVerifier {
  readonly readiness: FormAuthorityVerificationReadiness;
  verifySet(input: {
    readonly environment: FormAuthorityEnvironment;
    readonly hostId: string;
    readonly packages: readonly FormPackageInput[];
    readonly evidence: FormAuthorityVerificationEvidence;
    readonly previousCheckpoint: {
      readonly checkpointApiVersion: string;
      readonly sequence: number;
      readonly digest: AdmissionDigest;
      readonly entriesDigest: AdmissionDigest;
    } | null;
  }): Promise<VerifiedFormAuthorityEvidence>;
}

export class FormAuthorityVerificationError extends Error {
  constructor(
    readonly code:
      | "verification_unavailable"
      | "integration_only"
      | "fixture_package_refused"
      | "verification_evidence_refused"
      | "adapter_unavailable"
      | "artifact_mismatch"
      | "verification_response_refused",
    message: string = code,
  ) {
    super(message);
    this.name = "FormAuthorityVerificationError";
  }
}

export const TAKOFORM_CORE_VERIFIER_PROTOCOL = "takoserver.takoform-core-verifier@v1";
export const TAKOFORM_CORE_VERSION = "v1.1.0";
export const TAKOFORM_CORE_COMMIT = "e0e48b864de2a127a255cb0574d37bbb0f1cac29";

export interface TakoformCoreVerifierContainerId {
  toString(): string;
  equals(other: TakoformCoreVerifierContainerId): boolean;
  readonly name?: string;
  readonly jurisdiction?: string;
}

export interface TakoformCoreVerifierContainerNamespace {
  idFromName(name: string): TakoformCoreVerifierContainerId;
  get(id: TakoformCoreVerifierContainerId): {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  };
}

export interface TakoformCoreVerifierIdentity {
  readonly protocol: typeof TAKOFORM_CORE_VERIFIER_PROTOCOL;
  readonly coreVersion: typeof TAKOFORM_CORE_VERSION;
  readonly coreCommit: typeof TAKOFORM_CORE_COMMIT;
  readonly artifactDigest: AdmissionDigest;
}

export async function readReleasedCoreVerifierIdentity(input: {
  readonly containers: TakoformCoreVerifierContainerNamespace;
  readonly containerName: string;
  readonly artifactDigest: AdmissionDigest;
}): Promise<TakoformCoreVerifierIdentity> {
  let response: Response;
  try {
    const stub = input.containers.get(input.containers.idFromName(input.containerName));
    response = await stub.fetch("http://takoform-core-verifier/v1/identity", {
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new FormAuthorityVerificationError(
      "adapter_unavailable",
      error instanceof Error ? error.message : "released Core verifier unavailable",
    );
  }
  if (!response.ok) throw new FormAuthorityVerificationError("adapter_unavailable");
  let identity: unknown;
  try {
    identity = await response.json();
  } catch {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
  assertReleasedCoreIdentity(identity, input.artifactDigest);
  return structuredClone(identity as unknown as TakoformCoreVerifierIdentity);
}

/** Released-Core adapter. One bounded Container request verifies the entire set or returns nothing. */
export function createReleasedCoreFormAuthorityEvidenceVerifier(input: {
  readonly containers: TakoformCoreVerifierContainerNamespace;
  readonly containerName: string;
  readonly artifactDigest: AdmissionDigest;
}): FormAuthorityEvidenceVerifier {
  if (!input.containerName || !isSha256Digest(input.artifactDigest)) {
    throw new TypeError("released Core verifier configuration is invalid");
  }
  return {
    readiness: Object.freeze({ available: true, released: true }),
    async verifySet({ packages, evidence, previousCheckpoint }) {
      const request = releasedCoreRequest(packages, evidence, previousCheckpoint);
      let response: Response;
      try {
        const stub = input.containers.get(input.containers.idFromName(input.containerName));
        response = await stub.fetch("http://takoform-core-verifier/v1/verify-set", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(120_000),
        });
      } catch (error) {
        throw new FormAuthorityVerificationError(
          "adapter_unavailable",
          error instanceof Error ? error.message : "released Core verifier unavailable",
        );
      }
      if (!response.ok) {
        throw new FormAuthorityVerificationError(
          "verification_evidence_refused",
          `released Core verifier refused the set (${response.status})`,
        );
      }
      let result: unknown;
      try {
        result = await response.json();
      } catch {
        throw new FormAuthorityVerificationError("verification_response_refused");
      }
      assertReleasedCoreResponse(result, packages, evidence, input.artifactDigest);
      return { verificationMode: "released-core", evidence: cloneEvidence(evidence) };
    },
  };
}

function releasedCoreRequest(
  packages: readonly FormPackageInput[],
  evidence: FormAuthorityVerificationEvidence,
  previousCheckpoint: Parameters<
    FormAuthorityEvidenceVerifier["verifySet"]
  >[0]["previousCheckpoint"],
): Readonly<Record<string, unknown>> {
  const core = evidence.core;
  if (
    !core ||
    core.protocol !== TAKOFORM_CORE_VERIFIER_PROTOCOL ||
    core.expectedSourceCommit !== evidence.publisher.sourceCommit ||
    !Array.isArray(core.packageBundles) ||
    core.packageBundles.length !== packages.length ||
    !evidence.packageBundleDigests ||
    evidence.packageBundleDigests.length !== packages.length ||
    !evidence.checkpointBundleDigest
  ) {
    throw new FormAuthorityVerificationError(
      "verification_evidence_refused",
      "released Core raw evidence closure is incomplete",
    );
  }
  let publisherPolicy: unknown;
  try {
    publisherPolicy = JSON.parse(core.publisherPolicy);
  } catch {
    throw new FormAuthorityVerificationError("verification_evidence_refused");
  }
  if (
    !isJsonObject(publisherPolicy) ||
    canonicalJson(publisherPolicy) !== canonicalJson(evidence.publisher.policy ?? {})
  ) {
    throw new FormAuthorityVerificationError(
      "verification_evidence_refused",
      "Host publisher policy differs from released Core policy bytes",
    );
  }
  const bundles = new Map(core.packageBundles.map((value) => [value.packageDigest, value.bundle]));
  if (bundles.size !== packages.length) {
    throw new FormAuthorityVerificationError("verification_evidence_refused");
  }
  return {
    protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
    expectedSourceCommit: core.expectedSourceCommit,
    publisherPolicy: utf8Base64(core.publisherPolicy),
    trustedRoot: utf8Base64(core.trustedRoot),
    checkpoint: utf8Base64(core.checkpoint),
    checkpointBundle: utf8Base64(core.checkpointBundle),
    previousCheckpoint,
    packages: packages.map((pkg) => {
      if (!pkg.manifest) {
        throw new FormAuthorityVerificationError("verification_evidence_refused");
      }
      const bundle = bundles.get(pkg.packageDigest);
      if (bundle === undefined) {
        throw new FormAuthorityVerificationError("verification_evidence_refused");
      }
      return {
        packageDigest: pkg.packageDigest,
        formRef: structuredClone(pkg.formRef),
        index: utf8Base64(canonicalJson(pkg.manifest)),
        bundle: utf8Base64(bundle),
        files: pkg.files.map((file) => ({
          path: file.path,
          bytes: bytesBase64(boundedBytes(file.bytes)),
        })),
      };
    }),
  };
}

function assertReleasedCoreResponse(
  value: unknown,
  packages: readonly FormPackageInput[],
  evidence: FormAuthorityVerificationEvidence,
  artifactDigest: AdmissionDigest,
): void {
  if (
    !isJsonObject(value) ||
    !isJsonObject(value.identity) ||
    !isJsonObject(value.publisher) ||
    !isJsonObject(value.checkpoint) ||
    !Array.isArray(value.packages)
  ) {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
  assertReleasedCoreIdentity(value.identity, artifactDigest);
  const publisher = value.publisher;
  const expectedPublisher = evidence.publisher;
  for (const [actual, expected] of [
    [publisher.policyDigest, expectedPublisher.policyDigest],
    [publisher.trustedRootDigest, expectedPublisher.trustedRootDigest],
    [publisher.oidcIssuer, expectedPublisher.oidcIssuer],
    [publisher.sourceRepository, expectedPublisher.sourceRepository],
    [publisher.workflow, expectedPublisher.workflow],
    [publisher.ref, expectedPublisher.ref],
    [publisher.identity, expectedPublisher.identity],
    [publisher.sourceCommit, expectedPublisher.sourceCommit],
    [publisher.workflowCommit, expectedPublisher.workflowCommit],
    [publisher.buildConfigCommit, expectedPublisher.buildConfigCommit],
  ] as const) {
    if (actual !== expected)
      throw new FormAuthorityVerificationError("verification_response_refused");
  }
  const checkpoint = value.checkpoint;
  if (
    checkpoint.checkpointApiVersion !== evidence.checkpoint.apiVersion ||
    checkpoint.sequence !== evidence.checkpoint.sequence ||
    checkpoint.digest !== evidence.checkpoint.digest ||
    checkpoint.entriesDigest !== evidence.checkpoint.entriesDigest ||
    (checkpoint.previousDigest ?? null) !== evidence.checkpoint.previousDigest ||
    checkpoint.bundleDigest !== evidence.checkpointBundleDigest ||
    canonicalJson(checkpoint.revokedPackageDigests ?? []) !==
      canonicalJson(evidence.checkpoint.revokedPackageDigests ?? [])
  ) {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
  const expectedBundles = new Map(
    evidence.packageBundleDigests?.map((entry) => [entry.packageDigest, entry.bundleDigest]),
  );
  if (value.packages.length !== packages.length || expectedBundles.size !== packages.length) {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
  const seen = new Set<string>();
  for (const result of value.packages) {
    if (
      !isJsonObject(result) ||
      typeof result.packageDigest !== "string" ||
      seen.has(result.packageDigest)
    ) {
      throw new FormAuthorityVerificationError("verification_response_refused");
    }
    const pkg = packages.find((candidate) => candidate.packageDigest === result.packageDigest);
    if (
      !pkg ||
      canonicalJson(result.formRef) !== canonicalJson(pkg.formRef) ||
      result.bundleDigest !== expectedBundles.get(pkg.packageDigest)
    ) {
      throw new FormAuthorityVerificationError("verification_response_refused");
    }
    seen.add(result.packageDigest);
  }
}

function assertReleasedCoreIdentity(value: unknown, artifactDigest: AdmissionDigest): void {
  if (
    !isJsonObject(value) ||
    value.protocol !== TAKOFORM_CORE_VERIFIER_PROTOCOL ||
    value.coreVersion !== TAKOFORM_CORE_VERSION ||
    value.coreCommit !== TAKOFORM_CORE_COMMIT ||
    value.artifactDigest !== artifactDigest
  ) {
    throw new FormAuthorityVerificationError("artifact_mismatch");
  }
}

function boundedBytes(value: FormPackageInput["files"][number]["bytes"]): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  throw new FormAuthorityVerificationError(
    "verification_evidence_refused",
    "released Core verifier requires a bounded package closure",
  );
}

function utf8Base64(value: string): string {
  return bytesBase64(new TextEncoder().encode(value));
}

function bytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

const UNAVAILABLE = Object.freeze({ available: false, released: false });

export function createUnavailableFormAuthorityEvidenceVerifier(): FormAuthorityEvidenceVerifier {
  return {
    readiness: UNAVAILABLE,
    async verifySet(): Promise<never> {
      throw new FormAuthorityVerificationError(
        "verification_unavailable",
        "released Form package verification is unavailable",
      );
    },
  };
}

/**
 * Integration-only verification fixture. It proves the exact package and
 * evidence closure without claiming a released verifier or Host admission.
 */
export function createIntegrationFixtureEvidenceVerifier(input: {
  readonly packages: readonly {
    readonly formRef: FormPackageInput["formRef"];
    readonly packageDigest: AdmissionDigest;
  }[];
}): FormAuthorityEvidenceVerifier {
  const allowed = new Map(
    input.packages.map((candidate) => [canonicalJson(candidate.formRef), candidate.packageDigest]),
  );
  if (allowed.size !== input.packages.length || allowed.size === 0) {
    throw new TypeError("integration fixture package identities must be unique and nonempty");
  }
  for (const digest of allowed.values()) {
    if (!isSha256Digest(digest)) {
      throw new TypeError("integration fixture package digest is invalid");
    }
  }
  return {
    readiness: Object.freeze({ available: true, released: false }),
    async verifySet({ environment, packages, evidence }) {
      requireIntegration(environment);
      if (packages.length === 0) {
        throw new FormAuthorityVerificationError("fixture_package_refused");
      }
      for (const pkg of packages) await assertFixturePackage(pkg, allowed);
      validateEvidence(evidence);
      for (const pkg of packages) {
        if (evidence.publisher.group !== pkg.formRef.apiVersion) {
          throw new FormAuthorityVerificationError(
            "verification_evidence_refused",
            "integration fixture namespace evidence does not match the Form group",
          );
        }
        if ((evidence.checkpoint.revokedPackageDigests ?? []).includes(pkg.packageDigest)) {
          throw new FormAuthorityVerificationError(
            "verification_evidence_refused",
            "integration fixture package is revoked by the supplied checkpoint",
          );
        }
      }
      return {
        verificationMode: "integration-fixture",
        evidence: cloneEvidence(evidence),
      };
    },
  };
}

function requireIntegration(environment: FormAuthorityEnvironment): void {
  if (environment !== "integration") {
    throw new FormAuthorityVerificationError(
      "integration_only",
      "integration fixture verification refuses every non-integration environment",
    );
  }
}

async function assertFixturePackage(
  pkg: FormPackageInput,
  allowed: ReadonlyMap<string, AdmissionDigest>,
): Promise<void> {
  if (
    allowed.get(canonicalJson(pkg.formRef)) !== pkg.packageDigest ||
    !isSha256Digest(pkg.packageDigest) ||
    !pkg.manifest ||
    (await canonicalDigest(pkg.manifest)) !== pkg.packageDigest
  ) {
    throw new FormAuthorityVerificationError(
      "fixture_package_refused",
      "package is outside the exact integration fixture corpus",
    );
  }
}

const ROOT_KEYS = [
  "bundleDigest",
  "checkpoint",
  "checkpointBundleDigest",
  "core",
  "packageBundleDigests",
  "publisher",
] as const;
const PUBLISHER_KEYS = [
  "buildConfigCommit",
  "group",
  "identity",
  "namespaceGrantDigest",
  "oidcIssuer",
  "ownerIdentifier",
  "policy",
  "policyDigest",
  "publisherKey",
  "ref",
  "repositoryIdentifier",
  "sourceCommit",
  "sourceRepository",
  "trustedRootDigest",
  "workflow",
  "workflowCommit",
] as const;
const CHECKPOINT_KEYS = [
  "apiVersion",
  "digest",
  "entriesDigest",
  "previousDigest",
  "revokedPackageDigests",
  "sequence",
] as const;

function validateEvidence(evidence: FormAuthorityVerificationEvidence): void {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    !exactKeys(evidence, ROOT_KEYS, ["checkpointBundleDigest", "core", "packageBundleDigests"]) ||
    !exactKeys(evidence.publisher, PUBLISHER_KEYS, ["policy"]) ||
    !exactKeys(evidence.checkpoint, CHECKPOINT_KEYS, ["revokedPackageDigests"]) ||
    typeof evidence.publisher.publisherKey !== "string" ||
    evidence.publisher.publisherKey.length === 0 ||
    typeof evidence.publisher.oidcIssuer !== "string" ||
    typeof evidence.publisher.sourceRepository !== "string" ||
    typeof evidence.publisher.workflow !== "string" ||
    typeof evidence.publisher.ref !== "string" ||
    typeof evidence.publisher.identity !== "string" ||
    typeof evidence.publisher.sourceCommit !== "string" ||
    typeof evidence.publisher.workflowCommit !== "string" ||
    typeof evidence.publisher.buildConfigCommit !== "string" ||
    typeof evidence.publisher.repositoryIdentifier !== "string" ||
    typeof evidence.publisher.ownerIdentifier !== "string" ||
    typeof evidence.publisher.group !== "string" ||
    (evidence.publisher.policy !== undefined && !isJsonObject(evidence.publisher.policy)) ||
    !isSha256Digest(evidence.publisher.policyDigest) ||
    !isSha256Digest(evidence.publisher.trustedRootDigest) ||
    !isSha256Digest(evidence.publisher.namespaceGrantDigest) ||
    !isSha256Digest(evidence.checkpoint.digest) ||
    !isSha256Digest(evidence.checkpoint.entriesDigest) ||
    !isSha256Digest(evidence.bundleDigest) ||
    (evidence.checkpointBundleDigest !== undefined &&
      !isSha256Digest(evidence.checkpointBundleDigest)) ||
    (evidence.packageBundleDigests !== undefined &&
      (!Array.isArray(evidence.packageBundleDigests) ||
        evidence.packageBundleDigests.some(
          ({ packageDigest, bundleDigest }) =>
            !isSha256Digest(packageDigest) || !isSha256Digest(bundleDigest),
        ))) ||
    !Number.isSafeInteger(evidence.checkpoint.sequence) ||
    evidence.checkpoint.sequence < 0 ||
    evidence.checkpoint.apiVersion !== TAKOFORM_REVOCATION_V1 ||
    evidence.checkpoint.sequence !== 0 ||
    evidence.checkpoint.digest !== TAKOFORM_REVOCATION_V1_GENESIS_DIGEST ||
    evidence.checkpoint.entriesDigest !== TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST ||
    evidence.checkpoint.previousDigest !== null ||
    (evidence.checkpoint.revokedPackageDigests?.length ?? 0) !== 0 ||
    (evidence.checkpoint.revokedPackageDigests ?? []).some((digest) => !isSha256Digest(digest))
  ) {
    throw new FormAuthorityVerificationError("verification_evidence_refused");
  }
}

function exactKeys(
  value: unknown,
  allowed: readonly string[],
  optional: readonly string[] = [],
): value is Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value).sort();
  const required = allowed.filter((key) => !optional.includes(key));
  return required.every((key) => keys.includes(key)) && keys.every((key) => allowed.includes(key));
}

function cloneEvidence(
  evidence: FormAuthorityVerificationEvidence,
): FormAuthorityVerificationEvidence {
  return {
    publisher: {
      publisherKey: evidence.publisher.publisherKey,
      policyDigest: evidence.publisher.policyDigest,
      ...(evidence.publisher.policy === undefined
        ? {}
        : { policy: structuredClone(evidence.publisher.policy) }),
      oidcIssuer: evidence.publisher.oidcIssuer,
      sourceRepository: evidence.publisher.sourceRepository,
      workflow: evidence.publisher.workflow,
      ref: evidence.publisher.ref,
      identity: evidence.publisher.identity,
      trustedRootDigest: evidence.publisher.trustedRootDigest,
      sourceCommit: evidence.publisher.sourceCommit,
      workflowCommit: evidence.publisher.workflowCommit,
      buildConfigCommit: evidence.publisher.buildConfigCommit,
      repositoryIdentifier: evidence.publisher.repositoryIdentifier,
      ownerIdentifier: evidence.publisher.ownerIdentifier,
      group: evidence.publisher.group,
      namespaceGrantDigest: evidence.publisher.namespaceGrantDigest,
    },
    checkpoint: {
      apiVersion: evidence.checkpoint.apiVersion,
      sequence: evidence.checkpoint.sequence,
      digest: evidence.checkpoint.digest,
      entriesDigest: evidence.checkpoint.entriesDigest,
      previousDigest: evidence.checkpoint.previousDigest,
      ...(evidence.checkpoint.revokedPackageDigests === undefined
        ? {}
        : { revokedPackageDigests: [...evidence.checkpoint.revokedPackageDigests] }),
    },
    ...(evidence.core === undefined ? {} : { core: structuredClone(evidence.core) }),
    ...(evidence.checkpointBundleDigest === undefined
      ? {}
      : { checkpointBundleDigest: evidence.checkpointBundleDigest }),
    ...(evidence.packageBundleDigests === undefined
      ? {}
      : { packageBundleDigests: structuredClone(evidence.packageBundleDigests) }),
    bundleDigest: evidence.bundleDigest,
  };
}
