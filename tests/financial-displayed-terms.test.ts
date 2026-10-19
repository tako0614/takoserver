import { expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import {
  captureFinancialDisplayInput,
  createFinancialDisplayedTermsSource,
  type FinancialDisplayedTermsPolicy,
} from "../src/financial-displayed-terms.ts";
import { base64UrlDecode, bytesDigest } from "../src/json.ts";
import {
  FinancialRetainedR1Error,
  type SelectedEconomicR1,
} from "../src/shared-financial-retained-r1.ts";
import { financialSourceRef } from "../src/shared-financial-source-contract.ts";

// Synthetic local rendering fixtures only, never genuine source registration or a legal/consent issuer.
function displayPolicy(): FinancialDisplayedTermsPolicy {
  const billingConfig = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "display-r1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 300,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "fixed-duration", seconds: 3600 },
      plans: { small: { includedMinor: 2000, stripePriceId: "price_small" } },
      meters: { requests: { unit: "request", rate: { numeratorMicros: "3", denominator: "2" } } },
    }),
  );
  if (!billingConfig) throw Error("test tariff missing");
  return {
    billingConfig,
    plans: [
      { planKey: "small", priceId: "price_small", priceAmountMinor: 1000, includedMinor: 2000 },
    ],
    checkoutBounds: { minimumMinor: 50, maximumMinor: 10000 },
    postpaidEnabled: false,
    onDemand: {
      setupDisclosureRevision: "save-card-r1",
      terms: {
        termsRevision: "on-demand-r1",
        consentRevision: "consent-r1",
        currency: "USD",
        validity: { validFrom: "2026-10-01T00:00:00.000Z", validUntil: "2027-01-01T00:00:00.000Z" },
        replenishment: {
          trigger: "eligible-credit-deficit",
          rule: "ceil-deficit-to-quantum-with-minimum",
          fundingQuantumMinor: 50,
          minimumChargeMinor: 50,
          maximumChargeMinor: 1000,
        },
        cashCapBounds: { minimumMinor: 50, maximumMinor: 10000 },
        purchaseCreditExpiry: { kind: "none" },
      },
    },
  };
}
function topup(amountMinor = 500): Extract<SelectedEconomicR1, { kind: "topup" }> {
  return {
    kind: "topup",
    amountMinor,
    currency: "USD",
    pricingRevision: "display-r1",
    purchaseCreditExpiry: { kind: "fixed-duration", seconds: 3600 },
    minimumMinor: 50,
    maximumMinor: 10000,
  };
}
function selected(kind: SelectedEconomicR1["kind"]): SelectedEconomicR1 {
  switch (kind) {
    case "topup":
      return topup();
    case "subscription-start":
      return {
        kind,
        planKey: "small",
        pricingRevision: "display-r1",
        priceId: "price_small",
        priceAmountMinor: 1000,
        includedMinor: 2000,
        currency: "USD",
        periodMonths: 1,
      };
    case "card-setup":
      return {
        kind,
        setupDisclosureRevision: "save-card-r1",
        onDemandTermsRevision: "on-demand-r1",
      };
    case "plan-change":
      return {
        kind,
        expectedSubscriptionRef: "sra_original",
        targetSubscriptionId: "sub_original",
        targetGeneration: 7,
        targetPeriodStart: "2026-10-01T00:00:00.000Z",
        targetPeriodEnd: "2026-11-01T00:00:00.000Z",
        planKey: "small",
        pricingRevision: "display-r1",
        priceId: "price_small",
        priceAmountMinor: 1000,
        includedMinor: 2000,
        currency: "USD",
      };
    case "cancel":
      return {
        kind,
        expectedSubscriptionRef: "sra_original",
        targetSubscriptionId: "sub_original",
        targetGeneration: 7,
        branch: "legacy",
        pendingReference: null,
        scheduleId: null,
        cancelAtPeriodEnd: true,
      };
  }
}

for (const kind of [
  "topup",
  "subscription-start",
  "card-setup",
  "plan-change",
  "cancel",
] as const) {
  test(`${kind}: exact display UTF8 bytes define existing R1 terms metadata without another rendering`, async () => {
    const source = createFinancialDisplayedTermsSource(displayPolicy());
    const economic = selected(kind),
      result = await source.fromEconomic(economic);
    const raw = base64UrlDecode(result.selectedTerms.bodyUtf8Base64url);
    if (!raw) throw Error("exact terms encoding missing");
    expect(new TextDecoder("utf-8", { fatal: true }).decode(raw)).toBe(result.displayText);
    expect(raw).toEqual(new TextEncoder().encode(result.displayText));
    expect(await bytesDigest(raw)).toBe(result.selectedTerms.digest);
    expect(result.selectedTerms.bodyByteLength).toBe(raw.byteLength);
    expect(result.selectedTerms.digestRecipe).toBe("financial-terms-utf8-sha256-v1");
    expect(result.selectedTerms.mediaType).toBe("text/plain; charset=utf-8");
    expect(result.selectedTerms.locale).toBe("en");
    expect(result.selectedTerms.ref).toBe(`terms:${result.selectedTerms.digest.slice(7)}`);
    expect(financialSourceRef(result.selectedTerms.ref)).toBe(true);
    expect(result.economic).toEqual(economic);
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.selectedTerms)).toBe(true);
    expect(await source.fromEconomic(economic)).toEqual(result);
  });
}

test("each action displays only its selected economic meaning and configured policy facts", async () => {
  const source = createFinancialDisplayedTermsSource(displayPolicy());
  const add = await source.fromEconomic(topup());
  expect(add.displayText).toContain("Payment and purchased credit face value: USD 5.00");
  expect(add.displayText).toContain("3600 seconds after first verified funding");
  expect(add.displayText).not.toContain("subscription plan");
  const start = await source.fromEconomic(selected("subscription-start"));
  expect(start.displayText).toContain("Payment per 1 month: USD 10.00");
  expect(start.displayText).toContain("Included credit per period: USD 20.00");
  const plan = await source.fromEconomic(selected("plan-change"));
  expect(plan.displayText).toContain("Target period start: 2026-10-01T00:00:00.000Z");
  expect(plan.displayText).toContain(
    "Change effective at target period end: 2026-11-01T00:00:00.000Z",
  );
  const cancel = await source.fromEconomic(selected("cancel"));
  expect(cancel.displayText).toContain("Cancel at period end: true");
  expect(cancel.displayText).not.toContain("USD 10.00");
  expect(cancel.displayText).not.toContain("refund");
  const card = await source.fromEconomic(selected("card-setup"));
  expect(card.displayText).toContain('Setup disclosure revision: "save-card-r1"');
  expect(card.displayText).toContain('Separate on-demand consent revision: "consent-r1"');
  expect(card.displayText).toContain("Maximum single charge: USD 10.00");
  expect(card.displayText).toContain("ceil-deficit-to-quantum-with-minimum");
  expect(card.displayText).not.toContain("guarantee");
});

test("safe integer minor amounts use exact decimal cents even at Number.MAX_SAFE_INTEGER", async () => {
  const policy = displayPolicy(),
    first = policy.plans[0];
  if (!first) throw Error("selected test plan missing");
  Object.assign(first, { priceAmountMinor: Number.MAX_SAFE_INTEGER });
  const e = selected("subscription-start");
  if (e.kind !== "subscription-start") throw Error("wrong test selection");
  const result = await createFinancialDisplayedTermsSource(policy).fromEconomic({
    ...e,
    priceAmountMinor: Number.MAX_SAFE_INTEGER,
  });
  expect(result.displayText).toContain("USD 90071992547409.91");
  expect(result.displayText).not.toContain("90071992547409.92");
});

test("economic and constructor policy snapshots cannot change during the raw SHA await", async () => {
  const policy = displayPolicy(),
    e = topup(),
    source = createFinancialDisplayedTermsSource(policy);
  const pending = source.fromEconomic(e);
  Object.assign(e, { amountMinor: 600 });
  Object.assign(e.purchaseCreditExpiry, { seconds: 7200 });
  Object.assign(policy.billingConfig, { revision: "later-pricing" });
  const rate = policy.billingConfig.meters.requests?.rate;
  if (!rate) throw Error("original meter missing");
  Object.assign(rate, { numeratorMicros: "999" });
  const result = await pending;
  expect(result.economic).toMatchObject({
    amountMinor: 500,
    purchaseCreditExpiry: { kind: "fixed-duration", seconds: 3600 },
  });
  expect(result.displayText).toContain('"requests": 3/2 microUSD per "request"');
  expect(result.displayText).toContain('Configured pricing revision: "display-r1"');
  expect(result.displayText).not.toContain("later-pricing");
  expect(Object.isFrozen(result.economic)).toBe(true);
});

for (const amount of [-1, 0, -0, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
  test(`invalid amount ${Object.is(amount, -0) ? "negative-zero" : amount} never becomes displayed payment DATA`, async () => {
    await expect(
      createFinancialDisplayedTermsSource(displayPolicy()).fromEconomic(topup(amount)),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });
}

test("caller body/terms DTO and locale override cannot replace the owned text source", async () => {
  const policy = displayPolicy();
  expect(() =>
    createFinancialDisplayedTermsSource(Object.assign(policy, { body: "arbitrary terms" })),
  ).toThrow(FinancialRetainedR1Error);
  expect(() =>
    createFinancialDisplayedTermsSource(Object.assign(displayPolicy(), { locale: "ja-JP" })),
  ).toThrow(FinancialRetainedR1Error);
  await expect(
    createFinancialDisplayedTermsSource(displayPolicy()).fromEconomic(
      Object.assign(topup(), { selectedTerms: { ref: "caller" } }),
    ),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

test("own-data getters, string wrappers and malformed scalar text are rejected without getter execution", async () => {
  let getters = 0;
  const e = topup();
  Object.defineProperty(e, "amountMinor", {
    enumerable: true,
    get() {
      getters++;
      return 500;
    },
  });
  const source = createFinancialDisplayedTermsSource(displayPolicy());
  await expect(source.fromEconomic(e)).rejects.toMatchObject({ code: "invalid_request" });
  const request = { organizationId: "org_display", reference: "ref", amountMinor: 500 };
  Object.defineProperty(request, "reference", {
    enumerable: true,
    get() {
      getters++;
      return "ref";
    },
  });
  expect(() =>
    captureFinancialDisplayInput(request, ["organizationId", "reference", "amountMinor"]),
  ).toThrow(FinancialRetainedR1Error);
  const policy = displayPolicy();
  Object.defineProperty(policy, "billingConfig", {
    enumerable: true,
    get() {
      getters++;
      throw Error("never execute");
    },
  });
  expect(() => createFinancialDisplayedTermsSource(policy)).toThrow(FinancialRetainedR1Error);
  expect(getters).toBe(0);
  await expect(
    source.fromEconomic(Object.assign(topup(), { pricingRevision: new String("display-r1") })),
  ).rejects.toMatchObject({ code: "invalid_request" });
  await expect(
    source.fromEconomic(Object.assign(topup(), { pricingRevision: "\ud800" })),
  ).rejects.toMatchObject({ code: "invalid_request" });
});

test("snapshot requests detach before the existing selector awaits and reject unknown request fields", () => {
  const input = { organizationId: "org_display", reference: "before", amountMinor: 500 };
  const copy = captureFinancialDisplayInput(input, ["organizationId", "reference", "amountMinor"]);
  input.reference = "after";
  input.amountMinor = 600;
  expect(copy).toEqual({ organizationId: "org_display", reference: "before", amountMinor: 500 });
  expect(Object.isFrozen(copy)).toBe(true);
  expect(() =>
    captureFinancialDisplayInput({ ...input, terms: "caller" }, [
      "organizationId",
      "reference",
      "amountMinor",
    ]),
  ).toThrow(FinancialRetainedR1Error);
});

test("unknown revision/changed Price or absent configured card disclosure stay unavailable", async () => {
  const source = createFinancialDisplayedTermsSource(displayPolicy());
  await expect(
    source.fromEconomic({ ...topup(), pricingRevision: "past-revision" }),
  ).rejects.toMatchObject({ code: "unavailable" });
  const start = selected("subscription-start");
  if (start.kind !== "subscription-start") throw Error("wrong selection");
  await expect(source.fromEconomic({ ...start, priceAmountMinor: 900 })).rejects.toMatchObject({
    code: "unavailable",
  });
  await expect(
    createFinancialDisplayedTermsSource({ ...displayPolicy(), onDemand: null }).fromEconomic(
      selected("card-setup"),
    ),
  ).rejects.toMatchObject({ code: "unavailable" });
});

test("unsupported unit text cannot inject lines or replace the captured tariff", async () => {
  const policy = displayPolicy(),
    meter = policy.billingConfig.meters.requests;
  if (!meter) throw Error("meter absent");
  Object.assign(meter, { unit: 'request/秒\n"quoted"' });
  expect(() => createFinancialDisplayedTermsSource(policy)).toThrow(FinancialRetainedR1Error);
  const result = await createFinancialDisplayedTermsSource(displayPolicy()).fromEconomic(topup());
  expect(result.displayText).toContain('"requests": 3/2 microUSD per "request"');
  expect(result.displayText).not.toContain("quoted");
});

test("oversize configured terms refuse rather than truncate, and no issuer/prepare port is exposed", async () => {
  const policy = displayPolicy();
  Object.assign(policy.billingConfig, {
    meters: Object.fromEntries(
      Array.from({ length: 400 }, (_, i) => [
        `meter${i}`,
        { unit: "u".repeat(64), rate: { numeratorMicros: "1", denominator: "1" } },
      ]),
    ),
  });
  const source = createFinancialDisplayedTermsSource(policy);
  await expect(source.fromEconomic(topup())).rejects.toMatchObject({ code: "unavailable" });
  expect(Object.keys(source)).toEqual(["fromEconomic"]);
});

test("pending cancellation preserves its internal original while display excludes native and custody identifiers", async () => {
  const e = selected("cancel");
  if (e.kind !== "cancel") throw Error("wrong selection");
  const pending = {
    ...e,
    branch: "pending-plan-change" as const,
    pendingReference: "private_pending_ref",
    scheduleId: "sub_sched_private",
  };
  const result = await createFinancialDisplayedTermsSource(displayPolicy()).fromEconomic(pending);
  expect(result.economic).toEqual(pending);
  expect(result.displayText).toContain("Pending plan change: present");
  for (const secret of [
    e.targetSubscriptionId,
    e.expectedSubscriptionRef,
    pending.pendingReference,
    pending.scheduleId,
  ])
    expect(result.displayText).not.toContain(secret);
});

test("selector realm metadata remains outside the existing R1 economic and display images", async () => {
  const result = await createFinancialDisplayedTermsSource(displayPolicy()).fromEconomic(
    Object.assign(topup(), {
      accountId: "acct_private",
      livemode: false,
      financialRealm: "private-realm",
    }),
  );
  expect(result.economic).toEqual(topup());
  expect(result.displayText).not.toContain("acct_private");
  expect(result.displayText).not.toContain("private-realm");
  const start = await createFinancialDisplayedTermsSource(displayPolicy()).fromEconomic(
    selected("subscription-start"),
  );
  expect(start.displayText).not.toContain("price_small");
});
