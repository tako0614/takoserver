import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import {
  buildFinancialR1AttemptCustodyStatement,
  buildFinancialR1BoundedAttemptCustodyStatement,
  createFinancialR1AttemptDataReader,
} from "../src/shared-financial-retained-r1.ts";
import {
  ACTIONS,
  AT,
  count,
  EPOCH,
  fixture,
  SCOPE,
} from "./helpers/financial-r1-custody-fixture.ts";

const TABLE = "financial_r1_preparation_attempts";
const COLUMNS = [
  "r1_ref",
  "challenge_ref",
  "preparation_ref",
  "receipt_ref",
  "action_kind",
  "organization_id",
  "action_reference",
  "request_fingerprint",
  "command_json",
  "command_digest",
  "scope_json",
  "writer_epoch",
  "recorded_at",
] as const;

describe("Financial bounded claim SQL DATA", () => {
  for (const action of ACTIONS) {
    test(`${action.kind} connects the existing consumer entry to the exact13 Money postimage with16 semantic binds`, async () => {
      const old = await fixture(),
        current = await fixture();
      try {
        const left = await old.command(action, "bounded-equivalent"),
          right = await current.command(action, "bounded-equivalent");
        expect(left).toEqual(right);
        const legacy = await buildFinancialR1AttemptCustodyStatement(old.options, left, AT);
        const before = [current.writes, current.providerRequests, current.clocks];
        const bounded = await buildFinancialR1BoundedAttemptCustodyStatement(
          current.options,
          right,
          AT,
        );
        expect([current.writes, current.providerRequests, current.clocks]).toEqual(before);
        expect(legacy.params).toHaveLength(16);
        expect(legacy).toEqual(bounded);
        expect(bounded.params).toHaveLength(16);
        expect(bounded.sql.match(/\?/gu)).toHaveLength(16);
        const actual = await current.sql.run(bounded.sql, bounded.params),
          previous = await old.sql.run(legacy.sql, legacy.params);
        expect(actual.changes).toBe(1);
        expect(actual.rows).toHaveLength(1);
        expect(Object.keys(actual.rows[0]!).sort()).toEqual([...COLUMNS].sort());
        expect(actual).toEqual(previous);
        expect(count(current.db, TABLE)).toBe(1);
        const read = await createFinancialR1AttemptDataReader(
          current.options,
        ).readOriginalAttemptData(right);
        expect(read.status).toBe("found");
        if (read.status !== "found") throw Error("missing bounded claim");
        expect(read.fullCommandJson).toBe(canonicalJson(right));
      } finally {
        old.close();
        current.close();
      }
    });
  }
  test("equal-looking business namespace values retain distinct semantic input slots", async () => {
    const f = await fixture();
    try {
      const action = { ...ACTIONS[0]!, reference: "topup" };
      const command = await f.command(action, "bounded-equal-values");
      const s = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, command, AT);
      expect(s.params).toHaveLength(16);
      expect(s.params?.[4]).toBe("topup");
      expect(s.params?.[6]).toBe("topup");
      expect((await f.sql.run(s.sql, s.params)).changes).toBe(1);
    } finally {
      f.close();
    }
  });
  test("same-original replay and a re-keyed changed body cannot replace the original business claim", async () => {
    const f = await fixture();
    try {
      const first = await f.command(ACTIONS[0]!, "bounded-first");
      const a = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, first, AT);
      expect((await f.sql.run(a.sql, a.params)).changes).toBe(1);
      expect((await f.sql.run(a.sql, a.params)).changes).toBe(0);
      const topup = ACTIONS.find((action) => action.kind === "topup");
      if (!topup) throw Error("missing topup fixture");
      const next = await f.command({ ...topup, amountMinor: 6000 }, "bounded-second");
      const b = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, next, AT);
      expect((await f.sql.run(b.sql, b.params)).changes).toBe(0);
      expect(count(f.db, TABLE)).toBe(1);
      expect(f.db.query(`SELECT command_json FROM ${TABLE}`).get()).toEqual({
        command_json: canonicalJson(first),
      });
    } finally {
      f.close();
    }
  });
  test("a role occupied by another business claim is held", async () => {
    const f = await fixture();
    try {
      const first = await f.command(ACTIONS[0]!, "bounded-role-first");
      const a = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, first, AT);
      await f.sql.run(a.sql, a.params);
      const original = await f.command(
        { ...ACTIONS[0]!, reference: "other-business" },
        "bounded-role-second",
      );
      const next = {
        ...original,
        key: { ...original.key, r1Ref: first.key.challengeRef },
        original: { ...original.original, r1Ref: first.key.challengeRef },
      };
      const b = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, next, AT);
      expect((await f.sql.run(b.sql, b.params)).changes).toBe(0);
      expect(count(f.db, TABLE)).toBe(1);
    } finally {
      f.close();
    }
  });
  test("actual Money S freeze refuses the CTE claim without a row or a retained permit", async () => {
    const f = await fixture();
    try {
      const c = await f.command(ACTIONS[0]!, "bounded-freeze");
      const s = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, c, AT);
      await f.base.run("INSERT INTO money_cutover_freeze VALUES(1,?,?,?,?,?)", [
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
      ]);
      await expect(f.sql.run(s.sql, s.params)).rejects.toThrow();
      expect(count(f.db, TABLE)).toBe(0);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });
  test("epoch rotation refuses the old CTE claim", async () => {
    const f = await fixture();
    try {
      const c = await f.command(ACTIONS[0]!, "bounded-epoch");
      const s = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, c, AT);
      await f.base.run(
        "UPDATE money_cutover_authorized_epoch SET writer_epoch=? WHERE singleton=1",
        [`sha256:${"e".repeat(64)}`],
      );
      await expect(f.sql.run(s.sql, s.params)).rejects.toThrow();
      expect(count(f.db, TABLE)).toBe(0);
    } finally {
      f.close();
    }
  });
  test("committed acknowledgement loss recovers only the held original and does not write again", async () => {
    const f = await fixture();
    try {
      const c = await f.command(ACTIONS[0]!, "bounded-ack-loss");
      const s = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, c, AT);
      let committed = false;
      await expect(
        (async () => {
          const w = await f.sql.run(s.sql, s.params);
          expect(w.changes).toBe(1);
          expect(w.rows).toHaveLength(1);
          committed = true;
          throw Error("bounded injected postcommit loss");
        })(),
      ).rejects.toThrow("bounded injected postcommit loss");
      expect(committed).toBe(true);
      const before = [f.writes, f.providerRequests, f.clocks];
      const r = await createFinancialR1AttemptDataReader(f.options).readBusinessAttemptData({
        kind: c.original.c0.selection.action.kind as "topup",
        organizationId: SCOPE.organizationId,
        reference: ACTIONS[0]!.reference,
      });
      expect(r.status).toBe("found");
      if (r.status !== "found") throw Error("missing held original");
      expect(r.fullCommandJson).toBe(canonicalJson(c));
      expect([f.writes, f.providerRequests, f.clocks]).toEqual(before);
    } finally {
      f.close();
    }
  });
  test("large exact UTF8 terms and SQL-looking bytes remain parameters, never SQL text", async () => {
    const f = await fixture();
    try {
      const text =
        "? ' ; -- 😀" + "x".repeat(32768 - new TextEncoder().encode("? ' ; -- 😀").length);
      const c = await f.command(ACTIONS[0]!, "bounded-large", text);
      const s = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, c, AT);
      expect(s.params).toHaveLength(16);
      expect(s.sql.includes(text)).toBe(false);
      expect((await f.sql.run(s.sql, s.params)).changes).toBe(1);
      const r = await createFinancialR1AttemptDataReader(f.options).readOriginalAttemptData(c);
      expect(r.status).toBe("found");
      if (r.status !== "found") throw Error("missing large original");
      expect(r.fullCommand.original.selectedTerms.bodyByteLength).toBe(32768);
      expect(r.fullCommandJson).toBe(canonicalJson(c));
    } finally {
      f.close();
    }
  });
  test("caller mutation during digest work cannot alter the snapshotted original or scope", async () => {
    const f = await fixture();
    try {
      const c = await f.command(ACTIONS[0]!, "bounded-mutation");
      const expected = canonicalJson(c);
      const pending = buildFinancialR1BoundedAttemptCustodyStatement(f.options, c, AT);
      (c.original.selectedTerms as { locale: string }).locale = "ja-JP";
      const s = await pending;
      expect((await f.sql.run(s.sql, s.params)).changes).toBe(1);
      expect(f.db.query(`SELECT command_json FROM ${TABLE}`).get()).toEqual({
        command_json: expected,
      });
    } finally {
      f.close();
    }
  });
  test("exact13 positive row barrier precedes a deliberate named late constraint and the whole Money batch rolls back", async () => {
    const f = await fixture();
    try {
      const c = await f.command(ACTIONS[0]!, "bounded-rollback"),
        legacy = await buildFinancialR1AttemptCustodyStatement(f.options, c, AT),
        s = await buildFinancialR1BoundedAttemptCustodyStatement(f.options, c, AT);
      f.db.exec(
        "CREATE TABLE bounded_claim_late_fault(value INTEGER NOT NULL CONSTRAINT bounded_claim_late_fault_only CHECK(value=1))",
      );
      const barrier = `INSERT INTO bounded_claim_late_fault(value) SELECT CASE WHEN (SELECT count(*) FROM ${TABLE})=1 AND EXISTS(SELECT 1 FROM ${TABLE} WHERE ${COLUMNS.map((x) => `${x} IS ?`).join(" AND ")}) THEN 0 ELSE 1 END`;
      let caught: unknown;
      try {
        await f.sql.batch([s, { sql: barrier, params: legacy.params!.slice(0, 13) }]);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(Error);
      expect((caught as Error).message).toContain("bounded_claim_late_fault_only");
      expect(count(f.db, TABLE)).toBe(0);
      expect(count(f.db, "bounded_claim_late_fault")).toBe(0);
      expect(count(f.db, "money_cutover_writer_permit")).toBe(0);
    } finally {
      f.close();
    }
  });
});
