import type { TakoformV1Alpha3FormRef } from "../form-ref.ts";
import {
  bytesDigest,
  canonicalDigest,
  canonicalJson,
  isJsonObject,
  isSha256Digest,
} from "../json.ts";
import type { JsonObject, ObjectStore } from "../ports.ts";
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

/** The public runtime gets only exact readback; package writes stay private. */
export interface FormPackageReader {
  read(input: {
    readonly packageDigest: FormPackageDigest;
    readonly formRef?: TakoformV1Alpha3FormRef;
  }): Promise<ReadOnlyStoredFormPackage | null>;
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

export function createFormPackageReader(objects: Pick<ObjectStore, "get">): FormPackageReader {
  if (!objects || typeof objects.get !== "function") {
    throw new FormPackageReadError("package_store_unavailable", "an object reader is required");
  }
  return {
    async read(input): Promise<ReadOnlyStoredFormPackage | null> {
      requireDigest(input.packageDigest);
      if (input.formRef !== undefined) validateFormRefShape(input.formRef);
      return await readPackage(objects, input.packageDigest, input.formRef);
    },
  };
}

async function readPackage(
  objects: Pick<ObjectStore, "get">,
  packageDigest: FormPackageDigest,
  expectedFormRef?: TakoformV1Alpha3FormRef,
): Promise<ReadOnlyStoredFormPackage | null> {
  const prefix = readOnlyFormPackagePrefix(packageDigest);
  const index = await objects.get(`${prefix}/package-index.json`);
  if (!index) return null;
  const indexBytes = new Uint8Array(await new Response(index.body).arrayBuffer());
  let manifest: JsonObject;
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(indexBytes));
    if (!isJsonObject(parsed)) return null;
    manifest = parsed;
  } catch {
    return null;
  }
  if ((await canonicalDigest(manifest)) !== packageDigest || !validateManifestEnvelope(manifest)) {
    return null;
  }
  const formRef = manifest.formRef;
  if (!isFormRef(formRef)) return null;
  if (expectedFormRef && canonicalJson(formRef) !== canonicalJson(expectedFormRef)) return null;

  const declarations = manifest.files;
  if (!Array.isArray(declarations) || declarations.length === 0) return null;
  const files: ReadOnlyFormPackageFile[] = [];
  const seen = new Set<string>();
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
    let safePath: string;
    try {
      safePath = validateRelativePath(path);
    } catch {
      return null;
    }
    if (safePath === "package-index.json" || seen.has(safePath)) return null;
    seen.add(safePath);
    const object = await objects.get(readOnlyFormPackageKey(packageDigest, safePath));
    if (!object) return null;
    const bytes = new Uint8Array(await new Response(object.body).arrayBuffer());
    if (bytes.byteLength !== size || (await bytesDigest(bytes)) !== digest) return null;
    files.push({
      path: safePath,
      digest,
      size,
      ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
      bytes,
    });
  }
  files.sort((left, right) => left.path.localeCompare(right.path));
  if (!validateManifest(manifest, formRef, files)) return null;

  return {
    packageDigest,
    formRef: structuredClone(formRef),
    prefix,
    manifest: structuredClone(manifest),
    files,
  };
}

function validateManifest(
  value: JsonObject,
  expectedFormRef: TakoformV1Alpha3FormRef,
  files: readonly ReadOnlyFormPackageFile[],
): boolean {
  if (!validateManifestEnvelope(value)) return false;
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
  if (
    value.packageVersion !== undefined &&
    (typeof value.packageVersion !== "string" ||
      value.packageVersion.length === 0 ||
      value.packageVersion.length > 128)
  ) {
    return false;
  }
  if (
    value.definitionPath !== undefined &&
    (typeof value.definitionPath !== "string" ||
      !isSafeManifestPath(value.definitionPath) ||
      value.definitionPath === "package-index.json")
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
  return value.definitionPath === undefined || byPath.has(value.definitionPath);
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
