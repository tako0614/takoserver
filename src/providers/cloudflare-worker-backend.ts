import type { JsonObject, Sql } from "../ports.ts";
import type {
  ApplyInput,
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
  /** Provider-only capability for the gateway's external SQLite DO class. */
  readonly sqliteNamespace: CloudflareManagedSqliteNamespace;
}

export interface CloudflareManagedSqliteStub {
  takoserverSqliteInitialize(
    input: ManagedWorkerSqliteAuthority,
  ): Promise<ManagedWorkerSqliteAdminResult<{ readonly state: "active" }>>;
  takoserverSqliteInspect(
    input: ManagedWorkerSqliteAuthority,
  ): Promise<ManagedWorkerSqliteAdminResult<ManagedWorkerSqliteInspectResult>>;
  takoserverSqliteReadMigrationLedger(
    input: ManagedWorkerSqliteAuthority,
  ): Promise<ManagedWorkerSqliteAdminResult<readonly ManagedWorkerSqliteMigrationIdentity[]>>;
  takoserverSqliteApplyMigrationSuffix(input: {
    readonly authority: ManagedWorkerSqliteAuthority;
    readonly expectedPrefix: readonly ManagedWorkerSqliteMigrationIdentity[];
    readonly migrations: readonly ManagedWorkerSqliteMigration[];
  }): Promise<ManagedWorkerSqliteAdminResult<undefined>>;
  takoserverSqliteDestroy(
    input: ManagedWorkerSqliteAuthority,
  ): Promise<ManagedWorkerSqliteAdminResult<{ readonly destroyed: true }>>;
}

export interface CloudflareManagedSqliteNamespace {
  getByName(instanceName: string): CloudflareManagedSqliteStub;
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
}
