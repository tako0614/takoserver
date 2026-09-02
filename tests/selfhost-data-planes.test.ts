import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import type { Sql } from "../src/ports.ts";
import {
  SELFHOST_DATA_PLANE_KV_PATH,
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_QUEUE_PATH,
  SELFHOST_DATA_PLANE_SQL_PATH,
} from "../src/providers/selfhost-worker-wrapper.ts";
import {
  createSelfhostDataPlanes,
  type SelfhostDataPlaneGrant,
} from "../src/selfhost-data-planes.ts";

/**
 * The backend half of a self-hosted Worker's storage.
 *
 * Two properties are load-bearing here and both are about what a Worker cannot
 * do, not what it can: a token names one Worker Version and no other, and a
 * binding name resolves only inside the grant that token carries. Everything
 * else is the exact edge.kv/edge.sql behaviour the facade in front expects.
 */

const ORIGIN = "http://takoserver-selfhost-data.invalid";
const QUEUE = { messageRetentionSeconds: 345_600, deliveryDelaySeconds: 0 } as const;
const ALPHA: SelfhostDataPlaneGrant = {
  secret: "alpha-secret-value-0000",
  kv: { KV: "tskv-alpha" },
  sql: { DB: "tsdb-alpha" },
  queue: { DELIVERY: { queueId: "tsq-alpha", ...QUEUE } },
};
const BETA: SelfhostDataPlaneGrant = {
  secret: "beta-secret-value-00000",
  kv: { KV: "tskv-beta" },
  sql: { DB: "tsdb-beta" },
  queue: { DELIVERY: { queueId: "tsq-beta", ...QUEUE } },
};
const GRANTS: Record<string, SelfhostDataPlaneGrant> = {
  "alpha\u0000v1": ALPHA,
  "beta\u0000v1": BETA,
};

let root: string;
let sql: Sql;
let now: Date;
let planes: ReturnType<typeof createSelfhostDataPlanes>;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-data-planes-"));
  sql = createEphemeralSql();
  now = new Date("2026-09-02T00:00:00.000Z");
  planes = createSelfhostDataPlanes({
    sql,
    grant: async (script, versionId) => GRANTS[`${script}\u0000${versionId}`] ?? null,
    databasePath: (name) => join(root, `${name}.sqlite`),
    clock: () => now,
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

async function post(
  path: string,
  body: Record<string, unknown>,
  token = `alpha.v1.${ALPHA.secret}`,
): Promise<{ status: number; envelope: Record<string, unknown> }> {
  const payload = JSON.stringify({ protocol: SELFHOST_DATA_PLANE_PROTOCOL, ...body });
  const request = new Request(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      // Declared, as every real caller declares it: the plane refuses a body
      // whose length it was not told, so it never reads one it did not agree
      // to. `new Request` does not set this by itself; a wire client does.
      "content-length": String(new TextEncoder().encode(payload).byteLength),
    },
    body: payload,
  });
  const response = await planes.routes(request, new URL(request.url));
  if (!response) throw new Error("the data planes did not claim the request");
  return { status: response.status, envelope: (await response.json()) as Record<string, unknown> };
}

const kv = (body: Record<string, unknown>, token?: string) =>
  post(SELFHOST_DATA_PLANE_KV_PATH, { binding: "KV", ...body }, token);
const db = (body: Record<string, unknown>, token?: string) =>
  post(SELFHOST_DATA_PLANE_SQL_PATH, { binding: "DB", ...body }, token);
const queue = (body: Record<string, unknown>, token?: string) =>
  post(SELFHOST_DATA_PLANE_QUEUE_PATH, { binding: "DELIVERY", ...body }, token);
const encode = (text: string) => btoa(text);

function value(envelope: Record<string, unknown>): Record<string, unknown> {
  expect(envelope.ok).toBe(true);
  return envelope.value as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Routing and authentication
// ---------------------------------------------------------------------------

test("a path outside the prefix is not this plane's request to answer", async () => {
  const request = new Request(`${ORIGIN}/v1/organizations`, { method: "POST" });
  expect(await planes.routes(request, new URL(request.url))).toBeNull();
});

test("a request with no token is refused without saying what it asked for", async () => {
  const request = new Request(`${ORIGIN}${SELFHOST_DATA_PLANE_KV_PATH}`, {
    method: "POST",
    body: JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_PROTOCOL,
      binding: "KV",
      op: "get",
      key: "k",
    }),
  });
  const response = await planes.routes(request, new URL(request.url));
  expect(response?.status).toBe(401);
  expect(await response?.json()).toEqual({ ok: false, error: { code: "backend_unavailable" } });
});

test("a wrong secret is answered exactly like an unknown version", async () => {
  const wrongSecret = await kv({ op: "get", key: "k" }, `alpha.v1.${BETA.secret}`);
  const unknownVersion = await kv({ op: "get", key: "k" }, `alpha.v9.${ALPHA.secret}`);
  expect(wrongSecret).toEqual(unknownVersion);
  expect(wrongSecret.status).toBe(401);
});

test("a malformed token is refused before any record is read", async () => {
  for (const token of ["alpha", "alpha.v1", "../etc.v1.secret", `alpha.v1.${"x".repeat(200)}`]) {
    expect((await kv({ op: "get", key: "k" }, token)).status).toBe(401);
  }
});

test("a binding the Version did not declare resolves to nothing", async () => {
  const answer = await post(SELFHOST_DATA_PLANE_KV_PATH, { binding: "OTHER", op: "get", key: "k" });
  expect(answer.status).toBe(404);
  expect(answer.envelope).toEqual({ ok: false, error: { code: "backend_unavailable" } });
});

test("a request that is not a POST is refused", async () => {
  const request = new Request(`${ORIGIN}${SELFHOST_DATA_PLANE_KV_PATH}`, { method: "GET" });
  const response = await planes.routes(request, new URL(request.url));
  expect(response?.status).toBe(405);
});

// ---------------------------------------------------------------------------
// KV
// ---------------------------------------------------------------------------

test("a value put under a key comes back byte for byte", async () => {
  expect(
    value(await kv({ op: "put", key: "greeting", value: btoa("hello") }).then((r) => r.envelope)),
  ).toEqual({});
  const read = value((await kv({ op: "get", key: "greeting" })).envelope);
  expect(read).toEqual({ found: true, value: btoa("hello") });
});

test("a key nothing was put under is absent rather than empty", async () => {
  expect(value((await kv({ op: "get", key: "missing" })).envelope)).toEqual({ found: false });
});

test("metadata comes back only from getWithMetadata", async () => {
  await kv({ op: "put", key: "k", value: btoa("v"), metadata: { kind: "session", user: "u1" } });
  expect(value((await kv({ op: "get", key: "k" })).envelope)).toEqual({
    found: true,
    value: btoa("v"),
  });
  expect(value((await kv({ op: "getWithMetadata", key: "k" })).envelope)).toEqual({
    found: true,
    value: btoa("v"),
    metadata: { kind: "session", user: "u1" },
  });
});

test("a put replaces the value and the metadata it had", async () => {
  await kv({ op: "put", key: "k", value: btoa("first"), metadata: { a: "1" } });
  await kv({ op: "put", key: "k", value: btoa("second") });
  expect(value((await kv({ op: "getWithMetadata", key: "k" })).envelope)).toEqual({
    found: true,
    value: btoa("second"),
  });
});

test("an entry disappears exactly when its expiry passes", async () => {
  await kv({ op: "put", key: "k", value: btoa("v"), expirationTtlSeconds: 60 });
  now = new Date("2026-09-02T00:00:59.000Z");
  expect(value((await kv({ op: "get", key: "k" })).envelope)).toEqual({
    found: true,
    value: btoa("v"),
  });
  now = new Date("2026-09-02T00:01:00.000Z");
  expect(value((await kv({ op: "get", key: "k" })).envelope)).toEqual({ found: false });
  // Reading it is what reclaims it, so the row is gone rather than merely
  // filtered out of every later answer.
  const rows = await sql.query("SELECT COUNT(*) AS count FROM selfhost_kv_entries", []);
  expect(rows[0]?.count).toBe(0);
});

test("a ttl below the facade's floor is refused", async () => {
  const answer = await kv({ op: "put", key: "k", value: btoa("v"), expirationTtlSeconds: 30 });
  expect(answer.envelope).toEqual({ ok: false, error: { code: "invalid_value" } });
});

test("a delete makes the entry absent and is not an error when it already was", async () => {
  await kv({ op: "put", key: "k", value: btoa("v") });
  expect(value((await kv({ op: "delete", key: "k" })).envelope)).toEqual({});
  expect(value((await kv({ op: "get", key: "k" })).envelope)).toEqual({ found: false });
  expect(value((await kv({ op: "delete", key: "k" })).envelope)).toEqual({});
});

test("listing walks keys in order, honours a prefix, and pages by cursor", async () => {
  for (const key of ["a:1", "a:2", "a:3", "b:1"]) {
    await kv({ op: "put", key, value: btoa(key) });
  }
  const first = value((await kv({ op: "list", prefix: "a:", limit: 2 })).envelope);
  expect(first.keys).toEqual([{ name: "a:1" }, { name: "a:2" }]);
  expect(first.listComplete).toBe(false);
  expect(typeof first.cursor).toBe("string");

  const second = value(
    (await kv({ op: "list", prefix: "a:", limit: 2, cursor: first.cursor })).envelope,
  );
  expect(second.keys).toEqual([{ name: "a:3" }]);
  expect(second.listComplete).toBe(true);
  expect(second.cursor).toBeUndefined();
});

test("a prefix is a range rather than a pattern", async () => {
  for (const key of ["a%b", "axb", "azb"]) await kv({ op: "put", key, value: btoa(key) });
  // Under LIKE, `a%b` would match all three. It is a literal prefix here.
  const listed = value((await kv({ op: "list", prefix: "a%" })).envelope);
  expect(listed.keys).toEqual([{ name: "a%b" }]);
});

test("an expired entry is not listed", async () => {
  await kv({ op: "put", key: "live", value: btoa("v") });
  await kv({ op: "put", key: "dying", value: btoa("v"), expirationTtlSeconds: 60 });
  now = new Date("2026-09-02T00:02:00.000Z");
  expect(value((await kv({ op: "list" })).envelope).keys).toEqual([{ name: "live" }]);
});

test("a cursor that was not minted here is refused", async () => {
  expect((await kv({ op: "list", cursor: "not a cursor" })).envelope).toEqual({
    ok: false,
    error: { code: "invalid_cursor" },
  });
});

test("two Worker Versions cannot see each other's entries", async () => {
  await kv({ op: "put", key: "shared", value: btoa("alpha") });
  await kv({ op: "put", key: "shared", value: btoa("beta") }, `beta.v1.${BETA.secret}`);
  expect(value((await kv({ op: "get", key: "shared" })).envelope)).toEqual({
    found: true,
    value: btoa("alpha"),
  });
  expect(
    value((await kv({ op: "get", key: "shared" }, `beta.v1.${BETA.secret}`)).envelope),
  ).toEqual({ found: true, value: btoa("beta") });
  expect(value((await kv({ op: "list" })).envelope).keys).toEqual([{ name: "shared" }]);
});

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

test("a statement executes against the version's own database", async () => {
  expect(
    value(
      (
        await db({
          op: "execute",
          statement: { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT)" },
        })
      ).envelope,
    ),
  ).toEqual({ rows: [], rowsWritten: 0 });
  const inserted = value(
    (
      await db({
        op: "execute",
        statement: { sql: "INSERT INTO t (id, name) VALUES (?, ?)", params: [1, "a"] },
      })
    ).envelope,
  );
  expect(inserted).toEqual({ rows: [], rowsWritten: 1 });
  const read = value(
    (await db({ op: "query", statement: { sql: "SELECT id, name FROM t" } })).envelope,
  );
  expect(read).toEqual({ rows: [{ id: 1, name: "a" }], rowsWritten: 0 });
});

test("a read after a write reports no rows written", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER)" } });
  await db({ op: "execute", statement: { sql: "INSERT INTO t VALUES (1), (2), (3)" } });
  // `changes()` would still be 3 here; the facade refuses its own answer when
  // a read claims to have written, so this has to be the total delta.
  expect(
    value((await db({ op: "query", statement: { sql: "SELECT * FROM t" } })).envelope),
  ).toMatchObject({
    rowsWritten: 0,
  });
});

test("bound parameters carry text, numbers, null, and bytes", async () => {
  await db({
    op: "execute",
    statement: { sql: "CREATE TABLE t (s TEXT, n INTEGER, z TEXT, b BLOB)" },
  });
  await db({
    op: "execute",
    statement: {
      sql: "INSERT INTO t VALUES (?, ?, ?, ?)",
      params: ["text", 42, null, { encoding: "base64", data: btoa("bytes") }],
    },
  });
  expect(
    value((await db({ op: "query", statement: { sql: "SELECT * FROM t" } })).envelope),
  ).toEqual({
    rows: [{ s: "text", n: 42, z: null, b: { encoding: "base64", data: btoa("bytes") } }],
    rowsWritten: 0,
  });
});

test("a transaction commits every statement or none of them", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" } });
  const committed = value(
    (
      await db({
        op: "transaction",
        statements: [
          { sql: "INSERT INTO t VALUES (?)", params: [1] },
          { sql: "INSERT INTO t VALUES (?)", params: [2] },
        ],
      })
    ).envelope,
  );
  expect(committed.results).toEqual([
    { rows: [], rowsWritten: 1 },
    { rows: [], rowsWritten: 1 },
  ]);

  const refused = await db({
    op: "transaction",
    statements: [
      { sql: "INSERT INTO t VALUES (?)", params: [3] },
      // The same primary key twice: the second statement is rejected and the
      // first must not survive it.
      { sql: "INSERT INTO t VALUES (?)", params: [1] },
    ],
  });
  expect(refused.envelope).toEqual({ ok: false, error: { code: "sql_error" } });
  expect(
    value((await db({ op: "query", statement: { sql: "SELECT id FROM t ORDER BY id" } })).envelope),
  ).toEqual({
    rows: [{ id: 1 }, { id: 2 }],
    rowsWritten: 0,
  });
});

test("foreign keys are enforced, as they are on the managed backend", async () => {
  await db({
    op: "transaction",
    statements: [
      { sql: "CREATE TABLE parent (id INTEGER PRIMARY KEY)" },
      {
        sql: "CREATE TABLE child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES parent(id))",
      },
    ],
  });
  const orphan = await db({
    op: "execute",
    statement: { sql: "INSERT INTO child VALUES (1, 99)" },
  });
  expect(orphan.envelope).toEqual({ ok: false, error: { code: "sql_error" } });
});

test("broken SQL is a closed code rather than a SQLite message", async () => {
  const answer = await db({ op: "execute", statement: { sql: "SELECT * FROM nope" } });
  expect(answer.envelope).toEqual({ ok: false, error: { code: "sql_error" } });
  expect(JSON.stringify(answer.envelope)).not.toContain("nope");
});

test("two Worker Versions get two databases", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER)" } });
  await db({ op: "execute", statement: { sql: "INSERT INTO t VALUES (1)" } });
  const other = await db(
    { op: "query", statement: { sql: "SELECT * FROM t" } },
    `beta.v1.${BETA.secret}`,
  );
  expect(other.envelope).toEqual({ ok: false, error: { code: "sql_error" } });
});

test("an operation outside the vocabulary is refused", async () => {
  expect((await db({ op: "drop", statement: { sql: "SELECT 1" } })).envelope).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect((await kv({ op: "scan", key: "k" })).envelope).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
});

// ---------------------------------------------------------------------------
// What a statement is allowed to be
// ---------------------------------------------------------------------------

test("a statement that would leave this database is refused before it is prepared", async () => {
  const victim = join(root, "victim.sqlite");
  for (const statement of [
    { sql: "ATTACH DATABASE ? AS other", params: [victim] },
    { sql: `ATTACH DATABASE '${victim}' AS other` },
    { sql: "ATTACH/*sneaky*/DATABASE ? AS other", params: [victim] },
    { sql: "attach DATABASE ? AS other", params: [victim] },
    { sql: "DETACH DATABASE other" },
    { sql: "PRAGMA database_list" },
    { sql: "PRAGMA writable_schema = ON" },
    { sql: "VACUUM INTO ?", params: [victim] },
    { sql: "ANALYZE" },
    { sql: "EXPLAIN ATTACH DATABASE ? AS other", params: [victim] },
  ]) {
    expect((await db({ op: "execute", statement })).envelope).toEqual({
      ok: false,
      error: { code: "sql_error" },
    });
  }
  // Nothing was opened, so nothing was created either.
  expect(existsSync(victim)).toBe(false);
});

test("the Takoform migration ledger is not a table this binding can name", async () => {
  // On the managed backend the ledger is Durable Object storage and `edge.sql`
  // cannot see it. Here it lives in the same file, so the name is reserved —
  // however it is spelled, and including as a string literal, because SQLite
  // takes one where an identifier belongs.
  for (const sql of [
    "DROP TABLE IF EXISTS _takoform_sqlite_migrations",
    "DROP TABLE IF EXISTS '_takoform_sqlite_migrations'",
    'DROP TABLE IF EXISTS "_TAKOFORM_SQLITE_MIGRATIONS"',
    "DROP TABLE IF EXISTS [_takoform_sqlite_migrations]",
    "SELECT * FROM _takoform_sqlite_migrations",
    "CREATE TABLE _takoform_anything (a)",
    "ALTER TABLE t RENAME TO _takoform_sqlite_migrations",
  ]) {
    expect((await db({ op: "execute", statement: { sql } })).envelope).toEqual({
      ok: false,
      error: { code: "sql_error" },
    });
  }
});

test("transaction control belongs to the plane, not to the statement", async () => {
  for (const sql of [
    "BEGIN",
    "BEGIN IMMEDIATE",
    "COMMIT",
    "END",
    "ROLLBACK",
    "SAVEPOINT s",
    "RELEASE s",
  ]) {
    expect((await db({ op: "execute", statement: { sql } })).envelope).toEqual({
      ok: false,
      error: { code: "sql_error" },
    });
  }
  // The words are still legal where SQLite means something else by them.
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" } });
  expect(
    value(
      (
        await db({
          op: "query",
          statement: { sql: "SELECT CASE WHEN 1 THEN 'yes' ELSE 'no' END AS answer" },
        })
      ).envelope,
    ),
  ).toEqual({ rows: [{ answer: "yes" }], rowsWritten: 0 });
  expect(
    value(
      (await db({ op: "execute", statement: { sql: "INSERT OR ROLLBACK INTO t VALUES (1)" } }))
        .envelope,
    ),
  ).toEqual({ rows: [], rowsWritten: 1 });
});

test("a second statement in one text is refused", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER)" } });
  expect(
    (await db({ op: "execute", statement: { sql: "INSERT INTO t VALUES (1); DROP TABLE t" } }))
      .envelope,
  ).toEqual({ ok: false, error: { code: "sql_error" } });
  // A trailing semicolon is punctuation, not a second statement.
  expect(
    value(
      (await db({ op: "execute", statement: { sql: "INSERT INTO t VALUES (2); -- done" } }))
        .envelope,
    ),
  ).toEqual({ rows: [], rowsWritten: 1 });
});

test("a semicolon inside a value is not a statement boundary", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (body TEXT)" } });
  expect(
    value(
      (await db({ op: "execute", statement: { sql: "INSERT INTO t VALUES ('a; DROP TABLE t')" } }))
        .envelope,
    ),
  ).toEqual({ rows: [], rowsWritten: 1 });
  expect(
    value((await db({ op: "query", statement: { sql: "SELECT body FROM t" } })).envelope),
  ).toEqual({ rows: [{ body: "a; DROP TABLE t" }], rowsWritten: 0 });
});

// ---------------------------------------------------------------------------
// Reads, transactions, and ceilings
// ---------------------------------------------------------------------------

test("a write through query is rolled back rather than committed", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" } });
  await db({ op: "execute", statement: { sql: "INSERT INTO t VALUES (1)" } });
  // The managed backend runs `query` inside a transaction it always rolls
  // back, so the two backends must not differ on whether the row survives.
  expect(value((await db({ op: "query", statement: { sql: "DELETE FROM t" } })).envelope)).toEqual({
    rows: [],
    rowsWritten: 0,
  });
  expect(
    value((await db({ op: "query", statement: { sql: "SELECT count(*) AS n FROM t" } })).envelope),
  ).toEqual({ rows: [{ n: 1 }], rowsWritten: 0 });
});

test("a transaction whose last statement fails leaves none of the earlier ones", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" } });
  const mixed = await db({
    op: "transaction",
    statements: [
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "INSERT INTO t VALUES (2)" },
      { sql: "INSERT INTO t VALUES (1)" },
    ],
  });
  expect(mixed.envelope).toEqual({ ok: false, error: { code: "sql_error" } });
  expect(
    value((await db({ op: "query", statement: { sql: "SELECT count(*) AS n FROM t" } })).envelope),
  ).toEqual({ rows: [{ n: 0 }], rowsWritten: 0 });
});

test("a refused statement anywhere in a batch stops the batch before it starts", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER PRIMARY KEY)" } });
  const mixed = await db({
    op: "transaction",
    statements: [
      { sql: "INSERT INTO t VALUES (1)" },
      { sql: "COMMIT" },
      { sql: "INSERT INTO t VALUES (2)" },
    ],
  });
  expect(mixed.envelope).toEqual({ ok: false, error: { code: "sql_error" } });
  expect(
    value((await db({ op: "query", statement: { sql: "SELECT count(*) AS n FROM t" } })).envelope),
  ).toEqual({ rows: [{ n: 0 }], rowsWritten: 0 });
  // And the connection is still usable: a batch that failed did not leave a
  // transaction open on the handle every later request shares.
  expect(
    value(
      (
        await db({
          op: "transaction",
          statements: [{ sql: "INSERT INTO t VALUES (3)" }],
        })
      ).envelope,
    ),
  ).toEqual({ results: [{ rows: [], rowsWritten: 1 }] });
});

test("a result larger than the ceiling is refused rather than materialised", async () => {
  const generated =
    "WITH RECURSIVE wide(i, body) AS (" +
    "SELECT 1, hex(randomblob(4000)) UNION ALL SELECT i + 1, hex(randomblob(4000)) FROM wide WHERE i < 5000" +
    ") SELECT i, body FROM wide";
  const answer = await db({ op: "query", statement: { sql: generated } });
  expect(answer.envelope).toEqual({ ok: false, error: { code: "sql_error" } });
});

test("more rows than the ceiling is refused", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (i INTEGER)" } });
  const answer = await db({
    op: "query",
    statement: {
      sql:
        "WITH RECURSIVE many(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM many WHERE i < 20000) " +
        "SELECT i FROM many",
    },
  });
  expect(answer.envelope).toEqual({ ok: false, error: { code: "sql_error" } });
});

// ---------------------------------------------------------------------------
// Names, bodies, and files
// ---------------------------------------------------------------------------

test("a binding named after a prototype property resolves to nothing", async () => {
  for (const binding of ["__proto__", "constructor", "toString", "valueOf", "hasOwnProperty"]) {
    expect(
      (
        await post(SELFHOST_DATA_PLANE_SQL_PATH, {
          binding,
          op: "execute",
          statement: { sql: "SELECT 1" },
        })
      ).envelope,
    ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
    expect(
      (await post(SELFHOST_DATA_PLANE_KV_PATH, { binding, op: "get", key: "k" })).envelope,
    ).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
  }
  // And no file was opened for one of those names.
  expect(readdirSync(root)).toEqual([]);
});

test("a body with no declared length is refused before it is read", async () => {
  const request = new Request(`${ORIGIN}${SELFHOST_DATA_PLANE_SQL_PATH}`, {
    method: "POST",
    headers: { authorization: `Bearer alpha.v1.${ALPHA.secret}` },
    body: JSON.stringify({ protocol: SELFHOST_DATA_PLANE_PROTOCOL, binding: "DB", op: "execute" }),
  });
  const response = await planes.routes(request, new URL(request.url));
  expect(response?.status).toBe(400);
});

test("an unauthenticated caller is refused before the body is even measured", async () => {
  // A body far over the ceiling and a token that is not one. The answer is the
  // 401, not the 400: nothing about the body was looked at, so an
  // unauthenticated caller cannot choose how much work this process does.
  const request = new Request(`${ORIGIN}${SELFHOST_DATA_PLANE_SQL_PATH}`, {
    method: "POST",
    headers: {
      authorization: "Bearer alpha.v1.not-the-right-secret",
      "content-length": String(1024 * 1024 * 1024),
    },
    body: "{}",
  });
  const response = await planes.routes(request, new URL(request.url));
  expect(response?.status).toBe(401);
});

test("a database file and its directory are private to this process", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER)" } });
  expect(statSync(join(root, "tsdb-alpha.sqlite")).mode & 0o777).toBe(0o600);
  expect(statSync(root).mode & 0o077).toBe(0);
});

test("a listing includes keys outside the basic plane", async () => {
  // The prefix ceiling is a code point away, not a code unit: incrementing the
  // trailing low surrogate leaves a bound below every key it should match.
  await kv({ op: "put", key: "\u{10FFFF}", value: btoa("a") });
  await kv({ op: "put", key: "\u{10FFFF}z", value: btoa("b") });
  expect(value((await kv({ op: "list", prefix: "\u{10FFFF}" })).envelope).keys).toEqual([
    { name: "\u{10FFFF}" },
    { name: "\u{10FFFF}z" },
  ]);
});

// ---------------------------------------------------------------------------
// Maintenance
// ---------------------------------------------------------------------------

test("deleting a namespace deletes its rows and leaves every other namespace alone", async () => {
  await kv({ op: "put", key: "k", value: btoa("alpha") });
  await kv({ op: "put", key: "k", value: btoa("beta") }, `beta.v1.${BETA.secret}`);
  await planes.maintenance.deleteKvNamespace("tskv-alpha");
  expect(value((await kv({ op: "get", key: "k" })).envelope)).toEqual({ found: false });
  expect(value((await kv({ op: "get", key: "k" }, `beta.v1.${BETA.secret}`)).envelope)).toEqual({
    found: true,
    value: btoa("beta"),
  });
});

test("the sweep reclaims expired rows and nothing else, in bounded batches", async () => {
  await kv({ op: "put", key: "keeps", value: btoa("a") });
  await kv({ op: "put", key: "goes", value: btoa("b"), expirationTtlSeconds: 60 });
  now = new Date(now.getTime() + 120_000);
  expect(await planes.maintenance.sweepExpiredKv()).toBe(1);
  expect(await planes.maintenance.sweepExpiredKv()).toBe(0);
  expect(value((await kv({ op: "get", key: "keeps" })).envelope)).toEqual({
    found: true,
    value: btoa("a"),
  });
});

test("forgetting a database drops the handle rather than the file", async () => {
  await db({ op: "execute", statement: { sql: "CREATE TABLE t (id INTEGER)" } });
  await db({ op: "execute", statement: { sql: "INSERT INTO t VALUES (1)" } });
  planes.maintenance.forgetDatabase("tsdb-alpha");
  // Reopened on the next request, so a database deleted and declared again
  // under the same name is never served through a handle on the old inode.
  expect(
    value((await db({ op: "query", statement: { sql: "SELECT count(*) AS n FROM t" } })).envelope),
  ).toEqual({ rows: [{ n: 1 }], rowsWritten: 0 });
});

// ---------------------------------------------------------------------------
// Queue producer
// ---------------------------------------------------------------------------

const messages = () =>
  sql.query(
    "SELECT queue_id, message_id, visible_at_ms, expires_at_ms, deliveries " +
      "FROM selfhost_queue_messages ORDER BY message_id",
    [],
  );

test("accepting a message decides its whole future at the moment it is accepted", async () => {
  const accepted = value((await queue({ op: "send", body: encode("one") })).envelope);
  expect(String(accepted.messageId)).toMatch(/^[0-9a-f-]{36}$/u);
  expect(await messages()).toMatchObject([
    {
      queue_id: "tsq-alpha",
      // Deliverable now, because this queue's own delay is none, and kept for
      // exactly the retention it promised — both as absolute instants, so a
      // restart does not restart the clock with the process.
      visible_at_ms: now.getTime(),
      expires_at_ms: now.getTime() + 345_600 * 1_000,
      deliveries: 0,
    },
  ]);
});

test("a send may delay past the queue's own default, inside the Interface's range", async () => {
  value((await queue({ op: "send", body: encode("later"), delaySeconds: 30 })).envelope);
  expect(await messages()).toMatchObject([{ visible_at_ms: now.getTime() + 30_000 }]);
  expect((await queue({ op: "send", body: encode("no"), delaySeconds: 43_201 })).envelope).toEqual({
    ok: false,
    error: { code: "invalid_argument" },
  });
  expect((await queue({ op: "send", body: encode("no"), delaySeconds: -1 })).envelope).toEqual({
    ok: false,
    error: { code: "invalid_argument" },
  });
});

test("a batch is accepted whole or not at all", async () => {
  const accepted = value(
    (
      await queue({
        op: "sendBatch",
        messages: [{ body: encode("one") }, { body: encode("two"), delaySeconds: 5 }],
      })
    ).envelope,
  );
  expect((accepted.messageIds as readonly string[]).length).toBe(2);
  expect(await messages()).toHaveLength(2);

  // One bad message refuses the batch, and leaves nothing behind.
  expect(
    (
      await queue({
        op: "sendBatch",
        messages: [{ body: encode("fine") }, { body: "not base64!" }],
      })
    ).envelope,
  ).toEqual({ ok: false, error: { code: "invalid_body" } });
  expect(await messages()).toHaveLength(2);
});

test("refuses a body that is not bytes, one that is too large, and a batch that is", async () => {
  expect((await queue({ op: "send", body: 7 })).envelope).toEqual({
    ok: false,
    error: { code: "invalid_body" },
  });
  expect((await queue({ op: "send", body: encode("x".repeat(127_001)) })).envelope).toEqual({
    ok: false,
    error: { code: "message_too_large" },
  });
  expect(
    (
      await queue({
        op: "sendBatch",
        messages: Array.from({ length: 101 }, () => ({ body: encode("x") })),
      })
    ).envelope,
  ).toEqual({ ok: false, error: { code: "batch_too_large" } });
});

test("a queue binding the version never declared is not a queue this token can name", async () => {
  const answer = await post(
    SELFHOST_DATA_PLANE_QUEUE_PATH,
    { binding: "OTHER", op: "send", body: encode("x") },
    `alpha.v1.${ALPHA.secret}`,
  );
  expect(answer.status).toBe(404);
  expect(answer.envelope).toEqual({ ok: false, error: { code: "backend_unavailable" } });
  // And one tenant's binding name never reaches another tenant's queue.
  value((await queue({ op: "send", body: encode("mine") }, `beta.v1.${BETA.secret}`)).envelope);
  expect((await messages())[0]?.queue_id).toBe("tsq-beta");
});
