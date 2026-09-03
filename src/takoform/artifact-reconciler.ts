import type { Clock, ObjectStoreAccess, Row, Sql, SqlStatement } from "../ports.ts";
import {
  createExactArtifactRecoveryMutations,
  type ExactArtifactRecoveryMutations,
} from "./artifact-recovery.ts";

const MAXIMUM_SWEEP_LIMIT = 64;
const CANDIDATE_QUARANTINE_MILLISECONDS = 60 * 60_000;

export interface ArtifactCandidateEvidence {
  readonly kind: "manifest" | "blob";
  readonly digest: string;
  readonly state: "pending" | "deleting" | "retry";
  readonly notBefore: number;
  readonly createdAt: number;
}

export type ArtifactObjectInventory =
  | {
      readonly availability: "complete";
      readonly scannedObjects: number;
      readonly untrackedObjects: number;
    }
  | {
      readonly availability: "unavailable";
      readonly scannedObjects: number;
      readonly untrackedObjects: null;
    };

export interface ArtifactMaintenanceEvidence {
  readonly legacyHoldRoots: number;
  readonly legacyManifestRoots: number;
  readonly danglingCommittedUploads: number;
  readonly unresolvedConsumers: number;
  readonly missingHolds: number;
  readonly staleHolds: number;
  readonly oldestCandidate: ArtifactCandidateEvidence | null;
  readonly objectInventory: ArtifactObjectInventory;
}

export interface ArtifactMaintenancePlan extends ArtifactMaintenanceEvidence {
  /** Existing bytes declared by an active root but missing the tenant access row. */
  readonly repairableHolds: number;
  /** Replay rows eligible for release in this bounded pass. */
  readonly expiredReplays: number;
  /** Zero-reference digests that can become fenced deletion candidates. */
  readonly candidateDigests: number;
}

export interface ArtifactReconcileReport {
  readonly repairedHolds: number;
  readonly expiredReplays: number;
  readonly releasedHolds: number;
  readonly candidatesCreated: number;
  readonly deletedObjects: number;
  readonly retryableObjects: number;
}

export interface ArtifactMaintenanceStatus extends ArtifactMaintenanceEvidence {
  readonly uploads: {
    readonly open: number;
    readonly committed: number;
    readonly abandoned: number;
  };
  readonly activeRoots: number;
  readonly pendingCandidates: number;
  readonly retryableCandidates: number;
  readonly deletingCandidates: number;
  readonly deletedTombstones: number;
}

export interface ExactFailedRunRepairRequest {
  readonly tenantId: string;
  readonly principalId: string;
  readonly uploadId: string;
  readonly manifestDigest: string;
  readonly mode: "dry-run" | "execute";
  /** Durable owner closure bound to the exact persisted upload/root fences. */
  readonly closureReceipt?: {
    readonly receiptId: string;
    readonly receiptFence: number;
  };
}

export interface ExactFailedRunRepairResult {
  readonly outcome:
    | "not_found"
    | "blocked_policy"
    | "blocked_receipt"
    | "blocked_consumer"
    | "ready"
    | "released"
    | "already_released";
  readonly lifecycle: "open" | "committed" | "abandoned" | "unknown";
  readonly activeReplayRoots: number;
  readonly liveConsumerRoots: number;
  readonly unresolvedConsumers: number;
  readonly externalDeleteIssued: false;
}

export interface ArtifactReconciler extends ExactArtifactRecoveryMutations {
  dryRun(input: { readonly limit: number }): Promise<ArtifactMaintenancePlan>;
  status(): Promise<ArtifactMaintenanceStatus>;
  repairExactFailedRun(input: ExactFailedRunRepairRequest): Promise<ExactFailedRunRepairResult>;
  reconcile(input: {
    readonly limit: number;
    /** External deletion is an operator action; false performs SQL repair only. */
    readonly deleteObjects: boolean;
  }): Promise<ArtifactReconcileReport>;
}

export interface CreateArtifactReconcilerOptions {
  readonly sql: Sql;
  readonly objects: Pick<ObjectStoreAccess, "head" | "delete" | "list">;
  readonly clock: Clock;
  readonly randomId: () => string;
}

interface MissingHold {
  readonly tenantId: string;
  readonly digest: string;
}

interface HeldDigest extends MissingHold {
  readonly kind: "manifest" | "blob";
}

interface CandidateDigest {
  readonly kind: "manifest" | "blob";
  readonly digest: string;
}

interface CandidateRow extends CandidateDigest {
  readonly state: "pending" | "deleting" | "retry";
  readonly fence: number;
  readonly expectedEtag: string | null;
}

/**
 * Operator/maintenance artifact reconciliation.
 *
 * This object is composed beside the public HTTP router, never inside it. Its
 * reports contain lifecycle counts and content identifiers only: no manifest,
 * artifact bytes, replay body, provider value, or credential crosses the seam.
 */
export function createTakoformArtifactReconciler(
  options: CreateArtifactReconcilerOptions,
): ArtifactReconciler {
  const { sql, objects, clock } = options;
  const exactRecovery = createExactArtifactRecoveryMutations(options);
  const now = (): number => clock().getTime();

  const missingHolds = async (limit: number): Promise<readonly MissingHold[]> => {
    const existing: MissingHold[] = [];
    let afterTenant = "";
    let afterDigest = "";
    while (existing.length < limit) {
      const rows = await sql.query(
        `WITH missing AS (
           SELECT DISTINCT root.tenant_id, member.blob_digest
           FROM tf_artifact_roots AS root
           JOIN tf_artifact_manifest_members AS member
             ON member.manifest_digest = root.digest
           LEFT JOIN tf_artifact_holds AS hold
             ON hold.tenant_id = root.tenant_id
            AND hold.digest = member.blob_digest
            AND hold.kind = 'blob'
           WHERE root.state = 'active'
             AND root.target_kind = 'manifest'
             AND root.root_kind IN ('upload', 'replay', 'resource', 'deployment')
             AND hold.digest IS NULL
         )
         SELECT tenant_id, blob_digest FROM missing
         WHERE tenant_id > ? OR (tenant_id = ? AND blob_digest > ?)
         ORDER BY tenant_id, blob_digest
         LIMIT ?`,
        [afterTenant, afterTenant, afterDigest, MAXIMUM_SWEEP_LIMIT],
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        const tenantId = stringColumn(row, "tenant_id");
        const digest = digestColumn(row, "blob_digest");
        afterTenant = tenantId;
        afterDigest = digest;
        if (await objects.head(blobKey(digest))) existing.push({ tenantId, digest });
        if (existing.length === limit) break;
      }
      if (rows.length < MAXIMUM_SWEEP_LIMIT) break;
    }
    return existing;
  };

  const missingHoldCount = async (): Promise<number> => {
    const rows = await sql.query(
      `SELECT COUNT(*) AS total FROM (
         SELECT DISTINCT root.tenant_id, member.blob_digest
         FROM tf_artifact_roots AS root
         JOIN tf_artifact_manifest_members AS member
           ON member.manifest_digest = root.digest
         LEFT JOIN tf_artifact_holds AS hold
           ON hold.tenant_id = root.tenant_id
          AND hold.digest = member.blob_digest
          AND hold.kind = 'blob'
         WHERE root.state = 'active'
           AND root.target_kind = 'manifest'
           AND root.root_kind IN ('upload', 'replay', 'resource', 'deployment')
           AND hold.digest IS NULL
       )`,
    );
    return numberColumn(rows[0], "total");
  };

  const expiredReplayRows = async (limit: number): Promise<readonly Row[]> =>
    await sql.query(
      `SELECT replay_key
       FROM tf_artifact_replays
       WHERE expires_at <= ?
       ORDER BY expires_at, replay_key
       LIMIT ?`,
      [now(), limit],
    );

  const staleHolds = async (limit: number): Promise<readonly HeldDigest[]> => {
    const rows = await sql.query(
      `SELECT hold.tenant_id, hold.digest, hold.kind
       FROM tf_artifact_holds AS hold
       WHERE NOT EXISTS (
         SELECT 1
         FROM tf_artifact_roots AS root
         WHERE root.tenant_id = hold.tenant_id AND root.state = 'active'
           AND (
             (hold.kind = 'manifest' AND root.target_kind = 'manifest'
               AND root.digest = hold.digest) OR
             (hold.kind = 'blob' AND (
               (root.target_kind = 'blob' AND root.digest = hold.digest) OR
               (root.target_kind = 'manifest' AND EXISTS (
                 SELECT 1 FROM tf_artifact_manifest_members AS member
                 WHERE member.manifest_digest = root.digest
                   AND member.blob_digest = hold.digest
               ))
             ))
           )
       )
       ORDER BY hold.tenant_id, hold.kind, hold.digest
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      tenantId: stringColumn(row, "tenant_id"),
      digest: digestColumn(row, "digest"),
      kind: artifactKind(row, "kind"),
    }));
  };

  const staleHoldCount = async (): Promise<number> => {
    const rows = await sql.query(
      `SELECT COUNT(*) AS total
       FROM tf_artifact_holds AS hold
       WHERE NOT EXISTS (
         SELECT 1
         FROM tf_artifact_roots AS root
         WHERE root.tenant_id = hold.tenant_id AND root.state = 'active'
           AND (
             (hold.kind = 'manifest' AND root.target_kind = 'manifest'
               AND root.digest = hold.digest) OR
             (hold.kind = 'blob' AND (
               (root.target_kind = 'blob' AND root.digest = hold.digest) OR
               (root.target_kind = 'manifest' AND EXISTS (
                 SELECT 1 FROM tf_artifact_manifest_members AS member
                 WHERE member.manifest_digest = root.digest
                   AND member.blob_digest = hold.digest
               ))
             ))
           )
       )`,
    );
    return numberColumn(rows[0], "total");
  };

  const legacyRootCounts = async (): Promise<{
    readonly legacyHoldRoots: number;
    readonly legacyManifestRoots: number;
  }> => {
    const rows = await sql.query(
      `SELECT root_kind, COUNT(*) AS total
       FROM tf_artifact_roots
       WHERE state = 'active' AND root_kind IN ('legacy-hold', 'legacy-manifest')
       GROUP BY root_kind`,
    );
    const result = countsBy(rows, "root_kind");
    return {
      legacyHoldRoots: result["legacy-hold"] ?? 0,
      legacyManifestRoots: result["legacy-manifest"] ?? 0,
    };
  };

  const danglingCommittedUploadCount = async (): Promise<number> => {
    const rows = await sql.query(
      `SELECT COUNT(*) AS total
       FROM tf_artifact_uploads AS upload
       WHERE upload.lifecycle_state = 'committed'
         AND NOT EXISTS (
           SELECT 1 FROM tf_artifact_roots AS root
           WHERE root.tenant_id = upload.tenant_id AND root.root_kind = 'upload'
             AND root.root_id = upload.id AND root.target_kind = 'manifest'
             AND root.digest = upload.manifest_digest
         )`,
    );
    return numberColumn(rows[0], "total");
  };

  const unresolvedConsumerCount = async (): Promise<number> => {
    const rows = await sql.query(
      `SELECT COUNT(*) AS total
       FROM tf_artifact_consumer_uncertainties
       WHERE state = 'active'`,
    );
    return numberColumn(rows[0], "total");
  };

  const oldestCandidate = async (): Promise<ArtifactCandidateEvidence | null> => {
    const rows = await sql.query(
      `SELECT kind, digest, state, not_before, created_at
       FROM tf_artifact_gc_candidates
       WHERE state IN ('pending', 'deleting', 'retry')
       ORDER BY created_at, kind, digest
       LIMIT 1`,
    );
    const row = rows[0];
    if (!row) return null;
    const state = stringColumn(row, "state");
    if (state !== "pending" && state !== "deleting" && state !== "retry") {
      throw new Error("invalid artifact candidate state");
    }
    return {
      kind: artifactKind(row, "kind"),
      digest: digestColumn(row, "digest"),
      state,
      notBefore: numberColumn(row, "not_before"),
      createdAt: numberColumn(row, "created_at"),
    };
  };

  const trackedBlobDigests = async (digests: readonly string[]): Promise<ReadonlySet<string>> => {
    if (digests.length === 0) return new Set();
    const rows = await sql.query(
      `SELECT CAST(requested.value AS TEXT) AS digest
       FROM json_each(?) AS requested
       WHERE EXISTS (
         SELECT 1 FROM tf_artifact_manifest_members AS member
         WHERE member.blob_digest = CAST(requested.value AS TEXT)
       ) OR EXISTS (
         SELECT 1 FROM tf_artifact_holds AS hold
         WHERE hold.kind = 'blob' AND hold.digest = CAST(requested.value AS TEXT)
       ) OR EXISTS (
         SELECT 1 FROM tf_artifact_roots AS root
         WHERE root.target_kind = 'blob' AND root.digest = CAST(requested.value AS TEXT)
       ) OR EXISTS (
         SELECT 1 FROM tf_artifact_gc_candidates AS candidate
         WHERE candidate.kind = 'blob' AND candidate.digest = CAST(requested.value AS TEXT)
           AND candidate.state IN ('pending', 'deleting', 'retry')
       )`,
      [JSON.stringify(digests)],
    );
    return new Set(rows.map((row) => digestColumn(row, "digest")));
  };

  const objectInventory = async (): Promise<ArtifactObjectInventory> => {
    let cursor: string | undefined;
    let scannedObjects = 0;
    let untrackedObjects = 0;
    const cursors = new Set<string>();
    try {
      while (true) {
        const page = await objects.list({
          prefix: "art/",
          limit: MAXIMUM_SWEEP_LIMIT,
          ...(cursor === undefined ? {} : { cursor }),
        });
        scannedObjects += page.objects.length;
        const valid = page.objects
          .map((object) => /^art\/([0-9a-f]{64})$/u.exec(object.key)?.[1] ?? null)
          .filter((digest): digest is string => digest !== null)
          .map((digest) => `sha256:${digest}`);
        const tracked = await trackedBlobDigests(valid);
        untrackedObjects += page.objects.length - valid.length;
        untrackedObjects += valid.filter((digest) => !tracked.has(digest)).length;
        if (!page.truncated) {
          return { availability: "complete", scannedObjects, untrackedObjects };
        }
        if (!page.cursor || cursors.has(page.cursor) || page.objects.length === 0) {
          return { availability: "unavailable", scannedObjects, untrackedObjects: null };
        }
        cursors.add(page.cursor);
        cursor = page.cursor;
      }
    } catch {
      return { availability: "unavailable", scannedObjects, untrackedObjects: null };
    }
  };

  const maintenanceEvidence = async (): Promise<ArtifactMaintenanceEvidence> => {
    const [legacy, dangling, unresolved, missing, stale, oldest, inventory] = await Promise.all([
      legacyRootCounts(),
      danglingCommittedUploadCount(),
      unresolvedConsumerCount(),
      missingHoldCount(),
      staleHoldCount(),
      oldestCandidate(),
      objectInventory(),
    ]);
    return {
      ...legacy,
      danglingCommittedUploads: dangling,
      unresolvedConsumers: unresolved,
      missingHolds: missing,
      staleHolds: stale,
      oldestCandidate: oldest,
      objectInventory: inventory,
    };
  };

  const candidateDigests = async (limit: number): Promise<readonly CandidateDigest[]> => {
    const rows = await sql.query(
      `WITH proposed(kind, digest) AS (
         SELECT 'manifest', root.digest
         FROM tf_artifact_roots AS root
         WHERE root.state = 'released' AND root.target_kind = 'manifest'
         UNION
         SELECT 'blob', root.digest
         FROM tf_artifact_roots AS root
         WHERE root.state = 'released' AND root.target_kind = 'blob'
         UNION
         SELECT 'blob', member.blob_digest
         FROM tf_artifact_roots AS root
         JOIN tf_artifact_manifest_members AS member
           ON member.manifest_digest = root.digest
         WHERE root.state = 'released' AND root.target_kind = 'manifest'
       )
       SELECT proposed.kind, proposed.digest
       FROM proposed
       WHERE NOT EXISTS (
         SELECT 1
         FROM tf_artifact_roots AS direct
         WHERE direct.state = 'active'
           AND direct.target_kind = proposed.kind
           AND direct.digest = proposed.digest
       )
         AND (
           proposed.kind = 'manifest' OR NOT EXISTS (
             SELECT 1
             FROM tf_artifact_roots AS root
             JOIN tf_artifact_manifest_members AS member
               ON member.manifest_digest = root.digest
             WHERE root.state = 'active' AND root.target_kind = 'manifest'
               AND member.blob_digest = proposed.digest
           )
         )
         AND NOT EXISTS (
           SELECT 1 FROM tf_artifact_gc_candidates AS candidate
           WHERE candidate.kind = proposed.kind AND candidate.digest = proposed.digest
             AND candidate.state IN ('pending', 'deleting', 'retry')
         )
         AND NOT EXISTS (
           SELECT 1 FROM tf_artifact_owner_closure_receipts AS recovery
           WHERE recovery.receipt_id GLOB 'afr_*'
             AND length(recovery.receipt_id) = 68
             AND substr(recovery.receipt_id, 5) NOT GLOB '*[^0-9a-f]*'
             AND (
               (proposed.kind = 'manifest' AND recovery.manifest_digest = proposed.digest) OR
               (proposed.kind = 'blob' AND EXISTS (
                 SELECT 1 FROM tf_artifact_manifest_members AS recovery_member
                 WHERE recovery_member.manifest_digest = recovery.manifest_digest
                   AND recovery_member.blob_digest = proposed.digest
               ))
             )
         )
       ORDER BY proposed.kind, proposed.digest
       LIMIT ?`,
      [limit],
    );
    return rows.map((row) => ({
      kind: artifactKind(row, "kind"),
      digest: digestColumn(row, "digest"),
    }));
  };

  const dueCandidates = async (limit: number): Promise<readonly CandidateRow[]> => {
    const rows = await sql.query(
      `SELECT kind, digest, state, fence, expected_etag
       FROM tf_artifact_gc_candidates
       WHERE (
         state = 'deleting'
         OR (state IN ('pending', 'retry') AND not_before <= ?)
       )
         AND NOT EXISTS (
           SELECT 1 FROM tf_artifact_owner_closure_receipts AS recovery
           WHERE recovery.receipt_id GLOB 'afr_*'
             AND length(recovery.receipt_id) = 68
             AND substr(recovery.receipt_id, 5) NOT GLOB '*[^0-9a-f]*'
             AND (
               (tf_artifact_gc_candidates.kind = 'manifest'
                 AND recovery.manifest_digest = tf_artifact_gc_candidates.digest) OR
               (tf_artifact_gc_candidates.kind = 'blob' AND EXISTS (
                 SELECT 1 FROM tf_artifact_manifest_members AS recovery_member
                 WHERE recovery_member.manifest_digest = recovery.manifest_digest
                   AND recovery_member.blob_digest = tf_artifact_gc_candidates.digest
               ))
             )
         )
       ORDER BY CASE state WHEN 'deleting' THEN 0 ELSE 1 END,
                updated_at, kind, digest
       LIMIT ?`,
      [now(), limit],
    );
    return rows.map((row) => {
      const state = stringColumn(row, "state");
      if (state !== "pending" && state !== "deleting" && state !== "retry") {
        throw new Error("invalid artifact candidate state");
      }
      return {
        kind: artifactKind(row, "kind"),
        digest: digestColumn(row, "digest"),
        state,
        fence: positiveIntegerColumn(row, "fence"),
        expectedEtag: row.expected_etag === null ? null : stringColumn(row, "expected_etag"),
      };
    });
  };

  const hasLiveReference = async (candidate: CandidateDigest): Promise<boolean> => {
    const rows = await sql.query(
      candidate.kind === "manifest"
        ? `SELECT 1 AS live
           FROM tf_artifact_roots
           WHERE state = 'active' AND target_kind = 'manifest' AND digest = ?
           LIMIT 1`
        : `SELECT 1 AS live
           FROM tf_artifact_roots AS root
           WHERE root.state = 'active' AND (
             (root.target_kind = 'blob' AND root.digest = ?) OR
             (root.target_kind = 'manifest' AND EXISTS (
               SELECT 1 FROM tf_artifact_manifest_members AS member
               WHERE member.manifest_digest = root.digest AND member.blob_digest = ?
             ))
           )
           LIMIT 1`,
      candidate.kind === "manifest" ? [candidate.digest] : [candidate.digest, candidate.digest],
    );
    return rows.length > 0;
  };

  const cancelReferencedCandidate = async (candidate: CandidateDigest): Promise<void> => {
    await sql.run(
      `UPDATE tf_artifact_gc_candidates
       SET state = 'cancelled', fence = fence + 1, expected_etag = NULL,
           last_outcome = 'reference_present', updated_at = ?, deleted_at = NULL
       WHERE kind = ? AND digest = ? AND state IN ('pending', 'deleting', 'retry')`,
      [now(), candidate.kind, candidate.digest],
    );
  };

  const claimCandidate = async (
    candidate: CandidateRow,
    expectedEtag: string | null,
  ): Promise<CandidateRow | null> => {
    if (candidate.state !== "deleting") {
      const liveness =
        candidate.kind === "manifest"
          ? `NOT EXISTS (
               SELECT 1 FROM tf_artifact_roots
               WHERE state = 'active' AND target_kind = 'manifest' AND digest = ?
             )`
          : `NOT EXISTS (
               SELECT 1 FROM tf_artifact_roots AS root
               WHERE root.state = 'active' AND (
                 (root.target_kind = 'blob' AND root.digest = ?) OR
                 (root.target_kind = 'manifest' AND EXISTS (
                   SELECT 1 FROM tf_artifact_manifest_members AS member
                   WHERE member.manifest_digest = root.digest AND member.blob_digest = ?
                 ))
               )
             )`;
      const params =
        candidate.kind === "manifest"
          ? [expectedEtag, now(), candidate.kind, candidate.digest, candidate.digest]
          : [
              expectedEtag,
              now(),
              candidate.kind,
              candidate.digest,
              candidate.digest,
              candidate.digest,
            ];
      const claimed = await sql.run(
        `UPDATE tf_artifact_gc_candidates
         SET state = 'deleting', fence = fence + 1, expected_etag = ?,
             attempts = attempts + 1, last_outcome = 'claimed', updated_at = ?
         WHERE kind = ? AND digest = ? AND state IN ('pending', 'retry') AND ${liveness}`,
        params,
      );
      if (claimed.changes !== 1) {
        if (await hasLiveReference(candidate)) await cancelReferencedCandidate(candidate);
        return null;
      }
    }
    const rows = await sql.query(
      `SELECT kind, digest, state, fence, expected_etag
       FROM tf_artifact_gc_candidates
       WHERE kind = ? AND digest = ? AND state = 'deleting'`,
      [candidate.kind, candidate.digest],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      kind: artifactKind(row, "kind"),
      digest: digestColumn(row, "digest"),
      state: "deleting",
      fence: positiveIntegerColumn(row, "fence"),
      expectedEtag: row.expected_etag === null ? null : stringColumn(row, "expected_etag"),
    };
  };

  const settleDeleted = async (
    candidate: CandidateRow,
    outcome: "deleted" | "already_absent" | "metadata_deleted",
  ): Promise<void> => {
    const settled = await sql.run(
      `UPDATE tf_artifact_gc_candidates
       SET state = 'deleted', expected_etag = NULL, last_outcome = ?,
           updated_at = ?, deleted_at = ?
       WHERE kind = ? AND digest = ? AND state = 'deleting' AND fence = ?`,
      [outcome, now(), now(), candidate.kind, candidate.digest, candidate.fence],
    );
    if (settled.changes !== 1) {
      throw new Error("artifact candidate settlement lost its fence");
    }
  };

  const collectManifest = async (candidate: CandidateRow): Promise<boolean> => {
    const claimed = await claimCandidate(candidate, null);
    if (!claimed) return false;
    if (await hasLiveReference(claimed)) {
      await cancelReferencedCandidate(claimed);
      return false;
    }
    const token = `ag_${options
      .randomId()
      .replace(/[^A-Za-z0-9._-]/gu, "")
      .slice(0, 120)}`;
    await sql.batch([
      {
        sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
              SELECT ?, CASE WHEN
                EXISTS (
                  SELECT 1 FROM tf_artifact_gc_candidates
                  WHERE kind = 'manifest' AND digest = ? AND state = 'deleting' AND fence = ?
                ) AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_roots
                  WHERE state = 'active' AND target_kind = 'manifest' AND digest = ?
                )
              THEN 1 ELSE 0 END`,
        params: [token, claimed.digest, claimed.fence, claimed.digest],
      },
      {
        sql: `DELETE FROM tf_artifact_manifests
              WHERE digest = ? AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_roots
                WHERE state = 'active' AND target_kind = 'manifest' AND digest = ?
              )`,
        params: [claimed.digest, claimed.digest],
      },
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'deleted', expected_etag = NULL,
                  last_outcome = 'metadata_deleted', updated_at = ?, deleted_at = ?
              WHERE kind = 'manifest' AND digest = ? AND state = 'deleting' AND fence = ?`,
        params: [now(), now(), claimed.digest, claimed.fence],
      },
      { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
    ]);
    return true;
  };

  const collectBlob = async (
    candidate: CandidateRow,
  ): Promise<"deleted" | "absent" | "retry" | "skipped"> => {
    const before =
      candidate.state === "deleting" ? null : await objects.head(blobKey(candidate.digest));
    const observedEtag = before?.etag || candidate.expectedEtag;
    const claimed = await claimCandidate(candidate, observedEtag);
    if (!claimed) return "skipped";
    if (await hasLiveReference(claimed)) {
      await cancelReferencedCandidate(claimed);
      return "skipped";
    }
    const current = await objects.head(blobKey(claimed.digest));
    if (!current) {
      await settleDeleted(claimed, "already_absent");
      return "absent";
    }
    if (claimed.expectedEtag !== null && current.etag !== claimed.expectedEtag) {
      await sql.run(
        `UPDATE tf_artifact_gc_candidates
         SET state = 'retry', fence = fence + 1, expected_etag = NULL,
             not_before = ?, last_outcome = 'etag_changed', updated_at = ?, deleted_at = NULL
         WHERE kind = 'blob' AND digest = ? AND state = 'deleting' AND fence = ?`,
        [now() + CANDIDATE_QUARANTINE_MILLISECONDS, now(), claimed.digest, claimed.fence],
      );
      return "retry";
    }
    let deleted: boolean;
    try {
      deleted = await objects.delete(blobKey(claimed.digest));
    } catch {
      await sql.run(
        `UPDATE tf_artifact_gc_candidates
         SET state = 'retry', fence = fence + 1, expected_etag = NULL,
             not_before = ?, last_outcome = 'delete_failed', updated_at = ?, deleted_at = NULL
         WHERE kind = 'blob' AND digest = ? AND state = 'deleting' AND fence = ?`,
        [now() + CANDIDATE_QUARANTINE_MILLISECONDS, now(), claimed.digest, claimed.fence],
      );
      return "retry";
    }
    // Settlement is deliberately outside the object-delete catch. If SQL is
    // unavailable after a successful external delete, leaving `deleting` +
    // the claimed fence is the honest state: the next pass re-reads R2 and
    // settles `already_absent` without issuing a blind second delete.
    await settleDeleted(claimed, deleted ? "deleted" : "already_absent");
    return deleted ? "deleted" : "absent";
  };

  return {
    ...exactRecovery,
    async dryRun(input) {
      const limit = boundedLimit(input.limit);
      const [holds, replays, candidates, evidence] = await Promise.all([
        missingHolds(limit),
        expiredReplayRows(limit),
        candidateDigests(limit),
        maintenanceEvidence(),
      ]);
      return {
        ...evidence,
        repairableHolds: holds.length,
        expiredReplays: replays.length,
        candidateDigests: candidates.length,
      };
    },

    async status() {
      const [uploads, roots, candidates, evidence] = await Promise.all([
        sql.query(
          `SELECT lifecycle_state, COUNT(*) AS total
           FROM tf_artifact_uploads GROUP BY lifecycle_state`,
        ),
        sql.query("SELECT COUNT(*) AS total FROM tf_artifact_roots WHERE state = 'active'"),
        sql.query(
          `SELECT state, COUNT(*) AS total
           FROM tf_artifact_gc_candidates GROUP BY state`,
        ),
        maintenanceEvidence(),
      ]);
      const uploadCount = counts(uploads);
      const candidateCount = counts(candidates);
      return {
        ...evidence,
        uploads: {
          open: uploadCount.open ?? 0,
          committed: uploadCount.committed ?? 0,
          abandoned: uploadCount.abandoned ?? 0,
        },
        activeRoots: numberColumn(roots[0], "total"),
        pendingCandidates: candidateCount.pending ?? 0,
        retryableCandidates: candidateCount.retry ?? 0,
        deletingCandidates: candidateCount.deleting ?? 0,
        deletedTombstones: candidateCount.deleted ?? 0,
      };
    },

    async repairExactFailedRun(input) {
      requireExactRepairInput(input);
      const rows = await sql.query(
        `SELECT lifecycle_state, manifest_digest
         FROM tf_artifact_uploads
         WHERE id = ? AND tenant_id = ? AND principal_id = ? AND manifest_digest = ?`,
        [input.uploadId, input.tenantId, input.principalId, input.manifestDigest],
      );
      const row = rows[0];
      if (!row) {
        return {
          outcome: "not_found",
          lifecycle: "unknown",
          activeReplayRoots: 0,
          liveConsumerRoots: 0,
          unresolvedConsumers: 0,
          externalDeleteIssued: false,
        };
      }
      const lifecycle = uploadLifecycle(row);
      const activeReplayRoots = await activeReplayRootCount(
        sql,
        input.tenantId,
        input.manifestDigest,
      );
      const roots = await sql.query(
        `SELECT state
         FROM tf_artifact_roots
         WHERE tenant_id = ? AND root_kind = 'upload' AND root_id = ?
           AND target_kind = 'manifest' AND digest = ?`,
        [input.tenantId, input.uploadId, input.manifestDigest],
      );
      const rootState = roots[0]?.state;
      const liveConsumerRoots = await activeConsumerRootCount(
        sql,
        input.tenantId,
        input.manifestDigest,
      );
      const unresolvedConsumers = await activeConsumerUncertaintyCount(sql, input.tenantId);
      if (rootState === "released") {
        return {
          outcome: "already_released",
          lifecycle,
          activeReplayRoots,
          liveConsumerRoots,
          unresolvedConsumers,
          externalDeleteIssued: false,
        };
      }
      if (lifecycle !== "committed" || !input.principalId.startsWith("run:")) {
        return {
          outcome: "blocked_policy",
          lifecycle,
          activeReplayRoots,
          liveConsumerRoots,
          unresolvedConsumers,
          externalDeleteIssued: false,
        };
      }
      const receipt = input.closureReceipt;
      const receiptValid =
        receipt !== undefined && (await hasExactClosureReceipt(sql, input, receipt, now()));
      if (!receiptValid) {
        return {
          outcome: "blocked_receipt",
          lifecycle,
          activeReplayRoots,
          liveConsumerRoots,
          unresolvedConsumers,
          externalDeleteIssued: false,
        };
      }
      if (liveConsumerRoots > 0 || unresolvedConsumers > 0) {
        return {
          outcome: "blocked_consumer",
          lifecycle,
          activeReplayRoots,
          liveConsumerRoots,
          unresolvedConsumers,
          externalDeleteIssued: false,
        };
      }
      if (input.mode === "dry-run") {
        return {
          outcome: "ready",
          lifecycle,
          activeReplayRoots,
          liveConsumerRoots,
          unresolvedConsumers,
          externalDeleteIssued: false,
        };
      }

      const timestamp = now();
      const token = `ag_${options
        .randomId()
        .replace(/[^A-Za-z0-9._-]/gu, "")
        .slice(0, 120)}`;
      try {
        await sql.batch([
          {
            sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
                  SELECT ?, CASE WHEN EXISTS (
                    SELECT 1
                    FROM tf_artifact_uploads AS upload
                    JOIN tf_artifact_roots AS root
                      ON root.tenant_id = upload.tenant_id
                     AND root.root_kind = 'upload'
                     AND root.root_id = upload.id
                     AND root.target_kind = 'manifest'
                     AND root.digest = upload.manifest_digest
                    JOIN tf_artifact_owner_closure_receipts AS receipt
                      ON receipt.tenant_id = upload.tenant_id
                     AND receipt.principal_id = upload.principal_id
                     AND receipt.upload_id = upload.id
                     AND receipt.manifest_digest = upload.manifest_digest
                     AND receipt.upload_fence = upload.lifecycle_fence
                     AND receipt.root_fence = root.fence
                    WHERE upload.id = ? AND upload.tenant_id = ?
                      AND upload.principal_id = ? AND upload.manifest_digest = ?
                      AND upload.lifecycle_state = 'committed'
                      AND root.state = 'active'
                      AND receipt.receipt_id = ? AND receipt.receipt_fence = ?
                      AND receipt.state = 'closed'
                      AND receipt.closed_at <= ? AND receipt.expires_at > ?
                      AND NOT EXISTS (
                        SELECT 1 FROM tf_artifact_roots AS consumer
                        WHERE consumer.tenant_id = upload.tenant_id
                          AND consumer.target_kind = 'manifest'
                          AND consumer.digest = upload.manifest_digest
                          AND consumer.state = 'active'
                          AND consumer.root_kind IN ('resource', 'deployment')
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM tf_resources AS resource
                        WHERE resource.tenant_id = upload.tenant_id
                          AND json_extract(resource.resource_json, '$.spec.manifestDigest') =
                              upload.manifest_digest
                      )
                      AND NOT EXISTS (
                        SELECT 1 FROM tf_artifact_consumer_uncertainties AS uncertainty
                        WHERE uncertainty.tenant_id = upload.tenant_id
                          AND uncertainty.state = 'active'
                      )
                      AND NOT EXISTS (
                        SELECT 1
                        FROM tf_resource_deployments AS deployment
                        LEFT JOIN tf_resources AS resource
                          ON resource.tenant_id = deployment.tenant_id
                         AND resource.uid = deployment.resource_uid
                        WHERE deployment.tenant_id = upload.tenant_id
                          AND deployment.state <> 'deleted'
                          AND (
                            resource.uid IS NULL OR
                            json_type(resource.resource_json, '$.spec.manifestDigest') IS NOT 'text' OR
                            json_extract(resource.resource_json, '$.spec.manifestDigest') =
                              upload.manifest_digest
                          )
                      )
                  ) THEN 1 ELSE 0 END`,
            params: [
              token,
              input.uploadId,
              input.tenantId,
              input.principalId,
              input.manifestDigest,
              receipt.receiptId,
              receipt.receiptFence,
              timestamp,
              timestamp,
            ],
          },
          {
            sql: `UPDATE tf_artifact_roots
                  SET state = 'released', fence = fence + 1,
                      release_reason = 'operator_exact_failed_run', released_at = ?
                  WHERE tenant_id = ? AND root_kind = 'upload' AND root_id = ?
                    AND target_kind = 'manifest' AND digest = ? AND state = 'active'`,
            params: [timestamp, input.tenantId, input.uploadId, input.manifestDigest],
          },
          {
            sql: `UPDATE tf_artifact_uploads
                  SET lifecycle_fence = lifecycle_fence + 1, updated_at = ?
                  WHERE id = ? AND tenant_id = ? AND principal_id = ?
                    AND manifest_digest = ? AND lifecycle_state = 'committed'`,
            params: [
              timestamp,
              input.uploadId,
              input.tenantId,
              input.principalId,
              input.manifestDigest,
            ],
          },
          { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
        ]);
      } catch (error) {
        const settled = await sql
          .query(
            `SELECT state FROM tf_artifact_roots
             WHERE tenant_id = ? AND root_kind = 'upload' AND root_id = ?
               AND target_kind = 'manifest' AND digest = ?`,
            [input.tenantId, input.uploadId, input.manifestDigest],
          )
          .catch(() => []);
        if (settled[0]?.state !== "released") throw error;
      }
      return {
        outcome: "released",
        lifecycle: "committed",
        activeReplayRoots,
        liveConsumerRoots: 0,
        unresolvedConsumers: 0,
        externalDeleteIssued: false,
      };
    },

    async reconcile(input) {
      const limit = boundedLimit(input.limit);
      const timestamp = now();
      const [holds, replayRows] = await Promise.all([
        missingHolds(limit),
        expiredReplayRows(limit),
      ]);
      const statements: SqlStatement[] = [];
      for (const hold of holds) {
        statements.push({
          sql: `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
                SELECT ?, ?, 'blob'
                WHERE EXISTS (
                  SELECT 1
                  FROM tf_artifact_roots AS root
                  JOIN tf_artifact_manifest_members AS member
                    ON member.manifest_digest = root.digest
                  WHERE root.tenant_id = ? AND root.state = 'active'
                    AND root.target_kind = 'manifest' AND member.blob_digest = ?
                )`,
          params: [hold.tenantId, hold.digest, hold.tenantId, hold.digest],
        });
      }
      for (const row of replayRows) {
        const replayKey = stringColumn(row, "replay_key");
        statements.push(
          {
            sql: `UPDATE tf_artifact_roots
                  SET state = 'released', fence = fence + 1,
                      release_reason = 'replay_expired', released_at = ?
                  WHERE root_kind = 'replay' AND root_id = ? AND state = 'active'
                    AND expires_at <= ?`,
            params: [timestamp, replayKey, timestamp],
          },
          {
            sql: "DELETE FROM tf_artifact_replays WHERE replay_key = ? AND expires_at <= ?",
            params: [replayKey, timestamp],
          },
        );
      }
      if (statements.length > 0) await sql.batch(statements);

      const stale = await staleHolds(limit);
      let releasedHolds = 0;
      if (stale.length > 0) {
        const results = await sql.batch(
          stale.map(
            (hold): SqlStatement => ({
              sql: `DELETE FROM tf_artifact_holds
                    WHERE tenant_id = ? AND digest = ? AND kind = ?
                      AND NOT EXISTS (
                        SELECT 1
                        FROM tf_artifact_roots AS root
                        WHERE root.tenant_id = ? AND root.state = 'active'
                          AND (
                            (? = 'manifest' AND root.target_kind = 'manifest'
                              AND root.digest = ?) OR
                            (? = 'blob' AND (
                              (root.target_kind = 'blob' AND root.digest = ?) OR
                              (root.target_kind = 'manifest' AND EXISTS (
                                SELECT 1 FROM tf_artifact_manifest_members AS member
                                WHERE member.manifest_digest = root.digest
                                  AND member.blob_digest = ?
                              ))
                            ))
                          )
                      )`,
              params: [
                hold.tenantId,
                hold.digest,
                hold.kind,
                hold.tenantId,
                hold.kind,
                hold.digest,
                hold.kind,
                hold.digest,
                hold.digest,
              ],
            }),
          ),
        );
        releasedHolds = results.reduce((total, result) => total + result.changes, 0);
      }

      const proposed = await candidateDigests(limit);
      let candidatesCreated = 0;
      if (proposed.length > 0) {
        const notBefore = timestamp + CANDIDATE_QUARANTINE_MILLISECONDS;
        const results = await sql.batch(
          proposed.map(
            (candidate): SqlStatement => ({
              sql: `INSERT INTO tf_artifact_gc_candidates
                      (kind, digest, state, fence, not_before, expected_etag, attempts,
                       last_outcome, created_at, updated_at, deleted_at)
                    VALUES (?, ?, 'pending', 1, ?, NULL, 0, 'pending', ?, ?, NULL)
                    ON CONFLICT (kind, digest) DO UPDATE SET
                      state = 'pending', fence = tf_artifact_gc_candidates.fence + 1,
                      not_before = excluded.not_before, expected_etag = NULL,
                      last_outcome = 'pending', updated_at = excluded.updated_at,
                      deleted_at = NULL
                    WHERE tf_artifact_gc_candidates.state IN ('deleted', 'cancelled')`,
              params: [candidate.kind, candidate.digest, notBefore, timestamp, timestamp],
            }),
          ),
        );
        candidatesCreated = results.reduce((total, result) => total + result.changes, 0);
      }

      let deletedObjects = 0;
      let retryableObjects = 0;
      if (input.deleteObjects) {
        const due = await dueCandidates(limit);
        for (const candidate of due) {
          if (candidate.kind === "manifest") {
            await collectManifest(candidate);
            continue;
          }
          const outcome = await collectBlob(candidate);
          if (outcome === "deleted") deletedObjects += 1;
          if (outcome === "retry") retryableObjects += 1;
        }
      }
      return {
        repairedHolds: holds.length,
        expiredReplays: replayRows.length,
        releasedHolds,
        candidatesCreated,
        deletedObjects,
        retryableObjects,
      };
    },
  };
}

function boundedLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAXIMUM_SWEEP_LIMIT) {
    throw new TypeError(`artifact sweep limit must be between 1 and ${MAXIMUM_SWEEP_LIMIT}`);
  }
  return value;
}

function blobKey(digest: string): string {
  return `art/${digest.slice("sha256:".length)}`;
}

function stringColumn(row: Row | undefined, name: string): string {
  const value = row?.[name];
  if (typeof value !== "string") throw new Error(`invalid artifact maintenance ${name}`);
  return value;
}

function digestColumn(row: Row | undefined, name: string): string {
  const value = stringColumn(row, name);
  if (!/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new Error(`invalid artifact maintenance ${name}`);
  }
  return value;
}

function numberColumn(row: Row | undefined, name: string): number {
  const value = row?.[name];
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

function positiveIntegerColumn(row: Row | undefined, name: string): number {
  const value = numberColumn(row, name);
  if (value < 1) throw new Error(`invalid artifact maintenance ${name}`);
  return value;
}

function artifactKind(row: Row | undefined, name: string): "manifest" | "blob" {
  const value = stringColumn(row, name);
  if (value !== "manifest" && value !== "blob") {
    throw new Error(`invalid artifact maintenance ${name}`);
  }
  return value;
}

function counts(rows: readonly Row[]): Record<string, number> {
  return countsBy(rows, rows.some((row) => "state" in row) ? "state" : "lifecycle_state");
}

function countsBy(rows: readonly Row[], key: string): Record<string, number> {
  const result: Record<string, number> = {};
  for (const row of rows) result[stringColumn(row, key)] = numberColumn(row, "total");
  return result;
}

function requireExactRepairInput(input: ExactFailedRunRepairRequest): void {
  const receipt = input.closureReceipt;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(input.tenantId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,254}$/u.test(input.principalId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u.test(input.uploadId) ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.manifestDigest) ||
    (input.mode !== "dry-run" && input.mode !== "execute") ||
    (receipt !== undefined &&
      (!/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/u.test(receipt.receiptId) ||
        !Number.isSafeInteger(receipt.receiptFence) ||
        receipt.receiptFence < 1))
  ) {
    throw new TypeError("invalid exact artifact repair identity");
  }
}

function uploadLifecycle(row: Row): "open" | "committed" | "abandoned" {
  const state = stringColumn(row, "lifecycle_state");
  if (state !== "open" && state !== "committed" && state !== "abandoned") {
    throw new Error("invalid artifact upload lifecycle");
  }
  return state;
}

async function activeReplayRootCount(
  sql: Sql,
  tenantId: string,
  manifestDigest: string,
): Promise<number> {
  const rows = await sql.query(
    `SELECT COUNT(*) AS total
     FROM tf_artifact_roots
     WHERE tenant_id = ? AND root_kind = 'replay' AND target_kind = 'manifest'
       AND digest = ? AND state = 'active'`,
    [tenantId, manifestDigest],
  );
  return numberColumn(rows[0], "total");
}

async function activeConsumerRootCount(
  sql: Sql,
  tenantId: string,
  manifestDigest: string,
): Promise<number> {
  const rows = await sql.query(
    `SELECT COUNT(*) AS total
     FROM tf_artifact_roots
     WHERE tenant_id = ? AND target_kind = 'manifest' AND digest = ?
       AND state = 'active' AND root_kind IN ('resource', 'deployment')`,
    [tenantId, manifestDigest],
  );
  return numberColumn(rows[0], "total");
}

async function activeConsumerUncertaintyCount(sql: Sql, tenantId: string): Promise<number> {
  const rows = await sql.query(
    `SELECT COUNT(*) AS total
     FROM tf_artifact_consumer_uncertainties
     WHERE tenant_id = ? AND state = 'active'`,
    [tenantId],
  );
  return numberColumn(rows[0], "total");
}

async function hasExactClosureReceipt(
  sql: Sql,
  input: ExactFailedRunRepairRequest,
  receipt: NonNullable<ExactFailedRunRepairRequest["closureReceipt"]>,
  timestamp: number,
): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 AS valid
     FROM tf_artifact_owner_closure_receipts AS receipt
     JOIN tf_artifact_uploads AS upload
       ON upload.tenant_id = receipt.tenant_id
      AND upload.principal_id = receipt.principal_id
      AND upload.id = receipt.upload_id
      AND upload.manifest_digest = receipt.manifest_digest
      AND upload.lifecycle_fence = receipt.upload_fence
     JOIN tf_artifact_roots AS root
       ON root.tenant_id = receipt.tenant_id
      AND root.root_kind = 'upload'
      AND root.root_id = receipt.upload_id
      AND root.target_kind = 'manifest'
      AND root.digest = receipt.manifest_digest
      AND root.fence = receipt.root_fence
     WHERE receipt.receipt_id = ? AND receipt.receipt_fence = ?
       AND receipt.tenant_id = ? AND receipt.principal_id = ?
       AND receipt.upload_id = ? AND receipt.manifest_digest = ?
       AND receipt.state = 'closed'
       AND receipt.closed_at <= ? AND receipt.expires_at > ?
       AND upload.lifecycle_state = 'committed' AND root.state = 'active'
     LIMIT 1`,
    [
      receipt.receiptId,
      receipt.receiptFence,
      input.tenantId,
      input.principalId,
      input.uploadId,
      input.manifestDigest,
      timestamp,
      timestamp,
    ],
  );
  return rows.length === 1;
}
