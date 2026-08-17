import { bytesDigest, canonicalDigest } from "../json.ts";
import type { Clock, ObjectStore, Sql } from "../ports.ts";
import { parseStrictJson, StrictJsonError } from "../strict-json.ts";
import { MAXIMUM_REQUEST_BODY_BYTES, TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES } from "./limits.ts";

/**
 * Tenant-held, content-addressed artifacts.
 *
 * Bytes live in the object store under `art/<digest>` and are shared across
 * tenants by content; *access* is granted per tenant through hold rows. That
 * gives deduplication without letting one tenant read another's bundle merely
 * because the bytes happen to match. Uploads are owned by the exact principal
 * that started them, so a second key in the same organization cannot finish
 * someone else's upload.
 */

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
// A leading dot is allowed because `.well-known` is a standard web path and
// refusing it would make a whole class of real sites undeployable. Traversal is
// blocked separately: `.` and `..` segments are rejected by name.
const PATH = /^[A-Za-z0-9_.][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9._-]*)*$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const ARTIFACT_PREFIX = "/apis/forms.takoform.com/v1alpha3/artifacts";
const REPLAY_TTL_MILLISECONDS = 24 * 60 * 60_000;

const MODULE_MEDIA = new Set([
  "application/javascript+module",
  "application/wasm",
  "text/plain",
  "application/octet-stream",
  "application/source-map+json",
]);
const LOADABLE_MEDIA = new Set([
  "application/javascript+module",
  "application/wasm",
  "text/plain",
  "application/octet-stream",
]);

export interface TakoformArtifactPrincipal {
  readonly tenantId: string;
  readonly principalId: string;
}

export type TakoformArtifactFailure = (code: string, status: number, details?: unknown) => Response;

interface BlobDeclaration {
  readonly name: string;
  readonly mediaType: string;
  readonly size: number;
  readonly digest: `sha256:${string}`;
}

export interface TakoformArtifactManifest {
  readonly apiVersion: "artifacts.takoform.com/v1alpha1";
  readonly kind: "WorkerBundle" | "StaticAssetBundle" | "MigrationBundle";
  readonly mainModule?: string;
  readonly modules?: readonly BlobDeclaration[];
  readonly files?: readonly BlobDeclaration[];
}

export interface TakoformArtifactTransport {
  handle(
    request: Request,
    principal: TakoformArtifactPrincipal,
    failure: TakoformArtifactFailure,
  ): Promise<Response | null>;
  resolveManifest(tenantId: string, digest: string): Promise<TakoformArtifactManifest | null>;
}

export class ArtifactInputError extends Error {
  constructor(
    readonly code = "artifact_invalid",
    readonly status = 400,
  ) {
    super(code);
    this.name = "ArtifactInputError";
  }
}

export interface CreateTakoformArtifactsOptions {
  readonly sql: Sql;
  readonly objects: ObjectStore;
  readonly clock: Clock;
  readonly randomId: () => string;
}

export function createTakoformArtifacts(
  options: CreateTakoformArtifactsOptions,
): TakoformArtifactTransport {
  const { sql, objects, clock, randomId } = options;
  const now = (): number => clock().getTime();
  const blobKey = (digest: string): string => `art/${digest.slice("sha256:".length)}`;

  const holds = async (tenantId: string, digest: string, kind: string): Promise<boolean> => {
    const rows = await sql.query(
      "SELECT 1 AS held FROM tf_artifact_holds WHERE tenant_id = ? AND digest = ? AND kind = ?",
      [tenantId, digest, kind],
    );
    return rows.length === 1;
  };

  const grant = async (tenantId: string, digest: string, kind: string): Promise<void> => {
    await sql.run(
      "INSERT OR IGNORE INTO tf_artifact_holds (tenant_id, digest, kind) VALUES (?, ?, ?)",
      [tenantId, digest, kind],
    );
  };

  const ownedUpload = async (
    principal: TakoformArtifactPrincipal,
    id: string,
  ): Promise<{ manifest: TakoformArtifactManifest; manifestDigest: string } | null> => {
    const rows = await sql.query(
      "SELECT manifest_json, manifest_digest FROM tf_artifact_uploads WHERE id = ? AND tenant_id = ? AND principal_id = ?",
      [id, principal.tenantId, principal.principalId],
    );
    const row = rows[0];
    if (!row) return null;
    return {
      manifest: JSON.parse(String(row.manifest_json)) as TakoformArtifactManifest,
      manifestDigest: String(row.manifest_digest),
    };
  };

  const readReplay = async (
    key: string,
  ): Promise<{ status: number; body?: Record<string, string> } | null> => {
    const rows = await sql.query(
      "SELECT status, body_json FROM tf_artifact_replays WHERE replay_key = ? AND expires_at > ?",
      [key, now()],
    );
    const row = rows[0];
    if (!row) return null;
    const body = row.body_json;
    return {
      status: Number(row.status),
      ...(typeof body === "string" ? { body: JSON.parse(body) as Record<string, string> } : {}),
    };
  };

  const writeReplay = async (
    key: string,
    value: { status: number; body?: Record<string, string> },
  ): Promise<void> => {
    await sql.run(
      `INSERT INTO tf_artifact_replays (replay_key, status, body_json, expires_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (replay_key) DO UPDATE SET
         status = excluded.status, body_json = excluded.body_json, expires_at = excluded.expires_at`,
      [
        key,
        value.status,
        value.body ? JSON.stringify(value.body) : null,
        now() + REPLAY_TTL_MILLISECONDS,
      ],
    );
  };

  return {
    async resolveManifest(tenantId, digest) {
      if (!DIGEST.test(digest)) return null;
      if (!(await holds(tenantId, digest, "manifest"))) return null;
      const rows = await sql.query(
        "SELECT manifest_json FROM tf_artifact_manifests WHERE digest = ?",
        [digest],
      );
      const row = rows[0];
      return row ? (JSON.parse(String(row.manifest_json)) as TakoformArtifactManifest) : null;
    },

    async handle(request, principal, failure) {
      const url = new URL(request.url);
      if (!url.pathname.startsWith(ARTIFACT_PREFIX)) return null;
      if (url.search !== "" || url.pathname.includes("%")) return failure("invalid_argument", 400);

      if (request.method === "POST" && url.pathname === `${ARTIFACT_PREFIX}/uploads`) {
        const key = requireIdempotencyKey(request);
        const envelope = await strictJsonObject(request);
        exactKeys(envelope, ["manifest"]);
        const manifest = parseManifest(envelope.manifest);
        const manifestDigest = await canonicalDigest(manifest);
        const replayKey = [principal.tenantId, principal.principalId, "start", key].join("\u0000");
        const replay = await readReplay(replayKey);
        if (replay) {
          if (replay.body?.manifestDigest !== manifestDigest)
            return failure("invalid_argument", 400);
          const uploadId = replay.body.uploadId ?? "";
          const existing = await ownedUpload(principal, uploadId);
          if (existing) {
            return Response.json({
              uploadId,
              missingBlobs: await missingBlobs(existing.manifest, principal.tenantId, holds),
            });
          }
        }
        const id = `up_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`;
        await sql.run(
          "INSERT INTO tf_artifact_uploads (id, tenant_id, principal_id, manifest_json, manifest_digest, created_at) VALUES (?, ?, ?, ?, ?, ?)",
          [
            id,
            principal.tenantId,
            principal.principalId,
            JSON.stringify(manifest),
            manifestDigest,
            now(),
          ],
        );
        await writeReplay(replayKey, { status: 201, body: { uploadId: id, manifestDigest } });
        return Response.json(
          { uploadId: id, missingBlobs: await missingBlobs(manifest, principal.tenantId, holds) },
          { status: 201 },
        );
      }

      let match = new RegExp(
        `^${ARTIFACT_PREFIX.replaceAll(".", "\\.")}/uploads/([^/]+)/blobs/(sha256:[0-9a-f]{64})$`,
        "u",
      ).exec(url.pathname);
      if (request.method === "PUT" && match) {
        const upload = await ownedUpload(principal, requiredSegment(match[1]));
        if (!upload) return failure("artifact_missing", 404);
        const digest = requiredDigest(match[2]);
        const declaration = declarations(upload.manifest).find((entry) => entry.digest === digest);
        if (!declaration) return failure("artifact_invalid", 400);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength !== declaration.size || (await bytesDigest(bytes)) !== digest) {
          return failure("artifact_invalid", 400);
        }
        await objects.put(blobKey(digest), bytes, { contentType: declaration.mediaType });
        await grant(principal.tenantId, digest, "blob");
        return new Response(null, { status: 201 });
      }

      match = new RegExp(
        `^${ARTIFACT_PREFIX.replaceAll(".", "\\.")}/uploads/([^/]+)/commit$`,
        "u",
      ).exec(url.pathname);
      if (request.method === "POST" && match) {
        const key = requireIdempotencyKey(request);
        const replayKey = terminalReplayKey(principal, request, key);
        const replay = await readReplay(replayKey);
        if (replay) return replayArtifactResponse(replay);
        const upload = await ownedUpload(principal, requiredSegment(match[1]));
        if (!upload) return failure("artifact_missing", 404);
        // The manifest is not parsed again here. `parseManifest` reads the wire
        // grammar, where a StaticAssetBundle file carries `path`; what a row
        // holds is the parsed value, whose declarations carry `name`. Feeding
        // one to the other rejected every asset bundle ever committed. The row
        // exists only because a parse already succeeded.
        //
        // The checks run in waves rather than one at a time. A site bundle is
        // hundreds of files, and against an object store reached over HTTP a
        // serial pass spends the whole request in round trips — long enough
        // that the server closed the connection before it could answer.
        const verdicts = await inWaves(declarations(upload.manifest), 16, async (declaration) => {
          if (!(await holds(principal.tenantId, declaration.digest, "blob"))) {
            return { code: "artifact_missing", status: 404, detail: "no hold", declaration };
          }
          const stored = await objects.head(blobKey(declaration.digest));
          if (!stored) {
            return { code: "artifact_missing", status: 404, detail: "absent blob", declaration };
          }
          if (stored.size !== declaration.size) {
            return {
              code: "artifact_invalid",
              status: 400,
              detail: `stored ${stored.size}`,
              declaration,
            };
          }
          return null;
        });
        const rejected = verdicts.find((verdict) => verdict !== null);
        if (rejected) {
          return refuse(
            failure,
            rejected.code,
            rejected.status,
            rejected.detail,
            rejected.declaration,
          );
        }
        const existed =
          (
            await sql.query("SELECT 1 AS present FROM tf_artifact_manifests WHERE digest = ?", [
              upload.manifestDigest,
            ])
          ).length === 1;
        await sql.run(
          "INSERT OR IGNORE INTO tf_artifact_manifests (digest, manifest_json, created_at) VALUES (?, ?, ?)",
          [upload.manifestDigest, JSON.stringify(upload.manifest), now()],
        );
        await grant(principal.tenantId, upload.manifestDigest, "manifest");
        await inWaves(declarations(upload.manifest), 16, (declaration) =>
          grant(principal.tenantId, declaration.digest, "blob"),
        );
        const result = {
          status: existed ? 200 : 201,
          body: { manifestDigest: upload.manifestDigest },
        };
        await writeReplay(replayKey, result);
        return replayArtifactResponse(result);
      }

      match = new RegExp(`^${ARTIFACT_PREFIX.replaceAll(".", "\\.")}/uploads/([^/]+)$`, "u").exec(
        url.pathname,
      );
      if (request.method === "DELETE" && match) {
        const key = requireIdempotencyKey(request);
        const replayKey = terminalReplayKey(principal, request, key);
        const replay = await readReplay(replayKey);
        if (replay) return replayArtifactResponse(replay);
        const id = requiredSegment(match[1]);
        if (!(await ownedUpload(principal, id))) return failure("artifact_missing", 404);
        await sql.run("DELETE FROM tf_artifact_uploads WHERE id = ?", [id]);
        await writeReplay(replayKey, { status: 204 });
        return new Response(null, { status: 204 });
      }

      match = new RegExp(
        `^${ARTIFACT_PREFIX.replaceAll(".", "\\.")}/(sha256:[0-9a-f]{64})$`,
        "u",
      ).exec(url.pathname);
      if (request.method === "GET" && match) {
        const manifest = await this.resolveManifest(principal.tenantId, requiredDigest(match[1]));
        if (!manifest) return failure("artifact_missing", 404);
        return Response.json(manifest);
      }

      match = new RegExp(
        `^${ARTIFACT_PREFIX.replaceAll(".", "\\.")}/blobs/(sha256:[0-9a-f]{64})$`,
        "u",
      ).exec(url.pathname);
      if (request.method === "HEAD" && match) {
        const digest = requiredDigest(match[1]);
        if (!(await holds(principal.tenantId, digest, "blob"))) {
          return new Response(null, { status: 404 });
        }
        const stored = await objects.head(blobKey(digest));
        if (!stored) return new Response(null, { status: 404 });
        return new Response(null, {
          status: 200,
          headers: { "content-length": stored.size.toString() },
        });
      }
      return failure("invalid_argument", 404);
    },
  };
}

async function missingBlobs(
  manifest: TakoformArtifactManifest,
  tenantId: string,
  holds: (tenantId: string, digest: string, kind: string) => Promise<boolean>,
): Promise<readonly string[]> {
  const missing: string[] = [];
  for (const declaration of declarations(manifest)) {
    if (!(await holds(tenantId, declaration.digest, "blob"))) missing.push(declaration.digest);
  }
  return missing;
}

/**
 * Runs `work` over every item, at most `width` in flight.
 *
 * Unbounded `Promise.all` over a thousand-file manifest would open a thousand
 * sockets at once and be refused by the other end; one at a time is too slow to
 * finish inside a request. Waves keep both ends within what they can serve.
 */
async function inWaves<Item, Result>(
  items: readonly Item[],
  width: number,
  work: (item: Item) => Promise<Result>,
): Promise<readonly Result[]> {
  const results: Result[] = [];
  for (let start = 0; start < items.length; start += width) {
    results.push(...(await Promise.all(items.slice(start, start + width).map(work))));
  }
  return results;
}

/**
 * Refuse a commit, and say server-side which declaration was at fault.
 *
 * The wire answer stays the bare envelope a caller is promised; without the
 * log, "artifact_invalid" on a commit of hundreds of files names no file, and
 * the only way to find the bad one is to bisect the upload.
 */
function refuse(
  failure: (code: string, status: number) => Response,
  code: string,
  status: number,
  detail: string,
  declaration: BlobDeclaration,
): Response {
  if (process.env?.["TAKOSERVER_TRACE_HOST_ERRORS"]) {
    console.warn(
      `takoserver.artifacts.refused ${code} ${detail} name=${declaration.name} size=${declaration.size} digest=${declaration.digest}`,
    );
  }
  return failure(code, status);
}

function parseManifest(input: unknown): TakoformArtifactManifest {
  if (!isRecord(input)) throw new ArtifactInputError();
  const kind = input.kind;
  if (
    input.apiVersion !== "artifacts.takoform.com/v1alpha1" ||
    (kind !== "WorkerBundle" && kind !== "StaticAssetBundle" && kind !== "MigrationBundle")
  ) {
    throw new ArtifactInputError();
  }
  if (kind === "WorkerBundle") {
    exactKeys(input, ["apiVersion", "kind", "mainModule", "modules"]);
    const mainModule = artifactPath(input.mainModule);
    const modules = blobDeclarations(input.modules, true, 4_096);
    const main = modules.find((entry) => entry.name === mainModule);
    if (!main || !LOADABLE_MEDIA.has(main.mediaType)) throw new ArtifactInputError();
    const names = new Set(modules.map((entry) => entry.name));
    let totalBytes = 0;
    for (const module of modules) {
      totalBytes += module.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES) {
        throw new ArtifactInputError();
      }
      // A source map is only meaningful alongside the module it describes.
      if (module.mediaType === "application/source-map+json") {
        if (!module.name.endsWith(".map") || !names.has(module.name.slice(0, -4))) {
          throw new ArtifactInputError();
        }
      }
    }
    return { apiVersion: input.apiVersion, kind, mainModule, modules };
  }
  exactKeys(input, ["apiVersion", "kind", "files"]);
  return {
    apiVersion: input.apiVersion,
    kind,
    files: blobDeclarations(input.files, false, 16_384),
  };
}

function blobDeclarations(
  input: unknown,
  modules: boolean,
  limit: number,
): readonly BlobDeclaration[] {
  if (!Array.isArray(input) || input.length === 0 || input.length > limit) {
    throw new ArtifactInputError();
  }
  const names = new Set<string>();
  return input.map((candidate) => {
    if (!isRecord(candidate)) throw new ArtifactInputError();
    exactKeys(candidate, [modules ? "name" : "path", "mediaType", "size", "digest"]);
    const name = artifactPath(candidate[modules ? "name" : "path"]);
    const mediaType = string(candidate.mediaType);
    if (modules ? !MODULE_MEDIA.has(mediaType) : !MEDIA_TYPE.test(mediaType)) {
      throw new ArtifactInputError();
    }
    if (names.has(name)) throw new ArtifactInputError();
    names.add(name);
    if (
      !Number.isInteger(candidate.size) ||
      (candidate.size as number) < 0 ||
      (candidate.size as number) > 268_435_456
    ) {
      throw new ArtifactInputError();
    }
    return {
      name,
      mediaType,
      size: candidate.size as number,
      digest: requiredDigest(string(candidate.digest)),
    };
  });
}

function declarations(manifest: TakoformArtifactManifest): readonly BlobDeclaration[] {
  return manifest.modules ?? manifest.files ?? [];
}

async function strictJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ArtifactInputError();
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAXIMUM_REQUEST_BODY_BYTES) {
    throw new ArtifactInputError();
  }
  try {
    const parsed = parseStrictJson(bytes, MAXIMUM_REQUEST_BODY_BYTES);
    if (!isRecord(parsed)) throw new ArtifactInputError();
    return parsed;
  } catch (error) {
    if (!(error instanceof StrictJsonError)) throw error;
    throw new ArtifactInputError();
  }
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): void {
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...keys].sort())) {
    throw new ArtifactInputError();
  }
}

function artifactPath(value: unknown): string {
  const parsed = string(value);
  if (
    parsed.length > 240 ||
    !PATH.test(parsed) ||
    parsed.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new ArtifactInputError();
  }
  return parsed;
}

function requiredDigest(value: string | undefined): `sha256:${string}` {
  if (!value || !DIGEST.test(value)) throw new ArtifactInputError();
  return value as `sha256:${string}`;
}

function requiredSegment(value: string | undefined): string {
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(value)) {
    throw new ArtifactInputError();
  }
  return value;
}

function requireIdempotencyKey(request: Request): string {
  const value = request.headers.get("idempotency-key");
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/u.test(value)) {
    throw new ArtifactInputError("invalid_argument", 400);
  }
  return value;
}

function terminalReplayKey(
  principal: TakoformArtifactPrincipal,
  request: Request,
  idempotencyKey: string,
): string {
  const url = new URL(request.url);
  return [
    principal.tenantId,
    principal.principalId,
    request.method,
    url.pathname,
    idempotencyKey,
  ].join("\u0000");
}

function replayArtifactResponse(replay: {
  readonly status: number;
  readonly body?: Record<string, string>;
}): Response {
  return replay.body
    ? Response.json(replay.body, { status: replay.status })
    : new Response(null, { status: replay.status });
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new ArtifactInputError();
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
