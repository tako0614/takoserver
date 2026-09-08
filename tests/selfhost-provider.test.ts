import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { mkdir, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEphemeralSql } from "../src/compat.ts";
import { canonicalDigest } from "../src/json.ts";
import type {
  ProviderOffering,
  ProviderRelation,
  ProviderRuntimeBinding,
  ProviderTicket,
} from "../src/provider-port.ts";
import type { ProviderRuntimeInputLeasePort } from "../src/provider-runtime-input-port.ts";
import { EDGE_OBJECTS_BINDING_REF } from "../src/providers/cloudflare-runtime-bindings.ts";
import {
  createSelfhostDataPlaneAccess,
  createSelfhostEventTargets,
  createSelfhostProvider,
  type SelfhostDataPlaneMaintenance,
  selfhostDatabasePath,
} from "../src/providers/selfhost.ts";
import { SELFHOST_WORKER_EVENT_PROTOCOL } from "../src/providers/selfhost-events.ts";
import { SELFHOST_EDGE_OBJECTS_MATERIAL_KIND } from "../src/providers/selfhost-runtime-bindings.ts";
import {
  SELFHOST_WORKER_READINESS_PATH,
  SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
} from "../src/providers/selfhost-worker-wrapper.ts";
import { createRuntimeInputAuthority } from "../src/runtime-input-preparations.ts";
import { createSelfhostWorkerScheduler } from "../src/selfhost-scheduler.ts";
import {
  TAKOFORM_MAXIMUM_FILE_BUNDLE_FILES,
  TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES,
} from "../src/takoform/limits.ts";
import {
  createWorkerdRuntime,
  type WorkerdRuntime,
  type WorkerdSite,
} from "../src/workerd-runtime.ts";

/**
 * Running somebody's Worker on a machine you own is what makes a self-hosted
 * deployment a platform rather than a place to keep files. The chain under
 * test is the released Edge Family's: a WorkerVersion stores a committed
 * bundle, a single-version WorkerDeployment publishes it into workerd, and
 * the endpoint and domain attachments decide which hostnames route to it.
 */

const EDGE_API = "edge.forms.takoform.com/v1beta1";
const MODULE_WORKER_SERVICE_BINDING_REF = {
  apiVersion: "bindings.takoform.com/v1alpha2",
  name: "module-worker.service",
  version: "1.0.0",
  schemaDigest: "sha256:79c3a23e506ffc4607ea2921e3dbe76c7d44b20c76e6181e65c611239b9c51aa",
} as const;

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
const sqliteIdentity = (name: string, uid = `uid-${name}`) => ({
  ...identity(name),
  uid,
});
const readTarget = (name: string) => ({
  tenantId: "org_demo",
  resourceUid: `uid-${name}`,
  incarnationId: `dep-${name}`,
  generation: "1",
});

/** The one materialized version directory under a script, whichever id it got. */
function versionDirectoryName(dataRoot: string, script: string): string {
  const entries = readdirSync(join(dataRoot, "selfhost", "versions", script));
  const first = entries[0];
  if (entries.length !== 1 || !first) throw new Error("expected exactly one materialized version");
  return first;
}

async function publishedModule(
  dataRoot: string,
  script: string,
  provenance: "application" | "hostPrivate",
  name: string,
): Promise<string> {
  const stable = JSON.parse(
    await readFile(join(dataRoot, "workers", script, "takoserver-site.json"), "utf8"),
  ) as {
    publicationStorageLayout?: string;
    generationKey?: string;
    moduleFiles: Record<"application" | "hostPrivate", { name: string; key: string }[]>;
  };
  let manifest = stable;
  let moduleRoot = join(dataRoot, "workers", script);
  if (
    stable.publicationStorageLayout === "weighted-deployment-v1" &&
    typeof stable.generationKey === "string"
  ) {
    const generationRoot = join(dataRoot, "workers", ".publications", script, stable.generationKey);
    const deployment = JSON.parse(
      await readFile(join(generationRoot, "deployment.json"), "utf8"),
    ) as {
      versions: {
        storageKey: string;
        manifest: typeof stable;
      }[];
    };
    const version = deployment.versions[0];
    if (!version) throw new Error("published deployment Version is absent");
    manifest = version.manifest;
    moduleRoot = join(generationRoot, version.storageKey);
  }
  const entry = manifest.moduleFiles[provenance].find((candidate) => candidate.name === name);
  if (!entry) throw new Error(`published ${provenance} module is absent: ${name}`);
  return await readFile(
    join(moduleRoot, provenance === "application" ? "application" : "host-private", entry.key),
    "utf8",
  );
}

const endpointAssignment = (hostname = "reserved.localhost") => ({
  canonicalPublicOrigin: `https://${hostname}`,
  assignmentDigest: `sha256:${"e".repeat(64)}` as const,
});

let root: string;
const configProbeServers = new Set<ReturnType<typeof Bun.serve>>();

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
});

afterEach(() => {
  for (const server of configProbeServers) server.stop(true);
  configProbeServers.clear();
  rmSync(root, { recursive: true, force: true });
});

interface ProviderCase {
  readonly modules?: Record<string, string>;
  readonly siteFiles?: readonly string[];
  readonly events?: {
    forgetSchedules(script: string, cron?: string): Promise<void>;
  };
  readonly dataPlaneAddress?: string;
  readonly workerEndpointScheme?: "https" | "http";
  readonly workerEndpointPort?: number;
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

/**
 * A runtime that behaves the way workerd does: one live configuration at a
 * time, and a readiness answer that names whichever publication is live.
 *
 * `flakyRuntime` answers `has()` and nothing else, so it cannot show a
 * publication being answered about a configuration that replaced it. This one
 * can. Each step yields, because a race between two publications is a race
 * between their `await` points and a synchronous fake has none.
 */
function servingRuntime(): {
  readonly runtime: WorkerdRuntime;
  readonly state: { readonly log: string[] };
} {
  const staged = new Map<string, string>();
  const live = new Map<string, string>();
  const log: string[] = [];
  const yieldTurn = () => new Promise<void>((wake) => setTimeout(wake, 0));
  return {
    state: { log },
    runtime: {
      async inspectModule(input) {
        return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
      },
      async write(name, site) {
        log.push("write");
        await yieldTurn();
        staged.set(name, String(site.generation ?? ""));
      },
      async remove(name) {
        staged.delete(name);
        live.delete(name);
      },
      async reload() {
        log.push("reload");
        await yieldTurn();
        for (const [name, generation] of staged) live.set(name, generation);
      },
      async has(name, generation) {
        return generation === undefined ? live.has(name) : live.get(name) === generation;
      },
      async probe(name) {
        log.push("probe");
        await yieldTurn();
        const generation = live.get(name);
        if (generation === undefined) return null;
        return {
          status: 200,
          body: JSON.stringify({
            schema: SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
            publication: createHash("sha256").update(generation, "utf8").digest("hex"),
          }),
        };
      },
    },
  };
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
      async inspectModule(input) {
        return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
      },
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

const TEST_WORKER_SOURCE = "export default { fetch() {}, queue() {}, scheduled() {} };";

function materializingRuntime(
  options: Parameters<typeof createWorkerdRuntime>[0],
): ReturnType<typeof createWorkerdRuntime> {
  return Object.assign(createWorkerdRuntime(options), {
    async inspectModule(input: Parameters<WorkerdRuntime["inspectModule"]>[0]) {
      return { outcome: "valid" as const, exportedHandlers: [...input.declaredHandlers] };
    },
  });
}

function normalizeGeneratedWorkerdConfig(config: string): string {
  return config.replace(/[0-9a-f]{64}/gu, "<hash>");
}

function privateVersionService(config: string): string {
  const name = /^ {2}\( name = "(selfhost-version-[0-9a-f]{64})",$/mu.exec(config)?.[1];
  if (!name) throw new Error("private Worker Version service is absent");
  return name;
}

/** A loopback watcher emulator that proves the exact config identity it loaded. */
function probedMaterializingRuntime(
  afterLoad?: (invocation: number, config: string) => void | Promise<void>,
): { readonly runtime: ReturnType<typeof materializingRuntime>; readonly reloads: () => number } {
  let serving: {
    readonly identity: string;
    readonly token: string;
    readonly readinessPublication?: string;
  } | null = null;
  let reloads = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (
        serving?.readinessPublication &&
        request.method === "POST" &&
        url.pathname === SELFHOST_WORKER_READINESS_PATH
      ) {
        return Response.json({
          schema: SELFHOST_WORKER_READINESS_RESULT_SCHEMA,
          publication: serving.readinessPublication,
        });
      }
      if (
        serving === null ||
        request.method !== "POST" ||
        request.headers.get("host") !== "runtime.selfhost-config.invalid" ||
        url.pathname !== "/.well-known/takoserver/selfhost-runtime-config/v1" ||
        request.headers.get("x-takoserver-selfhost-runtime-config") !== serving.token
      ) {
        return new Response(null, { status: 404 });
      }
      return new Response(null, {
        status: 204,
        headers: { "x-takoserver-selfhost-config-identity": serving.identity },
      });
    },
  });
  configProbeServers.add(server);
  const port = server.port;
  if (port === undefined) throw new Error("config probe did not bind a port");
  return {
    runtime: materializingRuntime({
      root,
      port,
      isReady: () => true,
      onReload: async (path) => {
        const config = await readFile(path, "utf8");
        const identity = /\(name = "CONFIG_IDENTITY", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
        const token = /\(name = "CONFIG_PROBE_TOKEN", text = "([0-9a-f]{64})"\)/u.exec(config)?.[1];
        const readinessPublication = /\(name = "PUBLICATION", text = "([0-9a-f]{64})"\)/u.exec(
          config,
        )?.[1];
        if (!identity || !token) throw new Error("invalid config probe declaration");
        serving = {
          identity,
          token,
          ...(readinessPublication ? { readinessPublication } : {}),
        };
        reloads += 1;
        await afterLoad?.(reloads, config);
      },
    }),
    reloads: () => reloads,
  };
}

function provider(options: ProviderCase = {}) {
  const modules = options.modules ?? { "index.js": TEST_WORKER_SOURCE };
  return createSelfhostProvider({
    offerings: [],
    dataRoot: root,
    runtime: options.runtime ?? materializingRuntime({ root, isReady: () => true }),
    ...(options.suffixes ? { suffixes: options.suffixes } : {}),
    ...(options.workerEndpointScheme ? { workerEndpointScheme: options.workerEndpointScheme } : {}),
    ...(options.workerEndpointPort === undefined
      ? {}
      : { workerEndpointPort: options.workerEndpointPort }),
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
            files: (options.siteFiles ?? ["index.html", "app.css"]).map((path) => ({
              path,
              digest: `sha256:${path}`,
              mediaType: path === "index.html" ? "text/html" : "text/css",
            })),
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

/** Drives the chain and asserts it published, answering the script name. */
async function publish(
  local: ReturnType<typeof provider>,
  assets = false,
  vars?: Record<string, string | number>,
  dataBindings = false,
  handlers: readonly string[] = ["fetch"],
): Promise<string> {
  const { script, deployment } = await publishChain(local, assets, vars, dataBindings, handlers);
  expect(deployment.phase).toBe("succeeded");
  return script;
}

/** Drives the worker → version → deployment chain one apply at a time. */
async function publishChain(
  local: ReturnType<typeof provider>,
  assets = false,
  vars?: Record<string, string | number>,
  dataBindings = false,
  handlers: readonly string[] = ["fetch"],
): Promise<{ readonly script: string; readonly deployment: ProviderTicket }> {
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
      handlers,
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
  return { script, deployment };
}

describe("publishing a Worker through the Edge Family", () => {
  test("publishes, observes, adopts, and deletes one exact canonical weighted deployment", async () => {
    const local = provider();
    const script = await publish(local);
    const second = await local.apply({
      operationId: "op_weighted_second_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v2"),
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
    expect(second.phase).toBe("succeeded");
    const input = {
      offering: offering("WorkerDeployment"),
      identity: identity("hello-live"),
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        versions: [
          {
            workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "hello-v2" },
            weight: 1,
          },
          {
            workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "hello-v1" },
            weight: 9_999,
          },
        ],
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/versions/0/workerVersion", "WorkerVersion", "hello-v2"),
        relation("/versions/1/workerVersion", "WorkerVersion", "hello-v1"),
      ],
    };
    expect(await local.apply({ ...input, operationId: "op_split" })).toMatchObject({
      phase: "succeeded",
      result: {
        observed: {
          versions: expect.arrayContaining([
            expect.objectContaining({ weight: 1 }),
            expect.objectContaining({ weight: 9_999 }),
          ]),
        },
      },
    });
    const durable = JSON.parse(
      await readFile(join(root, "selfhost", "scripts", `${script}.json`), "utf8"),
    ) as {
      deployment: {
        versions: { versionId: string; workerVersionUid: string; weight: number }[];
      };
    };
    expect(durable.deployment.versions).toEqual([
      {
        workerVersionUid: "uid-WorkerVersion-hello-v1",
        versionId: expect.any(String),
        weight: 9_999,
      },
      { workerVersionUid: "uid-WorkerVersion-hello-v2", versionId: expect.any(String), weight: 1 },
    ]);
    const observation = { ...input, nativeId: `selfhost-deployment:${script}:op_deploy` };
    expect(await local.observe(observation)).toMatchObject({ phase: "succeeded" });
    if (!local.adopt) throw new Error("the self-host adoption path is missing");
    expect(await local.adopt({ ...observation, operationId: "op_adopt_split" })).toMatchObject({
      phase: "succeeded",
    });
    expect(await local.delete({ ...observation, operationId: "op_delete_split" })).toMatchObject({
      phase: "succeeded",
    });
  });

  test("event selection follows the exact deployment restored after an update fails", async () => {
    let rejectNextActivation = false;
    const watched = probedMaterializingRuntime(() => {
      if (rejectNextActivation) {
        rejectNextActivation = false;
        throw new Error("new weighted graph failed after the watcher loaded it");
      }
    });
    const invoked: Array<{ readonly deploymentId?: string }> = [];
    const runtime: WorkerdRuntime = {
      ...watched.runtime,
      async probe(name, path, init) {
        if (init.route === "events") {
          invoked.push(JSON.parse(init.body ?? "{}") as { deploymentId?: string });
          return {
            status: 200,
            body: JSON.stringify({
              protocol: SELFHOST_WORKER_EVENT_PROTOCOL,
              kind: "schedule",
              outcome: "ack",
            }),
          };
        }
        return (await watched.runtime.probe?.(name, path, init)) ?? null;
      },
    };
    const local = provider({ runtime, events: { async forgetSchedules() {} } });
    const script = await publish(local, false, undefined, false, ["fetch", "scheduled"]);
    const trigger = await local.apply({
      operationId: "op_failed_weighted_cron",
      offering: offering("WorkerCronTrigger"),
      identity: identity("hello-cron"),
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        cron: "* * * * *",
      },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(trigger.phase).toBe("succeeded");
    const second = await local.apply({
      operationId: "op_failed_weighted_second_version",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v2"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch", "scheduled"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
      ],
    });
    expect(second.phase).toBe("succeeded");
    rejectNextActivation = true;
    const failed = await local.apply({
      operationId: "op_failed_weighted_update",
      offering: offering("WorkerDeployment"),
      identity: identity("hello-live"),
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        versions: [
          {
            workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "hello-v2" },
            weight: 10_000,
          },
        ],
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/versions/0/workerVersion", "WorkerVersion", "hello-v2"),
      ],
    });
    expect(failed).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });

    // Desired state no longer names v1, but workerd still does. The serving
    // pointer remains a deletion fence until a later activation commits v2.
    expect(
      await local.delete({
        operationId: "op_delete_restored_v1",
        offering: offering("WorkerVersion"),
        identity: identity("hello-v1"),
        nativeId: `selfhost-version:${script}:restored-v1`,
        spec: {},
        relations: [relation("/worker", "ModuleWorker", "hello")],
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "conflict" } });

    // Desired state records the retry, but the exact pointer/config/activation
    // transaction proved and restored v1. Queue and cron selection must use
    // that committed graph rather than select the unserved desired v2.
    const targets = createSelfhostEventTargets(root, { basisPoint: () => 1 });
    const selected = await targets.select(script);
    expect(selected).toMatchObject({
      workerVersionUid: "uid-WorkerVersion-hello-v1",
    });
    let selections = 0;
    const countedTargets = {
      list: () => targets.list(),
      async select(selectedScript: string) {
        selections += 1;
        return await targets.select(selectedScript);
      },
    };
    const sql = createEphemeralSql();
    let now = Date.UTC(2026, 8, 8, 12, 0, 30);
    const scheduler = createSelfhostWorkerScheduler({
      sql,
      runtime,
      targets: countedTargets,
      clock: () => new Date(now),
    });
    expect(await scheduler.tick()).toBe(0);
    now = Date.UTC(2026, 8, 8, 12, 1, 10);
    expect(await scheduler.tick()).toBe(1);
    expect(selections).toBe(1);
    expect(invoked.map(({ deploymentId }) => deploymentId)).toEqual([selected?.versionId]);
  });

  test("refuses a single-version deployment unless its weight is exactly 10000", async () => {
    const runtime = servingRuntime();
    const local = provider({ runtime: runtime.runtime });
    const script = await publish(local);
    const statePath = join(root, "selfhost", "scripts", `${script}.json`);
    const before = await readFile(statePath, "utf8");
    runtime.state.log.length = 0;
    for (const weight of [0, -1, 5_000, 10_001]) {
      expect(
        await local.apply({
          operationId: `op_weight_${weight}`,
          offering: offering("WorkerDeployment"),
          identity: identity("hello-live"),
          spec: {
            worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
            versions: [
              {
                workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "hello-v1" },
                weight,
              },
            ],
          },
          relations: [
            relation("/worker", "ModuleWorker", "hello"),
            relation("/versions/0/workerVersion", "WorkerVersion", "hello-v1"),
          ],
        }),
      ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec", retryable: false } });
    }
    expect(await readFile(statePath, "utf8")).toBe(before);
    expect(runtime.state.log).toEqual([]);
    expect(await runtime.runtime.has(script)).toBe(true);
  });

  test("observe proves the immutable service target and refuses a legacy record with no identity", async () => {
    const local = provider();
    const createWorker = async (name: string) => {
      const ticket = await local.apply({
        operationId: `op_observe_service_${name}`,
        offering: offering("ModuleWorker"),
        identity: identity(name),
        spec: {},
      });
      if (ticket.phase !== "succeeded") throw new Error(`could not create ${name}`);
      return ticket.result;
    };
    const caller = await createWorker("observe-caller");
    const targetA = await createWorker("observe-target-a");
    const targetB = await createWorker("observe-target-b");
    const callerRelation = deployedRelation(
      "/worker",
      "ModuleWorker",
      "observe-caller",
      caller.nativeId,
      caller.outputs,
    );
    const targetRelation = (name: string, result: typeof targetA): ProviderRelation => ({
      ...deployedRelation(
        "/serviceBindings/0/resource",
        "ModuleWorker",
        name,
        result.nativeId,
        result.outputs,
      ),
      bindingRef: MODULE_WORKER_SERVICE_BINDING_REF,
    });
    const versionSpec = (target: string) => ({
      bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
      handlers: ["fetch"],
      worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "observe-caller" },
      serviceBindings: [
        {
          name: "PEER",
          resource: { apiVersion: EDGE_API, kind: "ModuleWorker", name: target },
        },
      ],
    });
    const bundleRelation = relation("/bundle", "WorkerBundle", "bundle", {
      manifestDigest: "sha256:worker",
    });
    const applied = await local.apply({
      operationId: "op_observe_service_version",
      offering: offering("WorkerVersion"),
      identity: identity("observe-caller-v1"),
      spec: versionSpec("observe-target-a"),
      relations: [callerRelation, bundleRelation, targetRelation("observe-target-a", targetA)],
    });
    if (applied.phase !== "succeeded") throw new Error("service Version did not apply");
    const versionId = String(applied.result.outputs.versionId);
    const record = join(
      root,
      "selfhost",
      "version-bindings",
      String(caller.outputs.scriptName),
      `${versionId}.json`,
    );
    const before = await readFile(record, "utf8");
    const exact = await local.observe({
      offering: offering("WorkerVersion"),
      nativeId: applied.result.nativeId,
      identity: identity("observe-caller-v1"),
      spec: versionSpec("observe-target-a"),
      relations: [callerRelation, bundleRelation, targetRelation("observe-target-a", targetA)],
    });
    expect(exact).toMatchObject({ phase: "succeeded" });

    const parsed = JSON.parse(before) as Record<string, unknown>;
    const wrongOwner = JSON.stringify({ ...parsed, workerResourceUid: "uid-other-worker" });
    await writeFile(record, wrongOwner, "utf8");
    const changedOwner = await local.observe({
      offering: offering("WorkerVersion"),
      nativeId: applied.result.nativeId,
      identity: identity("observe-caller-v1"),
      spec: versionSpec("observe-target-a"),
      relations: [callerRelation, bundleRelation, targetRelation("observe-target-a", targetA)],
    });
    expect(changedOwner).toMatchObject({
      phase: "failed",
      failure: { code: "conflict", retryable: false },
    });
    expect(await readFile(record, "utf8")).toBe(wrongOwner);
    await writeFile(record, before, "utf8");

    const changedTarget = await local.observe({
      offering: offering("WorkerVersion"),
      nativeId: applied.result.nativeId,
      identity: identity("observe-caller-v1"),
      spec: versionSpec("observe-target-b"),
      relations: [callerRelation, bundleRelation, targetRelation("observe-target-b", targetB)],
    });
    expect(changedTarget).toMatchObject({
      phase: "failed",
      failure: { code: "conflict", retryable: false },
    });
    expect(await readFile(record, "utf8")).toBe(before);

    const legacy = JSON.stringify({
      format: "takoserver.selfhost-version-bindings@v3",
      salt: parsed.salt,
      handlers: parsed.handlers,
      vars: parsed.vars,
      sensitiveVars: parsed.sensitiveVars,
      eventToken: parsed.eventToken,
    });
    await writeFile(record, legacy, "utf8");
    const missingIdentity = await local.observe({
      offering: offering("WorkerVersion"),
      nativeId: applied.result.nativeId,
      identity: identity("observe-caller-v1"),
      spec: versionSpec("observe-target-a"),
      relations: [callerRelation, bundleRelation, targetRelation("observe-target-a", targetA)],
    });
    expect(missingIdentity).toMatchObject({
      phase: "failed",
      failure: { code: "conflict", retryable: false },
    });
    expect(await readFile(record, "utf8")).toBe(legacy);
  });

  /**
   * Every publication is load-probed, including the simplest kind of Worker.
   *
   * The generated entrypoint is what answers this Host's readiness question,
   * and it used to be written only for a Version that bound a facade or
   * received an event. A Worker with neither was therefore published without
   * ever being asked whether its module loads: an unloadable one — a missing
   * built-in, a top-level throw — deployed, reported `Ready=True`, and failed
   * with a 500 on the first real request instead.
   */
  test("asks a Worker with no bindings at all whether its module loads", async () => {
    const asked: string[] = [];
    const local = provider({
      runtime: {
        async inspectModule(input) {
          return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
        },
        async write() {},
        async remove() {},
        async reload() {},
        async has() {
          return true;
        },
        async probe(name, path) {
          asked.push(`${name} ${path}`);
          // Semantic loading has already passed the required verifier above.
          // Serving-process activation is a separate readiness observation.
          return null;
        },
      },
    });

    const script = await publish(local);
    expect(asked).toEqual([`${script} ${SELFHOST_WORKER_READINESS_PATH}`]);
  });

  /**
   * A publication is not defeated by another publication of the same Worker.
   *
   * One `tofu apply` creates the `WorkerEndpoint`, the `QueueConsumer` and the
   * `WorkerCronTrigger` together, and all three republish the same script.
   * Read-state, render, write, reload, ask-the-runtime was not exclusive, so
   * the reloads interleaved: the endpoint asked about a configuration another
   * publication had already replaced, waited out a five-second guess on an
   * answer naming somebody else's publication, and refused with `unavailable` —
   * a Version that was in fact serving. On a real self-host the failed attempt
   * then left the origin reservation bound to an endpoint that never existed,
   * so every later apply answered `resource_busy` 409 forever.
   */
  test("does not let one publication of a Worker answer for another", async () => {
    const runtime = servingRuntime();
    const local = provider({ runtime: runtime.runtime, events: { async forgetSchedules() {} } });
    const script = await publish(local);
    const cron = () =>
      local.apply({
        operationId: "op_cron_race",
        offering: offering("WorkerCronTrigger"),
        identity: identity("hello-cron"),
        spec: {
          worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
          cron: "0 * * * *",
        },
        relations: [relation("/worker", "ModuleWorker", "hello")],
      });
    expect(await cron()).toMatchObject({ phase: "succeeded" });

    // The shape the real apply makes: the endpoint attaches its hostname while
    // a second publication of the same script — a re-applied attachment, which
    // republishes whether or not its desired state moved — runs beside it.
    runtime.state.log.length = 0;
    const [endpoint, replayed] = await Promise.all([
      local.apply({
        operationId: "op_endpoint_race",
        offering: offering("WorkerEndpoint"),
        identity: identity("hello-endpoint"),
        spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
        relations: [relation("/worker", "ModuleWorker", "hello")],
        workerEndpointOriginAssignment: endpointAssignment(`${script}.localhost`),
      }),
      cron(),
    ]);

    expect(endpoint).toMatchObject({ phase: "succeeded" });
    expect(replayed).toMatchObject({ phase: "succeeded" });
    expect(endpoint.phase === "succeeded" ? endpoint.result.outputs : {}).toEqual({
      hostname: `${script}.localhost`,
      url: `https://${script}.localhost/`,
    });

    // And every probe asked about the configuration the runtime had just been
    // given: one publication at a time, so nothing is ever published without
    // its own load probe being the one that answered.
    expect(runtime.state.log).toEqual(["write", "reload", "probe", "write", "reload", "probe"]);
  });

  test("keeps a tenant module under this Host's generated name in the application namespace", async () => {
    const local = provider({
      modules: {
        "index.js": TEST_WORKER_SOURCE,
        "__takoserver-selfhost-entrypoint.js": "export default {}",
      },
    });
    const { script, deployment } = await publishChain(local);
    expect(deployment).toMatchObject({ phase: "succeeded" });
    expect(
      await publishedModule(root, script, "application", "__takoserver-selfhost-entrypoint.js"),
    ).toBe("export default {}");
    expect(
      await publishedModule(root, script, "hostPrivate", "__takoserver-selfhost-entrypoint.js"),
    ).not.toBe("export default {}");
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).toContain("role = hostPrivate");
    expect(config).toContain("role = application");
  });

  test("a deployment publishes the version's modules into workerd", async () => {
    const local = provider();
    const script = await publish(local);

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    const variant = privateVersionService(config);
    expect(config).toContain(
      `(name = "${script}-selfhost-deployment", service = "${script}-selfhost-deployment")`,
    );
    expect(config).not.toContain(`(name = "${variant}", service = "${variant}")`);
    // Relative, because workerd resolves an embed against the config's own
    // directory and silently fails to read an absolute one.
    expect(config).toContain(`.publications/${script}/`);
    expect(config).toContain(`/version-00000/application/module-00000"`);
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

  test("absent and empty vars render the same Host-only readiness binding", async () => {
    const plain = provider();
    const plainScript = await publish(plain);
    const withoutVars = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
    const empty = provider();
    const emptyScript = await publish(empty, false, {});
    const withEmptyVars = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    expect(emptyScript).toBe(plainScript);
    expect(normalizeGeneratedWorkerdConfig(withEmptyVars)).toBe(
      normalizeGeneratedWorkerdConfig(withoutVars),
    );
    expect(withoutVars).toMatch(
      /bindings = \[ \(name = "__TAKOSERVER_SELFHOST_RUNTIME_READINESS", text = "[0-9a-f]{64}"\) \],/u,
    );
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

  /**
   * A machine whose socket speaks plain HTTP publishes an `http` address.
   *
   * The scheme used to be a constant, so this deployment advertised an `https`
   * endpoint its own workerd socket never served. Nothing answered there, and
   * the Worker behind it pinned the `http` origin its requests actually arrived
   * under — its published address and its own identity disagreed.
   */
  test("publishes an http endpoint address where the socket terminates no TLS", async () => {
    const local = provider({ workerEndpointScheme: "http" });
    const script = await publish(local);
    const derived = await local.workerEndpointOriginReservations?.derive({
      tenantRef: "org_demo",
      requestedSubdomain: script,
    });
    expect(derived?.canonicalPublicOrigin).toBe(`http://${script}.localhost`);

    const endpoint = await local.apply({
      operationId: "op_endpoint_http",
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: {
        canonicalPublicOrigin: `http://${script}.localhost`,
        assignmentDigest: `sha256:${"e".repeat(64)}` as const,
      },
    });
    expect(endpoint.phase === "succeeded" ? endpoint.result.outputs : {}).toEqual({
      hostname: `${script}.localhost`,
      url: `http://${script}.localhost/`,
    });

    // And an https assignment is refused on such a machine rather than
    // published as an address it cannot serve.
    expect(
      await local.apply({
        operationId: "op_endpoint_http_mismatch",
        offering: offering("WorkerEndpoint"),
        identity: identity("hello-endpoint-2"),
        spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
        relations: [relation("/worker", "ModuleWorker", "hello")],
        workerEndpointOriginAssignment: endpointAssignment(`${script}.localhost`),
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec" } });
  });

  /**
   * An address is a scheme, a name *and* a port.
   *
   * A self-host whose workerd socket is not on the scheme's default published a
   * portless address, so the Worker pinned the `…:28988` origin its own
   * requests genuinely arrived on while its Host advertised one without it —
   * the same disagreement the scheme fix closed, one dimension over. The
   * scheme's own default is still normalized away, so a deployment behind an
   * ordinary 443 front end publishes exactly what it published before.
   */
  test("publishes the port its socket listens on, and only when it is not the default", async () => {
    const ported = provider({ workerEndpointScheme: "https", workerEndpointPort: 28_988 });
    const script = await publish(ported);
    expect(
      (
        await ported.workerEndpointOriginReservations?.derive({
          tenantRef: "org_demo",
          requestedSubdomain: script,
        })
      )?.canonicalPublicOrigin,
    ).toBe(`https://${script}.localhost:28988`);

    // And it is the address this deployment then accepts and serves on.
    const endpoint = await ported.apply({
      operationId: "op_endpoint_ported",
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: {
        canonicalPublicOrigin: `https://${script}.localhost:28988`,
        assignmentDigest: `sha256:${"e".repeat(64)}` as const,
      },
    });
    expect(endpoint.phase === "succeeded" ? endpoint.result.outputs : {}).toEqual({
      // The router matches on the name, so the route is the bare hostname while
      // the published address carries the port a client has to dial.
      hostname: `${script}.localhost`,
      url: `https://${script}.localhost:28988/`,
    });

    const fronted = provider({ workerEndpointScheme: "https", workerEndpointPort: 443 });
    expect(
      (
        await fronted.workerEndpointOriginReservations?.derive({
          tenantRef: "org_demo",
          requestedSubdomain: script,
        })
      )?.canonicalPublicOrigin,
    ).toBe(`https://${script}.localhost`);
    const plain = provider({ workerEndpointScheme: "http", workerEndpointPort: 80 });
    expect(
      (
        await plain.workerEndpointOriginReservations?.derive({
          tenantRef: "org_demo",
          requestedSubdomain: script,
        })
      )?.canonicalPublicOrigin,
    ).toBe(`http://${script}.localhost`);
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
      await local.verifyNativeAbsence({
        offering: endpointOffering,
        descriptor,
        target: readTarget("hello-endpoint"),
      }),
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
      await local.verifyNativeAbsence({
        offering: endpointOffering,
        descriptor,
        target: readTarget("hello-endpoint"),
      }),
    ).toMatchObject({ outcome: "absent" });
    if (!local.recoverDelete) throw new Error("the selfhost provider is missing delete recovery");
    expect(await local.recoverDelete({ ...deleteInput, operationMode: "recovery" })).toMatchObject({
      phase: "succeeded",
      result: { nativeId: endpoint.result.nativeId, observed: { deleted: true } },
    });
  });

  test("a differing Worker Version digest refuses overwrite and preserves the committed modules", async () => {
    const first = provider({
      modules: { "index.js": TEST_WORKER_SOURCE, "old.js": "export const old = 1;" },
    });
    const script = await publish(first);
    expect(await publishedModule(root, script, "application", "old.js")).toBe(
      "export const old = 1;",
    );

    const second = provider({
      modules: { "index.js": `${TEST_WORKER_SOURCE}\n// different bytes` },
    });
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
    expect(await publishedModule(root, script, "application", "old.js")).toBe(
      "export const old = 1;",
    );
    expect(await publishedModule(root, script, "application", "index.js")).toBe(TEST_WORKER_SOURCE);
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
    const probed = probedMaterializingRuntime(() => {
      if (failNextReload) {
        failNextReload = false;
        throw new Error("runtime reload failed after staging");
      }
    });
    const local = provider({ runtime: probed.runtime });
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

  test("semantic module refusal precedes sensitive lease acquisition and materialization", async () => {
    const { port, log } = fakeLeases(() => root);
    let inspections = 0;
    const runtime = Object.assign(createWorkerdRuntime({ root, isReady: () => true }), {
      async inspectModule() {
        inspections += 1;
        return { outcome: "invalid" as const, error: "handler_not_exported" as const };
      },
    });
    const local = provider({ runtime, runtimeInputs: port });

    expect(await local.apply(sensitiveApply())).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });
    expect(inspections).toBe(1);
    expect(log.events).toEqual([]);
    expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
  });

  test("asset routing admission precedes sensitive lease acquisition and materialization", async () => {
    const cases = [
      {
        siteFiles: ["app.css"],
        assets: {
          bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "site" },
          notFoundHandling: "single_page_application",
          runWorkerFirst: false,
        },
      },
      {
        siteFiles: ["index.html"],
        assets: {
          bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "site" },
          notFoundHandling: "none",
        },
      },
    ] as const;
    for (const fixture of cases) {
      const { port, log } = fakeLeases(() => root);
      const local = provider({ runtimeInputs: port, siteFiles: fixture.siteFiles });
      const request = sensitiveApply({
        spec: { ...sensitiveApply().spec, assets: fixture.assets },
        relations: [
          ...sensitiveApply().relations,
          relation("/assets/bundle", "StaticAssetBundle", "site", {
            manifestDigest: "sha256:site",
          }),
        ],
      });

      expect(await local.apply(request)).toMatchObject({
        phase: "failed",
        failure: { code: "invalid_spec", retryable: false },
      });
      expect(log.events).toEqual([]);
      expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
    }
  });

  test("an unavailable semantic verifier cannot publish or consume sensitive inputs", async () => {
    const { port, log } = fakeLeases(() => root);
    const runtime = Object.assign(createWorkerdRuntime({ root, isReady: () => true }), {
      async inspectModule() {
        return { outcome: "unavailable" as const, retryable: true as const };
      },
    });
    const local = provider({ runtime, runtimeInputs: port });

    expect(await local.apply(sensitiveApply())).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(log.events).toEqual([]);
    expect(existsSync(join(root, "selfhost", "versions"))).toBe(false);
  });

  test("semantic verification receives only the exact module graph before sensitive inputs", async () => {
    const { port, log } = fakeLeases(() => root);
    const snapshots: unknown[] = [];
    const runtime = Object.assign(createWorkerdRuntime({ root, isReady: () => true }), {
      async inspectModule(input: unknown) {
        snapshots.push(input);
        expect(log.events).toEqual([]);
        return { outcome: "valid" as const, exportedHandlers: ["fetch" as const] };
      },
    });
    const modules = {
      "index.js": 'import { handler } from "./handler.js"; export default { fetch: handler };',
      "handler.js": 'export const handler = () => new Response("ok");',
    };
    const local = provider({ runtime, runtimeInputs: port, modules });

    expect(await local.apply(sensitiveApply())).toMatchObject({ phase: "succeeded" });
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0]).toEqual({
      mainModule: "index.js",
      declaredHandlers: ["fetch"],
      modules: Object.entries(modules).map(([name, source]) => ({
        name,
        digest: `sha256:${createHash("sha256").update(source).digest("hex")}`,
        mediaType: "application/javascript+module",
        bytes: new TextEncoder().encode(source),
      })),
    });
    expect(log.events).toEqual([
      "acquire",
      "dispatch",
      expect.stringMatching(/^settle:sha256:[0-9a-f]{64}$/u),
    ]);
  });

  for (const source of [
    "export default { fetch() {} };",
    "export default { fetch() {}, queue() {} };",
  ]) {
    test(`import refuses a different immutable handler declaration: ${source}`, async () => {
      const { port, log } = fakeLeases(() => root);
      const local = provider({ runtimeInputs: port, modules: { "index.js": source } });
      const applied = await local.apply(sensitiveApply());
      if (applied.phase !== "succeeded") throw new Error("the fixture version did not apply");
      if (!local.adopt) throw new Error("the selfhost provider is missing import");
      log.events.length = 0;
      const changed = {
        ...sensitiveApply(),
        operationId: "op_import_version",
        nativeId: applied.result.nativeId,
        spec: { ...sensitiveApply().spec, handlers: ["fetch", "queue"] },
      };
      expect(await local.adopt(changed)).toMatchObject({
        phase: "failed",
        failure: { code: "conflict", retryable: false },
      });
      expect(await local.observe(changed)).toMatchObject({
        phase: "failed",
        failure: { code: "conflict", retryable: false },
      });
      expect(log.events).toEqual([]);
    });
  }

  test("import refuses a different bundle instead of inspecting unrelated retained bytes", async () => {
    const { port, log } = fakeLeases(() => root);
    const local = provider({ runtimeInputs: port });
    const applied = await local.apply(sensitiveApply());
    if (applied.phase !== "succeeded") throw new Error("the fixture version did not apply");
    if (!local.adopt) throw new Error("the selfhost provider is missing import");
    log.events.length = 0;
    expect(
      await local.adopt({
        ...sensitiveApply(),
        operationId: "op_import_other_bundle",
        nativeId: applied.result.nativeId,
        spec: {
          ...sensitiveApply().spec,
          bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "other-bundle" },
        },
        relations: [
          relation("/worker", "ModuleWorker", "hello"),
          relation("/bundle", "WorkerBundle", "other-bundle", {
            manifestDigest: "sha256:other-bundle",
          }),
        ],
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "conflict", retryable: false } });
    expect(log.events).toEqual([]);
  });

  test("import accepts an identical projection with handler order normalized and no new lease", async () => {
    const { port, log } = fakeLeases(() => root);
    const local = provider({
      runtimeInputs: port,
      modules: { "index.js": "export default { fetch() {}, queue() {} };" },
    });
    const request = sensitiveApply({
      spec: { ...sensitiveApply().spec, handlers: ["fetch", "queue"] },
    });
    const applied = await local.apply(request);
    if (applied.phase !== "succeeded") throw new Error("the fixture version did not apply");
    if (!local.adopt) throw new Error("the selfhost provider is missing import");
    log.events.length = 0;
    expect(
      await local.adopt({
        ...request,
        operationId: "op_import_same_version",
        nativeId: applied.result.nativeId,
        spec: { ...sensitiveApply().spec, handlers: ["queue", "fetch"] },
      }),
    ).toMatchObject({ phase: "succeeded" });
    expect(log.events).toEqual([]);
  });

  test("recovery cannot settle a handler projection different from the stored wrapper", async () => {
    const { port, log } = fakeLeases(() => root);
    const local = provider({
      runtimeInputs: port,
      modules: { "index.js": "export default { fetch() {}, queue() {} };" },
    });
    log.settleFails = true;
    expect(await local.apply(sensitiveApply())).toMatchObject({ phase: "failed" });
    if (!local.recoverApply) throw new Error("the selfhost provider is missing recovery");
    log.settleFails = false;
    log.events.length = 0;
    expect(
      await local.recoverApply({
        ...sensitiveApply(),
        operationMode: "recovery",
        spec: { ...sensitiveApply().spec, handlers: ["fetch", "queue"] },
      }),
    ).toMatchObject({ phase: "failed" });
    expect(log.events).not.toContainEqual(expect.stringMatching(/^settle:/u));
    expect(log.events).not.toContain("acquire");
    expect(log.events).not.toContain("dispatch");
  });

  test("recovery verifies retained bytes even when legacy metadata hides a same-size change", async () => {
    const { port, log } = fakeLeases(() => root);
    const source = "export default { fetch() { return new Response('A'); } };";
    const replacement = source.replace("'A'", "'B'");
    const local = provider({ runtimeInputs: port, modules: { "index.js": source } });
    const applied = await local.apply(sensitiveApply());
    if (applied.phase !== "succeeded") throw new Error("the fixture version did not apply");
    if (!local.recoverApply) throw new Error("the selfhost provider is missing recovery");
    const { scriptName, versionId } = applied.result.outputs;
    if (typeof scriptName !== "string" || typeof versionId !== "string")
      throw new Error("missing version identity");
    await writeFile(
      join(root, "selfhost", "versions", scriptName, versionId, "modules", "index.js"),
      replacement,
    );
    log.events.length = 0;
    expect(await local.recoverApply(sensitiveApply({ operationMode: "recovery" }))).toMatchObject({
      phase: "failed",
    });
    expect(log.events).not.toContainEqual(expect.stringMatching(/^settle:/u));
    expect(log.events).not.toContain("acquire");
    expect(log.events).not.toContain("dispatch");
  });

  test("recovery cannot settle same-size substituted legacy static assets", async () => {
    const { port, log } = fakeLeases(() => root);
    const local = provider({ runtimeInputs: port });
    const base = sensitiveApply();
    const request = sensitiveApply({
      spec: {
        ...base.spec,
        assets: {
          bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "site" },
          notFoundHandling: "single_page_application",
          runWorkerFirst: false,
        },
      },
      relations: [
        ...base.relations,
        relation("/assets/bundle", "StaticAssetBundle", "site", { manifestDigest: "sha256:site" }),
      ],
    });
    log.settleFails = true;
    expect(await local.apply(request)).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    if (!local.recoverApply) throw new Error("the selfhost provider is missing recovery");
    const versionsRoot = join(root, "selfhost", "versions");
    const asset = readdirSync(versionsRoot, { recursive: true })
      .map(String)
      .find((path) => path.endsWith("/assets/asset-00000"));
    if (!asset) throw new Error("the fixture asset did not materialize");
    expect(readFileSync(join(versionsRoot, asset), "utf8")).toBe("<html>");
    await writeFile(join(versionsRoot, asset), "<body>");
    log.settleFails = false;
    log.events.length = 0;
    expect(await local.recoverApply({ ...request, operationMode: "recovery" })).toMatchObject({
      phase: "failed",
      failure: { code: "conflict", retryable: false },
    });
    expect(log.events).not.toContainEqual(expect.stringMatching(/^settle:/u));
    expect(log.events).not.toContain("acquire");
    expect(log.events).not.toContain("dispatch");
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
      expect(path).toMatch(
        /workerd\.capnp$|takoserver-site\.json$|deployment\.json$|version-bindings\//u,
      );
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
      async inspectModule(input) {
        return { outcome: "valid", exportedHandlers: [...input.declaredHandlers] };
      },
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
    expect(written[0]?.site.assets).toEqual({
      notFoundHandling: "single-page-application",
      runWorkerFirst: false,
      mediaTypes: {
        "app.css": "text/css",
        "index.html": "text/html",
      },
    });
  });

  test("legacy asset routing is refused before routes, triggers, or deployments move", async () => {
    const local = provider();
    const script = await publish(local, true);
    const versionId = versionDirectoryName(root, script);
    const metaPath = join(root, "selfhost", "versions", script, versionId, "meta.json");
    const legacy = JSON.parse(await readFile(metaPath, "utf8")) as {
      materializationDigest: string;
      assets: { runWorkerFirst?: boolean };
      [key: string]: unknown;
    };
    delete legacy.assets.runWorkerFirst;
    const { materializationDigest: _oldDigest, ...legacyPayload } = legacy;
    legacy.materializationDigest = await canonicalDigest(legacyPayload);
    await writeFile(metaPath, JSON.stringify(legacy), "utf8");
    const before = await readFile(metaPath, "utf8");

    const versionInput = {
      operationId: "op_version_legacy_assets",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      spec: {
        bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
        handlers: ["fetch"],
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        assets: {
          bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "site" },
          notFoundHandling: "single_page_application",
          runWorkerFirst: false,
        },
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
        relation("/assets/bundle", "StaticAssetBundle", "site", {
          manifestDigest: "sha256:site",
        }),
      ],
    } as const;
    const failure = {
      code: "unavailable",
      message:
        "the Worker Version's asset routing order is unknown; create and apply a new Worker Version",
      retryable: true,
    };
    const statePath = join(root, "selfhost", "scripts", `${script}.json`);
    const stateBefore = await readFile(statePath, "utf8");

    expect(await local.apply(versionInput)).toMatchObject({ phase: "failed", failure });
    if (!local.recoverApply) throw new Error("selfhost provider missing apply recovery");
    expect(await local.recoverApply({ ...versionInput, operationMode: "recovery" })).toMatchObject({
      phase: "failed",
      failure,
    });
    expect(
      await local.observe({
        ...versionInput,
        nativeId: `selfhost-version:${script}:${versionId}`,
      }),
    ).toMatchObject({ phase: "failed", failure });
    const endpoint = await local.apply({
      operationId: "op_endpoint_legacy_assets",
      offering: offering("WorkerEndpoint"),
      identity: identity("hello-endpoint"),
      spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
      relations: [relation("/worker", "ModuleWorker", "hello")],
      workerEndpointOriginAssignment: endpointAssignment(),
    });
    const domain = await local.apply({
      operationId: "op_domain_legacy_assets",
      offering: offering("WorkerCustomDomain"),
      identity: identity("hello-domain"),
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        hostname: "legacy.localhost",
      },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    const trigger = await local.apply({
      operationId: "op_cron_legacy_assets",
      offering: offering("WorkerCronTrigger"),
      identity: identity("hello-cron"),
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        cron: "0 * * * *",
      },
      relations: [relation("/worker", "ModuleWorker", "hello")],
    });
    expect(endpoint).toMatchObject({ phase: "failed", failure });
    expect(domain).toMatchObject({ phase: "failed", failure });
    expect(trigger).toMatchObject({ phase: "failed", failure });
    // All three declarations were refused, so none may become latent desired
    // state that a later, valid Version accidentally publishes.
    expect(await readFile(statePath, "utf8")).toBe(stateBefore);

    const nextVersion = await local.apply({
      ...versionInput,
      operationId: "op_version_after_legacy_assets",
      identity: identity("hello-v2"),
    });
    expect(nextVersion.phase).toBe("succeeded");
    const nextVersionId =
      nextVersion.phase === "succeeded" ? String(nextVersion.result.outputs.versionId) : "";
    const nextDeployment = await local.apply({
      operationId: "op_deploy_after_legacy_assets",
      offering: offering("WorkerDeployment"),
      identity: identity("hello-live"),
      spec: {
        worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
        versions: [
          {
            workerVersion: { apiVersion: EDGE_API, kind: "WorkerVersion", name: "hello-v2" },
            weight: 10_000,
          },
        ],
      },
      relations: [
        relation("/worker", "ModuleWorker", "hello"),
        relation("/versions/0/workerVersion", "WorkerVersion", "hello-v2"),
      ],
    });
    expect(nextDeployment.phase).toBe("succeeded");
    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    expect(config).not.toContain("reserved.localhost");
    expect(config).not.toContain("legacy.localhost");
    expect(config).not.toContain(`${script}-selfhost-events`);

    // Selecting the legacy Version is also refused before it replaces the
    // valid active Version. The serving manifest therefore remains the exact
    // valid publication rather than a ghost deployment in durable state.
    expect(
      await local.apply({
        operationId: "op_deploy_legacy_assets",
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
      }),
    ).toMatchObject({ phase: "failed", failure });
    expect(JSON.parse(await readFile(statePath, "utf8"))).toMatchObject({
      deployment: {
        versions: [
          {
            versionId: nextVersionId,
            workerVersionUid: "uid-WorkerVersion-hello-v2",
            weight: 10_000,
          },
        ],
      },
      domains: [],
    });
    expect(await readFile(metaPath, "utf8")).toBe(before);
  });

  test("legacy asset media and storage layout are never inferred or adopted", async () => {
    const cases = [
      {
        message:
          "the Worker Version's asset media types are unknown; create and apply a new Worker Version",
        async makeLegacy(_versionRoot: string, meta: Record<string, unknown>) {
          const assets = meta.assets as { files: Array<{ mediaType?: string }> };
          delete assets.files[0]?.mediaType;
        },
      },
      {
        message:
          "the Worker Version's asset storage layout is unknown; create and apply a new Worker Version",
        async makeLegacy(versionRoot: string, meta: Record<string, unknown>) {
          const assetsRoot = join(versionRoot, "assets");
          await rename(join(assetsRoot, "asset-00000"), join(assetsRoot, "index.html"));
          await rename(join(assetsRoot, "asset-00001"), join(assetsRoot, "app.css"));
          delete (meta.assets as { storageLayout?: string }).storageLayout;
        },
      },
    ] as const;

    for (const [index, fixture] of cases.entries()) {
      if (index > 0) {
        rmSync(root, { recursive: true, force: true });
        root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
      }
      const local = provider();
      const script = await publish(local, true);
      const versionId = versionDirectoryName(root, script);
      const versionRoot = join(root, "selfhost", "versions", script, versionId);
      const metaPath = join(versionRoot, "meta.json");
      const legacy = JSON.parse(await readFile(metaPath, "utf8")) as Record<string, unknown> & {
        materializationDigest: string;
      };
      await fixture.makeLegacy(versionRoot, legacy);
      const { materializationDigest: _oldDigest, ...legacyPayload } = legacy;
      legacy.materializationDigest = await canonicalDigest(legacyPayload);
      await writeFile(metaPath, JSON.stringify(legacy));
      const metaBefore = await readFile(metaPath, "utf8");
      const statePath = join(root, "selfhost", "scripts", `${script}.json`);
      const stateBefore = await readFile(statePath, "utf8");
      const versionInput = {
        operationId: `op_version_legacy_asset_metadata_${index}`,
        offering: offering("WorkerVersion"),
        identity: identity("hello-v1"),
        spec: {
          bundle: { apiVersion: EDGE_API, kind: "WorkerBundle", name: "bundle" },
          handlers: ["fetch"],
          worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" },
          assets: {
            bundle: { apiVersion: EDGE_API, kind: "StaticAssetBundle", name: "site" },
            notFoundHandling: "single_page_application",
            runWorkerFirst: false,
          },
        },
        relations: [
          relation("/worker", "ModuleWorker", "hello"),
          relation("/bundle", "WorkerBundle", "bundle", { manifestDigest: "sha256:worker" }),
          relation("/assets/bundle", "StaticAssetBundle", "site", {
            manifestDigest: "sha256:site",
          }),
        ],
      } as const;
      const failure = {
        code: "unavailable",
        message: fixture.message,
        retryable: true,
      };

      expect(await local.apply(versionInput)).toMatchObject({ phase: "failed", failure });
      if (!local.recoverApply) throw new Error("selfhost provider missing apply recovery");
      expect(
        await local.recoverApply({ ...versionInput, operationMode: "recovery" }),
      ).toMatchObject({ phase: "failed", failure });
      expect(
        await local.observe({
          ...versionInput,
          nativeId: `selfhost-version:${script}:${versionId}`,
        }),
      ).toMatchObject({ phase: "failed", failure });
      expect(
        await local.apply({
          operationId: `op_endpoint_legacy_asset_metadata_${index}`,
          offering: offering("WorkerEndpoint"),
          identity: identity("hello-endpoint"),
          spec: { worker: { apiVersion: EDGE_API, kind: "ModuleWorker", name: "hello" } },
          relations: [relation("/worker", "ModuleWorker", "hello")],
          workerEndpointOriginAssignment: endpointAssignment(),
        }),
      ).toMatchObject({ phase: "failed", failure });
      expect(await readFile(statePath, "utf8")).toBe(stateBefore);
      expect(await readFile(metaPath, "utf8")).toBe(metaBefore);
    }
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
    const probed = probedMaterializingRuntime();
    const local = provider({ runtime: probed.runtime });
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
    const afterDeleteReloads = probed.reloads();

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
    expect(probed.reloads()).toBe(afterDeleteReloads);
  });
});

describe("KV and SQLite bindings", () => {
  const address = "127.0.0.1:8787";

  test("a version binding both is published through a generated entrypoint", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, { LANE: "takoform-v1" }, true);

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    const variant = privateVersionService(config);
    // The tenant module is still declared, because the generated one imports
    // it; workerd resolves imports through the module registry this builds.
    expect(config).toMatch(
      new RegExp(
        `\\(name = "__takoserver-selfhost-entrypoint\\.js", esModule = embed "\\.publications/${script}/[0-9a-f]{64}/version-00000/host-private/module-00000", role = hostPrivate\\)`,
        "u",
      ),
    );
    expect(config).toMatch(
      new RegExp(
        `\\(name = "index\\.js", esModule = embed "\\.publications/${script}/[0-9a-f]{64}/version-00000/application/module-00000", role = application\\)`,
        "u",
      ),
    );
    expect(config).toContain(
      `(name = "__TAKOSERVER_SELFHOST_DATA", service = "${variant}-selfhost-data")`,
    );
    // The service the tenant binds is a Worker of this Host's own, and the one
    // that names the loopback address sits behind it.
    expect(config).toContain(`( name = "${variant}-selfhost-data",
    worker = (
      modules = [ (name = "__takoserver-selfhost-data.js", esModule = embed ".publications/${script}/`);
    expect(config).toContain(`( name = "${variant}-selfhost-data-origin",
    external = ( address = "${address}", http = () )
  ),`);
    expect(config).toContain('(name = "LANE", text = "takoform-v1")');
    expect(config).toContain('compatibilityFlags = [ "disallow_importable_env" ]');

    const generated = await publishedModule(
      root,
      script,
      "hostPrivate",
      "__takoserver-selfhost-entrypoint.js",
    );
    expect(generated).toContain('import * as TenantWorkerModule from "./index.js"');
    expect(generated).toContain('"kind":"edge.kv@1.0.0","publicName":"KV"');
    expect(generated).toContain('"kind":"edge.sql@1.0.0","publicName":"DB"');
  });

  test("the token names the version and is a binding of the facade service alone", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const versionId = versionDirectoryName(root, script);

    const config = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    const variant = privateVersionService(config);
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
    expect(services[0]).toStartWith(`"${variant}-selfhost-data"`);

    const tenantService = config
      .split(/^ {2}\( name = /mu)
      .find((section) => section.startsWith(`"${variant}"`)) as string;
    expect(tenantService).not.toContain(token as string);
    expect(tenantService).not.toContain("__TAKOSERVER_SELFHOST_DATA_TOKEN");

    // The generated modules carry no credential of their own either.
    const generated = await publishedModule(
      root,
      script,
      "hostPrivate",
      "__takoserver-selfhost-entrypoint.js",
    );
    const facade = await publishedModule(
      root,
      script,
      "hostPrivate",
      "__takoserver-selfhost-data.js",
    );
    expect(generated).not.toContain(token as string);
    expect(generated).not.toContain("__TAKOSERVER_SELFHOST_DATA_TOKEN");
    expect(facade).not.toContain(token as string);
  });

  test("the facade service is the only route out, and it names both its own", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const facade = await publishedModule(
      root,
      script,
      "hostPrivate",
      "__takoserver-selfhost-data.js",
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

  test("a version that binds neither renders the same whether or not a plane is served", async () => {
    const withPlane = provider({ dataPlaneAddress: address });
    const script = await publish(withPlane);
    const configured = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    rmSync(root, { recursive: true, force: true });
    root = mkdtempSync(join(tmpdir(), "takoserver-selfhost-"));
    const withoutPlane = provider();
    expect(await publish(withoutPlane)).toBe(script);
    const plain = await readFile(join(root, "workers", "workerd.capnp"), "utf8");

    expect(normalizeGeneratedWorkerdConfig(configured.replaceAll(script, "<script>"))).toBe(
      normalizeGeneratedWorkerdConfig(plain.replaceAll(script, "<script>")),
    );
    // The generated entrypoint is there either way, because it is the load
    // probe rather than the facade. The facade service is what a Version that
    // binds nothing does not get.
    expect(plain).toContain("selfhost-entrypoint");
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
    await publish(local, false, undefined, true);
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
    const variant = privateVersionService(after);
    const token = (input: string) =>
      input.match(/\(name = "__TAKOSERVER_SELFHOST_DATA_TOKEN", text = "([^"]+)"\)/u)?.[1];
    // A Worker Version is immutable, so a republish must not mint a second
    // token: the script serving traffic would be authenticating with one this
    // Host no longer holds.
    expect(token(after)).toBe(token(before));
    expect(after).toContain(
      `(name = "__TAKOSERVER_SELFHOST_DATA", service = "${variant}-selfhost-data")`,
    );
    expect(after).toContain("reserved.localhost");
  });

  test("an active deployment fences Version deletion before its plane grant is revoked", async () => {
    const local = provider({ dataPlaneAddress: address });
    const script = await publish(local, false, undefined, true);
    const versionId = versionDirectoryName(root, script);
    const access = createSelfhostDataPlaneAccess(root);
    expect(await access.grant(script, versionId)).toMatchObject({
      kv: { KV: KV_NAMESPACE },
      sql: { DB: SQLITE_DATABASE },
    });

    const versionDeleteInput = {
      operationId: "op_delete",
      offering: offering("WorkerVersion"),
      identity: identity("hello-v1"),
      nativeId: `selfhost-version:${script}:${versionId}`,
      spec: {},
      relations: [relation("/worker", "ModuleWorker", "hello")],
    } as const;
    const deleted = await local.delete(versionDeleteInput);
    expect(deleted).toMatchObject({ phase: "failed", failure: { code: "conflict" } });
    expect(await access.grant(script, versionId)).not.toBeNull();

    expect(
      await local.delete({
        operationId: "op_delete_deployment",
        offering: offering("WorkerDeployment"),
        identity: identity("hello-live"),
        nativeId: `selfhost-deployment:${script}:op_deploy`,
        spec: {},
        relations: [relation("/worker", "ModuleWorker", "hello")],
      }),
    ).toMatchObject({ phase: "succeeded" });
    expect(
      await local.delete({ ...versionDeleteInput, operationId: "op_delete_after_deployment" }),
    ).toMatchObject({ phase: "succeeded" });
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

  test("a SQLite database recreated under the same name cannot be removed by its stale incarnation", async () => {
    const forgotten: string[] = [];
    const local = provider({
      dataPlaneMaintenance: {
        async deleteKvNamespace() {},
        async deleteQueue() {},
        deleteDatabase(name) {
          forgotten.push(name);
          rmSync(selfhostDatabasePath(root, name), { force: true });
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
    expect(
      await local.apply({
        operationId: "op_sqlite_missing_uid",
        offering: offering("SQLiteDatabase"),
        identity: identity("same-name"),
        spec: {},
      }),
    ).toMatchObject({ phase: "failed", failure: { code: "invalid_spec", retryable: false } });
    const before = await local.apply({
      operationId: "op_sqlite_before",
      offering: offering("SQLiteDatabase"),
      identity: sqliteIdentity("same-name", "uid-sqlite-before"),
      spec: {},
    });
    const after = await local.apply({
      operationId: "op_sqlite_after",
      offering: offering("SQLiteDatabase"),
      identity: sqliteIdentity("same-name", "uid-sqlite-after"),
      spec: {},
    });
    if (before.phase !== "succeeded" || after.phase !== "succeeded") {
      throw new Error("SQLite database allocation failed");
    }
    const beforeName = String(before.result.observed.name);
    const afterName = String(after.result.observed.name);
    expect(afterName).not.toBe(beforeName);
    expect(after.result.nativeId).not.toBe(before.result.nativeId);

    await mkdir(join(root, "databases"), { recursive: true });
    const beforePath = selfhostDatabasePath(root, beforeName);
    const afterPath = selfhostDatabasePath(root, afterName);
    writeFileSync(beforePath, "old-incarnation");
    writeFileSync(afterPath, "new-incarnation");

    expect(
      await local.delete({
        operationId: "op_sqlite_stale_delete",
        offering: offering("SQLiteDatabase"),
        nativeId: before.result.nativeId,
        identity: sqliteIdentity("same-name", "uid-sqlite-before"),
        spec: {},
      }),
    ).toMatchObject({ phase: "succeeded", result: { observed: { deleted: true } } });
    expect(existsSync(beforePath)).toBe(false);
    expect(existsSync(afterPath)).toBe(true);
    expect(readFileSync(afterPath, "utf8")).toBe("new-incarnation");
    expect(forgotten).toEqual([beforeName]);
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
    let filesystemFailure = false;
    const local = provider({
      dataPlaneMaintenance: {
        async deleteKvNamespace(namespaceId) {
          deletedNamespaces.push(namespaceId);
        },
        async deleteQueue() {},
        deleteDatabase(name) {
          if (filesystemFailure) throw new Error("filesystem unavailable");
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
      identity: sqliteIdentity("app"),
      spec: {},
    });
    if (database.phase !== "succeeded") throw new Error("database allocation failed");
    expect(
      await local.delete({
        operationId: "op_4",
        offering: offering("SQLiteDatabase"),
        nativeId: database.result.nativeId,
        identity: sqliteIdentity("app"),
        spec: {},
      }),
    ).toMatchObject({ phase: "succeeded" });
    // The data-plane seam closes the handle and removes the exact database
    // incarnation; this provider test verifies it is invoked with that name.
    expect(forgotten).toEqual([String(database.result.observed.name)]);

    const malformed = await local.delete({
      operationId: "op_bad_database",
      offering: offering("SQLiteDatabase"),
      nativeId: "selfhost-sqlite:../outside:op_bad_database",
      identity: sqliteIdentity("app"),
      spec: {},
    });
    expect(malformed).toMatchObject({
      phase: "failed",
      failure: { code: "invalid_spec", retryable: false },
    });

    filesystemFailure = true;
    const unavailable = await local.delete({
      operationId: "op_filesystem_failure",
      offering: offering("SQLiteDatabase"),
      nativeId: database.result.nativeId,
      identity: sqliteIdentity("app"),
      spec: {},
    });
    expect(unavailable).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });

    const noPlane = provider();
    const noPlanePath = selfhostDatabasePath(root, String(database.result.observed.name));
    await mkdir(join(root, "databases"), { recursive: true });
    writeFileSync(noPlanePath, "durable-bytes");
    const refusedWithoutPlane = await noPlane.delete({
      operationId: "op_missing_data_plane",
      offering: offering("SQLiteDatabase"),
      nativeId: database.result.nativeId,
      identity: sqliteIdentity("app"),
      spec: {},
    });
    expect(refusedWithoutPlane).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    rmSync(noPlanePath, { force: true });
    expect(
      await noPlane.delete({
        operationId: "op_missing_data_plane_retry",
        offering: offering("SQLiteDatabase"),
        nativeId: database.result.nativeId,
        identity: sqliteIdentity("app"),
        spec: {},
      }),
    ).toMatchObject({ phase: "succeeded", result: { observed: { deleted: true } } });
  });

  test("SQLite delete recovery treats sidecars or a newer file as present", async () => {
    const local = provider();
    const databaseName = "tsdb-delete-recovery";
    const path = selfhostDatabasePath(root, databaseName);
    await mkdir(join(root, "databases"), { recursive: true });
    writeFileSync(path, "old-incarnation");
    writeFileSync(`${path}-wal`, "old-wal");
    const input = {
      operationId: "op_delete_recovery",
      offering: offering("SQLiteDatabase"),
      nativeId: `selfhost-sqlite:${databaseName}:op_old`,
      identity: sqliteIdentity("delete-recovery"),
      spec: {},
    };
    if (!local.recoverDelete) throw new Error("selfhost provider is missing delete recovery");
    if (!local.createNativeReadbackDescriptor || !local.verifyNativeAbsence) {
      throw new Error("selfhost provider is missing SQLite absence readback");
    }
    const descriptor = local.createNativeReadbackDescriptor(input);
    expect(await local.recoverDelete(input)).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(
      await local.verifyNativeAbsence({
        offering: input.offering,
        descriptor,
        target: readTarget("delete-recovery"),
      }),
    ).toMatchObject({ outcome: "present" });
    expect(readFileSync(path, "utf8")).toBe("old-incarnation");

    rmSync(`${path}-wal`, { force: true });
    rmSync(path, { force: true });
    expect(await local.recoverDelete(input)).toMatchObject({
      phase: "succeeded",
      result: { observed: { deleted: true } },
    });
    expect(
      await local.verifyNativeAbsence({
        offering: input.offering,
        descriptor,
        target: readTarget("delete-recovery"),
      }),
    ).toMatchObject({ outcome: "absent" });

    // A replacement at the same path is not absence for the old recovery
    // proof, and the read-only check must not remove or rewrite it.
    writeFileSync(path, "new-incarnation");
    expect(await local.recoverDelete(input)).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    expect(
      await local.verifyNativeAbsence({
        offering: input.offering,
        descriptor,
        target: readTarget("delete-recovery"),
      }),
    ).toMatchObject({ outcome: "present" });
    expect(readFileSync(path, "utf8")).toBe("new-incarnation");
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

    const entrypoint = await publishedModule(
      root,
      script,
      "hostPrivate",
      "__takoserver-selfhost-entrypoint.js",
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

  test("renders a version without bucket bindings with no facade and no object binding", async () => {
    const withoutBuckets = provider({ dataPlaneAddress: address });
    await publish(withoutBuckets, false, undefined, false);
    const plain = await readFile(join(root, "workers", "workerd.capnp"), "utf8");
    // The entrypoint is the load probe and is always there. What a Version
    // that binds no bucket does not get is the facade service or any trace of
    // the object Binding.
    expect(plain).toContain("selfhost-entrypoint");
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
    deleteDatabase() {},
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
    expect(
      await local.verifyNativeAbsence({
        offering: currentBucket,
        descriptor,
        target: readTarget("media"),
      }),
    ).toMatchObject({ outcome: "present" });
    state.objects = 0;
    expect(
      await local.verifyNativeAbsence({
        offering: currentBucket,
        descriptor,
        target: readTarget("media"),
      }),
    ).toMatchObject({ outcome: "absent" });
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
      target: readTarget("hello-v1"),
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
      target: readTarget("hello-v1"),
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
      target: readTarget("hello-v1"),
    });
    expect(malformed).toEqual({ outcome: "unknown", reason: "malformed", retryable: false });
  });
});

describe("the SQLite migration ledger", () => {
  test("applies an admitted 105-file history with a large first file of short statements", async () => {
    const local = provider();
    const database = await local.apply({
      operationId: "op_db_large_history",
      offering: offering("SQLiteDatabase"),
      identity: sqliteIdentity("large-history"),
      spec: {},
    });
    expect(database.phase).toBe("succeeded");
    const nativeId = database.phase === "succeeded" ? database.result.nativeId : "";
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");

    const firstStatements = [
      "CREATE TABLE migration_values (value INTEGER PRIMARY KEY)",
      ...Array.from(
        { length: 3_500 },
        (_, index) => `INSERT INTO migration_values (value) VALUES (${index})`,
      ),
    ];
    const firstSql = new TextEncoder().encode(`${firstStatements.join(";\n")};`);
    expect(firstSql.byteLength).toBeGreaterThan(100_000);
    const migrations = [
      {
        path: "0001_large.sql",
        digest: `sha256:${createHash("sha256").update(firstSql).digest("hex")}` as const,
        sql: firstSql,
      },
      ...Array.from({ length: 104 }, (_, index) => {
        const sql = new TextEncoder().encode(
          `INSERT INTO migration_values (value) VALUES (${3_500 + index})`,
        );
        return {
          path: `${String(index + 2).padStart(4, "0")}_append.sql`,
          digest: `sha256:${createHash("sha256").update(sql).digest("hex")}` as const,
          sql,
        };
      }),
    ];
    expect(migrations).toHaveLength(105);
    expect(migrations.length).toBeLessThanOrEqual(TAKOFORM_MAXIMUM_FILE_BUNDLE_FILES);
    expect(
      migrations.reduce((total, migration) => total + migration.sql.byteLength, 0),
    ).toBeLessThanOrEqual(TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES);

    expect(
      await port.applySuffix({
        operationId: "op_migration_large_history",
        operationMode: "initial",
        nativeId,
        target: {
          resourceUid: "uid_large_history",
          incarnationId: "dep_large_history",
          generation: "1",
        },
        desired: migrations,
        expectedPrefix: [],
        migrations,
      }),
    ).toEqual({ ok: true, value: undefined });

    const ledger = await port.readLedger({
      nativeId,
      target: {
        tenantId: "tenant",
        resourceUid: "uid_large_history",
        incarnationId: "dep_large_history",
        generation: "1",
      },
    });
    expect(ledger).toEqual({
      ok: true,
      value: migrations.map(({ path, digest }) => ({ path, digest })),
    });
    const databaseName = nativeId.split(":")[1];
    if (!databaseName) throw new Error("the selfhost SQLite native id must contain a name");
    const persisted = new Database(selfhostDatabasePath(root, databaseName));
    try {
      expect(persisted.query("SELECT COUNT(*) AS count FROM migration_values").get()).toEqual({
        count: 3_604,
      });
    } finally {
      persisted.close();
    }
  });

  test("records a zero-byte migration as an atomic no-op", async () => {
    const local = provider();
    const database = await local.apply({
      operationId: "op_db_empty_migration",
      offering: offering("SQLiteDatabase"),
      identity: sqliteIdentity("empty-migration"),
      spec: {},
    });
    expect(database.phase).toBe("succeeded");
    const nativeId = database.phase === "succeeded" ? database.result.nativeId : "";
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
    const target = {
      resourceUid: "uid_empty_migration",
      incarnationId: "dep_empty_migration",
      generation: "1",
    };
    const ledgerTarget = { tenantId: "tenant", ...target };
    const migration = (path: string, sql: Uint8Array) => ({
      path,
      digest: `sha256:${createHash("sha256").update(sql).digest("hex")}` as const,
      sql,
    });
    const empty = migration("0001_empty.sql", new Uint8Array());
    const following = migration(
      "0002_following.sql",
      new TextEncoder().encode(
        "CREATE TABLE empty_migration (value INTEGER PRIMARY KEY); INSERT INTO empty_migration (value) VALUES (1);",
      ),
    );
    const failing = migration(
      "0003_failing.sql",
      new TextEncoder().encode("CREATE TABLE empty_migration (other INTEGER);"),
    );

    expect(
      await port.applySuffix({
        operationId: "op_migration_empty_noop",
        operationMode: "initial",
        nativeId,
        target,
        desired: [empty, following],
        expectedPrefix: [],
        migrations: [empty, following],
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(await port.readLedger({ nativeId, target: ledgerTarget })).toEqual({
      ok: true,
      value: [empty, following].map(({ path, digest }) => ({ path, digest })),
    });

    const firstFailure = await port.applySuffix({
      operationId: "op_migration_empty_later_failure",
      operationMode: "recovery",
      nativeId,
      target,
      desired: [empty, following, failing],
      expectedPrefix: [empty, following].map(({ path, digest }) => ({ path, digest })),
      migrations: [failing],
    });
    expect(firstFailure).toMatchObject({ ok: false, failure: { code: "provider_error" } });
    expect(await port.readLedger({ nativeId, target: ledgerTarget })).toEqual({
      ok: true,
      value: [empty, following].map(({ path, digest }) => ({ path, digest })),
    });

    const identicalRetry = await port.applySuffix({
      operationId: "op_migration_empty_later_failure_retry",
      operationMode: "recovery",
      nativeId,
      target,
      desired: [empty, following, failing],
      expectedPrefix: [empty, following].map(({ path, digest }) => ({ path, digest })),
      migrations: [failing],
    });
    expect(identicalRetry).toMatchObject({ ok: false, failure: { code: "provider_error" } });
    expect(await port.readLedger({ nativeId, target: ledgerTarget })).toEqual({
      ok: true,
      value: [empty, following].map(({ path, digest }) => ({ path, digest })),
    });

    const databaseName = nativeId.split(":")[1];
    if (!databaseName) throw new Error("the selfhost SQLite native id must contain a name");
    const persisted = new Database(selfhostDatabasePath(root, databaseName));
    try {
      expect(persisted.query("SELECT COUNT(*) AS count FROM empty_migration").get()).toEqual({
        count: 1,
      });
    } finally {
      persisted.close();
    }
  });

  test("keeps completed files when a later file fails and retries from the actual prefix", async () => {
    const local = provider();
    const database = await local.apply({
      operationId: "op_db_retry_history",
      offering: offering("SQLiteDatabase"),
      identity: sqliteIdentity("retry-history"),
      spec: {},
    });
    expect(database.phase).toBe("succeeded");
    const nativeId = database.phase === "succeeded" ? database.result.nativeId : "";
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
    const target = {
      resourceUid: "uid_retry_history",
      incarnationId: "dep_retry_history",
      generation: "1",
    };
    const readTarget = { tenantId: "tenant", ...target };

    const migrations = [
      {
        path: "0001_init.sql",
        sql: new TextEncoder().encode(
          "CREATE TABLE migration_retry (value INTEGER PRIMARY KEY); INSERT INTO migration_retry (value) VALUES (0);",
        ),
      },
      ...Array.from({ length: 101 }, (_, index) => ({
        path: `${String(index + 2).padStart(4, "0")}_append.sql`,
        sql: new TextEncoder().encode(`INSERT INTO migration_retry (value) VALUES (${index + 1});`),
      })),
      {
        path: "0103_fail.sql",
        sql: new TextEncoder().encode(
          "INSERT INTO migration_retry (value) VALUES (102); INSERT INTO migration_retry (value) VALUES (103);",
        ),
      },
      {
        path: "0104_after-failure.sql",
        sql: new TextEncoder().encode("INSERT INTO migration_retry (value) VALUES (104);"),
      },
    ].map((migration) => ({
      ...migration,
      digest: `sha256:${createHash("sha256").update(migration.sql).digest("hex")}` as const,
    }));
    expect(migrations).toHaveLength(104);
    const seed = migrations[0];
    if (!seed) throw new Error("the migration retry fixture must have a seed");

    expect(
      await port.applySuffix({
        operationId: "op_migration_retry_seed",
        operationMode: "initial",
        nativeId,
        target,
        desired: [seed],
        expectedPrefix: [],
        migrations: [seed],
      }),
    ).toEqual({ ok: true, value: undefined });

    const databaseName = nativeId.split(":")[1];
    if (!databaseName) throw new Error("the selfhost SQLite native id must contain a name");
    const databasePath = selfhostDatabasePath(root, databaseName);
    const conflict = new Database(databasePath);
    conflict.query("INSERT INTO migration_retry (value) VALUES (?)").run(103);
    conflict.close();

    const firstAttempt = await port.applySuffix({
      operationId: "op_migration_retry_failure",
      operationMode: "recovery",
      nativeId,
      target,
      desired: migrations,
      expectedPrefix: [{ path: seed.path, digest: seed.digest }],
      migrations: migrations.slice(1),
    });
    expect(firstAttempt).toMatchObject({ ok: false, failure: { code: "provider_error" } });
    const afterFailure = await port.readLedger({ nativeId, target: readTarget });
    expect(afterFailure).toEqual({
      ok: true,
      value: migrations.slice(0, 102).map(({ path, digest }) => ({ path, digest })),
    });

    const afterFailedFile = new Database(databasePath);
    try {
      expect(
        afterFailedFile.query("SELECT value FROM migration_retry WHERE value = 102").all(),
      ).toEqual([]);
      expect(afterFailedFile.query("SELECT COUNT(*) AS count FROM migration_retry").get()).toEqual({
        count: 103,
      });
      afterFailedFile.query("DELETE FROM migration_retry WHERE value = ?").run(103);
    } finally {
      afterFailedFile.close();
    }

    expect(
      await port.applySuffix({
        operationId: "op_migration_retry_recovery",
        operationMode: "recovery",
        nativeId,
        target,
        desired: migrations,
        expectedPrefix: migrations.slice(0, 102).map(({ path, digest }) => ({ path, digest })),
        migrations: migrations.slice(102),
      }),
    ).toEqual({ ok: true, value: undefined });
    expect(await port.readLedger({ nativeId, target: readTarget })).toEqual({
      ok: true,
      value: migrations.map(({ path, digest }) => ({ path, digest })),
    });
    const complete = new Database(databasePath);
    try {
      expect(complete.query("SELECT COUNT(*) AS count FROM migration_retry").get()).toEqual({
        count: 105,
      });
    } finally {
      complete.close();
    }
  });

  test("prevalidates malformed UTF-8, NUL SQL, digest mismatch, duplicate paths, and aggregate bounds before mutation", async () => {
    const local = provider();
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
    const migration = (path: string, sql: Uint8Array) => ({
      path,
      digest: `sha256:${createHash("sha256").update(sql).digest("hex")}` as const,
      sql,
    });

    const valid = migration(
      "0001_valid.sql",
      new TextEncoder().encode("CREATE TABLE prevalidation (value INTEGER PRIMARY KEY);"),
    );
    const malformedBytes = new Uint8Array([0xc3, 0x28]);
    const malformed = migration("0002_malformed.sql", malformedBytes);
    const malformedResult = await port.applySuffix({
      operationId: "op_migration_prevalidate_utf8",
      operationMode: "initial",
      nativeId: "selfhost-sqlite:prevalidate-utf8:op_db",
      target: {
        resourceUid: "uid_prevalidate_utf8",
        incarnationId: "dep_prevalidate_utf8",
        generation: "1",
      },
      desired: [valid, malformed],
      expectedPrefix: [],
      migrations: [valid, malformed],
    });
    expect(malformedResult).toMatchObject({ ok: false, failure: { code: "invalid_spec" } });
    expect(existsSync(selfhostDatabasePath(root, "prevalidate-utf8"))).toBe(false);

    const nulBytes = new TextEncoder().encode("CREATE TABLE nul_sql (value INTEGER);\u0000");
    const nulSql = migration("0002_nul.sql", nulBytes);
    const nulResult = await port.applySuffix({
      operationId: "op_migration_prevalidate_nul",
      operationMode: "initial",
      nativeId: "selfhost-sqlite:prevalidate-nul:op_db",
      target: {
        resourceUid: "uid_prevalidate_nul",
        incarnationId: "dep_prevalidate_nul",
        generation: "1",
      },
      desired: [valid, nulSql],
      expectedPrefix: [],
      migrations: [valid, nulSql],
    });
    expect(nulResult).toMatchObject({ ok: false, failure: { code: "invalid_spec" } });
    expect(existsSync(selfhostDatabasePath(root, "prevalidate-nul"))).toBe(false);

    const digestMismatch = {
      ...migration(
        "0002_digest.sql",
        new TextEncoder().encode("CREATE TABLE digest_mismatch (value INTEGER);"),
      ),
      digest: `sha256:${"0".repeat(64)}` as const,
    };
    const digestResult = await port.applySuffix({
      operationId: "op_migration_prevalidate_digest",
      operationMode: "initial",
      nativeId: "selfhost-sqlite:prevalidate-digest:op_db",
      target: {
        resourceUid: "uid_prevalidate_digest",
        incarnationId: "dep_prevalidate_digest",
        generation: "1",
      },
      desired: [valid, digestMismatch],
      expectedPrefix: [],
      migrations: [valid, digestMismatch],
    });
    expect(digestResult).toMatchObject({ ok: false, failure: { code: "invalid_spec" } });
    expect(existsSync(selfhostDatabasePath(root, "prevalidate-digest"))).toBe(false);

    const duplicate = migration(
      "0001_duplicate.sql",
      new TextEncoder().encode("CREATE TABLE duplicate_paths (value INTEGER PRIMARY KEY);"),
    );
    const duplicatePath = migration(
      duplicate.path,
      new TextEncoder().encode("CREATE TABLE another_duplicate (value INTEGER PRIMARY KEY);"),
    );
    const duplicateResult = await port.applySuffix({
      operationId: "op_migration_prevalidate_duplicate",
      operationMode: "initial",
      nativeId: "selfhost-sqlite:prevalidate-duplicate:op_db",
      target: {
        resourceUid: "uid_prevalidate_duplicate",
        incarnationId: "dep_prevalidate_duplicate",
        generation: "1",
      },
      desired: [duplicate, duplicatePath],
      expectedPrefix: [],
      migrations: [duplicate, duplicatePath],
    });
    expect(duplicateResult).toMatchObject({ ok: false, failure: { code: "invalid_spec" } });
    expect(existsSync(selfhostDatabasePath(root, "prevalidate-duplicate"))).toBe(false);

    const oversized = migration(
      "0001_oversized.sql",
      new TextEncoder().encode("x".repeat(TAKOFORM_MAXIMUM_WORKER_BUNDLE_BYTES + 1)),
    );
    const oversizedResult = await port.applySuffix({
      operationId: "op_migration_prevalidate_aggregate",
      operationMode: "initial",
      nativeId: "selfhost-sqlite:prevalidate-aggregate:op_db",
      target: {
        resourceUid: "uid_prevalidate_aggregate",
        incarnationId: "dep_prevalidate_aggregate",
        generation: "1",
      },
      desired: [oversized],
      expectedPrefix: [],
      migrations: [oversized],
    });
    expect(oversizedResult).toMatchObject({ ok: false, failure: { code: "invalid_spec" } });
    expect(existsSync(selfhostDatabasePath(root, "prevalidate-aggregate"))).toBe(false);
  });

  test("rejects migration SQL that escapes the file transaction before any prefix is applied", async () => {
    const local = provider();
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
    const firstSql = new TextEncoder().encode(
      "CREATE TABLE policy_guard (value INTEGER PRIMARY KEY);",
    );
    const first = {
      path: "0001_policy.sql",
      digest: `sha256:${createHash("sha256").update(firstSql).digest("hex")}` as const,
      sql: firstSql,
    };
    const unsafeSql = [
      "COMMIT;",
      "END;",
      "ATTACH DATABASE 'outside.sqlite' AS external;",
      "VACUUM;",
      "CREATE TABLE bom_before_commit (value INTEGER);\ufeffCOMMIT;",
      "CREATE TABLE '_takoform_sqlite_migrations' (value INTEGER);",
      "PRAGMA writable_schema = ON;",
    ];
    for (const [index, sqlText] of unsafeSql.entries()) {
      const sql = new TextEncoder().encode(sqlText);
      const last = {
        path: `0002_unsafe_${index}.sql`,
        digest: `sha256:${createHash("sha256").update(sql).digest("hex")}` as const,
        sql,
      };
      const databaseName = `policy-guard-${index}`;
      const result = await port.applySuffix({
        operationId: `op_migration_policy_${index}`,
        operationMode: "initial",
        nativeId: `selfhost-sqlite:${databaseName}:op_db`,
        target: {
          resourceUid: `uid_policy_guard_${index}`,
          incarnationId: `dep_policy_guard_${index}`,
          generation: "1",
        },
        desired: [first, last],
        expectedPrefix: [],
        migrations: [first, last],
      });
      expect(result).toMatchObject({ ok: false, failure: { code: "invalid_spec" } });
      expect(existsSync(selfhostDatabasePath(root, databaseName))).toBe(false);
    }
  });

  test("admits trigger, CASE, quoted-semicolon, comment, and safe PRAGMA SQL", async () => {
    const local = provider();
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
    const sql = new TextEncoder().encode(
      "\ufeffCREATE TABLE policy_positive (\n" +
        "  value INTEGER PRIMARY KEY,\n" +
        "  note TEXT,\n" +
        "  CHECK (CASE WHEN value >= 0 THEN 1 ELSE 0 END = 1)\n" +
        ");\n" +
        "\ufeffCREATE \ufeffTRIGGER policy_positive_trigger\n" +
        "AFTER INSERT ON policy_positive\n" +
        "BEGIN\n" +
        "  UPDATE policy_positive\n" +
        "  SET note = 'quoted;semicolon'\n" +
        "  WHERE value = NEW.value;\n" +
        "END;\n" +
        "-- A semicolon in this comment must not end the trigger body.\n" +
        "PRAGMA user_version = 42;\n" +
        "INSERT INTO policy_positive (value, note) VALUES (1, 'initial');\n",
    );
    const migration = {
      path: "0001_policy_positive.sql",
      digest: `sha256:${createHash("sha256").update(sql).digest("hex")}` as const,
      sql,
    };
    const nativeId = "selfhost-sqlite:policy-positive:op_db";
    const target = {
      resourceUid: "uid_policy_positive",
      incarnationId: "dep_policy_positive",
      generation: "1",
    };
    expect(
      await port.applySuffix({
        operationId: "op_migration_policy_positive",
        operationMode: "initial",
        nativeId,
        target,
        desired: [migration],
        expectedPrefix: [],
        migrations: [migration],
      }),
    ).toEqual({ ok: true, value: undefined });
    const persisted = new Database(selfhostDatabasePath(root, "policy-positive"));
    try {
      expect(persisted.query("SELECT value, note FROM policy_positive").all()).toEqual([
        { value: 1, note: "quoted;semicolon" },
      ]);
      expect(persisted.query("PRAGMA user_version").get()).toEqual({ user_version: 42 });
    } finally {
      persisted.close();
    }
  });

  test("refuses a reordered prefix without executing any suffix SQL", async () => {
    const local = provider();
    const database = await local.apply({
      operationId: "op_db_prefix_guard",
      offering: offering("SQLiteDatabase"),
      identity: sqliteIdentity("prefix-guard"),
      spec: {},
    });
    expect(database.phase).toBe("succeeded");
    const nativeId = database.phase === "succeeded" ? database.result.nativeId : "";
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
    const firstSql = new TextEncoder().encode(
      "CREATE TABLE prefix_guard (value INTEGER PRIMARY KEY);",
    );
    const first = {
      path: "0001_first.sql",
      digest: `sha256:${createHash("sha256").update(firstSql).digest("hex")}` as const,
      sql: firstSql,
    };
    const secondSql = new TextEncoder().encode("INSERT INTO prefix_guard (value) VALUES (2);");
    const second = {
      path: "0002_second.sql",
      digest: `sha256:${createHash("sha256").update(secondSql).digest("hex")}` as const,
      sql: secondSql,
    };
    const thirdSql = new TextEncoder().encode("INSERT INTO prefix_guard (value) VALUES (3);");
    const third = {
      path: "0003_third.sql",
      digest: `sha256:${createHash("sha256").update(thirdSql).digest("hex")}` as const,
      sql: thirdSql,
    };
    const target = {
      resourceUid: "uid_prefix_guard",
      incarnationId: "dep_prefix_guard",
      generation: "1",
    };
    expect(
      await port.applySuffix({
        operationId: "op_migration_prefix_seed",
        operationMode: "initial",
        nativeId,
        target,
        desired: [first],
        expectedPrefix: [],
        migrations: [first],
      }),
    ).toEqual({ ok: true, value: undefined });

    const reordered = await port.applySuffix({
      operationId: "op_migration_prefix_reordered",
      operationMode: "recovery",
      nativeId,
      target,
      desired: [second, first, third],
      expectedPrefix: [],
      migrations: [second, first, third],
    });
    expect(reordered).toMatchObject({ ok: false, failure: { code: "conflict" } });
    expect(
      await port.readLedger({
        nativeId,
        target: { tenantId: "tenant", ...target },
      }),
    ).toEqual({
      ok: true,
      value: [{ path: first.path, digest: first.digest }],
    });
    const databaseName = nativeId.split(":")[1];
    if (!databaseName) throw new Error("the selfhost SQLite native id must contain a name");
    const persisted = new Database(selfhostDatabasePath(root, databaseName));
    try {
      expect(persisted.query("SELECT value FROM prefix_guard").all()).toEqual([]);
    } finally {
      persisted.close();
    }
  });

  test("applies real SQL and refuses a moved history", async () => {
    const local = provider();
    const database = await local.apply({
      operationId: "op_db",
      offering: offering("SQLiteDatabase"),
      identity: sqliteIdentity("main"),
      spec: {},
    });
    expect(database.phase).toBe("succeeded");
    const nativeId = database.phase === "succeeded" ? database.result.nativeId : "";
    const port = local.sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
    const target = {
      resourceUid: "uid_db",
      incarnationId: "dep_op_db",
      generation: "1",
    };
    const readTarget = { tenantId: "tenant", ...target };

    expect(await port.readLedger({ nativeId, target: readTarget })).toEqual({
      ok: true,
      value: [],
    });

    const firstSql = new TextEncoder().encode(
      "CREATE TABLE notes (id INTEGER PRIMARY KEY, body TEXT)",
    );
    const first = {
      path: "0001_init.sql",
      digest: `sha256:${createHash("sha256").update(firstSql).digest("hex")}` as const,
      sql: firstSql,
    };
    expect(
      await port.applySuffix({
        operationId: "op_migration_first",
        operationMode: "initial",
        nativeId,
        target,
        desired: [first],
        expectedPrefix: [],
        migrations: [first],
      }),
    ).toEqual({
      ok: true,
      value: undefined,
    });
    const databaseName = nativeId.split(":")[1];
    if (!databaseName) throw new Error("the selfhost SQLite native id must contain a name");
    const databasePath = selfhostDatabasePath(root, databaseName);
    expect(statSync(join(root, "databases")).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);

    const ledger = await port.readLedger({ nativeId, target: readTarget });
    expect(ledger).toEqual({
      ok: true,
      value: [{ path: first.path, digest: first.digest }],
    });

    // A stale prefix means the database moved underneath the plan.
    const moreSql = new TextEncoder().encode("CREATE TABLE more (id INTEGER PRIMARY KEY)");
    const more = {
      path: "0002_more.sql",
      digest: `sha256:${createHash("sha256").update(moreSql).digest("hex")}` as const,
      sql: moreSql,
    };
    const alteredMore = {
      ...more,
      sql: new TextEncoder().encode("CREATE TABLE other (id INTEGER PRIMARY KEY)"),
    };
    expect(
      await port.applySuffix({
        operationId: "op_migration_altered_bytes",
        operationMode: "recovery",
        nativeId,
        target,
        desired: [first, more],
        expectedPrefix: [{ path: first.path, digest: first.digest }],
        migrations: [alteredMore],
      }),
    ).toMatchObject({ ok: false, failure: { code: "invalid_spec" } });

    const conflicting = await port.applySuffix({
      operationId: "op_migration_conflicting",
      operationMode: "initial",
      nativeId,
      target,
      desired: [more],
      expectedPrefix: [],
      migrations: [more],
    });
    expect(conflicting).toMatchObject({ ok: false, failure: { code: "conflict" } });

    // Broken SQL commits nothing, ledger row included.
    const tenantDatabase = new Database(databasePath);
    tenantDatabase
      .query("INSERT INTO notes (id, body) VALUES (?, ?)")
      .run(1, "existing tenant data");
    tenantDatabase.close();
    const brokenSql = new TextEncoder().encode(
      "INSERT INTO notes (id, body) VALUES (2, 'must roll back'); THIS IS NOT SQL",
    );
    const brokenMigration = {
      path: "0002_broken.sql",
      digest: `sha256:${createHash("sha256").update(brokenSql).digest("hex")}` as const,
      sql: brokenSql,
    };
    const broken = await port.applySuffix({
      operationId: "op_migration_broken",
      operationMode: "initial",
      nativeId,
      target,
      desired: [first, brokenMigration],
      expectedPrefix: [{ path: first.path, digest: first.digest }],
      migrations: [brokenMigration],
    });
    expect(broken).toMatchObject({ ok: false, failure: { code: "provider_error" } });
    expect(await port.readLedger({ nativeId, target: readTarget })).toEqual({
      ok: true,
      value: [{ path: first.path, digest: first.digest }],
    });
    expect(statSync(join(root, "databases")).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    const preserved = new Database(databasePath);
    try {
      expect(preserved.query("SELECT id, body FROM notes ORDER BY id").all()).toEqual([
        { id: 1, body: "existing tenant data" },
      ]);
    } finally {
      preserved.close();
    }
  });

  test("tightens an existing database and directory without changing tenant data", async () => {
    const databaseName = "existing-database";
    const databasePath = selfhostDatabasePath(root, databaseName);
    await mkdir(join(root, "databases"), { recursive: true });
    chmodSync(join(root, "databases"), 0o755);
    const existing = new Database(databasePath, { create: true });
    existing.exec("CREATE TABLE preserved (value TEXT NOT NULL)");
    existing.query("INSERT INTO preserved (value) VALUES (?)").run("tenant-data");
    existing.close();
    chmodSync(databasePath, 0o644);

    const migrationSql = new TextEncoder().encode(
      "CREATE TABLE added_by_migration (id INTEGER PRIMARY KEY)",
    );
    const migration = {
      path: "0001_existing.sql",
      digest: `sha256:${createHash("sha256").update(migrationSql).digest("hex")}` as const,
      sql: migrationSql,
    };
    const port = provider().sqliteMigrations;
    if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
    expect(
      await port.applySuffix({
        operationId: "op_migration_existing",
        operationMode: "initial",
        nativeId: `selfhost-sqlite:${databaseName}:op_db`,
        target: {
          resourceUid: "uid_existing_db",
          incarnationId: "dep_existing_db",
          generation: "1",
        },
        desired: [migration],
        expectedPrefix: [],
        migrations: [migration],
      }),
    ).toEqual({ ok: true, value: undefined });

    expect(statSync(join(root, "databases")).mode & 0o777).toBe(0o700);
    expect(statSync(databasePath).mode & 0o777).toBe(0o600);
    const reopened = new Database(databasePath);
    try {
      expect(reopened.query("SELECT value FROM preserved").get()).toEqual({
        value: "tenant-data",
      });
    } finally {
      reopened.close();
    }
  });

  test("refuses a symlinked database directory without touching its target", async () => {
    const outside = mkdtempSync(join(tmpdir(), "takoserver-sqlite-outside-"));
    const sentinelPath = join(outside, "sentinel.txt");
    try {
      chmodSync(outside, 0o755);
      await writeFile(sentinelPath, "outside-directory-data");
      await symlink(outside, join(root, "databases"));
      const migrationSql = new TextEncoder().encode(
        "CREATE TABLE custody_probe (id INTEGER PRIMARY KEY)",
      );
      const migration = {
        path: "0001_custody.sql",
        digest: `sha256:${createHash("sha256").update(migrationSql).digest("hex")}` as const,
        sql: migrationSql,
      };
      const port = provider().sqliteMigrations;
      if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
      const outcome = await port
        .applySuffix({
          operationId: "op_migration_symlinked_parent",
          operationMode: "initial",
          nativeId: "selfhost-sqlite:parent-link:op_db",
          target: {
            resourceUid: "uid_symlinked_parent",
            incarnationId: "dep_symlinked_parent",
            generation: "1",
          },
          desired: [migration],
          expectedPrefix: [],
          migrations: [migration],
        })
        .then(
          () => "applied",
          () => "refused",
        );

      expect({
        outcome,
        outsideMode: statSync(outside).mode & 0o777,
        sentinel: readFileSync(sentinelPath, "utf8"),
        databaseCreated: existsSync(join(outside, "parent-link.sqlite")),
      }).toEqual({
        outcome: "refused",
        outsideMode: 0o755,
        sentinel: "outside-directory-data",
        databaseCreated: false,
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("refuses a symlinked database file without touching its target", async () => {
    const outside = mkdtempSync(join(tmpdir(), "takoserver-sqlite-file-outside-"));
    const outsidePath = join(outside, "outside.sqlite");
    try {
      await writeFile(outsidePath, "outside-file-bytes");
      chmodSync(outsidePath, 0o640);
      await mkdir(join(root, "databases"), { recursive: true });
      await symlink(outsidePath, selfhostDatabasePath(root, "file-link"));
      const migrationSql = new TextEncoder().encode(
        "CREATE TABLE file_custody_probe (id INTEGER PRIMARY KEY)",
      );
      const migration = {
        path: "0001_file_custody.sql",
        digest: `sha256:${createHash("sha256").update(migrationSql).digest("hex")}` as const,
        sql: migrationSql,
      };
      const port = provider().sqliteMigrations;
      if (!port) throw new Error("the selfhost provider must execute SQLite migrations");
      const outcome = await port
        .applySuffix({
          operationId: "op_migration_symlinked_file",
          operationMode: "initial",
          nativeId: "selfhost-sqlite:file-link:op_db",
          target: {
            resourceUid: "uid_symlinked_file",
            incarnationId: "dep_symlinked_file",
            generation: "1",
          },
          desired: [migration],
          expectedPrefix: [],
          migrations: [migration],
        })
        .then(
          () => "applied",
          () => "refused",
        );

      expect({
        outcome,
        outsideMode: statSync(outsidePath).mode & 0o777,
        outsideBytes: readFileSync(outsidePath, "utf8"),
      }).toEqual({
        outcome: "refused",
        outsideMode: 0o640,
        outsideBytes: "outside-file-bytes",
      });
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
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
  const QUEUE_NAME = "delivery";
  const DLQ_ID = "tsq-attachment-fixture-dlq";
  const DLQ_NAME = "delivery-dlq";
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
    queue: { apiVersion: EDGE_API, kind: "AtLeastOnceQueue", name: QUEUE_NAME },
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

  test("persists logical queue names separately from native routing ids", async () => {
    const local = provider({ events: EVENTS });
    const script = await publish(local);
    expect(
      await applyConsumer(
        local,
        {
          deadLetterQueue: {
            apiVersion: EDGE_API,
            kind: "AtLeastOnceQueue",
            name: DLQ_NAME,
          },
        },
        [queueRelation("/deadLetterQueue", DLQ_NAME, DLQ_ID)],
      ),
    ).toMatchObject({ phase: "succeeded" });

    const persisted = JSON.parse(
      readFileSync(join(root, "selfhost", "scripts", `${script}.json`), "utf8"),
    ) as { consumers?: readonly unknown[] };
    const expectedConsumers = [
      {
        queue: QUEUE_ID,
        queueName: QUEUE_NAME,
        maxBatchSize: 10,
        maxBatchTimeoutSeconds: 1,
        maxConcurrency: 4,
        maxRetries: 3,
        retryDelaySeconds: 60,
        deadLetterQueue: {
          queue: DLQ_ID,
          queueName: DLQ_NAME,
          messageRetentionSeconds: 345_600,
          deliveryDelaySeconds: 0,
        },
      },
    ] as const;
    expect(persisted.consumers).toEqual(expectedConsumers);
    expect((await createSelfhostEventTargets(root).list())[0]?.consumers).toEqual(
      expectedConsumers,
    );
  });

  test("requires authoritative reapply for a legacy attachment before delivery resumes", async () => {
    const local = provider({ events: EVENTS });
    const script = await publish(local);
    const deadLetterSpec = {
      deadLetterQueue: {
        apiVersion: EDGE_API,
        kind: "AtLeastOnceQueue",
        name: DLQ_NAME,
      },
    };
    const deadLetterRelation = queueRelation("/deadLetterQueue", DLQ_NAME, DLQ_ID);
    const applied = await applyConsumer(local, deadLetterSpec, [deadLetterRelation]);
    if (applied.phase !== "succeeded") throw new Error("the Queue Consumer did not attach");
    const path = join(root, "selfhost", "scripts", `${script}.json`);
    const legacy = JSON.parse(readFileSync(path, "utf8")) as {
      consumers: Array<Record<string, unknown>>;
    };
    for (const consumer of legacy.consumers) {
      delete consumer.queueName;
      if (
        typeof consumer.deadLetterQueue === "object" &&
        consumer.deadLetterQueue !== null &&
        !Array.isArray(consumer.deadLetterQueue)
      ) {
        delete (consumer.deadLetterQueue as Record<string, unknown>).queueName;
      }
    }
    await writeFile(path, JSON.stringify(legacy));

    const relations = [
      relation("/worker", "ModuleWorker", "hello"),
      queueRelation("/queue", QUEUE_NAME, QUEUE_ID),
      deadLetterRelation,
    ];
    expect(
      await local.observe({
        offering: offering("QueueConsumer"),
        nativeId: applied.result.nativeId,
        identity: identity("hello-consumer"),
        spec: { ...consumerSpec, ...deadLetterSpec },
        relations,
      }),
    ).toMatchObject({
      phase: "failed",
      failure: {
        code: "not_found",
        message: "the Queue Consumer must be reapplied to restore its portable queue identity",
      },
    });

    expect(await applyConsumer(local, deadLetterSpec, [deadLetterRelation])).toMatchObject({
      phase: "succeeded",
    });
    expect(
      (JSON.parse(readFileSync(path, "utf8")) as { consumers: Array<Record<string, unknown>> })
        .consumers[0],
    ).toMatchObject({
      queue: QUEUE_ID,
      queueName: QUEUE_NAME,
      deadLetterQueue: { queue: DLQ_ID, queueName: DLQ_NAME },
    });
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
          "a deployed Worker Version predates event delivery on this Host; publish a new Version",
      },
    });
    // Refused BEFORE the durable state moved: nothing was attached, so nothing
    // is left claiming a delivery that can never happen.
    const state = JSON.parse(
      readFileSync(join(root, "selfhost", "scripts", `${script}.json`), "utf8"),
    ) as { crons?: readonly string[]; consumers?: readonly unknown[] };
    expect(state.crons ?? []).toEqual([]);
    expect(state.consumers ?? []).toEqual([]);
    // Missing declarations cannot be grandfathered into a verified Version.
    expect(
      await local.observe({
        offering: offering("WorkerVersion"),
        nativeId: "retained-version",
        identity: identity("hello-v1"),
        spec: { handlers: ["fetch"] },
        relations: [relation("/worker", "ModuleWorker", "hello")],
      }),
    ).toMatchObject({
      phase: "failed",
      failure: { code: "unavailable", retryable: true },
    });
    // Authoritative reapply verifies the bytes and restores exact declarations;
    // only then may the retained version be published again.
    await publish(local);
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
    const local = provider({ events: EVENTS });
    const script = await publish(local);
    // A materialized tree the republish definitely refuses, present only while
    // the attachment is attempted. What the attachment must not do is leave
    // itself recorded behind a refusal.
    const strayModule = join(
      root,
      "selfhost",
      "versions",
      script,
      versionDirectoryName(root, script),
      "modules",
      "stray.js",
    );
    await writeFile(strayModule, "export default {}");
    expect(await applyCron(local, "0 * * * *")).toMatchObject({
      phase: "failed",
      failure: {
        code: "provider_error",
        message: "a deployed Worker Version is not materialized on this machine",
      },
    });
    rmSync(strayModule);
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

  test("refuses a deployed queue relation whose name cannot enter worker.runtime", async () => {
    const local = provider({ events: EVENTS });
    await publish(local);
    expect(
      await local.apply({
        operationId: "op_consumer",
        offering: offering("QueueConsumer"),
        identity: identity("hello-consumer"),
        spec: consumerSpec,
        relations: [
          relation("/worker", "ModuleWorker", "hello"),
          queueRelation("/queue", "Delivery_Internal", QUEUE_ID),
        ],
      }),
    ).toMatchObject({
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
    expect(
      await local.verifyNativeAbsence({
        offering: cronOffering,
        descriptor,
        target: readTarget("hello-cron"),
      }),
    ).toMatchObject({ outcome: "present" });

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
    expect(
      await local.verifyNativeAbsence({
        offering: cronOffering,
        descriptor,
        target: readTarget("hello-cron"),
      }),
    ).toMatchObject({ outcome: "absent" });
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
        deleteDatabase() {},
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
