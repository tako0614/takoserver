import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import {
  createSelfhostDataPlaneAccess,
  createSelfhostProvider,
} from "../src/providers/selfhost.ts";
import { createSelfhostDataPlanes } from "../src/selfhost-data-planes.ts";
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
let planeServer: ReturnType<typeof Bun.serve> | undefined;
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
async function boot(): Promise<{ readonly origin: string }> {
  const sql = createEphemeralSql();
  const access = createSelfhostDataPlaneAccess(root);
  const planes = createSelfhostDataPlanes({
    sql,
    grant: (script, versionId) => access.grant(script, versionId),
    databasePath: (name) => access.databasePath(name),
  });
  planeServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      return (
        (await planes(request, url)) ?? new Response("not a data plane request", { status: 404 })
      );
    },
  });
  const dataPlaneAddress = `127.0.0.1:${planeServer.port}`;

  // workerd binds a socket named in its configuration, so the port has to be
  // chosen before it starts. Asking the kernel for a free one and handing it
  // straight over is the closest thing to `port: 0` available here.
  const reserved = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const workerdPort = Number(reserved.port);
  reserved.stop(true);
  expect(Number.isSafeInteger(workerdPort)).toBe(true);
  const runtime = createWorkerdRuntime({ root, port: workerdPort, isReady: () => true });
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
        return digest === "sha256:index.js" ? new TextEncoder().encode(TENANT_MODULE) : null;
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

  workerd = Bun.spawn([WORKERD as string, "serve", join(root, "workers", "workerd.capnp")], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const origin = `http://127.0.0.1:${workerdPort}`;
  expect(await reachable(`${origin}/`)).toBe(true);
  return { origin };
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
