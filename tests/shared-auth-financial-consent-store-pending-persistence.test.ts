import { describe, expect, test } from "bun:test";
import { MONEY_CUTOVER_PERMIT_TABLE } from "../src/money-cutover-sql.ts";
import type { Row, SqlStatement } from "../src/ports.ts";
import { sharedAuthFinancialConsentLeafStatements } from "../src/shared-auth-financial-consent-schema-plan.ts";
import {
  createSharedAuthFinancialConsentOriginalReader,
  createSharedAuthFinancialConsentPendingRecovery,
  persistSharedAuthFinancialConsentRequestPendingData,
  SharedAuthFinancialConsentOriginalReadError,
  type SharedAuthFinancialConsentPendingData,
  sharedAuthFinancialConsentPendingPersistenceStatement,
} from "../src/shared-auth-financial-consent-store.ts";
import type { D1ResultLike } from "../src/sql-d1.ts";
import { readWorkerRequestConsumers } from "../src/worker-request-composition.ts";
import {
  custodyHash,
  graphFixture,
  rows,
  snapshot,
  write,
} from "./consent-request-graph-fixture.ts";

const P = "shared_auth_financial_consent_pending";
const C = "shared_auth_financial_consent_commands";
const O = "shared_auth_financial_consent_originals";
type Fixture = Awaited<ReturnType<typeof graphFixture>>;
const params = (statement: SqlStatement) => {
  if (statement.params === undefined)
    throw new Error("pending CAS must have closed original parameters");
  return statement.params;
};
const pendingCopy = (
  pending: SharedAuthFinancialConsentPendingData,
): SharedAuthFinancialConsentPendingData => ({
  ...pending,
  action_original_bytes: new Uint8Array(pending.action_original_bytes),
  terms_original_bytes: new Uint8Array(pending.terms_original_bytes),
  challenge_original_bytes: new Uint8Array(pending.challenge_original_bytes),
});
function pendingWrites(f: Fixture) {
  return f.native.calls.filter((call) => call.sql.includes(`INSERT INTO ${P} (`));
}
function noDownstream(f: Fixture) {
  expect(rows(f.db, C)).toHaveLength(0);
  expect(rows(f.db, O)).toHaveLength(0);
  expect(
    f.native.calls.some(
      (call) => call.sql.includes(`INSERT INTO ${C} (`) || call.sql.includes(`INSERT INTO ${O} (`),
    ),
  ).toBe(false);
  expect(rows(f.db, MONEY_CUTOVER_PERMIT_TABLE)).toHaveLength(0);
}
function readonlyCalls(f: Fixture, start: number) {
  const calls = f.native.calls.slice(start);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call) => /^(?:SELECT\b|PRAGMA table_info\()/u.test(call.sql))).toBe(true);
}
function changedMiddle(
  results: readonly D1ResultLike[],
  change: (value: D1ResultLike) => D1ResultLike,
): readonly D1ResultLike[] {
  const middle = results[1];
  if (results.length !== 3 || middle === undefined)
    throw new Error("missing actual Money permit3 write result");
  return results.map((value, index) => (index === 1 ? change(middle) : value));
}
function firstRow(result: D1ResultLike): Row {
  const row = result.results?.[0];
  if (row === undefined || result.results?.length !== 1)
    throw new Error("missing actual closed29 postimage");
  return row;
}
async function unavailable(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ code: "unavailable" });
}

// Only reduced synthetic Root anchors and local SQLite are supplied by the
// existing real-constructor fixture. This is not genuine consent/human/Clock,
// Financial R1/current admission, native D1 or request-route qualification.
describe("unmounted same-request pending29 persistence and historical DATA recovery", () => {
  test("one actual Money permit3 CAS returns all29 original values and leaves capture consume and Root unchanged", async () => {
    const f = await graphFixture({ seedPending: false });
    const before = snapshot(f.db);
    const effects = f.effects();
    const statement = await sharedAuthFinancialConsentPendingPersistenceStatement(f.input);
    const bound = params(statement);
    expect(bound.length).toBe(81);
    expect(statement.sql.match(/\?/gu)).toHaveLength(81);
    const result = await persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input);
    expect(result.state).toBe("pending-persistence-postimage-data");
    expect(Object.keys(result).sort()).toEqual(["pending", "state"]);
    expect(Object.keys(result.pending)).toHaveLength(29);
    expect(result.pending).toEqual(f.input.pending);
    expect(result.pending.action_original_bytes).not.toBe(f.input.pending.action_original_bytes);
    expect(f.native.batchCalls).toBe(1);
    expect(f.native.committedBatches).toHaveLength(1);
    expect(f.native.committedBatches[0]?.map((value) => value.meta?.changes)).toEqual([1, 1, 1]);
    const writes = f.native.calls.filter(
      (call) =>
        call.sql.includes(`INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE}`) ||
        call.sql.includes(`INSERT INTO ${P} (`) ||
        call.sql.includes(`DELETE FROM ${MONEY_CUTOVER_PERMIT_TABLE}`),
    );
    expect(writes).toHaveLength(3);
    expect(writes[1]).toEqual({ sql: statement.sql, params: bound });
    expect(Object.keys(firstRow(f.native.committedBatches[0]![1]!))).toHaveLength(29);
    expect(rows(f.db, P)).toEqual([f.input.pending]);
    const after = snapshot(f.db);
    expect(after.root).toEqual(before.root);
    expect(after.schema).toEqual(before.schema);
    expect(f.effects()).toEqual(effects);
    noDownstream(f);
  });

  test("the real parameterized CAS has81 binds and a positive full29 postimage before an intentional late SQL rollback", async () => {
    const f = await graphFixture({ seedPending: false });
    const before = snapshot(f.db);
    const statement = await sharedAuthFinancialConsentPendingPersistenceStatement(f.input);
    expect(params(statement).length).toBe(81);
    expect(params(statement).length).toBeLessThanOrEqual(100);
    let reached = false;
    let late: unknown;
    let observed: unknown;
    try {
      f.db.transaction(() => {
        const result = write(f.db, statement);
        expect(result.changes).toBe(1);
        expect(result.rows).toHaveLength(1);
        const expected: Row = { ...f.input.pending };
        expect(Object.keys(result.rows[0]!)).toHaveLength(29);
        expect(result.rows[0]).toEqual(expected);
        expect(rows(f.db, P)).toEqual([f.input.pending]);
        reached = true;
        try {
          f.db.exec("SELECT pending_intentional_late_sql_fault FROM no_pending_late_table");
        } catch (error) {
          late = error;
          throw error;
        }
        throw new Error("intentional late SQL did not fail");
      })();
    } catch (error) {
      observed = error;
    }
    expect(reached).toBe(true);
    expect(late).toBeInstanceOf(Error);
    expect(observed).toBe(late);
    expect(String(late)).toContain("no_pending_late_table");
    expect(snapshot(f.db)).toEqual(before);
  });

  test("committed lost ACK preserves the pending row and only its original29 GET recovers without another write", async () => {
    const f = await graphFixture({ seedPending: false });
    const recovery = createSharedAuthFinancialConsentPendingRecovery(f.connection, f.input.pending);
    f.native.afterBatch = () => {
      throw new Error("pending committed ACK lost");
    };
    await unavailable(persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input));
    expect(f.native.batchCalls).toBe(1);
    expect(rows(f.db, P)).toEqual([f.input.pending]);
    const start = f.native.calls.length;
    expect(await recovery.readOriginalPendingData()).toEqual(f.input.pending);
    readonlyCalls(f, start);
    expect(Object.keys(recovery)).toEqual(["readOriginalPendingData"]);
    expect(pendingWrites(f)).toHaveLength(1);
    expect(f.native.batchCalls).toBe(1);
    noDownstream(f);
    await unavailable(
      createSharedAuthFinancialConsentOriginalReader(f.sql).readOriginal(f.input.command),
    );
  });

  test("known0 unknown2 and malformed ACK postimages never become permission or trigger capture consume or a second pending write", async () => {
    for (const kind of [
      "zero",
      "two",
      "unknown",
      "extra",
      "missing",
      "duplicate",
      "wrong-bytes",
    ] as const) {
      const f = await graphFixture({ seedPending: false });
      f.native.afterBatch = (results) =>
        changedMiddle(results, (value) => {
          if (kind === "zero") return { ...value, meta: { changes: 0 } };
          if (kind === "two") return { ...value, meta: { changes: 2 } };
          if (kind === "unknown") return { ...value, meta: { changes: null } };
          const row = firstRow(value);
          if (kind === "extra")
            return { ...value, results: [{ ...row, extra_scalar: "not pending29" }] };
          if (kind === "missing") {
            const partial = { ...row };
            delete partial.terms_digest_original;
            return { ...value, results: [partial] };
          }
          if (kind === "duplicate") return { ...value, results: [row, row] };
          return { ...value, results: [{ ...row, action_original_bytes: new Uint8Array([0]) }] };
        });
      await unavailable(persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input));
      expect(f.native.batchCalls).toBe(1);
      expect(pendingWrites(f)).toHaveLength(1);
      noDownstream(f);
    }
  });

  test("retirement session version and human revocation occurring just before actual SQL all reject the same CAS", async () => {
    for (const sql of [
      "UPDATE credential_authority_classes SET state='retired'",
      "UPDATE shared_auth_sessions SET version=version+1",
      "UPDATE shared_principal_bindings SET state='retired'",
      "UPDATE shared_auth_sessions SET absolute_expires_at=0",
    ]) {
      const f = await graphFixture({ seedPending: false });
      f.native.beforeBatch = async () => {
        f.db.exec(sql);
      };
      await unavailable(persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input));
      expect(f.native.batchCalls).toBe(1);
      expect(rows(f.db, P)).toHaveLength(0);
      noDownstream(f);
    }
  });

  test("expiry old recorded timestamps and changed original input reject with no alternate ref or retry", async () => {
    const f = await graphFixture({ seedPending: false, at: Date.now() - 400_000 });
    await unavailable(persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input));
    expect(f.native.batchCalls).toBe(1);
    expect(rows(f.db, P)).toHaveLength(0);
    noDownstream(f);
    for (const kind of [
      "window",
      "time",
      "canonical",
      "scope",
      "accessor",
      "terms-limit",
    ] as const) {
      const g = await graphFixture({ seedPending: false });
      const prior = snapshot(g.db);
      let getterCalls = 0;
      if (kind === "window")
        Object.assign(g.input.pending, { expires_at: g.input.pending.created_at + 300001 });
      if (kind === "time") Object.assign(g.input, { recordedAt: -1 });
      if (kind === "canonical") g.input.command.originalBytes.fill(0);
      if (kind === "scope")
        Object.assign(g.input.pending, { credential_workspace_id: "selected_workspace_B" });
      if (kind === "accessor")
        Object.defineProperty(g.input.pending, "action_ref", {
          enumerable: true,
          get() {
            getterCalls++;
            throw new Error("input getter must not run");
          },
        });
      if (kind === "terms-limit")
        Object.assign(g.input.pending, { terms_original_bytes: new Uint8Array(16385) });
      await expect(
        persistSharedAuthFinancialConsentRequestPendingData(g.connection, g.input),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(getterCalls).toBe(0);
      expect(g.native.batchCalls).toBe(0);
      expect(snapshot(g.db)).toEqual(prior);
    }
  });

  test("input BLOB and fullcommand mutation after the first await cannot change the original29 selected for storage or recovery", async () => {
    const f = await graphFixture({ seedPending: false });
    const original = pendingCopy(f.input.pending);
    const recovery = createSharedAuthFinancialConsentPendingRecovery(f.connection, f.input.pending);
    const effect = persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input);
    f.input.pending.action_original_bytes.fill(0);
    f.input.command.originalBytes.fill(0);
    Object.assign(f.input.pending, { transaction_ref: `rpfc_${"z".repeat(43)}` });
    const actual = await effect;
    expect(actual.pending).toEqual(original);
    expect(rows(f.db, P)).toEqual([original]);
    expect(await recovery.readOriginalPendingData()).toEqual(original);
    noDownstream(f);
  });

  test("frozen method refuses replacement while once-only factory reconstruction preserves the original pending graph", async () => {
    for (const kind of ["method", "factory-refusal"] as const) {
      const f = await graphFixture({ seedPending: false });
      const rootsBefore = snapshot(f.db).root;
      let replaced: boolean | undefined;
      f.native.afterBatch = (results) => {
        if (kind === "factory-refusal") {
          expect(() => f.replaceGraph()).toThrow(
            new TypeError("Worker request consumers are already constructed"),
          );
          expect(readWorkerRequestConsumers(f.connection)).toBe(f.graph);
        } else {
          replaced = Reflect.defineProperty(f.graph.sql, "query", {
            value: async () => [],
            enumerable: true,
            writable: true,
            configurable: true,
          });
        }
        return results;
      };
      const attempt = persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input);
      const settled = attempt.then(
        () => undefined,
        () => undefined,
      );
      try {
        const actual = await attempt;
        expect(actual.state).toBe("pending-persistence-postimage-data");
        expect(actual.pending).toEqual(f.input.pending);
        if (kind === "method") {
          expect(Object.isFrozen(f.graph.sql)).toBe(true);
          expect(replaced).toBe(false);
        } else {
          expect(readWorkerRequestConsumers(f.connection)).toBe(f.graph);
        }
        expect(f.native.batchCalls).toBe(1);
        expect(pendingWrites(f)).toHaveLength(1);
        expect(rows(f.db, P)).toEqual([f.input.pending]);
        expect(snapshot(f.db).root).toEqual(rootsBefore);
        noDownstream(f);
      } finally {
        // Cleanup settles the original flight even if a later assertion fails.
        await settled;
      }
    }
  });

  test("same-vector sequential contenders retain one immutable row and command-only absence never supplies resume permission", async () => {
    const f = await graphFixture({ seedPending: false });
    await persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input);
    await unavailable(persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input));
    expect(f.native.batchCalls).toBe(2);
    expect(rows(f.db, P)).toEqual([f.input.pending]);
    noDownstream(f);
    await unavailable(
      createSharedAuthFinancialConsentOriginalReader(f.sql).readOriginal(f.input.command),
    );
  });

  test("positive complete absence is query-only DATA and differs from invalid custody or an occupied unique vector", async () => {
    const f = await graphFixture({ seedPending: false });
    const recovery = createSharedAuthFinancialConsentPendingRecovery(f.connection, f.input.pending);
    const start = f.native.calls.length;
    expect(await recovery.readOriginalPendingData()).toBeUndefined();
    readonlyCalls(f, start);
    expect(f.native.batchCalls).toBe(0);
    const bad = pendingCopy(f.input.pending);
    bad.terms_original_bytes.fill(0);
    await expect(
      createSharedAuthFinancialConsentPendingRecovery(f.connection, bad).readOriginalPendingData(),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await persistSharedAuthFinancialConsentRequestPendingData(f.connection, f.input);
    const other = { ...pendingCopy(f.input.pending), transaction_ref: `rpfc_${"b".repeat(43)}` };
    await expect(
      createSharedAuthFinancialConsentPendingRecovery(
        f.connection,
        other,
      ).readOriginalPendingData(),
    ).rejects.toMatchObject({ code: "custody_conflict" });
    expect(f.native.batchCalls).toBe(1);
    noDownstream(f);
  });

  test("expired retired historical29 is still readable without current or fullcommand authority", async () => {
    const f = await graphFixture({ seedPending: true, at: Date.now() - 400_000 });
    f.db.exec(
      "UPDATE credential_authority_classes SET state='retired'; UPDATE shared_principal_bindings SET state='retired'; UPDATE shared_auth_sessions SET status='revoked'",
    );
    const recovery = createSharedAuthFinancialConsentPendingRecovery(f.connection, f.input.pending);
    expect(await recovery.readOriginalPendingData()).toEqual(f.input.pending);
    expect(f.native.batchCalls).toBe(0);
    await unavailable(
      createSharedAuthFinancialConsentOriginalReader(f.sql).readOriginal(f.input.command),
    );
    noDownstream(f);
  });

  test("partial schema FK-off and orphan downstream rows fail closed rather than positive pending absence", async () => {
    for (const kind of ["partial", "fk-off", "orphan"] as const) {
      const f = await graphFixture({ seedPending: false });
      const recovery = createSharedAuthFinancialConsentPendingRecovery(
        f.connection,
        f.input.pending,
      );
      if (kind === "partial") f.db.exec(`DROP TRIGGER ${P}_auth_tuple`);
      else if (kind === "fk-off") f.db.exec("PRAGMA foreign_keys=OFF");
      else {
        f.db.exec("PRAGMA foreign_keys=OFF");
        f.db.exec(`DROP TRIGGER ${C}_pending_tuple`);
        f.db
          .query(
            `INSERT INTO ${C} (command_ref,transaction_ref,registration_ref,incarnation,organization_id,workspace_id,workspace_ref,family,consent_ref,receipt_ref,command_bytes,command_custody_sha256,original_bytes,original_digest,original_custody_sha256,captured_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          )
          .run(
            f.input.command.key.commandRef,
            f.input.command.key.transactionRef,
            f.input.command.key.registrationRef,
            f.input.command.key.incarnation,
            f.input.pending.organization_id,
            f.input.pending.workspace_id,
            f.input.pending.workspace_ref,
            f.input.command.family,
            f.input.command.key.consentRef,
            f.input.command.key.receiptRef,
            f.input.command.commandBytes,
            f.input.command.commandCustodySHA256,
            f.input.command.originalBytes,
            f.input.command.originalDigest,
            f.input.command.originalCustodySHA256,
            f.input.command.capturedAt,
          );
        const originalTrigger = sharedAuthFinancialConsentLeafStatements().find((statement) =>
          statement.sql.startsWith(`CREATE TRIGGER ${C}_pending_tuple `),
        );
        if (originalTrigger === undefined)
          throw new Error("missing immutable original tuple trigger");
        f.db.exec(originalTrigger.sql);
        f.db.exec("PRAGMA foreign_keys=ON");
        expect(rows(f.db, C)).toHaveLength(1);
        expect(rows(f.db, P)).toHaveLength(0);
      }
      const attempt = recovery.readOriginalPendingData();
      await unavailable(attempt);
      await expect(attempt).rejects.toBeInstanceOf(SharedAuthFinancialConsentOriginalReadError);
      expect(f.native.batchCalls).toBe(0);
    }
  });

  test("borrowed query errors partial extra duplicate and corrupt row bodies remain unavailable without a write fallback", async () => {
    for (const kind of ["throw", "partial", "extra", "duplicate", "corrupt"] as const) {
      const f = await graphFixture();
      f.native.rowFault = (sql, actual) => {
        if (!sql.startsWith(`SELECT transaction_ref,registration_ref`)) return actual;
        const first = actual[0];
        if (first === undefined) throw new Error("expected existing pending row");
        if (kind === "throw")
          throw new SharedAuthFinancialConsentOriginalReadError("custody_conflict");
        if (kind === "partial") {
          const row = { ...first };
          delete row.terms_digest_original;
          return [row];
        }
        if (kind === "extra") return [{ ...first, extra: "not pending29" }];
        if (kind === "duplicate") return [first, first];
        return [{ ...first, terms_original_bytes: new Uint8Array([0]) }];
      };
      const recovery = createSharedAuthFinancialConsentPendingRecovery(
        f.connection,
        f.input.pending,
      );
      if (kind === "duplicate")
        await expect(recovery.readOriginalPendingData()).rejects.toMatchObject({
          code: "custody_conflict",
        });
      else await unavailable(recovery.readOriginalPendingData());
      expect(f.native.batchCalls).toBe(0);
      noDownstream(f);
    }
  });

  test("changed well-hashed stored original versus caller29 is custody conflict rather than corrupted or absent data", async () => {
    const f = await graphFixture();
    const selected = new TextEncoder().encode("changed but valid original terms");
    const hash = await custodyHash(selected);
    f.native.rowFault = (sql, actual) =>
      sql.startsWith(`SELECT transaction_ref,registration_ref`)
        ? actual.map((row) => ({
            ...row,
            terms_original_bytes: selected,
            terms_custody_sha256: hash,
            terms_digest_original: hash,
          }))
        : actual;
    await expect(
      createSharedAuthFinancialConsentPendingRecovery(
        f.connection,
        f.input.pending,
      ).readOriginalPendingData(),
    ).rejects.toMatchObject({ code: "custody_conflict" });
    expect(f.native.batchCalls).toBe(0);
    noDownstream(f);
  });
});
