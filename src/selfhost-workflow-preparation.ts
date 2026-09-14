import { randomInt } from "node:crypto";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { WORKFLOW_HTTP_BOOTSTRAP_SOURCE } from "./generated/workflow-http-bootstrap.ts";
import type { JsonObject } from "./ports.ts";
import type { PreparedWorkerdWorkflow } from "./selfhost-workflow-execution-host.ts";
import { prepareWorkflowHttpExecution } from "./selfhost-workflow-http-transport.ts";
import type { WorkerdExecutionServiceGateway } from "./workerd-execution-guard.ts";
import {
  type HostedWorkerdRuntime,
  readWorkerdSelectedActiveVersion,
  type WorkerdSite,
  writeWorkerdPrivateExecution,
} from "./workerd-runtime.ts";
import { WorkflowRuntimeError } from "./workflow-driver.ts";
import type { WorkflowRunIdentity } from "./workflow-execution.ts";

/** Trusted Resource resolution, never instance parameters or provider desired state. */
export interface SelfhostWorkflowTarget {
  readonly tenantId: string;
  readonly workflowResourceUid: string;
  readonly workerResourceUid: string;
  readonly script: string;
  readonly className: string;
}

type PrivateServiceRuntime = Pick<HostedWorkerdRuntime, "acquirePrivateServiceBindings">;
type PrivateServiceLease = Awaited<
  ReturnType<PrivateServiceRuntime["acquirePrivateServiceBindings"]>
>;

function privateServiceMappings(
  root: string,
  bindings: NonNullable<WorkerdSite["serviceBindings"]>,
  lease: PrivateServiceLease,
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
 * Dormant concrete loader. No serving entry wires this factory. Its caller must
 * resolve the exact accepted Workflow Resource/worker relation, immutable class
 * name, and active self-host realization in the same tenant at preparation time.
 * This port is not permission to admit the unpublished forward Form candidate.
 * Every wake resolves again, then selects one committed active Worker Version.
 */
export function createSelfhostWorkflowPreparation(options: {
  readonly runtimeRoot: string;
  readonly temporaryRoot?: string;
  /** Host-owned private service socket authority; never a provider/public port. */
  readonly serviceRuntime?: PrivateServiceRuntime;
  /** Read-only resolver; honor cancellation and never allocate runtime artifacts. */
  readonly resolveTarget: (
    identity: WorkflowRunIdentity,
    signal: AbortSignal,
  ) => Promise<SelfhostWorkflowTarget | null>;
  readonly dataPlaneAddress?: () => string;
  readonly basisPoint?: () => number;
}): (
  identity: WorkflowRunIdentity,
  input: JsonObject | undefined,
  signal: AbortSignal,
  channel: {
    readonly journalToken: string;
    readonly recordPayload: (sequence: number, payload: string) => void;
  },
) => Promise<PreparedWorkerdWorkflow> {
  const temporaryRoot = options.temporaryRoot ?? tmpdir();
  if (!isAbsolute(options.runtimeRoot) || !isAbsolute(temporaryRoot)) {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }
  return async (identity, input, signal, channel) => {
    signal.throwIfAborted();
    // Target lookup has no artifacts to drain. A stalled read must not keep a
    // physically stopped registration's preparation latch open indefinitely.
    let onAbort!: () => void;
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason);
      signal.addEventListener("abort", onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    let target: SelfhostWorkflowTarget | null;
    try {
      target = await Promise.race([
        Promise.resolve().then(() => {
          signal.throwIfAborted();
          return options.resolveTarget(identity, signal);
        }),
        aborted,
      ]);
      // Promise.race retains rejection handlers on a late resolver result.
      // Only this continuation can progress to filesystem selection.
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
    signal.throwIfAborted();
    if (
      !target ||
      target.tenantId !== identity.scope.tenantId ||
      target.workflowResourceUid !== identity.scope.workflowResourceUid ||
      typeof target.className !== "string" ||
      target.className.length === 0 ||
      target.className.includes("\u0000")
    ) {
      throw new WorkflowRuntimeError("host_unavailable");
    }
    const selected = await readWorkerdSelectedActiveVersion(options.runtimeRoot, target.script, {
      expectedWorkerResourceUid: target.workerResourceUid,
      basisPoint: (options.basisPoint ?? (() => randomInt(10_000)))(),
    });
    signal.throwIfAborted();
    if (!selected) throw new WorkflowRuntimeError("host_unavailable");
    const wrapper = selected.site.hostEntrypoint;
    if (!wrapper || wrapper === selected.site.mainModule) {
      // The pinned module resolver bridges applicationMain before Host lookup.
      // The configured startup entry is the sole exception. Never import the
      // application under the mistaken assumption it is an env projector.
      throw new Error("selected Version has no importable private env projector");
    }
    const occupied = new Set([...selected.hostModules.keys(), selected.site.mainModule]);
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
      className: target.className,
      instanceId: identity.instanceId,
      ...(input === undefined ? {} : { params: input }),
      wrapperModule: `./${wrapper}`,
      applicationModule: `./${selected.site.mainModule}`,
    });
    const hostModules = new Map(selected.hostModules);
    const encoder = new TextEncoder();
    hostModules.set(
      entrypoint,
      encoder.encode(
        `import { createWorkflowHttpBootstrap } from ${JSON.stringify(`./${helper}`)};\nexport default createWorkflowHttpBootstrap(JSON.parse(${JSON.stringify(literal)}));\n`,
      ),
    );
    hostModules.set(helper, encoder.encode(WORKFLOW_HTTP_BOOTSTRAP_SOURCE));
    // The transport starts its own listening companion before configuration.
    // No native child exists yet, so any partial preparation can be removed.
    return prepareWorkflowHttpExecution({
      channel,
      signal,
      async configure(companionAddress, configureSignal) {
        configureSignal.throwIfAborted();
        const root = await mkdtemp(join(temporaryRoot, "twf-"));
        let serviceLease: PrivateServiceLease | undefined;
        let serviceLeaseReleased = false;
        const releaseServiceLease = async (): Promise<void> => {
          if (!serviceLease || serviceLeaseReleased) return;
          await serviceLease.release();
          serviceLeaseReleased = true;
        };
        try {
          await chmod(root, 0o700);
          const runSocketPath = join(root, "run.sock");
          let serviceBindings:
            | readonly { readonly name: string; readonly socketPath: string }[]
            | undefined;
          let serviceGateways: readonly WorkerdExecutionServiceGateway[] | undefined;
          const selectedBindings = selected.site.serviceBindings ?? [];
          if (selectedBindings.length > 0) {
            if (!options.serviceRuntime) {
              throw new Error("private execution service binding bridge is unavailable");
            }
            serviceLease = await options.serviceRuntime.acquirePrivateServiceBindings({
              script: target.script,
              generation: selected.generation,
              generationKey: selected.generationKey,
              workerResourceUid: selected.workerResourceUid,
              versionId: selected.versionId,
              workerVersionUid: selected.workerVersionUid,
            });
            configureSignal.throwIfAborted();
            const mapped = privateServiceMappings(root, selectedBindings, serviceLease);
            serviceBindings = mapped.bindings;
            serviceGateways = mapped.gateways;
          }
          const dataPlaneAddress = selected.site.dataPlane
            ? options.dataPlaneAddress?.()
            : undefined;
          const configPath = await writeWorkerdPrivateExecution({
            root,
            site: {
              ...selected.site,
              hostEntrypoint: entrypoint,
              hostModules: [...hostModules.keys()].filter(
                (name) => name !== entrypoint && name !== selected.site.dataPlane?.module,
              ),
            },
            modules: selected.modules,
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
            async dispose() {
              await rm(root, { recursive: true, force: true });
              await releaseServiceLease();
            },
          };
        } catch (error) {
          let cleanupError: unknown;
          try {
            await rm(root, { recursive: true, force: true });
          } catch (failure) {
            cleanupError = failure;
          }
          let releaseError: unknown;
          try {
            // Configuration failed before a child could start, so the lease
            // may be released even when artifact removal itself needs retry.
            await releaseServiceLease();
          } catch (failure) {
            releaseError = failure;
          }
          if (cleanupError !== undefined || releaseError !== undefined) {
            throw new AggregateError(
              [error, cleanupError, releaseError].filter((value) => value !== undefined),
              "private execution preparation cleanup failed",
            );
          }
          throw error;
        }
      },
    });
  };
}
