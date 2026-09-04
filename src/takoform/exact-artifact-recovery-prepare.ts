import {
  ARTIFACT_RECOVERY_QUARANTINE_MILLISECONDS,
  type ExactArtifactRecoveryPreparation,
} from "../artifact-recovery.ts";
import { canonicalDigest } from "../json.ts";
import type { Clock, ObjectStoreAccess, Sql, SqlStatement } from "../ports.ts";

export interface ExactArtifactRecoveryPreparationOptions {
  readonly sql: Sql;
  readonly objects: Pick<ObjectStoreAccess, "head">;
  readonly clock: Clock;
  readonly randomId: () => string;
}

const CANDIDATE_QUARANTINE_MILLISECONDS = ARTIFACT_RECOVERY_QUARANTINE_MILLISECONDS;

export async function prepareExactArtifactRecoveryGroup(
  options: ExactArtifactRecoveryPreparationOptions,
  input: ExactArtifactRecoveryPreparation,
): Promise<void> {
  const { sql, objects } = options;
  const { canonical, execution } = input;
  const { request } = canonical;
  const alreadyPrepared = await exactRecoveryPrepared(sql, canonical.requestDigest);
  if (alreadyPrepared) return;

  const evidenceDigest = await canonicalDigest({
    kind: "takoserver.exact-artifact-recovery-evidence@v2",
    credentialClosures: input.owners,
    settlementEvidence: request.settlementEvidence,
    lineage: request.lineage,
  });
  if (evidenceDigest !== input.evidenceDigest) {
    throw new Error("artifact recovery credential evidence digest drifted");
  }
  if (
    execution.pinnedRequestDigest !== canonical.requestDigest ||
    execution.r2IdentityDigest !== request.r2.identityDigest ||
    execution.sourceCommit !== request.source.commit ||
    execution.sourceVersion !== request.source.version
  ) {
    throw new Error("artifact recovery immutable Worker binding drifted");
  }

  const timestamp = options.clock().getTime();
  const quarantineNotBefore = timestamp + CANDIDATE_QUARANTINE_MILLISECONDS;
  const initialPurgeAfter = timestamp + request.retentionPolicy.detailRetentionMilliseconds;
  const token = artifactRecoveryGuardToken(options.randomId());
  const membersJson = JSON.stringify(request.memberDigests);
  const holdsJson = JSON.stringify(request.expectedHolds.entries);
  const replaysJson = JSON.stringify(request.expectedReplays.keys);
  const ownersJson = JSON.stringify(input.owners);
  const uploads = request.uploads.map((upload, index) => ({
    ...upload,
    receiptId: canonical.receipts[index]?.receiptId,
    closedAt: input.owners.find((owner) => owner.principalId === upload.principalId)?.closedAt,
  }));
  if (
    uploads.some(
      (upload) =>
        typeof upload.receiptId !== "string" ||
        !Number.isSafeInteger(upload.closedAt) ||
        Number(upload.closedAt) >= initialPurgeAfter,
    )
  ) {
    throw new Error("artifact recovery exact owner/receipt group is incomplete");
  }
  const uploadsJson = JSON.stringify(uploads);

  const etags: string[] = [];
  for (let index = 0; index < request.memberDigests.length; index += 1) {
    const memberDigest = request.memberDigests[index];
    const expectedEtag = input.candidateEtags[index];
    if (!memberDigest || !expectedEtag) {
      throw new Error("artifact recovery exact object evidence is incomplete");
    }
    const stored = await objects.head(blobKey(memberDigest));
    if (!stored || stored.etag !== expectedEtag) {
      throw new Error("artifact recovery exact object set changed before prepare");
    }
    etags.push(stored.etag);
  }

  const statements: SqlStatement[] = [
    exactArtifactRecoveryPrepareGuard({
      token,
      requestDigest: canonical.requestDigest,
      tenantId: request.tenantId,
      manifestDigest: request.manifestDigest,
      ownersJson,
      uploadsJson,
      membersJson,
      holdsJson,
      replaysJson,
    }),
    {
      sql: `INSERT INTO tf_artifact_recovery_once
              (singleton, request_digest, evidence_digest, tenant_id,
               logical_target_digest, manifest_digest, owner_set_digest,
               upload_set_digest, member_set_digest, replay_set_digest,
               hold_set_digest, expected_owner_count, expected_upload_count,
               expected_replay_count, expected_member_count, expected_hold_count,
               settlement_evidence_kind, settlement_evidence_digest,
               lineage_migration, lineage_digest, r2_identity_digest,
               source_commit, source_version, preparing_worker_version_id,
               active_worker_version_id, execution_handoff_count,
               retention_policy_kind, retention_policy_digest,
               detail_retention_milliseconds, phase, prepared_at)
            VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 4, 5, 2, 28, 29,
                    ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, 'prepared', ?)`,
      params: [
        canonical.requestDigest,
        input.evidenceDigest,
        request.tenantId,
        request.logicalTargetDigest,
        request.manifestDigest,
        request.ownerSetDigest,
        request.uploadSetDigest,
        request.memberSetDigest,
        request.expectedReplays.setDigest,
        request.expectedHolds.setDigest,
        request.settlementEvidence.kind,
        request.settlementEvidence.digest,
        request.lineage.migration,
        request.lineage.digest,
        request.r2.identityDigest,
        request.source.commit,
        request.source.version,
        execution.workerVersionId,
        execution.workerVersionId,
        request.retentionPolicy.kind,
        request.retentionPolicy.evidenceDigest,
        request.retentionPolicy.detailRetentionMilliseconds,
        timestamp,
      ],
    },
    {
      sql: `INSERT INTO tf_artifact_recovery_details
              (request_digest, request_json, prepared_worker_version_id, purge_after)
            VALUES (?, ?, ?, NULL)`,
      params: [canonical.requestDigest, canonical.canonicalJson, execution.workerVersionId],
    },
  ];

  for (const upload of uploads) {
    statements.push({
      sql: `INSERT INTO tf_artifact_owner_closure_receipts
              (receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
               manifest_digest, upload_fence, root_fence, receipt_kind,
               recovery_request_digest, state, closed_at, expires_at,
               purge_after, created_at, updated_at)
            VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'exact_failed_run_recovery',
                    ?, 'recovery_active', ?, ?, ?, ?, ?)`,
      params: [
        upload.receiptId as string,
        request.tenantId,
        upload.principalId,
        upload.uploadId,
        request.manifestDigest,
        upload.uploadFence,
        upload.rootFence,
        canonical.requestDigest,
        upload.closedAt as number,
        initialPurgeAfter,
        initialPurgeAfter,
        timestamp,
        timestamp,
      ],
    });
  }

  for (const upload of request.uploads) {
    statements.push(
      {
        sql: `UPDATE tf_artifact_roots
              SET state = 'released', fence = fence + 1,
                  release_reason = 'operator_exact_failed_run', released_at = ?
              WHERE tenant_id = ? AND root_kind = 'upload' AND root_id = ?
                AND target_kind = 'manifest' AND digest = ?
                AND state = 'active' AND fence = ?`,
        params: [
          timestamp,
          request.tenantId,
          upload.uploadId,
          request.manifestDigest,
          upload.rootFence,
        ],
      },
      {
        sql: `UPDATE tf_artifact_uploads
              SET lifecycle_fence = lifecycle_fence + 1, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND principal_id = ?
                AND manifest_digest = ? AND lifecycle_state = 'committed'
                AND lifecycle_fence = ?`,
        params: [
          timestamp,
          upload.uploadId,
          request.tenantId,
          upload.principalId,
          request.manifestDigest,
          upload.uploadFence,
        ],
      },
    );
  }
  statements.push(
    {
      sql: `UPDATE tf_artifact_roots
            SET state = 'released', fence = fence + 1,
                release_reason = 'operator_exact_failed_run', released_at = ?
            WHERE tenant_id = ? AND root_kind = 'replay'
              AND target_kind = 'manifest' AND digest = ? AND state = 'active'
              AND root_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
      params: [timestamp, request.tenantId, request.manifestDigest, replaysJson],
    },
    {
      sql: `DELETE FROM tf_artifact_replays
            WHERE replay_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
      params: [replaysJson],
    },
    {
      sql: `DELETE FROM tf_artifact_holds
            WHERE tenant_id = ? AND (
              (kind = 'manifest' AND digest = ?) OR
              (kind = 'blob' AND digest IN
                (SELECT CAST(value AS TEXT) FROM json_each(?)))
            )`,
      params: [request.tenantId, request.manifestDigest, membersJson],
    },
  );

  for (let index = 0; index < request.memberDigests.length; index += 1) {
    const memberDigest = request.memberDigests[index];
    const etag = etags[index];
    statements.push(
      {
        sql: `INSERT INTO tf_artifact_gc_candidates
                (kind, digest, state, fence, not_before, expected_etag, attempts,
                 last_outcome, created_at, updated_at, deleted_at)
              VALUES ('blob', ?, 'pending', 1, ?, ?, 0, 'pending', ?, ?, NULL)`,
        params: [memberDigest as string, quarantineNotBefore, etag as string, timestamp, timestamp],
      },
      {
        sql: `INSERT INTO tf_artifact_recovery_candidates
                (request_digest, ordinal, kind, digest, prepared_etag, active_etag,
                 state, purge_after)
              VALUES (?, ?, 'blob', ?, ?, ?, 'pending', ?)`,
        params: [
          canonical.requestDigest,
          index,
          memberDigest as string,
          etag as string,
          etag as string,
          initialPurgeAfter,
        ],
      },
    );
  }
  statements.push(
    {
      sql: `INSERT INTO tf_artifact_gc_candidates
              (kind, digest, state, fence, not_before, expected_etag, attempts,
               last_outcome, created_at, updated_at, deleted_at)
            VALUES ('manifest', ?, 'pending', 1, ?, NULL, 0, 'pending', ?, ?, NULL)`,
      params: [request.manifestDigest, quarantineNotBefore, timestamp, timestamp],
    },
    {
      sql: `INSERT INTO tf_artifact_recovery_candidates
              (request_digest, ordinal, kind, digest, prepared_etag, active_etag,
               state, purge_after)
            VALUES (?, 28, 'manifest', ?, NULL, NULL, 'pending', ?)`,
      params: [canonical.requestDigest, request.manifestDigest, initialPurgeAfter],
    },
    { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
  );

  try {
    await sql.batch(statements);
  } catch (error) {
    if (await exactRecoveryPrepared(sql, canonical.requestDigest).catch(() => false)) return;
    throw error;
  }
}

async function exactRecoveryPrepared(sql: Sql, requestDigest: string): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 AS prepared
     FROM tf_artifact_recovery_once AS recovery
     JOIN tf_artifact_recovery_details AS detail
       ON detail.request_digest = recovery.request_digest
     WHERE recovery.singleton = 1 AND recovery.request_digest = ?
       AND detail.request_digest = ?`,
    [requestDigest, requestDigest],
  );
  return rows.length === 1;
}

function exactArtifactRecoveryPrepareGuard(input: {
  readonly token: string;
  readonly requestDigest: string;
  readonly tenantId: string;
  readonly manifestDigest: string;
  readonly ownersJson: string;
  readonly uploadsJson: string;
  readonly membersJson: string;
  readonly holdsJson: string;
  readonly replaysJson: string;
}): SqlStatement {
  return {
    sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
          SELECT ?, CASE WHEN
            NOT EXISTS (
              SELECT 1 FROM tf_artifact_recovery_once
              WHERE singleton = 1 AND (request_digest = ? OR manifest_digest = ?)
            )
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) AS expected
              WHERE NOT EXISTS (
                SELECT 1
                FROM integration_e2e_credential_pair_operations AS operation
                JOIN auth_tokens AS writer
                  ON writer.id = operation.writer_key_id AND writer.kind = 'api_key'
                JOIN auth_tokens AS evidence
                  ON evidence.id = operation.evidence_key_id AND evidence.kind = 'api_key'
                WHERE operation.operation_id = json_extract(expected.value, '$.operationId')
                  AND operation.authority_slot =
                    json_extract(expected.value, '$.authoritySlot')
                  AND operation.org_id = ?
                  AND operation.org_id = json_extract(expected.value, '$.organizationId')
                  AND operation.writer_key_id = json_extract(expected.value, '$.writerKeyId')
                  AND operation.evidence_key_id = json_extract(expected.value, '$.evidenceKeyId')
                  AND json_extract(expected.value, '$.principalId') =
                    'api-key:' || operation.writer_key_id
                  AND operation.writer_name = 'integration-e2e-writer'
                  AND operation.writer_name = json_extract(expected.value, '$.writerName')
                  AND operation.evidence_name = 'integration-e2e-evidence'
                  AND operation.evidence_name = json_extract(expected.value, '$.evidenceName')
                  AND operation.writer_scopes_json = '["resources:write"]'
                  AND operation.writer_scopes_json =
                    json_extract(expected.value, '$.writerScopesJson')
                  AND operation.evidence_scopes_json = '["resources:read"]'
                  AND operation.evidence_scopes_json =
                    json_extract(expected.value, '$.evidenceScopesJson')
                  AND operation.ttl_seconds = 3600
                  AND operation.ttl_seconds = json_extract(expected.value, '$.ttlSeconds')
                  AND operation.state = 'revoked'
                  AND operation.state = json_extract(expected.value, '$.operationState')
                  AND operation.fence = json_extract(expected.value, '$.operationFence')
                  AND operation.source_commit =
                    json_extract(expected.value, '$.provenance.sourceCommit')
                  AND operation.artifact_digest =
                    json_extract(expected.value, '$.provenance.artifactDigest')
                  AND operation.authority_worker_version_id =
                    json_extract(expected.value, '$.provenance.authorityWorkerVersionId')
                  AND operation.created_at =
                    json_extract(expected.value, '$.operationCreatedAt')
                  AND operation.updated_at =
                    json_extract(expected.value, '$.operationUpdatedAt')
                  AND operation.revoked_at =
                    json_extract(expected.value, '$.operationRevokedAt')
                  AND operation.revoked_at = json_extract(expected.value, '$.closedAt')
                  AND writer.id = json_extract(expected.value, '$.writerToken.id')
                  AND writer.org_id = ? AND writer.name = 'integration-e2e-writer'
                  AND writer.org_id =
                    json_extract(expected.value, '$.writerToken.organizationId')
                  AND writer.name = json_extract(expected.value, '$.writerToken.name')
                  AND writer.scopes_json = '["resources:write"]'
                  AND writer.scopes_json =
                    json_extract(expected.value, '$.writerToken.scopesJson')
                  AND writer.created_at =
                    json_extract(expected.value, '$.writerToken.createdAt')
                  AND writer.expires_at =
                    json_extract(expected.value, '$.writerToken.expiresAt')
                  AND writer.revoked_at =
                    json_extract(expected.value, '$.writerToken.revokedAt')
                  AND evidence.id = json_extract(expected.value, '$.evidenceToken.id')
                  AND evidence.org_id = ? AND evidence.name = 'integration-e2e-evidence'
                  AND evidence.org_id =
                    json_extract(expected.value, '$.evidenceToken.organizationId')
                  AND evidence.name = json_extract(expected.value, '$.evidenceToken.name')
                  AND evidence.scopes_json = '["resources:read"]'
                  AND evidence.scopes_json =
                    json_extract(expected.value, '$.evidenceToken.scopesJson')
                  AND evidence.created_at =
                    json_extract(expected.value, '$.evidenceToken.createdAt')
                  AND evidence.expires_at =
                    json_extract(expected.value, '$.evidenceToken.expiresAt')
                  AND evidence.revoked_at =
                    json_extract(expected.value, '$.evidenceToken.revokedAt')
              )
            )
            AND (SELECT COUNT(*) FROM json_each(?)) = 4
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) AS expected
              WHERE NOT EXISTS (
                SELECT 1
                FROM tf_artifact_uploads AS upload
                JOIN tf_artifact_roots AS root
                  ON root.tenant_id = upload.tenant_id
                 AND root.root_kind = 'upload' AND root.root_id = upload.id
                 AND root.target_kind = 'manifest' AND root.digest = upload.manifest_digest
                WHERE upload.id = json_extract(expected.value, '$.uploadId')
                  AND upload.tenant_id = ?
                  AND upload.principal_id = json_extract(expected.value, '$.principalId')
                  AND upload.manifest_digest = ? AND upload.lifecycle_state = 'committed'
                  AND upload.lifecycle_fence = json_extract(expected.value, '$.uploadFence')
                  AND root.state = 'active'
                  AND root.fence = json_extract(expected.value, '$.rootFence')
              )
            )
            AND (SELECT COUNT(*) FROM json_each(?)) = 5
            AND (SELECT COUNT(*) FROM tf_artifact_manifest_members
                 WHERE manifest_digest = ?) = 28
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) AS expected
              WHERE NOT EXISTS (
                SELECT 1 FROM tf_artifact_manifest_members
                WHERE manifest_digest = ?
                  AND blob_digest = CAST(expected.value AS TEXT)
              )
            )
            AND (SELECT COUNT(*) FROM json_each(?)) = 28
            AND EXISTS (SELECT 1 FROM tf_artifact_manifests WHERE digest = ?)
            AND (SELECT COUNT(*) FROM tf_artifact_holds
                 WHERE tenant_id = ? AND (
                   (kind = 'manifest' AND digest = ?) OR
                   (kind = 'blob' AND digest IN
                     (SELECT CAST(value AS TEXT) FROM json_each(?)))
                 )) = 29
            AND NOT EXISTS (
              SELECT 1 FROM json_each(?) AS expected
              WHERE NOT EXISTS (
                SELECT 1 FROM tf_artifact_holds
                WHERE tenant_id = ?
                  AND kind = json_extract(expected.value, '$.kind')
                  AND digest = json_extract(expected.value, '$.digest')
              )
            )
            AND (SELECT COUNT(*) FROM tf_artifact_replays
                 WHERE replay_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))
                   AND status BETWEEN 200 AND 299
                   AND json_extract(body_json, '$.manifestDigest') = ?) = 2
            AND (SELECT COUNT(*) FROM tf_artifact_roots
                 WHERE tenant_id = ? AND root_kind = 'replay'
                   AND target_kind = 'manifest' AND digest = ? AND state = 'active'
                   AND fence = 1
                   AND root_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))) = 2
            AND NOT EXISTS (
              SELECT 1 FROM tf_artifact_consumer_uncertainties
              WHERE tenant_id = ? AND state = 'active'
            )
            AND NOT EXISTS (
              SELECT 1 FROM tf_artifact_roots AS root
              WHERE root.state = 'active' AND (
                (root.target_kind = 'blob' AND root.digest IN
                  (SELECT CAST(value AS TEXT) FROM json_each(?))) OR
                (root.target_kind = 'manifest' AND (
                  root.digest = ? OR EXISTS (
                    SELECT 1 FROM tf_artifact_manifest_members AS member
                    WHERE member.manifest_digest = root.digest
                      AND member.blob_digest IN
                        (SELECT CAST(value AS TEXT) FROM json_each(?))
                  )
                ))
              ) AND NOT (
                root.tenant_id = ? AND root.target_kind = 'manifest'
                AND root.digest = ? AND (
                  (root.root_kind = 'upload' AND root.root_id IN (
                    SELECT json_extract(value, '$.uploadId') FROM json_each(?)
                  )) OR
                  (root.root_kind = 'replay' AND root.root_id IN (
                    SELECT CAST(value AS TEXT) FROM json_each(?)
                  ))
                )
              )
            )
            AND NOT EXISTS (
              SELECT 1 FROM tf_artifact_gc_candidates
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
              SELECT 1 FROM tf_artifact_owner_closure_receipts AS receipt
              WHERE receipt.receipt_kind = 'exact_failed_run_recovery'
                OR receipt.receipt_id IN (
                SELECT json_extract(value, '$.receiptId') FROM json_each(?)
              ) OR (
                receipt.tenant_id = ? AND EXISTS (
                  SELECT 1 FROM json_each(?) AS expected
                  WHERE receipt.principal_id = json_extract(expected.value, '$.principalId')
                    AND receipt.upload_id = json_extract(expected.value, '$.uploadId')
                    AND receipt.manifest_digest = ?
                )
              )
            )
          THEN 1 ELSE 0 END`,
    params: [
      input.token,
      input.requestDigest,
      input.manifestDigest,
      input.ownersJson,
      input.tenantId,
      input.tenantId,
      input.tenantId,
      input.ownersJson,
      input.uploadsJson,
      input.tenantId,
      input.manifestDigest,
      input.uploadsJson,
      input.manifestDigest,
      input.membersJson,
      input.manifestDigest,
      input.membersJson,
      input.manifestDigest,
      input.tenantId,
      input.manifestDigest,
      input.membersJson,
      input.holdsJson,
      input.tenantId,
      input.replaysJson,
      input.manifestDigest,
      input.tenantId,
      input.manifestDigest,
      input.replaysJson,
      input.tenantId,
      input.membersJson,
      input.manifestDigest,
      input.membersJson,
      input.tenantId,
      input.manifestDigest,
      input.uploadsJson,
      input.replaysJson,
      input.manifestDigest,
      input.membersJson,
      input.membersJson,
      input.uploadsJson,
      input.tenantId,
      input.uploadsJson,
      input.manifestDigest,
    ],
  };
}

function artifactRecoveryGuardToken(randomId: string): string {
  const suffix = randomId.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 96);
  if (suffix.length === 0) throw new Error("artifact recovery guard id is empty");
  return `arg_${suffix}`;
}

function blobKey(digest: string): string {
  return `art/${digest.slice("sha256:".length)}`;
}
