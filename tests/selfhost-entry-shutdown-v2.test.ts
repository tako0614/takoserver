import { expect, test } from "bun:test";
import {
  closeSelfhostEntryOwnedResources,
  createSelfhostEntryShutdown,
} from "../src/selfhost-entry-shutdown.ts";

function gate() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test("one normal shutdown suspends v2 Worker owners before dependent planes and SQL close", async () => {
  const calls: string[] = [];
  const paused = gate();
  const entered = gate();
  const lifecycle = createSelfhostEntryShutdown({
    stopIngress: async () => {
      calls.push("ingress");
    },
    finishShutdown: async () => {
      const closed = await closeSelfhostEntryOwnedResources({
        workerdShutdown: async () => {
          calls.push("legacy-workerd");
        },
        mayCloseDependents: () => true,
        v2WorkerSuspend: async () => {
          calls.push("v2-owner-suspend");
          entered.release();
          await paused.wait;
        },
        actorClose: async () => {
          calls.push("actor");
        },
        dataPlanesStop: async () => {
          calls.push("data-planes");
        },
        controlDatabaseClose: () => {
          calls.push("database");
        },
        onFailure: (stage) => {
          calls.push(`failed:${stage}`);
        },
      });
      if (!closed) throw new Error("owned resources did not stop");
    },
    onFailure: (stage) => {
      calls.push(`lifecycle-failed:${stage}`);
    },
    onSuccess: () => {
      calls.push("success");
    },
  });
  const first = lifecycle.shutdown();
  expect(lifecycle.shutdown()).toBe(first);
  await Promise.race([entered.wait, first.then(() => undefined)]);
  expect(calls).toEqual(["ingress", "legacy-workerd", "v2-owner-suspend"]);
  paused.release();
  expect(await first).toBe(true);
  expect(calls).toEqual([
    "ingress",
    "legacy-workerd",
    "v2-owner-suspend",
    "actor",
    "data-planes",
    "database",
    "success",
  ]);
});

test("uncertain v2 owner suspension retains all dependent services and reports its exact stage", async () => {
  const calls: string[] = [];
  const closed = await closeSelfhostEntryOwnedResources({
    workerdShutdown: async () => {
      calls.push("legacy-workerd");
    },
    mayCloseDependents: () => true,
    v2WorkerSuspend: async () => {
      calls.push("v2-owner-suspend");
      throw new Error("native child exit still unknown");
    },
    actorClose: async () => {
      calls.push("actor");
    },
    dataPlanesStop: async () => {
      calls.push("data-planes");
    },
    controlDatabaseClose: () => {
      calls.push("database");
    },
    onFailure: (stage) => {
      calls.push(`failed:${stage}`);
    },
  });
  expect(closed).toBe(false);
  expect(calls).toEqual(["legacy-workerd", "v2-owner-suspend", "failed:v2-worker-suspend"]);
});
