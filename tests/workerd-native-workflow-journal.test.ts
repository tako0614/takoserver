import { expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";
import { createWorkerdExecutionGuard } from "../src/workerd-execution-guard.ts";
import { createWorkflowTransportJournal } from "../src/workflow-transport-journal.ts";

const workerd = process.env.TAKOSERVER_WORKERD_BINARY;
const guardBinary = process.env.TAKOSERVER_WORKFLOW_EXECUTION_GUARD_BINARY;

async function until(probe: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("native Workflow journal condition timed out");
}

async function processState(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(") ") + 2).split(" ");
    return { birth: fields[19], ticks: Number(fields[11]) + Number(fields[12]) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Diagnostics only: all signals use owned subprocess handles, never a discovered PID. */
async function childPids(pid: number): Promise<number[]> {
  const children = new Set<number>();
  for (const task of await readdir(`/proc/${pid}/task`)) {
    try {
      const value = await readFile(`/proc/${pid}/task/${task}/children`, "utf8");
      for (const child of value.trim().split(/\s+/u)) if (child) children.add(Number(child));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [...children];
}

test.skipIf(workerd === undefined || guardBinary === undefined)(
  "native guarded journal precedes CPU-stop ACK and refuses an undelivered companion",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-native-workflow-journal-"));
    const processes: ReturnType<typeof Bun.spawn>[] = [];
    const requests: AbortController[] = [];
    const servers: ReturnType<typeof Bun.serve>[] = [];
    const watchdog = setTimeout(() => {
      for (const child of processes) child.kill("SIGKILL");
    }, 18_000);
    try {
      const selected = await selectClosedGraphWorkerd({
        binary: workerd,
        privateRoot: join(root, "artifact"),
      });
      if (!selected.binary) throw new Error(selected.diagnostic ?? "no pinned workerd");
      const binary = selected.binary;
      for (const deliver of [true, false]) {
        // Private fixture correlation nonce, unrelated to any operator credential.
        const token = randomBytes(32).toString("hex");
        const dispatched: Array<{ sequence: number; payload: string }> = [];
        const journal = createWorkflowTransportJournal({
          dispatch(sequence, payload) {
            dispatched.push({ sequence, payload });
          },
        });
        const markers: number[] = [];
        const companion = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          async fetch(request) {
            if (request.method !== "POST" || new URL(request.url).pathname !== `/${token}`) {
              return new Response(null, { status: 404 });
            }
            journal.recordPayload(1, await request.text());
            return new Response("latched");
          },
        });
        servers.push(companion);
        const reservation = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch: () => new Response(),
        });
        const port = reservation.port;
        reservation.stop(true);
        // Capture before tenant evaluation. The nonce lives in a private module
        // closure, not in the body of the function visible to the application.
        await writeFile(
          join(root, "prelude.mjs"),
          `
const logger = console.error;
const receiver = console;
const apply = Reflect.apply;
const token = ${JSON.stringify(token)};
export function emit(sequence) {
  apply(logger, receiver, ["TAKOSERVER_WORKFLOW_JOURNAL:" + token + ":" + sequence]);
}
`,
          { mode: 0o600 },
        );
        await writeFile(
          join(root, "tenant.mjs"),
          `
console.error = () => { throw new Error("replaced console"); };
Reflect.apply = () => { throw new Error("replaced Reflect"); };
export function spin() { for (;;) {} }
`,
          { mode: 0o600 },
        );
        await writeFile(
          join(root, "entry.mjs"),
          `
import { emit } from "./prelude.mjs";
import { spin } from "./tenant.mjs";
export default { async fetch(request, env) {
  if (new URL(request.url).pathname !== "/cpu") return new Response("healthy");
  emit(1);
  ${deliver ? `await env.COMPANION.fetch("http://companion/${token}", { method: "POST", body: "bounded-payload" });` : ""}
  spin();
} };
`,
          { mode: 0o600 },
        );
        const configPath = join(root, "run.capnp");
        await writeFile(
          configPath,
          `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "application", worker = (
      modules = [
        (name = "entry.mjs", esModule = embed "entry.mjs"),
        (name = "prelude.mjs", esModule = embed "prelude.mjs"),
        (name = "tenant.mjs", esModule = embed "tenant.mjs"),
      ],
      compatibilityDate = "2026-01-01", globalOutbound = "deny",
      bindings = [(name = "COMPANION", service = "companion")],
    )),
    (name = "companion", external = (address = "127.0.0.1:${companion.port}", http = ())),
    (name = "deny", network = (allow = [])),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "application")],
);`,
          { mode: 0o600 },
        );
        const child = Bun.spawn([guardBinary as string, "--workerd-binary", binary], {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
          env: {},
        });
        processes.push(child);
        const guard = createWorkerdExecutionGuard({
          registration: {
            identity: "c".repeat(64),
            deadlineAt: Date.now() + 12_000,
            until: Date.now() + 8_000,
            journalToken: token,
          },
          commandTimeoutMs: 2_000,
          onJournalMarker(sequence) {
            journal.recordMarker(sequence);
            markers.push(sequence);
          },
          spawn: () => ({
            stdout: child.stdout,
            exited: child.exited,
            async write(frame) {
              child.stdin.write(frame);
              await child.stdin.flush();
            },
            end() {
              child.stdin.end();
            },
            kill() {
              child.kill("SIGKILL");
            },
          }),
        });
        await guard.registered;
        await guard.start(configPath);
        const url = `http://127.0.0.1:${port}`;
        await until(async () => {
          try {
            return (
              (await (await fetch(url, { signal: AbortSignal.timeout(150) })).text()) === "healthy"
            );
          } catch {
            return false;
          }
        });
        const pids = await childPids(child.pid);
        expect(pids).toHaveLength(1);
        const pid = pids[0] as number;
        const before = await processState(pid);
        if (!before) throw new Error("workerd disappeared before invocation");
        const controller = new AbortController();
        requests.push(controller);
        let settled = false;
        const pending = fetch(`${url}/cpu`, { signal: controller.signal })
          .catch(() => undefined)
          .finally(() => {
            settled = true;
          });
        // Deliberately do NOT wait for a marker before STOP. In the withheld
        // case, marker emission is immediately followed by non-yielding JS.
        // Exact child CPU progress proves that the captured logger returned.
        await until(async () => {
          const current = await processState(pid);
          return (
            current !== undefined &&
            current.birth === before.birth &&
            current.ticks >= before.ticks + 5
          );
        });
        const spinning = await processState(pid);
        if (!spinning || spinning.birth !== before.birth)
          throw new Error("workerd disappeared during CPU probe");
        // A separate interval of continued CPU progress excludes a one-shot
        // request/setup spike. Neither observation depends on marker delivery.
        await until(async () => {
          const current = await processState(pid);
          return (
            current !== undefined &&
            current.birth === before.birth &&
            current.ticks >= spinning.ticks + 5
          );
        });
        expect(settled).toBe(false);
        await guard.stop();
        const after = await processState(pid);
        expect(!after || after.birth !== before.birth).toBe(true);
        expect(markers).toEqual([1]);
        if (deliver) {
          // The application awaited the response, so the ingress handler has
          // finished latching its frame before entering CPU work.
          expect(() => journal.seal()).not.toThrow();
          expect(dispatched).toEqual([{ sequence: 1, payload: "bounded-payload" }]);
        } else {
          expect(() => journal.seal()).toThrow();
          expect(() => journal.recordPayload(1, "too-late")).toThrow();
          expect(dispatched).toEqual([]);
        }
        controller.abort();
        await pending;
        await child.exited;
        companion.stop(true);
      }
    } finally {
      clearTimeout(watchdog);
      for (const request of requests) request.abort();
      for (const server of servers) server.stop(true);
      for (const child of processes) child.kill("SIGKILL");
      await Promise.all(processes.map((child) => child.exited.catch(() => undefined)));
      await rm(root, { recursive: true, force: true });
    }
  },
  20_000,
);
