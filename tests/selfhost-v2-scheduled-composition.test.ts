import { expect, test } from "bun:test";
import type { Sql } from "../src/ports.ts";
import { createSelfhostV2ScheduledComposition } from "../src/selfhost-v2-scheduled-composition.ts";
import type { WorkerdWorkerRuntimeOwner } from "../src/workerd-worker-runtime-owner.ts";

test("scheduled adapter uses exact native capability and fences it on close", async () => {
  const calls: unknown[] = [];
  const owner = {
    async observeScheduledCapability(input: unknown) {
      calls.push(input);
      return {
        kind: "confirmed" as const,
        servingSourceOperationId: "operation-1",
        deploymentUid: "deployment-1",
        deploymentGeneration: 1,
        versions: [{ workerVersionUid: "version-1", generation: 1, weight: 10_000 }],
        stillCurrent: async () => true,
      };
    },
    async invokeScheduled() {
      return { kind: "unknown" as const };
    },
  } satisfies Pick<WorkerdWorkerRuntimeOwner, "observeScheduledCapability" | "invokeScheduled">;
  const composition = createSelfhostV2ScheduledComposition({
    sql: {} as Sql,
    targetKey: "selfhost-target",
    ownerForWorkerUid: async () => owner,
  });
  const request = {
    workerUid: "worker-1",
    principal: "org:one",
    space: "one",
    targetKey: "selfhost-target",
  };
  expect(
    await composition.capability.observeScheduledCapability({ ...request, targetKey: "other" }),
  ).toEqual({ kind: "unknown" });
  expect(calls).toHaveLength(0);
  const observed = await composition.capability.observeScheduledCapability(request);
  expect(observed.kind).toBe("confirmed");
  expect(calls).toEqual([request]);
  if (observed.kind !== "confirmed") throw new Error("native capability missing");
  expect(await observed.stillCurrent()).toBe(true);
  composition.close();
  expect(await observed.stillCurrent()).toBe(false);
  expect(await composition.capability.observeScheduledCapability(request)).toEqual({
    kind: "unknown",
  });
  await expect(composition.tick()).rejects.toThrow();
  await composition.drain();
});
