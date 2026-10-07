import { canonicalJson } from "../json.ts";
import type { Sql } from "../ports.ts";
import type { QueueCustody, QueueCustodyClaimedMessage } from "../queue-custody.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "./forms/at-least-once-queue.ts";
import { parseQueueConsumerSpec, QUEUE_CONSUMER_FORM_URL } from "./forms/queue-consumer.ts";
import {
  MODULE_WORKER_FORM_URL,
  WORKER_DEPLOYMENT_FORM_URL,
  WORKER_ENDPOINT_FORM_URL,
  WORKER_VERSION_FORM_URL,
} from "./forms/worker-specs.ts";
import type { V2Execution } from "./types.ts";
import type { V2QueueConsumerCapability } from "./worker-queue-consumer-backend.ts";

const DB_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";

/** A private physical namespace, pinned only to the accepted Resource UID. */
export function v2QueueId(queueUid: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(queueUid)) {
    throw new TypeError("Queue Resource UID is invalid");
  }
  return `takoform-v2-queue:${queueUid}`;
}

export interface V2QueueClaim {
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
  readonly action: V2Execution["action"];
  readonly generation: number;
  readonly specJson: string;
}

export function snapshotV2QueueClaim(execution: V2Execution): V2QueueClaim {
  return {
    operationId: execution.operationId,
    leaseToken: execution.leaseToken,
    resourceUid: execution.resourceUid,
    principal: execution.principal,
    form: execution.form,
    space: execution.space,
    name: execution.name,
    backendId: execution.backendId,
    targetKey: execution.targetKey,
    backendKey: execution.backendKey,
    action: execution.action,
    generation: execution.generation,
    specJson: canonicalJson(execution.spec),
  };
}

/**
 * SQL predicate embedded in each v2 Queue lifecycle write. A JS pre-read is
 * insufficient: the DB clock and accepted spec/lease are rechecked by the
 * same statement that mutates messages or consumer custody.
 */
export const V2_QUEUE_CLAIM_SQL = `EXISTS (
  SELECT 1 FROM tf_v2_operations op
  JOIN tf_v2_resources resource ON resource.uid = op.resource_uid
  WHERE op.id = ? AND op.lease_token = ? AND op.resource_uid = ?
    AND op.principal = ? AND op.backend_id = ? AND op.target_key = ?
    AND op.backend_key = ? AND op.action = ? AND op.generation = ?
    AND op.accepted_spec_json = ? AND op.status = 'reconciling'
    AND op.dispatch_possible = 1 AND op.lease_until_ms > ${DB_NOW_MS}
    AND resource.uid = ? AND resource.principal = ? AND resource.form_url = ?
    AND resource.space = ? AND resource.name = ?
    AND resource.backend_id = ? AND resource.target_key = ?
    AND resource.generation = op.generation AND resource.spec_json = op.accepted_spec_json
    AND resource.last_operation = op.id AND resource.busy_operation = op.id
    AND resource.deleted_at IS NULL
)`;

export function v2QueueClaimParams(claim: V2QueueClaim): (string | number)[] {
  return [
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
  ];
}

export async function ownsV2QueueClaim(sql: Sql, claim: V2QueueClaim): Promise<boolean> {
  const rows = await sql.query(`SELECT 1 WHERE ${V2_QUEUE_CLAIM_SQL}`, v2QueueClaimParams(claim));
  return rows.length === 1;
}

export interface V2QueueSettlementScopeInput {
  readonly batchId: string;
  readonly messageId: string;
  readonly leaseToken: string;
  readonly consumerUid: string;
  readonly queueUid: string;
  readonly workerUid: string;
  readonly generation: number;
  readonly servingSourceOperationId: string;
}

export type V2QueueSettlementScope =
  | { readonly kind: "unknown" }
  | ({
      readonly kind: "confirmed_live" | "confirmed_receipt";
    } & V2QueueSettlementScopeInput);

/**
 * Read-only preflight for the authenticated native settlement grant. The
 * returned identities come from accepted Core rows and the immutable 0082
 * registration, never from the request DTO. A terminal receipt may be read
 * after message deletion and Consumer retirement; only the exact custody CAS
 * may decide whether the presented decision/token is its committed result.
 */
export async function verifyV2QueueSettlementScope(
  sql: Sql,
  input: V2QueueSettlementScopeInput,
): Promise<V2QueueSettlementScope> {
  const expected = {
    batchId: input.batchId,
    messageId: input.messageId,
    leaseToken: input.leaseToken,
    consumerUid: input.consumerUid,
    queueUid: input.queueUid,
    workerUid: input.workerUid,
    generation: input.generation,
    servingSourceOperationId: input.servingSourceOperationId,
  };
  const uidPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const validUid = (value: unknown): value is string =>
    typeof value === "string" && uidPattern.test(value);
  if (
    !validUid(expected.messageId) ||
    !validUid(expected.consumerUid) ||
    !validUid(expected.queueUid) ||
    !validUid(expected.workerUid) ||
    !validUid(expected.servingSourceOperationId) ||
    typeof expected.batchId !== "string" ||
    expected.batchId.length < 1 ||
    new TextEncoder().encode(expected.batchId).length > 256 ||
    typeof expected.leaseToken !== "string" ||
    expected.leaseToken.length < 1 ||
    expected.leaseToken.length > 128 ||
    !Number.isSafeInteger(expected.generation) ||
    expected.generation < 1
  )
    return { kind: "unknown" };
  const rows = await sql.query(
    `SELECT receipt.batch_id, receipt.message_id, receipt.lease_token,
            consumer.uid AS consumer_uid, queue.uid AS queue_uid,
            worker.uid AS worker_uid, receipt.generation,
            source_op.id AS source_operation_id, receipt.state,
            message.lease_expires_at_ms
     FROM queue_v2_batch_settlements receipt
     LEFT JOIN queue_v2_batch_executions execution ON execution.batch_id = receipt.batch_id
     JOIN tf_v2_resources consumer ON consumer.uid = receipt.consumer_id
     LEFT JOIN tf_v2_operations consumer_confirmed_op
       ON consumer_confirmed_op.resource_uid = consumer.uid
         AND consumer_confirmed_op.generation = consumer.observed_generation
         AND consumer_confirmed_op.status = 'succeeded'
         AND consumer_confirmed_op.effect = 'complete'
         AND consumer_confirmed_op.action IN ('create','update')
     JOIN tf_v2_resources queue ON receipt.queue_id = 'takoform-v2-queue:' || queue.uid
     JOIN tf_v2_resources worker
       ON worker.uid = json_extract(consumer.spec_json, '$.worker.resourceUid')
     JOIN tf_v2_operations source_op ON source_op.id = ?
     JOIN tf_v2_resources source_resource ON source_resource.uid = source_op.resource_uid
     LEFT JOIN queue_consumer_custody custody ON custody.queue_id = receipt.queue_id
     LEFT JOIN selfhost_queue_messages message
       ON message.queue_id = receipt.queue_id AND message.message_id = receipt.message_id
         AND message.lease_token = receipt.lease_token
         AND message.lease_consumer_id = receipt.consumer_id
         AND message.lease_generation = receipt.generation
     WHERE receipt.batch_id = ? AND receipt.message_id = ?
       AND receipt.lease_token = ? AND receipt.consumer_id = ?
       AND receipt.queue_id = ? AND receipt.generation = ?
       AND consumer.form_url = ? AND queue.form_url = ? AND worker.form_url = ?
       AND queue.uid = json_extract(consumer.spec_json, '$.queue.resourceUid')
       AND consumer.principal = queue.principal AND consumer.principal = worker.principal
       AND consumer.space = queue.space AND consumer.space = worker.space
       AND consumer.target_key = queue.target_key AND consumer.target_key = worker.target_key
       AND source_resource.form_url IN (?, ?)
       AND source_resource.principal = consumer.principal
       AND source_resource.space = consumer.space
       AND source_resource.target_key = consumer.target_key
       AND source_op.principal = consumer.principal
       AND source_op.target_key = consumer.target_key
       AND source_op.backend_id = source_resource.backend_id
       AND json_extract(source_op.accepted_spec_json, '$.worker.resourceUid') = worker.uid
       AND (execution.batch_id IS NULL OR (
         execution.queue_id = receipt.queue_id
         AND execution.consumer_uid = receipt.consumer_id
         AND execution.consumer_generation = receipt.generation
         AND execution.reservation_token = receipt.execution_reservation_token
         AND execution.worker_uid = worker.uid
         AND execution.serving_source_operation_id = source_op.id
         AND execution.state IN ('send_authorized','retired')))
       AND (
         receipt.state = 'settled' OR (
           receipt.state = 'pending'
           AND consumer.deleted_at IS NULL AND queue.deleted_at IS NULL
           AND worker.deleted_at IS NULL
           AND consumer_confirmed_op.id IS NOT NULL
           AND json_extract(consumer.observed_json, '$.consumerAttached') = 1
           AND custody.consumer_id = consumer.uid
           AND custody.generation = receipt.generation
           AND custody.state IN ('active','retiring')
           AND message.lease_expires_at_ms > ${DB_NOW_MS}
         )
       ) LIMIT 2`,
    [
      expected.servingSourceOperationId,
      expected.batchId,
      expected.messageId,
      expected.leaseToken,
      expected.consumerUid,
      v2QueueId(expected.queueUid),
      expected.generation,
      QUEUE_CONSUMER_FORM_URL,
      AT_LEAST_ONCE_QUEUE_FORM_URL,
      MODULE_WORKER_FORM_URL,
      WORKER_DEPLOYMENT_FORM_URL,
      WORKER_ENDPOINT_FORM_URL,
    ],
  );
  const row = rows.length === 1 ? rows[0] : null;
  if (
    !row ||
    row.batch_id !== expected.batchId ||
    row.message_id !== expected.messageId ||
    row.lease_token !== expected.leaseToken ||
    row.consumer_uid !== expected.consumerUid ||
    row.queue_uid !== expected.queueUid ||
    row.worker_uid !== expected.workerUid ||
    row.generation !== expected.generation ||
    row.source_operation_id !== expected.servingSourceOperationId
  )
    return { kind: "unknown" };
  const confirmed = {
    batchId: row.batch_id as string,
    messageId: row.message_id as string,
    leaseToken: row.lease_token as string,
    consumerUid: row.consumer_uid as string,
    queueUid: row.queue_uid as string,
    workerUid: row.worker_uid as string,
    generation: row.generation as number,
    servingSourceOperationId: row.source_operation_id as string,
  };
  if (row.state === "settled") return { kind: "confirmed_receipt", ...confirmed };
  if (
    row.state !== "pending" ||
    typeof row.lease_expires_at_ms !== "number" ||
    !Number.isSafeInteger(row.lease_expires_at_ms) ||
    Date.now() >= row.lease_expires_at_ms
  ) {
    return { kind: "unknown" };
  }
  return { kind: "confirmed_live", ...confirmed };
}

export type V2RegisteredQueueBatch = {
  readonly kind: "ready";
  readonly batchId: string;
  /** Host-private pre-send reservation; never exposed to tenant JavaScript. */
  readonly reservationToken: string;
  readonly queueUid: string;
  readonly queueName: string;
  readonly workerUid: string;
  readonly consumerUid: string;
  readonly generation: number;
  readonly servingSourceOperationId: string;
  readonly versions: readonly {
    readonly workerVersionUid: string;
    readonly generation: number;
    readonly weight: number;
  }[];
  readonly claims: readonly QueueCustodyClaimedMessage[];
  /** Must be rechecked after native awaits and before the one-shot send. */
  stillCurrent(): Promise<boolean>;
};

export type V2QueueBatchSelection = V2RegisteredQueueBatch | { readonly kind: "idle" | "unknown" };

export interface V2QueueBatchExecutionIdentity {
  readonly batchId: string;
  readonly reservationToken: string;
  readonly queueUid: string;
  readonly consumerUid: string;
  readonly generation: number;
  readonly workerUid: string;
  readonly servingSourceOperationId: string;
  readonly workerVersionUid: string;
  readonly workerVersionGeneration: number;
  readonly incarnationOperationId: string;
}

function executionIdentity(input: V2QueueBatchExecutionIdentity): V2QueueBatchExecutionIdentity {
  const uid = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
  const values = [
    input.batchId,
    input.reservationToken,
    input.queueUid,
    input.consumerUid,
    input.workerUid,
    input.servingSourceOperationId,
    input.workerVersionUid,
    input.incarnationOperationId,
  ];
  if (
    values.some((value) => typeof value !== "string" || !uid.test(value)) ||
    !Number.isSafeInteger(input.generation) ||
    input.generation < 1 ||
    !Number.isSafeInteger(input.workerVersionGeneration) ||
    input.workerVersionGeneration < 1
  )
    throw new TypeError("Queue execution identity is invalid");
  return {
    batchId: input.batchId,
    reservationToken: input.reservationToken,
    queueUid: input.queueUid,
    consumerUid: input.consumerUid,
    generation: input.generation,
    workerUid: input.workerUid,
    servingSourceOperationId: input.servingSourceOperationId,
    workerVersionUid: input.workerVersionUid,
    workerVersionGeneration: input.workerVersionGeneration,
    incarnationOperationId: input.incarnationOperationId,
  };
}

const EXECUTION_SCOPE = `batch_id = ? AND reservation_token = ? AND queue_id = ?
  AND consumer_uid = ? AND consumer_generation = ? AND worker_uid = ?
  AND serving_source_operation_id = ?`;
function executionParams(input: V2QueueBatchExecutionIdentity): (string | number)[] {
  return [
    input.batchId,
    input.reservationToken,
    v2QueueId(input.queueUid),
    input.consumerUid,
    input.generation,
    input.workerUid,
    input.servingSourceOperationId,
  ];
}

async function executionRow(sql: Sql, input: V2QueueBatchExecutionIdentity) {
  const rows = await sql.query(
    `SELECT state,worker_version_uid,worker_version_generation,incarnation_operation_id,
            retirement_kind,retirement_receipt_digest FROM queue_v2_batch_executions
     WHERE ${EXECUTION_SCOPE} LIMIT 2`,
    executionParams(input),
  );
  return rows.length === 1 ? rows[0] : null;
}

/** Pre-send only; a sent or retired execution cannot be canceled by a clock. */
export async function cancelV2QueueBatchBeforeSend(
  sql: Sql,
  input: {
    readonly batchId: string;
    readonly reservationToken: string;
  },
): Promise<boolean> {
  const batchId = input.batchId;
  const reservationToken = input.reservationToken;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(batchId) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(reservationToken)
  )
    return false;
  try {
    await sql.batch([
      {
        sql: `UPDATE queue_v2_batch_executions SET state = 'pre_effect_refused'
          WHERE batch_id = ? AND reservation_token = ?
            AND state IN ('reserved','registered')`,
        params: [batchId, reservationToken],
      },
      {
        sql: `UPDATE selfhost_queue_messages
          SET visible_at_ms = ${DB_NOW_MS},
              deliveries = CASE WHEN deliveries > 0 THEN deliveries - 1 ELSE 0 END,
              lease_token = NULL,lease_expires_at_ms = NULL,
              lease_consumer_id = NULL,lease_generation = NULL,
              lease_max_retries = NULL,lease_retry_delay_seconds = NULL,
              lease_dead_letter_queue_id = NULL,
              lease_dead_letter_delivery_delay_seconds = NULL,
              lease_dead_letter_retention_seconds = NULL
          WHERE EXISTS (SELECT 1 FROM queue_v2_batch_executions execution
            WHERE execution.batch_id = ? AND execution.reservation_token = ?
              AND execution.state = 'pre_effect_refused'
              AND execution.queue_id = selfhost_queue_messages.queue_id
              AND execution.consumer_uid = selfhost_queue_messages.lease_consumer_id
              AND execution.consumer_generation = selfhost_queue_messages.lease_generation
              AND execution.lease_token = selfhost_queue_messages.lease_token)`,
        params: [batchId, reservationToken],
      },
    ]);
  } catch {
    /* Reopen the exact pre-send cancellation after a lost SQL ACK. */
  }
  const rows = await sql.query(
    `SELECT state FROM queue_v2_batch_executions
     WHERE batch_id = ? AND reservation_token = ? LIMIT 2`,
    [batchId, reservationToken],
  );
  return rows.length === 1 && rows[0]?.state === "pre_effect_refused";
}

/** Native owner calls immediately before one one-shot queue event send. */
export async function authorizeV2QueueBatchSend(
  sql: Sql,
  value: V2QueueBatchExecutionIdentity,
): Promise<"authorized" | "already_authorized" | "unknown"> {
  const input = executionIdentity(value);
  try {
    const result = await sql.run(
      `UPDATE queue_v2_batch_executions
      SET state = 'send_authorized',worker_version_uid = ?,worker_version_generation = ?,
          incarnation_operation_id = ?,send_authorized_at_ms = ${DB_NOW_MS}
      WHERE ${EXECUTION_SCOPE} AND state = 'registered'`,
      [
        input.workerVersionUid,
        input.workerVersionGeneration,
        input.incarnationOperationId,
        ...executionParams(input),
      ],
    );
    if (result.changes === 1) return "authorized";
  } catch {
    /* An ACK may be lost after the atomic send grant. */
  }
  const row = await executionRow(sql, input);
  return row?.state === "send_authorized" &&
    row.worker_version_uid === input.workerVersionUid &&
    row.worker_version_generation === input.workerVersionGeneration &&
    row.incarnation_operation_id === input.incarnationOperationId
    ? "already_authorized"
    : "unknown";
}

/** Trusted native terminal/physical-absence observer only, never a tenant RPC. */
export async function confirmV2QueueBatchRetirement(
  sql: Sql,
  value: {
    readonly execution: V2QueueBatchExecutionIdentity;
    readonly kind: "handler_and_wait_until" | "incarnation_absent";
    readonly receiptDigest: string;
  },
): Promise<"retired" | "already_retired" | "unknown"> {
  const input = executionIdentity(value.execution);
  const kind = value.kind;
  const digest = value.receiptDigest;
  if (
    (kind !== "handler_and_wait_until" && kind !== "incarnation_absent") ||
    !/^[a-f0-9]{64}$/u.test(digest)
  )
    throw new TypeError("Queue retirement proof is invalid");
  try {
    const result = await sql.run(
      `UPDATE queue_v2_batch_executions
      SET state = 'retired',retired_at_ms = ${DB_NOW_MS},
          retirement_kind = ?,retirement_receipt_digest = ?
      WHERE ${EXECUTION_SCOPE} AND state = 'send_authorized'
        AND worker_version_uid = ? AND worker_version_generation = ?
        AND incarnation_operation_id = ?`,
      [
        kind,
        digest,
        ...executionParams(input),
        input.workerVersionUid,
        input.workerVersionGeneration,
        input.incarnationOperationId,
      ],
    );
    if (result.changes === 1) return "retired";
  } catch {
    /* Read the exact receipt after an ambiguous SQL acknowledgement. */
  }
  const row = await executionRow(sql, input);
  return row?.state === "retired" &&
    row.worker_version_uid === input.workerVersionUid &&
    row.worker_version_generation === input.workerVersionGeneration &&
    row.incarnation_operation_id === input.incarnationOperationId &&
    row.retirement_kind === kind &&
    row.retirement_receipt_digest === digest
    ? "already_retired"
    : "unknown";
}

/**
 * Host-private SQL claim/receipt selection. The native owner chooses an exact
 * weighted Version from this full vector; this port neither sends an event nor
 * mints settlement permission for customer JavaScript.
 */
export function createV2QueueDelivery(options: {
  readonly sql: Sql;
  readonly custody: QueueCustody;
  readonly capability: V2QueueConsumerCapability;
  readonly randomId?: () => string;
}) {
  const { sql, custody, capability } = options;
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  return {
    /** Privileged producer path. The caller authenticates the selected native Version. */
    async admitMessages(input: {
      readonly queueUid: string;
      readonly producerVersionUid: string;
      readonly principal: string;
      readonly space: string;
      readonly targetKey: string;
      readonly messages: readonly { readonly body: Uint8Array; readonly delaySeconds?: number }[];
    }): Promise<readonly string[]> {
      const scope = {
        queueUid: input.queueUid,
        producerVersionUid: input.producerVersionUid,
        principal: input.principal,
        space: input.space,
        targetKey: input.targetKey,
      };
      if (
        !Array.isArray(input.messages) ||
        input.messages.length < 1 ||
        input.messages.length > 100
      ) {
        throw new TypeError("Queue batch must contain 1 to 100 messages");
      }
      const acceptedAt = Date.now();
      if (!Number.isSafeInteger(acceptedAt) || acceptedAt <= 0)
        throw new TypeError("Queue clock is invalid");
      const prepared = input.messages.map((message) => {
        if (
          !(message.body instanceof Uint8Array) ||
          message.body.byteLength > 127_000 ||
          (message.delaySeconds !== undefined &&
            (!Number.isInteger(message.delaySeconds) ||
              message.delaySeconds < 0 ||
              message.delaySeconds > 43_200))
        ) {
          throw new TypeError("Queue message is invalid");
        }
        const id = randomId();
        if (typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(id))
          throw new TypeError("Queue message ID is invalid");
        const body = message.body.slice();
        return {
          id,
          body: body.buffer.slice(
            body.byteOffset,
            body.byteOffset + body.byteLength,
          ) as ArrayBuffer,
          delay: message.delaySeconds ?? null,
        };
      });
      if (new Set(prepared.map((entry) => entry.id)).size !== prepared.length)
        throw new TypeError("Queue message IDs are not unique");
      const queueId = v2QueueId(scope.queueUid);
      const statements = [];
      // Eight rows/statement keeps a full 100-message send within both D1's
      // 100-parameter and 50-query Free limits, including the shared guard.
      for (let offset = 0; offset < prepared.length; offset += 8) {
        const page = prepared.slice(offset, offset + 8);
        statements.push({
          sql: `INSERT INTO selfhost_queue_messages
            (queue_id,message_id,body,enqueued_at_ms,visible_at_ms,expires_at_ms,deliveries)
            WITH proposed(message_id,body,override_delay) AS
              (VALUES ${page.map(() => "(?,?,?)").join(",")}),
            authority AS (
              SELECT queue.spec_json FROM tf_v2_resources queue
              JOIN tf_v2_operations queue_op ON queue_op.id = queue.last_operation
              WHERE queue.uid = ? AND queue.principal = ? AND queue.space = ?
                AND queue.target_key = ? AND queue.form_url = ?
                AND queue.deleted_at IS NULL AND queue.busy_operation IS NULL
                AND queue.phase = 'idle' AND queue.generation = queue.observed_generation
                AND queue_op.status = 'succeeded' AND queue_op.effect = 'complete'
                AND queue_op.action IN ('create','update')
                AND queue_op.accepted_spec_json = queue.spec_json
                AND EXISTS (
                  SELECT 1 FROM tf_v2_resources version
                  JOIN tf_v2_operations version_op ON version_op.id = version.last_operation
                  JOIN tf_v2_resource_references edge ON edge.referrer_uid = version.uid
                    AND edge.target_uid = queue.uid
                  WHERE version.uid = ? AND version.principal = queue.principal
                    AND version.space = queue.space AND version.target_key = queue.target_key
                    AND version.form_url = ? AND version.deleted_at IS NULL
                    AND version.busy_operation IS NULL AND version.phase = 'idle'
                    AND version.generation = version.observed_generation
                    AND json_extract(version.observed_json, '$.ready') = 1
                    AND version_op.status = 'succeeded' AND version_op.effect = 'complete'
                    AND version_op.accepted_spec_json = version.spec_json
                )
            )
            SELECT ?, proposed.message_id, proposed.body, ?,
                   ? + COALESCE(proposed.override_delay,
                     json_extract(authority.spec_json, '$.deliveryDelaySeconds'), 0) * 1000,
                   ? + json_extract(authority.spec_json, '$.messageRetentionSeconds') * 1000, 0
            FROM proposed CROSS JOIN authority`,
          params: [
            ...page.flatMap(({ id, body, delay }) => [id, body, delay]),
            scope.queueUid,
            scope.principal,
            scope.space,
            scope.targetKey,
            AT_LEAST_ONCE_QUEUE_FORM_URL,
            scope.producerVersionUid,
            WORKER_VERSION_FORM_URL,
            queueId,
            acceptedAt,
            acceptedAt,
            acceptedAt,
          ],
        });
      }
      try {
        const writes = await sql.batch(statements);
        if (
          writes.length === statements.length &&
          writes.every(
            (write, index) => write.changes === prepared.slice(index * 8, (index + 1) * 8).length,
          )
        ) {
          return prepared.map(({ id }) => id);
        }
      } catch {
        // A lost SQL acknowledgement is ambiguous. Producer calls have no
        // generic Host Operation replay key, so never mint/retry another send.
      }
      const error = new Error("Queue admission is unavailable");
      error.name = "backend_unavailable";
      throw error;
    },
    async claimRegisteredBatch(input: {
      readonly consumerUid: string;
      readonly principal: string;
      readonly space: string;
      readonly targetKey: string;
    }): Promise<V2QueueBatchSelection> {
      const identity = {
        consumerUid: input.consumerUid,
        principal: input.principal,
        space: input.space,
        targetKey: input.targetKey,
      };
      const rows = await sql.query(
        `SELECT attachment.spec_json, attachment.observed_json
         FROM tf_v2_resources attachment
         JOIN tf_v2_operations op ON op.id = attachment.last_operation
         WHERE attachment.uid = ? AND attachment.principal = ? AND attachment.space = ?
           AND attachment.target_key = ? AND attachment.form_url = ?
           AND attachment.deleted_at IS NULL AND attachment.phase = 'idle'
           AND attachment.busy_operation IS NULL
           AND attachment.generation = attachment.observed_generation
           AND op.resource_uid = attachment.uid AND op.status = 'succeeded'
           AND op.effect = 'complete' AND op.action IN ('create','update')
           AND op.generation = attachment.generation
           AND op.accepted_spec_json = attachment.spec_json LIMIT 2`,
        [
          identity.consumerUid,
          identity.principal,
          identity.space,
          identity.targetKey,
          QUEUE_CONSUMER_FORM_URL,
        ],
      );
      if (rows.length !== 1) return { kind: "unknown" };
      let spec: ReturnType<typeof parseQueueConsumerSpec>;
      try {
        const row = rows[0];
        if (!row || JSON.parse(String(row.observed_json)).consumerAttached !== true)
          return { kind: "unknown" };
        spec = parseQueueConsumerSpec(JSON.parse(String(row.spec_json)));
      } catch {
        return { kind: "unknown" };
      }
      const queueRows = await sql.query(
        `SELECT resource.name FROM tf_v2_resources resource
         JOIN tf_v2_operations op ON op.id = resource.last_operation
         WHERE resource.uid = ? AND resource.principal = ? AND resource.space = ?
           AND resource.target_key = ? AND resource.form_url = ?
           AND resource.deleted_at IS NULL AND resource.phase = 'idle'
           AND resource.busy_operation IS NULL
           AND resource.generation = resource.observed_generation
           AND json_extract(resource.observed_json, '$.queueExists') = 1
           AND op.status = 'succeeded' AND op.effect = 'complete'
           AND op.action IN ('create','update') AND op.accepted_spec_json = resource.spec_json
         LIMIT 2`,
        [
          spec.queue.resourceUid,
          identity.principal,
          identity.space,
          identity.targetKey,
          AT_LEAST_ONCE_QUEUE_FORM_URL,
        ],
      );
      if (queueRows.length !== 1 || typeof queueRows[0]?.name !== "string")
        return { kind: "unknown" };
      const queueName = queueRows[0].name as string;
      const queueId = v2QueueId(spec.queue.resourceUid);
      const custodyRows = await sql.query(
        `SELECT consumer_id, generation, state, max_retries, retry_delay_seconds,
                dead_letter_queue_id FROM queue_consumer_custody WHERE queue_id = ? LIMIT 2`,
        [queueId],
      );
      const owner = custodyRows.length === 1 ? custodyRows[0] : null;
      if (
        !owner ||
        owner.consumer_id !== identity.consumerUid ||
        owner.state !== "active" ||
        !Number.isSafeInteger(owner.generation) ||
        owner.max_retries !== spec.maxRetries ||
        owner.retry_delay_seconds !== spec.retryDelaySeconds ||
        owner.dead_letter_queue_id !==
          (spec.deadLetterQueue ? v2QueueId(spec.deadLetterQueue.resourceUid) : null)
      ) {
        return { kind: "unknown" };
      }
      const generation = owner.generation as number;
      const serving = await capability.observeCurrentServing({
        workerUid: spec.worker.resourceUid,
        principal: identity.principal,
        space: identity.space,
        targetKey: identity.targetKey,
      });
      if (
        serving.kind !== "ready" ||
        serving.snapshot.worker.uid !== spec.worker.resourceUid ||
        serving.snapshot.worker.principal !== identity.principal ||
        serving.snapshot.worker.space !== identity.space ||
        !serving.snapshot.deployment ||
        serving.snapshot.deployment.versions.length === 0 ||
        serving.snapshot.deployment.versions.some(
          (version) => !version.spec.handlers.includes("queue"),
        )
      )
        return { kind: "unknown" };
      // The selected weighted graph is custody evidence, not a later mutable
      // callback result. Capture it before awaiting any additional I/O.
      const sourceOperationId = serving.snapshot.sourceOperationId;
      const versions = serving.snapshot.deployment.versions.map((version) => ({
        workerVersionUid: version.uid,
        generation: version.generation,
        weight: version.weight,
      }));
      if (
        versions.length > 8 ||
        new Set(versions.map((v) => v.workerVersionUid)).size !== versions.length ||
        versions.some(
          (v) =>
            !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(v.workerVersionUid) ||
            !Number.isSafeInteger(v.generation) ||
            v.generation < 1 ||
            !Number.isSafeInteger(v.weight) ||
            v.weight < 1 ||
            v.weight > 10000,
        ) ||
        versions.reduce((sum, v) => sum + v.weight, 0) !== 10000 ||
        !(await serving.stillCurrent())
      )
        return { kind: "unknown" };
      const current = async () => {
        const [attached] = await sql.query(
          `SELECT 1 FROM tf_v2_resources resource
           JOIN tf_v2_operations op ON op.id = resource.last_operation
           JOIN queue_consumer_custody consumer ON consumer.queue_id = ?
           WHERE resource.uid = ? AND resource.principal = ? AND resource.space = ?
             AND resource.target_key = ? AND resource.form_url = ?
             AND resource.deleted_at IS NULL AND resource.phase = 'idle'
             AND resource.busy_operation IS NULL
             AND resource.generation = resource.observed_generation
             AND op.status = 'succeeded' AND op.effect = 'complete'
             AND op.accepted_spec_json = resource.spec_json
             AND consumer.consumer_id = resource.uid AND consumer.generation = ?
             AND consumer.state = 'active' LIMIT 1`,
          [
            queueId,
            identity.consumerUid,
            identity.principal,
            identity.space,
            identity.targetKey,
            QUEUE_CONSUMER_FORM_URL,
            generation,
          ],
        );
        return attached !== undefined && (await serving.stillCurrent());
      };
      if (!(await current())) return { kind: "unknown" };
      const readiness = await custody.readiness({
        queueId,
        consumerId: identity.consumerUid,
        generation,
        maxBatchSize: spec.maxBatchSize,
        maxBatchTimeoutSeconds: spec.maxBatchTimeoutSeconds,
      });
      if (readiness.state === "inactive") return { kind: "unknown" };
      if (readiness.state !== "ready") return { kind: "idle" };
      // Expiry only recovers an execution for which no send was authorized.
      // An unknown native outcome continues to occupy its slot indefinitely.
      await sql.run(
        `UPDATE queue_v2_batch_executions SET state = 'pre_effect_refused'
         WHERE consumer_uid = ? AND state IN ('reserved','registered')
           AND reservation_until_ms <= ${DB_NOW_MS}`,
        [identity.consumerUid],
      );
      const [capacity] = await sql.query(
        `SELECT count(*) AS n FROM queue_v2_batch_executions
         WHERE consumer_uid = ? AND state IN ('reserved','registered','send_authorized')`,
        [identity.consumerUid],
      );
      if (capacity && typeof capacity.n === "number" && capacity.n >= spec.maxConcurrency)
        return { kind: "idle" };
      const batchId = randomId();
      const reservationToken = randomId();
      if (
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(batchId) ||
        !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(reservationToken)
      )
        return { kind: "unknown" };
      let reserved: Awaited<ReturnType<Sql["run"]>>;
      try {
        reserved = await sql.run(
          `INSERT INTO queue_v2_batch_executions
           (batch_id,reservation_token,queue_id,consumer_uid,consumer_generation,
            worker_uid,serving_source_operation_id,selected_versions_json,principal,space,target_key,
            max_concurrency,reserved_at_ms,reservation_until_ms,state)
           VALUES (?,?,?,?,?,?,?,?,?,?,?, ?,${DB_NOW_MS},${DB_NOW_MS} + 120000,'reserved')`,
          [
            batchId,
            reservationToken,
            queueId,
            identity.consumerUid,
            generation,
            spec.worker.resourceUid,
            sourceOperationId,
            canonicalJson(versions),
            identity.principal,
            identity.space,
            identity.targetKey,
            spec.maxConcurrency,
          ],
        );
      } catch {
        return { kind: "unknown" };
      }
      if (reserved.changes !== 1) return { kind: "unknown" };
      const claims = await custody.claim({
        queueId,
        consumerId: identity.consumerUid,
        generation,
        limit: spec.maxBatchSize,
        v2Attachment: {
          principal: identity.principal,
          space: identity.space,
          targetKey: identity.targetKey,
        },
        v2Reservation: { batchId, reservationToken },
      });
      if (claims.length === 0) {
        await cancelV2QueueBatchBeforeSend(sql, { batchId, reservationToken });
        return { kind: "idle" };
      }
      try {
        await custody.registerSettlementBatch(batchId, claims, { reservationToken });
        if (!(await current())) {
          await cancelV2QueueBatchBeforeSend(sql, { batchId, reservationToken });
          return { kind: "unknown" };
        }
      } catch {
        // Nothing was returned to the native sender. A same-token pre-send
        // cancellation may refund the claim; an unknown DB result remains
        // occupied until exact recovery, never assumed sent or settled.
        try {
          await cancelV2QueueBatchBeforeSend(sql, { batchId, reservationToken });
        } catch {
          /* The persisted reservation remains authoritative. */
        }
        return { kind: "unknown" };
      }
      return {
        kind: "ready",
        batchId,
        reservationToken,
        queueUid: spec.queue.resourceUid,
        queueName,
        workerUid: spec.worker.resourceUid,
        consumerUid: identity.consumerUid,
        generation,
        servingSourceOperationId: sourceOperationId,
        versions,
        claims: claims.map((claim) => ({ ...claim, body: claim.body.slice() })),
        stillCurrent: current,
      };
    },
  };
}
