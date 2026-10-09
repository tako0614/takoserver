import type { Sql } from "./ports.ts";
import type { QueueCustody } from "./queue-custody.ts";
import type { V2QueueSchedulerOptions } from "./takoform-v2/worker-queue-scheduler.ts";
import { createV2QueueScheduler } from "./takoform-v2/worker-queue-scheduler.ts";

const DEFAULT_POLL_MILLIS = 1_000;
type Delivery = V2QueueSchedulerOptions["delivery"];

export interface SelfhostV2QueueSchedulerOptions {
  readonly sql: Sql;
  readonly custody: QueueCustody;
  readonly composition: Delivery;
  /** Required with the real Queue composition: native owners restore before claims. */
  readonly workerComposition?: { restoreOwners(): Promise<readonly string[]> };
  readonly pollMillis?: number;
}

/**
 * Self-host timer adapter for the Worker-safe scheduler state machine. All send
 * authority remains in deliverOnce's SQL claim, serving proof and one-shot
 * native transport; this adapter only provides the existing process cadence.
 */
export function createSelfhostV2QueueScheduler(options: SelfhostV2QueueSchedulerOptions) {
  if (!options.sql || !options.custody || typeof options.composition?.deliverOnce !== "function")
    throw new TypeError("v2 Queue scheduler needs SQL, custody and native delivery");
  const recovering = typeof options.composition.reconcileWorkerAuthorizedAbsence === "function";
  if (recovering !== (typeof options.workerComposition?.restoreOwners === "function"))
    throw new TypeError("v2 Queue delivery requires exact native-owner restore and recovery");
  const pollMillis = options.pollMillis ?? DEFAULT_POLL_MILLIS;
  if (!Number.isSafeInteger(pollMillis) || pollMillis < 1 || pollMillis > 60_000)
    throw new TypeError("v2 Queue polling interval is invalid");

  const scheduler = createV2QueueScheduler({
    sql: options.sql,
    custody: options.custody,
    delivery: options.composition,
    ...(options.workerComposition ? { workerComposition: options.workerComposition } : {}),
  });
  let timer: ReturnType<typeof setInterval> | undefined;
  let closed = false;

  return Object.freeze({
    tick: scheduler.tick,
    start() {
      if (closed) throw new Error("v2 Queue scheduler is closed");
      if (timer) return;
      timer = setInterval(() => {
        void scheduler.tick().catch(() => undefined);
      }, pollMillis);
      void scheduler.tick().catch(() => undefined);
    },
    close() {
      if (closed) return scheduler.close();
      closed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      return scheduler.close();
    },
  });
}
