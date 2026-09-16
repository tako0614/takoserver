import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import {
  WORKFLOW_LOADER_OUTER_SOURCE,
  WORKFLOW_LOADER_TENANT_SOURCE,
} from "./generated/workflow-loader-bootstrap.ts";
import type { JsonObject } from "./ports.ts";
import type { PreparedWorkerdWorkflow } from "./selfhost-workflow-execution-host.ts";
import { prepareWorkflowHttpExecution } from "./selfhost-workflow-http-transport.ts";
import type { WorkerdExecutionServiceGateway } from "./workerd-execution-guard.ts";
import {
  type WorkerdModuleMediaType,
  type WorkerdPrivateServiceLease,
  type WorkerdSite,
  writeWorkerdPrivateExecution,
} from "./workerd-runtime.ts";
import { WorkflowRuntimeError } from "./workflow-driver.ts";
import type { WorkflowRunIdentity } from "./workflow-execution.ts";
import {
  WORKFLOW_COMPANION_BINDING,
  WORKFLOW_HOST_BINDING,
  WORKFLOW_LOADER_BINDING,
  type WorkflowLoaderModule,
} from "./workflow-loader-outer-worker.ts";

/**
 * Secret-bearing, already selected execution graph supplied by the trusted Host.
 * The caller must qualify the exact active Version, module digests, immutable
 * Workflow class and same-tenant Resource relation before constructing this.
 * No filesystem publication key, provider desired state or admission flag is a
 * substitute for that selection. This materializer does not grant admission.
 */
export interface WorkerdWorkflowSelection {
  readonly tenantId: string;
  readonly workflowResourceUid: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionUid: string;
  readonly className: string;
  readonly site: WorkerdSite;
  readonly modules: ReadonlyMap<string, Uint8Array>;
  readonly hostModules: ReadonlyMap<string, Uint8Array>;
}

export interface WorkerdWorkflowPreparationOptions {
  readonly selection: WorkerdWorkflowSelection;
  readonly identity: WorkflowRunIdentity;
  readonly input: JsonObject | undefined;
  readonly signal: AbortSignal;
  readonly channel: {
    readonly journalToken: string;
    readonly recordPayload: (sequence: number, payload: string) => void;
  };
  readonly temporaryRoot?: string;
  /** Read the currently serving Host-private data plane, never a persisted address. */
  readonly dataPlaneAddress?: () => string;
  /**
   * Acquire for this exact selection, not whichever Version is active later.
   * The Host captures its own receipt/publication identity in this callback.
   * Honor cancellation: settle and undo any partial acquisition on abort, or
   * return an already acquired lease so this preparer can release it. Never
   * detach a late acquisition whose lease has no cleanup owner.
   * Once resolved, this preparer owns release, including failure and abort.
   */
  readonly acquireServiceBindings?: (signal: AbortSignal) => Promise<WorkerdPrivateServiceLease>;
}

const DATA_SERVICE_BINDING = "__TAKOSERVER_SELFHOST_DATA";
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });
const utf8Encoder = new TextEncoder();

interface WorkflowLoaderStaticGraph {
  readonly outerEntrypoint: string;
  readonly outerModules: ReadonlyMap<string, Uint8Array>;
  readonly outerModuleMediaTypes: Readonly<Record<string, WorkerdModuleMediaType>>;
  readonly staticHostModules: ReadonlyMap<string, Uint8Array>;
}

function encoderEncode(value: string): Uint8Array {
  return utf8Encoder.encode(value);
}

function loaderModuleValue(
  bytes: Uint8Array,
  mediaType: WorkerdModuleMediaType,
): WorkflowLoaderModule {
  try {
    switch (mediaType) {
      case "application/javascript+module":
        return { js: utf8Decoder.decode(bytes) };
      case "text/plain":
        return { text: utf8Decoder.decode(bytes) };
      case "application/octet-stream":
        return { data: new Uint8Array(bytes) };
      case "application/wasm":
        return { wasm: new Uint8Array(bytes) };
    }
  } catch {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }
  throw new WorkflowRuntimeError("invalid_runtime_input");
}

interface LoaderSourceEntry {
  readonly name: string;
  readonly value: WorkflowLoaderModule;
  readonly carrier: string;
}

function staticCarrierMedia(value: WorkflowLoaderModule): WorkerdModuleMediaType {
  return Object.hasOwn(value, "data") || Object.hasOwn(value, "wasm")
    ? "application/octet-stream"
    : "text/plain";
}

function importedModuleExpression(value: WorkflowLoaderModule, imported: string): string {
  if (Object.hasOwn(value, "js")) return `{js:${imported}}`;
  if (Object.hasOwn(value, "cjs")) return `{cjs:${imported}}`;
  if (Object.hasOwn(value, "text")) return `{text:${imported}}`;
  if (Object.hasOwn(value, "json")) return `{json:${imported}}`;
  if (Object.hasOwn(value, "py")) return `{py:${imported}}`;
  if (Object.hasOwn(value, "wasm")) return `{wasm:copyBytes(${imported})}`;
  if (Object.hasOwn(value, "data")) return `{data:copyBytes(${imported})}`;
  throw new WorkflowRuntimeError("invalid_runtime_input");
}

function tenantEntrySource(
  helper: string,
  options: {
    readonly className: string;
    readonly instanceId: string;
    readonly params?: JsonObject;
    readonly wrapperModule: string;
    readonly applicationModule: string;
  },
): string {
  // Parse the JSON text at bootstrap time rather than embedding an object
  // literal. In particular, an input key named `__proto__` must remain an own
  // params key, never become an object-literal prototype setter.
  const literal = JSON.stringify(JSON.stringify(options));
  return `import { createWorkflowLoaderTenantBootstrap } from ${JSON.stringify(`./${helper}`)};\nexport default createWorkflowLoaderTenantBootstrap(JSON.parse(${literal}));\n`;
}

function outerEntrySource(
  helper: string,
  options: {
    readonly token: string;
    readonly mainModule: string;
    readonly applicationMain: string;
    readonly applicationEntries: readonly LoaderSourceEntry[];
    readonly hostEntries: readonly LoaderSourceEntry[];
    readonly childBindingNames: readonly string[];
  },
): string {
  const entries = [...options.applicationEntries, ...options.hostEntries];
  const carriers = [...new Set(entries.map((entry) => entry.carrier))];
  const imports = carriers
    .map((carrier, index) => `import payload${index} from ${JSON.stringify(`./${carrier}`)};`)
    .join("\n");
  const imported = new Map(carriers.map((carrier, index) => [carrier, `payload${index}`]));
  const render = (entry: LoaderSourceEntry): string => {
    const variable = imported.get(entry.carrier);
    if (!variable) throw new WorkflowRuntimeError("invalid_runtime_input");
    return `modules[${JSON.stringify(entry.name)}]=${importedModuleExpression(entry.value, variable)};`;
  };
  const applicationAssignments = options.applicationEntries.map(render).join("");
  const hostAssignments = options.hostEntries
    .map((entry) => {
      const variable = imported.get(entry.carrier);
      if (!variable) throw new WorkflowRuntimeError("invalid_runtime_input");
      return `hostPrivateModules[${JSON.stringify(entry.name)}]=${importedModuleExpression(entry.value, variable)};`;
    })
    .join("");
  const literal = `{
  token:${JSON.stringify(options.token)},
  mainModule:${JSON.stringify(options.mainModule)},
  applicationMain:${JSON.stringify(options.applicationMain)},
  modules,
  hostPrivateModules,
  childBindingNames:${JSON.stringify(options.childBindingNames)},
}`;
  return `${imports}${imports.length > 0 ? "\n" : ""}import { createWorkflowLoaderOuterBootstrap } from ${JSON.stringify(`./${helper}`)};\nconst copyBytes = (value) => new Uint8Array(value);\nconst modules = Object.create(null);\n${applicationAssignments}\nconst hostPrivateModules = Object.create(null);\n${hostAssignments}\nconst runtime = createWorkflowLoaderOuterBootstrap(${literal});\nexport default runtime.default;\nexport const WorkflowHost = runtime.WorkflowHost;\n`;
}

function snapshotModules(source: ReadonlyMap<string, Uint8Array>): Map<string, Uint8Array> {
  const captured = new Map<string, Uint8Array>();
  for (const [name, bytes] of source) {
    if (!(bytes instanceof Uint8Array)) {
      throw new WorkflowRuntimeError("invalid_runtime_input");
    }
    captured.set(name, new Uint8Array(bytes));
  }
  return captured;
}

function privateServiceMappings(
  root: string,
  bindings: NonNullable<WorkerdSite["serviceBindings"]>,
  lease: WorkerdPrivateServiceLease,
): {
  readonly bindings: readonly { readonly name: string; readonly socketPath: string }[];
  readonly gateways: readonly WorkerdExecutionServiceGateway[];
} {
  if (!lease || !Array.isArray(lease.services) || typeof lease.release !== "function") {
    throw new Error("invalid private service lease");
  }
  if (lease.services.length !== bindings.length) {
    throw new Error("private service lease does not match selected Version");
  }
  const services = new Map<string, (typeof lease.services)[number]>();
  for (const service of lease.services) {
    if (
      typeof service?.name !== "string" ||
      typeof service.upstreamSocket !== "string" ||
      service.upstreamSocket.length === 0 ||
      typeof service.unavailableToken !== "string" ||
      services.has(service.name)
    ) {
      throw new Error("invalid private service lease");
    }
    services.set(service.name, service);
  }
  const mappedBindings: Array<{ readonly name: string; readonly socketPath: string }> = [];
  const gateways: WorkerdExecutionServiceGateway[] = [];
  for (const [index, binding] of bindings.entries()) {
    const service = services.get(binding.name);
    if (!service || service.unavailableToken !== binding.unavailableToken) {
      throw new Error("private service lease does not match selected Version");
    }
    const socketPath = join(root, `s${index.toString(10)}.sock`);
    mappedBindings.push({ name: binding.name, socketPath });
    gateways.push({
      listenPath: socketPath,
      upstreamPath: service.upstreamSocket,
      unavailableToken: service.unavailableToken,
    });
  }
  return { bindings: mappedBindings, gateways };
}

/**
 * Prepare one guarded workerd execution without evaluating application code.
 * Call only from the execution Host's run-time prepare callback, after fresh
 * authority selection; never select or materialize during openPaused().
 * The guard Host owns reap/frame sealing, then calls the returned disposer.
 * HTTP controller, bootstrap protocol and filesystem assembly stay internal.
 */
export async function prepareWorkerdWorkflowExecution(
  options: WorkerdWorkflowPreparationOptions,
): Promise<PreparedWorkerdWorkflow> {
  const { signal, dataPlaneAddress: readDataPlaneAddress, acquireServiceBindings } = options;
  signal.throwIfAborted();
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  const selected = options.selection;
  if (
    !isAbsolute(temporaryRoot) ||
    selected.tenantId !== options.identity.scope.tenantId ||
    selected.workflowResourceUid !== options.identity.scope.workflowResourceUid ||
    [
      selected.workerResourceUid,
      selected.versionId,
      selected.workerVersionUid,
      selected.className,
    ].some(
      (value) => typeof value !== "string" || value.length === 0 || value.includes("\u0000"),
    ) ||
    selected.site.workerResourceUid !== selected.workerResourceUid
  ) {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }
  // Take every mutable caller-owned graph byte and nested declaration before
  // the first asynchronous materialization/lease call. A later publication or
  // caller mutation cannot change this execution's captured selection.
  const site = structuredClone(selected.site);
  const modules = snapshotModules(selected.modules);
  const hostModules = snapshotModules(selected.hostModules);
  const channel = { ...options.channel };
  const wrapper = site.hostEntrypoint;
  if (!wrapper || wrapper === site.mainModule) {
    // Application-main resolution precedes Host lookup except for startup.
    throw new Error("selected Version has no importable private env projector");
  }
  const occupied = new Set([...modules.keys(), ...hostModules.keys(), site.mainModule]);
  function allocate(stem: string): string {
    let name = `${stem}.js`;
    for (let suffix = 1; occupied.has(name); suffix += 1) name = `${stem}-${suffix}.js`;
    occupied.add(name);
    return name;
  }
  const outerEntrypoint = allocate("__workflow_outer");
  const outerHelper = allocate("__workflow_outer_helper");
  const tenantEntrypoint = allocate("__workflow_tenant");
  const tenantHelper = allocate("__workflow_tenant_helper");
  const encoder = new TextEncoder();
  let payloadIndex = 0;
  const payloads = new Map<
    string,
    { readonly bytes: Uint8Array; readonly mediaType: WorkerdModuleMediaType }
  >();
  function payloadFor(bytes: Uint8Array, value: WorkflowLoaderModule): string {
    let name = `__workflow_payload_${payloadIndex.toString(10).padStart(5, "0")}`;
    payloadIndex += 1;
    while (occupied.has(name)) {
      name = `__workflow_payload_${payloadIndex.toString(10).padStart(5, "0")}`;
      payloadIndex += 1;
    }
    occupied.add(name);
    payloads.set(name, { bytes: new Uint8Array(bytes), mediaType: staticCarrierMedia(value) });
    return name;
  }

  const applicationNames = [site.mainModule, ...(site.modules ?? [])];
  const applicationEntries = applicationNames.map((name) => {
    const bytes = modules.get(name);
    if (!(bytes instanceof Uint8Array)) throw new WorkflowRuntimeError("invalid_runtime_input");
    const mediaType = site.moduleMediaTypes?.[name] ?? "application/javascript+module";
    const value = loaderModuleValue(bytes, mediaType);
    return { name, value, carrier: payloadFor(bytes, value) } satisfies LoaderSourceEntry;
  });

  const hostNames = [
    ...(wrapper === undefined ? [] : [wrapper]),
    ...(site.hostModules ?? []),
  ].filter(
    (name, index, names) =>
      name !== site.dataPlane?.module &&
      name !== site.events?.module &&
      names.indexOf(name) === index,
  );
  const tenantEntries = hostNames.map((name) => {
    const bytes = hostModules.get(name);
    if (!(bytes instanceof Uint8Array)) throw new WorkflowRuntimeError("invalid_runtime_input");
    const value = loaderModuleValue(bytes, "application/javascript+module");
    return { name, value, carrier: payloadFor(bytes, value) } satisfies LoaderSourceEntry;
  });
  const tenantHelperValue = { js: WORKFLOW_LOADER_TENANT_SOURCE } satisfies WorkflowLoaderModule;
  tenantEntries.push({
    name: tenantHelper,
    value: tenantHelperValue,
    carrier: payloadFor(encoderEncode(tenantHelperValue.js), tenantHelperValue),
  });
  const tenantOptions = {
    className: selected.className,
    instanceId: options.identity.instanceId,
    ...(options.input === undefined ? {} : { params: options.input }),
    wrapperModule: `./${wrapper}`,
    applicationModule: `./${site.mainModule}`,
  };
  const tenantEntrypointValue = {
    js: tenantEntrySource(tenantHelper, tenantOptions),
  } satisfies WorkflowLoaderModule;
  tenantEntries.push({
    name: tenantEntrypoint,
    value: tenantEntrypointValue,
    carrier: payloadFor(encoderEncode(tenantEntrypointValue.js), tenantEntrypointValue),
  });

  const childBindingNames = [
    ...(site.vars ?? []).map((binding) => binding.name),
    ...(site.dataPlane === undefined ? [] : [DATA_SERVICE_BINDING]),
    ...(site.serviceBindings ?? []).map((binding) => binding.name),
  ];
  if (
    childBindingNames.includes(WORKFLOW_LOADER_BINDING) ||
    childBindingNames.includes(WORKFLOW_COMPANION_BINDING) ||
    childBindingNames.includes(WORKFLOW_HOST_BINDING)
  ) {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }

  const outerOptions = {
    token: channel.journalToken,
    mainModule: tenantEntrypoint,
    applicationMain: site.mainModule,
    applicationEntries,
    hostEntries: tenantEntries,
    childBindingNames,
  };
  const outerModules = new Map<string, Uint8Array>([
    [outerEntrypoint, encoder.encode(outerEntrySource(outerHelper, outerOptions))],
    [outerHelper, encoder.encode(WORKFLOW_LOADER_OUTER_SOURCE)],
  ]);
  const outerModuleMediaTypes: Record<string, WorkerdModuleMediaType> = Object.create(null);
  outerModuleMediaTypes[outerEntrypoint] = "application/javascript+module";
  outerModuleMediaTypes[outerHelper] = "application/javascript+module";
  for (const [name, carrier] of payloads) {
    outerModules.set(name, carrier.bytes);
    outerModuleMediaTypes[name] = carrier.mediaType;
  }
  const staticHostModules = new Map<string, Uint8Array>();
  if (site.dataPlane) {
    const bytes = hostModules.get(site.dataPlane.module);
    if (!(bytes instanceof Uint8Array)) throw new WorkflowRuntimeError("invalid_runtime_input");
    staticHostModules.set(site.dataPlane.module, bytes);
  }
  const staticGraph: WorkflowLoaderStaticGraph = {
    outerEntrypoint,
    outerModules,
    outerModuleMediaTypes,
    staticHostModules,
  };
  return prepareWorkflowHttpExecution({
    channel,
    signal,
    async configure(companionAddress, configureSignal) {
      configureSignal.throwIfAborted();
      const root = await mkdtemp(join(temporaryRoot, "twf-"));
      let serviceLease: WorkerdPrivateServiceLease | undefined;
      let serviceLeaseReleased = false;
      const releaseServiceLease = async (): Promise<void> => {
        if (!serviceLease || serviceLeaseReleased) return;
        await serviceLease.release();
        serviceLeaseReleased = true;
      };
      const dispose = async (): Promise<void> => {
        // Called only before a child starts or after physical reap and ingress
        // sealing. Attempt both cleanups; retained files cannot run a child.
        // A failed cleanup still rejects stop and is retried, never hidden.
        const failures: unknown[] = [];
        try {
          await rm(root, { recursive: true, force: true });
        } catch (error) {
          failures.push(error);
        }
        try {
          await releaseServiceLease();
        } catch (error) {
          failures.push(error);
        }
        if (failures.length > 0) {
          throw new AggregateError(failures, "private execution preparation cleanup failed");
        }
      };
      try {
        await chmod(root, 0o700);
        const runSocketPath = join(root, "run.sock");
        let serviceBindings:
          | readonly { readonly name: string; readonly socketPath: string }[]
          | undefined;
        let serviceGateways: readonly WorkerdExecutionServiceGateway[] | undefined;
        const selectedBindings = site.serviceBindings ?? [];
        if (selectedBindings.length > 0) {
          if (!acquireServiceBindings) {
            throw new Error("private execution service binding bridge is unavailable");
          }
          serviceLease = await acquireServiceBindings(configureSignal);
          configureSignal.throwIfAborted();
          const mapped = privateServiceMappings(root, selectedBindings, serviceLease);
          serviceBindings = mapped.bindings;
          serviceGateways = mapped.gateways;
        }
        const dataPlaneAddress = site.dataPlane ? readDataPlaneAddress?.() : undefined;
        const configPath = await writeWorkerdPrivateExecution({
          root,
          site: {
            ...site,
            hostEntrypoint: site.hostEntrypoint,
          },
          modules,
          hostModules,
          companionAddress,
          runSocketPath,
          workflowLoader: staticGraph,
          ...(serviceBindings === undefined ? {} : { serviceBindings }),
          ...(dataPlaneAddress === undefined ? {} : { dataPlaneAddress }),
        });
        configureSignal.throwIfAborted();
        return {
          configPath,
          runSocketPath,
          ...(serviceGateways === undefined ? {} : { serviceGateways }),
          dispose,
        };
      } catch (error) {
        try {
          await dispose();
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            "private execution preparation cleanup failed",
          );
        }
        throw error;
      }
    },
  });
}
