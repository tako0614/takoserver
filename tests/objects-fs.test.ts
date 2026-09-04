import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bytesDigest, canonicalDigest } from "../src/json.ts";
import { createFileObjectStore } from "../src/objects-fs.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { type ObjectStore, ObjectStoreError } from "../src/ports.ts";
import { readBoundedFormPackageStream } from "../src/takoform/form-package-limits.ts";
import { createFormPackageStore, packageManifest } from "../src/takoform/form-packages.ts";

/**
 * Somebody running this on their own machine needs storage that survives a
 * restart, and keys come from customers. Both halves are the test: what it
 * keeps, and what it refuses to turn into a path.
 */

let root: string;
let store: ObjectStore;

const fileStoreModuleUrl = new URL("../src/objects-fs.ts", import.meta.url).href;

function spawnFileStoreWriter(
  storeRoot: string,
  key: string,
  value: string,
  hold: boolean,
): ReturnType<typeof Bun.spawn> {
  const script = `
    import { createFileObjectStore } from ${JSON.stringify(fileStoreModuleUrl)};
    const objects = createFileObjectStore({ root: Bun.argv[1] });
    await objects.put(${JSON.stringify(key)}, new TextEncoder().encode(${JSON.stringify(value)}));
    console.log("READY");
    if (${JSON.stringify(hold)}) await new Promise((resolve) => setTimeout(resolve, 30_000));
  `;
  return Bun.spawn([process.execPath, "--eval", script, storeRoot], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
}

function spawnIdleProcess(): ReturnType<typeof Bun.spawn> {
  return Bun.spawn(
    [
      process.execPath,
      "--eval",
      'console.log("READY"); await new Promise((resolve) => setTimeout(resolve, 30_000));',
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
}

async function waitForChildReady(child: ReturnType<typeof Bun.spawn>): Promise<void> {
  const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
  const ready = await reader.read();
  if (ready.done || !new TextDecoder().decode(ready.value).includes("READY")) {
    const stderr = await new Response(child.stderr as ReadableStream<Uint8Array>).text();
    throw new Error(`child writer did not become ready: ${stderr}`);
  }
  reader.releaseLock();
}

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

  test("persists exact write operation identity and drops it on an untagged rewrite", async () => {
    await store.put("art/exact", new TextEncoder().encode("first"), {
      writeOperationId: "abw_filesystem_exact",
    });
    const reopened = createFileObjectStore({ root });
    expect((await reopened.get("art/exact"))?.writeOperationId).toBe("abw_filesystem_exact");
    expect((await reopened.head("art/exact"))?.writeOperationId).toBe("abw_filesystem_exact");
    expect((await reopened.list({ prefix: "art/", limit: 10 })).objects[0]?.writeOperationId).toBe(
      "abw_filesystem_exact",
    );

    await reopened.put("art/exact", new TextEncoder().encode("second"));
    expect((await reopened.head("art/exact"))?.writeOperationId).toBeUndefined();
  });

  test("fails closed when tagged bytes have no readable metadata publication", async () => {
    await store.put("art/interrupted", new TextEncoder().encode("bytes"), {
      writeOperationId: "abw_filesystem_interrupted",
    });
    rmSync(join(root, ".object-metadata", "6172742f696e746572727570746564.json"));

    const reopened = createFileObjectStore({ root });
    expect((await reopened.head("art/interrupted"))?.writeOperationId).toBeUndefined();
    expect((await reopened.get("art/interrupted"))?.writeOperationId).toBeUndefined();
    expect(
      (await reopened.list({ prefix: "art/", limit: 10 })).objects[0]?.writeOperationId,
    ).toBeUndefined();
  });

  test("publishes a complete create-only object without replacing an existing key", async () => {
    expect(await store.create("immutable", new TextEncoder().encode("first"))).not.toBeNull();
    expect(await store.create("immutable", new TextEncoder().encode("second"))).toBeNull();
    expect(await new Response((await store.get("immutable"))?.body).text()).toBe("first");
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

  test("does not read through an intermediate symlink outside the store", async () => {
    const outside = mkdtempSync(join(tmpdir(), "takoserver-objects-outside-"));
    try {
      writeFileSync(join(outside, "secret.txt"), "outside secret");
      mkdirSync(join(root, "objects"), { recursive: true });
      symlinkSync(outside, join(root, "objects", "escape"), "dir");

      expect(await store.get("escape/secret.txt")).toBeNull();
      expect(await store.head("escape/secret.txt")).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("does not write, create, or delete through an intermediate symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "takoserver-objects-outside-"));
    try {
      writeFileSync(join(outside, "victim.txt"), "keep me");
      mkdirSync(join(root, "objects"), { recursive: true });
      symlinkSync(outside, join(root, "objects", "escape"), "dir");

      const results = await Promise.allSettled([
        store.put("escape/put.txt", new TextEncoder().encode("put")),
        store.create("escape/create.txt", new TextEncoder().encode("create")),
        store.delete("escape/victim.txt"),
      ]);
      for (const result of results) {
        expect(result.status).toBe("rejected");
        if (result.status === "rejected") {
          expect(result.reason).toBeInstanceOf(ObjectStoreError);
          expect(result.reason).toMatchObject({ code: "unavailable" });
        }
      }
      expect(existsSync(join(outside, "put.txt"))).toBe(false);
      expect(existsSync(join(outside, "create.txt"))).toBe(false);
      expect(readFileSync(join(outside, "victim.txt"), "utf8")).toBe("keep me");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses to list through an intermediate symlink", async () => {
    const outside = mkdtempSync(join(tmpdir(), "takoserver-objects-outside-"));
    try {
      writeFileSync(join(outside, "listed.txt"), "outside");
      mkdirSync(join(root, "objects"), { recursive: true });
      symlinkSync(outside, join(root, "objects", "escape"), "dir");

      await expect(store.list({ prefix: "escape/", limit: 100 })).rejects.toMatchObject({
        code: "unavailable",
      });
      await expect(store.list({ prefix: "", limit: 100 })).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("fails closed on a final symlink without changing its outside target", async () => {
    const outside = mkdtempSync(join(tmpdir(), "takoserver-objects-outside-"));
    try {
      const target = join(outside, "target.txt");
      writeFileSync(target, "outside target");
      mkdirSync(join(root, "objects"), { recursive: true });
      symlinkSync(target, join(root, "objects", "linked.txt"));

      expect(await store.get("linked.txt")).toBeNull();
      expect(await store.head("linked.txt")).toBeNull();
      await expect(store.list({ prefix: "", limit: 100 })).rejects.toMatchObject({
        code: "unavailable",
      });
      const results = await Promise.allSettled([
        store.put("linked.txt", new TextEncoder().encode("put")),
        store.create("linked.txt", new TextEncoder().encode("create")),
        store.delete("linked.txt"),
      ]);
      expect(results.map((result) => result.status)).toEqual(["rejected", "rejected", "rejected"]);
      expect(readFileSync(target, "utf8")).toBe("outside target");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("keeps metadata and staging suffixes available as ordinary object keys", async () => {
    await store.put("thing.meta", new Uint8Array([1]));
    await store.put("thing", new Uint8Array([0]));
    await store.put("thing.partial", new Uint8Array([2]));

    expect(await store.get("thing.meta")).toMatchObject({ size: 1 });
    expect(await store.get("thing.partial")).toMatchObject({ size: 1 });
    expect(
      (await store.list({ prefix: "", limit: 100 })).objects.map((object) => object.key),
    ).toEqual(["thing", "thing.meta", "thing.partial"]);
  });

  test("keeps a suffix-shaped user object when staging clocks and pid collide", async () => {
    const memory = createMemoryObjectStore();
    const fixedNow = 1_700_000_000_000;
    const suffixKey = `base.${process.pid}.${fixedNow}.partial`;
    const suffixBytes = new Uint8Array([7]);
    const baseBytes = new Uint8Array([8]);
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    try {
      await store.put(suffixKey, suffixBytes);
      await memory.put(suffixKey, suffixBytes);
      await store.put("base", baseBytes);
      await memory.put("base", baseBytes);
      expect(await store.get(suffixKey)).not.toBeNull();

      await store.delete("base");
      await memory.delete("base");
      await store.put(suffixKey, suffixBytes);
      await memory.put(suffixKey, suffixBytes);
      expect(await store.create("base", baseBytes)).not.toBeNull();
      await memory.create("base", baseBytes);
    } finally {
      Date.now = originalNow;
    }

    const fileKeys = (await store.list({ prefix: "", limit: 100 })).objects.map(
      (object) => object.key,
    );
    const memoryKeys = (await memory.list({ prefix: "", limit: 100 })).objects.map(
      (object) => object.key,
    );
    expect(fileKeys).toEqual(memoryKeys);
    expect(fileKeys).toEqual(["base", suffixKey]);
    expect(
      new Uint8Array(await new Response((await store.get(suffixKey))?.body).arrayBuffer()),
    ).toEqual(suffixBytes);
  });

  test("migrates a legacy metadata sidecar before accepting a terminal meta key", async () => {
    const siblingBytes = new Uint8Array([3]);
    const suffixBytes = new Uint8Array([4]);
    mkdirSync(join(root, "objects"), { recursive: true });
    writeFileSync(join(root, "objects", "thing"), siblingBytes);
    // Before terminal `.meta` keys were accepted, this pathname could only
    // be the legacy content-type sidecar for `thing`.
    writeFileSync(join(root, "objects", "thing.meta"), "text/plain");

    const created = await store.create("thing.meta", suffixBytes);
    expect(created).toMatchObject({ key: "thing.meta", size: suffixBytes.byteLength });
    expect(
      new Uint8Array(await new Response((await store.get("thing"))?.body).arrayBuffer()),
    ).toEqual(siblingBytes);
    expect((await store.head("thing"))?.contentType).toBe("text/plain");
    expect((await store.head("thing"))?.etag).toBe(
      (await bytesDigest(siblingBytes)).slice("sha256:".length),
    );
    expect(
      new Uint8Array(await new Response((await store.get("thing.meta"))?.body).arrayBuffer()),
    ).toEqual(suffixBytes);
    expect((await store.head("thing.meta"))?.size).toBe(suffixBytes.byteLength);

    const reopened = createFileObjectStore({ root });
    expect((await reopened.head("thing"))?.contentType).toBe("text/plain");
    expect((await reopened.head("thing"))?.etag).toBe(
      (await bytesDigest(siblingBytes)).slice("sha256:".length),
    );
    expect((await reopened.head("thing.meta"))?.size).toBe(suffixBytes.byteLength);
    expect(
      (await reopened.list({ prefix: "", limit: 100 })).objects.map((object) => object.key),
    ).toEqual(["thing", "thing.meta"]);
  });

  test("hides and deletes a legacy meta sidecar before preserving the sibling across restart", async () => {
    const siblingBytes = new Uint8Array([3]);
    mkdirSync(join(root, "objects"), { recursive: true });
    writeFileSync(join(root, "objects", "thing"), siblingBytes);
    // This pathname was only a content-type sidecar before terminal `.meta`
    // keys were accepted by the object API.
    writeFileSync(join(root, "objects", "thing.meta"), "text/plain");

    expect(await store.get("thing.meta")).toBeNull();
    expect(await store.head("thing.meta")).toBeNull();
    expect(
      (await store.list({ prefix: "", limit: 100 })).objects.map((object) => object.key),
    ).toEqual(["thing"]);
    expect(await store.delete("thing.meta")).toBe(false);
    expect((await store.head("thing"))?.contentType).toBe("text/plain");
    expect(
      new Uint8Array(await new Response((await store.get("thing"))?.body).arrayBuffer()),
    ).toEqual(siblingBytes);

    const reopened = createFileObjectStore({ root });
    expect(await reopened.get("thing.meta")).toBeNull();
    expect(await reopened.head("thing.meta")).toBeNull();
    expect((await reopened.head("thing"))?.contentType).toBe("text/plain");

    const terminalBytes = new Uint8Array([4]);
    expect(await reopened.create("thing.meta", terminalBytes)).not.toBeNull();
    expect((await reopened.head("thing"))?.contentType).toBe("text/plain");
    expect((await reopened.head("thing.meta"))?.size).toBe(terminalBytes.byteLength);
    expect(
      (await reopened.list({ prefix: "", limit: 100 })).objects.map((object) => object.key),
    ).toEqual(["thing", "thing.meta"]);

    expect(await reopened.delete("thing.meta")).toBe(true);
    expect(await reopened.head("thing.meta")).toBeNull();
    expect((await reopened.head("thing"))?.contentType).toBe("text/plain");
    expect(
      new Uint8Array(await new Response((await reopened.get("thing"))?.body).arrayBuffer()),
    ).toEqual(siblingBytes);

    const afterRestart = createFileObjectStore({ root });
    expect((await afterRestart.head("thing"))?.contentType).toBe("text/plain");
    expect(await afterRestart.head("thing.meta")).toBeNull();
    expect(
      (await afterRestart.list({ prefix: "", limit: 100 })).objects.map((object) => object.key),
    ).toEqual(["thing"]);
  });

  test("serializes concurrent first creates while migrating a legacy meta sidecar", async () => {
    mkdirSync(join(root, "objects"), { recursive: true });
    writeFileSync(join(root, "objects", "thing"), new Uint8Array([1]));
    writeFileSync(join(root, "objects", "thing.meta"), "text/plain");

    const secondStore = createFileObjectStore({ root });
    const [first, second] = await Promise.all([
      store.create("thing.meta", new Uint8Array([2])),
      secondStore.create("thing.meta", new Uint8Array([3])),
    ]);
    expect([first, second].filter((result) => result !== null)).toHaveLength(1);
    expect((await store.head("thing"))?.contentType).toBe("text/plain");
    expect((await store.head("thing.meta"))?.size).toBe(1);
    expect(
      (await store.list({ prefix: "", limit: 100 })).objects.map((object) => object.key),
    ).toEqual(["thing", "thing.meta"]);
  });

  test("serializes a base mutation with terminal-meta migration", async () => {
    mkdirSync(join(root, "objects"), { recursive: true });
    writeFileSync(join(root, "objects", "thing"), new Uint8Array([1]));
    writeFileSync(join(root, "objects", "thing.meta"), "text/plain");

    const secondStore = createFileObjectStore({ root });
    await Promise.all([
      store.put("thing", new Uint8Array([5]), { contentType: "application/octet-stream" }),
      secondStore.create("thing.meta", new Uint8Array([6])),
    ]);

    const siblingHead = await store.head("thing");
    expect(siblingHead?.size).toBe(1);
    if (!siblingHead) throw new Error("sibling body disappeared");
    expect(["text/plain", "application/octet-stream"]).toContain(siblingHead.contentType ?? "");
    const siblingBody = new Uint8Array(
      await new Response((await store.get("thing"))?.body).arrayBuffer(),
    );
    expect([1, 5]).toContain(siblingBody[0] ?? -1);
    expect((await store.head("thing.meta"))?.size).toBe(1);
    expect(
      (await store.list({ prefix: "", limit: 100 })).objects.map((object) => object.key),
    ).toEqual(["thing", "thing.meta"]);
  });

  test("refuses a second live writer process without waiting", async () => {
    const child = spawnFileStoreWriter(root, "child-owned", "child", true);
    try {
      await waitForChildReady(child);
      await expect(
        store.put("parent-refused", new TextEncoder().encode("parent")),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(existsSync(join(root, "objects", "parent-refused"))).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("recovers writer authority after the prior process exits", async () => {
    const child = spawnFileStoreWriter(root, "child-finished", "child", false);
    await waitForChildReady(child);
    expect(await child.exited).toBe(0);

    await store.put("parent-after-exit", new TextEncoder().encode("parent"));
    expect(await new Response((await store.get("child-finished"))?.body).text()).toBe("child");
    expect(await new Response((await store.get("parent-after-exit"))?.body).text()).toBe("parent");
  });

  test("recovers a same-PID claim carrying a prior process token", async () => {
    writeFileSync(
      join(root, ".object-store-writer.json"),
      JSON.stringify({
        version: 1,
        pid: process.pid,
        token: "00000000-0000-4000-8000-000000000000",
      }),
    );

    await store.put("after-same-pid-restart", new TextEncoder().encode("available"));
    expect(await new Response((await store.get("after-same-pid-restart"))?.body).text()).toBe(
      "available",
    );
  });

  test("recovers a legacy PID-only claim from a prior same-PID incarnation", async () => {
    writeFileSync(join(root, ".object-store-writer.json"), JSON.stringify({ pid: process.pid }));

    await store.put("after-legacy-restart", new TextEncoder().encode("available"));
    expect(await new Response((await store.get("after-legacy-restart"))?.body).text()).toBe(
      "available",
    );
  });

  test("recovers a live foreign PID whose Linux process fingerprint does not match", async () => {
    if (process.platform !== "linux") return;
    const child = spawnIdleProcess();
    try {
      await waitForChildReady(child);
      writeFileSync(
        join(root, ".object-store-writer.json"),
        JSON.stringify({
          version: 1,
          pid: child.pid,
          token: "00000000-0000-4000-8000-000000000000",
          linuxProcess: {
            bootId: "00000000-0000-4000-8000-000000000000",
            startTimeTicks: "1",
          },
        }),
      );

      await store.put("after-pid-reuse", new TextEncoder().encode("available"));
      expect(await new Response((await store.get("after-pid-reuse"))?.body).text()).toBe(
        "available",
      );
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("refuses an unverifiable legacy claim held by a live foreign PID", async () => {
    const child = spawnIdleProcess();
    try {
      await waitForChildReady(child);
      writeFileSync(join(root, ".object-store-writer.json"), JSON.stringify({ pid: child.pid }));

      await expect(
        store.put("foreign-live-legacy", new TextEncoder().encode("refused")),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(existsSync(join(root, "objects", "foreign-live-legacy"))).toBe(false);
    } finally {
      child.kill();
      await child.exited;
    }
  });

  test("removes a stale old staging pathname before accepting its terminal partial key", async () => {
    const fixedNow = 1_700_000_000_001;
    const staleKey = `stale.${process.pid}.${fixedNow}.partial`;
    const stalePath = join(root, "objects", staleKey);
    const replacement = new Uint8Array([6]);
    mkdirSync(join(root, "objects"), { recursive: true });
    writeFileSync(stalePath, new Uint8Array([9]));
    expect(await store.get(staleKey)).toBeNull();
    expect(await store.head(staleKey)).toBeNull();
    expect(
      (await store.list({ prefix: "", limit: 100 })).objects.map((object) => object.key),
    ).toEqual([]);
    expect(await store.delete(staleKey)).toBe(false);
    expect(await store.get(staleKey)).toBeNull();
    const originalNow = Date.now;
    Date.now = () => fixedNow;
    try {
      expect(await store.create(staleKey, replacement)).not.toBeNull();
    } finally {
      Date.now = originalNow;
    }
    expect(
      new Uint8Array(await new Response((await store.get(staleKey))?.body).arrayBuffer()),
    ).toEqual(replacement);
  });

  test("rejects non-positive and non-integer list limits", async () => {
    for (const limit of [0, -1, Number.NaN, 1.5]) {
      const listed = store.list({ prefix: "", limit });
      await expect(listed).rejects.toBeInstanceOf(ObjectStoreError);
      await expect(listed).rejects.toMatchObject({ code: "invalid" });
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

  test("matches memory string-prefix semantics for sibling and nested keys", async () => {
    const memory = createMemoryObjectStore();
    const keys = [
      "foo/a",
      "foo/nested/b",
      "foob/c",
      "foob/nested/d",
      "f/nested/e",
      "f-other",
      "pkg/nested.meta/payload.txt",
      "pkg/nested.partial/payload.txt",
    ];
    for (const [index, key] of keys.entries()) {
      const bytes = new Uint8Array([index]);
      await store.put(key, bytes);
      await memory.put(key, bytes);
    }

    const collectPages = async (objects: ObjectStore, prefix: string) => {
      const pages: Array<{
        readonly keys: readonly string[];
        readonly truncated: boolean;
        readonly cursor?: string;
      }> = [];
      let cursor: string | undefined;
      do {
        const page = await objects.list({
          prefix,
          limit: 2,
          ...(cursor === undefined ? {} : { cursor }),
        });
        pages.push({
          keys: page.objects.map((object) => object.key),
          truncated: page.truncated,
          ...(page.cursor === undefined ? {} : { cursor: page.cursor }),
        });
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
      return pages;
    };

    for (const prefix of ["foo", "foob", "f", "foo/", "f/nested/", "pkg", "pkg/"]) {
      await expect(collectPages(store, prefix)).resolves.toEqual(
        await collectPages(memory, prefix),
      );
    }
  });

  test("directs an exact package prefix without enumerating sibling digest trees", async () => {
    const digestRoot = join(root, "objects", "formpkg", "v1", "sha256");
    mkdirSync(digestRoot, { recursive: true });
    const target = "sha256-target";
    for (let index = 0; index < 1_100; index += 1) {
      const digest = `sha256-${index.toString().padStart(4, "0")}`;
      const directory = join(digestRoot, digest);
      mkdirSync(directory, { recursive: true });
      writeFileSync(join(directory, "package-index.json"), new Uint8Array([index % 256]));
    }
    const targetDirectory = join(digestRoot, target);
    mkdirSync(targetDirectory, { recursive: true });
    writeFileSync(join(targetDirectory, "package-index.json"), new Uint8Array([1]));

    const page = await store.list({
      prefix: `formpkg/v1/sha256/${target}/`,
      limit: 100,
    });
    expect(page.objects.map((object) => object.key)).toEqual([
      `formpkg/v1/sha256/${target}/package-index.json`,
    ]);
    expect(page.truncated).toBe(false);
  });

  test("fails closed when a partial-prefix traversal has too many entries", async () => {
    const directory = join(root, "objects", "partial-prefix");
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index <= 1_025; index += 1) {
      writeFileSync(join(directory, `entry-${index}`), new Uint8Array([index % 256]));
    }

    await expect(store.list({ prefix: "partial-prefix/", limit: 1 })).rejects.toMatchObject({
      code: "unavailable",
    });
  });

  test("lists the full valid package closure including metadata sidecars", async () => {
    const prefix = "formpkg/max/";
    await store.create(`${prefix}package-index.json`, new Uint8Array());
    for (let index = 0; index < 1_024; index += 1) {
      await store.put(
        `${prefix}payload-${index.toString().padStart(4, "0")}`,
        new Uint8Array([index]),
      );
    }

    const first = await store.list({ prefix, limit: 1_000 });
    expect(first.objects).toHaveLength(1_000);
    expect(first.truncated).toBe(true);
    const second = await store.list({
      prefix,
      limit: 1_000,
      ...(first.cursor === undefined ? {} : { cursor: first.cursor }),
    });
    expect(second.objects).toHaveLength(25);
    expect(second.truncated).toBe(false);
    expect(new Set([...first.objects, ...second.objects].map((object) => object.key)).size).toBe(
      1_025,
    );
    // 1,025 durable single-object writes plus two full listings: slow shared
    // CI disks need far more than the default per-test budget for this volume.
  }, 60_000);

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

  test("streams an existing object instead of buffering it before a package cap", async () => {
    const path = join(root, "objects", "large.bin");
    mkdirSync(join(root, "objects"), { recursive: true });
    writeFileSync(path, new Uint8Array(64 * 1024 + 1));
    const found = await store.get("large.bin");
    expect(found?.size).toBe(64 * 1024 + 1);
    await expect(
      readBoundedFormPackageStream(found?.body as ReadableStream<Uint8Array>, 1),
    ).rejects.toMatchObject({ kind: "overrun" });
  });

  test("rejects an append after the initial object stat", async () => {
    await store.put("mutable", new Uint8Array([1]));
    const found = await store.get("mutable");
    appendFileSync(join(root, "objects", "mutable"), new Uint8Array([2]));

    await expect(
      readBoundedFormPackageStream(found?.body as ReadableStream<Uint8Array>, 1, 1),
    ).rejects.toThrow("object changed while reading");
  });

  test("rejects a pathname replacement after the initial object stat", async () => {
    await store.put("mutable", new Uint8Array([1]));
    const found = await store.get("mutable");
    const replacement = join(root, "objects", "mutable.replacement");
    writeFileSync(replacement, new Uint8Array([9]));
    renameSync(replacement, join(root, "objects", "mutable"));

    await expect(
      readBoundedFormPackageStream(found?.body as ReadableStream<Uint8Array>, 1, 1),
    ).rejects.toThrow("object changed while reading");
  });

  test("rejects an intermediate directory replaced by an outside symlink after opening", async () => {
    const outside = mkdtempSync(join(tmpdir(), "takoserver-objects-outside-"));
    try {
      await store.put("nested/mutable", new Uint8Array([1]));
      const found = await store.get("nested/mutable");
      writeFileSync(join(outside, "mutable"), new Uint8Array([9]));
      renameSync(join(root, "objects", "nested"), join(root, "objects", "nested-original"));
      symlinkSync(outside, join(root, "objects", "nested"), "dir");

      await expect(
        readBoundedFormPackageStream(found?.body as ReadableStream<Uint8Array>, 1, 1),
      ).rejects.toThrow("object changed while reading");
      expect(new Uint8Array(readFileSync(join(outside, "mutable")))).toEqual(new Uint8Array([9]));
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("bounds malformed metadata sidecars before reading them", async () => {
    await store.put("sidecar", new Uint8Array([1]));
    writeFileSync(join(root, "objects", "sidecar.meta"), "x".repeat(64 * 1024));

    await expect(store.get("sidecar")).resolves.toMatchObject({
      key: "sidecar",
      size: 1,
    });
    expect((await store.get("sidecar"))?.contentType).toBeUndefined();
    expect((await store.list({ prefix: "", limit: 100 })).objects[0]?.contentType).toBeUndefined();
  });

  test("round-trips a Form Package through the filesystem ObjectStore seam", async () => {
    const formRef = {
      apiVersion: "example.forms.test/v1alpha1",
      kind: "Widget",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    } as const;
    const bytes = new TextEncoder().encode("package payload");
    const files = [
      {
        path: "payload.txt",
        digest: await bytesDigest(bytes),
        size: bytes.byteLength,
        mediaType: "text/plain" as const,
      },
    ];
    const packageDigest = await canonicalDigest(packageManifest({ formRef, files }));
    const packages = createFormPackageStore(store);
    await packages.put({
      packageDigest,
      formRef,
      files: [{ path: "payload.txt", bytes, mediaType: "text/plain" }],
    });
    await expect(packages.read({ packageDigest, formRef })).resolves.toMatchObject({
      packageDigest,
    });
  });
});
