import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import {
  bytesDigest,
  canonicalDigest,
  canonicalJson,
  isJsonObject,
  isSha256Digest,
} from "../json.ts";
import type { JsonObject, ObjectStoreAccess } from "../ports.ts";
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

/** Operator-owned package bytes never share the tenant artifact namespace. */
export const FORM_PACKAGE_PREFIX = "formpkg/v1/sha256";

export type FormPackageDigest = `sha256:${string}`;

export interface ReadOnlyFormPackageFile {
  readonly path: string;
  readonly digest: FormPackageDigest;
  readonly size: number;
  readonly mediaType?: string;
  readonly bytes: Uint8Array;
}

export interface ReadOnlyStoredFormPackage {
  readonly packageDigest: FormPackageDigest;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly prefix: string;
  readonly manifest: JsonObject;
  readonly files: readonly ReadOnlyFormPackageFile[];
}

/** The definition-only read used by fresh discovery and support probes. */
export interface ReadOnlyStoredFormDefinition {
  readonly packageDigest: FormPackageDigest;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly prefix: string;
  readonly manifest: JsonObject;
  readonly definition: ReadOnlyFormPackageFile;
}

/** Narrow reader seam for discovery/support; it never implies package closure. */
export interface FormDefinitionReader {
  readDefinition(input: {
    readonly packageDigest: FormPackageDigest;
    readonly formRef?: TakoformV1Alpha3FormRef;
  }): Promise<ReadOnlyStoredFormDefinition | null>;
}

/** The public runtime gets only exact readback; package writes stay private. */
export interface FormPackageReader {
  /**
   * Reads the complete package closure. Admission and retained-resource
   * authority use this path because an extra or missing object is a package
   * failure, not a best-effort warning.
   */
  read(input: {
    readonly packageDigest: FormPackageDigest;
    readonly formRef?: TakoformV1Alpha3FormRef;
  }): Promise<ReadOnlyStoredFormPackage | null>;
  /**
   * Reads only the canonical index and its declared Form Definition. This is
   * intentionally not a substitute for `read`: support/discovery needs a
   * bounded fresh probe, while mutation authority still verifies the complete
   * object closure.
   */
  readDefinition?: FormDefinitionReader["readDefinition"];
}

export class FormPackageReadError extends Error {
  constructor(
    readonly code: "invalid_package" | "package_store_unavailable",
    message: string = code,
  ) {
    super(message);
    this.name = "FormPackageReadError";
  }
}

/** Returns `formpkg/v1/sha256/<hex>`, never a tenant-owned prefix. */
export function readOnlyFormPackagePrefix(packageDigest: string): string {
  requireDigest(packageDigest);
  return `${FORM_PACKAGE_PREFIX}/${packageDigest.slice("sha256:".length)}`;
}

export function readOnlyFormPackageKey(packageDigest: string, relativePath: string): string {
  return `${readOnlyFormPackagePrefix(packageDigest)}/${validateRelativePath(relativePath)}`;
}

export function createFormPackageReader(
  objects: Pick<ObjectStoreAccess, "get" | "list">,
): FormPackageReader {
  if (!objects || typeof objects.get !== "function" || typeof objects.list !== "function") {
    throw new FormPackageReadError(
      "package_store_unavailable",
      "an object reader with bounded listing is required",
    );
  }
  return {
    async read(input): Promise<ReadOnlyStoredFormPackage | null> {
      requireDigest(input.packageDigest);
      if (input.formRef !== undefined) validateFormRefShape(input.formRef);
      return await readPackage(objects, input.packageDigest, input.formRef);
    },
    async readDefinition(input): Promise<ReadOnlyStoredFormDefinition | null> {
      requireDigest(input.packageDigest);
      if (input.formRef !== undefined) validateFormRefShape(input.formRef);
      return await readDefinition(objects, input.packageDigest, input.formRef);
    },
  };
}

async function readPackage(
  objects: Pick<ObjectStoreAccess, "get" | "list">,
  packageDigest: FormPackageDigest,
  expectedFormRef?: TakoformV1Alpha3FormRef,
): Promise<ReadOnlyStoredFormPackage | null> {
  const index = await readPackageIndex(objects, packageDigest, expectedFormRef);
  if (!index) return null;
  const files = await readDeclaredFiles(objects, packageDigest, index.declarations);
  if (!files) return null;
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!validateManifest(index.manifest, index.formRef, files)) return null;
  const expectedKeys = new Set<string>([
    `${index.prefix}/package-index.json`,
    ...files.map((file) => readOnlyFormPackageKey(packageDigest, file.path)),
  ]);
  if (
    !(await hasExactFormPackageObjectClosure(
      (input) => objects.list(input),
      `${index.prefix}/`,
      expectedKeys,
    ))
  ) {
    return null;
  }

  return {
    packageDigest,
    formRef: structuredClone(index.formRef),
    prefix: index.prefix,
    manifest: structuredClone(index.manifest),
    files,
  };
}

/**
 * Fresh support/discovery read: verify the canonical package index and fetch
 * only its declared definition. The complete object closure intentionally
 * remains the responsibility of `readPackage` above.
 */
async function readDefinition(
  objects: Pick<ObjectStoreAccess, "get" | "list">,
  packageDigest: FormPackageDigest,
  expectedFormRef?: TakoformV1Alpha3FormRef,
): Promise<ReadOnlyStoredFormDefinition | null> {
  const index = await readPackageIndex(objects, packageDigest, expectedFormRef);
  if (!index || typeof index.manifest.definitionPath !== "string") return null;
  const declaration = index.declarations.find(
    (candidate) => candidate.path === index.manifest.definitionPath,
  );
  if (!declaration || declaration.size > FORM_PACKAGE_LIMITS.definitionBytes) return null;
  const object = await objects.get(readOnlyFormPackageKey(packageDigest, declaration.path));
  if (!object) return null;
  if (!validObjectSize(object.size) || object.size > FORM_PACKAGE_LIMITS.definitionBytes) {
    cancelFormPackageStream(object.body);
    return null;
  }
  let bytes: Uint8Array;
  try {
    bytes = await readBoundedFormPackageStream(
      object.body,
      FORM_PACKAGE_LIMITS.definitionBytes,
      declaration.size,
    );
  } catch (error) {
    if (error instanceof FormPackageStreamLimitError) return null;
    throw error;
  }
  if ((await bytesDigest(bytes)) !== declaration.digest) return null;
  const definition: ReadOnlyFormPackageFile = {
    path: declaration.path,
    digest: declaration.digest,
    size: declaration.size,
    ...(declaration.mediaType === undefined ? {} : { mediaType: declaration.mediaType }),
    bytes,
  };
  return {
    packageDigest,
    formRef: structuredClone(index.formRef),
    prefix: index.prefix,
    manifest: structuredClone(index.manifest),
    definition,
  };
}

interface PackageIndex {
  readonly prefix: string;
  readonly manifest: JsonObject;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly declarations: readonly PackageFileDeclaration[];
}

interface PackageFileDeclaration {
  readonly path: string;
  readonly digest: FormPackageDigest;
  readonly size: number;
  readonly mediaType?: string;
}

/** Parses and validates the index before opening any payload object. */
async function readPackageIndex(
  objects: Pick<ObjectStoreAccess, "get" | "list">,
  packageDigest: FormPackageDigest,
  expectedFormRef?: TakoformV1Alpha3FormRef,
): Promise<PackageIndex | null> {
  const prefix = readOnlyFormPackagePrefix(packageDigest);
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
  if (
    (await canonicalDigest(manifest)) !== packageDigest ||
    !validateManifestEnvelope(manifest) ||
    !validateManifestMetadata(manifest)
  ) {
    return null;
  }
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
  if (
    manifest.definitionPath !== undefined &&
    (typeof manifest.definitionPath !== "string" ||
      !isSafeManifestPath(manifest.definitionPath) ||
      manifest.definitionPath === "package-index.json")
  ) {
    return null;
  }
  const parsedDeclarations: PackageFileDeclaration[] = [];
  const seen = new Set<string>();
  let declaredPayloadBytes = 0;
  for (const value of declarations) {
    if (!isJsonObject(value) || !exactFileKeys(value)) return null;
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
    const limit = formPackagePayloadLimit(
      typeof value.mediaType === "string" ? value.mediaType : undefined,
    );
    if (size > limit || size > FORM_PACKAGE_LIMITS.packagePayloadBytes - declaredPayloadBytes) {
      return null;
    }
    declaredPayloadBytes += size;
    let safePath: string;
    try {
      safePath = validateRelativePath(path);
    } catch {
      return null;
    }
    if (safePath === "package-index.json" || seen.has(safePath)) return null;
    seen.add(safePath);
    parsedDeclarations.push({
      path: safePath,
      digest,
      size,
      ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
    });
  }
  if (
    typeof manifest.definitionPath === "string" &&
    !parsedDeclarations.some((candidate) => candidate.path === manifest.definitionPath)
  ) {
    return null;
  }
  return { prefix, manifest, formRef, declarations: parsedDeclarations };
}

const FORM_PACKAGE_FILE_READ_CONCURRENCY = 16;

/** Reads declared payloads in bounded waves while retaining declaration order. */
async function readDeclaredFiles(
  objects: Pick<ObjectStoreAccess, "get" | "list">,
  packageDigest: FormPackageDigest,
  declarations: readonly PackageFileDeclaration[],
): Promise<ReadOnlyFormPackageFile[] | null> {
  const results = await mapBounded(
    declarations,
    FORM_PACKAGE_FILE_READ_CONCURRENCY,
    async (declaration): Promise<ReadOnlyFormPackageFile | null> => {
      const object = await objects.get(readOnlyFormPackageKey(packageDigest, declaration.path));
      if (!object) return null;
      const limit = formPackagePayloadLimit(declaration.mediaType);
      if (!validObjectSize(object.size) || object.size > limit) {
        cancelFormPackageStream(object.body);
        return null;
      }
      let bytes: Uint8Array;
      try {
        bytes = await readBoundedFormPackageStream(object.body, limit, declaration.size);
      } catch (error) {
        if (error instanceof FormPackageStreamLimitError) return null;
        throw error;
      }
      if ((await bytesDigest(bytes)) !== declaration.digest) return null;
      return {
        path: declaration.path,
        digest: declaration.digest,
        size: declaration.size,
        ...(declaration.mediaType === undefined ? {} : { mediaType: declaration.mediaType }),
        bytes,
      };
    },
    { stopOnNull: true },
  );
  return results.every(
    (value): value is ReadOnlyFormPackageFile => value !== undefined && value !== null,
  )
    ? results
    : null;
}

async function mapBounded<T, R>(
  input: readonly T[],
  concurrency: number,
  map: (value: T, index: number) => Promise<R>,
  options: { readonly stopOnNull?: boolean } = {},
): Promise<R[]> {
  if (input.length === 0) return [];
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
    throw new TypeError("concurrency must be a positive integer");
  }
  const output = Array<R>(input.length);
  let next = 0;
  let stopped = false;
  let failed = false;
  let firstError: unknown;
  const worker = async (): Promise<void> => {
    while (true) {
      if (stopped) return;
      const index = next;
      next += 1;
      if (index >= input.length) return;
      const value = input[index];
      if (value === undefined) return;
      try {
        const mapped = await map(value, index);
        output[index] = mapped;
        // `readDeclaredFiles` uses null as a fail-closed sentinel. Stop
        // assigning later work once one payload has failed, while allowing
        // the already launched bounded wave to settle.
        if (options.stopOnNull && mapped === null) stopped = true;
      } catch (error) {
        if (!failed) {
          failed = true;
          firstError = error;
        }
        stopped = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, () => worker()));
  if (failed) throw firstError;
  return output;
}

function validateManifest(
  value: JsonObject,
  expectedFormRef: TakoformV1Alpha3FormRef,
  files: readonly ReadOnlyFormPackageFile[],
): boolean {
  if (!validateManifestEnvelope(value)) return false;
  if (!validateManifestMetadata(value)) return false;
  if (
    ![
      "packages.forms.takoform.com/v1alpha1",
      "packages.forms.takoform.com/v1alpha2",
      "packages.forms.takoform.com/v1alpha3",
      "packages.forms.takoform.com/v1alpha4",
      "packages.forms.takoform.com/v1alpha5",
    ].includes(String(value.apiVersion)) ||
    value.kind !== "FormPackage" ||
    !isFormRef(value.formRef) ||
    canonicalJson(value.formRef) !== canonicalJson(expectedFormRef)
  ) {
    return false;
  }
  if (!Array.isArray(value.files) || value.files.length !== files.length) return false;
  const byPath = new Map(files.map((file) => [file.path, file]));
  for (const declaration of value.files) {
    if (!isJsonObject(declaration) || !exactFileKeys(declaration)) return false;
    const expected =
      typeof declaration.path === "string" ? byPath.get(declaration.path) : undefined;
    if (
      !expected ||
      declaration.digest !== expected.digest ||
      declaration.size !== expected.size ||
      declaration.mediaType !== expected.mediaType
    ) {
      return false;
    }
  }
  const definitionPath = value.definitionPath;
  return (
    definitionPath === undefined ||
    (typeof definitionPath === "string" && byPath.has(definitionPath))
  );
}

function validateManifestMetadata(value: JsonObject): boolean {
  if (
    !SUPPORTED_PACKAGE_API_VERSIONS.has(String(value.apiVersion)) ||
    (value.packageVersion !== undefined &&
      (typeof value.packageVersion !== "string" ||
        value.packageVersion.length === 0 ||
        value.packageVersion.length > 128))
  ) {
    return false;
  }
  const definitionPath = value.definitionPath;
  return (
    definitionPath === undefined ||
    (typeof definitionPath === "string" &&
      isSafeManifestPath(definitionPath) &&
      definitionPath !== "package-index.json")
  );
}

function validateManifestEnvelope(value: JsonObject): boolean {
  const keys = Object.keys(value);
  const allowed = new Set([
    "apiVersion",
    "definitionPath",
    "files",
    "formRef",
    "kind",
    "packageVersion",
  ]);
  return (
    keys.length >= 4 &&
    keys.length <= allowed.size &&
    keys.every((key) => allowed.has(key)) &&
    typeof value.apiVersion === "string" &&
    value.kind === "FormPackage" &&
    isJsonObject(value.formRef) &&
    Array.isArray(value.files)
  );
}

function exactFileKeys(value: JsonObject): boolean {
  const keys = Object.keys(value);
  const allowed = new Set(["digest", "mediaType", "path", "size"]);
  return (
    keys.length >= 3 &&
    keys.length <= 4 &&
    keys.every((key) => allowed.has(key)) &&
    keys.includes("digest") &&
    keys.includes("path") &&
    keys.includes("size")
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
  if (!isSha256Digest(value)) throw new FormPackageReadError("invalid_package", "invalid digest");
}

function validObjectSize(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validateRelativePath(value: string): string {
  if (!isSafeManifestPath(value)) {
    throw new FormPackageReadError("invalid_package", "invalid package path");
  }
  return value;
}

function validateFormRefShape(value: TakoformV1Alpha3FormRef): void {
  if (!isFormRef(value)) throw new FormPackageReadError("invalid_package", "invalid FormRef");
}

function isFormRef(value: unknown): value is TakoformV1Alpha3FormRef {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value).sort();
  if (
    keys.length !== 4 ||
    keys[0] !== "apiVersion" ||
    keys[1] !== "definitionVersion" ||
    keys[2] !== "kind" ||
    keys[3] !== "schemaDigest"
  ) {
    return false;
  }
  try {
    validateFormRef(value as unknown as TakoformV1Alpha3FormRef);
    return true;
  } catch {
    return false;
  }
}

const ALLOWED_MEDIA_TYPES = new Set([
  "application/vnd.takoform.form-definition.v1+json",
  "application/schema+json",
  "application/json",
  "text/markdown",
  "text/plain",
]);

const SUPPORTED_PACKAGE_API_VERSIONS = new Set([
  "packages.forms.takoform.com/v1alpha1",
  "packages.forms.takoform.com/v1alpha2",
  "packages.forms.takoform.com/v1alpha3",
  "packages.forms.takoform.com/v1alpha4",
  "packages.forms.takoform.com/v1alpha5",
]);
