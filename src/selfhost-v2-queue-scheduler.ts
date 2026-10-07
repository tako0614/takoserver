import type { Sql } from "./ports.ts";
import type { QueueCustody } from "./queue-custody.ts";
import type { createSelfhostV2QueueComposition } from "./selfhost-v2-queue-composition.ts";
import { AT_LEAST_ONCE_QUEUE_FORM_URL } from "./takoform-v2/forms/at-least-once-queue.ts";
import {
  parseQueueConsumerSpec,
  QUEUE_CONSUMER_FORM_URL,
} from "./takoform-v2/forms/queue-consumer.ts";
import { v2QueueId } from "./takoform-v2/worker-queue-delivery.ts";

/** One native event has a five-minute deadline; cap one shutdown drain pass. */
const PAGE = 16;
/** At most one extra native wake after the ordinary Consumer page. */
const NOTICE_PAGE = 1;
const DEFAULT_POLL_MILLIS = 1_000;
const DB_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";

type Delivery = Pick<ReturnType<typeof createSelfhostV2QueueComposition>, "deliverOnce">;

export interface SelfhostV2QueueSchedulerOptions {
  readonly sql: Sql;
  readonly custody: QueueCustody;
  readonly composition: Delivery;
  readonly pollMillis?: number;
}

/**
 * Host-private candidate scanner. All send authority remains in deliverOnce's
 * SQL claim, serving proof and one-shot native transport; this is only a wake.
 */
export function createSelfhostV2QueueScheduler(options: SelfhostV2QueueSchedulerOptions) {
  if (!options.sql || !options.custody || typeof options.composition?.deliverOnce !== "function")
    throw new TypeError("v2 Queue scheduler needs SQL, custody and native delivery");
  const pollMillis = options.pollMillis ?? DEFAULT_POLL_MILLIS;
  if (!Number.isSafeInteger(pollMillis) || pollMillis < 1 || pollMillis > 60_000)
    throw new TypeError("v2 Queue polling interval is invalid");

  let cursor = "";
  let noticeCursor: readonly [string, string, number, string] | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<number> | undefined;
  let closePromise: Promise<void> | undefined;
  let closed = false;

  const pass = async (): Promise<number> => {
    const outcomes = new Map<string, Awaited<ReturnType<Delivery["deliverOnce"]>>["kind"]>();
    const rows = await options.sql.query(
      `SELECT resource.uid, resource.principal, resource.space, resource.target_key
       FROM tf_v2_resources resource
       JOIN tf_v2_operations op ON op.id = resource.last_operation
       JOIN queue_consumer_custody custody
         ON custody.consumer_id = resource.uid
        AND custody.queue_id = 'takoform-v2-queue:' ||
          json_extract(resource.spec_json, '$.queue.resourceUid')
       WHERE resource.uid > ? AND resource.form_url = ?
         AND resource.deleted_at IS NULL AND resource.phase = 'idle'
         AND resource.busy_operation IS NULL
         AND resource.generation = resource.observed_generation
         AND json_extract(resource.observed_json, '$.consumerAttached') = 1
         AND op.resource_uid = resource.uid AND op.principal = resource.principal
         AND op.target_key = resource.target_key
         AND op.backend_id = resource.backend_id
         AND op.status = 'succeeded' AND op.effect = 'complete'
         AND op.action IN ('create','update') AND op.generation = resource.generation
         AND op.accepted_spec_json = resource.spec_json
         AND custody.state = 'active'
       ORDER BY resource.uid LIMIT ?`,
      [cursor, QUEUE_CONSUMER_FORM_URL, PAGE],
    );
    if (closed) return 0;
    const visits = await Promise.all(
      rows.map(async (row) => {
        if (
          closed ||
          typeof row.uid !== "string" ||
          typeof row.principal !== "string" ||
          typeof row.space !== "string" ||
          typeof row.target_key !== "string"
        )
          return 0;
        // A candidate read is not a send grant. This call repeats the exact
        // accepted graph and native owner checks before any event can be sent.
        const outcome = await options.composition
          .deliverOnce({
            consumerUid: row.uid,
            principal: row.principal,
            space: row.space,
            targetKey: row.target_key,
          })
          .catch(() => ({ kind: "unknown" as const }));
        outcomes.set(row.uid, outcome.kind);
        return 1;
      }),
    );
    const last = rows.at(-1);
    cursor = rows.length === PAGE && typeof last?.uid === "string" ? last.uid : "";
    await wakeTransfers(outcomes);
    return visits.reduce<number>((sum, value) => sum + value, 0);
  };

  /** A notice is not itself delivery authority or proof of a target wake. */
  const wakeTransfers = async (
    outcomes: Map<string, Awaited<ReturnType<Delivery["deliverOnce"]>>["kind"]>,
  ): Promise<void> => {
    if (closed || !timer) return;
    const after = noticeCursor ?? ["", "", 0, ""];
    const notices = await options.sql.query(
      `SELECT source_queue_id,source_consumer_id,source_generation,
              target_queue_id,notice_token
       FROM queue_custody_transfer_notices
       WHERE (source_queue_id,source_consumer_id,source_generation,target_queue_id)
             > (?,?,?,?)
       ORDER BY source_queue_id,source_consumer_id,source_generation,target_queue_id
       LIMIT ?`,
      [...after, NOTICE_PAGE],
    );
    for (const notice of notices) {
      if (closed) break;
      const sourceQueueId = notice.source_queue_id;
      const sourceConsumerId = notice.source_consumer_id;
      const sourceGeneration = notice.source_generation;
      const targetQueueId = notice.target_queue_id;
      const noticeToken = notice.notice_token;
      if (
        typeof sourceQueueId !== "string" ||
        typeof sourceConsumerId !== "string" ||
        !Number.isSafeInteger(sourceGeneration) ||
        typeof targetQueueId !== "string" ||
        typeof noticeToken !== "string"
      )
        continue;
      // Source may be retiring or soft-deleted. Its persisted v2 identity and
      // immutable Queue reference still distinguish this from legacy custody.
      const sourceRows = await options.sql.query(
        `SELECT principal,space,target_key FROM tf_v2_resources
         WHERE uid = ? AND form_url = ?
           AND ? = 'takoform-v2-queue:' ||
             json_extract(spec_json, '$.queue.resourceUid') LIMIT 2`,
        [sourceConsumerId, QUEUE_CONSUMER_FORM_URL, sourceQueueId],
      );
      const source = sourceRows.length === 1 ? sourceRows[0] : null;
      if (
        !source ||
        typeof source.principal !== "string" ||
        typeof source.space !== "string" ||
        typeof source.target_key !== "string"
      )
        continue;
      const sourcePrincipal = source.principal;
      const sourceSpace = source.space;
      const sourceTargetKey = source.target_key;
      const readTarget = () =>
        options.sql.query(
          `SELECT consumer.uid,consumer.spec_json,custody.generation
         FROM tf_v2_resources queue
         JOIN tf_v2_operations queue_op ON queue_op.id = queue.last_operation
         JOIN tf_v2_resources consumer
           ON json_extract(consumer.spec_json, '$.queue.resourceUid') = queue.uid
         JOIN tf_v2_operations consumer_op ON consumer_op.id = consumer.last_operation
         JOIN queue_consumer_custody custody
           ON custody.queue_id = ? AND custody.consumer_id = consumer.uid
         WHERE ? = 'takoform-v2-queue:' || queue.uid
           AND queue.form_url = ? AND queue.principal = ? AND queue.space = ?
           AND queue.target_key = ? AND queue.deleted_at IS NULL
           AND queue.phase = 'idle' AND queue.busy_operation IS NULL
           AND queue.generation = queue.observed_generation
           AND json_extract(queue.observed_json, '$.queueExists') = 1
           AND queue_op.resource_uid = queue.uid
           AND queue_op.principal = queue.principal
           AND queue_op.target_key = queue.target_key
           AND queue_op.backend_id = queue.backend_id
           AND queue_op.status = 'succeeded' AND queue_op.effect = 'complete'
           AND queue_op.action IN ('create','update')
           AND queue_op.generation = queue.generation
           AND queue_op.accepted_spec_json = queue.spec_json
           AND consumer.form_url = ? AND consumer.principal = queue.principal
           AND consumer.space = queue.space AND consumer.target_key = queue.target_key
           AND consumer.deleted_at IS NULL AND consumer.phase = 'idle'
           AND consumer.busy_operation IS NULL
           AND consumer.generation = consumer.observed_generation
           AND json_extract(consumer.observed_json, '$.consumerAttached') = 1
           AND consumer_op.resource_uid = consumer.uid
           AND consumer_op.principal = consumer.principal
           AND consumer_op.target_key = consumer.target_key
           AND consumer_op.backend_id = consumer.backend_id
           AND consumer_op.status = 'succeeded' AND consumer_op.effect = 'complete'
           AND consumer_op.action IN ('create','update')
           AND consumer_op.generation = consumer.generation
           AND consumer_op.accepted_spec_json = consumer.spec_json
           AND custody.state = 'active' LIMIT 2`,
          [
            targetQueueId,
            targetQueueId,
            AT_LEAST_ONCE_QUEUE_FORM_URL,
            sourcePrincipal,
            sourceSpace,
            sourceTargetKey,
            QUEUE_CONSUMER_FORM_URL,
          ],
        );
      const targets = await readTarget();
      const target = targets.length === 1 ? targets[0] : null;
      if (!target || typeof target.uid !== "string" || !Number.isSafeInteger(target.generation))
        continue;
      let spec: ReturnType<typeof parseQueueConsumerSpec>;
      try {
        spec = parseQueueConsumerSpec(JSON.parse(String(target.spec_json)));
        if (v2QueueId(spec.queue.resourceUid) !== targetQueueId) continue;
      } catch {
        continue;
      }
      // The exact copied message must still be present. After a previous
      // successful wake it may have been ACKed; that case is reconciled below
      // only through its own durable settlement receipt.
      const message = await options.sql.query(
        `SELECT 1 FROM selfhost_queue_messages
         WHERE queue_id = ? AND message_id = ? AND lease_token IS NULL
           AND expires_at_ms > ${DB_NOW_MS}
         LIMIT 1`,
        [targetQueueId, noticeToken],
      );
      if (message.length !== 1) continue;
      const readiness = await options.custody
        .readiness({
          queueId: targetQueueId,
          consumerId: target.uid,
          generation: target.generation as number,
          maxBatchSize: spec.maxBatchSize,
          maxBatchTimeoutSeconds: spec.maxBatchTimeoutSeconds,
        })
        .catch(() => ({ state: "inactive" as const }));
      if (readiness.state === "inactive") continue;
      const capacity = await options.sql.query(
        `SELECT count(*) AS occupied FROM queue_v2_batch_executions
         WHERE consumer_uid = ? AND state IN ('reserved','registered','send_authorized')`,
        [target.uid],
      );
      if (
        capacity.length !== 1 ||
        typeof capacity[0]?.occupied !== "number" ||
        capacity[0].occupied >= spec.maxConcurrency
      )
        continue;
      let outcome = outcomes.get(target.uid);
      if (!outcome) {
        outcome = (
          await options.composition
            .deliverOnce({
              consumerUid: target.uid,
              principal: sourcePrincipal,
              space: sourceSpace,
              targetKey: sourceTargetKey,
            })
            .catch(() => ({ kind: "unknown" as const }))
        ).kind;
        outcomes.set(target.uid, outcome);
      }
      if (outcome === "unknown" || closed) continue;
      // This process has actually visited an enabled target while its periodic
      // scanner remains armed. Recheck exact target message or its durable ACK
      // receipt: a stale/cross-tenant copy cannot release a source notice.
      const currentTargets = await readTarget();
      const current = currentTargets.length === 1 ? currentTargets[0] : null;
      if (
        !current ||
        current.uid !== target.uid ||
        current.generation !== target.generation ||
        current.spec_json !== target.spec_json
      )
        continue;
      const currentCapacity = await options.sql.query(
        `SELECT count(*) AS occupied FROM queue_v2_batch_executions
         WHERE consumer_uid = ? AND state IN ('reserved','registered','send_authorized')`,
        [target.uid],
      );
      if (
        currentCapacity.length !== 1 ||
        typeof currentCapacity[0]?.occupied !== "number" ||
        currentCapacity[0].occupied >= spec.maxConcurrency
      )
        continue;
      const stillPresent = await options.sql.query(
        `SELECT 1 FROM selfhost_queue_messages
         WHERE queue_id = ? AND message_id = ? AND lease_token IS NULL
           AND expires_at_ms > ${DB_NOW_MS}
         LIMIT 1`,
        [targetQueueId, noticeToken],
      );
      const settled =
        stillPresent.length === 1
          ? []
          : await options.sql.query(
              `SELECT 1 FROM queue_v2_batch_settlements
               WHERE queue_id = ? AND message_id = ? AND state = 'settled'
               LIMIT 1`,
              [targetQueueId, noticeToken],
            );
      if (stillPresent.length !== 1 && settled.length !== 1) continue;
      await options.custody
        .acknowledgeTransferNotice({
          queueId: sourceQueueId,
          consumerId: sourceConsumerId,
          generation: sourceGeneration as number,
          targetQueueId,
          noticeToken,
        })
        .catch(() => false);
    }
    const last = notices.at(-1);
    noticeCursor =
      notices.length === NOTICE_PAGE &&
      typeof last?.source_queue_id === "string" &&
      typeof last.source_consumer_id === "string" &&
      Number.isSafeInteger(last.source_generation) &&
      typeof last.target_queue_id === "string"
        ? [
            last.source_queue_id,
            last.source_consumer_id,
            last.source_generation as number,
            last.target_queue_id,
          ]
        : undefined;
  };

  const tick = (): Promise<number> => {
    if (closed) return Promise.resolve(0);
    if (inFlight) return inFlight;
    const promise = Promise.resolve()
      .then(pass)
      .finally(() => {
        if (inFlight === promise) inFlight = undefined;
      });
    inFlight = promise;
    return promise;
  };

  return Object.freeze({
    tick,
    start() {
      if (closed) throw new Error("v2 Queue scheduler is closed");
      if (timer) return;
      timer = setInterval(() => {
        void tick().catch(() => undefined);
      }, pollMillis);
      void tick().catch(() => undefined);
    },
    close() {
      if (closePromise) return closePromise;
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      closePromise =
        inFlight?.then(
          () => undefined,
          () => undefined,
        ) ?? Promise.resolve();
      return closePromise;
    },
  });
}
