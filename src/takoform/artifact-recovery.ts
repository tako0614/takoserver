import { canonicalDigest, canonicalJson, isSha256Digest } from "../json.ts";
import type { Clock, ObjectStoreAccess, Row, Sql, SqlStatement } from "../ports.ts";

export const EXACT_FAILED_RUN_MEMBER_COUNT = 28;
export const ARTIFACT_RECOVERY_REQUEST_KIND =
  "takoserver.exact-failed-run-artifact-recovery-request@v1" as const;

type Digest = `sha256:${string}`;

export interface ArtifactRecoveryHold {
  readonly kind: "manifest" | "blob";
  readonly digest: Digest;
}

export interface ArtifactRecoveryRequest {
  readonly kind: typeof ARTIFACT_RECOVERY_REQUEST_KIND;
  readonly tenantId: string;
  readonly principalId: string;
  readonly uploadId: string;
  readonly manifestDigest: Digest;
  readonly uploadFence: number;
  readonly rootFence: number;
  readonly memberDigests: readonly Digest[];
  readonly memberSetDigest: Digest;
  readonly expectedHolds: {
    readonly entries: readonly ArtifactRecoveryHold[];
    readonly count: number;
    readonly setDigest: Digest;
  };
  readonly expectedReplays: {
    readonly keys: readonly string[];
    readonly count: number;
    readonly setDigest: Digest;
  };
  readonly failedRunEvidence: {
    readonly kind: string;
    readonly sha256: Digest;
  };
  readonly closedAt: number;
}

export interface CanonicalArtifactRecoveryRequest {
  readonly request: ArtifactRecoveryRequest;
  readonly canonicalJson: string;
  readonly requestDigest: Digest;
  readonly receiptId: `afr_${string}`;
}

export type ArtifactRecoveryPhase =
  | "eligible"
  | "receipt-issued"
  | "quarantined"
  | "settling"
  | "requarantined"
  | "complete";

export interface ArtifactRecoveryReadback {
  readonly kind: "takoserver.exact-failed-run-artifact-recovery-readback@v1";
  readonly requestDigest: Digest;
  readonly receiptId: `afr_${string}`;
  readonly phase: ArtifactRecoveryPhase;
  readonly upload: { readonly lifecycle: "committed"; readonly fence: number };
  readonly candidates: {
    readonly pending: number;
    readonly deleting: number;
    readonly retry: number;
    readonly deleted: number;
  };
  readonly quarantineNotBefore: number | null;
  readonly metadataPresent: boolean;
  readonly presentBlobs: number;
  readonly absentBlobs: number;
}

export interface ArtifactRecoveryPlan {
  readonly kind: "takoserver.exact-failed-run-artifact-recovery-plan@v1";
  readonly requestDigest: Digest;
  readonly receiptId: `afr_${string}`;
  readonly observedPhase: ArtifactRecoveryPhase;
  readonly action: "issue-receipt" | "prepare-exact-set" | "wait" | "settle-exact-set" | "none";
  readonly planDigest: Digest;
}

export interface ExactArtifactRecoveryMutations {
  issueExactArtifactRecoveryReceipt(input: CanonicalArtifactRecoveryRequest): Promise<void>;
  prepareExactArtifactRecoverySet(input: CanonicalArtifactRecoveryRequest): Promise<void>;
  settleExactArtifactRecoverySet(input: CanonicalArtifactRecoveryRequest): Promise<void>;
}

export interface ArtifactRecoveryApplyResult {
  readonly kind: "takoserver.exact-failed-run-artifact-recovery-apply@v1";
  readonly plan: ArtifactRecoveryPlan;
  readonly readback: ArtifactRecoveryReadback;
}

export interface ArtifactRecovery {
  status(value: unknown): Promise<ArtifactRecoveryReadback>;
  apply(value: unknown): Promise<ArtifactRecoveryApplyResult>;
}

export interface CreateArtifactRecoveryOptions {
  readonly sql: Sql;
  readonly objects: Pick<ObjectStoreAccess, "head">;
  readonly clock: Clock;
  readonly reconciler: ExactArtifactRecoveryMutations;
}

export interface CreateExactArtifactRecoveryMutationsOptions {
  readonly sql: Sql;
  readonly objects: Pick<ObjectStoreAccess, "head" | "delete">;
  readonly clock: Clock;
  readonly randomId: () => string;
}

interface CandidateState {
  readonly kind: "manifest" | "blob";
  readonly digest: Digest;
  readonly state: "pending" | "deleting" | "retry" | "deleted";
  readonly fence: number;
  readonly notBefore: number;
  readonly expectedEtag: string | null;
  readonly attempts: number;
  readonly lastOutcome: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly deletedAt: number | null;
}

const QUARANTINE_MILLISECONDS = 60 * 60_000;
const DURABLE_RECEIPT_EXPIRES_AT = 8_640_000_000_000_000;

/**
 * Canonical status/apply coordinator for the one owner recovery. Status is
 * entirely read-only. Apply advances only acknowledged phases; an exception is
 * returned to the operator and never retried inside the call.
 */
export function createArtifactRecovery(options: CreateArtifactRecoveryOptions): ArtifactRecovery {
  const read = async (
    canonical: CanonicalArtifactRecoveryRequest,
  ): Promise<ArtifactRecoveryReadback> =>
    await exactRecoveryReadback(options.sql, options.objects, options.clock, canonical);

  return {
    async status(value) {
      return await read(await canonicalArtifactRecoveryRequest(value));
    },

    async apply(value) {
      const canonical = await canonicalArtifactRecoveryRequest(value);
      let current = await read(canonical);
      const plan = await artifactRecoveryPlan(current, options.clock().getTime());
      if (current.phase === "eligible") {
        await options.reconciler.issueExactArtifactRecoveryReceipt(canonical);
        current = await read(canonical);
      }
      if (current.phase === "receipt-issued") {
        await options.reconciler.prepareExactArtifactRecoverySet(canonical);
        current = await read(canonical);
      }
      if (
        current.phase === "quarantined" ||
        current.phase === "settling" ||
        current.phase === "requarantined"
      ) {
        await options.reconciler.settleExactArtifactRecoverySet(canonical);
        current = await read(canonical);
      }
      return {
        kind: "takoserver.exact-failed-run-artifact-recovery-apply@v1",
        plan,
        readback: current,
      };
    },
  };
}

/** Exact-set mutation implementation mixed into the maintenance reconciler. */
export function createExactArtifactRecoveryMutations(
  options: CreateExactArtifactRecoveryMutationsOptions,
): ExactArtifactRecoveryMutations {
  const { sql, objects } = options;
  const now = (): number => options.clock().getTime();
  const guardToken = (suffix: string): string => {
    const random = options
      .randomId()
      .replace(/[^A-Za-z0-9._-]/gu, "")
      .slice(0, 80);
    return `arg_${random}_${suffix}`.slice(0, 128);
  };

  return {
    async issueExactArtifactRecoveryReceipt(input) {
      const request = input.request;
      const timestamp = now();
      await sql.run(
        `INSERT INTO tf_artifact_owner_closure_receipts
           (receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
            manifest_digest, upload_fence, root_fence, state, closed_at,
            expires_at, created_at, updated_at)
         VALUES (?, 1, ?, ?, ?, ?, ?, ?, 'closed', ?, ?, ?, ?)`,
        [
          input.receiptId,
          request.tenantId,
          request.principalId,
          request.uploadId,
          request.manifestDigest,
          request.uploadFence,
          request.rootFence,
          request.closedAt,
          DURABLE_RECEIPT_EXPIRES_AT,
          timestamp,
          timestamp,
        ],
      );
    },

    async prepareExactArtifactRecoverySet(input) {
      const request = input.request;
      const timestamp = now();
      const etags: string[] = [];
      for (const memberDigest of request.memberDigests) {
        const object = await objects.head(blobKey(memberDigest));
        if (!object) {
          throw new Error("artifact recovery exact blob set changed before quarantine");
        }
        if (object.etag.length < 1 || object.etag.length > 512) {
          throw new Error("artifact recovery R2 returned an invalid ETag");
        }
        etags.push(object.etag);
      }
      const membersJson = JSON.stringify(request.memberDigests);
      const replayJson = JSON.stringify(request.expectedReplays.keys);
      const token = guardToken("prepare");
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
                SELECT ?, CASE WHEN
                  EXISTS (
                    SELECT 1 FROM tf_artifact_owner_closure_receipts AS receipt
                    JOIN tf_artifact_uploads AS upload
                      ON upload.tenant_id = receipt.tenant_id
                     AND upload.principal_id = receipt.principal_id
                     AND upload.id = receipt.upload_id
                     AND upload.manifest_digest = receipt.manifest_digest
                    JOIN tf_artifact_roots AS upload_root
                      ON upload_root.tenant_id = upload.tenant_id
                     AND upload_root.root_kind = 'upload'
                     AND upload_root.root_id = upload.id
                     AND upload_root.target_kind = 'manifest'
                     AND upload_root.digest = upload.manifest_digest
                    WHERE receipt.receipt_id = ? AND receipt.receipt_fence = 1
                      AND receipt.tenant_id = ? AND receipt.principal_id = ?
                      AND receipt.upload_id = ? AND receipt.manifest_digest = ?
                      AND receipt.upload_fence = ? AND receipt.root_fence = ?
                      AND receipt.closed_at = ?
                      AND receipt.state = 'closed' AND receipt.expires_at > ?
                      AND upload.lifecycle_state = 'committed'
                      AND upload.lifecycle_fence = ?
                      AND upload_root.state = 'active' AND upload_root.fence = ?
                      AND EXISTS (
                        SELECT 1 FROM tf_artifact_manifests AS metadata
                        WHERE metadata.digest = receipt.manifest_digest
                          AND metadata.manifest_json = upload.manifest_json
                      )
                      AND (SELECT COUNT(*) FROM tf_artifact_manifest_members AS member
                           WHERE member.manifest_digest = receipt.manifest_digest) = 28
                      AND NOT EXISTS (
                        SELECT 1 FROM tf_artifact_manifest_members AS member
                        WHERE member.manifest_digest = receipt.manifest_digest
                          AND member.blob_digest NOT IN
                            (SELECT CAST(value AS TEXT) FROM json_each(?))
                      )
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM tf_artifact_consumer_uncertainties
                    WHERE tenant_id = ? AND state = 'active'
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM tf_artifact_roots AS live
                    WHERE live.state = 'active'
                      AND (
                        (live.target_kind = 'manifest' AND live.digest = ?) OR
                        (live.target_kind = 'blob' AND live.digest IN
                          (SELECT CAST(value AS TEXT) FROM json_each(?))) OR
                        (live.target_kind = 'manifest' AND EXISTS (
                          SELECT 1 FROM tf_artifact_manifest_members AS shared_member
                          WHERE shared_member.manifest_digest = live.digest
                            AND shared_member.blob_digest IN
                              (SELECT CAST(value AS TEXT) FROM json_each(?))
                        ))
                      )
                      AND NOT (
                        live.tenant_id = ? AND live.target_kind = 'manifest' AND live.digest = ?
                        AND (
                          (live.root_kind = 'upload' AND live.root_id = ?) OR
                          (live.root_kind = 'replay' AND live.root_id IN
                            (SELECT CAST(value AS TEXT) FROM json_each(?)))
                        )
                      )
                  )
                  AND (SELECT COUNT(*) FROM tf_artifact_roots AS replay_root
                       WHERE replay_root.tenant_id = ? AND replay_root.root_kind = 'replay'
                         AND replay_root.target_kind = 'manifest' AND replay_root.digest = ?
                         AND replay_root.state = 'active' AND replay_root.fence = 1
                         AND replay_root.root_id IN
                           (SELECT CAST(value AS TEXT) FROM json_each(?))) = ?
                  AND (SELECT COUNT(*) FROM tf_artifact_roots AS replay_root
                       WHERE replay_root.root_kind = 'replay'
                         AND replay_root.target_kind = 'manifest'
                         AND replay_root.digest = ?) = ?
                  AND (SELECT COUNT(*) FROM tf_artifact_replays AS replay
                       WHERE replay.replay_key IN
                         (SELECT CAST(value AS TEXT) FROM json_each(?))
                         AND json_extract(replay.body_json, '$.manifestDigest') = ?) = ?
                  AND (SELECT COUNT(*) FROM tf_artifact_replays AS replay
                       WHERE json_extract(replay.body_json, '$.manifestDigest') = ?) = ?
                  AND (SELECT COUNT(*) FROM tf_artifact_holds AS hold
                       WHERE hold.digest = ? OR hold.digest IN
                         (SELECT CAST(value AS TEXT) FROM json_each(?))) = 29
                  AND NOT EXISTS (
                    SELECT 1 FROM tf_artifact_holds AS hold
                    WHERE (hold.digest = ? OR hold.digest IN
                      (SELECT CAST(value AS TEXT) FROM json_each(?)))
                      AND NOT (
                        hold.tenant_id = ? AND (
                          (hold.kind = 'manifest' AND hold.digest = ?) OR
                          (hold.kind = 'blob' AND hold.digest IN
                            (SELECT CAST(value AS TEXT) FROM json_each(?)))
                        )
                      )
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM tf_artifact_gc_candidates AS candidate
                    WHERE (candidate.kind = 'manifest' AND candidate.digest = ?)
                       OR (candidate.kind = 'blob' AND candidate.digest IN
                         (SELECT CAST(value AS TEXT) FROM json_each(?)))
                  )
                THEN 1 ELSE 0 END`,
          params: [
            token,
            input.receiptId,
            request.tenantId,
            request.principalId,
            request.uploadId,
            request.manifestDigest,
            request.uploadFence,
            request.rootFence,
            request.closedAt,
            timestamp,
            request.uploadFence,
            request.rootFence,
            membersJson,
            request.tenantId,
            request.manifestDigest,
            membersJson,
            membersJson,
            request.tenantId,
            request.manifestDigest,
            request.uploadId,
            replayJson,
            request.tenantId,
            request.manifestDigest,
            replayJson,
            request.expectedReplays.count,
            request.manifestDigest,
            request.expectedReplays.count,
            replayJson,
            request.manifestDigest,
            request.expectedReplays.count,
            request.manifestDigest,
            request.expectedReplays.count,
            request.manifestDigest,
            membersJson,
            request.manifestDigest,
            membersJson,
            request.tenantId,
            request.manifestDigest,
            membersJson,
            request.manifestDigest,
            membersJson,
          ],
        },
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
            request.uploadId,
            request.manifestDigest,
            request.rootFence,
          ],
        },
        {
          sql: `UPDATE tf_artifact_roots
                SET state = 'released', fence = fence + 1,
                    release_reason = 'operator_exact_failed_run', released_at = ?
                WHERE tenant_id = ? AND root_kind = 'replay'
                  AND target_kind = 'manifest' AND digest = ? AND state = 'active'
                  AND root_id IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
          params: [timestamp, request.tenantId, request.manifestDigest, replayJson],
        },
        {
          sql: `UPDATE tf_artifact_uploads
                SET lifecycle_fence = lifecycle_fence + 1, updated_at = ?
                WHERE id = ? AND tenant_id = ? AND principal_id = ?
                  AND manifest_digest = ? AND lifecycle_state = 'committed'
                  AND lifecycle_fence = ?`,
          params: [
            timestamp,
            request.uploadId,
            request.tenantId,
            request.principalId,
            request.manifestDigest,
            request.uploadFence,
          ],
        },
        {
          sql: `DELETE FROM tf_artifact_replays
                WHERE replay_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))`,
          params: [replayJson],
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
        {
          sql: `INSERT INTO tf_artifact_gc_candidates
                  (kind, digest, state, fence, not_before, expected_etag, attempts,
                   last_outcome, created_at, updated_at, deleted_at)
                VALUES ('manifest', ?, 'pending', 1, ?, NULL, 0,
                        'pending', ?, ?, NULL)`,
          params: [
            request.manifestDigest,
            timestamp + QUARANTINE_MILLISECONDS,
            timestamp,
            timestamp,
          ],
        },
      ];
      for (let index = 0; index < request.memberDigests.length; index += 1) {
        statements.push({
          sql: `INSERT INTO tf_artifact_gc_candidates
                  (kind, digest, state, fence, not_before, expected_etag, attempts,
                   last_outcome, created_at, updated_at, deleted_at)
                VALUES ('blob', ?, 'pending', 1, ?, ?, 0,
                        'pending', ?, ?, NULL)`,
          params: [
            request.memberDigests[index] as Digest,
            timestamp + QUARANTINE_MILLISECONDS,
            etags[index] as string,
            timestamp,
            timestamp,
          ],
        });
      }
      statements.push({
        sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?",
        params: [token],
      });
      const writes = await sql.batch(statements);
      if (
        writes[1]?.changes !== 1 ||
        writes[2]?.changes !== request.expectedReplays.count ||
        writes[3]?.changes !== 1 ||
        writes[4]?.changes !== request.expectedReplays.count ||
        writes[5]?.changes !== 29
      ) {
        throw new Error("artifact recovery exact prepare lost its durable fence");
      }
    },

    async settleExactArtifactRecoverySet(input) {
      const request = input.request;
      let candidates = await recoveryCandidates(sql, input);
      for (const candidate of candidates.filter((entry) => entry.kind === "blob")) {
        if (candidate.state === "deleted" || candidate.notBefore > now()) continue;
        await settleBlobCandidate(sql, objects, now, guardToken, input, candidate);
      }
      candidates = await recoveryCandidates(sql, input);
      const manifest = candidates.find((candidate) => candidate.kind === "manifest");
      if (!manifest) throw new Error("artifact recovery manifest candidate is missing");
      if (
        manifest.state !== "deleted" &&
        manifest.notBefore <= now() &&
        candidates
          .filter((candidate) => candidate.kind === "blob")
          .every((candidate) => candidate.state === "deleted")
      ) {
        await settleManifestCandidate(sql, now, guardToken, input, manifest);
      }
      // Keep the request live in this implementation: a broadened set cannot
      // accidentally be introduced while this loop is refactored.
      if (request.memberDigests.length !== EXACT_FAILED_RUN_MEMBER_COUNT) {
        throw new Error("artifact recovery exact member set changed during settlement");
      }
    },
  };
}

/**
 * Validates the complete operator-owned recovery fact before any durable read.
 * Arrays are already canonical sets on the wire: silently sorting them would
 * let two differently reviewed files name the same authority.
 */
export async function canonicalArtifactRecoveryRequest(
  value: unknown,
): Promise<CanonicalArtifactRecoveryRequest> {
  const request = exactRequest(value);
  const memberSetDigest = await canonicalDigest(request.memberDigests);
  if (memberSetDigest !== request.memberSetDigest) {
    throw new TypeError("artifact recovery member set digest does not match its exact members");
  }
  const holdSetDigest = await canonicalDigest(request.expectedHolds.entries);
  if (holdSetDigest !== request.expectedHolds.setDigest) {
    throw new TypeError("artifact recovery hold set digest does not match its exact entries");
  }
  const replaySetDigest = await canonicalDigest(request.expectedReplays.keys);
  if (replaySetDigest !== request.expectedReplays.setDigest) {
    throw new TypeError("artifact recovery replay set digest does not match its exact keys");
  }
  const encoded = canonicalJson(request);
  const requestDigest = await canonicalDigest(request);
  return {
    request,
    canonicalJson: encoded,
    requestDigest,
    receiptId: `afr_${requestDigest.slice("sha256:".length)}`,
  };
}

/** Strict wire readback used by the owner process after the named RPC hop. */
export function canonicalArtifactRecoveryReadback(
  value: unknown,
  input: CanonicalArtifactRecoveryRequest,
): ArtifactRecoveryReadback {
  const record = object(value, "artifact recovery readback");
  exactNamedKeys(
    record,
    [
      "kind",
      "requestDigest",
      "receiptId",
      "phase",
      "upload",
      "candidates",
      "quarantineNotBefore",
      "metadataPresent",
      "presentBlobs",
      "absentBlobs",
    ],
    "readback",
  );
  if (record.kind !== "takoserver.exact-failed-run-artifact-recovery-readback@v1") {
    throw new TypeError("artifact recovery readback kind is invalid");
  }
  if (record.requestDigest !== input.requestDigest || record.receiptId !== input.receiptId) {
    throw new TypeError("artifact recovery readback request identity is mismatched");
  }
  const phase = record.phase;
  if (
    phase !== "eligible" &&
    phase !== "receipt-issued" &&
    phase !== "quarantined" &&
    phase !== "settling" &&
    phase !== "requarantined" &&
    phase !== "complete"
  ) {
    throw new TypeError("artifact recovery readback phase is invalid");
  }
  const uploadRecord = object(record.upload, "artifact recovery readback upload");
  exactNamedKeys(uploadRecord, ["lifecycle", "fence"], "readback upload");
  if (uploadRecord.lifecycle !== "committed") {
    throw new TypeError("artifact recovery readback upload lifecycle is invalid");
  }
  const uploadFence = positiveInteger(uploadRecord.fence, "readback upload fence");
  const preRelease = phase === "eligible" || phase === "receipt-issued";
  if (uploadFence !== input.request.uploadFence + (preRelease ? 0 : 1)) {
    throw new TypeError("artifact recovery readback upload fence is mismatched");
  }

  const candidateRecord = object(record.candidates, "artifact recovery readback candidates");
  exactNamedKeys(
    candidateRecord,
    ["pending", "deleting", "retry", "deleted"],
    "readback candidates",
  );
  const candidates = {
    pending: nonnegativeInteger(candidateRecord.pending, "readback pending candidates"),
    deleting: nonnegativeInteger(candidateRecord.deleting, "readback deleting candidates"),
    retry: nonnegativeInteger(candidateRecord.retry, "readback retry candidates"),
    deleted: nonnegativeInteger(candidateRecord.deleted, "readback deleted candidates"),
  };
  const candidateTotal =
    candidates.pending + candidates.deleting + candidates.retry + candidates.deleted;
  const quarantineNotBefore =
    record.quarantineNotBefore === null
      ? null
      : nonnegativeInteger(record.quarantineNotBefore, "readback quarantineNotBefore");
  if (typeof record.metadataPresent !== "boolean") {
    throw new TypeError("artifact recovery readback metadataPresent is invalid");
  }
  const presentBlobs = nonnegativeInteger(record.presentBlobs, "readback presentBlobs");
  const absentBlobs = nonnegativeInteger(record.absentBlobs, "readback absentBlobs");
  if (
    presentBlobs > EXACT_FAILED_RUN_MEMBER_COUNT ||
    absentBlobs > EXACT_FAILED_RUN_MEMBER_COUNT ||
    presentBlobs + absentBlobs !== EXACT_FAILED_RUN_MEMBER_COUNT
  ) {
    throw new TypeError("artifact recovery readback blob counts are inconsistent");
  }
  if (preRelease) {
    if (
      candidateTotal !== 0 ||
      quarantineNotBefore !== null ||
      !record.metadataPresent ||
      presentBlobs !== EXACT_FAILED_RUN_MEMBER_COUNT
    ) {
      throw new TypeError("artifact recovery pre-release readback is inconsistent");
    }
  } else if (phase === "complete") {
    if (
      candidates.pending !== 0 ||
      candidates.deleting !== 0 ||
      candidates.retry !== 0 ||
      candidates.deleted !== EXACT_FAILED_RUN_MEMBER_COUNT + 1 ||
      quarantineNotBefore !== null ||
      record.metadataPresent ||
      presentBlobs !== 0
    ) {
      throw new TypeError("artifact recovery complete readback is inconsistent");
    }
  } else if (
    candidateTotal !== EXACT_FAILED_RUN_MEMBER_COUNT + 1 ||
    quarantineNotBefore === null ||
    !record.metadataPresent ||
    (phase === "quarantined" &&
      (candidates.pending !== EXACT_FAILED_RUN_MEMBER_COUNT + 1 ||
        candidates.deleting !== 0 ||
        candidates.retry !== 0 ||
        candidates.deleted !== 0)) ||
    (phase === "requarantined" && candidates.retry === 0) ||
    (phase === "settling" &&
      candidates.deleting === 0 &&
      candidates.retry === 0 &&
      candidates.deleted === 0)
  ) {
    throw new TypeError("artifact recovery in-progress readback is inconsistent");
  }
  return {
    kind: "takoserver.exact-failed-run-artifact-recovery-readback@v1",
    requestDigest: input.requestDigest,
    receiptId: input.receiptId,
    phase,
    upload: { lifecycle: "committed", fence: uploadFence },
    candidates,
    quarantineNotBefore,
    metadataPresent: record.metadataPresent,
    presentBlobs,
    absentBlobs,
  };
}

export async function canonicalArtifactRecoveryPlan(
  value: unknown,
  input: CanonicalArtifactRecoveryRequest,
): Promise<ArtifactRecoveryPlan> {
  const record = object(value, "artifact recovery plan");
  exactNamedKeys(
    record,
    ["kind", "requestDigest", "receiptId", "observedPhase", "action", "planDigest"],
    "plan",
  );
  if (record.kind !== "takoserver.exact-failed-run-artifact-recovery-plan@v1") {
    throw new TypeError("artifact recovery plan kind is invalid");
  }
  if (record.requestDigest !== input.requestDigest || record.receiptId !== input.receiptId) {
    throw new TypeError("artifact recovery plan request identity is mismatched");
  }
  const observedPhase = record.observedPhase;
  if (
    observedPhase !== "eligible" &&
    observedPhase !== "receipt-issued" &&
    observedPhase !== "quarantined" &&
    observedPhase !== "settling" &&
    observedPhase !== "requarantined" &&
    observedPhase !== "complete"
  ) {
    throw new TypeError("artifact recovery plan phase is invalid");
  }
  const action = record.action;
  if (
    action !== "issue-receipt" &&
    action !== "prepare-exact-set" &&
    action !== "wait" &&
    action !== "settle-exact-set" &&
    action !== "none"
  ) {
    throw new TypeError("artifact recovery plan action is invalid");
  }
  const phaseActionValid =
    (observedPhase === "eligible" && action === "issue-receipt") ||
    (observedPhase === "receipt-issued" && action === "prepare-exact-set") ||
    (observedPhase === "complete" && action === "none") ||
    ((observedPhase === "quarantined" ||
      observedPhase === "settling" ||
      observedPhase === "requarantined") &&
      (action === "wait" || action === "settle-exact-set"));
  if (!phaseActionValid) throw new TypeError("artifact recovery plan phase/action is inconsistent");
  const body = {
    kind: "takoserver.exact-failed-run-artifact-recovery-plan@v1" as const,
    requestDigest: input.requestDigest,
    receiptId: input.receiptId,
    observedPhase: observedPhase as ArtifactRecoveryPhase,
    action: action as ArtifactRecoveryPlan["action"],
  };
  const planDigest = digest(record.planDigest, "planDigest");
  if ((await canonicalDigest(body)) !== planDigest) {
    throw new TypeError("artifact recovery plan digest is mismatched");
  }
  return { ...body, planDigest };
}

export async function canonicalArtifactRecoveryApplyResult(
  value: unknown,
  input: CanonicalArtifactRecoveryRequest,
): Promise<ArtifactRecoveryApplyResult> {
  const record = object(value, "artifact recovery apply result");
  exactNamedKeys(record, ["kind", "plan", "readback"], "apply result");
  if (record.kind !== "takoserver.exact-failed-run-artifact-recovery-apply@v1") {
    throw new TypeError("artifact recovery apply result kind is invalid");
  }
  return {
    kind: "takoserver.exact-failed-run-artifact-recovery-apply@v1",
    plan: await canonicalArtifactRecoveryPlan(record.plan, input),
    readback: canonicalArtifactRecoveryReadback(record.readback, input),
  };
}

async function artifactRecoveryPlan(
  readback: ArtifactRecoveryReadback,
  timestamp: number,
): Promise<ArtifactRecoveryPlan> {
  const action: ArtifactRecoveryPlan["action"] =
    readback.phase === "eligible"
      ? "issue-receipt"
      : readback.phase === "receipt-issued"
        ? "prepare-exact-set"
        : readback.phase === "complete"
          ? "none"
          : readback.quarantineNotBefore !== null && readback.quarantineNotBefore > timestamp
            ? "wait"
            : "settle-exact-set";
  const body = {
    kind: "takoserver.exact-failed-run-artifact-recovery-plan@v1" as const,
    requestDigest: readback.requestDigest,
    receiptId: readback.receiptId,
    observedPhase: readback.phase,
    action,
  };
  return { ...body, planDigest: await canonicalDigest(body) };
}

async function exactRecoveryReadback(
  sql: Sql,
  objects: Pick<ObjectStoreAccess, "head">,
  clock: Clock,
  input: CanonicalArtifactRecoveryRequest,
): Promise<ArtifactRecoveryReadback> {
  const request = input.request;
  const timestamp = clock().getTime();
  if (!Number.isSafeInteger(timestamp) || timestamp < request.closedAt) {
    throw new Error("artifact recovery closure timestamp is in the future");
  }

  const uploadRows = await sql.query(
    `SELECT tenant_id, principal_id, manifest_json, manifest_digest,
            lifecycle_state, lifecycle_fence, created_at
     FROM tf_artifact_uploads WHERE id = ?`,
    [request.uploadId],
  );
  if (uploadRows.length !== 1) throw new Error("artifact recovery upload identity is unavailable");
  const upload = uploadRows[0] as Row;
  if (
    upload.tenant_id !== request.tenantId ||
    upload.principal_id !== request.principalId ||
    upload.manifest_digest !== request.manifestDigest ||
    upload.lifecycle_state !== "committed"
  ) {
    throw new Error("artifact recovery upload identity drifted from the exact request");
  }
  const uploadFence = integerColumn(upload, "lifecycle_fence");
  const uploadCreatedAt = integerColumn(upload, "created_at");
  if (request.closedAt < uploadCreatedAt) {
    throw new Error("artifact recovery closure predates its upload");
  }
  const uploadManifestJson = stringColumn(upload, "manifest_json");
  let uploadManifest: unknown;
  try {
    uploadManifest = JSON.parse(uploadManifestJson);
  } catch {
    throw new Error("artifact recovery upload manifest is not JSON");
  }
  if ((await canonicalDigest(uploadManifest)) !== request.manifestDigest) {
    throw new Error("artifact recovery manifest digest drifted from its canonical bytes");
  }
  if (canonicalJson(manifestMembers(uploadManifest)) !== canonicalJson(request.memberDigests)) {
    throw new Error("artifact recovery manifest member identity drifted from the exact request");
  }

  const receiptRows = await sql.query(
    `SELECT receipt_id, receipt_fence, tenant_id, principal_id, upload_id,
            manifest_digest, upload_fence, root_fence, state, closed_at, expires_at
     FROM tf_artifact_owner_closure_receipts
     WHERE receipt_id = ?`,
    [input.receiptId],
  );
  const otherReceipts = await sql.query(
    `SELECT receipt_id FROM tf_artifact_owner_closure_receipts
     WHERE tenant_id = ? AND principal_id = ? AND upload_id = ? AND manifest_digest = ?
       AND receipt_id <> ?`,
    [
      request.tenantId,
      request.principalId,
      request.uploadId,
      request.manifestDigest,
      input.receiptId,
    ],
  );
  if (otherReceipts.length > 0) {
    throw new Error("artifact recovery upload already has a different durable receipt");
  }
  const receipt = receiptRows[0];
  if (receiptRows.length > 1) throw new Error("artifact recovery receipt identity is ambiguous");
  if (
    receipt &&
    (!exactReceipt(receipt, input) || integerColumn(receipt, "expires_at") <= timestamp)
  ) {
    throw new Error("artifact recovery receipt id exists with different content");
  }

  const memberRows = await sql.query(
    `SELECT blob_digest FROM tf_artifact_manifest_members
     WHERE manifest_digest = ? ORDER BY blob_digest`,
    [request.manifestDigest],
  );
  const members = memberRows.map((row) => digestColumn(row, "blob_digest"));
  const manifestRows = await sql.query(
    "SELECT manifest_json FROM tf_artifact_manifests WHERE digest = ?",
    [request.manifestDigest],
  );
  if (manifestRows.length > 1) throw new Error("artifact recovery manifest metadata is ambiguous");
  const metadataPresent = manifestRows.length === 1;
  if (metadataPresent) {
    const metadataJson = stringColumn(manifestRows[0], "manifest_json");
    if (metadataJson !== uploadManifestJson) {
      throw new Error("artifact recovery manifest metadata drifted from its committed upload");
    }
    if (canonicalJson(members) !== canonicalJson(request.memberDigests)) {
      throw new Error("artifact recovery durable member set drifted from the exact request");
    }
  } else if (members.length > 0) {
    throw new Error("artifact recovery member metadata survived without its manifest");
  }

  const uploadRootRows = await sql.query(
    `SELECT state, fence, release_reason FROM tf_artifact_roots
     WHERE tenant_id = ? AND root_kind = 'upload' AND root_id = ?
       AND target_kind = 'manifest' AND digest = ?`,
    [request.tenantId, request.uploadId, request.manifestDigest],
  );
  if (uploadRootRows.length !== 1)
    throw new Error("artifact recovery upload root identity drifted");
  const uploadRoot = uploadRootRows[0] as Row;
  const uploadRootState = stringColumn(uploadRoot, "state");
  const uploadRootFence = integerColumn(uploadRoot, "fence");

  const activeUncertainties = await sql.query(
    `SELECT consumer_kind, consumer_id FROM tf_artifact_consumer_uncertainties
     WHERE tenant_id = ? AND state = 'active' LIMIT 1`,
    [request.tenantId],
  );
  if (activeUncertainties.length > 0) {
    throw new Error("artifact recovery is blocked by consumer uncertainty");
  }
  await assertNoUnexpectedLiveRoots(sql, input, uploadRootState === "active");

  const actualHolds = await targetHolds(sql, input);
  const replayRows = await targetReplayRows(sql, input);
  const replayRoots = await targetReplayRoots(sql, input);
  const candidates = await recoveryCandidates(sql, input, true);
  const presentBlobs = await countPresentBlobs(objects, request.memberDigests);

  if (!receipt) {
    if (uploadFence !== request.uploadFence || uploadRootFence !== request.rootFence) {
      throw new Error("artifact recovery upload/root fence drifted from the exact request");
    }
    if (uploadRootState !== "active") {
      throw new Error("artifact recovery upload root is not active before receipt issuance");
    }
    assertExactPreRecoveryState(input, actualHolds, replayRows, replayRoots, candidates);
    if (!metadataPresent || presentBlobs !== EXACT_FAILED_RUN_MEMBER_COUNT) {
      throw new Error("artifact recovery exact 29-object set is incomplete");
    }
    return readback(
      input,
      "eligible",
      uploadFence,
      emptyCandidateCounts(),
      null,
      true,
      presentBlobs,
    );
  }

  if (uploadRootState === "active") {
    if (uploadFence !== request.uploadFence || uploadRootFence !== request.rootFence) {
      throw new Error("artifact recovery receipt no longer matches its active fences");
    }
    assertExactPreRecoveryState(input, actualHolds, replayRows, replayRoots, candidates);
    if (!metadataPresent || presentBlobs !== EXACT_FAILED_RUN_MEMBER_COUNT) {
      throw new Error("artifact recovery exact set changed after receipt issuance");
    }
    return readback(
      input,
      "receipt-issued",
      uploadFence,
      emptyCandidateCounts(),
      null,
      true,
      presentBlobs,
    );
  }

  if (
    uploadRootState !== "released" ||
    uploadRoot.release_reason !== "operator_exact_failed_run" ||
    uploadFence !== request.uploadFence + 1 ||
    uploadRootFence !== request.rootFence + 1
  ) {
    throw new Error("artifact recovery released upload/root fence is not exact");
  }
  if (actualHolds.length !== 0 || replayRows.length !== 0) {
    throw new Error("artifact recovery released hold/replay set is not empty");
  }
  if (
    replayRoots.length !== request.expectedReplays.count ||
    replayRoots.some(
      (root) =>
        root.state !== "released" ||
        root.fence !== 2 ||
        root.release_reason !== "operator_exact_failed_run",
    )
  ) {
    throw new Error("artifact recovery replay-root release set drifted");
  }
  if (candidates.length !== EXACT_FAILED_RUN_MEMBER_COUNT + 1) {
    throw new Error("artifact recovery does not own exactly 29 candidates");
  }
  const counts = candidateCounts(candidates);
  const remaining = candidates.filter((candidate) => candidate.state !== "deleted");
  const manifestCandidate = candidates.find((candidate) => candidate.kind === "manifest");
  if (!manifestCandidate) throw new Error("artifact recovery manifest candidate is missing");
  const remainingBlobs = remaining.filter((candidate) => candidate.kind === "blob");
  const nextActionable = remainingBlobs.length > 0 ? remainingBlobs : [manifestCandidate];
  const quarantineNotBefore =
    remaining.length === 0
      ? null
      : Math.min(...nextActionable.map((candidate) => candidate.notBefore));
  if (remaining.length === 0) {
    if (metadataPresent || members.length > 0 || presentBlobs !== 0) {
      throw new Error("artifact recovery tombstones exist before exact absence readback");
    }
    return readback(input, "complete", uploadFence, counts, null, false, presentBlobs);
  }
  if (manifestCandidate.state === "deleted") {
    throw new Error("artifact recovery manifest tombstone precedes its blob set");
  }
  if (!metadataPresent) {
    throw new Error("artifact recovery manifest metadata disappeared before its tombstone");
  }
  const phase: ArtifactRecoveryPhase =
    counts.retry > 0 &&
    candidates.some((candidate) => candidate.state === "retry" && candidate.notBefore > timestamp)
      ? "requarantined"
      : counts.deleted > 0 || counts.deleting > 0 || counts.retry > 0
        ? "settling"
        : "quarantined";
  return readback(
    input,
    phase,
    uploadFence,
    counts,
    quarantineNotBefore,
    metadataPresent,
    presentBlobs,
  );
}

function readback(
  input: CanonicalArtifactRecoveryRequest,
  phase: ArtifactRecoveryPhase,
  uploadFence: number,
  candidates: ArtifactRecoveryReadback["candidates"],
  quarantineNotBefore: number | null,
  metadataPresent: boolean,
  presentBlobs: number,
): ArtifactRecoveryReadback {
  return {
    kind: "takoserver.exact-failed-run-artifact-recovery-readback@v1",
    requestDigest: input.requestDigest,
    receiptId: input.receiptId,
    phase,
    upload: { lifecycle: "committed", fence: uploadFence },
    candidates,
    quarantineNotBefore,
    metadataPresent,
    presentBlobs,
    absentBlobs: EXACT_FAILED_RUN_MEMBER_COUNT - presentBlobs,
  };
}

function emptyCandidateCounts(): ArtifactRecoveryReadback["candidates"] {
  return { pending: 0, deleting: 0, retry: 0, deleted: 0 };
}

function candidateCounts(
  candidates: readonly CandidateState[],
): ArtifactRecoveryReadback["candidates"] {
  const counts = { pending: 0, deleting: 0, retry: 0, deleted: 0 };
  for (const candidate of candidates) counts[candidate.state] += 1;
  return counts;
}

function exactReceipt(row: Row, input: CanonicalArtifactRecoveryRequest): boolean {
  const request = input.request;
  return (
    row.receipt_id === input.receiptId &&
    row.receipt_fence === 1 &&
    row.tenant_id === request.tenantId &&
    row.principal_id === request.principalId &&
    row.upload_id === request.uploadId &&
    row.manifest_digest === request.manifestDigest &&
    row.upload_fence === request.uploadFence &&
    row.root_fence === request.rootFence &&
    row.state === "closed" &&
    row.closed_at === request.closedAt &&
    row.expires_at === DURABLE_RECEIPT_EXPIRES_AT
  );
}

function manifestMembers(value: unknown): readonly Digest[] {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("artifact recovery manifest is not an object");
  }
  const record = value as Record<string, unknown>;
  const entries = Array.isArray(record.modules)
    ? record.modules
    : Array.isArray(record.files)
      ? record.files
      : null;
  if (!entries) throw new Error("artifact recovery manifest has no member set");
  const members = entries.map((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      throw new Error("artifact recovery manifest member is invalid");
    }
    return digest((entry as Record<string, unknown>).digest, "manifest member digest");
  });
  return [...members].sort();
}

async function targetHolds(
  sql: Sql,
  input: CanonicalArtifactRecoveryRequest,
): Promise<readonly ArtifactRecoveryHold[]> {
  const rows = await sql.query(
    `SELECT tenant_id, kind, digest FROM tf_artifact_holds
     WHERE digest = ? OR digest IN
       (SELECT CAST(value AS TEXT) FROM json_each(?))
     ORDER BY tenant_id, CASE kind WHEN 'manifest' THEN 0 ELSE 1 END, digest`,
    [input.request.manifestDigest, JSON.stringify(input.request.memberDigests)],
  );
  return rows.map((row) => {
    if (row.tenant_id !== input.request.tenantId) {
      throw new Error("artifact recovery is blocked by a foreign hold");
    }
    const kind = stringColumn(row, "kind");
    if (kind !== "manifest" && kind !== "blob")
      throw new Error("artifact recovery hold kind is invalid");
    return { kind, digest: digestColumn(row, "digest") };
  });
}

async function targetReplayRows(
  sql: Sql,
  input: CanonicalArtifactRecoveryRequest,
): Promise<readonly string[]> {
  const rows = await sql.query(
    `SELECT replay_key,
            json_extract(body_json, '$.manifestDigest') AS manifest_digest
     FROM tf_artifact_replays
     WHERE replay_key IN (SELECT CAST(value AS TEXT) FROM json_each(?))
        OR json_extract(body_json, '$.manifestDigest') = ?
     ORDER BY replay_key`,
    [JSON.stringify(input.request.expectedReplays.keys), input.request.manifestDigest],
  );
  return rows.map((row) => {
    const key = stringColumn(row, "replay_key");
    if (
      !input.request.expectedReplays.keys.includes(key) ||
      row.manifest_digest !== input.request.manifestDigest
    ) {
      throw new Error("artifact recovery is blocked by a shared replay");
    }
    return key;
  });
}

async function targetReplayRoots(
  sql: Sql,
  input: CanonicalArtifactRecoveryRequest,
): Promise<
  readonly {
    readonly id: string;
    readonly state: string;
    readonly fence: number;
    readonly release_reason: unknown;
  }[]
> {
  const rows = await sql.query(
    `SELECT tenant_id, root_id, state, fence, release_reason FROM tf_artifact_roots
     WHERE root_kind = 'replay' AND target_kind = 'manifest' AND digest = ?
     ORDER BY tenant_id, root_id`,
    [input.request.manifestDigest],
  );
  return rows.map((row) => {
    if (
      row.tenant_id !== input.request.tenantId ||
      !input.request.expectedReplays.keys.includes(stringColumn(row, "root_id"))
    ) {
      throw new Error("artifact recovery is blocked by a foreign or shared replay root");
    }
    return {
      id: stringColumn(row, "root_id"),
      state: stringColumn(row, "state"),
      fence: positiveIntegerColumn(row, "fence"),
      release_reason: row.release_reason,
    };
  });
}

function assertExactPreRecoveryState(
  input: CanonicalArtifactRecoveryRequest,
  holds: readonly ArtifactRecoveryHold[],
  replayRows: readonly string[],
  replayRoots: readonly { readonly id: string; readonly state: string; readonly fence: number }[],
  candidates: readonly CandidateState[],
): void {
  if (canonicalJson(holds) !== canonicalJson(input.request.expectedHolds.entries)) {
    throw new Error("artifact recovery hold set drifted from the exact request");
  }
  if (canonicalJson(replayRows) !== canonicalJson(input.request.expectedReplays.keys)) {
    throw new Error("artifact recovery replay set drifted from the exact request");
  }
  if (
    replayRoots.length !== input.request.expectedReplays.count ||
    replayRoots.some((root) => root.state !== "active" || root.fence !== 1) ||
    canonicalJson(replayRoots.map((root) => root.id)) !==
      canonicalJson(input.request.expectedReplays.keys)
  ) {
    throw new Error("artifact recovery replay-root set drifted from the exact request");
  }
  if (candidates.length !== 0) {
    throw new Error("artifact recovery exact object already has a foreign GC candidate");
  }
}

async function assertNoUnexpectedLiveRoots(
  sql: Sql,
  input: CanonicalArtifactRecoveryRequest,
  beforeReceipt: boolean,
): Promise<void> {
  const request = input.request;
  const rows = await sql.query(
    `SELECT live.tenant_id, live.root_kind, live.root_id, live.target_kind, live.digest
     FROM tf_artifact_roots AS live
     WHERE live.state = 'active' AND (
       (live.target_kind = 'manifest' AND live.digest = ?) OR
       (live.target_kind = 'blob' AND live.digest IN
         (SELECT CAST(value AS TEXT) FROM json_each(?))) OR
       (live.target_kind = 'manifest' AND EXISTS (
         SELECT 1 FROM tf_artifact_manifest_members AS shared_member
         WHERE shared_member.manifest_digest = live.digest
           AND shared_member.blob_digest IN
             (SELECT CAST(value AS TEXT) FROM json_each(?))
       ))
     )`,
    [
      request.manifestDigest,
      JSON.stringify(request.memberDigests),
      JSON.stringify(request.memberDigests),
    ],
  );
  for (const row of rows) {
    const allowed =
      beforeReceipt &&
      row.tenant_id === request.tenantId &&
      row.target_kind === "manifest" &&
      row.digest === request.manifestDigest &&
      ((row.root_kind === "upload" && row.root_id === request.uploadId) ||
        (row.root_kind === "replay" &&
          request.expectedReplays.keys.includes(stringColumn(row, "root_id"))));
    if (allowed) continue;
    if (row.root_kind === "resource" || row.root_kind === "deployment") {
      throw new Error("artifact recovery is blocked by a live consumer root");
    }
    if (row.tenant_id !== request.tenantId) {
      throw new Error("artifact recovery is blocked by a foreign root");
    }
    throw new Error("artifact recovery is blocked by a shared root");
  }
}

async function countPresentBlobs(
  objects: Pick<ObjectStoreAccess, "head">,
  members: readonly Digest[],
): Promise<number> {
  let present = 0;
  for (const member of members) if (await objects.head(blobKey(member))) present += 1;
  return present;
}

async function recoveryCandidates(
  sql: Sql,
  input: CanonicalArtifactRecoveryRequest,
  allowAbsent = false,
): Promise<readonly CandidateState[]> {
  const rows = await sql.query(
    `SELECT kind, digest, state, fence, not_before, expected_etag, attempts,
            last_outcome, created_at, updated_at, deleted_at
     FROM tf_artifact_gc_candidates
     WHERE (kind = 'manifest' AND digest = ?)
        OR (kind = 'blob' AND digest IN
          (SELECT CAST(value AS TEXT) FROM json_each(?)))
     ORDER BY CASE kind WHEN 'blob' THEN 0 ELSE 1 END, digest`,
    [input.request.manifestDigest, JSON.stringify(input.request.memberDigests)],
  );
  if (rows.length === 0 && allowAbsent) return [];
  return rows.map((row) => {
    const kind = stringColumn(row, "kind");
    const state = stringColumn(row, "state");
    if (kind !== "manifest" && kind !== "blob")
      throw new Error("artifact recovery candidate kind is invalid");
    if (state !== "pending" && state !== "deleting" && state !== "retry" && state !== "deleted") {
      throw new Error("artifact recovery candidate state is invalid");
    }
    const etag = row.expected_etag;
    if (etag !== null && typeof etag !== "string") {
      throw new Error("artifact recovery candidate ETag is invalid");
    }
    const candidate: CandidateState = {
      kind,
      digest: digestColumn(row, "digest"),
      state,
      fence: positiveIntegerColumn(row, "fence"),
      notBefore: integerColumn(row, "not_before"),
      expectedEtag: etag,
      attempts: integerColumn(row, "attempts"),
      lastOutcome: stringColumn(row, "last_outcome"),
      createdAt: integerColumn(row, "created_at"),
      updatedAt: integerColumn(row, "updated_at"),
      deletedAt: nullableIntegerColumn(row, "deleted_at"),
    };
    assertExactCandidateState(candidate);
    return candidate;
  });
}

function assertExactCandidateState(candidate: CandidateState): void {
  if (candidate.updatedAt < candidate.createdAt) {
    throw new Error("artifact recovery candidate timestamp drifted");
  }
  if (candidate.state === "pending") {
    if (
      candidate.fence !== 1 ||
      candidate.attempts !== 0 ||
      candidate.lastOutcome !== "pending" ||
      candidate.updatedAt !== candidate.createdAt ||
      candidate.deletedAt !== null ||
      candidate.notBefore < candidate.createdAt + QUARANTINE_MILLISECONDS ||
      (candidate.kind === "blob") !== (candidate.expectedEtag !== null)
    ) {
      throw new Error("artifact recovery candidate fence/state drifted");
    }
    return;
  }
  if (candidate.state === "deleting") {
    if (
      candidate.attempts < 1 ||
      candidate.fence !== candidate.attempts * 2 ||
      candidate.lastOutcome !== "claimed" ||
      candidate.deletedAt !== null ||
      (candidate.kind === "blob") !== (candidate.expectedEtag !== null)
    ) {
      throw new Error("artifact recovery candidate fence/state drifted");
    }
    return;
  }
  if (candidate.state === "retry") {
    if (
      candidate.kind !== "blob" ||
      candidate.attempts < 1 ||
      candidate.fence !== candidate.attempts * 2 + 1 ||
      (candidate.lastOutcome !== "etag_changed" && candidate.lastOutcome !== "delete_failed") ||
      candidate.expectedEtag === null ||
      candidate.deletedAt !== null ||
      candidate.notBefore < candidate.updatedAt + QUARANTINE_MILLISECONDS
    ) {
      throw new Error("artifact recovery candidate fence/state drifted");
    }
    return;
  }
  const exactDeleted =
    candidate.expectedEtag === null &&
    candidate.deletedAt !== null &&
    candidate.attempts >= 1 &&
    candidate.fence === candidate.attempts * 2 &&
    (candidate.kind === "manifest"
      ? candidate.attempts === 1 && candidate.lastOutcome === "metadata_deleted"
      : candidate.lastOutcome === "deleted" || candidate.lastOutcome === "already_absent");
  if (!exactDeleted) throw new Error("artifact recovery candidate fence/state drifted");
}

async function settleBlobCandidate(
  sql: Sql,
  objects: Pick<ObjectStoreAccess, "head" | "delete">,
  now: () => number,
  guardToken: (suffix: string) => string,
  input: CanonicalArtifactRecoveryRequest,
  candidate: CandidateState,
): Promise<void> {
  const claimed =
    candidate.state === "deleting"
      ? candidate
      : await claimRecoveryCandidate(sql, now, guardToken, input, candidate);
  await refenceDeletingCandidate(sql, now, guardToken, input, claimed);
  const current = await objects.head(blobKey(claimed.digest));
  if (!current) {
    await markRecoveryCandidateDeleted(sql, now, guardToken, input, claimed, "already_absent");
    return;
  }
  if (claimed.expectedEtag === null || current.etag !== claimed.expectedEtag) {
    await requarantineRecoveryCandidate(
      sql,
      now,
      guardToken,
      input,
      claimed,
      current.etag,
      "etag_changed",
    );
    return;
  }
  try {
    await objects.delete(blobKey(claimed.digest));
  } catch {
    await requarantineRecoveryCandidate(
      sql,
      now,
      guardToken,
      input,
      claimed,
      current.etag,
      "delete_failed",
    );
    return;
  }
  // SQL settlement is deliberately separate. If its acknowledgement is lost,
  // the durable candidate stays deleting; the next explicit apply sees R2
  // absence and records already_absent without issuing DELETE again.
  await markRecoveryCandidateDeleted(sql, now, guardToken, input, claimed, "deleted");
}

async function refenceDeletingCandidate(
  sql: Sql,
  now: () => number,
  guardToken: (suffix: string) => string,
  input: CanonicalArtifactRecoveryRequest,
  candidate: CandidateState,
): Promise<void> {
  const writes = await guardedCandidateBatch(
    sql,
    input,
    candidate,
    guardToken(`delete-fence-${candidate.digest.slice(-12)}`),
    now(),
    [
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET updated_at = updated_at
              WHERE kind = ? AND digest = ? AND state = 'deleting' AND fence = ?`,
        params: [candidate.kind, candidate.digest, candidate.fence],
      },
    ],
  );
  if (writes[1]?.changes !== 1) {
    throw new Error("artifact recovery external delete lost its durable fence");
  }
}

async function claimRecoveryCandidate(
  sql: Sql,
  now: () => number,
  guardToken: (suffix: string) => string,
  input: CanonicalArtifactRecoveryRequest,
  candidate: CandidateState,
): Promise<CandidateState> {
  const token = guardToken(`claim-${candidate.digest.slice(-12)}`);
  const timestamp = now();
  const writes = await guardedCandidateBatch(sql, input, candidate, token, timestamp, [
    {
      sql: `UPDATE tf_artifact_gc_candidates
            SET state = 'deleting', fence = fence + 1, attempts = attempts + 1,
                last_outcome = 'claimed', updated_at = ?
            WHERE kind = ? AND digest = ?
              AND state IN ('pending', 'retry') AND fence = ? AND not_before <= ?`,
      params: [timestamp, candidate.kind, candidate.digest, candidate.fence, timestamp],
    },
  ]);
  if (writes[1]?.changes !== 1) throw new Error("artifact recovery candidate claim lost its fence");
  const rows = await recoveryCandidates(sql, input);
  const claimed = rows.find(
    (entry) => entry.kind === candidate.kind && entry.digest === candidate.digest,
  );
  if (claimed?.state !== "deleting") {
    throw new Error("artifact recovery candidate claim readback failed");
  }
  return claimed;
}

async function markRecoveryCandidateDeleted(
  sql: Sql,
  now: () => number,
  guardToken: (suffix: string) => string,
  input: CanonicalArtifactRecoveryRequest,
  candidate: CandidateState,
  outcome: "deleted" | "already_absent",
): Promise<void> {
  const timestamp = now();
  const writes = await guardedCandidateBatch(
    sql,
    input,
    candidate,
    guardToken(`settle-${candidate.digest.slice(-12)}`),
    timestamp,
    [
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'deleted', expected_etag = NULL, last_outcome = ?,
                  updated_at = ?, deleted_at = ?
              WHERE kind = ? AND digest = ?
                AND state = 'deleting' AND fence = ?`,
        params: [outcome, timestamp, timestamp, candidate.kind, candidate.digest, candidate.fence],
      },
    ],
  );
  if (writes[1]?.changes !== 1) {
    throw new Error("artifact recovery candidate settlement lost its fence");
  }
}

async function requarantineRecoveryCandidate(
  sql: Sql,
  now: () => number,
  guardToken: (suffix: string) => string,
  input: CanonicalArtifactRecoveryRequest,
  candidate: CandidateState,
  expectedEtag: string,
  outcome: "etag_changed" | "delete_failed",
): Promise<void> {
  const timestamp = now();
  const writes = await guardedCandidateBatch(
    sql,
    input,
    candidate,
    guardToken(`retry-${candidate.digest.slice(-12)}`),
    timestamp,
    [
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'retry', fence = fence + 1, expected_etag = ?,
                  not_before = ?, last_outcome = ?, updated_at = ?, deleted_at = NULL
              WHERE kind = ? AND digest = ?
                AND state = 'deleting' AND fence = ?`,
        params: [
          expectedEtag,
          timestamp + QUARANTINE_MILLISECONDS,
          outcome,
          timestamp,
          candidate.kind,
          candidate.digest,
          candidate.fence,
        ],
      },
    ],
  );
  if (writes[1]?.changes !== 1) throw new Error("artifact recovery retry lost its fence");
}

async function settleManifestCandidate(
  sql: Sql,
  now: () => number,
  guardToken: (suffix: string) => string,
  input: CanonicalArtifactRecoveryRequest,
  candidate: CandidateState,
): Promise<void> {
  const claimed =
    candidate.state === "deleting"
      ? candidate
      : await claimRecoveryCandidate(sql, now, guardToken, input, candidate);
  const timestamp = now();
  const writes = await guardedCandidateBatch(
    sql,
    input,
    claimed,
    guardToken("settle-manifest"),
    timestamp,
    [
      {
        sql: `DELETE FROM tf_artifact_manifest_members
              WHERE manifest_digest = ? AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_gc_candidates AS member_candidate
                WHERE member_candidate.kind = 'blob'
                  AND member_candidate.digest IN
                    (SELECT CAST(value AS TEXT) FROM json_each(?))
                  AND member_candidate.state <> 'deleted'
              )`,
        params: [input.request.manifestDigest, JSON.stringify(input.request.memberDigests)],
      },
      {
        sql: "DELETE FROM tf_artifact_manifests WHERE digest = ?",
        params: [input.request.manifestDigest],
      },
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'deleted', expected_etag = NULL,
                  last_outcome = 'metadata_deleted', updated_at = ?, deleted_at = ?
              WHERE kind = 'manifest' AND digest = ?
                AND state = 'deleting' AND fence = ?`,
        params: [timestamp, timestamp, input.request.manifestDigest, claimed.fence],
      },
    ],
  );
  if (writes[3]?.changes !== 1) {
    throw new Error("artifact recovery manifest settlement lost its fence");
  }
}

async function guardedCandidateBatch(
  sql: Sql,
  input: CanonicalArtifactRecoveryRequest,
  candidate: CandidateState,
  token: string,
  timestamp: number,
  mutations: readonly SqlStatement[],
): Promise<readonly { readonly changes: number }[]> {
  const membersJson = JSON.stringify(input.request.memberDigests);
  return await sql.batch([
    {
      sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
            SELECT ?, CASE WHEN
              EXISTS (
                SELECT 1 FROM tf_artifact_gc_candidates AS candidate
                WHERE candidate.kind = ? AND candidate.digest = ?
                  AND candidate.state = ? AND candidate.fence = ?
              )
              AND EXISTS (
                SELECT 1 FROM tf_artifact_owner_closure_receipts AS receipt
                WHERE receipt.receipt_id = ? AND receipt.receipt_fence = 1
                  AND receipt.tenant_id = ? AND receipt.principal_id = ?
                  AND receipt.upload_id = ? AND receipt.manifest_digest = ?
                  AND receipt.upload_fence = ? AND receipt.root_fence = ?
                  AND receipt.state = 'closed' AND receipt.closed_at = ?
                  AND receipt.expires_at > ?
              )
              AND EXISTS (
                SELECT 1 FROM tf_artifact_uploads AS upload
                WHERE upload.id = ? AND upload.tenant_id = ?
                  AND upload.principal_id = ? AND upload.manifest_digest = ?
                  AND upload.lifecycle_state = 'committed'
                  AND upload.lifecycle_fence = ?
              )
              AND EXISTS (
                SELECT 1 FROM tf_artifact_roots AS upload_root
                WHERE upload_root.tenant_id = ? AND upload_root.root_kind = 'upload'
                  AND upload_root.root_id = ? AND upload_root.target_kind = 'manifest'
                  AND upload_root.digest = ? AND upload_root.state = 'released'
                  AND upload_root.fence = ?
                  AND upload_root.release_reason = 'operator_exact_failed_run'
              )
              AND EXISTS (
                SELECT 1 FROM tf_artifact_manifests AS metadata
                JOIN tf_artifact_uploads AS upload ON upload.id = ?
                WHERE metadata.digest = ?
                  AND metadata.manifest_json = upload.manifest_json
              )
              AND (SELECT COUNT(*) FROM tf_artifact_manifest_members AS member
                   WHERE member.manifest_digest = ?) = 28
              AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_manifest_members AS member
                WHERE member.manifest_digest = ? AND member.blob_digest NOT IN
                  (SELECT CAST(value AS TEXT) FROM json_each(?))
              )
              AND (SELECT COUNT(*) FROM tf_artifact_gc_candidates AS exact_candidate
                   WHERE (exact_candidate.kind = 'manifest' AND exact_candidate.digest = ?)
                      OR (exact_candidate.kind = 'blob' AND exact_candidate.digest IN
                        (SELECT CAST(value AS TEXT) FROM json_each(?)))) = 29
              AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_holds AS hold
                WHERE hold.digest = ? OR hold.digest IN
                  (SELECT CAST(value AS TEXT) FROM json_each(?))
              )
              AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_replays AS replay
                WHERE replay.replay_key IN
                    (SELECT CAST(value AS TEXT) FROM json_each(?))
                   OR json_extract(replay.body_json, '$.manifestDigest') = ?
              )
              AND (SELECT COUNT(*) FROM tf_artifact_roots AS replay_root
                   WHERE replay_root.root_kind = 'replay'
                     AND replay_root.target_kind = 'manifest'
                     AND replay_root.digest = ?) = ?
              AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_roots AS replay_root
                WHERE replay_root.root_kind = 'replay'
                  AND replay_root.target_kind = 'manifest'
                  AND replay_root.digest = ? AND NOT (
                    replay_root.tenant_id = ?
                    AND replay_root.root_id IN
                      (SELECT CAST(value AS TEXT) FROM json_each(?))
                    AND replay_root.state = 'released' AND replay_root.fence = 2
                    AND replay_root.release_reason = 'operator_exact_failed_run'
                  )
              )
              AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_consumer_uncertainties
                WHERE tenant_id = ? AND state = 'active'
              )
              AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_roots AS live
                WHERE live.state = 'active' AND (
                  (live.target_kind = 'manifest' AND live.digest = ?) OR
                  (live.target_kind = 'blob' AND live.digest IN
                    (SELECT CAST(value AS TEXT) FROM json_each(?))) OR
                  (live.target_kind = 'manifest' AND EXISTS (
                    SELECT 1 FROM tf_artifact_manifest_members AS shared_member
                    WHERE shared_member.manifest_digest = live.digest
                      AND shared_member.blob_digest IN
                        (SELECT CAST(value AS TEXT) FROM json_each(?))
                  ))
                )
              )
            THEN 1 ELSE 0 END`,
      params: [
        token,
        candidate.kind,
        candidate.digest,
        candidate.state,
        candidate.fence,
        input.receiptId,
        input.request.tenantId,
        input.request.principalId,
        input.request.uploadId,
        input.request.manifestDigest,
        input.request.uploadFence,
        input.request.rootFence,
        input.request.closedAt,
        timestamp,
        input.request.uploadId,
        input.request.tenantId,
        input.request.principalId,
        input.request.manifestDigest,
        input.request.uploadFence + 1,
        input.request.tenantId,
        input.request.uploadId,
        input.request.manifestDigest,
        input.request.rootFence + 1,
        input.request.uploadId,
        input.request.manifestDigest,
        input.request.manifestDigest,
        input.request.manifestDigest,
        membersJson,
        input.request.manifestDigest,
        membersJson,
        input.request.manifestDigest,
        membersJson,
        JSON.stringify(input.request.expectedReplays.keys),
        input.request.manifestDigest,
        input.request.manifestDigest,
        input.request.expectedReplays.count,
        input.request.manifestDigest,
        input.request.tenantId,
        JSON.stringify(input.request.expectedReplays.keys),
        input.request.tenantId,
        input.request.manifestDigest,
        membersJson,
        membersJson,
      ],
    },
    ...mutations,
    {
      sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?",
      params: [token],
    },
  ]);
}

function blobKey(digestValue: Digest): string {
  return `art/${digestValue.slice("sha256:".length)}`;
}

function stringColumn(row: Row | undefined, name: string): string {
  const value = row?.[name];
  if (typeof value !== "string") throw new Error(`artifact recovery durable ${name} is invalid`);
  return value;
}

function digestColumn(row: Row | undefined, name: string): Digest {
  return digest(stringColumn(row, name), name);
}

function integerColumn(row: Row | undefined, name: string): number {
  const value = row?.[name];
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`artifact recovery durable ${name} is invalid`);
  }
  return value as number;
}

function nullableIntegerColumn(row: Row | undefined, name: string): number | null {
  if (row?.[name] === null) return null;
  return integerColumn(row, name);
}

function positiveIntegerColumn(row: Row | undefined, name: string): number {
  const value = integerColumn(row, name);
  if (value < 1) throw new Error(`artifact recovery durable ${name} is invalid`);
  return value;
}

function exactRequest(value: unknown): ArtifactRecoveryRequest {
  const record = object(value, "artifact recovery request");
  exactKeys(record, [
    "kind",
    "tenantId",
    "principalId",
    "uploadId",
    "manifestDigest",
    "uploadFence",
    "rootFence",
    "memberDigests",
    "memberSetDigest",
    "expectedHolds",
    "expectedReplays",
    "failedRunEvidence",
    "closedAt",
  ]);
  if (record.kind !== ARTIFACT_RECOVERY_REQUEST_KIND) {
    throw new TypeError(`artifact recovery request kind must be ${ARTIFACT_RECOVERY_REQUEST_KIND}`);
  }
  const tenantId = boundedString(record.tenantId, "tenantId", 1, 255);
  const principalId = boundedString(record.principalId, "principalId", 5, 255);
  if (!principalId.startsWith("run:")) {
    throw new TypeError("artifact recovery principalId must use the run: authority namespace");
  }
  const uploadId = boundedString(record.uploadId, "uploadId", 3, 128);
  const manifestDigest = digest(record.manifestDigest, "manifestDigest");
  const uploadFence = positiveInteger(record.uploadFence, "uploadFence");
  const rootFence = positiveInteger(record.rootFence, "rootFence");
  const memberDigests = digestSet(record.memberDigests, "memberDigests");
  if (memberDigests.length !== EXACT_FAILED_RUN_MEMBER_COUNT) {
    throw new TypeError(
      `artifact recovery requires exactly ${EXACT_FAILED_RUN_MEMBER_COUNT} member digests`,
    );
  }
  if (memberDigests.includes(manifestDigest)) {
    throw new TypeError("artifact recovery manifest digest cannot also be a member digest");
  }

  const expectedHoldsRecord = object(record.expectedHolds, "expectedHolds");
  exactKeys(expectedHoldsRecord, ["entries", "count", "setDigest"]);
  if (!Array.isArray(expectedHoldsRecord.entries)) {
    throw new TypeError("artifact recovery expectedHolds.entries must be an array");
  }
  const holdEntries: ArtifactRecoveryHold[] = expectedHoldsRecord.entries.map((entry, index) => {
    const hold = object(entry, `expectedHolds.entries[${index}]`);
    exactKeys(hold, ["kind", "digest"]);
    if (hold.kind !== "manifest" && hold.kind !== "blob") {
      throw new TypeError(`artifact recovery expected hold ${index} has an invalid kind`);
    }
    return { kind: hold.kind, digest: digest(hold.digest, `expected hold ${index} digest`) };
  });
  if (
    new Set(holdEntries.map((entry) => `${entry.kind}:${entry.digest}`)).size !== holdEntries.length
  ) {
    throw new TypeError("artifact recovery expected hold entries must be unique");
  }
  const canonicalHolds: readonly ArtifactRecoveryHold[] = [
    { kind: "manifest", digest: manifestDigest },
    ...memberDigests.map((memberDigest) => ({ kind: "blob" as const, digest: memberDigest })),
  ];
  if (canonicalJson(holdEntries) !== canonicalJson(canonicalHolds)) {
    throw new TypeError("artifact recovery expected holds must be the exact manifest/member set");
  }
  const holdCount = positiveInteger(expectedHoldsRecord.count, "expectedHolds.count");
  if (holdCount !== holdEntries.length) {
    throw new TypeError("artifact recovery expected hold count does not match its exact entries");
  }

  const expectedReplaysRecord = object(record.expectedReplays, "expectedReplays");
  exactKeys(expectedReplaysRecord, ["keys", "count", "setDigest"]);
  if (!Array.isArray(expectedReplaysRecord.keys)) {
    throw new TypeError("artifact recovery expectedReplays.keys must be an array");
  }
  const replayKeys = expectedReplaysRecord.keys.map((entry, index) => {
    if (typeof entry !== "string" || entry.length < 1 || entry.length > 4096) {
      throw new TypeError(`artifact recovery expectedReplays.keys[${index}] is invalid`);
    }
    if (!entry.startsWith(`${tenantId}\u0000${principalId}\u0000`)) {
      throw new TypeError("artifact recovery replay key is outside the exact owner namespace");
    }
    return entry;
  });
  assertCanonicalUnique(replayKeys, "expected replay keys");
  const replayCount = nonnegativeInteger(expectedReplaysRecord.count, "expectedReplays.count");
  if (replayCount !== replayKeys.length) {
    throw new TypeError("artifact recovery expected replay count does not match its exact keys");
  }

  const failedRunEvidenceRecord = object(record.failedRunEvidence, "failedRunEvidence");
  exactKeys(failedRunEvidenceRecord, ["kind", "sha256"]);
  const evidenceKind = boundedString(
    failedRunEvidenceRecord.kind,
    "failedRunEvidence.kind",
    3,
    128,
  );
  if (!/^[a-z][a-z0-9.-]*@[a-zA-Z0-9._-]+$/u.test(evidenceKind)) {
    throw new TypeError("artifact recovery failed-run evidence kind is not canonical");
  }
  const closedAt = nonnegativeInteger(record.closedAt, "closedAt");
  if (closedAt >= DURABLE_RECEIPT_EXPIRES_AT) {
    throw new TypeError("artifact recovery closedAt exceeds the durable receipt lifetime");
  }

  return {
    kind: ARTIFACT_RECOVERY_REQUEST_KIND,
    tenantId,
    principalId,
    uploadId,
    manifestDigest,
    uploadFence,
    rootFence,
    memberDigests,
    memberSetDigest: digest(record.memberSetDigest, "memberSetDigest"),
    expectedHolds: {
      entries: holdEntries,
      count: holdCount,
      setDigest: digest(expectedHoldsRecord.setDigest, "expectedHolds.setDigest"),
    },
    expectedReplays: {
      keys: replayKeys,
      count: replayCount,
      setDigest: digest(expectedReplaysRecord.setDigest, "expectedReplays.setDigest"),
    },
    failedRunEvidence: {
      kind: evidenceKind,
      sha256: digest(failedRunEvidenceRecord.sha256, "failedRunEvidence.sha256"),
    },
    closedAt,
  };
}

function digestSet(value: unknown, name: string): readonly Digest[] {
  if (!Array.isArray(value)) throw new TypeError(`artifact recovery ${name} must be an array`);
  const result = value.map((entry, index) => digest(entry, `${name}[${index}]`));
  assertCanonicalUnique(result, name);
  return result;
}

function assertCanonicalUnique(values: readonly string[], name: string): void {
  const canonical = [...values].sort();
  if (
    new Set(values).size !== values.length ||
    values.some((entry, index) => entry !== canonical[index])
  ) {
    throw new TypeError(`artifact recovery ${name} must be a sorted unique set`);
  }
}

function digest(value: unknown, name: string): Digest {
  if (!isSha256Digest(value)) throw new TypeError(`artifact recovery ${name} must be sha256`);
  return value;
}

function object(value: unknown, name: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`artifact recovery ${name} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(record: Record<string, unknown>, required: readonly string[]): void {
  exactNamedKeys(record, required, "request");
}

function exactNamedKeys(
  record: Record<string, unknown>,
  required: readonly string[],
  name: string,
): void {
  const actual = Object.keys(record).sort();
  const expected = [...required].sort();
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new TypeError(`artifact recovery ${name} has unexpected or missing fields`);
  }
}

function boundedString(value: unknown, name: string, minimum: number, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length < minimum ||
    value.length > maximum ||
    value.trim() !== value ||
    value.includes("\u0000")
  ) {
    throw new TypeError(`artifact recovery ${name} is invalid`);
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const number = nonnegativeInteger(value, name);
  if (number === 0) throw new TypeError(`artifact recovery ${name} must be positive`);
  return number;
}

function nonnegativeInteger(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`artifact recovery ${name} must be a nonnegative integer`);
  }
  return value as number;
}
