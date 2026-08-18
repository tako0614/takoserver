import { type AiGateway, AiGatewayError } from "../ai-port.ts";
import { isJsonObject, type JsonObject } from "../json.ts";
import type { OpenAiModelConfig } from "./openai.ts";

const UPSTREAM_REFERENCE = /^@cf\/[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$/u;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const MAX_RESPONSE_CHARACTERS = 64 * 1024;

export interface CloudflareWorkersAiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: {
      readonly gateway?: {
        readonly id: string;
        readonly eventId?: string;
        readonly metadata?: Readonly<Record<string, string>>;
      };
    },
  ): Promise<unknown>;
}

export interface CloudflareWorkersAiOptions {
  readonly binding: CloudflareWorkersAiBinding;
  readonly models: readonly OpenAiModelConfig[];
  readonly gatewayId?: string;
  readonly clock?: () => Date;
}

/**
 * Runs the ordinary OpenAI-compatible Takoserver API on a native Workers AI
 * binding. The binding supplies Cloudflare authority; no REST API credential
 * enters the Worker or the customer-facing request path.
 */
export function createCloudflareWorkersAiGateway(options: CloudflareWorkersAiOptions): AiGateway {
  const gatewayId = options.gatewayId ?? "default";
  if (!GATEWAY_ID.test(gatewayId)) throw new TypeError("invalid Cloudflare AI gateway id");

  const configured = new Map<string, OpenAiModelConfig>();
  for (const model of options.models) {
    if (!UPSTREAM_REFERENCE.test(model.upstreamId) || configured.has(model.id)) {
      throw new TypeError("invalid Workers AI model mapping");
    }
    configured.set(model.id, structuredClone(model));
  }
  const clock = options.clock ?? (() => new Date());

  return {
    models: [...configured.values()].map(({ upstreamId: _upstreamId, ...model }) => model),
    async chat(request, context) {
      const publicModel = typeof request.model === "string" ? request.model : "";
      const model = configured.get(publicModel);
      if (!model) throw new AiGatewayError("invalid_response");
      const { model: _model, ...input } = request;

      let output: unknown;
      try {
        output = await options.binding.run(
          model.upstreamId,
          { ...input, stream: false },
          {
            gateway: {
              id: gatewayId,
              eventId: context.requestId,
              metadata: { takoserver_request_id: context.requestId },
            },
          },
        );
      } catch {
        throw new AiGatewayError("unavailable");
      }

      const completion = nativeCompletion(output);
      if (!completion) throw new AiGatewayError("invalid_response");
      return {
        id: `chatcmpl-${context.requestId}`,
        object: "chat.completion",
        created: Math.floor(clock().getTime() / 1_000),
        model: publicModel,
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: completion.response },
            finish_reason: "stop",
          },
        ],
        usage: completion.usage,
      } satisfies JsonObject;
    },
  };
}

function nativeCompletion(value: unknown): {
  readonly response: string;
  readonly usage: {
    readonly prompt_tokens: number;
    readonly completion_tokens: number;
    readonly total_tokens: number;
  };
} | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.response !== "string" || value.response.length > MAX_RESPONSE_CHARACTERS) {
    return null;
  }
  if (!isJsonObject(value.usage)) return null;
  const prompt = value.usage.prompt_tokens;
  const completion = value.usage.completion_tokens;
  const total = value.usage.total_tokens;
  if (
    !nonNegativeInteger(prompt) ||
    !nonNegativeInteger(completion) ||
    !nonNegativeInteger(total) ||
    total !== prompt + completion
  ) {
    return null;
  }
  return {
    response: value.response,
    usage: { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total },
  };
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
