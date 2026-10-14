import { expect, test } from "bun:test";
import { createAiRequestStore, expirePendingAiRequests } from "../src/ai-requests.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import { type Sql, SqlError } from "../src/ports.ts";

async function fixture(phase: "claimed" | "ready" | "dispatched" = "dispatched", funded = true) {
  const sql = createEphemeralSql();
  let instant = new Date("2026-10-14T00:00:00.000Z");
  const clock = () => instant;
  const ledger = createLedger(sql, clock);
  await ledger.fund({
    organizationId: "org:expiry",
    fundingRef: "test",
    amountMicros: 1000,
    consumptionClass: "purchased",
  });
  const requests = createAiRequestStore(sql, clock);
  const claim = await requests.claim({
    organizationId: "org:expiry",
    idempotencyKey: "test:call",
    fingerprint: "request",
    requestId: "ai_expiry",
    ceilingMicros: 123,
  });
  if (funded)
    expect(
      await ledger.hold({
        organizationId: "org:expiry",
        reference: "ai_expiry",
        amountMicros: 123,
      }),
    ).toBe(true);
  const ready = phase === "claimed" ? claim.record : await requests.ready(claim);
  if (phase === "dispatched") {
    if (ready.kind !== "pending") throw new Error("pending fixture required");
    await requests.dispatched(claim, ready);
  }
  return {
    sql,
    ledger,
    clock,
    requests,
    claim,
    advance: () => {
      instant = new Date("2026-10-15T00:00:00.000Z");
    },
  };
}

for (const phase of ["claimed", "ready", "dispatched"] as const) {
  test(`expiry returns an abandoned ${phase} hold exactly once at its deadline`, async () => {
    const f = await fixture(phase);
    expect(await expirePendingAiRequests(f.sql, f.clock, 64)).toBe(0);
    expect((await f.ledger.wallet("org:expiry")).heldMicros).toBe(123);
    f.advance();
    expect(await expirePendingAiRequests(f.sql, f.clock, 64)).toBe(1);
    expect(await expirePendingAiRequests(f.sql, f.clock, 64)).toBe(0);
    const wallet = await f.ledger.wallet("org:expiry");
    expect(wallet.availableMicros).toBe(1000);
    expect(wallet.heldMicros).toBe(0);
    expect(wallet.entries.filter((entry) => entry.type === "release")).toHaveLength(1);
    expect((await f.sql.query("SELECT status FROM idempotency"))[0]?.status).toBe(410);
  });
}

test("expiry handles a claim killed before its hold and preserves a staged billable result", async () => {
  const empty = await fixture("claimed", false);
  empty.advance();
  expect(await expirePendingAiRequests(empty.sql, empty.clock, 64)).toBe(1);
  expect(
    (await empty.ledger.wallet("org:expiry")).entries.some((entry) => entry.type === "release"),
  ).toBe(false);
  const staged = await fixture();
  await staged.requests.stage(staged.claim, {
    kind: "result",
    requestId: "ai_expiry",
    moneyPolicy: "usd-micros-v2",
    ceilingMicros: 123,
    actualMicros: 50,
    responseStatus: 200,
    responseBody: {},
    usageModel: "test",
    inputTokens: 1,
    outputTokens: 1,
  });
  staged.advance();
  expect(await expirePendingAiRequests(staged.sql, staged.clock, 64)).toBe(0);
  expect((await staged.ledger.wallet("org:expiry")).heldMicros).toBe(123);
});

test("a failed expiry batch rolls back the release and remains recoverable", async () => {
  const f = await fixture();
  f.advance();
  const broken: Sql = {
    query: (query, params) => f.sql.query(query, params),
    run: (query, params) => f.sql.run(query, params),
    batch: (statements) =>
      f.sql.batch([
        ...statements,
        { sql: "INSERT INTO wallet_allocation_guards (id, valid) VALUES ('failure', 0)" },
      ]),
  };
  await expect(expirePendingAiRequests(broken, f.clock, 64)).rejects.toBeInstanceOf(SqlError);
  expect((await f.ledger.wallet("org:expiry")).heldMicros).toBe(123);
  expect((await f.sql.query("SELECT status FROM idempotency"))[0]?.status).toBe(102);
  expect(await expirePendingAiRequests(f.sql, f.clock, 64)).toBe(1);
});

test("a result staged after expiry selection wins without an unearned release", async () => {
  const f = await fixture();
  f.advance();
  const racing: Sql = {
    query: (query, params) => f.sql.query(query, params),
    run: (query, params) => f.sql.run(query, params),
    async batch(statements) {
      await f.sql.run("UPDATE idempotency SET status = 202");
      return f.sql.batch(statements);
    },
  };
  expect(await expirePendingAiRequests(racing, f.clock, 64)).toBe(0);
  expect((await f.ledger.wallet("org:expiry")).heldMicros).toBe(123);
});
