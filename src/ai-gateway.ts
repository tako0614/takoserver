import type { RuntimeGrantVerifier } from "./runtime-grants.ts";
import { executionIntentDigest } from "./runtime-grants.ts";

export type AiGatewayOperation = "models.list" | "chat.completions";

export type AiChatRole = "system" | "user" | "assistant" | "tool";

export interface AiChatMessage {
  readonly role: AiChatRole;
  readonly content: unknown;
  readonly [key: string]: unknown;
}

export interface AiChatCompletionRequest {
  readonly model: string;
  readonly messages: readonly AiChatMessage[];
  readonly max_tokens?: number;
  readonly max_completion_tokens?: number;
  readonly temperature?: number;
  readonly stream?: boolean;
  readonly [key: string]: unknown;
}

export interface AiModel {
  readonly id: string;
  readonly object: "model";
  readonly created?: number;
  readonly owned_by?: string;
}

export interface AiUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly total_tokens: number;
}

export interface AiChatChoice {
  readonly index: number;
  readonly message: {
    readonly role: string;
    readonly content?: unknown;
    readonly [key: string]: unknown;
  };
  readonly finish_reason?: string | null;
  readonly [key: string]: unknown;
}

export interface AiChatCompletionResponse {
  readonly id: string;
  readonly object: "chat.completion";
  readonly created: number;
  readonly model: string;
  readonly choices: readonly AiChatChoice[];
  readonly usage: AiUsage;
  readonly [key: string]: unknown;
}

export interface AiGatewayUpstreamAdapter {
  /** Optional because model discovery is controlled by the Takoserver allowlist. */
  readonly listModels?: () => Promise<readonly AiModel[]>;
  /** The provider-facing call. Provider credentials never enter this module. */
  readonly chatCompletions?: (
    request: AiChatCompletionRequest,
  ) => Promise<AiChatCompletionResponse>;
}

export interface AiGatewayBaseCommand {
  readonly grantToken: string;
  readonly tenantRef: string;
  readonly resourceRef: string;
  /** Optional explicit intent for callers that persist a signed request plan. */
  readonly intent?: unknown;
}

export type AiGatewayCommand =
  | (AiGatewayBaseCommand & { readonly kind: "models.list" })
  | (AiGatewayBaseCommand & {
      readonly kind: "chat.completions";
      readonly request: AiChatCompletionRequest;
    });

export type AiGatewayResult =
  | {
      readonly kind: "models.list";
      readonly response: {
        readonly object: "list";
        readonly data: readonly AiModel[];
      };
    }
  | {
      readonly kind: "chat.completions";
      readonly response: AiChatCompletionResponse;
      readonly usageReceipt: AiUsageReceipt;
    };

export interface AiUsageReceipt {
  readonly kind: "ai.usage";
  readonly tenantRef: string;
  readonly resourceRef: string;
  readonly model: string;
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly totalTokens: number;
}

export interface AiGatewayModule {
  execute(command: AiGatewayCommand): Promise<AiGatewayResult>;
}

export type AiGatewayErrorCode =
  | "invalid_request"
  | "model_not_allowed"
  | "request_too_large"
  | "output_too_large"
  | "upstream_unavailable"
  | "invalid_response";

export class AiGatewayError extends Error {
  constructor(
    readonly code: AiGatewayErrorCode,
    readonly status: number = statusFor(code),
  ) {
    super(code);
    this.name = "AiGatewayError";
  }
}

export interface CreateAiGatewayModuleOptions {
  readonly verifier: RuntimeGrantVerifier;
  readonly upstream: AiGatewayUpstreamAdapter;
  readonly modelAllowlist: readonly string[];
  readonly maxRequestBytes?: number;
  readonly maxResponseBytes?: number;
  readonly maxMessages?: number;
  readonly maxMessageContentBytes?: number;
  readonly maxOutputTokens?: number;
  readonly maxChoices?: number;
}

export interface AiGatewayIntentInput {
  readonly operation: AiGatewayOperation;
  readonly tenantRef: string;
  readonly resourceRef: string;
  readonly request?: AiChatCompletionRequest;
}

export function aiGatewayIntent(input: AiGatewayIntentInput): Record<string, unknown> {
  const operation = operationValue(input.operation);
  const tenantRef = reference(input.tenantRef);
  const resourceRef = reference(input.resourceRef);
  const intent: Record<string, unknown> = { operation, tenantRef, resourceRef };
  if (input.request !== undefined) intent.request = input.request;
  return intent;
}

export function createAiGatewayModule(options: CreateAiGatewayModuleOptions): AiGatewayModule {
  if (!options.verifier || typeof options.verifier.verifyAndConsume !== "function") {
    throw new TypeError("runtime grant verifier is required");
  }
  if (!options.upstream) throw new TypeError("AI upstream adapter is required");
  if (typeof options.upstream.chatCompletions !== "function") {
    throw new TypeError("AI chat upstream adapter is required");
  }
  const chatCompletions = options.upstream.chatCompletions;
  const limits = gatewayLimits(options);
  const models = exactModels(options.modelAllowlist);

  return {
    async execute(command): Promise<AiGatewayResult> {
      const tenantRef = reference(command.tenantRef);
      const resourceRef = reference(command.resourceRef);
      const grantToken = nonEmpty(command.grantToken, 16_384);
      if (command.kind === "models.list") {
        const intent = aiGatewayIntent({ operation: "models.list", tenantRef, resourceRef });
        assertExplicitIntent(command.intent, intent);
        verifyIntentSize(intent, limits.maxRequestBytes);
        await options.verifier.verifyAndConsume(grantToken, {
          operation: "ai.invoke",
          tenantRef,
          intentDigest: await executionIntentDigest(intent),
        });
        return {
          kind: "models.list",
          response: { object: "list", data: models },
        };
      }

      if (command.kind !== "chat.completions") throw new AiGatewayError("invalid_request");
      const request = normalizeRequest(command.request, models, limits);
      const intent = aiGatewayIntent({
        operation: "chat.completions",
        tenantRef,
        resourceRef,
        request,
      });
      assertExplicitIntent(command.intent, intent);
      verifyIntentSize(intent, limits.maxRequestBytes);
      await options.verifier.verifyAndConsume(grantToken, {
        operation: "ai.invoke",
        tenantRef,
        intentDigest: await executionIntentDigest(intent),
      });

      let upstreamResponse: AiChatCompletionResponse;
      try {
        upstreamResponse = await chatCompletions(request);
      } catch {
        throw new AiGatewayError("upstream_unavailable");
      }
      const response = normalizeResponse(upstreamResponse, request.model, limits);
      const usageReceipt: AiUsageReceipt = {
        kind: "ai.usage",
        tenantRef,
        resourceRef,
        model: request.model,
        promptTokens: response.usage.prompt_tokens,
        completionTokens: response.usage.completion_tokens,
        totalTokens: response.usage.total_tokens,
      };
      return { kind: "chat.completions", response, usageReceipt };
    },
  };
}

interface GatewayLimits {
  readonly maxRequestBytes: number;
  readonly maxResponseBytes: number;
  readonly maxMessages: number;
  readonly maxMessageContentBytes: number;
  readonly maxOutputTokens: number;
  readonly maxChoices: number;
}

function gatewayLimits(options: CreateAiGatewayModuleOptions): GatewayLimits {
  return {
    maxRequestBytes: positiveLimit(options.maxRequestBytes ?? 128 * 1024),
    maxResponseBytes: positiveLimit(options.maxResponseBytes ?? 512 * 1024),
    maxMessages: positiveLimit(options.maxMessages ?? 128),
    maxMessageContentBytes: positiveLimit(options.maxMessageContentBytes ?? 64 * 1024),
    maxOutputTokens: positiveLimit(options.maxOutputTokens ?? 16_384),
    maxChoices: positiveLimit(options.maxChoices ?? 16),
  };
}

function exactModels(ids: readonly string[]): readonly AiModel[] {
  if (!Array.isArray(ids) || ids.length === 0 || ids.length > 128) {
    throw new TypeError("an exact AI model allowlist is required");
  }
  const seen = new Set<string>();
  return ids.map((id) => {
    if (
      typeof id !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/u.test(id) ||
      seen.has(id)
    ) {
      throw new TypeError("AI model allowlist contains an invalid or duplicate model");
    }
    seen.add(id);
    return Object.freeze({ id, object: "model" as const });
  });
}

function normalizeRequest(
  value: AiChatCompletionRequest,
  models: readonly AiModel[],
  limits: GatewayLimits,
): AiChatCompletionRequest {
  if (!isRecord(value)) throw new AiGatewayError("invalid_request");
  const model = value.model;
  if (typeof model !== "string") throw new AiGatewayError("invalid_request");
  if (!models.some((candidate) => candidate.id === model)) {
    throw new AiGatewayError("model_not_allowed");
  }
  if (
    !Array.isArray(value.messages) ||
    value.messages.length === 0 ||
    value.messages.length > limits.maxMessages
  ) {
    throw new AiGatewayError("request_too_large");
  }
  for (const message of value.messages) validateMessage(message, limits.maxMessageContentBytes);
  const maxTokens = value.max_completion_tokens ?? value.max_tokens;
  if (
    maxTokens !== undefined &&
    (!safeNumber(maxTokens) || maxTokens < 1 || maxTokens > limits.maxOutputTokens)
  ) {
    throw new AiGatewayError("request_too_large");
  }
  if (
    value.temperature !== undefined &&
    (!finiteNumber(value.temperature) || value.temperature < 0 || value.temperature > 2)
  ) {
    throw new AiGatewayError("invalid_request");
  }
  const encoded = boundedJson(value, limits.maxRequestBytes, "request_too_large");
  return encoded as AiChatCompletionRequest;
}

function validateMessage(value: unknown, maxContentBytes: number): void {
  if (
    !isRecord(value) ||
    (value.role !== "system" &&
      value.role !== "user" &&
      value.role !== "assistant" &&
      value.role !== "tool")
  ) {
    throw new AiGatewayError("invalid_request");
  }
  if (typeof value.content === "string") {
    if (byteLength(value.content) > maxContentBytes) throw new AiGatewayError("request_too_large");
    return;
  }
  if (!Array.isArray(value.content)) throw new AiGatewayError("invalid_request");
  for (const part of value.content) {
    if (!isRecord(part) || typeof part.type !== "string")
      throw new AiGatewayError("invalid_request");
    const text = part.text;
    if (text !== undefined && (typeof text !== "string" || byteLength(text) > maxContentBytes)) {
      throw new AiGatewayError("request_too_large");
    }
  }
}

function normalizeResponse(
  value: AiChatCompletionResponse,
  model: string,
  limits: GatewayLimits,
): AiChatCompletionResponse {
  if (!isRecord(value)) throw new AiGatewayError("invalid_response");
  const encoded = boundedJson(value, limits.maxResponseBytes, "output_too_large");
  if (
    typeof encoded.id !== "string" ||
    encoded.object !== "chat.completion" ||
    !safeNumber(encoded.created) ||
    encoded.model !== model ||
    !Array.isArray(encoded.choices) ||
    encoded.choices.length > limits.maxChoices ||
    !isRecord(encoded.usage)
  ) {
    throw new AiGatewayError("invalid_response");
  }
  const usage = encoded.usage;
  if (
    !safeNonNegative(usage.prompt_tokens) ||
    !safeNonNegative(usage.completion_tokens) ||
    !safeNonNegative(usage.total_tokens) ||
    usage.total_tokens < usage.prompt_tokens + usage.completion_tokens
  ) {
    throw new AiGatewayError("invalid_response");
  }
  const choices = encoded.choices.map((choice) => {
    const index = isRecord(choice) ? choice.index : undefined;
    if (
      !isRecord(choice) ||
      !safeNumber(index) ||
      index < 0 ||
      !isRecord(choice.message) ||
      typeof choice.message.role !== "string"
    ) {
      throw new AiGatewayError("invalid_response");
    }
    return choice;
  });
  return {
    id: encoded.id,
    object: "chat.completion",
    created: encoded.created,
    model,
    choices: choices as unknown as readonly AiChatChoice[],
    usage: {
      prompt_tokens: usage.prompt_tokens,
      completion_tokens: usage.completion_tokens,
      total_tokens: usage.total_tokens,
    },
  };
}

function assertExplicitIntent(value: unknown, expected: Record<string, unknown>): void {
  if (value === undefined) return;
  if (!isRecord(value) || canonicalJson(value) !== canonicalJson(expected)) {
    throw new AiGatewayError("invalid_request");
  }
}

function verifyIntentSize(intent: Record<string, unknown>, maxBytes: number): void {
  if (byteLength(canonicalJson(intent)) > maxBytes) throw new AiGatewayError("request_too_large");
}

function boundedJson(
  value: unknown,
  maxBytes: number,
  code: "request_too_large" | "output_too_large",
): Record<string, unknown> {
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    throw new AiGatewayError("invalid_request");
  }
  if (byteLength(encoded) > maxBytes) throw new AiGatewayError(code);
  try {
    const parsed: unknown = JSON.parse(encoded);
    if (!isRecord(parsed)) throw new AiGatewayError("invalid_request");
    return parsed;
  } catch (error) {
    if (error instanceof AiGatewayError) throw error;
    throw new AiGatewayError("invalid_request");
  }
}

function operationValue(value: string): AiGatewayOperation {
  if (value === "models.list" || value === "chat.completions") return value;
  throw new AiGatewayError("invalid_request");
}

function reference(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{2,127}$/u.test(value)) {
    throw new AiGatewayError("invalid_request");
  }
  return value;
}

function nonEmpty(value: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || byteLength(value) > maxBytes) {
    throw new AiGatewayError("invalid_request");
  }
  return value;
}

function positiveLimit(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError("AI gateway limit is invalid");
  return value;
}

function safeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Number.isSafeInteger(value);
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeNonNegative(value: unknown): value is number {
  return safeNumber(value) && value >= 0;
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function statusFor(code: AiGatewayErrorCode): number {
  switch (code) {
    case "invalid_request":
      return 400;
    case "model_not_allowed":
      return 400;
    case "request_too_large":
      return 413;
    case "output_too_large":
      return 502;
    case "upstream_unavailable":
      return 503;
    case "invalid_response":
      return 502;
  }
}
