import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import { SELFHOST_DATA_PLANE_SQL_PATH } from "../src/providers/selfhost-worker-wrapper.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const TARGET = "selfhost-v2-worker-primary";

test("SQLite broker boot requires an existing key and stable port before owner restore", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-sqlite-boot-"));
  const stagingRoot = join(root, "sql-input-staging");
  await mkdir(stagingRoot, { mode: 0o700 });
  const database = new Database(join(root, "control.sqlite"));
  let composition: ReturnType<typeof createSelfhostV2WorkerComposition> | undefined;
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const store = createSelfhostV2SQLiteStore({
      root: join(root, "sqlite-custody"),
      sql,
      targetKey: TARGET,
    });
    const objects = createMemoryObjectStore();
    const clock = () => new Date();
    const config = {
      cursorSigningKey: new Uint8Array(32).fill(0x51),
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    };
    const options = {
      sql,
      objects,
      clock,
      config,
      rootDirectory: join(root, "v2-worker-owners"),
      targetKey: TARGET,
      workerdBinary: null,
    };
    expect(() =>
      createSelfhostV2WorkerComposition({
        ...options,
        sqliteBinding: { store, stagingRoot, signingKey: new Uint8Array(32), privatePort: 0 },
      }),
    ).toThrow(TypeError);
    expect(() =>
      createSelfhostV2WorkerComposition({
        ...options,
        sqliteBinding: { store, stagingRoot, signingKey: new Uint8Array(31), privatePort: 12345 },
      }),
    ).toThrow(TypeError);
    const reservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    const privatePort = reservation.port;
    await reservation.stop(true);
    if (!privatePort) throw new Error("fixture private port unavailable");
    const supplied = { store, stagingRoot, signingKey: new Uint8Array(32).fill(0x58), privatePort };
    composition = createSelfhostV2WorkerComposition({ ...options, sqliteBinding: supplied });
    supplied.privatePort = 1;
    supplied.signingKey.fill(0);
    expect(await composition.restoreOwners()).toEqual([]);
    const response = await fetch(`http://127.0.0.1:${privatePort}${SELFHOST_DATA_PLANE_SQL_PATH}`, {
      method: "POST",
      body: "{}",
    });
    expect(response.status).toBe(401);
  } finally {
    await composition?.closePrivateBindingServices();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
