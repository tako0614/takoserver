import { bytesDigest, canonicalJson } from "../../json.ts";
import type { JsonObject, Row, Sql } from "../../ports.ts";
import { SqlError } from "../../ports.ts";
import { TakoformV2Error, type V2BackendResult, type V2Execution, type V2Form } from "../types.ts";
import type { V2ArtifactSource } from "./artifact-source.ts";
import {
  parseSQLiteMigrationManifest,
  parseSQLiteMigrationSetSpec,
  SQLITE_MIGRATION_SET_LIMITS,
  type SQLiteMigrationManifest,
  type SQLiteMigrationSetObservation,
  SQLiteMigrationSetValidationError,
  validateSQLiteMigrationPayload,
  validateSQLiteMigrationSetUpdate,
} from "./sqlite-migration-set.ts";

const CHUNK_BYTES = 65_536;
export const SQLITE_MIGRATION_SET_BACKEND_ID = "selfhost-v2-sqlite-migration-set-sql-v1";

interface OwnerRow extends Row {
  resource_uid: string;
  manifest_sha256: string;
  manifest_bytes: Uint8Array | ArrayBuffer;
  state: "staging" | "verified";
  observation_json: string | null;
}

/** Self-hosted SQL custody: the same v2 Operation claim fences every byte mutation. */
export function createSQLiteMigrationSetForm(options: {
  sql: Sql;
  source: V2ArtifactSource;
  /** Stable opaque identity of this durable local SQL target, never a path or secret. */
  targetKey: string;
}): V2Form {
  if (!options.targetKey) throw new TypeError("targetKey is required");
  const { sql, source } = options;

  async function owner(uid: string): Promise<OwnerRow | null> {
    return ((
      await sql.query("SELECT * FROM tf_v2_migration_set_owners WHERE resource_uid = ?", [uid])
    )[0] ?? null) as OwnerRow | null;
  }

  async function acquire(input: V2Execution, url: string, sha256: string, maxBytes: number) {
    const supplied = await source.read({
      principal: input.principal,
      space: input.space,
      url,
      sha256,
      maxBytes,
    });
    if (!(supplied instanceof Uint8Array) || supplied.byteLength > maxBytes) {
      throw new SQLiteMigrationSetValidationError("invalid_artifact");
    }
    // Never retain an adapter-owned mutable buffer across a digest await.
    const bytes = new Uint8Array(supplied);
    if ((await bytesDigest(bytes)) !== `sha256:${sha256}`) {
      throw new SQLiteMigrationSetValidationError("invalid_artifact");
    }
    return bytes;
  }

  async function heldFile(uid: string, fileIndex: number, expectedSha256: string) {
    const chunks = await sql.query(
      `SELECT chunk_index, bytes FROM tf_v2_migration_set_chunks
       WHERE resource_uid = ? AND file_index = ? ORDER BY chunk_index`,
      [uid, fileIndex],
    );
    if (chunks.length === 0) return null;
    let size = 0;
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      if (!chunk || chunk.chunk_index !== index) return null;
      const bytes = asBytes(chunk.bytes);
      if (bytes.byteLength > CHUNK_BYTES) return null;
      if (bytes.byteLength === 0 && (chunks.length !== 1 || index !== 0)) return null;
      if (index < chunks.length - 1 && bytes.byteLength !== CHUNK_BYTES) return null;
      size += bytes.byteLength;
      if (size > SQLITE_MIGRATION_SET_LIMITS.fileBytes) return null;
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = asBytes(chunk.bytes);
      joined.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return (await validSqlFile(joined, expectedSha256)) ? joined : null;
  }

  async function stageFile(input: V2Execution, index: number, bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < Math.max(1, bytes.byteLength); offset += CHUNK_BYTES) {
      const part = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
      const chunkIndex = offset / CHUNK_BYTES;
      await sql.run(
        `INSERT OR IGNORE INTO tf_v2_migration_set_chunks
           (resource_uid, file_index, chunk_index, bytes, operation_id, lease_token)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.resourceUid,
          index,
          chunkIndex,
          exactBuffer(part),
          input.operationId,
          input.leaseToken,
        ],
      );
    }
    const held = await heldFile(input.resourceUid, index, bareDigest(await bytesDigest(bytes)));
    if (!held || !sameBytes(held, bytes)) {
      throw new SQLiteMigrationSetValidationError("invalid_artifact");
    }
  }

  async function ensureManifest(input: V2Execution) {
    const spec = parseSQLiteMigrationSetSpec(input.spec);
    let current = await owner(input.resourceUid);
    if (!current) {
      const bytes = await acquire(
        input,
        spec.artifact.url,
        spec.artifact.sha256,
        SQLITE_MIGRATION_SET_LIMITS.manifestBytes,
      );
      parseSQLiteMigrationManifest(bytes);
      await sql.run(
        `INSERT OR IGNORE INTO tf_v2_migration_set_owners
           (resource_uid, manifest_sha256, manifest_bytes, staged_operation_id,
            staged_lease_token, state)
         VALUES (?, ?, ?, ?, ?, 'staging')`,
        [
          input.resourceUid,
          spec.artifact.sha256,
          exactBuffer(bytes),
          input.operationId,
          input.leaseToken,
        ],
      );
      current = await owner(input.resourceUid);
    }
    if (!current || current.manifest_sha256 !== spec.artifact.sha256) {
      throw new SQLiteMigrationSetValidationError("invalid_artifact");
    }
    const manifestBytes = asBytes(current.manifest_bytes);
    if ((await bytesDigest(manifestBytes)) !== `sha256:${spec.artifact.sha256}`) {
      throw new SQLiteMigrationSetValidationError("invalid_artifact");
    }
    return { current, manifestBytes, manifest: parseSQLiteMigrationManifest(manifestBytes) };
  }

  async function ensureFiles(
    input: V2Execution,
    manifest: SQLiteMigrationManifest,
    mayAcquire: boolean,
  ): Promise<readonly Uint8Array[]> {
    const held: Uint8Array[] = [];
    let total = 0;
    for (let index = 0; index < manifest.files.length; index += 1) {
      const file = manifest.files[index];
      if (!file) throw new SQLiteMigrationSetValidationError("invalid_manifest");
      let bytes: Uint8Array<ArrayBufferLike> | null = await heldFile(
        input.resourceUid,
        index,
        file.sha256,
      );
      if (!bytes && mayAcquire) {
        bytes = await acquire(input, file.url, file.sha256, SQLITE_MIGRATION_SET_LIMITS.fileBytes);
        if (!(await validSqlFile(bytes, file.sha256))) {
          throw new SQLiteMigrationSetValidationError("invalid_artifact");
        }
        await stageFile(input, index, bytes);
      }
      if (!bytes) throw new SQLiteMigrationSetValidationError("invalid_artifact");
      total += bytes.byteLength;
      if (total > SQLITE_MIGRATION_SET_LIMITS.aggregateBytes) {
        throw new SQLiteMigrationSetValidationError("invalid_artifact");
      }
      held.push(bytes);
    }
    return held;
  }

  async function verify(
    input: V2Execution,
    manifestBytes: Uint8Array,
    manifest: SQLiteMigrationManifest,
    current: OwnerRow,
  ): Promise<SQLiteMigrationSetObservation> {
    const files = await ensureFiles(input, manifest, current.state !== "verified");
    const result = await validateSQLiteMigrationPayload({
      spec: input.spec,
      manifestBytes,
      fileBytes: files,
    });
    const observedJson = canonicalJson(result.observed);
    if (current.state === "verified") {
      if (current.observation_json !== observedJson) {
        throw new SQLiteMigrationSetValidationError("invalid_artifact");
      }
      return result;
    }
    const written = await sql.run(
      `UPDATE tf_v2_migration_set_owners SET state = 'verified', observation_json = ?,
         verified_operation_id = ?, verified_lease_token = ?
       WHERE resource_uid = ? AND state = 'staging'`,
      [observedJson, input.operationId, input.leaseToken, input.resourceUid],
    );
    if (written.changes !== 1)
      throw new SqlError("unavailable", "custody finalization not confirmed");
    return result;
  }

  async function apply(input: V2Execution): Promise<V2BackendResult> {
    if (input.action === "delete") {
      await sql.run(
        `DELETE FROM tf_v2_migration_set_owners
         WHERE resource_uid = ? AND EXISTS (
           SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
           WHERE op.id = ? AND op.lease_token = ? AND op.status = 'reconciling'
             AND op.action = 'delete' AND r.uid = ? AND r.busy_operation = op.id
             AND r.generation = op.generation AND r.backend_id = op.backend_id
             AND r.target_key = op.target_key)`,
        [input.resourceUid, input.operationId, input.leaseToken, input.resourceUid],
      );
      if (await owner(input.resourceUid))
        throw new SqlError("unavailable", "custody release unconfirmed");
      return { kind: "complete", observed: {}, output: {} };
    }

    try {
      const { current, manifestBytes, manifest } = await ensureManifest(input);
      const result = await verify(input, manifestBytes, manifest, current);
      return {
        kind: "complete",
        observed: JSON.parse(canonicalJson(result.observed)) as JsonObject,
        output: {},
      };
    } catch (error) {
      if (error instanceof SqlError) throw error;
      const stage = await owner(input.resourceUid);
      // A terminal failure atomically GC's staging rows in migration 0071.
      // Only previously verified (and now damaged) custody is a remaining effect.
      return stage?.state === "verified"
        ? {
            kind: "partial",
            code: "artifact_incomplete",
            message: "Migration bytes could not be verified",
          }
        : {
            kind: "no_effect",
            code: "artifact_unavailable",
            message: "Migration bytes could not be acquired",
          };
    }
  }

  return {
    validateCreate(spec) {
      try {
        parseSQLiteMigrationSetSpec(spec);
      } catch (error) {
        if (error instanceof SQLiteMigrationSetValidationError)
          throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    validateUpdate(previousSpec, spec) {
      try {
        validateSQLiteMigrationSetUpdate(previousSpec, spec);
      } catch (error) {
        if (error instanceof SQLiteMigrationSetValidationError)
          throw new TakoformV2Error(error.code, 422);
        throw error;
      }
    },
    rejectDeleteWhileReferenced: true,
    backend: {
      id: SQLITE_MIGRATION_SET_BACKEND_ID,
      targetKey: options.targetKey,
      execute: apply,
      reconcile: apply,
    },
  };
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new SqlError("unavailable", "invalid stored byte representation");
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function bareDigest(digest: `sha256:${string}`) {
  return digest.slice("sha256:".length);
}

async function validSqlFile(bytes: Uint8Array, sha256: string): Promise<boolean> {
  if (bytes.byteLength > SQLITE_MIGRATION_SET_LIMITS.fileBytes) return false;
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf)
    return false;
  try {
    new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
  } catch {
    return false;
  }
  return (await bytesDigest(bytes)) === `sha256:${sha256}`;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
