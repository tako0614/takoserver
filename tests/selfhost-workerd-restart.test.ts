import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { createWorkerdSupervisor, findWorkerd } from "../src/workerd-supervisor.ts";

/**
 * A self-host survives its own restart.
 *
 * `workerd` was started by a publication and by nothing else. A restarted
 * self-host therefore served nothing at all, while its control plane reported
 * healthy and `tofu plan` answered "No changes. Your infrastructure matches the
 * configuration" — every resource observed Ready, and no request able to reach
 * any Worker. Neither a read nor a refresh revived it; only a fresh publication
 * did, so a machine did not come back from a reboot without a manual re-apply
 * and its own observation said it had.
 *
 * The test is the operator's own sequence: publish, confirm it serves, take the
 * process away, come back over the same data directory, and ask the Worker
 * again without publishing anything.
 */

const WORKERD = findWorkerd(resolve(import.meta.dir, ".."));
const HOSTNAME = "restart.localhost";
const MODULE = `export default {
  async fetch() {
    return new Response("served after a restart");
  },
};
`;

let root: string;
let running: { kill(): void; readonly exited?: Promise<number> } | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-restart-"));
});

afterEach(async () => {
  if (running) {
    // Waited out rather than merely signalled: a runtime still holding its
    // socket while the next file starts one of its own is how a suite becomes
    // flaky.
    running.kill();
    await running.exited;
    running = undefined;
  }
  if (root) rmSync(root, { recursive: true, force: true });
});

test.skipIf(WORKERD === null)(
  "a restarted self-host serves the Workers it already published, with no new publication",
  async () => {
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = Number(reserved.port);
    reserved.stop(true);

    const boot = async () => {
      const supervisor = createWorkerdSupervisor({
        binary: WORKERD,
        spawn: (command) => {
          const child = Bun.spawn([...command], { stdout: "ignore", stderr: "ignore" });
          running = child;
          return child;
        },
        readiness: async () => {
          for (let attempt = 0; attempt < 60; attempt += 1) {
            try {
              const response = await fetch(`http://127.0.0.1:${port}/`, {
                signal: AbortSignal.timeout(250),
              });
              if (response.status >= 100) return true;
            } catch {
              await new Promise<void>((wake) => setTimeout(wake, 100));
            }
          }
          return false;
        },
      });
      const runtime = createWorkerdRuntime({
        root,
        port,
        isReady: () => supervisor.isReady(),
        onReload: async (configPath) => {
          await supervisor.ensure(configPath);
        },
      });
      return { runtime, supervisor };
    };

    const ask = async (): Promise<string | null> => {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`, {
          headers: { host: HOSTNAME },
          signal: AbortSignal.timeout(1_000),
        });
        return await response.text();
      } catch {
        return null;
      }
    };

    const first = await boot();
    // Nothing published yet, so a boot starts nothing at all.
    expect(await first.runtime.restore()).toEqual([]);
    expect(first.supervisor.isReady()).toBe(false);

    await first.runtime.write(
      "sw-restart",
      {
        directory: "sw-restart",
        mainModule: "index.js",
        hostnames: [HOSTNAME],
        generation: "gen-1",
      },
      new Map([["index.js", new TextEncoder().encode(MODULE)]]),
    );
    await first.runtime.reload();
    expect(await ask()).toBe("served after a restart");

    // The machine goes away, exactly as a `kill` or a reboot takes it away.
    first.supervisor.stop();
    await running?.exited;
    running = undefined;
    expect(await ask()).toBeNull();

    // And comes back over the same data directory, told nothing.
    const second = await boot();
    expect(await second.runtime.restore()).toEqual(["sw-restart"]);
    expect(second.supervisor.isReady()).toBe(true);
    expect(await ask()).toBe("served after a restart");
    // The Host's own observation agrees: this generation really is activated.
    expect(await second.runtime.has("sw-restart", "gen-1")).toBe(true);
  },
  120_000,
);
