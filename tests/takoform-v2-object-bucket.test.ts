import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSelfhostV2ObjectBucketStore } from "../src/providers/selfhost-v2-object-bucket-store.ts";
import { createSelfhostObjectStore } from "../src/selfhost-object-store.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  OBJECT_BUCKET_FORM_URL,
  OBJECT_BUCKET_LIMITS,
  ObjectBucketValidationError,
  parseObjectBucketSpec,
  validateObjectBucketUpdate,
} from "../src/takoform-v2/forms/object-bucket.ts";
import { createObjectBucketForm } from "../src/takoform-v2/forms/object-bucket-backend.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const OBJECT_BUCKET_REFERENCE_FORM_URL = "https://fixture.example/ObjectBucketReference/1.0.0/";

test("ObjectBucket accepts only the immutable empty spec", () => {
  expect(parseObjectBucketSpec({})).toEqual({});
  expect(validateObjectBucketUpdate({}, {})).toEqual({});
  for (const value of [null, [], "{}", { region: "local" }, Object.create(null)]) {
    expect(() => parseObjectBucketSpec(value)).toThrow(ObjectBucketValidationError);
  }
  expect(() => validateObjectBucketUpdate({}, { cors: [] })).toThrow(ObjectBucketValidationError);
});

test("ObjectBucket lifecycle uses owned filesystem storage and survives SQLite reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-object-bucket-"));
  const databasePath = join(root, "control.sqlite");
  const objectsRoot = join(root, "objects");
  let database: Database | undefined = new Database(databasePath);
  try {
    migrateSqlite(database);
    let sql = createSqliteSql(database);
    let bucketStore = createSelfhostV2ObjectBucketStore({ sql, root: objectsRoot });
    let form = createObjectBucketForm({ store: bucketStore, targetKey: "selfhost-test-target" });
    const referenceForm = createObjectBucketReferenceForm();
    let host = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3_600,
      authorize: async (principal, space) => principal === "alice" && space === "default",
      forms: {
        [OBJECT_BUCKET_FORM_URL]: form,
        [OBJECT_BUCKET_REFERENCE_FORM_URL]: referenceForm,
      },
    });

    const accepted = await host.acceptCreate({
      principal: "alice",
      key: "object-bucket-create-key-0001",
      input: {
        form: OBJECT_BUCKET_FORM_URL,
        space: "default",
        name: "media",
        spec: {},
      },
    });
    expect(await host.runNext()).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(
      await host.acceptCreate({
        principal: "alice",
        key: "object-bucket-create-key-0001",
        input: { form: OBJECT_BUCKET_FORM_URL, space: "default", name: "media", spec: {} },
      }),
    ).toMatchObject({ id: accepted.id, resourceUid: accepted.resourceUid });

    const consumer = await host.acceptCreate({
      principal: "alice",
      key: "object-bucket-consumer-create-key",
      input: {
        form: OBJECT_BUCKET_REFERENCE_FORM_URL,
        space: "default",
        name: "consumer",
        spec: { bucket: { resourceUid: accepted.resourceUid } },
      },
    });
    expect(await host.runNext()).toMatchObject({ id: consumer.id, status: "succeeded" });
    await expect(
      host.acceptDelete({
        principal: "alice",
        key: "object-bucket-blocked-delete-key",
        uid: accepted.resourceUid,
        expectedGeneration: 1,
      }),
    ).rejects.toMatchObject({ code: "dependency_conflict", status: 409 });

    let resource = await host.getResource({ principal: "alice", uid: accepted.resourceUid });
    expect(resource).toMatchObject({
      observedGeneration: 1,
      observed: { bucketExists: true, ...OBJECT_BUCKET_LIMITS },
      output: {},
    });
    const bucketIdentity = {
      targetKey: "selfhost-test-target",
      principal: "alice",
      space: "default",
      resourceUid: accepted.resourceUid,
    };
    expect(await bucketStore.create({ identity: bucketIdentity, operationId: accepted.id })).toBe(
      "ready",
    );
    expect(
      await bucketStore.create({ identity: bucketIdentity, operationId: "different-create-op" }),
    ).toBe("conflict");
    expect(
      await bucketStore.openBucket({ ...bucketIdentity, targetKey: "different-target" }),
    ).toBeNull();
    let bucket = await bucketStore.openBucket({
      targetKey: "selfhost-test-target",
      principal: "alice",
      space: "default",
      resourceUid: accepted.resourceUid,
    });
    expect(bucket).not.toBeNull();
    if (!bucket) throw new Error("created bucket was not openable");
    const put = await bucket.put(
      "greeting",
      new Blob(["hello"]).stream() as ReadableStream<Uint8Array>,
      {
        contentLength: 5,
      },
    );
    expect(put.size).toBe(5);
    expect(await bucket.head("greeting")).toMatchObject({ etag: put.etag, size: 5 });
    const found = await bucket.get("greeting");
    expect(found && (await new Response(found.body).text())).toBe("hello");
    const upload = await bucket.createMultipartUpload("pending");
    await bucket.uploadPart(
      "pending",
      upload.uploadId,
      1,
      new Blob(["part"]).stream() as ReadableStream<Uint8Array>,
      {
        contentLength: 4,
      },
    );

    const updated = await host.acceptUpdate({
      principal: "alice",
      key: "object-bucket-update-key-0001",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
      spec: {},
    });
    expect(await host.runNext()).toMatchObject({
      id: updated.id,
      status: "succeeded",
      effect: "complete",
    });

    database.close();
    database = undefined;
    database = new Database(databasePath);
    migrateSqlite(database);
    sql = createSqliteSql(database);
    bucketStore = createSelfhostV2ObjectBucketStore({ sql, root: objectsRoot });
    form = createObjectBucketForm({ store: bucketStore, targetKey: "selfhost-test-target" });
    host = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3_600,
      authorize: async (principal, space) => principal === "alice" && space === "default",
      forms: {
        [OBJECT_BUCKET_FORM_URL]: form,
        [OBJECT_BUCKET_REFERENCE_FORM_URL]: referenceForm,
      },
    });
    resource = await host.getResource({ principal: "alice", uid: accepted.resourceUid });
    expect(resource.observedGeneration).toBe(2);
    bucket = await bucketStore.openBucket({
      targetKey: "selfhost-test-target",
      principal: "alice",
      space: "default",
      resourceUid: accepted.resourceUid,
    });
    if (!bucket) throw new Error("reopened bucket was not openable");
    const afterRestart = await bucket.get("greeting");
    expect(afterRestart && (await new Response(afterRestart.body).text())).toBe("hello");

    const consumerDelete = await host.acceptDelete({
      principal: "alice",
      key: "object-bucket-consumer-delete-key",
      uid: consumer.resourceUid,
      expectedGeneration: 1,
    });
    expect(await host.runNext()).toMatchObject({ id: consumerDelete.id, status: "succeeded" });

    const deletion = await host.acceptDelete({
      principal: "alice",
      key: "object-bucket-delete-key-0001",
      uid: accepted.resourceUid,
      expectedGeneration: 2,
    });
    expect(await host.runNext()).toMatchObject({
      id: deletion.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(
      await bucketStore.openBucket({
        targetKey: "selfhost-test-target",
        principal: "alice",
        space: "default",
        resourceUid: accepted.resourceUid,
      }),
    ).toBeNull();
    expect(await sql.query("SELECT bucket_id FROM selfhost_objects")).toEqual([]);
    expect(await sql.query("SELECT bucket_id FROM selfhost_object_uploads")).toEqual([]);
    expect(await sql.query("SELECT bucket_id FROM selfhost_object_upload_parts")).toEqual([]);
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ObjectBucket reconciles a lost create and delete acknowledgement after database reopen", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-object-bucket-reconcile-"));
  const databasePath = join(root, "control.sqlite");
  const objectsRoot = join(root, "objects");
  let nowMs = Date.parse("2026-10-07T00:00:00.000Z");
  let database: Database | undefined = new Database(databasePath);
  try {
    migrateSqlite(database);
    let sql = createSqliteSql(database);
    let bucketStore = createSelfhostV2ObjectBucketStore({ sql, root: objectsRoot });
    const baseForm = () =>
      createObjectBucketForm({ store: bucketStore, targetKey: "selfhost-test-target" });
    let loseCreateAck = true;
    let form = withLostAck(baseForm(), "create", () => {
      if (!loseCreateAck) return false;
      loseCreateAck = false;
      return true;
    });
    const createEngine = (currentForm: V2Form) =>
      createTakoformV2Engine({
        sql,
        now: () => new Date(nowMs),
        replayWindowSeconds: 3_600,
        leaseMilliseconds: 1_000,
        authorize: async (principal, space) => principal === "alice" && space === "default",
        forms: { [OBJECT_BUCKET_FORM_URL]: currentForm },
      });
    let host = createEngine(form);
    const accepted = await host.acceptCreate({
      principal: "alice",
      key: "object-bucket-reconcile-create-key",
      input: { form: OBJECT_BUCKET_FORM_URL, space: "default", name: "media", spec: {} },
    });
    expect(await host.runNext()).toMatchObject({
      id: accepted.id,
      status: "reconciling",
      effect: "unknown",
    });

    database.close();
    database = undefined;
    nowMs += 1_001;
    database = new Database(databasePath);
    migrateSqlite(database);
    sql = createSqliteSql(database);
    bucketStore = createSelfhostV2ObjectBucketStore({ sql, root: objectsRoot });
    form = baseForm();
    host = createEngine(form);
    expect(await host.runNext()).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(
      await host.acceptCreate({
        principal: "alice",
        key: "object-bucket-reconcile-create-key",
        input: { form: OBJECT_BUCKET_FORM_URL, space: "default", name: "media", spec: {} },
      }),
    ).toMatchObject({ id: accepted.id, resourceUid: accepted.resourceUid });

    const bucket = await bucketStore.openBucket({
      targetKey: "selfhost-test-target",
      principal: "alice",
      space: "default",
      resourceUid: accepted.resourceUid,
    });
    if (!bucket) throw new Error("reconciled create did not own the bucket");
    await bucket.put("owned", new Blob(["data"]).stream() as ReadableStream<Uint8Array>, {
      contentLength: 4,
    });
    const upload = await bucket.createMultipartUpload("unfinished");
    await bucket.uploadPart(
      "unfinished",
      upload.uploadId,
      1,
      new Blob(["part"]).stream() as ReadableStream<Uint8Array>,
      { contentLength: 4 },
    );

    const deletion = await host.acceptDelete({
      principal: "alice",
      key: "object-bucket-reconcile-delete-key",
      uid: accepted.resourceUid,
      expectedGeneration: 1,
    });
    let loseDeleteAck = true;
    form = withLostAck(baseForm(), "delete", () => {
      if (!loseDeleteAck) return false;
      loseDeleteAck = false;
      return true;
    });
    host = createEngine(form);
    expect(await host.runNext()).toMatchObject({
      id: deletion.id,
      status: "reconciling",
      effect: "unknown",
    });

    database.close();
    database = undefined;
    nowMs += 1_001;
    database = new Database(databasePath);
    migrateSqlite(database);
    sql = createSqliteSql(database);
    bucketStore = createSelfhostV2ObjectBucketStore({ sql, root: objectsRoot });
    host = createEngine(baseForm());
    expect(await host.runNext()).toMatchObject({
      id: deletion.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(await host.getOperation({ principal: "alice", id: deletion.id })).toMatchObject({
      resourceUid: accepted.resourceUid,
      action: "delete",
      status: "succeeded",
    });
    expect(await sql.query("SELECT bucket_id FROM selfhost_objects")).toEqual([]);
    expect(await sql.query("SELECT bucket_id FROM selfhost_object_uploads")).toEqual([]);
    expect(await sql.query("SELECT bucket_id FROM selfhost_object_upload_parts")).toEqual([]);
    expect(
      await bucketStore.openBucket({
        targetKey: "selfhost-test-target",
        principal: "alice",
        space: "default",
        resourceUid: accepted.resourceUid,
      }),
    ).toBeNull();
  } finally {
    database?.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ObjectBucket never adopts an existing unowned namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-object-bucket-foreign-"));
  const objectsRoot = join(root, "objects");
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const identity = {
      targetKey: "selfhost-test-target",
      principal: "alice",
      space: "default",
      resourceUid: "resource-foreign-test",
    };
    const bucketId = `tsb-${createHash("sha256")
      .update(
        canonicalJson([
          "takoserver.v2.object-bucket-namespace@1",
          identity.targetKey,
          identity.principal,
          identity.space,
          identity.resourceUid,
        ]),
      )
      .digest("hex")
      .slice(0, 40)}`;
    const foreign = createSelfhostObjectStore({ sql, root: objectsRoot });
    await foreign.put(
      bucketId,
      "foreign",
      new Blob(["owned elsewhere"]).stream() as ReadableStream<Uint8Array>,
      {
        contentLength: 15,
      },
    );

    const store = createSelfhostV2ObjectBucketStore({ sql, root: objectsRoot });
    expect(await store.create({ identity, operationId: "accepted-create-op" })).toBe("conflict");
    expect(await store.observe(identity)).toBe("conflict");
    expect(await store.openBucket(identity)).toBeNull();
    expect(await foreign.head(bucketId, "foreign")).toMatchObject({ size: 15 });
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

function withLostAck(form: V2Form, action: "create" | "delete", shouldLose: () => boolean): V2Form {
  const backend = form.backend;
  return {
    ...form,
    backend: {
      ...backend,
      async execute(input) {
        const result = await backend.execute(input);
        if (input.action === action && shouldLose()) {
          return { kind: "unknown", code: "fixture_ack_lost", message: "fixture_ack_lost" };
        }
        return result;
      },
    },
  };
}

function createObjectBucketReferenceForm(): V2Form {
  const complete = async () => ({ kind: "complete" as const, observed: {}, output: {} });
  return {
    validateCreate(spec) {
      if (!spec.bucket || typeof spec.bucket !== "object" || !("resourceUid" in spec.bucket)) {
        throw new TypeError("invalid fixture reference spec");
      }
    },
    validateUpdate(previousSpec, spec) {
      this.validateCreate(previousSpec);
      this.validateCreate(spec);
    },
    references(spec) {
      const bucket = spec.bucket as { readonly resourceUid: string };
      return [
        {
          resourceUid: bucket.resourceUid,
          formUrl: OBJECT_BUCKET_FORM_URL,
          readiness: "observed",
        },
      ];
    },
    backend: {
      id: "fixture-object-bucket-reference-v1",
      targetKey: "fixture-target",
      execute: complete,
      reconcile: complete,
    },
  };
}
