import {
  createWorkflowLoaderTenantWorker,
  type WorkflowLoaderTenantWorkerOptions,
} from "./workflow-loader-tenant-worker.ts";

/** Host-private functional RPC entry; its environment is injected by workerd. */
export function createWorkflowLoaderTenantBootstrap(options: WorkflowLoaderTenantWorkerOptions) {
  const runtime = createWorkflowLoaderTenantWorker(options);
  return {
    run(_request: null, env: Readonly<Record<string, unknown>>): Promise<string> {
      return runtime.run(env);
    },
  };
}
