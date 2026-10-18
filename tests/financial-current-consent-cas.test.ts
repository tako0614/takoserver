import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFinancialCurrentConsentNativeOriginal } from "../src/financial-current-consent-customer.ts";
import { createMoneyCutoverSql } from "../src/money-cutover-sql.ts";
import type { Row, SqlStatement } from "../src/ports.ts";
import { sharedAuthFinancialConsentLocalCurrentnessStatement } from "../src/shared-auth-financial-consent-store.ts";
import {
  guardCustomerConsentReceipt,
  packFinancialRpCurrentness,
} from "../src/shared-financial-current-consent-cas.ts";
import {
  type CustomerPhaseInput,
  compileCustomerPhase,
} from "../src/shared-financial-customer-dispatch.ts";
import {
  completedCustomerReceiptReadStatement,
  readCompletedCustomerReceipt,
  readCustomerJournalSnapshot,
} from "../src/shared-financial-customer-journal.ts";
import {
  captureCustomerTrackedPhaseOriginal,
  customerTrackedOriginalReadStatement,
} from "../src/shared-financial-customer-tracked-execution.ts";
import {
  closeRpCurrentConsentFixtures,
  completeRpCurrentConsentFixture,
  rpCurrentConsentFixture,
} from "./fixtures/financial-current-consent-rp-fixture.ts";
import { fixture as customerFixture } from "./fixtures/financial-customer-five-action-fixture.ts";

afterEach(closeRpCurrentConsentFixtures);

test("Financial operation reader does not inspect fabricated or accessor-bearing tokens", () => {
  let reads = 0;
  const forged = Object.defineProperty(Object.create(null), "kind", {
    get() {
      reads++;
      throw new Error("fake token inspected");
    },
  });
  expect(readFinancialCurrentConsentNativeOriginal(forged, "query")).toBeNull();
  expect(readFinancialCurrentConsentNativeOriginal({ ...forged }, "batch")).toBeNull();
  expect(reads).toBe(0);
});

test("tracked phase capture and both fixed reads retain detached original values", async () => {
  const { f, l1 } = await customerCase();
  try {
    const original = captureCustomerTrackedPhaseOriginal(l1);
    expect(original).not.toBe(l1);
    expect(Object.isFrozen(original)).toBe(true);
    expect(compileCustomerPhase(original).statements).toEqual(compileCustomerPhase(l1).statements);
    const completed = completedCustomerReceiptReadStatement(l1.admission.receiptRef);
    const history = customerTrackedOriginalReadStatement(
      l1.admission.receiptRef,
      l1.historyReceiptRef,
    );
    expect(completed.params).toEqual([l1.admission.receiptRef]);
    expect(history.params).toEqual([l1.admission.receiptRef, l1.historyReceiptRef]);
    expect(Object.isFrozen(completed)).toBe(true);
    expect(Object.isFrozen(history)).toBe(true);
    expect(() =>
      captureCustomerTrackedPhaseOriginal(
        Object.defineProperty({ ...l1 }, "phase", { get: () => "L1", enumerable: true }),
      ),
    ).toThrow();
  } finally {
    f.close();
  }
});

function binds(statement: SqlStatement) {
  return (statement.params ?? []).map((value) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : value,
  );
}

test("packed Financial guard has the same actual RP original and stale verdict as the 81-bind builder", async () => {
  const f = await rpCurrentConsentFixture();
  await completeRpCurrentConsentFixture(f);
  const rp = await sharedAuthFinancialConsentLocalCurrentnessStatement(f.input);
  const packed = packFinancialRpCurrentness(rp);
  expect(rp.params).toHaveLength(81);
  expect(packed.blobs).toHaveLength(5);
  const wrapped: SqlStatement = {
    sql: `WITH financial_consent_values(payload,blob0,blob1,blob2,blob3,blob4) AS MATERIALIZED (VALUES (?,?,?,?,?,?)),
 financial_consent_rp AS MATERIALIZED (${packed.sql}) SELECT * FROM financial_consent_rp`,
    params: [packed.payload, ...packed.blobs],
  };
  const direct = () => f.db.query(rp.sql).all(...binds(rp)) as Row[];
  const throughGuard = () => f.db.query(wrapped.sql).all(...binds(wrapped)) as Row[];
  expect(direct()).toHaveLength(1);
  expect(throughGuard()).toEqual(direct());
  f.db.exec("UPDATE shared_auth_sessions SET version=version+1");
  expect(direct()).toEqual([]);
  expect(throughGuard()).toEqual([]);
  f.db.exec("UPDATE shared_auth_sessions SET version=version-1");
  const changedParams = [...(rp.params ?? [])];
  const blobIndex = changedParams.findIndex((value) => value instanceof ArrayBuffer);
  expect(blobIndex).toBeGreaterThanOrEqual(0);
  changedParams[blobIndex] = new Uint8Array([0]).buffer;
  const wrongOriginal = { ...rp, params: changedParams };
  const wrongPacked = packFinancialRpCurrentness(wrongOriginal);
  expect(f.db.query(wrongOriginal.sql).all(...binds(wrongOriginal))).toEqual([]);
  const wrongWrapped: SqlStatement = {
    sql: `WITH financial_consent_values(payload,blob0,blob1,blob2,blob3,blob4) AS MATERIALIZED (VALUES (?,?,?,?,?,?)),
 financial_consent_rp AS MATERIALIZED (${wrongPacked.sql}) SELECT * FROM financial_consent_rp`,
    params: [wrongPacked.payload, ...wrongPacked.blobs],
  };
  expect(f.db.query(wrongWrapped.sql).all(...binds(wrongWrapped))).toEqual([]);
});

test("JSON packing preserves Unicode and BLOB types and refuses malformed UTF-16", async () => {
  const f = await rpCurrentConsentFixture();
  const rp = await sharedAuthFinancialConsentLocalCurrentnessStatement(f.input);
  const params = [...(rp.params ?? [])];
  const textIndex = params.findIndex((value) => typeof value === "string");
  expect(textIndex).toBeGreaterThanOrEqual(0);
  const originalText = params[textIndex];
  params[textIndex] = "\uFEFFquote' ? \u{1F9EA} \u0000";
  const changed = { ...rp, params };
  const packed = packFinancialRpCurrentness(changed);
  expect(packed.payload).toContain("quote' ?");
  expect(packed.blobs.every((value) => value instanceof ArrayBuffer)).toBe(true);
  params[textIndex] = "bad\uD800";
  expect(() => packFinancialRpCurrentness({ ...rp, params })).toThrow();
  if (typeof originalText !== "string") throw new Error("expected RP text bind");
  params[textIndex] = originalText;
  const quoted = rp.sql.replace("'rp-explicit-action-consent'", "'rp AND explicit-action-consent'");
  expect(quoted).not.toBe(rp.sql);
  expect(packFinancialRpCurrentness({ ...rp, sql: quoted }).sql).toContain(
    "'rp AND explicit-action-consent'",
  );
  const between = rp.sql.replace(
    "p.created_at IS e.p_created_at",
    "p.created_at BETWEEN e.p_created_at AND e.p_expires_at",
  );
  expect(between).not.toBe(rp.sql);
  expect(() => packFinancialRpCurrentness({ ...rp, sql: between })).toThrow();
});

const writerEpoch = `sha256:${createHash("sha256").update("writer").digest("hex")}`;
const issuerDigest = `sha256:${"a".repeat(64)}`;
const issuerJson = JSON.stringify({
  incarnation: "1",
  purpose: "rp-explicit-action-consent",
  registrationRef: "shared-financial-action-consent-rp",
  version: "takoserver-shared-financial-action-consent-issuer-v1",
});

function mechanicalRp(allow: boolean): SqlStatement {
  // Same 81-bind/five-BLOB shape as the actual builder, but this test isolates
  // Customer's receipt/CHECK transaction from the RP positive fixture above.
  const params = Array.from({ length: 81 }, (_, index) =>
    [2, 17, 24, 39, 43].includes(index)
      ? new Uint8Array([index, 0, 255]).buffer
      : index === 80
        ? Number(allow)
        : `retained:${index}`,
  );
  const terms = params.map((_, index) => (index === 80 ? "?=1" : "? IS NOT NULL"));
  function balanced(items: readonly string[]): string {
    if (items.length === 1) return items[0] ?? "0";
    const middle = Math.floor(items.length / 2);
    return `(${balanced(items.slice(0, middle))} AND ${balanced(items.slice(middle))})`;
  }
  return { sql: `SELECT 1 AS original WHERE ${balanced(terms)}`, params };
}

async function mechanicalGuard(
  f: Awaited<ReturnType<typeof customerFixture>>,
  input: CustomerPhaseInput,
  options: { rp?: boolean; root?: boolean; issuer?: boolean; expired?: boolean } = {},
) {
  const now = Date.now();
  const plan = compileCustomerPhase(input);
  const guarded = guardCustomerConsentReceipt(plan, {
    rp: mechanicalRp(options.rp !== false),
    root: {
      sql: `EXISTS(SELECT 1 FROM money_cutover_authorized_epoch WHERE writer_epoch=?)${" AND ? IS NOT NULL".repeat(9)}`,
      params: [
        options.root === false ? "stale" : writerEpoch,
        ...Array(9).fill("held-root-source"),
      ],
    },
    issuer: {
      registrationRef: "shared-financial-action-consent-rp",
      registrationDigest: issuerDigest,
      incarnation: "1",
    },
    acceptedAt: now - 60_000,
    expiresAt: options.expired ? now - 1 : now + 60_000,
  });
  expect(guarded.statements).toHaveLength(input.phase === "L1" ? 9 : 8);
  expect(guarded.firstDispatchResultIndex).toBe(input.phase === "D" ? 2 : null);
  expect(guarded.statements.every((s) => (s.params?.length ?? 0) <= 100)).toBe(true);
  const receiptIndex = input.phase === "L1" ? 4 : 3;
  expect(guarded.statements[receiptIndex]?.params).toHaveLength(
    (plan.statements[receiptIndex]?.params?.length ?? 0) + 16,
  );
  expect(guarded.statements[receiptIndex]?.params).toHaveLength(input.phase === "L1" ? 96 : 98);
  if (options.issuer !== false) {
    await f.sql.run(
      "INSERT OR IGNORE INTO shared_auth_financial_consent_issuer_registrations VALUES(?,?,?,?)",
      ["shared-financial-action-consent-rp", "1", issuerDigest, issuerJson],
    );
  }
  return guarded;
}

async function customerCase() {
  const f = await customerFixture(true);
  await f.sql.run(
    "CREATE TABLE shared_auth_financial_consent_issuer_registrations (registration_ref TEXT PRIMARY KEY,incarnation TEXT,registration_digest TEXT,original_json TEXT)",
  );
  const common = {
    admission: f.admission,
    history: f.journal,
    writerEpoch,
    couplingAttemptRef: "consent-cas:L1",
    entryRef: "consent-cas-entry:L1",
    historyReceiptRef: "consent-cas-H1:L1",
  };
  const l1 = { phase: "L1" as const, ...common };
  return { f, l1 };
}

test("actual Customer L1 and first-D receipt guards keep 9/8 ACK and D result index 2", async () => {
  const { f, l1 } = await customerCase();
  try {
    const l1Plan = await mechanicalGuard(f, l1);
    expect((await f.sql.batch(l1Plan.statements)).map((x) => x.changes)).toEqual(Array(9).fill(1));
    const history = await readCustomerJournalSnapshot(f.sql, {
      organizationId: f.org,
      realmRegistration: f.journal.realmRegistration,
      realmIncarnation: f.journal.realmIncarnation,
    });
    expect(history).not.toBeNull();
    if (!history) throw new Error("expected Customer history");
    const d: CustomerPhaseInput = {
      phase: "D",
      admission: f.admission,
      history,
      writerEpoch,
      couplingAttemptRef: "consent-cas:D",
      entryRef: "consent-cas-entry:D",
      historyReceiptRef: "consent-cas-H1:D",
      claimRef: "consent-cas-claim:D",
      dispatchAttemptRef: "consent-cas-attempt:D",
      dispatchReceiptRef: "consent-cas-receipt:D",
      dispatchedAt: f.at,
    };
    const dPlan = await mechanicalGuard(f, d);
    const ack = await f.sql.batch(dPlan.statements);
    expect(ack.map((x) => x.changes)).toEqual(Array(8).fill(1));
    expect(dPlan.firstDispatchResultIndex).toBe(2);
    expect(ack[2]?.changes).toBe(1);
  } finally {
    f.close();
  }
});

test.each(["rp", "root", "issuer", "expired"] as const)(
  "late %s nonmatch aborts L1 and leaves no partial Customer or permit rows",
  async (failure) => {
    const { f, l1 } = await customerCase();
    try {
      const tables = [
        "financial_customer_admissions",
        "stripe_billing_customer_commands",
        "financial_customer_admission_receipts",
        "financial_customer_history_receipts",
        "money_cutover_writer_permit",
      ];
      const before = await Promise.all(
        tables.map((table) => f.sql.query(`SELECT * FROM ${table}`)),
      );
      const plan = await mechanicalGuard(f, l1, { [failure]: failure === "expired" });
      await expect(f.sql.batch(plan.statements)).rejects.toThrow();
      for (const [index, table] of tables.entries()) {
        expect(await f.sql.query(`SELECT * FROM ${table}`)).toEqual(before[index] ?? []);
      }
    } finally {
      f.close();
    }
  },
);

test("late D RP nonmatch rolls back only the new dispatch and retains completed L1", async () => {
  const { f, l1 } = await customerCase();
  try {
    await f.sql.batch((await mechanicalGuard(f, l1)).statements);
    const history = await readCustomerJournalSnapshot(f.sql, {
      organizationId: f.org,
      realmRegistration: f.journal.realmRegistration,
      realmIncarnation: f.journal.realmIncarnation,
    });
    if (!history) throw new Error("expected completed L1 history");
    const d: CustomerPhaseInput = {
      phase: "D",
      admission: f.admission,
      history,
      writerEpoch,
      couplingAttemptRef: "consent-cas:D-false",
      entryRef: "consent-cas-entry:D-false",
      historyReceiptRef: "consent-cas-H1:D-false",
      claimRef: "consent-cas-claim:D-false",
      dispatchAttemptRef: "consent-cas-attempt:D-false",
      dispatchReceiptRef: "consent-cas-receipt:D-false",
      dispatchedAt: f.at,
    };
    const tables = [
      "financial_customer_admissions",
      "financial_customer_dispatch_claims",
      "financial_customer_dispatch_receipts",
      "financial_customer_history_receipts",
      "stripe_billing_customer_commands",
      "money_cutover_writer_permit",
    ];
    const before = await Promise.all(tables.map((table) => f.sql.query(`SELECT * FROM ${table}`)));
    const plan = await mechanicalGuard(f, d, { rp: false });
    await expect(f.sql.batch(plan.statements)).rejects.toThrow();
    for (const [index, table] of tables.entries()) {
      expect(await f.sql.query(`SELECT * FROM ${table}`)).toEqual(before[index] ?? []);
    }
  } finally {
    f.close();
  }
});

test("two RP-current rows cannot satisfy the mandatory receipt", async () => {
  const { f, l1 } = await customerCase();
  try {
    await mechanicalGuard(f, l1);
    const duplicateRp = mechanicalRp(true);
    const duplicatePlan = guardCustomerConsentReceipt(compileCustomerPhase(l1), {
      rp: { ...duplicateRp, sql: `${duplicateRp.sql} UNION ALL SELECT 1 AS original` },
      root: {
        sql: `EXISTS(SELECT 1 FROM money_cutover_authorized_epoch WHERE writer_epoch=?)${" AND ? IS NOT NULL".repeat(9)}`,
        params: [writerEpoch, ...Array(9).fill("held-root-source")],
      },
      issuer: {
        registrationRef: "shared-financial-action-consent-rp",
        registrationDigest: issuerDigest,
        incarnation: "1",
      },
      acceptedAt: Date.now() - 60_000,
      expiresAt: Date.now() + 60_000,
    });
    await expect(f.sql.batch(duplicatePlan.statements)).rejects.toThrow();
    expect(await f.sql.query("SELECT * FROM financial_customer_admissions")).toEqual([]);
  } finally {
    f.close();
  }
});

test("actual Money request wrapper refuses Customer internal receipt read and guarded batch without effect", async () => {
  const { f, l1 } = await customerCase();
  try {
    const wrapped = createMoneyCutoverSql(f.sql, writerEpoch);
    const plan = await mechanicalGuard(f, l1);
    const before = await f.sql.query("SELECT * FROM financial_customer_admissions");
    await expect(readCompletedCustomerReceipt(wrapped, f.admission.receiptRef)).rejects.toThrow(
      "outside the guarded surface",
    );
    await expect(wrapped.batch(plan.statements)).rejects.toThrow("outside the guarded surface");
    expect(await f.sql.query("SELECT * FROM financial_customer_admissions")).toEqual(before);
    expect(await f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
  } finally {
    f.close();
  }
});
