import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { JsonObject } from "../src/ports.ts";
import {
  createSelfhostWorkflowPreparation,
  type SelfhostWorkflowTarget,
} from "../src/selfhost-workflow-preparation.ts";
import {
  createWorkerdRuntime,
  type WorkerdBinding,
  type WorkerdDeploymentPublication,
  type WorkerdDeploymentVariant,
  type WorkerdPrivateServiceLease,
  type WorkerdSelectedVersionIdentity,
  type WorkerdServiceBinding,
} from "../src/workerd-runtime.ts";
import type { WorkflowRunIdentity } from "../src/workflow-execution.ts";

const encoder = new TextEncoder();
const journalToken = "a".repeat(64);
const currentDataPlaneAddress = "127.0.0.1:4666";
const persistedDataPlaneAddress = "127.0.0.1:4555";
const DATA_MODULE = "__data.js";
const EVENT_MODULE = "__events.js";
const HOST_ENTRYPOINT = "__host.js";

const identity: WorkflowRunIdentity = {
  scope: { tenantId: "tenant-1", workflowResourceUid: "workflow-1" },
  instanceId: "instance-1",
  executionId: "execution-1",
  createdAt: 10,
  epoch: 1,
  owner: "owner-1",
  deadlineAt: 1_000,
};

let runtimeRoot: string;
let temporaryRoot: string;

beforeEach(() => {
  runtimeRoot = mkdtempSync(join(tmpdir(), "takoserver-workflow-preparation-runtime-"));
  temporaryRoot = mkdtempSync(join(tmpdir(), "takoserver-workflow-preparation-temporary-"));
  chmodSync(runtimeRoot, 0o700);
  chmodSync(temporaryRoot, 0o700);
});

afterEach(() => {
  rmSync(runtimeRoot, { recursive: true, force: true });
  rmSync(temporaryRoot, { recursive: true, force: true });
});

interface PublicationOptions {
  readonly generation?: string;
  readonly mainModule?: string;
  readonly hostEntrypoint?: string;
  readonly collisionNames?: boolean;
  readonly serviceBindings?: readonly WorkerdServiceBinding[];
}

const SERVICE_BINDING: WorkerdServiceBinding = {
  name: "__TAKOSERVER_SELFHOST_SERVICE_00001",
  target: "other",
  targetResourceUid: "uid-Other",
  unavailableToken: "b".repeat(64),
};

function publication(options: PublicationOptions = {}): WorkerdDeploymentPublication {
  const generation = options.generation ?? "generation-1";
  const mainModule = options.mainModule ?? "index.js";
  const hostEntrypoint = options.hostEntrypoint ?? HOST_ENTRYPOINT;
  const hostModules = [
    "index.js",
    "host-helper.js",
    ...(options.collisionNames
      ? [
          "__workflow_entry.js",
          "__workflow_entry-1.js",
          "__workflow_bootstrap.js",
          "__workflow_bootstrap-1.js",
        ]
      : []),
  ].filter((name, index, names) => name !== hostEntrypoint && names.indexOf(name) === index);
  const applicationMediaTypes = {
    [mainModule]: "application/javascript+module" as const,
    "module.txt": "text/plain" as const,
    "module.bin": "application/octet-stream" as const,
  };

  const variant = (suffix: "a" | "b", weight: number): WorkerdDeploymentVariant => {
    const application = new Map<string, Uint8Array>([
      [mainModule, encoder.encode(`throw new Error("application-evaluated-${suffix}");`)],
      ["module.txt", encoder.encode(`module-text-${suffix}`)],
      ["module.bin", new Uint8Array([0, suffix === "a" ? 1 : 2, 255])],
    ]);
    const host = new Map<string, Uint8Array>([
      [hostEntrypoint, encoder.encode(`export const hostVersion = "${suffix}";`)],
      ["index.js", encoder.encode(`export const sharedHostModule = "${suffix}";`)],
      ["host-helper.js", encoder.encode(`export const helperVersion = "${suffix}";`)],
      ...(options.collisionNames
        ? ([
            ["__workflow_entry.js", encoder.encode("export const occupiedEntry = true;")],
            ["__workflow_entry-1.js", encoder.encode("export const occupiedEntryOne = true;")],
            ["__workflow_bootstrap.js", encoder.encode("export const occupiedBootstrap = true;")],
            [
              "__workflow_bootstrap-1.js",
              encoder.encode("export const occupiedBootstrapOne = true;"),
            ],
          ] as const)
        : []),
      [DATA_MODULE, encoder.encode(`export const dataVersion = "${suffix}";`)],
      [EVENT_MODULE, encoder.encode(`export const eventVersion = "${suffix}";`)],
    ]);
    const vars: readonly WorkerdBinding[] = [
      { name: "APP_VALUE", value: `app-${suffix}`, kind: "text" },
    ];
    return {
      versionId: `site-v-${suffix}`,
      workerVersionUid: `uid-WorkerVersion-site-${suffix}`,
      weight,
      site: {
        directory: "site",
        mainModule,
        hostEntrypoint,
        hostModules,
        hostnames: [],
        generation,
        workerResourceUid: "uid-ModuleWorker-site",
        fetchHandler: true,
        vars,
        modules: ["module.txt", "module.bin"],
        moduleMediaTypes: applicationMediaTypes,
        assets: {
          notFoundHandling: "none",
          runWorkerFirst: false,
          mediaTypes: { "index.html": "text/html" },
        },
        dataPlane: {
          address: persistedDataPlaneAddress,
          module: DATA_MODULE,
          vars: [{ name: "DATA_TOKEN", value: "facade-only-token", kind: "text" }],
        },
        events: {
          module: EVENT_MODULE,
          vars: [{ name: "EVENT_TOKEN", value: "event-only-token", kind: "text" }],
        },
        ...(options.serviceBindings === undefined
          ? {}
          : { serviceBindings: options.serviceBindings }),
      },
      modules: application,
      assets: new Map([["index.html", encoder.encode(`<h1>${suffix}</h1>`)]]),
      hostModules: host,
    };
  };

  return {
    generation,
    workerResourceUid: "uid-ModuleWorker-site",
    hostnames: ["public.example.invalid"],
    versions: [variant("b", 9_999), variant("a", 1)],
  };
}

async function publish(options: PublicationOptions = {}): Promise<void> {
  const runtime = createWorkerdRuntime({ root: runtimeRoot, isReady: () => true });
  if (!runtime.publish) throw new Error("weighted publication is unavailable");
  await runtime.publish("site", publication(options));
}

function target(overrides: Partial<SelfhostWorkflowTarget> = {}): SelfhostWorkflowTarget {
  return {
    tenantId: identity.scope.tenantId,
    workflowResourceUid: identity.scope.workflowResourceUid,
    workerResourceUid: "uid-ModuleWorker-site",
    script: "site",
    className: "ApprovedWorkflow",
    ...overrides,
  };
}

function channel() {
  return {
    journalToken,
    recordPayload() {},
  };
}

function preparation(
  resolved: SelfhostWorkflowTarget,
  options: {
    readonly dataPlaneAddress?: () => string;
    readonly onResolve?: (value: WorkflowRunIdentity) => void;
    readonly serviceRuntime?: {
      readonly acquirePrivateServiceBindings: (
        identity: WorkerdSelectedVersionIdentity,
      ) => Promise<WorkerdPrivateServiceLease>;
    };
  } = {},
) {
  return createSelfhostWorkflowPreparation({
    runtimeRoot,
    temporaryRoot,
    basisPoint: () => 0,
    ...(options.dataPlaneAddress === undefined
      ? {}
      : { dataPlaneAddress: options.dataPlaneAddress }),
    ...(options.serviceRuntime === undefined ? {} : { serviceRuntime: options.serviceRuntime }),
    resolveTarget: async (value) => {
      options.onResolve?.(value);
      return resolved;
    },
  });
}

async function permissions(path: string): Promise<number> {
  return (await stat(path)).mode & 0o777;
}

type Prepared = Awaited<ReturnType<ReturnType<typeof preparation>>>;

async function disposePrepared(prepared: Prepared) {
  await prepared.drainAfterStop();
  await prepared.dispose();
}

test("materializes the selected graph privately without evaluating or exposing public delivery", async () => {
  await publish();
  const resolved = target();
  const resolvedIdentities: WorkflowRunIdentity[] = [];
  const prepare = preparation(resolved, {
    dataPlaneAddress: () => currentDataPlaneAddress,
    onResolve: (value) => resolvedIdentities.push(value),
  });
  // JSON.parse keeps __proto__ as an own input field. It must remain params,
  // never become a resolver target or a prototype mutation in the bootstrap.
  const input = JSON.parse(
    '{"script":"attacker-script","className":"AttackerClass","__proto__":{"polluted":true}}',
  ) as JsonObject;
  const prepared = await prepare(identity, input, new AbortController().signal, channel());
  try {
    const preparedRoot = dirname(prepared.configPath);
    const config = await readFile(prepared.configPath, "utf8");
    const applicationSection = config.slice(
      config.indexOf('(name = "application"'),
      config.indexOf('(name = "companion"'),
    );
    const dataSection = config.slice(
      config.indexOf('(name = "data", worker ='),
      config.indexOf('(name = "data-origin"'),
    );
    expect(resolvedIdentities).toEqual([identity]);
    expect(config).toContain('(name = "module.txt", text = embed "./application/module-00001"');
    expect(config).toContain('(name = "module.bin", data = embed "./application/module-00002"');
    expect(applicationSection).toContain('(name = "APP_VALUE", text = "app-a")');
    expect(applicationSection).not.toContain("DATA_TOKEN");
    expect(dataSection).toContain('(name = "DATA_TOKEN", text = "facade-only-token")');
    expect(config).toContain(`address = "${currentDataPlaneAddress}"`);
    expect(config).not.toContain(persistedDataPlaneAddress);
    for (const forbidden of [
      "public.example.invalid",
      "index.html",
      "EVENT_TOKEN",
      "event-only-token",
      "selfhost-events.invalid",
      "ROUTES",
      "event-dispatcher.js",
    ]) {
      expect(config).not.toContain(forbidden);
    }

    const applicationRoot = join(preparedRoot, "application");
    const hostRoot = join(preparedRoot, "host-private");
    const applicationFiles = (await readdir(applicationRoot)).sort();
    const hostFiles = (await readdir(hostRoot)).sort();
    expect(applicationFiles).toEqual(["module-00000", "module-00001", "module-00002"]);
    const applicationSources = await Promise.all(
      applicationFiles.map(async (name) =>
        new TextDecoder().decode(await readFile(join(applicationRoot, name))),
      ),
    );
    expect(applicationSources.join("\n")).toContain("application-evaluated-a");
    const hostSources = await Promise.all(
      hostFiles.map(async (name) => new TextDecoder().decode(await readFile(join(hostRoot, name)))),
    );
    expect(hostSources).toContain('export const hostVersion = "a";');
    expect(hostSources).toContain('export const sharedHostModule = "a";');

    const entry = hostSources.find((source) => source.includes("createWorkflowHttpBootstrap"));
    if (!entry) throw new Error("generated workflow entrypoint is unavailable");
    const encodedOptions = /createWorkflowHttpBootstrap\(JSON\.parse\((.+)\)\);/u.exec(entry)?.[1];
    if (!encodedOptions) throw new Error("generated workflow options are unavailable");
    const bootstrapOptions = JSON.parse(JSON.parse(encodedOptions)) as {
      readonly className: string;
      readonly applicationModule: string;
      readonly wrapperModule: string;
      readonly params: JsonObject;
    };
    expect(bootstrapOptions).toMatchObject({
      className: "ApprovedWorkflow",
      applicationModule: "./index.js",
      wrapperModule: `./${HOST_ENTRYPOINT}`,
    });
    expect(bootstrapOptions.params).toEqual(input);
    expect(Object.hasOwn(bootstrapOptions.params, "__proto__")).toBe(true);
    expect((bootstrapOptions.params as Record<string, unknown>).polluted).toBeUndefined();

    expect(await permissions(preparedRoot)).toBe(0o700);
    expect(await permissions(applicationRoot)).toBe(0o700);
    expect(await permissions(hostRoot)).toBe(0o700);
    expect(await permissions(prepared.configPath)).toBe(0o600);
    for (const name of applicationFiles)
      expect(await permissions(join(applicationRoot, name))).toBe(0o600);
    for (const name of hostFiles) expect(await permissions(join(hostRoot, name))).toBe(0o600);
    await expect(stat(join(preparedRoot, "assets"))).rejects.toThrow();
  } finally {
    await disposePrepared(prepared);
  }
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("keeps application and Host namespaces distinct while suffixing generated module names", async () => {
  await publish({ collisionNames: true, generation: "generation-collision" });
  const prepared = await preparation(target(), {
    dataPlaneAddress: () => currentDataPlaneAddress,
  })(identity, undefined, new AbortController().signal, channel());
  try {
    const config = await readFile(prepared.configPath, "utf8");
    expect(config).toContain('(name = "__workflow_entry-2.js"');
    expect(config).toContain('(name = "__workflow_bootstrap-2.js"');
    expect(config).toMatch(
      /\(name = "index\.js", esModule = embed "\.\/host-private\/[^"\n]+", role = hostPrivate\)/u,
    );
    expect(config).toMatch(
      /\(name = "index\.js", esModule = embed "\.\/application\/[^"\n]+", role = application\)/u,
    );
  } finally {
    await disposePrepared(prepared);
  }

  await publish({
    generation: "generation-wrapper-main",
    mainModule: "same.js",
    hostEntrypoint: "same.js",
  });
  const refused = preparation(target({ script: "site", className: "ApprovedWorkflow" }));
  await expect(
    refused(identity, undefined, new AbortController().signal, channel()),
  ).rejects.toThrow("no importable private env projector");
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("rejects an absent publication, stale Worker identity, or cross-tenant target", async () => {
  await publish();
  const missing = preparation(target({ script: "missing" }));
  await expect(
    missing(identity, undefined, new AbortController().signal, channel()),
  ).rejects.toMatchObject({
    code: "host_unavailable",
  });

  const stale = preparation(target({ workerResourceUid: "uid-ModuleWorker-stale" }));
  await expect(
    stale(identity, undefined, new AbortController().signal, channel()),
  ).rejects.toMatchObject({
    code: "host_unavailable",
  });

  const crossTenant = preparation(target({ tenantId: "tenant-2" }));
  await expect(
    crossTenant(identity, undefined, new AbortController().signal, channel()),
  ).rejects.toMatchObject({
    code: "host_unavailable",
  });
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("uses the current data-plane callback and refuses service bindings instead of dropping them", async () => {
  await publish();
  const missingAddress = preparation(target());
  await expect(
    missingAddress(identity, undefined, new AbortController().signal, channel()),
  ).rejects.toThrow("unusable data plane address");
  expect(await readdir(temporaryRoot)).toEqual([]);

  await publish({ generation: "generation-service-binding", serviceBindings: [SERVICE_BINDING] });
  const refused = preparation(target());
  await expect(
    refused(identity, undefined, new AbortController().signal, channel()),
  ).rejects.toThrow("service binding bridge is unavailable");
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("pins the selected service binding and releases it only after prepared disposal", async () => {
  await publish({ generation: "generation-service-positive", serviceBindings: [SERVICE_BINDING] });
  let acquiredIdentity: WorkerdSelectedVersionIdentity | undefined;
  let releaseCount = 0;
  const lease: WorkerdPrivateServiceLease = {
    services: [
      {
        name: SERVICE_BINDING.name,
        upstreamSocket: "/tmp/takoserver-service-upstream.sock",
        unavailableToken: SERVICE_BINDING.unavailableToken,
      },
    ],
    async release() {
      releaseCount += 1;
    },
  };
  const prepared = await preparation(target(), {
    dataPlaneAddress: () => currentDataPlaneAddress,
    serviceRuntime: {
      async acquirePrivateServiceBindings(value) {
        acquiredIdentity = value;
        return lease;
      },
    },
  })(identity, undefined, new AbortController().signal, channel());
  try {
    const config = await readFile(prepared.configPath, "utf8");
    const preparedRoot = dirname(prepared.configPath);
    expect(acquiredIdentity).toMatchObject({
      script: "site",
      generation: "generation-service-positive",
      generationKey: expect.stringMatching(/^[0-9a-f]{64}$/u),
      workerResourceUid: "uid-ModuleWorker-site",
      versionId: "site-v-a",
      workerVersionUid: "uid-WorkerVersion-site-a",
    });
    expect(config).toContain(`(name = "${SERVICE_BINDING.name}", service = "service-0")`);
    expect(config).toContain(`unix:${preparedRoot}/s0.sock`);
    expect(prepared.serviceGateways).toEqual([
      {
        listenPath: join(preparedRoot, "s0.sock"),
        upstreamPath: "/tmp/takoserver-service-upstream.sock",
        unavailableToken: SERVICE_BINDING.unavailableToken,
      },
    ]);
    expect(releaseCount).toBe(0);
    await prepared.drainAfterStop();
    expect(releaseCount).toBe(0);
    await prepared.dispose();
    expect(releaseCount).toBe(1);
    await prepared.dispose();
    expect(releaseCount).toBe(1);
  } catch (error) {
    await prepared.drainAfterStop().catch(() => undefined);
    await prepared.dispose().catch(() => undefined);
    throw error;
  }
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("releases a service lease when mapping fails or cancellation arrives after acquisition", async () => {
  await publish({ generation: "generation-service-failure", serviceBindings: [SERVICE_BINDING] });
  let mismatchReleaseCount = 0;
  const mismatch = preparation(target(), {
    dataPlaneAddress: () => currentDataPlaneAddress,
    serviceRuntime: {
      async acquirePrivateServiceBindings() {
        return {
          services: [
            {
              name: "__TAKOSERVER_SELFHOST_SERVICE_00002",
              upstreamSocket: "/tmp/takoserver-service-upstream.sock",
              unavailableToken: SERVICE_BINDING.unavailableToken,
            },
          ],
          async release() {
            mismatchReleaseCount += 1;
          },
        };
      },
    },
  });
  await expect(
    mismatch(identity, undefined, new AbortController().signal, channel()),
  ).rejects.toThrow("does not match selected Version");
  expect(mismatchReleaseCount).toBe(1);
  expect(await readdir(temporaryRoot)).toEqual([]);

  const abortDuringAcquire = new AbortController();
  let abortReleaseCount = 0;
  const aborting = preparation(target(), {
    dataPlaneAddress: () => currentDataPlaneAddress,
    serviceRuntime: {
      async acquirePrivateServiceBindings() {
        abortDuringAcquire.abort();
        return {
          services: [
            {
              name: SERVICE_BINDING.name,
              upstreamSocket: "/tmp/takoserver-service-upstream.sock",
              unavailableToken: SERVICE_BINDING.unavailableToken,
            },
          ],
          async release() {
            abortReleaseCount += 1;
          },
        };
      },
    },
  });
  await expect(
    aborting(identity, undefined, abortDuringAcquire.signal, channel()),
  ).rejects.toThrow();
  expect(abortReleaseCount).toBe(1);
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("aborted preparation and renderer failure remove every temporary execution directory", async () => {
  await publish();
  let releaseTarget!: (value: SelfhostWorkflowTarget) => void;
  const unresolvedTarget = new Promise<SelfhostWorkflowTarget>((resolve) => {
    releaseTarget = resolve;
  });
  let resolverSignal!: AbortSignal;
  let markLookupEntered!: () => void;
  const lookupEntered = new Promise<void>((resolve) => {
    markLookupEntered = resolve;
  });
  const pending = createSelfhostWorkflowPreparation({
    runtimeRoot,
    temporaryRoot,
    resolveTarget: async (_value, signal) => {
      resolverSignal = signal;
      markLookupEntered();
      return unresolvedTarget;
    },
  });
  const pendingAbort = new AbortController();
  const pendingRun = pending(identity, undefined, pendingAbort.signal, channel());
  await lookupEntered;
  pendingAbort.abort();
  await expect(pendingRun).rejects.toBe(pendingAbort.signal.reason);
  expect(resolverSignal.aborted).toBe(true);
  releaseTarget(target());
  expect(await readdir(temporaryRoot)).toEqual([]);

  const alreadyAborted = new AbortController();
  alreadyAborted.abort();
  const prepare = preparation(target(), { dataPlaneAddress: () => currentDataPlaneAddress });
  await expect(prepare(identity, undefined, alreadyAborted.signal, channel())).rejects.toThrow();
  expect(await readdir(temporaryRoot)).toEqual([]);

  const abortDuringRender = new AbortController();
  let callbackCalls = 0;
  const partial = preparation(target(), {
    dataPlaneAddress: () => {
      callbackCalls += 1;
      abortDuringRender.abort();
      return currentDataPlaneAddress;
    },
  });
  await expect(partial(identity, undefined, abortDuringRender.signal, channel())).rejects.toThrow();
  expect(callbackCalls).toBe(1);
  expect(await readdir(temporaryRoot)).toEqual([]);
});
