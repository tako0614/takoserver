import { describe, expect, test } from "bun:test";
import {
  type BillingConfig,
  BillingConfigError,
  ceilHoldMicros,
  computeMeterAmountMicros,
  parseBillingConfig,
  selectCurrentBillingConfig,
} from "../src/billing-config.ts";
import { invoiceCents, minorToMicros, parseUnsignedMicros } from "../src/money.ts";

const validConfig = {
  schemaVersion: 1,
  revision: "2026-10-13.1",
  effectiveAt: "2026-10-13T00:00:00.000Z",
  currency: "USD",
  holdTtlSeconds: 86_400,
  freeIncludedMinor: 0,
  purchaseCreditExpiry: { kind: "none" },
  plans: {
    starter: { includedMinor: 0, stripePriceId: "price_plan001" },
  },
  meters: {
    "takosumi.storage.byte-hours": {
      unit: "byte-hour",
      rate: { numeratorMicros: "1", denominator: "1000" },
    },
  },
} satisfies Record<string, unknown>;

function parse(overrides: Record<string, unknown> = {}): BillingConfig {
  const raw = JSON.stringify({ ...validConfig, ...overrides });
  const config = parseBillingConfig(raw);
  if (!config) throw new Error("expected billing config");
  return config;
}

describe("billing config", () => {
  test("missing and blank input keep billing disabled", () => {
    expect(parseBillingConfig(undefined)).toBeUndefined();
    expect(parseBillingConfig("  \n")).toBeUndefined();
  });

  test("parses an exact USD tariff and retains its revision", () => {
    const config = parse();
    expect(config.revision).toBe("2026-10-13.1");
    expect(config.currency).toBe("USD");
    expect(config.holdTtlSeconds).toBe(86_400);
    expect(config.meters["takosumi.storage.byte-hours"]?.rate).toEqual({
      numeratorMicros: "1",
      denominator: "1000",
    });
  });

  test("defaults an omitted hold TTL to 24 hours", () => {
    const { holdTtlSeconds: _ttl, ...withoutTtl } = validConfig;
    expect(parseBillingConfig(JSON.stringify(withoutTtl))?.holdTtlSeconds).toBe(86_400);
    expect(() => parse({ holdTtlSeconds: null })).toThrow(BillingConfigError);
  });

  test("selects only the newest effective revision", () => {
    const earlier = parse();
    const later = parse({ revision: "2026-10-14.1", effectiveAt: "2026-10-14T00:00:00.000Z" });
    expect(selectCurrentBillingConfig([later, earlier], "2026-10-13T23:59:59.999Z")).toBe(earlier);
    expect(selectCurrentBillingConfig([earlier, later], "2026-10-14T00:00:00.000Z")).toBe(later);
    expect(selectCurrentBillingConfig([earlier], "2026-10-12T00:00:00.000Z")).toBeUndefined();
  });

  test("loads retained revisions, selects them by effective time, and rejects nested history", () => {
    const historical = {
      ...validConfig,
      revision: "2026-10-01.1",
      effectiveAt: "2026-10-01T00:00:00.000Z",
      freeIncludedMinor: 25,
    };
    const current = parse({ history: [historical] });
    expect(current.history).toHaveLength(1);
    expect(selectCurrentBillingConfig([current], "2026-10-12T23:59:59.999Z")?.revision).toBe(
      "2026-10-01.1",
    );
    expect(selectCurrentBillingConfig([current], current.effectiveAt)?.revision).toBe(
      current.revision,
    );
    expect(() => parse({ history: [{ ...historical, history: [] }] })).toThrow(BillingConfigError);
    expect(() => parse({ history: [{ ...historical, revision: validConfig.revision }] })).toThrow(
      BillingConfigError,
    );
    expect(() =>
      parse({ history: [{ ...historical, effectiveAt: validConfig.effectiveAt }] }),
    ).toThrow(BillingConfigError);
  });

  test("rejects duplicate JSON object members", () => {
    expect(() =>
      parseBillingConfig(
        '{"schemaVersion":1,"revision":"a","effectiveAt":"2026-10-13T00:00:00.000Z","currency":"USD","currency":"USD"}',
      ),
    ).toThrow(BillingConfigError);
  });

  test("rejects invalid TTL, currency, and noncanonical or impossible dates", () => {
    for (const holdTtlSeconds of [59, 604_801, 60.5, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => parse({ holdTtlSeconds })).toThrow(BillingConfigError);
    }
    expect(() => parse({ currency: "JPY" })).toThrow(BillingConfigError);
    expect(() => parse({ effectiveAt: "2026-02-30T00:00:00.000Z" })).toThrow(BillingConfigError);
    expect(() => parse({ effectiveAt: "2026-10-13T00:00:00Z" })).toThrow(BillingConfigError);
  });

  test("rejects duplicate Stripe price IDs and unknown fields", () => {
    expect(() =>
      parse({
        meters: {
          usage: {
            unit: "call",
            rate: { numeratorMicros: "1", denominator: "1" },
            stripePriceId: "price_plan001",
          },
        },
      }),
    ).toThrow(BillingConfigError);
    expect(() => parse({ unreviewedChargeMinor: 100 })).toThrow(BillingConfigError);
  });

  test("requires explicit entitlements and valid exact rational rates", () => {
    const { freeIncludedMinor: _free, ...withoutFree } = validConfig;
    expect(() => parseBillingConfig(JSON.stringify(withoutFree))).toThrow(BillingConfigError);
    expect(() =>
      parse({
        meters: {
          usage: { unit: "call", rate: { numeratorMicros: "01", denominator: "2" } },
        },
      }),
    ).toThrow(BillingConfigError);
    expect(() =>
      parse({
        meters: {
          usage: { unit: "call", rate: { numeratorMicros: "1", denominator: "0" } },
        },
      }),
    ).toThrow(BillingConfigError);
  });
});

describe("integer billing arithmetic", () => {
  test("converts verified cents exactly and ceilings the whole invoice once", () => {
    expect(minorToMicros(1)).toBe(10_000);
    expect(parseUnsignedMicros("1")).toBe(1);
    expect(invoiceCents("0")).toBe(0);
    expect(invoiceCents("1")).toBe(1);
    expect(invoiceCents("4999")).toBe(1);
    expect(invoiceCents("5000")).toBe(1);
    expect(invoiceCents("10000")).toBe(1);
    expect(invoiceCents("10001")).toBe(2);
    expect(invoiceCents("25000")).toBe(3);
    expect(invoiceCents(String(5000 + 5000))).toBe(1);
  });

  test("applies headroom once before ceiling the final hold", () => {
    expect(ceilHoldMicros("0", 10_000)).toBe(0);
    expect(ceilHoldMicros("1", 1)).toBe(2);
    expect(ceilHoldMicros("5000", 10_000)).toBe(10_000);
    expect(ceilHoldMicros("10000", 5_000)).toBe(15_000);
    expect(ceilHoldMicros("10001", 0)).toBe(10_001);
    expect(() => ceilHoldMicros("10000", -1)).toThrow(BillingConfigError);
  });

  test("quantizes an aggregate rational amount upward once to USD micros", () => {
    const rate = { numeratorMicros: "1", denominator: "2" };
    expect(computeMeterAmountMicros(0n, rate)).toBe(0);
    expect(computeMeterAmountMicros(1n, rate)).toBe(1);
    expect(computeMeterAmountMicros(2n, rate)).toBe(1);
    expect(computeMeterAmountMicros(3n, rate)).toBe(2);
    expect(computeMeterAmountMicros(10_001n, rate)).toBe(5_001);
    expect(computeMeterAmountMicros(1n, { numeratorMicros: "10000", denominator: "1" }, 2n)).toBe(
      5_000,
    );
    expect(() => computeMeterAmountMicros(1n, rate, 0n)).toThrow(BillingConfigError);
  });

  test("rejects noncanonical amounts, negatives, and unsafe integer results", () => {
    expect(() => parseUnsignedMicros("01")).toThrow();
    expect(() => parseUnsignedMicros("9007199254740992")).toThrow();
    expect(() => minorToMicros(900_719_925_475)).toThrow();
    expect(() => minorToMicros(1.5)).toThrow();
    expect(() => ceilHoldMicros("-1", 0)).toThrow(BillingConfigError);
    expect(() => ceilHoldMicros("999999999999999999999999999999", 0)).toThrow(BillingConfigError);
    expect(() => computeMeterAmountMicros(-1n, { numeratorMicros: "1", denominator: "1" })).toThrow(
      BillingConfigError,
    );
    expect(() =>
      computeMeterAmountMicros(9_007_199_254_740_992n, {
        numeratorMicros: "10000",
        denominator: "1",
      }),
    ).toThrow(BillingConfigError);
  });
});
