import { createHash, randomInt } from "node:crypto";
import { canonicalJson } from "../json.ts";
import type { JsonObject, Sql } from "../ports.ts";
import { v2SqliteWorkerProjection } from "../providers/selfhost-v2-sqlite-worker-projection.ts";
import { compareSelfhostWeightedVersions } from "../selfhost-weighted-deployment.ts";
import type { WorkerModuleSemanticInspector } from "../worker-module-inspection-contract.ts";
import type {
  WorkerdPrivateServiceLease,
  WorkerdSelectedActiveVersion,
} from "../workerd-runtime.ts";
import type { WorkerdWorkflowSelection } from "../workerd-workflow-preparation.ts";
import { WorkflowRuntimeError } from "../workflow-driver.ts";
import type { WorkflowRunIdentity } from "../workflow-execution.ts";
import type { WorkflowScope } from "../workflow-instances.ts";
import { DURABLE_WORKFLOW_FORM_URL, parseDurableWorkflowSpec } from "./forms/durable-workflow.ts";
import { MODULE_WORKER_FORM_URL } from "./forms/worker-specs.ts";
import { V2_SQLITE_ADAPTER_MODULE, V2_SQLITE_INTRINSIC_MODULE } from "./worker-code-runtime.ts";
import type {
  createV2WorkerPublicationState,
  V2WorkerCurrentServingIdentity,
} from "./worker-publication-state.ts";
import { DURABLE_WORKFLOW_BACKEND_ID } from "./workflow-backend.ts";

type CurrentServing = {
  readonly kind: "serving";
  readonly workerResourceUid: string;
  readonly targetKey: string;
  readonly sourceOperationId: string;
  readonly generation: string;
  readonly hostnames: readonly string[];
  readonly versions: readonly { readonly workerVersionUid: string; readonly weight: number }[];
};

/** Host-private owner port. Only the owner may read its current physical site. */
export interface V2WorkflowNativeOwnerPort {
  observeServing(input: {
    readonly workerResourceUid: string;
    readonly targetKey: string;
  }): Promise<CurrentServing | { readonly kind: "unknown" }>;
  selectWorkflowExecution(input: {
    readonly workerUid: string;
    readonly targetKey: string;
    readonly servingSourceOperationId: string;
    readonly basisPoint: number;
  }): Promise<
    | { readonly kind: "unknown" }
    | {
        readonly kind: "selected";
        readonly sourceOperationId: string;
        readonly incarnationId: string;
        readonly selected: WorkerdSelectedActiveVersion;
        /** Exact accepted serving graph and physical incarnation, after awaits. */
        stillCurrent(): Promise<boolean>;
        /** Closes over this selected incarnation, never a later active runtime. */
        acquirePrivateServiceBindings(signal: AbortSignal): Promise<WorkerdPrivateServiceLease>;
      }
  >;
}

type PublicationState = Pick<
  ReturnType<typeof createV2WorkerPublicationState>,
  "resolveCurrentServing"
>;

export interface V2WorkflowNativeSelection {
  readonly selection: WorkerdWorkflowSelection;
  readonly incarnationId: string;
  stillCurrent(): Promise<boolean>;
  acquirePrivateServiceBindings(signal: AbortSignal): Promise<WorkerdPrivateServiceLease>;
}

type ResourceCapture = {
  readonly principal: string;
  readonly space: string;
  readonly workerUid: string;
  readonly className: string;
  readonly vector: string;
};

const unavailable = () => new WorkflowRuntimeError("host_unavailable");

/** Read from the accepted Resource/Operation ledger, never v1 tf_resources. */
async function captureResource(
  sql: Sql,
  targetKey: string,
  scope: WorkflowScope,
): Promise<ResourceCapture> {
  const rows = await sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [
    scope.workflowResourceUid,
  ]);
  const row = rows.length === 1 ? rows[0] : undefined;
  if (
    !row ||
    row.uid !== scope.workflowResourceUid ||
    row.principal !== scope.tenantId ||
    typeof row.space !== "string" ||
    row.space.length === 0 ||
    row.target_key !== targetKey ||
    row.form_url !== DURABLE_WORKFLOW_FORM_URL ||
    row.backend_id !== DURABLE_WORKFLOW_BACKEND_ID ||
    row.deleted_at !== null ||
    !["idle", "pending"].includes(String(row.phase)) ||
    typeof row.generation !== "number" ||
    typeof row.observed_generation !== "number" ||
    row.observed_generation < 1 ||
    typeof row.last_operation !== "string" ||
    typeof row.spec_json !== "string" ||
    typeof row.observed_json !== "string"
  )
    throw unavailable();
  const operations = await sql.query("SELECT * FROM tf_v2_operations WHERE id = ?", [
    row.last_operation,
  ]);
  const currentOperation = operations.length === 1 ? operations[0] : undefined;
  const pending = row.phase === "pending";
  if (
    !currentOperation ||
    currentOperation.resource_uid !== row.uid ||
    currentOperation.principal !== row.principal ||
    currentOperation.backend_id !== row.backend_id ||
    currentOperation.target_key !== targetKey ||
    currentOperation.generation !== row.generation ||
    currentOperation.accepted_spec_json !== row.spec_json ||
    (pending
      ? row.busy_operation !== currentOperation.id ||
        row.generation <= row.observed_generation ||
        currentOperation.action !== "update" ||
        !["queued", "running", "waiting_input", "reconciling"].includes(
          String(currentOperation.status),
        )
      : row.busy_operation !== null ||
        row.generation !== row.observed_generation ||
        !["create", "update"].includes(String(currentOperation.action)) ||
        currentOperation.status !== "succeeded" ||
        currentOperation.effect !== "complete")
  )
    throw unavailable();
  const previous = pending
    ? await sql.query(
        `SELECT * FROM tf_v2_operations WHERE resource_uid = ? AND generation = ?
         AND action IN ('create','update') AND status = 'succeeded' AND effect = 'complete'`,
        [row.uid as string, row.observed_generation],
      )
    : operations;
  const operation = previous.length === 1 ? previous[0] : undefined;
  if (
    !operation ||
    operation.resource_uid !== row.uid ||
    operation.principal !== row.principal ||
    operation.backend_id !== row.backend_id ||
    operation.target_key !== targetKey ||
    operation.generation !== row.observed_generation ||
    operation.accepted_spec_json !== row.spec_json
  )
    throw unavailable();
  let spec: ReturnType<typeof parseDurableWorkflowSpec>;
  try {
    const observed: unknown = JSON.parse(row.observed_json);
    if (
      !observed ||
      typeof observed !== "object" ||
      Array.isArray(observed) ||
      !("ready" in observed) ||
      observed.ready !== true
    )
      throw unavailable();
    spec = parseDurableWorkflowSpec(JSON.parse(row.spec_json));
  } catch {
    throw unavailable();
  }
  const referenceOperations = pending ? [operation, currentOperation] : [operation];
  const [referenceSnapshots, edges, workers] = await Promise.all([
    Promise.all(
      referenceOperations.map(async (sourceOperation) => {
        const [sets, references] = await Promise.all([
          sql.query("SELECT * FROM tf_v2_operation_reference_sets WHERE operation_id = ?", [
            sourceOperation.id as string,
          ]),
          sql.query("SELECT * FROM tf_v2_operation_references WHERE operation_id = ?", [
            sourceOperation.id as string,
          ]),
        ]);
        const set = sets.length === 1 ? sets[0] : undefined;
        const reference = references.length === 1 ? references[0] : undefined;
        if (
          set?.sealed !== 1 ||
          reference?.target_uid !== spec.worker.resourceUid ||
          reference.form_url !== MODULE_WORKER_FORM_URL ||
          reference.readiness !== "observed" ||
          reference.target_spec_path !== null ||
          reference.target_spec_equals !== null
        )
          throw unavailable();
        return { set, reference };
      }),
    ),
    sql.query("SELECT * FROM tf_v2_resource_references WHERE target_uid = ? AND referrer_uid = ?", [
      spec.worker.resourceUid,
      row.uid as string,
    ]),
    sql.query("SELECT * FROM tf_v2_resources WHERE uid = ?", [spec.worker.resourceUid]),
  ]);
  const edge = edges.length === 1 ? edges[0] : undefined;
  const worker = workers.length === 1 ? workers[0] : undefined;
  if (
    edge?.target_uid !== spec.worker.resourceUid ||
    edge.referrer_uid !== row.uid ||
    worker?.form_url !== MODULE_WORKER_FORM_URL ||
    worker.principal !== row.principal ||
    worker.space !== row.space ||
    worker.deleted_at !== null ||
    !["idle", "pending"].includes(String(worker.phase)) ||
    typeof worker.observed_generation !== "number" ||
    worker.observed_generation < 1
  )
    throw unavailable();
  return {
    principal: row.principal as string,
    space: row.space,
    workerUid: spec.worker.resourceUid,
    className: spec.className,
    vector: canonicalJson({
      resource: row as JsonObject,
      operation: operation as JsonObject,
      pendingOperation: pending ? (currentOperation as JsonObject) : null,
      referenceSnapshots: referenceSnapshots as unknown as JsonObject,
      edge: edge as JsonObject,
      worker: worker as JsonObject,
    }),
  };
}

function cloneSelected(input: WorkerdSelectedActiveVersion): WorkerdSelectedActiveVersion {
  const modules = new Map<string, Uint8Array>();
  const hostModules = new Map<string, Uint8Array>();
  for (const [name, bytes] of input.modules) modules.set(name, new Uint8Array(bytes));
  for (const [name, bytes] of input.hostModules) hostModules.set(name, new Uint8Array(bytes));
  return {
    generation: input.generation,
    generationKey: input.generationKey,
    workerResourceUid: input.workerResourceUid,
    versionId: input.versionId,
    workerVersionUid: input.workerVersionUid,
    site: structuredClone(input.site),
    modules,
    hostModules,
  };
}

/** One fresh run/wake selection; no admission capability is retained across runs. */
export function createV2WorkflowNativeSelection(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly ownerForWorkerUid: (workerUid: string) => Promise<V2WorkflowNativeOwnerPort>;
  readonly publicationState: PublicationState;
  readonly inspector: Pick<WorkerModuleSemanticInspector, "inspectWorkflowClass">;
  readonly basisPoint?: () => number;
}) {
  if (
    !options.sql ||
    typeof options.sql.query !== "function" ||
    !options.targetKey ||
    typeof options.ownerForWorkerUid !== "function" ||
    typeof options.publicationState?.resolveCurrentServing !== "function" ||
    typeof options.inspector?.inspectWorkflowClass !== "function"
  )
    throw new TypeError("v2 Workflow native selection needs accepted SQL and Host owner ports");
  const basisPoint = options.basisPoint ?? (() => randomInt(10_000));
  return async (
    identity: WorkflowRunIdentity,
    signal: AbortSignal,
  ): Promise<V2WorkflowNativeSelection> => {
    signal.throwIfAborted();
    const scope = {
      tenantId: identity.scope.tenantId,
      workflowResourceUid: identity.scope.workflowResourceUid,
    };
    const resource = await captureResource(options.sql, options.targetKey, scope).catch(() => {
      throw unavailable();
    });
    const owner = await options.ownerForWorkerUid(resource.workerUid).catch(() => {
      throw unavailable();
    });
    if (
      typeof owner?.observeServing !== "function" ||
      typeof owner.selectWorkflowExecution !== "function"
    )
      throw unavailable();
    const serving = await owner.observeServing({
      workerResourceUid: resource.workerUid,
      targetKey: options.targetKey,
    });
    if (
      serving.kind !== "serving" ||
      serving.workerResourceUid !== resource.workerUid ||
      serving.targetKey !== options.targetKey
    )
      throw unavailable();
    const selectedBasisPoint = basisPoint();
    if (
      !Number.isSafeInteger(selectedBasisPoint) ||
      selectedBasisPoint < 0 ||
      selectedBasisPoint >= 10_000
    )
      throw new WorkflowRuntimeError("invalid_runtime_input");
    let accumulatedWeight = 0;
    const expectedWeighted = [...serving.versions]
      .sort(compareSelfhostWeightedVersions)
      .find((item) => {
        accumulatedWeight += item.weight;
        return selectedBasisPoint < accumulatedWeight;
      });
    if (!expectedWeighted) throw unavailable();
    const owned = await owner.selectWorkflowExecution({
      workerUid: resource.workerUid,
      targetKey: options.targetKey,
      servingSourceOperationId: serving.sourceOperationId,
      basisPoint: selectedBasisPoint,
    });
    if (
      owned.kind !== "selected" ||
      owned.sourceOperationId !== serving.sourceOperationId ||
      owned.selected.workerVersionUid !== expectedWeighted.workerVersionUid ||
      typeof owned.incarnationId !== "string" ||
      owned.incarnationId.length === 0
    )
      throw unavailable();
    const selected = cloneSelected(owned.selected);
    const expectedIdentity: V2WorkerCurrentServingIdentity = {
      generation: serving.generation,
      workerResourceUid: serving.workerResourceUid,
      hostnames: serving.hostnames,
      versions: serving.versions,
    };
    const publication = await options.publicationState.resolveCurrentServing({
      workerUid: resource.workerUid,
      targetKey: options.targetKey,
      sourceOperationId: serving.sourceOperationId,
      expectedIdentity,
    });
    if (publication.kind !== "ready") throw unavailable();
    const snapshot = publication.snapshot;
    const version = snapshot.deployment?.versions.find(
      (item) => item.uid === selected.workerVersionUid,
    );
    if (
      snapshot.sourceOperationId !== serving.sourceOperationId ||
      snapshot.worker.uid !== resource.workerUid ||
      snapshot.worker.principal !== resource.principal ||
      snapshot.worker.space !== resource.space ||
      !snapshot.deployment ||
      snapshot.deployment.spec.worker.resourceUid !== resource.workerUid ||
      !version ||
      selected.workerResourceUid !== resource.workerUid ||
      selected.generation !== serving.generation ||
      selected.site.workerResourceUid !== resource.workerUid ||
      selected.site.generation !== serving.generation ||
      // The weighted Version copy has no route hostnames. They belong to the
      // accepted Worker publication identity proved above, not this site.
      selected.site.hostnames.length !== 0 ||
      selected.versionId !==
        `v2-${createHash("sha256")
          .update(`${version.uid}\u0000${version.generation}`)
          .digest("hex")}`
    )
      throw unavailable();
    const materials = await publication.readVersionMaterials(version.uid).catch(() => {
      throw unavailable();
    });
    const bundle = materials.bundle;
    if (!bundle || bundle.manifest.files.length !== bundle.files.length) throw unavailable();
    let sqliteProjected: ReadonlyMap<string, Uint8Array>;
    try {
      sqliteProjected =
        version.spec.sqliteBindings.length === 0
          ? new Map<string, Uint8Array>()
          : v2SqliteWorkerProjection({
              originalMainModule: bundle.manifest.entrypoint,
              adapterModule: V2_SQLITE_ADAPTER_MODULE,
              intrinsicModule: V2_SQLITE_INTRINSIC_MODULE,
              sqliteBindingNames: version.spec.sqliteBindings.map((binding) => binding.name),
              declaredHandlers: version.spec.handlers,
            });
    } catch {
      throw unavailable();
    }
    const expectedModuleCount = bundle.manifest.files.length + sqliteProjected.size;
    const expectedMainModule =
      sqliteProjected.size === 0 ? bundle.manifest.entrypoint : V2_SQLITE_ADAPTER_MODULE;
    const declared = new Set([selected.site.mainModule, ...(selected.site.modules ?? [])]);
    if (
      selected.site.mainModule !== expectedMainModule ||
      declared.size !== expectedModuleCount ||
      selected.modules.size !== expectedModuleCount ||
      Object.keys(selected.site.moduleMediaTypes ?? {}).length !== expectedModuleCount ||
      !selected.site.hostEntrypoint ||
      selected.site.hostEntrypoint === selected.site.mainModule
    )
      throw unavailable();
    for (const [index, file] of bundle.manifest.files.entries()) {
      const nativeBytes = selected.modules.get(file.path);
      const heldBytes = bundle.files[index];
      if (
        !nativeBytes ||
        !heldBytes ||
        !declared.has(file.path) ||
        selected.site.moduleMediaTypes?.[file.path] !== file.mediaType ||
        nativeBytes.length !== heldBytes.length ||
        createHash("sha256").update(nativeBytes).digest("hex") !== file.sha256
      )
        throw unavailable();
    }
    for (const [name, bytes] of sqliteProjected) {
      const nativeBytes = selected.modules.get(name);
      if (
        !nativeBytes ||
        !declared.has(name) ||
        selected.site.moduleMediaTypes?.[name] !== "application/javascript+module" ||
        nativeBytes.length !== bytes.length ||
        !nativeBytes.every((value, index) => value === bytes[index])
      )
        throw unavailable();
    }
    const verdict = await options.inspector.inspectWorkflowClass({
      mainModule: bundle.manifest.entrypoint,
      modules: bundle.manifest.files.map((file, index) => ({
        name: file.path,
        digest: `sha256:${file.sha256}`,
        mediaType: file.mediaType,
        bytes: new Uint8Array(bundle.files[index] as Uint8Array),
      })),
      className: resource.className,
    });
    if (verdict.outcome !== "valid") throw unavailable();
    const stillCurrent = async (): Promise<boolean> => {
      if (signal.aborted) return false;
      try {
        const latest = await captureResource(options.sql, options.targetKey, scope);
        return (
          latest.vector === resource.vector &&
          (await publication.stillCurrent()) &&
          (await owned.stillCurrent()) &&
          !signal.aborted
        );
      } catch {
        return false;
      }
    };
    if (!(await stillCurrent())) throw unavailable();
    return {
      selection: {
        tenantId: resource.principal,
        workflowResourceUid: scope.workflowResourceUid,
        workerResourceUid: selected.workerResourceUid,
        versionId: selected.versionId,
        workerVersionUid: selected.workerVersionUid,
        className: resource.className,
        site: selected.site,
        modules: selected.modules,
        hostModules: selected.hostModules,
      },
      incarnationId: owned.incarnationId,
      stillCurrent,
      acquirePrivateServiceBindings: (leaseSignal) =>
        owned.acquirePrivateServiceBindings(leaseSignal),
    };
  };
}
