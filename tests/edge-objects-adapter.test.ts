import { describe, expect, test } from "bun:test";
import {
  createPrivateS3EdgeObjects,
  createR2EdgeObjects,
  type EdgeObjects,
  type EdgeObjectsR2Bucket,
  type EdgeObjectsR2MultipartUpload,
  type EdgeObjectsR2Object,
  type EdgeObjectsR2ObjectBody,
} from "../src/providers/edge-objects-adapter.ts";

const MAX_OBJECT_BYTES = 5_368_709_120;

interface StoredObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly contentType?: string;
  readonly uploaded: Date;
}

class MemoryStore {
  readonly objects = new Map<string, StoredObject>();
  readonly uploads = new Map<
    string,
    {
      readonly key: string;
      readonly parts: Map<number, StoredObject>;
      readonly contentType?: string;
    }
  >();
  sequence = 0;

  put(key: string, bytes: Uint8Array, contentType?: string): StoredObject {
    const object = {
      bytes,
      etag: `"etag-${++this.sequence}"`,
      ...(contentType ? { contentType } : {}),
      uploaded: new Date("2026-09-01T00:00:00.000Z"),
    };
    this.objects.set(key, object);
    return object;
  }
}

class MemoryR2 implements EdgeObjectsR2Bucket {
  constructor(
    readonly store = new MemoryStore(),
    readonly onComplete: () => void = () => {},
  ) {}

  async head(key: string): Promise<EdgeObjectsR2Object | null> {
    return this.project(key, this.store.objects.get(key));
  }

  async get(
    key: string,
    options?: {
      readonly range?: { readonly offset: number; readonly length?: number };
      readonly onlyIf?: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
    },
  ): Promise<EdgeObjectsR2ObjectBody | EdgeObjectsR2Object | null> {
    const found = this.store.objects.get(key);
    if (!found) return null;
    if (
      (options?.onlyIf?.etagMatches && options.onlyIf.etagMatches !== found.etag) ||
      (options?.onlyIf?.etagDoesNotMatch && options.onlyIf.etagDoesNotMatch === found.etag)
    ) {
      return this.project(key, found);
    }
    const offset = options?.range?.offset ?? 0;
    const length = Math.min(
      options?.range?.length ?? found.bytes.byteLength,
      found.bytes.byteLength - offset,
    );
    return {
      ...(this.project(key, found) as EdgeObjectsR2Object),
      ...(options?.range ? { range: { offset, length } } : {}),
      body: new Blob([found.bytes.slice(offset, offset + length)]).stream(),
    };
  }

  async put(
    key: string,
    body: ReadableStream<Uint8Array>,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly onlyIf?: { readonly etagMatches?: string; readonly etagDoesNotMatch?: string };
    },
  ): Promise<EdgeObjectsR2Object | null> {
    const current = this.store.objects.get(key);
    if (
      (options?.onlyIf?.etagMatches && current?.etag !== options.onlyIf.etagMatches) ||
      (options?.onlyIf?.etagDoesNotMatch === "*" && current)
    ) {
      return null;
    }
    const stored = this.store.put(key, await bytes(body), options?.httpMetadata?.contentType);
    return this.project(key, stored);
  }

  async delete(key: string): Promise<void> {
    this.store.objects.delete(key);
  }

  async list(options?: {
    readonly prefix?: string;
    readonly delimiter?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }) {
    if (options?.cursor && !/^\d+$/u.test(options.cursor)) named("invalid_cursor");
    const all = [...this.store.objects.entries()]
      .filter(([key]) => key.startsWith(options?.prefix ?? ""))
      .sort(([left], [right]) => left.localeCompare(right));
    const start = options?.cursor ? Number(options.cursor) : 0;
    const limit = options?.limit ?? 1_000;
    const page = all.slice(start, start + limit);
    const truncated = start + page.length < all.length;
    return {
      objects: page.map(([key, value]) => this.project(key, value) as EdgeObjectsR2Object),
      truncated,
      ...(truncated ? { cursor: String(start + page.length) } : {}),
    };
  }

  async createMultipartUpload(
    key: string,
    options?: { readonly httpMetadata?: { readonly contentType?: string } },
  ): Promise<EdgeObjectsR2MultipartUpload> {
    const uploadId = `upload-${++this.store.sequence}`;
    this.store.uploads.set(uploadId, {
      key,
      parts: new Map(),
      ...(options?.httpMetadata?.contentType
        ? { contentType: options.httpMetadata.contentType }
        : {}),
    });
    return this.resumeMultipartUpload(key, uploadId);
  }

  resumeMultipartUpload(key: string, uploadId: string): EdgeObjectsR2MultipartUpload {
    const store = this.store;
    const onComplete = this.onComplete;
    return {
      uploadId,
      async uploadPart(partNumber, body) {
        const upload = store.uploads.get(uploadId);
        if (!upload || upload.key !== key) named("upload_not_found");
        const part = store.put(`part:${uploadId}:${partNumber}`, await bytes(body));
        upload.parts.set(partNumber, part);
        return { etag: part.etag };
      },
      async complete(parts) {
        onComplete();
        const upload = store.uploads.get(uploadId);
        if (!upload || upload.key !== key) named("upload_not_found");
        const chunks = parts.map((part) => {
          const found = upload.parts.get(part.partNumber);
          if (!found || found.etag !== part.etag) named("invalid_part");
          return found.bytes;
        });
        const stored = store.put(key, concat(chunks), upload.contentType);
        store.uploads.delete(uploadId);
        return {
          key,
          size: stored.bytes.byteLength,
          httpEtag: stored.etag,
          uploaded: stored.uploaded,
        };
      },
      async abort() {
        if (!store.uploads.delete(uploadId)) named("upload_not_found");
      },
    };
  }

  private project(key: string, value: StoredObject | undefined): EdgeObjectsR2Object | null {
    return value
      ? {
          key,
          size: value.bytes.byteLength,
          httpEtag: value.etag,
          uploaded: value.uploaded,
          ...(value.contentType ? { httpMetadata: { contentType: value.contentType } } : {}),
        }
      : null;
  }
}

class MemoryS3 {
  readonly store = new MemoryStore();
  readonly calls: Request[] = [];

  constructor(readonly onComplete: () => void = () => {}) {}

  fetch = async (request: Request): Promise<Response> => {
    this.calls.push(request.clone());
    expect(request.headers.get("authorization")).toStartWith("AWS4-HMAC-SHA256 Credential=AKID/");
    const url = new URL(request.url);
    const key = decodeURIComponent(url.pathname.replace(/^\/private-bucket\/?/u, ""));
    const uploadId = url.searchParams.get("uploadId");
    const partNumber = Number(url.searchParams.get("partNumber"));
    if (request.method === "POST" && url.searchParams.has("uploads")) {
      const id = `upload-${++this.store.sequence}`;
      this.store.uploads.set(id, {
        key,
        parts: new Map(),
        ...(request.headers.get("content-type")
          ? { contentType: request.headers.get("content-type") as string }
          : {}),
      });
      return xml(
        200,
        `<InitiateMultipartUploadResult><UploadId>${id}</UploadId></InitiateMultipartUploadResult>`,
      );
    }
    if (request.method === "PUT" && uploadId) {
      const upload = this.store.uploads.get(uploadId);
      if (!upload || upload.key !== key) return new Response(null, { status: 404 });
      const stored = this.store.put(`part:${uploadId}:${partNumber}`, await requestBytes(request));
      upload.parts.set(partNumber, stored);
      return new Response(null, { status: 200, headers: { etag: stored.etag } });
    }
    if (request.method === "POST" && uploadId) {
      this.onComplete();
      const upload = this.store.uploads.get(uploadId);
      if (!upload || upload.key !== key) return new Response(null, { status: 404 });
      const document = await request.text();
      const parts = [
        ...document.matchAll(/<PartNumber>(\d+)<\/PartNumber><ETag>([^<]+)<\/ETag>/gu),
      ].map((match) => ({
        partNumber: Number(match[1]),
        etag: (match[2] as string).replaceAll("&quot;", '"'),
      }));
      const chunks = parts.map((part) => {
        const found = upload.parts.get(part.partNumber);
        if (!found || found.etag !== part.etag) named("invalid_part");
        return found.bytes;
      });
      const stored = this.store.put(key, concat(chunks), upload.contentType);
      this.store.uploads.delete(uploadId);
      return xml(
        200,
        `<CompleteMultipartUploadResult><ETag>${stored.etag}</ETag></CompleteMultipartUploadResult>`,
      );
    }
    if (request.method === "DELETE" && uploadId) {
      return new Response(null, { status: this.store.uploads.delete(uploadId) ? 204 : 404 });
    }
    if (request.method === "GET" && url.searchParams.get("list-type") === "2") {
      const prefix = url.searchParams.get("prefix") ?? "";
      const limit = Number(url.searchParams.get("max-keys") ?? "1000");
      const cursor = url.searchParams.get("continuation-token") ?? "0";
      if (!/^\d+$/u.test(cursor)) return new Response(null, { status: 400 });
      const start = Number(cursor);
      const all = [...this.store.objects.entries()]
        .filter(([name]) => !name.startsWith("part:") && name.startsWith(prefix))
        .sort(([left], [right]) => left.localeCompare(right));
      const page = all.slice(start, start + limit);
      const truncated = start + page.length < all.length;
      return xml(
        200,
        `<ListBucketResult><IsTruncated>${truncated}</IsTruncated>${page
          .map(
            ([name, value]) =>
              `<Contents><Key>${name}</Key><ETag>${value.etag}</ETag><Size>${value.bytes.byteLength}</Size><LastModified>${value.uploaded.toISOString()}</LastModified></Contents>`,
          )
          .join(
            "",
          )}${truncated ? `<NextContinuationToken>${start + page.length}</NextContinuationToken>` : ""}</ListBucketResult>`,
      );
    }
    const current = this.store.objects.get(key);
    if (request.method === "HEAD")
      return current ? objectResponse(current) : new Response(null, { status: 404 });
    if (request.method === "PUT") {
      if (request.headers.get("if-none-match") === "*" && current) {
        return new Response(null, { status: 412 });
      }
      const stored = this.store.put(
        key,
        await requestBytes(request),
        request.headers.get("content-type") ?? undefined,
      );
      return new Response(null, { status: 200, headers: { etag: stored.etag } });
    }
    if (request.method === "GET") {
      if (!current) return new Response(null, { status: 404 });
      const ifMatch = request.headers.get("if-match");
      if (ifMatch && ifMatch !== current.etag) return new Response(null, { status: 412 });
      const range = /^bytes=(\d+)-(\d*)$/u.exec(request.headers.get("range") ?? "");
      if (range) {
        const offset = Number(range[1]);
        if (offset >= current.bytes.byteLength) return new Response(null, { status: 416 });
        const end = range[2]
          ? Math.min(Number(range[2]), current.bytes.byteLength - 1)
          : current.bytes.byteLength - 1;
        const body = current.bytes.slice(offset, end + 1);
        return new Response(Uint8Array.from(body).buffer, {
          status: 206,
          headers: {
            etag: current.etag,
            "content-length": String(body.byteLength),
            "content-range": `bytes ${offset}-${end}/${current.bytes.byteLength}`,
            "last-modified": current.uploaded.toUTCString(),
          },
        });
      }
      return new Response(Uint8Array.from(current.bytes).buffer, {
        status: 200,
        headers: objectHeaders(current),
      });
    }
    if (request.method === "DELETE") {
      this.store.objects.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response(null, { status: 500 });
  };
}

for (const [name, factory] of [
  [
    "Cloudflare R2",
    (onComplete: () => void = () => {}) =>
      createR2EdgeObjects(new MemoryR2(new MemoryStore(), onComplete)),
  ],
  [
    "private S3",
    (onComplete: () => void = () => {}) => {
      const backend = new MemoryS3(onComplete);
      return createPrivateS3EdgeObjects({
        endpoint: "https://s3.internal.test",
        bucketName: "private-bucket",
        region: "ap-northeast-1",
        credentials: { accessKeyId: "AKID", secretAccessKey: "private-secret" },
        fetch: backend.fetch,
        now: () => new Date("2026-09-01T00:00:00.000Z"),
      });
    },
  ],
] as const) {
  describe(`${name} edge.objects binding conformance`, () => {
    test("implements all nine operations without exposing provider supply", async () => {
      const objects: EdgeObjects = factory();
      expect(Object.keys(objects).sort()).toEqual([
        "abortMultipartUpload",
        "completeMultipartUpload",
        "createMultipartUpload",
        "delete",
        "get",
        "head",
        "list",
        "put",
        "uploadPart",
      ]);
      expect(objects.uploadPart.length).toBe(5);
      expect(JSON.stringify(objects)).not.toMatch(/endpoint|bucketName|accessKey|secret/u);

      const put = await objects.put("reports/summary.txt", "abcdefgh", {
        contentLength: 8,
        contentType: "text/plain",
        ifNoneMatch: "*",
      });
      expect(put.size).toBe(8);
      expect(await objects.head("reports/summary.txt")).toMatchObject({
        etag: put.etag,
        size: 8,
        contentType: "text/plain",
      });
      await expect(
        objects.put("reports/summary.txt", "replacement", { ifNoneMatch: "*" }),
      ).rejects.toMatchObject({ name: "precondition_failed" });
      const ranged = await objects.get("reports/summary.txt", {
        range: { offset: 2, length: 3 },
      });
      expect(ranged).toMatchObject({ partial: true, range: { offset: 2, length: 3 }, size: 8 });
      expect(ranged).not.toHaveProperty("bodyStream");
      expect(ranged).not.toHaveProperty("uploadedAtMillis");
      expect(await streamText(ranged?.body)).toBe("cde");

      const listed = await objects.list({ prefix: "reports/", limit: 1 });
      expect(listed.objects.map((item) => item.key)).toEqual(["reports/summary.txt"]);
      expect(listed.prefixes).toEqual([]);
      expect(listed.objects[0]).not.toHaveProperty("contentType");

      const upload = await objects.createMultipartUpload("multipart.bin", {
        contentType: "application/octet-stream",
      });
      const first = await objects.uploadPart("multipart.bin", upload.uploadId, 1, "hello world", {
        contentLength: 11,
      });
      const complete = await objects.completeMultipartUpload("multipart.bin", upload.uploadId, [
        first,
      ]);
      expect(complete.size).toBe(11);
      expect(await streamText((await objects.get("multipart.bin"))?.body)).toBe("hello world");

      const abandoned = await objects.createMultipartUpload("abandoned.bin");
      await objects.abortMultipartUpload("abandoned.bin", abandoned.uploadId);
      await objects.delete("reports/summary.txt");
      expect(await objects.head("reports/summary.txt")).toBeNull();
    });

    test("requires and enforces exact stream lengths without storing a partial object", async () => {
      const objects: EdgeObjects = factory();

      const written = await objects.put("stream.bin", bodyStream("stream"), {
        contentLength: 6,
      });
      expect(written.size).toBe(6);
      expect(await streamText((await objects.get("stream.bin"))?.body)).toBe("stream");

      await expect(objects.put("missing-length.bin", bodyStream("body"))).rejects.toMatchObject({
        name: "invalid_body",
      });
      expect(await objects.head("missing-length.bin")).toBeNull();

      await expect(
        objects.put("undefined-length.bin", "body", { contentLength: undefined } as never),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.put("undefined-stream-length.bin", bodyStream("body"), {
          contentLength: undefined,
        } as never),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await objects.head("undefined-length.bin")).toBeNull();
      expect(await objects.head("undefined-stream-length.bin")).toBeNull();

      await expect(
        objects.put("intrinsic-mismatch.bin", "body", { contentLength: 5 }),
      ).rejects.toMatchObject({ name: "invalid_body" });
      expect(await objects.head("intrinsic-mismatch.bin")).toBeNull();

      await expect(
        objects.put("array-buffer-mismatch.bin", new TextEncoder().encode("body").buffer, {
          contentLength: 5,
        }),
      ).rejects.toMatchObject({ name: "invalid_body" });
      expect(await objects.head("array-buffer-mismatch.bin")).toBeNull();

      await expect(
        objects.put("short-stream.bin", bodyStream("short"), { contentLength: 6 }),
      ).rejects.toMatchObject({ name: "invalid_body" });
      expect(await objects.head("short-stream.bin")).toBeNull();

      await expect(
        objects.put("long-stream.bin", bodyStream("longer"), { contentLength: 5 }),
      ).rejects.toMatchObject({ name: "invalid_body" });
      expect(await objects.head("long-stream.bin")).toBeNull();

      const upload = await objects.createMultipartUpload("stream-part.bin");
      await expect(
        objects.uploadPart("stream-part.bin", upload.uploadId, 1, bodyStream("part")),
      ).rejects.toMatchObject({ name: "invalid_body" });
      await expect(
        objects.uploadPart("stream-part.bin", upload.uploadId, 1, "part", {
          contentLength: undefined,
        } as never),
      ).rejects.toBeInstanceOf(TypeError);
      const part = await objects.uploadPart(
        "stream-part.bin",
        upload.uploadId,
        1,
        bodyStream("part"),
        { contentLength: 4 },
      );
      const complete = await objects.completeMultipartUpload("stream-part.bin", upload.uploadId, [
        part,
      ]);
      expect(complete.size).toBe(4);
      expect(await streamText((await objects.get("stream-part.bin"))?.body)).toBe("part");
    });

    test("rejects an undersized non-final part atomically while permitting a short final part", async () => {
      const objects: EdgeObjects = factory();
      await objects.put("multipart-fence.bin", "original");

      const singleUpload = await objects.createMultipartUpload("short-final.bin");
      const shortFinal = await objects.uploadPart(
        "short-final.bin",
        singleUpload.uploadId,
        1,
        "short",
      );
      const single = await objects.completeMultipartUpload(
        "short-final.bin",
        singleUpload.uploadId,
        [shortFinal],
      );
      expect(single.size).toBe(5);
      expect(await streamText((await objects.get("short-final.bin"))?.body)).toBe("short");

      const upload = await objects.createMultipartUpload("multipart-fence.bin");
      const first = await objects.uploadPart("multipart-fence.bin", upload.uploadId, 1, "short");
      const second = await objects.uploadPart("multipart-fence.bin", upload.uploadId, 2, "tail");
      await expect(
        objects.completeMultipartUpload("multipart-fence.bin", upload.uploadId, [first, second]),
      ).rejects.toMatchObject({ name: "invalid_part" });
      expect(await streamText((await objects.get("multipart-fence.bin"))?.body)).toBe("original");

      await expect(
        objects.completeMultipartUpload("multipart-fence.bin", upload.uploadId, [
          { ...first, etag: `${first.etag}-stale` },
        ]),
      ).rejects.toMatchObject({ name: "invalid_part" });
      expect(await streamText((await objects.get("multipart-fence.bin"))?.body)).toBe("original");
    });

    test("rejects a missing part before provider completion without changing the key", async () => {
      let providerCompletions = 0;
      const objects: EdgeObjects = factory(() => {
        providerCompletions += 1;
      });
      await objects.put("missing-part-fence.bin", "original");
      const upload = await objects.createMultipartUpload("missing-part-fence.bin");
      await objects.uploadPart("missing-part-fence.bin", upload.uploadId, 1, "known");

      await expect(
        objects.completeMultipartUpload("missing-part-fence.bin", upload.uploadId, [
          { etag: '"fabricated"', partNumber: 2 },
        ]),
      ).rejects.toMatchObject({ name: "invalid_part" });
      expect(providerCompletions).toBe(0);
      expect(await streamText((await objects.get("missing-part-fence.bin"))?.body)).toBe(
        "original",
      );
    });

    test("rejects a selected multipart total above 5 GiB before provider completion", async () => {
      if (name !== "Cloudflare R2") return;
      let providerCompletions = 0;
      const store = new MemoryStore();
      const bucket = new MemoryR2(store);
      const objects = createR2EdgeObjects(bucket);
      await objects.put("multipart-size-fence.bin", "original");
      const upload = await objects.createMultipartUpload("multipart-size-fence.bin");

      bucket.resumeMultipartUpload = () =>
        ({
          uploadId: upload.uploadId,
          async uploadPart(partNumber: number) {
            return { etag: `"part-${partNumber}"` };
          },
          async complete() {
            providerCompletions += 1;
            throw new Error("must not complete an oversized selection");
          },
          async abort() {},
        }) as never;

      const part1 = await objects.uploadPart(
        "multipart-size-fence.bin",
        upload.uploadId,
        1,
        unconsumedBody(),
        { contentLength: MAX_OBJECT_BYTES },
      );
      const part2 = await objects.uploadPart(
        "multipart-size-fence.bin",
        upload.uploadId,
        2,
        unconsumedBody(),
        { contentLength: 1 },
      );
      await expect(
        objects.completeMultipartUpload("multipart-size-fence.bin", upload.uploadId, [
          part1,
          part2,
        ]),
      ).rejects.toMatchObject({ name: "value_too_large", message: "value_too_large" });
      expect(providerCompletions).toBe(0);
      expect(await streamText((await objects.get("multipart-size-fence.bin"))?.body)).toBe(
        "original",
      );
    });

    test("maps an intrinsic upload part above 5 GiB to invalid_body before provider access", async () => {
      let providerUploads = 0;
      const bucket = new MemoryR2();
      const objects = createR2EdgeObjects(bucket);
      const upload = await objects.createMultipartUpload("intrinsic-size-fence.bin");
      bucket.resumeMultipartUpload = () =>
        ({
          uploadId: upload.uploadId,
          async uploadPart() {
            providerUploads += 1;
            return { etag: '"unexpected"' };
          },
          async complete() {
            return { httpEtag: '"unexpected"', size: 0 };
          },
          async abort() {},
        }) as never;
      const oversized = new ArrayBuffer(1);
      Object.defineProperty(oversized, "byteLength", { value: MAX_OBJECT_BYTES + 1 });
      await expect(
        objects.uploadPart("intrinsic-size-fence.bin", upload.uploadId, 1, oversized),
      ).rejects.toMatchObject({ name: "invalid_body", message: "invalid_body" });
      expect(providerUploads).toBe(0);
    });

    test("rejects noncanonical JavaScript arguments with TypeError before mutation", async () => {
      const objects: EdgeObjects = factory();
      await expect(
        objects.put("bad.bin", { bytes: "not a stream" } as never),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.put("unknown-option.bin", "body", { unknown: true } as never),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.get("bad-range-option.bin", {
          range: { offset: 0, unknown: true } as never,
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.put("bad-member-type.bin", "body", { contentType: 42 } as never),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(objects.list({ prefix: 42 } as never)).rejects.toBeInstanceOf(TypeError);
      await expect(objects.head(42 as never)).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.get("bad-range-member.bin", { range: { offset: "0" } } as never),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(objects.list({ delimiter: 42 } as never)).rejects.toBeInstanceOf(TypeError);
      await expect(objects.list({ limit: "10" } as never)).rejects.toBeInstanceOf(TypeError);
      await expect(objects.head("界".repeat(327))).rejects.toMatchObject({ name: "invalid_key" });
      await expect(objects.list({ prefix: "界".repeat(327) })).rejects.toBeInstanceOf(TypeError);
      await expect(objects.list({ delimiter: "d".repeat(17) })).rejects.toBeInstanceOf(TypeError);
      await expect(objects.list({ limit: 0 })).rejects.toBeInstanceOf(TypeError);
      await expect(objects.list({ limit: 1_001 })).rejects.toBeInstanceOf(TypeError);
      await expect(objects.list({ cursor: "c".repeat(4_097) })).rejects.toBeInstanceOf(TypeError);
      await expect(objects.list({ cursor: "unrecognized-valid-cursor" })).rejects.toMatchObject({
        name: "invalid_cursor",
      });
      await expect(
        objects.put("content-type-bound.bin", "body", { contentType: "x".repeat(257) }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.createMultipartUpload("multipart-content-type-bound.bin", {
          contentType: "x".repeat(257),
        }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.get("bad-range-bound.bin", { range: { offset: -1 } }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.get("bad-range-length-bound.bin", { range: { offset: 0, length: 0 } }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.get("bad-etag-bound.bin", { ifMatch: "e".repeat(257) }),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.put("bad-length-type.bin", "body", { contentLength: "4" } as never),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.put("bad-length-bound.bin", "body", { contentLength: -1 }),
      ).rejects.toMatchObject({ name: "invalid_body" });
      for (const contentLength of [
        Number.NaN,
        Number.POSITIVE_INFINITY,
        1.5,
        Number.MAX_SAFE_INTEGER,
        5_368_709_121,
      ]) {
        await expect(
          objects.put("bad-numeric-length.bin", bodyStream("body"), { contentLength }),
        ).rejects.toMatchObject({ name: "invalid_body" });
      }
      await expect(objects.uploadPart("part.bin", 42 as never, 1, "body")).rejects.toBeInstanceOf(
        TypeError,
      );
      await expect(
        objects.uploadPart("part.bin", "upload", "1" as never, "body"),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.completeMultipartUpload("part.bin", "upload", [
          { partNumber: "1", etag: "etag" } as never,
        ]),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.completeMultipartUpload("part.bin", "upload", [
          { partNumber: 1, etag: 42 } as never,
        ]),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.completeMultipartUpload("part.bin", "upload", [
          { partNumber: 1, etag: "etag", extra: true } as never,
        ]),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.completeMultipartUpload("part.bin", "upload", { partNumber: 1 } as never),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.completeMultipartUpload("part.bin", "upload", [
          { partNumber: 2, etag: "second" },
          { partNumber: 1, etag: "first" },
        ]),
      ).rejects.toMatchObject({ name: "invalid_part" });
      await expect(
        objects.completeMultipartUpload("part.bin", "upload", [
          { partNumber: 1, etag: "first" },
          { partNumber: 1, etag: "duplicate" },
        ]),
      ).rejects.toMatchObject({ name: "invalid_part" });
      await expect(
        objects.completeMultipartUpload("part.bin", "upload", [{ partNumber: 0, etag: "first" }]),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        objects.completeMultipartUpload("part.bin", "upload", [
          { partNumber: 1, etag: "e".repeat(257) },
        ]),
      ).rejects.toBeInstanceOf(TypeError);
      await expect(
        (objects.put as (...args: unknown[]) => Promise<unknown>)(
          "extra-argument.bin",
          "body",
          {},
          "extra",
        ),
      ).rejects.toBeInstanceOf(TypeError);
      expect(await objects.head("bad.bin")).toBeNull();
      expect(await objects.head("unknown-option.bin")).toBeNull();
      expect(await objects.head("bad-member-type.bin")).toBeNull();
      expect(await objects.head("extra-argument.bin")).toBeNull();
    });

    test("counts bounded text as Unicode code points while keys remain UTF-8 bytes", async () => {
      const objects: EdgeObjects = factory();
      await expect(objects.list({ delimiter: "😀".repeat(16) })).resolves.toMatchObject({
        prefixes: [],
      });
      await expect(objects.list({ delimiter: "😀".repeat(17) })).rejects.toBeInstanceOf(TypeError);
      await expect(objects.list({ cursor: "😀".repeat(4_096) })).rejects.toMatchObject({
        name: "invalid_cursor",
      });
      await expect(objects.list({ cursor: "😀".repeat(4_097) })).rejects.toBeInstanceOf(TypeError);

      expect(
        await rejectionName(
          objects.put("unicode-content-type.bin", "body", {
            contentType: "😀".repeat(256),
          }),
        ),
      ).not.toBe("TypeError");
      await expect(
        objects.put("unicode-content-type-bound.bin", "body", {
          contentType: "😀".repeat(257),
        }),
      ).rejects.toBeInstanceOf(TypeError);

      expect(
        await rejectionName(objects.get("unicode-etag.bin", { ifMatch: "😀".repeat(256) })),
      ).not.toBe("TypeError");
      await expect(
        objects.get("unicode-etag-bound.bin", { ifMatch: "😀".repeat(257) }),
      ).rejects.toBeInstanceOf(TypeError);

      const upload = await objects.createMultipartUpload("unicode-part-etag.bin");
      await objects.uploadPart("unicode-part-etag.bin", upload.uploadId, 1, "body");
      await expect(
        objects.completeMultipartUpload("unicode-part-etag.bin", upload.uploadId, [
          { etag: "😀".repeat(256), partNumber: 1 },
        ]),
      ).rejects.toMatchObject({ name: "invalid_part" });
      await expect(
        objects.completeMultipartUpload("unicode-part-etag.bin", upload.uploadId, [
          { etag: "😀".repeat(257), partNumber: 1 },
        ]),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });
}

test("provider-private adapters reject malformed range envelopes instead of leaking them", async () => {
  const r2 = new MemoryR2();
  const stored = r2.store.put("range.bin", new TextEncoder().encode("body"));
  r2.get = async () =>
    ({
      key: "range.bin",
      size: stored.bytes.byteLength,
      httpEtag: stored.etag,
      uploaded: stored.uploaded,
      body: new Blob([Uint8Array.from(stored.bytes).buffer]).stream(),
      range: { offset: 0, length: 1, suffix: 3 },
    }) as never;
  await expect(
    createR2EdgeObjects(r2).get("range.bin", { range: { offset: 0, length: 1 } }),
  ).rejects.toMatchObject({ name: "backend_unavailable" });

  const s3 = createPrivateS3EdgeObjects({
    endpoint: "https://s3.internal.test",
    bucketName: "private-bucket",
    region: "ap-northeast-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "private-secret" },
    fetch: async () =>
      new Response("body!", {
        status: 206,
        headers: {
          etag: '"etag"',
          "content-length": "5",
          "content-range": "bytes 0-4/4",
        },
      }),
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  await expect(s3.get("range.bin", { range: { offset: 0, length: 1 } })).rejects.toMatchObject({
    name: "backend_unavailable",
  });
});

test("provider-private adapters expose only errors declared by each operation", async () => {
  const misleading = () => {
    const error = new Error("provider-private wrong operation code");
    error.name = "invalid_part";
    throw error;
  };
  const r2 = new MemoryR2();
  r2.head = async () => misleading();
  await expect(createR2EdgeObjects(r2).head("key.bin")).rejects.toMatchObject({
    name: "backend_unavailable",
  });

  const multipartR2 = new MemoryR2();
  const multipart = createR2EdgeObjects(multipartR2);
  const upload = await multipart.createMultipartUpload("key.bin");
  multipartR2.resumeMultipartUpload = () =>
    ({
      async uploadPart() {
        return misleading();
      },
      async complete() {
        return misleading();
      },
      async abort() {
        return misleading();
      },
    }) as never;
  await expect(multipart.uploadPart("key.bin", upload.uploadId, 1, "body")).rejects.toMatchObject({
    name: "backend_unavailable",
  });

  const s3 = createPrivateS3EdgeObjects({
    endpoint: "https://s3.internal.test",
    bucketName: "private-bucket",
    region: "ap-northeast-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "private-secret" },
    fetch: async () => misleading(),
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  await expect(s3.head("key.bin")).rejects.toMatchObject({ name: "backend_unavailable" });
});

test("normalizes allowed provider errors to fresh exact-name errors", async () => {
  const source = new Error("provider secret: internal object id");
  source.name = "invalid_key";
  const bucket = new MemoryR2();
  bucket.head = async () => {
    throw source;
  };
  const error = await createR2EdgeObjects(bucket)
    .head("key.bin")
    .catch((value) => value);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBe(source);
  expect(error).toMatchObject({ name: "invalid_key", message: "invalid_key" });

  const transportSource = new Error("provider secret: signed request details");
  transportSource.name = "invalid_body";
  const s3 = createPrivateS3EdgeObjects({
    endpoint: "https://s3.internal.test",
    bucketName: "private-bucket",
    region: "ap-northeast-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "private-secret" },
    fetch: async () => {
      throw transportSource;
    },
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  const transportError = await s3.put("key.bin", "body").catch((value) => value);
  expect(transportError).toBeInstanceOf(Error);
  expect(transportError).not.toBe(transportSource);
  expect(transportError).toMatchObject({ name: "invalid_body", message: "invalid_body" });
});

test("private S3 preflights a selected multipart total above 5 GiB", async () => {
  let providerCompletions = 0;
  const backend = new MemoryS3();
  const nativeFetch = backend.fetch;
  backend.fetch = async (request) => {
    const url = new URL(request.url);
    if (request.method === "PUT" && url.searchParams.has("uploadId")) {
      return new Response(null, {
        status: 200,
        headers: { etag: `"part-${url.searchParams.get("partNumber")}"` },
      });
    }
    if (request.method === "POST" && url.searchParams.has("uploadId")) {
      providerCompletions += 1;
      return xml(
        200,
        '<CompleteMultipartUploadResult><ETag>"unexpected"</ETag></CompleteMultipartUploadResult>',
      );
    }
    return nativeFetch(request);
  };
  const objects = createPrivateS3EdgeObjects({
    endpoint: "https://s3.internal.test",
    bucketName: "private-bucket",
    region: "ap-northeast-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "private-secret" },
    fetch: backend.fetch,
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  await objects.put("private-multipart-size-fence.bin", "original");
  const upload = await objects.createMultipartUpload("private-multipart-size-fence.bin");
  const part1 = await objects.uploadPart(
    "private-multipart-size-fence.bin",
    upload.uploadId,
    1,
    unconsumedBody(),
    { contentLength: MAX_OBJECT_BYTES },
  );
  const part2 = await objects.uploadPart(
    "private-multipart-size-fence.bin",
    upload.uploadId,
    2,
    unconsumedBody(),
    { contentLength: 1 },
  );
  await expect(
    objects.completeMultipartUpload("private-multipart-size-fence.bin", upload.uploadId, [
      part1,
      part2,
    ]),
  ).rejects.toMatchObject({ name: "value_too_large", message: "value_too_large" });
  expect(providerCompletions).toBe(0);
  expect(await streamText((await objects.get("private-multipart-size-fence.bin"))?.body)).toBe(
    "original",
  );
});

test("private S3 metadata fails closed when content-length is absent", async () => {
  const make = (method: "HEAD" | "GET") =>
    createPrivateS3EdgeObjects({
      endpoint: "https://s3.internal.test",
      bucketName: "private-bucket",
      region: "ap-northeast-1",
      credentials: { accessKeyId: "AKID", secretAccessKey: "private-secret" },
      fetch: async () =>
        new Response(method === "GET" ? "body" : null, {
          status: 200,
          headers: { etag: '"etag"' },
        }),
      now: () => new Date("2026-09-01T00:00:00.000Z"),
    });

  await expect(make("HEAD").head("missing-length.bin")).rejects.toMatchObject({
    name: "backend_unavailable",
  });
  await expect(make("GET").get("missing-length.bin")).rejects.toMatchObject({
    name: "backend_unavailable",
  });

  const complete = createPrivateS3EdgeObjects({
    endpoint: "https://s3.internal.test",
    bucketName: "private-bucket",
    region: "ap-northeast-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "private-secret" },
    fetch: async (request) => {
      const url = new URL(request.url);
      if (request.method === "POST" && url.searchParams.has("uploadId")) {
        return xml(
          200,
          '<CompleteMultipartUploadResult><ETag>"etag"</ETag></CompleteMultipartUploadResult>',
        );
      }
      if (request.method === "HEAD")
        return new Response(null, { status: 200, headers: { etag: '"etag"' } });
      return new Response(null, { status: 500 });
    },
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  await expect(
    complete.completeMultipartUpload("missing-length.bin", "upload-1", [
      { etag: '"part"', partNumber: 1 },
    ]),
  ).rejects.toMatchObject({ name: "backend_unavailable" });
});

test("provider-private adapters reject malformed list framing", async () => {
  const r2 = new MemoryR2();
  r2.list = async () => ({ objects: [], truncated: 0 }) as never;
  await expect(createR2EdgeObjects(r2).list()).rejects.toMatchObject({
    name: "backend_unavailable",
  });

  const s3 = createPrivateS3EdgeObjects({
    endpoint: "https://s3.internal.test",
    bucketName: "private-bucket",
    region: "ap-northeast-1",
    credentials: { accessKeyId: "AKID", secretAccessKey: "private-secret" },
    fetch: async () =>
      new Response("<ListBucketResult><IsTruncated>maybe</IsTruncated></ListBucketResult>", {
        status: 200,
      }),
    now: () => new Date("2026-09-01T00:00:00.000Z"),
  });
  await expect(s3.list()).rejects.toMatchObject({ name: "backend_unavailable" });
});

function bodyStream(value: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoded);
      controller.close();
    },
  });
}

function unconsumedBody(): ReadableStream<Uint8Array> {
  return new ReadableStream({});
}

async function rejectionName(value: Promise<unknown>): Promise<string | null> {
  try {
    await value;
    return null;
  } catch (error) {
    return error instanceof Error ? error.name : "non_error";
  }
}

async function requestBytes(request: Request): Promise<Uint8Array> {
  return new Uint8Array(await request.arrayBuffer());
}

async function bytes(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function streamText(stream: ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!stream) throw new Error("missing body stream");
  return await new Response(stream).text();
}

function concat(chunks: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(chunks.reduce((total, chunk) => total + chunk.byteLength, 0));
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function objectHeaders(value: StoredObject): HeadersInit {
  return {
    etag: value.etag,
    "content-length": String(value.bytes.byteLength),
    "last-modified": value.uploaded.toUTCString(),
    ...(value.contentType ? { "content-type": value.contentType } : {}),
  };
}

function objectResponse(value: StoredObject): Response {
  return new Response(null, { status: 200, headers: objectHeaders(value) });
}

function xml(status: number, body: string): Response {
  return new Response(body, { status, headers: { "content-type": "application/xml" } });
}

function named(name: string): never {
  const error = new Error(name);
  error.name = name;
  throw error;
}
