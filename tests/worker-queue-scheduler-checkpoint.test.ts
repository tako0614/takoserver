import { expect, test } from "bun:test";
import type { Sql } from "../src/ports.ts";
import type { QueueCustody } from "../src/queue-custody.ts";
import {
  createV2QueueScheduler,
  type V2QueueSchedulerCheckpoint,
  type V2QueueSchedulerOptions,
} from "../src/takoform-v2/worker-queue-scheduler.ts";

const uid = (index: number) => `consumer-${String(index).padStart(2, "0")}`;

function candidate(uidValue: string) {
  return {
    uid: uidValue,
    principal: "principal-a",
    space: "space-a",
    target_key: "target-a",
  };
}

function schedulerOptions(
  sql: Sql,
  checkpoint?: V2QueueSchedulerCheckpoint,
): V2QueueSchedulerOptions {
  return {
    sql,
    custody: {} as QueueCustody,
    delivery: { deliverOnce: async () => ({ kind: "idle" }) },
    ...(checkpoint ? { checkpoint } : {}),
  };
}

test("Queue scheduler resumes the bounded consumer page from an owned checkpoint", async () => {
  const candidates = Array.from({ length: 17 }, (_, index) => candidate(uid(index + 1)));
  const cursors: unknown[] = [];
  const sql = {
    async query(statement: string, params: readonly unknown[] = []) {
      if (statement.includes("FROM queue_custody_transfer_notices")) return [];
      if (statement.includes("FROM tf_v2_resources resource")) {
        const after = params[0];
        cursors.push(after);
        return candidates.filter((row) => row.uid > String(after)).slice(0, 16);
      }
      throw new Error(`unexpected scheduler query: ${statement}`);
    },
  } as unknown as Sql;

  const first = createV2QueueScheduler(schedulerOptions(sql));
  expect(await first.tick()).toBe(16);
  const checkpoint = first.checkpoint();
  expect(checkpoint).toEqual({
    schema: "takoserver.v2-queue-scheduler-checkpoint@v1",
    consumerCursor: uid(16),
    noticeCursor: null,
  });
  expect(Object.isFrozen(checkpoint)).toBe(true);
  await first.close();

  const resumed = createV2QueueScheduler(schedulerOptions(sql, checkpoint));
  expect(await resumed.tick()).toBe(1);
  expect(cursors).toEqual(["", uid(16)]);
  expect(resumed.checkpoint().consumerCursor).toBe("");
  await resumed.close();
});

test("Queue scheduler checkpoint validation rejects corrupt or accessor-backed data", () => {
  const make = (checkpoint: unknown) =>
    createV2QueueScheduler({
      ...schedulerOptions({ query: async () => [] } as unknown as Sql),
      checkpoint: checkpoint as V2QueueSchedulerCheckpoint,
    });
  const valid = {
    schema: "takoserver.v2-queue-scheduler-checkpoint@v1",
    consumerCursor: "",
    noticeCursor: null,
  };

  expect(() => make({ ...valid, unexpected: true })).toThrow(TypeError);
  expect(() => make({ ...valid, consumerCursor: "bad\u0000cursor" })).toThrow(TypeError);
  expect(() =>
    make({
      ...valid,
      noticeCursor: ["queue", "consumer-01", 1, "takoform-v2-queue:target"],
    }),
  ).toThrow(TypeError);

  let reads = 0;
  const accessor = Object.defineProperty({ ...valid }, "consumerCursor", {
    enumerable: true,
    get() {
      reads += 1;
      return "";
    },
  });
  expect(() => make(accessor)).toThrow(TypeError);
  expect(reads).toBe(0);
  const optionsWithAccessor = schedulerOptions({ query: async () => [] } as unknown as Sql);
  let optionReads = 0;
  Object.defineProperty(optionsWithAccessor, "checkpoint", {
    enumerable: true,
    get() {
      optionReads += 1;
      return valid;
    },
  });
  expect(() => createV2QueueScheduler(optionsWithAccessor)).toThrow(TypeError);
  expect(optionReads).toBe(0);

  const mutableTuple = [
    "takoform-v2-queue:source",
    "consumer-01",
    1,
    "takoform-v2-queue:target",
  ] as [string, string, number, string];
  const owned = createV2QueueScheduler(
    schedulerOptions(
      { query: async () => [] } as unknown as Sql,
      { ...valid, noticeCursor: mutableTuple } as V2QueueSchedulerCheckpoint,
    ),
  );
  mutableTuple[0] = "takoform-v2-queue:changed";
  expect(owned.checkpoint().noticeCursor?.[0]).toBe("takoform-v2-queue:source");
  expect(Object.isFrozen(owned.checkpoint().noticeCursor)).toBe(true);
});
