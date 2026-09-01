import { canonicalDigest, canonicalJson } from "../json.ts";
import type { Clock, JsonObject, Row, Sql, SqlParam, SqlStatement } from "../ports.ts";
import { SqlError } from "../ports.ts";
import type { TakoformAuthorityFence } from "./host-authority.ts";
import { OPERATION_TTL_MILLISECONDS, REPLAY_TTL_MILLISECONDS, SWEEP_ROW_LIMIT } from "./limits.ts";
import type { TakoformStoredRelation } from "./relations.ts";
import {
  type TakoformDriverReceipt,
  TakoformHostError,
  type TakoformStoredResource,
  type TakoformV1Alpha3FormRef,
} from "./types.ts";

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
  /** An identity-preserving no-op must leave the live Resource's committed claims untouched. */
  readonly preserveClaims?: true;
  readonly authorityFence?: TakoformAuthorityFence;
}

export interface DeferredResourceCommit extends ResourceMutationCommit {
  readonly terminalJson: string;
}

export interface ProviderMutationSaga {
  readonly operationId: string;
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

export type ProviderMutationExecution =
  | {
      readonly kind: "acquired";
      readonly mode: "initial" | "recovery";
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
  markProviderMutationDispatch(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
  /** Retains an accepted provider handle when completion was not observed. */
  recordProviderMutationOutcome(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
    readonly outcome: "running" | "indeterminate";
    readonly providerHandle?: string;
  }): Promise<boolean>;
  /** Terminalizes a failure proven to have happened before provider dispatch. */
  settleProviderMutationPreconditionFailure(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
  }): Promise<boolean>;
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
  settleDefinitiveProviderImportConflict(input: {
    readonly tenantId: string;
    readonly operationId: string;
    readonly replayKey: string;
    readonly resourceUid: string;
    readonly leaseToken: string;
    readonly outcome: "import_conflict";
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

  /** One UID-scoped snapshot used by authorities that must bind Resource and relations together. */
  resourceWithRelationsByUid(tenantId: string, uid: string): Promise<ResourceWithRelations | null>;

  /** The most recent settled operations for a tenant, newest first. */
  listOperations(tenantId: string, limit: number): Promise<readonly OperationListing[]>;

  readReplay(key: string): Promise<StoredReplay | null>;
  putReplay(key: string, replay: StoredReplay): Promise<void>;
  deleteReplay(key: string): Promise<void>;
}

export function createTakoformStore(sql: Sql, clock: Clock): TakoformStore {
  const now = (): number => clock().getTime();

  const readDeferredBy = async (
    column: "replay_key",
    value: string,
  ): Promise<DeferredOperationRecord | null> => {
    const rows = await sql.query(
      `SELECT * FROM tf_deferred_operations WHERE ${column} = ? AND expires_at > ?`,
      [value, now()],
    );
    return rows[0] ? deferredOperation(rows[0]) : null;
  };

  const commitFenceError = async (
    operation: DeferredOperationRecord,
    leaseToken: string,
  ): Promise<TakoformHostError> => {
    const liveOperation = await sql.query(
      `SELECT phase, lease_token FROM tf_deferred_operations
       WHERE id = ? AND tenant_id = ? AND principal_id = ? AND expires_at > ?`,
      [operation.id, operation.tenantId, operation.principalId, now()],
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
    if (row.revision !== operation.acceptedRevision) {
      return new TakoformHostError("revision_conflict", 412);
    }
    return new TakoformHostError("resource_busy", 409);
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
      await sql.run(
        `INSERT OR IGNORE INTO tf_resource_deletion_attestations
           (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
            state, closure_fence, effects_json, evidence_json, evidence_ref,
            evidence_effect_digest, evidence_checked_at, evidence_status,
            created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', 1, '[]', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
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
      const existing = rows[0] ? resourceDeletionTombstone(rows[0]) : null;
      if (
        !existing ||
        rows.length !== 1 ||
        existing.address.space !== input.address.space ||
        existing.address.apiVersion !== input.address.apiVersion ||
        existing.address.kind !== input.address.kind ||
        existing.address.name !== input.address.name ||
        canonicalJson(existing.formRef) !== canonicalJson(input.formRef)
      ) {
        throw new TakoformHostError("resource_busy", 409);
      }
      if (existing.state === "live" || existing.state === "pending") {
        await sql.run(
          `UPDATE tf_resource_deletion_attestations
           SET state = 'pending', updated_at = ?
           WHERE tenant_id = ? AND resource_uid = ? AND state = 'live'
             AND NOT EXISTS (
               SELECT 1 FROM worker_runtime_input_preparations AS runtime_input
               WHERE runtime_input.organization_id = ?
                 AND runtime_input.worker_resource_uid = ?
                 AND runtime_input.state = 'claimed'
                 AND runtime_input.claim_expires_at > ?
             )`,
          [
            timestamp,
            input.tenantId,
            input.resourceUid,
            input.tenantId,
            input.resourceUid,
            timestamp,
          ],
        );
      }
      const armedRows = await sql.query(
        `SELECT state FROM tf_resource_deletion_attestations
         WHERE tenant_id = ? AND resource_uid = ? LIMIT 2`,
        [input.tenantId, input.resourceUid],
      );
      if (armedRows.length !== 1 || text(armedRows[0]?.state) !== "pending") {
        throw new TakoformHostError("dependency_in_use", 409);
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
      await sql.run(
        `DELETE FROM tf_provider_mutation_sagas WHERE rowid IN (
           SELECT rowid FROM tf_provider_mutation_sagas
           WHERE phase = 'planned' AND expires_at <= ? ORDER BY expires_at LIMIT ?
         )`,
        [timestamp, SWEEP_ROW_LIMIT],
      );
      await sql.run(
        `INSERT OR IGNORE INTO tf_provider_mutation_sagas
           (operation_id, replay_key, tenant_id, fingerprint, resource_uid,
            target_space, target_api_version, target_kind, target_name,
            accepted_uid, accepted_generation, accepted_revision, phase,
            receipt_json, authority_head_digest, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', NULL, ?, ?, ?, ?)`,
        [
          record.operationId,
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
          timestamp + OPERATION_TTL_MILLISECONDS,
        ],
      );
      const rows = await sql.query(
        `SELECT * FROM tf_provider_mutation_sagas
         WHERE (
             replay_key = ? OR
             (tenant_id = ? AND target_space = ? AND target_api_version = ?
               AND target_kind = ? AND target_name = ?)
           )
           AND (phase = 'executed' OR expires_at > ?) LIMIT 3`,
        [
          record.replayKey,
          record.tenantId,
          record.target.space,
          record.target.apiVersion,
          record.target.kind,
          record.target.name,
          timestamp,
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
        throw new TakoformHostError("resource_busy", 409);
      }
      if (stored.replayKey === record.replayKey) return stored;
      const rotated = await sql.run(
        `UPDATE tf_provider_mutation_sagas
         SET replay_key = ?, updated_at = ?
         WHERE operation_id = ? AND replay_key = ? AND tenant_id = ?
           AND fingerprint = ? AND resource_uid = ?
           AND (phase = 'executed' OR expires_at > ?)`,
        [
          record.replayKey,
          timestamp,
          stored.operationId,
          stored.replayKey,
          stored.tenantId,
          stored.fingerprint,
          stored.resourceUid,
          timestamp,
        ],
      );
      if (rotated.changes !== 1) throw new TakoformHostError("resource_busy", 409);
      return { ...stored, replayKey: record.replayKey };
    },

    async establishedProviderMutationSaga(record) {
      const rows = await sql.query(
        `SELECT * FROM tf_provider_mutation_sagas
         WHERE operation_id = ? AND tenant_id = ? AND resource_uid = ?
           AND (phase = 'executed' OR expires_at > ?) LIMIT 2`,
        [record.operationId, record.tenantId, record.resourceUid, now()],
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
        `UPDATE tf_provider_mutation_sagas
         SET execution_lease_token = ?, execution_lease_until = ?,
             updated_at = ?
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL AND expires_at > ?
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
          timestamp,
        ],
      );
      if (initial.changes === 1) return { kind: "acquired", mode: "initial" };

      const recovery = await sql.run(
        `UPDATE tf_provider_mutation_sagas
         SET execution_lease_token = ?, execution_lease_until = ?, updated_at = ?
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL AND expires_at > ?
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
          timestamp,
        ],
      );
      if (recovery.changes === 1) {
        const stateRows = await sql.query(
          `SELECT provider_handle, provider_outcome
           FROM tf_provider_mutation_sagas
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
        `SELECT phase, receipt_json FROM tf_provider_mutation_sagas
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND (phase = 'executed' OR expires_at > ?) LIMIT 2`,
        [input.tenantId, input.operationId, input.resourceUid, timestamp],
      );
      if (rows.length > 1) throw new Error("provider_mutation_saga_ambiguous");
      const row = rows[0];
      if (row?.phase === "executed") {
        return { kind: "executed", receipt: providerReceipt(row.receipt_json) };
      }
      return { kind: "busy" };
    },

    async markProviderMutationDispatch(input) {
      const timestamp = now();
      const [marked] = await sql.batch([
        {
          sql: `UPDATE tf_provider_mutation_sagas
                SET execution_started_at = ?, provider_outcome = 'running', updated_at = ?,
                    expires_at = 253402300799999
                WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
                  AND phase = 'planned' AND receipt_json IS NULL AND expires_at > ?
                  AND execution_lease_token = ? AND execution_lease_until > ?
                  AND execution_started_at IS NULL`,
          params: [
            timestamp,
            timestamp,
            input.tenantId,
            input.operationId,
            input.resourceUid,
            timestamp,
            input.leaseToken,
            timestamp,
          ],
        },
        {
          // A deferred Host command and its dispatched provider saga become
          // one non-expiring repair unit in this transactional batch. An
          // immediate (non-deferred) mutation simply matches no Host row.
          sql: `UPDATE tf_deferred_operations
                SET expires_at = 253402300799999, updated_at = ?
                WHERE id = ? AND tenant_id = ? AND resource_uid = ?
                  AND phase = 'committing'
                  AND EXISTS (
                    SELECT 1 FROM tf_provider_mutation_sagas AS saga
                    WHERE saga.operation_id = tf_deferred_operations.id
                      AND saga.tenant_id = tf_deferred_operations.tenant_id
                      AND saga.resource_uid = tf_deferred_operations.resource_uid
                      AND saga.phase = 'planned' AND saga.receipt_json IS NULL
                      AND saga.execution_started_at IS NOT NULL
                      AND saga.execution_lease_token = ?
                  )`,
          params: [
            timestamp,
            input.operationId,
            input.tenantId,
            input.resourceUid,
            input.leaseToken,
          ],
        },
      ]);
      return marked?.changes === 1;
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
        `UPDATE tf_provider_mutation_sagas
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
      const settled = await sql.run(
        `DELETE FROM tf_provider_mutation_sagas
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL
           AND provider_handle IS NULL AND provider_outcome = 'running'
           AND execution_started_at IS NOT NULL
           AND execution_lease_token = ? AND execution_lease_until > ?`,
        [input.tenantId, input.operationId, input.resourceUid, input.leaseToken, now()],
      );
      return settled.changes === 1;
    },

    async releaseProviderMutationExecution(input) {
      const released = await sql.run(
        `UPDATE tf_provider_mutation_sagas
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
        `SELECT receipt_json FROM tf_provider_mutation_sagas
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'executed' LIMIT 2`,
        [tenantId, operationId, resourceUid],
      );
      if (rows.length > 1) throw new Error("provider_mutation_saga_ambiguous");
      return rows[0] ? providerReceipt(rows[0].receipt_json) : null;
    },

    async providerMutationPlanExists(tenantId, operationId, resourceUid) {
      const rows = await sql.query(
        `SELECT 1 AS found FROM tf_provider_mutation_sagas
         WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL AND expires_at > ? LIMIT 2`,
        [tenantId, operationId, resourceUid, now()],
      );
      if (rows.length > 1) throw new Error("provider_mutation_saga_ambiguous");
      return rows.length === 1;
    },

    async abandonProviderMutationPlan(input) {
      const removed = await sql.run(
        `DELETE FROM tf_provider_mutation_sagas
         WHERE tenant_id = ? AND operation_id = ? AND replay_key = ? AND resource_uid = ?
           AND phase = 'planned' AND receipt_json IS NULL
           AND execution_lease_token IS NULL AND execution_started_at IS NULL`,
        [input.tenantId, input.operationId, input.replayKey, input.resourceUid],
      );
      return removed.changes === 1;
    },

    async settleDefinitiveProviderImportConflict(input) {
      if (input.outcome !== "import_conflict") {
        throw new TypeError("provider import outcome must be import_conflict");
      }
      const timestamp = now();
      const removed = await sql.run(
        `DELETE FROM tf_provider_mutation_sagas
         WHERE tenant_id = ? AND operation_id = ? AND replay_key = ? AND resource_uid = ?
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
      try {
        await sql.batch([
          {
            sql: `INSERT INTO tf_operation_commit_guards (token, valid)
                  SELECT ?, CASE WHEN EXISTS (
                    SELECT 1 FROM tf_provider_mutation_sagas
                    WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
                      AND authority_head_digest IS ?
                      AND phase = 'planned' AND receipt_json IS NULL AND expires_at > ?
                      AND execution_lease_token = ? AND execution_lease_until > ?
                      AND execution_started_at IS NOT NULL
                  ) THEN 1 ELSE 0 END`,
            params: [
              guard,
              input.tenantId,
              input.operationId,
              input.resourceUid,
              input.authorityHeadDigest ?? null,
              timestamp,
              input.leaseToken,
              timestamp,
            ],
          },
          {
            sql: `UPDATE tf_provider_mutation_sagas
                  SET phase = 'executed', receipt_json = ?, updated_at = ?, expires_at = NULL,
                      execution_lease_token = NULL, execution_lease_until = NULL,
                      provider_handle = NULL, provider_outcome = 'planned'
                  WHERE tenant_id = ? AND operation_id = ? AND resource_uid = ?
                    AND authority_head_digest IS ?
                    AND phase = 'planned' AND receipt_json IS NULL AND expires_at > ?
                    AND execution_lease_token = ? AND execution_lease_until > ?
                    AND execution_started_at IS NOT NULL`,
            params: [
              serialized,
              timestamp,
              input.tenantId,
              input.operationId,
              input.resourceUid,
              input.authorityHeadDigest ?? null,
              timestamp,
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
                          AND state = 'reserved'`,
                  params: [timestamp, input.claimOwnerId, input.tenantId, input.resourceUid],
                },
                {
                  sql: `UPDATE tf_deferred_operations
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

    async holdDeferredProviderRepair(input) {
      const held = await sql.run(
        `UPDATE tf_deferred_operations
         SET lease_token = NULL, lease_until = NULL,
             expires_at = 253402300799999, updated_at = ?
         WHERE id = ? AND tenant_id = ? AND principal_id = ?
           AND phase = 'committing' AND lease_token = ?`,
        [
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
        `DELETE FROM tf_deferred_operations WHERE rowid IN (
           SELECT rowid FROM tf_deferred_operations
           WHERE expires_at <= ?
           ORDER BY expires_at LIMIT ?
         )`,
        [now(), SWEEP_ROW_LIMIT],
      );
      await sql.run(
        `INSERT OR IGNORE INTO tf_deferred_operations
           (id, tenant_id, principal_id, operation, phase, request_path, request_query,
            request_headers_json, request_body_json, fingerprint, replay_key,
            target_space, target_api_version, target_kind, target_name,
            target_form_ref_json, accepted_uid, accepted_generation, accepted_revision,
            resource_uid, worker_endpoint_origin_reservation_id, polls_remaining,
            lease_token, lease_until, terminal_json,
            committed_uid, created_at, updated_at, expires_at)
         VALUES (?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                 NULL, NULL, NULL, NULL, ?, ?, ?)`,
        [
          record.id,
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
          now() + OPERATION_TTL_MILLISECONDS,
        ],
      );
      const stored = await readDeferredBy("replay_key", record.replayKey);
      if (!stored) throw new SqlError("constraint", "deferred operation identity collision");
      return stored;
    },

    async readDeferredOperation(tenantId, principalId, id) {
      const rows = await sql.query(
        `SELECT * FROM tf_deferred_operations
         WHERE tenant_id = ? AND principal_id = ? AND id = ? AND expires_at > ?`,
        [tenantId, principalId, id, now()],
      );
      return rows[0] ? deferredOperation(rows[0]) : null;
    },

    async deferredOperationExists(id) {
      const rows = await sql.query(
        "SELECT 1 AS found FROM tf_deferred_operations WHERE id = ? AND expires_at > ? LIMIT 1",
        [id, now()],
      );
      return rows.length === 1;
    },

    async readDeferredOperationByReplay(replayKey) {
      return await readDeferredBy("replay_key", replayKey);
    },

    async retireDeferredOperation(id, replayKey) {
      const removed = await sql.run(
        `DELETE FROM tf_deferred_operations
         WHERE id = ? AND replay_key = ? AND phase IN ('succeeded', 'failed', 'cancelled')`,
        [id, replayKey],
      );
      return removed.changes === 1;
    },

    async advanceDeferredOperation(input) {
      const decremented = await sql.run(
        `UPDATE tf_deferred_operations
         SET polls_remaining = polls_remaining - 1, updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND id = ?
           AND phase = 'pending' AND polls_remaining > 1 AND expires_at > ?`,
        [now(), input.tenantId, input.principalId, input.id, now()],
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
        `UPDATE tf_deferred_operations
         SET phase = 'committing', polls_remaining = 0,
             lease_token = NULL, lease_until = NULL, updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND id = ?
           AND phase = 'pending' AND polls_remaining <= 1 AND expires_at > ?`,
        [now(), input.tenantId, input.principalId, input.id, now()],
      );
      if (armed.changes === 1) {
        return {
          operation: await this.readDeferredOperation(input.tenantId, input.principalId, input.id),
          acquired: false,
        };
      }
      const acquired = await sql.run(
        `UPDATE tf_deferred_operations
         SET lease_token = ?, lease_until = ?, updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND id = ? AND expires_at > ?
           AND phase = 'committing' AND (lease_until IS NULL OR lease_until <= ?)`,
        [
          input.leaseToken,
          input.leaseUntil,
          now(),
          input.tenantId,
          input.principalId,
          input.id,
          now(),
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
         FROM tf_deferred_operations AS operation
         INNER JOIN tf_provider_mutation_sagas AS saga
           ON saga.operation_id = operation.id
          AND saga.tenant_id = operation.tenant_id
          AND saga.resource_uid = operation.resource_uid
         WHERE operation.phase = 'committing'
           AND operation.terminal_json IS NULL
           AND operation.expires_at > ?
           AND (operation.lease_until IS NULL OR operation.lease_until <= ?)
           AND saga.phase = 'planned'
           AND saga.receipt_json IS NULL
           AND saga.execution_started_at IS NOT NULL
           AND (saga.execution_lease_until IS NULL OR saga.execution_lease_until <= ?)
         ORDER BY operation.updated_at, operation.id
         LIMIT ?`,
        [timestamp, timestamp, timestamp, limit],
      );
      return rows.map(deferredOperation);
    },

    async cancelDeferredOperation(input) {
      const cancelled = await sql.run(
        `UPDATE tf_deferred_operations
         SET phase = 'cancelled', terminal_json = ?, lease_token = NULL, lease_until = NULL,
             updated_at = ?
         WHERE tenant_id = ? AND principal_id = ? AND id = ?
           AND phase = 'pending' AND expires_at > ?`,
        [input.terminalJson, now(), input.tenantId, input.principalId, input.id, now()],
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

    async settleDeferredFailure(input) {
      const settled = await sql.run(
        `UPDATE tf_deferred_operations
         SET phase = 'failed', terminal_json = ?, lease_token = NULL, lease_until = NULL,
             updated_at = ?
         WHERE id = ? AND tenant_id = ? AND principal_id = ?
           AND phase = 'committing' AND lease_token = ? AND expires_at > ?`,
        [
          input.terminalJson,
          now(),
          input.operation.id,
          input.operation.tenantId,
          input.operation.principalId,
          input.leaseToken,
          now(),
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
      const guard = boundedGuard(`guard_${operation.id}_${leaseToken}`);
      const target = operation.target;
      const targetKey = [
        operation.tenantId,
        target.space,
        target.apiVersion,
        target.kind,
        target.name,
      ];
      const operationFence = `EXISTS (
        SELECT 1 FROM tf_deferred_operations
        WHERE id = ? AND tenant_id = ? AND principal_id = ?
          AND phase = 'committing' AND lease_token = ? AND expires_at > ?
      )`;
      const resourceFence =
        operation.acceptedUid === undefined
          ? `NOT EXISTS (
              SELECT 1 FROM tf_resources
              WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
            )`
          : `EXISTS (
              SELECT 1 FROM tf_resources
              WHERE tenant_id = ? AND space = ? AND api_version = ? AND kind = ? AND name = ?
                AND uid = ? AND generation = ? AND revision = ?
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
              operation.acceptedRevision ?? "",
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
      const deployment = deploymentMutationSql(mutation.providerReceipt, now());
      const providerEffect = providerEffectSql(mutation, now());
      const deletionFence = deletionTombstoneFence(mutation, operation.id);
      const authority = mutation.authorityFence
        ? await authorityFenceSql(mutation.authorityFence)
        : { sql: "1 = 1", params: [] as readonly SqlParam[] };
      const providerSagaFence = receiptJson
        ? `EXISTS (
        SELECT 1 FROM tf_provider_mutation_sagas
        WHERE operation_id = ? AND replay_key = ? AND tenant_id = ?
          AND fingerprint = ? AND resource_uid = ? AND phase = 'executed'
          AND receipt_json = ?
      )`
        : "1 = 1";
      const statements: SqlStatement[] = [
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
            now(),
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
                  receiptJson,
                ]
              : []),
            ...deployment.fenceParams,
            ...deletionFence.params,
            ...providerEffect.fenceParams,
            ...authority.params,
          ],
        },
        ...deployment.statements,
        ...providerEffect.statements,
        ...deletionTombstoneStatements(mutation, now()),
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
              now(),
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
              now(),
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
                  AND uid = ? AND generation = ? AND revision = ?`,
          params: [
            ...targetKey,
            operation.acceptedUid ?? "",
            operation.acceptedGeneration ?? "",
            operation.acceptedRevision ?? "",
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
            now() + REPLAY_TTL_MILLISECONDS,
          ],
        },
        ...(mutation.preserveClaims
          ? []
          : claimCommitStatements({ ...operation, id: leaseToken }, claimKeys, now())),
        {
          sql: `UPDATE tf_deferred_operations
                SET phase = 'succeeded', terminal_json = ?, committed_uid = ?,
                    lease_token = NULL, lease_until = NULL, updated_at = ?, expires_at = ?
                WHERE id = ? AND tenant_id = ? AND principal_id = ?
                  AND phase = 'committing' AND lease_token = ?`,
          params: [
            mutation.terminalJson,
            mutation.resource?.metadata.uid ?? null,
            now(),
            now() + OPERATION_TTL_MILLISECONDS,
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
            now() + OPERATION_TTL_MILLISECONDS,
          ],
        },
        ...(receiptJson
          ? [
              {
                sql: `DELETE FROM tf_provider_mutation_sagas
                      WHERE operation_id = ? AND tenant_id = ? AND receipt_json = ?`,
                params: [operation.id, operation.tenantId, receiptJson],
              },
            ]
          : []),
        {
          sql: "DELETE FROM tf_operation_commit_guards WHERE token = ?",
          params: [guard],
        },
      );
      try {
        await sql.batch(statements);
      } catch (error) {
        if (!(error instanceof SqlError) || error.code !== "constraint") throw error;
        throw await commitFenceError(operation, leaseToken);
      }
    },

    async committedResourceClaimHolder(key) {
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
      await sql.run(
        `DELETE FROM tf_resource_claims
         WHERE owner_operation_id = ? AND state = 'reserved'`,
        [operationId],
      );
    },

    async releaseCommittedResourceClaims(tenantId, holderUid) {
      await sql.run(
        `DELETE FROM tf_resource_claims
         WHERE tenant_id = ? AND holder_uid = ? AND state = 'committed'`,
        [tenantId, holderUid],
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
    ...(providerHandle ? { providerHandle } : {}),
    ...(providerOutcome === "indeterminate" || (providerOutcome === "running" && providerHandle)
      ? { providerOutcome }
      : {}),
  };
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

function providerReceipt(value: unknown): TakoformDriverReceipt {
  if (typeof value !== "string") throw new TypeError("invalid provider mutation receipt");
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new TypeError("invalid provider mutation receipt");
  }
  return parsed as TakoformDriverReceipt;
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
  const sagaFence = receiptJson
    ? `EXISTS (
    SELECT 1 FROM tf_provider_mutation_sagas AS saga
    WHERE saga.operation_id = ? AND saga.replay_key = ? AND saga.tenant_id = ?
      AND saga.fingerprint = ? AND saga.resource_uid = ?
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
    ...deployment.statements,
    ...providerEffect.statements,
    ...deletionTombstoneStatements(mutation, input.now),
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
            sql: `DELETE FROM tf_provider_mutation_sagas
                  WHERE operation_id = ? AND tenant_id = ? AND receipt_json = ?`,
            params: [input.operationId, input.tenantId, receiptJson],
          },
        ]
      : []),
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

function boundedGuard(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/gu, "_").slice(0, 128);
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
              AND claim_key NOT IN (${placeholders})`,
      params: [operation.tenantId, operation.resourceUid, ...claimKeys],
    });
  } else {
    statements.push({
      sql: `DELETE FROM tf_resource_claims
            WHERE (tenant_id = ? AND holder_uid = ?) OR
                  (owner_operation_id = ? AND state = 'reserved')`,
      params: [operation.tenantId, operation.resourceUid, operation.id],
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

function resourceDeletionTombstone(row: Row): ResourceDeletionTombstone {
  const formRef = JSON.parse(text(row.form_ref_json)) as unknown;
  const effectsValue = JSON.parse(text(row.effects_json)) as unknown;
  if (!recordValue(formRef) || !Array.isArray(effectsValue)) {
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
      apiVersion: text(row.api_version),
      kind: text(row.kind),
      name: text(row.name),
    },
    formRef: formRef as unknown as TakoformV1Alpha3FormRef,
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
