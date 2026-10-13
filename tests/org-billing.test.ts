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
const hold = {
  organizationId: "org_a",
  reference: "run_1",
  amountMinor: 10,
  pricingRevision: "r1",
  measurementFingerprint: "estimate-v1",
};
const capture = {
  organizationId: "org_a",
  reference: "run_1",
  amountMinor: 4,
  actualMicros: "40000",
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
  expectedMinor: 1,
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
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 15 });
    const admitted = await f.billing.hold(hold);
    const settled = await f.billing.capture(capture);
    expect(settled).toMatchObject({
      status: "captured",
      amountMinor: 10,
      capturedMinor: 4,
      releasedMinor: 6,
      expiresAt: admitted.expiresAt,
      actualMicros: "40000",
    });
    expect(await f.billing.capture(capture)).toEqual(settled);
    expect(await f.billing.hold(hold)).toEqual(settled);
    expect(await f.billing.release("org_a", "run_1")).toEqual(settled);
    expect(await f.billing.wallet("org_a")).toMatchObject({
      settledMinor: 11,
      heldMinor: 0,
      availableMinor: 11,
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
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    await f.billing.hold(hold);
    await errorCode(
      f.billing.capture({ ...capture, amountMinor: 11, actualMicros: "110000" }),
      "capture_exceeds_hold",
      409,
    );
    await errorCode(f.billing.capture({ ...capture, amountMinor: 5 }), "measurement_conflict", 409);
    expect(await f.billing.readHold("org_a", "run_1")).toMatchObject({
      status: "live",
      capturedMinor: 0,
    });
    expect(await f.billing.wallet("org_a")).toMatchObject({ heldMinor: 10, availableMinor: 0 });
  });

  test("actual exceeding hold is capped and full actual remains in the receipt fingerprint", async () => {
    const f = fixture();
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    await f.billing.hold(hold);
    expect(
      await f.billing.capture({ ...capture, amountMinor: 10, actualMicros: "1000000" }),
    ).toMatchObject({ capturedMinor: 10, actualMicros: "1000000" });
    await errorCode(
      f.billing.capture({ ...capture, amountMinor: 10, actualMicros: "1000001" }),
      "reference_conflict",
      409,
    );
  });

  test("zero capture is full release without a zero ledger capture and exact replay", async () => {
    const f = fixture();
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    await f.billing.hold(hold);
    const zero = { ...capture, amountMinor: 0, actualMicros: "5000" };
    const result = await f.billing.capture(zero);
    expect(result).toMatchObject({ status: "released", capturedMinor: 0, releasedMinor: 10 });
    expect(await f.billing.capture(zero)).toEqual(result);
    expect((await f.sql.query("SELECT 1 FROM ledger WHERE type = 'capture'")).length).toBe(0);
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMinor: 10, heldMinor: 0 });
  });

  test("zero hold still has durable TTL and closes without ledger rows", async () => {
    const f = fixture();
    await f.billing.hold({ ...hold, amountMinor: 0 });
    expect(
      await f.billing.capture({ ...capture, amountMinor: 0, actualMicros: "0" }),
    ).toMatchObject({ status: "released", releasedMinor: 0 });
    expect((await f.sql.query("SELECT 1 FROM ledger")).length).toBe(0);
  });

  test("insufficient hold writes no lifecycle, can retry exact request after topup", async () => {
    const f = fixture();
    await errorCode(f.billing.hold(hold), "insufficient_funds", 402);
    expect((await f.sql.query("SELECT 1 FROM org_wallet_holds")).length).toBe(0);
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    expect(await f.billing.hold(hold)).toMatchObject({ status: "live" });
  });

  test("release before a delayed hold leaves a permanent tombstone", async () => {
    const f = fixture();
    const tombstone = await f.billing.release("org_a", "never-admitted");
    expect(tombstone).toMatchObject({ status: "released", amountMinor: 0, expiresAt: null });
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    await errorCode(
      f.billing.hold({ ...hold, reference: "never-admitted" }),
      "reference_conflict",
      409,
    );
    expect(await f.billing.release("org_a", "never-admitted")).toEqual(tombstone);
    expect(await f.billing.wallet("org_a")).toMatchObject({ heldMinor: 0, availableMinor: 10 });
  });

  test("deadline is exclusive and capture auto-releases without cron", async () => {
    const f = fixture();
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    await f.billing.hold(hold);
    f.setTime("2026-10-13T00:00:59.999Z");
    expect(await f.billing.readHold("org_a", "run_1")).toMatchObject({ status: "live" });
    f.setTime("2026-10-13T00:01:00.000Z");
    await errorCode(f.billing.capture(capture), "hold_closed", 409);
    expect(await f.billing.readHold("org_a", "run_1")).toMatchObject({
      status: "expired",
      releasedMinor: 10,
    });
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMinor: 10, heldMinor: 0 });
  });

  test("expired lot stays pinned until settlement and never revives on release", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "included",
      amountMinor: 10,
      kind: "plan-included",
      expiresAt: "2026-10-13T00:00:30.000Z",
    });
    await f.billing.hold(hold);
    f.setTime("2026-10-13T00:00:40.000Z");
    expect(await f.ledger.wallet("org_a")).toMatchObject({ settledMinor: 10, availableMinor: 0 });
    await f.billing.capture(capture);
    expect(await f.billing.wallet("org_a")).toMatchObject({
      settledMinor: 0,
      heldMinor: 0,
      availableMinor: 0,
    });
    expect(await f.billing.lots("org_a")).toMatchObject([
      { reference: "included", spentMinor: 4, remainingMinor: 6, heldMinor: 0, availableMinor: 0 },
    ]);
  });

  test("uses nearer expiry first and nonexpiring purchased credit last", async () => {
    const f = fixture();
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "purchased",
      amountMinor: 10,
      kind: "purchased",
    });
    await f.ledger.fund({
      organizationId: "org_a",
      fundingRef: "included",
      amountMinor: 10,
      kind: "plan-included",
      expiresAt: "2026-11-01T00:00:00.000Z",
    });
    await f.billing.hold(hold);
    expect(
      await f.sql.query("SELECT lot_ref FROM wallet_credit_allocations WHERE debit_type = 'hold'"),
    ).toEqual([{ lot_ref: "included" }]);
  });

  test("simultaneous reservations cannot allocate the same money twice", async () => {
    const f = fixture();
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    const results = await Promise.allSettled([
      f.billing.hold(hold),
      f.billing.hold({ ...hold, reference: "run_2" }),
    ]);
    expect(results.filter((x) => x.status === "fulfilled").length).toBe(1);
    expect(await f.billing.wallet("org_a")).toMatchObject({ heldMinor: 10, availableMinor: 0 });
    expect((await f.sql.query("SELECT 1 FROM wallet_allocation_guards")).length).toBe(0);
  });

  test("capture/release races have one terminal receipt and no extra debit", async () => {
    const f = fixture();
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
    await f.billing.hold(hold);
    await Promise.allSettled([
      f.billing.capture(capture),
      f.billing.release("org_a", "run_1"),
      f.billing.capture(capture),
    ]);
    const terminal = await f.billing.readHold("org_a", "run_1");
    expect(terminal.capturedMinor + terminal.releasedMinor).toBe(10);
    expect(await f.billing.wallet("org_a")).toMatchObject({
      heldMinor: 0,
      availableMinor: 10 - terminal.capturedMinor,
    });
    expect((await f.sql.query("SELECT 1 FROM wallet_allocation_guards")).length).toBe(0);
  });

  test("two Organizations can use the same opaque reference independently", async () => {
    const f = fixture();
    for (const org of ["org_a", "org_b"])
      await f.ledger.fund({ organizationId: org, fundingRef: "pay", amountMinor: 10 });
    await f.billing.hold(hold);
    await f.billing.hold({ ...hold, organizationId: "org_b" });
    await f.billing.capture(capture);
    expect(await f.billing.wallet("org_b")).toMatchObject({ heldMinor: 10, settledMinor: 10 });
  });

  test("interrupted closure batch rolls back allocation, ledger and state together", async () => {
    const f = fixture();
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 10 });
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
      capturedMinor: 0,
    });
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMinor: 0, heldMinor: 10 });
    failBatch = false;
    expect(await billing.capture(capture)).toMatchObject({ capturedMinor: 4, releasedMinor: 6 });
  });

  test("expired backlog is bounded and durable sweep resumes after restart", async () => {
    const f = fixture();
    for (let n = 0; n < 12; n++)
      await f.billing.hold({ ...hold, reference: `zero_${n}`, amountMinor: 0 });
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
    expect(await restarted.wallet("org_a")).toMatchObject({ heldMinor: 0 });
  });
});

describe("monthly grants and frozen usage tariffs", () => {
  test("one UTC monthly lot across Organizations is frozen even after a price revision", async () => {
    const f = fixture(config({ freeIncludedMinor: 10 }));
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMinor: 10 });
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
    expect(await revised.wallet("org_b")).toMatchObject({ availableMinor: 10 });
    expect(await revised.wallet("org_a")).toMatchObject({ availableMinor: 10 });
    f.setTime("2026-11-01T00:00:00.000Z");
    expect(await revised.wallet("org_a")).toMatchObject({ availableMinor: 20 });
    expect((await revised.lots("org_a")).map((l) => l.reference)).toEqual([
      "free:org_a:2026-10",
      "free:org_a:2026-11",
    ]);
  });

  test("zero allowance and mid-month first tariff pin eligibility without backfill", async () => {
    const f = fixture(config({ effectiveAt: "2026-10-13T00:00:00.000Z", freeIncludedMinor: 10 }));
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMinor: 0 });
    expect(await f.sql.query("SELECT amount_minor FROM org_wallet_grant_snapshots")).toEqual([
      { amount_minor: 0 },
    ]);
    expect((await f.sql.query("SELECT 1 FROM ledger")).length).toBe(0);
    f.setTime("2026-11-01T00:00:00.000Z");
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMinor: 10 });
  });

  test("already-consumed usage persists pending then pays once after topup", async () => {
    const f = fixture();
    expect(await f.billing.usage(usage)).toMatchObject({
      status: "pending",
      amountMinor: 1,
      quantityUnit: "byte-millisecond",
    });
    await errorCode(f.billing.hold({ ...hold, amountMinor: 0 }), "outstanding_usage", 409);
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 2 });
    const result = await f.billing.usage(usage);
    expect(result).toMatchObject({ status: "paid", amountMinor: 1 });
    expect(await f.billing.usage(usage)).toEqual(result);
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMinor: 1, heldMinor: 0 });
    await errorCode(
      f.billing.usage({ ...usage, quantity: "7200000", expectedMinor: 2 }),
      "reference_conflict",
      409,
    );
  });

  test("storage integral byte-ms converts exactly and rounds once at cents", async () => {
    const f = fixture();
    expect(await f.billing.usage({ ...usage, quantity: "1", expectedMinor: 0 })).toMatchObject({
      status: "paid",
      amountMinor: 0,
    });
    expect((await f.sql.query("SELECT 1 FROM ledger")).length).toBe(0);
    expect(
      await f.billing.usage({ ...usage, reference: "tie", quantity: "1800000", expectedMinor: 0 }),
    ).toMatchObject({ amountMinor: 0 });
    expect(
      await f.billing.usage({
        ...usage,
        reference: "above",
        quantity: "1800001",
        expectedMinor: 1,
      }),
    ).toMatchObject({ amountMinor: 1, status: "pending" });
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
      amountMinor: 1,
      rate: { numeratorMicros: "10000" },
    });
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 1 });
    expect(await updated.usage(usage)).toMatchObject({ status: "paid", amountMinor: 1 });
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
    expect(await f.billing.usage(usage)).toMatchObject({ pricingRevision: "r1", amountMinor: 1 });
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
      expectedMinor: 2,
    };
    expect(await f.billing.usage(input)).toMatchObject({ amountMinor: 2 });
    expect(
      await f.billing.usage({ ...input, reference: "fraction", quantity: "1.5", expectedMinor: 1 }),
    ).toMatchObject({ amountMinor: 1 });
    await errorCode(
      f.billing.usage({ ...input, reference: "wrong", quantity: "1.0" }),
      "invalid_quantity",
      400,
    );
    await errorCode(
      f.billing.usage({ ...input, reference: "wrong-price", expectedMinor: 1 }),
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
    await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 2 });
    const receipts = await Promise.all([f.billing.usage(usage), f.billing.usage(usage)]);
    expect(receipts[0]).toEqual(receipts[1]);
    expect(await f.billing.wallet("org_a")).toMatchObject({ availableMinor: 1 });
    expect((await f.sql.query("SELECT 1 FROM ledger WHERE type = 'usage_debit'")).length).toBe(1);
  });
});

test("funded 0091 history migrates forward without rewriting wallet money", async () => {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS.filter((m) => m.name < "0092")) database.exec(migration.sql);
  const sql = createSqliteSql(database);
  const clock = () => new Date("2026-10-13T00:00:00.000Z");
  const ledger = createLedger(sql, clock);
  await ledger.fund({
    organizationId: "org_a",
    fundingRef: "old-purchase",
    kind: "purchased",
    amountMinor: 100,
  });
  await ledger.hold({ organizationId: "org_a", reference: "legacy-hold", amountMinor: 30 });
  const before = await ledger.wallet("org_a");
  const migration = MIGRATIONS.find((m) => m.name.startsWith("0092"));
  if (!migration) throw new Error("missing 0092");
  database.exec(migration.sql);
  await assertOrgBillingSchema(sql, config());
  expect(await ledger.wallet("org_a")).toEqual(before);
  expect(await sql.query("SELECT amount_minor FROM wallet_credit_lots")).toEqual([
    { amount_minor: 100 },
  ]);
  const billing = createOrgBilling({ sql, clock, ledger, config: config() });
  await billing.hold({ ...hold, amountMinor: 10 });
  await billing.capture(capture);
  expect(await ledger.wallet("org_a")).toMatchObject({
    availableMinor: 66,
    heldMinor: 30,
    settledMinor: 96,
  });
  database.close();
});

test("usage cursor includes equal timestamps once and never crosses Organizations", async () => {
  const f = fixture();
  for (const reference of ["a", "b", "c"])
    await f.billing.usage({ ...usage, reference, quantity: "0", expectedMinor: 0 });
  await f.billing.usage({
    ...usage,
    organizationId: "org_b",
    reference: "z",
    quantity: "0",
    expectedMinor: 0,
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
  await f.ledger.fund({ organizationId: "org_a", fundingRef: "pay", amountMinor: 20 });
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
  expect(await f.ledger.wallet("org_a")).toMatchObject({ availableMinor: 15, heldMinor: 0 });
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
  expect(await f.billing.usage(usage)).toMatchObject({ pricingRevision: "r1", amountMinor: 1 });
});
