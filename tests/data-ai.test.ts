import { describe, expect, test } from "bun:test";
import type { AiGateway } from "../src/ai-port.ts";
import { createAccounts, type ExternalIdentityVerifier } from "../src/auth.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createDataAiRoutes } from "../src/data-ai.ts";
import { createLedger } from "../src/ledger.ts";
import { createMetering } from "../src/metering.ts";

const identity: ExternalIdentityVerifier = {
  async verify({ assertion }) {
    return {
      providerSubject: assertion,
      email: `${assertion}@example.com`,
      displayName: assertion,
    };
  },
};

async function fixture(funds = 1_000, failFirstUsageRecord = false) {
  const sql = createEphemeralSql();
  const clock = () => new Date("2026-08-18T12:00:00.000Z");
  let identityCounter = 0;
  const accounts = createAccounts({
    sql,
    identity,
    clock,
    randomId: () => `fixed${++identityCounter}`,
  });
  const ledger = createLedger(sql, clock);
  const metering = createMetering({ sql, ledger, clock, randomId: () => "meter" });
  const signedIn = await accounts.signIn({ provider: "google", assertion: "owner" });
  const owner = await accounts.authenticate(`Bearer ${signedIn.sessionToken}`);
  if (!owner) throw new Error("owner did not authenticate");
  const organization = await accounts.createOrganization({ actor: owner, name: "Acme" });
  if (funds > 0) {
    await ledger.fund({ organizationId: organization.id, fundingRef: "seed", amountMinor: funds });
  }
  const scoped = await accounts.createApiKey({
    actor: owner,
    organizationId: organization.id,
    name: "ai-client",
    scopes: ["ai:invoke"],
    expiresInSeconds: 3_600,
  });
  const unscoped = await accounts.createApiKey({
    actor: owner,
    organizationId: organization.id,
    name: "reader",
    scopes: ["catalog:read"],
    expiresInSeconds: 3_600,
  });
  const calls: unknown[] = [];
  const gateway: AiGateway = {
    models: [
      {
        id: "takoserver-text",
        created: 1_787_054_400,
        ownedBy: "takoserver",
        limits: { maxInputTokens: 100, maxOutputTokens: 10 },
        price: { inputMinorPerMillionTokens: 1_000_000, outputMinorPerMillionTokens: 1_000_000 },
      },
    ],
    async chat(request) {
      calls.push(request);
      return {
        id: "chatcmpl_1",
        object: "chat.completion",
        created: 1_787_054_400,
        model: "takoserver-text",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "hello" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      };
    },
  };
  const routes = createDataAiRoutes({
    accounts,
    gateway,
    ledger,
    sql,
    record: async (usage) => {
      if (failFirstUsageRecord) {
        failFirstUsageRecord = false;
        throw new Error("usage store unavailable");
      }
      await metering.recordAi(usage);
    },
    clock,
    randomId: () => "req_fixed",
  });
  const call = (path: string, token: string | null, init: RequestInit = {}) => {
    const url = new URL(`https://api.example.test${path}`);
    return routes(
      new Request(url, {
        ...init,
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...((init.headers as Record<string, string>) ?? {}),
        },
      }),
      url,
    );
  };
  return { call, calls, scoped, unscoped, ledger, organization, sql };
}

describe("OpenAI-compatible AI data plane", () => {
  test("lists only configured models to an ai-scoped organization key", async () => {
    const { call, scoped, unscoped } = await fixture();

    expect((await call("/v1/ai/models", null))?.status).toBe(401);
    expect((await call("/v1/ai/models", unscoped.secret))?.status).toBe(401);

    const response = await call("/v1/ai/models", scoped.secret);
    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      object: "list",
      data: [
        {
          id: "takoserver-text",
          object: "model",
          created: 1_787_054_400,
          owned_by: "takoserver",
          takoserver: {
            pricing_revision: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
            maximum_charge_minor: 110,
          },
        },
      ],
    });
  });

  test("rejects a drifted pricing revision before holding funds or invoking upstream", async () => {
    const { call, calls, scoped, ledger, organization } = await fixture();
    const response = await call("/v1/ai/chat/completions", scoped.secret, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": "chat-priced",
        "x-takoserver-ai-pricing-revision": `sha256:${"0".repeat(64)}`,
      },
      body: JSON.stringify({
        model: "takoserver-text",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 10,
      }),
    });

    expect(response?.status).toBe(409);
    expect(await response?.json()).toMatchObject({ error: { code: "pricing_revision_conflict" } });
    expect(calls).toEqual([]);
    expect((await ledger.wallet(organization.id)).availableMinor).toBe(1_000);
  });

  test("holds the maximum, captures actual tokens, and records usage", async () => {
    const { call, calls, scoped, ledger, organization, sql } = await fixture();
    const response = await call("/v1/ai/chat/completions", scoped.secret, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "chat-one" },
      body: JSON.stringify({
        model: "takoserver-text",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 10,
      }),
    });

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      object: "chat.completion",
      model: "takoserver-text",
      usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
    });
    expect(calls).toHaveLength(1);
    expect((await ledger.wallet(organization.id)).availableMinor).toBe(995);
    expect(await sql.query("SELECT meter, quantity, amount_micros FROM usage_events")).toEqual([
      { meter: "ai.tokens.takoserver-text", quantity: 5, amount_micros: 0 },
    ]);
  });

  test("refuses before upstream inference when prepaid funds cannot cover the ceiling", async () => {
    const { call, calls, scoped } = await fixture(1);
    const response = await call("/v1/ai/chat/completions", scoped.secret, {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "chat-poor" },
      body: JSON.stringify({
        model: "takoserver-text",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 10,
      }),
    });

    expect(response?.status).toBe(402);
    expect(calls).toEqual([]);
  });

  test("requires a durable idempotency key before paid inference", async () => {
    const { call, calls, scoped } = await fixture();
    const response = await call("/v1/ai/chat/completions", scoped.secret, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "takoserver-text",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 10,
      }),
    });

    expect(response?.status).toBe(400);
    expect(await response?.json()).toMatchObject({ error: { code: "idempotency_key_required" } });
    expect(calls).toEqual([]);
  });

  test("replays one completed inference and charge for the same key", async () => {
    const { call, calls, scoped, ledger, organization, sql } = await fixture();
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "chat-replay" },
      body: JSON.stringify({
        model: "takoserver-text",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 10,
      }),
    } satisfies RequestInit;

    const first = await call("/v1/ai/chat/completions", scoped.secret, request);
    const second = await call("/v1/ai/chat/completions", scoped.secret, request);

    expect(first?.status).toBe(200);
    expect(second?.status).toBe(200);
    expect(await second?.json()).toEqual(await first?.json());
    expect(calls).toHaveLength(1);
    expect((await ledger.wallet(organization.id)).availableMinor).toBe(995);
    expect(await sql.query("SELECT request_id FROM usage_events")).toHaveLength(1);
  });

  test("rejects the same key with a different request before inference", async () => {
    const { call, calls, scoped } = await fixture();
    const headers = { "content-type": "application/json", "idempotency-key": "chat-conflict" };
    const first = await call("/v1/ai/chat/completions", scoped.secret, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "takoserver-text",
        messages: [{ role: "user", content: "one" }],
        max_tokens: 10,
      }),
    });
    const conflict = await call("/v1/ai/chat/completions", scoped.secret, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: "takoserver-text",
        messages: [{ role: "user", content: "different" }],
        max_tokens: 10,
      }),
    });

    expect(first?.status).toBe(200);
    expect(conflict?.status).toBe(409);
    expect(await conflict?.json()).toMatchObject({ error: { code: "idempotency_key_conflict" } });
    expect(calls).toHaveLength(1);
  });

  test("resumes durable settlement without a second upstream inference", async () => {
    const { call, calls, scoped, ledger, organization, sql } = await fixture(1_000, true);
    const request = {
      method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "chat-settlement" },
      body: JSON.stringify({
        model: "takoserver-text",
        messages: [{ role: "user", content: "hello" }],
        max_tokens: 10,
      }),
    } satisfies RequestInit;

    const interrupted = await call("/v1/ai/chat/completions", scoped.secret, request);
    expect(interrupted?.status).toBe(503);
    expect(await interrupted?.json()).toMatchObject({ error: { code: "settlement_pending" } });

    const recovered = await call("/v1/ai/chat/completions", scoped.secret, request);
    expect(recovered?.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect((await ledger.wallet(organization.id)).availableMinor).toBe(995);
    expect(await sql.query("SELECT request_id FROM usage_events")).toHaveLength(1);
  });
});
