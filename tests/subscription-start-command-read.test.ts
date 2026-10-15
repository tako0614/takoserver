import { describe, expect, test } from "bun:test";
import { canonicalJson } from "../src/json.ts";
import type { Sql } from "../src/ports.ts";
import type { StripeBillingClient, StripeBillingObject } from "../src/stripe-billing-client.ts";
import { createSubscriptionCustody } from "../src/subscription-custody.ts";
import { createHostedBillingRealmTestDatabase } from "./helpers/hosted-billing-realm-fixture.ts";

const ORG = "org_start_reader";
const AT = "2026-10-15T00:00:00.000Z";
const OLD = {
  planId: "hosted-10",
  stripePriceId: "price_original",
  monthlyAmountMinor: 1000,
  includedCreditMinor: 2000,
};
const digest = (value: unknown) =>
  new Bun.CryptoHasher("sha256").update(canonicalJson(value)).digest("hex");

async function fixture() {
  const { db, sql: database } = await createHostedBillingRealmTestDatabase();
  await database.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,?,?,?)", [
    ORG,
    "Reader",
    "principal_reader",
    AT,
  ]);
  await database.run(
    "INSERT INTO stripe_billing_customers(org_id,customer_id,created_at) VALUES(?,?,?)",
    [ORG, "cus_original", AT],
  );
  let readOnly = false,
    mutations = 0,
    nativeCalls = 0,
    callbackCalls = 0,
    cancelEffect = true,
    queries = 0;
  const sql: Sql = {
    query: (statement, params) => {
      queries++;
      if (readOnly && !/^\s*SELECT\b/iu.test(statement))
        throw new Error("reader attempted mutation through SQL.query");
      return database.query(statement, params);
    },
    async run(statement, params) {
      mutations++;
      if (readOnly) throw new Error("reader attempted SQL.run");
      return await database.run(statement, params);
    },
    async batch(statements) {
      mutations++;
      if (readOnly) throw new Error("reader attempted SQL.batch");
      return await database.batch(statements);
    },
  };
  const objects = new Map<string, StripeBillingObject>();
  const native = () => {
    nativeCalls++;
    if (readOnly) throw new Error("reader attempted processor call");
  };
  const callback = async () => {
    callbackCalls++;
    if (readOnly) throw new Error("reader attempted financial callback");
  };
  const client: StripeBillingClient = {
    async get(_kind, id) {
      native();
      return objects.get(id) ?? null;
    },
    async list() {
      native();
      return { data: [], hasMore: false };
    },
    async sessionLineItems() {
      native();
      return {
        data: [{ id: "li_original", price: OLD.stripePriceId, quantity: 1 }],
        hasMore: false,
      };
    },
    async post(kind, input) {
      native();
      if (kind === "subscriptions" && input.id && cancelEffect) {
        const subscription = objects.get(input.id);
        if (subscription) subscription.cancel_at_period_end = true;
      }
      throw new Error("lost processor acknowledgement");
    },
  };
  const make = (rotated = false) =>
    createSubscriptionCustody({
      sql,
      client,
      clock: () => new Date(AT),
      consoleOrigin: "https://console.example.test",
      plans: rotated
        ? [
            {
              planId: "hosted-50",
              stripePriceId: "price_rotated",
              monthlyAmountMinor: 5000,
              includedCreditMinor: 10000,
            },
          ]
        : [OLD],
      pricingRevision: rotated ? "revision-new" : "revision-original",
      effectiveAt: AT,
      validatePrice: callback,
      validateCustomer: callback,
      async ensureCustomer() {
        await callback();
        return "cus_original";
      },
      isConclusivePreflightFailure: () => false,
    });
  const custody = make();
  async function seed(
    reference: string,
    state: "prepared" | "dispatched" | "session_known" | "associated" | "expired" | "invalidated",
    suffix = reference,
  ) {
    const intent = `sci_${suffix}`,
      session = `cs_${suffix}`,
      subscription = `sub_${suffix}`;
    const known = ["session_known", "associated", "expired"].includes(state);
    await database.run(
      `INSERT INTO stripe_subscription_checkout_intents
      (id,org_id,request_key_digest,fingerprint,plan_key,pricing_revision,price_id,price_amount_minor,included_minor,livemode,customer_id,state,session_id,session_url,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,0,?,?,?,?,?,?)`,
      [
        intent,
        ORG,
        digest([ORG, reference]),
        digest([
          ORG,
          OLD.planId,
          "revision-original",
          OLD.stripePriceId,
          1000,
          2000,
          false,
          "subscription",
        ]),
        OLD.planId,
        "revision-original",
        OLD.stripePriceId,
        1000,
        2000,
        "cus_original",
        state === "associated" ? "session_known" : state,
        known ? session : null,
        known ? `https://checkout.stripe.com/c/pay/${session}` : null,
        AT,
        AT,
      ],
    );
    if (state === "associated") {
      const metadata = {
        organizationId: ORG,
        takoserverPurpose: "hosted_subscription",
        subscriptionCheckoutIntentId: intent,
        planKey: OLD.planId,
        pricingRevision: "revision-original",
      };
      objects.set(session, {
        id: session,
        object: "checkout.session",
        livemode: false,
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        customer: "cus_original",
        subscription,
        client_reference_id: intent,
        metadata,
        currency: "usd",
        amount_subtotal: 1000,
        amount_total: 1000,
        recovered_from: null,
        after_expiration: null,
      });
      objects.set(subscription, {
        id: subscription,
        object: "subscription",
        livemode: false,
        customer: "cus_original",
        metadata,
        currency: "usd",
        status: "active",
        cancel_at_period_end: false,
        current_period_start: Date.parse(AT) / 1000,
        current_period_end: Date.parse("2026-11-15T00:00:00.000Z") / 1000,
        schedule: null,
        items: { has_more: false, data: [{ price: OLD.stripePriceId, quantity: 1 }] },
      });
      objects.set("cus_original", {
        id: "cus_original",
        object: "customer",
        livemode: false,
        metadata: { organizationId: ORG, takoserverPurpose: "hosted_subscription" },
      });
      await custody.associateSession(session);
    }
    return { intent, session, subscription };
  }
  async function pure<T>(action: () => Promise<T>): Promise<T> {
    const before = { mutations, nativeCalls, callbackCalls };
    readOnly = true;
    try {
      return await action();
    } finally {
      readOnly = false;
      expect({ mutations, nativeCalls, callbackCalls }).toEqual(before);
    }
  }
  async function projection(subscription: string) {
    await database.run(
      `INSERT INTO stripe_billing_subscriptions
      (org_id,subscription_id,customer_id,plan_key,pricing_revision,status,cancel_at_period_end,period_start,period_end,paid_through,updated_at)
      VALUES(?,?,?,?,?,'active',0,?,?,NULL,?) ON CONFLICT(org_id) DO UPDATE SET subscription_id=excluded.subscription_id`,
      [
        ORG,
        subscription,
        "cus_original",
        OLD.planId,
        "revision-original",
        AT,
        "2026-11-15T00:00:00.000Z",
        AT,
      ],
    );
  }
  return {
    db,
    database,
    custody,
    make,
    seed,
    pure,
    projection,
    objects,
    get queries() {
      return queries;
    },
    loseCancelBeforeEffect() {
      cancelEffect = false;
    },
  };
}

describe("retained original START command reader", () => {
  test("unknown reference and another Org remain absent without effects", async () => {
    const f = await fixture();
    try {
      await f.seed("original", "associated");
      expect(await f.pure(() => f.custody.readStartCommand(ORG, "missing"))).toBeNull();
      expect(await f.pure(() => f.custody.readStartCommand("org_other", "original"))).toBeNull();
    } finally {
      f.db.close();
    }
  });
  test("prepared and genuinely lost-ACK dispatched commands stay pending after restart and tariff rotation", async () => {
    const f = await fixture();
    try {
      await f.seed("prepared", "prepared");
      const descriptor = await f.pure(() => f.make(true).readStartCommand(ORG, "prepared"));
      expect(descriptor).toEqual({
        organizationId: ORG,
        reference: "prepared",
        kind: "start",
        state: "pending",
        planKey: OLD.planId,
        pricingRevision: "revision-original",
        subscriptionRef: null,
        checkout: null,
      });
      await f.database.run(
        "UPDATE stripe_subscription_checkout_intents SET state='invalidated' WHERE id='sci_prepared'",
      );
      expect(await f.custody.begin(ORG, "lost-ack", OLD.planId)).toMatchObject({
        state: "pending",
      });
      expect(await f.pure(() => f.make(true).readStartCommand(ORG, "lost-ack"))).toMatchObject({
        reference: "lost-ack",
        state: "pending",
        pricingRevision: "revision-original",
        subscriptionRef: null,
        checkout: null,
      });
      expect(
        await f.database.query(
          "SELECT state FROM stripe_subscription_checkout_intents WHERE request_key_digest=?",
          [digest([ORG, "lost-ack"])],
        ),
      ).toEqual([{ state: "dispatched" }]);
    } finally {
      f.db.close();
    }
  });
  test("known Checkout projects only its retained verified URL and cannot refresh it", async () => {
    const f = await fixture();
    try {
      await f.seed("known", "session_known");
      expect(await f.pure(() => f.make(true).readStartCommand(ORG, "known"))).toMatchObject({
        state: "open",
        pricingRevision: "revision-original",
        subscriptionRef: null,
        checkout: { url: "https://checkout.stripe.com/c/pay/cs_known" },
      });
      await f.database.run(
        "UPDATE stripe_subscription_checkout_intents SET session_url='https://foreign.test/pay' WHERE id='sci_known'",
      );
      expect(await f.pure(() => f.custody.readStartCommand(ORG, "known"))).toMatchObject({
        state: "pending",
        checkout: null,
      });
      await f.database.run(
        "UPDATE stripe_subscription_checkout_intents SET session_url='https://checkout.stripe.com/c/pay/cs_known',recovery_conflict=1 WHERE id='sci_known'",
      );
      expect(await f.pure(() => f.custody.readStartCommand(ORG, "known"))).toMatchObject({
        state: "pending",
        checkout: null,
      });
    } finally {
      f.db.close();
    }
  });
  test("associated A stays bound to its original full tuple after B and changed current catalog", async () => {
    const f = await fixture();
    try {
      await f.seed("A", "associated");
      const a = await f.pure(() => f.custody.readStartCommand(ORG, "A"));
      expect(a).toMatchObject({
        reference: "A",
        kind: "start",
        state: "associated",
        planKey: OLD.planId,
        pricingRevision: "revision-original",
      });
      expect(a?.subscriptionRef).toMatch(/^sra_[a-f0-9]{64}$/u);
      const replacement = await f.seed("B", "associated");
      await f.projection(replacement.subscription);
      const b = await f.pure(() => f.custody.readStartCommand(ORG, "B"));
      expect(b?.subscriptionRef).not.toBe(a?.subscriptionRef);
      expect(await f.pure(() => f.make(true).readStartCommand(ORG, "A"))).toEqual(a);
      expect(Object.keys(a ?? {}).sort()).toEqual(
        [
          "organizationId",
          "reference",
          "kind",
          "state",
          "planKey",
          "pricingRevision",
          "subscriptionRef",
          "checkout",
        ].sort(),
      );
      expect(canonicalJson(a)).not.toContain("cus_");
      expect(canonicalJson(a)).not.toContain("price_");
    } finally {
      f.db.close();
    }
  });
  test.each(["expired", "invalidated"] as const)(
    "retains %s as a distinct recorded state",
    async (state) => {
      const f = await fixture();
      try {
        await f.seed("terminal", state);
        expect(await f.pure(() => f.make(true).readStartCommand(ORG, "terminal"))).toMatchObject({
          state,
          subscriptionRef: null,
          checkout: null,
          pricingRevision: "revision-original",
        });
      } finally {
        f.db.close();
      }
    },
  );
  test("stored fingerprint and historical association drift are refused without repair", async () => {
    const f = await fixture();
    try {
      await f.seed("A", "associated");
      await f.database.run(
        "UPDATE stripe_subscription_checkout_intents SET fingerprint='corrupt' WHERE id='sci_A'",
      );
      await expect(f.pure(() => f.custody.readStartCommand(ORG, "A"))).rejects.toMatchObject({
        code: "subscription_checkout_mismatch",
      });
      await f.database.run(
        "UPDATE stripe_subscription_checkout_intents SET fingerprint=? WHERE id='sci_A'",
        [
          digest([
            ORG,
            OLD.planId,
            "revision-original",
            OLD.stripePriceId,
            1000,
            2000,
            false,
            "subscription",
          ]),
        ],
      );
      await f.database.run(
        "UPDATE stripe_billing_associations SET included_minor=9999 WHERE subscription_id='sub_A'",
      );
      await expect(f.pure(() => f.custody.readStartCommand(ORG, "A"))).rejects.toMatchObject({
        code: "subscription_checkout_unresolved",
      });
    } finally {
      f.db.close();
    }
  });
  test("malformed references are rejected before any lookup or effect", async () => {
    const f = await fixture();
    try {
      const before = f.queries;
      await expect(f.pure(() => f.custody.readStartCommand(ORG, "../new"))).rejects.toMatchObject({
        code: "invalid_argument",
      });
      expect(f.queries).toBe(before);
    } finally {
      f.db.close();
    }
  });
});

describe("retained original native cancellation reader", () => {
  test("unknown reference and another Org cannot adopt a cancellation", async () => {
    const f = await fixture();
    try {
      expect(await f.pure(() => f.custody.readCancelCommand(ORG, "missing"))).toBeNull();
      expect(await f.pure(() => f.custody.readCancelCommand("org_other", "missing"))).toBeNull();
    } finally {
      f.db.close();
    }
  });
  test("lost-ACK pending cancellation never performs readback or invents effectiveAt", async () => {
    const f = await fixture();
    try {
      const a = await f.seed("A", "associated");
      await f.projection(a.subscription);
      const association = await f.custody.association(a.subscription);
      if (!association) throw new Error("missing original association");
      const ref = await f.custody.subscriptionRef(association);
      f.loseCancelBeforeEffect();
      expect(await f.custody.cancel(ORG, "cancel-original", ref)).toMatchObject({
        state: "pending",
      });
      const remote = f.objects.get(a.subscription);
      if (remote) remote.cancel_at_period_end = true;
      expect(await f.pure(() => f.make(true).readCancelCommand(ORG, "cancel-original"))).toEqual({
        organizationId: ORG,
        reference: "cancel-original",
        kind: "cancel",
        subscriptionRef: ref,
        planKey: OLD.planId,
        pricingRevision: "revision-original",
        state: "pending",
        effectiveAt: null,
        lifecycle: "pending",
      });
      expect(
        await f.database.query("SELECT state FROM stripe_subscription_cancellation_intents"),
      ).toEqual([{ state: "dispatched" }]);
    } finally {
      f.db.close();
    }
  });
  test("historical verified A receipt survives current B and a rotated tariff without asserting ended", async () => {
    const f = await fixture();
    try {
      const a = await f.seed("A", "associated");
      await f.projection(a.subscription);
      const association = await f.custody.association(a.subscription);
      if (!association) throw new Error("missing original association");
      const ref = await f.custody.subscriptionRef(association);
      expect(await f.custody.cancel(ORG, "cancel-original", ref)).toMatchObject({
        state: "verified",
      });
      const original = await f.pure(() => f.custody.readCancelCommand(ORG, "cancel-original"));
      expect(original).toEqual({
        organizationId: ORG,
        reference: "cancel-original",
        kind: "cancel",
        subscriptionRef: ref,
        planKey: OLD.planId,
        pricingRevision: "revision-original",
        state: "verified",
        effectiveAt: "2026-11-15T00:00:00.000Z",
        lifecycle: "scheduled",
      });
      const b = await f.seed("B", "associated");
      await f.projection(b.subscription);
      expect(await f.pure(() => f.make(true).readCancelCommand(ORG, "cancel-original"))).toEqual(
        original,
      );
      expect(
        await f.pure(() => f.custody.readCancelCommand("org_other", "cancel-original")),
      ).toBeNull();
      expect(canonicalJson(original)).not.toContain("cus_");
      expect(canonicalJson(original)).not.toContain("sub_A");
    } finally {
      f.db.close();
    }
  });
  test("corrupt original cancellation tuple is refused without repair", async () => {
    const f = await fixture();
    try {
      const a = await f.seed("A", "associated");
      await f.projection(a.subscription);
      const association = await f.custody.association(a.subscription);
      if (!association) throw new Error("missing original association");
      await f.custody.cancel(ORG, "cancel-original", await f.custody.subscriptionRef(association));
      await f.database.run(
        "UPDATE stripe_subscription_cancellation_intents SET fingerprint='corrupt'",
      );
      await expect(
        f.pure(() => f.custody.readCancelCommand(ORG, "cancel-original")),
      ).rejects.toMatchObject({ code: "subscription_management_conflict" });
    } finally {
      f.db.close();
    }
  });
});
