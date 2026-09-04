import {
  type ObjectListPage,
  type ObjectStore,
  ObjectStoreError,
  type StoredObject,
  type StoredObjectBody,
} from "./ports.ts";

/**
 * The R2 binding shape this adapter needs, declared structurally so the file
 * compiles in the Bun type world too. The generated `Env["OBJECTS"]` satisfies
 * it.
 *
 * This is a binding, never the Cloudflare REST API: the worker bundle gate
 * rejects any build that reaches api.cloudflare.com or names a credential.
 */
export interface R2ObjectLike {
  readonly key: string;
  readonly size: number;
  readonly etag: string;
  readonly httpMetadata?: { readonly contentType?: string } | undefined;
  readonly customMetadata?: Readonly<Record<string, string>> | undefined;
}

export interface R2ObjectBodyLike extends R2ObjectLike {
  readonly body: ReadableStream<Uint8Array>;
}

export interface R2ListedLike {
  readonly objects: readonly R2ObjectLike[];
  readonly truncated: boolean;
  readonly cursor?: string | undefined;
}

export interface R2BucketLike {
  put(
    key: string,
    body: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
    options?: {
      readonly httpMetadata?: { readonly contentType?: string };
      readonly customMetadata?: Readonly<Record<string, string>>;
      readonly onlyIf?: { readonly etagDoesNotMatch: "*" };
    },
  ): Promise<R2ObjectLike | null>;
  get(key: string): Promise<R2ObjectBodyLike | null>;
  head(key: string): Promise<R2ObjectLike | null>;
  delete(key: string): Promise<void>;
  list(options?: {
    readonly prefix?: string;
    readonly limit?: number;
    readonly cursor?: string;
    readonly include?: ("httpMetadata" | "customMetadata")[];
  }): Promise<R2ListedLike>;
}

const WRITE_OPERATION_METADATA_KEY = "takoserver-write-operation-id";

/** `ObjectStore` over an R2 Worker binding. Bodies stay streamed end to end. */
export function createR2ObjectStore(bucket: R2BucketLike): ObjectStore {
  if (
    !bucket ||
    typeof bucket.put !== "function" ||
    typeof bucket.get !== "function" ||
    typeof bucket.head !== "function" ||
    typeof bucket.delete !== "function" ||
    typeof bucket.list !== "function"
  ) {
    throw new TypeError("an R2 bucket binding is required");
  }

  return {
    writeOperationIdentity: "exact",

    async create(key, body, options): Promise<StoredObject | null> {
      const contentType = options?.contentType;
      const writeOperationId = options?.writeOperationId;
      const written = await bucket.put(key, body, {
        ...(contentType ? { httpMetadata: { contentType } } : {}),
        ...(writeOperationId
          ? { customMetadata: { [WRITE_OPERATION_METADATA_KEY]: writeOperationId } }
          : {}),
        onlyIf: { etagDoesNotMatch: "*" },
      });
      return written ? described(written) : null;
    },

    async put(key, body, options): Promise<StoredObject> {
      const contentType = options?.contentType;
      const writeOperationId = options?.writeOperationId;
      const putOptions = {
        ...(contentType ? { httpMetadata: { contentType } } : {}),
        ...(writeOperationId
          ? { customMetadata: { [WRITE_OPERATION_METADATA_KEY]: writeOperationId } }
          : {}),
      };
      const written = await bucket.put(
        key,
        body,
        Object.keys(putOptions).length > 0 ? putOptions : undefined,
      );
      if (!written) throw new ObjectStoreError("unavailable", "R2 did not acknowledge the write");
      return described(written);
    },

    async get(key): Promise<StoredObjectBody | null> {
      const found = await bucket.get(key);
      if (!found) return null;
      return { ...described(found), body: found.body };
    },

    async head(key): Promise<StoredObject | null> {
      const found = await bucket.head(key);
      return found ? described(found) : null;
    },

    async delete(key): Promise<boolean> {
      // R2 deletes are idempotent and report no prior existence, so existence is
      // established first for callers that distinguish 204 from 404.
      const existed = (await bucket.head(key)) !== null;
      await bucket.delete(key);
      return existed;
    },

    async list(input): Promise<ObjectListPage> {
      if (!Number.isSafeInteger(input.limit) || input.limit <= 0) {
        throw new ObjectStoreError("invalid", "list limit must be a positive integer");
      }
      const page = await bucket.list({
        prefix: input.prefix,
        limit: input.limit,
        include: ["httpMetadata", "customMetadata"],
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
      return {
        objects: page.objects.map(described),
        truncated: page.truncated,
        ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
      };
    },
  };
}

function described(object: R2ObjectLike): StoredObject {
  const contentType = object.httpMetadata?.contentType;
  const writeOperationId = object.customMetadata?.[WRITE_OPERATION_METADATA_KEY];
  if (!Number.isSafeInteger(object.size) || object.size < 0) {
    throw new ObjectStoreError("unavailable", "R2 reported an invalid object size");
  }
  return {
    key: object.key,
    size: object.size,
    etag: object.etag,
    ...(contentType ? { contentType } : {}),
    ...(writeOperationId ? { writeOperationId } : {}),
  };
}
