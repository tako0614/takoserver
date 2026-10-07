import type { Sql, SqlStatement } from "./ports.ts";

const MAX_MESSAGE_BYTES = 127_000;
const MAX_BATCH_MESSAGES = 100;
const MAX_DELIVERY_DELAY_SECONDS = 43_200;
const MIN_RETENTION_SECONDS = 60;
const MAX_RETENTION_SECONDS = 1_209_600;
const MAX_RETRIES = 100;
const MAX_LEASE_MILLIS = 120_000;
const MAX_REAP_MESSAGES = 50;
const MAX_CUSTODY_WINDOW_MESSAGES = MAX_BATCH_MESSAGES;
const MAX_BODY_QUERY_MESSAGES = 99;
const MAX_TRANSFER_NOTICE_LIST = 100;
const MAX_BATCH_TIMEOUT_SECONDS = 60;
const MAX_SAFE_GENERATION = Number.MAX_SAFE_INTEGER;
const SQL_NOW_MILLIS = `(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))`;
const NO_SENT_V2_EXECUTION = `AND NOT EXISTS (
  SELECT 1 FROM queue_v2_batch_executions execution
  WHERE execution.queue_id = selfhost_queue_messages.queue_id
    AND execution.consumer_uid = selfhost_queue_messages.lease_consumer_id
    AND execution.consumer_generation = selfhost_queue_messages.lease_generation
    AND execution.lease_token = selfhost_queue_messages.lease_token
    AND execution.state = 'send_authorized')`;
const MESSAGE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export interface QueueCustodyTarget {
  readonly queueId: string;
  readonly messageRetentionSeconds: number;
  readonly deliveryDelaySeconds: number;
}

export interface QueueCustodyAdmission {
  readonly messageId: string;
  readonly body: Uint8Array;
  readonly delaySeconds?: number;
}

/** Host-private selector; the SQL write must re-prove it, not trust this DTO. */
export interface QueueCustodyV2ProducerClaim {
  readonly principal: string;
  readonly space: string;
  readonly targetKey: string;
  readonly queueUid: string;
  readonly workerUid: string;
  readonly workerVersionUid: string;
  readonly workerVersionOperationId: string;
  readonly bindingName: string;
}

export type QueueCustodyDeadLetterTarget = QueueCustodyTarget;

export interface QueueCustodyRetryPolicy {
  readonly maxRetries: number;
  readonly retryDelaySeconds: number;
  readonly deadLetterQueue?: QueueCustodyDeadLetterTarget;
}

export interface QueueCustodyConsumerGeneration {
  readonly queueId: string;
  readonly consumerId: string;
  readonly generation: number;
  readonly policy: QueueCustodyRetryPolicy;
}

export interface QueueCustodyClaimedMessage {
  readonly queueId: string;
  readonly consumerId: string;
  readonly generation: number;
  readonly leaseToken: string;
  readonly messageId: string;
  readonly body: Uint8Array;
  readonly enqueuedAtMillis: number;
  readonly visibleAtMillis: number;
  readonly attempts: number;
  readonly policy: QueueCustodyRetryPolicy;
}

/** Retained evidence for one exact v2 batch claim, not another message ledger. */
export interface QueueCustodyBatchReceipt {
  readonly messageId: string;
  readonly state: "pending" | "settled";
  readonly outcome: "ack" | "retry" | null;
  readonly delaySeconds: number | null;
}

/** Host-private 0083 identity. This is a CAS selector, never tenant authority. */
export interface QueueCustodyV2ExecutionIdentity {
  readonly batchId: string;
  readonly reservationToken: string;
  readonly queueId: string;
  readonly consumerUid: string;
  readonly generation: number;
  readonly workerUid: string;
  readonly servingSourceOperationId: string;
  readonly workerVersionUid: string;
  readonly workerVersionGeneration: number;
  readonly incarnationOperationId: string;
}

/**
 * A durable marker that a terminal delivery created one message in a
 * dead-letter Queue. The marker carries no body or transport address: a
 * private caller resolves the target Queue through its own authority, wakes
 * it, then acknowledges this exact token.
 */
export interface QueueCustodyTransferNotice {
  readonly sourceQueueId: string;
  readonly sourceConsumerId: string;
  readonly sourceGeneration: number;
  readonly targetQueueId: string;
  readonly noticeToken: string;
}

export type QueueCustodyRetirementStatus =
  | { readonly state: "ready" }
  | { readonly state: "waiting"; readonly waitUntilMillis: number }
  | { readonly state: "reap"; readonly remainingAtLeast: 1 }
  | { readonly state: "notify"; readonly remainingAtLeast: 1 }
  | { readonly state: "tombstone" };

export type QueueCustodyRetirementCompletion =
  | { readonly state: "activated"; readonly generation: number }
  | { readonly state: "tombstone" }
  | { readonly state: "waiting"; readonly waitUntilMillis: number }
  | { readonly state: "reap"; readonly remainingAtLeast: 1 }
  | { readonly state: "notify"; readonly remainingAtLeast: 1 };

/**
 * A transport-neutral scheduling observation, never authority to deliver or
 * settle. The caller must still use `claim`, whose generation and lease
 * predicates arbitrate concurrent lifecycle changes.
 */
export type QueueCustodyReadiness =
  | { readonly state: "inactive" }
  | { readonly state: "idle" }
  | { readonly state: "ready" }
  | { readonly state: "waiting"; readonly wakeAtMillis: number };

export class QueueCustodyConflictError extends Error {
  constructor(message = "queue custody generation conflicts") {
    super(message);
    this.name = "QueueCustodyConflictError";
  }
}

export interface QueueCustody {
  admit(target: QueueCustodyTarget, message: QueueCustodyAdmission): Promise<void>;
  admitBatch(target: QueueCustodyTarget, messages: readonly QueueCustodyAdmission[]): Promise<void>;
  /** Atomic v2 Queue/Version/reference check and all-or-none producer admission. */
  admitV2Batch(input: {
    readonly claim: QueueCustodyV2ProducerClaim;
    readonly target: QueueCustodyTarget;
    readonly messages: readonly QueueCustodyAdmission[];
  }): Promise<boolean>;
  activateConsumer(generation: QueueCustodyConsumerGeneration): Promise<void>;
  readiness(input: {
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
    readonly maxBatchSize: number;
    readonly maxBatchTimeoutSeconds: number;
  }): Promise<QueueCustodyReadiness>;
  claim(input: {
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
    readonly limit: number;
    readonly leaseMillis?: number;
    /** Internal v2 attachment gate; fences DELETE/UPDATE acceptance in the lease write. */
    readonly v2Attachment?: {
      readonly principal: string;
      readonly space: string;
      readonly targetKey: string;
    };
    /** Exact pre-send execution reservation; never an authority to deliver by itself. */
    readonly v2Reservation?: { readonly batchId: string; readonly reservationToken: string };
  }): Promise<readonly QueueCustodyClaimedMessage[]>;
  release(message: QueueCustodyClaimedMessage, visibleAtMillis?: number): Promise<boolean>;
  settle(
    message: QueueCustodyClaimedMessage,
    decision: { readonly outcome: "ack" | "retry"; readonly delaySeconds?: number },
  ): Promise<boolean>;
  registerSettlementBatch(
    batchId: string,
    messages: readonly QueueCustodyClaimedMessage[],
    v2Reservation?: { readonly reservationToken: string },
  ): Promise<void>;
  readSettlementBatch(input: {
    readonly batchId: string;
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
  }): Promise<readonly QueueCustodyBatchReceipt[]>;
  settleBatchMessage(input: {
    readonly batchId: string;
    readonly message: QueueCustodyClaimedMessage;
    readonly decision: { readonly outcome: "ack" | "retry"; readonly delaySeconds?: number };
    readonly settlementToken: string;
  }): Promise<"settled" | "already_settled" | "unknown_batch" | "unknown_message" | "unavailable">;
  /** Trusted transport-only settlement by an already registered, exact SQL claim. */
  settleRegisteredBatchMessage(input: {
    readonly batchId: string;
    readonly messageId: string;
    readonly expected: {
      readonly queueId: string;
      readonly consumerId: string;
      readonly generation: number;
      readonly leaseToken: string;
    };
    readonly decision: { readonly outcome: "ack" | "retry"; readonly delaySeconds?: number };
    readonly settlementToken: string;
  }): Promise<"settled" | "already_settled" | "unknown_batch" | "unknown_message" | "unavailable">;
  /** Extend only all still-live pending 0082 leases of one exact sent 0083 execution. */
  renewRegisteredV2BatchLeases(
    execution: QueueCustodyV2ExecutionIdentity,
  ): Promise<"renewed" | "no_pending" | "unknown">;
  listTransferNotices(input: {
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
    readonly limit?: number;
  }): Promise<readonly QueueCustodyTransferNotice[]>;
  acknowledgeTransferNotice(input: {
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
    readonly targetQueueId: string;
    readonly noticeToken: string;
  }): Promise<boolean>;
  sweepExpired(limit?: number): Promise<number>;
  beginRetirement(input: {
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
  }): Promise<QueueCustodyRetirementStatus>;
  reapRetired(input: {
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
    readonly limit?: number;
  }): Promise<QueueCustodyRetirementStatus>;
  /** Internal v2 retiring maintenance; every write is batched with the live Operation fence. */
  reapRetiredV2(input: {
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
    readonly limit?: number;
    readonly operationClaim: {
      readonly operationId: string;
      readonly leaseToken: string;
      readonly resourceUid: string;
      readonly principal: string;
      readonly form: string;
      readonly space: string;
      readonly name: string;
      readonly backendId: string;
      readonly targetKey: string;
      readonly backendKey: string;
      readonly action: string;
      readonly generation: number;
      readonly specJson: string;
    };
  }): Promise<QueueCustodyRetirementStatus>;
  finishRetirement(input: {
    readonly queueId: string;
    readonly consumerId: string;
    readonly generation: number;
    readonly replacement?: QueueCustodyConsumerGeneration;
  }): Promise<QueueCustodyRetirementCompletion>;
}

export interface QueueCustodyOptions {
  readonly sql: Sql;
  readonly clock?: () => Date;
  readonly randomId?: () => string;
}

type V2ReapClaim = Parameters<QueueCustody["reapRetiredV2"]>[0]["operationClaim"];
const V2_REAP_DB_NOW = `(CAST(strftime('%s', 'now') AS INTEGER) * 1000
  + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))`;
const V2_QUEUE_FORM = "https://edge.forms.takoform.com/forms/AtLeastOnceQueue/0.2.0/";
const V2_VERSION_FORM = "https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/";
const V2_QUEUE_BACKEND = "selfhost-v2-at-least-once-queue-sql-v1";
// Evaluated for every INSERT inside the same BEGIN IMMEDIATE/implicit D1 batch.
// No pre-read can turn a concurrently accepted Queue DELETE into an admission.
const V2_PRODUCER_GUARD = `EXISTS (
  SELECT 1 FROM tf_v2_resources queue
  JOIN tf_v2_operations queue_op ON queue_op.id = queue.last_operation
  JOIN tf_v2_resources version ON version.uid = ?
  JOIN tf_v2_operations version_op ON version_op.id = version.last_operation
  JOIN tf_v2_operations source_op ON source_op.id = ?
  JOIN tf_v2_operation_reference_sets refs ON refs.operation_id = version_op.id
  JOIN tf_v2_operation_references ref ON ref.operation_id = refs.operation_id
  JOIN tf_v2_resource_references edge ON edge.referrer_uid = version.uid
  WHERE queue.uid = ? AND queue.form_url = '${V2_QUEUE_FORM}'
    AND queue.backend_id = '${V2_QUEUE_BACKEND}'
    AND queue.principal = ? AND queue.space = ? AND queue.target_key = ?
    AND queue.deleted_at IS NULL AND queue.phase = 'idle'
    AND queue.busy_operation IS NULL AND queue.observed_generation = queue.generation
    AND json_type(queue.observed_json, '$.queueExists') = 'true'
    AND queue_op.resource_uid = queue.uid AND queue_op.principal = queue.principal
    AND queue_op.backend_id = queue.backend_id AND queue_op.target_key = queue.target_key
    AND queue_op.generation = queue.generation AND queue_op.status = 'succeeded'
    AND queue_op.effect = 'complete' AND queue_op.action IN ('create','update')
    AND queue_op.accepted_spec_json = queue.spec_json
    AND json_extract(queue.spec_json, '$.messageRetentionSeconds') = ?
    AND COALESCE(json_extract(queue.spec_json, '$.deliveryDelaySeconds'), 0) = ?
    AND version.form_url = '${V2_VERSION_FORM}'
    AND version.principal = queue.principal AND version.space = queue.space
    AND version.target_key = queue.target_key AND version.deleted_at IS NULL
    AND version.phase = 'idle' AND version.busy_operation IS NULL
    AND version.observed_generation = version.generation
    AND json_type(version.observed_json, '$.ready') = 'true'
    AND version_op.resource_uid = version.uid AND version_op.principal = version.principal
    AND version_op.backend_id = version.backend_id
    AND version_op.target_key = version.target_key
    AND version_op.generation = version.generation
    AND version_op.status = 'succeeded' AND version_op.effect = 'complete'
    AND version_op.action IN ('create','update')
    AND version_op.accepted_spec_json = version.spec_json
    AND source_op.resource_uid = version.uid AND source_op.principal = version.principal
    AND source_op.backend_id = version.backend_id
    AND source_op.target_key = version.target_key
    AND source_op.generation <= version.generation
    AND source_op.status = 'succeeded' AND source_op.effect = 'complete'
    AND source_op.action IN ('create','update')
    AND source_op.accepted_spec_json = version.spec_json
    AND json_extract(version.spec_json, '$.worker.resourceUid') = ?
    AND EXISTS (SELECT 1 FROM json_each(version.spec_json, '$.queueProducerBindings') binding
      WHERE json_extract(binding.value, '$.name') = ?
        AND json_extract(binding.value, '$.resource.resourceUid') = queue.uid)
    AND refs.sealed = 1 AND ref.target_uid = queue.uid
    AND ref.form_url = queue.form_url AND ref.readiness = 'observed'
    AND edge.target_uid = queue.uid
)`;
// This SELECT runs as the first statement of the same atomic Sql.batch as
// all message/notice writes. A false claim deliberately raises a SQLite
// malformed-JSON error, rolling the batch back before any custody mutation.
const V2_REAP_GUARD_SQL = `SELECT CASE WHEN EXISTS (
  SELECT 1 FROM tf_v2_operations op
  JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
  WHERE op.id = ? AND op.lease_token = ? AND op.resource_uid = ?
    AND op.principal = ? AND op.backend_id = ? AND op.target_key = ?
    AND op.backend_key = ? AND op.action = ? AND op.generation = ?
    AND op.accepted_spec_json = ? AND op.status = 'reconciling'
    AND op.dispatch_possible = 1 AND op.lease_until_ms > ${V2_REAP_DB_NOW}
    AND resource.uid = ? AND resource.principal = ? AND resource.form_url = ?
    AND resource.space = ? AND resource.name = ?
    AND resource.backend_id = ? AND resource.target_key = ?
    AND resource.generation = op.generation AND resource.spec_json = op.accepted_spec_json
    AND resource.last_operation = op.id AND resource.busy_operation = op.id
    AND resource.deleted_at IS NULL
) THEN 1 ELSE json_extract('{', '$') END AS authorized`;

function v2ReapGuard(claim: V2ReapClaim): SqlStatement {
  return {
    sql: V2_REAP_GUARD_SQL,
    params: [
      claim.operationId,
      claim.leaseToken,
      claim.resourceUid,
      claim.principal,
      claim.backendId,
      claim.targetKey,
      claim.backendKey,
      claim.action,
      claim.generation,
      claim.specJson,
      claim.resourceUid,
      claim.principal,
      claim.form,
      claim.space,
      claim.name,
      claim.backendId,
      claim.targetKey,
    ],
  };
}

/**
 * Durable Queue message custody shared by self-host and managed transports.
 *
 * Runtime transport is deliberately absent. A pump may wake however its host
 * permits and may invoke a Worker through workerd or WfP, but admission,
 * visibility, attempts, leases, settlement and dead-letter transfer remain in
 * this SQL owner. Consumer replacement is two-phase: `beginRetirement` stops
 * new claims, then `finishRetirement` can advance only after every exact old
 * generation lease reached its durable deadline.
 */
export function createQueueCustody(options: QueueCustodyOptions): QueueCustody {
  if (!options?.sql) throw new TypeError("queue custody SQL is required");
  const sql = options.sql;
  const clock = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());

  const now = (): number => {
    const value = clock().getTime();
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError("queue custody clock is invalid");
    }
    return value;
  };

  const admissionStatements = (
    targetValue: QueueCustodyTarget,
    messageValues: readonly QueueCustodyAdmission[],
  ): readonly SqlStatement[] => {
    const target = queueTarget(targetValue);
    if (messageValues.length < 1 || messageValues.length > MAX_BATCH_MESSAGES) {
      throw new TypeError("queue custody admission batch is invalid");
    }
    const acceptedAt = now();
    return messageValues.map((value) => {
      const message = admission(value);
      const delay =
        message.delaySeconds === undefined
          ? target.deliveryDelaySeconds
          : delaySeconds(message.delaySeconds, "queue custody delivery delay is invalid");
      return {
        sql:
          "INSERT INTO selfhost_queue_messages " +
          "(queue_id, message_id, body, enqueued_at_ms, visible_at_ms, expires_at_ms, deliveries) " +
          "VALUES (?, ?, ?, ?, ?, ?, 0)",
        params: [
          target.queueId,
          message.messageId,
          arrayBuffer(message.body),
          acceptedAt,
          acceptedAt + delay * 1_000,
          acceptedAt + target.messageRetentionSeconds * 1_000,
        ],
      };
    });
  };

  const readGeneration = async (
    identity: Pick<QueueCustodyConsumerGeneration, "queueId" | "consumerId" | "generation">,
  ): Promise<
    | (QueueCustodyConsumerGeneration & {
        readonly state: "active" | "retiring" | "tombstone";
      })
    | null
  > => {
    const selected = generationIdentity(identity);
    const rows = await sql.query(
      `SELECT consumer_id, generation, state, max_retries, retry_delay_seconds,
              dead_letter_queue_id, dead_letter_delivery_delay_seconds,
              dead_letter_retention_seconds
       FROM queue_consumer_custody
       WHERE queue_id = ?`,
      [selected.queueId],
    );
    const row = rows[0];
    if (!row) return null;
    const state = row.state;
    if (state !== "active" && state !== "retiring" && state !== "tombstone") {
      throw new Error("queue custody state is corrupt");
    }
    const current = {
      queueId: selected.queueId,
      consumerId: stringValue(row.consumer_id),
      generation: integer(row.generation),
      state,
      policy: policyFromRow(row),
    } as const;
    return current;
  };

  const retirementStatus = async (
    identity: QueueCustodyConsumerGeneration,
    millis: number,
  ): Promise<QueueCustodyRetirementStatus> => {
    const current = await readGeneration(identity);
    if (
      !current ||
      current.consumerId !== identity.consumerId ||
      current.generation !== identity.generation
    ) {
      throw new QueueCustodyConflictError();
    }
    if (current.state === "tombstone") return { state: "tombstone" };
    if (current.state !== "retiring") throw new QueueCustodyConflictError();
    const rows = await sql.query(
      `SELECT lease_expires_at_ms
       FROM selfhost_queue_messages INDEXED BY selfhost_queue_messages_custody_lease
       WHERE queue_id = ? AND lease_consumer_id = ? AND lease_generation = ?
       ORDER BY lease_expires_at_ms LIMIT 1`,
      [identity.queueId, identity.consumerId, identity.generation],
    );
    const wait = nullableInteger(rows[0]?.lease_expires_at_ms);
    if (wait !== null) {
      return wait <= millis
        ? { state: "reap", remainingAtLeast: 1 }
        : { state: "waiting", waitUntilMillis: wait };
    }
    const notices = await sql.query(
      `SELECT target_queue_id, notice_token
       FROM queue_custody_transfer_notices
       WHERE source_queue_id = ? AND source_consumer_id = ? AND source_generation = ?
       ORDER BY target_queue_id LIMIT 1`,
      [identity.queueId, identity.consumerId, identity.generation],
    );
    if (notices.length > 0) return { state: "notify", remainingAtLeast: 1 };
    return { state: "ready" };
  };

  /**
   * Build the one terminal lease transaction used by explicit settlement,
   * active crash recovery and retirement. The source guard includes the whole
   * snapshotted terminal policy; a stale or reinterpreted lease changes
   * neither source nor dead-letter queue.
   */
  const terminalLeaseStatements = (
    lease: {
      readonly queueId: string;
      readonly messageId: string;
      readonly leaseToken: string;
      readonly consumerId: string;
      readonly generation: number;
      readonly attempts: number;
      readonly maxRetries: number;
      readonly retryDelaySeconds: number;
      readonly target?: QueueCustodyDeadLetterTarget;
      readonly leaseExpiresAtMillis?: number;
      /** Maintenance may never take a message from a sent native execution. */
      readonly reapOnly?: boolean;
    },
    millis: number,
    providedDeadLetterId?: string,
  ): readonly SqlStatement[] => {
    const target = lease.target;
    const expirySql =
      lease.leaseExpiresAtMillis === undefined ? "" : " AND lease_expires_at_ms = ?";
    const sentGuardSql = lease.reapOnly ? ` ${NO_SENT_V2_EXECUTION}` : "";
    const sourceParams = [
      lease.queueId,
      lease.messageId,
      lease.leaseToken,
      lease.consumerId,
      lease.generation,
      lease.attempts,
      lease.maxRetries,
      lease.retryDelaySeconds,
      target?.queueId ?? null,
      target?.deliveryDelaySeconds ?? null,
      target?.messageRetentionSeconds ?? null,
      ...(lease.leaseExpiresAtMillis === undefined ? [] : [lease.leaseExpiresAtMillis]),
      lease.queueId,
      lease.consumerId,
      lease.generation,
    ] as const;
    const removal: SqlStatement = {
      sql: `DELETE FROM selfhost_queue_messages
         WHERE queue_id = ? AND message_id = ? AND lease_token = ?
           AND lease_consumer_id = ? AND lease_generation = ?
           AND deliveries = ? AND lease_max_retries = ?
           AND lease_retry_delay_seconds = ?
           AND lease_dead_letter_queue_id IS ?
           AND lease_dead_letter_delivery_delay_seconds IS ?
           AND lease_dead_letter_retention_seconds IS ?${expirySql}
           AND EXISTS (
             SELECT 1 FROM queue_consumer_custody
             WHERE queue_id = ? AND consumer_id = ? AND generation = ?
               AND state IN ('active', 'retiring')
           )${sentGuardSql}`,
      params: sourceParams,
    };
    if (!target) return [removal];
    const deadLetterId = providedDeadLetterId ?? randomId();
    messageId(deadLetterId);
    return [
      {
        sql: `INSERT INTO selfhost_queue_messages
             (queue_id, message_id, body, enqueued_at_ms, visible_at_ms,
              expires_at_ms, deliveries)
           SELECT lease_dead_letter_queue_id, ?, body, ?,
                  ? + lease_dead_letter_delivery_delay_seconds * 1000,
                  ? + lease_dead_letter_retention_seconds * 1000, 0
           FROM selfhost_queue_messages
           WHERE queue_id = ? AND message_id = ? AND lease_token = ?
             AND lease_consumer_id = ? AND lease_generation = ?
             AND deliveries = ? AND lease_max_retries = ?
             AND lease_retry_delay_seconds = ?
             AND lease_dead_letter_queue_id IS ?
             AND lease_dead_letter_delivery_delay_seconds IS ?
             AND lease_dead_letter_retention_seconds IS ?${expirySql}
             AND EXISTS (
               SELECT 1 FROM queue_consumer_custody
               WHERE queue_id = ? AND consumer_id = ? AND generation = ?
                 AND state IN ('active', 'retiring')
             )${sentGuardSql}`,
        params: [deadLetterId, millis, millis, millis, ...sourceParams],
      },
      {
        sql: `INSERT INTO queue_custody_transfer_notices
             (source_queue_id, source_consumer_id, source_generation,
              target_queue_id, notice_token)
           SELECT queue_id, lease_consumer_id, lease_generation,
                  lease_dead_letter_queue_id, ?
           FROM selfhost_queue_messages
           WHERE queue_id = ? AND message_id = ? AND lease_token = ?
             AND lease_consumer_id = ? AND lease_generation = ?
             AND deliveries = ? AND lease_max_retries = ?
             AND lease_retry_delay_seconds = ?
             AND lease_dead_letter_queue_id IS ?
             AND lease_dead_letter_delivery_delay_seconds IS ?
             AND lease_dead_letter_retention_seconds IS ?${expirySql}
             AND EXISTS (
               SELECT 1 FROM queue_consumer_custody
               WHERE queue_id = ? AND consumer_id = ? AND generation = ?
                 AND state IN ('active', 'retiring')
             )${sentGuardSql}
           ON CONFLICT (source_queue_id, source_consumer_id, source_generation, target_queue_id)
           DO UPDATE SET notice_token = excluded.notice_token`,
        params: [deadLetterId, ...sourceParams],
      },
      removal,
    ];
  };

  /** Reap one bounded page of exact expired leases under their snapshotted policy. */
  const reapExpiredLeases = async (
    identity: Pick<QueueCustodyConsumerGeneration, "queueId" | "consumerId" | "generation">,
    millis: number,
    limit: number,
    v2OperationClaim?: V2ReapClaim,
  ): Promise<boolean> => {
    const rows = await sql.query(
      `SELECT message_id, enqueued_at_ms, visible_at_ms, expires_at_ms,
              lease_token, lease_expires_at_ms, deliveries, lease_max_retries,
              lease_retry_delay_seconds,
              lease_dead_letter_queue_id,
              lease_dead_letter_delivery_delay_seconds,
              lease_dead_letter_retention_seconds,
              (SELECT execution.state FROM queue_v2_batch_executions execution
               WHERE execution.queue_id = message.queue_id
                 AND execution.consumer_uid = message.lease_consumer_id
                 AND execution.consumer_generation = message.lease_generation
                 AND execution.lease_token = message.lease_token) AS execution_state,
              (SELECT execution.reservation_until_ms FROM queue_v2_batch_executions execution
               WHERE execution.queue_id = message.queue_id
                 AND execution.consumer_uid = message.lease_consumer_id
                 AND execution.consumer_generation = message.lease_generation
                 AND execution.lease_token = message.lease_token) AS execution_until_ms
       FROM selfhost_queue_messages AS message INDEXED BY selfhost_queue_messages_custody_lease
       WHERE queue_id = ? AND lease_consumer_id = ? AND lease_generation = ?
         AND lease_expires_at_ms <= ?
         AND NOT EXISTS (SELECT 1 FROM queue_v2_batch_executions protected
           WHERE protected.queue_id = message.queue_id
             AND protected.consumer_uid = message.lease_consumer_id
             AND protected.consumer_generation = message.lease_generation
             AND protected.lease_token = message.lease_token
             AND protected.state = 'send_authorized')
       ORDER BY lease_expires_at_ms LIMIT ?`,
      [identity.queueId, identity.consumerId, identity.generation, millis, limit],
    );
    if (rows.length === 0) return false;
    const statements: SqlStatement[] = [];
    for (const row of rows) {
      const id = messageId(row.message_id);
      const enqueuedAt = positiveStoredInteger(row.enqueued_at_ms);
      const visibleAt = positiveStoredInteger(row.visible_at_ms);
      const expiresAt = positiveStoredInteger(row.expires_at_ms);
      const leaseToken = token(row.lease_token, 128, "queue custody lease token");
      const leaseExpiresAt = positiveStoredInteger(row.lease_expires_at_ms);
      const deliveries = positiveStoredInteger(row.deliveries);
      const maxRetries = nonNegativeStoredInteger(row.lease_max_retries);
      const retryDelaySeconds = nonNegativeStoredInteger(row.lease_retry_delay_seconds);
      const target = leaseTargetFromRow(row);
      // An unconfirmed native handler may still be using this exact message.
      // Expired delivery time is not proof of handler+waitUntil retirement.
      if (row.execution_state === "send_authorized") continue;
      const snapshotParams = [
        identity.queueId,
        id,
        enqueuedAt,
        visibleAt,
        expiresAt,
        deliveries,
        leaseToken,
        leaseExpiresAt,
        identity.consumerId,
        identity.generation,
        maxRetries,
        retryDelaySeconds,
        target?.queueId ?? null,
        target?.deliveryDelaySeconds ?? null,
        target?.messageRetentionSeconds ?? null,
        identity.queueId,
        identity.consumerId,
        identity.generation,
      ] as const;
      if (expiresAt <= millis) {
        statements.push({
          sql: `DELETE FROM selfhost_queue_messages
             WHERE queue_id = ? AND message_id = ? AND enqueued_at_ms = ?
               AND visible_at_ms = ? AND expires_at_ms = ? AND deliveries = ?
               AND lease_token = ? AND lease_expires_at_ms = ?
               AND lease_consumer_id = ? AND lease_generation = ?
               AND lease_max_retries = ? AND lease_retry_delay_seconds = ?
               AND lease_dead_letter_queue_id IS ?
               AND lease_dead_letter_delivery_delay_seconds IS ?
               AND lease_dead_letter_retention_seconds IS ?
               AND expires_at_ms <= ?
               AND EXISTS (
                 SELECT 1 FROM queue_consumer_custody
                 WHERE queue_id = ? AND consumer_id = ? AND generation = ?
                   AND state IN ('active', 'retiring')
               ) ${NO_SENT_V2_EXECUTION}`,
          params: [...snapshotParams.slice(0, 15), millis, ...snapshotParams.slice(15)],
        });
        continue;
      }
      if (
        row.execution_state === "reserved" ||
        row.execution_state === "registered" ||
        row.execution_state === "pre_effect_refused"
      ) {
        const until = positiveStoredInteger(row.execution_until_ms);
        // Before this DB-time deadline, a registered sender could still win
        // authorization. Never refund an attempt that might have been sent.
        if (row.execution_state !== "pre_effect_refused" && until > millis) continue;
        statements.push({
          sql: `UPDATE selfhost_queue_messages
             SET visible_at_ms = ?,
                 deliveries = CASE WHEN deliveries > 0 THEN deliveries - 1 ELSE 0 END,
                 lease_token = NULL, lease_expires_at_ms = NULL,
                 lease_consumer_id = NULL, lease_generation = NULL,
                 lease_max_retries = NULL, lease_retry_delay_seconds = NULL,
                 lease_dead_letter_queue_id = NULL,
                 lease_dead_letter_delivery_delay_seconds = NULL,
                 lease_dead_letter_retention_seconds = NULL
             WHERE queue_id = ? AND message_id = ? AND enqueued_at_ms = ?
               AND visible_at_ms = ? AND expires_at_ms = ? AND deliveries = ?
               AND lease_token = ? AND lease_expires_at_ms = ?
               AND lease_consumer_id = ? AND lease_generation = ?
               AND lease_max_retries = ? AND lease_retry_delay_seconds = ?
               AND lease_dead_letter_queue_id IS ?
               AND lease_dead_letter_delivery_delay_seconds IS ?
               AND lease_dead_letter_retention_seconds IS ?
               AND EXISTS (SELECT 1 FROM queue_v2_batch_executions execution
                 WHERE execution.queue_id = selfhost_queue_messages.queue_id
                   AND execution.consumer_uid = selfhost_queue_messages.lease_consumer_id
                   AND execution.consumer_generation = selfhost_queue_messages.lease_generation
                   AND execution.lease_token = selfhost_queue_messages.lease_token
                   AND (execution.state = 'pre_effect_refused' OR
                     (execution.state IN ('reserved','registered') AND
                      execution.reservation_until_ms <=
                        (CAST(strftime('%s', 'now') AS INTEGER) * 1000
                         + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))))`,
          params: [millis, ...snapshotParams.slice(0, 15)],
        });
        continue;
      }
      if (deliveries < 1 + maxRetries) {
        const retryAt = Math.max(
          visibleAt,
          safeFutureMillis(leaseExpiresAt, retryDelaySeconds * 1_000),
        );
        statements.push({
          sql: `UPDATE selfhost_queue_messages
             SET visible_at_ms = ?, lease_token = NULL, lease_expires_at_ms = NULL,
                 lease_consumer_id = NULL, lease_generation = NULL,
                 lease_max_retries = NULL, lease_retry_delay_seconds = NULL,
                 lease_dead_letter_queue_id = NULL,
                 lease_dead_letter_delivery_delay_seconds = NULL,
                 lease_dead_letter_retention_seconds = NULL
             WHERE queue_id = ? AND message_id = ? AND enqueued_at_ms = ?
               AND visible_at_ms = ? AND expires_at_ms = ? AND deliveries = ?
               AND lease_token = ? AND lease_expires_at_ms = ?
               AND lease_consumer_id = ? AND lease_generation = ?
               AND lease_max_retries = ? AND lease_retry_delay_seconds = ?
               AND lease_dead_letter_queue_id IS ?
               AND lease_dead_letter_delivery_delay_seconds IS ?
               AND lease_dead_letter_retention_seconds IS ?
               AND expires_at_ms > ?
               AND EXISTS (
                 SELECT 1 FROM queue_consumer_custody
                 WHERE queue_id = ? AND consumer_id = ? AND generation = ?
                   AND state IN ('active', 'retiring')
               ) ${NO_SENT_V2_EXECUTION}`,
          params: [retryAt, ...snapshotParams.slice(0, 15), millis, ...snapshotParams.slice(15)],
        });
        continue;
      }
      statements.push(
        ...terminalLeaseStatements(
          {
            queueId: identity.queueId,
            messageId: id,
            leaseToken,
            consumerId: identity.consumerId,
            generation: identity.generation,
            attempts: deliveries,
            maxRetries,
            retryDelaySeconds,
            ...(target ? { target } : {}),
            leaseExpiresAtMillis: leaseExpiresAt,
            reapOnly: true,
          },
          millis,
        ),
      );
    }
    if (statements.length > 0)
      await sql.batch(
        v2OperationClaim ? [v2ReapGuard(v2OperationClaim), ...statements] : statements,
      );
    return true;
  };

  const settlementRows = async (batchId: string) =>
    await sql.query(
      `SELECT batch_id, queue_id, consumer_id, generation, lease_token, message_id,
              attempts, max_retries, retry_delay_seconds, dead_letter_queue_id,
              dead_letter_delivery_delay_seconds, dead_letter_retention_seconds,
              state, outcome, delay_seconds, settlement_token
       FROM queue_v2_batch_settlements WHERE batch_id = ? ORDER BY message_id`,
      [batchId],
    );

  const sameSettlementClaim = (
    row: Readonly<Record<string, unknown>>,
    batchId: string,
    message: QueueCustodyClaimedMessage,
  ): boolean => {
    const deadLetter = message.policy.deadLetterQueue;
    return (
      row.batch_id === batchId &&
      row.queue_id === message.queueId &&
      row.consumer_id === message.consumerId &&
      row.generation === message.generation &&
      row.lease_token === message.leaseToken &&
      row.message_id === message.messageId &&
      row.attempts === message.attempts &&
      row.max_retries === message.policy.maxRetries &&
      row.retry_delay_seconds === message.policy.retryDelaySeconds &&
      row.dead_letter_queue_id === (deadLetter?.queueId ?? null) &&
      row.dead_letter_delivery_delay_seconds === (deadLetter?.deliveryDelaySeconds ?? null) &&
      row.dead_letter_retention_seconds === (deadLetter?.messageRetentionSeconds ?? null)
    );
  };

  const readUnleasedWindow = async (
    queueId: string,
  ): Promise<readonly Readonly<Record<string, unknown>>[]> =>
    await sql.query(
      `SELECT message_id, enqueued_at_ms, visible_at_ms, expires_at_ms, deliveries
       FROM selfhost_queue_messages INDEXED BY selfhost_queue_messages_custody_ready
       WHERE queue_id = ? AND lease_token IS NULL
       ORDER BY visible_at_ms LIMIT ?`,
      [queueId, MAX_CUSTODY_WINDOW_MESSAGES],
    );

  /**
   * Make one bounded page of retention/final-attempt progress from an already
   * bounded unleased window. Every mutation rechecks the exact active
   * generation and every observed message field; a concurrent claim or
   * generation transition turns it into a no-op.
   */
  const progressActiveWindow = async (
    active: QueueCustodyConsumerGeneration,
    millis: number,
    rows: readonly Readonly<Record<string, unknown>>[],
  ): Promise<boolean> => {
    const statements: SqlStatement[] = [];
    const target = active.policy.deadLetterQueue;
    let maintenance = 0;
    for (const row of rows) {
      if (maintenance >= MAX_REAP_MESSAGES) break;
      const id = messageId(row.message_id);
      const enqueuedAt = positiveStoredInteger(row.enqueued_at_ms);
      const visibleAt = positiveStoredInteger(row.visible_at_ms);
      const expiresAt = positiveStoredInteger(row.expires_at_ms);
      const deliveries = nonNegativeStoredInteger(row.deliveries);
      if (expiresAt <= millis) {
        maintenance += 1;
        statements.push({
          sql: `DELETE FROM selfhost_queue_messages
             WHERE queue_id = ? AND message_id = ? AND enqueued_at_ms = ?
               AND visible_at_ms = ? AND expires_at_ms = ? AND deliveries = ?
               AND lease_token IS NULL AND expires_at_ms <= ?
               AND EXISTS (
                 SELECT 1 FROM queue_consumer_custody
                 WHERE queue_id = ? AND consumer_id = ? AND generation = ?
                   AND state = 'active'
               )`,
          params: [
            active.queueId,
            id,
            enqueuedAt,
            visibleAt,
            expiresAt,
            deliveries,
            millis,
            active.queueId,
            active.consumerId,
            active.generation,
          ],
        });
        continue;
      }
      if (visibleAt > millis || deliveries < 1 + active.policy.maxRetries) continue;
      maintenance += 1;
      const leaseToken = randomId();
      token(leaseToken, 128, "queue custody lease token");
      const leaseExpiresAt = safeFutureMillis(millis, MAX_LEASE_MILLIS);
      statements.push({
        sql: `UPDATE selfhost_queue_messages
           SET lease_token = ?, lease_expires_at_ms = ?, lease_consumer_id = ?,
               lease_generation = ?, lease_max_retries = ?,
               lease_retry_delay_seconds = ?, lease_dead_letter_queue_id = ?,
               lease_dead_letter_delivery_delay_seconds = ?,
               lease_dead_letter_retention_seconds = ?
           WHERE queue_id = ? AND message_id = ? AND enqueued_at_ms = ?
             AND visible_at_ms = ? AND expires_at_ms = ? AND deliveries = ?
             AND lease_token IS NULL AND visible_at_ms <= ? AND expires_at_ms > ?
             AND EXISTS (
               SELECT 1 FROM queue_consumer_custody
               WHERE queue_id = ? AND consumer_id = ? AND generation = ?
                 AND state = 'active'
             )`,
        params: [
          leaseToken,
          leaseExpiresAt,
          active.consumerId,
          active.generation,
          active.policy.maxRetries,
          active.policy.retryDelaySeconds,
          target?.queueId ?? null,
          target?.deliveryDelaySeconds ?? null,
          target?.messageRetentionSeconds ?? null,
          active.queueId,
          id,
          enqueuedAt,
          visibleAt,
          expiresAt,
          deliveries,
          millis,
          millis,
          active.queueId,
          active.consumerId,
          active.generation,
        ],
      });
      statements.push(
        ...terminalLeaseStatements(
          {
            queueId: active.queueId,
            messageId: id,
            leaseToken,
            consumerId: active.consumerId,
            generation: active.generation,
            attempts: deliveries,
            maxRetries: active.policy.maxRetries,
            retryDelaySeconds: active.policy.retryDelaySeconds,
            ...(target ? { target } : {}),
            leaseExpiresAtMillis: leaseExpiresAt,
          },
          millis,
        ),
      );
    }
    if (statements.length === 0) return false;
    await sql.batch(statements);
    return true;
  };

  return {
    async admit(target, message) {
      const statements = admissionStatements(target, [message]);
      const statement = statements[0];
      if (!statement) throw new TypeError("queue custody admission is invalid");
      await sql.run(statement.sql, statement.params);
    },

    async admitBatch(target, messages) {
      await sql.batch(admissionStatements(target, messages));
    },

    async admitV2Batch({ claim, target, messages }) {
      if (
        !claim?.principal ||
        !claim.space ||
        !claim.targetKey ||
        !claim.queueUid ||
        !claim.workerUid ||
        !claim.workerVersionUid ||
        !claim.workerVersionOperationId ||
        !claim.bindingName ||
        target.queueId !== `takoform-v2-queue:${claim.queueUid}`
      ) {
        throw new TypeError("v2 Queue producer admission identity is invalid");
      }
      const statements = admissionStatements(target, messages).map((statement): SqlStatement => {
        const suffix = "VALUES (?, ?, ?, ?, ?, ?, 0)";
        if (!statement.sql.endsWith(suffix)) {
          throw new Error("Queue admission statement changed unexpectedly");
        }
        return {
          sql: `${statement.sql.slice(0, -suffix.length)}SELECT ?, ?, ?, ?, ?, ?, 0 WHERE ${V2_PRODUCER_GUARD}`,
          params: [
            ...(statement.params ?? []),
            claim.workerVersionUid,
            claim.workerVersionOperationId,
            claim.queueUid,
            claim.principal,
            claim.space,
            claim.targetKey,
            target.messageRetentionSeconds,
            target.deliveryDelaySeconds,
            claim.workerUid,
            claim.bindingName,
          ],
        };
      });
      const writes = await sql.batch(statements);
      if (writes.every((write) => write.changes === 1)) return true;
      if (writes.every((write) => write.changes === 0)) return false;
      throw new Error("v2 Queue producer admission was not atomic");
    },

    async activateConsumer(value) {
      const selected = generation(value);
      const policy = selected.policy;
      const target = policy.deadLetterQueue;
      if (selected.generation !== 1) {
        const predecessorRows = await sql.query(
          `SELECT consumer_id, generation, state
           FROM queue_consumer_custody WHERE queue_id = ?`,
          [selected.queueId],
        );
        const predecessor = predecessorRows[0];
        if (
          predecessor?.state === "tombstone" &&
          integer(predecessor.generation) + 1 === selected.generation
        ) {
          const reactivated = await sql.run(
            `UPDATE queue_consumer_custody
             SET consumer_id = ?, generation = ?, state = 'active',
                 max_retries = ?, retry_delay_seconds = ?, dead_letter_queue_id = ?,
                 dead_letter_delivery_delay_seconds = ?,
                 dead_letter_retention_seconds = ?, retirement_started_at_ms = NULL
             WHERE queue_id = ? AND consumer_id = ? AND generation = ?
               AND state = 'tombstone'`,
            [
              selected.consumerId,
              selected.generation,
              policy.maxRetries,
              policy.retryDelaySeconds,
              target?.queueId ?? null,
              target?.deliveryDelaySeconds ?? null,
              target?.messageRetentionSeconds ?? null,
              selected.queueId,
              stringValue(predecessor.consumer_id),
              integer(predecessor.generation),
            ],
          );
          if (reactivated.changes === 1) return;
        }
        const current = await readGeneration(selected);
        if (
          current?.state === "active" &&
          current.consumerId === selected.consumerId &&
          current.generation === selected.generation &&
          samePolicy(current.policy, selected.policy)
        ) {
          return;
        }
        throw new QueueCustodyConflictError();
      }
      const inserted = await sql.run(
        `INSERT INTO queue_consumer_custody
           (queue_id, consumer_id, generation, state, max_retries,
            retry_delay_seconds, dead_letter_queue_id,
            dead_letter_delivery_delay_seconds, dead_letter_retention_seconds,
            retirement_started_at_ms)
         SELECT ?, ?, ?, 'active', ?, ?, ?, ?, ?, NULL
         WHERE NOT EXISTS (
           SELECT 1 FROM queue_consumer_custody WHERE queue_id = ?
         ) AND NOT EXISTS (
           SELECT 1 FROM selfhost_queue_messages
           WHERE queue_id = ? AND lease_token IS NOT NULL
         )`,
        [
          selected.queueId,
          selected.consumerId,
          selected.generation,
          policy.maxRetries,
          policy.retryDelaySeconds,
          target?.queueId ?? null,
          target?.deliveryDelaySeconds ?? null,
          target?.messageRetentionSeconds ?? null,
          selected.queueId,
          selected.queueId,
        ],
      );
      if (inserted.changes === 1 && selected.generation === 1) return;
      const current = await readGeneration(selected);
      if (
        current?.state === "active" &&
        current.consumerId === selected.consumerId &&
        current.generation === selected.generation &&
        samePolicy(current.policy, selected.policy)
      ) {
        return;
      }
      throw new QueueCustodyConflictError();
    },

    async readiness(input) {
      const selected = generationIdentity(input);
      const maxBatchSize = positiveInteger(
        input.maxBatchSize,
        MAX_BATCH_MESSAGES,
        "queue custody readiness batch size",
      );
      const maxBatchTimeoutSeconds = nonNegativeInteger(
        input.maxBatchTimeoutSeconds,
        MAX_BATCH_TIMEOUT_SECONDS,
        "queue custody readiness batch timeout",
      );
      const current = await readGeneration(selected);
      if (
        current?.state !== "active" ||
        current.consumerId !== selected.consumerId ||
        current.generation !== selected.generation
      ) {
        return { state: "inactive" };
      }

      const millis = now();
      const leaseRows = await sql.query(
        `SELECT lease_expires_at_ms
         FROM selfhost_queue_messages INDEXED BY selfhost_queue_messages_custody_lease
         WHERE queue_id = ? AND lease_consumer_id = ? AND lease_generation = ?
         ORDER BY lease_expires_at_ms LIMIT 1`,
        [current.queueId, current.consumerId, current.generation],
      );
      const leaseWakeAt = nullableInteger(leaseRows[0]?.lease_expires_at_ms);
      if (leaseWakeAt !== null && leaseWakeAt <= millis) return { state: "ready" };

      // Observation only: claim owns every retention and terminal mutation.
      const rows = await readUnleasedWindow(current.queueId);
      let wakeAt = leaseWakeAt;
      let firstEligibleAt: number | null = null;
      let eligible = 0;
      const deliveryCap = 1 + current.policy.maxRetries;
      for (const row of rows) {
        const visibleAt = positiveStoredInteger(row.visible_at_ms);
        const expiresAt = positiveStoredInteger(row.expires_at_ms);
        const deliveries = nonNegativeStoredInteger(row.deliveries);
        if (expiresAt <= millis) return { state: "ready" };
        wakeAt = earliest(wakeAt, expiresAt);
        if (deliveries >= deliveryCap) {
          if (visibleAt <= millis) return { state: "ready" };
          wakeAt = earliest(wakeAt, visibleAt);
          continue;
        }
        if (expiresAt <= visibleAt) continue;
        firstEligibleAt ??= visibleAt;
        eligible += 1;
        if (eligible === maxBatchSize) wakeAt = earliest(wakeAt, visibleAt);
      }
      if (firstEligibleAt !== null) {
        wakeAt = earliest(
          wakeAt,
          safeFutureMillis(firstEligibleAt, maxBatchTimeoutSeconds * 1_000),
        );
      }
      if (wakeAt === null) return { state: "idle" };
      return wakeAt <= millis ? { state: "ready" } : { state: "waiting", wakeAtMillis: wakeAt };
    },

    async claim(input) {
      const selected = generationIdentity(input);
      const v2Attachment =
        input.v2Attachment === undefined
          ? undefined
          : {
              principal: token(input.v2Attachment.principal, 128, "v2 attachment principal"),
              space: token(input.v2Attachment.space, 128, "v2 attachment space"),
              targetKey: token(input.v2Attachment.targetKey, 512, "v2 attachment target"),
            };
      const v2Reservation =
        input.v2Reservation === undefined
          ? undefined
          : {
              batchId: token(input.v2Reservation.batchId, 256, "v2 batch id"),
              reservationToken: token(
                input.v2Reservation.reservationToken,
                128,
                "v2 reservation token",
              ),
            };
      const limit = positiveInteger(input.limit, MAX_BATCH_MESSAGES, "queue custody claim limit");
      const leaseMillis = positiveInteger(
        input.leaseMillis ?? MAX_LEASE_MILLIS,
        MAX_LEASE_MILLIS,
        "queue custody lease",
      );
      const current = await readGeneration(selected);
      if (
        current?.state !== "active" ||
        current.consumerId !== selected.consumerId ||
        current.generation !== selected.generation
      ) {
        return [];
      }
      const millis = now();
      if (await reapExpiredLeases(current, millis, MAX_REAP_MESSAGES)) return [];
      const rows = await readUnleasedWindow(current.queueId);
      if (await progressActiveWindow(current, millis, rows)) return [];
      const candidateMetadata = rows
        .filter(
          (row) =>
            positiveStoredInteger(row.visible_at_ms) <= millis &&
            positiveStoredInteger(row.expires_at_ms) > millis &&
            nonNegativeStoredInteger(row.deliveries) < 1 + current.policy.maxRetries,
        )
        .slice(0, limit)
        .map((row) => ({
          messageId: messageId(row.message_id),
          enqueuedAtMillis: positiveStoredInteger(row.enqueued_at_ms),
          visibleAtMillis: positiveStoredInteger(row.visible_at_ms),
          expiresAtMillis: positiveStoredInteger(row.expires_at_ms),
          attempts: nonNegativeStoredInteger(row.deliveries) + 1,
        }));
      if (candidateMetadata.length === 0) return [];
      const bodies = new Map<string, Uint8Array>();
      for (let offset = 0; offset < candidateMetadata.length; offset += MAX_BODY_QUERY_MESSAGES) {
        const chunk = candidateMetadata.slice(offset, offset + MAX_BODY_QUERY_MESSAGES);
        const bodyRows = await sql.query(
          `SELECT message_id, body FROM selfhost_queue_messages
           WHERE queue_id = ? AND message_id IN (${chunk.map(() => "?").join(", ")})`,
          [current.queueId, ...chunk.map(({ messageId }) => messageId)],
        );
        for (const row of bodyRows) bodies.set(messageId(row.message_id), bytes(row.body));
      }
      const candidates = candidateMetadata.flatMap((message) => {
        const body = bodies.get(message.messageId);
        return body === undefined ? [] : [{ ...message, body }];
      });
      if (candidates.length === 0) return [];
      const leaseToken = randomId();
      token(leaseToken, 128, "queue custody lease token");
      const target = current.policy.deadLetterQueue;
      const claimStatements: SqlStatement[] = candidates.map((message) => ({
        sql: `UPDATE selfhost_queue_messages
             SET lease_token = ?, lease_expires_at_ms = ?, deliveries = deliveries + 1,
                 lease_consumer_id = ?, lease_generation = ?, lease_max_retries = ?,
                 lease_retry_delay_seconds = ?, lease_dead_letter_queue_id = ?,
                 lease_dead_letter_delivery_delay_seconds = ?,
                 lease_dead_letter_retention_seconds = ?
             WHERE queue_id = ? AND message_id = ? AND deliveries = ?
               AND enqueued_at_ms = ? AND visible_at_ms = ? AND expires_at_ms = ?
               AND visible_at_ms <= ? AND expires_at_ms > ?
               AND lease_token IS NULL
               AND EXISTS (
                 SELECT 1 FROM queue_consumer_custody
                 WHERE queue_id = ? AND consumer_id = ? AND generation = ?
                   AND state = 'active'
               )${
                 v2Attachment
                   ? `
               AND EXISTS (
                 SELECT 1 FROM tf_v2_resources attachment
                 JOIN tf_v2_operations op ON op.id = attachment.last_operation
                 WHERE attachment.uid = ? AND attachment.principal = ?
                   AND attachment.space = ? AND attachment.target_key = ?
                   AND attachment.form_url = 'https://edge.forms.takoform.com/forms/QueueConsumer/0.3.0/'
                   AND attachment.deleted_at IS NULL AND attachment.phase = 'idle'
                   AND attachment.busy_operation IS NULL
                   AND attachment.generation = attachment.observed_generation
                   AND op.resource_uid = attachment.uid AND op.status = 'succeeded'
                   AND op.effect = 'complete' AND op.action IN ('create','update')
                   AND op.generation = attachment.generation
                   AND op.accepted_spec_json = attachment.spec_json
               )`
                   : ""
}${
                 v2Reservation
                   ? `
               AND EXISTS (SELECT 1 FROM queue_v2_batch_executions execution
                 WHERE execution.batch_id = ? AND execution.reservation_token = ?
                   AND execution.queue_id = ? AND execution.consumer_uid = ?
                   AND execution.consumer_generation = ?
                   AND execution.lease_token = ? AND execution.state = 'reserved'
                   AND EXISTS (SELECT 1 FROM tf_v2_resources attachment
                     WHERE attachment.uid = execution.consumer_uid
                       AND attachment.spec_json = execution.consumer_spec_json)
                   AND execution.reservation_until_ms >
                     (CAST(strftime('%s', 'now') AS INTEGER) * 1000
                      + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER)))`
                   : ""
}`,
        params: [
          leaseToken,
          millis + leaseMillis,
          current.consumerId,
          current.generation,
          current.policy.maxRetries,
          current.policy.retryDelaySeconds,
          target?.queueId ?? null,
          target?.deliveryDelaySeconds ?? null,
          target?.messageRetentionSeconds ?? null,
          current.queueId,
          message.messageId,
          message.attempts - 1,
          message.enqueuedAtMillis,
          message.visibleAtMillis,
          message.expiresAtMillis,
          millis,
          millis,
          current.queueId,
          current.consumerId,
          current.generation,
          ...(v2Attachment
            ? [
                current.consumerId,
                v2Attachment.principal,
                v2Attachment.space,
                v2Attachment.targetKey,
              ]
            : []),
          ...(v2Reservation
            ? [
                v2Reservation.batchId,
                v2Reservation.reservationToken,
                current.queueId,
                current.consumerId,
                current.generation,
                leaseToken,
              ]
            : []),
        ],
      }));
      if (v2Reservation)
        claimStatements.unshift({
          sql: `UPDATE queue_v2_batch_executions SET lease_token = ?
          WHERE batch_id = ? AND reservation_token = ? AND queue_id = ?
            AND consumer_uid = ? AND consumer_generation = ? AND state = 'reserved'
            AND lease_token IS NULL`,
          params: [
            leaseToken,
            v2Reservation.batchId,
            v2Reservation.reservationToken,
            current.queueId,
            current.consumerId,
            current.generation,
          ],
        });
      const written = await sql.batch(claimStatements);
      return candidates.flatMap((message, index) =>
        written[index + (v2Reservation ? 1 : 0)]?.changes === 1
          ? [
              {
                ...message,
                queueId: current.queueId,
                consumerId: current.consumerId,
                generation: current.generation,
                leaseToken,
                policy: current.policy,
              },
            ]
          : [],
      );
    },

    async release(messageValue, visibleAtMillis) {
      const message = claimedMessage(messageValue);
      const visible =
        visibleAtMillis === undefined
          ? now()
          : positiveInteger(visibleAtMillis, MAX_SAFE_GENERATION, "queue custody visibility");
      const written = await sql.run(
        `UPDATE selfhost_queue_messages
         SET visible_at_ms = ?, lease_token = NULL, lease_expires_at_ms = NULL,
             deliveries = CASE WHEN deliveries > 0 THEN deliveries - 1 ELSE 0 END,
             lease_consumer_id = NULL, lease_generation = NULL,
             lease_max_retries = NULL, lease_retry_delay_seconds = NULL,
             lease_dead_letter_queue_id = NULL,
             lease_dead_letter_delivery_delay_seconds = NULL,
             lease_dead_letter_retention_seconds = NULL
         WHERE queue_id = ? AND message_id = ? AND lease_token = ?
           AND lease_consumer_id = ? AND lease_generation = ?`,
        [
          visible,
          message.queueId,
          message.messageId,
          message.leaseToken,
          message.consumerId,
          message.generation,
        ],
      );
      return written.changes === 1;
    },

    async settle(messageValue, decisionValue) {
      const message = claimedMessage(messageValue);
      const decision = settlementDecision(decisionValue);
      if (decision.outcome === "ack") {
        const deleted = await sql.run(
          `DELETE FROM selfhost_queue_messages
           WHERE queue_id = ? AND message_id = ? AND lease_token = ?
             AND lease_consumer_id = ? AND lease_generation = ?`,
          [
            message.queueId,
            message.messageId,
            message.leaseToken,
            message.consumerId,
            message.generation,
          ],
        );
        return deleted.changes === 1;
      }

      if (message.attempts < 1 + message.policy.maxRetries) {
        const millis = now();
        const delay = decision.delaySeconds ?? message.policy.retryDelaySeconds;
        const retried = await sql.run(
          `UPDATE selfhost_queue_messages
           SET visible_at_ms = ?, lease_token = NULL, lease_expires_at_ms = NULL,
               lease_consumer_id = NULL, lease_generation = NULL,
               lease_max_retries = NULL, lease_retry_delay_seconds = NULL,
               lease_dead_letter_queue_id = NULL,
               lease_dead_letter_delivery_delay_seconds = NULL,
               lease_dead_letter_retention_seconds = NULL
           WHERE queue_id = ? AND message_id = ? AND lease_token = ?
             AND lease_consumer_id = ? AND lease_generation = ?
             AND deliveries = ? AND lease_max_retries = ?
             AND lease_retry_delay_seconds = ?
             AND lease_dead_letter_queue_id IS ?
             AND lease_dead_letter_delivery_delay_seconds IS ?
             AND lease_dead_letter_retention_seconds IS ?`,
          [
            millis + delay * 1_000,
            message.queueId,
            message.messageId,
            message.leaseToken,
            message.consumerId,
            message.generation,
            message.attempts,
            message.policy.maxRetries,
            message.policy.retryDelaySeconds,
            message.policy.deadLetterQueue?.queueId ?? null,
            message.policy.deadLetterQueue?.deliveryDelaySeconds ?? null,
            message.policy.deadLetterQueue?.messageRetentionSeconds ?? null,
          ],
        );
        return retried.changes === 1;
      }

      const millis = now();
      const statements = terminalLeaseStatements(
        {
          queueId: message.queueId,
          messageId: message.messageId,
          leaseToken: message.leaseToken,
          consumerId: message.consumerId,
          generation: message.generation,
          attempts: message.attempts,
          maxRetries: message.policy.maxRetries,
          retryDelaySeconds: message.policy.retryDelaySeconds,
          ...(message.policy.deadLetterQueue ? { target: message.policy.deadLetterQueue } : {}),
        },
        millis,
      );
      const written = await sql.batch(statements);
      return written.at(-1)?.changes === 1;
    },

    async registerSettlementBatch(batchIdValue, messageValues, v2ReservationValue) {
      const batchId = token(batchIdValue, 256, "queue batch id");
      const v2Reservation =
        v2ReservationValue === undefined
          ? undefined
          : {
              reservationToken: token(
                v2ReservationValue.reservationToken,
                128,
                "v2 reservation token",
              ),
            };
      if (
        !Array.isArray(messageValues) ||
        messageValues.length < 1 ||
        messageValues.length > MAX_BATCH_MESSAGES
      ) {
        throw new TypeError("queue batch messages are invalid");
      }
      // Snapshot caller-owned bodies/policy before the first await. A claim is
      // not authority until the SQL registration guard checks its live lease.
      const messages = messageValues.map(claimedMessage);
      const first = messages[0];
      if (
        !first ||
        new Set(messages.map((message) => message.messageId)).size !== messages.length ||
        messages.some(
          (message) =>
            message.queueId !== first.queueId ||
            message.consumerId !== first.consumerId ||
            message.generation !== first.generation ||
            message.leaseToken !== first.leaseToken,
        )
      ) {
        throw new TypeError("queue batch claim is invalid");
      }
      try {
        const statements: SqlStatement[] = messages.map((message) => ({
          sql: `INSERT INTO queue_v2_batch_settlements
            (batch_id, queue_id, consumer_id, generation, lease_token, message_id,
             attempts, max_retries, retry_delay_seconds, dead_letter_queue_id,
             dead_letter_delivery_delay_seconds, dead_letter_retention_seconds,
             execution_reservation_token)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            batchId,
            message.queueId,
            message.consumerId,
            message.generation,
            message.leaseToken,
            message.messageId,
            message.attempts,
            message.policy.maxRetries,
            message.policy.retryDelaySeconds,
            message.policy.deadLetterQueue?.queueId ?? null,
            message.policy.deadLetterQueue?.deliveryDelaySeconds ?? null,
            message.policy.deadLetterQueue?.messageRetentionSeconds ?? null,
            v2Reservation?.reservationToken ?? null,
          ],
        }));
        if (v2Reservation)
          statements.push({
            sql: `UPDATE queue_v2_batch_executions SET state = 'registered', message_count = ?
            WHERE batch_id = ? AND reservation_token = ? AND queue_id = ?
              AND consumer_uid = ? AND consumer_generation = ?`,
            params: [
              messages.length,
              batchId,
              v2Reservation.reservationToken,
              first.queueId,
              first.consumerId,
              first.generation,
            ],
          });
        const results = await sql.batch(statements);
        if (v2Reservation && results.at(-1)?.changes !== 1)
          throw new QueueCustodyConflictError("queue batch reservation is unavailable");
      } catch {
        // Includes a lost acknowledgement after the atomic batch committed.
        // An identical complete registration is safe to reopen; a partial or
        // differently scoped row set is never adopted.
        const rows = await settlementRows(batchId);
        const executionRows = v2Reservation
          ? await sql.query(
              `SELECT state, message_count FROM queue_v2_batch_executions
           WHERE batch_id = ? AND reservation_token = ? AND queue_id = ?
             AND consumer_uid = ? AND consumer_generation = ? LIMIT 2`,
              [
                batchId,
                v2Reservation.reservationToken,
                first.queueId,
                first.consumerId,
                first.generation,
              ],
            )
          : [];
        if (
          rows.length === messages.length &&
          rows.every((row) => row.state === "pending" || row.state === "settled") &&
          rows.every((row) =>
            messages.some((message) => sameSettlementClaim(row, batchId, message)),
          ) &&
          (!v2Reservation ||
            (executionRows.length === 1 &&
              executionRows[0]?.message_count === messages.length &&
              ["registered", "send_authorized", "retired"].includes(
                String(executionRows[0]?.state),
              )))
        ) {
          return;
        }
        throw new QueueCustodyConflictError("queue batch claim is unavailable");
      }
    },

    async readSettlementBatch(input) {
      const batchId = token(input.batchId, 256, "queue batch id");
      const scope = generationIdentity(input);
      const rows = await settlementRows(batchId);
      if (
        rows.some(
          (row) =>
            row.queue_id !== scope.queueId ||
            row.consumer_id !== scope.consumerId ||
            row.generation !== scope.generation,
        )
      )
        return [];
      return rows.map((row) => {
        if (row.state !== "pending" && row.state !== "settled") {
          throw new Error("queue batch receipt is corrupt");
        }
        if (
          (row.state === "pending" && (row.outcome !== null || row.delay_seconds !== null)) ||
          (row.state === "settled" && row.outcome !== "ack" && row.outcome !== "retry")
        ) {
          throw new Error("queue batch receipt is corrupt");
        }
        return Object.freeze({
          messageId: messageId(row.message_id),
          state: row.state,
          outcome: row.outcome === "ack" || row.outcome === "retry" ? row.outcome : null,
          delaySeconds:
            row.delay_seconds === null ? null : nonNegativeStoredInteger(row.delay_seconds),
        });
      });
    },

    async settleBatchMessage(input) {
      const batchId = token(input.batchId, 256, "queue batch id");
      const message = claimedMessage(input.message);
      const decision = settlementDecision(input.decision);
      const settlementToken = token(input.settlementToken, 128, "queue settlement token");
      const rows = await settlementRows(batchId);
      if (rows.length === 0) return "unknown_batch";
      const row = rows.find((candidate) => candidate.message_id === message.messageId);
      if (!row || !sameSettlementClaim(row, batchId, message)) return "unknown_message";
      if (row.state === "settled") return "already_settled";
      if (row.state !== "pending") return "unavailable";

      const millis = now();
      const delay =
        decision.outcome === "retry"
          ? (decision.delaySeconds ?? message.policy.retryDelaySeconds)
          : null;
      const terminal =
        decision.outcome === "retry" && message.attempts >= 1 + message.policy.maxRetries;
      const deadLetterId = terminal && message.policy.deadLetterQueue ? randomId() : null;
      if (deadLetterId !== null) messageId(deadLetterId);
      const statements: SqlStatement[] = [
        {
          sql: `UPDATE queue_v2_batch_settlements
          SET state = 'settling', outcome = ?, delay_seconds = ?,
              settlement_token = ?, settled_at_ms = ?, dead_letter_message_id = ?
          WHERE batch_id = ? AND message_id = ?`,
          params: [
            decision.outcome,
            delay,
            settlementToken,
            millis,
            deadLetterId,
            batchId,
            message.messageId,
          ],
        },
      ];
      if (decision.outcome === "ack") {
        statements.push({
          sql: `DELETE FROM selfhost_queue_messages
            WHERE queue_id = ? AND message_id = ? AND lease_token = ?
              AND lease_consumer_id = ? AND lease_generation = ?`,
          params: [
            message.queueId,
            message.messageId,
            message.leaseToken,
            message.consumerId,
            message.generation,
          ],
        });
      } else if (!terminal) {
        statements.push({
          sql: `UPDATE selfhost_queue_messages
            SET visible_at_ms = ?, lease_token = NULL, lease_expires_at_ms = NULL,
                lease_consumer_id = NULL, lease_generation = NULL,
                lease_max_retries = NULL, lease_retry_delay_seconds = NULL,
                lease_dead_letter_queue_id = NULL,
                lease_dead_letter_delivery_delay_seconds = NULL,
                lease_dead_letter_retention_seconds = NULL
            WHERE queue_id = ? AND message_id = ? AND lease_token = ?
              AND lease_consumer_id = ? AND lease_generation = ?
              AND deliveries = ? AND lease_max_retries = ?
              AND lease_retry_delay_seconds = ?
              AND lease_dead_letter_queue_id IS ?
              AND lease_dead_letter_delivery_delay_seconds IS ?
              AND lease_dead_letter_retention_seconds IS ?`,
          params: [
            millis + (delay ?? 0) * 1_000,
            message.queueId,
            message.messageId,
            message.leaseToken,
            message.consumerId,
            message.generation,
            message.attempts,
            message.policy.maxRetries,
            message.policy.retryDelaySeconds,
            message.policy.deadLetterQueue?.queueId ?? null,
            message.policy.deadLetterQueue?.deliveryDelaySeconds ?? null,
            message.policy.deadLetterQueue?.messageRetentionSeconds ?? null,
          ],
        });
      } else {
        statements.push(
          ...terminalLeaseStatements(
            {
              queueId: message.queueId,
              messageId: message.messageId,
              leaseToken: message.leaseToken,
              consumerId: message.consumerId,
              generation: message.generation,
              attempts: message.attempts,
              maxRetries: message.policy.maxRetries,
              retryDelaySeconds: message.policy.retryDelaySeconds,
              ...(message.policy.deadLetterQueue ? { target: message.policy.deadLetterQueue } : {}),
            },
            millis,
            deadLetterId ?? undefined,
          ),
        );
      }
      statements.push({
        sql: `UPDATE queue_v2_batch_settlements SET state = 'settled'
          WHERE batch_id = ? AND message_id = ?`,
        params: [batchId, message.messageId],
      });
      try {
        const written = await sql.batch(statements);
        if (written.at(-1)?.changes !== 1) return "unavailable";
        return "settled";
      } catch {
        const after = (await settlementRows(batchId)).find(
          (candidate) => candidate.message_id === message.messageId,
        );
        if (!after) return "unknown_batch";
        if (!sameSettlementClaim(after, batchId, message)) return "unknown_message";
        if (after.state === "settled") {
          return after.settlement_token === settlementToken &&
            after.outcome === decision.outcome &&
            after.delay_seconds === delay
            ? "settled"
            : "already_settled";
        }
        return "unavailable";
      }
    },

    async settleRegisteredBatchMessage(input) {
      // The transport authenticates the grant. Capture it before SQL awaits;
      // the receipt is the only source for immutable policy/attempt fields.
      const batchId = token(input.batchId, 256, "queue batch id");
      const id = messageId(input.messageId);
      const expected = {
        ...generationIdentity(input.expected),
        leaseToken: token(input.expected.leaseToken, 128, "queue custody lease token"),
      };
      const decision = settlementDecision(input.decision);
      const settlementToken = token(input.settlementToken, 128, "queue settlement token");
      const rows = await settlementRows(batchId);
      if (rows.length === 0) return "unknown_batch";
      const row = rows.find((candidate) => candidate.message_id === id);
      if (!row) return "unknown_message";
      if (
        row.queue_id !== expected.queueId ||
        row.consumer_id !== expected.consumerId ||
        row.generation !== expected.generation ||
        row.lease_token !== expected.leaseToken
      )
        return "unknown_message";
      const effectiveDelay =
        decision.outcome === "retry"
          ? (decision.delaySeconds ?? nonNegativeStoredInteger(row.retry_delay_seconds))
          : null;
      if (row.state === "settled") {
        return row.settlement_token === settlementToken &&
          row.outcome === decision.outcome &&
          row.delay_seconds === effectiveDelay
          ? "settled"
          : "already_settled";
      }
      if (row.state !== "pending") return "unavailable";
      // The original body has no settlement authority. The immutable receipt
      // reconstructs exactly the claim fields; SQL verifies its live lease.
      const message: QueueCustodyClaimedMessage = {
        ...expected,
        messageId: id,
        body: new Uint8Array(0),
        enqueuedAtMillis: 1,
        visibleAtMillis: 1,
        attempts: positiveStoredInteger(row.attempts),
        policy: {
          maxRetries: nonNegativeStoredInteger(row.max_retries),
          retryDelaySeconds: nonNegativeStoredInteger(row.retry_delay_seconds),
          ...(row.dead_letter_queue_id === null
            ? {}
            : {
                deadLetterQueue: {
                  queueId: token(row.dead_letter_queue_id, 512, "queue custody target queue id"),
                  deliveryDelaySeconds: nonNegativeStoredInteger(
                    row.dead_letter_delivery_delay_seconds,
                  ),
                  messageRetentionSeconds: positiveStoredInteger(row.dead_letter_retention_seconds),
                },
              }),
        },
      };
      return await this.settleBatchMessage({ batchId, message, decision, settlementToken });
    },

    async renewRegisteredV2BatchLeases(value) {
      // Capture the native-selected identity before SQL I/O. Only the 0083 row,
      // exact 0082 receipt set, and still-live message leases can authorize a
      // renewal. A Host clock or tenant-provided batch name has no authority.
      const execution = {
        batchId: token(value.batchId, 256, "v2 batch id"),
        reservationToken: token(value.reservationToken, 128, "v2 reservation token"),
        queueId: token(value.queueId, 512, "v2 queue id"),
        consumerUid: token(value.consumerUid, 128, "v2 consumer uid"),
        generation: positiveInteger(value.generation, MAX_SAFE_GENERATION, "v2 generation"),
        workerUid: token(value.workerUid, 128, "v2 worker uid"),
        servingSourceOperationId: token(value.servingSourceOperationId, 128, "v2 source operation"),
        workerVersionUid: token(value.workerVersionUid, 128, "v2 Version uid"),
        workerVersionGeneration: positiveInteger(
          value.workerVersionGeneration,
          MAX_SAFE_GENERATION,
          "v2 Version generation",
        ),
        incarnationOperationId: token(value.incarnationOperationId, 128, "v2 incarnation"),
      };
      const identity = [
        execution.batchId,
        execution.reservationToken,
        execution.queueId,
        execution.consumerUid,
        execution.generation,
        execution.workerUid,
        execution.servingSourceOperationId,
        execution.workerVersionUid,
        execution.workerVersionGeneration,
        execution.incarnationOperationId,
      ] as const;
      // The count equality makes this all-or-none: if even one pending lease
      // was reclaimed or expired, no member of this batch is silently revived.
      const updated = await sql.run(
        `UPDATE selfhost_queue_messages AS message
         SET lease_expires_at_ms = MAX(message.lease_expires_at_ms, ${SQL_NOW_MILLIS} + ?)
         WHERE message.queue_id = ? AND message.lease_consumer_id = ?
           AND message.lease_generation = ?
           AND message.lease_expires_at_ms > ${SQL_NOW_MILLIS}
           AND EXISTS (SELECT 1 FROM queue_v2_batch_executions execution
             WHERE execution.batch_id = ? AND execution.reservation_token = ?
               AND execution.queue_id = ? AND execution.consumer_uid = ?
               AND execution.consumer_generation = ? AND execution.worker_uid = ?
               AND execution.serving_source_operation_id = ?
               AND execution.worker_version_uid = ?
               AND execution.worker_version_generation = ?
               AND execution.incarnation_operation_id = ?
               AND execution.state = 'send_authorized'
               AND execution.lease_token = message.lease_token
               AND execution.message_count = (SELECT count(*) FROM queue_v2_batch_settlements all_receipts
                 WHERE all_receipts.batch_id = execution.batch_id)
               AND (SELECT count(*) FROM queue_v2_batch_settlements pending
                 WHERE pending.batch_id = execution.batch_id AND pending.state = 'pending') =
                 (SELECT count(*) FROM queue_v2_batch_settlements pending
                   JOIN selfhost_queue_messages live
                     ON live.queue_id = pending.queue_id AND live.message_id = pending.message_id
                   WHERE pending.batch_id = execution.batch_id AND pending.state = 'pending'
                     AND pending.queue_id = execution.queue_id
                     AND pending.consumer_id = execution.consumer_uid
                     AND pending.generation = execution.consumer_generation
                     AND pending.lease_token = execution.lease_token
                     AND live.lease_token = pending.lease_token
                     AND live.lease_consumer_id = pending.consumer_id
                     AND live.lease_generation = pending.generation
                     AND live.lease_expires_at_ms > ${SQL_NOW_MILLIS}))
           AND EXISTS (SELECT 1 FROM queue_v2_batch_settlements receipt
             WHERE receipt.batch_id = ? AND receipt.queue_id = message.queue_id
               AND receipt.consumer_id = message.lease_consumer_id
               AND receipt.generation = message.lease_generation
               AND receipt.lease_token = message.lease_token
               AND receipt.message_id = message.message_id AND receipt.state = 'pending')`,
        [
          MAX_LEASE_MILLIS,
          execution.queueId,
          execution.consumerUid,
          execution.generation,
          ...identity,
          execution.batchId,
        ],
      );
      if (updated.changes > 0) return "renewed";
      const rows = await sql.query(
        `SELECT (SELECT count(*) FROM queue_v2_batch_settlements receipt
           WHERE receipt.batch_id = execution.batch_id AND receipt.state = 'pending') AS pending
         FROM queue_v2_batch_executions execution
         WHERE execution.batch_id = ? AND execution.reservation_token = ?
           AND execution.queue_id = ? AND execution.consumer_uid = ?
           AND execution.consumer_generation = ? AND execution.worker_uid = ?
           AND execution.serving_source_operation_id = ?
           AND execution.worker_version_uid = ?
           AND execution.worker_version_generation = ?
           AND execution.incarnation_operation_id = ?
           AND execution.state = 'send_authorized' LIMIT 1`,
        identity,
      );
      return rows.length === 1 && rows[0]?.pending === 0 ? "no_pending" : "unknown";
    },

    async listTransferNotices(input) {
      const selected = generationIdentity(input);
      const limit = positiveInteger(
        input.limit ?? MAX_TRANSFER_NOTICE_LIST,
        MAX_TRANSFER_NOTICE_LIST,
        "queue custody transfer notice limit",
      );
      const rows = await sql.query(
        `SELECT source_queue_id, source_consumer_id, source_generation,
                target_queue_id, notice_token
         FROM queue_custody_transfer_notices
         WHERE source_queue_id = ? AND source_consumer_id = ? AND source_generation = ?
         ORDER BY target_queue_id LIMIT ?`,
        [selected.queueId, selected.consumerId, selected.generation, limit],
      );
      return rows.map(transferNoticeFromRow);
    },

    async acknowledgeTransferNotice(input) {
      const selected = generationIdentity(input);
      const targetQueueId = token(input.targetQueueId, 512, "queue custody target queue id");
      const noticeToken = messageId(input.noticeToken);
      const deleted = await sql.run(
        `DELETE FROM queue_custody_transfer_notices
         WHERE source_queue_id = ? AND source_consumer_id = ? AND source_generation = ?
           AND target_queue_id = ? AND notice_token = ?`,
        [selected.queueId, selected.consumerId, selected.generation, targetQueueId, noticeToken],
      );
      return deleted.changes === 1;
    },

    async sweepExpired(limitValue = MAX_CUSTODY_WINDOW_MESSAGES) {
      const limit = positiveInteger(
        limitValue,
        MAX_CUSTODY_WINDOW_MESSAGES,
        "queue custody expiry sweep limit",
      );
      const millis = now();
      const rows = await sql.query(
        `SELECT queue_id, message_id, enqueued_at_ms, visible_at_ms, expires_at_ms,
                deliveries, lease_token, lease_expires_at_ms
         FROM selfhost_queue_messages AS message INDEXED BY selfhost_queue_messages_expiry
         WHERE expires_at_ms <= ?
           AND NOT EXISTS (SELECT 1 FROM queue_v2_batch_executions protected
             WHERE protected.queue_id = message.queue_id
               AND protected.consumer_uid = message.lease_consumer_id
               AND protected.consumer_generation = message.lease_generation
               AND protected.lease_token = message.lease_token
               AND protected.state = 'send_authorized')
         ORDER BY expires_at_ms LIMIT ?`,
        [millis, limit],
      );
      if (rows.length === 0) return 0;
      const written = await sql.batch(
        rows.map((row) => {
          const leaseToken = row.lease_token;
          if (leaseToken !== null) token(leaseToken, 128, "queue custody lease token");
          const leaseExpiresAt = nullableInteger(row.lease_expires_at_ms);
          return {
            sql: `DELETE FROM selfhost_queue_messages
               WHERE queue_id = ? AND message_id = ? AND enqueued_at_ms = ?
                 AND visible_at_ms = ? AND expires_at_ms = ? AND deliveries = ?
                 AND lease_token IS ? AND lease_expires_at_ms IS ?
                 AND expires_at_ms <= ?
                 AND NOT EXISTS (SELECT 1 FROM queue_v2_batch_executions execution
                 WHERE execution.queue_id = selfhost_queue_messages.queue_id
                   AND execution.consumer_uid = selfhost_queue_messages.lease_consumer_id
                   AND execution.consumer_generation = selfhost_queue_messages.lease_generation
                   AND execution.lease_token = selfhost_queue_messages.lease_token
                   AND execution.state = 'send_authorized')`,
            params: [
              token(row.queue_id, 512, "queue custody queue id"),
              messageId(row.message_id),
              positiveStoredInteger(row.enqueued_at_ms),
              positiveStoredInteger(row.visible_at_ms),
              positiveStoredInteger(row.expires_at_ms),
              nonNegativeStoredInteger(row.deliveries),
              leaseToken as string | null,
              leaseExpiresAt,
              millis,
            ],
          };
        }),
      );
      return written.reduce((total, result) => total + result.changes, 0);
    },

    async beginRetirement(input) {
      const selected = generationIdentity(input);
      const millis = now();
      const changed = await sql.run(
        `UPDATE queue_consumer_custody
         SET state = 'retiring', retirement_started_at_ms = ?
         WHERE queue_id = ? AND consumer_id = ? AND generation = ?
           AND state = 'active'`,
        [millis, selected.queueId, selected.consumerId, selected.generation],
      );
      const current = await readGeneration(selected);
      if (
        !current ||
        current.consumerId !== selected.consumerId ||
        current.generation !== selected.generation ||
        (changed.changes !== 1 && current.state !== "retiring" && current.state !== "tombstone")
      ) {
        throw new QueueCustodyConflictError();
      }
      return await retirementStatus(current, millis);
    },

    async reapRetired(input) {
      const selected = generationIdentity(input);
      const current = await readGeneration(selected);
      if (
        current?.state !== "retiring" ||
        current.consumerId !== selected.consumerId ||
        current.generation !== selected.generation
      ) {
        throw new QueueCustodyConflictError();
      }
      const millis = now();
      const limit = positiveInteger(
        input.limit ?? MAX_REAP_MESSAGES,
        MAX_REAP_MESSAGES,
        "queue custody reap limit",
      );
      await reapExpiredLeases(current, millis, limit);
      return await retirementStatus(current, millis);
    },

    async reapRetiredV2(input) {
      const selected = generationIdentity(input);
      const current = await readGeneration(selected);
      if (
        current?.state !== "retiring" ||
        current.consumerId !== selected.consumerId ||
        current.generation !== selected.generation
      )
        throw new QueueCustodyConflictError();
      const millis = now();
      const limit = positiveInteger(
        input.limit ?? MAX_REAP_MESSAGES,
        MAX_REAP_MESSAGES,
        "queue custody reap limit",
      );
      await reapExpiredLeases(current, millis, limit, input.operationClaim);
      return await retirementStatus(current, millis);
    },

    async finishRetirement(input) {
      const selected = generationIdentity(input);
      const millis = now();
      const replacement =
        input.replacement === undefined ? undefined : generation(input.replacement);
      if (
        replacement &&
        (replacement.queueId !== selected.queueId ||
          replacement.generation !== selected.generation + 1)
      ) {
        throw new TypeError("queue custody replacement generation is invalid");
      }
      let changed: number;
      if (replacement) {
        const target = replacement.policy.deadLetterQueue;
        changed = (
          await sql.run(
            `UPDATE queue_consumer_custody
             SET consumer_id = ?, generation = ?, state = 'active',
                 max_retries = ?, retry_delay_seconds = ?, dead_letter_queue_id = ?,
                 dead_letter_delivery_delay_seconds = ?,
                 dead_letter_retention_seconds = ?, retirement_started_at_ms = NULL
             WHERE queue_id = ? AND consumer_id = ? AND generation = ?
               AND state = 'retiring'
               AND NOT EXISTS (
                 SELECT 1 FROM selfhost_queue_messages
                 WHERE queue_id = ? AND lease_consumer_id = ? AND lease_generation = ?
                   AND lease_token IS NOT NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM queue_custody_transfer_notices
                 WHERE source_queue_id = ? AND source_consumer_id = ? AND source_generation = ?
               )`,
            [
              replacement.consumerId,
              replacement.generation,
              replacement.policy.maxRetries,
              replacement.policy.retryDelaySeconds,
              target?.queueId ?? null,
              target?.deliveryDelaySeconds ?? null,
              target?.messageRetentionSeconds ?? null,
              selected.queueId,
              selected.consumerId,
              selected.generation,
              selected.queueId,
              selected.consumerId,
              selected.generation,
              selected.queueId,
              selected.consumerId,
              selected.generation,
            ],
          )
        ).changes;
      } else {
        changed = (
          await sql.run(
            `UPDATE queue_consumer_custody
             SET state = 'tombstone', retirement_started_at_ms = NULL
             WHERE queue_id = ? AND consumer_id = ? AND generation = ?
               AND state = 'retiring'
               AND NOT EXISTS (
                 SELECT 1 FROM selfhost_queue_messages
                 WHERE queue_id = ? AND lease_consumer_id = ? AND lease_generation = ?
                   AND lease_token IS NOT NULL
               )
               AND NOT EXISTS (
                 SELECT 1 FROM queue_custody_transfer_notices
                 WHERE source_queue_id = ? AND source_consumer_id = ? AND source_generation = ?
               )`,
            [
              selected.queueId,
              selected.consumerId,
              selected.generation,
              selected.queueId,
              selected.consumerId,
              selected.generation,
              selected.queueId,
              selected.consumerId,
              selected.generation,
            ],
          )
        ).changes;
      }

      const current = await readGeneration(selected);
      if (replacement) {
        if (
          current?.state === "active" &&
          current.consumerId === replacement.consumerId &&
          current.generation === replacement.generation &&
          samePolicy(current.policy, replacement.policy)
        ) {
          return { state: "activated", generation: replacement.generation };
        }
      } else if (
        current?.state === "tombstone" &&
        current.consumerId === selected.consumerId &&
        current.generation === selected.generation
      ) {
        return { state: "tombstone" };
      }
      if (changed !== 0) throw new Error("queue custody retirement postcondition failed");
      const status = await retirementStatus(
        {
          queueId: selected.queueId,
          consumerId: selected.consumerId,
          generation: selected.generation,
          policy: current?.policy ?? { maxRetries: 0, retryDelaySeconds: 0 },
        },
        millis,
      );
      if (status.state === "waiting" || status.state === "reap" || status.state === "notify") {
        return status;
      }
      throw new QueueCustodyConflictError();
    },
  };
}

function queueTarget(value: QueueCustodyTarget): QueueCustodyTarget {
  if (!value || typeof value !== "object") throw new TypeError("queue custody target is invalid");
  return Object.freeze({
    queueId: token(value.queueId, 512, "queue custody queue id"),
    messageRetentionSeconds: retentionSeconds(value.messageRetentionSeconds),
    deliveryDelaySeconds: delaySeconds(
      value.deliveryDelaySeconds,
      "queue custody delivery delay is invalid",
    ),
  });
}

function admission(value: QueueCustodyAdmission): QueueCustodyAdmission {
  if (!value || typeof value !== "object") {
    throw new TypeError("queue custody admission is invalid");
  }
  const body = bytes(value.body);
  if (body.byteLength > MAX_MESSAGE_BYTES) {
    throw new TypeError("queue custody message is too large");
  }
  return Object.freeze({
    messageId: messageId(value.messageId),
    body,
    ...(value.delaySeconds === undefined
      ? {}
      : { delaySeconds: delaySeconds(value.delaySeconds, "queue custody delay is invalid") }),
  });
}

function generation(value: QueueCustodyConsumerGeneration): QueueCustodyConsumerGeneration {
  const identity = generationIdentity(value);
  return Object.freeze({ ...identity, policy: retryPolicy(value.policy, identity.queueId) });
}

function generationIdentity(
  value: Pick<QueueCustodyConsumerGeneration, "queueId" | "consumerId" | "generation">,
) {
  if (!value || typeof value !== "object") {
    throw new TypeError("queue custody generation is invalid");
  }
  return Object.freeze({
    queueId: token(value.queueId, 512, "queue custody queue id"),
    consumerId: token(value.consumerId, 512, "queue custody consumer id"),
    generation: positiveInteger(value.generation, MAX_SAFE_GENERATION, "queue custody generation"),
  });
}

function retryPolicy(
  value: QueueCustodyRetryPolicy,
  sourceQueueId: string,
): QueueCustodyRetryPolicy {
  if (!value || typeof value !== "object") throw new TypeError("queue custody policy is invalid");
  const maxRetries = nonNegativeInteger(value.maxRetries, MAX_RETRIES, "queue custody retries");
  const retryDelaySeconds = delaySeconds(
    value.retryDelaySeconds,
    "queue custody retry delay is invalid",
  );
  const deadLetterQueue =
    value.deadLetterQueue === undefined ? undefined : queueTarget(value.deadLetterQueue);
  if (deadLetterQueue?.queueId === sourceQueueId) {
    throw new TypeError("queue custody dead-letter queue loops to its source");
  }
  return Object.freeze({
    maxRetries,
    retryDelaySeconds,
    ...(deadLetterQueue ? { deadLetterQueue } : {}),
  });
}

function claimedMessage(value: QueueCustodyClaimedMessage): QueueCustodyClaimedMessage {
  const selected = generationIdentity(value);
  if (!value || typeof value !== "object") throw new TypeError("queue custody claim is invalid");
  return Object.freeze({
    ...selected,
    leaseToken: token(value.leaseToken, 128, "queue custody lease token"),
    messageId: messageId(value.messageId),
    body: bytes(value.body),
    enqueuedAtMillis: positiveInteger(
      value.enqueuedAtMillis,
      MAX_SAFE_GENERATION,
      "queue custody acceptance time",
    ),
    visibleAtMillis: positiveInteger(
      value.visibleAtMillis,
      MAX_SAFE_GENERATION,
      "queue custody visibility",
    ),
    attempts: positiveInteger(value.attempts, 1 + MAX_RETRIES, "queue custody attempts"),
    policy: retryPolicy(value.policy, selected.queueId),
  });
}

function settlementDecision(value: {
  readonly outcome: "ack" | "retry";
  readonly delaySeconds?: number;
}) {
  if (
    !value ||
    typeof value !== "object" ||
    (value.outcome !== "ack" && value.outcome !== "retry")
  ) {
    throw new TypeError("queue custody settlement is invalid");
  }
  if (value.outcome === "ack") {
    if (value.delaySeconds !== undefined)
      throw new TypeError("queue custody settlement is invalid");
    return { outcome: "ack" } as const;
  }
  return {
    outcome: "retry" as const,
    ...(value.delaySeconds === undefined
      ? {}
      : { delaySeconds: delaySeconds(value.delaySeconds, "queue custody retry delay is invalid") }),
  };
}

function policyFromRow(row: Readonly<Record<string, unknown>>): QueueCustodyRetryPolicy {
  const queueId = row.dead_letter_queue_id;
  if (queueId === null) {
    if (
      row.dead_letter_delivery_delay_seconds !== null ||
      row.dead_letter_retention_seconds !== null
    ) {
      throw new Error("queue custody policy is corrupt");
    }
    return Object.freeze({
      maxRetries: nonNegativeStoredInteger(row.max_retries),
      retryDelaySeconds: nonNegativeStoredInteger(row.retry_delay_seconds),
    });
  }
  return Object.freeze({
    maxRetries: nonNegativeStoredInteger(row.max_retries),
    retryDelaySeconds: nonNegativeStoredInteger(row.retry_delay_seconds),
    deadLetterQueue: Object.freeze({
      queueId: stringValue(queueId),
      deliveryDelaySeconds: nonNegativeStoredInteger(row.dead_letter_delivery_delay_seconds),
      messageRetentionSeconds: positiveStoredInteger(row.dead_letter_retention_seconds),
    }),
  });
}

function leaseTargetFromRow(
  row: Readonly<Record<string, unknown>>,
): QueueCustodyDeadLetterTarget | undefined {
  const queueId = row.lease_dead_letter_queue_id;
  if (queueId === null) {
    if (
      row.lease_dead_letter_delivery_delay_seconds !== null ||
      row.lease_dead_letter_retention_seconds !== null
    ) {
      throw new Error("queue custody lease policy is corrupt");
    }
    return undefined;
  }
  return Object.freeze({
    queueId: stringValue(queueId),
    deliveryDelaySeconds: nonNegativeStoredInteger(row.lease_dead_letter_delivery_delay_seconds),
    messageRetentionSeconds: positiveStoredInteger(row.lease_dead_letter_retention_seconds),
  });
}

function transferNoticeFromRow(row: Readonly<Record<string, unknown>>): QueueCustodyTransferNotice {
  return Object.freeze({
    sourceQueueId: token(row.source_queue_id, 512, "queue custody source queue id"),
    sourceConsumerId: token(row.source_consumer_id, 512, "queue custody source consumer id"),
    sourceGeneration: positiveStoredInteger(row.source_generation),
    targetQueueId: token(row.target_queue_id, 512, "queue custody target queue id"),
    noticeToken: messageId(row.notice_token),
  });
}

function samePolicy(left: QueueCustodyRetryPolicy, right: QueueCustodyRetryPolicy): boolean {
  return (
    left.maxRetries === right.maxRetries &&
    left.retryDelaySeconds === right.retryDelaySeconds &&
    left.deadLetterQueue?.queueId === right.deadLetterQueue?.queueId &&
    left.deadLetterQueue?.deliveryDelaySeconds === right.deadLetterQueue?.deliveryDelaySeconds &&
    left.deadLetterQueue?.messageRetentionSeconds === right.deadLetterQueue?.messageRetentionSeconds
  );
}

function token(value: unknown, maximum: number, name: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    value.includes("\0")
  ) {
    throw new TypeError(`${name} is invalid`);
  }
  return value;
}

function messageId(value: unknown): string {
  if (typeof value !== "string" || !MESSAGE_ID.test(value)) {
    throw new TypeError("queue custody message id is invalid");
  }
  return value;
}

function positiveInteger(value: unknown, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 1 || Number(value) > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, maximum: number, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0 || Number(value) > maximum) {
    throw new TypeError(`${name} is invalid`);
  }
  return Number(value);
}

function delaySeconds(value: unknown, message: string): number {
  return nonNegativeInteger(
    value,
    MAX_DELIVERY_DELAY_SECONDS,
    message.replace(/ is invalid$/u, ""),
  );
}

function retentionSeconds(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    Number(value) < MIN_RETENTION_SECONDS ||
    Number(value) > MAX_RETENTION_SECONDS
  ) {
    throw new TypeError("queue custody retention is invalid");
  }
  return Number(value);
}

function bytes(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  // D1 projects SQLite BLOBs as integer arrays. Reject coercion/truncation so
  // the retained message body is exactly the byte sequence that was admitted.
  if (
    Array.isArray(value) &&
    value.every(
      (byte) => typeof byte === "number" && Number.isInteger(byte) && byte >= 0 && byte <= 255,
    )
  )
    return Uint8Array.from(value);
  throw new TypeError("queue custody message body is invalid");
}

function arrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.slice().buffer as ArrayBuffer;
}

function integer(value: unknown): number {
  const selected = typeof value === "bigint" ? Number(value) : value;
  if (!Number.isSafeInteger(selected)) throw new Error("queue custody integer is corrupt");
  return Number(selected);
}

function positiveStoredInteger(value: unknown): number {
  const selected = integer(value);
  if (selected <= 0) throw new Error("queue custody integer is corrupt");
  return selected;
}

function nonNegativeStoredInteger(value: unknown): number {
  const selected = integer(value);
  if (selected < 0) throw new Error("queue custody integer is corrupt");
  return selected;
}

function nullableInteger(value: unknown): number | null {
  return value === null || value === undefined ? null : positiveStoredInteger(value);
}

function earliest(left: number | null, right: number): number {
  return left === null ? right : Math.min(left, right);
}

function safeFutureMillis(base: number, delta: number): number {
  return Math.min(base + delta, MAX_SAFE_GENERATION);
}

function stringValue(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("queue custody string is corrupt");
  }
  return value;
}
