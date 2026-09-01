import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import {
  bytesDigest,
  canonicalDigest,
  canonicalJson,
  isJsonObject,
  isSha256Digest,
} from "../json.ts";
import type { JsonObject, ObjectStore } from "../ports.ts";
import {
  cancelFormPackageStream,
  FORM_PACKAGE_LIMITS,
  FormPackageStreamLimitError,
  formPackagePayloadLimit,
  formPackagePayloadTotal,
  hasExactFormPackageObjectClosure,
  readBoundedFormPackageStream,
} from "./form-package-limits.ts";
import { validateFormRef } from "./forms.ts";

/**
 * Form Packages are operator-owned distribution bytes.  They deliberately do
 * not share the tenant artifact namespace (`art/`): a package is installed by
 * an admission decision, not uploaded by a customer Resource request.
 */
export const FORM_PACKAGE_PREFIX = "formpkg/v1/sha256";

export type FormPackageDigest = `sha256:${string}`;

export interface FormPackageFileInput {
  readonly path: string;
  readonly bytes: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;
  readonly digest?: FormPackageDigest;
  readonly mediaType?: string;
}

/**
 * The package index is the package identity.  Its canonical digest must equal
 * `packageDigest`; payload files are listed by path/digest/size in the index.
 * No executable code is interpreted by this module.
 */
export interface FormPackageInput {
  readonly packageDigest: FormPackageDigest;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly files: readonly FormPackageFileInput[];
  readonly manifest?: JsonObject;
  readonly retentionRef?: string;
  readonly retentionUntil?: number;
}

export interface FormPackageFile {
  readonly path: string;
  readonly digest: FormPackageDigest;
  readonly size: number;
  readonly mediaType?: string;
  readonly bytes: Uint8Array;
}

export interface StoredFormPackage {
  readonly packageDigest: FormPackageDigest;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly prefix: string;
  readonly manifest: JsonObject;
  readonly files: readonly FormPackageFile[];
}

export interface FormPackageStore {
  /** Writes bytes, reads every byte back, and verifies all content digests. */
  put(input: FormPackageInput): Promise<StoredFormPackage>;
  /** Reads and verifies an already written package. */
  read(input: {
    readonly packageDigest: FormPackageDigest;
    readonly formRef?: TakoformV1Alpha3FormRef;
  }): Promise<StoredFormPackage | null>;
  /** Deletes package bytes only; no admission row is changed here. */
  purge(packageDigest: FormPackageDigest): Promise<void>;
}

export class FormPackageError extends Error {
  constructor(
    readonly code:
      | "invalid_package"
      | "package_digest_mismatch"
      | "package_missing"
      | "package_readback_mismatch"
      | "package_store_unavailable",
    message: string = code,
  ) {
    super(message);
    this.name = "FormPackageError";
  }
}

/** Returns `formpkg/v1/sha256/<hex>/`, never the tenant `art/` prefix. */
export function formPackagePrefix(packageDigest: string): string {
  requireDigest(packageDigest);
  return `${FORM_PACKAGE_PREFIX}/${packageDigest.slice("sha256:".length)}`;
}

/** Returns the exact object key for one package-relative path. */
export function formPackageKey(packageDigest: string, relativePath: string): string {
  return `${formPackagePrefix(packageDigest)}/${validateRelativePath(relativePath)}`;
}

/**
 * Builds the canonical package index used by the package digest check.  The
 * index contains only data and exact identity pins; it cannot carry an
 * executable implementation, credentials, target, price, capacity, policy,
 * or a publisher classification lane.
 */
export function packageManifest(input: {
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly files: readonly Pick<FormPackageFile, "path" | "digest" | "size" | "mediaType">[];
  readonly manifest?: JsonObject;
}): JsonObject {
  assertPackageFileLimits(input.files);
  if (input.manifest !== undefined) {
    if (!isJsonObject(input.manifest)) throw new FormPackageError("invalid_package");
    const manifest = validatePackageManifest(input.manifest, input.formRef, input.files);
    assertPackageIndexSize(manifest);
    return manifest;
  }
  const manifest = {
    apiVersion: "packages.forms.takoform.com/v1alpha1",
    kind: "FormPackage",
    formRef: structuredClone(input.formRef) as unknown as JsonObject,
    files: input.files.map((file) => ({
      path: file.path,
      digest: file.digest,
      size: file.size,
      ...(file.mediaType === undefined ? {} : { mediaType: file.mediaType }),
    })),
  };
  const validated = validatePackageManifest(manifest, input.formRef, input.files);
  assertPackageIndexSize(validated);
  return validated;
}

export function createFormPackageStore(objects: ObjectStore): FormPackageStore {
  if (
    !objects ||
    typeof objects.create !== "function" ||
    typeof objects.put !== "function" ||
    typeof objects.get !== "function" ||
    typeof objects.head !== "function" ||
    typeof objects.list !== "function" ||
    typeof objects.delete !== "function"
  ) {
    throw new FormPackageError("package_store_unavailable", "an ObjectStore is required");
  }

  return {
    async put(input): Promise<StoredFormPackage> {
      if (input?.manifest !== undefined) {
        assertDeclaredManifestLimits(input.manifest);
      }
      const normal = await materialize(input);
      const manifest = packageManifest({
        formRef: normal.formRef,
        files: normal.files,
        ...(input.manifest === undefined ? {} : { manifest: input.manifest }),
      });
      const computedPackageDigest = await canonicalDigest(manifest);
      if (computedPackageDigest !== input.packageDigest) {
        throw new FormPackageError(
          "package_digest_mismatch",
          `package index digest ${computedPackageDigest} does not match ${input.packageDigest}`,
        );
      }

      const prefix = formPackagePrefix(input.packageDigest);
      const indexKey = `${prefix}/package-index.json`;
      const indexBytes = new TextEncoder().encode(canonicalJson(manifest));
      if (indexBytes.byteLength > FORM_PACKAGE_LIMITS.indexBytes) {
        throw new FormPackageError(
          "invalid_package",
          `package index exceeds ${FORM_PACKAGE_LIMITS.indexBytes} bytes`,
        );
      }

      // The index is the package visibility point. If it already exists, this
      // import is an exact-existing read only; a malformed or different prefix
      // is never repaired by overwriting it.
      if (await objects.head(indexKey)) {
        return exactReadback(
          await readPackage(objects, input.packageDigest, input.formRef),
          manifest,
          normal.files,
        );
      }

      // Payloads are created first, then the canonical index publishes the
      // complete prefix. Concurrent identical imports converge through the
      // exact-existing branch; a different existing byte fails closed.
      for (const file of normal.files) {
        await createExactObject(
          objects,
          formPackageKey(input.packageDigest, file.path),
          file.bytes,
          file.mediaType,
        );
      }
      await createExactObject(objects, indexKey, indexBytes, "application/json");

      // The write is not an install.  It becomes usable only after the full
      // readback below verifies the index and every payload digest.
      return exactReadback(
        await readPackage(objects, input.packageDigest, input.formRef),
        manifest,
        normal.files,
      );
    },

    async read(input): Promise<StoredFormPackage | null> {
      requireDigest(input.packageDigest);
      if (input.formRef !== undefined) validateFormRefShape(input.formRef);
      return readPackage(objects, input.packageDigest, input.formRef);
    },

    async purge(packageDigest): Promise<void> {
      requireDigest(packageDigest);
      const prefix = `${formPackagePrefix(packageDigest)}/`;
      let cursor: string | undefined;
      do {
        const page = await objects.list({ prefix, limit: 100, ...(cursor ? { cursor } : {}) });
        for (const object of page.objects) await objects.delete(object.key);
        cursor = page.truncated ? page.cursor : undefined;
      } while (cursor !== undefined);
    },
  };
}

async function createExactObject(
  objects: ObjectStore,
  key: string,
  bytes: Uint8Array,
  contentType?: string,
): Promise<void> {
  const created = await objects.create(key, bytes, {
    ...(contentType === undefined ? {} : { contentType }),
  });
  if (created) return;
  const existing = await objects.get(key);
  if (!existing) {
    throw new FormPackageError(
      "package_readback_mismatch",
      "create-only package object disappeared",
    );
  }
  let existingBytes: Uint8Array;
  try {
    existingBytes = await readBoundedFormPackageStream(
      existing.body,
      bytes.byteLength,
      bytes.byteLength,
    );
  } catch (error) {
    if (error instanceof FormPackageStreamLimitError) {
      throw new FormPackageError("package_readback_mismatch", error.message);
    }
    throw error;
  }
  if (!sameBytes(existingBytes, bytes)) {
    throw new FormPackageError(
      "package_readback_mismatch",
      "existing package object has different bytes",
    );
  }
}

function exactReadback(
  readback: StoredFormPackage | null,
  manifest: JsonObject,
  files: readonly FormPackageFile[],
): StoredFormPackage {
  if (!readback || canonicalJson(readback.manifest) !== canonicalJson(manifest)) {
    throw new FormPackageError("package_readback_mismatch", "package index changed");
  }
  if (readback.files.length !== files.length) {
    throw new FormPackageError("package_readback_mismatch", "package file count changed");
  }
  for (let index = 0; index < files.length; index += 1) {
    const expected = files[index];
    const actual = readback.files[index];
    if (
      !actual ||
      actual.path !== expected?.path ||
      actual.digest !== expected?.digest ||
      actual.size !== expected?.size ||
      !sameBytes(actual.bytes, expected.bytes)
    ) {
      throw new FormPackageError("package_readback_mismatch", "package payload changed");
    }
  }
  return readback;
}

async function materialize(input: FormPackageInput): Promise<{
  readonly packageDigest: FormPackageDigest;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly files: readonly FormPackageFile[];
}> {
  if (!input || typeof input !== "object") {
    throw new FormPackageError("invalid_package", "package input is required");
  }
  requireDigest(input.packageDigest);
  validateFormRefShape(input.formRef);
  if (!Array.isArray(input.files) || input.files.length === 0) {
    throw new FormPackageError("invalid_package", "a package needs at least one payload file");
  }
  if (
    input.retentionRef !== undefined &&
    (typeof input.retentionRef !== "string" ||
      input.retentionRef.length === 0 ||
      input.retentionRef.length > 255)
  ) {
    throw new FormPackageError(
      "invalid_package",
      "retentionRef must be a bounded non-empty string",
    );
  }
  if (
    input.retentionUntil !== undefined &&
    (!Number.isSafeInteger(input.retentionUntil) || input.retentionUntil < 0)
  ) {
    throw new FormPackageError("invalid_package", "retentionUntil must be a non-negative integer");
  }
  if (input.retentionUntil !== undefined && input.retentionRef === undefined) {
    throw new FormPackageError("invalid_package", "retentionUntil needs retentionRef");
  }
  const seen = new Set<string>();
  const files: FormPackageFile[] = [];
  if (input.files.length > FORM_PACKAGE_LIMITS.files) {
    throw new FormPackageError(
      "invalid_package",
      `package lists ${input.files.length} files; maximum is ${FORM_PACKAGE_LIMITS.files}`,
    );
  }
  let payloadBytes = 0;
  const declaredFiles = declaredManifestFiles(input.manifest);
  for (const file of input.files) {
    if (!file || typeof file !== "object" || typeof file.path !== "string") {
      throw new FormPackageError("invalid_package", "package file declaration is invalid");
    }
    const path = validateRelativePath(file.path);
    if (path === "package-index.json") {
      throw new FormPackageError("invalid_package", "package-index.json is reserved");
    }
    if (seen.has(path)) throw new FormPackageError("invalid_package", "duplicate package path");
    seen.add(path);
    const mediaType =
      file.mediaType === undefined ? undefined : validateInputMediaType(file.mediaType);
    const declared = declaredFiles.get(path);
    const declaredSize = declared?.size;
    const boundedMediaType = mediaType ?? declared?.mediaType;
    const maximum = Math.min(
      formPackagePayloadLimit(boundedMediaType),
      FORM_PACKAGE_LIMITS.packagePayloadBytes - payloadBytes,
    );
    let bytes: Uint8Array;
    try {
      bytes = await bytesOf(file.bytes, maximum, declaredSize);
    } catch (error) {
      if (error instanceof FormPackageStreamLimitError) {
        throw new FormPackageError("invalid_package", error.message);
      }
      throw error;
    }
    const digest = await bytesDigest(bytes);
    if (file.digest !== undefined && file.digest !== digest) {
      throw new FormPackageError("package_digest_mismatch", `payload digest mismatch for ${path}`);
    }
    if (bytes.byteLength > FORM_PACKAGE_LIMITS.packagePayloadBytes - payloadBytes) {
      throw new FormPackageError("invalid_package", "package payload total exceeds 256 MiB");
    }
    payloadBytes += bytes.byteLength;
    files.push({
      path,
      digest,
      size: bytes.byteLength,
      ...(mediaType === undefined ? {} : { mediaType: mediaType }),
      bytes,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  return { packageDigest: input.packageDigest, formRef: structuredClone(input.formRef), files };
}

async function readPackage(
  objects: ObjectStore,
  packageDigest: FormPackageDigest,
  expectedFormRef?: TakoformV1Alpha3FormRef,
): Promise<StoredFormPackage | null> {
  const prefix = formPackagePrefix(packageDigest);
  const index = await objects.get(`${prefix}/package-index.json`);
  if (!index) return null;
  if (!validObjectSize(index.size) || index.size > FORM_PACKAGE_LIMITS.indexBytes) {
    cancelFormPackageStream(index.body);
    return null;
  }
  let indexBytes: Uint8Array;
  try {
    indexBytes = await readBoundedFormPackageStream(
      index.body,
      FORM_PACKAGE_LIMITS.indexBytes,
      index.size > 0 ? index.size : undefined,
    );
  } catch (error) {
    if (error instanceof FormPackageStreamLimitError) return null;
    throw error;
  }
  let manifest: JsonObject;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(indexBytes));
    if (!isJsonObject(parsed)) return null;
    manifest = parsed;
  } catch {
    return null;
  }
  if ((await canonicalDigest(manifest)) !== packageDigest) return null;
  if (!validateManifestEnvelope(manifest)) return null;
  const formRef = manifest.formRef;
  if (!isFormRef(formRef)) return null;
  if (expectedFormRef && canonicalJson(formRef) !== canonicalJson(expectedFormRef)) return null;
  const declarations = manifest.files;
  if (
    !Array.isArray(declarations) ||
    declarations.length === 0 ||
    declarations.length > FORM_PACKAGE_LIMITS.files
  ) {
    return null;
  }
  if (formPackagePayloadTotal(declarations) === null) return null;
  const files: FormPackageFile[] = [];
  const seen = new Set<string>();
  let declaredPayloadBytes = 0;
  for (const value of declarations) {
    if (!isJsonObject(value)) return null;
    const path = value.path;
    const digest = value.digest;
    const size = value.size;
    if (
      typeof path !== "string" ||
      !isSha256Digest(digest) ||
      typeof size !== "number" ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      (value.mediaType !== undefined &&
        (typeof value.mediaType !== "string" ||
          value.mediaType.length === 0 ||
          value.mediaType.length > 255 ||
          !ALLOWED_MEDIA_TYPES.has(value.mediaType)))
    ) {
      return null;
    }
    const safePath = validateRelativePath(path);
    if (safePath === "package-index.json" || seen.has(safePath)) return null;
    const limit = formPackagePayloadLimit(
      typeof value.mediaType === "string" ? value.mediaType : undefined,
    );
    if (size > limit || size > FORM_PACKAGE_LIMITS.packagePayloadBytes - declaredPayloadBytes) {
      return null;
    }
    declaredPayloadBytes += size;
    seen.add(safePath);
    const object = await objects.get(formPackageKey(packageDigest, safePath));
    if (!object) return null;
    if (!validObjectSize(object.size) || object.size > limit) {
      cancelFormPackageStream(object.body);
      return null;
    }
    let bytes: Uint8Array;
    try {
      bytes = await readBoundedFormPackageStream(object.body, limit, size);
    } catch (error) {
      if (error instanceof FormPackageStreamLimitError) return null;
      throw error;
    }
    if ((await bytesDigest(bytes)) !== digest) return null;
    files.push({
      path: safePath,
      digest,
      size,
      ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
      bytes,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  try {
    validatePackageManifest(manifest, formRef, files);
  } catch {
    return null;
  }
  const expectedKeys = new Set<string>([
    `${prefix}/package-index.json`,
    ...files.map((file) => formPackageKey(packageDigest, file.path)),
  ]);
  if (
    !(await hasExactFormPackageObjectClosure(
      (input) => objects.list(input),
      `${prefix}/`,
      expectedKeys,
    ))
  ) {
    return null;
  }
  return {
    packageDigest,
    formRef: structuredClone(formRef),
    prefix,
    manifest,
    files,
  };
}

/**
 * Validate the package index as a closed data document.  The Host stores the
 * index verbatim for content addressing, so accepting an open-ended object
 * here would create a covert authority/identity channel.  The only optional
 * metadata is a bounded package/definition path; all publisher/policy/lane
 * fields (and every other unknown field) are rejected by the exact-key checks.
 */
function validatePackageManifest(
  value: JsonObject,
  expectedFormRef: TakoformV1Alpha3FormRef,
  expectedFiles: readonly Pick<FormPackageFile, "path" | "digest" | "size" | "mediaType">[],
): JsonObject {
  if (!validateManifestEnvelope(value)) {
    throw new FormPackageError("invalid_package", "package manifest has unsupported fields");
  }
  if (
    value.apiVersion !== "packages.forms.takoform.com/v1alpha1" &&
    value.apiVersion !== "packages.forms.takoform.com/v1alpha2" &&
    value.apiVersion !== "packages.forms.takoform.com/v1alpha3" &&
    value.apiVersion !== "packages.forms.takoform.com/v1alpha4" &&
    value.apiVersion !== "packages.forms.takoform.com/v1alpha5"
  ) {
    throw new FormPackageError("invalid_package", "unsupported package manifest apiVersion");
  }
  if (value.kind !== "FormPackage") {
    throw new FormPackageError("invalid_package", "package manifest kind is invalid");
  }
  if (
    !isFormRef(value.formRef) ||
    canonicalJson(value.formRef) !== canonicalJson(expectedFormRef)
  ) {
    throw new FormPackageError("invalid_package", "package manifest FormRef does not match input");
  }
  if (value.packageVersion !== undefined) {
    if (
      typeof value.packageVersion !== "string" ||
      value.packageVersion.length === 0 ||
      value.packageVersion.length > 128
    ) {
      throw new FormPackageError("invalid_package", "packageVersion is invalid");
    }
  }
  if (value.definitionPath !== undefined) {
    if (
      typeof value.definitionPath !== "string" ||
      !isSafeManifestPath(value.definitionPath) ||
      value.definitionPath === "package-index.json"
    ) {
      throw new FormPackageError("invalid_package", "definitionPath is invalid");
    }
  }
  if (!Array.isArray(value.files) || value.files.length === 0) {
    throw new FormPackageError("invalid_package", "package manifest files are invalid");
  }
  assertPackageFileLimits(value.files);
  if (expectedFiles.length > FORM_PACKAGE_LIMITS.files) {
    throw new FormPackageError(
      "invalid_package",
      `package lists ${expectedFiles.length} files; maximum is ${FORM_PACKAGE_LIMITS.files}`,
    );
  }
  if (value.files.length !== expectedFiles.length) {
    throw new FormPackageError(
      "invalid_package",
      "package manifest file set does not match payloads",
    );
  }
  const expectedByPath = new Map(expectedFiles.map((file) => [file.path, file]));
  const seen = new Set<string>();
  for (const declaration of value.files) {
    if (!isJsonObject(declaration)) {
      throw new FormPackageError("invalid_package", "package manifest file is invalid");
    }
    const keys = Object.keys(declaration).sort();
    const allowed = new Set(["digest", "mediaType", "path", "size"]);
    if (keys.some((key) => !allowed.has(key)) || keys.length < 3 || keys.length > 4) {
      throw new FormPackageError("invalid_package", "package manifest file has unsupported fields");
    }
    if (!keys.includes("digest") || !keys.includes("path") || !keys.includes("size")) {
      throw new FormPackageError(
        "invalid_package",
        "package manifest file is missing required fields",
      );
    }
    if (
      typeof declaration.path !== "string" ||
      !isSafeManifestPath(declaration.path) ||
      declaration.path === "package-index.json" ||
      seen.has(declaration.path) ||
      !isSha256Digest(declaration.digest) ||
      typeof declaration.size !== "number" ||
      !Number.isSafeInteger(declaration.size) ||
      declaration.size < 0
    ) {
      throw new FormPackageError("invalid_package", "package manifest file declaration is invalid");
    }
    if (
      declaration.mediaType !== undefined &&
      (typeof declaration.mediaType !== "string" ||
        declaration.mediaType.length === 0 ||
        declaration.mediaType.length > 255 ||
        !ALLOWED_MEDIA_TYPES.has(declaration.mediaType))
    ) {
      throw new FormPackageError("invalid_package", "package manifest media type is invalid");
    }
    const expected = expectedByPath.get(declaration.path);
    if (
      !expected ||
      declaration.digest !== expected.digest ||
      declaration.size !== expected.size ||
      declaration.mediaType !== expected.mediaType
    ) {
      throw new FormPackageError("invalid_package", "package manifest file does not match payload");
    }
    seen.add(declaration.path);
  }
  if (value.definitionPath !== undefined && !seen.has(value.definitionPath)) {
    throw new FormPackageError("invalid_package", "definitionPath is not listed");
  }
  return structuredClone(value);
}

function assertPackageIndexSize(value: JsonObject): void {
  let bytes: Uint8Array;
  try {
    bytes = new TextEncoder().encode(canonicalJson(value));
  } catch {
    throw new FormPackageError("invalid_package", "package index cannot be encoded");
  }
  if (bytes.byteLength > FORM_PACKAGE_LIMITS.indexBytes) {
    throw new FormPackageError(
      "invalid_package",
      `package index exceeds ${FORM_PACKAGE_LIMITS.indexBytes} bytes`,
    );
  }
}

function assertDeclaredManifestLimits(value: unknown): void {
  if (!isJsonObject(value)) {
    throw new FormPackageError("invalid_package", "package manifest is invalid");
  }
  assertPackageIndexSize(value);
  if (Array.isArray(value.files)) assertPackageFileLimits(value.files);
}

function assertPackageFileLimits(files: readonly unknown[]): void {
  if (files.length > FORM_PACKAGE_LIMITS.files) {
    throw new FormPackageError(
      "invalid_package",
      `package lists ${files.length} files; maximum is ${FORM_PACKAGE_LIMITS.files}`,
    );
  }
  let total = 0;
  for (const value of files) {
    if (!isJsonObject(value)) continue;
    const size = value.size;
    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) continue;
    const mediaType = typeof value.mediaType === "string" ? value.mediaType : undefined;
    const limit = formPackagePayloadLimit(mediaType);
    if (size > limit) {
      throw new FormPackageError(
        "invalid_package",
        `package payload exceeds ${limit} bytes for ${mediaType ?? "untyped"} content`,
      );
    }
    if (size > FORM_PACKAGE_LIMITS.packagePayloadBytes - total) {
      throw new FormPackageError(
        "invalid_package",
        `package payload total exceeds ${FORM_PACKAGE_LIMITS.packagePayloadBytes} bytes`,
      );
    }
    total += size;
  }
}

function declaredManifestFiles(
  manifest: JsonObject | undefined,
): ReadonlyMap<string, { readonly size: number; readonly mediaType?: string }> {
  if (!manifest || !Array.isArray(manifest.files)) return new Map();
  const declared = new Map<string, { readonly size: number; readonly mediaType?: string }>();
  for (const value of manifest.files) {
    if (!isJsonObject(value) || typeof value.path !== "string") continue;
    if (typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0) {
      continue;
    }
    declared.set(value.path, {
      size: value.size,
      ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    });
  }
  return declared;
}

const ALLOWED_MEDIA_TYPES = new Set([
  "application/vnd.takoform.form-definition.v1+json",
  "application/schema+json",
  "application/json",
  "text/markdown",
  "text/plain",
]);

function validateManifestEnvelope(value: JsonObject): boolean {
  const keys = Object.keys(value).sort();
  const allowed = new Set([
    "apiVersion",
    "definitionPath",
    "files",
    "formRef",
    "kind",
    "packageVersion",
  ]);
  if (keys.length < 4 || keys.length > allowed.size || keys.some((key) => !allowed.has(key))) {
    return false;
  }
  return (
    typeof value.apiVersion === "string" &&
    value.kind === "FormPackage" &&
    isJsonObject(value.formRef) &&
    Array.isArray(value.files)
  );
}

function isSafeManifestPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\u0000") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function requireDigest(value: string): asserts value is FormPackageDigest {
  if (!isSha256Digest(value))
    throw new FormPackageError("invalid_package", "invalid sha256 digest");
}

function validObjectSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.startsWith("/") ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    value.includes("\u0000")
  ) {
    throw new FormPackageError("invalid_package", `invalid package-relative path: ${value}`);
  }
  return value;
}

function validateFormRefShape(value: TakoformV1Alpha3FormRef): void {
  if (
    typeof value !== "object" ||
    value === null ||
    !sameFormRefKeys(value) ||
    typeof value.apiVersion !== "string" ||
    typeof value.kind !== "string" ||
    typeof value.definitionVersion !== "string" ||
    !isSha256Digest(value.schemaDigest)
  ) {
    throw new FormPackageError("invalid_package", "invalid FormRef");
  }
  try {
    validateFormRef(value);
  } catch {
    throw new FormPackageError("invalid_package", "invalid FormRef");
  }
}

function isFormRef(value: unknown): value is TakoformV1Alpha3FormRef {
  if (!isJsonObject(value)) return false;
  try {
    if (!sameFormRefKeys(value)) return false;
    validateFormRef(value as unknown as TakoformV1Alpha3FormRef);
    return true;
  } catch {
    return false;
  }
}

function sameFormRefKeys(value: object): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === 4 &&
    actual[0] === "apiVersion" &&
    actual[1] === "definitionVersion" &&
    actual[2] === "kind" &&
    actual[3] === "schemaDigest"
  );
}

function validateInputMediaType(value: string): string {
  if (value.length === 0 || value.length > 255 || !ALLOWED_MEDIA_TYPES.has(value)) {
    throw new FormPackageError("invalid_package", "package media type is invalid");
  }
  return value;
}

async function bytesOf(
  value: ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
  maxBytes: number,
  expectedBytes?: number,
): Promise<Uint8Array> {
  if (value instanceof Uint8Array) {
    if (value.byteLength > maxBytes) {
      throw new FormPackageStreamLimitError(
        "overrun",
        `Form Package payload exceeds ${maxBytes} bytes`,
      );
    }
    if (expectedBytes !== undefined && value.byteLength !== expectedBytes) {
      throw new FormPackageStreamLimitError(
        value.byteLength < expectedBytes ? "underrun" : "overrun",
        `Form Package payload has ${value.byteLength} bytes; declared ${expectedBytes}`,
      );
    }
    return value.slice();
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength > maxBytes) {
      throw new FormPackageStreamLimitError(
        "overrun",
        `Form Package payload exceeds ${maxBytes} bytes`,
      );
    }
    if (expectedBytes !== undefined && value.byteLength !== expectedBytes) {
      throw new FormPackageStreamLimitError(
        value.byteLength < expectedBytes ? "underrun" : "overrun",
        `Form Package payload has ${value.byteLength} bytes; declared ${expectedBytes}`,
      );
    }
    return new Uint8Array(value.slice(0));
  }
  if (!(value instanceof ReadableStream)) {
    throw new FormPackageError("invalid_package", "package payload bytes are invalid");
  }
  return await readBoundedFormPackageStream(value, maxBytes, expectedBytes);
}

function sameBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  for (let index = 0; index < left.byteLength; index += 1) {
    if (left[index] !== right[index]) return false;
  }
  return true;
}
