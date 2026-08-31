import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { bytesDigest, canonicalDigest, canonicalJson, isSha256Digest } from "../json.ts";

/**
 * The durable format for a self-hosted Worker Version.
 *
 * `meta.json` is intentionally a complete inventory rather than a pointer to
 * the source manifest.  A future process can therefore decide whether a
 * directory is complete without relying on an artifact store that may be
 * unavailable.  The inventory digest is over this normalized shape and the
 * bytes are checked against every canonical sha256 digest before a directory
 * is considered present.
 */
export const SELFHOST_VERSION_MATERIALIZATION_FORMAT =
  "takoserver.selfhost-version-materialization@v1" as const;

const SELFHOST_VERSION_STAGING_FORMAT = "takoserver.selfhost-version-staging@v1" as const;
const META_FILE = "meta.json";
const STAGING_MARKER_SUFFIX = ".marker.json";
const MODULES_DIRECTORY = "modules";
const ASSETS_DIRECTORY = "assets";
const MAX_PATH_LENGTH = 240;
const MAX_MEDIA_TYPE_LENGTH = 255;
const MAX_WORKER_ENTRIES = 4_096;
const MAX_ASSET_ENTRIES = 16_384;
const MAX_BUNDLE_BYTES = 10_485_760;
const MAX_DECLARED_BYTES = MAX_BUNDLE_BYTES;
const SAFE_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,254}$/u;
const SAFE_PATH = /^[A-Za-z0-9_.][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_.][A-Za-z0-9._-]*)*$/u;
const DIGEST = /^sha256:[A-Za-z0-9._-]{1,128}$/u;
const MEDIA_TYPE = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/u;
const MODULE_MEDIA = new Set([
  "application/javascript+module",
  "application/wasm",
  "text/plain",
  "application/octet-stream",
  "application/source-map+json",
]);
const MATERIALIZATION_MUTEXES = new Map<string, Promise<void>>();

export interface SelfhostVersionArtifactEntry {
  readonly name?: string;
  readonly path?: string;
  readonly mediaType?: string;
  readonly size?: number;
  readonly digest: string;
}

export interface SelfhostVersionArtifactManifest {
  readonly apiVersion?: string;
  readonly kind: string;
  readonly mainModule?: string;
  readonly modules?: readonly SelfhostVersionArtifactEntry[];
  readonly files?: readonly SelfhostVersionArtifactEntry[];
  readonly [key: string]: unknown;
}

export interface SelfhostVersionArtifacts {
  manifest(tenantRef: string, digest: string): Promise<SelfhostVersionArtifactManifest | null>;
  blob(digest: string): Promise<Uint8Array | null>;
}

export interface SelfhostVersionMaterializationRequest {
  readonly tenantRef: string;
  readonly script: string;
  readonly versionId: string;
  readonly manifestDigest: string;
  readonly assets?: {
    readonly manifestDigest: string;
    readonly notFoundHandling: string;
  };
}

export interface SelfhostVersionInventoryEntry {
  readonly path: string;
  readonly digest: string;
  readonly size: number;
  readonly mediaType?: string;
}

export interface SelfhostVersionMaterializationMeta {
  readonly format: typeof SELFHOST_VERSION_MATERIALIZATION_FORMAT;
  readonly materializationDigest: `sha256:${string}`;
  readonly manifestDigest: string;
  readonly mainModule: string;
  readonly modules: readonly SelfhostVersionInventoryEntry[];
  readonly assets?: {
    readonly manifestDigest: string;
    readonly notFoundHandling: string;
    readonly files: readonly SelfhostVersionInventoryEntry[];
  };
}

export type SelfhostVersionInspection =
  | { readonly state: "absent" }
  | {
      readonly state: "present";
      readonly digest: `sha256:${string}`;
      readonly meta: SelfhostVersionMaterializationMeta;
    }
  | { readonly state: "corrupt" };

export interface PreparedSelfhostVersionMaterialization {
  readonly materializationDigest: `sha256:${string}`;
  readonly meta: SelfhostVersionMaterializationMeta;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly assets?: ReadonlyMap<string, Uint8Array>;
}

export type SelfhostVersionMaterializationErrorCode = "invalid_spec" | "conflict" | "unavailable";

export class SelfhostVersionMaterializationError extends Error {
  constructor(
    readonly code: SelfhostVersionMaterializationErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "SelfhostVersionMaterializationError";
  }
}

export interface SelfhostVersionMaterializationFile {
  write(bytes: Uint8Array): Promise<void>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export interface SelfhostVersionMaterializationFileSystem {
  mkdir(path: string, options?: { readonly recursive?: boolean }): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  openExclusive(path: string): Promise<SelfhostVersionMaterializationFile>;
  rename(source: string, destination: string): Promise<void>;
  remove(path: string): Promise<boolean>;
  lstat(path: string): Promise<{
    isDirectory(): boolean;
    isFile(): boolean;
    isSymbolicLink(): boolean;
  }>;
  readdir(path: string): Promise<
    readonly {
      readonly name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }[]
  >;
  syncDirectory(path: string): Promise<void>;
}

/** Node filesystem implementation, exported for deterministic filesystem tests. */
export const nodeSelfhostVersionMaterializationFileSystem: SelfhostVersionMaterializationFileSystem =
  {
    async mkdir(path, options) {
      await mkdir(path, options);
    },

    async readFile(path) {
      return new Uint8Array(await readFile(path));
    },

    async openExclusive(path) {
      const handle = await open(
        path,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
        0o600,
      );
      return {
        async write(bytes) {
          await handle.writeFile(bytes);
        },
        async sync() {
          await handle.sync();
        },
        async close() {
          await handle.close();
        },
      };
    },

    async rename(source, destination) {
      await rename(source, destination);
    },

    async remove(path) {
      try {
        await rm(path, { recursive: true });
        return true;
      } catch (error) {
        if (errorCode(error) === "ENOENT") return false;
        throw error;
      }
    },

    async lstat(path) {
      return await lstat(path);
    },

    async readdir(path) {
      return await readdir(path, { withFileTypes: true });
    },

    async syncDirectory(path) {
      let handle: Awaited<ReturnType<typeof open>> | undefined;
      try {
        handle = await open(path, fsConstants.O_RDONLY);
        await handle.sync();
      } catch (error) {
        // Some filesystems (and Windows) do not support fsync on directories.
        // A successful file fsync plus atomic rename is still the strongest
        // portable guarantee available there.
        if (!directorySyncUnsupported(error)) throw error;
      } finally {
        await handle?.close().catch(() => undefined);
      }
    },
  };

export interface CreateSelfhostVersionMaterializerOptions {
  /** Parent of `<script>/<versionId>`. */
  readonly root: string;
  readonly artifacts: SelfhostVersionArtifacts;
  readonly fileSystem?: SelfhostVersionMaterializationFileSystem;
  readonly randomId?: () => string;
  /** Test-only crash seam; it runs after all staged bytes are durable. */
  readonly beforeRename?: (input: {
    readonly stagingPath: string;
    readonly finalPath: string;
    readonly materializationDigest: `sha256:${string}`;
  }) => Promise<void> | void;
}

export interface SelfhostVersionMaterializer {
  /** Resolve and validate every declaration and blob without writing local state. */
  prepare(
    input: SelfhostVersionMaterializationRequest,
  ): Promise<PreparedSelfhostVersionMaterialization>;
  /** Publish a prepared version using create-only atomic directory publication. */
  materialize(
    input: SelfhostVersionMaterializationRequest,
  ): Promise<PreparedSelfhostVersionMaterialization>;
  /** Inspect only the committed version directory; never cleans or writes. */
  inspect(input: {
    readonly script: string;
    readonly versionId: string;
  }): Promise<SelfhostVersionInspection>;
  /** Remove only marker-proven abandoned sibling staging directories. */
  cleanAbandonedStaging(input: {
    readonly script: string;
    readonly versionId: string;
  }): Promise<void>;
}

export function createSelfhostVersionMaterializer(
  options: CreateSelfhostVersionMaterializerOptions,
): SelfhostVersionMaterializer {
  const root = resolve(options.root);
  const fileSystem = options.fileSystem ?? nodeSelfhostVersionMaterializationFileSystem;
  const randomId = options.randomId ?? randomUUID;

  const pathsFor = (script: string, versionId: string) => {
    if (!SAFE_SEGMENT.test(script) || !SAFE_SEGMENT.test(versionId)) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "the Worker Version identity is invalid",
      );
    }
    const parent = join(root, script);
    const finalPath = join(parent, versionId);
    const inside = relative(root, finalPath);
    if (inside.startsWith("..") || inside === "") {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "the Worker Version path is invalid",
      );
    }
    return { parent, finalPath };
  };

  const markerPath = (stagingPath: string): string => `${stagingPath}${STAGING_MARKER_SUFFIX}`;

  const cleanAbandonedStaging = async (input: {
    readonly script: string;
    readonly versionId: string;
  }): Promise<void> => {
    const { parent, finalPath } = pathsFor(input.script, input.versionId);
    let entries: readonly {
      readonly name: string;
      isDirectory(): boolean;
      isFile(): boolean;
      isSymbolicLink(): boolean;
    }[];
    try {
      entries = await fileSystem.readdir(parent);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return;
      throw unavailable(error);
    }
    const prefix = `${input.versionId}.staging-`;
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix) || !entry.isDirectory() || entry.isSymbolicLink())
        continue;
      const stagingPath = join(parent, entry.name);
      const marker = markerPath(stagingPath);
      let markerBytes: Uint8Array;
      try {
        const markerStat = await fileSystem.lstat(marker);
        if (!markerStat.isFile() || markerStat.isSymbolicLink()) continue;
        markerBytes = await fileSystem.readFile(marker);
      } catch (error) {
        if (errorCode(error) === "ENOENT") continue;
        throw unavailable(error);
      }
      if (!validStagingMarker(markerBytes, stagingPath, finalPath)) continue;
      // Never pass the committed destination to the cleanup primitive. The
      // prefix and marker checks above are intentionally repeated here to make
      // the no-remove-final invariant local to this operation.
      if (stagingPath === finalPath) {
        throw unavailable(new Error("staging path aliases final path"));
      }
      await fileSystem.remove(stagingPath).catch((error) => {
        throw unavailable(error);
      });
      await fileSystem.remove(marker).catch((error) => {
        throw unavailable(error);
      });
    }
  };

  const inspect = async (input: {
    readonly script: string;
    readonly versionId: string;
  }): Promise<SelfhostVersionInspection> => {
    const { finalPath } = pathsFor(input.script, input.versionId);
    return await inspectPath(finalPath, fileSystem);
  };

  const prepare = async (
    input: SelfhostVersionMaterializationRequest,
  ): Promise<PreparedSelfhostVersionMaterialization> => {
    const { manifestDigest } = input;
    if (!DIGEST.test(manifestDigest)) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "the Worker Bundle digest is invalid",
      );
    }
    const manifest = await resolveManifest(options.artifacts, input.tenantRef, manifestDigest);
    const modules = await resolveEntries(manifest, "WorkerBundle");
    if (!manifest.mainModule || !safeArtifactPath(manifest.mainModule)) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "the Worker Bundle has no valid main module",
      );
    }
    if (!modules.some((entry) => entry.path === manifest.mainModule)) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "the Worker Bundle main module is not declared",
      );
    }
    if (manifest.apiVersion !== undefined) {
      const mainEntry = modules.find((entry) => entry.path === manifest.mainModule);
      if (
        !mainEntry?.mediaType ||
        mainEntry.mediaType === "application/source-map+json" ||
        !MODULE_MEDIA.has(mainEntry.mediaType)
      ) {
        throw new SelfhostVersionMaterializationError(
          "invalid_spec",
          "the Worker Bundle main module media type is not loadable",
        );
      }
    }
    if (isSha256Digest(manifestDigest)) {
      const actual = await canonicalDigest(manifest);
      if (actual !== manifestDigest) {
        throw new SelfhostVersionMaterializationError(
          "invalid_spec",
          "the Worker Bundle manifest digest mismatches its content",
        );
      }
    }
    const resolvedModules = await resolveBytes(options.artifacts, modules, MAX_BUNDLE_BYTES);
    const normalizedModules = resolvedModules.entries;
    const moduleBytes = resolvedModules.bytes;

    let assetsMeta: SelfhostVersionMaterializationMeta["assets"];
    let assetBytes: ReadonlyMap<string, Uint8Array> | undefined;
    if (input.assets) {
      if (
        !DIGEST.test(input.assets.manifestDigest) ||
        typeof input.assets.notFoundHandling !== "string" ||
        input.assets.notFoundHandling.length === 0 ||
        input.assets.notFoundHandling.length > 128
      ) {
        throw new SelfhostVersionMaterializationError(
          "invalid_spec",
          "the Static Asset Bundle digest is invalid",
        );
      }
      const assetManifest = await resolveManifest(
        options.artifacts,
        input.tenantRef,
        input.assets.manifestDigest,
      );
      if (isSha256Digest(input.assets.manifestDigest)) {
        const actual = await canonicalDigest(assetManifest);
        if (actual !== input.assets.manifestDigest) {
          throw new SelfhostVersionMaterializationError(
            "invalid_spec",
            "the Static Asset Bundle manifest digest mismatches its content",
          );
        }
      }
      const assets = await resolveEntries(assetManifest, "StaticAssetBundle");
      const resolvedAssets = await resolveBytes(options.artifacts, assets, MAX_BUNDLE_BYTES);
      const normalizedAssets = resolvedAssets.entries;
      assetBytes = resolvedAssets.bytes;
      assetsMeta = {
        manifestDigest: input.assets.manifestDigest,
        notFoundHandling: input.assets.notFoundHandling,
        files: normalizedAssets,
      };
    }

    const payload = materializationPayload({
      manifestDigest,
      mainModule: manifest.mainModule,
      modules: normalizedModules,
      ...(assetsMeta ? { assets: assetsMeta } : {}),
    });
    const materializationDigest = await canonicalDigest(payload);
    const meta: SelfhostVersionMaterializationMeta = {
      format: SELFHOST_VERSION_MATERIALIZATION_FORMAT,
      materializationDigest,
      manifestDigest,
      mainModule: manifest.mainModule,
      modules: normalizedModules,
      ...(assetsMeta ? { assets: assetsMeta } : {}),
    };
    return {
      materializationDigest,
      meta,
      modules: moduleBytes,
      ...(assetBytes ? { assets: assetBytes } : {}),
    };
  };

  const materialize = async (
    input: SelfhostVersionMaterializationRequest,
  ): Promise<PreparedSelfhostVersionMaterialization> => {
    const { parent, finalPath } = pathsFor(input.script, input.versionId);
    return await withMaterializationMutex(finalPath, async () => {
      // A stale staging directory is never allowed to become an input to the
      // new publication. Cleanup happens before artifact resolution so a
      // missing blob leaves the committed final entirely untouched.
      await cleanAbandonedStaging(input);
      const prepared = await prepare(input);
      const current = await inspectPath(finalPath, fileSystem);
      if (current.state === "present") {
        if (current.digest === prepared.materializationDigest) return prepared;
        throw new SelfhostVersionMaterializationError(
          "conflict",
          "the committed Worker Version has a different materialization digest",
        );
      }
      if (current.state === "corrupt") {
        throw new SelfhostVersionMaterializationError(
          "conflict",
          "the committed Worker Version materialization is corrupt",
        );
      }

      await fileSystem.mkdir(parent, { recursive: true }).catch((error) => {
        throw unavailable(error);
      });
      const stagingPath = await createUniqueStagingDirectory(
        fileSystem,
        parent,
        input.versionId,
        randomId,
      );
      const marker = markerPath(stagingPath);
      let renamed = false;
      try {
        await writeStagingDirectory(fileSystem, stagingPath, marker, finalPath, prepared);
        try {
          await options.beforeRename?.({
            stagingPath,
            finalPath,
            materializationDigest: prepared.materializationDigest,
          });
        } catch (error) {
          if (error instanceof SelfhostVersionMaterializationError) throw error;
          throw unavailable(error);
        }

        // Check immediately before rename. The per-final mutex serializes all
        // adapters in this process; an independent process must use the same
        // create-only publication contract and will otherwise fail its own
        // precondition rather than receiving an overwrite-capable update API.
        const beforeRename = await inspectPath(finalPath, fileSystem);
        if (beforeRename.state === "present") {
          if (beforeRename.digest === prepared.materializationDigest) return prepared;
          throw new SelfhostVersionMaterializationError(
            "conflict",
            "the committed Worker Version appeared with a different digest",
          );
        }
        if (beforeRename.state === "corrupt") {
          throw new SelfhostVersionMaterializationError(
            "conflict",
            "the committed Worker Version appeared corrupt",
          );
        }
        await fileSystem.syncDirectory(parent).catch((error) => {
          throw unavailable(error);
        });
        await fileSystem.rename(stagingPath, finalPath).catch((error) => {
          throw unavailable(error);
        });
        renamed = true;
        await fileSystem.syncDirectory(parent).catch((error) => {
          throw unavailable(error);
        });
        await fileSystem.remove(marker).catch((error) => {
          throw unavailable(error);
        });
        await fileSystem.syncDirectory(parent).catch((error) => {
          throw unavailable(error);
        });
        const committed = await inspectPath(finalPath, fileSystem);
        if (committed.state !== "present" || committed.digest !== prepared.materializationDigest) {
          throw new SelfhostVersionMaterializationError(
            "unavailable",
            "the Worker Version was not readable after publication",
          );
        }
        return prepared;
      } finally {
        // Once rename succeeds the path is committed and is never removed by
        // this module. Before that point only our unique sibling stage may be
        // cleaned.
        if (!renamed) await fileSystem.remove(stagingPath).catch(() => undefined);
        await fileSystem.remove(marker).catch(() => undefined);
      }
    });
  };

  return { prepare, materialize, inspect, cleanAbandonedStaging };
}

async function resolveManifest(
  artifacts: SelfhostVersionArtifacts,
  tenantRef: string,
  digest: string,
): Promise<SelfhostVersionArtifactManifest> {
  let manifest: SelfhostVersionArtifactManifest | null;
  try {
    manifest = await artifacts.manifest(tenantRef, digest);
  } catch (error) {
    throw unavailable(error);
  }
  if (!manifest) {
    throw new SelfhostVersionMaterializationError(
      "invalid_spec",
      "the artifact manifest is unavailable",
    );
  }
  if (
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    typeof manifest.kind !== "string" ||
    manifest.kind.length === 0 ||
    manifest.kind.length > 128
  ) {
    throw new SelfhostVersionMaterializationError(
      "invalid_spec",
      "the artifact manifest is malformed",
    );
  }
  return manifest;
}

async function resolveEntries(
  manifest: SelfhostVersionArtifactManifest,
  expectedKind: "WorkerBundle" | "StaticAssetBundle",
): Promise<readonly SelfhostVersionInventoryEntry[]> {
  if (
    manifest.apiVersion !== undefined &&
    manifest.apiVersion !== "artifacts.takoform.com/v1alpha1"
  ) {
    throw new SelfhostVersionMaterializationError(
      "invalid_spec",
      "the artifact manifest API version is invalid",
    );
  }
  if (manifest.kind !== expectedKind) {
    throw new SelfhostVersionMaterializationError(
      "invalid_spec",
      "the artifact manifest kind is invalid",
    );
  }
  if (manifest.apiVersion !== undefined) {
    const expectedKeys =
      expectedKind === "WorkerBundle"
        ? ["apiVersion", "kind", "mainModule", "modules"]
        : ["apiVersion", "kind", "files"];
    if (JSON.stringify(Object.keys(manifest).sort()) !== JSON.stringify(expectedKeys.sort())) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "the artifact manifest has unexpected fields",
      );
    }
  }
  const declarations = expectedKind === "WorkerBundle" ? manifest.modules : manifest.files;
  const strict = manifest.apiVersion !== undefined;
  const maxEntries = expectedKind === "WorkerBundle" ? MAX_WORKER_ENTRIES : MAX_ASSET_ENTRIES;
  if (
    !Array.isArray(declarations) ||
    declarations.length === 0 ||
    declarations.length > maxEntries
  ) {
    throw new SelfhostVersionMaterializationError(
      "invalid_spec",
      "the artifact manifest inventory is invalid",
    );
  }
  const names = new Set<string>();
  const entries: SelfhostVersionInventoryEntry[] = [];
  let total = 0;
  for (const declaration of declarations) {
    if (typeof declaration !== "object" || declaration === null || Array.isArray(declaration)) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "an artifact declaration is malformed",
      );
    }
    if (strict) {
      const expectedKeys =
        expectedKind === "WorkerBundle"
          ? ["digest", "mediaType", "name", "size"]
          : ["digest", "mediaType", "path", "size"];
      if (JSON.stringify(Object.keys(declaration).sort()) !== JSON.stringify(expectedKeys.sort())) {
        throw new SelfhostVersionMaterializationError(
          "invalid_spec",
          "an artifact declaration has unexpected fields",
        );
      }
    }
    const rawName = expectedKind === "WorkerBundle" ? declaration.name : declaration.path;
    if (typeof rawName !== "string" || !safeArtifactPath(rawName) || names.has(rawName)) {
      throw new SelfhostVersionMaterializationError("invalid_spec", "an artifact path is invalid");
    }
    if (typeof declaration.digest !== "string" || !DIGEST.test(declaration.digest)) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "an artifact digest is invalid",
      );
    }
    if (
      strict &&
      (!isSha256Digest(declaration.digest) ||
        typeof declaration.mediaType !== "string" ||
        !validMediaType(declaration.mediaType, expectedKind) ||
        !Number.isSafeInteger(declaration.size))
    ) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "an artifact declaration is not canonical",
      );
    }
    if (
      declaration.mediaType !== undefined &&
      (typeof declaration.mediaType !== "string" ||
        declaration.mediaType.length === 0 ||
        declaration.mediaType.length > MAX_MEDIA_TYPE_LENGTH ||
        !validMediaType(declaration.mediaType, expectedKind))
    ) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "an artifact media type is invalid",
      );
    }
    if (
      declaration.size !== undefined &&
      (!Number.isSafeInteger(declaration.size) ||
        declaration.size < 0 ||
        declaration.size > MAX_DECLARED_BYTES)
    ) {
      throw new SelfhostVersionMaterializationError("invalid_spec", "an artifact size is invalid");
    }
    const size = declaration.size ?? -1;
    if (size >= 0) {
      total += size;
      if (!Number.isSafeInteger(total) || total > MAX_BUNDLE_BYTES) {
        throw new SelfhostVersionMaterializationError(
          "invalid_spec",
          "the artifact inventory is too large",
        );
      }
    }
    names.add(rawName);
    entries.push({
      path: rawName,
      digest: declaration.digest,
      size,
      ...(declaration.mediaType !== undefined ? { mediaType: declaration.mediaType } : {}),
    });
  }
  return entries;
}

async function resolveBytes(
  artifacts: SelfhostVersionArtifacts,
  entries: readonly SelfhostVersionInventoryEntry[],
  maxTotalBytes: number,
): Promise<{
  readonly entries: readonly SelfhostVersionInventoryEntry[];
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}> {
  const cache = new Map<string, Uint8Array>();
  const normalized: SelfhostVersionInventoryEntry[] = [];
  let total = 0;
  for (const entry of entries) {
    let bytes = cache.get(entry.digest);
    if (!bytes) {
      let loaded: Uint8Array | null;
      try {
        loaded = await artifacts.blob(entry.digest);
      } catch (error) {
        throw unavailable(error);
      }
      if (!loaded) {
        throw new SelfhostVersionMaterializationError(
          "invalid_spec",
          `the declared artifact blob is missing: ${entry.path}`,
        );
      }
      bytes = new Uint8Array(loaded);
      cache.set(entry.digest, bytes);
    }
    if (entry.size >= 0 && bytes.byteLength !== entry.size) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        `the declared artifact blob size mismatches: ${entry.path}`,
      );
    }
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > maxTotalBytes) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        "the artifact inventory is too large",
      );
    }
    if (isSha256Digest(entry.digest) && (await bytesDigest(bytes)) !== entry.digest) {
      throw new SelfhostVersionMaterializationError(
        "invalid_spec",
        `the declared artifact blob digest mismatches: ${entry.path}`,
      );
    }
    normalized.push(entry.size >= 0 ? entry : { ...entry, size: bytes.byteLength });
  }
  return {
    entries: normalized,
    bytes: new Map(entries.map((entry) => [entry.path, cache.get(entry.digest) as Uint8Array])),
  };
}

function materializationPayload(input: {
  readonly manifestDigest: string;
  readonly mainModule: string;
  readonly modules: readonly SelfhostVersionInventoryEntry[];
  readonly assets?: SelfhostVersionMaterializationMeta["assets"];
}): Record<string, unknown> {
  return {
    format: SELFHOST_VERSION_MATERIALIZATION_FORMAT,
    manifestDigest: input.manifestDigest,
    mainModule: input.mainModule,
    modules: input.modules,
    ...(input.assets ? { assets: input.assets } : {}),
  };
}

async function inspectPath(
  finalPath: string,
  fileSystem: SelfhostVersionMaterializationFileSystem,
): Promise<SelfhostVersionInspection> {
  let stat: Awaited<ReturnType<SelfhostVersionMaterializationFileSystem["lstat"]>>;
  try {
    stat = await fileSystem.lstat(finalPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "absent" };
    if (errorCode(error) === "ENOTDIR") return { state: "corrupt" };
    throw unavailable(error);
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return { state: "corrupt" };
  const metaPath = join(finalPath, META_FILE);
  let metaBytes: Uint8Array;
  try {
    const metaStat = await fileSystem.lstat(metaPath);
    if (!metaStat.isFile() || metaStat.isSymbolicLink()) return { state: "corrupt" };
    metaBytes = await fileSystem.readFile(metaPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return { state: "corrupt" };
    throw unavailable(error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(metaBytes),
    );
  } catch {
    return { state: "corrupt" };
  }
  const meta = parseMeta(parsed);
  if (!meta) return { state: "corrupt" };
  const expectedDigest = await canonicalDigest(
    materializationPayload({
      manifestDigest: meta.manifestDigest,
      mainModule: meta.mainModule,
      modules: meta.modules,
      ...(meta.assets ? { assets: meta.assets } : {}),
    }),
  );
  if (expectedDigest !== meta.materializationDigest) return { state: "corrupt" };
  if (!(await verifyTree(join(finalPath, MODULES_DIRECTORY), meta.modules, fileSystem))) {
    return { state: "corrupt" };
  }
  const topLevel = await fileSystem.readdir(finalPath).catch((error) => {
    throw unavailable(error);
  });
  const allowed = new Set([META_FILE, MODULES_DIRECTORY]);
  if (meta.assets) allowed.add(ASSETS_DIRECTORY);
  if (
    topLevel.some(
      (entry) =>
        !allowed.has(entry.name) ||
        entry.isSymbolicLink() ||
        (entry.name === META_FILE && !entry.isFile()) ||
        (entry.name !== META_FILE && !entry.isDirectory()),
    )
  ) {
    return { state: "corrupt" };
  }
  if (
    meta.assets &&
    !(await verifyTree(join(finalPath, ASSETS_DIRECTORY), meta.assets.files, fileSystem))
  ) {
    return { state: "corrupt" };
  }
  return { state: "present", digest: meta.materializationDigest, meta };
}

function parseMeta(value: unknown): SelfhostVersionMaterializationMeta | null {
  if (!isRecord(value)) return null;
  if (
    value.format !== SELFHOST_VERSION_MATERIALIZATION_FORMAT ||
    typeof value.materializationDigest !== "string" ||
    !isSha256Digest(value.materializationDigest) ||
    typeof value.manifestDigest !== "string" ||
    !DIGEST.test(value.manifestDigest) ||
    typeof value.mainModule !== "string" ||
    !safeArtifactPath(value.mainModule)
  ) {
    return null;
  }
  const modules = parseInventory(value.modules, MAX_WORKER_ENTRIES, "WorkerBundle");
  if (!modules?.some((entry) => entry.path === value.mainModule)) return null;
  let assets: SelfhostVersionMaterializationMeta["assets"];
  if (value.assets !== undefined) {
    if (!isRecord(value.assets)) return null;
    if (
      JSON.stringify(Object.keys(value.assets).sort()) !==
      JSON.stringify(["files", "manifestDigest", "notFoundHandling"])
    ) {
      return null;
    }
    if (
      typeof value.assets.manifestDigest !== "string" ||
      !DIGEST.test(value.assets.manifestDigest) ||
      typeof value.assets.notFoundHandling !== "string" ||
      value.assets.notFoundHandling.length === 0 ||
      value.assets.notFoundHandling.length > 128
    ) {
      return null;
    }
    const files = parseInventory(value.assets.files, MAX_ASSET_ENTRIES, "StaticAssetBundle");
    if (!files) return null;
    assets = {
      manifestDigest: value.assets.manifestDigest,
      notFoundHandling: value.assets.notFoundHandling,
      files,
    };
  }
  const expectedKeys = new Set([
    "format",
    "materializationDigest",
    "manifestDigest",
    "mainModule",
    "modules",
  ]);
  if (assets) expectedKeys.add("assets");
  if (Object.keys(value).some((key) => !expectedKeys.has(key))) return null;
  return {
    format: SELFHOST_VERSION_MATERIALIZATION_FORMAT,
    materializationDigest: value.materializationDigest,
    manifestDigest: value.manifestDigest,
    mainModule: value.mainModule,
    modules,
    ...(assets ? { assets } : {}),
  };
}

function parseInventory(
  value: unknown,
  maxEntries: number,
  expectedKind: "WorkerBundle" | "StaticAssetBundle",
): readonly SelfhostVersionInventoryEntry[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxEntries) return null;
  const names = new Set<string>();
  const entries: SelfhostVersionInventoryEntry[] = [];
  let total = 0;
  for (const candidate of value) {
    if (!isRecord(candidate)) return null;
    const expectedKeys = ["digest", "path", "size"];
    if (candidate.mediaType !== undefined) expectedKeys.push("mediaType");
    if (JSON.stringify(Object.keys(candidate).sort()) !== JSON.stringify(expectedKeys.sort())) {
      return null;
    }
    const candidateSize = candidate.size;
    if (
      typeof candidate.path !== "string" ||
      !safeArtifactPath(candidate.path) ||
      names.has(candidate.path) ||
      typeof candidate.digest !== "string" ||
      !DIGEST.test(candidate.digest) ||
      !Number.isSafeInteger(candidateSize) ||
      (candidateSize as number) < 0 ||
      (candidateSize as number) > MAX_DECLARED_BYTES ||
      (candidate.mediaType !== undefined &&
        (typeof candidate.mediaType !== "string" ||
          candidate.mediaType.length === 0 ||
          candidate.mediaType.length > MAX_MEDIA_TYPE_LENGTH ||
          !validMediaType(candidate.mediaType, expectedKind)))
    ) {
      return null;
    }
    total += candidateSize as number;
    if (!Number.isSafeInteger(total) || total > MAX_BUNDLE_BYTES) return null;
    names.add(candidate.path);
    entries.push({
      path: candidate.path,
      digest: candidate.digest,
      size: candidateSize as number,
      ...(candidate.mediaType !== undefined ? { mediaType: candidate.mediaType } : {}),
    });
  }
  return entries;
}

async function verifyTree(
  root: string,
  expected: readonly SelfhostVersionInventoryEntry[],
  fileSystem: SelfhostVersionMaterializationFileSystem,
): Promise<boolean> {
  let rootStat: Awaited<ReturnType<SelfhostVersionMaterializationFileSystem["lstat"]>>;
  try {
    rootStat = await fileSystem.lstat(root);
  } catch (error) {
    if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") return false;
    throw unavailable(error);
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) return false;
  const actual = new Set<string>();
  const expectedDirectories = new Set<string>();
  for (const entry of expected) {
    let directory = entry.path.includes("/")
      ? entry.path.slice(0, entry.path.lastIndexOf("/"))
      : "";
    while (directory) {
      expectedDirectories.add(directory);
      directory = directory.includes("/") ? directory.slice(0, directory.lastIndexOf("/")) : "";
    }
  }
  const visit = async (directory: string, prefix: string): Promise<boolean> => {
    const entries = await fileSystem.readdir(directory).catch((error) => {
      throw unavailable(error);
    });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) return false;
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (!safeArtifactPath(name)) return false;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        // Empty or otherwise unlisted directories are not part of a complete
        // file inventory. Rejecting them prevents a tampered final from being
        // mistaken for the exact committed tree merely because its files all
        // happen to be present.
        if (!expectedDirectories.has(name)) return false;
        if (!(await visit(path, name))) return false;
      } else if (entry.isFile()) {
        actual.add(name);
      } else {
        return false;
      }
    }
    return true;
  };
  if (!(await visit(root, ""))) return false;
  if (actual.size !== expected.length || expected.some((entry) => !actual.has(entry.path)))
    return false;
  for (const entry of expected) {
    const path = join(root, entry.path);
    let stat: Awaited<ReturnType<SelfhostVersionMaterializationFileSystem["lstat"]>>;
    try {
      stat = await fileSystem.lstat(path);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw unavailable(error);
    }
    if (!stat.isFile() || stat.isSymbolicLink()) return false;
    const bytes = await fileSystem.readFile(path).catch((error) => {
      throw unavailable(error);
    });
    if (bytes.byteLength !== entry.size) return false;
    if (isSha256Digest(entry.digest) && (await bytesDigest(bytes)) !== entry.digest) return false;
  }
  return true;
}

async function writeStagingDirectory(
  fileSystem: SelfhostVersionMaterializationFileSystem,
  stagingPath: string,
  marker: string,
  finalPath: string,
  prepared: PreparedSelfhostVersionMaterialization,
): Promise<void> {
  await writeExclusive(
    fileSystem,
    marker,
    new TextEncoder().encode(
      canonicalJson({
        format: SELFHOST_VERSION_STAGING_FORMAT,
        stagingPath,
        finalPath,
      }),
    ),
  );
  // The marker is the proof that a sibling directory is ours to clean after a
  // crash. Persist it in the parent before any staged bytes are written.
  await fileSystem.syncDirectory(dirname(stagingPath)).catch((error) => {
    throw unavailable(error);
  });
  const directories = new Set<string>([stagingPath]);
  for (const [path, bytes] of prepared.modules) {
    await writeTreeFile(fileSystem, join(stagingPath, MODULES_DIRECTORY), path, bytes, directories);
  }
  if (prepared.assets) {
    for (const [path, bytes] of prepared.assets) {
      await writeTreeFile(
        fileSystem,
        join(stagingPath, ASSETS_DIRECTORY),
        path,
        bytes,
        directories,
      );
    }
  }
  await writeExclusive(
    fileSystem,
    join(stagingPath, META_FILE),
    new TextEncoder().encode(canonicalJson(prepared.meta)),
  );
  const orderedDirectories = [...directories].sort((left, right) => right.length - left.length);
  for (const directory of orderedDirectories) {
    await fileSystem.syncDirectory(directory).catch((error) => {
      throw unavailable(error);
    });
  }
}

async function writeTreeFile(
  fileSystem: SelfhostVersionMaterializationFileSystem,
  root: string,
  name: string,
  bytes: Uint8Array,
  directories: Set<string>,
): Promise<void> {
  if (!safeArtifactPath(name)) {
    throw new SelfhostVersionMaterializationError(
      "invalid_spec",
      "an artifact path escapes its staging directory",
    );
  }
  const path = join(root, name);
  const parent = dirname(path);
  await fileSystem.mkdir(parent, { recursive: true }).catch((error) => {
    throw unavailable(error);
  });
  directories.add(root);
  let current = parent;
  while (current !== root && current.startsWith(`${root}/`)) {
    directories.add(current);
    current = dirname(current);
  }
  await writeExclusive(fileSystem, path, bytes);
}

async function writeExclusive(
  fileSystem: SelfhostVersionMaterializationFileSystem,
  path: string,
  bytes: Uint8Array,
): Promise<void> {
  let file: SelfhostVersionMaterializationFile | undefined;
  let closed = false;
  try {
    file = await fileSystem.openExclusive(path);
    await file.write(bytes);
    await file.sync();
    await file.close();
    closed = true;
  } catch (error) {
    if (!closed) await file?.close().catch(() => undefined);
    throw unavailable(error);
  }
}

async function createUniqueStagingDirectory(
  fileSystem: SelfhostVersionMaterializationFileSystem,
  parent: string,
  versionId: string,
  randomId: () => string,
): Promise<string> {
  await fileSystem.mkdir(parent, { recursive: true }).catch((error) => {
    throw unavailable(error);
  });
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix =
      randomId()
        .replace(/[^A-Za-z0-9_-]/gu, "")
        .slice(0, 64) || randomUUID();
    const candidate = join(parent, `${versionId}.staging-${suffix}`);
    try {
      await fileSystem.mkdir(candidate);
      return candidate;
    } catch (error) {
      if (errorCode(error) === "EEXIST") continue;
      throw unavailable(error);
    }
  }
  throw new SelfhostVersionMaterializationError(
    "conflict",
    "could not allocate a unique staging directory",
  );
}

function validStagingMarker(bytes: Uint8Array, stagingPath: string, finalPath: string): boolean {
  try {
    const value: unknown = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
    return (
      isRecord(value) &&
      value.format === SELFHOST_VERSION_STAGING_FORMAT &&
      value.stagingPath === stagingPath &&
      value.finalPath === finalPath &&
      Object.keys(value).length === 3
    );
  } catch {
    return false;
  }
}

function safeArtifactPath(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_PATH_LENGTH) return false;
  if (!SAFE_PATH.test(value)) return false;
  return value.split("/").every((segment) => segment !== "." && segment !== "..");
}

function validMediaType(
  value: string,
  expectedKind: "WorkerBundle" | "StaticAssetBundle",
): boolean {
  if (!MEDIA_TYPE.test(value)) return false;
  return expectedKind === "StaticAssetBundle" || MODULE_MEDIA.has(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unavailable(error: unknown): SelfhostVersionMaterializationError {
  return new SelfhostVersionMaterializationError(
    "unavailable",
    error instanceof Error ? error.message : "the local Worker Version filesystem is unavailable",
  );
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}

function directorySyncUnsupported(error: unknown): boolean {
  const code = errorCode(error);
  return code === "EINVAL" || code === "ENOTSUP" || code === "EBADF" || code === "EPERM";
}

async function withMaterializationMutex<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = MATERIALIZATION_MUTEXES.get(key);
  let release!: () => void;
  const current = new Promise<void>((resolvePromise) => {
    release = resolvePromise;
  });
  MATERIALIZATION_MUTEXES.set(key, current);
  if (previous) await previous;
  try {
    return await operation();
  } finally {
    release();
    if (MATERIALIZATION_MUTEXES.get(key) === current) MATERIALIZATION_MUTEXES.delete(key);
  }
}
