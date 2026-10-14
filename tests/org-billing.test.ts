import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { type BillingConfig, parseBillingConfig } from "../src/billing-config.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createLedger } from "../src/ledger.ts";
import {
  assertOrgBillingSchema,
  createOrgBilling,
  OrgBillingError,
  type UsageInput,
} from "../src/org-billing.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

function config(overrides: Partial<BillingConfig> = {}): BillingConfig {
  const parsed = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "r1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: 0,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {
        "takosumi.storage.byte-hours": {
          unit: "byte-hour",
          rate: { numeratorMicros: "10000", denominator: "1" },
        },
        requests: { unit: "request", rate: { numeratorMicros: "5000", denominator: "1" } },
      },
      ...overrides,
    }),
  );
  if (!parsed) throw new Error("missing config");
  return parsed;
}
function fixture(tariff = config()) {
  const sql = createEphemeralSql();
  let time = "2026-10-13T00:00:00.000Z";
  const clock = () => new Date(time);
  const ledger = createLedger(sql, clock);
  return {
    sql,
    clock,
    ledger,
    billing: createOrgBilling({ sql, clock, ledger, config: tariff }),
    setTime: (value: string) => {
      time = value;
    },
  };
}
/**
 * A second billing service over the fixture whose clock jumps once, right after
 * the next bounded expiry sweep has read its rows: a deadline then passes
 * between the sweep and the rest of the same request.
 */
function sweepClock(f: ReturnType<typeof fixture>) {
  let next: string | undefined;
  const sql: Sql = {
    async query(query, params) {
      const rows = await f.sql.query(query, params);
      if (next !== undefined && query.includes("ORDER BY expires_at, org_id, ref")) {
        f.setTime(next);
        next = undefined;
      }
      return rows;
    },
    run: (query, params) => f.sql.run(query, params),
    batch: (statements) => f.sql.batch(statements),
  };
  return {
    billing: createOrgBilling({ sql, clock: f.clock, ledger: f.ledger, config: config() }),
    advanceAfterSweep(value: string) {
      next = value;
    },
  };
}
const hold = {
  organizationId: "org_a",
  reference: "run_1",
  amountMicros: 10,
  pricingRevision: "r1",
  measurementFingerprint: "estimate-v1",
};
const capture = {
  organizationId: "org_a",
  reference: "run_1",
  amountMicros: 4,
  actualMicros: "4",
  measurementFingerprint: "actual-v1",
};
const usage: UsageInput = {
  organizationId: "org_a",
  reference: "period_1",
  meter: "takosumi.storage.byte-hours",
  quantity: "3600000",
  quantityUnit: "byte-millisecond",
  periodStart: "2026-10-12T00:00:00.000Z",
  periodEnd: "2026-10-12T01:00:00.000Z",
  pricingRevision: "r1",
  expectedMicros: 10000,
  measurementFingerprint: "closed-period",
};

async function errorCode(promise: Promise<unknown>, code: string, status: number) {
  try {
    await promise;
    throw new Error("expected billing failure");
  } catch (error) {
    expect(error).toBeInstanceOf(OrgBillingError);
    expect(error).toMatchObject({ code, status });
  }
}

describe("Organization wallet lifecycle", () => {
  test("one batch captures actual and releases unused budget; semantic retries conserve", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 15,
      consumptionClass: "purchased",
    });
    const admitted = await f.billing.hold(hold);
    const settled = await f.billing.capture(capture);
    expect(settled).toMatchObject({
      status: "captured",
      amountMicros: 10,
      capturedMicros: 4,
      releasedMicros: 6,
      expiresAt: admitted.expiresAt,
      actualMicros: "4",
    });
    expect(await f.billing.capture(capture)).toEqual(settled);
    expect(await f.billing.hold(hold)).toEqual(settled);
    expect(await f.billing.release("org_a", "run_1")).toEqual(settled);
    expect(await f.billing.wallet("org_a")).toMatchObject({
      settledMicros: 11,
      heldMicros: 0,
      availableMicros: 11,
    });
    await errorCode(
      f.billing.capture({ ...capture, actualMicros: "44999" }),
      "reference_conflict",
      409,
    );
    await errorCode(
      f.billing.hold({ ...hold, measurementFingerprint: "changed" }),
      "reference_conflict",
      409,
    );
  });

  test("capture above hold and wrong rounded amount leave the live hold intact", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10,
      consumptionClass: "purchased",
    });
    await f.billing.hold(hold);
    await errorCode(
      f.billing.capture({ ...capture, amountMicros: 11, actualMicros: "11" }),
      "capture_exceeds_hold",
      409,
    );
    await errorCode(
      f.billing.capture({ ...capture, amountMicros: 5 }),
      "measurement_conflict",
      409,
    );
    expect(await f.billing.readHold("org_a", "run_1")).toMatchObject({
      status: "live",
      capturedMicros: 0,
    });
    expect(await f.billing.wallet("org_a")).toMatchObject({ heldMicros: 10, availableMicros: 0 });
  });

  test("actual exceeding hold is capped and full actual remains in the receipt fingerprint", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10,
      consumptionClass: "purchased",
    });
    await f.billing.hold(hold);
    const fullActual = "9".repeat(256);
    expect(
      await f.billing.capture({ ...capture, amountMicros: 10, actualMicros: fullActual }),
    ).toMatchObject({ capturedMicros: 10, actualMicros: fullActual });
    await errorCode(
      f.billing.capture({
        ...capture,
        amountMicros: 10,
        actualMicros: `${"8"}${fullActual.slice(1)}`,
      }),
      "reference_conflict",
      409,
    );
  });

  test("zero capture is full release without a zero ledger capture and exact replay", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10,
      consumptionClass: "purchased",
    });
    await f.billing.hold(hold);
    const zero = { ...capture, amountMicros: 0, actualMicros: "0" };
    const result = await f.billing.capture(zero);
    expect(result).toMatchObject({ status: "released", capturedMicros: 0, releasedMicros: 10 });
    expect(await f.billing.capture(zero)).toEqual(result);
    expect((await f.sql.query("SELECT 1 FROM ledger WHERE type = 'capture'")).length).toBe(0);
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMicros: 10, heldMicros: 0 });
  });

  test("zero hold still has durable TTL and closes without ledger rows", async () => {
    const f = fixture();
    await f.billing.hold({ ...hold, amountMicros: 0 });
    expect(
      await f.billing.capture({ ...capture, amountMicros: 0, actualMicros: "0" }),
    ).toMatchObject({ status: "released", releasedMicros: 0 });
    expect((await f.sql.query("SELECT 1 FROM ledger")).length).toBe(0);
  });

  test("insufficient hold writes no lifecycle, can retry exact request after topup", async () => {
    const f = fixture();
    await errorCode(f.billing.hold(hold), "insufficient_funds", 402);
    expect((await f.sql.query("SELECT 1 FROM org_wallet_holds")).length).toBe(0);
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10,
      consumptionClass: "purchased",
    });
    expect(await f.billing.hold(hold)).toMatchObject({ status: "live" });
  });

  test("release before a delayed hold leaves a permanent tombstone", async () => {
    const f = fixture();
    const tombstone = await f.billing.release("org_a", "never-admitted");
    expect(tombstone).toMatchObject({ status: "released", amountMicros: 0, expiresAt: null });
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10,
      consumptionClass: "purchased",
    });
    await errorCode(
      f.billing.hold({ ...hold, reference: "never-admitted" }),
      "reference_conflict",
      409,
    );
    expect(await f.billing.release("org_a", "never-admitted")).toEqual(tombstone);
    expect(await f.billing.wallet("org_a")).toMatchObject({ heldMicros: 0, availableMicros: 10 });
  });

  test("deadline is exclusive and capture auto-releases without cron", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10,
      consumptionClass: "purchased",
    });
    await f.billing.hold(hold);
    f.setTime("2026-10-13T00:00:59.999Z");
    expect(await f.billing.readHold("org_a", "run_1")).toMatchObject({ status: "live" });
    f.setTime("2026-10-13T00:01:00.000Z");
    await errorCode(f.billing.capture(capture), "hold_closed", 409);
    expect(await f.billing.readHold("org_a", "run_1")).toMatchObject({
      status: "expired",
      releasedMicros: 10,
    });
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMicros: 10, heldMicros: 0 });
  });

  test("expired lot stays pinned until settlement and never revives on release", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "included",
      consumptionClass: "free",
      amountMicros: 10,
      kind: "plan-included",
      expiresAt: "2026-10-13T00:00:30.000Z",
    });
    await f.billing.hold(hold);
    f.setTime("2026-10-13T00:00:40.000Z");
    expect(await f.ledger.wallet("org_a")).toMatchObject({ settledMicros: 10, availableMicros: 0 });
    await f.billing.capture(capture);
    expect(await f.billing.wallet("org_a")).toMatchObject({
      settledMicros: 0,
      heldMicros: 0,
      availableMicros: 0,
    });
    expect((await f.billing.lots("org_a")).lots).toMatchObject([
      {
        reference: "included",
        spentMicros: 4,
        remainingMicros: 6,
        heldMicros: 0,
        availableMicros: 0,
      },
    ]);
  });

  test("consumes free before earlier-expiring subscription and purchased credit", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "purchased",
      consumptionClass: "purchased",
      amountMicros: 10,
      kind: "purchased",
    });
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "included",
      consumptionClass: "free",
      amountMicros: 10,
      kind: "plan-included",
      expiresAt: "2026-11-01T00:00:00.000Z",
    });
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "subscription",
      consumptionClass: "subscription",
      amountMicros: 10,
      kind: "plan-included",
      expiresAt: "2026-10-20T00:00:00.000Z",
    });
    await f.billing.hold(hold);
    expect(
      await f.sql.query("SELECT lot_ref FROM wallet_credit_allocations WHERE debit_type = 'hold'"),
    ).toEqual([{ lot_ref: "included" }]);
  });

  test("simultaneous reservations cannot allocate the same money twice", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10,
      consumptionClass: "purchased",
    });
    const results = await Promise.allSettled([
      f.billing.hold(hold),
      f.billing.hold({ ...hold, reference: "run_2" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(await f.billing.wallet("org_a")).toMatchObject({ heldMicros: 10, availableMicros: 0 });
    expect((await f.sql.query("SELECT 1 FROM wallet_allocation_guards")).length).toBe(0);
  });

  test("capture/release races have one terminal receipt and no extra debit", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10,
      consumptionClass: "purchased",
    });
    await f.billing.hold(hold);
    await Promise.allSettled([
      f.billing.capture(capture),
      f.billing.release("org_a", "run_1"),
      f.billing.capture(capture),
    ]);
    const terminal = await f.billing.readHold("org_a", "run_1");
    expect(terminal.capturedMicros + terminal.releasedMicros).toBe(10);
    expect(await f.billing.wallet("org_a")).toMatchObject({
      heldMicros: 0,
      availableMicros: 10 - terminal.capturedMicros,
    });
    expect((await f.sql.query("SELECT 1 FROM wallet_allocation_guards")).length).toBe(0);
  });

  test("two Organizations can use the same opaque reference independently", async () => {
    const f = fixture();
    for (const org of ["org_a", "org_b"])
      await f.ledger.fund({
        organizationId: org,
        fundingRef: "pay",
        amountMicros: 10,
        consumptionClass: "purchased",
      });
    await f.billing.hold(hold);
    await f.billing.hold({ ...hold, organizationId: "org_b" });
    await f.billing.capture(capture);
    expect(await f.billing.wallet("org_b")).toMatchObject({ heldMicros: 10, settledMicros: 10 });
  });

  test("interrupted closure batch rolls back allocation, ledger and state together", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10,
      consumptionClass: "purchased",
    });
    await f.billing.hold(hold);
    let failBatch = true;
    const sql: Sql = {
      query: (q, p) => f.sql.query(q, p),
      run: (q, p) => f.sql.run(q, p),
      batch: (statements) =>
        f.sql.batch(
          failBatch
            ? [
                ...statements,
                { sql: "INSERT INTO wallet_allocation_guards VALUES ('injected-failure', 0)" },
              ]
            : statements,
        ),
    };
    const billing = createOrgBilling({ sql, clock: f.clock, ledger: f.ledger, config: config() });
    await errorCode(billing.capture(capture), "billing_unavailable", 503);
    expect(await f.billing.readHold("org_a", "run_1")).toMatchObject({
      status: "live",
      capturedMicros: 0,
    });
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMicros: 0, heldMicros: 10 });
    failBatch = false;
    expect(await billing.capture(capture)).toMatchObject({ capturedMicros: 4, releasedMicros: 6 });
  });

  test("expired backlog is bounded and durable sweep resumes after restart", async () => {
    const f = fixture();
    for (let n = 0; n < 12; n++)
      await f.billing.hold({ ...hold, reference: `zero_${n}`, amountMicros: 0 });
    f.setTime("2026-10-13T00:01:00.000Z");
    await errorCode(f.billing.wallet("org_a"), "billing_maintenance_pending", 503);
    const restarted = createOrgBilling({
      sql: f.sql,
      clock: f.clock,
      ledger: f.ledger,
      config: config(),
    });
    expect(await restarted.expireDue(3)).toBe(3);
    expect(await restarted.expireDue(3)).toBe(1);
    expect(await restarted.wallet("org_a")).toMatchObject({ heldMicros: 0 });
  });

  test("the request sweep and its backlog check read one instant", async () => {
    // Staging ttl-c013: H1 was swept, then H2's deadline passed before the
    // backlog check, and a two-hold Organization was refused with 503.
    const f = fixture();
    const swept = sweepClock(f);
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    await f.billing.hold({ ...hold, reference: "h1", amountMinor: 4 });
    f.setTime("2026-10-13T00:00:00.500Z");
    await f.billing.hold({ ...hold, reference: "h2", amountMinor: 3 });
    f.setTime("2026-10-13T00:01:00.200Z");
    swept.advanceAfterSweep("2026-10-13T00:01:00.600Z");
    await swept.billing.wallet("org_a");
    const states = async () =>
      (await f.sql.query("SELECT ref, state FROM org_wallet_holds ORDER BY ref")).map(
        (row) => `${row.ref}:${row.state}`,
      );
    expect(await states()).toEqual(["h1:expired", "h2:live"]);
    expect(await f.billing.readHold("org_a", "h2")).toMatchObject({
      status: "expired",
      releasedMinor: 3,
    });
    expect(await f.billing.wallet("org_a")).toMatchObject({ heldMinor: 0, availableMinor: 10 });

    // A backlog that already exists at the request instant still refuses, and
    // a deadline equal to that instant is part of it.
    const g = fixture();
    const backlog = sweepClock(g);
    for (let n = 0; n < 8; n++)
      await g.billing.hold({ ...hold, reference: `zero_${n}`, amountMinor: 0 });
    g.setTime("2026-10-13T00:00:00.200Z");
    await g.billing.hold({ ...hold, reference: "zero_8", amountMinor: 0 });
    g.setTime("2026-10-13T00:01:00.200Z");
    backlog.advanceAfterSweep("2026-10-13T00:01:01.000Z");
    await errorCode(backlog.billing.wallet("org_a"), "billing_maintenance_pending", 503);
    expect(
      await g.sql.query(
        "SELECT state, COUNT(*) AS n FROM org_wallet_holds GROUP BY state ORDER BY state",
      ),
    ).toEqual([
      { state: "expired", n: 8 },
      { state: "live", n: 1 },
    ]);
  });

  test("a deadline passing mid-request is never captured or reported live", async () => {
    const f = fixture();
    const swept = sweepClock(f);
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    await f.billing.hold(hold);
    f.setTime("2026-10-13T00:00:59.999Z");
    swept.advanceAfterSweep("2026-10-13T00:01:00.000Z");
    await errorCode(swept.billing.capture(capture), "hold_closed", 409);
    expect(await f.billing.readHold("org_a", "run_1")).toMatchObject({
      status: "expired",
      capturedMinor: 0,
      releasedMinor: 10,
    });
    expect((await f.sql.query("SELECT 1 FROM ledger WHERE type = 'capture'")).length).toBe(0);
    expect(
      await f.sql.query("SELECT 1 FROM wallet_credit_allocations WHERE debit_type = 'capture'"),
    ).toEqual([]);

    // An exact replay or a release in the same window answers the expiry.
    await f.billing.hold({ ...hold, reference: "run_2" });
    f.setTime("2026-10-13T00:01:59.999Z");
    swept.advanceAfterSweep("2026-10-13T00:02:00.000Z");
    expect(await swept.billing.hold({ ...hold, reference: "run_2" })).toMatchObject({
      status: "expired",
      releasedMinor: 10,
    });
    await f.billing.hold({ ...hold, reference: "run_3" });
    f.setTime("2026-10-13T00:02:59.999Z");
    swept.advanceAfterSweep("2026-10-13T00:03:00.000Z");
    expect(await swept.billing.release("org_a", "run_3")).toMatchObject({
      status: "expired",
      releasedMinor: 10,
    });
    expect(await f.billing.wallet("org_a")).toMatchObject({
      settledMinor: 10,
      heldMinor: 0,
      availableMinor: 10,
    });
    expect((await f.sql.query("SELECT 1 FROM wallet_allocation_guards")).length).toBe(0);
  });
});

describe("monthly grants and frozen usage tariffs", () => {
  test("one UTC monthly lot across Organizations is frozen even after a price revision", async () => {
    const f = fixture(config({ freeIncludedMinor: 10 }));
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMicros: 100000 });
    const revised = createOrgBilling({
      sql: f.sql,
      clock: f.clock,
      ledger: f.ledger,
      config: config({
        revision: "r2",
        effectiveAt: "2026-10-13T00:00:00.000Z",
        freeIncludedMinor: 20,
      }),
    });
    expect(await revised.wallet("org_b")).toMatchObject({ availableMicros: 100000 });
    expect(await revised.wallet("org_a")).toMatchObject({ availableMicros: 100000 });
    f.setTime("2026-11-01T00:00:00.000Z");
    expect(await revised.wallet("org_a")).toMatchObject({ availableMicros: 200000 });
    expect((await revised.lots("org_a")).lots.map((l) => l.reference)).toEqual([
      "free:org_a:2026-10",
      "free:org_a:2026-11",
    ]);
  });

  test("zero allowance and mid-month first tariff pin eligibility without backfill", async () => {
    const f = fixture(config({ effectiveAt: "2026-10-13T00:00:00.000Z", freeIncludedMinor: 10 }));
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMicros: 0 });
    expect(await f.sql.query("SELECT amount_micros FROM org_wallet_grant_snapshots")).toEqual([
      { amount_micros: 0 },
    ]);
    expect((await f.sql.query("SELECT 1 FROM ledger")).length).toBe(0);
    f.setTime("2026-11-01T00:00:00.000Z");
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMicros: 100000 });
  });

  test("already-consumed usage persists pending then pays once after topup", async () => {
    const f = fixture();
    expect(await f.billing.usage(usage)).toMatchObject({
      status: "pending",
      amountMicros: 10000,
      quantityUnit: "byte-millisecond",
    });
    await errorCode(f.billing.hold({ ...hold, amountMicros: 0 }), "outstanding_usage", 409);
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 20000,
      consumptionClass: "purchased",
    });
    const result = await f.billing.usage(usage);
    expect(result).toMatchObject({ status: "paid", amountMicros: 10000 });
    expect(await f.billing.usage(usage)).toEqual(result);
    expect(await f.billing.wallet("org_a")).toMatchObject({
      availableMicros: 10000,
      heldMicros: 0,
    });
    await errorCode(
      f.billing.usage({ ...usage, quantity: "7200000", expectedMicros: 20000 }),
      "reference_conflict",
      409,
    );
  });

  test("storage integral byte-ms converts exactly and rounds once to whole micros", async () => {
    const f = fixture();
    expect(await f.billing.usage({ ...usage, quantity: "1", expectedMicros: 1 })).toMatchObject({
      status: "pending",
      amountMicros: 1,
    });
    expect((await f.sql.query("SELECT 1 FROM ledger")).length).toBe(0);
    expect(
      await f.billing.usage({
        ...usage,
        reference: "tie",
        quantity: "1800000",
        expectedMicros: 5000,
      }),
    ).toMatchObject({ amountMicros: 5000 });
    expect(
      await f.billing.usage({
        ...usage,
        reference: "above",
        quantity: "1800001",
        expectedMicros: 5001,
      }),
    ).toMatchObject({ amountMicros: 5001, status: "pending" });
    await errorCode(
      f.billing.usage({ ...usage, reference: "wrong-unit", quantityUnit: "byte-hour" }),
      "invalid_quantity",
      400,
    );
  });

  test("delayed closed usage uses retired original tariff after restart/config update", async () => {
    const f = fixture();
    await assertOrgBillingSchema(f.sql, config());
    const updated = createOrgBilling({
      sql: f.sql,
      clock: f.clock,
      ledger: f.ledger,
      config: config({
        revision: "r2",
        effectiveAt: "2026-10-13T00:00:00.000Z",
        meters: {
          "takosumi.storage.byte-hours": {
            unit: "byte-hour",
            rate: { numeratorMicros: "20000", denominator: "1" },
          },
        },
      }),
    });
    expect(await updated.usage(usage)).toMatchObject({
      status: "pending",
      pricingRevision: "r1",
      amountMicros: 10000,
      rate: { numeratorMicros: "10000" },
    });
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 10000,
      consumptionClass: "purchased",
    });
    expect(await updated.usage(usage)).toMatchObject({ status: "paid", amountMicros: 10000 });
    await errorCode(
      updated.usage({
        ...usage,
        reference: "cross",
        periodStart: "2026-10-12T23:00:00.000Z",
        periodEnd: "2026-10-13T01:00:00.000Z",
      }),
      "invalid_usage_period",
      400,
    );
  });

  test("config history supports delayed first measurement and rejects tariff crossing", async () => {
    const old = config();
    const f = fixture(
      config({ revision: "r2", effectiveAt: "2026-10-13T00:00:00.000Z", history: [old] }),
    );
    expect(await f.billing.usage(usage)).toMatchObject({
      pricingRevision: "r1",
      amountMicros: 10000,
    });
    f.setTime("2026-10-13T02:00:00.000Z");
    await errorCode(
      f.billing.usage({
        ...usage,
        reference: "cross",
        periodStart: "2026-10-12T23:00:00.000Z",
        periodEnd: "2026-10-13T01:00:00.000Z",
      }),
      "usage_period_crosses_tariff",
      409,
    );
  });

  test("final run/meter rounding ties-even and safe decimal quantities", async () => {
    const f = fixture();
    const input = {
      ...usage,
      meter: "requests",
      quantity: "3",
      quantityUnit: "request",
      expectedMicros: 15000,
    };
    expect(await f.billing.usage(input)).toMatchObject({ amountMicros: 15000 });
    expect(
      await f.billing.usage({
        ...input,
        reference: "fraction",
        quantity: "1.5",
        expectedMicros: 7500,
      }),
    ).toMatchObject({ amountMicros: 7500 });
    await errorCode(
      f.billing.usage({ ...input, reference: "wrong", quantity: "1.0" }),
      "invalid_quantity",
      400,
    );
    await errorCode(
      f.billing.usage({ ...input, reference: "wrong-price", expectedMicros: 1 }),
      "measurement_conflict",
      409,
    );
  });

  test("same tariff revision cannot be overwritten or change its effective date", async () => {
    const f = fixture();
    await assertOrgBillingSchema(f.sql, config());
    await errorCode(
      assertOrgBillingSchema(f.sql, config({ freeIncludedMinor: 100 })),
      "pricing_revision_conflict",
      503,
    );
  });

  test("same paid usage concurrent retries debit once", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "pay",
      amountMicros: 20000,
      consumptionClass: "purchased",
    });
    const receipts = await Promise.all([f.billing.usage(usage), f.billing.usage(usage)]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMicros: 10000 });
    expect((await f.sql.query("SELECT 1 FROM ledger WHERE type = 'usage_debit'")).length).toBe(1);
  });
});

test("historical cents receipts remain readable and reject new micros mutations", async () => {
  const f = fixture();
  await f.sql.run("DROP TRIGGER org_wallet_holds_new_money_policy");
  await f.sql.run("DROP TRIGGER org_wallet_usage_records_new_money_policy");
  await f.sql.run(
    `INSERT INTO org_wallet_holds
      (org_id, ref, ledger_ref, amount_micros, fingerprint, pricing_revision, created_at,
       expires_at, state, captured_micros, released_micros, actual_micros, closed_at, money_policy)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'released', 0, ?, NULL, ?, 'usd-cents-v1')`,
    [
      "org_a",
      "legacy-hold",
      "org-hold:legacy-hold",
      10000,
      "legacy-fingerprint",
      "r1",
      "2026-10-12T00:00:00.000Z",
      10000,
      "2026-10-12T00:00:01.000Z",
    ],
  );
  await f.sql.run(
    `INSERT INTO org_wallet_usage_records
      (org_id, ref, fingerprint, pricing_revision, meter, quantity, quantity_unit,
       period_start, period_end, rate_numerator_micros, rate_denominator, amount_micros,
       state, created_at, paid_at, money_policy)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?, ?, 'usd-cents-v1')`,
    [
      "org_a",
      "legacy-usage",
      "legacy-fingerprint",
      "r1",
      "requests",
      "1",
      "request",
      "2026-10-11T00:00:00.000Z",
      "2026-10-11T01:00:00.000Z",
      "10000",
      "1",
      10000,
      "2026-10-12T00:00:00.000Z",
      "2026-10-12T00:00:01.000Z",
    ],
  );
  expect(await f.billing.readHold("org_a", "legacy-hold")).toMatchObject({
    moneyPolicy: "usd-cents-v1",
    amountMicros: 10000,
    status: "released",
  });
  await errorCode(
    f.billing.capture({ ...capture, reference: "legacy-hold", amountMicros: 0, actualMicros: "0" }),
    "reference_conflict",
    409,
  );
  await errorCode(f.billing.release("org_a", "legacy-hold"), "reference_conflict", 409);
  const oldUsage = await f.billing.listUsage("org_a");
  expect(oldUsage.usageRecords[0]).toMatchObject({
    reference: "legacy-usage",
    moneyPolicy: "usd-cents-v1",
    amountMicros: 10000,
  });
  await errorCode(
    f.billing.usage({ ...usage, reference: "legacy-usage", expectedMicros: 0 }),
    "reference_conflict",
    409,
  );
});

test("usage cursor includes equal timestamps once and never crosses Organizations", async () => {
  const f = fixture();
  for (const reference of ["a", "b", "c"])
    await f.billing.usage({ ...usage, reference, quantity: "0", expectedMicros: 0 });
  await f.billing.usage({
    ...usage,
    organizationId: "org_b",
    reference: "z",
    quantity: "0",
    expectedMicros: 0,
  });
  const first = await f.billing.listUsage("org_a", 2);
  expect(first.usageRecords.map((r) => r.reference)).toEqual(["c", "b"]);
  expect(first.cursor).not.toBeNull();
  const next = await f.billing.listUsage("org_a", 2, first.cursor ?? undefined);
  expect(next.usageRecords.map((r) => r.reference)).toEqual(["a"]);
  expect(next.cursor).toBeNull();
  await errorCode(f.billing.listUsage("org_a", 101), "invalid_limit", 400);
  await errorCode(f.billing.listUsage("org_a", 2, "invalid==="), "invalid_cursor", 400);
});

test("canonical dates cannot misclassify an extended-year future period as closed", async () => {
  const f = fixture();
  await errorCode(
    f.billing.usage({ ...usage, periodEnd: "+010000-01-01T00:00:00.000Z" }),
    "invalid_usage_period",
    400,
  );
});

test("lost write acknowledgement reads committed hold/capture/usage receipts without double debit", async () => {
  const f = fixture();
  await f.ledger.fund({
    organizationId: "org_a",
    fundingRef: "pay",
    amountMicros: 10020,
    consumptionClass: "purchased",
  });
  const sql: Sql = {
    query: (query, params) => f.sql.query(query, params),
    run: (query, params) => f.sql.run(query, params),
    async batch(statements) {
      await f.sql.batch(statements);
      throw new SqlError("unavailable", "fixture acknowledgement lost after commit");
    },
  };
  const billing = createOrgBilling({ sql, clock: f.clock, ledger: f.ledger, config: config() });
  expect(await billing.hold(hold)).toMatchObject({ status: "live" });
  const receipt = await billing.capture(capture);
  expect(await billing.capture(capture)).toEqual(receipt);
  const paid = await billing.usage(usage);
  expect(paid).toMatchObject({ status: "paid" });
  expect(await billing.usage(usage)).toEqual(paid);
  expect(await f.ledger.wallet("org_a")).toMatchObject({ availableMicros: 16, heldMicros: 0 });
});

test("new tariff cannot backdate and reprice an already consumed period", async () => {
  const f = fixture();
  await assertOrgBillingSchema(f.sql, config(), f.clock);
  const retroactive = config({ revision: "r2", effectiveAt: "2026-10-10T00:00:00.000Z" });
  await errorCode(
    assertOrgBillingSchema(f.sql, retroactive, f.clock),
    "pricing_revision_backdated",
    503,
  );
  expect(
    (await f.sql.query("SELECT revision FROM org_wallet_pricing_revisions")).map((r) => r.revision),
  ).toEqual(["r1"]);
  expect(await f.billing.usage(usage)).toMatchObject({
    pricingRevision: "r1",
    amountMicros: 10000,
  });
});

test("byte-hour pricing follows the configured unit without a customer product meter name", async () => {
  const f = fixture(
    config({
      meters: {
        "operator.storage": {
          unit: "byte-hour",
          rate: { numeratorMicros: "10000", denominator: "1" },
        },
      },
    }),
  );
  await f.ledger.fund({
    organizationId: "org_a",
    fundingRef: "unit-test",
    amountMicros: 10000,
    consumptionClass: "purchased",
  });
  const input = { ...usage, meter: "operator.storage" };
  expect(await f.billing.usage(input)).toMatchObject({ amountMicros: 10000, status: "paid" });
  await errorCode(
    f.billing.usage({
      ...input,
      reference: "decimal-integral",
      quantity: "1.5",
      expectedMicros: 0,
    }),
    "invalid_quantity",
    400,
  );
  await errorCode(
    f.billing.usage({
      ...input,
      reference: "wrong-unit",
      quantityUnit: "byte-hour",
      quantity: "1",
    }),
    "invalid_quantity",
    400,
  );
});

test("lot cursor bounds expiry-ordered pages with tied timestamps and opaque legacy refs", async () => {
  const f = fixture();
  const refs = [`legacy/${"x".repeat(2000)}`, "b", "c", "purchased"] as const;
  for (const fundingRef of refs.slice(1))
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef,
      amountMicros: 10,
      ...(fundingRef === "purchased"
        ? { kind: "purchased" as const, consumptionClass: "purchased" as const }
        : {
            kind: "plan-included" as const,
            consumptionClass: "free" as const,
            expiresAt: "2026-10-14T00:00:00.000Z",
          }),
    });
  await f.sql.run(
    `INSERT INTO wallet_credit_lots
      (org_id, ref, kind, consumption_class, amount_micros, expires_at, created_at)
     VALUES (?, ?, 'plan-included', 'free', 10, ?, ?)`,
    ["org_a", refs[0], "2026-10-14T00:00:00.000Z", "2026-10-13T00:00:00.000Z"],
  );
  await f.ledger.fund({
    organizationId: "org_other",
    fundingRef: "other",
    amountMicros: 10,
    consumptionClass: "purchased",
  });
  const first = await f.billing.lots("org_a", 2);
  expect(first.lots.map((l) => l.reference)).toEqual(["b", "c"]);
  expect(first.cursor).not.toBeNull();
  const second = await f.billing.lots("org_a", 2, first.cursor ?? undefined);
  expect(second.lots.map((l) => l.reference)).toEqual([refs[0], "purchased"]);
  expect(second.cursor).toBeNull();
  const legacy = await f.billing.lots("org_a", 1, first.cursor ?? undefined);
  expect(legacy.lots[0]?.reference).toBe(refs[0]);
  expect(legacy.cursor).toMatch(/^[a-f0-9]{32}$/u);
  expect((await f.billing.lots("org_a", 1, legacy.cursor ?? undefined)).lots[0]?.reference).toBe(
    "purchased",
  );
  await errorCode(f.billing.lots("org_other", 2, first.cursor ?? undefined), "invalid_cursor", 400);
  await errorCode(f.billing.lots("org_a", 101), "invalid_limit", 400);
  await errorCode(f.billing.lots("org_a", 1, "bad"), "invalid_cursor", 400);
  await errorCode(f.billing.lots("org_a", 1, "f".repeat(32)), "invalid_cursor", 400);
  const handles = await f.sql.query("SELECT cursor_handle FROM wallet_credit_lots");
  expect(new Set(handles.map((row) => row.cursor_handle)).size).toBe(5);
  expect(
    handles.every(
      (row) => typeof row.cursor_handle === "string" && /^[a-f0-9]{32}$/u.test(row.cursor_handle),
    ),
  ).toBe(true);
});

test("billing startup refuses missing lot cursor migration objects", async () => {
  const f = fixture();
  await assertOrgBillingSchema(f.sql);
  await f.sql.run("DROP TRIGGER wallet_credit_lots_cursor_insert");
  await errorCode(assertOrgBillingSchema(f.sql), "billing_schema_not_ready", 503);
});

test("billing startup refuses the cents schema before writing tariffs", async () => {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS.filter((migration) => migration.name < "0094"))
    database.exec(migration.sql);
  const sql = createSqliteSql(database);
  await errorCode(assertOrgBillingSchema(sql, config()), "billing_schema_not_ready", 503);
  expect(await sql.query("SELECT * FROM org_wallet_pricing_revisions")).toEqual([]);
  expect(await sql.query("SELECT * FROM org_wallet_monthly_tariffs")).toEqual([]);
  database.close();
});
