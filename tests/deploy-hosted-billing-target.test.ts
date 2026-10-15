import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectedWorkerSecrets, writeWorkerConfig } from "../scripts/deploy/realized-config.ts";
import { parseDeployTarget } from "../scripts/deploy/target.ts";
import {
  assertTargetComposes,
  workerCompositionEnv,
} from "../scripts/deploy/worker-composition.ts";
import { createWorkerEntry, type WorkerEnv } from "../src/entry-worker.ts";

const BASE = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "takoserver-api-integration",
  d1: {
    databaseName: "takoserver-integration",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "takoserver-integration" },
  publicOrigin: "https://api.integration.example.test",
  signing: { currentKeyId: "integration-fixture" },
};
const BILLING = {
  schemaVersion: 1,
  revision: "deploy-billing-r1",
  effectiveAt: "2026-10-01T00:00:00.000Z",
  currency: "USD",
  holdTtlSeconds: 60,
  freeIncludedMinor: 0,
  purchaseCreditExpiry: { kind: "none" },
  plans: { starter: { includedMinor: 1000, stripePriceId: "price_deployfixture" } },
  meters: { requests: { unit: "request", rate: { numeratorMicros: "10000", denominator: "1" } } },
};
const PRICING = JSON.stringify({
  authoringVersion: 1,
  planIds: { free: "free", subscription: "starter", usage: "usage" },
  billingConfig: BILLING,
  checkout: { minimumMinor: 50, maximumMinor: 10000 },
  stripeMonthlyReview: {
    starter: { expectedAmountMinor: 1000, currency: "USD", interval: "month" },
  },
});
const ON_DEMAND = {
  terms: {
    termsRevision: "deploy-terms-r1",
    consentRevision: "deploy-consent-r1",
    currency: "USD",
    validity: { validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z" },
    replenishment: {
      trigger: "eligible-credit-deficit",
      rule: "ceil-deficit-to-quantum-with-minimum",
      fundingQuantumMinor: 25,
      minimumChargeMinor: 50,
      maximumChargeMinor: 1000,
    },
    cashCapBounds: { minimumMinor: 50, maximumMinor: 10000 },
    purchaseCreditExpiry: { kind: "none" },
  },
  cardSetupReturnUrls: {
    successUrl: "https://console.example.test/wallet/card-saved",
    cancelUrl: "https://console.example.test/wallet/card-canceled",
  },
  setupDisclosureRevision: "deploy-disclosure-r1",
};

function selection() {
  return {
    selector: "canonical-test",
    stripeMode: "test",
    accountId: "acct_deployfixture",
    billingAuthority: "deploy-fixture",
  };
}
function descriptor() {
  return {
    ...BASE,
    consoleOrigin: "https://console.example.test",
    billingConfig: structuredClone(BILLING),
    hostedPricing: PRICING,
    hostedBilling: { ...selection(), onDemand: structuredClone(ON_DEMAND) },
  };
}
function parse(value: unknown) {
  return parseDeployTarget(value, "synthetic-deploy-target.json", "integration");
}

/** Entry configuration only: the first real persistence access deliberately refuses. */
async function entryConfiguration(
  variables: object,
  names: readonly string[],
  overrides: Readonly<Record<string, unknown>> = {},
) {
  let persistenceAccesses = 0;
  const secretFixtures = Object.fromEntries(
    names
      .filter((name) => name === "STRIPE_SECRET_KEY" || name === "STRIPE_WEBHOOK_SECRET")
      .map((name) => [
        name,
        name === "STRIPE_SECRET_KEY" ? "sk_test_deploy_fixture" : "whsec_deploy_fixture",
      ]),
  );
  const env = {
    ...variables,
    ...secretFixtures,
    TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
      documentation: "https://docs.example.test/v2",
      authenticationDocumentation: "https://docs.example.test/v2/authentication",
    }),
    TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: "A".repeat(43),
    ...overrides,
    get STATE_DB(): never {
      persistenceAccesses++;
      throw new TypeError("Entry configuration boundary reached; persistence not qualified");
    },
  } as unknown as WorkerEnv;
  const response = await createWorkerEntry().fetch(
    new Request(`${BASE.publicOrigin}/healthz`),
    env,
  );
  expect(response.status).toBe(503);
  return persistenceAccesses;
}

describe("owning deploy canonical Hosted TEST configuration", () => {
  test("parses and realizes explicit settings through the simulation and actual entry configuration", async () => {
    const target = parse(descriptor());
    const directory = mkdtempSync(join(tmpdir(), "takoserver-hosted-billing-target-"));
    try {
      const path = writeWorkerConfig(target, {
        path: join(directory, "worker.json"),
        main: "worker.js",
        commit: "b".repeat(40),
      });
      const generated = JSON.parse(readFileSync(path, "utf8")) as {
        vars: Record<string, string>;
        secrets: { required: string[] };
      };
      expect(generated.vars).toMatchObject({
        TAKOSERVER_HOSTED_BILLING: "canonical-test",
        TAKOSERVER_STRIPE_MODE: "test",
        TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID: "acct_deployfixture",
        TAKOSERVER_HOSTED_BILLING_AUTHORITY: "deploy-fixture",
      });
      expect(JSON.parse(generated.vars.TAKOSERVER_HOSTED_BILLING_ON_DEMAND ?? "null")).toEqual(
        ON_DEMAND,
      );
      expect(generated.vars).not.toHaveProperty("TAKOSERVER_STRIPE_CHECKOUT_ENABLED");
      expect(generated.vars).not.toHaveProperty("TAKOSERVER_STRIPE_WEBHOOK_ENABLED");
      expect(generated.vars).not.toHaveProperty("STRIPE_SECRET_KEY");
      expect(generated.vars).not.toHaveProperty("STRIPE_WEBHOOK_SECRET");
      expect(generated.secrets.required).toEqual([
        "STRIPE_SECRET_KEY",
        "STRIPE_WEBHOOK_SECRET",
        "TAKOSERVER_SIGNING_KEY",
      ]);
      const projected = workerCompositionEnv(target);
      for (const [name, value] of Object.entries(projected))
        expect(generated.vars[name]).toBe(value);
      await assertTargetComposes("preflight", target);
      expect(await entryConfiguration(projected, generated.secrets.required)).toBe(1);
      // The real entry requires each credential even though no legacy flag was selected.
      for (const missing of ["STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET"]) {
        expect(
          await entryConfiguration(projected, generated.secrets.required, { [missing]: undefined }),
        ).toBe(0);
      }
      expect(
        await entryConfiguration(projected, generated.secrets.required, {
          TAKOSERVER_STRIPE_MODE: "live",
        }),
      ).toBe(0);
      expect(
        await entryConfiguration(projected, generated.secrets.required, {
          TAKOSERVER_HOSTED_BILLING_ON_DEMAND: "{}",
        }),
      ).toBe(0);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("canonical without on-demand adds no cash terms and needs no legacy flags", async () => {
    const target = parse({ ...descriptor(), hostedBilling: selection() });
    const projected = workerCompositionEnv(target);
    expect(projected).not.toHaveProperty("TAKOSERVER_HOSTED_BILLING_ON_DEMAND");
    expect(await entryConfiguration(projected, expectedWorkerSecrets(target))).toBe(1);
  });

  test("absent selection preserves existing plain and legacy secret requirements", () => {
    const plain = parse(BASE);
    expect(workerCompositionEnv(plain)).toEqual({});
    expect(expectedWorkerSecrets(plain)).toEqual(["TAKOSERVER_SIGNING_KEY"]);
    expect(expectedWorkerSecrets(parse({ ...BASE, stripeCheckout: true }))).toEqual([
      "STRIPE_SECRET_KEY",
      "TAKOSERVER_SIGNING_KEY",
    ]);
  });

  test("refuses invalid selectors, non-test, unknown fields, mixed flags and incomplete realm", () => {
    for (const hostedBilling of [
      null,
      false,
      "canonical-test",
      [],
      {},
      { ...selection(), selector: "canonical-live" },
      { ...selection(), selector: "" },
      { ...selection(), selector: " canonical-test" },
      { ...selection(), stripeMode: "live" },
      { ...selection(), stripeMode: undefined },
      { ...selection(), accountId: undefined },
      { ...selection(), accountId: "a".repeat(32) },
      { ...selection(), billingAuthority: undefined },
      { ...selection(), billingAuthority: "" },
      { ...selection(), secretKey: "fixture-must-never-appear" },
    ])
      expect(() => parse({ ...descriptor(), hostedBilling })).toThrow();
    try {
      parse({
        ...descriptor(),
        hostedBilling: { ...selection(), secretKey: "fixture-must-never-appear" },
      });
      throw new Error("Expected closed Hosted target refusal");
    } catch (error) {
      expect(error).toMatchObject({ phase: "preflight" });
      expect(String(error)).not.toContain("fixture-must-never-appear");
    }
    for (const name of ["stripeCheckout", "stripeWebhook"]) {
      for (const value of [true, false])
        expect(() => parse({ ...descriptor(), [name]: value })).toThrow();
    }
  });

  test("refuses missing or contradictory pricing, console and explicit bounds", () => {
    for (const overrides of [
      { billingConfig: undefined },
      { hostedPricing: undefined },
      { consoleOrigin: undefined },
      { billingConfig: { ...BILLING, revision: "contradictory-r2" } },
      { stripeSettings: { checkoutMinimumMinor: 100 } },
      { stripeSettings: { checkoutMaximumMinor: 20000 } },
    ])
      expect(() => parse({ ...descriptor(), ...overrides })).toThrow();
    expect(() =>
      parse({
        ...descriptor(),
        stripeSettings: { checkoutMinimumMinor: 50, checkoutMaximumMinor: 10000 },
      }),
    ).not.toThrow();
  });

  test("terms are explicit closed USD inputs with no currency, cash or quantum defaults", () => {
    for (const terms of [
      {},
      { ...ON_DEMAND.terms, currency: "EUR" },
      { ...ON_DEMAND.terms, cashCapBounds: undefined },
      { ...ON_DEMAND.terms, purchaseCreditExpiry: undefined },
      {
        ...ON_DEMAND.terms,
        replenishment: { ...ON_DEMAND.terms.replenishment, fundingQuantumMinor: 0 },
      },
      { ...ON_DEMAND.terms, postpaid: true },
    ])
      expect(() =>
        parse({
          ...descriptor(),
          hostedBilling: { ...selection(), onDemand: { ...ON_DEMAND, terms } },
        }),
      ).toThrow();
  });

  test("card setup requires complete same-origin HTTPS returns and disclosure", () => {
    for (const onDemand of [
      null,
      "{}",
      {},
      { ...ON_DEMAND, setupDisclosureRevision: "" },
      { ...ON_DEMAND, extra: true },
      {
        ...ON_DEMAND,
        cardSetupReturnUrls: { successUrl: ON_DEMAND.cardSetupReturnUrls.successUrl },
      },
      ...[
        "http://console.example.test/cancel",
        "https://foreign.example.test/cancel",
        "https://user:password@console.example.test/cancel",
        "https://console.example.test/cancel#fragment",
        "https://console.example.test/cancel?token=fixture",
        "https://console.example.test/cancel?client_secret=fixture",
        `https://console.example.test/${"x".repeat(2048)}`,
      ].map((cancelUrl) => ({
        ...ON_DEMAND,
        cardSetupReturnUrls: { ...ON_DEMAND.cardSetupReturnUrls, cancelUrl },
      })),
    ])
      expect(() =>
        parse({ ...descriptor(), hostedBilling: { ...selection(), onDemand } }),
      ).toThrow();
  });
});
