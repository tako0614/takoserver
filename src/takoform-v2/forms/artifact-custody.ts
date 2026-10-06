import { bytesDigest, canonicalJson } from "../../json.ts";
import type { JsonObject, Row, Sql } from "../../ports.ts";
import { SqlError } from "../../ports.ts";
import type { V2BackendResult, V2Execution } from "../types.ts";
import type { V2ArtifactSource } from "./artifact-source.ts";

const CHUNK_BYTES = 65_536;

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

export interface SqlArtifactCustody<M extends { readonly files: readonly ArtifactFile[] }> {
  execute(input: V2Execution): Promise<V2BackendResult>;
  /** Read verified bytes only while this exact accepted v2 reference is leased. */
  readVerified(input: {
    readonly execution: V2Execution;
    readonly targetResourceUid: string;
  }): Promise<SqlArtifactCustodyRead<M>>;
}

/** Byte custody only: Form-specific parsing and observation remain with callers. */
export function createSqlArtifactCustody<
  M extends { readonly files: readonly ArtifactFile[] },
>(options: {
  readonly sql: Sql;
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
  /** Additional Form-specific byte rule, after raw digest verification. */
  readonly validateFile?: (bytes: Uint8Array, sha256: string) => Promise<boolean>;
  readonly invalidArtifact: () => Error;
  readonly invalidManifest: () => Error;
  readonly failureNoun: string;
}): SqlArtifactCustody<M> {
  const { sql, source } = options;
  const tables = TABLES[options.layout];

  async function owner(uid: string): Promise<OwnerRow | null> {
    return ((await sql.query(`SELECT * FROM ${tables.owners} WHERE resource_uid = ?`, [uid]))[0] ??
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

  async function heldFile(uid: string, fileIndex: number, expectedSha256: string) {
    const chunks = await sql.query(
      `SELECT chunk_index, bytes FROM ${tables.chunks}
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
      if (size > options.limits.fileBytes) return null;
    }
    const joined = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      const bytes = asBytes(chunk.bytes);
      joined.set(bytes, offset);
      offset += bytes.byteLength;
    }
    return (await validFile(joined, expectedSha256)) ? joined : null;
  }

  async function stageFile(input: V2Execution, index: number, bytes: Uint8Array): Promise<void> {
    for (let offset = 0; offset < Math.max(1, bytes.byteLength); offset += CHUNK_BYTES) {
      const part = bytes.subarray(offset, Math.min(offset + CHUNK_BYTES, bytes.byteLength));
      await sql.run(
        `INSERT OR IGNORE INTO ${tables.chunks}
           (resource_uid, file_index, chunk_index, bytes, operation_id, lease_token)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          input.resourceUid,
          index,
          offset / CHUNK_BYTES,
          exactBuffer(part),
          input.operationId,
          input.leaseToken,
        ],
      );
    }
    const sha256 = (await bytesDigest(bytes)).slice("sha256:".length);
    const held = await heldFile(input.resourceUid, index, sha256);
    if (!held || !sameBytes(held, bytes)) throw options.invalidArtifact();
  }

  async function ensureManifest(input: V2Execution, mayAcquire = true) {
    const spec = options.parseSpec(input.spec);
    let current = await owner(input.resourceUid);
    if (!current) {
      if (!mayAcquire) throw options.invalidArtifact();
      const bytes = await acquire(
        input,
        spec.artifact.url,
        spec.artifact.sha256,
        options.limits.manifestBytes,
      );
      options.parseManifest(bytes);
      await sql.run(
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
          input.operationId,
          input.leaseToken,
        ],
      );
      current = await owner(input.resourceUid);
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
    input: V2Execution,
    manifest: M,
    mayAcquire: boolean,
  ): Promise<readonly Uint8Array[]> {
    const held: Uint8Array[] = [];
    let total = 0;
    for (let index = 0; index < manifest.files.length; index += 1) {
      const file = manifest.files[index];
      if (!file) throw options.invalidManifest();
      const remainingBytes = options.limits.aggregateBytes - total;
      let bytes: Uint8Array<ArrayBufferLike> | null = await heldFile(
        input.resourceUid,
        index,
        file.sha256,
      );
      if (bytes && bytes.byteLength > remainingBytes) throw options.invalidArtifact();
      if (!bytes && mayAcquire) {
        bytes = await acquire(
          input,
          file.url,
          file.sha256,
          Math.min(options.limits.fileBytes, remainingBytes),
        );
        if (!(await validFile(bytes, file.sha256))) throw options.invalidArtifact();
        await stageFile(input, index, bytes);
      }
      if (!bytes) throw options.invalidArtifact();
      total += bytes.byteLength;
      if (total > options.limits.aggregateBytes) throw options.invalidArtifact();
      held.push(bytes);
    }
    return held;
  }

  async function verify(input: V2Execution): Promise<V2BackendResult> {
    const { current, manifestBytes, manifest } = await ensureManifest(input);
    const files = await ensureFiles(input, manifest, current.state !== "verified");
    const result = await options.validatePayload({
      spec: input.spec,
      manifestBytes,
      fileBytes: files,
    });
    const observedJson = canonicalJson(result.observed);
    if (current.state === "verified") {
      if (current.observation_json !== observedJson) throw options.invalidArtifact();
    } else {
      const written = await sql.run(
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

  async function readVerified(input: {
    readonly execution: V2Execution;
    readonly targetResourceUid: string;
  }): Promise<SqlArtifactCustodyRead<M>> {
    const { execution, targetResourceUid } = input;
    const denied = () => new SqlError("unavailable", "verified artifact is unavailable");
    if (!tables.hasFormUrl || !targetResourceUid) throw denied();

    const authorizationRow = async (): Promise<Row> => {
      let candidate: Row | undefined;
      try {
        candidate = (
          await sql.query(
            `SELECT op.accepted_spec_json, target.spec_json AS target_spec_json,
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
         JOIN tf_v2_artifact_owners owner ON owner.resource_uid = target.uid
         WHERE op.id = ? AND op.lease_token = ? AND op.status = 'reconciling'
           AND op.action IN ('create', 'update')
           AND op.resource_uid = ? AND op.principal = ? AND op.generation = ?
           AND op.backend_key = ? AND op.backend_id = ? AND op.target_key = ?
           AND consumer.principal = op.principal AND consumer.form_url = ?
           AND consumer.space = ? AND consumer.name = ?
           AND consumer.backend_id = op.backend_id AND consumer.target_key = op.target_key
           AND consumer.busy_operation = op.id AND consumer.last_operation = op.id
           AND consumer.generation = op.generation AND consumer.deleted_at IS NULL
           AND accepted_ref.form_url = ?
           AND (accepted_ref.target_spec_path IS NULL OR
                json_extract(target.spec_json, accepted_ref.target_spec_path) =
                  accepted_ref.target_spec_equals)
           AND target.principal = op.principal AND target.space = consumer.space
           AND target.form_url = ? AND target.deleted_at IS NULL
           AND target.busy_operation IS NULL AND target.phase = 'idle'
           AND target.generation = target.observed_generation
           AND owner.form_url = target.form_url AND owner.state = 'verified'`,
            [
              targetResourceUid,
              execution.operationId,
              execution.leaseToken,
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
      return candidate;
    };
    const candidate = await authorizationRow();

    try {
      const acceptedSpec = JSON.parse(String(candidate.accepted_spec_json)) as JsonObject;
      if (canonicalJson(acceptedSpec) !== canonicalJson(execution.spec)) throw denied();
      const targetSpec = JSON.parse(String(candidate.target_spec_json)) as JsonObject;
      const targetObserved = JSON.parse(String(candidate.target_observed_json)) as JsonObject;
      const { current, manifestBytes, manifest } = await ensureManifest(
        {
          ...execution,
          resourceUid: targetResourceUid,
          form: options.formUrl,
          spec: targetSpec,
        },
        false,
      );
      if (current.state !== "verified" || !current.observation_json) throw denied();
      const files = await ensureFiles(
        { ...execution, resourceUid: targetResourceUid, form: options.formUrl, spec: targetSpec },
        manifest,
        false,
      );
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
      const finalAuthorization = await authorizationRow();
      if (
        finalAuthorization.accepted_spec_json !== candidate.accepted_spec_json ||
        finalAuthorization.target_spec_json !== candidate.target_spec_json ||
        finalAuthorization.target_observed_json !== candidate.target_observed_json ||
        finalAuthorization.owner_observation_json !== candidate.owner_observation_json
      ) {
        throw denied();
      }
      return {
        manifest,
        manifestBytes: new Uint8Array(manifestBytes),
        files: files.map((bytes) => new Uint8Array(bytes)),
        observed: JSON.parse(observedJson) as JsonObject,
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

  return { execute, readVerified };
}

function asBytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return new Uint8Array(value);
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
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
