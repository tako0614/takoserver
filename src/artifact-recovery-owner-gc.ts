import {
  canonicalArtifactRecoveryRequest,
  type Digest,
  EXACT_ARTIFACT_RECOVERY_CANDIDATE_COUNT,
  EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT,
  EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT,
  type ExactArtifactRecoveryExecutionHandoff,
  exactArtifactRecoveryResultSetDigest,
  validateExactArtifactRecoveryExecutionLineage,
} from "./artifact-recovery.ts";
import { canonicalDigest, canonicalJson, isSha256Digest } from "./json.ts";
import type { Clock, ObjectStoreAccess, Row, Sql, SqlStatement } from "./ports.ts";

export const EXACT_ARTIFACT_RECOVERY_PURGE_AUTHORIZATION_FORMAT =
  "takoserver.exact-failed-run-artifact-recovery-purge-authorization@v1" as const;
export interface ExactArtifactRecoveryPurgeAuthorization {
  readonly kind: typeof EXACT_ARTIFACT_RECOVERY_PURGE_AUTHORIZATION_FORMAT;
  readonly requestDigest: Digest;
  readonly workerVersionId: string;
  /** Digest of the already verified, signed service-binding invocation. */
  readonly invocationDigest: Digest;
  readonly authorizedAt: number;
}

export interface ExactArtifactRecoveryOwnerGcOptions {
  readonly sql: Sql;
  readonly objects: Pick<ObjectStoreAccess, "head">;
  readonly authorization: ExactArtifactRecoveryPurgeAuthorization;
  readonly clock: Clock;
  readonly randomId: () => string;
}

export type ExactArtifactRecoveryOwnerGcResult =
  | {
      readonly outcome: "purged" | "already_purged";
      readonly requestDigest: Digest;
      readonly resultSetDigest: Digest;
    }
  | {
      readonly outcome: "blocked";
      readonly blocker: string;
    };

interface RecoverySingleton {
  readonly requestDigest: Digest;
  readonly tenantId: string;
  readonly manifestDigest: Digest;
  readonly memberSetDigest: Digest;
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
  readonly purgeWorkerVersionId: string | null;
  readonly purgeAuthorizationDigest: Digest | null;
  readonly purgeAuthorizedAt: number | null;
  readonly detailState: "active" | "purging" | "purged";
}

/**
 * Purges only one incident's detailed recovery receipts. The singleton is
 * intentionally retained as the compact authorization and terminal result.
 * This is composed only by the still service-bound route-less Worker. Its
 * signed operator invocation and R2 absence are checked before the D1 binding
 * transaction; the overlay and Worker retire only after purged readback.
 */
export async function purgeExactArtifactRecoveryDetails(
  options: ExactArtifactRecoveryOwnerGcOptions,
  requestDigest: Digest,
): Promise<ExactArtifactRecoveryOwnerGcResult> {
  if (!isSha256Digest(requestDigest)) throw new TypeError("invalid recovery request digest");
  const singleton = await readSingleton(options.sql, requestDigest);
  if (!singleton) return blocked("terminal_receipt_missing");
  if (singleton.phase !== "complete" || !singleton.resultSetDigest) {
    return blocked("recovery_not_complete");
  }
  if (singleton.detailState === "purged") {
    return {
      outcome: "already_purged",
      requestDigest,
      resultSetDigest: singleton.resultSetDigest,
    };
  }
  if (singleton.detailState !== "active" || singleton.purgeAfter === null) {
    return blocked("detail_purge_incomplete");
  }
  const now = options.clock().getTime();
  if (now < singleton.purgeAfter) return blocked("detail_retention_active");

  const detailRows = await options.sql.query(
    `SELECT request_json, prepared_worker_version_id, purge_after
     FROM tf_artifact_recovery_details WHERE request_digest = ?`,
    [requestDigest],
  );
  const detail = detailRows[0];
  if (
    detailRows.length !== 1 ||
    typeof detail?.request_json !== "string" ||
    detail.prepared_worker_version_id !== singleton.preparingWorkerVersionId ||
    detail.purge_after !== singleton.purgeAfter
  ) {
    return blocked("durable_detail_mismatch");
  }
  let canonical: Awaited<ReturnType<typeof canonicalArtifactRecoveryRequest>>;
  try {
    canonical = await canonicalArtifactRecoveryRequest(JSON.parse(detail.request_json));
  } catch {
    return blocked("durable_detail_mismatch");
  }
  if (
    canonical.requestDigest !== requestDigest ||
    canonical.canonicalJson !== detail.request_json ||
    canonical.request.tenantId !== singleton.tenantId ||
    canonical.request.manifestDigest !== singleton.manifestDigest ||
    canonical.request.memberSetDigest !== singleton.memberSetDigest ||
    canonical.request.r2.identityDigest !== singleton.r2IdentityDigest ||
    canonical.request.source.commit !== singleton.sourceCommit ||
    canonical.request.source.version !== singleton.sourceVersion ||
    canonical.request.retentionPolicy.kind !== singleton.retentionPolicyKind ||
    canonical.request.retentionPolicy.evidenceDigest !== singleton.retentionPolicyDigest ||
    canonical.request.retentionPolicy.detailRetentionMilliseconds !==
      singleton.detailRetentionMilliseconds
  ) {
    return blocked("durable_detail_mismatch");
  }

  if (!validPurgeAuthorization(options.authorization, singleton, now)) {
    return blocked("purge_authorization_invalid");
  }
  const purgeAuthorizationDigest = await canonicalDigest(options.authorization);

  for (const memberDigest of canonical.request.memberDigests) {
    if (await options.objects.head(blobKey(memberDigest))) {
      return blocked("object_absence_readback_failed");
    }
  }

  const [candidates, handoffRows] = await Promise.all([
    options.sql.query(
      `SELECT ordinal, kind, digest, state, result_digest, purge_after
       FROM tf_artifact_recovery_candidates
       WHERE request_digest = ? ORDER BY ordinal`,
      [requestDigest],
    ),
    options.sql.query(
      `SELECT sequence, candidate_ordinal, candidate_fence,
              predecessor_worker_version_id, successor_worker_version_id,
              resolution_kind, observed_etag, reviewed_operation_id,
              reviewed_candidate_fence, review_evidence_digest,
              quiescence_evidence_digest, activated_at, handoff_digest, purge_after
       FROM tf_artifact_recovery_execution_handoffs
       WHERE request_digest = ? ORDER BY sequence`,
      [requestDigest],
    ),
  ]);
  const handoffs = handoffRows.map(executionHandoffRow);
  const executionLineageDigest = await validateExactArtifactRecoveryExecutionLineage({
    requestDigest,
    preparingWorkerVersionId: singleton.preparingWorkerVersionId,
    activeWorkerVersionId: singleton.activeWorkerVersionId,
    expectedHandoffCount: singleton.executionHandoffCount,
    preparedAt: singleton.preparedAt,
    expectedPurgeAfter: singleton.purgeAfter,
    handoffs,
  });
  if (!executionLineageDigest) return blocked("execution_handoff_mismatch");
  const resultSetDigest = await terminalResultSetDigest(
    requestDigest,
    candidates,
    canonical.request,
    executionLineageDigest,
  );
  if (!resultSetDigest || resultSetDigest !== singleton.resultSetDigest) {
    return blocked("terminal_result_set_mismatch");
  }

  const recoveryIoRows = await options.sql.query(
    `SELECT COUNT(*) AS total FROM tf_artifact_blob_io_results
     WHERE receipt_kind = 'exact_failed_run_recovery'
       AND recovery_request_digest = ?`,
    [requestDigest],
  );
  const recoveryIoCount = integer(recoveryIoRows[0], "total");
  const token = guardToken(options.randomId());
  const timestamp = options.clock().getTime();
  if (timestamp < singleton.purgeAfter) return blocked("detail_retention_active");
  const membersJson = canonicalJson(canonical.request.memberDigests);

  const statements: SqlStatement[] = [
    purgeGuard({
      token,
      requestDigest,
      tenantId: singleton.tenantId,
      manifestDigest: singleton.manifestDigest,
      membersJson,
      resultSetDigest,
      purgeAfter: singleton.purgeAfter,
      recoveryIoCount,
      executionHandoffCount: singleton.executionHandoffCount,
    }),
    {
      sql: `UPDATE tf_artifact_recovery_once
            SET detail_state = 'purging', purge_worker_version_id = ?,
                purge_authorization_digest = ?, purge_authorized_at = ?
            WHERE singleton = 1 AND request_digest = ? AND phase = 'complete'
              AND detail_state = 'active' AND purge_after <= ?`,
      params: [
        singleton.activeWorkerVersionId,
        purgeAuthorizationDigest,
        options.authorization.authorizedAt,
        requestDigest,
        timestamp,
      ],
    },
    {
      sql: `DELETE FROM tf_artifact_blob_io_results
            WHERE receipt_kind = 'exact_failed_run_recovery'
              AND recovery_request_digest = ?`,
      params: [requestDigest],
    },
    {
      sql: `DELETE FROM tf_artifact_gc_candidates
            WHERE EXISTS (
              SELECT 1 FROM tf_artifact_recovery_candidates AS detail
              WHERE detail.request_digest = ?
                AND detail.kind = tf_artifact_gc_candidates.kind
                AND detail.digest = tf_artifact_gc_candidates.digest
            )`,
      params: [requestDigest],
    },
    {
      sql: `DELETE FROM tf_artifact_owner_closure_receipts
            WHERE receipt_kind = 'exact_failed_run_recovery'
              AND recovery_request_digest = ?`,
      params: [requestDigest],
    },
    {
      sql: "DELETE FROM tf_artifact_recovery_candidates WHERE request_digest = ?",
      params: [requestDigest],
    },
    {
      sql: "DELETE FROM tf_artifact_recovery_execution_handoffs WHERE request_digest = ?",
      params: [requestDigest],
    },
    {
      sql: "DELETE FROM tf_artifact_recovery_details WHERE request_digest = ?",
      params: [requestDigest],
    },
    {
      sql: `UPDATE tf_artifact_recovery_once
            SET detail_state = 'purged', details_purged_at = ?
            WHERE singleton = 1 AND request_digest = ? AND phase = 'complete'
              AND detail_state = 'purging'
              AND purge_authorization_digest = ?`,
      params: [timestamp, requestDigest, purgeAuthorizationDigest],
    },
    { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
  ];

  try {
    const writes = await options.sql.batch(statements);
    if (
      writes[1]?.changes !== 1 ||
      writes[2]?.changes !== recoveryIoCount ||
      writes[3]?.changes !== EXACT_ARTIFACT_RECOVERY_CANDIDATE_COUNT ||
      writes[4]?.changes !== EXACT_ARTIFACT_RECOVERY_UPLOAD_COUNT ||
      writes[5]?.changes !== EXACT_ARTIFACT_RECOVERY_CANDIDATE_COUNT ||
      writes[6]?.changes !== singleton.executionHandoffCount ||
      writes[7]?.changes !== 1 ||
      writes[8]?.changes !== 1
    ) {
      throw new Error("exact artifact recovery detail GC lost its fence");
    }
  } catch (error) {
    const visible = await readSingleton(options.sql, requestDigest).catch(() => null);
    if (visible?.detailState !== "purged") throw error;
  }
  return { outcome: "purged", requestDigest, resultSetDigest };
}

function purgeGuard(input: {
  readonly token: string;
  readonly requestDigest: Digest;
  readonly tenantId: string;
  readonly manifestDigest: Digest;
  readonly membersJson: string;
  readonly resultSetDigest: Digest;
  readonly purgeAfter: number;
  readonly recoveryIoCount: number;
  readonly executionHandoffCount: number;
}): SqlStatement {
  return {
    sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
          SELECT ?, CASE WHEN EXISTS (
            SELECT 1 FROM tf_artifact_recovery_once
            WHERE singleton = 1 AND request_digest = ? AND tenant_id = ?
              AND manifest_digest = ? AND phase = 'complete'
              AND detail_state = 'active' AND result_set_digest = ?
              AND purge_after = ?
          )
            AND EXISTS (
              SELECT 1 FROM tf_artifact_recovery_details
              WHERE request_digest = ? AND purge_after = ?
            )
            AND (SELECT COUNT(*) FROM tf_artifact_recovery_candidates
                 WHERE request_digest = ? AND purge_after = ? AND (
                   (kind = 'blob' AND state = 'deleted') OR
                   (kind = 'manifest' AND state = 'metadata_deleted')
                 )) = 29
            AND (SELECT COUNT(*) FROM tf_artifact_gc_candidates AS candidate
                 JOIN tf_artifact_recovery_candidates AS detail
                   ON detail.kind = candidate.kind AND detail.digest = candidate.digest
                 WHERE detail.request_digest = ? AND candidate.state = 'deleted') = 29
            AND (SELECT COUNT(*) FROM tf_artifact_owner_closure_receipts
                 WHERE receipt_kind = 'exact_failed_run_recovery'
                   AND recovery_request_digest = ? AND state = 'recovery_complete'
                   AND purge_after = ?) = 5
            AND (SELECT COUNT(*) FROM tf_artifact_blob_io_results
                 WHERE receipt_kind = 'exact_failed_run_recovery'
                   AND recovery_request_digest = ?) = ?
            AND (SELECT COUNT(*) FROM tf_artifact_recovery_execution_handoffs
                 WHERE request_digest = ? AND purge_after = ?) = ?
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
              WHERE (kind = 'manifest' AND digest = ?) OR
                (kind = 'blob' AND digest IN
                  (SELECT CAST(value AS TEXT) FROM json_each(?)))
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
      input.token,
      input.requestDigest,
      input.tenantId,
      input.manifestDigest,
      input.resultSetDigest,
      input.purgeAfter,
      input.requestDigest,
      input.purgeAfter,
      input.requestDigest,
      input.purgeAfter,
      input.requestDigest,
      input.requestDigest,
      input.purgeAfter,
      input.requestDigest,
      input.recoveryIoCount,
      input.requestDigest,
      input.purgeAfter,
      input.executionHandoffCount,
      input.tenantId,
      input.manifestDigest,
      input.membersJson,
      input.membersJson,
      input.manifestDigest,
      input.membersJson,
      input.membersJson,
      input.manifestDigest,
    ],
  };
}

async function terminalResultSetDigest(
  requestDigest: Digest,
  rows: readonly Row[],
  request: Awaited<ReturnType<typeof canonicalArtifactRecoveryRequest>>["request"],
  executionLineageDigest: Digest,
): Promise<Digest | null> {
  if (rows.length !== EXACT_ARTIFACT_RECOVERY_CANDIDATE_COUNT) return null;
  const results: {
    ordinal: number;
    kind: "blob" | "manifest";
    digest: Digest;
    resultDigest: Digest;
  }[] = [];
  for (let ordinal = 0; ordinal < rows.length; ordinal += 1) {
    const row = rows[ordinal];
    if (!row) return null;
    const kind = ordinal < EXACT_ARTIFACT_RECOVERY_MEMBER_COUNT ? "blob" : "manifest";
    const expectedDigest =
      kind === "blob" ? request.memberDigests[ordinal] : request.manifestDigest;
    if (
      !expectedDigest ||
      row.ordinal !== ordinal ||
      row.kind !== kind ||
      row.digest !== expectedDigest ||
      row.state !== (kind === "blob" ? "deleted" : "metadata_deleted") ||
      row.purge_after === null ||
      !isSha256Digest(row.result_digest)
    ) {
      return null;
    }
    results.push({ ordinal, kind, digest: expectedDigest, resultDigest: row.result_digest });
  }
  return await exactArtifactRecoveryResultSetDigest({
    requestDigest,
    executionLineageDigest,
    results,
  });
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

async function readSingleton(sql: Sql, requestDigest: Digest): Promise<RecoverySingleton | null> {
  const rows = await sql.query(
    `SELECT request_digest, tenant_id, manifest_digest, member_set_digest,
            r2_identity_digest, source_commit, source_version,
            preparing_worker_version_id, active_worker_version_id,
            execution_handoff_count, retention_policy_kind,
            retention_policy_digest, detail_retention_milliseconds, phase,
            prepared_at, completed_at, result_set_digest, purge_after,
            purge_worker_version_id, purge_authorization_digest, purge_authorized_at,
            detail_state
     FROM tf_artifact_recovery_once
     WHERE singleton = 1 AND request_digest = ?`,
    [requestDigest],
  );
  if (rows.length !== 1) return null;
  const row = rows[0] as Row;
  return {
    requestDigest: digest(row.request_digest),
    tenantId: text(row, "tenant_id"),
    manifestDigest: digest(row.manifest_digest),
    memberSetDigest: digest(row.member_set_digest),
    r2IdentityDigest: digest(row.r2_identity_digest),
    sourceCommit: text(row, "source_commit"),
    sourceVersion: text(row, "source_version"),
    preparingWorkerVersionId: text(row, "preparing_worker_version_id"),
    activeWorkerVersionId: text(row, "active_worker_version_id"),
    executionHandoffCount: integer(row, "execution_handoff_count"),
    retentionPolicyKind: text(row, "retention_policy_kind"),
    retentionPolicyDigest: digest(row.retention_policy_digest),
    detailRetentionMilliseconds: integer(row, "detail_retention_milliseconds"),
    phase: oneOf(row.phase, ["prepared", "settling", "complete", "revoked"] as const),
    preparedAt: integer(row, "prepared_at"),
    completedAt: nullableInteger(row.completed_at),
    resultSetDigest: row.result_set_digest === null ? null : digest(row.result_set_digest),
    purgeAfter: nullableInteger(row.purge_after),
    purgeWorkerVersionId:
      row.purge_worker_version_id === null ? null : text(row, "purge_worker_version_id"),
    purgeAuthorizationDigest:
      row.purge_authorization_digest === null ? null : digest(row.purge_authorization_digest),
    purgeAuthorizedAt: nullableInteger(row.purge_authorized_at),
    detailState: oneOf(row.detail_state, ["active", "purging", "purged"] as const),
  };
}

function validPurgeAuthorization(
  authorization: ExactArtifactRecoveryPurgeAuthorization,
  singleton: RecoverySingleton,
  now: number,
): boolean {
  return (
    authorization.kind === EXACT_ARTIFACT_RECOVERY_PURGE_AUTHORIZATION_FORMAT &&
    authorization.requestDigest === singleton.requestDigest &&
    authorization.workerVersionId === singleton.activeWorkerVersionId &&
    workerVersion(authorization.workerVersionId) &&
    isSha256Digest(authorization.invocationDigest) &&
    Number.isSafeInteger(authorization.authorizedAt) &&
    authorization.authorizedAt >= (singleton.purgeAfter ?? Number.POSITIVE_INFINITY) &&
    authorization.authorizedAt <= now
  );
}

function blocked(blocker: string): ExactArtifactRecoveryOwnerGcResult {
  return { outcome: "blocked", blocker };
}

function blobKey(value: Digest): string {
  return `art/${value.slice("sha256:".length)}`;
}

function guardToken(randomId: string): string {
  const suffix = randomId.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 96);
  if (!suffix) throw new Error("artifact recovery GC guard id is empty");
  return `arg_gc_${suffix}`;
}

function workerVersion(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);
}

function text(row: Row | undefined, key: string): string {
  const value = row?.[key];
  if (typeof value !== "string") throw new Error(`invalid ${key}`);
  return value;
}

function digest(value: unknown): Digest {
  if (!isSha256Digest(value)) throw new Error("invalid digest");
  return value;
}

function integer(row: Row | undefined, key: string): number {
  const value = row?.[key];
  if (!Number.isSafeInteger(value)) throw new Error(`invalid ${key}`);
  return Number(value);
}

function nullableInteger(value: unknown): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value)) throw new Error("invalid nullable integer");
  return Number(value);
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string") throw new Error("invalid nullable text");
  return value;
}

function oneOf<const T extends readonly string[]>(value: unknown, choices: T): T[number] {
  if (typeof value !== "string" || !choices.includes(value)) throw new Error("invalid state");
  return value as T[number];
}
