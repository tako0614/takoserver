import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";

// Qualification probe, not a Workflow adapter. Held-I/O abort does not prove
// that the supervisor can stop synchronous application code. The outer test
// process bounds this deliberately non-yielding fixture; killing that process
// on failure is cleanup, never evidence of a successful per-execution stop.
const CONFIGURED_WORKERD = process.env.TAKOSERVER_WORKERD_BINARY;
const CPU_ENTERED = "workflow-native-cpu-entered";

const application = `
export class Application {
  constructor(env) { this.env = env; }
  run() {
    console.error(${JSON.stringify(CPU_ENTERED)});
    // No await, timer, I/O, or clock read between the marker and this loop.
    // Workers clocks need not advance while JavaScript runs synchronously.
    for (;;) {}
  }
}
export default { fetch() { return new Response("application"); } };
`;

const bridge = `
import { Application } from "./Workflow.js";
export class Workflow {
  constructor(state, env) {
    this.state = state;
    state.storage.sql.exec("CREATE TABLE IF NOT EXISTS markers (name TEXT PRIMARY KEY)");
    this.application = new Application(Object.freeze({ marker: env.MARKER }));
  }
  fetch(request) {
    if (new URL(request.url).pathname === "/snapshot") {
      return Response.json(this.state.storage.sql.exec("SELECT name FROM markers ORDER BY name").toArray());
    }
    this.state.storage.sql.exec("INSERT INTO markers VALUES ('cpu_entered')");
    try {
      return Response.json(this.application.run());
    } finally {
      this.state.storage.sql.exec("INSERT INTO markers VALUES ('cpu_finally')");
    }
  }
}
export default { fetch() { return new Response("host-private"); } };
`;

const supervisor = `
import { DurableObject } from "cloudflare:workers";
export class Supervisor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.result = "not-started";
    this.pending = undefined;
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS boots (id INTEGER)");
    this.ctx.storage.sql.exec("INSERT INTO boots VALUES (1)");
    this.generation = this.ctx.storage.sql.exec("SELECT COUNT(*) AS count FROM boots").one().count;
  }
  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/ping") return Response.json({ generation: this.generation });
    if (path === "/start") {
      if (this.stub) return new Response("already-started", { status: 409 });
      this.stub = this.ctx.facets.get("execution", () => ({ class: this.env.WORKFLOW }));
      this.result = "pending";
      this.pending = this.stub.fetch("http://facet/run").then(
        () => { this.result = "fulfilled"; },
        error => { this.result = "rejected:" + String(error); },
      );
      this.ctx.waitUntil(this.pending);
      return Response.json({ started: true });
    }
    if (path === "/stop") {
      this.ctx.facets.abort("execution", "workflow-native-stop");
      await this.pending;
      let stale = "fulfilled";
      try { await this.stub.fetch("http://facet/snapshot"); }
      catch (error) { stale = "rejected:" + String(error); }
      return Response.json({ stopped: true, result: this.result, stale });
    }
    if (path === "/snapshot") {
      const replacement = this.ctx.facets.get("execution", () => ({ class: this.env.WORKFLOW }));
      return replacement.fetch("http://facet/snapshot");
    }
    if (path === "/result") return Response.json({ result: this.result });
    return new Response("not found", { status: 404 });
  }
}
export default {
  fetch(request, env) {
    return env.SUPERVISOR.get(env.SUPERVISOR.idFromName("workflow-cpu")).fetch(request);
  },
};
`;

function config(root: string, port: number): string {
  return `using Workerd = import "/workerd/workerd.capnp";
const config :Workerd.Config = (
  services = [
    (name = "supervisor", worker = (
      modules = [(name = "supervisor.mjs", esModule = embed "supervisor.mjs")],
      compatibilityDate = "2026-01-01", compatibilityFlags = ["experimental"],
      globalOutbound = "deny",
      bindings = [
        (name = "SUPERVISOR", durableObjectNamespace = "Supervisor"),
        (name = "WORKFLOW", durableObjectClass = (name = "application", entrypoint = "Workflow")),
      ],
      durableObjectNamespaces = [(className = "Supervisor", uniqueKey = "workflow-cpu-probe", enableSql = true)],
      durableObjectStorage = (localDisk = "storage"),
    )),
    (name = "application", worker = (
      modules = [
        (name = "Workflow.js", esModule = embed "bridge.mjs", role = hostPrivate),
        (name = "Workflow.js", esModule = embed "application.mjs", role = application),
      ],
      modulePolicy = (applicationMain = "Workflow.js"),
      compatibilityDate = "2026-01-01",
      compatibilityFlags = ["experimental", "disallow_importable_env"],
      globalOutbound = "deny",
      bindings = [(name = "MARKER", text = "declared")],
    )),
    (name = "storage", disk = (path = ${JSON.stringify(join(root, "storage"))}, writable = true)),
    (name = "deny", network = (allow = [])),
  ],
  sockets = [(name = "http", address = "127.0.0.1:${port}", http = (), service = "supervisor")],
);`;
}

async function getJson(origin: string, path: string): Promise<unknown> {
  const response = await fetch(origin + path, { signal: AbortSignal.timeout(2_000) });
  expect(response.status).toBe(200);
  return response.json();
}

test.skipIf(CONFIGURED_WORKERD === undefined)(
  "the pinned native facet supervisor can preempt non-yielding Workflow code",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-native-workflow-facets-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    let stderrTask: Promise<void> | undefined;
    try {
      const selected = await selectClosedGraphWorkerd({
        binary: CONFIGURED_WORKERD,
        privateRoot: root,
      });
      expect(selected.diagnostic).toBeNull();
      if (!selected.binary) throw new Error("configured native binary was not selected");
      const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      const port = Number(reserved.port);
      reserved.stop(true);
      await mkdir(join(root, "storage"), { mode: 0o700 });
      for (const [name, source] of Object.entries({
        "application.mjs": application,
        "bridge.mjs": bridge,
        "supervisor.mjs": supervisor,
        "workerd.capnp": config(root, port),
      })) {
        await writeFile(join(root, name), source, { mode: 0o600 });
      }
      const process = Bun.spawn(
        [selected.binary, "serve", "--experimental", join(root, "workerd.capnp")],
        {
          env: {},
          stdout: "ignore",
          stderr: "pipe",
        },
      );
      child = process;
      // Independent of the workerd event loop, including a startup failure.
      watchdog = setTimeout(() => process.kill(9), 8_000);
      let entered = false;
      let markerResolve!: () => void;
      const marker = new Promise<void>((resolve) => {
        markerResolve = resolve;
      });
      stderrTask = (async () => {
        const reader = process.stderr.getReader();
        const decoder = new TextDecoder();
        let tail = "";
        for (;;) {
          const part = await reader.read();
          if (part.done) return;
          const text = decoder.decode(part.value, { stream: true });
          globalThis.process.stderr.write(text);
          tail = (tail + text).slice(-8_192);
          if (!entered && tail.includes(CPU_ENTERED)) {
            entered = true;
            markerResolve();
          }
        }
      })();
      const origin = `http://127.0.0.1:${port}`;
      let before: Record<string, unknown> | undefined;
      const readyUntil = Date.now() + 3_000;
      while (Date.now() < readyUntil && !before) {
        try {
          before = (await getJson(origin, "/ping")) as Record<string, unknown>;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      expect(before).toEqual({ generation: 1 });
      if (!before) throw new Error("native supervisor did not become ready");
      // Do not require /start's response to flush before observing entry: a
      // non-yielding facet may already have blocked the native event loop.
      const started = getJson(origin, "/start").catch(() => undefined);
      await Promise.race([
        marker,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("CPU entry marker missing")), 2_000),
        ),
      ]);
      expect(entered).toBe(true);
      let stopped: Record<string, unknown>;
      try {
        // Complete a separate control round-trip before attempting abort, so
        // success cannot merely race the marker's console host call.
        expect(await getJson(origin, "/result")).toEqual({ result: "pending" });
        stopped = (await getJson(origin, "/stop")) as Record<string, unknown>;
      } catch {
        throw new Error(
          "native facet abort could not acknowledge stop while synchronous application code was executing",
        );
      }
      expect(stopped.stopped).toBe(true);
      expect(String(stopped.result)).toStartWith("rejected:");
      expect(String(stopped.result)).toContain("workflow-native-stop");
      expect(String(stopped.stale)).toStartWith("rejected:");
      expect(String(stopped.stale)).toContain("workflow-native-stop");
      expect(await getJson(origin, "/result")).toEqual({ result: stopped.result });
      expect(await getJson(origin, "/ping")).toEqual(before);
      expect(await getJson(origin, "/snapshot")).toEqual([{ name: "cpu_entered" }]);
      await started;
    } finally {
      if (watchdog !== undefined) clearTimeout(watchdog);
      if (child) {
        child.kill(9);
        await child.exited.catch(() => undefined);
      }
      await stderrTask?.catch(() => undefined);
      await rm(root, { recursive: true, force: true });
    }
  },
  12_000,
);
