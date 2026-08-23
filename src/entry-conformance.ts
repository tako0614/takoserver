import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createCatalog } from "./catalog.ts";
import { buildEdgeForms } from "./edge-forms.ts";
import { canonicalDigest, canonicalJson } from "./json.ts";
import { createLedger } from "./ledger.ts";
import { migrateSqlite } from "./migrate-sqlite.ts";
import { createFileObjectStore } from "./objects-fs.ts";
import type { JsonObject } from "./ports.ts";
import { createProviderDriver } from "./provider-driver.ts";
import { createResourceDeploymentStore } from "./resource-deployments.ts";
import { createSelfhostComposition } from "./selfhost-composition.ts";
import { createSqliteSql } from "./sql-sqlite.ts";
import { createTakoformArtifacts } from "./takoform/artifacts.ts";
import { sameFormRef } from "./takoform/forms.ts";
import { createTakoformHost } from "./takoform/host.ts";
import { InMemoryTakoformResourceDriver } from "./takoform/memory-driver.ts";
import { createTakoformStore, type ResourceAddress } from "./takoform/store.ts";
import type {
  InstalledTakoformForm,
  TakoformOperation,
  TakoformResourceDriver,
} from "./takoform/types.ts";
import {
  applyRequest,
  failure,
  idempotencyKey,
  increment,
  requestBodyDigest,
  stripApplyReview,
} from "./takoform/wire.ts";
import { createJavaScriptWorkerModuleInspector } from "./takoform/worker-module-inspector.ts";
import { createWorkerdRuntime } from "./workerd-runtime.ts";

/**
 * DISPOSABLE conformance build. Never production.
 *
 * Takoform's portable-host runner needs four instrumentation headers a real
 * host must never serve: forced stable errors, a forced 202 Operation path,
 * a host-side status touch, and an out-of-band delete — plus the documented
 * authorization, plan-binding, and raw-JSON probes. This entry composes the
 * SAME engine, provider, and catalog the self-host entry runs, wraps them in
 * a probe adapter, and refuses to start unless the operator states out loud
 * that this process is a test subject:
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
 * `TAKOSERVER_CONFORMANCE_EXTRA_FORMS` may name Takoform Form Definition
 * JSON documents (comma-separated paths) to install beside the released
 * catalog, so the matrix's two-definition identity checks can run. Those
 * synthetic definitions are corpus material with no released provider, so
 * they are driven by the in-memory protocol driver rather than sold.
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
  form_unavailable: 409,
  form_identity_conflict: 409,
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
  deletion_protected: 409,
  artifact_missing: 404,
  artifact_invalid: 400,
  unsupported_capability: 422,
  migration_required: 409,
  uid_mismatch: 409,
  revision_conflict: 412,
  generation_conflict: 412,
};

const RETRYABLE = new Set([
  "resource_busy",
  "backend_unavailable",
  "rate_limited",
  "deadline_exceeded",
]);

const port = Number(process.env.PORT ?? 8799);
const publicOrigin = process.env.TAKOSERVER_PUBLIC_ORIGIN ?? `http://127.0.0.1:${port}`;
const dataRoot = process.env.TAKOSERVER_DATA_ROOT ?? ".takoserver-conformance";

const databasePath = `${dataRoot}/control.sqlite`;
mkdirSync(dirname(databasePath), { recursive: true });
const database = new Database(databasePath);
migrateSqlite(database);
const sql = createSqliteSql(database);
const objects = createFileObjectStore({ root: dataRoot });
const clock = () => new Date();

const edge = await buildEdgeForms();
const artifactStore = createTakoformArtifacts({
  sql,
  objects,
  clock,
  randomId: () => crypto.randomUUID(),
});
const providerArtifacts = {
  manifest: (tenantRef: string, digest: string) => artifactStore.resolveManifest(tenantRef, digest),
  async blob(digest: string) {
    const stored = await objects.get(`art/${digest.slice("sha256:".length)}`);
    return stored ? new Uint8Array(await new Response(stored.body).arrayBuffer()) : null;
  },
};

// The SAME self-host composition entry-bun runs: one provider, one
// installation, the whole released Edge Family sold at price zero. The workerd
// runtime writes real files and configuration under the data root; no workerd
// process is started, because the matrix drives the control plane.
const composition = createSelfhostComposition({
  edge,
  dataRoot,
  runtime: createWorkerdRuntime({ root: dataRoot }),
  artifacts: providerArtifacts,
  edgeForms: true,
  ...(process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX
    ? { workerEndpointSuffix: process.env.TAKOSERVER_WORKER_ENDPOINT_SUFFIX }
    : {}),
  now: clock(),
});

/** Synthetic conformance definitions installed beside the released catalog. */
const extraForms: InstalledTakoformForm[] = [];
for (const path of (process.env.TAKOSERVER_CONFORMANCE_EXTRA_FORMS ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry.length > 0)) {
  const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown> & {
    schemaDigest?: string;
    apiVersion: string;
    kind: string;
    definitionVersion: string;
    title?: string;
    description?: string;
    role?: InstalledTakoformForm["role"];
    desiredSchema: JsonObject;
    observedSchema?: JsonObject;
    outputSchema?: JsonObject;
    lifecycleCapabilities: readonly string[];
  };
  // A Form's schemaDigest is the canonical digest of its whole Definition
  // document; a file may state one explicitly instead (the corpus pins the
  // synthetic second-group identity without shipping its document).
  const explicit = raw.schemaDigest;
  const { schemaDigest: _stated, ...document } = raw;
  const schemaDigest = (explicit ??
    (await canonicalDigest(document as JsonObject))) as `sha256:${string}`;
  extraForms.push({
    identity: {
      formRef: {
        apiVersion: raw.apiVersion,
        kind: raw.kind,
        definitionVersion: raw.definitionVersion,
        schemaDigest,
      },
    },
    ...(raw.title ? { displayName: raw.title } : {}),
    ...(raw.description ? { description: raw.description } : {}),
    ...(raw.role ? { role: raw.role } : {}),
    desiredSchema: raw.desiredSchema,
    ...(raw.observedSchema ? { observedSchema: raw.observedSchema } : {}),
    ...(raw.outputSchema ? { outputSchema: raw.outputSchema } : {}),
    operations: raw.lifecycleCapabilities as readonly TakoformOperation[],
  });
}

const forms: InstalledTakoformForm[] = [...edge.forms, ...extraForms];

const store = createTakoformStore(sql, clock);
const deployments = createResourceDeploymentStore(sql, clock);
const providerDriver = createProviderDriver({
  providers: [composition.provider],
  catalog: createCatalog(composition.offerings),
  ledger: createLedger(sql, clock),
  deployments,
});
const syntheticDriver = new InMemoryTakoformResourceDriver();
const syntheticRefs = extraForms.map((form) => form.identity.formRef);
const synthetic = (form: InstalledTakoformForm): boolean =>
  syntheticRefs.some((ref) => sameFormRef(ref, form.identity.formRef));

/**
 * The self-host provider driver, with the corpus's synthetic definitions
 * routed to the protocol driver: they exist to prove exact identity, not to
 * be sold, so no provider offering answers for them.
 */
const driver: TakoformResourceDriver = {
  apply: (input) =>
    synthetic(input.form) ? syntheticDriver.apply(input) : providerDriver.apply(input),
  observe: (input) =>
    syntheticRefs.some((ref) => sameFormRef(ref, input.resource.form.formRef))
      ? syntheticDriver.observe(input)
      : providerDriver.observe(input),
  delete: (input) =>
    syntheticRefs.some((ref) => sameFormRef(ref, input.resource.form.formRef))
      ? syntheticDriver.delete(input)
      : providerDriver.delete(input),
  import: (input) =>
    synthetic(input.form)
      ? (syntheticDriver.import?.(input) ?? Promise.reject(new Error("unreachable")))
      : (providerDriver.import?.(input) ?? Promise.reject(new Error("unreachable"))),
  ...(providerDriver.sqliteMigrations ? { sqliteMigrations: providerDriver.sqliteMigrations } : {}),
};

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
  bindings: edge.bindings,
  driver,
  artifacts: artifactStore,
  workerModuleInspector: createJavaScriptWorkerModuleInspector(),
  clock,
});

// ---------------------------------------------------------------------------
// The probe adapter.
// ---------------------------------------------------------------------------

const LANE = /^\/apis\/forms\.takoform\.com\/(?:v1beta1|v1alpha3)/u;
const RESOURCE_PATH =
  /^\/apis\/forms\.takoform\.com\/(?:v1beta1|v1alpha3)\/resources\/([^/]+)\/([^/]+)\/([^/]+)\/([^/]+)(\/observe|\/import)?$/u;
const OPERATION_PATH =
  /^\/apis\/forms\.takoform\.com\/(?:v1beta1|v1alpha3)\/operations\/([^/]+)(\/cancel)?$/u;

interface AdapterPrincipal {
  readonly tenantId: string;
  readonly principalId: string;
}

interface AcceptedTarget {
  readonly address?: ResourceAddress;
  readonly uid?: string;
  readonly ref?: InstalledTakoformForm["identity"]["formRef"];
}

interface AdapterOperation {
  readonly id: string;
  readonly owner: AdapterPrincipal;
  done: boolean;
  pollsRemaining: number;
  committedUid?: string;
  terminalBody?: string;
  commit: () => Promise<{ readonly body: string; readonly committedUid?: string }>;
}

const operations = new Map<string, AdapterOperation>();
const acceptReplays = new Map<
  string,
  { readonly fingerprint: string; readonly body: string; readonly operationId: string }
>();
let operationCounter = 0;

const stableError = (code: string): Response => failure(code, STABLE_ERROR_STATUS[code] ?? 500);

function operationDocument(operation: AdapterOperation): JsonObject {
  return {
    apiVersion: "operations.takoform.com/v1alpha1",
    kind: "Operation",
    id: operation.id,
    done: operation.done,
  };
}

function terminalErrorBody(operation: AdapterOperation, code: string, message: string): string {
  return JSON.stringify({
    ...operationDocument(operation),
    error: { code, message, retryable: RETRYABLE.has(code) },
  });
}

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

/** The engine's own replay identity, one namespace over for the 202 records. */
function acceptReplayKey(
  principal: AdapterPrincipal,
  space: string,
  operation: string,
  key: string,
): string {
  return ["probe-202", principal.tenantId, principal.principalId, space, operation, key].join(" ");
}

async function acceptFingerprint(request: Request, bodyBytes: Uint8Array): Promise<string> {
  const url = new URL(request.url);
  const digest = await requestBodyDigest(
    new Request(request.url, {
      method: request.method,
      ...(bodyBytes.byteLength > 0 ? { body: bodyBytes as unknown as BodyInit } : {}),
    }),
  );
  return canonicalJson({
    method: request.method,
    target: `${url.pathname}${url.search}`,
    preconditions: {
      ifMatch: request.headers.get("if-match"),
      ifNoneMatch: request.headers.get("if-none-match"),
      expectedGeneration: request.headers.get("takoform-expected-generation"),
    },
    rawBodyDigest: digest,
  });
}

/** Whether a recorded 202 outlived the incarnation its operation committed. */
async function acceptReplayRetired(record: { operationId: string }): Promise<boolean> {
  const operation = operations.get(record.operationId);
  if (!operation || !operation.done) return false;
  if (!operation.committedUid) return false;
  for (const principal of principals.values()) {
    if (await store.resourceByUid(principal.tenantId, operation.committedUid)) return false;
  }
  return true;
}

/** Accepts one mutation as a 202 Operation whose commit runs the real engine. */
async function acceptAsync(
  request: Request,
  principal: AdapterPrincipal,
  operationName: "apply" | "import" | "delete",
  space: string,
  target: AcceptedTarget,
  bodyBytes: Uint8Array,
): Promise<Response> {
  let key: string;
  try {
    key = idempotencyKey(request);
  } catch {
    return stableError("invalid_argument");
  }
  const replayKey = acceptReplayKey(principal, space, operationName, key);
  const fingerprint = await acceptFingerprint(request, bodyBytes);
  const recorded = acceptReplays.get(replayKey);
  if (recorded) {
    if (await acceptReplayRetired(recorded)) {
      acceptReplays.delete(replayKey);
    } else if (recorded.fingerprint !== fingerprint) {
      return stableError("invalid_argument");
    } else {
      return new Response(recorded.body, {
        status: 202,
        headers: { "content-type": "application/json" },
      });
    }
  }

  operationCounter += 1;
  const forwarded = strippedRequest(request, bodyBytes);
  const operation: AdapterOperation = {
    id: `op_probe${operationCounter}`,
    owner: principal,
    done: false,
    pollsRemaining: 2,
    commit: async () => {
      // Bound to the exact incarnation it was accepted for: a name now held
      // by another uid — or by the same name under another contract — is a
      // different resource, and rewriting it would be substitution.
      if (target.address) {
        const current = await store.readResource(target.address);
        if (!current) {
          return {
            body: terminalErrorBody(
              operation,
              "resource_not_found",
              "the resource this operation was accepted for is absent",
            ),
          };
        }
        if (
          current.metadata.uid !== target.uid ||
          (target.ref && canonicalJson(current.form.formRef) !== canonicalJson(target.ref))
        ) {
          return {
            body: terminalErrorBody(
              operation,
              "uid_mismatch",
              "the resource this operation was accepted for is gone; the name is held by another incarnation",
            ),
          };
        }
      }
      // The deferred mutation runs through the ordinary engine NOW, so every
      // fence, binding resolution, and blob requirement is re-verified at
      // commit time by construction.
      const response = await host.handle(forwarded);
      if (!response) {
        return {
          body: terminalErrorBody(operation, "internal_error", "the engine did not answer"),
        };
      }
      if (response.status === 204) {
        return {
          body: JSON.stringify({
            ...operationDocument(operation),
            done: true,
            result: { deleted: true },
          }),
        };
      }
      const text = await response.text();
      if (response.status === 200 || response.status === 201) {
        const resource = JSON.parse(text) as JsonObject;
        const committedUid = (resource.metadata as JsonObject | undefined)?.uid;
        return {
          body: JSON.stringify({
            ...operationDocument(operation),
            done: true,
            result: { resource },
          }),
          ...(typeof committedUid === "string" ? { committedUid } : {}),
        };
      }
      let code = "internal_error";
      let message = "the engine refused the commit";
      try {
        const envelope = JSON.parse(text) as { error?: { code?: string; message?: string } };
        if (typeof envelope.error?.code === "string") code = envelope.error.code;
        if (typeof envelope.error?.message === "string") message = envelope.error.message;
      } catch {
        // A non-JSON refusal stays an internal error.
      }
      return { body: terminalErrorBody(operation, code, message) };
    },
  };
  operations.set(operation.id, operation);
  const body = JSON.stringify({ operation: operationDocument(operation) });
  acceptReplays.set(replayKey, { fingerprint, body, operationId: operation.id });
  return new Response(body, { status: 202, headers: { "content-type": "application/json" } });
}

async function settleOperation(operation: AdapterOperation): Promise<void> {
  const outcome = await operation.commit();
  operation.done = true;
  operation.terminalBody = JSON.parse(outcome.body).done
    ? outcome.body
    : JSON.stringify({ ...(JSON.parse(outcome.body) as JsonObject), done: true });
  if (outcome.committedUid) operation.committedUid = outcome.committedUid;
}

function operationResponse(body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

async function handleOperationRoute(
  request: Request,
  principal: AdapterPrincipal,
  id: string,
  cancel: boolean,
): Promise<Response | null> {
  const operation = operations.get(id);
  if (!operation) return null;
  if (
    operation.owner.tenantId !== principal.tenantId ||
    operation.owner.principalId !== principal.principalId
  ) {
    // An operation id is a resumption handle, never a capability: a stranger
    // is told it does not exist, because 403 would confirm that it does.
    return stableError("operation_not_found");
  }
  if (cancel) {
    if (request.method !== "POST") return stableError("invalid_argument");
    try {
      idempotencyKey(request);
    } catch {
      return stableError("invalid_argument");
    }
    if (!operation.done) {
      operation.done = true;
      operation.terminalBody = terminalErrorBody(
        operation,
        "operation_cancelled",
        "operation was cancelled before completion",
      );
    }
    return operationResponse(operation.terminalBody ?? "{}");
  }
  if (request.method !== "GET") return stableError("invalid_argument");
  if (!operation.done) {
    operation.pollsRemaining -= 1;
    if (operation.pollsRemaining > 0) {
      return operationResponse(JSON.stringify(operationDocument(operation)), {
        "retry-after": "0",
      });
    }
    await settleOperation(operation);
  }
  return operationResponse(operation.terminalBody ?? "{}");
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
    apiVersion: `${match[1]}/${match[2]}`,
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
  const deployment = await deployments.active(principal.tenantId, current.metadata.uid);
  if (deployment) {
    await deployments.markDeleted(principal.tenantId, deployment.id, deployment.nativeId);
  }
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
      metadata: { ...current.metadata, revision: increment(current.metadata.revision) },
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
      substituted.spec = { ...substituted.spec, __takoformConformanceProbe__: true };
      break;
    case "resource-name":
      substituted.metadata = { ...substituted.metadata, name: `${body.metadata.name}-probe` };
      break;
    case "space":
      substituted.metadata = { ...substituted.metadata, space: `${body.metadata.space}-probe` };
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
      substituted.form = { ...substituted.form, packageDigest: `sha256:${"0".repeat(64)}` };
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
  if (request.method === "GET" && url.pathname === "/.well-known/takoform/v1beta1") {
    return Response.json(discovery("v1beta1"));
  }
  if (request.method === "GET" && url.pathname === "/.well-known/takoform/v1alpha3") {
    return Response.json(discovery("v1alpha3"));
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
  if (probe === "async" && resource) {
    const action = resource[5];
    if (request.method === "PUT" && !action) {
      const bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
      let parsed: ReturnType<typeof applyRequest>;
      try {
        parsed = applyRequest(JSON.parse(new TextDecoder().decode(bodyBytes)));
      } catch {
        return stableError("invalid_argument");
      }
      let target: AcceptedTarget = {};
      if (request.headers.get("if-none-match") !== "*") {
        const current = await store.readResource({
          tenantId: principal.tenantId,
          space: parsed.metadata.space,
          apiVersion: parsed.apiVersion,
          kind: parsed.kind,
          name: parsed.metadata.name,
        });
        if (current && canonicalJson(current.form.formRef) === canonicalJson(parsed.form.formRef)) {
          target = {
            address: {
              tenantId: principal.tenantId,
              space: parsed.metadata.space,
              apiVersion: parsed.apiVersion,
              kind: parsed.kind,
              name: parsed.metadata.name,
            },
            uid: current.metadata.uid,
            ref: structuredClone(current.form.formRef),
          };
        }
      }
      return await acceptAsync(
        request,
        principal,
        "apply",
        parsed.metadata.space,
        target,
        bodyBytes,
      );
    }
    if (request.method === "POST" && action === "/import") {
      const bodyBytes = new Uint8Array(await request.clone().arrayBuffer());
      let space = "";
      try {
        const parsed = JSON.parse(new TextDecoder().decode(bodyBytes)) as {
          metadata?: { space?: string };
        };
        space = typeof parsed.metadata?.space === "string" ? parsed.metadata.space : "";
      } catch {
        return stableError("invalid_argument");
      }
      return await acceptAsync(request, principal, "import", space, {}, bodyBytes);
    }
    if (request.method === "DELETE" && !action) {
      const resolved = await addressedResource(principal, url, resource);
      if (!resolved?.current) {
        return (await host.handle(request)) ?? failure("not_found", 404);
      }
      const expected = request.headers.get("takoform-expected-generation");
      const ifMatch = request.headers.get("if-match");
      if (
        !expected ||
        expected !== resolved.current.metadata.generation ||
        (ifMatch && ifMatch !== `"${resolved.current.metadata.revision}"`)
      ) {
        return (await host.handle(request)) ?? failure("not_found", 404);
      }
      return await acceptAsync(
        request,
        principal,
        "delete",
        url.searchParams.get("space") ?? "",
        {
          address: resolved.address,
          uid: resolved.current.metadata.uid,
          ref: structuredClone(resolved.current.form.formRef),
        },
        new Uint8Array(),
      );
    }
  }
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

  const operationRoute = OPERATION_PATH.exec(url.pathname);
  if (operationRoute?.[1]) {
    const handled = await handleOperationRoute(
      request,
      principal,
      operationRoute[1],
      operationRoute[2] === "/cancel",
    );
    if (handled) return handled;
  }

  return (await host.handle(request)) ?? failure("not_found", 404);
}

function discovery(lane: "v1beta1" | "v1alpha3"): Record<string, unknown> {
  const base = `${publicOrigin}/apis/forms.takoform.com/${lane}`;
  return {
    api_versions: [`forms.takoform.com/${lane}`],
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
      artifacts: `${base}/artifacts`,
      operations: `${base}/operations`,
      support: `${base}/support`,
    },
  };
}

Bun.serve({
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
    `forms installed: ${forms.length} (${extraForms.length} synthetic)`,
    `offerings: ${composition.offerings.map((offering) => offering.id).join(", ")}`,
    "",
    "runner credentials:",
    ...[...principals.entries()].map(
      ([token, principal]) => `  ${principal.tenantId}/${principal.principalId}: Bearer ${token}`,
    ),
    "",
  ].join("\n"),
);
