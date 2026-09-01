import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalDigest } from "../src/json.ts";
import type { JsonObject } from "../src/ports.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformOperation,
} from "../src/takoform/types.ts";

const ROOT = resolve(import.meta.dir, "..");
const OUTPUT = resolve(ROOT, "src/generated/takoform-stable-v1-catalog.ts");
const RECEIPT_OUTPUT = resolve(ROOT, "src/generated/takoform-publisher-set-receipt.ts");
const AUTHORITY_OUTPUT = resolve(ROOT, "src/generated/takoform-publisher-set-authority-closure.ts");
const INTEGRATION_GENERATOR = resolve(ROOT, "scripts/generate-integration-form-packages.ts");
const source = resolve(requiredFlag("--source"));
const setId = requiredFlag("--set");
const check = process.argv.includes("--check");
const FAMILY = "edge.forms.takoform.com";
const REPOSITORY = "https://github.com/tako0614/takoform-forms.git";
const CORE_VERSION = "v1.1.0";
const FAMILY_INDEX = "forms/candidates/current-family-index.json";
const CANDIDATE_SET = `forms/candidates/${FAMILY}/candidate-set.json`;
const INTERFACE_SET = "interfaces/candidates/v1alpha1/candidate-set.json";
const BINDING_SET = "bindings/candidates/v1alpha2/candidate-set.json";
const CORE_VERIFIER_PROTOCOL = "takoserver.takoform-core-verifier@v1";

const repository = normalizeRepository(git("remote", "get-url", "origin"));
const repositoryCommit = git("rev-parse", "HEAD");
if (
  repository !== REPOSITORY ||
  !/^[0-9a-f]{40}$/u.test(setId) ||
  !/^[0-9a-f]{40}$/u.test(repositoryCommit) ||
  git("status", "--porcelain=v1", "--untracked-files=all") !== "" ||
  git("rev-parse", `refs/tags/forms/sets/${setId}^{commit}`) !== repositoryCommit
) {
  invalid();
}
const verification = object(
  JSON.parse(
    execFileSync(
      "go",
      [
        "run",
        "./cmd/publisher-trust",
        "verify-set",
        "--repository",
        ".",
        "--set",
        `forms/trust/sets/${setId}`,
      ],
      { cwd: source, encoding: "utf8", maxBuffer: 8 * 1_024 * 1_024 },
    ),
  ),
);
const verifiedPackages = array(verification.packages).map(object);
if (
  verification.status !== "verified" ||
  verification.coreVersion !== CORE_VERSION ||
  verification.family !== FAMILY ||
  verification.setId !== setId ||
  verification.setTag !== `forms/sets/${setId}` ||
  verification.packageCount !== 17 ||
  verifiedPackages.length !== 17 ||
  verification.sourceCommit !== setId ||
  verification.workflowCommit !== setId ||
  verification.buildConfigCommit !== setId ||
  !record(verification.checkpoint)
) {
  invalid();
}

const inventory: Array<{ readonly path: string; readonly sha256: string }> = [];
const read = (path: string): Uint8Array => {
  const bytes = readFileSync(resolve(source, path));
  inventory.push({ path, sha256: sha256(bytes) });
  return bytes;
};
const json = (path: string): Record<string, unknown> => object(JSON.parse(read(path).toString()));
const authorityRead = (path: string): Buffer => readFileSync(resolve(source, path));
const authorityJson = (path: string): Record<string, unknown> =>
  object(JSON.parse(authorityRead(path).toString("utf8")));

const familyIndex = json(FAMILY_INDEX);
if (familyIndex.format !== "takoform.current-family-index@v1") invalid();
const families = array(familyIndex.families);
const family = object(families[0]);
if (families.length !== 1 || family.group !== FAMILY || family.candidateSet !== CANDIDATE_SET) {
  invalid();
}
const candidateBytes = read(CANDIDATE_SET);
if (family.sha256 !== sha256(candidateBytes)) invalid();
const candidateSet = object(JSON.parse(candidateBytes.toString()));
if (
  candidateSet.format !== "takoform.form-family-candidates@v1" ||
  candidateSet.family !== FAMILY ||
  candidateSet.publicationStatus !== "unpublished"
) {
  invalid();
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
    seenKinds.has(kind) ||
    !/^forms\/candidates\/edge\.forms\.takoform\.com\/[a-z0-9-]+$/u.test(packageRoot)
  ) {
    invalid();
  }
  seenKinds.add(kind);
  const packageIndex = json(`${packageRoot}/package-index.json`);
  const packageDigest = digest(entry.packageDigest);
  const verified = verifiedPackages.find(
    (candidate) =>
      candidate.kind === kind &&
      candidate.packageDigest === packageDigest &&
      JSON.stringify(candidate.formRef) === JSON.stringify(ref),
  );
  if (!verified || verifiedPackages.filter((candidate) => candidate.kind === kind).length !== 1) {
    invalid();
  }
  if ((await canonicalDigest(packageIndex)) !== packageDigest) invalid();
  const packageRef = object(packageIndex.formRef);
  if (
    packageIndex.apiVersion !== "packages.forms.takoform.com/v1alpha5" ||
    packageIndex.kind !== "FormPackage" ||
    JSON.stringify(packageRef) !== JSON.stringify(ref) ||
    packageIndex.definitionPath !== "definition.json"
  ) {
    invalid();
  }
  const declared = array(packageIndex.files);
  const paths = new Set<string>();
  for (const fileValue of declared) {
    const file = object(fileValue);
    const path = string(file.path);
    if (!/^(?:definition\.json|fixtures\/[a-z0-9-]+\.json)$/u.test(path) || paths.has(path)) {
      invalid();
    }
    paths.add(path);
    const bytes = read(`${packageRoot}/${path}`);
    if (file.size !== bytes.byteLength || file.digest !== `sha256:${sha256(bytes)}`) invalid();
  }
  if (!paths.has("definition.json")) invalid();
  const definition = json(`${packageRoot}/definition.json`);
  if (
    definition.apiVersion !== ref.apiVersion ||
    definition.kind !== kind ||
    definition.definitionVersion !== ref.definitionVersion ||
    (await canonicalDigest(definition)) !== ref.schemaDigest
  ) {
    invalid();
  }
  forms.push(installedForm(definition, ref, packageDigest));
}
if (forms.length !== family.formCount) invalid();

const interfaceBytes = read(INTERFACE_SET);
const interfaceSetRef = object(familyIndex.interfaceCandidateSet);
if (interfaceSetRef.path !== INTERFACE_SET || interfaceSetRef.sha256 !== sha256(interfaceBytes)) {
  invalid();
}
const interfaceSet = object(JSON.parse(interfaceBytes.toString()));
if (
  interfaceSet.format !== "takoform.interface-candidates@v1" ||
  interfaceSet.publicationStatus !== "unpublished"
) {
  invalid();
}
for (const entryValue of array(interfaceSet.interfaces)) {
  const entry = object(entryValue);
  const name = contractName(entry.name);
  const definition = json(`interfaces/candidates/v1alpha1/${name}/definition.json`);
  if (
    definition.apiVersion !== "interfaces.takoform.com/v1alpha1" ||
    definition.kind !== "InterfaceDefinition" ||
    definition.name !== name ||
    definition.version !== entry.version ||
    (await canonicalDigest(definition)) !== entry.schemaDigest
  ) {
    invalid();
  }
}

const bindingBytes = read(BINDING_SET);
const bindingSetRef = object(familyIndex.bindingCandidateSet);
if (bindingSetRef.path !== BINDING_SET || bindingSetRef.sha256 !== sha256(bindingBytes)) invalid();
const bindingSet = object(JSON.parse(bindingBytes.toString()));
if (
  bindingSet.format !== "takoform.binding-candidates@v1" ||
  bindingSet.publicationStatus !== "unpublished"
) {
  invalid();
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
    (await canonicalDigest(definition)) !== entry.schemaDigest ||
    !Array.isArray(definition.allowedTargetForms) ||
    typeof definition.sourceRole !== "string" ||
    !record(definition.targetInterface)
  ) {
    invalid();
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
if (bindings.length !== accepted.length) invalid();

const trustSetRoot = `forms/trust/sets/${setId}`;
const authorityPackages: Array<{
  readonly packageDigest: `sha256:${string}`;
  readonly formRef: Record<string, unknown>;
  readonly manifest: Record<string, unknown>;
  readonly files: readonly {
    readonly path: string;
    readonly digest: `sha256:${string}`;
    readonly mediaType?: string;
    readonly base64: string;
  }[];
}> = [];
const corePackageBundles: Array<{
  readonly packageDigest: `sha256:${string}`;
  readonly bundle: string;
}> = [];
for (const candidate of verifiedPackages) {
  const locator = object(candidate.locator);
  const bundle = object(candidate.bundle);
  const packageDigest = digest(candidate.packageDigest);
  const releaseId = string(locator.releaseId);
  const artifactId = string(locator.artifactId);
  const releaseRoot = string(locator.sourcePath);
  if (
    !/^k-[a-z2-7]+$/u.test(releaseId) ||
    artifactId !== packageDigest.replace(":", "-") ||
    releaseRoot !== `forms/releases/${releaseId}/${artifactId}`
  ) {
    invalid();
  }
  const manifest = authorityJson(`${releaseRoot}/package-index.json`);
  const formRef = object(candidate.formRef);
  if (
    (await canonicalDigest(manifest)) !== packageDigest ||
    JSON.stringify(manifest.formRef) !== JSON.stringify(formRef) ||
    !Array.isArray(manifest.files)
  ) {
    invalid();
  }
  const files: Array<{
    readonly path: string;
    readonly digest: `sha256:${string}`;
    readonly mediaType?: string;
    readonly base64: string;
  }> = [];
  for (const fileValue of array(manifest.files)) {
    const file = object(fileValue);
    const path = string(file.path);
    if (!/^(?:definition\.json|fixtures\/[a-z0-9-]+\.json)$/u.test(path)) invalid();
    const bytes = authorityRead(`${releaseRoot}/${path}`);
    const fileDigest = digest(file.digest);
    if (file.size !== bytes.byteLength || fileDigest !== `sha256:${sha256(bytes)}`) invalid();
    files.push({
      path,
      digest: fileDigest,
      ...(typeof file.mediaType === "string" ? { mediaType: file.mediaType } : {}),
      base64: Buffer.from(bytes).toString("base64"),
    });
  }
  const bundleBytes = authorityRead(
    `${trustSetRoot}/packages/${releaseId}/${artifactId}/package-index.sigstore.json`,
  );
  if (digest(bundle.bundleDigest) !== `sha256:${sha256(bundleBytes)}`) invalid();
  authorityPackages.push({ packageDigest, formRef, manifest, files });
  corePackageBundles.push({
    packageDigest,
    bundle: Buffer.from(bundleBytes).toString("utf8"),
  });
}
if (authorityPackages.length !== 17 || corePackageBundles.length !== 17) invalid();

inventory.sort((left, right) => left.path.localeCompare(right.path));
const checkpoint = object(verification.checkpoint);
const checkpointBundle = object(checkpoint.bundle);
const checkpointPin = object(checkpoint.pin);
// Publisher policy was already part of the catalog projection inventory before
// the runtime authority closure was added; keep that provenance digest stable.
const publisherPolicyBytes = Buffer.from(read(`${trustSetRoot}/publisher-policy.json`));
const publisherPolicy = object(JSON.parse(Buffer.from(publisherPolicyBytes).toString("utf8")));
const trustedRootBytes = authorityRead(`${trustSetRoot}/trusted-root.json`);
const checkpointBytes = authorityRead(`${trustSetRoot}/revocations/checkpoint.json`);
const checkpointBundleBytes = authorityRead(`${trustSetRoot}/revocations/checkpoint.sigstore.json`);
if (
  digest(checkpointBundle.trustedRootDigest) !== `sha256:${sha256(trustedRootBytes)}` ||
  digest(checkpointPin.digest) !== `sha256:${sha256(checkpointBytes)}` ||
  digest(checkpointBundle.bundleDigest) !== `sha256:${sha256(checkpointBundleBytes)}`
) {
  invalid();
}
JSON.parse(Buffer.from(trustedRootBytes).toString("utf8"));
JSON.parse(Buffer.from(checkpointBytes).toString("utf8"));
JSON.parse(Buffer.from(checkpointBundleBytes).toString("utf8"));
const receipt = {
  kind: "takoserver.publisher-set-verification@v1",
  coreVersion: CORE_VERSION,
  repository,
  repositoryCommit,
  setId,
  setTag: string(verification.setTag),
  family: FAMILY,
  publisherIdentity: string(verification.publisherIdentity),
  publisherPolicy,
  policyDigest: await canonicalDigest(publisherPolicy),
  oidcIssuer: string(checkpointBundle.oidcIssuer),
  sourceRepository: string(checkpointBundle.sourceRepository),
  workflow: string(checkpointBundle.workflow),
  ref: string(checkpointBundle.ref),
  sourceCommit: string(verification.sourceCommit),
  workflowCommit: string(verification.workflowCommit),
  buildConfigCommit: string(verification.buildConfigCommit),
  trustedRootDigest: digest(checkpointBundle.trustedRootDigest),
  checkpoint: {
    apiVersion: string(checkpointPin.checkpointApiVersion),
    sequence: number(checkpointPin.sequence),
    digest: digest(checkpointPin.digest),
    entriesDigest: digest(checkpointPin.entriesDigest),
    previousDigest: null,
    bundleDigest: digest(checkpointBundle.bundleDigest),
    revokedPackageDigests: [],
  },
  packages: verifiedPackages.map((candidate) => {
    const bundle = object(candidate.bundle);
    const locator = object(candidate.locator);
    return {
      formRef: object(candidate.formRef),
      packageDigest: digest(candidate.packageDigest),
      bundleDigest: digest(bundle.bundleDigest),
      tag: string(locator.tag),
      sourcePath: string(locator.sourcePath),
    };
  }),
} as const;
const receiptDigest = await canonicalDigest(receipt);
const authorityClosure = {
  kind: "takoserver.takoform-publisher-set-authority-closure@v1",
  repository,
  repositoryCommit,
  setId,
  setTag: `forms/sets/${setId}`,
  receiptDigest,
  core: {
    protocol: CORE_VERIFIER_PROTOCOL,
    expectedSourceCommit: string(verification.sourceCommit),
    publisherPolicy: Buffer.from(publisherPolicyBytes).toString("utf8"),
    trustedRoot: Buffer.from(trustedRootBytes).toString("utf8"),
    checkpoint: Buffer.from(checkpointBytes).toString("utf8"),
    checkpointBundle: Buffer.from(checkpointBundleBytes).toString("utf8"),
    packageBundles: corePackageBundles,
  },
  packages: authorityPackages,
} as const;
const provenance = {
  classification: "public-publisher-set-projection",
  repository,
  repositoryCommit,
  setId,
  setTag: `forms/sets/${setId}`,
  sourceCommit: string(verification.sourceCommit),
  coreVersion: CORE_VERSION,
  verificationReceiptDigest: receiptDigest,
  publicationStatus: "published",
  candidateTreeDigest: await canonicalDigest(inventory),
  familyIndexSha256: `sha256:${sha256(readFileSync(resolve(source, FAMILY_INDEX)))}`,
  familyCandidateSetSha256: `sha256:${sha256(candidateBytes)}`,
  interfaceCandidateSetSha256: `sha256:${sha256(interfaceBytes)}`,
  bindingCandidateSetSha256: `sha256:${sha256(bindingBytes)}`,
  familyCount: 1,
  formCount: forms.length,
  interfaceCount: array(interfaceSet.interfaces).length,
  bindingCount: bindings.length,
} as const;
const generated = `${[
  "// Code generated by scripts/import-publisher-set.ts. DO NOT EDIT.",
  "",
  `export const STABLE_PRODUCTION_TAKOFORM_CATALOG = ${JSON.stringify(
    { provenance, forms, bindings },
    null,
    2,
  )} as const;`,
  "",
].join("\n")}`;
const generatedReceipt = `${[
  "// Code generated by scripts/import-publisher-set.ts. DO NOT EDIT.",
  "",
  `export const TAKOFORM_PUBLISHER_SET_RECEIPT = ${JSON.stringify(receipt, null, 2)} as const;`,
  `export const TAKOFORM_PUBLISHER_SET_RECEIPT_DIGEST = ${JSON.stringify(receiptDigest)} as const;`,
  "",
].join("\n")}`;
const generatedAuthorityClosure = `${[
  "// Code generated by scripts/import-publisher-set.ts. DO NOT EDIT.",
  "// Public verification inputs are data; released Core re-verifies them at the Host mutation boundary.",
  "",
  `export const TAKOFORM_PUBLISHER_SET_AUTHORITY_CLOSURE = ${JSON.stringify(
    authorityClosure,
    null,
    2,
  )} as const;`,
  "",
].join("\n")}`;
const formatted = execFileSync(
  process.execPath,
  ["x", "biome", "format", "--stdin-file-path", OUTPUT],
  {
    cwd: ROOT,
    input: generated,
    encoding: "utf8",
  },
);
const formattedReceipt = execFileSync(
  process.execPath,
  ["x", "biome", "format", "--stdin-file-path", RECEIPT_OUTPUT],
  {
    cwd: ROOT,
    input: generatedReceipt,
    encoding: "utf8",
  },
);
const formattedAuthorityClosure = execFileSync(
  process.execPath,
  ["x", "biome", "format", "--stdin-file-path", AUTHORITY_OUTPUT],
  {
    cwd: ROOT,
    input: generatedAuthorityClosure,
    encoding: "utf8",
    maxBuffer: 8 * 1_024 * 1_024,
  },
);
if (check) {
  if (
    readFileSync(OUTPUT, "utf8") !== formatted ||
    readFileSync(RECEIPT_OUTPUT, "utf8") !== formattedReceipt ||
    readFileSync(AUTHORITY_OUTPUT, "utf8") !== formattedAuthorityClosure
  ) {
    throw new Error("publisher set projection is stale");
  }
} else {
  writeFileSync(OUTPUT, formatted);
  writeFileSync(RECEIPT_OUTPUT, formattedReceipt);
  writeFileSync(AUTHORITY_OUTPUT, formattedAuthorityClosure);
}
execFileSync(
  process.execPath,
  [INTEGRATION_GENERATOR, "--source", source, ...(check ? ["--check"] : [])],
  { cwd: ROOT, stdio: "inherit" },
);

function installedForm(
  definition: Record<string, unknown>,
  ref: Record<string, unknown>,
  packageDigest: `sha256:${string}`,
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
  if (
    !array(definition.providedInterfaces).some(
      (candidate) => record(candidate) && candidate.name === interfaceName,
    )
  ) {
    invalid();
  }
  return {
    workerClassRuntime: {
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

function requiredFlag(name: string): string {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`missing ${name}`);
  return value;
}

function git(...args: string[]): string {
  return execFileSync("git", args, { cwd: source, encoding: "utf8" }).trim();
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
  if (!/^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u.test(name)) invalid();
  return name;
}

function digest(value: unknown): `sha256:${string}` {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) invalid();
  return value as `sha256:${string}`;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) invalid();
  return value;
}

function object(value: unknown): Record<string, unknown> {
  if (!record(value)) invalid();
  return value;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function string(value: unknown): string {
  if (typeof value !== "string") invalid();
  return value;
}

function number(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid();
  return value as number;
}

function invalid(): never {
  throw new Error("publisher_set_projection_invalid");
}
