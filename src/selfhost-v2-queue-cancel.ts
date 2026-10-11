import type { Sql } from "./ports.ts";
import { cancelV2QueueBatchBeforeSend } from "./takoform-v2/worker-queue-delivery.ts";

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PRE_SEND_STATES = new Set(["reserved", "registered"]);

/** Short enough to stay inside one delivery pass; long enough to outlast a reader. */
const DEFAULT_RETRY_DELAYS_MS = Object.freeze([25, 100, 250]);
/** Total time the refund may spend, including the attempts themselves. */
const DEFAULT_RETRY_BUDGET_MS = 1_000;

const LOCK_MESSAGE = /\b(?:database (?:table )?is locked|SQLITE_BUSY|SQLITE_LOCKED)\b/iu;

/**
 * bun:sqlite raises a busy/locked error only after the connection's
 * busy_timeout already blocked this thread. Another attempt would block the
 * whole Host again, so that error ends the refund instead of being retried.
 */
function isLockError(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  try {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string" && /^SQLITE_(?:BUSY|LOCKED)/u.test(code)) return true;
    return LOCK_MESSAGE.test(cause.message);
  } catch {
    return false;
  }
}

/**
 * Refund a Queue reservation that was provably never sent.
 *
 * Core's pre-send cancel is one SQL write. When that write loses to a
 * transient failure, the previous caller discarded the failure and the
 * messages stayed invisible until the reservation expired 120 seconds later.
 * A false result is not proof that nothing can be done: it is also what Core
 * answers for an execution that was already sent or retired, and that one must
 * never be retried.
 *
 * So after a thrown or false cancel this reads the row once. Only a row that
 * is still `reserved` or `registered`, or one that could not be read for a
 * reason other than a lock, earns another attempt. `send_authorized`, retired
 * and absent rows stop immediately and silently: they are Core's answer, not a
 * fault. A lock error stops at once, because it already cost a full
 * busy_timeout; retries also stop before an attempt that would cross the total
 * time budget. When the refund gives up the last cause is reported and the
 * reservation falls back to its expiry, as before.
 */
export async function cancelQueueReservationBeforeSend(input: {
  readonly sql: Sql;
  readonly batch: { readonly batchId: string; readonly reservationToken: string };
  readonly cancel?: typeof cancelV2QueueBatchBeforeSend;
  readonly delaysMs?: readonly number[];
  readonly budgetMs?: number;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Receives the last failure only when the refund gave up; bounded by the caller. */
  readonly report?: (cause: unknown) => void;
}): Promise<boolean> {
  const { sql, batch } = input;
  if (!IDENTIFIER.test(batch.batchId) || !IDENTIFIER.test(batch.reservationToken)) return false;
  const cancel = input.cancel ?? cancelV2QueueBatchBeforeSend;
  const delays = input.delaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  const budget = input.budgetMs ?? DEFAULT_RETRY_BUDGET_MS;
  const now = input.now ?? Date.now;
  const sleep = input.sleep ?? ((milliseconds) => new Promise((r) => setTimeout(r, milliseconds)));
  const giveUp = (cause: unknown): false => {
    try {
      input.report?.(cause);
    } catch {
      /* Reporting must not turn a refused refund into a pass failure. */
    }
    return false;
  };

  const started = now();
  let lastCause: unknown = new Error("Queue reservation is still pre-send after cancel attempts");
  for (let attempt = 0; ; attempt += 1) {
    const attemptStarted = now();
    try {
      if (await cancel(sql, batch)) return true;
    } catch (cause) {
      if (isLockError(cause)) return giveUp(cause);
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
      if (isLockError(cause)) return giveUp(cause);
      // An unreadable row is not proof that it was sent.
      lastCause = cause;
      retryable = true;
    }
    if (!retryable) return false;
    const delay = delays[attempt];
    const attemptCost = now() - attemptStarted;
    if (delay === undefined || now() - started + delay + attemptCost > budget) {
      return giveUp(lastCause);
    }
    await sleep(delay);
  }
}

const DB_NOW_MS =
  "(CAST(strftime('%s', 'now') AS INTEGER) * 1000 + CAST(substr(strftime('%f', 'now'), 4, 3) AS INTEGER))";

/**
 * Every never-authorized reservation written up to a database time.
 *
 * The execution table only grows (rows are never deleted), so this must not
 * walk it. It is a loose index scan over
 * `queue_v2_batch_executions_open_consumer (consumer_uid, state)`: one seek
 * per Consumer UID that ever had an execution, then an exact search for its
 * `reserved` and `registered` rows, of which the reserve guard allows at most
 * 250 per Consumer. `CROSS JOIN` fixes that order, which statistics would
 * otherwise turn into a scan of every execution; `+reserved_at_ms` keeps the
 * time bound out of the index choice; `INDEXED BY` turns a missing index into
 * an error rather than a silent full scan. A test pins the plan with and
 * without planner statistics, like the backlog sampler's.
 */
export const SELFHOST_QUEUE_BOOT_REFUSAL_QUERY = `WITH RECURSIVE consumer(uid) AS (
    SELECT MIN(consumer_uid)
      FROM queue_v2_batch_executions INDEXED BY queue_v2_batch_executions_open_consumer
    UNION ALL
    SELECT (SELECT MIN(next.consumer_uid)
              FROM queue_v2_batch_executions AS next
                INDEXED BY queue_v2_batch_executions_open_consumer
              WHERE next.consumer_uid > consumer.uid)
      FROM consumer WHERE consumer.uid IS NOT NULL
  )
  SELECT execution.batch_id, execution.reservation_token
  FROM consumer
  CROSS JOIN queue_v2_batch_executions AS execution
    INDEXED BY queue_v2_batch_executions_open_consumer
  WHERE execution.consumer_uid = consumer.uid
    AND execution.state IN ('reserved','registered')
    AND +execution.reserved_at_ms <= ?`;

/**
 * Refuse, at Host start, every v2 Queue reservation that was never authorized.
 *
 * Call this before the process's first delivery pass. A `reserved` or
 * `registered` row then belongs to an earlier process (normally one that was
 * killed between claiming a batch and sending it), and without this its
 * messages stay leased until the row's 120 second reservation runs out.
 *
 * No proof that the writer is gone is needed. Each row is refused by the
 * pre-send cancel, which moves it to `pre_effect_refused` only while it is
 * still `reserved` or `registered`, and refunds its messages in the same
 * transaction. Send authorization is the competing move out of `registered`,
 * and the runtime owner sends only when it wins. So a writer that is in fact
 * alive (a second Host on the same database) loses that batch before effect;
 * nothing is sent twice. Rows reserved after this call started are left to
 * their own claimer.
 *
 * Returns how many rows this call refused. The first refusal that gives up
 * (a lock that outlasted the busy timeout, or retries out of budget) ends the
 * pass: it already cost that wait, the Host is not listening yet, and every
 * row left falls back to its expiry, exactly as before.
 */
export async function refuseQueueReservationsBeforeFirstDelivery(input: {
  readonly sql: Sql;
  readonly cancel?: typeof cancelV2QueueBatchBeforeSend;
  readonly report?: (cause: unknown) => void;
}): Promise<number> {
  const { sql } = input;
  const [clock] = await sql.query(`SELECT ${DB_NOW_MS} AS now`);
  const startedAt = clock?.now;
  if (typeof startedAt !== "number" || !Number.isSafeInteger(startedAt) || startedAt <= 0)
    throw new Error("Queue boot refusal could not read the database clock");
  const rows = await sql.query(SELFHOST_QUEUE_BOOT_REFUSAL_QUERY, [startedAt]);
  let gaveUp = false;
  const report = (cause: unknown): void => {
    gaveUp = true;
    input.report?.(cause);
  };
  let refused = 0;
  for (const row of rows) {
    if (typeof row.batch_id !== "string" || typeof row.reservation_token !== "string") continue;
    if (
      await cancelQueueReservationBeforeSend({
        sql,
        batch: { batchId: row.batch_id, reservationToken: row.reservation_token },
        ...(input.cancel ? { cancel: input.cancel } : {}),
        report,
      })
    )
      refused += 1;
    else if (gaveUp) break;
  }
  return refused;
}
