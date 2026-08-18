import { describe, expect, test } from "bun:test";
import { AiGatewayError } from "../src/ai-port.ts";
import { createCloudflareWorkersAiGateway } from "../src/providers/cloudflare-workers-ai.ts";

const model = {
  id: "takoserver-text",
  upstreamId: "@cf/meta/llama-3.1-8b-instruct-fp8",
  created: 1_787_054_400,
  ownedBy: "takoserver",
  limits: { maxInputTokens: 24_000, maxOutputTokens: 4_096 },
  price: { inputMinorPerMillionTokens: 20, outputMinorPerMillionTokens: 40 },
} as const;

describe("Cloudflare Workers AI binding adapter", () => {
  test("maps the private upstream model through the native binding and returns public wire identity", async () => {
    const calls: unknown[][] = [];
    const gateway = createCloudflareWorkersAiGateway({
      models: [model],
      binding: {
        async run(...input) {
          calls.push(input);
          return {
            response: "hello",
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          };
        },
      },
      clock: () => new Date("2026-08-18T08:00:00.000Z"),
    });

    const result = await gateway.chat(
      {
        model: "takoserver-text",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 64,
      },
      { requestId: "ai_request_1", idempotencyKey: "chat-one" },
    );

    expect(calls).toEqual([
      [
        "@cf/meta/llama-3.1-8b-instruct-fp8",
        {
          messages: [{ role: "user", content: "hello" }],
          max_tokens: 64,
          stream: false,
        },
        {
          gateway: {
            id: "default",
            eventId: "ai_request_1",
            metadata: { takoserver_request_id: "ai_request_1" },
          },
        },
      ],
    ]);
    expect(result).toEqual({
      id: "chatcmpl-ai_request_1",
      object: "chat.completion",
      created: 1_787_040_000,
      model: "takoserver-text",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    expect(JSON.stringify(result)).not.toContain("@cf/meta");
  });

  test("fails closed on an unknown public model or malformed native result", async () => {
    let calls = 0;
    const gateway = createCloudflareWorkersAiGateway({
      models: [model],
      binding: {
        async run() {
          calls += 1;
          return { response: "hello" };
        },
      },
    });

    const unknown = await gateway
      .chat(
        { model: "provider-secret-model", messages: [{ role: "user", content: "hello" }] },
        { requestId: "ai_request_2", idempotencyKey: "chat-two" },
      )
      .catch((error: unknown) => error);
    expect(unknown).toBeInstanceOf(AiGatewayError);
    expect(calls).toBe(0);

    const malformed = await gateway
      .chat(
        { model: "takoserver-text", messages: [{ role: "user", content: "hello" }] },
        { requestId: "ai_request_3", idempotencyKey: "chat-three" },
      )
      .catch((error: unknown) => error);
    expect(malformed).toBeInstanceOf(AiGatewayError);
    expect((malformed as AiGatewayError).code).toBe("invalid_response");
  });

  test("redacts native binding failures", async () => {
    const gateway = createCloudflareWorkersAiGateway({
      models: [model],
      binding: {
        async run() {
          throw new Error("provider account secret detail");
        },
      },
    });
    const error = await gateway
      .chat(
        { model: "takoserver-text", messages: [{ role: "user", content: "hello" }] },
        { requestId: "ai_request_4", idempotencyKey: "chat-four" },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiGatewayError);
    expect(String(error)).not.toContain("provider account secret detail");
  });
});
