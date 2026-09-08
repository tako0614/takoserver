import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";

// This evidence is deliberately opt-in. The package workerd is not the pinned
// artifact that production serving is allowed to execute.
// It probes the upstream native ABI, not Takoform Actor conformance. The same-socket
// idle reconstruction check proves one hibernation path, not code-update continuity
// or multi-instance coordination.
const CONFIGURED_WORKERD = process.env.TAKOSERVER_WORKERD_BINARY;

const NATIVE_PROBE_MODULE = `export class NativeProbe {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.state.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS probe_meta (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const rows = this.state.storage.sql
      .exec("SELECT value FROM probe_meta WHERE name = 'constructor'")
      .toArray();
    const previous = rows.length === 0 ? 0 : Number(rows[0].value);
    this.generation = previous + 1;
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO probe_meta (name, value) VALUES ('constructor', '" +
        this.generation +
        "')",
    );
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/health") return new Response("ok");
    if (path === "/write") {
      this.state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS probe_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO probe_state (name, value) VALUES ('persisted', 'from-first-process')",
      );
      return Response.json({ written: true });
    }
    if (path === "/kv-write") {
      await this.state.storage.kv.put("host-metadata", "host-private-kv-v1");
      const table = this.nativeKvTable();
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO probe_meta (name, value) VALUES ('kv_table', ?)",
        table,
      );
      const access = this.inspectNativeKvSql(table);
      return Response.json({ table, ...access });
    }
    if (path === "/kv-read") {
      const rows = this.state.storage.sql
        .exec("SELECT value FROM probe_meta WHERE name = 'kv_table'")
        .toArray();
      const table = rows.length === 0 ? "" : String(rows[0].value);
      if (!table || !this.nativeKvTableNames().includes(table)) {
        throw new Error("native KV table identity was not retained: " + table);
      }
      const access = this.inspectNativeKvSql(table);
      const marker = await this.state.storage.kv.get("host-metadata");
      return Response.json({ table, marker: marker ?? null, ...access });
    }
    if (path === "/read" || path === "/status") {
      const rows = this.state.storage.sql
        .exec("SELECT name, value FROM probe_state ORDER BY name")
        .toArray();
      return Response.json(
        Object.fromEntries(rows.map((row) => [String(row.name), String(row.value)])),
      );
    }
    if (path === "/identity") {
      return Response.json({ id: this.state.id.toString() });
    }
    if (path === "/arm") {
      const pending = new URL(request.url).searchParams.get("pending") === "true";
      const dueAt = Date.now() + (pending ? 2_000 : 25);
      this.state.storage.sql.exec(
        "CREATE TABLE IF NOT EXISTS probe_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
      );
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO probe_state (name, value) VALUES ('next_alarm', ?)",
        pending ? "pending-restart" : "first",
      );
      if (pending) {
        this.state.storage.sql.exec(
          "INSERT OR REPLACE INTO probe_state (name, value) VALUES ('pending_alarm', 'pending')",
        );
      }
      await this.state.storage.setAlarm(dueAt);
      return pending ? Response.json({ armed: true, pending: true, dueAt }) : Response.json({ armed: true });
    }
    if (path === "/socket") {
      const pair = new WebSocketPair();
      pair[1].serializeAttachment({ marker: "native-attachment-v1" });
      this.state.acceptWebSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    return new Response("not found", { status: 404 });
  }

  async alarm() {
    const rows = this.state.storage.sql
      .exec("SELECT value FROM probe_state WHERE name = 'next_alarm'")
      .toArray();
    const kind = rows.length === 0 ? "" : String(rows[0].value);
    if (kind === "pending-restart") {
      this.state.storage.sql.exec(
        "UPDATE probe_state SET value = 'delivered' WHERE name = 'pending_alarm'",
      );
    } else {
      this.state.storage.sql.exec(
        "INSERT OR REPLACE INTO probe_state (name, value) VALUES ('alarm', 'delivered')",
      );
    }
    this.state.storage.sql.exec(
      "DELETE FROM probe_state WHERE name = 'next_alarm'",
    );
  }

  nativeKvTableNames() {
    return this.state.storage.sql
      .exec("SELECT name FROM sqlite_schema WHERE type = 'table'")
      .toArray()
      .map((row) => String(row.name));
  }

  nativeKvTable() {
    const candidates = this.nativeKvTableNames().filter((name) => name.toLowerCase().includes("kv"));
    if (candidates.length !== 1) {
      throw new Error(
        "native KV table was not uniquely exposed by sqlite_schema: " + JSON.stringify(candidates),
      );
    }
    return candidates[0];
  }

  inspectNativeKvSql(table) {
    const quoted = '"' + table.replaceAll('"', '""') + '"';
    let select = "allowed";
    try {
      this.state.storage.sql.exec("SELECT * FROM " + quoted + " LIMIT 1").toArray();
    } catch (error) {
      select = "denied:" + (error instanceof Error ? error.name : String(error));
    }
    let mutation = "allowed";
    try {
      this.state.storage.sql.exec("DELETE FROM " + quoted);
    } catch (error) {
      mutation = "denied:" + (error instanceof Error ? error.name : String(error));
    }
    return {
      marker: this.state.storage.kv.get("host-metadata") ?? null,
      select,
      mutation,
    };
  }

  webSocketMessage(socket, message) {
    const attachment = socket.deserializeAttachment();
    const marker = attachment?.marker === "native-attachment-v1" ? attachment.marker : "missing";
    if (message === "generation") {
      socket.send("generation:" + this.generation + ":" + marker);
      return;
    }
    socket.send(typeof message === "string" ? "echo:" + message : message);
  }
}

export default {
  async fetch(request, env) {
    const id = env.NATIVE_PROBE.idFromName("stable-native-probe");
    return env.NATIVE_PROBE.get(id).fetch(request);
  },
};
`;

function capnpText(value: string): string {
  return JSON.stringify(value);
}

function nativeConfig(root: string, port: number): string {
  const storage = join(root, "do-storage");
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "native-worker",
      worker = (
        modules = [
          (name = "index.mjs", esModule = embed "index.mjs", role = application),
        ],
        compatibilityDate = "2026-01-01",
        modulePolicy = (applicationMain = "index.mjs"),
        globalOutbound = "native-network-deny",
        bindings = [
          (name = "NATIVE_PROBE", durableObjectNamespace = "NativeProbe"),
        ],
        durableObjectNamespaces = [
          (className = "NativeProbe", uniqueKey = "native-probe-namespace-v1", enableSql = true),
        ],
        durableObjectStorage = (localDisk = "native-do-storage"),
      ),
    ),
    (
      name = "native-do-storage",
      disk = (path = ${capnpText(storage)}, writable = true),
    ),
    (name = "native-network-deny", network = (allow = [])),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${port}", http = (), service = "native-worker"),
  ],
);
`;
}

async function waitForHttp(origin: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(250) });
      await response.arrayBuffer();
      if (response.status < 500) return;
    } catch {
      // The socket is not listening yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`native workerd did not become ready at ${origin}`);
}

async function getJson(origin: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(1_500) });
  const body = await response.text();
  expect(response.status).toBe(200);
  return JSON.parse(body) as Record<string, unknown>;
}

async function waitForAlarm(origin: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await getJson(origin, "/status");
    if (state.alarm === "delivered") return state;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("native Durable Object alarm was not delivered");
}

async function waitForPendingAlarm(origin: string): Promise<Record<string, unknown>> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const state = await getJson(origin, "/status");
    if (state.pending_alarm === "delivered") return state;
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("native Durable Object restart-pending alarm was not delivered");
}

async function exchangeWebSocketAcrossIdle(
  origin: string,
  idleMs: number,
): Promise<{
  readonly echo: string;
  readonly generationBefore: string;
  readonly generationAfter: string;
}> {
  const socket = new WebSocket(`${origin.replace(/^http:/u, "ws:")}/socket`);
  const pending: Array<{
    readonly resolve: (value: string) => void;
    readonly reject: (error: Error) => void;
  }> = [];
  let rejectOpen: (error: Error) => void = () => undefined;
  const opened = new Promise<void>((resolve, reject) => {
    rejectOpen = reject;
    const timer = setTimeout(() => reject(new Error("native WebSocket open timed out")), 3_000);
    socket.onopen = () => {
      clearTimeout(timer);
      resolve();
    };
  });
  const fail = (error: Error): void => {
    rejectOpen(error);
    while (pending.length > 0) pending.shift()?.reject(error);
  };
  socket.onerror = () => fail(new Error("native WebSocket connection failed"));
  socket.onclose = () => fail(new Error("native WebSocket closed before its reply"));
  socket.onmessage = (event) => pending.shift()?.resolve(String(event.data));
  const receive = (): Promise<string> =>
    new Promise<string>((resolve, reject) => {
      let waiter: {
        readonly resolve: (value: string) => void;
        readonly reject: (error: Error) => void;
      };
      const timer = setTimeout(() => {
        const index = pending.indexOf(waiter);
        if (index >= 0) pending.splice(index, 1);
        reject(new Error("native WebSocket reply timed out"));
      }, 3_000);
      waiter = {
        resolve(value) {
          clearTimeout(timer);
          resolve(value);
        },
        reject(error) {
          clearTimeout(timer);
          reject(error);
        },
      };
      pending.push(waiter);
    });

  try {
    await opened;
    socket.send("native-echo");
    const echo = await receive();
    socket.send("generation");
    const generationBefore = await receive();
    await new Promise<void>((resolve) => setTimeout(resolve, idleMs));
    socket.send("generation");
    const generationAfter = await receive();
    return { echo, generationBefore, generationAfter };
  } finally {
    try {
      socket.close();
    } catch {
      // The runtime may already have closed the socket after delivering data.
    }
  }
}

function generation(value: string): { readonly value: number; readonly marker: string } {
  const match = /^generation:(\d+):(.+)$/u.exec(value);
  if (!match) throw new Error(`unexpected native WebSocket generation reply: ${value}`);
  return { value: Number(match[1]), marker: match[2] as string };
}

test.skipIf(CONFIGURED_WORKERD === undefined)(
  "the pinned native workerd runs a Durable Object through restart, alarm, SQL, and WebSocket paths",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-native-do-capabilities-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let port = 0;
    try {
      const selected = await selectClosedGraphWorkerd({
        binary: CONFIGURED_WORKERD,
        privateRoot: root,
      });
      expect(selected.diagnostic).toBeNull();
      if (!selected.binary) {
        throw new Error(selected.diagnostic ?? "the supplied workerd binary was not selected");
      }

      const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
      port = Number(reserved.port);
      reserved.stop(true);
      await writeFile(join(root, "index.mjs"), NATIVE_PROBE_MODULE, {
        encoding: "utf8",
        mode: 0o600,
      });
      await mkdir(join(root, "do-storage"), { recursive: true, mode: 0o700 });
      const configPath = join(root, "workerd.capnp");
      await writeFile(configPath, nativeConfig(root, port), { encoding: "utf8", mode: 0o600 });

      const start = async (): Promise<void> => {
        child = Bun.spawn([selected.binary as string, "serve", configPath], {
          env: {},
          stdout: "ignore",
          stderr: "inherit",
        });
        await waitForHttp(`http://127.0.0.1:${port}`);
      };
      const stop = async (): Promise<void> => {
        const current = child;
        child = undefined;
        if (!current) return;
        current.kill(9);
        await current.exited.catch(() => undefined);
      };

      const origin = `http://127.0.0.1:${port}`;
      await start();
      expect(await getJson(origin, "/write")).toEqual({ written: true });
      const kvBeforeRestart = await getJson(origin, "/kv-write");
      expect(kvBeforeRestart.marker).toBe("host-private-kv-v1");
      expect(typeof kvBeforeRestart.table).toBe("string");
      expect(String(kvBeforeRestart.select)).toMatch(/^denied:/u);
      expect(String(kvBeforeRestart.mutation)).toMatch(/^denied:/u);
      const identityBeforeRestart = (await getJson(origin, "/identity")).id;
      expect(typeof identityBeforeRestart).toBe("string");
      expect(await getJson(origin, "/arm")).toEqual({ armed: true });
      expect(await waitForAlarm(origin)).toMatchObject({ alarm: "delivered" });
      const webSocket = await exchangeWebSocketAcrossIdle(origin, 12_000);
      expect(webSocket.echo).toBe("echo:native-echo");
      const generationBefore = generation(webSocket.generationBefore);
      const generationAfter = generation(webSocket.generationAfter);
      expect(generationBefore.marker).toBe("native-attachment-v1");
      expect(generationAfter.marker).toBe("native-attachment-v1");
      if (generationAfter.value <= generationBefore.value) {
        throw new Error(
          `native Durable Object hibernation unobserved after 12s idle (generation ${generationBefore.value})`,
        );
      }

      const pendingAlarm = await getJson(origin, "/arm?pending=true");
      const dueAt = Number(pendingAlarm.dueAt);
      expect(pendingAlarm).toMatchObject({ armed: true, pending: true });
      expect(dueAt - Date.now()).toBeGreaterThan(1_000);
      expect((await getJson(origin, "/status")).pending_alarm).toBe("pending");
      const stopRequestedAt = Date.now();
      await stop();
      const stoppedAt = Date.now();
      expect(stopRequestedAt).toBeLessThan(dueAt);
      expect(stoppedAt).toBeLessThan(dueAt);
      await start();
      expect(await waitForPendingAlarm(origin)).toMatchObject({ pending_alarm: "delivered" });
      const kvAfterRestart = await getJson(origin, "/kv-read");
      expect(kvAfterRestart.marker).toBe("host-private-kv-v1");
      expect(kvAfterRestart.table).toBe(kvBeforeRestart.table);
      expect(String(kvAfterRestart.select)).toMatch(/^denied:/u);
      expect(String(kvAfterRestart.mutation)).toMatch(/^denied:/u);
      expect(await getJson(origin, "/read")).toEqual({
        alarm: "delivered",
        pending_alarm: "delivered",
        persisted: "from-first-process",
      });
      expect((await getJson(origin, "/identity")).id).toBe(identityBeforeRestart);
      await stop();
    } finally {
      if (child) {
        child.kill(9);
        await child.exited.catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
