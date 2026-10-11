import type { Sql } from "./ports.ts";

/**
 * Signals the readiness probe reports without failing on them.
 *
 * A Host whose Operations sit in `reconciling` for an hour, whose Queue
 * batches were sent and never retired, or whose background passes fail on
 * every tick answered `/ready` with 200 and nothing else: the probe looked
 * only at the database and the Worker children. The backlog reads and the
 * pass recorder below make that visible as counts and fixed pass names, never
 * as identifiers or causes, and never as a reason to fail readiness on their
 * own.
 *
 * Both reads are driven by indexes that already exist, so their cost follows
 * the size of the backlog and the number of Queue Consumers, not the size of
 * the Operation or execution history (neither table is ever pruned):
 *
 * - `tf_v2_operations_work (status, lease_until_ms, created_at)` answers the
 *   Operation counts as a covering index search on the unsettled statuses.
 * - `queue_v2_batch_executions_open_consumer (consumer_uid, state)` answers
 *   the execution count by a loose index scan: one seek per Consumer UID that
 *   ever had an execution, then an exact `(consumer_uid, 'send_authorized')`
 *   search. A Consumer has at most 250 open executions.
 *
 * `INDEXED BY` makes a missing index an error the probe reports as
 * unobserved, rather than a silent full scan on every poll.
 */

/** Ten minutes: far past any ordinary Operation or Queue batch. */
export const SELFHOST_BACKLOG_STALLED_AFTER_MS = 10 * 60_000;

export interface SelfhostBacklogHealth {
  /** The age, in whole seconds, past which the counts below include an item. */
  readonly olderThanSeconds: number;
  /** v2 Operations accepted longer ago than that and still unsettled, by status. */
  readonly operations: {
    readonly queued: number;
    readonly running: number;
    readonly reconciling: number;
    /** Waiting for its client to resupply private inputs; not a Host fault. */
    readonly waitingInput: number;
  };
  /** v2 Queue batch executions sent longer ago than that and still not retired. */
  readonly queueExecutions: {
    readonly sendAuthorized: number;
  };
}

const OPERATION_COUNTS = `SELECT status, COUNT(*) AS n
  FROM tf_v2_operations INDEXED BY tf_v2_operations_work
  WHERE status IN ('queued', 'running', 'waiting_input', 'reconciling') AND created_at < ?
  GROUP BY status`;

const SENT_EXECUTION_COUNT = `WITH RECURSIVE consumer(uid) AS (
    SELECT MIN(consumer_uid)
      FROM queue_v2_batch_executions INDEXED BY queue_v2_batch_executions_open_consumer
    UNION ALL
    SELECT (SELECT MIN(next.consumer_uid)
              FROM queue_v2_batch_executions AS next
                INDEXED BY queue_v2_batch_executions_open_consumer
              WHERE next.consumer_uid > consumer.uid)
      FROM consumer WHERE consumer.uid IS NOT NULL
  )
  SELECT COUNT(*) AS n
  FROM consumer
  JOIN queue_v2_batch_executions AS execution
    INDEXED BY queue_v2_batch_executions_open_consumer
    ON execution.consumer_uid = consumer.uid AND execution.state = 'send_authorized'
  WHERE execution.send_authorized_at_ms < ?`;

/** Exposed so a test can pin the query plans of exactly what the probe runs. */
export const SELFHOST_BACKLOG_QUERIES = Object.freeze({
  operations: OPERATION_COUNTS,
  queueExecutions: SENT_EXECUTION_COUNT,
});

function count(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("backlog count is not a non-negative integer");
  }
  return number;
}

/**
 * Read-only backlog counts. Each call issues exactly the two statements above;
 * a thrown read is the caller's to report as unobserved.
 */
export function createSelfhostBacklogObserver(input: {
  readonly sql: Pick<Sql, "query">;
  readonly now: () => Date;
  readonly stalledAfterMs?: number;
}): { observe(): Promise<SelfhostBacklogHealth> } {
  const stalledAfterMs = input.stalledAfterMs ?? SELFHOST_BACKLOG_STALLED_AFTER_MS;
  if (!Number.isSafeInteger(stalledAfterMs) || stalledAfterMs < 1_000) {
    throw new TypeError("self-host backlog threshold must be at least one second");
  }
  const olderThanSeconds = Math.floor(stalledAfterMs / 1_000);
  return {
    async observe() {
      const nowMs = input.now().getTime();
      if (!Number.isFinite(nowMs)) throw new TypeError("self-host clock is invalid");
      const cutoffMs = nowMs - stalledAfterMs;
      const operations = { queued: 0, running: 0, reconciling: 0, waitingInput: 0 };
      for (const row of await input.sql.query(OPERATION_COUNTS, [
        new Date(cutoffMs).toISOString(),
      ])) {
        const n = count(row.n);
        if (row.status === "queued") operations.queued = n;
        else if (row.status === "running") operations.running = n;
        else if (row.status === "reconciling") operations.reconciling = n;
        else if (row.status === "waiting_input") operations.waitingInput = n;
        else throw new TypeError("backlog status is not an unsettled Operation status");
      }
      const sent = await input.sql.query(SENT_EXECUTION_COUNT, [cutoffMs]);
      if (sent.length !== 1) throw new TypeError("backlog execution count is not one row");
      return {
        olderThanSeconds,
        operations,
        queueExecutions: { sendAuthorized: count(sent[0]?.n) },
      };
    },
  };
}

/** Pass names come from source; anything else is reported without its text. */
const PASS_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_TRACKED_PASSES = 64;

export interface SelfhostBackgroundPassHealth {
  /** Named passes whose most recent completed run failed. */
  readonly failing: number;
  /** Named passes whose current run started longer ago than the threshold. */
  readonly stalled: number;
  /** The most recent failure of any pass: its fixed name and age only. */
  readonly lastFailure?: { readonly name: string; readonly ageSeconds: number };
}

export interface SelfhostBackgroundPassRecorder {
  /** Wrap one pass body so its start and outcome are recorded; outcome is unchanged. */
  observe(name: string, run: () => void | Promise<void>): () => Promise<void>;
  snapshot(): SelfhostBackgroundPassHealth;
}

/**
 * The entry's background passes already log a failure as one bounded line.
 * This keeps the same fact for the probe: which fixed pass name, and how long
 * ago, never its cause. A pass that later succeeds stops counting as failing.
 */
export function createSelfhostBackgroundPassRecorder(
  options: {
    /** Monotonic milliseconds; a wall-clock step must not age or rejuvenate a failure. */
    readonly now?: () => number;
    readonly stalledAfterMs?: number;
  } = {},
): SelfhostBackgroundPassRecorder {
  const now = options.now ?? (() => performance.now());
  const stalledAfterMs = options.stalledAfterMs ?? SELFHOST_BACKLOG_STALLED_AFTER_MS;
  const passes = new Map<string, { failed: boolean; startedAt: number | null }>();
  let lastFailure: { name: string; at: number } | undefined;

  const entry = (name: string) => {
    let key = PASS_NAME.test(name) ? name : "unnamed";
    // Names are source constants; the bound only keeps a bug from growing this.
    if (!passes.has(key) && passes.size >= MAX_TRACKED_PASSES) key = "unnamed";
    let state = passes.get(key);
    if (!state) {
      state = { failed: false, startedAt: null };
      passes.set(key, state);
    }
    return { key, state };
  };

  return {
    observe(name, run) {
      return async () => {
        const { key, state } = entry(name);
        const startedAt = now();
        state.startedAt = startedAt;
        try {
          await run();
          state.failed = false;
        } catch (error) {
          state.failed = true;
          lastFailure = { name: key, at: now() };
          throw error;
        } finally {
          if (state.startedAt === startedAt) state.startedAt = null;
        }
      };
    },
    snapshot() {
      const at = now();
      let failing = 0;
      let stalled = 0;
      for (const state of passes.values()) {
        if (state.failed) failing += 1;
        if (state.startedAt !== null && at - state.startedAt > stalledAfterMs) stalled += 1;
      }
      return {
        failing,
        stalled,
        ...(lastFailure
          ? {
              lastFailure: {
                name: lastFailure.name,
                ageSeconds: Math.max(0, Math.floor((at - lastFailure.at) / 1_000)),
              },
            }
          : {}),
      };
    },
  };
}
