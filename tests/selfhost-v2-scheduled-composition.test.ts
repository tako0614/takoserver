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

test("scheduled capability captures caller scope before owner lookup and refuses a closed lookup", async () => {
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => {
    releaseLookup = resolve;
  });
  const lookups: string[] = [];
  const observedScopes: unknown[] = [];
  const owner = {
    async observeScheduledCapability(input: unknown) {
      observedScopes.push(input);
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
    async ownerForWorkerUid(uid) {
      lookups.push(uid);
      await lookupGate;
      return owner;
    },
  });
  const input = {
    workerUid: "worker-1",
    principal: "org:one",
    space: "one",
    targetKey: "selfhost-target",
  };
  const pending = composition.capability.observeScheduledCapability(input);
  input.workerUid = "worker-2";
  input.principal = "org:two";
  input.space = "two";
  input.targetKey = "other-target";
  releaseLookup();
  expect((await pending).kind).toBe("confirmed");
  expect(lookups).toEqual(["worker-1"]);
  expect(observedScopes).toEqual([
    {
      workerUid: "worker-1",
      principal: "org:one",
      space: "one",
      targetKey: "selfhost-target",
    },
  ]);
  const closing = composition.capability.observeScheduledCapability({
    workerUid: "worker-3",
    principal: "org:three",
    space: "three",
    targetKey: "selfhost-target",
  });
  composition.close();
  expect(await closing).toEqual({ kind: "unknown" });
  expect(observedScopes).toHaveLength(1);
});

test("scheduled due scans are single-flight and close joins the in-progress scan", async () => {
  let releaseQuery!: () => void;
  const queryGate = new Promise<void>((resolve) => {
    releaseQuery = resolve;
  });
  let queryCount = 0;
  const sql: Sql = {
    async query() {
      if (queryCount++ === 0) await queryGate;
      return [];
    },
    async run() {
      return { rows: [], changes: 1 };
    },
    async batch() {
      return [];
    },
  };
  const composition = createSelfhostV2ScheduledComposition({
    sql,
    targetKey: "selfhost-target",
    ownerForWorkerUid: async () => {
      throw new Error("no accepted Cron match exists");
    },
  });
  const first = composition.tick();
  const joined = composition.tick();
  expect(joined).toBe(first);
  composition.close();
  let drained = false;
  const drain = composition.drain().then(() => {
    drained = true;
  });
  await Promise.resolve();
  expect(drained).toBe(false);
  releaseQuery();
  expect(await first).toMatchObject({ recorded: 0, claimed: 0 });
  await drain;
  expect(drained).toBe(true);
  expect(queryCount).toBeGreaterThan(1);
  await expect(composition.tick()).rejects.toThrow("closed");
});
