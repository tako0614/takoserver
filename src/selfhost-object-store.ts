import { Buffer } from "node:buffer";
import { createHash, randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Sql } from "./ports.ts";

/**
 * What a self-hosted Worker's `bucketBindings` actually talk to.
 *
 * Cloudflare sells R2, so the ordinary-workers backend only has to name a
 * bucket. A machine standing on its own has to be one, and this is it: object
 * bodies are files under the data root, and everything a lookup needs before it
 * opens one — which key exists, how big it is, what its etag is, which file
 * holds it — is a row in the control database under migration 0041.
 *
 * The split is not an accident. An object is up to 5 GiB and a row is not where
 * 5 GiB belongs; a listing is a range scan and a directory walk is not. Keeping
 * the bytes in files is also what makes a ranged get one `pread` rather than a
 * read of the whole value.
 *
 * **A key never becomes a path.** Keys are customer strings, `..` and `/` mean
 * something to a filesystem, and a store that joined them would hand out the
 * machine. Every body lives at a name this module minted — sixteen random bytes
 * as hex — and the key reaches the filesystem only through the row that names
 * that file. The bucket id is the provider's derived
 * `tsb-<40 hex>` incarnation name, which is path-safe by construction and
 * checked again here before it is joined.
 *
 * **A put mints a new file.** Overwriting the file a live row names would
 * replace the bytes under a reader that had already resolved that row's etag
 * and size. So the new body is written, renamed into place, and only then does
 * the row move; the superseded file is dropped afterwards. A reader that
 * resolved the old row and lost the race re-reads the row rather than reporting
 * a missing object.
 *
 * **Multipart receipts are durable.** That is the whole reason a self-host may
 * serve `bucketBindings` where the managed Cloudflare wrapper may not
 * ([ADR 0007](../docs/adr/0007-objectbucket-joins-the-implementation-catalog.md)):
 * a restart between `createMultipartUpload` and `completeMultipartUpload` loses
 * nothing here, so the part sizes and etags a complete is validated against
 * survive it.
 *
 * Directories are `0700` and files `0600`, and both are tightened and re-read
 * rather than created hopefully — `mkdir(mode)` does nothing to a directory an
 * earlier build or an operator's `mkdir -p` already made.
 */

/** The exact ceilings `edge.objects` fixes, enforced here and at the facade. */
export const MAX_SELFHOST_OBJECT_KEY_BYTES = 979;
export const MAX_SELFHOST_OBJECT_BYTES = 5_368_709_120;
export const MAX_SELFHOST_OBJECT_SINGLE_PUT_BYTES = 314_572_800;
export const MAX_SELFHOST_OBJECT_PARTS = 10_000;
export const MIN_SELFHOST_OBJECT_NON_FINAL_PART_BYTES = 5_242_880;
export const MAX_SELFHOST_OBJECT_LIST_LIMIT = 1_000;

/** The bucket ids this store will open a directory for, and nothing else. */
const BUCKET_ID = /^tsb-[0-9a-f]{40}$/u;
const STORAGE_ID = /^[0-9a-f]{32}$/u;
const UPLOAD_ID = /^[0-9a-f]{32}$/u;
const READ_CHUNK_BYTES = 512 * 1_024;

export type SelfhostObjectErrorCode =
  | "invalid_key"
  | "invalid_body"
  | "value_too_large"
  | "precondition_failed"
  | "range_not_satisfiable"
  | "invalid_cursor"
  | "invalid_part"
  | "upload_not_found"
  | "backend_unavailable";

export class SelfhostObjectError extends Error {
  constructor(readonly code: SelfhostObjectErrorCode) {
    super(code);
    this.name = "SelfhostObjectError";
  }
}

export interface SelfhostObjectMetadata {
  readonly etag: string;
  readonly size: number;
  readonly contentType?: string;
  readonly uploadedAtMillis: number;
}

export interface SelfhostObjectBody {
  readonly etag: string;
  readonly size: number;
  readonly contentType?: string;
  readonly body: ReadableStream<Uint8Array>;
  readonly partial: boolean;
  readonly range?: { readonly offset: number; readonly length: number };
}

export interface SelfhostObjectGetOptions {
  readonly range?: { readonly offset: number; readonly length?: number };
  readonly ifMatch?: string;
  readonly ifNoneMatch?: string;
}

export interface SelfhostObjectPutOptions {
  readonly contentLength: number;
  readonly contentType?: string;
  readonly ifMatch?: string;
  readonly ifNoneMatch?: "*";
}

export interface SelfhostObjectListOptions {
  readonly prefix?: string;
  readonly delimiter?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SelfhostObjectListResult {
  readonly objects: readonly {
    readonly key: string;
    readonly etag: string;
    readonly size: number;
    readonly uploadedAtMillis: number;
  }[];
  readonly prefixes: readonly string[];
  readonly truncated: boolean;
  readonly cursor?: string;
}

/** What a bucket still holds; a delete refuses while either is non-zero. */
export interface SelfhostObjectBucketOccupancy {
  readonly objects: number;
  readonly uploads: number;
}

export interface SelfhostObjectStore {
  head(bucketId: string, key: string): Promise<SelfhostObjectMetadata | null>;
  get(
    bucketId: string,
    key: string,
    options?: SelfhostObjectGetOptions,
  ): Promise<SelfhostObjectBody | null>;
  put(
    bucketId: string,
    key: string,
    body: ReadableStream<Uint8Array>,
    options: SelfhostObjectPutOptions,
  ): Promise<{ readonly etag: string; readonly size: number }>;
  delete(bucketId: string, key: string): Promise<void>;
  list(bucketId: string, options?: SelfhostObjectListOptions): Promise<SelfhostObjectListResult>;
  createMultipartUpload(
    bucketId: string,
    key: string,
    options?: { readonly contentType?: string },
  ): Promise<{ readonly uploadId: string }>;
  uploadPart(
    bucketId: string,
    key: string,
    uploadId: string,
    partNumber: number,
    body: ReadableStream<Uint8Array>,
    options: { readonly contentLength: number },
  ): Promise<{ readonly etag: string; readonly partNumber: number }>;
  completeMultipartUpload(
    bucketId: string,
    key: string,
    uploadId: string,
    parts: readonly { readonly etag: string; readonly partNumber: number }[],
  ): Promise<{ readonly etag: string; readonly size: number }>;
  abortMultipartUpload(bucketId: string, key: string, uploadId: string): Promise<void>;
  /** Read-only: what a lifecycle delete has to know before it removes a bucket. */
  occupancy(bucketId: string): Promise<SelfhostObjectBucketOccupancy>;
  /** Drops every row and every file of one bucket incarnation. */
  destroy(bucketId: string): Promise<void>;
}

export interface SelfhostObjectStoreOptions {
  readonly sql: Sql;
  /** Directory holding one subdirectory per bucket incarnation. */
  readonly root: string;
  readonly clock?: () => Date;
  /** Injected so a test can name an upload; 16 random bytes otherwise. */
  readonly identifier?: () => string;
}

export function createSelfhostObjectStore(
  options: SelfhostObjectStoreOptions,
): SelfhostObjectStore {
  const root = resolve(options.root);
  const now = options.clock ?? (() => new Date());
  const identifier = options.identifier ?? (() => randomBytes(16).toString("hex"));
  const sql = options.sql;

  const bucketDirectory = (bucketId: string): string => {
    validBucket(bucketId);
    return join(root, bucketId);
  };
  const bodyPath = (bucketId: string, storageId: string): string => {
    if (!STORAGE_ID.test(storageId)) throw new SelfhostObjectError("backend_unavailable");
    return join(bucketDirectory(bucketId), "o", storageId.slice(0, 2), storageId);
  };
  const partPath = (bucketId: string, uploadId: string, partNumber: number): string => {
    if (!UPLOAD_ID.test(uploadId) || !Number.isSafeInteger(partNumber)) {
      throw new SelfhostObjectError("backend_unavailable");
    }
    return join(bucketDirectory(bucketId), "u", uploadId, String(partNumber));
  };

  /**
   * Writes one stream to a private file, and refuses anything but exactly the
   * declared length.
   *
   * The length is declared rather than discovered because it is the only thing
   * that bounds what a caller can make this process write before the check
   * happens. A body that runs long is stopped at the first byte past it.
   */
  const stage = async (
    bucketId: string,
    body: ReadableStream<Uint8Array>,
    contentLength: number,
    maximum: number,
  ): Promise<{ readonly path: string; readonly etag: string; readonly size: number }> => {
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      throw new SelfhostObjectError("invalid_body");
    }
    if (contentLength > maximum) throw new SelfhostObjectError("value_too_large");
    const directory = join(bucketDirectory(bucketId), "tmp");
    await privateDirectory(directory);
    const path = join(directory, identifier());
    const digest = createHash("sha256");
    let received = 0;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      const reader = body.getReader();
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        const chunk = next.value;
        if (!(chunk instanceof Uint8Array)) {
          await reader.cancel().catch(() => undefined);
          throw new SelfhostObjectError("invalid_body");
        }
        received += chunk.byteLength;
        if (received > contentLength) {
          await reader.cancel().catch(() => undefined);
          throw new SelfhostObjectError("invalid_body");
        }
        digest.update(chunk);
        await handle.write(chunk);
      }
      if (received !== contentLength) throw new SelfhostObjectError("invalid_body");
      await handle.sync();
    } catch (error) {
      await handle?.close().catch(() => undefined);
      await rm(path, { force: true }).catch(() => undefined);
      throw error instanceof SelfhostObjectError
        ? error
        : new SelfhostObjectError("backend_unavailable");
    }
    await handle.close().catch(() => undefined);
    return { path, etag: digest.digest("hex"), size: received };
  };

  const publish = async (staged: string, destination: string): Promise<void> => {
    try {
      await privateDirectory(join(destination, ".."));
      await rename(staged, destination);
    } catch {
      await rm(staged, { force: true }).catch(() => undefined);
      throw new SelfhostObjectError("backend_unavailable");
    }
  };

  const readRow = async (
    bucketId: string,
    key: string,
  ): Promise<{
    readonly storageId: string;
    readonly size: number;
    readonly etag: string;
    readonly contentType?: string;
    readonly uploadedAtMillis: number;
  } | null> => {
    const rows = await query(
      sql,
      "SELECT storage_id, size, etag, content_type, uploaded_at_ms FROM selfhost_objects " +
        "WHERE bucket_id = ? AND key = ?",
      [bucketId, key],
    );
    const row = rows[0];
    if (!row) return null;
    const storageId = String(row.storage_id);
    const etag = String(row.etag);
    const size = Number(row.size);
    const uploadedAtMillis = Number(row.uploaded_at_ms);
    if (
      !STORAGE_ID.test(storageId) ||
      !Number.isSafeInteger(size) ||
      !Number.isSafeInteger(uploadedAtMillis)
    ) {
      throw new SelfhostObjectError("backend_unavailable");
    }
    return {
      storageId,
      size,
      etag,
      uploadedAtMillis,
      ...(typeof row.content_type === "string" ? { contentType: row.content_type } : {}),
    };
  };

  /** A put or a completed multipart: one new file, then one guarded row move. */
  const commitBody = async (
    bucketId: string,
    key: string,
    staged: { readonly path: string; readonly etag: string; readonly size: number },
    contentType: string | undefined,
    condition: { readonly ifMatch?: string; readonly ifNoneMatch?: "*" },
  ): Promise<{ readonly etag: string; readonly size: number }> => {
    const storageId = identifier();
    const destination = bodyPath(bucketId, storageId);
    const millis = now().getTime();
    let previous: string | null = null;
    try {
      await publish(staged.path, destination);
      if (condition.ifNoneMatch === "*") {
        const written = await run(
          sql,
          "INSERT INTO selfhost_objects " +
            "(bucket_id, key, storage_id, size, etag, content_type, uploaded_at_ms) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (bucket_id, key) DO NOTHING",
          [bucketId, key, storageId, staged.size, staged.etag, contentType ?? null, millis],
        );
        if (written.changes !== 1) throw new SelfhostObjectError("precondition_failed");
      } else if (condition.ifMatch !== undefined) {
        const current = await readRow(bucketId, key);
        if (!current || current.etag !== condition.ifMatch) {
          throw new SelfhostObjectError("precondition_failed");
        }
        const written = await run(
          sql,
          "UPDATE selfhost_objects SET storage_id = ?, size = ?, etag = ?, content_type = ?, " +
            "uploaded_at_ms = ? WHERE bucket_id = ? AND key = ? AND etag = ?",
          [
            storageId,
            staged.size,
            staged.etag,
            contentType ?? null,
            millis,
            bucketId,
            key,
            condition.ifMatch,
          ],
        );
        if (written.changes !== 1) throw new SelfhostObjectError("precondition_failed");
        previous = current.storageId;
      } else {
        const current = await readRow(bucketId, key);
        await run(
          sql,
          "INSERT INTO selfhost_objects " +
            "(bucket_id, key, storage_id, size, etag, content_type, uploaded_at_ms) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT (bucket_id, key) DO UPDATE SET " +
            "storage_id = excluded.storage_id, size = excluded.size, etag = excluded.etag, " +
            "content_type = excluded.content_type, uploaded_at_ms = excluded.uploaded_at_ms",
          [bucketId, key, storageId, staged.size, staged.etag, contentType ?? null, millis],
        );
        previous = current?.storageId ?? null;
      }
    } catch (error) {
      // The row never moved, so the file this call minted is unreachable.
      await rm(destination, { force: true }).catch(() => undefined);
      await rm(staged.path, { force: true }).catch(() => undefined);
      throw error instanceof SelfhostObjectError
        ? error
        : new SelfhostObjectError("backend_unavailable");
    }
    // Only once no row names it. A reader that resolved the superseded row
    // before this point is already holding the file open, and one that resolved
    // it and lost the race re-reads the row rather than reporting an absence.
    if (previous && previous !== storageId) {
      await rm(bodyPath(bucketId, previous), { force: true }).catch(() => undefined);
    }
    return { etag: staged.etag, size: staged.size };
  };

  const openBody = async (
    bucketId: string,
    key: string,
    offset: number,
    length: number,
  ): Promise<{
    readonly stream: ReadableStream<Uint8Array>;
    readonly row: NonNullable<Awaited<ReturnType<typeof readRow>>>;
  } | null> => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const row = await readRow(bucketId, key);
      if (!row) return null;
      let handle: Awaited<ReturnType<typeof open>>;
      try {
        handle = await open(bodyPath(bucketId, row.storageId), fsConstants.O_RDONLY);
      } catch {
        // A concurrent put replaced the row and dropped the file it named.
        continue;
      }
      return { row, stream: fileStream(handle, offset, length) };
    }
    throw new SelfhostObjectError("backend_unavailable");
  };

  return {
    async head(bucketId, key) {
      validBucket(bucketId);
      validKey(key);
      const row = await readRow(bucketId, key);
      return row
        ? {
            etag: row.etag,
            size: row.size,
            uploadedAtMillis: row.uploadedAtMillis,
            ...(row.contentType ? { contentType: row.contentType } : {}),
          }
        : null;
    },

    async get(bucketId, key, options = {}) {
      validBucket(bucketId);
      validKey(key);
      const current = await readRow(bucketId, key);
      if (!current) return null;
      if (options.ifMatch !== undefined && options.ifMatch !== current.etag) {
        throw new SelfhostObjectError("precondition_failed");
      }
      if (options.ifNoneMatch !== undefined && options.ifNoneMatch === current.etag) {
        throw new SelfhostObjectError("precondition_failed");
      }
      const requested = options.range;
      if (requested && requested.offset >= current.size && current.size > 0) {
        throw new SelfhostObjectError("range_not_satisfiable");
      }
      if (requested && requested.offset > current.size) {
        throw new SelfhostObjectError("range_not_satisfiable");
      }
      const offset = requested?.offset ?? 0;
      const length = requested
        ? Math.min(requested.length ?? current.size, current.size - offset)
        : current.size;
      const opened = await openBody(bucketId, key, offset, length);
      if (!opened) return null;
      return {
        etag: opened.row.etag,
        size: opened.row.size,
        ...(opened.row.contentType ? { contentType: opened.row.contentType } : {}),
        body: opened.stream,
        partial: requested !== undefined,
        ...(requested ? { range: { offset, length } } : {}),
      };
    },

    async put(bucketId, key, body, options) {
      validBucket(bucketId);
      validKey(key);
      const staged = await stage(
        bucketId,
        body,
        options.contentLength,
        MAX_SELFHOST_OBJECT_SINGLE_PUT_BYTES,
      );
      return await commitBody(bucketId, key, staged, options.contentType, {
        ...(options.ifMatch !== undefined ? { ifMatch: options.ifMatch } : {}),
        ...(options.ifNoneMatch !== undefined ? { ifNoneMatch: options.ifNoneMatch } : {}),
      });
    },

    async delete(bucketId, key) {
      validBucket(bucketId);
      validKey(key);
      const current = await readRow(bucketId, key);
      if (!current) return;
      await run(sql, "DELETE FROM selfhost_objects WHERE bucket_id = ? AND key = ? AND etag = ?", [
        bucketId,
        key,
        current.etag,
      ]);
      const still = await readRow(bucketId, key);
      if (still?.storageId === current.storageId) return;
      await rm(bodyPath(bucketId, current.storageId), { force: true }).catch(() => undefined);
    },

    async list(bucketId, options = {}) {
      return await listObjects(sql, bucketId, options);
    },

    async createMultipartUpload(bucketId, key, options = {}) {
      validBucket(bucketId);
      validKey(key);
      const uploadId = identifier();
      await privateDirectory(join(bucketDirectory(bucketId), "u", uploadId));
      await run(
        sql,
        "INSERT INTO selfhost_object_uploads " +
          "(bucket_id, upload_id, key, content_type, created_at_ms) VALUES (?, ?, ?, ?, ?)",
        [bucketId, uploadId, key, options.contentType ?? null, now().getTime()],
      );
      return { uploadId };
    },

    async uploadPart(bucketId, key, uploadId, partNumber, body, options) {
      validBucket(bucketId);
      validKey(key);
      if (
        !UPLOAD_ID.test(uploadId) ||
        !Number.isSafeInteger(partNumber) ||
        partNumber < 1 ||
        partNumber > MAX_SELFHOST_OBJECT_PARTS
      ) {
        throw new SelfhostObjectError("upload_not_found");
      }
      const upload = await readUpload(sql, bucketId, uploadId);
      if (!upload || upload.key !== key) throw new SelfhostObjectError("upload_not_found");
      const staged = await stage(bucketId, body, options.contentLength, MAX_SELFHOST_OBJECT_BYTES);
      const destination = partPath(bucketId, uploadId, partNumber);
      await publish(staged.path, destination);
      try {
        await run(
          sql,
          "INSERT INTO selfhost_object_upload_parts (bucket_id, upload_id, part_number, size, etag) " +
            "VALUES (?, ?, ?, ?, ?) ON CONFLICT (bucket_id, upload_id, part_number) DO UPDATE SET " +
            "size = excluded.size, etag = excluded.etag",
          [bucketId, uploadId, partNumber, staged.size, staged.etag],
        );
      } catch {
        await rm(destination, { force: true }).catch(() => undefined);
        throw new SelfhostObjectError("upload_not_found");
      }
      return { etag: staged.etag, partNumber };
    },

    async completeMultipartUpload(bucketId, key, uploadId, parts) {
      validBucket(bucketId);
      validKey(key);
      if (!UPLOAD_ID.test(uploadId)) throw new SelfhostObjectError("upload_not_found");
      const upload = await readUpload(sql, bucketId, uploadId);
      if (!upload || upload.key !== key) throw new SelfhostObjectError("upload_not_found");
      if (parts.length < 1 || parts.length > MAX_SELFHOST_OBJECT_PARTS) {
        throw new SelfhostObjectError("invalid_part");
      }
      const recorded = new Map<number, { readonly etag: string; readonly size: number }>();
      for (const row of await query(
        sql,
        "SELECT part_number, size, etag FROM selfhost_object_upload_parts " +
          "WHERE bucket_id = ? AND upload_id = ?",
        [bucketId, uploadId],
      )) {
        recorded.set(Number(row.part_number), {
          etag: String(row.etag),
          size: Number(row.size),
        });
      }
      let total = 0;
      let previous = 0;
      for (let index = 0; index < parts.length; index += 1) {
        const part = parts[index] as { readonly etag: string; readonly partNumber: number };
        const known = recorded.get(part.partNumber);
        if (
          part.partNumber <= previous ||
          !known ||
          known.etag !== part.etag ||
          (index < parts.length - 1 && known.size < MIN_SELFHOST_OBJECT_NON_FINAL_PART_BYTES)
        ) {
          throw new SelfhostObjectError("invalid_part");
        }
        previous = part.partNumber;
        if (known.size > MAX_SELFHOST_OBJECT_BYTES - total) {
          throw new SelfhostObjectError("value_too_large");
        }
        total += known.size;
      }
      // Assembled into one private file before anything durable moves, so a
      // failure halfway leaves the upload exactly where it was and the caller
      // may complete it again.
      const directory = join(bucketDirectory(bucketId), "tmp");
      await privateDirectory(directory);
      const assembled = join(directory, identifier());
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(
          assembled,
          fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
          0o600,
        );
        for (const part of parts) {
          const source = await open(
            partPath(bucketId, uploadId, part.partNumber),
            fsConstants.O_RDONLY,
          );
          try {
            for (let offset = 0; ; ) {
              const buffer = new Uint8Array(READ_CHUNK_BYTES);
              const read = await source.read(buffer, 0, buffer.byteLength, offset);
              if (read.bytesRead === 0) break;
              offset += read.bytesRead;
              await handle.write(buffer.subarray(0, read.bytesRead));
            }
          } finally {
            await source.close().catch(() => undefined);
          }
        }
        await handle.sync();
      } catch (error) {
        await handle?.close().catch(() => undefined);
        await rm(assembled, { force: true }).catch(() => undefined);
        throw error instanceof SelfhostObjectError
          ? error
          : new SelfhostObjectError("backend_unavailable");
      }
      await handle.close().catch(() => undefined);
      const size = (await stat(assembled).catch(() => null))?.size ?? -1;
      if (size !== total) {
        await rm(assembled, { force: true }).catch(() => undefined);
        throw new SelfhostObjectError("backend_unavailable");
      }
      // A multipart etag names the parts it was made of, exactly as S3's does,
      // so an object assembled from different bytes cannot present the etag of
      // one that was not.
      const etag = `${createHash("sha256")
        .update(parts.map((part) => `${part.partNumber}:${part.etag}`).join("\n"), "utf8")
        .digest("hex")}-${parts.length}`;
      const written = await commitBody(
        bucketId,
        key,
        { path: assembled, etag, size: total },
        upload.contentType,
        {},
      );
      await dropUpload(sql, bucketId, uploadId);
      await rm(join(bucketDirectory(bucketId), "u", uploadId), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
      return written;
    },

    async abortMultipartUpload(bucketId, key, uploadId) {
      validBucket(bucketId);
      validKey(key);
      if (!UPLOAD_ID.test(uploadId)) throw new SelfhostObjectError("upload_not_found");
      const upload = await readUpload(sql, bucketId, uploadId);
      if (!upload || upload.key !== key) throw new SelfhostObjectError("upload_not_found");
      await dropUpload(sql, bucketId, uploadId);
      await rm(join(bucketDirectory(bucketId), "u", uploadId), {
        recursive: true,
        force: true,
      }).catch(() => undefined);
    },

    async occupancy(bucketId) {
      validBucket(bucketId);
      const objects = await query(
        sql,
        "SELECT count(*) AS total FROM selfhost_objects WHERE bucket_id = ?",
        [bucketId],
      );
      const uploads = await query(
        sql,
        "SELECT count(*) AS total FROM selfhost_object_uploads WHERE bucket_id = ?",
        [bucketId],
      );
      return {
        objects: Number(objects[0]?.total ?? 0),
        uploads: Number(uploads[0]?.total ?? 0),
      };
    },

    async destroy(bucketId) {
      validBucket(bucketId);
      const directory = bucketDirectory(bucketId);
      await run(sql, "DELETE FROM selfhost_object_upload_parts WHERE bucket_id = ?", [bucketId]);
      await run(sql, "DELETE FROM selfhost_object_uploads WHERE bucket_id = ?", [bucketId]);
      await run(sql, "DELETE FROM selfhost_objects WHERE bucket_id = ?", [bucketId]);
      await rm(directory, { recursive: true, force: true }).catch(() => undefined);
    },
  };
}

/**
 * One page of a bucket in key order, with the delimiter rolled up.
 *
 * A group the delimiter rolls up is skipped by jumping to the exclusive upper
 * bound of its prefix rather than by reading every key inside it, so listing a
 * bucket with one enormous folder costs a page rather than the folder.
 *
 * The cursor is a bound, not a key: "resume at this key, inclusive or not".
 * Encoding the last key returned would be ambiguous the moment a page stopped
 * inside a rolled-up group, where the next page must start after the group
 * rather than after the key that named it.
 */
async function listObjects(
  sql: Sql,
  bucketId: string,
  options: SelfhostObjectListOptions,
): Promise<SelfhostObjectListResult> {
  validBucket(bucketId);
  const prefix = options.prefix ?? "";
  if (utf8Length(prefix) > MAX_SELFHOST_OBJECT_KEY_BYTES) {
    throw new SelfhostObjectError("invalid_key");
  }
  const delimiter = options.delimiter;
  const limit = options.limit ?? MAX_SELFHOST_OBJECT_LIST_LIMIT;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SELFHOST_OBJECT_LIST_LIMIT) {
    throw new SelfhostObjectError("invalid_cursor");
  }
  const ceiling = prefix === "" ? null : prefixCeiling(prefix);
  const objects: {
    key: string;
    etag: string;
    size: number;
    uploadedAtMillis: number;
  }[] = [];
  const prefixes: string[] = [];
  let bound: ListBound = { key: prefix, inclusive: true };
  if (options.cursor !== undefined) {
    const resumed = decodeCursor(options.cursor);
    if (resumed.key > bound.key || (resumed.key === bound.key && !resumed.inclusive)) {
      bound = resumed;
    }
  }
  const page = limit + 1;
  let truncated = false;
  let cursor: string | undefined;
  let exhausted = true;
  // Every pass consumes at least one row or ends the listing, and a rolled-up
  // group costs exactly one extra pass, so the ceiling is a safety net rather
  // than the loop's own bound.
  for (let pass = 0; pass < 2 * limit + 8; pass += 1) {
    const rows = await query(
      sql,
      "SELECT key, etag, size, uploaded_at_ms FROM selfhost_objects " +
        `WHERE bucket_id = ? AND key ${bound.inclusive ? ">=" : ">"} ?` +
        (ceiling === null ? "" : " AND key < ?") +
        " ORDER BY key LIMIT ?",
      ceiling === null ? [bucketId, bound.key, page] : [bucketId, bound.key, ceiling, page],
    );
    if (rows.length === 0) {
      exhausted = false;
      break;
    }
    let jumped = false;
    let full = false;
    for (const row of rows) {
      const key = String(row.key);
      bound = { key, inclusive: false };
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      const at = delimiter === undefined || delimiter === "" ? -1 : rest.indexOf(delimiter);
      if (at >= 0) {
        const group = `${prefix}${rest.slice(0, at + (delimiter as string).length)}`;
        if (!prefixes.includes(group)) {
          if (objects.length + prefixes.length >= limit) {
            truncated = true;
            cursor = encodeBound({ key, inclusive: true });
            full = true;
            break;
          }
          prefixes.push(group);
        }
        const next = prefixCeiling(group);
        if (next === null) continue;
        bound = { key: next, inclusive: true };
        jumped = true;
        break;
      }
      if (objects.length + prefixes.length >= limit) {
        truncated = true;
        cursor = encodeBound({ key, inclusive: true });
        full = true;
        break;
      }
      objects.push({
        key,
        etag: String(row.etag),
        size: Number(row.size),
        uploadedAtMillis: Number(row.uploaded_at_ms),
      });
    }
    if (full) {
      exhausted = false;
      break;
    }
    if (jumped) continue;
    if (rows.length < page) {
      exhausted = false;
      break;
    }
  }
  // Running out of passes is not "the listing is complete": say so rather than
  // hand back a page that silently lost the rest of the bucket.
  if (exhausted) {
    truncated = true;
    cursor = encodeBound(bound);
  }
  return {
    objects,
    prefixes,
    truncated,
    ...(truncated && cursor !== undefined ? { cursor } : {}),
  };
}

interface ListBound {
  readonly key: string;
  readonly inclusive: boolean;
}

async function readUpload(
  sql: Sql,
  bucketId: string,
  uploadId: string,
): Promise<{ readonly key: string; readonly contentType?: string } | null> {
  validBucket(bucketId);
  const rows = await query(
    sql,
    "SELECT key, content_type FROM selfhost_object_uploads WHERE bucket_id = ? AND upload_id = ?",
    [bucketId, uploadId],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    key: String(row.key),
    ...(typeof row.content_type === "string" ? { contentType: row.content_type } : {}),
  };
}

async function dropUpload(sql: Sql, bucketId: string, uploadId: string): Promise<void> {
  await run(sql, "DELETE FROM selfhost_object_upload_parts WHERE bucket_id = ? AND upload_id = ?", [
    bucketId,
    uploadId,
  ]);
  await run(sql, "DELETE FROM selfhost_object_uploads WHERE bucket_id = ? AND upload_id = ?", [
    bucketId,
    uploadId,
  ]);
}

async function query(
  sql: Sql,
  statement: string,
  params: readonly (string | number | null)[],
): Promise<readonly Record<string, unknown>[]> {
  try {
    return await sql.query(statement, params);
  } catch {
    throw new SelfhostObjectError("backend_unavailable");
  }
}

async function run(
  sql: Sql,
  statement: string,
  params: readonly (string | number | null)[],
): Promise<{ readonly changes: number }> {
  try {
    return await sql.run(statement, params);
  } catch {
    throw new SelfhostObjectError("backend_unavailable");
  }
}

/**
 * A directory this process is willing to keep a tenant's objects in.
 *
 * `mkdir(mode)` does nothing to a directory that already exists, so the mode is
 * tightened and re-read rather than assumed — exactly as the SQL plane does for
 * the directory holding tenants' databases.
 */
async function privateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700).catch(() => undefined);
  const mode = (await stat(path)).mode;
  if ((mode & 0o077) !== 0) {
    throw new SelfhostObjectError("backend_unavailable");
  }
}

/** A ranged read that holds the file open for as long as the caller reads it. */
function fileStream(
  handle: Awaited<ReturnType<typeof open>>,
  offset: number,
  length: number,
): ReadableStream<Uint8Array> {
  let position = offset;
  let remaining = length;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (remaining <= 0) {
        await handle.close().catch(() => undefined);
        controller.close();
        return;
      }
      const buffer = new Uint8Array(Math.min(READ_CHUNK_BYTES, remaining));
      let read: { bytesRead: number };
      try {
        read = await handle.read(buffer, 0, buffer.byteLength, position);
      } catch {
        await handle.close().catch(() => undefined);
        controller.error(new SelfhostObjectError("backend_unavailable"));
        return;
      }
      if (read.bytesRead === 0) {
        await handle.close().catch(() => undefined);
        controller.error(new SelfhostObjectError("backend_unavailable"));
        return;
      }
      position += read.bytesRead;
      remaining -= read.bytesRead;
      controller.enqueue(buffer.subarray(0, read.bytesRead));
    },
    async cancel() {
      await handle.close().catch(() => undefined);
    },
  });
}

/**
 * The bucket ids this Host derives, and nothing else.
 *
 * It fences the filesystem — every path below is joined from this — and it
 * fences the database, where a bucket id is the whole of the isolation between
 * two tenants' objects. Both are the same check, so it is one function.
 */
function validBucket(bucketId: string): void {
  if (typeof bucketId !== "string" || !BUCKET_ID.test(bucketId)) {
    throw new SelfhostObjectError("backend_unavailable");
  }
}

function validKey(key: string): void {
  if (
    typeof key !== "string" ||
    key.length < 1 ||
    utf8Length(key) > MAX_SELFHOST_OBJECT_KEY_BYTES ||
    hasControlCharacters(key)
  ) {
    throw new SelfhostObjectError("invalid_key");
  }
}

function hasControlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return true;
  }
  return false;
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function encodeBound(bound: ListBound): string {
  return Buffer.from(new TextEncoder().encode(JSON.stringify({ k: bound.key, i: bound.inclusive })))
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(value: string): ListBound {
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw new SelfhostObjectError("invalid_cursor");
  }
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new SelfhostObjectError("invalid_cursor");
  let parsed: unknown;
  try {
    const bytes = Buffer.from(value.replaceAll("-", "+").replaceAll("_", "/"), "base64");
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new SelfhostObjectError("invalid_cursor");
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).sort().join(",") !== "i,k"
  ) {
    throw new SelfhostObjectError("invalid_cursor");
  }
  const bound = parsed as { readonly k: unknown; readonly i: unknown };
  if (
    typeof bound.k !== "string" ||
    typeof bound.i !== "boolean" ||
    utf8Length(bound.k) > MAX_SELFHOST_OBJECT_KEY_BYTES
  ) {
    throw new SelfhostObjectError("invalid_cursor");
  }
  return { key: bound.k, inclusive: bound.i };
}

/**
 * The exclusive upper bound of a prefix range.
 *
 * Comparing on `key LIKE prefix || '%'` would make the prefix a pattern, so a
 * key containing `%` or `_` would list somebody else's keys. A range does not
 * have that problem, and it uses the primary key.
 */
export function prefixCeiling(prefix: string): string | null {
  // Code points, not code units. A key outside the basic plane ends in a
  // surrogate pair, and incrementing its low half while dropping one code unit
  // leaves a lone high surrogate as the bound — which sorts below the keys the
  // caller asked for, so a matching key simply vanishes from the listing.
  const points = [...prefix];
  while (points.length > 0) {
    const code = (points.pop() as string).codePointAt(0) ?? 0;
    // U+10FFFF has no successor, so the carry moves left. A prefix that is
    // nothing but U+10FFFF runs out of places to carry into and has no ceiling.
    if (code >= 0x10ffff) continue;
    // The surrogate block is not a code point a well-formed key can contain,
    // and SQLite compares the UTF-8 those keys are stored as.
    const next = code + 1 >= 0xd800 && code + 1 <= 0xdfff ? 0xe000 : code + 1;
    return `${points.join("")}${String.fromCodePoint(next)}`;
  }
  return null;
}
