import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import {
  createSelfhostDataPlaneAccess,
  createSelfhostProvider,
} from "../src/providers/selfhost.ts";
import { serveSelfhostDataPlanes } from "../src/selfhost-data-planes.ts";
import { createWorkerdRuntime } from "../src/workerd-runtime.ts";
import { findWorkerd } from "../src/workerd-supervisor.ts";

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
const HOSTNAME = "e2e.localhost";
const WORKERD = findWorkerd(resolve(import.meta.dir, ".."));

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
      await env.DB.execute("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
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
      await env.DB.execute("CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)");
      await env.DB.execute("INSERT OR REPLACE INTO notes (id, body) VALUES (7, 'seven')");
      const through = await env.DB.query("DELETE FROM notes WHERE id = 7");
      const after = await env.DB.query("SELECT count(*) AS n FROM notes WHERE id = 7");
      return Response.json({ through, after });
    }
    return Response.json({ lane: env.LANE, secret: typeof env.__TAKOSERVER_SELFHOST_DATA });
  },
};
`;

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
): ProviderRelation {
  const base = relation(pointer, kind, name);
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

afterEach(() => {
  workerd?.kill();
  workerd = undefined;
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
async function boot(tenantModule: string = TENANT_MODULE): Promise<{
  readonly origin: string;
  readonly local: ReturnType<typeof createSelfhostProvider>;
  readonly planeOrigin: string;
}> {
  const sql = createEphemeralSql();
  const access = createSelfhostDataPlaneAccess(root);
  const served = serveSelfhostDataPlanes({
    sql,
    grant: (script, versionId) => access.grant(script, versionId),
    databasePath: (name) => access.databasePath(name),
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
  // Restarted on every reload, exactly as the supervisor does it in the real
  // entry, so the configuration a probe reaches is always the one just
  // written rather than whichever one workerd happened to still be serving.
  const restart = async (): Promise<void> => {
    workerd?.kill();
    workerd = Bun.spawn([WORKERD as string, "serve", join(root, "workers", "workerd.capnp")], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await reachable(`${origin}/`)).toBe(true);
  };
  const runtime = createWorkerdRuntime({
    root,
    port: workerdPort,
    isReady: () => true,
    onReload: restart,
  });
  const local = createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime,
    dataPlaneAddress,
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
      deployed(
        "/sqliteBindings/0/resource",
        "SQLiteDatabase",
        "app",
        `selfhost-sqlite:${SQLITE_DATABASE}:op_db`,
        { engine: "sqlite", path: join(root, "databases", `${SQLITE_DATABASE}.sqlite`) },
      ),
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

  expect(await reachable(`${origin}/`)).toBe(true);
  return { origin, local, planeOrigin: `http://${served.address}` };
}

const ask = (origin: string, path: string) =>
  fetch(`${origin}${path}`, { headers: { host: HOSTNAME } });

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
      batched: [
        { rows: [], rowsWritten: 1 },
        { rows: [], rowsWritten: 1 },
      ],
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
    // `import { env } from "cloudflare:workers"` is the raw environment of the
    // service, not the projected object — so leaving a binding out of the
    // projection never hid it. Two things make this empty: the token and the
    // plane address are declared on a separate Host-owned service, and
    // `disallow_importable_env` is set on this one.
    expect(await response.json()).toEqual({
      importable: { keys: [], token: null, service: "undefined" },
      handlerToken: null,
      handlerService: "undefined",
    });
  },
  30_000,
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
