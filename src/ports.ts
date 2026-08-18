/**
 * The seams between Takoserver and the world it runs on.
 *
 * Everything the product needs from a host — durable rows, durable bytes,
 * provider lifecycles, AI upstreams — arrives through one of these. Nothing
 * here knows about Cloudflare, Bun, or any vendor; the implementations under
 * `sql-*.ts`, `objects-*.ts`, and `providers/` do, and they are the only files
 * that may.
 */

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type JsonObject = { readonly [key: string]: JsonValue };

export type SqlParam = string | number | null | ArrayBuffer;

export type Row = Record<string, unknown>;

export interface SqlStatement {
  readonly sql: string;
  readonly params?: readonly SqlParam[];
}

export interface SqlWrite {
  readonly rows: readonly Row[];
  /** Rows the statement actually changed. Guards are read from this. */
  readonly changes: number;
}

/**
 * The single storage seam.
 *
 * There is deliberately no interactive transaction. D1 cannot offer one, and an
 * abstraction that pretends otherwise would be a lie that only shows up in
 * production. Atomicity is expressed three honest ways instead:
 *
 * - a single statement whose `WHERE` carries its own precondition, checked
 *   afterwards through {@link SqlWrite.changes};
 * - a {@link Sql.batch}, which commits all-or-nothing — its statements may not
 *   depend on each other's results, because they are all sent at once;
 * - a claim: take ownership of a row with a guarded `UPDATE`, do the slow or
 *   external work outside any transaction, then settle with a guarded batch.
 */
export interface Sql {
  query(sql: string, params?: readonly SqlParam[]): Promise<readonly Row[]>;
  run(sql: string, params?: readonly SqlParam[]): Promise<SqlWrite>;
  /** Commits all statements or none, in order. */
  batch(statements: readonly SqlStatement[]): Promise<readonly SqlWrite[]>;
}

export class SqlError extends Error {
  constructor(
    readonly code: "unavailable" | "constraint" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "SqlError";
  }
}

export interface StoredObject {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly contentType?: string;
}

export interface StoredObjectBody extends StoredObject {
  readonly body: ReadableStream<Uint8Array>;
}

export interface ObjectListPage {
  readonly objects: readonly StoredObject[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

/**
 * The bytes seam. Artifacts live under `art/`, resource data planes under
 * `res/`; both are content- or tenant-addressed by their callers, never by the
 * implementation.
 */
export interface ObjectStore {
  put(
    key: string,
    body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
    options?: { readonly contentType?: string },
  ): Promise<StoredObject>;
  get(key: string): Promise<StoredObjectBody | null>;
  head(key: string): Promise<StoredObject | null>;
  delete(key: string): Promise<boolean>;
  list(input: {
    readonly prefix: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<ObjectListPage>;
}

export class ObjectStoreError extends Error {
  constructor(
    readonly code: "unavailable" | "too_large" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "ObjectStoreError";
  }
}

/** Wall clock, injected so tests and replay logic never read the ambient one. */
export type Clock = () => Date;
