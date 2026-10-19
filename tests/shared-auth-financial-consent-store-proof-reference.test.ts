import { describe, expect, test } from "bun:test";
import { MONEY_CUTOVER_PERMIT_TABLE } from "../src/money-cutover-sql.ts";
import type { Row } from "../src/ports.ts";
import { parseSharedAuthFinancialActionConsentOriginal } from "../src/shared-auth-financial-consent-contract.ts";
import {
  captureSharedAuthFinancialConsentRequestCommandData,
  createSharedAuthFinancialConsentProofReferenceReader,
  persistCaptureAndConsumeSharedAuthFinancialConsentRequestData,
  SharedAuthFinancialConsentOriginalReadError,
} from "../src/shared-auth-financial-consent-store.ts";
import type { WorkerRequestSql } from "../src/worker-request-composition.ts";
import { custodyHash, graphFixture, rows, snapshot } from "./consent-request-graph-fixture.ts";

const P = "shared_auth_financial_consent_pending";
const C = "shared_auth_financial_consent_commands";
const O = "shared_auth_financial_consent_originals";
type Fixture = Awaited<ReturnType<typeof graphFixture>>;
const isLookup = (sql: string) =>
  sql.startsWith("SELECT command_ref,transaction_ref,") &&
  sql.endsWith(" WHERE consent_ref=? LIMIT 2");
async function unavailable(promise: Promise<unknown>) {
  await expect(promise).rejects.toMatchObject({
    name: "SharedAuthFinancialConsentOriginalReadError",
    code: "unavailable",
  });
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
function unchangedReadOnly(f: Fixture, before: ReturnType<typeof checkpoint>) {
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
function one(actual: readonly Row[]): Row {
  const first = actual[0];
  if (actual.length !== 1 || first === undefined)
    throw new Error("expected one actual stored command row");
  return first;
}

// Reduced synthetic Root anchors with real local request constructors, Money
// wrapping and SQLite receipts. This is not a genuine consent issuer/current
// verifier, Root qualified Clock/human/target or Financial R1/CAS qualification.
describe("historical consentProofRef lookup of immutable receipt-backed original DATA", () => {
  test("the external reference is the stored canonical opaque consentRef and the same-row receipt stays separate", async () => {
    const f = await committed();
    const reader = createSharedAuthFinancialConsentProofReferenceReader(f.connection);
    const before = checkpoint(f);
    const actual = await reader.readProofOriginalData(f.input.command.key.consentRef);
    const decoded = await parseSharedAuthFinancialActionConsentOriginal(
      actual.original.originalBytes,
    );
    expect(Object.keys(reader)).toEqual(["readProofOriginalData"]);
    expect(actual.state).toBe("consent-proof-reference-original-data");
    expect(actual.consentProofRef).toBe(f.input.command.key.consentRef);
    expect(actual.consentProofRef).toBe(decoded.consentRef);
    if (decoded.identityEvidence.kind !== "financial-proof")
      throw new Error("fixture must retain its independent identity proof");
    expect(decoded.identityEvidence.proofRef).toBe("opaque_identity_proof_original");
    expect(actual.consentProofRef).not.toBe(decoded.identityEvidence.proofRef);
    expect(actual.original.command).toEqual(f.input.command);
    expect(actual.original.originalBytes).toEqual(f.input.command.originalBytes);
    expect(actual.original.originalDigest).toBe(decoded.consentDigest);
    expect(actual.original.originalCustodySHA256).toBe(
      await custodyHash(f.input.command.originalBytes),
    );
    expect(actual.original.receiptRef).toBe(f.input.command.key.receiptRef);
    expect(actual.original.receiptRecordedAt).toBe(f.input.recordedAt);
    expect(actual.original.recordedAt).toBe(f.input.recordedAt);
    expect(rows(f.db, P)).toHaveLength(1);
    expect(rows(f.db, C)).toHaveLength(1);
    expect(rows(f.db, O)).toHaveLength(1);
    expect(f.native.calls.slice(before.calls).some((call) => isLookup(call.sql))).toBe(true);
    unchangedReadOnly(f, before);
  });

  test("a committed batch with lost ACK is loaded by the original consent reference without dispatching again", async () => {
    const f = await graphFixture({ seedPending: false });
    const reader = createSharedAuthFinancialConsentProofReferenceReader(f.connection);
    const ref = f.input.command.key.consentRef;
    f.native.afterBatch = () => {
      throw new Error("original committed batch ACK lost");
    };
    await unavailable(
      persistCaptureAndConsumeSharedAuthFinancialConsentRequestData(f.connection, f.input),
    );
    expect(f.native.batchCalls).toBe(1);
    expect(f.native.committedBatches).toHaveLength(1);
    const before = checkpoint(f);
    expect((await reader.readProofOriginalData(ref)).original.receiptRef).toBe(
      f.input.command.key.receiptRef,
    );
    expect((await reader.readProofOriginalData(ref)).consentProofRef).toBe(ref);
    unchangedReadOnly(f, before);
  });

  test("byref zero with absent pending pending-only or command-only is unavailable never a positive three-row absence", async () => {
    for (const state of ["absent", "pending-only", "command-only"] as const) {
      const f = await graphFixture({ seedPending: state !== "absent" });
      if (state === "command-only") {
        await captureSharedAuthFinancialConsentRequestCommandData(f.connection, {
          pending: f.input.pending,
          command: f.input.command,
        });
      }
      const before = checkpoint(f);
      const reader = createSharedAuthFinancialConsentProofReferenceReader(f.connection);
      await unavailable(reader.readProofOriginalData(f.input.command.key.consentRef));
      expect(rows(f.db, O)).toEqual([]);
      unchangedReadOnly(f, before);
    }
  });

  test("identity proof receipt and changed reference strings are not alternate consent references or normalization inputs", async () => {
    const f = await committed();
    const before = checkpoint(f);
    const reader = createSharedAuthFinancialConsentProofReferenceReader(f.connection);
    for (const ref of [
      "opaque_identity_proof_original",
      f.input.command.key.receiptRef,
      "unknown-original-reference",
      ` ${f.input.command.key.consentRef}`,
    ]) {
      await unavailable(reader.readProofOriginalData(ref));
    }
    unchangedReadOnly(f, before);
  });

  test("invalid primitive refs and object accessors are refused before SQL without invoking a getter", async () => {
    const f = await committed();
    const before = checkpoint(f);
    let getters = 0;
    const accessor = Object.defineProperty({}, "consentProofRef", {
      enumerable: true,
      get() {
        getters++;
        throw new Error("must not inspect a DTO");
      },
    });
    const reader = createSharedAuthFinancialConsentProofReferenceReader(f.connection);
    for (const input of [undefined, null, 1, {}, accessor, "", "bad\0ref", "x".repeat(513)]) {
      await expect(reader.readProofOriginalData(input)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    expect(getters).toBe(0);
    expect(f.native.calls.length).toBe(before.calls);
    unchangedReadOnly(f, before);
  });

  test("external SQL rejections cannot borrow input or conflict codes from the exported error class", async () => {
    for (const code of ["invalid_request", "custody_conflict", "unavailable"] as const) {
      const f = await committed();
      const before = checkpoint(f);
      f.native.beforeRead = async (sql) => {
        if (isLookup(sql)) throw new SharedAuthFinancialConsentOriginalReadError(code);
      };
      await unavailable(
        createSharedAuthFinancialConsentProofReferenceReader(f.connection).readProofOriginalData(
          f.input.command.key.consentRef,
        ),
      );
      unchangedReadOnly(f, before);
    }
  });

  test("zero duplicate partial extra accessor and foreign-ref query rows cannot supply the strict stored command", async () => {
    for (const kind of ["zero", "duplicate", "partial", "extra", "accessor", "foreign"] as const) {
      const f = await committed();
      const before = checkpoint(f);
      let getters = 0;
      f.native.rowFault = (sql, actual) => {
        if (!isLookup(sql)) return actual;
        const row = one(actual);
        if (kind === "zero") return [];
        if (kind === "duplicate") return [row, row];
        if (kind === "partial") {
          const partial = { ...row };
          delete partial.command_custody_sha256;
          return [partial];
        }
        if (kind === "extra") return [{ ...row, extra_scalar: "not command16" }];
        if (kind === "foreign") return [{ ...row, consent_ref: "different opaque consent" }];
        return [
          Object.defineProperty({ ...row }, "command_bytes", {
            enumerable: true,
            get() {
              getters++;
              throw new Error("row accessor must not run");
            },
          }),
        ];
      };
      await unavailable(
        createSharedAuthFinancialConsentProofReferenceReader(f.connection).readProofOriginalData(
          f.input.command.key.consentRef,
        ),
      );
      expect(getters).toBe(0);
      unchangedReadOnly(f, before);
    }
  });

  test("native command BLOB snapshot bypasses shadow accessors and malformed canonical storage is unavailable not caller-invalid", async () => {
    for (const kind of ["native-shadow", "canonical"] as const) {
      const f = await committed();
      const before = checkpoint(f);
      let getters = 0;
      const corrupt = new TextEncoder().encode("invalid original canonical bytes");
      const corruptHash = await custodyHash(corrupt);
      Object.defineProperty(corrupt, "buffer", {
        get() {
          getters++;
          throw new Error("native slots only");
        },
      });
      f.native.rowFault = (sql, actual) => {
        if (!isLookup(sql)) return actual;
        const row = one(actual);
        return kind === "native-shadow"
          ? [{ ...row, command_bytes: corrupt }]
          : [{ ...row, original_bytes: corrupt, original_custody_sha256: corruptHash }];
      };
      await unavailable(
        createSharedAuthFinancialConsentProofReferenceReader(f.connection).readProofOriginalData(
          f.input.command.key.consentRef,
        ),
      );
      expect(getters).toBe(0);
      unchangedReadOnly(f, before);
    }
  });

  test("actual later-row conflict is retained while a matching caller ref cannot hide changed fullcommand custody", async () => {
    const f = await committed();
    const before = checkpoint(f);
    const changed = new TextEncoder().encode("different but honestly hashed fullcommand");
    const changedHash = await custodyHash(changed);
    f.native.rowFault = (sql, actual) =>
      isLookup(sql)
        ? actual.map((row) => ({
            ...row,
            command_bytes: changed,
            command_custody_sha256: changedHash,
          }))
        : actual;
    await expect(
      createSharedAuthFinancialConsentProofReferenceReader(f.connection).readProofOriginalData(
        f.input.command.key.consentRef,
      ),
    ).rejects.toMatchObject({ code: "custody_conflict" });
    unchangedReadOnly(f, before);
  });

  test("pending loss missing original and missing or changed mandatory receipt never return an incomplete proof original", async () => {
    for (const kind of ["pending", "original", "missing-receipt", "wrong-receipt-time"] as const) {
      const f = await committed();
      const before = checkpoint(f);
      f.native.rowFault = (sql, actual) => {
        if (kind === "pending" && sql.startsWith("SELECT transaction_ref,registration_ref,"))
          return [];
        if (!sql.startsWith("SELECT consent_ref,command_ref,")) return actual;
        if (kind === "original") return [];
        if (kind === "missing-receipt")
          return actual.map((row) => {
            const copy = { ...row };
            delete copy.receipt_recorded_at;
            return copy;
          });
        if (kind === "wrong-receipt-time")
          return actual.map((row) => ({ ...row, receipt_recorded_at: f.input.recordedAt + 1 }));
        return actual;
      };
      await unavailable(
        createSharedAuthFinancialConsentProofReferenceReader(f.connection).readProofOriginalData(
          f.input.command.key.consentRef,
        ),
      );
      unchangedReadOnly(f, before);
    }
  });

  test("partial schema or FK-off remains unavailable and no lookup fabricates readiness", async () => {
    for (const kind of ["partial", "fk-off"] as const) {
      const f = await committed();
      if (kind === "partial") f.db.exec(`DROP TRIGGER ${P}_auth_tuple`);
      else f.db.exec("PRAGMA foreign_keys=OFF");
      const before = checkpoint(f);
      await unavailable(
        createSharedAuthFinancialConsentProofReferenceReader(f.connection).readProofOriginalData(
          f.input.command.key.consentRef,
        ),
      );
      unchangedReadOnly(f, before);
    }
  });

  test("retirement and session revocation leave historical bytes readable without a current or Clock predicate", async () => {
    const f = await committed();
    f.db.exec(
      "UPDATE credential_authority_classes SET state='retired'; UPDATE shared_auth_sessions SET status='revoked'; UPDATE shared_principal_bindings SET state='retired'",
    );
    const before = checkpoint(f);
    const actual = await createSharedAuthFinancialConsentProofReferenceReader(
      f.connection,
    ).readProofOriginalData(f.input.command.key.consentRef);
    expect(actual.original.originalBytes).toEqual(f.input.command.originalBytes);
    expect(
      f.native.calls
        .slice(before.calls)
        .every(
          (call) => !/julianday|datetime|UPDATE|last_used_at|absolute_expires_at/iu.test(call.sql),
        ),
    ).toBe(true);
    unchangedReadOnly(f, before);
  });

  test("same-shaped connection clones and original-method replacement across SQL await cannot supply request origin", async () => {
    const f = await committed();
    const before = checkpoint(f);
    const foreign: WorkerRequestSql[] = [
      { ...f.connection },
      { sql: f.graph.sql, moneyGuard: "ready" },
    ];
    for (const connection of foreign)
      expect(() => createSharedAuthFinancialConsentProofReferenceReader(connection)).toThrow();
    for (const method of ["run", "query"] as const) {
      const g = await committed();
      const prior = checkpoint(g);
      g.native.beforeRead = async (sql) => {
        if (isLookup(sql))
          Object.defineProperty(g.graph.sql, method, {
            value: async () => {
              throw new Error("replacement must not be invoked");
            },
            configurable: true,
          });
      };
      await unavailable(
        createSharedAuthFinancialConsentProofReferenceReader(g.connection).readProofOriginalData(
          g.input.command.key.consentRef,
        ),
      );
      unchangedReadOnly(g, prior);
    }
    unchangedReadOnly(f, before);
  });

  test("primitive ref capture and returned BLOB detachment do not mutate stored custody or supply a phase API", async () => {
    const f = await committed();
    const before = checkpoint(f);
    const reader = createSharedAuthFinancialConsentProofReferenceReader(f.connection);
    const holder = { ref: f.input.command.key.consentRef };
    const originalRef = holder.ref;
    const attempt = reader.readProofOriginalData(holder.ref);
    holder.ref = "another lookup reference";
    const actual = await attempt;
    expect(actual.consentProofRef).toBe(originalRef);
    actual.original.originalBytes.fill(0);
    actual.original.command.commandBytes.fill(0);
    const second = await reader.readProofOriginalData(originalRef);
    expect(second.original.originalBytes).toEqual(f.input.command.originalBytes);
    expect(second.original.command.commandBytes).toEqual(f.input.command.commandBytes);
    expect(Object.keys(reader)).toEqual(["readProofOriginalData"]);
    unchangedReadOnly(f, before);
  });
});
