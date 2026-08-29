import { canonicalDigest, canonicalJson, isSha256Digest } from "../json.ts";
import type { InstalledTakoformForm, TakoformOperation } from "./types.ts";

export const YURUCOMMU_FORM_VERSIONS = {
  AtLeastOnceQueue: "0.1.0",
  EdgeKVNamespace: "0.1.0",
  ModuleWorker: "0.1.0",
  QueueConsumer: "0.1.0",
  SQLiteDatabase: "0.1.0",
  SQLiteMigrationApplication: "0.1.0",
  SQLiteMigrationSet: "0.1.0",
  WorkerBundle: "0.1.0",
  WorkerCronTrigger: "0.1.0",
  WorkerDeployment: "0.1.0",
  WorkerEndpoint: "0.1.0",
  WorkerVersion: "0.2.0",
} as const;

export type YurucommuFormKind = keyof typeof YURUCOMMU_FORM_VERSIONS;

export const YURUCOMMU_IDENTITY_CAPABILITY_KINDS = [
  "AtLeastOnceQueue",
  "EdgeKVNamespace",
  "ModuleWorker",
  "SQLiteDatabase",
] as const;

export type YurucommuIdentityCapabilityKind = (typeof YURUCOMMU_IDENTITY_CAPABILITY_KINDS)[number];

const OPERATION_ORDER: readonly TakoformOperation[] = [
  "create",
  "read",
  "update",
  "delete",
  "import",
  "observe",
];

export interface TakoformLifecycleCapabilityManifest {
  readonly apiVersion: "takoserver.form-lifecycle-capabilities@v1";
  readonly implementation: string;
  readonly forms: Readonly<Record<string, readonly TakoformOperation[]>>;
}

export interface TakoformHandlerManifest {
  readonly apiVersion: "takoserver.form-handlers@v1";
  readonly artifact: string;
  readonly forms: Readonly<Record<string, readonly TakoformOperation[]>>;
}

export interface TakoformImplementationCatalogEntry {
  readonly formRef: InstalledTakoformForm["identity"]["formRef"];
  readonly packageDigest: `sha256:${string}`;
  readonly operations: readonly TakoformOperation[];
}

export interface TakoformImplementationCatalog {
  readonly kind: "takoserver.form-implementation-catalog@v1";
  readonly capabilityDigest: `sha256:${string}`;
  readonly implementationDigest: `sha256:${string}`;
  readonly entries: readonly TakoformImplementationCatalogEntry[];
}

/**
 * Projects the public Worker's realized provider composition into the exact
 * Yurucommu capability surface. The supplied identities come from the same
 * deploy-target `edgeSupplies` value that configures the public Worker; they
 * are not accepted from the Form-authority RPC caller.
 */
export function yurucommuLifecycleCapabilityManifest(
  identityKinds: readonly YurucommuIdentityCapabilityKind[],
  operatorOperations: Readonly<
    Partial<Record<YurucommuFormKind, readonly TakoformOperation[]>>
  > = {},
): TakoformLifecycleCapabilityManifest {
  if (
    new Set(identityKinds).size !== identityKinds.length ||
    identityKinds.some((kind) => !YURUCOMMU_IDENTITY_CAPABILITY_KINDS.includes(kind))
  ) {
    throw new TypeError("Yurucommu target capability identities are invalid");
  }
  for (const kind of Object.keys(operatorOperations)) {
    if (!(kind in YURUCOMMU_FORM_VERSIONS)) {
      throw new TypeError(`operator operations contain an unknown Yurucommu Form: ${kind}`);
    }
  }
  const supplied = new Set<YurucommuIdentityCapabilityKind>(identityKinds);
  const capable = (kind: YurucommuFormKind): boolean => {
    switch (kind) {
      case "AtLeastOnceQueue":
      case "EdgeKVNamespace":
      case "ModuleWorker":
      case "SQLiteDatabase":
        return supplied.has(kind);
      case "QueueConsumer":
        return supplied.has("AtLeastOnceQueue") && supplied.has("ModuleWorker");
      case "WorkerCronTrigger":
      case "WorkerDeployment":
      case "WorkerEndpoint":
      case "WorkerVersion":
        return supplied.has("ModuleWorker");
      case "SQLiteMigrationApplication":
      case "SQLiteMigrationSet":
      case "WorkerBundle":
        return true;
    }
  };
  const sorted = [...identityKinds].sort();
  return {
    apiVersion: "takoserver.form-lifecycle-capabilities@v1",
    implementation: `takoserver.public-worker-target@v1:${sorted.join(",")}`,
    forms: Object.fromEntries(
      Object.keys(YURUCOMMU_FORM_VERSIONS).map((kindValue) => {
        const kind = kindValue as YurucommuFormKind;
        const available = capable(kind) ? OPERATION_ORDER : [];
        const requested = operatorOperations[kind];
        if (requested === undefined) return [kind, available];
        const narrowed = operationSet(requested, `operator ${kind}`);
        const widening = [...narrowed].filter((operation) => !available.includes(operation));
        if (widening.length > 0) {
          throw new TypeError(`operator operations widen ${kind}: ${widening.sort().join(",")}`);
        }
        return [kind, OPERATION_ORDER.filter((operation) => narrowed.has(operation))];
      }),
    ),
  };
}

/**
 * Selects the exact current package identities used by Yurucommu.
 *
 * Package and schema digests come from the verified generated publisher
 * corpus. The only literals here are the deliberately bounded kind/version
 * selection; adding a new current Form never silently expands authority.
 */
export function yurucommuFormCandidates(
  candidates: readonly InstalledTakoformForm[],
): readonly InstalledTakoformForm[] {
  const selected = Object.entries(YURUCOMMU_FORM_VERSIONS).map(([kind, definitionVersion]) => {
    const matches = candidates.filter(
      (candidate) =>
        candidate.identity.formRef.apiVersion === "edge.forms.takoform.com" &&
        candidate.identity.formRef.kind === kind &&
        candidate.identity.formRef.definitionVersion === definitionVersion,
    );
    const form = matches[0];
    if (
      matches.length !== 1 ||
      !form ||
      !form.identity.packageDigest ||
      !isSha256Digest(form.identity.packageDigest)
    ) {
      throw new TypeError(`verified Yurucommu Form candidate is missing: ${kind}`);
    }
    return structuredClone(form);
  });
  selected.sort((left, right) =>
    left.identity.formRef.kind.localeCompare(right.identity.formRef.kind),
  );
  return selected;
}

/**
 * Derives executable operations from three independent facts:
 *
 * 1. lifecycle operations declared by the exact Form package;
 * 2. the host capability manifest; and
 * 3. handlers actually present in the selected Worker artifact.
 *
 * Operator input is a fourth, narrowing-only set. Asking for anything outside
 * the code-derived intersection is rejected instead of silently turning a
 * requested widening into a misleading successful plan.
 */
export async function deriveImplementationCatalog(input: {
  readonly forms: readonly InstalledTakoformForm[];
  readonly capabilities: TakoformLifecycleCapabilityManifest;
  readonly handlers: TakoformHandlerManifest;
  readonly operatorOperations?: Readonly<Record<string, readonly TakoformOperation[]>>;
}): Promise<TakoformImplementationCatalog> {
  validateManifestIdentity(input.capabilities.apiVersion, input.capabilities.implementation);
  validateManifestIdentity(input.handlers.apiVersion, input.handlers.artifact);
  const forms = [...input.forms].sort((left, right) =>
    canonicalJson(left.identity.formRef).localeCompare(canonicalJson(right.identity.formRef)),
  );
  const seen = new Set<string>();
  const entries: TakoformImplementationCatalogEntry[] = [];
  for (const form of forms) {
    const key = canonicalJson(form.identity.formRef);
    if (seen.has(key)) throw new TypeError("implementation catalog contains a duplicate FormRef");
    seen.add(key);
    const packageDigest = form.identity.packageDigest;
    if (!packageDigest || !isSha256Digest(packageDigest)) {
      throw new TypeError("implementation catalog needs an exact package digest");
    }
    const kind = form.identity.formRef.kind;
    const declared = operationSet(form.operations, `Form ${kind}`);
    const capable = operationSet(input.capabilities.forms[kind] ?? [], `capability ${kind}`);
    const handled = operationSet(input.handlers.forms[kind] ?? [], `handler ${kind}`);
    const available = OPERATION_ORDER.filter(
      (operation) => declared.has(operation) && capable.has(operation) && handled.has(operation),
    );
    const requested = input.operatorOperations?.[kind];
    if (requested !== undefined) {
      const narrowed = operationSet(requested, `operator ${kind}`);
      const unavailable = [...narrowed].filter((operation) => !available.includes(operation));
      if (unavailable.length > 0) {
        throw new TypeError(`operator operations widen ${kind}: ${unavailable.sort().join(",")}`);
      }
    }
    const operations = requested
      ? available.filter((operation) => requested.includes(operation))
      : available;
    entries.push({
      formRef: structuredClone(form.identity.formRef),
      packageDigest,
      operations,
    });
  }
  const normalizedCapabilities = normalizedManifest(input.capabilities);
  const normalizedHandlers = normalizedManifest(input.handlers);
  const capabilityDigest = await canonicalDigest(normalizedCapabilities);
  const implementationDigest = await canonicalDigest({
    handlers: normalizedHandlers,
    capabilityDigest,
    entries,
  });
  return {
    kind: "takoserver.form-implementation-catalog@v1",
    capabilityDigest,
    implementationDigest,
    entries,
  };
}

function normalizedManifest(
  manifest: TakoformLifecycleCapabilityManifest | TakoformHandlerManifest,
): Record<string, unknown> {
  return {
    apiVersion: manifest.apiVersion,
    ...(Object.hasOwn(manifest, "implementation")
      ? { implementation: (manifest as TakoformLifecycleCapabilityManifest).implementation }
      : { artifact: (manifest as TakoformHandlerManifest).artifact }),
    forms: Object.fromEntries(
      Object.entries(manifest.forms)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([kind, operations]) => [
          kind,
          OPERATION_ORDER.filter((value) => operations.includes(value)),
        ]),
    ),
  };
}

function operationSet(values: readonly TakoformOperation[], label: string): Set<TakoformOperation> {
  if (!Array.isArray(values)) throw new TypeError(`${label} operations must be an array`);
  const result = new Set<TakoformOperation>();
  for (const value of values) {
    if (!OPERATION_ORDER.includes(value)) throw new TypeError(`${label} operation is invalid`);
    if (result.has(value)) throw new TypeError(`${label} operations contain a duplicate`);
    result.add(value);
  }
  return result;
}

function validateManifestIdentity(apiVersion: string, identity: string): void {
  if (
    !apiVersion ||
    typeof identity !== "string" ||
    identity.length === 0 ||
    identity.length > 255
  ) {
    throw new TypeError("implementation manifest identity is invalid");
  }
}
