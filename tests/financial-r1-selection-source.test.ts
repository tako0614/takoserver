import { expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createCanonicalFinancialR1SelectionSource } from "../src/financial-r1-selection-source.ts";
import { createCanonicalHostedBillingComposition } from "../src/hosted-billing-composition.ts";
import { base64UrlDecode, base64UrlEncode, bytesDigest } from "../src/json.ts";
import type { SharedFinancialAction } from "../src/shared-financial-action.ts";
import { createSharedFinancialActionIdentity } from "../src/shared-financial-action.ts";
import { FinancialRetainedR1Error } from "../src/shared-financial-retained-r1.ts";
import {
  fixture,
  ORG,
  operatorConfiguration,
} from "./helpers/financial-displayed-canonical-fixture.ts";

// Real canonical origin, existing in-memory owning SQL/qualified-realm mechanics and synthetic HTTP only.
// Neither this fixture nor assertData qualifies Root, a source registration or R1.prepare.
async function setup() {
  const f = await fixture();
  try {
    const billingConfig = parseBillingConfig(f.pricing.environment.TAKOSERVER_BILLING_CONFIG);
    if (!billingConfig) throw Error("actual tariff absent");
    let fundingCalls = 0;
    const context = {
      sql: f.sql,
      clock: f.clock,
      async credit() {
        fundingCalls++;
        throw Error("selection cannot fund");
      },
      async creditedFunding() {
        fundingCalls++;
        return new Set<string>();
      },
    };
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
      webhookSecret: "whsec_selection_synthetic_fixture",
      onDemand: configuration,
    });
    if (!composition.paymentActivation) throw Error("actual canonical composition absent");
    const options = { composition, context, billingConfig };
    const source = createCanonicalFinancialR1SelectionSource(options);
    return {
      ...f,
      source,
      options,
      configuration,
      get fundingCalls() {
        return fundingCalls;
      },
    };
  } catch (error) {
    f.db.close();
    throw error;
  }
}
async function action(
  f: Awaited<ReturnType<typeof setup>>,
  kind: SharedFinancialAction["kind"],
): Promise<SharedFinancialAction> {
  const common = { organizationId: ORG, reference: `selection-${kind}` };
  switch (kind) {
    case "topup":
      return { ...common, kind, amountMinor: 500 };
    case "subscription-start":
      await f.options.composition.createPayments(f.options.context).subscriptionCustody.read(ORG);
      return { ...common, kind, planKey: "hosted-10" };
    case "card-setup":
      return { ...common, kind, setupDisclosureRevision: f.configuration.setupDisclosureRevision };
    case "plan-change":
      return { ...common, kind, expectedSubscriptionRef: await f.begin(), planKey: "hosted-50" };
    case "cancel":
      return { ...common, kind, expectedSubscriptionRef: await f.begin(), cancelAtPeriodEnd: true };
  }
}
for (const kind of [
  "topup",
  "subscription-start",
  "card-setup",
  "plan-change",
  "cancel",
] as const) {
  test(`${kind}: existing canonical selection binds the exact closed action identity and display DATA`, async () => {
    const f = await setup();
    try {
      const input = await action(f, kind),
        expected = await createSharedFinancialActionIdentity(input),
        calls = f.calls.length;
      const selected = await f.source.selectNewActionData(input);
      expect(selected.actionIdentity).toEqual(expected);
      expect(selected.displayed.economic.kind).toBe(kind);
      expect(selected.selectedAt).toBe(f.clock().getTime());
      const raw = base64UrlDecode(selected.displayed.selectedTerms.bodyUtf8Base64url);
      if (!raw) throw Error("exact display original absent");
      expect(raw).toEqual(new TextEncoder().encode(selected.displayed.displayText));
      expect(await bytesDigest(raw)).toBe(selected.displayed.selectedTerms.digest);
      expect(() => f.source.assertData(selected)).not.toThrow();
      expect(Object.isFrozen(selected)).toBe(true);
      expect(Object.isFrozen(selected.actionIdentity)).toBe(true);
      expect(f.fundingCalls).toBe(0);
      expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
      expect(Object.keys(f.source)).toEqual(["selectNewActionData", "assertData"]);
    } finally {
      f.db.close();
    }
  });
}

test("a same-shape composition DTO cannot become the real canonical source", async () => {
  const f = await setup();
  try {
    const calls = f.calls.length;
    expect(() =>
      createCanonicalFinancialR1SelectionSource({
        ...f.options,
        composition: { ...f.options.composition },
      }),
    ).toThrow(FinancialRetainedR1Error);
    expect(f.calls.length).toBe(calls);
    expect(f.fundingCalls).toBe(0);
  } finally {
    f.db.close();
  }
});

test("live DATA origin rejects copied/cross-factory images without claiming persisted or permission authority", async () => {
  const f = await setup();
  try {
    const selected = await f.source.selectNewActionData(await action(f, "topup"));
    expect(() => f.source.assertData({ ...selected })).toThrow(FinancialRetainedR1Error);
    const other = createCanonicalFinancialR1SelectionSource(f.options);
    expect(() => other.assertData(selected)).toThrow(FinancialRetainedR1Error);
    expect(() => f.source.assertData(selected)).not.toThrow();
    expect("prepare" in f.source).toBe(false);
    expect("register" in f.source).toBe(false);
    expect("readRetainedActionConsentR1" in f.source).toBe(false);
  } finally {
    f.db.close();
  }
});

test("action input is captured before the identity digest await and never reselected from caller aliases", async () => {
  const f = await setup();
  try {
    const input = {
      kind: "topup" as const,
      organizationId: ORG,
      reference: "selection-before",
      amountMinor: 500,
    };
    const expected = await createSharedFinancialActionIdentity(input);
    const pending = f.source.selectNewActionData(input);
    Object.assign(input, { organizationId: "org_changed", reference: "changed", amountMinor: 900 });
    const selected = await pending;
    expect(selected.actionIdentity).toEqual(expected);
    expect(selected.displayed.economic).toMatchObject({ kind: "topup", amountMinor: 500 });
    expect(selected.displayed.displayText).toContain("USD 5.00");
    expect(selected.displayed.displayText).not.toContain("USD 9.00");
    expect(f.fundingCalls).toBe(0);
  } finally {
    f.db.close();
  }
});

test("caller terms/economic DTO fields are rejected before the actual source is invoked", async () => {
  const f = await setup();
  try {
    const input = await action(f, "card-setup"),
      calls = f.calls.length;
    await expect(
      f.source.selectNewActionData(Object.assign(input, { selectedTerms: { ref: "caller" } })),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(f.calls.length).toBe(calls);
    expect(f.fundingCalls).toBe(0);
  } finally {
    f.db.close();
  }
});

test("a stale card disclosure request cannot bind the current canonical terms to another action", async () => {
  const f = await setup();
  try {
    const input = {
        kind: "card-setup" as const,
        organizationId: ORG,
        reference: "stale-card",
        setupDisclosureRevision: "old-disclosure",
      },
      calls = f.calls.length;
    await expect(f.source.selectNewActionData(input)).rejects.toMatchObject({ code: "conflict" });
    expect(f.calls.length).toBe(calls);
    expect(f.fundingCalls).toBe(0);
  } finally {
    f.db.close();
  }
});

test("an unusable actual clock refuses DATA rather than inventing a selectedAt default", async () => {
  const f = await setup();
  try {
    const input = await action(f, "card-setup");
    f.now("not-a-date");
    await expect(f.source.selectNewActionData(input)).rejects.toMatchObject({
      code: "unavailable",
    });
    expect(f.fundingCalls).toBe(0);
  } finally {
    f.db.close();
  }
});

for (const [label, publicMethod, kind] of [
  ["createPayments", "createPayments", "subscription-start"],
  ["displayTopup", "selectTopUpDisplayedTermsR1", "topup"],
  ["displayCard", "selectCardSetupDisplayedTermsR1", "card-setup"],
  ["rawTopup", "selectTopUpEconomicR1", "topup"],
  ["rawCard", "selectCardSetupEconomicR1", "card-setup"],
] as const) {
  test(`${label}: own call value/getter poisoning is never invoked before a fresh source captures the original DATA`, async () => {
    for (const mode of ["value", "getter"] as const) {
      const f = await setup();
      try {
        const input = await action(f, kind);
        const expected = await f.source.selectNewActionData(input);
        const composition = f.options.composition;
        const target = composition[publicMethod];
        expect(Object.isFrozen(composition)).toBe(true);
        expect(Object.isExtensible(target)).toBe(true);
        const forgedText = "Caller-forged but internally consistent terms";
        const raw = new TextEncoder().encode(forgedText),
          digest = await bytesDigest(raw);
        const forgedDisplay = {
          ...expected.displayed,
          displayText: forgedText,
          selectedTerms: {
            ...expected.displayed.selectedTerms,
            ref: `terms:${digest.slice(7)}`,
            digest,
            bodyUtf8Base64url: base64UrlEncode(raw),
            bodyByteLength: raw.byteLength,
          },
        };
        const actualAssembly = composition.createPayments(f.options.context);
        const forgedResult: unknown =
          publicMethod === "createPayments"
            ? {
                ...actualAssembly,
                async selectSubscriptionStartDisplayedTermsR1() {
                  return forgedDisplay;
                },
              }
            : publicMethod === "selectTopUpEconomicR1" ||
                publicMethod === "selectCardSetupEconomicR1"
              ? expected.displayed.economic
              : forgedDisplay;
        let invoked = 0,
          getters = 0;
        const poisonedCall = async () => {
          invoked++;
          return forgedResult;
        };
        const previous = Object.getOwnPropertyDescriptor(target, "call");
        const calls = f.calls.length;
        try {
          Object.defineProperty(
            target,
            "call",
            mode === "value"
              ? { configurable: true, value: poisonedCall }
              : {
                  configurable: true,
                  get() {
                    getters++;
                    return poisonedCall;
                  },
                },
          );
          const fresh = createCanonicalFinancialR1SelectionSource(f.options);
          const selected = await fresh.selectNewActionData(input);
          expect(selected).toEqual(expected);
          expect(selected.displayed.displayText).not.toBe(forgedText);
          expect(invoked).toBe(0);
          expect(getters).toBe(0);
          expect(() => fresh.assertData(selected)).not.toThrow();
          expect(f.fundingCalls).toBe(0);
          expect(f.calls.slice(calls).filter((call) => call.method !== "GET")).toEqual([]);
        } finally {
          if (previous) Object.defineProperty(target, "call", previous);
          else expect(Reflect.deleteProperty(target, "call")).toBe(true);
        }
      } finally {
        f.db.close();
      }
    }
  });
}

test("funding function own bind value/getter is not read or executed while capturing a fresh source", async () => {
  for (const mode of ["value", "getter"] as const) {
    const f = await setup();
    try {
      const input = await action(f, "topup"),
        expected = await f.source.selectNewActionData(input);
      const targets = [f.options.context.credit, f.options.context.creditedFunding];
      const previous = targets.map((target) => Object.getOwnPropertyDescriptor(target, "bind"));
      let invoked = 0,
        getters = 0;
      const poisonedBind = () => {
        invoked++;
        return async () => {
          throw Error("poisoned funding callback");
        };
      };
      try {
        for (const target of targets)
          Object.defineProperty(
            target,
            "bind",
            mode === "value"
              ? { configurable: true, value: poisonedBind }
              : {
                  configurable: true,
                  get() {
                    getters++;
                    return poisonedBind;
                  },
                },
          );
        const fresh = createCanonicalFinancialR1SelectionSource(f.options);
        const selected = await fresh.selectNewActionData(input);
        expect(selected).toEqual(expected);
        expect(invoked).toBe(0);
        expect(getters).toBe(0);
        expect(f.fundingCalls).toBe(0);
      } finally {
        for (const [index, target] of targets.entries()) {
          const descriptor = previous[index];
          if (descriptor) Object.defineProperty(target, "bind", descriptor);
          else expect(Reflect.deleteProperty(target, "bind")).toBe(true);
        }
      }
    } finally {
      f.db.close();
    }
  }
});
