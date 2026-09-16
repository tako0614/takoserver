import { describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatAiLiveQualificationResult,
  runAiLiveQualification,
  runAiLiveQualificationCli,
  safeReadApiKeyFile,
} from "../scripts/ai-live-qualification.ts";

const ORIGIN = "https://api.example.test";
const ORGANIZATION_ID = "org_qualification";
const MODEL_ID = "takoserver-text";
const PRICING_REVISION = `sha256:${"a".repeat(64)}`;
const API_KEY = "sk-test-qualification-secret";
const IDEMPOTENCY_KEY = "qualification-test-key-0001";

interface Call {
  readonly url: string;
  readonly init: RequestInit;
}

interface FixtureOptions {
  readonly responses: readonly (Response | Error | "hang")[];
  readonly maximumChargeMinor?: number;
  readonly executeLive?: boolean;
  readonly timeoutMs?: number;
}

function fixture(options: FixtureOptions) {
  const calls: Call[] = [];
  let readCount = 0;
  let next = 0;
  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    calls.push({ url: String(input), init: init ?? {} });
    const response = options.responses[next++];
    if (response === "hang") return await new Promise<Response>(() => undefined);
    if (response instanceof Error) throw response;
    if (!response) throw new Error("fixture exhausted");
    return response;
  };
  const run = () =>
    runAiLiveQualification({
      origin: ORIGIN,
      organizationId: ORGANIZATION_ID,
      publicModelId: MODEL_ID,
      exactPricingRevision: PRICING_REVISION,
      maximumChargeMinor: options.maximumChargeMinor ?? 5,
      idempotencyKey: IDEMPOTENCY_KEY,
      apiKeyFile: "/private/api-key",
      executeLive: options.executeLive ?? true,
      timeoutMs: options.timeoutMs ?? 100,
      fetcher,
      readCredential: () => {
        readCount += 1;
        return API_KEY;
      },
    });
  return { calls, run, readCount: () => readCount };
}

function discoveryResponse(): Response {
  return Response.json({
    product: "takoserver",
    apiVersion: "v1",
    endpoints: { api: ORIGIN, ai: `${ORIGIN}/v1/ai` },
  });
}

function modelsResponse(maximumChargeMinor = 5): Response {
  return Response.json({
    object: "list",
    data: [
      {
        id: MODEL_ID,
        object: "model",
        takoserver: {
          pricing_revision: PRICING_REVISION,
          maximum_charge_minor: maximumChargeMinor,
        },
      },
    ],
  });
}

function walletResponse(availableMinor = 5): Response {
  return Response.json({
    wallet: { organizationId: ORGANIZATION_ID, currency: "USD", availableMinor },
  });
}

function completionResponse(
  content = "OK",
  requestId = "ai_qualification_request",
  billedMinor = 1,
): Response {
  return new Response(
    JSON.stringify({
      id: requestId,
      object: "chat.completion",
      created: 1_789_000_000,
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": requestId,
        "x-takoserver-billed-minor": String(billedMinor),
      },
    },
  );
}

function malformedCompletionResponse(choice: unknown): Response {
  return new Response(
    JSON.stringify({
      id: "ai_qualification_request",
      object: "chat.completion",
      created: 1_789_000_000,
      model: MODEL_ID,
      choices: [choice],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "x-request-id": "ai_qualification_request",
        "x-takoserver-billed-minor": "1",
      },
    },
  );
}

function validResponses(walletAvailable = 5): Response[] {
  return [
    discoveryResponse(),
    modelsResponse(),
    walletResponse(walletAvailable),
    completionResponse(),
    completionResponse(),
  ];
}

describe("AI live qualification client", () => {
  test("keeps help and the default CLI mode network-free", async () => {
    const help: string[] = [];
    const helpExit = await runAiLiveQualificationCli(["--help"], {
      stdout: (value) => help.push(value),
    });
    expect(helpExit).toBe(0);
    expect(help.join("")).toContain("without --execute-live, no network request is made");

    const output: string[] = [];
    let fetchCalls = 0;
    const dryRunExit = await runAiLiveQualificationCli(
      [
        "--origin",
        ORIGIN,
        "--organization-id",
        ORGANIZATION_ID,
        "--public-model-id",
        MODEL_ID,
        "--pricing-revision",
        PRICING_REVISION,
        "--maximum-charge-minor",
        "5",
        "--idempotency-key",
        IDEMPOTENCY_KEY,
        "--api-key-file",
        "/private/api-key",
      ],
      {
        fetch: async () => {
          fetchCalls += 1;
          throw new Error("network must not run");
        },
        readCredential: () => {
          throw new Error("credential must not be read");
        },
        stdout: (value) => output.push(value),
      },
    );
    expect(dryRunExit).toBe(0);
    expect(fetchCalls).toBe(0);
    expect(JSON.parse(output.join(""))).toMatchObject({
      status: "skipped",
      reason: "execution_not_requested",
    });
  });

  test("does not read credentials or use the network without --execute-live", async () => {
    const fixtureState = fixture({ responses: validResponses(), executeLive: false });
    const result = await fixtureState.run();

    expect(result).toMatchObject({
      status: "skipped",
      stage: "none",
      reason: "execution_not_requested",
    });
    expect(fixtureState.calls).toHaveLength(0);
    expect(fixtureState.readCount()).toBe(0);
  });

  test("refuses before POST when the observed wallet cannot cover the exact ceiling", async () => {
    const fixtureState = fixture({ responses: validResponses(4) });
    const result = await fixtureState.run();

    expect(result).toMatchObject({
      status: "failed",
      stage: "wallet",
      reason: "wallet_insufficient",
    });
    expect(result.wallet).toMatchObject({ availableMinor: 4, source: "preflight_observation" });
    expect(fixtureState.calls.map(({ init }) => init.method ?? "GET")).toEqual([
      "GET",
      "GET",
      "GET",
    ]);
  });

  test("rejects a 200 completion with no actual assistant message before replay", async () => {
    const fixtureState = fixture({
      responses: [
        discoveryResponse(),
        modelsResponse(),
        walletResponse(),
        malformedCompletionResponse(null),
        completionResponse(),
      ],
    });
    const result = await fixtureState.run();

    expect(result).toMatchObject({ status: "failed", stage: "post", reason: "post_malformed" });
    expect(fixtureState.calls).toHaveLength(4);
  });

  test("refuses before wallet or POST when the model ceiling exceeds the caller budget", async () => {
    const fixtureState = fixture({
      responses: [
        discoveryResponse(),
        modelsResponse(6),
        walletResponse(),
        completionResponse(),
        completionResponse(),
      ],
      maximumChargeMinor: 5,
    });
    const result = await fixtureState.run();

    expect(result).toMatchObject({ status: "failed", stage: "models", reason: "budget_exceeded" });
    expect(fixtureState.calls.map(({ init }) => init.method ?? "GET")).toEqual(["GET", "GET"]);
  });

  test("performs exactly two identical POSTs only after all preflight checks pass", async () => {
    const fixtureState = fixture({ responses: validResponses() });
    const result = await fixtureState.run();

    expect(result.status).toBe("passed");
    expect(fixtureState.calls.map(({ init }) => init.method ?? "GET")).toEqual([
      "GET",
      "GET",
      "GET",
      "POST",
      "POST",
    ]);
    const firstPost = fixtureState.calls[3];
    const replay = fixtureState.calls[4];
    expect(firstPost?.init.body).toBe(replay?.init.body);
    expect(firstPost?.init.headers).toMatchObject({
      authorization: `Bearer ${API_KEY}`,
      "idempotency-key": IDEMPOTENCY_KEY,
      "x-takoserver-ai-pricing-revision": PRICING_REVISION,
      "content-type": "application/json",
    });
    const body = JSON.parse(String(firstPost?.init.body));
    expect(body).toMatchObject({ model: MODEL_ID, max_tokens: 1, stream: false });
    expect(body.messages).toEqual([{ role: "user", content: "Reply with exactly: OK" }]);
    const serialized = formatAiLiveQualificationResult(result);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain(IDEMPOTENCY_KEY);
    expect(serialized).not.toContain("Reply with exactly: OK");
    expect(serialized).not.toContain("ai_qualification_request");
  });

  test("classifies a POST timeout as unknown and never retries it", async () => {
    const fixtureState = fixture({
      responses: [discoveryResponse(), modelsResponse(), walletResponse(), "hang"],
      timeoutMs: 5,
    });
    const result = await fixtureState.run();

    expect(result).toMatchObject({ status: "unknown", stage: "post", reason: "timeout" });
    expect(fixtureState.calls).toHaveLength(4);
  });

  test("fails a replay whose completion bytes, request id, or billed field differs", async () => {
    const fixtureState = fixture({
      responses: [
        discoveryResponse(),
        modelsResponse(),
        walletResponse(),
        completionResponse("OK", "ai_qualification_request", 1),
        completionResponse("different", "ai_qualification_replay", 2),
      ],
    });
    const result = await fixtureState.run();

    expect(result).toMatchObject({ status: "failed", stage: "replay", reason: "replay_mismatch" });
    expect(result.response).toMatchObject({ billedMinor: 1 });
    expect(fixtureState.calls).toHaveLength(5);
  });

  test("redacts transport errors and never emits raw completion content", async () => {
    const secret = "do-not-print-this-provider-error";
    const fixtureState = fixture({
      responses: [discoveryResponse(), modelsResponse(), walletResponse(), new Error(secret)],
    });
    const result = await fixtureState.run();
    const serialized = formatAiLiveQualificationResult(result);

    expect(result).toMatchObject({ status: "unknown", stage: "post", reason: "transport_error" });
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain(API_KEY);
    expect(serialized).not.toContain("Reply with exactly: OK");
  });

  test("does not reflect unchecked identifiers from invalid input", async () => {
    const secretLookingOrganization = "Bearer do-not-reflect\norg";
    const result = await runAiLiveQualification({
      origin: ORIGIN,
      organizationId: secretLookingOrganization,
      publicModelId: "model\nwith-secret",
      exactPricingRevision: "pricing-secret\nvalue",
      maximumChargeMinor: 5,
      idempotencyKey: IDEMPOTENCY_KEY,
      apiKeyFile: "/private/api-key",
      executeLive: true,
      fetcher: async () => {
        throw new Error("network must not run");
      },
      readCredential: () => API_KEY,
    });
    const serialized = formatAiLiveQualificationResult(result);

    expect(result).toMatchObject({ status: "failed", stage: "local", reason: "invalid_input" });
    expect(serialized).not.toContain(secretLookingOrganization);
    expect(serialized).not.toContain("model\\nwith-secret");
    expect(serialized).not.toContain("pricing-secret");
    expect(serialized).toContain('"organizationId":""');
    expect(serialized).toContain('"publicModelId":""');
    expect(serialized).toContain('"exactPricingRevision":""');
  });

  test("reads a fake key only from a private 0700 parent and rejects unsafe parents", () => {
    const root = mkdtempSync(join(tmpdir(), "takoserver-ai-qualification-key-"));
    const keyPath = join(root, "api-key");
    try {
      writeFileSync(keyPath, API_KEY, { mode: 0o600 });
      expect(safeReadApiKeyFile(keyPath)).toBe(API_KEY);

      chmodSync(root, 0o755);
      expect(() => safeReadApiKeyFile(keyPath)).toThrow();
      chmodSync(root, 0o700);

      const actual = join(root, "actual");
      mkdirSync(actual, { mode: 0o700 });
      const linkedParent = join(root, "linked-parent");
      symlinkSync(actual, linkedParent, "dir");
      const linkedKey = join(linkedParent, "api-key");
      writeFileSync(join(actual, "api-key"), API_KEY, { mode: 0o600 });
      expect(() => safeReadApiKeyFile(linkedKey)).toThrow();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
