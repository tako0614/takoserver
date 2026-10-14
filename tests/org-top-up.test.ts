import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import {
  assertOrgTopUpSchema,
  createOrgTopUps,
  type OrgTopUps,
  TOP_UP_UNKNOWN_ACK_CUTOFF_MS,
  type TopUpClient,
  type TopUpCommand,
  type TopUpPin,
  type TopUpSession,
} from "../src/org-top-up.ts";
import { resolvePayment } from "../src/payment-setup.ts";
import type { Sql } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { createHostedBillingRealmTestDatabase } from "./helpers/hosted-billing-realm-fixture.ts";

const START = Date.parse("2026-10-15T00:00:00.000Z");
const REQUEST = { organizationId: "org_topup", reference: "purchase-1", amountMinor: 123 };
const PIN: TopUpPin = {
  customerId: "cus_topup",
  accountId: "acct_topup",
  livemode: false,
  financialRealm: "staging-billing-epoch-1",
  pricingRevision: "revision-1",
  purchaseCreditExpiry: { kind: "fixed-duration", seconds: 86400 },
};

function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE stripe_top_up_commands (
    org_id TEXT NOT NULL, reference TEXT NOT NULL, fingerprint TEXT NOT NULL,
    command_json TEXT NOT NULL, stripe_key TEXT NOT NULL UNIQUE,
    state TEXT NOT NULL CHECK (state IN ('pending','ready','paid','expired')),
    session_id TEXT UNIQUE, session_url TEXT, dispatched_at TEXT,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (org_id,reference),
    CHECK (state='pending' OR session_id IS NOT NULL),
    CHECK (state<>'ready' OR session_url IS NOT NULL));
    CREATE UNIQUE INDEX stripe_top_up_pending_org ON stripe_top_up_commands(org_id)
    WHERE state='pending';`);
  let time = START;
  let pin = structuredClone(PIN);
  let pinReads = 0;
  let next = 0;
  let sql: Sql = createSqliteSql(db);
  const sessions = new Map<string, TopUpSession>();
  const creates: { command: TopUpCommand; key: string }[] = [];
  let lostRemoteAck = false;
  let hideRecovery = false;
  let mutate: (session: TopUpSession) => TopUpSession = (session) => session;
  const client: TopUpClient = {
    async create(command, key) {
      creates.push({ command: structuredClone(command), key });
      let session = sessions.get(key);
      if (!session) {
        const id = `cs_topup_${++next}`;
        session = {
          ...command,
          id,
          url: `https://checkout.stripe.com/c/pay/${id}`,
          status: "open",
          paymentStatus: "unpaid",
          mode: "payment",
        };
        sessions.set(key, session);
      }
      if (lostRemoteAck) {
        lostRemoteAck = false;
        throw new Error("lost acknowledgement");
      }
      return mutate(session);
    },
    async read(id) {
      return [...sessions.values()].find((session) => session.id === id) ?? null;
    },
    async recover(_command, key) {
      return hideRecovery ? null : (sessions.get(key) ?? null);
    },
  };
  const make = (bounds: OrgTopUps["bounds"] = { minimumMinor: 50, maximumMinor: 100_000 }) =>
    createOrgTopUps({
      sql,
      clock: () => new Date(time),
      client,
      async pin() {
        pinReads++;
        return pin;
      },
      bounds,
      consoleOrigin: "https://console.test",
    });
  return {
    db,
    make,
    client,
    sessions,
    creates,
    setTime(value: number) {
      time = value;
    },
    setPin(value: TopUpPin) {
      pin = value;
    },
    pinReads: () => pinReads,
    loseRemoteAck() {
      lostRemoteAck = true;
    },
    hideRecovery() {
      hideRecovery = true;
    },
    showRecovery() {
      hideRecovery = false;
    },
    changeResponse(value: typeof mutate) {
      mutate = value;
    },
    loseLocalAck() {
      const delegate = sql;
      let lose = true;
      sql = {
        ...delegate,
        async run(statement, params) {
          const written = await delegate.run(statement, params);
          if (lose && statement.includes("SET state =")) {
            lose = false;
            throw new Error("lost SQL acknowledgement");
          }
          return written;
        },
      };
    },
  };
}

describe("durable Organization top-ups", () => {
  test("ready purchases replay their frozen Checkout after restart with different bounds", async () => {
    for (const bounds of [
      { minimumMinor: 200, maximumMinor: 200_000 },
      { minimumMinor: 50, maximumMinor: 100 },
    ]) {
      const f = fixture();
      const accepted = await f.make().begin(REQUEST);
      const original = f.creates[0];
      if (!original) throw new Error("Missing original accepted command");
      f.setPin({ ...PIN, pricingRevision: "revision-2", purchaseCreditExpiry: { kind: "none" } });
      const restarted = f.make(bounds);
      expect(await restarted.begin(REQUEST)).toEqual(accepted);
      expect(await restarted.commandForSession("cs_topup_1")).toEqual(original.command);
      expect(f.creates).toHaveLength(1);
      expect(f.pinReads()).toBe(1);
      await expect(restarted.begin({ ...REQUEST, amountMinor: 124 })).rejects.toMatchObject({
        code: "conflict",
      });
    }
  });

  test("lost-ACK purchases reuse original command and key outside restarted purchase bounds", async () => {
    for (const bounds of [
      { minimumMinor: 200, maximumMinor: 200_000 },
      { minimumMinor: 50, maximumMinor: 100 },
    ]) {
      const f = fixture();
      f.loseRemoteAck();
      f.hideRecovery();
      await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
      const original = f.creates[0];
      if (!original) throw new Error("Missing dispatched purchase command");
      f.setPin({
        ...PIN,
        customerId: "cus_changed",
        pricingRevision: "revision-2",
        purchaseCreditExpiry: { kind: "none" },
      });
      f.setTime(START + TOP_UP_UNKNOWN_ACK_CUTOFF_MS - 1);
      const restarted = f.make(bounds);
      expect((await restarted.begin(REQUEST)).url).toContain("cs_topup_1");
      expect(f.creates[1]).toEqual(original);
      expect(f.sessions.size).toBe(1);
      expect(f.pinReads()).toBe(1);
      await expect(restarted.begin({ ...REQUEST, amountMinor: 124 })).rejects.toMatchObject({
        code: "conflict",
      });
      expect(f.creates).toHaveLength(2);
    }
  });

  test("reconfigured bounds do not reset a pending purchase's unknown-ACK cutoff", async () => {
    const f = fixture();
    f.loseRemoteAck();
    f.hideRecovery();
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    f.setTime(START + TOP_UP_UNKNOWN_ACK_CUTOFF_MS);
    await expect(
      f.make({ minimumMinor: 200, maximumMinor: 1000 }).begin(REQUEST),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(f.creates).toHaveLength(1);
    expect(f.pinReads()).toBe(1);
  });

  test("new purchases outside current bounds fail before custody, remote effect or durable insertion", async () => {
    const f = fixture();
    const current = f.make({ minimumMinor: 200, maximumMinor: 1000 });
    for (const [index, amountMinor] of [
      123,
      1001,
      0,
      -1,
      1.5,
      Number.MAX_SAFE_INTEGER + 1,
    ].entries()) {
      const request = { ...REQUEST, reference: `new-${index}`, amountMinor };
      await expect(current.begin(request)).rejects.toMatchObject({ code: "invalid_argument" });
      expect(await current.receipt(request)).toBeNull();
    }
    expect(f.pinReads()).toBe(0);
    expect(f.creates).toHaveLength(0);
    expect(f.db.query("SELECT COUNT(*) AS count FROM stripe_top_up_commands").get()).toEqual({
      count: 0,
    });
  });
  test("concurrent retries elect the same stored command, key and Checkout", async () => {
    const f = fixture();
    const first = f.make();
    const second = f.make();
    const results = await Promise.all([first.begin(REQUEST), second.begin(REQUEST)]);
    expect(results[0]).toEqual(results[1]);
    expect(f.sessions.size).toBe(1);
    expect(f.db.query("SELECT COUNT(*) AS count FROM stripe_top_up_commands").get()).toEqual({
      count: 1,
    });
    const session = [...f.sessions.values()][0];
    expect(session).toBeDefined();
    expect(await second.commandForSession(session?.id ?? "")).toMatchObject({
      ...REQUEST,
      amountMicros: 1_230_000,
      currency: "USD",
      purpose: "wallet_funding",
      ...PIN,
    });
    expect(await first.receipt(REQUEST)).toEqual({
      reference: REQUEST.reference,
      state: "ready",
      checkout: { url: results[0]?.url },
    });
    expect(await first.commandForSession("cs_foreign")).toBeNull();
  });

  test("a changed cash payload conflicts before another processor or pin call", async () => {
    const f = fixture();
    await f.make().begin(REQUEST);
    const calls = f.creates.length;
    const pins = f.pinReads();
    await expect(f.make().begin({ ...REQUEST, amountMinor: 124 })).rejects.toMatchObject({
      code: "conflict",
    });
    expect(f.creates.length).toBe(calls);
    expect(f.pinReads()).toBe(pins);
  });

  test("invalid arguments and unavailable custody make no durable command", async () => {
    const f = fixture();
    for (const request of [
      { ...REQUEST, reference: "" },
      { ...REQUEST, amountMinor: 49 },
      { ...REQUEST, amountMinor: 123.4 },
    ]) {
      await expect(f.make().begin(request)).rejects.toMatchObject({ code: "invalid_argument" });
    }
    f.setPin({ ...PIN, accountId: "" });
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.db.query("SELECT COUNT(*) AS count FROM stripe_top_up_commands").get()).toEqual({
      count: 0,
    });
    expect(f.creates).toHaveLength(0);
  });

  test("lost remote acknowledgement survives restart and forbids a fresh pending reference", async () => {
    const f = fixture();
    f.loseRemoteAck();
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.db.query("SELECT state, dispatched_at FROM stripe_top_up_commands").get()).toEqual({
      state: "pending",
      dispatched_at: new Date(START).toISOString(),
    });
    f.hideRecovery();
    await expect(
      f.make().begin({ ...REQUEST, reference: "guess-new-purchase" }),
    ).rejects.toMatchObject({ code: "conflict" });
    f.showRecovery();
    const replay = await f.make().begin(REQUEST);
    expect(replay.url).toContain("cs_topup_1");
    expect(f.creates).toHaveLength(1);
    expect(f.sessions.size).toBe(1);
  });

  test("lost local result acknowledgement reads the committed receipt on restart", async () => {
    const f = fixture();
    f.loseLocalAck();
    await expect(f.make().begin(REQUEST)).rejects.toThrow("lost SQL acknowledgement");
    const receipt = await f.make().begin(REQUEST);
    expect(receipt.url).toContain("cs_topup_1");
    expect(f.creates).toHaveLength(1);
    expect(f.db.query("SELECT state FROM stripe_top_up_commands").get()).toEqual({
      state: "ready",
    });
  });

  test("before cutoff an unknown result reuses the original key and frozen tariff", async () => {
    const f = fixture();
    f.loseRemoteAck();
    f.hideRecovery();
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    f.setPin({
      ...PIN,
      pricingRevision: "revision-2",
      customerId: "cus_other",
      purchaseCreditExpiry: { kind: "none" },
    });
    f.setTime(START + TOP_UP_UNKNOWN_ACK_CUTOFF_MS - 1);
    await f.make().begin(REQUEST);
    expect(f.creates).toHaveLength(2);
    expect(f.creates[1]).toEqual(f.creates[0]);
    expect(f.pinReads()).toBe(1);
    expect(f.sessions.size).toBe(1);
  });

  test("at and beyond cutoff an unknown result permits readback and never redispatch", async () => {
    const f = fixture();
    f.loseRemoteAck();
    f.hideRecovery();
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    f.setTime(START + TOP_UP_UNKNOWN_ACK_CUTOFF_MS);
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    f.setTime(START + 7 * 86400_000);
    expect(await f.make().receipt(REQUEST)).toEqual({
      reference: REQUEST.reference,
      state: "pending",
      checkout: null,
    });
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    expect(f.creates).toHaveLength(1);
  });

  test("authoritative recovered Checkout resolves an old unknown acknowledgement", async () => {
    const f = fixture();
    f.loseRemoteAck();
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    f.setTime(START + 7 * 86400_000);
    expect((await f.make().begin(REQUEST)).url).toContain("cs_topup_1");
    expect(f.creates).toHaveLength(1);
  });

  test("provider object must match Org, cash, purpose, customer, realm and tariff", async () => {
    const mutations: Partial<TopUpSession>[] = [
      { organizationId: "org_other" },
      { reference: "different" },
      { amountMinor: 124 },
      { currency: "EUR" as "USD" },
      { purpose: "hosted_subscription" as "wallet_funding" },
      { mode: "subscription" as "payment" },
      { customerId: "cus_other" },
      { accountId: "acct_other" },
      { livemode: true },
      { financialRealm: "production" },
      { pricingRevision: "other" },
      { purchaseCreditExpiry: { kind: "none" } },
    ];
    for (const mutation of mutations) {
      const f = fixture();
      f.changeResponse((session) => ({ ...session, ...mutation }));
      await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "conflict" });
      expect(f.db.query("SELECT state, session_id FROM stripe_top_up_commands").get()).toEqual({
        state: "pending",
        session_id: null,
      });
    }
  });

  test("paid status is a receipt only; expiry closes a reference; terminal status cannot regress", async () => {
    const f = fixture();
    const topUps = f.make();
    const original = await topUps.begin(REQUEST);
    const [key, session] = [...f.sessions.entries()][0] ?? [];
    if (!key || !session) throw new Error("Missing test Checkout");
    f.sessions.set(key, { ...session, status: "complete", paymentStatus: "paid", url: null });
    expect(await topUps.receipt(REQUEST)).toEqual({
      reference: REQUEST.reference,
      state: "paid",
      checkout: { url: original.url },
    });
    expect(await topUps.begin(REQUEST)).toEqual(original);
    f.sessions.set(key, session);
    expect((await topUps.receipt(REQUEST))?.state).toBe("paid");
    const second = { ...REQUEST, reference: "purchase-2" };
    await topUps.begin(second);
    const entry = [...f.sessions.entries()][1];
    if (!entry) throw new Error("Missing second Checkout");
    f.sessions.set(entry[0], { ...entry[1], status: "expired", url: null });
    await expect(topUps.begin(second)).rejects.toMatchObject({ code: "conflict" });
    expect((await topUps.receipt(second))?.state).toBe("expired");
    expect(f.creates).toHaveLength(2);
  });

  test("Organization isolation and missing receipt do not disclose another purchase", async () => {
    const f = fixture();
    await f.make().begin(REQUEST);
    expect(await f.make().receipt({ ...REQUEST, organizationId: "org_other" })).toBeNull();
    expect(await f.make().receipt({ ...REQUEST, reference: "missing" })).toBeNull();
    await f.make().begin({ ...REQUEST, organizationId: "org_other" });
    expect(f.creates[0]?.key).not.toBe(f.creates[1]?.key);
    expect(f.sessions.size).toBe(2);
  });

  test("a processor response cannot redirect the payer to another HTTPS site", async () => {
    const f = fixture();
    f.changeResponse((session) => ({ ...session, url: "https://other.example/c/pay/pretend" }));
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.db.query("SELECT state, session_url FROM stripe_top_up_commands").get()).toEqual({
      state: "pending",
      session_url: null,
    });
  });

  test("a paid unknown outcome without its former URL never sends another create", async () => {
    const f = fixture();
    f.loseRemoteAck();
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    const entry = [...f.sessions.entries()][0];
    if (!entry) throw new Error("Missing paid Checkout");
    f.sessions.set(entry[0], { ...entry[1], status: "complete", paymentStatus: "paid", url: null });
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    expect(await f.make().receipt(REQUEST)).toEqual({
      reference: REQUEST.reference,
      state: "paid",
      checkout: null,
    });
    await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    expect(f.creates).toHaveLength(1);
    expect(await f.make().commandForSession(entry[1].id)).toMatchObject({
      pricingRevision: PIN.pricingRevision,
      purchaseCreditExpiry: PIN.purchaseCreditExpiry,
      amountMicros: 1_230_000,
    });
  });

  test("a new reference authoritatively recovers a paid or expired pending predecessor", async () => {
    for (const status of ["complete", "expired"] as const) {
      const f = fixture();
      f.loseRemoteAck();
      await expect(f.make().begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
      const entry = [...f.sessions.entries()][0];
      if (!entry) throw new Error("Missing predecessor Checkout");
      f.sessions.set(entry[0], {
        ...entry[1],
        status,
        paymentStatus: status === "complete" ? "paid" : "unpaid",
        url: null,
      });
      expect((await f.make().begin({ ...REQUEST, reference: "next-purchase" })).url).toContain(
        "cs_topup_2",
      );
      expect(
        f.db.query("SELECT reference,state FROM stripe_top_up_commands ORDER BY reference").all(),
      ).toEqual([
        { reference: "next-purchase", state: "ready" },
        { reference: REQUEST.reference, state: status === "complete" ? "paid" : "expired" },
      ]);
      expect(f.creates).toHaveLength(2);
    }
  });

  test("startup verifies actual command DDL, Org pending uniqueness and durable guards without repair", async () => {
    const { db, sql } = await createHostedBillingRealmTestDatabase();
    await assertOrgTopUpSchema(sql);
    db.exec(
      "DROP INDEX stripe_top_up_pending_org; CREATE INDEX stripe_top_up_pending_org ON stripe_top_up_commands(org_id)",
    );
    await expect(assertOrgTopUpSchema(sql)).rejects.toMatchObject({ code: "unavailable" });
    for (const name of ["stripe_top_up_command_immutable", "stripe_top_up_commands_no_delete"]) {
      const fresh = await createHostedBillingRealmTestDatabase();
      fresh.db.exec(`DROP TRIGGER ${name}`);
      await expect(assertOrgTopUpSchema(fresh.sql)).rejects.toMatchObject({ code: "unavailable" });
      fresh.db.close();
    }
    db.close();
  });
});

describe("explicit Hosted top-up composition", () => {
  function pricing() {
    return compilePricingAuthoring({
      authoringVersion: 1,
      billingConfig: {
        schemaVersion: 1,
        revision: "test",
        effectiveAt: "2026-10-01T00:00:00.000Z",
        currency: "USD",
        holdTtlSeconds: 86400,
        freeIncludedMinor: 0,
        purchaseCreditExpiry: { kind: "none" },
        plans: { starter: { includedMinor: 1000, stripePriceId: "price_fixture" } },
        meters: {},
      },
      checkout: { minimumMinor: 50, maximumMinor: 100_000 },
      planIds: { free: "free", subscription: "starter", usage: "usage" },
      stripeMonthlyReview: {
        starter: { expectedAmountMinor: 1000, currency: "USD", interval: "month" },
      },
    });
  }

  test("Hosted amount-only Checkout stays unavailable without durable custody injection", () => {
    const setup = resolvePayment({
      hostedPricing: pricing(),
      stripeSecretKey: "sk_test_fixture",
      consoleOrigin: "https://console.test",
    });
    expect(setup.checkout).toBeUndefined();
  });

  test("explicit Hosted capability rejects a missing reference and forwards exact requests", async () => {
    const f = fixture();
    const topUps: OrgTopUps = f.make();
    const setup = resolvePayment({
      hostedPricing: pricing(),
      topUps,
      stripeSecretKey: "sk_test_fixture",
      consoleOrigin: "https://console.test",
    });
    await expect(
      setup.checkout?.begin({
        organizationId: REQUEST.organizationId,
        amountMinor: REQUEST.amountMinor,
      }),
    ).rejects.toMatchObject({ code: "invalid_argument" });
    expect(await setup.checkout?.begin(REQUEST)).toEqual(await topUps.begin(REQUEST));
  });
});
