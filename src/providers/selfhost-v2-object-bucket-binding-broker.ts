import { Buffer } from "node:buffer";
import { createHmac, timingSafeEqual } from "node:crypto";
import { SelfhostObjectError } from "../selfhost-object-store.ts";
import type {
  SelfhostV2ObjectBucketAccess,
  SelfhostV2ObjectBucketIdentity,
  SelfhostV2ObjectBucketStore,
} from "./selfhost-v2-object-bucket-store.ts";
import {
  MAX_SELFHOST_OBJECT_DOCUMENT_BYTES,
  SELFHOST_DATA_PLANE_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
  SELFHOST_DATA_PLANE_OBJECT_PROTOCOL,
  SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER,
  SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER,
  SELFHOST_DATA_PLANE_OBJECTS_PATH,
} from "./selfhost-worker-wrapper.ts";

const UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const BINDING = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/u;
const MAX_TOKEN_LENGTH = 32_768;
const OBJECT_OPERATION_FIELDS: Readonly<Record<string, readonly string[]>> = {
  head: ["key"],
  get: ["key", "range", "ifMatch", "ifNoneMatch"],
  put: ["key", "contentLength", "contentType", "ifMatch", "ifNoneMatch"],
  delete: ["key"],
  list: ["prefix", "delimiter", "cursor", "limit"],
  createMultipartUpload: ["key", "contentType"],
  uploadPart: ["key", "uploadId", "partNumber", "contentLength"],
  completeMultipartUpload: ["key", "uploadId", "parts"],
  abortMultipartUpload: ["key", "uploadId"],
};

export interface V2ObjectBucketBindingGrant {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly nativeVersionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly bindings: readonly { readonly name: string; readonly resourceUid: string }[];
}

export interface V2ObjectBucketSelectedVersionObservation {
  readonly kind: "confirmed";
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly versionId: string;
  readonly incarnationId: string;
  readonly servingSourceOperationId: string;
  readonly status: "active" | "draining";
}

/**
 * Host-owned current Core proof for one exact Version binding. `vector` must
 * change whenever the accepted Version or bucket/reference owner changes.
 */
export interface V2ObjectBucketBindingResolution {
  readonly identity: SelfhostV2ObjectBucketIdentity;
  readonly vector: string;
}

export interface SelfhostV2ObjectBucketBindingBrokerOptions {
  readonly store: SelfhostV2ObjectBucketStore;
  readonly targetKey: string;
  /** Stable operator-managed key; never generated or projected into tenant code. */
  readonly signingKey: Uint8Array;
  /** Exact native owner readback; caller claims are not native-state authority. */
  readonly observeVersionTarget: (input: {
    readonly workerUid: string;
    readonly workerVersionUid: string;
    readonly workerVersionOperationId: string;
    readonly versionId: string;
    readonly incarnationId: string;
    readonly servingSourceOperationId: string;
  }) => Promise<V2ObjectBucketSelectedVersionObservation | { readonly kind: "unknown" }>;
  /** Core-owned sealed Version reference + current settled bucket ownership proof. */
  readonly resolveCurrentBucketBinding: (
    grant: V2ObjectBucketBindingGrant,
    binding: string,
  ) => Promise<V2ObjectBucketBindingResolution | null>;
}

/**
 * Host-private edge.objects transport for v2 UID-owned ObjectBuckets. This is
 * not a public route by itself: the Host must mount it only on its private
 * workerd data-plane listener. A grant alone is insufficient; each request
 * rechecks both native incarnation status and the current Core binding proof.
 */
export function createSelfhostV2ObjectBucketBindingBroker(
  options: SelfhostV2ObjectBucketBindingBrokerOptions,
) {
  if (
    !options?.store ||
    typeof options.targetKey !== "string" ||
    options.targetKey.length === 0 ||
    !(options.signingKey instanceof Uint8Array) ||
    options.signingKey.byteLength < 32 ||
    typeof options.observeVersionTarget !== "function" ||
    typeof options.resolveCurrentBucketBinding !== "function"
  ) {
    throw new TypeError("private ObjectBucket binding authority is required");
  }
  const key = Buffer.from(options.signingKey);
  const targetKey = options.targetKey;

  function issueGrant(input: V2ObjectBucketBindingGrant): string {
    const grant = checkedGrant(input, targetKey);
    const payload = Buffer.from(JSON.stringify(grant)).toString("base64url");
    const signature = createHmac("sha256", key).update(payload).digest("base64url");
    return `${payload}.${signature}`;
  }

  function authenticate(request: Request): V2ObjectBucketBindingGrant | null {
    const header = request.headers.get("authorization");
    if (!header?.startsWith("Bearer ") || header.length > MAX_TOKEN_LENGTH) return null;
    const [payload, offered, ...extra] = header.slice(7).split(".");
    if (!payload || !offered || extra.length || !/^[A-Za-z0-9_-]+$/u.test(payload)) return null;
    let bytes: Buffer;
    let signature: Buffer;
    try {
      bytes = Buffer.from(payload, "base64url");
      if (bytes.toString("base64url") !== payload) return null;
      signature = Buffer.from(offered, "base64url");
    } catch {
      return null;
    }
    const expected = createHmac("sha256", key).update(payload).digest();
    if (
      signature.length !== expected.length ||
      signature.toString("base64url") !== offered ||
      !timingSafeEqual(signature, expected)
    ) {
      return null;
    }
    try {
      return checkedGrant(
        JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)),
        targetKey,
      );
    } catch {
      return null;
    }
  }

  async function resolveCurrent(
    grant: V2ObjectBucketBindingGrant,
    binding: string,
  ): Promise<V2ObjectBucketBindingResolution | null> {
    if (!grant.bindings.some((entry) => entry.name === binding)) return null;
    const native = await options.observeVersionTarget({
      workerUid: grant.workerUid,
      workerVersionUid: grant.workerVersionUid,
      workerVersionOperationId: grant.workerVersionOperationId,
      versionId: grant.nativeVersionId,
      incarnationId: grant.incarnationId,
      servingSourceOperationId: grant.servingSourceOperationId,
    });
    if (
      native.kind !== "confirmed" ||
      native.workerUid !== grant.workerUid ||
      native.workerVersionUid !== grant.workerVersionUid ||
      native.workerVersionOperationId !== grant.workerVersionOperationId ||
      native.versionId !== grant.nativeVersionId ||
      native.incarnationId !== grant.incarnationId ||
      native.servingSourceOperationId !== grant.servingSourceOperationId ||
      (native.status !== "active" && native.status !== "draining")
    ) {
      return null;
    }
    const resolution = await options.resolveCurrentBucketBinding(grant, binding);
    if (!resolution || !validResolution(resolution, grant, binding)) return null;
    return resolution;
  }

  async function stillCurrent(
    grant: V2ObjectBucketBindingGrant,
    binding: string,
    captured: V2ObjectBucketBindingResolution,
  ): Promise<boolean> {
    try {
      const latest = await resolveCurrent(grant, binding);
      return Boolean(
        latest &&
          latest.vector === captured.vector &&
          sameIdentity(latest.identity, captured.identity),
      );
    } catch {
      return false;
    }
  }

  async function routes(request: Request, url: URL): Promise<Response | null> {
    if (url.pathname !== SELFHOST_DATA_PLANE_OBJECTS_PATH) return null;
    if (request.method !== "POST") return refusal("backend_unavailable", 405);
    const grant = authenticate(request);
    if (!grant) return refusal("backend_unavailable", 401);
    let document: ObjectDocument;
    try {
      document = parseObjectDocument(
        request.headers.get(SELFHOST_DATA_PLANE_OBJECT_REQUEST_HEADER),
      );
    } catch {
      return refusal("backend_unavailable", 400);
    }
    const binding = document.binding;
    if (!grant.bindings.some((entry) => entry.name === binding)) {
      return objectRefusal("backend_unavailable", 404);
    }
    const resolution = await resolveCurrent(grant, binding).catch(() => null);
    if (!resolution) return objectRefusal("backend_unavailable", 200);
    const bucket = await options.store.openBucket(resolution.identity).catch(() => null);
    if (!bucket) return objectRefusal("backend_unavailable", 200);
    const valid = () => stillCurrent(grant, binding, resolution);
    try {
      if (!(await valid())) return objectRefusal("backend_unavailable", 200);
      const response = await operate(bucket, document, request, valid);
      // A response body is guarded for its whole lifetime; metadata-only
      // responses are revalidated here before they cross the private service.
      if (!(await valid())) {
        void response.body?.cancel().catch(() => undefined);
        return objectRefusal("backend_unavailable", 200);
      }
      if (
        response.body &&
        response.headers.get("content-type") === SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE
      ) {
        return new Response(guardStream(response.body, valid), {
          status: response.status,
          headers: response.headers,
        });
      }
      return response;
    } catch (error) {
      const code = error instanceof SelfhostObjectError ? error.code : "backend_unavailable";
      return objectRefusal(code, 200);
    }
  }

  async function handle(request: Request): Promise<Response | null> {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return null;
    }
    if (url.pathname !== SELFHOST_DATA_PLANE_OBJECTS_PATH) return null;
    try {
      return await routes(request, url);
    } catch {
      // Once this broker claims the private path, it must fail closed rather
      // than let a legacy route interpret the same request.
      return objectRefusal("backend_unavailable", 200);
    }
  }

  return Object.freeze({ issueGrant, handle, routes });
}

interface ObjectDocument {
  readonly binding: string;
  readonly op: string;
  readonly fields: Readonly<Record<string, unknown>>;
}

function checkedGrant(input: unknown, targetKey: string): V2ObjectBucketBindingGrant {
  const expected =
    "bindings,incarnationId,nativeVersionId,principal,servingSourceOperationId,space,targetKey,workerUid,workerVersionOperationId,workerVersionUid";
  if (!record(input) || Object.keys(input).sort().join(",") !== expected) {
    throw new TypeError("invalid ObjectBucket binding grant");
  }
  for (const field of [
    "principal",
    "space",
    "targetKey",
    "workerUid",
    "workerVersionUid",
    "workerVersionOperationId",
    "nativeVersionId",
    "incarnationId",
    "servingSourceOperationId",
  ] as const) {
    if (typeof input[field] !== "string" || input[field].length < 1 || input[field].length > 256) {
      throw new TypeError("invalid ObjectBucket binding identity");
    }
  }
  for (const field of [
    "workerUid",
    "workerVersionUid",
    "workerVersionOperationId",
    "servingSourceOperationId",
  ] as const) {
    if (!UID.test(input[field] as string)) throw new TypeError("invalid ObjectBucket binding UID");
  }
  if (
    input.targetKey !== targetKey ||
    !Array.isArray(input.bindings) ||
    input.bindings.length < 1 ||
    input.bindings.length > 64
  ) {
    throw new TypeError("invalid ObjectBucket binding target");
  }
  const names = new Set<string>();
  const bindings = input.bindings.map((entry) => {
    if (
      !record(entry) ||
      Object.keys(entry).sort().join(",") !== "name,resourceUid" ||
      typeof entry.name !== "string" ||
      !BINDING.test(entry.name) ||
      typeof entry.resourceUid !== "string" ||
      !UID.test(entry.resourceUid) ||
      names.has(entry.name)
    ) {
      throw new TypeError("invalid ObjectBucket binding declaration");
    }
    names.add(entry.name);
    return Object.freeze({ name: entry.name, resourceUid: entry.resourceUid });
  });
  bindings.sort((left, right) => left.name.localeCompare(right.name));
  return Object.freeze({
    principal: input.principal as string,
    space: input.space as string,
    targetKey: input.targetKey as string,
    workerUid: input.workerUid as string,
    workerVersionUid: input.workerVersionUid as string,
    workerVersionOperationId: input.workerVersionOperationId as string,
    nativeVersionId: input.nativeVersionId as string,
    incarnationId: input.incarnationId as string,
    servingSourceOperationId: input.servingSourceOperationId as string,
    bindings: Object.freeze(bindings),
  });
}

function parseObjectDocument(raw: string | null): ObjectDocument {
  if (raw === null || raw.length === 0 || raw.length > MAX_SELFHOST_OBJECT_DOCUMENT_BYTES) {
    throw new TypeError("invalid object document");
  }
  const bytes = Buffer.from(raw, "base64url");
  if (bytes.toString("base64url") !== raw) throw new TypeError("invalid object document");
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!record(parsed) || parsed.protocol !== SELFHOST_DATA_PLANE_OBJECT_PROTOCOL) {
    throw new TypeError("invalid object document");
  }
  const binding = parsed.binding;
  const op = parsed.op;
  if (typeof binding !== "string" || !BINDING.test(binding) || typeof op !== "string") {
    throw new TypeError("invalid object document");
  }
  const allowed = OBJECT_OPERATION_FIELDS[op];
  if (!allowed) throw new TypeError("invalid object operation");
  const fields: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [name, value] of Object.entries(parsed)) {
    if (name === "protocol" || name === "binding" || name === "op") continue;
    if (!allowed.includes(name)) throw new TypeError("unexpected object field");
    fields[name] = value;
  }
  if (allowed.includes("key") && !Object.hasOwn(fields, "key")) {
    throw new TypeError("object key missing");
  }
  return { binding, op, fields };
}

async function operate(
  bucket: SelfhostV2ObjectBucketAccess,
  document: ObjectDocument,
  request: Request,
  valid: () => Promise<boolean>,
): Promise<Response> {
  const fields = document.fields;
  switch (document.op) {
    case "head": {
      const metadata = await bucket.head(stringField(fields.key));
      return answer(metadata ? { found: true, ...metadata } : { found: false });
    }
    case "get": {
      const body = await bucket.get(stringField(fields.key), {
        ...(fields.range === undefined ? {} : { range: rangeField(fields.range) }),
        ...(fields.ifMatch === undefined ? {} : { ifMatch: stringField(fields.ifMatch) }),
        ...(fields.ifNoneMatch === undefined
          ? {}
          : { ifNoneMatch: stringField(fields.ifNoneMatch) }),
      });
      if (!body) return answer({ found: false });
      return new Response(body.body, {
        status: 200,
        headers: {
          "content-type": SELFHOST_DATA_PLANE_OBJECT_CONTENT_TYPE,
          [SELFHOST_DATA_PLANE_OBJECT_RESULT_HEADER]: encodeObjectDocument({
            etag: body.etag,
            size: body.size,
            ...(body.contentType === undefined ? {} : { contentType: body.contentType }),
            partial: body.partial,
            ...(body.range === undefined ? {} : { range: body.range }),
          }),
        },
      });
    }
    case "put": {
      const body = guardedRequestBody(request.body ?? new Blob([]).stream(), valid);
      const result = await bucket.put(stringField(fields.key), body, {
        contentLength: lengthField(fields.contentLength),
        ...(fields.contentType === undefined
          ? {}
          : { contentType: stringField(fields.contentType) }),
        ...(fields.ifMatch === undefined ? {} : { ifMatch: stringField(fields.ifMatch) }),
        ...(fields.ifNoneMatch === undefined ? {} : { ifNoneMatch: anyField(fields.ifNoneMatch) }),
      });
      return answer(result);
    }
    case "delete":
      await bucket.delete(stringField(fields.key));
      return answer({});
    case "list": {
      const page = await bucket.list({
        ...(fields.prefix === undefined ? {} : { prefix: stringField(fields.prefix) }),
        ...(fields.delimiter === undefined ? {} : { delimiter: stringField(fields.delimiter) }),
        ...(fields.cursor === undefined ? {} : { cursor: stringField(fields.cursor) }),
        ...(fields.limit === undefined ? {} : { limit: lengthField(fields.limit) }),
      });
      return answer(page);
    }
    case "createMultipartUpload":
      return answer(
        await bucket.createMultipartUpload(stringField(fields.key), {
          ...(fields.contentType === undefined
            ? {}
            : { contentType: stringField(fields.contentType) }),
        }),
      );
    case "uploadPart": {
      const body = guardedRequestBody(request.body ?? new Blob([]).stream(), valid);
      return answer(
        await bucket.uploadPart(
          stringField(fields.key),
          stringField(fields.uploadId),
          lengthField(fields.partNumber),
          body,
          { contentLength: lengthField(fields.contentLength) },
        ),
      );
    }
    case "completeMultipartUpload":
      return answer(
        await bucket.completeMultipartUpload(
          stringField(fields.key),
          stringField(fields.uploadId),
          partsField(fields.parts),
        ),
      );
    case "abortMultipartUpload":
      await bucket.abortMultipartUpload(stringField(fields.key), stringField(fields.uploadId));
      return answer({});
    default:
      return objectRefusal("backend_unavailable", 400);
  }
}

function guardedRequestBody(source: ReadableStream<Uint8Array>, valid: () => Promise<boolean>) {
  return guardStream(source, valid);
}

function guardStream(
  source: ReadableStream<Uint8Array>,
  valid: () => Promise<boolean>,
): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!(await valid())) {
        cancelReader(reader);
        controller.error(new SelfhostObjectError("backend_unavailable"));
        return;
      }
      try {
        const next = await reader.read();
        if (next.done) {
          if (!(await valid())) {
            controller.error(new SelfhostObjectError("backend_unavailable"));
          } else controller.close();
          return;
        }
        if (!(await valid())) {
          cancelReader(reader);
          controller.error(new SelfhostObjectError("backend_unavailable"));
          return;
        }
        controller.enqueue(next.value);
      } catch {
        controller.error(new SelfhostObjectError("backend_unavailable"));
      }
    },
    cancel(reason) {
      cancelReader(reader, reason);
    },
  });
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>, reason?: unknown): void {
  try {
    void reader.cancel(reason).catch(() => undefined);
  } catch {
    // A cancellation failure must not expose a transport-specific exception.
  }
}

function validResolution(
  resolution: V2ObjectBucketBindingResolution,
  grant: V2ObjectBucketBindingGrant,
  binding: string,
): boolean {
  const expected = grant.bindings.find((entry) => entry.name === binding);
  return Boolean(
    expected &&
      typeof resolution.vector === "string" &&
      resolution.vector.length > 0 &&
      resolution.identity.targetKey === grant.targetKey &&
      resolution.identity.principal === grant.principal &&
      resolution.identity.space === grant.space &&
      resolution.identity.resourceUid === expected.resourceUid,
  );
}

function sameIdentity(
  left: SelfhostV2ObjectBucketIdentity,
  right: SelfhostV2ObjectBucketIdentity,
): boolean {
  return (
    left.targetKey === right.targetKey &&
    left.principal === right.principal &&
    left.space === right.space &&
    left.resourceUid === right.resourceUid
  );
}

function encodeObjectDocument(value: Record<string, unknown>): string {
  const encoded = Buffer.from(JSON.stringify(value)).toString("base64url");
  if (encoded.length > MAX_SELFHOST_OBJECT_DOCUMENT_BYTES) {
    throw new SelfhostObjectError("backend_unavailable");
  }
  return encoded;
}

function answer(value: unknown): Response {
  return Response.json(
    { ok: true, value },
    {
      headers: { "content-type": SELFHOST_DATA_PLANE_CONTENT_TYPE },
    },
  );
}

function objectRefusal(code: string, status: number): Response {
  return Response.json(
    { ok: false, error: { code } },
    {
      status,
      headers: { "content-type": SELFHOST_DATA_PLANE_CONTENT_TYPE },
    },
  );
}

function refusal(code: string, status: number): Response {
  return objectRefusal(code, status);
}

function stringField(value: unknown): string {
  if (typeof value !== "string") throw new SelfhostObjectError("backend_unavailable");
  return value;
}

function lengthField(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new SelfhostObjectError("invalid_body");
  }
  return value;
}

function anyField(value: unknown): "*" {
  if (value !== "*") throw new SelfhostObjectError("backend_unavailable");
  return "*";
}

function rangeField(value: unknown): { readonly offset: number; readonly length?: number } {
  if (!record(value) || Object.keys(value).some((key) => key !== "offset" && key !== "length")) {
    throw new SelfhostObjectError("range_not_satisfiable");
  }
  if (
    typeof value.offset !== "number" ||
    !Number.isSafeInteger(value.offset) ||
    value.offset < 0 ||
    (value.length !== undefined &&
      (typeof value.length !== "number" || !Number.isSafeInteger(value.length) || value.length < 1))
  ) {
    throw new SelfhostObjectError("range_not_satisfiable");
  }
  return {
    offset: value.offset,
    ...(value.length === undefined ? {} : { length: value.length as number }),
  };
}

function partsField(
  value: unknown,
): readonly { readonly etag: string; readonly partNumber: number }[] {
  if (!Array.isArray(value)) throw new SelfhostObjectError("invalid_part");
  return value.map((entry) => {
    if (
      !record(entry) ||
      Object.keys(entry).sort().join(",") !== "etag,partNumber" ||
      typeof entry.etag !== "string" ||
      typeof entry.partNumber !== "number" ||
      !Number.isSafeInteger(entry.partNumber)
    ) {
      throw new SelfhostObjectError("invalid_part");
    }
    return { etag: entry.etag, partNumber: entry.partNumber };
  });
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
