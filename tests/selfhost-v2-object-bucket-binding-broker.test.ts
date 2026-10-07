import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest, canonicalJson } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { JsonObject } from "../src/ports.ts";
import {
  createSelfhostV2ObjectBucketBindingBroker,
  SELFHOST_V2_OBJECT_MULTIPART_PARTS_CONTENT_TYPE,
  type V2ObjectBucketBindingGrant,
} from "../src/providers/selfhost-v2-object-bucket-binding-broker.ts";
import {
  createSelfhostV2ObjectBucketStore,
  type SelfhostV2ObjectBucketIdentity,
} from "../src/providers/selfhost-v2-object-bucket-store.ts";
import {
  SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
  SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER,
  SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER,
  SELFHOST_DATA_PLANE_OBJECTS_PATH,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createTakoformV2Engine } from "../src/takoform-v2/engine.ts";
import {
  OBJECT_BUCKET_FORM_URL,
  OBJECT_BUCKET_LIMITS,
} from "../src/takoform-v2/forms/object-bucket.ts";
import {
  createObjectBucketForm,
  OBJECT_BUCKET_BACKEND_ID,
} from "../src/takoform-v2/forms/object-bucket-backend.ts";
import { createObjectBucketWorkerBindingAuthority } from "../src/takoform-v2/forms/object-bucket-worker-binding-authority.ts";
import { WORKER_BUNDLE_FORM_URL } from "../src/takoform-v2/forms/worker-bundle.ts";
import { referencesForWorkerVersion } from "../src/takoform-v2/forms/worker-references.ts";
import {
  MODULE_WORKER_FORM_URL,
  parseModuleWorkerSpec,
  parseWorkerVersionSpec,
  WORKER_VERSION_FORM_URL,
} from "../src/takoform-v2/forms/worker-specs.ts";
import type { V2Form } from "../src/takoform-v2/types.ts";

const TARGET = "v2-object-binding-target";
const ORIGIN = "http://127.0.0.1";
const IDENTITY: SelfhostV2ObjectBucketIdentity = {
  targetKey: TARGET,
  principal: "alice",
  space: "default",
  resourceUid: "bucket-one",
};
const GRANT: V2ObjectBucketBindingGrant = {
  principal: IDENTITY.principal,
  space: IDENTITY.space,
  targetKey: TARGET,
  workerUid: "worker-one",
  workerVersionUid: "version-one",
  workerVersionOperationId: "version-op-one",
  nativeVersionId: "native-version-one",
  incarnationId: "native-incarnation-one",
  servingSourceOperationId: "serving-op-one",
  bindings: [{ name: "MEDIA", resourceUid: IDENTITY.resourceUid }],
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "v2-object-broker-"));
  const databasePath = join(root, "control.sqlite");
  let database = new Database(databasePath);
  database.exec("PRAGMA foreign_keys = ON");
  migrateSqlite(database);
  let store = createSelfhostV2ObjectBucketStore({
    sql: createSqliteSql(database),
    root: join(root, "objects"),
  });
  expect(await store.create({ identity: IDENTITY, operationId: "bucket-create-op" })).toBe("ready");

  let nativeStatus: "active" | "draining" | "stopped" = "active";
  let bucketCurrent = true;
  const makeBroker = () =>
    createSelfhostV2ObjectBucketBindingBroker({
      store,
      targetKey: TARGET,
      signingKey: new Uint8Array(32).fill(9),
      async observeVersionTarget(input) {
        if (nativeStatus === "stopped") return { kind: "unknown" as const };
        return {
          kind: "confirmed" as const,
          workerUid: input.workerUid,
          versionId: input.versionId,
          incarnationId: input.incarnationId,
          servingSourceOperationId: input.servingSourceOperationId,
          status: nativeStatus,
        };
      },
      async resolveCurrentBucketBinding(grant, binding) {
        if (
          !bucketCurrent ||
          grant.workerUid !== GRANT.workerUid ||
          grant.workerVersionUid !== GRANT.workerVersionUid ||
          grant.workerVersionOperationId !== GRANT.workerVersionOperationId ||
          binding !== "MEDIA"
        )
          return null;
        return { identity: IDENTITY, vector: "v1:bucket-generation-1" };
      },
    });
  let broker = makeBroker();
  const token = broker.issueGrant(GRANT);

  async function request(
    document: Record<string, unknown>,
    body?: BodyInit,
    offeredToken = token,
  ): Promise<Response> {
    const encoded = Buffer.from(
      JSON.stringify({ protocol: SELFHOST_DATA_PLANE_OBJECT_PROTOCOL, ...document }),
    ).toString("base64url");
    const response = await broker.handle(
      new Request(`${ORIGIN}${SELFHOST_DATA_PLANE_OBJECTS_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${offeredToken}`,
          "content-type": SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
          [SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER]: encoded,
        },
        ...(body === undefined ? {} : { body }),
        ...(body instanceof ReadableStream ? { duplex: "half" as const } : {}),
      }),
    );
    if (!response) throw new Error("broker did not claim object route");
    return response;
  }

  return {
    root,
    get database() {
      return database;
    },
    get broker() {
      return broker;
    },
    token,
    request,
    stopNative() {
      nativeStatus = "stopped";
    },
    drainNative() {
      nativeStatus = "draining";
    },
    revokeBucket() {
      bucketCurrent = false;
    },
    allowBucket() {
      bucketCurrent = true;
    },
    async deleteBucket() {
      return await store.delete({ identity: IDENTITY, operationId: "bucket-delete-op" });
    },
    reopen() {
      database.close();
      database = new Database(databasePath);
      migrateSqlite(database);
      store = createSelfhostV2ObjectBucketStore({
        sql: createSqliteSql(database),
        root: join(root, "objects"),
      });
      broker = makeBroker();
    },
    close() {
      database.close();
      rmSync(root, { recursive: true, force: true });
    },
  };
}

function decodeResult(response: Response): Record<string, unknown> {
  const encoded = response.headers.get(SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER);
  if (!encoded) throw new Error("object result header missing");
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
}

test("ObjectBucket broker requires a persistent signing key and exact grant shape", () => {
  expect(() => createSelfhostV2ObjectBucketBindingBroker({} as never)).toThrow(TypeError);
  expect(() =>
    createSelfhostV2ObjectBucketBindingBroker({
      store: {} as never,
      targetKey: TARGET,
      signingKey: new Uint8Array(31),
      observeVersionTarget: async () => ({ kind: "unknown" }),
      resolveCurrentBucketBinding: async () => null,
    }),
  ).toThrow(TypeError);
});

test("grant bindings use the WorkerVersion code-unit comparator", async () => {
  const host = await fixture();
  try {
    const token = host.broker.issueGrant({
      ...GRANT,
      bindings: [
        { name: "_B", resourceUid: "bucket-underscore" },
        { name: "A", resourceUid: "bucket-letter" },
      ],
    });
    const payload = Buffer.from(token.split(".")[0] ?? "", "base64url").toString("utf8");
    const parsed = JSON.parse(payload) as V2ObjectBucketBindingGrant;
    expect(parsed.bindings.map(({ name }) => name)).toEqual(["A", "_B"]);
  } finally {
    host.close();
  }
});

test("signed object binding streams CRUD, range, listing, and multipart through the exact UID bucket", async () => {
  const host = await fixture();
  try {
    const put = await host.request(
      {
        binding: "MEDIA",
        op: "put",
        key: "asset.txt",
        contentLength: 5,
        contentType: "text/plain",
      },
      "hello",
    );
    expect(put.status).toBe(200);
    expect(await put.json()).toMatchObject({ ok: true, value: { size: 5 } });
    host.reopen();
    const afterReopen = await host.request({ binding: "MEDIA", op: "get", key: "asset.txt" });
    expect(decodeResult(afterReopen)).toMatchObject({ size: 5 });
    expect(await afterReopen.text()).toBe("hello");

    const ranged = await host.request({
      binding: "MEDIA",
      op: "get",
      key: "asset.txt",
      range: { offset: 1, length: 3 },
    });
    expect(ranged.headers.get("content-type")).toBe(SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE);
    expect(decodeResult(ranged)).toMatchObject({ partial: true, range: { offset: 1, length: 3 } });
    expect(await ranged.text()).toBe("ell");

    const head = await host.request({ binding: "MEDIA", op: "head", key: "asset.txt" });
    expect(await head.json()).toMatchObject({ ok: true, value: { found: true, size: 5 } });
    const list = await host.request({ binding: "MEDIA", op: "list", prefix: "asset", limit: 10 });
    expect(await list.json()).toMatchObject({
      ok: true,
      value: { objects: [{ key: "asset.txt", size: 5 }] },
    });

    const upload = await host.request({
      binding: "MEDIA",
      op: "createMultipartUpload",
      key: "multipart.bin",
    });
    const { uploadId } = ((await upload.json()) as { value: { uploadId: string } }).value;
    const partBytes = new Uint8Array(5 * 1024 * 1024).fill(65);
    const part = await host.request(
      {
        binding: "MEDIA",
        op: "uploadPart",
        key: "multipart.bin",
        uploadId,
        partNumber: 1,
        contentLength: partBytes.byteLength,
      },
      partBytes,
    );
    const partValue = ((await part.json()) as { value: { etag: string; partNumber: number } })
      .value;
    expect(partValue.partNumber).toBe(1);
    const completed = await host.request({
      binding: "MEDIA",
      op: "completeMultipartUpload",
      key: "multipart.bin",
      uploadId,
      parts: [{ etag: partValue.etag, partNumber: 1 }],
    });
    expect(await completed.json()).toMatchObject({
      ok: true,
      value: { size: partBytes.byteLength },
    });

    expect(
      await (await host.request({ binding: "MEDIA", op: "delete", key: "asset.txt" })).json(),
    ).toEqual({ ok: true, value: {} });
    expect(
      await (await host.request({ binding: "MEDIA", op: "head", key: "asset.txt" })).json(),
    ).toEqual({ ok: true, value: { found: false } });
    const abortStart = await host.request({
      binding: "MEDIA",
      op: "createMultipartUpload",
      key: "abort.bin",
    });
    const { uploadId: abortedUploadId } = (
      (await abortStart.json()) as { value: { uploadId: string } }
    ).value;
    expect(
      await (
        await host.request({
          binding: "MEDIA",
          op: "abortMultipartUpload",
          key: "abort.bin",
          uploadId: abortedUploadId,
        })
      ).json(),
    ).toEqual({ ok: true, value: {} });
    expect(
      await (
        await host.request({
          binding: "MEDIA",
          op: "uploadPart",
          key: "abort.bin",
          uploadId: abortedUploadId,
          partNumber: 1,
          contentLength: 0,
        })
      ).json(),
    ).toMatchObject({ ok: false, error: { code: "upload_not_found" } });
  } finally {
    host.close();
  }
}, 30_000);

test("grant, native incarnation, draining, and Core bucket reference are checked for every call", async () => {
  const host = await fixture();
  try {
    const forged = `${host.token.slice(0, -1)}${host.token.endsWith("a") ? "b" : "a"}`;
    expect(
      await host
        .request({ binding: "MEDIA", op: "head", key: "x" }, undefined, forged)
        .then((r) => r.status),
    ).toBe(401);
    expect(
      await host.request({ binding: "OTHER", op: "head", key: "x" }).then((r) => r.status),
    ).toBe(404);
    const foreignToken = host.broker.issueGrant({
      ...GRANT,
      bindings: [{ name: "MEDIA", resourceUid: "foreign-bucket" }],
    });
    expect(
      await host
        .request({ binding: "MEDIA", op: "head", key: "x" }, undefined, foreignToken)
        .then((r) => r.json()),
    ).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });

    host.drainNative();
    expect(
      await host.request({ binding: "MEDIA", op: "head", key: "x" }).then((r) => r.status),
    ).toBe(200);
    expect(await host.deleteBucket()).toBe("deleted");
    const deletedBucketToken = host.broker.issueGrant(GRANT);
    expect(
      await host
        .request({ binding: "MEDIA", op: "head", key: "x" }, undefined, deletedBucketToken)
        .then((r) => r.json()),
    ).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
    host.revokeBucket();
    expect(
      await host.request({ binding: "MEDIA", op: "head", key: "x" }).then((r) => r.json()),
    ).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    host.allowBucket();
    host.stopNative();
    expect(
      await host.request({ binding: "MEDIA", op: "head", key: "x" }).then((r) => r.json()),
    ).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
  } finally {
    host.close();
  }
});

test("a streaming write is stopped when the native/Core grant changes during body delivery", async () => {
  const host = await fixture();
  try {
    host.reopen();
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        host.revokeBucket();
        controller.enqueue(new TextEncoder().encode("late"));
        controller.close();
      },
    });
    const response = await host.request(
      { binding: "MEDIA", op: "put", key: "late.txt", contentLength: 4 },
      body,
    );
    expect(await response.json()).toEqual({
      ok: false,
      error: { code: "backend_unavailable" },
    });
    host.allowBucket();
    expect(
      await (await host.request({ binding: "MEDIA", op: "head", key: "late.txt" })).json(),
    ).toEqual({
      ok: true,
      value: { found: false },
    });
  } finally {
    host.close();
  }
});

test("multipart completion body carries the full sorted 10,000-part manifest", async () => {
  let capturedPartCount = 0;
  let firstPart: { etag: string; partNumber: number } | undefined;
  let lastPart: { etag: string; partNumber: number } | undefined;
  const bucketAccess = {
    async completeMultipartUpload(
      _key: string,
      _uploadId: string,
      parts: readonly { etag: string; partNumber: number }[],
    ) {
      capturedPartCount = parts.length;
      firstPart = parts[0];
      lastPart = parts.at(-1);
      return { etag: "complete-etag", size: 1 };
    },
  };
  const broker = createSelfhostV2ObjectBucketBindingBroker({
    store: {
      async openBucket() {
        return bucketAccess;
      },
    } as never,
    targetKey: TARGET,
    signingKey: new Uint8Array(32).fill(13),
    async observeVersionTarget(input) {
      return {
        kind: "confirmed" as const,
        workerUid: input.workerUid,
        versionId: input.versionId,
        incarnationId: input.incarnationId,
        servingSourceOperationId: input.servingSourceOperationId,
        status: "active" as const,
      };
    },
    async resolveCurrentBucketBinding() {
      return { identity: IDENTITY, vector: "current" };
    },
  });
  const token = broker.issueGrant(GRANT);
  const parts = Array.from({ length: 10_000 }, (_, index) => ({
    etag: `etag-${index + 1}`,
    partNumber: index + 1,
  }));
  const headerDocument = Buffer.from(
    JSON.stringify({
      protocol: SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
      binding: "MEDIA",
      op: "completeMultipartUpload",
      key: "large.bin",
      uploadId: "upload-1",
    }),
  ).toString("base64url");
  const send = async (manifestParts: readonly { etag: string; partNumber: number }[]) =>
    await broker.handle(
      new Request(`${ORIGIN}${SELFHOST_DATA_PLANE_OBJECTS_PATH}`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": SELFHOST_V2_OBJECT_MULTIPART_PARTS_CONTENT_TYPE,
          [SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER]: headerDocument,
        },
        body: JSON.stringify({ parts: manifestParts }),
      }),
    );
  const response = await send(parts);
  expect(response?.status).toBe(200);
  expect(await response?.json()).toEqual({
    ok: true,
    value: { etag: "complete-etag", size: 1 },
  });
  expect(capturedPartCount).toBe(10_000);
  expect(firstPart?.etag).toBe("etag-1");
  expect(firstPart?.partNumber).toBe(1);
  expect(lastPart?.etag).toBe("etag-10000");
  expect(lastPart?.partNumber).toBe(10_000);
  expect(
    await (
      await send([
        { etag: "etag-2", partNumber: 2 },
        { etag: "etag-1", partNumber: 1 },
      ])
    )?.json(),
  ).toMatchObject({ ok: false, error: { code: "invalid_part" } });
  expect(
    await (await send([...parts, { etag: "etag-10001", partNumber: 10_001 }]))?.json(),
  ).toMatchObject({ ok: false, error: { code: "invalid_part" } });
});

test("Core reader proves the exact sealed same-owner binding and survives immutable Version PUT", async () => {
  const root = mkdtempSync(join(tmpdir(), "v2-object-authority-"));
  const database = new Database(join(root, "control.sqlite"));
  try {
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const store = createSelfhostV2ObjectBucketStore({ sql, root: join(root, "objects") });
    const complete = async () => ({ kind: "complete" as const, observed: {}, output: {} });
    const moduleForm: V2Form = {
      validateCreate(spec) {
        parseModuleWorkerSpec(spec);
      },
      validateUpdate(previous, next) {
        parseModuleWorkerSpec(previous);
        parseModuleWorkerSpec(next);
      },
      backend: {
        id: "fixture-module-worker-v1",
        targetKey: TARGET,
        execute: complete,
        reconcile: complete,
      },
    };
    const bundleForm: V2Form = {
      validateCreate() {},
      validateUpdate() {},
      backend: {
        id: "fixture-worker-bundle-v1",
        targetKey: TARGET,
        execute: complete,
        reconcile: complete,
      },
    };
    const versionForm: V2Form = {
      validateCreate(spec) {
        parseWorkerVersionSpec(spec);
      },
      validateUpdate(previous, next) {
        const before = parseWorkerVersionSpec(previous);
        const after = parseWorkerVersionSpec(next);
        if (canonicalJson(before) !== canonicalJson(after))
          throw new TypeError("immutable Version");
      },
      references(spec) {
        return referencesForWorkerVersion(parseWorkerVersionSpec(spec));
      },
      backend: {
        id: "fixture-worker-version-v1",
        targetKey: TARGET,
        async execute() {
          return { kind: "complete", observed: { ready: true }, output: {} };
        },
        async reconcile() {
          return { kind: "complete", observed: { ready: true }, output: {} };
        },
      },
    };
    const bucketForm = createObjectBucketForm({ store, targetKey: TARGET });
    const engine = createTakoformV2Engine({
      sql,
      replayWindowSeconds: 3600,
      forms: {
        [MODULE_WORKER_FORM_URL]: moduleForm,
        [WORKER_BUNDLE_FORM_URL]: bundleForm,
        [WORKER_VERSION_FORM_URL]: versionForm,
        [OBJECT_BUCKET_FORM_URL]: bucketForm,
      },
      async authorize() {
        return true;
      },
    });
    async function create(form: string, name: string, spec: JsonObject) {
      const operation = await engine.acceptCreate({
        principal: "alice",
        key: `core-authority-${name}`,
        input: { form, space: "default", name, spec },
      });
      expect((await engine.runNext())?.status).toBe("succeeded");
      return operation;
    }
    const worker = await create(MODULE_WORKER_FORM_URL, "worker", {});
    const bucket = await create(OBJECT_BUCKET_FORM_URL, "bucket", {});
    const bundle = await create(WORKER_BUNDLE_FORM_URL, "bundle", {});
    const versionSpec = parseWorkerVersionSpec({
      worker: { resourceUid: worker.resourceUid },
      bundle: { resourceUid: bundle.resourceUid },
      handlers: ["fetch"],
      bucketBindings: [{ name: "MEDIA", resource: { resourceUid: bucket.resourceUid } }],
    });
    const version = await create(
      WORKER_VERSION_FORM_URL,
      "version",
      versionSpec as unknown as JsonObject,
    );
    const versionGeneration = 1;
    const nativeVersionDigest = await bytesDigest(
      new TextEncoder().encode(`${version.resourceUid}\u0000${versionGeneration}`),
    );
    const grant: V2ObjectBucketBindingGrant = {
      principal: "alice",
      space: "default",
      targetKey: TARGET,
      workerUid: worker.resourceUid,
      workerVersionUid: version.resourceUid,
      workerVersionOperationId: version.id,
      nativeVersionId: `v2-${nativeVersionDigest.slice("sha256:".length)}`,
      incarnationId: "incarnation-v1",
      servingSourceOperationId: "source-op-v1",
      bindings: [{ name: "MEDIA", resourceUid: bucket.resourceUid }],
    };
    const authority = createObjectBucketWorkerBindingAuthority({ sql, targetKey: TARGET });
    const first = await authority.resolveCurrentBucketBinding(grant, "MEDIA");
    expect(first).toMatchObject({
      identity: {
        targetKey: TARGET,
        principal: "alice",
        space: "default",
        resourceUid: bucket.resourceUid,
      },
    });
    expect(
      await authority.resolveCurrentBucketBinding(
        { ...grant, nativeVersionId: "v2-not-derived-from-the-accepted-version-operation" },
        "MEDIA",
      ),
    ).toBeNull();
    expect(
      await authority.resolveCurrentBucketBinding(
        { ...grant, workerVersionOperationId: bucket.id },
        "MEDIA",
      ),
    ).toBeNull();
    expect(
      await authority.resolveCurrentBucketBinding(
        { ...grant, targetKey: "foreign-target" },
        "MEDIA",
      ),
    ).toBeNull();
    expect(await authority.resolveCurrentBucketBinding(grant, "OTHER")).toBeNull();
    const broker = createSelfhostV2ObjectBucketBindingBroker({
      store,
      targetKey: TARGET,
      signingKey: new Uint8Array(32).fill(11),
      async observeVersionTarget(input) {
        return {
          kind: "confirmed" as const,
          workerUid: input.workerUid,
          versionId: input.versionId,
          incarnationId: input.incarnationId,
          servingSourceOperationId: input.servingSourceOperationId,
          status: "active" as const,
        };
      },
      resolveCurrentBucketBinding: authority.resolveCurrentBucketBinding,
    });
    const token = broker.issueGrant(grant);
    async function brokerHead() {
      const document = Buffer.from(
        JSON.stringify({
          protocol: SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
          binding: "MEDIA",
          op: "head",
          key: "probe",
        }),
      ).toString("base64url");
      const response = await broker.handle(
        new Request(`${ORIGIN}${SELFHOST_DATA_PLANE_OBJECTS_PATH}`, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            [SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER]: document,
          },
        }),
      );
      if (!response) throw new Error("broker route missing");
      return await response.json();
    }
    expect(await brokerHead()).toEqual({ ok: true, value: { found: false } });

    await engine.acceptUpdate({
      principal: "alice",
      key: "core-authority-version-same-spec-update",
      uid: version.resourceUid,
      expectedGeneration: 1,
      spec: versionSpec as unknown as JsonObject,
    });
    expect((await engine.runNext())?.status).toBe("succeeded");
    const afterSameSpecPut = await authority.resolveCurrentBucketBinding(grant, "MEDIA");
    expect(afterSameSpecPut).not.toBeNull();
    expect(afterSameSpecPut?.vector).not.toBe(first?.vector);
    expect(await brokerHead()).toEqual({ ok: true, value: { found: false } });

    await sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      canonicalJson({ bucketExists: false, ...OBJECT_BUCKET_LIMITS }),
      bucket.resourceUid,
    ]);
    expect(await authority.resolveCurrentBucketBinding(grant, "MEDIA")).toBeNull();
    expect(await brokerHead()).toMatchObject({ ok: false, error: { code: "backend_unavailable" } });
    expect(OBJECT_BUCKET_BACKEND_ID).toBe("selfhost-v2-object-bucket-filesystem-v1");
  } finally {
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
});
