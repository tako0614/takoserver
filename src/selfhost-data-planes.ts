import { Database } from "bun:sqlite";
import { Buffer } from "node:buffer";
import { chmodSync, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import type { JsonValue, Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import type { SelfhostDataPlaneMaintenance, SelfhostGrantedQueue } from "./providers/selfhost.ts";
import {
  MAX_SELFHOST_QUEUE_DELAY_SECONDS,
  MAX_SELFHOST_QUEUE_MESSAGE_BYTES,
  MAX_SELFHOST_QUEUE_MESSAGES,
} from "./providers/selfhost-events.ts";
import {
  MAX_SELFHOST_OBJECT_DOCUMENT_BYTES,
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
  SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER,
  SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER,
  SELFHOST_DATA_PLANE_OBJECTS_PATH,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_QUEUE_PATH,
  SELFHOST_DATA_PLANE_SQL_PATH,
} from "./providers/selfhost-worker-wrapper.ts";
import {
  createSelfhostObjectStore,
  prefixCeiling,
  SELFHOST_OBJECT_RECONCILE_BATCH,
  SelfhostObjectError,
  type SelfhostObjectStore,
} from "./selfhost-object-store.ts";

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
 *
 * These planes are served on a listener of their own, bound to `127.0.0.1`, and
 * never on the public one. The token is a bearer credential and the public
 * origin is on the internet: mounting a route that accepts it there makes it an
 * internet-facing credential for arbitrary SQL, whatever the comment above the
 * route says about loopback. The workerd `externalServer` in front points at
 * this listener, so the traffic that should reach it still does and nothing
 * else can.
 *
 * The SQL half executes what a tenant writes, so it decides what a statement is
 * allowed to be before it prepares one. `ATTACH` is the reason: SQLite will
 * happily open a second file, and every other tenant's database — and this
 * Host's own control database — is a path away. The gate is a parse rather than
 * a pattern, because a bound parameter, a comment, and a quoted identifier are
 * all ways of writing the same statement.
 */

/** The one path prefix these planes answer under. */
export const SELFHOST_DATA_PLANE_PATHS = [
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_OBJECTS_PATH,
  SELFHOST_DATA_PLANE_QUEUE_PATH,
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
  /** Public binding name to the queue, with the promise that queue makes. */
  readonly queue: Readonly<Record<string, SelfhostGrantedQueue>>;
  /** Public binding name to the bucket incarnation this Host derived. */
  readonly objects: Readonly<Record<string, string>>;
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
  /** Directory holding one subdirectory per bucket incarnation. */
  readonly objectRoot: string;
  readonly clock?: () => Date;
  /** The acceptance identity of one message; injected so a test can name them. */
  readonly messageId?: () => string;
}

export type SelfhostDataPlaneRoutes = (request: Request, url: URL) => Promise<Response | null>;

/** The planes plus the housekeeping the rest of this machine drives them with. */
export interface SelfhostDataPlanes {
  readonly routes: SelfhostDataPlaneRoutes;
  readonly maintenance: SelfhostDataPlaneMaintenance;
}

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
/** The managed Durable Object's own ceilings, enforced here for the same reason. */
const MAX_SQL_ROW_BYTES = 2_000_000;
const MAX_SQL_RESULT_BYTES = 8_388_608;
const DEFAULT_LIST_LIMIT = 1_000;
/**
 * How long a statement waits for a lock before it is `busy`.
 *
 * Two handles are open on a tenant's database at once whenever the Takoform
 * migration ledger is read or applied, and SQLite's default is to fail
 * immediately rather than wait. A Worker seeing `busy` because a migration was
 * mid-flight is a failure the operator cannot act on and the tenant cannot see
 * the cause of.
 */
const SQLITE_BUSY_TIMEOUT_MS = 5_000;
/** Rows one maintenance pass reclaims, so a sweep never becomes the workload. */
const KV_SWEEP_BATCH = 1_000;
/** Abandoned uploads one pass reclaims; each one is a directory to remove. */
const UPLOAD_SWEEP_BATCH = 64;
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
  | "invalid_body"
  | "message_too_large"
  | "batch_too_large"
  | "backend_unavailable";

class PlaneError extends Error {
  constructor(readonly code: PlaneErrorCode) {
    super(code);
    this.name = "PlaneError";
  }
}

export function createSelfhostDataPlanes(options: SelfhostDataPlaneOptions): SelfhostDataPlanes {
  const now = options.clock ?? (() => new Date());
  const messageId = options.messageId ?? (() => crypto.randomUUID());
  const databases = new Map<string, Database>();
  const objectStore = createSelfhostObjectStore({
    sql: options.sql,
    root: options.objectRoot,
    ...(options.clock ? { clock: options.clock } : {}),
  });

  /**
   * One handle per database file, kept open.
   *
   * A Worker's SQL binding is a hot path, and reopening the file per statement
   * would both cost more than the statement and drop the connection-scoped
   * `total_changes()` counter the write count is derived from. A handle is only
   * safe to keep while the file it names is the file the Host means, so
   * `forgetDatabase` is what a Resource lifecycle calls when that stops being
   * true.
   */
  const database = (name: string): Database => {
    const existing = databases.get(name);
    if (existing) return existing;
    const path = options.databasePath(name);
    let opened: Database | undefined;
    try {
      // Nothing creates the database root eagerly — a SQLite database on this
      // Host appears when something writes to it, and this is the something.
      // The directory holds tenants' whole datasets, so it is tightened and
      // then re-read rather than created hopefully: `mkdir(mode)` does nothing
      // to a directory an earlier build or an operator's `mkdir -p` made.
      privateDirectory(dirname(path));
      opened = new Database(path, { create: true });
      // `create: true` makes a `0644` file. The bytes under it are one
      // tenant's, so the mode is corrected and then proved.
      chmodSync(path, 0o600);
      if ((statSync(path).mode & 0o077) !== 0) {
        throw new Error("refusing to open a group- or world-accessible database");
      }
      opened.exec(`PRAGMA busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
      opened.exec("PRAGMA foreign_keys = ON");
    } catch {
      try {
        opened?.close();
      } catch {}
      throw new PlaneError("backend_unavailable");
    }
    databases.set(name, opened);
    return opened;
  };

  const routes: SelfhostDataPlaneRoutes = async (request, url) => {
    if (url.pathname === SELFHOST_DATA_PLANE_OBJECTS_PATH) {
      if (request.method !== "POST") return objectRefusal("backend_unavailable", 405);
      const grant = await authorize(request, options.grant);
      if (!grant) return objectRefusal("backend_unavailable", 401);
      try {
        const document = parseObjectDocument(
          request.headers.get(SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER),
        );
        // `hasOwn`, not a truthiness test, for the reason the other planes give:
        // `__proto__` is a property of every ordinary object, and a binding name
        // no record carried must never resolve to a bucket.
        if (!Object.hasOwn(grant.objects, document.binding)) {
          return objectRefusal("backend_unavailable", 404);
        }
        return await objectOperation(
          objectStore,
          grant.objects[document.binding] as string,
          document,
          request,
        );
      } catch (error) {
        return objectRefusal(
          error instanceof SelfhostObjectError ? error.code : "backend_unavailable",
          200,
        );
      }
    }
    const kv = url.pathname === SELFHOST_DATA_PLANE_KV_PATH;
    const sql = url.pathname === SELFHOST_DATA_PLANE_SQL_PATH;
    const queue = url.pathname === SELFHOST_DATA_PLANE_QUEUE_PATH;
    if (!kv && !sql && !queue) return null;
    if (request.method !== "POST") return refusal("backend_unavailable", 405);

    // Before the body, deliberately. Reading and parsing up to the request
    // ceiling for a caller that turns out to hold no token is work an
    // unauthenticated caller chose for this process; the header is enough to
    // decide, and it costs one record read.
    const grant = await authorize(request, options.grant);
    if (!grant) return refusal("backend_unavailable", 401);

    let body: unknown;
    try {
      body = JSON.parse(await boundedText(request));
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

    try {
      if (kv) {
        // `hasOwn`, not a truthiness test: `__proto__` and `constructor` are
        // properties of every ordinary object, so a lookup that walks the
        // prototype chain answers binding names no record ever carried — and
        // answers them the same way for every tenant on the machine.
        if (!Object.hasOwn(grant.kv, binding)) return refusal("backend_unavailable", 404);
        const namespace = grant.kv[binding] as string;
        return answer(await kvOperation(options.sql, now, namespace, op, payload));
      }
      if (queue) {
        if (!Object.hasOwn(grant.queue, binding)) return refusal("backend_unavailable", 404);
        const target = grant.queue[binding] as SelfhostGrantedQueue;
        return answer(await queueOperation(options.sql, now, target, op, payload, messageId));
      }
      if (!Object.hasOwn(grant.sql, binding)) return refusal("backend_unavailable", 404);
      const name = grant.sql[binding] as string;
      return answer(sqlOperation(database(name), op, payload));
    } catch (error) {
      // Nothing but the closed vocabulary crosses this seam. A SQLite message
      // can carry a table name, a column, or a bound value.
      return refusal(error instanceof PlaneError ? error.code : "backend_unavailable", 200);
    }
  };

  const maintenance: SelfhostDataPlaneMaintenance = {
    async deleteKvNamespace(namespaceId) {
      // A namespace id is derived from the Resource's own uid, so this can
      // never reach a live namespace's rows: the id a recreated namespace gets
      // is a different one.
      await options.sql.run("DELETE FROM selfhost_kv_entries WHERE namespace_id = ?", [
        namespaceId,
      ]);
    },

    async deleteQueue(queueId) {
      // The stored messages are this plane's rows, exactly as a namespace's
      // entries are, so dropping them belongs to the same housekeeping seam.
      // It is deliberately not the pump's: a queue stops existing whether or
      // not this machine happens to be running one.
      await options.sql.run("DELETE FROM selfhost_queue_messages WHERE queue_id = ?", [queueId]);
    },

    forgetDatabase(name) {
      const opened = databases.get(name);
      if (!opened) return;
      databases.delete(name);
      try {
        opened.close();
      } catch {}
    },

    async objectBucketOccupancy(bucketId) {
      return await objectStore.occupancy(bucketId);
    },

    async deleteObjectBucket(bucketId) {
      // The bytes go with the bucket, for the same reason a namespace's rows do:
      // a bucket id is derived from the Resource incarnation, so this can never
      // reach a live bucket's objects.
      await objectStore.destroy(bucketId);
    },

    async sweepExpiredObjectUploads(limit = UPLOAD_SWEEP_BATCH) {
      // Bounded for the same reason the KV sweep is: this runs on the
      // settlement tick, and a machine that accumulated ten thousand abandoned
      // uploads must not become that tick.
      return await objectStore.sweepExpiredUploads({
        limit: Math.max(1, Math.min(limit, UPLOAD_SWEEP_BATCH)),
      });
    },

    async reconcileOrphanObjectFiles(limit = SELFHOST_OBJECT_RECONCILE_BATCH) {
      const swept = await objectStore.reconcileOrphanFiles({
        limit: Math.max(1, Math.min(limit, SELFHOST_OBJECT_RECONCILE_BATCH)),
      });
      return swept.reclaimed;
    },

    async sweepExpiredKv(limit = KV_SWEEP_BATCH) {
      // Bounded, because this runs on the same tick as settlement and a
      // namespace with a million dead rows must not become that tick.
      const rows = await options.sql.query(
        "SELECT namespace_id, key FROM selfhost_kv_entries " +
          "WHERE expires_at_ms IS NOT NULL AND expires_at_ms <= ? LIMIT ?",
        [now().getTime(), Math.max(1, Math.min(limit, KV_SWEEP_BATCH))],
      );
      for (const row of rows) {
        await options.sql.run(
          "DELETE FROM selfhost_kv_entries WHERE namespace_id = ? AND key = ?",
          [String(row.namespace_id), String(row.key)],
        );
      }
      return rows.length;
    },
  };

  return { routes, maintenance };
}

/**
 * The planes on a listener of their own.
 *
 * `127.0.0.1` is the whole point: what authenticates here is a bearer token
 * minted per Worker Version, and the only thing that should ever present one is
 * a workerd service on this machine. A port of `0` asks the kernel for a free
 * one, which the caller then records and writes into the generated
 * `externalServer` — no configuration, no collision, and nothing published.
 */
export function serveSelfhostDataPlanes(
  options: SelfhostDataPlaneOptions & { readonly port?: number },
): {
  readonly address: string;
  readonly port: number;
  readonly maintenance: SelfhostDataPlaneMaintenance;
  stop(closeActive?: boolean): void;
} {
  const planes = createSelfhostDataPlanes(options);
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url);
      return (
        (await planes.routes(request, url)) ??
        new Response("not a data plane request\n", { status: 404 })
      );
    },
  });
  return {
    address: `127.0.0.1:${server.port}`,
    port: Number(server.port),
    maintenance: planes.maintenance,
    stop: (closeActive) => server.stop(closeActive),
  };
}

/**
 * A directory this process is willing to keep a tenant's dataset in.
 *
 * `mkdir(mode)` does nothing to a directory that already exists, so a
 * `databases/` made by an earlier build — or by an operator's `mkdir -p` — keeps
 * whatever mode it was made with. The mode is therefore tightened and re-read,
 * exactly as the workerd runtime does for the directories holding its rendered
 * bindings.
 */
function privateDirectory(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  try {
    chmodSync(path, 0o700);
  } catch {}
  if ((statSync(path).mode & 0o077) !== 0) {
    throw new Error(`refusing to open a database under a group- or world-accessible directory`);
  }
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

/**
 * The body, or a refusal before a byte of it is read.
 *
 * A declared length is required rather than merely respected. Without one the
 * only ceiling is the server's own, the caller decides how long this process
 * spends reading, and the check that follows happens after the bytes have
 * already crossed. Everything that legitimately reaches this plane is a fixed
 * JSON envelope a workerd service sent, and workerd declares its length.
 */
async function boundedText(request: Request): Promise<string> {
  const declared = request.headers.get("content-length");
  if (declared === null || !/^\d+$/u.test(declared) || Number(declared) > MAX_REQUEST_BYTES) {
    throw new PlaneError("backend_unavailable");
  }
  const raw = await request.text();
  if (utf8Length(raw) > Number(declared)) throw new PlaneError("backend_unavailable");
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
      // The ceiling is absent only when the prefix is made entirely of the last
      // code point there is, and then every key at or above it already carries
      // the prefix — there is nothing above to exclude.
      const ceiling = prefix === "" ? null : prefixCeiling(prefix);
      const rows = await sql.query(
        "SELECT key FROM selfhost_kv_entries WHERE namespace_id = ? AND key > ? " +
          (prefix === "" ? "" : "AND key >= ? ") +
          (ceiling === null ? "" : "AND key < ? ") +
          "AND (expires_at_ms IS NULL OR expires_at_ms > ?) ORDER BY key LIMIT ?",
        [
          namespace,
          after,
          ...(prefix === "" ? [] : [prefix]),
          ...(ceiling === null ? [] : [ceiling]),
          millis,
          limit + 1,
        ],
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
// Queue producer
// ---------------------------------------------------------------------------

/**
 * The accept half of a queue. The pump owns everything after.
 *
 * A message is a row the moment it is accepted, with its whole future already
 * decided: when it first becomes deliverable, and when it stops being worth
 * delivering. Both are absolute instants rather than durations, because a row
 * that outlives a restart must not have its clock restarted with the process.
 */
async function queueOperation(
  sql: Sql,
  clock: () => Date,
  target: SelfhostGrantedQueue,
  op: string,
  payload: Readonly<Record<string, unknown>>,
  mintMessageId: () => string,
): Promise<Record<string, unknown>> {
  const millis = clock().getTime();
  const accept = (body: unknown, delay: unknown): SqlStatement => {
    let bytes: Uint8Array;
    try {
      bytes = decodeBase64(body, MAX_SELFHOST_QUEUE_MESSAGE_BYTES, "message_too_large");
    } catch (error) {
      // The facade's own vocabulary: a body that is not bytes is `invalid_body`
      // here, where a KV value that is not bytes is `invalid_value`.
      throw new PlaneError(
        error instanceof PlaneError && error.code === "message_too_large"
          ? "message_too_large"
          : "invalid_body",
      );
    }
    const delaySeconds = queueDelay(delay, target.deliveryDelaySeconds);
    const id = mintMessageId();
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id)) {
      throw new PlaneError("backend_unavailable");
    }
    return {
      sql:
        "INSERT INTO selfhost_queue_messages " +
        "(queue_id, message_id, body, enqueued_at_ms, visible_at_ms, expires_at_ms, deliveries) " +
        "VALUES (?, ?, ?, ?, ?, ?, 0)",
      params: [
        target.queueId,
        id,
        bufferOf(bytes),
        millis,
        millis + delaySeconds * 1_000,
        millis + target.messageRetentionSeconds * 1_000,
      ],
    };
  };
  switch (op) {
    case "send": {
      const statement = accept(payload.body, payload.delaySeconds);
      const id = String((statement.params as readonly SqlParam[])[1]);
      await sql.run(statement.sql, statement.params);
      return { messageId: id };
    }
    case "sendBatch": {
      const messages = payload.messages;
      if (!Array.isArray(messages) || messages.length < 1) {
        throw new PlaneError("invalid_body");
      }
      if (messages.length > MAX_SELFHOST_QUEUE_MESSAGES) {
        throw new PlaneError("batch_too_large");
      }
      const statements = messages.map((entry) => {
        const message = record(entry);
        if (!message) throw new PlaneError("invalid_body");
        for (const key of Object.keys(message)) {
          if (key !== "body" && key !== "delaySeconds") throw new PlaneError("invalid_body");
        }
        return accept(message.body, message.delaySeconds);
      });
      // All or none: a partially accepted batch is a batch the caller has no
      // way to reason about, and `sendBatch` is the reason this seam has an
      // atomic capability at all.
      await sql.batch(statements);
      return {
        messageIds: statements.map((statement) =>
          String((statement.params as readonly SqlParam[])[1]),
        ),
      };
    }
    default:
      throw new PlaneError("backend_unavailable");
  }
}

/** A delay in seconds, or the queue's own default when none was asked for. */
function queueDelay(value: unknown, fallback: number): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 0 ||
    value > MAX_SELFHOST_QUEUE_DELAY_SECONDS
  ) {
    throw new PlaneError("invalid_argument");
  }
  return value;
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
  // A connection is shared by every request this Version makes, and a
  // transaction left open on it would make every later write invisible to
  // anything else and lost on a restart. Nothing here opens one it does not
  // close, so an open one means a process that died mid-request.
  if (database.inTransaction) rollback(database);
  switch (op) {
    case "execute":
      return executeStatement(database, planeStatement(payload.statement));

    // `query` is a read, and the facade in front of it says so. The managed
    // backend runs it inside a transaction it always rolls back, so a write
    // smuggled through `query` is executed and then undone rather than
    // committed and then complained about. Same here, for the same reason: the
    // two backends must not differ on whether a row survives.
    case "query": {
      const statement = planeStatement(payload.statement);
      exec(database, "BEGIN");
      try {
        const result = executeStatement(database, statement);
        return { rows: result.rows, rowsWritten: 0 };
      } finally {
        rollback(database);
      }
    }

    case "transaction": {
      const declared = payload.statements;
      if (!Array.isArray(declared) || declared.length < 1 || declared.length > MAX_SQL_STATEMENTS) {
        throw new PlaneError("sql_error");
      }
      // Every statement is admitted before any of them runs, so a batch whose
      // last statement is refused never half-executes.
      const statements = declared.map(planeStatement);
      // All or none, exactly as `createSqliteSql` does it and exactly what D1's
      // implicit batch transaction gives: a caller that used a batch to keep
      // two rows in step must not get one of them.
      try {
        exec(database, "BEGIN IMMEDIATE");
      } catch (error) {
        rollback(database);
        throw error;
      }
      try {
        const results = statements.map((statement) => executeStatement(database, statement));
        exec(database, "COMMIT");
        return { results };
      } catch (error) {
        rollback(database);
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
 * Undo whatever is open, without ever replacing the failure that got us here.
 *
 * A rollback that throws is a connection this process no longer understands,
 * and the honest answer to the caller is still the error their statement
 * produced.
 */
function rollback(database: Database): void {
  try {
    if (database.inTransaction) database.exec("ROLLBACK");
  } catch {}
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
  const rows: Record<string, JsonValue>[] = [];
  let resultBytes = 0;
  let prepared: ReturnType<Database["prepare"]>;
  try {
    prepared = database.prepare(statement.sql);
  } catch (error) {
    throw sqlFailure(error);
  }
  try {
    // Row by row, and refused before the next one is read. `.all()` builds the
    // whole answer first, so a recursive CTE the tenant wrote decides how much
    // of this machine's memory it gets — and this is the process serving the
    // control plane and every other tenant. The managed Durable Object bounds
    // the same three things at the same numbers.
    for (const raw of prepared.iterate(...statement.params) as Iterable<Row>) {
      if (rows.length >= MAX_SQL_ROWS) throw new PlaneError("sql_error");
      const keys = Object.keys(raw);
      if (keys.length > MAX_SQL_COLUMNS) throw new PlaneError("sql_error");
      const projected: Record<string, JsonValue> = {};
      for (const key of keys) projected[key] = wireValue(raw[key]);
      const bytes = utf8Length(JSON.stringify(projected));
      if (bytes > MAX_SQL_ROW_BYTES) throw new PlaneError("sql_error");
      resultBytes += bytes;
      if (resultBytes > MAX_SQL_RESULT_BYTES) throw new PlaneError("sql_error");
      rows.push(projected);
    }
  } catch (error) {
    throw error instanceof PlaneError ? error : sqlFailure(error);
  } finally {
    try {
      prepared.finalize();
    } catch {}
  }
  const rowsWritten = totalChanges(database) - before;
  return { rows, rowsWritten: rowsWritten < 0 ? 0 : rowsWritten };
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function totalChanges(database: Database): number {
  const row = database.query("SELECT total_changes() AS total").get() as { total?: unknown } | null;
  return typeof row?.total === "number" && Number.isSafeInteger(row.total) ? row.total : 0;
}

function planeStatement(value: unknown): PlaneStatement {
  const statement = record(value);
  const sql = statement?.sql;
  if (typeof sql !== "string" || utf8Length(sql) > MAX_SQL_BYTES) {
    throw new PlaneError("sql_error");
  }
  admitStatement(sql);
  const declared = statement?.params;
  if (declared === undefined) return { sql, params: [] };
  if (!Array.isArray(declared) || declared.length > MAX_SQL_PARAMETERS) {
    throw new PlaneError("sql_error");
  }
  return { sql, params: declared.map(boundValue) };
}

// ---------------------------------------------------------------------------
// What a statement is allowed to be
// ---------------------------------------------------------------------------

/**
 * Statements this plane never runs, wherever they appear.
 *
 * `ATTACH` is the one that matters: it opens a second database file, and every
 * other tenant's dataset and this Host's own `control.sqlite` are a path away —
 * the name can be a bound parameter, so parameterisation is no defence. The
 * other four are the same shape of problem: `VACUUM INTO` writes a file
 * anywhere this process can write, and `PRAGMA` reaches
 * `writable_schema`, `journal_mode`, and the list of attached files. None of
 * them is a keyword SQLite accepts as a bare identifier, so refusing the word
 * outright cannot break a legitimate statement.
 */
const REFUSED_ANYWHERE = new Set(["attach", "detach", "vacuum", "pragma", "analyze"]);

/**
 * Statements this plane never runs *as a statement*.
 *
 * Transaction control belongs to the plane, not to the caller. A tenant
 * `COMMIT` inside a batch ends the transaction the batch's own guarantee is
 * made of, and a tenant `BEGIN` leaves one open on a connection every later
 * request shares. These words are legal elsewhere — `END` closes a `CASE`,
 * `ROLLBACK` names a conflict resolution — so only the leading one is refused.
 */
const REFUSED_LEADING = new Set([
  "begin",
  "commit",
  "end",
  "rollback",
  "savepoint",
  "release",
  ...REFUSED_ANYWHERE,
]);

/**
 * The prefix the Takoform SQLite migration ledger lives under.
 *
 * On the managed backend that ledger is Durable Object storage and `edge.sql`
 * cannot see it. Here it is a table in the same file the tenant has full write
 * access to, so a tenant could drop it, rewrite it, or add rows to it and make
 * this Host re-apply or skip a migration. Names, quoted or bare, are refused —
 * and so are string literals, because SQLite accepts one where an identifier
 * belongs.
 */
const RESERVED_IDENTIFIER_PREFIX = "_takoform_";

const WORD_START = /[A-Za-z_\u0080-\uffff]/u;
const WORD_PART = /[A-Za-z0-9_$\u0080-\uffff]/u;

/**
 * One statement, and one this plane is willing to run.
 *
 * This is a parse rather than a pattern because every cheap check has a
 * counterexample: a comment hides a keyword, a quoted identifier hides a name,
 * a string literal contains a semicolon. It reads the text once, tracking only
 * what it needs to know which characters are code.
 */
function admitStatement(sql: string): void {
  let index = 0;
  let seenContent = false;
  let terminated = false;
  const words: string[] = [];
  const refuse = (): never => {
    throw new PlaneError("sql_error");
  };
  const content = (): void => {
    // Anything at all after a statement's own `;` is a second statement, and
    // this plane answers one. A batch is what `transaction` is for.
    if (terminated) refuse();
    seenContent = true;
  };
  while (index < sql.length) {
    const character = sql[index] as string;
    if (character === "-" && sql[index + 1] === "-") {
      index += 2;
      while (index < sql.length && sql[index] !== "\n") index += 1;
      continue;
    }
    if (character === "/" && sql[index + 1] === "*") {
      const end = sql.indexOf("*/", index + 2);
      if (end < 0) refuse();
      index = end + 2;
      continue;
    }
    if (character === " " || character === "\t" || character === "\n" || character === "\r") {
      index += 1;
      continue;
    }
    if (character === ";") {
      if (!seenContent || terminated) refuse();
      terminated = true;
      index += 1;
      continue;
    }
    if (character === "'" || character === '"' || character === "`") {
      content();
      const closed = closingQuote(sql, index, character);
      // A literal is refused by content only when it names this Host's own
      // ledger: SQLite will take `DROP TABLE '_takoform_x'` as an identifier.
      if (reserved(sql.slice(index + 1, closed - 1).replaceAll(character + character, character))) {
        refuse();
      }
      index = closed;
      continue;
    }
    if (character === "[") {
      content();
      const closed = sql.indexOf("]", index + 1);
      if (closed < 0) refuse();
      if (reserved(sql.slice(index + 1, closed))) refuse();
      index = closed + 1;
      continue;
    }
    if (WORD_START.test(character)) {
      content();
      let end = index + 1;
      while (end < sql.length && WORD_PART.test(sql[end] as string)) end += 1;
      const word = sql.slice(index, end);
      if (reserved(word) || REFUSED_ANYWHERE.has(word.toLowerCase())) refuse();
      words.push(word.toLowerCase());
      index = end;
      continue;
    }
    content();
    index += 1;
  }
  if (!seenContent) refuse();
  // `EXPLAIN` and `EXPLAIN QUERY PLAN` prefix a statement rather than being
  // one, so the word that decides is the one after them.
  let leading = 0;
  if (words[leading] === "explain") {
    leading += 1;
    if (words[leading] === "query" && words[leading + 1] === "plan") leading += 2;
  }
  const first = words[leading];
  if (first === undefined || REFUSED_LEADING.has(first)) refuse();
}

function reserved(identifier: string): boolean {
  return identifier.toLowerCase().startsWith(RESERVED_IDENTIFIER_PREFIX);
}

/** Index just past the closing quote, or a refusal for an unterminated one. */
function closingQuote(sql: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < sql.length) {
    if (sql[index] !== quote) {
      index += 1;
      continue;
    }
    if (sql[index + 1] === quote) {
      index += 2;
      continue;
    }
    return index + 1;
  }
  throw new PlaneError("sql_error");
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

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * The route that does not speak JSON envelopes in both directions.
 *
 * An `edge.objects` body is up to 5 GiB, so it travels as the request or
 * response body and the operation travels as one header. Nothing here is
 * buffered: a put is written to a file as it arrives, and a get is a `pread`
 * streamed straight back out.
 *
 * The binding name is still the whole authorization model. A Worker addresses
 * `MEDIA`, never the bucket incarnation this Host derived, and a name the
 * Version's own record does not carry is refused rather than resolved.
 */
const OBJECT_OPERATION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  head: ["key"],
  get: ["key", "range", "ifMatch", "ifNoneMatch"],
  put: ["key", "contentLength", "contentType", "ifMatch", "ifNoneMatch"],
  delete: ["key"],
  list: ["prefix", "delimiter", "cursor", "limit"],
  createMultipartUpload: ["key", "contentType"],
  uploadPart: ["key", "uploadId", "partNumber", "contentLength"],
  completeMultipartUpload: ["key", "uploadId", "parts"],
  abortMultipartUpload: ["key", "uploadId"],
};

interface ObjectDocument {
  readonly binding: string;
  readonly op: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

async function objectOperation(
  store: SelfhostObjectStore,
  bucketId: string,
  document: ObjectDocument,
  request: Request,
): Promise<Response> {
  const fields = document.fields;
  switch (document.op) {
    case "head": {
      const found = await store.head(bucketId, objectKey(fields.key));
      return objectAnswer(found ? { found: true, ...found } : { found: false });
    }

    case "get": {
      const found = await store.get(bucketId, objectKey(fields.key), {
        ...(fields.range === undefined ? {} : { range: objectRange(fields.range) }),
        ...(fields.ifMatch === undefined ? {} : { ifMatch: objectEtag(fields.ifMatch) }),
        ...(fields.ifNoneMatch === undefined
          ? {}
          : { ifNoneMatch: objectEtag(fields.ifNoneMatch) }),
      });
      if (!found) return objectAnswer({ found: false });
      return new Response(found.body, {
        status: 200,
        headers: {
          "content-type": SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
          [SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER]: encodeObjectDocument({
            etag: found.etag,
            size: found.size,
            ...(found.contentType === undefined ? {} : { contentType: found.contentType }),
            partial: found.partial,
            ...(found.range === undefined ? {} : { range: found.range }),
          }),
        },
      });
    }

    case "put": {
      const written = await store.put(bucketId, objectKey(fields.key), objectBody(request), {
        contentLength: objectLength(fields.contentLength),
        ...(fields.contentType === undefined
          ? {}
          : { contentType: objectContentType(fields.contentType) }),
        ...(fields.ifMatch === undefined ? {} : { ifMatch: objectEtag(fields.ifMatch) }),
        ...(fields.ifNoneMatch === undefined ? {} : { ifNoneMatch: objectAny(fields.ifNoneMatch) }),
      });
      return objectAnswer({ ...written });
    }

    case "delete": {
      await store.delete(bucketId, objectKey(fields.key));
      return objectAnswer({});
    }

    case "list": {
      const page = await store.list(bucketId, {
        ...(fields.prefix === undefined ? {} : { prefix: objectPrefix(fields.prefix) }),
        ...(fields.delimiter === undefined ? {} : { delimiter: objectDelimiter(fields.delimiter) }),
        ...(fields.cursor === undefined ? {} : { cursor: objectCursor(fields.cursor) }),
        ...(fields.limit === undefined ? {} : { limit: objectLimit(fields.limit) }),
      });
      return objectAnswer({
        objects: page.objects,
        prefixes: page.prefixes,
        truncated: page.truncated,
        ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
      });
    }

    case "createMultipartUpload": {
      const created = await store.createMultipartUpload(bucketId, objectKey(fields.key), {
        ...(fields.contentType === undefined
          ? {}
          : { contentType: objectContentType(fields.contentType) }),
      });
      return objectAnswer({ ...created });
    }

    case "uploadPart": {
      const part = await store.uploadPart(
        bucketId,
        objectKey(fields.key),
        objectUploadId(fields.uploadId),
        objectPartNumber(fields.partNumber),
        objectBody(request),
        { contentLength: objectLength(fields.contentLength) },
      );
      return objectAnswer({ ...part });
    }

    case "completeMultipartUpload": {
      const completed = await store.completeMultipartUpload(
        bucketId,
        objectKey(fields.key),
        objectUploadId(fields.uploadId),
        objectParts(fields.parts),
      );
      return objectAnswer({ ...completed });
    }

    case "abortMultipartUpload": {
      await store.abortMultipartUpload(
        bucketId,
        objectKey(fields.key),
        objectUploadId(fields.uploadId),
      );
      return objectAnswer({});
    }

    default:
      throw new SelfhostObjectError("backend_unavailable");
  }
}

function objectAnswer(value: Record<string, unknown>): Response {
  return Response.json({ ok: true, value }, { status: 200 });
}

function objectRefusal(code: string, status: number): Response {
  return Response.json({ ok: false, error: { code } }, { status });
}

/** The operation document, or a refusal before the body is touched. */
function parseObjectDocument(raw: string | null): ObjectDocument {
  if (
    raw === null ||
    raw.length === 0 ||
    raw.length > MAX_SELFHOST_OBJECT_DOCUMENT_BYTES ||
    !/^[A-Za-z0-9_-]+$/u.test(raw)
  ) {
    throw new SelfhostObjectError("backend_unavailable");
  }
  let parsed: unknown;
  try {
    const padded = raw.replaceAll("-", "+").replaceAll("_", "/");
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(padded, "base64")),
    );
  } catch {
    throw new SelfhostObjectError("backend_unavailable");
  }
  const document = record(parsed);
  if (!document || document.protocol !== SELFHOST_DATA_PLANE_OBJECT_PROTOCOL) {
    throw new SelfhostObjectError("backend_unavailable");
  }
  const binding = text(document.binding, 64);
  const op = text(document.op, 64);
  if (!binding || !op || !Object.hasOwn(OBJECT_OPERATION_FIELDS, op)) {
    throw new SelfhostObjectError("backend_unavailable");
  }
  const allowed = OBJECT_OPERATION_FIELDS[op] as readonly string[];
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(document)) {
    if (name === "protocol" || name === "binding" || name === "op") continue;
    if (!allowed.includes(name)) throw new SelfhostObjectError("backend_unavailable");
    fields[name] = value;
  }
  // A key-bearing operation without one is a document this Host did not write.
  if (allowed.includes("key") && fields.key === undefined) {
    throw new SelfhostObjectError("backend_unavailable");
  }
  return { binding, op, fields };
}

function encodeObjectDocument(value: Record<string, unknown>): string {
  const encoded = Buffer.from(new TextEncoder().encode(JSON.stringify(value)))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
  if (encoded.length > MAX_SELFHOST_OBJECT_DOCUMENT_BYTES) {
    throw new SelfhostObjectError("backend_unavailable");
  }
  return encoded;
}

/** An absent body is an empty one; a plane never guesses a length from it. */
function objectBody(request: Request): ReadableStream<Uint8Array> {
  return (request.body as ReadableStream<Uint8Array> | null) ?? new Blob([]).stream();
}

function objectKey(value: unknown): string {
  if (typeof value !== "string") throw new SelfhostObjectError("invalid_key");
  return value;
}

function objectPrefix(value: unknown): string {
  if (typeof value !== "string") throw new SelfhostObjectError("invalid_key");
  return value;
}

function objectDelimiter(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 16) {
    throw new SelfhostObjectError("backend_unavailable");
  }
  return value;
}

function objectCursor(value: unknown): string {
  if (typeof value !== "string") throw new SelfhostObjectError("invalid_cursor");
  return value;
}

function objectLimit(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 1_000) {
    throw new SelfhostObjectError("backend_unavailable");
  }
  return value as number;
}

/**
 * The facade's own bound, restated where the trust boundary is.
 *
 * The facade service copies a tenant's operation header across verbatim, so
 * anything holding the plain service binding writes this document directly and
 * the plane is what decides whether the field is one this Host will store. A
 * value the facade would refuse to read back is a value the plane must refuse
 * to write: 256 code points, no control characters — the same bound the
 * `edge.objects` facade applies and the same one migration 0041's CHECK
 * enforces.
 */
function objectEtag(value: unknown): string {
  return boundedObjectField(value);
}

function objectAny(value: unknown): "*" {
  if (value !== "*") throw new SelfhostObjectError("backend_unavailable");
  return "*";
}

function objectContentType(value: unknown): string {
  return boundedObjectField(value);
}

function boundedObjectField(value: unknown): string {
  if (typeof value !== "string") throw new SelfhostObjectError("backend_unavailable");
  const points = [...value];
  if (points.length < 1 || points.length > 256) {
    throw new SelfhostObjectError("backend_unavailable");
  }
  for (const point of points) {
    const code = point.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) throw new SelfhostObjectError("backend_unavailable");
  }
  return value;
}

function objectLength(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SelfhostObjectError("invalid_body");
  }
  return value as number;
}

function objectUploadId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 256) {
    throw new SelfhostObjectError("upload_not_found");
  }
  return value;
}

function objectPartNumber(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 10_000) {
    throw new SelfhostObjectError("upload_not_found");
  }
  return value as number;
}

function objectParts(
  value: unknown,
): readonly { readonly etag: string; readonly partNumber: number }[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 10_000) {
    throw new SelfhostObjectError("invalid_part");
  }
  return value.map((entry) => {
    const part = record(entry);
    if (
      !part ||
      Object.keys(part).sort().join(",") !== "etag,partNumber" ||
      typeof part.etag !== "string" ||
      part.etag.length < 1 ||
      part.etag.length > 1_024 ||
      !Number.isSafeInteger(part.partNumber) ||
      (part.partNumber as number) < 1 ||
      (part.partNumber as number) > 10_000
    ) {
      throw new SelfhostObjectError("invalid_part");
    }
    return { etag: part.etag, partNumber: part.partNumber as number };
  });
}

function objectRange(value: unknown): { readonly offset: number; readonly length?: number } {
  const range = record(value);
  if (
    !range ||
    !Number.isSafeInteger(range.offset) ||
    (range.offset as number) < 0 ||
    Object.keys(range).some((key) => key !== "offset" && key !== "length") ||
    (range.length !== undefined &&
      (!Number.isSafeInteger(range.length) || (range.length as number) < 1))
  ) {
    throw new SelfhostObjectError("range_not_satisfiable");
  }
  return {
    offset: range.offset as number,
    ...(range.length === undefined ? {} : { length: range.length as number }),
  };
}
