import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger } from "../src/ledger.ts";
import { createMetering } from "../src/metering.ts";

/**
 * Measurement is a fact; price is a decision. The meter keeps them apart, so a
 * deployment that has not decided what data costs still knows what it moved.
 */

async function meter(rates?: {
  bytesMinorPerGibibyte?: number;
  requestsMinorPerThousand?: number;
}) {
  const sql = createEphemeralSql();
  const clock = () => new Date(1_800_000_000_000);
  const ledger = createLedger(sql, clock);
  let counter = 0;
  const metering = createMetering({
    sql,
    ledger,
    clock,
    randomId: () => `id${++counter}`,
    ...(rates ? { rates } : {}),
  });
  await ledger.fund({ organizationId: "org_1", fundingRef: "seed", amountMinor: 100_000 });
  return { metering, ledger, sql };
}

const gibibyte = 1_024 * 1_024 * 1_024;

describe("metering", () => {
  test("counts a retried request once", async () => {
    const { metering, sql } = await meter();
    const usage = {
      requestId: "req_same",
      organizationId: "org_1",
      resourceUid: "uid_media",
      operation: "put",
      bytes: 10,
    };
    await metering.record(usage);
    await metering.record(usage);
    expect(await sql.query("SELECT COUNT(*) AS n FROM usage_events")).toEqual([{ n: 1 }]);
  });

  test("measures without charging when no price has been set", async () => {
    const { metering, ledger, sql } = await meter();
    await metering.record({
      requestId: "req_1",
      organizationId: "org_1",
      resourceUid: "uid_media",
      operation: "put",
      bytes: 5 * gibibyte,
    });
    expect(await metering.rollUp(100)).toBe(1);

    // The event is there; the wallet is untouched.
    const rows = await sql.query("SELECT quantity, rollup_id FROM usage_events");
    expect(rows[0]).toMatchObject({ quantity: 5 * gibibyte });
    expect(rows[0]?.rollup_id).not.toBeNull();
    expect((await ledger.wallet("org_1")).availableMinor).toBe(100_000);
  });

  test("folds many requests into one ledger entry", async () => {
    const { metering, ledger } = await meter({ bytesMinorPerGibibyte: 100 });
    for (let index = 0; index < 20; index += 1) {
      await metering.record({
        requestId: `req_${index}`,
        organizationId: "org_1",
        resourceUid: "uid_media",
        operation: "get",
        bytes: gibibyte / 2,
      });
    }
    expect(await metering.rollUp(100)).toBe(20);

    const wallet = await ledger.wallet("org_1");
    // 20 × half a gibibyte at 100 per gibibyte is 1,000 — charged once.
    expect(wallet.availableMinor).toBe(99_000);
    expect(wallet.entries.filter((entry) => entry.type === "usage_debit")).toHaveLength(1);
  });

  test("does not round a fraction of a cent up on every request", async () => {
    const { metering, ledger } = await meter({ bytesMinorPerGibibyte: 100 });
    // A thousand small reads. Rounded per request each would cost a whole
    // minor unit; rounded once they cost what they cost.
    for (let index = 0; index < 1_000; index += 1) {
      await metering.record({
        requestId: `small_${index}`,
        organizationId: "org_1",
        resourceUid: "uid_media",
        operation: "get",
        bytes: 1_024,
      });
    }
    await metering.rollUp(2_000);
    expect((await ledger.wallet("org_1")).availableMinor).toBe(100_000);
  });

  test("folding twice charges once", async () => {
    const { metering, ledger } = await meter({ requestsMinorPerThousand: 1_000 });
    for (let index = 0; index < 5; index += 1) {
      await metering.record({
        requestId: `r${index}`,
        organizationId: "org_1",
        resourceUid: "uid_media",
        operation: "head",
        bytes: 0,
      });
    }
    expect(await metering.rollUp(100)).toBe(5);
    expect(await metering.rollUp(100)).toBe(0);
    expect((await ledger.wallet("org_1")).availableMinor).toBe(99_995);
  });

  test("keeps organizations apart", async () => {
    const { metering, ledger } = await meter({ bytesMinorPerGibibyte: 1_000 });
    await ledger.fund({ organizationId: "org_2", fundingRef: "seed2", amountMinor: 100_000 });
    await metering.record({
      requestId: "a",
      organizationId: "org_1",
      resourceUid: "uid_a",
      operation: "get",
      bytes: gibibyte,
    });
    await metering.record({
      requestId: "b",
      organizationId: "org_2",
      resourceUid: "uid_b",
      operation: "get",
      bytes: 2 * gibibyte,
    });
    await metering.rollUp(100);
    expect((await ledger.wallet("org_1")).availableMinor).toBe(99_000);
    expect((await ledger.wallet("org_2")).availableMinor).toBe(98_000);
  });
});
