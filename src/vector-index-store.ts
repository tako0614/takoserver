/**
 * Bounded SQL storage for the internal VectorIndex boundary.
 *
 * This adapter deliberately owns no serving, provider, binding, or Resource
 * lifecycle policy.  A caller supplies the tenant/Resource scope and an
 * already-provisioned SQL index.  The codec is the only public-input parser;
 * every write below consumes its complete canonical result.
 */

import { canonicalJson } from "./json.ts";
import type { Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import {
  parseVectorIndexConfig,
  parseVectorIndexInput,
  type VectorIndexConfig,
  type VectorIndexConfigInput,
  type VectorIndexGetInput,
  VectorIndexInvalidSpecError,
  type VectorIndexMetadata,
  type VectorIndexMetadataScalar,
  type VectorIndexQueryInput,
  type VectorIndexRecord,
} from "./vector-index-codec.ts";

export type { VectorIndexConfigInput } from "./vector-index-codec.ts";

const DEFAULT_RECORD_LIMIT = 1_000;
const MAX_RECORD_LIMIT = 1_000;
const QUERY_PAGE_SIZE = 64;
const MAX_TOP_K = 100;
const MAX_SQL_ID_BATCH = 97;
const MAX_TENANT_LENGTH = 255;
const MAX_RESOURCE_UID_LENGTH = 128;

export type VectorIndexStoreErrorCode = "invalid_spec" | "quota" | "unavailable";

/** All storage-facing operation failures use one closed three-code taxonomy. */
export class VectorIndexStoreError extends Error {
  readonly code: VectorIndexStoreErrorCode;

  constructor(code: VectorIndexStoreErrorCode, message: string = code) {
    super(message);
    this.name = "VectorIndexStoreError";
    this.code = code;
  }
}

/** Alias retained for callers that name failures after the operation boundary. */
export class VectorIndexOperationError extends VectorIndexStoreError {
  constructor(code: VectorIndexStoreErrorCode, message: string = code) {
    super(code, message);
    this.name = "VectorIndexOperationError";
  }
}

/** A tenant/Resource UID scope addressed by every SQL operation. */
export interface VectorIndexScope {
  readonly tenantId: string;
  readonly resourceUid: string;
}

export interface VectorIndexCreateInput extends VectorIndexScope {
  readonly config?: VectorIndexConfigInput;
  readonly dimension?: unknown;
  readonly metric?: unknown;
  readonly filterKeys?: unknown;
  /** Host-private bounded quota; omitted means the fixed default of 1000. */
  readonly recordLimit?: unknown;
}

export interface VectorIndexRecordCount extends VectorIndexScope {
  readonly count: number;
}

export interface VectorIndexIndex extends VectorIndexScope {
  readonly config: VectorIndexConfig;
  readonly recordLimit: number;
}

export interface VectorIndexUpsertResult {
  readonly ids: readonly string[];
  readonly count: number;
}

export interface VectorIndexGetResult {
  readonly vectors: readonly VectorIndexRecord[];
}

export interface VectorIndexDeleteResult {
  readonly ids: readonly string[];
  readonly count: number;
}

export interface VectorIndexQueryMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata?: VectorIndexMetadata;
  readonly values?: readonly number[];
}

export interface VectorIndexQueryResult {
  readonly matches: readonly VectorIndexQueryMatch[];
  readonly count: number;
}

export interface VectorIndexStore {
  createIndex(
    tenantId: string,
    resourceUid: string,
    config: VectorIndexConfigInput,
    options?: { readonly recordLimit?: number },
  ): Promise<void>;
  createIndex(input: VectorIndexCreateInput): Promise<void>;
  ensureIndex(
    tenantId: string,
    resourceUid: string,
    config: VectorIndexConfigInput,
    options?: { readonly recordLimit?: number },
  ): Promise<void>;
  ensureIndex(input: VectorIndexCreateInput): Promise<void>;
  readIndex(scope: VectorIndexScope): Promise<VectorIndexIndex | null>;
  readIndex(tenantId: string, resourceUid: string): Promise<VectorIndexIndex | null>;
  readCount(scope: VectorIndexScope): Promise<number>;
  readCount(tenantId: string, resourceUid: string): Promise<number>;
  deleteIndex(scope: VectorIndexScope): Promise<boolean>;
  deleteIndex(tenantId: string, resourceUid: string): Promise<boolean>;

  upsert(scope: VectorIndexScope, input: unknown): Promise<VectorIndexUpsertResult>;
  upsert(tenantId: string, resourceUid: string, input: unknown): Promise<VectorIndexUpsertResult>;
  upsert(input: VectorIndexScope & { readonly input: unknown }): Promise<VectorIndexUpsertResult>;
  get(scope: VectorIndexScope, input: unknown): Promise<VectorIndexGetResult>;
  get(tenantId: string, resourceUid: string, input: unknown): Promise<VectorIndexGetResult>;
  get(input: VectorIndexScope & { readonly input: unknown }): Promise<VectorIndexGetResult>;
  delete(scope: VectorIndexScope, input: unknown): Promise<VectorIndexDeleteResult>;
  delete(tenantId: string, resourceUid: string, input: unknown): Promise<VectorIndexDeleteResult>;
  delete(input: VectorIndexScope & { readonly input: unknown }): Promise<VectorIndexDeleteResult>;
  query(scope: VectorIndexScope, input: unknown): Promise<VectorIndexQueryResult>;
  query(tenantId: string, resourceUid: string, input: unknown): Promise<VectorIndexQueryResult>;
  query(input: VectorIndexScope & { readonly input: unknown }): Promise<VectorIndexQueryResult>;
}

interface ParsedScope {
  readonly tenantId: string;
  readonly resourceUid: string;
}

interface Candidate {
  readonly id: string;
  readonly values: readonly number[];
  readonly score: number;
}

interface HydratedCandidate extends Candidate {
  readonly metadata: VectorIndexMetadata;
}

/**
 * Construct the SQL-backed store.  Passing a bare Sql is supported as a small
 * convenience for self-host callers; the object form is the named seam used by
 * composition code.
 */
export function createVectorIndexStore(options: { readonly sql: Sql }): VectorIndexStore;
export function createVectorIndexStore(sql: Sql): VectorIndexStore;
export function createVectorIndexStore(
  optionsOrSql: { readonly sql: Sql } | Sql,
): VectorIndexStore {
  const sql = isSql(optionsOrSql) ? optionsOrSql : optionsOrSql.sql;
  if (!isSql(sql)) throw new TypeError("a Sql implementation is required");

  const readIndex = async (
    first: VectorIndexScope | string,
    second?: string,
  ): Promise<VectorIndexIndex | null> => {
    const scope = normalizeScope(first, second);
    let rows: readonly Row[];
    try {
      rows = await sql.query(
        `SELECT tenant_id, resource_uid, dimension, metric,
                filter_keys_json, record_limit
         FROM vector_indexes
         WHERE tenant_id = ? AND resource_uid = ?
         LIMIT 2`,
        [scope.tenantId, scope.resourceUid],
      );
    } catch (error) {
      throw mapStorageError(error);
    }
    if (rows.length > 1) throw unavailable("vector index scope is ambiguous");
    const row = rows[0];
    if (!row) return null;
    return decodeIndex(scope, row);
  };

  const createIndex = async (
    first: VectorIndexCreateInput | string,
    second?: string,
    third?: VectorIndexConfigInput,
    fourth?: { readonly recordLimit?: number },
  ): Promise<void> => {
    const { scope, configInput, recordLimit, recordLimitProvided } = normalizeCreateArgs(
      first,
      second,
      third,
      fourth,
    );
    const config = parseVectorIndexConfig(configInput);
    const boundedRecordLimit = parseRecordLimit(recordLimit);
    try {
      await sql.run(
        `INSERT OR IGNORE INTO vector_indexes
           (tenant_id, resource_uid, dimension, metric, filter_keys_json, record_limit)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          scope.tenantId,
          scope.resourceUid,
          config.dimension,
          config.metric,
          JSON.stringify(config.filterKeys),
          boundedRecordLimit,
        ],
      );
    } catch (error) {
      throw mapStorageError(error);
    }

    // INSERT OR IGNORE is intentionally followed by a readback.  A concurrent
    // creator may have won the primary key, and immutable config must be
    // compared with that winner rather than silently accepted.
    const existing = await readIndex(scope);
    if (!existing) throw unavailable("vector index create was not durable");
    if (!sameConfig(existing.config, config)) {
      throw invalidSpec("vector index configuration is immutable");
    }
    // The private quota is an optional provisioning knob.  An idempotent
    // ensure call that omits it must not reinterpret an already-created index's
    // explicit quota as the fixed default; an explicitly supplied value still
    // participates in the immutable comparison.
    if (recordLimitProvided && existing.recordLimit !== boundedRecordLimit) {
      throw invalidSpec("vector index configuration is immutable");
    }
  };

  const ensureIndex = createIndex;

  const readCount = async (first: VectorIndexScope | string, second?: string): Promise<number> => {
    const scope = normalizeScope(first, second);
    try {
      const rows = await sql.query(
        `SELECT COUNT(*) AS count
         FROM vector_index_records
         WHERE tenant_id = ? AND resource_uid = ?`,
        [scope.tenantId, scope.resourceUid],
      );
      const count = rows[0]?.count;
      if (count === undefined) throw unavailable("vector index count read was empty");
      return safeInteger(count, "vector index count");
    } catch (error) {
      throw mapStorageError(error);
    }
  };

  const deleteIndex = async (
    first: VectorIndexScope | string,
    second?: string,
  ): Promise<boolean> => {
    const scope = normalizeScope(first, second);
    try {
      const write = await sql.run(
        `DELETE FROM vector_indexes WHERE tenant_id = ? AND resource_uid = ?`,
        [scope.tenantId, scope.resourceUid],
      );
      if (write.changes !== 0 && write.changes !== 1) {
        throw unavailable("vector index delete changed an unexpected number of rows");
      }
      return write.changes === 1;
    } catch (error) {
      throw mapStorageError(error);
    }
  };

  const upsert = async (
    first: VectorIndexScope | string,
    second?: string | unknown,
    third?: unknown,
  ): Promise<VectorIndexUpsertResult> => {
    const { scope, input } = normalizeOperationArgs(first, second, third);
    const index = await readIndex(scope);
    if (!index) throw unavailable("vector index does not exist");
    // This is deliberately before the first SQL write.  The codec traverses
    // the complete batch, so an invalid later record has zero write effects.
    const parsed = parseVectorIndexInput("upsert", input, index.config);
    // Prepare every record (including binary32 encoding, norm calculation, and
    // canonical metadata/terms) before the first provider effect.  The pure
    // codec validates each component, but aggregate norm overflow is a
    // storage-facing concern; keeping it in this preflight preserves the
    // zero-effect guarantee for any invalid record later in the request.
    const prepared = parsed.vectors.map((record) =>
      prepareUpsertRecord(
        scope,
        parsed.namespace,
        record,
        index.config.dimension,
        index.config.filterKeys,
      ),
    );
    for (const statements of prepared) {
      try {
        await sql.batch(statements);
      } catch (error) {
        throw mapStorageError(error);
      }
    }
    return { ids: parsed.vectors.map((record) => record.id), count: parsed.vectors.length };
  };

  const get = async (
    first: VectorIndexScope | string,
    second?: string | unknown,
    third?: unknown,
  ): Promise<VectorIndexGetResult> => {
    const { scope, input } = normalizeOperationArgs(first, second, third);
    const index = await readIndex(scope);
    if (!index) throw unavailable("vector index does not exist");
    const parsed = parseVectorIndexInput("get", input, index.config);
    const records = await readRecordsByIds(sql, scope, parsed, index.config.dimension);
    return { vectors: records };
  };

  const remove = async (
    first: VectorIndexScope | string,
    second?: string | unknown,
    third?: unknown,
  ): Promise<VectorIndexDeleteResult> => {
    const { scope, input } = normalizeOperationArgs(first, second, third);
    const index = await readIndex(scope);
    if (!index) throw unavailable("vector index does not exist");
    const parsed = parseVectorIndexInput("delete", input, index.config);
    for (const ids of chunks(parsed.ids, MAX_SQL_ID_BATCH)) {
      const placeholders = ids.map(() => "?").join(", ");
      try {
        await sql.run(
          `DELETE FROM vector_index_records
           WHERE tenant_id = ? AND resource_uid = ? AND namespace = ?
             AND id IN (${placeholders})`,
          [scope.tenantId, scope.resourceUid, parsed.namespace, ...ids],
        );
      } catch (error) {
        // Each chunk is independent.  A quota/unavailable failure may leave
        // the already-committed prefix, exactly as the operation contract
        // permits; the dedicated quota sentinel is not expected on delete but
        // remains mapped consistently if a trigger is added later.
        throw mapStorageError(error);
      }
    }
    return { ids: [...parsed.ids], count: parsed.ids.length };
  };

  const query = async (
    first: VectorIndexScope | string,
    second?: string | unknown,
    third?: unknown,
  ): Promise<VectorIndexQueryResult> => {
    const { scope, input } = normalizeOperationArgs(first, second, third);
    const index = await readIndex(scope);
    if (!index) throw unavailable("vector index does not exist");
    const parsed = parseVectorIndexInput("query", input, index.config);
    const queryNorm = vectorNorm(parsed.values);
    const heap = new TopKHeap(parsed.topK);
    let cursor: string | undefined;

    // Keyset pages are fixed at 64 rows.  We continue until an empty page,
    // rather than stopping at topK, so settled cardinality is never silently
    // under-counted by an early ANN-style cutoff.
    for (;;) {
      const page = await readQueryPage(sql, scope, parsed, cursor);
      if (page.length === 0) break;
      for (const row of page) {
        const candidate = decodeCandidate(row, index.config.dimension, parsed.values, queryNorm);
        heap.consider(candidate);
      }
      const last = page[page.length - 1];
      if (!last) break;
      cursor = stringColumn(last.id, "vector index record id");
    }

    const winners = heap.values();
    // Metadata hydration re-reads the complete winner row and repeats the
    // filter predicates.  A concurrent replacement can therefore only remove
    // a stale winner (or replace it with a newly scored, matching row); it can
    // never combine an old vector/score with new metadata.
    const hydrated = parsed.returnMetadata
      ? await hydrateWinners(sql, scope, parsed, index.config.dimension, queryNorm, winners)
      : null;
    const finalWinners = hydrated ? [...hydrated.values()].sort(compareCandidates) : winners;
    const matches: VectorIndexQueryMatch[] = finalWinners.map((winner) => {
      const match: {
        id: string;
        score: number;
        metadata?: VectorIndexMetadata;
        values?: readonly number[];
      } = {
        id: winner.id,
        score: winner.score,
      };
      if (parsed.returnMetadata) {
        match.metadata = (winner as HydratedCandidate).metadata;
      }
      if (parsed.returnValues) match.values = winner.values;
      return match;
    });
    return { matches, count: matches.length };
  };

  return {
    createIndex: createIndex as VectorIndexStore["createIndex"],
    ensureIndex: ensureIndex as VectorIndexStore["ensureIndex"],
    readIndex: readIndex as VectorIndexStore["readIndex"],
    readCount: readCount as VectorIndexStore["readCount"],
    deleteIndex: deleteIndex as VectorIndexStore["deleteIndex"],
    upsert: upsert as VectorIndexStore["upsert"],
    get: get as VectorIndexStore["get"],
    delete: remove as VectorIndexStore["delete"],
    query: query as VectorIndexStore["query"],
  };
}

function prepareUpsertRecord(
  scope: ParsedScope,
  namespace: string,
  record: VectorIndexRecord,
  dimension: number,
  filterKeys: readonly string[],
): readonly SqlStatement[] {
  const valuesBlob = encodeLittleEndianF32(record.values, dimension);
  const metadataJson = canonicalJson(record.metadata);
  // Only Resource-declared keys are indexed.  Metadata may carry additional
  // scalar properties for reads, but the per-record SQL batch is bounded by
  // the declaration limit of eight terms.
  const terms = filterKeys.flatMap((key) => {
    const value = record.metadata[key];
    return value === undefined ? [] : [[key, value] as const];
  });
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO vector_index_records
              (tenant_id, resource_uid, namespace, id, values_blob, norm, metadata_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT (tenant_id, resource_uid, namespace, id) DO UPDATE SET
              values_blob = excluded.values_blob,
              norm = excluded.norm,
              metadata_json = excluded.metadata_json`,
      params: [
        scope.tenantId,
        scope.resourceUid,
        namespace,
        record.id,
        valuesBlob,
        vectorNorm(record.values),
        metadataJson,
      ],
    },
    {
      sql: `DELETE FROM vector_index_filter_terms
            WHERE tenant_id = ? AND resource_uid = ? AND namespace = ? AND id = ?`,
      params: [scope.tenantId, scope.resourceUid, namespace, record.id],
    },
  ];

  // The codec's record type intentionally omits namespace: the operation owns
  // one namespace around the whole batch.
  for (const [key, value] of terms) {
    statements.push({
      sql: `INSERT INTO vector_index_filter_terms
              (tenant_id, resource_uid, namespace, id, filter_key,
               value_type, canonical_scalar_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      params: [
        scope.tenantId,
        scope.resourceUid,
        namespace,
        record.id,
        key,
        metadataValueType(value),
        canonicalJson(value),
      ],
    });
  }

  return statements;
}

async function readRecordsByIds(
  sql: Sql,
  scope: ParsedScope,
  input: VectorIndexGetInput,
  dimension: number,
): Promise<readonly VectorIndexRecord[]> {
  const byId = new Map<string, VectorIndexRecord>();
  for (const ids of chunks(input.ids, MAX_SQL_ID_BATCH)) {
    const placeholders = ids.map(() => "?").join(", ");
    let rows: readonly Row[];
    try {
      rows = await sql.query(
        `SELECT id, values_blob, norm, metadata_json
         FROM vector_index_records
         WHERE tenant_id = ? AND resource_uid = ? AND namespace = ?
           AND id IN (${placeholders})`,
        [scope.tenantId, scope.resourceUid, input.namespace, ...ids],
      );
    } catch (error) {
      throw mapStorageError(error);
    }
    for (const row of rows) {
      const id = stringColumn(row.id, "vector index record id");
      const values = decodeStoredValues(row.values_blob, dimension);
      const norm = positiveFinite(row.norm, "vector index record norm");
      // Recomputing the norm is intentionally not used for the scorer; this
      // readback only validates the persisted scalar and canonicalises values.
      if (!Number.isFinite(norm)) throw unavailable("vector index record norm is invalid");
      byId.set(id, {
        id,
        values,
        metadata: decodeMetadata(row.metadata_json),
      });
    }
  }
  return input.ids.flatMap((id) => {
    const record = byId.get(id);
    return record ? [record] : [];
  });
}

async function readQueryPage(
  sql: Sql,
  scope: ParsedScope,
  input: VectorIndexQueryInput,
  cursor: string | undefined,
): Promise<readonly Row[]> {
  const predicates: string[] = [];
  const params: SqlParam[] = [scope.tenantId, scope.resourceUid, input.namespace];
  const cursorPredicate = cursor === undefined ? "" : " AND record.id > ?";
  if (cursor !== undefined) params.push(cursor);
  for (const [key, value] of Object.entries(input.filter)) {
    const alias = `term_${predicates.length}`;
    predicates.push(`EXISTS (
      SELECT 1 FROM vector_index_filter_terms AS ${alias}
      WHERE ${alias}.tenant_id = record.tenant_id
        AND ${alias}.resource_uid = record.resource_uid
        AND ${alias}.namespace = record.namespace
        AND ${alias}.id = record.id
        AND ${alias}.filter_key = ?
        AND ${alias}.value_type = ?
        AND ${alias}.canonical_scalar_json = ?
    )`);
    params.push(key, metadataValueType(value), canonicalJson(value));
  }
  params.push(QUERY_PAGE_SIZE);
  const where =
    predicates.length > 0 ? `\n           AND ${predicates.join("\n           AND ")}` : "";
  try {
    return await sql.query(
      `SELECT record.id, record.values_blob, record.norm
       FROM vector_index_records AS record
       WHERE record.tenant_id = ? AND record.resource_uid = ?
         AND record.namespace = ?${cursorPredicate}${where}
       ORDER BY record.id ASC
       LIMIT ?`,
      params,
    );
  } catch (error) {
    throw mapStorageError(error);
  }
}

async function hydrateWinners(
  sql: Sql,
  scope: ParsedScope,
  input: VectorIndexQueryInput,
  dimension: number,
  queryNorm: number,
  winners: readonly Candidate[],
): Promise<Map<string, HydratedCandidate>> {
  const hydrated = new Map<string, HydratedCandidate>();
  const maxIds = Math.max(1, 100 - 3 - inputFilterParamCount(input.filter));
  for (const chunk of chunks(
    winners.map((winner) => winner.id),
    Math.min(MAX_SQL_ID_BATCH, maxIds),
  )) {
    if (chunk.length === 0) continue;
    const placeholders = chunk.map(() => "?").join(", ");
    const predicates: string[] = [];
    const params: SqlParam[] = [scope.tenantId, scope.resourceUid, input.namespace, ...chunk];
    for (const [key, value] of Object.entries(input.filter)) {
      const alias = `hydrate_term_${predicates.length}`;
      predicates.push(`EXISTS (
        SELECT 1 FROM vector_index_filter_terms AS ${alias}
        WHERE ${alias}.tenant_id = record.tenant_id
          AND ${alias}.resource_uid = record.resource_uid
          AND ${alias}.namespace = record.namespace
          AND ${alias}.id = record.id
          AND ${alias}.filter_key = ?
          AND ${alias}.value_type = ?
          AND ${alias}.canonical_scalar_json = ?
      )`);
      params.push(key, metadataValueType(value), canonicalJson(value));
    }
    const where =
      predicates.length > 0 ? `\n           AND ${predicates.join("\n           AND ")}` : "";
    let rows: readonly Row[];
    try {
      rows = await sql.query(
        `SELECT record.id, record.values_blob, record.norm, record.metadata_json
         FROM vector_index_records AS record
         WHERE record.tenant_id = ? AND record.resource_uid = ? AND record.namespace = ?
           AND record.id IN (${placeholders})${where}`,
        params,
      );
    } catch (error) {
      throw mapStorageError(error);
    }
    for (const row of rows) {
      const id = stringColumn(row.id, "vector index metadata id");
      const values = decodeStoredValues(row.values_blob, dimension);
      const storedNorm = positiveFinite(row.norm, "vector index record norm");
      let dot = 0;
      for (let index = 0; index < values.length; index += 1) {
        dot += (values[index] as number) * (input.values[index] as number);
      }
      let score = dot / (storedNorm * queryNorm);
      if (!Number.isFinite(score)) throw unavailable("vector index cosine score is not finite");
      score = Math.max(-1, Math.min(1, score));
      hydrated.set(id, {
        id,
        values,
        score,
        metadata: decodeMetadata(row.metadata_json),
      });
    }
  }
  return hydrated;
}

function inputFilterParamCount(filter: VectorIndexMetadata): number {
  return Object.keys(filter).length * 3;
}

function decodeCandidate(
  row: Row,
  dimension: number,
  queryValues: readonly number[],
  queryNorm: number,
): Candidate {
  const id = stringColumn(row.id, "vector index record id");
  const values = decodeStoredValues(row.values_blob, dimension);
  const storedNorm = positiveFinite(row.norm, "vector index record norm");
  let dot = 0;
  for (let index = 0; index < values.length; index += 1) {
    dot += (values[index] as number) * (queryValues[index] as number);
  }
  let score = dot / (storedNorm * queryNorm);
  if (!Number.isFinite(score)) throw unavailable("vector index cosine score is not finite");
  score = Math.max(-1, Math.min(1, score));
  return { id, values, score };
}

function decodeStoredValues(raw: unknown, dimension: number): readonly number[] {
  const bytes = asBytes(raw);
  if (bytes === null || bytes.byteLength !== dimension * 4) {
    throw unavailable("vector index value BLOB has the wrong dimension");
  }
  const values: number[] = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < dimension; index += 1) {
    const value = view.getFloat32(index * 4, true);
    if (!Number.isFinite(value)) throw unavailable("vector index value BLOB is not finite");
    values.push(value);
  }
  return Object.freeze(values);
}

function encodeLittleEndianF32(values: readonly number[], dimension: number): ArrayBuffer {
  if (values.length !== dimension) throw unavailable("vector index values dimension changed");
  const buffer = new ArrayBuffer(values.length * 4);
  const view = new DataView(buffer);
  for (let index = 0; index < values.length; index += 1) {
    view.setFloat32(index * 4, values[index] as number, true);
  }
  return buffer;
}

function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (value instanceof Uint8Array) return value;
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  return null;
}

function decodeMetadata(raw: unknown): VectorIndexMetadata {
  if (typeof raw !== "string") throw unavailable("vector index metadata is not text");
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw unavailable("vector index metadata is not valid JSON");
  }
  try {
    // Feed persisted JSON back through the one authoritative codec rather than
    // maintaining a second metadata grammar in this storage adapter.  A
    // synthetic one-dimensional record supplies only the codec context needed
    // to parse the flat metadata object; its canonical result is what callers
    // observe on get/query hydration.
    const parsed = parseVectorIndexInput(
      "upsert",
      { vectors: [{ id: "metadata", values: [1], metadata: value }] },
      { dimension: 1, metric: "cosine" },
    );
    const metadata = parsed.vectors[0]?.metadata;
    if (!metadata) throw unavailable("vector index metadata is not an object");
    return metadata;
  } catch (error) {
    if (error instanceof VectorIndexOperationError) throw error;
    throw unavailable("vector index metadata is corrupt");
  }
}

function metadataValueType(
  value: VectorIndexMetadataScalar,
): "string" | "number" | "boolean" | "null" {
  if (value === null) return "null";
  if (typeof value === "string") return "string";
  if (typeof value === "number") return "number";
  return "boolean";
}

function vectorNorm(values: readonly number[]): number {
  let sum = 0;
  for (const value of values) sum += value * value;
  const norm = Math.sqrt(sum);
  if (!Number.isFinite(norm) || norm <= 0) throw invalidSpec("vector cosine norm is invalid");
  return norm;
}

function positiveFinite(value: unknown, path: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number <= 0) throw unavailable(`${path} is invalid`);
  return number;
}

function stringColumn(value: unknown, path: string): string {
  if (typeof value !== "string") throw unavailable(`${path} is invalid`);
  return value;
}

function decodeIndex(scope: ParsedScope, row: Row): VectorIndexIndex {
  try {
    const config = parseVectorIndexConfig({
      dimension: row.dimension,
      metric: row.metric,
      filterKeys: JSON.parse(stringColumn(row.filter_keys_json, "vector index filter keys")),
    });
    const recordLimit = parseRecordLimit(row.record_limit);
    return { ...scope, config, recordLimit };
  } catch (error) {
    // Persisted configuration is a durable authority.  Any malformed JSON,
    // schema value, or codec rejection is corruption at this boundary, not a
    // caller invalid-spec result and never a raw SyntaxError escape.
    if (error instanceof VectorIndexOperationError) throw error;
    if (error instanceof VectorIndexInvalidSpecError) {
      throw unavailable("vector index configuration is corrupt");
    }
    throw unavailable("vector index configuration is corrupt");
  }
}

function normalizeCreateArgs(
  first: VectorIndexCreateInput | string,
  second?: string,
  third?: VectorIndexConfigInput,
  fourth?: { readonly recordLimit?: number },
): {
  readonly scope: ParsedScope;
  readonly configInput: VectorIndexConfigInput;
  readonly recordLimit: unknown;
  readonly recordLimitProvided: boolean;
} {
  if (typeof first === "string") {
    if (typeof second !== "string" || third === undefined) {
      throw invalidSpec("createIndex requires tenant, Resource UID, and config");
    }
    return {
      scope: normalizeScope(first, second),
      configInput: third,
      recordLimit: fourth?.recordLimit,
      recordLimitProvided: fourth !== undefined && Object.hasOwn(fourth, "recordLimit"),
    };
  }
  const scope = normalizeScope(first);
  const config: VectorIndexConfigInput =
    first.config ??
    ({
      dimension: first.dimension,
      metric: first.metric,
      ...(first.filterKeys === undefined ? {} : { filterKeys: first.filterKeys }),
    } as VectorIndexConfigInput);
  return {
    scope,
    configInput: config,
    recordLimit: first.recordLimit,
    recordLimitProvided: Object.hasOwn(first, "recordLimit"),
  };
}

function normalizeOperationArgs(
  first: VectorIndexScope | string,
  second?: string | unknown,
  third?: unknown,
): { readonly scope: ParsedScope; readonly input: unknown } {
  if (typeof first === "string") {
    if (typeof second !== "string") throw invalidSpec("operation requires a Resource UID");
    return { scope: normalizeScope(first, second), input: third };
  }
  const scope = normalizeScope(first);
  if (Object.hasOwn(first, "input")) {
    return { scope, input: (first as VectorIndexScope & { readonly input?: unknown }).input };
  }
  if (second !== undefined) return { scope, input: second };
  // A flat object form is accepted as a convenience for adapters that already
  // have scope fields next to the operation body.  The public wire object fed
  // into the codec remains closed after these two scope members are removed.
  const body: Record<string, unknown> = { ...(first as unknown as Record<string, unknown>) };
  delete body.tenantId;
  delete body.resourceUid;
  return { scope, input: body };
}

function normalizeScope(first: VectorIndexScope | string, second?: string): ParsedScope {
  const tenantId = typeof first === "string" ? first : first.tenantId;
  const resourceUid = typeof first === "string" ? second : first.resourceUid;
  if (
    typeof tenantId !== "string" ||
    typeof resourceUid !== "string" ||
    !boundedCodePointString(tenantId, 1, MAX_TENANT_LENGTH) ||
    !boundedCodePointString(resourceUid, 3, MAX_RESOURCE_UID_LENGTH) ||
    tenantId.includes("\u0000") ||
    resourceUid.includes("\u0000")
  ) {
    throw invalidSpec("tenantId and resourceUid are invalid");
  }
  return { tenantId, resourceUid };
}

function boundedCodePointString(value: string, minimum: number, maximum: number): boolean {
  const length = [...value].length;
  return length >= minimum && length <= maximum;
}

function parseRecordLimit(value: unknown): number {
  const limit = value === undefined ? DEFAULT_RECORD_LIMIT : value;
  if (
    typeof limit !== "number" ||
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > MAX_RECORD_LIMIT
  ) {
    throw invalidSpec("recordLimit must be an integer from 1 through 1000");
  }
  return limit;
}

function sameConfig(left: VectorIndexConfig, right: VectorIndexConfig): boolean {
  return (
    left.dimension === right.dimension &&
    left.metric === right.metric &&
    JSON.stringify(left.filterKeys) === JSON.stringify(right.filterKeys)
  );
}

function safeInteger(value: unknown, path: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw unavailable(`${path} is invalid`);
  return number;
}

function chunks<T>(values: readonly T[], size: number): readonly (readonly T[])[] {
  const result: (readonly T[])[] = [];
  for (let index = 0; index < values.length; index += size)
    result.push(values.slice(index, index + size));
  return result;
}

function invalidSpec(message: string): VectorIndexInvalidSpecError {
  return new VectorIndexInvalidSpecError(message);
}

function unavailable(message: string): VectorIndexOperationError {
  return new VectorIndexOperationError("unavailable", message);
}

function mapStorageError(error: unknown): VectorIndexOperationError {
  if (error instanceof VectorIndexOperationError) return error;
  if (error instanceof VectorIndexStoreError) {
    return new VectorIndexOperationError(error.code, error.message);
  }
  const message = error instanceof Error ? error.message : String(error);
  if (/vector_index_record_quota/iu.test(message)) {
    return new VectorIndexOperationError("quota", "vector index record quota exceeded");
  }
  return new VectorIndexOperationError("unavailable", message);
}

function isSql(value: unknown): value is Sql {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Sql).query === "function" &&
    typeof (value as Sql).run === "function" &&
    typeof (value as Sql).batch === "function"
  );
}

/** Min-heap whose root is the worst retained candidate. */
class TopKHeap {
  readonly #limit: number;
  readonly #items: Candidate[] = [];

  constructor(limit: number) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_TOP_K) {
      throw invalidSpec("topK must be an integer from 1 through 100");
    }
    this.#limit = limit;
  }

  consider(candidate: Candidate): void {
    if (this.#items.length < this.#limit) {
      this.#items.push(candidate);
      this.siftUp(this.#items.length - 1);
      return;
    }
    const root = this.#items[0];
    if (!root || !isBetter(candidate, root)) return;
    this.#items[0] = candidate;
    this.siftDown(0);
  }

  values(): readonly Candidate[] {
    return [...this.#items].sort((left, right) => (isBetter(left, right) ? -1 : 1));
  }

  private siftUp(start: number): void {
    let index = start;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      const current = this.#items[index];
      const parentItem = this.#items[parent];
      if (!current || !parentItem || !isWorse(current, parentItem)) break;
      this.#items[index] = parentItem;
      this.#items[parent] = current;
      index = parent;
    }
  }

  private siftDown(start: number): void {
    let index = start;
    for (;;) {
      const left = index * 2 + 1;
      const right = left + 1;
      let worst = index;
      if (
        left < this.#items.length &&
        isWorse(this.#items[left] as Candidate, this.#items[worst] as Candidate)
      ) {
        worst = left;
      }
      if (
        right < this.#items.length &&
        isWorse(this.#items[right] as Candidate, this.#items[worst] as Candidate)
      ) {
        worst = right;
      }
      if (worst === index) return;
      const current = this.#items[index] as Candidate;
      this.#items[index] = this.#items[worst] as Candidate;
      this.#items[worst] = current;
      index = worst;
    }
  }
}

function isBetter(left: Candidate, right: Candidate): boolean {
  if (left.score !== right.score) return left.score > right.score;
  return left.id < right.id;
}

function compareCandidates(left: Candidate, right: Candidate): number {
  if (isBetter(left, right)) return -1;
  if (isBetter(right, left)) return 1;
  return 0;
}

function isWorse(left: Candidate, right: Candidate): boolean {
  if (left.score !== right.score) return left.score < right.score;
  return left.id > right.id;
}
