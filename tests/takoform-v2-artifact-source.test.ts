import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { ObjectStoreAccess, StoredObjectBody } from "../src/ports.ts";
import {
  createV2HeldArtifactSource,
  V2ArtifactSourceError,
  type V2HeldArtifactEntry,
} from "../src/takoform-v2/forms/artifact-source.ts";

const URL = "https://artifacts.example.invalid/migrations/manifest.json";
const PRINCIPAL = "principal-a";
const SPACE = "space-a";

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceEntry(bytes: Uint8Array): V2HeldArtifactEntry {
  return {
    url: URL,
    sha256: digest(bytes),
    objectKey: "held/migrations/manifest",
    grants: [{ principal: PRINCIPAL, space: SPACE }],
  };
}

async function storeBytes(key: string, bytes: Uint8Array) {
  const objects = createMemoryObjectStore();
  await objects.put(key, bytes, { contentType: "application/octet-stream" });
  return objects;
}

async function errorCode(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof V2ArtifactSourceError ? error.code : `unexpected:${String(error)}`;
  }
  return "none";
}

describe("Host-held v2 artifact source", () => {
  test("reads only an exact authorized URL/digest and returns independent verified bytes", async () => {
    const bytes = new TextEncoder().encode("-- migration\nSELECT '雪';\n");
    const entry = sourceEntry(bytes);
    const objects = await storeBytes(entry.objectKey, bytes);
    const source = createV2HeldArtifactSource({ objects, entries: [entry] });

    const result = await source.read({
      principal: PRINCIPAL,
      space: SPACE,
      url: URL,
      sha256: entry.sha256,
      maxBytes: 1_024,
    });
    expect(result).toEqual(bytes);
    result.fill(0);
    expect(
      await source.read({
        principal: PRINCIPAL,
        space: SPACE,
        url: URL,
        sha256: entry.sha256,
        maxBytes: 1_024,
      }),
    ).toEqual(bytes);
  });

  test("digest presence alone grants no access and unknown source identities fail closed", async () => {
    const bytes = new TextEncoder().encode("private held bytes");
    const entry = sourceEntry(bytes);
    const storedObjects = await storeBytes(entry.objectKey, bytes);
    let reads = 0;
    const objects = {
      async get(key: string) {
        reads += 1;
        return await storedObjects.get(key);
      },
    } satisfies Pick<ObjectStoreAccess, "get">;
    const source = createV2HeldArtifactSource({ objects, entries: [entry] });
    const input = { url: URL, sha256: entry.sha256, maxBytes: 1_024 };

    expect(await errorCode(source.read({ ...input, principal: "other", space: SPACE }))).toBe(
      "unavailable",
    );
    expect(await errorCode(source.read({ ...input, principal: PRINCIPAL, space: "other" }))).toBe(
      "unavailable",
    );
    expect(
      await errorCode(
        source.read({
          ...input,
          principal: PRINCIPAL,
          space: SPACE,
          sha256: "0".repeat(64),
        }),
      ),
    ).toBe("unavailable");
    expect(
      await errorCode(
        source.read({
          ...input,
          principal: PRINCIPAL,
          space: SPACE,
          url: "https://artifacts.example.invalid/other.json",
        }),
      ),
    ).toBe("unavailable");
    expect(reads).toBe(0);
  });

  test("snapshots source keys and principal/Space grants at construction", async () => {
    const bytes = new TextEncoder().encode("snapshot bytes");
    const entry = sourceEntry(bytes);
    const entries: V2HeldArtifactEntry[] = [entry];
    const grants = entry.grants as Array<{ principal: string; space: string }>;
    const objects = await storeBytes(entry.objectKey, bytes);
    const source = createV2HeldArtifactSource({ objects, entries });

    (entry as { objectKey: string }).objectKey = "held/attacker-object";
    grants[0] = { principal: "attacker", space: SPACE };
    entries.push({
      ...entry,
      url: "https://artifacts.example.invalid/attacker.json",
      objectKey: "held/attacker-object",
    });

    expect(
      await source.read({
        principal: PRINCIPAL,
        space: SPACE,
        url: URL,
        sha256: digest(bytes),
        maxBytes: 1_024,
      }),
    ).toEqual(bytes);
    expect(
      await errorCode(
        source.read({
          principal: "attacker",
          space: SPACE,
          url: URL,
          sha256: digest(bytes),
          maxBytes: 1_024,
        }),
      ),
    ).toBe("unavailable");
  });

  test("enforces the observed stream size, not object metadata, and cancels overflow", async () => {
    const bytes = new TextEncoder().encode("ignored for limit fixture");
    const entry = sourceEntry(bytes);
    let cancelled = false;
    const objects = {
      async get(key: string): Promise<StoredObjectBody | null> {
        if (key !== entry.objectKey) return null;
        return {
          key,
          size: 0,
          etag: "not-authoritative",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3, 4]));
            },
            cancel() {
              cancelled = true;
            },
          }),
        };
      },
    } satisfies Pick<ObjectStoreAccess, "get">;
    const source = createV2HeldArtifactSource({ objects, entries: [entry] });

    expect(
      await errorCode(
        source.read({
          principal: PRINCIPAL,
          space: SPACE,
          url: URL,
          sha256: entry.sha256,
          maxBytes: 3,
        }),
      ),
    ).toBe("too_large");
    expect(cancelled).toBe(true);
  });

  test("rejects corrupt bytes and hides partial-stream diagnostics", async () => {
    const bytes = new TextEncoder().encode("expected bytes");
    const entry = sourceEntry(bytes);
    const corrupt = await storeBytes(entry.objectKey, new TextEncoder().encode("changed bytes"));
    const corruptSource = createV2HeldArtifactSource({ objects: corrupt, entries: [entry] });
    const request = {
      principal: PRINCIPAL,
      space: SPACE,
      url: URL,
      sha256: entry.sha256,
      maxBytes: 1_024,
    };
    expect(await errorCode(corruptSource.read(request))).toBe("integrity_failure");

    const objects = {
      async get(key: string): Promise<StoredObjectBody | null> {
        if (key !== entry.objectKey) return null;
        return {
          key,
          size: bytes.byteLength,
          etag: "fixture",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes.slice(0, 2));
              controller.error(new Error(`${URL} private SQL payload`));
            },
          }),
        };
      },
    } satisfies Pick<ObjectStoreAccess, "get">;
    const partialSource = createV2HeldArtifactSource({ objects, entries: [entry] });
    let caught: unknown;
    try {
      await partialSource.read(request);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(V2ArtifactSourceError);
    expect(caught).toMatchObject({ code: "unavailable", message: "unavailable" });
    expect(String(caught)).not.toContain(URL);
    expect(String(caught)).not.toContain("private SQL payload");
  });

  test("rejects unsafe configuration and caller-provided limits outside the Form ceiling", async () => {
    const bytes = new TextEncoder().encode("x");
    const entry = sourceEntry(bytes);
    const objects = await storeBytes(entry.objectKey, bytes);

    expect(() =>
      createV2HeldArtifactSource({
        objects,
        entries: [{ ...entry, url: `${URL}?token=secret` }],
      }),
    ).toThrow("invalid held artifact source configuration");
    expect(() =>
      createV2HeldArtifactSource({
        objects,
        entries: [{ ...entry, url: "https://user:pass@artifacts.example.invalid/file" }],
      }),
    ).toThrow("invalid held artifact source configuration");

    const source = createV2HeldArtifactSource({ objects, entries: [entry] });
    expect(
      await errorCode(
        source.read({
          principal: PRINCIPAL,
          space: SPACE,
          url: URL,
          sha256: entry.sha256,
          maxBytes: Number.MAX_SAFE_INTEGER,
        }),
      ),
    ).toBe("unavailable");
  });

  test("times out a stalled object lookup and cancels a body that arrives late", async () => {
    const bytes = new TextEncoder().encode("late body");
    const entry = sourceEntry(bytes);
    let resolveLookup!: (value: StoredObjectBody | null) => void;
    let cancelled = false;
    const lookup = new Promise<StoredObjectBody | null>((resolve) => {
      resolveLookup = resolve;
    });
    const objects = {
      async get(): Promise<StoredObjectBody | null> {
        return await lookup;
      },
    } satisfies Pick<ObjectStoreAccess, "get">;
    const source = createV2HeldArtifactSource({
      objects,
      entries: [entry],
      timeoutMilliseconds: 10,
    });

    expect(
      await errorCode(
        source.read({
          principal: PRINCIPAL,
          space: SPACE,
          url: URL,
          sha256: entry.sha256,
          maxBytes: 1_024,
        }),
      ),
    ).toBe("timeout");

    resolveLookup({
      key: entry.objectKey,
      size: bytes.byteLength,
      etag: "fixture",
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes);
          controller.close();
        },
        cancel() {
          cancelled = true;
        },
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(cancelled).toBe(true);
  });

  test("times out a stalled stream even when cancellation never settles", async () => {
    const bytes = new TextEncoder().encode("never delivered");
    const entry = sourceEntry(bytes);
    let cancelled = false;
    const objects = {
      async get(key: string): Promise<StoredObjectBody | null> {
        if (key !== entry.objectKey) return null;
        return {
          key,
          size: bytes.byteLength,
          etag: "fixture",
          body: new ReadableStream<Uint8Array>({
            pull() {
              return new Promise<void>(() => undefined);
            },
            cancel() {
              cancelled = true;
              return new Promise<void>(() => undefined);
            },
          }),
        };
      },
    } satisfies Pick<ObjectStoreAccess, "get">;
    const source = createV2HeldArtifactSource({
      objects,
      entries: [entry],
      timeoutMilliseconds: 10,
    });

    expect(
      await errorCode(
        source.read({
          principal: PRINCIPAL,
          space: SPACE,
          url: URL,
          sha256: entry.sha256,
          maxBytes: 1_024,
        }),
      ),
    ).toBe("timeout");
    expect(cancelled).toBe(true);
  });

  test("does not wait for a stalled cancellation after size overflow", async () => {
    const bytes = new TextEncoder().encode("size fixture");
    const entry = sourceEntry(bytes);
    let cancelled = false;
    const objects = {
      async get(key: string): Promise<StoredObjectBody | null> {
        if (key !== entry.objectKey) return null;
        return {
          key,
          size: 0,
          etag: "fixture",
          body: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2]));
            },
            cancel() {
              cancelled = true;
              return new Promise<void>(() => undefined);
            },
          }),
        };
      },
    } satisfies Pick<ObjectStoreAccess, "get">;
    const source = createV2HeldArtifactSource({ objects, entries: [entry] });

    expect(
      await errorCode(
        source.read({
          principal: PRINCIPAL,
          space: SPACE,
          url: URL,
          sha256: entry.sha256,
          maxBytes: 1,
        }),
      ),
    ).toBe("too_large");
    expect(cancelled).toBe(true);
  });

  test("accepts valid content streamed in more than 65,536 one-byte chunks", async () => {
    const bytes = new Uint8Array(65_537);
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = index % 251;
    const entry = sourceEntry(bytes);
    const objects = {
      async get(key: string): Promise<StoredObjectBody | null> {
        if (key !== entry.objectKey) return null;
        let offset = 0;
        return {
          key,
          size: 1,
          etag: "metadata-is-not-the-byte-count",
          body: new ReadableStream<Uint8Array>({
            pull(controller) {
              if (offset >= bytes.byteLength) {
                controller.close();
                return;
              }
              controller.enqueue(bytes.slice(offset, offset + 1));
              offset += 1;
            },
          }),
        };
      },
    } satisfies Pick<ObjectStoreAccess, "get">;
    const source = createV2HeldArtifactSource({
      objects,
      entries: [entry],
      timeoutMilliseconds: 5_000,
    });

    expect(
      await source.read({
        principal: PRINCIPAL,
        space: SPACE,
        url: URL,
        sha256: entry.sha256,
        maxBytes: bytes.byteLength,
      }),
    ).toEqual(bytes);
  });
});
