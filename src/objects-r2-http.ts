import {
  type ObjectListPage,
  type ObjectStoreAccess,
  ObjectStoreError,
  type StoredObject,
  type StoredObjectBody,
} from "./ports.ts";

// R2 listing is package metadata, not an unbounded JSON control plane. Keep
// this adapter-local cap so the host transport does not depend on domain code.
const R2_LIST_MAX_BYTES = 4 << 20;

/**
 * Non-atomic `ObjectStoreAccess` over R2's HTTP API, for a host that has no
 * binding. The REST surface cannot provide the conditional-create capability
 * required by the full `ObjectStore` contract.
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

export function createR2HttpObjectStore(options: R2HttpOptions): ObjectStoreAccess {
  const origin = options.apiOrigin ?? "https://api.cloudflare.com/client/v4";
  const base = `${origin}/accounts/${options.accountId}/r2/buckets/${options.bucketName}/objects`;
  const send = options.fetch ?? ((request: Request) => fetch(request));

  const call = async (
    method: string,
    key: string,
    body?: BodyInit,
    contentType?: string,
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
          },
          ...(body === undefined ? {} : { body }),
        }),
      );
    } catch {
      throw new ObjectStoreError("unavailable", "the R2 HTTP API is unreachable");
    }
  };

  return {
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
      const length = contentLength(response.headers.get("content-length"));
      const contentType = response.headers.get("content-type");
      return {
        key,
        size: length ?? 0,
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
        cancelBody(response.body);
        return null;
      }
      if (!response.ok) {
        cancelBody(response.body);
        throw new ObjectStoreError("unavailable", `R2 refused the probe (${response.status})`);
      }
      const declared = contentLength(response.headers.get("content-length"));
      const contentType = response.headers.get("content-type");
      const etag = response.headers.get("etag") ?? "";
      // Content length is not always present. Never consume an untrusted body
      // merely to infer its size: a head result feeds exact artifact checks,
      // so an unknown size must fail closed instead of becoming zero.
      cancelBody(response.body);
      if (declared === null) {
        throw new ObjectStoreError("unavailable", "R2 returned an invalid probe size");
      }
      return {
        key,
        size: declared,
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

    async list(input): Promise<ObjectListPage> {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        throw new ObjectStoreError("invalid", "list limit must be a positive integer");
      }
      const query = new URLSearchParams({
        prefix: input.prefix,
        per_page: String(Math.min(input.limit, 1_000)),
      });
      if (input.cursor !== undefined) query.set("cursor", input.cursor);
      let response: Response;
      try {
        response = await send(
          new Request(`${base}?${query.toString()}`, {
            method: "GET",
            headers: { authorization: await options.authorize() },
          }),
        );
      } catch {
        throw new ObjectStoreError("unavailable", "the R2 HTTP API is unreachable");
      }
      if (!response.ok) {
        throw new ObjectStoreError("unavailable", `R2 refused the listing (${response.status})`);
      }
      if (!response.body) {
        throw new ObjectStoreError("unavailable", "R2 returned an empty listing");
      }
      let listingBytes: Uint8Array;
      try {
        listingBytes = await readBoundedResponseBody(response.body, R2_LIST_MAX_BYTES);
      } catch (error) {
        if (error instanceof BoundedResponseBodyError && error.kind === "overrun") {
          throw new ObjectStoreError("unavailable", "R2 returned an oversized listing");
        }
        throw new ObjectStoreError("unavailable", "R2 returned an invalid listing");
      }
      let payload: unknown;
      try {
        payload = JSON.parse(new TextDecoder().decode(listingBytes));
      } catch {
        throw new ObjectStoreError("unavailable", "R2 returned an invalid listing");
      }
      if (!isRecord(payload) || !Array.isArray(payload.result) || !isRecord(payload.result_info)) {
        throw new ObjectStoreError("unavailable", "R2 returned an invalid listing");
      }
      const truncated = payload.result_info.is_truncated;
      const rawCursor = payload.result_info.cursor;
      const cursor = rawCursor === null ? undefined : rawCursor;
      if (
        typeof truncated !== "boolean" ||
        (truncated && (typeof cursor !== "string" || cursor.length === 0)) ||
        (!truncated && cursor !== undefined)
      ) {
        throw new ObjectStoreError("unavailable", "R2 returned invalid listing pagination");
      }
      if (payload.result.length > Math.min(input.limit, 1_000)) {
        throw new ObjectStoreError("unavailable", "R2 returned too many listed objects");
      }
      const objects = payload.result.map((value) => listedObject(value));
      return {
        objects,
        truncated,
        ...(truncated ? { cursor: cursor as string } : {}),
      };
    },
  };
}

class BoundedResponseBodyError extends Error {
  constructor(readonly kind: "overrun" | "read-error") {
    super(`bounded R2 response ${kind}`);
    this.name = "BoundedResponseBodyError";
  }
}

async function readBoundedResponseBody(
  stream: ReadableStream<Uint8Array>,
  maximum: number,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const result = await (async () => {
        try {
          return await reader.read();
        } catch {
          throw new BoundedResponseBodyError("read-error");
        }
      })();
      if (result.done) break;
      if (!(result.value instanceof Uint8Array) || result.value.byteLength > maximum - size) {
        cancelResponseBody(reader);
        throw new BoundedResponseBodyError("overrun");
      }
      chunks.push(result.value);
      size += result.value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function cancelResponseBody(
  stream: ReadableStream<Uint8Array> | ReadableStreamDefaultReader<Uint8Array>,
): void {
  try {
    void stream.cancel("R2 listing exceeded byte bound").catch(() => undefined);
  } catch {
    // The bounded refusal is authoritative even when cancellation is broken.
  }
}

function contentLength(value: string | null): number | null {
  if (value === null || !/^\d+$/u.test(value)) return null;
  const length = Number(value);
  return Number.isSafeInteger(length) && length >= 0 ? length : null;
}

function cancelBody(body: ReadableStream<Uint8Array> | null): void {
  if (!body) return;
  try {
    void body.cancel().catch(() => undefined);
  } catch {
    // A probe never waits for cancellation and does not turn a known response
    // into an unknown existence result because a body refused to cancel.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function listedObject(value: unknown): StoredObject {
  if (!isRecord(value) || typeof value.key !== "string") {
    throw new ObjectStoreError("unavailable", "R2 returned an invalid listed object");
  }
  const size = typeof value.size === "number" ? value.size : 0;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new ObjectStoreError("unavailable", "R2 returned an invalid listed object size");
  }
  const etag = typeof value.etag === "string" ? value.etag : "";
  const metadata = isRecord(value.http_metadata) ? value.http_metadata : undefined;
  const contentType =
    metadata && typeof metadata.content_type === "string"
      ? metadata.content_type
      : metadata && typeof metadata.contentType === "string"
        ? metadata.contentType
        : undefined;
  return {
    key: value.key,
    size,
    etag,
    ...(contentType ? { contentType } : {}),
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
