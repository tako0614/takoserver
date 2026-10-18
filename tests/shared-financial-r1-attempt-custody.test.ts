import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import {
  buildFinancialR1AttemptCustodyStatement,
  buildFinancialR1ClaimedCoPreparationBatch,
  createFinancialR1AttemptDataReader,
  FinancialRetainedR1Error,
} from "../src/shared-financial-retained-r1.ts";
import type { Row, SqlStatement } from "../src/ports.ts";
import {
  ACTIONS,
  AT,
  EPOCH,
  SCOPE,
  count,
  fixture,
  withoutGuard,
} from "./helpers/financial-r1-custody-fixture.ts";

const ATTEMPT_TABLE = "financial_r1_preparation_attempts";
const RETURNING_COLUMNS = [
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

async function claim(
  f: Awaited<ReturnType<typeof fixture>>,
  command: Parameters<typeof buildFinancialR1AttemptCustodyStatement>[1],
) {
  const statement = await buildFinancialR1AttemptCustodyStatement(f.options, command, AT);
  return f.sql.run(statement.sql, statement.params);
}

// The existing C0 compiler has reserved-table SQL rejected by public S. These
// fixed5-only fixtures use the SAME old isolated raw-R permit frame as the
// existing suite, not a new native/Money qualification. Claim writes use real S.
function fixtureTransaction(statements: readonly SqlStatement[]): readonly SqlStatement[] {
  return [
    { sql: "INSERT INTO money_cutover_writer_permit VALUES(1,'usd-micros-v2',?)", params: [EPOCH] },
    ...statements,
    { sql: "DELETE FROM money_cutover_writer_permit WHERE singleton=1" },
  ];
}

describe("private Financial R1 pre-dispatch attempt custody DATA", () => {
  test("first claim changes one row, returns the exact closed 13-column image, then fixed five commits and strict historical read succeeds", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "custody-fresh");
      const write = await claim(f, command);
      expect(write.changes).toBe(1);
      expect(write.rows).toHaveLength(1);
      expect(Object.keys(write.rows[0]!).sort()).toEqual([...RETURNING_COLUMNS].sort());
      expect(write.rows[0]).toMatchObject({
        r1_ref: command.key.r1Ref,
        challenge_ref: command.key.challengeRef,
        preparation_ref: command.key.preparationRef,
        receipt_ref: command.r1ReceiptRef,
        action_kind: ACTIONS[0]!.kind,
        organization_id: SCOPE.organizationId,
        action_reference: ACTIONS[0]!.reference,
        writer_epoch: EPOCH,
        recorded_at: AT,
      });
      const reader = createFinancialR1AttemptDataReader(f.options);
      const historical = await reader.readOriginalAttemptData(command);
      expect(historical.status).toBe("found");
      if (historical.status !== "found") throw Error("claimed attempt not found");
      expect(historical.fullCommand).toEqual(command);
      expect(historical.fullCommandJson).toBe(canonicalJson(command));
      expect(historical.recordedAt).toBe(AT);
      const batch = await buildFinancialR1ClaimedCoPreparationBatch(f.options, command, AT);
      expect(batch).toHaveLength(5);
      await f.base.batch(fixtureTransaction(batch));
      expect(count(f.db, ATTEMPT_TABLE)).toBe(1);
      expect(count(f.db, "financial_retained_r1_originals")).toBe(1);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(1);
      const complete = await f.store.readJoinedRetainedR1Data(command.key.challengeRef);
      expect(complete.status).toBe("found");
      if (complete.status !== "found") throw Error("complete C0/R1 pair missing");
      expect(complete.fullCommand).toEqual(command);
    } finally {
      f.close();
    }
  });

  test("all five closed actions can claim and preserve their own immutable full command", async () => {
    for (let index = 0; index < ACTIONS.length; index++) {
      const f = await fixture();
      try {
        const action = ACTIONS[index]!;
        const command = await f.command(action, `custody-action-${index}`);
        expect((await claim(f, command)).changes).toBe(1);
        const contribution = await buildFinancialR1ClaimedCoPreparationBatch(
          f.options,
          command,
          AT,
        );
        expect(contribution).toHaveLength(5);
        await f.base.batch(fixtureTransaction(contribution));
        const read = await createFinancialR1AttemptDataReader(f.options).readBusinessAttemptData({
          kind: action.kind,
          organizationId: action.organizationId,
          reference: action.reference,
        });
        expect(read.status).toBe("found");
        if (read.status !== "found") throw Error("business attempt missing");
        expect(read.fullCommand).toEqual(command);
        expect(count(f.db, ATTEMPT_TABLE)).toBe(1);
        expect(count(f.db, "financial_retained_r1_originals")).toBe(1);
        expect(count(f.db, "financial_retained_r1_receipts")).toBe(1);
      } finally {
        f.close();
      }
    }
  });

  test("fixed five statements without a committed claim roll back all five rows", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "custody-unclaimed");
      const batch = await buildFinancialR1ClaimedCoPreparationBatch(f.options, command, AT);
      expect(batch).toHaveLength(5);
      await expect(f.base.batch(fixtureTransaction(batch))).rejects.toThrow();
      expect(count(f.db, ATTEMPT_TABLE)).toBe(0);
      expect(count(f.db, "financial_action_source_registrations")).toBe(0);
      expect(count(f.db, "financial_preproof_challenges")).toBe(0);
      expect(count(f.db, "financial_preproof_challenge_receipts")).toBe(0);
      expect(count(f.db, "financial_retained_r1_originals")).toBe(0);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("committed claim with injected response loss is recovered by business key after closing and reopening its SQLite file", async () => {
    const directory = mkdtempSync(join(tmpdir(), "financial-r1-custody-"));
    const path = join(directory, "custody.sqlite");
    let f: Awaited<ReturnType<typeof fixture>> | undefined;
    try {
      f = await fixture(path);
      const command = await f.command(ACTIONS[0]!, "custody-ackloss-file");
      const statement = await buildFinancialR1AttemptCustodyStatement(f.options, command, AT);
      let committed = false;
      async function responseLostAfterCommit() {
        const actual = await f!.sql.run(statement.sql, statement.params);
        committed = actual.changes === 1 && actual.rows.length === 1;
        throw Error("injected response loss after actual commit");
      }
      await expect(responseLostAfterCommit()).rejects.toThrow(
        "injected response loss after actual commit",
      );
      expect(committed).toBe(true);
      expect(count(f.db, ATTEMPT_TABLE)).toBe(1);
      f.close();
      f = undefined;
      f = await fixture(path, false);
      const before = [f.writes, f.providerRequests, f.clocks];
      const recovered = await createFinancialR1AttemptDataReader(f.options).readBusinessAttemptData(
        {
          kind: ACTIONS[0]!.kind,
          organizationId: SCOPE.organizationId,
          reference: ACTIONS[0]!.reference,
        },
      );
      expect(recovered.status).toBe("found");
      if (recovered.status !== "found") throw Error("durable original lost on reopen");
      expect(recovered.fullCommand).toEqual(command);
      expect(recovered.fullCommandJson).toBe(canonicalJson(command));
      expect([f.writes, f.providerRequests, f.clocks]).toEqual(before);
      expect((await claim(f, command)).changes).toBe(0);
      expect(count(f.db, "financial_preproof_challenges")).toBe(0);
      expect(count(f.db, "financial_retained_r1_originals")).toBe(0);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(0);
    } finally {
      f?.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("freeze rejects fixed-five settlement while retaining the committed claim", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "custody-freeze-settlement");
      expect((await claim(f, command)).changes).toBe(1);
      await f.base.run("INSERT INTO money_cutover_freeze VALUES(1,?,?,?,?,?)", [
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
        EPOCH,
      ]);
      await expect(
        f.base.batch(
          fixtureTransaction(
            await buildFinancialR1ClaimedCoPreparationBatch(f.options, command, AT),
          ),
        ),
      ).rejects.toThrow();
      expect(count(f.db, ATTEMPT_TABLE)).toBe(1);
      expect(count(f.db, "financial_retained_r1_originals")).toBe(0);
      expect(count(f.db, "financial_retained_r1_receipts")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("a repeated exact claim is changes zero and a changed body cannot replace or re-key the business attempt", async () => {
    const f = await fixture();
    try {
      const first = await f.command(ACTIONS[0]!, "custody-replay-first");
      expect((await claim(f, first)).changes).toBe(1);
      expect((await claim(f, first)).changes).toBe(0);
      const changedAction = { ...ACTIONS[0]!, amountMinor: 999 };
      const changed = await f.command(changedAction, "custody-replay-changed");
      expect((await claim(f, changed)).changes).toBe(0);
      await expect(
        createFinancialR1AttemptDataReader(f.options).readOriginalAttemptData(changed),
      ).rejects.toMatchObject({ code: "conflict" });
      const read = await createFinancialR1AttemptDataReader(f.options).readBusinessAttemptData({
        kind: ACTIONS[0]!.kind,
        organizationId: SCOPE.organizationId,
        reference: ACTIONS[0]!.reference,
      });
      expect(read.status).toBe("found");
      if (read.status !== "found") throw Error("business attempt missing");
      expect(read.fullCommand).toEqual(first);
      expect(count(f.db, ATTEMPT_TABLE)).toBe(1);
    } finally {
      f.close();
    }
  });

  test("crossed role collision blocks a different business key", async () => {
    const f = await fixture();
    try {
      const first = await f.command(ACTIONS[0]!, "custody-role-owner");
      expect((await claim(f, first)).changes).toBe(1);
      const crossedAction = {
        ...ACTIONS[1]!,
        reference: "start:crossed-role",
      };
      const crossed = await f.command(crossedAction, "custody-role-crossed");
      Object.assign(crossed, { r1ReceiptRef: first.key.r1Ref });
      expect((await claim(f, crossed)).changes).toBe(0);
      expect(count(f.db, ATTEMPT_TABLE)).toBe(1);
    } finally {
      f.close();
    }
  });

  test("challenge-only C0 business history suppresses a new attempt claim", async () => {
    const f = await fixture();
    try {
      const existing = await f.command(ACTIONS[0]!, "custody-c0-only");
      await f.c0.prepare(existing.original.c0);
      await withoutGuard(f.db, "financial_preproof_challenge_receipts_no_delete", () =>
        f.base.run("DELETE FROM financial_preproof_challenge_receipts WHERE receipt_ref=?", [
          existing.original.c0ReceiptRef,
        ]),
      );
      const candidate = await f.command(ACTIONS[0]!, "custody-c0-new-r1");
      expect((await claim(f, candidate)).changes).toBe(0);
      expect(count(f.db, ATTEMPT_TABLE)).toBe(0);
      expect(count(f.db, "financial_preproof_challenges")).toBe(1);
      expect(count(f.db, "financial_preproof_challenge_receipts")).toBe(0);
    } finally {
      f.close();
    }
  });

  test("receipt-only C0 history suppresses a new attempt claim", async () => {
    const f = await fixture();
    try {
      const existing = await f.command(ACTIONS[0]!, "custody-c0-receipt-only");
      await f.c0.prepare(existing.original.c0);
      f.db.exec("PRAGMA foreign_keys=OFF");
      await withoutGuard(f.db, "financial_preproof_challenges_no_delete", () =>
        f.base.run("DELETE FROM financial_preproof_challenges WHERE challenge_ref=?", [
          existing.original.c0.challenge.challengeRef,
        ]),
      );
      f.db.exec("PRAGMA foreign_keys=ON");
      const candidate = await f.command(ACTIONS[0]!, "custody-c0-receipt-new-r1");
      expect((await claim(f, candidate)).changes).toBe(0);
      expect(count(f.db, ATTEMPT_TABLE)).toBe(0);
      expect(count(f.db, "financial_preproof_challenges")).toBe(0);
      expect(count(f.db, "financial_preproof_challenge_receipts")).toBe(1);
    } finally {
      f.close();
    }
  });

  test("stale captured writer epoch cannot create a claim", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "custody-stale-epoch");
      const statement = await buildFinancialR1AttemptCustodyStatement(f.options, command, AT);
      const rotated = `sha256:${"d".repeat(64)}`;
      await f.base.run(
        "UPDATE money_cutover_authorized_epoch SET writer_epoch=? WHERE singleton=1",
        [rotated],
      );
      await expect(f.sql.run(statement.sql, statement.params)).rejects.toThrow();
      expect(count(f.db, ATTEMPT_TABLE)).toBe(0);
    } finally {
      f.close();
    }
  });

  test("same-full-command input is snapshotted before asynchronous digest work", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "custody-snapshot");
      expect((await claim(f, command)).changes).toBe(1);
      const mutable = structuredClone(command);
      const pending = createFinancialR1AttemptDataReader(f.options).readOriginalAttemptData(
        mutable,
      );
      (mutable.original.economic as { amountMinor: number }).amountMinor = 999;
      const read = await pending;
      expect(read.status).toBe("found");
      if (read.status !== "found") throw Error("snapshotted attempt missing");
      expect(read.fullCommand.original.economic).toEqual(command.original.economic);
    } finally {
      f.close();
    }
  });

  test("a maximum terms body and near-bound canonical command remain readable", async () => {
    const f = await fixture();
    try {
      const command = await f.command(
        ACTIONS[0]!,
        "custody-max-terms-and-command",
        "x".repeat(32_768),
      );
      // Locale is retained presentation metadata with bounded grammar but no
      // short fixed limit. Pad valid 8-character subtags until the canonical
      // full-command JSON is close to, while within, the schema's 98,304-byte cap.
      const initialBytes = new TextEncoder().encode(canonicalJson(command)).length;
      const locale = "en-US" + "-abcdefgh".repeat(Math.ceil((96000 - initialBytes) / 9));
      (command.original.selectedTerms as { locale: string }).locale = locale;
      const commandBytes = new TextEncoder().encode(canonicalJson(command)).length;
      expect(commandBytes).toBeGreaterThanOrEqual(96_000);
      expect(commandBytes).toBeLessThanOrEqual(98_304);
      expect((await claim(f, command)).changes).toBe(1);
      const read = await createFinancialR1AttemptDataReader(f.options).readOriginalAttemptData(
        command,
      );
      expect(read.status).toBe("found");
      if (read.status !== "found") throw Error("near-bound attempt not readable");
      expect(new TextEncoder().encode(read.fullCommandJson).length).toBe(commandBytes);
      expect(read.fullCommand.original.selectedTerms.bodyByteLength).toBe(32_768);
    } finally {
      f.close();
    }
  });

  test("unknown query remains unavailable and never reports absence", async () => {
    const f = await fixture();
    try {
      const reader = createFinancialR1AttemptDataReader(f.options);
      f.unknownQuery();
      await expect(
        reader.readBusinessAttemptData({
          kind: ACTIONS[0]!.kind,
          organizationId: SCOPE.organizationId,
          reference: ACTIONS[0]!.reference,
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      f.close();
    }
  });

  test("borrowed exported conflict error from the query port becomes unavailable", async () => {
    const f = await fixture();
    try {
      const reader = createFinancialR1AttemptDataReader(f.options);
      f.setQueryOverride(async () => {
        throw new FinancialRetainedR1Error("conflict");
      });
      await expect(
        reader.readBusinessAttemptData({
          kind: ACTIONS[0]!.kind,
          organizationId: SCOPE.organizationId,
          reference: ACTIONS[0]!.reference,
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      f.close();
    }
  });

  test("getter-backed query rows are unavailable without invoking the getter", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "custody-getter-row");
      expect((await claim(f, command)).changes).toBe(1);
      let getterCalls = 0;
      const row: Row = {};
      for (const column of RETURNING_COLUMNS) {
        if (column === "r1_ref") {
          Object.defineProperty(row, column, {
            enumerable: true,
            get() {
              getterCalls++;
              return command.key.r1Ref;
            },
          });
        } else {
          Object.defineProperty(row, column, {
            enumerable: true,
            value: "placeholder",
          });
        }
      }
      f.setQueryOverride(async (query, params) => {
        if (query.includes(`FROM ${ATTEMPT_TABLE} WHERE`)) return [row];
        return f.base.query(query, params);
      });
      await expect(
        createFinancialR1AttemptDataReader(f.options).readOriginalAttemptData(command),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(getterCalls).toBe(0);
    } finally {
      f.close();
    }
  });

  test("missing or drifted attempt DDL object makes the historical read unavailable", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "custody-ddl-drift");
      await f.base.run(`DROP TRIGGER financial_r1_preparation_attempts_no_update`);
      await expect(
        createFinancialR1AttemptDataReader(f.options).readOriginalAttemptData(command),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      f.close();
    }
  });

  test("corrupt persisted command data is unavailable, never absence", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "custody-partial-row");
      expect((await claim(f, command)).changes).toBe(1);
      await withoutGuard(f.db, "financial_r1_preparation_attempts_no_update", () =>
        f.base.run(`UPDATE ${ATTEMPT_TABLE} SET command_json=? WHERE r1_ref=?`, [
          "{}",
          command.key.r1Ref,
        ]),
      );
      await expect(
        createFinancialR1AttemptDataReader(f.options).readOriginalAttemptData(command),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      f.close();
    }
  });
  test("extra attempt trigger refuses schema readiness instead of returning absence", async () => {
    const f = await fixture();
    try {
      f.db.exec(
        "CREATE TRIGGER financial_r1_unexpected AFTER INSERT ON financial_r1_preparation_attempts BEGIN SELECT 1; END",
      );
      await expect(
        createFinancialR1AttemptDataReader(f.options).readBusinessAttemptData({
          kind: ACTIONS[0]!.kind,
          organizationId: SCOPE.organizationId,
          reference: ACTIONS[0]!.reference,
        }),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      f.close();
    }
  });
  test("known empty custody is historical DATA and the reader performs no writes, selector or Clock calls", async () => {
    const f = await fixture();
    try {
      const before = [f.writes, f.providerRequests, f.clocks];
      const result = await createFinancialR1AttemptDataReader(f.options).readBusinessAttemptData({
        kind: ACTIONS[0]!.kind,
        organizationId: SCOPE.organizationId,
        reference: ACTIONS[0]!.reference,
      });
      expect(result).toEqual({ status: "not-found" });
      expect(Object.keys(result)).toEqual(["status"]);
      expect([f.writes, f.providerRequests, f.clocks]).toEqual(before);
    } finally {
      f.close();
    }
  });
  test("a deliberate SQL failure after all five positive milestones rolls back both pairs and registration but keeps original claim", async () => {
    const f = await fixture();
    try {
      const command = await f.command(ACTIONS[0]!, "custody-positive-late-rollback");
      expect((await claim(f, command)).changes).toBe(1);
      const tables = [
        ATTEMPT_TABLE,
        "financial_action_source_registrations",
        "financial_preproof_challenges",
        "financial_preproof_challenge_receipts",
        "financial_retained_r1_originals",
        "financial_retained_r1_receipts",
      ];
      const before = tables.map((t) => f.db.query(`SELECT * FROM ${t}`).all());
      const fixed = await buildFinancialR1ClaimedCoPreparationBatch(f.options, command, AT);
      const barrier = {
        sql: `SELECT CASE WHEN
        (SELECT count(*) FROM financial_action_source_registrations)=1
        AND(SELECT count(*) FROM financial_preproof_challenges)=1
        AND(SELECT count(*) FROM financial_preproof_challenge_receipts WHERE all_rows_match=1)=1
        AND(SELECT count(*) FROM financial_retained_r1_originals WHERE command_json=? )=1
        AND(SELECT count(*) FROM financial_retained_r1_receipts WHERE command_json=? AND all_rows_match=1)=1
        THEN 1 ELSE json('positive-prefix-not-reached') END AS positive_prefix`,
        params: [canonicalJson(command), canonicalJson(command)],
      };
      let failure: unknown;
      try {
        await f.base.batch(
          fixtureTransaction([
            ...fixed,
            barrier,
            { sql: "SELECT * FROM financial_r1_deliberate_late_fault" },
          ]),
        );
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain("financial_r1_deliberate_late_fault");
      expect(tables.map((t) => f.db.query(`SELECT * FROM ${t}`).all())).toEqual(before);
      expect(count(f.db, ATTEMPT_TABLE)).toBe(1);
    } finally {
      f.close();
    }
  });
});
