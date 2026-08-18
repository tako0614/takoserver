import type { JsonObject } from "./ports.ts";

/** One public model and the exact commercial ceiling Takoserver sells. */
export interface AiModel {
  readonly id: string;
  readonly created: number;
  readonly ownedBy: string;
  readonly limits: {
    readonly maxInputTokens: number;
    readonly maxOutputTokens: number;
  };
  readonly price: {
    readonly inputMinorPerMillionTokens: number;
    readonly outputMinorPerMillionTokens: number;
  };
}

/**
 * Provider-neutral inference seam.
 *
 * OpenAI wire compatibility is owned by `data-ai.ts`; an adapter sees a
 * validated JSON request using one public model id and returns an untrusted
 * upstream value which the route validates before billing or exposing it.
 */
export interface AiGateway {
  readonly models: readonly AiModel[];
  chat(
    request: JsonObject,
    context: { readonly requestId: string; readonly idempotencyKey: string },
  ): Promise<unknown>;
}

export interface AiUsage {
  readonly requestId: string;
  readonly organizationId: string;
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class AiGatewayError extends Error {
  constructor(readonly code: "unavailable" | "timeout" | "invalid_response") {
    super(code);
    this.name = "AiGatewayError";
  }
}
