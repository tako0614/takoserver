import { describe, expect, test } from "bun:test";
import { MONEY_CUTOVER_PERMIT_TABLE } from "../src/money-cutover-sql.ts";
import { type Row, SqlError, type SqlStatement } from "../src/ports.ts";
import {
  createSharedAuthFinancialConsentRequestCommandRecovery,
  persistCaptureAndConsumeSharedAuthFinancialConsentRequestData,
  type SharedAuthFinancialConsentOriginalCommand,
  sharedAuthFinancialConsentCommandCaptureStatement,
  sharedAuthFinancialConsentOriginalConsumeStatement,
  sharedAuthFinancialConsentPendingCaptureConsumeStatements,
  sharedAuthFinancialConsentPendingPersistenceStatement,
} from "../src/shared-auth-financial-consent-store.ts";
import type { D1ResultLike } from "../src/sql-d1.ts";
import { graphFixture, rows, snapshot, write } from "./consent-request-graph-fixture.ts";

const P = "shared_auth_financial_consent_pending";
const C = "shared_auth_financial_consent_commands";
const O = "shared_auth_financial_consent_originals";
type Fixture = Awaited<ReturnType<typeof graphFixture>>;
function params(s: SqlStatement) {
  if (s.params === undefined) throw new Error("required batch must retain all original parameters");
  return s.params;
}
function at(s: readonly SqlStatement[], index: number): SqlStatement {
  if (s.length !== 3 || s[index] === undefined)
    throw new Error("missing one of three original required statements");
  return s[index];
}
function command(f: Fixture): SharedAuthFinancialConsentOriginalCommand {
  const c = f.input.command;
  return {
    ...c,
    key: { ...c.key },
    selectedScope: { ...c.selectedScope },
    commandBytes: new Uint8Array(c.commandBytes),
    originalBytes: new Uint8Array(c.originalBytes),
  };
}
function expectedPending(f: Fixture): Row {
  return { ...f.input.pending };
}
function expectedCommand(f: Fixture): Row {
  const c = f.input.command;
  return {
    command_ref: c.key.commandRef,
    transaction_ref: c.key.transactionRef,
    registration_ref: c.key.registrationRef,
    incarnation: c.key.incarnation,
    organization_id: c.selectedScope.organizationId,
    workspace_id: c.selectedScope.workspaceId,
    workspace_ref: c.selectedScope.workspaceRef,
    family: c.family,
    consent_ref: c.key.consentRef,
    receipt_ref: c.key.receiptRef,
    command_bytes: new Uint8Array(c.commandBytes),
    command_custody_sha256: c.commandCustodySHA256,
    original_bytes: new Uint8Array(c.originalBytes),
    original_digest: c.originalDigest,
    original_custody_sha256: c.originalCustodySHA256,
    captured_at: c.capturedAt,
  };
}
function expectedOriginal(f: Fixture): Row {
  const c = f.input.command;
  return {
    consent_ref: c.key.consentRef,
    command_ref: c.key.commandRef,
    transaction_ref: c.key.transactionRef,
    receipt_ref: c.key.receiptRef,
    registration_ref: c.key.registrationRef,
    incarnation: c.key.incarnation,
    organization_id: c.selectedScope.organizationId,
    workspace_id: c.selectedScope.workspaceId,
    workspace_ref: c.selectedScope.workspaceRef,
    original_bytes: new Uint8Array(c.originalBytes),
    original_digest: c.originalDigest,
    original_custody_sha256: c.originalCustodySHA256,
    recorded_at: f.input.recordedAt,
    receipt_recorded_at: f.input.recordedAt,
  };
}
function allOriginalRows(f: Fixture) {
  expect(rows(f.db, P)).toEqual([f.input.pending]);
  expect(rows(f.db, C)).toEqual([expectedCommand(f)]);
  expect(rows(f.db, O)).toEqual([expectedOriginal(f)]);
}
async function unavailable(p: Promise<unknown>) {
  await expect(p).rejects.toMatchObject({
    name: "SharedAuthFinancialConsentOriginalReadError",
    code: "unavailable",
  });
}
function onlyReads(f: Fixture, start: number) {
  const observed = f.native.calls.slice(start);
  expect(observed.length).toBeGreaterThan(0);
  expect(observed.every((s) => /^(?:SELECT\b|PRAGMA table_info\()/u.test(s.sql))).toBe(true);
  expect(f.native.batchCalls).toBe(1);
}
function sameNonConsent(
  f: Fixture,
  before: ReturnType<typeof snapshot>,
  effects: ReturnType<Fixture["effects"]>,
) {
  const after = snapshot(f.db);
  expect(after.root).toEqual(before.root);
  expect(after.schema).toEqual(before.schema);
  expect(rows(f.db, MONEY_CUTOVER_PERMIT_TABLE)).toHaveLength(0);
  expect(f.effects()).toEqual(effects);
}
function changedResult(
  results: readonly D1ResultLike[],
  index: number,
  update: (r: D1ResultLike) => D1ResultLike,
): readonly D1ResultLike[] {
  const original = results[index];
  if (results.length !== 5 || index < 1 || index > 3 || original === undefined)
    throw new Error("missing permit5 result");
  return results.map((v, i) => (i === index ? update(original) : v));
}
function oneRow(r: D1ResultLike): Row {
  const row = r.results?.[0];
  if (r.results?.length !== 1 || row === undefined) throw new Error("no actual original postimage");
  return row;
}

// This source uses reduced synthetic Root anchors with actual constructors,
// unchanged Money/strict-D1 adapters and local SQLite transactions. It is not
// native D1 or genuine credential/human/Clock/R1/current-admission evidence.
describe("unmounted one-batch pending29 command16 mandatory-original14 DATA", () => {
  test("one actual captured Money batch returns exact29 16 14 rows and one same-row mandatory receipt", async () => {
    const f = await graphFixture({ seedPending: false });
    const before = snapshot(f.db);
    const effects = f.effects();
    const statements = await sharedAuthFinancialConsentPendingCaptureConsumeStatements(f.input);
    const actual = await persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(
      f.connection,
      f.input,
    );
    expect(f.native.batchCalls).toBe(1);
    expect(f.native.committedBatches).toHaveLength(1);
    const native = f.native.committedBatches[0];
    if (native === undefined) throw new Error("no committed actual batch");
    expect(native).toHaveLength(5);
    expect(native.map((r) => r.meta?.changes)).toEqual([1, 1, 1, 1, 1]);
    expect(native.slice(1, 4).map((r) => Object.keys(oneRow(r)).length)).toEqual([29, 16, 14]);
    expect(oneRow(native[1]!)).toEqual(expectedPending(f));
    expect(oneRow(native[2]!)).toEqual(expectedCommand(f));
    expect(oneRow(native[3]!)).toEqual(expectedOriginal(f));
    const mutations = f.native.calls.filter((s) => /\b(?:INSERT INTO|DELETE FROM)\b/u.test(s.sql));
    expect(mutations).toHaveLength(5);
    expect(mutations[0]?.sql).toContain(`INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE}`);
    for (let i = 0; i < 3; i++)
      expect(mutations[i + 1]).toEqual({
        sql: at(statements, i).sql,
        params: params(at(statements, i)),
      });
    expect(mutations[4]?.sql).toContain(`DELETE FROM ${MONEY_CUTOVER_PERMIT_TABLE}`);
    allOriginalRows(f);
    sameNonConsent(f, before, effects);
    expect(actual.state).toBe("receipted-original-data");
    expect(actual.command.key).toEqual(f.input.command.key);
    expect(Array.from(actual.command.commandBytes)).toEqual(
      Array.from(f.input.command.commandBytes),
    );
    expect(actual.receiptRef).toBe(f.input.command.key.receiptRef);
    expect(actual.receiptRecordedAt).toBe(f.input.recordedAt);
  });

  test("all81 45 81 bindings and every old predicate survive without a WHERE-zero or an extra expected row", async () => {
    const f = await graphFixture({ seedPending: false });
    const required = await sharedAuthFinancialConsentPendingCaptureConsumeStatements(f.input);
    await expect(sharedAuthFinancialConsentCommandCaptureStatement(f.input)).rejects.toMatchObject({
      code: "invalid_request",
    });
    const old = [
      await sharedAuthFinancialConsentPendingPersistenceStatement(f.input),
      await sharedAuthFinancialConsentCommandCaptureStatement({
        pending: f.input.pending,
        command: f.input.command,
      }),
      await sharedAuthFinancialConsentOriginalConsumeStatement(f.input),
    ];
    expect(required.map((s) => params(s).length)).toEqual([81, 45, 81]);
    for (let i = 0; i < 3; i++) {
      const s = at(required, i);
      const previous = at(old, i);
      expect(params(s)).toEqual(params(previous));
      expect(params(s).length).toBeLessThanOrEqual(100);
      expect(s.sql.match(/\?/gu)).toHaveLength(params(s).length);
      const beforeWhere = previous.sql.split("\nWHERE ")[1]?.split("\nRETURNING ")[0];
      const afterWhere = s.sql.split("SELECT CASE WHEN (")[1]?.split(") THEN ")[0];
      if (beforeWhere === undefined || afterWhere === undefined)
        throw new Error("missing exact original predicate");
      expect(afterWhere).toBe(beforeWhere);
      expect(s.sql).toContain(" ELSE NULL END,");
      expect(s.sql.match(/AS \(VALUES \(/gu)).toHaveLength(1);
      expect(s.sql).toContain("FROM expected e");
    }
    expect(at(required, 1).sql).toContain(
      `LEFT JOIN ${P} p ON p.transaction_ref=e.p_transaction_ref`,
    );
    expect(at(required, 2).sql).toContain(
      `LEFT JOIN ${C} c ON c.transaction_ref=p.transaction_ref AND c.command_ref=e.c_command_ref`,
    );
    expect(f.native.batchCalls).toBe(0);
  });

  test("a false or NULL pending guard is a real SQL failure with no committed prefix", async () => {
    for (const selected of ["false", "null"] as const) {
      const f = await graphFixture({ seedPending: false });
      const before = snapshot(f.db);
      const s = await sharedAuthFinancialConsentPendingCaptureConsumeStatements(f.input);
      const p = at(s, 0);
      const values = [...params(p)];
      values[45] = selected === "null" ? null : f.input.pending.expires_at;
      const changed = [{ ...p, params: values }, at(s, 1), at(s, 2)];
      await expect(f.graph.sql.batch(changed)).rejects.toBeInstanceOf(SqlError);
      expect(f.native.calls.at(-1)?.sql).toBe(p.sql);
      expect(f.native.batchCalls).toBe(1);
      expect(f.native.committedBatches).toHaveLength(0);
      expect(snapshot(f.db)).toEqual(before);
      expect(rows(f.db, MONEY_CUTOVER_PERMIT_TABLE)).toHaveLength(0);
    }
  });

  test("capture guard false or NULL aborts its same-primary batch including an already executed pending INSERT", async () => {
    for (const selected of ["false", "null"] as const) {
      const f = await graphFixture({ seedPending: false });
      const before = snapshot(f.db);
      const s = await sharedAuthFinancialConsentPendingCaptureConsumeStatements(f.input);
      const c = at(s, 1);
      const values = [...params(c)];
      if (selected === "null") values[44] = null;
      else values[9] = `sha256:${"0".repeat(64)}`;
      await expect(
        f.graph.sql.batch([at(s, 0), { ...c, params: values }, at(s, 2)]),
      ).rejects.toBeInstanceOf(SqlError);
      expect(f.native.calls.at(-1)?.sql).toBe(c.sql);
      expect(f.native.calls.some((call) => call.sql === at(s, 0).sql)).toBe(true);
      expect(f.native.calls.some((call) => call.sql === c.sql)).toBe(true);
      expect(f.native.committedBatches).toHaveLength(0);
      expect(snapshot(f.db)).toEqual(before);
      expect(rows(f.db, MONEY_CUTOVER_PERMIT_TABLE)).toHaveLength(0);
    }
  });

  test("consume guard false or NULL aborts both preceding immutable writes and their permit", async () => {
    for (const selected of ["false", "null"] as const) {
      const f = await graphFixture({ seedPending: false });
      const before = snapshot(f.db);
      const s = await sharedAuthFinancialConsentPendingCaptureConsumeStatements(f.input);
      const o = at(s, 2);
      const values = [...params(o)];
      values[45] = selected === "null" ? null : f.input.pending.expires_at;
      await expect(
        f.graph.sql.batch([at(s, 0), at(s, 1), { ...o, params: values }]),
      ).rejects.toBeInstanceOf(SqlError);
      expect(f.native.calls.at(-1)?.sql).toBe(o.sql);
      expect(f.native.calls.some((call) => call.sql === at(s, 0).sql)).toBe(true);
      expect(f.native.calls.some((call) => call.sql === at(s, 1).sql)).toBe(true);
      expect(f.native.committedBatches).toHaveLength(0);
      expect(snapshot(f.db)).toEqual(before);
      expect(rows(f.db, MONEY_CUTOVER_PERMIT_TABLE)).toHaveLength(0);
    }
  });

  test("positive affected1 and exact29 16 14 stored rows precede an identified intentional late SQL fault and all roll back", async () => {
    const f = await graphFixture({ seedPending: false });
    const before = snapshot(f.db);
    const s = await sharedAuthFinancialConsentPendingCaptureConsumeStatements(f.input);
    let reached = false;
    let late: unknown;
    let observed: unknown;
    try {
      f.db.transaction(() => {
        const p = write(f.db, at(s, 0));
        const c = write(f.db, at(s, 1));
        const o = write(f.db, at(s, 2));
        expect([p.changes, c.changes, o.changes]).toEqual([1, 1, 1]);
        expect(p.rows).toEqual([expectedPending(f)]);
        expect(c.rows).toEqual([expectedCommand(f)]);
        expect(o.rows).toEqual([expectedOriginal(f)]);
        expect([
          Object.keys(p.rows[0]!).length,
          Object.keys(c.rows[0]!).length,
          Object.keys(o.rows[0]!).length,
        ]).toEqual([29, 16, 14]);
        allOriginalRows(f);
        reached = true;
        try {
          f.db.exec("SELECT n4_intentional_late_fault FROM n4_no_late_table");
        } catch (error) {
          late = error;
          throw error;
        }
        throw new Error("intentional late SQL unexpectedly succeeded");
      })();
    } catch (error) {
      observed = error;
    }
    expect(reached).toBe(true);
    expect(late).toBeInstanceOf(Error);
    expect(observed).toBe(late);
    expect(String(late)).toContain("n4_no_late_table");
    expect(snapshot(f.db)).toEqual(before);
    expect(f.native.batchCalls).toBe(0);
  });

  test("the real Money batch late SQL failure rolls back all three successful statements with no permit left", async () => {
    const f = await graphFixture({ seedPending: false });
    const before = snapshot(f.db);
    const s = await sharedAuthFinancialConsentPendingCaptureConsumeStatements(f.input);
    await expect(
      f.graph.sql.batch([...s, { sql: "SELECT n4_late_failure FROM n4_no_late_table" }]),
    ).rejects.toMatchObject({ code: "unavailable" });
    const executed = f.native.calls.filter((call) =>
      s.some((statement) => statement.sql === call.sql),
    );
    expect(executed.map((call) => call.sql)).toEqual(s.map((statement) => statement.sql));
    expect(f.native.calls.at(-1)?.sql).toBe("SELECT n4_late_failure FROM n4_no_late_table");
    expect(f.native.committedBatches).toHaveLength(0);
    expect(snapshot(f.db)).toEqual(before);
    expect(rows(f.db, MONEY_CUTOVER_PERMIT_TABLE)).toHaveLength(0);
  });

  test("committed batch lost ACK is recovered only by original fullcommand GET without another write", async () => {
    const f = await graphFixture({ seedPending: false });
    const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
      f.connection,
      command(f),
    );
    f.native.afterBatch = () => {
      throw new Error("committed batch transport ACK lost");
    };
    await unavailable(
      persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(f.connection, f.input),
    );
    allOriginalRows(f);
    expect(f.native.committedBatches).toHaveLength(1);
    expect(f.native.batchCalls).toBe(1);
    const start = f.native.calls.length;
    const original = await recovery.readOriginalData();
    onlyReads(f, start);
    expect(original.command.key).toEqual(f.input.command.key);
    expect(original.receiptRef).toBe(f.input.command.key.receiptRef);
    expect(Object.keys(recovery)).toEqual(["readOriginalData"]);
  });

  test("known0 multiple malformed unknown and corrupted whole postimage ACKs never cause a second batch or fake rollback", async () => {
    for (const kind of [
      "zero",
      "two",
      "unknown",
      "extra",
      "missing",
      "duplicate",
      "wrong-bytes",
      "wrong-receipt",
    ] as const) {
      for (const index of [1, 2, 3]) {
        const f = await graphFixture({ seedPending: false });
        const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
          f.connection,
          command(f),
        );
        f.native.afterBatch = (results) =>
          changedResult(results, index, (r) => {
            if (kind === "zero") return { ...r, meta: { changes: 0 } };
            if (kind === "two") return { ...r, meta: { changes: 2 } };
            if (kind === "unknown") return { ...r, meta: { changes: null } };
            const row = oneRow(r);
            if (kind === "extra")
              return { ...r, results: [{ ...row, extra_scalar: "unexpected" }] };
            if (kind === "missing") {
              const partial = { ...row };
              delete partial.transaction_ref;
              return { ...r, results: [partial] };
            }
            if (kind === "duplicate") return { ...r, results: [row, row] };
            if (kind === "wrong-receipt")
              return {
                ...r,
                results: [
                  {
                    ...row,
                    [index === 1 ? "transaction_ref" : "receipt_ref"]: "changed original ref",
                  },
                ],
              };
            return {
              ...r,
              results: [
                {
                  ...row,
                  [index === 1 ? "action_original_bytes" : "original_bytes"]: new Uint8Array([0]),
                },
              ],
            };
          });
        await unavailable(
          persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(f.connection, f.input),
        );
        allOriginalRows(f);
        expect(f.native.committedBatches).toHaveLength(1);
        expect(f.native.batchCalls).toBe(1);
        const start = f.native.calls.length;
        expect((await recovery.readOriginalData()).receiptRef).toBe(f.input.command.key.receiptRef);
        onlyReads(f, start);
      }
    }
  });

  test("SQL revocation version and expiry immediately before dispatch abort without persisting pending or command prefixes", async () => {
    for (const change of [
      "UPDATE credential_authority_classes SET state='retired'",
      "UPDATE shared_principal_bindings SET state='retired'",
      "UPDATE shared_auth_sessions SET version=version+1",
      "UPDATE shared_auth_sessions SET absolute_expires_at=0",
    ]) {
      const f = await graphFixture({ seedPending: false });
      f.native.beforeBatch = async () => {
        f.db.exec(change);
      };
      await unavailable(
        persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(f.connection, f.input),
      );
      for (const table of [P, C, O, MONEY_CUTOVER_PERMIT_TABLE])
        expect(rows(f.db, table)).toHaveLength(0);
      expect(f.native.committedBatches).toHaveLength(0);
      expect(f.native.batchCalls).toBe(1);
    }
  });

  test("invalid original recipe or input guard shape is refused before any batch", async () => {
    for (const kind of ["bytes", "window", "accessor"] as const) {
      const f = await graphFixture({ seedPending: false });
      const before = snapshot(f.db);
      let getters = 0;
      if (kind === "bytes") f.input.command.originalBytes.fill(0);
      if (kind === "window")
        Object.assign(f.input.pending, { expires_at: f.input.pending.created_at + 300001 });
      if (kind === "accessor")
        Object.defineProperty(f.input.pending, "action_ref", {
          enumerable: true,
          get() {
            getters++;
            throw new Error("must not invoke input getter");
          },
        });
      await expect(
        persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(f.connection, f.input),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(f.native.batchCalls).toBe(0);
      expect(getters).toBe(0);
      expect(snapshot(f.db)).toEqual(before);
    }
  });

  test("input originals key and times are detached before the first await without reconstructing any reference", async () => {
    const f = await graphFixture({ seedPending: false });
    const original = command(f);
    const p = {
      ...f.input.pending,
      action_original_bytes: new Uint8Array(f.input.pending.action_original_bytes),
    };
    const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(f.connection, original);
    const attempt = persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(
      f.connection,
      f.input,
    );
    f.input.command.commandBytes.fill(0);
    f.input.command.originalBytes.fill(0);
    f.input.pending.action_original_bytes.fill(0);
    Object.assign(f.input.command.key, { commandRef: "not the original key" });
    Object.assign(f.input, { recordedAt: 0 });
    const result = await attempt;
    expect(result.command.key).toEqual(original.key);
    expect(rows(f.db, P)).toEqual([p]);
    expect((await recovery.readOriginalData()).command.key).toEqual(original.key);
    expect(f.native.batchCalls).toBe(1);
  });

  test("frozen batch method rejects replacement during dispatch and retains one original result", async () => {
    const f = await graphFixture({ seedPending: false });
    let replacementCalls = 0;
    let replaced: boolean | undefined;
    f.native.afterBatch = (results) => {
      replaced = Reflect.defineProperty(f.graph.sql, "batch", {
        value: async () => {
          replacementCalls++;
          return [];
        },
        enumerable: true,
        writable: true,
        configurable: true,
      });
      return results;
    };
    const actual = await persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(
      f.connection,
      f.input,
    );
    expect(Object.isFrozen(f.graph.sql)).toBe(true);
    expect(replaced).toBe(false);
    expect(actual.state).toBe("receipted-original-data");
    expect(replacementCalls).toBe(0);
    expect(f.native.batchCalls).toBe(1);
    allOriginalRows(f);
  });

  test("a cloned connection or plain delegated Sql cannot borrow the actual request graph to issue a batch", async () => {
    const f = await graphFixture({ seedPending: false });
    const before = snapshot(f.db);
    const clone = { ...f.connection };
    await unavailable(
      persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(clone, f.input),
    );
    let borrowedCalls = 0;
    const plain = {
      sql: {
        async query() {
          borrowedCalls++;
          return [];
        },
        async run() {
          borrowedCalls++;
          return { changes: 1, rows: [] };
        },
        async batch() {
          borrowedCalls++;
          return [];
        },
      },
      moneyGuard: f.connection.moneyGuard,
    };
    await unavailable(
      persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(plain, f.input),
    );
    expect(borrowedCalls).toBe(0);
    expect(f.native.batchCalls).toBe(0);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("a repeated same-command call fails its fresh-row constraint without gaining a durable resend lease", async () => {
    const f = await graphFixture({ seedPending: false });
    await persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(f.connection, f.input);
    const stored = snapshot(f.db);
    await unavailable(
      persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(f.connection, f.input),
    );
    expect(f.native.batchCalls).toBe(2);
    expect(f.native.committedBatches).toHaveLength(1);
    expect(snapshot(f.db)).toEqual(stored);
    const before = f.native.calls.length;
    expect(
      (
        await createSharedAuthFinancialConsentRequestCommandRecovery(
          f.connection,
          command(f),
        ).readOriginalData()
      ).receiptRef,
    ).toBe(f.input.command.key.receiptRef);
    expect(
      f.native.calls.slice(before).every((s) => /^(?:SELECT\b|PRAGMA table_info\()/u.test(s.sql)),
    ).toBe(true);
  });

  test("pending-only and complete absence alone are not permission to continue or resubmit", async () => {
    for (const seedPending of [false, true]) {
      const f = await graphFixture({ seedPending });
      const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
        f.connection,
        command(f),
      );
      await unavailable(recovery.readOriginalData());
      expect(f.native.batchCalls).toBe(0);
      expect(rows(f.db, C)).toHaveLength(0);
      expect(rows(f.db, O)).toHaveLength(0);
    }
  });

  test("historical fullcommand GET remains query-only after retirement and an external borrowed SQL error stays unavailable", async () => {
    const f = await graphFixture({ seedPending: false });
    const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
      f.connection,
      command(f),
    );
    await persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(f.connection, f.input);
    f.db.exec(
      "UPDATE credential_authority_classes SET state='retired'; UPDATE shared_auth_sessions SET status='revoked'",
    );
    const start = f.native.calls.length;
    expect((await recovery.readOriginalData()).receiptRecordedAt).toBe(f.input.recordedAt);
    onlyReads(f, start);
    f.native.beforeRead = async (sql) => {
      if (sql.startsWith("SELECT transaction_ref,registration_ref"))
        throw Object.assign(new Error("external borrowed typed code"), {
          code: "custody_conflict",
        });
    };
    await unavailable(recovery.readOriginalData());
    expect(f.native.batchCalls).toBe(1);
  });
});
