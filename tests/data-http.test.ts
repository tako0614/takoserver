import { describe, expect, test } from "bun:test";
import {
  aiGatewayIntent,
  createAiGatewayModule,
  createExecutionGrantSigner,
  createHttpHandler,
  createObjectStorageModule,
  createRuntimeGrantVerifier,
  createTakoserver,
  executionIntentDigest,
  InMemoryGrantReplayStore,
  InMemoryObjectStorageAdapter,
  objectStorageBodyDigest,
  objectStorageIntent,
  PortableFakeBackend,
} from "../src/index.ts";

describe("Takoserver public data planes", () => {
  test("serves resource-bound storage and AI through the independent HTTP contract", async () => {
    const now = Date.parse("2026-08-17T12:00:00.000Z");
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const signer = createExecutionGrantSigner({
      issuer: "https://api.takoserver.com",
      keyId: "runtime-key",
      privateKey: keys.privateKey,
    });
    const verifier = createRuntimeGrantVerifier({
      issuer: "https://api.takoserver.com",
      audience: "takoserver.runtime.v1",
      publicKeys: new Map([["runtime-key", keys.publicKey]]),
      replayStore: new InMemoryGrantReplayStore(),
      clock: () => new Date(now + 1_000),
    });
    const handler = createHttpHandler({
      server: createTakoserver({
        identity: {
          async verify() {
            return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
          },
        },
        backends: [new PortableFakeBackend("fake", [])],
      }),
      publicOrigin: "https://api.takoserver.com",
      objectStorage: createObjectStorageModule({
        verifier,
        adapter: new InMemoryObjectStorageAdapter(),
      }),
      aiGateway: createAiGatewayModule({
        verifier,
        modelAllowlist: ["takoserver/fast"],
        upstream: {
          async chatCompletions(request) {
            return {
              id: "chatcmpl_1",
              object: "chat.completion",
              created: 1,
              model: request.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "hello" },
                  finish_reason: "stop",
                },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
            };
          },
        },
      }),
    });
    const body = new TextEncoder().encode("hello");
    const putIntent = objectStorageIntent({
      operation: "put",
      tenantRef: "tenant-http",
      resourceRef: "bucket-http",
      key: "hello.txt",
      bodyDigest: await objectStorageBodyDigest(body),
      contentType: "text/plain",
    });
    const putToken = await issue(signer, now, "grant-put", "s3.access", putIntent);
    const put = await handler(
      new Request(
        "https://api.takoserver.com/v1/storage/object?tenantRef=tenant-http&resourceRef=bucket-http&key=hello.txt",
        {
          method: "PUT",
          headers: { authorization: `Bearer ${putToken}`, "content-type": "text/plain" },
          body,
        },
      ),
    );
    expect(put.status).toBe(201);

    const getIntent = objectStorageIntent({
      operation: "get",
      tenantRef: "tenant-http",
      resourceRef: "bucket-http",
      key: "hello.txt",
    });
    const getToken = await issue(signer, now, "grant-get", "s3.access", getIntent);
    const get = await handler(
      new Request(
        "https://api.takoserver.com/v1/storage/object?tenantRef=tenant-http&resourceRef=bucket-http&key=hello.txt",
        { headers: { authorization: `Bearer ${getToken}` } },
      ),
    );
    expect(get.status).toBe(200);
    expect(await get.text()).toBe("hello");

    const request = {
      model: "takoserver/fast",
      messages: [{ role: "user" as const, content: "hello" }],
    };
    const aiIntent = aiGatewayIntent({
      operation: "chat.completions",
      tenantRef: "tenant-http",
      resourceRef: "ai-http",
      request,
    });
    const aiToken = await issue(signer, now, "grant-ai", "ai.invoke", aiIntent);
    const chat = await handler(
      new Request(
        "https://api.takoserver.com/v1/ai/chat/completions?tenantRef=tenant-http&resourceRef=ai-http",
        {
          method: "POST",
          headers: { authorization: `Bearer ${aiToken}`, "content-type": "application/json" },
          body: JSON.stringify(request),
        },
      ),
    );
    expect(chat.status).toBe(200);
    expect(await chat.json()).toMatchObject({
      object: "chat.completion",
      model: "takoserver/fast",
      usage: { total_tokens: 2 },
    });
    expect(chat.headers.get("x-takoserver-usage")).toBeTruthy();
  });
});

async function issue(
  signer: ReturnType<typeof createExecutionGrantSigner>,
  now: number,
  grantId: string,
  operation: "s3.access" | "ai.invoke",
  intent: unknown,
): Promise<string> {
  return signer.issue({
    audience: "takoserver.runtime.v1",
    securityDomainId: "domain_data_test",
    tenantRef: "tenant-http",
    reservationId: "reservation-http",
    offeringId: operation === "s3.access" ? "storage.object.standard" : "ai.gateway.standard",
    offeringDigest: `sha256:${"c".repeat(64)}`,
    operation,
    intentDigest: await executionIntentDigest(intent),
    issuedAt: new Date(now),
    expiresAt: new Date(now + 60_000),
    grantId,
  });
}
