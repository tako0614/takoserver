import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import type { Sql } from "../src/ports.ts";
import {
  createSelfhostObjectStore,
  MIN_SELFHOST_OBJECT_NON_FINAL_PART_BYTES,
  SELFHOST_OBJECT_UPLOAD_LIFETIME_MS,
  SelfhostObjectError,
  type SelfhostObjectStore,
} from "../src/selfhost-object-store.ts";

/**
 * The `edge.objects` contract, against the store that actually holds bytes.
 *
 * What is worth testing here rather than at the facade is everything the facade
 * cannot decide: that a range is a `pread` rather than a truncated read, that
 * an etag actually commits to the bytes, that a multipart receipt survives
 * being written down, and that two bucket incarnations never see each other —
 * including when a customer picks a key that looks like a path.
 */

const BUCKET_A = `tsb-${"a".repeat(40)}`;
const BUCKET_B = `tsb-${"b".repeat(40)}`;

let root: string;
let sql: Sql;
let store: SelfhostObjectStore;
let counter: number;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-objects-"));
  sql = createEphemeralSql();
  counter = 0;
  store = createSelfhostObjectStore({
    sql,
    root,
    clock: () => new Date("2026-09-02T00:00:00.000Z"),
    identifier: () => {
      counter += 1;
      return counter.toString(16).padStart(32, "0");
    },
  });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function bytes(value: string): ReadableStream<Uint8Array> {
  const encoded = new TextEncoder().encode(value);
  return new Blob([encoded]).stream() as ReadableStream<Uint8Array>;
}

function filler(size: number, seed: string): ReadableStream<Uint8Array> {
  const chunk = new Uint8Array(size);
  chunk.fill(seed.charCodeAt(0));
  return new Blob([chunk]).stream() as ReadableStream<Uint8Array>;
}

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return await new Response(stream).text();
}

async function put(key: string, value: string, options: Record<string, unknown> = {}) {
  return await store.put(BUCKET_A, key, bytes(value), {
    contentLength: new TextEncoder().encode(value).byteLength,
    ...options,
  } as never);
}

async function failure(operation: Promise<unknown>): Promise<string> {
  try {
    await operation;
  } catch (error) {
    return error instanceof SelfhostObjectError ? error.code : `unexpected:${String(error)}`;
  }
  return "none";
}

describe("the self-host object store", () => {
  test("round-trips a body, its etag, and its content type", async () => {
    const written = await put("greeting", "hello objects", { contentType: "text/plain" });
    expect(written.size).toBe(13);
    expect(written.etag).toMatch(/^[0-9a-f]{64}$/u);

    const head = await store.head(BUCKET_A, "greeting");
    expect(head).toEqual({
      etag: written.etag,
      size: 13,
      contentType: "text/plain",
      uploadedAtMillis: Date.parse("2026-09-02T00:00:00.000Z"),
    });

    const found = await store.get(BUCKET_A, "greeting");
    if (!found) throw new Error("object missing");
    expect(found.partial).toBe(false);
    expect(found.range).toBeUndefined();
    expect(await text(found.body)).toBe("hello objects");
    expect(await store.head(BUCKET_A, "absent")).toBeNull();
    expect(await store.get(BUCKET_A, "absent")).toBeNull();
  });

  test("serves an exact byte range and refuses one past the end", async () => {
    await put("ranged", "0123456789");
    const middle = await store.get(BUCKET_A, "ranged", { range: { offset: 3, length: 4 } });
    if (!middle) throw new Error("object missing");
    expect(middle.partial).toBe(true);
    expect(middle.range).toEqual({ offset: 3, length: 4 });
    expect(middle.size).toBe(10);
    expect(await text(middle.body)).toBe("3456");

    const tail = await store.get(BUCKET_A, "ranged", { range: { offset: 7 } });
    if (!tail) throw new Error("object missing");
    expect(await text(tail.body)).toBe("789");
    // A length that runs past the object is clamped, exactly as R2 clamps it.
    const clamped = await store.get(BUCKET_A, "ranged", { range: { offset: 8, length: 999 } });
    expect(clamped?.range).toEqual({ offset: 8, length: 2 });
    expect(await failure(store.get(BUCKET_A, "ranged", { range: { offset: 10 } }))).toBe(
      "range_not_satisfiable",
    );
    // A range on an object that is not there is an absence, not a range error.
    expect(await store.get(BUCKET_A, "absent", { range: { offset: 0 } })).toBeNull();

    // And an empty object has no byte at offset 0 either. The managed adapter
    // heads first and refuses any offset at or past the size, so an exemption
    // for a zero-byte object would make one portable Binding answer two ways
    // depending on which Takoserver backend was behind it.
    await store.put(BUCKET_A, "empty", bytes(""), { contentLength: 0 });
    expect((await store.head(BUCKET_A, "empty"))?.size).toBe(0);
    expect(await failure(store.get(BUCKET_A, "empty", { range: { offset: 0 } }))).toBe(
      "range_not_satisfiable",
    );
    expect(await failure(store.get(BUCKET_A, "empty", { range: { offset: 0, length: 1 } }))).toBe(
      "range_not_satisfiable",
    );
    // Without a range it is still an ordinary, empty answer.
    const whole = await store.get(BUCKET_A, "empty");
    expect(whole?.partial).toBe(false);
    expect(await text(whole?.body as never)).toBe("");
  });

  test("honours ifMatch and ifNoneMatch on both halves", async () => {
    const first = await put("conditional", "one");
    expect(await failure(put("conditional", "two", { ifNoneMatch: "*" }))).toBe(
      "precondition_failed",
    );
    expect(await text((await store.get(BUCKET_A, "conditional"))?.body as never)).toBe("one");

    expect(await failure(put("conditional", "two", { ifMatch: "not-the-etag" }))).toBe(
      "precondition_failed",
    );
    const second = await put("conditional", "two", { ifMatch: first.etag });
    expect(second.etag).not.toBe(first.etag);
    expect(await text((await store.get(BUCKET_A, "conditional"))?.body as never)).toBe("two");

    expect(await failure(store.get(BUCKET_A, "conditional", { ifMatch: first.etag }))).toBe(
      "precondition_failed",
    );
    expect(await failure(store.get(BUCKET_A, "conditional", { ifNoneMatch: second.etag }))).toBe(
      "precondition_failed",
    );
    const still = await store.get(BUCKET_A, "conditional", { ifNoneMatch: first.etag });
    expect(await text(still?.body as never)).toBe("two");

    // A create-if-absent on a key nobody holds is an ordinary write.
    const fresh = await put("fresh", "new", { ifNoneMatch: "*" });
    expect(fresh.size).toBe(3);
    // An ifMatch on an absent key has nothing to match.
    expect(await failure(put("nothing", "x", { ifMatch: fresh.etag }))).toBe("precondition_failed");
    expect(await store.head(BUCKET_A, "nothing")).toBeNull();
  });

  test("refuses a body that is not exactly the declared length", async () => {
    expect(await failure(store.put(BUCKET_A, "short", bytes("abc"), { contentLength: 4 }))).toBe(
      "invalid_body",
    );
    expect(await failure(store.put(BUCKET_A, "long", bytes("abcdef"), { contentLength: 2 }))).toBe(
      "invalid_body",
    );
    expect(await store.head(BUCKET_A, "short")).toBeNull();
    expect(await store.head(BUCKET_A, "long")).toBeNull();
  });

  test("holds the exact edge.objects ceilings", async () => {
    expect(
      await failure(store.put(BUCKET_A, "huge", bytes(""), { contentLength: 314_572_801 })),
    ).toBe("value_too_large");
    expect(await failure(store.head(BUCKET_A, "a".repeat(980)))).toBe("invalid_key");
    expect(await failure(store.head(BUCKET_A, ""))).toBe("invalid_key");
    expect(await failure(store.head(BUCKET_A, "with\u0000nul"))).toBe("invalid_key");
    // 979 bytes exactly is a key, not a refusal.
    const longest = "k".repeat(979);
    await put(longest, "ok");
    expect((await store.head(BUCKET_A, longest))?.size).toBe(2);
  });

  test("lists in key order with prefix, delimiter, cursor, and limit", async () => {
    for (const key of ["a/1", "a/2", "b", "c/d/e", "c/f", "z"]) await put(key, key);

    const all = await store.list(BUCKET_A);
    expect(all.objects.map((object) => object.key)).toEqual([
      "a/1",
      "a/2",
      "b",
      "c/d/e",
      "c/f",
      "z",
    ]);
    expect(all.truncated).toBe(false);
    expect(all.prefixes).toEqual([]);

    const folders = await store.list(BUCKET_A, { delimiter: "/" });
    expect(folders.objects.map((object) => object.key)).toEqual(["b", "z"]);
    expect(folders.prefixes).toEqual(["a/", "c/"]);

    const inside = await store.list(BUCKET_A, { prefix: "c/", delimiter: "/" });
    expect(inside.objects.map((object) => object.key)).toEqual(["c/f"]);
    expect(inside.prefixes).toEqual(["c/d/"]);

    const first = await store.list(BUCKET_A, { limit: 2 });
    expect(first.objects.map((object) => object.key)).toEqual(["a/1", "a/2"]);
    expect(first.truncated).toBe(true);
    expect(typeof first.cursor).toBe("string");
    const second = await store.list(BUCKET_A, { limit: 2, cursor: first.cursor as string });
    expect(second.objects.map((object) => object.key)).toEqual(["b", "c/d/e"]);
    const third = await store.list(BUCKET_A, { limit: 2, cursor: second.cursor as string });
    expect(third.objects.map((object) => object.key)).toEqual(["c/f", "z"]);
    expect(third.truncated).toBe(false);

    // A page that stops inside a rolled-up group resumes past the group rather
    // than repeating it.
    const paged = await store.list(BUCKET_A, { delimiter: "/", limit: 1 });
    expect(paged.prefixes).toEqual(["a/"]);
    expect(paged.truncated).toBe(true);
    const rest = await store.list(BUCKET_A, {
      delimiter: "/",
      limit: 10,
      cursor: paged.cursor as string,
    });
    expect(rest.prefixes).toEqual(["c/"]);
    expect(rest.objects.map((object) => object.key)).toEqual(["b", "z"]);

    expect(await failure(store.list(BUCKET_A, { cursor: "not base64url!!" }))).toBe(
      "invalid_cursor",
    );
  });

  test("keeps a prefix a range rather than a LIKE pattern", async () => {
    for (const key of ["100%off", "1_0", "110", "1x"]) await put(key, key);
    const listed = await store.list(BUCKET_A, { prefix: "1_" });
    expect(listed.objects.map((object) => object.key)).toEqual(["1_0"]);
    const percent = await store.list(BUCKET_A, { prefix: "100%" });
    expect(percent.objects.map((object) => object.key)).toEqual(["100%off"]);
  });

  test("completes a real multipart upload and refuses a short non-final part", async () => {
    const created = await store.createMultipartUpload(BUCKET_A, "movie", {
      contentType: "video/mp4",
    });
    const size = MIN_SELFHOST_OBJECT_NON_FINAL_PART_BYTES;
    const one = await store.uploadPart(BUCKET_A, "movie", created.uploadId, 1, filler(size, "x"), {
      contentLength: size,
    });
    const two = await store.uploadPart(BUCKET_A, "movie", created.uploadId, 2, bytes("tail"), {
      contentLength: 4,
    });
    expect(one.partNumber).toBe(1);
    expect(two.partNumber).toBe(2);
    // Nothing is visible until the upload completes.
    expect(await store.head(BUCKET_A, "movie")).toBeNull();

    // Out of order, an unknown part, a wrong etag, and a short non-final part
    // are each refused before a byte is assembled.
    expect(
      await failure(
        store.completeMultipartUpload(BUCKET_A, "movie", created.uploadId, [
          { etag: two.etag, partNumber: 2 },
          { etag: one.etag, partNumber: 1 },
        ]),
      ),
    ).toBe("invalid_part");
    expect(
      await failure(
        store.completeMultipartUpload(BUCKET_A, "movie", created.uploadId, [
          { etag: one.etag, partNumber: 1 },
          { etag: "wrong", partNumber: 2 },
        ]),
      ),
    ).toBe("invalid_part");
    const three = await store.uploadPart(BUCKET_A, "movie", created.uploadId, 3, bytes("more"), {
      contentLength: 4,
    });
    expect(
      await failure(
        store.completeMultipartUpload(BUCKET_A, "movie", created.uploadId, [
          { etag: two.etag, partNumber: 2 },
          { etag: three.etag, partNumber: 3 },
        ]),
      ),
    ).toBe("invalid_part");
    expect(
      await failure(
        store.completeMultipartUpload(BUCKET_A, "movie", created.uploadId, [
          { etag: one.etag, partNumber: 1 },
          { etag: one.etag, partNumber: 9 },
        ]),
      ),
    ).toBe("invalid_part");

    const completed = await store.completeMultipartUpload(BUCKET_A, "movie", created.uploadId, [
      { etag: one.etag, partNumber: 1 },
      { etag: two.etag, partNumber: 2 },
    ]);
    expect(completed.size).toBe(size + 4);
    expect(completed.etag).toMatch(/^[0-9a-f]{64}-2$/u);
    const head = await store.head(BUCKET_A, "movie");
    expect(head?.contentType).toBe("video/mp4");
    const tail = await store.get(BUCKET_A, "movie", { range: { offset: size, length: 4 } });
    expect(await text(tail?.body as never)).toBe("tail");
    // The receipt is spent: completing again has no upload to complete.
    expect(
      await failure(
        store.completeMultipartUpload(BUCKET_A, "movie", created.uploadId, [
          { etag: one.etag, partNumber: 1 },
          { etag: two.etag, partNumber: 2 },
        ]),
      ),
    ).toBe("upload_not_found");
  });

  test("keeps multipart receipts durable rather than in memory", async () => {
    const created = await store.createMultipartUpload(BUCKET_A, "durable", {});
    const part = await store.uploadPart(BUCKET_A, "durable", created.uploadId, 1, bytes("kept"), {
      contentLength: 4,
    });
    // A second store over the same database and root is the restart: nothing
    // about the upload lived in the first one's memory.
    const restarted = createSelfhostObjectStore({ sql, root });
    const completed = await restarted.completeMultipartUpload(
      BUCKET_A,
      "durable",
      created.uploadId,
      [{ etag: part.etag, partNumber: 1 }],
    );
    expect(completed.size).toBe(4);
    expect(await text((await restarted.get(BUCKET_A, "durable"))?.body as never)).toBe("kept");
  });

  test("aborts an upload and forgets its parts and its files", async () => {
    const created = await store.createMultipartUpload(BUCKET_A, "abandoned", {});
    await store.uploadPart(BUCKET_A, "abandoned", created.uploadId, 1, bytes("half"), {
      contentLength: 4,
    });
    expect((await store.occupancy(BUCKET_A)).uploads).toBe(1);
    await store.abortMultipartUpload(BUCKET_A, "abandoned", created.uploadId);
    expect((await store.occupancy(BUCKET_A)).uploads).toBe(0);
    expect(await failure(store.abortMultipartUpload(BUCKET_A, "abandoned", created.uploadId))).toBe(
      "upload_not_found",
    );
    expect(
      await failure(
        store.uploadPart(BUCKET_A, "abandoned", created.uploadId, 1, bytes("x"), {
          contentLength: 1,
        }),
      ),
    ).toBe("upload_not_found");
    // An upload belongs to one key, and another key may not spend it.
    const other = await store.createMultipartUpload(BUCKET_A, "one", {});
    expect(
      await failure(
        store.uploadPart(BUCKET_A, "two", other.uploadId, 1, bytes("x"), { contentLength: 1 }),
      ),
    ).toBe("upload_not_found");
  });

  test("never lets a key become a filesystem path", async () => {
    for (const key of ["../../escape", "a/../../b", "/etc/passwd", "..", "nested/deep/key"]) {
      await put(key, key);
      expect(await text((await store.get(BUCKET_A, key))?.body as never)).toBe(key);
    }
    // Every body is under the bucket's own directory at a name this store
    // minted; nothing a customer wrote appears in the tree.
    const entries = await readdir(join(root, BUCKET_A, "o"), { recursive: true });
    expect(entries.some((entry) => entry.includes("escape") || entry.includes("passwd"))).toBe(
      false,
    );
    expect(await readdir(root)).toEqual([BUCKET_A]);
  });

  test("isolates one bucket incarnation from another", async () => {
    await put("shared", "bucket a");
    await store.put(BUCKET_B, "shared", bytes("bucket b"), { contentLength: 8 });
    expect(await text((await store.get(BUCKET_A, "shared"))?.body as never)).toBe("bucket a");
    expect(await text((await store.get(BUCKET_B, "shared"))?.body as never)).toBe("bucket b");
    expect((await store.list(BUCKET_B)).objects.map((object) => object.key)).toEqual(["shared"]);

    await store.delete(BUCKET_A, "shared");
    expect(await store.head(BUCKET_A, "shared")).toBeNull();
    expect((await store.head(BUCKET_B, "shared"))?.size).toBe(8);
    // Deleting a key that is not there is not an error.
    await store.delete(BUCKET_A, "shared");
  });

  test("refuses a bucket id this Host did not derive", async () => {
    for (const bucket of ["../etc", "tsb-short", "not-a-bucket", `tsb-${"A".repeat(40)}`]) {
      expect(await failure(store.head(bucket, "key"))).toBe("backend_unavailable");
      expect(await failure(store.list(bucket))).toBe("backend_unavailable");
      expect(await failure(store.occupancy(bucket))).toBe("backend_unavailable");
    }
  });

  test("keeps every directory 0700 and every body 0600", async () => {
    await put("private", "bytes");
    const created = await store.createMultipartUpload(BUCKET_A, "private", {});
    await store.uploadPart(BUCKET_A, "private", created.uploadId, 1, bytes("part"), {
      contentLength: 4,
    });
    const walk = async (directory: string): Promise<void> => {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const mode = statSync(path).mode & 0o777;
        expect(mode & 0o077).toBe(0);
        expect(mode).toBe(entry.isDirectory() ? 0o700 : 0o600);
        if (entry.isDirectory()) await walk(path);
      }
    };
    await walk(join(root, BUCKET_A));
  });

  test("reports occupancy and destroys a bucket whole", async () => {
    await put("one", "a");
    await put("two", "b");
    const created = await store.createMultipartUpload(BUCKET_A, "three", {});
    await store.uploadPart(BUCKET_A, "three", created.uploadId, 1, bytes("c"), {
      contentLength: 1,
    });
    await store.put(BUCKET_B, "elsewhere", bytes("kept"), { contentLength: 4 });
    expect(await store.occupancy(BUCKET_A)).toEqual({ objects: 2, uploads: 1 });

    await store.destroy(BUCKET_A);
    expect(await store.occupancy(BUCKET_A)).toEqual({ objects: 0, uploads: 0 });
    expect((await store.list(BUCKET_A)).objects).toEqual([]);
    expect(await readdir(root)).toEqual([BUCKET_B]);
    expect((await store.head(BUCKET_B, "elsewhere"))?.size).toBe(4);
  });

  test("reclaims an abandoned multipart upload and its part files", async () => {
    // The deadlock this exists for: the uploadId lived in the isolate that
    // called createMultipartUpload, no operation the Binding declares
    // enumerates open uploads, and durable receipts are exactly what would
    // otherwise keep this one for the life of the machine.
    const abandoned = await store.createMultipartUpload(BUCKET_A, "lost", {});
    await store.uploadPart(BUCKET_A, "lost", abandoned.uploadId, 1, bytes("half"), {
      contentLength: 4,
    });
    expect((await store.occupancy(BUCKET_A)).uploads).toBe(1);
    expect(await readdir(join(root, BUCKET_A, "u"))).toEqual([abandoned.uploadId]);

    // A fresh upload is not expired: the bound is measured from the create.
    expect(await store.sweepExpiredUploads()).toBe(0);
    expect((await store.occupancy(BUCKET_A)).uploads).toBe(1);

    const clock = Date.parse("2026-09-02T00:00:00.000Z");
    expect(await store.sweepExpiredUploads({ before: clock - 1 })).toBe(0);
    expect(await store.sweepExpiredUploads({ before: clock })).toBe(1);
    expect((await store.occupancy(BUCKET_A)).uploads).toBe(0);
    expect(await readdir(join(root, BUCKET_A, "u"))).toEqual([]);
    expect(
      await failure(
        store.uploadPart(BUCKET_A, "lost", abandoned.uploadId, 1, bytes("x"), {
          contentLength: 1,
        }),
      ),
    ).toBe("upload_not_found");
    expect(SELFHOST_OBJECT_UPLOAD_LIFETIME_MS).toBe(7 * 24 * 60 * 60 * 1_000);

    // And the sweep is not a ceiling on the feature: a new upload still
    // completes exactly as it did.
    const fresh = await store.createMultipartUpload(BUCKET_A, "found", {});
    const part = await store.uploadPart(BUCKET_A, "found", fresh.uploadId, 1, bytes("kept"), {
      contentLength: 4,
    });
    const completed = await store.completeMultipartUpload(BUCKET_A, "found", fresh.uploadId, [
      { etag: part.etag, partNumber: 1 },
    ]);
    expect(completed.size).toBe(4);
    expect(await text((await store.get(BUCKET_A, "found"))?.body as never)).toBe("kept");
  });

  test("reclaims a body no row names and a staged file nobody finished", async () => {
    await put("kept", "kept bytes");
    await put("orphaned", "orphan bytes");
    const rows = await sql.query("SELECT storage_id FROM selfhost_objects WHERE key = ?", [
      "orphaned",
    ]);
    const storageId = String((rows[0] as Record<string, unknown>).storage_id);
    // The crash this exists for: the body was renamed into place and the row
    // that would have named it never landed.
    await sql.run("DELETE FROM selfhost_objects WHERE key = ?", ["orphaned"]);
    // And a stage() that died before it published anything.
    const staged = join(root, BUCKET_A, "tmp", "abandoned");
    await mkdir(join(root, BUCKET_A, "tmp"), { recursive: true, mode: 0o700 });
    await writeFile(staged, "half a body", { mode: 0o600 });

    const orphan = join(root, BUCKET_A, "o", storageId.slice(0, 2), storageId);
    expect(statSync(orphan).size).toBe(12);

    // Nothing is old enough yet: the bound is what keeps a sweep from racing a
    // write that is still in flight.
    expect(await store.reconcileOrphanFiles({ before: 0 })).toEqual({
      examined: 3,
      reclaimed: 0,
    });
    expect(statSync(orphan).size).toBe(12);

    const reconciled = await store.reconcileOrphanFiles({ before: Date.now() + 60_000 });
    expect(reconciled).toEqual({ examined: 3, reclaimed: 2 });
    expect(() => statSync(orphan)).toThrow();
    expect(() => statSync(staged)).toThrow();
    // The object a row still names is untouched.
    expect(await text((await store.get(BUCKET_A, "kept"))?.body as never)).toBe("kept bytes");
    expect(await store.reconcileOrphanFiles({ before: Date.now() + 60_000 })).toEqual({
      examined: 1,
      reclaimed: 0,
    });
  });

  test("reconciles a bounded batch and resumes where it stopped", async () => {
    for (let index = 0; index < 6; index += 1) await put(`k${index}`, `body ${index}`);
    await sql.run("DELETE FROM selfhost_objects WHERE bucket_id = ?", [BUCKET_A]);
    const before = Date.now() + 60_000;
    let reclaimed = 0;
    // Two files a pass: a bucket holding a million bodies costs a batch a tick
    // rather than the tick.
    for (let pass = 0; pass < 3; pass += 1) {
      const result = await store.reconcileOrphanFiles({ before, limit: 2 });
      expect(result.examined).toBe(2);
      reclaimed += result.reclaimed;
    }
    expect(reclaimed).toBe(6);
    const files = await readdir(join(root, BUCKET_A, "o"), { recursive: true });
    expect(files.filter((entry) => /[0-9a-f]{32}$/u.test(entry))).toEqual([]);
  });

  test("refuses a complete whose part file no longer holds the bytes it recorded", async () => {
    const created = await store.createMultipartUpload(BUCKET_A, "swapped", {});
    const size = MIN_SELFHOST_OBJECT_NON_FINAL_PART_BYTES;
    const one = await store.uploadPart(
      BUCKET_A,
      "swapped",
      created.uploadId,
      1,
      filler(size, "x"),
      {
        contentLength: size,
      },
    );
    const two = await store.uploadPart(BUCKET_A, "swapped", created.uploadId, 2, bytes("tail"), {
      contentLength: 4,
    });
    // The interleaving a lock on the row would not catch: uploadPart renames a
    // new file over the deterministic part path, so a same-size replacement
    // passes both the recorded size and the assembled total. The bytes are
    // what the receipt is checked against.
    await writeFile(join(root, BUCKET_A, "u", created.uploadId, "2"), "TAIL", { mode: 0o600 });
    expect(
      await failure(
        store.completeMultipartUpload(BUCKET_A, "swapped", created.uploadId, [
          { etag: one.etag, partNumber: 1 },
          { etag: two.etag, partNumber: 2 },
        ]),
      ),
    ).toBe("invalid_part");
    // Nothing was published, and the upload is still there to complete once the
    // parts and their receipts agree again.
    expect(await store.head(BUCKET_A, "swapped")).toBeNull();
    const replaced = await store.uploadPart(
      BUCKET_A,
      "swapped",
      created.uploadId,
      2,
      bytes("TAIL"),
      { contentLength: 4 },
    );
    const completed = await store.completeMultipartUpload(BUCKET_A, "swapped", created.uploadId, [
      { etag: one.etag, partNumber: 1 },
      { etag: replaced.etag, partNumber: 2 },
    ]);
    expect(completed.size).toBe(size + 4);
  });

  test("replaces a body without disturbing a reader that already opened one", async () => {
    const first = await put("racing", "original bytes");
    const opened = await store.get(BUCKET_A, "racing");
    if (!opened) throw new Error("object missing");
    await put("racing", "replacement!!");
    // The stream was resolved against the first row and keeps its own file.
    expect(await text(opened.body)).toBe("original bytes");
    expect(await text((await store.get(BUCKET_A, "racing"))?.body as never)).toBe("replacement!!");
    expect((await store.head(BUCKET_A, "racing"))?.etag).not.toBe(first.etag);
    // And the superseded file is gone rather than accumulating.
    const files = await readdir(join(root, BUCKET_A, "o"), { recursive: true });
    expect(files.filter((entry) => /[0-9a-f]{32}$/u.test(entry))).toHaveLength(1);
  });
});
