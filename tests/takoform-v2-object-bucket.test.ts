import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
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
    await expect(
      bucket.put(
        "late-write",
        new Blob(["must not return"]).stream() as ReadableStream<Uint8Array>,
        {
          contentLength: 15,
        },
      ),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    await expect(bucket.createMultipartUpload("late-upload")).rejects.toMatchObject({
      code: "backend_unavailable",
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

test("ObjectBucket create reconciliation waits for a delayed accepted create", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-object-bucket-create-race-"));
  const database = new Database(join(root, "control.sqlite"));
  let releaseFirstOccupancy!: () => void;
  let enteredFirstOccupancy!: () => void;
  const firstOccupancyEntered = new Promise<void>((resolve) => {
    enteredFirstOccupancy = resolve;
  });
  const firstOccupancyGate = new Promise<void>((resolve) => {
    releaseFirstOccupancy = resolve;
  });
  try {
    migrateSqlite(database);
    const baseSql = createSqliteSql(database);
    let delayFirstOccupancy = true;
    const sql: Sql = {
      async query(statement, params) {
        if (
          delayFirstOccupancy &&
          statement.includes("SELECT count(*) AS total FROM selfhost_objects")
        ) {
          delayFirstOccupancy = false;
          enteredFirstOccupancy();
          await firstOccupancyGate;
        }
        return await baseSql.query(statement, params);
      },
      run: (statement, params) => baseSql.run(statement, params),
      batch: (statements) => baseSql.batch(statements),
    };
    const store = createSelfhostV2ObjectBucketStore({ sql, root: join(root, "objects") });
    const reopeningStore = createSelfhostV2ObjectBucketStore({ sql, root: join(root, "objects") });
    const identity = {
      targetKey: "selfhost-test-target",
      principal: "alice",
      space: "default",
      resourceUid: "resource-delayed-create",
    };
    const create = store.create({ identity, operationId: "accepted-create-op" });
    await firstOccupancyEntered;
    const reconcile = reopeningStore.reconcileCreate({
      identity,
      operationId: "accepted-create-op",
    });

    const beforeCreateCanCommit = await Promise.race([
      reconcile.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(beforeCreateCanCommit).toBe("blocked");

    releaseFirstOccupancy();
    expect(await create).toBe("ready");
    expect(await reconcile).toBe("ready");
  } finally {
    releaseFirstOccupancy();
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("expired accepted create reconciles only after the original writer is fenced", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-object-bucket-lease-race-"));
  const database = new Database(join(root, "control.sqlite"));
  let releaseFirstOccupancy!: () => void;
  let enteredFirstOccupancy!: () => void;
  const firstOccupancyEntered = new Promise<void>((resolve) => {
    enteredFirstOccupancy = resolve;
  });
  const firstOccupancyGate = new Promise<void>((resolve) => {
    releaseFirstOccupancy = resolve;
  });
  let firstRun: ReturnType<ReturnType<typeof createTakoformV2Engine>["runNext"]> | undefined;
  let reclaimedRun: ReturnType<ReturnType<typeof createTakoformV2Engine>["runNext"]> | undefined;
  try {
    migrateSqlite(database);
    const baseSql = createSqliteSql(database);
    let delayFirstOccupancy = true;
    const sql: Sql = {
      async query(statement, params) {
        if (
          delayFirstOccupancy &&
          statement.includes("SELECT count(*) AS total FROM selfhost_objects")
        ) {
          delayFirstOccupancy = false;
          enteredFirstOccupancy();
          await firstOccupancyGate;
        }
        return await baseSql.query(statement, params);
      },
      run: (statement, params) => baseSql.run(statement, params),
      batch: (statements) => baseSql.batch(statements),
    };
    let nowMs = Date.parse("2026-10-07T00:00:00.000Z");
    const targetKey = "selfhost-test-target";
    const makeEngine = () => {
      const store = createSelfhostV2ObjectBucketStore({ sql, root: join(root, "objects") });
      return createTakoformV2Engine({
        sql,
        now: () => new Date(nowMs),
        leaseMilliseconds: 100,
        replayWindowSeconds: 3_600,
        authorize: async (principal, space) => principal === "alice" && space === "default",
        forms: {
          [OBJECT_BUCKET_FORM_URL]: createObjectBucketForm({ store, targetKey }),
        },
      });
    };
    const firstHost = makeEngine();
    const accepted = await firstHost.acceptCreate({
      principal: "alice",
      key: "object-bucket-delayed-create-key",
      input: { form: OBJECT_BUCKET_FORM_URL, space: "default", name: "media", spec: {} },
    });
    firstRun = firstHost.runNext();
    await firstOccupancyEntered;

    nowMs += 101;
    const recoveryHost = makeEngine();
    reclaimedRun = recoveryHost.runNext();
    const beforeOriginalCompletes = await Promise.race([
      reclaimedRun.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    releaseFirstOccupancy();
    await firstRun;
    const recoveredOperation = await reclaimedRun;

    expect(beforeOriginalCompletes).toBe("blocked");
    expect(recoveredOperation).toMatchObject({
      id: accepted.id,
      status: "succeeded",
      effect: "complete",
    });
    expect(
      await recoveryHost.getResource({ principal: "alice", uid: accepted.resourceUid }),
    ).toMatchObject({
      observedGeneration: 1,
      observed: { bucketExists: true },
    });
  } finally {
    releaseFirstOccupancy();
    await Promise.allSettled([firstRun, reclaimedRun].filter((run) => run !== undefined));
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ObjectBucket refuses a second live process handle for an owned namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-object-bucket-process-owner-"));
  const databasePath = join(root, "control.sqlite");
  const objectsRoot = join(root, "objects");
  const database = new Database(databasePath);
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const identity = {
      targetKey: "selfhost-test-target",
      principal: "alice",
      space: "default",
      resourceUid: "resource-process-owner",
    };
    const store = createSelfhostV2ObjectBucketStore({ sql, root: objectsRoot });
    expect(await store.create({ identity, operationId: "accepted-create-op" })).toBe("ready");

    const sqlModule = new URL("../src/sql-sqlite.ts", import.meta.url).href;
    const storeModule = new URL(
      "../src/providers/selfhost-v2-object-bucket-store.ts",
      import.meta.url,
    ).href;
    const script = `
      import { Database } from "bun:sqlite";
      import { createSqliteSql } from ${JSON.stringify(sqlModule)};
      import { createSelfhostV2ObjectBucketStore } from ${JSON.stringify(storeModule)};
      const database = new Database(process.env.OBJECT_BUCKET_DB);
      const sql = createSqliteSql(database);
      const store = createSelfhostV2ObjectBucketStore({ sql, root: process.env.OBJECT_BUCKET_ROOT });
      const access = await store.openBucket(JSON.parse(process.env.OBJECT_BUCKET_IDENTITY));
      process.stdout.write(access ? "opened" : "refused");
      database.close();
    `;
    const child = Bun.spawn([process.execPath, "--no-env-file", "--eval", script], {
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        OBJECT_BUCKET_DB: databasePath,
        OBJECT_BUCKET_ROOT: objectsRoot,
        OBJECT_BUCKET_IDENTITY: JSON.stringify(identity),
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    const errorOutput = await new Response(child.stderr).text();
    const exitCode = await child.exited;
    expect(exitCode).toBe(0);
    expect(errorOutput).toBe("");
    expect(output).toBe("refused");
  } finally {
    database.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("ObjectBucket delete waits for an in-flight write and prevents stale-handle resurrection", async () => {
  const root = await mkdtemp(join(tmpdir(), "takoserver-v2-object-bucket-delete-race-"));
  const database = new Database(join(root, "control.sqlite"));
  let releaseBody!: () => void;
  let enteredBody!: () => void;
  const bodyEntered = new Promise<void>((resolve) => {
    enteredBody = resolve;
  });
  const bodyGate = new Promise<void>((resolve) => {
    releaseBody = resolve;
  });
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const store = createSelfhostV2ObjectBucketStore({ sql, root: join(root, "objects") });
    const identity = {
      targetKey: "selfhost-test-target",
      principal: "alice",
      space: "default",
      resourceUid: "resource-delete-race",
    };
    expect(await store.create({ identity, operationId: "accepted-create-op" })).toBe("ready");
    const access = await store.openBucket(identity);
    if (!access) throw new Error("created bucket was not openable");

    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        enteredBody();
        await bodyGate;
        controller.enqueue(new TextEncoder().encode("payload"));
        controller.close();
      },
    });
    const put = access.put("racing", body, { contentLength: 7 });
    const putOutcome = put.then(
      () => ({ kind: "resolved" as const }),
      (error: unknown) => ({ kind: "rejected" as const, error }),
    );
    await bodyEntered;
    const deletion = store.delete({ identity, operationId: "accepted-delete-op" });
    const beforeBodyCanFinish = await Promise.race([
      deletion.then(() => "settled" as const),
      new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 100)),
    ]);
    expect(beforeBodyCanFinish).toBe("blocked");

    releaseBody();
    expect(await putOutcome).toMatchObject({ kind: "resolved" });
    expect(await deletion).toBe("deleted");
    await expect(
      access.put("after-delete", new Blob(["late"]).stream() as ReadableStream<Uint8Array>, {
        contentLength: 4,
      }),
    ).rejects.toMatchObject({ code: "backend_unavailable" });
    expect(await sql.query("SELECT bucket_id FROM selfhost_objects")).toEqual([]);
    expect(await sql.query("SELECT bucket_id FROM selfhost_object_uploads")).toEqual([]);
  } finally {
    releaseBody();
    database.close();
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
