import { afterEach, describe, expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import {
  assertHostedBillingFinancialRealm,
  bindFreshHostedBillingRealm,
  type HostedBillingFinancialRealm,
  type HostedBillingRealmQualification,
  verifyHostedBillingFinancialRealm,
} from "../src/hosted-billing-realm.ts";
import { type Sql, SqlError } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import {
  createStripeBillingClient,
  type StripeBillingClient,
  type StripeBillingObject,
} from "../src/stripe-billing-client.ts";
import {
  createHostedBillingRealmTestDatabase,
  HOSTED_BILLING_REALM_TEST_INSTANT,
  hostedBillingRealmTestMigrations,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

const ACCOUNT = "acct_realmtest123";
const AUTHORITY = "hosted-staging-authority";
const PRICE = "price_hosted_realm_test";
const PRICE_TERMS = [{ priceId: PRICE, monthlyAmountMinor: 1000 }] as const;
const EXPECTED = { accountId: ACCOUNT, mode: "test", billingAuthority: AUTHORITY } as const;
const NOW = HOSTED_BILLING_REALM_TEST_INSTANT;
const close = new Set<() => void>();
afterEach(() => {
  for (const dispose of close) dispose();
  close.clear();
});

function price(overrides: Record<string, unknown> = {}): StripeBillingObject {
  return {
    id: PRICE,
    object: "price",
    livemode: false,
    currency: "usd",
    type: "recurring",
    billing_scheme: "per_unit",
    unit_amount: 1000,
    recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
    ...overrides,
  };
}

function processor(input: { account?: unknown; price?: StripeBillingObject | null } = {}) {
  const calls: string[] = [];
  const client: StripeBillingClient = {
    async authenticAccount() {
      calls.push("account");
      return (
        input.account === undefined ? { id: ACCOUNT, object: "account" } : input.account
      ) as StripeBillingObject;
    },
    async get(kind, id) {
      calls.push(`${kind}:${id}`);
      if (kind !== "prices" || id !== PRICE) throw new Error("unexpected read");
      return input.price === undefined ? price() : input.price;
    },
    async list() {
      throw new Error("unexpected list");
    },
    async sessionLineItems() {
      throw new Error("realm qualification must not read a Checkout line item");
    },
    async post() {
      throw new Error("financial realm qualification must not mutate Stripe");
    },
  };
  const reader = { client };
  return { reader, client, calls };
}

async function fixture(input: Parameters<typeof processor>[0] = {}) {
  const database = await createHostedBillingRealmTestDatabase();
  close.add(() => database.db.close());
  const remote = processor(input);
  const options: HostedBillingRealmQualification = {
    sql: database.sql,
    reader: remote.reader,
    expected: EXPECTED,
    prices: PRICE_TERMS,
  };
  return { ...database, ...remote, options };
}

async function rowCount(sql: Sql) {
  return await sql.query("SELECT COUNT(*) AS count FROM stripe_billing_account_realms");
}

function code(value: string) {
  return expect.objectContaining({ code: value });
}

describe("authenticated Hosted billing financial realm", () => {
  test("startup refuses an empty realm and never writes or reads the processor", async () => {
    const { sql, calls, options } = await fixture();
    const readonly: Sql = {
      query: sql.query.bind(sql),
      async run() {
        throw new Error("unexpected startup write");
      },
      async batch() {
        throw new Error("unexpected startup batch");
      },
    };
    await expect(verifyHostedBillingFinancialRealm({ ...options, sql: readonly })).rejects.toThrow(
      code("realm_unbound"),
    );
    expect(calls).toEqual([]);
    expect(await rowCount(sql)).toEqual([{ count: 0 }]);
  });

  test("only explicit fresh binding mints a frozen same-client, same-database proof", async () => {
    const { sql, client, calls, options } = await fixture();
    const realm = await bindFreshHostedBillingRealm({ ...options, clock: () => new Date(NOW) });
    expect(realm).toMatchObject({ ...EXPECTED, livemode: false, prices: PRICE_TERMS });
    expect(realm.financialRealm).toMatch(/^realm:[0-9a-f]{64}$/u);
    expect(Object.isFrozen(realm)).toBe(true);
    expect(Object.isFrozen(realm.prices)).toBe(true);
    expect(calls).toEqual(["account", `prices:${PRICE}`]);
    assertHostedBillingFinancialRealm(realm, { sql, client, billingAuthority: AUTHORITY });
    const context = { sql, client, billingAuthority: AUTHORITY };
    for (const invalid of [{ ...realm }, Object.create(realm), { ...realm, livemode: true }]) {
      expect(() =>
        assertHostedBillingFinancialRealm(invalid as HostedBillingFinancialRealm, context),
      ).toThrow(code("unqualified_realm"));
    }
    expect(() =>
      assertHostedBillingFinancialRealm(realm, {
        ...context,
        client: processor().client,
      }),
    ).toThrow(code("unqualified_realm"));
    expect(() =>
      assertHostedBillingFinancialRealm(realm, {
        ...context,
        sql: { ...sql },
      }),
    ).toThrow(code("unqualified_realm"));
    expect(() =>
      assertHostedBillingFinancialRealm(realm, { ...context, billingAuthority: "foreign" }),
    ).toThrow(code("unqualified_realm"));
    assertHostedBillingFinancialRealm(realm, { ...context, prices: PRICE_TERMS });
    expect(() =>
      assertHostedBillingFinancialRealm(realm, {
        ...context,
        prices: [...PRICE_TERMS, { priceId: "price_extra", monthlyAmountMinor: 5000 }],
      }),
    ).toThrow(code("unqualified_realm"));
  });

  test("same-account key rotation requalifies while populated restart stays read-only", async () => {
    const { sql, options } = await fixture();
    const first = await bindFreshHostedBillingRealm({ ...options, clock: () => new Date(NOW) });
    await sql.run("INSERT INTO stripe_billing_pricing VALUES (?, ?)", ["existing", "{}"]);
    const rotated = processor();
    const second = await verifyHostedBillingFinancialRealm({ ...options, reader: rotated.reader });
    expect(second.financialRealm).toBe(first.financialRealm);
    expect(await rowCount(sql)).toEqual([{ count: 1 }]);
    assertHostedBillingFinancialRealm(second, {
      sql,
      client: rotated.client,
      billingAuthority: AUTHORITY,
    });
    expect(() =>
      assertHostedBillingFinancialRealm(first, {
        sql,
        client: rotated.client,
        billingAuthority: AUTHORITY,
      }),
    ).toThrow(code("unqualified_realm"));
  });

  test("two real clients cannot combine one account read with another client's TEST Price", async () => {
    const { sql, options } = await fixture();
    await seedHostedBillingRealmTestPin(sql, EXPECTED);
    const readsA: string[] = [];
    const readsB: string[] = [];
    function actualClient(accountId: string, priceId: string, reads: string[]) {
      return createStripeBillingClient({
        secretKey: "sk_test_fixture",
        mode: "test",
        async fetch(request) {
          const path = new URL(request.url).pathname;
          reads.push(path);
          if (request.method !== "GET" || request.headers.has("stripe-account"))
            throw new Error("unexpected processor mutation or connected account");
          if (path === "/v1/account") return Response.json({ id: accountId, object: "account" });
          if (path === `/v1/prices/${priceId}`) return Response.json(price({ id: priceId }));
          throw new Error("unexpected processor request");
        },
      });
    }
    const own = actualClient(ACCOUNT, PRICE, readsA);
    const foreignPrice = "price_foreign_client";
    const foreign = actualClient("acct_foreign123", foreignPrice, readsB);
    let independentReads = 0;
    // This is the original attack shape. The extra callback remains a normal
    // structural JS property; qualification must never call or trust it.
    const mixedReader = {
      client: foreign,
      async readAuthenticatedAccount() {
        independentReads += 1;
        if (!own.authenticAccount) throw new Error("missing owned account reader");
        return await own.authenticAccount();
      },
    };
    const attack = {
      ...options,
      reader: mixedReader,
      prices: [{ priceId: foreignPrice, monthlyAmountMinor: 1000 }],
    };
    await expect(verifyHostedBillingFinancialRealm(attack)).rejects.toThrow(code("realm_mismatch"));
    expect(independentReads).toBe(0);
    expect(readsA).toEqual([]);
    expect(readsB).toEqual(["/v1/account"]);

    const fresh = await createHostedBillingRealmTestDatabase();
    close.add(() => fresh.db.close());
    await expect(
      bindFreshHostedBillingRealm({ ...attack, sql: fresh.sql, clock: () => new Date(NOW) }),
    ).rejects.toThrow(code("realm_mismatch"));
    expect(await rowCount(fresh.sql)).toEqual([{ count: 0 }]);
    expect(independentReads).toBe(0);

    let accessorReads = 0;
    const realm = await verifyHostedBillingFinancialRealm({
      ...options,
      reader: {
        get client() {
          accessorReads += 1;
          return accessorReads === 1 ? own : foreign;
        },
      },
    });
    expect(accessorReads).toBe(1);
    expect(readsA).toEqual(["/v1/account", `/v1/prices/${PRICE}`]);
    assertHostedBillingFinancialRealm(realm, { sql, client: own, billingAuthority: AUTHORITY });
    expect(() =>
      assertHostedBillingFinancialRealm(realm, {
        sql,
        client: foreign,
        billingAuthority: AUTHORITY,
      }),
    ).toThrow(code("unqualified_realm"));
  });

  test("a legacy client without its own authenticated account read cannot be upgraded by a callback", async () => {
    const { sql, options, calls } = await fixture();
    await seedHostedBillingRealmTestPin(sql, EXPECTED);
    const client = { ...options.reader.client };
    delete client.authenticAccount;
    const reader = {
      client,
      async readAuthenticatedAccount() {
        throw new Error("an independent account callback must not qualify a legacy client");
      },
    };
    await expect(verifyHostedBillingFinancialRealm({ ...options, reader })).rejects.toThrow(
      code("invalid_configuration"),
    );
    expect(calls).toEqual([]);
  });

  test("account identity is not a caller boolean, mode selector or inferred secret prefix", async () => {
    const { sql, options, calls } = await fixture();
    await seedHostedBillingRealmTestPin(sql, EXPECTED);
    for (const expected of [
      { ...EXPECTED, mode: "live" },
      { ...EXPECTED, billingAuthority: 123 },
      { ...EXPECTED, accountId: "acct_wrong_id" },
    ]) {
      await expect(
        verifyHostedBillingFinancialRealm({
          ...options,
          expected: expected as unknown as HostedBillingRealmQualification["expected"],
        }),
      ).rejects.toThrow(code("invalid_configuration"));
    }
    await expect(verifyHostedBillingFinancialRealm({ ...options, prices: [] })).rejects.toThrow(
      code("invalid_configuration"),
    );
    expect(calls).toEqual([]);
    const accountOnly = processor({ account: { id: ACCOUNT, object: "account", livemode: false } });
    await expect(
      verifyHostedBillingFinancialRealm({
        ...options,
        reader: accountOnly.reader,
        prices: [],
      }),
    ).rejects.toThrow(code("invalid_configuration"));
    expect(accountOnly.calls).toEqual([]);
  });

  test("foreign authenticated accounts and mode-less or malformed Price facts are refused", async () => {
    const cases: Exclude<Parameters<typeof processor>[0], undefined>[] = [
      { account: { id: "acct_foreign123", object: "account" } },
      { account: { id: ACCOUNT, object: "customer" } },
      { account: { id: ACCOUNT, object: "account", deleted: true } },
      { account: false },
      { price: null },
      { price: price({ id: "price_foreign" }) },
      { price: price({ object: "product" }) },
      { price: price({ livemode: true }) },
      { price: price({ livemode: undefined }) },
      { price: price({ currency: "jpy" }) },
      { price: price({ unit_amount: 5000 }) },
      { price: price({ billing_scheme: "tiered" }) },
      { price: price({ transform_quantity: { divide_by: 2, round: "up" } }) },
      { price: price({ account: "acct_connected" }) },
      {
        price: price({
          recurring: { interval: "year", interval_count: 1, usage_type: "licensed" },
        }),
      },
      {
        price: price({
          recurring: { interval: "month", interval_count: 1, usage_type: "metered" },
        }),
      },
    ];
    const { options, sql } = await fixture();
    for (const input of cases) {
      const remote = processor(input);
      await expect(
        bindFreshHostedBillingRealm({
          ...options,
          reader: remote.reader,
          clock: () => new Date(NOW),
        }),
      ).rejects.toThrow(
        code(
          input.account && (input.account as { id?: string }).id === "acct_foreign123"
            ? "realm_mismatch"
            : "invalid_processor_proof",
        ),
      );
      expect(await rowCount(sql)).toEqual([{ count: 0 }]);
    }
  });

  test("account or authority drift cannot reinterpret an existing immutable pin", async () => {
    const { sql, options, calls } = await fixture();
    await seedHostedBillingRealmTestPin(sql, EXPECTED);
    for (const expected of [
      { ...EXPECTED, accountId: "acct_other123" },
      { ...EXPECTED, billingAuthority: "other-authority" },
    ])
      await expect(verifyHostedBillingFinancialRealm({ ...options, expected })).rejects.toThrow(
        code("realm_mismatch"),
      );
    expect(calls).toEqual([]);
    for (const statement of [
      "UPDATE stripe_billing_account_realms SET account_id = 'acct_other123'",
      "DELETE FROM stripe_billing_account_realms",
      `INSERT OR REPLACE INTO stripe_billing_account_realms VALUES (1, 'acct_other123', 'test', 'other', '${NOW}')`,
    ])
      await expect(sql.run(statement)).rejects.toThrow(
        expect.objectContaining({ code: "constraint" }),
      );
    expect(await sql.query("SELECT account_id FROM stripe_billing_account_realms")).toEqual([
      { account_id: ACCOUNT },
    ]);
  });

  test("missing or permissive realm constraints/triggers are not readiness", async () => {
    const { sql, options } = await fixture();
    await seedHostedBillingRealmTestPin(sql, EXPECTED);
    await sql.run("DROP TRIGGER stripe_billing_account_realms_no_replace");
    await expect(verifyHostedBillingFinancialRealm(options)).rejects.toThrow(code("unsafe_schema"));
    await sql.run(`CREATE TRIGGER stripe_billing_account_realms_no_replace
      BEFORE INSERT ON stripe_billing_account_realms WHEN 0
      BEGIN SELECT RAISE(ABORT, 'constraint: authenticated Stripe financial realm is immutable'); END`);
    await expect(verifyHostedBillingFinancialRealm(options)).rejects.toThrow(code("unsafe_schema"));
  });

  test("absent or foreign 0098 mode pin is preserved and refuses financial qualification", async () => {
    const empty = await createHostedBillingRealmTestDatabase({ mode: null });
    const foreign = await createHostedBillingRealmTestDatabase({ mode: "live" });
    close.add(() => empty.db.close());
    close.add(() => foreign.db.close());
    const remote = processor();
    await expect(
      verifyHostedBillingFinancialRealm({
        sql: empty.sql,
        reader: remote.reader,
        expected: EXPECTED,
        prices: PRICE_TERMS,
      }),
    ).rejects.toThrow(code("realm_unbound"));
    await expect(
      verifyHostedBillingFinancialRealm({
        sql: foreign.sql,
        reader: remote.reader,
        expected: EXPECTED,
        prices: PRICE_TERMS,
      }),
    ).rejects.toThrow(code("realm_mismatch"));
    expect(await rowCount(empty.sql)).toEqual([{ count: 0 }]);
    expect(await rowCount(foreign.sql)).toEqual([{ count: 0 }]);
  });

  test("even zero-value financial history or unknown financial tables forbids fresh bind", async () => {
    for (const statement of [
      `INSERT INTO ledger (id, org_id, type, ref, settled_delta_micros, held_delta_micros, created_at)
       VALUES ('led_zero', 'org_old', 'funding', 'old', 0, 0, '${NOW}')`,
      "INSERT INTO stripe_billing_pricing VALUES ('old', '{}')",
      "CREATE TABLE stripe_unknown_history (id TEXT); INSERT INTO stripe_unknown_history VALUES ('old')",
      "CREATE TABLE money_external_claims (id TEXT); INSERT INTO money_external_claims VALUES ('old')",
    ]) {
      const { db, sql, options, calls } = await fixture();
      db.exec(statement);
      await expect(
        bindFreshHostedBillingRealm({ ...options, clock: () => new Date(NOW) }),
      ).rejects.toThrow(code("financial_history_present"));
      expect(await rowCount(sql)).toEqual([{ count: 0 }]);
      expect(calls).toEqual([]);
    }
    const missing = await fixture();
    missing.db.exec("DROP TABLE stripe_billing_commands");
    await expect(
      bindFreshHostedBillingRealm({ ...missing.options, clock: () => new Date(NOW) }),
    ).rejects.toThrow(code("unsafe_schema"));
  });

  test("money or a new financial table appearing after preflight cannot race the guarded insert", async () => {
    for (const mutation of [
      "INSERT INTO stripe_billing_pricing VALUES ('late', '{}')",
      "CREATE TABLE stripe_new_authority (id TEXT); INSERT INTO stripe_new_authority VALUES ('late')",
    ]) {
      const { db, sql, options } = await fixture();
      const guarded: Sql = {
        query: sql.query.bind(sql),
        batch: sql.batch.bind(sql),
        async run(statement, params) {
          if (statement.startsWith("INSERT INTO stripe_billing_account_realms")) db.exec(mutation);
          return await sql.run(statement, params);
        },
      };
      await expect(
        bindFreshHostedBillingRealm({ ...options, sql: guarded, clock: () => new Date(NOW) }),
      ).rejects.toThrow(code("financial_history_present"));
      expect(await rowCount(sql)).toEqual([{ count: 0 }]);
    }
  });

  test("lost fresh-bind acknowledgement is settled only by the exact committed pin", async () => {
    const { sql, options } = await fixture();
    let lose = true;
    const guarded: Sql = {
      query: sql.query.bind(sql),
      batch: sql.batch.bind(sql),
      async run(statement, params) {
        const result = await sql.run(statement, params);
        if (lose && statement.startsWith("INSERT INTO stripe_billing_account_realms")) {
          lose = false;
          throw new SqlError("unavailable", "lost acknowledgement");
        }
        return result;
      },
    };
    const realm = await bindFreshHostedBillingRealm({
      ...options,
      sql: guarded,
      clock: () => new Date(NOW),
    });
    assertHostedBillingFinancialRealm(realm, {
      sql: guarded,
      client: options.reader.client,
      billingAuthority: AUTHORITY,
    });
    expect(await rowCount(sql)).toEqual([{ count: 1 }]);
  });

  test("provider diagnostics are never copied into realm refusals", async () => {
    const { sql, options } = await fixture();
    await seedHostedBillingRealmTestPin(sql, EXPECTED);
    await expect(
      verifyHostedBillingFinancialRealm({
        ...options,
        reader: {
          client: {
            ...options.reader.client,
            async authenticAccount() {
              throw new Error("sensitive diagnostic fixture");
            },
          },
        },
      }),
    ).rejects.toThrow(/^unavailable$/u);
  });

  test("native D1 applies exact SQL, enforces immutable pins, and rolls failed batches back", async () => {
    const runtime = new Miniflare({
      workers: [
        {
          config: {
            name: "hosted-realm-negative-test",
            type: "worker",
            compatibilityDate: "2026-08-17",
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": {
                  type: "esm",
                  contents: "export default { fetch() { return new Response('realm fixture'); } };",
                },
              },
            },
            env: { STATE_DB: { type: "d1", id: "hosted-realm-negative-test" } },
            triggers: [],
          },
        },
      ],
    });
    try {
      const database = await runtime.getD1Database("STATE_DB");
      for (const migration of await hostedBillingRealmTestMigrations()) {
        const statements = splitMigration(migration);
        await database.batch(statements.map((statement) => database.prepare(statement)));
      }
      const sql = createD1Sql(database);
      await sql.run("INSERT INTO stripe_mode_realm VALUES (1, 'test', ?)", [NOW]);
      const remote = processor();
      const options = { sql, reader: remote.reader, expected: EXPECTED, prices: PRICE_TERMS };
      await expect(verifyHostedBillingFinancialRealm(options)).rejects.toThrow(
        code("realm_unbound"),
      );
      const insert = {
        sql: "INSERT INTO stripe_billing_account_realms VALUES (1, ?, 'test', ?, ?)",
        params: [ACCOUNT, AUTHORITY, NOW],
      };
      await expect(
        sql.batch([
          insert,
          {
            sql: "INSERT OR REPLACE INTO stripe_billing_account_realms VALUES (1, ?, 'test', ?, ?)",
            params: ["acct_foreign123", AUTHORITY, NOW],
          },
        ]),
      ).rejects.toThrow(expect.objectContaining({ code: "constraint" }));
      expect(await rowCount(sql)).toEqual([{ count: 0 }]);
      const realm = await bindFreshHostedBillingRealm({ ...options, clock: () => new Date(NOW) });
      assertHostedBillingFinancialRealm(realm, {
        sql,
        client: remote.client,
        billingAuthority: AUTHORITY,
      });
      await expect(
        sql.run("UPDATE stripe_billing_account_realms SET billing_authority='other'"),
      ).rejects.toThrow(expect.objectContaining({ code: "constraint" }));
      expect(await rowCount(sql)).toEqual([{ count: 1 }]);
    } finally {
      await runtime.dispose();
    }
  }, 60_000);
});

// The owning migrations include trigger bodies; semicolon splitting alone
// changes those bytes into invalid statements. Match their existing runner.
function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest) {
    if (/^CREATE\s+TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary));
      rest = rest.slice(boundary).trim();
    } else {
      const boundary = rest.indexOf(";");
      if (boundary < 0) {
        statements.push(rest);
        break;
      }
      statements.push(rest.slice(0, boundary));
      rest = rest.slice(boundary + 1).trim();
    }
  }
  return statements.filter((statement) => statement.trim().length > 0);
}
