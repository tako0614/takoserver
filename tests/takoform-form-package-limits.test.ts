import { describe, expect, test } from "bun:test";
import { bytesDigest, canonicalDigest, canonicalJson } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { JsonObject, StoredObjectBody } from "../src/ports.ts";
import {
  drainBoundedFormPackageStream,
  FORM_PACKAGE_LIMITS,
  FormPackageStreamLimitError,
  formPackagePayloadLimit,
  formPackagePayloadTotal,
  readBoundedFormPackageStream,
} from "../src/takoform/form-package-limits.ts";
import {
  createFormPackageReader,
  readOnlyFormPackageKey,
  readOnlyFormPackagePrefix,
} from "../src/takoform/form-package-reader.ts";
import {
  createFormPackageStore,
  type FormPackageInput,
  formPackageKey,
  packageManifest,
} from "../src/takoform/form-packages.ts";

const FORM_REF = {
  apiVersion: "example.forms.test/v1alpha1",
  kind: "Widget",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;

const ZERO_DIGEST = `sha256:${"0".repeat(64)}` as const;

describe("portable Form Package limits", () => {
  test("rejects an index stream over 4 MiB before parsing or buffering it", async () => {
    const packageDigest = `sha256:${"1".repeat(64)}` as const;
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(FORM_PACKAGE_LIMITS.indexBytes + 1));
      },
      cancel() {
        cancelled = true;
      },
    });
    const key = `${readOnlyFormPackagePrefix(packageDigest)}/package-index.json`;
    const reader = createFormPackageReader({
      async get(requested): Promise<StoredObjectBody | null> {
        return requested === key ? { key, size: 0, etag: "test", body } : null;
      },
      async list() {
        return { objects: [], truncated: false };
      },
    });

    await expect(reader.read({ packageDigest })).resolves.toBeNull();
    expect(cancelled).toBe(true);
  });

  test.each([
    ["unsupported package API", { apiVersion: "packages.forms.takoform.com/v9" }],
    ["malformed package version", { packageVersion: 42 }],
    ["unsafe definition path", { definitionPath: "../definition.json" }],
    ["index definition path", { definitionPath: "package-index.json" }],
  ] as const)("definition-only and full reads reject %s in the index", async (_label, override) => {
    const definitionBytes = new TextEncoder().encode("definition");
    const definitionDigest = await bytesDigest(definitionBytes);
    const manifest = {
      apiVersion: "packages.forms.takoform.com/v1alpha1",
      kind: "FormPackage",
      formRef: FORM_REF,
      definitionPath: "definition.json",
      files: [
        {
          path: "definition.json",
          digest: definitionDigest,
          size: definitionBytes.byteLength,
          mediaType: "application/json",
        },
      ],
      ...override,
    } as unknown as JsonObject;
    const packageDigest = (await canonicalDigest(manifest)) as `sha256:${string}`;
    const indexKey = `${readOnlyFormPackagePrefix(packageDigest)}/package-index.json`;
    const definitionKey = readOnlyFormPackageKey(packageDigest, "definition.json");
    const indexBytes = new TextEncoder().encode(canonicalJson(manifest));
    let payloadReads = 0;
    const reader = createFormPackageReader({
      async get(key): Promise<StoredObjectBody | null> {
        if (key === indexKey) {
          return { key, size: indexBytes.byteLength, etag: "index", body: streamOf(indexBytes) };
        }
        payloadReads += 1;
        if (key !== definitionKey) return null;
        return {
          key,
          size: definitionBytes.byteLength,
          etag: "definition",
          body: streamOf(definitionBytes),
        };
      },
      async list() {
        throw new Error("index rejection must happen before listing");
      },
    });

    if (!reader.readDefinition) throw new Error("definition reader missing");
    await expect(reader.readDefinition({ packageDigest, formRef: FORM_REF })).resolves.toBeNull();
    await expect(reader.read({ packageDigest, formRef: FORM_REF })).resolves.toBeNull();
    expect(payloadReads).toBe(0);
  });

  test("rejects more than 1024 declared files without reading a payload", async () => {
    const declarations = Array.from({ length: FORM_PACKAGE_LIMITS.files + 1 }, (_, index) => ({
      path: `payload-${index}.txt`,
      digest: ZERO_DIGEST,
      size: 0,
      mediaType: "text/plain",
    }));
    const { packageDigest, get, payloadReads } = await indexedReader(declarations);

    await expect(get().read({ packageDigest })).resolves.toBeNull();
    expect(payloadReads()).toBe(0);
  });

  test.each([
    [
      "Form Definition",
      FORM_PACKAGE_LIMITS.definitionBytes + 1,
      "application/vnd.takoform.form-definition.v1+json",
    ],
    ["application/json", FORM_PACKAGE_LIMITS.jsonPayloadBytes + 1, "application/json"],
    ["any file", FORM_PACKAGE_LIMITS.payloadBytes + 1, "text/plain"],
  ] as const)("rejects a declared %s over its Core cap", async (_label, size, mediaType) => {
    const { packageDigest, get, payloadReads } = await indexedReader([
      { path: "payload.txt", digest: ZERO_DIGEST, size, mediaType },
    ]);

    await expect(get().read({ packageDigest })).resolves.toBeNull();
    expect(payloadReads()).toBe(0);
  });

  test.each([
    [
      "Form Definition",
      "application/vnd.takoform.form-definition.v1+json",
      FORM_PACKAGE_LIMITS.definitionBytes,
    ],
    ["application/json", "application/json", FORM_PACKAGE_LIMITS.jsonPayloadBytes],
    ["other", "text/plain", FORM_PACKAGE_LIMITS.payloadBytes],
  ] as const)("keeps exact and +1 declared byte arithmetic for %s", (_label, mediaType, limit) => {
    expect(formPackagePayloadLimit(mediaType)).toBe(limit);
    expect(formPackagePayloadTotal([{ path: "payload", size: limit, mediaType }])).toBe(limit);
    expect(formPackagePayloadTotal([{ path: "payload", size: limit + 1, mediaType }])).toBeNull();
  });

  test.each([
    [
      "Form Definition",
      "application/vnd.takoform.form-definition.v1+json",
      FORM_PACKAGE_LIMITS.definitionBytes,
    ],
    ["application/json", "application/json", FORM_PACKAGE_LIMITS.jsonPayloadBytes],
    ["other", "text/plain", FORM_PACKAGE_LIMITS.payloadBytes],
  ] as const)(
    "enforces exact and +1 chunked stream limits for %s",
    async (_label, _mediaType, limit) => {
      const exact = await drainBoundedFormPackageStream(chunkedStream(limit), limit, limit);
      expect(exact).toBe(limit);

      await expect(
        drainBoundedFormPackageStream(chunkedStream(limit + 1), limit, limit),
      ).rejects.toMatchObject({ kind: "overrun" });
    },
  );

  test("enforces the aggregate read cap on a lazy chunked stream", async () => {
    await expect(
      drainBoundedFormPackageStream(
        chunkedStream(FORM_PACKAGE_LIMITS.packagePayloadBytes + 1),
        FORM_PACKAGE_LIMITS.packagePayloadBytes,
      ),
    ).rejects.toMatchObject({ kind: "overrun" });
  });

  test("rejects a declared package payload total over 256 MiB without allocating it", async () => {
    const declarations = [
      ...Array.from({ length: 4 }, (_, index) => ({
        path: `payload-${index}.txt`,
        digest: ZERO_DIGEST,
        size: FORM_PACKAGE_LIMITS.payloadBytes,
        mediaType: "text/plain" as const,
      })),
      {
        path: "payload-final.txt",
        digest: ZERO_DIGEST,
        size: 1,
        mediaType: "text/plain" as const,
      },
    ];
    const { packageDigest, get, payloadReads } = await indexedReader(declarations);

    await expect(get().read({ packageDigest })).resolves.toBeNull();
    expect(payloadReads()).toBe(0);
  });

  test.each([
    ["overrun", new Uint8Array([1, 2])],
    ["underrun", new Uint8Array()],
  ] as const)("rejects a payload stream %s its declared size", async (_label, actual) => {
    const digest = await bytesDigest(new Uint8Array([1]));
    const { packageDigest, get } = await indexedReader(
      [{ path: "payload.txt", digest, size: 1, mediaType: "text/plain" }],
      actual,
    );

    await expect(get().read({ packageDigest })).resolves.toBeNull();
  });

  test("stops assigning package payloads after the first failed bounded wave", async () => {
    const declarations = Array.from({ length: 92 }, (_, index) => ({
      path: `payload-${String(index).padStart(3, "0")}.txt`,
      digest: ZERO_DIGEST,
      size: 0,
      mediaType: "text/plain" as const,
    }));
    const { packageDigest, get, payloadReads } = await indexedReader(declarations);

    await expect(get().read({ packageDigest })).resolves.toBeNull();
    expect(payloadReads()).toBeGreaterThan(0);
    expect(payloadReads()).toBeLessThanOrEqual(16);
  });

  test("definition-only reads fetch only the index and declared Definition", async () => {
    const definitionBytes = new Uint8Array([1, 2, 3]);
    const definitionDigest = await bytesDigest(definitionBytes);
    const files = [
      {
        path: "definition.json",
        digest: definitionDigest,
        size: definitionBytes.byteLength,
        mediaType: "application/json",
      },
      ...Array.from({ length: 91 }, (_, index) => ({
        path: `payload-${String(index).padStart(3, "0")}.txt`,
        digest: ZERO_DIGEST,
        size: 0,
        mediaType: "text/plain",
      })),
    ];
    const manifest = {
      apiVersion: "packages.forms.takoform.com/v1alpha1",
      kind: "FormPackage",
      formRef: FORM_REF,
      definitionPath: "definition.json",
      files,
    } as unknown as JsonObject;
    const packageDigest = (await canonicalDigest(manifest)) as `sha256:${string}`;
    const indexKey = `${readOnlyFormPackagePrefix(packageDigest)}/package-index.json`;
    const definitionKey = readOnlyFormPackageKey(packageDigest, "definition.json");
    const indexBytes = new TextEncoder().encode(canonicalJson(manifest));
    const reads: string[] = [];
    const reader = createFormPackageReader({
      async get(key): Promise<StoredObjectBody | null> {
        reads.push(key);
        if (key === indexKey) {
          return { key, size: indexBytes.byteLength, etag: "index", body: streamOf(indexBytes) };
        }
        if (key === definitionKey) {
          return {
            key,
            size: definitionBytes.byteLength,
            etag: "definition",
            body: streamOf(definitionBytes),
          };
        }
        return null;
      },
      async list() {
        throw new Error("definition-only reads must not enumerate the package");
      },
    });

    if (!reader.readDefinition) throw new Error("definition reader missing");
    const result = await reader.readDefinition({ packageDigest, formRef: FORM_REF });
    expect(result?.definition.path).toBe("definition.json");
    expect(reads).toEqual([indexKey, definitionKey]);
  });

  test("checks an input manifest declaration before reading its payload stream", async () => {
    const manifest = {
      apiVersion: "packages.forms.takoform.com/v1alpha1",
      kind: "FormPackage",
      formRef: FORM_REF,
      files: [
        {
          path: "payload.json",
          digest: ZERO_DIGEST,
          size: FORM_PACKAGE_LIMITS.jsonPayloadBytes + 1,
          mediaType: "application/json",
        },
      ],
    } as const;
    const packageDigest = await canonicalDigest(manifest);
    let pulled = false;
    const bytes = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0]));
      },
      pull() {
        pulled = true;
        throw new Error("payload must not be read");
      },
    });
    const input: FormPackageInput = {
      packageDigest,
      formRef: FORM_REF,
      manifest,
      files: [{ path: "payload.json", bytes }],
    };
    const packages = createFormPackageStore(createMemoryObjectStore());

    await expect(packages.put(input)).rejects.toMatchObject({ code: "invalid_package" });
    expect(pulled).toBe(false);
  });

  test("rejects an input payload stream that overruns its declared size", async () => {
    const declared = new Uint8Array([1]);
    const manifest = {
      apiVersion: "packages.forms.takoform.com/v1alpha1",
      kind: "FormPackage",
      formRef: FORM_REF,
      files: [
        {
          path: "payload.txt",
          digest: await bytesDigest(declared),
          size: declared.byteLength,
          mediaType: "text/plain",
        },
      ],
    } as const;
    const packageDigest = await canonicalDigest(manifest);
    const bytes = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
        controller.close();
      },
    });
    const packages = createFormPackageStore(createMemoryObjectStore());

    await expect(
      packages.put({
        packageDigest,
        formRef: FORM_REF,
        manifest,
        files: [{ path: "payload.txt", bytes }],
      }),
    ).rejects.toMatchObject({ code: "invalid_package" });
  });

  test("returns an overrun promptly when source cancellation never settles", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2]));
      },
      cancel() {
        return new Promise<void>(() => {});
      },
    });
    const result = await Promise.race([
      readBoundedFormPackageStream(body, 1).then(
        () => "accepted",
        (error) => (error instanceof FormPackageStreamLimitError ? error.kind : "other"),
      ),
      new Promise<"timed-out">((resolve) => setTimeout(() => resolve("timed-out"), 100)),
    ]);
    expect(result).toBe("overrun");
  });

  test("accepts an exact 1024-payload package and rejects an extra object", async () => {
    const empty = new Uint8Array();
    const digest = await bytesDigest(empty);
    const declarations = Array.from({ length: FORM_PACKAGE_LIMITS.files }, (_, index) => ({
      path: `payload-${String(index).padStart(4, "0")}.txt`,
      digest,
      size: 0,
      mediaType: "text/plain" as const,
    }));
    const manifest = packageManifest({ formRef: FORM_REF, files: declarations });
    const packageDigest = await canonicalDigest(manifest);
    const objects = createMemoryObjectStore();
    const packages = createFormPackageStore(objects);
    const stored = await packages.put({
      packageDigest,
      formRef: FORM_REF,
      files: declarations.map((file) => ({
        path: file.path,
        bytes: empty,
        mediaType: file.mediaType,
      })),
    });
    expect(stored.files).toHaveLength(FORM_PACKAGE_LIMITS.files);

    await objects.put(`${stored.prefix}/extra.txt`, empty);
    await expect(packages.read({ packageDigest, formRef: FORM_REF })).resolves.toBeNull();
  });

  test("maps an unknown-size oversized object to a bounded read failure", async () => {
    const digest = await bytesDigest(new Uint8Array([1]));
    const { packageDigest, get } = await indexedReader(
      [{ path: "payload.txt", digest, size: 1, mediaType: "text/plain" }],
      new Uint8Array([1, 2]),
      0,
    );
    await expect(get().read({ packageDigest })).resolves.toBeNull();
  });

  test("rejects an oversized existing object without buffering it", async () => {
    const bytes = new Uint8Array([1]);
    const digest = await bytesDigest(bytes);
    const files = [{ path: "payload.txt", digest, size: 1, mediaType: "text/plain" as const }];
    const manifest = packageManifest({ formRef: FORM_REF, files });
    const packageDigest = await canonicalDigest(manifest);
    const objects = createMemoryObjectStore();
    await objects.put(formPackageKey(packageDigest, "payload.txt"), new Uint8Array([1, 2]));
    const packages = createFormPackageStore(objects);

    await expect(
      packages.put({
        packageDigest,
        formRef: FORM_REF,
        files: [{ path: "payload.txt", bytes, mediaType: "text/plain" }],
      }),
    ).rejects.toMatchObject({ code: "package_readback_mismatch" });
  });
});

async function indexedReader(
  files: readonly {
    readonly path: string;
    readonly digest: `sha256:${string}`;
    readonly size: number;
    readonly mediaType?: string;
  }[],
  payloadBytes?: Uint8Array,
  payloadObjectSize = payloadBytes?.byteLength ?? 0,
): Promise<{
  readonly packageDigest: `sha256:${string}`;
  readonly get: () => ReturnType<typeof createFormPackageReader>;
  readonly payloadReads: () => number;
}> {
  const manifest = {
    apiVersion: "packages.forms.takoform.com/v1alpha1",
    kind: "FormPackage",
    formRef: FORM_REF,
    files,
  };
  const packageDigest = await canonicalDigest(manifest);
  const indexKey = `${readOnlyFormPackagePrefix(packageDigest)}/package-index.json`;
  const payload = payloadBytes ?? new Uint8Array();
  let reads = 0;
  const readerFactory = () =>
    createFormPackageReader({
      async get(key): Promise<StoredObjectBody | null> {
        if (key === indexKey) {
          const indexBytes = new TextEncoder().encode(canonicalJson(manifest));
          return {
            key,
            size: indexBytes.byteLength,
            etag: "index",
            body: streamOf(indexBytes),
          };
        }
        reads += 1;
        const declaration = files.find(
          (file) => readOnlyFormPackageKey(packageDigest, file.path) === key,
        );
        return declaration
          ? {
              key,
              size: payloadObjectSize,
              etag: "payload",
              body: streamOf(payload),
            }
          : null;
      },
      async list({ prefix: listPrefix, cursor }) {
        const keys = [
          indexKey,
          ...files.map((file) => readOnlyFormPackageKey(packageDigest, file.path)),
        ].filter((key) => key.startsWith(listPrefix));
        const start = cursor === undefined ? 0 : keys.findIndex((key) => key > cursor);
        const objects = (start < 0 ? [] : keys.slice(start)).map((key) => ({
          key,
          size:
            key === indexKey
              ? new TextEncoder().encode(canonicalJson(manifest)).byteLength
              : payload.byteLength,
          etag: "fixture",
        }));
        return { objects, truncated: false };
      },
    });
  return { packageDigest, get: readerFactory, payloadReads: () => reads };
}

function streamOf(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      if (bytes.byteLength > 0) controller.enqueue(bytes);
      controller.close();
    },
  });
}

function chunkedStream(totalBytes: number): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(64 * 1024);
  let remaining = totalBytes;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (remaining === 0) {
        controller.close();
        return;
      }
      const size = Math.min(remaining, chunk.byteLength);
      remaining -= size;
      controller.enqueue(chunk.subarray(0, size));
    },
  });
}
