import { randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import type { JsonObject } from "./ports.ts";
import type { PreparedWorkerdWorkflow } from "./selfhost-workflow-execution-host.ts";
import { type HostedWorkerdRuntime, readWorkerdSelectedActiveVersion } from "./workerd-runtime.ts";
import { prepareWorkerdWorkflowExecution } from "./workerd-workflow-preparation.ts";
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
    const resolved = { ...target };
    const selected = await readWorkerdSelectedActiveVersion(options.runtimeRoot, resolved.script, {
      expectedWorkerResourceUid: resolved.workerResourceUid,
      basisPoint: (options.basisPoint ?? (() => randomInt(10_000)))(),
    });
    signal.throwIfAborted();
    if (!selected) throw new WorkflowRuntimeError("host_unavailable");
    const serviceRuntime = options.serviceRuntime;
    return prepareWorkerdWorkflowExecution({
      selection: {
        tenantId: resolved.tenantId,
        workflowResourceUid: resolved.workflowResourceUid,
        workerResourceUid: selected.workerResourceUid,
        versionId: selected.versionId,
        workerVersionUid: selected.workerVersionUid,
        className: resolved.className,
        site: selected.site,
        modules: selected.modules,
        hostModules: selected.hostModules,
      },
      identity,
      input,
      signal,
      channel,
      temporaryRoot,
      ...(options.dataPlaneAddress === undefined
        ? {}
        : { dataPlaneAddress: options.dataPlaneAddress }),
      ...(serviceRuntime === undefined
        ? {}
        : {
            acquireServiceBindings: (acquireSignal) =>
              serviceRuntime.acquirePrivateServiceBindings(
                {
                  script: resolved.script,
                  generation: selected.generation,
                  generationKey: selected.generationKey,
                  workerResourceUid: selected.workerResourceUid,
                  versionId: selected.versionId,
                  workerVersionUid: selected.workerVersionUid,
                },
                acquireSignal,
              ),
          }),
    });
  };
}
