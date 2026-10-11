import type { Sql } from "./ports.ts";
import type { SelfhostEntryShutdown } from "./selfhost-entry-shutdown.ts";

/**
 * Signals the readiness probe reports without failing on them.
 *
 * A Host whose Operations sit in `reconciling` for an hour, whose Queue
 * batches were sent and never retired, or whose background passes fail on
 * every tick answered `/ready` with 200 and nothing else: the probe looked
 * only at the database and the Worker children. The backlog sampler and the
 * pass recorder below make that visible as counts, never as identifiers, pass
 * names or causes, and never as a reason to fail readiness on their own.
 *
 * The probe never runs these queries. It is unauthenticated, and bun:sqlite
 * blocks the event loop for the length of a statement, so a per-request read
 * would let any caller spend the Host's time. A background pass samples every
 * `SELFHOST_BACKLOG_SAMPLE_INTERVAL_MS` and the probe returns the latest
 * sample from memory.
 *
 * Each sample is bounded by indexes that already exist, whatever statistics
 * `ANALYZE` or `PRAGMA optimize` later record (a test pins both plans with and
 * without statistics):
 *
 * - `tf_v2_operations_work (status, lease_until_ms, created_at)` is searched
 *   by `status` only. `+created_at` keeps the age filter out of the index, so
 *   the planner cannot trade the status search for a skip-scan over the whole
 *   history. The cost is the number of unsettled Operations of any age, which
 *   is in-flight work, not the history: settled Operations are never read.
 * - `queue_v2_batch_executions_open_consumer (consumer_uid, state)` answers
 *   the execution count by a loose index scan: one seek per Consumer UID that
 *   ever had an execution, then an exact `(consumer_uid, 'send_authorized')`
 *   search. `CROSS JOIN` fixes that order; with statistics the planner would
 *   otherwise scan every execution ever recorded and join the Consumers to
 *   it. A Consumer has at most 250 open executions.
 *
 * `INDEXED BY` makes a missing index an error the sampler reports, rather
 * than a silent full scan.
 */

/** Ten minutes: far past any ordinary Operation or Queue batch. */
export const SELFHOST_BACKLOG_STALLED_AFTER_MS = 10 * 60_000;
/** How often the entry's background pass refreshes the backlog sample. */
export const SELFHOST_BACKLOG_SAMPLE_INTERVAL_MS = 20_000;
/** A sample older than three intervals means the sampler is not running. */
export const SELFHOST_BACKLOG_STALE_AFTER_MS = 3 * SELFHOST_BACKLOG_SAMPLE_INTERVAL_MS;

export interface SelfhostBacklogCounts {
  /** v2 Operations unsettled past the threshold, by status. */
  readonly operations: {
    readonly queued: number;
    readonly running: number;
    readonly reconciling: number;
    /** Waiting for its client to resupply private inputs; not a Host fault. */
    readonly waitingInput: number;
  };
  /** v2 Queue batch executions sent past the threshold and still not retired. */
  readonly queueExecutions: {
    readonly sendAuthorized: number;
  };
}

export interface SelfhostBacklogHealth extends SelfhostBacklogCounts {
  /**
   * An item counts once it has been pending this long *while this Host
   * process was running*: accepted (or sent) that long ago, and the process
   * up for at least that long. Work that waited out a stopped Host is not
   * stalled the moment the Host returns.
   */
  readonly olderThanSeconds: number;
  /** Whole seconds since the background pass took this sample. */
  readonly sampledSecondsAgo: number;
}

const OPERATION_COUNTS = `SELECT status, COUNT(*) AS n
  FROM tf_v2_operations INDEXED BY tf_v2_operations_work
  WHERE status IN ('queued', 'running', 'waiting_input', 'reconciling') AND +created_at < ?
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
  CROSS JOIN queue_v2_batch_executions AS execution
    INDEXED BY queue_v2_batch_executions_open_consumer
  WHERE execution.consumer_uid = consumer.uid AND execution.state = 'send_authorized'
    AND +execution.send_authorized_at_ms < ?`;

/** Exposed so a test can pin the query plans of exactly what the sampler runs. */
export const SELFHOST_BACKLOG_QUERIES = Object.freeze({
  operations: OPERATION_COUNTS,
  queueExecutions: SENT_EXECUTION_COUNT,
});

const ZERO_COUNTS: SelfhostBacklogCounts = Object.freeze({
  operations: Object.freeze({ queued: 0, running: 0, reconciling: 0, waitingInput: 0 }),
  queueExecutions: Object.freeze({ sendAuthorized: 0 }),
});

function count(value: unknown): number {
  const number = typeof value === "bigint" ? Number(value) : value;
  if (typeof number !== "number" || !Number.isSafeInteger(number) || number < 0) {
    throw new TypeError("backlog count is not a non-negative integer");
  }
  return number;
}

function checkedThreshold(stalledAfterMs: number): number {
  if (!Number.isSafeInteger(stalledAfterMs) || stalledAfterMs < 1_000) {
    throw new TypeError("self-host backlog threshold must be at least one second");
  }
  return stalledAfterMs;
}

/**
 * Read-only backlog counts. Each call issues exactly the two statements above,
 * and none while the process has been up for less than the threshold; a
 * thrown read is the caller's to report.
 */
export function createSelfhostBacklogObserver(input: {
  readonly sql: Pick<Sql, "query">;
  readonly now: () => Date;
  /** Wall-clock milliseconds at which this Host process started serving. */
  readonly startedAtMs: number;
  readonly stalledAfterMs?: number;
}): { observe(): Promise<SelfhostBacklogCounts> } {
  const stalledAfterMs = checkedThreshold(
    input.stalledAfterMs ?? SELFHOST_BACKLOG_STALLED_AFTER_MS,
  );
  if (!Number.isFinite(input.startedAtMs)) {
    throw new TypeError("self-host backlog start time is invalid");
  }
  return {
    async observe() {
      const nowMs = input.now().getTime();
      if (!Number.isFinite(nowMs)) throw new TypeError("self-host clock is invalid");
      const cutoffMs = nowMs - stalledAfterMs;
      // Nothing has been pending this long while the process ran.
      if (input.startedAtMs > cutoffMs) return ZERO_COUNTS;
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
      return { operations, queueExecutions: { sendAuthorized: count(sent[0]?.n) } };
    },
  };
}

export interface SelfhostBacklogSampler {
  /** One sample, run by a background pass; a failure keeps the previous sample. */
  refresh(): Promise<void>;
  /** The latest sample from memory, or `unavailable` when none is fresh. */
  snapshot(): SelfhostBacklogHealth | "unavailable";
}

/**
 * Holds the latest backlog sample for the probe. A sample that never arrived,
 * or is older than `staleAfterMs`, is `unavailable`: the sampling pass failed
 * or stopped, which the pass recorder also counts.
 */
export function createSelfhostBacklogSampler(input: {
  readonly observer: { observe(): Promise<SelfhostBacklogCounts> };
  /** Monotonic milliseconds; a wall-clock step must not age or refresh a sample. */
  readonly now?: () => number;
  readonly stalledAfterMs?: number;
  readonly staleAfterMs?: number;
}): SelfhostBacklogSampler {
  const now = input.now ?? (() => performance.now());
  const olderThanSeconds = Math.floor(
    checkedThreshold(input.stalledAfterMs ?? SELFHOST_BACKLOG_STALLED_AFTER_MS) / 1_000,
  );
  const staleAfterMs = input.staleAfterMs ?? SELFHOST_BACKLOG_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs < 1) {
    throw new TypeError("self-host backlog staleness bound must be positive");
  }
  let latest: { readonly counts: SelfhostBacklogCounts; readonly at: number } | undefined;
  return {
    async refresh() {
      const counts = await input.observer.observe();
      latest = { counts, at: now() };
    },
    snapshot() {
      if (!latest) return "unavailable";
      const age = now() - latest.at;
      if (!(age >= 0) || age > staleAfterMs) return "unavailable";
      const { operations, queueExecutions } = latest.counts;
      return {
        olderThanSeconds,
        sampledSecondsAgo: Math.floor(age / 1_000),
        operations: {
          queued: operations.queued,
          running: operations.running,
          reconciling: operations.reconciling,
          waitingInput: operations.waitingInput,
        },
        queueExecutions: { sendAuthorized: queueExecutions.sendAuthorized },
      };
    },
  };
}

/** Pass names come from source; anything else shares one bucket. */
const PASS_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/u;
const MAX_TRACKED_PASSES = 64;

/**
 * Counts only. Which pass failed, when, and why are in the entry's stderr line
 * (`self-host background pass failed: <name>: <bounded cause>`), not in an
 * unauthenticated response body.
 */
export interface SelfhostBackgroundPassHealth {
  /** Named passes whose most recent completed run failed. */
  readonly failing: number;
  /** Named passes whose current run started longer ago than the threshold. */
  readonly stalled: number;
}

export interface SelfhostBackgroundPassRecorder {
  /** Wrap one pass body so its start and outcome are recorded; outcome is unchanged. */
  observe(name: string, run: () => void | Promise<void>): () => Promise<void>;
  snapshot(): SelfhostBackgroundPassHealth;
}

/** A pass that later succeeds stops counting as failing. */
export function createSelfhostBackgroundPassRecorder(
  options: {
    /** Monotonic milliseconds; a wall-clock step must not age a running pass. */
    readonly now?: () => number;
    readonly stalledAfterMs?: number;
  } = {},
): SelfhostBackgroundPassRecorder {
  const now = options.now ?? (() => performance.now());
  const stalledAfterMs = options.stalledAfterMs ?? SELFHOST_BACKLOG_STALLED_AFTER_MS;
  const passes = new Map<string, { failed: boolean; startedAt: number | null }>();

  const entry = (name: string) => {
    let key = PASS_NAME.test(name) ? name : "unnamed";
    // Names are source constants; the bound only keeps a bug from growing this.
    if (!passes.has(key) && passes.size >= MAX_TRACKED_PASSES) key = "unnamed";
    let state = passes.get(key);
    if (!state) {
      state = { failed: false, startedAt: null };
      passes.set(key, state);
    }
    return state;
  };

  return {
    observe(name, run) {
      return async () => {
        const state = entry(name);
        const startedAt = now();
        state.startedAt = startedAt;
        try {
          await run();
          state.failed = false;
        } catch (error) {
          state.failed = true;
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
      return { failing, stalled };
    },
  };
}

export type SelfhostObservedPasses = Pick<SelfhostEntryShutdown, "startInterval" | "runPass">;

/**
 * The shutdown owner's pass API with each body observed by `recorder`. Only
 * the body is wrapped: single-flight per name, the stop fence, the failure
 * callback and the rejection a caller sees stay exactly the shutdown owner's.
 */
export function observeSelfhostBackgroundPasses(
  shutdown: SelfhostObservedPasses,
  recorder: Pick<SelfhostBackgroundPassRecorder, "observe">,
): SelfhostObservedPasses {
  return {
    startInterval: (name, milliseconds, run, onFailure) =>
      shutdown.startInterval(name, milliseconds, recorder.observe(name, run), onFailure),
    runPass: (name, run) => shutdown.runPass(name, recorder.observe(name, run)),
  };
}
