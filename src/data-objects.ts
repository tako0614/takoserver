import type { ObjectStore } from "./ports.ts";
import { TokenError, type TokenService } from "./token.ts";

/**
 * Reaching the bucket you were sold.
 *
 * A customer provisions an ObjectBucket and is handed a name — of a bucket in
 * *our* cloud account, which they hold no credential for. The catalogue said
 * the offering speaks `s3` and every bucket's outputs repeated it, and until
 * this existed neither was true: the resource was a line in a list and a charge
 * on a wallet.
 *
 * So this is the door. It is not the whole of S3 and does not pretend to be —
 * put an object, get it, ask whether it is there, delete it, list what a prefix
 * holds. That is what a bucket is for, and every one of them is a thing a
 * person can do today rather than a compatibility surface nobody finishes.
 *
 * Authority is a short-lived token bound to one resource. Not the
 * organization's API key: that key can provision, and a program that only needs
 * to write a file should not be able to spend money. The token is minted by
 * somebody who holds the key, expires on its own, and names exactly one bucket
 * — so a leaked one is a leak of one bucket for one hour, which is a different
 * kind of accident.
 *
 * Keys are namespaced by the resource's uid, so two tenants' buckets cannot
 * name the same object even though they share a store.
 */

const MAX_KEY_BYTES = 1_024;
const MAX_LIST = 1_000;
/** Refused rather than streamed: a body this large is a different feature. */
const MAX_OBJECT_BYTES = 100 * 1_024 * 1_024;

export interface DataObjectsOptions {
  readonly objects: ObjectStore;
  readonly tokens: TokenService;
  /** Records what was moved, for the meter. */
  readonly record?: (usage: DataUsage) => Promise<void>;
}

export interface DataUsage {
  readonly organizationId: string;
  readonly resourceUid: string;
  readonly operation: "put" | "get" | "head" | "delete" | "list";
  readonly bytes: number;
}

export type DataObjectRoutes = (request: Request, url: URL) => Promise<Response | null>;

const PREFIX = "/data/v1/objects/";

export function createDataObjectRoutes(options: DataObjectsOptions): DataObjectRoutes {
  const { objects, tokens } = options;

  return async (request, url) => {
    if (!url.pathname.startsWith(PREFIX)) return null;

    const rest = url.pathname.slice(PREFIX.length);
    const slash = rest.indexOf("/");
    const resourceUid = decodeURIComponent(slash === -1 ? rest : rest.slice(0, slash));
    const key = slash === -1 ? "" : decodeURIComponent(rest.slice(slash + 1));
    if (resourceUid === "") return failure("invalid_argument", 400);

    let claims: { readonly organizationId: string };
    try {
      claims = await tokens.verifyDataToken(bearer(request), { resourceUid, protocol: "s3" });
    } catch (error) {
      // Every reason a token is unusable reads the same from outside. Which
      // one it was tells a holder something about a token they were not given.
      if (error instanceof TokenError) return failure("unauthenticated", 401);
      throw error;
    }

    const stored = (suffix: string): string => `res/${resourceUid}/${suffix}`;

    if (request.method === "GET" && key === "") {
      const prefix = url.searchParams.get("prefix") ?? "";
      if (!validKey(prefix, true)) return failure("invalid_argument", 400);
      const limit = Number(url.searchParams.get("limit") ?? "100");
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST) {
        return failure("invalid_argument", 400);
      }
      const cursor = url.searchParams.get("cursor");
      const page = await objects.list({
        prefix: stored(prefix),
        limit,
        ...(cursor ? { cursor } : {}),
      });
      await options.record?.({
        organizationId: claims.organizationId,
        resourceUid,
        operation: "list",
        bytes: 0,
      });
      return Response.json({
        objects: page.objects.map((object) => ({
          // The storage layout is ours. A caller sees the key they wrote.
          key: object.key.slice(`res/${resourceUid}/`.length),
          size: object.size,
          etag: object.etag,
          ...(object.contentType ? { contentType: object.contentType } : {}),
        })),
        truncated: page.truncated,
        ...(page.cursor ? { cursor: page.cursor } : {}),
      });
    }

    if (!validKey(key, false)) return failure("invalid_argument", 400);

    if (request.method === "PUT") {
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (Number.isSafeInteger(declared) && declared > MAX_OBJECT_BYTES) {
        return failure("payload_too_large", 413);
      }
      const bytes = new Uint8Array(await request.arrayBuffer());
      if (bytes.byteLength > MAX_OBJECT_BYTES) return failure("payload_too_large", 413);
      const contentType = request.headers.get("content-type");
      const written = await objects.put(stored(key), bytes, {
        ...(contentType ? { contentType } : {}),
      });
      await options.record?.({
        organizationId: claims.organizationId,
        resourceUid,
        operation: "put",
        bytes: bytes.byteLength,
      });
      return new Response(null, { status: 201, headers: { etag: written.etag } });
    }

    if (request.method === "GET" || request.method === "HEAD") {
      if (request.method === "HEAD") {
        const probe = await objects.head(stored(key));
        if (!probe) return failure("not_found", 404);
        await options.record?.({
          organizationId: claims.organizationId,
          resourceUid,
          operation: "head",
          bytes: 0,
        });
        return new Response(null, {
          headers: {
            etag: probe.etag,
            "content-length": String(probe.size),
            ...(probe.contentType ? { "content-type": probe.contentType } : {}),
          },
        });
      }
      const found = await objects.get(stored(key));
      if (!found) return failure("not_found", 404);
      await options.record?.({
        organizationId: claims.organizationId,
        resourceUid,
        operation: "get",
        bytes: found.size,
      });
      return new Response(found.body, {
        headers: {
          etag: found.etag,
          ...(found.contentType ? { "content-type": found.contentType } : {}),
        },
      });
    }

    if (request.method === "DELETE") {
      const removed = await objects.delete(stored(key));
      await options.record?.({
        organizationId: claims.organizationId,
        resourceUid,
        operation: "delete",
        bytes: 0,
      });
      // `removed` is read and discarded on purpose. A delete that finds
      // nothing has achieved what it asked for, and saying otherwise turns a
      // retry — the ordinary response to a dropped connection — into an error.
      void removed;
      return new Response(null, { status: 204 });
    }

    return failure("method_not_allowed", 405);
  };
}

function bearer(request: Request): string {
  const header = request.headers.get("authorization") ?? "";
  return header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
}

/**
 * A key a caller may use.
 *
 * Traversal is refused rather than normalised: `a/../b` has an obvious meaning
 * to a person and a dangerous one to a store that joins strings, and the gap
 * between those two readings is where objects escape their bucket.
 */
function validKey(key: string, allowEmpty: boolean): boolean {
  if (key === "") return allowEmpty;
  if (new TextEncoder().encode(key).byteLength > MAX_KEY_BYTES) return false;
  if (key.startsWith("/") || key.includes("//") || key.includes("\u0000")) return false;
  return key.split("/").every((segment) => segment !== "." && segment !== "..");
}

function failure(code: string, status: number): Response {
  return Response.json({ error: { code, message: code.replaceAll("_", " ") } }, { status });
}
