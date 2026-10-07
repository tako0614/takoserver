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
  const children: Array<{ process: WorkerdProcess; exit(code: number): void }> = [];
  const supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    listenerPort: 28790,
    listenerOwnership: async () => "vacant",
    spawn: () => {
      spawnCalls++;
      let resolveExit!: (code: number) => void;
      const process: WorkerdProcess = {
        pid: 43 + spawnCalls,
        kill: () => killed++,
        exited: new Promise<number>((resolve) => {
          resolveExit = resolve;
        }),
      };
      children.push({ process, exit: (code) => resolveExit(code) });
      return process;
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
    "child identity persistence failed",
  );
  expect(killed).toBe(1);
  expect(readinessCalls).toBe(0);
  expect(supervisor.snapshot()).toEqual({ state: "unavailable" });

  const retry = supervisor.ensure("/data/workerd.capnp");
  await Promise.resolve();
  await Promise.resolve();
  expect(spawnCalls).toBe(1);
  expect(restartSchedules).toBe(0);
  children[0]?.exit(137);
  await expect(retry).rejects.toThrow("child identity persistence failed");
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

test("shutdown joins a reentrant pending persistence hook even after fast child exit", async () => {
  let resolveExit!: (code: number) => void;
  let shutdownResolved = false;
  let hookStarted = false;
  let vacancyCalls = 0;
  let supervisor: ReturnType<typeof createWorkerdSupervisor>;
  let shutdown: Promise<void> | undefined;
  const persistence = deferred<void>();
  const child: WorkerdProcess = {
    pid: 44,
    kill() {},
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
  };
  supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    listenerPort: 28791,
    listenerOwnership: async () => {
      vacancyCalls++;
      return "vacant";
    },
    spawn: () => child,
    onSpawned: async () => {
      hookStarted = true;
      shutdown = supervisor.shutdown();
      void shutdown.then(() => {
        shutdownResolved = true;
      });
      await persistence.promise;
    },
    readiness: async () => true,
  });

  const start = supervisor.ensure("/data/workerd.capnp");
  await Promise.resolve();
  await Promise.resolve();
  expect(hookStarted).toBe(true);
  expect(shutdown).toBeDefined();
  resolveExit(137);
  await Promise.resolve();
  await Promise.resolve();
  expect(shutdownResolved).toBe(false);
  expect(vacancyCalls).toBe(0);

  persistence.resolve();
  await expect(start).rejects.toThrow("startup was cancelled");
  await shutdown;
  expect(shutdownResolved).toBe(true);
});

test("hook rejection does not fail shutdown after exact child exit and vacancy", async () => {
  let resolveExit!: (code: number) => void;
  const persistence = deferred<void>();
  let vacancyCalls = 0;
  const child: WorkerdProcess = {
    pid: 45,
    kill() {},
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
  };
  const supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    listenerPort: 28792,
    listenerOwnership: async () => {
      vacancyCalls++;
      return "vacant";
    },
    spawn: () => child,
    onSpawned: async () => {
      await persistence.promise;
      throw new Error("persistence rejected");
    },
    readiness: async () => true,
  });

  const start = supervisor.ensure("/data/workerd.capnp");
  await Promise.resolve();
  await Promise.resolve();
  const shutdown = supervisor.shutdown();
  resolveExit(137);
  for (let turn = 0; turn < 4; turn += 1) await Promise.resolve();
  expect(vacancyCalls).toBe(0);
  persistence.resolve();
  await expect(start).rejects.toThrow("child identity persistence failed");
  await expect(shutdown).resolves.toBeUndefined();
  expect(vacancyCalls).toBeGreaterThan(0);
});

test("a persistence failure during automatic recovery is not retried in background", async () => {
  const children: Array<{ process: WorkerdProcess; exit(): void }> = [];
  const restarts: Array<() => void> = [];
  let spawnCalls = 0;
  const supervisor = createWorkerdSupervisor({
    binary: "/usr/bin/workerd",
    spawn: () => {
      spawnCalls++;
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
      if (spawnCalls > 1) throw new Error("persistence rejected");
    },
    readiness: async () => true,
    scheduleRestart: (run) => {
      restarts.push(run);
      return () => undefined;
    },
  });

  await supervisor.ensure("/data/workerd.capnp");
  children[0]?.exit();
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  expect(restarts).toHaveLength(1);
  restarts[0]?.();
  await expect(supervisor.ensure("/data/workerd.capnp")).rejects.toThrow(
    "child identity persistence failed",
  );
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
  expect(spawnCalls).toBe(2);
  expect(restarts).toHaveLength(1);
  supervisor.stop();
});
