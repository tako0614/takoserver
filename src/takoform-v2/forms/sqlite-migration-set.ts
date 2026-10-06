import { bytesDigest } from "../../json.ts";
import { parseStrictJson, StrictJsonError } from "../../strict-json.ts";
import { isV2HttpsUrl } from "../identity.ts";

export const SQLITE_MIGRATION_SET_FORM_URL =
  "https://edge.forms.takoform.com/forms/SQLiteMigrationSet/0.2.0/" as const;

export const SQLITE_MIGRATION_SET_LIMITS = {
  manifestBytes: 1_048_576,
  fileCount: 512,
  pathBytes: 1_024,
  urlAsciiBytes: 8_192,
  fileBytes: 16_777_216,
  aggregateBytes: 134_217_728,
} as const;

export type SQLiteMigrationSetErrorCode = "invalid_spec" | "invalid_manifest" | "invalid_artifact";

/** Stable, payload-free validation failure suitable for public API mapping. */
export class SQLiteMigrationSetValidationError extends Error {
  constructor(readonly code: SQLiteMigrationSetErrorCode) {
    super(code);
    this.name = "SQLiteMigrationSetValidationError";
  }
}

export interface SQLiteMigrationSetSpec {
  readonly artifact: {
    readonly url: string;
    readonly sha256: string;
  };
}

export interface SQLiteMigrationManifestFile {
  readonly path: string;
  readonly url: string;
  readonly sha256: string;
  readonly mediaType: "application/sql";
}

export interface SQLiteMigrationManifest {
  readonly files: readonly SQLiteMigrationManifestFile[];
}

export interface SQLiteMigrationObservedFile {
  readonly path: string;
  readonly sha256: string;
  readonly mediaType: "application/sql";
  readonly byteSize: number;
}

export interface SQLiteMigrationSetObservation {
  readonly observed: {
    readonly manifestSha256: string;
    readonly fileCount: number;
    readonly totalBytes: number;
    readonly files: readonly SQLiteMigrationObservedFile[];
  };
  readonly output: Record<string, never>;
}

const SHA256 = /^[0-9a-f]{64}$/u;

/** Parse the exact public input shape; this function performs no network access. */
export function parseSQLiteMigrationSetSpec(input: unknown): SQLiteMigrationSetSpec {
  const spec = record(input, "invalid_spec");
  exactKeys(spec, ["artifact"], "invalid_spec");
  const artifact = record(spec.artifact, "invalid_spec");
  exactKeys(artifact, ["url", "sha256"], "invalid_spec");
  const url = artifact.url;
  const sha256 = artifact.sha256;
  if (!isArtifactUrl(url) || typeof sha256 !== "string" || !SHA256.test(sha256)) {
    throw invalid("invalid_spec");
  }
  return { artifact: { url, sha256 } };
}

/** Updates may repeat the exact artifact identity but may not replace it. */
export function validateSQLiteMigrationSetUpdate(
  previousInput: unknown,
  nextInput: unknown,
): SQLiteMigrationSetSpec {
  const previous = parseSQLiteMigrationSetSpec(previousInput);
  const next = parseSQLiteMigrationSetSpec(nextInput);
  if (
    previous.artifact.url !== next.artifact.url ||
    previous.artifact.sha256 !== next.artifact.sha256
  ) {
    throw invalid("invalid_spec");
  }
  return next;
}

/** Decode and validate the bounded UTF-8 manifest without fetching its files. */
export function parseSQLiteMigrationManifest(bytes: Uint8Array): SQLiteMigrationManifest {
  if (
    !(bytes instanceof Uint8Array) ||
    bytes.byteLength > SQLITE_MIGRATION_SET_LIMITS.manifestBytes
  ) {
    throw invalid("invalid_manifest");
  }
  let parsed: unknown;
  try {
    parsed = parseStrictJson(bytes, SQLITE_MIGRATION_SET_LIMITS.manifestBytes);
  } catch (error) {
    if (error instanceof StrictJsonError) throw invalid("invalid_manifest");
    throw error;
  }
  const manifest = record(parsed, "invalid_manifest");
  exactKeys(manifest, ["files"], "invalid_manifest");
  if (
    !Array.isArray(manifest.files) ||
    manifest.files.length < 1 ||
    manifest.files.length > SQLITE_MIGRATION_SET_LIMITS.fileCount
  ) {
    throw invalid("invalid_manifest");
  }
  const paths = new Set<string>();
  const files: SQLiteMigrationManifestFile[] = manifest.files.map((value) => {
    const file = record(value, "invalid_manifest");
    exactKeys(file, ["path", "url", "sha256", "mediaType"], "invalid_manifest");
    if (
      typeof file.path !== "string" ||
      !isValidMigrationPath(file.path) ||
      !isArtifactUrl(file.url) ||
      typeof file.sha256 !== "string" ||
      !SHA256.test(file.sha256) ||
      file.mediaType !== "application/sql" ||
      paths.has(file.path)
    ) {
      throw invalid("invalid_manifest");
    }
    paths.add(file.path);
    return {
      path: file.path,
      url: file.url,
      sha256: file.sha256,
      mediaType: "application/sql",
    };
  });
  return { files };
}

/**
 * Validate exact artifact bytes and produce the only allowed observed/output
 * projection. This never executes SQL, fetches a URL, or stores any bytes.
 */
export async function validateSQLiteMigrationPayload(input: {
  readonly spec: unknown;
  readonly manifestBytes: Uint8Array;
  readonly fileBytes: readonly Uint8Array[];
}): Promise<SQLiteMigrationSetObservation> {
  const spec = parseSQLiteMigrationSetSpec(input.spec);
  const manifest = parseSQLiteMigrationManifest(input.manifestBytes);
  const manifestSha256 = bareSha256(await bytesDigest(input.manifestBytes));
  if (
    manifestSha256 !== spec.artifact.sha256 ||
    !Array.isArray(input.fileBytes) ||
    input.fileBytes.length !== manifest.files.length
  ) {
    throw invalid("invalid_artifact");
  }

  let totalBytes = 0;
  for (const bytes of input.fileBytes) {
    if (
      !(bytes instanceof Uint8Array) ||
      bytes.byteLength > SQLITE_MIGRATION_SET_LIMITS.fileBytes
    ) {
      throw invalid("invalid_artifact");
    }
    if (totalBytes + bytes.byteLength > SQLITE_MIGRATION_SET_LIMITS.aggregateBytes) {
      throw invalid("invalid_artifact");
    }
    totalBytes += bytes.byteLength;
  }

  const observedFiles: SQLiteMigrationObservedFile[] = [];
  for (let index = 0; index < manifest.files.length; index += 1) {
    const file = manifest.files[index];
    const bytes = input.fileBytes[index];
    if (!file || !bytes) throw invalid("invalid_artifact");
    if (startsWithUtf8Bom(bytes) || !isStrictUtf8(bytes)) throw invalid("invalid_artifact");
    const digest = bareSha256(await bytesDigest(bytes));
    if (digest !== file.sha256) throw invalid("invalid_artifact");
    observedFiles.push({
      path: file.path,
      sha256: digest,
      mediaType: "application/sql",
      byteSize: bytes.byteLength,
    });
  }

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

function isArtifactUrl(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= SQLITE_MIGRATION_SET_LIMITS.urlAsciiBytes &&
    isV2HttpsUrl(value) &&
    !value.includes("?") &&
    !value.includes("#")
  );
}

function isValidMigrationPath(value: string): boolean {
  if (
    value.length === 0 ||
    new TextEncoder().encode(value).byteLength > SQLITE_MIGRATION_SET_LIMITS.pathBytes ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.includes("\\") ||
    value.includes("?") ||
    value.includes("#") ||
    hasPathControl(value)
  ) {
    return false;
  }
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}

function hasPathControl(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isStrictUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function startsWithUtf8Bom(bytes: Uint8Array): boolean {
  return bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
}

function bareSha256(value: `sha256:${string}`): string {
  return value.slice("sha256:".length);
}

function record(value: unknown, code: SQLiteMigrationSetErrorCode): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid(code);
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  code: SQLiteMigrationSetErrorCode,
): void {
  const actual = Object.keys(value);
  if (actual.length !== keys.length || actual.some((key) => !keys.includes(key)))
    throw invalid(code);
}

function invalid(code: SQLiteMigrationSetErrorCode): SQLiteMigrationSetValidationError {
  return new SQLiteMigrationSetValidationError(code);
}
