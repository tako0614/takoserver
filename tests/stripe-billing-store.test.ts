import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { createLedger } from "../src/ledger.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { type BillingGrant, createStripeBillingStore } from "../src/stripe-billing-store.ts";

const start = "2026-10-14T00:00:00.000Z";
const clock = () => new Date(start);

async function fixture() {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) {
    if (migration.name !== "0095_stripe_billing.sql") db.exec(migration.sql);
  }
  // Exercise the migration source even while another agent regenerates the
  // embedded schema from this file.
  db.exec(await Bun.file(new URL("../migrations/0095_stripe_billing.sql", import.meta.url)).text());
  const sql = createSqliteSql(db);
  const ledger = createLedger(sql, clock);
  const store = createStripeBillingStore({ sql, clock });
  const grant: BillingGrant = {
    organizationId: "org_test",
    fundingRef: "stripe:cs_test",
    kind: "purchased",
    amountMicros: 100,
    expiresAt: "2026-11-14T00:00:00.000Z",
    sourceType: "checkout",
    sourceId: "cs_test",
    chargeId: "ch_test",
    customerId: "cus_test",
    subscriptionId: null,
    planKey: null,
    pricingRevision: null,
    stripePriceId: null,
    periodStart: null,
    periodEnd: null,
    considerationMicros: 100,
  };
  return { db, sql, ledger, store, grant };
}

describe("Stripe billing store", () => {
  test("forward migration retains deferred Stripe event evidence for versioned replay", async () => {
    const db = new Database(":memory:");
    for (const migration of MIGRATIONS) {
      if (migration.name === "0095_stripe_billing.sql") break;
      db.exec(migration.sql);
    }
    db.exec(`INSERT INTO stripe_events
      (event_id, type, livemode, object_id, event_created_at, received_at,
       outcome, outcome_detail, settled_at)
      VALUES ('evt_old', 'invoice.paid', 0, 'in_old', '${start}', '${start}',
              'deferred', 'unsupported', '${start}')`);
    db.exec(
      await Bun.file(new URL("../migrations/0095_stripe_billing.sql", import.meta.url)).text(),
    );
    expect(
      db
        .query("SELECT outcome, handler_version FROM stripe_events WHERE event_id = 'evt_old'")
        .get(),
    ).toMatchObject({ outcome: "deferred", handler_version: 0 });
    expect(
      db.query("SELECT name FROM sqlite_schema WHERE name = 'stripe_events_outcome'").get(),
    ).toBeTruthy();
  });

  test("grant proof is idempotent and a frozen new lot cannot be allocated", async () => {
    const { ledger, store, grant } = await fixture();
    const fenceGeneration = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    await store.grant(grant);
    await store.grant(grant);
    expect((await store.grantsForCharge(grant.chargeId)).length).toBe(1);
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
    expect(
      await ledger.debitUsage({
        organizationId: grant.organizationId,
        reference: "usage",
        amountMicros: 1,
      }),
    ).toBe(false);
    const result = await store.refund({
      refundId: "re_test",
      grant,
      amountMicros: 100,
      cumulativeRefundedMicros: 100,
      fenceGeneration,
    });
    expect(result.debitMicros).toBe(100);
    expect((await ledger.wallet(grant.organizationId)).settledMicros).toBe(0);
  });

  test("spent credit becomes receivable without taking another lot", async () => {
    const { ledger, store, grant } = await fixture();
    await store.grant(grant);
    expect(
      await ledger.debitUsage({
        organizationId: grant.organizationId,
        reference: "usage",
        amountMicros: 60,
      }),
    ).toBe(true);
    await ledger.fund({ consumptionClass: "purchased",
      organizationId: grant.organizationId,
      fundingRef: "other",
      amountMicros: 50,
    });
    const fenceGeneration = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    const result = await store.refund({
      refundId: "re_test",
      grant,
      amountMicros: 100,
      cumulativeRefundedMicros: 100,
      fenceGeneration,
    });
    expect(result).toMatchObject({ debitMicros: 40, receivableMicros: 60, expiredMicros: 0 });
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(50);
    expect((await ledger.wallet(grant.organizationId)).refundReceivableMicros).toBe(60);
  });

  test("partial refunds use cumulative exact target and an expired unused lot creates no debt", async () => {
    const { ledger, store, grant } = await fixture();
    const expiredGrant: BillingGrant = { ...grant, expiresAt: "2026-10-13T00:00:00.000Z" };
    await store.grant(expiredGrant);
    let fenceGeneration = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    const first = await store.refund({
      refundId: "re_one",
      grant: expiredGrant,
      amountMicros: 33,
      cumulativeRefundedMicros: 33,
      fenceGeneration,
      releaseFreeze: false,
    });
    const second = await store.refund({
      refundId: "re_two",
      grant: expiredGrant,
      amountMicros: 67,
      cumulativeRefundedMicros: 100,
      fenceGeneration,
    });
    expect(first.expiredMicros).toBe(33);
    expect(second.expiredMicros).toBe(67);
    expect((await ledger.wallet(grant.organizationId)).refundReceivableMicros).toBe(0);
    fenceGeneration = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    expect(
      (
        await store.refund({
          refundId: "re_two",
          grant: expiredGrant,
          amountMicros: 67,
          cumulativeRefundedMicros: 100,
          fenceGeneration,
        })
      ).expiredMicros,
    ).toBe(67);
  });

  test("refund closes a held reservation and returns unrelated lot allocation", async () => {
    const { ledger, store, grant, sql } = await fixture();
    await store.grant(grant);
    await ledger.fund({ consumptionClass: "purchased",
      organizationId: grant.organizationId,
      fundingRef: "other",
      amountMicros: 50,
    });
    expect(
      await ledger.hold({
        organizationId: grant.organizationId,
        reference: "reservation",
        amountMicros: 120,
      }),
    ).toBe(true);
    const fenceGeneration = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    const result = await store.refund({
      refundId: "re_test",
      grant,
      amountMicros: 100,
      cumulativeRefundedMicros: 100,
      fenceGeneration,
    });
    expect(result.debitMicros).toBe(100);
    const wallet = await ledger.wallet(grant.organizationId);
    expect(wallet.heldMicros).toBe(0);
    expect(wallet.availableMicros).toBe(50);
    expect(
      (
        await sql.query(
          "SELECT 1 FROM wallet_credit_allocations WHERE debit_ref = 'reservation' AND debit_type = 'hold'",
        )
      ).length,
    ).toBe(0);
  });

  test("zero included credit has immutable invoice proof and no fictional wallet lot", async () => {
    const { store, grant, sql } = await fixture();
    const zero: BillingGrant = {
      ...grant,
      fundingRef: "stripe:invoice:in_zero",
      sourceType: "invoice",
      sourceId: "in_zero",
      chargeId: "ch_zero",
      kind: "plan-included",
      amountMicros: 0,
      considerationMicros: 30,
      planKey: "configured-plan",
      pricingRevision: "configured-revision",
      stripePriceId: "price_configured",
      subscriptionId: "sub_zero",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
    };
    await store.grant(zero);
    const generation = await store.freezeFunding(zero.organizationId, zero.fundingRef);
    const result = await store.refund({
      refundId: "re_zero",
      grant: zero,
      amountMicros: 30,
      cumulativeRefundedMicros: 30,
      fenceGeneration: generation,
    });
    expect(result).toMatchObject({ targetRevokedMicros: 0, debitMicros: 0, receivableMicros: 0 });
    expect(
      (
        await sql.query("SELECT 1 FROM wallet_credit_lots WHERE org_id = ? AND ref = ?", [
          zero.organizationId,
          zero.fundingRef,
        ])
      ).length,
    ).toBe(0);
  });

  test("cumulative partial refund rounding revokes only each delta", async () => {
    const { store, grant, ledger } = await fixture();
    const included: BillingGrant = {
      ...grant,
      sourceType: "invoice",
      sourceId: "in_test",
      fundingRef: "stripe:invoice:in_test",
      kind: "plan-included",
      amountMicros: 2,
      considerationMicros: 3,
      subscriptionId: "sub_test",
      planKey: "configured-plan",
      pricingRevision: "configured-revision",
      stripePriceId: "price_configured",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
    };
    await store.grant(included);
    const generation = await store.freezeFunding(included.organizationId, included.fundingRef);
    const results = [];
    for (let index = 1; index <= 3; index++)
      results.push(
        await store.refund({
          refundId: `re_${index}`,
          grant: included,
          amountMicros: 1,
          cumulativeRefundedMicros: index,
          fenceGeneration: generation,
          releaseFreeze: index !== 3 ? false : true,
        }),
      );
    expect(results.map((result) => result.targetRevokedMicros)).toEqual([0, 1, 2]);
    expect(results.map((result) => result.debitMicros)).toEqual([0, 1, 1]);
    expect((await ledger.wallet(included.organizationId)).availableMicros).toBe(0);
  });

  test("one subscription period cannot receive two grants from different invoice ids", async () => {
    const { store, grant, ledger, sql } = await fixture();
    const first: BillingGrant = {
      ...grant,
      sourceType: "invoice",
      sourceId: "in_first",
      chargeId: "ch_first",
      fundingRef: "stripe:invoice:in_first",
      kind: "plan-included",
      amountMicros: 20,
      subscriptionId: "sub_test",
      planKey: "configured-plan",
      pricingRevision: "configured-revision",
      stripePriceId: "price_configured",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
    };
    await store.grant(first);
    await expect(
      store.grant({
        ...first,
        sourceId: "in_second",
        chargeId: "ch_second",
        fundingRef: "stripe:invoice:in_second",
      }),
    ).rejects.toThrow();
    expect((await ledger.wallet(grant.organizationId)).settledMicros).toBe(20);
    expect((await sql.query("SELECT COUNT(*) AS n FROM stripe_billing_grants"))[0]?.n).toBe(1);
    expect(
      (
        await sql.query(
          "SELECT COUNT(*) AS n FROM wallet_credit_lots WHERE ref = 'stripe:invoice:in_second'",
        )
      )[0]?.n,
    ).toBe(0);
  });

  test("generation tombstone prevents stale worker from clearing a new freeze", async () => {
    const { store, grant, ledger } = await fixture();
    await store.grant(grant);
    const stale = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    const current = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    expect(current).toBeGreaterThan(stale);
    await expect(
      store.refund({
        refundId: "re_test",
        grant,
        amountMicros: 20,
        cumulativeRefundedMicros: 20,
        fenceGeneration: stale,
      }),
    ).rejects.toThrow();
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
    await store.refund({
      refundId: "re_test",
      grant,
      amountMicros: 20,
      cumulativeRefundedMicros: 20,
      fenceGeneration: current,
    });
    const next = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    expect(next).toBeGreaterThan(current);
    await expect(
      store.refund({
        refundId: "re_test",
        grant,
        amountMicros: 20,
        cumulativeRefundedMicros: 20,
        fenceGeneration: current,
      }),
    ).rejects.toThrow();
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
  });

  test("concurrent claim returns each write's generation, never a later readback", async () => {
    const { sql, grant } = await fixture();
    let releaseFirst!: () => void;
    let enteredFirst!: () => void;
    const firstClaimEntered = new Promise<void>((resolve) => {
      enteredFirst = resolve;
    });
    const firstClaimRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let claims = 0;
    const interleaved: Sql = {
      query: (query, params) => sql.query(query, params),
      batch: (statements) => sql.batch(statements),
      async run(query, params) {
        const written = await sql.run(query, params);
        if (query.includes("INSERT INTO stripe_billing_fences") && ++claims === 1) {
          enteredFirst();
          await firstClaimRelease;
        }
        return written;
      },
    };
    const store = createStripeBillingStore({ sql: interleaved, clock });
    const first = store.freezeFunding(grant.organizationId, grant.fundingRef);
    await firstClaimEntered;
    const second = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    releaseFirst();
    expect(await first).toBe(1);
    expect(second).toBe(2);
    await expect(
      store.unfreezeFunding({
        organizationId: grant.organizationId,
        fundingRef: grant.fundingRef,
        fenceGeneration: 1,
        cumulativeRefundedMicros: 0,
      }),
    ).rejects.toThrow();
    await store.unfreezeFunding({
      organizationId: grant.organizationId,
      fundingRef: grant.fundingRef,
      fenceGeneration: 2,
      cumulativeRefundedMicros: 0,
    });
  });

  test("lost freeze acknowledgement cannot synthesize the winner's claim token", async () => {
    const { sql, grant } = await fixture();
    let lose = true;
    const unreliable: Sql = {
      query: (query, params) => sql.query(query, params),
      batch: (statements) => sql.batch(statements),
      async run(query, params) {
        const written = await sql.run(query, params);
        if (lose && query.includes("INSERT INTO stripe_billing_fences")) {
          lose = false;
          throw new SqlError("unavailable", "lost freeze acknowledgement");
        }
        return written;
      },
    };
    const store = createStripeBillingStore({ sql: unreliable, clock });
    await expect(store.freezeFunding(grant.organizationId, grant.fundingRef)).rejects.toThrow();
    expect(await store.freezeFunding(grant.organizationId, grant.fundingRef)).toBe(2);
  });

  test("verified no-refund scan and fully recorded refund can unfreeze exactly once", async () => {
    const { store, grant, ledger } = await fixture();
    const first = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    await store.grant(grant);
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
    await store.unfreezeFunding({
      organizationId: grant.organizationId,
      fundingRef: grant.fundingRef,
      fenceGeneration: first,
      cumulativeRefundedMicros: 0,
    });
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(100);
    const second = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    await store.refund({
      refundId: "re_test",
      grant,
      amountMicros: 30,
      cumulativeRefundedMicros: 30,
      fenceGeneration: second,
      releaseFreeze: false,
    });
    await expect(
      store.unfreezeFunding({
        organizationId: grant.organizationId,
        fundingRef: grant.fundingRef,
        fenceGeneration: second,
        cumulativeRefundedMicros: 29,
      }),
    ).rejects.toThrow();
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
    await store.unfreezeFunding({
      organizationId: grant.organizationId,
      fundingRef: grant.fundingRef,
      fenceGeneration: second,
      cumulativeRefundedMicros: 30,
    });
    await store.unfreezeFunding({
      organizationId: grant.organizationId,
      fundingRef: grant.fundingRef,
      fenceGeneration: second,
      cumulativeRefundedMicros: 30,
    });
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(70);
  });

  test("lost batch acknowledgement reads exact grant and refund proof", async () => {
    const { sql, grant, ledger } = await fixture();
    let dropGrant = true;
    let dropRefund = true;
    const flaky: Sql = {
      query: (query, params) => sql.query(query, params),
      run: (query, params) => sql.run(query, params),
      async batch(statements) {
        const result = await sql.batch(statements);
        if (
          dropGrant &&
          statements.some((statement) =>
            statement.sql.includes("INSERT INTO stripe_billing_grants"),
          )
        ) {
          dropGrant = false;
          throw new SqlError("unavailable", "lost grant acknowledgement");
        }
        if (
          dropRefund &&
          statements.some((statement) =>
            statement.sql.includes("INSERT INTO stripe_billing_refunds"),
          )
        ) {
          dropRefund = false;
          throw new SqlError("unavailable", "lost refund acknowledgement");
        }
        return result;
      },
    };
    const store = createStripeBillingStore({ sql: flaky, clock });
    await store.grant(grant);
    const generation = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    const result = await store.refund({
      refundId: "re_test",
      grant,
      amountMicros: 40,
      cumulativeRefundedMicros: 40,
      fenceGeneration: generation,
    });
    expect(result.debitMicros).toBe(40);
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(60);
    expect((await sql.query("SELECT COUNT(*) AS n FROM stripe_billing_refunds"))[0]?.n).toBe(1);
  });

  test("refund closes an Organization hold with an auditable closure reason", async () => {
    const { store, grant, ledger, sql } = await fixture();
    await store.grant(grant);
    expect(
      await ledger.hold({
        organizationId: grant.organizationId,
        reference: "org-hold:run",
        amountMicros: 50,
      }),
    ).toBe(true);
    await sql.run(
      `INSERT INTO org_wallet_holds
      (org_id, ref, ledger_ref, amount_micros, created_at, expires_at, state, money_policy)
      VALUES (?, 'run', 'org-hold:run', 50, ?, ?, 'live', 'usd-micros-v2')`,
      [grant.organizationId, start, "2026-10-15T00:00:00.000Z"],
    );
    const generation = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    await store.refund({
      refundId: "re_test",
      grant,
      amountMicros: 50,
      cumulativeRefundedMicros: 50,
      fenceGeneration: generation,
    });
    expect(
      (
        await sql.query(
          "SELECT state, closure_reason, released_micros FROM org_wallet_holds WHERE org_id = ? AND ref = 'run'",
          [grant.organizationId],
        )
      )[0],
    ).toMatchObject({ state: "released", closure_reason: "refund", released_micros: 50 });
    expect((await ledger.wallet(grant.organizationId)).heldMicros).toBe(0);
  });

  test("exact verified Checkout proof attaches to legacy direct lot without changing it", async () => {
    const { ledger, store, grant, sql } = await fixture();
    await ledger.fund({ consumptionClass: "purchased",
      organizationId: grant.organizationId,
      fundingRef: grant.fundingRef,
      amountMicros: grant.amountMicros,
    });
    const legacyGrant = { ...grant, expiresAt: null };
    await store.grant(legacyGrant);
    expect(
      (
        await sql.query(
          "SELECT kind, expires_at FROM wallet_credit_lots WHERE org_id = ? AND ref = ?",
          [grant.organizationId, grant.fundingRef],
        )
      )[0],
    ).toMatchObject({ kind: "direct", expires_at: null });
    expect(
      (
        await sql.query(
          "SELECT legacy_lot FROM stripe_billing_grants WHERE org_id = ? AND funding_ref = ?",
          [grant.organizationId, grant.fundingRef],
        )
      )[0]?.legacy_lot,
    ).toBe(1);
    const generation = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    await store.refund({
      refundId: "re_test",
      grant: legacyGrant,
      amountMicros: 100,
      cumulativeRefundedMicros: 100,
      fenceGeneration: generation,
    });
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
  });

  test("used refund blocks admission without drawing another Organization or lot", async () => {
    const { store, grant, ledger, sql } = await fixture();
    await store.grant(grant);
    await ledger.fund({ consumptionClass: "purchased",
      organizationId: grant.organizationId,
      fundingRef: "other",
      amountMicros: 40,
    });
    await ledger.fund({ consumptionClass: "purchased", organizationId: "org_other", fundingRef: "other", amountMicros: 40 });
    expect(
      await ledger.debitUsage({
        organizationId: grant.organizationId,
        reference: "spent",
        amountMicros: 80,
      }),
    ).toBe(true);
    const generation = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    const receipt = await store.refund({
      refundId: "re_test",
      grant,
      amountMicros: 100,
      cumulativeRefundedMicros: 100,
      fenceGeneration: generation,
    });
    expect(receipt).toMatchObject({ debitMicros: 20, receivableMicros: 80 });
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(40);
    expect(
      await ledger.hold({ organizationId: grant.organizationId, reference: "new", amountMicros: 1 }),
    ).toBe(false);
    expect(
      await ledger.debitUsage({
        organizationId: grant.organizationId,
        reference: "new",
        amountMicros: 1,
      }),
    ).toBe(false);
    expect(
      await ledger.hold({ organizationId: "org_other", reference: "new", amountMicros: 1 }),
    ).toBe(true);
    expect(
      (
        await sql.query(
          "SELECT amount_micros FROM wallet_credit_lots WHERE org_id = ? AND ref = 'other'",
          [grant.organizationId],
        )
      )[0]?.amount_micros,
    ).toBe(40);
  });

  test("concurrent refund and capture resolve once under the freeze", async () => {
    const { store, grant, ledger } = await fixture();
    await store.grant(grant);
    expect(
      await ledger.hold({
        organizationId: grant.organizationId,
        reference: "reservation",
        amountMicros: 70,
      }),
    ).toBe(true);
    const generation = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    const results = await Promise.allSettled([
      ledger.capture({
        organizationId: grant.organizationId,
        reference: "reservation",
        amountMicros: 70,
      }),
      store.refund({
        refundId: "re_test",
        grant,
        amountMicros: 100,
        cumulativeRefundedMicros: 100,
        fenceGeneration: generation,
      }),
    ]);
    expect(results[0]?.status).toBe("rejected");
    expect(results[1]?.status).toBe("fulfilled");
    expect((await ledger.wallet(grant.organizationId)).heldMicros).toBe(0);
    expect((await ledger.wallet(grant.organizationId)).availableMicros).toBe(0);
  });

  test("one-micro spent subscription credit becomes one-micro receivable", async () => {
    const { store, grant, ledger } = await fixture();
    const included: BillingGrant = {
      ...grant, sourceType: "invoice", sourceId: "in_micro",
      fundingRef: "stripe:invoice:in_micro", chargeId: "ch_micro",
      kind: "plan-included", amountMicros: 2, considerationMicros: 3,
      subscriptionId: "sub_micro", planKey: "configured-plan",
      pricingRevision: "configured-revision", stripePriceId: "price_configured",
      periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z",
    };
    await store.grant(included);
    expect(await ledger.debitUsage({ organizationId: included.organizationId,
      reference: "one-micro", amountMicros: 1 })).toBe(true);
    const generation = await store.freezeFunding(included.organizationId, included.fundingRef);
    const receipt = await store.refund({ refundId: "re_micro", grant: included,
      amountMicros: 3, cumulativeRefundedMicros: 3, fenceGeneration: generation });
    expect(receipt).toMatchObject({ targetRevokedMicros: 2, debitMicros: 1,
      receivableMicros: 1, expiredMicros: 0 });
    expect((await ledger.wallet(included.organizationId)).availableMicros).toBe(0);
  });

  test("free credit is consumed before subscription and purchased lots under a refund freeze", async () => {
    const { store, grant, ledger, sql } = await fixture();
    await ledger.fund({ organizationId: grant.organizationId, fundingRef: "free",
      kind: "plan-included", consumptionClass: "free", amountMicros: 1 });
    const included: BillingGrant = {
      ...grant, sourceType: "invoice", sourceId: "in_priority",
      fundingRef: "stripe:invoice:in_priority", chargeId: "ch_priority",
      kind: "plan-included", amountMicros: 2, considerationMicros: 2,
      subscriptionId: "sub_priority", planKey: "configured-plan",
      pricingRevision: "configured-revision", stripePriceId: "price_configured",
      periodStart: "2026-10-01T00:00:00.000Z", periodEnd: "2026-11-01T00:00:00.000Z",
    };
    await store.grant(included);
    await store.grant(grant);
    const generation = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    expect(await ledger.debitUsage({ organizationId: grant.organizationId,
      reference: "priority", amountMicros: 2 })).toBe(true);
    const allocation = await sql.query(
      "SELECT lot_ref, amount_micros FROM wallet_credit_allocations WHERE debit_type = 'usage_debit' AND debit_ref = 'priority' ORDER BY lot_ref",
    );
    expect(allocation).toEqual([
      { lot_ref: "free", amount_micros: 1 },
      { lot_ref: "stripe:invoice:in_priority", amount_micros: 1 },
    ]);
    expect((await ledger.wallet(grant.organizationId)).frozenMicros).toBe(100);
    await store.unfreezeFunding({ organizationId: grant.organizationId,
      fundingRef: grant.fundingRef, fenceGeneration: generation,
      cumulativeRefundedMicros: 0 });
  });

  test("grant batch rolls back proof and lot when aggregate wallet exceeds safe micros", async () => {
    const { store, grant, ledger, sql } = await fixture();
    await ledger.fund({ organizationId: grant.organizationId, fundingRef: "existing",
      kind: "purchased", consumptionClass: "purchased",
      amountMicros: Number.MAX_SAFE_INTEGER - 1 });
    const overflow: BillingGrant = { ...grant, fundingRef: "stripe:cs_overflow",
      sourceId: "cs_overflow", chargeId: "ch_overflow",
      amountMicros: 2, considerationMicros: 2 };
    await expect(store.grant(overflow)).rejects.toThrow();
    expect((await sql.query("SELECT 1 FROM stripe_billing_grants WHERE source_id = 'cs_overflow'")).length).toBe(0);
    expect((await sql.query("SELECT 1 FROM wallet_credit_lots WHERE ref = 'stripe:cs_overflow'")).length).toBe(0);
    expect((await ledger.wallet(grant.organizationId)).settledMicros).toBe(Number.MAX_SAFE_INTEGER - 1);
  });
});
