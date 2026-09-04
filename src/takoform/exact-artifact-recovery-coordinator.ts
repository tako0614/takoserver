import {
  ARTIFACT_RECOVERY_QUARANTINE_MILLISECONDS,
  type Digest,
  EXACT_ARTIFACT_RECOVERY_CANDIDATE_COUNT,
  EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT,
  EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT,
  type ExactArtifactRecoveryCompletion,
  type ExactArtifactRecoveryCoordinator,
  type ExactArtifactRecoveryExecutionHandoff,
  type ExactArtifactRecoveryPreparation,
  type ExactArtifactRecoveryRearm,
  type ExactArtifactRecoverySettlement,
  exactArtifactRecoveryExecutionHandoffDigest,
  exactArtifactRecoveryResultSetDigest,
  validateExactArtifactRecoveryExecutionLineage,
} from "../artifact-recovery.ts";
import { canonicalDigest } from "../json.ts";
import type { Clock, ObjectStoreAccess, Row, Sql, SqlStatement } from "../ports.ts";
import { SqlError } from "../ports.ts";
import { ARTIFACT_BLOB_IO_LEASE_MILLISECONDS } from "./artifact-blob-io.ts";
import { prepareExactArtifactRecoveryGroup } from "./exact-artifact-recovery-prepare.ts";

export interface ExactArtifactRecoveryCoordinatorOptions {
  readonly sql: Sql;
  readonly objects: Pick<ObjectStoreAccess, "head" | "delete">;
  readonly clock: Clock;
  readonly randomId: () => string;
}

export function createExactArtifactRecoveryCoordinator(
  options: ExactArtifactRecoveryCoordinatorOptions,
): ExactArtifactRecoveryCoordinator {
  return {
    async prepareExactArtifactRecovery(input: ExactArtifactRecoveryPreparation) {
      await prepareExactArtifactRecoveryGroup(options, input);
    },
    async settleNextExactArtifactRecovery(input) {
      await settleExactArtifactRecoveryCandidate(options, input);
    },
    async reconcileAbsentExactArtifactRecovery(input) {
      await reconcileAbsentExactArtifactRecoveryCandidate(options, input);
    },
    async rearmExactArtifactRecovery(input) {
      await rearmExactArtifactRecoveryCandidate(options, input);
    },
    async completeExactArtifactRecovery(input) {
      await completeExactArtifactRecoveryGroup(options, input);
    },
  };
}

interface RecoveryCandidateState {
  readonly phase: "prepared" | "settling" | "complete" | "revoked";
  readonly tenantId: string;
  readonly preparingWorkerVersionId: string;
  readonly activeWorkerVersionId: string;
  readonly executionHandoffCount: number;
  readonly ordinal: number;
  readonly kind: "blob" | "manifest";
  readonly digest: Digest;
  readonly activeEtag: string | null;
  readonly detailState: "pending" | "delete_started" | "deleted" | "metadata_deleted";
  readonly reviewedOperationId: string | null;
  readonly reviewedCandidateFence: number | null;
  readonly reviewEvidenceDigest: Digest | null;
  readonly quiescenceEvidenceDigest: Digest | null;
  readonly deleteOperationId: string | null;
  readonly deleteLeaseFence: number | null;
  readonly executionWorkerVersionId: string | null;
  readonly resultDigest: Digest | null;
  readonly candidateState: "pending" | "deleting" | "retry" | "deleted" | "cancelled";
  readonly candidateFence: number;
  readonly notBefore: number;
  readonly expectedEtag: string | null;
  readonly leaseState: "available" | "writing" | "deleting" | null;
  readonly leaseOperationId: string | null;
  readonly leaseFence: number | null;
  readonly leaseCandidateFence: number | null;
  readonly leaseOutcome: string | null;
}

export async function settleExactArtifactRecoveryCandidate(
  options: ExactArtifactRecoveryCoordinatorOptions,
  input: ExactArtifactRecoverySettlement,
): Promise<void> {
  assertMutationBinding(input);
  const current = await readCandidate(
    options.sql,
    input.canonical.requestDigest,
    input.candidate.ordinal,
  );
  if (!current || current.phase === "complete" || current.phase === "revoked") return;
  if (!candidateMatchesInput(current, input) || current.detailState !== "pending") return;
  if (input.execution.workerVersionId !== current.activeWorkerVersionId) return;
  const timestamp = options.clock().getTime();
  if (current.notBefore > timestamp) return;

  if (current.kind === "manifest") {
    await settleManifest(options, input, current, timestamp);
    return;
  }

  const head = await options.objects.head(blobKey(current.digest));
  if (!head) {
    await settleObservedAbsent(options, input, current, timestamp);
    return;
  }
  if (head.etag !== current.activeEtag) return;

  const reviewed = reviewedDelete(input, current);
  if (current.reviewedOperationId && !reviewed) return;
  const operationId =
    reviewed?.operationId ?? recoveryOperationId("delete", options.randomId(), current);
  const nextCandidateFence = current.candidateFence + 1;
  if (reviewed && reviewed.candidateFence !== nextCandidateFence) return;
  if (current.leaseState !== null && current.leaseState !== "available") return;
  const previousLeaseFence = current.leaseFence ?? 0;
  const nextLeaseFence = previousLeaseFence + 1;
  const leaseExpiresAt = timestamp + ARTIFACT_BLOB_IO_LEASE_MILLISECONDS;
  const token = recoveryGuardToken(options.randomId());

  try {
    const writes = await options.sql.batch([
      recoveryCandidateGuard(token, input, current, timestamp, {
        requirePending: true,
        requireNoReference: true,
      }),
      {
        sql: `INSERT INTO tf_artifact_blob_io_leases
                (digest, state, fence, operation_id, tenant_id, principal_id, upload_id,
                 upload_fence, root_fence, expected_size, candidate_fence,
                 lease_expires_at, last_outcome, created_at, updated_at)
              VALUES (?, 'deleting', 1, ?, NULL, NULL, NULL, NULL, NULL, NULL,
                      ?, ?, 'delete_started', ?, ?)
              ON CONFLICT (digest) DO UPDATE SET
                state = 'deleting', fence = tf_artifact_blob_io_leases.fence + 1,
                operation_id = excluded.operation_id, tenant_id = NULL,
                principal_id = NULL, upload_id = NULL, upload_fence = NULL,
                root_fence = NULL, expected_size = NULL,
                candidate_fence = excluded.candidate_fence,
                lease_expires_at = excluded.lease_expires_at,
                last_outcome = 'delete_started', updated_at = excluded.updated_at
              WHERE tf_artifact_blob_io_leases.state = 'available'
                AND tf_artifact_blob_io_leases.fence = ?`,
        params: [
          current.digest,
          operationId,
          nextCandidateFence,
          leaseExpiresAt,
          timestamp,
          timestamp,
          previousLeaseFence,
        ],
      },
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'deleting', fence = fence + 1, expected_etag = ?,
                  attempts = attempts + 1, last_outcome = 'claimed', updated_at = ?
              WHERE kind = 'blob' AND digest = ? AND state IN ('pending', 'retry')
                AND fence = ? AND not_before <= ?`,
        params: [current.activeEtag, timestamp, current.digest, current.candidateFence, timestamp],
      },
      {
        sql: `UPDATE tf_artifact_recovery_candidates
              SET state = 'delete_started', delete_operation_id = ?,
                  delete_lease_fence = ?, execution_worker_version_id = ?
              WHERE request_digest = ? AND ordinal = ? AND kind = 'blob'
                AND digest = ? AND state = 'pending'`,
        params: [
          operationId,
          nextLeaseFence,
          input.execution.workerVersionId,
          input.canonical.requestDigest,
          current.ordinal,
          current.digest,
        ],
      },
      {
        sql: `UPDATE tf_artifact_recovery_once SET phase = 'settling'
              WHERE singleton = 1 AND request_digest = ? AND phase = 'prepared'`,
        params: [input.canonical.requestDigest],
      },
      deleteGuard(token),
    ]);
    if (writes[1]?.changes !== 1 || writes[2]?.changes !== 1 || writes[3]?.changes !== 1) {
      throw new Error("exact artifact recovery delete-start lost its fence");
    }
  } catch (error) {
    // Even an unavailable acknowledgement cannot authorize a second caller to
    // cross R2. A committed start remains visible for successor reconciliation.
    if (await deleteStartVisible(options.sql, input, current, operationId).catch(() => false))
      return;
    if (constraint(error)) return;
    throw error;
  }

  let deleteReturned: boolean;
  try {
    deleteReturned = await options.objects.delete(blobKey(current.digest));
  } catch {
    return;
  }
  const after = await options.objects.head(blobKey(current.digest));
  if (after) return;
  await settleStartedDelete(
    options,
    input,
    {
      ...current,
      detailState: "delete_started",
      candidateState: "deleting",
      candidateFence: nextCandidateFence,
      expectedEtag: current.activeEtag,
      leaseState: "deleting",
      leaseOperationId: operationId,
      leaseFence: nextLeaseFence,
      leaseCandidateFence: nextCandidateFence,
      leaseOutcome: "delete_started",
      deleteOperationId: operationId,
      deleteLeaseFence: nextLeaseFence,
      executionWorkerVersionId: input.execution.workerVersionId,
    },
    deleteReturned ? "deleted" : "already_absent",
    null,
    null,
  );
}

export async function reconcileAbsentExactArtifactRecoveryCandidate(
  options: ExactArtifactRecoveryCoordinatorOptions,
  input: ExactArtifactRecoverySettlement,
): Promise<void> {
  assertMutationBinding(input);
  const authorization = input.execution.lostAck;
  if (
    !authorization ||
    authorization.candidateOrdinal !== input.candidate.ordinal ||
    authorization.resolution.kind !== "confirm-head-absent"
  ) {
    return;
  }
  const current = await readCandidate(
    options.sql,
    input.canonical.requestDigest,
    input.candidate.ordinal,
  );
  if (
    !current ||
    !candidateMatchesInput(current, input) ||
    current.detailState !== "delete_started"
  ) {
    return;
  }
  if (
    authorization.predecessorWorkerVersionId !== current.executionWorkerVersionId ||
    authorization.predecessorWorkerVersionId !== current.activeWorkerVersionId ||
    authorization.predecessorWorkerVersionId === input.execution.workerVersionId
  ) {
    return;
  }
  if (await options.objects.head(blobKey(current.digest))) return;
  const handoff = await executionHandoff(input, current, options.clock().getTime());
  await settleStartedDelete(
    options,
    input,
    current,
    "already_absent",
    authorization.quiescenceEvidenceDigest,
    handoff,
  );
}

export async function rearmExactArtifactRecoveryCandidate(
  options: ExactArtifactRecoveryCoordinatorOptions,
  input: ExactArtifactRecoveryRearm,
): Promise<void> {
  assertMutationBinding(input);
  const { authorization } = input;
  if (
    authorization.candidateOrdinal !== input.candidate.ordinal ||
    authorization.resolution.kind !== "reviewed-retry" ||
    authorization.resolution.observedEtag !== input.observedEtag
  ) {
    return;
  }
  const current = await readCandidate(
    options.sql,
    input.canonical.requestDigest,
    input.candidate.ordinal,
  );
  if (
    !current ||
    !candidateMatchesInput(current, input) ||
    current.kind !== "blob" ||
    (current.detailState !== "pending" && current.detailState !== "delete_started") ||
    authorization.resolution.candidateFence !== current.candidateFence + 2
  ) {
    return;
  }
  const expectedPredecessor =
    current.detailState === "delete_started"
      ? current.executionWorkerVersionId
      : current.activeWorkerVersionId;
  if (
    !expectedPredecessor ||
    expectedPredecessor !== current.activeWorkerVersionId ||
    authorization.predecessorWorkerVersionId !== expectedPredecessor ||
    input.execution.workerVersionId === expectedPredecessor
  ) {
    return;
  }
  const head = await options.objects.head(blobKey(current.digest));
  if (!head || head.etag !== input.observedEtag) return;

  const timestamp = options.clock().getTime();
  const handoff = await executionHandoff(input, current, timestamp);
  const token = recoveryGuardToken(options.randomId());
  const statements: SqlStatement[] = [
    recoveryCandidateGuard(token, input, current, timestamp, {
      requirePending: current.detailState === "pending",
      requireStarted: current.detailState === "delete_started",
      requireNoReference: true,
    }),
    insertExecutionHandoff(input.canonical.requestDigest, handoff),
  ];
  if (current.detailState === "delete_started") {
    statements.push(
      completedDeleteResult(input.canonical.requestDigest, current, timestamp, "etag_changed"),
      releaseDeleteLease(current, timestamp, "etag_changed"),
    );
  }
  statements.push(
    {
      sql: `UPDATE tf_artifact_gc_candidates
            SET state = 'retry', fence = fence + 1, expected_etag = ?,
                not_before = ?, last_outcome = 'etag_changed', updated_at = ?,
                deleted_at = NULL
            WHERE kind = 'blob' AND digest = ? AND fence = ?
              AND state = ?`,
      params: [
        input.observedEtag,
        timestamp + ARTIFACT_RECOVERY_QUARANTINE_MILLISECONDS,
        timestamp,
        current.digest,
        current.candidateFence,
        current.candidateState,
      ],
    },
    {
      sql: `UPDATE tf_artifact_recovery_candidates
            SET active_etag = ?, state = 'pending',
                reviewed_operation_id = ?, reviewed_candidate_fence = ?,
                review_evidence_digest = ?, quiescence_evidence_digest = ?,
                delete_operation_id = NULL, delete_lease_fence = NULL,
                execution_worker_version_id = NULL, result_digest = NULL,
                completed_at = NULL
            WHERE request_digest = ? AND ordinal = ? AND kind = 'blob'
              AND digest = ? AND state = ?`,
      params: [
        input.observedEtag,
        authorization.resolution.operationId,
        authorization.resolution.candidateFence,
        authorization.resolution.reviewEvidenceDigest,
        authorization.quiescenceEvidenceDigest,
        input.canonical.requestDigest,
        current.ordinal,
        current.digest,
        current.detailState,
      ],
    },
    activateExecutionHandoff(input.canonical.requestDigest, handoff),
    {
      sql: `UPDATE tf_artifact_recovery_once SET phase = 'settling'
            WHERE singleton = 1 AND request_digest = ? AND phase = 'prepared'`,
      params: [input.canonical.requestDigest],
    },
    deleteGuard(token),
  );

  try {
    const writes = await options.sql.batch(statements);
    const gcIndex = current.detailState === "delete_started" ? 4 : 2;
    const detailIndex = gcIndex + 1;
    if (
      (current.detailState === "delete_started" &&
        (writes[2]?.changes !== 1 || writes[3]?.changes !== 1)) ||
      writes[1]?.changes !== 1 ||
      writes[gcIndex]?.changes !== 1 ||
      writes[detailIndex]?.changes !== 1 ||
      writes[detailIndex + 1]?.changes !== 1 ||
      writes[detailIndex + 2]?.changes !== 1
    ) {
      throw new Error("exact artifact recovery reviewed rearm lost its fence");
    }
  } catch (error) {
    if (await reviewedRearmVisible(options.sql, input).catch(() => false)) return;
    if (constraint(error)) return;
    throw error;
  }
}

export async function completeExactArtifactRecoveryGroup(
  options: ExactArtifactRecoveryCoordinatorOptions,
  input: ExactArtifactRecoveryCompletion,
): Promise<void> {
  assertCompletionBinding(input);
  const [terminal, executionRows, handoffRows] = await Promise.all([
    options.sql.query(
      `SELECT ordinal, kind, digest, state, result_digest
       FROM tf_artifact_recovery_candidates
       WHERE request_digest = ? ORDER BY ordinal`,
      [input.canonical.requestDigest],
    ),
    options.sql.query(
      `SELECT preparing_worker_version_id, active_worker_version_id,
              execution_handoff_count, prepared_at
       FROM tf_artifact_recovery_once
       WHERE singleton = 1 AND request_digest = ?
         AND phase IN ('prepared', 'settling') AND detail_state = 'active'`,
      [input.canonical.requestDigest],
    ),
    options.sql.query(
      `SELECT sequence, candidate_ordinal, candidate_fence,
              predecessor_worker_version_id, successor_worker_version_id,
              resolution_kind, observed_etag, reviewed_operation_id,
              reviewed_candidate_fence, review_evidence_digest,
              quiescence_evidence_digest, activated_at, handoff_digest, purge_after
       FROM tf_artifact_recovery_execution_handoffs
       WHERE request_digest = ? ORDER BY sequence`,
      [input.canonical.requestDigest],
    ),
  ]);
  if (!terminalCandidateSet(terminal, input)) return;
  if (executionRows.length !== 1) return;
  const executionRow = executionRows[0] as Row;
  const preparingWorkerVersionId = text(executionRow, "preparing_worker_version_id");
  const activeWorkerVersionId = text(executionRow, "active_worker_version_id");
  const executionHandoffCount = integer(executionRow, "execution_handoff_count");
  const preparedAt = integer(executionRow, "prepared_at");
  if (activeWorkerVersionId !== input.execution.workerVersionId) return;
  const handoffs = handoffRows.map(executionHandoffRow);
  const executionLineageDigest = await validateExactArtifactRecoveryExecutionLineage({
    requestDigest: input.canonical.requestDigest,
    preparingWorkerVersionId,
    activeWorkerVersionId,
    expectedHandoffCount: executionHandoffCount,
    preparedAt,
    expectedPurgeAfter: null,
    handoffs,
  });
  if (!executionLineageDigest) return;
  const actualResultSetDigest = await exactArtifactRecoveryResultSetDigest({
    requestDigest: input.canonical.requestDigest,
    executionLineageDigest,
    results: terminal.map((row) => ({
      ordinal: integer(row, "ordinal"),
      kind: artifactKind(row.kind),
      digest: digest(row.digest),
      resultDigest: digest(row.result_digest),
    })),
  });
  if (actualResultSetDigest !== input.resultSetDigest) return;
  for (const memberDigest of input.canonical.request.memberDigests) {
    if (await options.objects.head(blobKey(memberDigest))) return;
  }
  const metadata = await options.sql.query(
    "SELECT 1 AS present FROM tf_artifact_manifests WHERE digest = ?",
    [input.canonical.request.manifestDigest],
  );
  if (metadata.length !== 0) return;

  const timestamp = options.clock().getTime();
  const purgeAfter =
    timestamp + input.canonical.request.retentionPolicy.detailRetentionMilliseconds;
  const token = recoveryGuardToken(options.randomId());
  const membersJson = JSON.stringify(input.canonical.request.memberDigests);
  try {
    const writes = await options.sql.batch([
      {
        sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
              SELECT ?, CASE WHEN EXISTS (
                SELECT 1 FROM tf_artifact_recovery_once
                WHERE singleton = 1 AND request_digest = ?
                  AND phase IN ('prepared', 'settling') AND detail_state = 'active'
                  AND active_worker_version_id = ? AND execution_handoff_count = ?
              ) AND (SELECT COUNT(*) FROM tf_artifact_recovery_candidates
                     WHERE request_digest = ? AND (
                       (kind = 'blob' AND state = 'deleted') OR
                       (kind = 'manifest' AND state = 'metadata_deleted')
                     )) = 29
                AND (SELECT COUNT(*) FROM tf_artifact_gc_candidates AS candidate
                     JOIN tf_artifact_recovery_candidates AS detail
                       ON detail.kind = candidate.kind AND detail.digest = candidate.digest
                     WHERE detail.request_digest = ? AND candidate.state = 'deleted') = 29
                AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_consumer_uncertainties
                  WHERE tenant_id = ? AND state = 'active'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_roots AS root
                  WHERE root.state = 'active' AND (
                    (root.target_kind = 'manifest' AND root.digest = ?) OR
                    (root.target_kind = 'blob' AND root.digest IN
                      (SELECT CAST(value AS TEXT) FROM json_each(?))) OR
                    (root.target_kind = 'manifest' AND EXISTS (
                      SELECT 1 FROM tf_artifact_manifest_members AS member
                      WHERE member.manifest_digest = root.digest
                        AND member.blob_digest IN
                          (SELECT CAST(value AS TEXT) FROM json_each(?))
                    ))
                  )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_holds
                  WHERE tenant_id = ? AND (
                    (kind = 'manifest' AND digest = ?) OR
                    (kind = 'blob' AND digest IN
                      (SELECT CAST(value AS TEXT) FROM json_each(?)))
                  )
                )
                AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_blob_io_leases
                  WHERE digest IN (SELECT CAST(value AS TEXT) FROM json_each(?))
                    AND state <> 'available'
                )
                AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_manifests WHERE digest = ?
                )
              THEN 1 ELSE 0 END`,
        params: [
          token,
          input.canonical.requestDigest,
          activeWorkerVersionId,
          executionHandoffCount,
          input.canonical.requestDigest,
          input.canonical.requestDigest,
          input.canonical.request.tenantId,
          input.canonical.request.manifestDigest,
          membersJson,
          membersJson,
          input.canonical.request.tenantId,
          input.canonical.request.manifestDigest,
          membersJson,
          membersJson,
          input.canonical.request.manifestDigest,
        ],
      },
      {
        sql: `UPDATE tf_artifact_recovery_once
              SET phase = 'complete', completed_at = ?, result_set_digest = ?,
                  purge_after = ?
              WHERE singleton = 1 AND request_digest = ?
                AND phase IN ('prepared', 'settling') AND detail_state = 'active'
                AND active_worker_version_id = ? AND execution_handoff_count = ?`,
        params: [
          timestamp,
          input.resultSetDigest,
          purgeAfter,
          input.canonical.requestDigest,
          activeWorkerVersionId,
          executionHandoffCount,
        ],
      },
      {
        sql: `UPDATE tf_artifact_owner_closure_receipts
              SET state = 'recovery_complete', purge_after = ?, updated_at = ?
              WHERE receipt_kind = 'exact_failed_run_recovery'
                AND recovery_request_digest = ? AND state = 'recovery_active'`,
        params: [purgeAfter, timestamp, input.canonical.requestDigest],
      },
      {
        sql: `UPDATE tf_artifact_recovery_details SET purge_after = ?
              WHERE request_digest = ? AND purge_after IS NULL`,
        params: [purgeAfter, input.canonical.requestDigest],
      },
      {
        sql: `UPDATE tf_artifact_recovery_execution_handoffs SET purge_after = ?
              WHERE request_digest = ? AND purge_after IS NULL`,
        params: [purgeAfter, input.canonical.requestDigest],
      },
      {
        sql: `UPDATE tf_artifact_recovery_candidates SET purge_after = ?
              WHERE request_digest = ?`,
        params: [purgeAfter, input.canonical.requestDigest],
      },
      deleteGuard(token),
    ]);
    if (
      writes[1]?.changes !== 1 ||
      writes[2]?.changes !== EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT ||
      writes[3]?.changes !== 1 ||
      writes[4]?.changes !== executionHandoffCount ||
      writes[5]?.changes !== EXACT_ARTIFACT_RECOVERY_CANDIDATE_COUNT
    ) {
      throw new Error("exact artifact recovery completion lost its fence");
    }
  } catch (error) {
    if (
      await completionVisible(
        options.sql,
        input.canonical.requestDigest,
        input.resultSetDigest,
      ).catch(() => false)
    ) {
      return;
    }
    if (constraint(error)) return;
    throw error;
  }
}

async function settleManifest(
  options: ExactArtifactRecoveryCoordinatorOptions,
  input: ExactArtifactRecoverySettlement,
  current: RecoveryCandidateState,
  timestamp: number,
): Promise<void> {
  const resultDigest = await candidateResultDigest(input, current, {
    outcome: "metadata_deleted",
    operationId: null,
    candidateFence: current.candidateFence + 1,
    leaseFence: null,
    executionWorkerVersionId: null,
    quiescenceEvidenceDigest: null,
  });
  const token = recoveryGuardToken(options.randomId());
  try {
    const writes = await options.sql.batch([
      recoveryCandidateGuard(token, input, current, timestamp, {
        requirePending: true,
        requireNoReference: true,
        requireDeletedMembers: true,
      }),
      {
        sql: `DELETE FROM tf_artifact_manifests
              WHERE digest = ? AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_roots
                WHERE state = 'active' AND target_kind = 'manifest' AND digest = ?
              )`,
        params: [current.digest, current.digest],
      },
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'deleted', fence = fence + 1, expected_etag = NULL,
                  attempts = attempts + 1, last_outcome = 'metadata_deleted',
                  updated_at = ?, deleted_at = ?
              WHERE kind = 'manifest' AND digest = ? AND state IN ('pending', 'retry')
                AND fence = ?`,
        params: [timestamp, timestamp, current.digest, current.candidateFence],
      },
      {
        sql: `UPDATE tf_artifact_recovery_candidates
              SET state = 'metadata_deleted', result_digest = ?, completed_at = ?
              WHERE request_digest = ? AND ordinal = ? AND kind = 'manifest'
                AND digest = ? AND state = 'pending'`,
        params: [
          resultDigest,
          timestamp,
          input.canonical.requestDigest,
          current.ordinal,
          current.digest,
        ],
      },
      {
        sql: `UPDATE tf_artifact_recovery_once SET phase = 'settling'
              WHERE singleton = 1 AND request_digest = ? AND phase = 'prepared'`,
        params: [input.canonical.requestDigest],
      },
      deleteGuard(token),
    ]);
    if (writes[1]?.changes !== 1 || writes[2]?.changes !== 1 || writes[3]?.changes !== 1) {
      throw new Error("exact artifact recovery manifest settlement lost its fence");
    }
  } catch (error) {
    if (
      await candidateResultVisible(options.sql, input, current.ordinal, resultDigest).catch(
        () => false,
      )
    ) {
      return;
    }
    if (constraint(error)) return;
    throw error;
  }
}

async function settleObservedAbsent(
  options: ExactArtifactRecoveryCoordinatorOptions,
  input: ExactArtifactRecoverySettlement,
  current: RecoveryCandidateState,
  timestamp: number,
): Promise<void> {
  if (current.kind !== "blob") return;
  const operationId = recoveryOperationId("observe-absent", options.randomId(), current);
  const candidateFence = current.candidateFence + 1;
  const resultDigest = await candidateResultDigest(input, current, {
    outcome: "already_absent",
    operationId,
    candidateFence,
    leaseFence: candidateFence,
    executionWorkerVersionId: input.execution.workerVersionId,
    quiescenceEvidenceDigest: null,
  });
  const token = recoveryGuardToken(options.randomId());
  try {
    const writes = await options.sql.batch([
      recoveryCandidateGuard(token, input, current, timestamp, {
        requirePending: true,
        requireNoReference: true,
      }),
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'deleted', fence = fence + 1, expected_etag = NULL,
                  attempts = attempts + 1, last_outcome = 'already_absent',
                  updated_at = ?, deleted_at = ?
              WHERE kind = 'blob' AND digest = ? AND state IN ('pending', 'retry')
                AND fence = ? AND not_before <= ?`,
        params: [timestamp, timestamp, current.digest, current.candidateFence, timestamp],
      },
      {
        sql: `UPDATE tf_artifact_recovery_candidates
              SET state = 'deleted', delete_operation_id = ?,
                  delete_lease_fence = ?, execution_worker_version_id = ?,
                  result_digest = ?, completed_at = ?
              WHERE request_digest = ? AND ordinal = ? AND kind = 'blob'
                AND digest = ? AND state = 'pending'`,
        params: [
          operationId,
          candidateFence,
          input.execution.workerVersionId,
          resultDigest,
          timestamp,
          input.canonical.requestDigest,
          current.ordinal,
          current.digest,
        ],
      },
      {
        sql: `UPDATE tf_artifact_recovery_once SET phase = 'settling'
              WHERE singleton = 1 AND request_digest = ? AND phase = 'prepared'`,
        params: [input.canonical.requestDigest],
      },
      deleteGuard(token),
    ]);
    if (writes[1]?.changes !== 1 || writes[2]?.changes !== 1) {
      throw new Error("exact artifact recovery absence settlement lost its fence");
    }
  } catch (error) {
    if (
      await candidateResultVisible(options.sql, input, current.ordinal, resultDigest).catch(
        () => false,
      )
    ) {
      return;
    }
    if (constraint(error)) return;
    throw error;
  }
}

async function settleStartedDelete(
  options: ExactArtifactRecoveryCoordinatorOptions,
  input: ExactArtifactRecoverySettlement,
  current: RecoveryCandidateState,
  outcome: "deleted" | "already_absent",
  quiescenceEvidenceDigest: Digest | null,
  handoff: ExactArtifactRecoveryExecutionHandoff | null,
): Promise<void> {
  if (
    current.kind !== "blob" ||
    current.detailState !== "delete_started" ||
    current.candidateState !== "deleting" ||
    current.leaseState !== "deleting" ||
    !current.deleteOperationId ||
    !current.deleteLeaseFence ||
    !current.executionWorkerVersionId
  ) {
    return;
  }
  const timestamp = options.clock().getTime();
  const resultDigest = await candidateResultDigest(input, current, {
    outcome,
    operationId: current.deleteOperationId,
    candidateFence: current.candidateFence,
    leaseFence: current.deleteLeaseFence,
    executionWorkerVersionId: current.executionWorkerVersionId,
    quiescenceEvidenceDigest,
  });
  const token = recoveryGuardToken(options.randomId());
  const statements: SqlStatement[] = [
    recoveryCandidateGuard(token, input, current, timestamp, {
      requireStarted: true,
      requireNoReference: true,
    }),
  ];
  if (handoff) {
    statements.push(insertExecutionHandoff(input.canonical.requestDigest, handoff));
  }
  statements.push(
    completedDeleteResult(input.canonical.requestDigest, current, timestamp, outcome),
    releaseDeleteLease(current, timestamp, outcome),
    {
      sql: `UPDATE tf_artifact_gc_candidates
            SET state = 'deleted', expected_etag = NULL, last_outcome = ?,
                updated_at = ?, deleted_at = ?
            WHERE kind = 'blob' AND digest = ? AND state = 'deleting'
              AND fence = ?`,
      params: [outcome, timestamp, timestamp, current.digest, current.candidateFence],
    },
    {
      sql: `UPDATE tf_artifact_recovery_candidates
            SET state = 'deleted', result_digest = ?, completed_at = ?
            WHERE request_digest = ? AND ordinal = ? AND kind = 'blob'
              AND digest = ? AND state = 'delete_started'
              AND delete_operation_id = ? AND delete_lease_fence = ?
              AND execution_worker_version_id = ?`,
      params: [
        resultDigest,
        timestamp,
        input.canonical.requestDigest,
        current.ordinal,
        current.digest,
        current.deleteOperationId,
        current.deleteLeaseFence,
        current.executionWorkerVersionId,
      ],
    },
  );
  if (handoff) {
    statements.push(activateExecutionHandoff(input.canonical.requestDigest, handoff));
  }
  statements.push(deleteGuard(token));
  try {
    const writes = await options.sql.batch(statements);
    const mutationCount = handoff ? 6 : 4;
    if (writes.slice(1, mutationCount + 1).some(({ changes }) => changes !== 1)) {
      throw new Error("exact artifact recovery delete settlement lost its fence");
    }
  } catch (error) {
    if (
      await candidateResultVisible(options.sql, input, current.ordinal, resultDigest).catch(
        () => false,
      )
    ) {
      return;
    }
    if (constraint(error)) return;
    throw error;
  }
}

async function executionHandoff(
  input: ExactArtifactRecoverySettlement,
  current: RecoveryCandidateState,
  activatedAt: number,
): Promise<ExactArtifactRecoveryExecutionHandoff> {
  const authorization = input.execution.lostAck;
  if (
    !authorization ||
    authorization.candidateOrdinal !== current.ordinal ||
    authorization.predecessorWorkerVersionId !== current.activeWorkerVersionId ||
    authorization.predecessorWorkerVersionId === input.execution.workerVersionId
  ) {
    throw new TypeError("exact artifact recovery execution handoff is invalid");
  }
  const reviewed =
    authorization.resolution.kind === "reviewed-retry" ? authorization.resolution : null;
  const digestInput = {
    sequence: current.executionHandoffCount + 1,
    candidateOrdinal: current.ordinal,
    candidateFence: current.candidateFence,
    predecessorWorkerVersionId: authorization.predecessorWorkerVersionId,
    successorWorkerVersionId: input.execution.workerVersionId,
    resolutionKind: authorization.resolution.kind,
    observedEtag: reviewed?.observedEtag ?? null,
    reviewedOperationId: reviewed?.operationId ?? null,
    reviewedCandidateFence: reviewed?.candidateFence ?? null,
    reviewEvidenceDigest: reviewed?.reviewEvidenceDigest ?? null,
    quiescenceEvidenceDigest: authorization.quiescenceEvidenceDigest,
    activatedAt,
  } satisfies Omit<ExactArtifactRecoveryExecutionHandoff, "handoffDigest" | "purgeAfter">;
  return {
    ...digestInput,
    handoffDigest: await exactArtifactRecoveryExecutionHandoffDigest(
      input.canonical.requestDigest,
      digestInput,
    ),
    purgeAfter: null,
  };
}

function insertExecutionHandoff(
  requestDigest: Digest,
  handoff: ExactArtifactRecoveryExecutionHandoff,
): SqlStatement {
  return {
    sql: `INSERT INTO tf_artifact_recovery_execution_handoffs
            (request_digest, sequence, candidate_ordinal, candidate_fence,
             predecessor_worker_version_id, successor_worker_version_id,
             resolution_kind, observed_etag, reviewed_operation_id,
             reviewed_candidate_fence, review_evidence_digest,
             quiescence_evidence_digest, activated_at, handoff_digest, purge_after)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
    params: [
      requestDigest,
      handoff.sequence,
      handoff.candidateOrdinal,
      handoff.candidateFence,
      handoff.predecessorWorkerVersionId,
      handoff.successorWorkerVersionId,
      handoff.resolutionKind,
      handoff.observedEtag,
      handoff.reviewedOperationId,
      handoff.reviewedCandidateFence,
      handoff.reviewEvidenceDigest,
      handoff.quiescenceEvidenceDigest,
      handoff.activatedAt,
      handoff.handoffDigest,
    ],
  };
}

function activateExecutionHandoff(
  requestDigest: Digest,
  handoff: ExactArtifactRecoveryExecutionHandoff,
): SqlStatement {
  return {
    sql: `UPDATE tf_artifact_recovery_once
          SET active_worker_version_id = ?, execution_handoff_count = ?
          WHERE singleton = 1 AND request_digest = ?
            AND active_worker_version_id = ? AND execution_handoff_count = ?
            AND phase IN ('prepared', 'settling') AND detail_state = 'active'`,
    params: [
      handoff.successorWorkerVersionId,
      handoff.sequence,
      requestDigest,
      handoff.predecessorWorkerVersionId,
      handoff.sequence - 1,
    ],
  };
}

function recoveryCandidateGuard(
  token: string,
  input: ExactArtifactRecoverySettlement,
  current: RecoveryCandidateState,
  timestamp: number,
  requirements: {
    readonly requirePending?: boolean;
    readonly requireStarted?: boolean;
    readonly requireNoReference: boolean;
    readonly requireDeletedMembers?: boolean;
  },
): SqlStatement {
  const request = input.canonical.request;
  const statePredicate = requirements.requireStarted
    ? `detail.state = 'delete_started' AND candidate.state = 'deleting'
       AND detail.delete_operation_id = ? AND detail.delete_lease_fence = ?
       AND detail.execution_worker_version_id = ?
       AND EXISTS (
         SELECT 1 FROM tf_artifact_blob_io_leases AS lease
         WHERE lease.digest = detail.digest AND lease.state = 'deleting'
           AND lease.operation_id = detail.delete_operation_id
           AND lease.fence = detail.delete_lease_fence
           AND lease.candidate_fence = candidate.fence
           AND lease.last_outcome = 'delete_started'
       )`
    : `detail.state = 'pending' AND candidate.state IN ('pending', 'retry')
       AND candidate.not_before <= ? AND candidate.expected_etag IS detail.active_etag`;
  const stateParams = requirements.requireStarted
    ? [current.deleteOperationId, current.deleteLeaseFence, current.executionWorkerVersionId]
    : [timestamp];
  const referencePredicate = requirements.requireNoReference
    ? `AND NOT EXISTS (
         SELECT 1 FROM tf_artifact_roots AS root
         WHERE root.state = 'active' AND (
           (detail.kind = 'manifest' AND root.target_kind = 'manifest'
             AND root.digest = detail.digest) OR
           (detail.kind = 'blob' AND (
             (root.target_kind = 'blob' AND root.digest = detail.digest) OR
             (root.target_kind = 'manifest' AND EXISTS (
               SELECT 1 FROM tf_artifact_manifest_members AS member
               WHERE member.manifest_digest = root.digest
                 AND member.blob_digest = detail.digest
             ))
           ))
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM tf_artifact_holds AS hold
         WHERE hold.tenant_id = recovery.tenant_id
           AND hold.kind = detail.kind AND hold.digest = detail.digest
       )`
    : "";
  const membersPredicate = requirements.requireDeletedMembers
    ? `AND (SELECT COUNT(*) FROM tf_artifact_recovery_candidates AS member
            WHERE member.request_digest = recovery.request_digest
              AND member.kind = 'blob' AND member.state = 'deleted') = 28`
    : "";
  return {
    sql: `INSERT INTO tf_artifact_gc_guards
            (token, valid, authority_kind, recovery_request_digest)
          SELECT ?, CASE WHEN EXISTS (
            SELECT 1
            FROM tf_artifact_recovery_once AS recovery
            JOIN tf_artifact_recovery_candidates AS detail
              ON detail.request_digest = recovery.request_digest
            JOIN tf_artifact_gc_candidates AS candidate
              ON candidate.kind = detail.kind AND candidate.digest = detail.digest
            WHERE recovery.singleton = 1 AND recovery.request_digest = ?
              AND recovery.tenant_id = ? AND recovery.manifest_digest = ?
              AND recovery.phase IN ('prepared', 'settling')
              AND recovery.active_worker_version_id = ?
              AND recovery.execution_handoff_count = ?
              AND detail.ordinal = ? AND detail.kind = ? AND detail.digest = ?
              AND candidate.fence = ? AND ${statePredicate}
              AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_consumer_uncertainties AS uncertainty
                WHERE uncertainty.tenant_id = recovery.tenant_id
                  AND uncertainty.state = 'active'
              )
              ${referencePredicate}
              ${membersPredicate}
          ) THEN 1 ELSE 0 END, 'exact_failed_run_recovery', ?`,
    params: [
      token,
      input.canonical.requestDigest,
      request.tenantId,
      request.manifestDigest,
      current.activeWorkerVersionId,
      current.executionHandoffCount,
      current.ordinal,
      current.kind,
      current.digest,
      current.candidateFence,
      ...stateParams,
      input.canonical.requestDigest,
    ],
  };
}

function completedDeleteResult(
  requestDigest: Digest,
  current: RecoveryCandidateState,
  timestamp: number,
  outcome: "deleted" | "already_absent" | "etag_changed",
): SqlStatement {
  return {
    sql: `INSERT INTO tf_artifact_blob_io_results
            (operation_id, digest, operation_kind, lease_fence, candidate_fence,
             tenant_id, principal_id, upload_id, upload_fence, root_fence,
             expected_size, outcome, completed_at, receipt_kind,
             recovery_request_digest)
          SELECT operation_id, digest, 'delete', fence, candidate_fence,
                 NULL, NULL, NULL, NULL, NULL, NULL, ?, ?,
                 'exact_failed_run_recovery', ?
          FROM tf_artifact_blob_io_leases
          WHERE digest = ? AND state = 'deleting' AND operation_id = ?
            AND fence = ? AND candidate_fence = ?
            AND last_outcome = 'delete_started'`,
    params: [
      outcome,
      timestamp,
      requestDigest,
      current.digest,
      current.deleteOperationId,
      current.deleteLeaseFence,
      current.candidateFence,
    ],
  };
}

function releaseDeleteLease(
  current: RecoveryCandidateState,
  timestamp: number,
  outcome: "deleted" | "already_absent" | "etag_changed",
): SqlStatement {
  return {
    sql: `UPDATE tf_artifact_blob_io_leases
          SET state = 'available', fence = fence + 1,
              tenant_id = NULL, principal_id = NULL, upload_id = NULL,
              upload_fence = NULL, root_fence = NULL, expected_size = NULL,
              candidate_fence = NULL, lease_expires_at = NULL,
              last_outcome = ?, updated_at = ?
          WHERE digest = ? AND state = 'deleting' AND operation_id = ?
            AND fence = ? AND candidate_fence = ?
            AND last_outcome = 'delete_started'`,
    params: [
      outcome,
      timestamp,
      current.digest,
      current.deleteOperationId,
      current.deleteLeaseFence,
      current.candidateFence,
    ],
  };
}

async function readCandidate(
  sql: Sql,
  requestDigest: Digest,
  ordinal: number,
): Promise<RecoveryCandidateState | null> {
  const rows = await sql.query(
    `SELECT recovery.phase, recovery.tenant_id,
            recovery.preparing_worker_version_id,
            recovery.active_worker_version_id, recovery.execution_handoff_count,
            detail.ordinal, detail.kind, detail.digest, detail.active_etag,
            detail.state AS detail_state, detail.reviewed_operation_id,
            detail.reviewed_candidate_fence, detail.review_evidence_digest,
            detail.quiescence_evidence_digest, detail.delete_operation_id,
            detail.delete_lease_fence, detail.execution_worker_version_id,
            detail.result_digest, candidate.state AS candidate_state,
            candidate.fence AS candidate_fence, candidate.not_before,
            candidate.expected_etag, lease.state AS lease_state,
            lease.operation_id AS lease_operation_id,
            lease.fence AS lease_fence, lease.candidate_fence AS lease_candidate_fence,
            lease.last_outcome AS lease_outcome
     FROM tf_artifact_recovery_once AS recovery
     JOIN tf_artifact_recovery_candidates AS detail
       ON detail.request_digest = recovery.request_digest
     JOIN tf_artifact_gc_candidates AS candidate
       ON candidate.kind = detail.kind AND candidate.digest = detail.digest
     LEFT JOIN tf_artifact_blob_io_leases AS lease
       ON detail.kind = 'blob' AND lease.digest = detail.digest
     WHERE recovery.singleton = 1 AND recovery.request_digest = ?
       AND detail.ordinal = ?`,
    [requestDigest, ordinal],
  );
  if (rows.length !== 1) return null;
  const row = rows[0] as Row;
  const phase = oneOf(row.phase, ["prepared", "settling", "complete", "revoked"] as const);
  const kind = artifactKind(row.kind);
  const detailState = oneOf(row.detail_state, [
    "pending",
    "delete_started",
    "deleted",
    "metadata_deleted",
  ] as const);
  const candidateState = oneOf(row.candidate_state, [
    "pending",
    "deleting",
    "retry",
    "deleted",
    "cancelled",
  ] as const);
  const leaseState =
    row.lease_state === null
      ? null
      : oneOf(row.lease_state, ["available", "writing", "deleting"] as const);
  return {
    phase,
    tenantId: text(row, "tenant_id"),
    preparingWorkerVersionId: text(row, "preparing_worker_version_id"),
    activeWorkerVersionId: text(row, "active_worker_version_id"),
    executionHandoffCount: integer(row, "execution_handoff_count"),
    ordinal: integer(row, "ordinal"),
    kind,
    digest: digest(row.digest),
    activeEtag: nullableText(row.active_etag),
    detailState,
    reviewedOperationId: nullableText(row.reviewed_operation_id),
    reviewedCandidateFence: nullableInteger(row.reviewed_candidate_fence),
    reviewEvidenceDigest:
      row.review_evidence_digest === null ? null : digest(row.review_evidence_digest),
    quiescenceEvidenceDigest:
      row.quiescence_evidence_digest === null ? null : digest(row.quiescence_evidence_digest),
    deleteOperationId: nullableText(row.delete_operation_id),
    deleteLeaseFence: nullableInteger(row.delete_lease_fence),
    executionWorkerVersionId: nullableText(row.execution_worker_version_id),
    resultDigest: row.result_digest === null ? null : digest(row.result_digest),
    candidateState,
    candidateFence: integer(row, "candidate_fence"),
    notBefore: integer(row, "not_before"),
    expectedEtag: nullableText(row.expected_etag),
    leaseState,
    leaseOperationId: nullableText(row.lease_operation_id),
    leaseFence: nullableInteger(row.lease_fence),
    leaseCandidateFence: nullableInteger(row.lease_candidate_fence),
    leaseOutcome: nullableText(row.lease_outcome),
  };
}

function assertMutationBinding(input: ExactArtifactRecoverySettlement): void {
  const { canonical, execution, candidate } = input;
  const request = canonical.request;
  const expectedKind =
    candidate.ordinal < EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT ? "blob" : "manifest";
  const expectedDigest =
    expectedKind === "blob" ? request.memberDigests[candidate.ordinal] : request.manifestDigest;
  if (
    execution.pinnedRequestDigest !== canonical.requestDigest ||
    execution.r2IdentityDigest !== request.r2.identityDigest ||
    execution.sourceCommit !== request.source.commit ||
    execution.sourceVersion !== request.source.version ||
    candidate.kind !== expectedKind ||
    candidate.digest !== expectedDigest
  ) {
    throw new TypeError("exact artifact recovery mutation binding is invalid");
  }
}

function assertCompletionBinding(input: ExactArtifactRecoveryCompletion): void {
  const { canonical, execution } = input;
  if (
    execution.pinnedRequestDigest !== canonical.requestDigest ||
    execution.r2IdentityDigest !== canonical.request.r2.identityDigest ||
    execution.sourceCommit !== canonical.request.source.commit ||
    execution.sourceVersion !== canonical.request.source.version
  ) {
    throw new TypeError("exact artifact recovery completion binding is invalid");
  }
}

function candidateMatchesInput(
  current: RecoveryCandidateState,
  input: ExactArtifactRecoverySettlement,
): boolean {
  const candidate = input.candidate;
  return (
    current.tenantId === input.canonical.request.tenantId &&
    current.ordinal === candidate.ordinal &&
    current.kind === candidate.kind &&
    current.digest === candidate.digest &&
    current.detailState === candidate.state &&
    current.candidateFence === candidate.fence &&
    current.notBefore === candidate.notBefore &&
    current.activeEtag === candidate.activeEtag &&
    current.deleteOperationId === candidate.deleteOperationId &&
    current.deleteLeaseFence === candidate.deleteLeaseFence &&
    current.executionWorkerVersionId === candidate.executionWorkerVersionId
  );
}

function executionHandoffRow(row: Row): ExactArtifactRecoveryExecutionHandoff {
  return {
    sequence: integer(row, "sequence"),
    candidateOrdinal: integer(row, "candidate_ordinal"),
    candidateFence: integer(row, "candidate_fence"),
    predecessorWorkerVersionId: text(row, "predecessor_worker_version_id"),
    successorWorkerVersionId: text(row, "successor_worker_version_id"),
    resolutionKind: oneOf(row.resolution_kind, ["confirm-head-absent", "reviewed-retry"] as const),
    observedEtag: nullableText(row.observed_etag),
    reviewedOperationId: nullableText(row.reviewed_operation_id),
    reviewedCandidateFence: nullableInteger(row.reviewed_candidate_fence),
    reviewEvidenceDigest:
      row.review_evidence_digest === null ? null : digest(row.review_evidence_digest),
    quiescenceEvidenceDigest: digest(row.quiescence_evidence_digest),
    activatedAt: integer(row, "activated_at"),
    handoffDigest: digest(row.handoff_digest),
    purgeAfter: nullableInteger(row.purge_after),
  };
}

function reviewedDelete(
  input: ExactArtifactRecoverySettlement,
  current: RecoveryCandidateState,
): Extract<
  NonNullable<ExactArtifactRecoverySettlement["execution"]["lostAck"]>["resolution"],
  {
    kind: "reviewed-retry";
  }
> | null {
  const authorization = input.execution.lostAck;
  if (
    !authorization ||
    authorization.candidateOrdinal !== current.ordinal ||
    authorization.resolution.kind !== "reviewed-retry" ||
    authorization.resolution.operationId !== current.reviewedOperationId ||
    authorization.resolution.candidateFence !== current.reviewedCandidateFence ||
    authorization.resolution.reviewEvidenceDigest !== current.reviewEvidenceDigest ||
    authorization.quiescenceEvidenceDigest !== current.quiescenceEvidenceDigest ||
    authorization.resolution.observedEtag !== current.activeEtag
  ) {
    return null;
  }
  return authorization.resolution;
}

async function candidateResultDigest(
  input: ExactArtifactRecoverySettlement,
  current: RecoveryCandidateState,
  result: {
    readonly outcome: "deleted" | "already_absent" | "metadata_deleted";
    readonly operationId: string | null;
    readonly candidateFence: number;
    readonly leaseFence: number | null;
    readonly executionWorkerVersionId: string | null;
    readonly quiescenceEvidenceDigest: Digest | null;
  },
): Promise<Digest> {
  return await canonicalDigest({
    kind: "takoserver.exact-artifact-recovery-candidate-result@v2",
    requestDigest: input.canonical.requestDigest,
    ordinal: current.ordinal,
    candidateKind: current.kind,
    digest: current.digest,
    preparedEtag: current.activeEtag,
    ...result,
  });
}

function terminalCandidateSet(
  rows: readonly Row[],
  input: ExactArtifactRecoveryCompletion,
): boolean {
  if (rows.length !== EXACT_ARTIFACT_RECOVERY_CANDIDATE_COUNT) return false;
  for (let ordinal = 0; ordinal < rows.length; ordinal += 1) {
    const row = rows[ordinal];
    if (!row || integer(row, "ordinal") !== ordinal) return false;
    const expectedKind = ordinal < EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT ? "blob" : "manifest";
    const expectedDigest =
      expectedKind === "blob"
        ? input.canonical.request.memberDigests[ordinal]
        : input.canonical.request.manifestDigest;
    if (
      artifactKind(row.kind) !== expectedKind ||
      digest(row.digest) !== expectedDigest ||
      row.state !== (expectedKind === "blob" ? "deleted" : "metadata_deleted") ||
      !digestOrNull(row.result_digest)
    ) {
      return false;
    }
  }
  return true;
}

async function deleteStartVisible(
  sql: Sql,
  input: ExactArtifactRecoverySettlement,
  current: RecoveryCandidateState,
  operationId: string,
): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 AS visible
     FROM tf_artifact_recovery_candidates AS detail
     JOIN tf_artifact_gc_candidates AS candidate
       ON candidate.kind = detail.kind AND candidate.digest = detail.digest
     JOIN tf_artifact_blob_io_leases AS lease ON lease.digest = detail.digest
     WHERE detail.request_digest = ? AND detail.ordinal = ?
       AND detail.state = 'delete_started' AND detail.delete_operation_id = ?
       AND detail.execution_worker_version_id = ?
       AND candidate.state = 'deleting' AND candidate.fence = ?
       AND lease.state = 'deleting' AND lease.operation_id = ?
       AND lease.last_outcome = 'delete_started'`,
    [
      input.canonical.requestDigest,
      current.ordinal,
      operationId,
      input.execution.workerVersionId,
      current.candidateFence + 1,
      operationId,
    ],
  );
  return rows.length === 1;
}

async function reviewedRearmVisible(sql: Sql, input: ExactArtifactRecoveryRearm): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 AS visible
     FROM tf_artifact_recovery_candidates AS detail
     JOIN tf_artifact_gc_candidates AS candidate
       ON candidate.kind = detail.kind AND candidate.digest = detail.digest
     JOIN tf_artifact_recovery_once AS recovery
       ON recovery.request_digest = detail.request_digest
     JOIN tf_artifact_recovery_execution_handoffs AS handoff
       ON handoff.request_digest = recovery.request_digest
      AND handoff.sequence = recovery.execution_handoff_count
     WHERE detail.request_digest = ? AND detail.ordinal = ?
       AND detail.state = 'pending' AND detail.active_etag = ?
       AND detail.reviewed_operation_id = ?
       AND detail.reviewed_candidate_fence = ?
       AND detail.review_evidence_digest = ?
       AND detail.quiescence_evidence_digest = ?
       AND candidate.state = 'retry' AND candidate.fence = ?
       AND candidate.expected_etag = ?
       AND recovery.active_worker_version_id = ?
       AND handoff.predecessor_worker_version_id = ?
       AND handoff.successor_worker_version_id = ?`,
    [
      input.canonical.requestDigest,
      input.candidate.ordinal,
      input.observedEtag,
      input.authorization.resolution.operationId,
      input.authorization.resolution.candidateFence,
      input.authorization.resolution.reviewEvidenceDigest,
      input.authorization.quiescenceEvidenceDigest,
      input.authorization.resolution.candidateFence - 1,
      input.observedEtag,
      input.execution.workerVersionId,
      input.authorization.predecessorWorkerVersionId,
      input.execution.workerVersionId,
    ],
  );
  return rows.length === 1;
}

async function candidateResultVisible(
  sql: Sql,
  input: ExactArtifactRecoverySettlement,
  ordinal: number,
  resultDigest: Digest,
): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 AS visible FROM tf_artifact_recovery_candidates
     WHERE request_digest = ? AND ordinal = ? AND result_digest = ?
       AND state IN ('deleted', 'metadata_deleted')`,
    [input.canonical.requestDigest, ordinal, resultDigest],
  );
  return rows.length === 1;
}

async function completionVisible(
  sql: Sql,
  requestDigest: Digest,
  resultSetDigest: Digest,
): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 AS visible FROM tf_artifact_recovery_once
     WHERE singleton = 1 AND request_digest = ? AND phase = 'complete'
       AND result_set_digest = ?`,
    [requestDigest, resultSetDigest],
  );
  return rows.length === 1;
}

function recoveryOperationId(
  prefix: string,
  randomId: string,
  current: RecoveryCandidateState,
): string {
  const random = randomId.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 64);
  if (random.length === 0) throw new Error("exact artifact recovery operation id is empty");
  return `recovery-${prefix}-${random}-${current.ordinal}-${current.digest.slice(-12)}`.slice(
    0,
    128,
  );
}

function recoveryGuardToken(randomId: string): string {
  const random = randomId.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 96);
  if (random.length === 0) throw new Error("exact artifact recovery guard id is empty");
  return `arg_${random}`;
}

function deleteGuard(token: string): SqlStatement {
  return { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] };
}

function blobKey(value: Digest): string {
  return `art/${value.slice("sha256:".length)}`;
}

function constraint(error: unknown): boolean {
  return error instanceof SqlError && error.code === "constraint";
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`invalid exact artifact recovery ${key}`);
  return value;
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("invalid exact artifact recovery nullable text");
  return value;
}

function integer(row: Row, key: string): number {
  const value = row[key];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid exact artifact recovery ${key}`);
  }
  return value;
}

function nullableInteger(value: unknown): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error("invalid exact artifact recovery nullable integer");
  }
  return value;
}

function digest(value: unknown): Digest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error("invalid exact artifact recovery digest");
  }
  return value as Digest;
}

function digestOrNull(value: unknown): Digest | null {
  return value === null ? null : digest(value);
}

function artifactKind(value: unknown): "blob" | "manifest" {
  if (value !== "blob" && value !== "manifest") {
    throw new Error("invalid exact artifact recovery artifact kind");
  }
  return value;
}

function oneOf<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
): Values[number] {
  if (typeof value !== "string" || !values.includes(value)) {
    throw new Error("invalid exact artifact recovery state");
  }
  return value as Values[number];
}
