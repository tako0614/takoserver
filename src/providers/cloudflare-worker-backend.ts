import type { JsonObject } from "../ports.ts";
import type {
  ApplyInput,
  ProviderApplyNoEffectConclusionInput,
  ProviderApplyNoEffectConclusionResult,
  ProviderArtifactConsumption,
  ProviderArtifactConsumptionInput,
  ProviderExecutionAuthority,
  ProviderNativeAbsence,
  ProviderNativeReadbackDescriptor,
  ProviderNativeReadbackInput,
  ProviderOffering,
  ProviderReadAuthorityTarget,
  ProviderRelation,
  ProviderSqliteMigration,
  ProviderSqliteMigrationIdentity,
  ProviderTicket,
  ProviderValue,
  ResourceIdentity,
} from "../provider-port.ts";
import type { ProviderRuntimeInputLeasePort } from "../provider-runtime-input-port.ts";
import type { CloudflareZone } from "./cloudflare.ts";

export interface CloudflareOrdinaryWorkerBackendOptions {
  readonly kind: "ordinary-workers";
  /** Exact account suffix, for example `team.workers.dev`. */
  readonly workerEndpointSuffix?: string;
}

/** Provider/operator-only status for one exact ObjectBucket incarnation. */
export interface CloudflareManagedObjectBucketReceiptStatus {
  readonly lifecycle: "active" | "destroying";
  readonly receiptCount: number;
  readonly operatorReconciliationRequired: number;
  /** True for a permanent ambiguous receipt or any uncommitted destruction fence. */
  readonly repairRequired: boolean;
  readonly nextActionAt: number | null;
}

export interface CloudflareManagedScheduleReconciliationStatus {
  readonly state:
    | "idle"
    | "leased"
    | "operator_reconciliation_required"
    | "portable_clock_cutover_required"
    | "absent";
  readonly desiredGeneration: number | null;
  readonly appliedGeneration: number | null;
  readonly appliedDigest: `sha256:${string}` | null;
  readonly desiredSchedules: readonly string[];
  readonly actualSchedules: readonly string[];
  readonly actualDigest: `sha256:${string}`;
  /** Null when a bounded read cannot prove the complete, valid inventory. */
  readonly membershipCount: number | null;
  readonly membershipCapacity: number;
  readonly nativeProjectionSchedules: readonly string[];
  readonly routeAuthorityDigest: `sha256:${string}` | null;
  readonly nativeProjectionDigest: `sha256:${string}` | null;
  readonly clockClosure: "legacy-v1" | "portable-v2" | "unresolved";
  readonly leaseToken: string | null;
  readonly leaseUntil: number | null;
  readonly ambiguousGeneration: number | null;
  readonly ambiguityReason: "lease_expired" | "mutation_indeterminate" | null;
}

/** Provider/operator library contract only; not part of the portable Host API. */
export type CloudflareManagedScheduleOperatorProof =
  | {
      readonly operatorAcknowledgement: string;
      readonly leaseToken: string;
      readonly ambiguousGeneration: number;
      readonly desiredGeneration: number;
      readonly actualDigest: `sha256:${string}`;
      readonly action: "accept-provider-state" | "replace-with-desired";
    }
  | {
      readonly action: "cutover-portable-clock";
      readonly operatorAcknowledgement: string;
      readonly desiredGeneration: number;
      readonly legacyAppliedDigest: `sha256:${string}`;
      readonly actualDigest: `sha256:${string}`;
    };

export type CloudflareWorkerBackendOptions =
  | CloudflareOrdinaryWorkerBackendOptions
  | CloudflareWorkersForPlatformsBackendFactoryOptions;

export interface ArtifactBytes {
  manifest(tenantRef: string, digest: string): Promise<TakoformBundleManifest | null>;
  blob(digest: string): Promise<Uint8Array | null>;
}

export interface TakoformBundleManifest {
  readonly kind: string;
  readonly mainModule?: string;
  readonly modules?: readonly {
    readonly name: string;
    readonly mediaType: string;
    readonly size?: number;
    readonly digest: string;
  }[];
  readonly files?: readonly {
    readonly path: string;
    readonly mediaType: string;
    readonly size: number;
    readonly digest: string;
  }[];
}

export interface CloudflareWorkerDeleteInput {
  readonly operationId: string;
  readonly operationMode?: "initial" | "recovery";
  readonly providerHandle?: string;
  readonly executionAuthority?: ProviderExecutionAuthority;
  readonly offering: ProviderOffering;
  readonly nativeId: string;
  readonly identity: ResourceIdentity;
  readonly spec?: JsonObject;
  readonly relations?: readonly ProviderRelation[];
}

/** Adoption identity shared by the Cloudflare provider and its Worker backend. */
export interface CloudflareWorkerAdoptInput {
  readonly operationId: string;
  readonly operationMode?: "initial" | "recovery";
  readonly providerHandle?: string;
  readonly offering: ProviderOffering;
  readonly nativeId: string;
  readonly identity: ResourceIdentity;
  readonly spec: JsonObject;
  readonly relations?: readonly ProviderRelation[];
}

/** One complete Worker placement lifecycle behind the Cloudflare adapter. */
export interface CloudflareWorkerBackend {
  readonly kind: "ordinary-workers" | "workers-for-platforms";
  deriveOrigin(input: {
    readonly tenantRef: string;
    readonly requestedSubdomain: string;
  }): Promise<{ readonly canonicalPublicOrigin: string } | null>;
  /** True for every Worker-shaped offering this backend must own or reject. */
  owns(offering: ProviderOffering): boolean;
  apply(input: ApplyInput): Promise<ProviderTicket>;
  recoverApply(input: ApplyInput): Promise<ProviderTicket>;
  convergeApply(input: ApplyInput): Promise<ProviderTicket>;
  /** Optional closed create-abort authority owned by the managed backend. */
  concludeApplyNoEffect?(
    input: ProviderApplyNoEffectConclusionInput,
  ): Promise<ProviderApplyNoEffectConclusionResult>;
  observe(input: {
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec: JsonObject;
    readonly relations?: readonly ProviderRelation[];
  }): Promise<ProviderTicket>;
  /** Optional backend-owned adoption; omission refuses without ordinary fallback. */
  adopt?(input: CloudflareWorkerAdoptInput): Promise<ProviderTicket>;
  /** Optional read-only adoption recovery; omission refuses without ordinary fallback. */
  recoverAdopt?(input: CloudflareWorkerAdoptInput): Promise<ProviderTicket>;
  delete(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket>;
  recoverDelete(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket>;
  createNativeReadbackDescriptor(
    input: ProviderNativeReadbackInput,
  ): ProviderNativeReadbackDescriptor;
  verifyNativeAbsence(input: {
    readonly offering: ProviderOffering;
    readonly descriptor: ProviderNativeReadbackDescriptor;
    /** Route-less read authority; adapters must not reconstruct it from descriptor data. */
    readonly target?: ProviderReadAuthorityTarget;
  }): Promise<ProviderNativeAbsence>;
  verifyArtifactConsumption(
    input: ProviderArtifactConsumptionInput,
  ): Promise<ProviderArtifactConsumption>;
  readSqliteMigrationLedger?(input: {
    readonly nativeId: string;
  }): Promise<ProviderValue<readonly ProviderSqliteMigrationIdentity[]>>;
  applySqliteMigrationSuffix?(input: {
    readonly nativeId: string;
    readonly expectedPrefix: readonly ProviderSqliteMigrationIdentity[];
    readonly migrations: readonly ProviderSqliteMigration[];
  }): Promise<ProviderValue<undefined>>;
  managedScheduleReconciliationStatus?(): Promise<
    ProviderValue<CloudflareManagedScheduleReconciliationStatus>
  >;
  reconcileManagedSchedules?(
    proof: CloudflareManagedScheduleOperatorProof,
  ): Promise<ProviderValue<CloudflareManagedScheduleReconciliationStatus>>;
  managedObjectBucketReceiptStatus?(input: {
    readonly identity: ResourceIdentity;
    readonly bucketName: string;
  }): Promise<ProviderValue<CloudflareManagedObjectBucketReceiptStatus>>;
  /** Read-only vacancy proof required before a managed ObjectBucket destroy. */
  managedObjectBucketVacancy?(input: {
    readonly identity: ResourceIdentity;
    readonly bucketName: string;
  }): Promise<ProviderValue<{ readonly empty: boolean }>>;
  prepareManagedObjectBucketDestroy?(input: {
    readonly identity: ResourceIdentity;
    readonly bucketName: string;
    /** Opaque-handle binding on recovery; omitted only on the initial call. */
    readonly authorityProof?: string;
  }): Promise<
    ProviderValue<{
      readonly state: "draining" | "prepared";
      readonly authorityProof: string;
    }>
  >;
  commitManagedObjectBucketDestroy?(input: {
    readonly identity: ResourceIdentity;
    readonly bucketName: string;
    readonly authorityProof: string;
  }): Promise<ProviderValue<{ readonly destroyed: true }>>;
}

/**
 * Provider-owned values made available to a managed backend factory.
 *
 * Private Workers-for-Platforms authority (namespace, gateway, SQL, and
 * installation identity) stays in the composing caller's closure; this seam
 * carries only the normalized values the provider itself owns.
 */
export interface CloudflareWorkerBackendFactoryContext {
  readonly providerId: string;
  readonly accountId: string;
  readonly apiOrigin: string;
  readonly authorize: () => Promise<string> | string;
  readonly fetch: (request: Request) => Promise<Response>;
  readonly artifacts: ArtifactBytes;
  readonly offerings: readonly ProviderOffering[];
  readonly runtimeInputs?: ProviderRuntimeInputLeasePort;
  readonly workerCompatibilityDate: string;
  readonly zoneFor: (hostname: string, tenantRef: string) => CloudflareZone | undefined;
}

/** In-process managed backend composition; never a wire or public Form DTO. */
export interface CloudflareWorkersForPlatformsBackendFactoryOptions {
  readonly kind: "workers-for-platforms";
  readonly create: (
    context: Readonly<CloudflareWorkerBackendFactoryContext>,
  ) => CloudflareWorkerBackend;
}
