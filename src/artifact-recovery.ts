import {
  deterministicIntegrationE2eApiKeyIds,
  INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS,
  INTEGRATION_E2E_EVIDENCE_KEY_NAME,
  INTEGRATION_E2E_EVIDENCE_SCOPES,
  INTEGRATION_E2E_ORGANIZATION_ID,
  INTEGRATION_E2E_WRITER_KEY_NAME,
  INTEGRATION_E2E_WRITER_SCOPES,
} from "./integration-e2e-credential-authority.ts";
import { canonicalDigest, canonicalJson, isSha256Digest } from "./json.ts";
import type { Clock, ObjectStoreAccess, Row, Sql } from "./ports.ts";

export const ARTIFACT_RECOVERY_REQUEST_FORMAT =
  "takoserver.exact-failed-run-artifact-recovery-request@v2" as const;
export const ARTIFACT_RECOVERY_APPLY_FORMAT =
  "takoserver.exact-failed-run-artifact-recovery-apply@v2" as const;
export const ARTIFACT_RECOVERY_STATUS_FORMAT =
  "takoserver.exact-failed-run-artifact-recovery-status@v2" as const;
export const ARTIFACT_RECOVERY_PLAN_FORMAT =
  "takoserver.exact-failed-run-artifact-recovery-plan@v2" as const;
export const ARTIFACT_RECOVERY_RETENTION_FORMAT =
  "takoserver.exact-failed-run-artifact-recovery-detail-retention@v1" as const;
export const ARTIFACT_RECOVERY_LOST_ACK_FORMAT =
  "takoserver.exact-failed-run-artifact-recovery-lost-ack@v1" as const;
export const ARTIFACT_RECOVERY_EXECUTION_HANDOFF_FORMAT =
  "takoserver.exact-failed-run-artifact-recovery-execution-handoff@v1" as const;
export const ARTIFACT_RECOVERY_EXECUTION_LINEAGE_FORMAT =
  "takoserver.exact-failed-run-artifact-recovery-execution-lineage@v1" as const;
export const ARTIFACT_RECOVERY_RESULT_SET_FORMAT =
  "takoserver.exact-artifact-recovery-result-set@v2" as const;
export const ARTIFACT_RECOVERY_LINEAGE_MIGRATION =
  "0045_cloudflare_provider_executor_operations.sql" as const;
export const ARTIFACT_RECOVERY_LINEAGE_DIGEST =
  "sha256:7d87cb2eec7a3434ece89f1e5d2ecac470d1e717c0611ee3f47b5390f991f9f2" as const;

export type Digest = `sha256:${string}`;

export const EXACT_ARTIFACT_RECOVERY_OWNER_COUNT = 4;
export const EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT = 5;
export const EXACT_ARTIFACT_RECOVERY_REPLAY_COUNT = 2;
export const EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT = 28;
export const EXACT_ARTIFACT_RECOVERY_HOLD_COUNT = 29;
export const EXACT_ARTIFACT_RECOVERY_CANDIDATE_COUNT = 29;
export const ARTIFACT_RECOVERY_QUARANTINE_MILLISECONDS = 60 * 60_000;

export interface ArtifactRecoveryOwner {
  readonly principalId: string;
  readonly operationId: string;
}

export interface ArtifactRecoveryUpload {
  readonly principalId: string;
  readonly uploadId: string;
  readonly uploadFence: number;
  readonly rootFence: number;
}

export interface ArtifactRecoveryRequest {
  readonly kind: typeof ARTIFACT_RECOVERY_REQUEST_FORMAT;
  readonly tenantId: string;
  readonly logicalTargetDigest: Digest;
  readonly owners: readonly ArtifactRecoveryOwner[];
  readonly ownerSetDigest: Digest;
  readonly uploads: readonly ArtifactRecoveryUpload[];
  readonly uploadSetDigest: Digest;
  readonly manifestDigest: Digest;
  readonly memberDigests: readonly Digest[];
  readonly memberSetDigest: Digest;
  readonly expectedHolds: {
    readonly entries: readonly { readonly kind: "manifest" | "blob"; readonly digest: Digest }[];
    readonly count: number;
    readonly setDigest: Digest;
  };
  readonly expectedReplays: {
    readonly keys: readonly string[];
    readonly count: number;
    readonly setDigest: Digest;
  };
  readonly settlementEvidence: { readonly kind: string; readonly digest: Digest };
  readonly lineage: {
    readonly migration: typeof ARTIFACT_RECOVERY_LINEAGE_MIGRATION;
    readonly digest: typeof ARTIFACT_RECOVERY_LINEAGE_DIGEST;
  };
  readonly r2: {
    readonly accountId: string;
    readonly bucketName: string;
    readonly identityDigest: Digest;
  };
  readonly source: {
    readonly repository: "takoserver";
    readonly commit: string;
    readonly version: string;
  };
  readonly retentionPolicy: {
    readonly kind: typeof ARTIFACT_RECOVERY_RETENTION_FORMAT;
    readonly evidenceDigest: Digest;
    readonly detailRetentionMilliseconds: number;
  };
}

export interface ArtifactRecoveryLostAckAuthorization {
  readonly kind: typeof ARTIFACT_RECOVERY_LOST_ACK_FORMAT;
  readonly candidateOrdinal: number;
  readonly predecessorWorkerVersionId: string;
  readonly quiescenceEvidenceDigest: Digest;
  readonly resolution:
    | { readonly kind: "confirm-head-absent" }
    | {
        readonly kind: "reviewed-retry";
        readonly observedEtag: string;
        readonly operationId: string;
        readonly candidateFence: number;
        readonly reviewEvidenceDigest: Digest;
      };
}

/** Exact structural validator shared by the owner CLI and route-less Worker binding boundary. */
export function parseArtifactRecoveryLostAckAuthorization(
  value: unknown,
): ArtifactRecoveryLostAckAuthorization {
  const input = record(value, "lostAck");
  exactKeys(input, [
    "kind",
    "candidateOrdinal",
    "predecessorWorkerVersionId",
    "quiescenceEvidenceDigest",
    "resolution",
  ]);
  if (input.kind !== ARTIFACT_RECOVERY_LOST_ACK_FORMAT) {
    throw new TypeError("artifact recovery lost-ack kind is invalid");
  }
  if (!Number.isSafeInteger(input.candidateOrdinal)) {
    throw new TypeError("artifact recovery lost-ack candidateOrdinal is invalid");
  }
  const candidateOrdinal = Number(input.candidateOrdinal);
  if (candidateOrdinal < 0 || candidateOrdinal >= EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT) {
    throw new TypeError("artifact recovery lost-ack candidateOrdinal is invalid");
  }
  const predecessorWorkerVersionId = input.predecessorWorkerVersionId;
  if (!workerVersionId(predecessorWorkerVersionId)) {
    throw new TypeError("artifact recovery lost-ack predecessor Worker Version is invalid");
  }
  const quiescenceEvidenceDigest = digest(
    input.quiescenceEvidenceDigest,
    "lostAck.quiescenceEvidenceDigest",
  );
  const resolution = record(input.resolution, "lostAck.resolution");
  if (resolution.kind === "confirm-head-absent") {
    exactKeys(resolution, ["kind"]);
    return {
      kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
      candidateOrdinal,
      predecessorWorkerVersionId,
      quiescenceEvidenceDigest,
      resolution: { kind: "confirm-head-absent" },
    };
  }
  if (resolution.kind !== "reviewed-retry") {
    throw new TypeError("artifact recovery lost-ack resolution is invalid");
  }
  exactKeys(resolution, [
    "kind",
    "observedEtag",
    "operationId",
    "candidateFence",
    "reviewEvidenceDigest",
  ]);
  const observedEtag = resolution.observedEtag;
  if (
    typeof observedEtag !== "string" ||
    observedEtag.length < 1 ||
    observedEtag.length > 512 ||
    [...observedEtag].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new TypeError("artifact recovery lost-ack observed ETag is invalid");
  }
  const operationId = boundedIdentifier(resolution.operationId, "lostAck.operationId", 3, 128);
  if (!Number.isSafeInteger(resolution.candidateFence)) {
    throw new TypeError("artifact recovery lost-ack candidateFence is invalid");
  }
  const candidateFence = Number(resolution.candidateFence);
  if (candidateFence < 2) {
    throw new TypeError("artifact recovery lost-ack candidateFence is invalid");
  }
  const reviewEvidenceDigest = digest(
    resolution.reviewEvidenceDigest,
    "lostAck.reviewEvidenceDigest",
  );
  return {
    kind: ARTIFACT_RECOVERY_LOST_ACK_FORMAT,
    candidateOrdinal,
    predecessorWorkerVersionId,
    quiescenceEvidenceDigest,
    resolution: {
      kind: "reviewed-retry",
      observedEtag,
      operationId,
      candidateFence,
      reviewEvidenceDigest,
    },
  };
}

/** Immutable values embedded in the exact route-less recovery Worker Version. */
export interface ArtifactRecoveryExecution {
  readonly pinnedRequestDigest: Digest;
  readonly workerVersionId: string;
  readonly r2IdentityDigest: Digest;
  readonly sourceCommit: string;
  readonly sourceVersion: string;
  readonly lostAck?: ArtifactRecoveryLostAckAuthorization;
}

export interface ExactArtifactRecoveryExecutionHandoff {
  readonly sequence: number;
  readonly candidateOrdinal: number;
  readonly candidateFence: number;
  readonly predecessorWorkerVersionId: string;
  readonly successorWorkerVersionId: string;
  readonly resolutionKind: "confirm-head-absent" | "reviewed-retry";
  readonly observedEtag: string | null;
  readonly reviewedOperationId: string | null;
  readonly reviewedCandidateFence: number | null;
  readonly reviewEvidenceDigest: Digest | null;
  readonly quiescenceEvidenceDigest: Digest;
  readonly activatedAt: number;
  readonly handoffDigest: Digest;
  readonly purgeAfter: number | null;
}

export interface ExactArtifactRecoveryResult {
  readonly ordinal: number;
  readonly kind: "blob" | "manifest";
  readonly digest: Digest;
  readonly resultDigest: Digest;
}

export async function exactArtifactRecoveryExecutionHandoffDigest(
  requestDigest: Digest,
  handoff: Omit<ExactArtifactRecoveryExecutionHandoff, "handoffDigest" | "purgeAfter">,
): Promise<Digest> {
  return await canonicalDigest({
    kind: ARTIFACT_RECOVERY_EXECUTION_HANDOFF_FORMAT,
    requestDigest,
    ...handoff,
  });
}

export async function exactArtifactRecoveryExecutionLineageDigest(input: {
  readonly requestDigest: Digest;
  readonly preparingWorkerVersionId: string;
  readonly activeWorkerVersionId: string;
  readonly handoffs: readonly Pick<
    ExactArtifactRecoveryExecutionHandoff,
    "sequence" | "handoffDigest"
  >[];
}): Promise<Digest> {
  return await canonicalDigest({
    kind: ARTIFACT_RECOVERY_EXECUTION_LINEAGE_FORMAT,
    ...input,
  });
}

export async function exactArtifactRecoveryResultSetDigest(input: {
  readonly requestDigest: Digest;
  readonly executionLineageDigest: Digest;
  readonly results: readonly ExactArtifactRecoveryResult[];
}): Promise<Digest> {
  return await canonicalDigest({ kind: ARTIFACT_RECOVERY_RESULT_SET_FORMAT, ...input });
}

export interface ArtifactRecoveryStatus {
  readonly kind: typeof ARTIFACT_RECOVERY_STATUS_FORMAT;
  readonly requestDigest: Digest;
  readonly phase: "eligible" | "prepared" | "settling" | "blocked" | "complete" | "revoked";
  readonly action:
    | "prepare"
    | "wait"
    | "settle"
    | "reconcile_absent"
    | "rearm"
    | "complete"
    | "none";
  readonly blocker?: string;
  readonly planDigest: Digest;
  readonly receiptCount: number;
  readonly candidates: {
    readonly pending: number;
    readonly deleteStarted: number;
    readonly deleted: number;
    readonly metadataDeleted: number;
  };
  readonly quarantineNotBefore: number | null;
  readonly nextCandidate: {
    readonly ordinal: number;
    readonly kind: "manifest" | "blob";
    readonly state: "pending" | "delete_started";
    readonly fence: number;
    readonly notBefore: number;
  } | null;
  readonly metadataPresent: boolean;
  readonly presentBlobs: number;
  readonly absentBlobs: number;
  readonly detailState: "unprepared" | "active" | "purging" | "purged";
  readonly purgeAfter: number | null;
}

export interface CanonicalArtifactRecoveryRequest {
  readonly request: ArtifactRecoveryRequest;
  readonly canonicalJson: string;
  readonly requestDigest: Digest;
  readonly receipts: readonly {
    readonly receiptId: string;
    readonly principalId: string;
    readonly uploadId: string;
  }[];
}

export interface ArtifactRecovery {
  status(request: unknown): Promise<ArtifactRecoveryStatus>;
  apply(input: {
    readonly request: unknown;
    readonly planDigest: Digest;
  }): Promise<ArtifactRecoveryStatus>;
}

export interface ExactArtifactRecoveryCredentialClosure {
  readonly principalId: string;
  readonly operationId: string;
  readonly authoritySlot: string;
  readonly organizationId: string;
  readonly writerKeyId: string;
  readonly evidenceKeyId: string;
  readonly writerName: string;
  readonly evidenceName: string;
  readonly writerScopesJson: string;
  readonly evidenceScopesJson: string;
  readonly ttlSeconds: number;
  readonly operationState: "revoked";
  readonly operationFence: number;
  readonly provenance: {
    readonly sourceCommit: string;
    readonly artifactDigest: Digest;
    readonly authorityWorkerVersionId: string;
  };
  readonly operationCreatedAt: number;
  readonly operationUpdatedAt: number;
  readonly operationRevokedAt: number;
  readonly closedAt: number;
  readonly writerToken: {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly scopesJson: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly revokedAt: string;
  };
  readonly evidenceToken: {
    readonly id: string;
    readonly organizationId: string;
    readonly name: string;
    readonly scopesJson: string;
    readonly createdAt: string;
    readonly expiresAt: string;
    readonly revokedAt: string;
  };
}

export interface ExactArtifactRecoveryPreparation {
  readonly canonical: CanonicalArtifactRecoveryRequest;
  readonly evidenceDigest: Digest;
  readonly owners: readonly ExactArtifactRecoveryCredentialClosure[];
  readonly candidateEtags: readonly string[];
  readonly execution: ArtifactRecoveryExecution;
}

export interface ExactArtifactRecoveryCandidate {
  readonly ordinal: number;
  readonly kind: "manifest" | "blob";
  readonly digest: Digest;
  readonly state: "pending" | "delete_started";
  readonly fence: number;
  readonly notBefore: number;
  readonly activeEtag: string | null;
  readonly deleteOperationId: string | null;
  readonly deleteLeaseFence: number | null;
  readonly executionWorkerVersionId: string | null;
}

export interface ExactArtifactRecoverySettlement {
  readonly canonical: CanonicalArtifactRecoveryRequest;
  readonly candidate: ExactArtifactRecoveryCandidate;
  readonly execution: ArtifactRecoveryExecution;
}

export interface ExactArtifactRecoveryRearm extends ExactArtifactRecoverySettlement {
  readonly observedEtag: string;
  readonly authorization: ArtifactRecoveryLostAckAuthorization & {
    readonly resolution: Extract<
      ArtifactRecoveryLostAckAuthorization["resolution"],
      { kind: "reviewed-retry" }
    >;
  };
}

export interface ExactArtifactRecoveryCompletion {
  readonly canonical: CanonicalArtifactRecoveryRequest;
  readonly resultSetDigest: Digest;
  readonly execution: ArtifactRecoveryExecution;
}

/** Mutations stay in the reconciler composed only by the route-less Worker. */
export interface ExactArtifactRecoveryCoordinator {
  prepareExactArtifactRecovery(input: ExactArtifactRecoveryPreparation): Promise<void>;
  settleNextExactArtifactRecovery(input: ExactArtifactRecoverySettlement): Promise<void>;
  reconcileAbsentExactArtifactRecovery(input: ExactArtifactRecoverySettlement): Promise<void>;
  rearmExactArtifactRecovery(input: ExactArtifactRecoveryRearm): Promise<void>;
  completeExactArtifactRecovery(input: ExactArtifactRecoveryCompletion): Promise<void>;
}

export interface CreateArtifactRecoveryOptions {
  readonly sql: Sql;
  readonly objects: Pick<ObjectStoreAccess, "head">;
  readonly clock: Clock;
  readonly coordinator: ExactArtifactRecoveryCoordinator;
  readonly execution: ArtifactRecoveryExecution;
}

export class ArtifactRecoveryError extends Error {
  constructor(
    readonly code: "invalid_request" | "state_conflict" | "identity_unavailable",
    readonly status: 400 | 409 | 503,
  ) {
    super(code);
    this.name = "ArtifactRecoveryError";
  }
}

interface RecoveryInspection {
  readonly canonical: CanonicalArtifactRecoveryRequest;
  readonly status: ArtifactRecoveryStatus;
  readonly preparation?: ExactArtifactRecoveryPreparation;
  readonly candidate?: ExactArtifactRecoveryCandidate;
  readonly observedEtag?: string;
  readonly resultSetDigest?: Digest;
}

type RecoveryInspectionResult = Omit<RecoveryInspection, "canonical">;
type CredentialClosure = ExactArtifactRecoveryCredentialClosure;

interface RecoveryCandidateRow {
  readonly ordinal: number;
  readonly kind: "manifest" | "blob";
  readonly digest: Digest;
  readonly preparedEtag: string | null;
  readonly activeEtag: string | null;
  readonly detailState: "pending" | "delete_started" | "deleted" | "metadata_deleted";
  readonly deleteOperationId: string | null;
  readonly deleteLeaseFence: number | null;
  readonly executionWorkerVersionId: string | null;
  readonly resultDigest: Digest | null;
  readonly completedAt: number | null;
  readonly gcState: "pending" | "deleting" | "retry" | "deleted" | "cancelled";
  readonly fence: number;
  readonly notBefore: number;
  readonly expectedEtag: string | null;
  readonly attempts: number;
  readonly lastOutcome: string;
  readonly leaseOperationId: string | null;
  readonly leaseFence: number | null;
  readonly leaseOutcome: string | null;
}

interface SingletonRow {
  readonly requestDigest: Digest;
  readonly evidenceDigest: Digest;
  readonly tenantId: string;
  readonly logicalTargetDigest: Digest;
  readonly manifestDigest: Digest;
  readonly ownerSetDigest: Digest;
  readonly uploadSetDigest: Digest;
  readonly memberSetDigest: Digest;
  readonly replaySetDigest: Digest;
  readonly holdSetDigest: Digest;
  readonly expectedOwnerCount: number;
  readonly expectedUploadCount: number;
  readonly expectedReplayCount: number;
  readonly expectedMemberCount: number;
  readonly expectedHoldCount: number;
  readonly settlementEvidenceKind: string;
  readonly settlementEvidenceDigest: Digest;
  readonly lineageMigration: string;
  readonly lineageDigest: Digest;
  readonly r2IdentityDigest: Digest;
  readonly sourceCommit: string;
  readonly sourceVersion: string;
  readonly preparingWorkerVersionId: string;
  readonly activeWorkerVersionId: string;
  readonly executionHandoffCount: number;
  readonly retentionPolicyKind: string;
  readonly retentionPolicyDigest: Digest;
  readonly detailRetentionMilliseconds: number;
  readonly phase: "prepared" | "settling" | "complete" | "revoked";
  readonly preparedAt: number;
  readonly completedAt: number | null;
  readonly resultSetDigest: Digest | null;
  readonly purgeAfter: number | null;
  readonly detailState: "active" | "purging" | "purged";
}

export function createArtifactRecovery(options: CreateArtifactRecoveryOptions): ArtifactRecovery {
  const inspect = async (value: unknown): Promise<RecoveryInspection> => {
    let canonical: CanonicalArtifactRecoveryRequest;
    try {
      canonical = await canonicalArtifactRecoveryRequest(value);
      assertExecutionBinding(canonical, options.execution);
    } catch (error) {
      if (error instanceof TypeError) throw new ArtifactRecoveryError("invalid_request", 400);
      throw error;
    }
    return { canonical, ...(await inspectArtifactRecovery(options, canonical)) };
  };

  return {
    async status(request) {
      return (await inspect(request)).status;
    },

    async apply(input) {
      if (!isSha256Digest(input.planDigest)) {
        throw new ArtifactRecoveryError("invalid_request", 400);
      }
      const current = await inspect(input.request);
      if (current.status.planDigest !== input.planDigest) {
        // Once this exact singleton exists, a duplicate delivery can observe
        // the already-advanced state after its sibling committed. Treat that
        // stale same-request plan as a read-only acknowledgement; never let it
        // apply the next action. Before authorization exists, a mismatched
        // plan remains a hard conflict.
        if (current.status.phase !== "eligible") return current.status;
        throw new ArtifactRecoveryError("state_conflict", 409);
      }
      switch (current.status.action) {
        case "prepare":
          if (!current.preparation) throw new ArtifactRecoveryError("state_conflict", 409);
          await options.coordinator.prepareExactArtifactRecovery(current.preparation);
          break;
        case "settle":
          if (!current.candidate) throw new ArtifactRecoveryError("state_conflict", 409);
          await options.coordinator.settleNextExactArtifactRecovery({
            canonical: current.canonical,
            candidate: current.candidate,
            execution: options.execution,
          });
          break;
        case "reconcile_absent":
          if (!current.candidate) throw new ArtifactRecoveryError("state_conflict", 409);
          await options.coordinator.reconcileAbsentExactArtifactRecovery({
            canonical: current.canonical,
            candidate: current.candidate,
            execution: options.execution,
          });
          break;
        case "rearm": {
          const authorization = options.execution.lostAck;
          if (
            !current.candidate ||
            current.observedEtag === undefined ||
            !authorization ||
            authorization.resolution.kind !== "reviewed-retry"
          ) {
            throw new ArtifactRecoveryError("state_conflict", 409);
          }
          await options.coordinator.rearmExactArtifactRecovery({
            canonical: current.canonical,
            candidate: current.candidate,
            execution: options.execution,
            observedEtag: current.observedEtag,
            authorization: {
              ...authorization,
              resolution: authorization.resolution,
            },
          });
          break;
        }
        case "complete":
          if (!current.resultSetDigest) throw new ArtifactRecoveryError("state_conflict", 409);
          await options.coordinator.completeExactArtifactRecovery({
            canonical: current.canonical,
            resultSetDigest: current.resultSetDigest,
            execution: options.execution,
          });
          break;
      }
      return (await inspect(input.request)).status;
    },
  };
}

export async function canonicalArtifactRecoveryRequest(
  value: unknown,
): Promise<CanonicalArtifactRecoveryRequest> {
  const input = record(value, "artifact recovery request");
  exactKeys(input, [
    "kind",
    "tenantId",
    "logicalTargetDigest",
    "owners",
    "ownerSetDigest",
    "uploads",
    "uploadSetDigest",
    "manifestDigest",
    "memberDigests",
    "memberSetDigest",
    "expectedHolds",
    "expectedReplays",
    "settlementEvidence",
    "lineage",
    "r2",
    "source",
    "retentionPolicy",
  ]);
  if (input.kind !== ARTIFACT_RECOVERY_REQUEST_FORMAT) {
    throw new TypeError(`artifact recovery kind must be ${ARTIFACT_RECOVERY_REQUEST_FORMAT}`);
  }
  if (input.tenantId !== INTEGRATION_E2E_ORGANIZATION_ID) {
    throw new TypeError("artifact recovery requires the exact integration E2E organization");
  }

  const ownersInput = array(input.owners, "owners");
  if (ownersInput.length !== EXACT_ARTIFACT_RECOVERY_OWNER_COUNT) {
    throw new TypeError(
      `artifact recovery requires exactly ${EXACT_ARTIFACT_RECOVERY_OWNER_COUNT} owners`,
    );
  }
  const owners: ArtifactRecoveryOwner[] = [];
  for (const entry of ownersInput) {
    const owner = record(entry, "artifact recovery owner");
    exactKeys(owner, ["principalId", "operationId"]);
    const operationId = boundedIdentifier(owner.operationId, "operationId", 8, 128);
    const principalId = boundedString(owner.principalId, "principalId", 1, 255);
    const expectedWriter = (await deterministicIntegrationE2eApiKeyIds(operationId)).writer;
    if (principalId !== `api-key:${expectedWriter}`) {
      throw new TypeError(
        "artifact recovery owner is not its deterministic integration E2E writer",
      );
    }
    owners.push({ principalId, operationId });
  }
  assertCanonicalObjects(owners, (entry) => entry.principalId, "owners");
  const ownerSetDigest = digest(input.ownerSetDigest, "ownerSetDigest");
  if ((await canonicalDigest(owners)) !== ownerSetDigest) {
    throw new TypeError("artifact recovery owner set digest does not match its exact owners");
  }

  const uploadsInput = array(input.uploads, "uploads");
  if (uploadsInput.length !== EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT) {
    throw new TypeError(
      `artifact recovery requires exactly ${EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT} uploads`,
    );
  }
  const ownerIds = new Set(owners.map(({ principalId }) => principalId));
  const uploads = uploadsInput.map((entry): ArtifactRecoveryUpload => {
    const upload = record(entry, "artifact recovery upload");
    exactKeys(upload, ["principalId", "uploadId", "uploadFence", "rootFence"]);
    const principalId = boundedString(upload.principalId, "upload principalId", 1, 255);
    if (!ownerIds.has(principalId)) {
      throw new TypeError("artifact recovery upload does not belong to an exact owner");
    }
    return {
      principalId,
      uploadId: boundedIdentifier(upload.uploadId, "uploadId", 3, 128),
      uploadFence: positiveInteger(upload.uploadFence, "uploadFence"),
      rootFence: positiveInteger(upload.rootFence, "rootFence"),
    };
  });
  assertCanonicalObjects(
    uploads,
    (entry) => `${entry.principalId}\u0000${entry.uploadId}`,
    "uploads",
  );
  for (const owner of owners) {
    if (!uploads.some(({ principalId }) => principalId === owner.principalId)) {
      throw new TypeError("artifact recovery owner has no exact upload");
    }
  }
  const uploadSetDigest = digest(input.uploadSetDigest, "uploadSetDigest");
  if ((await canonicalDigest(uploads)) !== uploadSetDigest) {
    throw new TypeError("artifact recovery upload set digest does not match its exact uploads");
  }

  const manifestDigest = digest(input.manifestDigest, "manifestDigest");
  const memberDigests = digestArray(input.memberDigests, "memberDigests");
  if (memberDigests.length !== EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT) {
    throw new TypeError(
      `artifact recovery requires exactly ${EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT} members`,
    );
  }
  assertCanonicalStrings(memberDigests, "memberDigests");
  const memberSetDigest = digest(input.memberSetDigest, "memberSetDigest");
  if ((await canonicalDigest(memberDigests)) !== memberSetDigest) {
    throw new TypeError("artifact recovery member set digest does not match its exact members");
  }
  const logicalTargetDigest = digest(input.logicalTargetDigest, "logicalTargetDigest");
  if (
    (await canonicalDigest({
      kind: "takoserver.exact-artifact-logical-target@v1",
      tenantId: input.tenantId,
      manifestDigest,
      memberSetDigest,
    })) !== logicalTargetDigest
  ) {
    throw new TypeError("artifact recovery logical target digest does not match its exact target");
  }

  const expectedHoldsInput = record(input.expectedHolds, "expectedHolds");
  exactKeys(expectedHoldsInput, ["entries", "count", "setDigest"]);
  const expectedHoldEntries = array(expectedHoldsInput.entries, "expectedHolds.entries").map(
    (entry) => {
      const hold = record(entry, "artifact recovery hold");
      exactKeys(hold, ["kind", "digest"]);
      if (hold.kind !== "manifest" && hold.kind !== "blob") {
        throw new TypeError("artifact recovery hold kind is invalid");
      }
      return { kind: hold.kind, digest: digest(hold.digest, "hold digest") };
    },
  );
  const canonicalHolds = [
    { kind: "manifest" as const, digest: manifestDigest },
    ...memberDigests.map((memberDigest) => ({ kind: "blob" as const, digest: memberDigest })),
  ];
  if (canonicalJson(expectedHoldEntries) !== canonicalJson(canonicalHolds)) {
    throw new TypeError("artifact recovery holds do not match the exact manifest/member set");
  }
  const expectedHoldCount = positiveInteger(expectedHoldsInput.count, "expectedHolds.count");
  if (expectedHoldCount !== EXACT_ARTIFACT_RECOVERY_HOLD_COUNT) {
    throw new TypeError("artifact recovery hold count does not match the exact set");
  }
  const expectedHoldSetDigest = digest(expectedHoldsInput.setDigest, "expectedHolds.setDigest");
  if ((await canonicalDigest(canonicalHolds)) !== expectedHoldSetDigest) {
    throw new TypeError("artifact recovery hold set digest does not match the exact set");
  }

  const expectedReplaysInput = record(input.expectedReplays, "expectedReplays");
  exactKeys(expectedReplaysInput, ["keys", "count", "setDigest"]);
  const replayKeys = array(expectedReplaysInput.keys, "expectedReplays.keys").map((entry) =>
    boundedReplayKey(entry),
  );
  if (replayKeys.length !== EXACT_ARTIFACT_RECOVERY_REPLAY_COUNT) {
    throw new TypeError(
      `artifact recovery requires exactly ${EXACT_ARTIFACT_RECOVERY_REPLAY_COUNT} replays`,
    );
  }
  assertCanonicalStrings(replayKeys, "expected replay keys");
  for (const replayKey of replayKeys) {
    const parts = replayKey.split("\u0000");
    if (parts.length < 3 || parts[0] !== input.tenantId || !ownerIds.has(parts[1] ?? "")) {
      throw new TypeError("artifact recovery replay key is outside the exact owner group");
    }
  }
  const replayCount = positiveInteger(expectedReplaysInput.count, "expectedReplays.count");
  if (replayCount !== EXACT_ARTIFACT_RECOVERY_REPLAY_COUNT) {
    throw new TypeError("artifact recovery replay count does not match the exact set");
  }
  const replaySetDigest = digest(expectedReplaysInput.setDigest, "expectedReplays.setDigest");
  if ((await canonicalDigest(replayKeys)) !== replaySetDigest) {
    throw new TypeError("artifact recovery replay set digest does not match its exact keys");
  }

  const settlementInput = record(input.settlementEvidence, "settlementEvidence");
  exactKeys(settlementInput, ["kind", "digest"]);
  const settlementEvidence = {
    kind: boundedString(settlementInput.kind, "settlementEvidence.kind", 3, 128),
    digest: digest(settlementInput.digest, "settlementEvidence.digest"),
  };

  const lineageInput = record(input.lineage, "lineage");
  exactKeys(lineageInput, ["migration", "digest"]);
  if (
    lineageInput.migration !== ARTIFACT_RECOVERY_LINEAGE_MIGRATION ||
    lineageInput.digest !== ARTIFACT_RECOVERY_LINEAGE_DIGEST
  ) {
    throw new TypeError("artifact recovery 0045 lineage is invalid");
  }

  const r2Input = record(input.r2, "r2");
  exactKeys(r2Input, ["accountId", "bucketName", "identityDigest"]);
  const accountId = boundedHex(r2Input.accountId, "R2 accountId", 32);
  const bucketName = boundedBucketName(r2Input.bucketName);
  const r2IdentityDigest = digest(r2Input.identityDigest, "R2 identityDigest");
  if (
    (await canonicalDigest({
      kind: "takoserver.r2-artifact-target@v1",
      accountId,
      bucketName,
    })) !== r2IdentityDigest
  ) {
    throw new TypeError("artifact recovery R2 identity digest does not match its target");
  }

  const sourceInput = record(input.source, "source");
  exactKeys(sourceInput, ["repository", "commit", "version"]);
  if (sourceInput.repository !== "takoserver") {
    throw new TypeError("artifact recovery source repository is invalid");
  }
  const sourceCommit = boundedHex(sourceInput.commit, "source commit", 40);
  const sourceVersion = boundedIdentifier(sourceInput.version, "source version", 1, 128);

  const retentionInput = record(input.retentionPolicy, "retentionPolicy");
  exactKeys(retentionInput, ["kind", "evidenceDigest", "detailRetentionMilliseconds"]);
  if (retentionInput.kind !== ARTIFACT_RECOVERY_RETENTION_FORMAT) {
    throw new TypeError("artifact recovery retention policy kind is invalid");
  }
  const detailRetentionMilliseconds = positiveInteger(
    retentionInput.detailRetentionMilliseconds,
    "retentionPolicy.detailRetentionMilliseconds",
  );
  if (detailRetentionMilliseconds < 3_600_000 || detailRetentionMilliseconds > 31_536_000_000) {
    throw new TypeError("artifact recovery retention policy duration is invalid");
  }

  const request: ArtifactRecoveryRequest = {
    kind: ARTIFACT_RECOVERY_REQUEST_FORMAT,
    tenantId: INTEGRATION_E2E_ORGANIZATION_ID,
    logicalTargetDigest,
    owners,
    ownerSetDigest,
    uploads,
    uploadSetDigest,
    manifestDigest,
    memberDigests,
    memberSetDigest,
    expectedHolds: {
      entries: canonicalHolds,
      count: expectedHoldCount,
      setDigest: expectedHoldSetDigest,
    },
    expectedReplays: { keys: replayKeys, count: replayCount, setDigest: replaySetDigest },
    settlementEvidence,
    lineage: {
      migration: ARTIFACT_RECOVERY_LINEAGE_MIGRATION,
      digest: ARTIFACT_RECOVERY_LINEAGE_DIGEST,
    },
    r2: { accountId, bucketName, identityDigest: r2IdentityDigest },
    source: {
      repository: "takoserver",
      commit: sourceCommit,
      version: sourceVersion,
    },
    retentionPolicy: {
      kind: ARTIFACT_RECOVERY_RETENTION_FORMAT,
      evidenceDigest: digest(retentionInput.evidenceDigest, "retentionPolicy.evidenceDigest"),
      detailRetentionMilliseconds,
    },
  };
  const requestDigest = await canonicalDigest(request);
  const receipts = await Promise.all(
    uploads.map(async ({ principalId, uploadId }) => ({
      receiptId: `recovery-receipt-${(
        await canonicalDigest({
          kind: "takoserver.exact-artifact-recovery-upload-receipt@v2",
          requestDigest,
          tenantId: request.tenantId,
          principalId,
          uploadId,
        })
      ).slice("sha256:".length)}`,
      principalId,
      uploadId,
    })),
  );
  return { request, canonicalJson: canonicalJson(request), requestDigest, receipts };
}

function assertExecutionBinding(
  canonical: CanonicalArtifactRecoveryRequest,
  execution: ArtifactRecoveryExecution,
): void {
  const request = canonical.request;
  if (
    execution.pinnedRequestDigest !== canonical.requestDigest ||
    execution.r2IdentityDigest !== request.r2.identityDigest ||
    execution.sourceCommit !== request.source.commit ||
    execution.sourceVersion !== request.source.version ||
    !workerVersionId(execution.workerVersionId)
  ) {
    throw new TypeError("artifact recovery Worker Version binding is invalid");
  }
  const lostAck = execution.lostAck;
  if (!lostAck) return;
  if (
    lostAck.kind !== ARTIFACT_RECOVERY_LOST_ACK_FORMAT ||
    !Number.isSafeInteger(lostAck.candidateOrdinal) ||
    lostAck.candidateOrdinal < 0 ||
    lostAck.candidateOrdinal >= EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT ||
    !workerVersionId(lostAck.predecessorWorkerVersionId) ||
    lostAck.predecessorWorkerVersionId === execution.workerVersionId ||
    !isSha256Digest(lostAck.quiescenceEvidenceDigest)
  ) {
    throw new TypeError("artifact recovery lost-ack binding is invalid");
  }
  if (lostAck.resolution.kind === "confirm-head-absent") return;
  if (
    lostAck.resolution.kind !== "reviewed-retry" ||
    lostAck.resolution.observedEtag.length < 1 ||
    lostAck.resolution.observedEtag.length > 512 ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(lostAck.resolution.operationId) ||
    !Number.isSafeInteger(lostAck.resolution.candidateFence) ||
    lostAck.resolution.candidateFence < 2 ||
    !isSha256Digest(lostAck.resolution.reviewEvidenceDigest)
  ) {
    throw new TypeError("artifact recovery reviewed retry binding is invalid");
  }
}

async function inspectArtifactRecovery(
  options: CreateArtifactRecoveryOptions,
  canonical: CanonicalArtifactRecoveryRequest,
): Promise<RecoveryInspectionResult> {
  const singletonRows = await options.sql.query(
    `SELECT request_digest, evidence_digest, tenant_id, logical_target_digest,
            manifest_digest, owner_set_digest, upload_set_digest,
            member_set_digest, replay_set_digest, hold_set_digest,
            expected_owner_count, expected_upload_count, expected_replay_count,
            expected_member_count, expected_hold_count,
            settlement_evidence_kind, settlement_evidence_digest,
            lineage_migration, lineage_digest, r2_identity_digest,
            source_commit, source_version, preparing_worker_version_id,
            active_worker_version_id, execution_handoff_count,
            retention_policy_kind, retention_policy_digest,
            detail_retention_milliseconds, phase, prepared_at, completed_at,
            result_set_digest, purge_after, detail_state
     FROM tf_artifact_recovery_once WHERE singleton = 1`,
  );
  if (singletonRows.length > 1) {
    return {
      status: await blockedStatus(canonical, options.execution, "durable_authorization_ambiguous"),
    };
  }
  const singleton = singletonRows[0] ? singletonRow(singletonRows[0]) : null;
  if (singleton && !singletonMatchesRequest(singleton, canonical)) {
    return {
      status: await blockedStatus(
        canonical,
        options.execution,
        "authorization_consumed_by_other_request",
      ),
    };
  }
  if (singleton?.phase === "complete" && singleton.detailState === "purged") {
    return {
      status: await statusValue(canonical, options.execution, {
        phase: "complete",
        action: "none",
        receiptCount: 0,
        candidates: emptyCandidateCounts(),
        quarantineNotBefore: null,
        nextCandidate: null,
        metadataPresent: false,
        presentBlobs: 0,
        absentBlobs: EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT,
        detailState: "purged",
        purgeAfter: singleton.purgeAfter,
      }),
    };
  }

  const closures = await exactCredentialClosures(options.sql, canonical.request);
  if (!closures || closures.some(({ closedAt }) => closedAt > options.clock().getTime())) {
    return {
      status: await blockedStatus(canonical, options.execution, "credential_closure_incomplete"),
    };
  }
  const evidenceDigest = await canonicalDigest({
    kind: "takoserver.exact-artifact-recovery-evidence@v2",
    credentialClosures: closures,
    settlementEvidence: canonical.request.settlementEvidence,
    lineage: canonical.request.lineage,
  });

  if (!singleton) {
    const initial = await inspectInitialState(options, canonical, closures);
    if (initial.blocker) {
      return {
        status: await blockedStatus(canonical, options.execution, initial.blocker, {
          metadataPresent: initial.metadataPresent,
          presentBlobs: initial.presentBlobs,
        }),
      };
    }
    return {
      status: await statusValue(
        canonical,
        options.execution,
        {
          phase: "eligible",
          action: "prepare",
          receiptCount: 0,
          candidates: emptyCandidateCounts(),
          quarantineNotBefore: null,
          nextCandidate: null,
          metadataPresent: true,
          presentBlobs: EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT,
          absentBlobs: 0,
          detailState: "unprepared",
          purgeAfter: null,
        },
        { evidenceDigest, candidateEtags: initial.candidateEtags },
      ),
      preparation: {
        canonical,
        evidenceDigest,
        owners: closures,
        candidateEtags: initial.candidateEtags,
        execution: options.execution,
      },
    };
  }

  if (singleton.evidenceDigest !== evidenceDigest) {
    return {
      status: await blockedStatus(canonical, options.execution, "durable_evidence_mismatch"),
    };
  }
  if (!executionMayContinue(singleton, options.execution)) {
    return {
      status: await blockedStatus(canonical, options.execution, "recovery_version_not_authorized"),
    };
  }
  return await inspectPreparedState(options, canonical, singleton);
}

async function inspectInitialState(
  options: CreateArtifactRecoveryOptions,
  canonical: CanonicalArtifactRecoveryRequest,
  closures: readonly CredentialClosure[],
): Promise<{
  readonly blocker?: string;
  readonly metadataPresent: boolean;
  readonly presentBlobs: number;
  readonly candidateEtags: readonly string[];
}> {
  const { request } = canonical;
  const closuresByPrincipal = new Map(closures.map((closure) => [closure.principalId, closure]));
  let uploadManifestJson: string | null = null;
  for (const upload of request.uploads) {
    const [uploadRows, rootRows] = await Promise.all([
      options.sql.query(
        `SELECT tenant_id, principal_id, manifest_json, manifest_digest,
                lifecycle_state, lifecycle_fence, created_at
         FROM tf_artifact_uploads WHERE id = ?`,
        [upload.uploadId],
      ),
      options.sql.query(
        `SELECT state, fence FROM tf_artifact_roots
         WHERE tenant_id = ? AND root_kind = 'upload' AND root_id = ?
           AND target_kind = 'manifest' AND digest = ?`,
        [request.tenantId, upload.uploadId, request.manifestDigest],
      ),
    ]);
    const row = uploadRows[0];
    const closure = closuresByPrincipal.get(upload.principalId);
    const createdAt = integerValue(row?.created_at);
    const writerCreatedAt = closure ? isoTimestamp(closure.writerToken.createdAt) : null;
    const writerRevokedAt = closure ? isoTimestamp(closure.writerToken.revokedAt) : null;
    if (
      uploadRows.length !== 1 ||
      rootRows.length !== 1 ||
      !closure ||
      createdAt === null ||
      writerCreatedAt === null ||
      writerRevokedAt === null ||
      createdAt < writerCreatedAt ||
      createdAt > writerRevokedAt ||
      createdAt > closure.closedAt ||
      row?.tenant_id !== request.tenantId ||
      row?.principal_id !== upload.principalId ||
      row?.manifest_digest !== request.manifestDigest ||
      row?.lifecycle_state !== "committed" ||
      row?.lifecycle_fence !== upload.uploadFence ||
      typeof row?.manifest_json !== "string" ||
      rootRows[0]?.state !== "active" ||
      rootRows[0]?.fence !== upload.rootFence
    ) {
      return emptyInitial("upload_group_mismatch");
    }
    if (uploadManifestJson !== null && uploadManifestJson !== row.manifest_json) {
      return emptyInitial("upload_group_mismatch");
    }
    uploadManifestJson = row.manifest_json;
    if (!(await manifestMatchesRequest(row.manifest_json, request))) {
      return emptyInitial("manifest_identity_mismatch");
    }
  }

  const metadataRows = await options.sql.query(
    "SELECT manifest_json FROM tf_artifact_manifests WHERE digest = ?",
    [request.manifestDigest],
  );
  if (
    metadataRows.length !== 1 ||
    typeof metadataRows[0]?.manifest_json !== "string" ||
    metadataRows[0].manifest_json !== uploadManifestJson ||
    !(await manifestMatchesRequest(metadataRows[0].manifest_json, request)) ||
    !(await exactMemberRows(options.sql, request))
  ) {
    return emptyInitial("manifest_identity_mismatch");
  }

  const targetJson = JSON.stringify(request.memberDigests);
  const uploadJson = JSON.stringify(
    request.uploads.map(({ principalId, uploadId }) => ({ principalId, uploadId })),
  );
  const [uncertainties, receipts, candidates, leases, holds, replays, roots] = await Promise.all([
    options.sql.query(
      "SELECT 1 AS present FROM tf_artifact_consumer_uncertainties WHERE tenant_id = ? AND state = 'active' LIMIT 1",
      [request.tenantId],
    ),
    options.sql.query(
      `SELECT 1 AS present FROM tf_artifact_owner_closure_receipts AS receipt
       WHERE receipt.receipt_kind = 'exact_failed_run_recovery'
          OR (receipt.tenant_id = ? AND EXISTS (
            SELECT 1 FROM json_each(?) AS expected
            WHERE receipt.principal_id = json_extract(expected.value, '$.principalId')
              AND receipt.upload_id = json_extract(expected.value, '$.uploadId')
              AND receipt.manifest_digest = ?
          )) LIMIT 1`,
      [request.tenantId, uploadJson, request.manifestDigest],
    ),
    targetGcCandidates(options.sql, request),
    options.sql.query(
      `SELECT 1 AS present FROM tf_artifact_blob_io_leases
       WHERE digest IN (SELECT CAST(value AS TEXT) FROM json_each(?))
         AND state <> 'available' LIMIT 1`,
      [targetJson],
    ),
    targetHolds(options.sql, request),
    targetReplayRows(options.sql, request),
    relevantActiveRoots(options.sql, request),
  ]);
  if (uncertainties.length > 0) return emptyInitial("consumer_uncertainty_active", true);
  if (receipts.length > 0 || candidates.length > 0 || leases.length > 0) {
    return emptyInitial("recovery_state_already_present", true);
  }
  if (canonicalJson(holds) !== canonicalJson(request.expectedHolds.entries)) {
    return emptyInitial("hold_set_mismatch", true);
  }
  if (!exactReplayRows(replays, request) || !exactInitialRoots(roots, request)) {
    return emptyInitial("root_or_replay_set_mismatch", true);
  }

  const candidateEtags: string[] = [];
  let presentBlobs = 0;
  for (const memberDigest of request.memberDigests) {
    const stored = await options.objects.head(blobKey(memberDigest));
    if (!stored || stored.etag.length < 1 || stored.etag.length > 512) continue;
    presentBlobs += 1;
    candidateEtags.push(stored.etag);
  }
  if (presentBlobs !== EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT) {
    return {
      blocker: "object_set_incomplete",
      metadataPresent: true,
      presentBlobs,
      candidateEtags: [],
    };
  }
  return { metadataPresent: true, presentBlobs, candidateEtags };
}

function emptyInitial(
  blocker: string,
  metadataPresent = false,
): {
  readonly blocker: string;
  readonly metadataPresent: boolean;
  readonly presentBlobs: number;
  readonly candidateEtags: readonly string[];
} {
  return { blocker, metadataPresent, presentBlobs: 0, candidateEtags: [] };
}

async function inspectPreparedState(
  options: CreateArtifactRecoveryOptions,
  canonical: CanonicalArtifactRecoveryRequest,
  singleton: SingletonRow,
): Promise<RecoveryInspectionResult> {
  const { request } = canonical;
  if (singleton.phase === "revoked") {
    return {
      status: await statusValue(canonical, options.execution, {
        phase: "revoked",
        action: "none",
        receiptCount: 0,
        candidates: emptyCandidateCounts(),
        quarantineNotBefore: null,
        nextCandidate: null,
        metadataPresent: false,
        presentBlobs: 0,
        absentBlobs: 0,
        detailState: singleton.detailState,
        purgeAfter: null,
      }),
    };
  }
  const activeExecution = options.execution.workerVersionId === singleton.activeWorkerVersionId;
  if (singleton.phase === "complete" && !activeExecution) {
    return {
      status: await blockedStatus(canonical, options.execution, "recovery_version_not_authorized", {
        detailState: singleton.detailState,
        purgeAfter: singleton.purgeAfter,
      }),
    };
  }

  const detailRows = await options.sql.query(
    `SELECT request_json, prepared_worker_version_id, purge_after
     FROM tf_artifact_recovery_details WHERE request_digest = ?`,
    [canonical.requestDigest],
  );
  if (
    detailRows.length !== 1 ||
    detailRows[0]?.request_json !== canonical.canonicalJson ||
    detailRows[0]?.prepared_worker_version_id !== singleton.preparingWorkerVersionId ||
    (singleton.phase === "complete" && detailRows[0]?.purge_after !== singleton.purgeAfter) ||
    (singleton.phase !== "complete" && detailRows[0]?.purge_after !== null)
  ) {
    return { status: await blockedStatus(canonical, options.execution, "durable_detail_mismatch") };
  }

  const receiptRows = await options.sql.query(
    `SELECT receipt_id, principal_id, upload_id, manifest_digest, upload_fence,
            root_fence, receipt_kind, recovery_request_digest, state, purge_after
     FROM tf_artifact_owner_closure_receipts
     WHERE recovery_request_digest = ? AND receipt_kind = 'exact_failed_run_recovery'
     ORDER BY principal_id, upload_id`,
    [canonical.requestDigest],
  );
  if (!exactRecoveryReceipts(receiptRows, canonical, singleton)) {
    return {
      status: await blockedStatus(canonical, options.execution, "recovery_receipt_mismatch"),
    };
  }

  const [
    uncertainties,
    roots,
    holds,
    replays,
    replayRoots,
    candidateRows,
    executionHandoffs,
    metadataRows,
  ] = await Promise.all([
    options.sql.query(
      "SELECT 1 AS present FROM tf_artifact_consumer_uncertainties WHERE tenant_id = ? AND state = 'active' LIMIT 1",
      [request.tenantId],
    ),
    relevantActiveRoots(options.sql, request),
    targetHolds(options.sql, request),
    targetReplayRows(options.sql, request),
    options.sql.query(
      `SELECT root_id, state, fence, release_reason
         FROM tf_artifact_roots
         WHERE tenant_id = ? AND root_kind = 'replay' AND target_kind = 'manifest'
           AND digest = ? AND root_id IN
             (SELECT CAST(value AS TEXT) FROM json_each(?))
         ORDER BY root_id`,
      [request.tenantId, request.manifestDigest, JSON.stringify(request.expectedReplays.keys)],
    ),
    readRecoveryCandidates(options.sql, canonical),
    readRecoveryExecutionHandoffs(options.sql, canonical.requestDigest),
    options.sql.query("SELECT manifest_json FROM tf_artifact_manifests WHERE digest = ?", [
      request.manifestDigest,
    ]),
  ]);
  const executionLineageDigest = await validateExactArtifactRecoveryExecutionLineage({
    requestDigest: canonical.requestDigest,
    preparingWorkerVersionId: singleton.preparingWorkerVersionId,
    activeWorkerVersionId: singleton.activeWorkerVersionId,
    expectedHandoffCount: singleton.executionHandoffCount,
    preparedAt: singleton.preparedAt,
    expectedPurgeAfter: singleton.phase === "complete" ? singleton.purgeAfter : null,
    handoffs: executionHandoffs,
  });
  if (
    uncertainties.length > 0 ||
    roots.length > 0 ||
    holds.length > 0 ||
    replays.length > 0 ||
    !exactReleasedReplayRoots(replayRoots, request) ||
    !exactRecoveryCandidateSet(candidateRows, request, singleton.preparedAt) ||
    executionLineageDigest === null
  ) {
    return { status: await blockedStatus(canonical, options.execution, "prepared_group_mismatch") };
  }
  if (!(await exactMemberRows(options.sql, request))) {
    return {
      status: await blockedStatus(canonical, options.execution, "manifest_identity_mismatch"),
    };
  }

  const presence = await blobPresence(options.objects, request.memberDigests);
  const counts = candidateCounts(candidateRows);
  const presentBlobs = [...presence.values()].filter(Boolean).length;
  const metadataPresent = metadataRows.length === 1;
  if (metadataRows.length > 1) {
    return {
      status: await blockedStatus(canonical, options.execution, "manifest_identity_mismatch"),
    };
  }
  for (const candidate of candidateRows) {
    if (
      candidate.kind === "blob" &&
      candidate.detailState === "deleted" &&
      presence.get(candidate.digest)
    ) {
      return {
        status: await blockedStatus(canonical, options.execution, "deleted_object_reappeared", {
          candidates: counts,
          metadataPresent,
          presentBlobs,
          receiptCount: receiptRows.length,
          detailState: singleton.detailState,
          purgeAfter: singleton.purgeAfter,
        }),
      };
    }
  }

  const terminal = candidateRows.every((candidate) =>
    candidate.kind === "blob"
      ? candidate.detailState === "deleted"
      : candidate.detailState === "metadata_deleted",
  );
  const resultSetDigest = terminal
    ? await recoveryResultSetDigest(
        canonical.requestDigest,
        candidateRows,
        executionLineageDigest as Digest,
      )
    : null;
  if (singleton.phase === "complete") {
    if (
      !terminal ||
      metadataPresent ||
      presentBlobs !== 0 ||
      resultSetDigest !== singleton.resultSetDigest ||
      singleton.purgeAfter === null
    ) {
      return {
        status: await blockedStatus(canonical, options.execution, "terminal_receipt_mismatch", {
          candidates: counts,
          metadataPresent,
          presentBlobs,
          receiptCount: receiptRows.length,
          detailState: singleton.detailState,
          purgeAfter: singleton.purgeAfter,
        }),
      };
    }
    return {
      status: await statusValue(
        canonical,
        options.execution,
        {
          phase: "complete",
          action: "none",
          receiptCount: receiptRows.length,
          candidates: counts,
          quarantineNotBefore: null,
          nextCandidate: null,
          metadataPresent: false,
          presentBlobs: 0,
          absentBlobs: EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT,
          detailState: singleton.detailState,
          purgeAfter: singleton.purgeAfter,
        },
        { resultSetDigest },
      ),
    };
  }

  if (terminal) {
    if (!activeExecution) {
      return {
        status: await blockedStatus(
          canonical,
          options.execution,
          "recovery_version_not_authorized",
          {
            candidates: counts,
            metadataPresent,
            presentBlobs,
            receiptCount: receiptRows.length,
            detailState: singleton.detailState,
          },
        ),
      };
    }
    if (metadataPresent || presentBlobs !== 0 || !resultSetDigest) {
      return {
        status: await blockedStatus(canonical, options.execution, "absence_readback_incomplete", {
          candidates: counts,
          metadataPresent,
          presentBlobs,
          receiptCount: receiptRows.length,
          detailState: singleton.detailState,
        }),
      };
    }
    return {
      status: await statusValue(
        canonical,
        options.execution,
        {
          phase: singleton.phase,
          action: "complete",
          receiptCount: receiptRows.length,
          candidates: counts,
          quarantineNotBefore: null,
          nextCandidate: null,
          metadataPresent: false,
          presentBlobs: 0,
          absentBlobs: EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT,
          detailState: singleton.detailState,
          purgeAfter: null,
        },
        { resultSetDigest },
      ),
      resultSetDigest,
    };
  }

  const next = candidateRows.find((candidate) =>
    candidate.kind === "blob"
      ? candidate.detailState !== "deleted"
      : candidate.detailState !== "metadata_deleted",
  );
  if (!next) {
    return { status: await blockedStatus(canonical, options.execution, "prepared_group_mismatch") };
  }
  if (next.kind === "manifest") {
    if (!activeExecution) {
      return {
        status: await blockedStatus(
          canonical,
          options.execution,
          "recovery_version_not_authorized",
          {
            candidates: counts,
            metadataPresent,
            presentBlobs,
            receiptCount: receiptRows.length,
            detailState: singleton.detailState,
          },
        ),
      };
    }
    if (
      candidateRows.some(
        (candidate) => candidate.kind === "blob" && candidate.detailState !== "deleted",
      )
    ) {
      return {
        status: await blockedStatus(canonical, options.execution, "manifest_precedes_member"),
      };
    }
    if (!metadataPresent) {
      return {
        status: await blockedStatus(canonical, options.execution, "manifest_metadata_missing"),
      };
    }
    return actionableCandidateStatus(options, canonical, singleton, next, counts, {
      metadataPresent,
      presentBlobs,
      action: "settle",
    });
  }

  const head = await options.objects.head(blobKey(next.digest));
  if (next.detailState === "delete_started") {
    return await inspectIndeterminateDelete(
      options,
      canonical,
      singleton,
      next,
      counts,
      metadataPresent,
      presentBlobs,
      head?.etag ?? null,
    );
  }
  if (next.detailState !== "pending") {
    return { status: await blockedStatus(canonical, options.execution, "prepared_group_mismatch") };
  }
  if (head && head.etag !== next.activeEtag) {
    return await inspectReviewedRearm(
      options,
      canonical,
      singleton,
      next,
      counts,
      metadataPresent,
      presentBlobs,
      head.etag,
      "etag_drift_requires_review",
    );
  }
  if (!activeExecution) {
    return {
      status: await blockedStatus(canonical, options.execution, "recovery_version_not_authorized", {
        candidates: counts,
        metadataPresent,
        presentBlobs,
        receiptCount: receiptRows.length,
        detailState: singleton.detailState,
      }),
    };
  }
  return actionableCandidateStatus(options, canonical, singleton, next, counts, {
    metadataPresent,
    presentBlobs,
    action: next.notBefore <= options.clock().getTime() ? "settle" : "wait",
  });
}

async function inspectIndeterminateDelete(
  options: CreateArtifactRecoveryOptions,
  canonical: CanonicalArtifactRecoveryRequest,
  singleton: SingletonRow,
  candidate: RecoveryCandidateRow,
  counts: ArtifactRecoveryStatus["candidates"],
  metadataPresent: boolean,
  presentBlobs: number,
  headEtag: string | null,
): Promise<RecoveryInspectionResult> {
  const authorization = options.execution.lostAck;
  if (
    !authorization ||
    authorization.candidateOrdinal !== candidate.ordinal ||
    authorization.predecessorWorkerVersionId !== candidate.executionWorkerVersionId ||
    options.execution.workerVersionId === candidate.executionWorkerVersionId
  ) {
    return {
      status: await blockedStatus(canonical, options.execution, "recovery_version_not_retired", {
        candidates: counts,
        metadataPresent,
        presentBlobs,
        receiptCount: EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT,
        detailState: singleton.detailState,
      }),
    };
  }
  if (headEtag === null) {
    if (authorization.resolution.kind !== "confirm-head-absent") {
      return {
        status: await blockedStatus(canonical, options.execution, "lost_ack_resolution_mismatch", {
          candidates: counts,
          metadataPresent,
          presentBlobs,
          receiptCount: EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT,
          detailState: singleton.detailState,
        }),
      };
    }
    return actionableCandidateStatus(options, canonical, singleton, candidate, counts, {
      metadataPresent,
      presentBlobs,
      action: "reconcile_absent",
      extraPlan: { quiescenceEvidenceDigest: authorization.quiescenceEvidenceDigest },
    });
  }
  return await inspectReviewedRearm(
    options,
    canonical,
    singleton,
    candidate,
    counts,
    metadataPresent,
    presentBlobs,
    headEtag,
    "lost_ack_present_requires_review",
  );
}

async function inspectReviewedRearm(
  options: CreateArtifactRecoveryOptions,
  canonical: CanonicalArtifactRecoveryRequest,
  singleton: SingletonRow,
  candidate: RecoveryCandidateRow,
  counts: ArtifactRecoveryStatus["candidates"],
  metadataPresent: boolean,
  presentBlobs: number,
  observedEtag: string,
  missingBlocker: string,
): Promise<RecoveryInspectionResult> {
  const authorization = options.execution.lostAck;
  if (
    !authorization ||
    authorization.candidateOrdinal !== candidate.ordinal ||
    authorization.resolution.kind !== "reviewed-retry" ||
    authorization.resolution.candidateFence !== candidate.fence + 2 ||
    authorization.resolution.observedEtag !== observedEtag ||
    (candidate.detailState === "delete_started" &&
      authorization.predecessorWorkerVersionId !== candidate.executionWorkerVersionId) ||
    (candidate.detailState === "pending" &&
      authorization.predecessorWorkerVersionId !== singleton.activeWorkerVersionId)
  ) {
    const blocker =
      authorization?.resolution.kind === "reviewed-retry" &&
      authorization.candidateOrdinal === candidate.ordinal &&
      authorization.resolution.observedEtag !== observedEtag
        ? "reviewed_etag_drift"
        : missingBlocker;
    return {
      status: await blockedStatus(canonical, options.execution, blocker, {
        candidates: counts,
        metadataPresent,
        presentBlobs,
        receiptCount: EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT,
        detailState: singleton.detailState,
      }),
    };
  }
  const result = await actionableCandidateStatus(options, canonical, singleton, candidate, counts, {
    metadataPresent,
    presentBlobs,
    action: "rearm",
    extraPlan: {
      observedEtag,
      reviewedOperationId: authorization.resolution.operationId,
      reviewedCandidateFence: authorization.resolution.candidateFence,
      reviewEvidenceDigest: authorization.resolution.reviewEvidenceDigest,
      quiescenceEvidenceDigest: authorization.quiescenceEvidenceDigest,
    },
  });
  return { ...result, observedEtag };
}

async function actionableCandidateStatus(
  options: CreateArtifactRecoveryOptions,
  canonical: CanonicalArtifactRecoveryRequest,
  singleton: SingletonRow,
  candidate: RecoveryCandidateRow,
  counts: ArtifactRecoveryStatus["candidates"],
  state: {
    readonly metadataPresent: boolean;
    readonly presentBlobs: number;
    readonly action: "wait" | "settle" | "reconcile_absent" | "rearm";
    readonly extraPlan?: unknown;
  },
): Promise<RecoveryInspectionResult> {
  const publicCandidate: NonNullable<ArtifactRecoveryStatus["nextCandidate"]> = {
    ordinal: candidate.ordinal,
    kind: candidate.kind,
    state: candidate.detailState === "delete_started" ? "delete_started" : "pending",
    fence: candidate.fence,
    notBefore: candidate.notBefore,
  };
  const internalCandidate: ExactArtifactRecoveryCandidate = {
    ...publicCandidate,
    digest: candidate.digest,
    activeEtag: candidate.activeEtag,
    deleteOperationId: candidate.deleteOperationId,
    deleteLeaseFence: candidate.deleteLeaseFence,
    executionWorkerVersionId: candidate.executionWorkerVersionId,
  };
  return {
    status: await statusValue(
      canonical,
      options.execution,
      {
        phase: singleton.phase,
        action: state.action,
        receiptCount: EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT,
        candidates: counts,
        quarantineNotBefore: state.action === "wait" ? candidate.notBefore : null,
        nextCandidate: publicCandidate,
        metadataPresent: state.metadataPresent,
        presentBlobs: state.presentBlobs,
        absentBlobs: EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT - state.presentBlobs,
        detailState: singleton.detailState,
        purgeAfter: null,
      },
      {
        candidate: internalCandidate,
        observedEtag: candidate.kind === "blob" ? candidate.activeEtag : null,
        extraPlan: state.extraPlan ?? null,
      },
    ),
    candidate: internalCandidate,
  };
}

type StatusDraft = Omit<ArtifactRecoveryStatus, "kind" | "requestDigest" | "planDigest">;

async function statusValue(
  canonical: CanonicalArtifactRecoveryRequest,
  execution: ArtifactRecoveryExecution,
  draft: StatusDraft,
  privatePlanState: unknown = null,
): Promise<ArtifactRecoveryStatus> {
  const planDigest = await canonicalDigest({
    kind: ARTIFACT_RECOVERY_PLAN_FORMAT,
    requestDigest: canonical.requestDigest,
    workerVersionId: execution.workerVersionId,
    lostAck: execution.lostAck ?? null,
    phase: draft.phase,
    action: draft.action,
    blocker: draft.blocker ?? null,
    receiptCount: draft.receiptCount,
    candidates: draft.candidates,
    quarantineNotBefore: draft.quarantineNotBefore,
    nextCandidate: draft.nextCandidate,
    metadataPresent: draft.metadataPresent,
    presentBlobs: draft.presentBlobs,
    absentBlobs: draft.absentBlobs,
    detailState: draft.detailState,
    purgeAfter: draft.purgeAfter,
    privatePlanState,
  });
  return {
    kind: ARTIFACT_RECOVERY_STATUS_FORMAT,
    requestDigest: canonical.requestDigest,
    ...draft,
    planDigest,
  };
}

async function blockedStatus(
  canonical: CanonicalArtifactRecoveryRequest,
  execution: ArtifactRecoveryExecution,
  blocker: string,
  state: {
    readonly metadataPresent?: boolean;
    readonly presentBlobs?: number;
    readonly candidates?: ArtifactRecoveryStatus["candidates"];
    readonly receiptCount?: number;
    readonly detailState?: ArtifactRecoveryStatus["detailState"];
    readonly purgeAfter?: number | null;
  } = {},
): Promise<ArtifactRecoveryStatus> {
  const presentBlobs = state.presentBlobs ?? 0;
  return await statusValue(canonical, execution, {
    phase: "blocked",
    action: "none",
    blocker,
    receiptCount: state.receiptCount ?? 0,
    candidates: state.candidates ?? emptyCandidateCounts(),
    quarantineNotBefore: null,
    nextCandidate: null,
    metadataPresent: state.metadataPresent ?? false,
    presentBlobs,
    absentBlobs: EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT - presentBlobs,
    detailState: state.detailState ?? "unprepared",
    purgeAfter: state.purgeAfter ?? null,
  });
}

function emptyCandidateCounts(): ArtifactRecoveryStatus["candidates"] {
  return { pending: 0, deleteStarted: 0, deleted: 0, metadataDeleted: 0 };
}

function candidateCounts(
  candidates: readonly RecoveryCandidateRow[],
): ArtifactRecoveryStatus["candidates"] {
  const counts = { pending: 0, deleteStarted: 0, deleted: 0, metadataDeleted: 0 };
  for (const candidate of candidates) {
    switch (candidate.detailState) {
      case "pending":
        counts.pending += 1;
        break;
      case "delete_started":
        counts.deleteStarted += 1;
        break;
      case "deleted":
        counts.deleted += 1;
        break;
      case "metadata_deleted":
        counts.metadataDeleted += 1;
        break;
    }
  }
  return counts;
}

function singletonMatchesRequest(
  singleton: SingletonRow,
  canonical: CanonicalArtifactRecoveryRequest,
): boolean {
  const request = canonical.request;
  return (
    singleton.requestDigest === canonical.requestDigest &&
    singleton.tenantId === request.tenantId &&
    singleton.logicalTargetDigest === request.logicalTargetDigest &&
    singleton.manifestDigest === request.manifestDigest &&
    singleton.ownerSetDigest === request.ownerSetDigest &&
    singleton.uploadSetDigest === request.uploadSetDigest &&
    singleton.memberSetDigest === request.memberSetDigest &&
    singleton.replaySetDigest === request.expectedReplays.setDigest &&
    singleton.holdSetDigest === request.expectedHolds.setDigest &&
    singleton.expectedOwnerCount === EXACT_ARTIFACT_RECOVERY_OWNER_COUNT &&
    singleton.expectedUploadCount === EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT &&
    singleton.expectedReplayCount === EXACT_ARTIFACT_RECOVERY_REPLAY_COUNT &&
    singleton.expectedMemberCount === EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT &&
    singleton.expectedHoldCount === EXACT_ARTIFACT_RECOVERY_HOLD_COUNT &&
    singleton.settlementEvidenceKind === request.settlementEvidence.kind &&
    singleton.settlementEvidenceDigest === request.settlementEvidence.digest &&
    singleton.lineageMigration === request.lineage.migration &&
    singleton.lineageDigest === request.lineage.digest &&
    singleton.r2IdentityDigest === request.r2.identityDigest &&
    singleton.sourceCommit === request.source.commit &&
    singleton.sourceVersion === request.source.version &&
    singleton.retentionPolicyKind === request.retentionPolicy.kind &&
    singleton.retentionPolicyDigest === request.retentionPolicy.evidenceDigest &&
    singleton.detailRetentionMilliseconds === request.retentionPolicy.detailRetentionMilliseconds
  );
}

function executionMayContinue(
  singleton: SingletonRow,
  execution: ArtifactRecoveryExecution,
): boolean {
  if (singleton.activeWorkerVersionId === execution.workerVersionId) return true;
  return execution.lostAck?.predecessorWorkerVersionId === singleton.activeWorkerVersionId;
}

function singletonRow(row: Row): SingletonRow {
  const phase = stringColumn(row, "phase");
  if (phase !== "prepared" && phase !== "settling" && phase !== "complete" && phase !== "revoked") {
    throw new Error("artifact recovery durable phase is invalid");
  }
  const detailState = stringColumn(row, "detail_state");
  if (detailState !== "active" && detailState !== "purging" && detailState !== "purged") {
    throw new Error("artifact recovery durable detail state is invalid");
  }
  return {
    requestDigest: digestValue(row.request_digest),
    evidenceDigest: digestValue(row.evidence_digest),
    tenantId: stringColumn(row, "tenant_id"),
    logicalTargetDigest: digestValue(row.logical_target_digest),
    manifestDigest: digestValue(row.manifest_digest),
    ownerSetDigest: digestValue(row.owner_set_digest),
    uploadSetDigest: digestValue(row.upload_set_digest),
    memberSetDigest: digestValue(row.member_set_digest),
    replaySetDigest: digestValue(row.replay_set_digest),
    holdSetDigest: digestValue(row.hold_set_digest),
    expectedOwnerCount: requiredInteger(row.expected_owner_count, "expected owner count"),
    expectedUploadCount: requiredInteger(row.expected_upload_count, "expected upload count"),
    expectedReplayCount: requiredInteger(row.expected_replay_count, "expected replay count"),
    expectedMemberCount: requiredInteger(row.expected_member_count, "expected member count"),
    expectedHoldCount: requiredInteger(row.expected_hold_count, "expected hold count"),
    settlementEvidenceKind: stringColumn(row, "settlement_evidence_kind"),
    settlementEvidenceDigest: digestValue(row.settlement_evidence_digest),
    lineageMigration: stringColumn(row, "lineage_migration"),
    lineageDigest: digestValue(row.lineage_digest),
    r2IdentityDigest: digestValue(row.r2_identity_digest),
    sourceCommit: stringColumn(row, "source_commit"),
    sourceVersion: stringColumn(row, "source_version"),
    preparingWorkerVersionId: stringColumn(row, "preparing_worker_version_id"),
    activeWorkerVersionId: stringColumn(row, "active_worker_version_id"),
    executionHandoffCount: requiredInteger(row.execution_handoff_count, "execution handoff count"),
    retentionPolicyKind: stringColumn(row, "retention_policy_kind"),
    retentionPolicyDigest: digestValue(row.retention_policy_digest),
    detailRetentionMilliseconds: requiredInteger(
      row.detail_retention_milliseconds,
      "detail retention milliseconds",
    ),
    phase,
    preparedAt: requiredInteger(row.prepared_at, "prepared at"),
    completedAt: nullableInteger(row.completed_at, "completed at"),
    resultSetDigest: row.result_set_digest === null ? null : digestValue(row.result_set_digest),
    purgeAfter: nullableInteger(row.purge_after, "purge after"),
    detailState,
  };
}

function exactRecoveryReceipts(
  rows: readonly Row[],
  canonical: CanonicalArtifactRecoveryRequest,
  singleton: SingletonRow,
): boolean {
  if (rows.length !== EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT) return false;
  const expectedState = singleton.phase === "complete" ? "recovery_complete" : "recovery_active";
  return rows.every((row, index) => {
    const expected = canonical.receipts[index];
    const upload = canonical.request.uploads[index];
    return (
      expected !== undefined &&
      upload !== undefined &&
      row.receipt_id === expected.receiptId &&
      row.principal_id === upload.principalId &&
      row.upload_id === upload.uploadId &&
      row.manifest_digest === canonical.request.manifestDigest &&
      row.upload_fence === upload.uploadFence &&
      row.root_fence === upload.rootFence &&
      row.receipt_kind === "exact_failed_run_recovery" &&
      row.recovery_request_digest === canonical.requestDigest &&
      row.state === expectedState &&
      (singleton.phase === "complete" ? row.purge_after === singleton.purgeAfter : true)
    );
  });
}

async function readRecoveryCandidates(
  sql: Sql,
  canonical: CanonicalArtifactRecoveryRequest,
): Promise<readonly RecoveryCandidateRow[]> {
  const rows = await sql.query(
    `SELECT detail.ordinal, detail.kind, detail.digest, detail.prepared_etag,
            detail.active_etag, detail.state AS detail_state,
            detail.delete_operation_id, detail.delete_lease_fence,
            detail.execution_worker_version_id, detail.result_digest,
            detail.completed_at, candidate.state AS gc_state, candidate.fence,
            candidate.not_before, candidate.expected_etag, candidate.attempts,
            candidate.last_outcome, lease.operation_id AS lease_operation_id,
            lease.fence AS lease_fence, lease.last_outcome AS lease_outcome
     FROM tf_artifact_recovery_candidates AS detail
     LEFT JOIN tf_artifact_gc_candidates AS candidate
       ON candidate.kind = detail.kind AND candidate.digest = detail.digest
     LEFT JOIN tf_artifact_blob_io_leases AS lease
       ON detail.kind = 'blob' AND lease.digest = detail.digest
          AND lease.state = 'deleting'
     WHERE detail.request_digest = ? ORDER BY detail.ordinal`,
    [canonical.requestDigest],
  );
  return rows.map(recoveryCandidateRow);
}

async function readRecoveryExecutionHandoffs(
  sql: Sql,
  requestDigest: Digest,
): Promise<readonly ExactArtifactRecoveryExecutionHandoff[]> {
  const rows = await sql.query(
    `SELECT sequence, candidate_ordinal, candidate_fence,
            predecessor_worker_version_id, successor_worker_version_id,
            resolution_kind, observed_etag, reviewed_operation_id,
            reviewed_candidate_fence, review_evidence_digest,
            quiescence_evidence_digest, activated_at, handoff_digest, purge_after
     FROM tf_artifact_recovery_execution_handoffs
     WHERE request_digest = ? ORDER BY sequence`,
    [requestDigest],
  );
  return rows.map((row): ExactArtifactRecoveryExecutionHandoff => {
    const resolutionKind = stringColumn(row, "resolution_kind");
    if (resolutionKind !== "confirm-head-absent" && resolutionKind !== "reviewed-retry") {
      throw new Error("artifact recovery execution handoff resolution is invalid");
    }
    return {
      sequence: requiredInteger(row.sequence, "execution handoff sequence"),
      candidateOrdinal: requiredInteger(row.candidate_ordinal, "handoff candidate ordinal"),
      candidateFence: requiredInteger(row.candidate_fence, "handoff candidate fence"),
      predecessorWorkerVersionId: stringColumn(row, "predecessor_worker_version_id"),
      successorWorkerVersionId: stringColumn(row, "successor_worker_version_id"),
      resolutionKind,
      observedEtag: nullableString(row.observed_etag, "handoff observed ETag"),
      reviewedOperationId: nullableString(
        row.reviewed_operation_id,
        "handoff reviewed operation id",
      ),
      reviewedCandidateFence: nullableInteger(
        row.reviewed_candidate_fence,
        "handoff reviewed candidate fence",
      ),
      reviewEvidenceDigest:
        row.review_evidence_digest === null ? null : digestValue(row.review_evidence_digest),
      quiescenceEvidenceDigest: digestValue(row.quiescence_evidence_digest),
      activatedAt: requiredInteger(row.activated_at, "handoff activated at"),
      handoffDigest: digestValue(row.handoff_digest),
      purgeAfter: nullableInteger(row.purge_after, "handoff purge after"),
    };
  });
}

export async function validateExactArtifactRecoveryExecutionLineage(input: {
  readonly requestDigest: Digest;
  readonly preparingWorkerVersionId: string;
  readonly activeWorkerVersionId: string;
  readonly expectedHandoffCount: number;
  readonly preparedAt: number;
  readonly expectedPurgeAfter: number | null;
  readonly handoffs: readonly ExactArtifactRecoveryExecutionHandoff[];
}): Promise<Digest | null> {
  const { requestDigest, handoffs } = input;
  if (handoffs.length !== input.expectedHandoffCount) return null;
  let activeWorkerVersionId = input.preparingWorkerVersionId;
  const seenWorkerVersionIds = new Set([input.preparingWorkerVersionId]);
  for (let index = 0; index < handoffs.length; index += 1) {
    const handoff = handoffs[index];
    if (
      !handoff ||
      handoff.sequence !== index + 1 ||
      handoff.predecessorWorkerVersionId !== activeWorkerVersionId ||
      seenWorkerVersionIds.has(handoff.successorWorkerVersionId) ||
      !workerVersionId(handoff.predecessorWorkerVersionId) ||
      !workerVersionId(handoff.successorWorkerVersionId) ||
      handoff.candidateOrdinal < 0 ||
      handoff.candidateOrdinal >= EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT ||
      handoff.candidateFence < 1 ||
      handoff.activatedAt < input.preparedAt ||
      handoff.purgeAfter !== input.expectedPurgeAfter ||
      (handoff.resolutionKind === "confirm-head-absent" &&
        (handoff.observedEtag !== null ||
          handoff.reviewedOperationId !== null ||
          handoff.reviewedCandidateFence !== null ||
          handoff.reviewEvidenceDigest !== null)) ||
      (handoff.resolutionKind === "reviewed-retry" &&
        (!handoff.observedEtag ||
          !handoff.reviewedOperationId ||
          handoff.reviewedCandidateFence !== handoff.candidateFence + 2 ||
          !handoff.reviewEvidenceDigest))
    ) {
      return null;
    }
    if (
      (await exactArtifactRecoveryExecutionHandoffDigest(requestDigest, {
        sequence: handoff.sequence,
        candidateOrdinal: handoff.candidateOrdinal,
        candidateFence: handoff.candidateFence,
        predecessorWorkerVersionId: handoff.predecessorWorkerVersionId,
        successorWorkerVersionId: handoff.successorWorkerVersionId,
        resolutionKind: handoff.resolutionKind,
        observedEtag: handoff.observedEtag,
        reviewedOperationId: handoff.reviewedOperationId,
        reviewedCandidateFence: handoff.reviewedCandidateFence,
        reviewEvidenceDigest: handoff.reviewEvidenceDigest,
        quiescenceEvidenceDigest: handoff.quiescenceEvidenceDigest,
        activatedAt: handoff.activatedAt,
      })) !== handoff.handoffDigest
    ) {
      return null;
    }
    activeWorkerVersionId = handoff.successorWorkerVersionId;
    seenWorkerVersionIds.add(activeWorkerVersionId);
  }
  if (activeWorkerVersionId !== input.activeWorkerVersionId) return null;
  return await exactArtifactRecoveryExecutionLineageDigest({
    requestDigest,
    preparingWorkerVersionId: input.preparingWorkerVersionId,
    activeWorkerVersionId: input.activeWorkerVersionId,
    handoffs: handoffs.map(({ sequence, handoffDigest }) => ({ sequence, handoffDigest })),
  });
}

function recoveryCandidateRow(row: Row): RecoveryCandidateRow {
  const kind = artifactKind(row.kind);
  const detailState = stringColumn(row, "detail_state");
  if (
    detailState !== "pending" &&
    detailState !== "delete_started" &&
    detailState !== "deleted" &&
    detailState !== "metadata_deleted"
  ) {
    throw new Error("artifact recovery detail candidate state is invalid");
  }
  const gcState = stringColumn(row, "gc_state");
  if (
    gcState !== "pending" &&
    gcState !== "deleting" &&
    gcState !== "retry" &&
    gcState !== "deleted" &&
    gcState !== "cancelled"
  ) {
    throw new Error("artifact recovery GC candidate state is invalid");
  }
  return {
    ordinal: requiredInteger(row.ordinal, "candidate ordinal"),
    kind,
    digest: digestValue(row.digest),
    preparedEtag: nullableString(row.prepared_etag, "prepared ETag"),
    activeEtag: nullableString(row.active_etag, "active ETag"),
    detailState,
    deleteOperationId: nullableString(row.delete_operation_id, "delete operation id"),
    deleteLeaseFence: nullableInteger(row.delete_lease_fence, "delete lease fence"),
    executionWorkerVersionId: nullableString(
      row.execution_worker_version_id,
      "execution worker version id",
    ),
    resultDigest: row.result_digest === null ? null : digestValue(row.result_digest),
    completedAt: nullableInteger(row.completed_at, "candidate completed at"),
    gcState,
    fence: requiredInteger(row.fence, "candidate fence"),
    notBefore: requiredInteger(row.not_before, "candidate not before"),
    expectedEtag: nullableString(row.expected_etag, "candidate expected ETag"),
    attempts: requiredInteger(row.attempts, "candidate attempts"),
    lastOutcome: stringColumn(row, "last_outcome"),
    leaseOperationId: nullableString(row.lease_operation_id, "lease operation id"),
    leaseFence: nullableInteger(row.lease_fence, "lease fence"),
    leaseOutcome: nullableString(row.lease_outcome, "lease outcome"),
  };
}

function exactRecoveryCandidateSet(
  candidates: readonly RecoveryCandidateRow[],
  request: ArtifactRecoveryRequest,
  preparedAt: number,
): boolean {
  if (candidates.length !== EXACT_ARTIFACT_RECOVERY_CANDIDATE_COUNT) return false;
  const quarantine = preparedAt + ARTIFACT_RECOVERY_QUARANTINE_MILLISECONDS;
  for (let ordinal = 0; ordinal < candidates.length; ordinal += 1) {
    const candidate = candidates[ordinal];
    const expectedKind = ordinal < EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT ? "blob" : "manifest";
    const expectedDigest =
      expectedKind === "blob" ? request.memberDigests[ordinal] : request.manifestDigest;
    if (
      !candidate ||
      candidate.ordinal !== ordinal ||
      candidate.kind !== expectedKind ||
      candidate.digest !== expectedDigest ||
      candidate.notBefore < quarantine ||
      candidate.fence < 1 ||
      candidate.attempts < 0
    ) {
      return false;
    }
    if (candidate.kind === "blob") {
      if (!candidate.preparedEtag || !candidate.activeEtag) return false;
    } else if (candidate.preparedEtag !== null || candidate.activeEtag !== null) {
      return false;
    }
    if (candidate.detailState === "pending") {
      if (
        (candidate.gcState !== "pending" && candidate.gcState !== "retry") ||
        candidate.expectedEtag !== candidate.activeEtag ||
        candidate.deleteOperationId !== null ||
        candidate.deleteLeaseFence !== null ||
        candidate.executionWorkerVersionId !== null ||
        candidate.resultDigest !== null ||
        candidate.completedAt !== null ||
        candidate.leaseOperationId !== null
      ) {
        return false;
      }
    } else if (candidate.detailState === "delete_started") {
      if (
        candidate.kind !== "blob" ||
        candidate.gcState !== "deleting" ||
        candidate.expectedEtag !== candidate.activeEtag ||
        !candidate.deleteOperationId ||
        candidate.deleteLeaseFence === null ||
        !candidate.executionWorkerVersionId ||
        candidate.resultDigest !== null ||
        candidate.completedAt !== null ||
        candidate.leaseOperationId !== candidate.deleteOperationId ||
        candidate.leaseFence !== candidate.deleteLeaseFence ||
        candidate.leaseOutcome !== "delete_started"
      ) {
        return false;
      }
    } else if (candidate.detailState === "deleted") {
      if (
        candidate.kind !== "blob" ||
        candidate.gcState !== "deleted" ||
        !candidate.deleteOperationId ||
        candidate.deleteLeaseFence === null ||
        !candidate.executionWorkerVersionId ||
        !candidate.resultDigest ||
        candidate.completedAt === null ||
        candidate.leaseOperationId !== null
      ) {
        return false;
      }
    } else if (
      candidate.kind !== "manifest" ||
      candidate.gcState !== "deleted" ||
      !candidate.resultDigest ||
      candidate.completedAt === null
    ) {
      return false;
    }
  }
  return true;
}

async function recoveryResultSetDigest(
  requestDigest: Digest,
  candidates: readonly RecoveryCandidateRow[],
  executionLineageDigest: Digest,
): Promise<Digest> {
  return await exactArtifactRecoveryResultSetDigest({
    requestDigest,
    executionLineageDigest,
    results: candidates.map((candidate) => ({
      ordinal: candidate.ordinal,
      kind: candidate.kind,
      digest: candidate.digest,
      resultDigest: candidate.resultDigest as Digest,
    })),
  });
}

async function exactCredentialClosures(
  sql: Sql,
  request: ArtifactRecoveryRequest,
): Promise<readonly CredentialClosure[] | null> {
  const closures: CredentialClosure[] = [];
  for (const owner of request.owners) {
    const ids = await deterministicIntegrationE2eApiKeyIds(owner.operationId);
    const rows = await sql.query(
      `SELECT
         operation.operation_id, operation.authority_slot, operation.org_id,
         operation.writer_key_id, operation.evidence_key_id,
         operation.writer_name, operation.evidence_name,
         operation.writer_scopes_json, operation.evidence_scopes_json,
         operation.ttl_seconds, operation.state, operation.fence,
         operation.source_commit, operation.artifact_digest,
         operation.authority_worker_version_id, operation.created_at,
         operation.updated_at, operation.revoked_at,
         writer.id AS writer_id, writer.org_id AS writer_org_id,
         writer.name AS writer_token_name, writer.scopes_json AS writer_token_scopes,
         writer.created_at AS writer_created_at, writer.expires_at AS writer_expires_at,
         writer.revoked_at AS writer_revoked_at,
         evidence.id AS evidence_id, evidence.org_id AS evidence_org_id,
         evidence.name AS evidence_token_name,
         evidence.scopes_json AS evidence_token_scopes,
         evidence.created_at AS evidence_created_at,
         evidence.expires_at AS evidence_expires_at,
         evidence.revoked_at AS evidence_revoked_at
       FROM integration_e2e_credential_pair_operations AS operation
       LEFT JOIN auth_tokens AS writer
         ON writer.id = operation.writer_key_id AND writer.kind = 'api_key'
       LEFT JOIN auth_tokens AS evidence
         ON evidence.id = operation.evidence_key_id AND evidence.kind = 'api_key'
       WHERE operation.operation_id = ?`,
      [owner.operationId],
    );
    if (rows.length !== 1) return null;
    const row = rows[0] as Row;
    const operationCreatedAt = integerValue(row.created_at);
    const operationUpdatedAt = integerValue(row.updated_at);
    const operationRevokedAt = integerValue(row.revoked_at);
    const operationFence = positiveIntegerValue(row.fence);
    const writerCreatedAt = isoTimestamp(row.writer_created_at);
    const writerExpiresAt = isoTimestamp(row.writer_expires_at);
    const writerRevokedAt = isoTimestamp(row.writer_revoked_at);
    const evidenceCreatedAt = isoTimestamp(row.evidence_created_at);
    const evidenceExpiresAt = isoTimestamp(row.evidence_expires_at);
    const evidenceRevokedAt = isoTimestamp(row.evidence_revoked_at);
    if (
      operationCreatedAt === null ||
      operationUpdatedAt === null ||
      operationRevokedAt === null ||
      operationUpdatedAt < operationCreatedAt ||
      operationRevokedAt < operationCreatedAt ||
      operationFence === null ||
      writerCreatedAt === null ||
      writerExpiresAt === null ||
      writerRevokedAt === null ||
      evidenceCreatedAt === null ||
      evidenceExpiresAt === null ||
      evidenceRevokedAt === null ||
      writerCreatedAt < operationCreatedAt ||
      evidenceCreatedAt !== writerCreatedAt ||
      writerExpiresAt !== writerCreatedAt + INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS * 1_000 ||
      evidenceExpiresAt !== writerExpiresAt ||
      writerRevokedAt !== evidenceRevokedAt ||
      writerRevokedAt < writerCreatedAt ||
      writerRevokedAt > operationRevokedAt ||
      row.operation_id !== owner.operationId ||
      row.authority_slot !== "integration-e2e-credential-pair" ||
      row.org_id !== request.tenantId ||
      row.writer_key_id !== ids.writer ||
      row.evidence_key_id !== ids.evidence ||
      row.writer_name !== INTEGRATION_E2E_WRITER_KEY_NAME ||
      row.evidence_name !== INTEGRATION_E2E_EVIDENCE_KEY_NAME ||
      row.writer_scopes_json !== JSON.stringify(INTEGRATION_E2E_WRITER_SCOPES) ||
      row.evidence_scopes_json !== JSON.stringify(INTEGRATION_E2E_EVIDENCE_SCOPES) ||
      row.ttl_seconds !== INTEGRATION_E2E_API_KEY_DEFAULT_TTL_SECONDS ||
      row.state !== "revoked" ||
      row.writer_id !== ids.writer ||
      row.writer_org_id !== request.tenantId ||
      row.writer_token_name !== INTEGRATION_E2E_WRITER_KEY_NAME ||
      row.writer_token_scopes !== JSON.stringify(INTEGRATION_E2E_WRITER_SCOPES) ||
      row.evidence_id !== ids.evidence ||
      row.evidence_org_id !== request.tenantId ||
      row.evidence_token_name !== INTEGRATION_E2E_EVIDENCE_KEY_NAME ||
      row.evidence_token_scopes !== JSON.stringify(INTEGRATION_E2E_EVIDENCE_SCOPES) ||
      owner.principalId !== `api-key:${ids.writer}` ||
      typeof row.source_commit !== "string" ||
      !/^[0-9a-f]{40}$/u.test(row.source_commit) ||
      !isSha256Digest(row.artifact_digest) ||
      typeof row.authority_worker_version_id !== "string" ||
      !workerVersionId(row.authority_worker_version_id)
    ) {
      return null;
    }
    const closedAt = Math.max(operationRevokedAt, writerRevokedAt, evidenceRevokedAt);
    closures.push({
      principalId: owner.principalId,
      operationId: owner.operationId,
      authoritySlot: String(row.authority_slot),
      organizationId: String(row.org_id),
      writerKeyId: ids.writer,
      evidenceKeyId: ids.evidence,
      writerName: String(row.writer_name),
      evidenceName: String(row.evidence_name),
      writerScopesJson: String(row.writer_scopes_json),
      evidenceScopesJson: String(row.evidence_scopes_json),
      ttlSeconds: Number(row.ttl_seconds),
      operationState: "revoked",
      operationFence,
      provenance: {
        sourceCommit: String(row.source_commit),
        artifactDigest: row.artifact_digest as Digest,
        authorityWorkerVersionId: String(row.authority_worker_version_id),
      },
      operationCreatedAt,
      operationUpdatedAt,
      operationRevokedAt,
      closedAt,
      writerToken: {
        id: ids.writer,
        organizationId: String(row.writer_org_id),
        name: String(row.writer_token_name),
        scopesJson: String(row.writer_token_scopes),
        createdAt: String(row.writer_created_at),
        expiresAt: String(row.writer_expires_at),
        revokedAt: String(row.writer_revoked_at),
      },
      evidenceToken: {
        id: ids.evidence,
        organizationId: String(row.evidence_org_id),
        name: String(row.evidence_token_name),
        scopesJson: String(row.evidence_token_scopes),
        createdAt: String(row.evidence_created_at),
        expiresAt: String(row.evidence_expires_at),
        revokedAt: String(row.evidence_revoked_at),
      },
    });
  }
  return closures;
}

async function exactMemberRows(sql: Sql, request: ArtifactRecoveryRequest): Promise<boolean> {
  const rows = await sql.query(
    `SELECT blob_digest FROM tf_artifact_manifest_members
     WHERE manifest_digest = ? ORDER BY blob_digest`,
    [request.manifestDigest],
  );
  return canonicalJson(rows.map((row) => row.blob_digest)) === canonicalJson(request.memberDigests);
}

async function targetHolds(
  sql: Sql,
  request: ArtifactRecoveryRequest,
): Promise<readonly { readonly kind: "manifest" | "blob"; readonly digest: Digest }[]> {
  const rows = await sql.query(
    `SELECT kind, digest FROM tf_artifact_holds
     WHERE tenant_id = ? AND (
       (kind = 'manifest' AND digest = ?) OR
       (kind = 'blob' AND digest IN (SELECT CAST(value AS TEXT) FROM json_each(?)))
     ) ORDER BY CASE kind WHEN 'manifest' THEN 0 ELSE 1 END, digest`,
    [request.tenantId, request.manifestDigest, JSON.stringify(request.memberDigests)],
  );
  return rows.map((row) => ({ kind: artifactKind(row.kind), digest: digestValue(row.digest) }));
}

async function targetReplayRows(
  sql: Sql,
  request: ArtifactRecoveryRequest,
): Promise<readonly Row[]> {
  return await sql.query(
    `SELECT replay_key, status, body_json, expires_at
     FROM tf_artifact_replays
     WHERE replay_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))
     ORDER BY replay_key`,
    [JSON.stringify(request.expectedReplays.keys)],
  );
}

function exactReplayRows(rows: readonly Row[], request: ArtifactRecoveryRequest): boolean {
  if (rows.length !== request.expectedReplays.count) return false;
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (
      !row ||
      row.replay_key !== request.expectedReplays.keys[index] ||
      !Number.isSafeInteger(row.status) ||
      Number(row.status) < 200 ||
      Number(row.status) > 299 ||
      typeof row.body_json !== "string"
    ) {
      return false;
    }
    try {
      const body = record(JSON.parse(row.body_json), "artifact recovery replay body");
      if (body.manifestDigest !== request.manifestDigest) return false;
    } catch {
      return false;
    }
  }
  return true;
}

async function relevantActiveRoots(
  sql: Sql,
  request: ArtifactRecoveryRequest,
): Promise<readonly Row[]> {
  return await sql.query(
    `SELECT tenant_id, root_kind, root_id, target_kind, digest, state, fence,
            expires_at, release_reason
     FROM tf_artifact_roots AS root
     WHERE root.state = 'active' AND (
       (root.target_kind = 'blob'
         AND root.digest IN (SELECT CAST(value AS TEXT) FROM json_each(?))) OR
       (root.target_kind = 'manifest' AND (
         root.digest = ? OR EXISTS (
           SELECT 1 FROM tf_artifact_manifest_members AS member
           WHERE member.manifest_digest = root.digest
             AND member.blob_digest IN (SELECT CAST(value AS TEXT) FROM json_each(?))
         )
       ))
     ) ORDER BY tenant_id, root_kind, root_id, target_kind, digest`,
    [
      JSON.stringify(request.memberDigests),
      request.manifestDigest,
      JSON.stringify(request.memberDigests),
    ],
  );
}

function exactInitialRoots(rows: readonly Row[], request: ArtifactRecoveryRequest): boolean {
  const expected = [
    ...request.uploads.map((upload) => ({
      tenant_id: request.tenantId,
      root_kind: "upload",
      root_id: upload.uploadId,
      target_kind: "manifest",
      digest: request.manifestDigest,
      state: "active",
      fence: upload.rootFence,
      expires_at: null,
      release_reason: null,
    })),
    ...request.expectedReplays.keys.map((key) => ({
      tenant_id: request.tenantId,
      root_kind: "replay",
      root_id: key,
      target_kind: "manifest",
      digest: request.manifestDigest,
      state: "active",
      fence: 1,
      expires_at: rows.find((row) => row.root_kind === "replay" && row.root_id === key)?.expires_at,
      release_reason: null,
    })),
  ].sort(rootCompare);
  return canonicalJson(rows) === canonicalJson(expected);
}

function rootCompare(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftKey = `${left.tenant_id}\u0000${left.root_kind}\u0000${left.root_id}\u0000${left.target_kind}\u0000${left.digest}`;
  const rightKey = `${right.tenant_id}\u0000${right.root_kind}\u0000${right.root_id}\u0000${right.target_kind}\u0000${right.digest}`;
  return compare(leftKey, rightKey);
}

function exactReleasedReplayRoots(rows: readonly Row[], request: ArtifactRecoveryRequest): boolean {
  if (rows.length !== request.expectedReplays.count) return false;
  return rows.every(
    (row, index) =>
      row.root_id === request.expectedReplays.keys[index] &&
      row.state === "released" &&
      row.fence === 2 &&
      row.release_reason === "operator_exact_failed_run",
  );
}

async function targetGcCandidates(
  sql: Sql,
  request: ArtifactRecoveryRequest,
): Promise<readonly Row[]> {
  return await sql.query(
    `SELECT kind, digest FROM tf_artifact_gc_candidates
     WHERE (kind = 'manifest' AND digest = ?) OR
       (kind = 'blob' AND digest IN (SELECT CAST(value AS TEXT) FROM json_each(?)))`,
    [request.manifestDigest, JSON.stringify(request.memberDigests)],
  );
}

async function blobPresence(
  objects: Pick<ObjectStoreAccess, "head">,
  digests: readonly Digest[],
): Promise<ReadonlyMap<Digest, boolean>> {
  const result = new Map<Digest, boolean>();
  for (const item of digests) result.set(item, (await objects.head(blobKey(item))) !== null);
  return result;
}

async function manifestMatchesRequest(
  manifestJson: string,
  request: ArtifactRecoveryRequest,
): Promise<boolean> {
  try {
    const manifest = JSON.parse(manifestJson) as unknown;
    return (
      (await canonicalDigest(manifest)) === request.manifestDigest &&
      canonicalJson(manifestMemberDigests(manifest)) === canonicalJson(request.memberDigests)
    );
  } catch {
    return false;
  }
}

function manifestMemberDigests(value: unknown): readonly Digest[] {
  const manifest = record(value, "artifact manifest");
  const members: Digest[] = [];
  for (const field of ["modules", "files"] as const) {
    const entries = manifest[field];
    if (entries === undefined) continue;
    for (const entry of array(entries, `artifact manifest ${field}`)) {
      members.push(
        digest(record(entry, `artifact manifest ${field} member`).digest, "member digest"),
      );
    }
  }
  return [...new Set(members)].sort(compare);
}

function blobKey(value: Digest): string {
  return `art/${value.slice("sha256:".length)}`;
}

function artifactKind(value: unknown): "manifest" | "blob" {
  if (value !== "manifest" && value !== "blob") {
    throw new Error("artifact recovery candidate kind is invalid");
  }
  return value;
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function array(value: unknown, name: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${name} must be an array`);
  return value;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...keys].sort())) {
    throw new TypeError("artifact recovery request has unexpected or missing fields");
  }
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    throw new TypeError(`artifact recovery ${name} is invalid`);
  }
  return value;
}

function boundedIdentifier(value: unknown, name: string, minimum: number, maximum: number): string {
  const result = boundedString(value, name, minimum, maximum);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(result)) {
    throw new TypeError(`artifact recovery ${name} is invalid`);
  }
  return result;
}

function boundedReplayKey(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length < 3 ||
    value.length > 4096 ||
    value.trim() !== value ||
    value.split("\u0000").length !== 3 ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return (code <= 31 && code !== 0) || code === 127;
    })
  ) {
    throw new TypeError("artifact recovery replay key is invalid");
  }
  return value;
}

function boundedHex(value: unknown, name: string, length: number): string {
  if (typeof value !== "string" || value.length !== length || !/^[0-9a-f]+$/u.test(value)) {
    throw new TypeError(`artifact recovery ${name} is invalid`);
  }
  return value;
}

function boundedBucketName(value: unknown): string {
  const result = boundedString(value, "R2 bucketName", 3, 63);
  if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(result)) {
    throw new TypeError("artifact recovery R2 bucketName is invalid");
  }
  return result;
}

function positiveInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1) {
    throw new TypeError(`artifact recovery ${name} must be a positive integer`);
  }
  return Number(value);
}

function requiredInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`artifact recovery durable ${name} is invalid`);
  }
  return Number(value);
}

function integerValue(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function positiveIntegerValue(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 1 ? Number(value) : null;
}

function nullableInteger(value: unknown, name: string): number | null {
  if (value === null) return null;
  return requiredInteger(value, name);
}

function stringColumn(row: Row, name: string): string {
  const value = row[name];
  if (typeof value !== "string") throw new Error(`artifact recovery durable ${name} is invalid`);
  return value;
}

function nullableString(value: unknown, name: string): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error(`artifact recovery durable ${name} is invalid`);
  return value;
}

function digest(value: unknown, name: string): Digest {
  if (!isSha256Digest(value)) throw new TypeError(`artifact recovery ${name} is invalid`);
  return value;
}

function digestValue(value: unknown): Digest {
  if (!isSha256Digest(value)) throw new Error("artifact recovery durable digest is invalid");
  return value;
}

function digestArray(value: unknown, name: string): readonly Digest[] {
  return array(value, name).map((entry) => digest(entry, name));
}

function isoTimestamp(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const result = Date.parse(value);
  return Number.isSafeInteger(result) && result >= 0 ? result : null;
}

function workerVersionId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value)
  );
}

function compare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertCanonicalStrings(values: readonly string[], name: string): void {
  const canonical = [...new Set(values)].sort(compare);
  if (canonicalJson(canonical) !== canonicalJson(values)) {
    throw new TypeError(`artifact recovery ${name} must be a sorted unique set`);
  }
}

function assertCanonicalObjects<T>(
  values: readonly T[],
  key: (value: T) => string,
  name: string,
): void {
  const keys = values.map(key);
  const canonical = [...new Set(keys)].sort(compare);
  if (canonicalJson(canonical) !== canonicalJson(keys)) {
    throw new TypeError(`artifact recovery ${name} must be canonically ordered and unique`);
  }
}
