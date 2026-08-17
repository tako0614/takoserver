import { describe, expect, test } from "bun:test";
import { AiGatewayError, aiGatewayIntent, createAiGatewayModule } from "../src/ai-gateway.ts";
import {
  createExecutionGrantSigner,
  createRuntimeGrantVerifier,
  executionIntentDigest,
  InMemoryGrantReplayStore,
} from "../src/runtime-grants.ts";

const issuedAt = Date.parse("2026-08-17T12:00:00.000Z");

async function grantFor(
  intent: unknown,
  options: { readonly tenantRef?: string; readonly grantId?: string } = {},
) {
  const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const tenantRef = options.tenantRef ?? "tenant_ai_test";
  const signer = createExecutionGrantSigner({
    issuer: "https://api.takoserver.com",
    keyId: "ai-key",
    privateKey: keys.privateKey,
  });
  const token = await signer.issue({
    audience: "takoserver.runtime.v1",
    securityDomainId: "domain_ai_test",
    tenantRef,
    reservationId: "reservation_ai_test",
    offeringId: "ai.gateway.standard",
    offeringDigest: `sha256:${"c".repeat(64)}`,
    operation: "ai.invoke",
    intentDigest: await executionIntentDigest(intent),
    issuedAt: new Date(issuedAt),
    expiresAt: new Date(issuedAt + 60_000),
    grantId: options.grantId ?? "grant_ai_test",
  });
  return {
    token,
    verifier: createRuntimeGrantVerifier({
      issuer: "https://api.takoserver.com",
      audience: "takoserver.runtime.v1",
      publicKeys: new Map([["ai-key", keys.publicKey]]),
      replayStore: new InMemoryGrantReplayStore(),
      clock: () => new Date(issuedAt + 1_000),
    }),
  };
}

const chatRequest = {
  model: "takoserver/test-model",
  messages: [{ role: "user" as const, content: "hello" }],
  max_tokens: 32,
};

describe("AiGatewayModule", () => {
  test("serves an exact model allowlist and returns a logical OpenAI chat response with usage receipt", async () => {
    const intent = aiGatewayIntent({
      operation: "models.list",
      tenantRef: "tenant_ai_test",
      resourceRef: "ai-resource",
    });
    const modelsGrant = await grantFor(intent, { grantId: "grant_ai_models" });
    let calls = 0;
    const module = createAiGatewayModule({
      verifier: modelsGrant.verifier,
      modelAllowlist: ["takoserver/test-model", "takoserver/other-model"],
      upstream: {
        async listModels() {
          calls += 1;
          return [
            { id: "takoserver/test-model", object: "model" },
            { id: "provider-secret-model", object: "model" },
          ];
        },
        async chatCompletions() {
          throw new Error("not expected");
        },
      },
    });
    const listed = await module.execute({
      kind: "models.list",
      grantToken: modelsGrant.token,
      tenantRef: "tenant_ai_test",
      resourceRef: "ai-resource",
    });
    expect(listed).toEqual({
      kind: "models.list",
      response: {
        object: "list",
        data: [
          { id: "takoserver/test-model", object: "model" },
          { id: "takoserver/other-model", object: "model" },
        ],
      },
    });
    expect(calls).toBe(0);

    const chatIntent = aiGatewayIntent({
      operation: "chat.completions",
      tenantRef: "tenant_ai_test",
      resourceRef: "ai-resource",
      request: chatRequest,
    });
    const chatGrant = await grantFor(chatIntent, { grantId: "grant_ai_chat" });
    let received: unknown;
    const chatModule = createAiGatewayModule({
      verifier: chatGrant.verifier,
      modelAllowlist: ["takoserver/test-model"],
      upstream: {
        async listModels() {
          return [];
        },
        async chatCompletions(request) {
          received = request;
          return {
            id: "chatcmpl_test",
            object: "chat.completion",
            created: 1_723_895_000,
            model: request.model,
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "hi" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
          };
        },
      },
    });
    const completed = await chatModule.execute({
      kind: "chat.completions",
      grantToken: chatGrant.token,
      tenantRef: "tenant_ai_test",
      resourceRef: "ai-resource",
      request: chatRequest,
    });
    expect(received).toEqual(chatRequest);
    expect(completed).toMatchObject({
      kind: "chat.completions",
      response: { choices: [{ message: { content: "hi" } }] },
      usageReceipt: {
        tenantRef: "tenant_ai_test",
        resourceRef: "ai-resource",
        model: "takoserver/test-model",
        promptTokens: 3,
        completionTokens: 2,
        totalTokens: 5,
      },
    });
  });

  test("rejects model substitution and intent substitution before upstream I/O", async () => {
    const request = { ...chatRequest };
    const intent = aiGatewayIntent({
      operation: "chat.completions",
      tenantRef: "tenant_ai_test",
      resourceRef: "ai-resource",
      request,
    });
    const grant = await grantFor(intent, { grantId: "grant_ai_substitution" });
    let calls = 0;
    const module = createAiGatewayModule({
      verifier: grant.verifier,
      modelAllowlist: ["takoserver/test-model"],
      upstream: {
        async listModels() {
          return [];
        },
        async chatCompletions() {
          calls += 1;
          throw new Error("should not be called");
        },
      },
    });
    await expect(
      module.execute({
        kind: "chat.completions",
        grantToken: grant.token,
        tenantRef: "tenant_ai_test",
        resourceRef: "ai-resource",
        request: { ...request, model: "provider-secret-model" },
      }),
    ).rejects.toEqual(new AiGatewayError("model_not_allowed"));
    expect(calls).toBe(0);
  });

  test("enforces request/output bounds and hides upstream failures", async () => {
    const tooMany = {
      ...chatRequest,
      messages: Array.from({ length: 4 }, () => ({ role: "user" as const, content: "x" })),
    };
    const tooManyIntent = aiGatewayIntent({
      operation: "chat.completions",
      tenantRef: "tenant_ai_test",
      resourceRef: "ai-resource",
      request: tooMany,
    });
    const tooManyGrant = await grantFor(tooManyIntent, { grantId: "grant_ai_bounds" });
    const bounded = createAiGatewayModule({
      verifier: tooManyGrant.verifier,
      modelAllowlist: ["takoserver/test-model"],
      maxMessages: 2,
      upstream: {
        async listModels() {
          return [];
        },
        async chatCompletions() {
          throw new Error("not expected");
        },
      },
    });
    await expect(
      bounded.execute({
        kind: "chat.completions",
        grantToken: tooManyGrant.token,
        tenantRef: "tenant_ai_test",
        resourceRef: "ai-resource",
        request: tooMany,
      }),
    ).rejects.toEqual(new AiGatewayError("request_too_large"));

    const responseIntent = aiGatewayIntent({
      operation: "chat.completions",
      tenantRef: "tenant_ai_test",
      resourceRef: "ai-resource",
      request: chatRequest,
    });
    const responseGrant = await grantFor(responseIntent, { grantId: "grant_ai_output" });
    const failing = createAiGatewayModule({
      verifier: responseGrant.verifier,
      modelAllowlist: ["takoserver/test-model"],
      maxResponseBytes: 128,
      upstream: {
        async listModels() {
          return [];
        },
        async chatCompletions() {
          throw new Error("provider credential secret");
        },
      },
    });
    const error = await failing
      .execute({
        kind: "chat.completions",
        grantToken: responseGrant.token,
        tenantRef: "tenant_ai_test",
        resourceRef: "ai-resource",
        request: chatRequest,
      })
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(AiGatewayError);
    expect(String(error)).not.toContain("credential");
  });
});
