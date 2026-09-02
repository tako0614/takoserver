import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  MANAGED_SQLITE_CONTROL_KEY,
  MANAGED_SQLITE_CONTROL_SCHEMA,
  ManagedWorkerSqliteCore,
  type ManagedWorkerSqliteState,
  type ManagedWorkerSqliteStorage,
  managedWorkerSqliteInstanceName,
} from "../src/providers/cloudflare-managed-worker-sqlite.ts";

const AUTHORITY = {
  providerId: "cloudflare",
  resourceUid: "resource-uid",
  generation: "7",
  operationId: "operation-1",
  descriptorDigest: `sha256:${"a".repeat(64)}` as const,
};

class BunSqliteState implements ManagedWorkerSqliteState {
  readonly database = new Database(":memory:");
  readonly kvValues = new Map<string, unknown>();
  failNextKvPut = false;
  readonly storage = {
    sql: {
      exec: <T extends Record<string, ArrayBuffer | string | number | null>>(
        query: string,
        ...bindings: (ArrayBuffer | string | number | null)[]
      ) => {
        const rows = this.database
          .query(query)
          .all(
            ...bindings.map((value) =>
              value instanceof ArrayBuffer ? new Uint8Array(value) : value,
            ),
          )
          .map((row) => {
            const output: Record<string, ArrayBuffer | string | number | null> = {};
            for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
              output[key] =
                value instanceof Uint8Array
                  ? (value.buffer.slice(
                      value.byteOffset,
                      value.byteOffset + value.byteLength,
                    ) as unknown as ArrayBuffer)
                  : (value as ArrayBuffer | string | number | null);
            }
            return output as T;
          });
        const changed = this.database.query("SELECT changes() AS changes").get() as {
          changes?: unknown;
        } | null;
        return {
          toArray: () => rows,
          rowsWritten: typeof changed?.changes === "number" ? changed.changes : 0,
        };
      },
    } satisfies ManagedWorkerSqliteStorage,
    kv: {
      get: <T>(key: string): T | undefined => this.kvValues.get(key) as T | undefined,
      put: <T>(key: string, value: T): void => {
        if (this.failNextKvPut) {
          this.failNextKvPut = false;
          throw new Error("kv write failed");
        }
        this.kvValues.set(key, structuredClone(value));
      },
      delete: (key: string): boolean => this.kvValues.delete(key),
    },
    transactionSync: <T>(callback: () => T): T => {
      const kvSnapshot = structuredClone([...this.kvValues.entries()]);
      this.database.exec("BEGIN IMMEDIATE");
      try {
        const result = callback();
        this.database.exec("COMMIT");
        return result;
      } catch (error) {
        this.database.exec("ROLLBACK");
        this.kvValues.clear();
        for (const [key, value] of kvSnapshot) this.kvValues.set(key, value);
        throw error;
      }
    },
  };
}

async function migration(path: string, sql: string) {
  const bytes = new TextEncoder().encode(sql);
  const digest = `sha256:${[...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}` as const;
  return { path, digest, sql: bytes };
}

test("SQLite DO names are deterministic and never include the raw resource UID", async () => {
  const first = await managedWorkerSqliteInstanceName(AUTHORITY);
  const second = await managedWorkerSqliteInstanceName(AUTHORITY);
  expect(first).toBe(second);
  expect(first).toMatch(/^tsdb-[A-Za-z0-9_-]{43}$/u);
  expect(first).not.toContain(AUTHORITY.resourceUid);
});

test("edge.sql query rolls back all effects after full result materialization", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  expect(await database.takoserverSqliteInitialize(AUTHORITY)).toEqual({
    ok: true,
    value: { state: "active" },
  });
  const table = await migration(
    "001-create.sql",
    "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)",
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      authority: AUTHORITY,
      expectedPrefix: [],
      migrations: [table],
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(
    await database.edgeSqlExecute({
      sql: "INSERT INTO records (id, value) VALUES (?, ?)",
      params: [1, "before"],
    }),
  ).toMatchObject({ ok: true, value: { rowsWritten: 1 } });
  const rolledBack = await database.edgeSqlQuery({
    sql: "UPDATE records SET value = ?",
    params: ["after"],
  });
  expect(rolledBack).toMatchObject({ ok: true, value: { rowsWritten: 0 } });
  expect(await database.edgeSqlQuery({ sql: "SELECT value FROM records" })).toEqual({
    ok: true,
    value: { rows: [{ value: "before" }], rowsWritten: 0 },
  });
});

test("edge.sql transaction is serializable all-or-none", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  await database.takoserverSqliteInitialize(AUTHORITY);
  const table = await migration(
    "002-create.sql",
    "CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
  );
  await database.takoserverSqliteApplyMigrationSuffix({
    authority: AUTHORITY,
    expectedPrefix: [],
    migrations: [table],
  });
  const failure = await database.edgeSqlTransaction({
    statements: [
      { sql: "INSERT INTO events (id, value) VALUES (?, ?)", params: [1, "one"] },
      { sql: "INSERT INTO missing_table (value) VALUES (?)", params: ["two"] },
    ],
  });
  expect(failure).toMatchObject({ ok: false });
  expect(await database.edgeSqlQuery({ sql: "SELECT id FROM events" })).toEqual({
    ok: true,
    value: { rows: [], rowsWritten: 0 },
  });
});

test("control metadata is one hidden sync-KV record and an exact suffix retry is idempotent", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  await database.takoserverSqliteInitialize(AUTHORITY);
  const table = await migration(
    "008-retry.sql",
    "CREATE TABLE retry_once (id INTEGER PRIMARY KEY)",
  );
  const input = { authority: AUTHORITY, expectedPrefix: [], migrations: [table] };
  expect(await database.takoserverSqliteApplyMigrationSuffix(input)).toEqual({
    ok: true,
    value: undefined,
  });
  // Recreate the provider object to exercise the durable record after a restart.
  const restarted = new ManagedWorkerSqliteCore(state, {});
  expect(await restarted.takoserverSqliteApplyMigrationSuffix(input)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(
    state.database.query("SELECT name FROM sqlite_schema WHERE name = '__cf_kv'").all(),
  ).toEqual([]);
  expect(await restarted.takoserverSqliteInspect(AUTHORITY)).toEqual({
    ok: true,
    value: {
      state: "active",
      authority: AUTHORITY,
      migrations: [{ path: table.path, digest: table.digest }],
    },
  });
  expect(state.kvValues.size).toBe(1);
  expect(state.kvValues.has(MANAGED_SQLITE_CONTROL_KEY)).toBe(true);
});

test("customer SQL and the control KV record commit or roll back together", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  await database.takoserverSqliteInitialize(AUTHORITY);
  const first = await migration("009-first.sql", "CREATE TABLE first_row (value TEXT)");
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      authority: AUTHORITY,
      expectedPrefix: [],
      migrations: [first],
    }),
  ).toEqual({ ok: true, value: undefined });
  const second = await migration("010-second.sql", "CREATE TABLE rolled_back (value TEXT)");
  state.failNextKvPut = true;
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      authority: AUTHORITY,
      expectedPrefix: [{ path: first.path, digest: first.digest }],
      migrations: [second],
    }),
  ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
  expect(
    state.database.query("SELECT name FROM sqlite_schema WHERE name = 'rolled_back'").all(),
  ).toEqual([]);
  expect(await database.takoserverSqliteInspect(AUTHORITY)).toEqual({
    ok: true,
    value: {
      state: "active",
      authority: AUTHORITY,
      migrations: [{ path: first.path, digest: first.digest }],
    },
  });
});

test("destroy is idempotent, leaves a KV tombstone, and closes runtime RPC", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  await database.takoserverSqliteInitialize(AUTHORITY);
  const table = await migration("003-create.sql", "CREATE TABLE customer_data (value TEXT)");
  await database.takoserverSqliteApplyMigrationSuffix({
    authority: AUTHORITY,
    expectedPrefix: [],
    migrations: [table],
  });
  expect(await database.takoserverSqliteDestroy(AUTHORITY)).toEqual({
    ok: true,
    value: { destroyed: true },
  });
  expect(await database.takoserverSqliteDestroy(AUTHORITY)).toEqual({
    ok: true,
    value: { destroyed: true },
  });
  expect(await database.takoserverSqliteInspect(AUTHORITY)).toMatchObject({
    ok: true,
    value: { state: "destroyed" },
  });
  expect(state.kvValues.get(MANAGED_SQLITE_CONTROL_KEY)).toEqual({
    schema: MANAGED_SQLITE_CONTROL_SCHEMA,
    lifecycle: "destroyed",
    authority: AUTHORITY,
    migrations: [{ path: "003-create.sql", digest: table.digest }],
  });
  expect(await database.edgeSqlQuery({ sql: "SELECT 1" })).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  // `fetch` is inert on the Durable Object rather than on this core, and is
  // proved there against a real stub — see
  // `tests/cloudflare-managed-worker-sqlite-object.test.ts`.
});

test("runtime rejects schema and hidden KV access while former control names remain customer SQL", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  await database.takoserverSqliteInitialize(AUTHORITY);
  expect(await database.edgeSqlExecute({ sql: "CREATE TABLE nope (id INTEGER)" })).toEqual({
    ok: false,
    error: { code: "sql_error" },
  });
  // The runtime's own key-value table is `_cf_KV`, and `__cf_kv` is the name an
  // earlier reading used. Both are refused, and so are the `pragma_*`
  // table-valued functions, which answer where the `PRAGMA` keyword does not.
  for (const sql of [
    "SELECT * FROM __cf_kv",
    "SELECT * FROM _cf_KV",
    'SELECT * FROM "_cf_kv"',
    "SELECT * FROM _cf_METADATA",
    "SELECT name FROM pragma_table_list",
    "SELECT name FROM pragma_table_info('notes')",
    "SELECT * FROM pragma_database_list",
  ]) {
    expect({ sql, result: await database.edgeSqlQuery({ sql }) }).toEqual({
      sql,
      result: { ok: false, error: { code: "sql_error" } },
    });
  }
  // A migration is provider-supplied and may carry DDL, but it may not name
  // them either.
  const forbidden = await migration("004-pragma.sql", "CREATE TABLE t AS SELECT * FROM _cf_KV");
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      authority: AUTHORITY,
      expectedPrefix: [],
      migrations: [forbidden],
    }),
  ).toEqual({ ok: false, error: { code: "invalid_argument" } });
  const customerTable = await migration(
    "005-former-control-name.sql",
    'CREATE TABLE "_takoform_sqlite_migrations" (value TEXT)',
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      authority: AUTHORITY,
      expectedPrefix: [],
      migrations: [customerTable],
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(
    await database.edgeSqlExecute({
      sql: 'INSERT INTO "_takoform_sqlite_migrations" VALUES (?)',
      params: ["customer"],
    }),
  ).toMatchObject({ ok: true, value: { rowsWritten: 1 } });
  expect(
    await database.edgeSqlQuery({ sql: 'SELECT value FROM "_takoform_sqlite_migrations"' }),
  ).toEqual({
    ok: true,
    value: { rows: [{ value: "customer" }], rowsWritten: 0 },
  });
  expect(await database.takoserverSqliteInspect(AUTHORITY)).toMatchObject({
    ok: true,
    value: { state: "active", authority: AUTHORITY },
  });
});

test("former control-like names never expose or delete KV authority", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  await database.takoserverSqliteInitialize(AUTHORITY);

  const table = await migration(
    "006-former-identity.sql",
    'CREATE TABLE "_takoserver_sqlite_identity" (provider_id TEXT)',
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      authority: AUTHORITY,
      expectedPrefix: [],
      migrations: [table],
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(
    await database.edgeSqlExecute({
      sql: 'INSERT INTO "_takoserver_sqlite_identity" VALUES (?)',
      params: ["customer"],
    }),
  ).toMatchObject({ ok: true, value: { rowsWritten: 1 } });
  expect(
    await database.edgeSqlQuery({ sql: 'SELECT provider_id FROM "_takoserver_sqlite_identity"' }),
  ).toEqual({
    ok: true,
    value: { rows: [{ provider_id: "customer" }], rowsWritten: 0 },
  });
  expect(
    await database.edgeSqlExecute({ sql: 'DELETE FROM "_takoserver_sqlite_identity"' }),
  ).toMatchObject({
    ok: true,
    value: { rowsWritten: 1 },
  });
  expect(await database.takoserverSqliteInspect(AUTHORITY)).toMatchObject({
    ok: true,
    value: { state: "active", authority: AUTHORITY },
  });
});

test("migration SQL cannot address hidden/system SQLite storage", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  await database.takoserverSqliteInitialize(AUTHORITY);

  for (const sql of [
    "CREATE TABLE __cf_kv (id INTEGER)",
    "CREATE TABLE customer_notes (value TEXT); -- sqlite_schema",
    'CREATE TABLE customer_notes ("sqlite_master" TEXT)',
  ]) {
    const result = await database.takoserverSqliteApplyMigrationSuffix({
      authority: AUTHORITY,
      expectedPrefix: [],
      migrations: [await migration(`blocked-${sql.slice(0, 8)}.sql`, sql)],
    });
    expect(result).toEqual({ ok: false, error: { code: "invalid_argument" } });
  }
});

test("missing or malformed control metadata fails closed", async () => {
  const missing = new BunSqliteState();
  const missingDatabase = new ManagedWorkerSqliteCore(missing, {});
  expect(await missingDatabase.edgeSqlQuery({ sql: "SELECT 1" })).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(await missingDatabase.takoserverSqliteInspect(AUTHORITY)).toEqual({
    ok: false,
    error: { code: "not_found" },
  });

  const malformed = new BunSqliteState();
  malformed.kvValues.set(MANAGED_SQLITE_CONTROL_KEY, {
    schema: MANAGED_SQLITE_CONTROL_SCHEMA,
    lifecycle: "active",
    authority: AUTHORITY,
    migrations: [{ path: "not-valid", digest: "sha256:bad" }],
  });
  const malformedDatabase = new ManagedWorkerSqliteCore(malformed, {});
  expect(await malformedDatabase.edgeSqlQuery({ sql: "SELECT 1" })).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(await malformedDatabase.takoserverSqliteInspect(AUTHORITY)).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
});

test("legacy ordinary control names never become authority and block fresh reconciliation", async () => {
  const state = new BunSqliteState();
  state.database.exec('CREATE TABLE "_takoserver_sqlite_identity" (provider_id TEXT)');
  const database = new ManagedWorkerSqliteCore(state, {});
  expect(await database.takoserverSqliteInitialize(AUTHORITY)).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(state.kvValues.has(MANAGED_SQLITE_CONTROL_KEY)).toBe(false);
  expect(await database.takoserverSqliteInspect(AUTHORITY)).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
});

test("destroy drops customer objects with quoted names", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  await database.takoserverSqliteInitialize(AUTHORITY);
  const sql = [
    'CREATE TABLE "odd table""quoted" (value TEXT)',
    'CREATE INDEX "odd index""quoted" ON "odd table""quoted" (value)',
    'CREATE VIEW "odd view""quoted" AS SELECT value FROM "odd table""quoted"',
    'CREATE TRIGGER "odd trigger""quoted" AFTER INSERT ON "odd table""quoted" BEGIN SELECT 1; END',
  ].join(";\n");
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      authority: AUTHORITY,
      expectedPrefix: [],
      migrations: [await migration("004-quoted.sql", sql)],
    }),
  ).toEqual({ ok: true, value: undefined });

  expect(await database.takoserverSqliteDestroy(AUTHORITY)).toEqual({
    ok: true,
    value: { destroyed: true },
  });
  const leftovers = state.database
    .query(`SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' AND name <> '__cf_kv'`)
    .all() as {
    name: string;
  }[];
  expect(leftovers).toEqual([]);
});

test("a transaction envelope over the result ceiling is refused and rolls its writes back", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, {});
  await database.takoserverSqliteInitialize(AUTHORITY);
  const table = await migration(
    "007-wide.sql",
    "CREATE TABLE wide (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      authority: AUTHORITY,
      expectedPrefix: [],
      migrations: [table],
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(
    await database.edgeSqlExecute({
      sql: "INSERT INTO wide (id, body) VALUES (1, ?)",
      params: ["x".repeat(999_000)],
    }),
  ).toMatchObject({ ok: true });

  // Nine ~999 KB results are each far under the 8 MiB per-result ceiling; the
  // envelope carrying all nine is not. The wrapper refuses the same envelope on
  // the other side of the RPC — this proves the Durable Object refuses it too,
  // and that the write in the same transaction did not survive.
  const selects = Array.from({ length: 9 }, () => ({ sql: "SELECT body FROM wide" }));
  expect(
    await database.edgeSqlTransaction({
      statements: [
        { sql: "INSERT INTO wide (id, body) VALUES (2, ?)", params: ["second"] },
        ...selects,
      ],
    }),
  ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
  expect(await database.edgeSqlQuery({ sql: "SELECT count(*) AS total FROM wide" })).toEqual({
    ok: true,
    value: { rows: [{ total: 1 }], rowsWritten: 0 },
  });
});
