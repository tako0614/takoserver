import { bytesDigest } from "../json.ts";
import type { Clock, Sql } from "../ports.ts";
import { SqlError } from "../ports.ts";
import {
  parseWorkerCronTriggerSpec,
  WORKER_CRON_TRIGGER_FORM_URL,
} from "./forms/worker-cron-trigger.ts";

const MINUTE_MS = 60_000;
const DEFAULT_BATCH_SIZE = 16;
const DEFAULT_LEASE_MS = 30_000;
const DEFAULT_RETRY_MS = 1_000;
const MAX_BATCH_SIZE = 100;
const SCAN_PAGE_SIZE = 128;
const RESOURCE_UID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type WorkerCronTriggerDeliveryResult =
  | { readonly kind: "handler_resolved"; readonly workerVersionUid: string }
  | { readonly kind: "handler_rejected"; readonly workerVersionUid: string }
  | { readonly kind: "unknown" };

export interface WorkerCronTriggerDelivery {
  invokeScheduled(input: {
    readonly triggerUid: string;
    readonly workerUid: string;
    readonly cron: string;
    readonly scheduledTime: number;
    readonly matchId: string;
  }): Promise<WorkerCronTriggerDeliveryResult>;
}

export interface WorkerCronTriggerTickResult {
  readonly recorded: number;
  readonly claimed: number;
  readonly resolved: number;
  readonly rejected: number;
  readonly unknown: number;
}

interface TriggerRow {
  readonly uid: string;
  readonly principal: string;
  readonly space: string;
  readonly target_key: string;
  readonly generation: number;
  readonly last_operation: string;
  readonly updated_at: string;
  readonly spec_json: string;
}

interface MatchRow {
  readonly match_id: string;
  readonly target_key: string;
  readonly trigger_uid: string;
  readonly worker_uid: string;
  readonly cron: string;
  readonly scheduled_time_ms: number;
  readonly lease_token: string;
}

/**
 * Record only the current UTC minute, then deliver durable obligations. A
 * minute that was never recorded is intentionally not reconstructed later.
 */
export async function runWorkerCronTriggerTick(options: {
  readonly sql: Sql;
  readonly now: Clock;
  readonly delivery: WorkerCronTriggerDelivery;
  readonly targetKey: string;
  readonly limit?: number;
  readonly leaseMilliseconds?: number;
  readonly retryMilliseconds?: number;
}): Promise<WorkerCronTriggerTickResult> {
  const limit = options.limit ?? DEFAULT_BATCH_SIZE;
  const leaseMilliseconds = options.leaseMilliseconds ?? DEFAULT_LEASE_MS;
  const retryMilliseconds = options.retryMilliseconds ?? DEFAULT_RETRY_MS;
  if (!options.targetKey) throw new TypeError("targetKey is required");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_BATCH_SIZE) {
    throw new TypeError("limit must be an integer from 1 through 100");
  }
  if (!Number.isSafeInteger(leaseMilliseconds) || leaseMilliseconds < 1_000) {
    throw new TypeError("leaseMilliseconds must be an integer of at least 1000");
  }
  if (!Number.isSafeInteger(retryMilliseconds) || retryMilliseconds < 1_000) {
    throw new TypeError("retryMilliseconds must be an integer of at least 1000");
  }

  const tickAt = options.now().getTime();
  if (!Number.isSafeInteger(tickAt) || tickAt < 0)
    throw new TypeError("clock must be valid UTC time");
  const scheduledTime = Math.floor(tickAt / MINUTE_MS) * MINUTE_MS;
  let recorded = 0;
  let afterUid = "";
  async function scanPage(after: string): Promise<readonly TriggerRow[]> {
    return (await options.sql.query(
      `SELECT r.uid, r.principal, r.space, r.target_key, r.generation, r.last_operation,
              op.updated_at, r.spec_json
     FROM tf_v2_resources r
     JOIN tf_v2_operations op ON op.id = r.last_operation
     JOIN tf_v2_operation_reference_sets ref_set
       ON ref_set.operation_id = op.id AND ref_set.sealed = 1
     JOIN tf_v2_operation_references ref
       ON ref.operation_id = op.id
      AND ref.form_url = 'https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/'
      AND ref.readiness = 'observed'
     JOIN tf_v2_resource_references edge
       ON edge.referrer_uid = r.uid AND edge.target_uid = ref.target_uid
     WHERE r.form_url = ? AND r.target_key = ? AND r.uid > ?
       AND r.deleted_at IS NULL AND r.phase = 'idle'
       AND r.busy_operation IS NULL AND r.generation = r.observed_generation
       AND op.resource_uid = r.uid AND op.principal = r.principal
       AND op.target_key = r.target_key
       AND op.action IN ('create', 'update') AND op.status = 'succeeded'
       AND op.generation = r.generation AND op.accepted_spec_json = r.spec_json
     ORDER BY r.uid LIMIT ?`,
      [WORKER_CRON_TRIGGER_FORM_URL, options.targetKey, after, SCAN_PAGE_SIZE],
    )) as unknown as readonly TriggerRow[];
  }
  let candidates = await scanPage(afterUid);
  while (candidates.length > 0) {
    for (const row of candidates) {
      let spec: ReturnType<typeof parseWorkerCronTriggerSpec>;
      try {
        spec = parseWorkerCronTriggerSpec(JSON.parse(row.spec_json));
      } catch {
        continue;
      }
      const settledAt = Date.parse(row.updated_at);
      if (
        !Number.isSafeInteger(settledAt) ||
        settledAt > scheduledTime ||
        !spec.schedule.matches(scheduledTime)
      ) {
        continue;
      }
      const matchId = await bytesDigest(
        new TextEncoder().encode(`${row.uid}\u0000${spec.cron}\u0000${scheduledTime}`),
      );
      try {
        const inserted = await options.sql.run(
          `INSERT INTO tf_v2_worker_cron_matches
         (match_id, trigger_uid, principal, space, trigger_generation,
           target_key, trigger_operation_id, trigger_settled_at, worker_uid, cron, scheduled_time_ms, state,
           attempts, created_at_ms, next_attempt_at_ms, lease_token, lease_until_ms,
           result_version_uid, error_code, updated_at_ms)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?, NULL, NULL, NULL, NULL, ?
         WHERE EXISTS (
           SELECT 1 FROM tf_v2_resources current
           JOIN tf_v2_operations current_op ON current_op.id = current.last_operation
           WHERE current.uid = ? AND current.principal = ? AND current.space = ?
             AND current.target_key = ?
             AND current.form_url = ? AND current.deleted_at IS NULL
             AND current.phase = 'idle' AND current.busy_operation IS NULL
             AND current.generation = ? AND current.observed_generation = current.generation
             AND current.last_operation = ? AND current.spec_json = ?
             AND current_op.target_key = current.target_key
             AND current_op.status = 'succeeded' AND current_op.action IN ('create', 'update')
             AND current_op.generation = current.generation
             AND current_op.accepted_spec_json = current.spec_json
             AND current_op.updated_at = ? AND current_op.updated_at <= ?
         )
         ON CONFLICT DO NOTHING`,
          [
            matchId,
            row.uid,
            row.principal,
            row.space,
            row.generation,
            options.targetKey,
            row.last_operation,
            row.updated_at,
            spec.worker.resourceUid,
            spec.cron,
            scheduledTime,
            tickAt,
            tickAt,
            tickAt,
            row.uid,
            row.principal,
            row.space,
            options.targetKey,
            WORKER_CRON_TRIGGER_FORM_URL,
            row.generation,
            row.last_operation,
            row.spec_json,
            row.updated_at,
            new Date(scheduledTime).toISOString(),
          ],
        );
        recorded += inserted.changes;
      } catch (error) {
        if (!(error instanceof SqlError) || error.code !== "constraint") throw error;
        // The migration's insert trigger rechecks the full settled worker graph,
        // including a ready active Deployment and scheduled-capable Versions.
        // A graph that changed or was unavailable is not recorded as a match.
      }
    }
    if (candidates.length < SCAN_PAGE_SIZE) break;
    afterUid = candidates.at(-1)?.uid ?? afterUid;
    candidates = await scanPage(afterUid);
  }

  let claimed = 0;
  let resolved = 0;
  let rejected = 0;
  let unknown = 0;
  const claimable = (await options.sql.query(
    `SELECT match_id FROM tf_v2_worker_cron_matches
     WHERE target_key = ? AND (
       (state = 'pending' AND next_attempt_at_ms <= ?) OR
       (state = 'dispatching' AND lease_until_ms <= ?)
     )
     ORDER BY scheduled_time_ms, created_at_ms, match_id LIMIT ?`,
    [options.targetKey, tickAt, tickAt, limit],
  )) as readonly { readonly match_id: string }[];

  for (const candidate of claimable) {
    const leaseToken = crypto.randomUUID();
    const leaseUntil = tickAt + leaseMilliseconds;
    const claim = await options.sql.run(
      `UPDATE tf_v2_worker_cron_matches
       SET state = 'dispatching', attempts = attempts + 1, lease_token = ?,
           lease_until_ms = ?, updated_at_ms = ?
       WHERE match_id = ? AND target_key = ? AND (
         (state = 'pending' AND next_attempt_at_ms <= ?) OR
         (state = 'dispatching' AND lease_until_ms <= ?)
       )`,
      [leaseToken, leaseUntil, tickAt, candidate.match_id, options.targetKey, tickAt, tickAt],
    );
    if (claim.changes !== 1) continue;
    const [row] = (await options.sql.query(
      `SELECT match_id, target_key, trigger_uid, worker_uid, cron, scheduled_time_ms, lease_token
       FROM tf_v2_worker_cron_matches
       WHERE match_id = ? AND target_key = ? AND state = 'dispatching' AND lease_token = ?`,
      [candidate.match_id, options.targetKey, leaseToken],
    )) as unknown as readonly MatchRow[];
    if (!row || row.target_key !== options.targetKey || row.lease_token !== leaseToken) continue;
    claimed += 1;

    let result: WorkerCronTriggerDeliveryResult;
    try {
      result = await options.delivery.invokeScheduled({
        triggerUid: row.trigger_uid,
        workerUid: row.worker_uid,
        cron: row.cron,
        scheduledTime: row.scheduled_time_ms,
        matchId: row.match_id,
      });
    } catch {
      result = { kind: "unknown" };
    }

    if (
      result.kind !== "unknown" &&
      (!RESOURCE_UID.test(result.workerVersionUid) || result.workerVersionUid.length > 128)
    ) {
      result = { kind: "unknown" };
    }
    if (result.kind === "handler_resolved") {
      const settled = await options.sql.run(
        `UPDATE tf_v2_worker_cron_matches
         SET state = 'resolved', lease_token = NULL, lease_until_ms = NULL,
             result_version_uid = ?, error_code = NULL, updated_at_ms = ?
         WHERE match_id = ? AND target_key = ? AND state = 'dispatching' AND lease_token = ?`,
        [
          result.workerVersionUid,
          options.now().getTime(),
          row.match_id,
          options.targetKey,
          leaseToken,
        ],
      );
      if (settled.changes === 1) resolved += 1;
    } else if (result.kind === "handler_rejected") {
      const settled = await options.sql.run(
        `UPDATE tf_v2_worker_cron_matches
         SET state = 'rejected', lease_token = NULL, lease_until_ms = NULL,
             result_version_uid = ?, error_code = 'handler_rejected', updated_at_ms = ?
         WHERE match_id = ? AND target_key = ? AND state = 'dispatching' AND lease_token = ?`,
        [
          result.workerVersionUid,
          options.now().getTime(),
          row.match_id,
          options.targetKey,
          leaseToken,
        ],
      );
      if (settled.changes === 1) rejected += 1;
    } else {
      const retryAt = options.now().getTime() + retryMilliseconds;
      const released = await options.sql.run(
        `UPDATE tf_v2_worker_cron_matches
         SET state = 'pending', lease_token = NULL, lease_until_ms = NULL,
             next_attempt_at_ms = ?, updated_at_ms = ?
         WHERE match_id = ? AND target_key = ? AND state = 'dispatching' AND lease_token = ?`,
        [retryAt, options.now().getTime(), row.match_id, options.targetKey, leaseToken],
      );
      if (released.changes === 1) unknown += 1;
    }
  }

  return { recorded, claimed, resolved, rejected, unknown };
}
