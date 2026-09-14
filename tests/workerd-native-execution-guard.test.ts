import { expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { createWorkerdExecutionGuard } from "../src/workerd-execution-guard.ts";

const workerd = process.env.TAKOSERVER_WORKERD_BINARY;
const guardBinary = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;

const application = `export default { fetch(request) {
  if (new URL(request.url).pathname === "/cpu") { for (;;) {} }
  return new Response("healthy");
} };`;

function config(port: number): string {
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "application", worker = (
      modules = [(name = "app.mjs", esModule = embed "app.mjs")],
      compatibilityDate = "2026-01-01", globalOutbound = "deny",
    )),
    (name = "deny", network = (allow = [])),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "application")],
);`;
}

async function until(probe: () => Promise<boolean>, timeout = 2_000): Promise<void> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await probe()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("native execution guard condition timed out");
}

async function processState(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return { state: fields[0], ticks: Number(fields[11]) + Number(fields[12]), birth: fields[19] };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Read-only diagnostics of this fixture's known guard; PIDs are never used to signal a process. */
async function childPids(pid: number): Promise<number[]> {
  const found = new Set<number>();
  for (const task of await readdir(`/proc/${pid}/task`)) {
    try {
      const children = await readFile(`/proc/${pid}/task/${task}/children`, "utf8");
      for (const child of children.trim().split(/\s+/u)) if (child) found.add(Number(child));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...found];
}

test.skipIf(workerd === undefined || guardBinary === undefined)(
  "native process guard stops CPU work, fences deadlines and survives controller/guard loss without killing a sibling",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-native-execution-guard-"));
    const processes: ReturnType<typeof Bun.spawn>[] = [];
    const requests: AbortController[] = [];
    // Outer cleanup is only fixture hygiene, never a successful guard ACK.
    const watchdog = setTimeout(() => {
      for (const process of processes) process.kill("SIGKILL");
    }, 22_000);
    try {
      const selected = await selectClosedGraphWorkerd({
        binary: workerd,
        privateRoot: join(root, "artifact"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "no pinned workerd");
      const binary = selected.binary;
      await writeFile(join(root, "app.mjs"), application, { mode: 0o600 });
      async function configuration(name: string) {
        const reservation = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: () => new Response(),
        });
        const port = reservation.port;
        reservation.stop(true);
        const path = join(root, `${name}.capnp`);
        await writeFile(path, config(Number(port)), { mode: 0o600 });
        return { path, url: `http://127.0.0.1:${port}` };
      }
      async function healthy(url: string): Promise<boolean> {
        try {
          const response = await fetch(url, { signal: AbortSignal.timeout(150) });
          return (await response.text()) === "healthy";
        } catch {
          return false;
        }
      }
      function open(lease: number) {
        let process!: Subprocess<"pipe", "pipe", "ignore">;
        const guard = createWorkerdExecutionGuard({
          registration: {
            identity: "b".repeat(64),
            deadlineAt: Date.now() + 15_000,
            until: Date.now() + lease,
          },
          commandTimeoutMs: 2_000,
          spawn: () => {
            process = Bun.spawn([guardBinary as string, "--workerd-binary", binary], {
              stdin: "pipe",
              stdout: "pipe",
              stderr: "ignore",
              env: {},
            });
            processes.push(process);
            return {
              stdout: process.stdout,
              exited: process.exited,
              write: async (frame) => {
                process.stdin.write(frame);
                await process.stdin.flush();
              },
              end: () => {
                process.stdin.end();
              },
              kill: () => {
                process.kill("SIGKILL");
              },
            };
          },
        });
        return { guard, process };
      }

      const siblingConfig = await configuration("sibling");
      const sibling = Bun.spawn([binary, "serve", siblingConfig.path], {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "ignore",
        env: {},
      });
      processes.push(sibling);
      await until(() => healthy(siblingConfig.url));

      const paused = open(5_000);
      await paused.guard.registered;
      expect(await childPids(paused.process.pid)).toEqual([]);
      await paused.guard.stop();
      await expect(paused.guard.start(join(root, "must-not-run.capnp"))).rejects.toThrow("stopped");
      await paused.process.exited;

      for (const mode of ["stop", "deadline", "controller-eof", "guard-loss"] as const) {
        const target = await configuration(mode);
        const run = open(mode === "deadline" ? 2_000 : 6_000);
        await run.guard.registered;
        await run.guard.start(target.path);
        await until(() => healthy(target.url));
        const children = await childPids(run.process.pid);
        expect(children).toHaveLength(1);
        const pid = children[0] as number;
        const before = await processState(pid);
        if (!before) throw new Error("workerd disappeared before CPU invocation");
        const controller = new AbortController();
        requests.push(controller);
        let settled = false;
        const pending = fetch(`${target.url}/cpu`, { signal: controller.signal })
          .catch(() => undefined)
          .finally(() => {
            settled = true;
          });
        // Prove CPU progress in the exact child, not merely a request sent by the controller.
        await until(async () => {
          const state = await processState(pid);
          return (
            state !== undefined && state.birth === before.birth && state.ticks >= before.ticks + 5
          );
        });
        expect(settled).toBe(false);
        expect(await healthy(siblingConfig.url)).toBe(true);
        if (mode === "stop") {
          await run.guard.stop();
          const after = await processState(pid);
          // ACK is after reap; a subsequently reused PID is not the same child.
          expect(!after || after.birth !== before.birth).toBe(true);
          await expect(run.guard.extendDeadline(Date.now() + 1_000)).rejects.toThrow("stopped");
        } else if (mode === "controller-eof") {
          run.process.stdin.end();
        } else if (mode === "guard-loss") {
          run.process.kill("SIGKILL");
        }
        await until(async () => {
          const state = await processState(pid);
          // After guard death the init/subreaper owns reap. A zombie cannot execute.
          return !state || state.birth !== before.birth || state.state === "Z";
        }, 3_000);
        expect(await healthy(siblingConfig.url)).toBe(true);
        controller.abort();
        await pending;
        // Non-ACK shutdowns remain failure, even though the independent probe proved no execution.
        if (mode !== "stop") await expect(run.guard.stop()).rejects.toThrow();
        await run.process.exited;
      }
    } finally {
      clearTimeout(watchdog);
      for (const request of requests) request.abort();
      for (const process of processes) process.kill("SIGKILL");
      await Promise.all(processes.map((process) => process.exited.catch(() => undefined)));
      await rm(root, { recursive: true, force: true });
    }
  },
  25_000,
);
