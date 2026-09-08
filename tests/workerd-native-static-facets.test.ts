import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { selectClosedGraphWorkerd } from "../src/workerd-artifact.ts";

// This is an opt-in native feasibility fixture. It runs the exact Host-selected
// workerd bytes and exercises static facet classes; it is not a portable Actor
// ABI or a production Host wrapper. The host-private module is deliberately the
// only class entrypoint and constructs a fixture-only application context.
const CONFIGURED_WORKERD = process.env.TAKOSERVER_WORKERD_BINARY;
const STATIC_VERSION_A = "A" as const;
const STATIC_VERSION_B = "B" as const;
type StaticVersion = typeof STATIC_VERSION_A | typeof STATIC_VERSION_B;

function capnpText(value: string): string {
  return JSON.stringify(value);
}

function applicationModule(version: StaticVersion): string {
  const codeMarker = `static-app-source-${version}-v1`;
  return `
import { DECLARED_MARKER } from "./declared.js";

const CODE_VERSION = ${JSON.stringify(version)};
const CODE_MARKER = ${JSON.stringify(codeMarker)};

function classifyImport(error) {
  const message = String(error);
  return /No such module|not found|disallow|denied|blocked|unsupported|cannot/i.test(message)
    ? "blocked"
    : "error:" + message;
}

async function probeImport(loader) {
  try {
    await loader();
    return "allowed";
  } catch (error) {
    return classifyImport(error);
  }
}

export class NativeBridge {
  constructor(ctx, env) {
    // This class is a fixture-only plain application object. Its context is
    // intentionally assembled by the host-private wrapper, not a portable ABI.
    this.ctx = ctx;
    this.env = env;
    this.version = CODE_VERSION;
    this.ensureTables();
    const rows = this.ctx.storage.sql
      .exec("SELECT value FROM static_state WHERE name = 'constructor_count'")
      .toArray();
    this.generation = rows.length === 0 ? 1 : Number(rows[0].value) + 1;
    this.ctx.storage.sql.exec(
      "INSERT OR REPLACE INTO static_state (name, value) VALUES ('constructor_count', ?)",
      String(this.generation),
    );
  }

  ensureTables() {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS static_state (name TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
  }

  state() {
    const rows = this.ctx.storage.sql
      .exec("SELECT name, value FROM static_state ORDER BY name")
      .toArray();
    return Object.fromEntries(rows.map((row) => [String(row.name), String(row.value)]));
  }

  async probe() {
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
    return {
      cloudflareWorkers: await probeImport(() => import("cloudflare:workers")),
      workerdUnsafe: await probeImport(() => import("workerd:unsafe")),
      hostPrivate: await probeImport(() => import("./host-only.js")),
      undeclaredRelative: await probeImport(() => import("./undeclared.js")),
      evaluatedCloudflareWorkers: await probeImport(() => eval('import("cloudflare:workers")')),
      functionWorkerdUnsafe: await probeImport(() => Function('return import("workerd:unsafe")')()),
      asyncFunctionHostPrivate: await probeImport(() =>
        AsyncFunction('return import("./host-only.js")')(),
      ),
    };
  }

  snapshot() {
    return {
      version: this.version,
      codeMarker: CODE_MARKER,
      envMarker: this.env.marker,
      hostPrivateMarker: this.env.hostPrivateMarker,
      envKeys: Object.keys(this.env).sort(),
      id: this.ctx.id.toString(),
      generation: this.generation,
      declaredModule: DECLARED_MARKER,
      state: this.state(),
    };
  }

  async fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/seed") {
      this.ctx.storage.sql.exec(
        "INSERT OR IGNORE INTO static_state (name, value) VALUES ('seed', 'from-version-A')",
      );
      return Response.json(this.snapshot());
    }
    if (path === "/mark") {
      this.ctx.storage.sql.exec(
        "INSERT OR REPLACE INTO static_state (name, value) VALUES ('seen_' || ?, 'true')",
        this.version,
      );
      return Response.json(this.snapshot());
    }
    if (path === "/probe") return Response.json({ ...this.snapshot(), imports: await this.probe() });
    if (path === "/snapshot") return Response.json(this.snapshot());
    return new Response("not found", { status: 404 });
  }
}

export default { fetch() { return new Response("application"); } };
`;
}

function hostPrivateModule(): string {
  return `
import { NativeBridge as ApplicationBridge } from "./NativeBridge.js";
import { HOST_PRIVATE_MARKER } from "./host-only.js";

// This legacy-shaped class is fixture-only: the static facet probe needs only
// a constructor(state, env) and fetch(), not the portable DurableObject base.
export class NativeBridge {
  constructor(state, env) {
    // Fixture-only context: this is not a portable Actor constructor contract.
    const fixtureContext = { id: state.id, storage: state.storage };
    const declaredEnv = Object.freeze({
      marker: env.MARKER,
      version: env.VERSION,
      hostPrivateMarker: HOST_PRIVATE_MARKER,
    });
    this.application = new ApplicationBridge(fixtureContext, declaredEnv);
    void HOST_PRIVATE_MARKER;
  }

  fetch(request) {
    return this.application.fetch(request);
  }
}

export default { fetch() { return new Response("host-private"); } };
`;
}

function hostOnlyModule(version: StaticVersion): string {
  return `export const HOST_PRIVATE_MARKER = ${JSON.stringify(`host-only-${version}`)};`;
}

function declaredModule(version: StaticVersion): string {
  return `export const DECLARED_MARKER = ${JSON.stringify(`declared-application-${version}`)};`;
}

function supervisorModule(): string {
  return `
import { DurableObject } from "cloudflare:workers";

export class StaticSupervisor extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.facets = new Map();
    this.versions = new Map();
  }

  facet(name, version) {
    const existing = this.facets.get(name);
    if (existing !== undefined && this.versions.get(name) === version) return existing;
    if (existing !== undefined) this.ctx.facets.abort(name, "static-version-switch");
    const klass = version === "B" ? this.env.VERSION_B : this.env.VERSION_A;
    const stub = this.ctx.facets.get(name, () => ({ class: klass, id: "facet:" + name }));
    this.facets.set(name, stub);
    this.versions.set(name, version);
    return stub;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/facet") {
      const name = url.searchParams.get("name") ?? "default";
      const version = url.searchParams.get("version") === "B" ? "B" : "A";
      const target = url.searchParams.get("target") ?? "/snapshot";
      return this.facet(name, version).fetch(new Request("http://facet.local" + target));
    }
    if (url.pathname === "/replace") {
      const name = url.searchParams.get("name") ?? "versioned";
      const first = this.facet(name, "A");
      const before = await (await first.fetch(new Request("http://facet.local/seed"))).json();
      this.ctx.facets.abort(name, "static-version-switch");
      let staleA = "not-invalidated";
      try {
        await first.fetch(new Request("http://facet.local/snapshot"));
      } catch (error) {
        staleA = String(error);
      }
      this.facets.delete(name);
      this.versions.delete(name);

      const second = this.facet(name, "B");
      const middle = await (await second.fetch(new Request("http://facet.local/mark"))).json();
      this.ctx.facets.abort(name, "static-version-switch-again");
      let staleB = "not-invalidated";
      try {
        await second.fetch(new Request("http://facet.local/snapshot"));
      } catch (error) {
        staleB = String(error);
      }
      this.facets.delete(name);
      this.versions.delete(name);

      const third = this.facet(name, "A");
      const after = await (await third.fetch(new Request("http://facet.local/snapshot"))).json();
      return Response.json({ before, middle, after, staleA, staleB, facetId: after.id });
    }
    return new Response("not found", { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const id = env.SUPERVISOR.idFromName("static-facets-supervisor");
    return env.SUPERVISOR.get(id).fetch(request);
  },
};
`;
}

async function writeVersionFiles(root: string, version: StaticVersion): Promise<void> {
  const directory = join(root, `version-${version.toLowerCase()}`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await Promise.all([
    writeFile(join(directory, "host-private.mjs"), hostPrivateModule(), {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(join(directory, "application.mjs"), applicationModule(version), {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(join(directory, "host-only.mjs"), hostOnlyModule(version), {
      encoding: "utf8",
      mode: 0o600,
    }),
    writeFile(join(directory, "declared.mjs"), declaredModule(version), {
      encoding: "utf8",
      mode: 0o600,
    }),
  ]);
}

function versionWorker(version: StaticVersion): string {
  const directory = `version-${version.toLowerCase()}`;
  return `
    (
      name = "version-${version.toLowerCase()}",
      worker = (
        modules = [
          (name = "NativeBridge.js", esModule = embed ${capnpText(`${directory}/host-private.mjs`)}, role = hostPrivate),
          (name = "NativeBridge.js", esModule = embed ${capnpText(`${directory}/application.mjs`)}, role = application),
          (name = "host-only.js", esModule = embed ${capnpText(`${directory}/host-only.mjs`)}, role = hostPrivate),
          (name = "declared.js", esModule = embed ${capnpText(`${directory}/declared.mjs`)}, role = application),
        ],
        modulePolicy = (applicationMain = "NativeBridge.js"),
        compatibilityDate = "2026-01-01",
        compatibilityFlags = ["experimental", "disallow_importable_env"],
        globalOutbound = "static-network-deny",
        bindings = [
          (name = "MARKER", text = "static-facet-env-${version}"),
          (name = "VERSION", text = "${version}"),
        ],
      ),
    ),`;
}

function nativeConfig(root: string, port: number): string {
  const storage = join(root, "static-facets-storage");
  return `using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (
      name = "static-supervisor",
      worker = (
        modules = [
          (name = "supervisor.mjs", esModule = embed "supervisor.mjs", role = application),
        ],
        compatibilityDate = "2026-01-01",
        compatibilityFlags = ["experimental"],
        globalOutbound = "static-network-deny",
        bindings = [
          (name = "SUPERVISOR", durableObjectNamespace = "StaticSupervisor"),
          (name = "VERSION_A", durableObjectClass = (name = "version-a", entrypoint = "NativeBridge")),
          (name = "VERSION_B", durableObjectClass = (name = "version-b", entrypoint = "NativeBridge")),
        ],
        durableObjectNamespaces = [
          (className = "StaticSupervisor", uniqueKey = "static-facets-supervisor-v1", enableSql = true),
        ],
        durableObjectStorage = (localDisk = "static-facets-storage"),
      ),
    ),
${versionWorker(STATIC_VERSION_A)}
${versionWorker(STATIC_VERSION_B)}
    (name = "static-facets-storage", disk = (path = ${capnpText(storage)}, writable = true)),
    (name = "static-network-deny", network = (allow = [])),
  ],
  sockets = [
    (name = "http", address = "127.0.0.1:${port}", http = (), service = "static-supervisor"),
  ],
);
`;
}

async function waitForHttp(origin: string, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${origin}/facet?name=health&target=/snapshot`, {
        signal: AbortSignal.timeout(250),
      });
      await response.arrayBuffer();
      if (response.status < 500) return;
    } catch {
      // Workerd has not bound the socket yet.
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`static facet workerd did not become ready at ${origin}`);
}

async function getJson(origin: string, path: string): Promise<Record<string, unknown>> {
  const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(2_000) });
  const body = await response.text();
  expect(response.status).toBe(200);
  return JSON.parse(body) as Record<string, unknown>;
}

test.skipIf(CONFIGURED_WORKERD === undefined)(
  "the pinned native workerd runs static closed-graph facets through A-B-A replacement",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "takoserver-native-static-facets-"));
    let child: ReturnType<typeof Bun.spawn> | undefined;
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

      const reserved = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch: () => new Response(),
      });
      const port = Number(reserved.port);
      reserved.stop(true);
      await writeFile(join(root, "supervisor.mjs"), supervisorModule(), {
        encoding: "utf8",
        mode: 0o600,
      });
      await writeVersionFiles(root, STATIC_VERSION_A);
      await writeVersionFiles(root, STATIC_VERSION_B);
      await mkdir(join(root, "static-facets-storage"), { recursive: true, mode: 0o700 });
      const configPath = join(root, "workerd.capnp");
      const config = nativeConfig(root, port);
      expect(config).not.toContain("workerLoader");
      expect(config).not.toContain("tails");
      expect(config).not.toContain("streamingTails");
      expect(config).toContain(
        '(name = "VERSION_A", durableObjectClass = (name = "version-a", entrypoint = "NativeBridge"))',
      );
      expect(config).toContain(
        '(name = "VERSION_B", durableObjectClass = (name = "version-b", entrypoint = "NativeBridge"))',
      );
      expect(config).toContain('modulePolicy = (applicationMain = "NativeBridge.js")');
      expect(config).toContain("role = hostPrivate");
      expect(config).toContain("role = application");
      await writeFile(configPath, config, { encoding: "utf8", mode: 0o600 });

      child = Bun.spawn([selected.binary, "serve", "--experimental", configPath], {
        env: {},
        stdout: "ignore",
        stderr: "inherit",
      });
      const origin = `http://127.0.0.1:${port}`;
      await waitForHttp(origin);

      const probe = await getJson(origin, "/facet?name=imports&version=A&target=/probe");
      expect(probe.version).toBe("A");
      expect(probe.codeMarker).toBe("static-app-source-A-v1");
      expect(probe.envMarker).toBe("static-facet-env-A");
      expect(probe.envKeys).toEqual(["hostPrivateMarker", "marker", "version"]);
      expect(probe.id).toBe("facet:imports");
      expect(probe.declaredModule).toBe("declared-application-A");
      expect((probe.imports as Record<string, unknown>).cloudflareWorkers).toBe("blocked");
      expect((probe.imports as Record<string, unknown>).workerdUnsafe).toBe("blocked");
      expect((probe.imports as Record<string, unknown>).hostPrivate).toBe("blocked");
      expect((probe.imports as Record<string, unknown>).undeclaredRelative).toBe("blocked");
      expect((probe.imports as Record<string, unknown>).evaluatedCloudflareWorkers).toBe("blocked");
      expect((probe.imports as Record<string, unknown>).functionWorkerdUnsafe).toBe("blocked");
      expect((probe.imports as Record<string, unknown>).asyncFunctionHostPrivate).toBe("blocked");
      expect(probe.hostPrivateMarker).toBe("host-only-A");

      const replacement = await getJson(origin, "/replace?name=versioned");
      expect(replacement.facetId).toBe("facet:versioned");
      expect(replacement.staleA).toContain("static-version-switch");
      expect(replacement.staleB).toContain("static-version-switch-again");
      const before = replacement.before as Record<string, unknown>;
      const middle = replacement.middle as Record<string, unknown>;
      const after = replacement.after as Record<string, unknown>;
      expect(before).toMatchObject({
        version: "A",
        codeMarker: "static-app-source-A-v1",
        envMarker: "static-facet-env-A",
        id: "facet:versioned",
        declaredModule: "declared-application-A",
      });
      expect(middle).toMatchObject({
        version: "B",
        codeMarker: "static-app-source-B-v1",
        envMarker: "static-facet-env-B",
        id: "facet:versioned",
        declaredModule: "declared-application-B",
      });
      expect(after).toMatchObject({
        version: "A",
        codeMarker: "static-app-source-A-v1",
        envMarker: "static-facet-env-A",
        id: "facet:versioned",
        declaredModule: "declared-application-A",
      });
      expect((after.state as Record<string, unknown>).seed).toBe("from-version-A");
      expect((after.state as Record<string, unknown>).seen_B).toBe("true");
      expect(Number(middle.generation)).toBeGreaterThan(Number(before.generation));
      expect(Number(after.generation)).toBeGreaterThan(Number(middle.generation));
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
