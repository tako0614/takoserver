import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA } from "../src/financial-0104-money-fence.ts";
import {
  readFinancialCurrentConsentCustomerOperationOriginal,
  readFinancialCurrentConsentNativeOriginal,
} from "../src/financial-current-consent-customer.ts";
import { createMoneyCutoverSql } from "../src/money-cutover-sql.ts";
import type { Row, Sql, SqlStatement } from "../src/ports.ts";
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
  createCustomerTrackedExecutionData,
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
  expect(readFinancialCurrentConsentCustomerOperationOriginal({} as never, forged)).toBeNull();
  expect(
    readFinancialCurrentConsentCustomerOperationOriginal({} as never, { ...forged }),
  ).toBeNull();
  expect(readFinancialCurrentConsentNativeOriginal(forged, "query")).toBeNull();
  expect(readFinancialCurrentConsentNativeOriginal(forged, "batch")).toBeNull();
  expect(readFinancialCurrentConsentNativeOriginal({ ...forged }, "query")).toBeNull();
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
const ROTATED = `sha256:${"d".repeat(64)}`;
const MONEY_WORDS =
  /\b(?:money_cutover_freeze|money_cutover_writer_permit|money_cutover_authorized_epoch)\b/u;
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
      // Synthetic Root currentness over a retained epoch column. Like the actual
      // Auth103 predicate it names no money_cutover_* table.
      sql: `EXISTS(SELECT 1 FROM shared_customer_challenges WHERE writer_epoch=?)${" AND ? IS NOT NULL".repeat(9)}`,
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
  // Customer statements only: Root's Money writer adds its own permit frame.
  expect(guarded.statements).toHaveLength(input.phase === "L1" ? 7 : 6);
  expect(guarded.firstDispatchResultIndex).toBe(input.phase === "D" ? 1 : null);
  expect(guarded.statements.every((s) => (s.params?.length ?? 0) <= 100)).toBe(true);
  for (const statement of guarded.statements) expect(statement.sql).not.toMatch(MONEY_WORDS);
  const receiptIndex = input.phase === "L1" ? 3 : 2;
  expect(guarded.statements[receiptIndex]?.params).toHaveLength(
    (plan.statements[receiptIndex]?.params?.length ?? 0) + 16,
  );
  // consentGuard() carries one bind for its in-statement consent-fence check.
  expect(guarded.statements[receiptIndex]?.params).toHaveLength(input.phase === "L1" ? 97 : 99);
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

test("actual Customer L1 and first-D receipt guards keep 7/6 ACK through the Money writer and D result index 1", async () => {
  const { f, l1 } = await customerCase();
  try {
    const l1Plan = await mechanicalGuard(f, l1);
    expect((await f.money.batch(l1Plan.statements)).map((x) => x.changes)).toEqual(
      Array(7).fill(1),
    );
    expect(await f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
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
    const ack = await f.money.batch(dPlan.statements);
    expect(ack.map((x) => x.changes)).toEqual(Array(6).fill(1));
    expect(dPlan.firstDispatchResultIndex).toBe(1);
    expect(ack[1]?.changes).toBe(1);
    expect(await f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
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
      await expect(f.money.batch(plan.statements)).rejects.toThrow();
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
    await f.money.batch((await mechanicalGuard(f, l1)).statements);
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
    await expect(f.money.batch(plan.statements)).rejects.toThrow();
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
        // Synthetic Root currentness over a retained epoch column. Like the actual
        // Auth103 predicate it names no money_cutover_* table.
        sql: `EXISTS(SELECT 1 FROM shared_customer_challenges WHERE writer_epoch=?)${" AND ? IS NOT NULL".repeat(9)}`,
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
    await expect(f.money.batch(duplicatePlan.statements)).rejects.toThrow();
    expect(await f.sql.query("SELECT * FROM financial_customer_admissions")).toEqual([]);
  } finally {
    f.close();
  }
});

test("actual Money writer refuses the Customer internal receipt read but sends the guarded batch; raw Sql cannot", async () => {
  const { f, l1 } = await customerCase();
  try {
    const wrapped = createMoneyCutoverSql(f.sql, writerEpoch);
    const plan = await mechanicalGuard(f, l1);
    const before = await f.sql.query("SELECT * FROM financial_customer_admissions");
    // The fixed recovery read still names money_cutover_* and stays raw-only.
    await expect(readCompletedCustomerReceipt(wrapped, f.admission.receiptRef)).rejects.toThrow(
      "outside the guarded surface",
    );
    // Outside Root's permit frame the Customer fences refuse the whole batch.
    await expect(f.sql.batch(plan.statements)).rejects.toThrow(/constraint: Financial Customer/u);
    expect(await f.sql.query("SELECT * FROM financial_customer_admissions")).toEqual(before);
    expect(await f.sql.query("SELECT * FROM stripe_billing_customer_commands")).toEqual([]);
    expect(await f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
    // The same plan names no money_cutover_* table and commits inside the writer.
    expect((await wrapped.batch(plan.statements)).map((x) => x.changes)).toEqual(Array(7).fill(1));
    expect(await f.sql.query("SELECT * FROM financial_customer_admissions")).toHaveLength(1);
    expect(await f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
  } finally {
    f.close();
  }
});

const CUSTOMER_ROWS = [
  "financial_customer_admissions",
  "stripe_billing_customer_commands",
  "stripe_customer_admission_links",
  "financial_customer_admission_receipts",
  "financial_customer_dispatch_claims",
  "financial_customer_dispatch_receipts",
  "financial_customer_history_entries",
  "financial_customer_history_heads",
  "financial_customer_history_receipts",
  "money_cutover_writer_permit",
] as const;
async function customerRows(f: Awaited<ReturnType<typeof customerFixture>>) {
  return Promise.all(CUSTOMER_ROWS.map((table) => f.sql.query(`SELECT * FROM ${table}`)));
}
async function dispatchCase(
  f: Awaited<ReturnType<typeof customerFixture>>,
  l1: CustomerPhaseInput,
): Promise<CustomerPhaseInput> {
  await f.money.batch((await mechanicalGuard(f, l1)).statements);
  const history = await readCustomerJournalSnapshot(f.sql, {
    organizationId: f.org,
    realmRegistration: f.journal.realmRegistration,
    realmIncarnation: f.journal.realmIncarnation,
  });
  if (!history) throw new Error("expected completed L1 history");
  return {
    phase: "D",
    admission: f.admission,
    history,
    writerEpoch,
    couplingAttemptRef: "consent-cas:D-money",
    entryRef: "consent-cas-entry:D-money",
    historyReceiptRef: "consent-cas-H1:D-money",
    claimRef: "consent-cas-claim:D-money",
    dispatchAttemptRef: "consent-cas-attempt:D-money",
    dispatchReceiptRef: "consent-cas-receipt:D-money",
    dispatchedAt: f.at,
  };
}

for (const phase of ["L1", "D"] as const)
  test(`${phase}: freeze, revoked or foreign epoch and a missing permit roll back every Customer and Stripe row`, async () => {
    const { f, l1 } = await customerCase();
    try {
      const input = phase === "L1" ? l1 : await dispatchCase(f, l1);
      const plan = await mechanicalGuard(f, input);
      const before = await customerRows(f);
      const unchanged = async () => expect(await customerRows(f)).toEqual(before);
      // Freeze.
      f.db.exec(
        "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')",
      );
      await expect(f.money.batch(plan.statements)).rejects.toThrow(
        /constraint: Financial Customer/u,
      );
      await unchanged();
      f.db.exec("DELETE FROM money_cutover_freeze");
      // Revoked epoch: the writer's own permit insert aborts.
      f.db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(ROTATED);
      await expect(f.money.batch(plan.statements)).rejects.toThrow();
      await unchanged();
      // Foreign epoch: an authorized permit that is not the retained rows' own epoch.
      await expect(createMoneyCutoverSql(f.sql, ROTATED).batch(plan.statements)).rejects.toThrow(
        /constraint: Financial Customer .*permit\/epoch required/u,
      );
      await unchanged();
      f.db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(writerEpoch);
      // Missing permit: the same statements on the raw Sql.
      await expect(f.sql.batch(plan.statements)).rejects.toThrow(/constraint: Financial Customer/u);
      await unchanged();
      // The exact plan then commits inside the writer for the authorized epoch.
      expect((await f.money.batch(plan.statements)).map((x) => x.changes)).toEqual(
        Array(phase === "L1" ? 7 : 6).fill(1),
      );
      expect(await f.sql.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
    } finally {
      f.close();
    }
  });

test("tracked execution refuses raw Sql, a foreign writer and an unfenced shape before any statement; freeze writes nothing", async () => {
  const { f, l1 } = await customerCase();
  try {
    const calls: string[] = [];
    // The transport beneath any writer; it records every statement sent.
    const transport: Sql = {
      async query(sql, params) {
        calls.push(`query:${sql.slice(0, 24)}`);
        return f.sql.query(sql, params);
      },
      async run(sql, params) {
        calls.push("run");
        return f.sql.run(sql, params);
      },
      async batch(statements) {
        calls.push(`batch:${statements.length}`);
        return f.sql.batch(statements);
      },
    };
    const before = await customerRows(f);
    const unchanged = async () => expect(await customerRows(f)).toEqual(before);
    // A raw Sql and a Money writer for another epoch are refused before any SQL.
    for (const sql of [transport, createMoneyCutoverSql(transport, ROTATED)]) {
      await expect(createCustomerTrackedExecutionData(sql).executePhase(l1)).rejects.toThrow(
        "Root's Money writer",
      );
      expect(calls).toEqual([]);
    }
    await unchanged();
    const writer = createMoneyCutoverSql(transport, writerEpoch);
    // One missing Customer fence is not the exact fenced shape: no batch is sent.
    f.db.exec("DROP TRIGGER financial_customer_history_receipts_money_fence");
    await expect(createCustomerTrackedExecutionData(writer).executePhase(l1)).rejects.toThrow(
      "exact fenced shape",
    );
    expect(calls.filter((call) => !call.startsWith("query:"))).toEqual([]);
    await unchanged();
    f.db.exec(
      FINANCIAL_0104_CUSTOMER_FENCE_SCHEMA.financial_customer_history_receipts_money_fence ?? "",
    );
    // Freeze with the exact shape and the actual writer: nothing is written.
    f.db.exec(
      "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')",
    );
    const frozen = await createCustomerTrackedExecutionData(writer).executePhase(l1);
    expect(frozen.status).toBe("get-only");
    expect(calls.filter((call) => !call.startsWith("query:"))).toEqual([]);
    await unchanged();
    // GET-only recovery stays ungated and still reads nothing it may not.
    const recovered = await createCustomerTrackedExecutionData(transport).readOriginal(l1);
    expect(recovered.status).toBe("get-only");
    await unchanged();
  } finally {
    f.close();
  }
});
