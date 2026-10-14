import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
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
  selfhostWorkerPreludeModuleName,
  selfhostWorkerPreludeSource,
} from "../src/providers/selfhost-worker-prelude.ts";
import {
  SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
  SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
  SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER,
  SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER,
  SELFHOST_DATA_PLANE_OBJECTS_PATH,
  SELFHOST_V2_OBJECT_BUCKET_BINDING_ORIGIN,
  SELFHOST_V2_OBJECT_BUCKET_BINDING_PATH,
  SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
  selfhostWorkerEntrypointSource,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING } from "../src/providers/workerd-v2-private-binding-names.ts";
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
const ALTERNATE_BACKEND_ID = "operator-selected-object-bucket-v1";
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

function fragmentedObjectWire(chunks: readonly (readonly number[])[]): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (index === chunks.length) controller.close();
        else {
          const chunk = chunks[index++];
          if (chunk === undefined) throw new Error("missing wire fixture chunk");
          controller.enqueue(new Uint8Array(chunk));
        }
      },
    },
    { highWaterMark: 0 },
  );
}

test("signed ObjectBucket framed receiver assembles fragmented records and validated zero-byte EOF", async () => {
  const host = await fixture();
  try {
    const put = await host.request(
      {
        binding: "MEDIA",
        op: "put",
        key: "fragmented",
        bodyFormat: SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
      },
      fragmentedObjectWire([
        [],
        [0, 0],
        [],
        [0],
        [2, 104],
        [],
        [101],
        [0, 0, 0],
        [3],
        [108, 108],
        [],
        [111, 255, 255],
        [255],
        [],
        [255],
        [],
      ]),
    );
    expect(await put.json()).toEqual({
      ok: true,
      value: {
        etag: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        size: 5,
      },
    });
    const found = await host.request({ binding: "MEDIA", op: "get", key: "fragmented" });
    expect(decodeResult(found)).toMatchObject({ size: 5 });
    expect(await found.text()).toBe("hello");
    const emptyWires = [
      [[255], [], [255, 255], [255], []],
      [[], [255, 255, 255, 255], []],
    ];
    for (const [index, chunks] of emptyWires.entries()) {
      const zero = await host.request(
        {
          binding: "MEDIA",
          op: "put",
          key: `zero-frame-${index}`,
          bodyFormat: SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
        },
        fragmentedObjectWire(chunks),
      );
      expect(await zero.json()).toEqual({
        ok: true,
        value: {
          etag: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          size: 0,
        },
      });
      const zeroGet = await host.request({
        binding: "MEDIA",
        op: "get",
        key: `zero-frame-${index}`,
      });
      expect(await zeroGet.text()).toBe("");
    }
  } finally {
    host.close();
  }
});

test("signed ObjectBucket framed receiver refuses malformed EOF without changing objects or part receipts", async () => {
  const host = await fixture();
  try {
    const prior = await host.request(
      { binding: "MEDIA", op: "put", key: "previous-frame" },
      "stable",
    );
    expect(await prior.json()).toMatchObject({ ok: true, value: { size: 6 } });
    const upload = await host.request({
      binding: "MEDIA",
      op: "createMultipartUpload",
      key: "part-frame-recovery",
    });
    const { uploadId } = ((await upload.json()) as { value: { uploadId: string } }).value;
    const original = await host.request(
      {
        binding: "MEDIA",
        op: "uploadPart",
        key: "part-frame-recovery",
        uploadId,
        partNumber: 1,
      },
      "original",
    );
    const { etag, partNumber } = (
      (await original.json()) as { value: { etag: string; partNumber: number } }
    ).value;
    const malformed: { reason: string; chunks: readonly (readonly number[])[] }[] = [
      { reason: "clean empty HTTP EOF is not producer EOF", chunks: [[], []] },
      {
        reason: "zero-length wire data records cannot inflate the frame budget",
        chunks: [
          [0, 0, 0, 0],
          [255, 255, 255, 255],
        ],
      },
      { reason: "data without terminal", chunks: [[0, 0, 0, 3], [1, 2, 3], []] },
      { reason: "truncated length header", chunks: [[0], [], [0, 0]] },
      { reason: "truncated record data", chunks: [[0, 0, 0, 3], [1], [], [2]] },
      { reason: "record exceeds 65536 bytes", chunks: [[0, 1], [], [0, 1]] },
      { reason: "truncated terminal after data", chunks: [[0, 0, 0, 1, 65, 255, 255], [255]] },
      {
        reason: "trailing byte buffered with terminal",
        chunks: [[0, 0, 0, 1, 65, 255, 255, 255, 255, 9]],
      },
      { reason: "trailing byte in later wire chunk", chunks: [[255, 255, 255, 255], [], [9]] },
      {
        reason: "duplicate terminal",
        chunks: [
          [255, 255, 255, 255],
          [255, 255, 255, 255],
        ],
      },
    ];
    for (const malformedWire of malformed) {
      const put = await host.request(
        {
          binding: "MEDIA",
          op: "put",
          key: "previous-frame",
          bodyFormat: SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
        },
        fragmentedObjectWire(malformedWire.chunks),
      );
      expect({ reason: malformedWire.reason, result: await put.json() }).toEqual({
        reason: malformedWire.reason,
        result: { ok: false, error: { code: "backend_unavailable" } },
      });
      const replacement = await host.request(
        {
          binding: "MEDIA",
          op: "uploadPart",
          key: "part-frame-recovery",
          uploadId,
          partNumber: 1,
          bodyFormat: SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
        },
        fragmentedObjectWire(malformedWire.chunks),
      );
      expect({ reason: malformedWire.reason, result: await replacement.json() }).toEqual({
        reason: malformedWire.reason,
        result: { ok: false, error: { code: "backend_unavailable" } },
      });
      const previous = await host.request({ binding: "MEDIA", op: "get", key: "previous-frame" });
      expect(await previous.text()).toBe("stable");
    }
    host.reopen();
    const previous = await host.request({ binding: "MEDIA", op: "get", key: "previous-frame" });
    expect(await previous.text()).toBe("stable");
    const completed = await host.request({
      binding: "MEDIA",
      op: "completeMultipartUpload",
      key: "part-frame-recovery",
      uploadId,
      parts: [{ etag, partNumber }],
    });
    expect(await completed.json()).toMatchObject({ ok: true, value: { size: 8 } });
    const recovered = await host.request({
      binding: "MEDIA",
      op: "get",
      key: "part-frame-recovery",
    });
    expect(await recovered.text()).toBe("original");
  } finally {
    host.close();
  }
});

test("signed ObjectBucket framed receiver checks declared logical bytes rather than framing bytes", async () => {
  const host = await fixture();
  try {
    const helloFrame = () =>
      fragmentedObjectWire([[0, 0], [0, 5, 104, 101], [], [108, 108, 111], [255, 255, 255, 255]]);
    const exact = await host.request(
      {
        binding: "MEDIA",
        op: "put",
        key: "declared-frame",
        contentLength: 5,
        bodyFormat: SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
      },
      helloFrame(),
    );
    expect(await exact.json()).toMatchObject({ ok: true, value: { size: 5 } });
    const upload = await host.request({
      binding: "MEDIA",
      op: "createMultipartUpload",
      key: "declared-frame-part",
    });
    const { uploadId } = ((await upload.json()) as { value: { uploadId: string } }).value;
    const exactPart = await host.request(
      {
        binding: "MEDIA",
        op: "uploadPart",
        key: "declared-frame-part",
        uploadId,
        partNumber: 1,
        contentLength: 5,
        bodyFormat: SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
      },
      helloFrame(),
    );
    const partEnvelope = (await exactPart.json()) as {
      ok: boolean;
      value: { etag: string; partNumber: number; size: number };
    };
    expect(partEnvelope).toEqual({
      ok: true,
      value: {
        etag: "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
        partNumber: 1,
        size: 5,
      },
    });
    for (const contentLength of [4, 6, 13]) {
      const mismatch = await host.request(
        {
          binding: "MEDIA",
          op: "put",
          key: "declared-frame",
          contentLength,
          bodyFormat: SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
        },
        helloFrame(),
      );
      expect(await mismatch.json()).toEqual({ ok: false, error: { code: "invalid_body" } });
      const partMismatch = await host.request(
        {
          binding: "MEDIA",
          op: "uploadPart",
          key: "declared-frame-part",
          uploadId,
          partNumber: 1,
          contentLength,
          bodyFormat: SELFHOST_DATA_PLANE_OBJECT_BODY_FORMAT,
        },
        helloFrame(),
      );
      expect(await partMismatch.json()).toEqual({ ok: false, error: { code: "invalid_body" } });
      const prior = await host.request({ binding: "MEDIA", op: "get", key: "declared-frame" });
      expect(await prior.text()).toBe("hello");
    }
    const completed = await host.request({
      binding: "MEDIA",
      op: "completeMultipartUpload",
      key: "declared-frame-part",
      uploadId,
      parts: [{ etag: partEnvelope.value.etag, partNumber: 1 }],
    });
    expect(await completed.json()).toMatchObject({ ok: true, value: { size: 5 } });
    const partBody = await host.request({
      binding: "MEDIA",
      op: "get",
      key: "declared-frame-part",
    });
    expect(await partBody.text()).toBe("hello");
  } finally {
    host.close();
  }
});

/** Import the shipped facade, then bridge its private service to the signed broker. */
async function generatedObjectTenant(host: Awaited<ReturnType<typeof fixture>>, body: string) {
  const directory = mkdtempSync(join(host.root, "generated-tenant-"));
  const main = "tenant.mjs";
  await Bun.write(
    join(directory, main),
    `function chunks(values) {
      let index = 0;
      return new ReadableStream({
        pull(controller) {
          if (index === values.length) controller.close();
          else controller.enqueue(new Uint8Array(values[index++]));
        }
      }, { highWaterMark: 0 });
    }
    async function failure(operation) {
      try { await operation(); return null; }
      catch (error) { return { name: error.name, message: error.message }; }
    }
    export default { async fetch(request, env) { ${body} } };`,
  );
  await Bun.write(
    join(directory, selfhostWorkerPreludeModuleName(main)),
    selfhostWorkerPreludeSource(),
  );
  const wrapper = join(directory, "wrapper.mjs");
  await Bun.write(
    wrapper,
    selfhostWorkerEntrypointSource(
      {
        originalMainModule: main,
        publication: "object-stream-test",
        probeHostname: "stream-test.selfhost-internal.invalid",
        declaredHandlers: ["fetch"],
        bindings: [
          {
            kind: SELFHOST_WORKER_EDGE_OBJECTS_BINDING_KIND,
            publicName: "MEDIA",
            internalName: WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING,
          },
        ],
      },
      true,
    ),
  );
  const { default: worker } = (await import(pathToFileURL(wrapper).href)) as {
    default: {
      fetch(request: Request, env: Record<string, unknown>, context: object): Promise<Response>;
    };
  };
  const wire: {
    document: Record<string, unknown>;
    contentLength: string | null;
    result?: Record<string, unknown>;
  }[] = [];
  return {
    wire,
    async fetch() {
      return await worker.fetch(
        new Request("https://tenant.example/stream"),
        {
          [WORKERD_V2_PRIVATE_OBJECT_BUCKET_BINDING]: {
            async fetch(url: string, init: RequestInit) {
              if (
                url !==
                `${SELFHOST_V2_OBJECT_BUCKET_BINDING_ORIGIN}${SELFHOST_V2_OBJECT_BUCKET_BINDING_PATH}`
              ) {
                throw new Error("generated facade addressed the wrong private service route");
              }
              const headers = new Headers(init.headers);
              const document = headers.get(SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER);
              if (!document) throw new Error("generated facade omitted operation metadata");
              const call: (typeof wire)[number] = {
                document: JSON.parse(Buffer.from(document, "base64url").toString("utf8")),
                contentLength: headers.get("content-length"),
              };
              wire.push(call);
              headers.set("authorization", `Bearer ${host.token}`);
              const response = await host.broker.handle(
                new Request(`${ORIGIN}${SELFHOST_DATA_PLANE_OBJECTS_PATH}`, {
                  ...init,
                  headers,
                  ...(init.body instanceof ReadableStream ? { duplex: "half" as const } : {}),
                }),
              );
              if (!response) throw new Error("signed broker did not claim the object route");
              if (!response.headers.has(SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER)) {
                call.result = (await response.clone().json()) as Record<string, unknown>;
              }
              return response;
            },
          },
        },
        { waitUntil() {} },
      );
    },
  };
}

test("generated tenant accepts omitted-length streams and hides private part size receipts", async () => {
  const host = await fixture();
  try {
    const tenant = await generatedObjectTenant(
      host,
      `const put = await env.MEDIA.put("hello", chunks([[], [104, 101], [], [108, 108, 111]]));
       const empty = await env.MEDIA.put("empty", chunks([[], []]));
       const zeroUpload = await env.MEDIA.createMultipartUpload("zero-part");
       const zeroPart = await env.MEDIA.uploadPart("zero-part", zeroUpload.uploadId, 1, chunks([[], []]));
       const zeroDone = await env.MEDIA.completeMultipartUpload("zero-part", zeroUpload.uploadId, [zeroPart]);
       const upload = await env.MEDIA.createMultipartUpload("small-part");
       const part = await env.MEDIA.uploadPart("small-part", upload.uploadId, 1, chunks([[], [104, 101], [108, 108, 111]]));
       const done = await env.MEDIA.completeMultipartUpload("small-part", upload.uploadId, [part]);
       const found = await env.MEDIA.get("small-part");
       return Response.json({ put, empty, zeroPart, zeroDone, part, done, text: await new Response(found.body).text() });`,
    );
    const response = await tenant.fetch();
    expect(response.status).toBe(200);
    const helloEtag = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    const emptyEtag = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    expect(await response.json()).toEqual({
      put: { etag: helloEtag, size: 5 },
      empty: { etag: emptyEtag, size: 0 },
      zeroPart: { etag: emptyEtag, partNumber: 1 },
      zeroDone: { etag: expect.stringMatching(/^[0-9a-f]{64}-1$/u), size: 0 },
      part: { etag: helloEtag, partNumber: 1 },
      done: { etag: expect.stringMatching(/^[0-9a-f]{64}-1$/u), size: 5 },
      text: "hello",
    });
    const writes = tenant.wire.filter(({ document }) =>
      ["put", "uploadPart"].includes(String(document.op)),
    );
    expect(writes).toHaveLength(4);
    for (const write of writes) {
      expect(write.document).not.toHaveProperty("contentLength");
      expect(write.contentLength).toBeNull();
    }
    expect(
      writes.filter(({ document }) => document.op === "uploadPart").map(({ result }) => result),
    ).toEqual([
      { ok: true, value: { etag: emptyEtag, partNumber: 1, size: 0 } },
      { ok: true, value: { etag: helloEtag, partNumber: 1, size: 5 } },
    ]);
  } finally {
    host.close();
  }
});

test("generated tenant retains declared-length validation while unknown length is accepted", async () => {
  const host = await fixture();
  try {
    const tenant = await generatedObjectTenant(
      host,
      `await env.MEDIA.put("existing", "stable");
       const exact = await env.MEDIA.put("exact", chunks([[], [65], [66], []]), { contentLength: 2 });
       const upload = await env.MEDIA.createMultipartUpload("declared-part");
       const errors = [];
       errors.push(await failure(() => env.MEDIA.put("existing", chunks([[65]]), { contentLength: 2 })));
       errors.push(await failure(() => env.MEDIA.put("existing", chunks([[65], [66]]), { contentLength: 1 })));
       errors.push(await failure(() => env.MEDIA.uploadPart("declared-part", upload.uploadId, 1, chunks([[65]]), { contentLength: 2 })));
       errors.push(await failure(() => env.MEDIA.uploadPart("declared-part", upload.uploadId, 1, chunks([[65], [66]]), { contentLength: 1 })));
       const undefinedPut = await failure(() => env.MEDIA.put("undefined-put", chunks([]), { contentLength: undefined }));
       const undefinedPart = await failure(() => env.MEDIA.uploadPart("declared-part", upload.uploadId, 1, chunks([]), { contentLength: undefined }));
       const previous = await env.MEDIA.get("existing");
       return Response.json({ exact, errors, undefinedPut, undefinedPart, previous: await new Response(previous.body).text() });`,
    );
    const response = await tenant.fetch();
    expect(response.status).toBe(200);
    const result = (await response.json()) as Record<string, unknown>;
    expect(result.exact).toEqual({
      etag: "38164fbd17603d73f696b8b4d72664d735bb6a7c88577687fd2ae33fd6964153",
      size: 2,
    });
    expect(result.errors).toEqual(
      Array.from({ length: 4 }, () => ({ name: "invalid_body", message: "invalid_body" })),
    );
    expect(result.undefinedPut).toEqual({
      name: "TypeError",
      message: "invalid module-worker.object-bucket arguments",
    });
    expect(result.undefinedPart).toEqual(result.undefinedPut);
    expect(result.previous).toBe("stable");
    expect(
      await (await host.request({ binding: "MEDIA", op: "head", key: "undefined-put" })).json(),
    ).toEqual({ ok: true, value: { found: false } });
  } finally {
    host.close();
  }
});

test("generated tenant failures preserve previous objects and part receipts across store reopen", async () => {
  const host = await fixture();
  try {
    const tenant = await generatedObjectTenant(
      host,
      `function broken(kind) {
         let sent = false;
         return new ReadableStream({ pull(controller) {
           if (!sent) { sent = true; controller.enqueue(new Uint8Array([1, 2, 3])); }
           else if (kind === "producer") controller.error(new Error("private producer detail"));
           else controller.enqueue("non-byte chunk");
         } }, { highWaterMark: 0 });
       }
       await env.MEDIA.put("previous", "stable");
       const upload = await env.MEDIA.createMultipartUpload("part-recovery");
       const originalPart = await env.MEDIA.uploadPart("part-recovery", upload.uploadId, 1, chunks([[111, 114, 105, 103, 105, 110, 97, 108]]));
       const errors = [];
       for (const kind of ["producer", "non-byte"]) {
         errors.push(await failure(() => env.MEDIA.put("previous", broken(kind))));
         errors.push(await failure(() => env.MEDIA.put("new-failed", broken(kind))));
         errors.push(await failure(() => env.MEDIA.uploadPart("part-recovery", upload.uploadId, 1, broken(kind))));
       }
       return Response.json({ uploadId: upload.uploadId, originalPart, errors });`,
    );
    const response = await tenant.fetch();
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      uploadId: string;
      originalPart: { etag: string; partNumber: number };
      errors: { name: string; message: string }[];
    };
    expect(Object.keys(result.originalPart).sort()).toEqual(["etag", "partNumber"]);
    expect(result.errors).toEqual([
      ...Array.from({ length: 3 }, () => ({
        name: "backend_unavailable",
        message: "backend_unavailable",
      })),
      ...Array.from({ length: 3 }, () => ({ name: "invalid_body", message: "invalid_body" })),
    ]);
    host.reopen();
    const previous = await host.request({ binding: "MEDIA", op: "get", key: "previous" });
    expect(await previous.text()).toBe("stable");
    expect(
      await (await host.request({ binding: "MEDIA", op: "head", key: "new-failed" })).json(),
    ).toEqual({ ok: true, value: { found: false } });
    const recovered = await generatedObjectTenant(
      host,
      `const done = await env.MEDIA.completeMultipartUpload("part-recovery", ${JSON.stringify(result.uploadId)}, [${JSON.stringify(result.originalPart)}]);
       const found = await env.MEDIA.get("part-recovery");
       return Response.json({ done, text: await new Response(found.body).text() });`,
    );
    const recoveredResponse = await recovered.fetch();
    expect(recoveredResponse.status).toBe(200);
    expect(await recoveredResponse.json()).toEqual({
      done: { etag: expect.stringMatching(/^[0-9a-f]{64}-1$/u), size: 8 },
      text: "original",
    });
  } finally {
    host.close();
  }
});

test("generated tenant completes unequal unknown-length D05 parts using actual broker receipt sizes", async () => {
  const host = await fixture();
  try {
    const tenant = await generatedObjectTenant(
      host,
      `function repeated(length, value) {
         return new ReadableStream({ pull(controller) {
           if (length === 0) { controller.close(); return; }
           const size = Math.min(length, 65536);
           length -= size;
           controller.enqueue(new Uint8Array(size).fill(value));
         } }, { highWaterMark: 0 });
       }
       const upload = await env.MEDIA.createMultipartUpload("unequal");
       const parts = [];
       parts.push(await env.MEDIA.uploadPart("unequal", upload.uploadId, 1, repeated(5242880, 65)));
       parts.push(await env.MEDIA.uploadPart("unequal", upload.uploadId, 2, repeated(6291456, 66)));
       parts.push(await env.MEDIA.uploadPart("unequal", upload.uploadId, 3, repeated(7, 67)));
       const done = await env.MEDIA.completeMultipartUpload("unequal", upload.uploadId, parts);
       return Response.json({ parts, done });`,
    );
    const response = await tenant.fetch();
    expect(response.status).toBe(200);
    const result = (await response.json()) as {
      parts: { etag: string; partNumber: number }[];
      done: { etag: string; size: number };
    };
    expect(result.done.size).toBe(11_534_343);
    expect(result.done.etag).toMatch(/^[0-9a-f]{64}-3$/u);
    expect(result.parts.map((part) => Object.keys(part).sort())).toEqual([
      ["etag", "partNumber"],
      ["etag", "partNumber"],
      ["etag", "partNumber"],
    ]);
    const partCalls = tenant.wire.filter(({ document }) => document.op === "uploadPart");
    expect(partCalls.map(({ result: wireResult }) => wireResult?.value)).toEqual(
      result.parts.map((part, index) => ({ ...part, size: [5_242_880, 6_291_456, 7][index] })),
    );
    for (const call of partCalls) expect(call.document).not.toHaveProperty("contentLength");
    host.reopen();
    const found = await host.request({ binding: "MEDIA", op: "get", key: "unequal" });
    expect(decodeResult(found)).toMatchObject({ size: 11_534_343, etag: result.done.etag });
    if (!found.body) throw new Error("completed ObjectBucket body missing");
    const reader = found.body.getReader();
    const digest = createHash("sha256");
    let offset = 0;
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      digest.update(next.value);
      let local = 0;
      while (local < next.value.byteLength) {
        const value = offset < 5_242_880 ? 65 : offset < 11_534_336 ? 66 : 67;
        const boundary =
          offset < 5_242_880 ? 5_242_880 : offset < 11_534_336 ? 11_534_336 : 11_534_343;
        const count = Math.min(boundary - offset, next.value.byteLength - local);
        expect(count).toBeGreaterThan(0);
        expect(next.value.subarray(local, local + count).every((byte) => byte === value)).toBe(
          true,
        );
        local += count;
        offset += count;
      }
    }
    reader.releaseLock();
    expect(offset).toBe(11_534_343);
    expect(digest.digest("hex")).toBe(
      "d12db80c0453ccff81ca75631ce9c67a437e4f8e088b79e65072f88f654e2ea5",
    );
  } finally {
    host.close();
  }
}, 30_000);

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

async function proveCoreBucketBinding(backendId: string | undefined) {
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
          return {
            kind: "complete",
            observed: { ready: true, bundleVerified: true, resolvedBindings: true },
            output: {},
          };
        },
        async reconcile() {
          return {
            kind: "complete",
            observed: { ready: true, bundleVerified: true, resolvedBindings: true },
            output: {},
          };
        },
      },
    };
    const bucketForm = createObjectBucketForm({
      store,
      targetKey: TARGET,
      ...(backendId === undefined ? {} : { backendId }),
    });
    expect(bucketForm.backend.id).toBe(backendId ?? OBJECT_BUCKET_BACKEND_ID);
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
    const authority = createObjectBucketWorkerBindingAuthority({
      sql,
      targetKey: TARGET,
      ...(backendId === undefined ? {} : { backendId }),
    });
    const first = await authority.resolveCurrentBucketBinding(grant, "MEDIA");
    expect(first).toMatchObject({
      identity: {
        targetKey: TARGET,
        principal: "alice",
        space: "default",
        resourceUid: bucket.resourceUid,
      },
    });
    const wrongAuthority = createObjectBucketWorkerBindingAuthority({
      sql,
      targetKey: TARGET,
      ...(backendId === ALTERNATE_BACKEND_ID ? {} : { backendId: ALTERNATE_BACKEND_ID }),
    });
    expect(await wrongAuthority.resolveCurrentBucketBinding(grant, "MEDIA")).toBeNull();
    expect(() =>
      createObjectBucketWorkerBindingAuthority({ sql, targetKey: TARGET, backendId: "" }),
    ).toThrow(TypeError);
    expect(
      await authority.resolveCurrentBucketBinding(
        { ...grant, principal: "foreign-owner" },
        "MEDIA",
      ),
    ).toBeNull();
    expect(
      await authority.resolveCurrentBucketBinding({ ...grant, space: "foreign-space" }, "MEDIA"),
    ).toBeNull();
    // Readiness is a complete observation, not a boolean supplied by this fixture.
    // Missing Binding or Bundle proof must not authorize a native call.
    for (const observed of [
      { ready: true },
      { ready: true, bundleVerified: true, resolvedBindings: false },
      { ready: true, bundleVerified: false, resolvedBindings: true },
    ]) {
      await sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
        canonicalJson(observed),
        version.resourceUid,
      ]);
      expect(await authority.resolveCurrentBucketBinding(grant, "MEDIA")).toBeNull();
    }
    await sql.run("UPDATE tf_v2_resources SET observed_json = ? WHERE uid = ?", [
      canonicalJson({ ready: true, bundleVerified: true, resolvedBindings: true }),
      version.resourceUid,
    ]);
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
}

test("Core reader keeps the filesystem default and survives immutable Version PUT", async () => {
  await proveCoreBucketBinding(undefined);
});

test("Core reader accepts one selected alternate backend and refuses the default", async () => {
  await proveCoreBucketBinding(ALTERNATE_BACKEND_ID);
});
