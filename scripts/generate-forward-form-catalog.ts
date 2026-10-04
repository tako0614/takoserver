import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformOperation,
} from "../src/takoform/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = resolve(ROOT, "src/generated/takoform-forward-candidate-catalog.ts");
const source = resolve(requiredFlag("--source"));
const check = process.argv.includes("--check");
const FAMILY = "edge.forms.takoform.com";
const REPOSITORY = "https://github.com/tako0614/takoform-forms.git";
const SOURCE_COMMIT = "32dd4f177685e9da28d54369cfa196ba5ed67da6";
const FAMILY_INDEX = "forms/candidates/current-family-index.json";
const CANDIDATE_SET = `forms/candidates/${FAMILY}/candidate-set.json`;
const INTERFACE_SET = "interfaces/candidates/v1alpha1/candidate-set.json";
const BINDING_SET = "bindings/candidates/v1alpha2/candidate-set.json";

const repository = normalizeRepository(git("remote", "get-url", "origin"));
const repositoryCommit = git("rev-parse", "HEAD");
if (
  repository !== REPOSITORY ||
  repositoryCommit !== SOURCE_COMMIT ||
  git("status", "--porcelain=v1", "--untracked-files=all") !== ""
) {
  invalid("source must be a clean checkout of the Takoform Forms repository");
}

const inventory: Array<{ readonly path: string; readonly sha256: string }> = [];
const read = (path: string): Buffer => {
  const bytes = readFileSync(resolve(source, path));
  inventory.push({ path, sha256: sha256(bytes) });
  return bytes;
};
const json = (path: string): Record<string, unknown> => object(JSON.parse(read(path).toString()));

const familyIndexBytes = read(FAMILY_INDEX);
const familyIndex = object(JSON.parse(familyIndexBytes.toString()));
if (familyIndex.format !== "takoform.current-family-index@v1") invalid("family index format");
const families = array(familyIndex.families).map(object);
const family = families.find((entry) => entry.group === FAMILY);
if (
  families.length !== 1 ||
  !family ||
  family.candidateSet !== CANDIDATE_SET ||
  family.sha256 !== sha256(readFileSync(resolve(source, CANDIDATE_SET)))
) {
  invalid("family index does not identify the exact candidate set");
}

const candidateBytes = read(CANDIDATE_SET);
if (family.sha256 !== sha256(candidateBytes)) {
  invalid("family candidate set changed while loading");
}
const candidateSet = object(JSON.parse(candidateBytes.toString()));
if (
  candidateSet.format !== "takoform.form-family-candidates@v1" ||
  candidateSet.family !== FAMILY ||
  candidateSet.publicationStatus !== "unpublished"
) {
  invalid("candidate set must remain explicitly unpublished");
}

const interfaceBytes = read(INTERFACE_SET);
assertSetDigest(familyIndex.interfaceCandidateSet, INTERFACE_SET, interfaceBytes);
const interfaceSet = object(JSON.parse(interfaceBytes.toString()));
if (
  interfaceSet.format !== "takoform.interface-candidates@v1" ||
  interfaceSet.publicationStatus !== "unpublished"
) {
  invalid("interface candidate set must remain explicitly unpublished");
}
const interfaces = new Map<string, Record<string, unknown>>();
for (const value of array(interfaceSet.interfaces)) {
  const entry = object(value);
  const name = contractName(entry.name);
  const definition = json(`interfaces/candidates/v1alpha1/${name}/definition.json`);
  const schemaDigest = digest(entry.schemaDigest);
  if (
    definition.apiVersion !== "interfaces.takoform.com/v1alpha1" ||
    definition.kind !== "InterfaceDefinition" ||
    definition.name !== name ||
    definition.version !== entry.version ||
    (await canonicalDigest(definition)) !== schemaDigest ||
    interfaces.has(`${name}@${String(entry.version)}`)
  ) {
    invalid(`interface definition mismatch: ${name}`);
  }
  interfaces.set(`${name}@${String(entry.version)}`, {
    apiVersion: "interfaces.takoform.com/v1alpha1",
    name,
    version: string(entry.version),
    schemaDigest,
  });
}

const forms: InstalledTakoformForm[] = [];
const seenKinds = new Set<string>();
for (const entryValue of array(candidateSet.forms)) {
  const entry = object(entryValue);
  const ref = object(entry.formRef);
  const kind = string(ref.kind);
  const packageRoot = string(entry.path);
  if (
    ref.apiVersion !== FAMILY ||
    entry.kind !== kind ||
    seenKinds.has(kind) ||
    !/^forms\/candidates\/edge\.forms\.takoform\.com\/[a-z0-9-]+$/u.test(packageRoot)
  ) {
    invalid(`invalid Form candidate entry: ${kind}`);
  }
  seenKinds.add(kind);
  const packageIndex = json(`${packageRoot}/package-index.json`);
  const packageDigest = digest(entry.packageDigest);
  if (
    (await canonicalDigest(packageIndex)) !== packageDigest ||
    packageIndex.apiVersion !== "packages.forms.takoform.com/v1alpha5" ||
    packageIndex.kind !== "FormPackage" ||
    canonicalJson(packageIndex.formRef) !== canonicalJson(ref) ||
    packageIndex.definitionPath !== "definition.json"
  ) {
    invalid(`package index mismatch: ${kind}`);
  }
  const declared = array(packageIndex.files).map(object);
  const paths = new Set<string>();
  for (const file of declared) {
    const path = string(file.path);
    if (!/^(?:definition\.json|fixtures\/[a-z0-9-]+\.json)$/u.test(path) || paths.has(path)) {
      invalid(`invalid package file path: ${kind}/${path}`);
    }
    paths.add(path);
    const bytes = read(`${packageRoot}/${path}`);
    if (file.size !== bytes.byteLength || file.digest !== `sha256:${sha256(bytes)}`) {
      invalid(`package file digest mismatch: ${kind}/${path}`);
    }
  }
  if (!paths.has("definition.json")) invalid(`package has no definition: ${kind}`);
  const definition = json(`${packageRoot}/definition.json`);
  const schemaDigest = digest(ref.schemaDigest);
  if (
    definition.apiVersion !== ref.apiVersion ||
    definition.kind !== kind ||
    definition.definitionVersion !== ref.definitionVersion ||
    (await canonicalDigest(definition)) !== schemaDigest
  ) {
    invalid(`Form Definition mismatch: ${kind}`);
  }
  forms.push(installedForm(definition, ref, packageDigest, interfaces));
}
if (forms.length !== family.formCount) invalid("family Form count mismatch");

const bindingBytes = read(BINDING_SET);
assertSetDigest(familyIndex.bindingCandidateSet, BINDING_SET, bindingBytes);
const bindingSet = object(JSON.parse(bindingBytes.toString()));
if (
  bindingSet.format !== "takoform.binding-candidates@v1" ||
  bindingSet.publicationStatus !== "unpublished"
) {
  invalid("binding candidate set must remain explicitly unpublished");
}
const accepted = forms.flatMap((form) => form.acceptedBindings ?? []);
const bindings: InstalledTakoformBinding[] = [];
for (const entryValue of array(bindingSet.bindings)) {
  const entry = object(entryValue);
  const name = contractName(entry.name);
  const definition = json(`bindings/candidates/v1alpha2/${name}/definition.json`);
  const ref = accepted.find(
    (candidate) =>
      candidate.name === name &&
      candidate.version === entry.version &&
      candidate.schemaDigest === entry.schemaDigest,
  );
  if (
    !ref ||
    definition.apiVersion !== "bindings.takoform.com/v1alpha2" ||
    definition.kind !== "BindingDefinition" ||
    definition.name !== name ||
    definition.version !== entry.version ||
    (await canonicalDigest(definition)) !== digest(entry.schemaDigest) ||
    !Array.isArray(definition.allowedTargetForms) ||
    typeof definition.sourceRole !== "string" ||
    !record(definition.targetInterface)
  ) {
    invalid(`binding definition mismatch: ${name}`);
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
if (bindings.length !== accepted.length) invalid("binding closure is incomplete");

const provenance = {
  classification: "unpublished-source-candidate",
  repository: REPOSITORY,
  repositoryCommit,
  sourceCommit: repositoryCommit,
  publicationStatus: "unpublished",
  sourceTreeDigest: await canonicalDigest(inventory),
  familyIndexSha256: `sha256:${sha256(familyIndexBytes)}`,
  familyCandidateSetSha256: `sha256:${sha256(candidateBytes)}`,
  interfaceCandidateSetSha256: `sha256:${sha256(interfaceBytes)}`,
  bindingCandidateSetSha256: `sha256:${sha256(bindingBytes)}`,
  familyCount: 1,
  formCount: forms.length,
  interfaceCount: interfaces.size,
  bindingCount: bindings.length,
} as const;
assertSourceUnchanged();
const generated = `${[
  "// Code generated by scripts/generate-forward-form-catalog.ts. DO NOT EDIT.",
  "// Exact source candidate bytes; this catalog is not a published or verified set.",
  "",
  `export const TAKOFORM_FORWARD_CANDIDATE_CATALOG = ${JSON.stringify(
    { provenance, forms, bindings },
    null,
    2,
  )} as const;`,
  "",
].join("\n")}`;
const formatted = execFileSync(
  process.execPath,
  ["x", "biome", "format", "--stdin-file-path", OUTPUT],
  { cwd: ROOT, input: generated, encoding: "utf8", maxBuffer: 8 * 1_024 * 1_024 },
);
assertSourceUnchanged();
if (check) {
  if (readFileSync(OUTPUT, "utf8") !== formatted) {
    throw new Error("forward Takoform source candidate projection is stale");
  }
} else {
  writeFileSync(OUTPUT, formatted);
}

function installedForm(
  definition: Record<string, unknown>,
  ref: Record<string, unknown>,
  packageDigest: `sha256:${string}`,
  interfaceDefinitions: ReadonlyMap<string, Record<string, unknown>>,
): InstalledTakoformForm {
  const operations = array(definition.lifecycleCapabilities).map(string);
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
    ...(record(definition.observedSchema)
      ? { observedSchema: structuredClone(definition.observedSchema) as JsonObject }
      : {}),
    ...(record(definition.outputSchema)
      ? { outputSchema: structuredClone(definition.outputSchema) as JsonObject }
      : {}),
    operations: operations as TakoformOperation[],
    ...artifactRequirement(string(ref.kind)),
    ...workerClassRuntime(string(ref.kind), definition, interfaceDefinitions),
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
  interfaceDefinitions: ReadonlyMap<string, Record<string, unknown>>,
): Pick<InstalledTakoformForm, "workerClassRuntime"> | object {
  const interfaceName =
    kind === "ActorNamespace"
      ? "worker.actor"
      : kind === "DurableWorkflow"
        ? "worker.workflow"
        : undefined;
  if (!interfaceName) return {};
  const runtimeClassRef = array(definition.providedInterfaces)
    .map(object)
    .find((candidate) => candidate.name === interfaceName);
  if (!runtimeClassRef) invalid(`missing class Interface: ${kind}`);
  const projectedRef = interfaceDefinitions.get(
    `${interfaceName}@${String(runtimeClassRef.version)}`,
  );
  if (!projectedRef || canonicalJson(projectedRef) !== canonicalJson(runtimeClassRef)) {
    invalid(`class Interface is not in exact source set: ${kind}`);
  }
  return {
    workerClassRuntime: {
      runtimeClassRef: structuredClone(projectedRef) as never,
      providedInterface: interfaceName,
      className: "/className",
      workerRelation: "/worker",
      deploymentForm: { apiVersion: FAMILY, kind: "WorkerDeployment" },
      deploymentWorkerRelation: "/worker",
      deploymentVersionRelation: "/versions/*/workerVersion",
      versionBundleRelation: "/bundle",
    },
  };
}

function assertSetDigest(value: unknown, expectedPath: string, bytes: Buffer): void {
  const ref = object(value);
  if (ref.path !== expectedPath || ref.sha256 !== sha256(bytes)) {
    invalid(`candidate index digest mismatch: ${expectedPath}`);
  }
}

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
}

function assertSourceUnchanged(): void {
  if (
    git("rev-parse", "HEAD") !== SOURCE_COMMIT ||
    git("status", "--porcelain=v1", "--untracked-files=all") !== "" ||
    inventory.some((entry) => sha256(readFileSync(resolve(source, entry.path))) !== entry.sha256)
  ) {
    invalid("source changed during projection");
  }
}

function normalizeRepository(value: string): string {
  return value === "git@github.com:tako0614/takoform-forms.git"
    ? "https://github.com/tako0614/takoform-forms.git"
    : value;
}

function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function contractName(value: unknown): string {
  const name = string(value);
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(name)) invalid("invalid contract name");
  return name;
}

function digest(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    invalid("invalid sha256 digest");
  }
  return value as `sha256:${string}`;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid("expected object");
  return value as Record<string, unknown>;
}

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid("expected array");
  return value;
}

function string(value: unknown): string {
  if (typeof value !== "string") invalid("expected string");
  return value;
}

function invalid(reason: string): never {
  throw new Error(`invalid forward Takoform candidate source: ${reason}`);
}
