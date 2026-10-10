import { expect, test } from "bun:test";
import type { Sql } from "../src/ports.ts";
import { cancelQueueReservationBeforeSend } from "../src/selfhost-v2-queue-cancel.ts";

/**
 * A reservation that was provably never sent is refunded by Core's
 * pre-send cancel. When that one SQL write loses to a transient lock, giving
 * up silently leaves the messages invisible for the reservation's 120 seconds.
 * These tests pin: retry while the row is still pre-send, never retry once it
 * is not, and say so when every attempt failed.
 */

const batch = { batchId: "batch-1", reservationToken: "reservation-1" } as const;

function sqlWithState(states: readonly (string | "throw" | "absent")[]): {
  readonly sql: Sql;
  readonly reads: () => number;
} {
  let reads = 0;
  const sql = {
    async query() {
      const next = states[Math.min(reads, states.length - 1)];
      reads += 1;
      if (next === "throw") throw new Error("database is locked");
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
      if (calls < 3) throw new Error("database is locked");
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
  const { sql } = sqlWithState(["throw"]);
  const delays: number[] = [];
  const reported: unknown[] = [];
  const result = await cancelQueueReservationBeforeSend({
    sql,
    batch,
    cancel: async () => {
      throw new Error("database is locked");
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
  expect((reported[0] as Error).message).toBe("database is locked");
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
