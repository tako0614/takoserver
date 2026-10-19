import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/db-schema.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
} from "../src/money-cutover-sql.ts";
import { type Sql, SqlError, type SqlParam, type SqlStatement } from "../src/ports.ts";
import { createSharedFinancialSourceReceiver } from "../src/shared-financial-source.ts";
import { financialSourceReceiptRef } from "../src/shared-financial-source-abi.ts";
import {
  canonicalFinancialSourceJson,
  type FinancialSourceEvent,
  type FinancialSourceRegistration,
  financialSourceEventDigest,
} from "../src/shared-financial-source-contract.ts";
import {
  createFinancialPreproofChallengeStore,
  createFinancialSourceMaterializationStore,
  FINANCIAL_SOURCE_ENROLLMENT_DDL,
  type FinancialEnrollmentComponentOptions,
  type FinancialPreproofPreparation,
  type FinancialPreproofScope,
} from "../src/shared-financial-source-enrollment.ts";
import {
  createFinancialControlGenesisAdmissionStore,
  FINANCIAL_SOURCE_GENESIS_DDL,
  type FinancialControlGenesisCommand,
} from "../src/shared-financial-source-genesis-admission.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  financial0104Writer,
  installFinancial0104Fences,
  MONEY_FREEZE_ROW,
} from "./helpers/financial-0104-fenced.ts";

const AT = "2026-10-15T00:00:00.000Z";
const D = `sha256:${"a".repeat(64)}` as const,
  G = `sha256:${"b".repeat(64)}` as const,
  W = `sha256:${"c".repeat(64)}` as const;
const R = "receiver:component",
  T = "target:component",
  Q = "qualification:component",
  GQ = "genesis:component",
  A = "parent:one";
const REG: FinancialSourceRegistration = {
  registrationRef: "registration:component",
  incarnation: "incarnation:one",
  genesisDigest: G,
  receivers: [{ receiverRef: R, targetRef: T }],
};
const SCOPE: FinancialPreproofScope = {
  registrationRef: REG.registrationRef,
  clientId: "client:component",
  workspaceId: "workspace:component",
  organizationId: "org:component",
  workspaceRef: "workspace-ref:component",
};
const TABLES = [
  "financial_preproof_challenges",
  "financial_preproof_challenge_receipts",
  "financial_source_materializations",
  "financial_source_materialization_receipts",
] as const;
const count = (db: Database, table: string) =>
  db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number };
function withGuardDisabled(db: Database, name: string, mutate: () => void) {
  const guard = db
    .query("SELECT sql FROM sqlite_schema WHERE type='trigger' AND name=?")
    .get(name) as { sql: string } | null;
  if (!guard) throw Error(`missing trigger ${name}`);
  db.exec(`DROP TRIGGER ${name}`);
  try {
    mutate();
  } finally {
    db.exec(guard.sql);
  }
}
function withForeignKeysDisabled(db: Database, mutate: () => void) {
  db.exec("PRAGMA foreign_keys=OFF");
  try {
    mutate();
  } finally {
    db.exec("PRAGMA foreign_keys=ON");
  }
}
function event(affectedRef = A): FinancialSourceEvent {
  return {
    v: 1,
    eventRef: `event:${affectedRef}`,
    registrationRef: REG.registrationRef,
    incarnation: REG.incarnation,
    sequence: 1,
    previousDigest: G,
    kind: "advance",
    affectedRef,
    evidenceRef: `evidence:${affectedRef}`,
  };
}

// Mechanical fixture only. The real Core retained-row reader and Root-selected producer are not mocked as authority here.
function genesisCommand(suffix = "one", affectedRef = A): FinancialControlGenesisCommand {
  const binding = {
    workspaceId: affectedRef,
    organizationRef: "org:one",
    workspaceRef: "workspace-ref:one",
    intentId: "intent:one",
  };
  const registration = {
    sourceRef: REG.registrationRef,
    incarnation: REG.incarnation,
    genesisDigest: G.slice(7),
    requiredReceivers: REG.receivers,
  };
  const original = {
    workspaceId: affectedRef,
    sourceRef: REG.registrationRef,
    incarnation: REG.incarnation,
    registrationJson: JSON.stringify(registration),
    enrollmentJson: JSON.stringify({
      workspace: { id: affectedRef, createdAt: AT },
      management: { workspaceId: affectedRef, managementState: "active", managementEpoch: 1 },
      binding,
      members: [{ workspaceId: affectedRef, accountId: "account:one", status: "active" }],
    }),
    identityJson: JSON.stringify({
      ...registration,
      workspaceId: affectedRef,
      workspaceCreatedAt: AT,
      organizationRef: binding.organizationRef,
      workspaceRef: binding.workspaceRef,
      bindingIntentId: binding.intentId,
      bindingJson: JSON.stringify(binding),
      enrolledAt: AT,
    }),
    enrolledAt: AT,
  };
  return {
    admissionRef: `admission:${suffix}`,
    commandRef: `g-command:${suffix}`,
    receiptRef: `g-receipt:${suffix}`,
    enrollmentOriginal: original,
  };
}
const byteLength = (value: string) => new TextEncoder().encode(value).byteLength;
function padRawJson(value: string, length: number, fill: " " | "\n" = " "): string {
  const remaining = length - byteLength(value);
  if (remaining < 0) throw Error("fixture raw JSON already exceeds Core cap");
  return value + fill.repeat(remaining);
}
function largeOriginalCommand(): FinancialControlGenesisCommand {
  const command = genesisCommand("large");
  const enrollment = JSON.parse(command.enrollmentOriginal.enrollmentJson) as {
    members: { workspaceId: string; accountId: string; status: string }[];
  };
  enrollment.members = Array.from({ length: 64 }, (_, i) => ({
    workspaceId: A,
    accountId: `account:${i}:"\\雪:${"x".repeat(600)}`,
    status: "active",
  }));
  if (
    !enrollment.members[0]?.accountId.includes('"') ||
    !enrollment.members[0]?.accountId.includes("\\") ||
    !enrollment.members[0]?.accountId.includes("雪")
  )
    throw Error("fixture must retain quote, backslash and Unicode");
  const enrollmentJson = JSON.stringify(enrollment);
  if (byteLength(enrollmentJson) <= 32768 || byteLength(enrollmentJson) > 262144)
    throw Error("fixture must cross old G inner cap within Core domain");
  return { ...command, enrollmentOriginal: { ...command.enrollmentOriginal, enrollmentJson } };
}
const genesisStore = (f: Awaited<ReturnType<typeof fixture>>, affectedRef = A) =>
  createFinancialControlGenesisAdmissionStore({
    ...f.common,
    source: f.source,
    affectedRef,
    genesisQualificationRef: GQ,
  });
const assertNoGenesisRows = (db: Database) => {
  for (const table of [
    "financial_source_genesis_admissions",
    "financial_source_genesis_admission_receipts",
    "financial_source_registrations",
    "financial_source_heads",
  ])
    expect(count(db, table).n).toBe(0);
};

describe("private historical Control G candidate", () => {
  test("large quoted/Unicode/escaped Core-shaped original survives lost ACK and query-only historical GET", async () => {
    const f = await fixture();
    try {
      const base = largeOriginalCommand();
      const command = {
        ...base,
        enrollmentOriginal: {
          ...base.enrollmentOriginal,
          identityJson: padRawJson(base.enrollmentOriginal.identityJson, 40000),
        },
      };
      expect(byteLength(command.enrollmentOriginal.enrollmentJson)).toBeGreaterThan(32768);
      expect(byteLength(command.enrollmentOriginal.identityJson)).toBeGreaterThan(32768);
      const store = genesisStore(f);
      f.drop();
      await expect(store.admitGenesis(command)).rejects.toMatchObject({ code: "unavailable" });
      const stored = f.db
        .query("SELECT record_json FROM financial_source_genesis_admissions")
        .get() as { record_json: string };
      const decoded = JSON.parse(stored.record_json) as {
        enrollmentOriginal: FinancialControlGenesisCommand["enrollmentOriginal"];
      };
      expect(decoded.enrollmentOriginal).toEqual(command.enrollmentOriginal);
      expect(decoded.enrollmentOriginal.enrollmentJson).toBe(
        command.enrollmentOriginal.enrollmentJson,
      );
      expect(decoded.enrollmentOriginal.identityJson).toBe(command.enrollmentOriginal.identityJson);
      const before = { clock: f.clockCalls, batch: f.batchCalls };
      const receipt = {
        admissionRef: command.admissionRef,
        commandRef: command.commandRef,
        receiptRef: command.receiptRef,
      };
      expect(await store.readGenesisOriginal(command)).toEqual(receipt);
      expect(f.clockCalls).toBe(before.clock);
      expect(f.batchCalls).toBe(before.batch);
      f.failRead();
      await expect(store.readGenesisOriginal(command)).rejects.toMatchObject({
        code: "unavailable",
      });
      await f.base.run("INSERT INTO money_cutover_freeze VALUES(1,?,?,?,?,?)", [D, D, D, D, D]);
      expect(await store.readGenesisOriginal(command)).toEqual(receipt);
      expect(f.clockCalls).toBe(before.clock);
      expect(f.batchCalls).toBe(before.batch);
    } finally {
      f.close();
    }
  });

  test("declared Core raw byte maxima fit one G record row without duplicate original column", async () => {
    const f = await fixture();
    try {
      const base = largeOriginalCommand();
      const original = {
        ...base.enrollmentOriginal,
        registrationJson: padRawJson(base.enrollmentOriginal.registrationJson, 16384, "\n"),
        enrollmentJson: padRawJson(base.enrollmentOriginal.enrollmentJson, 262144, "\n"),
        identityJson: padRawJson(base.enrollmentOriginal.identityJson, 262144, "\n"),
      };
      expect([
        byteLength(original.registrationJson),
        byteLength(original.enrollmentJson),
        byteLength(original.identityJson),
      ]).toEqual([16384, 262144, 262144]);
      const command = { ...base, enrollmentOriginal: original };
      const receipt = await genesisStore(f).admitGenesis(command);
      expect(await genesisStore(f).readGenesisOriginal(command)).toEqual(receipt);
      const row = f.db
        .query("SELECT record_json,source_json FROM financial_source_genesis_admissions")
        .get() as { record_json: string; source_json: string };
      expect(byteLength(row.record_json)).toBeGreaterThan(1000000);
      expect(byteLength(row.record_json)).toBeLessThanOrEqual(1200000);
      expect(byteLength(row.record_json) + byteLength(row.source_json) + 4096).toBeLessThan(
        2000000,
      );
      expect(
        (
          JSON.parse(row.record_json) as {
            enrollmentOriginal: FinancialControlGenesisCommand["enrollmentOriginal"];
          }
        ).enrollmentOriginal,
      ).toEqual(original);
    } finally {
      f.close();
    }
  });

  test.each(["registrationJson", "enrollmentJson", "identityJson"] as const)(
    "raw %s one byte over Core cap rejects before batch",
    async (field) => {
      const f = await fixture();
      try {
        const c = genesisCommand();
        const maximum = field === "registrationJson" ? 16384 : 262144;
        const original = {
          ...c.enrollmentOriginal,
          [field]: padRawJson(c.enrollmentOriginal[field], maximum + 1),
        };
        await expect(
          genesisStore(f).admitGenesis({ ...c, enrollmentOriginal: original }),
        ).rejects.toMatchObject({ code: "invalid_request" });
        expect(f.batchCalls).toBe(0);
        assertNoGenesisRows(f.db);
      } finally {
        f.close();
      }
    },
  );

  test("G-specific capture still rejects accessors, custom prototypes, lone surrogates and cycles before await", async () => {
    const f = await fixture();
    try {
      const c = genesisCommand(),
        store = genesisStore(f);
      let getterCalls = 0;
      const accessor = Object.defineProperty({ ...c.enrollmentOriginal }, "enrollmentJson", {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls++;
          return c.enrollmentOriginal.enrollmentJson;
        },
      });
      const outerAccessor = Object.defineProperty({ ...c }, "receiptRef", {
        enumerable: true,
        configurable: true,
        get() {
          getterCalls++;
          return c.receiptRef;
        },
      });
      const alienPrototype = Object.setPrototypeOf({ ...c.enrollmentOriginal }, { alien: true });
      const outerPrototype = Object.setPrototypeOf({ ...c }, { alien: true });
      const cyclic: Record<string, unknown> = { ...c };
      cyclic.enrollmentOriginal = cyclic;
      for (const candidate of [
        { ...c, enrollmentOriginal: accessor },
        outerAccessor,
        { ...c, enrollmentOriginal: alienPrototype },
        outerPrototype,
        {
          ...c,
          enrollmentOriginal: {
            ...c.enrollmentOriginal,
            enrollmentJson: c.enrollmentOriginal.enrollmentJson + "\ud800",
          },
        },
        cyclic,
      ])
        await expect(
          store.admitGenesis(candidate as FinancialControlGenesisCommand),
        ).rejects.toMatchObject({ code: "invalid_request" });
      expect(getterCalls).toBe(0);
      expect(f.batchCalls).toBe(0);
      assertNoGenesisRows(f.db);
    } finally {
      f.close();
    }
  });

  test("seq0 admits no event and exact GET survives event1, retirement and freeze", async () => {
    const f = await fixture();
    try {
      const command = genesisCommand(),
        store = genesisStore(f);
      expect(await store.readGenesisOriginal(command)).toBeUndefined();
      const receipt = await store.admitGenesis(command);
      expect(receipt).toEqual({
        admissionRef: command.admissionRef,
        commandRef: command.commandRef,
        receiptRef: command.receiptRef,
      });
      expect(count(f.db, "financial_source_genesis_admissions").n).toBe(1);
      expect(count(f.db, "financial_source_genesis_admission_receipts").n).toBe(1);
      expect(count(f.db, "financial_source_events").n).toBe(0);
      expect(count(f.db, "financial_source_receipts").n).toBe(0);
      expect(await store.admitGenesis(command)).toEqual(receipt);
      const eventReceipt = await f.receiver().applySourceEvent(event(A));
      expect(eventReceipt.sequence).toBe(1);
      await f.base.run(
        "UPDATE financial_source_registrations SET retirement_ref=?,retired_at=? WHERE registration_ref=? AND incarnation=?",
        ["retirement:one", AT, REG.registrationRef, REG.incarnation],
      );
      await f.base.run("INSERT INTO money_cutover_freeze VALUES(1,?,?,?,?,?)", [D, D, D, D, D]);
      const clocks = f.clockCalls,
        batches = f.batchCalls;
      expect(await store.readGenesisOriginal(command)).toEqual(receipt);
      expect(f.clockCalls).toBe(clocks);
      expect(f.batchCalls).toBe(batches);
    } finally {
      f.close();
    }
  });

  test("historical G GET survives terminal close and writer-epoch rotation", async () => {
    const f = await fixture();
    try {
      const command = genesisCommand(),
        store = genesisStore(f);
      const receipt = await store.admitGenesis(command);
      const firstEvent = event(A);
      await f.receiver().applySourceEvent(firstEvent);
      const closeEvent: FinancialSourceEvent = {
        ...firstEvent,
        eventRef: "event:close",
        sequence: 2,
        previousDigest: await financialSourceEventDigest(firstEvent),
        kind: "close",
        evidenceRef: "evidence:close",
      };
      const closeReceipt = await f.receiver(A, GQ, closeEvent).applySourceEvent(closeEvent);
      expect(closeReceipt.state).toBe("admission-closed");
      f.db.exec(`UPDATE money_cutover_authorized_epoch SET writer_epoch='${D}' WHERE singleton=1`);
      const before = { clock: f.clockCalls, batch: f.batchCalls };
      expect(await store.readGenesisOriginal(command)).toEqual(receipt);
      expect(f.clockCalls).toBe(before.clock);
      expect(f.batchCalls).toBe(before.batch);
    } finally {
      f.close();
    }
  });

  test("late batch fault rolls back G original, registration, head and receipt", async () => {
    const f = await fixture();
    try {
      f.fault((statements) => [
        ...statements,
        {
          sql: "INSERT INTO financial_source_genesis_admission_receipts(receipt_ref) VALUES('late-fault')",
        },
      ]);
      const command = genesisCommand();
      await expect(genesisStore(f).admitGenesis(command)).rejects.toMatchObject({
        code: "conflict",
      });
      for (const table of [
        "financial_source_genesis_admissions",
        "financial_source_genesis_admission_receipts",
        "financial_source_registrations",
        "financial_source_heads",
      ])
        expect(count(f.db, table).n).toBe(0);
      expect(await genesisStore(f).readGenesisOriginal(command)).toBeUndefined();
    } finally {
      f.close();
    }
  });

  test("fourth mandatory receipt rejects zero-match and rolls back the first three rows", async () => {
    const f = await fixture();
    try {
      f.fault((statements) => {
        expect(statements).toHaveLength(4);
        const receipt = statements[3]!;
        const params = [...(receipt.params ?? [])];
        params[params.length - 1] = "genesis:wrong";
        return [...statements.slice(0, 3), { ...receipt, params }];
      });
      await expect(genesisStore(f).admitGenesis(genesisCommand())).rejects.toMatchObject({
        code: "conflict",
      });
      assertNoGenesisRows(f.db);
    } finally {
      f.close();
    }
  });

  test("local realm change after GET and before batch rolls back all G rows", async () => {
    const f = await fixture();
    try {
      f.fault((statements) => {
        withGuardDisabled(f.db, "stripe_mode_realm_no_update", () =>
          f.db.exec("UPDATE stripe_mode_realm SET mode='live' WHERE singleton=1"),
        );
        return statements;
      });
      await expect(genesisStore(f).admitGenesis(genesisCommand())).rejects.toMatchObject({
        code: "conflict",
      });
      assertNoGenesisRows(f.db);
    } finally {
      f.close();
    }
  });

  test.each(["epoch", "freeze"] as const)(
    "local %s change after GET and before batch rolls back all G rows through the 0104 fences",
    async (change) => {
      const f = await fixture();
      try {
        // Freeze/permit/epoch are the Financial 0104 fences inside the actual
        // permit-framed Money writer; the G predicate names no money table.
        installFinancial0104Fences(f.db, { receiver: true, c0: true });
        const { money, realm } = await financial0104Writer(f.sql, W, f.common.client, {
          accountId: "acct_enrollment",
          billingAuthority: "enrollment",
          priceId: "price_enrollment",
        });
        const fenced = () =>
          createFinancialControlGenesisAdmissionStore({
            ...f.common,
            sql: money,
            realm,
            source: f.source,
            affectedRef: A,
            genesisQualificationRef: GQ,
          });
        f.fault((statements) => {
          if (change === "epoch")
            f.db.exec(
              `UPDATE money_cutover_authorized_epoch SET writer_epoch='${D}' WHERE singleton=1`,
            );
          if (change === "freeze") f.db.exec(MONEY_FREEZE_ROW);
          return statements;
        });
        await expect(fenced().admitGenesis(genesisCommand())).rejects.toMatchObject({
          code: "conflict",
        });
        assertNoGenesisRows(f.db);
        expect(count(f.db, "money_cutover_writer_permit").n).toBe(0);
        f.fault(undefined);
        if (change === "epoch")
          f.db.exec(
            `UPDATE money_cutover_authorized_epoch SET writer_epoch='${W}' WHERE singleton=1`,
          );
        else f.db.exec("DELETE FROM money_cutover_freeze");
        // Outside the permit frame the same G batch is refused by the fences.
        await expect(genesisStore(f).admitGenesis(genesisCommand())).rejects.toMatchObject({
          code: "conflict",
        });
        assertNoGenesisRows(f.db);
        // A current permit under a foreign epoch is refused: the G row keeps its own.
        f.db.exec(
          `UPDATE money_cutover_authorized_epoch SET writer_epoch='${D}' WHERE singleton=1`,
        );
        const foreign = await financial0104Writer(f.sql, D, f.common.client, {
          accountId: "acct_enrollment",
          billingAuthority: "enrollment",
          priceId: "price_enrollment",
        });
        await expect(
          createFinancialControlGenesisAdmissionStore({
            ...f.common,
            sql: foreign.money,
            realm: foreign.realm,
            source: f.source,
            affectedRef: A,
            genesisQualificationRef: GQ,
          }).admitGenesis(genesisCommand()),
        ).rejects.toMatchObject({ code: "conflict" });
        assertNoGenesisRows(f.db);
        f.db.exec(
          `UPDATE money_cutover_authorized_epoch SET writer_epoch='${W}' WHERE singleton=1`,
        );
        // Inside the actual writer with the authorized epoch all four rows commit.
        expect(await fenced().admitGenesis(genesisCommand())).toMatchObject({
          admissionRef: "admission:one",
        });
        for (const table of [
          "financial_source_genesis_admissions",
          "financial_source_genesis_admission_receipts",
          "financial_source_registrations",
          "financial_source_heads",
        ])
          expect(count(f.db, table).n).toBe(1);
        expect(count(f.db, "money_cutover_writer_permit").n).toBe(0);
        for (const statement of f.batches.at(-1)?.slice(1, -1) ?? [])
          expect(statement.sql).not.toMatch(/\bmoney_cutover_/u);
      } finally {
        f.close();
      }
    },
  );

  test("independent orphan and malformed adapter projections never become positive absence", async () => {
    const cases: readonly {
      name: string;
      match: string;
      row: Record<string, unknown>;
      code: string;
    }[] = [
      {
        name: "orphan M receipt on full triple with unrelated IDs",
        match: "FROM financial_source_materialization_receipts",
        row: {
          receipt_ref: "m-orphan:other",
          command_ref: "m-command:other",
          registration_ref: REG.registrationRef,
          incarnation: REG.incarnation,
          affected_ref: A,
        },
        code: "conflict",
      },
      {
        name: "orphan G receipt",
        match: "FROM financial_source_genesis_admission_receipts",
        row: {
          receipt_ref: "g-orphan:other",
          admission_ref: "admission:other",
          command_ref: "g-command:other",
          registration_ref: REG.registrationRef,
          incarnation: REG.incarnation,
        },
        code: "unavailable",
      },
      {
        name: "partial G root",
        match: "FROM financial_source_genesis_admissions g",
        row: { admission_ref: "admission:one" },
        code: "conflict",
      },
      {
        name: "null occupied head",
        match: " AS head,",
        row: { head: null, registration: 0 },
        code: "unavailable",
      },
      {
        name: "missing occupied registration",
        match: " AS head,",
        row: { head: 0 },
        code: "unavailable",
      },
      {
        name: "string occupied values",
        match: " AS head,",
        row: { head: "0", registration: "0" },
        code: "unavailable",
      },
    ];
    for (const c of cases) {
      const f = await fixture();
      try {
        let hit = 0;
        f.projectQuery((q, p, rows) => {
          if (!q.includes(c.match)) return rows;
          hit++;
          if (c.name === "orphan M receipt on full triple with unrelated IDs") {
            expect(q).toContain("registration_ref=? AND incarnation=? AND affected_ref=?");
            expect(p).toEqual([
              "g-command:one",
              "g-receipt:one",
              REG.registrationRef,
              REG.incarnation,
              A,
            ]);
          }
          return [c.row];
        });
        await expect(genesisStore(f).readGenesisOriginal(genesisCommand())).rejects.toMatchObject({
          code: c.code,
        });
        expect(hit).toBe(1);
      } finally {
        f.close();
      }
    }
  });

  test("occupied registration rejects sibling affectedRef, wrong IDs and wrong source", async () => {
    const f = await fixture();
    try {
      const command = genesisCommand();
      await genesisStore(f).admitGenesis(command);
      await expect(
        genesisStore(f, "parent:alien").readGenesisOriginal(
          genesisCommand("alien", "parent:alien"),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        genesisStore(f).readGenesisOriginal({ ...command, receiptRef: "g-receipt:alien" }),
      ).rejects.toMatchObject({ code: "conflict" });
      const changedSource = createFinancialControlGenesisAdmissionStore({
        ...f.common,
        source: { ...f.source, registrationDigest: `sha256:${"d".repeat(64)}` },
        affectedRef: A,
        genesisQualificationRef: GQ,
      });
      await expect(changedSource.readGenesisOriginal(command)).rejects.toMatchObject({
        code: "conflict",
      });
      expect(count(f.db, "financial_source_genesis_admissions").n).toBe(1);
    } finally {
      f.close();
    }
  });

  test("lost committed ACK is recovered only by the exact GET original", async () => {
    const f = await fixture();
    try {
      const command = genesisCommand(),
        store = genesisStore(f);
      f.drop();
      await expect(store.admitGenesis(command)).rejects.toMatchObject({ code: "unavailable" });
      expect(await store.readGenesisOriginal(command)).toEqual({
        admissionRef: command.admissionRef,
        commandRef: command.commandRef,
        receiptRef: command.receiptRef,
      });
      await expect(
        store.readGenesisOriginal({ ...command, commandRef: "g-command:other" }),
      ).rejects.toMatchObject({ code: "conflict" });
    } finally {
      f.close();
    }
  });

  test("G and event M cannot each bootstrap the same Control registration", async () => {
    const first = await fixture();
    try {
      const gCommand = genesisCommand();
      await genesisStore(first).admitGenesis(gCommand);
      const before = {
        batches: first.batchCalls,
        runs: first.runCalls,
        changes: first.db.query("SELECT total_changes() AS n").get(),
        original: first.db
          .query("SELECT * FROM financial_source_genesis_admissions ORDER BY admission_ref")
          .all(),
        receipt: first.db
          .query("SELECT * FROM financial_source_genesis_admission_receipts ORDER BY receipt_ref")
          .all(),
      };
      // Current M rejects observed G occupancy before any install SQL. Its
      // unqualified G observation reports unavailable, never a typed conflict.
      await expect(first.m().install(await first.command(A))).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(first.batchCalls).toBe(before.batches);
      expect(first.runCalls).toBe(before.runs);
      expect(first.db.query("SELECT total_changes() AS n").get()).toEqual(before.changes);
      expect(
        first.db
          .query("SELECT * FROM financial_source_genesis_admissions ORDER BY admission_ref")
          .all(),
      ).toEqual(before.original);
      expect(
        first.db
          .query("SELECT * FROM financial_source_genesis_admission_receipts ORDER BY receipt_ref")
          .all(),
      ).toEqual(before.receipt);
      expect(await genesisStore(first).readGenesisOriginal(gCommand)).toEqual({
        admissionRef: gCommand.admissionRef,
        commandRef: gCommand.commandRef,
        receiptRef: gCommand.receiptRef,
      });
      expect(count(first.db, "financial_source_materializations").n).toBe(0);
    } finally {
      first.close();
    }
    const second = await fixture();
    try {
      await second.m().install(await second.command(A));
      await expect(genesisStore(second).admitGenesis(genesisCommand())).rejects.toMatchObject({
        code: "conflict",
      });
      expect(count(second.db, "financial_source_genesis_admissions").n).toBe(0);
    } finally {
      second.close();
    }
  });

  test("both SQL insertion orders reject OR REPLACE and preserve the first completed family", async () => {
    const first = await fixture();
    try {
      const gCommand = genesisCommand();
      await genesisStore(first).admitGenesis(gCommand);
      const sourceJson = (
        first.db.query("SELECT source_json FROM financial_source_genesis_admissions").get() as {
          source_json: string;
        }
      ).source_json;
      const mCommand = await first.command(A);
      const mRecord = canonicalFinancialSourceJson({
        ...mCommand,
        source: JSON.parse(sourceJson),
        affectedRef: A,
        genesisQualificationRef: GQ,
      });
      await expect(
        first.base.run(
          `INSERT OR REPLACE INTO financial_source_materializations
        (materialization_ref,command_ref,registration_ref,incarnation,affected_ref,source_json,record_json,genesis_qualification_ref,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
          [
            mCommand.materializationRef,
            mCommand.commandRef,
            REG.registrationRef,
            REG.incarnation,
            A,
            sourceJson,
            mRecord,
            GQ,
            AT,
          ],
        ),
      ).rejects.toMatchObject({ code: "constraint" });
      expect(count(first.db, "financial_source_genesis_admissions").n).toBe(1);
      expect(count(first.db, "financial_source_genesis_admission_receipts").n).toBe(1);
      expect(count(first.db, "financial_source_materializations").n).toBe(0);
    } finally {
      first.close();
    }
    const second = await fixture();
    try {
      await second.m().install(await second.command(A));
      const sourceJson = (
        second.db.query("SELECT source_json FROM financial_source_materializations").get() as {
          source_json: string;
        }
      ).source_json;
      const gCommand = genesisCommand();
      const gRecord = canonicalFinancialSourceJson({
        ...gCommand,
        source: JSON.parse(sourceJson),
        affectedRef: A,
        genesisQualificationRef: GQ,
      });
      await expect(
        second.base.run(
          `INSERT OR REPLACE INTO financial_source_genesis_admissions
        (admission_ref,command_ref,receipt_ref,registration_ref,incarnation,affected_ref,source_json,record_json,genesis_qualification_ref,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`,
          [
            gCommand.admissionRef,
            gCommand.commandRef,
            gCommand.receiptRef,
            REG.registrationRef,
            REG.incarnation,
            A,
            sourceJson,
            gRecord,
            GQ,
            AT,
          ],
        ),
      ).rejects.toMatchObject({ code: "constraint" });
      expect(count(second.db, "financial_source_materializations").n).toBe(1);
      expect(count(second.db, "financial_source_materialization_receipts").n).toBe(1);
      expect(count(second.db, "financial_source_genesis_admissions").n).toBe(0);
    } finally {
      second.close();
    }
  });

  test.each(["command", "receipt"] as const)(
    "M root cannot take a completed G %s ID under an alien full key",
    async (which) => {
      const f = await fixture();
      try {
        const g = genesisCommand();
        await genesisStore(f).admitGenesis(g);
        const retained = f.db
          .query("SELECT source_json FROM financial_source_genesis_admissions")
          .get() as { source_json: string };
        const alienSource = JSON.parse(retained.source_json) as Record<string, unknown> & {
          registration: Record<string, unknown>;
        };
        alienSource.registration = {
          ...alienSource.registration,
          registrationRef: "registration:alien",
          incarnation: "incarnation:alien",
        };
        const m = await f.command("parent:alien", "alien");
        const candidate = {
          ...m,
          commandRef: which === "command" ? g.commandRef : m.commandRef,
          receiptRef: which === "receipt" ? g.receiptRef : m.receiptRef,
          source: alienSource,
          affectedRef: "parent:alien",
          genesisQualificationRef: GQ,
        };
        await expect(
          f.base.run(
            `INSERT OR REPLACE INTO financial_source_materializations
        (materialization_ref,command_ref,registration_ref,incarnation,affected_ref,source_json,record_json,genesis_qualification_ref,created_at)
        VALUES(?,?,?,?,?,?,?,?,?)`,
            [
              candidate.materializationRef,
              candidate.commandRef,
              "registration:alien",
              "incarnation:alien",
              "parent:alien",
              canonicalFinancialSourceJson(alienSource),
              canonicalFinancialSourceJson(candidate),
              GQ,
              AT,
            ],
          ),
        ).rejects.toMatchObject({ code: "constraint" });
        expect(count(f.db, "financial_source_materializations").n).toBe(0);
        expect(count(f.db, "financial_source_genesis_admissions").n).toBe(1);
        expect(count(f.db, "financial_source_genesis_admission_receipts").n).toBe(1);
      } finally {
        f.close();
      }
    },
  );

  test.each(["command", "receipt"] as const)(
    "G root cannot take a completed M %s ID under an alien full key",
    async (which) => {
      const f = await fixture();
      try {
        const m = await f.command(A);
        await f.m().install(m);
        const before = {
          originals: f.db
            .query("SELECT * FROM financial_source_materializations ORDER BY materialization_ref")
            .all(),
          receipts: f.db
            .query("SELECT * FROM financial_source_materialization_receipts ORDER BY receipt_ref")
            .all(),
        };
        expect(before.originals).toHaveLength(1);
        expect(before.receipts).toHaveLength(1);
        const retained = f.db
          .query("SELECT source_json FROM financial_source_materializations")
          .get() as { source_json: string };
        const alienSource = JSON.parse(retained.source_json) as Record<string, unknown> & {
          registration: Record<string, unknown>;
        };
        alienSource.registration = {
          ...alienSource.registration,
          registrationRef: "registration:alien",
          incarnation: "incarnation:alien",
        };
        const base = genesisCommand("alien", "parent:alien");
        const coreRegistration = JSON.parse(base.enrollmentOriginal.registrationJson) as Record<
          string,
          unknown
        >;
        const coreIdentity = JSON.parse(base.enrollmentOriginal.identityJson) as Record<
          string,
          unknown
        >;
        const original = {
          ...base.enrollmentOriginal,
          sourceRef: "registration:alien",
          incarnation: "incarnation:alien",
          registrationJson: JSON.stringify({
            ...coreRegistration,
            sourceRef: "registration:alien",
            incarnation: "incarnation:alien",
          }),
          identityJson: JSON.stringify({
            ...coreIdentity,
            sourceRef: "registration:alien",
            incarnation: "incarnation:alien",
          }),
        };
        const unoccupied = { ...base, enrollmentOriginal: original };
        const insert = `INSERT OR REPLACE INTO financial_source_genesis_admissions
        (admission_ref,command_ref,receipt_ref,registration_ref,incarnation,affected_ref,source_json,record_json,genesis_qualification_ref,created_at)
        VALUES(?,?,?,?,?,?,?,?,?,?)`;
        const params = (g: FinancialControlGenesisCommand) =>
          [
            g.admissionRef,
            g.commandRef,
            g.receiptRef,
            "registration:alien",
            "incarnation:alien",
            "parent:alien",
            canonicalFinancialSourceJson(alienSource),
            canonicalFinancialSourceJson({
              ...g,
              source: alienSource,
              affectedRef: "parent:alien",
              genesisQualificationRef: GQ,
            }),
            GQ,
            AT,
          ] as const;
        // Test-only root probe: this exact alien key/shape must insert when neither ID collides.
        f.db.exec("SAVEPOINT alien_g_shape_probe");
        try {
          await f.base.run(insert, params(unoccupied));
          expect(count(f.db, "financial_source_genesis_admissions").n).toBe(1);
        } finally {
          f.db.exec("ROLLBACK TO SAVEPOINT alien_g_shape_probe");
          f.db.exec("RELEASE SAVEPOINT alien_g_shape_probe");
        }
        expect(count(f.db, "financial_source_genesis_admissions").n).toBe(0);
        const colliding = {
          ...unoccupied,
          commandRef: which === "command" ? m.commandRef : unoccupied.commandRef,
          receiptRef: which === "receipt" ? m.receiptRef : unoccupied.receiptRef,
        };
        await expect(f.base.run(insert, params(colliding))).rejects.toMatchObject({
          code: "constraint",
        });
        expect(count(f.db, "financial_source_genesis_admissions").n).toBe(0);
        expect(count(f.db, "financial_source_genesis_admission_receipts").n).toBe(0);
        expect(
          f.db
            .query("SELECT * FROM financial_source_materializations ORDER BY materialization_ref")
            .all(),
        ).toEqual(before.originals);
        expect(
          f.db
            .query("SELECT * FROM financial_source_materialization_receipts ORDER BY receipt_ref")
            .all(),
        ).toEqual(before.receipts);
      } finally {
        f.close();
      }
    },
  );

  test("wrong original key and incomplete retained Core shape fail before any batch", async () => {
    const f = await fixture();
    try {
      const c = genesisCommand(),
        store = genesisStore(f);
      await expect(
        store.admitGenesis({
          ...c,
          enrollmentOriginal: { ...c.enrollmentOriginal, workspaceId: "workspace:alien" },
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(
        store.admitGenesis({
          ...c,
          enrollmentOriginal: { ...c.enrollmentOriginal, identityJson: "{}" },
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      expect(f.batchCalls).toBe(0);
    } finally {
      f.close();
    }
  });

  test("unknown read and missing strict schema cannot be mistaken for absence", async () => {
    const first = await fixture();
    try {
      first.failRead();
      await expect(genesisStore(first).readGenesisOriginal(genesisCommand())).rejects.toMatchObject(
        { code: "unavailable" },
      );
    } finally {
      first.close();
    }
    const second = await fixture();
    try {
      second.db.exec("DROP TRIGGER financial_source_materializations_no_genesis_collision");
      await expect(
        genesisStore(second).readGenesisOriginal(genesisCommand()),
      ).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      second.close();
    }
  });
});
async function fixture() {
  const db = new Database(":memory:");
  for (const m of MIGRATIONS) db.exec(m.sql);
  db.exec(
    readFileSync(
      new URL("./fixtures/shared-financial-source-component-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
  db.exec(MONEY_CUTOVER_FREEZE_DDL);
  db.exec(FINANCIAL_SOURCE_ENROLLMENT_DDL);
  db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
  const base = createSqliteSql(db);
  let clockCalls = 0,
    batchCalls = 0,
    queryCalls = 0,
    runCalls = 0,
    readFailure = false,
    dropAck = false;
  let fault: ((s: readonly SqlStatement[]) => readonly SqlStatement[]) | undefined;
  let queryProjection:
    | ((
        q: string,
        p: readonly SqlParam[] | undefined,
        rows: readonly Record<string, unknown>[],
      ) => readonly Record<string, unknown>[])
    | undefined;
  const batches: (readonly SqlStatement[])[] = [];
  const failures: string[] = [];
  const sql: Sql = {
    query: async (q, p) => {
      queryCalls++;
      if (readFailure) {
        readFailure = false;
        throw new SqlError("unavailable", "injected readback loss");
      }
      const rows = await base.query(q, p);
      return queryProjection ? queryProjection(q, p, rows) : rows;
    },
    run: (q, p) => {
      runCalls++;
      return base.run(q, p);
    },
    batch: async (s) => {
      batchCalls++;
      batches.push(s);
      try {
        const r = await base.batch(fault ? fault(s) : s);
        if (dropAck) {
          dropAck = false;
          readFailure = true;
          throw new SqlError("unavailable", "dropped committed ACK");
        }
        return r;
      } catch (e) {
        failures.push(String(e));
        throw e;
      }
    },
  };
  await base.run("INSERT INTO stripe_mode_realm VALUES(1,'test',?)", [AT]);
  await base.run(
    "INSERT INTO stripe_billing_account_realms VALUES(1,'acct_enrollment','test','enrollment',?)",
    [AT],
  );
  await base.run("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)", [W]);
  let providerRequests = 0;
  const client = createStripeBillingClient({
    secretKey: "sk_test_component_fixture",
    async fetch(request) {
      providerRequests++;
      const u = new URL(request.url);
      if (request.method !== "GET") throw Error("provider effect forbidden");
      if (u.pathname === "/v1/account")
        return Response.json({ object: "account", id: "acct_enrollment" });
      if (u.pathname === "/v1/prices/price_enrollment")
        return Response.json({
          object: "price",
          id: "price_enrollment",
          livemode: false,
          currency: "usd",
          type: "recurring",
          billing_scheme: "per_unit",
          unit_amount: 1000,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      throw Error("unexpected fake provider read");
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: "acct_enrollment", mode: "test", billingAuthority: "enrollment" },
    prices: [{ priceId: "price_enrollment", monthlyAmountMinor: 1000 }],
  });
  const common: FinancialEnrollmentComponentOptions = {
    sql,
    client,
    realm,
    writerEpoch: W,
    receiverRef: R,
    targetRef: T,
    clock: () => {
      clockCalls++;
      return new Date(AT);
    },
  };
  const c0 = () => createFinancialPreproofChallengeStore({ ...common, scope: SCOPE });
  const source = {
    registration: REG,
    registrationDigest: D,
    qualificationRef: Q,
    sourceSchemaDigest: D,
    sourceCredentialRef: "credential:component",
    clockPolicyRef: "clock:component",
    originRef: "origin:component",
  };
  const m = (affectedRef = A, genesisQualificationRef = GQ) =>
    createFinancialSourceMaterializationStore({
      ...common,
      source,
      affectedRef,
      genesisQualificationRef,
    });
  const preparation = (suffix = "one"): FinancialPreproofPreparation => ({
    preparationRef: `preparation:${suffix}`,
    receiptRef: `c0-receipt:${suffix}`,
    challenge: {
      v: 1,
      challengeRef: `challenge:${suffix}`,
      ...SCOPE,
      requestFingerprint: D,
      createdAt: Date.parse(AT),
      expiresAt: Date.parse(AT) + 300_000,
    },
    selection: {
      action: {
        kind: "customer-create",
        ref: `action:${suffix}`,
        body: { email: "component@example.invalid" },
        requestFingerprint: D,
      },
      customer: {
        requestRef: `native:${suffix}`,
        idempotencyKey: `key:${suffix}`,
        requestFingerprint: G,
        financialRealm: realm.financialRealm,
      },
      business: { ref: `business:${suffix}`, requestFingerprint: G },
      terms: { ref: "terms:one", digest: D },
      carrier: {
        issuerRef: "issuer:component",
        requestRef: `request:${suffix}`,
        carrierRef: "carrier:component",
        contextRef: "context:component",
        createdAt: AT,
      },
      billingBinding: {
        bindingRef: "binding:component",
        organizationId: SCOPE.organizationId,
        workspaceId: SCOPE.workspaceId,
        workspaceRef: SCOPE.workspaceRef,
      },
    },
  });
  const command = async (affectedRef = A, suffix = "one") => {
    const e = event(affectedRef);
    return {
      materializationRef: `materialization:${suffix}`,
      commandRef: `command:${suffix}`,
      receiptRef: `m-receipt:${suffix}`,
      materialization: {
        rawEventDigest: D,
        event: e,
        eventDigest: await financialSourceEventDigest(e),
      },
    };
  };
  const receiver = (
    affectedRef = A,
    genesisQualificationRef = GQ,
    suppliedEvent?: FinancialSourceEvent,
  ) =>
    createSharedFinancialSourceReceiver({
      ...common,
      registration: REG,
      registrationDigest: D,
      qualificationRef: Q,
      evidence: {
        async readImmutableEvent(ref: string) {
          const e = suppliedEvent ?? event(affectedRef);
          return ref === e.eventRef
            ? {
                qualificationRef: Q,
                receiverRef: R,
                targetRef: T,
                genesisQualificationRef,
                registration: REG,
                event: e,
              }
            : null;
        },
      },
    });
  return {
    db,
    base,
    sql,
    common,
    source,
    c0,
    m,
    preparation,
    command,
    receiver,
    batches,
    failures,
    get clockCalls() {
      return clockCalls;
    },
    get batchCalls() {
      return batchCalls;
    },
    get queryCalls() {
      return queryCalls;
    },
    get runCalls() {
      return runCalls;
    },
    get providerRequests() {
      return providerRequests;
    },
    fault: (f: typeof fault) => {
      fault = f;
    },
    projectQuery: (f: typeof queryProjection) => {
      queryProjection = f;
    },
    drop: () => {
      dropAck = true;
    },
    failRead: () => {
      readFailure = true;
    },
    counts: () => TABLES.map((t) => count(db, t).n),
    close: () => db.close(),
  };
}

// These are component data/transport fixtures, not genuine source origin, bootstrap proof or payer authority.
