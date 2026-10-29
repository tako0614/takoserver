import { describe, expect, test } from "bun:test";
import { MONEY_CUTOVER_PERMIT_TABLE } from "../src/money-cutover-sql.ts";
import type { Row, SqlStatement } from "../src/ports.ts";
import {
  captureSharedAuthFinancialConsentRequestCommandData,
  createSharedAuthFinancialConsentLocalProofDataReader,
  createSharedAuthFinancialConsentProofReferenceReader,
  persistCaptureAndConsumeSharedAuthFinancialConsentRequestData,
  SharedAuthFinancialConsentOriginalReadError,
  sharedAuthFinancialConsentLocalCurrentnessStatement,
} from "../src/shared-auth-financial-consent-store.ts";
import { graphFixture, rows, snapshot } from "./consent-request-graph-fixture.ts";

type Fixture = Awaited<ReturnType<typeof graphFixture>>;
const isLocal = (sql: string) => sql.startsWith("SELECT local_original.");
const isPending = (sql: string) =>
  sql.startsWith("SELECT transaction_ref,registration_ref,") &&
  sql.endsWith(" WHERE transaction_ref=? LIMIT 2");
function input(f: Fixture) {
  return {
    consentProofRef: f.input.command.key.consentRef,
    credential: f.input.credential,
    human: f.input.human,
    currentSession: f.input.currentSession,
  };
}
async function committed() {
  const f = await graphFixture({ seedPending: false });
  await persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(f.connection, f.input);
  return f;
}
function checkpoint(f: Fixture) {
  return {
    db: snapshot(f.db),
    effects: f.effects(),
    batches: f.native.batchCalls,
    calls: f.native.calls.length,
  };
}
function readonly(f: Fixture, before: ReturnType<typeof checkpoint>) {
  expect(snapshot(f.db)).toEqual(before.db);
  expect(f.effects()).toEqual(before.effects);
  expect(f.native.batchCalls).toBe(before.batches);
  expect(
    f.native.calls
      .slice(before.calls)
      .every((call) => /^(?:SELECT\b|PRAGMA table_info\()/u.test(call.sql)),
  ).toBe(true);
  expect(rows(f.db, MONEY_CUTOVER_PERMIT_TABLE)).toEqual([]);
}
async function unavailable(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({ code: "unavailable" });
}
function params(statement: SqlStatement) {
  if (statement.params === undefined)
    throw new Error("existing local statement must retain its81 parameters");
  return statement.params;
}
function one(actual: readonly Row[]): Row {
  if (actual.length !== 1 || actual[0] === undefined) throw new Error("one stored row required");
  return actual[0];
}

// Synthetic local Root anchors and real request/Money/SQLite constructors only.
// No fixture claims genuine credential/human/Clock/R1/current-admission origin.
describe("stored proof reference to local predicate DATA without caller original echoes", () => {
  test("actual stored29 command16 receipt14 supply the unchanged original and closed output without a write", async () => {
    const f = await committed();
    const before = checkpoint(f);
    const reader = createSharedAuthFinancialConsentLocalProofDataReader(f.connection);
    const actual = await reader.readLocalProofOriginalData(input(f));
    expect(Object.keys(reader)).toEqual(["readLocalProofOriginalData"]);
    expect(actual?.state).toBe("consent-proof-reference-local-data");
    expect(actual?.consentProofRef).toBe(f.input.command.key.consentRef);
    expect(actual?.original.command).toEqual(f.input.command);
    expect(actual?.original.originalBytes).toEqual(f.input.command.originalBytes);
    expect(actual?.original.recordedAt).toBe(f.input.recordedAt);
    expect(actual?.original.receiptRecordedAt).toBe(f.input.recordedAt);
    expect(actual?.original.receiptRef).toBe(f.input.command.key.receiptRef);
    expect(Object.keys(actual ?? {})).toEqual(["state", "consentProofRef", "original"]);
    expect(Object.keys(input(f))).toEqual([
      "consentProofRef",
      "credential",
      "human",
      "currentSession",
    ]);
    expect(f.native.calls.slice(before.calls).filter((call) => isLocal(call.sql))).toHaveLength(1);
    readonly(f, before);
  });

  test("caller pending command recordedAt clock ready and permission echoes are rejected before SQL", async () => {
    const f = await committed();
    const before = checkpoint(f);
    const reader = createSharedAuthFinancialConsentLocalProofDataReader(f.connection);
    let getters = 0;
    for (const name of ["pending", "command", "recordedAt", "clock", "ready", "permission"]) {
      const raw = Object.defineProperty(input(f), name, {
        enumerable: true,
        get() {
          getters++;
          throw new Error("echo getter must remain uncalled");
        },
      });
      await expect(reader.readLocalProofOriginalData(raw)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    expect(getters).toBe(0);
    expect(f.native.calls.length).toBe(before.calls);
    readonly(f, before);
  });

  test("absent pending-only and command-only references stay unavailable and never become a local nonmatch or retry", async () => {
    for (const state of ["absent", "pending", "command"] as const) {
      const f = await graphFixture({ seedPending: state !== "absent" });
      if (state === "command")
        await captureSharedAuthFinancialConsentRequestCommandData(f.connection, {
          pending: f.input.pending,
          command: f.input.command,
        });
      const before = checkpoint(f);
      await unavailable(
        createSharedAuthFinancialConsentLocalProofDataReader(
          f.connection,
        ).readLocalProofOriginalData(input(f)),
      );
      expect(f.native.calls.slice(before.calls).some((call) => isLocal(call.sql))).toBe(false);
      readonly(f, before);
    }
  });

  test("identity receipt unknown and changed opaque references are not aliases or normalized lookups", async () => {
    const f = await committed();
    const before = checkpoint(f);
    const reader = createSharedAuthFinancialConsentLocalProofDataReader(f.connection);
    for (const consentProofRef of [
      "opaque_identity_proof_original",
      f.input.command.key.receiptRef,
      "unknown-original-reference",
      ` ${f.input.command.key.consentRef}`,
    ]) {
      await unavailable(reader.readLocalProofOriginalData({ ...input(f), consentProofRef }));
    }
    expect(f.native.calls.slice(before.calls).some((call) => isLocal(call.sql))).toBe(false);
    readonly(f, before);
  });

  test("freshly selected pending rows must be one closed29 own row with valid native original bytes", async () => {
    for (const kind of ["zero", "duplicate", "extra", "partial", "corrupt"] as const) {
      const f = await committed();
      const before = checkpoint(f);
      let reads = 0;
      f.native.rowFault = (sql, actual) => {
        if (!isPending(sql) || ++reads !== 2) return actual;
        const row = one(actual);
        if (kind === "zero") return [];
        if (kind === "duplicate") return [row, row];
        if (kind === "extra") return [{ ...row, extra: "not-pending29" }];
        if (kind === "partial") {
          const r = { ...row };
          delete r.disclosure_ref;
          return [r];
        }
        return [{ ...row, action_original_bytes: new Uint8Array([1, 2, 3]) }];
      };
      await unavailable(
        createSharedAuthFinancialConsentLocalProofDataReader(
          f.connection,
        ).readLocalProofOriginalData(input(f)),
      );
      expect(reads).toBe(2);
      expect(f.native.calls.slice(before.calls).some((call) => isLocal(call.sql))).toBe(false);
      readonly(f, before);
    }
  });

  test("stored pending scope and canonical action terms challenge relations cannot be replaced by a second read", async () => {
    for (const key of ["workspace_id", "challenge_ref", "action_ref", "terms_digest_original"]) {
      const f = await committed();
      const before = checkpoint(f);
      let reads = 0;
      f.native.rowFault = (sql, actual) =>
        !isPending(sql) || ++reads !== 2
          ? actual
          : actual.map((row) => ({ ...row, [key]: "different-original" }));
      await unavailable(
        createSharedAuthFinancialConsentLocalProofDataReader(
          f.connection,
        ).readLocalProofOriginalData(input(f)),
      );
      expect(f.native.calls.slice(before.calls).some((call) => isLocal(call.sql))).toBe(false);
      readonly(f, before);
    }
  });

  test("the actual local SELECT and all81 original parameters equal the existing builder with receipt-derived recordedAt", async () => {
    const f = await committed();
    const expected = await sharedAuthFinancialConsentLocalCurrentnessStatement(f.input);
    const before = checkpoint(f);
    await createSharedAuthFinancialConsentLocalProofDataReader(
      f.connection,
    ).readLocalProofOriginalData(input(f));
    const calls = f.native.calls.slice(before.calls).filter((call) => isLocal(call.sql));
    expect(calls).toHaveLength(1);
    const actual = calls[0];
    if (!actual) throw new Error("actual local query missing");
    expect(actual.sql).toBe(expected.sql);
    expect(actual.params).toEqual(params(expected));
    expect(actual.params).toHaveLength(81);
    expect(actual.sql).toContain(
      "o.recorded_at IS e.recorded_at AND o.receipt_recorded_at IS o.recorded_at",
    );
    expect(actual.sql).toContain("LIMIT 2");
    readonly(f, before);
  });

  test("retirement session version drift and absolute expiry yield only local nonmatch while original GET remains historical", async () => {
    for (const sql of [
      "UPDATE credential_authority_classes SET state='retired'",
      "UPDATE shared_auth_sessions SET version=version+1",
      "UPDATE shared_auth_sessions SET absolute_expires_at=1",
    ]) {
      const f = await committed();
      f.db.exec(sql);
      const before = checkpoint(f);
      expect(
        await createSharedAuthFinancialConsentLocalProofDataReader(
          f.connection,
        ).readLocalProofOriginalData(input(f)),
      ).toBeUndefined();
      const historical = await createSharedAuthFinancialConsentProofReferenceReader(
        f.connection,
      ).readProofOriginalData(f.input.command.key.consentRef);
      expect(historical.original.receiptRef).toBe(f.input.command.key.receiptRef);
      readonly(f, before);
    }
  });

  test("mismatched credential or distinct human metadata remains invalid instead of constructing a new binding", async () => {
    for (const kind of ["credential", "human"] as const) {
      const f = await committed();
      const before = checkpoint(f);
      const metadata =
        kind === "credential"
          ? {
              ...input(f),
              credential: {
                ...f.input.credential,
                origin: { ...f.input.credential.origin, ref: "different-authority" },
              },
            }
          : { ...input(f), human: { ...f.input.human, ref: "different-human" } };
      await expect(
        createSharedAuthFinancialConsentLocalProofDataReader(
          f.connection,
        ).readLocalProofOriginalData(metadata),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(f.native.calls.slice(before.calls).some((call) => isLocal(call.sql))).toBe(false);
      readonly(f, before);
    }
  });

  test("local row must be exact14 with the original key receipt timestamps and BLOB without a fabricated write ACK", async () => {
    for (const kind of ["duplicate", "partial", "extra", "key", "receipt", "bytes"] as const) {
      const f = await committed();
      const before = checkpoint(f);
      f.native.rowFault = (sql, actual) => {
        if (!isLocal(sql)) return actual;
        const row = one(actual);
        if (kind === "duplicate") return [row, row];
        if (kind === "partial") {
          const r = { ...row };
          delete r.original_digest;
          return [r];
        }
        if (kind === "extra") return [{ ...row, changes: 1 }];
        if (kind === "key") return [{ ...row, command_ref: "foreign-command" }];
        if (kind === "receipt") return [{ ...row, receipt_recorded_at: f.input.recordedAt + 1 }];
        return [{ ...row, original_bytes: new Uint8Array([1, 2, 3]) }];
      };
      await unavailable(
        createSharedAuthFinancialConsentLocalProofDataReader(
          f.connection,
        ).readLocalProofOriginalData(input(f)),
      );
      readonly(f, before);
    }
  });

  test("native local BLOB snapshots bypass shadow getters and returned DATA cannot mutate stored originals", async () => {
    const f = await committed();
    const before = checkpoint(f);
    let getters = 0;
    f.native.rowFault = (sql, actual) => {
      if (!isLocal(sql)) return actual;
      return actual.map((row) => {
        if (!(row.original_bytes instanceof Uint8Array))
          throw new Error("native stored BLOB required");
        const bytes = new Uint8Array(row.original_bytes);
        for (const key of ["buffer", "byteLength", "byteOffset", "constructor"])
          Object.defineProperty(bytes, key, {
            get() {
              getters++;
              throw new Error("native getter must not run");
            },
          });
        return { ...row, original_bytes: bytes };
      });
    };
    const reader = createSharedAuthFinancialConsentLocalProofDataReader(f.connection);
    const actual = await reader.readLocalProofOriginalData(input(f));
    expect(getters).toBe(0);
    if (!actual) throw new Error("original local DATA required");
    actual.original.originalBytes.fill(0);
    actual.original.command.commandBytes.fill(0);
    expect((await reader.readLocalProofOriginalData(input(f)))?.original.originalBytes).toEqual(
      f.input.command.originalBytes,
    );
    readonly(f, before);
  });

  test("borrowed external error classes at historical or local SQL boundaries remain unavailable with no fallback", async () => {
    for (const where of ["historical", "local"] as const)
      for (const code of ["invalid_request", "custody_conflict", "unavailable"] as const) {
        const f = await committed();
        const before = checkpoint(f);
        f.native.beforeRead = async (sql) => {
          if ((where === "local") === isLocal(sql))
            throw new SharedAuthFinancialConsentOriginalReadError(code);
        };
        await unavailable(
          createSharedAuthFinancialConsentLocalProofDataReader(
            f.connection,
          ).readLocalProofOriginalData(input(f)),
        );
        readonly(f, before);
      }
  });

  test("foreign connections and frozen query or run methods cannot replace the original local read", async () => {
    const f = await committed();
    expect(() =>
      createSharedAuthFinancialConsentLocalProofDataReader({ ...f.connection }),
    ).toThrow();
    for (const method of ["query", "run"] as const) {
      const g = await committed();
      const before = checkpoint(g);
      const reader = createSharedAuthFinancialConsentLocalProofDataReader(g.connection);
      let replaced: boolean | undefined;
      g.native.beforeRead = async (sql) => {
        if (isLocal(sql))
          replaced = Reflect.defineProperty(g.graph.sql, method, {
            value: () => Promise.resolve([]),
          });
      };
      const actual = await reader.readLocalProofOriginalData(input(g));
      expect(Object.isFrozen(g.graph.sql)).toBe(true);
      expect(replaced).toBe(false);
      expect(actual?.consentProofRef).toBe(g.input.command.key.consentRef);
      expect(actual?.original.command).toEqual(g.input.command);
      readonly(g, before);
    }
  });

  test("all ref and Root metadata DATA detach before the first await without a new currentness authority flag", async () => {
    const f = await committed();
    const before = checkpoint(f);
    const selected = input(f);
    let changed = false;
    f.native.beforeRead = async () => {
      if (changed) return;
      changed = true;
      selected.consentProofRef = "changed-after-original-capture";
      Object.defineProperty(selected.credential.origin, "ref", { value: "changed-authority" });
      Object.defineProperty(selected.human, "ref", { value: "changed-human" });
      Object.defineProperty(selected.currentSession, "version", {
        value: selected.currentSession.version + 1,
      });
    };
    const actual = await createSharedAuthFinancialConsentLocalProofDataReader(
      f.connection,
    ).readLocalProofOriginalData(selected);
    expect(changed).toBe(true);
    expect(actual?.consentProofRef).toBe(f.input.command.key.consentRef);
    expect(Object.keys(actual ?? {})).toEqual(["state", "consentProofRef", "original"]);
    readonly(f, before);
  });
  test("the historical reader's own occupied fullcommand conflict stays typed before any local query", async () => {
    const f = await committed();
    const before = checkpoint(f);
    f.native.rowFault = (sql, actual) =>
      sql.startsWith("SELECT command_ref,transaction_ref,") &&
      sql.endsWith(" WHERE consent_ref=? LIMIT 2")
        ? actual.map((row) => ({ ...row, captured_at: f.input.command.capturedAt + 1 }))
        : actual;
    await expect(
      createSharedAuthFinancialConsentLocalProofDataReader(f.connection).readLocalProofOriginalData(
        input(f),
      ),
    ).rejects.toMatchObject({ code: "custody_conflict" });
    expect(f.native.calls.slice(before.calls).some((call) => isLocal(call.sql))).toBe(false);
    readonly(f, before);
  });
});
