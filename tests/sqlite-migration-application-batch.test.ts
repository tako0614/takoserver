import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest, isJsonObject } from "../src/json.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2ArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";
import {
  parseSQLiteMigrationApplicationSpec,
  SQLITE_MIGRATION_APPLICATION_FORM_URL,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0,
  SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0,
  type SQLiteMigrationApplicationFormUrl,
} from "../src/takoform-v2/forms/sqlite-migration-application.ts";
import {
  createSQLiteMigrationApplicationForm,
  runSQLiteMigrationApplication,
} from "../src/takoform-v2/forms/sqlite-migration-application-backend.ts";
import { createSQLiteMigrationApplicationNativePort } from "../src/takoform-v2/forms/sqlite-migration-application-native.ts";
import type {
  SQLiteMigrationApplicationBatchInput,
  SQLiteMigrationApplicationBatchPort,
  SQLiteMigrationApplicationPort,
} from "../src/takoform-v2/forms/sqlite-migration-application-port.ts";
import {
  SQLITE_MIGRATION_SET_FORM_URL,
  SQLITE_MIGRATION_SET_FORM_URL_0_2_0,
  SQLITE_MIGRATION_SET_FORM_URL_0_3_0,
} from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import {
  createSQLiteMigrationSetCustody,
  createSQLiteMigrationSetForm,
} from "../src/takoform-v2/forms/sqlite-migration-set-backend.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const MANIFEST_URL = "https://artifacts.example.test/migrations.json";
const FILE_URL = "https://artifacts.example.test/0001.sql";

async function fixture(
  sqlText: string | readonly string[],
  portFactory: (
    native: SQLiteMigrationApplicationPort,
    context: {
      custody: ReturnType<typeof createSQLiteMigrationSetCustody>;
      store: ReturnType<typeof createSelfhostV2SQLiteStore>;
      advance: (ms: number) => void;
    },
  ) => SQLiteMigrationApplicationBatchPort,
  applicationFormUrl: SQLiteMigrationApplicationFormUrl = SQLITE_MIGRATION_APPLICATION_FORM_URL,
) {
  const setFormUrl =
    applicationFormUrl === SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0
      ? SQLITE_MIGRATION_SET_FORM_URL_0_2_0
      : applicationFormUrl === SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0
        ? SQLITE_MIGRATION_SET_FORM_URL_0_3_0
        : SQLITE_MIGRATION_SET_FORM_URL;
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
  const custody = createSQLiteMigrationSetCustody({ sql, source, now: clock, formUrl: setFormUrl });
  const dbForm = createSQLiteDatabaseForm({ store });
  const setForm = createSQLiteMigrationSetForm({
    sql,
    source,
    targetKey: "selfhost-set-target-1",
    formUrl: setFormUrl,
    now: clock,
  });
  const appForm = createSQLiteMigrationApplicationForm({
    sql,
    migrationPort: portFactory(createSQLiteMigrationApplicationNativePort(store), {
      custody,
      store,
      advance(ms) {
        nowMs += ms;
      },
    }),
    custody,
    targetKey: "selfhost-application-target-1",
    formUrl: applicationFormUrl,
    now: clock,
  });
  const forms: Record<string, V2Form> = {
    [SQLITE_DATABASE_FORM_URL]: dbForm,
    [setFormUrl]: setForm,
    [applicationFormUrl]: appForm,
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
        form: setFormUrl,
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
        form: applicationFormUrl,
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

/** In-process adapter fixture: the metadata alone never supplies authority or SQL bytes. */
async function readBatchFiles(
  custody: ReturnType<typeof createSQLiteMigrationSetCustody>,
  input: SQLiteMigrationApplicationBatchInput,
): Promise<readonly Uint8Array[]> {
  expect(Object.hasOwn(input, "files")).toBe(false);
  const set = input.execution.spec.migrationSet;
  if (!isJsonObject(set)) throw new Error("missing Set");
  const setUid = set.resourceUid;
  if (typeof setUid !== "string") throw new Error("missing Set UID");
  // These observation fields are not remote authority; the custody reader
  // proves the exact accepted identity and reference against real control SQL.
  const held = await custody.openAcceptedUnverified({
    execution: { ...input.execution, previousObserved: {}, previousOutput: {} },
    targetResourceUid: setUid,
  });
  const heldEntries: SQLiteMigrationApplicationBatchInput["targetEntries"] =
    held.manifest.files.map(({ path, sha256 }) => ({ path, sha256 }));
  expect(heldEntries).toEqual(input.targetEntries);
  expect(held.fileSizes).toEqual(input.fileSizes);
  const files: Uint8Array[] = [];
  for (const [index, file] of held.manifest.files.entries()) {
    const chunks: Uint8Array[] = [];
    const verified = await held.stageVerifiedFile({
      fileIndex: index,
      async write(chunk) {
        chunks.push(chunk);
      },
    });
    const byteSize = input.fileSizes[index];
    if (byteSize === undefined) throw new Error("missing expected file size");
    expect(verified).toEqual({ sha256: file.sha256, byteSize });
    const bytes = new Uint8Array(verified.byteSize);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    expect(offset).toBe(bytes.byteLength);
    files.push(bytes);
  }
  return files;
}

for (const version of [
  { label: "0.2", form: SQLITE_MIGRATION_APPLICATION_FORM_URL_0_2_0, prefix: "" },
  {
    label: "0.3",
    form: SQLITE_MIGRATION_APPLICATION_FORM_URL_0_3_0,
    prefix: "PRAGMA defer_foreign_keys=ON; ",
  },
  {
    label: "0.4",
    form: SQLITE_MIGRATION_APPLICATION_FORM_URL,
    prefix: "PRAGMA defer_foreign_keys=ON; SELECT * FROM pragma_table_info('batch_item'); ",
  },
] as const) {
  test(`metadata batch ${version.label} uses accepted held bytes and reconciles a lost batch ACK without SQL replay`, async () => {
    let loseAck = true;
    let sessions = 0;
    const calls: SQLiteMigrationApplicationBatchInput[] = [];
    const f = await fixture(
      version.prefix +
        "CREATE TABLE batch_item(value TEXT); INSERT INTO batch_item VALUES('once');",
      (native, { custody }) => ({
        async applyAuthorizedMigration(input) {
          calls.push(input);
          const files = await readBatchFiles(custody, input);
          const result = await runSQLiteMigrationApplication(
            {
              withAuthorizedMigrationSession(request) {
                sessions += 1;
                return native.withAuthorizedMigrationSession(request);
              },
            },
            { ...input, files },
          );
          if (loseAck) {
            loseAck = false;
            throw new Error("batch ACK lost after durable commit");
          }
          return result;
        },
      }),
      version.form,
    );
    const verifiedRead = spyOn(f.custody, "readVerified");
    try {
      const { databaseUid, setUid } = await f.prepare();
      const reads = f.sourceReads;
      f.blobs.clear();
      const accepted = await f.createApplication(databaseUid, setUid);
      expect((await f.engine.runNext())?.status).toBe("reconciling");
      expect((await f.drive(accepted.id)).status).toBe("succeeded");
      expect(verifiedRead).not.toHaveBeenCalled();
      expect(f.sourceReads).toBe(reads);
      expect(sessions).toBe(2);
      expect(calls.length).toBe(2);
      expect(calls.every((input) => input.execution.form === version.form)).toBe(true);
      expect(calls.every((input) => input.resourceUid === databaseUid)).toBe(true);
      expect(calls[0]?.execution.operationId).toBe(accepted.id);
      expect(calls[0]?.execution.leaseToken).not.toBe(calls[1]?.execution.leaseToken);
      expect(
        await f.store.withAuthorizedDatabase({
          resourceUid: databaseUid,
          stillAuthorized: async () => true,
          use(database) {
            return {
              data: database.prepare("SELECT value FROM batch_item").all(),
              ledger: database
                .prepare(
                  "SELECT sequence,path,sha256,operation_id FROM _takoform_sqlite_migrations",
                )
                .all(),
            };
          },
        }),
      ).toEqual({
        data: [{ value: "once" }],
        ledger: [
          {
            sequence: 1,
            path: "migrations/0001.sql",
            sha256: f.fileSha256,
            operation_id: accepted.id,
          },
        ],
      });
      const deletion = await f.engine.acceptDelete({
        principal: "alice",
        key: "batch-delete-application-0001",
        uid: accepted.resourceUid,
        expectedGeneration: 1,
      });
      expect((await f.drive(deletion.id)).status).toBe("succeeded");
      expect(calls.length).toBe(2);
    } finally {
      verifiedRead.mockRestore();
      f.close();
    }
  });
}

test("batch runner retains one real UID exclusion and resolves a file ACK only from committed history", async () => {
  let sessions = 0;
  let effects = 0;
  const f = await fixture(
    [
      "CREATE TABLE batch_item(value TEXT); INSERT INTO batch_item VALUES('first');",
      "INSERT INTO batch_item VALUES('second');",
    ],
    (native, { custody, store }) => ({
      async applyAuthorizedMigration(input) {
        const files = await readBatchFiles(custody, input);
        return runSQLiteMigrationApplication(
          {
            withAuthorizedMigrationSession(request) {
              sessions += 1;
              return native.withAuthorizedMigrationSession({
                ...request,
                use(session) {
                  return request.use({
                    readLedger: () => session.readLedger(),
                    async applyOneHeldFile(file) {
                      await expect(
                        store.withAuthorizedDatabase({
                          resourceUid: input.resourceUid,
                          stillAuthorized: async () => true,
                          use: () => undefined,
                        }),
                      ).rejects.toMatchObject({ code: "busy" });
                      effects += 1;
                      const applied = await session.applyOneHeldFile(file);
                      expect(applied.kind).toBe("applied");
                      return file.sequence === 1 ? { kind: "unknown" } : applied;
                    },
                  });
                },
              });
            },
          },
          { ...input, files },
        );
      },
    }),
  );
  try {
    const { databaseUid, setUid } = await f.prepare();
    const accepted = await f.createApplication(databaseUid, setUid);
    expect((await f.drive(accepted.id)).status).toBe("succeeded");
    expect(sessions).toBe(1);
    expect(effects).toBe(2);
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use: (database) => database.prepare("SELECT value FROM batch_item ORDER BY rowid").all(),
      }),
    ).toEqual([{ value: "first" }, { value: "second" }]);
  } finally {
    f.close();
  }
});

test("batch metadata cannot turn missing held chunks into native SQL authority", async () => {
  let sessions = 0;
  const f = await fixture("CREATE TABLE batch_item(value TEXT)", (native, { custody }) => ({
    async applyAuthorizedMigration(input) {
      const files = await readBatchFiles(custody, input);
      return runSQLiteMigrationApplication(
        {
          withAuthorizedMigrationSession(request) {
            sessions += 1;
            return native.withAuthorizedMigrationSession(request);
          },
        },
        { ...input, files },
      );
    },
  }));
  try {
    const { databaseUid, setUid } = await f.prepare();
    f.database.query("DELETE FROM tf_v2_migration_set_chunks WHERE resource_uid = ?").run(setUid);
    const accepted = await f.createApplication(databaseUid, setUid);
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(sessions).toBe(0);
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use: (database) =>
          database.prepare("SELECT count(*) AS count FROM _takoform_sqlite_migrations").get(),
      }),
    ).toEqual({ count: 0 });
    expect((await f.engine.getOperation({ principal: "alice", id: accepted.id })).effect).toBe(
      "unknown",
    );
  } finally {
    f.close();
  }
});

test("accepted bounded reader rechecks its real lease before staging bytes", async () => {
  let refused = false;
  const f = await fixture(
    "CREATE TABLE batch_item(value TEXT)",
    (_native, { custody, advance }) => ({
      async applyAuthorizedMigration(input) {
        const set = input.execution.spec.migrationSet;
        if (!isJsonObject(set) || typeof set.resourceUid !== "string")
          throw new Error("Set missing");
        const request = {
          execution: { ...input.execution, previousObserved: {}, previousOutput: {} },
          targetResourceUid: set.resourceUid,
        };
        await expect(
          custody.openAcceptedUnverified({
            ...request,
            execution: { ...request.execution, leaseToken: "stale-lease" },
          }),
        ).rejects.toThrow();
        const held = await custody.openAcceptedUnverified(request);
        advance(1_001);
        let writes = 0;
        await expect(
          held.stageVerifiedFile({
            fileIndex: 0,
            async write() {
              writes += 1;
            },
          }),
        ).rejects.toThrow();
        expect(writes).toBe(0);
        refused = true;
        throw new Error("accepted lease expired before file verification");
      },
    }),
  );
  try {
    const { databaseUid, setUid } = await f.prepare();
    await f.createApplication(databaseUid, setUid);
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(refused).toBe(true);
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use: (database) =>
          database.prepare("SELECT count(*) AS count FROM _takoform_sqlite_migrations").get(),
      }),
    ).toEqual({ count: 0 });
  } finally {
    f.close();
  }
});

test("shared runner verifies all complete held file digests before opening the native UID", async () => {
  let sessions = 0;
  const f = await fixture("CREATE TABLE batch_item(value TEXT)", (native, { custody }) => ({
    async applyAuthorizedMigration(input) {
      const verified = await readBatchFiles(custody, input);
      const files = verified.map((bytes) => new Uint8Array(bytes));
      const first = files[0];
      if (!first?.length) throw new Error("fixture SQL missing");
      first[0] = (first[0] ?? 0) ^ 1;
      return runSQLiteMigrationApplication(
        {
          withAuthorizedMigrationSession(request) {
            sessions += 1;
            return native.withAuthorizedMigrationSession(request);
          },
        },
        { ...input, files },
      );
    },
  }));
  try {
    const { databaseUid, setUid } = await f.prepare();
    const accepted = await f.createApplication(databaseUid, setUid);
    expect(await f.drive(accepted.id)).toMatchObject({
      status: "failed",
      effect: "none",
      error: { code: "artifact_invalid" },
    });
    expect(sessions).toBe(0);
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use: (database) =>
          database.prepare("SELECT count(*) AS count FROM _takoform_sqlite_migrations").get(),
      }),
    ).toEqual({ count: 0 });
  } finally {
    f.close();
  }
});

test("bounded custody descriptor cannot survive actual referenced Set deletion", async () => {
  const f = await fixture("CREATE TABLE batch_item(value TEXT)", (native, { custody }) => ({
    async applyAuthorizedMigration(input) {
      return runSQLiteMigrationApplication(native, {
        ...input,
        files: await readBatchFiles(custody, input),
      });
    },
  }));
  try {
    const { databaseUid, setUid } = await f.prepare();
    const accepted = await f.createApplication(databaseUid, setUid);
    expect((await f.drive(accepted.id)).status).toBe("succeeded");
    const appDeletion = await f.engine.acceptDelete({
      principal: "alice",
      key: "batch-app-before-set-delete-01",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    expect((await f.drive(appDeletion.id)).status).toBe("succeeded");
    const set = await f.engine.getResource({ principal: "alice", uid: setUid });
    const held = await f.custody.openHeldUnverified({
      targetResourceUid: setUid,
      principal: "alice",
      space: "default",
      expectedSpec: set.spec,
      expectedObserved: set.observed,
      stillAuthorized: async () => true,
    });
    expect((await held.readPage({ fileIndex: 0, nextChunk: 0 })).chunks.length).toBe(1);
    const deletion = await f.engine.acceptDelete({
      principal: "alice",
      key: "batch-delete-set-reader-0001",
      uid: setUid,
      expectedGeneration: 1,
    });
    expect((await f.drive(deletion.id)).status).toBe("succeeded");
    await expect(held.readPage({ fileIndex: 0, nextChunk: 0 })).rejects.toThrow();
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use: (database) =>
          database.prepare("SELECT count(*) AS count FROM _takoform_sqlite_migrations").get(),
      }),
    ).toEqual({ count: 1 });
  } finally {
    f.close();
  }
});

test("batch realization requires the actual bounded accepted custody capability", async () => {
  const port: SQLiteMigrationApplicationBatchPort = {
    async applyAuthorizedMigration() {
      throw new Error("must not execute");
    },
  };
  const f = await fixture("CREATE TABLE batch_item(value TEXT)", () => port);
  try {
    expect(() =>
      createSQLiteMigrationApplicationForm({
        sql: f.sql,
        targetKey: "selected-target",
        migrationPort: port,
        custody: { readVerified: f.custody.readVerified },
      }),
    ).toThrow("bounded accepted artifact custody");
  } finally {
    f.close();
  }
});

for (const phase of ["hash", "open", "readLedger"] as const) {
  test(`batch runner snapshots retained caller material before ${phase} await`, async () => {
    const original = "CREATE TABLE captured(value TEXT); INSERT INTO captured VALUES('safe');";
    const changed = new TextEncoder().encode(original.replace("'safe'", "'evil'"));
    let mutated = false;
    const f = await fixture(original, (native, { custody }) => ({
      async applyAuthorizedMigration(input) {
        const verified = await readBatchFiles(custody, input);
        const refs = parseSQLiteMigrationApplicationSpec(input.execution.spec);
        const mutable = {
          ...input,
          execution: {
            ...input.execution,
            spec: {
              database: { resourceUid: refs.database.resourceUid },
              migrationSet: { resourceUid: refs.migrationSet.resourceUid },
            },
          },
          targetEntries: input.targetEntries.map((entry) => ({ ...entry })),
          files: verified.map((bytes) => new Uint8Array(bytes)),
        };
        const mutate = () => {
          if (mutated) return;
          mutated = true;
          const bytes = mutable.files[0];
          if (!bytes || bytes.byteLength !== changed.byteLength) throw new Error("fixture size");
          bytes.set(changed);
          if (phase !== "hash") {
            mutable.files[0] = new Uint8Array(changed);
            mutable.targetEntries[0] = { path: "migrations/evil.sql", sha256: "0".repeat(64) };
            mutable.execution.operationId = "evil-operation";
            mutable.execution.form = "https://invalid.example.test/evil/";
            mutable.execution.spec.database.resourceUid = "evil-database";
            mutable.execution.spec.migrationSet.resourceUid = "evil-set";
            mutable.resourceUid = "evil-database";
          }
        };
        const pending = runSQLiteMigrationApplication(
          {
            withAuthorizedMigrationSession(request) {
              if (phase === "open") mutate();
              return native.withAuthorizedMigrationSession({
                ...request,
                use(session) {
                  return request.use({
                    async readLedger() {
                      const result = await session.readLedger();
                      if (phase === "readLedger") mutate();
                      return result;
                    },
                    applyOneHeldFile: (file) => session.applyOneHeldFile(file),
                  });
                },
              });
            },
          },
          mutable,
        );
        if (phase === "hash") mutate();
        return pending;
      },
    }));
    try {
      const { databaseUid, setUid } = await f.prepare();
      const accepted = await f.createApplication(databaseUid, setUid);
      expect((await f.drive(accepted.id)).status).toBe("succeeded");
      expect(mutated).toBe(true);
      expect(
        await f.store.withAuthorizedDatabase({
          resourceUid: databaseUid,
          stillAuthorized: async () => true,
          use(database) {
            return {
              data: database.prepare("SELECT value FROM captured").all(),
              ledger: database
                .prepare(
                  "SELECT sequence,path,sha256,operation_id FROM _takoform_sqlite_migrations",
                )
                .all(),
            };
          },
        }),
      ).toEqual({
        data: [{ value: "safe" }],
        ledger: [
          {
            sequence: 1,
            path: "migrations/0001.sql",
            sha256: f.fileSha256,
            operation_id: accepted.id,
          },
        ],
      });
    } finally {
      f.close();
    }
  });
}

test("batch runner retains live revocation after the owned snapshot and ledger read", async () => {
  let allowed = true;
  const f = await fixture("CREATE TABLE must_not_exist(value TEXT)", (native, { custody }) => ({
    async applyAuthorizedMigration(input) {
      const files = await readBatchFiles(custody, input);
      return runSQLiteMigrationApplication(
        {
          withAuthorizedMigrationSession(request) {
            return native.withAuthorizedMigrationSession({
              ...request,
              use(session) {
                return request.use({
                  async readLedger() {
                    const result = await session.readLedger();
                    allowed = false;
                    return result;
                  },
                  applyOneHeldFile: (file) => session.applyOneHeldFile(file),
                });
              },
            });
          },
        },
        {
          ...input,
          files,
          stillAuthorized: async () => allowed && (await input.stillAuthorized()),
        },
      );
    },
  }));
  try {
    const { databaseUid, setUid } = await f.prepare();
    await f.createApplication(databaseUid, setUid);
    expect((await f.engine.runNext())?.status).toBe("reconciling");
    expect(allowed).toBe(false);
    expect(
      await f.store.withAuthorizedDatabase({
        resourceUid: databaseUid,
        stillAuthorized: async () => true,
        use(database) {
          return {
            table: database
              .prepare("SELECT name FROM sqlite_schema WHERE name='must_not_exist'")
              .get(),
            ledger: database
              .prepare("SELECT count(*) AS count FROM _takoform_sqlite_migrations")
              .get(),
          };
        },
      }),
    ).toEqual({ table: undefined, ledger: { count: 0 } });
  } finally {
    f.close();
  }
});
