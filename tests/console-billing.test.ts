import { afterEach, describe, expect, test } from "bun:test";
import type {
  OrganizationSubscription,
  SubscriptionCancellationReceipt,
  SubscriptionCheckoutStart,
} from "../console/src/api.ts";
import {
  createSubscriptionCancelIntentStore,
  type SubscriptionCancelIntentStorage,
} from "../console/src/subscription-cancel-intent.ts";
import { createSubscriptionCancellationController } from "../console/src/subscription-cancellation.ts";
import { createSubscriptionCheckoutController } from "../console/src/subscription-checkout.ts";
import {
  createSubscriptionIntentStore,
  type SubscriptionIntentStorage,
} from "../console/src/subscription-intent.ts";
import { subscriptionPlanOptions } from "../console/src/subscription-plan-options.ts";
import { finalizedHostedPlanTable } from "./helpers/finalized-hosted-plan-table.ts";

const organizationId = "org-example";
const ownerPrincipalId = "principal-owner";
const otherSubscriptionRef = `sra_${"b".repeat(64)}`;
const originalSubscriptionRef = `sra_${"a".repeat(64)}`;
const hostedPlanTable = {} as OrganizationSubscription["planTable"];

function terminalSnapshot(subscriptionRef = originalSubscriptionRef, status = "canceled") {
  return {
    subscription: {
      organizationId,
      subscriptionId: "sub_private_processor_id",
      subscriptionRef,
      planKey: "host-configured-plan",
      pricingRevision: "revision-1",
      status,
      cancelAtPeriodEnd: false,
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      paidThrough: null,
      paidFeatures: false,
      updatedAt: "2026-10-01T00:00:00.000Z",
    },
    planTable: hostedPlanTable,
  } as OrganizationSubscription;
}
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

class MemoryStorage implements SubscriptionIntentStorage, SubscriptionCancelIntentStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function exclusiveLock() {
  let queue = Promise.resolve();
  return async <T>(_name: string, operation: () => T | Promise<T>): Promise<T> => {
    const previous = queue;
    let release: () => void = () => undefined;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  };
}

function storageFixture(storage = new MemoryStorage()) {
  let next = 1;
  const lock = exclusiveLock();
  return {
    storage,
    purchases: createSubscriptionIntentStore({
      storage,
      lock,
      uuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    }),
    cancellations: createSubscriptionCancelIntentStore({
      storage,
      lock,
      uuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
    }),
  };
}

function checkoutBrowser(search = "") {
  let currentSearch = search;
  const assigned: string[] = [];
  const replaced: string[] = [];
  return {
    assigned,
    replaced,
    currentSearch: () => currentSearch,
    value: {
      readLocation: () => ({ pathname: "/billing", search: currentSearch, hash: "#wallet" }),
      replaceLocation: (url: string) => {
        replaced.push(url);
        currentSearch = new URL(url, "https://console.example").search;
      },
      assign: (url: string) => assigned.push(url),
    },
  };
}

function purchaseScope(principalId = ownerPrincipalId) {
  return { organizationId, principalId, ownerPrincipalId };
}

function checkoutHarness(input?: {
  readonly search?: string;
  readonly scope?: () => ReturnType<typeof purchaseScope> | null;
  readonly begin?: (reference: string, planKey: string) => Promise<SubscriptionCheckoutStart>;
  readonly subscription?: (call: number) => Promise<OrganizationSubscription>;
}) {
  const storage = storageFixture();
  const browser = checkoutBrowser(input?.search);
  const calls: { readonly reference: string; readonly planKey: string }[] = [];
  let refreshes = 0;
  let subscriptionReads = 0;
  const controller = createSubscriptionCheckoutController({
    organizationId,
    getScope: input?.scope ?? (() => purchaseScope()),
    intents: storage.purchases,
    api: {
      subscription: async () => {
        subscriptionReads += 1;
        return input?.subscription ? input.subscription(subscriptionReads) : terminalSnapshot();
      },
      beginSubscription: async (_organizationId, reference, planKey) => {
        calls.push({ reference, planKey });
        return input?.begin
          ? input.begin(reference, planKey)
          : {
              status: 202,
              checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000001" },
            };
      },
    },
    browser: browser.value,
    onSubscriptionRefresh: () => {
      refreshes += 1;
    },
  });
  return {
    controller,
    storage,
    browser,
    calls,
    refreshes: () => refreshes,
    subscriptionReads: () => subscriptionReads,
  };
}

describe("canonical organization subscription checkout", () => {
  test("finalized paid choices render both exact allowances without stacking Free and retain tier selection", async () => {
    const choices = subscriptionPlanOptions(finalizedHostedPlanTable(), "en-US");
    expect(choices).toEqual([
      {
        planId: "hosted-10",
        monthlyAmountMinor: 1000,
        includedCreditMinor: 2000,
        monthlyAmount: "$10",
        monthlyAllowance: "$20",
      },
      {
        planId: "hosted-50",
        monthlyAmountMinor: 5000,
        includedCreditMinor: 10000,
        monthlyAmount: "$50",
        monthlyAllowance: "$100",
      },
    ]);
    for (const choice of choices) {
      const page = checkoutHarness();
      await page.controller.start(choice.planId);
      expect(page.calls.map((call) => call.planKey)).toEqual([choice.planId]);
    }
  });

  test("pending Checkout retains one durable reference across controller reload", async () => {
    const first = checkoutHarness();
    await first.controller.start("host-configured-plan");
    expect(first.controller.state()).toEqual({ status: "pending" });

    const second = createSubscriptionCheckoutController({
      organizationId,
      getScope: () => purchaseScope(),
      intents: first.storage.purchases,
      api: {
        subscription: async () => terminalSnapshot(),
        beginSubscription: async (_organizationId, reference, planKey) => {
          first.calls.push({ reference, planKey });
          return {
            status: 202,
            checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000001" },
          };
        },
      },
      browser: first.browser.value,
      onSubscriptionRefresh: () => undefined,
    });
    await second.start("host-configured-plan");
    expect(first.calls).toHaveLength(2);
    expect(first.calls[1]).toEqual(first.calls[0]);
    expect(first.browser.assigned).toEqual([]);
  });

  test("return completion refreshes subscription truth and removes only its own query key", async () => {
    const page = checkoutHarness({
      search: "?keep=1&subscription=cs_test_return_1",
      begin: async () => ({
        status: 200,
        checkout: {
          state: "associated",
          id: "cs_test_return_1",
          subscriptionRef: originalSubscriptionRef,
        },
      }),
    });
    await page.storage.purchases.getOrCreate({
      organizationId,
      ownerPrincipalId,
      planKey: "host-configured-plan",
    });
    expect(page.browser.currentSearch()).toBe("?keep=1&subscription=cs_test_return_1");
    await page.controller.handleReturn();

    expect(page.controller.state()).toEqual({ status: "associated" });
    expect(page.refreshes()).toBe(1);
    expect(page.browser.currentSearch()).toBe("?keep=1");
    expect(page.browser.replaced.at(-1)).toBe("/billing?keep=1#wallet");
  });

  test("return failure preserves its query and retry uses the same reference", async () => {
    let attempt = 0;
    const page = checkoutHarness({
      search: "?subscription=cs_test_return_1&keep=yes",
      begin: async () => {
        attempt += 1;
        if (attempt === 1) throw new Error("unknown acknowledgement");
        return {
          status: 200,
          checkout: {
            state: "associated",
            id: "cs_test_return_1",
            subscriptionRef: originalSubscriptionRef,
          },
        };
      },
    });
    await page.storage.purchases.getOrCreate({
      organizationId,
      ownerPrincipalId,
      planKey: "host-configured-plan",
    });
    await page.controller.handleReturn();
    expect(page.controller.state()).toEqual({ status: "uncertain" });
    expect(page.browser.currentSearch()).toContain("subscription=cs_test_return_1");
    await page.controller.retryReturn();
    expect(page.controller.state()).toEqual({ status: "associated" });
    expect(page.calls[1]?.reference).toBe(page.calls[0]?.reference);
    expect(page.browser.currentSearch()).toBe("?keep=yes");
  });

  test("Checkout cancel retains the reference and does not mint or submit another", async () => {
    const page = checkoutHarness({ search: "?keep=1&subscription=cancelled" });
    const reference = await page.storage.purchases.getOrCreate({
      organizationId,
      ownerPrincipalId,
      planKey: "host-configured-plan",
    });
    await page.controller.handleReturn();
    expect(page.controller.state()).toEqual({ status: "cancelled" });
    expect(page.storage.storage.values.size).toBe(1);
    expect(
      await page.storage.purchases.getOrCreate({
        organizationId,
        ownerPrincipalId,
        planKey: "host-configured-plan",
      }),
    ).toBe(reference);
    expect(page.calls).toEqual([]);
    expect(page.browser.currentSearch()).toBe("?keep=1&subscription=cancelled");
  });

  test("a return without its durable intent cannot remint a checkout reference", async () => {
    const page = checkoutHarness({ search: "?subscription=cancelled" });
    await page.controller.handleReturn();
    expect(page.controller.state()).toEqual({ status: "missing_intent" });
    await page.controller.start("host-configured-plan");
    expect(page.calls).toEqual([]);
    expect(page.storage.storage.values.size).toBe(0);
  });

  test("simultaneous tabs initialize one reference while owner and Organization scopes stay isolated", async () => {
    const shared = storageFixture();
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    const [first, second] = await Promise.all([
      shared.purchases.getOrCreate(identity),
      shared.purchases.getOrCreate(identity),
    ]);
    expect(first).toBe(second);
    expect(shared.storage.values.size).toBe(1);
    expect(
      await shared.purchases.getOrCreate({
        ...identity,
        organizationId: "other-organization",
      }),
    ).not.toBe(first);
    expect(
      await shared.purchases.getOrCreate({
        ...identity,
        ownerPrincipalId: "other-owner",
      }),
    ).not.toBe(first);
    await expect(
      shared.purchases.getOrCreate({ ...identity, planKey: "another-configured-plan" }),
    ).rejects.toMatchObject({ code: "intent_scope_mismatch" });
  });

  test("storage failure or absent exclusive lock refuses to mint a purchase reference", async () => {
    const brokenStorage: SubscriptionIntentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("storage blocked");
      },
      removeItem: () => undefined,
    };
    const failed = createSubscriptionIntentStore({
      storage: brokenStorage,
      uuid: () => "00000000-0000-4000-8000-000000000001",
      lock: exclusiveLock(),
    });
    await expect(
      failed.getOrCreate({ organizationId, ownerPrincipalId, planKey: "host-configured-plan" }),
    ).rejects.toMatchObject({ code: "storage_unavailable" });
    const noLock = createSubscriptionIntentStore({
      storage: new MemoryStorage(),
      uuid: () => "00000000-0000-4000-8000-000000000002",
    });
    await expect(
      noLock.getOrCreate({ organizationId, ownerPrincipalId, planKey: "host-configured-plan" }),
    ).rejects.toMatchObject({ code: "exclusive_lock_unavailable" });
  });

  test("only an explicit action after exact expired receipt replaces its reference", async () => {
    let attempts = 0;
    const page = checkoutHarness({
      begin: async () => {
        attempts += 1;
        return attempts === 1
          ? { status: 200, checkout: { state: "expired", id: "cs_test_expired_1" } }
          : {
              status: 202,
              checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000001" },
            };
      },
    });
    await page.controller.start("host-configured-plan");
    const expiredReference = page.calls[0]?.reference;
    expect(page.controller.state()).toEqual({ status: "expired" });
    expect(page.calls).toHaveLength(1);
    await page.controller.startNewPurchase("host-configured-plan");
    expect(page.calls).toHaveLength(2);
    expect(page.calls[1]?.reference).not.toBe(expiredReference);
    expect(page.controller.state()).toEqual({ status: "pending" });
  });

  test("terminal associated reference is replayed, checked twice, then rotated once", async () => {
    let previous = "";
    const page = checkoutHarness({
      begin: async (reference) =>
        reference !== previous
          ? {
              status: 202,
              checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000002" },
            }
          : {
              status: 200,
              checkout: {
                state: "associated",
                id: "cs_test_historical",
                subscriptionRef: originalSubscriptionRef,
              },
            },
    });
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    previous = await page.storage.purchases.getOrCreate(identity);
    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);

    expect(page.calls.map(({ reference }) => reference)).toEqual([previous, expect.any(String)]);
    const forwardReference = page.calls[1]?.reference;
    if (forwardReference === undefined) throw new Error("expected forward Checkout reference");
    expect(forwardReference).not.toBe(previous);
    expect(page.storage.purchases.peek(identity)).toBe(forwardReference);
    expect(page.subscriptionReads()).toBe(2);
    expect(page.controller.state()).toEqual({ status: "pending" });
  });

  test("terminal replay mismatch or changed fresh projection retains the previous reference", async () => {
    for (const mode of ["receipt", "projection"] as const) {
      const page = checkoutHarness({
        subscription: async (call) =>
          terminalSnapshot(
            mode === "projection" && call > 1 ? otherSubscriptionRef : originalSubscriptionRef,
          ),
        begin: async () => ({
          status: 200,
          checkout: {
            state: "associated",
            id: "cs_test_historical",
            subscriptionRef: mode === "receipt" ? otherSubscriptionRef : originalSubscriptionRef,
          },
        }),
      });
      const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
      const previous = await page.storage.purchases.getOrCreate(identity);
      await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
      expect(page.calls.map(({ reference }) => reference)).toEqual([previous]);
      expect(page.storage.purchases.peek(identity)).toBe(previous);
      expect(page.controller.state()).toEqual({ status: "target_mismatch" });
    }
  });

  test("pending or open terminal replay keeps the original local reference", async () => {
    const receipts: SubscriptionCheckoutStart[] = [
      {
        status: 202,
        checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000003" },
      },
      {
        status: 201,
        checkout: {
          state: "open",
          id: "cs_test_open_historical",
          url: "https://checkout.stripe.com/c/pay/test",
        },
      },
    ];
    for (const receipt of receipts) {
      const page = checkoutHarness({ begin: async () => receipt });
      const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
      const previous = await page.storage.purchases.getOrCreate(identity);
      await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
      expect(page.calls.map(({ reference }) => reference)).toEqual([previous]);
      expect(page.storage.purchases.peek(identity)).toBe(previous);
      expect(page.browser.assigned).toEqual([]);
    }
  });

  test("two tabs compare-and-rotate the associated intent to one shared forward reference", async () => {
    const storage = storageFixture();
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    const previous = await storage.purchases.getOrCreate(identity);
    const calls: string[] = [];
    const makeController = () =>
      createSubscriptionCheckoutController({
        organizationId,
        getScope: () => purchaseScope(),
        intents: storage.purchases,
        api: {
          subscription: async () => terminalSnapshot(),
          beginSubscription: async (_organizationId, reference) => {
            calls.push(reference);
            return reference === previous
              ? {
                  status: 200,
                  checkout: {
                    state: "associated",
                    id: "cs_test_historical",
                    subscriptionRef: originalSubscriptionRef,
                  },
                }
              : {
                  status: 202,
                  checkout: {
                    state: "pending",
                    id: "sci_00000000-0000-4000-8000-000000000004",
                  },
                };
          },
        },
        browser: checkoutBrowser().value,
        onSubscriptionRefresh: () => undefined,
      });
    const [first, second] = [makeController(), makeController()];
    await Promise.all([
      first.startNewPurchase("host-configured-plan", originalSubscriptionRef),
      second.startNewPurchase("host-configured-plan", originalSubscriptionRef),
    ]);
    const fresh = calls.filter((reference) => reference !== previous);
    expect(new Set(fresh).size).toBe(1);
    const sharedForwardReference = fresh[0];
    if (sharedForwardReference === undefined) throw new Error("expected shared forward reference");
    expect(storage.purchases.peek(identity)).toBe(sharedForwardReference);
  });

  test("an expired replay is advanced only by the next explicit terminal action", async () => {
    let attempt = 0;
    const page = checkoutHarness({
      begin: async () => {
        attempt += 1;
        return attempt === 1
          ? { status: 200, checkout: { state: "expired", id: "cs_test_expired_old" } }
          : {
              status: 202,
              checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000006" },
            };
      },
    });
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    const oldReference = await page.storage.purchases.getOrCreate(identity);
    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    expect(page.controller.state()).toEqual({ status: "expired" });
    expect(page.storage.purchases.peek(identity)).toBe(oldReference);

    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    expect(page.calls.map(({ reference }) => reference)).toEqual([
      oldReference,
      "console-subscription-00000000-0000-4000-8000-000000000002",
    ]);
    const forwardReference = page.calls[1]?.reference;
    if (forwardReference === undefined) throw new Error("expected forward Checkout reference");
    expect(page.storage.purchases.peek(identity)).toBe(forwardReference);
    expect(page.controller.state()).toEqual({ status: "pending" });
  });

  test("an expired fresh forward reference advances to one fresh key on the next click", async () => {
    let attempt = 0;
    const page = checkoutHarness({
      begin: async () => {
        attempt += 1;
        if (attempt === 1)
          return {
            status: 200,
            checkout: {
              state: "associated",
              id: "cs_test_historical",
              subscriptionRef: originalSubscriptionRef,
            },
          };
        if (attempt === 2)
          return { status: 200, checkout: { state: "expired", id: "cs_test_expired_forward" } };
        return {
          status: 202,
          checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000007" },
        };
      },
    });
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    const oldReference = await page.storage.purchases.getOrCreate(identity);
    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    const expiredForwardReference = page.calls[1]?.reference;
    if (expiredForwardReference === undefined)
      throw new Error("expected expired forward reference");
    expect(page.controller.state()).toEqual({ status: "expired" });
    expect(page.storage.purchases.peek(identity)).toBe(expiredForwardReference);

    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    expect(page.calls.map(({ reference }) => reference)).toEqual([
      oldReference,
      expiredForwardReference,
      "console-subscription-00000000-0000-4000-8000-000000000003",
    ]);
    const nextReference = page.calls[2]?.reference;
    if (nextReference === undefined) throw new Error("expected next Checkout reference");
    expect(page.storage.purchases.peek(identity)).toBe(nextReference);
    expect(page.controller.state()).toEqual({ status: "pending" });
  });

  test("an expired receipt cannot reset its reference after the terminal target changes", async () => {
    let subscriptionReads = 0;
    const page = checkoutHarness({
      subscription: async () => {
        subscriptionReads += 1;
        return subscriptionReads > 1
          ? terminalSnapshot(otherSubscriptionRef)
          : terminalSnapshot(originalSubscriptionRef);
      },
      begin: async () => ({
        status: 200,
        checkout: { state: "expired", id: "cs_test_expired_target_change" },
      }),
    });
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    const expiredReference = await page.storage.purchases.getOrCreate(identity);
    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    expect(page.controller.state()).toEqual({ status: "expired" });

    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    expect(page.controller.state()).toEqual({ status: "target_mismatch" });
    expect(page.calls).toHaveLength(1);
    expect(page.storage.purchases.peek(identity)).toBe(expiredReference);
  });

  test("an expired Checkout return can advance the same stored key after matching current terminal GET", async () => {
    let attempt = 0;
    const page = checkoutHarness({
      search: "?subscription=cs_test_return_expired",
      begin: async () => {
        attempt += 1;
        return attempt === 1
          ? { status: 200, checkout: { state: "expired", id: "cs_test_return_expired" } }
          : {
              status: 202,
              checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000009" },
            };
      },
    });
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    const oldReference = await page.storage.purchases.getOrCreate(identity);
    await page.controller.handleReturn();
    expect(page.controller.state()).toEqual({ status: "expired" });

    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    const freshReference = page.calls[1]?.reference;
    if (freshReference === undefined) throw new Error("expected fresh Checkout reference");
    expect(freshReference).not.toBe(oldReference);
    expect(page.storage.purchases.peek(identity)).toBe(freshReference);
    expect(page.controller.state()).toEqual({ status: "pending" });
  });

  test("an expired return receipt for a different Checkout id cannot authorize key reset", async () => {
    const page = checkoutHarness({
      search: "?subscription=cs_test_returned_checkout",
      begin: async () => ({
        status: 200,
        checkout: { state: "expired", id: "cs_test_other_expired_checkout" },
      }),
    });
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    const storedReference = await page.storage.purchases.getOrCreate(identity);
    await page.controller.handleReturn();
    expect(page.controller.state()).toEqual({ status: "uncertain" });
    expect(page.storage.purchases.peek(identity)).toBe(storedReference);
  });

  test("an ordinary submit expiry can advance when the terminal page confirms its target", async () => {
    let attempt = 0;
    const page = checkoutHarness({
      begin: async () => {
        attempt += 1;
        return attempt === 1
          ? { status: 200, checkout: { state: "expired", id: "cs_test_ordinary_expired" } }
          : {
              status: 202,
              checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000010" },
            };
      },
    });
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    const oldReference = await page.storage.purchases.getOrCreate(identity);
    await page.controller.start("host-configured-plan");
    expect(page.controller.state()).toEqual({ status: "expired" });

    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    const freshReference = page.calls[1]?.reference;
    if (freshReference === undefined) throw new Error("expected fresh Checkout reference");
    expect(freshReference).not.toBe(oldReference);
    expect(page.storage.purchases.peek(identity)).toBe(freshReference);
    expect(page.controller.state()).toEqual({ status: "pending" });
  });

  test("two tabs cannot use one expired receipt to clear a newer forward reference", async () => {
    const storage = storageFixture();
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    const oldReference = await storage.purchases.getOrCreate(identity);
    const calls: string[] = [];
    const makeController = () =>
      createSubscriptionCheckoutController({
        organizationId,
        getScope: () => purchaseScope(),
        intents: storage.purchases,
        api: {
          subscription: async () => terminalSnapshot(),
          beginSubscription: async (_organizationId, reference) => {
            calls.push(reference);
            if (reference === oldReference)
              return { status: 200, checkout: { state: "expired", id: "cs_test_shared_expired" } };
            return {
              status: 202,
              checkout: {
                state: "pending",
                id: "sci_00000000-0000-4000-8000-000000000008",
              },
            };
          },
        },
        browser: checkoutBrowser().value,
        onSubscriptionRefresh: () => undefined,
      });
    const [first, second] = [makeController(), makeController()];
    await Promise.all([
      first.startNewPurchase("host-configured-plan", originalSubscriptionRef),
      second.startNewPurchase("host-configured-plan", originalSubscriptionRef),
    ]);
    expect(first.state()).toEqual({ status: "expired" });
    expect(second.state()).toEqual({ status: "expired" });

    await Promise.all([
      first.startNewPurchase("host-configured-plan", originalSubscriptionRef),
      second.startNewPurchase("host-configured-plan", originalSubscriptionRef),
    ]);
    const forward = storage.purchases.peek(identity);
    expect(forward).not.toBe(oldReference);
    expect(calls.filter((reference) => reference === forward)).toHaveLength(1);
    expect(second.state()).toEqual({ status: "intent_conflict" });
  });

  test("a terminal projection without local intent creates a forward key only on explicit action", async () => {
    const page = checkoutHarness({
      begin: async () => ({
        status: 202,
        checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000005" },
      }),
    });
    await page.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    expect(page.subscriptionReads()).toBe(1);
    expect(page.calls).toHaveLength(1);
    expect(page.storage.storage.values.size).toBe(1);
    expect(page.controller.state()).toEqual({ status: "pending" });
  });

  test("a scope switch after terminal read sends nothing and a server refusal retains the rotated key", async () => {
    let active = purchaseScope();
    let finishRead: (result: OrganizationSubscription) => void = () => undefined;
    const waitingRead = new Promise<OrganizationSubscription>((resolve) => {
      finishRead = resolve;
    });
    const switched = checkoutHarness({
      scope: () => active,
      subscription: async () => waitingRead,
    });
    const pending = switched.controller.startNewPurchase(
      "host-configured-plan",
      originalSubscriptionRef,
    );
    active = { ...purchaseScope(), organizationId: "another-org" };
    finishRead(terminalSnapshot());
    await pending;
    expect(switched.calls).toEqual([]);
    expect(switched.storage.storage.values.size).toBe(0);

    const refused = checkoutHarness({
      begin: async (reference) => {
        if (
          reference.startsWith("console-subscription-") &&
          reference === "console-subscription-00000000-0000-4000-8000-000000000002"
        )
          throw { code: "subscription_management_conflict" };
        return {
          status: 200,
          checkout: {
            state: "associated",
            id: "cs_test_historical",
            subscriptionRef: originalSubscriptionRef,
          },
        };
      },
    });
    const identity = { organizationId, ownerPrincipalId, planKey: "host-configured-plan" };
    await refused.storage.purchases.getOrCreate(identity);
    await refused.controller.startNewPurchase("host-configured-plan", originalSubscriptionRef);
    expect(refused.calls).toHaveLength(2);
    const forwardReference = refused.calls[1]?.reference;
    if (forwardReference === undefined) throw new Error("expected forward Checkout reference");
    expect(refused.storage.purchases.peek(identity)).toBe(forwardReference);
    expect(refused.controller.state()).toEqual({ status: "uncertain" });
  });

  test("a non-owner or changed Organization cannot create or send a purchase", async () => {
    const page = checkoutHarness({
      scope: () => ({ ...purchaseScope("different-principal"), organizationId: "other-org" }),
    });
    await page.controller.start("host-configured-plan");
    expect(page.calls).toEqual([]);
    expect(page.storage.storage.values.size).toBe(0);
    expect(page.controller.state()).toEqual({ status: "idle" });
  });

  test("an account switch while Checkout is unresolved cannot redirect the new scope", async () => {
    let active = purchaseScope();
    let entered: () => void = () => undefined;
    let resolveStart: (result: SubscriptionCheckoutStart) => void = () => undefined;
    const begun = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const page = checkoutHarness({
      scope: () => active,
      begin: () => {
        entered();
        return new Promise((resolve) => {
          resolveStart = resolve;
        });
      },
    });
    const pending = page.controller.start("host-configured-plan");
    await begun;
    active = { ...purchaseScope(), organizationId: "another-org" };
    resolveStart({
      status: 201,
      checkout: {
        state: "open",
        id: "cs_test_scope_change",
        url: "https://checkout.stripe.com/c/pay/test",
      },
    });
    await pending;
    expect(page.browser.assigned).toEqual([]);
    expect(page.refreshes()).toBe(0);
  });
});

function cancellationHarness(input?: {
  readonly receipt?: (
    reference: string,
    expectedRef: string,
  ) => Promise<SubscriptionCancellationReceipt>;
  readonly scope?: () => {
    organizationId: string;
    ownerPrincipalId: string;
    subscriptionRef: string;
  } | null;
  readonly storage?: ReturnType<typeof storageFixture>;
}) {
  const storage = input?.storage ?? storageFixture();
  const calls: { readonly reference: string; readonly expectedRef: string }[] = [];
  let refreshes = 0;
  const controller = createSubscriptionCancellationController({
    organizationId,
    getScope:
      input?.scope ??
      (() => ({ organizationId, ownerPrincipalId, subscriptionRef: originalSubscriptionRef })),
    intents: storage.cancellations,
    api: {
      cancelSubscription: async (_organizationId, reference, expectedRef) => {
        calls.push({ reference, expectedRef });
        return input?.receipt
          ? input.receipt(reference, expectedRef)
          : { state: "pending", subscriptionRef: expectedRef };
      },
    },
    onRefresh: () => {
      refreshes += 1;
    },
  });
  return { controller, storage, calls, refreshes: () => refreshes };
}

describe("canonical subscription cancellation", () => {
  test("pending cancellation retries with the same reference and expected target", async () => {
    const first = cancellationHarness();
    await first.controller.cancel();
    expect(first.controller.state()).toEqual({ status: "pending" });
    const second = cancellationHarness({ storage: first.storage });
    expect(second.controller.state()).toEqual({ status: "uncertain" });
    await second.controller.cancel();
    expect(second.calls[0]?.expectedRef).toBe(originalSubscriptionRef);
    expect(first.calls[0]?.reference).toBe(second.calls[0]?.reference);
  });

  test("verified cancellation clears only its matching intent and reports the confirmed date", async () => {
    const page = cancellationHarness({
      receipt: async (_reference, expectedRef) => ({
        state: "verified",
        subscriptionRef: expectedRef,
        effectiveAt: "2026-11-01T00:00:00.000Z",
      }),
    });
    await page.controller.cancel();
    expect(page.controller.state()).toEqual({
      status: "verified",
      effectiveAt: "2026-11-01T00:00:00.000Z",
    });
    expect(page.refreshes()).toBe(1);
  });

  test("a mismatched cancellation receipt does not clear the original target's key", async () => {
    const page = cancellationHarness({
      receipt: async () => ({
        state: "verified",
        subscriptionRef: otherSubscriptionRef,
        effectiveAt: "2026-11-01T00:00:00.000Z",
      }),
    });
    await page.controller.cancel();
    expect(page.controller.state()).toEqual({ status: "target_mismatch" });
    expect(page.storage.storage.values.size).toBe(1);
    expect(page.refreshes()).toBe(1);
  });

  test("a scope change while cancellation is in flight cannot update the new target", async () => {
    let activeRef: string | null = originalSubscriptionRef;
    let release: (value: SubscriptionCancellationReceipt) => void = () => undefined;
    const page = cancellationHarness({
      scope: () =>
        activeRef ? { organizationId, ownerPrincipalId, subscriptionRef: activeRef } : null,
      receipt: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const pending = page.controller.cancel();
    activeRef = otherSubscriptionRef;
    release({
      state: "verified",
      subscriptionRef: originalSubscriptionRef,
      effectiveAt: "2026-11-01T00:00:00.000Z",
    });
    await pending;
    expect(page.controller.state()).toEqual({ status: "busy" });
    expect(page.refreshes()).toBe(0);
  });

  test("a stale cancellation controller sends nothing after its expected subscription disappears", async () => {
    let activeRef: string | null = originalSubscriptionRef;
    const page = cancellationHarness({
      scope: () =>
        activeRef === originalSubscriptionRef
          ? { organizationId, ownerPrincipalId, subscriptionRef: originalSubscriptionRef }
          : null,
    });
    activeRef = null;
    await page.controller.cancel();
    expect(page.calls).toEqual([]);
    expect(page.storage.storage.values.size).toBe(0);
  });

  test("a server target conflict retains the same reference and refreshes canonical status", async () => {
    const page = cancellationHarness({
      receipt: async () => {
        throw { code: "subscription_management_conflict" };
      },
    });
    await page.controller.cancel();
    expect(page.controller.state()).toEqual({ status: "target_mismatch" });
    expect(page.calls).toHaveLength(1);
    expect(page.refreshes()).toBe(1);
    expect(page.storage.storage.values.size).toBe(1);
  });
});
