import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostV2WorkerComposition } from "../src/selfhost-v2-worker-composition.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

test("a v2 composition with no opened owners reports zero counts and never opens one", async () => {
  const root = await mkdtemp(join(tmpdir(), "selfhost-v2-owner-health-"));
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const composition = createSelfhostV2WorkerComposition({
      sql: createSqliteSql(database),
      objects: createMemoryObjectStore(),
      clock: () => new Date(),
      config: {
        cursorSigningKey: new Uint8Array(32).fill(0x51),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/authentication",
      },
      rootDirectory: join(root, "v2-worker-owners"),
      targetKey: "selfhost-v2-worker-primary",
      workerdBinary: null,
    });
    expect(await composition.restoreOwners()).toEqual([]);
    expect(await composition.observeOwnerHealth()).toEqual({
      owners: 0,
      serving: 0,
      unavailable: 0,
    });
    await composition.closePrivateBindingServices();
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});
