import { beforeEach, describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger, type Ledger, LedgerError } from "../src/ledger.ts";
import type { Sql } from "../src/ports.ts";

let sql: Sql;
let ledger: Ledger;
let tick = 0;

beforeEach(() => {
  sql = createEphemeralSql();
  tick = 0;
  // Entries are ordered by their timestamp, so the clock must advance.
  ledger = createLedger(sql, () => new Date(Date.UTC(2026, 7, 17) + tick++ * 1_000));
});

describe("prepaid wallet", () => {
  test("conserves money across the whole reservation lifecycle", async () => {
    await ledger.fund({ organizationId: "org_a", fundingRef: "pay_1", amountMinor: 10_000 });

    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMinor: 4_000 }),
    ).toBe(true);
    let wallet = await ledger.wallet("org_a");
    expect(wallet).toMatchObject({ settledMinor: 10_000, heldMinor: 4_000, availableMinor: 6_000 });

    await ledger.capture({ organizationId: "org_a", reference: "rsv_1", amountMinor: 4_000 });
    wallet = await ledger.wallet("org_a");
    // Capture removes the hold and the settled funds together, so credited
    // equals available plus held plus captured at every point.
    expect(wallet).toMatchObject({ settledMinor: 6_000, heldMinor: 0, availableMinor: 6_000 });

    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_2", amountMinor: 6_000 }),
    ).toBe(true);
    await ledger.release({ organizationId: "org_a", reference: "rsv_2", amountMinor: 6_000 });
    wallet = await ledger.wallet("org_a");
    expect(wallet).toMatchObject({ settledMinor: 6_000, heldMinor: 0, availableMinor: 6_000 });
  });

  test("refuses a hold the balance cannot cover, before writing anything", async () => {
    await ledger.fund({ organizationId: "org_a", fundingRef: "pay_1", amountMinor: 1_000 });

    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMinor: 1_001 }),
    ).toBe(false);
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMinor: 0, availableMinor: 1_000 });

    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMinor: 1_000 }),
    ).toBe(true);
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMinor: 1_000, availableMinor: 0 });
  });

  test("cannot hold the same funds twice", async () => {
    await ledger.fund({ organizationId: "org_a", fundingRef: "pay_1", amountMinor: 1_000 });
    expect(await ledger.hold({ organizationId: "org_a", reference: "a", amountMinor: 600 })).toBe(
      true,
    );
    // 400 remains, so the second 600 must lose outright rather than overdraw.
    expect(await ledger.hold({ organizationId: "org_a", reference: "b", amountMinor: 600 })).toBe(
      false,
    );
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMinor: 600, availableMinor: 400 });
  });

  test("treats every money operation as idempotent by reference", async () => {
    await ledger.fund({ organizationId: "org_a", fundingRef: "pay_1", amountMinor: 5_000 });
    await ledger.fund({ organizationId: "org_a", fundingRef: "pay_1", amountMinor: 5_000 });
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMinor: 5_000 });

    // A retried hold reports success without earmarking a second time.
    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMinor: 2_000 }),
    ).toBe(true);
    expect(
      await ledger.hold({ organizationId: "org_a", reference: "rsv_1", amountMinor: 2_000 }),
    ).toBe(true);
    expect(await ledger.wallet("org_a")).toMatchObject({ heldMinor: 2_000 });

    await ledger.capture({ organizationId: "org_a", reference: "rsv_1", amountMinor: 2_000 });
    await ledger.capture({ organizationId: "org_a", reference: "rsv_1", amountMinor: 2_000 });
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMinor: 3_000, heldMinor: 0 });
  });

  test("keeps organizations separate", async () => {
    await ledger.fund({ organizationId: "org_a", fundingRef: "pay_1", amountMinor: 1_000 });
    expect(await ledger.wallet("org_b")).toMatchObject({
      settledMinor: 0,
      heldMinor: 0,
      availableMinor: 0,
      entries: [],
    });
    expect(await ledger.hold({ organizationId: "org_b", reference: "rsv_1", amountMinor: 1 })).toBe(
      false,
    );
  });

  test("charges metered usage against settled funds", async () => {
    await ledger.fund({ organizationId: "org_a", fundingRef: "pay_1", amountMinor: 500 });
    await ledger.debitUsage({ organizationId: "org_a", reference: "usage_1", amountMinor: 120 });
    await ledger.debitUsage({ organizationId: "org_a", reference: "usage_1", amountMinor: 120 });
    expect(await ledger.wallet("org_a")).toMatchObject({ settledMinor: 380, availableMinor: 380 });
  });

  test("refuses a nonsense amount rather than recording it", async () => {
    for (const amountMinor of [0, -1, 1.5, Number.NaN]) {
      await expect(
        ledger.fund({ organizationId: "org_a", fundingRef: `pay_${amountMinor}`, amountMinor }),
      ).rejects.toBeInstanceOf(LedgerError);
    }
  });
});
