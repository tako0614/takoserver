import { createHash, randomInt } from "node:crypto";
import type { Sql } from "../ports.ts";
import { v2SqliteWorkerProjection } from "../providers/selfhost-v2-sqlite-worker-projection.ts";
import type { WorkerModuleSemanticInspector } from "../worker-module-inspection-contract.ts";
import type {
  WorkerdPrivateServiceLease,
  WorkerdSelectedActiveVersion,
} from "../workerd-runtime.ts";
import type { WorkerdWorkflowSelection } from "../workerd-workflow-preparation.ts";
import { WorkflowRuntimeError } from "../workflow-driver.ts";
import type { WorkflowRunIdentity } from "../workflow-execution.ts";
import { V2_SQLITE_ADAPTER_MODULE, V2_SQLITE_INTRINSIC_MODULE } from "./worker-code-runtime.ts";
import type { createV2WorkerPublicationState } from "./worker-publication-state.ts";
import {
  createV2WorkflowSelectedMaterials,
  type V2WorkflowServingObservation,
} from "./workflow-selected-materials.ts";

type CurrentServing = V2WorkflowServingObservation;

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

const unavailable = () => new WorkflowRuntimeError("host_unavailable");

export interface V2WorkflowNativeSelection {
  readonly selection: WorkerdWorkflowSelection;
  readonly incarnationId: string;
  stillCurrent(): Promise<boolean>;
  acquirePrivateServiceBindings(signal: AbortSignal): Promise<WorkerdPrivateServiceLease>;
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
  const selectMaterials = createV2WorkflowSelectedMaterials(options);
  return async (
    identity: WorkflowRunIdentity,
    signal: AbortSignal,
  ): Promise<V2WorkflowNativeSelection> => {
    signal.throwIfAborted();
    const capturedIdentity: WorkflowRunIdentity = Object.freeze({
      scope: Object.freeze({
        tenantId: identity.scope.tenantId,
        workflowResourceUid: identity.scope.workflowResourceUid,
      }),
      instanceId: identity.instanceId,
      executionId: identity.executionId,
      createdAt: identity.createdAt,
      epoch: identity.epoch,
      owner: identity.owner,
      deadlineAt: identity.deadlineAt,
    });
    const selectedBasisPoint = basisPoint();
    if (
      !Number.isSafeInteger(selectedBasisPoint) ||
      selectedBasisPoint < 0 ||
      selectedBasisPoint >= 10_000
    )
      throw new WorkflowRuntimeError("invalid_runtime_input");
    let owner: V2WorkflowNativeOwnerPort | undefined;
    const materials = await selectMaterials(
      capturedIdentity,
      signal,
      async (workerUid, targetKey) => {
        owner ??= await options.ownerForWorkerUid(workerUid);
        if (
          typeof owner?.observeServing !== "function" ||
          typeof owner.selectWorkflowExecution !== "function"
        )
          throw unavailable();
        return owner.observeServing({ workerResourceUid: workerUid, targetKey });
      },
      selectedBasisPoint,
    );
    if (!owner) throw unavailable();
    const { resource, serving, version } = materials;
    const owned = await owner.selectWorkflowExecution({
      workerUid: resource.workerUid,
      targetKey: options.targetKey,
      servingSourceOperationId: serving.sourceOperationId,
      basisPoint: selectedBasisPoint,
    });
    if (
      owned.kind !== "selected" ||
      owned.sourceOperationId !== serving.sourceOperationId ||
      owned.selected.workerVersionUid !== version.uid ||
      typeof owned.incarnationId !== "string" ||
      owned.incarnationId.length === 0
    )
      throw unavailable();
    const selected = cloneSelected(owned.selected);
    if (
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
    const bundle = materials.materials.bundle;
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
    // Retain only the authority callback, not the selected material payload.
    const materialsStillCurrent = materials.stillCurrent;
    const stillCurrent = async (): Promise<boolean> => {
      if (signal.aborted) return false;
      try {
        return (await materialsStillCurrent()) && (await owned.stillCurrent()) && !signal.aborted;
      } catch {
        return false;
      }
    };
    if (!(await stillCurrent())) throw unavailable();
    return {
      selection: {
        tenantId: resource.principal,
        workflowResourceUid: capturedIdentity.scope.workflowResourceUid,
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
