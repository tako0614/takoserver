import {
  type ObjectListPage,
  type ObjectStore,
  ObjectStoreError,
  type StoredObject,
  type StoredObjectBody,
} from "./ports.ts";

/**
 * `ObjectStore` over R2's HTTP API, for a host that has no binding.
 *
 * The provisioner must read the very bytes a tenant uploaded through the
 * Worker. Those live in R2, which a Worker reaches by binding and a host can
 * only reach over HTTP. Without this the provisioner would be reading a
 * different store from the one the product writes to, and a Worker bundle
 * committed through the API would simply not be there when it came time to
 * publish it.
 *
 * Host-only, like the other HTTP transports: it carries an account credential.
 */
export interface R2HttpOptions {
  readonly accountId: string;
  readonly bucketName: string;
  readonly authorize: () => string | Promise<string>;
  readonly apiOrigin?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}

export function createR2HttpObjectStore(options: R2HttpOptions): ObjectStore {
  const origin = options.apiOrigin ?? "https://api.cloudflare.com/client/v4";
  const base = `${origin}/accounts/${options.accountId}/r2/buckets/${options.bucketName}/objects`;
  const send = options.fetch ?? ((request: Request) => fetch(request));

  const call = async (
    method: string,
    key: string,
    body?: BodyInit,
    contentType?: string,
    createOnly = false,
  ): Promise<Response> => {
    const path = key
      .split("/")
      .map((segment) => encodeURIComponent(segment))
      .join("/");
    try {
      return await send(
        new Request(`${base}/${path}`, {
          method,
          headers: {
            authorization: await options.authorize(),
            ...(contentType ? { "content-type": contentType } : {}),
            ...(createOnly ? { "if-none-match": "*" } : {}),
          },
          ...(body === undefined ? {} : { body }),
        }),
      );
    } catch {
      throw new ObjectStoreError("unavailable", "the R2 HTTP API is unreachable");
    }
  };

  return {
    async create(key, body, opts): Promise<StoredObject | null> {
      const bytes = await collect(body);
      const response = await call(
        "PUT",
        key,
        bytes as unknown as BodyInit,
        opts?.contentType ?? "application/octet-stream",
        true,
      );
      if (response.status === 412) return null;
      if (!response.ok) {
        throw new ObjectStoreError("unavailable", `R2 refused the create (${response.status})`);
      }
      const contentType = opts?.contentType;
      return {
        key,
        size: bytes.byteLength,
        etag: await digest(bytes),
        ...(contentType ? { contentType } : {}),
      };
    },

    async put(key, body, opts): Promise<StoredObject> {
      const bytes = await collect(body);
      const response = await call(
        "PUT",
        key,
        bytes as unknown as BodyInit,
        opts?.contentType ?? "application/octet-stream",
      );
      if (!response.ok) {
        throw new ObjectStoreError("unavailable", `R2 refused the write (${response.status})`);
      }
      const contentType = opts?.contentType;
      return {
        key,
        size: bytes.byteLength,
        etag: await digest(bytes),
        ...(contentType ? { contentType } : {}),
      };
    },

    async get(key): Promise<StoredObjectBody | null> {
      const response = await call("GET", key);
      if (response.status === 404) return null;
      if (!response.ok || !response.body) {
        throw new ObjectStoreError("unavailable", `R2 refused the read (${response.status})`);
      }
      const length = Number(response.headers.get("content-length") ?? 0);
      const contentType = response.headers.get("content-type");
      return {
        key,
        size: Number.isSafeInteger(length) ? length : 0,
        etag: response.headers.get("etag") ?? "",
        ...(contentType ? { contentType } : {}),
        body: response.body,
      };
    },

    async head(key): Promise<StoredObject | null> {
      // The R2 HTTP API rejects HEAD on the objects endpoint (405), so a probe
      // is a GET whose body is dropped without being read.
      const response = await call("GET", key);
      if (response.status === 404) {
        await response.body?.cancel();
        return null;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new ObjectStoreError("unavailable", `R2 refused the probe (${response.status})`);
      }
      const declared = Number(response.headers.get("content-length") ?? Number.NaN);
      const contentType = response.headers.get("content-type");
      const etag = response.headers.get("etag") ?? "";
      // Content length is not always present; falling back to reading the body
      // keeps the size honest rather than reporting zero.
      let size: number;
      if (Number.isSafeInteger(declared)) {
        await response.body?.cancel();
        size = declared;
      } else {
        size = (await response.arrayBuffer()).byteLength;
      }
      return {
        key,
        size,
        etag,
        ...(contentType ? { contentType } : {}),
      };
    },

    async delete(key): Promise<boolean> {
      const response = await call("DELETE", key);
      if (response.status === 404) return false;
      if (!response.ok) {
        throw new ObjectStoreError("unavailable", `R2 refused the delete (${response.status})`);
      }
      return true;
    },

    async list(): Promise<ObjectListPage> {
      // Nothing in the provisioner enumerates objects; it reads blobs it was
      // told about by digest. Refusing beats a listing that silently truncates.
      throw new ObjectStoreError("invalid", "listing is not available over the R2 HTTP transport");
    },
  };
}

async function collect(
  body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  return new Uint8Array(await new Response(body).arrayBuffer());
}

async function digest(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
