import { describe, expect, test } from "bun:test";
import { createR2ObjectStore, type R2BucketLike } from "../src/objects-r2.ts";

describe("R2 object adapter", () => {
  test("round-trips the exact write operation identity in R2 custom metadata", async () => {
    const held = new Map<
      string,
      { readonly bytes: Uint8Array; readonly customMetadata?: Readonly<Record<string, string>> }
    >();
    let listOptions: unknown;
    const bucket: R2BucketLike = {
      async put(key, body, options) {
        const bytes =
          body instanceof Uint8Array
            ? body.slice()
            : body instanceof ArrayBuffer
              ? new Uint8Array(body.slice(0))
              : new Uint8Array(await new Response(body).arrayBuffer());
        held.set(key, {
          bytes,
          ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
        });
        return {
          key,
          size: bytes.byteLength,
          etag: "etag-operation",
          ...(options?.customMetadata ? { customMetadata: options.customMetadata } : {}),
        };
      },
      async get(key) {
        const value = held.get(key);
        if (!value) return null;
        const response = new Response(value.bytes as unknown as BodyInit);
        if (!response.body) throw new Error("R2 fixture response body missing");
        return {
          key,
          size: value.bytes.byteLength,
          etag: "etag-operation",
          ...(value.customMetadata ? { customMetadata: value.customMetadata } : {}),
          body: response.body,
        };
      },
      async head(key) {
        const value = held.get(key);
        return value
          ? {
              key,
              size: value.bytes.byteLength,
              etag: "etag-operation",
              ...(value.customMetadata ? { customMetadata: value.customMetadata } : {}),
            }
          : null;
      },
      async delete(key) {
        held.delete(key);
      },
      async list(options) {
        listOptions = options;
        return {
          objects: [...held.entries()].map(([key, value]) => ({
            key,
            size: value.bytes.byteLength,
            etag: "etag-operation",
            ...(value.customMetadata ? { customMetadata: value.customMetadata } : {}),
          })),
          truncated: false,
        };
      },
    };
    const store = createR2ObjectStore(bucket);

    const written = await store.put("art/exact", new Uint8Array([1, 2, 3]), {
      writeOperationId: "abw_exact_operation",
    });
    expect(written.writeOperationId).toBe("abw_exact_operation");
    expect((await store.head("art/exact"))?.writeOperationId).toBe("abw_exact_operation");
    expect((await store.get("art/exact"))?.writeOperationId).toBe("abw_exact_operation");
    expect((await store.list({ prefix: "art/", limit: 10 })).objects[0]?.writeOperationId).toBe(
      "abw_exact_operation",
    );
    expect(listOptions).toMatchObject({
      prefix: "art/",
      limit: 10,
      include: ["httpMetadata", "customMetadata"],
    });
  });

  test("maps create-only to R2's conditional put and preserves the winner", async () => {
    const held = new Map<string, Uint8Array>();
    const puts: unknown[] = [];
    let contenders = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const bucket: R2BucketLike = {
      async put(key, body, options) {
        puts.push(options);
        if (options?.onlyIf?.etagDoesNotMatch === "*") {
          contenders += 1;
          if (contenders === 2) release();
          await barrier;
          if (held.has(key)) return null;
        }
        const bytes =
          body instanceof Uint8Array
            ? body.slice()
            : body instanceof ArrayBuffer
              ? new Uint8Array(body.slice(0))
              : new Uint8Array(await new Response(body).arrayBuffer());
        held.set(key, bytes);
        return { key, size: bytes.byteLength, etag: `etag-${bytes.byteLength}` };
      },
      async get(key) {
        const bytes = held.get(key);
        if (!bytes) return null;
        const response = new Response(bytes as unknown as BodyInit);
        if (!response.body) throw new Error("R2 fixture response body missing");
        return {
          key,
          size: bytes.byteLength,
          etag: `etag-${bytes.byteLength}`,
          body: response.body,
        };
      },
      async head(key) {
        const bytes = held.get(key);
        return bytes ? { key, size: bytes.byteLength, etag: `etag-${bytes.byteLength}` } : null;
      },
      async delete(key) {
        held.delete(key);
      },
      async list() {
        return { objects: [], truncated: false };
      },
    };
    const store = createR2ObjectStore(bucket);

    const results = await Promise.all([
      store.create("formpkg/exact", new TextEncoder().encode("first")),
      store.create("formpkg/exact", new TextEncoder().encode("second")),
    ]);
    expect(results.filter((result) => result !== null)).toHaveLength(1);
    const winner = await new Response((await store.get("formpkg/exact"))?.body).text();
    expect(["first", "second"]).toContain(winner);
    expect(puts).toEqual([
      { onlyIf: { etagDoesNotMatch: "*" } },
      { onlyIf: { etagDoesNotMatch: "*" } },
    ]);
  });
});
