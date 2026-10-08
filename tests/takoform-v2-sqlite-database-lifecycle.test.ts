import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSelfhostV2SqlitePlane } from "../src/providers/selfhost-v2-sqlite-plane.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  parseSQLiteDatabaseSpec,
  SQLITE_DATABASE_FORM_URL,
} from "../src/takoform-v2/forms/sqlite-database.ts";
import {
  createSQLiteDatabaseForm,
  SQLITE_DATABASE_BACKEND_ID,
} from "../src/takoform-v2/forms/sqlite-database-backend.ts";

const TARGET = "selfhost-sqlite-target-1";
const CREATE_KEY = "sqlite-create-key-0000000001";

function control(root: string, initialize: boolean): Database {
  const database = new Database(join(root, "control.sqlite"));
  database.exec("PRAGMA foreign_keys = ON");
  if (initialize) {
    for (const name of [
      "0070_takoform_v2.sql",
      "0071_v2_sqlite_migration_set_custody.sql",
      "0073_v2_reference_acceptance.sql",
      "0081_v2_private_inputs.sql",
    ]) {
      database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
    }
  }
  return database;
}

function host(root: string, database: Database, clock: () => Date) {
  const sql = createSqliteSql(database);
  const store = createSelfhostV2SQLiteStore({
    root: join(root, "native"),
    sql,
    targetKey: TARGET,
    now: clock,
  });
  const form = createSQLiteDatabaseForm({ store });
  const engine = createTakoformV2Engine({
    sql,
    now: clock,
    leaseMilliseconds: 1_000,
    replayWindowSeconds: 120,
    async authorize(principal, space) {
      return principal === "alice" && space === "default";
    },
    forms: { [SQLITE_DATABASE_FORM_URL]: form },
  });
  return { engine, store };
}

function created(engine: ReturnType<typeof host>["engine"], name = "db", key = CREATE_KEY) {
  return engine.acceptCreate({
    principal: "alice",
    key,
    input: { form: SQLITE_DATABASE_FORM_URL, space: "default", name, spec: {} },
  });
}

test("published SQLiteDatabase spec accepts only an empty object", () => {
  expect(parseSQLiteDatabaseSpec({})).toEqual({});
  for (const input of [null, [], { engine: "sqlite" }, { schema: null }]) {
    expect(() => parseSQLiteDatabaseSpec(input)).toThrow();
  }
});

test("SQLiteDatabase Form keeps Selfhost backend identity unless an explicit valid operator ID is supplied", () => {
  const store = {
    targetKey: TARGET,
    async ensureCreated() {
      return "present" as const;
    },
    async inspect() {
      return "present" as const;
    },
    async ensureDeleted() {
      return "absent" as const;
    },
  };
  expect(createSQLiteDatabaseForm({ store }).backend.id).toBe(SQLITE_DATABASE_BACKEND_ID);
  expect(
    createSQLiteDatabaseForm({ store, backendId: "wfp-v2-sqlite-database-native-v1" }).backend.id,
  ).toBe("wfp-v2-sqlite-database-native-v1");
  for (const backendId of [
    "",
    " ",
    " leading",
    "trailing ",
    "bad\nline",
    "bad\0nul",
    "x".repeat(256),
    7,
  ]) {
    expect(() => createSQLiteDatabaseForm({ store, backendId: backendId as string })).toThrow();
  }
});

test("UID-owned native bytes survive process-like reopen and same-spec PUT; DELETE removes only that UID", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-db-"));
  let database = control(root, true);
  let clockMs = Date.parse("2026-10-07T00:00:00Z");
  const clock = () => new Date(clockMs);
  try {
    let { engine, store } = host(root, database, clock);
    const first = await created(engine, "first", "sqlite-first-create-key-0001");
    const second = await created(engine, "second", "sqlite-second-create-key-0001");
    expect((await engine.runNext())?.status).toBe("succeeded");
    expect((await engine.runNext())?.status).toBe("succeeded");
    expect(
      (await engine.getResource({ principal: "alice", uid: first.resourceUid })).observed,
    ).toEqual({
      databaseExists: true,
    });

    await store.withAuthorizedDatabase({
      resourceUid: first.resourceUid,
      stillAuthorized: async () => true,
      use(native) {
        native.exec("CREATE TABLE data (value TEXT NOT NULL)");
        native.prepare("INSERT INTO data VALUES (?)").run("preserved");
      },
    });
    database.close();
    const childCode = `
      const { Database } = await import("bun:sqlite");
      const { createSqliteSql } = await import(${JSON.stringify(new URL("../src/sql-sqlite.ts", import.meta.url).href)});
      const { createSelfhostV2SQLiteStore } = await import(${JSON.stringify(new URL("../src/providers/selfhost-v2-sqlite-store.ts", import.meta.url).href)});
      const control = new Database(${JSON.stringify(join(root, "control.sqlite"))});
      const store = createSelfhostV2SQLiteStore({ root: ${JSON.stringify(join(root, "native"))}, sql: createSqliteSql(control), targetKey: ${JSON.stringify(TARGET)} });
      const row = await store.withAuthorizedDatabase({ resourceUid: ${JSON.stringify(first.resourceUid)}, stillAuthorized: async () => true, use(database) { return database.prepare("SELECT value FROM data").get(); } });
      console.log(JSON.stringify({ pid: process.pid, row }));
      control.close();
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "-e", childCode], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [childOutput, childErrors, childExit] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(childExit).toBe(0);
    expect(childErrors).toBe("");
    expect(JSON.parse(childOutput)).toEqual({ pid: child.pid, row: { value: "preserved" } });
    database = control(root, false);
    ({ engine, store } = host(root, database, clock));
    expect(
      await store.withAuthorizedDatabase({
        resourceUid: first.resourceUid,
        stillAuthorized: async () => true,
        use(native) {
          return native.prepare("SELECT value FROM data").get();
        },
      }),
    ).toEqual({ value: "preserved" });
    const update = await engine.acceptUpdate({
      principal: "alice",
      key: "sqlite-update-key-00000001",
      uid: first.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(update.generation).toBe(2);
    expect((await engine.runNext())?.status).toBe("succeeded");
    await expect(
      engine.acceptUpdate({
        principal: "alice",
        key: "sqlite-invalid-update-0001",
        uid: first.resourceUid,
        expectedGeneration: 2,
        spec: { reset: true },
      }),
    ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });

    const deletion = await engine.acceptDelete({
      principal: "alice",
      key: "sqlite-delete-key-00000001",
      uid: first.resourceUid,
      expectedGeneration: 2,
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    expect(
      existsSync(join(root, "native", "resources", first.resourceUid, "database.sqlite")),
    ).toBe(false);
    expect(
      existsSync(join(root, "native", "resources", second.resourceUid, "database.sqlite")),
    ).toBe(true);
    expect((await engine.getOperation({ principal: "alice", id: deletion.id })).status).toBe(
      "succeeded",
    );
    expect(
      (
        await engine.acceptDelete({
          principal: "alice",
          key: "sqlite-delete-key-00000001",
          uid: first.resourceUid,
          expectedGeneration: 2,
        })
      ).id,
    ).toBe(deletion.id);
    clockMs += 1_001;
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator proof port opens only the UID with its accepted original CREATE receipt", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-proof-port-"));
  const database = control(root, true);
  try {
    const { engine } = host(root, database, () => new Date("2026-10-07T00:00:00Z"));
    const accepted = await created(engine);
    expect((await engine.runNext())?.status).toBe("succeeded");
    let createOperationId = accepted.id;
    const proofStore = createSelfhostV2SQLiteStore({
      root: join(root, "native"),
      targetKey: TARGET,
      proofs: {
        async currentClaim() {
          return null;
        },
        async acceptedCreate(input) {
          return {
            createOperationId,
            resourceUid: input.resourceUid,
            principal: "alice",
            space: "default",
            backendId: SQLITE_DATABASE_BACKEND_ID,
            targetKey: input.targetKey,
          };
        },
      },
    });
    expect(
      await proofStore.withAuthorizedDatabase({
        resourceUid: accepted.resourceUid,
        stillAuthorized: async () => true,
        use(native) {
          return native.prepare("SELECT count(*) AS count FROM _takoform_sqlite_migrations").get();
        },
      }),
    ).toEqual({ count: 0 });
    expect(
      await proofStore.inspectOwnedDatabase({
        resourceUid: accepted.resourceUid,
        stillAuthorized: async () => true,
      }),
    ).toBe("confirmed");
    expect(
      await proofStore.inspectOwnedDatabase({
        resourceUid: accepted.resourceUid,
        stillAuthorized: async () => false,
      }),
    ).toBe("unknown");
    createOperationId = "foreign-create";
    await expect(
      proofStore.withAuthorizedDatabase({
        resourceUid: accepted.resourceUid,
        stillAuthorized: async () => true,
        use: () => "must not open",
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(
      await proofStore.inspectOwnedDatabase({
        resourceUid: accepted.resourceUid,
        stillAuthorized: async () => true,
      }),
    ).toBe("unknown");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("operator proof port refuses a mismatched current CREATE claim before file effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-create-proof-"));
  const nowMs = Date.parse("2026-10-07T00:00:00Z");
  const execution = {
    operationId: "create-one",
    leaseToken: "lease-one",
    backendKey: "database-one",
    backendId: SQLITE_DATABASE_BACKEND_ID,
    targetKey: TARGET,
    resourceUid: "database-one",
    principal: "alice",
    action: "create" as const,
    generation: 1,
    form: SQLITE_DATABASE_FORM_URL,
    space: "default",
    name: "db",
  };
  let wrongGeneration = true;
  try {
    const store = createSelfhostV2SQLiteStore({
      root: join(root, "native"),
      targetKey: TARGET,
      now: () => new Date(nowMs),
      proofs: {
        async currentClaim(input) {
          return {
            ...input,
            generation: wrongGeneration ? 2 : 1,
            leaseUntilMs: nowMs + 1_000,
          };
        },
        async acceptedCreate(input) {
          return {
            createOperationId: execution.operationId,
            resourceUid: input.resourceUid,
            principal: "alice",
            space: "default",
            backendId: SQLITE_DATABASE_BACKEND_ID,
            targetKey: input.targetKey,
          };
        },
      },
    });
    expect(await store.ensureCreated(execution)).toBe("unknown");
    expect(existsSync(join(root, "native", "resources", execution.resourceUid))).toBe(false);
    wrongGeneration = false;
    expect(await store.ensureCreated(execution)).toBe("present");
    expect(await store.inspect(execution)).toBe("present");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lost create acknowledgement reconciles the same UID and cannot replace foreign custody", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-db-ack-"));
  let database = control(root, true);
  let clockMs = Date.parse("2026-10-07T00:00:00Z");
  const clock = () => new Date(clockMs);
  try {
    const initial = host(root, database, clock);
    const original = initial.store.ensureCreated;
    let loseAck = true;
    const form = createSQLiteDatabaseForm({
      store: {
        ...initial.store,
        async ensureCreated(input) {
          const result = await original(input);
          if (loseAck) {
            loseAck = false;
            throw new Error("lost ACK after native create");
          }
          return result;
        },
      },
    });
    const sql = createSqliteSql(database);
    const engine = createTakoformV2Engine({
      sql,
      now: clock,
      leaseMilliseconds: 1_000,
      replayWindowSeconds: 120,
      async authorize(principal, space) {
        return principal === "alice" && space === "default";
      },
      forms: { [SQLITE_DATABASE_FORM_URL]: form },
    });
    const accepted = await created(engine);
    expect((await engine.runNext())?.status).toBe("reconciling");
    expect(
      existsSync(join(root, "native", "resources", accepted.resourceUid, "database.sqlite")),
    ).toBe(true);
    database.close();
    database = control(root, false);
    const reopened = host(root, database, clock);
    clockMs += 1_001;
    expect((await reopened.engine.runNext())?.status).toBe("succeeded");
    expect((await created(reopened.engine)).id).toBe(accepted.id);

    const foreign = createSelfhostV2SQLiteStore({
      root: join(root, "native"),
      sql: createSqliteSql(database),
      targetKey: "another-host-owned-target",
      now: clock,
    });
    await expect(
      foreign.withAuthorizedDatabase({
        resourceUid: accepted.resourceUid,
        stillAuthorized: async () => true,
        use: () => "should not open",
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(
      existsSync(join(root, "native", "resources", accepted.resourceUid, "database.sqlite")),
    ).toBe(true);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("a crash after native delete removes one link resumes from the owned tombstone", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-db-delete-"));
  const database = control(root, true);
  const clock = () => new Date("2026-10-07T00:00:00Z");
  try {
    const { engine } = host(root, database, clock);
    const accepted = await created(engine);
    expect((await engine.runNext())?.status).toBe("succeeded");
    const deletion = await engine.acceptDelete({
      principal: "alice",
      key: "sqlite-delete-crash-key-001",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    const nativeRoot = join(root, "native");
    const live = join(nativeRoot, "resources", accepted.resourceUid);
    const tomb = join(nativeRoot, "deleted", accepted.resourceUid, deletion.id);
    mkdirSync(tomb, { recursive: true, mode: 0o700 });
    for (const file of ["owner.json", "database.sqlite"]) {
      linkSync(join(live, file), join(tomb, file));
    }
    unlinkSync(join(live, "database.sqlite"));
    expect((await engine.runNext())?.status).toBe("succeeded");
    expect(existsSync(live)).toBe(false);
    expect(existsSync(tomb)).toBe(false);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE refuses a substituted symlink and preserves another UID's database", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-db-foreign-"));
  const database = control(root, true);
  const clock = () => new Date("2026-10-07T00:00:00Z");
  try {
    const { engine } = host(root, database, clock);
    const first = await created(engine, "first", "sqlite-foreign-first-00001");
    const second = await created(engine, "second", "sqlite-foreign-second-0001");
    expect((await engine.runNext())?.status).toBe("succeeded");
    expect((await engine.runNext())?.status).toBe("succeeded");
    const firstFile = join(root, "native", "resources", first.resourceUid, "database.sqlite");
    const secondFile = join(root, "native", "resources", second.resourceUid, "database.sqlite");
    const saved = join(root, "saved-first.sqlite");
    linkSync(firstFile, saved);
    unlinkSync(firstFile);
    symlinkSync(secondFile, firstFile);
    await engine.acceptDelete({
      principal: "alice",
      key: "sqlite-foreign-delete-0001",
      uid: first.resourceUid,
      expectedGeneration: 1,
    });
    expect((await engine.runNext())?.status).toBe("reconciling");
    expect(existsSync(secondFile)).toBe(true);
    expect(existsSync(saved)).toBe(true);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("the UID-owned native handle feeds the guarded Worker SQL plane without ledger access", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-db-plane-"));
  const database = control(root, true);
  const clock = () => new Date("2026-10-07T00:00:00Z");
  try {
    const { engine, store } = host(root, database, clock);
    const accepted = await created(engine);
    expect((await engine.runNext())?.status).toBe("succeeded");
    await store.withAuthorizedDatabase({
      resourceUid: accepted.resourceUid,
      stillAuthorized: async () => true,
      use(native) {
        native.exec("CREATE TABLE item (value TEXT NOT NULL)");
      },
    });
    await store.withAuthorizedDatabase({
      resourceUid: accepted.resourceUid,
      stillAuthorized: async () => true,
      async use(native) {
        const plane = createSelfhostV2SqlitePlane({
          database: native,
          migrationLedger: { schema: "main", table: "_takoform_sqlite_migrations" },
        });
        try {
          const worker = {
            execute: plane.execute,
            query: plane.query,
            transaction: plane.transaction,
          };
          expect(Object.keys(worker)).toEqual(["execute", "query", "transaction"]);
          expect(await worker.execute("INSERT INTO item VALUES (?)", ["tenant-row"])).toMatchObject(
            {
              rowsWritten: 1,
            },
          );
          expect(await worker.query("SELECT value FROM item")).toMatchObject({
            rows: [{ value: "tenant-row" }],
            rowsWritten: 0,
          });
          await expect(
            worker.query("SELECT * FROM _takoform_sqlite_migrations"),
          ).rejects.toMatchObject({
            name: "sql_error",
          });
        } finally {
          plane.close();
        }
      },
    });
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("DELETE treats a replaced Resource directory as unknown, not confirmed absence", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-db-dir-"));
  const database = control(root, true);
  const clock = () => new Date("2026-10-07T00:00:00Z");
  try {
    const { engine } = host(root, database, clock);
    const first = await created(engine, "first", "sqlite-dir-first-00000001");
    const second = await created(engine, "second", "sqlite-dir-second-0000001");
    expect((await engine.runNext())?.status).toBe("succeeded");
    expect((await engine.runNext())?.status).toBe("succeeded");
    const firstDir = join(root, "native", "resources", first.resourceUid);
    const secondDir = join(root, "native", "resources", second.resourceUid);
    const saved = join(root, "saved-first");
    renameSync(firstDir, saved);
    symlinkSync(secondDir, firstDir);
    await engine.acceptDelete({
      principal: "alice",
      key: "sqlite-dir-delete-00000001",
      uid: first.resourceUid,
      expectedGeneration: 1,
    });
    expect((await engine.runNext())?.status).toBe("reconciling");
    expect(existsSync(join(secondDir, "database.sqlite"))).toBe(true);
    expect(existsSync(join(saved, "database.sqlite"))).toBe(true);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("sidecar create receipt must match the accepted core create Operation", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-db-receipt-"));
  const database = control(root, true);
  const clock = () => new Date("2026-10-07T00:00:00Z");
  try {
    const { engine, store } = host(root, database, clock);
    const accepted = await created(engine);
    expect((await engine.runNext())?.status).toBe("succeeded");
    const resourceDir = join(root, "native", "resources", accepted.resourceUid);
    const ownerPath = join(resourceDir, "owner.json");
    const owner = JSON.parse(readFileSync(ownerPath, "utf8"));
    writeFileSync(ownerPath, JSON.stringify({ ...owner, createOperationId: "foreign-operation" }));
    await expect(
      store.withAuthorizedDatabase({
        resourceUid: accepted.resourceUid,
        stillAuthorized: async () => true,
        use: () => "not authorized",
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    await engine.acceptDelete({
      principal: "alice",
      key: "sqlite-receipt-delete-000001",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    expect((await engine.runNext())?.status).toBe("reconciling");
    expect(existsSync(join(resourceDir, "database.sqlite"))).toBe(true);
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("crash during publish or stage cleanup resumes only original hard links", async () => {
  for (const partial of ["empty", "owner-only", "cleanup-owner-only"] as const) {
    const root = mkdtempSync(join(tmpdir(), "v2-sqlite-db-publish-"));
    const database = control(root, true);
    let clockMs = Date.parse("2026-10-07T00:00:00Z");
    const clock = () => new Date(clockMs);
    try {
      const base = host(root, database, clock);
      let once = true;
      const form = createSQLiteDatabaseForm({
        store: {
          ...base.store,
          async ensureCreated(input) {
            const result = await base.store.ensureCreated(input);
            if (!once) return result;
            once = false;
            const final = join(root, "native", "resources", input.resourceUid);
            const stage = join(root, "native", "staging", input.operationId);
            mkdirSync(stage, { mode: 0o700 });
            for (const name of partial === "cleanup-owner-only"
              ? ["owner.json"]
              : ["owner.json", "database.sqlite"]) {
              linkSync(join(final, name), join(stage, name));
            }
            if (partial !== "cleanup-owner-only") {
              unlinkSync(join(final, "database.sqlite"));
              if (partial === "empty") unlinkSync(join(final, "owner.json"));
            }
            throw new Error("process stopped during native publication");
          },
        },
      });
      const engine = createTakoformV2Engine({
        sql: createSqliteSql(database),
        now: clock,
        leaseMilliseconds: 1_000,
        replayWindowSeconds: 120,
        async authorize(principal, space) {
          return principal === "alice" && space === "default";
        },
        forms: { [SQLITE_DATABASE_FORM_URL]: form },
      });
      const accepted = await created(engine, `db-${partial}`, `sqlite-publish-${partial}-key-01`);
      expect((await engine.runNext())?.status).toBe("reconciling");
      clockMs += 1_001;
      expect((await base.engine.runNext())?.status).toBe("succeeded");
      expect(
        existsSync(join(root, "native", "resources", accepted.resourceUid, "database.sqlite")),
      ).toBe(true);
      expect(existsSync(join(root, "native", "staging", accepted.id))).toBe(false);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("crash during tombstone teardown resumes from owner-only or empty tombstone", async () => {
  for (const partial of ["owner-only", "empty"] as const) {
    const root = mkdtempSync(join(tmpdir(), "v2-sqlite-db-tomb-teardown-"));
    const database = control(root, true);
    const clock = () => new Date("2026-10-07T00:00:00Z");
    try {
      const { engine } = host(root, database, clock);
      const accepted = await created(engine, `db-${partial}`, `sqlite-tomb-${partial}-create-01`);
      expect((await engine.runNext())?.status).toBe("succeeded");
      const deletion = await engine.acceptDelete({
        principal: "alice",
        key: `sqlite-tomb-${partial}-delete-01`,
        uid: accepted.resourceUid,
        expectedGeneration: 1,
      });
      const live = join(root, "native", "resources", accepted.resourceUid);
      const tomb = join(root, "native", "deleted", accepted.resourceUid, deletion.id);
      mkdirSync(tomb, { recursive: true, mode: 0o700 });
      for (const name of ["owner.json", "database.sqlite"]) {
        linkSync(join(live, name), join(tomb, name));
        unlinkSync(join(live, name));
      }
      rmdirSync(live);
      unlinkSync(join(tomb, "database.sqlite"));
      if (partial === "empty") unlinkSync(join(tomb, "owner.json"));
      expect((await engine.runNext())?.status).toBe("succeeded");
      expect(existsSync(tomb)).toBe(false);
    } finally {
      database.close();
      rmSync(root, { recursive: true, force: true });
    }
  }
});
