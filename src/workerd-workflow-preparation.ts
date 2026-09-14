import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { WORKFLOW_HTTP_BOOTSTRAP_SOURCE } from "./generated/workflow-http-bootstrap.ts";
import type { JsonObject } from "./ports.ts";
import type { PreparedWorkerdWorkflow } from "./selfhost-workflow-execution-host.ts";
import { prepareWorkflowHttpExecution } from "./selfhost-workflow-http-transport.ts";
import type { WorkerdExecutionServiceGateway } from "./workerd-execution-guard.ts";
import {
  type WorkerdPrivateServiceLease,
  type WorkerdSite,
  writeWorkerdPrivateExecution,
} from "./workerd-runtime.ts";
import { WorkflowRuntimeError } from "./workflow-driver.ts";
import type { WorkflowRunIdentity } from "./workflow-execution.ts";

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
  const occupied = new Set([...hostModules.keys(), site.mainModule]);
  function allocate(stem: string): string {
    let name = `${stem}.js`;
    for (let suffix = 1; occupied.has(name); suffix += 1) name = `${stem}-${suffix}.js`;
    occupied.add(name);
    return name;
  }
  const entrypoint = allocate("__workflow_entry");
  const helper = allocate("__workflow_bootstrap");
  const literal = JSON.stringify({
    token: channel.journalToken,
    className: selected.className,
    instanceId: options.identity.instanceId,
    ...(options.input === undefined ? {} : { params: options.input }),
    wrapperModule: `./${wrapper}`,
    applicationModule: `./${site.mainModule}`,
  });
  const encoder = new TextEncoder();
  hostModules.set(
    entrypoint,
    encoder.encode(
      `import { createWorkflowHttpBootstrap } from ${JSON.stringify(`./${helper}`)};\nexport default createWorkflowHttpBootstrap(JSON.parse(${JSON.stringify(literal)}));\n`,
    ),
  );
  hostModules.set(helper, encoder.encode(WORKFLOW_HTTP_BOOTSTRAP_SOURCE));
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
            hostEntrypoint: entrypoint,
            hostModules: [...hostModules.keys()].filter(
              (name) => name !== entrypoint && name !== site.dataPlane?.module,
            ),
          },
          modules,
          hostModules,
          companionAddress,
          runSocketPath,
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
