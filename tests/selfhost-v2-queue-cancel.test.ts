import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { Sql } from "../src/ports.ts";
import {
  cancelQueueReservationBeforeSend,
  refuseQueueReservationsBeforeFirstDelivery,
  SELFHOST_QUEUE_BOOT_REFUSAL_QUERY,
} from "../src/selfhost-v2-queue-cancel.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

/**
 * A reservation that was provably never sent is refunded by Core's
 * pre-send cancel. When that one SQL write loses to a transient lock, giving
 * up silently leaves the messages invisible for the reservation's 120 seconds.
 * These tests pin: retry while the row is still pre-send, never retry once it
 * is not, and say so when every attempt failed.
 */

const batch = { batchId: "batch-1", reservationToken: "reservation-1" } as const;

function sqlWithState(states: readonly (string | "throw" | "io" | "absent")[]): {
  readonly sql: Sql;
  readonly reads: () => number;
} {
  let reads = 0;
  const sql = {
    async query() {
      const next = states[Math.min(reads, states.length - 1)];
      reads += 1;
      if (next === "throw") throw new Error("database is locked");
      if (next === "io") throw new Error("disk I/O error");
      return next === "absent" ? [] : [{ state: next }];
    },
    async run() {
      throw new Error("unexpected write");
    },
    async batch() {
      throw new Error("unexpected write");
    },
  } as unknown as Sql;
  return { sql, reads: () => reads };
}

const noSleep = async () => undefined;

test("a transient failure of the cancel is retried until the reservation is refunded", async () => {
  const { sql } = sqlWithState(["reserved"]);
  let calls = 0;
  const reported: unknown[] = [];
  const result = await cancelQueueReservationBeforeSend({
    sql,
    batch,
    cancel: async () => {
      calls += 1;
      if (calls < 3) throw new Error("disk I/O error");
      return true;
    },
    sleep: noSleep,
    report: (cause) => reported.push(cause),
  });
  expect(result).toBe(true);
  expect(calls).toBe(3);
  expect(reported).toEqual([]);
});

test("a false result while the row is still pre-send is retried", async () => {
  const { sql } = sqlWithState(["registered"]);
  let calls = 0;
  const result = await cancelQueueReservationBeforeSend({
    sql,
    batch,
    cancel: async () => {
      calls += 1;
      return calls === 2;
    },
    sleep: noSleep,
  });
  expect(result).toBe(true);
  expect(calls).toBe(2);
});

test("a send-authorized or retired execution is never retried or reported", async () => {
  for (const state of ["send_authorized", "retired", "pre_effect_refused", "absent"] as const) {
    const { sql } = sqlWithState([state]);
    let calls = 0;
    const reported: unknown[] = [];
    const result = await cancelQueueReservationBeforeSend({
      sql,
      batch,
      cancel: async () => {
        calls += 1;
        return false;
      },
      sleep: noSleep,
      report: (cause) => reported.push(cause),
    });
    expect(result).toBe(false);
    expect(calls).toBe(1);
    expect(reported).toEqual([]);
  }
});

test("exhausted attempts report the last cause and still return false", async () => {
  const { sql } = sqlWithState(["io"]);
  const delays: number[] = [];
  const reported: unknown[] = [];
  const result = await cancelQueueReservationBeforeSend({
    sql,
    batch,
    cancel: async () => {
      throw new Error("disk I/O error");
    },
    delaysMs: [5, 10],
    sleep: async (milliseconds) => {
      delays.push(milliseconds);
    },
    report: (cause) => reported.push(cause),
  });
  expect(result).toBe(false);
  expect(delays).toEqual([5, 10]);
  expect(reported).toHaveLength(1);
  expect((reported[0] as Error).message).toBe("disk I/O error");
});

test("a still-pre-send row that never cancels is reported, not silently dropped", async () => {
  const { sql } = sqlWithState(["reserved"]);
  const reported: unknown[] = [];
  const result = await cancelQueueReservationBeforeSend({
    sql,
    batch,
    cancel: async () => false,
    delaysMs: [1],
    sleep: noSleep,
    report: (cause) => reported.push(cause),
  });
  expect(result).toBe(false);
  expect(reported).toHaveLength(1);
});

test("a malformed identity is refused without any SQL", async () => {
  const { sql, reads } = sqlWithState(["reserved"]);
  let calls = 0;
  const result = await cancelQueueReservationBeforeSend({
    sql,
    batch: { batchId: "", reservationToken: "x" },
    cancel: async () => {
      calls += 1;
      return true;
    },
    sleep: noSleep,
  });
  expect(result).toBe(false);
  expect(calls).toBe(0);
  expect(reads()).toBe(0);
});

/**
 * A busy/locked error from bun:sqlite arrives only after busy_timeout already
 * blocked this thread. Retrying it would block the Host again for each
 * attempt, so the refund gives up at once and reports.
 */
test("a lock that outlasted busy_timeout is not retried", async () => {
  for (const failure of [
    Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" }),
    new Error("database is locked"),
    new Error("SQLITE_BUSY: database is locked"),
    new Error("database table is locked"),
  ]) {
    const { sql, reads } = sqlWithState(["reserved"]);
    let calls = 0;
    const sleeps: number[] = [];
    const reported: unknown[] = [];
    const result = await cancelQueueReservationBeforeSend({
      sql,
      batch,
      cancel: async () => {
        calls += 1;
        throw failure;
      },
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
      report: (cause) => reported.push(cause),
    });
    expect(result).toBe(false);
    expect(calls).toBe(1);
    expect(reads()).toBe(0);
    expect(sleeps).toEqual([]);
    expect(reported).toEqual([failure]);
  }
});

test("a busy state read after a false cancel is not retried either", async () => {
  const { sql, reads } = sqlWithState(["throw"]);
  let calls = 0;
  const reported: unknown[] = [];
  const result = await cancelQueueReservationBeforeSend({
    sql,
    batch,
    cancel: async () => {
      calls += 1;
      return false;
    },
    sleep: noSleep,
    report: (cause) => reported.push(cause),
  });
  expect(result).toBe(false);
  expect(calls).toBe(1);
  expect(reads()).toBe(1);
  expect(reported).toHaveLength(1);
});

test("retries stop at the total time budget, not only at the attempt count", async () => {
  const { sql } = sqlWithState(["reserved"]);
  let clock = 0;
  let calls = 0;
  const sleeps: number[] = [];
  const reported: unknown[] = [];
  const result = await cancelQueueReservationBeforeSend({
    sql,
    batch,
    cancel: async () => {
      calls += 1;
      clock += 300; // each attempt is slow, but not a lock error
      return false;
    },
    delaysMs: [100, 100, 100, 100, 100],
    budgetMs: 900,
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    },
    report: (cause) => reported.push(cause),
  });
  expect(result).toBe(false);
  // 300 + 100 + 300 = 700; another 100 + 300 would cross 900.
  expect(calls).toBe(2);
  expect(sleeps).toEqual([100]);
  expect(reported).toHaveLength(1);
});

test("Host start refuses each unsent reservation and stops at the first refusal that gives up", async () => {
  const startedAt = 1_791_687_371_000;
  const rows = ["batch-1", "batch-2", "batch-3", "batch-4"].map((batchId) => ({
    batch_id: batchId,
    reservation_token: `token-${batchId}`,
  }));
  const scans: (readonly unknown[])[] = [];
  const sql = {
    async query(statement: string, params: readonly unknown[] = []) {
      if (statement.includes("AS now")) return [{ now: startedAt }];
      // The cancel helper's own readback after a refused cancel.
      if (statement.includes("SELECT state FROM")) return [{ state: "send_authorized" }];
      if (statement === SELFHOST_QUEUE_BOOT_REFUSAL_QUERY) {
        scans.push(params);
        return rows;
      }
      throw new Error(`unexpected query: ${statement}`);
    },
    async run() {
      throw new Error("unexpected write");
    },
    async batch() {
      throw new Error("unexpected write");
    },
  } as unknown as Sql;
  const attempted: string[] = [];
  const reported: unknown[] = [];
  const refused = await refuseQueueReservationsBeforeFirstDelivery({
    sql,
    cancel: async (_sql, value) => {
      attempted.push(value.batchId);
      // batch-2 was sent meanwhile: Core refuses to cancel it, not a fault.
      if (value.batchId === "batch-3") throw new Error("database is locked");
      return value.batchId === "batch-1";
    },
    report: (cause) => reported.push(cause),
  });
  expect(scans).toEqual([[startedAt]]);
  // The lock already cost a full busy_timeout; batch-4 is left to its expiry.
  expect(attempted).toEqual(["batch-1", "batch-2", "batch-3"]);
  expect(refused).toBe(1);
  expect(reported.map((cause) => (cause as Error).message)).toEqual(["database is locked"]);
});

test("the Host start scan stays an index search over Consumers, with and without statistics", async () => {
  const seeded = (): Database => {
    const database = new Database(":memory:");
    migrateSqlite(database);
    // Direct rows only: the guards that admit them are not under test here.
    for (const { name } of database
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'queue_v2_batch_executions'",
      )
      .all() as { name: string }[])
      database.exec(`DROP TRIGGER "${name}"`);
    const insert = database.prepare(
      `INSERT INTO queue_v2_batch_executions
        (batch_id,reservation_token,lease_token,queue_id,consumer_uid,consumer_generation,
         worker_uid,consumer_spec_json,serving_source_operation_id,selected_versions_json,
         principal,space,target_key,max_concurrency,reserved_at_ms,reservation_until_ms,state,
         message_count,worker_version_uid,worker_version_generation,incarnation_operation_id,
         send_authorized_at_ms,retired_at_ms,retirement_kind,retirement_receipt_digest)
       VALUES (?,?,?,'takoform-v2-queue:queue-1',?,1,'worker-1','{}','source-op','[]',
         'org-one','default','target',10,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    const row = (
      batchId: string,
      consumer: string,
      state: "reserved" | "registered" | "send_authorized" | "retired",
      reservedAt: number,
    ) => {
      const leased = state !== "reserved";
      const sent = state === "send_authorized" || state === "retired";
      const retired = state === "retired";
      insert.run(
        batchId,
        `reservation-${batchId}`,
        leased ? `lease-${batchId}` : null,
        consumer,
        reservedAt,
        reservedAt + 120_000,
        state,
        leased ? 1 : null,
        sent ? "version-1" : null,
        sent ? 1 : null,
        sent ? "incarnation-1" : null,
        sent ? reservedAt + 1 : null,
        retired ? reservedAt + 2 : null,
        retired ? "handler_and_wait_until" : null,
        retired ? `receipt-${batchId}` : null,
      );
    };
    const now = Date.now();
    database.transaction(() => {
      for (let index = 0; index < 3_000; index += 1)
        row(`history-${index}`, `consumer-${"abc"[index % 3]}`, "retired", now - 1e9 + index);
      row("unsent-reserved", "consumer-a", "reserved", now - 5_000);
      row("unsent-registered", "consumer-b", "registered", now - 5_000);
      row("sent", "consumer-a", "send_authorized", now - 5_000);
      // Reserved after the refusal started: its own claimer is still running.
      row("later", "consumer-c", "reserved", now + 60_000);
    })();
    return database;
  };
  for (const collect of ["none", "ANALYZE", "PRAGMA optimize=0x10002"] as const) {
    const database = seeded();
    if (collect !== "none") database.exec(collect);
    const plan = (
      database.query(`EXPLAIN QUERY PLAN ${SELFHOST_QUEUE_BOOT_REFUSAL_QUERY}`).all(Date.now()) as {
        detail: string;
      }[]
    ).map((line) => line.detail);
    // Only the recursive CTE is scanned; every table access is an index seek
    // driven by one Consumer UID at a time.
    for (const line of plan) if (line.startsWith("SCAN ")) expect(line).toBe("SCAN consumer");
    expect(plan).toContain(
      "SEARCH next USING COVERING INDEX queue_v2_batch_executions_open_consumer (consumer_uid>?)",
    );
    expect(plan.at(-1)).toBe(
      "SEARCH execution USING INDEX queue_v2_batch_executions_open_consumer (consumer_uid=? AND state=?)",
    );
    expect(
      await refuseQueueReservationsBeforeFirstDelivery({ sql: createSqliteSql(database) }),
    ).toBe(2);
    expect(
      database
        .query(
          "SELECT batch_id, state FROM queue_v2_batch_executions WHERE state <> 'retired' ORDER BY batch_id",
        )
        .all(),
    ).toEqual([
      { batch_id: "later", state: "reserved" },
      { batch_id: "sent", state: "send_authorized" },
      { batch_id: "unsent-registered", state: "pre_effect_refused" },
      { batch_id: "unsent-reserved", state: "pre_effect_refused" },
    ]);
    database.close();
  }
});

test("a missing open-Consumer index refuses the Host start scan instead of walking history", async () => {
  const database = new Database(":memory:");
  migrateSqlite(database);
  database.exec("DROP INDEX queue_v2_batch_executions_open_consumer");
  await expect(
    refuseQueueReservationsBeforeFirstDelivery({ sql: createSqliteSql(database) }),
  ).rejects.toThrow("no such index");
  database.close();
});

test("Host start refusal needs the database clock before it touches any row", async () => {
  const sql = {
    async query() {
      return [{ now: null }];
    },
  } as unknown as Sql;
  await expect(
    refuseQueueReservationsBeforeFirstDelivery({
      sql,
      cancel: async () => {
        throw new Error("no row may be refused");
      },
    }),
  ).rejects.toThrow("database clock");
});
