import { execFileSync } from "node:child_process";
import { lstat, open, opendir } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { bytesDigest, canonicalDigest } from "../json.ts";
import type { JsonObject } from "../ports.ts";
import {
  FORM_PACKAGE_LIMITS,
  formPackagePayloadLimit,
  formPackagePayloadTotal,
} from "./form-package-limits.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformOperation,
} from "./types.ts";

/**
 * The only source identity that may feed the generated stable catalog.
 *
 * The publisher's Git commit is unsigned provenance. This loader does not
 * turn it into a trust, admission, or Host-support assertion; it only makes
 * the public unsigned package corpus reproducible before generation.
 */
export const CURRENT_PUBLISHER_REPOSITORY =
  "https://github.com/tako0614/takoform-forms.git" as const;
export const CURRENT_PUBLISHER_COMMIT = "026f862975b9adb0e2bfd9c6214a5e6691dfb596" as const;
export const CURRENT_PUBLISHER_FAMILY_INDEX_SHA256 =
  "c3c59a01fb90ab967c3765ff1dd15ca4af4062cba9b38c0a3b97a168822ffb32" as const;
export const CURRENT_PUBLISHER_FAMILY_CONFORMANCE_SHA256 =
  "9c7288fe103584922fb481dc6af2f1d70e0fb7b48aa3389bf817bf5626f1c873" as const;
export const CURRENT_PUBLISHER_FAMILY_CANDIDATE_SET_SHA256 =
  "8e8599ca3896946dc5ac4e609ce7652f21631bd5e38dddc026db7a3febadf2f8" as const;
export const CURRENT_PUBLISHER_INTERFACE_SET_SHA256 =
  "9d15d44047369cf7866c4570293e4f40f346873eb646d82f676a3b411156ba2b" as const;
export const CURRENT_PUBLISHER_BINDING_SET_SHA256 =
  "e3b4aa31d5f9f7b7f31ff70f5f805a9354abf3ccd5555cc457e2e7c395224143" as const;
export const CURRENT_PUBLISHER_FAMILY = "edge.forms.takoform.com" as const;
export const CURRENT_PUBLISHER_COUNTS = {
  familyCount: 1,
  formCount: 16,
  interfaceCount: 7,
  bindingCount: 6,
} as const;

const FAMILY_INDEX = "forms/candidates/current-family-index.json";
const FAMILY_CONFORMANCE = "conformance/takoform-v1/families/edge.forms.takoform.com.json";
const FAMILY_CANDIDATE_SET = "forms/candidates/edge.forms.takoform.com/candidate-set.json";
const INTERFACE_CANDIDATE_SET = "interfaces/candidates/v1alpha1/candidate-set.json";
const BINDING_CANDIDATE_SET = "bindings/candidates/v1alpha2/candidate-set.json";

/**
 * Bounds for walking the current publisher's checked-in Git corpus.
 *
 * These are publisher-source complexity limits, not additional Form Package
 * validity rules. A package contains one package index plus at most the Core
 * limit of 1,024 declared payload files. Directories are counted separately
 * so a valid maximum package may put every payload beneath one directory,
 * while a pathological tree with more than 1,024 directories still fails
 * closed before it can be fully materialized.
 */
export const CURRENT_PUBLISHER_PACKAGE_FILE_ENTRY_LIMIT = FORM_PACKAGE_LIMITS.files + 1;
export const CURRENT_PUBLISHER_PACKAGE_DIRECTORY_ENTRY_LIMIT = FORM_PACKAGE_LIMITS.files;
/** Raw entries examined by a non-recursive catalog directory scan. */
export const CURRENT_PUBLISHER_DIRECTORY_SCAN_ENTRY_LIMIT =
  CURRENT_PUBLISHER_PACKAGE_FILE_ENTRY_LIMIT;

export function isCurrentPublisherPackageWithinTraversalBounds(
  fileCount: number,
  directoryCount: number,
): boolean {
  return (
    Number.isSafeInteger(fileCount) &&
    fileCount >= 0 &&
    fileCount <= CURRENT_PUBLISHER_PACKAGE_FILE_ENTRY_LIMIT &&
    Number.isSafeInteger(directoryCount) &&
    directoryCount >= 0 &&
    directoryCount <= CURRENT_PUBLISHER_PACKAGE_DIRECTORY_ENTRY_LIMIT
  );
}

export interface CurrentPublisherCatalog {
  readonly forms: readonly InstalledTakoformForm[];
  readonly bindings: readonly InstalledTakoformBinding[];
  readonly provenance: {
    readonly classification: "public-unsigned-package-corpus";
    readonly repository: typeof CURRENT_PUBLISHER_REPOSITORY;
    readonly commit: typeof CURRENT_PUBLISHER_COMMIT;
    /** Git tags are provenance only; this publisher has no signature claim. */
    readonly gitTags: "unsigned";
    readonly sigstoreBundle: null;
    readonly familyIndexSha256: `sha256:${typeof CURRENT_PUBLISHER_FAMILY_INDEX_SHA256}`;
    readonly familyConformanceSha256: `sha256:${typeof CURRENT_PUBLISHER_FAMILY_CONFORMANCE_SHA256}`;
    readonly interfaceCandidateSetSha256: `sha256:${typeof CURRENT_PUBLISHER_INTERFACE_SET_SHA256}`;
    readonly bindingCandidateSetSha256: `sha256:${typeof CURRENT_PUBLISHER_BINDING_SET_SHA256}`;
    readonly familyCount: typeof CURRENT_PUBLISHER_COUNTS.familyCount;
    readonly formCount: typeof CURRENT_PUBLISHER_COUNTS.formCount;
    readonly interfaceCount: typeof CURRENT_PUBLISHER_COUNTS.interfaceCount;
    readonly bindingCount: typeof CURRENT_PUBLISHER_COUNTS.bindingCount;
  };
}

interface CurrentPublisherCatalogLoadOptions {
  /** Deterministic test seam for racing a package closure during payload reads. */
  readonly afterPackagePayloadRead?: (packageRoot: string) => void | Promise<void>;
}

/**
 * Load the exact current publisher corpus for generation of the stable
 * production catalog. Every input is deleted-first: only the one family and
 * its package paths named by the current-family index are considered, and all
 * package release paths are required to match those candidates.
 */
export async function loadCurrentPublisherCatalog(
  repositoryRoot: string,
  options: CurrentPublisherCatalogLoadOptions = {},
): Promise<CurrentPublisherCatalog> {
  const root = resolve(repositoryRoot);
  assertPublisherSource(root);

  const indexBytes = await requiredBytes(root, FAMILY_INDEX, FORM_PACKAGE_LIMITS.indexBytes);
  if (
    (await bytesDigest(indexBytes)).slice("sha256:".length) !==
    CURRENT_PUBLISHER_FAMILY_INDEX_SHA256
  ) {
    mismatch();
  }
  const index = object(parse(indexBytes));
  if (index.format !== "takoform.current-family-index@v1") mismatch();

  const familyValues = array(index.families);
  if (familyValues.length !== CURRENT_PUBLISHER_COUNTS.familyCount) incomplete();
  const family = object(familyValues[0]);
  if (
    family.group !== CURRENT_PUBLISHER_FAMILY ||
    family.candidateSet !== FAMILY_CANDIDATE_SET ||
    family.sha256 !== CURRENT_PUBLISHER_FAMILY_CANDIDATE_SET_SHA256 ||
    family.formCount !== CURRENT_PUBLISHER_COUNTS.formCount
  ) {
    mismatch();
  }

  const conformanceBytes = await requiredBytes(
    root,
    FAMILY_CONFORMANCE,
    FORM_PACKAGE_LIMITS.indexBytes,
  );
  if (
    (await bytesDigest(conformanceBytes)).slice("sha256:".length) !==
    CURRENT_PUBLISHER_FAMILY_CONFORMANCE_SHA256
  ) {
    mismatch();
  }
  const conformance = object(parse(conformanceBytes));
  const conformanceCandidateSet = object(conformance.candidateSet);
  if (
    conformance.format !== "takoform.family-semantic-corpus@v1" ||
    conformance.hostApiLane !== "forms.takoform.com/v1" ||
    conformance.group !== CURRENT_PUBLISHER_FAMILY ||
    conformanceCandidateSet.path !== FAMILY_CANDIDATE_SET ||
    conformanceCandidateSet.sha256 !== CURRENT_PUBLISHER_FAMILY_CANDIDATE_SET_SHA256
  ) {
    mismatch();
  }

  const candidateBytes = await requiredBytes(
    root,
    FAMILY_CANDIDATE_SET,
    FORM_PACKAGE_LIMITS.indexBytes,
  );
  if (
    (await bytesDigest(candidateBytes)).slice("sha256:".length) !==
    CURRENT_PUBLISHER_FAMILY_CANDIDATE_SET_SHA256
  ) {
    mismatch();
  }
  const candidateSet = object(parse(candidateBytes));
  if (candidateSet.family !== CURRENT_PUBLISHER_FAMILY) mismatch();
  const candidateEntries = array(candidateSet.forms);
  if (candidateEntries.length !== CURRENT_PUBLISHER_COUNTS.formCount) incomplete();

  const forms = await loadPackageForms(root, candidateEntries, options.afterPackagePayloadRead);
  if (forms.length !== CURRENT_PUBLISHER_COUNTS.formCount) incomplete();

  const interfaceRef = object(index.interfaceCandidateSet);
  if (
    interfaceRef.path !== INTERFACE_CANDIDATE_SET ||
    interfaceRef.sha256 !== CURRENT_PUBLISHER_INTERFACE_SET_SHA256
  ) {
    mismatch();
  }
  const interfaces = await loadInterfaces(root, INTERFACE_CANDIDATE_SET);
  if (interfaces !== CURRENT_PUBLISHER_COUNTS.interfaceCount) incomplete();

  const bindingRef = object(index.bindingCandidateSet);
  if (
    bindingRef.path !== BINDING_CANDIDATE_SET ||
    bindingRef.sha256 !== CURRENT_PUBLISHER_BINDING_SET_SHA256
  ) {
    mismatch();
  }
  const bindings = await loadBindings(root, BINDING_CANDIDATE_SET, forms);
  if (bindings.length !== CURRENT_PUBLISHER_COUNTS.bindingCount) incomplete();

  return {
    forms,
    bindings,
    provenance: {
      classification: "public-unsigned-package-corpus",
      repository: CURRENT_PUBLISHER_REPOSITORY,
      commit: CURRENT_PUBLISHER_COMMIT,
      gitTags: "unsigned",
      sigstoreBundle: null,
      familyIndexSha256: `sha256:${CURRENT_PUBLISHER_FAMILY_INDEX_SHA256}`,
      familyConformanceSha256: `sha256:${CURRENT_PUBLISHER_FAMILY_CONFORMANCE_SHA256}`,
      interfaceCandidateSetSha256: `sha256:${CURRENT_PUBLISHER_INTERFACE_SET_SHA256}`,
      bindingCandidateSetSha256: `sha256:${CURRENT_PUBLISHER_BINDING_SET_SHA256}`,
      familyCount: CURRENT_PUBLISHER_COUNTS.familyCount,
      formCount: CURRENT_PUBLISHER_COUNTS.formCount,
      interfaceCount: CURRENT_PUBLISHER_COUNTS.interfaceCount,
      bindingCount: CURRENT_PUBLISHER_COUNTS.bindingCount,
    },
  };
}

async function loadPackageForms(
  root: string,
  candidateValues: readonly unknown[],
  afterPackagePayloadRead?: (packageRoot: string) => void | Promise<void>,
): Promise<InstalledTakoformForm[]> {
  const forms: InstalledTakoformForm[] = [];
  const seenKinds = new Set<string>();
  for (const candidateValue of candidateValues) {
    const candidate = object(candidateValue);
    const ref = object(candidate.formRef);
    const apiVersion = string(ref.apiVersion);
    const kind = string(ref.kind);
    const definitionVersion = string(ref.definitionVersion);
    const schemaDigest = digest(ref.schemaDigest);
    const packageDigest = digest(candidate.packageDigest);
    const packageRoot = string(candidate.path);
    if (
      apiVersion !== CURRENT_PUBLISHER_FAMILY ||
      !/^forms\/candidates\/edge\.forms\.takoform\.com\/[A-Za-z0-9._-]+$/u.test(packageRoot) ||
      seenKinds.has(kind)
    ) {
      mismatch();
    }
    seenKinds.add(kind);

    const candidateIndexBytes = await requiredBytes(
      root,
      `${packageRoot}/package-index.json`,
      FORM_PACKAGE_LIMITS.indexBytes,
    );
    const candidateIndex = object(parse(candidateIndexBytes));
    await validatePackageIndex(candidateIndex, ref, packageDigest);
    await validatePackageFiles(root, packageRoot, candidateIndex, afterPackagePayloadRead);

    const releaseRoot = `forms/releases/${releaseId(apiVersion, kind)}/${packageDigest.replace(
      "sha256:",
      "sha256-",
    )}`;
    const releaseIndexBytes = await requiredBytes(
      root,
      `${releaseRoot}/package-index.json`,
      FORM_PACKAGE_LIMITS.indexBytes,
    );
    const releaseIndex = object(parse(releaseIndexBytes));
    await validatePackageIndex(releaseIndex, ref, packageDigest);
    await validatePackageFiles(root, releaseRoot, releaseIndex, afterPackagePayloadRead);

    const definitionPath = string(releaseIndex.definitionPath);
    const definitionDeclaration = array(releaseIndex.files)
      .map(object)
      .find((file) => file.path === definitionPath);
    const definition = object(
      parse(
        await requiredBytes(
          root,
          `${releaseRoot}/${definitionPath}`,
          formPackagePayloadLimit(
            typeof definitionDeclaration?.mediaType === "string"
              ? definitionDeclaration.mediaType
              : undefined,
          ),
        ),
      ),
    );
    if (
      definition.apiVersion !== apiVersion ||
      definition.kind !== kind ||
      definition.definitionVersion !== definitionVersion ||
      (await canonicalDigest(definition)) !== schemaDigest
    ) {
      mismatch();
    }
    forms.push(installedForm(definition, ref, packageDigest));
  }

  // A stale release directory must not silently survive deletion of a Form.
  const releaseDirectories = await directories(root, "forms/releases");
  if (releaseDirectories.length !== CURRENT_PUBLISHER_COUNTS.formCount) incomplete();
  if (forms.some((form) => form.identity.formRef.apiVersion !== CURRENT_PUBLISHER_FAMILY)) {
    mismatch();
  }
  return forms;
}

async function loadInterfaces(root: string, relative: string): Promise<number> {
  const bytes = await requiredBytes(root, relative, FORM_PACKAGE_LIMITS.indexBytes);
  if (
    (await bytesDigest(bytes)).slice("sha256:".length) !== CURRENT_PUBLISHER_INTERFACE_SET_SHA256
  ) {
    mismatch();
  }
  const set = object(parse(bytes));
  if (set.format !== "takoform.interface-candidates@v1") mismatch();
  const entries = array(set.interfaces);
  const seen = new Set<string>();
  for (const value of entries) {
    const entry = object(value);
    const name = string(entry.name);
    const version = string(entry.version);
    const schemaDigest = digest(entry.schemaDigest);
    const key = `${name}\0${version}`;
    if (seen.has(key)) mismatch();
    seen.add(key);
    const definition = object(
      parse(
        await requiredBytes(
          root,
          `interfaces/candidates/v1alpha1/${name}/definition.json`,
          FORM_PACKAGE_LIMITS.jsonPayloadBytes,
        ),
      ),
    );
    if (
      definition.apiVersion !== "interfaces.takoform.com/v1alpha1" ||
      definition.kind !== "InterfaceDefinition" ||
      definition.name !== name ||
      definition.version !== version ||
      (await canonicalDigest(definition)) !== schemaDigest
    ) {
      mismatch();
    }
  }
  if (entries.length !== CURRENT_PUBLISHER_COUNTS.interfaceCount) incomplete();
  return entries.length;
}

async function loadBindings(
  root: string,
  relative: string,
  forms: readonly InstalledTakoformForm[],
): Promise<InstalledTakoformBinding[]> {
  const bytes = await requiredBytes(root, relative, FORM_PACKAGE_LIMITS.indexBytes);
  if ((await bytesDigest(bytes)).slice("sha256:".length) !== CURRENT_PUBLISHER_BINDING_SET_SHA256) {
    mismatch();
  }
  const set = object(parse(bytes));
  if (set.format !== "takoform.binding-candidates@v1") mismatch();
  const entries = array(set.bindings);
  const accepted = forms.flatMap((form) => form.acceptedBindings ?? []);
  const bindings: InstalledTakoformBinding[] = [];
  const seen = new Set<string>();
  for (const value of entries) {
    const entry = object(value);
    const name = string(entry.name);
    const version = string(entry.version);
    const schemaDigest = digest(entry.schemaDigest);
    const key = `${name}\0${version}`;
    if (seen.has(key)) mismatch();
    seen.add(key);
    const definition = object(
      parse(
        await requiredBytes(
          root,
          `bindings/candidates/v1alpha2/${name}/definition.json`,
          FORM_PACKAGE_LIMITS.jsonPayloadBytes,
        ),
      ),
    );
    const ref = accepted.find(
      (candidate) =>
        candidate.name === name &&
        candidate.version === version &&
        candidate.schemaDigest === schemaDigest,
    );
    if (
      definition.apiVersion !== "bindings.takoform.com/v1alpha2" ||
      definition.kind !== "BindingDefinition" ||
      definition.name !== name ||
      definition.version !== version ||
      !ref ||
      (await canonicalDigest(definition)) !== schemaDigest ||
      !["identity", "revision", "deployment", "attachment", "policy"].includes(
        string(definition.sourceRole),
      ) ||
      !isObject(definition.targetInterface) ||
      !Array.isArray(definition.allowedTargetForms)
    ) {
      mismatch();
    }
    bindings.push({
      bindingRef: structuredClone(ref),
      sourceRole: definition.sourceRole as InstalledTakoformBinding["sourceRole"],
      targetInterface: structuredClone(
        definition.targetInterface,
      ) as unknown as InstalledTakoformBinding["targetInterface"],
      allowedTargetForms: structuredClone(
        definition.allowedTargetForms,
      ) as InstalledTakoformBinding["allowedTargetForms"],
    });
  }
  if (
    entries.length !== CURRENT_PUBLISHER_COUNTS.bindingCount ||
    bindings.length !== accepted.length
  ) {
    incomplete();
  }
  return bindings;
}

async function validatePackageIndex(
  packageIndex: Record<string, unknown>,
  ref: Record<string, unknown>,
  packageDigest: `sha256:${string}`,
): Promise<void> {
  const packageRef = object(packageIndex.formRef);
  if (
    packageIndex.apiVersion !== "packages.forms.takoform.com/v1alpha5" ||
    packageIndex.kind !== "FormPackage" ||
    packageRef.apiVersion !== ref.apiVersion ||
    packageRef.kind !== ref.kind ||
    packageRef.definitionVersion !== ref.definitionVersion ||
    packageRef.schemaDigest !== ref.schemaDigest ||
    typeof packageIndex.definitionPath !== "string" ||
    !Array.isArray(packageIndex.files)
  ) {
    mismatch();
  }
  if (formPackagePayloadTotal(packageIndex.files) === null) mismatch();
  if ((await canonicalDigest(packageIndex)) !== packageDigest) mismatch();
}

async function validatePackageFiles(
  root: string,
  packageRoot: string,
  packageIndex: Record<string, unknown>,
  afterPackagePayloadRead?: (packageRoot: string) => void | Promise<void>,
): Promise<void> {
  const declarations = array(packageIndex.files);
  const actual = await inventoryPackageFiles(root, packageRoot);
  const expected = new Set(["package-index.json"]);
  if (declarations.length > FORM_PACKAGE_LIMITS.files) mismatch();
  for (const value of declarations) {
    const file = object(value);
    const relative = string(file.path);
    if (
      !isSafePackagePath(relative) ||
      relative === "package-index.json" ||
      expected.has(relative)
    ) {
      mismatch();
    }
    expected.add(relative);
  }
  if (actual.length !== expected.size || actual.some((path) => !expected.has(path))) mismatch();
  for (const value of declarations) {
    const file = object(value);
    const relative = string(file.path);
    const bytes = await requiredBytes(
      root,
      `${packageRoot}/${relative}`,
      formPackagePayloadLimit(typeof file.mediaType === "string" ? file.mediaType : undefined),
    );
    if (bytes.byteLength !== number(file.size) || (await bytesDigest(bytes)) !== file.digest) {
      mismatch();
    }
  }
  if (afterPackagePayloadRead) await afterPackagePayloadRead(packageRoot);
  const finalActual = await inventoryPackageFiles(root, packageRoot);
  if (finalActual.length !== expected.size || finalActual.some((path) => !expected.has(path))) {
    mismatch();
  }
}

function installedForm(
  definition: Record<string, unknown>,
  ref: Record<string, unknown>,
  packageDigest: `sha256:${string}`,
): InstalledTakoformForm {
  const operations = array(definition.lifecycleCapabilities).map(string);
  if (
    !operations.every((operation) =>
      ["create", "read", "update", "delete", "import", "observe"].includes(operation),
    )
  ) {
    mismatch();
  }
  return {
    identity: {
      formRef: {
        apiVersion: string(ref.apiVersion),
        kind: string(ref.kind),
        definitionVersion: string(ref.definitionVersion),
        schemaDigest: digest(ref.schemaDigest),
      },
      packageDigest,
    },
    ...(typeof definition.title === "string" ? { displayName: definition.title } : {}),
    ...(typeof definition.description === "string" ? { description: definition.description } : {}),
    ...(typeof definition.requiresHostApi === "string"
      ? { requiresHostApi: definition.requiresHostApi }
      : {}),
    ...(typeof definition.role === "string"
      ? { role: definition.role as NonNullable<InstalledTakoformForm["role"]> }
      : {}),
    ...(Array.isArray(definition.constraints)
      ? { constraints: structuredClone(definition.constraints) as never }
      : {}),
    ...(Array.isArray(definition.providedInterfaces)
      ? { providedInterfaces: structuredClone(definition.providedInterfaces) as never }
      : {}),
    ...(Array.isArray(definition.acceptedBindings)
      ? { acceptedBindings: structuredClone(definition.acceptedBindings) as never }
      : {}),
    desiredSchema: object(definition.desiredSchema) as JsonObject,
    ...(isObject(definition.observedSchema)
      ? { observedSchema: structuredClone(definition.observedSchema) as JsonObject }
      : {}),
    ...(isObject(definition.outputSchema)
      ? { outputSchema: structuredClone(definition.outputSchema) as JsonObject }
      : {}),
    operations: operations as TakoformOperation[],
    ...artifactRequirement(string(ref.kind)),
    ...workerClassRuntime(string(ref.kind), definition),
  };
}

function artifactRequirement(
  kind: string,
): Pick<InstalledTakoformForm, "artifactRequirement"> | object {
  if (kind === "WorkerBundle") {
    return { artifactRequirement: { specField: "manifestDigest", kind: "WorkerBundle" } };
  }
  if (kind === "StaticAssetBundle") {
    return { artifactRequirement: { specField: "manifestDigest", kind: "StaticAssetBundle" } };
  }
  if (kind === "SQLiteMigrationSet") {
    return { artifactRequirement: { specField: "manifestDigest", kind: "MigrationBundle" } };
  }
  return {};
}

function workerClassRuntime(
  kind: string,
  definition: Record<string, unknown>,
): Pick<InstalledTakoformForm, "workerClassRuntime"> | object {
  const interfaceName =
    kind === "ActorNamespace"
      ? "worker.actor"
      : kind === "DurableWorkflow"
        ? "worker.workflow"
        : undefined;
  if (!interfaceName) return {};
  const provided = Array.isArray(definition.providedInterfaces)
    ? definition.providedInterfaces.some(
        (candidate) =>
          isObject(candidate) &&
          candidate.apiVersion === "interfaces.takoform.com/v1alpha1" &&
          candidate.name === interfaceName,
      )
    : false;
  if (!provided) mismatch();
  return {
    workerClassRuntime: {
      providedInterface: interfaceName,
      className: "/className",
      workerRelation: "/worker",
      deploymentForm: { apiVersion: CURRENT_PUBLISHER_FAMILY, kind: "WorkerDeployment" },
      deploymentWorkerRelation: "/worker",
      deploymentVersionRelation: "/versions/*/workerVersion",
      versionBundleRelation: "/bundle",
    },
  };
}

function assertPublisherSource(root: string): void {
  let commit: string;
  let repository: string;
  try {
    commit = git(root, "rev-parse", "HEAD");
    repository = normalizeRepository(git(root, "remote", "get-url", "origin"));
  } catch {
    throw new Error("current_publisher_source_identity_unavailable");
  }
  if (commit !== CURRENT_PUBLISHER_COMMIT || repository !== CURRENT_PUBLISHER_REPOSITORY) {
    throw new Error("current_publisher_source_identity_drifted");
  }
  let status: string;
  try {
    status = git(root, "status", "--porcelain", "--untracked-files=all");
  } catch {
    throw new Error("current_publisher_source_identity_unavailable");
  }
  if (status !== "") throw new Error("current_publisher_source_dirty");
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function normalizeRepository(value: string): string {
  if (value === "git@github.com:tako0614/takoform-forms.git") {
    return CURRENT_PUBLISHER_REPOSITORY;
  }
  return value;
}

function releaseId(group: string, kind: string): string {
  const bytes = new TextEncoder().encode(`${group}/${kind}`);
  let output = "";
  let buffer = 0;
  let bits = 0;
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += "abcdefghijklmnopqrstuvwxyz234567"[(buffer >> bits) & 31];
    }
  }
  if (bits > 0) output += "abcdefghijklmnopqrstuvwxyz234567"[(buffer << (5 - bits)) & 31];
  return `k-${output}`;
}

async function directories(root: string, relative: string): Promise<string[]> {
  let directory: Awaited<ReturnType<typeof opendir>> | undefined;
  try {
    directory = await opendir(resolve(root, relative));
    const found: string[] = [];
    let rawEntryCount = 0;
    let directoryCount = 0;
    for await (const entry of directory) {
      rawEntryCount += 1;
      if (rawEntryCount > CURRENT_PUBLISHER_DIRECTORY_SCAN_ENTRY_LIMIT) mismatch();
      if (entry.isDirectory()) {
        directoryCount += 1;
        if (!isCurrentPublisherPackageWithinTraversalBounds(0, directoryCount)) {
          mismatch();
        }
        found.push(entry.name);
      }
    }
    return found;
  } catch (error) {
    if (error instanceof Error && error.message === "current_publisher_input_mismatch") {
      throw error;
    }
    throw new Error("current_publisher_input_missing");
  } finally {
    if (directory) {
      try {
        await directory.close();
      } catch {
        // The async iterator may have closed the directory already.
      }
    }
  }
}

async function inventoryPackageFiles(root: string, packageRoot: string): Promise<string[]> {
  const directory = resolve(root, packageRoot);
  const found: string[] = [];
  let fileCount = 0;
  let directoryCount = 0;
  const visit = async (current: string, relativeDirectory: string): Promise<void> => {
    let handle: Awaited<ReturnType<typeof opendir>> | undefined;
    try {
      handle = await opendir(current);
      for await (const entry of handle) {
        const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          directoryCount += 1;
          if (!isCurrentPublisherPackageWithinTraversalBounds(fileCount, directoryCount)) {
            mismatch();
          }
          await visit(resolve(current, entry.name), relativePath);
        } else if (entry.isFile()) {
          fileCount += 1;
          if (!isCurrentPublisherPackageWithinTraversalBounds(fileCount, directoryCount)) {
            mismatch();
          }
          found.push(relativePath);
        } else {
          mismatch();
        }
      }
    } catch (error) {
      if (error instanceof Error && error.message === "current_publisher_input_mismatch") {
        throw error;
      }
      throw new Error("current_publisher_input_missing");
    } finally {
      if (handle) {
        try {
          await handle.close();
        } catch {
          // The async iterator may have closed the directory already.
        }
      }
    }
  };
  await visit(directory, "");
  found.sort();
  return found;
}

async function requiredBytes(
  root: string,
  relative: string,
  maxBytes = FORM_PACKAGE_LIMITS.payloadBytes,
): Promise<Uint8Array> {
  const path = resolve(root, relative);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error("current_publisher_input_missing");
  }
  let handle: Awaited<ReturnType<typeof open>>;
  let beforePath: Awaited<ReturnType<typeof lstat>>;
  try {
    beforePath = await lstat(path);
  } catch {
    throw new Error("current_publisher_input_missing");
  }
  if (!beforePath.isFile() || beforePath.isSymbolicLink()) mismatch();
  try {
    handle = await open(path, "r");
  } catch {
    throw new Error("current_publisher_input_missing");
  }
  try {
    const metadata = await handle.stat();
    if (
      !metadata.isFile() ||
      !Number.isSafeInteger(metadata.size) ||
      metadata.size < 0 ||
      metadata.size > maxBytes
    ) {
      mismatch();
    }
    if (!sameFile(beforePath, metadata) || !sameStableMetadata(beforePath, metadata)) {
      mismatch();
    }
    const bytes = new Uint8Array(metadata.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const result = await handle.read(bytes, offset, bytes.byteLength - offset, offset);
      if (result.bytesRead <= 0) mismatch();
      offset += result.bytesRead;
    }
    const after = await handle.stat();
    const afterPath = await lstat(path);
    if (
      !after.isFile() ||
      !afterPath.isFile() ||
      afterPath.isSymbolicLink() ||
      !sameFile(metadata, after) ||
      !sameFile(metadata, afterPath) ||
      !sameStableMetadata(metadata, after) ||
      !sameStableMetadata(metadata, afterPath)
    ) {
      mismatch();
    }
    return bytes;
  } catch (error) {
    if (error instanceof Error && error.message === "current_publisher_input_mismatch") {
      throw error;
    }
    throw new Error("current_publisher_input_missing");
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function sameFile(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableMetadata(
  left: Awaited<ReturnType<typeof lstat>>,
  right: Awaited<ReturnType<typeof lstat>>,
): boolean {
  return left.mode === right.mode && left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function isSafePackagePath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= 512 &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !value.includes("\u0000") &&
    value.split("/").every((segment) => segment.length > 0 && segment !== "." && segment !== "..")
  );
}

function parse(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    mismatch();
  }
}

function mismatch(): never {
  throw new Error("current_publisher_input_mismatch");
}

function incomplete(): never {
  throw new Error("current_publisher_catalog_incomplete");
}

function digest(value: unknown): `sha256:${string}` {
  const parsed = string(value);
  if (!/^sha256:[0-9a-f]{64}$/u.test(parsed)) mismatch();
  return parsed as `sha256:${string}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function object(value: unknown): Record<string, unknown> {
  if (!isObject(value)) mismatch();
  return value;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) mismatch();
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") mismatch();
  return value;
}

function number(value: unknown): number {
  if (!Number.isSafeInteger(value)) mismatch();
  return value as number;
}
