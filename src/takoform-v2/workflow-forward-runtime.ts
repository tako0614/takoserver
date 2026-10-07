import type { JsonObject } from "../ports.ts";
import type { PreparedWorkerdWorkflow } from "../selfhost-workflow-execution-host.ts";
import { prepareWorkerdWorkflowExecution } from "../workerd-workflow-preparation.ts";
import { WorkflowRuntimeError } from "../workflow-driver.ts";
import type { WorkflowRunIdentity } from "../workflow-execution.ts";
import type { V2WorkflowNativeSelection } from "./workflow-native-selection.ts";

const unavailable = () => new WorkflowRuntimeError("host_unavailable");

/**
 * Bridge a fresh accepted v2 selection to the existing guarded native child.
 * This is a Host-only execution path, not a WorkerVersion Binding projection.
 */
export function createV2WorkflowForwardRuntime(options: {
  readonly select: (
    identity: WorkflowRunIdentity,
    signal: AbortSignal,
  ) => Promise<V2WorkflowNativeSelection>;
  readonly temporaryRoot?: string;
  readonly dataPlaneAddress?: () => string;
}) {
  if (typeof options.select !== "function")
    throw new TypeError("v2 Workflow forward runtime needs a trusted selector");
  return async (
    identity: WorkflowRunIdentity,
    input: JsonObject | undefined,
    signal: AbortSignal,
    channel: {
      readonly journalToken: string;
      readonly recordPayload: (sequence: number, payload: string) => void;
    },
  ): Promise<PreparedWorkerdWorkflow> => {
    signal.throwIfAborted();
    const selected = await options.select(identity, signal);
    signal.throwIfAborted();
    if (!(await selected.stillCurrent())) throw unavailable();
    const prepared = await prepareWorkerdWorkflowExecution({
      selection: selected.selection,
      identity,
      input,
      signal,
      channel,
      ...(options.temporaryRoot === undefined ? {} : { temporaryRoot: options.temporaryRoot }),
      ...(options.dataPlaneAddress === undefined
        ? {}
        : { dataPlaneAddress: options.dataPlaneAddress }),
      acquireServiceBindings: async (leaseSignal) => {
        leaseSignal.throwIfAborted();
        if (!(await selected.stillCurrent())) throw unavailable();
        const lease = await selected.acquirePrivateServiceBindings(leaseSignal);
        try {
          leaseSignal.throwIfAborted();
          if (!(await selected.stillCurrent())) throw unavailable();
          return lease;
        } catch (error) {
          try {
            await lease.release();
          } catch (cleanupError) {
            throw new AggregateError([error, cleanupError], "v2 Workflow lease cleanup failed");
          }
          throw error;
        }
      },
    });
    try {
      signal.throwIfAborted();
      if (!(await selected.stillCurrent())) throw unavailable();
      return prepared;
    } catch (error) {
      try {
        // No guarded child has started yet. Close the companion ingress before
        // disposing its lease/artifacts, as the preparer's stop protocol requires.
        await prepared.drainAfterStop();
        await prepared.dispose();
      } catch (cleanupError) {
        throw new AggregateError([error, cleanupError], "v2 Workflow preparation cleanup failed");
      }
      throw error;
    }
  };
}
