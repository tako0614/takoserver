import { describe, expect, test } from "bun:test";
import { MONEY_CUTOVER_PERMIT_TABLE } from "../src/money-cutover-sql.ts";
import type { Row, SqlStatement } from "../src/ports.ts";
import {
  captureAndConsumeSharedAuthFinancialConsentRequestOriginalData,
  createSharedAuthFinancialConsentRequestCommandRecovery,
  type SharedAuthFinancialConsentGuardedStatementData,
  type SharedAuthFinancialConsentOriginalCommand,
  SharedAuthFinancialConsentOriginalReadError,
  sharedAuthFinancialConsentCommandCaptureStatement,
  sharedAuthFinancialConsentOriginalConsumeStatement,
} from "../src/shared-auth-financial-consent-store.ts";
import type { D1ResultLike } from "../src/sql-d1.ts";
import {
  bytes,
  captureInput,
  graphFixture,
  rows,
  snapshot,
} from "./consent-request-graph-fixture.ts";

const C = "shared_auth_financial_consent_commands";
const O = "shared_auth_financial_consent_originals";
type Fixture = Awaited<ReturnType<typeof graphFixture>>;

// This uses the pinned fixture's actual constructors and real Money -> strict
// D1 -> native-shaped SQLite transactions. Root anchors/pending are synthetic,
// not genuine human/current admission or native D1/Financial authority.
function params(statement: SqlStatement) {
  if (statement.params === undefined)
    throw new Error("closed capture/consume must have its original parameters");
  return statement.params;
}
function originalCommand(
  input: SharedAuthFinancialConsentGuardedStatementData,
): SharedAuthFinancialConsentOriginalCommand {
  return Object.freeze({
    ...input.command,
    key: Object.freeze({ ...input.command.key }),
    selectedScope: Object.freeze({ ...input.command.selectedScope }),
    commandBytes: new Uint8Array(input.command.commandBytes),
    originalBytes: new Uint8Array(input.command.originalBytes),
  });
}
function writes(f: Fixture, table: string) {
  return f.native.calls.filter((call) => call.sql.includes(`INSERT INTO ${table} (`));
}
function batchResult(f: Fixture, index: number): D1ResultLike {
  const result = f.native.committedBatches[index]?.[1];
  if (result === undefined) throw new Error("missing actual middle write result");
  return result;
}
function changedMiddle(
  results: readonly D1ResultLike[],
  change: (result: D1ResultLike) => D1ResultLike,
): readonly D1ResultLike[] {
  const middle = results[1];
  if (results.length !== 3 || middle === undefined)
    throw new Error("Money permit transaction must contain all three results");
  return results.map((value, index) => (index === 1 ? change(middle) : value));
}
function firstRow(result: D1ResultLike): Row {
  const row = result.results?.[0];
  if (row === undefined || result.results?.length !== 1)
    throw new Error("missing actual returning row");
  return row;
}
async function unavailable(effect: Promise<unknown>): Promise<void> {
  await expect(effect).rejects.toMatchObject({
    name: "SharedAuthFinancialConsentOriginalReadError",
    code: "unavailable",
  });
}
function unchangedEffects(f: Fixture, prior: ReturnType<Fixture["effects"]>) {
  expect(f.effects()).toEqual(prior);
  expect(rows(f.db, MONEY_CUTOVER_PERMIT_TABLE)).toHaveLength(0);
}
function queryOnly(f: Fixture, start: number) {
  const calls = f.native.calls.slice(start);
  expect(calls.length).toBeGreaterThan(0);
  expect(calls.every((call) => /^(?:SELECT\b|PRAGMA table_info\()/u.test(call.sql))).toBe(true);
  expect(calls.some((call) => /\b(?:INSERT INTO|UPDATE|DELETE FROM)\b/u.test(call.sql))).toBe(
    false,
  );
}
function fullOriginalRow(
  f: Fixture,
  command: SharedAuthFinancialConsentOriginalCommand,
  recordedAt: number,
) {
  const actual = f.db.query<Row, []>(`SELECT * FROM ${O}`).get();
  if (actual === null) throw new Error("no persisted original/mandatory receipt");
  const expected: Row = {
    consent_ref: command.key.consentRef,
    command_ref: command.key.commandRef,
    transaction_ref: command.key.transactionRef,
    receipt_ref: command.key.receiptRef,
    registration_ref: command.key.registrationRef,
    incarnation: command.key.incarnation,
    organization_id: command.selectedScope.organizationId,
    workspace_id: command.selectedScope.workspaceId,
    workspace_ref: command.selectedScope.workspaceRef,
    original_bytes: new Uint8Array(command.originalBytes),
    original_digest: command.originalDigest,
    original_custody_sha256: command.originalCustodySHA256,
    recorded_at: recordedAt,
    receipt_recorded_at: recordedAt,
  };
  expect(Object.keys(actual).sort()).toEqual(Object.keys(expected).sort());
  expect(actual).toEqual(expected);
}

describe("unmounted actual request capture-to-consume ordered DATA effect", () => {
  test("one captured Money Sql executes permit3 capture45 then permit3 consume81 and returns exact receipted fullcommand DATA", async () => {
    const f = await graphFixture();
    const prior = snapshot(f.db);
    const effects = f.effects();
    const capture = await sharedAuthFinancialConsentCommandCaptureStatement(captureInput(f.input));
    const consume = await sharedAuthFinancialConsentOriginalConsumeStatement(f.input);
    const capParams = params(capture);
    const consumeParams = params(consume);
    const command = originalCommand(f.input);
    const result = await captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(
      f.connection,
      f.input,
    );
    expect(f.native.batchCalls).toBe(2);
    expect(f.native.committedBatches.map((batch) => batch.length)).toEqual([3, 3]);
    for (const batch of f.native.committedBatches)
      expect(batch.map((result) => result.meta?.changes)).toEqual([1, 1, 1]);
    expect(f.native.calls.slice(0, 6)).toEqual([
      expect.objectContaining({
        sql: expect.stringContaining(`INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE}`),
      }),
      { sql: capture.sql, params: capParams },
      expect.objectContaining({
        sql: expect.stringContaining(`DELETE FROM ${MONEY_CUTOVER_PERMIT_TABLE}`),
      }),
      expect.objectContaining({
        sql: expect.stringContaining(`INSERT INTO ${MONEY_CUTOVER_PERMIT_TABLE}`),
      }),
      { sql: consume.sql, params: consumeParams },
      expect.objectContaining({
        sql: expect.stringContaining(`DELETE FROM ${MONEY_CUTOVER_PERMIT_TABLE}`),
      }),
    ]);
    expect(capParams.length).toBe(45);
    expect(consumeParams.length).toBe(81);
    expect(batchResult(f, 0).meta?.changes).toBe(1);
    expect(batchResult(f, 1).meta?.changes).toBe(1);
    expect(Object.keys(firstRow(batchResult(f, 0))).length).toBe(16);
    expect(Object.keys(firstRow(batchResult(f, 1))).length).toBe(14);
    expect(rows(f.db, C)).toHaveLength(1);
    expect(rows(f.db, O)).toHaveLength(1);
    expect(result.state).toBe("receipted-original-data");
    expect(result.command.key).toEqual(command.key);
    expect(Array.from(result.command.commandBytes)).toEqual(Array.from(command.commandBytes));
    expect(Array.from(result.originalBytes)).toEqual(Array.from(command.originalBytes));
    expect(result.originalDigest).toBe(command.originalDigest);
    expect(result.originalCustodySHA256).toBe(command.originalCustodySHA256);
    expect(result.recordedAt).toBe(f.input.recordedAt);
    expect(result.receiptRecordedAt).toBe(f.input.recordedAt);
    expect(result.receiptRef).toBe(command.key.receiptRef);
    fullOriginalRow(f, command, f.input.recordedAt);
    const after = snapshot(f.db);
    expect(after.root).toEqual(prior.root);
    expect(after.pending).toEqual(prior.pending);
    expect(after.schema).toEqual(prior.schema);
    queryOnly(f, 6);
    unchangedEffects(f, effects);
  });

  test("closed guard-input and canonical original failures are rejected before the first real write", async () => {
    for (const kind of ["credential", "current", "time", "sequence", "canonical"] as const) {
      const f = await graphFixture();
      const prior = snapshot(f.db);
      if (kind === "credential")
        Object.assign(f.input.credential.origin, { targetRef: "different_target" });
      if (kind === "current") Object.assign(f.input.currentSession, { version: -1 });
      if (kind === "time") Object.assign(f.input, { recordedAt: -1 });
      if (kind === "sequence")
        Object.assign(f.input, { recordedAt: f.input.command.capturedAt - 1 });
      if (kind === "canonical") f.input.command.originalBytes.fill(0);
      await expect(
        captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(f.native.batchCalls).toBe(0);
      expect(f.native.calls).toEqual([]);
      expect(snapshot(f.db)).toEqual(prior);
    }
  });

  test("capture commit with lost ACK never dispatches consume and fixed recovery remains command-only unavailable", async () => {
    const f = await graphFixture();
    const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
      f.connection,
      f.input.command,
    );
    f.native.afterBatch = (results) => {
      if (f.native.batchCalls === 1) throw new Error("capture committed acknowledgement lost");
      return results;
    };
    await unavailable(
      captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
    );
    expect(f.native.batchCalls).toBe(1);
    expect(writes(f, C)).toHaveLength(1);
    expect(writes(f, O)).toHaveLength(0);
    expect(rows(f.db, C)).toHaveLength(1);
    expect(rows(f.db, O)).toHaveLength(0);
    const start = f.native.calls.length;
    await unavailable(recovery.readOriginalData());
    queryOnly(f, start);
    expect(f.native.batchCalls).toBe(1);
  });

  test("capture zero unknown malformed whole postimage or origin change cannot reach consume", async () => {
    for (const fault of ["zero", "unknown", "extra", "origin"] as const) {
      const f = await graphFixture();
      f.native.afterBatch = (results) => {
        if (f.native.batchCalls !== 1) return results;
        if (fault === "origin") {
          f.replaceGraph();
          return results;
        }
        return changedMiddle(results, (result) =>
          fault === "zero"
            ? { ...result, meta: { changes: 0 } }
            : fault === "unknown"
              ? { ...result, meta: { changes: null } }
              : {
                  ...result,
                  results: [{ ...firstRow(result), extra_scalar: "not a capture16 column" }],
                },
        );
      };
      await unavailable(
        captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
      );
      expect(f.native.batchCalls).toBe(1);
      expect(writes(f, O)).toHaveLength(0);
      expect(rows(f.db, O)).toHaveLength(0);
    }
  });

  test("consume commit with lost ACK recovers the same mandatory receipt using only the original GET and never resends", async () => {
    const f = await graphFixture();
    const command = originalCommand(f.input);
    const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(f.connection, command);
    f.native.afterBatch = (results) => {
      if (f.native.batchCalls === 2) throw new Error("consume committed acknowledgement lost");
      return results;
    };
    await unavailable(
      captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
    );
    expect(f.native.batchCalls).toBe(2);
    expect(rows(f.db, O)).toHaveLength(1);
    fullOriginalRow(f, command, f.input.recordedAt);
    const start = f.native.calls.length;
    const recovered = await recovery.readOriginalData();
    queryOnly(f, start);
    expect(recovered.command.key).toEqual(command.key);
    expect(recovered.receiptRef).toBe(command.key.receiptRef);
    expect(recovered.recordedAt).toBe(f.input.recordedAt);
    expect(Array.from(recovered.originalBytes)).toEqual(Array.from(command.originalBytes));
    expect(f.native.batchCalls).toBe(2);
    expect(writes(f, C)).toHaveLength(1);
    expect(writes(f, O)).toHaveLength(1);
  });

  test("consume precommit unknown leaves command-only custody unavailable without an inferred resume lease", async () => {
    const f = await graphFixture();
    const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
      f.connection,
      f.input.command,
    );
    f.native.beforeBatch = async () => {
      if (f.native.batchCalls === 2) throw new Error("consume transport unknown before execution");
    };
    await unavailable(
      captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
    );
    expect(f.native.batchCalls).toBe(2);
    expect(f.native.committedBatches).toHaveLength(1);
    expect(rows(f.db, C)).toHaveLength(1);
    expect(rows(f.db, O)).toHaveLength(0);
    const start = f.native.calls.length;
    await unavailable(recovery.readOriginalData());
    queryOnly(f, start);
    expect(f.native.batchCalls).toBe(2);
    expect(writes(f, O)).toHaveLength(0);
  });

  test("a repeated low-level invocation is not admission and loses the same capture key without a second consume", async () => {
    const f = await graphFixture();
    const first = await captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(
      f.connection,
      f.input,
    );
    const state = snapshot(f.db);
    // Deliberate misuse negative, never a caller protocol permitting a retry.
    await unavailable(
      captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
    );
    expect(f.native.batchCalls).toBe(3);
    expect(writes(f, C)).toHaveLength(2);
    expect(writes(f, O)).toHaveLength(1);
    expect(snapshot(f.db)).toEqual(state);
    expect(first.receiptRef).toBe(f.input.command.key.receiptRef);
  });

  test("interleaved same-command contenders have one actual ACK16 winner and one consume on the synthetic single SQLite graph", async () => {
    const f = await graphFixture();
    const result = await Promise.allSettled([
      captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
      captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
    ]);
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    expect(result.filter((entry) => entry.status === "rejected")).toHaveLength(1);
    for (const entry of result)
      if (entry.status === "rejected") expect(entry.reason).toMatchObject({ code: "unavailable" });
    expect(f.native.batchCalls).toBe(3);
    expect(writes(f, C)).toHaveLength(2);
    expect(writes(f, O)).toHaveLength(1);
    expect(rows(f.db, C)).toHaveLength(1);
    expect(rows(f.db, O)).toHaveLength(1);
    fullOriginalRow(f, f.input.command, f.input.recordedAt);
    // Not a native concurrent D1/race qualification; these are JS-interleaved
    // calls whose real synchronous SQLite transactions serialize in one VM.
  });

  test("actual capture known-zero from absent or expired pending dispatches no consume and does not auto-recover or repair", async () => {
    for (const missing of [true, false]) {
      const f = await graphFixture(missing ? { seedPending: false } : { at: Date.now() - 600_000 });
      const prior = snapshot(f.db);
      await unavailable(
        captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
      );
      expect(f.native.batchCalls).toBe(1);
      expect(batchResult(f, 0).meta?.changes).toBe(0);
      expect(writes(f, O)).toHaveLength(0);
      expect(snapshot(f.db)).toEqual(prior);
    }
  });

  test("retirement version expiry and human revocation between the two transactions reject consume at its actual final SQL guard", async () => {
    for (const guard of ["retirement", "version", "expiry", "human"] as const) {
      const f = await graphFixture();
      const unrelated = rows(f.db, "unrelated_kept");
      f.native.beforeBatch = async () => {
        if (f.native.batchCalls !== 2) return;
        // Synthetic anchor change, not repair of command/original custody.
        if (guard === "retirement")
          f.db.exec("UPDATE credential_authority_classes SET state='retired'");
        if (guard === "version") f.db.exec("UPDATE shared_auth_sessions SET version=version+1");
        if (guard === "expiry") f.db.exec("UPDATE shared_auth_sessions SET absolute_expires_at=0");
        if (guard === "human") f.db.exec("UPDATE shared_principal_bindings SET state='retired'");
      };
      await unavailable(
        captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
      );
      expect(f.native.batchCalls).toBe(2);
      expect(batchResult(f, 1).meta?.changes).toBe(0);
      expect(rows(f.db, C)).toHaveLength(1);
      expect(rows(f.db, O)).toHaveLength(0);
      expect(rows(f.db, "unrelated_kept")).toEqual(unrelated);
    }
  });

  test("input whole BLOBs keys timestamps and Root metadata detach before the first await for both original statements", async () => {
    const f = await graphFixture();
    const command = originalCommand(f.input);
    const recordedAt = f.input.recordedAt;
    const capture = await sharedAuthFinancialConsentCommandCaptureStatement(captureInput(f.input));
    const consume = await sharedAuthFinancialConsentOriginalConsumeStatement(f.input);
    const capParams = params(capture);
    const consumeParams = params(consume);
    const promise = captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(
      f.connection,
      f.input,
    );
    f.input.command.commandBytes.fill(0);
    f.input.command.originalBytes.fill(0);
    f.input.pending.action_original_bytes.fill(0);
    f.input.pending.terms_original_bytes.fill(0);
    f.input.pending.challenge_original_bytes.fill(0);
    Object.assign(f.input.command.key, {
      receiptRef: "borrowed_receipt",
      commandRef: "borrowed_command",
    });
    Object.assign(f.input.command.selectedScope, { workspaceId: "borrowed_workspace" });
    Object.assign(f.input, { recordedAt: recordedAt + 1 });
    Object.assign(f.input.currentSession, { version: 999 });
    Object.assign(f.input.credential.rp, { sessionDigest: "sha256:" + "1".repeat(64) });
    Object.assign(f.input.human, { ref: "borrowed_human" });
    const result = await promise;
    expect(writes(f, C)).toEqual([{ sql: capture.sql, params: capParams }]);
    expect(writes(f, O)).toEqual([{ sql: consume.sql, params: consumeParams }]);
    expect(result.command.key).toEqual(command.key);
    expect(result.recordedAt).toBe(recordedAt);
    expect(Array.from(result.originalBytes)).toEqual(Array.from(command.originalBytes));
    fullOriginalRow(f, command, recordedAt);
  });

  test("accessor inputs plain connections and same-shaped connection clones cannot replace the real captured graph", async () => {
    const f = await graphFixture();
    let getters = 0;
    const input = { ...f.input };
    Object.defineProperty(input, "human", {
      enumerable: true,
      get() {
        getters++;
        return f.input.human;
      },
    });
    await expect(
      captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, input),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await unavailable(
      captureAndConsumeSharedAuthFinancialConsentRequestOriginalData({ ...f.connection }, f.input),
    );
    expect(getters).toBe(0);
    expect(f.native.batchCalls).toBe(0);
    expect(f.native.calls).toEqual([]);
  });

  test("method replacement across preflight or the consume await fails closing origin without a third write", async () => {
    for (const phase of ["preflight", "consume"] as const) {
      const f = await graphFixture();
      if (phase === "consume")
        f.native.afterBatch = (result) => {
          if (f.native.batchCalls === 2)
            f.connection.sql.query = f.connection.sql.query.bind(f.connection.sql);
          return result;
        };
      const promise = captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(
        f.connection,
        f.input,
      );
      if (phase === "preflight") f.connection.sql.run = f.connection.sql.run.bind(f.connection.sql);
      await unavailable(promise);
      expect(f.native.batchCalls).toBe(phase === "preflight" ? 0 : 2);
      expect(rows(f.db, O)).toHaveLength(phase === "preflight" ? 0 : 1);
    }
  });

  test("consume ACK rejects missing extra duplicate wrong receipt and changed full BLOB postimages even after a real commit", async () => {
    for (const fault of ["missing", "extra", "duplicate", "receipt", "blob", "accessor"] as const) {
      const f = await graphFixture();
      let getters = 0;
      const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
        f.connection,
        f.input.command,
      );
      f.native.afterBatch = (results) =>
        f.native.batchCalls !== 2
          ? results
          : changedMiddle(results, (result) => {
              const row = firstRow(result);
              if (fault === "missing") {
                const missing = { ...row };
                delete missing.receipt_ref;
                return { ...result, results: [missing] };
              }
              if (fault === "extra") return { ...result, results: [{ ...row, extra_scalar: 1 }] };
              if (fault === "duplicate") return { ...result, results: [row, row] };
              if (fault === "receipt")
                return { ...result, results: [{ ...row, receipt_ref: "wrong_original_receipt" }] };
              if (fault === "blob")
                return {
                  ...result,
                  results: [{ ...row, original_bytes: bytes("wrong whole immutable original") }],
                };
              const access = { ...row };
              Object.defineProperty(access, "original_digest", {
                enumerable: true,
                get() {
                  getters++;
                  return row.original_digest;
                },
              });
              return { ...result, results: [access] };
            });
      await unavailable(
        captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
      );
      expect(f.native.batchCalls).toBe(2);
      expect(rows(f.db, O)).toHaveLength(1);
      expect(getters).toBe(0);
      const start = f.native.calls.length;
      const result = await recovery.readOriginalData();
      queryOnly(f, start);
      expect(result.receiptRef).toBe(f.input.command.key.receiptRef);
      expect(f.native.batchCalls).toBe(2);
    }
  });

  test("consume affected2 and unknown ACK do not become a synthetic changes1 despite a matching actual row", async () => {
    for (const changes of [2, null]) {
      const f = await graphFixture();
      f.native.afterBatch = (results) =>
        f.native.batchCalls !== 2
          ? results
          : changedMiddle(results, (result) => ({ ...result, meta: { changes } }));
      await unavailable(
        captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
      );
      expect(f.native.batchCalls).toBe(2);
      expect(rows(f.db, O)).toHaveLength(1);
      expect(writes(f, C)).toHaveLength(1);
      expect(writes(f, O)).toHaveLength(1);
    }
  });

  test("historical GET unknown after both positive ACKs never repeats either write and the fixed original query can later recover", async () => {
    const f = await graphFixture();
    const recovery = createSharedAuthFinancialConsentRequestCommandRecovery(
      f.connection,
      f.input.command,
    );
    f.native.beforeRead = async () => {
      throw new SharedAuthFinancialConsentOriginalReadError("custody_conflict");
    };
    await unavailable(
      captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(f.connection, f.input),
    );
    expect(f.native.batchCalls).toBe(2);
    expect(rows(f.db, O)).toHaveLength(1);
    delete f.native.beforeRead;
    const start = f.native.calls.length;
    const result = await recovery.readOriginalData();
    queryOnly(f, start);
    expect(result.receiptRef).toBe(f.input.command.key.receiptRef);
    expect(f.native.batchCalls).toBe(2);
  });

  test("retirement after successful consume still permits immutable historical GET without claiming current authority", async () => {
    const f = await graphFixture();
    f.native.afterBatch = (results) => {
      if (f.native.batchCalls === 2) {
        f.db.exec("UPDATE credential_authority_classes SET state='retired'");
        f.db.exec("UPDATE shared_auth_sessions SET status='retired',absolute_expires_at=0");
      }
      return results;
    };
    const result = await captureAndConsumeSharedAuthFinancialConsentRequestOriginalData(
      f.connection,
      f.input,
    );
    expect(result.state).toBe("receipted-original-data");
    expect(result.receiptRef).toBe(f.input.command.key.receiptRef);
    expect(Object.keys(result).sort()).toEqual(
      [
        "state",
        "command",
        "originalBytes",
        "originalDigest",
        "originalCustodySHA256",
        "recordedAt",
        "receiptRef",
        "receiptRecordedAt",
      ].sort(),
    );
    expect(f.native.batchCalls).toBe(2);
    fullOriginalRow(f, f.input.command, f.input.recordedAt);
  });
});
