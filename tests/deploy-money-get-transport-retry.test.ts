import { expect, test } from "bun:test";
import { DeployError } from "../scripts/deploy/errors.ts";
import { CloudflareIntegrationStorageProvider } from "../scripts/deploy/integration-storage-generation.ts";
import { healthRead } from "../scripts/deploy/schema-money-unit-owner.ts";

/**
 * The frame v3 QA counted about 2,000 single-shot storage GETs and health
 * reads after the last Money attempt's root would exist; one TCP reset would
 * have ended the plan. Reads are now repeated, boundedly, only for transport,
 * body transport, 429 and temporary 5xx; every other answer is judged once and
 * every failure carries a closed reason.
 */
const ACCOUNT = "a".repeat(32);
const D1_ID = "00000000-0000-4000-8000-000000000001";
const d1Ok = () =>
  Response.json({
    success: true,
    result: { uuid: D1_ID, name: "integration-ts-fixture", created_at: "2026-10-20T00:00:00Z" },
  });
const brokenBody = (status = 200) =>
  new Response(
    new ReadableStream({
      pull(controller) {
        controller.error(new Error("connection reset while reading"));
      },
    }),
    { status },
  );

function storage(outcomes: (() => Response | Promise<Response>)[]) {
  const methods: string[] = [];
  const provider = new CloudflareIntegrationStorageProvider(ACCOUNT, "token-value", {
    getRetryDelaysMs: [0, 0],
    fetcher: async (request) => {
      methods.push(request.method);
      const next = outcomes.shift();
      if (next === undefined) throw new Error("unexpected extra request");
      return await next();
    },
  });
  return { provider, methods };
}

async function rejection(promise: Promise<unknown>): Promise<Error & { reason?: unknown }> {
  try {
    await promise;
  } catch (error) {
    return error as Error & { reason?: unknown };
  }
  throw new Error("expected a rejection");
}

test("a storage GET is read again after transport, body transport, 429 or 5xx", async () => {
  for (const first of [
    () => Promise.reject(new TypeError("fetch failed")),
    () => brokenBody(),
    () => new Response("busy", { status: 429, headers: { "retry-after": "0" } }),
    () => new Response("<html>bad gateway</html>", { status: 502 }),
  ]) {
    const run = storage([first, d1Ok]);
    expect((await run.provider.getD1(D1_ID)).uuid).toBe(D1_ID);
    expect(run.methods).toEqual(["GET", "GET"]);
  }
  const exhausted = storage([
    () => new Response("", { status: 503 }),
    () => new Response("", { status: 500 }),
    () => new Response("", { status: 504 }),
  ]);
  expect((await rejection(exhausted.provider.getD1(D1_ID))).reason).toEqual({
    code: "http-status",
    operation: "storage-read",
    attempts: 3,
  });
});

test("refusals, malformed answers and writes are never sent again", async () => {
  for (const [answer, code] of [
    [() => Response.json({ success: false, errors: [] }, { status: 401 }), "http-response"],
    [() => Response.json({ success: false, errors: [] }, { status: 403 }), "http-response"],
    [() => new Response("{not json", { status: 200 }), "http-response"],
  ] as const) {
    const run = storage([answer]);
    expect((await rejection(run.provider.getD1(D1_ID))).reason).toEqual({
      code,
      operation: "storage-read",
      attempts: 1,
    });
    expect(run.methods).toHaveLength(1);
  }
  const write = storage([() => Promise.reject(new TypeError("fetch failed"))]);
  expect((await rejection(write.provider.createD1("integration-ts-fixture"))).reason).toEqual({
    code: "http-transport",
    operation: "storage-write",
    attempts: 1,
  });
  expect(write.methods).toEqual(["POST"]);
});

const MAINTENANCE = {
  error: {
    code: "backend_unavailable",
    message: "Host is quiesced for the wallet USD-micros schema maintenance transition",
    details: { reason: "runtime-configuration" },
  },
};
const maintenance = () =>
  Response.json(MAINTENANCE, {
    status: 503,
    headers: { "cache-control": "no-store", "retry-after": "60" },
  });

function health(outcomes: (() => Response | Promise<Response>)[]) {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    const next = outcomes.shift();
    if (next === undefined) throw new Error("unexpected extra health read");
    return await next();
  }) as unknown as Parameters<typeof healthRead>[1];
  return { fetcher, calls: () => calls };
}

test("the expected maintenance 503 is judged once; only transport, 429 and other 5xx repeat", async () => {
  const once = health([maintenance]);
  const read = await healthRead("https://worker.example.test", once.fetcher, [0, 0]);
  expect(read.response.status).toBe(503);
  expect(read.body).toEqual(MAINTENANCE);
  expect(once.calls()).toBe(1);
  for (const first of [
    () => Promise.reject(new TypeError("fetch failed")),
    () => brokenBody(),
    () => new Response("", { status: 429, headers: { "retry-after": "0" } }),
    () => new Response("<html>bad gateway</html>", { status: 502 }),
  ]) {
    const again = health([first, maintenance]);
    expect((await healthRead("https://worker.example.test", again.fetcher, [0, 0])).body).toEqual(
      MAINTENANCE,
    );
    expect(again.calls()).toBe(2);
  }
});

test("a malformed health body is refused once and exhausted reads keep a closed reason", async () => {
  const malformed = health([() => new Response("{not json", { status: 200 })]);
  const refused = await rejection(
    healthRead("https://worker.example.test", malformed.fetcher, [0, 0]),
  );
  expect(refused).toBeInstanceOf(DeployError);
  expect(refused.reason).toEqual({ code: "http-response", operation: "health-read", attempts: 1 });
  expect(malformed.calls()).toBe(1);
  // A non-JSON 503 is not the expected maintenance answer and is not retried.
  const edge503 = health([() => new Response("<html>unavailable</html>", { status: 503 })]);
  expect(
    (await rejection(healthRead("https://worker.example.test", edge503.fetcher, [0, 0]))).reason,
  ).toEqual({ code: "http-response", operation: "health-read", attempts: 1 });
  const down = health([
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.reject(new TypeError("fetch failed")),
    () => Promise.reject(new TypeError("fetch failed")),
  ]);
  expect(
    (await rejection(healthRead("https://worker.example.test", down.fetcher, [0, 0]))).reason,
  ).toEqual({ code: "http-transport", operation: "health-read", attempts: 3 });
});

test("a refusal whose body breaks, a 404 and a failed create are each sent once", async () => {
  for (const [answer, code] of [
    [() => brokenBody(401), "http-transport"],
    [() => brokenBody(403), "http-transport"],
    [() => Response.json({ success: false, errors: [] }, { status: 404 }), "http-response"],
  ] as const) {
    const run = storage([answer]);
    expect((await rejection(run.provider.getD1(D1_ID))).reason).toEqual({
      code,
      operation: "storage-read",
      attempts: 1,
    });
    expect(run.methods).toHaveLength(1);
  }
  for (const status of [429, 503]) {
    const create = storage([() => new Response("", { status })]);
    expect((await rejection(create.provider.createD1("integration-ts-fixture"))).reason).toEqual({
      code: "http-status",
      operation: "storage-write",
      attempts: 1,
    });
    expect(create.methods).toEqual(["POST"]);
  }
});

test("a maintenance 503 or a refusal whose body breaks is judged once, never read again", async () => {
  for (const status of [503, 401]) {
    const run = health([() => brokenBody(status)]);
    expect(
      (await rejection(healthRead("https://worker.example.test", run.fetcher, [0, 0]))).reason,
    ).toEqual({ code: "http-transport", operation: "health-read", attempts: 1 });
    expect(run.calls()).toBe(1);
  }
});
