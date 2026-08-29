import { canonicalDigest, canonicalJson, isSha256Digest } from "../json.ts";
import type {
  AdmissionDigest,
  AdmissionHandle,
  AdmissionHandleIssuer,
  AdmissionPublisherPin,
  AdmissionReport,
} from "./admission.ts";
import {
  createAdmissionHandleIssuer,
  TAKOFORM_REVOCATION_V1,
  TAKOFORM_REVOCATION_V1_EMPTY_ENTRIES_DIGEST,
  TAKOFORM_REVOCATION_V1_GENESIS_DIGEST,
  type TakoformRevocationCheckpointApiVersion,
} from "./admission.ts";
import type { FormPackageInput } from "./form-packages.ts";

export type FormAuthorityEnvironment = "integration" | "rehearsal" | "production";

export interface FormAuthorityTrustEvidence {
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

export interface VerifiedFormAuthorityTrustEvidence extends FormAuthorityTrustEvidence {
  readonly admissionMode: "released-core" | "integration-fixture";
  readonly productionEligible: boolean;
}

export interface FormAuthorityAdapterReadiness {
  readonly available: boolean;
  readonly released: boolean;
  readonly productionEligible: boolean;
}

export interface SignedTrustEvidenceAdapter {
  readonly readiness: FormAuthorityAdapterReadiness;
  verify(input: {
    readonly environment: FormAuthorityEnvironment;
    readonly hostId: string;
    readonly package: FormPackageInput;
    readonly evidence: FormAuthorityTrustEvidence;
  }): Promise<VerifiedFormAuthorityTrustEvidence>;
}

export interface PreparedCoreAdmission {
  readonly admissionMode: "released-core" | "integration-fixture";
  readonly productionEligible: boolean;
  issue(input: {
    readonly policyEventDigest: AdmissionDigest;
    readonly checkpointEventDigest: AdmissionDigest;
  }): AdmissionHandle;
}

/**
 * Port for a released Takoform Core EvaluateAdmission implementation.
 *
 * Takoserver deliberately defines no TypeScript evaluator. A future adapter
 * must wrap a released Core artifact and return an opaque in-process handle
 * from the same issuer passed to the durable admission store.
 */
export interface CoreAdmissionAdapter {
  readonly readiness: FormAuthorityAdapterReadiness;
  readonly handles: AdmissionHandleIssuer;
  prepare(input: {
    readonly environment: FormAuthorityEnvironment;
    readonly hostId: string;
    readonly operation: "install" | "replace";
    readonly package: FormPackageInput;
    readonly evidence: VerifiedFormAuthorityTrustEvidence;
  }): Promise<PreparedCoreAdmission>;
}

export class FormAuthorityAdapterError extends Error {
  constructor(
    readonly code:
      | "core_admission_unavailable"
      | "signed_trust_unavailable"
      | "integration_only"
      | "fixture_package_refused"
      | "trust_evidence_refused",
    message: string = code,
  ) {
    super(message);
    this.name = "FormAuthorityAdapterError";
  }
}

const UNAVAILABLE = Object.freeze({
  available: false,
  released: false,
  productionEligible: false,
});

export function createUnavailableCoreAdmissionAdapter(): CoreAdmissionAdapter {
  const handles = createAdmissionHandleIssuer();
  return {
    readiness: UNAVAILABLE,
    handles,
    async prepare(): Promise<never> {
      throw new FormAuthorityAdapterError(
        "core_admission_unavailable",
        "released Takoform Core EvaluateAdmission adapter is unavailable",
      );
    },
  };
}

export function createUnavailableSignedTrustEvidenceAdapter(): SignedTrustEvidenceAdapter {
  return {
    readiness: UNAVAILABLE,
    async verify(): Promise<never> {
      throw new FormAuthorityAdapterError(
        "signed_trust_unavailable",
        "signed trust evidence adapter is unavailable",
      );
    },
  };
}

/**
 * Test/staging bridge only. It proves package closure and issues an opaque
 * handle for the exact allowlisted package identities, but makes no signature
 * or first-party claim. Every result is permanently ineligible for production.
 */
export function createIntegrationFixtureAdmissionAdapters(input: {
  readonly packages: readonly {
    readonly formRef: FormPackageInput["formRef"];
    readonly packageDigest: AdmissionDigest;
  }[];
}): {
  readonly core: CoreAdmissionAdapter;
  readonly trust: SignedTrustEvidenceAdapter;
} {
  const allowed = new Map(
    input.packages.map((candidate) => [canonicalJson(candidate.formRef), candidate.packageDigest]),
  );
  if (allowed.size !== input.packages.length || allowed.size === 0) {
    throw new TypeError("integration fixture package identities must be unique and nonempty");
  }
  for (const digest of allowed.values()) {
    if (!isSha256Digest(digest))
      throw new TypeError("integration fixture package digest is invalid");
  }
  const handles = createAdmissionHandleIssuer();
  const readiness = Object.freeze({
    available: true,
    released: false,
    productionEligible: false,
  });
  const trust: SignedTrustEvidenceAdapter = {
    readiness,
    async verify({ environment, package: pkg, evidence }) {
      requireIntegration(environment);
      await assertFixturePackage(pkg, allowed);
      validateEvidence(evidence);
      if (evidence.publisher.group !== pkg.formRef.apiVersion) {
        throw new FormAuthorityAdapterError(
          "trust_evidence_refused",
          "integration fixture namespace evidence does not match the Form group",
        );
      }
      if ((evidence.checkpoint.revokedPackageDigests ?? []).includes(pkg.packageDigest)) {
        throw new FormAuthorityAdapterError(
          "trust_evidence_refused",
          "integration fixture package is revoked by the supplied checkpoint",
        );
      }
      return {
        ...structuredClone(evidence),
        admissionMode: "integration-fixture",
        productionEligible: false,
      };
    },
  };
  const core: CoreAdmissionAdapter = {
    readiness,
    handles,
    async prepare({ environment, operation, package: pkg, evidence }) {
      requireIntegration(environment);
      await assertFixturePackage(pkg, allowed);
      if (
        evidence.admissionMode !== "integration-fixture" ||
        evidence.productionEligible !== false
      ) {
        throw new FormAuthorityAdapterError("trust_evidence_refused");
      }
      const report: AdmissionReport = {
        status: "admitted",
        operation,
        package: {
          packageDigest: pkg.packageDigest,
          formRef: structuredClone(pkg.formRef),
          fileCount: pkg.files.length,
          payloadBytes: pkg.files.reduce((total, file) => total + packageFileSize(file.bytes), 0),
        },
        publisher: {
          policyDigest: evidence.publisher.policyDigest,
          oidcIssuer: evidence.publisher.oidcIssuer,
          sourceRepository: evidence.publisher.sourceRepository,
          workflow: evidence.publisher.workflow,
          ref: evidence.publisher.ref,
          identity: evidence.publisher.identity,
        },
        source: {
          sourceCommit: evidence.publisher.sourceCommit,
          workflowCommit: evidence.publisher.workflowCommit,
          buildConfigCommit: evidence.publisher.buildConfigCommit,
          repositoryIdentifier: evidence.publisher.repositoryIdentifier,
          ownerIdentifier: evidence.publisher.ownerIdentifier,
        },
        namespace: {
          group: evidence.publisher.group,
          namespaceGrantDigest: evidence.publisher.namespaceGrantDigest,
        },
        signature: {
          subjectDigest: pkg.packageDigest,
          bundleDigest: evidence.bundleDigest,
          trustedRootDigest: evidence.publisher.trustedRootDigest,
        },
        revocation: {
          checkpointApiVersion: evidence.checkpoint.apiVersion,
          sequence: evidence.checkpoint.sequence,
          checkpointDigest: evidence.checkpoint.digest,
          entriesDigest: evidence.checkpoint.entriesDigest,
          revoked: (evidence.checkpoint.revokedPackageDigests ?? []).includes(pkg.packageDigest),
        },
        checks: [
          { code: "integration-fixture-exact-package-closure", passed: true },
          { code: "integration-fixture-not-production-eligible", passed: true },
        ],
      };
      return {
        admissionMode: "integration-fixture" as const,
        productionEligible: false,
        issue({ policyEventDigest, checkpointEventDigest }): AdmissionHandle {
          return handles.issue({
            operation,
            packageDigest: pkg.packageDigest,
            formRef: pkg.formRef,
            publisherKey: evidence.publisher.publisherKey,
            publisher: evidence.publisher,
            policyEventDigest,
            checkpointApiVersion: evidence.checkpoint.apiVersion,
            checkpointSequence: evidence.checkpoint.sequence,
            checkpointDigest: evidence.checkpoint.digest,
            checkpointEventDigest,
            report,
          });
        },
      };
    },
  };
  return { core, trust };
}

function requireIntegration(environment: FormAuthorityEnvironment): void {
  if (environment !== "integration") {
    throw new FormAuthorityAdapterError(
      "integration_only",
      "integration fixture admission refuses every non-integration environment",
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
    throw new FormAuthorityAdapterError(
      "fixture_package_refused",
      "package is outside the exact integration fixture corpus",
    );
  }
}

function validateEvidence(evidence: FormAuthorityTrustEvidence): void {
  if (
    !evidence ||
    typeof evidence !== "object" ||
    !evidence.publisher ||
    typeof evidence.publisher.publisherKey !== "string" ||
    evidence.publisher.publisherKey.length === 0 ||
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
    (evidence.checkpoint.revokedPackageDigests?.length ?? 0) !== 0
  ) {
    throw new FormAuthorityAdapterError("trust_evidence_refused");
  }
}

function packageFileSize(bytes: Uint8Array | ArrayBuffer | ReadableStream<Uint8Array>): number {
  if (bytes instanceof Uint8Array) return bytes.byteLength;
  if (bytes instanceof ArrayBuffer) return bytes.byteLength;
  throw new FormAuthorityAdapterError(
    "fixture_package_refused",
    "integration fixture package bytes must be bounded in memory",
  );
}
