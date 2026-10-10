import type { Sql } from "./ports.ts";
import { cancelV2QueueBatchBeforeSend } from "./takoform-v2/worker-queue-delivery.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PRE_SEND_STATES = new Set(["reserved", "registered"]);

/** Short enough to stay inside one delivery pass; long enough to outlast a reader. */
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([25, 100, 250]);

/**
 * Refund a Queue reservation that was provably never sent.
 *
 * Core's pre-send cancel is one SQL write. When that write loses to a
 * transient lock (an operator's `sqlite3`, a backup tool), the previous
 * caller discarded the failure and the messages stayed invisible until the
 * reservation expired 120 seconds later. A false result is not proof that
 * nothing can be done: it is also what Core answers for an execution that was
 * already sent or retired, and that one must never be retried.
 *
 * So after a thrown or false cancel this reads the row once. Only a row that
 * is still `reserved` or `registered`, or one that cannot be read at all,
 * earns another bounded attempt. `send_authorized`, retired and absent rows
 * stop immediately and silently: they are Core's answer, not a fault. When every
 * attempt fails the last cause is reported and the reservation falls back to
 * its expiry, as before.
 */
export async function cancelQueueReservationBeforeSend(input: {
  readonly sql: Sql;
  readonly batch: { readonly batchId: string; readonly reservationToken: string };
  readonly cancel?: typeof cancelV2QueueBatchBeforeSend;
  readonly delaysMs?: readonly number[];
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Receives the last failure only when attempts ran out; never secret-bearing. */
  readonly report?: (cause: unknown) => void;
}): Promise<boolean> {
  const { sql, batch } = input;
  if (!IDENTIFIER.test(batch.batchId) || !IDENTIFIER.test(batch.reservationToken)) return false;
  const cancel = input.cancel ?? cancelV2QueueBatchBeforeSend;
  const delays = input.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const sleep = input.sleep ?? ((milliseconds) => new Promise((r) => setTimeout(r, milliseconds)));

  let lastCause: unknown = new Error("Queue reservation is still pre-send after cancel attempts");
  for (let attempt = 0; ; attempt += 1) {
    try {
      if (await cancel(sql, batch)) return true;
    } catch (cause) {
      lastCause = cause;
    }
    let retryable: boolean;
    try {
      const rows = await sql.query(
        `SELECT state FROM queue_v2_batch_executions
         WHERE batch_id = ? AND reservation_token = ? LIMIT 2`,
        [batch.batchId, batch.reservationToken],
      );
      retryable =
        rows.length === 1 &&
        typeof rows[0]?.state === "string" &&
        PRE_SEND_STATES.has(rows[0].state);
    } catch (cause) {
      // An unreadable row is not proof that it was sent.
      lastCause = cause;
      retryable = true;
    }
    if (!retryable) return false;
    const delay = delays[attempt];
    if (delay === undefined) {
      try {
        input.report?.(lastCause);
      } catch {
        /* Reporting must not turn a refused refund into a pass failure. */
      }
      return false;
    }
    await sleep(delay);
  }
}
