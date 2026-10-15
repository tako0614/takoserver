import { describe, expect, test } from "bun:test";
import {
  calculateOrgOnDemandFunding,
  OrgOnDemandTermsError,
  parseOrgOnDemandTerms,
  resolveOrgOnDemandCreditExpiry,
  validateOrgOnDemandCashCap,
} from "../src/org-on-demand-terms.ts";

const NOW = "2026-10-15T12:34:56.789Z";

// Test-only operator values, not a default policy or an activated configuration.
function suppliedTerms() {
  return {
    termsRevision: "operator-terms-7",
    consentRevision: "consent-text-3",
    currency: "USD",
    validity: {
      validFrom: "2026-10-01T00:00:00.000Z",
      validUntil: "2026-11-01T00:00:00.000Z",
    },
    replenishment: {
      trigger: "eligible-credit-deficit",
      rule: "ceil-deficit-to-quantum-with-minimum",
      fundingQuantumMinor: 25,
      minimumChargeMinor: 50,
      maximumChargeMinor: 1000,
    },
    cashCapBounds: { minimumMinor: 1, maximumMinor: 100_000 },
    purchaseCreditExpiry: { kind: "fixed-duration", seconds: 86400 },
  };
}

function fails(action: () => unknown, code: OrgOnDemandTermsError["code"]) {
  let caught: unknown;
  try {
    action();
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(OrgOnDemandTermsError);
  expect(caught).toMatchObject({ code });
}

function funding(deficitMicros: string) {
  return calculateOrgOnDemandFunding(parseOrgOnDemandTerms(suppliedTerms()), {
    deficitMicros,
    evaluatedAt: NOW,
  });
}

describe("explicit operator on-demand terms", () => {
  test("copies and deeply freezes every policy object without selecting a cash cap", () => {
    const supplied = suppliedTerms();
    const terms = parseOrgOnDemandTerms(supplied);
    expect(terms as unknown).toEqual(supplied);
    for (const value of [
      terms,
      terms.validity,
      terms.replenishment,
      terms.cashCapBounds,
      terms.purchaseCreditExpiry,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    supplied.termsRevision = "replaced";
    supplied.validity.validUntil = "2026-10-02T00:00:00.000Z";
    supplied.replenishment.fundingQuantumMinor = 100;
    supplied.cashCapBounds.maximumMinor = 1;
    supplied.purchaseCreditExpiry.seconds = 1;
    expect(terms as unknown).toEqual(suppliedTerms());
    expect(Object.hasOwn(terms, "cashCapMinor")).toBe(false);
    expect(
      calculateOrgOnDemandFunding(terms, { deficitMicros: "500001", evaluatedAt: NOW }),
    ).toMatchObject({ amountMinor: 75, creditMicros: 750_000 });
    expect(resolveOrgOnDemandCreditExpiry(terms, NOW).creditExpiresAt).toBe(
      "2026-10-16T12:34:56.789Z",
    );
  });

  test("every top-level value is required, with unknown fields and defaults refused", () => {
    for (const key of Object.keys(suppliedTerms())) {
      const value: Record<string, unknown> = suppliedTerms();
      delete value[key];
      fails(() => parseOrgOnDemandTerms(value), "invalid_terms");
    }
    for (const field of [
      { cashCapMinor: 100 },
      { active: true },
      { postpaid: true },
      { defaultQuantum: 25 },
    ])
      fails(() => parseOrgOnDemandTerms({ ...suppliedTerms(), ...field }), "invalid_terms");
    for (const value of [null, undefined, [], "{}", new Date(), Object.create(suppliedTerms())])
      fails(() => parseOrgOnDemandTerms(value), "invalid_terms");
  });

  test("nested missing or unknown keys and accessors cannot supply an implicit policy", () => {
    for (const parent of ["validity", "replenishment", "cashCapBounds", "purchaseCreditExpiry"]) {
      const supplied = suppliedTerms() as unknown as Record<string, Record<string, unknown>>;
      const object = supplied[parent];
      if (!object) throw new Error("Missing fixture object");
      for (const key of Object.keys(object)) {
        const missing = { ...object };
        delete missing[key];
        fails(
          () => parseOrgOnDemandTerms({ ...suppliedTerms(), [parent]: missing }),
          "invalid_terms",
        );
      }
      fails(
        () => parseOrgOnDemandTerms({ ...suppliedTerms(), [parent]: { ...object, unknown: 1 } }),
        "invalid_terms",
      );
    }
    let reads = 0;
    const getter = Object.defineProperty(suppliedTerms(), "termsRevision", {
      get() {
        reads++;
        return "getter-terms";
      },
    });
    fails(() => parseOrgOnDemandTerms(getter), "invalid_terms");
    expect(reads).toBe(0);
    const symbol = { ...suppliedTerms(), [Symbol("extension")]: 1 };
    fails(() => parseOrgOnDemandTerms(symbol), "invalid_terms");
  });

  test("only the explicit supported trigger and minimum-floor rule are accepted", () => {
    for (const field of [
      { rule: undefined },
      { rule: "ceil-deficit-to-quantum" },
      { rule: "repeat-until-admitted" },
      { trigger: "low-balance" },
      { trigger: "always" },
    ])
      fails(
        () =>
          parseOrgOnDemandTerms({
            ...suppliedTerms(),
            replenishment: { ...suppliedTerms().replenishment, ...field },
          }),
        "invalid_terms",
      );
  });

  test("USD and explicit bounded revision identities are required", () => {
    for (const field of ["termsRevision", "consentRevision"])
      for (const value of ["", " needs-trimming", "rev\n", "a".repeat(129), 1, null])
        fails(() => parseOrgOnDemandTerms({ ...suppliedTerms(), [field]: value }), "invalid_terms");
    for (const currency of ["usd", "JPY", "", undefined])
      fails(() => parseOrgOnDemandTerms({ ...suppliedTerms(), currency }), "invalid_terms");
  });

  test("positive safe integer cents must also have safe face-value micros", () => {
    for (const field of ["fundingQuantumMinor", "minimumChargeMinor", "maximumChargeMinor"])
      for (const value of [
        0,
        -1,
        0.5,
        NaN,
        Infinity,
        "25",
        Number.MAX_SAFE_INTEGER,
        900_719_925_475,
      ])
        fails(
          () =>
            parseOrgOnDemandTerms({
              ...suppliedTerms(),
              replenishment: { ...suppliedTerms().replenishment, [field]: value },
            }),
          "invalid_terms",
        );
    for (const field of ["minimumMinor", "maximumMinor"])
      for (const value of [0, -1, 0.5, NaN, Infinity, "1", 900_719_925_475])
        fails(
          () =>
            parseOrgOnDemandTerms({
              ...suppliedTerms(),
              cashCapBounds: { ...suppliedTerms().cashCapBounds, [field]: value },
            }),
          "invalid_terms",
        );
  });

  test("charge bounds must be ordered whole quanta, independently of cap bounds", () => {
    for (const field of [
      { minimumChargeMinor: 75, maximumChargeMinor: 50 },
      { minimumChargeMinor: 51 },
      { maximumChargeMinor: 999 },
      { fundingQuantumMinor: 100 },
    ])
      fails(
        () =>
          parseOrgOnDemandTerms({
            ...suppliedTerms(),
            replenishment: { ...suppliedTerms().replenishment, ...field },
          }),
        "invalid_terms",
      );
    fails(
      () =>
        parseOrgOnDemandTerms({
          ...suppliedTerms(),
          cashCapBounds: { minimumMinor: 101, maximumMinor: 100 },
        }),
      "invalid_terms",
    );
    // A chosen cash cap need not be a whole quantum; reservation may refuse a charge.
    expect(validateOrgOnDemandCashCap(parseOrgOnDemandTerms(suppliedTerms()), 51)).toBe(51);
  });

  test("validity requires canonical actual instants and an ordered half-open interval", () => {
    for (const value of [
      "2026-10-01",
      "2026-10-01T00:00:00Z",
      "2026-10-01T00:00:00.000+00:00",
      "2026-02-30T00:00:00.000Z",
      "2026-10-01T24:00:00.000Z",
      "9999-12-31T23:59:59.001Z",
      "+010000-01-01T00:00:00.000Z",
      null,
    ])
      for (const key of ["validFrom", "validUntil"])
        fails(
          () =>
            parseOrgOnDemandTerms({
              ...suppliedTerms(),
              validity: { ...suppliedTerms().validity, [key]: value },
            }),
          "invalid_terms",
        );
    for (const validUntil of ["2026-10-01T00:00:00.000Z", "2026-09-30T00:00:00.000Z"])
      fails(
        () =>
          parseOrgOnDemandTerms({
            ...suppliedTerms(),
            validity: { ...suppliedTerms().validity, validUntil },
          }),
        "invalid_terms",
      );
  });

  test("the purchase expiry policy is exact and fully supplied", () => {
    for (const purchaseCreditExpiry of [
      null,
      {},
      { kind: "fixed-duration" },
      { kind: "none", seconds: 0 },
      { kind: "default" },
      { kind: "fixed-date", at: NOW },
      ...[0, -1, 0.5, NaN, Infinity, "1", 253402300800].map((seconds) => ({
        kind: "fixed-duration",
        seconds,
      })),
    ])
      fails(
        () => parseOrgOnDemandTerms({ ...suppliedTerms(), purchaseCreditExpiry }),
        "invalid_terms",
      );
    const none = parseOrgOnDemandTerms({
      ...suppliedTerms(),
      purchaseCreditExpiry: { kind: "none" },
    });
    expect(none.purchaseCreditExpiry).toEqual({ kind: "none" });
    expect(Object.isFrozen(none.purchaseCreditExpiry)).toBe(true);
  });
});

describe("single on-demand funding arithmetic", () => {
  test("zero deficit does not apply a minimum or create a positive charge", () => {
    expect(funding("0")).toMatchObject({
      kind: "none",
      deficitMicros: "0",
      amountMinor: 0,
      creditMicros: 0,
    });
  });

  test("one micro deficit applies the explicitly selected minimum floor", () => {
    expect(funding("1")).toMatchObject({
      kind: "single-charge",
      amountMinor: 50,
      creditMicros: 500_000,
    });
  });

  test("cents and quantum boundaries round upward exactly, preserving face value", () => {
    for (const [deficitMicros, amountMinor] of [
      ["499999", 50],
      ["500000", 50],
      ["500001", 75],
      ["509999", 75],
      ["510000", 75],
      ["750000", 75],
      ["750001", 100],
      ["10000000", 1000],
    ] as const)
      expect(funding(deficitMicros)).toMatchObject({
        kind: "single-charge",
        deficitMicros,
        amountMinor,
        creditMicros: amountMinor * 10_000,
      });
  });

  test("an amount above the maximum is refused without truncation or multiple charges", () => {
    for (const deficitMicros of ["10000001", "20000000", String(Number.MAX_SAFE_INTEGER)])
      fails(() => funding(deficitMicros), "maximum_charge_exceeded");
  });

  test("only canonical nonnegative integer safe micros are accepted", () => {
    for (const deficitMicros of [
      "-1",
      "-0",
      "1.0",
      "0.5",
      "01",
      "+1",
      "1e3",
      " 1",
      "1\n",
      "",
      "NaN",
      "9007199254740992",
    ])
      fails(() => funding(deficitMicros), "invalid_argument");
    const terms = parseOrgOnDemandTerms(suppliedTerms());
    for (const deficitMicros of [1, -1, 0.5, NaN, Infinity, null, undefined])
      fails(
        () => calculateOrgOnDemandFunding(terms, { deficitMicros, evaluatedAt: NOW } as never),
        "invalid_argument",
      );
  });

  test("the largest representable cash face value works, while its next cent cannot", () => {
    const maximumMinor = 900_719_925_474;
    const terms = parseOrgOnDemandTerms({
      ...suppliedTerms(),
      replenishment: {
        ...suppliedTerms().replenishment,
        fundingQuantumMinor: 1,
        minimumChargeMinor: 1,
        maximumChargeMinor: maximumMinor,
      },
      cashCapBounds: { minimumMinor: 1, maximumMinor },
    });
    expect(
      calculateOrgOnDemandFunding(terms, { deficitMicros: "9007199254740000", evaluatedAt: NOW }),
    ).toMatchObject({ amountMinor: maximumMinor, creditMicros: 9_007_199_254_740_000 });
    fails(
      () =>
        calculateOrgOnDemandFunding(terms, {
          deficitMicros: String(Number.MAX_SAFE_INTEGER),
          evaluatedAt: NOW,
        }),
      "maximum_charge_exceeded",
    );
  });

  test("the explicit evaluation instant must be within the terms half-open interval", () => {
    const terms = parseOrgOnDemandTerms(suppliedTerms());
    expect(
      calculateOrgOnDemandFunding(terms, {
        deficitMicros: "1",
        evaluatedAt: terms.validity.validFrom,
      }).amountMinor,
    ).toBe(50);
    for (const evaluatedAt of ["2026-09-30T23:59:59.999Z", terms.validity.validUntil])
      fails(
        () => calculateOrgOnDemandFunding(terms, { deficitMicros: "0", evaluatedAt }),
        "terms_not_valid",
      );
    for (const input of [
      { deficitMicros: "1" },
      { deficitMicros: "1", evaluatedAt: "bad" },
      { deficitMicros: "1", evaluatedAt: NOW, cashCapMinor: 100 },
    ])
      fails(() => calculateOrgOnDemandFunding(terms, input as never), "invalid_argument");
  });

  test("calculation discloses its original frozen terms and cannot retain mutable caller terms", () => {
    const input = suppliedTerms();
    const calculated = calculateOrgOnDemandFunding(input as never, {
      deficitMicros: "500001",
      evaluatedAt: NOW,
    });
    expect(calculated.terms.replenishment as unknown).toEqual(suppliedTerms().replenishment);
    expect(Object.isFrozen(calculated)).toBe(true);
    expect(Object.isFrozen(calculated.terms.replenishment)).toBe(true);
    input.replenishment.rule = "changed";
    input.purchaseCreditExpiry.seconds = 1;
    expect(calculated.terms as unknown).toEqual(suppliedTerms());
    fails(
      () => calculateOrgOnDemandFunding(input as never, { deficitMicros: "1", evaluatedAt: NOW }),
      "invalid_terms",
    );
  });

  test("a monthly cash cap must be explicitly supplied and remains separate from funding", () => {
    const terms = parseOrgOnDemandTerms(suppliedTerms());
    expect(validateOrgOnDemandCashCap(terms, 1)).toBe(1);
    expect(validateOrgOnDemandCashCap(terms, 100_000)).toBe(100_000);
    for (const cap of [0, -1, 0.5, NaN, Infinity, 100_001, 900_719_925_475, undefined, "100"])
      fails(() => validateOrgOnDemandCashCap(terms, cap as never), "invalid_argument");
    // Validation of a low cap is not approval of a charge against that cap.
    expect(funding("1").amountMinor).toBe(50);
  });
});

describe("first verified funding purchase expiry", () => {
  test("uses the explicitly chosen first funding instant, including milliseconds", () => {
    const terms = parseOrgOnDemandTerms(suppliedTerms());
    const resolved = resolveOrgOnDemandCreditExpiry(terms, NOW);
    expect(resolved).toEqual({
      firstVerifiedFundingAt: NOW,
      creditExpiresAt: "2026-10-16T12:34:56.789Z",
    });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolveOrgOnDemandCreditExpiry(terms, NOW)).toEqual(resolved);
  });

  test("late verified success keeps the original policy after its admission validity ends", () => {
    const terms = parseOrgOnDemandTerms(suppliedTerms());
    expect(resolveOrgOnDemandCreditExpiry(terms, "2026-11-15T12:34:56.789Z").creditExpiresAt).toBe(
      "2026-11-16T12:34:56.789Z",
    );
  });

  test("none retains no expiry but still requires a canonical explicit first funding instant", () => {
    const terms = parseOrgOnDemandTerms({
      ...suppliedTerms(),
      purchaseCreditExpiry: { kind: "none" },
    });
    expect(resolveOrgOnDemandCreditExpiry(terms, NOW)).toEqual({
      firstVerifiedFundingAt: NOW,
      creditExpiresAt: null,
    });
    for (const at of [
      undefined,
      "2026-10-15",
      "2026-02-30T00:00:00.000Z",
      "9999-12-31T23:59:59.001Z",
    ])
      fails(() => resolveOrgOnDemandCreditExpiry(terms, at as never), "invalid_argument");
  });

  test("accepts the final bounded instant exactly and refuses overflow rather than null", () => {
    const terms = parseOrgOnDemandTerms({
      ...suppliedTerms(),
      purchaseCreditExpiry: { kind: "fixed-duration", seconds: 1 },
    });
    expect(resolveOrgOnDemandCreditExpiry(terms, "9999-12-31T23:59:58.000Z").creditExpiresAt).toBe(
      "9999-12-31T23:59:59.000Z",
    );
    for (const at of ["9999-12-31T23:59:58.001Z", "9999-12-31T23:59:59.000Z"])
      fails(() => resolveOrgOnDemandCreditExpiry(terms, at), "expiry_overflow");
    const long = parseOrgOnDemandTerms({
      ...suppliedTerms(),
      purchaseCreditExpiry: { kind: "fixed-duration", seconds: 253402300799 },
    });
    expect(resolveOrgOnDemandCreditExpiry(long, "1970-01-01T00:00:00.000Z").creditExpiresAt).toBe(
      "9999-12-31T23:59:59.000Z",
    );
    fails(
      () => resolveOrgOnDemandCreditExpiry(long, "1970-01-01T00:00:00.001Z"),
      "expiry_overflow",
    );
  });
});
