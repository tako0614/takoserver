import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createWorkflowLoaderTenantWorker,
  type WorkflowLoaderTenantWorkerOptions,
} from "./workflow-loader-tenant-worker.ts";

/** Host-private dynamic child entry. Its run method intentionally takes no args. */
export function createWorkflowLoaderTenantBootstrap(options: WorkflowLoaderTenantWorkerOptions) {
  const runtime = createWorkflowLoaderTenantWorker(options);
  return class WorkflowTenant extends WorkerEntrypoint {
    run(): Promise<string> {
      return runtime.run(this.env as Readonly<Record<string, unknown>>);
    }
  };
}
