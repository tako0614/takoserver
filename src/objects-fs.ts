import { createHash } from "node:crypto";
import { link, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import {
  type ObjectListPage,
  type ObjectStore,
  ObjectStoreError,
  type StoredObject,
  type StoredObjectBody,
} from "./ports.ts";

/**
 * Objects on a disk.
 *
 * The in-memory store is for tests and the R2 stores need an account. Neither
 * is what somebody running this on their own machine needs: a self-hosted
 * deployment has to survive a restart, and losing every customer's files to a
 * process exit is not a storage layer.
 *
 * A key becomes a path, which is where this kind of code goes wrong. Keys come
 * from customers, `..` means something to a filesystem, and a store that joins
 * strings hands out the machine. So a key is checked before it is joined and
 * the result is checked again after — the second check is what catches the
 * encoding nobody thought of.
 *
 * Writes land through a temporary file and a rename, because a rename within a
 * filesystem is atomic and a partial write is not: a reader during a crash
 * finds the old bytes or the new ones, never half of either.
 */

export interface FileObjectStoreOptions {
  /** Directory that holds everything. Created if absent. */
  readonly root: string;
}

export function createFileObjectStore(options: FileObjectStoreOptions): ObjectStore {
  const root = options.root;

  /**
   * The path a key lives at, or a refusal.
   *
   * Content type is kept beside the bytes rather than in a database: a store
   * that needs a second system to answer `get` is a store that can be half
   * available.
   */
  const pathFor = (key: string): { readonly body: string; readonly meta: string } => {
    if (!validKey(key)) throw new ObjectStoreError("invalid", "unusable object key");
    const body = join(root, "objects", key);
    // Checked after joining too. Normalisation, encodings and symlinked path
    // segments all resolve here and not before.
    const inside = relative(join(root, "objects"), body);
    if (inside.startsWith("..") || inside.startsWith(sep) || inside === "") {
      throw new ObjectStoreError("invalid", "unusable object key");
    }
    return { body, meta: `${body}.meta` };
  };

  return {
    async create(key, body, opts): Promise<StoredObject | null> {
      const { body: path, meta } = pathFor(key);
      const bytes = await collect(body);
      await mkdir(dirname(path), { recursive: true });
      const staging = `${path}.${process.pid}.${Date.now()}.partial`;
      try {
        await writeFile(staging, bytes, { flag: "wx" });
        try {
          // A hard link publishes the complete staging inode without replacing
          // an existing key. Both paths are in the same directory/filesystem.
          await link(staging, path);
        } catch (error) {
          if (isAlreadyExists(error)) return null;
          throw error;
        }
        const contentType = opts?.contentType;
        if (contentType) await writeFile(meta, contentType, "utf8");
        else await rm(meta, { force: true });
        return {
          key,
          size: bytes.byteLength,
          etag: digest(bytes),
          ...(contentType ? { contentType } : {}),
        };
      } catch (error) {
        if (isAlreadyExists(error)) return null;
        throw new ObjectStoreError("unavailable", `the disk refused the create: ${String(error)}`);
      } finally {
        await rm(staging, { force: true });
      }
    },

    async put(key, body, opts): Promise<StoredObject> {
      const { body: path, meta } = pathFor(key);
      const bytes = await collect(body);
      await mkdir(dirname(path), { recursive: true });
      const staging = `${path}.${process.pid}.${Date.now()}.partial`;
      try {
        await writeFile(staging, bytes);
        await rename(staging, path);
      } catch (error) {
        await rm(staging, { force: true });
        throw new ObjectStoreError("unavailable", `the disk refused the write: ${String(error)}`);
      }
      const contentType = opts?.contentType;
      if (contentType) await writeFile(meta, contentType, "utf8");
      else await rm(meta, { force: true });

      return {
        key,
        size: bytes.byteLength,
        etag: digest(bytes),
        ...(contentType ? { contentType } : {}),
      };
    },

    async get(key): Promise<StoredObjectBody | null> {
      const { body: path, meta } = pathFor(key);
      let bytes: Buffer;
      try {
        bytes = await readFile(path);
      } catch {
        return null;
      }
      const contentType = await readFile(meta, "utf8").catch(() => null);
      return {
        key,
        size: bytes.byteLength,
        etag: digest(bytes),
        ...(contentType ? { contentType } : {}),
        body: new Response(bytes as unknown as BodyInit).body as ReadableStream<Uint8Array>,
      };
    },

    async head(key): Promise<StoredObject | null> {
      const { body: path, meta } = pathFor(key);
      const found = await stat(path).catch(() => null);
      if (!found) return null;
      if (!found.isFile()) return null;
      // The etag is content-derived, so it is read rather than remembered.
      // A store that guessed here would report a match for changed bytes.
      const bytes = await readFile(path).catch(() => null);
      if (!bytes) return null;
      const contentType = await readFile(meta, "utf8").catch(() => null);
      return {
        key,
        size: bytes.byteLength,
        etag: digest(bytes),
        ...(contentType ? { contentType } : {}),
      };
    },

    async delete(key): Promise<boolean> {
      const { body: path, meta } = pathFor(key);
      const existed = (await stat(path).catch(() => null)) !== null;
      await rm(path, { force: true });
      await rm(meta, { force: true });
      return existed;
    },

    async list(options): Promise<ObjectListPage> {
      const prefix = options.prefix;
      const limit = Math.min(Math.max(options.limit, 1), 1_000);
      const base = join(root, "objects");
      const keys = (await walk(base, base)).filter((key) => key.startsWith(prefix)).sort();

      // The cursor is the last key returned. Sorted keys make that a position
      // without a stored session, and a key that has since been deleted still
      // says where to continue from.
      const after = options.cursor ?? null;
      const start = after === null ? 0 : keys.findIndex((key) => key > after);
      const window = start === -1 ? [] : keys.slice(start, start + limit);
      const objects: StoredObject[] = [];
      for (const key of window) {
        const bytes = await readFile(join(base, key)).catch(() => null);
        if (!bytes) continue;
        const contentType = await readFile(join(base, `${key}.meta`), "utf8").catch(() => null);
        objects.push({
          key,
          size: bytes.byteLength,
          etag: digest(bytes),
          ...(contentType ? { contentType } : {}),
        });
      }
      const last = window[window.length - 1];
      const truncated = start !== -1 && start + limit < keys.length;
      return {
        objects,
        truncated,
        ...(truncated && last ? { cursor: last } : {}),
      };
    },
  };
}

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === "EEXIST"
  );
}

async function walk(directory: string, base: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const found: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      found.push(...(await walk(path, base)));
      continue;
    }
    // `.meta` sidecars and interrupted writes are storage, not objects.
    if (entry.name.endsWith(".meta") || entry.name.endsWith(".partial")) continue;
    found.push(relative(base, path).split(sep).join("/"));
  }
  return found;
}

/**
 * A key that may become a path.
 *
 * Refused rather than sanitised: sanitising invents a key the caller did not
 * write, and two different keys that sanitise alike become one object.
 */
function validKey(key: string): boolean {
  if (key === "" || key.length > 1_024) return false;
  if (key.startsWith("/") || key.includes("//") || key.includes("\0")) return false;
  if (key.endsWith(".meta") || key.endsWith(".partial")) return false;
  return key.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

async function collect(
  body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body as unknown as BodyInit).arrayBuffer());
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
