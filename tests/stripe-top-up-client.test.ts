import { describe, expect, test } from "bun:test";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { createOrgTopUps, type TopUpCommand } from "../src/org-top-up.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { assertStripeCustomerBinding } from "../src/stripe-customer-custody.ts";
import {
  assertTopUpSessionCommand,
  createStripeTopUpClient,
  frozenTopUpExpiry,
} from "../src/stripe-top-up-client.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

async function fixture() {
  const { db, sql } = await createHostedBillingRealmTestDatabase();
  await seedHostedBillingRealmTestPin(sql, {
    accountId: "acct_adapter",
    billingAuthority: "staging",
  });
  const requests: Request[] = [];
  const sessions = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, string>();
  const customer: Record<string, unknown> = {
    id: "cus_adapter",
    object: "customer",
    livemode: false,
    metadata: { organizationId: "org_adapter", takoserverPurpose: "hosted_subscription" },
  };
  let lostAck = false;
  let pages: { data: Record<string, unknown>[]; has_more: boolean }[] | undefined;
  const transport = createStripeBillingClient({
    secretKey: "sk_test_fixture",
    async fetch(request) {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/account")
        return Response.json({ id: "acct_adapter", object: "account" });
      if (url.pathname === "/v1/prices/price_fixture")
        return Response.json({
          id: "price_fixture",
          object: "price",
          livemode: false,
          active: true,
          currency: "usd",
          unit_amount: 1000,
          type: "recurring",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      if (url.pathname === "/v1/customers/cus_adapter") return Response.json(customer);
      if (url.pathname === "/v1/checkout/sessions" && request.method === "POST") {
        const key = request.headers.get("idempotency-key");
        if (!key) throw new Error("Missing stable processor key");
        let id = keys.get(key);
        if (!id) {
          id = `cs_adapter_${keys.size + 1}`;
          keys.set(key, id);
          const form = new URLSearchParams(await request.clone().text());
          const metadata = Object.fromEntries(
            [...form.entries()]
              .filter(([name]) => /^metadata\[/u.test(name))
              .map(([name, value]) => [name.slice(9, -1), value]),
          );
          sessions.set(id, {
            id,
            object: "checkout.session",
            livemode: false,
            mode: "payment",
            customer: form.get("customer"),
            amount_total: Number(form.get("line_items[0][price_data][unit_amount]")),
            currency: "usd",
            metadata,
            status: "open",
            payment_status: "unpaid",
            payment_intent: null,
            url: `https://checkout.stripe.com/c/pay/${id}`,
          });
        }
        if (lostAck) {
          lostAck = false;
          throw new Error("Lost processor acknowledgement");
        }
        return Response.json(sessions.get(id));
      }
      if (url.pathname === "/v1/checkout/sessions")
        return Response.json(pages?.shift() ?? { data: [...sessions.values()], has_more: false });
      const found = sessions.get(url.pathname.split("/").at(-1) ?? "");
      return found ? Response.json(found) : new Response("", { status: 404 });
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client: transport },
    expected: { accountId: "acct_adapter", mode: "test", billingAuthority: "staging" },
    prices: [{ priceId: "price_fixture", monthlyAmountMinor: 1000 }],
  });
  await sql.run(
    "INSERT INTO stripe_billing_customers(org_id,customer_id,created_at) VALUES (?,?,?)",
    ["org_adapter", "cus_adapter", "2026-10-15T00:00:00.000Z"],
  );
  const context = { sql, client: transport, realm };
  const client = createStripeTopUpClient(context);
  const topUps = createOrgTopUps({
    sql,
    client,
    clock: () => new Date("2026-10-15T00:00:00.000Z"),
    bounds: { minimumMinor: 50, maximumMinor: 1000 },
    consoleOrigin: "https://console.test",
    pin: async () => ({
      customerId: "cus_adapter",
      accountId: realm.accountId,
      livemode: false,
      financialRealm: realm.financialRealm,
      pricingRevision: "revision-1",
      purchaseCreditExpiry: { kind: "fixed-duration", seconds: 86400 },
    }),
  });
  return {
    db,
    sql,
    context,
    client,
    topUps,
    sessions,
    keys,
    requests,
    customer,
    loseAck() {
      lostAck = true;
    },
    pages(value: NonNullable<typeof pages>) {
      pages = value;
    },
  };
}
const REQUEST = { organizationId: "org_adapter", reference: "purchase-1", amountMinor: 123 };

describe("existing Stripe transport top-up adapter", () => {
  test("lost-ACK replay rejects drifted customer realm before create, read, recovery or funding acknowledgement", async () => {
    const f = await fixture();
    f.loseAck();
    await expect(f.topUps.begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    const persisted = f.db
      .query("SELECT command_json,stripe_key FROM stripe_top_up_commands")
      .get() as { command_json: string; stripe_key: string };
    const command = JSON.parse(persisted.command_json) as TopUpCommand;
    const raw = f.sessions.get("cs_adapter_1");
    if (!raw) throw new Error("Missing original unacknowledged Checkout");
    const paid = {
      ...raw,
      id: "cs_adapter_1",
      status: "complete",
      payment_status: "paid",
      url: null,
    };
    for (const drift of [
      { metadata: { financialRealm: "realm:foreign" } },
      { metadata: { stripeAccountId: "acct_foreign" } },
      { object: "subscription" },
      { object: undefined },
    ]) {
      Object.assign(f.customer, { object: "customer", metadata: {} }, drift);
      await expect(f.topUps.begin(REQUEST)).rejects.toMatchObject({ code: "conflict" });
      await expect(f.client.create(command, persisted.stripe_key)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(f.client.read("cs_adapter_1", command)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(f.client.recover(command, persisted.stripe_key)).rejects.toMatchObject({
        code: "conflict",
      });
      await expect(assertTopUpSessionCommand(f.context, paid, command)).rejects.toMatchObject({
        code: "conflict",
      });
    }
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(
      f.db.query("SELECT state,session_id,session_url FROM stripe_top_up_commands").get(),
    ).toEqual({ state: "pending", session_id: null, session_url: null });
    expect(f.db.query("SELECT COUNT(*) AS count FROM stripe_billing_grants").get()).toEqual({
      count: 0,
    });
    expect(f.db.query("SELECT COUNT(*) AS count FROM wallet_credit_lots").get()).toEqual({
      count: 0,
    });
  });

  test("shared customer verifier rejects identity mismatch and preserves unmarked historical custody", async () => {
    const f = await fixture();
    const expected = {
      customerId: "cus_adapter",
      organizationId: "org_adapter",
      realm: f.context.realm,
    };
    expect(() =>
      assertStripeCustomerBinding(
        { id: "cus_foreign", object: "customer", livemode: false },
        expected,
      ),
    ).toThrow();
    expect(() =>
      assertStripeCustomerBinding(
        { id: undefined as unknown as string, object: "customer", livemode: false },
        expected,
      ),
    ).toThrow();
    f.customer.metadata = {};
    expect((await f.topUps.begin(REQUEST)).url).toContain("cs_adapter_1");
  });
  test("pins customer, cash, realm, policy and stable key in Session and PaymentIntent", async () => {
    const f = await fixture();
    const first = await f.topUps.begin(REQUEST);
    expect(await f.topUps.begin(REQUEST)).toEqual(first);
    const posted = f.requests.find((request) => request.method === "POST");
    if (!posted) throw new Error("Missing Checkout POST");
    const form = new URLSearchParams(await posted.clone().text());
    expect(posted.url).toBe("https://api.stripe.com/v1/checkout/sessions");
    expect(posted.headers.get("stripe-account")).toBeNull();
    expect(posted.headers.get("stripe-version")).toBe("2024-06-20");
    expect(form.get("customer")).toBe("cus_adapter");
    expect(form.get("line_items[0][price_data][unit_amount]")).toBe("123");
    for (const name of [
      "organizationId",
      "financialRealm",
      "pricingRevision",
      "purchaseCreditExpiry",
      "topUpCommandDigest",
      "topUpIdempotencyKey",
    ]) {
      expect(form.get(`metadata[${name}]`)).toBe(
        form.get(`payment_intent_data[metadata][${name}]`),
      );
    }
    expect(f.keys.size).toBe(1);
  });

  test("lost acknowledgement recovers by exact customer command metadata without another POST", async () => {
    const f = await fixture();
    f.loseAck();
    await expect(f.topUps.begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    expect((await f.topUps.begin(REQUEST)).url).toContain("cs_adapter_1");
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    const listed = f.requests.find(
      (request) =>
        request.method === "GET" && new URL(request.url).pathname === "/v1/checkout/sessions",
    );
    expect(new URL(listed?.url ?? "https://missing.test").searchParams.get("customer")).toBe(
      "cus_adapter",
    );
  });

  test("ambiguous or truncated recovery never acknowledges an arbitrary match", async () => {
    const f = await fixture();
    f.loseAck();
    await expect(f.topUps.begin(REQUEST)).rejects.toMatchObject({ code: "unavailable" });
    const session = f.sessions.get("cs_adapter_1");
    if (!session) throw new Error("Missing Checkout");
    f.pages([{ data: [session, { ...session, id: "cs_adapter_duplicate" }], has_more: false }]);
    await expect(f.topUps.begin(REQUEST)).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    f.pages(
      Array.from({ length: 10 }, (_, index) => ({
        data: [
          { id: `cs_page_${index}`, object: "checkout.session", livemode: false, metadata: {} },
        ],
        has_more: true,
      })),
    );
    await expect(f.topUps.begin(REQUEST)).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("existing writer helper verifies original policy and expanded payment tuple", async () => {
    const f = await fixture();
    await f.topUps.begin(REQUEST);
    const command = await f.topUps.commandForSession("cs_adapter_1");
    const raw = f.sessions.get("cs_adapter_1");
    if (!command || !raw) throw new Error("Missing original purchase proof");
    const paid = {
      ...raw,
      id: "cs_adapter_1",
      status: "complete",
      payment_status: "paid",
      url: null,
      payment_intent: {
        id: "pi_adapter",
        livemode: false,
        customer: command.customerId,
        currency: "usd",
        amount: command.amountMinor,
        metadata: raw.metadata,
      },
    };
    expect((await assertTopUpSessionCommand(f.context, paid, command)).paymentStatus).toBe("paid");
    await expect(
      assertTopUpSessionCommand(f.context, { ...paid, amount_total: 124 }, command),
    ).rejects.toMatchObject({ code: "conflict" });
    await expect(
      assertTopUpSessionCommand(
        f.context,
        { ...paid, payment_intent: { ...paid.payment_intent, customer: "cus_foreign" } },
        command,
      ),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(frozenTopUpExpiry(command, "2026-10-18T00:00:00.000Z")).toBe("2026-10-19T00:00:00.000Z");
    expect(
      frozenTopUpExpiry(
        { ...command, purchaseCreditExpiry: { kind: "none" } } as TopUpCommand,
        "2026-10-18T00:00:00.000Z",
      ),
    ).toBeNull();
  });

  test("structural realm, different client, and caller-selected customer cannot activate transport", async () => {
    const f = await fixture();
    expect(() =>
      createStripeTopUpClient({ ...f.context, realm: { ...f.context.realm } }),
    ).toThrow();
    expect(() =>
      createStripeTopUpClient({ ...f.context, client: { ...f.context.client } }),
    ).toThrow();
    await f.topUps.begin(REQUEST);
    const command = await f.topUps.commandForSession("cs_adapter_1");
    if (!command) throw new Error("Missing purchase command");
    await expect(
      f.client.create({ ...command, customerId: "cus_foreign" }, "foreign-key"),
    ).rejects.toMatchObject({ code: "conflict" });
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });
});
