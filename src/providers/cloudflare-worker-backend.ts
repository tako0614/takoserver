import type { JsonObject, Sql } from "../ports.ts";
import type {
  ApplyInput,
  ProviderArtifactConsumption,
  ProviderArtifactConsumptionInput,
  ProviderNativeAbsence,
  ProviderNativeReadbackDescriptor,
  ProviderNativeReadbackInput,
  ProviderOffering,
  ProviderSqliteMigration,
  ProviderSqliteMigrationIdentity,
  ProviderTicket,
  ProviderValue,
  ResourceIdentity,
} from "../provider-port.ts";
import type {
  ManagedObjectReceiptAuthority,
  ManagedObjectReceiptResult,
} from "./cloudflare-managed-object-receipt.ts";
import type {
  ManagedWorkerSqliteAdminOperation,
  ManagedWorkerSqliteAdminResult,
  ManagedWorkerSqliteAuthority,
  ManagedWorkerSqliteInspectResult,
  ManagedWorkerSqliteMigration,
  ManagedWorkerSqliteMigrationIdentity,
} from "./cloudflare-managed-worker-sqlite.ts";

export interface CloudflareOrdinaryWorkerBackendOptions {
  readonly kind: "ordinary-workers";
  /** Exact account suffix, for example `team.workers.dev`. */
  readonly workerEndpointSuffix?: string;
}

export interface CloudflareManagedReleaseInspectionInput {
  readonly scriptName: string;
  readonly descriptorDigest: `sha256:${string}`;
  readonly operationId: string;
  readonly declaredHandlers: readonly ("fetch" | "queue" | "scheduled")[];
}

export type CloudflareManagedReleaseInspection =
  | {
      readonly ok: true;
      readonly scriptName: string;
      readonly descriptorDigest: `sha256:${string}`;
      readonly operationId: string;
      readonly handlers: readonly ("fetch" | "queue" | "scheduled")[];
    }
  | { readonly ok: false; readonly retryable: boolean };

export interface CloudflareManagedReleaseReadbackQualification {
  readonly schema: "takoserver.cloudflare-wfp-release-readback-qualification@v1";
  /** Must be the exact namespace rehearsed by the owning deploy surface. */
  readonly dispatchNamespace: string;
  /** Digest of the recorded multi-module upload/content/settings/ETag rehearsal artifact. */
  readonly rehearsalDigest: `sha256:${string}`;
}

export interface CloudflareWorkersForPlatformsBackendOptions {
  readonly kind: "workers-for-platforms";
  readonly dispatchNamespace: string;
  readonly gatewayWorkerName: string;
  /** Exact ProviderInstallation whose Resources this backend may bind. */
  readonly providerInstallationId: string;
  /** Exact operator-owned suffix, without a leading dot. */
  readonly managedBaseDomain: string;
  /** Provider-private D1 authority shared with the gateway as STATE_DB. */
  readonly sql: Sql;
  /** Trusted, provider-only dispatch that imports and inspects a release. */
  readonly inspectRelease: (
    input: CloudflareManagedReleaseInspectionInput,
  ) => Promise<CloudflareManagedReleaseInspection>;
  /**
   * Enables adoption of a present script after upload acknowledgement loss.
   * Omission is fail-closed: acknowledged uploads still commit normally, but
   * a pending receipt cannot infer undocumented GET content round-tripping.
   */
  readonly releaseReadbackQualification?: CloudflareManagedReleaseReadbackQualification;
  /** HMACs provider-private SQLite DO instance names; raw resource UIDs never enter bindings. */
  readonly deriveSqliteInstanceName: (input: {
    readonly providerId: string;
    readonly resourceUid: string;
    readonly generation: string;
  }) => Promise<string>;
  /**
   * Seals one SQLite admin operation on one authority tuple.
   *
   * The tuple itself is derivable by the customer whose Resource it describes,
   * so it authorizes nothing; this proof is what the Durable Object checks
   * before it claims, migrates, inspects, or destroys. The secret behind it is
   * the gateway's `TAKOSERVER_MANAGED_SQLITE_ADMIN_SECRET` binding, which a
   * tenant Worker never holds.
   */
  readonly sealSqliteAdminProof: (input: {
    readonly operation: ManagedWorkerSqliteAdminOperation;
    readonly authority: ManagedWorkerSqliteAuthority;
  }) => Promise<string>;
  /** Provider-only capability for the gateway's external SQLite DO class. */
  readonly sqliteNamespace: CloudflareManagedSqliteNamespace;
  /**
   * Route-less authority script that owns the receipt Durable Object and all
   * R2 S3/proof credentials. This name is embedded only in provider-authored
   * tenant Version metadata; it is never accepted from a tenant declaration.
   */
  readonly objectReceiptWorkerName?: string;
  /**
   * Narrow cross-script RPC capability. The caller never receives the proof
   * secret or an administrative Durable Object namespace.
   */
  readonly objectReceiptAuthority?: CloudflareManagedObjectReceiptAuthority;
}

export interface CloudflareManagedObjectReceiptRuntimeBinding {
  readonly instanceName: string;
  readonly proof: string;
}

export interface CloudflareManagedObjectReceiptDestroyPreparation {
  readonly state: "draining" | "prepared";
  /** Opaque prepare proof retained only inside the provider recovery handle. */
  readonly authorityProof: string;
}

/** RPC surface exported only by the route-less receipt-authority Worker. */
export interface CloudflareManagedObjectReceiptAuthority {
  takoserverObjectReceiptRuntimeBinding(input: {
    readonly authority: ManagedObjectReceiptAuthority;
    readonly bucketName: string;
  }): Promise<ManagedObjectReceiptResult<CloudflareManagedObjectReceiptRuntimeBinding>>;
  takoserverObjectReceiptInspect(input: {
    readonly authority: ManagedObjectReceiptAuthority;
    readonly bucketName: string;
  }): Promise<
    ManagedObjectReceiptResult<{
      readonly schemaVersion: 2;
      readonly lifecycle: "active" | "destroying";
      readonly authority: ManagedObjectReceiptAuthority | null;
      readonly bucketName: string | null;
      readonly receiptCount: number;
      readonly operatorReconciliationRequired: number;
      readonly nextActionAt: number | null;
    }>
  >;
  takoserverObjectReceiptPrepareDestroy(input: {
    readonly authority: ManagedObjectReceiptAuthority;
    readonly bucketName: string;
    readonly authorityProof?: string;
  }): Promise<ManagedObjectReceiptResult<CloudflareManagedObjectReceiptDestroyPreparation>>;
  takoserverObjectReceiptCommitDestroy(input: {
    readonly authority: ManagedObjectReceiptAuthority;
    readonly bucketName: string;
    readonly authorityProof: string;
  }): Promise<ManagedObjectReceiptResult<{ readonly destroyed: true }>>;
}

/** Every admin call carries the authority tuple and the proof that seals it. */
export interface CloudflareManagedSqliteAdminRequest {
  readonly authority: ManagedWorkerSqliteAuthority;
  readonly proof: string;
}

export interface CloudflareManagedSqliteStub {
  takoserverSqliteInitialize(
    input: CloudflareManagedSqliteAdminRequest,
  ): Promise<ManagedWorkerSqliteAdminResult<{ readonly state: "active" }>>;
  takoserverSqliteInspect(
    input: CloudflareManagedSqliteAdminRequest,
  ): Promise<ManagedWorkerSqliteAdminResult<ManagedWorkerSqliteInspectResult>>;
  takoserverSqliteReadMigrationLedger(
    input: CloudflareManagedSqliteAdminRequest,
  ): Promise<ManagedWorkerSqliteAdminResult<readonly ManagedWorkerSqliteMigrationIdentity[]>>;
  takoserverSqliteApplyMigrationSuffix(
    input: CloudflareManagedSqliteAdminRequest & {
      readonly expectedPrefix: readonly ManagedWorkerSqliteMigrationIdentity[];
      readonly migrations: readonly ManagedWorkerSqliteMigration[];
    },
  ): Promise<ManagedWorkerSqliteAdminResult<undefined>>;
  takoserverSqliteDestroy(
    input: CloudflareManagedSqliteAdminRequest,
  ): Promise<ManagedWorkerSqliteAdminResult<{ readonly destroyed: true }>>;
}

export interface CloudflareManagedSqliteNamespace {
  getByName(instanceName: string): CloudflareManagedSqliteStub;
}

/** Narrow service-binding RPC exported by the public dispatcher for SQLite authority. */
export interface CloudflareManagedWorkerGatewayAuthority {
  deriveSqliteInstanceName(input: {
    readonly providerId: string;
    readonly resourceUid: string;
    readonly generation: string;
  }): Promise<string>;
  sealSqliteAdminProof(input: {
    readonly operation: ManagedWorkerSqliteAdminOperation;
    readonly authority: ManagedWorkerSqliteAuthority;
  }): Promise<string>;
}

export interface CloudflareManagedObjectReceiptAdminRequest {
  readonly authority: ManagedObjectReceiptAuthority;
  readonly bucketName: string;
  readonly proof: string;
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

export interface CloudflareManagedObjectReceiptStub {
  takoserverObjectReceiptInspect(input: CloudflareManagedObjectReceiptAdminRequest): Promise<
    ManagedObjectReceiptResult<{
      readonly schemaVersion: 2;
      readonly lifecycle: "active" | "destroying";
      readonly authority: ManagedObjectReceiptAuthority | null;
      readonly bucketName: string | null;
      readonly receiptCount: number;
      readonly operatorReconciliationRequired: number;
      readonly nextActionAt: number | null;
    }>
  >;
  takoserverObjectReceiptPrepareDestroy(
    input: CloudflareManagedObjectReceiptAdminRequest,
  ): Promise<ManagedObjectReceiptResult<{ readonly state: "draining" | "prepared" }>>;
  takoserverObjectReceiptCommitDestroy(
    input: CloudflareManagedObjectReceiptAdminRequest,
  ): Promise<ManagedObjectReceiptResult<{ readonly destroyed: true }>>;
}

export interface CloudflareManagedObjectReceiptNamespace {
  getByName(instanceName: string): CloudflareManagedObjectReceiptStub;
}

export interface CloudflareManagedScheduleReconciliationStatus {
  readonly state: "idle" | "leased" | "operator_reconciliation_required" | "absent";
  readonly desiredGeneration: number | null;
  readonly appliedGeneration: number | null;
  readonly appliedDigest: `sha256:${string}` | null;
  readonly desiredSchedules: readonly string[];
  readonly actualSchedules: readonly string[];
  readonly actualDigest: `sha256:${string}`;
  readonly leaseToken: string | null;
  readonly leaseUntil: number | null;
  readonly ambiguousGeneration: number | null;
  readonly ambiguityReason: "lease_expired" | "mutation_indeterminate" | null;
}

export interface CloudflareManagedScheduleOperatorProof {
  readonly operatorAcknowledgement: string;
  readonly leaseToken: string;
  readonly ambiguousGeneration: number;
  readonly desiredGeneration: number;
  readonly actualDigest: `sha256:${string}`;
  readonly action: "accept-provider-state" | "replace-with-desired";
}

export type CloudflareWorkerBackendOptions =
  | CloudflareOrdinaryWorkerBackendOptions
  | CloudflareWorkersForPlatformsBackendOptions;

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
  readonly offering: ProviderOffering;
  readonly nativeId: string;
  readonly identity: ResourceIdentity;
  readonly spec?: JsonObject;
  readonly relations?: readonly import("../provider-port.ts").ProviderRelation[];
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
  observe(input: {
    readonly offering: ProviderOffering;
    readonly nativeId: string;
    readonly identity: ResourceIdentity;
    readonly spec: JsonObject;
    readonly relations?: readonly import("../provider-port.ts").ProviderRelation[];
  }): Promise<ProviderTicket>;
  delete(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket>;
  recoverDelete(input: CloudflareWorkerDeleteInput): Promise<ProviderTicket>;
  createNativeReadbackDescriptor(
    input: ProviderNativeReadbackInput,
  ): ProviderNativeReadbackDescriptor;
  verifyNativeAbsence(input: {
    readonly offering: ProviderOffering;
    readonly descriptor: ProviderNativeReadbackDescriptor;
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
