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
  test("keeps AI absent unless the operator configures it", () => {
    expect(createWorkerDataServices({})).toEqual({});
  });

  test("composes exact public AI models", () => {
    const AI = { async run() {} };
    const services = createWorkerDataServices({
      AI,
      TAKOSERVER_AI_MODELS: MODELS,
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
  });

  test("refuses partial or malformed operator configuration", () => {
    expect(() => createWorkerDataServices({ TAKOSERVER_AI_MODELS: MODELS })).toThrow(
      "AI binding is not configured",
    );
    expect(() =>
      createWorkerDataServices({
        TAKOSERVER_AI_MODELS: MODELS,
      }),
    ).toThrow("AI binding is not configured");
  });
});
