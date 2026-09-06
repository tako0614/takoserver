import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Miniflare } from "miniflare";

/**
 * The managed SQLite Durable Object, on a real runtime, called the way the
 * provider and the wrapper call it.
 *
 * This is the test that a fake storage cannot be: a Durable Object class that
 * does not extend `DurableObject` from `cloudflare:workers` is reachable only
 * through `fetch`, so every RPC method below would throw on a real stub however
 * correct its body is. `tests/cloudflare-managed-worker-sqlite.test.ts` proves
 * the behaviour; this proves the surface exists.
 */

const OBJECT_MODULE = resolve(
  import.meta.dir,
  "../src/providers/cloudflare-managed-worker-sqlite-object.ts",
);
const SQLITE_MODULE = resolve(
  import.meta.dir,
  "../src/providers/cloudflare-managed-worker-sqlite.ts",
);
const ADMIN_SECRET = "test-managed-sqlite-admin-secret";

const WORKER_SOURCE = `export { TakoserverManagedWorkerSqlite } from ${JSON.stringify(OBJECT_MODULE)};
import { managedWorkerSqliteAdminProof } from ${JSON.stringify(SQLITE_MODULE)};

const SECRET = ${JSON.stringify(ADMIN_SECRET)};
const seal = async (operation, authority) => ({
  authority,
  proof: await managedWorkerSqliteAdminProof({ secret: SECRET, operation, authority }),
});

const AUTHORITY = {
  providerId: "cloudflare",
  resourceUid: "resource-uid",
  generation: "1",
  operationId: "operation-1",
  descriptorDigest: "sha256:" + "a".repeat(64),
};

const OTHER_AUTHORITY = { ...AUTHORITY, operationId: "operation-2" };

export default {
  async fetch(_request, env) {
    const stub = env.SQLITE_DATABASES.getByName("tsdb-managed-sqlite-object-test");
    const payload = "x".repeat(36_000);
    const migrationSql = new TextEncoder().encode(
      [
        "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT NOT NULL)",
        "CREATE VIEW migration_payload_1 AS SELECT '" + payload + "' AS value",
        "CREATE VIEW migration_payload_2 AS SELECT '" + payload + "' AS value",
        "CREATE VIEW migration_payload_3 AS SELECT '" + payload + "' AS value",
      ].join(";\\n"),
    );
    const digestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", migrationSql));
    const digest =
      "sha256:" +
      [...digestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

    const uninitialized = await stub.edgeSqlExecute({ sql: "SELECT 1" });
    const unsealed = await stub.takoserverSqliteInitialize(AUTHORITY);
    const missing = await stub.takoserverSqliteInspect(await seal("inspect", AUTHORITY));
    const initialized = await stub.takoserverSqliteInitialize(await seal("initialize", AUTHORITY));
    const squatted = await stub.takoserverSqliteInitialize(
      await seal("initialize", OTHER_AUTHORITY),
    );
    const migrated = await stub.takoserverSqliteApplyMigrationSuffix({
      ...(await seal("apply-migration-suffix", AUTHORITY)),
      expectedPrefix: [],
      migrations: [{ path: "001-notes.sql", digest, sql: migrationSql }],
    });
    const inserted = await stub.edgeSqlExecute({
      sql: "INSERT INTO notes (body) VALUES (?)",
      params: ["from rpc"],
    });
    const queried = await stub.edgeSqlQuery({ sql: "SELECT body FROM notes" });
    const transacted = await stub.edgeSqlTransaction({
      statements: [
        { sql: "INSERT INTO notes (body) VALUES (?)", params: ["second"] },
        { sql: "SELECT count(*) AS total FROM notes" },
      ],
    });
    const pragmaRefused = await stub.edgeSqlQuery({
      sql: "SELECT name FROM pragma_table_list",
    });
    const ledger = await stub.takoserverSqliteReadMigrationLedger(
      await seal("read-migration-ledger", AUTHORITY),
    );
    const inspected = await stub.takoserverSqliteInspect(await seal("inspect", AUTHORITY));
    const noOpSql = new TextEncoder().encode("SELECT 1");
    const noOpDigestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", noOpSql));
    const noOpDigest =
      "sha256:" +
      [...noOpDigestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const emptySql = new Uint8Array();
    const emptyDigestBytes = new Uint8Array(await crypto.subtle.digest("SHA-256", emptySql));
    const emptyDigest =
      "sha256:" +
      [...emptyDigestBytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
    const largeMigrations = Array.from({ length: 1_200 }, (_, index) => ({
      path:
        "migrations/" +
        String(index + 2).padStart(4, "0") +
        "-" +
        "x".repeat(64) +
        ".sql",
      digest: index === 0 ? emptyDigest : noOpDigest,
      sql: index === 0 ? emptySql : noOpSql,
    }));
    const largeMigrated = await stub.takoserverSqliteApplyMigrationSuffix({
      ...(await seal("apply-migration-suffix", AUTHORITY)),
      expectedPrefix: [{ path: "001-notes.sql", digest }],
      migrations: largeMigrations,
    });
    const largeLedger = await stub.takoserverSqliteReadMigrationLedger(
      await seal("read-migration-ledger", AUTHORITY),
    );
    const largeControlBytes =
      largeLedger.ok
        ? new TextEncoder().encode(
            JSON.stringify({
              schema: "takoserver.managed-sqlite-control@v2",
              lifecycle: "active",
              authority: AUTHORITY,
              migrations: largeLedger.value,
            }),
          ).byteLength
        : 0;
    const httpStatus = (await stub.fetch(new Request("https://do.invalid/admin"))).status;
    const destroyed = await stub.takoserverSqliteDestroy(await seal("destroy", AUTHORITY));
    const afterDestroy = await stub.edgeSqlExecute({ sql: "SELECT 1" });

    return Response.json({
      uninitialized,
      unsealed,
      missing,
      initialized,
      squatted,
      migrationBytes: migrationSql.byteLength,
      migrated,
      inserted,
      queried,
      transacted,
      pragmaRefused,
      ledger,
      inspected,
      largeHistory: {
        migrated: largeMigrated,
        ledgerOk: largeLedger.ok,
        ledgerEntries: largeLedger.ok ? largeLedger.value.length : 0,
        zeroByteLedgered: largeLedger.ok && largeLedger.value[1]?.digest === emptyDigest,
        lastPath: largeLedger.ok ? largeLedger.value.at(-1)?.path : undefined,
        controlBytes: largeControlBytes,
      },
      httpStatus,
      destroyed,
      afterDestroy,
    });
  },
};
`;

async function bundledWorker(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-managed-sqlite-object-"));
  try {
    const entry = join(root, "worker.ts");
    await Bun.write(entry, WORKER_SOURCE);
    const built = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      external: ["cloudflare:workers"],
    });
    if (!built.success) throw new AggregateError(built.logs, "managed SQLite DO bundle failed");
    const output = built.outputs[0];
    if (!output) throw new Error("managed SQLite DO bundle produced no module");
    return await output.text();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("the managed SQLite Durable Object answers every RPC method on real workerd", async () => {
  const contents = await bundledWorker();
  expect(contents).toContain('from "cloudflare:workers"');
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "managed-sqlite-object-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents } },
          },
          exports: {
            TakoserverManagedWorkerSqlite: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET: { type: "text", value: ADMIN_SECRET },
            SQLITE_DATABASES: {
              type: "durable-object",
              workerName: "managed-sqlite-object-test",
              exportName: "TakoserverManagedWorkerSqlite",
            },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    const response = await runtime.dispatchFetch("https://worker.example/");
    const text = await response.text();
    expect({ status: response.status, text }).toMatchObject({ status: 200 });
    const body = JSON.parse(text);
    expect(body).toEqual({
      // Runtime SQL before an authority exists is refused, not answered.
      uninitialized: { ok: false, error: { code: "backend_unavailable" } },
      // The authority tuple alone claims nothing: the admin plane wants the
      // proof only the gateway's secret binding can produce.
      unsealed: { ok: false, error: { code: "invalid_argument" } },
      missing: { ok: false, error: { code: "not_found" } },
      initialized: { ok: true, value: { state: "active" } },
      // A second authority on a claimed instance is a conflict, never a
      // silent re-claim.
      squatted: { ok: false, error: { code: "conflict" } },
      // One artifact file is larger than workerd's 100 KB per-statement
      // ceiling, but each of its four native statements is comfortably below
      // it. The stable sql.exec path receives the exact precomputed slices.
      migrationBytes: expect.any(Number),
      migrated: { ok: true },
      inserted: { ok: true, value: { rows: [], rowsWritten: 1 } },
      queried: { ok: true, value: { rows: [{ body: "from rpc" }], rowsWritten: 0 } },
      transacted: {
        ok: true,
        value: {
          results: [
            { rows: [], rowsWritten: 1 },
            { rows: [{ total: 2 }], rowsWritten: 0 },
          ],
        },
      },
      // The `pragma_*` table-valued functions are denied like `PRAGMA` itself.
      pragmaRefused: { ok: false, error: { code: "sql_error" } },
      ledger: {
        ok: true,
        value: [{ path: "001-notes.sql", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) }],
      },
      inspected: {
        ok: true,
        value: {
          state: "active",
          authority: {
            providerId: "cloudflare",
            resourceUid: "resource-uid",
            generation: "1",
            operationId: "operation-1",
            descriptorDigest: `sha256:${"a".repeat(64)}`,
          },
          migrations: [
            { path: "001-notes.sql", digest: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u) },
          ],
        },
      },
      // This is one actual workerd RPC and one SQLite-backed DO KV record, not
      // the Bun fake. Its history is above the former 100-entry cap and its
      // serialized v2 control record is above the legacy 128 KiB KV ceiling.
      largeHistory: {
        migrated: { ok: true },
        ledgerOk: true,
        ledgerEntries: 1_201,
        zeroByteLedgered: true,
        lastPath: `migrations/1201-${"x".repeat(64)}.sql`,
        controlBytes: expect.any(Number),
      },
      // `fetch` stays inert: no HTTP path reaches customer tables.
      httpStatus: 404,
      destroyed: { ok: true, value: { destroyed: true } },
      afterDestroy: { ok: false, error: { code: "backend_unavailable" } },
    });
    expect(body.migrationBytes).toBeGreaterThan(100_000);
    expect(body.largeHistory.controlBytes).toBeGreaterThan(128 * 1_024);
  } finally {
    await runtime.dispose();
  }
}, 60_000);
