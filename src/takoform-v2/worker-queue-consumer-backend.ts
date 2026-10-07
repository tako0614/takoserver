import type { Sql } from "../ports.ts";
import {
  AT_LEAST_ONCE_QUEUE_FORM_URL,
  type AtLeastOnceQueueSpec,
  parseAtLeastOnceQueueSpec,
} from "./forms/at-least-once-queue.ts";
import {
  parseQueueConsumerSpec,
  QUEUE_CONSUMER_FORM_URL,
  type QueueConsumerSpec,
  queueConsumerReferences,
  validateQueueConsumerUpdate,
} from "./forms/queue-consumer.ts";
import type { V2BackendResult, V2Execution, V2Form } from "./types.ts";
import type { V2WorkerCurrentServingResolution } from "./worker-publication-state.ts";
import {
  ownsV2QueueClaim,
  snapshotV2QueueClaim,
  V2_QUEUE_CLAIM_SQL,
  v2QueueClaimParams,
  v2QueueId,
} from "./worker-queue-delivery.ts";

export const V2_QUEUE_CONSUMER_BACKEND_ID = "selfhost-v2-queue-consumer-sql-v1";
const UNKNOWN: V2BackendResult = {
  kind: "unknown",
  code: "attachment_unconfirmed",
  message: "The Queue attachment is not yet confirmed",
};

/** Privileged owner supplies the canonical current SQL + held-byte publication proof. */
export interface V2QueueConsumerCapability {
  observeCurrentServing(input: {
    readonly workerUid: string;
    readonly principal: string;
    readonly space: string;
    readonly targetKey: string;
  }): Promise<V2WorkerCurrentServingResolution>;
}

interface QueueTarget {
  readonly queueId: string;
  readonly spec: AtLeastOnceQueueSpec;
}

interface CustodyRow {
  readonly consumer_id: string;
  readonly generation: number;
  readonly state: "active" | "retiring" | "tombstone";
  readonly max_retries: number;
  readonly retry_delay_seconds: number;
  readonly dead_letter_queue_id: string | null;
  readonly dead_letter_delivery_delay_seconds: number | null;
  readonly dead_letter_retention_seconds: number | null;
}

function emptyPrivateInputs(inputs: Readonly<Record<string, string>> | undefined): void {
  if (inputs === undefined) return;
  if (inputs === null || typeof inputs !== "object" || Array.isArray(inputs))
    throw new TypeError("QueueConsumer private inputs must be empty");
  const prototype = Object.getPrototypeOf(inputs);
  if (
    (prototype !== Object.prototype && prototype !== null) ||
    Reflect.ownKeys(inputs).length !== 0
  )
    throw new TypeError("QueueConsumer private inputs must be empty");
}

async function settledQueue(
  sql: Sql,
  execution: V2Execution,
  uid: string,
): Promise<QueueTarget | null> {
  const rows = await sql.query(
    `SELECT resource.spec_json, resource.observed_json FROM tf_v2_resources resource
     JOIN tf_v2_operations op ON op.id = resource.last_operation
     WHERE resource.uid = ? AND resource.principal = ? AND resource.space = ?
       AND resource.target_key = ? AND resource.form_url = ?
       AND resource.deleted_at IS NULL AND resource.phase = 'idle'
       AND resource.busy_operation IS NULL AND resource.generation = resource.observed_generation
       AND op.resource_uid = resource.uid AND op.status = 'succeeded' AND op.effect = 'complete'
       AND op.action IN ('create','update') AND op.generation = resource.generation
       AND op.accepted_spec_json = resource.spec_json LIMIT 2`,
    [uid, execution.principal, execution.space, execution.targetKey, AT_LEAST_ONCE_QUEUE_FORM_URL],
  );
  if (rows.length !== 1) return null;
  try {
    const row = rows[0];
    if (!row || JSON.parse(String(row.observed_json)).queueExists !== true) return null;
    return {
      queueId: v2QueueId(uid),
      spec: parseAtLeastOnceQueueSpec(JSON.parse(String(row.spec_json))),
    };
  } catch {
    return null;
  }
}

async function currentCustody(sql: Sql, queueId: string): Promise<CustodyRow | null> {
  const rows = await sql.query(
    `SELECT consumer_id, generation, state, max_retries, retry_delay_seconds,
            dead_letter_queue_id, dead_letter_delivery_delay_seconds,
            dead_letter_retention_seconds
     FROM queue_consumer_custody WHERE queue_id = ? LIMIT 2`,
    [queueId],
  );
  return rows.length === 1 ? (rows[0] as unknown as CustodyRow) : null;
}

function samePolicy(row: CustodyRow, spec: QueueConsumerSpec, dlq: QueueTarget | null): boolean {
  return (
    row.max_retries === spec.maxRetries &&
    row.retry_delay_seconds === spec.retryDelaySeconds &&
    row.dead_letter_queue_id === (dlq?.queueId ?? null) &&
    row.dead_letter_delivery_delay_seconds === (dlq?.spec.deliveryDelaySeconds ?? null) &&
    row.dead_letter_retention_seconds === (dlq?.spec.messageRetentionSeconds ?? null)
  );
}

function policyParams(
  spec: QueueConsumerSpec,
  dlq: QueueTarget | null,
): (string | number | null)[] {
  return [
    spec.maxRetries,
    spec.retryDelaySeconds,
    dlq?.queueId ?? null,
    dlq?.spec.deliveryDelaySeconds ?? null,
    dlq?.spec.messageRetentionSeconds ?? null,
  ];
}

/** Unmounted internal manager; public support waits for native Queue transport. */
export function createQueueConsumerForm(options: {
  readonly sql: Sql;
  readonly targetKey: string;
  readonly capability: V2QueueConsumerCapability;
}): V2Form {
  const { sql, targetKey, capability } = options;
  if (!sql || !capability || typeof targetKey !== "string" || !targetKey)
    throw new TypeError("QueueConsumer SQL, target, and capability are required");

  async function run(execution: V2Execution): Promise<V2BackendResult> {
    if (
      execution.form !== QUEUE_CONSUMER_FORM_URL ||
      execution.backendId !== V2_QUEUE_CONSUMER_BACKEND_ID ||
      execution.targetKey !== targetKey
    )
      return UNKNOWN;
    const claim = snapshotV2QueueClaim(execution);
    const spec = parseQueueConsumerSpec(execution.spec);
    const queueId = v2QueueId(spec.queue.resourceUid);
    if (!(await ownsV2QueueClaim(sql, claim))) return UNKNOWN;

    let serving: Extract<V2WorkerCurrentServingResolution, { kind: "ready" }> | null = null;
    let queue: QueueTarget | null = null;
    let dlq: QueueTarget | null = null;
    if (execution.action !== "delete") {
      queue = await settledQueue(sql, execution, spec.queue.resourceUid);
      dlq = spec.deadLetterQueue
        ? await settledQueue(sql, execution, spec.deadLetterQueue.resourceUid)
        : null;
      if (!queue || (spec.deadLetterQueue && !dlq)) return UNKNOWN;
      const result = await capability.observeCurrentServing({
        workerUid: spec.worker.resourceUid,
        principal: execution.principal,
        space: execution.space,
        targetKey: execution.targetKey,
      });
      if (result.kind !== "ready") return UNKNOWN;
      const snapshot = result.snapshot;
      if (
        snapshot.worker.uid !== spec.worker.resourceUid ||
        snapshot.worker.principal !== execution.principal ||
        snapshot.worker.space !== execution.space ||
        !snapshot.deployment ||
        snapshot.deployment.versions.length === 0 ||
        snapshot.deployment.versions.some((version) => !version.spec.handlers.includes("queue")) ||
        !(await result.stillCurrent())
      )
        return UNKNOWN;
      serving = result;
    }
    if (!(await ownsV2QueueClaim(sql, claim))) return UNKNOWN;

    if (execution.action !== "create") {
      // Once this UPDATE/DELETE is accepted, the send guard cannot authorize
      // an older registered batch: the Consumer is busy in the same SQL
      // authority. Cancel only the pre-send states under this exact Operation
      // lease. A sent execution has no clock-based release.
      await sql.run(
        `UPDATE queue_v2_batch_executions SET state = 'pre_effect_refused'
         WHERE consumer_uid = ? AND state IN ('reserved','registered')
           AND ${V2_QUEUE_CLAIM_SQL}`,
        [execution.resourceUid, ...v2QueueClaimParams(claim)],
      );
      // A previously registered batch can have claimed messages before the
      // Host died. Its pre-send cancellation is durable, but no new delivery
      // claim runs while this Consumer is retiring. Refund one bounded page
      // under the *current* accepted Operation lease, so DELETE/UPDATE can
      // drain without mistaking a never-sent attempt for a delivery. A sent
      // or uncertain execution is deliberately excluded.
      const refunded = await sql.run(
        `UPDATE selfhost_queue_messages
         SET visible_at_ms = (CAST(strftime('%s', 'now') AS INTEGER) * 1000
              + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)),
             deliveries = CASE WHEN deliveries > 0 THEN deliveries - 1 ELSE 0 END,
             lease_token = NULL, lease_expires_at_ms = NULL,
             lease_consumer_id = NULL, lease_generation = NULL,
             lease_max_retries = NULL, lease_retry_delay_seconds = NULL,
             lease_dead_letter_queue_id = NULL,
             lease_dead_letter_delivery_delay_seconds = NULL,
             lease_dead_letter_retention_seconds = NULL
         WHERE rowid IN (SELECT message.rowid FROM selfhost_queue_messages message
           JOIN queue_v2_batch_executions batch
             ON batch.queue_id = message.queue_id
            AND batch.consumer_uid = message.lease_consumer_id
            AND batch.consumer_generation = message.lease_generation
            AND batch.lease_token = message.lease_token
           WHERE batch.consumer_uid = ? AND batch.state = 'pre_effect_refused'
           ORDER BY message.rowid LIMIT 64)
           AND ${V2_QUEUE_CLAIM_SQL}`,
        [execution.resourceUid, ...v2QueueClaimParams(claim)],
      );
      if (refunded.changes > 0) return { kind: "continue" };
    }

    const row = await currentCustody(sql, queueId);
    if (execution.action === "create") {
      if (!row || row.state === "tombstone") {
        const nextGeneration = row ? row.generation + 1 : 1;
        if (!Number.isSafeInteger(nextGeneration)) return UNKNOWN;
        const params = policyParams(spec, dlq);
        const write = row
          ? await sql.run(
              `UPDATE queue_consumer_custody SET consumer_id = ?, generation = ?, state = 'active',
                 max_retries = ?, retry_delay_seconds = ?, dead_letter_queue_id = ?,
                 dead_letter_delivery_delay_seconds = ?, dead_letter_retention_seconds = ?,
                 retirement_started_at_ms = NULL
               WHERE queue_id = ? AND consumer_id = ? AND generation = ? AND state = 'tombstone'
                 AND NOT EXISTS (SELECT 1 FROM selfhost_queue_messages WHERE queue_id = ? AND lease_token IS NOT NULL)
                 AND NOT EXISTS (SELECT 1 FROM queue_v2_batch_executions execution
                   WHERE execution.consumer_uid = ?
                     AND execution.state IN ('reserved','registered','send_authorized'))
                 AND ${V2_QUEUE_CLAIM_SQL}`,
              [
                execution.resourceUid,
                nextGeneration,
                ...params,
                queueId,
                row.consumer_id,
                row.generation,
                queueId,
                execution.resourceUid,
                ...v2QueueClaimParams(claim),
              ],
            )
          : await sql.run(
              `INSERT INTO queue_consumer_custody
                 (queue_id,consumer_id,generation,state,max_retries,retry_delay_seconds,
                  dead_letter_queue_id,dead_letter_delivery_delay_seconds,dead_letter_retention_seconds)
               SELECT ?, ?, 1, 'active', ?, ?, ?, ?, ?
               WHERE ${V2_QUEUE_CLAIM_SQL}
                 AND NOT EXISTS (SELECT 1 FROM queue_consumer_custody WHERE queue_id = ?)
                 AND NOT EXISTS (SELECT 1 FROM selfhost_queue_messages WHERE queue_id = ? AND lease_token IS NOT NULL)`,
              [
                queueId,
                execution.resourceUid,
                ...params,
                ...v2QueueClaimParams(claim),
                queueId,
                queueId,
              ],
            );
        if (write.changes !== 1) return UNKNOWN;
      } else if (
        row.state !== "active" ||
        row.consumer_id !== execution.resourceUid ||
        !samePolicy(row, spec, dlq)
      ) {
        return UNKNOWN;
      }
    } else {
      if (!row || row.consumer_id !== execution.resourceUid) return UNKNOWN;
      if (execution.action === "update" && row.state === "active" && samePolicy(row, spec, dlq)) {
        // A same-spec PUT is a new Host generation but has no new custody policy.
      } else if (row.state === "tombstone") {
        if (execution.action !== "delete") return UNKNOWN;
      } else {
        if (row.state === "active") {
          const begun = await sql.run(
            `UPDATE queue_consumer_custody SET state = 'retiring', retirement_started_at_ms = ?
             WHERE queue_id = ? AND consumer_id = ? AND generation = ? AND state = 'active'
               AND ${V2_QUEUE_CLAIM_SQL}`,
            [Date.now(), queueId, row.consumer_id, row.generation, ...v2QueueClaimParams(claim)],
          );
          if (begun.changes !== 1) return UNKNOWN;
        }
        const replacementGeneration = row.generation + 1;
        if (!Number.isSafeInteger(replacementGeneration)) return UNKNOWN;
        const replacement = execution.action === "update";
        const write = await sql.run(
          replacement
            ? `UPDATE queue_consumer_custody
               SET consumer_id = ?, generation = ?, state = 'active',
                   max_retries = ?, retry_delay_seconds = ?, dead_letter_queue_id = ?,
                   dead_letter_delivery_delay_seconds = ?, dead_letter_retention_seconds = ?,
                   retirement_started_at_ms = NULL
               WHERE queue_id = ? AND consumer_id = ? AND generation = ? AND state = 'retiring'
                 AND NOT EXISTS (SELECT 1 FROM selfhost_queue_messages
                   WHERE queue_id = ? AND lease_consumer_id = ? AND lease_generation = ? AND lease_token IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM queue_custody_transfer_notices
                   WHERE source_queue_id = ? AND source_consumer_id = ? AND source_generation = ?)
                 AND NOT EXISTS (SELECT 1 FROM queue_v2_batch_executions execution
                   WHERE execution.consumer_uid = ?
                     AND execution.state IN ('reserved','registered','send_authorized'))
                 AND ${V2_QUEUE_CLAIM_SQL}`
            : `UPDATE queue_consumer_custody SET state = 'tombstone', retirement_started_at_ms = NULL
               WHERE queue_id = ? AND consumer_id = ? AND generation = ? AND state = 'retiring'
                 AND NOT EXISTS (SELECT 1 FROM selfhost_queue_messages
                   WHERE queue_id = ? AND lease_consumer_id = ? AND lease_generation = ? AND lease_token IS NOT NULL)
                AND NOT EXISTS (SELECT 1 FROM queue_custody_transfer_notices
                   WHERE source_queue_id = ? AND source_consumer_id = ? AND source_generation = ?)
                 AND NOT EXISTS (SELECT 1 FROM queue_v2_batch_executions execution
                   WHERE execution.consumer_uid = ?
                     AND execution.state IN ('reserved','registered','send_authorized'))
                 AND ${V2_QUEUE_CLAIM_SQL}`,
          replacement
            ? [
                execution.resourceUid,
                replacementGeneration,
                ...policyParams(spec, dlq),
                queueId,
                row.consumer_id,
                row.generation,
                queueId,
                row.consumer_id,
                row.generation,
                queueId,
                row.consumer_id,
                row.generation,
                execution.resourceUid,
                ...v2QueueClaimParams(claim),
              ]
            : [
                queueId,
                row.consumer_id,
                row.generation,
                queueId,
                row.consumer_id,
                row.generation,
                queueId,
                row.consumer_id,
                row.generation,
                execution.resourceUid,
                ...v2QueueClaimParams(claim),
              ],
        );
        if (write.changes !== 1) {
          if (!(await ownsV2QueueClaim(sql, claim))) return UNKNOWN;
          return { kind: "continue" };
        }
      }
    }
    const final = await currentCustody(sql, queueId);
    if (!(await ownsV2QueueClaim(sql, claim)) || (serving && !(await serving.stillCurrent())))
      return UNKNOWN;
    const attached = execution.action !== "delete";
    if (
      !final ||
      final.consumer_id !== execution.resourceUid ||
      (attached && (final.state !== "active" || !samePolicy(final, spec, dlq))) ||
      (!attached && final.state !== "tombstone")
    )
      return UNKNOWN;
    return {
      kind: "complete",
      observed: attached
        ? { queueExists: true, workerExists: true, consumerAttached: true }
        : { consumerAttached: false },
      output: {},
    };
  }

  return {
    validateCreate(spec) {
      parseQueueConsumerSpec(spec);
    },
    validateUpdate(previous, spec) {
      validateQueueConsumerUpdate(previous, spec);
    },
    references(spec) {
      return queueConsumerReferences(parseQueueConsumerSpec(spec));
    },
    privateInputs: {
      validateCreate(_spec, inputs) {
        emptyPrivateInputs(inputs);
      },
      validateUpdate(_previous, _spec, inputs) {
        emptyPrivateInputs(inputs);
      },
    },
    backend: { id: V2_QUEUE_CONSUMER_BACKEND_ID, targetKey, execute: run, reconcile: run },
  };
}
