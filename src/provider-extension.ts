/**
 * In-process extension seam for an operator-selected provider implementation.
 *
 * This source/package surface is not the Takoform Host API, an RPC credential
 * carrier, or a second lifecycle authority. Concrete WfP construction belongs
 * to the operator composition, not the shared Cloudflare adapter.
 */
export { createCloudflareProviderSurface } from "./cloudflare-provider-surface.ts";
export { buildEdgeForms } from "./edge-forms.ts";
export { isEdgeFormsApiVersion } from "./form-ref.ts";
export {
  HOSTED_EDGE_IDENTITY_CLASSES,
  HOSTED_EDGE_SUPPLIES_KIND,
  type HostedEdgeIdentityKind,
  type HostedEdgeSupplies,
  hostedEdgeSuppliesJson,
  parseHostedEdgeSupplies,
} from "./hosted-edge-supplies.ts";
export {
  HOSTED_OBJECT_BUCKET_SUPPLIES_KIND,
  type HostedObjectBucketSupplies,
  hostedObjectBucketSuppliesJson,
  parseHostedObjectBucketSupplies,
  parseHostedProviderInstallation,
} from "./hosted-object-bucket-supplies.ts";
export { base64UrlEncode, bytesDigest, canonicalDigest, canonicalJson } from "./json.ts";
export { createR2ObjectStore } from "./objects-r2.ts";
export type { JsonObject, JsonValue, Sql } from "./ports.ts";
export type {
  MeterSource,
  ProviderMeterDeployment,
  ProviderMeterUsage,
} from "./provider-meter-port.ts";
export { createProviderPack, type ProviderPackDefinition } from "./provider-pack.ts";
export {
  type ApplyInput,
  failed,
  failedWithoutProviderMutation,
  PROVIDER_READBACK_API_VERSION,
  type Provider,
  type ProviderArtifactConsumption,
  type ProviderArtifactConsumptionInput,
  type ProviderExecutionAuthority,
  type ProviderNativeAbsence,
  type ProviderNativeReadbackDescriptor,
  type ProviderNativeReadbackInput,
  type ProviderOffering,
  ProviderReadbackDescriptorError,
  type ProviderRelation,
  type ProviderSqliteMigration,
  type ProviderSqliteMigrationIdentity,
  type ProviderTicket,
  type ProviderValue,
  type ResourceIdentity,
  succeeded,
} from "./provider-port.ts";
export type {
  ProviderRuntimeInputDispatchedLease,
  ProviderRuntimeInputLease,
  ProviderRuntimeInputLeasePort,
  ProviderRuntimeInputPublicApply,
  ProviderRuntimeInputRecoveryLease,
} from "./provider-runtime-input-port.ts";
export {
  canonicalWorkerEndpointOrigin,
  derivedProviderResourceIncarnationName,
  derivedProviderResourceName,
} from "./provider-worker-endpoint-origin.ts";
export { signAwsV4Request } from "./providers/aws-sigv4.ts";
export {
  CloudflareProvider,
  type CloudflareProviderOptions,
  type CloudflareZone,
} from "./providers/cloudflare.ts";
export { createCloudflareEdgeMeterSources } from "./providers/cloudflare-edge-meter.ts";
export {
  CLOUDFLARE_PROVIDER_METER_SOURCES,
  type CloudflareProviderMeterSourceDescriptor,
  cloudflareProviderMeterSourceForOfferingKind,
} from "./providers/cloudflare-edge-meter-contract.ts";
export {
  boundedString,
  digest,
  digestArray,
  isCloudflareProviderArtifactConsumption,
  jsonObject,
  maybeExactRecord,
  plainRecord,
} from "./providers/cloudflare-provider-executor-codec.ts";
export type {
  CloudflareProviderAdoptInput,
  CloudflareProviderDeleteInput,
  CloudflareProviderExecutorRpc,
  CloudflareProviderMeterReadInput,
  CloudflareProviderObserveInput,
  CloudflareProviderPollInput,
  CloudflareProviderSqliteMigrationApplyInput,
  CloudflareProviderSqliteMigrationReadInput,
  CloudflareProviderVerifyArtifactConsumptionInput,
  CloudflareProviderVerifyNativeAbsenceInput,
} from "./providers/cloudflare-provider-executor-port.ts";
export {
  CloudflareProviderProxy,
  createCloudflareProviderMeterProxySources,
} from "./providers/cloudflare-provider-proxy.ts";
export { createCloudflareR2MeterSource } from "./providers/cloudflare-r2-meter.ts";
export {
  cloudflareExecutorDirectOwnsOffering,
  cloudflareWfpOwnsOffering,
  validateCloudflareNativeReadbackDescriptor,
} from "./providers/cloudflare-readback-descriptor.ts";
export {
  CLOUDFLARE_R2_EDGE_OBJECTS_MATERIAL_KIND,
  cloudflareR2EdgeObjectsMaterial,
  EDGE_OBJECTS_BINDING_REF,
} from "./providers/cloudflare-runtime-bindings.ts";
export type {
  ArtifactBytes,
  CloudflareManagedObjectBucketReceiptStatus,
  CloudflareManagedScheduleOperatorProof,
  CloudflareManagedScheduleReconciliationStatus,
  CloudflareOrdinaryWorkerBackendOptions,
  CloudflareWorkerBackend,
  CloudflareWorkerBackendFactoryContext,
  CloudflareWorkerDeleteInput,
  CloudflareWorkersForPlatformsBackendFactoryOptions,
} from "./providers/cloudflare-worker-backend.ts";
export {
  createHttpRevisionServing,
  type HttpRevisionBackendObservation,
  type HttpRevisionServingBackend,
  type HttpRevisionServingCoordinator,
  HttpRevisionServingError,
  type HttpRevisionServingErrorCode,
  type HttpRevisionServingHandle,
  type HttpRevisionServingIdentity,
  type HttpRevisionServingObservation,
  type HttpRevisionServingOptions,
  type HttpRevisionServingRevision,
  type HttpRevisionServingRevisionRecord,
  type HttpRevisionServingSnapshot,
  type HttpRevisionServingStatePort,
} from "./providers/http-revision-serving.ts";
export { ProviderMeterError } from "./providers/provider-meter.ts";
export {
  assertSafeMigrationSql,
  MigrationSqlCapacityError,
  prepareMigrationSql,
} from "./providers/sqlite-migration-policy.ts";
export {
  TAKOSERVER_MANAGED_WORKER_EVENT_CONTENT_TYPE,
  TAKOSERVER_MANAGED_WORKER_EVENT_PATH,
  TAKOSERVER_MANAGED_WORKER_EVENT_PROTOCOL,
  TAKOSERVER_MANAGED_WORKER_EVENT_RESPONSE_CONTENT_TYPE,
} from "./providers/worker-event-protocol.ts";
export {
  semanticInspectionPreludeSource,
  snapshotWorkerModuleInspectionInput,
  WORKER_MODULE_AUXILIARY_MEDIA_TYPES,
  WORKER_MODULE_IMPORTABLE_MEDIA_TYPES,
  type WorkerModuleMediaType,
} from "./providers/worker-module-semantic-inspection.ts";
export {
  createQueueCustody,
  type QueueCustody,
  type QueueCustodyAdmission,
  type QueueCustodyClaimedMessage,
  QueueCustodyConflictError,
  type QueueCustodyConsumerGeneration,
  type QueueCustodyDeadLetterTarget,
  type QueueCustodyOptions,
  type QueueCustodyRetirementCompletion,
  type QueueCustodyRetirementStatus,
  type QueueCustodyRetryPolicy,
  type QueueCustodyTarget,
} from "./queue-custody.ts";
export { createRuntimeInputAuthority } from "./runtime-input-preparations.ts";
export { parseRuntimeInputSealKeyRing } from "./runtime-input-seal-keyring.ts";
export { createD1Sql } from "./sql-d1.ts";
export { createTakoformArtifacts } from "./takoform/artifacts.ts";
export { currentTakoformCandidates } from "./takoform/current-candidates.ts";
export {
  MAXIMUM_REQUEST_BODY_BYTES,
  TAKOFORM_MAXIMUM_FILE_BUNDLE_FILES,
  TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES,
} from "./takoform/limits.ts";
export { createWorkerProductionComposition } from "./worker-production-composition.ts";
