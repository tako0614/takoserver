import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { parseBillingConfig } from "../src/billing-config.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createLedger, stripeRefundSource, type UsageWarningPreparer } from "../src/ledger.ts";
import { createMetering } from "../src/metering.ts";
import { createOrgBilling } from "../src/org-billing.ts";
import { createOrgLimitPolicy } from "../src/org-limit-policy.ts";
import { orgUsageSummaryReadStatement } from "../src/org-usage-summary.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";

const ORG = "hosted_meter_org";
const NOW = "2026-10-15T00:00:00.000Z";
const clock = () => new Date(NOW);
const usage = (requestId: string) => ({
  requestId,
  organizationId: ORG,
  resourceUid: "resource",
  operation: "get",
  bytes: 0,
});
const command = (onLimit: "stop" | "prepaid", reference: string = onLimit) => ({
  organizationId: ORG,
  authorizedPrincipal: "session:owner",
  reference,
  onLimit,
});

function schemas(): readonly string[] {
  const draft = process.env.TAKOSERVER_BILLING_EXTENSION_TEST_SCHEMA;
  return [...MIGRATIONS.map(({ sql }) => sql), ...(draft ? [readFileSync(draft, "utf8")] : [])];
}

function services(sql: Sql) {
  const policy = createOrgLimitPolicy({ sql, clock });
  const allocationAdmissionResolver = policy.prepareAdmission.bind(policy);
  const ledger = createLedger(sql, clock, {
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver,
  });
  let id = 0;
  const metering = createMetering({
    sql,
    ledger,
    clock,
    randomId: () => `hosted_${++id}`,
    rates: { requestsMinorPerThousand: 1 },
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver,
  });
  return { sql, policy, ledger, metering, allocationAdmissionResolver };
}

function fixture() {
  const database = new Database(":memory:");
  for (const schema of schemas()) database.exec(schema);
  return { database, ...services(createSqliteSql(database)) };
}

async function purchase(sql: Sql, amountMicros = 100) {
  await createLedger(sql, clock).fund({
    organizationId: ORG,
    fundingRef: "purchase",
    kind: "purchased",
    consumptionClass: "purchased",
    amountMicros,
  });
}

async function included(sql: Sql, amountMicros: number) {
  await createLedger(sql, clock).fund({
    organizationId: ORG,
    fundingRef: "free",
    kind: "plan-included",
    consumptionClass: "free",
    amountMicros,
  });
}

describe("Hosted composition closes bare ledger and metering writers", () => {
  test("the instance resolver applies to every new bare hold/debit and preserves historical settlement", async () => {
    const f = fixture();
    try {
      await exerciseBareLedger(f.sql);
    } finally {
      f.database.close();
    }
  });

  test("a stop measurement never acquires purchased consent from a later prepaid policy", async () => {
    const f = fixture();
    try {
      await purchase(f.sql);
      await f.metering.record(usage("original-stop"));
      const original = (await f.sql.query("SELECT admission_policy_json FROM usage_events"))[0]
        ?.admission_policy_json;
      expect(JSON.parse(String(original))).toMatchObject({
        onLimit: "stop",
        policyVersion: 0,
        allowPurchasedCredit: false,
      });
      await expect(f.metering.rollUp(100)).rejects.toMatchObject({ code: "insufficient_funds" });
      await f.policy.change(command("prepaid"));
      await f.metering.record(usage("original-stop"));
      expect(
        (await f.sql.query("SELECT admission_policy_json FROM usage_events"))[0]
          ?.admission_policy_json,
      ).toBe(original);
      await expect(f.metering.rollUp(100)).rejects.toMatchObject({ code: "insufficient_funds" });
      expect(await f.sql.query("SELECT rollup_id FROM usage_events")).toEqual([
        { rollup_id: null },
      ]);
      await expect(
        f.sql.run("UPDATE usage_events SET admission_policy_json = '{}' WHERE request_id = ?", [
          "original-stop",
        ]),
      ).rejects.toMatchObject({ code: "constraint" });
      await included(f.sql, 10);
      expect(await f.metering.rollUp(100)).toBe(1);
      expect(
        await f.sql.query("SELECT lot_ref, amount_micros FROM wallet_credit_allocations"),
      ).toEqual([{ lot_ref: "free", amount_micros: 10 }]);
    } finally {
      f.database.close();
    }
  });

  test("consented measurements settle after stop; concurrent rolls claim once and zero-cost AI never adds a debit", async () => {
    const f = fixture();
    try {
      await exerciseFrozenRollup(f.sql);
    } finally {
      f.database.close();
    }
  });

  test("historical NULL measurement witnesses stay included-only even under current prepaid", async () => {
    const f = fixture();
    try {
      const legacy = createMetering({
        sql: f.sql,
        ledger: f.ledger,
        clock,
        randomId: () => "legacy",
        rates: { requestsMinorPerThousand: 1 },
      });
      await legacy.record(usage("historical"));
      await purchase(f.sql);
      await f.policy.change(command("prepaid"));
      await expect(f.metering.rollUp(100)).rejects.toMatchObject({ code: "insufficient_funds" });
      expect(
        await f.sql.query("SELECT admission_policy_json, rollup_id FROM usage_events"),
      ).toEqual([{ admission_policy_json: null, rollup_id: null }]);
      await included(f.sql, 10);
      expect(await f.metering.rollUp(100)).toBe(1);
      expect(await f.sql.query("SELECT lot_ref FROM wallet_credit_allocations")).toEqual([
        { lot_ref: "free" },
      ]);
    } finally {
      f.database.close();
    }
  });

  test("mixed provider-window decisions retain a single exact aggregate ceiling and their conservative eligibility", async () => {
    const f = fixture();
    try {
      const window = (deploymentId: string) => ({
        organizationId: ORG,
        resourceUid: "resource",
        deploymentId,
        meterSourceId: "source",
        from: "2026-10-14T00:00:00.000Z",
        until: NOW,
        priced: {
          amountUnit: "usd-micros-v2" as const,
          amountMicros: 1,
          lines: [
            {
              meter: "worker.requests",
              quantity: 1,
              amountMicros: 0,
              amountNumeratorMicros: "1",
              amountDenominator: "10",
            },
          ],
        },
      });
      await purchase(f.sql);
      await f.metering.recordProviderWindow(window("stop"));
      await f.policy.change(command("prepaid"));
      await f.metering.recordProviderWindow(window("prepaid"));
      await f.metering.recordProviderWindow(window("stop"));
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM usage_events")).toEqual([{ n: 2 }]);
      await expect(f.metering.rollUp(100)).rejects.toMatchObject({ code: "insufficient_funds" });
      await included(f.sql, 1);
      expect(await f.metering.rollUp(100)).toBe(2);
      expect(
        await f.sql.query("SELECT settled_delta_micros FROM ledger WHERE type = 'usage_debit'"),
      ).toEqual([{ settled_delta_micros: -1 }]);
      expect(
        await f.sql.query("SELECT lot_ref, amount_micros FROM wallet_credit_allocations"),
      ).toEqual([{ lot_ref: "free", amount_micros: 1 }]);
    } finally {
      f.database.close();
    }
  });

  test("recording a measurement and new bare hold both fail atomically if their policy snapshot races", async () => {
    const f = fixture();
    try {
      await exercisePolicyRace(f.sql);
    } finally {
      f.database.close();
    }
  });

  test("Hosted metering preserves paid-Free exclusion and never spends unproven direct-origin credit", async () => {
    const f = fixture();
    try {
      await included(f.sql, 100);
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "unknown",
        kind: "direct",
        consumptionClass: "purchased",
        amountMicros: 100,
      });
      await createStripeBillingStore({ sql: f.sql, clock }).grant({
        organizationId: ORG,
        fundingRef: "stripe:invoice:in_meter",
        kind: "plan-included",
        amountMicros: 5,
        expiresAt: "2026-11-15T00:00:00.000Z",
        sourceType: "invoice",
        sourceId: "in_meter",
        chargeId: "ch_meter",
        customerId: "cus_meter",
        subscriptionId: "sub_meter",
        planKey: "starter",
        pricingRevision: "revision",
        stripePriceId: "price_meter",
        periodStart: NOW,
        periodEnd: "2026-11-15T00:00:00.000Z",
        considerationMicros: 5,
      });
      await f.policy.change(command("prepaid"));
      await f.metering.record(usage("paid"));
      await expect(f.metering.rollUp(100)).rejects.toMatchObject({ code: "insufficient_funds" });
      expect(await f.sql.query("SELECT * FROM wallet_credit_allocations")).toEqual([]);
      await purchase(f.sql, 5);
      expect(await f.metering.rollUp(100)).toBe(1);
      expect(
        await f.sql.query(
          "SELECT lot_ref, amount_micros FROM wallet_credit_allocations ORDER BY lot_ref",
        ),
      ).toEqual([
        { lot_ref: "purchase", amount_micros: 5 },
        { lot_ref: "stripe:invoice:in_meter", amount_micros: 5 },
      ]);
    } finally {
      f.database.close();
    }
  });
});

async function exerciseBareLedger(sql: Sql) {
  const f = services(sql);
  await purchase(sql);
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "unknown",
    kind: "direct",
    consumptionClass: "purchased",
    amountMicros: 100,
  });
  expect(await f.ledger.hold({ organizationId: ORG, reference: "stop", amountMicros: 1 })).toBe(
    false,
  );
  expect(
    await f.ledger.debitUsage({ organizationId: ORG, reference: "stop", amountMicros: 1 }),
  ).toBe(false);
  await f.policy.change(command("prepaid"));
  expect(
    await f.ledger.hold({ organizationId: ORG, reference: "original", amountMicros: 80 }),
  ).toBe(true);
  expect(
    await f.ledger.debitUsage({ organizationId: ORG, reference: "consented", amountMicros: 20 }),
  ).toBe(true);
  await f.policy.change(command("stop"));
  const unavailable = createLedger(sql, clock, {
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver: async () => {
      throw new Error("policy unavailable");
    },
  });
  expect(
    await unavailable.hold({ organizationId: ORG, reference: "original", amountMicros: 80 }),
  ).toBe(true);
  expect(
    await unavailable.debitUsage({ organizationId: ORG, reference: "consented", amountMicros: 20 }),
  ).toBe(true);
  await expect(
    unavailable.capture({ organizationId: ORG, reference: "original", amountMicros: 81 }),
  ).rejects.toMatchObject({ code: "conservation_violated" });
  await unavailable.capture({ organizationId: ORG, reference: "original", amountMicros: 80 });
  await unavailable.capture({ organizationId: ORG, reference: "original", amountMicros: 80 });
  await expect(
    unavailable.hold({ organizationId: ORG, reference: "new", amountMicros: 1 }),
  ).rejects.toThrow("policy unavailable");
  expect(await f.ledger.wallet(ORG)).toMatchObject({ heldMicros: 0, availableMicros: 100 });
}

async function exerciseFrozenRollup(sql: Sql) {
  const f = services(sql);
  await purchase(sql);
  await f.policy.change(command("prepaid"));
  await f.metering.record(usage("consented"));
  await f.metering.recordAi({
    requestId: "already-captured-ai",
    organizationId: ORG,
    model: "model",
    inputTokens: 1,
    outputTokens: 1,
  });
  await f.policy.change(command("stop"));
  const outcomes = await Promise.allSettled([f.metering.rollUp(100), f.metering.rollUp(100)]);
  expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
  expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
  expect(await f.ledger.wallet(ORG)).toMatchObject({ availableMicros: 90, heldMicros: 0 });
  expect(await sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type = 'usage_debit'")).toEqual([
    { n: 1 },
  ]);
  expect(await sql.query("SELECT lot_ref, amount_micros FROM wallet_credit_allocations")).toEqual([
    { lot_ref: "purchase", amount_micros: 10 },
  ]);
  expect(await f.metering.rollUp(100)).toBe(0);
  expect(await sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
}

async function exercisePolicyRace(sql: Sql) {
  const f = services(sql);
  await purchase(sql);
  await f.policy.change(command("prepaid"));
  let raced = false;
  const resolver = async (org: string) => {
    const admission = await f.policy.prepareAdmission(org);
    if (!raced) {
      raced = true;
      await f.policy.change(command("stop", "record-race"));
    }
    return admission;
  };
  const metering = createMetering({
    sql,
    ledger: f.ledger,
    clock,
    randomId: () => "race",
    rates: { requestsMinorPerThousand: 1 },
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver: resolver,
  });
  await expect(metering.record(usage("racing"))).rejects.toMatchObject({ code: "constraint" });
  expect(await sql.query("SELECT * FROM usage_events")).toEqual([]);
  await f.policy.change(command("prepaid", "hold-race-prepaid"));
  const ledger = createLedger(sql, clock, {
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver: async (org) => {
      const admission = await f.policy.prepareAdmission(org);
      await f.policy.change(command("stop", "hold-race-stop"));
      return admission;
    },
  });
  await expect(
    ledger.hold({ organizationId: ORG, reference: "racing", amountMicros: 10 }),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await sql.query("SELECT * FROM wallet_credit_allocations")).toEqual([]);
  expect(await sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
}

async function exerciseAtomicUsageWarnings(sql: Sql) {
  const config = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "native-warnings-r1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {},
    }),
  );
  if (!config) throw new Error("native warning tariff missing");
  const policy = createOrgLimitPolicy({ sql, clock });
  const allocationAdmissionResolver = policy.prepareAdmission.bind(policy);
  const usageWarnings: UsageWarningPreparer = async (input) =>
    policy.warningStatements({
      ...input,
      summaryRead: orgUsageSummaryReadStatement({
        ...input,
        hostedPaidFreeExclusion: true,
        hostedCreditProvenance: true,
        refundSource: await stripeRefundSource(sql),
      }),
    });
  const ledger = createLedger(sql, clock, {
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver,
    usageWarnings,
  });
  const billing = createOrgBilling({
    sql,
    clock,
    ledger,
    config,
    hostedPaidFreeExclusion: true,
    limitPolicy: policy,
  });
  let id = 0;
  const metering = createMetering({
    sql,
    ledger,
    clock,
    randomId: () => `native_warning_${++id}`,
    // One request costs 225,000 USD micros under this explicit meter rate.
    rates: { requestsMinorPerThousand: 22_500 },
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver,
    usageWarnings,
  });
  for (const rollback of [false, true]) {
    const organizationId = `native_warning_${rollback ? "rollback" : "success"}`;
    expect((await billing.wallet(organizationId)).availableMicros).toBe(1_500_000);
    const hold = { organizationId, reference: "eighty", amountMicros: 1_200_000 };
    expect(await ledger.hold(hold)).toBe(true);
    const warningRows = async () =>
      sql.query(
        "SELECT * FROM org_wallet_usage_warnings WHERE org_id = ? ORDER BY threshold_basis_points",
        [organizationId],
      );
    const eighty = await warningRows();
    expect(eighty.map((row) => row.threshold_basis_points)).toEqual([8000]);
    expect(JSON.parse(String(eighty[0]?.payload_json))).toMatchObject({
      organizationId,
      effectiveIncludedMicros: "1500000",
      usedMicros: "0",
      heldMicros: "1200000",
    });
    const measured = { ...usage(`${organizationId}:request`), organizationId };
    await metering.record(measured);
    const state = async () => ({
      usage: await sql.query("SELECT * FROM usage_events WHERE org_id = ? ORDER BY request_id", [
        organizationId,
      ]),
      ledger: await sql.query("SELECT * FROM ledger WHERE org_id = ? ORDER BY id", [
        organizationId,
      ]),
      allocations: await sql.query(
        "SELECT * FROM wallet_credit_allocations WHERE org_id = ? ORDER BY debit_type, debit_ref, lot_ref",
        [organizationId],
      ),
      lots: await sql.query("SELECT * FROM wallet_credit_lots WHERE org_id = ? ORDER BY ref", [
        organizationId,
      ]),
      warnings: await warningRows(),
      guards: await sql.query("SELECT * FROM wallet_allocation_guards ORDER BY id"),
      wallet: await ledger.wallet(organizationId),
    });
    if (rollback) {
      const before = await state();
      await sql.run(`CREATE TRIGGER native_warning_late_failure
        BEFORE INSERT ON org_wallet_usage_warnings
        WHEN NEW.org_id = 'native_warning_rollback' AND NEW.threshold_basis_points = 9500
        BEGIN SELECT RAISE(ABORT, 'constraint: native-warning-late-failure'); END`);
      try {
        let failure: unknown;
        try {
          await metering.rollUp(100);
        } catch (error) {
          failure = error;
        }
        expect(failure).toBeInstanceOf(SqlError);
        if (!(failure instanceof SqlError)) throw new Error("native warning failure missing");
        expect(failure.code).toBe("constraint");
        expect(failure.message).toContain("constraint: native-warning-late-failure");
        console.info("native warning rollback:", failure.name, failure.code, failure.message);
        expect(await state()).toEqual(before);
      } finally {
        await sql.run("DROP TRIGGER native_warning_late_failure");
      }
    }
    expect(await metering.rollUp(100)).toBe(1);
    const warnings = await warningRows();
    expect(warnings.map((row) => row.threshold_basis_points)).toEqual([8000, 9500]);
    expect(warnings[0]).toEqual(eighty[0]);
    expect(JSON.parse(String(warnings[1]?.payload_json))).toMatchObject({
      organizationId,
      effectiveIncludedMicros: "1500000",
      usedMicros: "225000",
      heldMicros: "1200000",
    });
    expect(await ledger.wallet(organizationId)).toMatchObject({
      settledMicros: 1_275_000,
      heldMicros: 1_200_000,
      availableMicros: 75_000,
    });
    const committed = await state();
    expect(committed.usage[0]?.rollup_id).not.toBeNull();
    expect(committed.guards).toEqual([]);
    expect(await ledger.hold(hold)).toBe(true);
    await metering.record(measured);
    expect(await metering.rollUp(100)).toBe(0);
    expect(await state()).toEqual(committed);
  }
}

test("native D1 keeps Hosted default holds and frozen metering guards atomic", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "hosted-metering-limit",
          type: "worker",
          compatibilityDate: "2026-08-17",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('ok'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id: "hosted-metering-limit" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const schema of schemas())
      for (const statement of splitMigration(schema)) await database.prepare(statement).run();
    const sql = createD1Sql(database);
    await exercisePolicyRace(sql);
    // Exercise concurrent settlement after the original consent is revoked.
    const f = services(sql);
    await f.policy.change(command("prepaid", "d1-frozen"));
    await f.metering.record(usage("d1-consented"));
    await f.policy.change(command("stop", "d1-revoked"));
    const outcomes = await Promise.allSettled([f.metering.rollUp(100), f.metering.rollUp(100)]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    expect(await f.ledger.wallet(ORG)).toMatchObject({ availableMicros: 90, heldMicros: 0 });
    expect(await sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
    await exerciseAtomicUsageWarnings(sql);
  } finally {
    await runtime.dispose();
  }
}, 60_000);

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
