/**
 * Source extension seam for an operator-owned v2 backend.
 *
 * Resource and Operation authority remains with the public v2 SQL engine.
 * This entrypoint only reexports its existing contracts and the read-only
 * Worker publication resolver; it does not register Forms or publish traffic.
 */
export type { JsonObject, Sql } from "../ports.ts";
export {
  referencesForModuleWorker,
  referencesForWorkerDeployment,
  referencesForWorkerEndpoint,
  referencesForWorkerForm,
  referencesForWorkerVersion,
} from "./forms/worker-references.ts";
export {
  MODULE_WORKER_FORM_URL,
  type ModuleWorkerSpec,
  parseModuleWorkerSpec,
  parseWorkerDeploymentSpec,
  parseWorkerEndpointSpec,
  parseWorkerVersionSpec,
  validateModuleWorkerUpdate,
  validateWorkerDeploymentUpdate,
  validateWorkerEndpointUpdate,
  validateWorkerVersionUpdate,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
  type WorkerDeploymentSpec,
  type WorkerEndpointSpec,
  WorkerFormValidationError,
  type WorkerVersionSpec,
} from "./forms/worker-specs.ts";
export type {
  V2Backend,
  V2BackendResult,
  V2Execution,
  V2Form,
  V2ReferenceRequirement,
} from "./types.ts";
export {
  createV2WorkerInvocationLifecycle,
  type V2WorkerInvocationAdmission,
  type V2WorkerInvocationCustody,
  type V2WorkerInvocationHandle,
  type V2WorkerInvocationRecord,
  type V2WorkerInvocationRetirementIdentity,
  type V2WorkerInvocationRetirementInput,
  type V2WorkerInvocationSelection,
} from "./worker-invocation-custody.ts";
export {
  createV2NativeDeletionCustody,
  type V2NativeDeletionCustody,
  type V2NativeDeletionInspection,
  type V2NativeDeletionItem,
} from "./worker-native-deletions.ts";
export {
  createV2NativeEffectCustody,
  type V2NativeEffectCustody,
  type V2NativeEffectIdentity,
  type V2NativeEffectInspection,
} from "./worker-native-effects.ts";
export {
  createV2WorkerPublicationState,
  type V2WorkerPublicationResolution,
  type V2WorkerPublicationSnapshot,
  type V2WorkerPublicationSqlGuard,
  type V2WorkerVersionMaterialScopeResolution,
  type V2WorkerVersionMaterialScopes,
  type V2WorkerVersionMaterials,
  type V2WorkerVersionResolution,
  type V2WorkerVersionSnapshot,
} from "./worker-publication-state.ts";
