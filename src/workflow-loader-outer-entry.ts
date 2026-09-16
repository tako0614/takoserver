import { WorkerEntrypoint } from "cloudflare:workers";
import {
  createWorkflowLoaderOuterWorker,
  type WorkflowLoaderOuterContext,
  type WorkflowLoaderOuterWorkerOptions,
} from "./workflow-loader-outer-worker.ts";

/**
 * Host-private static entry used by the deterministic outer bundle. The
 * generated per-execution module supplies the selected graph as inert data;
 * this entry exposes only HTTP fetch and the one WorkflowHost RPC method.
 */
export function createWorkflowLoaderOuterBootstrap(options: WorkflowLoaderOuterWorkerOptions) {
  const runtime = createWorkflowLoaderOuterWorker(options);
  class WorkflowHost extends WorkerEntrypoint {
    exchange(payload: string): Promise<string> {
      return runtime.exchange(payload);
    }
  }
  return {
    default: {
      fetch(
        request: Request,
        env: Readonly<Record<string, unknown>>,
        ctx: WorkflowLoaderOuterContext,
      ): Promise<Response> {
        return runtime.fetch(request, env, ctx);
      },
    },
    WorkflowHost,
  };
}
