import {
  type ObjectListPage,
  type ObjectStore,
  ObjectStoreError,
  type StoredObject,
  type StoredObjectBody,
} from "./ports.ts";

interface HeldObject {
  readonly bytes: Uint8Array;
  readonly etag: string;
  readonly contentType?: string;
}

/**
 * An in-process `ObjectStore`. It backs the test suite and the default
 * self-hosted configuration, so it holds the same invariants the R2 adapter
 * does: content-derived etags and byte-exact reads.
 */
export function createMemoryObjectStore(): ObjectStore {
  const objects = new Map<string, HeldObject>();

  return {
    async put(key, body, options): Promise<StoredObject> {
      const bytes = await collect(body);
      const etag = await digest(bytes);
      const contentType = options?.contentType;
      objects.set(key, { bytes, etag, ...(contentType ? { contentType } : {}) });
      return { key, size: bytes.byteLength, etag, ...(contentType ? { contentType } : {}) };
    },

    async get(key): Promise<StoredObjectBody | null> {
      const held = objects.get(key);
      if (!held) return null;
      const snapshot = held.bytes.slice();
      return {
        key,
        size: held.bytes.byteLength,
        etag: held.etag,
        ...(held.contentType ? { contentType: held.contentType } : {}),
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(snapshot);
            controller.close();
          },
        }),
      };
    },

    async head(key): Promise<StoredObject | null> {
      const held = objects.get(key);
      if (!held) return null;
      return {
        key,
        size: held.bytes.byteLength,
        etag: held.etag,
        ...(held.contentType ? { contentType: held.contentType } : {}),
      };
    },

    async delete(key): Promise<boolean> {
      return objects.delete(key);
    },

    async list(input): Promise<ObjectListPage> {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        throw new ObjectStoreError("invalid", "list limit must be a positive integer");
      }
      const keys = [...objects.keys()]
        .filter((key) => key.startsWith(input.prefix))
        .sort()
        .filter((key) => (input.cursor === undefined ? true : key > input.cursor));
      const page = keys.slice(0, input.limit);
      const truncated = keys.length > page.length;
      const last = page.at(-1);
      return {
        objects: page.map((key) => {
          const held = objects.get(key);
          if (!held) throw new ObjectStoreError("unavailable", "object vanished during list");
          return {
            key,
            size: held.bytes.byteLength,
            etag: held.etag,
            ...(held.contentType ? { contentType: held.contentType } : {}),
          };
        }),
        truncated,
        ...(truncated && last ? { cursor: last } : {}),
      };
    },
  };
}

async function collect(
  body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof ArrayBuffer) return new Uint8Array(body.slice(0));
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
