import type { Sql, SqlParam, SqlStatement } from "./ports.ts";
import type {
  SelfhostEventSelection,
  SelfhostEventTarget,
  SelfhostEventTargets,
} from "./providers/selfhost.ts";
import {
  MAX_SELFHOST_EVENT_REQUEST_BYTES,
  MAX_SELFHOST_EVENT_RESPONSE_BYTES,
  MAX_SELFHOST_QUEUE_MESSAGES,
  parseSelfhostQueueDecisions,
  SELFHOST_WORKER_EVENT_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_HEADER,
  SELFHOST_WORKER_EVENT_PATH,
  SELFHOST_WORKER_EVENT_PROTOCOL,
  SELFHOST_WORKER_EVENT_RESPONSE_CONTENT_TYPE,
  SELFHOST_WORKER_EVENT_TOKEN_HEADER,
  SelfhostEventShapeError,
  type SelfhostQueueDecision,
  selfhostQueueEvent,
} from "./providers/selfhost-events.ts";
import {
  isSelfhostPortableQueueName,
  type SelfhostQueueConsumerAttachment,
} from "./providers/selfhost-script-state.ts";
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
 *   full one held for it would make the size a lie. A batch is also full once
 *   the next message would not fit its envelope.
 * - **`maxConcurrency`.** At most that many batches are in flight for one
 *   consumer at a time. It is a ceiling on this machine, not a promise of
 *   parallelism.
 * - **`maxRetries`.** REDELIVERIES, not deliveries: a message is delivered at
 *   most `1 + maxRetries` times, and one that exhausts them moves to the
 *   dead-letter queue as a NEW message -- new identity, new acceptance instant,
 *   its own count starting again -- or is dropped when none is declared.
 * - **`retryDelaySeconds`.** When the handler asked for no delay of its own.
 * - **`deliveryDelaySeconds` / `messageRetentionSeconds`.** Applied at
 *   acceptance by the producer plane, so both are already absolute instants on
 *   the row by the time this file reads it.
 *
 * Two rules decide what a delivery costs the tenant, and they are the whole
 * reason this file is careful:
 *
 * - **A batch is reserved by encoded size as well as by count.** The event
 *   envelope has a ceiling, and a batch over it is one this Host cannot send at
 *   all. Reserving below that ceiling is what keeps the number of messages a
 *   batch claimed and the number that actually left equal. A batch that still
 *   cannot be built is split, never settled: nothing was sent, so nothing is
 *   counted and nothing reaches a dead-letter queue.
 * - **"No answer" is not "the tenant refused".** A workerd that is restarting,
 *   a refused connection, a timeout, and a reply that is not this protocol are
 *   all this Host failing to ask. The lease is released, the delivery count is
 *   put back where it was, and the consumer is left alone for a bounded moment.
 *   An answer the tenant's own module produced -- its decisions, or the
 *   wrapper's status for a handler that threw -- spends a redelivery. A process
 *   that dies before recording either outcome leaves its durable attempt spent:
 *   recovery cannot know whether the handler ran.
 *
 * A batch owns its messages under a lease. That is what makes a crash safe: a
 * process that dies between dispatch and settlement leaves rows whose lease
 * expires. The next pass takes them again only within the retry budget;
 * exhausted messages go to the dead-letter queue or are dropped. At-least-once
 * permits a handler to see work again when its acknowledgement was not recorded.
 *
 * One tenant cannot take the pass from another. Targets are worked a few at a
 * time and from a rotating start, each consumer gets a bounded slice of the
 * tick, an invocation may not outlast that slice, and a throw anywhere inside
 * one target is that target's alone.
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
/** The floor under a bounded invocation timeout, so a slice never means zero. */
const MIN_INVOCATION_TIMEOUT_MILLIS = 1_000;
/** How much of one tick a single consumer may spend before the pass moves on. */
const DEFAULT_CONSUMER_BUDGET_MILLIS = 60_000;
/** Rows one sweep page reclaims. */
const SWEEP_PAGE = 1_000;
/** Rows one sweep reclaims in total, so a dead queue never becomes the tick. */
const SWEEP_LIMIT = 100_000;
/** Batches one consumer may drain in one pass. */
const MAX_BATCHES_PER_CONSUMER = 8;
/** Targets in flight at once, so one slow Worker does not hold the rest. */
const MAX_CONCURRENT_TARGETS = 8;
/** First wait after a Worker did not answer, doubling to the ceiling below. */
const NO_ANSWER_BACKOFF_MILLIS = 1_000;
const MAX_NO_ANSWER_BACKOFF_MILLIS = 60_000;
/**
 * The longest batch id the envelope's own grammar accepts.
 *
 * Reserved from the budget rather than measured, because the id is minted after
 * the batch has been reserved and a budget that depended on it would be a
 * different number every pass.
 */
const MAX_BATCH_ID_BYTES = 512;
/** The deployment identity uses the same bounded token grammar as a batch id. */
const MAX_DEPLOYMENT_ID_BYTES = 512;
/**
 * What one message costs inside the envelope besides its own values.
 *
 * Derived from the exact projection below rather than counted by hand: the two
 * zeros stand in for the numbers, the empty id's quotes come back with
 * `JSON.stringify(messageId)`, and the one extra byte is the comma that
 * separates this message from the next.
 */
const QUEUE_MESSAGE_FIXED_BYTES =
  JSON.stringify({
    messageId: "",
    timestampMillis: 0,
    attempts: 0,
    body: { encoding: "base64", data: "" },
  }).length -
  4 +
  1;

export interface SelfhostQueuePumpOptions {
  /** Control storage; the messages live here under migration 0040. */
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
  /** How much of one tick a single consumer may spend. */
  readonly consumerBudgetMillis?: number;
}

export interface SelfhostQueuePump {
  /** One pass over every attached consumer. Answers messages settled. */
  tick(): Promise<number>;
  /** Reclaims messages whose retention ran out, bounded. */
  sweep(limit?: number): Promise<number>;
}

interface ReservedMessage {
  readonly messageId: string;
  readonly body: string;
  readonly enqueuedAtMillis: number;
  readonly visibleAtMillis: number;
  readonly attempts: number;
}

interface ReservedBatch {
  readonly token: string;
  readonly messages: readonly ReservedMessage[];
}

/** What one delivery attempt cost, and whether the Worker answered at all. */
interface DeliveryOutcome {
  readonly settled: number;
  /** False for "this Host could not ask", which must never spend a retry. */
  readonly answered: boolean;
}

type DeliverableQueueConsumer = SelfhostQueueConsumerAttachment & {
  readonly queueName: string;
  readonly deadLetterQueue?: NonNullable<SelfhostQueueConsumerAttachment["deadLetterQueue"]> & {
    readonly queueName: string;
  };
};

/** Legacy attachments retain their messages until an authoritative reapply names every queue. */
function isDeliverableQueueConsumer(
  consumer: SelfhostQueueConsumerAttachment,
): consumer is DeliverableQueueConsumer {
  return (
    isSelfhostPortableQueueName(consumer.queueName) &&
    (consumer.deadLetterQueue === undefined ||
      isSelfhostPortableQueueName(consumer.deadLetterQueue.queueName))
  );
}

export function createSelfhostQueuePump(options: SelfhostQueuePumpOptions): SelfhostQueuePump {
  const now = options.clock ?? (() => new Date());
  const randomId = options.randomId ?? (() => crypto.randomUUID());
  const leaseMillis = options.leaseMillis ?? DEFAULT_LEASE_MILLIS;
  const invocationTimeoutMillis =
    options.invocationTimeoutMillis ?? DEFAULT_INVOCATION_TIMEOUT_MILLIS;
  const consumerBudgetMillis = options.consumerBudgetMillis ?? DEFAULT_CONSUMER_BUDGET_MILLIS;
  const { sql, runtime } = options;
  /**
   * How long each consumer whose Worker did not answer is left alone for.
   *
   * In memory rather than on a row, because it is a fact about the Worker and
   * not about any one message, and because a process that restarts has already
   * done the only thing the wait was for.
   */
  const silence = new Map<string, { readonly failures: number; readonly untilMillis: number }>();
  /** Where the next pass starts in the target list, so no queue is always last. */
  let rotation = 0;

  /**
   * How many bytes of messages one envelope for this consumer may carry.
   *
   * The ceiling is the wrapper's, so the arithmetic is done here rather than
   * discovered by a refused delivery: an envelope over it is a batch this Host
   * would have to throw away, and throwing away a batch is what a queue must
   * never do.
   */
  const budgetFor = (target: SelfhostEventTarget, consumer: DeliverableQueueConsumer) =>
    MAX_SELFHOST_EVENT_REQUEST_BYTES -
    utf8Bytes(
      JSON.stringify({
        protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
        kind: "queue",
        batchId: "",
        logicalWorkerId: target.script,
        // Selection happens only once there is an actual reserved batch. Hold
        // the grammar's maximum here so every selected Version still fits.
        deploymentId: "x".repeat(MAX_DEPLOYMENT_ID_BYTES),
        queue: consumer.queueName,
        messages: [],
      }),
    ) -
    MAX_BATCH_ID_BYTES;

  /**
   * Takes up to one batch for one consumer, or answers null.
   *
   * Null means one of three things and deliberately does not distinguish them:
   * nothing is due, what is due is not worth sending yet because the batch
   * timeout has not elapsed, or another pass took the rows first.
   */
  const reserve = async (
    consumer: DeliverableQueueConsumer,
    millis: number,
    budget: number,
  ): Promise<ReservedBatch | null> => {
    const rows = (
      await sql.query(
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
      )
    ).filter((row) => integer(row.deliveries) < 1 + consumer.maxRetries);
    if (rows.length === 0) return null;
    // Reserved by encoded size as well as by count. The first message always
    // goes, whatever it costs: refusing to move a row is how a queue stops
    // forever, and the producer's own ceiling on a message body makes a single
    // unsendable message impossible.
    const candidates: ReservedMessage[] = [];
    let used = 0;
    for (const row of rows) {
      const message: ReservedMessage = {
        messageId: String(row.message_id),
        body: base64(row.body),
        enqueuedAtMillis: integer(row.enqueued_at_ms),
        visibleAtMillis: integer(row.visible_at_ms),
        // The count on the row is deliveries already made, and this claim is
        // about to be one of them; the handler is told which attempt it sees.
        attempts: integer(row.deliveries) + 1,
      };
      const cost = messageCost(message);
      if (candidates.length > 0 && used + cost > budget) break;
      used += cost;
      candidates.push(message);
    }
    // A batch that is not full waits for the timeout it was given, measured
    // from the moment its oldest message became deliverable. A batch the
    // envelope cut short is full: there is more waiting right behind it.
    if (candidates.length === rows.length && rows.length < consumer.maxBatchSize) {
      const oldest = Math.min(...rows.map((row) => integer(row.visible_at_ms)));
      if (oldest + consumer.maxBatchTimeoutSeconds * 1_000 > millis) return null;
    }
    const token = randomId();
    // The SELECT may have waited while another pump settled these messages.
    // Claim the observed incarnation/count/visibility only if it is still due
    // and retained now; an old read must not bypass a retry or renew expiry.
    const claimMillis = now().getTime();
    const written = await sql.batch(
      candidates.map((message) => ({
        sql:
          "UPDATE selfhost_queue_messages " +
          "SET lease_token = ?, lease_expires_at_ms = ?, deliveries = deliveries + 1 " +
          "WHERE queue_id = ? AND message_id = ? " +
          "AND deliveries = ? AND enqueued_at_ms = ? AND visible_at_ms = ? " +
          "AND visible_at_ms <= ? AND expires_at_ms > ? " +
          "AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)",
        params: [
          token,
          claimMillis + leaseMillis,
          consumer.queue,
          message.messageId,
          message.attempts - 1,
          message.enqueuedAtMillis,
          message.visibleAtMillis,
          claimMillis,
          claimMillis,
          claimMillis,
        ] as readonly SqlParam[],
      })),
    );
    const messages = candidates.filter((_, index) => (written[index]?.changes ?? 0) === 1);
    return messages.length === 0 ? null : { token, messages };
  };

  /**
   * Gives the messages back, exactly as they were.
   *
   * The claim that took them counted a delivery, so putting them back uncounts
   * it. This is the path for a batch that never left this process, and a batch
   * that never left must not cost the tenant anything at all.
   */
  const release = async (
    consumer: SelfhostQueueConsumerAttachment,
    token: string,
    messages: readonly ReservedMessage[],
    visibleAtMillis: number,
  ): Promise<void> => {
    if (messages.length === 0) return;
    await sql.batch(
      messages.map((message) => ({
        sql:
          "UPDATE selfhost_queue_messages SET visible_at_ms = ?, lease_token = NULL, " +
          "lease_expires_at_ms = NULL, " +
          "deliveries = CASE WHEN deliveries > 0 THEN deliveries - 1 ELSE 0 END " +
          "WHERE queue_id = ? AND message_id = ? AND lease_token = ?",
        params: [
          Math.max(1, visibleAtMillis),
          consumer.queue,
          message.messageId,
          token,
        ] as readonly SqlParam[],
      })),
    );
  };

  /**
   * Hands one batch to the Worker and settles what comes back.
   *
   * Three outcomes, and telling them apart is the point. A well-formed decision
   * for every message settles the batch. An answer the tenant's own module
   * produced that is not one -- the wrapper's status for a handler that threw --
   * is a refusal, and spends a redelivery. Anything else is this Host failing to
   * ask, and the batch goes back untouched and uncounted.
   */
  const deliver = async (
    target: SelfhostEventTarget,
    selected: SelfhostEventSelection,
    consumer: DeliverableQueueConsumer,
    reserved: ReservedBatch,
    deadlineMillis: number,
  ): Promise<DeliveryOutcome> => {
    let event: ReturnType<typeof selfhostQueueEvent>;
    try {
      event = selfhostQueueEvent({
        batchId: randomId(),
        script: target.script,
        publication: selected.versionId,
        queue: consumer.queueName,
        messages: reserved.messages.map((message) => ({
          messageId: message.messageId,
          timestampMillis: message.enqueuedAtMillis,
          attempts: message.attempts,
          body: { encoding: "base64" as const, data: message.body },
        })),
      });
    } catch (error) {
      if (!(error instanceof SelfhostEventShapeError)) throw error;
      return await split(target, selected, consumer, reserved, deadlineMillis);
    }
    let answer: { readonly status: number; readonly body: string } | null | undefined;
    try {
      answer = await runtime.probe?.(target.script, SELFHOST_WORKER_EVENT_PATH, {
        method: "POST",
        route: "events",
        headers: {
          "content-type": SELFHOST_WORKER_EVENT_CONTENT_TYPE,
          accept: SELFHOST_WORKER_EVENT_RESPONSE_CONTENT_TYPE,
          [SELFHOST_WORKER_EVENT_HEADER]: SELFHOST_WORKER_EVENT_PROTOCOL,
          [SELFHOST_WORKER_EVENT_TOKEN_HEADER]: selected.eventToken,
        },
        body: JSON.stringify(event),
        timeoutMillis: boundedTimeout(deadlineMillis),
      });
    } catch {
      answer = null;
    }
    let decisions: readonly SelfhostQueueDecision[] | null = null;
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
    // The wrapper answers 500 and nothing else when the tenant's handler threw,
    // so that status is the tenant refusing the whole batch. Every other shape
    // -- no answer, a status this protocol does not use, a body that is not the
    // decisions envelope -- is a question this Host failed to ask.
    if (!decisions && answer?.status !== 500) {
      await release(consumer, reserved.token, reserved.messages, now().getTime());
      return { settled: 0, answered: false };
    }
    const settled = await settle(consumer, reserved, decisions);
    return { settled, answered: true };
  };

  /**
   * Sends half a batch this Host could not send whole.
   *
   * The envelope has a ceiling and `reserve` stops below it, so reaching here
   * means one grew past it anyway. Halving is the answer rather than
   * dead-lettering: nothing was sent, so nothing may be settled and nothing may
   * be counted. A single message that still will not go is put back with the
   * same wait a silent Worker gets -- the producer's own caps make that
   * impossible, and destroying the row would be worse than leaving it.
   */
  const split = async (
    target: SelfhostEventTarget,
    selected: SelfhostEventSelection,
    consumer: DeliverableQueueConsumer,
    reserved: ReservedBatch,
    deadlineMillis: number,
  ): Promise<DeliveryOutcome> => {
    const millis = now().getTime();
    if (reserved.messages.length < 2) {
      await release(consumer, reserved.token, reserved.messages, millis + NO_ANSWER_BACKOFF_MILLIS);
      return { settled: 0, answered: false };
    }
    const half = Math.floor(reserved.messages.length / 2);
    // The tail goes back immediately visible: the next pass takes it, at the
    // size this one proved it has to be.
    await release(consumer, reserved.token, reserved.messages.slice(half), millis);
    return await deliver(
      target,
      selected,
      consumer,
      { token: reserved.token, messages: reserved.messages.slice(0, half) },
      deadlineMillis,
    );
  };

  /** Writes what the tenant decided, or the whole-batch retry it refused with. */
  const settle = async (
    consumer: SelfhostQueueConsumerAttachment,
    reserved: ReservedBatch,
    decisions: readonly SelfhostQueueDecision[] | null,
  ): Promise<number> => {
    const byId = new Map((decisions ?? []).map((decision) => [decision.messageId, decision]));
    const millis = now().getTime();
    const statements: SqlStatement[] = [];
    const settlements: number[] = [];
    for (const message of reserved.messages) {
      const decision = byId.get(message.messageId);
      if (decision?.outcome === "ack") {
        statements.push({
          sql: "DELETE FROM selfhost_queue_messages WHERE queue_id = ? AND message_id = ? AND lease_token = ?",
          params: [consumer.queue, message.messageId, reserved.token],
        });
      } else if (message.attempts >= 1 + consumer.maxRetries) {
        // Exhausted counts redeliveries: the first delivery is free, so a
        // message is done after `1 + maxRetries` deliveries.
        statements.push(...exhausted(consumer, message.messageId, reserved.token, millis));
      } else {
        const delaySeconds =
          decision?.outcome === "retry" && decision.delaySeconds !== undefined
            ? decision.delaySeconds
            : consumer.retryDelaySeconds;
        statements.push({
          sql:
            "UPDATE selfhost_queue_messages SET visible_at_ms = ?, lease_token = NULL, " +
            "lease_expires_at_ms = NULL WHERE queue_id = ? AND message_id = ? AND lease_token = ?",
          params: [
            millis + delaySeconds * 1_000,
            consumer.queue,
            message.messageId,
            reserved.token,
          ],
        });
      }
      // Count the final source write, not the DLQ insert as a second message
      // and not an old holder's token-fenced no-op as a successful settlement.
      settlements.push(statements.length - 1);
    }
    if (statements.length === 0) return 0;
    const written = await sql.batch(statements);
    return settlements.filter((index) => written[index]?.changes === 1).length;
  };

  /** Where a message goes once its redeliveries are spent. */
  const exhausted = (
    consumer: SelfhostQueueConsumerAttachment,
    messageId: string,
    token: string,
    millis: number,
  ): readonly SqlStatement[] => {
    const removal: SqlStatement = {
      sql: "DELETE FROM selfhost_queue_messages WHERE queue_id = ? AND message_id = ? AND lease_token = ?",
      params: [consumer.queue, messageId, token],
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
          "SELECT ?, ?, body, ?, ?, ?, 0 FROM selfhost_queue_messages " +
          "WHERE queue_id = ? AND message_id = ? AND lease_token = ?",
        params: [
          target.queue,
          randomId(),
          millis,
          millis + target.deliveryDelaySeconds * 1_000,
          millis + target.messageRetentionSeconds * 1_000,
          consumer.queue,
          messageId,
          token,
        ],
      },
      removal,
    ];
  };

  /** Finishes spent deliveries abandoned by a crashed holder, without sending again. */
  const recoverExhausted = async (consumer: DeliverableQueueConsumer): Promise<number> => {
    const millis = now().getTime();
    // Filter a bounded ready page in memory. Filtering on the unindexed count
    // in SQL would scan the healthy backlog on every pass looking for failures.
    const rows = (
      await sql.query(
        "SELECT message_id, enqueued_at_ms, visible_at_ms, deliveries, " +
          "lease_token, lease_expires_at_ms FROM selfhost_queue_messages " +
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
      )
    ).filter((row) => integer(row.deliveries) >= 1 + consumer.maxRetries);
    if (rows.length === 0) return 0;
    const token = randomId();
    const claimMillis = now().getTime();
    const statements: SqlStatement[] = [];
    const settlements: number[] = [];
    for (const row of rows) {
      const messageId = String(row.message_id);
      statements.push({
        sql:
          "UPDATE selfhost_queue_messages SET lease_token = ?, lease_expires_at_ms = ? " +
          "WHERE queue_id = ? AND message_id = ? " +
          "AND deliveries = ? AND enqueued_at_ms = ? AND visible_at_ms = ? " +
          "AND lease_token IS ? AND lease_expires_at_ms IS ? " +
          "AND visible_at_ms <= ? AND expires_at_ms > ? " +
          "AND (lease_expires_at_ms IS NULL OR lease_expires_at_ms <= ?)",
        params: [
          token,
          claimMillis + leaseMillis,
          consumer.queue,
          messageId,
          integer(row.deliveries),
          integer(row.enqueued_at_ms),
          integer(row.visible_at_ms),
          row.lease_token === null ? null : String(row.lease_token),
          row.lease_expires_at_ms === null ? null : integer(row.lease_expires_at_ms),
          claimMillis,
          claimMillis,
          claimMillis,
        ],
      });
      // Claim, copy and removal are one transaction. A lost claim makes both
      // following writes no-ops; a failed copy rolls the claim back as well.
      statements.push(...exhausted(consumer, messageId, token, claimMillis));
      settlements.push(statements.length - 1);
    }
    const written = await sql.batch(statements);
    return settlements.filter((index) => written[index]?.changes === 1).length;
  };

  /** An invocation may not outlast the slice of the tick its consumer has. */
  const boundedTimeout = (deadlineMillis: number): number =>
    Math.max(
      MIN_INVOCATION_TIMEOUT_MILLIS,
      Math.min(invocationTimeoutMillis, deadlineMillis - now().getTime()),
    );

  /** How long a Worker that did not answer is left alone for: doubling, bounded. */
  const beSilent = (key: string, millis: number): void => {
    const failures = (silence.get(key)?.failures ?? 0) + 1;
    const wait = Math.min(
      MAX_NO_ANSWER_BACKOFF_MILLIS,
      NO_ANSWER_BACKOFF_MILLIS * 2 ** Math.min(failures - 1, 16),
    );
    silence.set(key, { failures, untilMillis: millis + wait });
  };

  const drainConsumer = async (
    target: SelfhostEventTarget,
    consumer: SelfhostQueueConsumerAttachment,
  ): Promise<number> => {
    // Checked before the first SQL read, lease, attempt increment, or
    // settlement. The native id cannot be reversed into the logical name.
    if (!isDeliverableQueueConsumer(consumer)) return 0;
    const key = `${target.script} ${consumer.queue}`;
    const start = now().getTime();
    const waiting = silence.get(key);
    if (waiting && waiting.untilMillis > start) return 0;
    const budget = budgetFor(target, consumer);
    const deadline = start + consumerBudgetMillis;
    let settled = 0;
    for (let pass = 0; pass < MAX_BATCHES_PER_CONSUMER; pass += 1) {
      const millis = now().getTime();
      if (millis >= deadline) break;
      const recovered = await recoverExhausted(consumer);
      settled += recovered;
      const reserved: ReservedBatch[] = [];
      for (let slot = 0; slot < consumer.maxConcurrency; slot += 1) {
        const batch = await reserve(consumer, millis, budget);
        if (!batch) break;
        reserved.push(batch);
      }
      if (reserved.length === 0) {
        if (recovered > 0) continue;
        break;
      }
      const outcomes = await Promise.all(
        reserved.map(async (batch): Promise<DeliveryOutcome> => {
          let selected: SelfhostEventSelection | null = null;
          try {
            selected = await options.targets.select(target.script);
          } catch {
            // Selection is durable readback plus private entropy. A failure is
            // this Host failing to ask, so this batch spends no delivery.
          }
          if (!selected?.handlers.includes("queue")) {
            await release(consumer, batch.token, batch.messages, now().getTime());
            return { settled: 0, answered: false };
          }
          return await deliver(target, selected, consumer, batch, deadline);
        }),
      );
      let answered = false;
      for (const outcome of outcomes) {
        settled += outcome.settled;
        answered = answered || outcome.answered;
      }
      if (!answered) {
        beSilent(key, now().getTime());
        break;
      }
      silence.delete(key);
    }
    return settled;
  };

  const drainTarget = async (target: SelfhostEventTarget): Promise<number> => {
    let settled = 0;
    for (const consumer of target.consumers) {
      try {
        settled += await drainConsumer(target, consumer);
      } catch {
        // One consumer's failure is one consumer's, and left undescribed on
        // purpose: the rows are the record of what happened, the lease expires
        // by itself, and a queue's identity is not a thing this file logs.
      }
    }
    return settled;
  };

  return {
    async tick() {
      const listed = await options.targets.list();
      // From a rotating start, so a target near the end of the list is not the
      // one that never gets its turn when a pass runs out of room.
      const offset = listed.length === 0 ? 0 : rotation % listed.length;
      rotation = (rotation + 1) % Math.max(1, listed.length);
      const targets = [...listed.slice(offset), ...listed.slice(0, offset)];
      let settled = 0;
      let next = 0;
      const worker = async (): Promise<void> => {
        for (;;) {
          const target = targets[next];
          next += 1;
          if (!target) return;
          try {
            settled += await drainTarget(target);
          } catch {
            // Same discipline one level up: a target that throws is one
            // target, and every other tenant's queue still gets this pass.
          }
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENT_TARGETS, targets.length) }, worker),
      );
      return settled;
    },

    async sweep(limit = SWEEP_LIMIT) {
      // Paged rather than capped at one page: a machine accepting a hundred
      // messages a second must not fall behind a sweep that reclaims a thousand
      // rows every thirty. The total is still bounded, so a dead queue cannot
      // become the tick.
      const bounded = Math.max(1, Math.min(limit, SWEEP_LIMIT));
      let removed = 0;
      while (removed < bounded) {
        const page = Math.min(SWEEP_PAGE, bounded - removed);
        const rows = await sql.query(
          "SELECT queue_id, message_id FROM selfhost_queue_messages WHERE expires_at_ms <= ? LIMIT ?",
          [now().getTime(), page],
        );
        if (rows.length === 0) break;
        await sql.batch(
          rows.map((row) => ({
            sql: "DELETE FROM selfhost_queue_messages WHERE queue_id = ? AND message_id = ?",
            params: [String(row.queue_id), String(row.message_id)] as readonly SqlParam[],
          })),
        );
        removed += rows.length;
        if (rows.length < page) break;
      }
      return removed;
    },
  };
}

function integer(value: unknown): number {
  const parsed = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isSafeInteger(parsed) ? parsed : 0;
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

/**
 * What one message costs inside the envelope.
 *
 * Computed rather than measured, because measuring means encoding a body that
 * may be a sixth of a megabyte, for every candidate row of every pass. Base64
 * is ASCII, so its length is its byte count; only the id can carry anything
 * else, and that one is measured.
 */
function messageCost(message: ReservedMessage): number {
  return (
    QUEUE_MESSAGE_FIXED_BYTES +
    utf8Bytes(JSON.stringify(message.messageId)) +
    String(message.enqueuedAtMillis).length +
    String(message.attempts).length +
    message.body.length
  );
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
