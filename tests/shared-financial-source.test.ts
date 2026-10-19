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
import {
  createSharedFinancialSourceReceiver,
  createSharedFinancialSourceReceiverAbi,
  SharedFinancialSourceError,
  type SharedFinancialSourceImmutableEvidence,
} from "../src/shared-financial-source.ts";
import {
  FinancialSourceAbiError,
  financialSourceReceiptRecordDigest,
} from "../src/shared-financial-source-abi.ts";
import {
  canonicalFinancialSourceJson,
  type FinancialSourceEvent,
  type FinancialSourceRegistration,
  financialSourceEventDigest,
} from "../src/shared-financial-source-contract.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  financial0104Writer,
  installFinancial0104Fences,
  MONEY_FREEZE_ROW,
} from "./helpers/financial-0104-fenced.ts";

const AT = "2026-01-01T00:00:00.000Z";
const GENESIS = `sha256:${"a".repeat(64)}` as const;
const REGISTRATION_DIGEST = `sha256:${"b".repeat(64)}` as const;
const WRITER = `sha256:${"c".repeat(64)}` as const;
const RECEIVER = "receiver:financial-fixture";
const TARGET = "target:financial-fixture";
const QUALIFICATION = "qualified-source:fixture";
const COMPONENT = "parent:session-fixture";
const GENESIS_QUALIFICATION = "qualified-genesis:session-fixture";
const REGISTRATION: FinancialSourceRegistration = {
  registrationRef: "registration:fixture",
  incarnation: "incarnation:1",
  genesisDigest: GENESIS,
  receivers: [{ receiverRef: RECEIVER, targetRef: TARGET }],
};

function first(overrides: Partial<FinancialSourceEvent> = {}): FinancialSourceEvent {
  return {
    v: 1,
    eventRef: "event:1",
    registrationRef: REGISTRATION.registrationRef,
    incarnation: REGISTRATION.incarnation,
    sequence: 1,
    previousDigest: GENESIS,
    kind: "advance",
    affectedRef: COMPONENT,
    evidenceRef: "evidence:1",
    ...overrides,
  };
}

async function fixture(
  input: {
    readonly enrolled?: boolean;
    readonly head?: boolean;
    readonly registration?: FinancialSourceRegistration;
    readonly receiverRef?: string;
    readonly targetRef?: string;
  } = {},
) {
  const fixtureRegistration = input.registration ?? REGISTRATION;
  const fixtureReceiver = input.receiverRef ?? RECEIVER;
  const fixtureTarget = input.targetRef ?? TARGET;
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS) db.exec(migration.sql);
  // Explicit synthetic, UNREGISTERED component schema, not public migration
  // lineage or genuine peer evidence. Always apply it: a future owning public
  // migration must fail on duplicates until this fixture is explicitly synced.
  db.exec(
    readFileSync(
      new URL("./fixtures/shared-financial-source-component-schema.sql", import.meta.url),
      "utf8",
    ),
  );
  db.exec(MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL);
  db.exec(MONEY_CUTOVER_FREEZE_DDL);
  const base = createSqliteSql(db);
  let beforeBatch: (() => Promise<void>) | undefined;
  let batchFault: ((statements: readonly SqlStatement[]) => readonly SqlStatement[]) | undefined;
  let lostAck = false,
    lostRead = false;
  let batchCalls = 0,
    evidenceCalls = 0,
    reads = 0,
    clockCalls = 0;
  let observation = new Date(AT);
  let queryFailure: Error | undefined, evidenceFailure: Error | undefined;
  const clock = () => {
    clockCalls++;
    return observation;
  };
  const failures: string[] = [];
  const rawFailures: unknown[] = [];
  const batches: (readonly SqlStatement[])[] = [];
  const sql: Sql = {
    async query(query, params) {
      reads++;
      if (queryFailure) {
        const error = queryFailure;
        queryFailure = undefined;
        throw error;
      }
      if (lostRead) {
        lostRead = false;
        throw new SqlError("unavailable", "Lost receipt readback");
      }
      return base.query(query, params);
    },
    run: (query, params) => base.run(query, params),
    async batch(statements) {
      batchCalls++;
      batches.push(statements);
      if (beforeBatch) {
        const action = beforeBatch;
        beforeBatch = undefined;
        await action();
      }
      try {
        const result = await base.batch(batchFault ? batchFault(statements) : statements);
        if (lostAck) {
          lostAck = false;
          lostRead = true;
          throw new SqlError("unavailable", "Lost committed acknowledgement");
        }
        return result;
      } catch (error) {
        failures.push(String(error));
        rawFailures.push(error);
        throw error;
      }
    },
  };
  await base.run("INSERT INTO stripe_mode_realm VALUES(1,'test',?)", [AT]);
  await base.run(
    "INSERT INTO stripe_billing_account_realms VALUES(1,'acct_sourcefixture','test','source-fixture',?)",
    [AT],
  );
  await base.run("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)", [WRITER]);
  const client = createStripeBillingClient({
    secretKey: "sk_test_source_fixture",
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method !== "GET") throw new Error("Unexpected provider effect");
      if (url.pathname === "/v1/account")
        return Response.json({ object: "account", id: "acct_sourcefixture" });
      if (url.pathname === "/v1/prices/price_sourcefixture")
        return Response.json({
          object: "price",
          id: "price_sourcefixture",
          livemode: false,
          currency: "usd",
          type: "recurring",
          billing_scheme: "per_unit",
          unit_amount: 1000,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      throw new Error("Unexpected provider read");
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: "acct_sourcefixture", mode: "test", billingAuthority: "source-fixture" },
    prices: [{ priceId: "price_sourcefixture", monthlyAmountMinor: 1000 }],
  });
  async function enroll(registration = fixtureRegistration) {
    await base.run(
      `INSERT INTO financial_source_registrations
      (registration_ref,incarnation,receiver_ref,target_ref,genesis_digest,registration_digest,registration_json,qualification_ref,registered_at)
      VALUES(?,?,?,?,?,?,?,?,?)`,
      [
        registration.registrationRef,
        registration.incarnation,
        fixtureReceiver,
        fixtureTarget,
        registration.genesisDigest,
        REGISTRATION_DIGEST,
        canonicalFinancialSourceJson(registration),
        QUALIFICATION,
        AT,
      ],
    );
  }
  async function head(affectedRef = COMPONENT, registration = fixtureRegistration) {
    await base.run(
      `INSERT INTO financial_source_heads
      (registration_ref,incarnation,affected_ref,genesis_qualification_ref,created_at,sequence,event_digest,state,last_event_ref,updated_at)
      VALUES(?,?,?,?,?,0,?,'active',NULL,?)`,
      [
        registration.registrationRef,
        registration.incarnation,
        affectedRef,
        GENESIS_QUALIFICATION,
        AT,
        registration.genesisDigest,
        AT,
      ],
    );
  }
  if (input.enrolled !== false) await enroll();
  if (input.enrolled !== false && input.head !== false) await head();
  const evidence = new Map<string, SharedFinancialSourceImmutableEvidence>();
  const reader = {
    async readImmutableEvent(eventRef: string) {
      evidenceCalls++;
      if (evidenceFailure) throw evidenceFailure;
      const original = evidence.get(eventRef);
      return original === undefined ? null : structuredClone(original);
    },
  };
  const options = {
    sql,
    clock,
    client,
    realm,
    writerEpoch: WRITER,
    registration: fixtureRegistration,
    registrationDigest: REGISTRATION_DIGEST,
    receiverRef: fixtureReceiver,
    targetRef: fixtureTarget,
    qualificationRef: QUALIFICATION,
    evidence: reader,
  };
  const make = () => createSharedFinancialSourceReceiver(options);
  return {
    db,
    sql,
    base,
    options,
    reader,
    realm,
    client,
    make,
    receiver: make(),
    evidence,
    enroll,
    head,
    failures,
    rawFailures,
    batches,
    get batchCalls() {
      return batchCalls;
    },
    get evidenceCalls() {
      return evidenceCalls;
    },
    get reads() {
      return reads;
    },
    get clockCalls() {
      return clockCalls;
    },
    setClock(value: Date) {
      observation = value;
    },
    failNextRead(error: Error) {
      queryFailure = error;
    },
    failEvidence(error: Error) {
      evidenceFailure = error;
    },
    own(
      event: FinancialSourceEvent,
      overrides: Partial<SharedFinancialSourceImmutableEvidence> = {},
    ) {
      evidence.set(
        event.eventRef,
        structuredClone({
          qualificationRef: QUALIFICATION,
          receiverRef: fixtureReceiver,
          targetRef: fixtureTarget,
          genesisQualificationRef: GENESIS_QUALIFICATION,
          registration: fixtureRegistration,
          event,
          ...overrides,
        }),
      );
      return event;
    },
    beforeBatch(action: () => Promise<void>) {
      beforeBatch = action;
    },
    fault(action: (statements: readonly SqlStatement[]) => readonly SqlStatement[]) {
      batchFault = action;
    },
    loseAckAndReadback() {
      lostAck = true;
    },
    async snapshot() {
      return {
        events: await base.query(
          "SELECT event_ref FROM financial_source_events ORDER BY event_ref",
        ),
        receipts: await base.query(
          "SELECT event_ref FROM financial_source_receipts ORDER BY event_ref",
        ),
        heads: await base.query(
          "SELECT affected_ref,sequence,event_digest,state,last_event_ref FROM financial_source_heads ORDER BY affected_ref",
        ),
      };
    },
  };
}

describe("unmounted shared Financial source primary store", () => {
  test("commits the original event/head/receipt and reads only retained primary data", async () => {
    const f = await fixture();
    expect(await f.receiver.readSourceEventReceipt("absent:event")).toBeNull();
    const event = f.own(first());
    const receipt = await f.receiver.applySourceEvent(event);
    expect(receipt).toMatchObject({
      v: 1,
      eventRef: event.eventRef,
      eventDigest: await financialSourceEventDigest(event),
      incarnation: event.incarnation,
      sequence: 1,
      state: "advanced",
    });
    expect(receipt.receiptRef).toMatch(/^fsr_[0-9a-f]{64}$/u);
    // Independent Python SHA256 + sorted compact ASCII JSON fixture vector.
    expect(receipt.eventDigest).toBe(
      "sha256:e4c0921bde25ccfa976e32803a1badd5b3ac1a2a755ed9f8e21673774c3c52d4",
    );
    expect(receipt.receiptRef).toBe(
      "fsr_56328497a80bd3f5e878ee9456fbfbbee1169a0748968d8e53ccb2f802bfdff7",
    );
    const before = await f.snapshot(),
      calls = f.evidenceCalls,
      batches = f.batchCalls,
      clockCalls = f.clockCalls;
    f.evidence.clear();
    f.setClock(new Date(Number.NaN));
    expect(await f.receiver.readSourceEventReceipt(event.eventRef)).toEqual(receipt);
    expect(await f.receiver.applySourceEvent(event)).toEqual(receipt);
    expect(await f.snapshot()).toEqual(before);
    expect(f.evidenceCalls).toBe(calls);
    expect(f.batchCalls).toBe(batches);
    expect(f.clockCalls).toBe(clockCalls);
    expect(f.batches.flat().every((statement) => (statement.params?.length ?? 0) <= 100)).toBe(
      true,
    );
    f.db.close();
  });

  test("head sequence is per affectedRef and a close is terminal without losing earlier receipts", async () => {
    const f = await fixture();
    await f.head("parent:client-fixture");
    const a = f.own(first()),
      b = f.own(first({ eventRef: "event:client:1", affectedRef: "parent:client-fixture" }));
    const [ra, rb] = await Promise.all([
      f.receiver.applySourceEvent(a),
      f.receiver.applySourceEvent(b),
    ]);
    expect([ra.sequence, rb.sequence]).toEqual([1, 1]);
    const close = f.own(
      first({
        eventRef: "event:2",
        sequence: 2,
        previousDigest: ra.eventDigest,
        kind: "close",
        evidenceRef: "evidence:2",
      }),
    );
    expect(await f.receiver.applySourceEvent(close)).toMatchObject({ state: "admission-closed" });
    expect(await f.receiver.readSourceEventReceipt(a.eventRef)).toEqual(ra);
    expect(await f.receiver.applySourceEvent(a)).toEqual(ra);
    const late = f.own(
      first({
        eventRef: "event:3",
        sequence: 3,
        previousDigest: await financialSourceEventDigest(close),
      }),
    );
    const before = await f.snapshot();
    await expect(f.receiver.applySourceEvent(late)).rejects.toMatchObject({
      code: "source_conflict",
    });
    expect(await f.snapshot()).toEqual(before);
    f.db.close();
  });

  test("same-event concurrency replays one commit and same-ordinal forks have one winner", async () => {
    for (const same of [true, false]) {
      const f = await fixture();
      const a = f.own(first()),
        b = same ? a : f.own(first({ eventRef: "event:fork", evidenceRef: "evidence:fork" }));
      const results = await Promise.allSettled([
        f.receiver.applySourceEvent(a),
        f.receiver.applySourceEvent(b),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(same ? 2 : 1);
      if (same) expect(results[0]).toEqual(results[1]);
      const snapshot = await f.snapshot();
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.receipts).toHaveLength(1);
      expect(snapshot.heads[0]).toMatchObject({ sequence: 1 });
      f.db.close();
    }
  });

  test("changed original payload, gaps and wrong predecessor are refused without effects", async () => {
    const f = await fixture();
    const original = f.own(first());
    await f.receiver.applySourceEvent(original);
    for (const event of [
      { ...original, kind: "close" as const },
      first({ eventRef: "event:gap", sequence: 3 }),
      first({ eventRef: "event:wrong-prev", sequence: 2, previousDigest: GENESIS }),
    ]) {
      f.own(event);
      const before = await f.snapshot();
      await expect(f.receiver.applySourceEvent(event)).rejects.toMatchObject({
        code: "source_conflict",
      });
      expect(await f.snapshot()).toEqual(before);
    }
    f.db.close();
  });

  test("missing registration or component cannot auto-enroll or invent genesis", async () => {
    for (const input of [{ enrolled: false }, { head: false }]) {
      const f = await fixture(input);
      const before = await f.snapshot();
      await expect(f.receiver.applySourceEvent(f.own(first()))).rejects.toBeDefined();
      expect(await f.snapshot()).toEqual(before);
      expect(
        await f.base.query("SELECT count(*) AS n FROM financial_source_registrations"),
      ).toEqual([{ n: input.enrolled === false ? 0 : 1 }]);
      f.db.close();
    }
  });

  test("fixed peer evidence, target, full registration and component provenance must match", async () => {
    const f = await fixture();
    for (const overrides of [
      { qualificationRef: "qualified-source:foreign" },
      { targetRef: "target:foreign" },
      { receiverRef: "receiver:foreign" },
      { genesisQualificationRef: "genesis:foreign" },
      {
        registration: {
          ...REGISTRATION,
          receivers: [
            ...REGISTRATION.receivers,
            { receiverRef: "receiver:extra", targetRef: "target:extra" },
          ],
        },
      },
      { event: first({ evidenceRef: "evidence:foreign" }) },
    ]) {
      f.own(first(), overrides);
      const before = await f.snapshot();
      await expect(f.receiver.applySourceEvent(first())).rejects.toMatchObject({
        code: "source_conflict",
      });
      expect(await f.snapshot()).toEqual(before);
    }
    f.db.close();
  });

  test("retirement between evidence await and batch is refused atomically", async () => {
    const f = await fixture();
    f.beforeBatch(async () => {
      await f.base.run(
        "UPDATE financial_source_registrations SET retirement_ref='retired:fixture',retired_at=?",
        [new Date().toISOString()],
      );
    });
    await expect(f.receiver.applySourceEvent(f.own(first()))).rejects.toMatchObject({
      code: "source_conflict",
    });
    expect(await f.snapshot()).toMatchObject({
      events: [],
      receipts: [],
      heads: [{ sequence: 0, state: "active" }],
    });
    f.db.close();
  });

  test("writer rotation and freeze between evidence await and batch are fenced atomically by 0104", async () => {
    for (const mutation of ["writer", "freeze", "unpermitted"] as const) {
      const f = await fixture();
      try {
        // Freeze/permit/epoch are the Financial 0104 receiver fences inside the
        // actual permit-framed Money writer; the predicate names no money table.
        installFinancial0104Fences(f.db, { receiver: true });
        const { money, realm } = await financial0104Writer(f.sql, WRITER, f.client, {
          accountId: "acct_sourcefixture",
          billingAuthority: "source-fixture",
          priceId: "price_sourcefixture",
        });
        const fenced = createSharedFinancialSourceReceiver({ ...f.options, sql: money, realm });
        if (mutation !== "unpermitted")
          f.beforeBatch(async () => {
            if (mutation === "writer")
              await f.base.run("UPDATE money_cutover_authorized_epoch SET writer_epoch=?", [
                `sha256:${"d".repeat(64)}`,
              ]);
            else await f.base.run(MONEY_FREEZE_ROW);
          });
        const receiver = mutation === "unpermitted" ? f.receiver : fenced;
        await expect(receiver.applySourceEvent(f.own(first()))).rejects.toMatchObject({
          code: "source_conflict",
        });
        expect(await f.snapshot()).toMatchObject({
          events: [],
          receipts: [],
          heads: [{ sequence: 0, state: "active" }],
        });
        expect(await f.base.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
        if (mutation === "writer")
          await f.base.run("UPDATE money_cutover_authorized_epoch SET writer_epoch=?", [WRITER]);
        if (mutation === "freeze") await f.base.run("DELETE FROM money_cutover_freeze");
        // Inside the actual writer with the authorized epoch all three writes commit.
        const receipt = await fenced.applySourceEvent(f.own(first()));
        expect(receipt.sequence).toBe(1);
        expect(await f.snapshot()).toMatchObject({
          events: [{}],
          receipts: [{}],
          heads: [{ sequence: 1, state: "active" }],
        });
        for (const statement of f.batches.at(-1)?.slice(1, -1) ?? [])
          expect(statement.sql).not.toMatch(/\bmoney_cutover_/u);
        expect(await f.base.query("SELECT * FROM money_cutover_writer_permit")).toEqual([]);
      } finally {
        f.db.close();
      }
    }
  });

  test("original receipt survives retirement, writer revocation and an ABA incarnation", async () => {
    const f = await fixture();
    const event = f.own(first()),
      receipt = await f.receiver.applySourceEvent(event);
    await f.base.run(
      "UPDATE financial_source_registrations SET retirement_ref='retired:fixture',retired_at=?",
      [new Date().toISOString()],
    );
    await f.enroll({ ...REGISTRATION, incarnation: "incarnation:2" });
    await f.base.run("UPDATE money_cutover_authorized_epoch SET writer_epoch=?", [
      `sha256:${"d".repeat(64)}`,
    ]);
    f.evidence.clear();
    expect(await f.make().applySourceEvent(event)).toEqual(receipt);
    expect(await f.make().readSourceEventReceipt(event.eventRef)).toEqual(receipt);
    const before = await f.snapshot();
    await expect(
      f.receiver.applySourceEvent(
        f.own(
          first({ eventRef: "event:after-ABA", sequence: 2, previousDigest: receipt.eventDigest }),
        ),
      ),
    ).rejects.toMatchObject({ code: "source_conflict" });
    expect(await f.snapshot()).toEqual(before);
    f.db.close();
  });

  test("a stale genuine realm capability cannot hide changed local primary evidence at CAS", async () => {
    const f = await fixture();
    f.beforeBatch(async () => {
      // Isolated hostile-storage fixture: normal realm writes are immutable.
      f.db.exec("DROP TRIGGER stripe_billing_account_realms_no_update");
      await f.base.run("UPDATE stripe_billing_account_realms SET account_id='acct_foreignfixture'");
    });
    await expect(f.receiver.applySourceEvent(f.own(first()))).rejects.toMatchObject({
      code: "source_conflict",
    });
    expect(await f.snapshot()).toMatchObject({
      events: [],
      receipts: [],
      heads: [{ sequence: 0 }],
    });
    f.db.close();
  });

  test("captured peer, Clock and copied event withstand caller mutation during awaits", async () => {
    const f = await fixture();
    const event = f.own(first());
    let redirected = 0;
    f.reader.readImmutableEvent = async () => {
      redirected++;
      throw new Error("Replaced peer");
    };
    f.options.clock = () => {
      redirected++;
      throw new Error("Replaced observation Clock");
    };
    const pending = f.receiver.applySourceEvent(event);
    Object.assign(event, { kind: "close", evidenceRef: "evidence:changed" });
    expect(await pending).toMatchObject({ state: "advanced" });
    expect(redirected).toBe(0);
    expect(f.clockCalls).toBe(1);
    expect((await f.snapshot()).heads).toMatchObject([{ sequence: 1, state: "active" }]);
    f.db.close();
  });

  test("an observation before head creation still admits the valid event and preserves raw timestamps", async () => {
    const f = await fixture();
    const observed = "2025-12-31T23:59:59.999Z";
    f.setClock(new Date(observed));
    const event = f.own(first());
    const abi = createSharedFinancialSourceReceiverAbi(f.options);
    const eventDigest = await financialSourceEventDigest(event);
    const receipt = await abi.applySourceEvent({ v: 1, event, eventDigest });
    expect(receipt).toMatchObject({
      sequence: 1,
      state: "advanced",
      eventDigest,
      receiptRef: "fsr_56328497a80bd3f5e878ee9456fbfbbee1169a0748968d8e53ccb2f802bfdff7",
    });
    expect(
      await f.base.query("SELECT created_at,updated_at,sequence,state FROM financial_source_heads"),
    ).toEqual([{ created_at: AT, updated_at: AT, sequence: 1, state: "active" }]);
    expect(await f.base.query("SELECT applied_at FROM financial_source_events")).toEqual([
      { applied_at: observed },
    ]);
    expect(
      await f.base.query("SELECT created_at,receipt_json FROM financial_source_receipts"),
    ).toEqual([{ created_at: observed, receipt_json: canonicalFinancialSourceJson(receipt) }]);
    expect(f.batchCalls).toBe(1);
    expect(f.clockCalls).toBe(1);
    f.setClock(new Date(Number.NaN));
    f.evidence.clear();
    expect(
      await abi.readSourceEventReceipt({
        v: 1,
        registrationRef: event.registrationRef,
        eventRef: event.eventRef,
        eventDigest,
      }),
    ).toEqual(receipt);
    expect(await abi.applySourceEvent({ v: 1, event, eventDigest })).toEqual(receipt);
    expect(f.clockCalls).toBe(1);
    expect(f.evidenceCalls).toBe(1);
    expect(f.batchCalls).toBe(1);
    f.db.close();
  });

  test("later observation rollback keeps head metadata monotonic through advance and close", async () => {
    const f = await fixture();
    const forward = "2026-01-01T00:02:00.000Z";
    const rolledBack = "2026-01-01T00:01:00.000Z";
    const abi = createSharedFinancialSourceReceiverAbi(f.options);
    const event = f.own(first());
    const eventDigest = await financialSourceEventDigest(event);
    f.setClock(new Date(forward));
    const original = await abi.applySourceEvent({ v: 1, event, eventDigest });
    const advance = f.own(
      first({
        eventRef: "event:clock:2",
        evidenceRef: "evidence:clock:2",
        sequence: 2,
        previousDigest: eventDigest,
      }),
    );
    f.setClock(new Date(rolledBack));
    const advanceDigest = await financialSourceEventDigest(advance);
    expect(
      await abi.applySourceEvent({ v: 1, event: advance, eventDigest: advanceDigest }),
    ).toMatchObject({ sequence: 2, state: "advanced" });
    expect(
      await f.base.query("SELECT created_at,updated_at,sequence,state FROM financial_source_heads"),
    ).toEqual([{ created_at: AT, updated_at: forward, sequence: 2, state: "active" }]);
    const close = f.own(
      first({
        eventRef: "event:clock:3",
        evidenceRef: "evidence:clock:3",
        sequence: 3,
        previousDigest: advanceDigest,
        kind: "close",
      }),
    );
    const beforeCreation = "2025-12-31T23:59:59.999Z";
    f.setClock(new Date(beforeCreation));
    expect(
      await abi.applySourceEvent({
        v: 1,
        event: close,
        eventDigest: await financialSourceEventDigest(close),
      }),
    ).toMatchObject({ sequence: 3, state: "admission-closed" });
    expect(
      await f.base.query("SELECT created_at,updated_at,sequence,state FROM financial_source_heads"),
    ).toEqual([{ created_at: AT, updated_at: forward, sequence: 3, state: "closed" }]);
    expect(
      await f.base.query(
        "SELECT event_ref,applied_at FROM financial_source_events ORDER BY sequence",
      ),
    ).toEqual([
      { event_ref: event.eventRef, applied_at: forward },
      { event_ref: advance.eventRef, applied_at: rolledBack },
      { event_ref: close.eventRef, applied_at: beforeCreation },
    ]);
    expect(
      await f.base.query(
        "SELECT event_ref,created_at FROM financial_source_receipts ORDER BY sequence",
      ),
    ).toEqual([
      { event_ref: event.eventRef, created_at: forward },
      { event_ref: advance.eventRef, created_at: rolledBack },
      { event_ref: close.eventRef, created_at: beforeCreation },
    ]);
    f.evidence.clear();
    f.setClock(new Date(Number.NaN));
    expect(
      await abi.readSourceEventReceipt({
        v: 1,
        registrationRef: event.registrationRef,
        eventRef: event.eventRef,
        eventDigest,
      }),
    ).toEqual(original);
    expect(await abi.applySourceEvent({ v: 1, event, eventDigest })).toEqual(original);
    expect(f.clockCalls).toBe(3);
    expect(f.evidenceCalls).toBe(3);
    expect(f.batchCalls).toBe(3);
    f.db.close();
  });

  test("invalid observation clocks refuse new writes before peer access or SQL batch", async () => {
    for (const instant of [new Date(Number.NaN), new Date(253402300800000)]) {
      const f = await fixture();
      f.setClock(instant);
      const before = await f.snapshot();
      const error = await f.receiver
        .applySourceEvent(f.own(first()))
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SharedFinancialSourceError);
      expect(error).toMatchObject({ code: "unavailable", message: "unavailable" });
      expect((error as SharedFinancialSourceError).cause).toBeInstanceOf(Error);
      expect(f.evidenceCalls).toBe(0);
      expect(f.batchCalls).toBe(0);
      expect(await f.snapshot()).toEqual(before);
      f.db.close();
    }
  });

  test("SQL and evidence failures preserve their original private cause without widening messages", async () => {
    for (const boundary of ["SQL", "evidence"] as const) {
      const f = await fixture();
      const nativeError = new Error(`private-${boundary}-fixture-detail`);
      if (boundary === "SQL") f.failNextRead(nativeError);
      else f.failEvidence(nativeError);
      const error = await f.receiver
        .applySourceEvent(f.own(first()))
        .catch((error: unknown) => error);
      expect(error).toBeInstanceOf(SharedFinancialSourceError);
      expect(error).toMatchObject({
        code: "unavailable",
        message: "unavailable",
        cause: nativeError,
      });
      expect(JSON.stringify(error)).not.toContain(nativeError.message);
      expect(f.batchCalls).toBe(0);
      f.db.close();
    }
  });

  test("malformed new events and reader references refuse before any primary or peer access", async () => {
    const f = await fixture();
    const reads = f.reads;
    const error = await f.receiver
      .applySourceEvent(first({ sequence: 0 }))
      .catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "invalid_event" });
    expect((error as SharedFinancialSourceError).cause).toBeInstanceOf(TypeError);
    await expect(f.receiver.readSourceEventReceipt("bad reference")).rejects.toMatchObject({
      code: "invalid_event",
    });
    expect(f.reads).toBe(reads);
    expect(f.batchCalls).toBe(0);
    expect(f.evidenceCalls).toBe(0);
    f.db.close();
  });

  test("unconditional receipt CHECK rolls back zero-row event or head even without the receipt trigger", async () => {
    for (const operation of ["event", "head", "null-check"] as const) {
      const f = await fixture();
      f.db.exec("DROP TRIGGER financial_source_receipt_match");
      f.fault((statements) =>
        statements.map((statement, index) => {
          if ((operation === "event" && index === 0) || (operation === "head" && index === 1))
            return { ...statement, sql: `${statement.sql} AND 0` };
          if (operation === "null-check" && index === 2)
            return {
              ...statement,
              sql: statement.sql.replace("THEN 1 ELSE 0 END", "THEN NULL ELSE 0 END"),
            };
          return statement;
        }),
      );
      const before = await f.snapshot();
      const error = await f.receiver
        .applySourceEvent(f.own(first()))
        .catch((error: unknown) => error);
      expect(error).toMatchObject({ code: "source_conflict", cause: f.rawFailures[0] });
      expect(await f.snapshot()).toEqual(before);
      expect(f.failures.some((message) => /all_rows_match/u.test(message))).toBe(true);
      f.db.close();
    }
  });

  test("lost commit ACK and failed primary readback recover the original receipt after restart", async () => {
    const f = await fixture();
    const event = f.own(first());
    f.loseAckAndReadback();
    const error = await f.receiver.applySourceEvent(event).catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "unavailable" });
    const causes = (error as SharedFinancialSourceError).cause;
    expect(causes).toBeInstanceOf(AggregateError);
    if (!(causes instanceof AggregateError))
      throw new Error("Missing private batch/readback causes");
    expect(causes.errors).toHaveLength(2);
    expect(causes.errors[0]).toBe(f.rawFailures[0]);
    expect(causes.errors[1]).toMatchObject({ cause: expect.any(SqlError) });
    const before = await f.snapshot(),
      calls = f.evidenceCalls;
    f.evidence.clear();
    const restarted = f.make();
    const receipt = await restarted.readSourceEventReceipt(event.eventRef);
    if (receipt === null) throw new Error("Committed original receipt is missing");
    expect(receipt).toMatchObject({ eventRef: event.eventRef });
    expect(await restarted.applySourceEvent(event)).toEqual(receipt);
    expect(await f.snapshot()).toEqual(before);
    expect(f.batchCalls).toBe(1);
    expect(f.evidenceCalls).toBe(calls);
    f.db.close();
  });

  test("an orphan immutable event is unavailable and never reconstructed as an ACK", async () => {
    const f = await fixture();
    const event = f.own(first());
    await f.base.run(
      `INSERT INTO financial_source_events
      (event_ref,registration_ref,incarnation,affected_ref,sequence,previous_digest,event_digest,kind,evidence_ref,event_json,applied_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
      [
        event.eventRef,
        event.registrationRef,
        event.incarnation,
        event.affectedRef,
        event.sequence,
        event.previousDigest,
        await financialSourceEventDigest(event),
        event.kind,
        event.evidenceRef,
        canonicalFinancialSourceJson(event),
        AT,
      ],
    );
    await expect(f.receiver.readSourceEventReceipt(event.eventRef)).rejects.toMatchObject({
      code: "unavailable",
    });
    await expect(f.receiver.applySourceEvent(event)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.batchCalls).toBe(0);
    expect(f.evidenceCalls).toBe(0);
    f.db.close();
  });

  test("missing component storage is unavailable, never an absent ACK or a new effect", async () => {
    const f = await fixture({ enrolled: false });
    // Only the synthetic component is removed; genuine local realm/Sql
    // identity remains qualified. No production schema is changed or repaired.
    f.db.exec(`DROP TABLE financial_source_receipts;
      DROP TABLE financial_source_heads;
      DROP TABLE financial_source_events;
      DROP TABLE financial_source_registrations;`);
    const changes = await f.base.query("SELECT total_changes() AS n");
    const realmRows = await f.base.query("SELECT * FROM stripe_billing_account_realms");
    const abi = createSharedFinancialSourceReceiverAbi(f.options);
    const event = f.own(first());
    const eventDigest = await financialSourceEventDigest(event);
    await expect(
      abi.readSourceEventReceipt({
        v: 1,
        registrationRef: event.registrationRef,
        eventRef: event.eventRef,
        eventDigest,
      }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await expect(abi.applySourceEvent({ v: 1, event, eventDigest })).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(await f.base.query("SELECT total_changes() AS n")).toEqual(changes);
    expect(await f.base.query("SELECT * FROM stripe_billing_account_realms")).toEqual(realmRows);
    expect(
      await f.base.query(
        "SELECT name FROM sqlite_schema WHERE name IN ('financial_source_registrations','financial_source_heads','financial_source_events','financial_source_receipts')",
      ),
    ).toEqual([]);
    expect(f.clockCalls).toBe(0);
    expect(f.evidenceCalls).toBe(0);
    expect(f.batchCalls).toBe(0);
    f.db.close();
  });

  test("raw realm objects, another SQL primary and wrong receiver cannot construct this store", async () => {
    const f = await fixture();
    expect(() =>
      createSharedFinancialSourceReceiver({ ...f.options, realm: { ...f.realm } }),
    ).toThrow();
    expect(() => createSharedFinancialSourceReceiver({ ...f.options, sql: f.base })).toThrow();
    expect(() =>
      createSharedFinancialSourceReceiver({ ...f.options, receiverRef: "receiver:foreign" }),
    ).toThrow();
    expect(f.batchCalls).toBe(0);
    expect(f.evidenceCalls).toBe(0);
    f.db.close();
  });
});

describe("closed external Financial source ABI over the actual primary store", () => {
  test("the frozen Accounts close vector stores the exact outward receipt, without rewriting it", async () => {
    const event: FinancialSourceEvent = {
      v: 1,
      eventRef: "event:one",
      registrationRef: "source:accounts",
      incarnation: "incarnation:one",
      sequence: 1,
      previousDigest: `sha256:${"1".repeat(64)}`,
      kind: "close",
      affectedRef: "grant:one",
      evidenceRef: "evidence:one",
    };
    const registration: FinancialSourceRegistration = {
      registrationRef: event.registrationRef,
      incarnation: event.incarnation,
      genesisDigest: event.previousDigest,
      receivers: [{ receiverRef: "receiver:financial", targetRef: "target:qualified" }],
    };
    const f = await fixture({
      registration,
      receiverRef: "receiver:financial",
      targetRef: "target:qualified",
      head: false,
    });
    await f.head(event.affectedRef);
    f.own(event);
    const abi = createSharedFinancialSourceReceiverAbi(f.options);
    const eventDigest = await financialSourceEventDigest(event);
    const receipt = await abi.applySourceEvent({ v: 1, event, eventDigest });
    expect(eventDigest).toBe(
      "sha256:85dfc950d869c729357ad56b76bc83275053ea0b037f117649932a36d5924b93",
    );
    expect(receipt).toEqual({
      v: 1,
      eventRef: event.eventRef,
      eventDigest,
      receiptRef: "fsr_df35120d968c92051da0398de4d68fd0efc718f3302e671af09c09663b74c192",
      incarnation: event.incarnation,
      sequence: 1,
      state: "admission-closed",
    });
    expect(
      await financialSourceReceiptRecordDigest({
        registrationRef: registration.registrationRef,
        receiverRef: "receiver:financial",
        targetRef: "target:qualified",
        receipt,
      }),
    ).toBe("sha256:2a3fc7ee808cff8bbbc8805a20a06faff28b045628ae63b65b743f48f97751d9");
    expect(
      await f.base.query("SELECT receipt_ref,receipt_json FROM financial_source_receipts"),
    ).toEqual([
      { receipt_ref: receipt.receiptRef, receipt_json: canonicalFinancialSourceJson(receipt) },
    ]);
    expect(await f.receiver.readSourceEventReceipt(event.eventRef)).toEqual(receipt);
    expect(
      await abi.readSourceEventReceipt({
        v: 1,
        registrationRef: event.registrationRef,
        eventRef: event.eventRef,
        eventDigest,
      }),
    ).toEqual(receipt);
    expect((await f.snapshot()).heads[0]).toMatchObject({ sequence: 1, state: "closed" });
    f.db.close();
  });

  test("malformed envelopes, wrong digest and unregistered source deny before any primary access", async () => {
    const f = await fixture();
    const abi = createSharedFinancialSourceReceiverAbi(f.options);
    const event = first();
    const eventDigest = await financialSourceEventDigest(event);
    const reads = f.reads;
    for (const input of [
      null,
      { event, eventDigest },
      { v: 2, event, eventDigest },
      { v: 1, event, eventDigest, ready: true },
      { v: 1, event, eventDigest: REGISTRATION_DIGEST },
    ]) {
      await expect(abi.applySourceEvent(input as never)).rejects.toMatchObject({
        code: "invalid-request",
      });
    }
    const foreign = first({ registrationRef: "source:foreign" });
    await expect(
      abi.applySourceEvent({
        v: 1,
        event: foreign,
        eventDigest: await financialSourceEventDigest(foreign),
      }),
    ).rejects.toMatchObject({ code: "unregistered-source" });
    for (const input of [
      null,
      {
        v: 1,
        registrationRef: REGISTRATION.registrationRef,
        eventRef: event.eventRef,
        eventDigest,
        ready: true,
      },
    ])
      await expect(abi.readSourceEventReceipt(input as never)).rejects.toMatchObject({
        code: "invalid-request",
      });
    await expect(
      abi.readSourceEventReceipt({
        v: 1,
        registrationRef: "source:foreign",
        eventRef: event.eventRef,
        eventDigest,
      }),
    ).rejects.toMatchObject({ code: "unregistered-source" });
    expect(f.reads).toBe(reads);
    expect(f.batchCalls).toBe(0);
    expect(f.evidenceCalls).toBe(0);
    expect(f.clockCalls).toBe(0);
    f.db.close();
  });

  test("only absent primary receipts return undefined; wrong original digest and unreadable data throw", async () => {
    const f = await fixture();
    const abi = createSharedFinancialSourceReceiverAbi(f.options);
    const event = f.own(first());
    const eventDigest = await financialSourceEventDigest(event);
    const read = {
      v: 1 as const,
      registrationRef: event.registrationRef,
      eventRef: event.eventRef,
      eventDigest,
    };
    expect(await abi.readSourceEventReceipt(read)).toBeUndefined();
    const receipt = await abi.applySourceEvent({ v: 1, event, eventDigest });
    const before = await f.snapshot(),
      calls = f.evidenceCalls,
      clocks = f.clockCalls;
    await expect(
      abi.readSourceEventReceipt({ ...read, eventDigest: REGISTRATION_DIGEST }),
    ).rejects.toMatchObject({ code: "conflict" });
    const changed = { ...event, kind: "close" as const };
    await expect(
      abi.applySourceEvent({
        v: 1,
        event: changed,
        eventDigest: await financialSourceEventDigest(changed),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    f.evidence.clear();
    f.setClock(new Date(Number.NaN));
    expect(await abi.readSourceEventReceipt(read)).toEqual(receipt);
    expect(await abi.applySourceEvent({ v: 1, event, eventDigest })).toEqual(receipt);
    const nativeError = new SqlError("unavailable", "private ABI read fixture detail");
    f.failNextRead(nativeError);
    const error = await abi.readSourceEventReceipt(read).catch((error: unknown) => error);
    expect(error).toBeInstanceOf(FinancialSourceAbiError);
    expect(error).toMatchObject({ code: "unavailable", cause: { cause: nativeError } });
    expect(await f.snapshot()).toEqual(before);
    expect(f.batchCalls).toBe(1);
    expect(f.evidenceCalls).toBe(calls);
    expect(f.clockCalls).toBe(clocks);
    f.db.close();
  });

  test("the wrapper captures actual core options and duplicate/fork calls elect one primary winner", async () => {
    const f = await fixture();
    const options = { ...f.options };
    let bindCalls = 0;
    Object.defineProperty(options.evidence.readImmutableEvent, "bind", {
      value() {
        bindCalls++;
        throw new Error("A peer-owned bind property must not run");
      },
    });
    const abi = createSharedFinancialSourceReceiverAbi(options);
    options.registration = { ...REGISTRATION, registrationRef: "source:swapped" };
    options.evidence = {
      async readImmutableEvent() {
        throw new Error("Swapped peer must not run");
      },
    };
    options.clock = () => new Date(Number.NaN);
    const event = f.own(first());
    const request = { v: 1 as const, event, eventDigest: await financialSourceEventDigest(event) };
    const copies = await Promise.all([
      abi.applySourceEvent(request),
      abi.applySourceEvent(request),
    ]);
    expect(copies[0]).toEqual(copies[1]);
    expect(bindCalls).toBe(0);
    const fork = f.own(
      first({ eventRef: "event:external-fork", evidenceRef: "evidence:external-fork" }),
    );
    await expect(
      abi.applySourceEvent({
        v: 1,
        event: fork,
        eventDigest: await financialSourceEventDigest(fork),
      }),
    ).rejects.toMatchObject({ code: "conflict" });
    const snapshot = await f.snapshot();
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.receipts).toHaveLength(1);
    expect(snapshot.heads[0]).toMatchObject({ sequence: 1, state: "active" });
    f.db.close();
  });

  test("lost external ACK recovers the original saved receipt after restart and later close", async () => {
    const f = await fixture();
    const event = f.own(first());
    const eventDigest = await financialSourceEventDigest(event);
    const request = { v: 1 as const, event, eventDigest };
    f.loseAckAndReadback();
    await expect(
      createSharedFinancialSourceReceiverAbi(f.options).applySourceEvent(request),
    ).rejects.toMatchObject({ code: "unavailable" });
    const restarted = createSharedFinancialSourceReceiverAbi(f.options);
    const read = {
      v: 1 as const,
      registrationRef: event.registrationRef,
      eventRef: event.eventRef,
      eventDigest,
    };
    const receipt = await restarted.readSourceEventReceipt(read);
    if (receipt === undefined) throw new Error("Committed ABI receipt is missing");
    expect(await restarted.applySourceEvent(request)).toEqual(receipt);
    expect(f.batchCalls).toBe(1);
    const close = f.own(
      first({
        eventRef: "event:external-close",
        evidenceRef: "evidence:external-close",
        sequence: 2,
        previousDigest: eventDigest,
        kind: "close",
      }),
    );
    await restarted.applySourceEvent({
      v: 1,
      event: close,
      eventDigest: await financialSourceEventDigest(close),
    });
    await f.base.run(
      "UPDATE financial_source_registrations SET retirement_ref='retired:external',retired_at=?",
      [AT],
    );
    f.evidence.clear();
    f.setClock(new Date(Number.NaN));
    const before = await f.snapshot(),
      calls = f.evidenceCalls,
      clocks = f.clockCalls;
    expect(
      await createSharedFinancialSourceReceiverAbi(f.options).readSourceEventReceipt(read),
    ).toEqual(receipt);
    expect(
      await createSharedFinancialSourceReceiverAbi(f.options).applySourceEvent(request),
    ).toEqual(receipt);
    expect(await f.snapshot()).toEqual(before);
    expect(f.batchCalls).toBe(2);
    expect(f.evidenceCalls).toBe(calls);
    expect(f.clockCalls).toBe(clocks);
    f.db.close();
  });
});
