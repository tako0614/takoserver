import { expect, test } from "bun:test";
import { createLedger, stripeRefundSource, type UsageWarningPreparer } from "../src/ledger.ts";
import { createOrgLimitPolicy } from "../src/org-limit-policy.ts";
import { orgUsageSummaryReadStatement } from "../src/org-usage-summary.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { migratedDatabase } from "./helpers/migrated-database.ts";

const ORG = "org_ledger_warnings";
const NOW = "2026-10-15T12:00:00.000Z";
const ALLOWANCE = 1_500_000;

async function fixture() {
  const database = migratedDatabase();
  const sql = createSqliteSql(database);
  let instant = NOW;
  let clockCalls = 0;
  const clock = () => {
    clockCalls++;
    return new Date(instant);
  };
  const policy = createOrgLimitPolicy({ sql, clock });
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
  const ledgerOptions = {
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver: policy.prepareAdmission.bind(policy),
    usageWarnings,
  };
  const ledger = createLedger(sql, clock, ledgerOptions);
  const standalone = createLedger(sql, clock);
  const ref = `free:${ORG}:2026-10`;
  await sql.batch([
    {
      sql: "INSERT INTO org_wallet_monthly_tariffs (month,pricing_revision,amount_micros,expires_at,created_at,money_policy) VALUES ('2026-10','warnings-r1',?,'2026-11-01T00:00:00.000Z',?,'usd-micros-v2')",
      params: [ALLOWANCE, NOW],
    },
    {
      sql: "INSERT INTO org_wallet_grant_snapshots (org_id,ref,pricing_revision,amount_micros,expires_at,created_at,money_policy) VALUES (?,?,'warnings-r1',?,'2026-11-01T00:00:00.000Z',?,'usd-micros-v2')",
      params: [ORG, ref, ALLOWANCE, NOW],
    },
  ]);
  await standalone.fund({
    organizationId: ORG,
    fundingRef: ref,
    kind: "plan-included",
    consumptionClass: "free",
    amountMicros: ALLOWANCE,
    expiresAt: "2026-11-01T00:00:00.000Z",
  });
  return {
    database,
    sql,
    clock,
    policy,
    ledger,
    standalone,
    usageWarnings,
    time(value: string) {
      instant = value;
    },
    takeClockCalls() {
      const calls = clockCalls;
      clockCalls = 0;
      return calls;
    },
    async warnings() {
      return sql.query(
        "SELECT threshold_basis_points,payload_json,created_at FROM org_wallet_usage_warnings ORDER BY threshold_basis_points",
      );
    },
  };
}

test("direct Ledger holds retain 80/95 exposure before capture or release and deduplicate replay", async () => {
  const f = await fixture();
  try {
    const eighty = { organizationId: ORG, reference: "eighty", amountMicros: 1_200_000 };
    expect(await f.ledger.hold(eighty)).toBe(true);
    await f.ledger.capture(eighty);
    await f.ledger.capture(eighty);
    const extra = { organizationId: ORG, reference: "ninety-five", amountMicros: 225_000 };
    expect(await f.ledger.hold(extra)).toBe(true);
    await f.ledger.release(extra);
    await f.ledger.release(extra);
    expect(await f.ledger.hold(eighty)).toBe(true);
    expect(await f.ledger.hold(extra)).toBe(true);
    // No usage-summary read or warning observer has run during the lifecycle.
    const rows = await f.warnings();
    expect(rows.map((row) => row.threshold_basis_points)).toEqual([8000, 9500]);
    expect(JSON.parse(String(rows[0]?.payload_json))).toMatchObject({
      organizationId: ORG,
      effectiveIncludedMicros: "1500000",
      usedMicros: "0",
      heldMicros: "1200000",
    });
    expect(JSON.parse(String(rows[1]?.payload_json))).toMatchObject({
      usedMicros: "1200000",
      heldMicros: "225000",
    });
    expect((await f.ledger.wallet(ORG)).heldMicros).toBe(0);
  } finally {
    f.database.close();
  }
});

test("direct usage debits record exact 80/95 used thresholds and ignore replay", async () => {
  const f = await fixture();
  try {
    const eighty = { organizationId: ORG, reference: "used-eighty", amountMicros: 1_200_000 };
    const extra = { organizationId: ORG, reference: "used-extra", amountMicros: 225_000 };
    expect(await f.ledger.debitUsage(eighty)).toBe(true);
    expect(await f.ledger.debitUsage(extra)).toBe(true);
    expect(await f.ledger.debitUsage(eighty)).toBe(true);
    expect(await f.ledger.debitUsage(extra)).toBe(true);
    const rows = await f.warnings();
    expect(rows.map((row) => row.threshold_basis_points)).toEqual([8000, 9500]);
    expect(JSON.parse(String(rows[0]?.payload_json))).toMatchObject({
      usedMicros: "1200000",
      heldMicros: "0",
    });
    expect(JSON.parse(String(rows[1]?.payload_json))).toMatchObject({
      usedMicros: "1425000",
      heldMicros: "0",
    });
  } finally {
    f.database.close();
  }
});

test("releasing a prior hold warns only from the remaining post-release exposure", async () => {
  const f = await fixture();
  try {
    expect(
      await f.standalone.hold({ organizationId: ORG, reference: "keep", amountMicros: 1_200_000 }),
    ).toBe(true);
    const release = { organizationId: ORG, reference: "release", amountMicros: 225_000 };
    expect(await f.standalone.hold(release)).toBe(true);
    f.time("2026-10-15T12:02:00.000Z");
    await f.ledger.release(release);
    await f.ledger.release(release);
    const rows = await f.warnings();
    expect(rows.map((row) => row.threshold_basis_points)).toEqual([8000]);
    expect(JSON.parse(String(rows[0]?.payload_json))).toMatchObject({
      heldMicros: "1200000",
      usedMicros: "0",
    });
  } finally {
    f.database.close();
  }
});

async function moneySnapshot(f: Awaited<ReturnType<typeof fixture>>) {
  return Promise.all([
    f.sql.query("SELECT * FROM ledger ORDER BY id"),
    f.sql.query("SELECT * FROM wallet_credit_allocations ORDER BY debit_type,debit_ref,lot_ref"),
    f.sql.query("SELECT * FROM org_wallet_usage_warnings ORDER BY threshold_basis_points"),
    f.sql.query("SELECT * FROM wallet_allocation_guards ORDER BY id"),
  ]);
}

for (const operation of ["hold", "debitUsage", "capture", "release"] as const) {
  test(`late warning SQL failure rolls back ${operation}, allocations and outbox together`, async () => {
    const f = await fixture();
    try {
      const input = { organizationId: ORG, reference: "late-warning", amountMicros: 1_200_000 };
      if (operation === "capture")
        expect(await f.standalone.hold({ ...input, amountMicros: 1_425_000 })).toBe(true);
      if (operation === "release") {
        expect(await f.standalone.hold({ ...input, reference: "retained" })).toBe(true);
        expect(await f.standalone.hold({ ...input, amountMicros: 225_000 })).toBe(true);
      }
      await f.sql.run(
        "CREATE TRIGGER test_warning_failure BEFORE INSERT ON org_wallet_usage_warnings BEGIN SELECT RAISE(ABORT,'constraint: injected warning SQL failure'); END",
      );
      const before = await moneySnapshot(f);
      const amountMicros = operation === "release" ? 225_000 : 1_200_000;
      await expect(f.ledger[operation]({ ...input, amountMicros })).rejects.toMatchObject({
        code: "constraint",
        message: expect.stringContaining("constraint: injected warning SQL failure"),
      });
      expect(await moneySnapshot(f)).toEqual(before);
    } finally {
      f.database.close();
    }
  });
}

test("warning preparation cannot bypass a policy version changed before the atomic hold", async () => {
  const f = await fixture();
  try {
    const ledger = createLedger(f.sql, f.clock, {
      hostedPaidFreeExclusion: true,
      allocationAdmissionResolver: f.policy.prepareAdmission.bind(f.policy),
      usageWarnings: async (input) => {
        await f.policy.change({
          organizationId: ORG,
          authorizedPrincipal: "session:owner",
          reference: "concurrent-change",
          onLimit: "prepaid",
        });
        return f.usageWarnings(input);
      },
    });
    const before = await moneySnapshot(f);
    await expect(
      ledger.hold({ organizationId: ORG, reference: "stale-policy", amountMicros: 1_200_000 }),
    ).rejects.toMatchObject({ code: "constraint" });
    expect(await moneySnapshot(f)).toEqual(before);
    expect(await f.policy.prepareAdmission(ORG)).toMatchObject({
      policyVersion: 1,
      onLimit: "prepaid",
    });
  } finally {
    f.database.close();
  }
});

test("omitting warnings preserves standalone money, clock and replay behavior", async () => {
  const f = await fixture();
  try {
    f.takeClockCalls();
    const hold = { organizationId: ORG, reference: "standalone", amountMicros: 1_425_000 };
    expect(await f.standalone.hold(hold)).toBe(true);
    expect(f.takeClockCalls()).toBe(1);
    const capture = { ...hold, amountMicros: 1_200_000 };
    await f.standalone.capture(capture);
    expect(f.takeClockCalls()).toBe(1);
    const release = { ...hold, amountMicros: 225_000 };
    await f.standalone.release(release);
    expect(f.takeClockCalls()).toBe(1);
    expect(await f.standalone.hold(hold)).toBe(true);
    await f.standalone.capture(capture);
    await f.standalone.release(release);
    expect(f.takeClockCalls()).toBe(0);
    expect(await f.warnings()).toEqual([]);
  } finally {
    f.database.close();
  }
});

test("an existing expired-period hold still captures without manufacturing a current warning", async () => {
  const f = await fixture();
  try {
    const input = { organizationId: ORG, reference: "old-period", amountMicros: 1_200_000 };
    expect(await f.standalone.hold(input)).toBe(true);
    f.time("2026-11-01T00:00:00.000Z");
    await f.ledger.capture(input);
    expect(await f.warnings()).toEqual([]);
    expect((await f.ledger.wallet(ORG)).heldMicros).toBe(0);
    expect(
      await f.sql.query(
        "SELECT amount_micros FROM wallet_credit_allocations WHERE debit_type='capture'",
      ),
    ).toEqual([{ amount_micros: 1_200_000 }]);
  } finally {
    f.database.close();
  }
});

test("captures a prior hold into used plus remaining held warnings in the settlement batch", async () => {
  const f = await fixture();
  try {
    const original = { organizationId: ORG, reference: "prior", amountMicros: 1_425_000 };
    expect(await f.standalone.hold(original)).toBe(true);
    const at = "2026-10-15T12:01:00.000Z";
    f.time(at);
    await f.ledger.capture({ ...original, amountMicros: 1_200_000 });
    const rows = await f.warnings();
    expect(rows.map((row) => row.threshold_basis_points)).toEqual([8000, 9500]);
    for (const row of rows) {
      expect(row.created_at).toBe(at);
      expect(JSON.parse(String(row.payload_json))).toMatchObject({
        usedMicros: "1200000",
        heldMicros: "225000",
      });
    }
  } finally {
    f.database.close();
  }
});

test("constructor retains the original warning preparer after caller options are removed or replaced", async () => {
  const f = await fixture();
  try {
    let originalCalls = 0;
    let replacementCalls = 0;
    const options: {
      hostedPaidFreeExclusion: boolean;
      allocationAdmissionResolver: typeof f.policy.prepareAdmission;
      usageWarnings?: UsageWarningPreparer;
    } = {
      hostedPaidFreeExclusion: true,
      allocationAdmissionResolver: f.policy.prepareAdmission.bind(f.policy),
      usageWarnings: async (input) => {
        originalCalls++;
        return f.usageWarnings(input);
      },
    };
    const ledger = createLedger(f.sql, f.clock, options);
    delete options.usageWarnings;
    const eighty = { organizationId: ORG, reference: "retained-preparer", amountMicros: 1_200_000 };
    expect(await ledger.hold(eighty)).toBe(true);
    options.usageWarnings = async () => {
      replacementCalls++;
      return [];
    };
    await ledger.capture(eighty);
    const extra = { organizationId: ORG, reference: "extra-preparer", amountMicros: 225_000 };
    expect(await ledger.hold(extra)).toBe(true);
    await ledger.release(extra);
    expect((await f.warnings()).map((row) => row.threshold_basis_points)).toEqual([8000, 9500]);
    expect(originalCalls).toBe(4);
    expect(replacementCalls).toBe(0);
  } finally {
    f.database.close();
  }
});
