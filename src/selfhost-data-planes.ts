import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue, Row, Sql, SqlParam } from "./ports.ts";
import {
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
} from "./providers/selfhost-worker-wrapper.ts";

/**
 * What a self-hosted Worker's KV and SQL bindings actually talk to.
 *
 * A managed Cloudflare Worker gets a KV namespace and a SQLite Durable Object
 * because Cloudflare runs them. A machine standing on its own has to be both
 * the platform and the backend, so these two small HTTP services are the
 * backend half: the generated entrypoint holds the exact `edge.kv@1.0.0` and
 * `edge.sql@1.0.0` facades and turns every call into one request here.
 *
 * The Worker addresses a binding by *name*, never by the namespace id or the
 * database this Host resolved it to. That is the whole authorization model and
 * it is worth stating plainly: a token names one Worker Version, the Version's
 * own record names which namespaces and databases that Version declared, and a
 * name the record does not carry is answered `backend_unavailable` rather than
 * resolved. A Worker cannot reach another tenant's data by guessing an id
 * because ids are not something it is ever given.
 *
 * The token is compared in constant time and never appears in a response, a
 * log line, or an error. A wrong one is answered exactly like a missing one.
 */

/** The one path prefix these planes answer under. */
export const SELFHOST_DATA_PLANE_PATHS = [
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_SQL_PATH,
] as const;

/** What one running Worker Version is allowed to reach. */
export interface SelfhostDataPlaneGrant {
  /** The plane half of this version's bearer token. */
  readonly secret: string;
  /** Public binding name to the namespace id this Host derived. */
  readonly kv: Readonly<Record<string, string>>;
  /** Public binding name to the SQLite database name this Host derived. */
  readonly sql: Readonly<Record<string, string>>;
}

export interface SelfhostDataPlaneOptions {
  /** Control storage; the KV entries live here under migration 0038. */
  readonly sql: Sql;
  /** Resolves the grant one presented token names, or null if there is none. */
  readonly grant: (
    script: string,
    versionId: string,
  ) => Promise<SelfhostDataPlaneGrant | null | undefined>;
  /** Absolute path of one SQLite database this machine keeps. */
  readonly databasePath: (name: string) => string;
  readonly clock?: () => Date;
}

export type SelfhostDataPlaneRoutes = (request: Request, url: URL) => Promise<Response | null>;

const MAX_REQUEST_BYTES = 40 * 1024 * 1024;
const MAX_KV_KEY_BYTES = 467;
const MAX_KV_VALUE_BYTES = 26_214_400;
const MAX_KV_METADATA_BYTES = 1_024;
const MAX_SQL_BYTES = 100_000;
const MAX_SQL_PARAMETERS = 100;
const MAX_SQL_STATEMENTS = 100;
const MAX_SQL_ROWS = 10_000;
const MAX_SQL_COLUMNS = 100;
const MAX_SQL_VALUE_BYTES = 1_000_000;
const DEFAULT_LIST_LIMIT = 1_000;
const SCRIPT_NAME = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const TOKEN_SECRET = /^[A-Za-z0-9_-]{16,128}$/u;

type PlaneErrorCode =
  | "invalid_key"
  | "invalid_value"
  | "invalid_argument"
  | "invalid_cursor"
  | "value_too_large"
  | "metadata_too_large"
  | "sql_error"
  | "numeric_out_of_range"
  | "busy"
  | "backend_unavailable";

class PlaneError extends Error {
  constructor(readonly code: PlaneErrorCode) {
    super(code);
    this.name = "PlaneError";
  }
}

export function createSelfhostDataPlanes(
  options: SelfhostDataPlaneOptions,
): SelfhostDataPlaneRoutes {
  const now = options.clock ?? (() => new Date());
  const databases = new Map<string, Database>();

  /**
   * One handle per database file, kept open.
   *
   * A Worker's SQL binding is a hot path, and reopening the file per statement
   * would both cost more than the statement and drop the connection-scoped
   * `total_changes()` counter the write count is derived from.
   */
  const database = (name: string): Database => {
    const existing = databases.get(name);
    if (existing) return existing;
    const path = options.databasePath(name);
    let opened: Database;
    try {
      // Nothing creates the database root eagerly — a SQLite database on this
      // Host appears when something writes to it, and this is the something.
      // `0700` because the file underneath is a tenant's whole dataset.
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      opened = new Database(path, { create: true });
      opened.exec("PRAGMA foreign_keys = ON");
    } catch {
      throw new PlaneError("backend_unavailable");
    }
    databases.set(name, opened);
    return opened;
  };

  return async (request, url) => {
    const kv = url.pathname === SELFHOST_DATA_PLANE_KV_PATH;
    const sql = url.pathname === SELFHOST_DATA_PLANE_SQL_PATH;
    if (!kv && !sql) return null;
    if (request.method !== "POST") return refusal("backend_unavailable", 405);

    let body: unknown;
    try {
      const raw = await boundedText(request);
      body = JSON.parse(raw);
    } catch {
      return refusal("backend_unavailable", 400);
    }
    const payload = record(body);
    if (!payload || payload.protocol !== SELFHOST_DATA_PLANE_PROTOCOL) {
      return refusal("backend_unavailable", 400);
    }
    const binding = text(payload.binding, 64);
    const op = text(payload.op, 32);
    if (!binding || !op) return refusal("backend_unavailable", 400);

    const grant = await authorize(request, options.grant);
    if (!grant) return refusal("backend_unavailable", 401);

    try {
      if (kv) {
        const namespace = grant.kv[binding];
        // A name the Version did not declare is not a 403 to be probed: it is
        // simply not a binding this deployment has.
        if (namespace === undefined) return refusal("backend_unavailable", 404);
        return answer(await kvOperation(options.sql, now, namespace, op, payload));
      }
      const name = grant.sql[binding];
      if (name === undefined) return refusal("backend_unavailable", 404);
      return answer(sqlOperation(database(name), op, payload));
    } catch (error) {
      // Nothing but the closed vocabulary crosses this seam. A SQLite message
      // can carry a table name, a column, or a bound value.
      return refusal(error instanceof PlaneError ? error.code : "backend_unavailable", 200);
    }
  };
}

/**
 * The token names the Worker Version it was minted for.
 *
 * Carrying the identity in the token rather than looking the secret up across
 * every version is what keeps this a single record read; the identity halves
 * are not secret, and the third is compared in constant time against the
 * record's own.
 */
async function authorize(
  request: Request,
  lookup: SelfhostDataPlaneOptions["grant"],
): Promise<SelfhostDataPlaneGrant | null> {
  const header = request.headers.get("authorization");
  if (!header || !header.startsWith("Bearer ") || header.length > 512) return null;
  const parts = header.slice("Bearer ".length).split(".");
  const [script, versionId, secret] = parts;
  if (
    parts.length !== 3 ||
    !script ||
    !versionId ||
    !secret ||
    !SCRIPT_NAME.test(script) ||
    !VERSION_ID.test(versionId) ||
    !TOKEN_SECRET.test(secret)
  ) {
    return null;
  }
  let grant: SelfhostDataPlaneGrant | null | undefined;
  try {
    grant = await lookup(script, versionId);
  } catch {
    return null;
  }
  if (!grant || !constantTimeEqual(grant.secret, secret)) return null;
  return grant;
}

function constantTimeEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

async function boundedText(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^\d+$/u.test(declared) || Number(declared) > MAX_REQUEST_BYTES)) {
    throw new PlaneError("backend_unavailable");
  }
  const raw = await request.text();
  if (raw.length > MAX_REQUEST_BYTES) throw new PlaneError("backend_unavailable");
  return raw;
}

// ---------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------

async function kvOperation(
  sql: Sql,
  clock: () => Date,
  namespace: string,
  op: string,
  payload: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const millis = clock().getTime();
  switch (op) {
    case "get":
    case "getWithMetadata": {
      const key = kvKey(payload.key);
      const rows = await sql.query(
        "SELECT value, metadata_json, expires_at_ms FROM selfhost_kv_entries " +
          "WHERE namespace_id = ? AND key = ?",
        [namespace, key],
      );
      const found = rows[0];
      if (!found) return { found: false };
      const expiry = found.expires_at_ms;
      if (typeof expiry === "number" && expiry <= millis) {
        // Reading an expired entry is what proves it is gone, so this is where
        // the row is reclaimed. A sweeper would only find it later.
        await sql
          .run("DELETE FROM selfhost_kv_entries WHERE namespace_id = ? AND key = ?", [
            namespace,
            key,
          ])
          .catch(() => undefined);
        return { found: false };
      }
      const result: Record<string, unknown> = {
        found: true,
        value: encodeBase64(bytesOf(found.value)),
      };
      if (op === "getWithMetadata" && typeof found.metadata_json === "string") {
        const parsed = record(JSON.parse(found.metadata_json));
        if (parsed) result.metadata = parsed;
      }
      return result;
    }

    case "put": {
      const key = kvKey(payload.key);
      const value = decodeBase64(payload.value, MAX_KV_VALUE_BYTES, "value_too_large");
      const metadata = kvMetadata(payload.metadata);
      const ttl = payload.expirationTtlSeconds;
      let expiresAt: number | null = null;
      if (ttl !== undefined) {
        if (!Number.isSafeInteger(ttl) || (ttl as number) < 60 || (ttl as number) > 315_360_000) {
          throw new PlaneError("invalid_value");
        }
        expiresAt = millis + (ttl as number) * 1_000;
      }
      await sql.run(
        "INSERT INTO selfhost_kv_entries (namespace_id, key, value, metadata_json, expires_at_ms) " +
          "VALUES (?, ?, ?, ?, ?) ON CONFLICT (namespace_id, key) DO UPDATE SET " +
          "value = excluded.value, metadata_json = excluded.metadata_json, " +
          "expires_at_ms = excluded.expires_at_ms",
        [namespace, key, bufferOf(value), metadata, expiresAt],
      );
      return {};
    }

    case "delete": {
      await sql.run("DELETE FROM selfhost_kv_entries WHERE namespace_id = ? AND key = ?", [
        namespace,
        kvKey(payload.key),
      ]);
      return {};
    }

    case "list": {
      const prefix = payload.prefix === undefined ? "" : kvKey(payload.prefix, true);
      const limit = kvLimit(payload.limit);
      const after = kvCursor(payload.cursor);
      // One row past the limit is what says whether the listing is complete,
      // without a second count over the same range.
      const rows = await sql.query(
        "SELECT key FROM selfhost_kv_entries WHERE namespace_id = ? AND key > ? " +
          "AND (? = '' OR (key >= ? AND key < ?)) " +
          "AND (expires_at_ms IS NULL OR expires_at_ms > ?) ORDER BY key LIMIT ?",
        [namespace, after, prefix, prefix, prefixCeiling(prefix), millis, limit + 1],
      );
      const page = rows.slice(0, limit);
      const listComplete = rows.length <= limit;
      const last = page[page.length - 1];
      const result: Record<string, unknown> = {
        keys: page.map((row) => ({ name: String(row.key) })),
        listComplete,
      };
      if (!listComplete && last) result.cursor = encodeCursor(String(last.key));
      return result;
    }

    default:
      throw new PlaneError("backend_unavailable");
  }
}

function kvKey(value: unknown, allowEmpty = false): string {
  if (typeof value !== "string") throw new PlaneError("invalid_key");
  const size = new TextEncoder().encode(value).byteLength;
  if (size > MAX_KV_KEY_BYTES || (!allowEmpty && size === 0)) throw new PlaneError("invalid_key");
  return value;
}

function kvLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_LIST_LIMIT;
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000) {
    throw new PlaneError("invalid_argument");
  }
  return value as number;
}

function kvCursor(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new PlaneError("invalid_cursor");
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(
      decodeBase64Url(value, MAX_KV_KEY_BYTES),
    );
  } catch {
    throw new PlaneError("invalid_cursor");
  }
  return decoded;
}

function encodeCursor(key: string): string {
  return encodeBase64(new TextEncoder().encode(key))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

/**
 * The exclusive upper bound of a prefix range.
 *
 * Comparing on `key LIKE prefix || '%'` would make the prefix a pattern, so a
 * key containing `%` or `_` would list somebody else's keys. A range does not
 * have that problem, and it uses the primary key.
 */
function prefixCeiling(prefix: string): string {
  if (prefix === "") return "";
  const code = prefix.codePointAt(prefix.length - 1) ?? 0;
  return `${prefix.slice(0, -1)}${String.fromCodePoint(code + 1)}`;
}

function kvMetadata(value: unknown): string | null {
  if (value === undefined) return null;
  const metadata = record(value);
  if (!metadata) throw new PlaneError("invalid_value");
  const entries = Object.entries(metadata).sort(([left], [right]) => (left < right ? -1 : 1));
  if (entries.length > 64) throw new PlaneError("metadata_too_large");
  const projected: Record<string, string> = {};
  for (const [name, item] of entries) {
    if (name.length > 256 || typeof item !== "string" || item.length > 8_192) {
      throw new PlaneError("metadata_too_large");
    }
    projected[name] = item;
  }
  const encoded = JSON.stringify(projected);
  if (new TextEncoder().encode(encoded).byteLength > MAX_KV_METADATA_BYTES) {
    throw new PlaneError("metadata_too_large");
  }
  return encoded;
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

interface PlaneStatement {
  readonly sql: string;
  readonly params: readonly (string | number | null | Uint8Array)[];
}

function sqlOperation(
  database: Database,
  op: string,
  payload: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  switch (op) {
    case "execute":
    case "query":
      return executeStatement(database, planeStatement(payload.statement));

    case "transaction": {
      const declared = payload.statements;
      if (!Array.isArray(declared) || declared.length < 1 || declared.length > MAX_SQL_STATEMENTS) {
        throw new PlaneError("sql_error");
      }
      const statements = declared.map(planeStatement);
      // All or none, exactly as `createSqliteSql` does it and exactly what D1's
      // implicit batch transaction gives: a caller that used a batch to keep
      // two rows in step must not get one of them.
      exec(database, "BEGIN IMMEDIATE");
      try {
        const results = statements.map((statement) => executeStatement(database, statement));
        exec(database, "COMMIT");
        return { results };
      } catch (error) {
        exec(database, "ROLLBACK");
        throw error instanceof PlaneError ? error : sqlFailure(error);
      }
    }

    default:
      throw new PlaneError("backend_unavailable");
  }
}

function exec(database: Database, statement: string): void {
  try {
    database.exec(statement);
  } catch (error) {
    throw sqlFailure(error);
  }
}

/**
 * One statement, with the row count the facade reports.
 *
 * The count is a `total_changes()` delta rather than `changes()`, because
 * `changes()` is the last *modifying* statement's count and a `SELECT` does not
 * reset it — a read run after a write would otherwise report the write's rows
 * and the facade's `query` would refuse its own answer.
 */
function executeStatement(database: Database, statement: PlaneStatement): Record<string, unknown> {
  const before = totalChanges(database);
  let rows: Row[];
  try {
    rows = database.query(statement.sql).all(...statement.params) as Row[];
  } catch (error) {
    throw sqlFailure(error);
  }
  const rowsWritten = totalChanges(database) - before;
  if (rows.length > MAX_SQL_ROWS) throw new PlaneError("sql_error");
  return {
    rows: rows.map((row) => {
      const keys = Object.keys(row);
      if (keys.length > MAX_SQL_COLUMNS) throw new PlaneError("sql_error");
      const projected: Record<string, JsonValue> = {};
      for (const key of keys) projected[key] = wireValue(row[key]);
      return projected;
    }),
    rowsWritten: rowsWritten < 0 ? 0 : rowsWritten,
  };
}

function totalChanges(database: Database): number {
  const row = database.query("SELECT total_changes() AS total").get() as { total?: unknown } | null;
  return typeof row?.total === "number" && Number.isSafeInteger(row.total) ? row.total : 0;
}

function planeStatement(value: unknown): PlaneStatement {
  const statement = record(value);
  const sql = statement?.sql;
  if (typeof sql !== "string" || new TextEncoder().encode(sql).byteLength > MAX_SQL_BYTES) {
    throw new PlaneError("sql_error");
  }
  const declared = statement?.params;
  if (declared === undefined) return { sql, params: [] };
  if (!Array.isArray(declared) || declared.length > MAX_SQL_PARAMETERS) {
    throw new PlaneError("sql_error");
  }
  return { sql, params: declared.map(boundValue) };
}

function boundValue(value: unknown): string | number | null | Uint8Array {
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new PlaneError("numeric_out_of_range");
    }
    return value;
  }
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_SQL_VALUE_BYTES) {
      throw new PlaneError("sql_error");
    }
    return value;
  }
  const encoded = record(value);
  if (encoded?.encoding === "base64" && typeof encoded.data === "string") {
    return decodeBase64(encoded.data, MAX_SQL_VALUE_BYTES, "sql_error");
  }
  throw new PlaneError("sql_error");
}

/** SQLite's own types, carried in exactly the shapes the facade accepts. */
function wireValue(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") {
    if (new TextEncoder().encode(value).byteLength > MAX_SQL_VALUE_BYTES) {
      throw new PlaneError("sql_error");
    }
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER) {
      throw new PlaneError("numeric_out_of_range");
    }
    return value;
  }
  if (typeof value === "bigint") {
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < -BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new PlaneError("numeric_out_of_range");
    }
    return Number(value);
  }
  if (value instanceof Uint8Array || value instanceof ArrayBuffer) {
    const bytes = bytesOf(value);
    if (bytes.byteLength > MAX_SQL_VALUE_BYTES) throw new PlaneError("sql_error");
    return { encoding: "base64", data: encodeBase64(bytes) };
  }
  throw new PlaneError("sql_error");
}

function sqlFailure(error: unknown): PlaneError {
  const message = error instanceof Error ? error.message : String(error);
  if (/database is locked|busy/iu.test(message)) return new PlaneError("busy");
  return new PlaneError("sql_error");
}

// ---------------------------------------------------------------------------
// Wire helpers
// ---------------------------------------------------------------------------

function answer(value: Record<string, unknown>): Response {
  return Response.json({ ok: true, value }, { status: 200 });
}

function refusal(code: PlaneErrorCode, status: number): Response {
  return Response.json({ ok: false, error: { code } }, { status });
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function text(value: unknown, maximum: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= maximum ? value : null;
}

function bytesOf(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (typeof value === "string") return new TextEncoder().encode(value);
  throw new PlaneError("backend_unavailable");
}

function bufferOf(bytes: Uint8Array): SqlParam {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  return buffer;
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.byteLength; offset += 4_096) {
    const chunk = bytes.subarray(offset, Math.min(offset + 4_096, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function decodeBase64(value: unknown, maximum: number, tooLarge: PlaneErrorCode): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)
  ) {
    throw new PlaneError("invalid_value");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new PlaneError("invalid_value");
  }
  if (binary.length > maximum) throw new PlaneError(tooLarge);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function decodeBase64Url(value: string, maximum: number): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  return decodeBase64(
    padded + "=".repeat((4 - (padded.length % 4)) % 4),
    maximum,
    "invalid_cursor",
  );
}
