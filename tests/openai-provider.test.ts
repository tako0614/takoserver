import { describe, expect, test } from "bun:test";
import { AiGatewayError } from "../src/ai-port.ts";
import { createOpenAiGateway } from "../src/providers/openai.ts";

const model = {
  id: "takoserver-text",
  upstreamId: "@cf/provider/model-v1",
  created: 1_787_054_400,
  ownedBy: "takoserver",
  limits: { maxInputTokens: 24_000, maxOutputTokens: 4_096 },
  price: { inputMinorPerMillionTokens: 40, outputMinorPerMillionTokens: 300 },
} as const;

describe("OpenAI-compatible upstream adapter", () => {
  test("maps a public allowlisted model to the operator-owned upstream", async () => {
    const requests: Request[] = [];
    const gateway = createOpenAiGateway({
      baseUrl: "https://upstream.example/v1",
      models: [model],
      authorize: () => "Bearer upstream-secret",
      async fetch(request) {
        requests.push(request);
        return Response.json({
          id: "chatcmpl_upstream",
          object: "chat.completion",
          created: 1_787_054_400,
          model: "@cf/provider/model-v1",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: "hello" },
              finish_reason: "stop",
            },
          ],
          usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
        });
      },
    });

    const result = await gateway.chat(
      {
        model: "takoserver-text",
        messages: [{ role: "user", content: "hello" }],
      },
      { requestId: "ai_one", idempotencyKey: "chat-one" },
    );
    expect(result).toMatchObject({ model: "takoserver-text" });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://upstream.example/v1/chat/completions");
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer upstream-secret");
    expect(requests[0]?.headers.get("idempotency-key")).toBe("chat-one");
    expect(requests[0]?.headers.get("x-request-id")).toBe("ai_one");
    expect(await requests[0]?.json()).toMatchObject({ model: "@cf/provider/model-v1" });
  });

  test("classifies an upstream refusal without exposing its response", async () => {
    const gateway = createOpenAiGateway({
      baseUrl: "https://upstream.example/v1",
      models: [model],
      authorize: () => "Bearer upstream-secret",
      async fetch() {
        return Response.json(
          { error: { message: "account credential secret detail" } },
          { status: 500 },
        );
      },
    });

    const error = await gateway
      .chat(
        { model: "takoserver-text", messages: [{ role: "user", content: "hello" }] },
        { requestId: "ai_two", idempotencyKey: "chat-two" },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(AiGatewayError);
    expect(String(error)).not.toContain("credential secret detail");
  });
});
