import { expect, spyOn, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import type { FinancialDisplayedTermsR1 } from "../src/financial-displayed-terms.ts";
import { createCanonicalHostedBillingComposition } from "../src/hosted-billing-composition.ts";
import { base64UrlDecode, bytesDigest, canonicalJson } from "../src/json.ts";
import type { Sql } from "../src/ports.ts";
import type { SelectedEconomicR1 } from "../src/shared-financial-retained-r1.ts";
import {
  fixture,
  NEXT,
  ORG,
  operatorConfiguration,
} from "./helpers/financial-displayed-canonical-fixture.ts";

// Public canonical factory and original subscription writers over in-memory owning SQL.
// Only native HTTP is synthetic. No Root human/class/permission or R1 issuer is fabricated.
async function canonical() {
  const f = await fixture();
  try {
    const billingConfig = parseBillingConfig(f.pricing.environment.TAKOSERVER_BILLING_CONFIG);
    if (!billingConfig) throw Error("original canonical tariff missing");
    const configuration = operatorConfiguration();
    const composition = await createCanonicalHostedBillingComposition({
      sql: f.sql,
      clock: f.clock,
      billingConfig,
      pricing: f.pricing,
      client: f.client,
      realm: f.realm,
      consoleOrigin: "https://console.example.test",
      warnings: { state: "unavailable", reason: "transport-not-composed" },
      webhookSecret: "whsec_displayed_terms_synthetic_fixture",
      onDemand: configuration,
    });
    if (!composition.paymentActivation) throw Error("actual canonical fixture unavailable");
    const payments = composition.createPayments({
      sql: f.sql,
      clock: f.clock,
      async credit() {
        throw Error("parallel grant callback forbidden");
      },
      async creditedFunding() {
        return new Set<string>();
      },
    });
    return { ...f, composition, payments, configuration };
  } catch (error) {
    f.db.close();
    throw error;
  }
}
type F = Awaited<ReturnType<typeof canonical>>;
type Action = SelectedEconomicR1["kind"];

const COMMAND_TABLES = [
  "stripe_billing_customers",
  "stripe_billing_customer_commands",
  "stripe_top_up_commands",
  "stripe_subscription_checkout_intents",
  "stripe_subscription_cancellation_intents",
  "stripe_billing_plan_changes",
  "stripe_billing_plan_change_slots",
  "stripe_billing_plan_change_steps",
  "stripe_billing_card_setup_commands",
  "stripe_billing_on_demand_commands",
  "org_wallet_cash_exposures",
] as const;
async function commandRows(sql: Sql) {
  return Object.fromEntries(
    await Promise.all(
      COMMAND_TABLES.map(async (table) => [
        table,
        (await sql.query(`SELECT * FROM ${table}`)).map(canonicalJson).sort(),
      ]),
    ),
  );
}
async function observe<T>(f: F, invoke: () => Promise<T>) {
  const query = spyOn(f.sql, "query"),
    run = spyOn(f.sql, "run"),
    batch = spyOn(f.sql, "batch");
  const calls = f.calls.length;
  try {
    const value = await invoke();
    return {
      value,
      trace: structuredClone({
        query: query.mock.calls,
        run: run.mock.calls,
        batch: batch.mock.calls,
      }),
      native: structuredClone(f.calls.slice(calls)),
    };
  } finally {
    query.mockRestore();
    run.mockRestore();
    batch.mockRestore();
  }
}
function economicImage(e: SelectedEconomicR1): SelectedEconomicR1 {
  if (e.kind !== "topup" && e.kind !== "subscription-start") return e;
  const {
    accountId: _account,
    livemode: _mode,
    financialRealm: _realm,
    ...image
  } = e as SelectedEconomicR1 & {
    accountId?: string;
    livemode?: boolean;
    financialRealm?: string;
  };
  return image as SelectedEconomicR1;
}
async function exactBody(result: FinancialDisplayedTermsR1) {
  const raw = base64UrlDecode(result.selectedTerms.bodyUtf8Base64url);
  if (!raw) throw Error("original body missing");
  expect(raw).toEqual(new TextEncoder().encode(result.displayText));
  expect(await bytesDigest(raw)).toBe(result.selectedTerms.digest);
  expect(result.selectedTerms.ref).toBe(`terms:${result.selectedTerms.digest.slice(7)}`);
  expect(result.selectedTerms.bodyByteLength).toBe(raw.byteLength);
  expect(result.selectedTerms.digestRecipe).toBe("financial-terms-utf8-sha256-v1");
  expect(result.selectedTerms.mediaType).toBe("text/plain; charset=utf-8");
  expect(result.selectedTerms.locale).toBe("en");
  expect(Object.isFrozen(result)).toBe(true);
  expect(Object.isFrozen(result.economic)).toBe(true);
  expect(Object.isFrozen(result.selectedTerms)).toBe(true);
}
async function selection(
  f: F,
  kind: Action,
): Promise<{
  direct(): Promise<SelectedEconomicR1>;
  display(): Promise<FinancialDisplayedTermsR1>;
}> {
  const ref = kind === "plan-change" || kind === "cancel" ? await f.begin() : null;
  if (kind === "subscription-start") await f.payments.subscriptionCustody.read(ORG);
  switch (kind) {
    case "topup": {
      const input = { organizationId: ORG, reference: "display-topup", amountMinor: 500 };
      return {
        direct: () => f.composition.selectTopUpEconomicR1(input),
        display: () => f.composition.selectTopUpDisplayedTermsR1(input),
      };
    }
    case "card-setup":
      return {
        direct: () => f.composition.selectCardSetupEconomicR1(),
        display: () => f.composition.selectCardSetupDisplayedTermsR1(),
      };
    case "subscription-start": {
      const input = { organizationId: ORG, reference: "display-start", planKey: "hosted-10" };
      return {
        direct: () => f.payments.selectSubscriptionStartEconomicR1(input),
        display: () => f.payments.selectSubscriptionStartDisplayedTermsR1(input),
      };
    }
    case "plan-change": {
      if (!ref) throw Error("actual original missing");
      const input = {
        organizationId: ORG,
        reference: "display-plan",
        expectedSubscriptionRef: ref,
        planKey: "hosted-50",
      };
      return {
        direct: () => f.payments.preparePlanChangeEconomicR1(input),
        display: () => f.payments.preparePlanChangeDisplayedTermsR1(input),
      };
    }
    case "cancel": {
      if (!ref) throw Error("actual original missing");
      const input = {
        organizationId: ORG,
        reference: "display-cancel",
        expectedSubscriptionRef: ref,
      };
      return {
        direct: () => f.payments.prepareCancellationEconomicR1(input),
        display: () => f.payments.prepareCancellationDisplayedTermsR1(input),
      };
    }
  }
}

for (const kind of [
  "topup",
  "subscription-start",
  "card-setup",
  "plan-change",
  "cancel",
] as const) {
  test(`${kind}: canonical display uses exactly one real selector trace and the same economic/UTF8 original`, async () => {
    const f = await canonical();
    try {
      const source = await selection(f, kind);
      await source.direct(); // Existing PLAN/CANCEL readiness may retain period terms.
      const expected = await observe(f, source.direct);
      const before = await commandRows(f.sql);
      const actual = await observe(f, source.display);
      expect(actual.value.economic).toEqual(economicImage(expected.value));
      expect(actual.trace).toEqual(expected.trace); // A repeated selector would repeat the actual SQL trace.
      expect(actual.trace.query.length).toBeGreaterThan(0);
      expect(actual.native).toEqual(expected.native);
      expect(actual.native.filter((call) => call.method !== "GET")).toEqual([]);
      expect(await commandRows(f.sql)).toEqual(before);
      await exactBody(actual.value);
      switch (kind) {
        case "topup":
          expect(actual.value.displayText).toContain("USD 5.00");
          break;
        case "subscription-start":
          expect(actual.value.displayText).toContain("Payment per 1 month: USD 10.00");
          break;
        case "card-setup":
          expect(actual.value.displayText).toContain(f.configuration.setupDisclosureRevision);
          break;
        case "plan-change":
          expect(actual.value.displayText).toContain("USD 50.00");
          expect(actual.value.displayText).toContain(NEXT);
          break;
        case "cancel":
          expect(actual.value.economic).toMatchObject({ branch: "legacy" });
          expect(actual.value.displayText).toContain("Cancel at period end: true");
          break;
      }
    } finally {
      f.db.close();
    }
  });
}

test("pending-plan cancellation display follows the actual phase owner and retains its original without dispatch", async () => {
  const f = await canonical();
  try {
    const ref = await f.begin();
    await f.change(ref);
    const input = {
      organizationId: ORG,
      reference: "display-phase-cancel",
      expectedSubscriptionRef: ref,
    };
    const expected = await f.payments.prepareCancellationEconomicR1(input);
    expect(expected).toMatchObject({
      branch: "pending-plan-change",
      pendingReference: "actual-upgrade",
      scheduleId: "sub_sched_actual",
    });
    const before = await commandRows(f.sql),
      calls = f.calls.length;
    const result = await f.payments.prepareCancellationDisplayedTermsR1(input);
    expect(result.economic).toEqual(expected);
    expect(result.displayText).toContain("Pending plan change: present");
    expect(result.displayText).not.toContain("sub_sched_actual");
    expect(result.displayText).not.toContain("actual-upgrade");
    expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
    expect(await commandRows(f.sql)).toEqual(before);
    await exactBody(result);
  } finally {
    f.db.close();
  }
});

for (const kind of ["subscription-start", "plan-change", "cancel"] as const) {
  test(`${kind}: replacing the returned selector facade cannot replace the captured real callable/receiver`, async () => {
    const f = await canonical();
    try {
      const source = await selection(f, kind),
        expected = economicImage(await source.direct());
      let replacements = 0;
      const replacement = async () => {
        replacements++;
        throw Error("caller replacement must not run");
      };
      Object.assign(f.payments, {
        selectSubscriptionStartEconomicR1: replacement,
        preparePlanChangeEconomicR1: replacement,
        prepareCancellationEconomicR1: replacement,
      });
      Object.assign(f.payments.subscriptionPlans, { preparePlanChangeEconomicR1: replacement });
      const before = await commandRows(f.sql),
        calls = f.calls.length;
      const result = await source.display();
      expect(result.economic).toEqual(expected);
      expect(replacements).toBe(0);
      expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
      expect(await commandRows(f.sql)).toEqual(before);
      await exactBody(result);
    } finally {
      f.db.close();
    }
  });
}

test("actual PLAN await cannot change its captured organization/ref/plan or reconstruct another economic original", async () => {
  const f = await canonical();
  let release = () => {};
  const originalQuery = f.sql.query;
  try {
    const ref = await f.begin();
    const input = {
      organizationId: ORG,
      reference: "display-await",
      expectedSubscriptionRef: ref,
      planKey: "hosted-50",
    };
    const expected = await f.payments.preparePlanChangeEconomicR1(input),
      before = await commandRows(f.sql),
      calls = f.calls.length;
    let entered = () => {},
      blocked = false;
    const reached = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const resume = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.sql.query = async function (statement, params) {
      if (!blocked) {
        blocked = true;
        entered();
        await resume;
      }
      return originalQuery.call(this, statement, params);
    };
    const pending = f.payments.preparePlanChangeDisplayedTermsR1(input);
    const outcome = pending.then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error }),
    );
    await Promise.race([
      reached,
      outcome.then(() => {
        throw Error("selector settled before the real SQL gate");
      }),
    ]);
    Object.assign(input, {
      organizationId: "org_wrong",
      reference: "replaced",
      expectedSubscriptionRef: "sra_wrong",
      planKey: "hosted-10",
    });
    release();
    const result = await outcome;
    if (!result.value) throw result.error;
    expect(result.value.economic).toEqual(expected);
    expect(result.value.displayText).toContain("USD 50.00");
    expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
    expect(await commandRows(f.sql)).toEqual(before);
    await exactBody(result.value);
  } finally {
    release();
    f.sql.query = originalQuery;
    f.db.close();
  }
});

test("unknown persisted-realm read returns the actual card selector error once with no retry or native dispatch", async () => {
  const f = await canonical();
  try {
    const before = await commandRows(f.sql),
      calls = f.calls.length;
    const query = spyOn(f.sql, "query").mockRejectedValue(new Error("unknown SQL observation"));
    try {
      await expect(f.composition.selectCardSetupDisplayedTermsR1()).rejects.toMatchObject({
        name: "StripeCardSetupError",
        code: "unavailable",
      });
      expect(query).toHaveBeenCalledTimes(1);
    } finally {
      query.mockRestore();
    }
    expect(f.calls.length).toBe(calls);
    expect(await commandRows(f.sql)).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("unknown real PLAN native read preserves its existing error class and never retries or dispatches", async () => {
  const f = await canonical();
  try {
    const source = await selection(f, "plan-change");
    await source.direct();
    const before = await commandRows(f.sql),
      calls = f.calls.length;
    const get = spyOn(f.client, "get").mockRejectedValue(new Error("unknown native observation"));
    const reject = async (invoke: () => Promise<unknown>) => {
      let rejected = false,
        original: unknown;
      try {
        await invoke();
      } catch (error) {
        rejected = true;
        original = error;
      }
      if (!rejected) throw Error("actual source rejection required");
      return original;
    };
    try {
      const expected = await reject(source.direct);
      expect(get).toHaveBeenCalledTimes(1);
      get.mockClear();
      const actual = await reject(source.display);
      expect(get).toHaveBeenCalledTimes(1);
      expect(actual).toBeInstanceOf(Error);
      expect(expected).toBeInstanceOf(Error);
      if (!(actual instanceof Error) || !(expected instanceof Error))
        throw Error("original source errors absent");
      expect(actual.constructor).toBe(expected.constructor);
      expect(actual.message).toBe(expected.message);
    } finally {
      get.mockRestore();
    }
    expect(f.calls.length).toBe(calls);
    expect(await commandRows(f.sql)).toEqual(before);
  } finally {
    f.db.close();
  }
});

test("actual constructor-captured card policy remains the same original after caller configuration mutation", async () => {
  const f = await canonical();
  try {
    const expected = await f.composition.selectCardSetupEconomicR1();
    const before = await commandRows(f.sql),
      calls = f.calls.length;
    f.configuration.setupDisclosureRevision = "caller-replaced-disclosure";
    f.configuration.terms.termsRevision = "caller-replaced-terms";
    f.configuration.terms.replenishment.maximumChargeMinor = 500;
    const result = await f.composition.selectCardSetupDisplayedTermsR1();
    expect(result.economic).toEqual(expected);
    expect(result.displayText).toContain("Maximum single charge: USD 10.00");
    expect(result.displayText).not.toContain("caller-replaced");
    expect(f.calls.length).toBe(calls);
    expect(await commandRows(f.sql)).toEqual(before);
    await exactBody(result);
  } finally {
    f.db.close();
  }
});
