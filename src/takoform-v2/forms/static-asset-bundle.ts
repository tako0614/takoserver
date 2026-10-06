import { bytesDigest } from "../../json.ts";
import { parseStrictJson, StrictJsonError } from "../../strict-json.ts";
import {
  ARTIFACT_PATH_MAX_BYTES,
  ARTIFACT_URL_MAX_ASCII_BYTES,
  bareSha256Digest,
  isArtifactUrl,
  isValidArtifactPath,
} from "./artifact-validation.ts";

export const STATIC_ASSET_BUNDLE_FORM_URL =
  "https://edge.forms.takoform.com/forms/StaticAssetBundle/0.2.0/" as const;

export const STATIC_ASSET_BUNDLE_LIMITS = {
  manifestBytes: 1_048_576,
  fileCount: 512,
  pathBytes: ARTIFACT_PATH_MAX_BYTES,
  urlAsciiBytes: ARTIFACT_URL_MAX_ASCII_BYTES,
  fileBytes: 16_777_216,
  aggregateBytes: 134_217_728,
} as const;

export type StaticAssetBundleErrorCode = "invalid_spec" | "invalid_manifest" | "invalid_artifact";

/** Stable, payload-free validation failure suitable for public API mapping. */
export class StaticAssetBundleValidationError extends Error {
  constructor(readonly code: StaticAssetBundleErrorCode) {
    super(code);
    this.name = "StaticAssetBundleValidationError";
  }
}

export interface StaticAssetBundleSpec {
  readonly artifact: { readonly url: string; readonly sha256: string };
}

export interface StaticAssetBundleManifestFile {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly mediaType: string;
}

export interface StaticAssetBundleManifest {
  readonly files: readonly StaticAssetBundleManifestFile[];
}

export interface StaticAssetBundleObservedFile {
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: string;
  readonly byteSize: number;
}

export interface StaticAssetBundleObservation {
  readonly observed: {
    readonly manifestSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly files: readonly StaticAssetBundleObservedFile[];
  };
  readonly output: Record<string, never>;
}

const SHA256 = /^[0-9a-f]{64}$/u;
// RFC 9110 token, followed by a slash and another token; parameters are forbidden.
const MEDIA_TYPE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;

/** Parse the exact public input shape; this performs no network access. */
export function parseStaticAssetBundleSpec(input: unknown): StaticAssetBundleSpec {
  const spec = record(input, "invalid_spec");
  exactKeys(spec, ["artifact"], "invalid_spec");
  const artifact = record(spec.artifact, "invalid_spec");
  exactKeys(artifact, ["url", "sha256"], "invalid_spec");
  if (
    !isArtifactUrl(artifact.url) ||
    typeof artifact.sha256 !== "string" ||
    !SHA256.test(artifact.sha256)
  ) {
    throw invalid("invalid_spec");
  }
  return { artifact: { url: artifact.url, sha256: artifact.sha256 } };
}

/** Updates may repeat the exact artifact identity but may not replace it. */
export function validateStaticAssetBundleUpdate(
  previousInput: unknown,
  nextInput: unknown,
): StaticAssetBundleSpec {
  const previous = parseStaticAssetBundleSpec(previousInput);
  const next = parseStaticAssetBundleSpec(nextInput);
  if (
    previous.artifact.url !== next.artifact.url ||
    previous.artifact.sha256 !== next.artifact.sha256
  ) {
    throw invalid("invalid_spec");
  }
  return next;
}

/** Decode and validate the bounded UTF-8 manifest without fetching its files. */
export function parseStaticAssetBundleManifest(bytes: Uint8Array): StaticAssetBundleManifest {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > STATIC_ASSET_BUNDLE_LIMITS.manifestBytes
  ) {
    throw invalid("invalid_manifest");
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes, STATIC_ASSET_BUNDLE_LIMITS.manifestBytes);
  } catch (error) {
    if (error instanceof StrictJsonError) throw invalid("invalid_manifest");
    throw error;
  }

  const manifest = record(parsed, "invalid_manifest");
  exactKeys(manifest, ["files"], "invalid_manifest");
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.length > STATIC_ASSET_BUNDLE_LIMITS.fileCount
  ) {
    throw invalid("invalid_manifest");
  }

  const paths = new Set<string>();
  const files: StaticAssetBundleManifestFile[] = manifest.files.map((value) => {
    const file = record(value, "invalid_manifest");
    exactKeys(file, ["path", "url", "sha256", "mediaType"], "invalid_manifest");
    if (
      typeof file.path !== "string" ||
      !isValidArtifactPath(file.path) ||
      !isArtifactUrl(file.url) ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256) ||
      typeof file.mediaType !== "string" ||
      !MEDIA_TYPE.test(file.mediaType) ||
      paths.has(file.path)
    ) {
      throw invalid("invalid_manifest");
    }
    paths.add(file.path);
    return {
      path: file.path,
      url: file.url,
      sha256: file.sha256,
      mediaType: file.mediaType,
    };
  });
  return { files };
}

/** Validate exact artifact bytes and produce the published ordered projection. */
export async function validateStaticAssetBundlePayload(input: {
  readonly spec: unknown;
  readonly manifestBytes: Uint8Array;
  readonly fileBytes: readonly Uint8Array[];
}): Promise<StaticAssetBundleObservation> {
  const spec = parseStaticAssetBundleSpec(input.spec);
  const manifest = parseStaticAssetBundleManifest(input.manifestBytes);
  const manifestSha256 = bareSha256Digest(await bytesDigest(input.manifestBytes));
  if (
    manifestSha256 !== spec.artifact.sha256 ||
    !Array.isArray(input.fileBytes) ||
    input.fileBytes.length !== manifest.files.length
  ) {
    throw invalid("invalid_artifact");
  }

  let totalBytes = 0;
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index];
    const bytes = input.fileBytes[index];
    if (
      !file ||
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > STATIC_ASSET_BUNDLE_LIMITS.fileBytes ||
      totalBytes + bytes.byteLength > STATIC_ASSET_BUNDLE_LIMITS.aggregateBytes
    ) {
      throw invalid("invalid_artifact");
    }
    totalBytes += bytes.byteLength;
    const digest = bareSha256Digest(await bytesDigest(bytes));
    if (digest !== file.sha256) throw invalid("invalid_artifact");
  }

  return await projectStaticAssetBundleVerified({
    spec: input.spec,
    manifestBytes: input.manifestBytes,
    fileSizes: input.fileBytes.map((bytes) => bytes.byteLength),
  });
}

/** Projection from a complete set of individually verified immutable files. */
export async function projectStaticAssetBundleVerified(input: {
  readonly spec: unknown;
  readonly manifestBytes: Uint8Array;
  readonly fileSizes: readonly number[];
}): Promise<StaticAssetBundleObservation> {
  const spec = parseStaticAssetBundleSpec(input.spec);
  const manifest = parseStaticAssetBundleManifest(input.manifestBytes);
  const manifestSha256 = bareSha256Digest(await bytesDigest(input.manifestBytes));
  if (manifestSha256 !== spec.artifact.sha256 || input.fileSizes.length !== manifest.files.length) {
    throw invalid("invalid_artifact");
  }
  let totalBytes = 0;
  const observedFiles: StaticAssetBundleObservedFile[] = manifest.files.map((file, index) => {
    const size = input.fileSizes[index];
    if (
      !Number.isSafeInteger(size) ||
      size === undefined ||
      size < 0 ||
      size > STATIC_ASSET_BUNDLE_LIMITS.fileBytes ||
      totalBytes + size > STATIC_ASSET_BUNDLE_LIMITS.aggregateBytes
    ) {
      throw invalid("invalid_artifact");
    }
    totalBytes += size;
    return { path: file.path, sha256: file.sha256, mediaType: file.mediaType, byteSize: size };
  });

  return {
    observed: {
      manifestSha256,
      fileCount: observedFiles.length,
      totalBytes,
      files: observedFiles,
    },
    output: {},
  };
}

function record(value: unknown, code: StaticAssetBundleErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(code);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: StaticAssetBundleErrorCode,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw invalid(code);
  }
}

function invalid(code: StaticAssetBundleErrorCode): StaticAssetBundleValidationError {
  return new StaticAssetBundleValidationError(code);
}
