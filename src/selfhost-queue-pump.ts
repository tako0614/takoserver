import type { Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import type { SelfhostEventTarget, SelfhostEventTargets } from "./providers/selfhost.ts";
import {
  MAX_SELFHOST_EVENT_RESPONSE_BYTES,
  MAX_SELFHOST_QUEUE_MESSAGES,
  parseSelfhostQueueDecisions,
  SELFHOST_WORKER_EVENT_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_HEADER,
  SELFHOST_WORKER_EVENT_PATH,
  SELFHOST_WORKER_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_RESPONSE_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_TOKEN_HEADER,
  type SelfhostQueueDecision,
  selfhostQueueEvent,
} from "./providers/selfhost-events.ts";
import type { SelfhostQueueConsumerAttachment } from "./providers/selfhost-script-state.ts";
import type { WorkerdRuntime } from "./workerd-runtime.ts";

/**
 * What actually moves a message on a machine standing on its own.
 *
 * Cloudflare runs the queue and calls the Worker; here the queue is rows in the
 * control database and the call is one HTTP request through the workerd router.
 * Everything the `QueueConsumer` Form promises is decided in this file:
 *
 * - **`maxBatchSize` / `maxBatchTimeoutSeconds`.** A batch leaves as soon as it
 *   is full, or as soon as its oldest due message has waited the timeout. A
 *   partial batch delivered instantly would make the timeout meaningless; a
 *   full one held for it would make the size a lie.
 * - **`maxConcurrency`.** At most that many batches are in flight for one
 *   consumer at a time. It is a ceiling on this machine, not a promise of
 *   parallelism.
 * - **`maxRetries`.** REDELIVERIES, not deliveries: a message is delivered at
 *   most `1 + maxRetries` times, and one that exhausts them moves to the
 *   dead-letter queue as a NEW message — new identity, new acceptance instant,
 *   its own count starting again — or is dropped when none is declared.
 * - **`retryDelaySeconds`.** When the handler asked for no delay of its own.
 * - **`deliveryDelaySeconds` / `messageRetentionSeconds`.** Applied at
 *   acceptance by the producer plane, so both are already absolute instants on
 *   the row by the time this file reads it.
 *
 * A batch owns its messages under a lease. That is what makes a crash safe: a
 * process that dies between dispatch and settlement leaves rows whose lease
 * expires, and the next pass takes them again. At-least-once is the contract,
 * so a handler that acknowledged work this Host never recorded will see the
 * message twice, which is the guarantee rather than a defect.
 *
 * Nothing tenant-controlled reaches a SQL identifier, a filesystem path, or a
 * log line here. A queue is addressed by the id the provider derived, a message
 * body is bytes this file never reads, and a delivery failure is counted rather
 * than described.
 */

/** How long an in-flight batch owns its messages. */
const DEFAULT_LEASE_MILLIS = 120_000;
/** How long one batch invocation may run before the pump gives up on it. */
const DEFAULT_INVOCATION_TIMEOUT_MILLIS = 60_000;
/** Rows one sweep reclaims, so a dead queue never becomes the tick. */
const SWEEP_BATCH = 1_000;
/** Queues one pass will drain, so one busy Worker cannot starve the others. */
const MAX_BATCHES_PER_CONSUMER = 8;

export interface SelfhostQueuePumpOptions {
  /** Control storage; the messages live here under migration 0039. */
  readonly sql: Sql;
  /** The runtime the event is delivered through, by its own event hostname. */
  readonly runtime: WorkerdRuntime;
  /** Which Workers have a Consumer attached, and the token to reach them with. */
  readonly targets: SelfhostEventTargets;
  readonly clock?: () => Date;
  /** The identity of one batch and of one dead-lettered message. */
  readonly randomId?: () => string;
  readonly leaseMillis?: number;
  readonly invocationTimeoutMillis?: number;
}

export interface SelfhostQueuePump {
  /** One pass over every attached consumer. Answers messages settled. */
  tick(): Promise<number>;
  /** Reclaims messages whose retention ran out, bounded. */
  sweep(limit?: number): Promise<number>;
  /** Drops every stored message of one queue, when the queue stops existing. */
  deleteQueue(queueId: string): Promise<void>;
}

interface ReservedMessage {
  readonly messageId: string;
  readonly body: string;
  readonly enqueuedAtMillis: number;
  readonly attempts: number;
}

export function createSelfhostQueuePump(options: SelfhostQueuePumpOptions): SelfhostQueuePump {
  const now = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const leaseMillis = options.leaseMillis ?? DEFAULT_LEASE_MILLIS;
  const invocationTimeoutMillis =
    options.invocationTimeoutMillis ?? DEFAULT_INVOCATION_TIMEOUT_MILLIS;
  const { sql, runtime } = options;

  /**
   * Takes up to one batch for one consumer, or answers null.
   *
   * Null means one of three things and deliberately does not distinguish them:
   * nothing is due, what is due is not worth sending yet because the batch
   * timeout has not elapsed, or another pass took the rows first.
   */
  const reserve = async (
    consumer: SelfhostQueueConsumerAttachment,
    millis: number,
  ): Promise<{ readonly token: string; readonly messages: readonly ReservedMessage[] } | null> => {
    const rows = await sql.query(
      "SELECT message_id, body, enqueued_at_ms, visible_at_ms, deliveries " +
        "FROM selfhost_queue_messages " +
        "WHERE queue_id = ? AND visible_at_ms <= ? AND expires_at_ms > ? " +
        "AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?) " +
        "ORDER BY visible_at_ms, message_id LIMIT ?",
      [
        consumer.queue,
        millis,
        millis,
        millis,
        Math.min(consumer.maxBatchSize, MAX_SELFHOST_QUEUE_MESSAGES),
      ],
    );
    if (rows.length === 0) return null;
    // A batch that is not full waits for the timeout it was given, measured
    // from the moment its oldest message became deliverable.
    if (rows.length < consumer.maxBatchSize) {
      const oldest = Math.min(...rows.map((row) => integer(row.visible_at_ms)));
      if (oldest + consumer.maxBatchTimeoutSeconds * 1_000 > millis) return null;
    }
    const token = randomId();
    const claims = rows.map((row) => ({
      sql:
        "UPDATE selfhost_queue_messages " +
        "SET lease_token = ?, lease_expires_at_ms = ?, deliveries = deliveries + 1 " +
        "WHERE queue_id = ? AND message_id = ? " +
        "AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)",
      params: [
        token,
        millis + leaseMillis,
        consumer.queue,
        String(row.message_id),
        millis,
      ] as readonly SqlParam[],
    }));
    const written = await sql.batch(claims);
    const messages: ReservedMessage[] = [];
    for (let index = 0; index < rows.length; index += 1) {
      if ((written[index]?.changes ?? 0) !== 1) continue;
      const row = rows[index] as Row;
      messages.push({
        messageId: String(row.message_id),
        body: base64(row.body),
        enqueuedAtMillis: integer(row.enqueued_at_ms),
        // The count on the row is deliveries already made, and this claim was
        // one of them; the handler is told which attempt it is looking at.
        attempts: integer(row.deliveries) + 1,
      });
    }
    return messages.length === 0 ? null : { token, messages };
  };

  /**
   * Hands one batch to the Worker and settles what comes back.
   *
   * Anything short of a well-formed decision for every message is a whole-batch
   * retry: no answer, a status that is not 200, an envelope this Host cannot
   * parse, or a decision list that does not name exactly the messages sent. A
   * message nobody decided about is one this Host still owes.
   */
  const deliver = async (
    target: SelfhostEventTarget,
    consumer: SelfhostQueueConsumerAttachment,
    reserved: { readonly token: string; readonly messages: readonly ReservedMessage[] },
  ): Promise<number> => {
    let decisions: readonly SelfhostQueueDecision[] | null = null;
    try {
      const event = selfhostQueueEvent({
        batchId: randomId(),
        script: target.script,
        publication: target.versionId,
        queue: consumer.queue,
        messages: reserved.messages.map((message) => ({
          messageId: message.messageId,
          timestampMillis: message.enqueuedAtMillis,
          attempts: message.attempts,
          body: { encoding: "base64" as const, data: message.body },
        })),
      });
      const answer = await runtime.probe?.(target.script, SELFHOST_WORKER_EVENT_PATH, {
        method: "POST",
        route: "events",
        headers: {
          "content-type": SELFHOST_WORKER_EVENT_CONTENT_TYPE,
          accept: SELFHOST_WORKER_EVENT_RESPONSE_CONTENT_TYPE,
          [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_WORKER_EVENT_PROTOCOL,
          [SELFHOST_WORKER_EVENT_TOKEN_HEADER]: target.eventToken,
        },
        body: JSON.stringify(event),
        timeoutMillis: invocationTimeoutMillis,
      });
      if (
        answer &&
        answer.status === 200 &&
        answer.body.length <= MAX_SELFHOST_EVENT_RESPONSE_BYTES
      ) {
        decisions = parseSelfhostQueueDecisions(
          answer.body,
          event.messages.map(({ messageId }) => messageId),
        );
      }
    } catch {
      decisions = null;
    }
    const byId = new Map((decisions ?? []).map((decision) => [decision.messageId, decision]));
    const millis = now().getTime();
    const statements: SqlStatement[] = [];
    for (const message of reserved.messages) {
      const decision = byId.get(message.messageId);
      if (decision?.outcome === "ack") {
        statements.push({
          sql: "DELETE FROM selfhost_queue_messages WHERE queue_id = ? AND message_id = ? AND lease_token = ?",
          params: [consumer.queue, message.messageId, reserved.token],
        });
        continue;
      }
      // Exhausted counts redeliveries: the first delivery is free, so a message
      // is done once it has been delivered `1 + maxRetries` times.
      if (message.attempts >= 1 + consumer.maxRetries) {
        statements.push(...exhausted(consumer, message, reserved.token, millis));
        continue;
      }
      const delaySeconds =
        decision?.outcome === "retry" && decision.delaySeconds !== undefined
          ? decision.delaySeconds
          : consumer.retryDelaySeconds;
      statements.push({
        sql:
          "UPDATE selfhost_queue_messages SET visible_at_ms = ?, lease_token = NULL, " +
          "lease_expires_at_ms = NULL WHERE queue_id = ? AND message_id = ? AND lease_token = ?",
        params: [millis + delaySeconds * 1_000, consumer.queue, message.messageId, reserved.token],
      });
    }
    if (statements.length > 0) await sql.batch(statements);
    return reserved.messages.length;
  };

  /** Where a message goes once its redeliveries are spent. */
  const exhausted = (
    consumer: SelfhostQueueConsumerAttachment,
    message: ReservedMessage,
    token: string,
    millis: number,
  ): readonly SqlStatement[] => {
    const removal: SqlStatement = {
      sql: "DELETE FROM selfhost_queue_messages WHERE queue_id = ? AND message_id = ? AND lease_token = ?",
      params: [consumer.queue, message.messageId, token],
    };
    const target = consumer.deadLetterQueue;
    if (!target) return [removal];
    // A new message there, not a moved one: the Form is explicit that the
    // dead-letter copy has its own identity, its own acceptance timestamp, and
    // an attempt count starting again at one.
    return [
      {
        sql:
          "INSERT INTO selfhost_queue_messages " +
          "(queue_id, message_id, body, enqueued_at_ms, visible_at_ms, expires_at_ms, deliveries) " +
          "VALUES (?, ?, ?, ?, ?, ?, 0)",
        params: [
          target.queue,
          randomId(),
          bytes(message.body),
          millis,
          millis + target.deliveryDelaySeconds * 1_000,
          millis + target.messageRetentionSeconds * 1_000,
        ],
      },
      removal,
    ];
  };

  return {
    async tick() {
      const targets = await options.targets.list();
      let settled = 0;
      for (const target of targets) {
        // A Worker that never declared a `queue` handler cannot be handed a
        // batch. The attachment upstream is gated on the declaration, so this
        // is a second lock rather than the first.
        if (!target.handlers.includes("queue")) continue;
        for (const consumer of target.consumers) {
          for (let pass = 0; pass < MAX_BATCHES_PER_CONSUMER; pass += 1) {
            const reserved: {
              readonly token: string;
              readonly messages: readonly ReservedMessage[];
            }[] = [];
            const millis = now().getTime();
            for (let slot = 0; slot < consumer.maxConcurrency; slot += 1) {
              const batch = await reserve(consumer, millis);
              if (!batch) break;
              reserved.push(batch);
            }
            if (reserved.length === 0) break;
            const counts = await Promise.all(
              reserved.map((batch) => deliver(target, consumer, batch)),
            );
            for (const count of counts) settled += count;
          }
        }
      }
      return settled;
    },

    async sweep(limit = SWEEP_BATCH) {
      const bounded = Math.max(1, Math.min(limit, SWEEP_BATCH));
      const rows = await sql.query(
        "SELECT queue_id, message_id FROM selfhost_queue_messages WHERE expires_at_ms <= ? LIMIT ?",
        [now().getTime(), bounded],
      );
      if (rows.length === 0) return 0;
      await sql.batch(
        rows.map((row) => ({
          sql: "DELETE FROM selfhost_queue_messages WHERE queue_id = ? AND message_id = ?",
          params: [String(row.queue_id), String(row.message_id)] as readonly SqlParam[],
        })),
      );
      return rows.length;
    },

    async deleteQueue(queueId) {
      await sql.run("DELETE FROM selfhost_queue_messages WHERE queue_id = ?", [queueId]);
    },
  };
}

function integer(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

/** A stored body, as the base64 the event envelope carries. */
function base64(value: unknown): string {
  const raw =
    value instanceof Uint8Array
      ? value
      : value instanceof ArrayBuffer
        ? new Uint8Array(value)
        : ArrayBuffer.isView(value)
          ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength)
          : new TextEncoder().encode(typeof value === "string" ? value : "");
  let binary = "";
  for (let offset = 0; offset < raw.byteLength; offset += 4_096) {
    binary += String.fromCharCode(...raw.subarray(offset, offset + 4_096));
  }
  return btoa(binary);
}

/** The same bytes back, for the copy a dead-letter transfer writes. */
function bytes(encoded: string): SqlParam {
  const binary = atob(encoded);
  const raw = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) raw[index] = binary.charCodeAt(index);
  return raw.buffer.slice(0) as ArrayBuffer;
}
