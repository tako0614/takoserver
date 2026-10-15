import { describe, expect, test } from "bun:test";
import { createEphemeralSql } from "../src/compat.ts";
import { createLedger, prepareLedgerAllocation } from "../src/ledger.ts";
import { createMetering } from "../src/metering.ts";
import { minorToMicros } from "../src/money.ts";
import type { Sql } from "../src/ports.ts";

/**
 * Measurement is a fact; price is a decision. The meter keeps them apart, so a
 * deployment that has not decided what data costs still knows what it moved.
 */

async function meter(
  rates?: {
    bytesMinorPerGibibyte?: number;
    requestsMinorPerThousand?: number;
  },
  wrapSql: (sql: Sql) => Sql = (sql) => sql,
) {
  const sql = createEphemeralSql();
  const clock = () => new Date(1_800_000_000_000);
  const ledger = createLedger(sql, clock);
  let counter = 0;
  const metering = createMetering({
    sql: wrapSql(sql),
    ledger,
    clock,
    randomId: () => `id${++counter}`,
    ...(rates ? { rates } : {}),
  });
  await ledger.fund({
    organizationId: "org_1",
    fundingRef: "seed",
    amountMicros: minorToMicros(100_000),
    kind: "purchased",
    consumptionClass: "purchased",
  });
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
    expect((await ledger.wallet("org_1")).availableMicros).toBe(minorToMicros(100_000));
  });

  test("rejects a reused zero-cost rollup reference without claiming new rows", async () => {
    const { metering, ledger, sql } = await meter();
    await metering.record({
      requestId: "zero_first",
      organizationId: "org_1",
      resourceUid: "uid_media",
      operation: "get",
      bytes: 0,
    });
    expect(await metering.rollUp(100)).toBe(1);
    expect(await sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type = 'usage_debit'")).toEqual([
      { n: 0 },
    ]);

    const reusedReference = createMetering({
      sql,
      ledger,
      clock: () => new Date(1_800_000_000_000),
      randomId: () => "id1",
    });
    await reusedReference.record({
      requestId: "zero_second",
      organizationId: "org_1",
      resourceUid: "uid_media",
      operation: "get",
      bytes: 0,
    });
    await expect(reusedReference.rollUp(100)).rejects.toMatchObject({ code: "constraint" });
    expect(
      await sql.query("SELECT request_id, rollup_id FROM usage_events ORDER BY request_id"),
    ).toEqual([
      { request_id: "zero_first", rollup_id: "roll_id1" },
      { request_id: "zero_second", rollup_id: null },
    ]);
    expect(await sql.query("SELECT COUNT(*) AS n FROM wallet_allocation_guards")).toEqual([
      { n: 0 },
    ]);
    expect(await sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type = 'usage_debit'")).toEqual([
      { n: 0 },
    ]);
    expect(await metering.rollUp(100)).toBe(1);
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
    expect(wallet.availableMicros).toBe(minorToMicros(99_000));
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
    // Exact 1000*1024/GiB * 100 cents is 953.67431640625 USD micros.
    expect((await ledger.wallet("org_1")).availableMicros).toBe(minorToMicros(100_000) - 954);
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
    expect((await ledger.wallet("org_1")).availableMicros).toBe(minorToMicros(99_995));
  });

  test("a partial concurrent claim rolls back this fold and retries only pending rows", async () => {
    let raced = false;
    const { metering, ledger, sql } = await meter({ requestsMinorPerThousand: 1_000 }, (base) => ({
      ...base,
      async batch(statements) {
        if (
          !raced &&
          statements.some((statement) =>
            statement.sql.includes("UPDATE usage_events SET rollup_id"),
          )
        ) {
          raced = true;
          // Another fold wins only one of the two rows after this fold's
          // advisory read, with its own claim and debit committed together.
          const winner = await prepareLedgerAllocation(base, {
            organizationId: "org_1",
            type: "usage_debit",
            reference: "roll_winner",
            amountMicros: 10_000,
            settledDeltaMicros: -10_000,
            heldDeltaMicros: 0,
            now: new Date(1_800_000_000_000).toISOString(),
          });
          await base.batch([
            {
              sql: "UPDATE usage_events SET rollup_id = ? WHERE request_id = ? AND rollup_id IS NULL",
              params: ["roll_winner", "race_b"],
            },
            ...winner,
          ]);
        }
        return base.batch(statements);
      },
    }));
    for (const requestId of ["race_a", "race_b"]) {
      await metering.record({
        requestId,
        organizationId: "org_1",
        resourceUid: "uid_media",
        operation: "get",
        bytes: 0,
      });
    }

    await expect(metering.rollUp(100)).rejects.toMatchObject({ code: "constraint" });
    expect(
      await sql.query("SELECT request_id, rollup_id FROM usage_events ORDER BY request_id"),
    ).toEqual([
      { request_id: "race_a", rollup_id: null },
      { request_id: "race_b", rollup_id: "roll_winner" },
    ]);
    expect(
      (await ledger.wallet("org_1")).entries.filter((entry) => entry.type === "usage_debit"),
    ).toHaveLength(1);

    expect(await metering.rollUp(100)).toBe(1);
    const wallet = await ledger.wallet("org_1");
    expect(wallet.availableMicros).toBe(minorToMicros(100_000) - 20_000);
    expect(wallet.entries.filter((entry) => entry.type === "usage_debit")).toHaveLength(2);
  });

  test("a failure after the claim and debit statements rolls back the whole batch", async () => {
    let failBeforeCommit = true;
    const { metering, ledger, sql } = await meter({ requestsMinorPerThousand: 1_000 }, (base) => ({
      ...base,
      batch(statements) {
        if (
          failBeforeCommit &&
          statements.some((statement) =>
            statement.sql.includes("UPDATE usage_events SET rollup_id"),
          )
        ) {
          failBeforeCommit = false;
          return base.batch([
            ...statements,
            {
              sql: "INSERT INTO wallet_allocation_guards (id, valid) VALUES ('forced_failure', 0)",
            },
          ]);
        }
        return base.batch(statements);
      },
    }));
    await metering.record({
      requestId: "before_commit",
      organizationId: "org_1",
      resourceUid: "uid_media",
      operation: "get",
      bytes: 0,
    });

    await expect(metering.rollUp(100)).rejects.toMatchObject({ code: "constraint" });
    expect(await sql.query("SELECT rollup_id FROM usage_events")).toEqual([{ rollup_id: null }]);
    expect(await sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type = 'usage_debit'")).toEqual([
      { n: 0 },
    ]);
    expect(
      await sql.query(
        "SELECT COUNT(*) AS n FROM wallet_credit_allocations WHERE debit_type = 'usage_debit'",
      ),
    ).toEqual([{ n: 0 }]);
    expect(await sql.query("SELECT COUNT(*) AS n FROM wallet_allocation_guards")).toEqual([
      { n: 0 },
    ]);
    expect((await ledger.wallet("org_1")).availableMicros).toBe(minorToMicros(100_000));
    expect(await metering.rollUp(100)).toBe(1);
  });

  test("a lost acknowledgement after commit cannot debit the same rows again", async () => {
    let loseAcknowledgement = true;
    const { metering, ledger, sql } = await meter({ requestsMinorPerThousand: 1_000 }, (base) => ({
      ...base,
      async batch(statements) {
        const result = await base.batch(statements);
        if (
          loseAcknowledgement &&
          statements.some((statement) =>
            statement.sql.includes("UPDATE usage_events SET rollup_id"),
          )
        ) {
          loseAcknowledgement = false;
          throw new Error("lost batch acknowledgement");
        }
        return result;
      },
    }));
    await metering.record({
      requestId: "lost_ack",
      organizationId: "org_1",
      resourceUid: "uid_media",
      operation: "get",
      bytes: 0,
    });

    await expect(metering.rollUp(100)).rejects.toThrow("lost batch acknowledgement");
    expect(await sql.query("SELECT rollup_id FROM usage_events")).toEqual([
      { rollup_id: "roll_id1" },
    ]);
    expect(await metering.rollUp(100)).toBe(0);
    expect((await ledger.wallet("org_1")).availableMicros).toBe(minorToMicros(100_000) - 10_000);
    expect(await sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type = 'usage_debit'")).toEqual([
      { n: 1 },
    ]);
  });

  test("returns an unfunded usage fold to the pending queue", async () => {
    const { metering, ledger, sql } = await meter({
      bytesMinorPerGibibyte: 200_000,
    });
    await metering.record({
      requestId: "unfunded",
      organizationId: "org_1",
      resourceUid: "uid_media",
      operation: "get",
      bytes: gibibyte,
    });

    await expect(metering.rollUp(100)).rejects.toMatchObject({
      code: "insufficient_funds",
    });
    expect(await sql.query("SELECT rollup_id FROM usage_events")).toEqual([{ rollup_id: null }]);
    expect((await ledger.wallet("org_1")).availableMicros).toBe(minorToMicros(100_000));
  });

  test("keeps organizations apart", async () => {
    const { metering, ledger } = await meter({ bytesMinorPerGibibyte: 1_000 });
    await ledger.fund({
      organizationId: "org_2",
      fundingRef: "seed2",
      amountMicros: minorToMicros(100_000),
      kind: "purchased",
      consumptionClass: "purchased",
    });
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
    expect((await ledger.wallet("org_1")).availableMicros).toBe(minorToMicros(99_000));
    expect((await ledger.wallet("org_2")).availableMicros).toBe(minorToMicros(98_000));
  });
});
