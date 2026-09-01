import {
  bytesDigest,
  canonicalDigest,
  canonicalJson,
  isJsonObject,
  isSha256Digest,
} from "../json.ts";
import { parseStrictJson } from "../strict-json.ts";
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

/**
 * Signature evidence for one exact Form package identity. Publisher and
 * revocation checkpoint pins are common to the complete set, but the signed
 * package bundle is never shared across package identities.
 *
 * `formRef` is optional for the wire's historical package-digest-only shape.
 * When supplied it is checked as part of the identity; when omitted the
 * package digest must still resolve to exactly one package in the verified set.
 */
export interface FormAuthorityPackageBundleEvidence {
  readonly formRef?: FormPackageInput["formRef"];
  readonly packageDigest: AdmissionDigest;
  readonly bundleDigest: AdmissionDigest;
}

export interface FormAuthorityReleasedCoreEvidence {
  readonly protocol: "takoserver.takoform-core-verifier@v1";
  readonly expectedSourceCommit: string;
  readonly publisherPolicy: string;
  readonly trustedRoot: string;
  readonly checkpoint: string;
  readonly checkpointBundle: string;
  readonly packageBundles: readonly {
    readonly formRef?: FormPackageInput["formRef"];
    readonly packageDigest: AdmissionDigest;
    readonly bundle: string;
  }[];
}

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
  /** Raw public evidence re-verified by released Core before Host mutation. */
  readonly core?: FormAuthorityReleasedCoreEvidence;
  /** Digest Core must report for the separately signed checkpoint bundle. */
  readonly checkpointBundleDigest?: AdmissionDigest;
  /** One entry for every exact package in the verified set, and no others. */
  readonly packageBundleDigests: readonly FormAuthorityPackageBundleEvidence[];
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
    /** Reserved for a released verifier's checkpoint-chain continuity check. */
    readonly previousCheckpoint?: {
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

const MAXIMUM_IDENTITY_RESPONSE_BYTES = 16 * 1024;
const MAXIMUM_VERIFICATION_RESPONSE_BYTES = 256 * 1024;

export async function readReleasedCoreVerifierIdentity(input: {
  readonly containers: TakoformCoreVerifierContainerNamespace;
  readonly containerName: string;
  readonly artifactDigest: AdmissionDigest;
}): Promise<TakoformCoreVerifierIdentity> {
  let response: Response;
  try {
    response = await containerStub(input.containers, input.containerName).fetch(
      "http://takoform-core-verifier/v1/identity",
      { signal: AbortSignal.timeout(30_000) },
    );
  } catch (error) {
    throw new FormAuthorityVerificationError(
      "adapter_unavailable",
      error instanceof Error ? error.message : "released Core verifier unavailable",
    );
  }
  if (!response.ok || !isJsonResponse(response)) {
    throw new FormAuthorityVerificationError("adapter_unavailable");
  }
  const identity = await strictResponseJson(response, MAXIMUM_IDENTITY_RESPONSE_BYTES);
  assertReleasedCoreIdentity(identity, input.artifactDigest);
  return structuredClone(identity as TakoformCoreVerifierIdentity);
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
      const request = await releasedCoreRequest(packages, evidence, previousCheckpoint);
      let response: Response;
      try {
        response = await containerStub(input.containers, input.containerName).fetch(
          "http://takoform-core-verifier/v1/verify-set",
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(request),
            signal: AbortSignal.timeout(120_000),
          },
        );
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
      if (!isJsonResponse(response)) {
        throw new FormAuthorityVerificationError("verification_response_refused");
      }
      const result = await strictResponseJson(response, MAXIMUM_VERIFICATION_RESPONSE_BYTES);
      await assertReleasedCoreResponse(result, packages, evidence, input.artifactDigest);
      return { verificationMode: "released-core", evidence: cloneEvidence(evidence) };
    },
  };
}

function containerStub(
  containers: TakoformCoreVerifierContainerNamespace,
  containerName: string,
): ReturnType<TakoformCoreVerifierContainerNamespace["get"]> {
  return containers.get(containers.idFromName(containerName));
}

async function releasedCoreRequest(
  packages: readonly FormPackageInput[],
  evidence: FormAuthorityVerificationEvidence,
  previousCheckpoint: Parameters<
    FormAuthorityEvidenceVerifier["verifySet"]
  >[0]["previousCheckpoint"],
): Promise<Readonly<Record<string, unknown>>> {
  validateEvidence(evidence);
  assertPackageBundleEvidence(evidence, packages);
  const core = evidence.core;
  if (
    !core ||
    core.protocol !== TAKOFORM_CORE_VERIFIER_PROTOCOL ||
    core.expectedSourceCommit !== evidence.publisher.sourceCommit ||
    !evidence.checkpointBundleDigest
  ) {
    throw new FormAuthorityVerificationError(
      "verification_evidence_refused",
      "released Core raw evidence closure is incomplete",
    );
  }
  // The Host pin is the canonical policy digest; Core attests the exact raw
  // bytes it verified. Both must describe the same policy document.
  const publisherPolicy = strictJsonString(core.publisherPolicy);
  if (
    !isJsonObject(publisherPolicy) ||
    canonicalJson(publisherPolicy) !== canonicalJson(evidence.publisher.policy ?? {}) ||
    (await canonicalDigest(publisherPolicy)) !== evidence.publisher.policyDigest
  ) {
    throw new FormAuthorityVerificationError(
      "verification_evidence_refused",
      "Host publisher policy differs from released Core policy bytes",
    );
  }
  const rawBundles = rawPackageBundlesByIdentity(core, packages);
  return {
    protocol: TAKOFORM_CORE_VERIFIER_PROTOCOL,
    expectedSourceCommit: core.expectedSourceCommit,
    publisherPolicy: utf8Base64(core.publisherPolicy),
    trustedRoot: utf8Base64(core.trustedRoot),
    checkpoint: utf8Base64(core.checkpoint),
    checkpointBundle: utf8Base64(core.checkpointBundle),
    ...(previousCheckpoint === undefined ? {} : { previousCheckpoint }),
    packages: packages.map((pkg) => {
      if (!pkg.manifest) {
        throw new FormAuthorityVerificationError("verification_evidence_refused");
      }
      const bundle = rawBundles.get(packageIdentityKey(pkg.formRef, pkg.packageDigest));
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

function rawPackageBundlesByIdentity(
  core: FormAuthorityReleasedCoreEvidence,
  packages: readonly Pick<FormPackageInput, "formRef" | "packageDigest">[],
): ReadonlyMap<string, string> {
  if (!Array.isArray(core.packageBundles) || core.packageBundles.length !== packages.length) {
    throw new FormAuthorityVerificationError("verification_evidence_refused");
  }
  const bundles = new Map<string, string>();
  for (const entry of core.packageBundles) {
    const key = resolvePackageIdentity(entry, packages);
    if (!key || bundles.has(key) || typeof entry.bundle !== "string" || entry.bundle.length === 0) {
      throw new FormAuthorityVerificationError("verification_evidence_refused");
    }
    bundles.set(key, entry.bundle);
  }
  if (bundles.size !== packages.length) {
    throw new FormAuthorityVerificationError("verification_evidence_refused");
  }
  return bundles;
}

async function assertReleasedCoreResponse(
  value: unknown,
  packages: readonly FormPackageInput[],
  evidence: FormAuthorityVerificationEvidence,
  artifactDigest: AdmissionDigest,
): Promise<void> {
  if (
    !isJsonObject(value) ||
    !exactKeys(value, ["checkpoint", "identity", "packages", "publisher"]) ||
    !isJsonObject(value.identity) ||
    !isJsonObject(value.publisher) ||
    !isJsonObject(value.checkpoint) ||
    !Array.isArray(value.packages)
  ) {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
  assertReleasedCoreIdentity(value.identity, artifactDigest);
  const publisher = value.publisher;
  if (
    !exactKeys(publisher, [
      "buildConfigCommit",
      "identity",
      "oidcIssuer",
      "policyDigest",
      "ref",
      "sourceCommit",
      "sourceRepository",
      "trustedRootDigest",
      "workflow",
      "workflowCommit",
    ])
  ) {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
  const expectedPublisher = evidence.publisher;
  // Core reports the digest of the exact policy bytes it verified, which the
  // request bound to the Host's canonical policy pin above.
  const rawPolicyDigest = evidence.core
    ? await bytesDigest(new TextEncoder().encode(evidence.core.publisherPolicy))
    : null;
  for (const [actual, expected] of [
    [publisher.policyDigest, rawPolicyDigest],
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
    if (actual !== expected) {
      throw new FormAuthorityVerificationError("verification_response_refused");
    }
  }
  const checkpoint = value.checkpoint;
  if (
    !exactKeys(
      checkpoint,
      [
        "bundleDigest",
        "checkpointApiVersion",
        "digest",
        "entriesDigest",
        "previousDigest",
        "revokedPackageDigests",
        "sequence",
      ],
      ["previousDigest"],
    ) ||
    checkpoint.checkpointApiVersion !== evidence.checkpoint.apiVersion ||
    checkpoint.sequence !== evidence.checkpoint.sequence ||
    checkpoint.digest !== evidence.checkpoint.digest ||
    checkpoint.entriesDigest !== evidence.checkpoint.entriesDigest ||
    (checkpoint.previousDigest ?? null) !== evidence.checkpoint.previousDigest ||
    checkpoint.bundleDigest !== evidence.checkpointBundleDigest ||
    canonicalJson(checkpoint.revokedPackageDigests) !==
      canonicalJson(evidence.checkpoint.revokedPackageDigests ?? [])
  ) {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
  const expectedBundles = packageBundleEvidenceByIdentity(evidence, packages);
  if (value.packages.length !== packages.length) {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
  const seen = new Set<string>();
  for (const result of value.packages) {
    if (
      !isJsonObject(result) ||
      !exactKeys(result, ["bundleDigest", "formRef", "packageDigest"]) ||
      !isJsonObject(result.formRef) ||
      typeof result.packageDigest !== "string"
    ) {
      throw new FormAuthorityVerificationError("verification_response_refused");
    }
    const key = packageIdentityKey(
      result.formRef as unknown as FormPackageInput["formRef"],
      result.packageDigest as AdmissionDigest,
    );
    const pkg = packages.find(
      (candidate) => packageIdentityKey(candidate.formRef, candidate.packageDigest) === key,
    );
    if (!pkg || seen.has(key) || result.bundleDigest !== expectedBundles.get(key)) {
      throw new FormAuthorityVerificationError("verification_response_refused");
    }
    seen.add(key);
  }
  if (seen.size !== packages.length) {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
}

function assertReleasedCoreIdentity(value: unknown, artifactDigest: AdmissionDigest): void {
  if (
    !isJsonObject(value) ||
    !exactKeys(value, ["artifactDigest", "coreCommit", "coreVersion", "protocol"]) ||
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

function strictJsonString(value: string): unknown {
  try {
    return parseStrictJson(new TextEncoder().encode(value), 512 * 1024);
  } catch {
    throw new FormAuthorityVerificationError("verification_evidence_refused");
  }
}

function isJsonResponse(response: Response): boolean {
  return (
    response.headers.get("content-type")?.toLowerCase().startsWith("application/json") === true
  );
}

async function strictResponseJson(response: Response, maximumBytes: number): Promise<unknown> {
  const declared = response.headers.get("content-length");
  if (declared && (!/^\d+$/u.test(declared) || Number(declared) > maximumBytes)) {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new FormAuthorityVerificationError("verification_response_refused");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel();
        throw new FormAuthorityVerificationError("verification_response_refused");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return parseStrictJson(bytes, maximumBytes);
  } catch {
    throw new FormAuthorityVerificationError("verification_response_refused");
  }
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
      assertPackageBundleEvidence(evidence, packages);
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
    (await canonicalDigest(pkg.manifest)) !== pkg.packageDigest ||
    canonicalJson(pkg.manifest.formRef) !== canonicalJson(pkg.formRef)
  ) {
    throw new FormAuthorityVerificationError(
      "fixture_package_refused",
      "package is outside the exact integration fixture corpus",
    );
  }
}

const ROOT_KEYS = [
  "checkpoint",
  "checkpointBundleDigest",
  "core",
  "packageBundleDigests",
  "publisher",
] as const;
const PACKAGE_BUNDLE_KEYS = ["bundleDigest", "formRef", "packageDigest"] as const;
const CORE_KEYS = [
  "checkpoint",
  "checkpointBundle",
  "expectedSourceCommit",
  "packageBundles",
  "protocol",
  "publisherPolicy",
  "trustedRoot",
] as const;
const CORE_PACKAGE_BUNDLE_KEYS = ["bundle", "formRef", "packageDigest"] as const;
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
    !exactKeys(evidence, ROOT_KEYS, ["checkpointBundleDigest", "core"]) ||
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
    (evidence.checkpointBundleDigest !== undefined &&
      !isSha256Digest(evidence.checkpointBundleDigest)) ||
    (evidence.core !== undefined && !validReleasedCoreEvidence(evidence.core)) ||
    !Array.isArray(evidence.packageBundleDigests) ||
    evidence.packageBundleDigests.some(
      (entry) =>
        !isRecord(entry) ||
        !exactKeys(entry, PACKAGE_BUNDLE_KEYS, ["formRef"]) ||
        !isSha256Digest(entry.packageDigest) ||
        !isSha256Digest(entry.bundleDigest) ||
        (entry.formRef !== undefined &&
          (!isJsonObject(entry.formRef) || !exactFormRef(entry.formRef))),
    ) ||
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

function validReleasedCoreEvidence(value: FormAuthorityReleasedCoreEvidence): boolean {
  return (
    isRecord(value) &&
    exactKeys(value, CORE_KEYS) &&
    value.protocol === TAKOFORM_CORE_VERIFIER_PROTOCOL &&
    /^[0-9a-f]{40}$/u.test(value.expectedSourceCommit) &&
    typeof value.publisherPolicy === "string" &&
    value.publisherPolicy.length > 0 &&
    typeof value.trustedRoot === "string" &&
    value.trustedRoot.length > 0 &&
    typeof value.checkpoint === "string" &&
    value.checkpoint.length > 0 &&
    typeof value.checkpointBundle === "string" &&
    value.checkpointBundle.length > 0 &&
    Array.isArray(value.packageBundles) &&
    value.packageBundles.every(
      (entry) =>
        isRecord(entry) &&
        exactKeys(entry, CORE_PACKAGE_BUNDLE_KEYS, ["formRef"]) &&
        isSha256Digest(entry.packageDigest) &&
        typeof entry.bundle === "string" &&
        entry.bundle.length > 0 &&
        (entry.formRef === undefined ||
          (isJsonObject(entry.formRef) && exactFormRef(entry.formRef))),
    )
  );
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

function exactFormRef(value: Readonly<Record<string, unknown>>): boolean {
  return (
    exactKeys(value, ["apiVersion", "definitionVersion", "kind", "schemaDigest"]) &&
    typeof value.apiVersion === "string" &&
    typeof value.kind === "string" &&
    typeof value.definitionVersion === "string" &&
    isSha256Digest(value.schemaDigest)
  );
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Proves that the submitted package-bundle evidence is a closed set for the
 * exact package identities being verified. This intentionally rejects
 * duplicate, missing, and extra entries before any Host mutation.
 */
export function assertPackageBundleEvidence(
  evidence: FormAuthorityVerificationEvidence,
  packages: readonly Pick<FormPackageInput, "formRef" | "packageDigest">[],
): void {
  const expected = new Map(
    packages.map((pkg) => [packageIdentityKey(pkg.formRef, pkg.packageDigest), pkg]),
  );
  if (expected.size !== packages.length || expected.size === 0) {
    throw new FormAuthorityVerificationError(
      "verification_evidence_refused",
      "verified package identities are duplicated or empty",
    );
  }
  const entries = evidence.packageBundleDigests;
  if (!Array.isArray(entries) || entries.length !== expected.size) {
    throw new FormAuthorityVerificationError(
      "verification_evidence_refused",
      "package bundle evidence is missing or has extra entries",
    );
  }
  const seen = new Set<string>();
  for (const entry of entries) {
    if (
      !entry ||
      typeof entry !== "object" ||
      !isSha256Digest(entry.packageDigest) ||
      !isSha256Digest(entry.bundleDigest)
    ) {
      throw new FormAuthorityVerificationError("verification_evidence_refused");
    }
    const candidates = [...expected.entries()].filter(
      ([key, pkg]) =>
        pkg.packageDigest === entry.packageDigest &&
        (entry.formRef === undefined ||
          canonicalJson(pkg.formRef) === canonicalJson(entry.formRef)) &&
        key === packageIdentityKey(pkg.formRef, pkg.packageDigest),
    );
    if (candidates.length !== 1) {
      throw new FormAuthorityVerificationError(
        "verification_evidence_refused",
        "package bundle evidence entry is unknown or ambiguous",
      );
    }
    const key = candidates[0]?.[0];
    if (!key || seen.has(key)) {
      throw new FormAuthorityVerificationError(
        "verification_evidence_refused",
        "package bundle evidence contains a duplicate entry",
      );
    }
    seen.add(key);
  }
  if (seen.size !== expected.size) {
    throw new FormAuthorityVerificationError(
      "verification_evidence_refused",
      "package bundle evidence is incomplete",
    );
  }
}

/** Validates the evidence shape and proves it is a closed set for `packages`. */
export function assertFormAuthorityEvidence(
  evidence: FormAuthorityVerificationEvidence,
  packages: readonly Pick<FormPackageInput, "formRef" | "packageDigest">[],
): void {
  validateEvidence(evidence);
  assertPackageBundleEvidence(evidence, packages);
}

function packageBundleEvidenceByIdentity(
  evidence: FormAuthorityVerificationEvidence,
  packages: readonly Pick<FormPackageInput, "formRef" | "packageDigest">[],
): ReadonlyMap<string, AdmissionDigest> {
  assertPackageBundleEvidence(evidence, packages);
  const result = new Map<string, AdmissionDigest>();
  for (const entry of evidence.packageBundleDigests) {
    const key = resolvePackageIdentity(entry, packages);
    if (!key || result.has(key)) {
      throw new FormAuthorityVerificationError("verification_evidence_refused");
    }
    result.set(key, entry.bundleDigest);
  }
  return result;
}

function resolvePackageIdentity(
  entry: { readonly formRef?: FormPackageInput["formRef"]; readonly packageDigest: string },
  packages: readonly Pick<FormPackageInput, "formRef" | "packageDigest">[],
): string | null {
  const matches = packages.filter(
    (pkg) =>
      pkg.packageDigest === entry.packageDigest &&
      (entry.formRef === undefined || canonicalJson(pkg.formRef) === canonicalJson(entry.formRef)),
  );
  return matches.length === 1
    ? packageIdentityKey(matches[0]!.formRef, matches[0]!.packageDigest)
    : null;
}

export function packageIdentityKey(
  formRef: FormPackageInput["formRef"],
  packageDigest: AdmissionDigest,
): string {
  return `${canonicalJson(formRef)}\0${packageDigest}`;
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
    packageBundleDigests: evidence.packageBundleDigests.map((entry) => ({
      ...(entry.formRef === undefined ? {} : { formRef: structuredClone(entry.formRef) }),
      packageDigest: entry.packageDigest,
      bundleDigest: entry.bundleDigest,
    })),
  };
}
