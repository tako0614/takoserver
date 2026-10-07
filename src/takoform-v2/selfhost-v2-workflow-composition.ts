import type { Clock, Sql } from "../ports.ts";
import type { WorkerModuleSemanticInspector } from "../worker-module-inspection-contract.ts";
import { createWorkflowRuntime } from "../workflow-execution.ts";
import { createWorkerdWorkflowExecutionHost } from "../workflow-runtime-workerd.ts";
import { createV2WorkflowResourceAuthority } from "../workflow-v2-resource-authority.ts";
import type { StaticAssetBundleCustody } from "./forms/static-asset-bundle-backend.ts";
import type { WorkerBundleCustody } from "./forms/worker-bundle-backend.ts";
import { createV2WorkerPublicationState } from "./worker-publication-state.ts";
import { createDurableWorkflowForm } from "./workflow-backend.ts";
import { createV2WorkflowClassAdmission } from "./workflow-class-admission.ts";
import { createV2WorkflowForwardRuntime } from "./workflow-forward-runtime.ts";
import {
  createV2WorkflowNativeSelection,
  type V2WorkflowNativeOwnerPort,
} from "./workflow-native-selection.ts";

/**
 * Internal, unmounted v2 Workflow composition. Its SQL object is shared by
 * Resource/Operation admission and instance/step writes; no second ledger is
 * introduced. The owner must supply exact current native selection and lease.
 */
export function createSelfhostV2WorkflowComposition(options: {
  readonly sql: Sql;
  readonly clock: Clock;
  readonly randomId: () => string;
  readonly waitUntil: (epochMs: number, signal: AbortSignal) => Promise<void>;
  readonly targetKey: string;
  readonly ownerForWorkerUid: (workerUid: string) => Promise<V2WorkflowNativeOwnerPort>;
  readonly bundleCustody: Pick<WorkerBundleCustody, "readHeldVerified">;
  readonly assetCustody?: Pick<StaticAssetBundleCustody, "readHeldVerified">;
  readonly inspector: Pick<WorkerModuleSemanticInspector, "inspectWorkflowClass">;
  readonly guardBinary: string;
  readonly workerdBinary: string;
  readonly maximumRegistrations: number;
  readonly leaseMs?: number;
  readonly temporaryRoot?: string;
  readonly dataPlaneAddress?: () => string;
}) {
  const publicationState = createV2WorkerPublicationState({
    sql: options.sql,
    bundleCustody: options.bundleCustody,
    ...(options.assetCustody === undefined ? {} : { assetCustody: options.assetCustody }),
  });
  const classAdmission = createV2WorkflowClassAdmission({
    sql: options.sql,
    targetKey: options.targetKey,
    bundleCustody: options.bundleCustody,
    inspector: options.inspector,
  });
  const select = createV2WorkflowNativeSelection({
    sql: options.sql,
    targetKey: options.targetKey,
    ownerForWorkerUid: options.ownerForWorkerUid,
    publicationState,
    inspector: options.inspector,
  });
  const prepare = createV2WorkflowForwardRuntime({
    select,
    ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
    ...(options.dataPlaneAddress === undefined
      ? {}
      : { dataPlaneAddress: options.dataPlaneAddress }),
  });
  const host = createWorkerdWorkflowExecutionHost({
    guardBinary: options.guardBinary,
    workerdBinary: options.workerdBinary,
    maximumRegistrations: options.maximumRegistrations,
    prepare,
  });
  const runtime = createWorkflowRuntime({
    sql: options.sql,
    clock: options.clock,
    randomId: options.randomId,
    waitUntil: options.waitUntil,
    host,
    v2ResourceAuthority: createV2WorkflowResourceAuthority(options.sql),
    ...(options.leaseMs === undefined ? {} : { leaseMs: options.leaseMs }),
  });
  const form = createDurableWorkflowForm({
    sql: options.sql,
    clock: options.clock,
    targetKey: options.targetKey,
    classAdmission,
    runtime,
  });
  return { form, runtime, host };
}
