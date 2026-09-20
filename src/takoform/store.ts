import { canonicalDigest, canonicalJson } from "../json.ts";
import {
  type LedgerHeldCharge,
  ledgerHoldReleaseCommittedFence,
  prepareLedgerHoldRelease,
} from "../ledger.ts";
import type { Clock, JsonObject, Row, Sql, SqlParam, SqlStatement } from "../ports.ts";
import { SqlError } from "../ports.ts";
import {
  RESOURCE_EXECUTION_EVIDENCE_FORMAT,
  type ResourceExecutionCommit,
  type ResourceExecutionEvidenceResponse,
} from "../resource-execution-evidence.ts";
import {
  encodeTakoformApplySelection,
  parseTakoformApplySelection,
  type TakoformApplySelection,
} from "./apply-selection.ts";
import {
  decodeResourceDependencySet,
  isResourceDependencyClaimKey,
  RESOURCE_DEPENDENCY_PRIVATE_HOLDER,
  type ResourceDependencySet,
  resourceDependencyClaimKeys,
  resourceDependencyClaimRange,
  resourceDependencyTargetClaimRange,
} from "./dependency-fence.ts";
import type { TakoformAuthorityFence } from "./host-authority.ts";
import {
  OPERATION_TTL_MILLISECONDS,
  PROVIDER_REPAIR_HOLD_TTL_MILLISECONDS,
  REPLAY_TTL_MILLISECONDS,
  SWEEP_ROW_LIMIT,
} from "./limits.ts";
import type { TakoformStoredRelation } from "./relations.ts";
import {
  crossResourcePrecondition,
  type TakoformDriverReceipt,
  TakoformHostError,
  type TakoformStoredResource,
  type TakoformV1Alpha3FormRef,
} from "./types.ts";

const OPERATION_PROTOCOL_GENERATION = 1;
const PROVIDER_MUTATION_SAGA_TABLE = "tf_provider_mutation_sagas_selection_v1";
const DEFERRED_OPERATION_TABLE = "tf_deferred_operations_selection_v1";
const LEGACY_PROVIDER_MUTATION_SAGA_TABLE = "tf_provider_mutation_sagas";
const LEGACY_DEFERRED_OPERATION_TABLE = "tf_deferred_operations";

/** Internal classification used to retain a new command behind legacy evidence. */
export const LEGACY_OPERATION_GENERATION_CONFLICT = "LEGACY_OPERATION_GENERATION_CONFLICT";

/**
 * Durable Takoform state.
 *
 * A resource row stores the wire document whole, because that document *is* the
 * contract; columns exist only where something is queried, fenced, or made
 * unique. That keeps the schema honest — every column earns its place — and
 * means a wire field can be added without a migration.
 *
 * Writes are guarded rather than transactional. D1 has no interactive
 * transaction, so a fence is carried in the `WHERE` clause of the write itself
 * and confirmed through the changed-row count. This closes a race the in-memory
 * predecessor had: it checked a fence, awaited the provider, and only then
 * wrote, leaving a window in which two concurrent applies could both pass the
 * same fence.
 */

export interface ResourceAddress {
  readonly tenantId: string;
  readonly space: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
}

export interface StoredPrepare {
  readonly fingerprint: string;
  readonly authorityHeadDigest?: `sha256:${string}`;
  readonly expectedGeneration?: string;
  readonly currentUid?: string;
}

export interface OperationRecord {
  readonly id: string;
  readonly operation: string;
  readonly state: "succeeded" | "failed";
  readonly createdAt: string;
  readonly resource?: TakoformStoredResource;
}

export type ResourceDeletionEffectPhase = "planned" | "dispatched" | "succeeded" | "cancelled";
export type ResourceEffectKind =
  | "apply"
  | "import"
  | "provision"
  | "transfer-export"
  | "transfer-import"
  | "verify"
  | "cancel-delete"
  | "delete";

/** Host-owned, provider-opaque events retained by a deletion tombstone. */
export interface ResourceDeletionEffect {
  readonly eventId?: string;
  readonly operationId: string;
  readonly kind?: ResourceEffectKind;
  readonly phase: ResourceDeletionEffectPhase;
  readonly operationMode?: "initial" | "recovery";
  readonly providerPackRef?: string;
  readonly providerInstallationRef?: string;
  readonly nativeId?: string;
  /** Provider-owned, redacted target descriptor retained only for evidence. */
  readonly target?: JsonObject;
  readonly disposition?: "deleted" | "retained";
}

/** Durable identity and closure fence for one deleted Resource incarnation. */
export interface ResourceDeletionTombstone {
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly address: ResourceAddress;
  readonly formRef: TakoformV1Alpha3FormRef;
  readonly state: "live" | "pending" | "closed" | "cancelled";
  readonly closureFence: number;
  readonly effects: readonly ResourceDeletionEffect[];
  readonly evidenceJson?: JsonObject;
  readonly evidenceRef?: `sha256:${string}`;
  readonly evidenceEffectDigest?: `sha256:${string}`;
  readonly evidenceCheckedAt?: string;
  readonly evidenceStatus?: "absent" | "present" | "indeterminate";
  readonly createdAt: string;
  readonly updatedAt: string;
}

export type DeferredOperationPhase =
  | "pending"
  | "committing"
  | "succeeded"
  | "failed"
  | "cancelled";

/**
 * A resumable Host mutation. Only portable desired-state bytes and the closed
 * lifecycle headers are retained; authentication, cookies, probe headers, and
 * resolved service credentials never cross this storage boundary.
 */
export interface DeferredOperationRecord {
  readonly id: string;
  readonly tenantId: string;
  readonly principalId: string;
  readonly operation: "apply" | "import" | "delete";
  readonly phase: DeferredOperationPhase;
  readonly requestPath: string;
  readonly requestQuery: string;
  readonly requestHeaders: Readonly<Record<string, string>>;
  readonly requestBody?: string;
  readonly fingerprint: string;
  readonly replayKey: string;
  readonly target: {
    readonly space: string;
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
    readonly formRef: TakoformV1Alpha3FormRef;
  };
  readonly acceptedUid?: string;
  readonly acceptedGeneration?: string;
  readonly acceptedRevision?: string;
  readonly resourceUid: string;
  readonly workerEndpointOriginReservationId?: string;
  readonly pollsRemaining: number;
  readonly leaseToken?: string;
  readonly leaseUntil?: number;
  readonly terminalJson?: string;
  readonly committedUid?: string;
  readonly createdAt: string;
}

export interface ResourceMutationCommit {
  readonly kind: "write" | "delete";
  readonly resourceUid: string;
  readonly address: ResourceAddress;
  readonly expectedRevision: string | null;
  readonly resource?: TakoformStoredResource;
  readonly relations?: readonly TakoformStoredRelation[];
  readonly replayKey: string;
  readonly replay: StoredReplay;
  readonly providerReceipt?: TakoformDriverReceipt;
  /** Append the terminal event for the provider effect in the same commit. */
  readonly providerEffect?: {
    readonly effectId: string;
    readonly kind: ResourceEffectKind;
    readonly operationMode?: "initial" | "recovery";
  };
  /** Finalize the pre-created deletion tombstone in this same SQL batch. */
  readonly deletionTombstone?: {
    readonly operationId: string;
  };
  readonly claimKeys?: readonly string[];
  /** Exact internal relation targets held across provider dispatch and recovery. */
  readonly dependencySet?: ResourceDependencySet;
  /** An identity-preserving no-op must leave the live Resource's committed claims untouched. */
  readonly preserveClaims?: true;
  readonly authorityFence?: TakoformAuthorityFence;
}

export interface DeferredResourceCommit extends ResourceMutationCommit {
  readonly terminalJson: string;
}

export interface ProviderMutationSaga {
  readonly operationId: string;
  readonly operationKind: "apply" | "import" | "delete";
  readonly replayKey: string;
  readonly tenantId: string;
  readonly fingerprint: string;
  readonly resourceUid: string;
  readonly authorityHeadDigest?: `sha256:${string}`;
  readonly target: ResourceAddress;
  readonly acceptedUid?: string;
  readonly acceptedGeneration?: string;
  readonly acceptedRevision?: string;
  readonly receipt?: TakoformDriverReceipt;
}

interface OperationGenerationIdentity {
  readonly operationId: string;
  readonly replayKey: string;
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly target: ResourceAddress;
}

/** One no-effect provider refusal committed with its exact priced hold. */
export interface DefinitiveProviderMutationFailureCommit {
  /** Set only after the driver restores operation-wide proof from convergence. */
  readonly recoveryAction?: "convergeApply";
  readonly saga: ProviderMutationSaga;
  readonly providerLeaseToken: string;
  readonly claimOwnerId: string;
  readonly operation: "create" | "update";
  readonly charge: LedgerHeldCharge;
  readonly hostOperation:
    | { readonly kind: "immediate"; readonly createdAt: string }
    | {
        readonly kind: "deferred";
        readonly operation: DeferredOperationRecord;
        readonly leaseToken: string;
        readonly terminalJson: string;
      };
}

export type ProviderMutationExecution =
  | {
      readonly kind: "acquired";
      readonly mode: "initial" | "recovery";
      /** Immutable selection retained before this apply first crossed dispatch. */
      readonly applySelection?: TakoformApplySelection;
      /** Opaque provider handle from the last accepted dispatch, if any. */
      readonly providerHandle?: string;
      /** Whether the accepted dispatch is still running or indeterminate. */
      readonly providerOutcome?: "running" | "indeterminate";
    }
  | { readonly kind: "busy" }
  | { readonly kind: "executed"; readonly receipt: TakoformDriverReceipt };

export interface ResourceClaimReservation {
  readonly key: string;
  readonly tenantId: string;
  readonly holderSpace: string;
  readonly holderApiVersion: string;
  readonly holderKind: string;
  readonly holderName: string;
  readonly holderUid: string;
  readonly operationId: string;
}

export type ResourceClaimHolder = Omit<ResourceClaimReservation, "key" | "operationId">;

/** A resource as an inventory shows it: address, lineage, and last movement. */
export interface ResourceListing {
  readonly space: string;
  readonly apiVersion: string;
  readonly kind: string;
  readonly name: string;
  readonly uid: string;
  readonly generation: string;
  readonly revision: string;
  readonly updatedAt: string;
  readonly resource: TakoformStoredResource;
}

export interface ResourceWithRelations {
  readonly listing: ResourceListing;
  readonly relations: readonly TakoformStoredRelation[];
}

/** One same-space, lifecycle-attested Resource relation snapshot. */
export interface ResourceRelationTargetSnapshot {
  readonly source: ResourceListing;
  readonly relation: TakoformStoredRelation;
  readonly target: ResourceListing;
}

export interface OperationListing {
  readonly id: string;
  readonly operation: string;
  readonly state: string;
  readonly createdAt: string;
}

export interface RelatedResource {
  readonly resource: TakoformStoredResource;
  readonly relations: readonly TakoformStoredRelation[];
}

export interface StoredReplay {
  readonly fingerprint: string;
  readonly status: number;
  readonly resource?: TakoformStoredResource;
  readonly boundUid?: string;
}

export interface TakoformStore {
  readResource(address: ResourceAddress): Promise<TakoformStoredResource | null>;
  readRelations(address: ResourceAddress): Promise<readonly TakoformStoredRelation[]>;
  relationHolders(tenantId: string, targetUid: string): Promise<readonly string[]>;
  resourcesByRelation(input: {
    readonly tenantId: string;
    readonly space: string;
    readonly sourceApiVersion: string;
    readonly sourceKind: string;
    readonly relation: string;
    readonly targetUid: string;
    readonly limit: number;
  }): Promise<readonly RelatedResource[]>;
  /** Live custom-domain claims for one canonical DNS name, across every tenant space. */
  hostnameClaims(
    tenantId: string,
    hostname: string,
    limit: number,
  ): Promise<readonly ResourceListing[]>;
  /** Whether following QueueConsumer dead-letter edges reaches another queue. */
  queuePathReaches(input: {
    readonly tenantId: string;
    readonly space: string;
    readonly fromQueueUid: string;
    readonly toQueueUid: string;
  }): Promise<boolean>;
  /**
   * Writes a resource under an optimistic fence. `expectedRevision` is null for
   * a create, which then requires the row to be absent. Returns false when the
   * fence lost, meaning another writer moved the resource first.
   */
  writeResource(input: {
    readonly address: ResourceAddress;
    readonly resource: TakoformStoredResource;
    readonly relations: readonly TakoformStoredRelation[];
    readonly expectedRevision: string | null;
    /** Proves and finalizes Definition-declared claims in the same SQL batch. */
    readonly claimCommit?: {
      readonly operationId: string;
      readonly claimKeys: readonly string[];
    };
    readonly authorityFence?: TakoformAuthorityFence;
  }): Promise<boolean>;
  deleteResource(address: ResourceAddress, expectedRevision: string): Promise<boolean>;

  putPrepare(
    tenantId: string,
    prepareDigest: string,
    prepare: StoredPrepare,
    expiresAt: number,
  ): Promise<void>;
  readPrepare(tenantId: string, prepareDigest: string): Promise<StoredPrepare | null>;

  /**
   * Records a settled operation so `GET /operations/{id}` can answer with the
   * truth. Every mutation writes one, including the synchronous ones, because a
   * caller cannot tell from the outside which kind it made.
   */
  putOperation(tenantId: string, record: OperationRecord): Promise<void>;
  readOperation(tenantId: string, id: string): Promise<OperationRecord | null>;

  /** Arm one exact Resource-incarnation tombstone before provider dispatch. */
  prepareResourceDeletion(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly address: ResourceAddress;
    readonly formRef: TakoformV1Alpha3FormRef;
    readonly operationId: string;
  }): Promise<ResourceDeletionTombstone>;
  /** Record that the provider boundary was crossed for the armed tombstone. */
  markResourceDeletionDispatch(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly operationId: string;
  }): Promise<boolean>;
  readResourceDeletion(
    tenantId: string,
    resourceUid: string,
  ): Promise<ResourceDeletionTombstone | null>;
  /** Reserve an incarnation before any external provider dispatch. */
  reserveResourceIncarnation(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly address: ResourceAddress;
    readonly formRef: TakoformV1Alpha3FormRef;
  }): Promise<boolean>;
  /**
   * Drops the record of an incarnation that was reserved and never committed.
   *
   * `reserveResourceIncarnation` opens a deletion attestation `live` before the
   * Resource exists, and a create that is refused commits nothing — so the
   * record described an incarnation that never existed, a deletion that never
   * happened could never close it, and the `apply` effect it carried stayed
   * open for good. Everything that later asks "is this endpoint provably gone"
   * reads exactly those two rows, so the residue of one refusal made the next
   * repair impossible.
   *
   * Fenced on the incarnation having produced nothing: no Resource row, no
   * provider deployment outside `deleted`/`failed`, the attestation still
   * `live`, and every effect on the uid belonging to this one operation with
   * none of them `succeeded`. A refusal that may have mutated something keeps
   * its record, which is what a repair reads.
   */
  releaseUncommittedResourceIncarnation(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly effectId: string;
  }): Promise<boolean>;
  /** Append one provider/migration effect event; duplicate events are idempotent. */
  recordResourceEffect(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly effectId: string;
    readonly kind: ResourceEffectKind;
    readonly phase: ResourceDeletionEffectPhase;
    readonly operationMode: "initial" | "recovery";
    readonly providerPackRef?: string;
    readonly providerInstallationRef?: string;
    readonly nativeId?: string;
    readonly target?: JsonObject;
  }): Promise<boolean>;
  readResourceEffectLedger(
    tenantId: string,
    resourceUid: string,
  ): Promise<readonly ResourceDeletionEffect[]>;
  cacheResourceDeletionEvidence(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly closureFence: number;
    readonly evidence: JsonObject;
    readonly evidenceRef: `sha256:${string}`;
    readonly effectSetDigest: `sha256:${string}`;
    readonly checkedAt: number;
    readonly status: "absent" | "present" | "indeterminate";
  }): Promise<boolean>;

  acceptProviderMutationSaga(record: ProviderMutationSaga): Promise<ProviderMutationSaga>;
  /** Read-only proof that this exact command already crossed Host review. */
  establishedProviderMutationSaga(record: ProviderMutationSaga): Promise<boolean>;
  acquireProviderMutationExecution(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
    readonly leaseUntil: number;
  }): Promise<ProviderMutationExecution>;
  /**
   * Binds or re-verifies one immutable apply selection under the exact current
   * saga lease. Initial retries may repeat the same value; recovery may never
   * fill a historical NULL or replace an accepted value.
   */
  bindProviderMutationApplySelection(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly fingerprint: string;
    readonly leaseToken: string;
    readonly mode: "initial" | "recovery";
    readonly selection: TakoformApplySelection;
  }): Promise<TakoformApplySelection | null>;
  markProviderMutationDispatch(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
    /** Omitted only by historical direct store callers with no dependency fence. */
    readonly mode?: "initial" | "recovery";
    readonly dependencyReservationOwnerId?: string;
    readonly dependencySet?: ResourceDependencySet;
  }): Promise<boolean | "dependency_changed">;
  /** Retains an accepted provider handle when completion was not observed. */
  recordProviderMutationOutcome(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
    readonly outcome: "running" | "indeterminate";
    readonly providerHandle?: string;
  }): Promise<boolean>;
  /** Retires a proven no-effect refusal; recovery requires a whole-operation fence. */
  settleProviderMutationPreconditionFailure(input: {
    readonly recoveryAction?: "convergeApply";
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
  /**
   * Atomically terminalizes a proven no-effect provider attempt and releases
   * its exact wallet hold. A lost fence returns false with both still durable.
   */
  commitDefinitiveProviderMutationFailure(
    input: DefinitiveProviderMutationFailureCommit,
  ): Promise<boolean>;
  releaseProviderMutationExecution(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
  readProviderMutationReceipt(
    tenantId: string,
    operationId: string,
    resourceUid: string,
  ): Promise<TakoformDriverReceipt | null>;
  providerMutationPlanExists(
    tenantId: string,
    operationId: string,
    resourceUid: string,
  ): Promise<boolean>;
  abandonProviderMutationPlan(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly replayKey: string;
    readonly resourceUid: string;
  }): Promise<boolean>;
  settleDefinitiveProviderImportFailure(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly replayKey: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
    readonly outcome: "import_conflict" | "adoption_aborted";
  }): Promise<boolean>;
  recordProviderMutationReceipt(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
    readonly receipt: TakoformDriverReceipt;
    readonly authorityHeadDigest?: `sha256:${string}`;
    readonly claimOwnerId?: string;
  }): Promise<void>;
  holdDeferredProviderRepair(input: {
    readonly operation: DeferredOperationRecord;
    readonly leaseToken: string;
  }): Promise<boolean>;
  commitImmediateMutation(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly operation: "create" | "update" | "import" | "delete";
    readonly createdAt: string;
    readonly mutation: ResourceMutationCommit;
  }): Promise<void>;

  acceptDeferredOperation(record: DeferredOperationRecord): Promise<DeferredOperationRecord>;
  readDeferredOperation(
    tenantId: string,
    principalId: string,
    id: string,
  ): Promise<DeferredOperationRecord | null>;
  deferredOperationExists(id: string): Promise<boolean>;
  readDeferredOperationByReplay(replayKey: string): Promise<DeferredOperationRecord | null>;
  retireDeferredOperation(id: string, replayKey: string): Promise<boolean>;
  advanceDeferredOperation(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly id: string;
    readonly leaseToken: string;
    readonly leaseUntil: number;
  }): Promise<{
    readonly operation: DeferredOperationRecord | null;
    readonly acquired: boolean;
  }>;
  /** Dispatched provider commands with no receipt and no live execution lease. */
  recoverableDeferredProviderOperations(limit: number): Promise<readonly DeferredOperationRecord[]>;
  cancelDeferredOperation(input: {
    readonly tenantId: string;
    readonly principalId: string;
    readonly id: string;
    readonly terminalJson: string;
  }): Promise<"cancelled" | "settled" | "too_late" | "not_found">;
  /**
   * Ends a held provider repair whose receipt the Form can never carry.
   *
   * The ordinary hold is right where a native object exists and the exact Host
   * command is the only thing that can reconcile it. This one cannot be
   * reconciled by anything: the receipt is durable and the Form is frozen, so
   * the command answers the same refusal for ever and owns the caller's replay
   * key while it does. It is settled as a refusal about this Host — which
   * ADR 0008 re-attempts — and the executed saga is dropped with it, because a
   * fresh attempt on the same target would otherwise adopt it and re-project
   * the same answer.
   */
  retireUnpublishableProviderMutation(input: {
    readonly operation: DeferredOperationRecord;
    readonly leaseToken: string;
    readonly terminalJson: string;
  }): Promise<boolean>;
  settleDeferredFailure(input: {
    readonly operation: DeferredOperationRecord;
    readonly leaseToken: string;
    readonly terminalJson: string;
  }): Promise<boolean>;
  commitDeferredMutation(input: {
    readonly operation: DeferredOperationRecord;
    readonly leaseToken: string;
    readonly mutation: DeferredResourceCommit;
  }): Promise<void>;

  reserveResourceClaims(
    reservations: readonly ResourceClaimReservation[],
    expiresAt: number,
  ): Promise<void>;
  /** The live Resource that committed this canonical claim; pending reservations are invisible. */
  committedResourceClaimHolder(key: string): Promise<ResourceClaimHolder | null>;
  resourceClaimHolder(key: string): Promise<ResourceClaimHolder | null>;
  releaseResourceClaims(operationId: string): Promise<void>;
  releaseCommittedResourceClaims(tenantId: string, holderUid: string): Promise<void>;
  /** Atomically reserves every exact target snapshot selected by one provider mutation. */
  reserveResourceDependencies(input: {
    readonly tenantId: string;
    readonly holderUid: string;
    readonly reservationOwnerId: string;
    readonly dependencies: ResourceDependencySet;
    readonly expiresAt: number;
  }): Promise<void>;
  /** Reads the complete dependency set marked for a dispatched saga, or no legacy set. */
  readProviderMutationDependencies(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly operationId: string;
  }): Promise<ResourceDependencySet | null>;
  /** Releases only this source's uncommitted internal rows owned by this attempt. */
  releaseResourceDependencies(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly ownerId: string;
  }): Promise<void>;

  /**
   * Resources whose Form is no longer installed.
   *
   * These are not broken rows — they are declarations the Host can no longer
   * resolve, so the customer cannot read, update, or delete them while the
   * backend resource keeps running and keeps billing. It happens when a Form's
   * schema is changed without minting a new definition version, and it is
   * silent unless something looks for it.
   */
  orphanedResources(
    installedDigests: readonly string[],
    limit: number,
  ): Promise<
    readonly {
      readonly space: string;
      readonly name: string;
      readonly kind: string;
    }[]
  >;

  /**
   * One page of a tenant's resources, newest change first.
   *
   * The exact-pin lanes address a resource by its full quad, which is the right
   * shape for a machine that already knows what it declared and the wrong shape
   * for a person asking what they have. Paging is keyed on `(updated_at, uid)`
   * rather than an offset so a concurrent write cannot make a row appear twice
   * or vanish across pages.
   */
  listResources(
    tenantId: string,
    options: {
      readonly space?: string | undefined;
      readonly limit: number;
      readonly cursor?: string | undefined;
    },
  ): Promise<{
    readonly resources: readonly ResourceListing[];
    readonly cursor: string | null;
  }>;

  /** Exact resource lookup for a credential broker; a uid is not a list cursor. */
  resourceByUid(tenantId: string, uid: string): Promise<ResourceListing | null>;

  /**
   * One immutable snapshot page of Takoserver-owned Resource commit evidence.
   * The deletion attestation owns identity even after the live Resource row is
   * gone; a cursor binds all later pages to the first page's maximum sequence.
   */
  readResourceExecutionEvidence(input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<ResourceExecutionEvidenceResponse | null>;

  /** One UID-scoped snapshot used by authorities that must bind Resource and relations together. */
  resourceWithRelationsByUid(tenantId: string, uid: string): Promise<ResourceWithRelations | null>;

  /** One atomic source/relation/target snapshot with both live lifecycle attestations. */
  resourceWithRelationTargetByUid(
    tenantId: string,
    sourceUid: string,
    pointer: string,
  ): Promise<ResourceRelationTargetSnapshot | null>;

  /** The most recent settled operations for a tenant, newest first. */
  listOperations(tenantId: string, limit: number): Promise<readonly OperationListing[]>;

  readReplay(key: string): Promise<StoredReplay | null>;
  putReplay(key: string, replay: StoredReplay): Promise<void>;
  deleteReplay(key: string): Promise<void>;
}

function legacyOperationConflictFence(input: OperationGenerationIdentity): {
  readonly sql: string;
  readonly params: readonly SqlParam[];
} {
  return {
    sql: `(
      EXISTS (
        SELECT 1 FROM ${LEGACY_PROVIDER_MUTATION_SAGA_TABLE} AS legacy_saga
        WHERE legacy_saga.operation_id = ? OR legacy_saga.replay_key = ?
          OR (legacy_saga.tenant_id = ? AND (
            legacy_saga.resource_uid = ? OR (
              legacy_saga.target_space = ? AND legacy_saga.target_api_version = ?
              AND legacy_saga.target_kind = ? AND legacy_saga.target_name = ?
            )
          ))
      ) OR EXISTS (
        SELECT 1 FROM ${LEGACY_DEFERRED_OPERATION_TABLE} AS legacy_operation
        WHERE legacy_operation.phase IN ('pending', 'committing') AND (
          legacy_operation.id = ? OR legacy_operation.replay_key = ?
          OR (legacy_operation.tenant_id = ? AND (
            legacy_operation.resource_uid = ? OR (
              legacy_operation.target_space = ? AND legacy_operation.target_api_version = ?
              AND legacy_operation.target_kind = ? AND legacy_operation.target_name = ?
            )
          ))
        )
      )
    )`,
    params: [
      input.operationId,
      input.replayKey,
      input.tenantId,
      input.resourceUid,
      input.target.space,
      input.target.apiVersion,
      input.target.kind,
      input.target.name,
      input.operationId,
      input.replayKey,
      input.tenantId,
      input.resourceUid,
      input.target.space,
      input.target.apiVersion,
      input.target.kind,
      input.target.name,
    ],
  };
}

function legacyOperationConflictError(): TakoformHostError {
  return new TakoformHostError(
    "resource_busy",
    409,
    undefined,
    undefined,
    LEGACY_OPERATION_GENERATION_CONFLICT,
  );
}

export function createTakoformStore(sql: Sql, clock: Clock): TakoformStore {
  const now = (): number => clock().getTime();

  const readDeferredBy = async (
    column: "replay_key",
    value: string,
  ): Promise<DeferredOperationRecord | null> => {
    const current = await sql.query(
      `SELECT * FROM ${DEFERRED_OPERATION_TABLE}
       WHERE ${column} = ? AND (phase IN ('pending', 'committing') OR expires_at > ?) LIMIT 2`,
      [value, now()],
    );
    if (current.length > 1) throw new Error("deferred_operation_ambiguous");
    if (current[0]) return deferredOperation(current[0]);
    const legacy = await sql.query(
      `SELECT * FROM ${LEGACY_DEFERRED_OPERATION_TABLE} WHERE ${column} = ? LIMIT 2`,
      [value],
    );
    if (legacy.length > 1) throw new Error("legacy_deferred_operation_ambiguous");
    return legacy[0] ? deferredOperation(legacy[0]) : null;
  };

  const hasLegacyOperationConflict = async (
    identity: OperationGenerationIdentity,
  ): Promise<boolean> => {
    const fence = legacyOperationConflictFence(identity);
    const rows = await sql.query(`SELECT CASE WHEN ${fence.sql} THEN 1 ELSE 0 END AS conflict`, [
      ...fence.params,
    ]);
    return Number(rows[0]?.conflict ?? 0) === 1;
  };

  /**
   * Whether this deferred operation's accepted revision is still a fence.
   *
   * For an apply or an import it is: an update must not land on a Resource that
   * moved under it. For a **delete** it is not, and the released provider's own
   * documentation says so on every resource page — *"`revision` … is deliberately
   * NOT the delete fence: a teardown removes dependents first and would otherwise
   * be refused by a revision it moved itself."* `DeleteResource` accordingly sends
   * `takoform-expected-generation` and no `If-Match`.
   *
   * Pinning it anyway is what wedged a real teardown. A deferred `ModuleWorker`
   * delete was accepted at revision 2; deleting the Worker's dependents made
   * `withDerivedRendering` re-render the parent (its `Ready` condition became
   * "has no active WorkerDeployment") and the live revision became 3. Every
   * retry replayed the same durable record under the provider's deterministic
   * delete idempotency key and answered 412 forever, so `tofu destroy` could
   * never finish and six resources leaked. Incarnation (`uid`), `generation` and
   * the exact Form ref remain the fences, and they are the ones that describe
   * what the caller asked to delete.
   */
  function deleteFencesRevision(operation: {
    readonly operation: "apply" | "import" | "delete";
  }): boolean {
    return operation.operation !== "delete";
  }

  const commitFenceError = async (
    operation: DeferredOperationRecord,
    leaseToken: string,
  ): Promise<TakoformHostError> => {
    const liveOperation = await sql.query(
      `SELECT phase, lease_token FROM ${DEFERRED_OPERATION_TABLE}
       WHERE id = ? AND tenant_id = ? AND principal_id = ?`,
      [operation.id, operation.tenantId, operation.principalId],
    );
    if (
      liveOperation.length !== 1 ||
      liveOperation[0]?.phase !== "committing" ||
      liveOperation[0]?.lease_token !== leaseToken
    ) {
      return new TakoformHostError("resource_busy", 409);
    }
    const current = await sql.query(
      `SELECT uid, generation, revision, resource_json FROM tf_resources
       WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?`,
      [
        operation.tenantId,
        operation.target.space,
        operation.target.apiVersion,
        operation.target.kind,
        operation.target.name,
      ],
    );
    const row = current[0];
    if (operation.acceptedUid === undefined) {
      return new TakoformHostError(row ? "uid_mismatch" : "resource_busy", 409);
    }
    if (!row) return new TakoformHostError("resource_not_found", 404);
    const resource = JSON.parse(text(row.resource_json)) as TakoformStoredResource;
    if (
      row.uid !== operation.acceptedUid ||
      canonicalJson(resource.form.formRef) !== canonicalJson(operation.target.formRef)
    ) {
      return new TakoformHostError("uid_mismatch", 409);
    }
    if (row.generation !== operation.acceptedGeneration) {
      return new TakoformHostError("generation_conflict", 412);
    }
    if (deleteFencesRevision(operation) && row.revision !== operation.acceptedRevision) {
      return new TakoformHostError("revision_conflict", 412);
    }
    return new TakoformHostError("resource_busy", 409);
  };

  /**
   * Recognize only the immutable answer of one already-committed mutation.
   *
   * This check runs only after the commit batch has been rejected atomically.
   * Letting an existing-evidence branch continue through that batch would let
   * caller-supplied replay or provider fields mutate after the operation id was
   * already claimed. A lost acknowledgement is therefore a read-only outcome:
   * every durable identity must match, or the retry is a conflict.
   */
  const exactCommittedMutationReplay = async (input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly operation: "create" | "update" | "apply" | "import" | "delete";
    readonly mutation: ResourceMutationCommit;
    readonly deleteGeneration?: string;
    readonly fenceDeleteRevision: boolean;
  }): Promise<boolean> => {
    const operationRows = await sql.query(
      `SELECT tenant_id, operation, state, resource_json
       FROM tf_operations WHERE id = ? LIMIT 2`,
      [input.operationId],
    );
    const evidenceRows = await sql.query(
      `SELECT tenant_id, resource_uid, action, resource_generation, resource_revision
       FROM tf_resource_execution_evidence WHERE operation_id = ? LIMIT 2`,
      [input.operationId],
    );
    const replayRows = await sql.query(
      `SELECT fingerprint, status, resource_json, bound_uid
       FROM tf_replays WHERE replay_key = ? LIMIT 2`,
      [input.mutation.replayKey],
    );
    if (operationRows.length === 0 && evidenceRows.length === 0 && replayRows.length === 0) {
      return false;
    }

    const identityNoOp =
      input.mutation.kind === "write" &&
      input.mutation.preserveClaims === true &&
      input.mutation.expectedRevision !== null &&
      input.mutation.resource?.metadata.revision === input.mutation.expectedRevision;
    const operationRow = operationRows[0];
    const replayRow = replayRows[0];
    const evidenceRow = evidenceRows[0];
    const sameJson = (stored: unknown, expected: unknown | undefined): boolean => {
      if (expected === undefined) return stored === null;
      if (typeof stored !== "string") return false;
      return canonicalJson(JSON.parse(stored)) === canonicalJson(expected);
    };
    const operationMatches =
      operationRows.length === 1 &&
      operationRow !== undefined &&
      operationRow.tenant_id === input.tenantId &&
      operationRow.operation === input.operation &&
      operationRow.state === "succeeded" &&
      sameJson(operationRow.resource_json, input.mutation.resource);
    const replayMatches =
      replayRows.length === 1 &&
      replayRow !== undefined &&
      replayRow.fingerprint === input.mutation.replay.fingerprint &&
      Number(replayRow.status) === input.mutation.replay.status &&
      sameJson(replayRow.resource_json, input.mutation.replay.resource) &&
      replayRow.bound_uid === (input.mutation.replay.boundUid ?? null);
    const expectedAction =
      input.mutation.kind === "delete"
        ? "delete"
        : input.mutation.expectedRevision === null
          ? "create"
          : "update";
    const evidenceMatches = identityNoOp
      ? evidenceRows.length === 0
      : evidenceRows.length === 1 &&
        evidenceRow !== undefined &&
        evidenceRow.tenant_id === input.tenantId &&
        evidenceRow.resource_uid === input.mutation.resourceUid &&
        evidenceRow.action === expectedAction &&
        (input.mutation.kind === "write"
          ? input.mutation.resource !== undefined &&
            evidenceRow.resource_generation === input.mutation.resource.metadata.generation &&
            evidenceRow.resource_revision === input.mutation.resource.metadata.revision
          : (input.deleteGeneration === undefined ||
              evidenceRow.resource_generation === input.deleteGeneration) &&
            (!input.fenceDeleteRevision ||
              evidenceRow.resource_revision === input.mutation.expectedRevision));
    if (operationMatches && replayMatches && evidenceMatches) return true;
    throw new TakoformHostError("resource_busy", 409);
  };

  return {
    async readResource(address): Promise<TakoformStoredResource | null> {
      const rows = await sql.query(
        `SELECT resource_json, package_digest, implementation_digest FROM tf_resources
         WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?`,
        [address.tenantId, address.space, address.apiVersion, address.kind, address.name],
      );
      const row = rows[0];
      return row ? storedResource(row) : null;
    },

    async readRelations(address): Promise<readonly TakoformStoredRelation[]> {
      const rows = await sql.query(
        `SELECT relations_json FROM tf_resources
         WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?`,
        [address.tenantId, address.space, address.apiVersion, address.kind, address.name],
      );
      const row = rows[0];
      return row ? storedRelations(text(row.relations_json)) : [];
    },

    async relationHolders(tenantId, targetUid): Promise<readonly string[]> {
      const rows = await sql.query(
        `SELECT DISTINCT resource.api_version, resource.kind, resource.name
         FROM tf_resources AS resource, json_each(resource.relations_json) AS relation
         WHERE resource.tenant_id = ?
           AND json_extract(relation.value, '$.targetUid') = ?
         ORDER BY resource.api_version, resource.kind, resource.name
         LIMIT 2`,
        [tenantId, targetUid],
      );
      return rows.map((row) => `${text(row.api_version)}/${text(row.kind)}/${text(row.name)}`);
    },

    async resourcesByRelation(input): Promise<readonly RelatedResource[]> {
      const rows = await sql.query(
        `SELECT DISTINCT resource.resource_json, resource.relations_json
         FROM tf_resources AS resource, json_each(resource.relations_json) AS relation
         WHERE resource.tenant_id = ?
           AND resource.space = ?
           AND resource.api_version = ?
           AND resource.kind = ?
           AND json_extract(relation.value, '$.relation') = ?
           AND json_extract(relation.value, '$.targetUid') = ?
         ORDER BY resource.name
         LIMIT ?`,
        [
          input.tenantId,
          input.space,
          input.sourceApiVersion,
          input.sourceKind,
          input.relation,
          input.targetUid,
          input.limit,
        ],
      );
      return rows.map((row) => ({
        resource: JSON.parse(text(row.resource_json)) as TakoformStoredResource,
        relations: storedRelations(text(row.relations_json)),
      }));
    },

    async hostnameClaims(tenantId, hostname, limit): Promise<readonly ResourceListing[]> {
      const rows = await sql.query(
        `SELECT space, api_version, kind, name, uid, generation, revision,
                updated_at, resource_json
         FROM tf_resources
         WHERE tenant_id = ?
           AND (api_version = 'edge.forms.takoform.com'
                OR api_version LIKE 'edge.forms.takoform.com/%')
           AND kind = 'WorkerCustomDomain'
           AND json_extract(resource_json, '$.spec.hostname') = ?
         ORDER BY space, name
         LIMIT ?`,
        [tenantId, hostname, Math.min(Math.max(limit, 1), 2)],
      );
      return rows.map(resourceListing);
    },

    async queuePathReaches(input): Promise<boolean> {
      const rows = await sql.query(
        `WITH RECURSIVE dead_letter_path(queue_uid) AS (
           VALUES (?)
           UNION
           SELECT json_extract(dead_letter.value, '$.targetUid')
           FROM dead_letter_path AS path
           JOIN tf_resources AS consumer
             ON consumer.tenant_id = ?
            AND consumer.space = ?
            AND (consumer.api_version = 'edge.forms.takoform.com'
                 OR consumer.api_version LIKE 'edge.forms.takoform.com/%')
            AND consumer.kind = 'QueueConsumer'
           JOIN json_each(consumer.relations_json) AS drained
             ON json_extract(drained.value, '$.relation') = '/queue'
            AND json_extract(drained.value, '$.targetUid') = path.queue_uid
           JOIN json_each(consumer.relations_json) AS dead_letter
             ON json_extract(dead_letter.value, '$.relation') = '/deadLetterQueue'
         )
         SELECT 1 AS found FROM dead_letter_path WHERE queue_uid = ? LIMIT 1`,
        [input.fromQueueUid, input.tenantId, input.space, input.toQueueUid],
      );
      return rows.length === 1;
    },

    async writeResource({
      address,
      resource,
      relations,
      expectedRevision,
      claimCommit,
      authorityFence,
    }): Promise<boolean> {
      const key = [address.tenantId, address.space, address.apiVersion, address.kind, address.name];
      const [packageDigest, implementationDigest] = exactResourceDigests(resource);
      if (claimCommit || authorityFence) {
        const claimKeys = [...new Set(claimCommit?.claimKeys ?? [])].sort();
        const authority = authorityFence
          ? await authorityFenceSql(authorityFence)
          : { sql: "1 = 1", params: [] as readonly SqlParam[] };
        const guard = boundedGuard(
          `resource_${claimCommit?.operationId ?? authorityFence?.headDigest ?? "fence"}`,
        );
        const resourceFence =
          expectedRevision === null
            ? `NOT EXISTS (
                SELECT 1 FROM tf_resources
                WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
              )`
            : `EXISTS (
                SELECT 1 FROM tf_resources
                WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
                  AND revision = ?
              )`;
        const claimFence =
          claimKeys.length === 0
            ? "1 = 1"
            : `(SELECT COUNT(*) FROM tf_resource_claims
                WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                  AND claim_key IN (${claimKeys.map(() => "?").join(", ")})) = ?`;
        const statements: SqlStatement[] = [
          {
            sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                  SELECT ?, CASE WHEN ${resourceFence} AND ${claimFence}
                                      AND (${authority.sql}) THEN 1 ELSE 0 END`,
            params: [
              guard,
              ...key,
              ...(expectedRevision === null ? [] : [expectedRevision]),
              ...(claimKeys.length === 0
                ? []
                : [
                    claimCommit?.operationId ?? "",
                    address.tenantId,
                    resource.metadata.uid,
                    ...claimKeys,
                    claimKeys.length,
                  ]),
              ...authority.params,
            ],
          },
        ];
        if (expectedRevision === null) {
          statements.push({
            sql: `INSERT INTO tf_resources
                    (tenant_id, space, api_version, kind, name, uid, generation, revision,
                     resource_json, relations_json, package_digest, implementation_digest, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              ...key,
              resource.metadata.uid,
              resource.metadata.generation,
              resource.metadata.revision,
              JSON.stringify(resource),
              JSON.stringify(relations),
              packageDigest,
              implementationDigest,
              now(),
            ],
          });
        } else {
          statements.push({
            sql: `UPDATE tf_resources
                  SET uid = ?, generation = ?, revision = ?, resource_json = ?,
                      relations_json = ?, package_digest = ?, implementation_digest = ?, updated_at = ?
                  WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
                    AND revision = ?`,
            params: [
              resource.metadata.uid,
              resource.metadata.generation,
              resource.metadata.revision,
              JSON.stringify(resource),
              JSON.stringify(relations),
              packageDigest,
              implementationDigest,
              now(),
              ...key,
              expectedRevision,
            ],
          });
        }
        statements.push(
          ...(claimCommit
            ? claimCommitStatements(
                {
                  id: claimCommit.operationId,
                  tenantId: address.tenantId,
                  resourceUid: resource.metadata.uid,
                },
                claimKeys,
                now(),
              )
            : []),
          {
            sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
            params: [guard],
          },
        );
        try {
          await sql.batch(statements);
          return true;
        } catch (error) {
          if (!(error instanceof SqlError) || error.code !== "constraint") throw error;
          const current = await sql.query(
            `SELECT revision FROM tf_resources
             WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?`,
            key,
          );
          if (
            (expectedRevision === null && current.length > 0) ||
            (expectedRevision !== null && current[0]?.revision !== expectedRevision)
          ) {
            return false;
          }
          if (claimCommit && claimKeys.length > 0) {
            const owned = await sql.query(
              `SELECT claim_key FROM tf_resource_claims
               WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                 AND claim_key IN (${claimKeys.map(() => "?").join(", ")})`,
              [claimCommit.operationId, address.tenantId, resource.metadata.uid, ...claimKeys],
            );
            if (owned.length !== claimKeys.length) {
              throw new TakoformHostError("invalid_argument", 400);
            }
          }
          throw error;
        }
      }
      if (expectedRevision === null) {
        const written = await sql.run(
          `INSERT OR IGNORE INTO tf_resources
             (tenant_id, space, api_version, kind, name, uid, generation, revision,
              resource_json, relations_json, package_digest, implementation_digest, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            ...key,
            resource.metadata.uid,
            resource.metadata.generation,
            resource.metadata.revision,
            JSON.stringify(resource),
            JSON.stringify(relations),
            packageDigest,
            implementationDigest,
            now(),
          ],
        );
        return written.changes === 1;
      }
      const written = await sql.run(
        `UPDATE tf_resources
         SET uid = ?, generation = ?, revision = ?, resource_json = ?, relations_json = ?,
             package_digest = ?, implementation_digest = ?, updated_at = ?
         WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
           AND revision = ?`,
        [
          resource.metadata.uid,
          resource.metadata.generation,
          resource.metadata.revision,
          JSON.stringify(resource),
          JSON.stringify(relations),
          packageDigest,
          implementationDigest,
          now(),
          ...key,
          expectedRevision,
        ],
      );
      return written.changes === 1;
    },

    async deleteResource(address, expectedRevision): Promise<boolean> {
      const written = await sql.run(
        `DELETE FROM tf_resources
         WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
           AND revision = ?`,
        [
          address.tenantId,
          address.space,
          address.apiVersion,
          address.kind,
          address.name,
          expectedRevision,
        ],
      );
      return written.changes === 1;
    },

    async putPrepare(tenantId, prepareDigest, prepare, expiresAt): Promise<void> {
      // Expired reviews are swept opportunistically and in bounded batches, so
      // the table cannot grow without limit and no single request pays for a
      // full scan.
      await sql.run(
        `DELETE FROM tf_prepares WHERE rowid IN (
           SELECT rowid FROM tf_prepares WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
        [now(), SWEEP_ROW_LIMIT],
      );
      await sql.run(
        `INSERT INTO tf_prepares
           (tenant_id, prepare_digest, fingerprint, expected_generation, current_uid,
            authority_head_digest, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (tenant_id, prepare_digest) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           expected_generation = excluded.expected_generation,
           current_uid = excluded.current_uid,
           authority_head_digest = excluded.authority_head_digest,
           expires_at = excluded.expires_at`,
        [
          tenantId,
          prepareDigest,
          prepare.fingerprint,
          prepare.expectedGeneration ?? null,
          prepare.currentUid ?? null,
          prepare.authorityHeadDigest ?? null,
          expiresAt,
        ],
      );
    },

    async readPrepare(tenantId, prepareDigest): Promise<StoredPrepare | null> {
      const rows = await sql.query(
        `SELECT fingerprint, expected_generation, current_uid, authority_head_digest FROM tf_prepares
         WHERE tenant_id = ? AND prepare_digest = ? AND expires_at > ?`,
        [tenantId, prepareDigest, now()],
      );
      const row = rows[0];
      if (!row) return null;
      const expectedGeneration = row.expected_generation;
      const currentUid = row.current_uid;
      return {
        fingerprint: text(row.fingerprint),
        ...(row.authority_head_digest === null
          ? {}
          : { authorityHeadDigest: digestText(row.authority_head_digest) }),
        ...(typeof expectedGeneration === "string" ? { expectedGeneration } : {}),
        ...(typeof currentUid === "string" ? { currentUid } : {}),
      };
    },

    async putOperation(tenantId, record): Promise<void> {
      await sql.run(
        `DELETE FROM tf_operations WHERE rowid IN (
           SELECT rowid FROM tf_operations WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
        [now(), SWEEP_ROW_LIMIT],
      );
      await sql.run(
        `INSERT OR IGNORE INTO tf_operations
           (id, tenant_id, operation, state, resource_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          record.id,
          tenantId,
          record.operation,
          record.state,
          record.resource ? JSON.stringify(record.resource) : null,
          record.createdAt,
          now() + OPERATION_TTL_MILLISECONDS,
        ],
      );
    },

    async readOperation(tenantId, id): Promise<OperationRecord | null> {
      const rows = await sql.query(
        `SELECT id, operation, state, resource_json, created_at FROM tf_operations
         WHERE tenant_id = ? AND id = ? AND expires_at > ?`,
        [tenantId, id, now()],
      );
      const row = rows[0];
      if (!row) return null;
      const resourceJson = row.resource_json;
      return {
        id: text(row.id),
        operation: text(row.operation),
        state: text(row.state) === "failed" ? "failed" : "succeeded",
        createdAt: text(row.created_at),
        ...(typeof resourceJson === "string"
          ? { resource: JSON.parse(resourceJson) as TakoformStoredResource }
          : {}),
      };
    },

    async reserveResourceIncarnation(input): Promise<boolean> {
      const timestamp = now();
      await sql.run(
        `INSERT OR IGNORE INTO tf_resource_deletion_attestations
           (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
            state, closure_fence, effects_json, evidence_json, evidence_ref,
            evidence_effect_digest, evidence_checked_at, evidence_status,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'live', 1, '[]', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
        [
          input.tenantId,
          input.resourceUid,
          input.address.space,
          input.address.apiVersion,
          input.address.kind,
          input.address.name,
          canonicalJson(input.formRef),
          timestamp,
          timestamp,
        ],
      );
      const rows = await sql.query(
        `SELECT * FROM tf_resource_deletion_attestations
         WHERE tenant_id = ? AND resource_uid = ? LIMIT 2`,
        [input.tenantId, input.resourceUid],
      );
      if (rows.length !== 1 || !rows[0]) return false;
      const row = resourceDeletionTombstone(rows[0]);
      return (
        row.address.space === input.address.space &&
        row.address.apiVersion === input.address.apiVersion &&
        row.address.kind === input.address.kind &&
        row.address.name === input.address.name &&
        canonicalJson(row.formRef) === canonicalJson(input.formRef) &&
        row.state === "live"
      );
    },

    async releaseUncommittedResourceIncarnation(input): Promise<boolean> {
      const release = uncommittedResourceIncarnationRelease(input);
      const [, dropped] = await sql.batch(release.statements);
      return (dropped?.changes ?? 0) === 1;
    },

    async recordResourceEffect(input): Promise<boolean> {
      validResourceEffectInput(input);
      const eventId = `${input.effectId}:${input.phase}`;
      const existing = await sql.query(
        `SELECT event_id FROM tf_resource_provider_effects
         WHERE tenant_id = ? AND resource_uid = ? AND event_id = ? LIMIT 1`,
        [input.tenantId, input.resourceUid, eventId],
      );
      if (existing.length > 0) return true;
      const prior = await sql.query(
        `SELECT phase FROM tf_resource_provider_effects
         WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
         ORDER BY created_at, event_id`,
        [input.tenantId, input.resourceUid, input.effectId],
      );
      const phases = new Set(prior.map((row) => row.phase));
      if (
        (input.phase === "dispatched" && !phases.has("planned")) ||
        (input.phase === "succeeded" && !phases.has("dispatched")) ||
        (input.phase === "cancelled" && !phases.has("planned") && !phases.has("dispatched")) ||
        phases.has("succeeded") ||
        phases.has("cancelled")
      ) {
        return false;
      }
      const timestamp = now();
      const inserted = await sql.run(
        `INSERT OR IGNORE INTO tf_resource_provider_effects
           (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
            operation_mode, provider_pack_ref, provider_installation_ref,
            native_id, target_json, created_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
         WHERE EXISTS (
           SELECT 1 FROM tf_resource_deletion_attestations
           WHERE tenant_id = ? AND resource_uid = ? AND state IN ('live', 'pending')
         )`,
        [
          input.tenantId,
          input.resourceUid,
          eventId,
          input.effectId,
          input.kind,
          input.phase,
          input.operationMode,
          input.providerPackRef ?? null,
          input.providerInstallationRef ?? null,
          input.nativeId ?? null,
          input.target ? canonicalJson(input.target) : null,
          timestamp,
          input.tenantId,
          input.resourceUid,
        ],
      );
      if (inserted.changes !== 1) return false;
      await sql.run(
        `UPDATE tf_resource_deletion_attestations
         SET closure_fence = closure_fence + 1,
             effects_json = json_insert(effects_json, '$[#]', json(?)),
             evidence_json = NULL, evidence_ref = NULL,
             evidence_effect_digest = NULL, evidence_checked_at = NULL,
             evidence_status = NULL, updated_at = ?
         WHERE tenant_id = ? AND resource_uid = ? AND state IN ('live', 'pending')`,
        [
          canonicalJson({
            eventId,
            operationId: input.effectId,
            kind: input.kind,
            phase: input.phase,
            operationMode: input.operationMode,
            ...(input.providerPackRef ? { providerPackRef: input.providerPackRef } : {}),
            ...(input.providerInstallationRef
              ? { providerInstallationRef: input.providerInstallationRef }
              : {}),
            ...(input.nativeId ? { nativeId: input.nativeId } : {}),
            ...(input.target ? { target: input.target } : {}),
          }),
          timestamp,
          input.tenantId,
          input.resourceUid,
        ],
      );
      return true;
    },

    async readResourceEffectLedger(
      tenantId,
      resourceUid,
    ): Promise<readonly ResourceDeletionEffect[]> {
      const rows = await sql.query(
        `SELECT event_id, effect_id, effect_kind, phase, operation_mode,
                provider_pack_ref, provider_installation_ref, native_id, target_json
         FROM tf_resource_provider_effects
         WHERE tenant_id = ? AND resource_uid = ?
         ORDER BY created_at, event_id`,
        [tenantId, resourceUid],
      );
      return rows.map(resourceProviderEffect);
    },

    async prepareResourceDeletion(input): Promise<ResourceDeletionTombstone> {
      const timestamp = now();
      const [targetClaimStart, targetClaimEnd] = await resourceDependencyTargetClaimRange(
        input.tenantId,
        input.resourceUid,
      );
      const guard = boundedGuard(`delete_dependency_${input.operationId}`);
      const formRefJson = canonicalJson(input.formRef);
      const available = `
        NOT EXISTS (
          SELECT 1 FROM tf_resource_claims AS dependency
          WHERE dependency.claim_key >= ? AND dependency.claim_key < ?
            AND dependency.tenant_id = ?
            AND (dependency.state = 'committed' OR dependency.expires_at > ?)
        )
        AND NOT EXISTS (
          SELECT 1
          FROM tf_resources AS holder, json_each(holder.relations_json) AS relation
          WHERE holder.tenant_id = ?
            AND json_extract(relation.value, '$.targetUid') = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM worker_runtime_input_preparations AS runtime_input
          WHERE runtime_input.organization_id = ?
            AND runtime_input.worker_resource_uid = ?
            AND runtime_input.state = 'claimed'
            AND runtime_input.claim_expires_at > ?
        )`;
      const availableParams = (): readonly SqlParam[] => [
        targetClaimStart,
        targetClaimEnd,
        input.tenantId,
        timestamp,
        input.tenantId,
        input.resourceUid,
        input.tenantId,
        input.resourceUid,
        timestamp,
      ];
      try {
        await sql.batch([
          {
            // Provider deployment and intrinsic-resource absence evidence also
            // uses this tombstone when no logical Resource row exists. The
            // exact supplied incarnation remains authoritative; availability,
            // not tf_resources presence, is the atomic deletion prerequisite.
            sql: `INSERT OR IGNORE INTO tf_resource_deletion_attestations
                    (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
                     state, closure_fence, effects_json, evidence_json, evidence_ref,
                     evidence_effect_digest, evidence_checked_at, evidence_status,
                     created_at, updated_at)
                  SELECT ?, ?, ?, ?, ?, ?, ?, 'pending', 1, '[]',
                         NULL, NULL, NULL, NULL, NULL, ?, ?
                  WHERE ${available}`,
            params: [
              input.tenantId,
              input.resourceUid,
              input.address.space,
              input.address.apiVersion,
              input.address.kind,
              input.address.name,
              formRefJson,
              timestamp,
              timestamp,
              ...availableParams(),
            ],
          },
          {
            sql: `UPDATE tf_resource_deletion_attestations
                  SET state = 'pending', updated_at = ?
                  WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
                    AND space = ? AND api_version = ? AND kind = ? AND name = ?
                    AND form_ref_json = ? AND ${available}`,
            params: [
              timestamp,
              input.tenantId,
              input.resourceUid,
              input.address.space,
              input.address.apiVersion,
              input.address.kind,
              input.address.name,
              formRefJson,
              ...availableParams(),
            ],
          },
          {
            sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                  SELECT ?, CASE WHEN EXISTS (
                    SELECT 1 FROM tf_resource_deletion_attestations
                    WHERE tenant_id = ? AND resource_uid = ? AND state = 'pending'
                      AND space = ? AND api_version = ? AND kind = ? AND name = ?
                      AND form_ref_json = ? AND ${available}
                  ) THEN 1 ELSE 0 END`,
            params: [
              guard,
              input.tenantId,
              input.resourceUid,
              input.address.space,
              input.address.apiVersion,
              input.address.kind,
              input.address.name,
              formRefJson,
              ...availableParams(),
            ],
          },
          {
            sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
            params: [guard],
          },
        ]);
      } catch (error) {
        if (!(error instanceof SqlError) || error.code !== "constraint") throw error;
        const identity = await sql.query(
          `SELECT space, api_version, kind, name, form_ref_json, state
           FROM tf_resource_deletion_attestations
           WHERE tenant_id = ? AND resource_uid = ? LIMIT 2`,
          [input.tenantId, input.resourceUid],
        );
        const row = identity[0];
        if (
          identity.length !== 1 ||
          row?.space !== input.address.space ||
          row.api_version !== input.address.apiVersion ||
          row.kind !== input.address.kind ||
          row.name !== input.address.name ||
          row.form_ref_json !== formRefJson ||
          (row.state !== "live" && row.state !== "pending")
        ) {
          throw new TakoformHostError("resource_busy", 409);
        }
        throw crossResourcePrecondition();
      }
      const recorded = await this.recordResourceEffect({
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        effectId: input.operationId,
        kind: "delete",
        phase: "planned",
        operationMode: "initial",
      });
      if (!recorded) throw new TakoformHostError("resource_busy", 409);
      const refreshed = await sql.query(
        `SELECT * FROM tf_resource_deletion_attestations
         WHERE tenant_id = ? AND resource_uid = ? LIMIT 2`,
        [input.tenantId, input.resourceUid],
      );
      const result = refreshed[0]
        ? {
            ...resourceDeletionTombstone(refreshed[0]),
            effects: await this.readResourceEffectLedger(input.tenantId, input.resourceUid),
          }
        : null;
      if (!result || refreshed.length !== 1) throw new TakoformHostError("resource_busy", 409);
      return result;
    },

    async markResourceDeletionDispatch(input): Promise<boolean> {
      return await this.recordResourceEffect({
        tenantId: input.tenantId,
        resourceUid: input.resourceUid,
        effectId: input.operationId,
        kind: "delete",
        phase: "dispatched",
        operationMode: "initial",
      });
    },

    async readResourceDeletion(tenantId, resourceUid): Promise<ResourceDeletionTombstone | null> {
      const rows = await sql.query(
        `SELECT * FROM tf_resource_deletion_attestations
         WHERE tenant_id = ? AND resource_uid = ? LIMIT 2`,
        [tenantId, resourceUid],
      );
      if (rows.length > 1) throw new TakoformHostError("backend_unavailable", 503);
      if (!rows[0]) return null;
      const parsed = resourceDeletionTombstone(rows[0]);
      const ledger = await this.readResourceEffectLedger(tenantId, resourceUid);
      return ledger.length > 0 ? { ...parsed, effects: ledger } : parsed;
    },

    async cacheResourceDeletionEvidence(input): Promise<boolean> {
      const changed = await sql.run(
        `UPDATE tf_resource_deletion_attestations
         SET evidence_json = ?, evidence_ref = ?, evidence_effect_digest = ?,
             evidence_checked_at = ?, evidence_status = ?, updated_at = ?
         WHERE tenant_id = ? AND resource_uid = ? AND state = 'closed'
           AND closure_fence = ?`,
        [
          canonicalJson(input.evidence),
          input.evidenceRef,
          input.effectSetDigest,
          input.checkedAt,
          input.status,
          now(),
          input.tenantId,
          input.resourceUid,
          input.closureFence,
        ],
      );
      return changed.changes === 1;
    },

    async acceptProviderMutationSaga(record) {
      const timestamp = now();
      const legacyFence = legacyOperationConflictFence(record);
      await sql.run(
        `INSERT OR IGNORE INTO ${PROVIDER_MUTATION_SAGA_TABLE}
           (operation_id, protocol_generation, operation_kind, replay_key,
            tenant_id, fingerprint, resource_uid,
            target_space, target_api_version, target_kind, target_name,
            accepted_uid, accepted_generation, accepted_revision, phase,
            receipt_json, authority_head_digest, created_at, updated_at, expires_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, ?, ?, ?
         WHERE NOT ${legacyFence.sql}`,
        [
          record.operationId,
          OPERATION_PROTOCOL_GENERATION,
          record.operationKind,
          record.replayKey,
          record.tenantId,
          record.fingerprint,
          record.resourceUid,
          record.target.space,
          record.target.apiVersion,
          record.target.kind,
          record.target.name,
          record.acceptedUid ?? null,
          record.acceptedGeneration ?? null,
          record.acceptedRevision ?? null,
          record.authorityHeadDigest ?? null,
          timestamp,
          timestamp,
          253_402_300_799_999,
          ...legacyFence.params,
        ],
      );
      const rows = await sql.query(
        `SELECT * FROM ${PROVIDER_MUTATION_SAGA_TABLE}
         WHERE (
             replay_key = ? OR
             (tenant_id = ? AND target_space = ? AND target_api_version = ?
               AND target_kind = ? AND target_name = ?)
           ) LIMIT 3`,
        [
          record.replayKey,
          record.tenantId,
          record.target.space,
          record.target.apiVersion,
          record.target.kind,
          record.target.name,
        ],
      );
      const stored = rows[0] ? providerMutationSaga(rows[0]) : null;
      if (
        !stored ||
        rows.length !== 1 ||
        !(stored.replayKey === record.replayKey
          ? sameProviderMutationSaga(record, stored)
          : sameProviderMutationTarget(record, stored))
      ) {
        if (!stored && (await hasLegacyOperationConflict(record))) {
          throw legacyOperationConflictError();
        }
        throw new TakoformHostError("resource_busy", 409);
      }
      if (stored.replayKey === record.replayKey) return stored;
      const rotated = await sql.run(
        `UPDATE ${PROVIDER_MUTATION_SAGA_TABLE}
         SET replay_key = ?, updated_at = ?
         WHERE operation_id = ? AND replay_key = ? AND tenant_id = ?
           AND fingerprint = ? AND resource_uid = ?`,
        [
          record.replayKey,
          timestamp,
          stored.operationId,
          stored.replayKey,
          stored.tenantId,
          stored.fingerprint,
          stored.resourceUid,
        ],
      );
      if (rotated.changes !== 1) throw new TakoformHostError("resource_busy", 409);
      return { ...stored, replayKey: record.replayKey };
    },

    async establishedProviderMutationSaga(record) {
      const rows = await sql.query(
        `SELECT * FROM ${PROVIDER_MUTATION_SAGA_TABLE}
         WHERE operation_id = ? AND tenant_id = ? AND resource_uid = ? LIMIT 2`,
        [record.operationId, record.tenantId, record.resourceUid],
      );
      if (rows.length === 0) return false;
      if (rows.length !== 1) throw new TakoformHostError("resource_busy", 409);
      const row = rows[0];
      if (!row) throw new TakoformHostError("resource_busy", 409);
      const stored = providerMutationSaga(row);
      if (!sameProviderMutationSaga(record, stored)) {
        throw new TakoformHostError("resource_busy", 409);
      }
      return true;
    },

    async acquireProviderMutationExecution(input) {
      const timestamp = now();
      if (input.leaseUntil <= timestamp)
        throw new TypeError("provider lease must be in the future");
      const initial = await sql.run(
        `UPDATE ${PROVIDER_MUTATION_SAGA_TABLE}
         SET execution_lease_token = ?, execution_lease_until = ?,
             updated_at = ?
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL
           AND execution_started_at IS NULL
           AND (execution_lease_token IS NULL OR execution_lease_until <= ?)`,
        [
          input.leaseToken,
          input.leaseUntil,
          timestamp,
          input.tenantId,
          input.operationId,
          input.resourceUid,
          timestamp,
        ],
      );
      if (initial.changes === 1) {
        const stateRows = await sql.query(
          `SELECT selection_json
           FROM ${PROVIDER_MUTATION_SAGA_TABLE}
           WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
             AND execution_lease_token = ? LIMIT 1`,
          [input.tenantId, input.operationId, input.resourceUid, input.leaseToken],
        );
        return {
          kind: "acquired",
          mode: "initial",
          ...providerMutationApplySelectionState(stateRows[0]),
        };
      }

      const recovery = await sql.run(
        `UPDATE ${PROVIDER_MUTATION_SAGA_TABLE}
         SET execution_lease_token = ?, execution_lease_until = ?, updated_at = ?
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL
           AND execution_started_at IS NOT NULL
           AND (execution_lease_token IS NULL OR execution_lease_until <= ?)`,
        [
          input.leaseToken,
          input.leaseUntil,
          timestamp,
          input.tenantId,
          input.operationId,
          input.resourceUid,
          timestamp,
        ],
      );
      if (recovery.changes === 1) {
        const stateRows = await sql.query(
          `SELECT provider_handle, provider_outcome, selection_json
           FROM ${PROVIDER_MUTATION_SAGA_TABLE}
           WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
             AND execution_lease_token = ? LIMIT 1`,
          [input.tenantId, input.operationId, input.resourceUid, input.leaseToken],
        );
        return {
          kind: "acquired",
          mode: "recovery",
          ...providerMutationExecutionState(stateRows[0]),
        };
      }

      const rows = await sql.query(
        `SELECT phase, receipt_json FROM ${PROVIDER_MUTATION_SAGA_TABLE}
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ? LIMIT 2`,
        [input.tenantId, input.operationId, input.resourceUid],
      );
      if (rows.length > 1) throw new Error("provider_mutation_saga_ambiguous");
      const row = rows[0];
      if (row?.phase === "executed") {
        return { kind: "executed", receipt: providerReceipt(row.receipt_json) };
      }
      return { kind: "busy" };
    },

    async bindProviderMutationApplySelection(input) {
      const timestamp = now();
      const selectionJson = encodeTakoformApplySelection(input.selection);
      // Preparation can already cross effectful extension boundaries after
      // this acceptance. Keep its exact destination and deferred command as
      // one repair unit even if the invocation never reaches dispatch.
      const [bound] = await sql.batch([
        {
          sql: `UPDATE ${PROVIDER_MUTATION_SAGA_TABLE}
         SET selection_json = COALESCE(selection_json, ?),
             selection_verified_lease_token = ?, updated_at = ?, expires_at = 253402300799999
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND fingerprint = ? AND operation_kind = 'apply'
           AND phase = 'planned' AND receipt_json IS NULL
           AND execution_lease_token = ? AND execution_lease_until > ?
           AND execution_started_at IS ${input.mode === "initial" ? "NULL" : "NOT NULL"}
           AND ${
             input.mode === "initial"
               ? "(selection_json IS NULL OR selection_json = ?)"
               : "selection_json = ?"
}`,
          params: [
            selectionJson,
            input.leaseToken,
            timestamp,
            input.tenantId,
            input.operationId,
            input.resourceUid,
            input.fingerprint,
            input.leaseToken,
            timestamp,
            selectionJson,
          ],
        },
        {
          sql: `UPDATE ${DEFERRED_OPERATION_TABLE}
                SET expires_at = 253402300799999, updated_at = ?
                WHERE id = ? AND tenant_id = ? AND resource_uid = ?
                  AND operation = 'apply' AND phase = 'committing'
                  AND EXISTS (
                    SELECT 1 FROM ${PROVIDER_MUTATION_SAGA_TABLE} AS saga
                    WHERE saga.operation_id = ${DEFERRED_OPERATION_TABLE}.id
                      AND saga.tenant_id = ${DEFERRED_OPERATION_TABLE}.tenant_id
                      AND saga.resource_uid = ${DEFERRED_OPERATION_TABLE}.resource_uid
                      AND saga.fingerprint = ? AND saga.selection_json = ?
                      AND saga.phase = 'planned' AND saga.receipt_json IS NULL
                      AND saga.execution_started_at IS ${input.mode === "initial" ? "NULL" : "NOT NULL"}
                      AND saga.execution_lease_token = ? AND saga.execution_lease_until > ?
                      AND saga.selection_verified_lease_token = saga.execution_lease_token
                  )`,
          params: [
            timestamp,
            input.operationId,
            input.tenantId,
            input.resourceUid,
            input.fingerprint,
            selectionJson,
            input.leaseToken,
            timestamp,
          ],
        },
      ]);
      if (bound?.changes !== 1) return null;
      const rows = await sql.query(
        `SELECT selection_json FROM ${PROVIDER_MUTATION_SAGA_TABLE}
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND fingerprint = ? AND execution_lease_token = ? LIMIT 2`,
        [input.tenantId, input.operationId, input.resourceUid, input.fingerprint, input.leaseToken],
      );
      if (rows.length !== 1 || typeof rows[0]?.selection_json !== "string") return null;
      return parseTakoformApplySelection(rows[0].selection_json);
    },

    async markProviderMutationDispatch(input) {
      const timestamp = now();
      const mode = input.mode ?? "initial";
      const dependencies = input.dependencySet;
      if (dependencies && !input.dependencyReservationOwnerId) {
        throw new TypeError("dependency dispatch requires its reservation owner");
      }
      if (dependencies && dependencies.operationId !== input.operationId) {
        throw new TypeError("dependency dispatch has the wrong operation identity");
      }
      const dependencyKeys = dependencies ? resourceDependencyClaimKeys(dependencies) : [];
      if (
        new Set(dependencyKeys).size !== dependencyKeys.length ||
        dependencyKeys.some((key) => !isResourceDependencyClaimKey(key))
      ) {
        throw new TypeError("invalid provider dependency set");
      }
      const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
      const dependencyKeysJson = dependencies ? resourceDependencyKeysJson(dependencies) : null;
      const dependencyFencesJson = dependencies ? resourceDependencyFencesJson(dependencies) : null;
      const sagaGuard = boundedGuard(`dispatch_saga_${input.leaseToken}`);
      const targetGuard = boundedGuard(`dispatch_targets_${input.leaseToken}`);
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                SELECT ?, CASE WHEN EXISTS (
                  SELECT 1 FROM ${PROVIDER_MUTATION_SAGA_TABLE}
                  WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
                    AND phase = 'planned' AND receipt_json IS NULL
                    AND execution_lease_token = ? AND execution_lease_until > ?
                    AND execution_started_at IS ${mode === "initial" ? "NULL" : "NOT NULL"}
                )${
                  dependencies
                    ? ` AND (
                    SELECT COUNT(*) FROM tf_resource_claims
                    WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                      AND claim_key >= ? AND claim_key < ?
                      AND (state = 'committed' OR expires_at > ?)
                  ) = json_array_length(?) AND NOT EXISTS (
                    SELECT 1 FROM json_each(?) AS expected
                    WHERE NOT EXISTS (
                      SELECT 1 FROM tf_resource_claims AS dependency
                      WHERE dependency.claim_key = CAST(expected.value AS TEXT)
                        AND dependency.owner_operation_id = ? AND dependency.tenant_id = ?
                        AND dependency.holder_uid = ?
                        AND (dependency.state = 'committed' OR dependency.expires_at > ?)
                    )
                  )`
                    : ""
                } THEN 1 ELSE 0 END`,
          params: [
            sagaGuard,
            input.tenantId,
            input.operationId,
            input.resourceUid,
            input.leaseToken,
            timestamp,
            ...(dependencies
              ? [
                  input.dependencyReservationOwnerId as string,
                  input.tenantId,
                  input.resourceUid,
                  dependencyStart,
                  dependencyEnd,
                  timestamp,
                  dependencyKeysJson as string,
                  dependencyKeysJson as string,
                  input.dependencyReservationOwnerId as string,
                  input.tenantId,
                  input.resourceUid,
                  timestamp,
                ]
              : []),
          ],
        },
      ];
      if (dependencies) {
        statements.push({
          sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                SELECT ?, CASE WHEN NOT EXISTS (
                  SELECT 1 FROM json_each(?) AS fence
                  WHERE NOT EXISTS (
                    SELECT 1 FROM tf_resource_claims AS dependency
                    WHERE dependency.claim_key = json_extract(fence.value, '$[0]')
                      AND dependency.owner_operation_id = ?
                      AND dependency.tenant_id = ? AND dependency.holder_uid = ?
                      AND (dependency.state = 'committed' OR dependency.expires_at > ?)
                      AND EXISTS (
                        SELECT 1 FROM tf_resources AS target
                        WHERE target.tenant_id = dependency.tenant_id
                          AND target.space = json_extract(fence.value, '$[1]')
                          AND target.api_version = json_extract(fence.value, '$[2]')
                          AND target.kind = json_extract(fence.value, '$[3]')
                          AND target.name = json_extract(fence.value, '$[4]')
                          AND target.uid = json_extract(fence.value, '$[5]')
                          AND target.revision = json_extract(fence.value, '$[6]')
                          AND EXISTS (
                            SELECT 1 FROM tf_resource_deletion_attestations AS attestation
                            WHERE attestation.tenant_id = target.tenant_id
                              AND attestation.resource_uid = target.uid
                              AND attestation.space = target.space
                              AND attestation.api_version = target.api_version
                              AND attestation.kind = target.kind
                              AND attestation.name = target.name
                              AND attestation.form_ref_json = json_extract(fence.value, '$[7]')
                              AND attestation.state = 'live'
                          )
                      )
                  )
                ) THEN 1 ELSE 0 END`,
          params: [
            targetGuard,
            dependencyFencesJson as string,
            input.dependencyReservationOwnerId as string,
            input.tenantId,
            input.resourceUid,
            timestamp,
          ],
        });
      }
      const sagaStatementIndex = statements.length;
      statements.push({
        sql: `UPDATE ${PROVIDER_MUTATION_SAGA_TABLE}
              SET execution_started_at = COALESCE(execution_started_at, ?),
                  provider_outcome = CASE
                    WHEN execution_started_at IS NULL THEN 'running'
                    ELSE provider_outcome
                  END,
                  updated_at = ?, expires_at = 253402300799999
              WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
                AND phase = 'planned' AND receipt_json IS NULL
                AND execution_lease_token = ? AND execution_lease_until > ?
                AND execution_started_at IS ${mode === "initial" ? "NULL" : "NOT NULL"}`,
        params: [
          timestamp,
          timestamp,
          input.tenantId,
          input.operationId,
          input.resourceUid,
          input.leaseToken,
          timestamp,
        ],
      });
      if (dependencies) {
        statements.push({
          // A newly selected edge stays reserved: if the following on-dispatch
          // ledger callback refuses before provider entry, proven-idle cleanup
          // may remove it. Its horizon becomes the same non-expiring repair
          // horizon as the dispatched saga; prior committed edges stay live.
          sql: `UPDATE tf_resource_claims
                SET owner_operation_id = ?,
                    expires_at = CASE
                      WHEN state = 'reserved' THEN 253402300799999
                      ELSE NULL
                    END,
                    updated_at = ?
                WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                  AND claim_key >= ? AND claim_key < ?
                  AND (state = 'committed' OR expires_at > ?)`,
          params: [
            input.operationId,
            timestamp,
            input.dependencyReservationOwnerId as string,
            input.tenantId,
            input.resourceUid,
            dependencyStart,
            dependencyEnd,
            timestamp,
          ],
        });
      }
      statements.push({
        // A deferred Host command and its dispatched provider saga become one
        // non-expiring repair unit in this transactional batch. An immediate
        // mutation simply matches no Host row.
        sql: `UPDATE ${DEFERRED_OPERATION_TABLE}
              SET expires_at = 253402300799999, updated_at = ?
              WHERE id = ? AND tenant_id = ? AND resource_uid = ?
                AND phase = 'committing'
                AND EXISTS (
                  SELECT 1 FROM ${PROVIDER_MUTATION_SAGA_TABLE} AS saga
                  WHERE saga.operation_id = ${DEFERRED_OPERATION_TABLE}.id
                    AND saga.tenant_id = ${DEFERRED_OPERATION_TABLE}.tenant_id
                    AND saga.resource_uid = ${DEFERRED_OPERATION_TABLE}.resource_uid
                    AND saga.phase = 'planned' AND saga.receipt_json IS NULL
                    AND saga.execution_started_at IS NOT NULL
                    AND saga.execution_lease_token = ?
                )`,
        params: [timestamp, input.operationId, input.tenantId, input.resourceUid, input.leaseToken],
      });
      if (dependencies) {
        statements.push({
          sql: "DELETE FROM tf_operation_commit_guards WHERE token IN (?, ?)",
          params: [targetGuard, sagaGuard],
        });
      } else {
        statements.push({
          sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
          params: [sagaGuard],
        });
      }
      try {
        const results = await sql.batch(statements);
        return results[sagaStatementIndex]?.changes === 1;
      } catch (error) {
        if (!(error instanceof SqlError) || error.code !== "constraint") throw error;
        if (!dependencies) return false;
        if (
          !(await resourceDependenciesStillCurrent(sql, now, {
            tenantId: input.tenantId,
            resourceUid: input.resourceUid,
            ownerId: input.dependencyReservationOwnerId as string,
            dependencies,
          }))
        ) {
          return "dependency_changed";
        }
        return false;
      }
    },

    async recordProviderMutationOutcome(input) {
      if (input.outcome !== "running" && input.outcome !== "indeterminate") {
        throw new TypeError("invalid provider mutation outcome");
      }
      if (input.providerHandle !== undefined && input.providerHandle.length === 0) {
        throw new TypeError("provider mutation handle must not be empty");
      }
      if (input.outcome === "running" && input.providerHandle === undefined) {
        throw new TypeError("a running provider mutation must retain its handle");
      }
      const timestamp = now();
      const recorded = await sql.run(
        `UPDATE ${PROVIDER_MUTATION_SAGA_TABLE}
         SET provider_handle = ?, provider_outcome = ?, updated_at = ?
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL
           AND execution_started_at IS NOT NULL
           AND execution_lease_token = ? AND execution_lease_until > ?`,
        [
          input.providerHandle ?? null,
          input.outcome,
          timestamp,
          input.tenantId,
          input.operationId,
          input.resourceUid,
          input.leaseToken,
          timestamp,
        ],
      );
      return recorded.changes === 1;
    },

    async settleProviderMutationPreconditionFailure(input) {
      if (input.recoveryAction !== undefined && input.recoveryAction !== "convergeApply") {
        throw new TypeError("invalid provider refusal recovery action");
      }
      const settled = await sql.run(
        `DELETE FROM ${PROVIDER_MUTATION_SAGA_TABLE}
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL
           AND provider_handle IS NULL AND provider_outcome ${input.recoveryAction === "convergeApply" ? "IN ('running', 'indeterminate')" : "= 'running'"}
           ${input.recoveryAction === "convergeApply" ? "AND accepted_uid IS NULL AND accepted_generation IS NULL AND accepted_revision IS NULL" : ""}
           AND execution_started_at IS NOT NULL
           AND execution_lease_token = ? AND execution_lease_until > ?`,
        [input.tenantId, input.operationId, input.resourceUid, input.leaseToken, now()],
      );
      return settled.changes === 1;
    },

    async commitDefinitiveProviderMutationFailure(input) {
      assertDefinitiveProviderMutationFailure(input);
      const timestamp = now();
      const releaseIdentity = {
        organizationId: input.saga.tenantId,
        reference: input.charge.reference,
        amountMinor: input.charge.amountMinor,
      };
      const releaseFence = ledgerHoldReleaseCommittedFence(releaseIdentity);
      const committedFence = definitiveProviderFailureCommittedFence(input, releaseFence);
      const committed = async (): Promise<boolean> => {
        const rows = await sql.query(
          `SELECT CASE WHEN ${committedFence.sql} THEN 1 ELSE 0 END AS committed`,
          committedFence.params,
        );
        return Number(rows[0]?.committed ?? 0) === 1;
      };

      // A release without the rest of this exact lifecycle is not replay
      // evidence. Check the whole terminal shape before asking the ledger to
      // plan from the still-held allocation, otherwise an acknowledgement lost
      // after commit would look like a conservation failure on retry.
      if (await committed()) return true;

      const release = await prepareLedgerHoldRelease(sql, clock, releaseIdentity);
      const initialFence = definitiveProviderFailureInitialFence(input, timestamp);
      const initialGuard = boundedGuard(
        `definitive_failure_start_${input.saga.operationId}_${input.providerLeaseToken}`,
      );
      const committedGuard = boundedGuard(
        `definitive_failure_result_${input.saga.operationId}_${input.providerLeaseToken}`,
      );
      const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
      const cancelledEvent = canonicalJson({
        eventId: `${input.saga.operationId}:cancelled`,
        operationId: input.saga.operationId,
        kind: "apply",
        phase: "cancelled",
        operationMode: "initial",
      });
      const incarnationRelease =
        input.operation === "create"
          ? uncommittedResourceIncarnationRelease({
              tenantId: input.saga.tenantId,
              resourceUid: input.saga.resourceUid,
              effectId: input.saga.operationId,
            })
          : undefined;
      const hostOperation = input.hostOperation;
      const operationCreatedAt =
        hostOperation.kind === "deferred"
          ? hostOperation.operation.createdAt
          : hostOperation.createdAt;
      const storedOperation =
        hostOperation.kind === "deferred" ? hostOperation.operation.operation : input.operation;
      const statements: SqlStatement[] = [
        {
          sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                SELECT ?, CASE WHEN ${initialFence.sql} THEN 1 ELSE 0 END`,
          params: [initialGuard, ...initialFence.params],
        },
        ...release.statements,
        {
          sql: `INSERT INTO tf_resource_provider_effects
                  (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
                   operation_mode, provider_pack_ref, provider_installation_ref,
                   native_id, target_json, created_at)
                VALUES (?, ?, ?, ?, 'apply', 'cancelled', 'initial', NULL, NULL, NULL, NULL, ?)`,
          params: [
            input.saga.tenantId,
            input.saga.resourceUid,
            `${input.saga.operationId}:cancelled`,
            input.saga.operationId,
            timestamp,
          ],
        },
        {
          sql: `UPDATE tf_resource_deletion_attestations
                SET closure_fence = closure_fence + 1,
                    effects_json = json_insert(effects_json, '$[#]', json(?)),
                    evidence_json = NULL, evidence_ref = NULL,
                    evidence_effect_digest = NULL, evidence_checked_at = NULL,
                    evidence_status = NULL, updated_at = ?
                WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'`,
          params: [cancelledEvent, timestamp, input.saga.tenantId, input.saga.resourceUid],
        },
        {
          sql: `DELETE FROM tf_resource_claims
                WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                  AND state = 'reserved'
                  AND NOT (claim_key >= ? AND claim_key < ?)`,
          params: [
            input.claimOwnerId,
            input.saga.tenantId,
            input.saga.resourceUid,
            dependencyStart,
            dependencyEnd,
          ],
        },
        {
          sql: `DELETE FROM tf_resource_claims
                WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                  AND state = 'reserved' AND claim_key >= ? AND claim_key < ?`,
          params: [
            input.saga.operationId,
            input.saga.tenantId,
            input.saga.resourceUid,
            dependencyStart,
            dependencyEnd,
          ],
        },
        ...(incarnationRelease?.statements ?? []),
        ...(hostOperation.kind === "deferred"
          ? [
              {
                sql: `UPDATE ${DEFERRED_OPERATION_TABLE}
                      SET phase = 'failed', terminal_json = ?, committed_uid = NULL,
                          lease_token = NULL, lease_until = NULL, updated_at = ?, expires_at = ?
                      WHERE id = ? AND tenant_id = ? AND principal_id = ?
                        AND phase = 'committing' AND lease_token = ? AND lease_until > ?`,
                params: [
                  hostOperation.terminalJson,
                  timestamp,
                  timestamp + OPERATION_TTL_MILLISECONDS,
                  hostOperation.operation.id,
                  hostOperation.operation.tenantId,
                  hostOperation.operation.principalId,
                  hostOperation.leaseToken,
                  timestamp,
                ],
              },
            ]
          : []),
        {
          sql: `INSERT INTO tf_operations
                  (id, tenant_id, operation, state, resource_json, created_at, expires_at)
                VALUES (?, ?, ?, 'failed', NULL, ?, ?)`,
          params: [
            input.saga.operationId,
            input.saga.tenantId,
            storedOperation,
            operationCreatedAt,
            timestamp + OPERATION_TTL_MILLISECONDS,
          ],
        },
        {
          sql: `DELETE FROM ${PROVIDER_MUTATION_SAGA_TABLE}
                WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
                  AND phase = 'planned' AND receipt_json IS NULL
                  AND provider_handle IS NULL AND provider_outcome ${input.recoveryAction === "convergeApply" ? "IN ('running', 'indeterminate')" : "= 'running'"}
                  AND execution_started_at IS NOT NULL
                  AND execution_lease_token = ? AND execution_lease_until > ?`,
          params: [
            input.saga.tenantId,
            input.saga.operationId,
            input.saga.resourceUid,
            input.providerLeaseToken,
            timestamp,
          ],
        },
        {
          sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                SELECT ?, CASE WHEN ${committedFence.sql} THEN 1 ELSE 0 END`,
          params: [committedGuard, ...committedFence.params],
        },
        {
          sql: "DELETE FROM tf_operation_commit_guards WHERE token IN (?, ?)",
          params: [committedGuard, initialGuard],
        },
      ];
      try {
        await sql.batch(statements);
        return true;
      } catch (error) {
        if (await committed()) return true;
        if (error instanceof SqlError && error.code === "constraint") return false;
        throw error;
      }
    },

    async releaseProviderMutationExecution(input) {
      const released = await sql.run(
        `UPDATE ${PROVIDER_MUTATION_SAGA_TABLE}
         SET execution_lease_token = NULL, execution_lease_until = NULL, updated_at = ?
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL
           AND execution_lease_token = ?`,
        [now(), input.tenantId, input.operationId, input.resourceUid, input.leaseToken],
      );
      return released.changes === 1;
    },

    async readProviderMutationReceipt(tenantId, operationId, resourceUid) {
      const rows = await sql.query(
        `SELECT receipt_json FROM ${PROVIDER_MUTATION_SAGA_TABLE}
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'executed' LIMIT 2`,
        [tenantId, operationId, resourceUid],
      );
      if (rows.length > 1) throw new Error("provider_mutation_saga_ambiguous");
      return rows[0] ? providerReceipt(rows[0].receipt_json) : null;
    },

    async providerMutationPlanExists(tenantId, operationId, resourceUid) {
      const rows = await sql.query(
        `SELECT 1 AS found FROM ${PROVIDER_MUTATION_SAGA_TABLE}
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL LIMIT 2`,
        [tenantId, operationId, resourceUid],
      );
      if (rows.length > 1) throw new Error("provider_mutation_saga_ambiguous");
      return rows.length === 1;
    },

    async abandonProviderMutationPlan(input) {
      const removed = await sql.run(
        `DELETE FROM ${PROVIDER_MUTATION_SAGA_TABLE}
         WHERE tenant_id = ? AND operation_id = ? AND replay_key = ? AND resource_uid = ?
           AND protocol_generation = 1
           AND phase = 'planned' AND receipt_json IS NULL
           AND execution_lease_token IS NULL AND execution_started_at IS NULL`,
        [input.tenantId, input.operationId, input.replayKey, input.resourceUid],
      );
      return removed.changes === 1;
    },

    async settleDefinitiveProviderImportFailure(input) {
      if (input.outcome !== "import_conflict" && input.outcome !== "adoption_aborted") {
        throw new TypeError("provider import outcome must be definitive");
      }
      const timestamp = now();
      const removed = await sql.run(
        `DELETE FROM ${PROVIDER_MUTATION_SAGA_TABLE}
         WHERE tenant_id = ? AND operation_id = ? AND replay_key = ? AND resource_uid = ?
           AND protocol_generation = 1 AND operation_kind = 'import'
           AND phase = 'planned' AND receipt_json IS NULL
           AND execution_lease_token = ? AND execution_lease_until > ?
           AND execution_started_at IS NOT NULL`,
        [
          input.tenantId,
          input.operationId,
          input.replayKey,
          input.resourceUid,
          input.leaseToken,
          timestamp,
        ],
      );
      return removed.changes === 1;
    },

    async recordProviderMutationReceipt(input) {
      const serialized = canonicalJson(input.receipt);
      const timestamp = now();
      const guard = boundedGuard(`receipt_${input.leaseToken}`);
      const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
      try {
        await sql.batch([
          {
            sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                  SELECT ?, CASE WHEN EXISTS (
                    SELECT 1 FROM ${PROVIDER_MUTATION_SAGA_TABLE}
                    WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
                      AND authority_head_digest IS ?
                      AND phase = 'planned' AND receipt_json IS NULL
                      AND execution_lease_token = ? AND execution_lease_until > ?
                      AND execution_started_at IS NOT NULL
                  ) THEN 1 ELSE 0 END`,
            params: [
              guard,
              input.tenantId,
              input.operationId,
              input.resourceUid,
              input.authorityHeadDigest ?? null,
              input.leaseToken,
              timestamp,
            ],
          },
          {
            sql: `UPDATE ${PROVIDER_MUTATION_SAGA_TABLE}
                  SET phase = 'executed', receipt_json = ?, updated_at = ?, expires_at = NULL,
                      execution_lease_token = NULL, execution_lease_until = NULL,
                      provider_handle = NULL, provider_outcome = 'planned'
                  WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
                    AND authority_head_digest IS ?
                    AND phase = 'planned' AND receipt_json IS NULL
                    AND execution_lease_token = ? AND execution_lease_until > ?
                    AND execution_started_at IS NOT NULL`,
            params: [
              serialized,
              timestamp,
              input.tenantId,
              input.operationId,
              input.resourceUid,
              input.authorityHeadDigest ?? null,
              input.leaseToken,
              timestamp,
            ],
          },
          ...(input.claimOwnerId
            ? [
                {
                  sql: `UPDATE tf_resource_claims
                        SET state = 'committed', expires_at = NULL, updated_at = ?
                        WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                          AND state = 'reserved'
                          AND NOT (claim_key >= ? AND claim_key < ?)`,
                  params: [
                    timestamp,
                    input.claimOwnerId,
                    input.tenantId,
                    input.resourceUid,
                    dependencyStart,
                    dependencyEnd,
                  ],
                },
                {
                  sql: `UPDATE ${DEFERRED_OPERATION_TABLE}
                        SET expires_at = 253402300799999, updated_at = ?
                        WHERE id = ? AND tenant_id = ? AND resource_uid = ?
                          AND phase = 'committing' AND lease_token = ?`,
                  params: [
                    timestamp,
                    input.operationId,
                    input.tenantId,
                    input.resourceUid,
                    input.claimOwnerId,
                  ],
                },
              ]
            : []),
          {
            sql: `UPDATE tf_resource_claims
                  SET state = 'committed', expires_at = NULL, updated_at = ?
                  WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                    AND state = 'reserved' AND claim_key >= ? AND claim_key < ?`,
            params: [
              timestamp,
              input.operationId,
              input.tenantId,
              input.resourceUid,
              dependencyStart,
              dependencyEnd,
            ],
          },
          {
            sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
            params: [guard],
          },
        ]);
      } catch (error) {
        if (!(error instanceof SqlError) || error.code !== "constraint") throw error;
        const existing = await this.readProviderMutationReceipt(
          input.tenantId,
          input.operationId,
          input.resourceUid,
        );
        if (existing && canonicalJson(existing) === serialized) return;
        throw new TakoformHostError("resource_busy", 409);
      }
    },

    /**
     * Holds a command whose provider mutation may have crossed the boundary.
     *
     * An apply or an import is held without an end: its provider evidence is a
     * native object that exists, and the exact Host command is the only thing
     * that can reconcile it. A **delete** is bounded. The same row owns the
     * caller's replay key, so a delete acceptance that can never settle refuses
     * every later attempt at the same delete for the life of the deployment —
     * which is how the end-to-end teardown came to be permanently wedged. The
     * window runs from acceptance rather than from the last repair attempt, so
     * the repair loop re-entering the hold cannot push it out forever, and the
     * dispatched saga row keeps its own non-expiring provider evidence either
     * way.
     */
    async holdDeferredProviderRepair(input) {
      const accepted = Date.parse(input.operation.createdAt);
      const expiresAt =
        input.operation.operation === "delete"
          ? (Number.isFinite(accepted) ? accepted : now()) + PROVIDER_REPAIR_HOLD_TTL_MILLISECONDS
          : 253_402_300_799_999;
      const held = await sql.run(
        `UPDATE ${DEFERRED_OPERATION_TABLE}
         SET lease_token = NULL, lease_until = NULL,
             expires_at = ?, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND principal_id = ?
           AND phase = 'committing' AND lease_token = ?`,
        [
          expiresAt,
          now(),
          input.operation.id,
          input.operation.tenantId,
          input.operation.principalId,
          input.leaseToken,
        ],
      );
      return held.changes === 1;
    },

    async commitImmediateMutation(input) {
      const { mutation } = input;
      assertResourceMutationOperation(input.operation, mutation);
      assertResourceMutationIdentity({ tenantId: input.tenantId, mutation });
      const guard = boundedGuard(`guard_${input.operationId}`);
      const authority = mutation.authorityFence
        ? await authorityFenceSql(mutation.authorityFence)
        : { sql: "1 = 1", params: [] as readonly SqlParam[] };
      const statements = providerMutationCommitStatements({
        guard,
        tenantId: input.tenantId,
        operationId: input.operationId,
        operation: input.operation,
        createdAt: input.createdAt,
        mutation,
        claimOwnerId: input.operationId,
        now: now(),
        additionalFence: authority.sql,
        additionalFenceParams: authority.params,
      });
      try {
        await sql.batch(statements);
      } catch (error) {
        if (!(error instanceof SqlError) || error.code !== "constraint") throw error;
        if (
          await exactCommittedMutationReplay({
            tenantId: input.tenantId,
            operationId: input.operationId,
            operation: input.operation,
            mutation,
            fenceDeleteRevision: true,
          })
        ) {
          return;
        }
        const claimKeys = mutation.claimKeys ?? [];
        if (claimKeys.length > 0) {
          const owned = await sql.query(
            `SELECT claim_key FROM tf_resource_claims
             WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
               AND claim_key IN (${claimKeys.map(() => "?").join(", ")})`,
            [input.operationId, input.tenantId, mutation.resourceUid, ...claimKeys],
          );
          if (owned.length !== claimKeys.length) {
            throw new TakoformHostError("invalid_argument", 400);
          }
        }
        throw new TakoformHostError("resource_busy", 409);
      }
    },

    async acceptDeferredOperation(record): Promise<DeferredOperationRecord> {
      await sql.run(
        `DELETE FROM ${DEFERRED_OPERATION_TABLE} WHERE rowid IN (
           SELECT rowid FROM ${DEFERRED_OPERATION_TABLE}
           WHERE phase IN ('succeeded', 'failed', 'cancelled') AND expires_at <= ?
           ORDER BY expires_at LIMIT ?
         )`,
        [now(), SWEEP_ROW_LIMIT],
      );
      const identity: OperationGenerationIdentity = {
        operationId: record.id,
        replayKey: record.replayKey,
        tenantId: record.tenantId,
        resourceUid: record.resourceUid,
        target: { tenantId: record.tenantId, ...record.target },
      };
      const legacyFence = legacyOperationConflictFence(identity);
      await sql.run(
        `INSERT OR IGNORE INTO ${DEFERRED_OPERATION_TABLE}
           (id, protocol_generation, tenant_id, principal_id, operation, phase,
            request_path, request_query,
            request_headers_json, request_body_json, fingerprint, replay_key,
            target_space, target_api_version, target_kind, target_name,
            target_form_ref_json, accepted_uid, accepted_generation, accepted_revision,
            resource_uid, worker_endpoint_origin_reservation_id, polls_remaining,
            lease_token, lease_until, terminal_json,
            committed_uid, created_at, updated_at, expires_at)
         SELECT ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                NULL, NULL, NULL, NULL, ?, ?, ?
         WHERE NOT ${legacyFence.sql}`,
        [
          record.id,
          OPERATION_PROTOCOL_GENERATION,
          record.tenantId,
          record.principalId,
          record.operation,
          record.requestPath,
          record.requestQuery,
          JSON.stringify(record.requestHeaders),
          record.requestBody ?? null,
          record.fingerprint,
          record.replayKey,
          record.target.space,
          record.target.apiVersion,
          record.target.kind,
          record.target.name,
          JSON.stringify(record.target.formRef),
          record.acceptedUid ?? null,
          record.acceptedGeneration ?? null,
          record.acceptedRevision ?? null,
          record.resourceUid,
          record.workerEndpointOriginReservationId ?? null,
          record.pollsRemaining,
          record.createdAt,
          now(),
          253_402_300_799_999,
          ...legacyFence.params,
        ],
      );
      const rows = await sql.query(
        `SELECT * FROM ${DEFERRED_OPERATION_TABLE} WHERE replay_key = ? LIMIT 2`,
        [record.replayKey],
      );
      if (rows.length > 1) throw new Error("deferred_operation_ambiguous");
      if (rows[0]) return deferredOperation(rows[0]);
      if (await hasLegacyOperationConflict(identity)) throw legacyOperationConflictError();
      throw new SqlError("constraint", "deferred operation identity collision");
    },

    async readDeferredOperation(tenantId, principalId, id) {
      const current = await sql.query(
        `SELECT * FROM ${DEFERRED_OPERATION_TABLE}
         WHERE tenant_id = ? AND principal_id = ? AND id = ?
           AND (phase IN ('pending', 'committing') OR expires_at > ?) LIMIT 2`,
        [tenantId, principalId, id, now()],
      );
      if (current.length > 1) throw new Error("deferred_operation_ambiguous");
      if (current[0]) return deferredOperation(current[0]);
      const legacy = await sql.query(
        `SELECT * FROM ${LEGACY_DEFERRED_OPERATION_TABLE}
         WHERE tenant_id = ? AND principal_id = ? AND id = ? LIMIT 2`,
        [tenantId, principalId, id],
      );
      if (legacy.length > 1) throw new Error("legacy_deferred_operation_ambiguous");
      return legacy[0] ? deferredOperation(legacy[0]) : null;
    },

    async deferredOperationExists(id) {
      const rows = await sql.query(
        `SELECT 1 AS found FROM ${DEFERRED_OPERATION_TABLE}
         WHERE id = ? AND (phase IN ('pending', 'committing') OR expires_at > ?)
         UNION ALL
         SELECT 1 AS found FROM ${LEGACY_DEFERRED_OPERATION_TABLE} WHERE id = ?
         LIMIT 2`,
        [id, now(), id],
      );
      return rows.length > 0;
    },

    async readDeferredOperationByReplay(replayKey) {
      return await readDeferredBy("replay_key", replayKey);
    },

    async retireDeferredOperation(id, replayKey) {
      const removed = await sql.run(
        `DELETE FROM ${DEFERRED_OPERATION_TABLE}
         WHERE id = ? AND replay_key = ? AND phase IN ('succeeded', 'failed', 'cancelled')`,
        [id, replayKey],
      );
      return removed.changes === 1;
    },

    async advanceDeferredOperation(input) {
      const decremented = await sql.run(
        `UPDATE ${DEFERRED_OPERATION_TABLE}
         SET polls_remaining = polls_remaining - 1, updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND id = ?
           AND phase = 'pending' AND polls_remaining > 1`,
        [now(), input.tenantId, input.principalId, input.id],
      );
      if (decremented.changes === 1) {
        return {
          operation: await this.readDeferredOperation(input.tenantId, input.principalId, input.id),
          acquired: false,
        };
      }
      // Persist the safe-stop boundary before provider work starts. A caller
      // can now distinguish a cancellation that took from one that lost to
      // the durable commit intent, and a restarted process can resume that
      // intent without guessing whether cancellation was still possible.
      const armed = await sql.run(
        `UPDATE ${DEFERRED_OPERATION_TABLE}
         SET phase = 'committing', polls_remaining = 0,
             lease_token = NULL, lease_until = NULL, updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND id = ?
           AND phase = 'pending' AND polls_remaining <= 1`,
        [now(), input.tenantId, input.principalId, input.id],
      );
      if (armed.changes === 1) {
        return {
          operation: await this.readDeferredOperation(input.tenantId, input.principalId, input.id),
          acquired: false,
        };
      }
      const acquired = await sql.run(
        `UPDATE ${DEFERRED_OPERATION_TABLE}
         SET lease_token = ?, lease_until = ?, updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND id = ?
           AND phase = 'committing' AND (lease_until IS NULL OR lease_until <= ?)`,
        [
          input.leaseToken,
          input.leaseUntil,
          now(),
          input.tenantId,
          input.principalId,
          input.id,
          now(),
        ],
      );
      return {
        operation: await this.readDeferredOperation(input.tenantId, input.principalId, input.id),
        acquired: acquired.changes === 1,
      };
    },

    async recoverableDeferredProviderOperations(limit) {
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) {
        throw new TypeError("invalid provider repair limit");
      }
      const timestamp = now();
      const rows = await sql.query(
        `SELECT operation.*
         FROM ${DEFERRED_OPERATION_TABLE} AS operation
         INNER JOIN ${PROVIDER_MUTATION_SAGA_TABLE} AS saga
           ON saga.operation_id = operation.id
          AND saga.protocol_generation = operation.protocol_generation
          AND saga.operation_kind = operation.operation
          AND saga.tenant_id = operation.tenant_id
          AND saga.fingerprint = operation.fingerprint
          AND saga.resource_uid = operation.resource_uid
          AND saga.target_space = operation.target_space
          AND saga.target_api_version = operation.target_api_version
          AND saga.target_kind = operation.target_kind
          AND saga.target_name = operation.target_name
          AND saga.accepted_uid IS operation.accepted_uid
          AND saga.accepted_generation IS operation.accepted_generation
          AND saga.accepted_revision IS operation.accepted_revision
         WHERE operation.phase = 'committing'
           AND operation.protocol_generation = 1
           AND operation.terminal_json IS NULL
           AND (operation.lease_until IS NULL OR operation.lease_until <= ?)
           AND saga.phase = 'planned'
           AND saga.receipt_json IS NULL
           AND saga.execution_started_at IS NOT NULL
           AND (saga.execution_lease_until IS NULL OR saga.execution_lease_until <= ?)
         ORDER BY operation.updated_at, operation.id
         LIMIT ?`,
        [timestamp, timestamp, limit],
      );
      return rows.map(deferredOperation);
    },

    async cancelDeferredOperation(input) {
      const cancelled = await sql.run(
        `UPDATE ${DEFERRED_OPERATION_TABLE}
         SET phase = 'cancelled', terminal_json = ?, lease_token = NULL, lease_until = NULL,
             updated_at = ?, expires_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND id = ?
           AND phase = 'pending'`,
        [
          input.terminalJson,
          now(),
          now() + OPERATION_TTL_MILLISECONDS,
          input.tenantId,
          input.principalId,
          input.id,
        ],
      );
      if (cancelled.changes === 1) {
        await this.putOperation(input.tenantId, {
          id: input.id,
          operation: "cancel",
          state: "failed",
          createdAt: new Date(now()).toISOString(),
        });
        return "cancelled";
      }
      const record = await this.readDeferredOperation(input.tenantId, input.principalId, input.id);
      if (!record) return "not_found";
      return terminalPhase(record.phase) ? "settled" : "too_late";
    },

    async retireUnpublishableProviderMutation(input) {
      const timestamp = now();
      const [settled] = await sql.batch([
        {
          sql: `UPDATE ${DEFERRED_OPERATION_TABLE}
                SET phase = 'failed', terminal_json = ?, lease_token = NULL, lease_until = NULL,
                    expires_at = ?, updated_at = ?
                WHERE id = ? AND tenant_id = ? AND principal_id = ?
                  AND phase = 'committing' AND lease_token = ?`,
          params: [
            input.terminalJson,
            timestamp + OPERATION_TTL_MILLISECONDS,
            timestamp,
            input.operation.id,
            input.operation.tenantId,
            input.operation.principalId,
            input.leaseToken,
          ],
        },
        {
          sql: `DELETE FROM ${PROVIDER_MUTATION_SAGA_TABLE}
                WHERE operation_id = ? AND tenant_id = ? AND resource_uid = ?
                  AND phase = 'executed'
                  AND EXISTS (
                    SELECT 1 FROM ${DEFERRED_OPERATION_TABLE}
                    WHERE id = ? AND tenant_id = ? AND phase = 'failed'
                  )`,
          params: [
            input.operation.id,
            input.operation.tenantId,
            input.operation.resourceUid,
            input.operation.id,
            input.operation.tenantId,
          ],
        },
      ]);
      if ((settled?.changes ?? 0) !== 1) return false;
      // The durable record of the refusal. It outlives the command row that
      // ADR 0008 retires on the next presentation of the same key, and it is
      // what a reservation repair reads to know this effect settled.
      await this.putOperation(input.operation.tenantId, {
        id: input.operation.id,
        operation: input.operation.operation,
        state: "failed",
        createdAt: input.operation.createdAt,
      });
      return true;
    },

    async settleDeferredFailure(input) {
      const settled = await sql.run(
        `UPDATE ${DEFERRED_OPERATION_TABLE}
         SET phase = 'failed', terminal_json = ?, lease_token = NULL, lease_until = NULL,
             updated_at = ?, expires_at = ?
         WHERE id = ? AND tenant_id = ? AND principal_id = ?
           AND phase = 'committing' AND lease_token = ?`,
        [
          input.terminalJson,
          now(),
          now() + OPERATION_TTL_MILLISECONDS,
          input.operation.id,
          input.operation.tenantId,
          input.operation.principalId,
          input.leaseToken,
        ],
      );
      if (settled.changes === 1) {
        await this.putOperation(input.operation.tenantId, {
          id: input.operation.id,
          operation: input.operation.operation,
          state: "failed",
          createdAt: input.operation.createdAt,
        });
      }
      return settled.changes === 1;
    },

    async commitDeferredMutation(input) {
      const { operation, mutation, leaseToken } = input;
      const timestamp = now();
      const guard = boundedGuard(`guard_${operation.id}_${leaseToken}`);
      const target = operation.target;
      assertResourceMutationOperation(operation.operation, mutation);
      assertResourceMutationIdentity({
        tenantId: operation.tenantId,
        mutation,
        expectedResourceUid: operation.resourceUid,
        expectedAddress: target,
        expectedFormRef: target.formRef,
      });
      const targetKey = [
        operation.tenantId,
        target.space,
        target.apiVersion,
        target.kind,
        target.name,
      ];
      const operationFence = `EXISTS (
        SELECT 1 FROM ${DEFERRED_OPERATION_TABLE}
        WHERE id = ? AND tenant_id = ? AND principal_id = ?
          AND phase = 'committing' AND lease_token = ?
      )`;
      // A delete is fenced by incarnation and generation, never by revision.
      // See `deleteFencesRevision`.
      const fencesRevision = deleteFencesRevision(operation);
      const resourceFence =
        operation.acceptedUid === undefined
          ? `NOT EXISTS (
              SELECT 1 FROM tf_resources
              WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
            )`
          : `EXISTS (
              SELECT 1 FROM tf_resources
              WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
                AND uid = ? AND generation = ?${fencesRevision ? " AND revision = ?" : ""}
                AND json_extract(resource_json, '$.form.formRef.apiVersion') = ?
                AND json_extract(resource_json, '$.form.formRef.kind') = ?
                AND json_extract(resource_json, '$.form.formRef.definitionVersion') = ?
                AND json_extract(resource_json, '$.form.formRef.schemaDigest') = ?
            )`;
      const resourceFenceParameters: SqlParam[] =
        operation.acceptedUid === undefined
          ? targetKey
          : [
              ...targetKey,
              operation.acceptedUid,
              operation.acceptedGeneration ?? "",
              ...(fencesRevision ? [operation.acceptedRevision ?? ""] : []),
              target.formRef.apiVersion,
              target.formRef.kind,
              target.formRef.definitionVersion,
              target.formRef.schemaDigest,
            ];
      const claimKeys = mutation.claimKeys ?? [];
      const claimFence =
        claimKeys.length === 0
          ? "1 = 1"
          : `(SELECT COUNT(*) FROM tf_resource_claims
              WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                AND claim_key IN (${claimKeys.map(() => "?").join(", ")})) = ?`;
      const receiptJson = mutation.providerReceipt
        ? canonicalJson(mutation.providerReceipt)
        : undefined;
      const deployment = deploymentMutationSql(mutation.providerReceipt, timestamp);
      const providerEffect = providerEffectSql(mutation, timestamp);
      const deletionFence = deletionTombstoneFence(mutation, operation.id);
      const executionEvidence = resourceExecutionEvidenceSql({
        tenantId: operation.tenantId,
        operationId: operation.id,
        mutation,
        committedAt: timestamp,
        fenceDeleteRevision: fencesRevision,
      });
      const executionEvidenceGuard = boundedGuard(`evidence_${guard}`);
      const dependencyGuards = resourceDependencyCommitGuards({
        tokenBase: guard,
        tenantId: operation.tenantId,
        resourceUid: mutation.resourceUid,
        operationId: operation.id,
        dependencies: mutation.dependencySet,
      });
      const authority = mutation.authorityFence
        ? await authorityFenceSql(mutation.authorityFence)
        : { sql: "1 = 1", params: [] as readonly SqlParam[] };
      const providerSagaFence = receiptJson
        ? `EXISTS (
        SELECT 1 FROM ${PROVIDER_MUTATION_SAGA_TABLE}
        WHERE operation_id = ? AND replay_key = ? AND tenant_id = ?
          AND fingerprint = ? AND resource_uid = ?
          AND protocol_generation = 1 AND operation_kind = ? AND phase = 'executed'
          AND receipt_json = ?
      )`
        : "1 = 1";
      const statements: SqlStatement[] = [
        ...dependencyGuards.statements,
        {
          sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                SELECT ?, CASE WHEN ${operationFence} AND ${resourceFence}
                                     AND ${claimFence} AND ${providerSagaFence}
                                     AND ${deployment.fence}
                                     AND ${deletionFence.sql}
                                     AND ${providerEffect.fence}
                                     AND (${authority.sql}) THEN 1 ELSE 0 END`,
          params: [
            guard,
            operation.id,
            operation.tenantId,
            operation.principalId,
            leaseToken,
            ...resourceFenceParameters,
            ...(claimKeys.length === 0
              ? []
              : [
                  leaseToken,
                  operation.tenantId,
                  operation.resourceUid,
                  ...claimKeys,
                  claimKeys.length,
                ]),
            ...(receiptJson
              ? [
                  operation.id,
                  mutation.replayKey,
                  operation.tenantId,
                  mutation.replay.fingerprint,
                  mutation.resourceUid,
                  operation.operation,
                  receiptJson,
                ]
              : []),
            ...deployment.fenceParams,
            ...deletionFence.params,
            ...providerEffect.fenceParams,
            ...authority.params,
          ],
        },
        resourceExecutionEvidenceGuardStatement(executionEvidenceGuard, executionEvidence),
        ...deployment.statements,
        ...providerEffect.statements,
        ...deletionTombstoneStatements(mutation, timestamp),
        ...executionEvidence.statements,
      ];
      if (mutation.kind === "write") {
        const resource = mutation.resource;
        if (!resource) throw new TypeError("write commit requires a resource");
        const relations = mutation.relations ?? [];
        const [packageDigest, implementationDigest] = exactResourceDigests(resource);
        if (operation.acceptedUid === undefined) {
          statements.push({
            sql: `INSERT INTO tf_resources
                    (tenant_id, space, api_version, kind, name, uid, generation, revision,
                     resource_json, relations_json, package_digest, implementation_digest, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            params: [
              ...targetKey,
              resource.metadata.uid,
              resource.metadata.generation,
              resource.metadata.revision,
              JSON.stringify(resource),
              JSON.stringify(relations),
              packageDigest,
              implementationDigest,
              timestamp,
            ],
          });
        } else {
          statements.push({
            sql: `UPDATE tf_resources
                  SET uid = ?, generation = ?, revision = ?, resource_json = ?,
                      relations_json = ?, package_digest = ?, implementation_digest = ?, updated_at = ?
                  WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
                    AND uid = ? AND generation = ? AND revision = ?`,
            params: [
              resource.metadata.uid,
              resource.metadata.generation,
              resource.metadata.revision,
              JSON.stringify(resource),
              JSON.stringify(relations),
              packageDigest,
              implementationDigest,
              timestamp,
              ...targetKey,
              operation.acceptedUid,
              operation.acceptedGeneration ?? "",
              operation.acceptedRevision ?? "",
            ],
          });
        }
      } else {
        statements.push({
          sql: `DELETE FROM tf_resources
                WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
                  AND uid = ? AND generation = ?${fencesRevision ? " AND revision = ?" : ""}`,
          params: [
            ...targetKey,
            operation.acceptedUid ?? "",
            operation.acceptedGeneration ?? "",
            ...(fencesRevision ? [operation.acceptedRevision ?? ""] : []),
          ],
        });
      }
      statements.push(
        {
          sql: `INSERT INTO tf_replays
                  (replay_key, fingerprint, status, resource_json, bound_uid, expires_at)
                VALUES (?, ?, ?, ?, ?, ?)
                ON CONFLICT (replay_key) DO UPDATE SET
                  fingerprint = excluded.fingerprint, status = excluded.status,
                  resource_json = excluded.resource_json, bound_uid = excluded.bound_uid,
                  expires_at = excluded.expires_at`,
          params: [
            mutation.replayKey,
            mutation.replay.fingerprint,
            mutation.replay.status,
            mutation.replay.resource ? JSON.stringify(mutation.replay.resource) : null,
            mutation.replay.boundUid ?? null,
            timestamp + REPLAY_TTL_MILLISECONDS,
          ],
        },
        ...(mutation.preserveClaims
          ? []
          : claimCommitStatements({ ...operation, id: leaseToken }, claimKeys, timestamp)),
        ...resourceDependencyCommitStatements({
          tenantId: operation.tenantId,
          resourceUid: mutation.resourceUid,
          operationId: operation.id,
          mutation,
          timestamp,
        }),
        {
          sql: `UPDATE ${DEFERRED_OPERATION_TABLE}
                SET phase = 'succeeded', terminal_json = ?, committed_uid = ?,
                    lease_token = NULL, lease_until = NULL, updated_at = ?, expires_at = ?
                WHERE id = ? AND tenant_id = ? AND principal_id = ?
                  AND phase = 'committing' AND lease_token = ?`,
          params: [
            mutation.terminalJson,
            mutation.resource?.metadata.uid ?? null,
            timestamp,
            timestamp + OPERATION_TTL_MILLISECONDS,
            operation.id,
            operation.tenantId,
            operation.principalId,
            leaseToken,
          ],
        },
        {
          sql: `INSERT OR IGNORE INTO tf_operations
                  (id, tenant_id, operation, state, resource_json, created_at, expires_at)
                VALUES (?, ?, ?, 'succeeded', ?, ?, ?)`,
          params: [
            operation.id,
            operation.tenantId,
            operation.operation,
            mutation.resource ? JSON.stringify(mutation.resource) : null,
            operation.createdAt,
            timestamp + OPERATION_TTL_MILLISECONDS,
          ],
        },
        ...(receiptJson
          ? [
              {
                sql: `DELETE FROM ${PROVIDER_MUTATION_SAGA_TABLE}
                      WHERE operation_id = ? AND tenant_id = ? AND receipt_json = ?`,
                params: [operation.id, operation.tenantId, receiptJson],
              },
            ]
          : []),
        ...dependencyGuards.cleanup,
        {
          sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
          params: [executionEvidenceGuard],
        },
        {
          sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
          params: [guard],
        },
      );
      try {
        await sql.batch(statements);
      } catch (error) {
        if (!(error instanceof SqlError) || error.code !== "constraint") throw error;
        if (
          await exactCommittedMutationReplay({
            tenantId: operation.tenantId,
            operationId: operation.id,
            operation: operation.operation,
            mutation,
            ...(operation.acceptedGeneration === undefined
              ? {}
              : { deleteGeneration: operation.acceptedGeneration }),
            fenceDeleteRevision: fencesRevision,
          })
        ) {
          return;
        }
        throw await commitFenceError(operation, leaseToken);
      }
    },

    async committedResourceClaimHolder(key) {
      if (isResourceDependencyClaimKey(key)) return null;
      const rows = await sql.query(
        `SELECT tenant_id, holder_space, holder_api_version, holder_kind,
                holder_name, holder_uid
         FROM tf_resource_claims
         WHERE claim_key = ? AND state = 'committed'
         LIMIT 1`,
        [key],
      );
      const row = rows[0];
      return row
        ? {
            tenantId: text(row.tenant_id),
            holderSpace: text(row.holder_space),
            holderApiVersion: text(row.holder_api_version),
            holderKind: text(row.holder_kind),
            holderName: text(row.holder_name),
            holderUid: text(row.holder_uid),
          }
        : null;
    },

    async resourceClaimHolder(key) {
      if (isResourceDependencyClaimKey(key)) return null;
      const rows = await sql.query(
        `SELECT tenant_id, holder_space, holder_api_version, holder_kind,
                holder_name, holder_uid
         FROM tf_resource_claims
         WHERE claim_key = ? AND (state = 'committed' OR expires_at > ?)
         LIMIT 1`,
        [key, now()],
      );
      const row = rows[0];
      return row
        ? {
            tenantId: text(row.tenant_id),
            holderSpace: text(row.holder_space),
            holderApiVersion: text(row.holder_api_version),
            holderKind: text(row.holder_kind),
            holderName: text(row.holder_name),
            holderUid: text(row.holder_uid),
          }
        : null;
    },

    async reserveResourceClaims(reservations, expiresAt) {
      if (reservations.length === 0) return;
      if (reservations.some((reservation) => isResourceDependencyClaimKey(reservation.key))) {
        throw new TypeError("Definition claims cannot enter the Host dependency namespace");
      }
      const timestamp = now();
      const statements: SqlStatement[] = [
        {
          sql: `DELETE FROM tf_resource_claims
                WHERE state = 'reserved' AND expires_at <= ?`,
          params: [timestamp],
        },
      ];
      reservations.forEach((reservation, index) => {
        const guard = boundedGuard(`claim_${reservation.operationId}_${index}`);
        statements.push(
          {
            sql: `INSERT INTO tf_resource_claims
                    (claim_key, tenant_id, holder_space, holder_api_version, holder_kind,
                     holder_name, holder_uid, owner_operation_id, state, expires_at, updated_at)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?)
                  ON CONFLICT (claim_key) DO UPDATE SET
                    owner_operation_id = excluded.owner_operation_id,
                    state = CASE
                      WHEN tf_resource_claims.state = 'committed' THEN 'committed'
                      ELSE 'reserved'
                    END,
                    expires_at = CASE
                      WHEN tf_resource_claims.state = 'committed' THEN NULL
                      ELSE excluded.expires_at
                    END,
                    updated_at = excluded.updated_at
                  WHERE (
                    tf_resource_claims.tenant_id = excluded.tenant_id AND
                    tf_resource_claims.holder_space = excluded.holder_space AND
                    tf_resource_claims.holder_api_version = excluded.holder_api_version AND
                    tf_resource_claims.holder_kind = excluded.holder_kind AND
                    tf_resource_claims.holder_name = excluded.holder_name AND
                    tf_resource_claims.holder_uid = excluded.holder_uid
                  ) OR (
                    tf_resource_claims.state = 'reserved' AND
                    tf_resource_claims.expires_at <= ?
                  )`,
            params: [
              reservation.key,
              reservation.tenantId,
              reservation.holderSpace,
              reservation.holderApiVersion,
              reservation.holderKind,
              reservation.holderName,
              reservation.holderUid,
              reservation.operationId,
              expiresAt,
              timestamp,
              timestamp,
            ],
          },
          {
            sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                  SELECT ?, CASE WHEN EXISTS (
                    SELECT 1 FROM tf_resource_claims
                    WHERE claim_key = ? AND owner_operation_id = ?
                      AND tenant_id = ? AND holder_space = ? AND holder_api_version = ?
                      AND holder_kind = ? AND holder_name = ? AND holder_uid = ?
                  ) THEN 1 ELSE 0 END`,
            params: [
              guard,
              reservation.key,
              reservation.operationId,
              reservation.tenantId,
              reservation.holderSpace,
              reservation.holderApiVersion,
              reservation.holderKind,
              reservation.holderName,
              reservation.holderUid,
            ],
          },
          {
            sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
            params: [guard],
          },
        );
      });
      await sql.batch(statements);
    },

    async releaseResourceClaims(operationId) {
      const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
      await sql.run(
        `DELETE FROM tf_resource_claims
         WHERE owner_operation_id = ? AND state = 'reserved'
           AND NOT (claim_key >= ? AND claim_key < ?)`,
        [operationId, dependencyStart, dependencyEnd],
      );
    },

    async releaseCommittedResourceClaims(tenantId, holderUid) {
      await sql.run(
        `DELETE FROM tf_resource_claims
         WHERE tenant_id = ? AND holder_uid = ? AND state = 'committed'`,
        [tenantId, holderUid],
      );
    },

    async reserveResourceDependencies(input) {
      if (input.expiresAt <= now()) {
        throw new TypeError("resource dependency reservation must expire in the future");
      }
      const keys = resourceDependencyClaimKeys(input.dependencies);
      if (
        keys.length === 0 ||
        keys.some((key) => !isResourceDependencyClaimKey(key)) ||
        new Set(keys).size !== keys.length
      ) {
        throw new TypeError("invalid resource dependency set");
      }
      const decoded = await decodeResourceDependencySet(
        keys,
        input.tenantId,
        input.holderUid,
        input.dependencies.operationId,
      );
      if (!decoded || canonicalJson(decoded) !== canonicalJson(input.dependencies)) {
        throw new TypeError("resource dependency set does not match its durable payload");
      }
      const timestamp = now();
      const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
      const keysJson = resourceDependencyKeysJson(input.dependencies);
      const fencesJson = resourceDependencyFencesJson(input.dependencies);
      const targetGuard = boundedGuard(`dependency_targets_${input.reservationOwnerId}`);
      const ownershipGuard = boundedGuard(`dependency_owner_${input.reservationOwnerId}`);
      const statements: SqlStatement[] = [
        {
          sql: `DELETE FROM tf_resource_claims
                WHERE state = 'reserved' AND expires_at <= ?
                  AND claim_key >= ? AND claim_key < ?`,
          params: [timestamp, dependencyStart, dependencyEnd],
        },
        {
          // A target persisted by an older Host may not yet have an
          // attestation. Opening every exact live incarnation in this same
          // batch is safe: a concurrent delete either wins with `pending`, or
          // this reservation wins and its deletion guard sees the hold.
          sql: `INSERT OR IGNORE INTO tf_resource_deletion_attestations
                  (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
                   state, closure_fence, effects_json, evidence_json, evidence_ref,
                   evidence_effect_digest, evidence_checked_at, evidence_status,
                   created_at, updated_at)
                SELECT ?, json_extract(fence.value, '$[5]'), json_extract(fence.value, '$[1]'),
                       json_extract(fence.value, '$[2]'), json_extract(fence.value, '$[3]'),
                       json_extract(fence.value, '$[4]'), json_extract(fence.value, '$[7]'),
                       'live', 0, '[]', NULL, NULL, NULL, NULL, NULL, ?, ?
                FROM json_each(?) AS fence
                WHERE EXISTS (
                  SELECT 1 FROM tf_resources AS target
                  WHERE target.tenant_id = ?
                    AND target.space = json_extract(fence.value, '$[1]')
                    AND target.api_version = json_extract(fence.value, '$[2]')
                    AND target.kind = json_extract(fence.value, '$[3]')
                    AND target.name = json_extract(fence.value, '$[4]')
                    AND target.uid = json_extract(fence.value, '$[5]')
                    AND target.revision = json_extract(fence.value, '$[6]')
                )`,
          params: [input.tenantId, timestamp, timestamp, fencesJson, input.tenantId],
        },
        {
          sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                SELECT ?, CASE WHEN NOT EXISTS (
                  SELECT 1 FROM json_each(?) AS fence
                  WHERE NOT EXISTS (
                    SELECT 1 FROM tf_resources AS target
                    WHERE target.tenant_id = ?
                      AND target.space = json_extract(fence.value, '$[1]')
                      AND target.api_version = json_extract(fence.value, '$[2]')
                      AND target.kind = json_extract(fence.value, '$[3]')
                      AND target.name = json_extract(fence.value, '$[4]')
                      AND target.uid = json_extract(fence.value, '$[5]')
                      AND target.revision = json_extract(fence.value, '$[6]')
                      AND EXISTS (
                        SELECT 1 FROM tf_resource_deletion_attestations AS attestation
                        WHERE attestation.tenant_id = target.tenant_id
                          AND attestation.resource_uid = target.uid
                          AND attestation.space = target.space
                          AND attestation.api_version = target.api_version
                          AND attestation.kind = target.kind AND attestation.name = target.name
                          AND attestation.form_ref_json = json_extract(fence.value, '$[7]')
                          AND attestation.state = 'live'
                      )
                  )
                ) THEN 1 ELSE 0 END`,
          params: [targetGuard, fencesJson, input.tenantId],
        },
        {
          sql: `INSERT INTO tf_resource_claims
                  (claim_key, tenant_id, holder_space, holder_api_version, holder_kind,
                   holder_name, holder_uid, owner_operation_id, state, expires_at, updated_at)
                SELECT CAST(dependency.value AS TEXT), ?, ?, ?, ?, ?, ?, ?, 'reserved', ?, ?
                FROM json_each(?) AS dependency
                WHERE 1 = 1
                ON CONFLICT (claim_key) DO UPDATE SET
                  owner_operation_id = excluded.owner_operation_id,
                  state = CASE
                    WHEN tf_resource_claims.state = 'committed' THEN 'committed'
                    ELSE 'reserved'
                  END,
                  expires_at = CASE
                    WHEN tf_resource_claims.state = 'committed' THEN NULL
                    ELSE excluded.expires_at
                  END,
                  updated_at = excluded.updated_at
                WHERE (
                  tf_resource_claims.tenant_id = excluded.tenant_id AND
                  tf_resource_claims.holder_space = excluded.holder_space AND
                  tf_resource_claims.holder_api_version = excluded.holder_api_version AND
                  tf_resource_claims.holder_kind = excluded.holder_kind AND
                  tf_resource_claims.holder_name = excluded.holder_name AND
                  tf_resource_claims.holder_uid = excluded.holder_uid
                ) OR (
                  tf_resource_claims.state = 'reserved' AND
                  tf_resource_claims.expires_at <= ?
                )`,
          params: [
            input.tenantId,
            RESOURCE_DEPENDENCY_PRIVATE_HOLDER.space,
            RESOURCE_DEPENDENCY_PRIVATE_HOLDER.apiVersion,
            RESOURCE_DEPENDENCY_PRIVATE_HOLDER.kind,
            RESOURCE_DEPENDENCY_PRIVATE_HOLDER.name,
            input.holderUid,
            input.reservationOwnerId,
            input.expiresAt,
            timestamp,
            keysJson,
            timestamp,
          ],
        },
        {
          sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                SELECT ?, CASE WHEN (
                  SELECT COUNT(*) FROM tf_resource_claims
                  WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                    AND claim_key >= ? AND claim_key < ?
                    AND (state = 'committed' OR expires_at > ?)
                ) = json_array_length(?) AND NOT EXISTS (
                  SELECT 1 FROM json_each(?) AS expected
                  WHERE NOT EXISTS (
                    SELECT 1 FROM tf_resource_claims AS dependency
                    WHERE dependency.claim_key = CAST(expected.value AS TEXT)
                      AND dependency.owner_operation_id = ? AND dependency.tenant_id = ?
                      AND dependency.holder_space = ? AND dependency.holder_api_version = ?
                      AND dependency.holder_kind = ? AND dependency.holder_name = ?
                      AND dependency.holder_uid = ?
                      AND (dependency.state = 'committed' OR dependency.expires_at > ?)
                  )
                ) THEN 1 ELSE 0 END`,
          params: [
            ownershipGuard,
            input.reservationOwnerId,
            input.tenantId,
            input.holderUid,
            dependencyStart,
            dependencyEnd,
            timestamp,
            keysJson,
            keysJson,
            input.reservationOwnerId,
            input.tenantId,
            RESOURCE_DEPENDENCY_PRIVATE_HOLDER.space,
            RESOURCE_DEPENDENCY_PRIVATE_HOLDER.apiVersion,
            RESOURCE_DEPENDENCY_PRIVATE_HOLDER.kind,
            RESOURCE_DEPENDENCY_PRIVATE_HOLDER.name,
            input.holderUid,
            timestamp,
          ],
        },
        {
          sql: "DELETE FROM tf_operation_commit_guards WHERE token IN (?, ?)",
          params: [targetGuard, ownershipGuard],
        },
      ];
      await sql.batch(statements);
    },

    async readProviderMutationDependencies(input) {
      const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
      const rows = await sql.query(
        `SELECT claim_key FROM tf_resource_claims
         WHERE tenant_id = ? AND holder_uid = ? AND owner_operation_id = ?
           AND claim_key >= ? AND claim_key < ?
           AND (state = 'committed' OR expires_at > ?)
         ORDER BY claim_key`,
        [
          input.tenantId,
          input.resourceUid,
          input.operationId,
          dependencyStart,
          dependencyEnd,
          now(),
        ],
      );
      try {
        return await decodeResourceDependencySet(
          rows.map((row) => text(row.claim_key)),
          input.tenantId,
          input.resourceUid,
          input.operationId,
        );
      } catch {
        throw new TakoformHostError("backend_unavailable", 503);
      }
    },

    async releaseResourceDependencies(input) {
      const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
      await sql.run(
        `DELETE FROM tf_resource_claims
         WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
           AND state = 'reserved'
           AND claim_key >= ? AND claim_key < ?`,
        [input.ownerId, input.tenantId, input.resourceUid, dependencyStart, dependencyEnd],
      );
    },

    async orphanedResources(installedDigests, limit) {
      if (installedDigests.length === 0) return [];
      const placeholders = installedDigests.map(() => "?").join(", ");
      const rows = await sql.query(
        `SELECT space, name, kind FROM tf_resources
         WHERE json_extract(resource_json, '$.form.formRef.schemaDigest') NOT IN (${placeholders})
         ORDER BY updated_at DESC LIMIT ?`,
        [...installedDigests, limit],
      );
      return rows.map((row) => ({
        space: text(row.space),
        name: text(row.name),
        kind: text(row.kind),
      }));
    },

    async listResources(tenantId, { space, limit, cursor }) {
      const page = Math.min(Math.max(limit, 1), 200);
      const seek = decodeCursor(cursor);
      const rows = await sql.query(
        `SELECT space, api_version, kind, name, uid, generation, revision,
                updated_at, resource_json
         FROM tf_resources
         WHERE tenant_id = ?
           ${space === undefined ? "" : "AND space = ?"}
           ${seek === null ? "" : "AND (updated_at < ? OR (updated_at = ? AND uid < ?))"}
         ORDER BY updated_at DESC, uid DESC
         LIMIT ?`,
        [
          tenantId,
          ...(space === undefined ? [] : [space]),
          ...(seek === null ? [] : [seek.updatedAt, seek.updatedAt, seek.uid]),
          page + 1,
        ],
      );
      // One row past the page is read only to learn whether another page
      // exists. Handing back a cursor that leads nowhere is worse than none.
      const visible = rows.slice(0, page);
      const last = visible[visible.length - 1];
      return {
        resources: visible.map(resourceListing),
        cursor:
          rows.length > page && last
            ? encodeCursor({
                updatedAt: Number(last.updated_at),
                uid: text(last.uid),
              })
            : null,
      };
    },

    async resourceByUid(tenantId, uid) {
      // LIMIT 2 is an integrity check: uid generation is expected to be unique,
      // but old schemas did not enforce it. Ambiguity must never mint reach to
      // one arbitrary backend resource.
      const rows = await sql.query(
        `SELECT space, api_version, kind, name, uid, generation, revision,
                updated_at, resource_json
         FROM tf_resources
         WHERE tenant_id = ? AND uid = ?
         LIMIT 2`,
        [tenantId, uid],
      );
      if (rows.length === 0) return null;
      if (rows.length !== 1) throw new Error("duplicate_resource_uid");
      return resourceListing(rows[0] as Row);
    },

    async readResourceExecutionEvidence(input) {
      const identityRows = await sql.query(
        `SELECT space, api_version, kind, name, form_ref_json
         FROM tf_resource_deletion_attestations
         WHERE tenant_id = ? AND resource_uid = ?
         LIMIT 2`,
        [input.tenantId, input.resourceUid],
      );
      if (identityRows.length === 0) return null;
      if (identityRows.length !== 1 || !identityRows[0]) {
        throw new TakoformHostError("backend_unavailable", 503);
      }
      const identity = identityRows[0];
      const formRef = resourceExecutionFormRef(identity.form_ref_json);

      const boundRows = await sql.query(
        `SELECT MAX(sequence) AS snapshot_fence
         FROM tf_resource_execution_evidence
         WHERE tenant_id = ? AND resource_uid = ?`,
        [input.tenantId, input.resourceUid],
      );
      if (boundRows.length !== 1) throw new TakoformHostError("backend_unavailable", 503);
      const currentFenceValue = boundRows[0]?.snapshot_fence;
      const currentFence =
        currentFenceValue === null ? 0 : positiveIntegerColumn(currentFenceValue);
      const cursor = decodeResourceExecutionEvidenceCursor(input.cursor);
      if (
        cursor &&
        (cursor.organizationId !== input.tenantId ||
          cursor.resourceUid !== input.resourceUid ||
          cursor.snapshotFence > currentFence ||
          cursor.beforeSequence > cursor.snapshotFence ||
          cursor.beforeSequence < 1)
      ) {
        throw new TakoformHostError("invalid_argument", 400);
      }
      const snapshotFence = cursor?.snapshotFence ?? currentFence;
      const page = Math.min(Math.max(input.limit, 1), 200);
      const rows =
        snapshotFence === 0
          ? []
          : await sql.query(
              `SELECT sequence, operation_id, action, resource_generation,
                      resource_revision, committed_at
               FROM tf_resource_execution_evidence
               WHERE tenant_id = ? AND resource_uid = ?
                 AND sequence <= ?
                 ${cursor ? "AND sequence < ?" : ""}
               ORDER BY sequence DESC
               LIMIT ?`,
              [
                input.tenantId,
                input.resourceUid,
                snapshotFence,
                ...(cursor ? [cursor.beforeSequence] : []),
                page + 1,
              ],
            );
      const expectedFirstSequence = cursor ? cursor.beforeSequence - 1 : snapshotFence;
      if (expectedFirstSequence === 0) {
        if (rows.length !== 0) throw new TakoformHostError("backend_unavailable", 503);
      } else {
        if (rows.length === 0) throw new TakoformHostError("backend_unavailable", 503);
        for (const [index, row] of rows.entries()) {
          if (positiveIntegerColumn(row.sequence) !== expectedFirstSequence - index) {
            throw new TakoformHostError("backend_unavailable", 503);
          }
        }
        if (rows.length <= page && positiveIntegerColumn(rows.at(-1)?.sequence) !== 1) {
          throw new TakoformHostError("backend_unavailable", 503);
        }
      }
      const visible = rows.slice(0, page).map(resourceExecutionCommit);
      const last = visible[visible.length - 1];
      const firstActionRows =
        snapshotFence === 0
          ? []
          : await sql.query(
              `SELECT action
               FROM tf_resource_execution_evidence
               WHERE tenant_id = ? AND resource_uid = ? AND sequence = 1
               LIMIT 2`,
              [input.tenantId, input.resourceUid],
            );
      const firstAction = firstActionRows[0]?.action;
      if (
        (snapshotFence === 0 && firstActionRows.length !== 0) ||
        (snapshotFence > 0 &&
          (firstActionRows.length !== 1 ||
            (firstAction !== "create" && firstAction !== "update" && firstAction !== "delete")))
      ) {
        throw new TakoformHostError("backend_unavailable", 503);
      }
      const coverage = firstAction === "create" ? "complete" : "partial";
      return {
        executionEvidence: {
          format: RESOURCE_EXECUTION_EVIDENCE_FORMAT,
          organizationId: input.tenantId,
          resource: {
            uid: input.resourceUid,
            address: {
              space: text(identity.space),
              apiVersion: text(identity.api_version),
              kind: text(identity.kind),
              name: text(identity.name),
            },
            formRef,
          },
          coverage,
          snapshotFence,
          commits: visible,
        },
        ...(rows.length > page && last
          ? {
              cursor: encodeResourceExecutionEvidenceCursor({
                organizationId: input.tenantId,
                resourceUid: input.resourceUid,
                snapshotFence,
                beforeSequence: last.sequence,
              }),
            }
          : {}),
      };
    },

    async resourceWithRelationsByUid(tenantId, uid) {
      const rows = await sql.query(
        `SELECT space, api_version, kind, name, uid, generation, revision,
                updated_at, resource_json, relations_json
         FROM tf_resources
         WHERE tenant_id = ? AND uid = ?
         LIMIT 2`,
        [tenantId, uid],
      );
      if (rows.length === 0) return null;
      if (rows.length !== 1 || !rows[0]) throw new Error("duplicate_resource_uid");
      return {
        listing: resourceListing(rows[0]),
        relations: storedRelations(text(rows[0].relations_json)),
      };
    },

    async resourceWithRelationTargetByUid(tenantId, sourceUid, pointer) {
      // The source CTE is deliberately bounded before expanding its JSON. A
      // legacy database may contain duplicate UIDs, and retaining two rows is
      // what lets the caller refuse an ambiguous identity instead of filtering
      // down to whichever row SQLite happened to visit first. The same LIMIT
      // on the outer statement retains duplicate relations or target UIDs.
      const rows = await sql.query(
        `WITH source_rows AS (
           SELECT tenant_id AS source_tenant_id,
                  space AS source_space,
                  api_version AS source_api_version,
                  kind AS source_kind,
                  name AS source_name,
                  uid AS source_uid,
                  generation AS source_generation,
                  revision AS source_revision,
                  updated_at AS source_updated_at,
                  resource_json AS source_resource_json,
                  relations_json AS source_relations_json
           FROM tf_resources
           WHERE tenant_id = ? AND uid = ?
           LIMIT 2
         ), source_relation_rows AS (
           SELECT source_rows.*, relation.value AS relation_json
           FROM source_rows
           LEFT JOIN json_each(
             CASE
               WHEN json_valid(source_rows.source_relations_json) = 1 THEN
                 CASE
                   WHEN json_type(source_rows.source_relations_json) = 'array'
                     THEN source_rows.source_relations_json
                   ELSE '[]'
                 END
               ELSE '[]'
             END
         ) AS relation
             ON CASE
                  WHEN relation.type = 'object'
                    THEN json_extract(relation.value, '$.pointer')
                  ELSE NULL
                END = ?
         )
         SELECT source.source_tenant_id,
                source.source_space,
                source.source_api_version,
                source.source_kind,
                source.source_name,
                source.source_uid,
                source.source_generation,
                source.source_revision,
                source.source_updated_at,
                source.source_resource_json,
                source.source_relations_json,
                source.relation_json,
                target.tenant_id AS target_tenant_id,
                target.space AS target_space,
                target.api_version AS target_api_version,
                target.kind AS target_kind,
                target.name AS target_name,
                target.uid AS target_uid,
                target.generation AS target_generation,
                target.revision AS target_revision,
                target.updated_at AS target_updated_at,
                target.resource_json AS target_resource_json,
                source_attestation.tenant_id AS source_attestation_tenant_id,
                source_attestation.resource_uid AS source_attestation_resource_uid,
                source_attestation.space AS source_attestation_space,
                source_attestation.api_version AS source_attestation_api_version,
                source_attestation.kind AS source_attestation_kind,
                source_attestation.name AS source_attestation_name,
                source_attestation.form_ref_json AS source_attestation_form_ref_json,
                source_attestation.state AS source_attestation_state,
                target_attestation.tenant_id AS target_attestation_tenant_id,
                target_attestation.resource_uid AS target_attestation_resource_uid,
                target_attestation.space AS target_attestation_space,
                target_attestation.api_version AS target_attestation_api_version,
                target_attestation.kind AS target_attestation_kind,
                target_attestation.name AS target_attestation_name,
                target_attestation.form_ref_json AS target_attestation_form_ref_json,
                target_attestation.state AS target_attestation_state
         FROM source_relation_rows AS source
         LEFT JOIN tf_resources AS target
           ON target.tenant_id = source.source_tenant_id
          AND target.uid = json_extract(source.relation_json, '$.targetUid')
         LEFT JOIN tf_resource_deletion_attestations AS source_attestation
           ON source_attestation.tenant_id = source.source_tenant_id
          AND source_attestation.resource_uid = source.source_uid
         LEFT JOIN tf_resource_deletion_attestations AS target_attestation
           ON target_attestation.tenant_id = target.tenant_id
          AND target_attestation.resource_uid = target.uid
         LIMIT 2`,
        [tenantId, sourceUid, pointer],
      );
      if (rows.length !== 1 || !rows[0]) return null;
      const row = rows[0];
      const source = snapshotResourceListing(row, "source");
      const target = snapshotResourceListing(row, "target");
      if (!source || !target || source.uid !== sourceUid || source.space !== target.space) {
        return null;
      }
      if (
        !liveSnapshotAttestation(row, "source", tenantId, source) ||
        !liveSnapshotAttestation(row, "target", tenantId, target)
      ) {
        return null;
      }

      const relations = snapshotRelations(row.source_relations_json);
      if (!relations) return null;
      const matching = relations.filter((relation) => relation.pointer === pointer);
      if (matching.length !== 1) return null;
      const relation = matching[0];
      if (
        !relation ||
        relation.relation !== pointer ||
        relation.targetApiVersion !== target.apiVersion ||
        relation.targetKind !== target.kind ||
        relation.targetName !== target.name ||
        relation.targetUid !== target.uid ||
        !sameSnapshotFormRef(relation.targetFormRef, target.resource.form.formRef)
      ) {
        return null;
      }
      return { source, relation, target };
    },

    async listOperations(tenantId, limit) {
      const rows = await sql.query(
        `SELECT id, operation, state, created_at FROM tf_operations
         WHERE tenant_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
        [tenantId, Math.min(Math.max(limit, 1), 200)],
      );
      return rows.map((row) => ({
        id: text(row.id),
        operation: text(row.operation),
        state: text(row.state),
        createdAt: text(row.created_at),
      }));
    },

    async readReplay(key): Promise<StoredReplay | null> {
      const rows = await sql.query(
        "SELECT fingerprint, status, resource_json, bound_uid FROM tf_replays WHERE replay_key = ? AND expires_at > ?",
        [key, now()],
      );
      const row = rows[0];
      if (!row) return null;
      const resourceJson = row.resource_json;
      const boundUid = row.bound_uid;
      return {
        fingerprint: text(row.fingerprint),
        status: Number(row.status),
        ...(typeof resourceJson === "string"
          ? { resource: JSON.parse(resourceJson) as TakoformStoredResource }
          : {}),
        ...(typeof boundUid === "string" ? { boundUid } : {}),
      };
    },

    async putReplay(key, replay): Promise<void> {
      await sql.run(
        `DELETE FROM tf_replays WHERE rowid IN (
           SELECT rowid FROM tf_replays WHERE expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
        [now(), SWEEP_ROW_LIMIT],
      );
      await sql.run(
        `INSERT INTO tf_replays (replay_key, fingerprint, status, resource_json, bound_uid, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (replay_key) DO UPDATE SET
           fingerprint = excluded.fingerprint,
           status = excluded.status,
           resource_json = excluded.resource_json,
           bound_uid = excluded.bound_uid,
           expires_at = excluded.expires_at`,
        [
          key,
          replay.fingerprint,
          replay.status,
          replay.resource ? JSON.stringify(replay.resource) : null,
          replay.boundUid ?? null,
          now() + REPLAY_TTL_MILLISECONDS,
        ],
      );
    },

    async deleteReplay(key): Promise<void> {
      await sql.run("DELETE FROM tf_replays WHERE replay_key = ?", [key]);
    },
  };
}

interface StoreSqlFence {
  readonly sql: string;
  readonly params: readonly SqlParam[];
}

function assertDefinitiveProviderMutationFailure(
  input: DefinitiveProviderMutationFailureCommit,
): void {
  const { saga } = input;
  if (saga.operationKind !== "apply") {
    throw new TypeError("provider failure has the wrong mutation kind");
  }
  if (
    input.recoveryAction !== undefined &&
    (input.recoveryAction !== "convergeApply" ||
      input.operation !== "create" ||
      saga.acceptedUid !== undefined ||
      saga.acceptedGeneration !== undefined ||
      saga.acceptedRevision !== undefined)
  ) {
    throw new TypeError("invalid provider refusal recovery action");
  }
  if (input.charge.reference !== saga.operationId) {
    throw new TypeError("provider failure charge has the wrong operation identity");
  }
  if ((input.operation === "create") !== (saga.acceptedUid === undefined)) {
    throw new TypeError("provider failure has the wrong lifecycle operation");
  }
  if (
    saga.acceptedUid !== undefined &&
    (saga.acceptedGeneration === undefined || saga.acceptedRevision === undefined)
  ) {
    throw new TypeError("provider failure has an incomplete incumbent fence");
  }
  const hostOperation = input.hostOperation;
  if (hostOperation.kind === "immediate") {
    if (input.claimOwnerId !== saga.operationId) {
      throw new TypeError("immediate provider failure has the wrong claim owner");
    }
    return;
  }
  const operation = hostOperation.operation;
  if (
    operation.id !== saga.operationId ||
    operation.tenantId !== saga.tenantId ||
    operation.operation !== "apply" ||
    operation.fingerprint !== saga.fingerprint ||
    operation.resourceUid !== saga.resourceUid ||
    operation.target.space !== saga.target.space ||
    operation.target.apiVersion !== saga.target.apiVersion ||
    operation.target.kind !== saga.target.kind ||
    operation.target.name !== saga.target.name ||
    operation.acceptedUid !== saga.acceptedUid ||
    operation.acceptedGeneration !== saga.acceptedGeneration ||
    operation.acceptedRevision !== saga.acceptedRevision ||
    input.claimOwnerId !== hostOperation.leaseToken
  ) {
    throw new TypeError("deferred provider failure does not match its accepted operation");
  }
}

function definitiveProviderFailureInitialFence(
  input: DefinitiveProviderMutationFailureCommit,
  timestamp: number,
): StoreSqlFence {
  const { saga } = input;
  const sagaFence = `EXISTS (
    SELECT 1 FROM ${PROVIDER_MUTATION_SAGA_TABLE}
    WHERE operation_id = ? AND replay_key = ? AND tenant_id = ?
      AND fingerprint = ? AND resource_uid = ? AND authority_head_digest IS ?
      AND target_space = ? AND target_api_version = ? AND target_kind = ? AND target_name = ?
      AND accepted_uid IS ? AND accepted_generation IS ? AND accepted_revision IS ?
      AND protocol_generation = 1 AND operation_kind = 'apply'
      AND phase = 'planned' AND receipt_json IS NULL
      AND provider_handle IS NULL AND provider_outcome ${input.recoveryAction === "convergeApply" ? "IN ('running', 'indeterminate')" : "= 'running'"}
      AND execution_started_at IS NOT NULL
      AND execution_lease_token = ? AND execution_lease_until > ?
  )`;
  const sagaParams: readonly SqlParam[] = [
    saga.operationId,
    saga.replayKey,
    saga.tenantId,
    saga.fingerprint,
    saga.resourceUid,
    saga.authorityHeadDigest ?? null,
    saga.target.space,
    saga.target.apiVersion,
    saga.target.kind,
    saga.target.name,
    saga.acceptedUid ?? null,
    saga.acceptedGeneration ?? null,
    saga.acceptedRevision ?? null,
    input.providerLeaseToken,
    timestamp,
  ];
  const hostOperation = input.hostOperation;
  const hostFence =
    hostOperation.kind === "deferred"
      ? `EXISTS (
          SELECT 1 FROM ${DEFERRED_OPERATION_TABLE}
          WHERE id = ? AND tenant_id = ? AND principal_id = ?
            AND protocol_generation = 1 AND operation = 'apply' AND phase = 'committing'
            AND fingerprint = ? AND replay_key = ? AND resource_uid = ?
            AND target_space = ? AND target_api_version = ?
            AND target_kind = ? AND target_name = ? AND target_form_ref_json = ?
            AND accepted_uid IS ? AND accepted_generation IS ? AND accepted_revision IS ?
            AND terminal_json IS NULL AND committed_uid IS NULL
            AND lease_token = ? AND lease_until > ?
        )`
      : `NOT EXISTS (
          SELECT 1 FROM ${DEFERRED_OPERATION_TABLE} WHERE id = ?
        )`;
  const hostParams: readonly SqlParam[] =
    hostOperation.kind === "deferred"
      ? [
          hostOperation.operation.id,
          hostOperation.operation.tenantId,
          hostOperation.operation.principalId,
          hostOperation.operation.fingerprint,
          hostOperation.operation.replayKey,
          hostOperation.operation.resourceUid,
          hostOperation.operation.target.space,
          hostOperation.operation.target.apiVersion,
          hostOperation.operation.target.kind,
          hostOperation.operation.target.name,
          JSON.stringify(hostOperation.operation.target.formRef),
          hostOperation.operation.acceptedUid ?? null,
          hostOperation.operation.acceptedGeneration ?? null,
          hostOperation.operation.acceptedRevision ?? null,
          hostOperation.leaseToken,
          timestamp,
        ]
      : [saga.operationId];
  const target = [
    saga.tenantId,
    saga.target.space,
    saga.target.apiVersion,
    saga.target.kind,
    saga.target.name,
  ] as const;
  const incarnationRelease =
    input.operation === "create"
      ? uncommittedResourceIncarnationRelease({
          tenantId: saga.tenantId,
          resourceUid: saga.resourceUid,
          effectId: saga.operationId,
        })
      : undefined;
  const resourceFence =
    input.operation === "create"
      ? `NOT EXISTS (
          SELECT 1 FROM tf_resources
          WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
        ) AND (${incarnationRelease?.fence ?? "0 = 1"})`
      : `EXISTS (
          SELECT 1 FROM tf_resources
          WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
            AND uid = ? AND generation = ? AND revision = ?
        )`;
  const resourceParams: readonly SqlParam[] =
    input.operation === "create"
      ? [...target, ...(incarnationRelease?.fenceParams ?? [])]
      : [
          ...target,
          saga.acceptedUid ?? "",
          saga.acceptedGeneration ?? "",
          saga.acceptedRevision ?? "",
        ];
  const formFence = hostOperation.kind === "deferred" ? "AND form_ref_json = ?" : "";
  const formParams: readonly SqlParam[] =
    hostOperation.kind === "deferred"
      ? [canonicalJson(hostOperation.operation.target.formRef)]
      : [];
  const attemptFence = `EXISTS (
      SELECT 1 FROM tf_resource_deletion_attestations
      WHERE tenant_id = ? AND resource_uid = ? AND space = ? AND api_version = ?
        AND kind = ? AND name = ? AND state = 'live' ${formFence}
    )
    AND EXISTS (
      SELECT 1 FROM tf_resource_provider_effects
      WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
        AND effect_kind = 'apply' AND phase = 'planned' AND operation_mode = 'initial'
    )
    AND EXISTS (
      SELECT 1 FROM tf_resource_provider_effects
      WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
        AND effect_kind = 'apply' AND phase = 'dispatched' AND operation_mode = 'initial'
    )
    AND NOT EXISTS (
      SELECT 1 FROM tf_resource_provider_effects
      WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
        AND phase IN ('succeeded', 'cancelled')
    )`;
  const attemptParams: readonly SqlParam[] = [
    saga.tenantId,
    saga.resourceUid,
    saga.target.space,
    saga.target.apiVersion,
    saga.target.kind,
    saga.target.name,
    ...formParams,
    saga.tenantId,
    saga.resourceUid,
    saga.operationId,
    saga.tenantId,
    saga.resourceUid,
    saga.operationId,
    saga.tenantId,
    saga.resourceUid,
    saga.operationId,
  ];
  return {
    sql: `${sagaFence}
      AND NOT EXISTS (SELECT 1 FROM tf_operations WHERE id = ?)
      AND ${hostFence}
      AND ${resourceFence}
      AND ${attemptFence}`,
    params: [...sagaParams, saga.operationId, ...hostParams, ...resourceParams, ...attemptParams],
  };
}

function definitiveProviderFailureCommittedFence(
  input: DefinitiveProviderMutationFailureCommit,
  releaseFence: StoreSqlFence,
): StoreSqlFence {
  const { saga } = input;
  const operationCreatedAt =
    input.hostOperation.kind === "deferred"
      ? input.hostOperation.operation.createdAt
      : input.hostOperation.createdAt;
  const storedOperation =
    input.hostOperation.kind === "deferred"
      ? input.hostOperation.operation.operation
      : input.operation;
  const hostFence =
    input.hostOperation.kind === "deferred"
      ? `EXISTS (
          SELECT 1 FROM ${DEFERRED_OPERATION_TABLE}
          WHERE id = ? AND tenant_id = ? AND principal_id = ?
            AND protocol_generation = 1 AND operation = 'apply' AND phase = 'failed'
            AND fingerprint = ? AND replay_key = ? AND resource_uid = ?
            AND target_space = ? AND target_api_version = ?
            AND target_kind = ? AND target_name = ? AND target_form_ref_json = ?
            AND accepted_uid IS ? AND accepted_generation IS ? AND accepted_revision IS ?
            AND terminal_json = ? AND committed_uid IS NULL
            AND lease_token IS NULL AND lease_until IS NULL
        )`
      : `NOT EXISTS (
          SELECT 1 FROM ${DEFERRED_OPERATION_TABLE} WHERE id = ?
        )`;
  const hostParams: readonly SqlParam[] =
    input.hostOperation.kind === "deferred"
      ? [
          input.hostOperation.operation.id,
          input.hostOperation.operation.tenantId,
          input.hostOperation.operation.principalId,
          input.hostOperation.operation.fingerprint,
          input.hostOperation.operation.replayKey,
          input.hostOperation.operation.resourceUid,
          input.hostOperation.operation.target.space,
          input.hostOperation.operation.target.apiVersion,
          input.hostOperation.operation.target.kind,
          input.hostOperation.operation.target.name,
          JSON.stringify(input.hostOperation.operation.target.formRef),
          input.hostOperation.operation.acceptedUid ?? null,
          input.hostOperation.operation.acceptedGeneration ?? null,
          input.hostOperation.operation.acceptedRevision ?? null,
          input.hostOperation.terminalJson,
        ]
      : [saga.operationId];
  const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
  const claimFence =
    input.operation === "create"
      ? `NOT EXISTS (
          SELECT 1 FROM tf_resource_claims
          WHERE tenant_id = ? AND holder_uid = ?
        )`
      : `NOT EXISTS (
          SELECT 1 FROM tf_resource_claims
          WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
            AND state = 'reserved' AND NOT (claim_key >= ? AND claim_key < ?)
        )
        AND NOT EXISTS (
          SELECT 1 FROM tf_resource_claims
          WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
            AND state = 'reserved' AND claim_key >= ? AND claim_key < ?
        )`;
  const claimParams: readonly SqlParam[] =
    input.operation === "create"
      ? [saga.tenantId, saga.resourceUid]
      : [
          input.claimOwnerId,
          saga.tenantId,
          saga.resourceUid,
          dependencyStart,
          dependencyEnd,
          saga.operationId,
          saga.tenantId,
          saga.resourceUid,
          dependencyStart,
          dependencyEnd,
        ];
  const target = [
    saga.tenantId,
    saga.target.space,
    saga.target.apiVersion,
    saga.target.kind,
    saga.target.name,
  ] as const;
  const attemptFence =
    input.operation === "create"
      ? `NOT EXISTS (
          SELECT 1 FROM tf_resources
          WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM tf_resources WHERE tenant_id = ? AND uid = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM tf_resource_deployments
          WHERE tenant_id = ? AND resource_uid = ? AND state NOT IN ('deleted', 'failed')
        )
        AND NOT EXISTS (
          SELECT 1 FROM tf_resource_provider_effects
          WHERE tenant_id = ? AND resource_uid = ?
        )
        AND NOT EXISTS (
          SELECT 1 FROM tf_resource_deletion_attestations
          WHERE tenant_id = ? AND resource_uid = ?
        )`
      : `EXISTS (
          SELECT 1 FROM tf_resources
          WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
            AND uid = ? AND generation = ? AND revision = ?
        )
        AND EXISTS (
          SELECT 1 FROM tf_resource_provider_effects
          WHERE tenant_id = ? AND resource_uid = ? AND event_id = ? AND effect_id = ?
            AND effect_kind = 'apply' AND phase = 'cancelled' AND operation_mode = 'initial'
            AND provider_pack_ref IS NULL AND provider_installation_ref IS NULL
            AND native_id IS NULL AND target_json IS NULL
        )
        AND EXISTS (
          SELECT 1
          FROM tf_resource_deletion_attestations AS attestation,
               json_each(attestation.effects_json) AS event
          WHERE attestation.tenant_id = ? AND attestation.resource_uid = ?
            AND attestation.space = ? AND attestation.api_version = ?
            AND attestation.kind = ? AND attestation.name = ? AND attestation.state = 'live'
            AND attestation.evidence_json IS NULL AND attestation.evidence_ref IS NULL
            AND attestation.evidence_effect_digest IS NULL
            AND attestation.evidence_checked_at IS NULL AND attestation.evidence_status IS NULL
            AND json_extract(event.value, '$.eventId') = ?
            AND json_extract(event.value, '$.operationId') = ?
            AND json_extract(event.value, '$.kind') = 'apply'
            AND json_extract(event.value, '$.phase') = 'cancelled'
            AND json_extract(event.value, '$.operationMode') = 'initial'
        )`;
  const attemptParams: readonly SqlParam[] =
    input.operation === "create"
      ? [
          ...target,
          saga.tenantId,
          saga.resourceUid,
          saga.tenantId,
          saga.resourceUid,
          saga.tenantId,
          saga.resourceUid,
          saga.tenantId,
          saga.resourceUid,
        ]
      : [
          ...target,
          saga.acceptedUid ?? "",
          saga.acceptedGeneration ?? "",
          saga.acceptedRevision ?? "",
          saga.tenantId,
          saga.resourceUid,
          `${saga.operationId}:cancelled`,
          saga.operationId,
          saga.tenantId,
          saga.resourceUid,
          saga.target.space,
          saga.target.apiVersion,
          saga.target.kind,
          saga.target.name,
          `${saga.operationId}:cancelled`,
          saga.operationId,
        ];
  return {
    sql: `(${releaseFence.sql})
      AND EXISTS (
        SELECT 1 FROM tf_operations
        WHERE id = ? AND tenant_id = ? AND operation = ? AND state = 'failed'
          AND resource_json IS NULL AND created_at = ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM ${PROVIDER_MUTATION_SAGA_TABLE} WHERE operation_id = ?
      )
      AND ${hostFence}
      AND ${claimFence}
      AND ${attemptFence}`,
    params: [
      ...releaseFence.params,
      saga.operationId,
      saga.tenantId,
      storedOperation,
      operationCreatedAt,
      saga.operationId,
      ...hostParams,
      ...claimParams,
      ...attemptParams,
    ],
  };
}

function storedRelations(value: string): readonly TakoformStoredRelation[] {
  const parsed: unknown = JSON.parse(value);
  if (!Array.isArray(parsed)) throw new TypeError("invalid stored Takoform relations");
  return parsed as readonly TakoformStoredRelation[];
}

function providerMutationSaga(row: Row): ProviderMutationSaga {
  const receipt =
    typeof row.receipt_json === "string" ? providerReceipt(row.receipt_json) : undefined;
  return {
    operationId: text(row.operation_id),
    operationKind: providerMutationOperationKind(row.operation_kind),
    replayKey: text(row.replay_key),
    tenantId: text(row.tenant_id),
    fingerprint: text(row.fingerprint),
    resourceUid: text(row.resource_uid),
    ...(row.authority_head_digest === null
      ? {}
      : { authorityHeadDigest: digestText(row.authority_head_digest) }),
    target: {
      tenantId: text(row.tenant_id),
      space: text(row.target_space),
      apiVersion: text(row.target_api_version),
      kind: text(row.target_kind),
      name: text(row.target_name),
    },
    ...(typeof row.accepted_uid === "string" ? { acceptedUid: row.accepted_uid } : {}),
    ...(typeof row.accepted_generation === "string"
      ? { acceptedGeneration: row.accepted_generation }
      : {}),
    ...(typeof row.accepted_revision === "string"
      ? { acceptedRevision: row.accepted_revision }
      : {}),
    ...(receipt ? { receipt } : {}),
  };
}

function providerMutationExecutionState(row: Row | undefined): {
  readonly applySelection?: TakoformApplySelection;
  readonly providerHandle?: string;
  readonly providerOutcome?: "running" | "indeterminate";
} {
  if (!row) throw new Error("provider_mutation_saga_missing_after_lease");
  const providerHandle = typeof row.provider_handle === "string" ? row.provider_handle : undefined;
  const providerOutcome =
    row.provider_outcome === "running" || row.provider_outcome === "indeterminate"
      ? row.provider_outcome
      : undefined;
  return {
    ...providerMutationApplySelectionState(row),
    ...(providerHandle ? { providerHandle } : {}),
    ...(providerOutcome === "indeterminate" || (providerOutcome === "running" && providerHandle)
      ? { providerOutcome }
      : {}),
  };
}

function providerMutationApplySelectionState(row: Row | undefined): {
  readonly applySelection?: TakoformApplySelection;
} {
  if (!row) throw new Error("provider_mutation_saga_missing_after_lease");
  if (row.selection_json === null || row.selection_json === undefined) return {};
  if (typeof row.selection_json !== "string") {
    throw new Error("provider_mutation_apply_selection_invalid");
  }
  return { applySelection: parseTakoformApplySelection(row.selection_json) };
}

function sameProviderMutationSaga(
  left: ProviderMutationSaga,
  right: ProviderMutationSaga,
): boolean {
  return left.replayKey === right.replayKey && sameProviderMutationTarget(left, right);
}

/**
 * A short-lived run credential and its idempotency key may be renewed while a
 * provider mutation is still unresolved. The target, desired bytes, tenant,
 * and accepted incumbent are the durable identity; the renewed caller resumes
 * the stored operation id/resource uid so provider work remains idempotent.
 */
function sameProviderMutationTarget(
  left: ProviderMutationSaga,
  right: ProviderMutationSaga,
): boolean {
  return (
    left.operationKind === right.operationKind &&
    left.tenantId === right.tenantId &&
    left.fingerprint === right.fingerprint &&
    left.authorityHeadDigest === right.authorityHeadDigest &&
    left.target.tenantId === right.target.tenantId &&
    left.target.space === right.target.space &&
    left.target.apiVersion === right.target.apiVersion &&
    left.target.kind === right.target.kind &&
    left.target.name === right.target.name &&
    left.acceptedUid === right.acceptedUid &&
    left.acceptedGeneration === right.acceptedGeneration &&
    left.acceptedRevision === right.acceptedRevision
  );
}

function providerMutationOperationKind(value: unknown): ProviderMutationSaga["operationKind"] {
  if (value === "apply" || value === "import" || value === "delete") return value;
  throw new TypeError("invalid provider mutation operation kind");
}

function providerReceipt(value: unknown): TakoformDriverReceipt {
  if (typeof value !== "string") throw new TypeError("invalid provider mutation receipt");
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("invalid provider mutation receipt");
  }
  return parsed as TakoformDriverReceipt;
}

/**
 * The public execution ledger is derived only from the logical commit input.
 * It never accepts a caller-supplied evidence object and never copies opaque
 * provider receipt/effect data into its durable or public shape.
 */
function resourceExecutionEvidenceSql(input: {
  readonly tenantId: string;
  readonly operationId: string;
  readonly mutation: ResourceMutationCommit;
  readonly committedAt: number;
  readonly fenceDeleteRevision: boolean;
}): {
  readonly fence: string;
  readonly fenceParams: readonly SqlParam[];
  readonly statements: readonly SqlStatement[];
} {
  const { mutation } = input;
  const identityNoOp =
    mutation.kind === "write" &&
    mutation.preserveClaims === true &&
    mutation.expectedRevision !== null &&
    mutation.resource?.metadata.revision === mutation.expectedRevision;
  const identity = resourceExecutionAttestationFence(input.tenantId, mutation);
  const predecessor = resourceExecutionPredecessorFence(
    input.tenantId,
    mutation,
    identityNoOp,
    input.fenceDeleteRevision,
  );
  if (identityNoOp) {
    // A successful identity-preserving apply is useful replay evidence, but it
    // did not commit a new Resource version and must not advance this ledger.
    // It still must not borrow an operation id that already proves a different
    // committed mutation: the absence of a new row is not permission to bypass
    // the ledger's tenant-scoped operation identity.
    return {
      fence: `(${identity.sql}) AND (${predecessor.sql}) AND NOT EXISTS (
          SELECT 1 FROM tf_resource_execution_evidence
          WHERE tenant_id = ? AND operation_id = ?
        ) AND NOT EXISTS (
          SELECT 1 FROM tf_operations WHERE id = ?
        )`,
      fenceParams: [
        ...identity.params,
        ...predecessor.params,
        input.tenantId,
        input.operationId,
        input.operationId,
      ],
      statements: [],
    };
  }
  const action =
    mutation.kind === "delete"
      ? ("delete" as const)
      : mutation.expectedRevision === null
        ? ("create" as const)
        : ("update" as const);
  const fence = `(${identity.sql}) AND NOT EXISTS (
    SELECT 1 FROM tf_resource_execution_evidence
    WHERE tenant_id = ? AND operation_id = ?
  ) AND NOT EXISTS (
    SELECT 1 FROM tf_operations WHERE id = ?
  ) AND (${predecessor.sql})`;
  const fenceParams: readonly SqlParam[] = [
    ...identity.params,
    input.tenantId,
    input.operationId,
    input.operationId,
    ...predecessor.params,
  ];
  const nextSequence = `(
    SELECT COALESCE(MAX(previous.sequence), 0) + 1
    FROM tf_resource_execution_evidence AS previous
    WHERE previous.tenant_id = ? AND previous.resource_uid = ?
  )`;
  const notRecorded = `NOT EXISTS (
    SELECT 1 FROM tf_resource_execution_evidence
    WHERE tenant_id = ? AND operation_id = ?
  ) AND NOT EXISTS (
    SELECT 1 FROM tf_operations WHERE id = ?
  )`;
  if (mutation.kind === "write") {
    const resource = mutation.resource;
    if (!resource) throw new TypeError("write commit requires a resource");
    return {
      fence,
      fenceParams,
      statements: [
        {
          sql: `INSERT INTO tf_resource_execution_evidence
                  (tenant_id, resource_uid, operation_id, sequence, action,
                   resource_generation, resource_revision, committed_at)
                SELECT ?, ?, ?, ${nextSequence}, ?, ?, ?, ?
                WHERE ${notRecorded}`,
          params: [
            input.tenantId,
            mutation.resourceUid,
            input.operationId,
            input.tenantId,
            mutation.resourceUid,
            action,
            resource.metadata.generation,
            resource.metadata.revision,
            input.committedAt,
            input.tenantId,
            input.operationId,
            input.operationId,
          ],
        },
      ],
    };
  }
  return {
    fence,
    fenceParams,
    statements: [
      {
        // Read the exact incarnation immediately before its DELETE statement.
        // The enclosing Resource fence and this SELECT are one serialized
        // batch, so the version cannot be substituted between proof and delete.
        sql: `INSERT INTO tf_resource_execution_evidence
                (tenant_id, resource_uid, operation_id, sequence, action,
                 resource_generation, resource_revision, committed_at)
              SELECT ?, ?, ?, ${nextSequence}, 'delete', resource.generation,
                     resource.revision, ?
              FROM tf_resources AS resource
              WHERE resource.tenant_id = ? AND resource.space = ?
                AND resource.api_version = ? AND resource.kind = ? AND resource.name = ?
                AND resource.uid = ? AND ${notRecorded}`,
        params: [
          input.tenantId,
          mutation.resourceUid,
          input.operationId,
          input.tenantId,
          mutation.resourceUid,
          input.committedAt,
          input.tenantId,
          mutation.address.space,
          mutation.address.apiVersion,
          mutation.address.kind,
          mutation.address.name,
          mutation.resourceUid,
          input.tenantId,
          input.operationId,
          input.operationId,
        ],
      },
    ],
  };
}

function resourceExecutionEvidenceGuardStatement(
  token: string,
  evidence: {
    readonly fence: string;
    readonly fenceParams: readonly SqlParam[];
  },
): SqlStatement {
  const params: readonly SqlParam[] = [token, ...evidence.fenceParams];
  // D1 accepts at most 100 bound values per prepared statement. Keep this
  // proof in its own guard statement so declared Resource claims cannot consume
  // its headroom in the main commit guard.
  if (params.length > 100) throw new TypeError("resource execution evidence fence is too large");
  return {
    sql: `INSERT INTO tf_operation_commit_guards (token, valid)
          SELECT ?, CASE WHEN ${evidence.fence} THEN 1 ELSE 0 END`,
    params,
  };
}

function resourceExecutionAttestationFence(
  tenantId: string,
  mutation: ResourceMutationCommit,
): { readonly sql: string; readonly params: readonly SqlParam[] } {
  const address = mutation.address;
  const resource = mutation.kind === "write" ? mutation.resource : undefined;
  return {
    sql: `EXISTS (
      SELECT 1 FROM tf_resource_deletion_attestations AS attestation
      WHERE attestation.tenant_id = ? AND attestation.resource_uid = ?
        AND attestation.space = ? AND attestation.api_version = ?
        AND attestation.kind = ? AND attestation.name = ?
        ${resource ? "AND attestation.form_ref_json = ?" : ""}
    )`,
    params: [
      tenantId,
      mutation.resourceUid,
      address.space,
      address.apiVersion,
      address.kind,
      address.name,
      ...(resource ? [canonicalJson(resource.form.formRef)] : []),
    ],
  };
}

function resourceExecutionPredecessorFence(
  tenantId: string,
  mutation: ResourceMutationCommit,
  identityNoOp: boolean,
  fenceDeleteRevision: boolean,
): { readonly sql: string; readonly params: readonly SqlParam[] } {
  const address = mutation.address;
  if (mutation.kind === "write" && mutation.expectedRevision === null) {
    const resource = mutation.resource;
    if (!resource) throw new TypeError("write commit requires a resource");
    return {
      sql: `EXISTS (
          SELECT 1 FROM tf_resource_deletion_attestations AS attestation
          WHERE attestation.tenant_id = ? AND attestation.resource_uid = ?
            AND attestation.space = ? AND attestation.api_version = ?
            AND attestation.kind = ? AND attestation.name = ?
            AND attestation.state = 'live' AND attestation.form_ref_json = ?
        ) AND NOT EXISTS (
          SELECT 1 FROM tf_resources AS current
          WHERE current.tenant_id = ? AND current.space = ?
            AND current.api_version = ? AND current.kind = ? AND current.name = ?
        )`,
      params: [
        tenantId,
        mutation.resourceUid,
        address.space,
        address.apiVersion,
        address.kind,
        address.name,
        canonicalJson(resource.form.formRef),
        tenantId,
        address.space,
        address.apiVersion,
        address.kind,
        address.name,
      ],
    };
  }

  const resource = mutation.kind === "write" ? mutation.resource : undefined;
  const exactContent =
    identityNoOp && resource
      ? (() => {
          const [packageDigest, implementationDigest] = exactResourceDigests(resource);
          return {
            sql: `AND current.resource_json = ? AND current.relations_json = ?
                    AND current.package_digest IS ? AND current.implementation_digest IS ?`,
            params: [
              JSON.stringify(resource),
              JSON.stringify(mutation.relations ?? []),
              packageDigest,
              implementationDigest,
            ] as readonly SqlParam[],
          };
        })()
      : { sql: "", params: [] as readonly SqlParam[] };
  const state = mutation.kind === "delete" ? "IN ('live', 'pending')" : "= 'live'";
  const revisionFence =
    mutation.kind === "delete" && !fenceDeleteRevision
      ? { sql: "", params: [] as readonly SqlParam[] }
      : {
          sql: "AND current.revision = ?",
          params: [mutation.expectedRevision ?? ""] as readonly SqlParam[],
        };
  return {
    sql: `EXISTS (
      SELECT 1
      FROM tf_resources AS current
      INNER JOIN tf_resource_deletion_attestations AS attestation
        ON attestation.tenant_id = current.tenant_id
       AND attestation.resource_uid = current.uid
      WHERE current.tenant_id = ? AND current.space = ?
        AND current.api_version = ? AND current.kind = ? AND current.name = ?
        AND current.uid = ? ${revisionFence.sql}
        AND attestation.space = current.space
        AND attestation.api_version = current.api_version
        AND attestation.kind = current.kind AND attestation.name = current.name
        AND attestation.state ${state}
        AND json_extract(current.resource_json, '$.apiVersion') = current.api_version
        AND json_extract(current.resource_json, '$.kind') = current.kind
        AND json_extract(current.resource_json, '$.metadata.space') = current.space
        AND json_extract(current.resource_json, '$.metadata.name') = current.name
        AND json_extract(current.resource_json, '$.metadata.uid') = current.uid
        AND json_extract(current.resource_json, '$.metadata.generation') = current.generation
        AND json_extract(current.resource_json, '$.metadata.revision') = current.revision
        AND json_extract(current.resource_json, '$.form.formRef.apiVersion') =
            json_extract(attestation.form_ref_json, '$.apiVersion')
        AND json_extract(current.resource_json, '$.form.formRef.kind') =
            json_extract(attestation.form_ref_json, '$.kind')
        AND json_extract(current.resource_json, '$.form.formRef.definitionVersion') =
            json_extract(attestation.form_ref_json, '$.definitionVersion')
        AND json_extract(current.resource_json, '$.form.formRef.schemaDigest') =
            json_extract(attestation.form_ref_json, '$.schemaDigest')
        ${resource ? "AND attestation.form_ref_json = ?" : ""}
        ${exactContent.sql}
    )`,
    params: [
      tenantId,
      address.space,
      address.apiVersion,
      address.kind,
      address.name,
      mutation.resourceUid,
      ...revisionFence.params,
      ...(resource ? [canonicalJson(resource.form.formRef)] : []),
      ...exactContent.params,
    ],
  };
}

function assertResourceMutationIdentity(input: {
  readonly tenantId: string;
  readonly mutation: ResourceMutationCommit;
  readonly expectedResourceUid?: string;
  readonly expectedAddress?: {
    readonly space: string;
    readonly apiVersion: string;
    readonly kind: string;
    readonly name: string;
  };
  readonly expectedFormRef?: TakoformV1Alpha3FormRef;
}): void {
  const { mutation } = input;
  const address = mutation.address;
  const expected = input.expectedAddress;
  if (
    address.tenantId !== input.tenantId ||
    (input.expectedResourceUid !== undefined &&
      mutation.resourceUid !== input.expectedResourceUid) ||
    (expected !== undefined &&
      (address.space !== expected.space ||
        address.apiVersion !== expected.apiVersion ||
        address.kind !== expected.kind ||
        address.name !== expected.name))
  ) {
    throw new TypeError("resource mutation identity mismatch");
  }
  if (mutation.kind !== "write") {
    if (mutation.expectedRevision === null || mutation.preserveClaims === true) {
      throw new TypeError("resource mutation identity mismatch");
    }
    return;
  }
  const resource = mutation.resource;
  if (
    !resource ||
    resource.metadata.uid !== mutation.resourceUid ||
    resource.metadata.space !== address.space ||
    resource.apiVersion !== address.apiVersion ||
    resource.kind !== address.kind ||
    resource.metadata.name !== address.name ||
    resource.form.formRef.apiVersion !== resource.apiVersion ||
    resource.form.formRef.kind !== resource.kind ||
    (input.expectedFormRef !== undefined &&
      canonicalJson(resource.form.formRef) !== canonicalJson(input.expectedFormRef)) ||
    (mutation.preserveClaims === true &&
      (mutation.expectedRevision === null ||
        resource.metadata.revision !== mutation.expectedRevision))
  ) {
    throw new TypeError("resource mutation identity mismatch");
  }
}

function assertResourceMutationOperation(
  operation: "create" | "update" | "apply" | "import" | "delete",
  mutation: ResourceMutationCommit,
): void {
  const valid =
    operation === "delete"
      ? mutation.kind === "delete"
      : operation === "create"
        ? mutation.kind === "write" && mutation.expectedRevision === null
        : operation === "update"
          ? mutation.kind === "write" && mutation.expectedRevision !== null
          : mutation.kind === "write";
  if (!valid) throw new TypeError("resource mutation operation mismatch");
}

function providerMutationCommitStatements(input: {
  readonly guard: string;
  readonly tenantId: string;
  readonly operationId: string;
  readonly operation: "create" | "update" | "apply" | "import" | "delete";
  readonly createdAt: string;
  readonly mutation: ResourceMutationCommit;
  readonly claimOwnerId: string;
  readonly now: number;
  readonly additionalFence?: string;
  readonly additionalFenceParams?: readonly SqlParam[];
  readonly beforeOperationStatements?: readonly SqlStatement[];
}): SqlStatement[] {
  const { mutation } = input;
  const address = mutation.address;
  const key = [address.tenantId, address.space, address.apiVersion, address.kind, address.name];
  const receiptJson = mutation.providerReceipt
    ? canonicalJson(mutation.providerReceipt)
    : undefined;
  const sagaOperationKind =
    input.operation === "import" || input.operation === "delete" ? input.operation : "apply";
  const claimKeys = mutation.claimKeys ?? [];
  const claimFence =
    claimKeys.length === 0
      ? "1 = 1"
      : `(SELECT COUNT(*) FROM tf_resource_claims
          WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
            AND claim_key IN (${claimKeys.map(() => "?").join(", ")})) = ?`;
  const deployment = deploymentMutationSql(mutation.providerReceipt, input.now);
  const providerEffect = providerEffectSql(mutation, input.now);
  const deletionFence = deletionTombstoneFence(mutation, input.operationId);
  const executionEvidence = resourceExecutionEvidenceSql({
    tenantId: input.tenantId,
    operationId: input.operationId,
    mutation,
    committedAt: input.now,
    fenceDeleteRevision: true,
  });
  const executionEvidenceGuard = boundedGuard(`evidence_${input.guard}`);
  const dependencyGuards = resourceDependencyCommitGuards({
    tokenBase: input.guard,
    tenantId: input.tenantId,
    resourceUid: mutation.resourceUid,
    operationId: input.operationId,
    dependencies: mutation.dependencySet,
  });
  const sagaFence = receiptJson
    ? `EXISTS (
    SELECT 1 FROM ${PROVIDER_MUTATION_SAGA_TABLE} AS saga
    WHERE saga.operation_id = ? AND saga.replay_key = ? AND saga.tenant_id = ?
      AND saga.fingerprint = ? AND saga.resource_uid = ?
      AND saga.protocol_generation = 1 AND saga.operation_kind = ?
      AND saga.target_space = ? AND saga.target_api_version = ?
      AND saga.target_kind = ? AND saga.target_name = ?
      AND saga.accepted_revision IS ?
      AND saga.phase = 'executed' AND saga.receipt_json = ?
      AND (
        (saga.accepted_uid IS NULL AND NOT EXISTS (
          SELECT 1 FROM tf_resources
          WHERE tenant_id = saga.tenant_id AND space = saga.target_space
            AND api_version = saga.target_api_version AND kind = saga.target_kind
            AND name = saga.target_name
        )) OR
        EXISTS (
          SELECT 1 FROM tf_resources AS resource
          WHERE resource.tenant_id = saga.tenant_id AND resource.space = saga.target_space
            AND resource.api_version = saga.target_api_version
            AND resource.kind = saga.target_kind AND resource.name = saga.target_name
            AND resource.uid = saga.accepted_uid
            AND resource.generation = saga.accepted_generation
            AND resource.revision = saga.accepted_revision
        )
      )
  )`
    : "1 = 1";
  const statements: SqlStatement[] = [
    ...dependencyGuards.statements,
    {
      sql: `INSERT INTO tf_operation_commit_guards (token, valid)
            SELECT ?, CASE WHEN ${sagaFence} AND ${claimFence}
                                 AND ${deployment.fence}
                                 AND ${deletionFence.sql}
                                 AND ${providerEffect.fence}
                                 AND (${input.additionalFence ?? "1 = 1"}) THEN 1 ELSE 0 END`,
      params: [
        input.guard,
        ...(receiptJson
          ? [
              input.operationId,
              mutation.replayKey,
              input.tenantId,
              mutation.replay.fingerprint,
              mutation.resourceUid,
              sagaOperationKind,
              address.space,
              address.apiVersion,
              address.kind,
              address.name,
              mutation.expectedRevision,
              receiptJson,
            ]
          : []),
        ...(claimKeys.length === 0
          ? []
          : [
              input.claimOwnerId,
              input.tenantId,
              mutation.resourceUid,
              ...claimKeys,
              claimKeys.length,
            ]),
        ...deployment.fenceParams,
        ...deletionFence.params,
        ...providerEffect.fenceParams,
        ...(input.additionalFenceParams ?? []),
      ],
    },
    resourceExecutionEvidenceGuardStatement(executionEvidenceGuard, executionEvidence),
    ...deployment.statements,
    ...providerEffect.statements,
    ...deletionTombstoneStatements(mutation, input.now),
    ...executionEvidence.statements,
  ];
  if (mutation.kind === "write") {
    const resource = mutation.resource;
    if (!resource) throw new TypeError("write commit requires a resource");
    const relations = mutation.relations ?? [];
    const [packageDigest, implementationDigest] = exactResourceDigests(resource);
    if (mutation.expectedRevision === null) {
      statements.push({
        sql: `INSERT INTO tf_resources
                (tenant_id, space, api_version, kind, name, uid, generation, revision,
                 resource_json, relations_json, package_digest, implementation_digest, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        params: [
          ...key,
          resource.metadata.uid,
          resource.metadata.generation,
          resource.metadata.revision,
          JSON.stringify(resource),
          JSON.stringify(relations),
          packageDigest,
          implementationDigest,
          input.now,
        ],
      });
    } else {
      statements.push({
        sql: `UPDATE tf_resources
              SET uid = ?, generation = ?, revision = ?, resource_json = ?,
                  relations_json = ?, package_digest = ?, implementation_digest = ?, updated_at = ?
              WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
                AND revision = ?`,
        params: [
          resource.metadata.uid,
          resource.metadata.generation,
          resource.metadata.revision,
          JSON.stringify(resource),
          JSON.stringify(relations),
          packageDigest,
          implementationDigest,
          input.now,
          ...key,
          mutation.expectedRevision,
        ],
      });
    }
  } else {
    statements.push({
      sql: `DELETE FROM tf_resources
            WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
              AND revision = ?`,
      params: [...key, mutation.expectedRevision ?? ""],
    });
  }
  statements.push(
    {
      sql: `INSERT INTO tf_replays
              (replay_key, fingerprint, status, resource_json, bound_uid, expires_at)
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT (replay_key) DO UPDATE SET
              fingerprint = excluded.fingerprint, status = excluded.status,
              resource_json = excluded.resource_json, bound_uid = excluded.bound_uid,
              expires_at = excluded.expires_at`,
      params: [
        mutation.replayKey,
        mutation.replay.fingerprint,
        mutation.replay.status,
        mutation.replay.resource ? JSON.stringify(mutation.replay.resource) : null,
        mutation.replay.boundUid ?? null,
        input.now + REPLAY_TTL_MILLISECONDS,
      ],
    },
    ...(mutation.preserveClaims
      ? []
      : claimCommitStatements(
          {
            id: input.claimOwnerId,
            tenantId: input.tenantId,
            resourceUid: mutation.resourceUid,
          },
          mutation.kind === "delete" ? [] : claimKeys,
          input.now,
        )),
    ...resourceDependencyCommitStatements({
      tenantId: input.tenantId,
      resourceUid: mutation.resourceUid,
      operationId: input.operationId,
      mutation,
      timestamp: input.now,
    }),
    ...(input.beforeOperationStatements ?? []),
    {
      sql: `INSERT OR IGNORE INTO tf_operations
              (id, tenant_id, operation, state, resource_json, created_at, expires_at)
            VALUES (?, ?, ?, 'succeeded', ?, ?, ?)`,
      params: [
        input.operationId,
        input.tenantId,
        input.operation,
        mutation.resource ? JSON.stringify(mutation.resource) : null,
        input.createdAt,
        input.now + OPERATION_TTL_MILLISECONDS,
      ],
    },
    ...(receiptJson
      ? [
          {
            sql: `DELETE FROM ${PROVIDER_MUTATION_SAGA_TABLE}
                  WHERE operation_id = ? AND tenant_id = ? AND receipt_json = ?`,
            params: [input.operationId, input.tenantId, receiptJson],
          },
        ]
      : []),
    ...dependencyGuards.cleanup,
    {
      sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
      params: [executionEvidenceGuard],
    },
    {
      sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
      params: [input.guard],
    },
  );
  return statements;
}

function deletionTombstoneFence(
  mutation: ResourceMutationCommit,
  operationId: string,
): { readonly sql: string; readonly params: readonly SqlParam[] } {
  if (!mutation.deletionTombstone) return { sql: "1 = 1", params: [] };
  return {
    sql: `EXISTS (
      SELECT 1 FROM tf_resource_deletion_attestations AS attestation
      WHERE attestation.tenant_id = ? AND attestation.resource_uid = ?
        AND attestation.state = 'pending'
        AND EXISTS (
          SELECT 1 FROM tf_resource_provider_effects AS effect
          WHERE effect.tenant_id = attestation.tenant_id
            AND effect.resource_uid = attestation.resource_uid
            AND effect.effect_id = ?
            AND effect.phase = 'dispatched'
        )
    )`,
    params: [mutation.address.tenantId, mutation.resourceUid, operationId],
  };
}

function providerEffectSql(
  mutation: ResourceMutationCommit,
  timestamp: number,
): {
  readonly fence: string;
  readonly fenceParams: readonly SqlParam[];
  readonly statements: readonly SqlStatement[];
} {
  const declared =
    mutation.providerEffect ??
    (mutation.deletionTombstone
      ? {
          effectId: mutation.deletionTombstone.operationId,
          kind: "delete" as const,
          operationMode: "initial" as const,
        }
      : undefined);
  if (!declared) return { fence: "1 = 1", fenceParams: [], statements: [] };
  const providerMutation = mutation.providerReceipt?.deploymentMutation;
  const providerPackRef =
    providerMutation && "providerPackRef" in providerMutation
      ? providerMutation.providerPackRef
      : undefined;
  const providerInstallationRef =
    providerMutation && "providerInstallationRef" in providerMutation
      ? providerMutation.providerInstallationRef
      : undefined;
  const nativeId =
    providerMutation && "expectedNativeId" in providerMutation
      ? providerMutation.expectedNativeId
      : undefined;
  const target = {
    resourceUid: mutation.resourceUid,
    address: {
      space: mutation.address.space,
      apiVersion: mutation.address.apiVersion,
      kind: mutation.address.kind,
      name: mutation.address.name,
    },
    ...(providerPackRef ? { providerPackRef } : {}),
    ...(providerInstallationRef ? { providerInstallationRef } : {}),
    ...(nativeId ? { nativeId } : {}),
  } satisfies JsonObject;
  const operationMode = declared.operationMode ?? "initial";
  return {
    fence: `EXISTS (
      SELECT 1 FROM tf_resource_provider_effects
      WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
        AND phase = 'dispatched'
    )`,
    fenceParams: [mutation.address.tenantId, mutation.resourceUid, declared.effectId],
    statements: [
      {
        sql: `INSERT OR IGNORE INTO tf_resource_provider_effects
               (tenant_id, resource_uid, event_id, effect_id, effect_kind, phase,
                operation_mode, provider_pack_ref, provider_installation_ref,
                native_id, target_json, created_at)
             SELECT ?, ?, ?, ?, ?, 'succeeded', ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM tf_resource_provider_effects
               WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
                 AND phase = 'dispatched'
             )`,
        params: [
          mutation.address.tenantId,
          mutation.resourceUid,
          `${declared.effectId}:succeeded`,
          declared.effectId,
          declared.kind,
          operationMode,
          providerPackRef ?? null,
          providerInstallationRef ?? null,
          nativeId ?? null,
          canonicalJson(target),
          timestamp,
          mutation.address.tenantId,
          mutation.resourceUid,
          declared.effectId,
        ],
      },
      {
        sql: `UPDATE tf_resource_deletion_attestations
              SET closure_fence = closure_fence + 1,
                  effects_json = json_insert(effects_json, '$[#]', json(?)),
                  evidence_json = NULL, evidence_ref = NULL,
                  evidence_effect_digest = NULL, evidence_checked_at = NULL,
                  evidence_status = NULL, updated_at = ?
              WHERE tenant_id = ? AND resource_uid = ?
                AND state IN ('live', 'pending')`,
        params: [
          canonicalJson({
            eventId: `${declared.effectId}:succeeded`,
            operationId: declared.effectId,
            kind: declared.kind,
            phase: "succeeded",
            operationMode,
            ...(providerPackRef ? { providerPackRef } : {}),
            ...(providerInstallationRef ? { providerInstallationRef } : {}),
            ...(nativeId ? { nativeId } : {}),
            target,
          }),
          timestamp,
          mutation.address.tenantId,
          mutation.resourceUid,
        ],
      },
    ],
  };
}

function deletionTombstoneStatements(
  mutation: ResourceMutationCommit,
  timestamp: number,
): readonly SqlStatement[] {
  const tombstone = mutation.deletionTombstone;
  if (!tombstone) return [];
  return [
    {
      sql: `UPDATE tf_resource_deletion_attestations
            SET state = 'closed', closure_fence = closure_fence + 1,
                evidence_json = NULL, evidence_ref = NULL,
                evidence_effect_digest = NULL, evidence_checked_at = NULL,
                evidence_status = NULL, updated_at = ?
            WHERE tenant_id = ? AND resource_uid = ? AND state = 'pending'
              AND EXISTS (
                SELECT 1 FROM tf_resource_provider_effects
                WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
                  AND phase = 'succeeded'
              )
              AND NOT EXISTS (
                SELECT 1 FROM tf_resource_provider_effects AS open_effect
                WHERE open_effect.tenant_id = tf_resource_deletion_attestations.tenant_id
                  AND open_effect.resource_uid = tf_resource_deletion_attestations.resource_uid
                  AND open_effect.phase IN ('planned', 'dispatched')
                  AND NOT EXISTS (
                    SELECT 1 FROM tf_resource_provider_effects AS terminal_effect
                    WHERE terminal_effect.tenant_id = open_effect.tenant_id
                      AND terminal_effect.resource_uid = open_effect.resource_uid
                      AND terminal_effect.effect_id = open_effect.effect_id
                      AND terminal_effect.phase IN ('succeeded', 'cancelled')
                  )
              )`,
      params: [
        timestamp,
        mutation.address.tenantId,
        mutation.resourceUid,
        mutation.address.tenantId,
        mutation.resourceUid,
        tombstone.operationId,
      ],
    },
  ];
}

function deploymentMutationSql(
  receipt: TakoformDriverReceipt | undefined,
  timestamp: number,
): {
  readonly fence: string;
  readonly fenceParams: readonly SqlParam[];
  readonly statements: readonly SqlStatement[];
} {
  const mutation = receipt?.deploymentMutation;
  if (!mutation) return { fence: "1 = 1", fenceParams: [], statements: [] };
  if (mutation.kind === "create") {
    const value = mutation.deployment;
    return {
      fence: `NOT EXISTS (
        SELECT 1 FROM tf_resource_deployments
        WHERE tenant_id = ? AND (id = ? OR (resource_uid = ? AND state = 'active'))
      )`,
      fenceParams: [value.tenantId, value.id, value.resourceUid],
      statements: [
        {
          sql: `INSERT INTO tf_resource_deployments
                   (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
                    provider_installation_ref, native_id, native_claimed, state,
                    observed_json, outputs_json, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            value.tenantId,
            value.id,
            value.resourceUid,
            value.offeringId,
            value.providerPackRef,
            value.providerInstallationRef,
            value.nativeId,
            value.nativeClaimed === true ? 1 : 0,
            value.state,
            JSON.stringify(value.observed),
            JSON.stringify(value.outputs),
            timestamp,
            timestamp,
          ],
        },
      ],
    };
  }
  const commonFence = `EXISTS (
    SELECT 1 FROM tf_resource_deployments
    WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'active'
  )`;
  const commonParams = [mutation.tenantId, mutation.deploymentId, mutation.expectedNativeId];
  if (mutation.kind === "refresh") {
    return {
      fence: commonFence,
      fenceParams: commonParams,
      statements: [
        {
          sql: `UPDATE tf_resource_deployments
                SET observed_json = ?, outputs_json = ?, updated_at = ?
                WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'active'`,
          params: [
            JSON.stringify(mutation.observed),
            JSON.stringify(mutation.outputs),
            timestamp,
            ...commonParams,
          ],
        },
      ],
    };
  }
  if (mutation.kind === "claim") {
    return {
      fence: `${commonFence} AND EXISTS (
        SELECT 1 FROM tf_resource_deployments
        WHERE tenant_id = ? AND id = ? AND native_id = ? AND native_claimed = 0
      )`,
      fenceParams: [...commonParams, ...commonParams],
      statements: [
        {
          sql: `UPDATE tf_resource_deployments
                SET native_id = ?, native_claimed = 1, observed_json = ?,
                    outputs_json = ?, updated_at = ?
                WHERE tenant_id = ? AND id = ? AND native_id = ?
                  AND native_claimed = 0 AND state = 'active'`,
          params: [
            mutation.nativeId,
            JSON.stringify(mutation.observed),
            JSON.stringify(mutation.outputs),
            timestamp,
            ...commonParams,
          ],
        },
      ],
    };
  }
  if (mutation.kind === "retain") {
    return {
      fence: commonFence,
      fenceParams: commonParams,
      statements: [
        {
          sql: mutation.operationId
            ? `UPDATE tf_resource_deployments
                SET state = 'retained', observed_json = ?,
                    outputs_json = json_set(
                      ?,
                      '$.__takoserver.deleteOperationId', ?,
                      '$.__takoserver.resourceUid', ?,
                      '$.__takoserver.space', ?,
                      '$.__takoserver.name', ?
                    ), updated_at = ?
                WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'active'`
            : `UPDATE tf_resource_deployments
                SET state = 'retained', observed_json = ?, outputs_json = ?, updated_at = ?
                WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'active'`,
          params: [
            JSON.stringify(mutation.observed),
            ...(mutation.operationId
              ? [
                  JSON.stringify(mutation.outputs),
                  mutation.operationId,
                  mutation.resourceUid ?? "",
                  mutation.space ?? "",
                  mutation.name ?? "",
                  timestamp,
                  ...commonParams,
                ]
              : [JSON.stringify(mutation.outputs), timestamp, ...commonParams]),
          ],
        },
      ],
    };
  }
  return {
    fence: commonFence,
    fenceParams: commonParams,
    statements: [
      {
        sql: mutation.operationId
          ? `UPDATE tf_resource_deployments
              SET state = 'deleted',
                    outputs_json = json_set(
                    outputs_json,
                    '$.__takoserver.deleteOperationId', ?,
                    '$.__takoserver.resourceUid', ?,
                    '$.__takoserver.space', ?,
                    '$.__takoserver.name', ?
                  ),
                  updated_at = ?
              WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'active'`
          : `UPDATE tf_resource_deployments SET state = 'deleted', updated_at = ?
              WHERE tenant_id = ? AND id = ? AND native_id = ? AND state = 'active'`,
        params: mutation.operationId
          ? [
              mutation.operationId,
              mutation.resourceUid ?? "",
              mutation.space ?? "",
              mutation.name ?? "",
              timestamp,
              ...commonParams,
            ]
          : [timestamp, ...commonParams],
      },
    ],
  };
}

function deferredOperation(row: Row): DeferredOperationRecord {
  const headers = JSON.parse(text(row.request_headers_json)) as unknown;
  const formRef = JSON.parse(text(row.target_form_ref_json)) as unknown;
  if (
    typeof headers !== "object" ||
    headers === null ||
    Array.isArray(headers) ||
    typeof formRef !== "object" ||
    formRef === null ||
    Array.isArray(formRef)
  ) {
    throw new TypeError("invalid stored deferred operation");
  }
  const phase = text(row.phase);
  if (!isDeferredPhase(phase)) throw new TypeError("invalid stored deferred operation phase");
  const operation = text(row.operation);
  if (operation !== "apply" && operation !== "import" && operation !== "delete") {
    throw new TypeError("invalid stored deferred operation kind");
  }
  return {
    id: text(row.id),
    tenantId: text(row.tenant_id),
    principalId: text(row.principal_id),
    operation,
    phase,
    requestPath: text(row.request_path),
    requestQuery: text(row.request_query),
    requestHeaders: headers as Readonly<Record<string, string>>,
    ...(typeof row.request_body_json === "string" ? { requestBody: row.request_body_json } : {}),
    fingerprint: text(row.fingerprint),
    replayKey: text(row.replay_key),
    target: {
      space: text(row.target_space),
      apiVersion: text(row.target_api_version),
      kind: text(row.target_kind),
      name: text(row.target_name),
      formRef: formRef as unknown as TakoformV1Alpha3FormRef,
    },
    ...(typeof row.accepted_uid === "string" ? { acceptedUid: row.accepted_uid } : {}),
    ...(typeof row.accepted_generation === "string"
      ? { acceptedGeneration: row.accepted_generation }
      : {}),
    ...(typeof row.accepted_revision === "string"
      ? { acceptedRevision: row.accepted_revision }
      : {}),
    resourceUid: text(row.resource_uid),
    ...(typeof row.worker_endpoint_origin_reservation_id === "string"
      ? { workerEndpointOriginReservationId: row.worker_endpoint_origin_reservation_id }
      : {}),
    pollsRemaining: Number(row.polls_remaining),
    ...(typeof row.lease_token === "string" ? { leaseToken: row.lease_token } : {}),
    ...(typeof row.lease_until === "number" ? { leaseUntil: row.lease_until } : {}),
    ...(typeof row.terminal_json === "string" ? { terminalJson: row.terminal_json } : {}),
    ...(typeof row.committed_uid === "string" ? { committedUid: row.committed_uid } : {}),
    createdAt: text(row.created_at),
  };
}

function isDeferredPhase(value: string): value is DeferredOperationPhase {
  return ["pending", "committing", "succeeded", "failed", "cancelled"].includes(value);
}

function terminalPhase(phase: DeferredOperationPhase): boolean {
  return phase === "succeeded" || phase === "failed" || phase === "cancelled";
}

async function authorityFenceSql(fence: TakoformAuthorityFence): Promise<{
  readonly sql: string;
  readonly params: readonly SqlParam[];
}> {
  if (
    fence.version !== "takoserver.takoform-authority-fence@v1" ||
    !isDigest(fence.headDigest) ||
    !isDigest(fence.packageDigest) ||
    !isDigest(fence.implementationDigest) ||
    !Array.isArray(fence.heads) ||
    fence.heads.length === 0 ||
    fence.heads.length > 16
  ) {
    throw new TakoformHostError("form_unavailable", 503);
  }
  const normalized = [...fence.heads].sort((left, right) =>
    `${left.kind}\u0000${left.key}`.localeCompare(`${right.kind}\u0000${right.key}`),
  );
  if (
    canonicalJson(normalized) !== canonicalJson(fence.heads) ||
    (await canonicalDigest({
      version: fence.version,
      mode: fence.mode,
      packageDigest: fence.packageDigest,
      implementationDigest: fence.implementationDigest,
      heads: normalized,
    })) !== fence.headDigest
  ) {
    throw new TakoformHostError("form_unavailable", 503);
  }
  const clauses: string[] = [];
  const params: SqlParam[] = [];
  const seen = new Set<string>();
  for (const head of fence.heads) {
    const identity = `${head.kind}\u0000${head.key}`;
    if (
      seen.has(identity) ||
      head.key.length === 0 ||
      head.key.length > 512 ||
      (head.eventDigest !== null && !isDigest(head.eventDigest))
    ) {
      throw new TakoformHostError("form_unavailable", 503);
    }
    seen.add(identity);
    if (head.kind === "install-event") {
      if (head.eventDigest === null || head.key !== head.eventDigest) {
        throw new TakoformHostError("form_unavailable", 503);
      }
      clauses.push("(SELECT COUNT(*) FROM tf_form_install_events WHERE event_digest = ?) = 1");
      params.push(head.eventDigest);
      continue;
    }
    if (head.kind === "checkpoint") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(head.key);
      } catch {
        throw new TakoformHostError("form_unavailable", 503);
      }
      if (
        typeof parsed !== "object" ||
        parsed === null ||
        Array.isArray(parsed) ||
        typeof (parsed as { publisherKey?: unknown }).publisherKey !== "string" ||
        !["trust.forms.takoform.com/v1", "trust.forms.takoform.com/v1alpha1"].includes(
          String((parsed as { checkpointApiVersion?: unknown }).checkpointApiVersion),
        )
      ) {
        throw new TakoformHostError("form_unavailable", 503);
      }
      const publisherKey = (parsed as { publisherKey: string }).publisherKey;
      const apiVersion = String((parsed as { checkpointApiVersion: string }).checkpointApiVersion);
      clauses.push(
        currentHeadCountClause(
          "tf_form_revocation_checkpoints",
          "publisher_key = ? AND checkpoint_api_version = ?",
          "successor.publisher_key = current.publisher_key AND successor.checkpoint_api_version = current.checkpoint_api_version",
          head.eventDigest,
        ),
      );
      params.push(
        publisherKey,
        apiVersion,
        ...(head.eventDigest === null ? [] : [publisherKey, apiVersion, head.eventDigest]),
      );
      continue;
    }
    if (head.kind === "purge") {
      const [formRefKey, packageDigest, extra] = head.key.split("\u0000");
      if (extra !== undefined || !isDigest(formRefKey) || !isDigest(packageDigest)) {
        throw new TakoformHostError("form_unavailable", 503);
      }
      clauses.push(
        currentHeadCountClause(
          "tf_form_package_purge_events",
          "form_ref_key = ? AND package_digest = ?",
          "successor.form_ref_key = current.form_ref_key AND successor.package_digest = current.package_digest",
          head.eventDigest,
        ),
      );
      params.push(
        formRefKey,
        packageDigest,
        ...(head.eventDigest === null ? [] : [formRefKey, packageDigest, head.eventDigest]),
      );
      continue;
    }
    const tableAndColumn =
      head.kind === "publisher"
        ? (["tf_form_publisher_events", "publisher_key"] as const)
        : head.kind === "install"
          ? (["tf_form_install_events", "form_ref_key"] as const)
          : head.kind === "support"
            ? (["tf_form_support_events", "support_key"] as const)
            : head.kind === "activation"
              ? (["tf_form_activation_events", "activation_key"] as const)
              : null;
    if (!tableAndColumn) throw new TakoformHostError("form_unavailable", 503);
    const [table, column] = tableAndColumn;
    clauses.push(
      currentHeadCountClause(
        table,
        `${column} = ?`,
        `successor.${column} = current.${column}`,
        head.eventDigest,
      ),
    );
    params.push(head.key, ...(head.eventDigest === null ? [] : [head.key, head.eventDigest]));
  }
  return { sql: clauses.join(" AND "), params };
}

function currentHeadCountClause(
  table: string,
  keyPredicate: string,
  successorKeyPredicate: string,
  eventDigest: string | null,
): string {
  const current = `(SELECT COUNT(*) FROM ${table} AS current
    WHERE ${keyPredicate}
      AND NOT EXISTS (
        SELECT 1 FROM ${table} AS successor
        WHERE ${successorKeyPredicate}
          AND successor.predecessor_digest = current.event_digest
      ))`;
  if (eventDigest === null) return `${current} = 0`;
  return `(${current} = 1 AND EXISTS (
    SELECT 1 FROM ${table} AS current
    WHERE ${keyPredicate}
      AND current.event_digest = ?
      AND NOT EXISTS (
        SELECT 1 FROM ${table} AS successor
        WHERE ${successorKeyPredicate}
          AND successor.predecessor_digest = current.event_digest
      )))`;
}

function exactResourceDigests(
  resource: TakoformStoredResource,
): readonly [`sha256:${string}` | null, `sha256:${string}` | null] {
  const packageDigest = resource.form.packageDigest;
  const implementationDigest = resource.form.implementationDigest;
  if (packageDigest === undefined && implementationDigest === undefined) {
    return [null, null];
  }
  if (!isDigest(packageDigest) || !isDigest(implementationDigest)) {
    throw new TakoformHostError("form_unavailable", 503);
  }
  return [packageDigest, implementationDigest];
}

function storedResource(row: Row): TakoformStoredResource {
  const resource = JSON.parse(text(row.resource_json)) as TakoformStoredResource;
  const packageDigest = row.package_digest;
  const implementationDigest = row.implementation_digest;
  if (packageDigest === null && implementationDigest === null) {
    const {
      packageDigest: _legacyPackageDigest,
      implementationDigest: _legacyImplementationDigest,
      ...formRef
    } = resource.form;
    return {
      ...resource,
      form: formRef,
    };
  }
  if (
    !isDigest(packageDigest) ||
    !isDigest(implementationDigest) ||
    resource.form.packageDigest !== packageDigest ||
    resource.form.implementationDigest !== implementationDigest
  ) {
    throw new TakoformHostError("form_unavailable", 503);
  }
  return resource;
}

function digestText(value: unknown): `sha256:${string}` {
  if (!isDigest(value)) throw new TakoformHostError("form_unavailable", 503);
  return value;
}

function isDigest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function uncommittedResourceIncarnationRelease(input: {
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly effectId: string;
}): {
  readonly fence: string;
  readonly fenceParams: readonly SqlParam[];
  readonly statements: readonly SqlStatement[];
} {
  const fence = `
    NOT EXISTS (
      SELECT 1 FROM tf_resources
      WHERE tenant_id = ? AND uid = ?
    )
    AND NOT EXISTS (
      SELECT 1 FROM tf_resource_deployments
      WHERE tenant_id = ? AND resource_uid = ? AND state NOT IN ('deleted', 'failed')
    )
    AND EXISTS (
      SELECT 1 FROM tf_resource_deletion_attestations
      WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
    )
    AND NOT EXISTS (
      SELECT 1 FROM tf_resource_provider_effects
      WHERE tenant_id = ? AND resource_uid = ?
        AND (effect_id <> ? OR phase = 'succeeded')
    )`;
  const fenceParams = [
    input.tenantId,
    input.resourceUid,
    input.tenantId,
    input.resourceUid,
    input.tenantId,
    input.resourceUid,
    input.tenantId,
    input.resourceUid,
    input.effectId,
  ] as const;
  return {
    fence,
    fenceParams,
    statements: [
      {
        sql: `DELETE FROM tf_resource_provider_effects
              WHERE tenant_id = ? AND resource_uid = ? AND effect_id = ?
                AND ${fence}`,
        params: [input.tenantId, input.resourceUid, input.effectId, ...fenceParams],
      },
      {
        sql: `DELETE FROM tf_resource_deletion_attestations
              WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
                AND ${fence}`,
        params: [input.tenantId, input.resourceUid, ...fenceParams],
      },
    ],
  };
}

function boundedGuard(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128);
}

function resourceDependencyKeysJson(dependencies: ResourceDependencySet): string {
  return boundedResourceDependencyJson(resourceDependencyClaimKeys(dependencies), "keys");
}

function resourceDependencyFencesJson(dependencies: ResourceDependencySet): string {
  return boundedResourceDependencyJson(
    dependencies.fences.map((fence) => [
      fence.key,
      fence.target.space,
      fence.target.apiVersion,
      fence.target.kind,
      fence.target.name,
      fence.target.uid,
      fence.target.revision,
      canonicalJson(fence.target.formRef),
    ]),
    "targets",
  );
}

/** D1 bounds each string parameter at 2,000,000 bytes, including JSON1 inputs. */
function boundedResourceDependencyJson(value: unknown, label: string): string {
  const serialized = canonicalJson(value);
  if (new TextEncoder().encode(serialized).byteLength > 2_000_000) {
    throw new TypeError(`resource dependency ${label} exceed the D1 parameter limit`);
  }
  return serialized;
}

/** Readback is only error classification; the preceding batch remains the permission boundary. */
async function resourceDependenciesStillCurrent(
  sql: Sql,
  now: () => number,
  input: {
    readonly tenantId: string;
    readonly resourceUid: string;
    readonly ownerId: string;
    readonly dependencies: ResourceDependencySet;
  },
): Promise<boolean> {
  const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
  const expectedKeys = resourceDependencyClaimKeys(input.dependencies);
  const rows = await sql.query(
    `SELECT claim_key FROM tf_resource_claims
     WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
       AND claim_key >= ? AND claim_key < ?
       AND (state = 'committed' OR expires_at > ?)
     ORDER BY claim_key`,
    [input.ownerId, input.tenantId, input.resourceUid, dependencyStart, dependencyEnd, now()],
  );
  if (canonicalJson(rows.map((row) => text(row.claim_key))) !== canonicalJson(expectedKeys)) {
    return false;
  }
  const targets = await sql.query(
    `SELECT CASE WHEN NOT EXISTS (
       SELECT 1 FROM json_each(?) AS fence
       WHERE NOT EXISTS (
         SELECT 1 FROM tf_resources AS target
         WHERE target.tenant_id = ?
           AND target.space = json_extract(fence.value, '$[1]')
           AND target.api_version = json_extract(fence.value, '$[2]')
           AND target.kind = json_extract(fence.value, '$[3]')
           AND target.name = json_extract(fence.value, '$[4]')
           AND target.uid = json_extract(fence.value, '$[5]')
           AND target.revision = json_extract(fence.value, '$[6]')
           AND EXISTS (
             SELECT 1 FROM tf_resource_deletion_attestations AS attestation
             WHERE attestation.tenant_id = target.tenant_id
               AND attestation.resource_uid = target.uid
               AND attestation.space = target.space
               AND attestation.api_version = target.api_version
               AND attestation.kind = target.kind AND attestation.name = target.name
               AND attestation.form_ref_json = json_extract(fence.value, '$[7]')
               AND attestation.state = 'live'
           )
       )
     ) THEN 1 ELSE 0 END AS current`,
    [resourceDependencyFencesJson(input.dependencies), input.tenantId],
  );
  return targets.length === 1 && targets[0]?.current === 1;
}

function resourceDependencyCommitGuards(input: {
  readonly tokenBase: string;
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly operationId: string;
  readonly dependencies: ResourceDependencySet | undefined;
}): {
  readonly statements: readonly SqlStatement[];
  readonly cleanup: readonly SqlStatement[];
} {
  if (!input.dependencies) return { statements: [], cleanup: [] };
  if (input.dependencies.operationId !== input.operationId) {
    throw new TypeError("dependency commit has the wrong operation identity");
  }
  const keysJson = resourceDependencyKeysJson(input.dependencies);
  const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
  const guard = boundedGuard(`dependency_commit_${input.tokenBase}`);
  const statements: SqlStatement[] = [
    {
      sql: `INSERT INTO tf_operation_commit_guards (token, valid)
            SELECT ?, CASE WHEN (
              SELECT COUNT(*) FROM tf_resource_claims
              WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
                AND claim_key >= ? AND claim_key < ? AND state = 'committed'
            ) = json_array_length(?) AND NOT EXISTS (
              SELECT 1 FROM json_each(?) AS expected
              WHERE NOT EXISTS (
                SELECT 1 FROM tf_resource_claims AS dependency
                WHERE dependency.claim_key = CAST(expected.value AS TEXT)
                  AND dependency.owner_operation_id = ? AND dependency.tenant_id = ?
                  AND dependency.holder_uid = ? AND dependency.state = 'committed'
              )
            ) THEN 1 ELSE 0 END`,
      params: [
        guard,
        input.operationId,
        input.tenantId,
        input.resourceUid,
        dependencyStart,
        dependencyEnd,
        keysJson,
        keysJson,
        input.operationId,
        input.tenantId,
        input.resourceUid,
      ],
    },
  ];
  return {
    statements,
    cleanup: [{ sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?", params: [guard] }],
  };
}

function resourceDependencyCommitStatements(input: {
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly operationId: string;
  readonly mutation: ResourceMutationCommit;
  readonly timestamp: number;
}): readonly SqlStatement[] {
  const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
  if (input.mutation.kind === "delete") {
    return [
      {
        sql: `DELETE FROM tf_resource_claims
              WHERE tenant_id = ? AND holder_uid = ?
                AND claim_key >= ? AND claim_key < ?`,
        params: [input.tenantId, input.resourceUid, dependencyStart, dependencyEnd],
      },
    ];
  }
  if (!input.mutation.dependencySet) return [];
  return [
    {
      sql: `UPDATE tf_resource_claims
            SET state = 'committed', expires_at = NULL, updated_at = ?
            WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
              AND claim_key >= ? AND claim_key < ?`,
      params: [
        input.timestamp,
        input.operationId,
        input.tenantId,
        input.resourceUid,
        dependencyStart,
        dependencyEnd,
      ],
    },
    {
      // Obsolete committed edges remain live until this same Resource commit,
      // then disappear atomically with the replacement relation set.
      sql: `DELETE FROM tf_resource_claims
            WHERE tenant_id = ? AND holder_uid = ?
              AND claim_key >= ? AND claim_key < ?
              AND owner_operation_id <> ?`,
      params: [
        input.tenantId,
        input.resourceUid,
        dependencyStart,
        dependencyEnd,
        input.operationId,
      ],
    },
  ];
}

function claimCommitStatements(
  operation: {
    readonly id: string;
    readonly tenantId: string;
    readonly resourceUid: string;
  },
  claimKeys: readonly string[],
  timestamp: number,
): readonly SqlStatement[] {
  const statements: SqlStatement[] = [];
  const [dependencyStart, dependencyEnd] = resourceDependencyClaimRange();
  if (claimKeys.length > 0) {
    const placeholders = claimKeys.map(() => "?").join(", ");
    statements.push({
      sql: `UPDATE tf_resource_claims
            SET state = 'committed', expires_at = NULL, updated_at = ?
            WHERE owner_operation_id = ? AND tenant_id = ? AND holder_uid = ?
              AND claim_key IN (${placeholders})`,
      params: [timestamp, operation.id, operation.tenantId, operation.resourceUid, ...claimKeys],
    });
    statements.push({
      sql: `DELETE FROM tf_resource_claims
            WHERE tenant_id = ? AND holder_uid = ?
              AND NOT (claim_key >= ? AND claim_key < ?)
              AND claim_key NOT IN (${placeholders})`,
      params: [
        operation.tenantId,
        operation.resourceUid,
        dependencyStart,
        dependencyEnd,
        ...claimKeys,
      ],
    });
  } else {
    statements.push({
      sql: `DELETE FROM tf_resource_claims
            WHERE NOT (claim_key >= ? AND claim_key < ?)
              AND ((tenant_id = ? AND holder_uid = ?) OR
                   (owner_operation_id = ? AND state = 'reserved'))`,
      params: [
        dependencyStart,
        dependencyEnd,
        operation.tenantId,
        operation.resourceUid,
        operation.id,
      ],
    });
  }
  return statements;
}

function resourceListing(row: Row): ResourceListing {
  return {
    space: text(row.space),
    apiVersion: text(row.api_version),
    kind: text(row.kind),
    name: text(row.name),
    uid: text(row.uid),
    generation: text(row.generation),
    revision: text(row.revision),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    resource: JSON.parse(text(row.resource_json)) as TakoformStoredResource,
  };
}

function snapshotResourceListing(row: Row, prefix: "source" | "target"): ResourceListing | null {
  const value = (column: string): unknown => row[`${prefix}_${column}`];
  const space = value("space");
  const apiVersion = value("api_version");
  const kind = value("kind");
  const name = value("name");
  const uid = value("uid");
  const generation = value("generation");
  const revision = value("revision");
  const updatedAt = value("updated_at");
  const resourceJson = value("resource_json");
  if (
    typeof space !== "string" ||
    typeof apiVersion !== "string" ||
    typeof kind !== "string" ||
    typeof name !== "string" ||
    typeof uid !== "string" ||
    typeof generation !== "string" ||
    typeof revision !== "string" ||
    typeof updatedAt !== "number" ||
    !Number.isSafeInteger(updatedAt) ||
    updatedAt < 0 ||
    typeof resourceJson !== "string"
  ) {
    return null;
  }
  const timestamp = new Date(updatedAt);
  if (!Number.isFinite(timestamp.getTime())) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(resourceJson) as unknown;
  } catch {
    return null;
  }
  if (!recordValue(parsed)) return null;
  if (parsed.apiVersion !== apiVersion || parsed.kind !== kind) return null;
  const metadata = parsed.metadata;
  if (
    !recordValue(metadata) ||
    metadata.name !== name ||
    metadata.space !== space ||
    metadata.uid !== uid ||
    metadata.generation !== generation ||
    metadata.revision !== revision
  ) {
    return null;
  }
  const form = parsed.form;
  const formRef = recordValue(form) ? snapshotFormRef(form.formRef) : null;
  if (!formRef || formRef.apiVersion !== apiVersion || formRef.kind !== kind) return null;
  const resource = parsed as unknown as TakoformStoredResource;
  return {
    space,
    apiVersion,
    kind,
    name,
    uid,
    generation,
    revision,
    updatedAt: timestamp.toISOString(),
    resource,
  };
}

function liveSnapshotAttestation(
  row: Row,
  prefix: "source" | "target",
  tenantId: string,
  listing: ResourceListing,
): boolean {
  const value = (column: string): unknown => row[`${prefix}_attestation_${column}`];
  if (
    value("state") !== "live" ||
    value("tenant_id") !== tenantId ||
    value("resource_uid") !== listing.uid ||
    value("space") !== listing.space ||
    value("api_version") !== listing.apiVersion ||
    value("kind") !== listing.kind ||
    value("name") !== listing.name
  ) {
    return false;
  }
  const formRef = snapshotFormRefFromJson(value("form_ref_json"));
  return formRef !== null && sameSnapshotFormRef(formRef, listing.resource.form.formRef);
}

function snapshotRelations(value: unknown): readonly TakoformStoredRelation[] | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const relations: TakoformStoredRelation[] = [];
  for (const candidate of parsed) {
    if (!recordValue(candidate)) return null;
    if (
      typeof candidate.pointer !== "string" ||
      typeof candidate.relation !== "string" ||
      typeof candidate.targetApiVersion !== "string" ||
      typeof candidate.targetKind !== "string" ||
      typeof candidate.targetName !== "string" ||
      typeof candidate.targetUid !== "string" ||
      !snapshotFormRef(candidate.targetFormRef) ||
      ("targetRevision" in candidate && typeof candidate.targetRevision !== "string") ||
      ("bindingRef" in candidate && !snapshotBindingRef(candidate.bindingRef))
    ) {
      return null;
    }
    relations.push(candidate as unknown as TakoformStoredRelation);
  }
  return relations;
}

function snapshotFormRefFromJson(value: unknown): TakoformV1Alpha3FormRef | null {
  if (typeof value !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(value) as unknown;
  } catch {
    return null;
  }
  return snapshotFormRef(parsed);
}

function snapshotFormRef(value: unknown): TakoformV1Alpha3FormRef | null {
  if (
    !recordValue(value) ||
    Object.keys(value).sort().join("|") !== "apiVersion|definitionVersion|kind|schemaDigest" ||
    typeof value.apiVersion !== "string" ||
    value.apiVersion.length < 1 ||
    value.apiVersion.length > 320 ||
    typeof value.kind !== "string" ||
    value.kind.length < 1 ||
    value.kind.length > 128 ||
    typeof value.definitionVersion !== "string" ||
    value.definitionVersion.length < 1 ||
    value.definitionVersion.length > 128 ||
    !isDigest(value.schemaDigest)
  ) {
    return null;
  }
  return {
    apiVersion: value.apiVersion,
    kind: value.kind,
    definitionVersion: value.definitionVersion,
    schemaDigest: value.schemaDigest,
  };
}

function snapshotBindingRef(value: unknown): boolean {
  if (!recordValue(value)) return false;
  return (
    (value.apiVersion === "bindings.takoform.com/v1alpha1" ||
      value.apiVersion === "bindings.takoform.com/v1alpha2") &&
    typeof value.name === "string" &&
    typeof value.version === "string" &&
    isDigest(value.schemaDigest)
  );
}

function sameSnapshotFormRef(
  left: TakoformV1Alpha3FormRef,
  right: TakoformV1Alpha3FormRef,
): boolean {
  return (
    left.apiVersion === right.apiVersion &&
    left.kind === right.kind &&
    left.definitionVersion === right.definitionVersion &&
    left.schemaDigest === right.schemaDigest
  );
}

function resourceDeletionTombstone(row: Row): ResourceDeletionTombstone {
  const formRef = resourceExecutionFormRef(row.form_ref_json);
  const effectsValue = JSON.parse(text(row.effects_json)) as unknown;
  const apiVersion = text(row.api_version);
  const kind = text(row.kind);
  if (!Array.isArray(effectsValue) || formRef.apiVersion !== apiVersion || formRef.kind !== kind) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const effects = effectsValue.map(resourceDeletionEffect);
  const state = text(row.state);
  if (state !== "live" && state !== "pending" && state !== "closed" && state !== "cancelled") {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const closureFence = row.closure_fence;
  if (typeof closureFence !== "number" || !Number.isSafeInteger(closureFence)) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const evidence =
    typeof row.evidence_json === "string" ? (JSON.parse(row.evidence_json) as unknown) : undefined;
  if (evidence !== undefined && !recordValue(evidence)) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const evidenceRef = row.evidence_ref;
  if (evidenceRef !== null && !isDigest(evidenceRef)) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const evidenceEffectDigest = row.evidence_effect_digest;
  if (evidenceEffectDigest !== null && !isDigest(evidenceEffectDigest)) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const evidenceCheckedAt = row.evidence_checked_at;
  if (
    evidenceCheckedAt !== null &&
    (typeof evidenceCheckedAt !== "number" || !Number.isSafeInteger(evidenceCheckedAt))
  ) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const evidenceStatus = row.evidence_status;
  if (
    evidenceStatus !== null &&
    evidenceStatus !== "absent" &&
    evidenceStatus !== "present" &&
    evidenceStatus !== "indeterminate"
  ) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  return {
    tenantId: text(row.tenant_id),
    resourceUid: text(row.resource_uid),
    address: {
      tenantId: text(row.tenant_id),
      space: text(row.space),
      apiVersion,
      kind,
      name: text(row.name),
    },
    formRef,
    state,
    closureFence,
    effects,
    ...(evidence ? { evidenceJson: evidence as JsonObject } : {}),
    ...(typeof evidenceRef === "string" ? { evidenceRef } : {}),
    ...(typeof evidenceEffectDigest === "string" ? { evidenceEffectDigest } : {}),
    ...(typeof evidenceCheckedAt === "number"
      ? { evidenceCheckedAt: new Date(evidenceCheckedAt).toISOString() }
      : {}),
    ...(evidenceStatus ? { evidenceStatus } : {}),
    createdAt: new Date(integerColumn(row.created_at)).toISOString(),
    updatedAt: new Date(integerColumn(row.updated_at)).toISOString(),
  };
}

function resourceDeletionEffect(value: unknown): ResourceDeletionEffect {
  if (!recordValue(value) || typeof value.operationId !== "string") {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const phase = value.phase;
  if (
    phase !== "planned" &&
    phase !== "dispatched" &&
    phase !== "succeeded" &&
    phase !== "cancelled"
  ) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const kind = value.kind;
  if (
    kind !== undefined &&
    kind !== "apply" &&
    kind !== "import" &&
    kind !== "provision" &&
    kind !== "transfer-export" &&
    kind !== "transfer-import" &&
    kind !== "verify" &&
    kind !== "cancel-delete" &&
    kind !== "delete"
  ) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const operationMode = value.operationMode;
  if (operationMode !== undefined && operationMode !== "initial" && operationMode !== "recovery") {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const providerPackRef = value.providerPackRef;
  const providerInstallationRef = value.providerInstallationRef;
  const nativeId = value.nativeId;
  const target = value.target;
  const disposition = value.disposition;
  if (
    (providerPackRef !== undefined && typeof providerPackRef !== "string") ||
    (providerInstallationRef !== undefined && typeof providerInstallationRef !== "string") ||
    (nativeId !== undefined && typeof nativeId !== "string") ||
    (target !== undefined && !recordValue(target)) ||
    (disposition !== undefined && disposition !== "deleted" && disposition !== "retained")
  ) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  return {
    ...(typeof value.eventId === "string" ? { eventId: value.eventId } : {}),
    operationId: value.operationId,
    ...(kind ? { kind } : {}),
    phase,
    ...(operationMode ? { operationMode } : {}),
    ...(typeof providerPackRef === "string" ? { providerPackRef } : {}),
    ...(typeof providerInstallationRef === "string" ? { providerInstallationRef } : {}),
    ...(typeof nativeId === "string" ? { nativeId } : {}),
    ...(recordValue(target) ? { target: target as JsonObject } : {}),
    ...(disposition === "deleted" || disposition === "retained" ? { disposition } : {}),
  };
}

function validResourceEffectInput(input: {
  readonly tenantId: string;
  readonly resourceUid: string;
  readonly effectId: string;
  readonly kind: ResourceEffectKind;
  readonly phase: ResourceDeletionEffectPhase;
  readonly operationMode: "initial" | "recovery";
  readonly providerPackRef?: string;
  readonly providerInstallationRef?: string;
  readonly nativeId?: string;
  readonly target?: JsonObject;
}): void {
  if (
    input.tenantId.length < 1 ||
    input.tenantId.length > 255 ||
    input.resourceUid.length < 3 ||
    input.resourceUid.length > 128 ||
    input.effectId.length < 3 ||
    input.effectId.length > 255
  ) {
    throw new TakoformHostError("invalid_argument", 400);
  }
  if (input.providerPackRef !== undefined && input.providerPackRef.length > 255) {
    throw new TakoformHostError("invalid_argument", 400);
  }
  if (input.providerInstallationRef !== undefined && input.providerInstallationRef.length > 255) {
    throw new TakoformHostError("invalid_argument", 400);
  }
  if (input.nativeId !== undefined && (input.nativeId.length < 1 || input.nativeId.length > 4096)) {
    throw new TakoformHostError("invalid_argument", 400);
  }
  if (input.target !== undefined) {
    let encoded: string;
    try {
      encoded = canonicalJson(input.target);
    } catch {
      throw new TakoformHostError("invalid_argument", 400);
    }
    if (encoded.length < 2 || encoded.length > 1_048_576) {
      throw new TakoformHostError("invalid_argument", 400);
    }
    const forbidden = /(?:secret|token|password|credential|private[_-]?key|authorization)/iu;
    const containsSecretKey = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.some(containsSecretKey);
      if (!recordValue(value)) return false;
      return Object.entries(value).some(
        ([key, child]) => forbidden.test(key) || containsSecretKey(child),
      );
    };
    if (containsSecretKey(input.target)) throw new TakoformHostError("invalid_argument", 400);
  }
}

function resourceProviderEffect(row: Row): ResourceDeletionEffect {
  const phase = text(row.phase);
  if (
    phase !== "planned" &&
    phase !== "dispatched" &&
    phase !== "succeeded" &&
    phase !== "cancelled"
  ) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const operationMode = text(row.operation_mode);
  if (operationMode !== "initial" && operationMode !== "recovery") {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const kind = text(row.effect_kind);
  if (
    kind !== "apply" &&
    kind !== "import" &&
    kind !== "provision" &&
    kind !== "transfer-export" &&
    kind !== "transfer-import" &&
    kind !== "verify" &&
    kind !== "cancel-delete" &&
    kind !== "delete"
  ) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  return {
    eventId: text(row.event_id),
    operationId: text(row.effect_id),
    kind,
    phase,
    operationMode,
    ...(typeof row.provider_pack_ref === "string"
      ? { providerPackRef: row.provider_pack_ref }
      : {}),
    ...(typeof row.provider_installation_ref === "string"
      ? { providerInstallationRef: row.provider_installation_ref }
      : {}),
    ...(typeof row.native_id === "string" ? { nativeId: row.native_id } : {}),
    ...(typeof row.target_json === "string"
      ? (() => {
          try {
            const parsed = JSON.parse(row.target_json) as unknown;
            if (!recordValue(parsed)) throw new Error("invalid target descriptor");
            return { target: parsed as JsonObject };
          } catch {
            throw new TakoformHostError("backend_unavailable", 503);
          }
        })()
      : {}),
  };
}

function recordValue(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function integerColumn(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  return value;
}

function positiveIntegerColumn(value: unknown): number {
  const parsed = integerColumn(value);
  if (parsed < 1) throw new TakoformHostError("backend_unavailable", 503);
  return parsed;
}

function resourceExecutionCommit(row: Row): ResourceExecutionCommit {
  const action = text(row.action);
  if (action !== "create" && action !== "update" && action !== "delete") {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  const committedAt = integerColumn(row.committed_at);
  const timestamp = new Date(committedAt);
  if (!Number.isFinite(timestamp.getTime())) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  return {
    sequence: positiveIntegerColumn(row.sequence),
    operationId: text(row.operation_id),
    action,
    outcome: "committed",
    resourceVersion: {
      generation: numericTextColumn(row.resource_generation),
      revision: numericTextColumn(row.resource_revision),
    },
    committedAt: timestamp.toISOString(),
  };
}

function resourceExecutionFormRef(value: unknown): TakoformV1Alpha3FormRef {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(value)) as unknown;
  } catch {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  if (
    !recordValue(parsed) ||
    Object.keys(parsed).sort().join("|") !== "apiVersion|definitionVersion|kind|schemaDigest" ||
    typeof parsed.apiVersion !== "string" ||
    parsed.apiVersion.length < 1 ||
    parsed.apiVersion.length > 320 ||
    typeof parsed.kind !== "string" ||
    parsed.kind.length < 1 ||
    parsed.kind.length > 128 ||
    typeof parsed.definitionVersion !== "string" ||
    parsed.definitionVersion.length < 1 ||
    parsed.definitionVersion.length > 128 ||
    !isDigest(parsed.schemaDigest)
  ) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  return {
    apiVersion: parsed.apiVersion,
    kind: parsed.kind,
    definitionVersion: parsed.definitionVersion,
    schemaDigest: parsed.schemaDigest,
  };
}

function numericTextColumn(value: unknown): string {
  const parsed = text(value);
  if (!/^[0-9]+$/u.test(parsed)) {
    throw new TakoformHostError("backend_unavailable", 503);
  }
  return parsed;
}

interface ResourceExecutionEvidenceCursor {
  readonly organizationId: string;
  readonly resourceUid: string;
  readonly snapshotFence: number;
  readonly beforeSequence: number;
}

function encodeResourceExecutionEvidenceCursor(cursor: ResourceExecutionEvidenceCursor): string {
  const bytes = new TextEncoder().encode(
    JSON.stringify({
      kind: "takoserver.resource-execution-evidence-cursor/v1",
      organizationId: cursor.organizationId,
      resourceUid: cursor.resourceUid,
      snapshotFence: cursor.snapshotFence,
      beforeSequence: cursor.beforeSequence,
    }),
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function decodeResourceExecutionEvidenceCursor(
  value: string | undefined,
): ResourceExecutionEvidenceCursor | null {
  if (value === undefined) return null;
  if (value.length < 1 || value.length > 1_024 || !/^[A-Za-z0-9_-]+$/u.test(value)) {
    throw new TakoformHostError("invalid_argument", 400);
  }
  try {
    const base64 = value.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    const parsed = JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    ) as unknown;
    if (
      !recordValue(parsed) ||
      JSON.stringify(Object.keys(parsed).sort()) !==
        JSON.stringify([
          "beforeSequence",
          "kind",
          "organizationId",
          "resourceUid",
          "snapshotFence",
        ]) ||
      parsed.kind !== "takoserver.resource-execution-evidence-cursor/v1" ||
      typeof parsed.organizationId !== "string" ||
      parsed.organizationId.length < 1 ||
      parsed.organizationId.length > 255 ||
      typeof parsed.resourceUid !== "string" ||
      parsed.resourceUid.length < 3 ||
      parsed.resourceUid.length > 128 ||
      typeof parsed.snapshotFence !== "number" ||
      !Number.isSafeInteger(parsed.snapshotFence) ||
      parsed.snapshotFence < 1 ||
      typeof parsed.beforeSequence !== "number" ||
      !Number.isSafeInteger(parsed.beforeSequence) ||
      parsed.beforeSequence < 2
    ) {
      throw new Error("invalid cursor");
    }
    return {
      organizationId: parsed.organizationId,
      resourceUid: parsed.resourceUid,
      snapshotFence: parsed.snapshotFence,
      beforeSequence: parsed.beforeSequence,
    };
  } catch {
    throw new TakoformHostError("invalid_argument", 400);
  }
}

function text(value: unknown): string {
  if (typeof value !== "string") throw new TypeError("expected a text column");
  return value;
}

/**
 * Page cursors carry the sort key, not an offset.
 *
 * An opaque string keeps a caller from treating it as a position they may
 * compute, and an unreadable one is ignored, which reads as "start from the
 * beginning" rather than an error a person can do nothing about.
 */
function encodeCursor(seek: { readonly updatedAt: number; readonly uid: string }): string {
  return btoa(`${seek.updatedAt}:${seek.uid}`)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

function decodeCursor(
  cursor: string | undefined,
): { readonly updatedAt: number; readonly uid: string } | null {
  if (cursor === undefined || cursor === "") return null;
  let decoded: string;
  try {
    decoded = atob(cursor.replaceAll("-", "+").replaceAll("_", "/"));
  } catch {
    return null;
  }
  const separator = decoded.indexOf(":");
  const updatedAt = Number(decoded.slice(0, separator));
  const uid = decoded.slice(separator + 1);
  if (separator < 1 || !Number.isSafeInteger(updatedAt) || uid === "") return null;
  return { updatedAt, uid };
}
