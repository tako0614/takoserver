import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";

// This evidence is deliberately opt-in. It runs one upstream native
// WorkerLoader/Facet fixture against the exact Host-selected workerd bytes.
// It is not a portable Actor/Host ABI conformance test. In particular,
// dynamic WorkerCode has no capnp modulePolicy/role fields, so its import
// observations below are reported as a confinement gap rather than as proof
// of the closed application graph.
const CONFIGURED_WORKERD = process.env.TAKOSERVER_WORKERD_BINARY;
const LOADER_GRAPH_LIMITATION =
  "dynamic WorkerLoader has no modulePolicy/roles; import observations are not closed-graph conformance";

const DYNAMIC_FACET_MODULE = (version: "A" | "B"): string => `
import { DurableObject } from "cloudflare:workers";

const CODE_VERSION = ${JSON.stringify(version)};

export class Facet extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.env = env;
    this.version = CODE_VERSION;
    this.ensureTables();
    const rows = this.ctx.storage.sql
      .exec("SELECT value FROM facet_state WHERE name = 'constructor_count'")
      .toArray();
    this.constructorCount = rows.length === 0 ? 1 : Number(rows[0].value) + 1;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO facet_state (name, value) VALUES ('constructor_count', ?)",
      String(this.constructorCount),
    );
  }

  ensureTables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS facet_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  async notify(slot) {
    const url = new URL("http://loopback/facet-event");
    url.searchParams.set("facet", this.ctx.id.toString());
    url.searchParams.set("slot", slot);
    // This is the sole outbound path in the fixture: CONTROL is an explicit
    // loopback service binding, while global outbound is null/denied.
    const response = await this.env.control.fetch(url.toString());
    await response.arrayBuffer();
  }

  stateSnapshot() {
    const rows = this.ctx.storage.sql
      .exec("SELECT name, value FROM facet_state ORDER BY name")
      .toArray();
    return {
      version: this.version,
      envMarker: this.env.marker,
      envKeys: Object.keys(this.env).sort(),
      id: this.ctx.id.toString(),
      constructorCount: this.constructorCount,
      state: Object.fromEntries(rows.map((row) => [String(row.name), String(row.value)])),
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/queue") {
      const slot = url.searchParams.get("slot") ?? "unknown";
      await this.notify(slot);
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO facet_state (name, value) VALUES ('queue_' || ?, 'entered')",
        slot,
      );
      return Response.json({ slot, id: this.ctx.id.toString(), version: this.version });
    }
    if (url.pathname === "/stream") {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO facet_state (name, value) VALUES ('stream_active', 'true')",
      );
      const encoder = new TextEncoder();
      const version = this.version;
      return new Response(
        new ReadableStream({
          start(controller) {
            // Once this chunk is read, the response head/body stream is live;
            // the stream intentionally remains open until the test cancels it.
            controller.enqueue(encoder.encode("head:" + version));
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    }
    if (url.pathname === "/stream-status") {
      return Response.json({
        version: this.version,
        constructorCount: this.constructorCount,
        streamActive:
          this.ctx.storage.sql
            .exec("SELECT value FROM facet_state WHERE name = 'stream_active'")
            .toArray().length > 0,
      });
    }
    if (url.pathname === "/seed") {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO facet_state (name, value) VALUES ('seed', 'from-version-A')",
      );
      return Response.json(this.stateSnapshot());
    }
    if (url.pathname === "/upgrade") {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO facet_state (name, value) VALUES ('seen_' || ?, 'true')",
        this.version,
      );
      return Response.json(this.stateSnapshot());
    }
    if (url.pathname === "/loader") {
      let relativeImport = "allowed";
      try {
        await import("./not-declared-by-loader.mjs");
      } catch (error) {
        relativeImport = String(error).includes("No such module")
          ? "blocked"
          : "error:" + String(error);
      }
      let builtinImport = "blocked";
      try {
        await import("node:process");
        builtinImport = "available";
      } catch (error) {
        builtinImport = String(error).includes("No such module")
          ? "blocked"
          : "error:" + String(error);
      }
      let globalFetch = "blocked";
      try {
        await fetch("http://global-outbound-denied.invalid/");
        globalFetch = "allowed";
      } catch {
        globalFetch = "blocked";
      }
      return Response.json({
        envMarker: this.env.marker,
        envKeys: Object.keys(this.env).sort(),
        relativeImport,
        builtinImport,
        globalFetch,
        limitation: ${JSON.stringify(LOADER_GRAPH_LIMITATION)},
      });
    }
    if (url.pathname === "/state") return Response.json(this.stateSnapshot());
    return new Response("not found", { status: 404 });
  }
}
`;

function capnpText(value: string): string {
  return JSON.stringify(value);
}

function nativeWorkerModule(): string {
  const dynamicA = JSON.stringify(DYNAMIC_FACET_MODULE("A"));
  const dynamicB = JSON.stringify(DYNAMIC_FACET_MODULE("B"));
  return `
import { DurableObject } from "cloudflare:workers";

const DYNAMIC_CODE = { A: ${dynamicA}, B: ${dynamicB} };

export class NativeSupervisor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.facetsByName = new Map();
    this.versionsByName = new Map();
    this.dispatchesByName = new Map();
    this.queueByName = new Map();
  }

  dynamicWorker(version) {
    return this.env.LOADER.get("native-facet-code-" + version, async () => ({
      compatibilityDate: "2026-01-01",
      allowExperimental: true,
      mainModule: "facet.js",
      modules: { "facet.js": DYNAMIC_CODE[version] },
      env: {
        marker: "native-facet-env-" + version,
        version,
        control: this.env.CONTROL,
      },
      // null deliberately denies dynamic global fetch. CONTROL is the only
      // explicit loopback service passed through the RPC-serializable env.
      globalOutbound: null,
    }));
  }

  startupOptions(name, version) {
    const worker = this.dynamicWorker(version);
    return { class: worker.getDurableObjectClass("Facet"), id: "facet:" + name };
  }

  getFacet(name, version) {
    let stub = this.facetsByName.get(name);
    if (stub === undefined || this.versionsByName.get(name) !== version) {
      stub = this.ctx.facets.get(name, () => this.startupOptions(name, version));
      this.facetsByName.set(name, stub);
      this.versionsByName.set(name, version);
    }
    return stub;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/facet") {
      const name = url.searchParams.get("name") ?? "default";
      const version = url.searchParams.get("version") === "B" ? "B" : "A";
      const target = url.searchParams.get("target") ?? "/state";
      return await this.getFacet(name, version).fetch(
        new Request("http://facet.local" + target),
      );
    }
    if (url.pathname === "/queue/dispatch") {
      const name = url.searchParams.get("name") ?? "queue";
      const slot = url.searchParams.get("slot") ?? "unknown";
      const stub = this.getFacet(name, "A");
      const count = (this.dispatchesByName.get(name) ?? 0) + 1;
      this.dispatchesByName.set(name, count);
      const previous = this.queueByName.get(name) ?? Promise.resolve();
      const pending = previous
        .catch(() => undefined)
        .then(() =>
          stub.fetch(
            new Request(
              "http://facet.local/queue?slot=" + encodeURIComponent(slot),
            ),
          ),
        )
        .then(async (response) => {
          await response.arrayBuffer();
        });
      this.queueByName.set(name, pending);
      this.ctx.waitUntil(
        pending,
      );
      return Response.json({ name, slot, dispatchCount: count, queuedId: "facet:" + name });
    }
    if (url.pathname === "/upgrade") {
      const name = url.searchParams.get("name") ?? "upgrade";
      const first = this.getFacet(name, "A");
      const before = await (await first.fetch(new Request("http://facet.local/seed"))).json();
      this.ctx.facets.abort(name, "native-facet-upgrade");
      let staleA = "not-invalidated";
      try {
        await first.fetch(new Request("http://facet.local/state"));
      } catch (error) {
        staleA = String(error);
      }

      this.facetsByName.delete(name);
      this.versionsByName.delete(name);
      const second = this.getFacet(name, "B");
      const middle = await (await second.fetch(new Request("http://facet.local/upgrade"))).json();
      this.ctx.facets.abort(name, "native-facet-upgrade-again");
      let staleB = "not-invalidated";
      try {
        await second.fetch(new Request("http://facet.local/state"));
      } catch (error) {
        staleB = String(error);
      }

      this.facetsByName.delete(name);
      this.versionsByName.delete(name);
      const third = this.getFacet(name, "A");
      const after = await (await third.fetch(new Request("http://facet.local/state"))).json();
      return Response.json({
        before,
        middle,
        after,
        staleA,
        staleB,
        tailFree: true,
        facetId: after.id,
      });
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const id = env.SUPERVISOR.idFromName("native-facets-supervisor");
    return env.SUPERVISOR.get(id).fetch(request);
  },
};
`;
}

function nativeConfig(root: string, port: number, controlPort: number): string {
  const storage = join(root, "facet-storage");
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "native-facets-worker",
      worker = (
        modules = [
          (name = "index.mjs", esModule = embed "index.mjs", role = application),
        ],
        compatibilityDate = "2026-01-01",
        compatibilityFlags = ["experimental"],
        globalOutbound = "native-network-deny",
        bindings = [
          (name = "SUPERVISOR", durableObjectNamespace = "NativeSupervisor"),
          (name = "CONTROL", service = "native-loopback"),
          (name = "LOADER", workerLoader = ()),
        ],
        durableObjectNamespaces = [
          (className = "NativeSupervisor", uniqueKey = "native-facets-supervisor-v1", enableSql = true),
        ],
        durableObjectStorage = (localDisk = "native-facets-storage"),
      ),
    ),
    (
      name = "native-facets-storage",
      disk = (path = ${capnpText(storage)}, writable = true),
    ),
    (name = "native-network-deny", network = (allow = [])),
    (
      name = "native-loopback",
      external = (address = "127.0.0.1:${controlPort}", http = ()),
    ),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${port}", http = (), service = "native-facets-worker"),
  ],
);
`;
}

async function waitForHttp(origin: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/facet?name=health&target=/state`, {
        signal: AbortSignal.timeout(250),
      });
      await response.arrayBuffer();
      if (response.status < 500) return;
    } catch {
      // Workerd has not bound the socket yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`native facets workerd did not become ready at ${origin}`);
}

async function getJson(origin: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(2_000) });
  const body = await response.text();
  expect(response.status).toBe(200);
  return JSON.parse(body) as Record<string, unknown>;
}

function eventKey(slot: string, facet?: string): string {
  return `${facet ?? "*"}\0${slot}`;
}

function waitForEvent(
  events: readonly { readonly facet: string; readonly slot: string }[],
  waiters: Map<string, Array<() => void>>,
  slot: string,
  facet?: string,
): Promise<void> {
  if (
    events.some((event) => event.slot === slot && (facet === undefined || event.facet === facet))
  ) {
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    const key = eventKey(slot, facet);
    const pending = waiters.get(key) ?? [];
    pending.push(resolve);
    waiters.set(key, pending);
  });
}

test.skipIf(CONFIGURED_WORKERD === undefined)(
  "the pinned native WorkerLoader runs deterministic facet queues, streams, and tail-free replacement",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-native-facets-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
    let workerdPort = 0;
    const events: Array<{ facet: string; slot: string }> = [];
    const eventWaiters = new Map<string, Array<() => void>>();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstSeenResolve: (() => void) | undefined;
    const firstSeen = new Promise<void>((resolve) => {
      firstSeenResolve = resolve;
    });
    let control: ReturnType<typeof Bun.serve> | undefined;
    try {
      const selected = await selectClosedGraphWorkerd({
        binary: CONFIGURED_WORKERD,
        privateRoot: root,
      });
      expect(selected.diagnostic).toBeNull();
      if (!selected.binary) {
        throw new Error(selected.diagnostic ?? "the supplied workerd binary was not selected");
      }

      control = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        async fetch(request) {
          const url = new URL(request.url);
          if (url.pathname !== "/facet-event") return new Response("not found", { status: 404 });
          const facet = url.searchParams.get("facet") ?? "";
          const slot = url.searchParams.get("slot") ?? "";
          events.push({ facet, slot });
          for (const key of [eventKey(slot, facet), eventKey(slot)]) {
            const pending = eventWaiters.get(key);
            eventWaiters.delete(key);
            pending?.forEach((resolve) => {
              resolve();
            });
          }
          if (slot === "first") {
            firstSeenResolve?.();
            await firstGate;
          }
          return new Response("ok");
        },
      });
      const controlPort = Number(control.port);
      const reserved = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      });
      workerdPort = Number(reserved.port);
      reserved.stop(true);

      await writeFile(join(root, "index.mjs"), nativeWorkerModule(), {
        encoding: "utf8",
        mode: 0o600,
      });
      await mkdir(join(root, "facet-storage"), { recursive: true, mode: 0o700 });
      const configPath = join(root, "workerd.capnp");
      const config = nativeConfig(root, workerdPort, controlPort);
      expect(config).not.toContain("tails");
      expect(config).not.toContain("streamingTails");
      await writeFile(configPath, config, {
        encoding: "utf8",
        mode: 0o600,
      });

      child = Bun.spawn([selected.binary, "serve", "--experimental", configPath], {
        env: {},
        stdout: "ignore",
        stderr: "inherit",
      });
      const origin = `http://127.0.0.1:${workerdPort}`;
      await waitForHttp(origin);

      const loader = await getJson(origin, "/facet?name=loader&target=/loader&version=A");
      expect(loader.envMarker).toBe("native-facet-env-A");
      expect(loader.envKeys).toEqual(["control", "marker", "version"]);
      expect(loader.relativeImport).toBe("blocked");
      expect(loader.builtinImport).toMatch(/^(blocked|available|error:)/u);
      expect(loader.globalFetch).toBe("blocked");
      expect(loader.limitation).toBe(LOADER_GRAPH_LIMITATION);

      const firstDispatch = await getJson(origin, "/queue/dispatch?name=same&slot=first");
      expect(firstDispatch).toMatchObject({ name: "same", slot: "first", dispatchCount: 1 });
      await Promise.race([
        firstSeen,
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("first facet queue call did not reach loopback gate")),
            2_000,
          ),
        ),
      ]);
      const secondDispatch = await getJson(origin, "/queue/dispatch?name=same&slot=second");
      expect(secondDispatch).toMatchObject({ name: "same", slot: "second", dispatchCount: 2 });
      expect(events.filter((event) => event.facet === "facet:same")).toEqual([
        { facet: "facet:same", slot: "first" },
      ]);
      const otherDispatch = await getJson(origin, "/queue/dispatch?name=other&slot=other");
      expect(otherDispatch).toMatchObject({ name: "other", slot: "other", dispatchCount: 1 });
      await Promise.race([
        waitForEvent(events, eventWaiters, "other", "facet:other"),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("other facet did not proceed while same ID was held")),
            2_000,
          ),
        ),
      ]);
      expect(events.filter((event) => event.facet === "facet:same")).toHaveLength(1);
      releaseFirst?.();
      await Promise.race([
        waitForEvent(events, eventWaiters, "second", "facet:same"),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error("queued same-ID facet call did not run after release")),
            2_000,
          ),
        ),
      ]);

      const streamResponse = await fetch(`${origin}/facet?name=stream&target=/stream&version=A`, {
        signal: AbortSignal.timeout(2_000),
      });
      expect(streamResponse.status).toBe(200);
      const reader = streamResponse.body?.getReader();
      if (!reader) throw new Error("native facet stream did not expose a body reader");
      const firstChunk = await Promise.race([
        reader.read(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("native facet stream head timed out")), 2_000),
        ),
      ]);
      expect(new TextDecoder().decode(firstChunk.value)).toBe("head:A");
      const streamStatus = await getJson(
        origin,
        "/facet?name=stream&target=/stream-status&version=A",
      );
      expect(streamStatus).toMatchObject({ version: "A", streamActive: true, constructorCount: 1 });
      await reader.cancel();

      const upgrade = await getJson(origin, "/upgrade?name=versioned");
      expect(upgrade.tailFree).toBe(true);
      expect(upgrade.staleA).toContain("native-facet-upgrade");
      expect(upgrade.staleB).toContain("native-facet-upgrade-again");
      expect(upgrade.facetId).toBe("facet:versioned");
      const before = upgrade.before as Record<string, unknown>;
      const middle = upgrade.middle as Record<string, unknown>;
      const after = upgrade.after as Record<string, unknown>;
      expect(before).toMatchObject({
        version: "A",
        envMarker: "native-facet-env-A",
        id: "facet:versioned",
      });
      expect(middle).toMatchObject({
        version: "B",
        envMarker: "native-facet-env-B",
        id: "facet:versioned",
      });
      expect(after).toMatchObject({
        version: "A",
        envMarker: "native-facet-env-A",
        id: "facet:versioned",
      });
      expect((after.state as Record<string, unknown>).seed).toBe("from-version-A");
      expect((after.state as Record<string, unknown>).seen_B).toBe("true");
      expect(Number(after.constructorCount)).toBeGreaterThan(Number(before.constructorCount));
      expect(Number(middle.constructorCount)).toBeGreaterThan(Number(before.constructorCount));
    } finally {
      control?.stop(true);
      if (child) {
        child.kill(9);
        await child.exited.catch(() => undefined);
      }
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
