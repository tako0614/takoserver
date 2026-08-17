import type { JsonObject } from "./backends.ts";
import { executionIntentDigest } from "./runtime-grants.ts";
import { parseStrictJson, StrictJsonError } from "./strict-json.ts";

const DIGEST = /^sha256:[0-9a-f]{64}$/u;
const PATH = /^[A-Za-z0-9_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_][A-Za-z0-9._-]*)*$/u;
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
export const TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES = 10_485_760;

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

interface Upload {
  readonly id: string;
  readonly owner: TakoformArtifactPrincipal;
  readonly manifest: TakoformArtifactManifest;
  readonly manifestDigest: `sha256:${string}`;
}

export interface TakoformArtifactTransport {
  handle(
    request: Request,
    principal: TakoformArtifactPrincipal,
    failure: TakoformArtifactFailure,
  ): Promise<Response | null>;
  resolveManifest(tenantId: string, digest: string): TakoformArtifactManifest | null;
}

export function createInMemoryTakoformArtifactTransport(
  options: { readonly randomId?: () => string } = {},
): TakoformArtifactTransport {
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const uploads = new Map<string, Upload>();
  const startReplays = new Map<string, { readonly digest: string; readonly uploadId: string }>();
  const blobs = new Map<string, Uint8Array>();
  const manifests = new Map<string, TakoformArtifactManifest>();
  const tenantBlobHolds = new Map<string, Set<string>>();
  const tenantManifestHolds = new Map<string, Set<string>>();
  const terminalReplays = new Map<
    string,
    { readonly status: number; readonly body?: Readonly<Record<string, string>> }
  >();

  const holds = (table: Map<string, Set<string>>, tenantId: string, value: string): boolean =>
    table.get(tenantId)?.has(value) === true;
  const grant = (table: Map<string, Set<string>>, tenantId: string, value: string): void => {
    const values = table.get(tenantId) ?? new Set<string>();
    values.add(value);
    table.set(tenantId, values);
  };
  const ownedUpload = (principal: TakoformArtifactPrincipal, id: string): Upload | undefined => {
    const upload = uploads.get(id);
    return upload?.owner.tenantId === principal.tenantId &&
      upload.owner.principalId === principal.principalId
      ? upload
      : undefined;
  };

  return {
    resolveManifest(tenantId, digest) {
      const manifest = manifests.get(digest);
      return manifest && holds(tenantManifestHolds, tenantId, digest)
        ? structuredClone(manifest)
        : null;
    },

    async handle(request, principal, failure) {
      const url = new URL(request.url);
      const prefix = "/apis/forms.takoform.com/v1alpha3/artifacts";
      if (!url.pathname.startsWith(prefix)) return null;
      if (url.search !== "" || url.pathname.includes("%")) {
        return failure("invalid_argument", 400);
      }

      if (request.method === "POST" && url.pathname === `${prefix}/uploads`) {
        const idempotencyKey = requireIdempotencyKey(request);
        const envelope = await strictJsonObject(request);
        exactKeys(envelope, ["manifest"]);
        const manifest = parseManifest(envelope.manifest);
        const manifestDigest = (await executionIntentDigest(manifest)) as `sha256:${string}`;
        const replayKey = `${principal.tenantId}\0${principal.principalId}\0${idempotencyKey}`;
        const replay = startReplays.get(replayKey);
        if (replay) {
          if (replay.digest !== manifestDigest) return failure("invalid_argument", 400);
          const existing = uploads.get(replay.uploadId);
          if (existing) {
            return Response.json({
              uploadId: existing.id,
              missingBlobs: declarations(existing.manifest)
                .map((entry) => entry.digest)
                .filter((digest) => !holds(tenantBlobHolds, principal.tenantId, digest)),
            });
          }
        }
        const id = `up_${randomId().replace(/[^A-Za-z0-9._-]/gu, "")}`;
        uploads.set(id, { id, owner: { ...principal }, manifest, manifestDigest });
        startReplays.set(replayKey, { digest: manifestDigest, uploadId: id });
        const missingBlobs = declarations(manifest)
          .map((entry) => entry.digest)
          .filter((digest) => !holds(tenantBlobHolds, principal.tenantId, digest));
        return Response.json({ uploadId: id, missingBlobs }, { status: 201 });
      }

      let match =
        /^\/apis\/forms\.takoform\.com\/v1alpha3\/artifacts\/uploads\/([^/]+)\/blobs\/(sha256:[0-9a-f]{64})$/u.exec(
          url.pathname,
        );
      if (request.method === "PUT" && match) {
        const upload = ownedUpload(principal, requiredSegment(match[1]));
        if (!upload) return failure("artifact_missing", 404);
        const digest = requiredDigest(match[2]);
        const declaration = declarations(upload.manifest).find((entry) => entry.digest === digest);
        if (!declaration) return failure("artifact_invalid", 400);
        const bytes = new Uint8Array(await request.arrayBuffer());
        if (bytes.byteLength !== declaration.size || (await sha256(bytes)) !== digest) {
          return failure("artifact_invalid", 400);
        }
        blobs.set(digest, bytes.slice());
        grant(tenantBlobHolds, principal.tenantId, digest);
        return new Response(null, { status: 201 });
      }

      match = /^\/apis\/forms\.takoform\.com\/v1alpha3\/artifacts\/uploads\/([^/]+)\/commit$/u.exec(
        url.pathname,
      );
      if (request.method === "POST" && match) {
        const idempotencyKey = requireIdempotencyKey(request);
        const replayKey = terminalReplayKey(principal, request, idempotencyKey);
        const replay = terminalReplays.get(replayKey);
        if (replay) return replayArtifactResponse(replay);
        const upload = ownedUpload(principal, requiredSegment(match[1]));
        if (!upload) return failure("artifact_missing", 404);
        parseManifest(upload.manifest);
        for (const declaration of declarations(upload.manifest)) {
          const bytes = blobs.get(declaration.digest);
          if (!bytes || !holds(tenantBlobHolds, principal.tenantId, declaration.digest)) {
            return failure("artifact_missing", 404);
          }
          if (
            bytes.byteLength !== declaration.size ||
            (await sha256(bytes)) !== declaration.digest
          ) {
            return failure("artifact_invalid", 400);
          }
        }
        const existed = manifests.has(upload.manifestDigest);
        manifests.set(upload.manifestDigest, structuredClone(upload.manifest));
        grant(tenantManifestHolds, principal.tenantId, upload.manifestDigest);
        for (const declaration of declarations(upload.manifest)) {
          grant(tenantBlobHolds, principal.tenantId, declaration.digest);
        }
        const result = {
          status: existed ? 200 : 201,
          body: { manifestDigest: upload.manifestDigest },
        } as const;
        terminalReplays.set(replayKey, result);
        return replayArtifactResponse(result);
      }

      match = /^\/apis\/forms\.takoform\.com\/v1alpha3\/artifacts\/uploads\/([^/]+)$/u.exec(
        url.pathname,
      );
      if (request.method === "DELETE" && match) {
        const idempotencyKey = requireIdempotencyKey(request);
        const replayKey = terminalReplayKey(principal, request, idempotencyKey);
        const replay = terminalReplays.get(replayKey);
        if (replay) return replayArtifactResponse(replay);
        const id = requiredSegment(match[1]);
        if (!ownedUpload(principal, id)) return failure("artifact_missing", 404);
        uploads.delete(id);
        terminalReplays.set(replayKey, { status: 204 });
        return new Response(null, { status: 204 });
      }

      match = /^\/apis\/forms\.takoform\.com\/v1alpha3\/artifacts\/(sha256:[0-9a-f]{64})$/u.exec(
        url.pathname,
      );
      if (request.method === "GET" && match) {
        const digest = requiredDigest(match[1]);
        const manifest = manifests.get(digest);
        if (!manifest || !holds(tenantManifestHolds, principal.tenantId, digest)) {
          return failure("artifact_missing", 404);
        }
        return Response.json(structuredClone(manifest));
      }

      match =
        /^\/apis\/forms\.takoform\.com\/v1alpha3\/artifacts\/blobs\/(sha256:[0-9a-f]{64})$/u.exec(
          url.pathname,
        );
      if (request.method === "HEAD" && match) {
        const digest = requiredDigest(match[1]);
        const blob = blobs.get(digest);
        if (!blob || !holds(tenantBlobHolds, principal.tenantId, digest)) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, {
          status: 200,
          headers: { "content-length": blob.byteLength.toString() },
        });
      }
      return failure("invalid_argument", 404);
    },
  };
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

const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;

function declarations(manifest: TakoformArtifactManifest): readonly BlobDeclaration[] {
  return manifest.modules ?? manifest.files ?? [];
}

async function strictJsonObject(request: Request): Promise<Record<string, unknown>> {
  if (!request.headers.get("content-type")?.toLowerCase().startsWith("application/json")) {
    throw new ArtifactInputError();
  }
  const bytes = new Uint8Array(await request.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > 1_048_576) throw new ArtifactInputError();
  try {
    const parsed = parseStrictJson(bytes, 1_048_576);
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
  return `${principal.tenantId}\0${principal.principalId}\0${request.method}\0${url.pathname}\0${idempotencyKey}`;
}

function replayArtifactResponse(replay: {
  readonly status: number;
  readonly body?: Readonly<Record<string, string>>;
}): Response {
  return replay.body
    ? Response.json(replay.body, { status: replay.status })
    : new Response(null, { status: replay.status });
}

async function sha256(bytes: Uint8Array): Promise<`sha256:${string}`> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer),
  );
  return `sha256:${[...digest].map((value) => value.toString(16).padStart(2, "0")).join("")}`;
}

function string(value: unknown): string {
  if (typeof value !== "string") throw new ArtifactInputError();
  return value;
}

function isRecord(value: unknown): value is JsonObject & Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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
