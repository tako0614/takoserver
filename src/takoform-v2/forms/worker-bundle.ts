import { bytesDigest } from "../../json.ts";
import { parseStrictJson, StrictJsonError } from "../../strict-json.ts";
import {
  ARTIFACT_PATH_MAX_BYTES,
  ARTIFACT_URL_MAX_ASCII_BYTES,
  bareSha256Digest,
  isArtifactUrl,
  isValidArtifactPath,
} from "./artifact-validation.ts";

export const WORKER_BUNDLE_FORM_URL =
  "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/" as const;

export const WORKER_BUNDLE_LIMITS = {
  manifestBytes: 1_048_576,
  fileCount: 512,
  pathBytes: ARTIFACT_PATH_MAX_BYTES,
  urlAsciiBytes: ARTIFACT_URL_MAX_ASCII_BYTES,
  fileBytes: 16_777_216,
  aggregateBytes: 134_217_728,
} as const;

export const WORKER_BUNDLE_MEDIA_TYPES = [
  "application/javascript+module",
  "text/plain",
  "application/octet-stream",
  "application/wasm",
] as const;

export type WorkerBundleMediaType = (typeof WORKER_BUNDLE_MEDIA_TYPES)[number];
export type WorkerBundleErrorCode = "invalid_spec" | "invalid_manifest" | "invalid_artifact";

/** Stable, payload-free validation failure suitable for public API mapping. */
export class WorkerBundleValidationError extends Error {
  constructor(readonly code: WorkerBundleErrorCode) {
    super(code);
    this.name = "WorkerBundleValidationError";
  }
}

export interface WorkerBundleSpec {
  readonly artifact: {
    readonly url: string;
    readonly sha256: string;
  };
}

export interface WorkerBundleManifestFile {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly mediaType: WorkerBundleMediaType;
}

export interface WorkerBundleManifest {
  readonly entrypoint: string;
  readonly files: readonly WorkerBundleManifestFile[];
}

export interface WorkerBundleObservedFile {
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: WorkerBundleMediaType;
  readonly byteSize: number;
}

export interface WorkerBundleObservation {
  readonly observed: {
    readonly manifestSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly entrypoint: string;
    readonly files: readonly WorkerBundleObservedFile[];
  };
  readonly output: Record<string, never>;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const MEDIA_TYPES = new Set<string>(WORKER_BUNDLE_MEDIA_TYPES);

/** Parse the exact public input shape; this performs no network access. */
export function parseWorkerBundleSpec(input: unknown): WorkerBundleSpec {
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
export function validateWorkerBundleUpdate(
  previousInput: unknown,
  nextInput: unknown,
): WorkerBundleSpec {
  const previous = parseWorkerBundleSpec(previousInput);
  const next = parseWorkerBundleSpec(nextInput);
  if (
    previous.artifact.url !== next.artifact.url ||
    previous.artifact.sha256 !== next.artifact.sha256
  ) {
    throw invalid("invalid_spec");
  }
  return next;
}

/** Decode and validate the bounded UTF-8 manifest without fetching its files. */
export function parseWorkerBundleManifest(bytes: Uint8Array): WorkerBundleManifest {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength > WORKER_BUNDLE_LIMITS.manifestBytes) {
    throw invalid("invalid_manifest");
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes, WORKER_BUNDLE_LIMITS.manifestBytes);
  } catch (error) {
    if (error instanceof StrictJsonError) throw invalid("invalid_manifest");
    throw error;
  }

  const manifest = record(parsed, "invalid_manifest");
  exactKeys(manifest, ["entrypoint", "files"], "invalid_manifest");
  if (
    typeof manifest.entrypoint !== "string" ||
    !isValidArtifactPath(manifest.entrypoint) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.length > WORKER_BUNDLE_LIMITS.fileCount
  ) {
    throw invalid("invalid_manifest");
  }

  const paths = new Set<string>();
  let entrypointIsModule = false;
  const files: WorkerBundleManifestFile[] = manifest.files.map((value) => {
    const file = record(value, "invalid_manifest");
    exactKeys(file, ["path", "url", "sha256", "mediaType"], "invalid_manifest");
    if (
      typeof file.path !== "string" ||
      !isValidArtifactPath(file.path) ||
      !isArtifactUrl(file.url) ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256) ||
      typeof file.mediaType !== "string" ||
      !MEDIA_TYPES.has(file.mediaType) ||
      paths.has(file.path)
    ) {
      throw invalid("invalid_manifest");
    }
    paths.add(file.path);
    if (file.path === manifest.entrypoint && file.mediaType === "application/javascript+module") {
      entrypointIsModule = true;
    }
    return {
      path: file.path,
      url: file.url,
      sha256: file.sha256,
      mediaType: file.mediaType as WorkerBundleMediaType,
    };
  });
  if (!entrypointIsModule) throw invalid("invalid_manifest");
  return { entrypoint: manifest.entrypoint, files };
}

/**
 * Validate exact artifact bytes and produce the only allowed observed/output
 * projection. This never fetches URLs or executes Worker code.
 */
export async function validateWorkerBundlePayload(input: {
  readonly spec: unknown;
  readonly manifestBytes: Uint8Array;
  readonly fileBytes: readonly Uint8Array[];
}): Promise<WorkerBundleObservation> {
  const spec = parseWorkerBundleSpec(input.spec);
  const manifest = parseWorkerBundleManifest(input.manifestBytes);
  const manifestSha256 = bareSha256Digest(await bytesDigest(input.manifestBytes));
  if (
    manifestSha256 !== spec.artifact.sha256 ||
    !Array.isArray(input.fileBytes) ||
    input.fileBytes.length !== manifest.files.length
  ) {
    throw invalid("invalid_artifact");
  }

  let totalBytes = 0;
  for (const bytes of input.fileBytes) {
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > WORKER_BUNDLE_LIMITS.fileBytes) {
      throw invalid("invalid_artifact");
    }
    if (totalBytes + bytes.byteLength > WORKER_BUNDLE_LIMITS.aggregateBytes) {
      throw invalid("invalid_artifact");
    }
    totalBytes += bytes.byteLength;
  }

  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index];
    const bytes = input.fileBytes[index];
    if (!file || !bytes) throw invalid("invalid_artifact");
    const digest = bareSha256Digest(await bytesDigest(bytes));
    if (digest !== file.sha256) throw invalid("invalid_artifact");
  }

  return await projectWorkerBundleVerified({
    spec: input.spec,
    manifestBytes: input.manifestBytes,
    fileSizes: input.fileBytes.map((bytes) => bytes.byteLength),
  });
}

/** Projection from a complete set of individually verified immutable files. */
export async function projectWorkerBundleVerified(input: {
  readonly spec: unknown;
  readonly manifestBytes: Uint8Array;
  readonly fileSizes: readonly number[];
}): Promise<WorkerBundleObservation> {
  const spec = parseWorkerBundleSpec(input.spec);
  const manifest = parseWorkerBundleManifest(input.manifestBytes);
  const manifestSha256 = bareSha256Digest(await bytesDigest(input.manifestBytes));
  if (manifestSha256 !== spec.artifact.sha256 || input.fileSizes.length !== manifest.files.length) {
    throw invalid("invalid_artifact");
  }
  let totalBytes = 0;
  const observedFiles: WorkerBundleObservedFile[] = manifest.files.map((file, index) => {
    const size = input.fileSizes[index];
    if (
      !Number.isSafeInteger(size) ||
      size === undefined ||
      size < 0 ||
      size > WORKER_BUNDLE_LIMITS.fileBytes ||
      totalBytes + size > WORKER_BUNDLE_LIMITS.aggregateBytes
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
      entrypoint: manifest.entrypoint,
      files: observedFiles,
    },
    output: {},
  };
}

function record(value: unknown, code: WorkerBundleErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(code);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: WorkerBundleErrorCode,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key))) {
    throw invalid(code);
  }
}

function invalid(code: WorkerBundleErrorCode): WorkerBundleValidationError {
  return new WorkerBundleValidationError(code);
}
