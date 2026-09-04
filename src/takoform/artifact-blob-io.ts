import type { Clock, Row, Sql, SqlStatement, StoredObject } from "../ports.ts";
import { SqlError } from "../ports.ts";

export const ARTIFACT_BLOB_IO_LEASE_MILLISECONDS = 5 * 60_000;

export interface ArtifactBlobWriteLease {
  readonly digest: string;
  readonly operationId: string;
  readonly fence: number;
  readonly tenantId: string;
  readonly principalId: string;
  readonly uploadId: string;
  readonly uploadFence: number;
  readonly rootFence: number;
  readonly expectedSize: number;
  readonly leaseExpiresAt: number;
}

export interface ArtifactBlobWriteInput {
  readonly tenantId: string;
  readonly principalId: string;
  readonly uploadId: string;
  readonly manifestDigest: string;
  readonly digest: string;
  readonly uploadFence: number;
  readonly rootFence: number;
  readonly expectedSize: number;
}

interface ArtifactBlobIoOptions {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly randomId: () => string;
}

/**
 * Claims one digest immediately before R2 PUT. The upload/root fences, manifest
 * membership, deleting candidate, and per-digest owner are checked in one D1
 * transaction. Merely validating an HTTP request grants no external-write
 * authority.
 */
export async function admitArtifactBlobWrite(
  options: ArtifactBlobIoOptions,
  input: ArtifactBlobWriteInput,
): Promise<ArtifactBlobWriteLease | null> {
  const timestamp = options.clock().getTime();
  const operationId = identifier("abw", options.randomId());
  const guard = identifier("agw", options.randomId());
  const leaseExpiresAt = timestamp + ARTIFACT_BLOB_IO_LEASE_MILLISECONDS;
  try {
    const writes = await options.sql.batch([
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
                JOIN tf_artifact_manifest_members AS member
                  ON member.manifest_digest = upload.manifest_digest
                 AND member.blob_digest = ?
                WHERE upload.id = ? AND upload.tenant_id = ? AND upload.principal_id = ?
                  AND upload.manifest_digest = ? AND upload.lifecycle_state = 'open'
                  AND upload.lifecycle_fence = ?
                  AND root.state = 'active' AND root.fence = ?
              ) AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_gc_candidates AS candidate
                WHERE candidate.kind = 'blob' AND candidate.digest = ?
                  AND candidate.state = 'deleting'
              ) AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_blob_io_leases AS lease
                WHERE lease.digest = ? AND lease.state <> 'available'
              ) AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_blob_io_results AS result
                WHERE result.operation_id = ?
              ) THEN 1 ELSE 0 END`,
        params: [
          guard,
          input.digest,
          input.uploadId,
          input.tenantId,
          input.principalId,
          input.manifestDigest,
          input.uploadFence,
          input.rootFence,
          input.digest,
          input.digest,
          operationId,
        ],
      },
      {
        sql: `INSERT INTO tf_artifact_blob_io_leases
                (digest, state, fence, operation_id, tenant_id, principal_id, upload_id,
                 upload_fence, root_fence, expected_size, candidate_fence,
                 lease_expires_at, last_outcome, created_at, updated_at)
              VALUES (?, 'writing', 1, ?, ?, ?, ?, ?, ?, ?, NULL, ?,
                      'write_admitted', ?, ?)
              ON CONFLICT (digest) DO UPDATE SET
                state = 'writing', fence = tf_artifact_blob_io_leases.fence + 1,
                operation_id = excluded.operation_id, tenant_id = excluded.tenant_id,
                principal_id = excluded.principal_id, upload_id = excluded.upload_id,
                upload_fence = excluded.upload_fence, root_fence = excluded.root_fence,
                expected_size = excluded.expected_size, candidate_fence = NULL,
                lease_expires_at = excluded.lease_expires_at,
                last_outcome = 'write_admitted', updated_at = excluded.updated_at
              WHERE tf_artifact_blob_io_leases.state = 'available'
              RETURNING fence`,
        params: [
          input.digest,
          operationId,
          input.tenantId,
          input.principalId,
          input.uploadId,
          input.uploadFence,
          input.rootFence,
          input.expectedSize,
          leaseExpiresAt,
          timestamp,
          timestamp,
        ],
      },
      { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [guard] },
    ]);
    const fence = positiveInteger(writes[1]?.rows[0], "fence");
    return {
      digest: input.digest,
      operationId,
      fence,
      tenantId: input.tenantId,
      principalId: input.principalId,
      uploadId: input.uploadId,
      uploadFence: input.uploadFence,
      rootFence: input.rootFence,
      expectedSize: input.expectedSize,
      leaseExpiresAt,
    };
  } catch (error) {
    const recovered = await readOwnedWritingLease(options.sql, operationId, input).catch(
      () => null,
    );
    if (recovered) return recovered;
    if (error instanceof SqlError && error.code === "constraint") return null;
    throw error;
  }
}

/**
 * Performs the post-R2 CAS. Exact operation metadata is a precondition: size,
 * digest, or elapsed time alone can never make pre-existing bytes this PUT's
 * acknowledged result.
 */
export async function commitArtifactBlobWrite(
  options: ArtifactBlobIoOptions,
  lease: ArtifactBlobWriteLease,
  observed: StoredObject,
): Promise<boolean> {
  if (
    observed.key !== blobKey(lease.digest) ||
    observed.size !== lease.expectedSize ||
    observed.writeOperationId !== lease.operationId
  ) {
    return false;
  }
  const timestamp = options.clock().getTime();
  const guard = identifier("agw", options.randomId());
  try {
    const writes = await options.sql.batch([
      {
        sql: `INSERT INTO tf_artifact_gc_guards (token, valid)
              SELECT ?, CASE WHEN EXISTS (
                SELECT 1
                FROM tf_artifact_blob_io_leases AS lease
                JOIN tf_artifact_uploads AS upload
                  ON upload.id = lease.upload_id AND upload.tenant_id = lease.tenant_id
                 AND upload.principal_id = lease.principal_id
                 AND upload.lifecycle_fence = lease.upload_fence
                JOIN tf_artifact_roots AS root
                  ON root.tenant_id = upload.tenant_id
                 AND root.root_kind = 'upload' AND root.root_id = upload.id
                 AND root.target_kind = 'manifest' AND root.digest = upload.manifest_digest
                 AND root.fence = lease.root_fence
                JOIN tf_artifact_manifest_members AS member
                  ON member.manifest_digest = upload.manifest_digest
                 AND member.blob_digest = lease.digest
                WHERE lease.digest = ? AND lease.state = 'writing'
                  AND lease.operation_id = ? AND lease.fence = ?
                  AND upload.lifecycle_state = 'open' AND root.state = 'active'
              ) AND NOT EXISTS (
                SELECT 1 FROM tf_artifact_gc_candidates AS candidate
                WHERE candidate.kind = 'blob' AND candidate.digest = ?
                  AND candidate.state = 'deleting'
              ) THEN 1 ELSE 0 END`,
        params: [guard, lease.digest, lease.operationId, lease.fence, lease.digest],
      },
      {
        sql: `INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind)
              VALUES (?, ?, 'blob')`,
        params: [lease.tenantId, lease.digest],
      },
      {
        sql: `UPDATE tf_artifact_gc_candidates
              SET state = 'cancelled', fence = fence + 1, expected_etag = NULL,
                  last_outcome = 'reference_present', updated_at = ?, deleted_at = NULL
              WHERE kind = 'blob' AND digest = ?
                AND state IN ('pending', 'retry', 'deleted', 'cancelled')`,
        params: [timestamp, lease.digest],
      },
      completedWriteResultStatement(lease, timestamp),
      availableWriteLeaseStatement(lease, timestamp),
      { sql: "DELETE FROM tf_artifact_gc_guards WHERE token = ?", params: [guard] },
    ]);
    if (writes[3]?.changes !== 1 || writes[4]?.changes !== 1) {
      throw new Error("artifact blob writer lost its post-R2 fence");
    }
    return true;
  } catch (error) {
    if (await committedWriteVisible(options.sql, lease).catch(() => false)) return true;
    if (error instanceof SqlError && error.code === "constraint") return false;
    throw error;
  }
}

export async function expiredArtifactBlobWrites(
  sql: Sql,
  timestamp: number,
  limit: number,
): Promise<readonly ArtifactBlobWriteLease[]> {
  const rows = await sql.query(
    `SELECT digest, operation_id, fence, tenant_id, principal_id, upload_id,
            upload_fence, root_fence, expected_size, lease_expires_at
     FROM tf_artifact_blob_io_leases
     WHERE state = 'writing' AND lease_expires_at <= ?
     ORDER BY lease_expires_at, digest
     LIMIT ?`,
    [timestamp, limit],
  );
  return rows.map(writeLease);
}

function completedWriteResultStatement(
  lease: ArtifactBlobWriteLease,
  timestamp: number,
): SqlStatement {
  return {
    sql: `INSERT INTO tf_artifact_blob_io_results
            (operation_id, digest, operation_kind, lease_fence, candidate_fence,
             tenant_id, principal_id, upload_id, upload_fence, root_fence,
             expected_size, outcome, completed_at)
          SELECT operation_id, digest, 'write', fence, NULL,
                 tenant_id, principal_id, upload_id, upload_fence, root_fence,
                 expected_size, 'write_committed', ?
          FROM tf_artifact_blob_io_leases
          WHERE digest = ? AND state = 'writing' AND operation_id = ? AND fence = ?`,
    params: [timestamp, lease.digest, lease.operationId, lease.fence],
  };
}

function availableWriteLeaseStatement(
  lease: ArtifactBlobWriteLease,
  timestamp: number,
): SqlStatement {
  return {
    sql: `UPDATE tf_artifact_blob_io_leases
          SET state = 'available', fence = fence + 1,
              tenant_id = NULL, principal_id = NULL, upload_id = NULL,
              upload_fence = NULL, root_fence = NULL, expected_size = NULL,
              candidate_fence = NULL, lease_expires_at = NULL,
              last_outcome = 'write_committed', updated_at = ?
          WHERE digest = ? AND state = 'writing' AND operation_id = ? AND fence = ?`,
    params: [timestamp, lease.digest, lease.operationId, lease.fence] as const,
  };
}

async function readOwnedWritingLease(
  sql: Sql,
  operationId: string,
  input: ArtifactBlobWriteInput,
): Promise<ArtifactBlobWriteLease | null> {
  const rows = await sql.query(
    `SELECT digest, operation_id, fence, tenant_id, principal_id, upload_id,
            upload_fence, root_fence, expected_size, lease_expires_at
     FROM tf_artifact_blob_io_leases
     WHERE digest = ? AND state = 'writing' AND operation_id = ?`,
    [input.digest, operationId],
  );
  const row = rows[0];
  if (!row) return null;
  const lease = writeLease(row);
  return lease.tenantId === input.tenantId &&
    lease.principalId === input.principalId &&
    lease.uploadId === input.uploadId &&
    lease.uploadFence === input.uploadFence &&
    lease.rootFence === input.rootFence &&
    lease.expectedSize === input.expectedSize
    ? lease
    : null;
}

async function committedWriteVisible(sql: Sql, lease: ArtifactBlobWriteLease): Promise<boolean> {
  const rows = await sql.query(
    `SELECT 1 AS committed
     FROM tf_artifact_blob_io_results
     WHERE operation_id = ? AND digest = ? AND operation_kind = 'write'
       AND lease_fence = ? AND candidate_fence IS NULL
       AND tenant_id = ? AND principal_id = ? AND upload_id = ?
       AND upload_fence = ? AND root_fence = ? AND expected_size = ?
       AND outcome = 'write_committed'`,
    [
      lease.operationId,
      lease.digest,
      lease.fence,
      lease.tenantId,
      lease.principalId,
      lease.uploadId,
      lease.uploadFence,
      lease.rootFence,
      lease.expectedSize,
    ],
  );
  return rows.length === 1;
}

function writeLease(row: Row): ArtifactBlobWriteLease {
  return {
    digest: stringColumn(row, "digest"),
    operationId: stringColumn(row, "operation_id"),
    fence: positiveInteger(row, "fence"),
    tenantId: stringColumn(row, "tenant_id"),
    principalId: stringColumn(row, "principal_id"),
    uploadId: stringColumn(row, "upload_id"),
    uploadFence: positiveInteger(row, "upload_fence"),
    rootFence: positiveInteger(row, "root_fence"),
    expectedSize: nonnegativeInteger(row, "expected_size"),
    leaseExpiresAt: nonnegativeInteger(row, "lease_expires_at"),
  };
}

function blobKey(digest: string): string {
  return `art/${digest.slice("sha256:".length)}`;
}

function identifier(prefix: string, random: string): string {
  const suffix = random.replace(/[^A-Za-z0-9._-]/gu, "").slice(0, 100);
  if (suffix.length === 0) throw new Error("artifact blob I/O operation id is empty");
  return `${prefix}_${suffix}`.slice(0, 128);
}

function stringColumn(row: Row | undefined, name: string): string {
  const value = row?.[name];
  if (typeof value !== "string") throw new Error(`artifact blob I/O ${name} is invalid`);
  return value;
}

function positiveInteger(row: Row | undefined, name: string): number {
  const value = nonnegativeInteger(row, name);
  if (value < 1) throw new Error(`artifact blob I/O ${name} is invalid`);
  return value;
}

function nonnegativeInteger(row: Row | undefined, name: string): number {
  const value = row?.[name];
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new Error(`artifact blob I/O ${name} is invalid`);
  }
  return Number(value);
}
