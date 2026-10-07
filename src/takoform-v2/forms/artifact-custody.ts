import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { bytesDigest, canonicalJson } from "../../json.ts";
import type { Clock, JsonObject, Row, Sql } from "../../ports.ts";
import { SqlError } from "../../ports.ts";
import type { V2BackendResult, V2Execution } from "../types.ts";
import type { V2ArtifactSource } from "./artifact-source.ts";

const CHUNK_BYTES = 65_536;
const CHUNKS_PER_WRITE = 15; // six bindings each; D1 permits at most 100.
const CHUNK_WRITES_PER_PASS = 4;
const FILES_PER_PASS = 6;
const CHUNKS_PER_READ = 16;
// Reserve at least twelve D1 queries for the surrounding Host claim/settle.
const VERIFY_SQL_STATEMENTS_PER_PASS = 38;

class WorkBudgetExhausted extends Error {}

/** Closed internal layouts. The 0071 layout remains authoritative for MigrationSet. */
type CustodyLayout = "migration-set-0071" | "artifact-0072";
const TABLES = {
  "migration-set-0071": {
    owners: "tf_v2_migration_set_owners",
    chunks: "tf_v2_migration_set_chunks",
    hasFormUrl: false,
  },
  "artifact-0072": {
    owners: "tf_v2_artifact_owners",
    chunks: "tf_v2_artifact_chunks",
    hasFormUrl: true,
  },
} as const;

interface OwnerRow extends Row {
  resource_uid: string;
  form_url?: string;
  manifest_sha256: string;
  manifest_bytes: Uint8Array | ArrayBuffer;
  state: "staging" | "verified";
  observation_json: string | null;
}

interface ProgressRow extends Row {
  operation_id: string;
  resource_uid: string;
  form_url: string;
  next_file_index: number;
  current_file_bytes: number | null;
  current_file_sha256: string | null;
  file_sizes_json: string;
  total_bytes: number;
  lease_token: string;
}

interface ArtifactSpec {
  readonly artifact: { readonly url: string; readonly sha256: string };
}

interface ArtifactFile {
  readonly url: string;
  readonly sha256: string;
}

export interface SqlArtifactCustodyRead<M> {
  readonly manifest: M;
  readonly manifestBytes: Uint8Array;
  readonly files: readonly Uint8Array[];
  readonly observed: JsonObject;
}

/** A scoped description, not proof that the held file bytes are still intact. */
export interface SqlArtifactCustodyUnverified<M> {
  readonly manifest: M;
  readonly manifestBytes: Uint8Array;
  readonly observed: JsonObject;
  readonly fileSizes: readonly number[];
  /** Returned chunks are untrusted until their complete file digest is checked. */
  readPage(input: {
    readonly fileIndex: number;
    readonly nextChunk: number;
  }): Promise<{ readonly chunks: readonly Uint8Array[]; readonly nextChunk: number | null }>;
  /** The sink must be private staging, never a serving or native effect. */
  stageVerifiedFile(input: {
    readonly fileIndex: number;
    readonly write: (chunk: Uint8Array) => Promise<void>;
  }): Promise<{ readonly sha256: string; readonly byteSize: number }>;
}

export interface SqlArtifactCustodyHeldInput {
  readonly targetResourceUid: string;
  readonly principal: string;
  readonly space: string;
  readonly expectedSpec: JsonObject;
  readonly expectedObserved: JsonObject;
  readonly stillAuthorized: () => Promise<boolean>;
}

export interface SqlArtifactCustody<M extends { readonly files: readonly ArtifactFile[] }> {
  execute(input: V2Execution): Promise<V2BackendResult>;
  /** Read verified bytes only while this exact accepted v2 reference is leased. */
  readVerified(input: {
    readonly execution: V2Execution;
    readonly targetResourceUid: string;
  }): Promise<SqlArtifactCustodyRead<M>>;
  /** Internal graph read. The caller must prove its accepted graph on both sides. */
  readHeldVerified(input: SqlArtifactCustodyHeldInput): Promise<SqlArtifactCustodyRead<M>>;
  /** Internal graph-only bounded read. A caller must re-open after restart. */
  openHeldUnverified(input: SqlArtifactCustodyHeldInput): Promise<SqlArtifactCustodyUnverified<M>>;
}

/** Byte custody only: Form-specific parsing and observation remain with callers. */
export function createSqlArtifactCustody<
  M extends { readonly files: readonly ArtifactFile[] },
>(options: {
  readonly sql: Sql;
  /** Host-owned clock for SQL lease checks; never supplied by a read caller. */
  readonly now?: Clock;
  readonly source: V2ArtifactSource;
  readonly layout: CustodyLayout;
  readonly formUrl: string;
  readonly limits: {
    readonly manifestBytes: number;
    readonly fileBytes: number;
    readonly aggregateBytes: number;
  };
  readonly parseSpec: (spec: JsonObject) => ArtifactSpec;
  readonly parseManifest: (bytes: Uint8Array) => M;
  readonly validatePayload: (input: {
    readonly spec: JsonObject;
    readonly manifestBytes: Uint8Array;
    readonly fileBytes: readonly Uint8Array[];
  }) => Promise<{ readonly observed: object; readonly output: object }>;
  /** Projection from already verified immutable files; no aggregate byte array. */
  readonly projectVerified: (input: {
    readonly spec: JsonObject;
    readonly manifestBytes: Uint8Array;
    readonly fileSizes: readonly number[];
  }) => Promise<{ readonly observed: object; readonly output: object }>;
  /** Additional Form-specific byte rule, after raw digest verification. */
  readonly validateFile?: (bytes: Uint8Array, sha256: string) => Promise<boolean>;
  readonly invalidArtifact: () => Error;
  readonly invalidManifest: () => Error;
  readonly failureNoun: string;
}): SqlArtifactCustody<M> {
  const { sql, source } = options;
  const now = options.now ?? (() => new Date());
  const tables = TABLES[options.layout];

  async function owner(uid: string, db: Sql = sql): Promise<OwnerRow | null> {
    return ((await db.query(`SELECT * FROM ${tables.owners} WHERE resource_uid = ?`, [uid]))[0] ??
      null) as OwnerRow | null;
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
      throw options.invalidArtifact();
    }
    // The source may own a mutable buffer. Clone before crossing the digest await.
    const bytes = new Uint8Array(supplied);
    if ((await bytesDigest(bytes)) !== `sha256:${sha256}`) throw options.invalidArtifact();
    return bytes;
  }

  async function validFile(bytes: Uint8Array, sha256: string): Promise<boolean> {
    if (bytes.byteLength > options.limits.fileBytes) return false;
    if ((await bytesDigest(bytes)) !== `sha256:${sha256}`) return false;
    return (await options.validateFile?.(bytes, sha256)) ?? true;
  }

  async function heldFile(
    uid: string,
    fileIndex: number,
    expectedSha256: string,
    expectedSize?: number,
    db: Sql = sql,
  ) {
    if (
      expectedSize !== undefined &&
      (!Number.isSafeInteger(expectedSize) ||
        expectedSize < 0 ||
        expectedSize > options.limits.fileBytes)
    )
      return null;
    // D1 materializes BLOBs as arrays of JS numbers. Never ask it to return a
    // whole 16 MiB file (roughly 128 MiB of numbers) in one query.
    const joined = expectedSize === undefined ? null : new Uint8Array(expectedSize);
    const parts: Uint8Array[] = [];
    let size = 0;
    let next = 0;
    let lastLength = CHUNK_BYTES;
    for (;;) {
      const page = await db.query(
        `SELECT chunk_index, bytes FROM ${tables.chunks}
         WHERE resource_uid = ? AND file_index = ? AND chunk_index >= ?
         ORDER BY chunk_index LIMIT ?`,
        [uid, fileIndex, next, CHUNKS_PER_READ],
      );
      for (const chunk of page) {
        if (chunk.chunk_index !== next || lastLength !== CHUNK_BYTES) return null;
        const bytes = asBytes(chunk.bytes);
        if (bytes.byteLength > CHUNK_BYTES || (bytes.byteLength === 0 && next !== 0)) return null;
        if (size + bytes.byteLength > (expectedSize ?? options.limits.fileBytes)) return null;
        if (joined) joined.set(bytes, size);
        else parts.push(bytes);
        size += bytes.byteLength;
        lastLength = bytes.byteLength;
        next += 1;
      }
      if (page.length < CHUNKS_PER_READ) break;
    }
    if (next === 0 || (expectedSize !== undefined && size !== expectedSize)) return null;
    const bytes = joined ?? new Uint8Array(size);
    if (!joined) {
      let offset = 0;
      for (const part of parts) {
        bytes.set(part, offset);
        offset += part.byteLength;
      }
    }
    return (await validFile(bytes, expectedSha256)) ? bytes : null;
  }

  async function chunkPrefix(
    uid: string,
    fileIndex: number,
    length: number,
    db: Sql = sql,
  ): Promise<number> {
    const row = (
      await db.query(
        `SELECT COUNT(*) AS count, MAX(chunk_index) AS last_index,
           COALESCE(SUM(length(bytes)), 0) AS total_bytes
         FROM ${tables.chunks} WHERE resource_uid = ? AND file_index = ?`,
        [uid, fileIndex],
      )
    )[0];
    const count = row?.count;
    const required = Math.max(1, Math.ceil(length / CHUNK_BYTES));
    if (
      typeof count !== "number" ||
      count < 0 ||
      count > required ||
      (count > 0 && row?.last_index !== count - 1) ||
      row?.total_bytes !== Math.min(count * CHUNK_BYTES, length)
    ) {
      throw options.invalidArtifact();
    }
    return count;
  }

  async function stageBatch(
    input: V2Execution,
    fileIndex: number,
    bytes: Uint8Array,
    firstChunk: number,
    db: Sql = sql,
  ): Promise<number> {
    const required = Math.max(1, Math.ceil(bytes.byteLength / CHUNK_BYTES));
    const count = Math.min(CHUNKS_PER_WRITE, required - firstChunk);
    if (count <= 0) return firstChunk;
    const params: (string | number | ArrayBuffer)[] = [];
    for (let i = 0; i < count; i += 1) {
      const chunkIndex = firstChunk + i;
      const offset = chunkIndex * CHUNK_BYTES;
      params.push(
        input.resourceUid,
        fileIndex,
        chunkIndex,
        exactBuffer(bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength))),
        input.operationId,
        input.leaseToken,
      );
    }
    await db.run(
      `INSERT OR IGNORE INTO ${tables.chunks}
         (resource_uid, file_index, chunk_index, bytes, operation_id, lease_token)
       VALUES ${Array.from({ length: count }, () => "(?, ?, ?, ?, ?, ?)").join(", ")}`,
      params,
    );
    return firstChunk + count;
  }

  async function ensureManifest(
    input: Pick<V2Execution, "resourceUid" | "spec">,
    mayAcquire = true,
    acquisition?: V2Execution,
    db: Sql = sql,
  ) {
    const spec = options.parseSpec(input.spec);
    let current = await owner(input.resourceUid, db);
    if (!current) {
      if (!mayAcquire || !acquisition) throw options.invalidArtifact();
      const bytes = await acquire(
        acquisition,
        spec.artifact.url,
        spec.artifact.sha256,
        options.limits.manifestBytes,
      );
      options.parseManifest(bytes);
      await db.run(
        tables.hasFormUrl
          ? `INSERT OR IGNORE INTO ${tables.owners}
               (resource_uid, form_url, manifest_sha256, manifest_bytes,
                staged_operation_id, staged_lease_token, state)
             VALUES (?, ?, ?, ?, ?, ?, 'staging')`
          : `INSERT OR IGNORE INTO ${tables.owners}
               (resource_uid, manifest_sha256, manifest_bytes,
                staged_operation_id, staged_lease_token, state)
             VALUES (?, ?, ?, ?, ?, 'staging')`,
        [
          input.resourceUid,
          ...(tables.hasFormUrl ? [options.formUrl] : []),
          spec.artifact.sha256,
          exactBuffer(bytes),
          acquisition.operationId,
          acquisition.leaseToken,
        ],
      );
      current = await owner(input.resourceUid, db);
    }
    if (
      !current ||
      current.manifest_sha256 !== spec.artifact.sha256 ||
      (tables.hasFormUrl && current.form_url !== options.formUrl)
    ) {
      throw options.invalidArtifact();
    }
    const manifestBytes = asBytes(current.manifest_bytes);
    if ((await bytesDigest(manifestBytes)) !== `sha256:${spec.artifact.sha256}`) {
      throw options.invalidArtifact();
    }
    return { current, manifestBytes, manifest: options.parseManifest(manifestBytes) };
  }

  async function ensureFiles(
    input: Pick<V2Execution, "resourceUid" | "spec">,
    manifest: M,
  ): Promise<readonly Uint8Array[]> {
    const held: Uint8Array[] = [];
    let total = 0;
    for (let index = 0; index < manifest.files.length; index += 1) {
      const file = manifest.files[index];
      if (!file) throw options.invalidManifest();
      const remainingBytes = options.limits.aggregateBytes - total;
      const bytes: Uint8Array<ArrayBufferLike> | null = await heldFile(
        input.resourceUid,
        index,
        file.sha256,
      );
      if (bytes && bytes.byteLength > remainingBytes) throw options.invalidArtifact();
      if (!bytes) throw options.invalidArtifact();
      total += bytes.byteLength;
      if (total > options.limits.aggregateBytes) throw options.invalidArtifact();
      held.push(bytes);
    }
    return held;
  }

  async function progress(input: V2Execution, fileCount: number, db: Sql): Promise<ProgressRow> {
    await db.run(
      `INSERT OR IGNORE INTO tf_v2_artifact_progress
         (operation_id, resource_uid, form_url, lease_token) VALUES (?, ?, ?, ?)`,
      [input.operationId, input.resourceUid, options.formUrl, input.leaseToken],
    );
    let row = (
      await db.query("SELECT * FROM tf_v2_artifact_progress WHERE operation_id = ?", [
        input.operationId,
      ])
    )[0] as ProgressRow | undefined;
    if (!row || row.resource_uid !== input.resourceUid || row.form_url !== options.formUrl) {
      throw new SqlError("unavailable", "artifact progress is unavailable");
    }
    if (row.lease_token !== input.leaseToken) {
      const rotated = await db.run(
        `UPDATE tf_v2_artifact_progress SET lease_token = ?
         WHERE operation_id = ? AND lease_token = ?`,
        [input.leaseToken, input.operationId, row.lease_token],
      );
      if (rotated.changes !== 1) throw new SqlError("unavailable", "artifact claim was lost");
      row = { ...row, lease_token: input.leaseToken };
    }
    const sizes = JSON.parse(row.file_sizes_json) as unknown;
    if (
      !Array.isArray(sizes) ||
      row.next_file_index > fileCount ||
      sizes.length !== row.next_file_index ||
      !sizes.every(
        (size) => Number.isSafeInteger(size) && size >= 0 && size <= options.limits.fileBytes,
      ) ||
      sizes.reduce<number>((sum, size) => sum + size, 0) !== row.total_bytes ||
      row.total_bytes > options.limits.aggregateBytes
    ) {
      throw options.invalidArtifact();
    }
    return row;
  }

  async function beginFile(
    input: V2Execution,
    row: ProgressRow,
    fileSha256: string,
    size: number,
    db: Sql,
  ): Promise<ProgressRow> {
    if (size > options.limits.fileBytes || row.total_bytes + size > options.limits.aggregateBytes) {
      throw options.invalidArtifact();
    }
    const written = await db.run(
      `UPDATE tf_v2_artifact_progress
       SET current_file_bytes = ?, current_file_sha256 = ?
       WHERE operation_id = ? AND lease_token = ? AND next_file_index = ?
         AND current_file_bytes IS NULL`,
      [size, fileSha256, input.operationId, input.leaseToken, row.next_file_index],
    );
    if (written.changes !== 1) throw new SqlError("unavailable", "artifact claim was lost");
    return { ...row, current_file_bytes: size, current_file_sha256: fileSha256 };
  }

  async function finishFile(input: V2Execution, row: ProgressRow, db: Sql): Promise<ProgressRow> {
    const size = row.current_file_bytes;
    if (size === null) throw options.invalidArtifact();
    const sizes = JSON.parse(row.file_sizes_json) as number[];
    const updated = {
      ...row,
      next_file_index: row.next_file_index + 1,
      current_file_bytes: null,
      current_file_sha256: null,
      file_sizes_json: JSON.stringify([...sizes, size]),
      total_bytes: row.total_bytes + size,
    };
    const written = await db.run(
      `UPDATE tf_v2_artifact_progress SET next_file_index = ?,
         current_file_bytes = NULL, current_file_sha256 = NULL,
         file_sizes_json = ?, total_bytes = ?
       WHERE operation_id = ? AND lease_token = ? AND next_file_index = ?
         AND current_file_bytes = ?`,
      [
        updated.next_file_index,
        updated.file_sizes_json,
        updated.total_bytes,
        input.operationId,
        input.leaseToken,
        row.next_file_index,
        size,
      ],
    );
    if (written.changes !== 1) throw new SqlError("unavailable", "artifact claim was lost");
    return updated;
  }

  async function verify(input: V2Execution): Promise<V2BackendResult> {
    let remainingSql = VERIFY_SQL_STATEMENTS_PER_PASS;
    const spend = (statements = 1) => {
      if (remainingSql < statements) throw new WorkBudgetExhausted();
      remainingSql -= statements;
    };
    const db: Sql = {
      query(statement, params) {
        spend();
        return sql.query(statement, params);
      },
      run(statement, params) {
        spend();
        return sql.run(statement, params);
      },
      batch(statements) {
        spend(statements.length);
        return sql.batch(statements);
      },
    };
    const { current, manifestBytes, manifest } = await ensureManifest(input, true, input, db);
    const observedFiles = current.observation_json
      ? (JSON.parse(current.observation_json) as { files?: readonly { byteSize?: number }[] }).files
      : undefined;
    let checkpoint = await progress(input, manifest.files.length, db);
    let advanced = 0;
    let chunkWrites = 0;
    while (checkpoint.next_file_index < manifest.files.length) {
      if (advanced >= FILES_PER_PASS || chunkWrites >= CHUNK_WRITES_PER_PASS) {
        return { kind: "continue" };
      }
      const index = checkpoint.next_file_index;
      const file = manifest.files[index];
      if (!file) throw options.invalidManifest();
      if (checkpoint.current_file_bytes !== null && checkpoint.current_file_sha256 !== file.sha256)
        throw options.invalidArtifact();

      let bytes: Uint8Array | null = null;
      if (checkpoint.current_file_bytes !== null) {
        const count = await chunkPrefix(
          input.resourceUid,
          index,
          checkpoint.current_file_bytes,
          db,
        );
        const required = Math.max(1, Math.ceil(checkpoint.current_file_bytes / CHUNK_BYTES));
        if (count === required) {
          bytes = await heldFile(
            input.resourceUid,
            index,
            file.sha256,
            checkpoint.current_file_bytes,
            db,
          );
          if (!bytes) throw options.invalidArtifact();
        }
      } else if (current.state === "verified") {
        const recordedSize = observedFiles?.[index]?.byteSize;
        bytes = await heldFile(
          input.resourceUid,
          index,
          file.sha256,
          Number.isSafeInteger(recordedSize) &&
            recordedSize !== undefined &&
            recordedSize >= 0 &&
            recordedSize <= options.limits.fileBytes
            ? recordedSize
            : undefined,
          db,
        );
        if (!bytes) throw options.invalidArtifact();
        checkpoint = await beginFile(input, checkpoint, file.sha256, bytes.byteLength, db);
      }
      if (!bytes) {
        if (current.state === "verified") throw options.invalidArtifact();
        const remaining = options.limits.aggregateBytes - checkpoint.total_bytes;
        const sourceBytes = await acquire(
          input,
          file.url,
          file.sha256,
          Math.min(options.limits.fileBytes, remaining),
        );
        if (!(await validFile(sourceBytes, file.sha256))) throw options.invalidArtifact();
        if (checkpoint.current_file_bytes === null) {
          checkpoint = await beginFile(input, checkpoint, file.sha256, sourceBytes.byteLength, db);
        } else if (checkpoint.current_file_bytes !== sourceBytes.byteLength) {
          throw options.invalidArtifact();
        }
        let nextChunk = await chunkPrefix(input.resourceUid, index, sourceBytes.byteLength, db);
        const required = Math.max(1, Math.ceil(sourceBytes.byteLength / CHUNK_BYTES));
        while (nextChunk < required && chunkWrites < CHUNK_WRITES_PER_PASS) {
          nextChunk = await stageBatch(input, index, sourceBytes, nextChunk, db);
          chunkWrites += 1;
        }
        if (nextChunk < required) return { kind: "continue" };
        bytes = await heldFile(input.resourceUid, index, file.sha256, sourceBytes.byteLength, db);
        if (!bytes || !sameBytes(bytes, sourceBytes)) throw options.invalidArtifact();
      }
      checkpoint = await finishFile(input, checkpoint, db);
      advanced += 1;
    }
    const result = await options.projectVerified({
      spec: input.spec,
      manifestBytes,
      fileSizes: JSON.parse(checkpoint.file_sizes_json) as number[],
    });
    const observedJson = canonicalJson(result.observed);
    if (current.state === "verified") {
      if (current.observation_json !== observedJson) throw options.invalidArtifact();
    } else {
      const written = await db.run(
        `UPDATE ${tables.owners} SET state = 'verified', observation_json = ?,
           verified_operation_id = ?, verified_lease_token = ?
         WHERE resource_uid = ? AND state = 'staging'`,
        [observedJson, input.operationId, input.leaseToken, input.resourceUid],
      );
      if (written.changes !== 1) {
        throw new SqlError("unavailable", "custody finalization not confirmed");
      }
    }
    return {
      kind: "complete",
      observed: JSON.parse(observedJson) as JsonObject,
      output: JSON.parse(canonicalJson(result.output)) as JsonObject,
    };
  }

  async function release(input: V2Execution): Promise<V2BackendResult> {
    await sql.run(
      `DELETE FROM ${tables.owners}
       WHERE resource_uid = ? ${tables.hasFormUrl ? "AND form_url = ?" : ""} AND EXISTS (
         SELECT 1 FROM tf_v2_operations op JOIN tf_v2_resources r ON r.uid = op.resource_uid
         WHERE op.id = ? AND op.lease_token = ? AND op.status = 'reconciling'
           AND op.action = 'delete' AND r.uid = ? AND r.busy_operation = op.id
           AND r.generation = op.generation AND r.backend_id = op.backend_id
           AND r.target_key = op.target_key)`,
      [
        input.resourceUid,
        ...(tables.hasFormUrl ? [options.formUrl] : []),
        input.operationId,
        input.leaseToken,
        input.resourceUid,
      ],
    );
    if (await owner(input.resourceUid)) {
      throw new SqlError("unavailable", "custody release unconfirmed");
    }
    return { kind: "complete", observed: {}, output: {} };
  }

  const denied = () => new SqlError("unavailable", "verified artifact is unavailable");

  async function heldVerified(
    targetResourceUid: string,
    targetSpec: JsonObject,
    targetObserved: JsonObject,
  ): Promise<SqlArtifactCustodyRead<M>> {
    const heldInput = { resourceUid: targetResourceUid, spec: targetSpec };
    const { current, manifestBytes, manifest } = await ensureManifest(heldInput, false);
    if (current.state !== "verified" || !current.observation_json) throw denied();
    const files = await ensureFiles(heldInput, manifest);
    const result = await options.validatePayload({
      spec: targetSpec,
      manifestBytes,
      fileBytes: files,
    });
    const observedJson = canonicalJson(result.observed);
    if (
      current.observation_json !== observedJson ||
      canonicalJson(targetObserved) !== observedJson
    ) {
      throw denied();
    }
    return {
      manifest,
      manifestBytes: new Uint8Array(manifestBytes),
      files: files.map((bytes) => new Uint8Array(bytes)),
      observed: JSON.parse(observedJson) as JsonObject,
    };
  }

  async function readVerified(input: {
    readonly execution: V2Execution;
    readonly targetResourceUid: string;
  }): Promise<SqlArtifactCustodyRead<M>> {
    const { execution, targetResourceUid } = input;
    if (!targetResourceUid) throw denied();

    const authorizationRow = async (): Promise<Row> => {
      let candidate: Row | undefined;
      try {
        const nowMs = now().getTime();
        if (!Number.isFinite(nowMs)) throw denied();
        candidate = (
          await sql.query(
            `SELECT op.accepted_spec_json, op.lease_until_ms,
                target.spec_json AS target_spec_json,
                target.observed_json AS target_observed_json,
                owner.state AS owner_state, owner.observation_json AS owner_observation_json
         FROM tf_v2_operations op
         JOIN tf_v2_resources consumer ON consumer.uid = op.resource_uid
         JOIN tf_v2_operation_reference_sets accepted_set
           ON accepted_set.operation_id = op.id AND accepted_set.sealed = 1
         JOIN tf_v2_operation_references accepted_ref
           ON accepted_ref.operation_id = op.id AND accepted_ref.target_uid = ?
         JOIN tf_v2_resource_references active_ref
           ON active_ref.target_uid = accepted_ref.target_uid
          AND active_ref.referrer_uid = consumer.uid
         JOIN tf_v2_resources target ON target.uid = accepted_ref.target_uid
         JOIN ${tables.owners} owner ON owner.resource_uid = target.uid
         WHERE op.id = ? AND op.lease_token = ? AND op.status = 'reconciling'
           AND op.dispatch_possible = 1 AND op.lease_until_ms > ?
           AND op.action IN ('create', 'update') AND op.action = ?
           AND op.resource_uid = ? AND op.principal = ? AND op.generation = ?
           AND op.backend_key = ? AND op.backend_id = ? AND op.target_key = ?
           AND consumer.principal = op.principal AND consumer.form_url = ?
           AND consumer.space = ? AND consumer.name = ?
           AND consumer.backend_id = op.backend_id AND consumer.target_key = op.target_key
           AND consumer.busy_operation = op.id AND consumer.last_operation = op.id
           AND consumer.generation = op.generation AND consumer.deleted_at IS NULL
           AND consumer.spec_json = op.accepted_spec_json
           AND accepted_ref.form_url = ?
           AND (accepted_ref.target_spec_path IS NULL OR
                json_extract(target.spec_json, accepted_ref.target_spec_path) =
                  accepted_ref.target_spec_equals)
           AND target.principal = op.principal AND target.space = consumer.space
           AND target.form_url = ? AND target.deleted_at IS NULL
           AND target.busy_operation IS NULL AND target.phase = 'idle'
           AND target.generation = target.observed_generation
           AND owner.state = 'verified'
           ${tables.hasFormUrl ? "AND owner.form_url = target.form_url" : ""}`,
            [
              targetResourceUid,
              execution.operationId,
              execution.leaseToken,
              nowMs,
              execution.action,
              execution.resourceUid,
              execution.principal,
              execution.generation,
              execution.backendKey,
              execution.backendId,
              execution.targetKey,
              execution.form,
              execution.space,
              execution.name,
              options.formUrl,
              options.formUrl,
            ],
          )
        )[0];
      } catch {
        throw denied();
      }
      if (candidate?.owner_state !== "verified") throw denied();
      const freshNowMs = now().getTime();
      if (
        !Number.isFinite(freshNowMs) ||
        typeof candidate.lease_until_ms !== "number" ||
        candidate.lease_until_ms <= freshNowMs
      )
        throw denied();
      return candidate;
    };
    const candidate = await authorizationRow();

    try {
      const acceptedSpec = JSON.parse(String(candidate.accepted_spec_json)) as JsonObject;
      if (canonicalJson(acceptedSpec) !== canonicalJson(execution.spec)) throw denied();
      const targetSpec = JSON.parse(String(candidate.target_spec_json)) as JsonObject;
      const targetObserved = JSON.parse(String(candidate.target_observed_json)) as JsonObject;
      const read = await heldVerified(targetResourceUid, targetSpec, targetObserved);
      const finalAuthorization = await authorizationRow();
      if (
        finalAuthorization.accepted_spec_json !== candidate.accepted_spec_json ||
        finalAuthorization.target_spec_json !== candidate.target_spec_json ||
        finalAuthorization.target_observed_json !== candidate.target_observed_json ||
        finalAuthorization.owner_observation_json !== candidate.owner_observation_json
      ) {
        throw denied();
      }
      return read;
    } catch {
      throw denied();
    }
  }

  function heldAuthorization(input: SqlArtifactCustodyHeldInput) {
    const expectedSpecJson = canonicalJson(input.expectedSpec);
    const expectedObservedJson = canonicalJson(input.expectedObserved);
    const params = [
      input.targetResourceUid,
      input.principal,
      input.space,
      options.formUrl,
      expectedSpecJson,
      expectedObservedJson,
    ];
    const fromWhere = `FROM tf_v2_resources target
           JOIN tf_v2_operations settled ON settled.id = target.last_operation
           JOIN ${tables.owners} owner ON owner.resource_uid = target.uid
           WHERE target.uid = ? AND target.principal = ? AND target.space = ?
             AND target.form_url = ? AND target.deleted_at IS NULL
             AND target.busy_operation IS NULL AND target.phase = 'idle'
             AND target.generation = target.observed_generation
             AND settled.resource_uid = target.uid AND settled.principal = target.principal
             AND settled.generation = target.generation
             AND settled.status = 'succeeded' AND settled.effect = 'complete'
             AND target.spec_json = ? AND target.observed_json = ?
             AND owner.state = 'verified'
             ${tables.hasFormUrl ? "AND owner.form_url = target.form_url" : ""}
             AND owner.observation_json = target.observed_json`;
    const row = async (): Promise<Row> => {
      const found = (
        await sql.query(
          `SELECT target.uid, target.generation, target.last_operation,
              target.spec_json, target.observed_json, owner.observation_json,
              owner.manifest_sha256, owner.verified_operation_id,
              length(owner.manifest_bytes) AS manifest_byte_size
           ${fromWhere} LIMIT 1`,
          params,
        )
      )[0];
      if (!found) throw denied();
      return found;
    };
    return { params, fromWhere, row };
  }

  async function readHeldVerified(
    input: SqlArtifactCustodyHeldInput,
  ): Promise<SqlArtifactCustodyRead<M>> {
    if (!input.targetResourceUid) throw denied();
    try {
      const authorizationRow = heldAuthorization(input).row;
      if (!(await input.stillAuthorized())) throw denied();
      const before = await authorizationRow();
      const read = await heldVerified(
        input.targetResourceUid,
        input.expectedSpec,
        input.expectedObserved,
      );
      const after = await authorizationRow();
      if (canonicalJson(before) !== canonicalJson(after)) throw denied();
      if (!(await input.stillAuthorized())) throw denied();
      return read;
    } catch {
      throw denied();
    }
  }

  async function openHeldUnverified(
    input: SqlArtifactCustodyHeldInput,
  ): Promise<SqlArtifactCustodyUnverified<M>> {
    if (!input.targetResourceUid) throw denied();
    try {
      // Neither the caller's objects nor a previously returned descriptor are authority.
      const scoped: SqlArtifactCustodyHeldInput = {
        ...input,
        expectedSpec: JSON.parse(canonicalJson(input.expectedSpec)) as JsonObject,
        expectedObserved: JSON.parse(canonicalJson(input.expectedObserved)) as JsonObject,
      };
      const authorization = heldAuthorization(scoped);
      if (!(await scoped.stillAuthorized())) throw denied();
      const initial = await authorization.row();
      if (
        !Number.isSafeInteger(initial.generation) ||
        typeof initial.last_operation !== "string" ||
        typeof initial.verified_operation_id !== "string" ||
        typeof initial.manifest_sha256 !== "string"
      )
        throw denied();
      const pinned = [
        initial.generation as number,
        initial.last_operation,
        initial.verified_operation_id,
        initial.manifest_sha256,
      ];
      const { current, manifestBytes, manifest } = await ensureManifest(
        { resourceUid: scoped.targetResourceUid, spec: scoped.expectedSpec },
        false,
      );
      if (
        current.state !== "verified" ||
        current.observation_json !== canonicalJson(scoped.expectedObserved)
      ) {
        throw denied();
      }
      const observedFiles = scoped.expectedObserved.files;
      if (!Array.isArray(observedFiles) || observedFiles.length !== manifest.files.length) {
        throw denied();
      }
      const fileSizes = observedFiles.map((value: unknown) => {
        if (typeof value !== "object" || value === null || Array.isArray(value)) throw denied();
        const size = (value as Record<string, unknown>).byteSize;
        if (
          !Number.isSafeInteger(size) ||
          (size as number) < 0 ||
          (size as number) > options.limits.fileBytes
        ) {
          throw denied();
        }
        return size as number;
      });
      const projection = await options.projectVerified({
        spec: scoped.expectedSpec,
        manifestBytes,
        fileSizes,
      });
      if (canonicalJson(projection.observed) !== canonicalJson(scoped.expectedObserved))
        throw denied();
      const checkCurrent = async () => {
        const latest = await authorization.row();
        if (canonicalJson(latest) !== canonicalJson(initial) || !(await scoped.stillAuthorized())) {
          throw denied();
        }
      };
      await checkCurrent();

      const readPage = async ({
        fileIndex,
        nextChunk,
      }: {
        readonly fileIndex: number;
        readonly nextChunk: number;
      }): Promise<{
        readonly chunks: readonly Uint8Array[];
        readonly nextChunk: number | null;
      }> => {
        try {
          if (
            !Number.isSafeInteger(fileIndex) ||
            fileIndex < 0 ||
            fileIndex >= manifest.files.length ||
            !Number.isSafeInteger(nextChunk) ||
            nextChunk < 0
          )
            throw denied();
          const fileSize = fileSizes[fileIndex];
          if (fileSize === undefined) throw denied();
          const required = Math.max(1, Math.ceil(fileSize / CHUNK_BYTES));
          if (nextChunk >= required) throw denied();
          const count = Math.min(CHUNKS_PER_READ, required - nextChunk);
          if (!(await scoped.stillAuthorized())) throw denied();
          const before = await authorization.row();
          if (canonicalJson(before) !== canonicalJson(initial)) throw denied();
          const rows = await sql.query(
            `SELECT chunk.chunk_index, chunk.bytes FROM ${tables.chunks} chunk
           JOIN (SELECT target.uid, target.generation, target.last_operation,
                        owner.verified_operation_id, owner.manifest_sha256
                 ${authorization.fromWhere}) authorized
             ON authorized.uid = chunk.resource_uid
           WHERE chunk.file_index = ? AND chunk.chunk_index >= ?
             AND authorized.generation = ? AND authorized.last_operation = ?
             AND authorized.verified_operation_id = ? AND authorized.manifest_sha256 = ?
           ORDER BY chunk.chunk_index LIMIT ?`,
            [...authorization.params, fileIndex, nextChunk, ...pinned, count],
          );
          if (rows.length !== count) throw denied();
          const chunks: Uint8Array[] = [];
          for (let offset = 0; offset < count; offset += 1) {
            const row = rows[offset];
            const index = nextChunk + offset;
            if (row?.chunk_index !== index) throw denied();
            const bytes = asBytes(row.bytes);
            const expectedLength =
              index === required - 1 ? fileSize - index * CHUNK_BYTES : CHUNK_BYTES;
            if (bytes.byteLength !== expectedLength) throw denied();
            chunks.push(bytes);
          }
          if (nextChunk + count === required) {
            const extra = await sql.query(
              `SELECT 1 FROM ${tables.chunks} chunk
             JOIN (SELECT target.uid, target.generation, target.last_operation,
                          owner.verified_operation_id, owner.manifest_sha256
                   ${authorization.fromWhere}) authorized
               ON authorized.uid = chunk.resource_uid
             WHERE chunk.file_index = ? AND chunk.chunk_index >= ?
               AND authorized.generation = ? AND authorized.last_operation = ?
               AND authorized.verified_operation_id = ? AND authorized.manifest_sha256 = ?
             LIMIT 1`,
              [...authorization.params, fileIndex, required, ...pinned],
            );
            if (extra.length !== 0) throw denied();
          }
          await checkCurrent();
          return {
            chunks,
            nextChunk: nextChunk + count === required ? null : nextChunk + count,
          };
        } catch {
          throw denied();
        }
      };

      return {
        manifest: structuredClone(manifest),
        manifestBytes: new Uint8Array(manifestBytes),
        observed: structuredClone(scoped.expectedObserved),
        fileSizes: [...fileSizes],
        readPage,
        async stageVerifiedFile({ fileIndex, write }) {
          try {
            if (
              typeof write !== "function" ||
              !Number.isSafeInteger(fileIndex) ||
              fileIndex < 0 ||
              fileIndex >= manifest.files.length
            )
              throw denied();
            const file = manifest.files[fileIndex];
            const byteSize = fileSizes[fileIndex];
            if (!file || byteSize === undefined) throw denied();
            const hash = sha256.create();
            let cursor: number | null = 0;
            while (cursor !== null) {
              const page = await readPage({ fileIndex, nextChunk: cursor });
              for (const chunk of page.chunks) {
                hash.update(chunk);
                await write(new Uint8Array(chunk));
              }
              cursor = page.nextChunk;
            }
            const digest = bytesToHex(hash.digest());
            if (digest !== file.sha256) throw denied();
            await checkCurrent();
            return { sha256: digest, byteSize };
          } catch {
            throw denied();
          }
        },
      };
    } catch {
      throw denied();
    }
  }

  async function execute(input: V2Execution): Promise<V2BackendResult> {
    if (input.action === "delete") return await release(input);
    try {
      return await verify(input);
    } catch (error) {
      if (error instanceof WorkBudgetExhausted) return { kind: "continue" };
      if (error instanceof SqlError) throw error;
      const stage = await owner(input.resourceUid);
      // The terminal failed settlement atomically removes unverified stage rows.
      return stage?.state === "verified"
        ? {
            kind: "partial",
            code: "artifact_incomplete",
            message: `${options.failureNoun} bytes could not be verified`,
          }
        : {
            kind: "no_effect",
            code: "artifact_unavailable",
            message: `${options.failureNoun} bytes could not be acquired`,
          };
    }
  }

  return { execute, readVerified, readHeldVerified, openHeldUnverified };
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  // D1 returns BLOB columns as arrays of byte numbers. Validate before copying:
  // Uint8Array.from would silently coerce fractions and out-of-range values.
  if (Array.isArray(value)) {
    const bytes = new Uint8Array(value.length);
    for (let index = 0; index < value.length; index += 1) {
      const byte: unknown = value[index];
      if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) {
        throw new SqlError("unavailable", "invalid stored byte representation");
      }
      bytes[index] = byte;
    }
    return bytes;
  }
  throw new SqlError("unavailable", "invalid stored byte representation");
}

function exactBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
