import { describe, expect, test } from "bun:test";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { TOP_UP_UNKNOWN_ACK_CUTOFF_MS } from "../src/org-top-up.ts";
import type { Sql } from "../src/ports.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  assertStripeCustomerCustodySchema,
  createStripeCustomerCustody,
} from "../src/stripe-customer-custody.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

async function fixture() {
  const { db, sql } = await createHostedBillingRealmTestDatabase();
  await seedHostedBillingRealmTestPin(sql, {
    accountId: "acct_customer",
    billingAuthority: "staging",
  });
  for (const org of ["org_shared", "org_existing", "org_other"])
    await sql.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES (?,?,?,?)", [
      org,
      org,
      "principal_fixture",
      "2026-10-15T00:00:00.000Z",
    ]);
  let time = Date.parse("2026-10-15T00:00:00.000Z");
  let lostAck = false;
  let hidden = false;
  let pages: { data: Record<string, unknown>[]; has_more: boolean }[] | undefined;
  const requests: Request[] = [];
  const customers = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, string>();
  const client = createStripeBillingClient({
    secretKey: "sk_test_fixture",
    async fetch(request) {
      requests.push(request);
      const url = new URL(request.url);
      if (url.pathname === "/v1/account")
        return Response.json({ id: "acct_customer", object: "account" });
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
      if (url.pathname === "/v1/customers" && request.method === "POST") {
        const key = request.headers.get("idempotency-key");
        if (!key) throw new Error("Missing customer key");
        let id = keys.get(key);
        if (!id) {
          id = `cus_created_${keys.size + 1}`;
          keys.set(key, id);
          const form = new URLSearchParams(await request.clone().text());
          const metadata = Object.fromEntries(
            [...form.entries()]
              .filter(([name]) => /^metadata\[/u.test(name))
              .map(([name, value]) => [name.slice(9, -1), value]),
          );
          customers.set(id, { id, object: "customer", livemode: false, metadata });
        }
        if (lostAck) {
          lostAck = false;
          throw new Error("Lost customer acknowledgement");
        }
        return Response.json(customers.get(id));
      }
      if (url.pathname === "/v1/customers")
        return Response.json(
          pages?.shift() ?? { data: hidden ? [] : [...customers.values()], has_more: false },
        );
      const customer = customers.get(url.pathname.split("/").at(-1) ?? "");
      return customer ? Response.json(customer) : new Response("", { status: 404 });
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: "acct_customer", mode: "test", billingAuthority: "staging" },
    prices: [{ priceId: "price_fixture", monthlyAmountMinor: 1000 }],
  });
  const make = (storage: Sql = sql) =>
    createStripeCustomerCustody({ sql: storage, clock: () => new Date(time), client, realm });
  return {
    db,
    sql,
    client,
    realm,
    customers,
    keys,
    requests,
    make,
    loseAck() {
      lostAck = true;
    },
    hideRecovery() {
      hidden = true;
    },
    setTime(value: number) {
      time = value;
    },
    pages(value: NonNullable<typeof pages>) {
      pages = value;
    },
  };
}

describe("same-authority durable Stripe customer custody", () => {
  test("startup refuses missing or weakened customer proof guards without repair", async () => {
    const fresh = await createHostedBillingRealmTestDatabase();
    await assertStripeCustomerCustodySchema(fresh.sql);
    fresh.db.exec(
      "DROP TRIGGER stripe_billing_customer_commands_immutable; CREATE TRIGGER stripe_billing_customer_commands_immutable BEFORE UPDATE ON stripe_billing_customer_commands BEGIN SELECT 1; END",
    );
    await expect(assertStripeCustomerCustodySchema(fresh.sql)).rejects.toMatchObject({
      code: "unavailable",
    });
    fresh.db.close();
    for (const name of [
      "stripe_billing_customer_commands_no_delete",
      "stripe_billing_customer_commands_verified_insert",
      "stripe_billing_customer_commands_verified_update",
    ]) {
      const { db, sql } = await createHostedBillingRealmTestDatabase();
      db.exec(`DROP TRIGGER ${name}`);
      await expect(assertStripeCustomerCustodySchema(sql)).rejects.toMatchObject({
        code: "unavailable",
      });
      db.close();
    }
    const missing = await createHostedBillingRealmTestDatabase();
    missing.db.exec("DROP TABLE stripe_billing_customer_commands");
    await expect(assertStripeCustomerCustodySchema(missing.sql)).rejects.toMatchObject({
      code: "unavailable",
    });
    missing.db.close();
  });
  test("an unknown Organization cannot create a processor customer", async () => {
    const f = await fixture();
    await expect(f.make().ensure("org_unknown")).rejects.toMatchObject({
      code: "invalid_argument",
    });
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    expect(
      f.db.query("SELECT COUNT(*) AS count FROM stripe_billing_customer_commands").get(),
    ).toEqual({ count: 0 });
  });
  test("concurrent subscription/top-up prerequisites elect one customer and durable receipt", async () => {
    const f = await fixture();
    const [topUpCustomer, subscriptionCustomer] = await Promise.all([
      f.make().ensure("org_shared"),
      f.make().ensure("org_shared"),
    ]);
    expect(topUpCustomer).toBe(subscriptionCustomer);
    expect(f.keys.size).toBe(1);
    expect(f.db.query("SELECT org_id,customer_id FROM stripe_billing_customers").all()).toEqual([
      { org_id: "org_shared", customer_id: topUpCustomer },
    ]);
    expect(
      f.db.query("SELECT state,customer_id FROM stripe_billing_customer_commands").get(),
    ).toEqual({ state: "verified", customer_id: topUpCustomer });
    const request = f.requests.find((request) => request.method === "POST");
    if (!request) throw new Error("Missing customer POST");
    const form = new URLSearchParams(await request.clone().text());
    expect(form.get("email")).toBeNull();
    expect(form.get("metadata[takoserverPurpose]")).toBe("hosted_subscription");
    expect(request.headers.get("stripe-account")).toBeNull();
  });

  test("lost customer ACK is recovered and associated without another create", async () => {
    const f = await fixture();
    f.loseAck();
    await expect(f.make().ensure("org_shared")).rejects.toMatchObject({ code: "unavailable" });
    expect(f.db.query("SELECT COUNT(*) AS count FROM stripe_billing_customers").get()).toEqual({
      count: 0,
    });
    expect(await f.make().ensure("org_shared")).toBe("cus_created_1");
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
  });

  test("unknown outcomes retain command and key; after23h they only read back", async () => {
    const f = await fixture();
    f.loseAck();
    f.hideRecovery();
    await expect(f.make().ensure("org_shared")).rejects.toMatchObject({ code: "unavailable" });
    f.setTime(Date.parse("2026-10-15T00:00:00.000Z") + TOP_UP_UNKNOWN_ACK_CUTOFF_MS);
    await expect(f.make().ensure("org_shared")).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
    expect(
      f.db.query("SELECT state,dispatched_at FROM stripe_billing_customer_commands").get(),
    ).toEqual({ state: "dispatched", dispatched_at: "2026-10-15T00:00:00.000Z" });
  });

  test("ambiguous customer recovery and foreign metadata cannot establish association", async () => {
    const f = await fixture();
    f.loseAck();
    await expect(f.make().ensure("org_shared")).rejects.toMatchObject({ code: "unavailable" });
    const remote = f.customers.get("cus_created_1");
    if (!remote) throw new Error("Missing customer");
    f.pages([{ data: [remote, { ...remote, id: "cus_duplicate" }], has_more: false }]);
    await expect(f.make().ensure("org_shared")).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    f.customers.set("cus_created_1", {
      ...remote,
      metadata: {
        ...(remote.metadata as Record<string, unknown>),
        financialRealm: "different-realm",
      },
    });
    await expect(f.make().ensure("org_shared")).rejects.toMatchObject({ code: "conflict" });
    expect(f.db.query("SELECT COUNT(*) AS count FROM stripe_billing_customers").get()).toEqual({
      count: 0,
    });
  });

  test("genuine existing custody is reused but an arbitrary remote customer is never adopted", async () => {
    const f = await fixture();
    f.customers.set("cus_existing", {
      id: "cus_existing",
      object: "customer",
      livemode: false,
      metadata: { organizationId: "org_existing", takoserverPurpose: "hosted_subscription" },
    });
    await f.sql.run(
      "INSERT INTO stripe_billing_customers(org_id,customer_id,created_at) VALUES(?,?,?)",
      ["org_existing", "cus_existing", "2026-10-15T00:00:00.000Z"],
    );
    expect(await f.make().ensure("org_existing")).toBe("cus_existing");
    expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(0);
    f.customers.set("cus_unbound", {
      id: "cus_unbound",
      object: "customer",
      livemode: false,
      metadata: { organizationId: "org_other" },
    });
    expect(await f.make().ensure("org_other")).toBe("cus_created_1");
    expect(
      f.db.query("SELECT customer_id FROM stripe_billing_customers WHERE org_id='org_other'").get(),
    ).toEqual({ customer_id: "cus_created_1" });
  });

  test("binding conflict rolls back receipt verification and never overwrites custody", async () => {
    const f = await fixture();
    f.loseAck();
    await expect(f.make().ensure("org_shared")).rejects.toMatchObject({ code: "unavailable" });
    await f.sql.run(
      "INSERT INTO stripe_billing_customers(org_id,customer_id,created_at) VALUES(?,?,?)",
      ["org_shared", "cus_other", "2026-10-15T00:00:00.000Z"],
    );
    await expect(f.make().ensure("org_shared")).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    expect(
      f.db.query("SELECT state,customer_id FROM stripe_billing_customer_commands").get(),
    ).toEqual({ state: "dispatched", customer_id: null });
    expect(f.db.query("SELECT customer_id FROM stripe_billing_customers").get()).toEqual({
      customer_id: "cus_other",
    });
  });

  test("customer command request, first dispatch, verified receipt and association are durable", async () => {
    const f = await fixture();
    await f.make().ensure("org_shared");
    for (const statement of [
      "UPDATE stripe_billing_customer_commands SET request_json='{}'",
      "UPDATE stripe_billing_customer_commands SET dispatched_at=NULL",
      "UPDATE stripe_billing_customer_commands SET customer_id='cus_other'",
      "DELETE FROM stripe_billing_customer_commands",
    ]) {
      await expect(f.sql.run(statement)).rejects.toMatchObject({ code: "constraint" });
    }
    expect(await f.make().ensure("org_shared")).toBe("cus_created_1");
  });
});
