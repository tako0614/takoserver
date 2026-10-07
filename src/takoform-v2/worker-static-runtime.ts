import { bytesDigest, canonicalJson } from "../json.ts";
import type { WorkerdDeploymentVariant, WorkerdStaticSite } from "../workerd-runtime.ts";
import type { SqlArtifactCustodyRead } from "./forms/artifact-custody.ts";
import {
  parseStaticAssetBundleManifest,
  STATIC_ASSET_BUNDLE_LIMITS,
  type StaticAssetBundleManifest,
} from "./forms/static-asset-bundle.ts";
import { parseWorkerVersionSpec } from "./forms/worker-specs.ts";
import type { V2WorkerVersionMaterials } from "./worker-publication-state.ts";

export class V2WorkerStaticRuntimeError extends Error {
  constructor(readonly code: "worker_version_unavailable" | "asset_bundle_unavailable") {
    super(code);
    this.name = "V2WorkerStaticRuntimeError";
  }
}

/**
 * Pure projection input from the caller's already-selected publication graph.
 * Identity values are preserved; they are not authorization evidence.
 */
export type V2StaticWorkerVersionIdentity = Omit<
  Pick<WorkerdStaticSite, "directory" | "hostnames" | "generation" | "workerResourceUid">,
  "generation"
> & {
  readonly generation: string;
  readonly versionId: string;
  readonly workerVersionUid: string;
  readonly weight: number;
};

export type V2StaticWorkerDeploymentVariant = WorkerdDeploymentVariant<WorkerdStaticSite> & {
  readonly assets: ReadonlyMap<string, Uint8Array>;
};

/**
 * Project a static-only WorkerVersion plus bytes returned by the publication
 * authority's `readVersionMaterials`. This function validates and copies its
 * input but does not authorize the read or perform source/network/SQL access.
 */
export async function projectV2StaticWorkerVersion(input: {
  readonly identity: V2StaticWorkerVersionIdentity;
  readonly spec: unknown;
  readonly materials: V2WorkerVersionMaterials | null;
}): Promise<V2StaticWorkerDeploymentVariant> {
  const unavailable = () => new V2WorkerStaticRuntimeError("worker_version_unavailable");
  let spec: ReturnType<typeof parseWorkerVersionSpec>;
  try {
    spec = parseWorkerVersionSpec(input.spec);
  } catch {
    throw unavailable();
  }

  if (
    spec.bundle ||
    spec.handlers.length !== 0 ||
    Object.keys(spec.vars).length !== 0 ||
    spec.requiredSensitiveVars.length !== 0 ||
    spec.kvBindings.length !== 0 ||
    spec.sqliteBindings.length !== 0 ||
    spec.bucketBindings.length !== 0 ||
    spec.queueProducerBindings.length !== 0 ||
    spec.serviceBindings.length !== 0 ||
    spec.actorBindings.length !== 0 ||
    spec.workflowBindings.length !== 0 ||
    !spec.assets ||
    spec.assets.runWorkerFirst ||
    spec.worker.resourceUid !== input.identity.workerResourceUid
  ) {
    throw unavailable();
  }

  if (!input.materials || input.materials.bundle !== null || !input.materials.assets) {
    throw new V2WorkerStaticRuntimeError("asset_bundle_unavailable");
  }
  const assets = await verifyV2AssetMaterials(input.materials.assets);
  if (
    spec.assets.notFoundHandling === "single_page_application" &&
    !assets.bytes.has("index.html")
  ) {
    throw new V2WorkerStaticRuntimeError("asset_bundle_unavailable");
  }

  const site: WorkerdStaticSite = {
    kind: "static",
    directory: input.identity.directory,
    hostnames: [...input.identity.hostnames],
    generation: input.identity.generation,
    workerResourceUid: input.identity.workerResourceUid,
    fetchHandler: false,
    assets: {
      notFoundHandling:
        spec.assets.notFoundHandling === "single_page_application"
          ? "single-page-application"
          : "none",
      runWorkerFirst: false,
      mediaTypes: assets.mediaTypes,
    },
  };
  return {
    versionId: input.identity.versionId,
    workerVersionUid: input.identity.workerVersionUid,
    weight: input.identity.weight,
    site,
    modules: new Map(),
    assets: assets.bytes,
  };
}

/** Verify and copy the exact held StaticAssetBundle for either static or code Versions. */
export async function verifyV2AssetMaterials(
  held: SqlArtifactCustodyRead<StaticAssetBundleManifest>,
): Promise<{
  readonly bytes: ReadonlyMap<string, Uint8Array>;
  readonly mediaTypes: Readonly<Record<string, string>>;
}> {
  const unavailable = () => new V2WorkerStaticRuntimeError("asset_bundle_unavailable");
  let manifestBytes: Uint8Array;
  let fileSnapshots: (Uint8Array | null)[];
  let heldManifestJson: string;
  let heldObservedJson: string;
  try {
    if (!(held.manifestBytes instanceof Uint8Array) || !Array.isArray(held.files)) {
      throw unavailable();
    }
    // Snapshot every mutable input before the first digest await. Hashing and
    // projection below must observe the same bytes and metadata.
    manifestBytes = new Uint8Array(held.manifestBytes);
    fileSnapshots = held.files.map((file) =>
      file instanceof Uint8Array ? new Uint8Array(file) : null,
    );
    heldManifestJson = canonicalJson(held.manifest);
    heldObservedJson = canonicalJson(held.observed);
  } catch {
    throw unavailable();
  }

  let manifest: StaticAssetBundleManifest;
  try {
    manifest = parseStaticAssetBundleManifest(manifestBytes);
  } catch {
    throw unavailable();
  }
  if (
    heldManifestJson !== canonicalJson(manifest) ||
    fileSnapshots.length !== manifest.files.length
  ) {
    throw unavailable();
  }

  const manifestSha256 = (await bytesDigest(manifestBytes)).slice("sha256:".length);
  const files: { path: string; sha256: string; mediaType: string; byteSize: number }[] = [];
  const byteCopies = new Map<string, Uint8Array>();
  const mediaTypes: Record<string, string> = Object.create(null);
  let totalBytes = 0;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index];
    const bytes = fileSnapshots[index];
    if (
      !file ||
      !bytes ||
      bytes.byteLength > STATIC_ASSET_BUNDLE_LIMITS.fileBytes ||
      totalBytes + bytes.byteLength > STATIC_ASSET_BUNDLE_LIMITS.aggregateBytes
    ) {
      throw unavailable();
    }
    totalBytes += bytes.byteLength;
    const sha256 = (await bytesDigest(bytes)).slice("sha256:".length);
    if (sha256 !== file.sha256) throw unavailable();
    files.push({ path: file.path, sha256, mediaType: file.mediaType, byteSize: bytes.byteLength });
    byteCopies.set(file.path, new Uint8Array(bytes));
    mediaTypes[file.path] = file.mediaType;
  }

  const expectedObservation = {
    manifestSha256,
    fileCount: files.length,
    totalBytes,
    files,
  };
  if (heldObservedJson !== canonicalJson(expectedObservation)) throw unavailable();
  return { bytes: byteCopies, mediaTypes };
}
