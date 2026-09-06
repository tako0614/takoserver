import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  MANAGED_SQLITE_ADMIN_SECRET_BINDING,
  MANAGED_SQLITE_CONTROL_KEY,
  MANAGED_SQLITE_CONTROL_SCHEMA,
  type ManagedWorkerSqliteAdminOperation,
  type ManagedWorkerSqliteAuthority,
  ManagedWorkerSqliteCore,
  type ManagedWorkerSqliteState,
  type ManagedWorkerSqliteStorage,
  managedWorkerSqliteAdminProof,
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
  failKvPutAt: number | undefined;
  kvPutCount = 0;
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
        this.kvPutCount += 1;
        if (this.failNextKvPut || this.kvPutCount === this.failKvPutAt) {
          this.failNextKvPut = false;
          this.failKvPutAt = undefined;
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

/** Stands in for the gateway's `TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET` binding. */
const ADMIN_SECRET = "test-managed-sqlite-admin-secret";
const ADMIN_ENV = { [MANAGED_SQLITE_ADMIN_SECRET_BINDING]: ADMIN_SECRET };

/** Every admin call carries a proof sealed for that exact operation. */
async function sealed(
  operation: ManagedWorkerSqliteAdminOperation,
  authority: ManagedWorkerSqliteAuthority = AUTHORITY,
) {
  return {
    authority,
    proof: await managedWorkerSqliteAdminProof({ secret: ADMIN_SECRET, operation, authority }),
  };
}

async function migration(path: string, sql: string) {
  return await migrationBytes(path, new TextEncoder().encode(sql));
}

async function migrationBytes(path: string, bytes: Uint8Array) {
  const digest = `sha256:${[
    ...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource)),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")}` as const;
  return { path, digest, sql: bytes };
}

function utf8Bytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

function migrationIdentitiesWithSerializedBytes(targetBytes: number) {
  const entries: { path: string; digest: `sha256:${string}` }[] = [];
  const digest = `sha256:${"f".repeat(64)}` as const;
  let serializedBytes = 2; // []
  for (let index = 0; serializedBytes < targetBytes; index += 1) {
    const prefix = `m${index.toString().padStart(5, "0")}-`;
    const maximumPath = `${prefix}${"x".repeat(255 - prefix.length)}`;
    const maximumEntry = { path: maximumPath, digest };
    const separatorBytes = entries.length === 0 ? 0 : 1;
    const maximumAdded = separatorBytes + utf8Bytes(maximumEntry);
    if (serializedBytes + maximumAdded <= targetBytes) {
      entries.push(maximumEntry);
      serializedBytes += maximumAdded;
      continue;
    }

    const minimumEntry = { path: prefix, digest };
    const minimumAdded = separatorBytes + utf8Bytes(minimumEntry);
    const remaining = targetBytes - serializedBytes;
    if (remaining < minimumAdded) {
      const previous = entries.at(-1);
      if (!previous) throw new Error("cannot derive exact migration projection size");
      const reduction = minimumAdded - remaining;
      if (previous.path.length - reduction < 1) {
        throw new Error("cannot derive exact migration projection size");
      }
      previous.path = previous.path.slice(0, -reduction);
      serializedBytes -= reduction;
    }
    const finalPathBytes = targetBytes - serializedBytes - minimumAdded;
    if (finalPathBytes < 0 || prefix.length + finalPathBytes > 255) {
      throw new Error("cannot derive exact migration projection size");
    }
    entries.push({ path: `${prefix}${"x".repeat(finalPathBytes)}`, digest });
    serializedBytes = targetBytes;
  }
  if (utf8Bytes(entries) !== targetBytes) {
    throw new Error("migration projection did not reach the requested serialized size");
  }
  return entries;
}

function neutralMigrationSql(targetBytes: number): string {
  const prefix = `${[
    "CREATE TABLE migration_effects (sequence INTEGER PRIMARY KEY)",
    "CREATE TABLE first_file_statements (sequence INTEGER PRIMARY KEY)",
    ...Array.from(
      { length: 500 },
      (_, index) => `INSERT INTO first_file_statements VALUES (${index + 1})`,
    ),
  ].join(";\n")};\n`;
  const finalStatement = "INSERT INTO migration_effects VALUES (1)";
  const fixedBytes = new TextEncoder().encode(`${prefix}/**/\n${finalStatement}`).byteLength;
  const paddingBytes = targetBytes - fixedBytes;
  if (paddingBytes < 0) throw new Error("neutral migration target is too small");
  const sql = `${prefix}/*${"x".repeat(paddingBytes)}*/\n${finalStatement}`;
  if (new TextEncoder().encode(sql).byteLength !== targetBytes) {
    throw new Error("neutral migration did not reach the requested byte size");
  }
  return sql;
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
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  expect(await database.takoserverSqliteInitialize(await sealed("initialize"))).toEqual({
    ok: true,
    value: { state: "active" },
  });
  const table = await migration(
    "001-create.sql",
    "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT)",
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
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
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));
  const table = await migration(
    "002-create.sql",
    "CREATE TABLE events (id INTEGER PRIMARY KEY, value TEXT NOT NULL)",
  );
  await database.takoserverSqliteApplyMigrationSuffix({
    ...(await sealed("apply-migration-suffix")),
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
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));
  const table = await migration(
    "008-retry.sql",
    "CREATE TABLE retry_once (id INTEGER PRIMARY KEY)",
  );
  const input = {
    ...(await sealed("apply-migration-suffix")),
    expectedPrefix: [],
    migrations: [table],
  };
  expect(await database.takoserverSqliteApplyMigrationSuffix(input)).toEqual({
    ok: true,
    value: undefined,
  });
  // Recreate the provider object to exercise the durable record after a restart.
  const restarted = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  expect(await restarted.takoserverSqliteApplyMigrationSuffix(input)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(
    state.database.query("SELECT name FROM sqlite_schema WHERE name = '__cf_kv'").all(),
  ).toEqual([]);
  expect(await restarted.takoserverSqliteInspect(await sealed("inspect"))).toEqual({
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
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));
  const first = await migration("009-first.sql", "CREATE TABLE first_row (value TEXT)");
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [],
      migrations: [first],
    }),
  ).toEqual({ ok: true, value: undefined });
  const second = await migration("010-second.sql", "CREATE TABLE rolled_back (value TEXT)");
  state.failNextKvPut = true;
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [{ path: first.path, digest: first.digest }],
      migrations: [second],
    }),
  ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
  expect(
    state.database.query("SELECT name FROM sqlite_schema WHERE name = 'rolled_back'").all(),
  ).toEqual([]);
  expect(await database.takoserverSqliteInspect(await sealed("inspect"))).toEqual({
    ok: true,
    value: {
      state: "active",
      authority: AUTHORITY,
      migrations: [{ path: first.path, digest: first.digest }],
    },
  });
});

test("a zero-byte migration atomically records its artifact identity", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));
  const empty = await migrationBytes("migrations/0001-empty.sql", new Uint8Array());
  const request = {
    ...(await sealed("apply-migration-suffix")),
    expectedPrefix: [],
    migrations: [empty],
  };

  state.failNextKvPut = true;
  expect(await database.takoserverSqliteApplyMigrationSuffix(request)).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(
    await database.takoserverSqliteReadMigrationLedger(await sealed("read-migration-ledger")),
  ).toEqual({ ok: true, value: [] });

  expect(await database.takoserverSqliteApplyMigrationSuffix(request)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(
    await database.takoserverSqliteReadMigrationLedger(await sealed("read-migration-ledger")),
  ).toEqual({
    ok: true,
    value: [{ path: empty.path, digest: empty.digest }],
  });
});

test("a 105-file suffix commits per file and an exact partial retry resumes without replay", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));

  // This is a neutral generated analogue of the real 107,748-byte baseline,
  // with hundreds of statements but no application SQL copied into this repo.
  const firstFileSql = neutralMigrationSql(107_748);
  expect(new TextEncoder().encode(firstFileSql).byteLength).toBe(107_748);
  const migrations = await Promise.all([
    migration("migrations/0001-long-file.sql", firstFileSql),
    ...Array.from({ length: 104 }, (_, index) =>
      migration(
        `migrations/${(index + 2).toString().padStart(4, "0")}.sql`,
        `INSERT INTO migration_effects VALUES (${index + 2})`,
      ),
    ),
  ]);

  // Initialization was KV put 1. Fail the ledger append for file 103 after
  // files 1..102 have each committed their SQL and identity independently.
  state.failKvPutAt = state.kvPutCount + 103;
  const exactSuffix = {
    ...(await sealed("apply-migration-suffix")),
    expectedPrefix: [],
    migrations,
  };
  expect(await database.takoserverSqliteApplyMigrationSuffix(exactSuffix)).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  const partial = await database.takoserverSqliteReadMigrationLedger(
    await sealed("read-migration-ledger"),
  );
  expect(partial).toMatchObject({ ok: true });
  if (!partial.ok) throw new Error("expected a readable partial migration ledger");
  expect(partial.value).toEqual(
    migrations.slice(0, 102).map(({ path, digest }) => ({ path, digest })),
  );
  expect(
    state.database.query("SELECT sequence FROM migration_effects ORDER BY sequence").all(),
  ).toEqual(Array.from({ length: 102 }, (_, index) => ({ sequence: index + 1 })));

  // This is the identical original request, including expectedPrefix: []. The
  // recorded 102-entry prefix is recognized as progress within that request,
  // so replaying any INSERT would violate the primary key instead of succeeding.
  expect(await database.takoserverSqliteApplyMigrationSuffix(exactSuffix)).toEqual({
    ok: true,
    value: undefined,
  });
  expect(
    await database.takoserverSqliteReadMigrationLedger(await sealed("read-migration-ledger")),
  ).toEqual({
    ok: true,
    value: migrations.map(({ path, digest }) => ({ path, digest })),
  });
  expect(
    state.database.query("SELECT sequence FROM migration_effects ORDER BY sequence").all(),
  ).toEqual(Array.from({ length: 105 }, (_, index) => ({ sequence: index + 1 })));
});

test("the complete migration input is validated before its first tenant statement", async () => {
  const aggregateLimit = 10_485_760;
  const invalidUtf8 = await migrationBytes("migrations/0002-invalid-utf8.sql", Uint8Array.of(0xff));
  const aggregateBytes = new TextEncoder().encode(`--${"x".repeat(aggregateLimit - 2)}`);
  expect(aggregateBytes.byteLength).toBe(aggregateLimit);
  const scenarios = [
    {
      name: "path",
      second: await migration("migrations/../escape.sql", "SELECT 1"),
    },
    {
      name: "digest",
      second: {
        ...(await migration("migrations/0002-digest.sql", "SELECT 1")),
        digest: `sha256:${"0".repeat(64)}` as const,
      },
    },
    { name: "UTF-8", second: invalidUtf8 },
    {
      name: "unique path",
      second: await migration("migrations/0001-first.sql", "SELECT 1"),
    },
    {
      name: "aggregate bytes",
      second: await migrationBytes("migrations/0002-aggregate.sql", aggregateBytes),
    },
    {
      name: "protected storage",
      second: await migration(
        "migrations/0002-protected.sql",
        "CREATE TABLE leaked_control AS SELECT * FROM _cf_KV",
      ),
    },
    {
      name: "transaction escape",
      second: await migration(
        "migrations/0002-transaction.sql",
        "BEGIN; CREATE TABLE escaped_transaction (value TEXT); COMMIT",
      ),
    },
    {
      name: "BOM transaction escape",
      second: await migration(
        "migrations/0002-bom-transaction.sql",
        "SELECT 1;\ufeffBEGIN; CREATE TABLE escaped_bom (value TEXT); COMMIT",
      ),
    },
  ];

  for (const scenario of scenarios) {
    const state = new BunSqliteState();
    const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
    await database.takoserverSqliteInitialize(await sealed("initialize"));
    const first = await migration(
      "migrations/0001-first.sql",
      "CREATE TABLE must_not_exist (value TEXT)",
    );
    const result = await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [],
      migrations: [first, scenario.second],
    });
    expect({ name: scenario.name, result }).toEqual({
      name: scenario.name,
      result: { ok: false, error: { code: "invalid_argument" } },
    });
    expect({
      name: scenario.name,
      table: state.database
        .query("SELECT name FROM sqlite_schema WHERE name = 'must_not_exist'")
        .all(),
    }).toEqual({ name: scenario.name, table: [] });
    expect({
      name: scenario.name,
      ledger: await database.takoserverSqliteReadMigrationLedger(
        await sealed("read-migration-ledger"),
      ),
    }).toEqual({ name: scenario.name, ledger: { ok: true, value: [] } });
  }
});

test("a later statement failure rolls back its whole file and corrected SQL can retry", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));

  const failing = await migration(
    "migrations/0001-atomic.sql",
    [
      "CREATE TABLE file_atomic (value INTEGER PRIMARY KEY)",
      "CREATE TABLE file_atomic_audit (value INTEGER NOT NULL)",
      "CREATE \ufeffTRIGGER file_atomic_insert AFTER INSERT ON file_atomic BEGIN " +
        "INSERT INTO file_atomic_audit VALUES (CASE WHEN NEW.value > 0 THEN NEW.value ELSE 0 END); END",
      "INSERT INTO file_atomic VALUES (1)",
      "INSERT INTO file_atomic VALUES (1)",
    ].join(";\n"),
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [],
      migrations: [failing],
    }),
  ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
  expect(
    state.database.query("SELECT name FROM sqlite_schema WHERE name = 'file_atomic'").all(),
  ).toEqual([]);
  expect(
    await database.takoserverSqliteReadMigrationLedger(await sealed("read-migration-ledger")),
  ).toEqual({ ok: true, value: [] });

  const corrected = await migration(
    "migrations/0001-atomic.sql",
    [
      "CREATE TABLE file_atomic (value INTEGER PRIMARY KEY)",
      "CREATE TABLE file_atomic_audit (value INTEGER NOT NULL)",
      "CREATE \ufeffTRIGGER file_atomic_insert AFTER INSERT ON file_atomic BEGIN " +
        "INSERT INTO file_atomic_audit VALUES (CASE WHEN NEW.value > 0 THEN NEW.value ELSE 0 END); END",
      "INSERT INTO file_atomic VALUES (1)",
      "INSERT INTO file_atomic VALUES (2)",
    ].join(";\n"),
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [],
      migrations: [corrected],
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(state.database.query("SELECT value FROM file_atomic ORDER BY value").all()).toEqual([
    { value: 1 },
    { value: 2 },
  ]);
  expect(state.database.query("SELECT value FROM file_atomic_audit ORDER BY value").all()).toEqual([
    { value: 1 },
    { value: 2 },
  ]);
  expect(
    await database.takoserverSqliteReadMigrationLedger(await sealed("read-migration-ledger")),
  ).toEqual({
    ok: true,
    value: [{ path: corrected.path, digest: corrected.digest }],
  });
});

test("an over-capacity native statement is refused before an earlier file executes", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));
  const first = await migration(
    "migrations/0001-must-not-run.sql",
    "CREATE TABLE must_not_run (value TEXT)",
  );
  const overCapacity = await migration(
    "migrations/0002-over-capacity.sql",
    `SELECT '${"x".repeat(100_000)}'`,
  );

  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [],
      migrations: [first, overCapacity],
    }),
  ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
  expect(
    state.database.query("SELECT name FROM sqlite_schema WHERE name = 'must_not_run'").all(),
  ).toEqual([]);
  expect(
    await database.takoserverSqliteReadMigrationLedger(await sealed("read-migration-ledger")),
  ).toEqual({ ok: true, value: [] });
});

test("the v2 control record bound is the admitted manifest projection plus exact authority overhead", async () => {
  const manifestProjectionBytes = 1_048_576;
  const migrations = migrationIdentitiesWithSerializedBytes(manifestProjectionBytes);
  expect(migrations.length).toBeLessThanOrEqual(16_384);
  const maximumAuthority = {
    providerId: "a".repeat(512),
    resourceUid: "b".repeat(512),
    generation: "9".repeat(19),
    operationId: "c".repeat(512),
    descriptorDigest: `sha256:${"d".repeat(64)}` as const,
  };
  const record = {
    schema: MANAGED_SQLITE_CONTROL_SCHEMA,
    lifecycle: "destroyed" as const,
    authority: maximumAuthority,
    migrations,
  };
  expect(utf8Bytes(record.migrations)).toBe(manifestProjectionBytes);
  // The exact maximum envelope overhead is 1,815 bytes: fixed v2 fields plus
  // the longest valid authority and lifecycle, excluding the migrations [].
  expect(utf8Bytes(record)).toBe(1_050_391);
  expect(utf8Bytes(record)).toBeLessThan(2 * 1_024 * 1_024);

  const atLimit = new BunSqliteState();
  atLimit.kvValues.set(MANAGED_SQLITE_CONTROL_KEY, record);
  const database = new ManagedWorkerSqliteCore(atLimit, ADMIN_ENV);
  expect(
    await database.takoserverSqliteInspect(await sealed("inspect", maximumAuthority)),
  ).toMatchObject({
    ok: true,
    value: { state: "destroyed", authority: maximumAuthority },
  });

  const overLimit = structuredClone(record);
  const extendable = overLimit.migrations.find((entry) => entry.path.length < 255);
  if (!extendable) throw new Error("expected one extendable migration path");
  extendable.path += "x";
  expect(utf8Bytes(overLimit.migrations)).toBe(manifestProjectionBytes + 1);
  const malformed = new BunSqliteState();
  malformed.kvValues.set(MANAGED_SQLITE_CONTROL_KEY, overLimit);
  const malformedDatabase = new ManagedWorkerSqliteCore(malformed, ADMIN_ENV);
  expect(
    await malformedDatabase.takoserverSqliteInspect(await sealed("inspect", maximumAuthority)),
  ).toEqual({ ok: false, error: { code: "backend_unavailable" } });
});

test("destroy is idempotent, leaves a KV tombstone, and closes runtime RPC", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));
  const table = await migration("003-create.sql", "CREATE TABLE customer_data (value TEXT)");
  await database.takoserverSqliteApplyMigrationSuffix({
    ...(await sealed("apply-migration-suffix")),
    expectedPrefix: [],
    migrations: [table],
  });
  expect(await database.takoserverSqliteDestroy(await sealed("destroy"))).toEqual({
    ok: true,
    value: { destroyed: true },
  });
  expect(await database.takoserverSqliteDestroy(await sealed("destroy"))).toEqual({
    ok: true,
    value: { destroyed: true },
  });
  expect(await database.takoserverSqliteInspect(await sealed("inspect"))).toMatchObject({
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

test("runtime rejects schema and hidden KV access and migrations cannot mint a ledger-like table", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));
  expect(await database.edgeSqlExecute({ sql: "CREATE TABLE nope (id INTEGER)" })).toEqual({
    ok: false,
    error: { code: "sql_error" },
  });
  expect(await database.edgeSqlQuery({ sql: `SELECT '${"x".repeat(100_000)}'` })).toEqual({
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
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [],
      migrations: [forbidden],
    }),
  ).toEqual({ ok: false, error: { code: "invalid_argument" } });
  const ledgerLikeTable = await migration(
    "005-ledger-like-name.sql",
    'CREATE TABLE "_takoform_sqlite_migrations" (value TEXT)',
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [],
      migrations: [ledgerLikeTable],
    }),
  ).toEqual({ ok: false, error: { code: "invalid_argument" } });
  expect(
    state.database
      .query("SELECT name FROM sqlite_schema WHERE name = '_takoform_sqlite_migrations'")
      .all(),
  ).toEqual([]);
  expect(await database.takoserverSqliteInspect(await sealed("inspect"))).toMatchObject({
    ok: true,
    value: { state: "active", authority: AUTHORITY },
  });
});

test("former control-like names never expose or delete KV authority", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));

  const table = await migration(
    "006-former-identity.sql",
    'CREATE TABLE "_takoserver_sqlite_identity" (provider_id TEXT)',
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
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
  expect(await database.takoserverSqliteInspect(await sealed("inspect"))).toMatchObject({
    ok: true,
    value: { state: "active", authority: AUTHORITY },
  });
});

test("migration SQL cannot address hidden/system SQLite storage", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));

  for (const sql of [
    "CREATE TABLE __cf_kv (id INTEGER)",
    "CREATE TABLE customer_notes (value TEXT); -- sqlite_schema",
    'CREATE TABLE customer_notes ("sqlite_master" TEXT)',
  ]) {
    const result = await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [],
      migrations: [await migration(`blocked-${sql.slice(0, 8)}.sql`, sql)],
    });
    expect(result).toEqual({ ok: false, error: { code: "invalid_argument" } });
  }
});

test("missing or malformed control metadata fails closed", async () => {
  const missing = new BunSqliteState();
  const missingDatabase = new ManagedWorkerSqliteCore(missing, ADMIN_ENV);
  expect(await missingDatabase.edgeSqlQuery({ sql: "SELECT 1" })).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(await missingDatabase.takoserverSqliteInspect(await sealed("inspect"))).toEqual({
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
  const malformedDatabase = new ManagedWorkerSqliteCore(malformed, ADMIN_ENV);
  expect(await malformedDatabase.edgeSqlQuery({ sql: "SELECT 1" })).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(await malformedDatabase.takoserverSqliteInspect(await sealed("inspect"))).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
});

test("legacy ordinary control names never become authority and block fresh reconciliation", async () => {
  const state = new BunSqliteState();
  state.database.exec('CREATE TABLE "_takoserver_sqlite_identity" (provider_id TEXT)');
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  expect(await database.takoserverSqliteInitialize(await sealed("initialize"))).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
  expect(state.kvValues.has(MANAGED_SQLITE_CONTROL_KEY)).toBe(false);
  expect(await database.takoserverSqliteInspect(await sealed("inspect"))).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
});

test("destroy drops customer objects with quoted names", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));
  const sql = [
    'CREATE TABLE "odd table""quoted" (value TEXT)',
    'CREATE INDEX "odd index""quoted" ON "odd table""quoted" (value)',
    'CREATE VIEW "odd view""quoted" AS SELECT value FROM "odd table""quoted"',
    'CREATE TRIGGER "odd trigger""quoted" AFTER INSERT ON "odd table""quoted" BEGIN SELECT 1; END',
  ].join(";\n");
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
      expectedPrefix: [],
      migrations: [await migration("004-quoted.sql", sql)],
    }),
  ).toEqual({ ok: true, value: undefined });

  expect(await database.takoserverSqliteDestroy(await sealed("destroy"))).toEqual({
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
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);
  await database.takoserverSqliteInitialize(await sealed("initialize"));
  const table = await migration(
    "007-wide.sql",
    "CREATE TABLE wide (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
  );
  expect(
    await database.takoserverSqliteApplyMigrationSuffix({
      ...(await sealed("apply-migration-suffix")),
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

test("the admin plane is provider-only: no proof, wrong operation, and no secret all refuse", async () => {
  const state = new BunSqliteState();
  const database = new ManagedWorkerSqliteCore(state, ADMIN_ENV);

  // Every field of an authority tuple is derivable by the customer whose
  // Resource it describes, so the tuple alone claims nothing.
  expect(await database.takoserverSqliteInitialize(AUTHORITY)).toEqual({
    ok: false,
    error: { code: "invalid_argument" },
  });
  expect(
    await database.takoserverSqliteInitialize({
      authority: AUTHORITY,
      proof: "z".repeat(43),
    }),
  ).toEqual({ ok: false, error: { code: "invalid_argument" } });
  // A proof names one operation: an inspect proof does not initialize.
  expect(await database.takoserverSqliteInitialize(await sealed("inspect"))).toEqual({
    ok: false,
    error: { code: "invalid_argument" },
  });
  // Nor does a proof over a different authority.
  expect(
    await database.takoserverSqliteInitialize({
      authority: AUTHORITY,
      proof: (await sealed("initialize", { ...AUTHORITY, resourceUid: "other-uid" })).proof,
    }),
  ).toEqual({ ok: false, error: { code: "invalid_argument" } });
  expect(state.kvValues.get(MANAGED_SQLITE_CONTROL_KEY)).toBeUndefined();

  expect(await database.takoserverSqliteInitialize(await sealed("initialize"))).toEqual({
    ok: true,
    value: { state: "active" },
  });
  for (const call of [
    database.takoserverSqliteInspect(AUTHORITY),
    database.takoserverSqliteReadMigrationLedger(AUTHORITY),
    database.takoserverSqliteDestroy(await sealed("inspect")),
  ]) {
    expect(await call).toEqual({ ok: false, error: { code: "invalid_argument" } });
  }
  expect(await database.takoserverSqliteInspect(await sealed("inspect"))).toMatchObject({
    ok: true,
    value: { state: "active" },
  });

  // A Host that never provisioned the gateway secret executes no admin
  // operation at all rather than trusting what the caller sent.
  const unconfigured = new ManagedWorkerSqliteCore(new BunSqliteState(), {});
  expect(await unconfigured.takoserverSqliteInitialize(await sealed("initialize"))).toEqual({
    ok: false,
    error: { code: "backend_unavailable" },
  });
});

test("an admin proof is bound to the exact operation and authority it seals", async () => {
  const authority = { ...AUTHORITY, resourceUid: "other-uid" };
  const first = await managedWorkerSqliteAdminProof({
    secret: ADMIN_SECRET,
    operation: "destroy",
    authority: AUTHORITY,
  });
  expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/u);
  expect(
    await managedWorkerSqliteAdminProof({
      secret: ADMIN_SECRET,
      operation: "destroy",
      authority: AUTHORITY,
    }),
  ).toBe(first);
  for (const other of [
    { secret: `${ADMIN_SECRET}-2`, operation: "destroy" as const, authority: AUTHORITY },
    { secret: ADMIN_SECRET, operation: "inspect" as const, authority },
    { secret: ADMIN_SECRET, operation: "destroy" as const, authority },
    // The length prefix is what stops a byte moving across a field boundary
    // from producing the same proof.
    {
      secret: ADMIN_SECRET,
      operation: "destroy" as const,
      authority: { ...AUTHORITY, providerId: "cloudflar", resourceUid: "eresource-uid" },
    },
  ]) {
    expect(await managedWorkerSqliteAdminProof(other)).not.toBe(first);
  }
});
