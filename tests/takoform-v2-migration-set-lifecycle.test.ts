import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { bytesDigest } from "../src/json.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import type { V2ArtifactSource } from "../src/takoform-v2/forms/artifact-source.ts";
import { SQLITE_MIGRATION_SET_FORM_URL } from "../src/takoform-v2/forms/sqlite-migration-set.ts";
import { createSQLiteMigrationSetForm } from "../src/takoform-v2/forms/sqlite-migration-set-backend.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const MANIFEST_URL = "https://artifacts.example.test/manifest.json";
const FILE_URL = "https://artifacts.example.test/0001.sql";
const FILE_BYTES = new TextEncoder().encode("CREATE TABLE should_not_execute (id INTEGER);\n");
const ENCODER = new TextEncoder();

async function fixture(input?: {
  fileBytes?: Uint8Array;
  customizeSource?: (source: V2ArtifactSource, blobs: Map<string, Uint8Array>) => V2ArtifactSource;
  customizeForm?: (form: V2Form) => V2Form;
}) {
  const db = new Database(":memory:");
  for (const name of ["0070_takoform_v2.sql", "0071_v2_sqlite_migration_set_custody.sql"]) {
    db.exec(readFileSync(new URL(`../migrations/${name}`, import.meta.url), "utf8"));
  }
  const sql = createSqliteSql(db);
  const fileBytes = input?.fileBytes ?? FILE_BYTES;
  const fileSha256 = (await bytesDigest(fileBytes)).slice(7);
  const manifestBytes = ENCODER.encode(
    JSON.stringify({
      files: [
        {
          path: "migrations/0001.sql",
          url: FILE_URL,
          sha256: fileSha256,
          mediaType: "application/sql",
        },
      ],
    }),
  );
  const manifestSha256 = (await bytesDigest(manifestBytes)).slice(7);
  const blobs = new Map<string, Uint8Array>([
    [MANIFEST_URL, manifestBytes],
    [FILE_URL, fileBytes],
  ]);
  const reads: string[] = [];
  const plainSource: V2ArtifactSource = {
    async read({ principal, space, url, sha256, maxBytes }) {
      expect(principal).toBe("alice");
      expect(space).toBe("default");
      reads.push(url);
      const bytes = blobs.get(url);
      if (
        !bytes ||
        bytes.byteLength > maxBytes ||
        (await bytesDigest(bytes)) !== `sha256:${sha256}`
      )
        throw new Error("source unavailable");
      return bytes;
    },
  };
  const source = input?.customizeSource?.(plainSource, blobs) ?? plainSource;
  const rawForm = createSQLiteMigrationSetForm({
    sql,
    source,
    targetKey: "selfhost-control-sqlite-1",
  });
  const form = input?.customizeForm?.(rawForm) ?? rawForm;
  let nowMs = Date.parse("2026-10-06T00:00:00.000Z");
  const engine = () =>
    createTakoformV2Engine({
      sql,
      now: () => new Date(nowMs),
      replayWindowSeconds: 3_600,
      leaseMilliseconds: 1_000,
      authorize: async (principal, space) => principal === "alice" && space === "default",
      forms: { [SQLITE_MIGRATION_SET_FORM_URL]: form },
    });
  const spec = { artifact: { url: MANIFEST_URL, sha256: manifestSha256 } };
  const create = (host: ReturnType<typeof engine>, key = "migration-create-key-00001") =>
    host.acceptCreate({
      principal: "alice",
      key,
      input: { form: SQLITE_MIGRATION_SET_FORM_URL, space: "default", name: "migrations", spec },
    });
  return {
    db,
    blobs,
    reads,
    engine,
    create,
    spec,
    manifestSha256,
    fileSha256,
    advance(ms: number) {
      nowMs += ms;
    },
  };
}

test("create holds exact ordered bytes; read and same-spec update do not contact the source", async () => {
  const f = await fixture();
  const host = f.engine();
  const admitted = await f.create(host);
  expect(await host.runNext()).toMatchObject({ id: admitted.id, status: "succeeded" });
  expect(await f.create(host)).toMatchObject({ id: admitted.id });
  const resource = await host.getResource({ principal: "alice", uid: admitted.resourceUid });
  expect(resource).toMatchObject({
    observedGeneration: 1,
    observed: {
      manifestSha256: f.manifestSha256,
      fileCount: 1,
      totalBytes: FILE_BYTES.byteLength,
      files: [
        {
          path: "migrations/0001.sql",
          sha256: f.fileSha256,
          mediaType: "application/sql",
          byteSize: FILE_BYTES.byteLength,
        },
      ],
    },
    output: {},
  });
  expect(
    f.db.query("SELECT name FROM sqlite_master WHERE name = 'should_not_execute'").all(),
  ).toEqual([]);
  f.blobs.clear();
  const readsBefore = f.reads.length;
  expect(
    (await host.getResource({ principal: "alice", uid: admitted.resourceUid })).observed,
  ).toEqual(resource.observed);
  const updated = await host.acceptUpdate({
    principal: "alice",
    key: "migration-update-key-00001",
    uid: admitted.resourceUid,
    expectedGeneration: 1,
    spec: { artifact: { sha256: f.manifestSha256, url: MANIFEST_URL } },
  });
  expect(await host.runNext()).toMatchObject({ id: updated.id, status: "succeeded" });
  expect(f.reads).toHaveLength(readsBefore);
  await expect(
    host.acceptUpdate({
      principal: "alice",
      key: "migration-update-key-00002",
      uid: admitted.resourceUid,
      expectedGeneration: 2,
      spec: { artifact: { sha256: "0".repeat(64), url: MANIFEST_URL } },
    }),
  ).rejects.toMatchObject({ code: "invalid_spec", status: 422 });
  const deletion = await host.acceptDelete({
    principal: "alice",
    key: "migration-delete-key-00001",
    uid: admitted.resourceUid,
    expectedGeneration: 2,
  });
  expect(await host.runNext()).toMatchObject({ id: deletion.id, status: "succeeded" });
  expect(f.db.query("SELECT * FROM tf_v2_migration_set_owners").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM tf_v2_migration_set_chunks").all()).toHaveLength(0);
  expect(f.reads).toHaveLength(readsBefore);
});

test("partial create is retained as failed Resource but terminal staging bytes are GCed", async () => {
  const f = await fixture();
  f.blobs.delete(FILE_URL);
  const host = f.engine();
  const created = await f.create(host);
  expect(await host.runNext()).toMatchObject({ id: created.id, status: "failed", effect: "none" });
  expect(await host.getResource({ principal: "alice", uid: created.resourceUid })).toMatchObject({
    phase: "error",
    generation: 1,
    observedGeneration: 0,
    observed: {},
    output: {},
  });
  expect(f.db.query("SELECT * FROM tf_v2_migration_set_owners").all()).toHaveLength(0);
  f.blobs.set(FILE_URL, FILE_BYTES);
  const updated = await host.acceptUpdate({
    principal: "alice",
    key: "migration-retry-key-000001",
    uid: created.resourceUid,
    expectedGeneration: 1,
    spec: f.spec,
  });
  expect(await host.runNext()).toMatchObject({ id: updated.id, status: "succeeded" });
});

test("empty SQL file requires an authorized source read and a fenced durable sentinel", async () => {
  const f = await fixture({ fileBytes: new Uint8Array(0) });
  f.blobs.delete(FILE_URL);
  const host = f.engine();
  const created = await f.create(host);
  expect(await host.runNext()).toMatchObject({ status: "failed", effect: "none" });
  expect(f.reads).toContain(FILE_URL);
  expect(f.db.query("SELECT * FROM tf_v2_migration_set_chunks").all()).toHaveLength(0);
  f.blobs.set(FILE_URL, new Uint8Array(0));
  const retry = await host.acceptUpdate({
    principal: "alice",
    key: "migration-empty-retry-0001",
    uid: created.resourceUid,
    expectedGeneration: 1,
    spec: f.spec,
  });
  expect(await host.runNext()).toMatchObject({ id: retry.id, status: "succeeded" });
  expect(f.db.query("SELECT length(bytes) AS n FROM tf_v2_migration_set_chunks").get()).toEqual({
    n: 0,
  });
});

test("lost create acknowledgement reconciles from held bytes after source disappearance", async () => {
  let sent = false;
  const f = await fixture({
    customizeForm(form) {
      return {
        ...form,
        backend: {
          ...form.backend,
          async execute(input) {
            const result = await form.backend.execute(input);
            if (!sent) {
              sent = true;
              throw new Error("lost acknowledgement");
            }
            return result;
          },
        },
      };
    },
  });
  const first = f.engine();
  const created = await f.create(first);
  expect(await first.runNext()).toMatchObject({ status: "reconciling", effect: "unknown" });
  f.blobs.clear();
  f.advance(1_001);
  expect(await f.engine().runNext()).toMatchObject({ id: created.id, status: "succeeded" });
  expect(
    (await first.getResource({ principal: "alice", uid: created.resourceUid })).observedGeneration,
  ).toBe(1);
});

test("late old create writer cannot resurrect bytes after reclaimed completion and delete", async () => {
  let release!: () => void;
  let entered!: () => void;
  const waiting = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let held = false;
  const f = await fixture({
    customizeSource(source) {
      return {
        async read(input) {
          if (input.url === FILE_URL && !held) {
            held = true;
            entered();
            await new Promise<void>((resolve) => {
              release = resolve;
            });
          }
          return source.read(input);
        },
      };
    },
  });
  const original = f.engine();
  const created = await f.create(original);
  const oldRun = original.runNext();
  await waiting;
  f.advance(1_001);
  const restarted = f.engine();
  expect(await restarted.runNext()).toMatchObject({ id: created.id, status: "succeeded" });
  const deleted = await restarted.acceptDelete({
    principal: "alice",
    key: "migration-delete-key-00002",
    uid: created.resourceUid,
    expectedGeneration: 1,
  });
  expect(await restarted.runNext()).toMatchObject({ id: deleted.id, status: "succeeded" });
  release();
  await oldRun;
  expect(f.db.query("SELECT * FROM tf_v2_migration_set_owners").all()).toHaveLength(0);
  expect(f.db.query("SELECT * FROM tf_v2_migration_set_chunks").all()).toHaveLength(0);
});

test("a different Form's live reference and delete acceptance cannot both win", async () => {
  const f = await fixture();
  const host = f.engine();
  const set = await f.create(host);
  expect(await host.runNext()).toMatchObject({ status: "succeeded" });

  // Application v2 is not yet implemented. A second Form Resource provides
  // the future referrer, and this direct insert proves the SQL reference fence.
  const otherFormUrl = "https://forms.example.test/reference-fixture/1";
  const other = createTakoformV2Engine({
    sql: createSqliteSql(f.db),
    now: () => new Date("2026-10-06T00:00:00Z"),
    replayWindowSeconds: 3_600,
    authorize: async () => true,
    forms: {
      [otherFormUrl]: {
        validateCreate() {},
        validateUpdate() {},
        backend: {
          id: "reference-fixture-v1",
          targetKey: "fixture-target",
          async execute() {
            return { kind: "complete", observed: {}, output: {} };
          },
          async reconcile() {
            return { kind: "complete", observed: {}, output: {} };
          },
        },
      },
    },
  });
  const referrer = await other.acceptCreate({
    principal: "alice",
    key: "referrer-create-key-0001",
    input: { form: otherFormUrl, space: "default", name: "application", spec: {} },
  });
  expect(await other.runNext()).toMatchObject({ status: "succeeded" });
  const insertReference = () =>
    f.db
      .query("INSERT INTO tf_v2_resource_references (target_uid, referrer_uid) VALUES (?, ?)")
      .run(set.resourceUid, referrer.resourceUid);
  insertReference();
  const before = (f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get() as { n: number })
    .n;
  await expect(
    host.acceptDelete({
      principal: "alice",
      key: "referenced-delete-key-001",
      uid: set.resourceUid,
      expectedGeneration: 1,
    }),
  ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
  expect((f.db.query("SELECT count(*) AS n FROM tf_v2_operations").get() as { n: number }).n).toBe(
    before,
  );
  expect((await host.getResource({ principal: "alice", uid: set.resourceUid })).generation).toBe(1);

  const referrerDelete = await other.acceptDelete({
    principal: "alice",
    key: "referrer-delete-key-0001",
    uid: referrer.resourceUid,
    expectedGeneration: 1,
  });
  // A deleting/failed Application remains live until this Operation succeeds.
  await expect(
    host.acceptDelete({
      principal: "alice",
      key: "still-live-delete-key-01",
      uid: set.resourceUid,
      expectedGeneration: 1,
    }),
  ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });
  expect(await other.runNext()).toMatchObject({ id: referrerDelete.id, status: "succeeded" });
  expect(
    f.db.query("SELECT * FROM tf_v2_resource_references WHERE target_uid = ?").all(set.resourceUid),
  ).toHaveLength(1);
  const deleting = await host.acceptDelete({
    principal: "alice",
    key: "unreferenced-delete-key-01",
    uid: set.resourceUid,
    expectedGeneration: 1,
  });
  expect(deleting.status).toBe("queued");
  expect(await host.runNext()).toMatchObject({ id: deleting.id, status: "succeeded" });
  expect(
    f.db.query("SELECT * FROM tf_v2_resource_references WHERE target_uid = ?").all(set.resourceUid),
  ).toHaveLength(1);
  const replacement = await host.acceptCreate({
    principal: "alice",
    key: "replacement-create-key-01",
    input: {
      form: SQLITE_MIGRATION_SET_FORM_URL,
      space: "default",
      name: "replacement",
      spec: f.spec,
    },
  });
  expect(await host.runNext()).toMatchObject({ id: replacement.id, status: "succeeded" });
  expect(() =>
    f.db
      .query("INSERT INTO tf_v2_resource_references (target_uid, referrer_uid) VALUES (?, ?)")
      .run(replacement.resourceUid, referrer.resourceUid),
  ).toThrow("tf_v2_resource_reference_unavailable");
});
