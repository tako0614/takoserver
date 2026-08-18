import { expect, test } from "bun:test";
import { createCloudflareAiGateway } from "../src/providers/cloudflare-ai.ts";

test("Cloudflare Workers AI uses the required exact gateway header", async () => {
  let seen: Request | undefined;
  const gateway = createCloudflareAiGateway({
    accountId: "account_01",
    models: [
      {
        id: "takoserver-text",
        upstreamId: "@cf/meta/llama-3.1-8b-instruct-fp8",
        created: 1,
        ownedBy: "takoserver",
        limits: { maxInputTokens: 32_000, maxOutputTokens: 4_096 },
        price: { inputMinorPerMillionTokens: 20, outputMinorPerMillionTokens: 40 },
      },
    ],
    authorize: () => "Bearer provider-secret",
    async fetch(request) {
      seen = request;
      return Response.json({
        id: "chat_1",
        object: "chat.completion",
        model: "@cf/meta/llama-3.1-8b-instruct-fp8",
        choices: [],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      });
    },
  });

  await gateway.chat(
    { model: "takoserver-text", messages: [{ role: "user", content: "hello" }] },
    { requestId: "request_1", idempotencyKey: "idem_1" },
  );

  expect(seen?.url).toBe(
    "https://api.cloudflare.com/client/v4/accounts/account_01/ai/v1/chat/completions",
  );
  expect(seen?.headers.get("authorization")).toBe("Bearer provider-secret");
  expect(seen?.headers.get("cf-aig-gateway-id")).toBe("default");
});
