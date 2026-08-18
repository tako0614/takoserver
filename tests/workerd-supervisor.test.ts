import { describe, expect, test } from "bun:test";
import { createWorkerdSupervisor } from "../src/workerd-supervisor.ts";

/**
 * Generating a configuration and leaving somebody to start the runtime is not
 * a platform; it is homework. What matters is that starting it happens once,
 * and that a machine without the binary keeps serving what it can.
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
    });
    await supervisor.ensure("/data/workerd.capnp");
    await supervisor.ensure("/data/workerd.capnp");
    await supervisor.ensure("/data/workerd.capnp");

    expect(started).toHaveLength(1);
    // Watching, so a rewritten config does not bounce other tenants' requests.
    expect(started[0]).toEqual(["/usr/bin/workerd", "serve", "--watch", "/data/workerd.capnp"]);
  });

  test("says so once when there is no runtime, and carries on", async () => {
    const said: string[] = [];
    const supervisor = createWorkerdSupervisor({
      binary: null,
      spawn: () => {
        throw new Error("must not spawn");
      },
      log: (message) => said.push(message),
    });
    await supervisor.ensure("/data/workerd.capnp");
    await supervisor.ensure("/data/workerd.capnp");

    // A deployment that refused to run because it cannot serve Workers would
    // also stop serving the storage it can.
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("Storage and databases are unaffected");
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
