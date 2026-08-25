import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import { createSelfhostProvider } from "../src/providers/selfhost.ts";
import {
  createWorkerdRuntime,
  type WorkerdRuntime,
  type WorkerdSite,
} from "../src/workerd-runtime.ts";

/**
 * Running somebody's Worker on a machine you own is what makes a self-hosted
 * deployment a platform rather than a place to keep files. The chain under
 * test is the released Edge Family's: a WorkerVersion materializes a committed
 * bundle, a WorkerDeployment publishes the winning version into workerd, and
 * the endpoint and domain attachments decide which hostnames route to it.
 */

const EDGE_API = "edge.forms.takoform.com/v1beta1";

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

const identity = (name: string) => ({ tenantRef: "org_demo", space: "default", name });

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface ProviderCase {
  readonly modules?: Record<string, string>;
  readonly suffixes?: readonly string[];
  readonly runtime?: WorkerdRuntime;
  readonly missingBlobs?: boolean;
}

function provider(options: ProviderCase = {}) {
  const modules = options.modules ?? { "index.js": "export default {}" };
  return createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime: options.runtime ?? createWorkerdRuntime({ root }),
    ...(options.suffixes ? { suffixes: options.suffixes } : {}),
    artifacts: {
      async manifest(_tenant, digest) {
        if (digest === "sha256:worker") {
          return {
            kind: "WorkerBundle",
            mainModule: "index.js",
            modules: Object.keys(modules).map((name) => ({ name, digest: `sha256:${name}` })),
          };
        }
        if (digest === "sha256:site") {
          return {
            kind: "StaticAssetBundle",
            files: [
              { path: "index.html", digest: "sha256:index.html" },
              { path: "app.css", digest: "sha256:app.css" },
            ],
          };
        }
        return null;
      },
      async blob(digest) {
        if (options.missingBlobs) return null;
        const name = digest.slice("sha256:".length);
        const source = modules[name] ?? { "index.html": "<html>", "app.css": "body{}" }[name];
        return source === undefined ? null : new TextEncoder().encode(source);
      },
    },
  });
}

/** Drives the worker → version → deployment chain one apply at a time. */
async function publish(local: ReturnType<typeof provider>, assets = false) {
  const worker = await local.apply({
    operationId: "op_worker",
    offering: offering("ModuleWorker"),
    identity: identity("hello"),
    spec: {},
  });
  expect(worker.phase).toBe("succeeded");
  const script = worker.phase === "succeeded" ? (worker.result.outputs.scriptName as string) : "";

  const version = await local.apply({
    operationId: "op_version",
    offering: offering("WorkerVersion"),
    identity: identity("hello-v1"),
    spec: {
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      ...(assets
        ? {
            assets: {
              bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "site" },
              notFoundHandling: "single_page_application",
              runWorkerFirst: false,
            },
          }
        : {}),
    },
    relations: [
      relation("/worker", "ModuleWorker", "hello"),
      relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ...(assets
        ? [
            relation("/assets/bundle", "StaticAssetBundle", "site", {
              manifestDigest: "sha256:site",
            }),
          ]
        : []),
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
  return script;
}

describe("publishing a Worker through the Edge Family", () => {
  test("a deployment publishes the version's modules into workerd", async () => {
    const local = provider();
    const script = await publish(local);

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain(`(name = "${script}", service = "${script}")`);
    // Relative, because workerd resolves an embed against the config's own
    // directory and silently fails to read an absolute one.
    expect(config).toContain(`embed "${script}/index.js"`);
    expect(config).not.toContain(`embed "${root}`);
  });

  test("the endpoint attachment assigns a stable HTTPS address and routes it", async () => {
    const local = provider();
    const script = await publish(local);

    const endpoint = await local.apply({
      operationId: "op_endpoint",
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(endpoint.phase).toBe("succeeded");
    const outputs = endpoint.phase === "succeeded" ? endpoint.result.outputs : {};
    expect(outputs.hostname).toBe(`${script}.localhost`);
    expect(outputs.url).toBe(`https://${script}.localhost/`);
    // The published address matches the closed outputs grammar: lowercase
    // labels, at least two of them, no trailing dot.
    expect(String(outputs.hostname)).toMatch(
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u,
    );

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain(`${script}.localhost`);

    // The address is deterministic for the worker, so a re-observation reports
    // exactly what was assigned.
    const observed = await local.observe({
      offering: offering("WorkerEndpoint"),
      nativeId: "whatever-was-recorded",
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(observed.phase === "succeeded" ? observed.result.outputs : {}).toEqual(outputs);
  });

  test("a second deployment replaces the modules rather than merging them", async () => {
    const first = provider({ modules: { "index.js": "a", "old.js": "b" } });
    const script = await publish(first);
    expect(await readFile(join(root, "workers", script, "old.js"), "utf8")).toBe("b");

    const second = provider({ modules: { "index.js": "a2" } });
    await publish(second);
    // A module the new bundle does not contain must not survive, where it
    // would be loadable and wrong.
    const kept = await readFile(join(root, "workers", script, "old.js"), "utf8").catch(() => null);
    expect(kept).toBeNull();
  });

  test("refuses a custom domain this deployment does not serve", async () => {
    const local = provider({ suffixes: ["mine.test"] });
    const ticket = await local.apply({
      operationId: "op_domain",
      offering: offering("WorkerCustomDomain"),
      identity: identity("hello-domain"),
      spec: {
        hostname: "somebody-else.test",
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  });

  test("refuses a bundle whose modules the store cannot produce", async () => {
    const local = provider({ missingBlobs: true });
    const ticket = await local.apply({
      operationId: "op_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ],
    });
    // Otherwise it becomes a script that fails to start later, for reasons
    // nothing connects back to this apply.
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  });

  test("refuses sensitive Worker bindings without a runtime materializer", async () => {
    const local = provider();
    const ticket = await local.apply({
      operationId: "op_sensitive_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-sensitive"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        requiredSensitiveVars: ["ENCRYPTION_KEY"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ],
    });
    expect(ticket).toMatchObject({ phase: "failed", failure: { code: "denied" } });
  });

  test("a version that declares a site carries its files to the runtime", async () => {
    const written: {
      name: string;
      site: WorkerdSite;
      modules: ReadonlyMap<string, Uint8Array>;
      assets?: ReadonlyMap<string, Uint8Array>;
    }[] = [];
    const runtime: WorkerdRuntime = {
      async write(name, site, modules, assets) {
        written.push({ name, site, modules, ...(assets ? { assets } : {}) });
      },
      async remove() {},
      async reload() {},
      async has() {
        return true;
      },
    };
    const local = provider({ runtime });
    await publish(local, true);
    expect([...(written[0]?.assets?.keys() ?? [])].sort()).toEqual(["app.css", "index.html"]);
    expect(written[0]?.site.assets).toEqual({ notFoundHandling: "single-page-application" });
  });

  test("deleting the worker removes the script and its routes", async () => {
    const local = provider();
    const script = await publish(local);

    const deleted = await local.delete({
      operationId: "op_delete",
      offering: offering("ModuleWorker"),
      nativeId: `selfhost-worker:${script}:op_worker`,
      identity: identity("hello"),
    });
    expect(deleted.phase).toBe("succeeded");
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).not.toContain(`embed "${script}/index.js"`);
  });
});

describe("local namespaces", () => {
  test("a create mints an incarnation-unique native identity", async () => {
    const local = provider();
    const kv = offering("EdgeKVNamespace");
    const first = await local.apply({
      operationId: "op_1",
      offering: kv,
      identity: identity("cache"),
      spec: {},
    });
    const second = await local.apply({
      operationId: "op_2",
      offering: kv,
      identity: identity("cache"),
      spec: {},
    });
    const firstId = first.phase === "succeeded" ? first.result.nativeId : "";
    const secondId = second.phase === "succeeded" ? second.result.nativeId : "";
    // Delete-then-recreate of one name is a NEW incarnation, and the durable
    // deployment ledger holds native identities unique — so two creates must
    // never mint the same one.
    expect(firstId).not.toBe(secondId);

    // An update keeps the identity it was created under.
    const updated = await local.apply({
      operationId: "op_3",
      offering: kv,
      identity: identity("cache"),
      spec: {},
      previous: { nativeId: firstId, spec: {} },
    });
    expect(updated.phase === "succeeded" ? updated.result.nativeId : "").toBe(firstId);
  });

  test("the bucket keeps its pre-Edge readable name", async () => {
    const local = provider();
    const bucket = await local.apply({
      operationId: "op_1",
      offering: { ...offering("ObjectBucket"), kind: "object_bucket" },
      identity: identity("media"),
      spec: {},
    });
    expect(bucket.phase === "succeeded" ? bucket.result.outputs : {}).toEqual({
      protocol: "s3",
      bucketName: "org_demo-default-media",
    });
  });
});

describe("the SQLite migration ledger", () => {
  test("applies real SQL and refuses a moved history", async () => {
    const local = provider();
    const database = await local.apply({
      operationId: "op_db",
      offering: offering("SQLiteDatabase"),
      identity: identity("main"),
      spec: {},
    });
    expect(database.phase).toBe("succeeded");
    const nativeId = database.phase === "succeeded" ? database.result.nativeId : "";
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");

    expect(await port.readLedger({ nativeId })).toEqual({ ok: true, value: [] });

    const first = {
      path: "0001_init.sql",
      digest: `sha256:${"1".repeat(64)}` as const,
      sql: new TextEncoder().encode("CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)"),
    };
    expect(await port.applySuffix({ nativeId, expectedPrefix: [], migrations: [first] })).toEqual({
      ok: true,
      value: undefined,
    });

    const ledger = await port.readLedger({ nativeId });
    expect(ledger).toEqual({
      ok: true,
      value: [{ path: first.path, digest: first.digest }],
    });

    // A stale prefix means the database moved underneath the plan.
    const conflicting = await port.applySuffix({
      nativeId,
      expectedPrefix: [],
      migrations: [
        {
          path: "0002_more.sql",
          digest: `sha256:${"2".repeat(64)}`,
          sql: new TextEncoder().encode("CREATE TABLE more (id INTEGER PRIMARY KEY)"),
        },
      ],
    });
    expect(conflicting).toMatchObject({ ok: false, failure: { code: "conflict" } });

    // Broken SQL commits nothing, ledger row included.
    const broken = await port.applySuffix({
      nativeId,
      expectedPrefix: [{ path: first.path, digest: first.digest }],
      migrations: [
        {
          path: "0002_broken.sql",
          digest: `sha256:${"3".repeat(64)}`,
          sql: new TextEncoder().encode("THIS IS NOT SQL"),
        },
      ],
    });
    expect(broken).toMatchObject({ ok: false, failure: { code: "provider_error" } });
    expect(await port.readLedger({ nativeId })).toEqual({
      ok: true,
      value: [{ path: first.path, digest: first.digest }],
    });
  });
});
