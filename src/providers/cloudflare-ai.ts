import type { AiGateway } from "../ai-port.ts";
import { createOpenAiGateway, type OpenAiModelConfig } from "./openai.ts";

export interface CloudflareAiOptions {
  readonly accountId: string;
  readonly models: readonly OpenAiModelConfig[];
  readonly authorize: () => string | Promise<string>;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** Cloudflare's OpenAI-compatible inference endpoint behind the standard AI port. */
export function createCloudflareAiGateway(options: CloudflareAiOptions): AiGateway {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options.accountId)) {
    throw new TypeError("invalid Cloudflare account id");
  }
  return createOpenAiGateway({
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/v1`,
    models: options.models,
    authorize: options.authorize,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
}
