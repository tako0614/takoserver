import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import type { JsonObject } from "../src/ports.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { EDGE_OBJECTS_BINDING_REF } from "../src/providers/cloudflare-runtime-bindings.ts";
import {
  createSelfhostDataPlaneAccess,
  createSelfhostEventTargets,
  createSelfhostProvider,
} from "../src/providers/selfhost.ts";
import { SELFHOST_EDGE_OBJECTS_MATERIAL_KIND } from "../src/providers/selfhost-runtime-bindings.ts";
import { SELFHOST_WORKER_PRELUDE_MODULE } from "../src/providers/selfhost-worker-prelude.ts";
import { serveSelfhostDataPlanes } from "../src/selfhost-data-planes.ts";
import { createSelfhostObjectStore } from "../src/selfhost-object-store.ts";
import { createSelfhostQueuePump } from "../src/selfhost-queue-pump.ts";
import { createSelfhostWorkerScheduler } from "../src/selfhost-scheduler.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";

/**
 * The whole self-hosted lane, end to end, with nothing simulated.
 *
 * A real Worker Version is materialized and published, a real workerd process
 * loads the generated configuration, and the tenant's own module calls `env.KV`
 * and `env.DB`. What that proves — and what no unit test can — is that workerd
 * resolves the generated entrypoint's import of the tenant module, that its
 * `externalServer` binding actually reaches this process, and that the facade's
 * bytes survive the round trip in both directions.
 *
 * It is worth stating why the data planes are reached through a service binding
 * rather than an ordinary `fetch`: workerd's default outbound network refuses
 * loopback with `connect() blocked by restrictPeers()`, so a Worker cannot call
 * this process by URL at all. The binding is not a convenience.
 */

const EDGE_API = "edge.forms.takoform.com/v1beta1";
const KV_NAMESPACE = "tskv-e2e-cache";
const SQLITE_DATABASE = "tsdb-e2e-app";
const SQLITE_NATIVE_ID = `selfhost-sqlite:${SQLITE_DATABASE}:op_db`;
const SQLITE_PATH_SEGMENT = `databases/${SQLITE_DATABASE}.sqlite`;
const NOTES_MIGRATION_SQL = new TextEncoder().encode(
  "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
);
const NOTES_MIGRATION = {
  path: "0001-notes.sql",
  digest: `sha256:${createHash("sha256").update(NOTES_MIGRATION_SQL).digest("hex")}` as const,
  sql: NOTES_MIGRATION_SQL,
};
const HOSTNAME = "e2e.localhost";
const SERVICE_CALLER_HOSTNAME = "service-binding.localhost";
const MODULE_WORKER_SERVICE_BINDING_REF = {
  apiVersion: "bindings.takoform.com/v1alpha2",
  name: "module-worker.service",
  version: "1.0.0",
  schemaDigest: "sha256:79c3a23e506ffc4607ea2921e3dbe76c7d44b20c76e6181e65c611239b9c51aa",
} as const;
// This suite is serving evidence only for the pinned native runtime. Falling
// back to the npm workerd would exercise the known-open resolver instead.
const WORKERD = process.env.TAKOSERVER_WORKERD_BINARY ?? null;

const TENANT_MODULE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/kv") {
      await env.KV.put("greeting", "hello from kv", {
        expirationTtlSeconds: 300,
        metadata: { kind: "probe" },
      });
      await env.KV.put("greeting-2", "second");
      const found = await env.KV.getWithMetadata("greeting");
      const listed = await env.KV.list({ prefix: "greeting" });
      await env.KV.delete("greeting-2");
      const gone = await env.KV.get("greeting-2");
      return Response.json({
        value: new TextDecoder().decode(found.value),
        metadata: found.metadata,
        keys: listed.keys.map((key) => key.name),
        listComplete: listed.listComplete,
        deleted: gone === null,
      });
    }
    if (url.pathname === "/sql") {
      const written = await env.DB.execute(
        "INSERT INTO notes (id, body) VALUES (?, ?)",
        [1, "written through the facade"],
      );
      const read = await env.DB.query("SELECT id, body FROM notes WHERE id = ?", [1]);
      const batched = await env.DB.transaction([
        { sql: "INSERT INTO notes (id, body) VALUES (?, ?)", params: [2, "two"] },
        { sql: "INSERT INTO notes (id, body) VALUES (?, ?)", params: [3, "three"] },
      ]);
      const all = await env.DB.query("SELECT id FROM notes ORDER BY id");
      return Response.json({ written, read, batched, all });
    }
    if (url.pathname === "/rollback") {
      try {
        await env.DB.transaction([
          { sql: "INSERT INTO notes (id, body) VALUES (?, ?)", params: [9, "nine"] },
          { sql: "INSERT INTO notes (id, body) VALUES (?, ?)", params: [1, "duplicate"] },
        ]);
      } catch (error) {
        const after = await env.DB.query("SELECT id FROM notes WHERE id = 9");
        return Response.json({ refused: error.name, rows: after.rows });
      }
      return Response.json({ refused: "none" });
    }
    if (url.pathname === "/smuggle") {
      // The exposure this lane was built wrong for: a binding belongs to the
      // service it is declared on, and workerd hands every one of them to
      // every module that service runs. Reading the projected env never
      // showed that; this does.
      let importable = null;
      try {
        const module = await import("cloudflare:workers");
        importable = {
          keys: Object.keys(module.env ?? {}).sort(),
          token: (module.env ?? {}).__TAKOSERVER_SELFHOST_DATA_TOKEN ?? null,
          service: typeof (module.env ?? {}).__TAKOSERVER_SELFHOST_DATA,
        };
      } catch (error) {
        importable = { error: String(error && error.name) };
      }
      return Response.json({
        importable,
        handlerToken: env.__TAKOSERVER_SELFHOST_DATA_TOKEN ?? null,
        handlerService: typeof env.__TAKOSERVER_SELFHOST_DATA,
      });
    }
    if (url.pathname === "/attach") {
      const attempts = {};
      for (const [name, sql, params] of [
        ["attachLiteral", "ATTACH DATABASE '" + url.searchParams.get("victim") + "' AS victim", []],
        ["attachParam", "ATTACH DATABASE ? AS victim", [url.searchParams.get("victim")]],
        ["attachControl", "ATTACH DATABASE ? AS control", [url.searchParams.get("control")]],
        ["databaseList", "PRAGMA database_list", []],
        ["vacuumInto", "VACUUM INTO ?", [url.searchParams.get("spill")]],
        ["dropLedger", "DROP TABLE IF EXISTS _takoform_sqlite_migrations", []],
        ["selectLedger", "SELECT * FROM _takoform_sqlite_migrations", []],
        ["multiStatement", "SELECT 1; ATTACH DATABASE ? AS victim", [url.searchParams.get("victim")]],
        ["begin", "BEGIN IMMEDIATE", []],
        ["commit", "COMMIT", []],
        ["savepoint", "SAVEPOINT s1", []],
        ["analyze", "ANALYZE", []],
        ["detach", "DETACH DATABASE victim", []],
      ]) {
        try {
          await env.DB.execute(sql, params);
          attempts[name] = "allowed";
        } catch (error) {
          attempts[name] = error.name;
        }
      }
      return Response.json(attempts);
    }
    if (url.pathname === "/query-writes") {
      await env.DB.execute("INSERT OR REPLACE INTO notes (id, body) VALUES (7, 'seven')");
      const through = await env.DB.query("DELETE FROM notes WHERE id = 7");
      const after = await env.DB.query("SELECT count(*) AS n FROM notes WHERE id = 7");
      return Response.json({ through, after });
    }
    return Response.json({ lane: env.LANE, secret: typeof env.__TAKOSERVER_SELFHOST_DATA });
  },
};
`;

const STARTUP_CLOSED_GRAPH_MODULE = `const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const attempts = {
  relative: () => import("./undeclared.js"),
  cloudflare: () => import("cloudflare:workers"),
  node: () => import("node:process"),
  workerd: () => import("workerd:unsafe"),
  eval: () => eval('import("cloudflare:sockets")'),
  Function: () => Function('return import("node:process")')(),
  AsyncFunction: () => AsyncFunction('return import("workerd:unsafe")')(),
};
const captures = Object.entries(attempts).map(([name, attempt]) => {
  try {
    return [name, Promise.resolve(attempt()).then(
      () => "resolved",
      (error) => String(error).includes("No such module") ? "module_not_found" : String(error),
    )];
  } catch (error) {
    return [name, Promise.resolve(
      String(error).includes("No such module") ? "module_not_found" : String(error),
    )];
  }
});
export default {
  async fetch() {
    const refusals = {};
    for (const [name, capture] of captures) refusals[name] = await capture;
    return Response.json(refusals);
  },
};
`;

interface BootGraphModule {
  readonly name: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly digest?: string;
}

/**
 * A complete import graph whose names deliberately do not describe their
 * media. The map passed to the Host is the only source of truth: the `.txt`
 * file is JavaScript, while the `.js` files are text and binary data.
 */
const COMPLETE_GRAPH_MODULE = `import { graphValues } from "./helper.txt";

let getterReads = 0;
export default {
  get fetch() {
    getterReads += 1;
    return async () => Response.json({ ...graphValues(), getterReads });
  },
};
`;

const COMPLETE_GRAPH_ADDITIONAL_MODULES: readonly BootGraphModule[] = [
  {
    name: "helper.txt",
    mediaType: "application/javascript+module",
    bytes: new TextEncoder().encode(`import message from "./message.js";
import payload from "./payload.js";
import wasm from "./empty.wasm";

export function graphValues() {
  return {
    helperLoaded: true,
    text: message,
    dataIsArrayBuffer: payload instanceof ArrayBuffer,
    data: Array.from(new Uint8Array(payload)),
    wasmIsModule: wasm instanceof WebAssembly.Module,
  };
}
`),
  },
  {
    name: "message.js",
    mediaType: "text/plain",
    bytes: new TextEncoder().encode("portable graph text"),
  },
  {
    name: "payload.js",
    mediaType: "application/octet-stream",
    bytes: new Uint8Array([0, 1, 2, 255]),
  },
  {
    name: "empty.wasm",
    mediaType: "application/wasm",
    bytes: new Uint8Array([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00]),
  },
  {
    // This is intentionally not JavaScript. The semantic verifier admits it as
    // auxiliary evidence, and publication must not put it in workerd's module
    // registry where an import could evaluate it.
    name: "index.js.map",
    mediaType: "application/source-map+json",
    bytes: new TextEncoder().encode("this is intentionally not JavaScript"),
  },
];

function offering(kind: string): ProviderOffering {
  return {
    id: `selfhost.edge.${kind.toLowerCase()}`,
    kind: `takoform.${kind}`,
    displayName: kind,
    form: {
      apiVersion: EDGE_API,
      kind,
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "delete", "import", "observe"],
  };
}

function relation(
  pointer: string,
  kind: string,
  name: string,
  spec: Record<string, unknown> = {},
): ProviderRelation {
  return {
    pointer,
    relation: pointer.replace(/\/[0-9]+\//gu, "/*/"),
    targetUid: `uid-${kind}-${name}`,
    resource: {
      apiVersion: EDGE_API,
      kind,
      form: {
        formRef: {
          apiVersion: EDGE_API,
          kind,
          definitionVersion: "0.1.0",
          schemaDigest: `sha256:${"a".repeat(64)}`,
        },
      },
      metadata: {
        name,
        space: "default",
        uid: `uid-${kind}-${name}`,
        generation: "1",
        revision: "1",
      },
      spec: spec as never,
    },
  };
}

function deployed(
  pointer: string,
  kind: string,
  name: string,
  nativeId: string,
  outputs: Record<string, unknown>,
  spec: Record<string, unknown> = {},
): ProviderRelation {
  const base = relation(pointer, kind, name, spec);
  return {
    ...base,
    deployment: {
      tenantId: "org_demo",
      id: `dep-${name}`,
      resourceUid: base.targetUid,
      offeringId: `selfhost.edge.${kind.toLowerCase()}`,
      providerPackRef: "local.pack",
      providerInstallationRef: "local.primary",
      nativeId,
      state: "active",
      observed: {},
      outputs: outputs as never,
      createdAt: "2026-09-02T00:00:00.000Z",
      updatedAt: "2026-09-02T00:00:00.000Z",
    },
  };
}

const identity = (name: string) => ({ tenantRef: "org_demo", space: "default", name });

let root: string;
let planeServer: { stop(closeActive?: boolean): void } | undefined;
let workerd: ReturnType<typeof Bun.spawn> | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-e2e-"));
});

afterEach(async () => {
  if (workerd) {
    // Waited out rather than merely signalled. A 150 MB runtime still holding
    // its socket — and still reading a configuration whose directory is about
    // to be removed — while the next file starts one of its own is how a suite
    // becomes flaky for reasons that have nothing to do with what it proves.
    workerd.kill();
    await workerd.exited;
    workerd = undefined;
  }
  planeServer?.stop(true);
  planeServer = undefined;
  rmSync(root, { recursive: true, force: true });
});

async function reachable(url: string, attempts = 80): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await fetch(url, { signal: AbortSignal.timeout(250) });
      return true;
    } catch {
      await new Promise<void>((wake) => setTimeout(wake, 50));
    }
  }
  return false;
}

/** Publishes the fixture Worker and boots workerd in front of the real planes. */
async function boot(
  tenantModule: string = TENANT_MODULE,
  /**
   * Whether workerd watches its configuration while the test publishes.
   *
   * Off by default, and deliberately: every reload a watching workerd notices
   * starts another copy of a 150 MB runtime, inside a suite that runs beside
   * every other workerd-backed test in this repository. A test that publishes
   * once and then asks questions does not need it — it starts the runtime after
   * the publication. A test that publishes *while* the runtime is up asks.
   */
  watchConfig = false,
  additionalModules: readonly BootGraphModule[] = [],
  mainModule = "index.js",
): Promise<{
  readonly origin: string;
  readonly local: ReturnType<typeof createSelfhostProvider>;
  readonly planeOrigin: string;
  readonly runtime: ReturnType<typeof createWorkerdRuntime>;
}> {
  const graphModules = additionalModules.map((entry, index) => ({
    ...entry,
    digest: entry.digest ?? `sha256:graph-${index}`,
  }));
  const indexBytes = new TextEncoder().encode(tenantModule);
  const moduleBlobs = new Map<string, Uint8Array>([
    ["sha256:index.js", indexBytes],
    ...graphModules.map((entry) => [entry.digest, entry.bytes] as const),
  ]);
  const workerManifestModules = [
    ...(additionalModules.length === 0
      ? [{ name: mainModule, digest: "sha256:index.js" }]
      : [
          {
            name: mainModule,
            digest: "sha256:index.js",
            mediaType: "application/javascript+module",
          },
        ]),
    ...graphModules.map(({ name, digest, mediaType }) => ({ name, digest, mediaType })),
  ];
  const sql = createEphemeralSql();
  const access = createSelfhostDataPlaneAccess(root);
  const served = serveSelfhostDataPlanes({
    sql,
    grant: (script, versionId) => access.grant(script, versionId),
    databasePath: (name) => access.databasePath(name),
    objectRoot: join(root, "selfhost", "objects"),
  });
  planeServer = served;
  const dataPlaneAddress = served.address;

  // workerd binds a socket named in its configuration, so the port has to be
  // chosen before it starts. Asking the kernel for a free one and handing it
  // straight over is the closest thing to `port: 0` available here.
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const workerdPort = Number(reserved.port);
  reserved.stop(true);
  expect(Number.isSafeInteger(workerdPort)).toBe(true);
  const origin = `http://127.0.0.1:${workerdPort}`;
  // Started once, exactly as the supervisor starts it in the real entry: with
  // `--watch` it notices a rewritten configuration itself, and the readiness
  // probe waits for the one this publication wrote rather than for whichever
  // one workerd still served.
  const start = async (): Promise<void> => {
    if (workerd) return;
    workerd = Bun.spawn(
      [
        WORKERD as string,
        "serve",
        ...(watchConfig ? ["--watch"] : []),
        join(root, "workers", "workerd.capnp"),
      ],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await reachable(`${origin}/`)).toBe(true);
  };
  const runtime = createWorkerdRuntime({
    root,
    binary: WORKERD,
    port: workerdPort,
    isReady: () => true,
    ...(watchConfig ? { onReload: start } : {}),
  });
  const local = createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    dataPlaneAddress,
    suffixes: ["localhost"],
    artifacts: {
      async manifest(_tenant, digest) {
        if (digest === "sha256:worker") {
          return {
            kind: "WorkerBundle",
            mainModule,
            modules: workerManifestModules,
          };
        }
        // A second bundle whose module cannot load at all, used to prove the
        // load probe runs for a Worker that binds nothing.
        return digest === "sha256:unloadable"
          ? {
              kind: "WorkerBundle",
              mainModule: "unloadable.js",
              modules: [{ name: "unloadable.js", digest: "sha256:unloadable.js" }],
            }
          : null;
      },
      async blob(digest) {
        const graphBlob = moduleBlobs.get(digest);
        if (graphBlob) return new Uint8Array(graphBlob);
        return digest === "sha256:unloadable.js"
          ? new TextEncoder().encode(UNLOADABLE_MODULE)
          : null;
      },
    },
  });
  const sqlitePath = join(root, SQLITE_PATH_SEGMENT);

  const worker = await local.apply({
    operationId: "op_worker",
    offering: offering("ModuleWorker"),
    identity: identity("hello"),
    spec: {},
  });
  expect(worker.phase).toBe("succeeded");

  const sqliteMigrations = local.sqliteMigrations;
  if (!sqliteMigrations) throw new Error("the selfhost provider must execute SQLite migrations");
  expect(
    await sqliteMigrations.applySuffix({
      operationId: "op_db_migration",
      operationMode: "initial",
      nativeId: SQLITE_NATIVE_ID,
      target: {
        resourceUid: "uid-SQLiteDatabase-app",
        incarnationId: "dep-app",
        generation: "1",
      },
      desired: [NOTES_MIGRATION],
      expectedPrefix: [],
      migrations: [NOTES_MIGRATION],
    }),
  ).toEqual({ ok: true, value: undefined });
  expect(statSync(join(root, "databases")).mode & 0o777).toBe(0o700);
  expect(statSync(sqlitePath).mode & 0o777).toBe(0o600);

  const version = await local.apply({
    operationId: "op_version",
    offering: offering("WorkerVersion"),
    identity: identity("hello-v1"),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      vars: { LANE: "takoform-v1" },
      kvBindings: [
        { name: "KV", resource: { apiVersion: EDGE_API, kind: "EdgeKVNamespace", name: "cache" } },
      ],
      sqliteBindings: [
        { name: "DB", resource: { apiVersion: EDGE_API, kind: "SQLiteDatabase", name: "app" } },
      ],
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      deployed(
        "/kvBindings/0/resource",
        "EdgeKVNamespace",
        "cache",
        `selfhost-kv:${KV_NAMESPACE}:op_kv`,
        { namespaceId: KV_NAMESPACE },
      ),
      deployed("/sqliteBindings/0/resource", "SQLiteDatabase", "app", SQLITE_NATIVE_ID, {
        engine: "sqlite",
        path: sqlitePath,
      }),
    ],
  });
  expect(version.phase).toBe("succeeded");

  const deployment = await local.apply({
    operationId: "op_deploy",
    offering: offering("WorkerDeployment"),
    identity: identity("hello-live"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      versions: [
        {
          workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "hello-v1" },
          weight: 10_000,
        },
      ],
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/versions/0/workerVersion", "WorkerVersion", "hello-v1"),
    ],
  });
  expect(deployment.phase).toBe("succeeded");

  const endpoint = await local.apply({
    operationId: "op_endpoint",
    offering: offering("WorkerEndpoint"),
    identity: identity("hello-endpoint"),
    spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
    relations: [relation("/worker", "ModuleWorker", "hello")],
    workerEndpointOriginAssignment: {
      canonicalPublicOrigin: `https://${HOSTNAME}`,
      assignmentDigest: `sha256:${"e".repeat(64)}`,
    },
  });
  expect(endpoint.phase).toBe("succeeded");

  await start();
  return { origin, local, planeOrigin: `http://${served.address}`, runtime };
}

const ask = (origin: string, path: string) =>
  fetch(`${origin}${path}`, { headers: { host: HOSTNAME } });

test.skipIf(WORKERD === null)(
  "a tenant main named exactly like the Host prelude serves across a runtime restart",
  async () => {
    const { origin } = await boot(
      `export default {
  async fetch() { return new Response("tenant prelude spelling"); },
};`,
      false,
      [],
      SELFHOST_WORKER_PRELUDE_MODULE,
    );
    expect(await (await ask(origin, "/")).text()).toBe("tenant prelude spelling");

    workerd?.kill();
    await workerd?.exited;
    workerd = Bun.spawn([WORKERD as string, "serve", join(root, "workers", "workerd.capnp")], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await reachable(`${origin}/`)).toBe(true);
    expect(await (await ask(origin, "/after-restart")).text()).toBe("tenant prelude spelling");
  },
  60_000,
);

/** Sends the request-target byte spelling without a client URL normalization pass. */
function rawAsk(
  origin: string,
  target: string,
): Promise<{ readonly status: number; readonly body: string }> {
  const endpoint = new URL(origin);
  return new Promise((resolvePromise, reject) => {
    const request = httpRequest(
      {
        hostname: endpoint.hostname,
        port: endpoint.port,
        method: "GET",
        path: target,
        headers: { host: HOSTNAME, connection: "close" },
      },
      (response) => {
        const chunks: Uint8Array[] = [];
        response.on("data", (chunk: Uint8Array) => chunks.push(new Uint8Array(chunk)));
        response.on("end", () => {
          resolvePromise({
            status: response.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

/** A module workerd refuses to load, for exactly the reason it names. */
const UNLOADABLE_MODULE = `import "node:path";

export default {
  async fetch() {
    return new Response("unreachable");
  },
};
`;

/**
 * The handler access order is observable because worker.runtime accepts own
 * accessors and promises to capture each result once. The semantic inspector
 * and the serving wrapper must therefore read the same properties in the same
 * order, or a Version can pass one phase and be refused by the other.
 */
const ORDER_SENSITIVE_HANDLER_MODULE = `let scheduledRead = false;

export default {
  async fetch() { return new Response("canonical handler order"); },
  get scheduled() {
    scheduledRead = true;
    return async () => {};
  },
  get queue() {
    return scheduledRead ? async () => {} : null;
  },
};
`;

/** Materializes one more Version of the fixture Worker and makes it the live one. */
async function publishVersion(
  local: ReturnType<typeof createSelfhostProvider>,
  name: string,
  handlers: readonly string[],
): Promise<{ readonly version: string; readonly deployment: string }> {
  const version = await local.apply({
    operationId: `op_version_${name}`,
    offering: offering("WorkerVersion"),
    identity: identity(name),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      handlers: [...handlers],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      kvBindings: [
        { name: "KV", resource: { apiVersion: EDGE_API, kind: "EdgeKVNamespace", name: "cache" } },
      ],
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      deployed(
        "/kvBindings/0/resource",
        "EdgeKVNamespace",
        "cache",
        `selfhost-kv:${KV_NAMESPACE}:op_kv`,
        { namespaceId: KV_NAMESPACE },
      ),
    ],
  });
  const deployment = await local.apply({
    operationId: `op_deploy_${name}`,
    offering: offering("WorkerDeployment"),
    identity: identity("hello-live"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      versions: [
        {
          workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name },
          weight: 10_000,
        },
      ],
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/versions/0/workerVersion", "WorkerVersion", name),
    ],
  });
  return { version: version.phase, deployment: deployment.phase };
}

test.skipIf(WORKERD === null)(
  "a published Worker reads and writes its KV namespace through the facade",
  async () => {
    const { origin } = await boot();
    const response = await ask(origin, "/kv");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      value: "hello from kv",
      metadata: { kind: "probe" },
      keys: ["greeting", "greeting-2"],
      listComplete: true,
      deleted: true,
    });
  },
  30_000,
);

test.skipIf(WORKERD === null)(
  "a published Worker reads and writes its SQLite database through the facade",
  async () => {
    const { origin } = await boot();
    const response = await ask(origin, "/sql");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      written: { rows: [], rowsWritten: 1 },
      read: { rows: [{ id: 1, body: "written through the facade" }], rowsWritten: 0 },
      batched: {
        results: [
          { rows: [], rowsWritten: 1 },
          { rows: [], rowsWritten: 1 },
        ],
      },
      all: { rows: [{ id: 1 }, { id: 2 }, { id: 3 }], rowsWritten: 0 },
    });
  },
  30_000,
);

test.skipIf(WORKERD === null)(
  "a transaction that fails halfway leaves the database as it was",
  async () => {
    const { origin } = await boot();
    expect((await ask(origin, "/sql")).status).toBe(200);
    const response = await ask(origin, "/rollback");
    expect(await response.json()).toEqual({ refused: "sql_error", rows: [] });
  },
  30_000,
);

test.skipIf(WORKERD === null)(
  "the tenant sees its own vars and never the data-plane service binding",
  async () => {
    const { origin } = await boot();
    const response = await ask(origin, "/");
    expect(await response.json()).toEqual({ lane: "takoform-v1", secret: "undefined" });
  },
  30_000,
);

test.skipIf(WORKERD === null)(
  "a tenant importing cloudflare:workers finds no token and no data binding",
  async () => {
    const { origin } = await boot();
    const response = await ask(origin, "/smuggle");
    // The closed application graph does not grant an ambient builtin exception.
    // The token and plane address also remain on a separate Host-owned service.
    expect(await response.json()).toEqual({
      importable: { error: "Error" },
      handlerToken: null,
      handlerService: "undefined",
    });
  },
  30_000,
);

test.skipIf(WORKERD === null)(
  "the serving runtime keeps startup eval and every import constructor inside the application graph",
  async () => {
    const { origin } = await boot(STARTUP_CLOSED_GRAPH_MODULE);
    expect(await (await ask(origin, "/")).json()).toEqual({
      relative: "module_not_found",
      cloudflare: "module_not_found",
      node: "module_not_found",
      workerd: "module_not_found",
      eval: "module_not_found",
      Function: "module_not_found",
      AsyncFunction: "module_not_found",
    });
  },
  30_000,
);

test.skipIf(WORKERD === null)(
  "serves a complete Worker graph with exact media and a cached accessor handler",
  async () => {
    const { origin, runtime } = await boot(
      COMPLETE_GRAPH_MODULE,
      false,
      COMPLETE_GRAPH_ADDITIONAL_MODULES,
    );

    const config = await Bun.file(join(root, "workers", "workerd.capnp")).text();
    expect(config).toMatch(
      /\(name = "helper\.txt", esModule = embed "[^"]+\/application\/module-\d+", role = application\)/u,
    );
    expect(config).toMatch(
      /\(name = "message\.js", text = embed "[^"]+\/application\/module-\d+", role = application\)/u,
    );
    expect(config).toMatch(
      /\(name = "payload\.js", data = embed "[^"]+\/application\/module-\d+", role = application\)/u,
    );
    expect(config).toMatch(
      /\(name = "empty\.wasm", wasm = embed "[^"]+\/application\/module-\d+", role = application\)/u,
    );
    expect(config).not.toContain("index.js.map");

    const expected = {
      helperLoaded: true,
      text: "portable graph text",
      dataIsArrayBuffer: true,
      data: [0, 1, 2, 255],
      wasmIsModule: true,
      getterReads: 1,
    };
    const first = await ask(origin, "/graph");
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual(expected);
    const second = await ask(origin, "/graph-again");
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(expected);

    // Re-render from the durable site manifest and restart a fresh workerd
    // process. The exact media map must survive that readback, and the cached
    // own getter must still be observed only during the wrapper's readiness
    // import, not once per request.
    if (!workerd) throw new Error("the graph workerd did not start");
    workerd.kill();
    await workerd.exited;
    workerd = undefined;
    expect(await runtime.restore()).toHaveLength(1);
    workerd = Bun.spawn([WORKERD as string, "serve", join(root, "workers", "workerd.capnp")], {
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await reachable(origin)).toBe(true);
    const afterRestart = await ask(origin, "/after-restart");
    expect(afterRestart.status).toBe(200);
    expect(await afterRestart.json()).toEqual(expected);
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "the SQL binding refuses every statement that would leave its own database",
  async () => {
    const { origin } = await boot();
    const victim = join(root, "databases", "tsdb-someone-else.sqlite");
    const control = join(root, "control.sqlite");
    const spill = join(root, "spilled.sqlite");
    const asked = new URL(`${origin}/attach`);
    asked.searchParams.set("victim", victim);
    asked.searchParams.set("control", control);
    asked.searchParams.set("spill", spill);
    const response = await fetch(asked, { headers: { host: HOSTNAME } });
    // Every one of these is a way out of the one database this binding names:
    // ATTACH opens another tenant's file and this Host's control database,
    // VACUUM INTO writes a file anywhere this process can, PRAGMA reads the
    // paths back, and the migration ledger lives in the same file.
    expect(await response.json()).toEqual({
      attachLiteral: "sql_error",
      attachParam: "sql_error",
      attachControl: "sql_error",
      databaseList: "sql_error",
      vacuumInto: "sql_error",
      dropLedger: "sql_error",
      selectLedger: "sql_error",
      multiStatement: "sql_error",
      begin: "sql_error",
      commit: "sql_error",
      savepoint: "sql_error",
      analyze: "sql_error",
      detach: "sql_error",
    });
    expect(existsSync(victim)).toBe(false);
    expect(existsSync(spill)).toBe(false);
  },
  30_000,
);

test.skipIf(WORKERD === null)(
  "a write smuggled through query is rolled back, exactly as the managed backend does it",
  async () => {
    const { origin } = await boot();
    const response = await ask(origin, "/query-writes");
    expect(await response.json()).toEqual({
      through: { rows: [], rowsWritten: 0 },
      after: { rows: [{ n: 1 }], rowsWritten: 0 },
    });
  },
  30_000,
);

/**
 * The load probe runs for every publication, including the simplest one.
 *
 * The semantic inspector imports the application graph before publication,
 * and the generated entrypoint validates its already-imported namespace. The
 * entrypoint used to be written only for a Version that bound a facade or
 * received an event. A Worker with neither was therefore published without
 * being asked: an unloadable module deployed, reported `Ready=True`, and
 * failed with a 500 on the first real request, while only workerd's own stderr
 * said `No such module`.
 */
test.skipIf(WORKERD === null)(
  "publishing a Version with no bindings whose module cannot load is refused",
  async () => {
    const { local } = await boot(TENANT_MODULE, true);
    const version = await local.apply({
      operationId: "op_version_unloadable",
      offering: offering("WorkerVersion"),
      identity: identity("hello-unloadable"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "unloadable" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "unloadable", {
          manifestDigest: "sha256:unloadable",
        }),
      ],
    });
    expect(version).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    if (version.phase !== "failed") throw new Error("the unloadable Version was accepted");
    expect(version.failure.message).toContain("module_not_found");

    const deployment = await local.apply({
      operationId: "op_deploy_unloadable",
      offering: offering("WorkerDeployment"),
      identity: identity("hello-live"),
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        versions: [
          {
            workerVersion: {
              apiVersion: EDGE_API,
              kind: "WorkerVersion",
              name: "hello-unloadable",
            },
            weight: 10_000,
          },
        ],
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/versions/0/workerVersion", "WorkerVersion", "hello-unloadable"),
      ],
    });
    expect(deployment).toMatchObject({
      phase: "failed",
    });
    if (deployment.phase !== "failed") throw new Error("the unloadable Version was published");
  },
  30_000,
);

test.skipIf(WORKERD === null)(
  "publishing a Version whose module lacks a declared handler is refused",
  async () => {
    const { local } = await boot(TENANT_MODULE, true);
    // The fixture module exports `fetch` and nothing else. Declaring
    // `scheduled` used to publish successfully and fail on the first event the
    // attachment delivered — the wrapper validates its declaration when it
    // first consumes the already-imported namespace, and until now that first
    // consumption was a customer's request.
    expect(await publishVersion(local, "hello-v2", ["fetch", "scheduled"])).toEqual({
      version: "failed",
      deployment: "failed",
    });
    // A Version that declares only what it exports still publishes.
    expect(await publishVersion(local, "hello-v3", ["fetch"])).toEqual({
      version: "succeeded",
      deployment: "succeeded",
    });
  },
  30_000,
);

test.skipIf(WORKERD === null)(
  "semantic inspection and serving capture handler getters in one canonical order",
  async () => {
    const { local, origin } = await boot(ORDER_SENSITIVE_HANDLER_MODULE, true);
    expect(
      await publishVersion(local, "hello-canonical-handlers", ["fetch", "scheduled", "queue"]),
    ).toEqual({ version: "succeeded", deployment: "succeeded" });
    expect(await (await ask(origin, "/after-publication")).text()).toBe("canonical handler order");
  },
  30_000,
);

/**
 * The event half of the same lane, with the same nothing simulated.
 *
 * A real Worker sends a message through `env.QUEUE`, a real Bun pump takes it
 * out of SQLite and posts it through the workerd router, and the same Worker's
 * `queue` handler acknowledges it. Nothing here can be proved without workerd:
 * that a service binding naming a *named* entrypoint resolves, that the batch
 * the tenant receives is iterable and settles the way the managed wrapper's
 * does, that the gate refuses a caller without the token, and that the token is
 * nowhere tenant code can reach.
 */
const EVENT_MODULE = `const seen = [];

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/send") {
      const id = await env.QUEUE.send(JSON.stringify({ note: "one" }));
      const ids = await env.QUEUE.sendBatch([
        { body: JSON.stringify({ note: "two" }) },
        { body: JSON.stringify({ note: "three" }) },
      ]);
      return Response.json({ id, ids });
    }
    if (url.pathname === "/seen") {
      const stored = await env.KV.get("seen");
      const fired = await env.KV.get("fired");
      return Response.json({
        seen: stored === null ? null : JSON.parse(new TextDecoder().decode(stored)),
        fired: fired === null ? null : new TextDecoder().decode(fired),
      });
    }
    if (url.pathname === "/reach") {
      // The token is declared on a service this isolate holds no binding to,
      // and the entrypoint that consumes it is not the one the router calls.
      let importable = null;
      try {
        const module = await import("cloudflare:workers");
        importable = Object.keys(module.env ?? {}).sort();
      } catch (error) {
        importable = [String(error && error.name)];
      }
      return Response.json({
        importable,
        handlerKeys: Object.keys(env).sort(),
        token: env.__TAKOSERVER_SELFHOST_EVENT_TOKEN ?? null,
        target: typeof env.__TAKOSERVER_SELFHOST_EVENT_TARGET,
      });
    }
    return Response.json({ ok: true });
  },
  async queue(batch, env) {
    // for-of, which is how every consumer is written: the batch this Host
    // projects has to be an ordinary iterable array.
    for (const message of batch.messages) {
      seen.push({
        queue: batch.queue,
        attempts: message.attempts,
        note: JSON.parse(atob(message.body.data)).note,
      });
      message.acknowledge();
    }
    await env.KV.put("seen", JSON.stringify(seen));
  },
  async scheduled(controller, env) {
    await env.KV.put("fired", controller.cron + "@" + String(controller.scheduledTime));
  },
};
`;

const QUEUE_ID = "tsq-e2e-delivery";
const QUEUE_NAME = "delivery";
const DLQ_ID = "tsq-e2e-delivery-dlq";
const CRON = "* * * * *";

function weightedEventModule(version: string): string {
  return `const VERSION = ${JSON.stringify(version)};
export default {
  async fetch(request, env) {
    if (new URL(request.url).pathname === "/send") {
      const ids = await env.QUEUE.sendBatch(["one", "two", "three"].map((note) => ({
        body: JSON.stringify({ note }),
      })));
      return Response.json({ ids });
    }
    const read = async (key) => {
      const bytes = await env.KV.get(key);
      return bytes === null ? null : JSON.parse(new TextDecoder().decode(bytes));
    };
    return Response.json({ seen: await read("seen"), fired: await read("fired") });
  },
  async queue(batch, env) {
    const messages = [];
    for (const message of batch.messages) {
      messages.push({
        note: JSON.parse(atob(message.body.data)).note,
        version: VERSION,
        marker: env.MARKER,
        attempts: message.attempts,
      });
      message.acknowledge();
    }
    await env.KV.put("seen", JSON.stringify({ messages, keys: Object.keys(env).sort() }));
  },
  async scheduled(controller, env) {
    await env.KV.put("fired", JSON.stringify({
      version: VERSION, marker: env.MARKER, cron: controller.cron,
      time: controller.scheduledTime, keys: Object.keys(env).sort(),
    }));
  },
};
`;
}

function queueRelation(pointer: string, name: string, id: string): ProviderRelation {
  return deployed(
    pointer,
    "AtLeastOnceQueue",
    name,
    `selfhost-queue:${id}:op_queue`,
    { queueId: id, queueName: id },
    { messageRetentionSeconds: 345_600, deliveryDelaySeconds: 0 },
  );
}

interface EventVersionFixture {
  readonly name: string;
  readonly module: string;
  readonly weight: number;
  readonly vars?: JsonObject;
}

/** Publishes a Worker that produces, consumes, and is scheduled, then boots it. */
async function bootEvents(
  versions: readonly EventVersionFixture[] = [
    { name: "hello-v1", module: EVENT_MODULE, weight: 10_000 },
  ],
): Promise<{
  readonly origin: string;
  readonly script: string;
  readonly workerdPort: number;
  readonly sql: ReturnType<typeof createEphemeralSql>;
  readonly runtime: ReturnType<typeof createWorkerdRuntime>;
  readonly targets: ReturnType<typeof createSelfhostEventTargets>;
}> {
  const sql = createEphemeralSql();
  const access = createSelfhostDataPlaneAccess(root);
  const served = serveSelfhostDataPlanes({
    sql,
    grant: (script, versionId) => access.grant(script, versionId),
    databasePath: (name) => access.databasePath(name),
    objectRoot: join(root, "selfhost", "objects"),
  });
  planeServer = served;

  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const workerdPort = Number(reserved.port);
  reserved.stop(true);
  const origin = `http://127.0.0.1:${workerdPort}`;
  const runtime = createWorkerdRuntime({
    root,
    binary: WORKERD,
    port: workerdPort,
    isReady: () => true,
  });
  const local = createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    dataPlaneAddress: served.address,
    suffixes: ["localhost"],
    events: { async forgetSchedules() {} },
    artifacts: {
      async manifest(_tenant, digest) {
        const version = versions.find((entry) => digest === `sha256:event-bundle-${entry.name}`);
        return version
          ? {
              kind: "WorkerBundle",
              mainModule: "index.js",
              modules: [{ name: "index.js", digest: `sha256:event-module-${version.name}` }],
            }
          : null;
      },
      async blob(digest) {
        const version = versions.find((entry) => digest === `sha256:event-module-${entry.name}`);
        return version ? new TextEncoder().encode(version.module) : null;
      },
    },
  });

  const worker = await local.apply({
    operationId: "op_worker",
    offering: offering("ModuleWorker"),
    identity: identity("hello"),
    spec: {},
  });
  expect(worker.phase).toBe("succeeded");
  const script = worker.phase === "succeeded" ? String(worker.result.outputs.scriptName) : "";

  for (const fixture of versions) {
    const version = await local.apply({
      operationId: `op_version_${fixture.name}`,
      offering: offering("WorkerVersion"),
      identity: identity(fixture.name),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: `bundle-${fixture.name}` },
        handlers: ["fetch", "queue", "scheduled"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        ...(fixture.vars === undefined ? {} : { vars: fixture.vars }),
        kvBindings: [
          {
            name: "KV",
            resource: { apiVersion: EDGE_API, kind: "EdgeKVNamespace", name: "cache" },
          },
        ],
        queueProducerBindings: [
          {
            name: "QUEUE",
            resource: { apiVersion: EDGE_API, kind: "AtLeastOnceQueue", name: QUEUE_NAME },
          },
        ],
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", `bundle-${fixture.name}`, {
          manifestDigest: `sha256:event-bundle-${fixture.name}`,
        }),
        deployed(
          "/kvBindings/0/resource",
          "EdgeKVNamespace",
          "cache",
          `selfhost-kv:${KV_NAMESPACE}:op_kv`,
          { namespaceId: KV_NAMESPACE },
        ),
        queueRelation("/queueProducerBindings/0/resource", QUEUE_NAME, QUEUE_ID),
      ],
    });
    expect(version.phase).toBe("succeeded");
  }

  const deployment = await local.apply({
    operationId: "op_deploy",
    offering: offering("WorkerDeployment"),
    identity: identity("hello-live"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      versions: versions.map((version) => ({
        workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: version.name },
        weight: version.weight,
      })),
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      ...versions.map((version, index) =>
        relation(`/versions/${index}/workerVersion`, "WorkerVersion", version.name),
      ),
    ],
  });
  expect(deployment.phase).toBe("succeeded");

  const endpoint = await local.apply({
    operationId: "op_endpoint",
    offering: offering("WorkerEndpoint"),
    identity: identity("hello-endpoint"),
    spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
    relations: [relation("/worker", "ModuleWorker", "hello")],
    workerEndpointOriginAssignment: {
      canonicalPublicOrigin: `https://${HOSTNAME}`,
      assignmentDigest: `sha256:${"e".repeat(64)}`,
    },
  });
  expect(endpoint.phase).toBe("succeeded");

  const consumer = await local.apply({
    operationId: "op_consumer",
    offering: offering("QueueConsumer"),
    identity: identity("hello-consumer"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      queue: { apiVersion: EDGE_API, kind: "AtLeastOnceQueue", name: QUEUE_NAME },
      deadLetterQueue: { apiVersion: EDGE_API, kind: "AtLeastOnceQueue", name: "delivery-dlq" },
      maxBatchSize: 10,
      maxBatchTimeoutSeconds: 0,
      maxRetries: 3,
      retryDelaySeconds: 60,
      maxConcurrency: 4,
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      queueRelation("/queue", QUEUE_NAME, QUEUE_ID),
      queueRelation("/deadLetterQueue", "delivery-dlq", DLQ_ID),
    ],
  });
  expect(consumer).toMatchObject({
    phase: "succeeded",
    result: { observed: { delivering: true } },
  });

  const trigger = await local.apply({
    operationId: "op_cron",
    offering: offering("WorkerCronTrigger"),
    identity: identity("hello-cron"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      cron: CRON,
    },
    relations: [relation("/worker", "ModuleWorker", "hello")],
  });
  expect(trigger).toMatchObject({
    phase: "succeeded",
    result: { observed: { scheduled: true } },
  });

  workerd = Bun.spawn([WORKERD as string, "serve", join(root, "workers", "workerd.capnp")], {
    env: {},
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await reachable(`${origin}/`)).toBe(true);

  return { origin, script, workerdPort, sql, runtime, targets: createSelfhostEventTargets(root) };
}

test.skipIf(WORKERD === null)(
  "a Worker sends into its own queue, the pump delivers the batch, and the handler acks",
  async () => {
    const { origin, sql, runtime, targets } = await bootEvents();
    const pump = createSelfhostQueuePump({ sql, runtime, targets });
    const sent = await ask(origin, "/send");
    expect(sent.status).toBe(200);
    const accepted = (await sent.json()) as { id: string; ids: readonly string[] };
    expect(accepted.id).toMatch(/^[0-9a-f-]{36}$/u);
    expect(accepted.ids).toHaveLength(2);

    // One pass takes every due message, hands it to the same Worker's `queue`
    // handler as a portable batch, and settles what came back.
    expect(await pump.tick()).toBe(3);
    const observed = (await (await ask(origin, "/seen")).json()) as {
      seen: readonly { queue: string; attempts: number; note: string }[];
    };
    expect(observed.seen.map((entry) => entry.note).sort()).toEqual(["one", "three", "two"]);
    expect(observed.seen.every((entry) => entry.attempts === 1)).toBe(true);
    expect(observed.seen.every((entry) => entry.queue === QUEUE_NAME)).toBe(true);
    // Acknowledged means gone: a second pass has nothing left to deliver.
    expect(await pump.tick()).toBe(0);
    expect(await sql.query("SELECT message_id FROM selfhost_queue_messages", [])).toEqual([]);
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "the scheduler fires the Worker's scheduled handler inside the minute it matched",
  async () => {
    const { origin, sql, runtime, targets } = await bootEvents();
    let millis = Date.UTC(2026, 8, 2, 12, 0, 30);
    const scheduler = createSelfhostWorkerScheduler({
      sql,
      runtime,
      targets,
      clock: () => new Date(millis),
    });
    // The first pass only seeds the next fire: a trigger attached at 12:00:30
    // is not owed the 12:00 that happened before it existed.
    expect(await scheduler.tick()).toBe(0);
    expect((await (await ask(origin, "/seen")).json()).fired).toBeNull();

    millis = Date.UTC(2026, 8, 2, 12, 1, 10);
    expect(await scheduler.tick()).toBe(1);
    expect((await (await ask(origin, "/seen")).json()).fired).toBe(
      `${CRON}@${Date.UTC(2026, 8, 2, 12, 1, 0)}`,
    );
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "weighted native queue batches and cron invocations select one exact Version each",
  async () => {
    const { origin, sql, runtime, targets } = await bootEvents(
      ["v1", "v2"].map((version) => ({
        name: `hello-${version}`,
        module: weightedEventModule(version),
        weight: 5_000,
        vars: { MARKER: `environment-${version}` },
      })),
    );
    expect(await targets.list()).toHaveLength(1);
    let selections = 0;
    const countedTargets: typeof targets = {
      list: () => targets.list(),
      async select(script) {
        selections += 1;
        return targets.select(script);
      },
    };
    const pump = createSelfhostQueuePump({ sql, runtime, targets: countedTargets });
    let millis = Date.UTC(2026, 8, 8, 12, 0, 30);
    const scheduler = createSelfhostWorkerScheduler({
      sql,
      runtime,
      targets: countedTargets,
      clock: () => new Date(millis),
    });
    expect(await scheduler.tick()).toBe(0);
    expect(selections).toBe(0);
    const queueVersions = new Set<string>();
    const scheduledVersions = new Set<string>();
    for (let index = 0; index < 64; index += 1) {
      expect((await ask(origin, "/send")).status).toBe(200);
      const beforeQueue = selections;
      expect(await pump.tick()).toBe(3);
      expect(selections - beforeQueue).toBe(1);
      const observed = (await (await ask(origin, "/seen")).json()) as {
        seen: {
          keys: string[];
          messages: { version: string; marker: string; note: string; attempts: number }[];
        };
      };
      expect(observed.seen.keys).toEqual(["KV", "MARKER", "QUEUE"]);
      expect(observed.seen.messages.map((message) => message.note).sort()).toEqual([
        "one",
        "three",
        "two",
      ]);
      const batchVersions = new Set(observed.seen.messages.map((message) => message.version));
      expect(batchVersions.size).toBe(1);
      for (const message of observed.seen.messages) {
        expect(["v1", "v2"]).toContain(message.version);
        expect(message.marker).toBe(`environment-${message.version}`);
        expect(message.attempts).toBe(1);
        queueVersions.add(message.version);
      }
      expect(await pump.tick()).toBe(0);
      expect(selections - beforeQueue).toBe(1);

      millis += 60_000;
      const beforeSchedule = selections;
      expect(await scheduler.tick()).toBe(1);
      expect(selections - beforeSchedule).toBe(1);
      const scheduled = (await (await ask(origin, "/seen")).json()) as {
        fired: { version: string; marker: string; cron: string; time: number; keys: string[] };
      };
      expect(["v1", "v2"]).toContain(scheduled.fired.version);
      expect(scheduled.fired.marker).toBe(`environment-${scheduled.fired.version}`);
      expect(scheduled.fired.cron).toBe(CRON);
      expect(scheduled.fired.time).toBe(Math.floor(millis / 60_000) * 60_000);
      expect(scheduled.fired.keys).toEqual(["KV", "MARKER", "QUEUE"]);
      scheduledVersions.add(scheduled.fired.version);
    }
    // Native reachability of both branches, not a statistical ratio test.
    expect([...queueVersions].sort()).toEqual(["v1", "v2"]);
    expect([...scheduledVersions].sort()).toEqual(["v1", "v2"]);
    expect(await sql.query("SELECT message_id FROM selfhost_queue_messages", [])).toEqual([]);
  },
  90_000,
);

test.skipIf(WORKERD === null)(
  "the event token is not readable from tenant code, and the gate refuses without it",
  async () => {
    const { origin, script, workerdPort } = await bootEvents();
    const reach = await ask(origin, "/reach");
    expect(await reach.json()).toEqual({
      // No undeclared builtin is visible; the token and gate service binding
      // were never on this service to begin with.
      importable: ["Error"],
      handlerKeys: ["KV", "QUEUE"],
      token: null,
      target: "undefined",
    });

    const event = JSON.stringify({
      protocol: "takoserver.managed-worker-event@v1",
      kind: "schedule",
      logicalWorkerId: script,
      deploymentId: "forged",
      cron: CRON,
      scheduledTime: 0,
    });
    const eventPath = "/.well-known/takoserver/managed-worker-events/v1";
    const headers = {
      "content-type": "application/vnd.takoserver.managed-worker-event.v1+json",
      "x-takoserver-managed-worker-event": "takoserver.managed-worker-event@v1",
    };
    // Anything that can reach the runtime's port can name a hostname, so the
    // gate is what stands between that and a forged delivery.
    const forged = await fetch(`http://127.0.0.1:${workerdPort}${eventPath}`, {
      method: "POST",
      headers: { ...headers, host: `${script}.selfhost-events.invalid` },
      body: event,
    });
    expect(forged.status).toBe(404);

    // And the customer-facing hostname does not know what an event is: the
    // event entrypoint is a named export the router never addresses.
    const direct = await fetch(`http://127.0.0.1:${workerdPort}${eventPath}`, {
      method: "POST",
      headers: { ...headers, host: HOSTNAME },
      body: event,
    });
    expect(await direct.json()).toEqual({ ok: true });
    expect((await (await ask(origin, "/seen")).json()).fired).toBeNull();
  },
  60_000,
);

/**
 * The events-only half of the lane: a Worker whose only reason for a generated
 * entrypoint is that something delivers to it.
 *
 * Everything above binds a data plane, so the generated entrypoint and its
 * internal readiness route came along for free. A Worker with a Cron Trigger
 * and nothing else is the case where both have to be built for the event alone
 * — and it is the case where two things used to go silently wrong: the asset
 * layer disappeared out of `env` the moment the trigger was attached, and the
 * readiness route was never rendered, so the publication was never checked.
 */
const SITE_INDEX = "<!doctype html><title>site</title>";
const SITE_ASSET = "served by the Host-owned asset service";
const SITE_MISLEADING_CSS = "body { color: rebeccapurple; }";
const SITE_VENDOR_ASSET = "vendor asset";
const SITE_INDEX_MEDIA = "application/vnd.takos.shell+html";
const SITE_VENDOR_MEDIA = "application/vnd.takos.theme";
const SITE_PREFIX_FILE = "logical foo";
const SITE_PREFIX_CHILD = "logical foo child";

const ASSETS_EVENT_MODULE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/asset") {
      const answer = await env.ASSETS.fetch("http://assets.invalid/index.html");
      return Response.json({ status: answer.status, body: await answer.text() });
    }
    if (url.pathname === "/declared-assets") {
      return Response.json({ assets: env.ASSETS });
    }
    return Response.json({ assets: typeof env.ASSETS });
  },
  async scheduled() {},
};
`;

const ASSET_ROUTING_MODULE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path === "/worker-ok") {
      return new Response("worker ok", { headers: { "x-worker": "ok" } });
    }
    if (path === "/throws" || url.searchParams.has("throw")) throw new Error("worker failure");
    return new Response("worker miss: " + path, {
      status: 404,
      headers: { "x-worker": "preserved" },
    });
  },
};
`;

const COLLIDING_ASSET_MODULE = `export default {
  async fetch(request) {
    if (new URL(request.url).pathname !== "/module-collision") {
      return new Response("worker miss", { status: 404 });
    }
    const loaded = await import("./__assets/asset-00000");
    return new Response(loaded.default);
  },
};
`;
const COLLIDING_TEXT_MODULE = "tenant module bytes remain distinct";

/** Publishes an assets Worker that binds no data plane, and boots it watching. */
async function bootEventsOnly(input: {
  readonly module: string;
  readonly handlers: readonly string[];
  readonly runWorkerFirst?: boolean;
  readonly notFoundHandling?: "none" | "single_page_application";
  readonly includeAssets?: boolean;
  readonly vars?: Readonly<Record<string, string>>;
  readonly modules?: readonly BootGraphModule[];
  /** Returns the version ticket before attempting deployment. */
  readonly versionTicket?: boolean;
}): Promise<{
  readonly origin: string;
  readonly local: ReturnType<typeof createSelfhostProvider>;
  readonly runtime: ReturnType<typeof createWorkerdRuntime>;
  readonly version?: Awaited<ReturnType<ReturnType<typeof createSelfhostProvider>["apply"]>>;
}> {
  const includeAssets = input.includeAssets ?? true;
  const additionalModules = (input.modules ?? []).map((entry, index) => ({
    ...entry,
    digest: entry.digest ?? `sha256:event-graph-${index}`,
  }));
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const workerdPort = Number(reserved.port);
  reserved.stop(true);
  const origin = `http://127.0.0.1:${workerdPort}`;
  // Watching, because the attachment is applied while the runtime is up and the
  // readiness probe has to be answered by the configuration that attachment
  // wrote rather than the one workerd still had.
  const start = async (): Promise<void> => {
    if (workerd) return;
    workerd = Bun.spawn(
      [WORKERD as string, "serve", "--watch", join(root, "workers", "workerd.capnp")],
      { stdout: "ignore", stderr: "ignore" },
    );
    expect(await reachable(`${origin}/`)).toBe(true);
  };
  const runtime = createWorkerdRuntime({
    root,
    binary: WORKERD,
    port: workerdPort,
    isReady: () => true,
    onReload: start,
  });
  // No data plane address at all: this Version binds nothing, which is the
  // whole point of the case.
  const local = createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    suffixes: ["localhost"],
    events: { async forgetSchedules() {} },
    artifacts: {
      async manifest(_tenant, digest) {
        if (digest === "sha256:worker") {
          return {
            kind: "WorkerBundle",
            mainModule: "index.js",
            modules: [
              { name: "index.js", digest: "sha256:index.js" },
              ...additionalModules.map(({ name, digest, mediaType }) => ({
                name,
                digest,
                mediaType,
              })),
            ],
          };
        }
        if (digest === "sha256:site") {
          return {
            kind: "StaticAssetBundle",
            files: [
              {
                path: "index.html",
                digest: "sha256:index.html",
                mediaType: SITE_INDEX_MEDIA,
              },
              { path: "asset.txt", digest: "sha256:asset.txt", mediaType: "text/plain" },
              { path: "app.bin", digest: "sha256:app.bin", mediaType: "text/css" },
              {
                path: "app.css",
                digest: "sha256:app.css",
                mediaType: SITE_VENDOR_MEDIA,
              },
              { path: "foo", digest: "sha256:foo", mediaType: "text/plain" },
              {
                path: "foo/bar.txt",
                digest: "sha256:foo-bar.txt",
                mediaType: "text/plain",
              },
            ],
          };
        }
        return null;
      },
      async blob(digest) {
        if (digest === "sha256:index.js") return new TextEncoder().encode(input.module);
        const additional = additionalModules.find((entry) => entry.digest === digest);
        if (additional) return additional.bytes;
        if (digest === "sha256:index.html") return new TextEncoder().encode(SITE_INDEX);
        if (digest === "sha256:asset.txt") return new TextEncoder().encode(SITE_ASSET);
        if (digest === "sha256:app.bin") return new TextEncoder().encode(SITE_MISLEADING_CSS);
        if (digest === "sha256:app.css") return new TextEncoder().encode(SITE_VENDOR_ASSET);
        if (digest === "sha256:foo") return new TextEncoder().encode(SITE_PREFIX_FILE);
        if (digest === "sha256:foo-bar.txt") return new TextEncoder().encode(SITE_PREFIX_CHILD);
        return null;
      },
    },
  });

  expect(
    (
      await local.apply({
        operationId: "op_worker",
        offering: offering("ModuleWorker"),
        identity: identity("hello"),
        spec: {},
      })
    ).phase,
  ).toBe("succeeded");

  const version = await local.apply({
    operationId: "op_version",
    offering: offering("WorkerVersion"),
    identity: identity("hello-v1"),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      handlers: [...input.handlers],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      ...(input.vars ? { vars: input.vars } : {}),
      ...(includeAssets
        ? {
            assets: {
              bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "site" },
              notFoundHandling: input.notFoundHandling ?? "none",
              runWorkerFirst: input.runWorkerFirst ?? false,
            },
          }
        : {}),
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ...(includeAssets
        ? [
            relation("/assets/bundle", "StaticAssetBundle", "site", {
              manifestDigest: "sha256:site",
            }),
          ]
        : []),
    ],
  });
  if (input.versionTicket) return { origin, local, runtime, version };
  expect(version.phase).toBe("succeeded");

  const deployment = await local.apply({
    operationId: "op_deploy",
    offering: offering("WorkerDeployment"),
    identity: identity("hello-live"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      versions: [
        {
          workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "hello-v1" },
          weight: 10_000,
        },
      ],
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/versions/0/workerVersion", "WorkerVersion", "hello-v1"),
    ],
  });
  expect(deployment.phase).toBe("succeeded");

  expect(
    (
      await local.apply({
        operationId: "op_endpoint",
        offering: offering("WorkerEndpoint"),
        identity: identity("hello-endpoint"),
        spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
        relations: [relation("/worker", "ModuleWorker", "hello")],
        workerEndpointOriginAssignment: {
          canonicalPublicOrigin: `https://${HOSTNAME}`,
          assignmentDigest: `sha256:${"e".repeat(64)}`,
        },
      })
    ).phase,
  ).toBe("succeeded");

  await start();
  return { origin, local, runtime };
}

/**
 * Asks until the router has the route, because a publication with no generated
 * entrypoint has no readiness answer for the apply to have waited on: workerd
 * notices the rewritten configuration on its own schedule.
 */
async function served(origin: string, path: string, attempts = 200): Promise<Response> {
  let last: Response | undefined;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      // A watching workerd restarts on a rewritten configuration, so the socket
      // is refused for a moment. That is the reload, not a failure.
      const response = await ask(origin, path);
      if (response.status !== 404) return response;
      last = response;
    } catch {}
    await new Promise<void>((wake) => setTimeout(wake, 50));
  }
  return last ?? (await ask(origin, path));
}

const SERVICE_CALLER_MODULE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/binding-shape") {
      return Response.json({
        env: Object.keys(env).sort(),
        binding: Object.keys(env.PEER ?? {}).sort(),
        frozen: Object.isFrozen(env.PEER),
        rpc: typeof env.PEER?.rpc,
      });
    }
    try {
      if (url.pathname === "/string-init") {
        return await env.PEER.fetch("https://caller-chosen.invalid/echo?source=string", {
          method: "PATCH",
          headers: { "x-service-probe": "string-init" },
          body: "string request body",
        });
      }
      if (url.pathname === "/abort-in-flight") {
        const controller = new AbortController();
        const pending = env.PEER.fetch("https://caller-chosen.invalid/slow", {
          signal: controller.signal,
        });
        setTimeout(() => controller.abort(), 25);
        return await pending;
      }
      return await env.PEER.fetch(request);
    } catch (error) {
      return Response.json({ name: error && error.name }, { status: 503 });
    }
  },
};
`;

function serviceTargetModule(version: string): string {
  return `const VERSION = ${JSON.stringify(version)};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/identity") {
      return Response.json({ version: VERSION, marker: env.MARKER, keys: Object.keys(env).sort() });
    }
    if (url.pathname === "/throw-v1") {
      if (VERSION === "v1") throw new Error("selected target v1 failure");
      return new Response(VERSION);
    }
    if (url.pathname === "/throw") throw new Error("target failure");
    if (url.pathname === "/slow") {
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      return new Response("too late");
    }
    if (url.pathname === "/spoof") {
      return new Response("target-owned 530", {
        status: 530,
        headers: { "x-takoserver-selfhost-service-unavailable": "guessed" },
      });
    }
    if (url.pathname === "/stream") {
      const reader = request.body && request.body.getReader();
      if (!reader) return new Response("request body missing", { status: 400 });
      const first = await reader.read();
      const decoder = new TextDecoder();
      const encoder = new TextEncoder();
      const body = new ReadableStream({
        async start(controller) {
          controller.enqueue(encoder.encode(VERSION + ":" + decoder.decode(first.value) + "|"));
          const second = await reader.read();
          controller.enqueue(encoder.encode(decoder.decode(second.value)));
          controller.close();
        },
      });
      return new Response(body, {
        status: 207,
        headers: {
          "content-type": "text/plain",
          "x-target-version": VERSION,
          "x-seen-method": request.method,
          "x-seen-query": url.search,
          "x-seen-probe": request.headers.get("x-service-probe") ?? "",
        },
      });
    }
    if (url.pathname === "/echo") {
      return new Response(await request.text(), {
        status: 209,
        headers: {
          "x-target-version": VERSION,
          "x-seen-host": url.hostname,
          "x-seen-method": request.method,
          "x-seen-query": url.search,
          "x-seen-probe": request.headers.get("x-service-probe") ?? "",
        },
      });
    }
    return new Response(VERSION + ":worker miss", {
      status: 404,
      headers: { "x-target-version": VERSION },
    });
  },
  async scheduled() {},
};
`;
}

/**
 * Sends the second request chunk only after the first response chunk arrives.
 * A fallback ends the request so a buffering regression fails with evidence
 * instead of hanging the suite forever.
 */
function streamedServiceAsk(origin: string): Promise<{
  readonly status: number;
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
  readonly body: string;
  readonly firstResponseBeforeSecondRequest: boolean;
}> {
  const endpoint = new URL(origin);
  return new Promise((resolvePromise, reject) => {
    let settled = false;
    let secondSent = false;
    let firstResponseBeforeSecondRequest = false;
    const request = httpRequest({
      hostname: endpoint.hostname,
      port: endpoint.port,
      method: "POST",
      path: "/stream?token=kept",
      headers: {
        host: SERVICE_CALLER_HOSTNAME,
        "content-type": "application/octet-stream",
        "transfer-encoding": "chunked",
        "x-service-probe": "streaming",
      },
    });
    const sendSecond = () => {
      if (secondSent) return;
      secondSent = true;
      request.end("second");
    };
    const fallback = setTimeout(sendSecond, 3_000);
    const deadline = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error("the service-binding streaming probe timed out"));
    }, 10_000);
    request.on("response", (response) => {
      const chunks: Uint8Array[] = [];
      response.on("data", (chunk: Uint8Array) => {
        chunks.push(new Uint8Array(chunk));
        if (!secondSent) {
          firstResponseBeforeSecondRequest = true;
          clearTimeout(fallback);
          sendSecond();
        }
      });
      response.on("end", () => {
        if (settled) return;
        settled = true;
        clearTimeout(fallback);
        clearTimeout(deadline);
        resolvePromise({
          status: response.statusCode ?? 0,
          headers: response.headers,
          body: Buffer.concat(chunks).toString("utf8"),
          firstResponseBeforeSecondRequest,
        });
      });
    });
    request.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(fallback);
      clearTimeout(deadline);
      reject(error);
    });
    request.write("first");
  });
}

/**
 * Two independently materialized Workers and one public endpoint. The target
 * deliberately has no WorkerEndpoint: a service binding is logical Host
 * routing, never a loop through public discovery.
 */
async function bootServiceBinding(): Promise<{
  readonly origin: string;
  readonly local: ReturnType<typeof createSelfhostProvider>;
  readonly callerScript: string;
  readonly targetWorkerNativeId: string;
  readonly targetWorkerOutputs: Record<string, unknown>;
  readonly targetV1NativeId: string;
  readonly targetDeploymentInput: {
    readonly offering: ProviderOffering;
    readonly identity: ReturnType<typeof identity>;
    readonly spec: JsonObject;
    readonly relations: readonly ProviderRelation[];
  };
}> {
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const workerdPort = Number(reserved.port);
  reserved.stop(true);
  const origin = `http://127.0.0.1:${workerdPort}`;
  const start = async (): Promise<void> => {
    if (workerd) return;
    workerd = Bun.spawn(
      [WORKERD as string, "serve", "--watch", join(root, "workers", "workerd.capnp")],
      { env: {}, stdout: "ignore", stderr: "ignore" },
    );
    expect(await reachable(`${origin}/`)).toBe(true);
  };
  const runtime = createWorkerdRuntime({
    root,
    binary: WORKERD,
    port: workerdPort,
    isReady: () => true,
    onReload: start,
  });
  const blobs = new Map<string, Uint8Array>([
    ["sha256:caller.js", new TextEncoder().encode(SERVICE_CALLER_MODULE)],
    ["sha256:target-v1.js", new TextEncoder().encode(serviceTargetModule("v1"))],
    ["sha256:target-v2.js", new TextEncoder().encode(serviceTargetModule("v2"))],
    ["sha256:target-v1-asset", new TextEncoder().encode("target asset v1")],
    ["sha256:target-v2-asset", new TextEncoder().encode("target asset v2")],
  ]);
  const local = createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    suffixes: ["localhost"],
    artifacts: {
      async manifest(_tenant, digest) {
        if (digest === "sha256:caller-bundle") {
          return {
            kind: "WorkerBundle",
            mainModule: "caller.js",
            modules: [{ name: "caller.js", digest: "sha256:caller.js" }],
          };
        }
        if (digest === "sha256:target-v1-bundle" || digest === "sha256:target-v2-bundle") {
          const version = digest.includes("v1") ? "v1" : "v2";
          return {
            kind: "WorkerBundle",
            mainModule: "target.js",
            modules: [{ name: "target.js", digest: `sha256:target-${version}.js` }],
          };
        }
        if (digest === "sha256:target-v1-assets" || digest === "sha256:target-v2-assets") {
          const version = digest.includes("v1") ? "v1" : "v2";
          return {
            kind: "StaticAssetBundle",
            files: [
              {
                path: "asset.txt",
                digest: `sha256:target-${version}-asset`,
                mediaType: "text/plain",
              },
            ],
          };
        }
        return null;
      },
      async blob(digest) {
        const bytes = blobs.get(digest);
        return bytes ? new Uint8Array(bytes) : null;
      },
    },
  });

  const targetWorker = await local.apply({
    operationId: "op_service_target_worker",
    offering: offering("ModuleWorker"),
    identity: identity("target"),
    spec: {},
  });
  const callerWorker = await local.apply({
    operationId: "op_service_caller_worker",
    offering: offering("ModuleWorker"),
    identity: identity("caller"),
    spec: {},
  });
  expect(targetWorker.phase).toBe("succeeded");
  expect(callerWorker.phase).toBe("succeeded");
  if (targetWorker.phase !== "succeeded" || callerWorker.phase !== "succeeded") {
    throw new Error("the service-binding Workers were not realized");
  }
  const targetWorkerRelation = deployed(
    "/serviceBindings/0/resource",
    "ModuleWorker",
    "target",
    targetWorker.result.nativeId,
    targetWorker.result.outputs,
  );
  const serviceRelation: ProviderRelation = {
    ...targetWorkerRelation,
    bindingRef: MODULE_WORKER_SERVICE_BINDING_REF,
  };
  const callerWorkerRelation = deployed(
    "/worker",
    "ModuleWorker",
    "caller",
    callerWorker.result.nativeId,
    callerWorker.result.outputs,
  );
  const targetOwnerRelation = deployed(
    "/worker",
    "ModuleWorker",
    "target",
    targetWorker.result.nativeId,
    targetWorker.result.outputs,
  );

  const targetV1 = await local.apply({
    operationId: "op_service_target_v1",
    offering: offering("WorkerVersion"),
    identity: identity("target-v1"),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "target-v1-bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
      vars: { MARKER: "environment-v1" },
      assets: {
        bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "target-v1-assets" },
        notFoundHandling: "none",
        runWorkerFirst: false,
      },
    },
    relations: [
      targetOwnerRelation,
      relation("/bundle", "WorkerBundle", "target-v1-bundle", {
        manifestDigest: "sha256:target-v1-bundle",
      }),
      relation("/assets/bundle", "StaticAssetBundle", "target-v1-assets", {
        manifestDigest: "sha256:target-v1-assets",
      }),
    ],
  });
  expect(targetV1.phase).toBe("succeeded");
  if (targetV1.phase !== "succeeded") throw new Error("the target Version was not materialized");

  const callerVersion = await local.apply({
    operationId: "op_service_caller_v1",
    offering: offering("WorkerVersion"),
    identity: identity("caller-v1"),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "caller-bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "caller" },
      serviceBindings: [
        {
          name: "PEER",
          resource: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
        },
      ],
    },
    relations: [
      callerWorkerRelation,
      relation("/bundle", "WorkerBundle", "caller-bundle", {
        manifestDigest: "sha256:caller-bundle",
      }),
      serviceRelation,
    ],
  });
  expect(callerVersion.phase).toBe("succeeded");

  expect(
    (
      await local.apply({
        operationId: "op_service_caller_deployment",
        offering: offering("WorkerDeployment"),
        identity: identity("caller-live"),
        spec: {
          worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "caller" },
          versions: [
            {
              workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "caller-v1" },
              weight: 10_000,
            },
          ],
        },
        relations: [
          relation("/worker", "ModuleWorker", "caller"),
          relation("/versions/0/workerVersion", "WorkerVersion", "caller-v1"),
        ],
      })
    ).phase,
  ).toBe("succeeded");
  expect(
    (
      await local.apply({
        operationId: "op_service_caller_endpoint",
        offering: offering("WorkerEndpoint"),
        identity: identity("caller-endpoint"),
        spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "caller" } },
        relations: [relation("/worker", "ModuleWorker", "caller")],
        workerEndpointOriginAssignment: {
          canonicalPublicOrigin: `https://${SERVICE_CALLER_HOSTNAME}`,
          assignmentDigest: `sha256:${"f".repeat(64)}`,
        },
      })
    ).phase,
  ).toBe("succeeded");
  await start();

  const targetDeploymentInput = {
    offering: offering("WorkerDeployment"),
    identity: identity("target-live"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
      versions: [
        {
          workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "target-v1" },
          weight: 10_000,
        },
      ],
    },
    relations: [
      relation("/worker", "ModuleWorker", "target"),
      relation("/versions/0/workerVersion", "WorkerVersion", "target-v1"),
    ],
  } as const;
  return {
    origin,
    local,
    callerScript: String(callerWorker.result.outputs.scriptName),
    targetWorkerNativeId: targetWorker.result.nativeId,
    targetWorkerOutputs: targetWorker.result.outputs,
    targetV1NativeId: targetV1.result.nativeId,
    targetDeploymentInput,
  };
}

test.skipIf(WORKERD === null)(
  "weighted deployment routes whole native fetches and service calls, then restores a reweighted generation",
  async () => {
    const setup = await bootServiceBinding();
    const { local, origin, targetDeploymentInput } = setup;
    const targetHostname = "weighted-target.localhost";
    const targetOwner = deployed(
      "/worker",
      "ModuleWorker",
      "target",
      setup.targetWorkerNativeId,
      setup.targetWorkerOutputs,
    );
    expect(
      (
        await local.apply({
          operationId: "op_weighted_target_v2",
          offering: offering("WorkerVersion"),
          identity: identity("target-v2"),
          spec: {
            bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "target-v2-bundle" },
            handlers: ["fetch"],
            worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
            vars: { MARKER: "environment-v2" },
            assets: {
              bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "target-v2-assets" },
              notFoundHandling: "none",
              runWorkerFirst: false,
            },
          },
          relations: [
            targetOwner,
            relation("/bundle", "WorkerBundle", "target-v2-bundle", {
              manifestDigest: "sha256:target-v2-bundle",
            }),
            relation("/assets/bundle", "StaticAssetBundle", "target-v2-assets", {
              manifestDigest: "sha256:target-v2-assets",
            }),
          ],
        })
      ).phase,
    ).toBe("succeeded");

    const deployment = (versions: readonly { name: string; weight: number }[]) => ({
      offering: targetDeploymentInput.offering,
      identity: targetDeploymentInput.identity,
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
        versions: versions.map(({ name, weight }) => ({
          workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name },
          weight,
        })),
      },
      relations: [
        targetOwner,
        ...versions.map(({ name }, index) =>
          relation(`/versions/${index}/workerVersion`, "WorkerVersion", name),
        ),
      ],
    });
    const balanced = deployment([
      { name: "target-v1", weight: 5_000 },
      { name: "target-v2", weight: 5_000 },
    ]);
    const applied = await local.apply({ ...balanced, operationId: "op_weighted_balanced" });
    expect(applied.phase).toBe("succeeded");
    if (applied.phase !== "succeeded") throw new Error("the weighted deployment failed");
    expect(
      (
        await local.apply({
          operationId: "op_weighted_target_endpoint",
          offering: offering("WorkerEndpoint"),
          identity: identity("target-endpoint"),
          spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" } },
          relations: [targetOwner],
          workerEndpointOriginAssignment: {
            canonicalPublicOrigin: `https://${targetHostname}`,
            assignmentDigest: `sha256:${"e".repeat(64)}`,
          },
        })
      ).phase,
    ).toBe("succeeded");

    const request = (hostname: string, path: string) =>
      fetch(`${origin}${path}`, {
        headers: { host: hostname },
        signal: AbortSignal.timeout(5_000),
      });
    // This is native reachability/namespace smoke, not a statistical proof of
    // exact proportions. Deterministic selector tests own interval boundaries.
    for (const hostname of [targetHostname, SERVICE_CALLER_HOSTNAME]) {
      const code = new Set<string>();
      const assets = new Set<string>();
      for (let index = 0; index < 64; index += 1) {
        const response = await request(hostname, "/identity");
        expect(response.status).toBe(200);
        const result = (await response.json()) as {
          version: string;
          marker: string;
          keys: string[];
        };
        expect(["v1", "v2"]).toContain(result.version);
        expect(result.marker).toBe(`environment-${result.version}`);
        expect(result.keys).toEqual(["MARKER"]);
        code.add(result.version);
        const asset = await request(hostname, "/asset.txt");
        expect(asset.status).toBe(200);
        const body = await asset.text();
        expect(["target asset v1", "target asset v2"]).toContain(body);
        assets.add(body);
      }
      expect([...code].sort()).toEqual(["v1", "v2"]);
      expect([...assets].sort()).toEqual(["target asset v1", "target asset v2"]);
    }
    const stream = await streamedServiceAsk(origin);
    const selected = stream.headers["x-target-version"];
    if (typeof selected !== "string") throw new Error("selected target version header missing");
    expect(["v1", "v2"]).toContain(selected);
    expect(stream.status).toBe(207);
    expect(stream.firstResponseBeforeSecondRequest).toBe(true);
    expect(stream.body).toBe(`${selected}:first|second`);

    const statuses = new Set<number>();
    for (let index = 0; index < 64; index += 1) {
      const response = await request(SERVICE_CALLER_HOSTNAME, "/throw-v1");
      statuses.add(response.status);
      const body = await response.text();
      if (response.status === 200) expect(body).toBe("v2");
    }
    // A chosen v1 exception must not turn into a successful v2 retry.
    expect([...statuses].sort()).toEqual([200, 500]);

    const onlyB = deployment([{ name: "target-v2", weight: 10_000 }]);
    expect((await local.apply({ ...onlyB, operationId: "op_weighted_only_b" })).phase).toBe(
      "succeeded",
    );
    for (const hostname of [targetHostname, SERVICE_CALLER_HOSTNAME]) {
      for (let index = 0; index < 16; index += 1) {
        const response = await request(hostname, "/identity");
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
          version: "v2",
          marker: "environment-v2",
          keys: ["MARKER"],
        });
      }
    }

    workerd?.kill();
    await workerd?.exited;
    workerd = undefined;
    const restored = createWorkerdRuntime({
      root,
      binary: WORKERD,
      port: Number(new URL(origin).port),
      isReady: () => workerd?.exitCode === null,
      onReload: async (configPath) => {
        workerd = Bun.spawn([WORKERD as string, "serve", configPath], {
          env: {},
          stdout: "ignore",
          stderr: "ignore",
        });
        if (!(await reachable(origin))) throw new Error("restored runtime did not start");
      },
    });
    expect(await restored.restore()).toContain(String(setup.targetWorkerOutputs.scriptName));
    for (const hostname of [targetHostname, SERVICE_CALLER_HOSTNAME]) {
      const response = await request(hostname, "/identity");
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        version: "v2",
        marker: "environment-v2",
        keys: ["MARKER"],
      });
      expect(await (await request(hostname, "/asset.txt")).text()).toBe("target asset v2");
    }
  },
  90_000,
);

test.skipIf(WORKERD === null)(
  "module-worker.service follows the target active deployment without a public endpoint",
  async () => {
    const setup = await bootServiceBinding();
    const { origin, local, callerScript, targetDeploymentInput } = setup;
    const callerManifestPath = join(root, "workers", callerScript, "takoserver-site.json");
    const callerManifest = await Bun.file(callerManifestPath).text();

    // A Version may bind a realized ModuleWorker before that Worker's mutable
    // traffic deployment is active. Invocation, not declaration, is unavailable.
    const inactive = await fetch(`${origin}/echo`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(inactive.status).toBe(503);
    expect(await inactive.json()).toEqual({ name: "backend_unavailable" });

    const targetDeployment = await local.apply({
      operationId: "op_service_target_deployment_v1",
      ...targetDeploymentInput,
    });
    expect(targetDeployment.phase).toBe("succeeded");
    if (targetDeployment.phase !== "succeeded") throw new Error("the target was not activated");

    const shape = await fetch(`${origin}/binding-shape`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(await shape.json()).toEqual({
      env: ["PEER"],
      binding: ["fetch"],
      frozen: true,
      rpc: "undefined",
    });

    const streamed = await streamedServiceAsk(origin);
    expect(streamed).toMatchObject({
      status: 207,
      body: "v1:first|second",
      firstResponseBeforeSecondRequest: true,
    });
    expect(streamed.headers["x-target-version"]).toBe("v1");
    expect(streamed.headers["x-seen-method"]).toBe("POST");
    expect(streamed.headers["x-seen-query"]).toBe("?token=kept");
    expect(streamed.headers["x-seen-probe"]).toBe("streaming");

    const stringInit = await fetch(`${origin}/string-init`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(stringInit.status).toBe(209);
    expect(await stringInit.text()).toBe("string request body");
    expect(stringInit.headers.get("x-target-version")).toBe("v1");
    expect(stringInit.headers.get("x-seen-host")).toBe("caller-chosen.invalid");
    expect(stringInit.headers.get("x-seen-method")).toBe("PATCH");
    expect(stringInit.headers.get("x-seen-query")).toBe("?source=string");
    expect(stringInit.headers.get("x-seen-probe")).toBe("string-init");

    const aborted = await fetch(`${origin}/abort-in-flight`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(aborted.status).toBe(503);
    expect(await aborted.json()).toEqual({ name: "AbortError" });

    const asset = await fetch(`${origin}/asset.txt`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(asset.status).toBe(200);
    expect(asset.headers.get("content-type")).toBe("text/plain");
    expect(await asset.text()).toBe("target asset v1");

    // The callee's uncaught exception is its runtime-generated response. It is
    // not the Host-unavailable rejection caught and rewritten by the caller.
    const thrown = await fetch(`${origin}/throw`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(thrown.status).toBe(500);

    // The marker value is per caller Version and never reaches the target. A
    // tenant returning the same private-looking status/header spelling is still
    // an ordinary response, preserved rather than misclassified as absence.
    const spoof = await fetch(`${origin}/spoof`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(spoof.status).toBe(530);
    expect(spoof.headers.get("x-takoserver-selfhost-service-unavailable")).toBe("guessed");
    expect(await spoof.text()).toBe("target-owned 530");

    const targetV2 = await local.apply({
      operationId: "op_service_target_v2",
      offering: offering("WorkerVersion"),
      identity: identity("target-v2"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "target-v2-bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
        assets: {
          bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "target-v2-assets" },
          notFoundHandling: "none",
          runWorkerFirst: false,
        },
      },
      relations: [
        deployed(
          "/worker",
          "ModuleWorker",
          "target",
          setup.targetWorkerNativeId,
          setup.targetWorkerOutputs,
        ),
        relation("/bundle", "WorkerBundle", "target-v2-bundle", {
          manifestDigest: "sha256:target-v2-bundle",
        }),
        relation("/assets/bundle", "StaticAssetBundle", "target-v2-assets", {
          manifestDigest: "sha256:target-v2-assets",
        }),
      ],
    });
    expect(targetV2.phase).toBe("succeeded");
    const targetV2Deployment = await local.apply({
      operationId: "op_service_target_deployment_v2",
      offering: targetDeploymentInput.offering,
      identity: targetDeploymentInput.identity,
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
        versions: [
          {
            workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "target-v2" },
            weight: 10_000,
          },
        ],
      },
      relations: [
        relation("/worker", "ModuleWorker", "target"),
        relation("/versions/0/workerVersion", "WorkerVersion", "target-v2"),
      ],
    });
    expect(targetV2Deployment.phase).toBe("succeeded");

    const updated = await fetch(`${origin}/string-init`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(updated.status).toBe(209);
    expect(updated.headers.get("x-target-version")).toBe("v2");
    const updatedAsset = await fetch(`${origin}/asset.txt`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(await updatedAsset.text()).toBe("target asset v2");
    expect(await Bun.file(callerManifestPath).text()).toBe(callerManifest);

    const noFetchVersion = await local.apply({
      operationId: "op_service_target_no_fetch",
      offering: offering("WorkerVersion"),
      identity: identity("target-no-fetch"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "target-v2-bundle" },
        handlers: ["scheduled"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
        assets: {
          bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "target-v2-assets" },
          notFoundHandling: "none",
          runWorkerFirst: false,
        },
      },
      relations: [
        deployed(
          "/worker",
          "ModuleWorker",
          "target",
          setup.targetWorkerNativeId,
          setup.targetWorkerOutputs,
        ),
        relation("/bundle", "WorkerBundle", "target-v2-bundle", {
          manifestDigest: "sha256:target-v2-bundle",
        }),
        relation("/assets/bundle", "StaticAssetBundle", "target-v2-assets", {
          manifestDigest: "sha256:target-v2-assets",
        }),
      ],
    });
    expect(noFetchVersion.phase).toBe("succeeded");
    expect(
      (
        await local.apply({
          operationId: "op_service_target_deployment_no_fetch",
          offering: targetDeploymentInput.offering,
          identity: targetDeploymentInput.identity,
          spec: {
            worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
            versions: [
              {
                workerVersion: {
                  apiVersion: EDGE_API,
                  kind: "WorkerVersion",
                  name: "target-no-fetch",
                },
                weight: 10_000,
              },
            ],
          },
          relations: [
            relation("/worker", "ModuleWorker", "target"),
            relation("/versions/0/workerVersion", "WorkerVersion", "target-no-fetch"),
          ],
        })
      ).phase,
    ).toBe("succeeded");
    const noFetch = await fetch(`${origin}/asset.txt`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(noFetch.status).toBe(503);
    expect(await noFetch.json()).toEqual({ name: "backend_unavailable" });

    const restoredTarget = await local.apply({
      operationId: "op_service_target_deployment_v2_restore",
      offering: targetDeploymentInput.offering,
      identity: targetDeploymentInput.identity,
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "target" },
        versions: [
          {
            workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "target-v2" },
            weight: 10_000,
          },
        ],
      },
      relations: [
        relation("/worker", "ModuleWorker", "target"),
        relation("/versions/0/workerVersion", "WorkerVersion", "target-v2"),
      ],
    });
    expect(restoredTarget.phase).toBe("succeeded");
    if (restoredTarget.phase !== "succeeded") throw new Error("the target was not restored");
    const restoredAsset = await fetch(`${origin}/asset.txt`, {
      headers: { host: SERVICE_CALLER_HOSTNAME },
    });
    expect(await restoredAsset.text()).toBe("target asset v2");

    expect(
      (
        await local.delete({
          operationId: "op_service_target_deployment_delete",
          offering: targetDeploymentInput.offering,
          nativeId: restoredTarget.result.nativeId,
          identity: targetDeploymentInput.identity,
          spec: targetDeploymentInput.spec,
          relations: targetDeploymentInput.relations,
        })
      ).phase,
    ).toBe("succeeded");
    let unavailable: Response | undefined;
    for (let attempt = 0; attempt < 200; attempt += 1) {
      unavailable = await fetch(`${origin}/echo`, {
        headers: { host: SERVICE_CALLER_HOSTNAME },
      }).catch(() => undefined);
      if (unavailable?.status === 503) break;
      await new Promise<void>((wake) => setTimeout(wake, 50));
    }
    expect(unavailable?.status).toBe(503);
    expect(await unavailable?.json()).toEqual({ name: "backend_unavailable" });
    expect(await Bun.file(callerManifestPath).text()).toBe(callerManifest);
  },
  90_000,
);

const attachCron = (local: ReturnType<typeof createSelfhostProvider>, cron: string) =>
  local.apply({
    operationId: "op_cron",
    offering: offering("WorkerCronTrigger"),
    identity: identity("hello-cron"),
    spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" }, cron },
    relations: [relation("/worker", "ModuleWorker", "hello")],
  });

test.skipIf(WORKERD === null)(
  "static assets stay Host-owned and never become a tenant ASSETS binding",
  async () => {
    const { origin, local } = await bootEventsOnly({
      module: ASSETS_EVENT_MODULE,
      handlers: ["fetch", "scheduled"],
    });
    // The Host may route through its private asset service, but that service is
    // never one of the application module's native bindings.
    expect(await (await served(origin, "/worker-env")).json()).toEqual({ assets: "undefined" });

    expect((await attachCron(local, "0 * * * *")).phase).toBe("succeeded");

    // A generated entrypoint must not introduce the same hidden binding when
    // an unrelated event attachment republishes the Version.
    expect(await (await served(origin, "/worker-env")).json()).toEqual({ assets: "undefined" });
    // And the gate is really in front of it.
    const config = await Bun.file(join(root, "workers", "workerd.capnp")).text();
    expect(config).toContain("-selfhost-events");
    expect(config).toContain("selfhost-internal.invalid");
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "asset-first routing serves an exact static asset before invoking fetch",
  async () => {
    const { origin } = await bootEventsOnly({
      module: ASSETS_EVENT_MODULE,
      handlers: ["fetch", "scheduled"],
    });

    const response = await served(origin, "/index.html");
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(SITE_INDEX);
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "worker-first routing keeps a non-404 fetch response ahead of an exact asset",
  async () => {
    const { origin } = await bootEventsOnly({
      module: ASSETS_EVENT_MODULE,
      handlers: ["fetch", "scheduled"],
      runWorkerFirst: true,
    });

    const response = await served(origin, "/index.html");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assets: "undefined" });
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "both asset orders preserve fallback, worker 404, and fetch errors",
  async () => {
    const assetFirst = await bootEventsOnly({
      module: ASSET_ROUTING_MODULE,
      handlers: ["fetch"],
    });
    expect(await (await served(assetFirst.origin, "/asset.txt?throw=1")).text()).toBe(SITE_ASSET);
    expect(await (await served(assetFirst.origin, "/worker-ok")).text()).toBe("worker ok");
    const assetFirstMissing = await ask(assetFirst.origin, "/both-miss");
    expect(assetFirstMissing.status).toBe(404);
    expect(assetFirstMissing.headers.get("x-worker")).toBe("preserved");
    expect(await assetFirstMissing.text()).toBe("worker miss: /both-miss");

    workerd?.kill();
    await workerd?.exited;
    workerd = undefined;
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-e2e-"));

    const workerFirst = await bootEventsOnly({
      module: ASSET_ROUTING_MODULE,
      handlers: ["fetch"],
      runWorkerFirst: true,
    });
    expect(await (await served(workerFirst.origin, "/asset.txt")).text()).toBe(SITE_ASSET);
    const workerFirstMissing = await ask(workerFirst.origin, "/both-miss");
    expect(workerFirstMissing.status).toBe(404);
    expect(workerFirstMissing.headers.get("x-worker")).toBe("preserved");
    expect(await workerFirstMissing.text()).toBe("worker miss: /both-miss");
    const thrown = await served(workerFirst.origin, "/asset.txt?throw=1");
    expect(thrown.status).toBe(500);
    expect(await thrown.text()).not.toBe(SITE_ASSET);
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "worker-first assets support a Version with no fetch handler and preserve its 404 on a miss",
  async () => {
    const { origin } = await bootEventsOnly({
      module: `export default { async scheduled() {} };`,
      handlers: ["scheduled"],
      runWorkerFirst: true,
    });

    expect(await (await served(origin, "/asset.txt")).text()).toBe(SITE_ASSET);
    const missing = await ask(origin, "/missing");
    expect(missing.status).toBe(404);
    expect(missing.headers.has("x-takoserver-selfhost-asset-miss")).toBe(false);
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "ASSETS is absent unless the user declares that ordinary value",
  async () => {
    const absent = await bootEventsOnly({
      module: ASSETS_EVENT_MODULE,
      handlers: ["fetch"],
      includeAssets: false,
    });
    expect(await (await served(absent.origin, "/worker-env")).json()).toEqual({
      assets: "undefined",
    });

    workerd?.kill();
    await workerd?.exited;
    workerd = undefined;
    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-e2e-"));

    const declared = await bootEventsOnly({
      module: ASSETS_EVENT_MODULE,
      handlers: ["fetch"],
      vars: { ASSETS: "user-declared" },
    });
    expect(await (await served(declared.origin, "/declared-assets")).json()).toEqual({
      assets: "user-declared",
    });
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "SPA fallback accepts only a valid runtime pathname and invalid pathnames fail closed",
  async () => {
    const { origin } = await bootEventsOnly({
      module: `export default { fetch() { return new Response("worker", { status: 418 }); } };`,
      handlers: ["fetch"],
      notFoundHandling: "single_page_application",
    });
    expect(await (await served(origin, "/valid-route")).text()).toBe(SITE_INDEX);
    expect(await (await served(origin, `/${"a".repeat(240)}`)).text()).toBe(SITE_INDEX);
    // Query never becomes part of the asset key.
    expect(await (await served(origin, "/asset.txt?cache=one")).text()).toBe(SITE_ASSET);
    // The contract begins at the runtime URL pathname. workerd applies URL
    // canonicalization at HTTP ingress, so this spelling reaches the Worker as
    // `/index.html` and is the same valid exact-path lookup.
    expect((await rawAsk(origin, "/nested/../index.html")).body).toBe(SITE_INDEX);

    for (const target of [
      "/.env",
      "/dir/.x",
      "/%2Eenv",
      "/dir/%2Ex",
      `/${"a".repeat(241)}`,
      "/nested//path",
      "/nested%2Findex.html",
      "/nested%5Cindex.html",
      // An encoded question mark is pathname data after the one strict decode,
      // and cannot match the manifest's relative-path grammar.
      "/asset.txt%3Fcache=one",
      "/trailing/",
      "/%00",
      "/%EF%B7%90",
      "/%C0%AF",
      "/%ZZ",
    ]) {
      const response = await rawAsk(origin, target);
      expect({ target, status: response.status, body: response.body }).toEqual({
        target,
        status: 404,
        body: "not found\n",
      });
    }
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "static responses use the manifest media type for exact and SPA assets",
  async () => {
    const { origin } = await bootEventsOnly({
      module: ASSET_ROUTING_MODULE,
      handlers: ["fetch"],
      notFoundHandling: "single_page_application",
    });

    const misleading = await served(origin, "/app.bin");
    expect(await misleading.text()).toBe(SITE_MISLEADING_CSS);
    expect(misleading.headers.get("content-type")).toBe("text/css");

    const vendor = await served(origin, "/app.css");
    expect(await vendor.text()).toBe(SITE_VENDOR_ASSET);
    expect(vendor.headers.get("content-type")).toBe(SITE_VENDOR_MEDIA);

    const spa = await served(origin, "/valid-spa-route");
    expect(await spa.text()).toBe(SITE_INDEX);
    expect(spa.headers.get("content-type")).toBe(SITE_INDEX_MEDIA);
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "prefix-colliding logical asset paths both survive publication and HTTP lookup",
  async () => {
    const { origin } = await bootEventsOnly({
      module: ASSET_ROUTING_MODULE,
      handlers: ["fetch"],
    });
    expect(await (await served(origin, "/foo")).text()).toBe(SITE_PREFIX_FILE);
    expect(await (await served(origin, "/foo/bar.txt")).text()).toBe(SITE_PREFIX_CHILD);
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "private asset storage cannot overwrite a colliding tenant module across restart",
  async () => {
    const { origin, runtime } = await bootEventsOnly({
      module: COLLIDING_ASSET_MODULE,
      modules: [
        {
          name: "__assets/asset-00000",
          mediaType: "text/plain",
          bytes: new TextEncoder().encode(COLLIDING_TEXT_MODULE),
        },
      ],
      handlers: ["fetch"],
    });
    expect(await (await served(origin, "/module-collision")).text()).toBe(COLLIDING_TEXT_MODULE);
    expect(await (await served(origin, "/index.html")).text()).toBe(SITE_INDEX);

    const running = workerd;
    if (!running) throw new Error("workerd did not start");
    running.kill();
    await running.exited;
    workerd = undefined;
    expect(await runtime.restore()).toHaveLength(1);
    expect(await (await served(origin, "/module-collision")).text()).toBe(COLLIDING_TEXT_MODULE);
    expect(await (await served(origin, "/index.html")).text()).toBe(SITE_INDEX);
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "publishing a Version that declares queue and never exports it is refused",
  async () => {
    const { version } = await bootEventsOnly({
      module: ASSETS_EVENT_MODULE,
      handlers: ["fetch", "queue"],
      versionTicket: true,
    });
    // The fixture exports `fetch` and `scheduled`. This used to publish, and
    // only the Consumer attachment — the thing that first asked for a generated
    // entrypoint — refused it; before the internal route was rendered for an
    // events-only script even that succeeded, and every batch it enabled 500ed
    // straight into the dead-letter queue. Now every publication is probed, so
    // the declaration is checked where it is made.
    expect(version).toMatchObject({
      phase: "failed",
      failure: {
        code: "invalid_spec",
        retryable: false,
        message: expect.stringContaining("handler_not_exported"),
      },
    });
    expect(workerd).toBeUndefined();
  },
  60_000,
);

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/**
 * The bucket lane, with nothing simulated.
 *
 * What only a real runtime can answer here is whether an object body actually
 * streams: the tenant's `put` hands a stream to a service binding, the facade
 * forwards it to an `externalServer` without reading it, and the plane writes
 * it to a file as it arrives. A unit test can prove each hop; only workerd can
 * prove the three of them compose.
 */
const BUCKET_ID = `tsb-${"e".repeat(40)}`;
const OTHER_BUCKET_ID = `tsb-${"d".repeat(40)}`;

const OBJECT_MODULE = `export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/objects") {
      const written = await env.MEDIA.put("photos/one.txt", "hello objects", {
        contentType: "text/plain",
      });
      await env.MEDIA.put("photos/two.txt", "second");
      await env.MEDIA.put("notes/readme.txt", "notes");
      const head = await env.MEDIA.head("photos/one.txt");
      const whole = await env.MEDIA.get("photos/one.txt");
      const wholeText = await new Response(whole.body).text();
      const ranged = await env.MEDIA.get("photos/one.txt", { range: { offset: 6, length: 7 } });
      const rangedText = await new Response(ranged.body).text();
      const listed = await env.MEDIA.list({ prefix: "photos/" });
      const folders = await env.MEDIA.list({ delimiter: "/" });
      await env.MEDIA.delete("photos/two.txt");
      const gone = await env.MEDIA.head("photos/two.txt");
      let refused = null;
      try {
        await env.MEDIA.put("photos/one.txt", "clash", { ifNoneMatch: "*" });
      } catch (error) { refused = error.name; }
      return Response.json({
        size: written.size,
        etagMatches: head.etag === written.etag,
        contentType: head.contentType,
        wholeText,
        partial: ranged.partial,
        range: ranged.range,
        rangedText,
        keys: listed.objects.map((object) => object.key),
        prefixes: folders.prefixes,
        deleted: gone === null,
        refused,
      });
    }
    if (url.pathname === "/multipart") {
      const created = await env.MEDIA.createMultipartUpload("film.bin", {
        contentType: "application/octet-stream",
      });
      const block = new Uint8Array(5 * 1024 * 1024);
      block.fill(65);
      const one = await env.MEDIA.uploadPart("film.bin", created.uploadId, 1, block.buffer);
      const two = await env.MEDIA.uploadPart("film.bin", created.uploadId, 2, "TAIL");
      const completed = await env.MEDIA.completeMultipartUpload("film.bin", created.uploadId, [
        { etag: one.etag, partNumber: 1 },
        { etag: two.etag, partNumber: 2 },
      ]);
      const tail = await env.MEDIA.get("film.bin", {
        range: { offset: completed.size - 4, length: 4 },
      });
      const tailText = await new Response(tail.body).text();
      let spent = null;
      try {
        await env.MEDIA.abortMultipartUpload("film.bin", created.uploadId);
      } catch (error) { spent = error.name; }
      return Response.json({ size: completed.size, tailText, spent });
    }
    if (url.pathname === "/objects-isolation") {
      const escaped = "../" + url.searchParams.get("other") + "/stolen";
      const written = await env.MEDIA.put(escaped, "nope");
      const listed = await env.MEDIA.list({});
      let direct = null;
      try {
        const response = await fetch(url.searchParams.get("plane"), { method: "POST" });
        direct = "status:" + response.status;
      } catch (error) { direct = String(error && error.name); }
      let importable;
      try {
        const module = await import("cloudflare:workers");
        importable = Object.keys(module.env ?? {}).sort();
      } catch (error) { importable = ["threw:" + String(error && error.name)]; }
      return Response.json({
        escapedSize: written.size,
        keys: listed.objects.map((object) => object.key),
        other: typeof env.OTHER,
        dataService: typeof env.__TAKOSERVER_SELFHOST_DATA,
        token: env.__TAKOSERVER_SELFHOST_DATA_TOKEN ?? null,
        importable,
        direct,
      });
    }
    return Response.json({ lane: "objects" });
  },
};
`;

/**
 * A tenant that redefines what `instanceof ReadableStream` answers, before its
 * first `put`.
 *
 * `ReadableStream` is an ordinary extensible constructor and the tenant's
 * top-level code runs first, so `instanceof` would make the facade's
 * discrimination between "a stream" and "not a BodyInit" the tenant's to
 * decide. Only the real runtime can say whether workerd's global is extensible
 * the way Bun's is, and whether the brand check the facade uses instead holds
 * there.
 */
const FORGED_STREAM_MODULE = `let forged = "no";
try {
  Object.defineProperty(ReadableStream, Symbol.hasInstance, {
    value: () => true,
    configurable: true,
  });
  forged = "yes";
} catch (error) { forged = "threw:" + String(error && error.name); }

export default {
  async fetch(request, env) {
    const attempts = { forged, instanceofLies: ({}) instanceof ReadableStream };
    const record = async (name, run) => {
      try { attempts[name] = await run(); }
      catch (error) { attempts[name] = error.name; }
    };
    // Forged to true: a value that is not a BodyInit must still be a type error
    // rather than something handed to the plane and coerced to a string.
    await record("plainObject", () => env.MEDIA.put("forged", { nope: true }, { contentLength: 4 }));
    await record("string", async () => (await env.MEDIA.put("forged", "ok")).size);
    // Forged the other way: a real stream must still be one.
    try {
      Object.defineProperty(ReadableStream, Symbol.hasInstance, {
        value: () => false,
        configurable: true,
      });
    } catch (error) { attempts.reforged = "threw:" + String(error && error.name); }
    await record("stream", async () => (await env.MEDIA.put(
      "streamed",
      new Blob(["streamed"]).stream(),
      { contentLength: 8 },
    )).size);
    delete ReadableStream[Symbol.hasInstance];
    await record("readBack", async () =>
      await new Response((await env.MEDIA.get("streamed")).body).text());
    return Response.json(attempts);
  },
};
`;

/** Publishes a Worker that binds one bucket, and boots workerd in front of it. */
async function bootObjects(tenantModule: string = OBJECT_MODULE): Promise<{
  readonly origin: string;
  readonly planeOrigin: string;
  readonly store: ReturnType<typeof createSelfhostObjectStore>;
}> {
  const sql = createEphemeralSql();
  const access = createSelfhostDataPlaneAccess(root);
  const objectRoot = join(root, "selfhost", "objects");
  const served = serveSelfhostDataPlanes({
    sql,
    grant: (script, versionId) => access.grant(script, versionId),
    databasePath: (name) => access.databasePath(name),
    objectRoot,
  });
  planeServer = served;

  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const workerdPort = Number(reserved.port);
  reserved.stop(true);
  const origin = `http://127.0.0.1:${workerdPort}`;
  const runtime = createWorkerdRuntime({
    root,
    binary: WORKERD,
    port: workerdPort,
    isReady: () => true,
  });
  const local = createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    dataPlaneAddress: served.address,
    suffixes: ["localhost"],
    artifacts: {
      async manifest(_tenant, digest) {
        return digest === "sha256:worker"
          ? {
              kind: "WorkerBundle",
              mainModule: "index.js",
              modules: [{ name: "index.js", digest: "sha256:index.js" }],
            }
          : null;
      },
      async blob(digest) {
        return digest === "sha256:index.js" ? new TextEncoder().encode(tenantModule) : null;
      },
    },
  });

  const worker = await local.apply({
    operationId: "op_worker",
    offering: offering("ModuleWorker"),
    identity: identity("hello"),
    spec: {},
  });
  expect(worker.phase).toBe("succeeded");
  const script = worker.phase === "succeeded" ? String(worker.result.outputs.scriptName) : "";

  const bucket = deployed(
    "/bucketBindings/0/resource",
    "ObjectBucket",
    "media",
    `selfhost-bucket:${BUCKET_ID}`,
    { bucketName: BUCKET_ID },
  );
  const version = await local.apply({
    operationId: "op_version",
    offering: offering("WorkerVersion"),
    identity: identity("hello-v1"),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      bucketBindings: [
        { name: "MEDIA", resource: { apiVersion: EDGE_API, kind: "ObjectBucket", name: "media" } },
      ],
    },
    relations: [
      deployed("/worker", "ModuleWorker", "hello", `selfhost-worker:${script}`, {
        scriptName: script,
      }),
      relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      { ...bucket, bindingRef: EDGE_OBJECTS_BINDING_REF },
    ],
    // Exactly what the Provider Pack's own importer produces for this relation.
    runtimeBindings: [
      {
        name: "MEDIA",
        targetUid: bucket.targetUid,
        bindingRef: EDGE_OBJECTS_BINDING_REF,
        material: { kind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND, bucketId: BUCKET_ID },
      },
    ],
  });
  if (version.phase !== "succeeded") {
    throw new Error(`version apply failed: ${JSON.stringify(version)}`);
  }

  const deployment = await local.apply({
    operationId: "op_deploy",
    offering: offering("WorkerDeployment"),
    identity: identity("hello-live"),
    spec: {
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      versions: [
        {
          workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "hello-v1" },
          weight: 10_000,
        },
      ],
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/versions/0/workerVersion", "WorkerVersion", "hello-v1"),
    ],
  });
  expect(deployment.phase).toBe("succeeded");

  const endpoint = await local.apply({
    operationId: "op_endpoint",
    offering: offering("WorkerEndpoint"),
    identity: identity("hello-endpoint"),
    spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
    relations: [relation("/worker", "ModuleWorker", "hello")],
    workerEndpointOriginAssignment: {
      canonicalPublicOrigin: `https://${HOSTNAME}`,
      assignmentDigest: `sha256:${"e".repeat(64)}`,
    },
  });
  expect(endpoint.phase).toBe("succeeded");

  workerd = Bun.spawn([WORKERD as string, "serve", join(root, "workers", "workerd.capnp")], {
    stdout: "ignore",
    stderr: "ignore",
  });
  expect(await reachable(`${origin}/`)).toBe(true);
  return {
    origin,
    planeOrigin: `http://${served.address}`,
    store: createSelfhostObjectStore({ sql, root: objectRoot }),
  };
}

test.skipIf(WORKERD === null)(
  "a published Worker puts, ranged-gets, lists, and deletes through env.MEDIA",
  async () => {
    const { origin, store } = await bootObjects();
    const response = await ask(origin, "/objects");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      size: 13,
      etagMatches: true,
      contentType: "text/plain",
      wholeText: "hello objects",
      partial: true,
      range: { offset: 6, length: 7 },
      rangedText: "objects",
      keys: ["photos/one.txt", "photos/two.txt"],
      prefixes: ["notes/", "photos/"],
      deleted: true,
      refused: "precondition_failed",
    });
    // The bytes really are on this machine, in this bucket, and nowhere else.
    const listed = await store.list(BUCKET_ID);
    expect(listed.objects.map((object) => object.key)).toEqual([
      "notes/readme.txt",
      "photos/one.txt",
    ]);
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "a multipart upload streams five megabytes through the facade and completes",
  async () => {
    const { origin, store } = await bootObjects();
    const response = await ask(origin, "/multipart");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      size: 5 * 1024 * 1024 + 4,
      tailText: "TAIL",
      spent: "upload_not_found",
    });
    expect((await store.head(BUCKET_ID, "film.bin"))?.size).toBe(5 * 1024 * 1024 + 4);
    // The receipts were rows, so nothing about the upload is still owed.
    expect(await store.occupancy(BUCKET_ID)).toEqual({ objects: 1, uploads: 0 });
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "a tenant cannot reach another bucket, the plane, or its own token",
  async () => {
    const { origin, planeOrigin, store } = await bootObjects();
    // Somebody else's bucket, with something in it worth taking.
    await store.put(OTHER_BUCKET_ID, "secret", new Blob(["not yours"]).stream(), {
      contentLength: 9,
    });

    const asked = new URL(`${origin}/objects-isolation`);
    asked.searchParams.set("other", OTHER_BUCKET_ID);
    asked.searchParams.set(
      "plane",
      `${planeOrigin}/.well-known/takoserver/selfhost-data/v1/objects`,
    );
    const response = await fetch(asked, { headers: { host: HOSTNAME } });
    const body = (await response.json()) as Record<string, unknown>;

    // A key that looks like a path is a key. It landed inside this Version's
    // own bucket, under a name this Host minted, and touched nothing else.
    expect(body.escapedSize).toBe(4);
    expect(body.keys).toEqual([`../${OTHER_BUCKET_ID}/stolen`]);
    expect((await store.list(OTHER_BUCKET_ID)).objects.map((object) => object.key)).toEqual([
      "secret",
    ]);
    expect(await new Response((await store.get(OTHER_BUCKET_ID, "secret"))?.body).text()).toBe(
      "not yours",
    );

    // A binding this Version never declared is absent rather than resolvable,
    // and the plane token is on a service this one holds no binding to.
    expect(body.other).toBe("undefined");
    expect(body.dataService).toBe("undefined");
    expect(body.token).toBeNull();
    expect(body.importable).toEqual(["threw:Error"]);
    // And the planes are not reachable by address from tenant code at all:
    // workerd's default outbound network refuses loopback, so the attempt
    // throws rather than reaching a status of any kind.
    expect(String(body.direct)).not.toContain("status:");
  },
  60_000,
);

test.skipIf(WORKERD === null)(
  "a tenant that forges Symbol.hasInstance cannot move what the facade calls a stream",
  async () => {
    const { origin, store } = await bootObjects(FORGED_STREAM_MODULE);
    const response = await ask(origin, "/");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      // workerd's ReadableStream is an ordinary extensible constructor, exactly
      // as Bun's is, so the forgery takes — and changes nothing.
      forged: "yes",
      instanceofLies: true,
      plainObject: "TypeError",
      string: 2,
      stream: 8,
      readBack: "streamed",
    });
    // Nothing the forgery produced reached the bucket.
    expect((await store.list(BUCKET_ID)).objects.map((object) => object.key)).toEqual([
      "forged",
      "streamed",
    ]);
    expect((await store.head(BUCKET_ID, "forged"))?.size).toBe(2);
  },
  60_000,
);
