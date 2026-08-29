import { describe, expect, test } from "bun:test";
import { createWorkerdSupervisor } from "../src/workerd-supervisor.ts";

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
    const supervisor = createWorkerdSupervisor({
      binary: "/usr/bin/workerd",
      spawn: () => ({
        kill() {
          killed += 1;
        },
      }),
      readiness: async () => false,
    });
    await expect(supervisor.ensure("/data/workerd.capnp")).rejects.toThrow("readiness");
    expect(supervisor.isReady()).toBe(false);
    expect(killed).toBe(1);
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
