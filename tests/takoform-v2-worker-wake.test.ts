import { expect, test } from "bun:test";
import type { V2Operation } from "../src/takoform-v2/types.ts";
import { drainV2Operations } from "../src/takoform-v2/worker-wake.ts";

function operation(status: V2Operation["status"], error?: V2Operation["error"]): V2Operation {
  return {
    id: "accepted-operation",
    resourceUid: "accepted-resource",
    action: "create",
    generation: 1,
    status,
    effect: status === "succeeded" ? "complete" : "unknown",
    createdAt: "2026-10-12T00:00:00.000Z",
    updatedAt: "2026-10-12T00:00:00.000Z",
    retainUntil: "2026-10-13T00:00:00.000Z",
    ...(error ? { error } : {}),
  };
}

test("bounded v2 wake waits for persisted continuation eligibility before another pass", async () => {
  let now = 0;
  const calls: number[] = [];
  const sleeps: number[] = [];
  await drainV2Operations(
    async () => {
      calls.push(now);
      return calls.length === 1 ? operation("reconciling") : operation("succeeded");
    },
    {
      now: () => now,
      sleep: async (ms) => {
        sleeps.push(ms);
        now += ms;
      },
      maxSteps: 2,
    },
  );
  expect(sleeps).toEqual([1_000]);
  expect(calls).toEqual([0, 1_000]);
});

test("bounded v2 wake stops on idle and uncertain backoff without spinning", async () => {
  let idleCalls = 0;
  await drainV2Operations(async () => {
    idleCalls += 1;
    return null;
  });
  expect(idleCalls).toBe(1);

  let backoffCalls = 0;
  await drainV2Operations(async () => {
    backoffCalls += 1;
    return operation("reconciling", { code: "outcome_unconfirmed", message: "pending" });
  });
  expect(backoffCalls).toBe(1);
});

test("a later durable eligibility remains authoritative after a conservative continuation wake", async () => {
  let now = 0;
  let calls = 0;
  await drainV2Operations(
    async () => {
      calls += 1;
      return calls === 1 ? operation("reconciling") : null;
    },
    {
      now: () => now,
      sleep: async (ms) => {
        now += ms;
      },
    },
  );
  expect(now).toBe(1_000);
  expect(calls).toBe(2);
});

test("bounded v2 wake starts no new pass past elapsed or iteration cap", async () => {
  let now = 0;
  let calls = 0;
  await drainV2Operations(
    async () => {
      calls += 1;
      now += 10;
      return operation("succeeded");
    },
    { now: () => now, maxElapsedMs: 25, maxSteps: 100 },
  );
  expect(calls).toBe(3);

  calls = 0;
  await drainV2Operations(
    async () => {
      calls += 1;
      return operation("succeeded");
    },
    { maxSteps: 3 },
  );
  expect(calls).toBe(3);
});
