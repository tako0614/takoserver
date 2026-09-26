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
  }): Promise<readonly QueueCustodyClaimedMessage[]>;
  release(message: QueueCustodyClaimedMessage, visibleAtMillis?: number): Promise<boolean>;
  settle(
    message: QueueCustodyClaimedMessage,
    decision: { readonly outcome: "ack" | "retry"; readonly delaySeconds?: number },
  ): Promise<boolean>;
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
    },
    millis: number,
  ): readonly SqlStatement[] => {
    const target = lease.target;
    const expirySql =
      lease.leaseExpiresAtMillis === undefined ? "" : " AND lease_expires_at_ms = ?";
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
           )`,
      params: sourceParams,
    };
    if (!target) return [removal];
    const deadLetterId = randomId();
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
             )`,
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
             )
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
  ): Promise<boolean> => {
    const rows = await sql.query(
      `SELECT message_id, enqueued_at_ms, visible_at_ms, expires_at_ms,
              lease_token, lease_expires_at_ms, deliveries, lease_max_retries,
              lease_retry_delay_seconds,
              lease_dead_letter_queue_id,
              lease_dead_letter_delivery_delay_seconds,
              lease_dead_letter_retention_seconds
       FROM selfhost_queue_messages INDEXED BY selfhost_queue_messages_custody_lease
       WHERE queue_id = ? AND lease_consumer_id = ? AND lease_generation = ?
         AND lease_expires_at_ms <= ?
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
               )`,
          params: [...snapshotParams.slice(0, 15), millis, ...snapshotParams.slice(15)],
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
               )`,
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
          },
          millis,
        ),
      );
    }
    if (statements.length > 0) await sql.batch(statements);
    return true;
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
      const written = await sql.batch(
        candidates.map((message) => ({
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
               )`,
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
          ],
        })),
      );
      return candidates.flatMap((message, index) =>
        written[index]?.changes === 1
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
         FROM selfhost_queue_messages INDEXED BY selfhost_queue_messages_expiry
         WHERE expires_at_ms <= ?
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
                 AND expires_at_ms <= ?`,
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
