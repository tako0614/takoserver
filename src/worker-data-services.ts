import type { AiGateway } from "./ai-port.ts";
import {
  type CloudflareWorkersAiBinding,
  createCloudflareWorkersAiGateway,
} from "./providers/cloudflare-workers-ai.ts";
import { parseOpenAiModelConfig } from "./providers/openai.ts";

export interface WorkerDataServiceEnv {
  readonly AI?: CloudflareWorkersAiBinding;
  readonly TAKOSERVER_AI_MODELS?: string;
}

export interface WorkerDataServices {
  readonly ai?: AiGateway;
}

/**
 * Optional standard data planes for the hosted Takoserver installation.
 *
 * Model mappings, prices, account identity, and credentials are realized
 * deployment configuration. The product owns only the ports and adapters.
 */
export function createWorkerDataServices(env: WorkerDataServiceEnv): WorkerDataServices {
  const aiConfigured = env.TAKOSERVER_AI_MODELS !== undefined;
  if (!aiConfigured) return {};

  const ai = aiConfigured
    ? (() => {
        if (!env.AI) throw new TypeError("AI binding is not configured");
        return createCloudflareWorkersAiGateway({
          binding: env.AI,
          models: parseOpenAiModelConfig(env.TAKOSERVER_AI_MODELS as string),
        });
      })()
    : undefined;

  return { ...(ai ? { ai } : {}) };
}
