import type { Sql } from "../ports.ts";

export type ManagedWorkerReceiptKind =
  | "worker"
  | "version"
  | "deployment"
  | "endpoint"
  | "cron"
  | "consumer"
  | "sqlite";
export type ManagedWorkerRouteKind = "host" | "worker" | "queue" | "schedule";
export type ManagedWorkerReceiptState = "pending" | "committed" | "deleting" | "deleted";

export interface ManagedWorkerReceipt {
  readonly resourceUid: string;
  readonly nativeId: string;
  readonly kind: ManagedWorkerReceiptKind;
  readonly logicalWorkerId: string;
  readonly operationId: string;
  readonly generation: number;
  readonly descriptorDigest: `sha256:${string}`;
  readonly state: ManagedWorkerReceiptState;
  readonly providerEtag?: string;
  readonly observed: Readonly<Record<string, unknown>>;
}

export interface ManagedWorkerRouteState {
  readonly kind: ManagedWorkerRouteKind;
  readonly key: string;
  readonly ownerNativeId: string;
  readonly generation: number;
  readonly operationId: string;
  readonly state: "active" | "tombstone";
  readonly value: Readonly<Record<string, unknown>>;
}

export interface ManagedWorkerScheduleReconciliation {
  readonly desiredGeneration: number;
  readonly appliedGeneration: number;
  readonly appliedDigest?: `sha256:${string}`;
  readonly reconciliationState: "idle" | "leased" | "operator_reconciliation_required";
  readonly leaseToken?: string;
  readonly leaseStartedAt?: number;
  readonly leaseUntil?: number;
  readonly ambiguousGeneration?: number;
  readonly ambiguityReason?: "lease_expired" | "mutation_indeterminate";
}

export interface ManagedWorkerScheduleSnapshot extends ManagedWorkerScheduleReconciliation {
  readonly routes: readonly ManagedWorkerRouteState[];
}

export type ManagedWorkerScheduleLeaseAcquisition =
  | {
      readonly outcome: "acquired";
      readonly state: ManagedWorkerScheduleReconciliation;
    }
  | {
      readonly outcome: "busy" | "operator_reconciliation_required" | "absent";
      readonly state?: ManagedWorkerScheduleReconciliation;
    };

export const MAX_MANAGED_WORKER_SCHEDULE_LEASE_MS = 60_000;

export type ManagedWorkerRoutePredecessor =
  | { readonly kind: "absent" }
  | { readonly kind: "exact"; readonly route: ManagedWorkerRouteState };

export type ManagedWorkerReceiptClaim =
  | {
      readonly outcome: "claimed" | "pending" | "committed";
      readonly receipt: ManagedWorkerReceipt;
    }
  | { readonly outcome: "conflict" };

interface StoredReceipt extends ManagedWorkerReceipt {
  readonly previous: ManagedWorkerReceipt | null;
}

/** Durable managed-worker authority exists, but its stored closure is invalid. */
export class ManagedWorkerStateCorruptionError extends Error {
  constructor(readonly authority: "receipt" | "route" | "schedule") {
    super(`the managed Worker ${authority} authority is malformed`);
    this.name = "ManagedWorkerStateCorruptionError";
  }
}

/**
 * SQL-only durable authority for managed Worker resources and gateway routes.
 * Every mutable command repeats an exact predecessor in one guarded SQL
 * statement. Deleted resource UIDs remain as tombstones, so delayed commands
 * cannot resurrect an old attachment after ownership moved to a replacement.
 */
export class ManagedWorkerState {
  constructor(
    readonly providerId: string,
    readonly sql: Sql,
  ) {
    if (!nativeToken(providerId)) throw new TypeError("invalid managed Worker provider id");
  }

  async claimReceipt(input: {
    readonly resourceUid: string;
    readonly nativeId: string;
    readonly kind: ManagedWorkerReceiptKind;
    readonly logicalWorkerId: string;
    readonly operationId: string;
    readonly descriptorDigest: `sha256:${string}`;
    readonly observed?: Readonly<Record<string, unknown>>;
    /** Required for an update; absent means the first incarnation. */
    readonly predecessor?: {
      readonly nativeId: string;
      readonly descriptorDigest?: `sha256:${string}`;
    };
  }): Promise<ManagedWorkerReceiptClaim> {
    assertReceiptInput(input);
    const current = await this.#receipt(input.resourceUid);
    if (current && sameClaim(current, input)) {
      if (current.state === "deleted" || current.state === "deleting") {
        return { outcome: "conflict" };
      }
      return {
        outcome: current.state === "committed" ? "committed" : "pending",
        receipt: withoutPrevious(current),
      };
    }

    if (!current) {
      if (input.predecessor) return { outcome: "conflict" };
      const write = await this.sql.run(
        `INSERT INTO cloudflare_managed_worker_receipts (
           provider_id, resource_uid, native_id, kind, logical_worker_id,
           operation_id, generation, descriptor_digest, state, observed_json
         ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, 'pending', ?)
         ON CONFLICT DO NOTHING`,
        [
          this.providerId,
          input.resourceUid,
          input.nativeId,
          input.kind,
          input.logicalWorkerId,
          input.operationId,
          input.descriptorDigest,
          canonicalJson(input.observed ?? {}),
        ],
      );
      if (write.changes !== 1) return { outcome: "conflict" };
      const claimed = await this.#receipt(input.resourceUid);
      return claimed && sameClaim(claimed, input) && claimed.state === "pending"
        ? { outcome: "claimed", receipt: withoutPrevious(claimed) }
        : { outcome: "conflict" };
    }

    if (
      !input.predecessor ||
      current.state !== "committed" ||
      current.nativeId !== input.predecessor.nativeId ||
      (input.predecessor.descriptorDigest !== undefined &&
        current.descriptorDigest !== input.predecessor.descriptorDigest) ||
      current.kind !== input.kind ||
      current.logicalWorkerId !== input.logicalWorkerId
    ) {
      return { outcome: "conflict" };
    }

    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_receipts
       SET native_id = ?, operation_id = ?, generation = generation + 1,
           descriptor_digest = ?, state = 'pending', provider_etag = NULL,
           observed_json = ?, previous_json = ?
       WHERE provider_id = ? AND resource_uid = ? AND native_id = ?
         AND kind = ? AND logical_worker_id = ? AND operation_id = ?
         AND generation = ? AND descriptor_digest = ? AND state = 'committed'
         AND observed_json = ? AND provider_etag IS ?`,
      [
        input.nativeId,
        input.operationId,
        input.descriptorDigest,
        canonicalJson(input.observed ?? {}),
        serializeReceipt(current),
        this.providerId,
        input.resourceUid,
        current.nativeId,
        current.kind,
        current.logicalWorkerId,
        current.operationId,
        current.generation,
        current.descriptorDigest,
        canonicalJson(current.observed),
        current.providerEtag ?? null,
      ],
    );
    if (write.changes !== 1) return { outcome: "conflict" };
    const claimed = await this.#receipt(input.resourceUid);
    return claimed && sameClaim(claimed, input) && claimed.state === "pending"
      ? { outcome: "claimed", receipt: withoutPrevious(claimed) }
      : { outcome: "conflict" };
  }

  async receiptByResourceUid(resourceUid: string): Promise<ManagedWorkerReceipt | null> {
    const receipt = await this.#receipt(resourceUid);
    return receipt ? withoutPrevious(receipt) : null;
  }

  async receiptByNativeId(nativeId: string): Promise<ManagedWorkerReceipt | null> {
    const rows = await this.sql.query(`${RECEIPT_SELECT} WHERE provider_id = ? AND native_id = ?`, [
      this.providerId,
      nativeId,
    ]);
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ManagedWorkerStateCorruptionError("receipt");
    const receipt = parseReceipt(rows[0]);
    if (!receipt) throw new ManagedWorkerStateCorruptionError("receipt");
    return receipt ? withoutPrevious(receipt) : null;
  }

  async commitReceipt(input: {
    readonly resourceUid: string;
    readonly operationId: string;
    readonly descriptorDigest: `sha256:${string}`;
    readonly providerEtag?: string;
    readonly observed: Readonly<Record<string, unknown>>;
  }): Promise<boolean> {
    const observed = canonicalJson(input.observed);
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'committed', provider_etag = ?, observed_json = ?, previous_json = NULL
       WHERE provider_id = ? AND resource_uid = ? AND operation_id = ?
         AND descriptor_digest = ? AND state = 'pending'`,
      [
        input.providerEtag ?? null,
        observed,
        this.providerId,
        input.resourceUid,
        input.operationId,
        input.descriptorDigest,
      ],
    );
    if (write.changes === 1) return true;
    const current = await this.#receipt(input.resourceUid);
    return (
      current?.state === "committed" &&
      current.operationId === input.operationId &&
      current.descriptorDigest === input.descriptorDigest &&
      current.providerEtag === input.providerEtag &&
      canonicalJson(current.observed) === observed
    );
  }

  async bindPendingNativeId(input: {
    readonly resourceUid: string;
    readonly operationId: string;
    readonly descriptorDigest: `sha256:${string}`;
    readonly expectedNativeId: string;
    readonly nativeId: string;
  }): Promise<boolean> {
    if (!nativeToken(input.nativeId) || !nativeToken(input.expectedNativeId)) return false;
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_receipts
       SET native_id = ?
       WHERE provider_id = ? AND resource_uid = ? AND native_id = ?
         AND operation_id = ? AND descriptor_digest = ? AND state = 'pending'`,
      [
        input.nativeId,
        this.providerId,
        input.resourceUid,
        input.expectedNativeId,
        input.operationId,
        input.descriptorDigest,
      ],
    );
    if (write.changes === 1) return true;
    const current = await this.#receipt(input.resourceUid);
    return (
      current?.state === "pending" &&
      current.nativeId === input.nativeId &&
      current.operationId === input.operationId &&
      current.descriptorDigest === input.descriptorDigest
    );
  }

  /** Restore the exact previous committed receipt, or remove an initial claim. */
  async abortPendingReceipt(input: {
    readonly resourceUid: string;
    readonly operationId: string;
    readonly descriptorDigest: `sha256:${string}`;
  }): Promise<boolean> {
    const current = await this.#receipt(input.resourceUid);
    if (
      current?.state !== "pending" ||
      current.operationId !== input.operationId ||
      current.descriptorDigest !== input.descriptorDigest
    ) {
      return false;
    }
    if (!current.previous) {
      const removed = await this.sql.run(
        `DELETE FROM cloudflare_managed_worker_receipts
         WHERE provider_id = ? AND resource_uid = ? AND operation_id = ?
           AND generation = ? AND descriptor_digest = ? AND state = 'pending'
           AND previous_json IS NULL`,
        [
          this.providerId,
          input.resourceUid,
          input.operationId,
          current.generation,
          input.descriptorDigest,
        ],
      );
      return removed.changes === 1;
    }
    return await this.#restorePrevious(current, "pending");
  }

  async beginReceiptDelete(input: {
    readonly resourceUid: string;
    readonly nativeId: string;
    readonly operationId: string;
  }): Promise<ManagedWorkerReceipt | null> {
    const current = await this.#receipt(input.resourceUid);
    if (
      current?.state === "deleting" &&
      current.operationId === input.operationId &&
      current.nativeId === input.nativeId
    ) {
      return withoutPrevious(current);
    }
    if (current?.state !== "committed" || current.nativeId !== input.nativeId) {
      return null;
    }
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'deleting', operation_id = ?, generation = generation + 1,
           previous_json = ?
       WHERE provider_id = ? AND resource_uid = ? AND native_id = ?
         AND operation_id = ? AND generation = ? AND descriptor_digest = ?
         AND state = 'committed' AND observed_json = ? AND provider_etag IS ?`,
      [
        input.operationId,
        serializeReceipt(current),
        this.providerId,
        input.resourceUid,
        input.nativeId,
        current.operationId,
        current.generation,
        current.descriptorDigest,
        canonicalJson(current.observed),
        current.providerEtag ?? null,
      ],
    );
    if (write.changes !== 1) return null;
    const deleting = await this.#receipt(input.resourceUid);
    return deleting?.state === "deleting" && deleting.operationId === input.operationId
      ? withoutPrevious(deleting)
      : null;
  }

  async commitReceiptDelete(input: {
    readonly resourceUid: string;
    readonly nativeId: string;
    readonly operationId: string;
    readonly observed?: Readonly<Record<string, unknown>>;
  }): Promise<boolean> {
    const observed = canonicalJson(input.observed ?? { deleted: true });
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'deleted', provider_etag = NULL, observed_json = ?, previous_json = NULL
       WHERE provider_id = ? AND resource_uid = ? AND native_id = ?
         AND operation_id = ? AND state = 'deleting'`,
      [observed, this.providerId, input.resourceUid, input.nativeId, input.operationId],
    );
    if (write.changes === 1) return true;
    const current = await this.#receipt(input.resourceUid);
    return (
      current?.state === "deleted" &&
      current.nativeId === input.nativeId &&
      current.operationId === input.operationId &&
      canonicalJson(current.observed) === observed
    );
  }

  async abortReceiptDelete(input: {
    readonly resourceUid: string;
    readonly nativeId: string;
    readonly operationId: string;
  }): Promise<boolean> {
    const current = await this.#receipt(input.resourceUid);
    if (
      current?.state !== "deleting" ||
      current.nativeId !== input.nativeId ||
      current.operationId !== input.operationId ||
      !current.previous
    ) {
      return false;
    }
    return await this.#restorePrevious(current, "deleting");
  }

  async putRoute(input: {
    readonly kind: ManagedWorkerRouteKind;
    readonly key: string;
    readonly ownerNativeId: string;
    readonly operationId: string;
    readonly value: Readonly<Record<string, unknown>>;
    readonly predecessor: ManagedWorkerRoutePredecessor;
  }): Promise<ManagedWorkerRouteState | null> {
    return await this.#transitionRoute({ ...input, state: "active" });
  }

  async tombstoneRoute(input: {
    readonly kind: ManagedWorkerRouteKind;
    readonly key: string;
    readonly ownerNativeId: string;
    readonly operationId: string;
    readonly predecessor: { readonly kind: "exact"; readonly route: ManagedWorkerRouteState };
  }): Promise<ManagedWorkerRouteState | null> {
    return await this.#transitionRoute({
      ...input,
      state: "tombstone",
      value: { schema: "takoserver.managed-worker-route-tombstone@v1" },
    });
  }

  async route(kind: ManagedWorkerRouteKind, key: string): Promise<ManagedWorkerRouteState | null> {
    const rows = await this.sql.query(
      `SELECT owner_native_id, generation, operation_id, state, value_json
       FROM cloudflare_managed_worker_routes
       WHERE provider_id = ? AND route_kind = ? AND route_key = ?`,
      [this.providerId, kind, key],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ManagedWorkerStateCorruptionError("route");
    const route = parseRoute(kind, key, rows[0]);
    if (!route) throw new ManagedWorkerStateCorruptionError("route");
    return route;
  }

  async activeRoutes(kind: ManagedWorkerRouteKind): Promise<readonly ManagedWorkerRouteState[]> {
    const rows = await this.sql.query(
      `SELECT route_key, owner_native_id, generation, operation_id, state, value_json
       FROM cloudflare_managed_worker_routes
       WHERE provider_id = ? AND route_kind = ? AND state = 'active'
       ORDER BY route_key`,
      [this.providerId, kind],
    );
    const routes = rows.map((row) =>
      typeof row.route_key === "string" ? parseRoute(kind, row.route_key, row) : null,
    );
    if (!routes.every((route): route is ManagedWorkerRouteState => route !== null)) {
      throw new ManagedWorkerStateCorruptionError("route");
    }
    return routes;
  }

  async acquireScheduleReconciliation(input: {
    readonly leaseToken: string;
    readonly now: number;
    readonly leaseUntil: number;
  }): Promise<ManagedWorkerScheduleLeaseAcquisition> {
    if (
      !nativeToken(input.leaseToken) ||
      !Number.isSafeInteger(input.now) ||
      !Number.isSafeInteger(input.leaseUntil) ||
      input.now < 0 ||
      input.leaseUntil <= input.now ||
      input.leaseUntil - input.now > MAX_MANAGED_WORKER_SCHEDULE_LEASE_MS
    ) {
      throw new TypeError("invalid managed Worker schedule lease");
    }
    // An expired owner may still have a whole-set PUT in flight. Permanently
    // classify that generation as ambiguous before considering any new lease;
    // no automatic caller may steal it and issue a second PUT.
    await this.sql.run(
      `UPDATE cloudflare_managed_worker_schedule_reconciliation
       SET reconciliation_state = 'operator_reconciliation_required',
           ambiguous_generation = desired_generation,
           ambiguity_reason = 'lease_expired'
       WHERE provider_id = ? AND reconciliation_state = 'leased'
         AND lease_until <= ?`,
      [this.providerId, input.now],
    );
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_schedule_reconciliation
       SET reconciliation_state = 'leased', lease_token = ?,
           lease_started_at = CASE
             WHEN reconciliation_state = 'leased' AND lease_token = ?
             THEN lease_started_at ELSE ? END,
           lease_until = ?
       WHERE provider_id = ?
         AND (
           reconciliation_state = 'idle' OR
           (
             reconciliation_state = 'leased' AND lease_token = ? AND lease_until > ?
             AND ? <= lease_started_at + ?
           )
         )`,
      [
        input.leaseToken,
        input.leaseToken,
        input.now,
        input.leaseUntil,
        this.providerId,
        input.leaseToken,
        input.now,
        input.leaseUntil,
        MAX_MANAGED_WORKER_SCHEDULE_LEASE_MS,
      ],
    );
    const state = await this.#scheduleReconciliation();
    if (!state) return { outcome: "absent" };
    if (
      write.changes === 1 &&
      state.reconciliationState === "leased" &&
      state.leaseToken === input.leaseToken &&
      state.leaseUntil === input.leaseUntil
    ) {
      return { outcome: "acquired", state };
    }
    return {
      outcome:
        state.reconciliationState === "operator_reconciliation_required"
          ? "operator_reconciliation_required"
          : "busy",
      state,
    };
  }

  /** Read-only status. Expiry is projected as ambiguous without changing SQL. */
  async scheduleReconciliationStatus(
    now: number,
  ): Promise<ManagedWorkerScheduleReconciliation | null> {
    if (!Number.isSafeInteger(now) || now < 0) {
      throw new TypeError("invalid managed Worker schedule status time");
    }
    const state = await this.#scheduleReconciliation();
    if (
      state?.reconciliationState === "leased" &&
      state.leaseUntil !== undefined &&
      state.leaseUntil <= now
    ) {
      return {
        ...state,
        reconciliationState: "operator_reconciliation_required",
        ambiguousGeneration: state.desiredGeneration,
        ambiguityReason: "lease_expired",
      };
    }
    return state;
  }

  async scheduleSnapshot(input: {
    readonly leaseToken: string;
    readonly now: number;
  }): Promise<ManagedWorkerScheduleSnapshot | null> {
    if (!nativeToken(input.leaseToken) || !Number.isSafeInteger(input.now) || input.now < 0) {
      throw new TypeError("invalid managed Worker schedule snapshot");
    }
    const [authorityResult, routesResult] = await this.sql.batch([
      {
        sql: `SELECT desired_generation, applied_generation, applied_digest,
                     reconciliation_state, lease_token, lease_started_at, lease_until,
                     ambiguous_generation, ambiguity_reason
              FROM cloudflare_managed_worker_schedule_reconciliation
              WHERE provider_id = ? AND reconciliation_state = 'leased'
                AND lease_token = ? AND lease_until > ?`,
        params: [this.providerId, input.leaseToken, input.now],
      },
      {
        sql: `SELECT route_key, owner_native_id, generation, operation_id, state, value_json
              FROM cloudflare_managed_worker_routes
              WHERE provider_id = ? AND route_kind = 'schedule' AND state = 'active'
              ORDER BY route_key`,
        params: [this.providerId],
      },
    ]);
    if (!authorityResult || !routesResult || authorityResult.rows.length === 0) return null;
    if (authorityResult.rows.length !== 1) {
      throw new ManagedWorkerStateCorruptionError("schedule");
    }
    const authority = parseScheduleReconciliation(authorityResult.rows[0]);
    if (!authority || authority.leaseToken !== input.leaseToken) {
      throw new ManagedWorkerStateCorruptionError("schedule");
    }
    const routes = routesResult.rows.map((row) =>
      typeof row.route_key === "string" ? parseRoute("schedule", row.route_key, row) : null,
    );
    if (!routes.every((route): route is ManagedWorkerRouteState => route !== null)) {
      throw new ManagedWorkerStateCorruptionError("route");
    }
    return { ...authority, routes };
  }

  async completeScheduleReconciliation(input: {
    readonly leaseToken: string;
    readonly now: number;
    readonly desiredGeneration: number;
    readonly appliedDigest: `sha256:${string}`;
  }): Promise<boolean> {
    if (
      !nativeToken(input.leaseToken) ||
      !Number.isSafeInteger(input.now) ||
      input.now < 0 ||
      !Number.isSafeInteger(input.desiredGeneration) ||
      input.desiredGeneration < 1 ||
      !sha256Digest(input.appliedDigest)
    ) {
      throw new TypeError("invalid managed Worker schedule completion");
    }
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_schedule_reconciliation
       SET applied_generation = ?, applied_digest = ?
       WHERE provider_id = ? AND desired_generation = ?
         AND reconciliation_state = 'leased'
         AND lease_token = ? AND lease_until > ?`,
      [
        input.desiredGeneration,
        input.appliedDigest,
        this.providerId,
        input.desiredGeneration,
        input.leaseToken,
        input.now,
      ],
    );
    if (write.changes !== 1) return false;
    const state = await this.#scheduleReconciliation();
    return (
      state?.desiredGeneration === input.desiredGeneration &&
      state.appliedGeneration === input.desiredGeneration &&
      state.appliedDigest === input.appliedDigest &&
      state.reconciliationState === "leased" &&
      state.leaseToken === input.leaseToken
    );
  }

  async markScheduleReconciliationAmbiguous(input: {
    readonly leaseToken: string;
    readonly desiredGeneration: number;
    readonly reason: "lease_expired" | "mutation_indeterminate";
  }): Promise<boolean> {
    if (
      !nativeToken(input.leaseToken) ||
      !Number.isSafeInteger(input.desiredGeneration) ||
      input.desiredGeneration < 1
    ) {
      throw new TypeError("invalid managed Worker schedule ambiguity");
    }
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_schedule_reconciliation
       SET reconciliation_state = 'operator_reconciliation_required',
           ambiguous_generation = ?, ambiguity_reason = ?
       WHERE provider_id = ? AND reconciliation_state = 'leased'
         AND lease_token = ?`,
      [input.desiredGeneration, input.reason, this.providerId, input.leaseToken],
    );
    if (write.changes === 1) return true;
    const state = await this.#scheduleReconciliation();
    return (
      state?.reconciliationState === "operator_reconciliation_required" &&
      state.leaseToken === input.leaseToken &&
      state.ambiguousGeneration === input.desiredGeneration &&
      state.ambiguityReason === input.reason
    );
  }

  async completeOperatorScheduleReconciliation(input: {
    readonly leaseToken: string;
    readonly ambiguousGeneration: number;
    readonly desiredGeneration: number;
    readonly appliedDigest: `sha256:${string}`;
  }): Promise<boolean> {
    if (
      !nativeToken(input.leaseToken) ||
      !Number.isSafeInteger(input.ambiguousGeneration) ||
      input.ambiguousGeneration < 1 ||
      !Number.isSafeInteger(input.desiredGeneration) ||
      input.desiredGeneration < 1 ||
      !sha256Digest(input.appliedDigest)
    ) {
      throw new TypeError("invalid managed Worker operator schedule completion");
    }
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_schedule_reconciliation
       SET applied_generation = ?, applied_digest = ?, reconciliation_state = 'idle',
           lease_token = NULL, lease_started_at = NULL, lease_until = NULL,
           ambiguous_generation = NULL, ambiguity_reason = NULL
       WHERE provider_id = ?
         AND reconciliation_state = 'operator_reconciliation_required'
         AND lease_token = ? AND ambiguous_generation = ?
         AND desired_generation = ?`,
      [
        input.desiredGeneration,
        input.appliedDigest,
        this.providerId,
        input.leaseToken,
        input.ambiguousGeneration,
        input.desiredGeneration,
      ],
    );
    return write.changes === 1;
  }

  async releaseScheduleReconciliation(leaseToken: string): Promise<boolean> {
    if (!nativeToken(leaseToken)) throw new TypeError("invalid managed Worker schedule lease");
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_schedule_reconciliation
       SET reconciliation_state = 'idle', lease_token = NULL,
           lease_started_at = NULL, lease_until = NULL
       WHERE provider_id = ? AND reconciliation_state = 'leased' AND lease_token = ?`,
      [this.providerId, leaseToken],
    );
    return write.changes === 1;
  }

  async commitReceiptAtScheduleFence(input: {
    readonly resourceUid: string;
    readonly operationId: string;
    readonly descriptorDigest: `sha256:${string}`;
    readonly observed: Readonly<Record<string, unknown>>;
    readonly scheduleGeneration: number;
    readonly scheduleDigest: `sha256:${string}`;
    readonly scheduleLeaseToken: string;
    readonly now: number;
  }): Promise<boolean> {
    const observed = canonicalJson(input.observed);
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'committed', provider_etag = NULL,
           observed_json = ?, previous_json = NULL
       WHERE provider_id = ? AND resource_uid = ? AND operation_id = ?
         AND descriptor_digest = ? AND state = 'pending'
         AND EXISTS (
           SELECT 1 FROM cloudflare_managed_worker_schedule_reconciliation AS schedule
           WHERE schedule.provider_id = cloudflare_managed_worker_receipts.provider_id
             AND schedule.desired_generation = ?
             AND schedule.applied_generation = ?
             AND schedule.applied_digest = ?
             AND schedule.reconciliation_state = 'leased'
             AND schedule.lease_token = ? AND schedule.lease_until > ?
         )`,
      [
        observed,
        this.providerId,
        input.resourceUid,
        input.operationId,
        input.descriptorDigest,
        input.scheduleGeneration,
        input.scheduleGeneration,
        input.scheduleDigest,
        input.scheduleLeaseToken,
        input.now,
      ],
    );
    if (write.changes === 1) return true;
    const current = await this.#receipt(input.resourceUid);
    return (
      current?.state === "committed" &&
      current.operationId === input.operationId &&
      current.descriptorDigest === input.descriptorDigest &&
      canonicalJson(current.observed) === observed
    );
  }

  async commitReceiptDeleteAtScheduleFence(input: {
    readonly resourceUid: string;
    readonly nativeId: string;
    readonly operationId: string;
    readonly observed?: Readonly<Record<string, unknown>>;
    readonly scheduleGeneration: number;
    readonly scheduleDigest: `sha256:${string}`;
    readonly scheduleLeaseToken: string;
    readonly now: number;
  }): Promise<boolean> {
    const observed = canonicalJson(input.observed ?? { deleted: true });
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_receipts
       SET state = 'deleted', provider_etag = NULL,
           observed_json = ?, previous_json = NULL
       WHERE provider_id = ? AND resource_uid = ? AND native_id = ?
         AND operation_id = ? AND state = 'deleting'
         AND EXISTS (
           SELECT 1 FROM cloudflare_managed_worker_schedule_reconciliation AS schedule
           WHERE schedule.provider_id = cloudflare_managed_worker_receipts.provider_id
             AND schedule.desired_generation = ?
             AND schedule.applied_generation = ?
             AND schedule.applied_digest = ?
             AND schedule.reconciliation_state = 'leased'
             AND schedule.lease_token = ? AND schedule.lease_until > ?
         )`,
      [
        observed,
        this.providerId,
        input.resourceUid,
        input.nativeId,
        input.operationId,
        input.scheduleGeneration,
        input.scheduleGeneration,
        input.scheduleDigest,
        input.scheduleLeaseToken,
        input.now,
      ],
    );
    if (write.changes === 1) return true;
    const current = await this.#receipt(input.resourceUid);
    return (
      current?.state === "deleted" &&
      current.nativeId === input.nativeId &&
      current.operationId === input.operationId &&
      canonicalJson(current.observed) === observed
    );
  }

  async #receipt(resourceUid: string): Promise<StoredReceipt | null> {
    const rows = await this.sql.query(
      `${RECEIPT_SELECT} WHERE provider_id = ? AND resource_uid = ?`,
      [this.providerId, resourceUid],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ManagedWorkerStateCorruptionError("receipt");
    const receipt = parseReceipt(rows[0]);
    if (!receipt) throw new ManagedWorkerStateCorruptionError("receipt");
    return receipt;
  }

  async #scheduleReconciliation(): Promise<ManagedWorkerScheduleReconciliation | null> {
    const rows = await this.sql.query(
      `SELECT desired_generation, applied_generation, applied_digest,
              reconciliation_state, lease_token, lease_started_at, lease_until,
              ambiguous_generation, ambiguity_reason
       FROM cloudflare_managed_worker_schedule_reconciliation
       WHERE provider_id = ?`,
      [this.providerId],
    );
    if (rows.length === 0) return null;
    if (rows.length !== 1) throw new ManagedWorkerStateCorruptionError("schedule");
    const state = parseScheduleReconciliation(rows[0]);
    if (!state) throw new ManagedWorkerStateCorruptionError("schedule");
    return state;
  }

  async #restorePrevious(
    current: StoredReceipt,
    expectedState: "pending" | "deleting",
  ): Promise<boolean> {
    const previous = current.previous;
    if (!previous) return false;
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_receipts
       SET native_id = ?, kind = ?, logical_worker_id = ?, operation_id = ?,
           generation = ?, descriptor_digest = ?, state = ?, provider_etag = ?,
           observed_json = ?, previous_json = NULL
       WHERE provider_id = ? AND resource_uid = ? AND native_id = ?
         AND operation_id = ? AND generation = ? AND descriptor_digest = ?
         AND state = ?`,
      [
        previous.nativeId,
        previous.kind,
        previous.logicalWorkerId,
        previous.operationId,
        previous.generation,
        previous.descriptorDigest,
        previous.state,
        previous.providerEtag ?? null,
        canonicalJson(previous.observed),
        this.providerId,
        current.resourceUid,
        current.nativeId,
        current.operationId,
        current.generation,
        current.descriptorDigest,
        expectedState,
      ],
    );
    return write.changes === 1;
  }

  async #transitionRoute(input: {
    readonly kind: ManagedWorkerRouteKind;
    readonly key: string;
    readonly ownerNativeId: string;
    readonly operationId: string;
    readonly state: "active" | "tombstone";
    readonly value: Readonly<Record<string, unknown>>;
    readonly predecessor: ManagedWorkerRoutePredecessor;
  }): Promise<ManagedWorkerRouteState | null> {
    const current = await this.route(input.kind, input.key);
    if (current?.operationId === input.operationId) {
      const expectedValue = canonicalJson({ ...input.value, generation: current.generation });
      return current.ownerNativeId === input.ownerNativeId &&
        current.state === input.state &&
        canonicalJson(current.value) === expectedValue
        ? current
        : null;
    }

    if (input.predecessor.kind === "absent") {
      if (current) return null;
      const generation = 1;
      const value = canonicalJson({ ...input.value, generation });
      const write = await this.sql.run(
        `INSERT INTO cloudflare_managed_worker_routes (
           provider_id, route_kind, route_key, owner_native_id, generation,
           operation_id, state, value_json
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT DO NOTHING`,
        [
          this.providerId,
          input.kind,
          input.key,
          input.ownerNativeId,
          generation,
          input.operationId,
          input.state,
          value,
        ],
      );
      if (write.changes !== 1) return null;
      return await this.#readExactRoute(input.kind, input.key, {
        ownerNativeId: input.ownerNativeId,
        generation,
        operationId: input.operationId,
        state: input.state,
        value,
      });
    }

    const predecessor = input.predecessor.route;
    if (!sameRoute(current, predecessor)) return null;
    if (
      predecessor.ownerNativeId !== input.ownerNativeId &&
      !(predecessor.state === "tombstone" && input.state === "active")
    ) {
      return null;
    }
    const generation = predecessor.generation + 1;
    const value = canonicalJson({ ...input.value, generation });
    const write = await this.sql.run(
      `UPDATE cloudflare_managed_worker_routes
       SET owner_native_id = ?, generation = ?, operation_id = ?, state = ?, value_json = ?
       WHERE provider_id = ? AND route_kind = ? AND route_key = ?
         AND owner_native_id = ? AND generation = ? AND operation_id = ?
         AND state = ? AND value_json = ?`,
      [
        input.ownerNativeId,
        generation,
        input.operationId,
        input.state,
        value,
        this.providerId,
        input.kind,
        input.key,
        predecessor.ownerNativeId,
        predecessor.generation,
        predecessor.operationId,
        predecessor.state,
        canonicalJson(predecessor.value),
      ],
    );
    if (write.changes !== 1) return null;
    return await this.#readExactRoute(input.kind, input.key, {
      ownerNativeId: input.ownerNativeId,
      generation,
      operationId: input.operationId,
      state: input.state,
      value,
    });
  }

  async #readExactRoute(
    kind: ManagedWorkerRouteKind,
    key: string,
    expected: {
      readonly ownerNativeId: string;
      readonly generation: number;
      readonly operationId: string;
      readonly state: "active" | "tombstone";
      readonly value: string;
    },
  ): Promise<ManagedWorkerRouteState | null> {
    const route = await this.route(kind, key);
    return route?.ownerNativeId === expected.ownerNativeId &&
      route.generation === expected.generation &&
      route.operationId === expected.operationId &&
      route.state === expected.state &&
      canonicalJson(route.value) === expected.value
      ? route
      : null;
  }
}

const RECEIPT_SELECT = `SELECT resource_uid, native_id, kind, logical_worker_id,
  operation_id, generation, descriptor_digest, state, provider_etag,
  observed_json, previous_json
  FROM cloudflare_managed_worker_receipts`;

function parseReceipt(row: Readonly<Record<string, unknown>> | undefined): StoredReceipt | null {
  const kind = receiptKind(row?.kind);
  const state = receiptState(row?.state);
  if (
    !row ||
    !nativeToken(row.resource_uid) ||
    !nativeToken(row.native_id) ||
    !kind ||
    !nativeToken(row.logical_worker_id) ||
    !nativeToken(row.operation_id) ||
    !Number.isSafeInteger(row.generation) ||
    Number(row.generation) < 1 ||
    !sha256Digest(row.descriptor_digest) ||
    !state ||
    typeof row.observed_json !== "string" ||
    (row.provider_etag !== null &&
      row.provider_etag !== undefined &&
      typeof row.provider_etag !== "string") ||
    (row.previous_json !== null &&
      row.previous_json !== undefined &&
      typeof row.previous_json !== "string")
  ) {
    return null;
  }
  const observed = parseObject(row.observed_json);
  if (!observed) return null;
  let previous: ManagedWorkerReceipt | null = null;
  if (typeof row.previous_json === "string") {
    const parsed = parseObject(row.previous_json);
    previous = parsed ? parseSerializedReceipt(parsed) : null;
    if (!previous) return null;
  }
  return {
    resourceUid: row.resource_uid,
    nativeId: row.native_id,
    kind,
    logicalWorkerId: row.logical_worker_id,
    operationId: row.operation_id,
    generation: Number(row.generation),
    descriptorDigest: row.descriptor_digest,
    state,
    ...(typeof row.provider_etag === "string" ? { providerEtag: row.provider_etag } : {}),
    observed,
    previous,
  };
}

function parseSerializedReceipt(
  value: Readonly<Record<string, unknown>>,
): ManagedWorkerReceipt | null {
  const kind = receiptKind(value.kind);
  const state = receiptState(value.state);
  const observed =
    typeof value.observed === "object" && value.observed !== null && !Array.isArray(value.observed)
      ? (value.observed as Readonly<Record<string, unknown>>)
      : null;
  if (
    !nativeToken(value.resourceUid) ||
    !nativeToken(value.nativeId) ||
    !kind ||
    !nativeToken(value.logicalWorkerId) ||
    !nativeToken(value.operationId) ||
    !Number.isSafeInteger(value.generation) ||
    Number(value.generation) < 1 ||
    !sha256Digest(value.descriptorDigest) ||
    !state ||
    !observed ||
    (value.providerEtag !== undefined && typeof value.providerEtag !== "string")
  ) {
    return null;
  }
  return {
    resourceUid: value.resourceUid,
    nativeId: value.nativeId,
    kind,
    logicalWorkerId: value.logicalWorkerId,
    operationId: value.operationId,
    generation: Number(value.generation),
    descriptorDigest: value.descriptorDigest,
    state,
    ...(typeof value.providerEtag === "string" ? { providerEtag: value.providerEtag } : {}),
    observed,
  };
}

function parseRoute(
  kind: ManagedWorkerRouteKind,
  key: string,
  row: Readonly<Record<string, unknown>> | undefined,
): ManagedWorkerRouteState | null {
  if (
    !row ||
    !nativeToken(row.owner_native_id) ||
    !Number.isSafeInteger(row.generation) ||
    Number(row.generation) < 1 ||
    !nativeToken(row.operation_id) ||
    (row.state !== "active" && row.state !== "tombstone") ||
    typeof row.value_json !== "string"
  ) {
    return null;
  }
  const value = parseObject(row.value_json);
  if (!value || value.generation !== Number(row.generation)) return null;
  return {
    kind,
    key,
    ownerNativeId: row.owner_native_id,
    generation: Number(row.generation),
    operationId: row.operation_id,
    state: row.state,
    value,
  };
}

function sameClaim(
  receipt: ManagedWorkerReceipt,
  input: {
    readonly resourceUid: string;
    readonly nativeId: string;
    readonly kind: ManagedWorkerReceiptKind;
    readonly logicalWorkerId: string;
    readonly operationId: string;
    readonly descriptorDigest: `sha256:${string}`;
  },
): boolean {
  return (
    receipt.resourceUid === input.resourceUid &&
    receipt.nativeId === input.nativeId &&
    receipt.kind === input.kind &&
    receipt.logicalWorkerId === input.logicalWorkerId &&
    receipt.operationId === input.operationId &&
    receipt.descriptorDigest === input.descriptorDigest
  );
}

function sameRoute(left: ManagedWorkerRouteState | null, right: ManagedWorkerRouteState): boolean {
  return (
    left?.kind === right.kind &&
    left.key === right.key &&
    left.ownerNativeId === right.ownerNativeId &&
    left.generation === right.generation &&
    left.operationId === right.operationId &&
    left.state === right.state &&
    canonicalJson(left.value) === canonicalJson(right.value)
  );
}

function withoutPrevious(receipt: StoredReceipt): ManagedWorkerReceipt {
  const { previous: _previous, ...value } = receipt;
  return value;
}

function serializeReceipt(receipt: ManagedWorkerReceipt): string {
  return canonicalJson(receipt);
}

function assertReceiptInput(input: {
  readonly resourceUid: string;
  readonly nativeId: string;
  readonly logicalWorkerId: string;
  readonly operationId: string;
  readonly descriptorDigest: unknown;
}): void {
  if (
    !nativeToken(input.resourceUid) ||
    !nativeToken(input.nativeId) ||
    !nativeToken(input.logicalWorkerId) ||
    !nativeToken(input.operationId) ||
    !sha256Digest(input.descriptorDigest)
  ) {
    throw new TypeError("invalid managed Worker receipt command");
  }
}

function receiptKind(value: unknown): ManagedWorkerReceiptKind | null {
  return value === "worker" ||
    value === "version" ||
    value === "deployment" ||
    value === "endpoint" ||
    value === "cron" ||
    value === "consumer" ||
    value === "sqlite"
    ? value
    : null;
}

function receiptState(value: unknown): ManagedWorkerReceiptState | null {
  return value === "pending" || value === "committed" || value === "deleting" || value === "deleted"
    ? value
    : null;
}

function parseObject(value: string): Readonly<Record<string, unknown>> | null {
  try {
    const parsed: unknown = JSON.parse(value);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Readonly<Record<string, unknown>>)
      : null;
  } catch {
    return null;
  }
}

function parseScheduleReconciliation(
  row: Readonly<Record<string, unknown>> | undefined,
): ManagedWorkerScheduleReconciliation | null {
  if (
    !row ||
    !Number.isSafeInteger(row.desired_generation) ||
    Number(row.desired_generation) < 1 ||
    !Number.isSafeInteger(row.applied_generation) ||
    Number(row.applied_generation) < 0 ||
    Number(row.applied_generation) > Number(row.desired_generation)
  ) {
    return null;
  }
  const appliedGeneration = Number(row.applied_generation);
  const appliedDigest = row.applied_digest;
  if (
    (appliedGeneration === 0 && appliedDigest !== null && appliedDigest !== undefined) ||
    (appliedGeneration > 0 && !sha256Digest(appliedDigest))
  ) {
    return null;
  }
  const leaseToken = row.lease_token;
  const leaseStartedAt = row.lease_started_at;
  const leaseUntil = row.lease_until;
  const reconciliationState = row.reconciliation_state;
  const ambiguousGeneration = row.ambiguous_generation;
  const ambiguityReason = row.ambiguity_reason;
  if (
    !["idle", "leased", "operator_reconciliation_required"].includes(String(reconciliationState)) ||
    (leaseToken !== null && leaseToken !== undefined && !nativeToken(leaseToken)) ||
    (leaseStartedAt !== null &&
      leaseStartedAt !== undefined &&
      (!Number.isSafeInteger(leaseStartedAt) || Number(leaseStartedAt) < 0)) ||
    (leaseUntil !== null &&
      leaseUntil !== undefined &&
      (!Number.isSafeInteger(leaseUntil) || Number(leaseUntil) < 0)) ||
    (ambiguousGeneration !== null &&
      ambiguousGeneration !== undefined &&
      (!Number.isSafeInteger(ambiguousGeneration) ||
        Number(ambiguousGeneration) < 1 ||
        Number(ambiguousGeneration) > Number(row.desired_generation))) ||
    (ambiguityReason !== null &&
      ambiguityReason !== undefined &&
      ambiguityReason !== "lease_expired" &&
      ambiguityReason !== "mutation_indeterminate")
  ) {
    return null;
  }
  const hasLease =
    typeof leaseToken === "string" &&
    typeof leaseStartedAt === "number" &&
    typeof leaseUntil === "number" &&
    leaseStartedAt < leaseUntil;
  const hasAmbiguity =
    typeof ambiguousGeneration === "number" && typeof ambiguityReason === "string";
  if (
    (reconciliationState === "idle" && (hasLease || hasAmbiguity)) ||
    (reconciliationState === "leased" && (!hasLease || hasAmbiguity)) ||
    (reconciliationState === "operator_reconciliation_required" && (!hasLease || !hasAmbiguity))
  ) {
    return null;
  }
  return {
    desiredGeneration: Number(row.desired_generation),
    appliedGeneration,
    reconciliationState:
      reconciliationState as ManagedWorkerScheduleReconciliation["reconciliationState"],
    ...(sha256Digest(appliedDigest) ? { appliedDigest } : {}),
    ...(typeof leaseToken === "string" ? { leaseToken } : {}),
    ...(typeof leaseStartedAt === "number" ? { leaseStartedAt } : {}),
    ...(typeof leaseUntil === "number" ? { leaseUntil } : {}),
    ...(typeof ambiguousGeneration === "number" ? { ambiguousGeneration } : {}),
    ...(ambiguityReason === "lease_expired" || ambiguityReason === "mutation_indeterminate"
      ? { ambiguityReason }
      : {}),
  };
}

function nativeToken(value: unknown): value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > 1_024) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 31 || code === 127) return false;
  }
  return true;
}

function sha256Digest(value: unknown): value is `sha256:${string}` {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(
    Object.entries(value as Readonly<Record<string, unknown>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, sortJson(child)]),
  );
}
