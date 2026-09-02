import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import type {
  ProviderOffering,
  ProviderRelation,
  ProviderRuntimeBinding,
} from "../src/provider-port.ts";
import type { ProviderRuntimeInputLeasePort } from "../src/provider-runtime-input-port.ts";
import { EDGE_OBJECTS_BINDING_REF } from "../src/providers/cloudflare-runtime-bindings.ts";
import {
  createSelfhostDataPlaneAccess,
  createSelfhostProvider,
  type SelfhostDataPlaneMaintenance,
} from "../src/providers/selfhost.ts";
import { SELFHOST_EDGE_OBJECTS_MATERIAL_KIND } from "../src/providers/selfhost-runtime-bindings.ts";
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
  readonly events?: {
    forgetSchedules(script: string, cron?: string): Promise<void>;
  };
  readonly dataPlaneAddress?: string;
  readonly suffixes?: readonly string[];
  readonly runtime?: WorkerdRuntime;
  readonly missingBlobs?: boolean;
  readonly runtimeInputs?: ProviderRuntimeInputLeasePort;
  readonly dataPlaneMaintenance?: SelfhostDataPlaneMaintenance;
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
    ...(options.dataPlaneMaintenance ? { dataPlaneMaintenance: options.dataPlaneMaintenance } : {}),
    ...(options.events ? { events: options.events } : {}),
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

  /**
   * The address an ordinary organization API key gets.
   *
   * The released provider's `takoform_worker_endpoint` accepts only `name` and
   * `worker`, so an ordinary key supplies no reservation at all and the Host
   * mints one from this. What the installation derives has to be the address
   * it will actually serve on — the Worker's own script name under this
   * deployment's suffix — or the endpoint publishes a hostname the router
   * never answers.
   */
  test("derives the Host-minted endpoint subdomain as the script this machine routes", async () => {
    const local = provider();
    const script = await publish(local);
    const derive = local.workerEndpointOriginReservations?.hostMintedSubdomain;
    if (!derive) throw new Error("the self-host provider mints no endpoint subdomain");
    const subdomain = await derive({
      tenantRef: "org_demo",
      space: "default",
      workerName: "hello",
    });
    expect(subdomain).toBe(script);

    const derived = await local.workerEndpointOriginReservations?.derive({
      tenantRef: "org_demo",
      requestedSubdomain: subdomain as string,
    });
    expect(derived?.canonicalPublicOrigin).toBe(`https://${script}.localhost`);

    // And it is an address this deployment accepts and publishes.
    const endpoint = await local.apply({
      operationId: "op_endpoint_hostmint",
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(`${script}.localhost`),
    });
    expect(endpoint.phase === "succeeded" ? endpoint.result.outputs : {}).toEqual({
      hostname: `${script}.localhost`,
      url: `https://${script}.localhost/`,
    });
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

  test("a sensitive var named after this Host's reserved prefix is refused", async () => {
    const { port } = fakeLeases(() => root);
    const local = provider({ runtimeInputs: port });
    // The one declaration whose grammar admits `__TAKOSERVER_`: a `vars` name
    // must start with a letter, and a data-binding name is checked explicitly.
    // Without this the reserved namespace is not reserved, and a tenant can
    // name a binding after the data service the entrypoint reaches its storage
    // through.
    for (const name of ["__TAKOSERVER_SELFHOST_DATA", "__TAKOSERVER_SELFHOST_DATA_TOKEN"]) {
      expect(
        await local.apply(
          sensitiveApply({
            spec: {
              bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
              handlers: ["fetch"],
              requiredSensitiveVars: [name],
              worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
            },
          }),
        ),
      ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
    }
    expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
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
    // The service the tenant binds is a Worker of this Host's own, and the one
    // that names the loopback address sits behind it.
    expect(config).toContain(`( name = "${script}-selfhost-data",
    worker = (
      modules = [ (name = "__takoserver-selfhost-data.js", esModule = embed "${script}/__takoserver-selfhost-data.js") ],`);
    expect(config).toContain(`( name = "${script}-selfhost-data-origin",
    external = ( address = "${address}", http = () )
  ),`);
    expect(config).toContain('(name = "LANE", text = "takoform-v1")');
    expect(config).toContain('compatibilityFlags = [ "disallow_importable_env" ]');

    const generated = await readFile(
      join(root, "workers", script, "__takoserver-selfhost-entrypoint.js"),
      "utf8",
    );
    expect(generated).toContain('import("./index.js")');
    expect(generated).toContain('"kind":"edge.kv@1.0.0","publicName":"KV"');
    expect(generated).toContain('"kind":"edge.sql@1.0.0","publicName":"DB"');
  });

  test("the token names the version and is a binding of the facade service alone", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const versionId = versionDirectoryName(root, script);

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    const token = config.match(
      /\(name = "__TAKOSERVER_SELFHOST_DATA_TOKEN", text = "([^"]+)"\)/u,
    )?.[1];
    expect(token).toBeDefined();
    expect(token).toStartWith(`${script}.${versionId}.`);

    // Exactly one service declares it, and it is not the one that runs tenant
    // code. A binding belongs to its service, and workerd hands every binding
    // of a service to every module that service runs — including through
    // `cloudflare:workers` — so keeping the token off this service is the whole
    // isolation claim.
    const services = config
      .split(/^ {2}\( name = /mu)
      .filter((section) => section.includes("__TAKOSERVER_SELFHOST_DATA_TOKEN"));
    expect(services).toHaveLength(1);
    expect(services[0]).toStartWith(`"${script}-selfhost-data"`);

    const tenantService = config
      .split(/^ {2}\( name = /mu)
      .find((section) => section.startsWith(`"${script}"`)) as string;
    expect(tenantService).not.toContain(token as string);
    expect(tenantService).not.toContain("__TAKOSERVER_SELFHOST_DATA_TOKEN");

    // The generated modules carry no credential of their own either.
    const generated = await readFile(
      join(root, "workers", script, "__takoserver-selfhost-entrypoint.js"),
      "utf8",
    );
    const facade = await readFile(
      join(root, "workers", script, "__takoserver-selfhost-data.js"),
      "utf8",
    );
    expect(generated).not.toContain(token as string);
    expect(generated).not.toContain("__TAKOSERVER_SELFHOST_DATA_TOKEN");
    expect(facade).not.toContain(token as string);
  });

  test("the facade service is the only route out, and it names both its own", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const facade = await readFile(
      join(root, "workers", script, "__takoserver-selfhost-data.js"),
      "utf8",
    );
    // Two destinations, both constants of this Host's, and nothing a caller
    // writes on a request reaches either.
    expect(facade).toContain(
      'const KV_URL = "http://takoserver-selfhost-data.invalid/.well-known/takoserver/selfhost-data/v1/kv"',
    );
    expect(facade).toContain(
      'const SQL_URL = "http://takoserver-selfhost-data.invalid/.well-known/takoserver/selfhost-data/v1/sql"',
    );
    expect(facade).toContain(
      'if (target === null || request.method !== "POST") return refuse(404)',
    );
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
    expect(existsSync(join(versionDirectory, "modules", "__takoserver-selfhost-data.js"))).toBe(
      false,
    );
    expect(readdirSync(join(versionDirectory, "modules"))).toEqual(["index.js"]);
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
  // A namespace now stores bytes, so its native name is derived from the
  // Resource UID as well as its name. The Host sends one on every apply.
  const kvIdentity = (name: string, uid: string) => ({ ...identity(name), uid });

  test("a create mints an incarnation-unique native identity", async () => {
    const local = provider();
    const kv = offering("EdgeKVNamespace");
    const first = await local.apply({
      operationId: "op_1",
      offering: kv,
      identity: kvIdentity("cache", "uid-1"),
      spec: {},
    });
    const second = await local.apply({
      operationId: "op_2",
      offering: kv,
      identity: kvIdentity("cache", "uid-1"),
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
      identity: kvIdentity("cache", "uid-1"),
      spec: {},
      previous: { nativeId: firstId, spec: {} },
    });
    expect(updated.phase === "succeeded" ? updated.result.nativeId : "").toBe(firstId);
  });

  test("a namespace recreated under the same name is a different namespace", async () => {
    const local = provider();
    const kv = offering("EdgeKVNamespace");
    const before = await local.apply({
      operationId: "op_1",
      offering: kv,
      identity: kvIdentity("cache", "uid-before"),
      spec: {},
    });
    const after = await local.apply({
      operationId: "op_2",
      offering: kv,
      identity: kvIdentity("cache", "uid-after"),
      spec: {},
    });
    // Cloudflare gives a recreated namespace an empty one. So does this: the
    // rows are keyed by the derived id, and the id names the incarnation.
    expect(before.phase === "succeeded" ? before.result.outputs.namespaceId : "").not.toBe(
      after.phase === "succeeded" ? after.result.outputs.namespaceId : "",
    );
  });

  test("a queue recreated under the same name is a different queue", async () => {
    const local = provider();
    const queue = offering("AtLeastOnceQueue");
    const before = await local.apply({
      operationId: "op_1",
      offering: queue,
      identity: kvIdentity("delivery", "uid-before"),
      spec: { messageRetentionSeconds: 345_600, deliveryDelaySeconds: 0 },
    });
    const after = await local.apply({
      operationId: "op_2",
      offering: queue,
      identity: kvIdentity("delivery", "uid-after"),
      spec: { messageRetentionSeconds: 345_600, deliveryDelaySeconds: 0 },
    });
    // A queue is a store now, exactly as a KV namespace is: the messages are
    // keyed by the derived id, so a name reused after a delete must not name
    // the incarnation that already has messages in it.
    expect(before.phase === "succeeded" ? before.result.outputs.queueId : "").not.toBe(
      after.phase === "succeeded" ? after.result.outputs.queueId : "",
    );
  });

  test("an observation reports the queue id its messages are actually under", async () => {
    const local = provider();
    const queue = offering("AtLeastOnceQueue");
    const created = await local.apply({
      operationId: "op_1",
      offering: queue,
      identity: kvIdentity("delivery", "uid-1"),
      spec: {},
    });
    if (created.phase !== "succeeded") throw new Error("queue allocation failed");
    const observed = await local.observe({
      offering: queue,
      nativeId: created.result.nativeId,
      identity: identity("delivery"),
      spec: {},
    });
    expect(observed.phase === "succeeded" ? observed.result.outputs : {}).toEqual(
      created.result.outputs,
    );
  });

  test("an observation reports the namespace id its rows are actually under", async () => {
    const local = provider();
    const kv = offering("EdgeKVNamespace");
    const created = await local.apply({
      operationId: "op_1",
      offering: kv,
      identity: kvIdentity("cache", "uid-1"),
      spec: {},
    });
    if (created.phase !== "succeeded") throw new Error("namespace allocation failed");
    // Observation carries no Resource UID, so a recomputed name would be a
    // different one than the rows are stored under.
    const observed = await local.observe({
      offering: kv,
      nativeId: created.result.nativeId,
      identity: identity("cache"),
      spec: {},
    });
    expect(observed.phase === "succeeded" ? observed.result.outputs : {}).toEqual(
      created.result.outputs,
    );
  });

  test("deleting a namespace or a database reaches the planes that hold them", async () => {
    const deletedNamespaces: string[] = [];
    const forgotten: string[] = [];
    const local = provider({
      dataPlaneMaintenance: {
        async deleteKvNamespace(namespaceId) {
          deletedNamespaces.push(namespaceId);
        },
        async deleteQueue() {},
        forgetDatabase(name) {
          forgotten.push(name);
        },
        async objectBucketOccupancy() {
          return { objects: 0, uploads: 0 };
        },
        async deleteObjectBucket() {},
        async sweepExpiredKv() {
          return 0;
        },
        async sweepExpiredObjectUploads() {
          return 0;
        },
        async reconcileOrphanObjectFiles() {
          return 0;
        },
      },
    });
    const created = await local.apply({
      operationId: "op_1",
      offering: offering("EdgeKVNamespace"),
      identity: kvIdentity("cache", "uid-1"),
      spec: {},
    });
    if (created.phase !== "succeeded") throw new Error("namespace allocation failed");
    const namespaceId = String(created.result.outputs.namespaceId);
    expect(
      await local.delete({
        operationId: "op_2",
        offering: offering("EdgeKVNamespace"),
        nativeId: created.result.nativeId,
        identity: identity("cache"),
        spec: {},
      }),
    ).toMatchObject({ phase: "succeeded" });
    // The rows go with the namespace: leaving them was defensible while this
    // was a name with nothing behind it.
    expect(deletedNamespaces).toEqual([namespaceId]);

    const database = await local.apply({
      operationId: "op_3",
      offering: offering("SQLiteDatabase"),
      identity: identity("app"),
      spec: {},
    });
    if (database.phase !== "succeeded") throw new Error("database allocation failed");
    expect(
      await local.delete({
        operationId: "op_4",
        offering: offering("SQLiteDatabase"),
        nativeId: database.result.nativeId,
        identity: identity("app"),
        spec: {},
      }),
    ).toMatchObject({ phase: "succeeded" });
    // The file stays; the open handle on it must not, or a database declared
    // again under the same name would be served through the old inode.
    expect(forgotten).toEqual([String(database.result.observed.name)]);
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

/**
 * ADR 0007 let a Host support and activate the current ObjectBucket Form, and
 * a self-host admission does exactly that. This machine still has no
 * `edge.objects` backend, so the mutation barrier is where the truth is told.
 * Slice D2 replaces the refusal with a backend, not the refusal's reason.
 */
describe("bucketBindings on a self-host Worker Version", () => {
  const address = "127.0.0.1:65535";
  const BUCKET_ID = `tsb-${"f".repeat(40)}`;

  /** The realized bucket Deployment the Provider Pack materialized from. */
  function bucketRelation(overrides: Record<string, unknown> = {}): ProviderRelation {
    const base = deployedRelation(
      "/bucketBindings/0/resource",
      "ObjectBucket",
      "media",
      `selfhost-bucket:${BUCKET_ID}`,
      { bucketName: BUCKET_ID },
    );
    return {
      ...base,
      bindingRef: EDGE_OBJECTS_BINDING_REF,
      ...overrides,
      deployment: {
        ...(base.deployment as NonNullable<ProviderRelation["deployment"]>),
        ...((overrides.deployment as Record<string, unknown>) ?? {}),
      },
    } as ProviderRelation;
  }

  /** The `/worker` relation, deployed — a Version inherits its installation. */
  function deployedWorker(installationRef = "local.primary"): ProviderRelation {
    const base = deployedRelation("/worker", "ModuleWorker", "hello", "selfhost-worker:sw", {
      scriptName: "sw",
    });
    return {
      ...base,
      deployment: {
        ...(base.deployment as NonNullable<ProviderRelation["deployment"]>),
        providerInstallationRef: installationRef,
      },
    };
  }

  const runtimeBinding = (overrides: Record<string, unknown> = {}): ProviderRuntimeBinding =>
    ({
      name: "MEDIA",
      targetUid: "uid-ObjectBucket-media",
      bindingRef: EDGE_OBJECTS_BINDING_REF,
      material: { kind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND, bucketId: BUCKET_ID },
      ...overrides,
    }) as ProviderRuntimeBinding;

  async function applyVersion(
    local: ReturnType<typeof provider>,
    input: {
      readonly spec?: Record<string, unknown>;
      readonly relations?: readonly ProviderRelation[];
      readonly runtimeBindings?: readonly ProviderRuntimeBinding[];
    } = {},
  ) {
    return await local.apply({
      operationId: "op_version_bucket",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        bucketBindings: [
          {
            name: "MEDIA",
            resource: { apiVersion: EDGE_API, kind: "ObjectBucket", name: "media" },
          },
        ],
        ...(input.spec ?? {}),
      },
      relations: input.relations ?? [
        deployedWorker(),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
        bucketRelation(),
      ],
      runtimeBindings: input.runtimeBindings ?? [runtimeBinding()],
    });
  }

  test("publishes a Worker whose env.MEDIA is the exact edge.objects facade", async () => {
    const local = provider({ dataPlaneAddress: address });
    const worker = await local.apply({
      operationId: "op_worker",
      offering: offering("ModuleWorker"),
      identity: identity("hello"),
      spec: {},
    });
    if (worker.phase !== "succeeded") throw new Error("worker allocation failed");
    const script = String(worker.result.outputs.scriptName);

    const version = await applyVersion(local);
    if (version.phase !== "succeeded") {
      throw new Error(`version apply failed: ${JSON.stringify(version)}`);
    }
    expect(version.result.observed.dataBindingNames).toEqual(["MEDIA"]);
    // Names only: a bucket id is a fact about this machine, not identity.
    expect(JSON.stringify(version.result)).not.toContain(BUCKET_ID);

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

    const entrypoint = await readFile(
      join(root, "workers", script, "__takoserver-selfhost-entrypoint.js"),
      "utf8",
    );
    expect(entrypoint).toContain('"kind":"edge.objects@1.0.0","publicName":"MEDIA"');
    expect(entrypoint).toContain("createObjectsAdapter");
    // The bucket id lives in the Version's own record and never in the module.
    expect(entrypoint).not.toContain(BUCKET_ID);

    const versionId = versionDirectoryName(root, script);
    const stored = JSON.parse(
      await readFile(
        join(root, "selfhost", "version-bindings", script, `${versionId}.json`),
        "utf8",
      ),
    ) as { dataPlane: { bindings: { kind: string; name: string; target: string }[] } };
    expect(stored.dataPlane.bindings).toEqual([
      { kind: "edge.objects", name: "MEDIA", target: BUCKET_ID },
    ]);
  });

  test("refuses every mismatch between the declaration and what the pack materialized", async () => {
    const local = provider({ dataPlaneAddress: address });
    const cases: Record<string, Parameters<typeof applyVersion>[1]> = {
      // One runtime Binding per declaration, in the same order.
      noMaterial: { runtimeBindings: [] },
      extraMaterial: { runtimeBindings: [runtimeBinding(), runtimeBinding({ name: "OTHER" })] },
      // The exact Binding identity, digest included.
      wrongBindingVersion: {
        runtimeBindings: [
          runtimeBinding({ bindingRef: { ...EDGE_OBJECTS_BINDING_REF, version: "1.0.0" } }),
        ],
      },
      wrongSchemaDigest: {
        runtimeBindings: [
          runtimeBinding({
            bindingRef: { ...EDGE_OBJECTS_BINDING_REF, schemaDigest: `sha256:${"0".repeat(64)}` },
          }),
        ],
      },
      // The declaration's name and the Binding's name are one name.
      renamedDeclaration: {
        spec: {
          bucketBindings: [
            {
              name: "OTHER",
              resource: { apiVersion: EDGE_API, kind: "ObjectBucket", name: "media" },
            },
          ],
        },
      },
      // The relation's target and the Binding's target are one Resource.
      wrongTargetUid: { runtimeBindings: [runtimeBinding({ targetUid: "uid-somebody-else" })] },
      // A material another pack could have produced is not this Host's.
      foreignMaterial: {
        runtimeBindings: [
          runtimeBinding({
            material: { kind: "takoserver.cloudflare-r2.edge-objects@v1", bucketId: BUCKET_ID },
          }),
        ],
      },
      unshapedMaterial: {
        runtimeBindings: [
          runtimeBinding({
            material: { kind: SELFHOST_EDGE_OBJECTS_MATERIAL_KIND, bucketId: "../escape" },
          }),
        ],
      },
      // An active Deployment in the same installation, or nothing.
      draining: {
        relations: [
          deployedWorker(),
          relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
          bucketRelation({ deployment: { state: "draining" } }),
        ],
      },
      otherInstallation: {
        relations: [
          deployedWorker("local.secondary"),
          relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
          bucketRelation(),
        ],
      },
      undeployedWorker: {
        relations: [
          relation("/worker", "ModuleWorker", "hello"),
          relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
          bucketRelation(),
        ],
      },
      // A relation pointing at something that is not a bucket.
      wrongRelationKind: {
        relations: [
          deployedWorker(),
          relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
          deployedRelation(
            "/bucketBindings/0/resource",
            "EdgeKVNamespace",
            "media",
            `selfhost-bucket:${BUCKET_ID}`,
            { bucketName: BUCKET_ID },
          ),
        ],
      },
      // One name is one binding, across every kind on the Version.
      collidesWithVar: { spec: { vars: { MEDIA: "taken" } } },
      reservedName: {
        spec: {
          bucketBindings: [
            {
              name: "__TAKOSERVER_MEDIA",
              resource: { apiVersion: EDGE_API, kind: "ObjectBucket", name: "media" },
            },
          ],
        },
        runtimeBindings: [runtimeBinding({ name: "__TAKOSERVER_MEDIA" })],
      },
    };
    for (const [name, input] of Object.entries(cases)) {
      const ticket = await applyVersion(local, input);
      expect({ name, phase: ticket.phase }).toEqual({ name, phase: "failed" });
      expect(ticket.phase === "failed" ? ticket.failure.retryable : true).toBe(false);
      // Nothing is materialized behind a refusal.
      expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
    }
  });

  test("refuses a bucket binding on a deployment that serves no plane", async () => {
    const local = provider();
    expect(await applyVersion(local)).toMatchObject({
      phase: "failed",
      failure: { code: "denied", retryable: false },
    });
  });

  test("renders a version without bucket bindings byte-for-byte as it always did", async () => {
    const withoutBuckets = provider({ dataPlaneAddress: address });
    await publish(withoutBuckets, false, undefined, false);
    const plain = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    // A plain Version carries no generated entrypoint and no facade service at
    // all, which is the whole of the byte-identity claim.
    expect(plain).not.toContain("selfhost-entrypoint");
    expect(plain).not.toContain("selfhost-data");
    expect(plain).not.toContain("edge.objects");
  });
});

describe("the current ObjectBucket Form on a self-host", () => {
  const currentBucket: ProviderOffering = {
    id: "storage.object.stable-v1.standard",
    kind: "takoform.ObjectBucket",
    displayName: "Object bucket",
    form: {
      apiVersion: "edge.forms.takoform.com",
      kind: "ObjectBucket",
      definitionVersion: "0.1.0",
      schemaDigest: "sha256:154e2dcf100b1278f3badb7f7f2f25bba8c6bcf387c75fb6b9abc5ede1cbd557",
    },
    providedInterfaces: [],
    bindingRefs: [],
    capabilities: ["create", "delete", "import", "observe"],
  };
  const retainedBucket = offering("ObjectBucket");

  const bucketMaintenance = (
    state: { objects: number; uploads: number },
    destroyed: string[] = [],
  ) => ({
    async deleteKvNamespace() {},
    async deleteQueue() {},
    forgetDatabase() {},
    async objectBucketOccupancy() {
      return { objects: state.objects, uploads: state.uploads };
    },
    async deleteObjectBucket(bucketId: string) {
      destroyed.push(bucketId);
      state.objects = 0;
      state.uploads = 0;
    },
    async sweepExpiredKv() {
      return 0;
    },
    async sweepExpiredObjectUploads() {
      return 0;
    },
    async reconcileOrphanObjectFiles() {
      return 0;
    },
  });

  test("creates one under the incarnation this Host derives", async () => {
    const local = provider();
    const ticket = await local.apply({
      operationId: "op_current_bucket",
      offering: currentBucket,
      identity: { ...identity("media"), uid: "uid-media" },
      spec: {},
    });
    if (ticket.phase !== "succeeded") throw new Error("the bucket was not created");
    const name = String(ticket.result.outputs.bucketName);
    expect(name).toMatch(/^tsb-[0-9a-f]{40}$/u);
    expect(ticket.result.nativeId).toBe(`selfhost-bucket:${name}`);
    // No endpoint, region, credential, or supply document crosses the seam.
    expect(Object.keys(ticket.result.outputs)).toEqual(["bucketName"]);

    // The name is a pure function of the incarnation, so a retry is the same
    // agreement rather than a second bucket.
    const again = await local.apply({
      operationId: "op_current_bucket_retry",
      offering: currentBucket,
      identity: { ...identity("media"), uid: "uid-media" },
      spec: {},
    });
    expect(again).toMatchObject({
      phase: "succeeded",
      result: { nativeId: ticket.result.nativeId },
    });

    // A bucket declared again under the same NAME after a destroy is a
    // different incarnation, and therefore a different bucket.
    const reborn = await local.apply({
      operationId: "op_current_bucket_reborn",
      offering: currentBucket,
      identity: { ...identity("media"), uid: "uid-media-2" },
      spec: {},
    });
    if (reborn.phase !== "succeeded") throw new Error("the bucket was not created");
    expect(reborn.result.nativeId).not.toBe(ticket.result.nativeId);
  });

  test("refuses a declaration with no Resource identity to derive from", async () => {
    const local = provider();
    expect(
      await local.apply({
        operationId: "op_current_bucket_anonymous",
        offering: currentBucket,
        identity: identity("media"),
        spec: {},
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec", retryable: false } });
  });

  test("adopts only the bucket it derives for this Resource address", async () => {
    const local = provider();
    const adopt = local.adopt;
    if (!adopt) throw new Error("the self-host provider must offer import");
    const derived = await local.apply({
      operationId: "op_current_bucket_for_import",
      offering: currentBucket,
      identity: { ...identity("media"), uid: "uid-media" },
      spec: {},
    });
    if (derived.phase !== "succeeded") throw new Error("the bucket was not created");

    for (const nativeId of [
      "local-bucket:whatever",
      `selfhost-bucket:tsb-${"0".repeat(40)}`,
      "selfhost-bucket:../escape",
      "takoserver-objects-production",
    ]) {
      expect(
        await adopt.call(local, {
          operationId: "op_current_bucket_adopt_foreign",
          offering: currentBucket,
          nativeId,
          identity: { ...identity("media"), uid: "uid-media" },
          spec: {},
        }),
      ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec", retryable: false } });
    }

    // The one address a configuration already manages is adoptable, which is
    // the documented repair after a lost create acknowledgement.
    expect(
      await adopt.call(local, {
        operationId: "op_current_bucket_adopt",
        offering: currentBucket,
        nativeId: derived.result.nativeId,
        identity: { ...identity("media"), uid: "uid-media" },
        spec: {},
      }),
    ).toMatchObject({ phase: "succeeded", result: { nativeId: derived.result.nativeId } });
  });

  test("refuses to destroy a bucket that still holds objects, but not one mid-upload", async () => {
    const destroyed: string[] = [];
    const state = { objects: 2, uploads: 0 };
    const local = provider({ dataPlaneMaintenance: bucketMaintenance(state, destroyed) });
    const created = await local.apply({
      operationId: "op_current_bucket_delete",
      offering: currentBucket,
      identity: { ...identity("media"), uid: "uid-media" },
      spec: {},
    });
    if (created.phase !== "succeeded") throw new Error("the bucket was not created");

    expect(
      await local.delete({
        operationId: "op_current_bucket_delete_full",
        offering: currentBucket,
        nativeId: created.result.nativeId,
        identity: { ...identity("media"), uid: "uid-media" },
      }),
    ).toMatchObject({
      phase: "failed",
      failure: {
        // Not `conflict`: that renders as the automatically retryable
        // `resource_busy`, and waiting never empties a bucket.
        code: "occupied",
        retryable: false,
        message:
          "the bucket still holds objects, and this Host does not empty a bucket for you; " +
          "delete its contents and destroy again",
      },
    });
    expect(destroyed).toEqual([]);

    // An object beside an unfinished upload still refuses: the objects are the
    // customer's storage, and this Host does not empty one for them.
    state.objects = 1;
    state.uploads = 1;
    expect(
      await local.delete({
        operationId: "op_current_bucket_delete_mixed",
        offering: currentBucket,
        nativeId: created.result.nativeId,
        identity: { ...identity("media"), uid: "uid-media" },
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "occupied" } });
    expect(destroyed).toEqual([]);

    // An unfinished upload alone does not. Nothing the Binding declares can
    // list one, and the upload id that could abort it lived in an isolate that
    // is gone — so refusing on it would make a bucket the customer can see is
    // empty permanently undeletable. The destroy takes it with everything else.
    state.objects = 0;
    state.uploads = 1;
    expect(
      await local.delete({
        operationId: "op_current_bucket_delete_abandoned",
        offering: currentBucket,
        nativeId: created.result.nativeId,
        identity: { ...identity("media"), uid: "uid-media" },
      }),
    ).toMatchObject({ phase: "succeeded", result: { observed: { deleted: true } } });
    expect(destroyed).toEqual([String(created.result.outputs.bucketName)]);
    expect(state).toEqual({ objects: 0, uploads: 0 });
  });

  test("proves a delete only once the bucket is empty, and never by writing", async () => {
    const destroyed: string[] = [];
    const state = { objects: 1, uploads: 0 };
    const local = provider({ dataPlaneMaintenance: bucketMaintenance(state, destroyed) });
    const created = await local.apply({
      operationId: "op_current_bucket_recover",
      offering: currentBucket,
      identity: { ...identity("media"), uid: "uid-media" },
      spec: {},
    });
    if (created.phase !== "succeeded") throw new Error("the bucket was not created");
    const recover = local.recoverDelete;
    if (!recover) throw new Error("the self-host provider must offer delete recovery");
    const ask = () =>
      recover.call(local, {
        operationId: "op_current_bucket_recover_delete",
        offering: currentBucket,
        nativeId: created.result.nativeId,
        identity: { ...identity("media"), uid: "uid-media" },
      });
    expect(await ask()).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    state.objects = 0;
    expect(await ask()).toMatchObject({
      phase: "succeeded",
      result: { observed: { deleted: true } },
    });
    // Readback only: recovery never destroys what a delete had not.
    expect(destroyed).toEqual([]);
  });

  test("proves a bucket present while it holds anything and absent once it does not", async () => {
    const state = { objects: 1, uploads: 0 };
    const local = provider({ dataPlaneMaintenance: bucketMaintenance(state) });
    const created = await local.apply({
      operationId: "op_current_bucket_absence",
      offering: currentBucket,
      identity: { ...identity("media"), uid: "uid-media" },
      spec: {},
    });
    if (created.phase !== "succeeded") throw new Error("the bucket was not created");
    if (!local.createNativeReadbackDescriptor || !local.verifyNativeAbsence) {
      throw new Error("selfhost provider must expose native absence readback");
    }
    const descriptor = local.createNativeReadbackDescriptor({
      offering: currentBucket,
      nativeId: created.result.nativeId,
      identity: { ...identity("media"), uid: "uid-media" },
    });
    expect(await local.verifyNativeAbsence({ offering: currentBucket, descriptor })).toMatchObject({
      outcome: "present",
    });
    state.objects = 0;
    expect(await local.verifyNativeAbsence({ offering: currentBucket, descriptor })).toMatchObject({
      outcome: "absent",
    });
  });

  test("keeps the retained v1beta1 drain working", async () => {
    const local = provider();
    const created = await local.apply({
      operationId: "op_retained_bucket",
      offering: retainedBucket,
      identity: identity("legacy"),
      spec: {},
    });
    expect(created).toMatchObject({
      phase: "succeeded",
      result: { outputs: { protocol: "s3" } },
    });
    if (created.phase !== "succeeded") throw new Error("expected success");
    const observed = await local.observe({
      offering: retainedBucket,
      nativeId: created.result.nativeId,
      identity: identity("legacy"),
      spec: {},
    });
    expect(observed).toMatchObject({ phase: "succeeded" });
    const deleted = await local.delete({
      operationId: "op_retained_bucket_delete",
      offering: retainedBucket,
      nativeId: created.result.nativeId,
      identity: identity("legacy"),
    });
    expect(deleted).toMatchObject({ phase: "succeeded", result: { observed: { deleted: true } } });
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
        handlers: ["fetch"],
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

/**
 * A Queue Consumer and a Cron Trigger are declarations until something on the
 * machine moves the message or fires the minute. The ticket has to say which of
 * those is true, because an observation that lies is worse than a missing
 * feature: an operator reading `delivering: true` on a machine with no pump has
 * no way left to find out.
 */
describe("attaching a Queue Consumer and a Cron Trigger", () => {
  const QUEUE_ID = "tsq-attachment-fixture";
  const DLQ_ID = "tsq-attachment-fixture-dlq";
  const EVENTS = {
    async forgetSchedules() {},
  };

  /** Where one Version's durable binding record lives on this machine. */
  const recordPath = (script: string) =>
    join(
      root,
      "selfhost",
      "version-bindings",
      script,
      `${versionDirectoryName(root, script)}.json`,
    );

  function queueRelation(pointer: string, name: string, id: string): ProviderRelation {
    return {
      ...deployedRelation(pointer, "AtLeastOnceQueue", name, `selfhost-queue:${id}:op_q`, {
        queueId: id,
        queueName: id,
      }),
      resource: {
        ...relation(pointer, "AtLeastOnceQueue", name, {
          messageRetentionSeconds: 345_600,
          deliveryDelaySeconds: 0,
        }).resource,
      },
    };
  }

  const consumerSpec = {
    worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
    queue: { apiVersion: EDGE_API, kind: "AtLeastOnceQueue", name: "delivery" },
    maxBatchSize: 10,
    maxBatchTimeoutSeconds: 1,
    maxRetries: 3,
    retryDelaySeconds: 60,
    maxConcurrency: 4,
  };

  const applyConsumer = (
    local: ReturnType<typeof provider>,
    spec: Record<string, unknown> = {},
    relations: readonly ProviderRelation[] = [],
  ) =>
    local.apply({
      operationId: "op_consumer",
      offering: offering("QueueConsumer"),
      identity: identity("hello-consumer"),
      spec: { ...consumerSpec, ...spec },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        queueRelation("/queue", "delivery", QUEUE_ID),
        ...relations,
      ],
    });

  const applyCron = (local: ReturnType<typeof provider>, cron: string) =>
    local.apply({
      operationId: "op_cron",
      offering: offering("WorkerCronTrigger"),
      identity: identity("hello-cron"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" }, cron },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });

  test("says it is delivering and scheduled only when this machine runs both", async () => {
    const configured = provider({ events: EVENTS });
    await publish(configured);
    expect(await applyConsumer(configured)).toMatchObject({
      phase: "succeeded",
      result: { observed: { queueName: QUEUE_ID, delivering: true } },
    });
    expect(await applyCron(configured, "0 * * * *")).toMatchObject({
      phase: "succeeded",
      result: { observed: { cron: "0 * * * *", scheduled: true } },
    });

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
    const bare = provider();
    await publish(bare);
    // Still recorded, still republished — the declaration is desired state
    // either way — and honestly reported as moving nothing.
    expect(await applyConsumer(bare)).toMatchObject({
      phase: "succeeded",
      result: { observed: { delivering: false } },
    });
    expect(await applyCron(bare, "0 * * * *")).toMatchObject({
      phase: "succeeded",
      result: { observed: { scheduled: false } },
    });
  });

  test("refuses an attachment to a Version it could never deliver to", async () => {
    const local = provider({ events: EVENTS });
    const script = await publish(local);
    // Exactly what an upgraded machine has: a Version published before this
    // Host recorded handlers and minted an event token. Earlier builds removed
    // the record entirely for a Version that declared no binding.
    rmSync(recordPath(script), { force: true });

    expect(await applyCron(local, "0 * * * *")).toMatchObject({
      phase: "failed",
      failure: {
        code: "invalid_spec",
        message:
          "the active Worker Version predates event delivery on this Host; publish a new Version",
      },
    });
    // Refused BEFORE the durable state moved: nothing was attached, so nothing
    // is left claiming a delivery that can never happen.
    const state = JSON.parse(
      readFileSync(join(root, "selfhost", "scripts", `${script}.json`), "utf8"),
    ) as { crons?: readonly string[]; consumers?: readonly unknown[] };
    expect(state.crons ?? []).toEqual([]);
    expect(state.consumers ?? []).toEqual([]);
    // And the script is not wedged: a later republish of it still succeeds.
    expect(
      (
        await local.apply({
          operationId: "op_domain",
          offering: offering("WorkerCustomDomain"),
          identity: identity("hello-domain"),
          spec: {
            worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
            hostname: "attached.localhost",
          },
          relations: [relation("/worker", "ModuleWorker", "hello")],
        })
      ).phase,
    ).toBe("succeeded");
  });

  test("an attachment the publication definitely refused does not stay behind", async () => {
    // A bundle carrying a module under this Host's own generated name. It
    // publishes fine while nothing is attached, because a Version with no
    // binding gets no generated entrypoint at all; the attachment is what asks
    // for one, and asking is what the publication refuses.
    const local = provider({
      events: EVENTS,
      modules: {
        "index.js": "export default {}",
        "__takoserver-selfhost-entrypoint.js": "export default {}",
      },
    });
    const script = await publish(local);
    expect(await applyCron(local, "0 * * * *")).toMatchObject({
      phase: "failed",
      failure: {
        code: "invalid_spec",
        message: "the Worker bundle claims this Host's entrypoint module name",
      },
    });
    // Rolled back, so a later republish of the script is not the same refusal
    // for ever. Before this, one refused attach wedged every domain, endpoint,
    // and deployment change the Worker would ever see.
    const state = JSON.parse(
      readFileSync(join(root, "selfhost", "scripts", `${script}.json`), "utf8"),
    ) as { crons?: readonly string[] };
    expect(state.crons ?? []).toEqual([]);
    expect(
      (
        await local.apply({
          operationId: "op_domain",
          offering: offering("WorkerCustomDomain"),
          identity: identity("hello-domain"),
          spec: {
            worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
            hostname: "attached.localhost",
          },
          relations: [relation("/worker", "ModuleWorker", "hello")],
        })
      ).phase,
    ).toBe("succeeded");
  });

  test("refuses a cron expression this Host could record and never fire", async () => {
    const local = provider({ events: EVENTS });
    await publish(local);
    expect(await applyCron(local, "0 * * *")).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec" },
    });
    expect(await applyCron(local, "0 * * * MON")).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec" },
    });
  });

  test("refuses a Consumer whose queue this provider did not deploy", async () => {
    const local = provider({ events: EVENTS });
    await publish(local);
    const ticket = await local.apply({
      operationId: "op_consumer",
      offering: offering("QueueConsumer"),
      identity: identity("hello-consumer"),
      spec: consumerSpec,
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        // Declared but never deployed here: the native id and the published
        // output are what say which queue this is, and there are neither.
        relation("/queue", "AtLeastOnceQueue", "delivery", {
          messageRetentionSeconds: 345_600,
        }),
      ],
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", message: "the Queue Consumer is incomplete" },
    });
  });

  test("refuses a Consumer whose declared dead-letter queue is not resolvable", async () => {
    const local = provider({ events: EVENTS });
    await publish(local);
    expect(
      await applyConsumer(local, {
        deadLetterQueue: { apiVersion: EDGE_API, kind: "AtLeastOnceQueue", name: "dlq" },
      }),
    ).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec" },
    });
    expect(
      await applyConsumer(
        local,
        { deadLetterQueue: { apiVersion: EDGE_API, kind: "AtLeastOnceQueue", name: "dlq" } },
        [queueRelation("/deadLetterQueue", "dlq", DLQ_ID)],
      ),
    ).toMatchObject({ phase: "succeeded" });
  });

  test("refuses a limit outside the range its Form fixes", async () => {
    const local = provider({ events: EVENTS });
    await publish(local);
    expect(await applyConsumer(local, { maxBatchSize: 101 })).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", message: "the Queue Consumer limits are invalid" },
    });
    expect(await applyConsumer(local, { maxConcurrency: undefined })).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec" },
    });
  });

  test("puts the event gate in front of the Worker only once something is attached", async () => {
    const local = provider({ events: EVENTS });
    const script = await publish(local);
    const before = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(before).not.toContain("selfhost-events");

    expect((await applyCron(local, "0 * * * *")).phase).toBe("succeeded");
    const after = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    // A Host-owned service holding the token, and a route that reaches it
    // rather than the script.
    expect(after).toContain(`( name = "${script}-selfhost-events"`);
    expect(after).toContain(`entrypoint = "takoserverSelfhostEvents"`);
    expect(after).toContain(`${script}.selfhost-events.invalid\\":\\"${script}-selfhost-events`);
    // The token is on the gate and on nothing else.
    const tenantService = after.slice(
      after.indexOf(`( name = "${script}",`),
      after.indexOf(`( name = "${script}-selfhost-events"`),
    );
    expect(tenantService).not.toContain("__TAKOSERVER_SELFHOST_EVENT_TOKEN");
  });

  test("a Worker Version binding a queue on a machine with no plane is refused", async () => {
    const local = provider();
    const worker = await local.apply({
      operationId: "op_worker",
      offering: offering("ModuleWorker"),
      identity: identity("hello"),
      spec: {},
    });
    expect(worker.phase).toBe("succeeded");
    const ticket = await local.apply({
      operationId: "op_version_queue",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch", "queue"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        queueProducerBindings: [
          {
            name: "QUEUE",
            resource: { apiVersion: EDGE_API, kind: "AtLeastOnceQueue", name: "delivery" },
          },
        ],
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
        queueRelation("/queueProducerBindings/0/resource", "delivery", QUEUE_ID),
      ],
    });
    expect(ticket).toMatchObject({
      phase: "failed",
      failure: {
        code: "denied",
        message:
          "this deployment serves no data plane, so the Worker Version's bindings cannot be projected",
      },
    });
  });

  test("an attachment's absence is read from durable state, not asserted", async () => {
    const forgotten: string[] = [];
    const local = provider({
      events: {
        async forgetSchedules(_script, cron) {
          forgotten.push(cron ?? "*");
        },
      },
    });
    await publish(local);
    const applied = await applyCron(local, "0 * * * *");
    if (applied.phase !== "succeeded") throw new Error("the cron trigger did not attach");
    if (!local.createNativeReadbackDescriptor || !local.verifyNativeAbsence) {
      throw new Error("selfhost provider must expose native absence readback");
    }
    const descriptor = local.createNativeReadbackDescriptor({
      offering: offering("WorkerCronTrigger"),
      nativeId: applied.result.nativeId,
      identity: identity("hello-cron"),
      spec: { cron: "0 * * * *" },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    const cronOffering = offering("WorkerCronTrigger");
    expect(await local.verifyNativeAbsence({ offering: cronOffering, descriptor })).toMatchObject({
      outcome: "present",
    });

    expect(
      (
        await local.delete({
          operationId: "op_delete_cron",
          offering: offering("WorkerCronTrigger"),
          identity: identity("hello-cron"),
          nativeId: applied.result.nativeId,
          spec: {
            worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
            cron: "0 * * * *",
          },
          relations: [relation("/worker", "ModuleWorker", "hello")],
        })
      ).phase,
    ).toBe("succeeded");
    expect(forgotten).toEqual(["0 * * * *"]);
    expect(await local.verifyNativeAbsence({ offering: cronOffering, descriptor })).toMatchObject({
      outcome: "absent",
    });
    // And the gate goes with it: nothing delivers to this Worker any more.
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).not.toContain("selfhost-events");
  });

  test("a queue delete drops the messages that queue was holding", async () => {
    const dropped: string[] = [];
    // Through the storage seam rather than the pump's: a queue stops existing
    // whether or not this deployment happens to run one.
    const local = provider({
      dataPlaneMaintenance: {
        async deleteKvNamespace() {},
        async deleteQueue(id) {
          dropped.push(id);
        },
        forgetDatabase() {},
        async objectBucketOccupancy() {
          return { objects: 0, uploads: 0 };
        },
        async deleteObjectBucket() {},
        async sweepExpiredKv() {
          return 0;
        },
        async sweepExpiredObjectUploads() {
          return 0;
        },
        async reconcileOrphanObjectFiles() {
          return 0;
        },
      },
    });
    const ticket = await local.delete({
      operationId: "op_delete_queue",
      offering: offering("AtLeastOnceQueue"),
      identity: identity("delivery"),
      nativeId: `selfhost-queue:${QUEUE_ID}:op_q`,
      spec: {},
    });
    expect(ticket.phase).toBe("succeeded");
    expect(dropped).toEqual([QUEUE_ID]);
  });
});
