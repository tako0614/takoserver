import { describe, expect, test } from "bun:test";
import { MIGRATIONS } from "../src/db-schema.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { canonicalJson } from "../src/json.ts";
import {
  createStripeBillingClient,
  type StripeBillingObject,
} from "../src/stripe-billing-client.ts";
import { assertStripeCardSetupSchema, createStripeCardSetup } from "../src/stripe-card-setup.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

const START = "2026-10-15T00:00:00.000Z";
const ORG = "org_setup_free";
const INPUT = {
  organizationId: ORG,
  reference: "original-setup",
  authorizedPrincipal: "session:principal_setup",
  setupDisclosureRevision: "card-save-v1",
};
const RETURN_URLS = {
  successUrl: "https://console.example.test/wallet/setup-success",
  cancelUrl: "https://console.example.test/wallet/setup-cancel",
};

async function fixture() {
  const { db, sql } = await createHostedBillingRealmTestDatabase();
  const migration = MIGRATIONS.find((item) => item.name.startsWith("0100_"));
  if (!migration)
    throw new Error("0100 must be actually registered before the card-setup test runs");
  db.exec(migration.sql);
  await seedHostedBillingRealmTestPin(sql, {
    accountId: "acct_cardsetup",
    billingAuthority: "card-setup-fixture",
  });
  for (const org of [ORG, "org_other_setup"])
    await sql.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES (?,?,?,?)", [
      org,
      org,
      "principal_setup",
      START,
    ]);
  let time = Date.parse(START),
    lost = false,
    hidden = false,
    extra: StripeBillingObject | null = null,
    gate: Promise<void> | null = null;
  let entered: () => void = () => {};
  const sessions = new Map<string, StripeBillingObject>(),
    intents = new Map<string, StripeBillingObject>(),
    customers = new Map<string, StripeBillingObject>();
  const calls: { method: string; path: string; form: Record<string, string> }[] = [];
  const keys = new Map<string, string>();
  const nested = (form: Record<string, string>, prefix: string) =>
    Object.fromEntries(
      Object.entries(form)
        .filter(([name]) => name.startsWith(`${prefix}[`))
        .map(([name, value]) => [name.slice(prefix.length + 1, -1), value]),
    );
  const client = createStripeBillingClient({
    secretKey: "sk_test_card_setup_fake_only",
    mode: "test",
    async fetch(request) {
      const url = new URL(request.url),
        path = url.pathname,
        form = Object.fromEntries(new URLSearchParams(await request.text()));
      calls.push({ method: request.method, path, form });
      if (path === "/v1/account") return Response.json({ id: "acct_cardsetup", object: "account" });
      if (path === "/v1/prices/price_setup")
        return Response.json({
          id: "price_setup",
          object: "price",
          livemode: false,
          active: true,
          currency: "usd",
          unit_amount: 1000,
          type: "recurring",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      if (path === "/v1/customers" && request.method === "POST") {
        const customer = {
          id: "cus_setup",
          object: "customer",
          livemode: false,
          metadata: nested(form, "metadata"),
        };
        customers.set(customer.id, customer);
        return Response.json(customer);
      }
      if (path === "/v1/customers")
        return Response.json({ data: [...customers.values()], has_more: false });
      if (path === "/v1/checkout/sessions" && request.method === "POST") {
        entered();
        if (gate) await gate;
        const key = request.headers.get("idempotency-key");
        if (!key) throw Error("missing setup key");
        let sessionId = keys.get(key);
        if (!sessionId) {
          sessionId = `cs_setup_${keys.size + 1}`;
          keys.set(key, sessionId);
          sessions.set(sessionId, {
            id: sessionId,
            object: "checkout.session",
            livemode: false,
            mode: "setup",
            customer: form.customer,
            metadata: nested(form, "metadata"),
            status: "open",
            setup_intent: null,
            payment_intent: null,
            subscription: null,
            invoice: null,
            amount_subtotal: null,
            amount_total: null,
            payment_method_types: ["card"],
            success_url: form.success_url,
            cancel_url: form.cancel_url,
            created: Math.floor(time / 1000),
            url: `https://checkout.stripe.com/c/setup/${sessionId}`,
            client_secret: "test-only-native-client-secret",
          });
        }
        if (lost) {
          lost = false;
          throw Error("lost native ACK with secret test-only-native-client-secret");
        }
        return Response.json(sessions.get(sessionId));
      }
      if (path === "/v1/checkout/sessions")
        return Response.json({
          data: hidden ? [] : [...sessions.values(), ...(extra ? [extra] : [])],
          has_more: false,
        });
      for (const [collection, values] of [
        ["customers", customers],
        ["checkout/sessions", sessions],
        ["setup_intents", intents],
      ] as const) {
        const row = values.get(path.slice(`/v1/${collection}/`.length));
        if (path.startsWith(`/v1/${collection}/`))
          return row ? Response.json(row) : new Response(null, { status: 404 });
      }
      throw Error(`unexpected provider request ${path}`);
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: "acct_cardsetup", mode: "test", billingAuthority: "card-setup-fixture" },
    prices: [{ priceId: "price_setup", monthlyAmountMinor: 1000 }],
  });
  const make = () =>
    createStripeCardSetup({
      sql,
      clock: () => new Date(time),
      client,
      realm,
      explicitReturnUrls: RETURN_URLS,
    });
  const complete = (sessionId = "cs_setup_1", status = "succeeded") => {
    const session = sessions.get(sessionId);
    if (!session) throw Error("missing setup Session");
    session.status = "complete";
    session.setup_intent = `seti_${sessionId}`;
    const intent = {
      id: String(session.setup_intent),
      object: "setup_intent",
      livemode: false,
      customer: session.customer,
      payment_method: "pm_setup",
      payment_method_types: ["card"],
      metadata: structuredClone(session.metadata),
      usage: "off_session",
      status,
      client_secret: "test-only-native-client-secret",
      last_setup_error: { message: "test-only-native-error" },
    };
    intents.set(intent.id, intent);
    return { session, intent };
  };
  return {
    db,
    sql,
    client,
    realm,
    make,
    calls,
    sessions,
    intents,
    customers,
    complete,
    lose() {
      lost = true;
      hidden = true;
    },
    reveal() {
      hidden = false;
    },
    duplicate() {
      extra = structuredClone([...sessions.values()][0] ?? null);
      if (extra) extra = { ...extra, id: "cs_setup_duplicate" };
    },
    now(at: string) {
      time = Date.parse(at);
    },
    pause(onEntered: () => void, promise: Promise<void>) {
      entered = onEntered;
      gate = promise;
    },
    posts() {
      return calls.filter((call) => call.method === "POST");
    },
  };
}

describe("original metadata-only Hosted card setup", () => {
  test("a cardless Free Org sets up the same customer without buying credit; safe history never leaks its browser URL", async () => {
    const f = await fixture();
    try {
      const service = f.make(),
        begun = await service.begin(INPUT);
      expect(begun).toMatchObject({
        receipt: { reference: INPUT.reference, state: "original-known", sessionExpired: false },
        checkout: { url: "https://checkout.stripe.com/c/setup/cs_setup_1" },
      });
      expect(f.posts().map((call) => call.path)).toEqual([
        "/v1/customers",
        "/v1/checkout/sessions",
      ]);
      const form = f.posts()[1]?.form ?? {};
      expect(Object.keys(form).sort()).toEqual(
        [
          "mode",
          "customer",
          "success_url",
          "cancel_url",
          "payment_method_types[0]",
          ...[
            "organizationId",
            "reference",
            "fingerprint",
            "setupDisclosureRevision",
            "stripeAccountId",
            "financialRealm",
            "billingAuthority",
          ].flatMap((key) => [`metadata[${key}]`, `setup_intent_data[metadata][${key}]`]),
        ].sort(),
      );
      f.complete();
      expect(await service.recoverOriginal(ORG, INPUT.reference)).toMatchObject({
        state: "succeeded",
      });
      expect(await service.readSelection(ORG, INPUT.reference)).toEqual({
        organizationId: ORG,
        customerId: "cus_setup",
        setupIntentId: "seti_cs_setup_1",
        paymentMethodId: "pm_setup",
      });
      const dump = JSON.stringify([
        await f.sql.query("SELECT * FROM stripe_billing_card_setup_commands"),
        await f.sql.query("SELECT * FROM stripe_billing_card_setup_results"),
        await service.read(ORG, INPUT.reference),
      ]);
      for (const forbidden of [
        "checkout.stripe.com",
        "client_secret",
        "test-only-native-client-secret",
        "test-only-native-error",
        "last_setup_error",
      ])
        expect(dump).not.toContain(forbidden);
      expect(await f.sql.query("SELECT * FROM ledger")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM stripe_billing_grants")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM org_wallet_limit_policy_commands")).toEqual([]);
    } finally {
      f.db.close();
    }
  });
  test("concurrent workers elect one acknowledged dispatch owner, and a restart cannot POST while that owner is in flight", async () => {
    const f = await fixture();
    let resume: () => void = () => {},
      entered: () => void = () => {};
    const seen = new Promise<void>((done) => {
        entered = done;
      }),
      gate = new Promise<void>((done) => {
        resume = done;
      });
    try {
      f.pause(entered, gate);
      const first = f.make().begin(INPUT);
      await seen;
      expect((await f.make().begin(INPUT)).receipt.state).toBe("pending");
      expect(f.posts().filter((call) => call.path === "/v1/checkout/sessions")).toHaveLength(1);
      resume();
      expect((await first).receipt.state).toBe("original-known");
      expect(f.posts().filter((call) => call.path === "/v1/checkout/sessions")).toHaveLength(1);
    } finally {
      resume();
      f.db.close();
    }
  });
  test("a committed but unacknowledged dispatch CAS never grants POST authority to its caller or a restarted worker", async () => {
    const f = await fixture();
    try {
      const original = f.sql.run.bind(f.sql);
      let lose = true;
      f.sql.run = async (...args) => {
        const result = await original(...args);
        if (lose && args[0].includes("dispatch_nonce=?")) {
          lose = false;
          throw Error("lost DB ACK");
        }
        return result;
      };
      expect((await f.make().begin(INPUT)).receipt.state).toBe("pending");
      expect((await f.make().begin(INPUT)).receipt.state).toBe("pending");
      expect(f.posts().filter((call) => call.path === "/v1/checkout/sessions")).toEqual([]);
      f.now("2026-10-16T00:00:00.000Z");
      await expect(f.make().recoverOriginal(ORG, INPUT.reference)).rejects.toMatchObject({
        code: "reconciliation_required",
      });
      expect((await f.make().read(ORG, INPUT.reference))?.state).toBe("pending");
    } finally {
      f.db.close();
    }
  });
  test("lost native ACK recovers its exact original by bounded customer list and GET; empty results never permit a second POST", async () => {
    const f = await fixture();
    try {
      f.lose();
      expect((await f.make().begin(INPUT)).receipt.state).toBe("pending");
      expect((await f.make().begin(INPUT)).checkout).toBeNull();
      const before = f.posts().length;
      f.reveal();
      expect(await f.make().recoverOriginal(ORG, INPUT.reference)).toMatchObject({
        state: "original-known",
      });
      expect((await f.make().begin(INPUT)).checkout?.url).toContain("cs_setup_1");
      expect(f.posts()).toHaveLength(before);
    } finally {
      f.db.close();
    }
  });
  test("a customer association that changes before the dispatch CAS cannot authorize a setup against the old binding", async () => {
    const f = await fixture();
    try {
      const original = f.sql.run.bind(f.sql);
      let changed = false;
      f.sql.run = async (...args) => {
        if (!changed && args[0].includes("dispatch_nonce=?")) {
          changed = true;
          await original("UPDATE stripe_billing_customers SET customer_id=? WHERE org_id=?", [
            "cus_foreign",
            ORG,
          ]);
        }
        return await original(...args);
      };
      expect((await f.make().begin(INPUT)).receipt.state).toBe("prepared");
      expect(
        await f.sql.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id=?", [ORG]),
      ).toEqual([{ customer_id: "cus_foreign" }]);
      expect(f.posts().filter((call) => call.path === "/v1/checkout/sessions")).toEqual([]);
      expect(
        await f.sql.query(
          "SELECT dispatch_nonce,dispatched_at FROM stripe_billing_card_setup_commands",
        ),
      ).toEqual([{ dispatch_nonce: null, dispatched_at: null }]);
    } finally {
      f.db.close();
    }
  });
  test("another actor or disclosure cannot adopt a reference; wallet reads remain SELECT-only without customer or processor recovery", async () => {
    const f = await fixture();
    try {
      await f.make().begin(INPUT);
      const calls = f.calls.length;
      for (const changed of [
        { authorizedPrincipal: "session:foreign" },
        { setupDisclosureRevision: "card-save-v2" },
      ])
        await expect(f.make().begin({ ...INPUT, ...changed })).rejects.toMatchObject({
          code: "conflict",
        });
      expect(f.calls).toHaveLength(calls);
      const query = f.sql.query.bind(f.sql);
      f.sql.query = async (s, p) => {
        if (!/^\s*SELECT\b/iu.test(s)) throw Error("read attempted non-SELECT");
        return query(s, p);
      };
      f.sql.run = async () => {
        throw Error("read attempted write");
      };
      f.sql.batch = async () => {
        throw Error("read attempted batch");
      };
      const service = f.make();
      expect(await service.read("org_other_setup", INPUT.reference)).toBeNull();
      expect(await service.read(ORG, "unknown")).toBeNull();
      expect(await service.read(ORG, INPUT.reference)).toEqual({
        reference: INPUT.reference,
        state: "original-known",
        setupDisclosureRevision: "card-save-v1",
        sessionExpired: false,
        observedAt: null,
      });
      expect(f.calls).toHaveLength(calls);
    } finally {
      f.db.close();
    }
  });
  test("expired Checkout remains nonterminal, and later original SI cancellation is its own saved result", async () => {
    const f = await fixture();
    try {
      await f.make().begin(INPUT);
      const session = f.sessions.get("cs_setup_1");
      if (!session) throw Error("missing setup");
      session.status = "expired";
      expect(await f.make().recoverOriginal(ORG, INPUT.reference)).toMatchObject({
        state: "original-known",
        sessionExpired: true,
      });
      const original = f.complete("cs_setup_1", "canceled");
      original.session.status = "expired";
      expect(await f.make().recoverOriginal(ORG, INPUT.reference)).toMatchObject({
        state: "canceled",
        sessionExpired: true,
      });
      expect(await f.make().readSelection(ORG, INPUT.reference)).toBeNull();
      expect(
        await f.sql.query("SELECT kind FROM stripe_billing_card_setup_results ORDER BY sequence"),
      ).toEqual([{ kind: "session-expiry" }, { kind: "setup-canceled" }]);
    } finally {
      f.db.close();
    }
  });
  for (const [label, mutate] of [
    [
      "foreign customer",
      (intent: StripeBillingObject) => {
        intent.customer = "cus_foreign";
      },
    ],
    [
      "live mode",
      (intent: StripeBillingObject) => {
        intent.livemode = true;
      },
    ],
    [
      "on-session usage",
      (intent: StripeBillingObject) => {
        intent.usage = "on_session";
      },
    ],
    [
      "foreign account",
      (intent: StripeBillingObject) => {
        intent.account = "acct_foreign";
      },
    ],
    [
      "changed metadata",
      (intent: StripeBillingObject) => {
        (intent.metadata as Record<string, string>).reference = "another-original";
      },
    ],
    [
      "missing payment method",
      (intent: StripeBillingObject) => {
        intent.payment_method = null;
      },
    ],
  ] as const)
    test(`contradictory original SI ${label} cannot become successful history`, async () => {
      const f = await fixture();
      try {
        await f.make().begin(INPUT);
        mutate(f.complete().intent);
        await expect(f.make().recoverOriginal(ORG, INPUT.reference)).rejects.toBeInstanceOf(Error);
        expect((await f.make().read(ORG, INPUT.reference))?.state).toBe("original-known");
        expect(await f.sql.query("SELECT * FROM stripe_billing_card_setup_results")).toEqual([]);
      } finally {
        f.db.close();
      }
    });
  test("duplicate recovery candidates stay unresolved and do not pin either native identity", async () => {
    const f = await fixture();
    try {
      f.lose();
      await f.make().begin(INPUT);
      f.reveal();
      f.duplicate();
      await expect(f.make().recoverOriginal(ORG, INPUT.reference)).rejects.toMatchObject({
        code: "reconciliation_required",
      });
      expect((await f.make().read(ORG, INPUT.reference))?.state).toBe("pending");
      expect(f.posts().filter((call) => call.path === "/v1/checkout/sessions")).toHaveLength(1);
    } finally {
      f.db.close();
    }
  });
  test("distinct explicit setup references coexist and the saved original result is unaffected by later customer/PM availability", async () => {
    const f = await fixture();
    try {
      await f.make().begin(INPUT);
      f.complete();
      const original = await f.make().recoverOriginal(ORG, INPUT.reference);
      await f.make().begin({ ...INPUT, reference: "second-explicit-setup" });
      f.customers.clear();
      f.intents.clear();
      expect(await f.make().read(ORG, INPUT.reference)).toEqual(original);
      expect(await f.make().recoverOriginal(ORG, INPUT.reference)).toEqual(original);
      expect(await f.make().readSelection(ORG, INPUT.reference)).toMatchObject({
        paymentMethodId: "pm_setup",
      });
      expect(f.posts().filter((call) => call.path === "/v1/checkout/sessions")).toHaveLength(2);
    } finally {
      f.db.close();
    }
  });
  test("exact schema qualification refuses a weakened native-ownership trigger without repair", async () => {
    const f = await fixture();
    try {
      await assertStripeCardSetupSchema(f.sql);
      f.db.exec(
        "DROP TRIGGER stripe_billing_card_setup_commands_foreign_pin; CREATE TRIGGER stripe_billing_card_setup_commands_foreign_pin BEFORE UPDATE ON stripe_billing_card_setup_commands BEGIN SELECT 1; END",
      );
      const before = canonicalJson(
        await f.sql.query(
          "SELECT sql FROM sqlite_schema WHERE name='stripe_billing_card_setup_commands_foreign_pin'",
        ),
      );
      await expect(assertStripeCardSetupSchema(f.sql)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(
        canonicalJson(
          await f.sql.query(
            "SELECT sql FROM sqlite_schema WHERE name='stripe_billing_card_setup_commands_foreign_pin'",
          ),
        ),
      ).toBe(before);
      expect(f.posts()).toEqual([]);
    } finally {
      f.db.close();
    }
  });
  test("caller extras and accessors cannot enter the immutable request or leak native errors", async () => {
    const f = await fixture();
    try {
      await expect(
        f.make().begin({ ...INPUT, client_secret: "caller secret" } as typeof INPUT),
      ).rejects.toMatchObject({ code: "invalid_argument" });
      let read = false;
      const invalid = { ...INPUT };
      Object.defineProperty(invalid, "reference", {
        enumerable: true,
        get() {
          read = true;
          throw Error("secret");
        },
      });
      await expect(f.make().begin(invalid)).rejects.toMatchObject({ code: "invalid_argument" });
      expect(read).toBe(false);
      expect(f.posts()).toEqual([]);
    } finally {
      f.db.close();
    }
  });
});
