import { expect, test } from "bun:test";
import { createWorkerdSupervisor, type WorkerdProcess } from "../src/workerd-supervisor.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  return {
    promise: new Promise<T>((done) => {
      resolve = done;
    }),
    resolve,
  };
}

test("awaits child identity persistence before readiness can pass", async () => {
  const persistence = deferred<void>();
  const order: string[] = [];
  const child: WorkerdProcess = { pid: 42, kill() {} };
  const supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    listenerPort: 28789,
    spawn: () => child,
    async onSpawned(actualChild) {
      expect(actualChild).toBe(child);
      order.push("persist-start");
      await persistence.promise;
      order.push("persist-committed");
    },
    async readiness() {
      order.push("readiness");
      return true;
    },
  });

  const starting = supervisor.ensure("/data/workerd.capnp");
  await Promise.resolve();
  await Promise.resolve();
  expect(order).toEqual(["persist-start"]);
  persistence.resolve();
  await starting;
  expect(order).toEqual(["persist-start", "persist-committed", "readiness"]);
});

test("a failed identity persistence hook fails startup and never probes readiness", async () => {
  let killed = 0;
  let readinessCalls = 0;
  let spawnCalls = 0;
  let restartSchedules = 0;
  let resolveExit!: (code: number) => void;
  const ownedChild: WorkerdProcess = {
    pid: 43,
    kill: () => killed++,
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
  };
  const supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    listenerPort: 28790,
    listenerOwnership: async () => "vacant",
    spawn: () => {
      spawnCalls++;
      return ownedChild;
    },
    onSpawned: async () => {
      throw new Error("durable identity write failed");
    },
    readiness: async () => {
      readinessCalls++;
      return true;
    },
    scheduleRestart: () => {
      restartSchedules++;
      return () => undefined;
    },
  });

  await expect(supervisor.ensure("/data/workerd.capnp")).rejects.toThrow(
    "durable identity write failed",
  );
  expect(killed).toBe(1);
  expect(readinessCalls).toBe(0);
  expect(supervisor.snapshot()).toEqual({ state: "unavailable" });

  const retry = supervisor.ensure("/data/workerd.capnp");
  await Promise.resolve();
  await Promise.resolve();
  expect(spawnCalls).toBe(1);
  expect(restartSchedules).toBe(0);
  resolveExit(137);
  await expect(retry).rejects.toThrow("durable identity write failed");
  expect(spawnCalls).toBe(2);
  expect(restartSchedules).toBe(0);
});

test("runs the persistence hook for every automatic child restart", async () => {
  const children: Array<{ process: WorkerdProcess; exit(): void }> = [];
  const restarts: Array<() => void> = [];
  let persisted = 0;
  const supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    spawn: () => {
      let resolveExit!: (code: number) => void;
      const child = {
        process: {
          kill() {},
          exited: new Promise<number>((resolve) => {
            resolveExit = resolve;
          }),
        },
        exit: () => resolveExit(1),
      };
      children.push(child);
      return child.process;
    },
    onSpawned: async () => {
      persisted++;
    },
    readiness: async () => true,
    scheduleRestart: (run) => {
      restarts.push(run);
      return () => undefined;
    },
  });

  await supervisor.ensure("/data/workerd.capnp");
  children[0]?.exit();
  await Promise.resolve();
  await Promise.resolve();
  restarts[0]?.();
  await supervisor.ensure("/data/workerd.capnp");
  expect(persisted).toBe(2);
  expect(children).toHaveLength(2);
  supervisor.stop();
});
