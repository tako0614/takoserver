import { expect, test } from "bun:test";
import sharedPricing from "../config/shared-hosted-pricing.json";
import { buildApp, createAppResourceStoreBundle } from "../src/app.ts";
import { parseBillingConfig } from "../src/billing-config.ts";
import { type Offering, priceMeteredUsage } from "../src/catalog.ts";
import { createEphemeralSql } from "../src/compat.ts";
import { createCanonicalHostedBillingComposition } from "../src/hosted-billing-composition.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { createLedger } from "../src/ledger.ts";
import { createMetering } from "../src/metering.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createProviderPack } from "../src/provider-pack.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

const ORG = "org_metering_ondemand";
const START = "2026-10-15T11:00:00.000Z";
const END = "2026-10-15T12:00:00.000Z";
const FORM = {
  apiVersion: "example.forms.test",
  kind: "MeteringWorkload",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
} as const;
const OFFERING: Offering = {
  id: "metering.on-demand",
  providerPackRef: "metering-provider",
  providerInstallationRef: "metering-provider.test",
  supplyContractRef: "metering-contract",
  pricePlanRef: "metering-price-v1",
  resourceClass: "compute.test",
  deliveryMode: "embedded-binding",
  supportPolicyRef: "support:test",
  abusePolicyRef: "abuse:test",
  kind: "worker",
  displayName: "Measured workload",
  form: FORM,
  pricePlan: {
    id: "metering-price-v1",
    currency: "USD",
    provisioning: { meter: "resource.create", amountMinor: 0 },
    meters: [{ meter: "compute.requests", amountMinor: 200 }],
  },
  providedInterfaces: [],
  bindingRefs: [],
  regions: ["test"],
  portability: { api: "portable", exportFormats: [], importFormats: [], migrationModes: [] },
  isolation: "dedicated-resource",
  available: true,
};
const TERMS = {
  termsRevision: "metering-terms-v1",
  consentRevision: "metering-consent-v1",
  currency: "USD",
  validity: { validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z" },
  replenishment: {
    trigger: "eligible-credit-deficit",
    rule: "ceil-deficit-to-quantum-with-minimum",
    fundingQuantumMinor: 100,
    minimumChargeMinor: 100,
    maximumChargeMinor: 1000,
  },
  cashCapBounds: { minimumMinor: 100, maximumMinor: 10000 },
  purchaseCreditExpiry: { kind: "none" },
};

// Native GET responses are local transport fixtures. The real realm/service,
// explicit consent writer, app and metering produce every admission witness.
// This neither authenticates a real payer nor exercises a provider mutation.
async function fixture(purchasedMicros = 1000000) {
  const sql = createEphemeralSql();
  let time = START;
  const clock = () => new Date(time);
  const shared = {
    ...structuredClone(sharedPricing),
    plans: sharedPricing.plans.map((plan, index) => ({
      ...plan,
      stripePriceId: `price_meter${index}`,
    })),
  };
  const pricing = compilePricingAuthoring({
    authoringVersion: 2,
    sharedPricing: shared,
    planIds: { free: "free", usage: "usage" },
    checkout: { minimumMinor: 100, maximumMinor: 10000 },
    billingConfig: {
      schemaVersion: 1,
      revision: shared.revision,
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 300,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: Object.fromEntries(
        shared.plans.map((plan) => [
          plan.planId,
          {
            includedMinor: Number(BigInt(plan.includedMicros) / 10000n),
            stripePriceId: plan.stripePriceId,
          },
        ]),
      ),
      meters: Object.fromEntries(
        Object.entries(shared.meters)
          .filter(([, meter]) => meter.cloudflareCostMicros !== "0")
          .map(([name, meter]) => [
            name,
            {
              unit: meter.unit,
              rate: {
                numeratorMicros: (BigInt(meter.cloudflareCostMicros) * 3n).toString(),
                denominator: meter.quantity,
              },
            },
          ]),
      ),
    },
  });
  const billingConfig = parseBillingConfig(pricing.environment.TAKOSERVER_BILLING_CONFIG);
  if (!billingConfig) throw new Error("fixture tariff missing");
  await sql.run("INSERT INTO stripe_mode_realm VALUES(1,'test',?)", [START]);
  await sql.run(
    "INSERT INTO stripe_billing_account_realms VALUES(1,'acct_metering','test','metering.test',?)",
    [START],
  );
  await sql.run("INSERT INTO orgs(id,name,owner_principal_id,created_at) VALUES(?,?,?,?)", [
    ORG,
    "Metering",
    "prn_metering",
    START,
  ]);
  await sql.run("INSERT INTO stripe_billing_customers VALUES(?,?,?)", [ORG, "cus_metering", START]);
  const calls: { method: string; path: string }[] = [];
  const client = createStripeBillingClient({
    secretKey: "sk_test_metering_fixture_not_a_credential",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      calls.push({ method: request.method, path });
      if (request.method !== "GET") throw new Error("metering must never request native cash");
      if (path === "/v1/account") return Response.json({ id: "acct_metering", object: "account" });
      if (path === "/v1/balance")
        return Response.json({ object: "balance", livemode: false, available: [], pending: [] });
      const price = shared.plans.find((plan) => path === `/v1/prices/${plan.stripePriceId}`);
      if (price)
        return Response.json({
          id: price.stripePriceId,
          object: "price",
          livemode: false,
          active: true,
          currency: "usd",
          unit_amount: Number(BigInt(price.monthlyPriceMicros) / 10000n),
          type: "recurring",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      if (path === "/v1/customers/cus_metering")
        return Response.json({
          id: "cus_metering",
          object: "customer",
          livemode: false,
          metadata: { organizationId: ORG, takoserverPurpose: "hosted_subscription" },
        });
      if (path === "/v1/payment_methods/pm_metering")
        return Response.json({
          id: "pm_metering",
          object: "payment_method",
          livemode: false,
          type: "card",
          customer: "cus_metering",
          card: { exp_month: 12, exp_year: 2030 },
        });
      if (["/v1/events", "/v1/invoices", "/v1/subscriptions"].includes(path))
        return Response.json({ data: [], has_more: false });
      return new Response(null, { status: 404 });
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql,
    reader: { client },
    expected: { accountId: "acct_metering", mode: "test", billingAuthority: "metering.test" },
    prices: shared.plans.map((plan) => ({
      priceId: plan.stripePriceId,
      monthlyAmountMinor: Number(BigInt(plan.monthlyPriceMicros) / 10000n),
    })),
  });
  const composition = await createCanonicalHostedBillingComposition({
    sql,
    clock,
    billingConfig,
    pricing,
    client,
    realm,
    consoleOrigin: "https://console.example.test",
    warnings: { state: "unavailable", reason: "transport-not-composed" },
    webhookSecret: "whsec_metering_fixture_not_a_credential",
    onDemand: {
      terms: TERMS,
      cardSetupReturnUrls: {
        successUrl: "https://console.example.test/card/success",
        cancelUrl: "https://console.example.test/card/cancel",
      },
      setupDisclosureRevision: "metering-card-v1",
    },
  });
  await composition.limitPolicy.change({
    organizationId: ORG,
    authorizedPrincipal: "session:prn_metering",
    reference: "accept_on_demand",
    onLimit: "on-demand",
    cashCapMinor: 5000,
    consentRevision: TERMS.consentRevision,
    termsRevision: TERMS.termsRevision,
    paymentMethodId: "pm_metering",
  });
  const stores = createAppResourceStoreBundle(sql, clock);
  await stores.deployments.create({
    tenantId: ORG,
    id: "dep_metering",
    resourceUid: "resource_metering",
    offeringId: OFFERING.id,
    providerPackRef: OFFERING.providerPackRef,
    providerInstallationRef: OFFERING.providerInstallationRef,
    nativeId: "native:metering",
    state: "active",
    observed: {},
    outputs: {},
  });
  let reads = 0;
  const pack = createProviderPack({
    id: OFFERING.providerPackRef,
    providerType: "test-provider",
    provisioners: [new FakeProvider({ id: "test-provider", offerings: [] })],
    attachmentFactories: [],
    transferEndpoints: [],
    credentialIssuers: [],
    costEstimators: [],
    meterSources: [
      {
        id: "metering-source",
        meters: ["compute.requests"],
        settlementDelaySeconds: 0,
        maximumWindowSeconds: 3600,
        async read() {
          reads++;
          return [{ meter: "compute.requests", quantity: 1 }];
        },
      },
    ],
  });
  const ledger = createLedger(sql, clock, { hostedPaidFreeExclusion: true });
  if (purchasedMicros > 0)
    await ledger.fund({
      organizationId: ORG,
      fundingRef: "existing_purchase",
      amountMicros: purchasedMicros,
      kind: "purchased",
      consumptionClass: "purchased",
    });
  const app = buildApp({
    sql,
    clock,
    billingConfig,
    hostedBilling: composition,
    resourceStores: stores,
    objects: createMemoryObjectStore(),
    identity: {
      async verify() {
        throw new Error("login is not part of this fixture");
      },
    },
    settlement: {
      async verify() {
        throw new Error("funding proof is not part of metering");
      },
    },
    publicOrigin: "https://api.example.test",
    v2: TEST_TAKOFORM_V2_CONFIG,
    forms: [],
    hostForms: [],
    offerings: [OFFERING],
    providerPacks: [pack],
    driver: new InMemoryTakoformResourceDriver(),
  });
  time = END;
  const directMetering = createMetering({
    sql,
    ledger,
    clock,
    randomId: () => "direct_replay",
    hostedPaidFreeExclusion: true,
    allocationAdmissionResolver: composition.limitPolicy.prepareAdmission.bind(
      composition.limitPolicy,
    ),
  });
  const window = {
    organizationId: ORG,
    resourceUid: "resource_metering",
    deploymentId: "dep_metering",
    meterSourceId: "metering-source",
    from: START,
    until: END,
    priced: priceMeteredUsage(OFFERING.pricePlan, [{ meter: "compute.requests", quantity: 1 }]),
  };
  return {
    sql,
    clock,
    app,
    ledger,
    composition,
    directMetering,
    window,
    calls,
    reads: () => reads,
  };
}

test("buildApp settles its provider window under genuine on-demand consent without fresh cash", async () => {
  const f = await fixture();
  const admission = await f.composition.limitPolicy.prepareAdmission(ORG);
  expect(admission).toMatchObject({
    onLimit: "on-demand",
    allowPurchasedCredit: true,
    policyVersion: 1,
    consentRevision: TERMS.consentRevision,
  });
  const report = await f.app.tick();
  let receiverError: unknown;
  try {
    await f.directMetering.recordProviderWindow(f.window);
  } catch (error) {
    receiverError = error;
  }
  expect({
    windows: report.providerMeterWindows,
    failures: report.providerMeterFailures,
    receiverError,
  }).toEqual({ windows: 1, failures: [], receiverError: undefined });
  expect(report.meteredRows).toBe(1);
  expect(f.reads()).toBe(1);
  expect(
    await f.sql.query("SELECT meter, quantity, rollup_id IS NOT NULL AS paid FROM usage_events"),
  ).toEqual([{ meter: "compute.requests", quantity: 1, paid: 1 }]);
  expect((await f.ledger.wallet(ORG)).availableMicros).toBe(500000);
  expect(
    await f.sql.query(
      "SELECT lot_ref,amount_micros FROM wallet_credit_allocations ORDER BY lot_ref",
    ),
  ).toEqual([
    { lot_ref: "existing_purchase", amount_micros: 500000 },
    { lot_ref: `free:${ORG}:2026-10`, amount_micros: 1500000 },
  ]);
  expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands")).toEqual([]);
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});

test("altered on-demand witness fields cannot write usage or acquire purchased eligibility", async () => {
  const f = await fixture();
  const before = await f.ledger.wallet(ORG);
  for (const corruption of [
    { allowPurchasedCredit: false },
    { policyVersion: 0 },
    { consentRevision: null },
    { consentRevision: "" },
    { consentRevision: "invalid revision" },
    { consentRevision: "x".repeat(129) },
  ]) {
    // Deliberately corrupt the real resolver's output to test its receiver;
    // this object is never represented as an authenticated positive witness.
    const receiver = createMetering({
      sql: f.sql,
      ledger: f.ledger,
      clock: f.clock,
      randomId: () => "corrupt_witness",
      hostedPaidFreeExclusion: true,
      allocationAdmissionResolver: async (org) => ({
        ...(await f.composition.limitPolicy.prepareAdmission(org)),
        ...corruption,
      }),
    });
    await expect(receiver.recordProviderWindow(f.window)).rejects.toMatchObject({
      code: "conservation_violated",
    });
  }
  expect(await f.sql.query("SELECT * FROM usage_events")).toEqual([]);
  expect(await f.sql.query("SELECT * FROM wallet_allocation_guards")).toEqual([]);
  expect(await f.ledger.wallet(ORG)).toEqual(before);
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});

test("unpaid app metering never starts cash and retains its original witness after stop", async () => {
  const f = await fixture(0);
  await expect(f.app.tick()).rejects.toMatchObject({ code: "insufficient_funds" });
  const pending = (
    await f.sql.query("SELECT admission_policy_json,rollup_id FROM usage_events")
  )[0];
  expect(JSON.parse(String(pending?.admission_policy_json))).toMatchObject({
    onLimit: "on-demand",
    policyVersion: 1,
    consentRevision: TERMS.consentRevision,
    allowPurchasedCredit: true,
  });
  expect(pending?.rollup_id).toBeNull();
  expect((await f.ledger.wallet(ORG)).availableMicros).toBe(1500000);
  expect(await f.sql.query("SELECT cursor_at FROM provider_meter_checkpoints")).toEqual([
    { cursor_at: Date.parse(END) },
  ]);
  expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands")).toEqual([]);
  expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual([]);
  await f.composition.limitPolicy.change({
    organizationId: ORG,
    reference: "stop_after_measurement",
    onLimit: "stop",
    authorizedPrincipal: "session:prn_metering",
  });
  await f.ledger.fund({
    organizationId: ORG,
    fundingRef: "later_purchase",
    amountMicros: 500000,
    kind: "purchased",
    consumptionClass: "purchased",
  });
  const settled = await f.app.tick();
  expect(settled.meteredRows).toBe(1);
  expect(settled.providerMeterWindows).toBe(0);
  expect(f.reads()).toBe(1);
  expect((await f.ledger.wallet(ORG)).availableMicros).toBe(0);
  await f.directMetering.recordProviderWindow(f.window);
  expect(await f.sql.query("SELECT admission_policy_json FROM usage_events")).toEqual([
    { admission_policy_json: pending?.admission_policy_json },
  ]);
  expect(await f.sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type='usage_debit'")).toEqual([
    { n: 1 },
  ]);
  await expect(
    f.directMetering.recordProviderWindow({
      ...f.window,
      priced: priceMeteredUsage(OFFERING.pricePlan, [{ meter: "compute.requests", quantity: 2 }]),
    }),
  ).rejects.toMatchObject({ code: "conservation_violated" });
  expect(await f.sql.query("SELECT * FROM stripe_billing_on_demand_commands")).toEqual([]);
  expect(await f.sql.query("SELECT * FROM org_wallet_cash_exposures")).toEqual([]);
  expect(f.calls.every((call) => call.method === "GET")).toBe(true);
});
