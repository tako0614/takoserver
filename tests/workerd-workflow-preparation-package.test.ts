import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { readdir, readFile, rename, symlink, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as root from "@takoserver/core";
import * as providerExtension from "@takoserver/core/provider-extension";
import type {
  JsonObject,
  WorkflowExecutionHost,
  WorkflowRunIdentity,
} from "@takoserver/core/workflow-runtime";
import * as neutralRuntime from "@takoserver/core/workflow-runtime";
import type {
  PreparedWorkerdWorkflow,
  WorkerdPrivateServiceLease,
  WorkerdSite,
  WorkerdWorkflowPreparationOptions,
  WorkerdWorkflowSelection,
} from "@takoserver/core/workflow-runtime/workerd";
import * as workerdRuntime from "@takoserver/core/workflow-runtime/workerd";

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const JOURNAL_TOKEN = "a".repeat(64);
const SERVICE_TOKEN = "b".repeat(64);
const CURRENT_DATA_PLANE = "127.0.0.1:4666";
const PERSISTED_DATA_PLANE = "127.0.0.1:4555";

const identity: WorkflowRunIdentity = {
  scope: { tenantId: "tenant-1", workflowResourceUid: "workflow-1" },
  instanceId: "instance-1",
  executionId: "execution-1",
  createdAt: 10,
  epoch: 1,
  owner: "owner-1",
  deadlineAt: 1_000,
};

let temporaryRoot: string;
let cleanupRoots: string[];

beforeEach(() => {
  temporaryRoot = mkdtempSync(join(tmpdir(), "twf-pkg-"));
  chmodSync(temporaryRoot, 0o700);
  cleanupRoots = [];
});

afterEach(() => {
  for (const rootPath of cleanupRoots.splice(0)) {
    rmSync(rootPath, { recursive: true, force: true });
  }
  rmSync(temporaryRoot, { recursive: true, force: true });
});

const serviceBinding: NonNullable<WorkerdSite["serviceBindings"]>[number] = {
  name: "__TAKOSERVER_SELFHOST_SERVICE_00001",
  target: "service",
  targetResourceUid: "uid-Service",
  unavailableToken: SERVICE_TOKEN,
};

function site(overrides: Partial<WorkerdSite> = {}): WorkerdSite {
  return {
    directory: "site",
    mainModule: "main.js",
    hostEntrypoint: "wrapper.js",
    hostModules: ["wrapper.js", "host-helper.js", "data.js"],
    hostnames: [],
    generation: "generation-1",
    workerResourceUid: "worker-1",
    fetchHandler: true,
    vars: [{ name: "APP_VALUE", value: "app-original", kind: "text" }],
    modules: ["aux.js"],
    moduleMediaTypes: {
      "main.js": "application/javascript+module",
      "aux.js": "application/javascript+module",
    },
    dataPlane: {
      address: PERSISTED_DATA_PLANE,
      module: "data.js",
      vars: [{ name: "DATA_TOKEN", value: "data-original", kind: "text" }],
    },
    ...overrides,
  };
}

function selection(overrides: Partial<WorkerdWorkflowSelection> = {}): WorkerdWorkflowSelection {
  const selectedSite = overrides.site ?? site();
  return {
    tenantId: "tenant-1",
    workflowResourceUid: "workflow-1",
    workerResourceUid: "worker-1",
    versionId: "version-1",
    workerVersionUid: "worker-version-1",
    className: "ApprovedWorkflow",
    site: selectedSite,
    modules: new Map([
      ["main.js", encoder.encode('throw new Error("application-evaluated");')],
      ["aux.js", encoder.encode("export const aux = 'aux-original';")],
    ]),
    hostModules: new Map([
      ["wrapper.js", encoder.encode("export const wrapper = 'wrapper-original';")],
      ["host-helper.js", encoder.encode("export const helper = 'helper-original';")],
      ["data.js", encoder.encode("export const data = 'data-original';")],
    ]),
    ...overrides,
  };
}

function preparationOptions(
  overrides: Partial<WorkerdWorkflowPreparationOptions> = {},
): WorkerdWorkflowPreparationOptions {
  const input: JsonObject = { nested: { value: "input-original" } };
  const selected = selection();
  return {
    selection: selected,
    identity,
    input,
    signal: new AbortController().signal,
    channel: {
      journalToken: JOURNAL_TOKEN,
      recordPayload() {},
    },
    temporaryRoot,
    dataPlaneAddress: () => CURRENT_DATA_PLANE,
    ...overrides,
  };
}

async function disposePrepared(prepared: PreparedWorkerdWorkflow): Promise<void> {
  await prepared.drainAfterStop();
  await prepared.dispose();
}

async function preparedSources(rootPath: string, directory: string): Promise<string> {
  const names = (await readdir(join(rootPath, directory))).sort();
  const sources = await Promise.all(
    names.map(async (name) => decoder.decode(await readFile(join(rootPath, directory, name)))),
  );
  return sources.join("\n");
}

test("workerd package surface exports only concrete factory and preparation", () => {
  expect(Object.keys(workerdRuntime).sort()).toEqual([
    "createWorkerdWorkflowExecutionHost",
    "prepareWorkerdWorkflowExecution",
  ]);
  for (const name of ["createWorkerdWorkflowExecutionHost", "prepareWorkerdWorkflowExecution"]) {
    expect(name in neutralRuntime).toBe(false);
    expect(name in root).toBe(false);
    expect(name in providerExtension).toBe(false);
  }
});

test("package preparation materializes a selected graph privately without app evaluation", async () => {
  const options = preparationOptions();
  const prepared = await workerdRuntime.prepareWorkerdWorkflowExecution(options);
  try {
    const rootPath = dirname(prepared.configPath);
    const config = await readFile(prepared.configPath, "utf8");
    const application = await preparedSources(rootPath, "application");
    const hostPrivate = await preparedSources(rootPath, "host-private");

    expect(application).toContain("application-evaluated");
    expect(config).toContain('APP_VALUE", text = "app-original"');
    expect(config).toContain('DATA_TOKEN", text = "data-original"');
    expect(config).toContain(`address = "${CURRENT_DATA_PLANE}"`);
    expect(config).not.toContain(PERSISTED_DATA_PLANE);
    expect(hostPrivate).toContain("wrapper-original");
    expect(hostPrivate).toContain("data-original");
    for (const forbidden of [
      "active.json",
      "generationKey",
      "registry",
      "public.example.invalid",
      "event-dispatcher.js",
    ]) {
      expect(config).not.toContain(forbidden);
    }
  } finally {
    await disposePrepared(prepared);
  }
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("preparation snapshots maps, nested site vars, and input before caller mutation", async () => {
  const options = preparationOptions();
  const selected = options.selection;
  const input = options.input as unknown as { nested: { value: string } };
  const moduleBytes = selected.modules.get("aux.js");
  const hostBytes = selected.hostModules.get("wrapper.js");
  const mutableSite = selected.site as unknown as {
    vars: Array<{ name: string; value: string; kind: "text" | "json" }>;
    dataPlane: {
      address: string;
      module: string;
      vars: Array<{ name: string; value: string; kind: "text" | "json" }>;
    };
  };
  const appVariable = mutableSite.vars[0];
  const dataVariable = mutableSite.dataPlane.vars[0];
  if (!moduleBytes || !hostBytes || !appVariable || !dataVariable) {
    throw new Error("incomplete snapshot fixture");
  }
  const pending = workerdRuntime.prepareWorkerdWorkflowExecution(options);
  moduleBytes.set(encoder.encode("export const aux = 'aux-mutated';"));
  hostBytes.set(encoder.encode("export const wrapper = 'wrapper-mutated';"));
  appVariable.value = "app-mutated";
  dataVariable.value = "data-mutated";
  mutableSite.dataPlane.address = "mutated.invalid:9";
  input.nested.value = "input-mutated";

  const prepared = await pending;
  try {
    const rootPath = dirname(prepared.configPath);
    const config = await readFile(prepared.configPath, "utf8");
    const application = await preparedSources(rootPath, "application");
    const hostPrivate = await preparedSources(rootPath, "host-private");
    expect(application).toContain("aux-original");
    expect(application).not.toContain("aux-mutated");
    expect(hostPrivate).toContain("wrapper-original");
    expect(hostPrivate).not.toContain("wrapper-mutated");
    expect(config).toContain('APP_VALUE", text = "app-original"');
    expect(config).not.toContain("app-mutated");
    expect(config).toContain('DATA_TOKEN", text = "data-original"');
    expect(config).not.toContain("data-mutated");
    expect(config).not.toContain("mutated.invalid:9");
    expect(hostPrivate).toContain("input-original");
    expect(hostPrivate).not.toContain("input-mutated");
  } finally {
    await disposePrepared(prepared);
  }
});

test("scope and Worker identity mismatches refuse before creating a temporary execution", async () => {
  const mismatches: readonly WorkerdWorkflowSelection[] = [
    selection({ tenantId: "tenant-other" }),
    selection({ site: site({ workerResourceUid: "worker-other" }) }),
  ];
  for (const selected of mismatches) {
    await expect(
      workerdRuntime.prepareWorkerdWorkflowExecution({
        ...preparationOptions(),
        selection: selected,
      }),
    ).rejects.toMatchObject({ code: "invalid_runtime_input" });
    expect(await readdir(temporaryRoot)).toEqual([]);
  }
});

test("malformed and mismatched private service leases release on rejection", async () => {
  const cases: readonly WorkerdPrivateServiceLease[] = [
    {
      services: [
        { name: serviceBinding.name, upstreamSocket: "", unavailableToken: SERVICE_TOKEN },
      ],
      async release() {},
    },
    {
      services: [
        {
          name: "OTHER_SERVICE",
          upstreamSocket: "/tmp/upstream.sock",
          unavailableToken: SERVICE_TOKEN,
        },
      ],
      async release() {},
    },
  ];
  for (const candidate of cases) {
    let releases = 0;
    const lease = {
      ...candidate,
      release: async () => {
        releases += 1;
      },
    };
    const selected = selection({ site: site({ serviceBindings: [serviceBinding] }) });
    await expect(
      workerdRuntime.prepareWorkerdWorkflowExecution({
        ...preparationOptions(),
        selection: selected,
        acquireServiceBindings: async () => lease,
      }),
    ).rejects.toThrow();
    expect(releases).toBe(1);
    expect(await readdir(temporaryRoot)).toEqual([]);
  }
});

test("service acquisition receives the preparation signal and abort removes its temporary root", async () => {
  const controller = new AbortController();
  let acquiredSignal: AbortSignal | undefined;
  let entered!: () => void;
  const enteredPromise = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const pending = workerdRuntime.prepareWorkerdWorkflowExecution({
    ...preparationOptions({ signal: controller.signal }),
    selection: selection({ site: site({ serviceBindings: [serviceBinding] }) }),
    acquireServiceBindings: (signal) => {
      acquiredSignal = signal;
      entered();
      return new Promise<WorkerdPrivateServiceLease>((_resolve, reject) => {
        const abort = () => {
          signal.removeEventListener("abort", abort);
          reject(new Error("service acquisition aborted"));
        };
        if (signal.aborted) abort();
        else signal.addEventListener("abort", abort, { once: true });
      });
    },
  });
  await enteredPromise;
  expect(acquiredSignal).toBe(controller.signal);
  controller.abort();
  await expect(pending).rejects.toThrow("service acquisition aborted");
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("dispose retains combined cleanup failures, retries failed release, and is idempotent", async () => {
  let releases = 0;
  const lease: WorkerdPrivateServiceLease = {
    services: [
      {
        name: serviceBinding.name,
        upstreamSocket: "/tmp/upstream.sock",
        unavailableToken: SERVICE_TOKEN,
      },
    ],
    async release() {
      releases += 1;
      if (releases === 1) throw new Error("release failed");
    },
  };
  const prepared = await workerdRuntime.prepareWorkerdWorkflowExecution({
    ...preparationOptions(),
    selection: selection({ site: site({ serviceBindings: [serviceBinding] }) }),
    acquireServiceBindings: async () => lease,
  });
  await prepared.drainAfterStop();

  const savedRoot = `${temporaryRoot}-saved`;
  cleanupRoots.push(savedRoot);
  await rename(temporaryRoot, savedRoot);
  await symlink(temporaryRoot, temporaryRoot);
  let firstError: unknown;
  try {
    await prepared.dispose();
  } catch (error) {
    firstError = error;
  }
  await unlink(temporaryRoot).catch(() => undefined);
  await rename(savedRoot, temporaryRoot);

  expect(firstError).toBeInstanceOf(AggregateError);
  const failures = firstError instanceof AggregateError ? firstError.errors : [];
  expect(failures).toHaveLength(2);
  expect(
    failures.some((failure) => failure instanceof Error && failure.message === "release failed"),
  ).toBe(true);
  expect(releases).toBe(1);

  await prepared.dispose();
  expect(releases).toBe(2);
  await prepared.dispose();
  expect(releases).toBe(2);
  expect(await readdir(temporaryRoot)).toEqual([]);
});

test("public workerd factory ignores a cast-injected spawnGuard", async () => {
  const privateRoot = mkdtempSync(join(tmpdir(), "takoserver-workflow-runtime-guard-"));
  cleanupRoots.push(privateRoot);
  const missingGuard = join(privateRoot, "missing-guard");
  const missingWorkerd = join(privateRoot, "missing-workerd");
  let injectedCalls = 0;
  let prepareCalls = 0;
  const injected = () => {
    injectedCalls += 1;
    throw new Error("injected guard must not run");
  };
  const host = workerdRuntime.createWorkerdWorkflowExecutionHost({
    guardBinary: missingGuard,
    workerdBinary: missingWorkerd,
    maximumRegistrations: 1,
    clock: () => 20,
    prepare: async () => {
      prepareCalls += 1;
      throw new Error("prepare must not run");
    },
    spawnGuard: injected,
  } as never) as WorkflowExecutionHost & { close(): Promise<void> };
  try {
    await expect(host.openPaused(identity, undefined, 100)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(injectedCalls).toBe(0);
    expect(prepareCalls).toBe(0);
  } finally {
    await host.close();
  }
});
