import { type AiGateway, AiGatewayError } from "../ai-port.ts";
import { isJsonObject, type JsonObject } from "../json.ts";
import type { OpenAiModelConfig } from "./openai.ts";

const UPSTREAM_REFERENCE = /^@cf\/[A-Za-z0-9][A-Za-z0-9._/-]{0,250}$/u;
const GATEWAY_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const TOOL_CALL_ID = /^[\x21-\x7e]{1,256}$/u;
const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/u;
const MAX_RESPONSE_CHARACTERS = 64 * 1024;
const MAX_TOOL_CALLS = 16;
const MAX_TOOL_ARGUMENT_CHARACTERS = 256 * 1024;

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

      const modern = nativeChatCompletion(output);
      if (modern) {
        return {
          id: `chatcmpl-${context.requestId}`,
          object: "chat.completion",
          created: Math.floor(clock().getTime() / 1_000),
          model: publicModel,
          choices: modern.choices,
          usage: modern.usage,
        } satisfies JsonObject;
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

function nativeChatCompletion(value: unknown): {
  readonly choices: readonly JsonObject[];
  readonly usage: NativeUsage;
} | null {
  if (!isJsonObject(value) || value.object !== "chat.completion") return null;
  if (!Array.isArray(value.choices) || value.choices.length < 1 || value.choices.length > 16) {
    return null;
  }
  const usage = nativeUsage(value.usage);
  if (!usage) return null;

  const choices: JsonObject[] = [];
  for (let index = 0; index < value.choices.length; index += 1) {
    const candidate = value.choices[index];
    if (!isJsonObject(candidate) || !isJsonObject(candidate.message)) return null;
    const message = candidate.message;
    if (message.role !== "assistant") return null;
    if (
      message.content !== null &&
      (typeof message.content !== "string" || message.content.length > MAX_RESPONSE_CHARACTERS)
    ) {
      return null;
    }
    const toolCalls = nativeToolCalls(message.tool_calls);
    if (toolCalls === null) return null;
    if (message.content === null && toolCalls.length === 0) return null;
    const expectedFinish = toolCalls.length > 0 ? "tool_calls" : candidate.finish_reason;
    if (
      candidate.finish_reason !== expectedFinish ||
      !(
        candidate.finish_reason === "stop" ||
        candidate.finish_reason === "length" ||
        candidate.finish_reason === "tool_calls"
      )
    ) {
      return null;
    }
    choices.push({
      index,
      message: {
        role: "assistant",
        content: message.content,
        ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
      },
      finish_reason: candidate.finish_reason,
    });
  }
  return { choices, usage };
}

function nativeToolCalls(value: unknown): JsonObject[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_TOOL_CALLS) return null;
  const calls: JsonObject[] = [];
  for (const candidate of value) {
    if (
      !isJsonObject(candidate) ||
      candidate.type !== "function" ||
      typeof candidate.id !== "string" ||
      !TOOL_CALL_ID.test(candidate.id) ||
      !isJsonObject(candidate.function) ||
      typeof candidate.function.name !== "string" ||
      !TOOL_NAME.test(candidate.function.name) ||
      typeof candidate.function.arguments !== "string" ||
      candidate.function.arguments.length > MAX_TOOL_ARGUMENT_CHARACTERS
    ) {
      return null;
    }
    let argumentsValue: unknown;
    try {
      argumentsValue = JSON.parse(candidate.function.arguments);
    } catch {
      return null;
    }
    if (!isJsonObject(argumentsValue)) return null;
    calls.push({
      id: candidate.id,
      type: "function",
      function: {
        name: candidate.function.name,
        arguments: candidate.function.arguments,
      },
    });
  }
  return calls;
}

type NativeUsage = {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
};

function nativeUsage(value: unknown): NativeUsage | null {
  if (!isJsonObject(value)) return null;
  const prompt = value.prompt_tokens;
  const completion = value.completion_tokens;
  const total = value.total_tokens;
  if (
    !nonNegativeInteger(prompt) ||
    !nonNegativeInteger(completion) ||
    !nonNegativeInteger(total) ||
    total !== prompt + completion
  ) {
    return null;
  }
  return { prompt_tokens: prompt, completion_tokens: completion, total_tokens: total };
}

function nativeCompletion(value: unknown): {
  readonly response: string;
  readonly usage: NativeUsage;
} | null {
  if (!isJsonObject(value)) return null;
  if (typeof value.response !== "string" || value.response.length > MAX_RESPONSE_CHARACTERS) {
    return null;
  }
  const usage = nativeUsage(value.usage);
  return usage ? { response: value.response, usage } : null;
}

function nonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
