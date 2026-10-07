import { bytesDigest, canonicalJson } from "../json.ts";
import type { SqlArtifactCustodyRead } from "./forms/artifact-custody.ts";
import {
  parseStaticAssetBundleManifest,
  STATIC_ASSET_BUNDLE_LIMITS,
  type StaticAssetBundleManifest,
} from "./forms/static-asset-bundle.ts";

export class V2WorkerStaticRuntimeError extends Error {
  constructor(readonly code: "worker_version_unavailable" | "asset_bundle_unavailable") {
    super(code);
    this.name = "V2WorkerStaticRuntimeError";
  }
}

/** Verified, detached asset bytes and their exact media-type mapping. */
export interface V2VerifiedAssetMaterials {
  readonly bytes: ReadonlyMap<string, Uint8Array>;
  readonly mediaTypes: Readonly<Record<string, string>>;
}

/** Verify and copy the exact held StaticAssetBundle for static or code Versions. */
export async function verifyV2AssetMaterials(
  held: SqlArtifactCustodyRead<StaticAssetBundleManifest>,
): Promise<V2VerifiedAssetMaterials> {
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
