import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { type ObjectStore, ObjectStoreError } from "../src/ports.ts";

/**
 * Somebody running this on their own machine needs storage that survives a
 * restart, and keys come from customers. Both halves are the test: what it
 * keeps, and what it refuses to turn into a path.
 */

let root: string;
let store: ObjectStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-objects-"));
  store = createFileObjectStore({ root });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("objects on a disk", () => {
  test("round-trips bytes and their content type", async () => {
    const body = new TextEncoder().encode("hello");
    const written = await store.put("a/b/one.txt", body, { contentType: "text/plain" });
    expect(written.size).toBe(5);

    const read = await store.get("a/b/one.txt");
    expect(new Uint8Array(await new Response(read?.body).arrayBuffer())).toEqual(body);
    expect(read?.contentType).toBe("text/plain");
    expect(read?.etag).toBe(written.etag);
  });

  test("survives a new store over the same directory", async () => {
    await store.put("kept", new TextEncoder().encode("still here"));
    const reopened = createFileObjectStore({ root });
    const read = await reopened.get("kept");
    expect(await new Response(read?.body).text()).toBe("still here");
  });

  test("reports absence rather than inventing an object", async () => {
    expect(await store.get("never")).toBeNull();
    expect(await store.head("never")).toBeNull();
    expect(await store.delete("never")).toBe(false);
  });

  test("refuses a key that would leave the store", async () => {
    for (const key of ["../escape", "a/../../b", "/absolute", "a//b", "", "."]) {
      await expect(store.put(key, new Uint8Array([1]))).rejects.toBeInstanceOf(ObjectStoreError);
    }
  });

  test("refuses keys that would collide with its own bookkeeping", async () => {
    // The sidecar and the staging file are storage, not objects; a key that
    // could name one could overwrite another object's content type.
    for (const key of ["thing.meta", "thing.partial"]) {
      await expect(store.put(key, new Uint8Array([1]))).rejects.toBeInstanceOf(ObjectStoreError);
    }
  });

  test("lists a prefix and pages through it", async () => {
    for (const name of ["p/one", "p/three", "p/two", "other/x"]) {
      await store.put(name, new TextEncoder().encode(name));
    }
    const first = await store.list({ prefix: "p/", limit: 2 });
    expect(first.objects.map((object) => object.key)).toEqual(["p/one", "p/three"]);
    expect(first.truncated).toBe(true);

    const second = await store.list({
      prefix: "p/",
      limit: 2,
      ...(first.cursor ? { cursor: first.cursor } : {}),
    });
    expect(second.objects.map((object) => object.key)).toEqual(["p/two"]);
    expect(second.truncated).toBe(false);
  });

  test("never lists its own sidecars as objects", async () => {
    await store.put("doc", new TextEncoder().encode("x"), { contentType: "text/plain" });
    expect(
      (await store.list({ prefix: "", limit: 100 })).objects.map((object) => object.key),
    ).toEqual(["doc"]);
  });

  test("a rewrite replaces the object rather than appending to it", async () => {
    await store.put("doc", new TextEncoder().encode("first version, longer"));
    await store.put("doc", new TextEncoder().encode("second"));
    const read = await store.get("doc");
    expect(await new Response(read?.body).text()).toBe("second");
  });

  test("dropping the content type on a rewrite drops it from the store", async () => {
    await store.put("doc", new TextEncoder().encode("x"), { contentType: "text/plain" });
    await store.put("doc", new TextEncoder().encode("x"));
    // Otherwise an object keeps a type nobody declared, and `get` disagrees
    // with the request that last wrote it.
    expect((await store.get("doc"))?.contentType).toBeUndefined();
  });
});
