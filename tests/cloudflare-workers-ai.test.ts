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

  test("sanitizes modern Workers AI tool calls with opaque arguments and truncation", async () => {
    const calls: unknown[][] = [];
    const gateway = createCloudflareWorkersAiGateway({
      models: [
        {
          ...model,
          upstreamId: "@cf/google/gemma-4-26b-a4b-it",
        },
      ],
      binding: {
        async run(...input) {
          calls.push(input);
          return {
            id: "provider-completion-id",
            object: "chat.completion",
            created: 1_787_040_000,
            model: "@cf/google/gemma-4-26b-a4b-it",
            choices: [
              {
                index: 2,
                message: {
                  role: "assistant",
                  content: null,
                  refusal: null,
                  tool_calls: [
                    {
                      id: "call_toolbox_1",
                      type: "function",
                      function: {
                        name: "toolbox",
                        arguments: '{"action":"search","query":"storage"',
                      },
                    },
                  ],
                },
                finish_reason: "length",
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
          };
        },
      },
      clock: () => new Date("2026-08-18T08:00:00.000Z"),
    });

    const result = await gateway.chat(
      {
        model: "takoserver-text",
        messages: [{ role: "user", content: "Find storage tools" }],
        tools: [
          {
            type: "function",
            function: {
              name: "toolbox",
              description: "Find and call available tools",
              parameters: {
                type: "object",
                properties: { action: { type: "string" } },
                required: ["action"],
              },
            },
          },
        ],
        tool_choice: "auto",
        max_tokens: 64,
      },
      { requestId: "ai_request_tools", idempotencyKey: "chat-tools" },
    );

    expect(calls[0]?.[1]).toMatchObject({
      tools: [
        {
          type: "function",
          function: { name: "toolbox" },
        },
      ],
      tool_choice: "auto",
      stream: false,
    });
    expect(result).toEqual({
      id: "chatcmpl-ai_request_tools",
      object: "chat.completion",
      created: 1_787_040_000,
      model: "takoserver-text",
      choices: [
        {
          index: 2,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: "call_toolbox_1",
                type: "function",
                function: {
                  name: "toolbox",
                  arguments: '{"action":"search","query":"storage"',
                },
              },
            ],
          },
          finish_reason: "length",
        },
      ],
      usage: { prompt_tokens: 12, completion_tokens: 7, total_tokens: 19 },
    });
    expect(JSON.stringify(result)).not.toContain("@cf/google");
    expect(JSON.stringify(result)).not.toContain("provider-completion-id");
  });

  test("normalizes a modern Workers AI text completion to the public model", async () => {
    const gateway = createCloudflareWorkersAiGateway({
      models: [model],
      binding: {
        async run() {
          return {
            id: "provider-completion-id",
            object: "chat.completion",
            created: 1_787_040_000,
            model: "@cf/meta/llama-3.1-8b-instruct-fp8",
            choices: [
              {
                index: 0,
                message: {
                  role: "assistant",
                  content: "Modern Workers AI response",
                  refusal: null,
                },
                finish_reason: "stop",
                logprobs: null,
              },
            ],
            usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
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
      { requestId: "ai_request_modern_text", idempotencyKey: "chat-modern-text" },
    );

    expect(result).toEqual({
      id: "chatcmpl-ai_request_modern_text",
      object: "chat.completion",
      created: 1_787_040_000,
      model: "takoserver-text",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "Modern Workers AI response" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 9, completion_tokens: 4, total_tokens: 13 },
    });
    expect(JSON.stringify(result)).not.toContain("@cf/meta");
    expect(JSON.stringify(result)).not.toContain("provider-completion-id");
  });

  test("fails closed on malformed modern usage, role, and tool shapes", async () => {
    const modernBase = {
      id: "provider-completion-id",
      object: "chat.completion",
      created: 1_787_040_000,
      model: "@cf/meta/llama-3.1-8b-instruct-fp8",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: "hello" },
          finish_reason: "stop",
        },
      ],
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      response: "legacy fallback must not be accepted",
    };
    const baseChoice = modernBase.choices[0];
    if (!baseChoice) throw new Error("modern completion fixture is missing a choice");
    const malformed = [
      {
        label: "usage",
        output: {
          ...modernBase,
          usage: { prompt_tokens: 1, completion_tokens: "one", total_tokens: 2 },
        },
      },
      {
        label: "role",
        output: {
          ...modernBase,
          choices: [
            {
              ...baseChoice,
              message: { role: "user", content: "hello" },
            },
          ],
        },
      },
      {
        label: "tool",
        output: {
          ...modernBase,
          choices: [
            {
              index: 0,
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: "call_invalid",
                    type: "function",
                    function: { name: "toolbox", arguments: [] },
                  },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
      },
      {
        label: "choice-index",
        output: {
          ...modernBase,
          choices: [
            {
              ...baseChoice,
              index: -1,
            },
          ],
        },
      },
    ] as const;

    for (const { label, output } of malformed) {
      const gateway = createCloudflareWorkersAiGateway({
        models: [model],
        binding: {
          async run() {
            return output;
          },
        },
      });
      const error = await gateway
        .chat(
          { model: "takoserver-text", messages: [{ role: "user", content: "hello" }] },
          { requestId: `ai_request_malformed_${label}`, idempotencyKey: `chat-${label}` },
        )
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(AiGatewayError);
      expect((error as AiGatewayError).code).toBe("invalid_response");
    }
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
