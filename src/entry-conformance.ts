import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { createStaticTestTakoformHost as createTakoformHost } from "./app.ts";
import {
  bytesDigest,
  canonicalDigest,
  canonicalJson,
  isJsonObject,
  isSha256Digest,
} from "./json.ts";
import { migrateSqlite } from "./migrate-sqlite.ts";
import { createFileObjectStore } from "./objects-fs.ts";
import type { JsonObject } from "./ports.ts";
import { createSqliteSql } from "./sql-sqlite.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import { InMemoryTakoformResourceDriver } from "./takoform/memory-driver.ts";
import type { TakoformRouteConfiguration } from "./takoform/routes.ts";
import { createTakoformStore, type ResourceAddress } from "./takoform/store.ts";
import type {
  InstalledTakoformBinding,
  InstalledTakoformForm,
  TakoformOperation,
} from "./takoform/types.ts";
import {
  applyRequest,
  failure,
  idempotencyKey,
  increment,
  stripApplyReview,
} from "./takoform/wire.ts";
import { createJavaScriptWorkerModuleInspector } from "./takoform/worker-module-inspector.ts";

/**
 * DISPOSABLE conformance build. Never production.
 *
 * Takoform's portable-host runner needs instrumentation headers a real host
 * must never serve: forced stable errors, a host-side status touch, and an
 * out-of-band delete — plus the documented authorization, plan-binding, and
 * raw-JSON probes. The async probe only selects the persistent Operation
 * policy composed around the ordinary lifecycle engine; it does not emulate a
 * 202 response in this adapter. Frozen stable suite inputs are loaded from an
 * exact Takoform repository/corpus checkout, and the process refuses to start unless
 * the operator states out loud that this process is a test subject:
 *
 *   TAKOSERVER_DISPOSABLE_CONFORMANCE=1 bun src/entry-conformance.ts
 *
 * The production entries (`entry-bun`, `entry-worker`) do not import this
 * module, so their bytes carry no probe handling. Everything probe-shaped
 * lives here and only here.
 *
 * The runner requires three bearer credentials — two principals of one tenant
 * and the first principal of another — which this build serves as fixed
 * tokens. That is the second reason it is disposable: fixed credentials are
 * exactly what a real deployment must never hold.
 *
 * This does not vendor or publish those input packages. The nine corpus-only
 * Forms needed to prove constraints and independent definition/family identity
 * come only from the pinned runner inputs and use the in-memory protocol driver.
 */

if (process.env.TAKOSERVER_DISPOSABLE_CONFORMANCE !== "1") {
  console.error(
    "entry-conformance is a DISPOSABLE test build that serves conformance probe headers.\n" +
      "It must never face production traffic. To start it anyway, state that on purpose:\n\n" +
      "  TAKOSERVER_DISPOSABLE_CONFORMANCE=1 bun src/entry-conformance.ts\n",
  );
  process.exit(1);
}

const PROBE_HEADER = "takoform-conformance-probe";
const PROBE_AUTHORIZATION_HEADER = "takoform-conformance-probe-authorization";
const PROBE_PLAN_BINDING_HEADER = "takoform-conformance-probe-plan-binding";
const PROBE_PLAN_BINDING_RESULT_HEADER = "takoform-conformance-probe-plan-binding-result";
const PROBE_RAW_JSON_HEADER = "takoform-conformance-probe-raw-json";

/** The closed stable error taxonomy with its exact HTTP status map. */
const STABLE_ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_argument: 400,
  unauthenticated: 401,
  permission_denied: 403,
  form_unknown: 404,
  form_not_installed: 409,
  form_unavailable: 503,
  resource_not_found: 404,
  resource_busy: 409,
  import_conflict: 409,
  policy_denied: 403,
  backend_unavailable: 503,
  internal_error: 500,
  rate_limited: 429,
  deadline_exceeded: 504,
  operation_cancelled: 409,
  operation_not_found: 404,
  dependency_in_use: 409,
  artifact_missing: 404,
  artifact_invalid: 400,
  unsupported_capability: 422,
  migration_required: 409,
  uid_mismatch: 409,
  revision_conflict: 412,
  generation_conflict: 412,
};

const port = Number(process.env.PORT ?? 8799);
const publicOrigin = process.env.TAKOSERVER_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const dataRoot = process.env.TAKOSERVER_DATA_ROOT ?? ".takoserver-conformance";
const takoformRoot = resolve(process.env.TAKOFORM_REPOSITORY_ROOT ?? "../takoform");
const corpusRoot = resolve(
  process.env.TAKOFORM_CONFORMANCE_ROOT ??
    resolve(takoformRoot, "conformance/takoform-v1/generic-host/portable-host"),
);
const stableRoutes: TakoformRouteConfiguration = {
  hostApiVersion: "forms.takoform.com/v1",
  apiPath: "/apis/forms.takoform.com/v1",
  supportProfileApiVersion: "support.takoform.com/v1",
  enumerateForms: true,
  exposeDefinitionConstraints: true,
  omitObservedStatus: true,
  bodyGenerationFence: true,
  reviewSpecDigest: true,
  standardServices: {
    apiVersion: "standards.takoform.com/v1",
  },
};

const databasePath = `${dataRoot}/control.sqlite`;
mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
migrateSqlite(database);
const sql = createSqliteSql(database);
const objects = createFileObjectStore({ root: dataRoot });
const clock = () => new Date();

const suiteCatalog = await loadCandidateCatalog(takoformRoot, corpusRoot);
const forms = suiteCatalog.forms;
const artifactStore = createTakoformArtifacts({
  sql,
  objects,
  clock,
  randomId: () => crypto.randomUUID(),
  artifactPrefix: `${stableRoutes.apiPath}/artifacts`,
});

const store = createTakoformStore(sql, clock);
const driver = new InMemoryTakoformResourceDriver();

interface CandidateFormEntry {
  readonly kind: string;
  readonly role: InstalledTakoformForm["role"];
  readonly path: string;
  readonly requiresHostApi?: string;
  readonly formRef: InstalledTakoformForm["identity"]["formRef"];
  readonly packageDigest?: `sha256:${string}`;
}

interface CandidateDefinition extends Record<string, unknown> {
  readonly apiVersion: string;
  readonly kind: string;
  readonly definitionVersion: string;
  readonly title?: string;
  readonly description?: string;
  readonly role?: InstalledTakoformForm["role"];
  readonly requiresHostApi: string;
  readonly desiredSchema: JsonObject;
  readonly observedSchema?: JsonObject;
  readonly outputSchema?: JsonObject;
  readonly lifecycleCapabilities: readonly string[];
}

/**
 * Reads the frozen stable-suite inputs from the owning Takoform repository.
 *
 * Nothing is copied into the immutable provider-v2.1.1 vendor history. This
 * The source tree still names these unpublished package locations `candidates`;
 * this entry verifies their set, package index, and definition identities agree
 * before feeding their semantics to the ordinary Host registry.
 */
async function loadCandidateCatalog(
  repositoryRoot: string,
  conformanceRoot: string,
): Promise<{
  readonly forms: readonly InstalledTakoformForm[];
  readonly bindings: readonly InstalledTakoformBinding[];
  readonly familyCount: number;
}> {
  const setPath = resolve(
    repositoryRoot,
    "forms/candidates/edge.forms.takoform.com/candidate-set.json",
  );
  const set = (await readJson(setPath)) as {
    readonly format?: unknown;
    readonly family?: unknown;
    readonly packageApiVersion?: unknown;
    readonly publicationStatus?: unknown;
    readonly forms?: unknown;
  };
  if (
    set.format !== "takoform.form-family-candidates@v1" ||
    set.family !== "edge.forms.takoform.com" ||
    set.packageApiVersion !== "packages.forms.takoform.com/v1alpha5" ||
    set.publicationStatus !== "unpublished" ||
    !Array.isArray(set.forms) ||
    set.forms.length !== 16
  ) {
    throw new Error("candidate_set_identity_mismatch");
  }

  const entries = set.forms as CandidateFormEntry[];
  const familyForms: InstalledTakoformForm[] = [];
  for (const entry of entries) {
    if (
      !isSha256Digest(entry.packageDigest) ||
      !isSha256Digest(entry.formRef?.schemaDigest) ||
      entry.formRef.apiVersion !== set.family ||
      entry.formRef.kind !== entry.kind
    ) {
      throw new Error("candidate_form_identity_invalid");
    }
    const packageDirectory = within(repositoryRoot, resolve(repositoryRoot, entry.path));
    const definitionPath = resolve(packageDirectory, "definition.json");
    const indexBytes = await readFile(resolve(packageDirectory, "package-index.json"));
    const index = JSON.parse(indexBytes.toString()) as {
      readonly apiVersion?: unknown;
      readonly kind?: unknown;
      readonly formRef?: unknown;
      readonly definitionPath?: unknown;
      readonly files?: readonly {
        readonly path?: unknown;
        readonly size?: unknown;
        readonly digest?: unknown;
      }[];
    };
    const definitionBytes = await readFile(definitionPath);
    const definition = (JSON.parse(definitionBytes.toString()) ?? {}) as CandidateDefinition;
    const indexedDefinition = index.files?.find((file) => file.path === "definition.json");
    if (
      index.apiVersion !== set.packageApiVersion ||
      index.kind !== "FormPackage" ||
      index.definitionPath !== "definition.json" ||
      canonicalJson(index.formRef) !== canonicalJson(entry.formRef) ||
      (await canonicalDigest(index)) !== entry.packageDigest ||
      indexedDefinition?.digest !== (await bytesDigest(definitionBytes)) ||
      indexedDefinition.size !== definitionBytes.byteLength ||
      definition.apiVersion !== entry.formRef.apiVersion ||
      definition.kind !== entry.formRef.kind ||
      definition.definitionVersion !== entry.formRef.definitionVersion ||
      definition.role !== entry.role ||
      (await canonicalDigest(definition)) !== entry.formRef.schemaDigest ||
      (entry.requiresHostApi !== undefined &&
        definition.requiresHostApi !== entry.requiresHostApi) ||
      !isJsonObject(definition.desiredSchema) ||
      !Array.isArray(definition.lifecycleCapabilities)
    ) {
      throw new Error(`candidate_package_identity_mismatch:${entry.kind}`);
    }
    familyForms.push(installedCandidateForm(entry, definition));
  }

  const bindings = await loadCandidateBindings(repositoryRoot, familyForms);
  const contract = (await readJson(resolve(conformanceRoot, "contract.json"))) as {
    readonly apiVersion?: unknown;
    readonly runnerInput?: {
      readonly syntheticSecondGroup?: InstalledTakoformForm["identity"]["formRef"];
      readonly syntheticSecondDefinitionVersion?: {
        readonly formRef?: InstalledTakoformForm["identity"]["formRef"];
        readonly path?: string;
        readonly sha256?: string;
      };
      readonly constraintSemantics?: Readonly<
        Record<
          string,
          {
            readonly formRef?: InstalledTakoformForm["identity"]["formRef"];
            readonly path?: string;
            readonly sha256?: string;
          }
        >
      >;
    };
  };
  if (contract.apiVersion !== stableRoutes.hostApiVersion) {
    throw new Error("candidate_conformance_lane_mismatch");
  }
  const second = contract.runnerInput?.syntheticSecondDefinitionVersion;
  if (!second?.formRef || !second.path || !isSha256Digest(second.sha256)) {
    throw new Error("candidate_conformance_second_definition_missing");
  }
  const secondBytes = await readFile(
    within(conformanceRoot, resolve(conformanceRoot, second.path)),
  );
  if ((await bytesDigest(secondBytes)) !== second.sha256) {
    throw new Error("candidate_conformance_second_definition_digest_mismatch");
  }
  const secondDefinition = JSON.parse(secondBytes.toString()) as CandidateDefinition;
  if (
    secondDefinition.apiVersion !== second.formRef.apiVersion ||
    secondDefinition.kind !== second.formRef.kind ||
    secondDefinition.definitionVersion !== second.formRef.definitionVersion ||
    (await canonicalDigest(secondDefinition)) !== second.formRef.schemaDigest ||
    !isJsonObject(secondDefinition.desiredSchema) ||
    !Array.isArray(secondDefinition.lifecycleCapabilities)
  ) {
    throw new Error("candidate_conformance_second_definition_identity_mismatch");
  }
  const secondForm = installedCandidateForm(
    {
      kind: second.formRef.kind,
      role: secondDefinition.role,
      path: second.path,
      requiresHostApi: secondDefinition.requiresHostApi,
      formRef: second.formRef,
    },
    secondDefinition,
    false,
  );

  const secondGroup = contract.runnerInput?.syntheticSecondGroup;
  const edgeKv = familyForms.find((form) => form.identity.formRef.kind === "EdgeKVNamespace");
  if (!secondGroup || !isSha256Digest(secondGroup.schemaDigest) || !edgeKv) {
    throw new Error("candidate_conformance_second_group_missing");
  }
  const otherGroupForm: InstalledTakoformForm = {
    ...structuredClone(edgeKv),
    identity: { formRef: structuredClone(secondGroup) },
  };
  const constraintForms = await loadConstraintForms(conformanceRoot, contract);
  return {
    forms: [...familyForms, secondForm, otherGroupForm, ...constraintForms],
    bindings,
    familyCount: familyForms.length,
  };
}

async function loadConstraintForms(
  conformanceRoot: string,
  contract: {
    readonly runnerInput?: {
      readonly constraintSemantics?: Readonly<
        Record<
          string,
          {
            readonly formRef?: InstalledTakoformForm["identity"]["formRef"];
            readonly path?: string;
            readonly sha256?: string;
          }
        >
      >;
    };
  },
): Promise<readonly InstalledTakoformForm[]> {
  const probes = contract.runnerInput?.constraintSemantics;
  if (
    !probes ||
    Object.keys(probes).sort().join("\0") !==
      [
        "distinctPair",
        "member",
        "node",
        "sameTarget",
        "structural",
        "uniquePair",
        "uniquePairSecond",
      ].join("\0")
  ) {
    throw new Error("stable_constraint_corpus_missing");
  }
  const forms: InstalledTakoformForm[] = [];
  for (const [name, probe] of Object.entries(probes).sort(([left], [right]) =>
    left.localeCompare(right),
  )) {
    if (!probe.formRef || !probe.path || !isSha256Digest(probe.sha256)) {
      throw new Error(`stable_constraint_probe_missing:${name}`);
    }
    const bytes = await readFile(within(conformanceRoot, resolve(conformanceRoot, probe.path)));
    if ((await bytesDigest(bytes)) !== probe.sha256) {
      throw new Error(`stable_constraint_probe_bytes_mismatch:${name}`);
    }
    const definition = JSON.parse(bytes.toString()) as CandidateDefinition;
    if (
      definition.apiVersion !== probe.formRef.apiVersion ||
      definition.kind !== probe.formRef.kind ||
      definition.definitionVersion !== probe.formRef.definitionVersion ||
      (await canonicalDigest(definition)) !== probe.formRef.schemaDigest ||
      !isJsonObject(definition.desiredSchema) ||
      !Array.isArray(definition.lifecycleCapabilities)
    ) {
      throw new Error(`stable_constraint_probe_identity_mismatch:${name}`);
    }
    forms.push(
      installedCandidateForm(
        {
          kind: probe.formRef.kind,
          role: definition.role,
          path: probe.path,
          requiresHostApi: definition.requiresHostApi,
          formRef: probe.formRef,
        },
        definition,
        false,
      ),
    );
  }
  return forms;
}

function installedCandidateForm(
  entry: CandidateFormEntry,
  definition: CandidateDefinition,
  includePackage = true,
): InstalledTakoformForm {
  const operations = definition.lifecycleCapabilities;
  if (
    !operations.every((operation) =>
      ["create", "read", "update", "delete", "import", "observe"].includes(operation),
    )
  ) {
    throw new Error(`candidate_operations_invalid:${entry.kind}`);
  }
  return {
    identity: {
      formRef: structuredClone(entry.formRef),
      ...(includePackage && entry.packageDigest ? { packageDigest: entry.packageDigest } : {}),
    },
    ...(definition.title ? { displayName: definition.title } : {}),
    ...(definition.description ? { description: definition.description } : {}),
    ...(definition.role ? { role: definition.role } : {}),
    requiresHostApi: definition.requiresHostApi,
    ...(Array.isArray(definition.constraints)
      ? { constraints: structuredClone(definition.constraints) as never }
      : {}),
    ...(Array.isArray(definition.providedInterfaces)
      ? {
          providedInterfaces: structuredClone(definition.providedInterfaces) as never,
        }
      : {}),
    ...(Array.isArray(definition.acceptedBindings)
      ? {
          acceptedBindings: structuredClone(definition.acceptedBindings) as never,
        }
      : {}),
    desiredSchema: structuredClone(definition.desiredSchema),
    ...(isJsonObject(definition.observedSchema)
      ? { observedSchema: structuredClone(definition.observedSchema) }
      : {}),
    ...(isJsonObject(definition.outputSchema)
      ? { outputSchema: structuredClone(definition.outputSchema) }
      : {}),
    operations: operations as readonly TakoformOperation[],
    ...artifactRequirement(entry.kind),
    ...workerClassRuntime(entry.kind, definition),
  };
}

/** Explicit edge-family adapter; generic keyed exclusivity never implies worker ABI semantics. */
function workerClassRuntime(
  kind: string,
  definition: CandidateDefinition,
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
          isJsonObject(candidate) &&
          candidate.apiVersion === "interfaces.takoform.com/v1alpha1" &&
          candidate.name === interfaceName,
      )
    : false;
  if (!provided) throw new Error(`candidate_worker_class_interface_missing:${kind}`);
  return {
    workerClassRuntime: {
      providedInterface: interfaceName,
      className: "/className",
      workerRelation: "/worker",
      deploymentForm: {
        apiVersion: "edge.forms.takoform.com",
        kind: "WorkerDeployment",
      },
      deploymentWorkerRelation: "/worker",
      deploymentVersionRelation: "/versions/*/workerVersion",
      versionBundleRelation: "/bundle",
    },
  };
}

async function loadCandidateBindings(
  repositoryRoot: string,
  forms: readonly InstalledTakoformForm[],
): Promise<readonly InstalledTakoformBinding[]> {
  const accepted = forms.flatMap((form) => form.acceptedBindings ?? []);
  const directory = resolve(repositoryRoot, "bindings/candidates/v1alpha2");
  const bindings: InstalledTakoformBinding[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const definition = (await readJson(resolve(directory, entry.name, "definition.json"))) as {
      readonly apiVersion?: unknown;
      readonly kind?: unknown;
      readonly name?: unknown;
      readonly version?: unknown;
      readonly sourceRole?: unknown;
      readonly targetInterface?: unknown;
      readonly allowedTargetForms?: unknown;
    };
    const ref = accepted.find(
      (candidate) => candidate.name === definition.name && candidate.version === definition.version,
    );
    if (
      definition.apiVersion !== "bindings.takoform.com/v1alpha2" ||
      definition.kind !== "BindingDefinition" ||
      !ref ||
      (await canonicalDigest(definition)) !== ref.schemaDigest ||
      !["identity", "revision", "deployment", "attachment", "policy"].includes(
        String(definition.sourceRole),
      ) ||
      !isJsonObject(definition.targetInterface) ||
      !Array.isArray(definition.allowedTargetForms)
    ) {
      throw new Error(`candidate_binding_invalid:${entry.name}`);
    }
    bindings.push({
      bindingRef: structuredClone(ref),
      sourceRole: definition.sourceRole as NonNullable<InstalledTakoformForm["role"]>,
      targetInterface: structuredClone(definition.targetInterface) as never,
      allowedTargetForms: structuredClone(definition.allowedTargetForms) as never,
    });
  }
  if (bindings.length !== accepted.length) {
    throw new Error("candidate_binding_catalog_incomplete");
  }
  return bindings;
}

function artifactRequirement(
  kind: string,
): Pick<InstalledTakoformForm, "artifactRequirement"> | object {
  if (kind === "WorkerBundle") {
    return {
      artifactRequirement: {
        specField: "manifestDigest",
        kind: "WorkerBundle",
      },
    };
  }
  if (kind === "StaticAssetBundle") {
    return {
      artifactRequirement: {
        specField: "manifestDigest",
        kind: "StaticAssetBundle",
      },
    };
  }
  if (kind === "SQLiteMigrationSet") {
    return {
      artifactRequirement: {
        specField: "manifestDigest",
        kind: "MigrationBundle",
      },
    };
  }
  return {};
}

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8"));
}

function within(root: string, path: string): string {
  const candidate = relative(root, path);
  if (candidate === "" || candidate === "." || candidate.startsWith(`..${pathSeparator()}`)) {
    if (candidate !== "" && candidate !== ".") throw new Error("candidate_path_escape");
  }
  if (candidate === ".." || resolve(root, candidate) !== path)
    throw new Error("candidate_path_escape");
  return path;
}

function pathSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

/** The runner's three credentials: two principals of tenant A, one of tenant B. */
const principals = new Map([
  [
    process.env.TAKOSERVER_CONFORMANCE_TOKEN ?? "takoserver-conformance-primary",
    { tenantId: "org-conformance-a", principalId: "principal-1" },
  ],
  [
    process.env.TAKOSERVER_CONFORMANCE_ALTERNATE_TOKEN ?? "takoserver-conformance-alternate",
    { tenantId: "org-conformance-a", principalId: "principal-2" },
  ],
  [
    process.env.TAKOSERVER_CONFORMANCE_ALTERNATE_TENANT_TOKEN ??
      "takoserver-conformance-alternate-tenant",
    { tenantId: "org-conformance-b", principalId: "principal-1" },
  ],
]);

const host = createTakoformHost({
  sql,
  objects,
  authenticate: async (request) => {
    const authorization = request.headers.get("authorization");
    if (!authorization?.startsWith("Bearer ")) return null;
    return principals.get(authorization.slice("Bearer ".length)) ?? null;
  },
  forms,
  bindings: suiteCatalog.bindings,
  driver,
  artifacts: artifactStore,
  standardServiceResolver: {
    async satisfiable(input) {
      return (
        [...principals.values()].some((principal) => principal.tenantId === input.tenantId) &&
        input.serviceRef.protocol === "com.amazonaws.s3"
      );
    },
    async resolve(input) {
      if (
        ![...principals.values()].some((principal) => principal.tenantId === input.tenantId) ||
        input.slot.service.protocol !== "com.amazonaws.s3"
      ) {
        return null;
      }
      return {
        endpoint: {
          handle: `conformance-endpoint:${input.tenantId}:${input.slot.service.protocol}`,
        },
        credential: {
          handle: `conformance-credential:${input.tenantId}:${input.slot.service.protocol}`,
        },
      };
    },
  },
  deferredOperations: {
    shouldDefer: ({ request }) => request.headers.get(PROBE_HEADER) === "async",
    pollsBeforeCommit: 1,
    retryAfterSeconds: 0,
  },
  workerModuleInspector: createJavaScriptWorkerModuleInspector(),
  clock,
});

// ---------------------------------------------------------------------------
// The probe adapter.
// ---------------------------------------------------------------------------

const LANE = /^\/apis\/forms\.takoform\.com\/v1(?:\/|$)/u;
const RESOURCE_PATH =
  /^\/apis\/forms\.takoform\.com\/v1\/resources\/([^/]+)(?:\/(v[0-9]+(?:(?:alpha|beta)[0-9]+)?))?\/([^/]+)\/([^/]+)(\/observe|\/import)?$/u;

interface AdapterPrincipal {
  readonly tenantId: string;
  readonly principalId: string;
}

const stableError = (code: string): Response => failure(code, STABLE_ERROR_STATUS[code] ?? 500);

/** Strips every probe header so the engine never sees instrumentation. */
function strippedRequest(request: Request, body?: Uint8Array): Request {
  const headers = new Headers(request.headers);
  headers.delete(PROBE_HEADER);
  headers.delete(PROBE_AUTHORIZATION_HEADER);
  headers.delete(PROBE_PLAN_BINDING_HEADER);
  headers.delete(PROBE_RAW_JSON_HEADER);
  return new Request(request.url, {
    method: request.method,
    headers,
    ...(body && body.byteLength > 0 ? { body: body as unknown as BodyInit } : {}),
  });
}

/** Resolves the exact resource a name-addressed request points at, if any. */
async function addressedResource(
  principal: AdapterPrincipal,
  url: URL,
  match: RegExpExecArray,
): Promise<{
  address: ResourceAddress;
  current: Awaited<ReturnType<typeof store.readResource>>;
} | null> {
  const space = url.searchParams.get("space");
  if (!space) return null;
  const address: ResourceAddress = {
    tenantId: principal.tenantId,
    space,
    apiVersion: match[2] === undefined ? (match[1] as string) : `${match[1]}/${match[2]}`,
    kind: match[3] as string,
    name: match[4] as string,
  };
  const current = await store.readResource(address);
  const query = {
    apiVersion: url.searchParams.get("group"),
    kind: url.searchParams.get("kind"),
    definitionVersion: url.searchParams.get("definitionVersion"),
    schemaDigest: url.searchParams.get("schemaDigest"),
  };
  if (
    current &&
    (current.form.formRef.apiVersion !== query.apiVersion ||
      current.form.formRef.kind !== query.kind ||
      current.form.formRef.definitionVersion !== query.definitionVersion ||
      current.form.formRef.schemaDigest !== query.schemaDigest)
  ) {
    return { address, current: null };
  }
  return { address, current };
}

/** One delete performed as an out-of-band backend change. */
async function externalChangeDelete(
  request: Request,
  principal: AdapterPrincipal,
  url: URL,
  match: RegExpExecArray,
): Promise<Response | null> {
  const resolved = await addressedResource(principal, url, match);
  // A miss keeps its ordinary taxonomy: the engine answers it.
  if (!resolved?.current) return null;
  const { address, current } = resolved;
  try {
    idempotencyKey(request);
  } catch {
    return stableError("invalid_argument");
  }
  const expected = request.headers.get("takoform-expected-generation");
  if (!expected) return stableError("invalid_argument");
  if (expected !== current.metadata.generation) return stableError("generation_conflict");
  const ifMatch = request.headers.get("if-match");
  if (ifMatch && ifMatch !== `"${current.metadata.revision}"`) {
    return stableError("revision_conflict");
  }
  // The one path that bypasses relation protection, because it exists to
  // simulate a backend losing a resource nobody asked it to lose.
  const removed = await store.deleteResource(address, current.metadata.revision);
  if (!removed) return stableError("resource_busy");
  return new Response(null, { status: 204 });
}

/** A host-side status touch: the revision advances, the generation does not. */
async function touchStatus(
  principal: AdapterPrincipal,
  url: URL,
  match: RegExpExecArray,
): Promise<void> {
  const resolved = await addressedResource(principal, url, match);
  if (!resolved?.current) return;
  const { address, current } = resolved;
  const relations = await store.readRelations(address);
  await store.writeResource({
    address,
    resource: {
      ...current,
      metadata: {
        ...current.metadata,
        revision: increment(current.metadata.revision),
      },
    },
    relations,
    expectedRevision: current.metadata.revision,
  });
}

/** The documented closed enum of instrumented one-field plan substitutions. */
const PLAN_BINDING_PROBES = new Set([
  "desired-spec",
  "resource-name",
  "space",
  "generation",
  "form-api-version",
  "form-kind",
  "form-definition-version",
  "form-schema-digest",
  "package-digest",
]);

/**
 * Passes a substituted apply through the same canonical plan-binding
 * computation the engine uses — the stored prepare fingerprint against the
 * canonical reviewed body, plus the generation and incarnation the review was
 * minted for — and reports the verdict without executing a fence, mutating
 * state, or recording a replay.
 */
async function planBindingProbe(
  request: Request,
  principal: AdapterPrincipal,
  value: string,
): Promise<Response> {
  if (!PLAN_BINDING_PROBES.has(value)) return stableError("invalid_argument");
  let body: ReturnType<typeof applyRequest>;
  try {
    body = applyRequest(await request.clone().json());
  } catch {
    return stableError("invalid_argument");
  }
  const substituted = structuredClone(body) as {
    -readonly [K in keyof typeof body]: (typeof body)[K];
  };
  const mutableRef = substituted.form.formRef as {
    -readonly [K in keyof typeof substituted.form.formRef]: string;
  };
  switch (value) {
    case "desired-spec":
      substituted.spec = {
        ...substituted.spec,
        __takoformConformanceProbe__: true,
      };
      break;
    case "resource-name":
      substituted.metadata = {
        ...substituted.metadata,
        name: `${body.metadata.name}-probe`,
      };
      break;
    case "space":
      substituted.metadata = {
        ...substituted.metadata,
        space: `${body.metadata.space}-probe`,
      };
      break;
    case "generation":
      substituted.expectedGeneration = increment(substituted.expectedGeneration ?? "1");
      break;
    case "form-api-version":
      mutableRef.apiVersion = "probe.forms.takoform.com/v1";
      break;
    case "form-kind":
      mutableRef.kind = `${mutableRef.kind}Probe`;
      break;
    case "form-definition-version":
      mutableRef.definitionVersion = "999.0.0";
      break;
    case "form-schema-digest":
      mutableRef.schemaDigest = `sha256:${"0".repeat(64)}`;
      break;
    case "package-digest":
      substituted.form = {
        ...substituted.form,
        packageDigest: `sha256:${"0".repeat(64)}`,
      };
      break;
    default:
      return stableError("invalid_argument");
  }
  const review = await store.readPrepare(principal.tenantId, body.review.prepareDigest);
  const current = await store.readResource({
    tenantId: principal.tenantId,
    space: substituted.metadata.space,
    apiVersion: substituted.apiVersion,
    kind: substituted.kind,
    name: substituted.metadata.name,
  });
  const expectedGeneration =
    value === "generation"
      ? substituted.expectedGeneration
      : (current?.metadata.generation ?? undefined);
  const bound =
    review !== null &&
    review.fingerprint === canonicalJson(stripApplyReview(substituted)) &&
    review.expectedGeneration === expectedGeneration &&
    review.currentUid === (current?.metadata.uid ?? undefined);
  if (!bound) {
    const refusal = stableError("invalid_argument");
    refusal.headers.set(PROBE_PLAN_BINDING_RESULT_HEADER, "rejected");
    return refusal;
  }
  return new Response(null, {
    status: 204,
    headers: { [PROBE_PLAN_BINDING_RESULT_HEADER]: "accepted-no-mutation" },
  });
}

async function adapter(request: Request): Promise<Response> {
  const url = new URL(request.url);
  if (request.method === "GET" && url.pathname === "/.well-known/takoform/v1") {
    return Response.json(discovery());
  }
  if (!LANE.test(url.pathname)) {
    return (await host.handle(request)) ?? failure("not_found", 404);
  }

  // Authentication first, always: an instrumentation header must never be a
  // way past the credential check.
  const authorization = request.headers.get("authorization");
  const principal = authorization?.startsWith("Bearer ")
    ? principals.get(authorization.slice("Bearer ".length))
    : undefined;
  if (!principal) {
    return (await host.handle(request)) ?? failure("not_found", 404);
  }

  const authorizationProbe = request.headers.get(PROBE_AUTHORIZATION_HEADER);
  if (authorizationProbe !== null) {
    // A current denial, decided after authentication and before any replay
    // lookup — the adapter answers before the engine ever sees the request,
    // so no recorded success is read, overwritten, or poisoned.
    if (authorizationProbe === "credential-revoked") return stableError("unauthenticated");
    if (authorizationProbe === "permission-revoked") return stableError("permission_denied");
    if (authorizationProbe === "policy-revoked") return stableError("policy_denied");
    return stableError("invalid_argument");
  }

  const rawJsonProbe = request.headers.get(PROBE_RAW_JSON_HEADER);
  if (rawJsonProbe !== null) {
    if (rawJsonProbe !== "duplicate-error-code") return stableError("invalid_argument");
    // The contract's exact malformed envelope: an error object carrying the
    // "code" member twice, which complete raw I-JSON validation must refuse
    // before any stable-error decoding.
    return new Response(
      '{"error":{"code":"invalid_argument","code":"internal_error","message":"conformance raw-JSON probe","requestId":"req_probe","retryable":false}}',
      { status: 400, headers: { "content-type": "application/json" } },
    );
  }

  const planBinding = request.headers.get(PROBE_PLAN_BINDING_HEADER);
  if (planBinding !== null) {
    return await planBindingProbe(request, principal, planBinding);
  }

  const probe = request.headers.get(PROBE_HEADER) ?? "";
  if (probe.startsWith("error:")) {
    const code = probe.slice("error:".length);
    if (!(code in STABLE_ERROR_STATUS)) return stableError("invalid_argument");
    return stableError(code);
  }
  if (
    probe !== "" &&
    probe !== "async" &&
    probe !== "touch-status" &&
    probe !== "external-change"
  ) {
    return stableError("invalid_argument");
  }

  const resource = RESOURCE_PATH.exec(url.pathname);
  if (
    probe === "touch-status" &&
    resource &&
    resource[5] === "/observe" &&
    request.method === "POST"
  ) {
    await touchStatus(principal, url, resource);
    return (await host.handle(strippedRequest(request))) ?? failure("not_found", 404);
  }
  if (probe === "external-change" && resource && !resource[5] && request.method === "DELETE") {
    const handled = await externalChangeDelete(request, principal, url, resource);
    if (handled) return handled;
    return (await host.handle(request)) ?? failure("not_found", 404);
  }

  return (await host.handle(request)) ?? failure("not_found", 404);
}

function discovery(): Record<string, unknown> {
  const base = `${publicOrigin}${stableRoutes.apiPath}`;
  return {
    api_versions: [stableRoutes.hostApiVersion],
    features: {
      service_forms: true,
      exact_form_ref: true,
      optimistic_concurrency: true,
      idempotent_lifecycle: true,
      operations: true,
      artifact_upload: true,
      support_profiles: true,
    },
    endpoints: {
      api: base,
    },
  };
}

Bun.serve({
  hostname: "127.0.0.1",
  port,
  idleTimeout: 120,
  fetch: adapter,
});

console.log(
  [
    "",
    "############################################################",
    "##  TAKOSERVER DISPOSABLE CONFORMANCE BUILD — NOT PRODUCTION",
    "##  This process serves Takoform conformance probe headers",
    "##  and fixed test credentials. Destroy it after the run.",
    "############################################################",
    "",
    `listening on http://127.0.0.1:${port} as ${publicOrigin}`,
    `forms installed: ${forms.length} (${suiteCatalog.familyCount} current stable family, 9 corpus-only)`,
    `bindings installed: ${suiteCatalog.bindings.length}`,
    "",
    "runner credentials:",
    ...[...principals.entries()].map(
      ([token, principal]) => `  ${principal.tenantId}/${principal.principalId}: Bearer ${token}`,
    ),
    "",
  ].join("\n"),
);
