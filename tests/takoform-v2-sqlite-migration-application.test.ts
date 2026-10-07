import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest } from "../src/json.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2ArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";
import { SQLITE_MIGRATION_APPLICATION_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import { createSQLiteMigrationApplicationForm } from "../src/takoform-v2/forms/sqlite-migration-application-backend.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import {
  createSQLiteMigrationSetCustody,
  createSQLiteMigrationSetForm,
} from "../src/takoform-v2/forms/sqlite-migration-set-backend.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const MANIFEST_URL = "https://artifacts.example.test/migrations.json";
const FILE_URL = "https://artifacts.example.test/0001.sql";

async function fixture(sqlText: string | readonly string[]) {
  const root = mkdtempSync(join(tmpdir(), "v2-sqlite-app-"));
  const database = new Database(join(root, "control.sqlite"));
  database.exec("PRAGMA foreign_keys = ON");
  for (const name of [
    "0070_takoform_v2.sql",
    "0071_v2_sqlite_migration_set_custody.sql",
    "0072_v2_artifact_custody.sql",
    "0073_v2_reference_acceptance.sql",
    "0075_v2_artifact_progress.sql",
    "0081_v2_private_inputs.sql",
  ]) {
    database.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql = createSqliteSql(database);
  let nowMs = Date.now();
  const clock = () => new Date(nowMs);
  const store = createSelfhostV2SQLiteStore({
    root: join(root, "native"),
    sql,
    targetKey: "selfhost-sqlite-target-1",
    now: clock,
  });
  const texts = typeof sqlText === "string" ? [sqlText] : sqlText;
  const fileBytes = texts.map((text) => new TextEncoder().encode(text));
  const fileSha256 = await Promise.all(
    fileBytes.map(async (bytes) => (await bytesDigest(bytes)).slice(7)),
  );
  const manifestFiles = fileBytes.map((_, index) => ({
    path: `migrations/${String(index + 1).padStart(4, "0")}.sql`,
    url:
      index === 0
        ? FILE_URL
        : `https://artifacts.example.test/${String(index + 1).padStart(4, "0")}.sql`,
    sha256: fileSha256[index] as string,
    mediaType: "application/sql",
  }));
  const manifestBytes = new TextEncoder().encode(
    JSON.stringify({
      files: manifestFiles,
    }),
  );
  const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
  const blobs = new Map<string, Uint8Array>([[MANIFEST_URL, manifestBytes]]);
  for (const [index, file] of manifestFiles.entries())
    blobs.set(file.url, fileBytes[index] as Uint8Array);
  let sourceReads = 0;
  const source: V2ArtifactSource = {
    async read(input) {
      sourceReads += 1;
      if (input.principal !== "alice" || input.space !== "default") throw new Error("denied");
      const bytes = blobs.get(input.url);
      if (!bytes || bytes.byteLength > input.maxBytes) throw new Error("missing");
      if ((await bytesDigest(bytes)) !== `sha256:${input.sha256}`) throw new Error("changed");
      return bytes;
    },
  };
  const custody = createSQLiteMigrationSetCustody({ sql, source, now: clock });
  const dbForm = createSQLiteDatabaseForm({ store });
  const setForm = createSQLiteMigrationSetForm({
    sql,
    source,
    targetKey: "selfhost-set-target-1",
    now: clock,
  });
  const appForm = createSQLiteMigrationApplicationForm({
    sql,
    store,
    custody,
    targetKey: "selfhost-application-target-1",
    now: clock,
  });
  const forms: Record<string, V2Form> = {
    [SQLITE_DATABASE_FORM_URL]: dbForm,
    [SQLITE_MIGRATION_SET_FORM_URL]: setForm,
    [SQLITE_MIGRATION_APPLICATION_FORM_URL]: appForm,
  };
  const engine = createTakoformV2Engine({
    sql,
    now: clock,
    leaseMilliseconds: 1_000,
    replayWindowSeconds: 120,
    async authorize(principal, space) {
      return principal === "alice" && space === "default";
    },
    forms,
  });
  async function drive(id: string) {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const next = await engine.runNext();
      const current = await engine.getOperation({ principal: "alice", id });
      if (current.status === "succeeded" || current.status === "failed") return current;
      if (next === null || current.status === "reconciling") nowMs += 1_001;
    }
    throw new Error("Operation did not settle");
  }
  const setSpec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
  async function prepare() {
    const createdDb = await engine.acceptCreate({
      principal: "alice",
      key: "sqlite-app-db-create-00000001",
      input: { form: SQLITE_DATABASE_FORM_URL, space: "default", name: "database", spec: {} },
    });
    expect((await drive(createdDb.id)).status).toBe("succeeded");
    const createdSet = await engine.acceptCreate({
      principal: "alice",
      key: "sqlite-app-set-create-0000001",
      input: {
        form: SQLITE_MIGRATION_SET_FORM_URL,
        space: "default",
        name: "migration-set",
        spec: setSpec,
      },
    });
    expect((await drive(createdSet.id)).status).toBe("succeeded");
    return { databaseUid: createdDb.resourceUid, setUid: createdSet.resourceUid };
  }
  function createApplication(
    databaseUid: string,
    setUid: string,
    key = "sqlite-app-create-key-000001",
  ) {
    return engine.acceptCreate({
      principal: "alice",
      key,
      input: {
        form: SQLITE_MIGRATION_APPLICATION_FORM_URL,
        space: "default",
        name: "application",
        spec: {
          database: { resourceUid: databaseUid },
          migrationSet: { resourceUid: setUid },
        },
      },
    });
  }
  return {
    root,
    database,
    sql,
    engine,
    store,
    custody,
    blobs,
    setSpec,
    appForm,
    forms,
    prepare,
    drive,
    createApplication,
    fileSha256: fileSha256[0] as string,
    fileBytes,
    manifestFiles,
    clock,
    get sourceReads() {
      return sourceReads;
    },
    advance(ms: number) {
      nowMs += ms;
    },
    close() {
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

test("held migration applies atomically with ledger and never refetches or reruns on same-spec update", async () => {
  const f = await fixture(
    "CREATE TABLE item (value TEXT NOT NULL); INSERT INTO item VALUES ('once');",
  );
  try {
    const { databaseUid, setUid } = await f.prepare();
    f.blobs.clear();
    const readsBefore = f.sourceReads;
    const application = await f.createApplication(databaseUid, setUid);
    expect((await f.drive(application.id)).status).toBe("succeeded");
    expect(f.sourceReads).toBe(readsBefore);
    const resource = await f.engine.getResource({
      principal: "alice",
      uid: application.resourceUid,
    });
    expect(resource.observed).toMatchObject({
      databaseUid,
      migrationSetUid: setUid,
      ready: true,
      appliedEntries: [{ path: "migrations/0001.sql", sha256: f.fileSha256 }],
    });
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return database.prepare("SELECT value FROM item").all();
        },
      }),
    ).toEqual([{ value: "once" }]);
    const sameSpec = await f.engine.acceptUpdate({
      principal: "alice",
      key: "sqlite-app-update-key-000001",
      uid: application.resourceUid,
      expectedGeneration: 1,
      spec: {
        migrationSet: { resourceUid: setUid },
        database: { resourceUid: databaseUid },
      },
    });
    expect((await f.drive(sameSpec.id)).status).toBe("succeeded");
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return database.prepare("SELECT count(*) AS count FROM item").get();
        },
      }),
    ).toEqual({ count: 1 });
    await expect(
      f.engine.acceptDelete({
        principal: "alice",
        key: "sqlite-app-db-delete-blocked-01",
        uid: databaseUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
    const appDeletion = await f.engine.acceptDelete({
      principal: "alice",
      key: "sqlite-app-delete-key-000001",
      uid: application.resourceUid,
      expectedGeneration: 2,
    });
    expect((await f.drive(appDeletion.id)).status).toBe("succeeded");
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return database.prepare("SELECT count(*) AS count FROM item").get();
        },
      }),
    ).toEqual({ count: 1 });
  } finally {
    f.close();
  }
});

test("invalid migration SQL rolls back file and ledger; custody refuses foreign or changed material", async () => {
  const f = await fixture(
    "CREATE TABLE item (value TEXT); INSERT INTO item VALUES ('no'); PRAGMA user_version = 7;",
  );
  try {
    const { databaseUid, setUid } = await f.prepare();
    const set = await f.engine.getResource({ principal: "alice", uid: setUid });
    await expect(
      f.custody.readHeldVerified({
        targetResourceUid: setUid,
        principal: "bob",
        space: "default",
        expectedSpec: set.spec,
        expectedObserved: set.observed,
        stillAuthorized: async () => true,
      }),
    ).rejects.toThrow();
    const application = await f.createApplication(databaseUid, setUid);
    expect(await f.drive(application.id)).toMatchObject({
      status: "failed",
      effect: "none",
      error: { code: "migration_sql_error" },
    });
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return {
            table: database.prepare("SELECT name FROM sqlite_schema WHERE name = 'item'").get(),
            ledger: database
              .prepare("SELECT count(*) AS count FROM _takoform_sqlite_migrations")
              .get(),
          };
        },
      }),
    ).toEqual({ table: undefined, ledger: { count: 0 } });
    f.database.query("DELETE FROM tf_v2_migration_set_chunks WHERE resource_uid = ?").run(setUid);
    await expect(
      f.custody.readHeldVerified({
        targetResourceUid: setUid,
        principal: "alice",
        space: "default",
        expectedSpec: set.spec,
        expectedObserved: set.observed,
        stillAuthorized: async () => true,
      }),
    ).rejects.toThrow();
  } finally {
    f.close();
  }
});

test("lost Application acknowledgement resumes from committed ledger without rerunning SQL", async () => {
  const f = await fixture("CREATE TABLE item (value TEXT); INSERT INTO item VALUES ('once');");
  try {
    const { databaseUid, setUid } = await f.prepare();
    let loseAck = true;
    const original = f.appForm.backend.execute;
    const wrapped: V2Form = {
      ...f.appForm,
      backend: {
        ...f.appForm.backend,
        async execute(input) {
          const result = await original(input);
          if (loseAck && result.kind === "complete") {
            loseAck = false;
            throw new Error("lost ACK after file and ledger commit");
          }
          return result;
        },
      },
    };
    const engine = createTakoformV2Engine({
      sql: f.sql,
      now: f.clock,
      leaseMilliseconds: 1_000,
      replayWindowSeconds: 120,
      async authorize(principal, space) {
        return principal === "alice" && space === "default";
      },
      forms: { ...f.forms, [SQLITE_MIGRATION_APPLICATION_FORM_URL]: wrapped },
    });
    const accepted = await engine.acceptCreate({
      principal: "alice",
      key: "sqlite-app-lost-ack-key-0001",
      input: {
        form: SQLITE_MIGRATION_APPLICATION_FORM_URL,
        space: "default",
        name: "application",
        spec: {
          database: { resourceUid: databaseUid },
          migrationSet: { resourceUid: setUid },
        },
      },
    });
    expect((await engine.runNext())?.status).toBe("reconciling");
    f.advance(1_001);
    expect((await f.engine.runNext())?.status).toBe("succeeded");
    expect((await f.engine.getOperation({ principal: "alice", id: accepted.id })).status).toBe(
      "succeeded",
    );
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return {
            rows: database.prepare("SELECT count(*) AS count FROM item").get(),
            ledger: database
              .prepare("SELECT count(*) AS count FROM _takoform_sqlite_migrations")
              .get(),
          };
        },
      }),
    ).toEqual({ rows: { count: 1 }, ledger: { count: 1 } });
  } finally {
    f.close();
  }
});

test("known first-file commit is partial; a new immutable Set advances from its exact prefix", async () => {
  const f = await fixture([
    "CREATE TABLE item (value TEXT); INSERT INTO item VALUES ('first');",
    "INSERT INTO item VALUES ('bad'); PRAGMA user_version = 7;",
  ]);
  try {
    const { databaseUid, setUid } = await f.prepare();
    const first = await f.createApplication(databaseUid, setUid);
    expect(await f.drive(first.id)).toMatchObject({
      status: "failed",
      effect: "partial",
      error: { code: "migration_sql_error" },
    });
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return {
            rows: database.prepare("SELECT value FROM item").all(),
            ledger: database
              .prepare("SELECT sequence, path FROM _takoform_sqlite_migrations ORDER BY sequence")
              .all(),
          };
        },
      }),
    ).toEqual({
      rows: [{ value: "first" }],
      ledger: [{ sequence: 1, path: "migrations/0001.sql" }],
    });
    const appDelete = await f.engine.acceptDelete({
      principal: "alice",
      key: "sqlite-app-partial-delete-001",
      uid: first.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.drive(appDelete.id)).status).toBe("succeeded");
    const correctedBytes = new TextEncoder().encode("INSERT INTO item VALUES ('second');");
    const correctedSha = (await bytesDigest(correctedBytes)).slice(7);
    const correctedUrl = "https://artifacts.example.test/corrected-0002.sql";
    const correctedManifestUrl = "https://artifacts.example.test/corrected-manifest.json";
    const correctedManifest = new TextEncoder().encode(
      JSON.stringify({
        files: [
          f.manifestFiles[0],
          {
            path: "migrations/0002.sql",
            url: correctedUrl,
            sha256: correctedSha,
            mediaType: "application/sql",
          },
        ],
      }),
    );
    const correctedManifestSha = (await bytesDigest(correctedManifest)).slice(7);
    f.blobs.set(correctedManifestUrl, correctedManifest);
    f.blobs.set(correctedUrl, correctedBytes);
    const correctedSet = await f.engine.acceptCreate({
      principal: "alice",
      key: "sqlite-app-corrected-set-0001",
      input: {
        form: SQLITE_MIGRATION_SET_FORM_URL,
        space: "default",
        name: "corrected-set",
        spec: { artifact: { url: correctedManifestUrl, sha256: correctedManifestSha } },
      },
    });
    expect((await f.drive(correctedSet.id)).status).toBe("succeeded");
    const replacement = await f.createApplication(
      databaseUid,
      correctedSet.resourceUid,
      "sqlite-app-replacement-key-0001",
    );
    expect((await f.drive(replacement.id)).status).toBe("succeeded");
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return {
            rows: database.prepare("SELECT value FROM item ORDER BY rowid").all(),
            ledger: database
              .prepare("SELECT count(*) AS count FROM _takoform_sqlite_migrations")
              .get(),
          };
        },
      }),
    ).toEqual({ rows: [{ value: "first" }, { value: "second" }], ledger: { count: 2 } });
  } finally {
    f.close();
  }
});

test("SQLite parses trigger BEGIN/END as SQL body, while direct ledger access is rolled back", async () => {
  const allowed = await fixture(
    "CREATE TABLE item (value TEXT); CREATE TABLE audit (value TEXT); CREATE TRIGGER on_item AFTER INSERT ON item BEGIN INSERT INTO audit VALUES (NEW.value); END; INSERT INTO item VALUES ('triggered');",
  );
  try {
    const { databaseUid, setUid } = await allowed.prepare();
    const application = await allowed.createApplication(databaseUid, setUid);
    expect((await allowed.drive(application.id)).status).toBe("succeeded");
    expect(
      await allowed.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return database.prepare("SELECT value FROM audit").all();
        },
      }),
    ).toEqual([{ value: "triggered" }]);
  } finally {
    allowed.close();
  }

  const denied = await fixture(
    "CREATE TABLE item (value TEXT); INSERT INTO item SELECT path FROM _takoform_sqlite_migrations;",
  );
  try {
    const { databaseUid, setUid } = await denied.prepare();
    const application = await denied.createApplication(databaseUid, setUid);
    expect(await denied.drive(application.id)).toMatchObject({
      status: "failed",
      effect: "none",
      error: { code: "migration_sql_error" },
    });
    expect(
      await denied.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return database.prepare("SELECT name FROM sqlite_schema WHERE name = 'item'").get();
        },
      }),
    ).toBeUndefined();
  } finally {
    denied.close();
  }
});

test("MigrationSet held-byte reader refuses missing, deleted, and unconfirmed authority", async () => {
  const f = await fixture("CREATE TABLE item (value TEXT)");
  try {
    const { setUid } = await f.prepare();
    const set = await f.engine.getResource({ principal: "alice", uid: setUid });
    const request = {
      targetResourceUid: setUid,
      principal: "alice",
      space: "default",
      expectedSpec: set.spec,
      expectedObserved: set.observed,
      stillAuthorized: async () => true,
    };
    await expect(
      f.custody.readHeldVerified({ ...request, targetResourceUid: "missing-set-uid" }),
    ).rejects.toThrow();
    await expect(
      f.custody.readHeldVerified({ ...request, stillAuthorized: async () => false }),
    ).rejects.toThrow();
    const deletion = await f.engine.acceptDelete({
      principal: "alice",
      key: "sqlite-set-delete-reader-test-01",
      uid: setUid,
      expectedGeneration: 1,
    });
    expect((await f.drive(deletion.id)).status).toBe("succeeded");
    await expect(f.custody.readHeldVerified(request)).rejects.toThrow();
  } finally {
    f.close();
  }
});
