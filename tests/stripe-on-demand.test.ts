import { describe, expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { createLedger } from "../src/ledger.ts";
import { createOrgBilling } from "../src/org-billing.ts";
import { createOrgLimitPolicy } from "../src/org-limit-policy.ts";
import { parseOrgOnDemandTerms } from "../src/org-on-demand-terms.ts";
import { type Sql, SqlError, type SqlStatement } from "../src/ports.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";
import {
  assertStripeOnDemandService,
  createStripeOnDemand,
  parseStripeOnDemandConsentEnvelope,
} from "../src/stripe-on-demand.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

const ORG = "org_ondemand";
const ACCOUNT = "acct_ondemandfixture";
const PRIVATE_MARKER = "native-private-data-must-not-be-persisted";
const AT = "2026-10-15T12:00:00.000Z";
const inputTerms = () => ({
  termsRevision: "operator-terms-1",
  consentRevision: "offsession-disclosure-1",
  currency: "USD",
  validity: { validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2026-12-01T00:00:00.000Z" },
  replenishment: {
    trigger: "eligible-credit-deficit",
    rule: "ceil-deficit-to-quantum-with-minimum",
    fundingQuantumMinor: 25,
    minimumChargeMinor: 50,
    maximumChargeMinor: 1000,
  },
  cashCapBounds: { minimumMinor: 1, maximumMinor: 10_000 },
  purchaseCreditExpiry: { kind: "fixed-duration", seconds: 86400 },
});
const hold = (reference = "run-1", amountMicros = 10_000, organizationId = ORG) => ({
  organizationId,
  reference,
  amountMicros,
  pricingRevision: "ondemand-fixture-r1",
  measurementFingerprint: "quote-1",
});

async function fixture(
  options: { readonly freeIncludedMinor?: number; readonly time?: string } = {},
) {
  const { db, sql: base } = await createHostedBillingRealmTestDatabase();
  const migration = MIGRATIONS.find((item) => item.name === "0100_hosted_on_demand.sql");
  if (!migration) throw new Error("Missing owning 0100 fixture migration");
  db.exec("PRAGMA foreign_keys=ON");
  db.exec(migration.sql);
  let time = options.time ?? AT;
  const clock = () => new Date(time);
  const batches: (readonly SqlStatement[])[] = [];
  let beforeBatch: ((statements: readonly SqlStatement[]) => Promise<void>) | undefined;
  let afterBatch: ((statements: readonly SqlStatement[]) => Promise<void>) | undefined;
  let loseBatchAck: ((statements: readonly SqlStatement[]) => boolean) | undefined;
  const sql: Sql = {
    query: (...args) => base.query(...args),
    run: (...args) => base.run(...args),
    async batch(statements) {
      for (const statement of statements)
        expect(statement.params?.length ?? 0).toBeLessThanOrEqual(100);
      batches.push(statements);
      await beforeBatch?.(statements);
      const result = await base.batch(statements);
      await afterBatch?.(statements);
      if (loseBatchAck?.(statements)) {
        loseBatchAck = undefined;
        throw new SqlError("unavailable", "fixture lost batch acknowledgement");
      }
      return result;
    },
  };
  await seedHostedBillingRealmTestPin(sql, {
    accountId: ACCOUNT,
    billingAuthority: "ondemand-test-authority",
  });
  const native = new Map<string, Record<string, unknown>>();
  const posts: { form: URLSearchParams; key: string | null }[] = [];
  const getPaths: string[] = [];
  const lists: string[] = [];
  let resultStatus = "succeeded";
  let losePostAck = false;
  let hideOriginal = false;
  let listMore = false;
  let duplicateOriginal = false;
  let beforePost: (() => Promise<void>) | undefined;
  let onRead: ((path: string) => Promise<void>) | undefined;
  const methods = new Map<string, string>();
  const client = createStripeBillingClient({
    secretKey: "sk_test_on_demand_fixture_not_a_credential",
    fetch: async (request) => {
      expect(request.headers.get("stripe-version")).toBe("2024-06-20");
      const url = new URL(request.url);
      if (request.method === "GET") {
        getPaths.push(url.pathname);
        await onRead?.(url.pathname);
        if (url.pathname === "/v1/account")
          return Response.json({ id: ACCOUNT, object: "account" });
        if (url.pathname === "/v1/prices/price_ondemand_fixture")
          return Response.json({
            id: "price_ondemand_fixture",
            object: "price",
            livemode: false,
            currency: "usd",
            type: "recurring",
            billing_scheme: "per_unit",
            unit_amount: 1000,
            recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
          });
        if (url.pathname.startsWith("/v1/customers/"))
          return Response.json({
            id: url.pathname.split("/").at(-1),
            object: "customer",
            livemode: false,
            metadata: {},
          });
        if (url.pathname.startsWith("/v1/payment_methods/")) {
          const id = url.pathname.split("/").at(-1) ?? "";
          const customer = methods.get(id);
          return customer
            ? Response.json({
                id,
                object: "payment_method",
                livemode: false,
                customer,
                type: "card",
                card: { exp_month: 12, exp_year: 2030, last4: PRIVATE_MARKER },
                billing_details: { name: PRIVATE_MARKER },
              })
            : Response.json({ error: { type: "invalid_request_error" } }, { status: 404 });
        }
        if (url.pathname === "/v1/payment_intents") {
          lists.push(url.search);
          const data = hideOriginal
            ? []
            : [...native.values()].filter(
                (row) =>
                  row.object === "payment_intent" &&
                  row.customer === url.searchParams.get("customer"),
              );
          if (duplicateOriginal && data[0]) data.push({ ...data[0], id: "pi_duplicate_original" });
          return Response.json({ object: "list", data, has_more: listMore });
        }
        const id = url.pathname.split("/").at(-1) ?? "";
        const value = native.get(id);
        return value && !hideOriginal
          ? Response.json(value)
          : Response.json({ error: { type: "invalid_request_error" } }, { status: 404 });
      }
      if (request.method !== "POST" || url.pathname !== "/v1/payment_intents")
        throw new Error("Unexpected native mutation");
      const form = new URLSearchParams(await request.text());
      posts.push({ form, key: request.headers.get("Idempotency-Key") });
      await beforePost?.();
      const id = `pi_original_${posts.length}`;
      const chargeId = `ch_original_${posts.length}`;
      const amount = Number(form.get("amount"));
      const metadata = Object.fromEntries(
        [...form]
          .filter(([key]) => key.startsWith("metadata["))
          .map(([key, value]) => [key.slice(9, -1), value]),
      );
      const intent = {
        id,
        object: "payment_intent",
        livemode: false,
        status: resultStatus,
        customer: form.get("customer"),
        payment_method: form.get("payment_method"),
        currency: "usd",
        amount,
        amount_received: resultStatus === "succeeded" ? amount : 0,
        amount_capturable: 0,
        latest_charge: resultStatus === "succeeded" ? chargeId : null,
        metadata,
        client_secret: PRIVATE_MARKER,
      };
      native.set(id, intent);
      native.set(chargeId, {
        id: chargeId,
        object: "charge",
        livemode: false,
        payment_intent: id,
        payment_method: form.get("payment_method"),
        payment_method_details: { type: "card" },
        customer: form.get("customer"),
        currency: "usd",
        amount,
        amount_captured: amount,
        paid: true,
        captured: true,
        status: "succeeded",
        disputed: false,
        amount_refunded: 0,
        refunded: false,
        billing_details: { name: PRIVATE_MARKER },
      });
      if (losePostAck) {
        losePostAck = false;
        throw new Error("fixture lost native acknowledgement");
      }
      return Response.json(intent);
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: ACCOUNT, mode: "test", billingAuthority: "ondemand-test-authority" },
    prices: [{ priceId: "price_ondemand_fixture", monthlyAmountMinor: 1000 }],
  });
  const billingConfig = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "ondemand-fixture-r1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: options.freeIncludedMinor ?? 0,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {
        requests: { unit: "request", rate: { numeratorMicros: "10000", denominator: "1" } },
      },
    }),
  );
  if (!billingConfig) throw new Error("Missing fixture billing config");
  const store = createStripeBillingStore({ sql, clock });
  const terms = parseOrgOnDemandTerms(inputTerms());
  const makeService = () =>
    createStripeOnDemand({ sql, clock, client, realm, store, billingConfig, terms });
  const service = await makeService();
  const policy = createOrgLimitPolicy({ sql, clock, onDemand: service });
  const ledger = createLedger(sql, clock);
  const billing = createOrgBilling({
    sql,
    clock,
    ledger,
    config: billingConfig,
    limitPolicy: policy,
    admissionFunding: service,
  });
  async function bind(org: string) {
    const customer = `cus_${org}`;
    const method = `pm_${org}`;
    methods.set(method, customer);
    await sql.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,?,?,?)", [
      org,
      "On-demand fixture",
      "principal_ondemand_fixture",
      time,
    ]);
    await sql.run("INSERT INTO stripe_billing_customers VALUES (?, ?, ?)", [org, customer, time]);
  }
  async function consent(org = ORG, cashCapMinor = 10_000, reference = "consent-1") {
    return await policy.change({
      organizationId: org,
      reference,
      authorizedPrincipal: "host:principal-1",
      onLimit: "on-demand",
      termsRevision: terms.termsRevision,
      consentRevision: terms.consentRevision,
      cashCapMinor,
      paymentMethodId: `pm_${org}`,
    });
  }
  const commands = () =>
    sql.query("SELECT * FROM stripe_billing_on_demand_commands ORDER BY org_id, reference");
  const exposures = () => sql.query("SELECT * FROM org_wallet_cash_exposures ORDER BY org_id, ref");
  const afterPrepare = (action: () => Promise<void>) => {
    afterBatch = async (statements) => {
      if (
        statements.some((statement) =>
          statement.sql.startsWith("INSERT INTO stripe_billing_on_demand_commands"),
        )
      ) {
        afterBatch = undefined;
        await action();
      }
    };
  };
  await bind(ORG);
  return {
    db,
    sql,
    clock,
    client,
    realm,
    store,
    billingConfig,
    terms,
    service,
    makeService,
    policy,
    ledger,
    billing,
    commands,
    exposures,
    consent,
    bind,
    native,
    posts,
    getPaths,
    lists,
    batches,
    methods,
    afterPrepare,
    setTime(value: string) {
      time = value;
    },
    setStatus(value: string) {
      resultStatus = value;
    },
    losePost() {
      losePostAck = true;
    },
    hide(value: boolean) {
      hideOriginal = value;
    },
    truncated(value: boolean) {
      listMore = value;
    },
    duplicate(value: boolean) {
      duplicateOriginal = value;
    },
    beforePost(action: () => Promise<void>) {
      beforePost = action;
    },
    onRead(action: (path: string) => Promise<void>) {
      onRead = action;
    },
    beforeBatch(action: (statements: readonly SqlStatement[]) => Promise<void>) {
      beforeBatch = action;
    },
    loseBatchWhen(predicate: (statements: readonly SqlStatement[]) => boolean) {
      loseBatchAck = predicate;
    },
  };
}

async function rejected(promise: Promise<unknown>) {
  let error: unknown;
  try {
    await promise;
  } catch (caught) {
    error = caught;
  }
  expect(error).toBeDefined();
}

describe("genuine on-demand command orchestration", () => {
  test("only a qualified service and genuine OrgBilling token can enter the cash path", async () => {
    const f = await fixture();
    expect(() =>
      assertStripeOnDemandService({ ...f.service }, { sql: f.sql, clock: f.clock }),
    ).toThrow();
    expect(() =>
      assertStripeOnDemandService(f.service, { sql: f.sql, clock: () => f.clock() }),
    ).toThrow();
    expect(() =>
      assertStripeOnDemandService(f.service, {
        sql: f.sql,
        clock: f.clock,
        billingConfig: structuredClone(f.billingConfig),
      }),
    ).not.toThrow();
    expect(() =>
      assertStripeOnDemandService(f.service, {
        sql: f.sql,
        clock: f.clock,
        billingConfig: { ...f.billingConfig, revision: "other" },
      }),
    ).toThrow();
    await rejected(
      f.service.beforeNewAdmission({
        organizationId: ORG,
        namespace: "org-hold",
        reference: "run-1",
        amountMicros: 1,
        allocationAdmission: { onLimit: "on-demand" },
      }),
    );
    expect(f.posts).toHaveLength(0);
    expect(await f.commands()).toEqual([]);
    f.db.close();
  });

  test("genuine hold funds once before local admission and persists only the explicit request allowlist", async () => {
    const f = await fixture();
    await f.consent();
    const accepted = await f.billing.hold(hold());
    expect(accepted).toMatchObject({ amountMicros: 10_000 });
    expect(f.posts).toHaveLength(1);
    const [command] = await f.commands();
    expect(command).toMatchObject({
      state: "paid",
      amount_minor: 50,
      period_start: "2026-10-01T00:00:00.000Z",
      period_end: "2026-11-01T00:00:00.000Z",
      terms_expires_at: "2026-11-01T00:00:00.000Z",
    });
    const request = JSON.parse(String(command?.request_json)) as Record<string, unknown>;
    expect(Object.keys(request).sort()).toEqual([
      "amount",
      "confirm",
      "currency",
      "customer",
      "metadata",
      "off_session",
      "payment_method",
      "payment_method_types",
    ]);
    expect(Object.keys(request.metadata as object).sort()).toEqual([
      "billingAuthority",
      "financialRealm",
      "fingerprint",
      "fundingRef",
      "organizationId",
      "reference",
      "stripeAccountId",
    ]);
    expect(request.payment_method_types).toEqual(["card"]);
    expect(f.posts[0]?.form.get("payment_method_types[0]")).toBe("card");
    expect(f.posts[0]?.form.has("automatic_payment_methods[enabled]")).toBe(false);
    for (const table of [
      "stripe_billing_on_demand_commands",
      "stripe_billing_on_demand_attempts",
      "stripe_billing_on_demand_terminals",
      "stripe_billing_on_demand_funding",
    ])
      expect(JSON.stringify(await f.sql.query(`SELECT * FROM ${table}`))).not.toContain(
        PRIVATE_MARKER,
      );
    expect(await f.exposures()).toMatchObject([{ status: "paid", amount_minor: 50 }]);
    expect(
      await f.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_on_demand_funding"),
    ).toEqual([{ count: 1 }]);
    expect(await f.billing.hold(hold())).toEqual(accepted);
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });

  test("zero and included-covered work stay cardless and never prepare cash", async () => {
    const f = await fixture({ freeIncludedMinor: 150 });
    await f.billing.hold(hold("zero", 0));
    await f.billing.hold(hold("included", 100_000));
    expect(f.posts).toHaveLength(0);
    expect(await f.commands()).toEqual([]);
    expect(f.getPaths.filter((path) => path.startsWith("/v1/payment_methods/"))).toEqual([]);
    f.db.close();
  });

  test("direct ledger, reads and metering-style local recovery cannot invent cash authority", async () => {
    const f = await fixture();
    await f.consent();
    await f.billing.wallet(ORG);
    await f.service.readOriginal({ organizationId: ORG, reference: "absent" });
    await f.service.drainOriginal({ organizationId: ORG, reference: "absent" });
    await f.service.drainPending(10);
    expect(await f.ledger.hold({ organizationId: ORG, reference: "direct", amountMicros: 1 })).toBe(
      false,
    );
    expect(f.posts).toHaveLength(0);
    expect(await f.commands()).toEqual([]);
    f.db.close();
  });

  test("atomic prepare rollback cannot leave an exposure without its command", async () => {
    const f = await fixture();
    await f.consent();
    f.db.exec(
      "CREATE TRIGGER fixture_command_insert_failure BEFORE INSERT ON stripe_billing_on_demand_commands BEGIN SELECT RAISE(ABORT,'fixture command insert failure'); END",
    );
    await rejected(f.billing.hold(hold()));
    expect(await f.commands()).toEqual([]);
    expect(await f.exposures()).toEqual([]);
    expect(await f.sql.query("SELECT * FROM org_wallet_cash_cap_buckets")).toEqual([]);
    expect(f.posts).toHaveLength(0);
    f.db.close();
  });

  test("lost prepare or first-dispatch DB ACK recovers only the invocation's original winner nonce", async () => {
    for (const needle of [
      "INSERT INTO stripe_billing_on_demand_commands",
      "INSERT INTO stripe_billing_on_demand_attempts",
    ]) {
      const f = await fixture();
      await f.consent();
      f.loseBatchWhen((statements) =>
        statements.some((statement) => statement.sql.startsWith(needle)),
      );
      await f.billing.hold(hold());
      expect(f.posts).toHaveLength(1);
      expect(
        await f.sql.query(
          "SELECT COUNT(*) AS count FROM stripe_billing_on_demand_attempts WHERE kind='first-dispatch'",
        ),
      ).toEqual([{ count: 1 }]);
      expect(await f.exposures()).toMatchObject([{ status: "paid" }]);
      f.db.close();
    }
  });

  test("unknown native ACK survives restart, 404/list absence and UTC month without another POST", async () => {
    const f = await fixture();
    await f.consent();
    f.losePost();
    f.hide(true);
    await rejected(f.billing.hold(hold()));
    const [command] = await f.commands();
    const reference = String(command?.reference);
    expect(command).toMatchObject({ state: "dispatched", payment_intent_id: null });
    f.setTime("2026-11-02T00:00:00.000Z");
    const restarted = await f.makeService();
    expect(await restarted.drainOriginal({ organizationId: ORG, reference })).toMatchObject({
      state: "pending",
      reconciliationRequired: true,
      periodStart: "2026-10-01T00:00:00.000Z",
    });
    await rejected(f.billing.hold(hold("other-new-reference")));
    expect(f.posts).toHaveLength(1);
    expect(await f.exposures()).toMatchObject([
      { status: "reserved", period_start: "2026-10-01T00:00:00.000Z" },
    ]);
    f.hide(false);
    expect(await restarted.drainOriginal({ organizationId: ORG, reference })).toMatchObject({
      state: "funded",
    });
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });

  test("ambiguous and truncated recovery never grant or release the unresolved original", async () => {
    for (const mode of ["duplicate", "truncated"] as const) {
      const f = await fixture();
      await f.consent();
      f.losePost();
      f.hide(true);
      await rejected(f.billing.hold(hold()));
      f.hide(false);
      if (mode === "duplicate") f.duplicate(true);
      else f.truncated(true);
      const [row] = await f.commands();
      expect(
        await f.service.drainOriginal({ organizationId: ORG, reference: String(row?.reference) }),
      ).toMatchObject({ state: "pending" });
      expect(await f.exposures()).toMatchObject([{ status: "reserved" }]);
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_funding")).toEqual([]);
      expect(f.posts).toHaveLength(1);
      f.db.close();
    }
  });

  test("manual funding after prepare abandons with a genuine same-batch capacity guard", async () => {
    const f = await fixture();
    await f.consent();
    f.afterPrepare(async () => {
      await f.ledger.fund({
        organizationId: ORG,
        fundingRef: "manual",
        amountMicros: 100_000,
        kind: "purchased",
        consumptionClass: "purchased",
      });
    });
    await f.billing.hold(hold());
    expect(f.posts).toHaveLength(0);
    expect(await f.commands()).toMatchObject([{ state: "abandoned" }]);
    expect(await f.sql.query("SELECT reason FROM stripe_billing_on_demand_abandonments")).toEqual([
      { reason: "not-needed" },
    ]);
    expect(await f.exposures()).toMatchObject([{ status: "released", source_ref: null }]);
    f.db.close();
  });

  test("partial manual funding that changes the dispatch quote retains the original without POST", async () => {
    const f = await fixture();
    try {
      await f.consent();
      f.afterPrepare(async () => {
        await f.ledger.fund({
          organizationId: ORG,
          fundingRef: "manual-partial",
          amountMicros: 750_000,
          kind: "purchased",
          consumptionClass: "purchased",
        });
      });
      // The original deficit quotes 100 cents. The remaining 25-cent deficit
      // quotes the explicit 50-cent minimum, so the immutable 100 cannot dispatch.
      await rejected(f.billing.hold(hold("partial-deficit", 1_000_000)));
      expect(f.posts).toHaveLength(0);
      const originals = await f.commands();
      expect(originals).toMatchObject([
        { state: "prepared", amount_minor: 100, dispatched_at: null, payment_intent_id: null },
      ]);
      expect(await f.exposures()).toMatchObject([{ status: "reserved", amount_minor: 100 }]);
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_attempts")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_funding")).toEqual([]);
      expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_abandonments")).toEqual([]);
      await rejected(f.billing.hold(hold("partial-deficit", 1_000_000)));
      expect(f.posts).toHaveLength(0);
      expect(await f.commands()).toEqual(originals);
      expect(await f.exposures()).toMatchObject([{ status: "reserved", amount_minor: 100 }]);
    } finally {
      f.db.close();
    }
  });

  test("partial manual funding within the same quantum keeps the exact original dispatch quote", async () => {
    const f = await fixture();
    try {
      await f.consent();
      f.afterPrepare(async () => {
        await f.ledger.fund({
          organizationId: ORG,
          fundingRef: "manual-same-quantum",
          amountMicros: 1,
          kind: "purchased",
          consumptionClass: "purchased",
        });
      });
      await f.billing.hold(hold("same-quantum", 1_000_000));
      expect(f.posts.map((post) => post.form.get("amount"))).toEqual(["100"]);
      expect(await f.commands()).toMatchObject([{ state: "paid", amount_minor: 100 }]);
      expect(await f.exposures()).toMatchObject([{ status: "paid", amount_minor: 100 }]);
    } finally {
      f.db.close();
    }
  });

  test("withdrawal before dispatch abandons atomically; a dispatched original still drains without current card", async () => {
    const prepared = await fixture();
    await prepared.consent();
    prepared.afterPrepare(async () => {
      await prepared.policy.change({
        organizationId: ORG,
        reference: "withdraw",
        authorizedPrincipal: "host:principal-1",
        onLimit: "stop",
      });
    });
    await rejected(prepared.billing.hold(hold()));
    expect(prepared.posts).toHaveLength(0);
    expect(await prepared.commands()).toMatchObject([{ state: "abandoned" }]);
    expect(await prepared.exposures()).toMatchObject([{ status: "released" }]);
    prepared.db.close();
    const dispatched = await fixture();
    await dispatched.consent();
    dispatched.setStatus("requires_action");
    await rejected(dispatched.billing.hold(hold()));
    await dispatched.policy.change({
      organizationId: ORG,
      reference: "withdraw",
      authorizedPrincipal: "host:principal-1",
      onLimit: "stop",
    });
    dispatched.methods.clear();
    const native = dispatched.native.get("pi_original_1");
    if (!native) throw new Error("Missing native fixture original");
    Object.assign(native, {
      status: "succeeded",
      amount_received: native.amount,
      latest_charge: "ch_original_1",
    });
    expect(await dispatched.service.drainForPaymentIntent("pi_original_1")).toMatchObject({
      state: "funded",
    });
    expect(dispatched.posts).toHaveLength(1);
    expect(await dispatched.exposures()).toMatchObject([{ status: "paid" }]);
    dispatched.db.close();
  });

  test("an undispatched command cannot POST after its frozen UTC cap month deadline", async () => {
    const f = await fixture({ time: "2026-10-31T23:59:59.000Z" });
    await f.consent();
    f.afterPrepare(async () => {
      f.setTime("2026-11-01T00:00:00.000Z");
    });
    await rejected(f.billing.hold(hold()));
    expect(f.posts).toHaveLength(0);
    expect(await f.commands()).toMatchObject([
      { state: "abandoned", terms_expires_at: "2026-11-01T00:00:00.000Z" },
    ]);
    expect(await f.sql.query("SELECT reason FROM stripe_billing_on_demand_abandonments")).toEqual([
      { reason: "expired" },
    ]);
    expect(await f.exposures()).toMatchObject([
      { status: "released", period_start: "2026-10-01T00:00:00.000Z" },
    ]);
    f.db.close();
  });

  test("requires_action and failed statuses keep reserved cap; only a genuine canceled no-payment original releases", async () => {
    for (const status of ["requires_action", "requires_payment_method", "processing"]) {
      const f = await fixture();
      await f.consent();
      f.setStatus(status);
      await rejected(f.billing.hold(hold()));
      expect(await f.exposures()).toMatchObject([{ status: "reserved" }]);
      const intent = f.native.get("pi_original_1");
      if (!intent) throw new Error("Missing native fixture original");
      intent.status = "canceled";
      expect(await f.service.drainForPaymentIntent("pi_original_1")).toMatchObject({
        state: "canceled",
      });
      expect(await f.exposures()).toMatchObject([
        { status: "released", source_ref: "pi_original_1" },
      ]);
      expect(f.posts).toHaveLength(1);
      f.db.close();
    }
  });

  test("late funding expiry is fixed at first settlement and replay cannot extend it", async () => {
    const f = await fixture();
    await f.consent();
    f.setStatus("requires_action");
    await rejected(f.billing.hold(hold()));
    f.setTime("2026-11-02T05:06:07.890Z");
    const intent = f.native.get("pi_original_1");
    if (!intent) throw new Error("Missing native fixture original");
    Object.assign(intent, {
      status: "succeeded",
      amount_received: intent.amount,
      latest_charge: "ch_original_1",
    });
    await f.service.drainForPaymentIntent("pi_original_1");
    const rows = await f.sql.query(
      "SELECT created_at, expires_at FROM stripe_billing_on_demand_funding",
    );
    expect(rows).toEqual([
      { created_at: "2026-11-02T05:06:07.890Z", expires_at: "2026-11-03T05:06:07.890Z" },
    ]);
    f.setTime("2026-11-03T05:06:07.890Z");
    await f.service.drainForPaymentIntent("pi_original_1");
    expect(
      await f.sql.query("SELECT created_at, expires_at FROM stripe_billing_on_demand_funding"),
    ).toEqual(rows);
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });

  test("canceled closure rolls terminal, exposure and command back together on a real SQL failure", async () => {
    const f = await fixture();
    await f.consent();
    f.setStatus("requires_action");
    await rejected(f.billing.hold(hold()));
    const intent = f.native.get("pi_original_1");
    if (!intent) throw new Error("Missing native fixture original");
    intent.status = "canceled";
    f.db.exec(
      "CREATE TRIGGER fixture_cancel_failure BEFORE UPDATE ON stripe_billing_on_demand_commands WHEN NEW.state='canceled' BEGIN SELECT RAISE(ABORT,'fixture canceled closure failure'); END",
    );
    expect(await f.service.drainForPaymentIntent("pi_original_1")).toMatchObject({
      state: "pending",
    });
    expect(await f.exposures()).toMatchObject([{ status: "reserved" }]);
    expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_terminals")).toEqual([]);
    f.db.exec("DROP TRIGGER fixture_cancel_failure");
    expect(await f.service.drainForPaymentIntent("pi_original_1")).toMatchObject({
      state: "canceled",
    });
    expect(await f.exposures()).toMatchObject([{ status: "released" }]);
    expect(
      await f.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_on_demand_terminals"),
    ).toEqual([{ count: 1 }]);
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });

  test("funded cash remains paid if local admission loses, with no second cash command", async () => {
    const f = await fixture();
    await f.consent();
    f.beforePost(async () => {
      await f.policy.change({
        organizationId: ORG,
        reference: "withdraw-after-marker",
        authorizedPrincipal: "host:principal-1",
        onLimit: "stop",
      });
    });
    await rejected(f.billing.hold(hold()));
    expect(await f.commands()).toMatchObject([{ state: "paid" }]);
    expect(await f.exposures()).toMatchObject([{ status: "paid" }]);
    expect(f.posts).toHaveLength(1);
    await rejected(f.billing.hold(hold()));
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });

  test("cash cap below the selected minimum refuses before native dispatch", async () => {
    const f = await fixture();
    await f.consent(ORG, 1);
    await rejected(f.billing.hold(hold()));
    expect(f.posts).toHaveLength(0);
    expect(await f.commands()).toEqual([]);
    expect(await f.exposures()).toEqual([]);
    f.db.close();
  });

  test("fresh usage shares the command protocol while accepted usage replays after withdrawal", async () => {
    const f = await fixture();
    await f.consent();
    const input = {
      organizationId: ORG,
      reference: "closed-business-usage",
      meter: "requests",
      quantity: "1",
      quantityUnit: "request",
      periodStart: "2026-10-15T10:00:00.000Z",
      periodEnd: "2026-10-15T11:00:00.000Z",
      pricingRevision: f.billingConfig.revision,
      expectedMicros: 10_000,
      measurementFingerprint: "closed-1",
    };
    const original = await f.billing.usage(input);
    expect(f.posts).toHaveLength(1);
    const [row] = await f.commands();
    expect(JSON.parse(String(row?.admission_json))).toMatchObject({
      namespace: "org-usage",
      reference: input.reference,
    });
    await f.policy.change({
      organizationId: ORG,
      reference: "withdraw-usage",
      authorizedPrincipal: "host:principal-1",
      onLimit: "stop",
    });
    f.methods.clear();
    expect(await f.billing.usage(input)).toEqual(original);
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });

  test("bad pricing, foreign Workspace and changed request fingerprints cannot trigger cash", async () => {
    const f = await fixture();
    await f.consent();
    await f.sql.run(
      "INSERT INTO org_wallet_workspace_bindings(workspace_ref,org_id,created_at) VALUES(?,?,?)",
      ["ws_foreign", "org_other", AT],
    );
    await rejected(f.billing.hold({ ...hold(), pricingRevision: "unreviewed" }));
    await rejected(f.billing.hold({ ...hold(), workspaceRef: "ws_foreign" }));
    expect(f.posts).toHaveLength(0);
    f.setStatus("requires_action");
    await rejected(f.billing.hold(hold()));
    await rejected(f.billing.hold({ ...hold(), measurementFingerprint: "different-original" }));
    expect(f.posts).toHaveLength(1);
    expect(await f.commands()).toHaveLength(1);
    f.db.close();
  });

  test("genuine first Workspace admission funds before its owning local batch creates the binding", async () => {
    const f = await fixture();
    await f.consent();
    expect(await f.sql.query("SELECT * FROM org_wallet_workspace_bindings")).toEqual([]);
    await f.billing.hold({ ...hold(), workspaceRef: "ws_first_admission" });
    expect(f.posts).toHaveLength(1);
    expect(
      await f.sql.query("SELECT workspace_ref,org_id FROM org_wallet_workspace_bindings"),
    ).toEqual([{ workspace_ref: "ws_first_admission", org_id: ORG }]);
    const [row] = await f.commands();
    expect(JSON.parse(String(row?.admission_json))).toMatchObject({
      attribution: { workspaceRef: "ws_first_admission" },
    });
    f.db.close();
  });

  test("two genuine services racing one original reference retain one cash command and winner", async () => {
    const f = await fixture();
    await f.consent();
    const other = await f.makeService();
    const otherBilling = createOrgBilling({
      sql: f.sql,
      clock: f.clock,
      ledger: f.ledger,
      config: structuredClone(f.billingConfig),
      limitPolicy: f.policy,
      admissionFunding: other,
    });
    const results = await Promise.allSettled([f.billing.hold(hold()), otherBilling.hold(hold())]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(await f.commands()).toHaveLength(1);
    expect(f.posts).toHaveLength(1);
    expect(
      await f.sql.query(
        "SELECT COUNT(*) AS count FROM stripe_billing_on_demand_attempts WHERE kind='first-dispatch'",
      ),
    ).toEqual([{ count: 1 }]);
    expect(
      await f.sql.query("SELECT COUNT(*) AS count FROM stripe_billing_on_demand_funding"),
    ).toEqual([{ count: 1 }]);
    await f.billing.hold(hold());
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });

  test("closed consent parsing rejects unsafe persisted claims and freezes a defensive copy", async () => {
    const f = await fixture();
    await f.consent();
    const row = (
      await f.sql.query("SELECT result_json FROM org_wallet_limit_policy_commands WHERE org_id=?", [
        ORG,
      ])
    )[0];
    const input = JSON.parse(String(row?.result_json)) as Record<string, unknown>;
    const parsed = parseStripeOnDemandConsentEnvelope(input);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.selectedCardProof)).toBe(true);
    expect(Object.isFrozen(parsed.acceptedTerms.replenishment)).toBe(true);
    const mutations: ((value: Record<string, unknown>) => void)[] = [
      (value) => {
        value.rawNative = { client_secret: PRIVATE_MARKER };
      },
      (value) => {
        value.version = 2;
      },
      (value) => {
        value.acceptedAt = "2027-01-01T00:00:00.000Z";
      },
      (value) => {
        (value.selectedCardProof as Record<string, unknown>).verifiedAt =
          "2026-10-15T12:00:00.001Z";
      },
      (value) => {
        (value.selectedCardProof as Record<string, unknown>).last4 = PRIVATE_MARKER;
      },
      (value) => {
        (value.publicResult as Record<string, unknown>).cashCapMinor = 0;
      },
      (value) => {
        (
          (value.publicResult as Record<string, unknown>).capabilities as Record<string, unknown>
        ).postpaid = true;
      },
    ];
    for (const mutate of mutations) {
      const copy = structuredClone(input);
      mutate(copy);
      expect(() => parseStripeOnDemandConsentEnvelope(copy)).toThrow();
    }
    (input.acceptedTerms as Record<string, unknown>).termsRevision = "mutated";
    expect(parsed.acceptedTerms.termsRevision).toBe(f.terms.termsRevision);
    f.db.close();
  });

  test("schema drift and an object-shaped common store cannot qualify a service", async () => {
    const f = await fixture();
    await rejected(
      createStripeOnDemand({
        sql: f.sql,
        clock: f.clock,
        client: f.client,
        realm: f.realm,
        store: { ...f.store },
        billingConfig: f.billingConfig,
        terms: f.terms,
      }),
    );
    f.db.exec("DROP TRIGGER stripe_billing_on_demand_commands_no_delete");
    await rejected(f.makeService());
    expect(f.posts).toHaveLength(0);
    f.db.close();
  });

  test("Stripe factory validates explicit USD protocol bounds without selecting operator amounts", async () => {
    const f = await fixture();
    const create = (minimumChargeMinor: number, maximumChargeMinor: number) =>
      createStripeOnDemand({
        sql: f.sql,
        clock: f.clock,
        client: f.client,
        realm: f.realm,
        store: f.store,
        billingConfig: f.billingConfig,
        terms: parseOrgOnDemandTerms({
          ...inputTerms(),
          replenishment: {
            ...inputTerms().replenishment,
            fundingQuantumMinor: 1,
            minimumChargeMinor,
            maximumChargeMinor,
          },
        }),
      });
    await rejected(create(49, 1000));
    await rejected(create(50, 100_000_000));
    const supported = await create(50, 99_999_999);
    expect(supported.terms.replenishment).toMatchObject({
      minimumChargeMinor: 50,
      maximumChargeMinor: 99_999_999,
      fundingQuantumMinor: 1,
    });
    expect(f.posts).toHaveLength(0);
    f.db.close();
  });

  test("native refund proof is original-only and cannot substitute for a fresh admission token", async () => {
    const f = await fixture();
    await f.consent();
    await f.billing.hold(hold());
    const proof = await f.service.readFundingProofForPaymentIntent("pi_original_1");
    expect(proof).toMatchObject({ sourceType: "payment-intent", refundedAmountMinor: 0 });
    await rejected(f.service.beforeNewAdmission(proof));
    expect(await f.service.readFundingProofForPaymentIntent("pi_unknown")).toBeNull();
    expect(f.posts).toHaveLength(1);
    f.db.close();
  });

  test("bounded recovery rotates unknown originals using durable readback visits at a fixed clock", async () => {
    const f = await fixture();
    f.setStatus("requires_action");
    for (const org of [ORG, "org_ondemand_b", "org_ondemand_c"]) {
      if (org !== ORG) await f.bind(org);
      await f.consent(org);
      await rejected(f.billing.hold(hold("run-1", 10_000, org)));
    }
    const first = await f.service.drainPending(1);
    const second = await f.service.drainPending(1);
    const third = await f.service.drainPending(1);
    expect(
      new Set([first[0]?.organizationId, second[0]?.organizationId, third[0]?.organizationId]).size,
    ).toBe(3);
    expect(f.posts).toHaveLength(3);
    expect((await f.exposures()).every((row) => row.status === "reserved")).toBe(true);
    f.db.close();
  });
});
