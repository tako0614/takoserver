import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
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
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";

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
