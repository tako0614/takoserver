import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { Miniflare } from "miniflare";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  createLedger,
  type LedgerAllocationAdmission,
  prepareLedgerAllocation,
} from "../src/ledger.ts";
import { createOrgLimitPolicy, type OrgLimitAdmission } from "../src/org-limit-policy.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";

const ORG = "hosted_limit_org";
const NOW = "2026-10-15T00:00:00.000Z";

function schemas(): readonly string[] {
  const draft = process.env.TAKOSERVER_BILLING_EXTENSION_TEST_SCHEMA;
  return [...MIGRATIONS.map(({ sql }) => sql), ...(draft ? [readFileSync(draft, "utf8")] : [])];
}

function fixture(seedBeforeCutover?: (database: Database) => void) {
  const database = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    database.exec(migration.sql);
    if (migration.name === "0093_wallet_credit_classification_proofs.sql")
      seedBeforeCutover?.(database);
  }
  const draft = process.env.TAKOSERVER_BILLING_EXTENSION_TEST_SCHEMA;
  if (draft) database.exec(readFileSync(draft, "utf8"));
  const sql = createSqliteSql(database);
  let instant = NOW;
  const clock = () => new Date(instant);
  return {
    database,
    sql,
    ledger: createLedger(sql, clock, { hostedPaidFreeExclusion: true }),
    policy: createOrgLimitPolicy({ sql, clock }),
    time(value: string) {
      instant = value;
    },
  };
}

async function purchase(sql: Sql, amountMicros = 100) {
  await createLedger(sql, () => new Date(NOW)).fund({
    organizationId: ORG,
    fundingRef: "purchase",
    kind: "purchased",
    consumptionClass: "purchased",
    amountMicros,
  });
}

async function allocations(sql: Sql) {
  return sql.query(
    `SELECT debit_type, debit_ref, lot_ref, amount_micros FROM wallet_credit_allocations
     WHERE org_id = ? ORDER BY debit_ref, lot_ref`,
    [ORG],
  );
}

function command(onLimit: "stop" | "prepaid", reference: string = onLimit) {
  return { organizationId: ORG, authorizedPrincipal: "session:owner", reference, onLimit };
}

describe("explicit Hosted ledger admission", () => {
  test("default stop allocates included classes in order and leaves purchase/direct funds untouched", async () => {
    const f = fixture();
    try {
      for (const entry of [
        { fundingRef: "direct", kind: "direct", consumptionClass: "free", amountMicros: 100 },
        { fundingRef: "free", kind: "plan-included", consumptionClass: "free", amountMicros: 10 },
        {
          fundingRef: "plan",
          kind: "plan-included",
          consumptionClass: "subscription",
          amountMicros: 20,
        },
        {
          fundingRef: "purchase",
          kind: "purchased",
          consumptionClass: "purchased",
          amountMicros: 50,
        },
      ] as const) {
        await f.ledger.fund({ organizationId: ORG, ...entry });
      }
      const admission = await f.policy.prepareAdmission(ORG);
      expect(admission).toMatchObject({
        onLimit: "stop",
        policyVersion: 0,
        allowPurchasedCredit: false,
      });
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "too-much",
          amountMicros: 31,
          allocationAdmission: admission,
        }),
      ).toBe(false);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "too-much",
          amountMicros: 31,
          allocationAdmission: admission,
        }),
      ).toBe(false);
      expect(await allocations(f.sql)).toEqual([]);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "usage",
          amountMicros: 12,
          allocationAdmission: admission,
        }),
      ).toBe(true);
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "hold",
          amountMicros: 18,
          allocationAdmission: admission,
        }),
      ).toBe(true);
      expect(await allocations(f.sql)).toEqual([
        { debit_type: "hold", debit_ref: "hold", lot_ref: "plan", amount_micros: 18 },
        { debit_type: "usage_debit", debit_ref: "usage", lot_ref: "free", amount_micros: 10 },
        { debit_type: "usage_debit", debit_ref: "usage", lot_ref: "plan", amount_micros: 2 },
      ]);
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "blocked",
          amountMicros: 1,
          allocationAdmission: admission,
        }),
      ).toBe(false);
      expect((await f.ledger.wallet(ORG)).availableMicros).toBe(150);
      expect(await f.sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
    } finally {
      f.database.close();
    }
  });

  test("consented prepaid adds purchased funds after included funds but excludes unproven direct classes", async () => {
    const f = fixture();
    try {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "free",
        kind: "plan-included",
        consumptionClass: "free",
        amountMicros: 10,
      });
      await purchase(f.sql, 50);
      for (const consumptionClass of ["free", "subscription", "purchased"] as const) {
        await f.ledger.fund({
          organizationId: ORG,
          fundingRef: `direct:${consumptionClass}`,
          kind: "direct",
          consumptionClass,
          amountMicros: 100,
        });
      }
      await f.policy.change(command("prepaid"));
      const admission = await f.policy.prepareAdmission(ORG);
      expect(admission).toMatchObject({
        onLimit: "prepaid",
        allowPurchasedCredit: true,
        consentRevision: "prepaid-usage-v1",
      });
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "usage",
          amountMicros: 15,
          allocationAdmission: admission,
        }),
      ).toBe(true);
      expect(await allocations(f.sql)).toEqual([
        { debit_type: "usage_debit", debit_ref: "usage", lot_ref: "free", amount_micros: 10 },
        { debit_type: "usage_debit", debit_ref: "usage", lot_ref: "purchase", amount_micros: 5 },
      ]);
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "prepaid",
          amountMicros: 45,
          allocationAdmission: admission,
        }),
      ).toBe(true);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "blocked",
          amountMicros: 1,
          allocationAdmission: admission,
        }),
      ).toBe(false);
      expect((await f.ledger.wallet(ORG)).availableMicros).toBe(300);
      const independent = createLedger(f.sql, () => new Date(NOW));
      expect(
        await independent.debitUsage({
          organizationId: ORG,
          reference: "self-host",
          amountMicros: 1,
        }),
      ).toBe(true);
    } finally {
      f.database.close();
    }
  });

  test("preserved classification proofs admit legacy direct credit under the original class", async () => {
    const f = fixture((database) => {
      for (const [consumptionClass, amountMinor] of [
        ["free", 1],
        ["subscription", 2],
        ["purchased", 3],
      ] as const) {
        const ref = `legacy:${consumptionClass}`;
        database
          .query(`INSERT INTO wallet_credit_lots
          (org_id, ref, kind, amount_minor, expires_at, created_at)
          VALUES (?, ?, 'direct', ?, NULL, ?)`)
          .run(ORG, ref, amountMinor, NOW);
        database
          .query(`INSERT INTO ledger
          (id, org_id, type, ref, settled_delta, held_delta, created_at)
          VALUES (?, ?, 'funding', ?, ?, 0, ?)`)
          .run(`funding:${ref}`, ORG, ref, amountMinor, NOW);
        database
          .query(`INSERT INTO wallet_credit_lot_classification_proofs
          (org_id, ref, original_kind, original_amount_minor, original_expires_at,
           consumption_class, evidence_ref, reviewed_at)
          VALUES (?, ?, 'direct', ?, NULL, ?, 'operator-reviewed-proof', ?)`)
          .run(ORG, ref, amountMinor, consumptionClass, NOW);
      }
    });
    try {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "unknown",
        kind: "direct",
        consumptionClass: "purchased",
        amountMicros: 100_000,
      });
      const stop = await f.policy.prepareAdmission(ORG);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "included",
          amountMicros: 30_000,
          allocationAdmission: stop,
        }),
      ).toBe(true);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "no-consent",
          amountMicros: 1,
          allocationAdmission: stop,
        }),
      ).toBe(false);
      await f.policy.change(command("prepaid"));
      const prepaid = await f.policy.prepareAdmission(ORG);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "purchase",
          amountMicros: 30_000,
          allocationAdmission: prepaid,
        }),
      ).toBe(true);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "unknown",
          amountMicros: 1,
          allocationAdmission: prepaid,
        }),
      ).toBe(false);
      expect(await allocations(f.sql)).toEqual([
        {
          debit_type: "usage_debit",
          debit_ref: "included",
          lot_ref: "legacy:free",
          amount_micros: 10_000,
        },
        {
          debit_type: "usage_debit",
          debit_ref: "included",
          lot_ref: "legacy:subscription",
          amount_micros: 20_000,
        },
        {
          debit_type: "usage_debit",
          debit_ref: "purchase",
          lot_ref: "legacy:purchased",
          amount_micros: 30_000,
        },
      ]);
      await expect(
        f.sql.run(
          "UPDATE wallet_credit_lot_classification_proofs SET original_amount_minor = 4 WHERE org_id = ? AND ref = ?",
          [ORG, "legacy:purchased"],
        ),
      ).rejects.toBeInstanceOf(SqlError);
      expect((await f.ledger.wallet(ORG)).availableMicros).toBe(100_000);
    } finally {
      f.database.close();
    }
  });

  test("a verified legacy Stripe source proves a direct purchase without a guessed reference", async () => {
    const f = fixture();
    try {
      for (const fundingRef of ["stripe:cs_legacy", "stripe:cs_unproven"]) {
        await f.ledger.fund({
          organizationId: ORG,
          fundingRef,
          kind: "direct",
          consumptionClass: "purchased",
          amountMicros: 100,
        });
      }
      const store = createStripeBillingStore({ sql: f.sql, clock: () => new Date(NOW) });
      await store.grant({
        organizationId: ORG,
        fundingRef: "stripe:cs_legacy",
        kind: "purchased",
        amountMicros: 100,
        expiresAt: null,
        sourceType: "checkout",
        sourceId: "cs_legacy",
        chargeId: "ch_legacy",
        customerId: "cus_legacy",
        subscriptionId: null,
        planKey: null,
        pricingRevision: null,
        stripePriceId: null,
        periodStart: null,
        periodEnd: null,
        considerationMicros: 100,
      });
      await f.policy.change(command("prepaid"));
      const admission = await f.policy.prepareAdmission(ORG);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "verified",
          amountMicros: 100,
          allocationAdmission: admission,
        }),
      ).toBe(true);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "unverified",
          amountMicros: 1,
          allocationAdmission: admission,
        }),
      ).toBe(false);
      expect(await allocations(f.sql)).toEqual([
        {
          debit_type: "usage_debit",
          debit_ref: "verified",
          lot_ref: "stripe:cs_legacy",
          amount_micros: 100,
        },
      ]);
    } finally {
      f.database.close();
    }
  });

  test("paid coverage excludes Free from new admission while an earlier Free hold still captures", async () => {
    const f = fixture();
    try {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "free",
        kind: "plan-included",
        consumptionClass: "free",
        amountMicros: 100,
      });
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "old-free",
          amountMicros: 40,
          allocationAdmission: await f.policy.prepareAdmission(ORG),
        }),
      ).toBe(true);
      await createStripeBillingStore({ sql: f.sql, clock: () => new Date(NOW) }).grant({
        organizationId: ORG,
        fundingRef: "stripe:invoice:in_paid",
        kind: "plan-included",
        amountMicros: 20,
        expiresAt: "2026-11-15T00:00:00.000Z",
        sourceType: "invoice",
        sourceId: "in_paid",
        chargeId: "ch_paid",
        customerId: "cus_paid",
        subscriptionId: "sub_paid",
        planKey: "starter",
        pricingRevision: "revision",
        stripePriceId: "price_paid",
        periodStart: NOW,
        periodEnd: "2026-11-15T00:00:00.000Z",
        considerationMicros: 10,
      });
      const stop = await f.policy.prepareAdmission(ORG);
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "cannot-stack",
          amountMicros: 21,
          allocationAdmission: stop,
        }),
      ).toBe(false);
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "paid",
          amountMicros: 20,
          allocationAdmission: stop,
        }),
      ).toBe(true);
      await f.ledger.capture({ organizationId: ORG, reference: "old-free", amountMicros: 40 });
      expect(await allocations(f.sql)).toEqual([
        { debit_type: "capture", debit_ref: "old-free", lot_ref: "free", amount_micros: 40 },
        {
          debit_type: "hold",
          debit_ref: "paid",
          lot_ref: "stripe:invoice:in_paid",
          amount_micros: 20,
        },
      ]);
    } finally {
      f.database.close();
    }
  });

  test("a stale policy witness rolls back the enclosing write, allocation, and ledger receipt", async () => {
    const f = fixture();
    try {
      await exercisePolicyFence(f.sql);
    } finally {
      f.database.close();
    }
  });

  test("two concurrent included holds cannot both allocate the same admitted funds", async () => {
    const f = fixture();
    try {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "free",
        kind: "plan-included",
        consumptionClass: "free",
        amountMicros: 100,
      });
      const planned = await Promise.all(
        ["first", "second"].map(async (reference) =>
          prepareLedgerAllocation(f.sql, {
            organizationId: ORG,
            reference,
            type: "hold",
            amountMicros: 70,
            settledDeltaMicros: 0,
            heldDeltaMicros: 70,
            now: NOW,
            allocationAdmission: await f.policy.prepareAdmission(ORG),
          }),
        ),
      );
      const results = await Promise.allSettled(
        planned.map((statements) => f.sql.batch(statements)),
      );
      expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
      expect(results.filter(({ status }) => status === "rejected")).toHaveLength(1);
      expect(await f.ledger.wallet(ORG)).toMatchObject({ heldMicros: 70, availableMicros: 30 });
      expect(await allocations(f.sql)).toHaveLength(1);
      expect(await f.sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
    } finally {
      f.database.close();
    }
  });

  test("already admitted purchase holds capture and replay after prepaid is revoked", async () => {
    const f = fixture();
    try {
      await purchase(f.sql);
      await f.policy.change(command("prepaid"));
      const admission = await f.policy.prepareAdmission(ORG);
      const hold = {
        organizationId: ORG,
        reference: "original",
        amountMicros: 70,
        allocationAdmission: admission,
      };
      expect(await f.ledger.hold(hold)).toBe(true);
      await f.policy.change(command("stop"));
      expect(await f.ledger.hold(hold)).toBe(true);
      expect(
        await f.ledger.hold({
          ...hold,
          reference: "new",
          allocationAdmission: await f.policy.prepareAdmission(ORG),
        }),
      ).toBe(false);
      await f.ledger.capture({ organizationId: ORG, reference: "original", amountMicros: 70 });
      await f.ledger.capture({ organizationId: ORG, reference: "original", amountMicros: 70 });
      expect(await f.ledger.hold(hold)).toBe(true);
      expect(await f.ledger.wallet(ORG)).toMatchObject({ heldMicros: 0, availableMicros: 30 });
      expect(await allocations(f.sql)).toEqual([
        { debit_type: "capture", debit_ref: "original", lot_ref: "purchase", amount_micros: 70 },
      ]);
    } finally {
      f.database.close();
    }
  });

  test("expired included lots retain the original hold's capture and release rights", async () => {
    const f = fixture();
    try {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "expiring",
        kind: "plan-included",
        consumptionClass: "free",
        amountMicros: 100,
        expiresAt: "2026-10-15T01:00:00.000Z",
      });
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "before-expiry",
          amountMicros: 80,
          allocationAdmission: await f.policy.prepareAdmission(ORG),
        }),
      ).toBe(true);
      await f.policy.change(command("prepaid"));
      f.time("2026-10-15T02:00:00.000Z");
      expect(
        await f.ledger.hold({
          organizationId: ORG,
          reference: "after-expiry",
          amountMicros: 1,
          allocationAdmission: await f.policy.prepareAdmission(ORG),
        }),
      ).toBe(false);
      await f.ledger.capture({ organizationId: ORG, reference: "before-expiry", amountMicros: 30 });
      await f.ledger.release({ organizationId: ORG, reference: "before-expiry", amountMicros: 50 });
      expect(await f.ledger.wallet(ORG)).toMatchObject({
        settledMicros: 0,
        heldMicros: 0,
        availableMicros: 0,
      });
    } finally {
      f.database.close();
    }
  });

  test("pending usage keeps its original purchase decision after the current policy changes", async () => {
    const f = fixture();
    try {
      const declined = await pinUsage(f.sql, "declined", await f.policy.prepareAdmission(ORG));
      await f.policy.change(command("prepaid"));
      const consented = await pinUsage(f.sql, "consented", await f.policy.prepareAdmission(ORG));
      await purchase(f.sql);
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "usage:declined",
          amountMicros: 10,
          allocationAdmission: declined,
        }),
      ).toBe(false);
      await f.policy.change(command("stop"));
      expect(
        await f.ledger.debitUsage({
          organizationId: ORG,
          reference: "usage:consented",
          amountMicros: 10,
          allocationAdmission: consented,
        }),
      ).toBe(true);
      await expect(
        f.sql.run(
          "UPDATE org_wallet_usage_records SET admission_policy_json = '{}' WHERE org_id = ? AND ref = ?",
          [ORG, "declined"],
        ),
      ).rejects.toBeInstanceOf(SqlError);
      expect(await allocations(f.sql)).toEqual([
        {
          debit_type: "usage_debit",
          debit_ref: "usage:consented",
          lot_ref: "purchase",
          amount_micros: 10,
        },
      ]);
      expect(await f.sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
    } finally {
      f.database.close();
    }
  });
});

async function exercisePolicyFence(sql: Sql) {
  const policy = createOrgLimitPolicy({ sql, clock: () => new Date(NOW) });
  await purchase(sql);
  await policy.change(command("prepaid"));
  const planned = await prepareLedgerAllocation(sql, {
    organizationId: ORG,
    reference: "stale",
    type: "hold",
    amountMicros: 70,
    settledDeltaMicros: 0,
    heldDeltaMicros: 70,
    now: NOW,
    allocationAdmission: await policy.prepareAdmission(ORG),
  });
  await sql.run("CREATE TABLE test_admission_effects (reference TEXT PRIMARY KEY)");
  await policy.change(command("stop"));
  await expect(
    sql.batch([
      { sql: "INSERT INTO test_admission_effects (reference) VALUES ('must-rollback')" },
      ...planned,
    ]),
  ).rejects.toMatchObject({ code: "constraint" });
  expect(await sql.query("SELECT * FROM test_admission_effects")).toEqual([]);
  expect(await allocations(sql)).toEqual([]);
  expect(
    await sql.query("SELECT ref FROM ledger WHERE org_id = ? AND type = 'hold'", [ORG]),
  ).toEqual([]);
  expect(await sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
  // An ABA mode change still invalidates the original version witness.
  await policy.change(command("prepaid", "prepaid-again"));
  await expect(sql.batch(planned)).rejects.toMatchObject({ code: "constraint" });
  const ledger = createLedger(sql, () => new Date(NOW), { hostedPaidFreeExclusion: true });
  expect(
    await ledger.hold({
      organizationId: ORG,
      reference: "fresh",
      amountMicros: 70,
      allocationAdmission: await policy.prepareAdmission(ORG),
    }),
  ).toBe(true);
  expect(await ledger.wallet(ORG)).toMatchObject({ heldMicros: 70, availableMicros: 30 });
  await ledger.release({ organizationId: ORG, reference: "fresh", amountMicros: 70 });
  const racingHold = await prepareLedgerAllocation(sql, {
    organizationId: ORG,
    reference: "racing",
    type: "hold",
    amountMicros: 60,
    settledDeltaMicros: 0,
    heldDeltaMicros: 60,
    now: NOW,
    allocationAdmission: await policy.prepareAdmission(ORG),
  });
  const [change, allocation] = await Promise.allSettled([
    policy.change(command("stop", "racing-stop")),
    sql.batch(racingHold),
  ]);
  expect(change.status).toBe("fulfilled");
  if (allocation.status === "rejected")
    expect(allocation.reason).toMatchObject({ code: "constraint" });
  const wallet = await ledger.wallet(ORG);
  expect(wallet).toMatchObject({
    heldMicros: allocation.status === "fulfilled" ? 60 : 0,
    availableMicros: allocation.status === "fulfilled" ? 40 : 100,
  });
  expect(await sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
}

async function pinUsage(
  sql: Sql,
  reference: string,
  admission: OrgLimitAdmission,
): Promise<LedgerAllocationAdmission> {
  const witness = JSON.stringify({
    onLimit: admission.onLimit,
    policyVersion: admission.policyVersion,
    consentRevision: admission.consentRevision,
    allowPurchasedCredit: admission.allowPurchasedCredit,
  });
  await sql.batch([
    admission.guard,
    {
      sql: `INSERT INTO org_wallet_usage_records
        (org_id, ref, fingerprint, pricing_revision, meter, quantity, quantity_unit,
         period_start, period_end, rate_numerator_micros, rate_denominator,
         amount_micros, state, created_at, paid_at, money_policy, admission_policy_json)
        VALUES (?, ?, ?, 'revision', 'meter', '10', 'request', ?, ?, '1', '1',
          10, 'pending', ?, NULL, 'usd-micros-v2', ?)`,
      params: [ORG, reference, reference, NOW, "2026-10-15T00:01:00.000Z", NOW, witness],
    },
    admission.cleanup,
  ]);
  const id = `guard_${crypto.randomUUID()}`;
  return {
    allowPurchasedCredit: admission.allowPurchasedCredit,
    guard: {
      sql: `INSERT INTO wallet_allocation_guards (id, valid)
        VALUES (?, CASE WHEN EXISTS (SELECT 1 FROM org_wallet_usage_records
          WHERE org_id = ? AND ref = ? AND admission_policy_json = ? AND state = 'pending')
          THEN 1 ELSE 0 END)`,
      params: [id, ORG, reference, witness],
    },
    cleanup: { sql: "DELETE FROM wallet_allocation_guards WHERE id = ?", params: [id] },
  };
}

test("native D1 rolls back a purchase allocation when its admission policy changes", async () => {
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: "hosted-limit-allocation",
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
          env: { STATE_DB: { type: "d1", id: "hosted-limit-allocation" } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    for (const schema of schemas()) {
      for (const statement of splitMigration(schema)) await database.prepare(statement).run();
    }
    await exercisePolicyFence(createD1Sql(database));
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
