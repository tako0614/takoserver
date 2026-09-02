import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import type { ProviderOffering, ProviderRelation } from "../src/provider-port.ts";
import type { ProviderRuntimeInputLeasePort } from "../src/provider-runtime-input-port.ts";
import {
  createSelfhostDataPlaneAccess,
  createSelfhostProvider,
} from "../src/providers/selfhost.ts";
import { createRuntimeInputAuthority } from "../src/runtime-input-preparations.ts";
import {
  createWorkerdRuntime,
  type WorkerdRuntime,
  type WorkerdSite,
} from "../src/workerd-runtime.ts";

/**
 * Running somebody's Worker on a machine you own is what makes a self-hosted
 * deployment a platform rather than a place to keep files. The chain under
 * test is the released Edge Family's: a WorkerVersion stores a committed
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

/**
 * A relation whose Resource this provider has already deployed.
 *
 * A data binding resolves through the deployment rather than the declaration —
 * the native id and the published outputs are what say which namespace or
 * database `env.KV` and `env.DB` actually address — so a test that omitted it
 * would be testing a different question.
 */
function deployedRelation(
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

/** The one materialized version directory under a script, whichever id it got. */
function versionDirectoryName(dataRoot: string, script: string): string {
  const entries = readdirSync(join(dataRoot, "selfhost", "versions", script));
  const first = entries[0];
  if (entries.length !== 1 || !first) throw new Error("expected exactly one materialized version");
  return first;
}

const endpointAssignment = (hostname = "reserved.localhost") => ({
  canonicalPublicOrigin: `https://${hostname}`,
  assignmentDigest: `sha256:${"e".repeat(64)}` as const,
});

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

interface ProviderCase {
  readonly modules?: Record<string, string>;
  readonly dataPlaneAddress?: string;
  readonly suffixes?: readonly string[];
  readonly runtime?: WorkerdRuntime;
  readonly missingBlobs?: boolean;
  readonly runtimeInputs?: ProviderRuntimeInputLeasePort;
}

const SECRET_VALUE = "placeholder-encryption-value";
const SENSITIVE_OPERATION_KEY = `takoform-worker-runtime-v1-${"a".repeat(64)}`;

interface LeaseLog {
  readonly events: string[];
  bindings: Record<string, string>;
  settleFails: boolean;
  recoveredNames: readonly string[];
  /** Files under the data root at the moment `dispatch` was called. */
  filesAtDispatch: readonly string[];
}

/**
 * A lease port that records exactly what the provider did with it, so the
 * ordering the contract requires — claim, dispatch immediately before the write,
 * settle only after readback — is observable rather than asserted from the code.
 */
function fakeLeases(dataRoot: () => string): {
  readonly port: ProviderRuntimeInputLeasePort;
  readonly log: LeaseLog;
} {
  const log: LeaseLog = {
    events: [],
    bindings: { ENCRYPTION_KEY: SECRET_VALUE },
    settleFails: false,
    recoveredNames: ["ENCRYPTION_KEY"],
    filesAtDispatch: [],
  };
  const preparation = {
    preparationId: "prep-selfhost",
    operationKey: SENSITIVE_OPERATION_KEY,
    workerResourceUid: "uid-ModuleWorker-hello",
    canonicalPublicOrigin: "https://api.takoserver.test",
    commitment: `sha256:${"b".repeat(64)}` as const,
  };
  return {
    log,
    port: {
      async acquire() {
        log.events.push("acquire");
        return {
          bindings: log.bindings,
          preparation,
          async abort() {
            log.events.push("abort");
          },
          async dispatch() {
            log.events.push("dispatch");
            log.filesAtDispatch = bindingFiles(dataRoot());
            return {
              async settle(digest) {
                if (log.settleFails) {
                  log.events.push("settle-failed");
                  throw Object.assign(new Error("settle failed"), { code: "unavailable" });
                }
                log.events.push(`settle:${digest}`);
              },
            };
          },
        };
      },
      async recover() {
        log.events.push("recover");
        return {
          preparation,
          bindingNames: log.recoveredNames,
          async settle(digest) {
            if (log.settleFails) {
              log.events.push("settle-failed");
              throw Object.assign(new Error("settle failed"), { code: "unavailable" });
            }
            log.events.push(`settle:${digest}`);
          },
        };
      },
      async abandon() {
        log.events.push("abandon");
      },
    },
  };
}

/** Every file under the data root that carries the value, with its mode. */
function carriers(dataRoot: string): readonly (readonly [string, number])[] {
  const found: (readonly [string, number])[] = [];
  for (const entry of readdirSync(dataRoot, { recursive: true })) {
    const path = join(dataRoot, String(entry));
    const stats = statSync(path);
    if (!stats.isFile()) continue;
    if (!readFileSync(path, "utf8").includes(SECRET_VALUE)) continue;
    found.push([String(entry), stats.mode & 0o777] as const);
  }
  return found;
}

function bindingFiles(dataRoot: string): readonly string[] {
  const bindings = join(dataRoot, "selfhost", "version-bindings");
  if (!existsSync(bindings)) return [];
  return readdirSync(bindings, { recursive: true }).map(String);
}

interface FlakyRuntimeState {
  serving: boolean;
  failNextWrite: boolean;
  failNextReload: boolean;
  writes: number;
  reloads: number;
}

function flakyRuntime(): { runtime: WorkerdRuntime; state: FlakyRuntimeState } {
  const state: FlakyRuntimeState = {
    serving: false,
    failNextWrite: false,
    failNextReload: false,
    writes: 0,
    reloads: 0,
  };
  return {
    state,
    runtime: {
      async write() {
        state.writes += 1;
        if (state.failNextWrite) {
          state.failNextWrite = false;
          state.serving = false;
          throw new Error("runtime write failed");
        }
      },
      async remove() {
        state.serving = false;
      },
      async reload() {
        state.reloads += 1;
        if (state.failNextReload) {
          state.failNextReload = false;
          state.serving = false;
          throw new Error("runtime reload failed");
        }
        state.serving = true;
      },
      async has() {
        return state.serving;
      },
    },
  };
}

function provider(options: ProviderCase = {}) {
  const modules = options.modules ?? { "index.js": "export default {}" };
  return createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime: options.runtime ?? createWorkerdRuntime({ root, isReady: () => true }),
    ...(options.suffixes ? { suffixes: options.suffixes } : {}),
    ...(options.runtimeInputs ? { runtimeInputs: options.runtimeInputs } : {}),
    ...(options.dataPlaneAddress ? { dataPlaneAddress: options.dataPlaneAddress } : {}),
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

const KV_NAMESPACE = "tskv-cache-fixture";
const SQLITE_DATABASE = "tsdb-app-fixture";

/** The two relations a KV+SQL Worker Version binds, as this Host deployed them. */
function dataRelations(dataRoot: string): readonly ProviderRelation[] {
  return [
    deployedRelation(
      "/kvBindings/0/resource",
      "EdgeKVNamespace",
      "cache",
      `selfhost-kv:${KV_NAMESPACE}:op_kv`,
      {
        namespaceId: KV_NAMESPACE,
      },
    ),
    deployedRelation(
      "/sqliteBindings/0/resource",
      "SQLiteDatabase",
      "app",
      `selfhost-sqlite:${SQLITE_DATABASE}:op_db`,
      { engine: "sqlite", path: join(dataRoot, "databases", `${SQLITE_DATABASE}.sqlite`) },
    ),
  ];
}

const DATA_BINDING_SPEC = {
  kvBindings: [
    { name: "KV", resource: { apiVersion: EDGE_API, kind: "EdgeKVNamespace", name: "cache" } },
  ],
  sqliteBindings: [
    { name: "DB", resource: { apiVersion: EDGE_API, kind: "SQLiteDatabase", name: "app" } },
  ],
};

/** Drives the worker → version → deployment chain one apply at a time. */
async function publish(
  local: ReturnType<typeof provider>,
  assets = false,
  vars?: Record<string, string | number>,
  dataBindings = false,
) {
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
      ...(vars ? { vars } : {}),
      ...(dataBindings ? DATA_BINDING_SPEC : {}),
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
      ...(dataBindings ? dataRelations(root) : []),
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

  test("a version's vars reach the running worker's environment", async () => {
    const local = provider();
    const script = await publish(local, false, {
      "yurucommu.lane": "takoform-v1",
      RETRIES: 3,
      QUOTED: 'he said "hi"',
    });

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain('(name = "QUOTED", text = "he said \\"hi\\"")');
    expect(config).toContain('(name = "RETRIES", json = "3")');
    expect(config).toContain('(name = "yurucommu.lane", text = "takoform-v1")');
    // The environment is a fact about the version, not part of the immutable
    // materialization whose digest means "the bytes the tenant committed".
    const meta = await readFile(
      join(root, "selfhost", "versions", script, versionDirectoryName(root, script), "meta.json"),
      "utf8",
    );
    expect(meta).not.toContain("takoform-v1");
    expect(meta).not.toContain("vars");
  });

  test("a version without vars publishes exactly the bytes it always did", async () => {
    const plain = provider();
    const plainScript = await publish(plain);
    const withoutVars = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
    const empty = provider();
    const emptyScript = await publish(empty, false, {});
    const withEmptyVars = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    expect(emptyScript).toBe(plainScript);
    expect(withEmptyVars).toBe(withoutVars);
    expect(withoutVars).not.toContain('bindings = [ (name = "');
  });

  test("refuses a var name the module could never find under that spelling", async () => {
    const local = provider();
    const ticket = await local.apply({
      operationId: "op_bad_var",
      offering: offering("WorkerVersion"),
      identity: identity("hello-badvar"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        vars: { "1leading": "x" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ],
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", message: "the Worker Version vars are invalid" },
    });
  });

  test("reports malformed durable script state instead of observing an empty deployment", async () => {
    const local = provider();
    const worker = await local.apply({
      operationId: "op_worker_corrupt_state",
      offering: offering("ModuleWorker"),
      identity: identity("hello"),
      spec: {},
    });
    if (worker.phase !== "succeeded") throw new Error("the worker allocation failed");
    const script = String(worker.result.outputs.scriptName);
    const stateRoot = join(root, "selfhost", "scripts");
    const statePath = join(stateRoot, `${script}.json`);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(statePath, '{"activeVersion":"v-truncated","domains":[', "utf8");

    const observed = await local.observe({
      offering: offering("WorkerDeployment"),
      nativeId: `selfhost-deployment:${script}:op_deploy`,
      identity: identity("hello-live"),
      spec: {},
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });

    expect(observed).toMatchObject({
      phase: "failed",
      failure: {
        code: "provider_error",
        message: "the durable Worker script state is malformed",
        retryable: false,
      },
    });
    expect(await readFile(statePath, "utf8")).toBe('{"activeVersion":"v-truncated","domains":[');
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
      workerEndpointOriginAssignment: endpointAssignment(),
    });
    expect(endpoint.phase).toBe("succeeded");
    const outputs = endpoint.phase === "succeeded" ? endpoint.result.outputs : {};
    expect(outputs.hostname).toBe("reserved.localhost");
    expect(outputs.url).toBe("https://reserved.localhost/");
    // The published address matches the closed outputs grammar: lowercase
    // labels, at least two of them, no trailing dot.
    expect(String(outputs.hostname)).toMatch(
      /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u,
    );

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain("reserved.localhost");
    expect(config).not.toContain(`${script}.localhost`);

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

    if (endpoint.phase !== "succeeded") throw new Error("the endpoint allocation failed");
    if (!local.createNativeReadbackDescriptor || !local.verifyNativeAbsence) {
      throw new Error("the selfhost provider is missing native readback");
    }
    const endpointOffering = offering("WorkerEndpoint");
    const endpointRelations = [relation("/worker", "ModuleWorker", "hello")];
    const descriptor = local.createNativeReadbackDescriptor({
      offering: endpointOffering,
      nativeId: endpoint.result.nativeId,
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: endpointRelations,
    });
    expect(descriptor.data).toEqual({
      hostname: "reserved.localhost",
      scriptName: script,
    });
    expect(
      await local.verifyNativeAbsence({ offering: endpointOffering, descriptor }),
    ).toMatchObject({ outcome: "present" });
    const deleteInput = {
      operationId: "op_endpoint_delete",
      operationMode: "initial" as const,
      offering: endpointOffering,
      nativeId: endpoint.result.nativeId,
      identity: identity("hello-endpoint"),
      spec: {},
      relations: endpointRelations,
    };
    expect(await local.delete(deleteInput)).toMatchObject({ phase: "succeeded" });
    expect(
      await local.verifyNativeAbsence({ offering: endpointOffering, descriptor }),
    ).toMatchObject({ outcome: "absent" });
    if (!local.recoverDelete) throw new Error("the selfhost provider is missing delete recovery");
    expect(await local.recoverDelete({ ...deleteInput, operationMode: "recovery" })).toMatchObject({
      phase: "succeeded",
      result: { nativeId: endpoint.result.nativeId, observed: { deleted: true } },
    });
  });

  test("a differing Worker Version digest refuses overwrite and preserves the committed modules", async () => {
    const first = provider({ modules: { "index.js": "a", "old.js": "b" } });
    const script = await publish(first);
    expect(await readFile(join(root, "workers", script, "old.js"), "utf8")).toBe("b");

    const second = provider({ modules: { "index.js": "a2" } });
    const worker = await second.apply({
      operationId: "op_worker",
      offering: offering("ModuleWorker"),
      identity: identity("hello"),
      spec: {},
    });
    expect(worker.phase).toBe("succeeded");
    const version = await second.apply({
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
    expect(version).toMatchObject({
      phase: "failed",
      failure: { code: "conflict" },
    });
    // Immutable Worker Version identities are create-only. A module the new
    // bundle does not contain must not be able to erase or replace committed
    // bytes under the same identity.
    expect(await readFile(join(root, "workers", script, "old.js"), "utf8")).toBe("b");
    expect(await readFile(join(root, "workers", script, "index.js"), "utf8")).toBe("a");
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

  test("republishes an endpoint after a runtime reload failure persisted its desired state", async () => {
    const runtime = flakyRuntime();
    const local = provider({ runtime: runtime.runtime });
    await publish(local);
    runtime.state.failNextReload = true;

    const endpointInput = {
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(),
    } as const;
    const failedApply = await local.apply({
      ...endpointInput,
      operationId: "op_endpoint_reload_failure",
    });
    expect(failedApply).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(runtime.state.serving).toBe(false);

    const retried = await local.apply({
      ...endpointInput,
      operationId: "op_endpoint_reload_retry",
    });
    expect(retried).toMatchObject({
      phase: "succeeded",
      result: { outputs: { hostname: "reserved.localhost" } },
    });
    expect(runtime.state.serving).toBe(true);
    expect(runtime.state.reloads).toBe(3);
  });

  test("republishes a custom domain after a runtime write failure persisted its desired state", async () => {
    const runtime = flakyRuntime();
    const local = provider({ runtime: runtime.runtime });
    await publish(local);
    runtime.state.failNextWrite = true;

    const domainInput = {
      offering: offering("WorkerCustomDomain"),
      identity: identity("hello-domain"),
      spec: {
        hostname: "www.example.test",
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    } as const;
    const failedApply = await local.apply({
      ...domainInput,
      operationId: "op_domain_write_failure",
    });
    expect(failedApply).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(runtime.state.serving).toBe(false);

    const retried = await local.apply({ ...domainInput, operationId: "op_domain_write_retry" });
    expect(retried).toMatchObject({
      phase: "succeeded",
      result: { observed: { hostname: "www.example.test" } },
    });
    expect(runtime.state.serving).toBe(true);
  });

  test("observes runtime truth instead of treating durable endpoint state as served", async () => {
    const runtime = flakyRuntime();
    const local = provider({ runtime: runtime.runtime });
    await publish(local);
    const endpoint = await local.apply({
      operationId: "op_endpoint_observe_truth",
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(),
    });
    expect(endpoint.phase).toBe("succeeded");
    runtime.state.serving = false;

    const observed = await local.observe({
      offering: offering("WorkerEndpoint"),
      nativeId: "whatever-was-recorded",
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(observed).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
  });

  test("does not treat a staged manifest as serving after reload fails", async () => {
    let failNextReload = false;
    const runtime = createWorkerdRuntime({
      root,
      isReady: () => true,
      onReload: async () => {
        if (failNextReload) {
          failNextReload = false;
          throw new Error("runtime reload failed after staging");
        }
      },
    });
    const local = provider({ runtime });
    await publish(local);
    failNextReload = true;

    const endpointInput = {
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(),
    } as const;
    const failedApply = await local.apply({
      ...endpointInput,
      operationId: "op_endpoint_staged_reload_failure",
    });
    expect(failedApply).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });

    const observed = await local.observe({
      offering: offering("WorkerEndpoint"),
      nativeId: "whatever-was-recorded",
      identity: identity("hello-endpoint"),
      spec: endpointInput.spec,
      relations: endpointInput.relations,
    });
    expect(observed).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
  });

  test("removes an activation marker when the serving process is no longer ready", async () => {
    let ready = true;
    const runtime = createWorkerdRuntime({ root, isReady: () => ready });
    await runtime.write(
      "hello",
      { directory: "unused", mainModule: "index.js", hostnames: ["hello.test"], generation: "v1" },
      new Map([["index.js", new TextEncoder().encode("export default {}")]]),
    );
    await runtime.reload();
    expect(await runtime.has("hello", "v1")).toBe(true);
    ready = false;
    expect(await runtime.has("hello", "v1")).toBe(false);
    expect(await runtime.has("hello", "v1")).toBe(false);
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

  /** The sensitive apply, as the Host drives it: an exact operation and UID. */
  const sensitiveApply = (extra: Record<string, unknown> = {}) => ({
    operationId: "op_sensitive_version",
    operationKey: SENSITIVE_OPERATION_KEY,
    publicApply: {
      method: "PUT",
      path: "/apis/forms.takoform.com/v1/resources/edge.forms.takoform.com/WorkerVersion/hello-sensitive",
      ifNoneMatch: "*",
      body: '{"apiVersion":"edge.forms.takoform.com","kind":"WorkerVersion"}',
    },
    offering: offering("WorkerVersion"),
    identity: { ...identity("hello-sensitive"), uid: "uid-WorkerVersion-hello-sensitive" },
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
    ...extra,
  });

  test("an unconfigured machine still refuses sensitive Worker bindings", async () => {
    const local = provider();
    expect(await local.apply(sensitiveApply())).toMatchObject({
      phase: "failed",
      failure: {
        code: "denied",
        message: "required sensitive Worker runtime inputs are unavailable",
      },
    });
    // Nothing was materialized on the way to saying no.
    expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
  });

  test("refuses a sensitive apply the Host cannot name an executing request for", async () => {
    const { port, log } = fakeLeases(() => root);
    const local = provider({ runtimeInputs: port });
    const { publicApply: _executing, ...unnamed } = sensitiveApply();

    // Without it the authority cannot recompute the commitment the preparation
    // was made against, so the claim would be unfenced. Refuse before a file
    // exists rather than spend a handoff on an apply nobody can identify.
    expect(await local.apply(unnamed)).toMatchObject({
      phase: "failed",
      failure: {
        code: "denied",
        message: "required sensitive Worker runtime inputs are unavailable",
      },
    });
    expect(log.events).toEqual([]);
    expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
  });

  test("refuses and aborts when the lease does not carry the exact declared names", async () => {
    const { port, log } = fakeLeases(() => root);
    log.bindings = { ENCRYPTION_KEY: SECRET_VALUE, EXTRA: "unexpected" };
    const local = provider({ runtimeInputs: port });

    expect(await local.apply(sensitiveApply())).toMatchObject({
      phase: "failed",
      failure: {
        code: "denied",
        message: "required sensitive Worker runtime inputs are unavailable",
      },
    });
    expect(log.events).toEqual(["acquire", "abort"]);
    expect(bindingFiles(root)).toEqual([]);
  });

  test("refuses a colliding environment before the one-shot lease is spent", async () => {
    const { port, log } = fakeLeases(() => root);
    const local = provider({ runtimeInputs: port });

    // A `vars` name that collides with a sensitive one. The Host refuses this at
    // admission, so reaching the provider with it means something upstream is
    // wrong — and the answer must still be a refusal the lease survives, not a
    // dispatched handoff nothing can clear.
    expect(
      await local.apply(
        sensitiveApply({
          spec: { ...sensitiveApply().spec, vars: { ENCRYPTION_KEY: "collides" } },
        }),
      ),
    ).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", message: "the Worker Version environment is invalid" },
    });
    expect(log.events).toEqual(["acquire", "abort"]);
    expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
  });

  test("dispatches before the values touch disk and settles only after readback", async () => {
    const { port, log } = fakeLeases(() => root);
    const local = provider({ runtimeInputs: port });

    const ticket = await local.apply(sensitiveApply());
    expect(ticket.phase).toBe("succeeded");
    expect(log.events[0]).toBe("acquire");
    expect(log.events[1]).toBe("dispatch");
    // The dispatch CAS runs before this machine's own mutation: at that moment
    // no file on it holds the value.
    expect(log.filesAtDispatch).toEqual([]);
    expect(log.events[2]).toMatch(/^settle:sha256:[0-9a-f]{64}$/u);
    expect(bindingFiles(root).length).toBeGreaterThan(0);

    // Deploying it projects the value into what workerd actually runs.
    await local.apply({
      operationId: "op_worker",
      offering: offering("ModuleWorker"),
      identity: identity("hello"),
      spec: {},
    });
    const deployment = await local.apply({
      operationId: "op_deploy_sensitive",
      offering: offering("WorkerDeployment"),
      identity: identity("hello-live"),
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        versions: [
          {
            workerVersion: {
              apiVersion: EDGE_API,
              kind: "WorkerVersion",
              name: "hello-sensitive",
            },
            weight: 10_000,
          },
        ],
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/versions/0/workerVersion", "WorkerVersion", "hello-sensitive"),
      ],
    });
    expect(deployment.phase).toBe("succeeded");
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain(`(name = "ENCRYPTION_KEY", text = "${SECRET_VALUE}")`);

    // Leak fence: the value is in the two 0600 files that must carry it, and
    // in nothing the Host records, returns, or leaves world-readable.
    expect(JSON.stringify(ticket)).not.toContain(SECRET_VALUE);
    if (ticket.phase !== "succeeded") throw new Error("unreachable");
    expect(JSON.stringify(ticket.result.observed)).toContain("ENCRYPTION_KEY");
    expect(ticket.result.nativeId).not.toContain(SECRET_VALUE);
    expect(log.events.join(" ")).not.toContain(SECRET_VALUE);
    const holders = carriers(root);
    // The generated config, the script manifest it was rendered from, and the
    // version's own binding record — and nothing else on the machine.
    expect(holders.length).toBe(3);
    for (const [path, mode] of holders) {
      expect(mode).toBe(0o600);
      expect(path).toMatch(/workerd\.capnp$|takoserver-site\.json$|version-bindings\//u);
    }
  });

  test("reports an unsettled receipt as retryable rather than as a completed apply", async () => {
    const { port, log } = fakeLeases(() => root);
    log.settleFails = true;
    const local = provider({ runtimeInputs: port });

    expect(await local.apply(sensitiveApply())).toMatchObject({
      phase: "failed",
      failure: {
        code: "unavailable",
        message: "the sensitive Worker runtime input outcome is indeterminate",
        retryable: true,
      },
    });
    expect(log.events).toEqual(["acquire", "dispatch", "settle-failed"]);
  });

  test("recovery settles from readback and never dispatches a second time", async () => {
    const { port, log } = fakeLeases(() => root);
    const local = provider({ runtimeInputs: port });
    expect((await local.apply(sensitiveApply())).phase).toBe("succeeded");
    log.events.length = 0;

    if (!local.recoverApply) throw new Error("the selfhost provider is missing apply recovery");
    const recovered = await local.recoverApply(sensitiveApply({ operationMode: "recovery" }));
    expect(recovered.phase).toBe("succeeded");
    expect(log.events[0]).toBe("recover");
    expect(log.events).not.toContain("dispatch");
    expect(log.events.at(-1)).toMatch(/^settle:sha256:[0-9a-f]{64}$/u);
    expect(JSON.stringify(recovered)).not.toContain(SECRET_VALUE);
  });

  /**
   * The whole one-shot lifecycle against the real authority rather than a fake
   * port, because the property under test is what the durable row does: a write
   * that fails *after* dispatch must still end in a handoff the ordinary retry
   * can prepare again under the same plan-derived operation key.
   */
  const sealedLane = async () => {
    const sql = createEphemeralSql();
    const now = Date.parse("2026-09-02T09:00:00.000Z");
    const formRef = {
      apiVersion: EDGE_API,
      kind: "ModuleWorker",
      definitionVersion: "0.1.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    };
    const resource = {
      apiVersion: EDGE_API,
      kind: "ModuleWorker",
      form: { formRef },
      metadata: {
        name: "hello",
        space: "default",
        uid: "uid-ModuleWorker-hello",
        generation: "1",
        revision: "1",
      },
      spec: {},
    };
    await sql.run(
      `INSERT INTO tf_resources
         (tenant_id, space, api_version, kind, name, uid, generation, revision,
          resource_json, updated_at)
       VALUES ('org_demo', 'default', ?, 'ModuleWorker', 'hello', 'uid-ModuleWorker-hello',
               '1', '1', ?, ?)`,
      [EDGE_API, JSON.stringify(resource), now],
    );
    await sql.run(
      `INSERT INTO tf_resource_deployments
         (tenant_id, id, resource_uid, offering_id, provider_pack_ref,
          provider_installation_ref, native_id, native_claimed, state,
          observed_json, outputs_json, created_at, updated_at)
       VALUES ('org_demo', 'dep-hello', 'uid-ModuleWorker-hello', 'selfhost.edge.moduleworker',
               'local', 'local.primary', 'selfhost-worker:hello', 0, 'active', '{}', '{}', ?, ?)`,
      [now, now],
    );
    await sql.run(
      `INSERT INTO tf_resource_deletion_attestations
         (tenant_id, resource_uid, space, api_version, kind, name, form_ref_json,
          state, closure_fence, effects_json, evidence_json, evidence_ref,
          evidence_effect_digest, evidence_checked_at, evidence_status, created_at, updated_at)
       VALUES ('org_demo', 'uid-ModuleWorker-hello', 'default', ?, 'ModuleWorker', 'hello', ?,
               'live', 1, '[]', NULL, NULL, NULL, NULL, NULL, ?, ?)`,
      [EDGE_API, JSON.stringify(formRef), now, now],
    );
    const authority = createRuntimeInputAuthority({
      sql,
      sealKeys: {
        current: {
          keyId: "selfhost-test-key",
          key: await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
            "encrypt",
            "decrypt",
          ]),
        },
      },
      canonicalPublicOrigin: "https://api.takoserver.test",
      clock: () => new Date(now),
    });
    const executing = sensitiveApply().publicApply;
    const prepare = async () =>
      await authority.preparations.prepare({
        organizationId: "org_demo",
        operationKey: SENSITIVE_OPERATION_KEY,
        canonicalPublicOrigin: "https://api.takoserver.test",
        publicApply: {
          method: executing.method,
          path: executing.path,
          fences: { ifNoneMatch: executing.ifNoneMatch },
          body: executing.body,
        },
        bindings: { ENCRYPTION_KEY: SECRET_VALUE },
      });
    return { authority, prepare, local: provider({ runtimeInputs: authority.leases }) };
  };

  test("a write that fails after dispatch is recovered, abandoned, and prepared again", async () => {
    const { authority, prepare, local } = await sealedLane();
    expect((await prepare()).status).toBe("prepared");

    // A transient I/O failure that can only be discovered by writing: the store's
    // own root is not a directory, so every path under it fails with ENOTDIR.
    await mkdir(join(root, "selfhost"), { recursive: true });
    await writeFile(join(root, "selfhost", "version-bindings"), "not a directory");

    expect(await local.apply(sensitiveApply())).toMatchObject({
      phase: "failed",
      failure: {
        code: "unavailable",
        message: "the Worker Version environment did not settle",
        retryable: true,
      },
    });
    // The ciphertext is gone and the version directory exists, which is exactly
    // the state that used to be unrecoverable.
    expect(await authority.preparations.read("org_demo", SENSITIVE_OPERATION_KEY)).toMatchObject({
      status: "dispatched",
    });
    await expect(prepare()).rejects.toMatchObject({ code: "conflict", status: 409 });

    rmSync(join(root, "selfhost", "version-bindings"));
    if (!local.recoverApply) throw new Error("the selfhost provider is missing apply recovery");
    expect(await local.recoverApply(sensitiveApply({ operationMode: "recovery" }))).toMatchObject({
      phase: "failed",
      failure: { code: "not_found", message: "the Worker Version environment was not recorded" },
    });
    // Abandoned on proven absence, so the plan-derived key is not burned.
    expect(await authority.preparations.read("org_demo", SENSITIVE_OPERATION_KEY)).toBeNull();

    expect((await prepare()).status).toBe("prepared");
    const retried = await local.apply(sensitiveApply());
    expect(retried.phase).toBe("succeeded");
    expect(await authority.preparations.read("org_demo", SENSITIVE_OPERATION_KEY)).toMatchObject({
      status: "consumed",
    });
    expect(JSON.stringify(retried)).not.toContain(SECRET_VALUE);
  });

  test("recovery abandons a handoff whose values provably never landed", async () => {
    const { port, log } = fakeLeases(() => root);
    const local = provider({ runtimeInputs: port });

    if (!local.recoverApply) throw new Error("the selfhost provider is missing apply recovery");
    const recovered = await local.recoverApply(sensitiveApply({ operationMode: "recovery" }));
    expect(recovered).toMatchObject({
      phase: "failed",
      failure: { code: "not_found", message: "the Worker Version is not materialized" },
    });
    expect(log.events).toEqual(["recover", "abandon"]);
  });

  test("recovery refuses a handoff whose recovered names are not the declared ones", async () => {
    const { port, log } = fakeLeases(() => root);
    log.recoveredNames = ["ENCRYPTION_KEY", "SOMETHING_ELSE"];
    const local = provider({ runtimeInputs: port });

    if (!local.recoverApply) throw new Error("the selfhost provider is missing apply recovery");
    expect(await local.recoverApply(sensitiveApply({ operationMode: "recovery" }))).toMatchObject({
      phase: "failed",
      failure: {
        code: "denied",
        message: "required sensitive Worker runtime inputs are unavailable",
      },
    });
    expect(log.events).toEqual(["recover"]);
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

  test("recovers a local worker delete by readback without repeating the mutation", async () => {
    let reloads = 0;
    const runtime = createWorkerdRuntime({
      root,
      isReady: () => true,
      onReload: async () => {
        reloads += 1;
      },
    });
    const local = provider({ runtime });
    const script = await publish(local);
    const input = {
      operationId: "op_worker_delete_recovery",
      operationMode: "initial" as const,
      offering: offering("ModuleWorker"),
      nativeId: `selfhost-worker:${script}:op_worker`,
      identity: identity("hello"),
    };
    const deleted = await local.delete(input);
    expect(deleted).toMatchObject({ phase: "succeeded" });
    const afterDeleteReloads = reloads;

    if (!local.recoverDelete) throw new Error("selfhost provider missing delete recovery seam");
    const recovered = await local.recoverDelete({
      ...input,
      operationMode: "recovery",
    });
    expect(recovered).toMatchObject({
      phase: "succeeded",
      result: { nativeId: input.nativeId, observed: { deleted: true } },
    });
    // Recovery is a readback-only seam: no second remove/reload is allowed.
    expect(reloads).toBe(afterDeleteReloads);
  });
});

describe("KV and SQLite bindings", () => {
  const address = "127.0.0.1:8787";

  test("a version binding both is published through a generated entrypoint", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, { LANE: "takoform-v1" }, true);

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    // The tenant module is still declared, because the generated one imports
    // it; workerd resolves imports through the module registry this builds.
    expect(config).toContain(
      `modules = [ (name = "__takoserver-selfhost-entrypoint.js", esModule = embed "${script}/__takoserver-selfhost-entrypoint.js"), (name = "index.js", esModule = embed "${script}/index.js") ]`,
    );
    expect(config).toContain(
      `(name = "__TAKOSERVER_SELFHOST_DATA", service = "${script}-selfhost-data")`,
    );
    expect(config).toContain(`( name = "${script}-selfhost-data",
    external = ( address = "${address}", http = () )
  ),`);
    expect(config).toContain('(name = "LANE", text = "takoform-v1")');

    const generated = await readFile(
      join(root, "workers", script, "__takoserver-selfhost-entrypoint.js"),
      "utf8",
    );
    expect(generated).toContain('import("./index.js")');
    expect(generated).toContain('"kind":"edge.kv@1.0.0","publicName":"KV"');
    expect(generated).toContain('"kind":"edge.sql@1.0.0","publicName":"DB"');
  });

  test("the token names the version, is projected once, and stays out of the tenant's env", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const versionId = versionDirectoryName(root, script);

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    const token = config.match(
      /\(name = "__TAKOSERVER_SELFHOST_DATA_TOKEN", text = "([^"]+)"\)/u,
    )?.[1];
    expect(token).toBeDefined();
    expect(token).toStartWith(`${script}.${versionId}.`);

    // The generated module reads it from the raw environment and never lists it
    // among the bindings it projects.
    const generated = await readFile(
      join(root, "workers", script, "__takoserver-selfhost-entrypoint.js"),
      "utf8",
    );
    expect(generated).not.toContain(token as string);
    expect(generated).not.toContain('"name":"__TAKOSERVER_SELFHOST_DATA_TOKEN"');
  });

  test("the plane secret never reaches an observation, an output, or a native id", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const versionId = versionDirectoryName(root, script);
    const stored = JSON.parse(
      await readFile(
        join(root, "selfhost", "version-bindings", script, `${versionId}.json`),
        "utf8",
      ),
    ) as { planeToken: string };
    expect(typeof stored.planeToken).toBe("string");

    const observed = await local.observe({
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      nativeId: `selfhost-version:${script}:${versionId}`,
      spec: { ...DATA_BINDING_SPEC },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(JSON.stringify(observed)).not.toContain(stored.planeToken);
  });

  test("the generated entrypoint stays outside the immutable version directory", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const versionId = versionDirectoryName(root, script);
    const versionDirectory = join(root, "selfhost", "versions", script, versionId);

    expect(
      existsSync(join(versionDirectory, "modules", "__takoserver-selfhost-entrypoint.js")),
    ).toBe(false);
    const meta = await readFile(join(versionDirectory, "meta.json"), "utf8");
    expect(meta).toContain('"mainModule":"index.js"');
    expect(meta).not.toContain("selfhost-entrypoint");
    expect(meta).not.toContain("kvBindings");

    // The materialization is still the bytes the tenant committed, so the
    // recovery seam that recomputes the digest still agrees with it.
    const recovered = await local.recoverApply?.({
      operationId: "op_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        ...DATA_BINDING_SPEC,
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
        ...dataRelations(root),
      ],
    });
    expect(recovered).toMatchObject({
      phase: "succeeded",
      result: { observed: { dataBindingNames: ["KV", "DB"] } },
    });
  });

  test("a version that binds neither publishes exactly the bytes it always did", async () => {
    const withPlane = provider({ dataPlaneAddress: address });
    const script = await publish(withPlane);
    const configured = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
    const withoutPlane = provider();
    expect(await publish(withoutPlane)).toBe(script);
    const plain = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    expect(configured.replaceAll(script, "<script>")).toBe(plain.replaceAll(script, "<script>"));
    expect(plain).not.toContain("selfhost-entrypoint");
    expect(plain).not.toContain("selfhost-data");
  });

  test("a deployment with no data plane refuses the declaration rather than half-serving it", async () => {
    const local = provider();
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
        ...DATA_BINDING_SPEC,
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
        ...dataRelations(root),
      ],
    });
    expect(version).toMatchObject({
      phase: "failed",
      failure: { code: "denied" },
    });
    // Nothing was materialized: a refusal must leave no version behind.
    expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
  });

  test("a target this Host did not deploy is refused rather than guessed at", async () => {
    for (const [label, relations] of [
      [
        "a namespace another provider deployed",
        [
          deployedRelation(
            "/kvBindings/0/resource",
            "EdgeKVNamespace",
            "cache",
            "cloudflare-kv:abc123:op",
            { namespaceId: "abc123" },
          ),
        ],
      ],
      [
        "an output that disagrees with the native id",
        [
          deployedRelation(
            "/kvBindings/0/resource",
            "EdgeKVNamespace",
            "cache",
            `selfhost-kv:${KV_NAMESPACE}:op_kv`,
            { namespaceId: "some-other-namespace" },
          ),
        ],
      ],
      ["a declaration with no relation at all", []],
    ] as const) {
      rmSync(root, { recursive: true, force: true });
      root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
      const local = provider({ dataPlaneAddress: address });
      const version = await local.apply({
        operationId: "op_version",
        offering: offering("WorkerVersion"),
        identity: identity("hello-v1"),
        spec: {
          bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
          handlers: ["fetch"],
          worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
          kvBindings: DATA_BINDING_SPEC.kvBindings,
        },
        relations: [
          relation("/worker", "ModuleWorker", "hello"),
          relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
          ...relations,
        ],
      });
      expect({ label, ticket: version }).toMatchObject({
        label,
        ticket: { phase: "failed", failure: { code: "invalid_spec" } },
      });
    }
  });

  test("a binding name colliding with a var is refused", async () => {
    const local = provider({ dataPlaneAddress: address });
    const version = await local.apply({
      operationId: "op_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        vars: { KV: "not a namespace" },
        kvBindings: DATA_BINDING_SPEC.kvBindings,
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
        ...dataRelations(root),
      ],
    });
    expect(version).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  });

  test("republishing after an endpoint attachment keeps the entrypoint and the token", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const before = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    const endpoint = await local.apply({
      operationId: "op_endpoint",
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(),
    });
    expect(endpoint.phase).toBe("succeeded");

    const after = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    const token = (input: string) =>
      input.match(/\(name = "__TAKOSERVER_SELFHOST_DATA_TOKEN", text = "([^"]+)"\)/u)?.[1];
    // A Worker Version is immutable, so a republish must not mint a second
    // token: the script serving traffic would be authenticating with one this
    // Host no longer holds.
    expect(token(after)).toBe(token(before));
    expect(after).toContain(
      `(name = "__TAKOSERVER_SELFHOST_DATA", service = "${script}-selfhost-data")`,
    );
    expect(after).toContain("reserved.localhost");
  });

  test("deleting the version revokes the plane grant with it", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const versionId = versionDirectoryName(root, script);
    const access = createSelfhostDataPlaneAccess(root);
    expect(await access.grant(script, versionId)).toMatchObject({
      kv: { KV: KV_NAMESPACE },
      sql: { DB: SQLITE_DATABASE },
    });

    const deleted = await local.delete({
      operationId: "op_delete",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      nativeId: `selfhost-version:${script}:${versionId}`,
      spec: {},
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(deleted.phase).toBe("succeeded");
    expect(await access.grant(script, versionId)).toBeNull();
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

describe("read-only native absence verification", () => {
  test("reads worker Version state, then proves it absent after parent deletion", async () => {
    const runtime = flakyRuntime();
    const local = provider({ runtime: runtime.runtime });
    const worker = await local.apply({
      operationId: "op_readback_worker",
      offering: offering("ModuleWorker"),
      identity: identity("hello"),
      spec: {},
    });
    if (worker.phase !== "succeeded") throw new Error("worker allocation failed");
    const script = String(worker.result.outputs.scriptName);
    const version = await local.apply({
      operationId: "op_readback_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ],
    });
    if (version.phase !== "succeeded") throw new Error("version materialization failed");
    if (!local.createNativeReadbackDescriptor || !local.verifyNativeAbsence) {
      throw new Error("selfhost provider must expose native absence readback");
    }
    const descriptor = local.createNativeReadbackDescriptor({
      offering: offering("WorkerVersion"),
      nativeId: version.result.nativeId,
      identity: identity("hello-v1"),
    });
    const writes = runtime.state.writes;
    const reloads = runtime.state.reloads;
    const present = await local.verifyNativeAbsence({
      offering: offering("WorkerVersion"),
      descriptor,
    });
    expect(present).toEqual({
      outcome: "present",
      evidence: { provider: "local", kind: "WorkerVersion", state: "present" },
    });
    expect(runtime.state.writes).toBe(writes);
    expect(runtime.state.reloads).toBe(reloads);

    const deleted = await local.delete({
      operationId: "op_readback_parent_delete",
      offering: offering("ModuleWorker"),
      nativeId: worker.result.nativeId,
      identity: identity("hello"),
    });
    expect(deleted.phase).toBe("succeeded");
    const writesAfterDelete = runtime.state.writes;
    const reloadsAfterDelete = runtime.state.reloads;
    const absent = await local.verifyNativeAbsence({
      offering: offering("WorkerVersion"),
      descriptor,
    });
    expect(absent).toEqual({
      outcome: "absent",
      evidence: { provider: "local", kind: "WorkerVersion", state: "absent" },
    });
    expect(JSON.stringify(absent)).not.toContain(script);
    expect(runtime.state.writes).toBe(writesAfterDelete);
    expect(runtime.state.reloads).toBe(reloadsAfterDelete);

    const malformed = await local.verifyNativeAbsence({
      offering: offering("WorkerVersion"),
      descriptor: { ...descriptor, data: { scriptName: "not-the-parent", versionId: "bad" } },
    });
    expect(malformed).toEqual({ outcome: "unknown", reason: "malformed", retryable: false });
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
