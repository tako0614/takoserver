import type { AiGateway } from "../ai-port.ts";
import { createOpenAiGateway, type OpenAiModelConfig } from "./openai.ts";

export interface CloudflareAiOptions {
  readonly accountId: string;
  readonly models: readonly OpenAiModelConfig[];
  readonly authorize: () => string | Promise<string>;
  readonly gatewayId?: string;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** Cloudflare's OpenAI-compatible inference endpoint behind the standard AI port. */
export function createCloudflareAiGateway(options: CloudflareAiOptions): AiGateway {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(options.accountId)) {
    throw new TypeError("invalid Cloudflare account id");
  }
  const gatewayId = options.gatewayId ?? "default";
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(gatewayId)) {
    throw new TypeError("invalid Cloudflare AI gateway id");
  }
  const fetchRequest = options.fetch ?? ((request: Request) => fetch(request));
  return createOpenAiGateway({
    baseUrl: `https://api.cloudflare.com/client/v4/accounts/${options.accountId}/ai/v1`,
    models: options.models,
    authorize: options.authorize,
    fetch(request) {
      const headers = new Headers(request.headers);
      headers.set("cf-aig-gateway-id", gatewayId);
      return fetchRequest(new Request(request, { headers }));
    },
  });
}
