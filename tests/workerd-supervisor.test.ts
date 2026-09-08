import { describe, expect, test } from "bun:test";
import { createWorkerdSupervisor } from "../src/workerd-supervisor.ts";

type TestChild = {
  readonly process: {
    kill(): void;
    readonly exited: Promise<number>;
  };
  exit(code?: number): void;
  readonly killed: number;
};

type Deferred<T> = {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
};

function testChild(): TestChild {
  let resolveExit: ((code: number) => void) | undefined;
  let killed = 0;
  const process = {
    kill() {
      killed += 1;
    },
    exited: new Promise<number>((resolve) => {
      resolveExit = resolve;
    }),
  };
  return {
    process,
    exit(code = 1) {
      resolveExit?.(code);
    },
    get killed() {
      return killed;
    },
  };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) await Promise.resolve();
}

/**
 * Generating a configuration and leaving somebody to start the runtime is not
 * a platform; it is homework. What matters is that starting it happens once,
 * and that a machine without the binary fails the serving operation.
 */
describe("keeping workerd running", () => {
  test("starts once however many times it is asked", async () => {
    const started: string[][] = [];
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: (command) => {
        started.push([...command]);
        return { kill() {} };
      },
      readiness: async () => true,
    });
    await supervisor.ensure("/data/workerd.capnp");
    await supervisor.ensure("/data/workerd.capnp");
    await supervisor.ensure("/data/workerd.capnp");

    expect(started).toHaveLength(1);
    // Watching, so a rewritten config does not bounce other tenants' requests.
    expect(started[0]).toEqual(["/usr/bin/workerd", "serve", "--watch", "/data/workerd.capnp"]);
  });

  test("recovers a ready runtime after its child exits", async () => {
    const children: TestChild[] = [];
    const restarts: Array<{ readonly delay: number; readonly run: () => void }> = [];
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: () => {
        const child = testChild();
        children.push(child);
        return child.process;
      },
      readiness: async () => true,
      scheduleRestart: (run, delay) => {
        restarts.push({ delay, run });
        return () => undefined;
      },
    });

    await supervisor.ensure("/data/workerd.capnp");
    expect(supervisor.isReady()).toBe(true);

    children[0]?.exit();
    await settle();
    expect(supervisor.isReady()).toBe(false);
    expect(restarts).toHaveLength(1);
    expect(restarts[0]?.delay).toBeGreaterThan(0);

    restarts[0]?.run();
    await settle();
    expect(children).toHaveLength(2);
    expect(supervisor.isReady()).toBe(true);
  });

  test("caps repeated recovery backoff without bouncing a healthy child", async () => {
    const children: TestChild[] = [];
    const restarts: Array<{ readonly delay: number; readonly run: () => void }> = [];
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: () => {
        const child = testChild();
        children.push(child);
        return child.process;
      },
      readiness: async () => true,
      scheduleRestart: (run, delay) => {
        restarts.push({ delay, run });
        return () => undefined;
      },
    });

    await supervisor.ensure("/data/workerd.capnp");
    for (let crash = 0; crash < 8; crash += 1) {
      children.at(-1)?.exit();
      await settle();
      restarts.at(-1)?.run();
      await settle();
    }

    expect(children).toHaveLength(9);
    expect(restarts.map(({ delay }) => delay)).toEqual([
      100, 200, 400, 800, 1_600, 3_200, 5_000, 5_000,
    ]);
    expect(supervisor.isReady()).toBe(true);
  });

  test("stop cancels a pending recovery and a later ensure starts normally", async () => {
    const children: TestChild[] = [];
    const cancellations: number[] = [];
    const restarts: Array<{ readonly run: () => void }> = [];
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: () => {
        const child = testChild();
        children.push(child);
        return child.process;
      },
      readiness: async () => true,
      scheduleRestart: (run) => {
        const index = cancellations.length;
        cancellations.push(0);
        restarts.push({ run });
        return () => {
          cancellations[index] = (cancellations[index] ?? 0) + 1;
        };
      },
    });

    await supervisor.ensure("/data/workerd.capnp");
    children[0]?.exit();
    await settle();
    expect(restarts).toHaveLength(1);

    supervisor.stop();
    expect(cancellations).toEqual([1]);
    restarts[0]?.run();
    await settle();
    expect(children).toHaveLength(1);
    expect(supervisor.isReady()).toBe(false);

    await supervisor.ensure("/data/workerd.capnp");
    expect(children).toHaveLength(2);
    expect(supervisor.isReady()).toBe(true);
  });

  test("does not let stale readiness revive a stopped child or replace a later ensure", async () => {
    const children: TestChild[] = [];
    const probes: Array<Deferred<boolean>> = [];
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: () => {
        const child = testChild();
        children.push(child);
        return child.process;
      },
      readiness: async () => {
        const probe = deferred<boolean>();
        probes.push(probe);
        return await probe.promise;
      },
    });

    const firstEnsure = supervisor.ensure("/data/workerd.capnp");
    await settle();
    expect(children).toHaveLength(1);
    supervisor.stop();

    const secondEnsure = supervisor.ensure("/data/workerd.capnp");
    await settle();
    expect(children).toHaveLength(2);
    expect(probes).toHaveLength(2);

    probes[0]?.resolve(true);
    await expect(firstEnsure).rejects.toThrow("cancelled");
    expect(supervisor.isReady()).toBe(false);
    expect(children[0]?.killed).toBe(1);

    probes[1]?.resolve(true);
    await secondEnsure;
    expect(supervisor.isReady()).toBe(true);
    expect(children[1]?.killed).toBe(0);

    children[0]?.exit();
    await settle();
    expect(supervisor.isReady()).toBe(true);
  });

  test("kills a child when its readiness probe throws", async () => {
    let child: TestChild | undefined;
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: () => {
        child = testChild();
        return child.process;
      },
      readiness: async () => {
        throw new Error("listener probe failed");
      },
    });

    await expect(supervisor.ensure("/data/workerd.capnp")).rejects.toThrow("listener probe failed");
    expect(child?.killed).toBe(1);
    expect(supervisor.isReady()).toBe(false);
  });

  test("fails serving activation when there is no runtime binary", async () => {
    const said: string[] = [];
    const supervisor = createWorkerdSupervisor({
      binary: null,
      spawn: () => {
        throw new Error("must not spawn");
      },
      log: (message) => said.push(message),
    });
    await expect(supervisor.ensure("/data/workerd.capnp")).rejects.toThrow("binary is required");
    expect(said).toHaveLength(0);
  });

  test("fails closed when serving has no liveness/readiness proof", async () => {
    let spawned = 0;
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: () => {
        spawned += 1;
        return { kill() {} };
      },
    });
    await expect(supervisor.ensure("/data/workerd.capnp")).rejects.toThrow("readiness probe");
    expect(spawned).toBe(0);
    expect(supervisor.isReady()).toBe(false);
  });

  test("does not mark a child ready until its liveness probe succeeds", async () => {
    let killed = 0;
    let scheduled = 0;
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: () => ({
        kill() {
          killed += 1;
        },
      }),
      readiness: async () => false,
      scheduleRestart: () => {
        scheduled += 1;
        return () => undefined;
      },
    });
    await expect(supervisor.ensure("/data/workerd.capnp")).rejects.toThrow("readiness");
    expect(supervisor.isReady()).toBe(false);
    expect(killed).toBe(1);
    expect(scheduled).toBe(0);
  });

  test("stops what it started", async () => {
    let killed = 0;
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: () => ({
        kill() {
          killed += 1;
        },
      }),
      readiness: async () => true,
    });
    await supervisor.ensure("/data/workerd.capnp");
    supervisor.stop();
    expect(killed).toBe(1);
    // And starts again afterwards, rather than believing it is still running.
    await supervisor.ensure("/data/workerd.capnp");
    supervisor.stop();
    expect(killed).toBe(2);
  });
});
