import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import {
  SELFHOST_WORKER_DATA_SERVICE_MODULE,
  selfhostDataServiceSource,
} from "../src/providers/selfhost-data-service.ts";
import {
  SELFHOST_DATA_PLANE_PROTOCOL,
  SELFHOST_DATA_PLANE_SQL_PATH,
  SELFHOST_WORKER_DATA_TOKEN_BINDING,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { serveSelfhostDataPlanes } from "../src/selfhost-data-planes.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { createWorkerdSupervisor } from "../src/workerd-supervisor.ts";

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

// A restart must prove the binary Takoserver is allowed to serve with, not the
// legacy package runtime that the production selector deliberately rejects.
const WORKERD = process.env.TAKOSERVER_WORKERD_BINARY ?? null;
const HOSTNAME = "restart.localhost";
const MODULE = `export default {
  async fetch(request, env) {
    return env.__TAKOSERVER_SELFHOST_DATA.fetch("http://data.internal${SELFHOST_DATA_PLANE_SQL_PATH}", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: ${JSON.stringify(SELFHOST_DATA_PLANE_PROTOCOL)}, binding: "DB", op: "execute", statement: { sql: "SELECT 42 AS answer" } }),
    });
  },
};
`;

let root: string;
let running: { kill(): void; readonly exited?: Promise<number> } | undefined;
let plane: ReturnType<typeof serveSelfhostDataPlanes> | undefined;
let retiredListener: ReturnType<typeof Bun.serve> | undefined;

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
  plane?.stop(true);
  plane = undefined;
  retiredListener?.stop(true);
  retiredListener = undefined;
  if (root) rmSync(root, { recursive: true, force: true });
});

test.skipIf(WORKERD === null)(
  "a restarted self-host serves the Workers it already published, with no new publication",
  async () => {
    const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = Number(reserved.port);
    reserved.stop(true);

    const sql = createEphemeralSql();
    const startPlane = () =>
      serveSelfhostDataPlanes({
        sql,
        grant: async (script, versionId) =>
          script === "sw1" && versionId === "v1"
            ? {
                secret: "restart-plane-secret-0",
                kv: {},
                sql: { DB: "restart-db" },
                queue: {},
                objects: {},
              }
            : null,
        databasePath: (name) => join(root, "databases", `${name}.sqlite`),
        objectRoot: join(root, "objects"),
      });
    plane = startPlane();
    const originalAddress = plane.address;
    const boot = async (dataPlaneAddress: string) => {
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
        dataPlaneAddress,
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

    const first = await boot(originalAddress);
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
        dataPlane: {
          address: originalAddress,
          module: SELFHOST_WORKER_DATA_SERVICE_MODULE,
          vars: [
            {
              name: SELFHOST_WORKER_DATA_TOKEN_BINDING,
              value: "sw1.v1.restart-plane-secret-0",
              kind: "text",
            },
          ],
        },
      },
      new Map([["index.js", new TextEncoder().encode(MODULE)]]),
      undefined,
      new Map([
        [
          SELFHOST_WORKER_DATA_SERVICE_MODULE,
          new TextEncoder().encode(selfhostDataServiceSource()),
        ],
      ]),
    );
    await first.runtime.reload();
    const expected = { ok: true, value: { rows: [{ answer: 42 }], rowsWritten: 0 } };
    expect(JSON.parse((await ask()) ?? "null")).toEqual(expected);

    // The machine goes away, exactly as a `kill` or a reboot takes it away.
    first.supervisor.stop();
    await running?.exited;
    running = undefined;
    expect(await ask()).toBeNull();
    plane.stop(true);
    let staleCalls = 0;
    retiredListener = Bun.serve({
      hostname: "127.0.0.1",
      port: Number(originalAddress.split(":")[1]),
      fetch() {
        staleCalls++;
        return new Response("retired listener", { status: 503 });
      },
    });
    plane = startPlane();
    expect(plane.address).not.toBe(originalAddress);

    // And comes back over the same data directory, told nothing.
    const second = await boot(plane.address);
    expect(await second.runtime.restore()).toEqual(["sw-restart"]);
    expect(second.supervisor.isReady()).toBe(true);
    expect(JSON.parse((await ask()) ?? "null")).toEqual(expected);
    expect(staleCalls).toBe(0);
    // The Host's own observation agrees: this generation really is activated.
    expect(await second.runtime.has("sw-restart", "gen-1")).toBe(true);
  },
  120_000,
);
