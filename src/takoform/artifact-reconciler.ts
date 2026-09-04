import { bytesDigest } from "../json.ts";
import type { Clock, ObjectStoreAccess, Row, Sql, SqlStatement, SqlWrite } from "../ports.ts";
import { SqlError } from "../ports.ts";
import {
  ARTIFACT_BLOB_IO_LEASE_MILLISECONDS,
  commitArtifactBlobWrite,
  expiredArtifactBlobWrites,
} from "./artifact-blob-io.ts";

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
  /** Started external DELETE owners past their deadline; automatic retry stays disabled. */
  readonly permanentlyFencedBlobDeletes: number;
  /** Durable exact-operation results retained for lost-acknowledgement recovery. */
  readonly completedBlobIoResults: number;
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

export interface ArtifactReconciler {
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
  readonly objects: Pick<ObjectStoreAccess, "get" | "head" | "delete" | "list">;
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

interface ArtifactBlobDeleteLease {
  readonly operationId: string;
  readonly fence: number;
  readonly candidateFence: number;
  readonly leaseExpiresAt: number;
  readonly phase: "claimed" | "started";
}

interface ClaimedBlobCandidate {
  readonly candidate: CandidateRow;
  readonly lease: ArtifactBlobDeleteLease;
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
             AND NOT EXISTS (
               SELECT 1 FROM tf_artifact_blob_io_leases AS lease
               WHERE lease.digest = member.blob_digest AND lease.state <> 'available'
             )
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

  const reconcileExpiredWrites = async (limit: number): Promise<void> => {
    const expired = await expiredArtifactBlobWrites(sql, now(), limit);
    for (const lease of expired) {
      const stored = await objects.get(blobKey(lease.digest));
      if (
        !stored ||
        stored.size !== lease.expectedSize ||
        stored.writeOperationId !== lease.operationId
      ) {
        continue;
      }
      const bytes = new Uint8Array(await new Response(stored.body).arrayBuffer());
      if (bytes.byteLength !== lease.expectedSize || (await bytesDigest(bytes)) !== lease.digest) {
        continue;
      }
      await commitArtifactBlobWrite({ sql, clock, randomId: options.randomId }, lease, stored);
      // Absence, expiry, size, and even equal content are not ordering proof.
      // A non-matching operation remains fenced until its exact PUT is visible
      // or a future authority explicitly resolves it.
    }
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
         AND (
           proposed.kind = 'manifest' OR NOT EXISTS (
             SELECT 1 FROM tf_artifact_blob_io_leases AS lease
             WHERE lease.digest = proposed.digest AND lease.state <> 'available'
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
       FROM tf_artifact_gc_candidates AS candidate
       WHERE (
         (candidate.state IN ('pending', 'retry') AND candidate.not_before <= ?)
         OR (candidate.state = 'deleting' AND EXISTS (
           SELECT 1 FROM tf_artifact_blob_io_leases AS lease
           WHERE lease.digest = candidate.digest AND lease.state = 'deleting'
             AND lease.candidate_fence = candidate.fence
             AND lease.last_outcome IN ('delete_claimed', 'delete_reclaimed')
             AND lease.lease_expires_at <= ?
         ))
       )
       ORDER BY CASE candidate.state WHEN 'deleting' THEN 0 ELSE 1 END,
                updated_at, kind, digest
       LIMIT ?`,
      [now(), now(), limit],
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

  const cancelReferencedCandidate = async (candidate: CandidateRow): Promise<void> => {
    await sql.run(
      `UPDATE tf_artifact_gc_candidates
       SET state = 'cancelled', fence = fence + 1, expected_etag = NULL,
           last_outcome = 'reference_present', updated_at = ?, deleted_at = NULL
       WHERE kind = ? AND digest = ? AND state = ? AND fence = ?`,
      [now(), candidate.kind, candidate.digest, candidate.state, candidate.fence],
    );
  };

  const claimCandidate = async (
    candidate: CandidateRow,
    expectedEtag: string | null,
  ): Promise<CandidateRow | null> => {
    if (candidate.kind !== "manifest") {
      throw new Error("blob candidates require the per-digest delete lease");
    }
    let claimedFence = candidate.fence;
    if (candidate.state !== "deleting") {
      let claimed: SqlWrite;
      try {
        claimed = await sql.run(
          `UPDATE tf_artifact_gc_candidates
           SET state = 'deleting', fence = fence + 1, expected_etag = ?,
               attempts = attempts + 1, last_outcome = 'claimed', updated_at = ?
           WHERE kind = 'manifest' AND digest = ? AND state = ? AND fence = ?
             AND NOT EXISTS (
               SELECT 1 FROM tf_artifact_roots
               WHERE state = 'active' AND target_kind = 'manifest' AND digest = ?
             )`,
          [
            expectedEtag,
            now(),
            candidate.digest,
            candidate.state,
            candidate.fence,
            candidate.digest,
          ],
        );
      } catch (error) {
        // Migration 0046 reserves its shared candidate rows in a database
        // trigger. Treat that serialized loss just like any other lost claim;
        // this collector intentionally has no dependency on recovery tables.
        if (error instanceof SqlError && error.code === "constraint") return null;
        throw error;
      }
      if (claimed.changes !== 1) {
        if (await hasLiveReference(candidate)) await cancelReferencedCandidate(candidate);
        return null;
      }
      claimedFence += 1;
    }
    const rows = await sql.query(
      `SELECT kind, digest, state, fence, expected_etag
       FROM tf_artifact_gc_candidates
       WHERE kind = ? AND digest = ? AND state = 'deleting' AND fence = ?`,
      [candidate.kind, candidate.digest, claimedFence],
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

  const claimBlobCandidate = async (
    candidate: CandidateRow,
    expectedEtag: string | null,
  ): Promise<ClaimedBlobCandidate | null> => {
    const timestamp = now();
    if (candidate.state === "deleting") {
      const previousLease = await readBlobDeleteLease(sql, candidate);
      if (!previousLease) throw new Error("artifact blob candidate lost its delete lease");
      // Once an external DELETE began, neither absence nor elapsed time proves
      // that its original invocation cannot resume. Keep that digest fenced.
      if (previousLease.phase === "started" || previousLease.leaseExpiresAt > timestamp) {
        return null;
      }
      const operationId = blobOperationId("delete-reclaim", options.randomId(), candidate);
      const leaseExpiresAt = timestamp + ARTIFACT_BLOB_IO_LEASE_MILLISECONDS;
      const token = blobOperationId("guard", options.randomId(), candidate);
      try {
        const writes = await sql.batch([
          blobDeleteGuard(token, candidate, previousLease, {
            phase: "claimed",
            expiredAt: timestamp,
            liveReference: "absent",
          }),
          {
            sql: `UPDATE tf_artifact_blob_io_leases
                  SET fence = fence + 1, operation_id = ?, lease_expires_at = ?,
                      last_outcome = 'delete_reclaimed', updated_at = ?
                  WHERE digest = ? AND state = 'deleting' AND operation_id = ?
                    AND fence = ? AND candidate_fence = ?
                    AND last_outcome IN ('delete_claimed', 'delete_reclaimed')
                    AND NOT EXISTS (
                      SELECT 1 FROM tf_artifact_blob_io_results AS result
                      WHERE result.operation_id = ?
                    )
                    AND lease_expires_at <= ?
                  RETURNING fence`,
            params: [
              operationId,
              leaseExpiresAt,
              timestamp,
              candidate.digest,
              previousLease.operationId,
              previousLease.fence,
              candidate.fence,
              operationId,
              timestamp,
            ],
          },
          { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
        ]);
        if (writes[1]?.changes !== 1) {
          throw new Error("artifact blob delete reclaim lost its fence");
        }
        return {
          candidate,
          lease: {
            operationId,
            fence: positiveIntegerColumn(writes[1]?.rows[0], "fence"),
            candidateFence: candidate.fence,
            leaseExpiresAt,
            phase: "claimed",
          },
        };
      } catch (error) {
        const recovered = await readOwnedBlobDeleteClaim(
          sql,
          candidate,
          operationId,
          "claimed",
        ).catch(() => null);
        if (recovered) return recovered;
        if (error instanceof SqlError && error.code === "constraint") return null;
        throw error;
      }
    }

    const nextFence = candidate.fence + 1;
    const operationId = blobOperationId("delete", options.randomId(), candidate);
    const leaseExpiresAt = timestamp + ARTIFACT_BLOB_IO_LEASE_MILLISECONDS;
    const token = blobOperationId("guard", options.randomId(), candidate);
    try {
      const writes = await sql.batch([
        {
          sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
                SELECT ?, CASE WHEN EXISTS (
                  SELECT 1 FROM tf_artifact_gc_candidates
                  WHERE kind = 'blob' AND digest = ? AND state = ? AND fence = ?
                    AND not_before <= ?
                ) AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_roots AS root
                  WHERE root.state = 'active' AND (
                    (root.target_kind = 'blob' AND root.digest = ?) OR
                    (root.target_kind = 'manifest' AND EXISTS (
                      SELECT 1 FROM tf_artifact_manifest_members AS member
                      WHERE member.manifest_digest = root.digest AND member.blob_digest = ?
                    ))
                  )
                ) AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_blob_io_leases AS lease
                  WHERE lease.digest = ? AND lease.state <> 'available'
                ) AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_blob_io_results AS result
                  WHERE result.operation_id = ?
                ) THEN 1 ELSE 0 END`,
          params: [
            token,
            candidate.digest,
            candidate.state,
            candidate.fence,
            timestamp,
            candidate.digest,
            candidate.digest,
            candidate.digest,
            operationId,
          ],
        },
        {
          sql: `INSERT INTO tf_artifact_blob_io_leases
                  (digest, state, fence, operation_id, tenant_id, principal_id, upload_id,
                   upload_fence, root_fence, expected_size, candidate_fence,
                   lease_expires_at, last_outcome, created_at, updated_at)
                VALUES (?, 'deleting', 1, ?, NULL, NULL, NULL, NULL, NULL, NULL, ?, ?,
                        'delete_claimed', ?, ?)
                ON CONFLICT (digest) DO UPDATE SET
                  state = 'deleting', fence = tf_artifact_blob_io_leases.fence + 1,
                  operation_id = excluded.operation_id, tenant_id = NULL,
                  principal_id = NULL, upload_id = NULL, upload_fence = NULL,
                  root_fence = NULL, expected_size = NULL,
                  candidate_fence = excluded.candidate_fence,
                  lease_expires_at = excluded.lease_expires_at,
                  last_outcome = 'delete_claimed', updated_at = excluded.updated_at
                WHERE tf_artifact_blob_io_leases.state = 'available'
                RETURNING fence`,
          params: [candidate.digest, operationId, nextFence, leaseExpiresAt, timestamp, timestamp],
        },
        {
          sql: `UPDATE tf_artifact_gc_candidates
                SET state = 'deleting', fence = fence + 1, expected_etag = ?,
                    attempts = attempts + 1, last_outcome = 'claimed', updated_at = ?
                WHERE kind = 'blob' AND digest = ? AND state = ? AND fence = ?
                  AND not_before <= ?`,
          params: [
            expectedEtag,
            timestamp,
            candidate.digest,
            candidate.state,
            candidate.fence,
            timestamp,
          ],
        },
        { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
      ]);
      if (writes[1]?.changes !== 1 || writes[2]?.changes !== 1) {
        throw new Error("artifact blob candidate claim lost its fence");
      }
      return {
        candidate: {
          ...candidate,
          state: "deleting",
          fence: nextFence,
          expectedEtag,
        },
        lease: {
          operationId,
          fence: positiveIntegerColumn(writes[1]?.rows[0], "fence"),
          candidateFence: nextFence,
          leaseExpiresAt,
          phase: "claimed",
        },
      };
    } catch (error) {
      const recovered = await readOwnedBlobDeleteClaim(
        sql,
        { ...candidate, fence: nextFence, state: "deleting", expectedEtag },
        operationId,
        "claimed",
      ).catch(() => null);
      if (recovered) return recovered;
      if (error instanceof SqlError && error.code === "constraint") {
        if (await hasLiveReference(candidate)) await cancelReferencedCandidate(candidate);
        return null;
      }
      throw error;
    }
  };

  const settleOwnedBlobDelete = async (
    claimed: ClaimedBlobCandidate,
    outcome: "deleted" | "already_absent",
    phase: "claimed" | "started" = "started",
  ): Promise<boolean> => {
    const timestamp = now();
    const token = blobOperationId("guard", options.randomId(), claimed.candidate);
    try {
      const writes = await sql.batch([
        blobDeleteGuard(token, claimed.candidate, claimed.lease, {
          phase,
          liveReference: "absent",
        }),
        completedBlobDeleteResult(claimed, timestamp, outcome),
        availableBlobDeleteLease(claimed, timestamp, outcome),
        {
          sql: `UPDATE tf_artifact_gc_candidates
                SET state = 'deleted', expected_etag = NULL, last_outcome = ?,
                    updated_at = ?, deleted_at = ?
                WHERE kind = 'blob' AND digest = ? AND state = 'deleting' AND fence = ?`,
          params: [
            outcome,
            timestamp,
            timestamp,
            claimed.candidate.digest,
            claimed.candidate.fence,
          ],
        },
        { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
      ]);
      if (writes[1]?.changes !== 1 || writes[2]?.changes !== 1 || writes[3]?.changes !== 1) {
        throw new Error("artifact blob delete settlement lost its fence");
      }
      return true;
    } catch (error) {
      if (await settledBlobDeleteVisible(sql, claimed, outcome).catch(() => false)) return true;
      if (
        error instanceof SqlError &&
        error.code === "constraint" &&
        !(await readOwnedBlobDeleteClaim(
          sql,
          claimed.candidate,
          claimed.lease.operationId,
          phase,
        ).catch(() => null))
      ) {
        return false;
      }
      throw error;
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
    // Recovery candidates pin the ETag observed before quarantine. Ordinary
    // candidates carry null and acquire the current ETag here. Never replace
    // an existing quarantine fence with a later observation before DELETE.
    const observedEtag = candidate.expectedEtag ?? before?.etag ?? null;
    let claimed = await claimBlobCandidate(candidate, observedEtag);
    if (!claimed) return "skipped";
    if (await hasLiveReference(claimed.candidate)) {
      await cancelClaimedBlobCandidate(sql, now(), options.randomId, claimed);
      return "skipped";
    }
    const current = await objects.head(blobKey(claimed.candidate.digest));
    if (!current) {
      return (await settleOwnedBlobDelete(claimed, "already_absent", "claimed"))
        ? "absent"
        : "skipped";
    }
    if (
      claimed.candidate.expectedEtag === null ||
      current.etag !== claimed.candidate.expectedEtag
    ) {
      return (await retryClaimedBlobCandidate(sql, now(), options.randomId, claimed))
        ? "retry"
        : "skipped";
    }
    const started = await beginClaimedBlobDelete(sql, now(), options.randomId, claimed);
    if (!started) return "skipped";
    claimed = started;
    let deleted: boolean;
    try {
      deleted = await objects.delete(blobKey(claimed.candidate.digest));
    } catch {
      // A thrown external DELETE is ambiguous: it may still complete. Retain
      // the started owner permanently rather than authorize a second DELETE.
      return "skipped";
    }
    if (!(await settleOwnedBlobDelete(claimed, deleted ? "deleted" : "already_absent"))) {
      return "skipped";
    }
    return deleted ? "deleted" : "absent";
  };

  return {
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
      const [uploads, roots, candidates, permanentDeleteFences, completedResults, evidence] =
        await Promise.all([
          sql.query(
            `SELECT lifecycle_state, COUNT(*) AS total
           FROM tf_artifact_uploads GROUP BY lifecycle_state`,
          ),
          sql.query("SELECT COUNT(*) AS total FROM tf_artifact_roots WHERE state = 'active'"),
          sql.query(
            `SELECT state, COUNT(*) AS total
           FROM tf_artifact_gc_candidates GROUP BY state`,
          ),
          sql.query(
            `SELECT COUNT(*) AS total
           FROM tf_artifact_blob_io_leases
           WHERE state = 'deleting' AND last_outcome = 'delete_started'
             AND lease_expires_at <= ?`,
            [now()],
          ),
          sql.query("SELECT COUNT(*) AS total FROM tf_artifact_blob_io_results"),
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
        permanentlyFencedBlobDeletes: numberColumn(permanentDeleteFences[0], "total"),
        completedBlobIoResults: numberColumn(completedResults[0], "total"),
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
                      AND receipt.receipt_kind = 'run_owner_closure'
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
      await reconcileExpiredWrites(limit);
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
                ) AND NOT EXISTS (
                  SELECT 1 FROM tf_artifact_blob_io_leases AS lease
                  WHERE lease.digest = ? AND lease.state <> 'available'
                )`,
          params: [hold.tenantId, hold.digest, hold.tenantId, hold.digest, hold.digest],
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

function blobDeleteGuard(
  token: string,
  candidate: CandidateRow,
  lease: ArtifactBlobDeleteLease,
  options: {
    readonly phase: "claimed" | "started";
    readonly expiredAt?: number;
    readonly liveReference: "absent" | "present";
  },
): SqlStatement {
  const phasePredicate =
    options.phase === "started"
      ? "last_outcome = 'delete_started'"
      : "last_outcome IN ('delete_claimed', 'delete_reclaimed')";
  const referencePredicate =
    options.liveReference === "present"
      ? `EXISTS (
           SELECT 1 FROM tf_artifact_roots AS root
           WHERE root.state = 'active' AND (
             (root.target_kind = 'blob' AND root.digest = ?) OR
             (root.target_kind = 'manifest' AND EXISTS (
               SELECT 1 FROM tf_artifact_manifest_members AS member
               WHERE member.manifest_digest = root.digest AND member.blob_digest = ?
             ))
           )
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
  return {
    sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
          SELECT ?, CASE WHEN EXISTS (
            SELECT 1 FROM tf_artifact_gc_candidates
            WHERE kind = 'blob' AND digest = ? AND state = 'deleting' AND fence = ?
          ) AND EXISTS (
            SELECT 1 FROM tf_artifact_blob_io_leases
            WHERE digest = ? AND state = 'deleting' AND operation_id = ?
              AND fence = ? AND candidate_fence = ? AND ${phasePredicate}
              ${options.expiredAt === undefined ? "" : "AND lease_expires_at <= ?"}
          ) AND ${referencePredicate} THEN 1 ELSE 0 END`,
    params: [
      token,
      candidate.digest,
      candidate.fence,
      candidate.digest,
      lease.operationId,
      lease.fence,
      lease.candidateFence,
      ...(options.expiredAt === undefined ? [] : [options.expiredAt]),
      candidate.digest,
      candidate.digest,
    ],
  };
}

async function readBlobDeleteLease(
  sql: Sql,
  candidate: CandidateRow,
): Promise<ArtifactBlobDeleteLease | null> {
  const rows = await sql.query(
    `SELECT operation_id, fence, candidate_fence, lease_expires_at, last_outcome
     FROM tf_artifact_blob_io_leases
     WHERE digest = ? AND state = 'deleting' AND candidate_fence = ?`,
    [candidate.digest, candidate.fence],
  );
  if (rows.length !== 1) return null;
  const outcome = stringColumn(rows[0], "last_outcome");
  const phase =
    outcome === "delete_started"
      ? "started"
      : outcome === "delete_claimed" || outcome === "delete_reclaimed"
        ? "claimed"
        : null;
  if (!phase) throw new Error("artifact blob delete lease phase is invalid");
  return {
    operationId: stringColumn(rows[0], "operation_id"),
    fence: positiveIntegerColumn(rows[0], "fence"),
    candidateFence: positiveIntegerColumn(rows[0], "candidate_fence"),
    leaseExpiresAt: numberColumn(rows[0], "lease_expires_at"),
    phase,
  };
}

async function readOwnedBlobDeleteClaim(
  sql: Sql,
  candidate: CandidateRow,
  operationId: string,
  phase: "claimed" | "started",
): Promise<ClaimedBlobCandidate | null> {
  const outcomes =
    phase === "started"
      ? "lease.last_outcome = 'delete_started'"
      : "lease.last_outcome IN ('delete_claimed', 'delete_reclaimed')";
  const rows = await sql.query(
    `SELECT candidate.digest, candidate.fence, candidate.expected_etag,
            lease.operation_id, lease.fence AS lease_fence,
            lease.candidate_fence, lease.lease_expires_at
     FROM tf_artifact_gc_candidates AS candidate
     JOIN tf_artifact_blob_io_leases AS lease
       ON lease.digest = candidate.digest AND lease.state = 'deleting'
      AND lease.candidate_fence = candidate.fence
     WHERE candidate.kind = 'blob' AND candidate.digest = ?
       AND candidate.state = 'deleting' AND candidate.fence = ?
       AND lease.operation_id = ? AND ${outcomes}`,
    [candidate.digest, candidate.fence, operationId],
  );
  if (rows.length !== 1) return null;
  const row = rows[0];
  return {
    candidate: {
      kind: "blob",
      digest: digestColumn(row, "digest"),
      state: "deleting",
      fence: positiveIntegerColumn(row, "fence"),
      expectedEtag: row?.expected_etag === null ? null : stringColumn(row, "expected_etag"),
    },
    lease: {
      operationId: stringColumn(row, "operation_id"),
      fence: positiveIntegerColumn(row, "lease_fence"),
      candidateFence: positiveIntegerColumn(row, "candidate_fence"),
      leaseExpiresAt: numberColumn(row, "lease_expires_at"),
      phase,
    },
  };
}

async function beginClaimedBlobDelete(
  sql: Sql,
  timestamp: number,
  randomId: () => string,
  claimed: ClaimedBlobCandidate,
): Promise<ClaimedBlobCandidate | null> {
  if (claimed.lease.phase !== "claimed") return null;
  const token = blobOperationId("guard", randomId(), claimed.candidate);
  const leaseExpiresAt = timestamp + ARTIFACT_BLOB_IO_LEASE_MILLISECONDS;
  try {
    const writes = await sql.batch([
      blobDeleteGuard(token, claimed.candidate, claimed.lease, {
        phase: "claimed",
        liveReference: "absent",
      }),
      {
        sql: `UPDATE tf_artifact_blob_io_leases
              SET fence = fence + 1, lease_expires_at = ?,
                  last_outcome = 'delete_started', updated_at = ?
              WHERE digest = ? AND state = 'deleting' AND operation_id = ?
                AND fence = ? AND candidate_fence = ?
                AND last_outcome IN ('delete_claimed', 'delete_reclaimed')
              RETURNING fence`,
        params: [
          leaseExpiresAt,
          timestamp,
          claimed.candidate.digest,
          claimed.lease.operationId,
          claimed.lease.fence,
          claimed.candidate.fence,
        ],
      },
      { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
    ]);
    if (writes[1]?.changes !== 1) return null;
    return {
      candidate: claimed.candidate,
      lease: {
        ...claimed.lease,
        fence: positiveIntegerColumn(writes[1]?.rows[0], "fence"),
        leaseExpiresAt,
        phase: "started",
      },
    };
  } catch (error) {
    const recovered = await readOwnedBlobDeleteClaim(
      sql,
      claimed.candidate,
      claimed.lease.operationId,
      "started",
    ).catch(() => null);
    if (recovered) return recovered;
    if (error instanceof SqlError && error.code === "constraint") return null;
    throw error;
  }
}

async function retryClaimedBlobCandidate(
  sql: Sql,
  timestamp: number,
  randomId: () => string,
  claimed: ClaimedBlobCandidate,
): Promise<boolean> {
  const token = blobOperationId("guard", randomId(), claimed.candidate);
  try {
    const writes = await sql.batch([
      blobDeleteGuard(token, claimed.candidate, claimed.lease, {
        phase: "claimed",
        liveReference: "absent",
      }),
      completedBlobDeleteResult(claimed, timestamp, "etag_changed"),
      availableBlobDeleteLease(claimed, timestamp, "etag_changed"),
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'retry', fence = fence + 1, expected_etag = NULL,
                  not_before = ?, last_outcome = 'etag_changed',
                  updated_at = ?, deleted_at = NULL
              WHERE kind = 'blob' AND digest = ? AND state = 'deleting' AND fence = ?`,
        params: [
          timestamp + CANDIDATE_QUARANTINE_MILLISECONDS,
          timestamp,
          claimed.candidate.digest,
          claimed.candidate.fence,
        ],
      },
      { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
    ]);
    if (writes[1]?.changes !== 1 || writes[2]?.changes !== 1 || writes[3]?.changes !== 1) {
      throw new Error("artifact blob retry lost its delete lease");
    }
    return true;
  } catch (error) {
    if (await completedBlobDeleteVisible(sql, claimed, "etag_changed").catch(() => false)) {
      return true;
    }
    if (
      error instanceof SqlError &&
      error.code === "constraint" &&
      !(await readOwnedBlobDeleteClaim(
        sql,
        claimed.candidate,
        claimed.lease.operationId,
        "claimed",
      ).catch(() => null))
    ) {
      return false;
    }
    throw error;
  }
}

async function cancelClaimedBlobCandidate(
  sql: Sql,
  timestamp: number,
  randomId: () => string,
  claimed: ClaimedBlobCandidate,
): Promise<void> {
  const token = blobOperationId("guard", randomId(), claimed.candidate);
  try {
    const writes = await sql.batch([
      blobDeleteGuard(token, claimed.candidate, claimed.lease, {
        phase: claimed.lease.phase,
        liveReference: "present",
      }),
      completedBlobDeleteResult(claimed, timestamp, "reference_present"),
      availableBlobDeleteLease(claimed, timestamp, "reference_present"),
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'cancelled', fence = fence + 1, expected_etag = NULL,
                  last_outcome = 'reference_present', updated_at = ?, deleted_at = NULL
              WHERE kind = 'blob' AND digest = ? AND state = 'deleting' AND fence = ?`,
        params: [timestamp, claimed.candidate.digest, claimed.candidate.fence],
      },
      { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [token] },
    ]);
    if (writes[1]?.changes !== 1 || writes[2]?.changes !== 1 || writes[3]?.changes !== 1) {
      throw new Error("artifact blob reference cancellation lost its delete lease");
    }
  } catch (error) {
    if (await completedBlobDeleteVisible(sql, claimed, "reference_present").catch(() => false)) {
      return;
    }
    throw error;
  }
}

function availableBlobDeleteLease(
  claimed: ClaimedBlobCandidate,
  timestamp: number,
  outcome: "deleted" | "already_absent" | "etag_changed" | "reference_present",
): SqlStatement {
  return {
    sql: `UPDATE tf_artifact_blob_io_leases
          SET state = 'available', fence = fence + 1,
              tenant_id = NULL, principal_id = NULL, upload_id = NULL,
              upload_fence = NULL, root_fence = NULL, expected_size = NULL,
              candidate_fence = NULL, lease_expires_at = NULL,
              last_outcome = ?, updated_at = ?
          WHERE digest = ? AND state = 'deleting' AND operation_id = ?
            AND fence = ? AND candidate_fence = ?`,
    params: [
      outcome,
      timestamp,
      claimed.candidate.digest,
      claimed.lease.operationId,
      claimed.lease.fence,
      claimed.candidate.fence,
    ],
  };
}

function completedBlobDeleteResult(
  claimed: ClaimedBlobCandidate,
  timestamp: number,
  outcome: "deleted" | "already_absent" | "etag_changed" | "reference_present",
): SqlStatement {
  return {
    sql: `INSERT INTO tf_artifact_blob_io_results
            (operation_id, digest, operation_kind, lease_fence, candidate_fence,
             tenant_id, principal_id, upload_id, upload_fence, root_fence,
             expected_size, outcome, completed_at)
          SELECT operation_id, digest, 'delete', fence, candidate_fence,
                 NULL, NULL, NULL, NULL, NULL, NULL, ?, ?
          FROM tf_artifact_blob_io_leases
          WHERE digest = ? AND state = 'deleting' AND operation_id = ?
            AND fence = ? AND candidate_fence = ?`,
    params: [
      outcome,
      timestamp,
      claimed.candidate.digest,
      claimed.lease.operationId,
      claimed.lease.fence,
      claimed.candidate.fence,
    ],
  };
}

async function completedBlobDeleteVisible(
  sql: Sql,
  claimed: ClaimedBlobCandidate,
  outcome: "deleted" | "already_absent" | "etag_changed" | "reference_present",
): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 AS settled
     FROM tf_artifact_blob_io_results
     WHERE operation_id = ? AND digest = ? AND operation_kind = 'delete'
       AND lease_fence = ? AND candidate_fence = ? AND outcome = ?`,
    [
      claimed.lease.operationId,
      claimed.candidate.digest,
      claimed.lease.fence,
      claimed.candidate.fence,
      outcome,
    ],
  );
  return rows.length === 1;
}

async function settledBlobDeleteVisible(
  sql: Sql,
  claimed: ClaimedBlobCandidate,
  outcome: "deleted" | "already_absent",
): Promise<boolean> {
  return await completedBlobDeleteVisible(sql, claimed, outcome);
}

function blobOperationId(prefix: string, random: string, candidate: CandidateRow): string {
  const suffix = random.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 80);
  if (suffix.length === 0) throw new Error("artifact blob operation id is empty");
  return `${prefix}_${suffix}_${candidate.fence}_${candidate.digest.slice(-12)}`.slice(0, 128);
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
       AND receipt.receipt_kind = 'run_owner_closure'
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
