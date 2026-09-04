import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Miniflare, type MiniflareOptions } from "miniflare";
import { managedObjectReceiptRuntimeProof } from "../src/providers/cloudflare-managed-object-receipt.ts";
import {
  MANAGED_WORKER_EDGE_OBJECTS_BINDING_KIND,
  MANAGED_WORKER_EDGE_SQL_BINDING_KIND,
  MANAGED_WORKER_READINESS_PATH,
  MANAGED_WORKER_READINESS_PROPS_SCHEMA,
  MANAGED_WORKER_READINESS_RESULT_SCHEMA,
  type ManagedWorkerEntrypointSourceInput,
  managedWorkerEntrypointSource,
} from "../src/providers/cloudflare-managed-worker-wrapper.ts";

const EMPTY_WORKER: ManagedWorkerEntrypointSourceInput = {
  originalMainModule: "index.js",
  declaredHandlers: ["fetch"],
  bindings: [],
};

const EVENT_PATH = "/.well-known/takoserver/managed-worker-events/v1";
const EVENT_PROTOCOL = "takoserver.managed-worker-event@v1";
const EVENT_CONTENT_TYPE = "application/vnd.takoserver.managed-worker-event.v1+json";
const GATEWAY_PROP = "takoserverManagedWorkerGateway";
const GATEWAY_PROPS_SCHEMA = "takoserver.managed-worker-gateway-props@v1";
const OBJECT_RECEIPT_AUTHORITY = {
  schema: "takoserver.managed-object-receipt-authority@v1",
  providerId: "cloudflare.wfp.integration",
  resourceUid: "bucket-media-uid",
  incarnationId: "deployment-bucket-media",
  generation: "1",
} as const;
const OBJECT_RECEIPT_NATIVE_NAME = "__TAKOSERVER_OBJECT_RECEIPTS_0";
const OBJECT_RECEIPT_INSTANCE_NAME = `tsobj-${"A".repeat(43)}`;
const OBJECT_RECEIPT_PROOF_SECRET = "managed-object-receipt-test-secret";
const OBJECT_RECEIPT_RUNTIME_PROOF = await managedObjectReceiptRuntimeProof({
  secret: OBJECT_RECEIPT_PROOF_SECRET,
  authority: OBJECT_RECEIPT_AUTHORITY,
  bucketName: "managed-bucket",
});

function edgeObjectsDescriptor() {
  return {
    kind: MANAGED_WORKER_EDGE_OBJECTS_BINDING_KIND,
    publicName: "MEDIA",
    nativeName: "__TAKOSERVER_OBJECTS_0",
    receiptNativeName: OBJECT_RECEIPT_NATIVE_NAME,
    receiptInstanceName: OBJECT_RECEIPT_INSTANCE_NAME,
    bucketName: "managed-bucket",
    runtimeProof: OBJECT_RECEIPT_RUNTIME_PROOF,
    authority: OBJECT_RECEIPT_AUTHORITY,
  } as const;
}

async function bundledObjectReceiptWorker(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-object-receipt-wrapper-test-"));
  try {
    const objectModule = resolve(
      import.meta.dir,
      "../src/providers/cloudflare-managed-object-receipt-object.ts",
    );
    const entry = join(root, "worker.ts");
    await Bun.write(
      entry,
      `export { TakoserverManagedObjectReceipt } from ${JSON.stringify(objectModule)};
export default { fetch() { return new Response(null, { status: 404 }); } };`,
    );
    const built = await Bun.build({
      entrypoints: [entry],
      target: "browser",
      format: "esm",
      external: ["cloudflare:workers"],
    });
    if (!built.success) throw new AggregateError(built.logs, "receipt worker bundle failed");
    const output = built.outputs[0];
    if (!output) throw new Error("receipt worker bundle produced no module");
    return await output.text();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function loadGeneratedWorker(
  customerSource: string,
  input: ManagedWorkerEntrypointSourceInput = EMPTY_WORKER,
): Promise<{
  readonly worker: {
    fetch(request: Request, env: Record<string, unknown>, context: object): Promise<Response>;
  };
  dispose(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "takoserver-managed-wrapper-"));
  const customerPath = join(root, input.originalMainModule);
  await mkdir(dirname(customerPath), { recursive: true });
  await Bun.write(customerPath, customerSource);
  const wrapperPath = join(root, "wrapper.mjs");
  await Bun.write(wrapperPath, managedWorkerEntrypointSource(input));
  const loaded = (await import(
    `${pathToFileURL(wrapperPath).href}?test=${crypto.randomUUID()}`
  )) as {
    readonly default: {
      fetch(request: Request, env: Record<string, unknown>, context: object): Promise<Response>;
    };
  };
  return {
    worker: loaded.default,
    async dispose() {
      await rm(root, { recursive: true, force: true });
    },
  };
}

function publicRequest(path = "/"): Request {
  return new Request(`https://worker.example${path}`);
}

function gatewayContext(entrypoint: "queue" | "scheduled", waits: Promise<unknown>[] = []) {
  return {
    props: {
      [GATEWAY_PROP]: {
        schema: GATEWAY_PROPS_SCHEMA,
        gatewayId: "gateway-test",
        environment: "integration",
        logicalWorkerId: "worker-1",
        deploymentId: "deployment-1",
        entrypoint,
      },
    },
    waitUntil(value: Promise<unknown>) {
      waits.push(value);
    },
    passThroughOnException() {
      throw new Error("must not be projected");
    },
  };
}

function xml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function eventRequest(event: object): Request {
  return new Request(`https://worker.example${EVENT_PATH}`, {
    method: "POST",
    headers: {
      "content-type": EVENT_CONTENT_TYPE,
      "x-takoserver-managed-worker-event": EVENT_PROTOCOL,
    },
    body: JSON.stringify(event),
  });
}

test("managed Worker wrapper normalizes an artifact module name to a relative specifier", () => {
  const source = managedWorkerEntrypointSource(EMPTY_WORKER);
  expect(source).toContain('import("./index.js")');
  expect(source).not.toContain('import("index.js")');
});

test("managed Worker wrapper runs a real workerd multipart module graph", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "wrapper-graph-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "wrapper.js",
            modules: {
              "wrapper.js": {
                type: "esm",
                contents: managedWorkerEntrypointSource({
                  ...EMPTY_WORKER,
                  bindings: [{ name: "GREETING", type: "plain_text" }],
                }),
              },
              "index.js": {
                type: "esm",
                contents:
                  'import { suffix } from "./lib/value.js"; import note from "./note.txt"; Reflect.apply = () => { throw new Error("poisoned apply"); }; Object.keys = () => ["poisoned"]; Object.hasOwn = () => false; Object.freeze = () => { throw new Error("poisoned freeze"); }; Object.prototype.kind = "edge.sql@1.0.0"; Object.prototype.publicName = "LEAK"; Object.prototype.nativeName = "__TAKOSERVER_LEAK"; Object.prototype.instanceName = "leak"; export default { fetch(_request, env) { return new Response(env.GREETING + suffix + note); } };',
              },
              "lib/value.js": {
                type: "esm",
                contents: 'export const suffix = " from sibling";',
              },
              "note.txt": { type: "text", contents: " and text module" },
            },
          },
          env: { GREETING: { type: "text", value: "hello" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const response = await runtime.dispatchFetch("https://worker.example/");
    expect(await response.text()).toBe("hello from sibling and text module");
  } finally {
    await runtime.dispose();
  }
});

test("managed edge.objects projection runs all nine operations against real workerd R2", async () => {
  const receiptWorker = await bundledObjectReceiptWorker();
  const openUploads = new Map<string, { readonly key: string; readonly uploadId: string }>();
  const s3Transport = async (request: Request, miniflare: Miniflare): Promise<Response> => {
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.split("/").slice(2).join("/"));
    const bucket = await miniflare.getR2Bucket(
      "__TAKOSERVER_OBJECTS_0",
      "wrapper-edge-objects-test",
    );
    if (request.method === "GET" && url.searchParams.has("uploads")) {
      const prefix = url.searchParams.get("prefix");
      const uploads = [...openUploads.values()].filter(
        (candidate) => prefix === null || candidate.key === prefix,
      );
      return new Response(
        `<?xml version="1.0"?><ListMultipartUploadsResult><IsTruncated>false</IsTruncated>${uploads
          .map(
            (upload) =>
              `<Upload><Key>${xml(upload.key)}</Key><UploadId>${xml(upload.uploadId)}</UploadId></Upload>`,
          )
          .join("")}</ListMultipartUploadsResult>`,
      );
    }
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const contentType = request.headers.get("content-type");
      const marker = request.headers.get("x-amz-meta-takoserver-multipart-receipt-v1");
      const upload = await bucket.createMultipartUpload(key, {
        ...(contentType ? { httpMetadata: { contentType } } : {}),
        ...(marker ? { customMetadata: { "takoserver-multipart-receipt-v1": marker } } : {}),
      });
      openUploads.set(upload.uploadId, { key, uploadId: upload.uploadId });
      return new Response(
        `<?xml version="1.0"?><InitiateMultipartUploadResult><Bucket>managed-bucket</Bucket><Key>${xml(key)}</Key><UploadId>${xml(upload.uploadId)}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (request.method === "DELETE") {
      const uploadId = url.searchParams.get("uploadId");
      const upload = uploadId ? openUploads.get(uploadId) : undefined;
      if (!upload || upload.key !== key) return new Response(null, { status: 404 });
      await bucket.resumeMultipartUpload(key, uploadId as string).abort();
      openUploads.delete(uploadId as string);
      return new Response(null, { status: 204 });
    }
    if (request.method === "HEAD") return new Response(null, { status: 200 });
    return new Response(null, { status: 405 });
  };
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "managed-object-receipt-gateway-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: receiptWorker } },
          },
          exports: {
            TakoserverManagedObjectReceipt: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            MANAGED_PROVIDER_ID: { type: "text", value: OBJECT_RECEIPT_AUTHORITY.providerId },
            TAKOSERVER_MANAGED_OBJECT_ACCOUNT_ID: { type: "text", value: "test-account" },
            TAKOSERVER_MANAGED_OBJECT_ACCESS_KEY_ID: {
              type: "text",
              value: "test-access-key",
            },
            TAKOSERVER_MANAGED_OBJECT_SECRET_ACCESS_KEY: {
              type: "text",
              value: "test-secret-key",
            },
            TAKOSERVER_MANAGED_OBJECT_PROOF_SECRET: {
              type: "text",
              value: OBJECT_RECEIPT_PROOF_SECRET,
            },
            TAKOSERVER_MANAGED_OBJECT_S3_TRANSPORT: {
              type: "fetcher",
              handler: s3Transport,
            },
          },
          triggers: [],
        },
      },
      {
        config: {
          name: "wrapper-edge-objects-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "wrapper.js",
            modules: {
              "wrapper.js": {
                type: "esm",
                contents: managedWorkerEntrypointSource({
                  ...EMPTY_WORKER,
                  bindings: [edgeObjectsDescriptor()],
                }),
              },
              "index.js": {
                type: "esm",
                contents: `export default { async fetch(_request, env) { let step = "methods"; try {
  const methods = Reflect.ownKeys(env.MEDIA).sort();
  step = "put";
  const put = await env.MEDIA.put("workerd.txt", "workerd-r2", { contentLength: 10, contentType: "text/plain", ifNoneMatch: "*" });
  step = "stream-put";
  const streamPut = await env.MEDIA.put("stream.txt", new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("stream")); controller.close(); } }), { contentLength: 6 });
  let missingLengthError;
  try { await env.MEDIA.put("missing-length.txt", new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } })); }
  catch (error) { missingLengthError = error.name; }
  let intrinsicMismatchError;
  try { await env.MEDIA.put("intrinsic-mismatch.txt", "body", { contentLength: 5 }); }
  catch (error) { intrinsicMismatchError = error.name; }
  step = "head";
  const head = await env.MEDIA.head("workerd.txt");
  step = "get";
  const get = await env.MEDIA.get("workerd.txt", { range: { offset: 3, length: 4 } });
  const getHasBodyStream = Reflect.ownKeys(get).includes("bodyStream");
  const getHasUploadedAtMillis = Reflect.ownKeys(get).includes("uploadedAtMillis");
  let invalidBodyTypeError = false;
  try { await env.MEDIA.put("invalid-body.txt", { bytes: "body" }); }
  catch (error) { invalidBodyTypeError = error instanceof TypeError; }
  let unknownOptionTypeError = false;
  try { await env.MEDIA.put("unknown-option.txt", "body", { unknown: true }); }
  catch (error) { unknownOptionTypeError = error instanceof TypeError; }
  let nestedOptionTypeError = false;
  try { await env.MEDIA.get("workerd.txt", { range: { offset: 0, unknown: true } }); }
  catch (error) { nestedOptionTypeError = error instanceof TypeError; }
  let memberTypeError = false;
  try { await env.MEDIA.put("bad-member-type.txt", "body", { contentType: 42 }); }
  catch (error) { memberTypeError = error instanceof TypeError; }
  let extraArgumentTypeError = false;
  try { await env.MEDIA.put("extra-argument.txt", "body", {}, "extra"); }
  catch (error) { extraArgumentTypeError = error instanceof TypeError; }
  const typeError = async (promise) => { try { await promise; return false; } catch (error) { return error instanceof TypeError; } };
  const invalidKeyTypeError = await typeError(env.MEDIA.head(42));
  const invalidRangeTypeError = await typeError(env.MEDIA.get("workerd.txt", { range: { offset: "0" } }));
  const invalidDelimiterTypeError = await typeError(env.MEDIA.list({ delimiter: 42 }));
  const invalidLimitTypeError = await typeError(env.MEDIA.list({ limit: "10" }));
  const invalidLengthTypeError = await typeError(env.MEDIA.put("bad-length-type.txt", "body", { contentLength: "4" }));
  const undefinedLengthTypeError = await typeError(env.MEDIA.put("undefined-length.txt", "body", { contentLength: undefined }));
  const undefinedStreamLengthTypeError = await typeError(env.MEDIA.put("undefined-stream-length.txt", new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }), { contentLength: undefined }));
  const undefinedPartLengthTypeError = await typeError(env.MEDIA.uploadPart("part.txt", "upload", 1, "body", { contentLength: undefined }));
  const invalidNumericLengthErrors = await Promise.all([NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER, 5368709121].map(async (contentLength) => {
    try { await env.MEDIA.put("bad-numeric-length.txt", new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } }), { contentLength }); }
    catch (error) { return error.name; }
  }));
  const invalidUploadIdTypeError = await typeError(env.MEDIA.uploadPart("part.txt", 42, 1, "body"));
  const invalidPartNumberTypeError = await typeError(env.MEDIA.uploadPart("part.txt", "upload", "1", "body"));
  const invalidPartsTypeError = await typeError(env.MEDIA.completeMultipartUpload("part.txt", "upload", { partNumber: 1 }));
  const invalidPartMemberTypeError = await typeError(env.MEDIA.completeMultipartUpload("part.txt", "upload", [{ partNumber: "1", etag: "etag" }]));
  const invalidPartEtagTypeError = await typeError(env.MEDIA.completeMultipartUpload("part.txt", "upload", [{ partNumber: 1, etag: 42 }]));
  const invalidPartMemberError = await typeError(env.MEDIA.completeMultipartUpload("part.txt", "upload", [{ partNumber: 1, etag: "etag", extra: true }]));
  const multibyteKeyError = await (async () => { try { await env.MEDIA.head("界".repeat(327)); } catch (error) { return error.name; } })();
  const multibytePrefixTypeError = await typeError(env.MEDIA.list({ prefix: "界".repeat(327) }));
  const delimiterBoundTypeError = await typeError(env.MEDIA.list({ delimiter: "d".repeat(17) }));
  const lowLimitBoundTypeError = await typeError(env.MEDIA.list({ limit: 0 }));
  const highLimitBoundTypeError = await typeError(env.MEDIA.list({ limit: 1001 }));
  const cursorBoundTypeError = await typeError(env.MEDIA.list({ cursor: "c".repeat(4097) }));
  const contentTypeBoundTypeError = await typeError(env.MEDIA.put("content-type-bound.txt", "body", { contentType: "x".repeat(257) }));
  const multipartContentTypeBoundTypeError = await typeError(env.MEDIA.createMultipartUpload("multipart-content-type-bound.txt", { contentType: "x".repeat(257) }));
  const rangeBoundTypeError = await typeError(env.MEDIA.get("workerd.txt", { range: { offset: -1 } }));
  const etagBoundTypeError = await typeError(env.MEDIA.get("workerd.txt", { ifMatch: "e".repeat(257) }));
  const unicodeDelimiterTypeError = await typeError(env.MEDIA.list({ delimiter: "😀".repeat(16) }));
  const unicodeDelimiterBoundTypeError = await typeError(env.MEDIA.list({ delimiter: "😀".repeat(17) }));
  const unicodeCursorTypeError = await typeError(env.MEDIA.list({ cursor: "😀".repeat(4096) }));
  const unicodeCursorBoundTypeError = await typeError(env.MEDIA.list({ cursor: "😀".repeat(4097) }));
  const unicodeContentTypeError = await typeError(env.MEDIA.put("unicode-content-type.txt", "body", { contentType: "😀".repeat(256) }));
  const unicodeContentTypeBoundTypeError = await typeError(env.MEDIA.put("unicode-content-type-bound.txt", "body", { contentType: "😀".repeat(257) }));
  const unicodeEtagTypeError = await typeError(env.MEDIA.get("workerd.txt", { ifMatch: "😀".repeat(256) }));
  const unicodeEtagBoundTypeError = await typeError(env.MEDIA.get("workerd.txt", { ifMatch: "😀".repeat(257) }));
  const unicodePartEtagTypeError = await typeError(env.MEDIA.completeMultipartUpload("part.txt", "upload", [{ partNumber: 1, etag: "😀".repeat(256) }]));
  const unicodePartEtagBoundTypeError = await typeError(env.MEDIA.completeMultipartUpload("part.txt", "upload", [{ partNumber: 1, etag: "😀".repeat(257) }]));
  let outOfOrderPartsError;
  try { await env.MEDIA.completeMultipartUpload("part.txt", "upload", [{ partNumber: 2, etag: "two" }, { partNumber: 1, etag: "one" }]); }
  catch (error) { outOfOrderPartsError = error.name; }
  let duplicatePartsError;
  try { await env.MEDIA.completeMultipartUpload("part.txt", "upload", [{ partNumber: 1, etag: "one" }, { partNumber: 1, etag: "one" }]); }
  catch (error) { duplicatePartsError = error.name; }
  step = "list";
  const listed = await env.MEDIA.list({ prefix: "workerd", limit: 10 });
  step = "create";
  const upload = await env.MEDIA.createMultipartUpload("multipart.txt", { contentType: "text/plain" });
  step = "part";
  const part = await env.MEDIA.uploadPart("multipart.txt", upload.uploadId, 1, new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode("multipart")); controller.close(); } }), { contentLength: 9 });
  step = "complete";
  const complete = await env.MEDIA.completeMultipartUpload("multipart.txt", upload.uploadId, [part]);
  await env.MEDIA.put("multipart-fence.txt", "original");
  const invalidUpload = await env.MEDIA.createMultipartUpload("multipart-fence.txt");
  const invalidFirst = await env.MEDIA.uploadPart("multipart-fence.txt", invalidUpload.uploadId, 1, "short");
  const invalidSecond = await env.MEDIA.uploadPart("multipart-fence.txt", invalidUpload.uploadId, 2, "tail");
  let undersizedNonFinalError;
  try { await env.MEDIA.completeMultipartUpload("multipart-fence.txt", invalidUpload.uploadId, [invalidFirst, invalidSecond]); }
  catch (error) { undersizedNonFinalError = error.name; }
  const staleUpload = await env.MEDIA.createMultipartUpload("multipart-stale.txt");
  const stalePart = await env.MEDIA.uploadPart("multipart-stale.txt", staleUpload.uploadId, 1, "short");
  let stalePartError;
  try { await env.MEDIA.completeMultipartUpload("multipart-stale.txt", staleUpload.uploadId, [{ ...stalePart, etag: stalePart.etag + "-stale" }]); }
  catch (error) { stalePartError = error.name; }
  const multipartFenceBody = await new Response((await env.MEDIA.get("multipart-fence.txt")).body).text();
  step = "abort";
  const abandoned = await env.MEDIA.createMultipartUpload("abandoned.txt");
  await env.MEDIA.abortMultipartUpload("abandoned.txt", abandoned.uploadId);
  await env.MEDIA.abortMultipartUpload("abandoned.txt", abandoned.uploadId);
  step = "delete";
  await env.MEDIA.delete("workerd.txt");
  const missing = await env.MEDIA.head("workerd.txt");
  return Response.json({ envKeys: Reflect.ownKeys(env), methods, uploadPartArity: env.MEDIA.uploadPart.length, put, streamPut, missingLengthError, intrinsicMismatchError, invalidBodyTypeError, unknownOptionTypeError, nestedOptionTypeError, memberTypeError, extraArgumentTypeError, invalidKeyTypeError, invalidRangeTypeError, invalidDelimiterTypeError, invalidLimitTypeError, invalidLengthTypeError, undefinedLengthTypeError, undefinedStreamLengthTypeError, undefinedPartLengthTypeError, invalidNumericLengthErrors, invalidUploadIdTypeError, invalidPartNumberTypeError, invalidPartsTypeError, invalidPartMemberTypeError, invalidPartEtagTypeError, invalidPartMemberError, multibyteKeyError, multibytePrefixTypeError, delimiterBoundTypeError, lowLimitBoundTypeError, highLimitBoundTypeError, cursorBoundTypeError, contentTypeBoundTypeError, multipartContentTypeBoundTypeError, rangeBoundTypeError, etagBoundTypeError, unicodeDelimiterTypeError, unicodeDelimiterBoundTypeError, unicodeCursorTypeError, unicodeCursorBoundTypeError, unicodeContentTypeError, unicodeContentTypeBoundTypeError, unicodeEtagTypeError, unicodeEtagBoundTypeError, unicodePartEtagTypeError, unicodePartEtagBoundTypeError, outOfOrderPartsError, duplicatePartsError, undersizedNonFinalError, stalePartError, multipartFenceBody, invalidBodyStored: await env.MEDIA.head("invalid-body.txt"), unknownOptionStored: await env.MEDIA.head("unknown-option.txt"), badMemberTypeStored: await env.MEDIA.head("bad-member-type.txt"), extraArgumentStored: await env.MEDIA.head("extra-argument.txt"), badLengthTypeStored: await env.MEDIA.head("bad-length-type.txt"), undefinedLengthStored: await env.MEDIA.head("undefined-length.txt"), undefinedStreamLengthStored: await env.MEDIA.head("undefined-stream-length.txt"), missingLengthStored: await env.MEDIA.head("missing-length.txt"), intrinsicMismatchStored: await env.MEDIA.head("intrinsic-mismatch.txt"), getHasBodyStream, getHasUploadedAtMillis, head, partial: get.partial, range: get.range, body: await new Response(get.body).text(), listed: listed.objects.map((item) => item.key), prefixes: listed.prefixes, complete, missing });
  } catch (error) { return Response.json({ failure: step, name: error.name, message: error.message }); }
} };`,
              },
            },
          },
          env: {
            __TAKOSERVER_OBJECTS_0: { type: "r2", name: "managed-edge-objects-test" },
            [OBJECT_RECEIPT_NATIVE_NAME]: {
              type: "durable-object",
              workerName: "managed-object-receipt-gateway-test",
              exportName: "TakoserverManagedObjectReceipt",
            },
          },
          triggers: [],
        },
      },
    ],
  });
  try {
    const response = await (await runtime.getWorker("wrapper-edge-objects-test")).fetch(
      "https://worker.example/",
    );
    const responseText = await response.text();
    expect({ status: response.status, responseText }).toMatchObject({ status: 200 });
    expect(JSON.parse(responseText)).toEqual({
      envKeys: ["MEDIA"],
      methods: [
        "abortMultipartUpload",
        "completeMultipartUpload",
        "createMultipartUpload",
        "delete",
        "get",
        "head",
        "list",
        "put",
        "uploadPart",
      ],
      uploadPartArity: 5,
      put: expect.objectContaining({ size: 10 }),
      streamPut: expect.objectContaining({ size: 6 }),
      missingLengthError: "invalid_body",
      intrinsicMismatchError: "invalid_body",
      invalidBodyTypeError: true,
      unknownOptionTypeError: true,
      nestedOptionTypeError: true,
      memberTypeError: true,
      extraArgumentTypeError: true,
      invalidKeyTypeError: true,
      invalidRangeTypeError: true,
      invalidDelimiterTypeError: true,
      invalidLimitTypeError: true,
      invalidLengthTypeError: true,
      undefinedLengthTypeError: true,
      undefinedStreamLengthTypeError: true,
      undefinedPartLengthTypeError: true,
      invalidNumericLengthErrors: Array(5).fill("invalid_body"),
      invalidUploadIdTypeError: true,
      invalidPartNumberTypeError: true,
      invalidPartsTypeError: true,
      invalidPartMemberTypeError: true,
      invalidPartEtagTypeError: true,
      invalidPartMemberError: true,
      multibyteKeyError: "invalid_key",
      multibytePrefixTypeError: true,
      delimiterBoundTypeError: true,
      lowLimitBoundTypeError: true,
      highLimitBoundTypeError: true,
      cursorBoundTypeError: true,
      contentTypeBoundTypeError: true,
      multipartContentTypeBoundTypeError: true,
      rangeBoundTypeError: true,
      etagBoundTypeError: true,
      unicodeDelimiterTypeError: false,
      unicodeDelimiterBoundTypeError: true,
      unicodeCursorTypeError: false,
      unicodeCursorBoundTypeError: true,
      unicodeContentTypeError: false,
      unicodeContentTypeBoundTypeError: true,
      unicodeEtagTypeError: false,
      unicodeEtagBoundTypeError: true,
      unicodePartEtagTypeError: false,
      unicodePartEtagBoundTypeError: true,
      outOfOrderPartsError: "invalid_part",
      duplicatePartsError: "invalid_part",
      undersizedNonFinalError: "invalid_part",
      stalePartError: "invalid_part",
      multipartFenceBody: "original",
      invalidBodyStored: null,
      unknownOptionStored: null,
      badMemberTypeStored: null,
      extraArgumentStored: null,
      badLengthTypeStored: null,
      undefinedLengthStored: null,
      undefinedStreamLengthStored: null,
      missingLengthStored: null,
      intrinsicMismatchStored: null,
      getHasBodyStream: false,
      getHasUploadedAtMillis: false,
      head: expect.objectContaining({ size: 10, contentType: "text/plain" }),
      partial: true,
      range: { offset: 3, length: 4 },
      body: "kerd",
      listed: ["workerd.txt"],
      prefixes: [],
      complete: expect.objectContaining({ size: 9 }),
      missing: null,
    });
  } finally {
    await runtime.dispose();
  }
}, 60_000);

test("managed edge.objects reconciles a lost R2 complete response without a second complete", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      const upload = await env.MEDIA.createMultipartUpload("lost-ack.bin");
      const part = { partNumber: 1, etag: "part-etag" };
      const first = await env.MEDIA.completeMultipartUpload("lost-ack.bin", upload.uploadId, [part]);
      const second = await env.MEDIA.completeMultipartUpload("lost-ack.bin", upload.uploadId, [part]);
      const head = await env.MEDIA.head("lost-ack.bin");
      return Response.json({ first, second, headKeys: Reflect.ownKeys(head).sort() });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  let state: "new" | "active" | "completing" | "completed" = "new";
  let marker = "";
  let nativeCompleteCalls = 0;
  const receipt = {
    async createMultipartUpload(input: { readonly marker: string }) {
      marker = input.marker;
      state = "active";
      completed.customMetadata = { "takoserver-multipart-receipt-v1": marker };
      return { ok: true, value: { state: "active" } };
    },
    async beginCreate(input: { readonly marker: string }) {
      marker = input.marker;
      state = "new";
      return { ok: true, value: { state: "creating" } };
    },
    async markCreateOutcomeUnknown() {
      return { ok: false, error: { code: "conflict" } };
    },
    async activateCreate() {
      state = "active";
      return { ok: true, value: { state: "active" } };
    },
    async beginPart(input: { readonly attemptId: string }) {
      return {
        ok: true,
        value: { nativeUploadId: "native-upload", attemptId: input.attemptId },
      };
    },
    async commitPart(input: { readonly etag: string; readonly partNumber: number }) {
      return { ok: true, value: { etag: input.etag, partNumber: input.partNumber } };
    },
    async releasePart() {
      return { ok: true, value: { state: "active" } };
    },
    async beginComplete() {
      if (state === "completed") {
        return { ok: true, value: { action: "done", etag: '"object-etag"', size: 4 } };
      }
      if (state === "completing") {
        return {
          ok: true,
          value: {
            action: "reconcile",
            nativeUploadId: "native-upload",
            marker,
            expectedSize: 4,
          },
        };
      }
      state = "completing";
      return {
        ok: true,
        value: {
          action: "execute",
          nativeUploadId: "native-upload",
          marker,
          expectedSize: 4,
        },
      };
    },
    async commitComplete(input: { readonly etag: string; readonly size: number }) {
      state = "completed";
      return { ok: true, value: { etag: input.etag, size: input.size } };
    },
    async failComplete() {
      state = "active";
      return { ok: true, value: { state: "active" } };
    },
    async markCompleteLost() {
      state = "completing";
      return { ok: true, value: { state: "reconciliation_required" } };
    },
    async beginAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
  };
  const completed = {
    httpEtag: '"object-etag"',
    size: 4,
    customMetadata: {} as Record<string, string>,
  };
  const raw = {
    async head() {
      return nativeCompleteCalls > 0 ? completed : null;
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      throw new Error("wrapper must not own native multipart create");
    },
    resumeMultipartUpload() {
      return {
        async uploadPart(_partNumber: number, body: ReadableStream<Uint8Array>) {
          await new Response(body).arrayBuffer();
          return { etag: "part-etag" };
        },
        async complete() {
          nativeCompleteCalls += 1;
          throw new Error("R2 response lost after the object became visible");
        },
        async abort() {},
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      first: { etag: '"object-etag"', size: 4 },
      second: { etag: '"object-etag"', size: 4 },
      headKeys: ["etag", "size"],
    });
    expect(nativeCompleteCalls).toBe(1);
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects leaves native create failure cleanup to its receipt authority", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      try { await env.MEDIA.createMultipartUpload("create-failed.bin"); }
      catch (error) { return Response.json({ error: error.name }); }
      return new Response("unexpected", { status: 500 });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  let receiptState = "new";
  let nativeAbortCalls = 0;
  const receipt = {
    async createMultipartUpload() {
      receiptState = "aborted";
      return { ok: false, error: { code: "backend_unavailable" } };
    },
    async beginCreate() {
      receiptState = "creating";
      return { ok: true, value: { state: "creating" } };
    },
    async markCreateOutcomeUnknown() {
      receiptState = "reconciliation_required";
      return { ok: true, value: { state: "reconciliation_required" } };
    },
    async activateCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async releasePart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async failComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCompleteLost() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginAbort(input: { readonly nativeUploadId?: string }) {
      if (input.nativeUploadId !== undefined) throw new Error("unexpected native id");
      receiptState = "aborted";
      return { ok: true, value: { action: "done" } };
    },
    async commitAbort() {
      receiptState = "aborted";
      return { ok: true, value: { state: "aborted" } };
    },
  };
  const raw = {
    async head() {
      return null;
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      const error = new Error("native create rejected the key");
      error.name = "invalid_key";
      throw error;
    },
    resumeMultipartUpload() {
      return {
        async uploadPart() {
          return { etag: "unused" };
        },
        async complete() {},
        async abort() {
          nativeAbortCalls += 1;
        },
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({ error: "backend_unavailable" });
    expect(receiptState).toBe("aborted");
    expect(nativeAbortCalls).toBe(0);
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects surfaces receipt-owned ambiguous create outcomes without native fallback", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      let transport;
      try { await env.MEDIA.createMultipartUpload("create-ambiguous.bin"); }
      catch (error) { transport = error.name; }
      let malformed;
      try { await env.MEDIA.createMultipartUpload("create-malformed.bin"); }
      catch (error) { malformed = error.name; }
      return Response.json({ transport, malformed });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  let receiptState = "new";
  let marked = 0;
  let nativeCreateCalls = 0;
  const receipt = {
    async createMultipartUpload() {
      marked += 1;
      receiptState = "operator_reconciliation_required";
      return { ok: false, error: { code: "backend_unavailable" } };
    },
    async beginCreate() {
      receiptState = "creating";
      return { ok: true, value: { state: "creating" } };
    },
    async markCreateOutcomeUnknown() {
      marked += 1;
      receiptState = "reconciliation_required";
      return { ok: true, value: { state: "reconciliation_required" } };
    },
    async activateCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async releasePart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async failComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCompleteLost() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
  };
  const raw = {
    async head() {
      return null;
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      nativeCreateCalls += 1;
      if (nativeCreateCalls === 1) throw new Error("transport acknowledgement lost after create");
      return {};
    },
    resumeMultipartUpload() {
      return {
        async uploadPart() {
          return { etag: "unused" };
        },
        async complete() {},
        async abort() {},
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({
      transport: "backend_unavailable",
      malformed: "backend_unavailable",
    });
    expect(receiptState).toBe("operator_reconciliation_required");
    expect(marked).toBe(2);
    expect(nativeCreateCalls).toBe(0);
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects never creates again for a stale creating receipt", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      try { await env.MEDIA.createMultipartUpload("stale-create.bin"); }
      catch (error) { return Response.json({ error: error.name }); }
      return new Response("unexpected", { status: 500 });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  let nativeCreateCalls = 0;
  const receipt = {
    async createMultipartUpload() {
      return { ok: false, error: { code: "backend_unavailable" } };
    },
    async beginCreate() {
      return { ok: true, value: { state: "reconciliation_required" } };
    },
    async markCreateOutcomeUnknown() {
      throw new Error("must not mark a fenced receipt twice");
    },
    async activateCreate() {
      throw new Error("must not activate stale create");
    },
    async beginPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async releasePart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async failComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCompleteLost() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
  };
  const raw = {
    async head() {
      return null;
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      nativeCreateCalls += 1;
      return { uploadId: "must-not-create" };
    },
    resumeMultipartUpload() {
      return {
        async uploadPart() {
          return { etag: "unused" };
        },
        async complete() {},
        async abort() {},
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({ error: "backend_unavailable" });
    expect(nativeCreateCalls).toBe(0);
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects does not second-guess receipt-owned activation recovery", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      try { await env.MEDIA.createMultipartUpload("activation-lost.bin"); }
      catch (error) { return Response.json({ error: error.name }); }
      return new Response("unexpected", { status: 500 });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  let receiptState = "new";
  let activationCalls = 0;
  let nativeAbortCalls = 0;
  const receipt = {
    async createMultipartUpload() {
      receiptState = "aborted";
      return { ok: false, error: { code: "backend_unavailable" } };
    },
    async beginCreate() {
      receiptState = "creating";
      return { ok: true, value: { state: "creating" } };
    },
    async markCreateOutcomeUnknown() {
      return { ok: false, error: { code: "conflict" } };
    },
    async activateCreate() {
      activationCalls += 1;
      throw new Error("activation acknowledgement lost");
    },
    async beginPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async releasePart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async failComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCompleteLost() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginAbort(input: { readonly nativeUploadId?: string }) {
      expect(input.nativeUploadId).toBe("native-activation-lost");
      receiptState = "aborting";
      return {
        ok: true,
        value: {
          action: "execute",
          nativeUploadId: "native-activation-lost",
          marker: "A".repeat(43),
        },
      };
    },
    async commitAbort() {
      receiptState = "aborted";
      return { ok: true, value: { state: "aborted" } };
    },
  };
  const raw = {
    async head() {
      return null;
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      return { uploadId: "native-activation-lost" };
    },
    resumeMultipartUpload() {
      return {
        async uploadPart() {
          return { etag: "unused" };
        },
        async complete() {},
        async abort() {
          nativeAbortCalls += 1;
        },
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({ error: "backend_unavailable" });
    expect(activationCalls).toBe(0);
    expect(receiptState).toBe("aborted");
    expect(nativeAbortCalls).toBe(0);
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects fences a definitive upload_not_found and keeps reconciliation pending", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      const part = { partNumber: 1, etag: "part-etag" };
      let first;
      try { await env.MEDIA.completeMultipartUpload("lost.bin", "receipt-lost", [part]); }
      catch (error) { first = error.name; }
      let second;
      try { await env.MEDIA.completeMultipartUpload("lost.bin", "receipt-lost", [part]); }
      catch (error) { second = error.name; }
      return Response.json({ first, second });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  let receiptState = "active";
  let markedLost = 0;
  const receipt = {
    async beginCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCreateOutcomeUnknown() {
      return { ok: false, error: { code: "conflict" } };
    },
    async activateCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async releasePart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginComplete() {
      if (receiptState === "completion_reconciling") {
        return {
          ok: true,
          value: {
            action: "reconcile",
            nativeUploadId: "native-lost",
            marker: "A".repeat(43),
            expectedSize: 4,
          },
        };
      }
      receiptState = "completing";
      return {
        ok: true,
        value: {
          action: "execute",
          nativeUploadId: "native-lost",
          marker: "A".repeat(43),
          expectedSize: 4,
        },
      };
    },
    async commitComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async failComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCompleteLost() {
      markedLost += 1;
      receiptState = "completion_reconciling";
      return { ok: true, value: { state: "completion_reconciling" } };
    },
    async beginAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
  };
  const raw = {
    async head() {
      return null;
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      return { uploadId: "unused" };
    },
    resumeMultipartUpload() {
      return {
        async uploadPart() {
          return { etag: "unused" };
        },
        async complete() {
          throw new Error("R2 multipart upload was not found (10024)");
        },
        async abort() {},
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({
      first: "upload_not_found",
      second: "backend_unavailable",
    });
    expect(markedLost).toBe(1);
    expect(receiptState).toBe("completion_reconciling");
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects fences upload_not_found when head is ambiguous without retrying complete", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      const parts = [{ partNumber: 1, etag: "part-etag" }];
      let first;
      try {
        await env.MEDIA.completeMultipartUpload("ambiguous.bin", "receipt-ambiguous", parts);
      } catch (error) {
        first = error.name;
      }
      let second;
      try {
        await env.MEDIA.completeMultipartUpload("ambiguous.bin", "receipt-ambiguous", parts);
      } catch (error) {
        second = error.name;
      }
      return Response.json({ first, second });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  let receiptState = "active";
  let markedLost = 0;
  let nativeCompleteCalls = 0;
  const receipt = {
    async beginCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCreateOutcomeUnknown() {
      return { ok: false, error: { code: "conflict" } };
    },
    async activateCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async releasePart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginComplete() {
      if (receiptState === "reconciliation_required") {
        return {
          ok: true,
          value: {
            action: "reconcile",
            nativeUploadId: "native-ambiguous",
            marker: "A".repeat(43),
            expectedSize: 4,
          },
        };
      }
      receiptState = "completing";
      return {
        ok: true,
        value: {
          action: "execute",
          nativeUploadId: "native-ambiguous",
          marker: "A".repeat(43),
          expectedSize: 4,
        },
      };
    },
    async commitComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async failComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCompleteLost() {
      markedLost += 1;
      receiptState = "reconciliation_required";
      return { ok: true, value: { state: "reconciliation_required" } };
    },
    async beginAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
  };
  const raw = {
    async head() {
      throw new Error("head readback unavailable");
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      return { uploadId: "unused" };
    },
    resumeMultipartUpload() {
      return {
        async uploadPart() {
          return { etag: "unused" };
        },
        async complete() {
          nativeCompleteCalls += 1;
          throw new Error("R2 multipart upload was not found (10024)");
        },
        async abort() {},
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({
      first: "backend_unavailable",
      second: "backend_unavailable",
    });
    expect(markedLost).toBe(2);
    expect(nativeCompleteCalls).toBe(1);
    expect(receiptState).toBe("reconciliation_required");
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects does not report invalid_part unless the durable receipt reopens", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      try {
        await env.MEDIA.completeMultipartUpload("failed.bin", "receipt-id", [
          { partNumber: 1, etag: "part-etag" },
        ]);
      } catch (error) {
        return Response.json({ error: error.name });
      }
      return new Response("unexpected", { status: 500 });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  const raw = {
    async head() {
      return null;
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      return { uploadId: "unused" };
    },
    resumeMultipartUpload() {
      return {
        async uploadPart() {
          return { etag: "unused" };
        },
        async complete() {
          throw { name: "invalid_part" };
        },
        async abort() {},
      };
    },
  };
  const receipt = {
    async beginCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCreateOutcomeUnknown() {
      return { ok: false, error: { code: "conflict" } };
    },
    async activateCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async releasePart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginComplete() {
      return {
        ok: true,
        value: {
          action: "execute",
          nativeUploadId: "native-upload",
          marker: "A".repeat(43),
          expectedSize: 4,
        },
      };
    },
    async commitComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async failComplete() {
      return { ok: true, value: { state: "completing" } };
    },
    async markCompleteLost() {
      return { ok: true, value: { state: "reconciliation_required" } };
    },
    async beginAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({ error: "backend_unavailable" });
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects fences an invalid_part with a different object and never retries complete", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      const parts = [{ partNumber: 1, etag: "part-etag" }];
      let first;
      try { await env.MEDIA.completeMultipartUpload("mismatch.bin", "receipt-mismatch", parts); }
      catch (error) { first = error.name; }
      let second;
      try { await env.MEDIA.completeMultipartUpload("mismatch.bin", "receipt-mismatch", parts); }
      catch (error) { second = error.name; }
      return Response.json({ first, second });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  let receiptState = "active";
  let nativeCompleteCalls = 0;
  let markReconciliationCalls = 0;
  let failCompleteCalls = 0;
  const marker = "A".repeat(43);
  const receipt = {
    async beginCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCreateOutcomeUnknown() {
      return { ok: false, error: { code: "conflict" } };
    },
    async activateCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async releasePart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginComplete() {
      if (receiptState === "reconciliation_required") {
        return {
          ok: true,
          value: {
            action: "reconcile",
            nativeUploadId: "native-mismatch",
            marker,
            expectedSize: 4,
          },
        };
      }
      receiptState = "completing";
      return {
        ok: true,
        value: { action: "execute", nativeUploadId: "native-mismatch", marker, expectedSize: 4 },
      };
    },
    async commitComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async failComplete() {
      failCompleteCalls += 1;
      receiptState = "active";
      return { ok: true, value: { state: "active" } };
    },
    async markCompleteLost() {
      markReconciliationCalls += 1;
      receiptState = "reconciliation_required";
      return { ok: true, value: { state: "reconciliation_required" } };
    },
    async beginAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
  };
  const raw = {
    async head() {
      return {
        httpEtag: '"different-object"',
        size: 4,
        customMetadata: { "takoserver-multipart-receipt-v1": "not-this-receipt" },
      };
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      return { uploadId: "unused" };
    },
    resumeMultipartUpload() {
      return {
        async uploadPart() {
          return { etag: "unused" };
        },
        async complete() {
          nativeCompleteCalls += 1;
          throw { name: "invalid_part" };
        },
        async abort() {},
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({
      first: "backend_unavailable",
      second: "backend_unavailable",
    });
    expect(nativeCompleteCalls).toBe(1);
    expect(failCompleteCalls).toBe(0);
    expect(markReconciliationCalls).toBe(2);
    expect(receiptState).toBe("reconciliation_required");
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects fences upload_not_found when the marker size disagrees and never retries complete", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      const parts = [{ partNumber: 1, etag: "part-etag" }];
      let first;
      try { await env.MEDIA.completeMultipartUpload("size-mismatch.bin", "receipt-size-mismatch", parts); }
      catch (error) { first = error.name; }
      let second;
      try { await env.MEDIA.completeMultipartUpload("size-mismatch.bin", "receipt-size-mismatch", parts); }
      catch (error) { second = error.name; }
      return Response.json({ first, second });
    } };`,
    { ...EMPTY_WORKER, bindings: [edgeObjectsDescriptor()] },
  );
  let receiptState = "active";
  let nativeCompleteCalls = 0;
  let markReconciliationCalls = 0;
  let failCompleteCalls = 0;
  const marker = "A".repeat(43);
  const receipt = {
    async beginCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async markCreateOutcomeUnknown() {
      return { ok: false, error: { code: "conflict" } };
    },
    async activateCreate() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitPart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async releasePart() {
      return { ok: false, error: { code: "conflict" } };
    },
    async beginComplete() {
      if (receiptState === "reconciliation_required") {
        return {
          ok: true,
          value: {
            action: "reconcile",
            nativeUploadId: "native-size-mismatch",
            marker,
            expectedSize: 4,
          },
        };
      }
      receiptState = "completing";
      return {
        ok: true,
        value: {
          action: "execute",
          nativeUploadId: "native-size-mismatch",
          marker,
          expectedSize: 4,
        },
      };
    },
    async commitComplete() {
      return { ok: false, error: { code: "conflict" } };
    },
    async failComplete() {
      failCompleteCalls += 1;
      receiptState = "active";
      return { ok: true, value: { state: "active" } };
    },
    async markCompleteLost() {
      markReconciliationCalls += 1;
      receiptState = "reconciliation_required";
      return { ok: true, value: { state: "reconciliation_required" } };
    },
    async beginAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
    async commitAbort() {
      return { ok: false, error: { code: "conflict" } };
    },
  };
  const raw = {
    async head() {
      return {
        httpEtag: '"different-size"',
        size: 9,
        customMetadata: { "takoserver-multipart-receipt-v1": marker },
      };
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list() {
      return { objects: [], truncated: false };
    },
    async createMultipartUpload() {
      return { uploadId: "unused" };
    },
    resumeMultipartUpload() {
      return {
        async uploadPart() {
          return { etag: "unused" };
        },
        async complete() {
          nativeCompleteCalls += 1;
          throw { name: "upload_not_found" };
        },
        async abort() {},
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: { getByName: () => receipt },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({
      first: "backend_unavailable",
      second: "backend_unavailable",
    });
    expect(nativeCompleteCalls).toBe(1);
    expect(failCompleteCalls).toBe(0);
    expect(markReconciliationCalls).toBe(2);
    expect(receiptState).toBe("reconciliation_required");
  } finally {
    await loaded.dispose();
  }
});

test("managed edge.objects list projects the exact closed Binding result", async () => {
  const loaded = await loadGeneratedWorker(
    `export default { async fetch(_request, env) {
      let invalidCursor;
      try { await env.MEDIA.list({ cursor: "unrecognized-valid-cursor" }); }
      catch (error) { invalidCursor = error.name; }
      let invalidHead;
      try { await env.MEDIA.head("reports/a.txt"); }
      catch (error) { invalidHead = error.name; }
      const upload = await env.MEDIA.createMultipartUpload("reports/part.txt");
      let invalidUploadPart;
      try { await env.MEDIA.uploadPart("reports/part.txt", upload.uploadId, 1, "body"); }
      catch (error) { invalidUploadPart = error.name; }
      const page = await env.MEDIA.list();
      return Response.json({
        resultKeys: Reflect.ownKeys(page).sort(),
        objectKeys: Reflect.ownKeys(page.objects[0]).sort(),
        prefixes: page.prefixes,
        invalidCursor,
        invalidHead,
        invalidUploadPart,
      });
    } };`,
    {
      ...EMPTY_WORKER,
      bindings: [edgeObjectsDescriptor()],
    },
  );
  const raw = {
    async head() {
      const error = new Error("provider-private wrong operation code");
      error.name = "invalid_part";
      throw error;
    },
    async get() {
      return null;
    },
    async put() {
      return null;
    },
    async delete() {},
    async list(options?: { readonly cursor?: string }) {
      if (options?.cursor) {
        const error = new Error("provider-private cursor rejection");
        error.name = "invalid_cursor";
        throw error;
      }
      return {
        objects: [
          {
            key: "reports/a.txt",
            httpEtag: '"etag"',
            size: 1,
            uploaded: new Date("2026-09-01T00:00:00.000Z"),
            httpMetadata: { contentType: "text/plain" },
            nativeExtra: "hidden",
          },
        ],
        truncated: false,
        nativeExtra: "hidden",
      };
    },
    async createMultipartUpload() {
      return { uploadId: "unused" };
    },
    resumeMultipartUpload() {
      return {
        async uploadPart(_partNumber: number, body: ReadableStream<Uint8Array>) {
          await new Response(body).arrayBuffer();
          throw { name: "invalid_part" };
        },
        async complete() {
          return { httpEtag: '"unused"', size: 0 };
        },
        async abort() {},
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        __TAKOSERVER_OBJECTS_0: raw,
        [OBJECT_RECEIPT_NATIVE_NAME]: {
          getByName() {
            return {
              async createMultipartUpload() {
                return { ok: true, value: { state: "active" } };
              },
              async beginCreate() {
                return { ok: true, value: { state: "creating" } };
              },
              async markCreateOutcomeUnknown() {
                return { ok: false, error: { code: "conflict" } };
              },
              async activateCreate() {
                return { ok: true, value: { state: "active" } };
              },
              async beginPart(input: { readonly attemptId: string }) {
                return {
                  ok: true,
                  value: { nativeUploadId: "unused", attemptId: input.attemptId },
                };
              },
              async commitPart() {
                return { ok: false, error: { code: "backend_unavailable" } };
              },
              async releasePart() {
                return { ok: true, value: { state: "active" } };
              },
              async beginComplete() {
                return { ok: false, error: { code: "invalid_part" } };
              },
              async commitComplete() {
                return { ok: false, error: { code: "backend_unavailable" } };
              },
              async failComplete() {
                return { ok: true, value: { state: "active" } };
              },
              async markCompleteLost() {
                return { ok: true, value: { state: "reconciliation_required" } };
              },
              async beginAbort() {
                return { ok: false, error: { code: "not_found" } };
              },
              async commitAbort() {
                return { ok: false, error: { code: "not_found" } };
              },
            };
          },
        },
      },
      { waitUntil() {} },
    );
    expect(await response.json()).toEqual({
      resultKeys: ["objects", "prefixes", "truncated"],
      objectKeys: ["etag", "key", "size", "uploadedAtMillis"],
      prefixes: [],
      invalidCursor: "invalid_cursor",
      invalidHead: "backend_unavailable",
      invalidUploadPart: "backend_unavailable",
    });
  } finally {
    await loaded.dispose();
  }
});

test("generator rejects unsafe module names, unsupported native shapes, and namespace collisions", () => {
  for (const originalMainModule of [
    "",
    "./index.js",
    "../index.js",
    "/index.js",
    "https://example.com/index.js",
    "src/../index.js",
    "index.js\0suffix",
  ]) {
    expect(() =>
      managedWorkerEntrypointSource({
        ...EMPTY_WORKER,
        originalMainModule,
      }),
    ).toThrow(TypeError);
  }
  for (const type of ["d1", "assets", "durable_object_namespace", "browser"]) {
    expect(() =>
      managedWorkerEntrypointSource({
        ...EMPTY_WORKER,
        bindings: [{ name: "DB", type } as never],
      }),
    ).toThrow(TypeError);
  }
  expect(() =>
    managedWorkerEntrypointSource({
      ...EMPTY_WORKER,
      declaredHandlers: ["fetch", "fetch"],
    }),
  ).toThrow(TypeError);
  expect(() =>
    managedWorkerEntrypointSource({
      ...EMPTY_WORKER,
      bindings: [
        {
          ...edgeObjectsDescriptor(),
          apiVersion: "interfaces.takoform.com/v1alpha1",
        } as never,
      ],
    }),
  ).toThrow(TypeError);
  expect(() =>
    managedWorkerEntrypointSource({
      ...EMPTY_WORKER,
      bindings: [
        { name: "VALUE", type: "plain_text" },
        { name: "VALUE", type: "secret_text" },
      ],
    }),
  ).toThrow(TypeError);
  expect(() =>
    managedWorkerEntrypointSource({
      ...EMPTY_WORKER,
      bindings: [
        {
          kind: MANAGED_WORKER_EDGE_SQL_BINDING_KIND,
          publicName: "DB",
          nativeName: "DB_NATIVE",
          instanceName: "opaque-instance",
        },
      ],
    }),
  ).toThrow(TypeError);
  expect(() =>
    managedWorkerEntrypointSource({
      ...EMPTY_WORKER,
      bindings: [
        {
          kind: MANAGED_WORKER_EDGE_SQL_BINDING_KIND,
          publicName: "DB",
          nativeName: "__TAKOSERVER_SQLITE_0",
          instanceName: "opaque-instance",
        },
        { name: "__TAKOSERVER_SQLITE_0", type: "plain_text" },
      ],
    }),
  ).toThrow(TypeError);
  expect(() =>
    managedWorkerEntrypointSource({
      ...EMPTY_WORKER,
      bindings: [
        {
          ...edgeObjectsDescriptor(),
          receiptInstanceName: "customer-selected-receipt-authority",
        },
      ],
    }),
  ).toThrow(TypeError);

  let getterCalls = 0;
  const accessorInput = Object.create(null) as Record<string, unknown>;
  Object.defineProperties(accessorInput, {
    originalMainModule: {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "index.js";
      },
    },
    declaredHandlers: { enumerable: true, value: ["fetch"] },
    bindings: { enumerable: true, value: [] },
  });
  expect(() =>
    managedWorkerEntrypointSource(accessorInput as unknown as ManagedWorkerEntrypointSourceInput),
  ).toThrow(TypeError);
  expect(getterCalls).toBe(0);
});

test("readiness is dispatch-props gated, validates own declared handlers, and invokes no customer handler", async () => {
  const valid = await loadGeneratedWorker(
    `let calls = 0;
export default {
  scheduled() { calls += 1; },
  fetch() { calls += 1; return new Response("customer:" + calls); },
};`,
    { ...EMPTY_WORKER, declaredHandlers: ["scheduled", "fetch"] },
  );
  const props = {
    schema: MANAGED_WORKER_READINESS_PROPS_SCHEMA,
    operationId: "operation-1",
    descriptorDigest: `sha256:${"a".repeat(64)}`,
  };
  try {
    const response = await valid.worker.fetch(
      publicRequest(MANAGED_WORKER_READINESS_PATH),
      {},
      { props },
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      schema: MANAGED_WORKER_READINESS_RESULT_SCHEMA,
      operationId: "operation-1",
      descriptorDigest: `sha256:${"a".repeat(64)}`,
      handlers: ["fetch", "scheduled"],
    });
    const publicResponse = await valid.worker.fetch(
      publicRequest(MANAGED_WORKER_READINESS_PATH),
      {},
      { props: { ...props, extra: true } },
    );
    expect(await publicResponse.text()).toBe("customer:1");
  } finally {
    await valid.dispose();
  }

  for (const customerSource of [
    'export function fetch() { return new Response("namespace"); }',
    'const inherited = { fetch() { return new Response("inherited"); } }; export default Object.create(inherited);',
    'const accessor = {}; Object.defineProperty(accessor, "fetch", { enumerable: true, get() { return () => new Response("accessor"); } }); export default accessor;',
    "export default { queue() {} };",
  ]) {
    const invalid = await loadGeneratedWorker(customerSource);
    try {
      expect(
        (await invalid.worker.fetch(publicRequest(MANAGED_WORKER_READINESS_PATH), {}, { props }))
          .status,
      ).toBe(500);
    } finally {
      await invalid.dispose();
    }
  }
});

test("customer env, context, and binding adapters have exact null-prototype projections", async () => {
  const bindingInput: ManagedWorkerEntrypointSourceInput = {
    ...EMPTY_WORKER,
    bindings: [
      { name: "TEXT", type: "plain_text" },
      { name: "DOCUMENT", type: "json" },
      { name: "PUBLIC.VALUE", type: "json" },
      { name: "SECRET", type: "secret_text" },
      { name: "KV", type: "kv_namespace" },
      { name: "QUEUE", type: "queue" },
      { name: "SERVICE", type: "service" },
      {
        kind: MANAGED_WORKER_EDGE_SQL_BINDING_KIND,
        publicName: "DB",
        nativeName: "__TAKOSERVER_SQLITE_0",
        instanceName: "database-instance",
      },
    ],
  };
  const loaded = await loadGeneratedWorker(
    `export default { fetch(_request, env, context) {
  const describe = (value) => ({ keys: Reflect.ownKeys(value), nullPrototype: Object.getPrototypeOf(value) === null });
  return Response.json({
    env: describe(env), context: describe(context),
    kv: describe(env.KV), queue: describe(env.QUEUE),
    service: describe(env.SERVICE), sql: describe(env.DB),
    text: env.TEXT, document: env.DOCUMENT, dotted: env["PUBLIC.VALUE"], secret: env.SECRET,
    leaked: env.RAW_EXTRA ?? env.TAKOSERVER_INTERNAL_OPERATION_MARKER ?? env.__TAKOSERVER_SQLITE_0,
  });
} };`,
    bindingInput,
  );
  const methods = {
    KV: {
      get() {},
      getWithMetadata() {},
      put() {},
      delete() {},
      list() {},
    },
    QUEUE: { send() {}, sendBatch() {} },
    SERVICE: { fetch() {} },
  };
  const sqlStub = {
    edgeSqlExecute() {},
    edgeSqlQuery() {},
    edgeSqlTransaction() {},
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        TEXT: "value",
        DOCUMENT: { nested: true },
        "PUBLIC.VALUE": { portable: true },
        SECRET: "sealed",
        ...methods,
        __TAKOSERVER_SQLITE_0: { getByName: () => sqlStub },
        RAW_EXTRA: "must-not-leak",
        TAKOSERVER_INTERNAL_OPERATION_MARKER: "must-not-leak",
      },
      {
        waitUntil() {},
        passThroughOnException() {},
        props: { raw: "must-not-leak" },
      },
    );
    expect(await response.json()).toEqual({
      env: {
        keys: ["TEXT", "DOCUMENT", "PUBLIC.VALUE", "SECRET", "KV", "QUEUE", "SERVICE", "DB"],
        nullPrototype: true,
      },
      context: { keys: ["waitUntil"], nullPrototype: true },
      kv: {
        keys: ["get", "getWithMetadata", "put", "delete", "list"],
        nullPrototype: true,
      },
      queue: { keys: ["send", "sendBatch"], nullPrototype: true },
      service: { keys: ["fetch"], nullPrototype: true },
      sql: { keys: ["execute", "query", "transaction"], nullPrototype: true },
      text: "value",
      document: { nested: true },
      dotted: { portable: true },
      secret: "sealed",
    });
  } finally {
    await loaded.dispose();
  }
});

test("KV, Queue producer, Service, and SQLite-DO adapters preserve portable bytes and closed errors", async () => {
  const calls: Array<{ readonly operation: string; readonly value: unknown }> = [];
  const bindingInput: ManagedWorkerEntrypointSourceInput = {
    ...EMPTY_WORKER,
    bindings: [
      { name: "KV", type: "kv_namespace" },
      { name: "QUEUE", type: "queue" },
      { name: "SERVICE", type: "service" },
      {
        kind: MANAGED_WORKER_EDGE_SQL_BINDING_KIND,
        publicName: "DB",
        nativeName: "__TAKOSERVER_SQLITE_0",
        instanceName: "db-instance-v7",
      },
    ],
  };
  const loaded = await loadGeneratedWorker(
    `const named = async (promise) => { try { await promise; return null; } catch (error) { return { name: error.name, message: error.message }; } };
export default { async fetch(_request, env) {
  const value = Array.from(new Uint8Array(await env.KV.get("alpha")));
  const withMetadata = await env.KV.getWithMetadata("alpha");
  const poisonedView = new Uint16Array([0x0201]);
  Object.defineProperties(poisonedView, {
    buffer: { get() { throw new Error("poisoned buffer getter"); } },
    byteOffset: { get() { return 999; } },
    byteLength: { get() { return 999; } },
  });
  await env.KV.put("saved", poisonedView, { expirationTtlSeconds: 60, metadata: { owner: "test" } });
  const list = await env.KV.list({ prefix: "a", limit: 2 });
  const invalidKey = await named(env.KV.get(""));
  const invalidKvMetadata = await named(env.KV.put("saved", "value", { metadata: null }));
  const privateKvFailure = await named(env.KV.get("explode"));
  const accepted = await env.QUEUE.send("hello", { delaySeconds: 0 });
  const acceptedBatch = await env.QUEUE.sendBatch([{ body: new Uint8Array([1, 2]) }, { body: "three", delaySeconds: 4 }]);
  const invalidQueueDelay = await named(env.QUEUE.send("invalid", { delaySeconds: -1 }));
  const service500 = await env.SERVICE.fetch("https://service.internal/failure");
  const serviceUnavailable = await named(env.SERVICE.fetch("https://service.internal/unavailable"));
  const invalidServiceMethod = await named(env.SERVICE.fetch("https://service.internal/custom", { method: "TRACE" }));
  const invalidServiceLength = await named(Promise.resolve().then(() => env.SERVICE.fetch(new Request("https://service.internal/length", { headers: { "content-length": "1" } }))));
  const responseAborted = await named(env.SERVICE.fetch("https://service.internal/oversized"));
  const execute = await env.DB.execute("INSERT INTO t VALUES (?1, ?2)", [1.5, { encoding: "base64", data: "AQI=" }]);
  const queryBusy = await named(env.DB.query("SELECT busy"));
  const malformedSqlOutput = await named(env.DB.query("SELECT malformed"));
  const numericOutOfRange = await named(env.DB.execute("SELECT ?1", [Infinity]));
  const transaction = await env.DB.transaction([{ sql: "SELECT ?1", params: ["ok"] }]);
  return Response.json({
    value, metadataBytes: Array.from(new Uint8Array(withMetadata.value)), metadata: withMetadata.metadata,
    list, invalidKey, invalidKvMetadata, privateKvFailure, accepted, acceptedBatch, invalidQueueDelay,
    serviceStatus: service500.status, serviceBody: await service500.text(), serviceUnavailable, invalidServiceMethod, invalidServiceLength, responseAborted,
    execute, queryBusy, malformedSqlOutput, numericOutOfRange, transaction,
  });
} };`,
    bindingInput,
  );

  const kv = {
    async get(key: string, type: string) {
      calls.push({ operation: "kv.get", value: { key, type } });
      if (key === "explode") throw new Error("provider credential leaked");
      return new Uint8Array([1, 2, 3]).buffer;
    },
    async getWithMetadata(key: string, type: string) {
      calls.push({ operation: "kv.getWithMetadata", value: { key, type } });
      return {
        value: new Uint8Array([4, 5]).buffer,
        metadata: { owner: "test" },
        cacheStatus: "native-extra",
      };
    },
    async put(key: string, value: Uint8Array, options: object) {
      calls.push({
        operation: "kv.put",
        value: { key, bytes: Array.from(value), options },
      });
    },
    async delete(key: string) {
      calls.push({ operation: "kv.delete", value: key });
    },
    async list(options: object) {
      calls.push({ operation: "kv.list", value: options });
      return {
        keys: [{ name: "alpha", metadata: { native: "hidden" } }],
        list_complete: false,
        cursor: "next-page",
        cacheStatus: "native-extra",
      };
    },
  };
  const queue = {
    async send(body: Uint8Array, options: object) {
      calls.push({
        operation: "queue.send",
        value: { bytes: Array.from(body), options },
      });
      return { messageId: "cloudflare-does-not-return-this" };
    },
    async sendBatch(messages: Array<{ body: Uint8Array }>) {
      calls.push({
        operation: "queue.sendBatch",
        value: messages.map((message) => ({
          ...message,
          body: Array.from(message.body),
        })),
      });
      return { outcome: "acknowledged-without-provider-message-ids" };
    },
  };
  const service = {
    async fetch(input: RequestInfo | URL) {
      const url = input instanceof Request ? input.url : String(input);
      calls.push({ operation: "service.fetch", value: url });
      if (url.endsWith("/unavailable")) throw new Error("private dispatch detail");
      if (url.endsWith("/oversized")) {
        return new Response(null, { headers: { "content-length": "104857601" } });
      }
      return new Response("callee failed", { status: 500 });
    },
  };
  const sqlStub = {
    async edgeSqlExecute(input: unknown) {
      calls.push({ operation: "sql.execute", value: input });
      return {
        ok: true,
        value: {
          rows: [{ "": "empty-column", blob: { encoding: "base64", data: "AQI=" }, decimal: 1.5 }],
          rowsWritten: 1,
        },
      };
    },
    async edgeSqlQuery(input: { readonly sql: string }) {
      calls.push({ operation: "sql.query", value: input });
      if (input.sql.includes("malformed")) {
        return {
          ok: true,
          value: { rows: [], rowsWritten: 0, nativeMetadata: "hidden" },
        };
      }
      return { ok: false, error: { code: "busy" } };
    },
    async edgeSqlTransaction(input: unknown) {
      calls.push({ operation: "sql.transaction", value: input });
      return {
        ok: true,
        value: { results: [{ rows: [{ value: "ok" }], rowsWritten: 0 }] },
      };
    },
  };
  try {
    const response = await loaded.worker.fetch(
      publicRequest(),
      {
        KV: kv,
        QUEUE: queue,
        SERVICE: service,
        __TAKOSERVER_SQLITE_0: {
          getByName(instanceName: string) {
            calls.push({ operation: "sql.getByName", value: instanceName });
            return sqlStub;
          },
        },
      },
      { waitUntil() {} },
    );
    const body = (await response.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      value: [1, 2, 3],
      metadataBytes: [4, 5],
      metadata: { owner: "test" },
      list: {
        keys: [{ name: "alpha" }],
        listComplete: false,
        cursor: "next-page",
      },
      invalidKey: { name: "invalid_key", message: "invalid_key" },
      invalidKvMetadata: { name: "invalid_value", message: "invalid_value" },
      privateKvFailure: {
        name: "backend_unavailable",
        message: "backend_unavailable",
      },
      invalidQueueDelay: {
        name: "invalid_argument",
        message: "invalid_argument",
      },
      serviceStatus: 500,
      serviceBody: "callee failed",
      serviceUnavailable: {
        name: "backend_unavailable",
        message: "backend_unavailable",
      },
      invalidServiceMethod: {
        name: "invalid_argument",
        message: "invalid_argument",
      },
      invalidServiceLength: {
        name: "request_too_large",
        message: "request_too_large",
      },
      responseAborted: {
        name: "response_aborted",
        message: "response_aborted",
      },
      execute: {
        rows: [
          {
            "": "empty-column",
            blob: { encoding: "base64", data: "AQI=" },
            decimal: 1.5,
          },
        ],
        rowsWritten: 1,
      },
      queryBusy: { name: "busy", message: "busy" },
      malformedSqlOutput: {
        name: "backend_unavailable",
        message: "backend_unavailable",
      },
      numericOutOfRange: {
        name: "numeric_out_of_range",
        message: "numeric_out_of_range",
      },
      transaction: [{ rows: [{ value: "ok" }], rowsWritten: 0 }],
    });
    expect(typeof body.accepted).toBe("string");
    expect(body.accepted).not.toBe("cloudflare-does-not-return-this");
    expect(body.acceptedBatch).toHaveLength(2);
    expect(new Set(body.acceptedBatch as string[]).size).toBe(2);
    expect(calls).toContainEqual({
      operation: "kv.put",
      value: {
        key: "saved",
        bytes: [1, 2],
        options: { expirationTtl: 60, metadata: { owner: "test" } },
      },
    });
    expect(calls).toContainEqual({
      operation: "queue.send",
      value: {
        bytes: [104, 101, 108, 108, 111],
        options: { contentType: "bytes", delaySeconds: 0 },
      },
    });
    expect(calls).toContainEqual({
      operation: "sql.getByName",
      value: "db-instance-v7",
    });
    const sqlInput = calls.find(({ operation }) => operation === "sql.execute")?.value as Record<
      string,
      unknown
    >;
    expect(Reflect.ownKeys(sqlInput)).toEqual(["sql", "params"]);
    expect(Object.getPrototypeOf(sqlInput)).toBeNull();
  } finally {
    await loaded.dispose();
  }
});

test("raw R2 bindings are not part of the managed Worker ABI", () => {
  expect(() =>
    managedWorkerEntrypointSource({
      ...EMPTY_WORKER,
      bindings: [{ name: "OBJECTS", type: "r2_bucket" } as never],
    }),
  ).toThrow(TypeError);
});

test("Queue delivery preserves encoded bytes, exact portable shapes, and throw settlement semantics", async () => {
  let report: unknown;
  const waits: Promise<unknown>[] = [];
  const loaded = await loadGeneratedWorker(
    `export default { async queue(batch, env, context) {
  const first = batch.messages[0];
  first.acknowledge();
  let doubleSettlement;
  try { first.acknowledge(); } catch (error) { doubleSettlement = error.name; }
  batch.messages[1].retry({ delaySeconds: 1 });
  let zeroDelay;
  try { batch.messages[2].retry({ delaySeconds: 0 }); } catch (error) { zeroDelay = error.name; }
  context.waitUntil(Promise.reject(new Error("diagnostic only")));
  env.REPORT({
    batchKeys: Reflect.ownKeys(batch), batchNullPrototype: Object.getPrototypeOf(batch) === null,
    messageKeys: Reflect.ownKeys(first), messageNullPrototype: Object.getPrototypeOf(first) === null,
    bodyKeys: Reflect.ownKeys(first.body), bodyNullPrototype: Object.getPrototypeOf(first.body) === null,
    contextKeys: Reflect.ownKeys(context), contextNullPrototype: Object.getPrototypeOf(context) === null,
    id: first.id, timestampMillis: first.timestampMillis, attempts: first.attempts, body: first.body,
    doubleSettlement, zeroDelay,
  });
  batch.messages[0].id = "customer-mutated";
  batch.messages.length = 1;
  throw new Error("retry only messages not already acknowledged");
} };`,
    {
      originalMainModule: "queue-worker.js",
      declaredHandlers: ["queue"],
      bindings: [{ name: "REPORT", type: "plain_text" }],
    },
  );
  const event = {
    protocol: EVENT_PROTOCOL,
    kind: "queue",
    batchId: "batch-1",
    logicalWorkerId: "worker-1",
    deploymentId: "deployment-1",
    queue: "delivery",
    messages: [
      {
        messageId: "message-1",
        timestampMillis: 1_788_220_800_000,
        attempts: 1,
        body: { encoding: "base64", data: "AQI=" },
      },
      {
        messageId: "message-2",
        timestampMillis: 1_788_220_800_001,
        attempts: 2,
        body: { encoding: "base64", data: "Aw==" },
      },
      {
        messageId: "message-3",
        timestampMillis: 1_788_220_800_002,
        attempts: 3,
        body: { encoding: "base64", data: "BA==" },
      },
    ],
  };
  try {
    const response = await loaded.worker.fetch(
      eventRequest(event),
      {
        REPORT: (value: unknown) => {
          report = value;
        },
        RAW_INTERNAL: "hidden",
      },
      gatewayContext("queue", waits),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol: EVENT_PROTOCOL,
      kind: "queue",
      decisions: [
        { messageId: "message-1", outcome: "ack" },
        { messageId: "message-2", outcome: "retry", delaySeconds: 1 },
        { messageId: "message-3", outcome: "retry" },
      ],
    });
    expect(report).toEqual({
      batchKeys: ["batchId", "queue", "messages", "acknowledgeAll", "retryAll"],
      batchNullPrototype: true,
      messageKeys: ["id", "timestampMillis", "attempts", "body", "acknowledge", "retry"],
      messageNullPrototype: true,
      bodyKeys: ["encoding", "data"],
      bodyNullPrototype: true,
      contextKeys: ["waitUntil"],
      contextNullPrototype: true,
      id: "message-1",
      timestampMillis: 1_788_220_800_000,
      attempts: 1,
      body: { encoding: "base64", data: "AQI=" },
      doubleSettlement: "already_settled",
      zeroDelay: "invalid_argument",
    });
    const duplicateResponse = await loaded.worker.fetch(
      eventRequest({
        ...event,
        batchId: "batch-duplicate",
        messages: [event.messages[0], event.messages[0]],
      }),
      { REPORT() {} },
      gatewayContext("queue"),
    );
    expect(duplicateResponse.status).toBe(500);
    expect(waits).toHaveLength(1);
    expect((await Promise.allSettled(waits))[0]?.status).toBe("rejected");
  } finally {
    await loaded.dispose();
  }
});

test("Queue normal return defaults to ack and does not await waitUntil", async () => {
  let release!: () => void;
  const background = new Promise<void>((resolve) => {
    release = resolve;
  });
  const waits: Promise<unknown>[] = [];
  const loaded = await loadGeneratedWorker(
    `export default { queue(_batch, env, context) { context.waitUntil(env.BACKGROUND); } };`,
    {
      originalMainModule: "queue-success.js",
      declaredHandlers: ["queue"],
      bindings: [{ name: "BACKGROUND", type: "json" }],
    },
  );
  try {
    const response = await Promise.race([
      loaded.worker.fetch(
        eventRequest({
          protocol: EVENT_PROTOCOL,
          kind: "queue",
          batchId: "batch-success",
          logicalWorkerId: "worker-1",
          deploymentId: "deployment-1",
          queue: "delivery",
          messages: [
            {
              messageId: "message-success",
              timestampMillis: 1,
              attempts: 1,
              body: { encoding: "base64", data: "" },
            },
          ],
        }),
        { BACKGROUND: background },
        gatewayContext("queue", waits),
      ),
      Bun.sleep(100).then(() => "timed-out" as const),
    ]);
    expect(response).not.toBe("timed-out");
    expect(await (response as Response).json()).toEqual({
      protocol: EVENT_PROTOCOL,
      kind: "queue",
      decisions: [{ messageId: "message-success", outcome: "ack" }],
    });
    expect(waits).toEqual([background]);
  } finally {
    release();
    await loaded.dispose();
  }
});

test("Scheduled delivery waits for nested waitUntil tasks but treats rejection as diagnostics only", async () => {
  let releaseFirst!: () => void;
  let releaseSecond!: () => void;
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  const second = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  let report: unknown;
  const waits: Promise<unknown>[] = [];
  const loaded = await loadGeneratedWorker(
    `export default { scheduled(event, env, context) {
  env.REPORT({
    eventKeys: Reflect.ownKeys(event), eventNullPrototype: Object.getPrototypeOf(event) === null,
    contextKeys: Reflect.ownKeys(context), contextNullPrototype: Object.getPrototypeOf(context) === null,
    cron: event.cron, scheduledTime: event.scheduledTime,
  });
  context.waitUntil(env.FIRST.then(() => { context.waitUntil(env.SECOND); }));
  context.waitUntil(Promise.reject(new Error("diagnostic rejection")));
} };`,
    {
      originalMainModule: "scheduled-worker.js",
      declaredHandlers: ["scheduled"],
      bindings: [
        { name: "REPORT", type: "plain_text" },
        { name: "FIRST", type: "json" },
        { name: "SECOND", type: "json" },
      ],
    },
  );
  const invocation = loaded.worker.fetch(
    eventRequest({
      protocol: EVENT_PROTOCOL,
      kind: "schedule",
      logicalWorkerId: "worker-1",
      deploymentId: "deployment-1",
      cron: "*/5 * * * *",
      scheduledTime: 1_788_220_800_000,
    }),
    {
      FIRST: first,
      SECOND: second,
      REPORT: (value: unknown) => {
        report = value;
      },
    },
    gatewayContext("scheduled", waits),
  );
  try {
    while (report === undefined) await Bun.sleep(1);
    expect(
      await Promise.race([invocation.then(() => "settled"), Bun.sleep(25).then(() => "pending")]),
    ).toBe("pending");
    releaseFirst();
    while (waits.length < 3) await Bun.sleep(1);
    expect(
      await Promise.race([invocation.then(() => "settled"), Bun.sleep(25).then(() => "pending")]),
    ).toBe("pending");
    releaseSecond();
    const response = await invocation;
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      protocol: EVENT_PROTOCOL,
      kind: "schedule",
      outcome: "ack",
    });
    expect(report).toEqual({
      eventKeys: ["cron", "scheduledTime"],
      eventNullPrototype: true,
      contextKeys: ["waitUntil"],
      contextNullPrototype: true,
      cron: "*/5 * * * *",
      scheduledTime: 1_788_220_800_000,
    });
    expect((await Promise.allSettled(waits)).map(({ status }) => status)).toEqual([
      "fulfilled",
      "rejected",
      "fulfilled",
    ]);
  } finally {
    releaseFirst();
    releaseSecond();
    await loaded.dispose();
  }
});

test("Scheduled handler failure waits for its background task and fails the invocation", async () => {
  let release!: () => void;
  const background = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loaded = await loadGeneratedWorker(
    `export default { scheduled(_event, env, context) { context.waitUntil(env.BACKGROUND); throw new Error("handler failed"); } };`,
    {
      originalMainModule: "scheduled-failure.js",
      declaredHandlers: ["scheduled"],
      bindings: [{ name: "BACKGROUND", type: "json" }],
    },
  );
  const invocation = loaded.worker.fetch(
    eventRequest({
      protocol: EVENT_PROTOCOL,
      kind: "schedule",
      logicalWorkerId: "worker-1",
      deploymentId: "deployment-1",
      cron: "0 * * * *",
      scheduledTime: 1,
    }),
    { BACKGROUND: background },
    gatewayContext("scheduled"),
  );
  try {
    expect(
      await Promise.race([invocation.then(() => "settled"), Bun.sleep(25).then(() => "pending")]),
    ).toBe("pending");
    release();
    expect((await invocation).status).toBe(500);
  } finally {
    release();
    await loaded.dispose();
  }
});

/**
 * ADR 0007's managed-lane amendment. A binding belongs to the script it is
 * declared on, and workerd hands every one of them to every module that script
 * runs — `import { env } from "cloudflare:workers"` included. So the wrapper's
 * projected `env` never hid the internal `__TAKOSERVER_OBJECTS_<i>` handle; it
 * only declined to pass it. `disallow_importable_env`, which
 * `CloudflareWfpBackend` now uploads on every tenant user Worker, is what
 * empties the importable environment. This runs the generated wrapper under the
 * pinned workerd both ways and reads the difference.
 */
type MiniflareWorker = MiniflareOptions["workers"][number];

function importableEnvWorker(name: string, compatibilityFlags: string[]): MiniflareWorker {
  return {
    config: {
      name,
      type: "worker",
      compatibilityDate: "2026-08-18",
      compatibilityFlags,
      manifest: {
        mainModule: "wrapper.js",
        modules: {
          "wrapper.js": {
            type: "esm",
            contents: managedWorkerEntrypointSource({
              ...EMPTY_WORKER,
              bindings: [
                { name: "GREETING", type: "plain_text" },
                { name: "API_KEY", type: "secret_text" },
                edgeObjectsDescriptor(),
              ],
            }),
          },
          "index.js": {
            type: "esm",
            contents: `import { env as importable } from "cloudflare:workers";
export default { async fetch(_request, env) {
  const importableKeys = Reflect.ownKeys(importable ?? {}).sort();
  const rawBucket = importable?.__TAKOSERVER_OBJECTS_0;
  const rawReceiptNamespace = importable?.__TAKOSERVER_OBJECT_RECEIPTS_0;
  let rawPut = "absent";
  if (rawBucket) {
    try { await rawBucket.put("raw.txt", "raw"); rawPut = "stored"; }
    catch (error) { rawPut = error.name; }
  }
  return Response.json({
    importableKeys,
    rawSecret: importable?.API_KEY ?? null,
    rawPut,
    rawReceiptNamespace: rawReceiptNamespace ? "present" : "absent",
    handlerKeys: Reflect.ownKeys(env).sort(),
    handlerGreeting: env.GREETING,
    handlerSecret: env.API_KEY,
    mediaMethods: Reflect.ownKeys(env.MEDIA).sort(),
  });
} };`,
          },
        },
      },
      env: {
        GREETING: { type: "text", value: "hello" },
        API_KEY: { type: "text", value: "s3cret" },
        __TAKOSERVER_OBJECTS_0: {
          type: "r2",
          name: `${name}-bucket`,
        },
        [OBJECT_RECEIPT_NATIVE_NAME]: {
          type: "durable-object",
          workerName: "managed-object-receipt-import-fence-test",
          exportName: "TakoserverManagedObjectReceipt",
        },
      },
      triggers: [],
    },
  };
}

async function importableEnvComparison() {
  const unflaggedWorkerName = "wrapper-import-fence-unflagged";
  const flaggedWorkerName = "wrapper-import-fence-flagged";
  const receiptWorker = await bundledObjectReceiptWorker();
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "managed-object-receipt-import-fence-test",
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: receiptWorker } },
          },
          exports: {
            TakoserverManagedObjectReceipt: { type: "durable-object", storage: "sqlite" },
          },
          env: {},
          triggers: [],
        },
      },
      importableEnvWorker(unflaggedWorkerName, []),
      importableEnvWorker(flaggedWorkerName, ["disallow_importable_env"]),
    ],
  });
  try {
    async function readWorker(name: string) {
      const worker = await runtime.getWorker(name);
      const response = await worker.fetch("https://worker.example/");
      const text = await response.text();
      expect({ status: response.status, text }).toMatchObject({ status: 200 });
      return JSON.parse(text) as Record<string, unknown>;
    }

    return {
      unflagged: await readWorker(unflaggedWorkerName),
      flagged: await readWorker(flaggedWorkerName),
    };
  } finally {
    await runtime.dispose();
  }
}

test("disallow_importable_env empties the tenant's importable env and changes nothing else", async () => {
  const comparison = await importableEnvComparison();
  const projected = {
    handlerKeys: ["API_KEY", "GREETING", "MEDIA"],
    handlerGreeting: "hello",
    handlerSecret: "s3cret",
    mediaMethods: [
      "abortMultipartUpload",
      "completeMultipartUpload",
      "createMultipartUpload",
      "delete",
      "get",
      "head",
      "list",
      "put",
      "uploadPart",
    ],
  };

  // Without the flag the raw internal R2 handle and the raw secret are both
  // one import away, and the handle is usable. This is the defect.
  expect(comparison.unflagged).toEqual({
    ...projected,
    importableKeys: [
      "API_KEY",
      "GREETING",
      "__TAKOSERVER_OBJECTS_0",
      "__TAKOSERVER_OBJECT_RECEIPTS_0",
    ],
    rawSecret: "s3cret",
    rawPut: "stored",
    rawReceiptNamespace: "present",
  });

  // With it the importable environment is empty, and the handler env and the
  // projected facade are byte-for-byte what they were.
  expect(comparison.flagged).toEqual({
    ...projected,
    importableKeys: [],
    rawSecret: null,
    rawPut: "absent",
    rawReceiptNamespace: "absent",
  });
}, 60_000);
