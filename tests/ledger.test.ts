import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  createLedger,
  type Ledger,
  LedgerError,
  ledgerHoldReleaseCommittedFence,
  prepareLedgerHoldRelease,
} from "../src/ledger.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const preparation = readFileSync(
  new URL("../migrations/0093_wallet_credit_classification_proofs.sql", import.meta.url),
  "utf8",
);
const migration = readFileSync(
  new URL("../migrations/0094_wallet_usd_micros.sql", import.meta.url),
  "utf8",
);

function createMicrosSql(): Sql {
  const database = new Database(":memory:");
  for (const entry of MIGRATIONS.filter(({ name }) => name <= "0092_org_wallet_lifecycle.sql")) {
    database.exec(entry.sql);
  }
  database.exec(preparation);
  database.exec(migration);
  return createSqliteSql(database);
}

let sql: Sql;
let ledger: Ledger;
let tick = 0;

beforeEach(() => {
  sql = createMicrosSql();
  tick = 0;
  // Entries are ordered by their timestamp, so the clock must advance.
  ledger = createLedger(sql, () => new Date(Date.UTC(2026, 7, 17) + tick++ * 1_000));
});

describe("prepaid wallet", () => {
  test("conserves money across the whole reservation lifecycle", async () => {
    await ledger.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "pay_1",
      amountMicros: 10_000,
    });

    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMicros: 4_000 }),
    ).toBe(true);
    let wallet = await ledger.wallet("org_a");
    expect(wallet).toMatchObject({
      settledMicros: 10_000,
      heldMicros: 4_000,
      availableMicros: 6_000,
    });

    await ledger.capture({ organizationId: "org_a", reference: "rsv_1", amountMicros: 4_000 });
    wallet = await ledger.wallet("org_a");
    // Capture removes the hold and the settled funds together, so credited
    // equals available plus held plus captured at every point.
    expect(wallet).toMatchObject({ settledMicros: 6_000, heldMicros: 0, availableMicros: 6_000 });

    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_2", amountMicros: 6_000 }),
    ).toBe(true);
    await ledger.release({ organizationId: "org_a", reference: "rsv_2", amountMicros: 6_000 });
    wallet = await ledger.wallet("org_a");
    expect(wallet).toMatchObject({ settledMicros: 6_000, heldMicros: 0, availableMicros: 6_000 });
  });

  test("refuses a hold the balance cannot cover, before writing anything", async () => {
    await ledger.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "pay_1",
      amountMicros: 1_000,
    });

    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMicros: 1_001 }),
    ).toBe(false);
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMicros: 0, availableMicros: 1_000 });

    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMicros: 1_000 }),
    ).toBe(true);
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMicros: 1_000, availableMicros: 0 });
  });

  test("cannot hold the same funds twice", async () => {
    await ledger.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "pay_1",
      amountMicros: 1_000,
    });
    expect(await ledger.hold({ organizationId: "org_a", reference: "a", amountMicros: 600 })).toBe(
      true,
    );
    // 400 remains, so the second 600 must lose outright rather than overdraw.
    expect(await ledger.hold({ organizationId: "org_a", reference: "b", amountMicros: 600 })).toBe(
      false,
    );
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMicros: 600, availableMicros: 400 });
  });

  test("treats every money operation as idempotent by reference", async () => {
    await ledger.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "pay_1",
      amountMicros: 5_000,
    });
    await ledger.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "pay_1",
      amountMicros: 5_000,
    });
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMicros: 5_000 });

    // A retried hold reports success without earmarking a second time.
    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMicros: 2_000 }),
    ).toBe(true);
    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMicros: 2_000 }),
    ).toBe(true);
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMicros: 2_000 });

    await ledger.capture({ organizationId: "org_a", reference: "rsv_1", amountMicros: 2_000 });
    await ledger.capture({ organizationId: "org_a", reference: "rsv_1", amountMicros: 2_000 });
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMicros: 3_000, heldMicros: 0 });

    await expect(
      ledger.fund({
        organizationId: "org_a",
        fundingRef: "pay_1",
        amountMicros: 5_000,
        kind: "direct",
        consumptionClass: "free",
      }),
    ).rejects.toBeInstanceOf(LedgerError);
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMicros: 3_000 });
  });

  test("keeps organizations separate", async () => {
    await ledger.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "pay_1",
      amountMicros: 1_000,
    });
    expect(await ledger.wallet("org_b")).toMatchObject({
      settledMicros: 0,
      heldMicros: 0,
      availableMicros: 0,
      entries: [],
    });
    expect(
      await ledger.hold({ organizationId: "org_b", reference: "rsv_1", amountMicros: 1 }),
    ).toBe(false);
  });

  test("converts a commercial-cent hold release exactly at the ledger boundary", async () => {
    await ledger.fund({
      organizationId: "org_a",
      fundingRef: "cash",
      amountMicros: 10_000,
      kind: "purchased",
      consumptionClass: "purchased",
    });
    expect(
      await ledger.hold({ organizationId: "org_a", reference: "quote", amountMicros: 10_000 }),
    ).toBe(true);
    const input = { organizationId: "org_a", reference: "quote", amountMinor: 1 };
    const planned = await prepareLedgerHoldRelease(
      sql,
      () => new Date("2026-08-17T00:10:00.000Z"),
      input,
    );
    expect(ledgerHoldReleaseCommittedFence(input).params[2]).toBe(10_000);
    await sql.batch(planned.statements);
    expect(
      await sql.query(
        `SELECT 1 AS ok WHERE ${planned.committedFence.sql}`,
        planned.committedFence.params,
      ),
    ).toEqual([{ ok: 1 }]);
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMicros: 10_000, heldMicros: 0 });
    expect(() =>
      ledgerHoldReleaseCommittedFence({ ...input, amountMinor: 900_719_925_475 }),
    ).toThrow(LedgerError);
  });

  test("charges metered usage against settled funds", async () => {
    await ledger.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "pay_1",
      amountMicros: 500,
    });
    await ledger.debitUsage({ organizationId: "org_a", reference: "usage_1", amountMicros: 120 });
    await ledger.debitUsage({ organizationId: "org_a", reference: "usage_1", amountMicros: 120 });
    expect(await ledger.wallet("org_a")).toMatchObject({
      settledMicros: 380,
      availableMicros: 380,
    });
  });

  test("spends one micro and applies free, subscription, purchased priority before expiry", async () => {
    const organizationId = "org_priority";
    await ledger.fund({
      organizationId,
      fundingRef: "purchase-early-expiry",
      kind: "purchased",
      consumptionClass: "purchased",
      amountMicros: 5,
      expiresAt: "2026-08-17T00:10:00.000Z",
    });
    await ledger.fund({
      organizationId,
      fundingRef: "subscription",
      kind: "plan-included",
      consumptionClass: "subscription",
      amountMicros: 3,
      expiresAt: "2026-08-18T00:00:00.000Z",
    });
    await ledger.fund({
      organizationId,
      fundingRef: "free",
      kind: "plan-included",
      consumptionClass: "free",
      amountMicros: 1,
      expiresAt: "2026-08-19T00:00:00.000Z",
    });
    expect(
      await ledger.debitUsage({ organizationId, reference: "one-micro", amountMicros: 1 }),
    ).toBe(true);
    expect(await ledger.hold({ organizationId, reference: "h", amountMicros: 4 })).toBe(true);
    expect(
      await sql.query(
        `SELECT debit_ref, lot_ref, amount_micros FROM wallet_credit_allocations
       WHERE org_id = ? ORDER BY debit_ref, lot_ref`,
        [organizationId],
      ),
    ).toEqual([
      { debit_ref: "h", lot_ref: "purchase-early-expiry", amount_micros: 1 },
      { debit_ref: "h", lot_ref: "subscription", amount_micros: 3 },
      { debit_ref: "one-micro", lot_ref: "free", amount_micros: 1 },
    ]);
    await ledger.capture({ organizationId, reference: "h", amountMicros: 2 });
    await ledger.release({ organizationId, reference: "h", amountMicros: 2 });
    expect(
      await sql.query(
        `SELECT lot_ref, amount_micros FROM wallet_credit_allocations
       WHERE org_id = ? AND debit_type = 'capture'`,
        [organizationId],
      ),
    ).toEqual([{ lot_ref: "subscription", amount_micros: 2 }]);
    expect(await ledger.wallet(organizationId)).toMatchObject({
      settledMicros: 6,
      heldMicros: 0,
      availableMicros: 6,
    });
  });

  test("refuses metered usage that would overdraw prepaid funds", async () => {
    await ledger.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "pay_1",
      amountMicros: 100,
    });

    expect(
      await ledger.debitUsage({
        organizationId: "org_a",
        reference: "usage_too_large",
        amountMicros: 101,
      }),
    ).toBe(false);
    expect(await ledger.wallet("org_a")).toMatchObject({
      settledMicros: 100,
      heldMicros: 0,
      availableMicros: 100,
    });
  });

  test("expires only unused included credit and keeps purchased credit", async () => {
    const durable = createMicrosSql();
    let now = new Date("2026-08-17T00:00:00.000Z");
    const expiring = createLedger(durable, () => now);
    await expiring.fund({
      consumptionClass: "free",
      organizationId: "org_a",
      fundingRef: "included:cycle-1",
      amountMicros: 100,
      kind: "plan-included",
      expiresAt: "2026-08-17T01:00:00.000Z",
    });
    await expiring.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "purchase:1",
      amountMicros: 50,
      kind: "purchased",
      expiresAt: null,
    });
    expect(
      await expiring.debitUsage({
        organizationId: "org_a",
        reference: "usage_before_expiry",
        amountMicros: 40,
      }),
    ).toBe(true);
    expect(await expiring.wallet("org_a")).toMatchObject({ availableMicros: 110 });

    now = new Date("2026-08-17T02:00:00.000Z");
    expect(await expiring.wallet("org_a")).toMatchObject({ availableMicros: 50 });
    expect(
      await expiring.debitUsage({
        organizationId: "org_a",
        reference: "usage_after_expiry",
        amountMicros: 50,
      }),
    ).toBe(true);
    expect(await expiring.wallet("org_a")).toMatchObject({ availableMicros: 0 });
  });

  test("keeps an expiring credit lot reserved until its hold is captured or released", async () => {
    const durable = createMicrosSql();
    let now = new Date("2026-08-17T00:00:00.000Z");
    const expiring = createLedger(durable, () => now);
    await expiring.fund({
      consumptionClass: "free",
      organizationId: "org_a",
      fundingRef: "included:cycle-1",
      amountMicros: 100,
      kind: "plan-included",
      expiresAt: "2026-08-17T01:00:00.000Z",
    });
    await expiring.fund({
      consumptionClass: "purchased",
      organizationId: "org_a",
      fundingRef: "purchase:1",
      amountMicros: 50,
      kind: "purchased",
      expiresAt: null,
    });

    expect(
      await expiring.hold({ organizationId: "org_a", reference: "request:1", amountMicros: 80 }),
    ).toBe(true);
    now = new Date("2026-08-17T02:00:00.000Z");
    expect(await expiring.wallet("org_a")).toMatchObject({
      settledMicros: 130,
      heldMicros: 80,
      availableMicros: 50,
    });

    await expiring.capture({ organizationId: "org_a", reference: "request:1", amountMicros: 30 });
    await expiring.release({ organizationId: "org_a", reference: "request:1", amountMicros: 50 });
    expect(await expiring.wallet("org_a")).toMatchObject({
      settledMicros: 50,
      heldMicros: 0,
      availableMicros: 50,
    });
  });

  test("refuses a nonsense amount rather than recording it", async () => {
    for (const amountMicros of [0, -1, 1.5, Number.NaN]) {
      await expect(
        ledger.fund({
          consumptionClass: "purchased",
          organizationId: "org_a",
          fundingRef: `pay_${amountMicros}`,
          amountMicros,
        }),
      ).rejects.toBeInstanceOf(LedgerError);
    }
    await expect(
      ledger.fund({
        organizationId: "org_a",
        fundingRef: "bad-expiry",
        amountMicros: 1,
        kind: "plan-included",
        consumptionClass: "free",
        expiresAt: "2026-8-18",
      }),
    ).rejects.toBeInstanceOf(LedgerError);
  });

  test("rolls back a funding that would exceed the safe wallet aggregate", async () => {
    await ledger.fund({
      organizationId: "org_a",
      fundingRef: "near-bound",
      amountMicros: Number.MAX_SAFE_INTEGER - 1,
      kind: "purchased",
      consumptionClass: "purchased",
    });
    await expect(
      ledger.fund({
        organizationId: "org_a",
        fundingRef: "over-bound",
        amountMicros: 2,
        kind: "purchased",
        consumptionClass: "purchased",
      }),
    ).rejects.toThrow();
    expect(await ledger.wallet("org_a")).toMatchObject({
      settledMicros: Number.MAX_SAFE_INTEGER - 1,
      heldMicros: 0,
    });
    expect(await ledger.hasFunding({ organizationId: "org_a", fundingRef: "over-bound" })).toBe(
      false,
    );
    expect(
      await sql.query("SELECT ref FROM wallet_credit_lots WHERE org_id = ? AND ref = ?", [
        "org_a",
        "over-bound",
      ]),
    ).toEqual([]);
    expect(
      await sql.query("SELECT id FROM wallet_allocation_guards WHERE id LIKE 'guard_%'"),
    ).toEqual([]);
  });
});
