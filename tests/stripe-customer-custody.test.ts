import { describe, expect, test } from "bun:test";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
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
  const { db, sql: base } = await createHostedBillingRealmTestDatabase();
  let readOnly = false;
  let afterPrepare: (() => void) | undefined;
  let duringPost: (() => void) | undefined;
  const queries: string[] = [];
  const sql: Sql = {
    async query(statement, params) {
      queries.push(statement);
      if (readOnly && !/^\s*SELECT\b/iu.test(statement)) throw new Error("Non-SELECT inspection");
      return await base.query(statement, params);
    },
    async run(...args) {
      if (readOnly) throw new Error("Inspection wrote SQL");
      const result = await base.run(...args);
      if (args[0].startsWith("INSERT OR IGNORE INTO stripe_billing_customer_commands")) {
        const action = afterPrepare;
        afterPrepare = undefined;
        action?.();
      }
      return result;
    },
    async batch(...args) {
      if (readOnly) throw new Error("Inspection batched SQL");
      return await base.batch(...args);
    },
  };
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
  let beforeRecovery: (() => Promise<void>) | undefined;
  const requests: Request[] = [];
  const customers = new Map<string, Record<string, unknown>>();
  const keys = new Map<string, string>();
  const client = createStripeBillingClient({
    secretKey: "sk_test_fixture",
    async fetch(request) {
      if (readOnly) throw new Error("Inspection called processor");
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
        const action = duringPost;
        duringPost = undefined;
        action?.();
        if (lostAck) {
          lostAck = false;
          throw new Error("Lost customer acknowledgement");
        }
        return Response.json(customers.get(id));
      }
      if (url.pathname === "/v1/customers") {
        const action = beforeRecovery;
        beforeRecovery = undefined;
        await action?.();
        return Response.json(
          pages?.shift() ?? { data: hidden ? [] : [...customers.values()], has_more: false },
        );
      }
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
    createStripeCustomerCustody({
      sql: storage,
      clock: () => {
        if (readOnly) throw new Error("Inspection read clock");
        return new Date(time);
      },
      client,
      realm,
    });
  return {
    db,
    sql,
    client,
    realm,
    customers,
    keys,
    requests,
    queries,
    denyEffects() {
      readOnly = true;
      queries.length = 0;
    },
    beforeRecovery(action: () => Promise<void>) {
      beforeRecovery = action;
    },
    afterPrepare(action: () => void) {
      afterPrepare = action;
    },
    duringPost(action: () => void) {
      duringPost = action;
    },
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

async function prepared(
  f: Awaited<ReturnType<typeof fixture>>,
  change?: (row: Record<string, unknown>) => void,
) {
  const realm = {
    accountId: f.realm.accountId,
    financialRealm: f.realm.financialRealm,
    livemode: false,
    billingAuthority: f.realm.billingAuthority,
  };
  const digest = await canonicalDigest({
    organizationId: "org_shared",
    realm,
    purpose: "hosted_subscription",
  });
  const key = `takoserver_customer_${digest.slice(7)}`;
  const command = {
    organizationId: "org_shared",
    realm,
    metadata: {
      organizationId: "org_shared",
      takoserverPurpose: "hosted_subscription",
      stripeAccountId: realm.accountId,
      financialRealm: realm.financialRealm,
      customerCreationCommand: digest,
      customerCreationKey: key,
    },
  };
  const row: Record<string, unknown> = {
    org_id: "org_shared",
    realm_json: canonicalJson(realm),
    request_json: canonicalJson(command),
    fingerprint: await canonicalDigest(command),
    stripe_key: key,
    state: "prepared",
    dispatched_at: null,
    customer_id: null,
    created_at: "2026-10-15T00:00:00.000Z",
    verified_at: null,
  };
  change?.(row);
  const fields = Object.keys(row);
  await f.sql.run(
    `INSERT INTO stripe_billing_customer_commands (${fields.join(",")}) VALUES (${fields.map(() => "?").join(",")})`,
    fields.map((field) => row[field] as string | null),
  );
}

describe("same-authority durable Stripe customer custody", () => {
  test("inspection is one SQL-only redacted frozen snapshot, including unobserved and legacy custody", async () => {
    for (const state of ["unobserved", "prepared", "dispatched", "verified", "legacy"] as const) {
      const f = await fixture();
      try {
        if (state === "prepared") await prepared(f);
        if (state === "dispatched") {
          f.loseAck();
          await expect(f.make().ensure("org_shared")).rejects.toMatchObject({
            code: "unavailable",
          });
        }
        if (state === "verified") await f.make().ensure("org_shared");
        if (state === "legacy")
          await f.sql.run("INSERT INTO stripe_billing_customers VALUES (?,?,?)", [
            "org_shared",
            "cus_legacy",
            "2026-10-14 00:00:00",
          ]);
        const postCount = f.requests.length;
        const service = f.make();
        f.denyEffects();
        const result = await service.inspect("org_shared");
        expect(f.queries).toHaveLength(1);
        expect(f.requests).toHaveLength(postCount);
        expect(Object.isFrozen(result)).toBe(true);
        expect(Object.keys(result).sort()).toEqual(["binding", "command", "organizationId"]);
        expect(result.organizationId).toBe("org_shared");
        expect(result.command?.state ?? null).toBe(
          state === "unobserved" || state === "legacy" ? null : state,
        );
        expect(result.binding?.customerId ?? null).toBe(
          state === "legacy" ? "cus_legacy" : state === "verified" ? "cus_created_1" : null,
        );
        if (result.command) {
          expect(Object.isFrozen(result.command)).toBe(true);
          expect(Object.keys(result.command).sort()).toEqual([
            "createdAt",
            "customerId",
            "dispatchedAt",
            "fingerprint",
            "state",
            "verifiedAt",
          ]);
        }
        if (result.binding) expect(Object.isFrozen(result.binding)).toBe(true);
        if (state === "legacy") expect(result.binding?.createdAt).toBe("2026-10-14 00:00:00");
        expect(JSON.stringify(result)).not.toContain("takoserver_customer_");
        expect(JSON.stringify(result)).not.toContain("metadata");
        await expect(service.inspect("org_unknown")).rejects.toMatchObject({
          code: "invalid_argument",
        });
      } finally {
        f.db.close();
      }
    }
  });

  test("actual ensure and inspection reject malformed original tuples before native effects", async () => {
    const changes: ((row: Record<string, unknown>) => void)[] = [
      (row) => {
        row.request_json = "{}";
      },
      (row) => {
        const request = JSON.parse(String(row.request_json));
        request.organizationId = "org_other";
        row.request_json = canonicalJson(request);
      },
      (row) => {
        const request = JSON.parse(String(row.request_json));
        request.realm.financialRealm = "other";
        row.request_json = canonicalJson(request);
      },
      (row) => {
        const request = JSON.parse(String(row.request_json));
        request.metadata.takoserverPurpose = "other";
        row.request_json = canonicalJson(request);
      },
      (row) => {
        const request = JSON.parse(String(row.request_json));
        request.unreviewed = true;
        row.request_json = canonicalJson(request);
      },
      (row) => {
        row.request_json = String(row.request_json).replace("{", '{"organizationId":"org_other",');
      },
      (row) => {
        row.realm_json = canonicalJson({ financialRealm: "wrong" });
      },
      (row) => {
        row.fingerprint = `sha256:${"0".repeat(64)}`;
      },
      (row) => {
        row.stripe_key = "foreign-customer-key";
      },
      (row) => {
        row.created_at = "not-an-instant";
      },
      (row) => {
        row.dispatched_at = "2026-10-15T00:00:00.000Z";
      },
      (row) => {
        row.state = "dispatched";
      },
      (row) => {
        row.state = "dispatched";
        row.dispatched_at = "2026-10-14 00:00:00";
      },
    ];
    for (const change of changes) {
      const f = await fixture();
      try {
        await prepared(f, change);
        const original = f.db.query("SELECT * FROM stripe_billing_customer_commands").all();
        const requests = f.requests.length;
        await expect(f.make().inspect("org_shared")).rejects.toMatchObject({ code: "conflict" });
        await expect(f.make().ensure("org_shared")).rejects.toMatchObject({ code: "conflict" });
        expect(f.requests).toHaveLength(requests);
        expect(f.db.query("SELECT * FROM stripe_billing_customer_commands").all()).toEqual(
          original,
        );
        expect(f.db.query("SELECT * FROM stripe_billing_customers").all()).toEqual([]);
      } finally {
        f.db.close();
      }
    }
  });

  test("writer ISO timestamps retain the complete final millisecond of year 9999", async () => {
    const f = await fixture();
    try {
      const finalInstant = "9999-12-31T23:59:59.999Z";
      await prepared(f, (row) => {
        row.created_at = finalInstant;
      });
      f.setTime(Date.parse(finalInstant));
      expect((await f.make().inspect("org_shared")).command?.createdAt).toBe(finalInstant);
      expect(await f.make().ensure("org_shared")).toBe("cus_created_1");
      expect((await f.make().inspect("org_shared")).command).toMatchObject({
        state: "verified",
        createdAt: finalInstant,
        dispatchedAt: finalInstant,
        verifiedAt: finalInstant,
      });
    } finally {
      f.db.close();
    }
  });

  for (const instant of ["+010000-01-01T00:00:00.000Z", "-000001-01-01T00:00:00.000Z"]) {
    test(`actual ensure retains canonical expanded-year ${instant} through inspect and replay`, async () => {
      const f = await fixture();
      try {
        f.setTime(Date.parse(instant));
        expect(await f.make().ensure("org_shared")).toBe("cus_created_1");
        const original = await f.make().inspect("org_shared");
        expect(original.command).toMatchObject({
          state: "verified",
          createdAt: instant,
          dispatchedAt: instant,
          verifiedAt: instant,
        });
        const rows = f.db.query("SELECT * FROM stripe_billing_customer_commands").all();
        expect(await f.make().ensure("org_shared")).toBe("cus_created_1");
        expect(await f.make().inspect("org_shared")).toEqual(original);
        expect(f.db.query("SELECT * FROM stripe_billing_customer_commands").all()).toEqual(rows);
        expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
        expect(f.keys.size).toBe(1);
      } finally {
        f.db.close();
      }
    });
  }

  test("invalid binding and noncanonical verified timestamps refuse before native reads or writes", async () => {
    for (const kind of ["binding", "verified-time"] as const) {
      const f = await fixture();
      try {
        await f.sql.run("INSERT INTO stripe_billing_customers VALUES (?,?,?)", [
          "org_shared",
          kind === "binding" ? "malformed" : "cus_verified",
          "2026-10-14 00:00:00",
        ]);
        if (kind === "verified-time")
          await prepared(f, (row) => {
            row.state = "verified";
            row.customer_id = "cus_verified";
            row.dispatched_at = "2026-10-15T00:00:00.000Z";
            row.verified_at = "not-an-instant";
          });
        const requests = f.requests.length;
        await expect(f.make().inspect("org_shared")).rejects.toMatchObject({ code: "conflict" });
        await expect(f.make().ensure("org_shared")).rejects.toMatchObject({ code: "conflict" });
        expect(f.requests).toHaveLength(requests);
      } finally {
        f.db.close();
      }
    }
  });

  for (const phase of ["afterPrepare", "duringPost"] as const) {
    test(`actual ensure preserves its original custody during ${phase} wall-clock rollback`, async () => {
      const f = await fixture();
      try {
        const createdAt = "2026-10-15T00:00:00.000Z";
        const rolledBack = "2026-10-14T23:59:59.999Z";
        f[phase](() => f.setTime(Date.parse(rolledBack)));
        expect(await f.make().ensure("org_shared")).toBe("cus_created_1");
        const original = await f.make().inspect("org_shared");
        expect(original.command).toMatchObject({
          state: "verified",
          createdAt,
          dispatchedAt: phase === "afterPrepare" ? rolledBack : createdAt,
          verifiedAt: rolledBack,
          customerId: "cus_created_1",
        });
        const rows = f.db.query("SELECT * FROM stripe_billing_customer_commands").all();
        f.setTime(Date.parse(rolledBack) - 1);
        expect(await f.make().ensure("org_shared")).toBe("cus_created_1");
        expect(await f.make().inspect("org_shared")).toEqual(original);
        expect(f.db.query("SELECT * FROM stripe_billing_customer_commands").all()).toEqual(rows);
        expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
        expect(f.keys.size).toBe(1);
      } finally {
        f.db.close();
      }
    });
  }

  test("a binding appearing during unknown recovery prevents another original-key POST", async () => {
    const f = await fixture();
    try {
      f.loseAck();
      await expect(f.make().ensure("org_shared")).rejects.toMatchObject({ code: "unavailable" });
      f.hideRecovery();
      f.beforeRecovery(async () => {
        await f.sql.run("INSERT INTO stripe_billing_customers VALUES (?,?,?)", [
          "org_shared",
          "cus_other",
          "2026-10-14 00:00:00",
        ]);
      });
      await expect(f.make().ensure("org_shared")).rejects.toMatchObject({
        code: "reconciliation_required",
      });
      expect(f.requests.filter((request) => request.method === "POST")).toHaveLength(1);
      expect((await f.make().inspect("org_shared")).command?.state).toBe("dispatched");
      expect(f.db.query("SELECT customer_id FROM stripe_billing_customers").get()).toEqual({
        customer_id: "cus_other",
      });
    } finally {
      f.db.close();
    }
  });
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
      ["org_existing", "cus_existing", "2026-10-14 00:00:00"],
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
