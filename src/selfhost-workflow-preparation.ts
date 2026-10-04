import { randomInt } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import type { TakoformInterfaceRef } from "./interface-ref.ts";
import type { JsonObject } from "./ports.ts";
import type { PreparedWorkerdWorkflow } from "./selfhost-workflow-execution-host.ts";
import { type HostedWorkerdRuntime, readWorkerdSelectedActiveVersion } from "./workerd-runtime.ts";
import { prepareWorkerdWorkflowExecution } from "./workerd-workflow-preparation.ts";
import { WorkflowRuntimeError } from "./workflow-driver.ts";
import type { WorkflowRunIdentity } from "./workflow-execution.ts";
import { isExactWorkflowV3InterfaceRef } from "./workflow-instances.ts";

/** Trusted Resource resolution, never instance parameters or provider desired state. */
export interface SelfhostWorkflowTarget {
  readonly tenantId: string;
  readonly workflowResourceUid: string;
  readonly workerResourceUid: string;
  readonly script: string;
  readonly className: string;
  readonly runtimeClassRef?: TakoformInterfaceRef;
}

interface SelfhostWorkflowSelectedIdentity {
  readonly script: string;
  readonly generation: string;
  readonly generationKey: string;
  readonly workerResourceUid: string;
  readonly versionId: string;
  readonly workerVersionUid: string;
}

function snapshotWorkflowRef(value: unknown): TakoformInterfaceRef | undefined {
  if (value === undefined) return undefined;
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("invalid workflow runtime reference");
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("invalid workflow runtime reference");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length !== 4 ||
      keys.some(
        (key) =>
          key !== "apiVersion" && key !== "name" && key !== "version" && key !== "schemaDigest",
      )
    ) {
      throw new Error("invalid workflow runtime reference");
    }
    const captured: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") throw new Error("invalid workflow runtime reference");
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error("invalid workflow runtime reference");
      }
      captured[key] = descriptor.value;
    }
    if (!isExactWorkflowV3InterfaceRef(captured)) {
      throw new Error("invalid workflow runtime reference");
    }
    return Object.freeze(captured) as unknown as TakoformInterfaceRef;
  } catch {
    throw new WorkflowRuntimeError("invalid_runtime_input");
  }
}

function snapshotTarget(value: SelfhostWorkflowTarget): SelfhostWorkflowTarget {
  let tenantId: unknown;
  let workflowResourceUid: unknown;
  let workerResourceUid: unknown;
  let script: unknown;
  let className: unknown;
  let runtimeRefValue: unknown;
  try {
    const read = (key: keyof SelfhostWorkflowTarget): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error("invalid self-host workflow target");
      }
      return descriptor.value;
    };
    tenantId = read("tenantId");
    workflowResourceUid = read("workflowResourceUid");
    workerResourceUid = read("workerResourceUid");
    script = read("script");
    className = read("className");
    const runtimeRefDescriptor = Object.getOwnPropertyDescriptor(value, "runtimeClassRef");
    if (
      runtimeRefDescriptor !== undefined &&
      (!runtimeRefDescriptor.enumerable || !Object.hasOwn(runtimeRefDescriptor, "value"))
    ) {
      throw new Error("invalid self-host workflow target");
    }
    runtimeRefValue = runtimeRefDescriptor?.value;
  } catch {
    throw new WorkflowRuntimeError("host_unavailable");
  }
  const runtimeClassRef = snapshotWorkflowRef(runtimeRefValue);
  return Object.freeze({
    tenantId,
    workflowResourceUid,
    workerResourceUid,
    script,
    className,
    ...(runtimeClassRef === undefined ? {} : { runtimeClassRef }),
  }) as SelfhostWorkflowTarget;
}

async function raceReadOnlyWithAbort<T>(
  signal: AbortSignal,
  read: () => T | PromiseLike<T>,
): Promise<T> {
  signal.throwIfAborted();
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([
      Promise.resolve().then(() => {
        signal.throwIfAborted();
        return read();
      }),
      aborted,
    ]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

async function awaitSqlBearingCallback<T>(
  signal: AbortSignal,
  callback: () => T | PromiseLike<T>,
): Promise<T> {
  signal.throwIfAborted();
  try {
    const result = await callback();
    signal.throwIfAborted();
    return result;
  } catch (error) {
    if (signal.aborted) signal.throwIfAborted();
    throw error;
  }
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
  /** Revalidate private Resource relations against this exact active selection. */
  readonly verifySelected?: (
    identity: WorkflowRunIdentity,
    target: SelfhostWorkflowTarget,
    selectedIdentity: SelfhostWorkflowSelectedIdentity,
    signal: AbortSignal,
  ) => Promise<void>;
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
    // This resolver may join shared SQL state. Keep its promise attached until
    // it settles so stop cannot close that connection while a query is active.
    const target = await awaitSqlBearingCallback(signal, () =>
      options.resolveTarget(identity, signal),
    );
    signal.throwIfAborted();
    const resolved = target === null ? null : snapshotTarget(target);
    if (
      !resolved ||
      resolved.tenantId !== identity.scope.tenantId ||
      resolved.workflowResourceUid !== identity.scope.workflowResourceUid ||
      typeof resolved.className !== "string" ||
      resolved.className.length === 0 ||
      resolved.className.includes("\u0000")
    ) {
      throw new WorkflowRuntimeError("host_unavailable");
    }
    const runtimeClassRef = resolved.runtimeClassRef;
    if (runtimeClassRef !== undefined && !options.verifySelected) {
      throw new WorkflowRuntimeError("invalid_runtime_input");
    }
    const selected = await raceReadOnlyWithAbort(signal, () =>
      readWorkerdSelectedActiveVersion(options.runtimeRoot, resolved.script, {
        expectedWorkerResourceUid: resolved.workerResourceUid,
        basisPoint: (options.basisPoint ?? (() => randomInt(10_000)))(),
      }),
    );
    signal.throwIfAborted();
    if (!selected) throw new WorkflowRuntimeError("host_unavailable");
    const selectedIdentity = Object.freeze({
      script: resolved.script,
      generation: selected.generation,
      generationKey: selected.generationKey,
      workerResourceUid: selected.workerResourceUid,
      versionId: selected.versionId,
      workerVersionUid: selected.workerVersionUid,
    });
    if (options.verifySelected) {
      await awaitSqlBearingCallback(signal, () =>
        options.verifySelected?.(identity, resolved, selectedIdentity, signal),
      );
    }
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
        ...(runtimeClassRef === undefined ? {} : { runtimeClassRef }),
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
