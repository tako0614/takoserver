import { describe, expect, test } from "bun:test";
import { createWorkerDataServices } from "../src/worker-data-services.ts";

const MODELS = JSON.stringify([
  {
    id: "takoserver-text",
    upstreamId: "@cf/meta/llama-3.1-8b-instruct",
    created: 1_787_054_400,
    ownedBy: "takoserver",
    maxInputTokens: 24_000,
    maxOutputTokens: 4_096,
    inputMinorPerMillionTokens: 40,
    outputMinorPerMillionTokens: 300,
  },
]);

describe("Worker data service composition", () => {
  test("keeps ordinary AI and S3 absent unless the operator configures them", () => {
    expect(createWorkerDataServices({})).toEqual({});
  });

  test("composes exact public AI models and standard S3 credentials", () => {
    const AI = { async run() {} };
    const services = createWorkerDataServices({
      AI,
      CLOUDFLARE_ACCOUNT_ID: "account_01",
      TAKOSERVER_AI_MODELS: MODELS,
      TAKOSERVER_R2_PARENT_ACCESS_KEY_ID: "parent-key",
      TAKOSERVER_R2_PARENT_TOKEN: "a".repeat(64),
    });
    expect(services.ai?.models).toEqual([
      {
        id: "takoserver-text",
        created: 1_787_054_400,
        ownedBy: "takoserver",
        limits: { maxInputTokens: 24_000, maxOutputTokens: 4_096 },
        price: { inputMinorPerMillionTokens: 40, outputMinorPerMillionTokens: 300 },
      },
    ]);
    expect(services.s3).toBeDefined();
    expect(JSON.stringify(services)).not.toContain("a".repeat(64));
  });

  test("refuses partial or malformed operator configuration", () => {
    expect(() => createWorkerDataServices({ TAKOSERVER_AI_MODELS: MODELS })).toThrow(
      "AI binding is not configured",
    );
    expect(() =>
      createWorkerDataServices({
        CLOUDFLARE_ACCOUNT_ID: "account_01",
        TAKOSERVER_AI_MODELS: MODELS,
      }),
    ).toThrow("AI binding is not configured");
    expect(() =>
      createWorkerDataServices({
        CLOUDFLARE_ACCOUNT_ID: "account_01",
        TAKOSERVER_R2_PARENT_ACCESS_KEY_ID: "parent-key",
      }),
    ).toThrow("S3 credential issuer is not fully configured");
    expect(() =>
      createWorkerDataServices({
        CLOUDFLARE_ACCOUNT_ID: "account_01",
        TAKOSERVER_R2_PARENT_ACCESS_KEY_ID: "parent-key",
        TAKOSERVER_R2_PARENT_TOKEN: "not-a-parent-secret",
      }),
    ).toThrow();
  });
});
