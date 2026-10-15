import { expect, test } from "bun:test";
import { canonicalDigest } from "../src/json.ts";
import {
  createSharedFinancialActionIdentity,
  parseSharedFinancialAction,
  SHARED_FINANCIAL_ACTION_VERSION,
  type SharedFinancialAction,
} from "../src/shared-financial-action.ts";

const TARGET = `sra_${"a".repeat(64)}`;
const OTHER_TARGET = `sra_${"b".repeat(64)}`;
const COMMON = { organizationId: "org_action", reference: "original" };
const CASES = [
  {
    action: { ...COMMON, kind: "topup", amountMinor: 1000 },
    fingerprint: "sha256:79f703a5cbfa34d01e2eb027b5a1053a5ae8952514104f9ff770fa0ff9f926ae",
  },
  {
    action: { ...COMMON, kind: "subscription-start", planKey: "starter" },
    fingerprint: "sha256:9c731f5d3d9debeda96444b17800bd32f825973a130fd8210e361602e4a93cdb",
  },
  {
    action: { ...COMMON, kind: "card-setup", setupDisclosureRevision: "setup-v1" },
    fingerprint: "sha256:ffc5ef903f2ef0304fc8690004990ede85b2bae026354781846594512937cd46",
  },
  {
    action: { ...COMMON, kind: "plan-change", planKey: "team", expectedSubscriptionRef: TARGET },
    fingerprint: "sha256:192317a8de8f7099896f0c4caaaa86367af5920df58d2cab3d88ba80e3cd7ae5",
  },
  {
    action: { ...COMMON, kind: "cancel", cancelAtPeriodEnd: true, expectedSubscriptionRef: TARGET },
    fingerprint: "sha256:54d3527ef5f877540d2fd757fc0b91aaf0c365f906b935ce4b7e0f639269f436",
  },
] as const satisfies readonly { action: SharedFinancialAction; fingerprint: string }[];

test("topup identity pins the local versioned canonical recipe without processor terms", async () => {
  const request = {
    kind: "topup",
    organizationId: "org_action",
    reference: "original",
    amountMinor: 1000,
  } satisfies SharedFinancialAction;
  const identity = await createSharedFinancialActionIdentity(request);
  expect(SHARED_FINANCIAL_ACTION_VERSION).toBe("takoserver-shared-financial-action-v1");
  expect(identity).toEqual({
    version: "takoserver-shared-financial-action-v1",
    action: request,
    requestFingerprint: await canonicalDigest(["takoserver-shared-financial-action-v1", request]),
  });
  expect(parseSharedFinancialAction(request)).not.toBe(request);
});

for (const { action, fingerprint } of CASES) {
  test(`${action.kind} has one closed immutable shape and a pinned fingerprint`, async () => {
    const parsed = parseSharedFinancialAction(action);
    expect(parsed).toEqual(action);
    expect(parsed).not.toBe(action);
    expect(Object.isFrozen(parsed)).toBe(true);
    const identity = await createSharedFinancialActionIdentity(action);
    expect(identity.requestFingerprint).toBe(fingerprint);
    expect(identity.action).toEqual(action);
    expect(Object.isFrozen(identity)).toBe(true);
    expect(Object.isFrozen(identity.action)).toBe(true);
    expect(Reflect.set(identity, "requestFingerprint", "sha256:changed")).toBe(false);
    expect(Reflect.set(identity.action, "reference", "rebound")).toBe(false);
    expect(Reflect.set(identity.action, "source", "untrusted")).toBe(false);
    for (const field of Object.keys(action)) {
      const missing: Record<string, unknown> = { ...action };
      delete missing[field];
      expect(() => parseSharedFinancialAction(missing)).toThrow(TypeError);
    }
    expect(() => parseSharedFinancialAction({ ...action, extra: undefined })).toThrow(TypeError);
    // Property order does not change the existing canonical JSON recipe.
    const reversed = Object.fromEntries(Object.entries(action).reverse());
    expect((await createSharedFinancialActionIdentity(reversed)).requestFingerprint).toBe(
      fingerprint,
    );
  });

  test(`${action.kind} detaches before the real digest await and retains original data`, async () => {
    const input: Record<string, unknown> = { ...action };
    const pending = createSharedFinancialActionIdentity(input);
    // Mutate every original property, then add fields from a later selection,
    // before yielding to the actual WebCrypto digest's continuation.
    for (const field of Object.keys(input)) input[field] = "changed while hashing";
    Object.assign(input, { pricingRevision: "r2", customerId: "cus_changed" });
    const identity = await pending;
    expect(identity.action).toEqual(action);
    expect(identity.requestFingerprint).toBe(fingerprint);
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.isFrozen(identity.action)).toBe(true);
    expect(identity.action).not.toBe(input);
  });
}

test("changed Organization, kind, reference or public body never shares the original fingerprint", async () => {
  const originals = await Promise.all(
    CASES.map(({ action }) => createSharedFinancialActionIdentity(action)),
  );
  expect(new Set(originals.map((value) => value.requestFingerprint)).size).toBe(5);
  for (const { action, fingerprint } of CASES) {
    for (const change of [{ organizationId: "org_other" }, { reference: "other" }]) {
      expect(
        (await createSharedFinancialActionIdentity({ ...action, ...change })).requestFingerprint,
      ).not.toBe(fingerprint);
    }
  }
  const bodyChanges = [
    { ...COMMON, kind: "topup", amountMinor: 1001 },
    { ...COMMON, kind: "subscription-start", planKey: "team" },
    { ...COMMON, kind: "card-setup", setupDisclosureRevision: "setup-v2" },
    { ...COMMON, kind: "plan-change", planKey: "starter", expectedSubscriptionRef: TARGET },
    { ...COMMON, kind: "cancel", cancelAtPeriodEnd: true, expectedSubscriptionRef: OTHER_TARGET },
  ];
  for (const [index, action] of bodyChanges.entries()) {
    expect((await createSharedFinancialActionIdentity(action)).requestFingerprint).not.toBe(
      CASES[index]?.fingerprint,
    );
  }
  expect(
    (
      await createSharedFinancialActionIdentity({
        ...COMMON,
        kind: "plan-change",
        planKey: "team",
        expectedSubscriptionRef: OTHER_TARGET,
      })
    ).requestFingerprint,
  ).not.toBe(CASES[3].fingerprint);
});

test("card setup disclosure is not an amount, charging consent or another action", () => {
  const card = { ...COMMON, kind: "card-setup", setupDisclosureRevision: "setup-v1" };
  for (const extra of [
    { amountMinor: 1000 },
    { charge: true },
    { consentRevision: "charge-v1" },
    { onLimit: "on-demand" },
    { authorizedPrincipal: "session:owner" },
  ])
    expect(() => parseSharedFinancialAction({ ...card, ...extra })).toThrow(TypeError);
  expect(() => parseSharedFinancialAction({ ...card, kind: "topup" })).toThrow(TypeError);
  expect(() =>
    parseSharedFinancialAction({ ...COMMON, kind: "card-setup", consentRevision: "setup-v1" }),
  ).toThrow(TypeError);
});

test("subscription START cannot be replayed as plan change or cancellation", () => {
  const start = { ...COMMON, kind: "subscription-start", planKey: "starter" };
  for (const kind of ["start", "plan-change", "cancel"]) {
    expect(() => parseSharedFinancialAction({ ...start, kind })).toThrow(TypeError);
  }
  expect(() => parseSharedFinancialAction({ ...start, expectedSubscriptionRef: TARGET })).toThrow(
    TypeError,
  );
  const cancel = {
    ...COMMON,
    kind: "cancel",
    expectedSubscriptionRef: TARGET,
    cancelAtPeriodEnd: true,
  };
  for (const cancelAtPeriodEnd of [false, null, 1, "true"]) {
    expect(() => parseSharedFinancialAction({ ...cancel, cancelAtPeriodEnd })).toThrow(TypeError);
  }
  expect(() => parseSharedFinancialAction({ ...cancel, planKey: "starter" })).toThrow(TypeError);
});

test("route-level positive safe minor amounts do not inherit current purchase bounds", () => {
  for (const amountMinor of [1, 1000, Number.MAX_SAFE_INTEGER]) {
    expect(parseSharedFinancialAction({ ...COMMON, kind: "topup", amountMinor })).toMatchObject({
      amountMinor,
    });
  }
  for (const amountMinor of [
    0,
    -0,
    -1,
    0.1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.MAX_SAFE_INTEGER + 1,
    "1000",
    1n,
    null,
  ]) {
    expect(() => parseSharedFinancialAction({ ...COMMON, kind: "topup", amountMinor })).toThrow(
      TypeError,
    );
  }
  expect(() =>
    parseSharedFinancialAction({
      ...COMMON,
      kind: "topup",
      amountMinor: 1000,
      amountMicros: 10_000_000,
    }),
  ).toThrow(TypeError);
});

test("public text and opaque-reference limits match their existing routes", () => {
  expect(
    parseSharedFinancialAction({
      ...COMMON,
      kind: "subscription-start",
      planKey: "a".repeat(1024),
    }),
  ).toMatchObject({ planKey: "a".repeat(1024) });
  expect(
    parseSharedFinancialAction({
      ...COMMON,
      kind: "plan-change",
      planKey: "a".repeat(64),
      expectedSubscriptionRef: TARGET,
    }),
  ).toMatchObject({ planKey: "a".repeat(64) });
  expect(() =>
    parseSharedFinancialAction({
      ...COMMON,
      kind: "subscription-start",
      planKey: "a".repeat(1025),
    }),
  ).toThrow(TypeError);
  expect(() =>
    parseSharedFinancialAction({
      ...COMMON,
      kind: "plan-change",
      planKey: "a".repeat(65),
      expectedSubscriptionRef: TARGET,
    }),
  ).toThrow(TypeError);
  expect(
    parseSharedFinancialAction({ ...COMMON, kind: "subscription-start", planKey: "プラン😀" }),
  ).toMatchObject({ planKey: "プラン😀" });
  for (const planKey of ["", null, 1, "\ud800", "\udc00"]) {
    expect(() =>
      parseSharedFinancialAction({ ...COMMON, kind: "subscription-start", planKey }),
    ).toThrow(TypeError);
  }
  for (const field of ["organizationId", "reference", "setupDisclosureRevision"]) {
    const valid = {
      ...COMMON,
      kind: "card-setup",
      setupDisclosureRevision: "setup-v1",
      [field]: "a".repeat(128),
    };
    expect(parseSharedFinancialAction(valid)).toMatchObject({ [field]: "a".repeat(128) });
    for (const value of ["", "a".repeat(129), "a/b", "a%2Fb", " padded", null, 1]) {
      expect(() => parseSharedFinancialAction({ ...valid, [field]: value })).toThrow(TypeError);
    }
  }
  for (const expectedSubscriptionRef of [
    "",
    `sra_${"A".repeat(64)}`,
    `sra_${"a".repeat(63)}`,
    `sub_${"a".repeat(64)}`,
    null,
  ]) {
    expect(() =>
      parseSharedFinancialAction({
        ...COMMON,
        kind: "cancel",
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef,
      }),
    ).toThrow(TypeError);
  }
});

test("closed data refuses accessors, symbols, hidden fields and non-JSON objects without invoking getters", () => {
  let reads = 0;
  const getter = {
    ...COMMON,
    amountMinor: 1000,
    get kind() {
      reads++;
      return "topup";
    },
  };
  expect(() => parseSharedFinancialAction(getter)).toThrow(TypeError);
  expect(reads).toBe(0);
  const base = { ...COMMON, kind: "topup", amountMinor: 1000 } satisfies SharedFinancialAction;
  const hidden = Object.defineProperty({ ...base }, "selectedTerms", { value: "hidden" });
  const nonenumerableKind = Object.defineProperty({ ...base }, "kind", {
    value: "topup",
    enumerable: false,
  });
  for (const invalid of [
    null,
    [],
    "topup",
    new Date(0),
    Object.create(base),
    hidden,
    nonenumerableKind,
    { ...base, [Symbol("terms")]: "r2" },
  ]) {
    expect(() => parseSharedFinancialAction(invalid)).toThrow(TypeError);
  }
  const noPrototype = Object.assign(Object.create(null), base);
  expect(parseSharedFinancialAction(noPrototype)).toEqual(base);
  expect(() =>
    parseSharedFinancialAction({
      ...base,
      toJSON() {
        reads++;
        return base;
      },
    }),
  ).toThrow(TypeError);
  expect(reads).toBe(0);
});

for (const { action, fingerprint } of CASES) {
  test(`${action.kind} excludes R1/R2 selections, identity and processor recipes`, async () => {
    const selections = {
      pricingRevision: "r1",
      stripePriceId: "price_r1",
      amountMicros: 10_000_000,
      currency: "USD",
      minimumMinor: 500,
      maximumMinor: 5000,
      successUrl: "https://console.example.test/r1",
      cancelUrl: "https://console.example.test/cancel-r1",
      customerId: "cus_r1",
      financialRealm: "realm_r1",
      clock: "2026-10-15T12:00:00.000Z",
      authorizedPrincipal: "session:owner",
      credential: "not-a-credential",
      source: "r1-source",
    };
    for (const [field, value] of Object.entries(selections)) {
      expect(() => parseSharedFinancialAction({ ...action, [field]: value })).toThrow(TypeError);
    }
    const original = await createSharedFinancialActionIdentity(action);
    // Selected terms are intentionally a separate caller-owned object. This
    // unit does not read them or resolve a stored original reference.
    Object.assign(selections, {
      pricingRevision: "r2",
      minimumMinor: 2000,
      customerId: "cus_r2",
      successUrl: "https://console.example.test/r2",
    });
    for (const [field, value] of Object.entries(selections)) {
      expect(() => parseSharedFinancialAction({ ...action, [field]: value })).toThrow(TypeError);
    }
    expect((await createSharedFinancialActionIdentity({ ...action })).requestFingerprint).toBe(
      fingerprint,
    );
    expect(original.requestFingerprint).toBe(fingerprint);
  });
}
