import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { MIGRATIONS } from "../src/db-schema.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
} from "../src/money-cutover-sql.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
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
import { FINANCIAL_GENESIS_SCHEMA } from "../src/shared-financial-source-genesis-schema.ts";
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
  const base = createSqliteSql(db);
  let clockCalls = 0,
    batchCalls = 0,
    queryCalls = 0,
    runCalls = 0,
    readFailure = false,
    dropAck = false;
  let fault: ((s: readonly SqlStatement[]) => readonly SqlStatement[]) | undefined;
  const batches: (readonly SqlStatement[])[] = [];
  const failures: string[] = [];
  const sql: Sql = {
    query: async (q, p) => {
      queryCalls++;
      if (readFailure) {
        readFailure = false;
        throw new SqlError("unavailable", "injected readback loss");
      }
      return base.query(q, p);
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
  const receiver = (affectedRef = A, genesisQualificationRef = GQ) =>
    createSharedFinancialSourceReceiver({
      ...common,
      registration: REG,
      registrationDigest: D,
      qualificationRef: Q,
      evidence: {
        async readImmutableEvent(ref: string) {
          const e = event(affectedRef);
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
describe("private C0 and explicit M component", () => {
  test("C0 commits with no Org/A/payer/E and reads the original exact ten fields without clock", async () => {
    const f = await fixture();
    try {
      const p = f.preparation();
      expect(count(f.db, "orgs").n).toBe(0);
      expect(
        f.db
          .query(
            "SELECT name FROM sqlite_schema WHERE name IN ('shared_customer_challenges','financial_source_enrollments','financial_payer_grants')",
          )
          .all(),
      ).toHaveLength(0);
      const receipt = await f.c0().prepare(p);
      expect(receipt).toEqual({
        preparationRef: p.preparationRef,
        challengeRef: p.challenge.challengeRef,
        receiptRef: p.receiptRef,
      });
      expect(f.counts()).toEqual([1, 1, 0, 0]);
      const calls = f.clockCalls;
      await f.base.run("INSERT INTO money_cutover_freeze VALUES(1,?,?,?,?,?)", [D, D, D, D, D]);
      const read = await f.c0().readChallenge(p.challenge.challengeRef);
      expect(read).toEqual(p.challenge);
      expect(Object.keys(read ?? {})).toHaveLength(10);
      expect(await f.c0().prepare(p)).toEqual(receipt);
      expect(f.clockCalls).toBe(calls);
      expect(await f.c0().readChallenge("challenge:absent")).toBeUndefined();
      expect(f.providerRequests).toBe(2);
    } finally {
      f.close();
    }
  });
  test("C0 frozen selection and scope reject changed attempts without rewriting originals", async () => {
    const f = await fixture();
    try {
      const p = f.preparation();
      await f.c0().prepare(p);
      const changed = structuredClone(p);
      (changed.selection.terms as { ref: string }).ref = "terms:two";
      await expect(f.c0().prepare(changed)).rejects.toMatchObject({ code: "conflict" });
      const wrong = createFinancialPreproofChallengeStore({
        ...f.common,
        scope: { ...SCOPE, workspaceId: "workspace:other" },
      });
      await expect(wrong.readChallenge(p.challenge.challengeRef)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(await f.c0().readChallenge(p.challenge.challengeRef)).toEqual(p.challenge);
      expect(f.counts()).toEqual([1, 1, 0, 0]);
    } finally {
      f.close();
    }
  });
  test("C0 snapshots data before await and rejects accessors/unknown closed keys", async () => {
    const f = await fixture();
    try {
      const p = f.preparation();
      const original = structuredClone(p);
      const pending = f.c0().prepare(p);
      (p.selection.terms as { ref: string }).ref = "terms:mutated";
      await pending;
      expect(await f.c0().prepare(original)).toMatchObject({ receiptRef: original.receiptRef });
      const bad = { ...f.preparation("bad"), extra: true };
      await expect(f.c0().prepare(bad)).rejects.toMatchObject({ code: "invalid_request" });
      let touched = 0;
      const getter = { ...f.preparation("getter") };
      Object.defineProperty(getter, "selection", {
        enumerable: true,
        get() {
          touched++;
          return original.selection;
        },
      });
      await expect(f.c0().prepare(getter)).rejects.toMatchObject({ code: "invalid_request" });
      expect(touched).toBe(0);
    } finally {
      f.close();
    }
  });
  test("C0 concurrent same-original replay and conflicting selection retain one root/receipt", async () => {
    const f = await fixture();
    try {
      const p = f.preparation();
      const results = await Promise.all([f.c0().prepare(p), f.c0().prepare(p)]);
      expect(results[0]).toEqual(results[1]);
      expect(f.counts()).toEqual([1, 1, 0, 0]);
      const a = f.preparation("race"),
        b = structuredClone(a);
      (b.selection.terms as { ref: string }).ref = "terms:race-loser";
      const race = await Promise.allSettled([f.c0().prepare(a), f.c0().prepare(b)]);
      expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(race.filter((r) => r.status === "rejected")).toHaveLength(1);
      expect(f.counts()).toEqual([2, 2, 0, 0]);
    } finally {
      f.close();
    }
  });
  test("actual postcommit C0 ACK plus readback loss recovers only the original from a new factory", async () => {
    const f = await fixture();
    try {
      const p = f.preparation();
      f.drop();
      await expect(f.c0().prepare(p)).rejects.toMatchObject({ code: "unavailable" });
      expect(f.counts()).toEqual([1, 1, 0, 0]);
      const before = f.clockCalls;
      expect(await f.c0().prepare(p)).toMatchObject({ receiptRef: p.receiptRef });
      expect(f.clockCalls).toBe(before);
      expect(f.batchCalls).toBe(1);
    } finally {
      f.close();
    }
  });
  for (const fault of ["zero", "null", "late"] as const)
    test(`C0 ${fault} final failure rolls back every prefix`, async () => {
      const f = await fixture();
      try {
        if (fault === "late")
          f.db.exec(
            "CREATE TRIGGER injected_c0_late BEFORE INSERT ON financial_preproof_challenge_receipts BEGIN SELECT RAISE(ABORT,'constraint: injected C0 late failure'); END",
          );
        // Additional schema is intentionally rejected before writes; remove only at the batch boundary so the actual late trigger executes.
        if (fault === "late") f.db.exec("DROP TRIGGER injected_c0_late");
        f.fault((s) => {
          if (fault === "late")
            f.db.exec(
              "CREATE TRIGGER injected_c0_late BEFORE INSERT ON financial_preproof_challenge_receipts BEGIN SELECT RAISE(ABORT,'constraint: injected C0 late failure'); END",
            );
          return s.map((x, i) =>
            i === 0 && fault === "zero"
              ? { ...x, sql: x.sql.replace(" WHERE ", " WHERE NULL AND ") }
              : i === 1 && fault === "null"
                ? {
                    ...x,
                    sql: x.sql.replace(/CASE WHEN[\s\S]+THEN 1 ELSE 0 END/u, "NULL"),
                    params: x.params?.slice(0, 4) ?? [],
                  }
                : x,
          );
        });
        await expect(f.c0().prepare(f.preparation())).rejects.toMatchObject({ code: "conflict" });
        expect(f.counts()).toEqual([0, 0, 0, 0]);
        expect(f.failures).toHaveLength(1);
        if (fault === "late") expect(f.failures[0]).toContain("injected C0 late failure");
      } finally {
        f.close();
      }
    });
  test("receiver missing rows never autoenroll; explicit M installs head0 then real receiver produces original official receipt", async () => {
    const f = await fixture();
    try {
      const cmd = await f.command();
      await expect(f.receiver().applySourceEvent(cmd.materialization.event)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(f.counts()).toEqual([0, 0, 0, 0]);
      expect(count(f.db, "financial_source_registrations").n).toBe(0);
      const mr = await f.m().install(cmd);
      expect(mr).toEqual({
        materializationRef: cmd.materializationRef,
        commandRef: cmd.commandRef,
        receiptRef: cmd.receiptRef,
      });
      expect(
        f.db.query("SELECT sequence,last_event_ref,state FROM financial_source_heads").get(),
      ).toEqual({ sequence: 0, last_event_ref: null, state: "active" });
      const receipt = await f.receiver().applySourceEvent(cmd.materialization.event);
      expect(receipt.receiptRef).toBe(
        await financialSourceReceiptRef({
          registrationRef: REG.registrationRef,
          receiverRef: R,
          targetRef: T,
          eventRef: receipt.eventRef,
          eventDigest: receipt.eventDigest,
          incarnation: receipt.incarnation,
          sequence: receipt.sequence,
          state: receipt.state,
        }),
      );
      expect(receipt.receiptRef).not.toBe(mr.receiptRef);
      expect(await f.receiver().readSourceEventReceipt(receipt.eventRef)).toEqual(receipt);
      await f.base.run(
        "UPDATE financial_source_registrations SET retirement_ref='retirement:one',retired_at=? WHERE registration_ref=?",
        [AT, REG.registrationRef],
      );
      const before = f.clockCalls;
      expect(await f.m().install(cmd)).toEqual(mr);
      expect(f.clockCalls).toBe(before);
      expect(f.db.query("SELECT sequence FROM financial_source_heads").get()).toEqual({
        sequence: 1,
      });
      expect(f.counts()).toEqual([0, 0, 1, 1]);
    } finally {
      f.close();
    }
  });
  test("M can add a second original head only through completed same-provenance registration", async () => {
    const f = await fixture();
    try {
      await f.m().install(await f.command());
      expect(
        await f.m("parent:two", "genesis:two").install(await f.command("parent:two", "two")),
      ).toMatchObject({ commandRef: "command:two" });
      expect(count(f.db, "financial_source_registrations").n).toBe(1);
      expect(count(f.db, "financial_source_heads").n).toBe(2);
      expect(f.counts()).toEqual([0, 0, 2, 2]);
    } finally {
      f.close();
    }
  });
  test("matching manual registration is never adopted as completed M provenance", async () => {
    const f = await fixture();
    try {
      await f.base.run(
        "INSERT INTO financial_source_registrations(registration_ref,incarnation,receiver_ref,target_ref,genesis_digest,registration_digest,registration_json,qualification_ref,registered_at) VALUES(?,?,?,?,?,?,?,?,?)",
        [
          REG.registrationRef,
          REG.incarnation,
          R,
          T,
          G,
          D,
          canonicalFinancialSourceJson(REG),
          Q,
          AT,
        ],
      );
      await expect(f.m().install(await f.command())).rejects.toMatchObject({ code: "conflict" });
      expect(f.counts()).toEqual([0, 0, 0, 0]);
      expect(count(f.db, "financial_source_heads").n).toBe(0);
    } finally {
      f.close();
    }
  });
  test("M original command drift/digest mismatch and same-fullkey concurrent loser cannot replace the winner", async () => {
    const f = await fixture();
    try {
      const one = await f.command(),
        two = {
          ...one,
          commandRef: "command:other",
          materializationRef: "materialization:other",
          receiptRef: "m-receipt:other",
        };
      const race = await Promise.allSettled([f.m().install(one), f.m().install(two)]);
      expect(race.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      expect(f.counts()).toEqual([0, 0, 1, 1]);
      const bad = await f.command("parent:bad", "bad");
      bad.materialization.eventDigest = G;
      await expect(f.m("parent:bad").install(bad)).rejects.toMatchObject({
        code: "invalid_request",
      });
      const other = createFinancialSourceMaterializationStore({
        ...f.common,
        source: { ...f.source, originRef: "origin:other" },
        affectedRef: A,
        genesisQualificationRef: GQ,
      });
      await expect(other.install(one)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      f.close();
    }
  });
  test("actual postcommit M ACK loss recovers original sealed installation without resetting an advanced head", async () => {
    const f = await fixture();
    try {
      const cmd = await f.command();
      f.drop();
      await expect(f.m().install(cmd)).rejects.toMatchObject({ code: "unavailable" });
      expect(f.counts()).toEqual([0, 0, 1, 1]);
      await f.receiver().applySourceEvent(cmd.materialization.event);
      const before = f.clockCalls;
      expect(await f.m().install(cmd)).toMatchObject({ receiptRef: cmd.receiptRef });
      expect(f.clockCalls).toBe(before);
      expect(f.db.query("SELECT sequence FROM financial_source_heads").get()).toEqual({
        sequence: 1,
      });
    } finally {
      f.close();
    }
  });
  test("GET recovery reads the exact committed M after a lost ACK without resending install", async () => {
    const f = await fixture();
    try {
      const cmd = await f.command();
      f.drop();
      await expect(f.m().install(cmd)).rejects.toMatchObject({ code: "unavailable" });
      expect(f.counts()).toEqual([0, 0, 1, 1]);
      const before = {
        batches: f.batchCalls,
        runs: f.runCalls,
        clock: f.clockCalls,
        provider: f.providerRequests,
        queries: f.queryCalls,
        materialization: f.db.query("SELECT * FROM financial_source_materializations").get(),
        receipt: f.db.query("SELECT * FROM financial_source_materialization_receipts").get(),
      };
      expect(await f.m().readOriginal(cmd)).toEqual({
        materializationRef: cmd.materializationRef,
        commandRef: cmd.commandRef,
        receiptRef: cmd.receiptRef,
      });
      expect(f.queryCalls).toBeGreaterThan(before.queries);
      expect(f.batchCalls).toBe(before.batches);
      expect(f.runCalls).toBe(before.runs);
      expect(f.clockCalls).toBe(before.clock);
      expect(f.providerRequests).toBe(before.provider);
      expect(f.db.query("SELECT * FROM financial_source_materializations").get()).toEqual(
        before.materialization,
      );
      expect(f.db.query("SELECT * FROM financial_source_materialization_receipts").get()).toEqual(
        before.receipt,
      );
    } finally {
      f.close();
    }
  });
  test("GET recovery distinguishes complete absence from a conflicting command, vector, source, receiver or genesis", async () => {
    const f = await fixture();
    try {
      const cmd = await f.command();
      expect(await f.m().readOriginal(cmd)).toBeUndefined();
      await f.m().install(cmd);
      const unknown = await f.command("parent:unknown", "unknown");
      expect(await f.m("parent:unknown").readOriginal(unknown)).toBeUndefined();
      await f.m("parent:two", "genesis:two").install(await f.command("parent:two", "two"));
      expect(await f.m("parent:unknown").readOriginal(unknown)).toBeUndefined();
      const alienSibling = createFinancialSourceMaterializationStore({
        ...f.common,
        source: { ...f.source, originRef: "origin:other" },
        affectedRef: "parent:unknown",
        genesisQualificationRef: GQ,
      });
      await expect(alienSibling.readOriginal(unknown)).rejects.toMatchObject({
        code: "unavailable",
      });
      await expect(
        f.m().readOriginal({
          ...cmd,
          materializationRef: "materialization:other",
          commandRef: "command:other",
          receiptRef: "m-receipt:other",
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        f.m().readOriginal({
          ...cmd,
          materialization: { ...cmd.materialization, rawEventDigest: G },
        }),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        f.m().readOriginal({
          ...cmd,
          materialization: { ...cmd.materialization, eventDigest: G },
        }),
      ).rejects.toMatchObject({ code: "invalid_request" });
      await expect(f.m(A, "genesis:other").readOriginal(cmd)).rejects.toMatchObject({
        code: "conflict",
      });
      const otherOrigin = createFinancialSourceMaterializationStore({
        ...f.common,
        source: { ...f.source, originRef: "origin:other" },
        affectedRef: A,
        genesisQualificationRef: GQ,
      });
      await expect(otherOrigin.readOriginal(cmd)).rejects.toMatchObject({ code: "conflict" });
      const otherReceiver = createFinancialSourceMaterializationStore({
        ...f.common,
        receiverRef: "receiver:other",
        targetRef: "target:other",
        source: {
          ...f.source,
          registration: {
            ...REG,
            receivers: [
              ...REG.receivers,
              { receiverRef: "receiver:other", targetRef: "target:other" },
            ],
          },
        },
        affectedRef: A,
        genesisQualificationRef: GQ,
      });
      await expect(otherReceiver.readOriginal(cmd)).rejects.toMatchObject({ code: "conflict" });
    } finally {
      f.close();
    }
  });
  test("GET recovery snapshots command input before its first await and propagates SQL errors", async () => {
    const f = await fixture();
    try {
      const cmd = await f.command();
      await f.m().install(cmd);
      const mutable = structuredClone(cmd);
      const read = f.m().readOriginal(mutable);
      (mutable as { commandRef: string }).commandRef = "command:mutated";
      (mutable.materialization.event as { affectedRef: string }).affectedRef = "parent:mutated";
      expect(await read).toMatchObject({ commandRef: cmd.commandRef, receiptRef: cmd.receiptRef });
      f.failRead();
      await expect(f.m().readOriginal(cmd)).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      f.close();
    }
  });
  test("GET recovery retains the original M after receiver advance, close, retirement, payer loss, epoch rotation and freeze", async () => {
    const f = await fixture();
    try {
      const cmd = await f.command();
      const original = await f.m().install(cmd);
      const advanced = await f.receiver().applySourceEvent(cmd.materialization.event);
      expect(await f.m().readOriginal(cmd)).toEqual(original);
      const closeEvent: FinancialSourceEvent = {
        ...cmd.materialization.event,
        eventRef: "event:close",
        evidenceRef: "evidence:close",
        sequence: 2,
        previousDigest: advanced.eventDigest,
        kind: "close",
      };
      const closingReceiver = createSharedFinancialSourceReceiver({
        ...f.common,
        registration: REG,
        registrationDigest: D,
        qualificationRef: Q,
        evidence: {
          async readImmutableEvent(ref: string) {
            return ref === closeEvent.eventRef
              ? {
                  qualificationRef: Q,
                  receiverRef: R,
                  targetRef: T,
                  genesisQualificationRef: GQ,
                  registration: REG,
                  event: closeEvent,
                }
              : null;
          },
        },
      });
      await closingReceiver.applySourceEvent(closeEvent);
      expect(f.db.query("SELECT sequence,state FROM financial_source_heads").get()).toEqual({
        sequence: 2,
        state: "closed",
      });
      expect(await f.m().readOriginal(cmd)).toEqual(original);
      await f.base.run(
        "UPDATE financial_source_registrations SET retirement_ref='retirement:one',retired_at=? WHERE registration_ref=?",
        [AT, REG.registrationRef],
      );
      await f.base.run("UPDATE money_cutover_authorized_epoch SET writer_epoch=?", [D]);
      await f.base.run(
        "INSERT INTO money_cutover_freeze VALUES(1,'binding','origin','backup','writer','source')",
      );
      withGuardDisabled(f.db, "stripe_billing_account_realms_no_delete", () => {
        f.db.exec("DELETE FROM stripe_billing_account_realms");
      });
      const before = { batches: f.batchCalls, runs: f.runCalls, clock: f.clockCalls };
      expect(await f.m().readOriginal(cmd)).toEqual(original);
      expect(f.batchCalls).toBe(before.batches);
      expect(f.runCalls).toBe(before.runs);
      expect(f.clockCalls).toBe(before.clock);
    } finally {
      f.close();
    }
  });
  for (const scenario of [
    {
      name: "missing receipt",
      code: "unavailable",
      mutate: (db: Database) =>
        withGuardDisabled(db, "financial_source_materialization_receipts_no_delete", () => {
          db.exec("DELETE FROM financial_source_materialization_receipts");
        }),
    },
    {
      name: "receipt tuple mismatch",
      code: "unavailable",
      mutate: (db: Database) =>
        withForeignKeysDisabled(db, () =>
          withGuardDisabled(db, "financial_source_materialization_receipts_no_update", () => {
            db.exec(
              "UPDATE financial_source_materialization_receipts SET registration_ref='registration:other'",
            );
          }),
        ),
    },
    {
      name: "receipt record mismatch",
      code: "unavailable",
      mutate: (db: Database) =>
        withGuardDisabled(db, "financial_source_materialization_receipts_no_update", () => {
          db.exec(
            "UPDATE financial_source_materialization_receipts SET record_json=json_set(record_json,'$.receiptRef','m-receipt:other')",
          );
        }),
    },
    {
      name: "orphan receipt without materialization",
      code: "unavailable",
      mutate: (db: Database) =>
        withForeignKeysDisabled(db, () =>
          withGuardDisabled(db, "financial_source_materializations_no_delete", () => {
            db.exec("DELETE FROM financial_source_materializations");
          }),
        ),
    },
    {
      name: "missing head",
      code: "unavailable",
      mutate: (db: Database) =>
        withForeignKeysDisabled(db, () =>
          withGuardDisabled(db, "financial_source_heads_no_delete", () => {
            db.exec("DELETE FROM financial_source_heads");
          }),
        ),
    },
    {
      name: "head genesis mismatch",
      code: "unavailable",
      mutate: (db: Database) =>
        withGuardDisabled(db, "financial_source_head_advance", () => {
          db.exec("UPDATE financial_source_heads SET genesis_qualification_ref='genesis:other'");
        }),
    },
    {
      name: "missing registration",
      code: "unavailable",
      mutate: (db: Database) =>
        withForeignKeysDisabled(db, () =>
          withGuardDisabled(db, "financial_source_registrations_no_delete", () => {
            db.exec("DELETE FROM financial_source_registrations");
          }),
        ),
    },
    {
      name: "registration genesis mismatch",
      code: "unavailable",
      mutate: (db: Database) =>
        withGuardDisabled(db, "financial_source_registration_retire_only", () => {
          db.exec(`UPDATE financial_source_registrations SET genesis_digest='${D}'`);
        }),
    },
    {
      name: "saved realm mismatch",
      code: "conflict",
      mutate: (db: Database) =>
        withGuardDisabled(db, "financial_source_materializations_no_update", () => {
          db.exec(
            "UPDATE financial_source_materializations SET source_json=json_set(source_json,'$.financialRealm','realm:other')",
          );
        }),
    },
  ] as const)
    test(`GET recovery rejects ${scenario.name} instead of reporting absence`, async () => {
      const f = await fixture();
      try {
        const cmd = await f.command();
        await f.m().install(cmd);
        scenario.mutate(f.db);
        await expect(f.m().readOriginal(cmd)).rejects.toMatchObject({ code: scenario.code });
        if (scenario.name === "orphan receipt without materialization") {
          const before = f.batchCalls;
          await expect(f.m().install(cmd)).rejects.toMatchObject({ code: "unavailable" });
          expect(f.batchCalls).toBe(before);
        }
      } finally {
        f.close();
      }
    });
  test("GET recovery does not call an orphan head complete absence", async () => {
    const f = await fixture();
    try {
      const cmd = await f.command();
      await f.m().install(cmd);
      withForeignKeysDisabled(f.db, () => {
        withGuardDisabled(f.db, "financial_source_materialization_receipts_no_delete", () => {
          f.db.exec("DELETE FROM financial_source_materialization_receipts");
        });
        withGuardDisabled(f.db, "financial_source_materializations_no_delete", () => {
          f.db.exec("DELETE FROM financial_source_materializations");
        });
      });
      expect(f.counts()).toEqual([0, 0, 0, 0]);
      expect(count(f.db, "financial_source_heads").n).toBe(1);
      await expect(f.m().readOriginal(cmd)).rejects.toMatchObject({ code: "unavailable" });
    } finally {
      f.close();
    }
  });
  test("GET recovery does not treat a manual registration as completed M provenance", async () => {
    const f = await fixture();
    try {
      await f.base.run(
        "INSERT INTO financial_source_registrations(registration_ref,incarnation,receiver_ref,target_ref,genesis_digest,registration_digest,registration_json,qualification_ref,registered_at) VALUES(?,?,?,?,?,?,?,?,?)",
        [
          REG.registrationRef,
          REG.incarnation,
          R,
          T,
          G,
          D,
          canonicalFinancialSourceJson(REG),
          Q,
          AT,
        ],
      );
      expect(f.counts()).toEqual([0, 0, 0, 0]);
      await expect(f.m().readOriginal(await f.command())).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      f.close();
    }
  });
  test("GET recovery requires a sibling M's immutable head birth before reporting absence", async () => {
    const f = await fixture();
    try {
      await f.m().install(await f.command());
      const unknown = await f.command("parent:unknown", "unknown");
      expect(await f.m("parent:unknown").readOriginal(unknown)).toBeUndefined();
      withGuardDisabled(f.db, "financial_source_head_advance", () => {
        f.db.exec(
          "UPDATE financial_source_heads SET created_at='2026-10-14T23:59:59.000Z' WHERE affected_ref='parent:one'",
        );
      });
      await expect(f.m("parent:unknown").readOriginal(unknown)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      f.close();
    }
  });
  for (const fault of ["zero", "null", "late"] as const)
    test(`M ${fault} final failure rolls back root, registration, head and receipt`, async () => {
      const f = await fixture();
      try {
        f.fault((s) => {
          if (fault === "late")
            f.db.exec(
              "CREATE TRIGGER injected_m_late BEFORE INSERT ON financial_source_materialization_receipts BEGIN SELECT RAISE(ABORT,'constraint: injected M late failure'); END",
            );
          return s.map((x, i) =>
            i === 2 && fault === "zero"
              ? { ...x, sql: x.sql.replace(" WHERE ", " WHERE NULL AND ") }
              : i === 3 && fault === "null"
                ? {
                    ...x,
                    sql: x.sql.replace(/CASE WHEN[\s\S]+THEN 1 ELSE 0 END/u, "NULL"),
                    params: x.params?.slice(0, 7) ?? [],
                  }
                : x,
          );
        });
        await expect(f.m().install(await f.command())).rejects.toMatchObject({ code: "conflict" });
        expect(f.counts()).toEqual([0, 0, 0, 0]);
        expect(count(f.db, "financial_source_registrations").n).toBe(0);
        expect(count(f.db, "financial_source_heads").n).toBe(0);
        if (fault === "late") expect(f.failures[0]).toContain("injected M late failure");
      } finally {
        f.close();
      }
    });
  test("whole schema and canonical receiver pins fail closed, and SQL errors never become absence", async () => {
    const f = await fixture();
    try {
      f.failRead();
      await expect(f.c0().readChallenge("challenge:absent")).rejects.toMatchObject({
        code: "unavailable",
      });
      f.db.exec("DROP TRIGGER financial_source_heads_no_replace");
      await expect(f.m().install(await f.command())).rejects.toMatchObject({ code: "unavailable" });
      expect(f.counts()).toEqual([0, 0, 0, 0]);
      f.db.exec("DROP TRIGGER financial_preproof_challenges_no_update");
      await expect(f.c0().prepare(f.preparation())).rejects.toMatchObject({ code: "unavailable" });
      expect(f.counts()).toEqual([0, 0, 0, 0]);
    } finally {
      f.close();
    }
  });
  test("private DDL is the exact exported component schema and no orphan prefix is acknowledged", async () => {
    const f = await fixture();
    try {
      const file = readFileSync(
        new URL(
          "./fixtures/shared-financial-source-enrollment-component-schema.sql",
          import.meta.url,
        ),
        "utf8",
      );
      expect(file.split("\n").slice(1).join("\n")).toBe(FINANCIAL_SOURCE_ENROLLMENT_DDL);
      const p = f.preparation();
      await f.c0().prepare(p);
      const row = f.db.query("SELECT * FROM financial_preproof_challenges").get() as Record<
        string,
        unknown
      >;
      expect(row.challenge_json).toBe(canonicalFinancialSourceJson(p.challenge));
      f.db.exec("DROP TRIGGER financial_preproof_challenge_receipts_no_delete");
      f.db.exec("DELETE FROM financial_preproof_challenge_receipts");
      // Restore the exact original trigger so readiness succeeds; the root alone must still fail historical custody.
      const original = FINANCIAL_SOURCE_ENROLLMENT_DDL.match(
        /CREATE TRIGGER financial_preproof_challenge_receipts_no_delete[\s\S]*?END;/u,
      )?.[0];
      if (!original) throw Error("missing original trigger");
      f.db.exec(original);
      await expect(f.c0().readChallenge(p.challenge.challengeRef)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      f.close();
    }
  });
  test("a current primary fence revoked at allocation time rolls back both independent phases", async () => {
    const f = await fixture();
    try {
      // Freeze, permit and epoch are the exact Financial 0104 fences inside the
      // actual permit-framed Money writer; neither predicate names them.
      installFinancial0104Fences(f.db, { receiver: true, c0: true, genesisOverlay: true });
      const { money, realm } = await financial0104Writer(f.sql, W, f.common.client, {
        accountId: "acct_enrollment",
        billingAuthority: "enrollment",
        priceId: "price_enrollment",
      });
      const fenced = { ...f.common, sql: money, realm };
      const c0 = () => createFinancialPreproofChallengeStore({ ...fenced, scope: SCOPE });
      const m = () =>
        createFinancialSourceMaterializationStore({
          ...fenced,
          source: f.source,
          affectedRef: A,
          genesisQualificationRef: GQ,
        });
      for (const phase of ["c0", "m"] as const) {
        const attempt = async () =>
          phase === "c0" ? c0().prepare(f.preparation()) : m().install(await f.command());
        f.fault((s) => {
          f.db.exec(MONEY_FREEZE_ROW);
          return s;
        });
        await expect(attempt()).rejects.toMatchObject({ code: "conflict" });
        expect(f.counts()).toEqual([0, 0, 0, 0]);
        f.db.exec("DELETE FROM money_cutover_freeze");
        f.fault((s) => {
          f.db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(D);
          return s;
        });
        await expect(attempt()).rejects.toMatchObject({ code: "conflict" });
        expect(f.counts()).toEqual([0, 0, 0, 0]);
        f.db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(W);
        f.fault(undefined);
        expect(count(f.db, "financial_source_heads").n).toBe(0);
        expect(count(f.db, "financial_source_registrations").n).toBe(0);
        expect(count(f.db, "money_cutover_writer_permit").n).toBe(0);
      }
      // Outside the permit frame the same batches are refused by the fences.
      await expect(f.c0().prepare(f.preparation())).rejects.toMatchObject({ code: "conflict" });
      await expect(f.m().install(await f.command())).rejects.toMatchObject({ code: "conflict" });
      expect(f.counts()).toEqual([0, 0, 0, 0]);
      expect(count(f.db, "financial_source_heads").n).toBe(0);
      // A current permit under a foreign epoch is refused: each row keeps its own.
      f.db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(D);
      const foreign = await financial0104Writer(f.sql, D, f.common.client, {
        accountId: "acct_enrollment",
        billingAuthority: "enrollment",
        priceId: "price_enrollment",
      });
      const foreignOptions = { ...f.common, sql: foreign.money, realm: foreign.realm };
      await expect(
        createFinancialPreproofChallengeStore({ ...foreignOptions, scope: SCOPE }).prepare(
          f.preparation(),
        ),
      ).rejects.toMatchObject({ code: "conflict" });
      await expect(
        createFinancialSourceMaterializationStore({
          ...foreignOptions,
          source: f.source,
          affectedRef: A,
          genesisQualificationRef: GQ,
        }).install(await f.command()),
      ).rejects.toMatchObject({ code: "conflict" });
      expect(f.counts()).toEqual([0, 0, 0, 0]);
      expect(count(f.db, "financial_source_heads").n).toBe(0);
      f.db.query("UPDATE money_cutover_authorized_epoch SET writer_epoch=?").run(W);
      // Inside the actual writer with the authorized epoch both commit.
      expect(await c0().prepare(f.preparation())).toMatchObject({ challengeRef: "challenge:one" });
      expect(await m().install(await f.command())).toMatchObject({
        materializationRef: "materialization:one",
      });
      expect(f.counts()).toEqual([1, 1, 1, 1]);
      expect(count(f.db, "financial_source_heads").n).toBe(1);
      expect(count(f.db, "financial_source_registrations").n).toBe(1);
      expect(count(f.db, "money_cutover_writer_permit").n).toBe(0);
      // Each fenced statement passes the writer unchanged.
      for (const batch of f.batches.slice(-2))
        for (const statement of batch.slice(1, -1))
          expect(statement.sql).not.toMatch(/\bmoney_cutover_/u);
    } finally {
      f.close();
    }
  });
  test("fixed C0/M batches have exactly matching binds, bounded by actual D1's 100 parameter limit", async () => {
    const f = await fixture();
    try {
      await f.c0().prepare(f.preparation());
      await f.m().install(await f.command());
      expect(f.batches.map((b) => b.length)).toEqual([2, 4]);
      for (const batch of f.batches)
        for (const statement of batch) {
          expect(statement.sql.match(/\?/gu)?.length ?? 0).toBe(statement.params?.length ?? 0);
          expect(statement.params?.length ?? 0).toBeLessThanOrEqual(100);
        }
    } finally {
      f.close();
    }
  });
  test("each PK/UNIQUE replacement guard independently protects childless rows with recursive triggers off", async () => {
    const f = await fixture();
    try {
      await f.c0().prepare(f.preparation());
      await f.m().install(await f.command());
      let checked = 0;
      for (const table of TABLES) {
        const original = f.db.query(`SELECT * FROM ${table}`).get() as Record<
          string,
          string | number | null
        >;
        // This is a narrow DDL primitive test, not a source-readiness or authority fixture.
        // Remove other BEFORE checks to prove every no_replace disjunct itself, rather
        // than accepting a rejection caused by unrelated JSON/FK constraints.
        const db = new Database(":memory:");
        try {
          db.exec(FINANCIAL_SOURCE_ENROLLMENT_DDL);
          db.exec("PRAGMA foreign_keys=OFF; PRAGMA recursive_triggers=OFF");
          const triggers = db
            .query("SELECT name FROM sqlite_schema WHERE type='trigger'")
            .all() as { name: string }[];
          for (const t of triggers)
            if (!/_no_(replace|update|delete)$/u.test(t.name)) db.exec(`DROP TRIGGER ${t.name}`);
          const columns = Object.keys(original),
            insert = `INSERT INTO ${table}(${columns.join(",")}) VALUES(${columns.map(() => "?").join(",")})`;
          db.query(insert).run(...Object.values(original));
          const indexes = db.query(`PRAGMA index_list(${table})`).all() as {
            name: string;
            unique: number;
          }[];
          const uniqueKeys = indexes
            .filter((i) => i.unique === 1)
            .map((i) =>
              (db.query(`PRAGMA index_info(${i.name})`).all() as { name: string }[]).map(
                (c) => c.name,
              ),
            );
          for (const [n, key] of uniqueKeys.entries()) {
            const candidate = { ...original };
            for (const other of uniqueKeys.flat())
              if (!key.includes(other))
                candidate[other] = `${String(original[other])}:replacement-${n}`;
            expect(() =>
              db
                .query(insert.replace("INSERT INTO", "INSERT OR REPLACE INTO"))
                .run(...columns.map((c) => candidate[c] ?? null)),
            ).toThrow("constraint: immutable enrollment replacement");
            expect(db.query(`SELECT * FROM ${table}`).all()).toEqual([original]);
            checked++;
          }
          expect(() => db.exec(`UPDATE ${table} SET record_json=record_json`)).toThrow(
            "constraint: immutable enrollment original",
          );
          expect(() => db.exec(`DELETE FROM ${table}`)).toThrow(
            "constraint: immutable enrollment original",
          );
        } finally {
          db.close();
        }
      }
      expect(checked).toBe(11);
    } finally {
      f.close();
    }
  });
});

// Mechanical same-primary fixtures only. These originals do not prove a Core
// producer, registration authority, payer permission, native D1 or a qualified G.
type EnrollmentFixture = Awaited<ReturnType<typeof fixture>>;
function readEffects(f: EnrollmentFixture) {
  const genesisTables = [
    "financial_source_genesis_admissions",
    "financial_source_genesis_admission_receipts",
  ].filter((table) =>
    f.db.query("SELECT 1 FROM sqlite_schema WHERE type='table' AND name=?").get(table),
  );
  return {
    batches: f.batchCalls,
    runs: f.runCalls,
    clocks: f.clockCalls,
    provider: f.providerRequests,
    rows: [
      ...TABLES,
      "financial_source_registrations",
      "financial_source_heads",
      "financial_source_events",
      "financial_source_receipts",
      ...genesisTables,
    ].map((table) => JSON.stringify(f.db.query(`SELECT * FROM ${table} ORDER BY 1`).all())),
  };
}
function mechanicalGenesis(f: EnrollmentFixture) {
  const workspace = { id: A, createdAt: AT };
  const binding = {
    workspaceId: A,
    organizationRef: SCOPE.organizationId,
    workspaceRef: SCOPE.workspaceRef,
    intentId: "intent:mechanical-genesis",
  };
  const registration = {
    sourceRef: REG.registrationRef,
    incarnation: REG.incarnation,
    genesisDigest: G.slice("sha256:".length),
    requiredReceivers: REG.receivers,
  };
  const command: FinancialControlGenesisCommand = {
    admissionRef: "g-admission:mechanical",
    commandRef: "g-command:mechanical",
    receiptRef: "g-receipt:mechanical",
    enrollmentOriginal: {
      workspaceId: A,
      sourceRef: REG.registrationRef,
      incarnation: REG.incarnation,
      registrationJson: JSON.stringify(registration),
      enrollmentJson: JSON.stringify({
        workspace,
        management: {},
        binding,
        members: [{ ref: "member:mechanical" }],
      }),
      identityJson: JSON.stringify({
        ...registration,
        workspaceId: A,
        workspaceCreatedAt: AT,
        organizationRef: binding.organizationRef,
        workspaceRef: binding.workspaceRef,
        bindingIntentId: binding.intentId,
        bindingJson: JSON.stringify(binding),
        enrolledAt: AT,
      }),
      enrolledAt: AT,
    },
  };
  return {
    command,
    store: createFinancialControlGenesisAdmissionStore({
      ...f.common,
      source: f.source,
      affectedRef: A,
      genesisQualificationRef: GQ,
    }),
  };
}
async function otherMaterialization(f: EnrollmentFixture) {
  const registration = {
    ...REG,
    registrationRef: "registration:other-overlay",
    incarnation: "incarnation:other-overlay",
  };
  const originalEvent: FinancialSourceEvent = {
    ...event(),
    registrationRef: registration.registrationRef,
    incarnation: registration.incarnation,
  };
  return {
    store: createFinancialSourceMaterializationStore({
      ...f.common,
      source: { ...f.source, registration },
      affectedRef: A,
      genesisQualificationRef: GQ,
    }),
    command: {
      materializationRef: "materialization:other-overlay",
      commandRef: "command:other-overlay",
      receiptRef: "m-receipt:other-overlay",
      materialization: {
        rawEventDigest: D,
        event: originalEvent,
        eventDigest: await financialSourceEventDigest(originalEvent),
      },
    },
  };
}
async function rejectsUnreadySchema(f: EnrollmentFixture) {
  const retained = await f.command();
  const absent = await f.command("parent:absent-schema", "absent-schema");
  const before = readEffects(f);
  await expect(f.c0().prepare(f.preparation("absent-schema"))).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(f.c0().readChallenge("challenge:one")).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(f.c0().readChallenge("challenge:absent-schema")).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(f.m().readOriginal(retained)).rejects.toMatchObject({ code: "unavailable" });
  await expect(f.m("parent:absent-schema").readOriginal(absent)).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(f.m("parent:absent-schema").install(absent)).rejects.toMatchObject({
    code: "unavailable",
  });
  expect(readEffects(f)).toEqual(before);
}

describe("legacy C0/M floor and exact complete G overlay readiness", () => {
  for (const overlay of [false, true]) {
    test(`${overlay ? "complete G" : "exact no-G legacy"}: C0/M retain originals, query budgets and GET-only unknowns`, async () => {
      const f = await fixture();
      try {
        if (overlay) f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
        expect(
          f.db
            .query(
              "SELECT name FROM sqlite_schema WHERE type='table' AND name IN ('financial_source_genesis_admissions','financial_source_genesis_admission_receipts')",
            )
            .all(),
        ).toHaveLength(overlay ? 2 : 0);
        const preparation = f.preparation();
        await f.c0().prepare(preparation);
        let effects = readEffects(f);
        expect(await f.c0().readChallenge(preparation.challenge.challengeRef)).toEqual(
          preparation.challenge,
        );
        expect(
          Object.keys((await f.c0().readChallenge(preparation.challenge.challengeRef)) ?? {}),
        ).toHaveLength(10);
        expect(await f.c0().readChallenge("challenge:absent-legacy")).toBeUndefined();
        expect(readEffects(f)).toEqual(effects);
        const command = await f.command();
        const extraRead = overlay ? 1 : 0;
        let queries = f.queryCalls;
        effects = readEffects(f);
        expect(await f.m().readOriginal(command)).toBeUndefined();
        expect(f.queryCalls - queries).toBe(6 + extraRead);
        expect(readEffects(f)).toEqual(effects);
        const receipt = await f.m().install(command);
        expect(receipt).toEqual({
          materializationRef: command.materializationRef,
          commandRef: command.commandRef,
          receiptRef: command.receiptRef,
        });
        queries = f.queryCalls;
        effects = readEffects(f);
        expect(await f.m().readOriginal(command)).toEqual(receipt);
        expect(f.queryCalls - queries).toBe(4);
        expect(readEffects(f)).toEqual(effects);
        const sibling = await f.command("parent:second-schema", "second-schema");
        queries = f.queryCalls;
        expect(await f.m("parent:second-schema").readOriginal(sibling)).toBeUndefined();
        expect(f.queryCalls - queries).toBe(7 + extraRead);
        expect(readEffects(f)).toEqual(effects);
        f.failRead();
        await expect(f.m().readOriginal(command)).rejects.toMatchObject({ code: "unavailable" });
        expect(readEffects(f)).toEqual(effects);
        f.failRead();
        await expect(
          f.c0().readChallenge(preparation.challenge.challengeRef),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect(readEffects(f)).toEqual(effects);
      } finally {
        f.close();
      }
    });
  }

  test("G itself still requires the complete overlay and its original reader remains coherent", async () => {
    const f = await fixture();
    try {
      const g = mechanicalGenesis(f);
      const before = readEffects(f);
      await expect(g.store.readGenesisOriginal(g.command)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(readEffects(f)).toEqual(before);
      f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
      expect(await g.store.readGenesisOriginal(g.command)).toBeUndefined();
      const receipt = await g.store.admitGenesis(g.command);
      expect(receipt).toEqual({
        admissionRef: g.command.admissionRef,
        commandRef: g.command.commandRef,
        receiptRef: g.command.receiptRef,
      });
      const effects = readEffects(f);
      expect(await g.store.readGenesisOriginal(g.command)).toEqual(receipt);
      expect(readEffects(f)).toEqual(effects);
      const sibling = await f.command("parent:another-G-key", "another-G-key");
      await expect(f.m("parent:another-G-key").readOriginal(sibling)).rejects.toMatchObject({
        code: "unavailable",
      });
      await expect(f.m("parent:another-G-key").install(sibling)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(readEffects(f)).toEqual(effects);
    } finally {
      f.close();
    }
  });

  const collisionGuards = [
    "financial_source_genesis_admissions_no_replace",
    "financial_source_genesis_admission_receipts_no_replace",
    "financial_source_materializations_no_genesis_collision",
    "financial_source_materialization_receipts_no_genesis_collision",
  ] as const;
  for (const name of collisionGuards) {
    for (const fault of ["missing", "corrupt"] as const) {
      test(`${name} ${fault}: neither effect, retained GET nor positive absence is permitted`, async () => {
        const f = await fixture();
        try {
          f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
          await f.c0().prepare(f.preparation());
          await f.m().install(await f.command());
          f.db.exec(`DROP TRIGGER ${name}`);
          if (fault === "corrupt") {
            const original = FINANCIAL_GENESIS_SCHEMA[name];
            if (!original) throw Error("missing fixed collision guard");
            const broken = original.replace(/RAISE\(ABORT,'[^']*'\)/u, "1");
            expect(broken).not.toBe(original);
            f.db.exec(broken);
          }
          await rejectsUnreadySchema(f);
        } finally {
          f.close();
        }
      });
    }
  }

  const partialOverlays: readonly {
    readonly name: string;
    readonly mutate: (f: EnrollmentFixture) => void;
  }[] = [
    {
      name: "G tables only",
      mutate(f) {
        for (const name of [
          "financial_source_genesis_admissions",
          "financial_source_genesis_admission_receipts",
        ]) {
          const sql = FINANCIAL_GENESIS_SCHEMA[name];
          if (!sql) throw Error("missing fixed G table");
          f.db.exec(sql);
        }
      },
    },
    {
      name: "M collision guards without G tables",
      mutate(f) {
        for (const name of collisionGuards.slice(2)) {
          const sql = FINANCIAL_GENESIS_SCHEMA[name];
          if (!sql) throw Error("missing fixed M/G guard");
          f.db.exec(sql);
        }
      },
    },
    {
      name: "missing G original table",
      mutate(f) {
        f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
        f.db.exec("DROP TABLE financial_source_genesis_admissions");
      },
    },
    {
      name: "missing G receipt table",
      mutate(f) {
        f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
        f.db.exec("DROP TABLE financial_source_genesis_admission_receipts");
      },
    },
    {
      name: "renamed G original table",
      mutate(f) {
        f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
        f.db.exec(
          "ALTER TABLE financial_source_genesis_admissions RENAME TO renamed_overlay_original",
        );
      },
    },
    {
      name: "unknown G namespace object on legacy schema",
      mutate(f) {
        f.db.exec("CREATE TABLE financial_source_genesis_unknown_overlay(ref TEXT)");
      },
    },
    {
      name: "unexpected G trigger on a complete overlay",
      mutate(f) {
        f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
        f.db.exec(
          "CREATE TRIGGER financial_source_genesis_unknown_guard BEFORE INSERT ON financial_preproof_challenges BEGIN SELECT 1; END",
        );
      },
    },
  ];
  for (const scenario of partialOverlays) {
    test(`${scenario.name}: partial or unknown G is never legacy`, async () => {
      const f = await fixture();
      try {
        await f.c0().prepare(f.preparation());
        await f.m().install(await f.command());
        scenario.mutate(f);
        await rejectsUnreadySchema(f);
      } finally {
        f.close();
      }
    });
  }

  test("complete G occupies both command/receipt roles even for another M source incarnation", async () => {
    const f = await fixture();
    try {
      f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
      const g = mechanicalGenesis(f);
      await g.store.admitGenesis(g.command);
      const m = await otherMaterialization(f);
      for (const candidate of [
        { ...m.command, commandRef: g.command.commandRef },
        { ...m.command, commandRef: g.command.receiptRef },
        { ...m.command, receiptRef: g.command.commandRef },
        { ...m.command, receiptRef: g.command.receiptRef },
      ]) {
        const before = readEffects(f);
        await expect(m.store.readOriginal(candidate)).rejects.toMatchObject({
          code: "unavailable",
        });
        await expect(m.store.install(candidate)).rejects.toMatchObject({ code: "unavailable" });
        expect(readEffects(f)).toEqual(before);
      }
    } finally {
      f.close();
    }
  });

  for (const orphan of ["original-only", "receipt-only"] as const) {
    test(`complete schema with ${orphan} G cannot manufacture M positive absence`, async () => {
      const f = await fixture();
      try {
        f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
        const g = mechanicalGenesis(f);
        await g.store.admitGenesis(g.command);
        if (orphan === "original-only") {
          withGuardDisabled(f.db, "financial_source_genesis_admission_receipts_no_delete", () => {
            f.db.exec("DELETE FROM financial_source_genesis_admission_receipts");
          });
        } else {
          withForeignKeysDisabled(f.db, () => {
            withGuardDisabled(f.db, "financial_source_genesis_admissions_no_delete", () => {
              f.db.exec("DELETE FROM financial_source_genesis_admissions");
            });
          });
        }
        expect(count(f.db, "financial_source_genesis_admissions").n).toBe(
          orphan === "original-only" ? 1 : 0,
        );
        expect(count(f.db, "financial_source_genesis_admission_receipts").n).toBe(
          orphan === "receipt-only" ? 1 : 0,
        );
        const m = await otherMaterialization(f);
        const candidate = {
          ...m.command,
          commandRef: g.command.commandRef,
          receiptRef: g.command.receiptRef,
        };
        const before = readEffects(f);
        await expect(m.store.readOriginal(candidate)).rejects.toMatchObject({
          code: "unavailable",
        });
        await expect(m.store.install(candidate)).rejects.toMatchObject({ code: "unavailable" });
        expect(readEffects(f)).toEqual(before);
      } finally {
        f.close();
      }
    });
  }

  test("unknown, malformed or ambiguous full-G lookup never becomes M absence or a write", async () => {
    for (const fault of [
      "throw",
      "missing-row",
      "null-result",
      "string-zero",
      "duplicate-row",
    ] as const) {
      const f = await fixture();
      try {
        f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
        const command = await f.command();
        const before = readEffects(f);
        const query = f.sql.query;
        let lookups = 0;
        f.sql.query = async (sql, params) => {
          if (sql.startsWith("SELECT EXISTS(SELECT 1 FROM financial_source_genesis_admissions")) {
            lookups++;
            if (fault === "throw") throw new SqlError("unavailable", "unknown G read");
            if (fault === "missing-row") return [];
            if (fault === "null-result") return [{ original_occupied: 0, receipt_occupied: null }];
            if (fault === "string-zero") return [{ original_occupied: "0", receipt_occupied: 0 }];
            return [
              { original_occupied: 0, receipt_occupied: 0 },
              { original_occupied: 0, receipt_occupied: 0 },
            ];
          }
          return query(sql, params);
        };
        await expect(f.m().readOriginal(command)).rejects.toMatchObject({ code: "unavailable" });
        await expect(f.m().install(command)).rejects.toMatchObject({ code: "unavailable" });
        expect(lookups).toBe(2);
        expect(readEffects(f)).toEqual(before);
      } finally {
        f.close();
      }
    }
  });

  test("completed M history survives a later valid G cross-role receipt reservation", async () => {
    const f = await fixture();
    try {
      f.db.exec(FINANCIAL_SOURCE_GENESIS_DDL);
      const command = await f.command();
      const receipt = await f.m().install(command);
      expect(receipt).toEqual({
        materializationRef: command.materializationRef,
        commandRef: command.commandRef,
        receiptRef: command.receiptRef,
      });
      const seed = mechanicalGenesis(f);
      const registration: FinancialSourceRegistration = {
        ...REG,
        registrationRef: "registration:history-G",
        incarnation: "incarnation:history-G",
      };
      const coreRegistration = {
        sourceRef: registration.registrationRef,
        incarnation: registration.incarnation,
        genesisDigest: G.slice("sha256:".length),
        requiredReceivers: registration.receivers,
      };
      const binding = {
        workspaceId: A,
        organizationRef: SCOPE.organizationId,
        workspaceRef: SCOPE.workspaceRef,
        intentId: "intent:mechanical-genesis",
      };
      const gCommand: FinancialControlGenesisCommand = {
        admissionRef: "g-admission:history-G",
        commandRef: "g-command:history-G",
        receiptRef: command.commandRef,
        enrollmentOriginal: {
          ...seed.command.enrollmentOriginal,
          sourceRef: registration.registrationRef,
          incarnation: registration.incarnation,
          registrationJson: JSON.stringify(coreRegistration),
          identityJson: JSON.stringify({
            ...coreRegistration,
            workspaceId: A,
            workspaceCreatedAt: AT,
            organizationRef: binding.organizationRef,
            workspaceRef: binding.workspaceRef,
            bindingIntentId: binding.intentId,
            bindingJson: JSON.stringify(binding),
            enrolledAt: AT,
          }),
        },
      };
      expect(registration.registrationRef).not.toBe(REG.registrationRef);
      expect(registration.incarnation).not.toBe(REG.incarnation);
      expect(new Set([command.commandRef, command.receiptRef, gCommand.commandRef]).size).toBe(3);
      expect(gCommand.commandRef).not.toBe(command.commandRef);
      expect(gCommand.receiptRef).toBe(command.commandRef);
      expect(gCommand.receiptRef).not.toBe(command.receiptRef);
      const g = createFinancialControlGenesisAdmissionStore({
        ...f.common,
        source: { ...f.source, registration },
        affectedRef: A,
        genesisQualificationRef: GQ,
      });
      const gReceipt = await g.admitGenesis(gCommand);
      expect(gReceipt).toEqual({
        admissionRef: gCommand.admissionRef,
        commandRef: gCommand.commandRef,
        receiptRef: gCommand.receiptRef,
      });
      expect(await g.readGenesisOriginal(gCommand)).toEqual(gReceipt);
      expect(f.batchCalls).toBe(2);
      expect(
        f.db
          .query(`SELECT m.command_ref,q.receipt_ref,q.all_rows_match,
          m.record_json=q.record_json AS record_matches
          FROM financial_source_materializations m
          JOIN financial_source_materialization_receipts q ON q.materialization_ref=m.materialization_ref
          WHERE m.materialization_ref=? AND q.command_ref=m.command_ref`)
          .all(command.materializationRef),
      ).toEqual([
        {
          command_ref: command.commandRef,
          receipt_ref: command.receiptRef,
          all_rows_match: 1,
          record_matches: 1,
        },
      ]);
      expect(
        f.db
          .query(`SELECT g.command_ref,q.receipt_ref,q.all_rows_match,
          g.record_json=q.record_json AS record_matches
          FROM financial_source_genesis_admissions g
          JOIN financial_source_genesis_admission_receipts q ON q.admission_ref=g.admission_ref
          WHERE g.admission_ref=? AND q.command_ref=g.command_ref`)
          .all(gCommand.admissionRef),
      ).toEqual([
        {
          command_ref: gCommand.commandRef,
          receipt_ref: gCommand.receiptRef,
          all_rows_match: 1,
          record_matches: 1,
        },
      ]);
      const effects = readEffects(f);
      let queries = f.queryCalls;
      expect(await f.m().readOriginal(command)).toEqual(receipt);
      expect(f.queryCalls - queries).toBe(4);
      expect(readEffects(f)).toEqual(effects);
      queries = f.queryCalls;
      // Normal known-ACK original replay only. Unknown outcomes use readOriginal;
      // undefined never grants install or retry permission.
      expect(await f.m().install(command)).toEqual(receipt);
      expect(f.queryCalls - queries).toBe(4);
      expect(readEffects(f)).toEqual(effects);
    } finally {
      f.close();
    }
  });
});

// Mechanical fixed SQL contribution only; not native primary/Root or genuine issuer qualification.
describe("fixed C0 builder contribution", () => {
  test("builds two detached statements without SQL, Clock, provider or write effects", async () => {
    const f = await fixture();
    try {
      const store = f.c0(),
        input = f.preparation("builder-pure");
      const before = [f.queryCalls, f.runCalls, f.batchCalls, f.clockCalls, f.providerRequests];
      const statements = store.buildPreparationBatch(input, AT),
        original = structuredClone(statements);
      expect(statements).toHaveLength(2);
      expect(statements[0]?.sql).toContain("INSERT INTO financial_preproof_challenges");
      expect(statements[1]?.sql).toContain("INSERT INTO financial_preproof_challenge_receipts");
      expect(statements[1]?.sql).toContain("CASE WHEN changes()=1");
      Object.assign(input.challenge, { challengeRef: "challenge:caller-changed" });
      Object.assign(input.selection.action, { body: { email: "changed@example.invalid" } });
      expect(statements).toEqual(original);
      expect([f.queryCalls, f.runCalls, f.batchCalls, f.clockCalls, f.providerRequests]).toEqual(
        before,
      );
      expect(f.counts()).toEqual([0, 0, 0, 0]);
    } finally {
      f.close();
    }
  });

  test("actual prepare uses the identical fixed SQL and params, then replay reads without another Clock or batch", async () => {
    const f = await fixture();
    try {
      const store = f.c0(),
        input = f.preparation("builder-prepare");
      const statements = store.buildPreparationBatch(input, AT),
        clocks = f.clockCalls,
        batches = f.batchCalls;
      const receipt = await store.prepare(input);
      expect(f.batches.at(-1)).toEqual(statements);
      expect(f.batchCalls).toBe(batches + 1);
      expect(f.clockCalls).toBe(clocks + 1);
      expect(receipt).toEqual({
        preparationRef: input.preparationRef,
        challengeRef: input.challenge.challengeRef,
        receiptRef: input.receiptRef,
      });
      expect(f.counts()).toEqual([1, 1, 0, 0]);
      expect(await store.prepare(input)).toEqual(receipt);
      expect(f.batchCalls).toBe(batches + 1);
      expect(f.clockCalls).toBe(clocks + 1);
    } finally {
      f.close();
    }
  });

  test("closed input/getter and malformed observedAt reject without invoking the getter, SQL or Clock", async () => {
    const f = await fixture();
    try {
      const store = f.c0(),
        input = f.preparation("builder-closed");
      let getters = 0;
      const before = [f.queryCalls, f.runCalls, f.batchCalls, f.clockCalls, f.providerRequests];
      Object.defineProperty(input.selection.terms, "digest", {
        enumerable: true,
        get() {
          getters++;
          return D;
        },
      });
      expect(() => store.buildPreparationBatch(input, AT)).toThrow();
      expect(() =>
        store.buildPreparationBatch(f.preparation("builder-date"), "not-an-ISO-instant"),
      ).toThrow();
      const foreign = f.preparation("builder-foreign");
      Object.assign(foreign.challenge, { organizationId: "org:other" });
      expect(() => store.buildPreparationBatch(foreign, AT)).toThrow();
      expect(getters).toBe(0);
      expect([f.queryCalls, f.runCalls, f.batchCalls, f.clockCalls, f.providerRequests]).toEqual(
        before,
      );
      expect(f.counts()).toEqual([0, 0, 0, 0]);
    } finally {
      f.close();
    }
  });

  test("prepare still captures its entire original before the first readiness await", async () => {
    const f = await fixture();
    try {
      const store = f.c0(),
        input = f.preparation("builder-before-await");
      const statements = store.buildPreparationBatch(input, AT);
      const pending = store.prepare(input);
      Object.assign(input.challenge, {
        requestFingerprint: G,
        challengeRef: "challenge:after-await",
      });
      Object.assign(input.selection.action, { body: { changed: true } });
      await pending;
      expect(f.batches.at(-1)).toEqual(statements);
      expect(await store.readChallenge("challenge:builder-before-await")).toMatchObject({
        requestFingerprint: D,
      });
      expect(await store.readChallenge("challenge:after-await")).toBeUndefined();
    } finally {
      f.close();
    }
  });

  test("one exact positive batch precedes a later SQL failure that rolls back both new C0 rows", async () => {
    const f = await fixture();
    try {
      const store = f.c0(),
        positive = store.buildPreparationBatch(f.preparation("builder-positive"), AT);
      expect(await f.base.batch(positive)).toHaveLength(2);
      expect(f.counts()).toEqual([1, 1, 0, 0]);
      const late = store.buildPreparationBatch(f.preparation("builder-late"), AT);
      // Explicit in-memory late-failure transport fixture, never part of the fixed producer contribution.
      await expect(
        f.base.batch([...late, { sql: "SELECT * FROM missing_c0_builder_late_fixture" }]),
      ).rejects.toBeInstanceOf(SqlError);
      expect(f.counts()).toEqual([1, 1, 0, 0]);
      expect(await store.readChallenge("challenge:builder-late")).toBeUndefined();
    } finally {
      f.close();
    }
  });

  test("a mandatory receipt mismatch after its original rolls back the pair while the positive pair survives", async () => {
    const f = await fixture();
    try {
      const store = f.c0();
      await f.base.batch(
        store.buildPreparationBatch(f.preparation("builder-receipt-positive"), AT),
      );
      expect(f.counts()).toEqual([1, 1, 0, 0]);
      const statements = store.buildPreparationBatch(f.preparation("builder-receipt-bad"), AT);
      const [original, receipt] = statements;
      if (!original || !receipt?.params) throw Error("fixed C0 pair missing");
      const mismatched = {
        ...receipt,
        params: receipt.params.map((value, index) => (index === 3 ? "{}" : value)),
      };
      await expect(f.base.batch([original, mismatched])).rejects.toBeInstanceOf(SqlError);
      expect(f.counts()).toEqual([1, 1, 0, 0]);
      expect(await store.readChallenge("challenge:builder-receipt-bad")).toBeUndefined();
    } finally {
      f.close();
    }
  });

  test("observedAt remains DATA and builder does not invoke an actual Clock that throws", async () => {
    const f = await fixture();
    try {
      let clocks = 0;
      const store = createFinancialPreproofChallengeStore({
        ...f.common,
        scope: SCOPE,
        clock() {
          clocks++;
          throw Error("unusable actual Clock");
        },
      });
      const input = f.preparation("builder-no-clock");
      expect(store.buildPreparationBatch(input, AT)).toHaveLength(2);
      expect(clocks).toBe(0);
      await expect(store.prepare(input)).rejects.toMatchObject({ code: "unavailable" });
      expect(clocks).toBe(1);
      expect(f.counts()).toEqual([0, 0, 0, 0]);
    } finally {
      f.close();
    }
  });
});
