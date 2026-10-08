/**
 * Source extension seam for an operator-owned v2 backend.
 *
 * Resource and Operation authority remains with the public v2 SQL engine.
 * This entrypoint only reexports its existing contracts and the read-only
 * Worker publication resolver; it does not register Forms or publish traffic.
 */
export type { JsonObject, Sql } from "../ports.ts";
export {
  readV2ConfiguredPrivateInputs,
  type V2ConfiguredPrivateInputIdentity,
  type V2ConfiguredPrivateInputs,
} from "./configured-private-inputs.ts";
export {
  createV2EdgeKvNativeCustody,
  type V2EdgeKvConfirmedIdentity,
  type V2EdgeKvCreateInspection,
  type V2EdgeKvCreateIntent,
  type V2EdgeKvDeleteGrant,
  type V2EdgeKvDeleteInspection,
  type V2EdgeKvSettledTarget,
  type V2EdgeKvSettledTargetInput,
} from "./edge-kv-native-custody.ts";
export { AT_LEAST_ONCE_QUEUE_FORM_URL } from "./forms/at-least-once-queue.ts";
export {
  EDGE_KV_NAMESPACE_FORM_URL,
  EDGE_KV_NAMESPACE_LIMITS,
  EdgeKVNamespaceValidationError,
  parseEdgeKVNamespaceSpec,
  validateEdgeKVNamespaceUpdate,
} from "./forms/edge-kv-namespace.ts";
export {
  createEdgeKVNamespaceForm,
  EDGE_KV_NAMESPACE_BACKEND_ID,
  type EdgeKVNamespaceFormOptions,
  type EdgeKVNamespaceIdentity,
  type EdgeKVNamespaceStore,
} from "./forms/edge-kv-namespace-backend.ts";
export {
  createQueueWorkerBindingAuthority,
  type QueueWorkerBindingClaim,
  type QueueWorkerBindingResolution,
} from "./forms/queue-worker-binding-authority.ts";
export {
  parseSQLiteDatabaseSpec,
  SQLITE_DATABASE_FORM_URL,
  validateSQLiteDatabaseUpdate,
} from "./forms/sqlite-database.ts";
export { createSQLiteDatabaseForm } from "./forms/sqlite-database-backend.ts";
export type { SQLiteDatabaseNativePort } from "./forms/sqlite-native-store-port.ts";
export {
  createSQLiteWorkerBindingAuthority,
  type SQLiteWorkerBindingClaim,
} from "./forms/sqlite-worker-binding-authority.ts";
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
export {
  createInternalV2ModuleWorkerForm,
  type V2WorkerRetirementReader,
  type V2WorkerServingReader,
} from "./module-worker-lifecycle-backend.ts";
export type {
  V2PrivateInputCustody,
  V2PrivateInputKey,
  V2PrivateInputMap,
} from "./private-inputs.ts";
export {
  createV2ServiceBindingAuthority,
  type V2ServiceBindingClaim,
  type V2ServiceBindingResolution,
} from "./service-binding-authority.ts";
export type {
  V2Backend,
  V2BackendResult,
  V2Execution,
  V2Form,
  V2ReferenceRequirement,
} from "./types.ts";
export {
  inspectV2WorkerCodeVersionEligibility,
  type V2WorkerModuleInspector,
} from "./worker-code-eligibility.ts";
export {
  runWorkerCronTriggerTick,
  type WorkerCronTriggerDelivery,
  type WorkerCronTriggerDeliveryResult,
  type WorkerCronTriggerScanContinuation,
  type WorkerCronTriggerTickResult,
} from "./worker-cron-trigger-scheduler.ts";
export {
  createV2WorkerInvocationLifecycle,
  type V2WorkerCronInvocationClaim,
  type V2WorkerCronRouteRelease,
  type V2WorkerInvocationAdmission,
  type V2WorkerInvocationCustody,
  type V2WorkerInvocationHandle,
  type V2WorkerInvocationIngress,
  type V2WorkerInvocationRecord,
  type V2WorkerInvocationRetirementIdentity,
  type V2WorkerInvocationRetirementInput,
  type V2WorkerInvocationSelection,
} from "./worker-invocation-custody.ts";
export {
  inspectV2WorkerInvocationSchema,
  type V2WorkerInvocationSchema,
  v2WorkerInvocationSchemaReady,
} from "./worker-invocation-schema.ts";
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
export {
  createAtLeastOnceQueueForm,
  V2_QUEUE_BACKEND_ID,
} from "./worker-queue-backend.ts";
export {
  exactV2ResolvedServiceBindings,
  projectV2ResolvedServiceBindings,
  type V2ResolvedServiceBinding,
} from "./worker-service-resolution.ts";
export {
  createV2WorkerVersionConfiguredInputSealer,
  type V2WorkerVersionConfiguredKeyring,
  type V2WorkerVersionPrivateIdentity,
  type V2WorkerVersionSealedInputs,
} from "./worker-version-configured-inputs.ts";
