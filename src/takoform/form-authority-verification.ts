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
  verify(input: {
    readonly environment: FormAuthorityEnvironment;
    readonly hostId: string;
    readonly package: FormPackageInput;
    readonly evidence: FormAuthorityVerificationEvidence;
  }): Promise<VerifiedFormAuthorityEvidence>;
}

export class FormAuthorityVerificationError extends Error {
  constructor(
    readonly code:
      | "verification_unavailable"
      | "integration_only"
      | "fixture_package_refused"
      | "verification_evidence_refused",
    message: string = code,
  ) {
    super(message);
    this.name = "FormAuthorityVerificationError";
  }
}

const UNAVAILABLE = Object.freeze({ available: false, released: false });

export function createUnavailableFormAuthorityEvidenceVerifier(): FormAuthorityEvidenceVerifier {
  return {
    readiness: UNAVAILABLE,
    async verify(): Promise<never> {
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
    async verify({ environment, package: pkg, evidence }) {
      requireIntegration(environment);
      await assertFixturePackage(pkg, allowed);
      validateEvidence(evidence);
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

const ROOT_KEYS = ["bundleDigest", "checkpoint", "publisher"] as const;
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
    !exactKeys(evidence, ROOT_KEYS) ||
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
    bundleDigest: evidence.bundleDigest,
  };
}
