/** Trusted Bun/Linux workerd composition; not a Cloudflare Worker import. */
import { createWorkerdWorkflowExecutionHost as createInternalHost } from "./selfhost-workflow-execution-host.ts";

export type { PreparedWorkerdWorkflow } from "./selfhost-workflow-execution-host.ts";
export type {
  WorkerdPrivateServiceLease,
  WorkerdSite,
} from "./workerd-runtime.ts";
export {
  compileWorkerdVersionGraph,
  type WorkerdVersionGraph,
  type WorkerdVersionGraphInput,
} from "./workerd-version-graph.ts";
export {
  prepareWorkerdWorkflowExecution,
  type WorkerdWorkflowPreparationOptions,
  type WorkerdWorkflowSelection,
} from "./workerd-workflow-preparation.ts";

export type WorkerdWorkflowExecutionHostOptions = Omit<
  Parameters<typeof createInternalHost>[0],
  "spawnGuard"
>;

/**
 * Production composition always spawns the retained guard executable. Rebuild
 * the accepted options so even a JavaScript caller cannot inject the internal
 * fake-guard seam through this package entrypoint.
 */
export function createWorkerdWorkflowExecutionHost(
  options: WorkerdWorkflowExecutionHostOptions,
): ReturnType<typeof createInternalHost> {
  return createInternalHost({
    guardBinary: options.guardBinary,
    workerdBinary: options.workerdBinary,
    maximumRegistrations: options.maximumRegistrations,
    prepare: options.prepare,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
  });
}
