import { expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { createLedger } from "../src/ledger.ts";
import type { Sql, SqlStatement } from "../src/ports.ts";
import { createD1Sql } from "../src/sql-d1.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { createStripeBillingStore } from "../src/stripe-billing-store.ts";
import { createStripeCustomerCustody } from "../src/stripe-customer-custody.ts";
import {
  type StripeOnDemandFundingExpected,
  verifyStripeOnDemandFunding,
} from "../src/stripe-on-demand-verification.ts";
import { currentAuditedSchemaMigrations } from "./helpers/audited-schema-fixture.ts";
import {
  HOSTED_BILLING_REALM_TEST_INSTANT,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";
import { mkdtempForSockets } from "./helpers/socket-temp-root.ts";

const PREPARED = "2026-10-15T12:00:00.000Z";
const DISPATCHED = "2026-10-15T12:00:01.000Z";
const OBSERVED = "2026-10-15T12:00:02.123Z";
const FUNDED = "2026-10-15T12:00:03.456Z";
const ACCOUNT = "acct_D1";
const AUTHORITY = "native-d1.test";
const clock = () => new Date(FUNDED);

async function qualifyCustomerInspection(sql: Sql): Promise<void> {
  const organizationId = "org_d1_customer";
  await sql.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,?,?,?)", [
    organizationId,
    "Native customer fixture",
    "principal_fixture",
    PREPARED,
  ]);
  const requests: Request[] = [];
  let customer: Record<string, unknown> | undefined;
  let loseAcknowledgement = true;
  const client = createStripeBillingClient({
    secretKey: "sk_test_fixture",
    async fetch(request) {
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/v1/account") return Response.json({ object: "account", id: ACCOUNT });
      if (path === "/v1/prices/price_customer_d1")
        return Response.json({
          id: "price_customer_d1",
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
        const form = new URLSearchParams(await request.clone().text());
        const metadata = Object.fromEntries(
          [...form.entries()].map(([key, value]) => [key.slice(9, -1), value]),
        );
        customer = { id: "cus_native_inspection", object: "customer", livemode: false, metadata };
        if (loseAcknowledgement) {
          loseAcknowledgement = false;
          throw new Error("native Customer fixture lost acknowledgement");
        }
        return Response.json(customer);
      }
      if (path === "/v1/customers")
        return Response.json({ data: customer ? [customer] : [], has_more: false });
      if (path === "/v1/customers/cus_native_inspection" && customer)
        return Response.json(customer);
      throw new Error("native Customer fixture forbids other processor requests");
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: ACCOUNT, mode: "test", billingAuthority: AUTHORITY },
    prices: [{ priceId: "price_customer_d1", monthlyAmountMinor: 1000 }],
  });
  const custody = createStripeCustomerCustody({ sql, client, realm, clock });
  const reader = createStripeCustomerCustody({
    sql,
    client,
    realm,
    clock: () => {
      throw new Error("Customer inspection must not read the clock");
    },
  });
  const initialRequests = requests.length;
  expect(await reader.inspect(organizationId)).toEqual({
    organizationId,
    command: null,
    binding: null,
  });
  expect(requests).toHaveLength(initialRequests);
  await expect(custody.ensure(organizationId)).rejects.toMatchObject({ code: "unavailable" });
  const afterUnknownRequests = requests.length;
  const unknown = await reader.inspect(organizationId);
  expect(unknown.command?.state).toBe("dispatched");
  expect(unknown.command?.customerId).toBeNull();
  expect(unknown.binding).toBeNull();
  expect(requests).toHaveLength(afterUnknownRequests);
  expect(await custody.ensure(organizationId)).toBe("cus_native_inspection");
  const afterRecoveryRequests = requests.length;
  const recovered = await reader.inspect(organizationId);
  expect(recovered.command?.state).toBe("verified");
  expect(recovered.command?.fingerprint).toBe(unknown.command?.fingerprint);
  expect(recovered.binding?.customerId).toBe("cus_native_inspection");
  expect(Object.isFrozen(recovered)).toBe(true);
  expect(Object.isFrozen(recovered.command)).toBe(true);
  expect(Object.keys(recovered.command ?? {}).sort()).toEqual([
    "createdAt",
    "customerId",
    "dispatchedAt",
    "fingerprint",
    "state",
    "verifiedAt",
  ]);
  expect(requests).toHaveLength(afterRecoveryRequests);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
}

function insert(table: string, row: Record<string, string | number | null>): SqlStatement {
  const columns = Object.keys(row);
  return {
    sql: `INSERT INTO ${table} (${columns.join(",")}) VALUES (${columns.map(() => "?").join(",")})`,
    params: Object.values(row),
  };
}

// Same original command fixture as the common-store SQLite test: it proves
// store/SQL custody, not merchant authorization, fresh admission or a Stripe POST.
async function prepareCommand(sql: Sql, suffix: string) {
  const metadata = {
    organizationId: `org_d1_${suffix}`,
    reference: `fund_${suffix}`,
    fingerprint: `original_${suffix}`,
    fundingRef: `stripe:on-demand:d1:${suffix}`,
    stripeAccountId: ACCOUNT,
    financialRealm: `realm:${"a".repeat(64)}`,
    billingAuthority: AUTHORITY,
  };
  const expected: StripeOnDemandFundingExpected = {
    organizationId: metadata.organizationId,
    reference: metadata.reference,
    fingerprint: metadata.fingerprint,
    fundingRef: metadata.fundingRef,
    financialRealm: metadata.financialRealm,
    billingAuthority: metadata.billingAuthority,
    accountId: ACCOUNT,
    mode: "test",
    customerId: `cus_d1_${suffix}`,
    paymentMethodId: `pm_d1_${suffix}`,
    paymentIntentId: `pi_d1_${suffix}`,
    chargeId: `ch_d1_${suffix}`,
    currency: "USD",
    amountMinor: 10,
    observedAt: OBSERVED,
    metadata,
  };
  const exposure = `exposure_${suffix}`;
  await sql.batch([
    insert("stripe_billing_customers", {
      org_id: expected.organizationId,
      customer_id: expected.customerId,
      created_at: PREPARED,
    }),
    insert("org_wallet_limit_policies", {
      org_id: expected.organizationId,
      on_limit: "on-demand",
      policy_version: 1,
      consent_revision: "consent-original",
      cash_cap_minor: 100,
      authorized_principal: "session:test-owner",
      updated_at: PREPARED,
    }),
    insert("org_wallet_cash_cap_buckets", {
      org_id: expected.organizationId,
      period_start: "2026-10-01T00:00:00.000Z",
      period_end: "2026-11-01T00:00:00.000Z",
    }),
    insert("org_wallet_cash_exposures", {
      org_id: expected.organizationId,
      ref: exposure,
      period_start: "2026-10-01T00:00:00.000Z",
      period_end: "2026-11-01T00:00:00.000Z",
      policy_version: 1,
      consent_revision: "consent-original",
      amount_minor: 10,
      status: "reserved",
      source_ref: null,
      created_at: PREPARED,
      closed_at: null,
    }),
    insert("stripe_billing_on_demand_commands", {
      org_id: expected.organizationId,
      reference: expected.reference,
      admission_json: JSON.stringify({
        organizationId: expected.organizationId,
        namespace: "store-fixture",
        reference: "original-hold",
        fingerprint: "original-admission",
      }),
      exposure_ref: exposure,
      funding_ref: expected.fundingRef,
      fingerprint: expected.fingerprint,
      account_id: ACCOUNT,
      mode: "test",
      billing_authority: AUTHORITY,
      customer_id: expected.customerId,
      payment_method_id: expected.paymentMethodId,
      setup_intent_id: null,
      authorized_principal: "session:test-owner",
      consent_revision: "consent-original",
      terms_revision: "terms-original",
      terms_json: '{"revision":"terms-original"}',
      consent_json: '{"revision":"consent-original"}',
      request_json: JSON.stringify({
        amount: 10,
        currency: "usd",
        customer: expected.customerId,
        payment_method: expected.paymentMethodId,
        off_session: true,
        confirm: true,
        metadata,
      }),
      policy_version: 1,
      cap_minor: 100,
      period_start: "2026-10-01T00:00:00.000Z",
      period_end: "2026-11-01T00:00:00.000Z",
      amount_minor: 10,
      credit_expiry_kind: "fixed-duration",
      credit_expiry_seconds: 3600,
      terms_expires_at: "2026-10-16T00:00:00.000Z",
      stripe_key: `original_key_${suffix}`,
      state: "prepared",
      dispatched_at: null,
      payment_intent_id: null,
      created_at: PREPARED,
    }),
  ]);
  const marker = insert("stripe_billing_on_demand_attempts", {
    org_id: expected.organizationId,
    reference: expected.reference,
    sequence: 1,
    kind: "first-dispatch",
    detail_json: '{"nonce":"original"}',
    created_at: DISPATCHED,
    first_dispatch_at: DISPATCHED,
  });
  const dispatch: SqlStatement = {
    sql: "UPDATE stripe_billing_on_demand_commands SET state='dispatched',dispatched_at=? WHERE org_id=? AND reference=? AND state='prepared' AND dispatched_at IS NULL",
    params: [DISPATCHED, expected.organizationId, expected.reference],
  };
  const native = (refundedAmountMinor = 0, observedAt = OBSERVED) =>
    verifyStripeOnDemandFunding(
      { ...expected, observedAt },
      {
        paymentIntent: {
          object: "payment_intent",
          id: expected.paymentIntentId,
          livemode: false,
          status: "succeeded",
          customer: expected.customerId,
          payment_method: expected.paymentMethodId,
          currency: "usd",
          amount: 10,
          amount_received: 10,
          amount_capturable: 0,
          latest_charge: expected.chargeId,
          metadata,
        },
        charge: {
          object: "charge",
          id: expected.chargeId,
          livemode: false,
          status: "succeeded",
          payment_intent: expected.paymentIntentId,
          payment_method: expected.paymentMethodId,
          customer: expected.customerId,
          currency: "usd",
          amount: 10,
          amount_captured: 10,
          paid: true,
          captured: true,
          disputed: false,
          amount_refunded: refundedAmountMinor,
          refunded: refundedAmountMinor === 10,
          payment_method_details: { type: "card" },
        },
      },
    );
  return { expected, exposure, marker, dispatch, native };
}

async function financialState(sql: Sql, organizationId: string) {
  return Promise.all([
    sql.query(
      "SELECT state,dispatched_at,payment_intent_id FROM stripe_billing_on_demand_commands WHERE org_id=?",
      [organizationId],
    ),
    sql.query("SELECT status,source_ref,closed_at FROM org_wallet_cash_exposures WHERE org_id=?", [
      organizationId,
    ]),
    sql.query("SELECT * FROM stripe_billing_on_demand_terminals WHERE org_id=?", [organizationId]),
    sql.query("SELECT * FROM stripe_billing_on_demand_funding WHERE org_id=?", [organizationId]),
    sql.query("SELECT * FROM wallet_credit_lots WHERE org_id=?", [organizationId]),
    sql.query("SELECT * FROM ledger WHERE org_id=?", [organizationId]),
    sql.query("SELECT * FROM stripe_billing_fences WHERE org_id=?", [organizationId]),
    sql.query("SELECT * FROM wallet_allocation_guards"),
  ]);
}

// Run the actual D1 compiler and implicit batch transaction. SQLite's default
// expression-depth limit (1000) cannot expose D1's limit (100) at INSERT time.
test("native D1 dispatch and original on-demand money preserve atomic custody", async () => {
  const root = await mkdtempForSockets("od-d1-", 70);
  let runtime: Miniflare | undefined;
  try {
    runtime = new Miniflare({
      cf: false,
      resourcePersistencePath: join(root, "state"),
      resourceTmpPath: join(root, "tmp"),
      workers: [
        {
          config: {
            name: "stripe-on-demand-d1",
            type: "worker",
            compatibilityDate: "2026-08-17",
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": {
                  type: "esm",
                  contents: "export default { fetch() { return new Response('local D1 only'); } };",
                },
              },
            },
            env: { STATE_DB: { type: "d1", id: "stripe-on-demand-d1" } },
            triggers: [],
          },
          dev: {
            rootPath: root,
            outboundService: {
              type: "fetcher",
              handler: () => {
                throw new Error("native D1 billing test forbids provider requests");
              },
            },
          },
        },
      ],
    });
    const database = await runtime.getD1Database("STATE_DB");
    const migrations = currentAuditedSchemaMigrations();
    expect(migrations.some(({ name }) => name === "0100_hosted_on_demand.sql")).toBe(true);
    for (const migration of migrations)
      for (const statement of splitMigration(migration.sql))
        await database.prepare(statement).run();
    const sql = createD1Sql(database);
    await sql.run("INSERT INTO stripe_mode_realm VALUES (1,'test',?)", [
      HOSTED_BILLING_REALM_TEST_INSTANT,
    ]);
    await seedHostedBillingRealmTestPin(sql, { accountId: ACCOUNT, billingAuthority: AUTHORITY });
    // Same native adapter/schema as the money assertions below; Customer reads
    // retain an unknown original before any subscription/top-up intent exists.
    await qualifyCustomerInspection(sql);
    const original = await prepareCommand(sql, "original");
    const foreign = await prepareCommand(sql, "foreign");

    // The marker's deferred original-command FK requires its own companion
    // transition. A foreign Org's transition cannot close that custody.
    await expect(sql.batch([original.marker])).rejects.toMatchObject({ code: "constraint" });
    await expect(sql.batch([original.marker, foreign.dispatch])).rejects.toMatchObject({
      code: "constraint",
    });
    expect(await sql.query("SELECT * FROM stripe_billing_on_demand_attempts")).toEqual([]);
    expect(
      await sql.query(
        "SELECT state,dispatched_at FROM stripe_billing_on_demand_commands ORDER BY org_id",
      ),
    ).toEqual([
      { state: "prepared", dispatched_at: null },
      { state: "prepared", dispatched_at: null },
    ]);
    await sql.batch([original.marker, original.dispatch]);
    expect(
      await sql.query(
        "SELECT state,dispatched_at FROM stripe_billing_on_demand_commands WHERE org_id=?",
        [original.expected.organizationId],
      ),
    ).toEqual([{ state: "dispatched", dispatched_at: DISPATCHED }]);
    expect(
      await sql.query("SELECT org_id,reference,kind FROM stripe_billing_on_demand_attempts"),
    ).toEqual([
      {
        org_id: original.expected.organizationId,
        reference: original.expected.reference,
        kind: "first-dispatch",
      },
    ]);

    const store = createStripeBillingStore({ sql, clock });
    const fund = () =>
      store.grantOnDemand({
        organizationId: original.expected.organizationId,
        reference: original.expected.reference,
        expectedCommandFingerprint: original.expected.fingerprint,
        native: original.native(),
      });
    const before = await financialState(sql, original.expected.organizationId);
    // A test-owned failure at the actual paid transition must roll back the
    // terminal, lot, ledger, funding source and cap closure together.
    await sql.run(
      "CREATE TRIGGER test_on_demand_paid_failure BEFORE UPDATE OF state ON stripe_billing_on_demand_commands WHEN NEW.state='paid' BEGIN SELECT RAISE(ABORT,'constraint: injected paid closure failure'); END",
    );
    await expect(fund()).rejects.toMatchObject({
      code: "constraint",
      message: expect.stringContaining("constraint: injected paid closure failure"),
    });
    expect(await financialState(sql, original.expected.organizationId)).toEqual(before);
    await sql.run("DROP TRIGGER test_on_demand_paid_failure");
    const grant = await fund();
    expect(await fund()).toEqual(grant);
    expect(
      await sql.query(
        "SELECT source_type,source_id FROM stripe_billing_funding_sources_all WHERE org_id=?",
        [grant.organizationId],
      ),
    ).toEqual([{ source_type: "payment-intent", source_id: original.expected.paymentIntentId }]);
    expect(
      await sql.query("SELECT status,source_ref FROM org_wallet_cash_exposures WHERE org_id=?", [
        grant.organizationId,
      ]),
    ).toEqual([{ status: "paid", source_ref: original.expected.paymentIntentId }]);
    expect(
      await sql.query("SELECT COUNT(*) AS n FROM ledger WHERE org_id=? AND type='funding'", [
        grant.organizationId,
      ]),
    ).toEqual([{ n: 1 }]);

    const generation = await store.freezeFunding(grant.organizationId, grant.fundingRef);
    const refund = {
      grant,
      refundId: "re_d1_original",
      amountMicros: 100000,
      cumulativeRefundedMicros: 100000,
      fenceGeneration: generation,
      native: original.native(10, FUNDED),
    };
    const receipt = await store.refund(refund);
    expect(await store.refund(refund)).toEqual(receipt);
    expect(receipt).toMatchObject({ debitMicros: 100000, receivableMicros: 0, expiredMicros: 0 });
    expect(await createLedger(sql, clock).wallet(grant.organizationId)).toMatchObject({
      availableMicros: 0,
      heldMicros: 0,
      refundReceivableMicros: 0,
    });
    expect(
      await sql.query("SELECT amount_micros FROM wallet_credit_lots WHERE org_id=?", [
        grant.organizationId,
      ]),
    ).toEqual([{ amount_micros: 100000 }]);
    expect(
      await sql.query(
        "SELECT COUNT(*) AS n,SUM(debit_micros) AS debit FROM stripe_billing_refund_receipts_all WHERE org_id=?",
        [grant.organizationId],
      ),
    ).toEqual([{ n: 1, debit: 100000 }]);
    expect(
      await sql.query("SELECT * FROM stripe_billing_refunds WHERE org_id=?", [
        grant.organizationId,
      ]),
    ).toEqual([]);
    expect(await sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
  } finally {
    try {
      await runtime?.dispose();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
}, 60_000);

function splitMigration(source: string): readonly string[] {
  const statements: string[] = [];
  let rest = source.replace(/^\s*--.*$/gmu, "").trim();
  while (rest.length > 0) {
    if (/^CREATE\s+(?:TEMP\s+)?TRIGGER\b/iu.test(rest)) {
      const end = /^END\s*;/imu.exec(rest);
      if (!end || end.index === undefined) throw new Error("incomplete migration trigger");
      const boundary = end.index + end[0].length;
      statements.push(rest.slice(0, boundary).trim());
      rest = rest.slice(boundary).trim();
      continue;
    }
    const boundary = rest.indexOf(";");
    if (boundary < 0) {
      statements.push(rest);
      break;
    }
    const statement = rest.slice(0, boundary).trim();
    if (statement) statements.push(statement);
    rest = rest.slice(boundary + 1).trim();
  }
  return statements;
}
