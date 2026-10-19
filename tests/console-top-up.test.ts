import { afterEach, describe, expect, test } from "bun:test";
import {
  createApi,
  type OrganizationSubscription,
  type TopUpCheckoutStart,
  type TopUpReceipt,
} from "../console/src/api.ts";
import { createTopUpCheckoutController, topUpLane } from "../console/src/top-up-checkout.ts";
import {
  createTopUpIntentStore,
  type TopUpIntentStorage,
  TopUpIntentStoreError,
} from "../console/src/top-up-intent.ts";
import { finalizedHostedPlanTable } from "./helpers/finalized-hosted-plan-table.ts";

const organizationId = "org-example";
const ownerPrincipalId = "principal-owner";
const scope = { organizationId, ownerPrincipalId };
const checkoutUrl = "https://checkout.stripe.com/c/pay/cs_test_top_up";
const storageKey = `takoserver.hosted-top-up-intent.v1:${ownerPrincipalId}:${organizationId}`;

const saved = new Map(
  ["document", "window", "localStorage", "Node", "HTMLInputElement", "fetch", "navigator"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
  ),
);
afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

class MemoryStorage implements TopUpIntentStorage {
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

function intentStore(storage: TopUpIntentStorage = new MemoryStorage()) {
  let next = 1;
  return createTopUpIntentStore({
    storage,
    lock: exclusiveLock(),
    uuid: () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`,
  });
}

function browser(search = "") {
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

function apiError(code: string, status: number) {
  return Object.assign(new Error(code), { code, status });
}

function harness(input?: {
  readonly search?: string;
  readonly storage?: MemoryStorage;
  readonly intents?: ReturnType<typeof intentStore>;
  readonly principalId?: string;
  readonly scopeOrganizationId?: string;
  readonly signedOut?: boolean;
  readonly begin?: (reference: string, amountMinor: number) => Promise<TopUpCheckoutStart>;
  readonly receipt?: (reference: string) => Promise<TopUpReceipt>;
}) {
  const storage = input?.storage ?? new MemoryStorage();
  const intents = input?.intents ?? intentStore(storage);
  const location = browser(input?.search);
  const begins: { readonly reference: string; readonly amountMinor: number }[] = [];
  const receipts: string[] = [];
  let refreshes = 0;
  let activeScope: {
    readonly organizationId: string;
    readonly principalId: string;
    readonly ownerPrincipalId: string;
  } | null = input?.signedOut
    ? null
    : {
        organizationId: input?.scopeOrganizationId ?? organizationId,
        principalId: input?.principalId ?? ownerPrincipalId,
        ownerPrincipalId,
      };
  const controller = createTopUpCheckoutController({
    organizationId,
    getScope: () => activeScope,
    intents,
    api: {
      beginTopUp: async (_organizationId, reference, amountMinor) => {
        begins.push({ reference, amountMinor });
        return input?.begin
          ? input.begin(reference, amountMinor)
          : { checkout: { url: checkoutUrl } };
      },
      topUpReceipt: async (_organizationId, reference) => {
        receipts.push(reference);
        if (input?.receipt) return input.receipt(reference);
        throw apiError("not_found", 404);
      },
    },
    browser: location.value,
    onWalletRefresh: () => {
      refreshes += 1;
    },
  });
  return {
    controller,
    storage,
    intents,
    location,
    begins,
    receipts,
    refreshes: () => refreshes,
    switchScope: (next: typeof activeScope) => {
      activeScope = next;
    },
  };
}

function storedReference(storage: MemoryStorage): string | null {
  const value = storage.getItem(storageKey);
  return value === null ? null : (JSON.parse(value) as { reference: string }).reference;
}

describe("hosted top-up intent and Checkout", () => {
  test("a durable reference survives reload and the same amount reuses it", async () => {
    const first = harness();
    await first.controller.start(5000);
    expect(first.begins).toHaveLength(1);
    const reference = first.begins[0]?.reference ?? "";
    expect(reference).toMatch(/^console-top-up-[0-9a-f-]{36}$/u);
    expect(first.location.assigned).toEqual([checkoutUrl]);
    expect(JSON.parse(first.storage.getItem(storageKey) ?? "null")).toEqual({
      version: 1,
      organizationId,
      ownerPrincipalId,
      amountMinor: 5000,
      reference,
    });

    // A reload builds a new controller over the same browser storage.
    const second = harness({ storage: first.storage });
    expect(second.controller.state()).toEqual({ status: "unresolved", amountMinor: 5000 });
    await second.controller.start(5000);
    expect(second.receipts).toEqual([reference]);
    expect(second.begins).toEqual([{ reference, amountMinor: 5000 }]);
    expect(storedReference(second.storage)).toBe(reference);
  });

  test("a different amount sends nothing and offers the earlier payment instead", async () => {
    const page = harness();
    await page.controller.start(5000);
    const reference = page.begins[0]?.reference ?? "";
    await page.controller.start(2500);
    expect(page.begins).toHaveLength(1);
    expect(page.receipts).toEqual([]);
    expect(page.controller.state()).toEqual({ status: "amount_conflict", amountMinor: 5000 });
    expect(storedReference(page.storage)).toBe(reference);

    await page.controller.start(5000);
    expect(page.begins.map((call) => call.reference)).toEqual([reference, reference]);
  });

  test("a different amount minted by another tab under the lock is refused, not overwritten", async () => {
    const storage = new MemoryStorage();
    const shared = exclusiveLock();
    let next = 1;
    const uuid = () => `00000000-0000-4000-8000-${String(next++).padStart(12, "0")}`;
    const otherTab = createTopUpIntentStore({ storage, lock: shared, uuid });
    let otherReference: string | null = null;
    // This tab's peek and unlocked read saw nothing; the other tab mints its
    // own amount while this tab is still waiting for the exclusive lock.
    const interleaved = async <T>(name: string, operation: () => T | Promise<T>): Promise<T> => {
      expect(storedReference(storage)).toBeNull();
      await otherTab.getOrCreate({ ...scope, amountMinor: 1000 });
      otherReference = storedReference(storage);
      return shared(name, operation);
    };
    const page = harness({
      storage,
      intents: createTopUpIntentStore({ storage, lock: interleaved, uuid }),
    });
    await page.controller.start(2000);
    expect(otherReference).not.toBeNull();
    expect(page.begins).toEqual([]);
    expect(page.receipts).toEqual([]);
    expect(page.controller.state()).toEqual({ status: "amount_conflict", amountMinor: 1000 });
    expect(storedReference(storage)).toBe(otherReference);
    expect(JSON.parse(storage.getItem(storageKey) ?? "{}").amountMinor).toBe(1000);
  });

  test("storage failure or an absent exclusive lock refuses to mint a reference", async () => {
    const broken: TopUpIntentStorage = {
      getItem: () => null,
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => undefined,
    };
    const failing = harness({ intents: intentStore(broken) });
    await failing.controller.start(5000);
    expect(failing.begins).toEqual([]);
    expect(failing.controller.state()).toEqual({ status: "error" });

    const unreadable: TopUpIntentStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => undefined,
      removeItem: () => undefined,
    };
    const blocked = harness({ intents: intentStore(unreadable) });
    await blocked.controller.start(5000);
    expect(blocked.begins).toEqual([]);
    expect(blocked.controller.state()).toEqual({ status: "error" });

    const storage = new MemoryStorage();
    const lockless = harness({
      storage,
      intents: createTopUpIntentStore({ storage, uuid: () => crypto.randomUUID() }),
    });
    await lockless.controller.start(5000);
    expect(lockless.begins).toEqual([]);
    expect(storage.values.size).toBe(0);
    expect(lockless.controller.state()).toEqual({ status: "error" });
  });

  test("an ambiguous begin keeps custody and the retry replays the same reference", async () => {
    let fail = true;
    const page = harness({
      begin: async () => {
        if (fail) throw apiError("unreachable", 0);
        return { checkout: { url: checkoutUrl } };
      },
    });
    await page.controller.start(5000);
    expect(page.controller.state()).toEqual({ status: "uncertain" });
    const reference = storedReference(page.storage) ?? "";
    fail = false;
    await page.controller.start(5000);
    expect(page.begins.map((call) => call.reference)).toEqual([reference, reference]);
    expect(page.location.assigned).toEqual([checkoutUrl]);
  });

  test("a paid return removes the intent, refreshes the wallet and only its query key", async () => {
    const storage = new MemoryStorage();
    await intentStore(storage).getOrCreate({ ...scope, amountMinor: 5000 });
    const reference = storedReference(storage) ?? "";
    const page = harness({
      storage,
      search: "?checkout=cs_test_top_up&tab=ledger",
      receipt: async (asked) => ({ reference: asked, state: "paid", checkout: null }),
    });
    await page.controller.handleReturn();
    expect(page.receipts).toEqual([reference]);
    expect(page.begins).toEqual([]);
    expect(page.controller.state()).toEqual({ status: "paid" });
    expect(page.refreshes()).toBe(1);
    expect(storage.values.size).toBe(0);
    expect(page.location.replaced).toEqual(["/billing?tab=ledger#wallet"]);
  });

  test("pending and ready returns keep the intent; ready may continue the same Checkout", async () => {
    for (const state of ["pending", "ready"] as const) {
      const storage = new MemoryStorage();
      await intentStore(storage).getOrCreate({ ...scope, amountMinor: 5000 });
      const reference = storedReference(storage);
      const page = harness({
        storage,
        search: "?checkout=cs_test_top_up",
        receipt: async (asked) => ({
          reference: asked,
          state,
          checkout: state === "ready" ? { url: checkoutUrl } : null,
        }),
      });
      await page.controller.handleReturn();
      expect(storedReference(storage)).toBe(reference);
      expect(page.begins).toEqual([]);
      expect(page.location.replaced).toEqual([]);
      expect(page.refreshes()).toBe(0);
      if (state === "pending") {
        expect(page.controller.state()).toEqual({ status: "pending" });
      } else {
        expect(page.controller.state()).toEqual({ status: "ready", url: checkoutUrl });
        page.controller.continueCheckout();
        expect(page.location.assigned).toEqual([checkoutUrl]);
      }
    }
  });

  test("an unknown or unreachable return receipt keeps the intent", async () => {
    for (const failure of [apiError("not_found", 404), apiError("unreachable", 0)]) {
      const storage = new MemoryStorage();
      await intentStore(storage).getOrCreate({ ...scope, amountMinor: 5000 });
      const reference = storedReference(storage);
      const page = harness({
        storage,
        search: "?checkout=cs_test_top_up",
        receipt: async () => {
          throw failure;
        },
      });
      await page.controller.handleReturn();
      expect(page.controller.state()).toEqual({ status: "uncertain" });
      expect(storedReference(storage)).toBe(reference);
      expect(page.location.replaced).toEqual([]);
    }
  });

  test("an expired receipt compare-and-removes only its matching reference", async () => {
    const storage = new MemoryStorage();
    const store = intentStore(storage);
    await store.getOrCreate({ ...scope, amountMinor: 5000 });
    const reference = storedReference(storage) ?? "";
    await expect(
      store.removeAfterConclusiveReceipt(scope, {
        reference: "console-top-up-other",
        state: "expired",
      }),
    ).rejects.toMatchObject({ code: "intent_reference_mismatch" });
    await expect(
      store.removeAfterConclusiveReceipt(scope, {
        reference,
        state: "pending" as unknown as "expired",
      }),
    ).rejects.toBeInstanceOf(TopUpIntentStoreError);
    expect(storedReference(storage)).toBe(reference);

    const page = harness({
      storage,
      search: "?checkout=cs_test_top_up",
      receipt: async (asked) => ({ reference: asked, state: "expired", checkout: null }),
    });
    await page.controller.handleReturn();
    expect(page.controller.state()).toEqual({ status: "expired" });
    expect(storage.values.size).toBe(0);
    expect(page.location.replaced).toEqual(["/billing#wallet"]);

    // The next explicit start mints a fresh reference.
    const next = harness({ storage, intents: store });
    await next.controller.start(5000);
    expect(next.begins[0]?.reference).not.toBe(reference);
  });

  test("a stored reference found expired or paid on start is concluded, not begun", async () => {
    for (const state of ["expired", "paid"] as const) {
      const storage = new MemoryStorage();
      await intentStore(storage).getOrCreate({ ...scope, amountMinor: 5000 });
      const page = harness({
        storage,
        receipt: async (asked) => ({ reference: asked, state, checkout: null }),
      });
      await page.controller.start(5000);
      expect(page.begins).toEqual([]);
      expect(page.controller.state()).toEqual({ status: state });
      expect(storage.values.size).toBe(0);
    }
  });

  test("a cancelled Checkout keeps the intent and the next start resumes the same reference", async () => {
    const storage = new MemoryStorage();
    await intentStore(storage).getOrCreate({ ...scope, amountMinor: 5000 });
    const reference = storedReference(storage);
    const page = harness({ storage, search: "?checkout=cancelled&tab=ledger" });
    await page.controller.handleReturn();
    expect(page.controller.state()).toEqual({ status: "cancelled" });
    expect(page.receipts).toEqual([]);
    expect(page.begins).toEqual([]);
    expect(storedReference(storage)).toBe(reference);
    expect(page.location.replaced).toEqual(["/billing?tab=ledger#wallet"]);

    await page.controller.start(5000);
    expect(page.begins).toEqual([{ reference: reference ?? "", amountMinor: 5000 }]);
  });

  test("a consent return replays the same reference and amount and removes only its key", async () => {
    const storage = new MemoryStorage();
    await intentStore(storage).getOrCreate({ ...scope, amountMinor: 7500 });
    const reference = storedReference(storage) ?? "";
    const page = harness({ storage, search: "?consent=returned&tab=ledger" });
    await page.controller.handleConsentReturn();
    expect(page.begins).toEqual([{ reference, amountMinor: 7500 }]);
    expect(page.receipts).toEqual([reference]);
    expect(page.location.assigned).toEqual([checkoutUrl]);
    expect(page.location.replaced).toEqual(["/billing?tab=ledger#wallet"]);
    expect(storedReference(storage)).toBe(reference);
  });

  test("a consent return reads the receipt first and never reopens a settled payment", async () => {
    const storage = new MemoryStorage();
    await intentStore(storage).getOrCreate({ ...scope, amountMinor: 7500 });
    const reference = storedReference(storage) ?? "";
    const page = harness({
      storage,
      search: "?consent=returned",
      receipt: async (ref) => ({ reference: ref, state: "paid", checkout: null }),
    });
    await page.controller.handleConsentReturn();
    expect(page.receipts).toEqual([reference]);
    expect(page.begins).toEqual([]);
    expect(page.location.assigned).toEqual([]);
    expect(page.controller.state()).toEqual({ status: "paid" });
    expect(storedReference(storage)).toBeNull();
  });

  test("a new reference refused before creation is discarded only after a not-found receipt", async () => {
    const refused = harness({
      begin: async () => Promise.reject(apiError("invalid_argument", 400)),
    });
    await refused.controller.start(5000);
    const reference = refused.begins[0]?.reference ?? "";
    expect(refused.receipts).toEqual([reference]);
    expect(refused.controller.state()).toEqual({ status: "rejected" });
    expect(storedReference(refused.storage)).toBeNull();

    // A receipt that exists means the server holds the command: keep custody.
    const held = harness({
      begin: async () => Promise.reject(apiError("invalid_argument", 400)),
      receipt: async (ref) => ({ reference: ref, state: "pending", checkout: null }),
    });
    await held.controller.start(5000);
    const heldReference = held.begins[0]?.reference ?? "";
    expect(held.controller.state()).toEqual({ status: "uncertain" });
    expect(storedReference(held.storage)).toBe(heldReference);

    // An unreachable receipt is not absence either.
    const unknown = harness({
      begin: async () => Promise.reject(apiError("invalid_argument", 400)),
      receipt: async () => Promise.reject(apiError("unavailable", 503)),
    });
    await unknown.controller.start(5000);
    expect(storedReference(unknown.storage)).toBe(unknown.begins[0]?.reference ?? "");
  });

  test("a begin answered not_found is discarded only after a not-found receipt, then unavailable", async () => {
    const absent = harness({ begin: async () => Promise.reject(apiError("not_found", 404)) });
    await absent.controller.start(5000);
    const reference = absent.begins[0]?.reference ?? "";
    expect(absent.receipts).toEqual([reference]);
    expect(absent.controller.state()).toEqual({ status: "unavailable" });
    expect(storedReference(absent.storage)).toBeNull();

    for (const receipt of [
      async (ref: string): Promise<TopUpReceipt> => ({
        reference: ref,
        state: "pending",
        checkout: null,
      }),
      async (): Promise<TopUpReceipt> => Promise.reject(apiError("unreachable", 0)),
    ]) {
      const held = harness({
        begin: async () => Promise.reject(apiError("not_found", 404)),
        receipt,
      });
      await held.controller.start(5000);
      expect(held.controller.state()).toEqual({ status: "unavailable" });
      expect(storedReference(held.storage)).toBe(held.begins[0]?.reference ?? "");
    }
  });

  test("a return before the owner scope loads is kept and answered once the scope arrives", async () => {
    const storage = new MemoryStorage();
    await intentStore(storage).getOrCreate({ ...scope, amountMinor: 5000 });
    const page = harness({
      storage,
      signedOut: true,
      search: "?checkout=cs_test_top_up&consent=returned",
      receipt: async (ref) => ({ reference: ref, state: "pending", checkout: null }),
    });
    expect(await page.controller.handleReturn()).toBe(false);
    expect(await page.controller.handleConsentReturn()).toBe(false);
    expect(page.receipts).toEqual([]);
    expect(page.location.replaced).toEqual([]);
    expect(page.location.currentSearch()).toBe("?checkout=cs_test_top_up&consent=returned");

    page.switchScope({ organizationId, principalId: ownerPrincipalId, ownerPrincipalId });
    expect(await page.controller.handleReturn()).toBe(true);
    expect(page.receipts).toHaveLength(1);
    expect(page.controller.state()).toEqual({ status: "pending" });
  });

  test("a consent return without an intent sends nothing", async () => {
    const page = harness({ search: "?consent=returned" });
    await page.controller.handleConsentReturn();
    expect(page.begins).toEqual([]);
    expect(page.receipts).toEqual([]);
    expect(page.location.assigned).toEqual([]);
    expect(page.location.replaced).toEqual(["/billing#wallet"]);
    expect(page.storage.values.size).toBe(0);

    const other = harness({ search: "?consent=other" });
    await other.controller.handleConsentReturn();
    expect(other.location.replaced).toEqual([]);
  });

  test("a non-owner or changed Organization cannot mint, read or send", async () => {
    const storage = new MemoryStorage();
    await intentStore(storage).getOrCreate({ ...scope, amountMinor: 5000 });
    for (const page of [
      harness({ storage, principalId: "principal-member", search: "?checkout=cs_test_top_up" }),
      harness({ storage, scopeOrganizationId: "org-other", search: "?checkout=cs_test_top_up" }),
    ]) {
      await page.controller.start(5000);
      await page.controller.handleReturn();
      await page.controller.handleConsentReturn();
      expect(page.begins).toEqual([]);
      expect(page.receipts).toEqual([]);
      expect(page.location.assigned).toEqual([]);
    }

    const fresh = harness({ principalId: "principal-member" });
    await fresh.controller.start(5000);
    expect(fresh.storage.values.size).toBe(0);
  });

  test("an account switch while begin is in flight cannot redirect the new scope", async () => {
    let release: (value: TopUpCheckoutStart) => void = () => undefined;
    const page = harness({
      begin: () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    });
    const started = page.controller.start(5000);
    while (page.begins.length === 0) await new Promise((resolve) => setTimeout(resolve, 0));
    page.switchScope({
      organizationId,
      principalId: "principal-next",
      ownerPrincipalId: "principal-next",
    });
    release({ checkout: { url: checkoutUrl } });
    await started;
    expect(page.begins).toHaveLength(1);
    expect(page.location.assigned).toEqual([]);
  });
});

describe("top-up lane", () => {
  const planTable = finalizedHostedPlanTable() as unknown as OrganizationSubscription["planTable"];
  const capabilities = {
    contractVersion: "hosted-billing-v1",
    topUps: true,
    subscriptionStart: true,
    subscriptionCancellation: true,
    subscriptionPlanChange: true,
  };
  const ready = (value: OrganizationSubscription) => ({ state: "ready" as const, value });

  test("only the declared hosted billing contract with top-ups takes a durable reference", () => {
    expect(
      topUpLane(ready({ subscription: null, planTable, billingCapabilities: capabilities })),
    ).toBe("hosted");
    expect(topUpLane(ready({ subscription: null, planTable }))).toBe("legacy");
    for (const billingCapabilities of [
      { ...capabilities, topUps: false },
      { ...capabilities, contractVersion: "hosted-billing-v2" },
    ])
      expect(topUpLane(ready({ subscription: null, planTable, billingCapabilities }))).toBe(
        "legacy",
      );
    expect(topUpLane({ state: "error", error: apiError("not_found", 404) })).toBe("legacy");
    expect(topUpLane({ state: "error", error: apiError("unavailable", 503) })).toBeNull();
    expect(topUpLane({ state: "loading" })).toBeNull();
  });
});

describe("console top-up API", () => {
  function transport(answer: (request: Request) => Response) {
    const seen: Request[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        seen.push(request.clone());
        return answer(request);
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    return seen;
  }
  const client = () =>
    createApi({ origin: "https://api.example.test", token: () => null, onSessionLost: () => {} });

  test("hosted begin sends exactly the reference and amount and accepts only a Stripe URL", async () => {
    const seen = transport(() =>
      Response.json({ checkout: { url: checkoutUrl } }, { status: 201 }),
    );
    expect(await client().beginTopUp(organizationId, "console-top-up-1", 5000)).toEqual({
      checkout: { url: checkoutUrl },
    });
    expect(seen[0]?.method).toBe("POST");
    expect(new URL(seen[0]?.url ?? "").pathname).toBe(
      `/v1/organizations/${organizationId}/wallet/checkout`,
    );
    expect(await seen[0]?.json()).toEqual({ reference: "console-top-up-1", amountMinor: 5000 });

    transport(() =>
      Response.json({ checkout: { url: "https://evil.example/pay" } }, { status: 201 }),
    );
    await expect(
      client().beginTopUp(organizationId, "console-top-up-1", 5000),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(client().beginTopUp(organizationId, " bad", 5000)).rejects.toMatchObject({
      code: "invalid_request",
    });
  });

  test("receipts are bound to their reference, state and Checkout URL shape", async () => {
    const seen = transport(() =>
      Response.json({
        reference: "console-top-up-1",
        state: "ready",
        checkout: { url: checkoutUrl },
      }),
    );
    expect(await client().topUpReceipt(organizationId, "console-top-up-1")).toEqual({
      reference: "console-top-up-1",
      state: "ready",
      checkout: { url: checkoutUrl },
    });
    expect(seen[0]?.method).toBe("GET");
    expect(new URL(seen[0]?.url ?? "").pathname).toBe(
      `/v1/organizations/${organizationId}/wallet/checkout/console-top-up-1`,
    );
    for (const payload of [
      { reference: "console-top-up-2", state: "paid", checkout: null },
      { reference: "console-top-up-1", state: "settled", checkout: null },
      { reference: "console-top-up-1", state: "ready", checkout: { url: "https://evil.example" } },
      { reference: "console-top-up-1", state: "ready" },
    ]) {
      transport(() => Response.json(payload));
      await expect(client().topUpReceipt(organizationId, "console-top-up-1")).rejects.toMatchObject(
        { code: "invalid_response" },
      );
    }
  });

  test("the subscription read keeps declared billing capabilities and refuses malformed ones", async () => {
    const planTable = finalizedHostedPlanTable();
    const capabilities = {
      contractVersion: "hosted-billing-v1",
      topUps: true,
      subscriptionStart: true,
      subscriptionCancellation: false,
      subscriptionPlanChange: false,
    };
    transport(() =>
      Response.json({ subscription: null, planTable, billingCapabilities: capabilities }),
    );
    expect((await client().subscription(organizationId)).billingCapabilities).toEqual(capabilities);
    transport(() => Response.json({ subscription: null, planTable }));
    expect(await client().subscription(organizationId)).not.toHaveProperty("billingCapabilities");
    transport(() =>
      Response.json({
        subscription: null,
        planTable,
        billingCapabilities: { ...capabilities, topUps: "yes" },
      }),
    );
    await expect(client().subscription(organizationId)).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  test("legacy begin still sends only the amount and legacy funding the session proof", async () => {
    const seen = transport((request) =>
      new URL(request.url).pathname.endsWith("/funding")
        ? Response.json({ wallet: {} })
        : Response.json({ checkout: { url: checkoutUrl } }, { status: 201 }),
    );
    await client().beginCheckout(organizationId, 5000);
    await client().fund(organizationId, "cs_test_legacy");
    expect(await seen[0]?.json()).toEqual({ amountMinor: 5000 });
    expect(new URL(seen[1]?.url ?? "").pathname).toBe(
      `/v1/organizations/${organizationId}/wallet/funding`,
    );
    expect(await seen[1]?.json()).toEqual({ settlementProof: "cs_test_legacy" });
  });
});

/* ------------------------------------------------------ billing page lane -- */

class TestNode {
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<(event: unknown) => unknown>>();
  readonly style = {};
  readonly dataset = {};
  parent: TestNode | null = null;
  className = "";
  value = "";
  disabled = false;
  constructor(
    readonly tag = "text",
    private readonly content = "",
  ) {}
  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }
  append(...values: Array<TestNode | string>): void {
    for (const value of values) {
      const child = typeof value === "string" ? new TestNode("text", value) : value;
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...values: Array<TestNode | string>): void {
    this.children.length = 0;
    this.append(...values);
  }
  remove(): void {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(type: string, listener: (event: unknown) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }
  removeEventListener(): void {}
  querySelector(): null {
    return null;
  }
  click(): void {
    for (const listener of this.listeners.get("click") ?? []) listener({ target: this });
  }
  all(): TestNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

type SubscriptionAnswer =
  /** Hosted billing composed: the GET declares the hosted contract with top-ups. */
  | "hosted"
  /** Self-host with hosted pricing: a subscription route, no hosted capabilities. */
  | "self-host-subscriptions"
  /** Legacy self-host: no subscription route. */
  | "legacy"
  /** The subscription read never answers. */
  | "loading"
  /** The subscription read fails with something other than not_found. */
  | "failing";

interface SentRequest {
  readonly call: string;
  readonly body: unknown;
}

const flush = async (rounds = 20) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
};

/**
 * Builds the billing page over a Host that answers as given, then reports
 * which money paths it called. Only the lane decision and its routing are
 * under test; the rest of the page is built but not inspected.
 */
async function billingPageFor(input: {
  readonly subscription: SubscriptionAnswer;
  readonly search?: string;
  readonly storage?: Map<string, string>;
  readonly signedIn?: boolean;
  readonly receiptState?: TopUpReceipt["state"];
}) {
  const values = input.storage ?? new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const location = new URL(`https://console.example.test/billing${input.search ?? ""}`);
  const replaced: string[] = [];
  const assigned: string[] = [];
  const body = new TestNode("body");
  Object.assign(globalThis, {
    Node: TestNode,
    HTMLInputElement: TestNode,
    localStorage: storage,
    document: {
      body,
      documentElement: new TestNode("html"),
      createElement: (tag: string) => new TestNode(tag),
      createElementNS: (_ns: string, tag: string) => new TestNode(tag),
      createTextNode: (value: string) => new TestNode("text", value),
      createDocumentFragment: () => new TestNode("fragment"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    window: {
      location: Object.assign(location, { assign: (url: string) => assigned.push(url) }),
      localStorage: storage,
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          replaced.push(url);
          location.search = new URL(url, location).search;
        },
      },
      addEventListener: () => undefined,
    },
  });
  const lock = exclusiveLock();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: {
      locks: {
        request: (name: string, _options: unknown, operation: () => unknown) =>
          lock(name, operation),
      },
    },
  });
  const sent: SentRequest[] = [];
  const base = `/v1/organizations/${organizationId}`;
  globalThis.fetch = Object.assign(
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(target));
      const method = init?.method ?? "GET";
      sent.push({
        call: `${method} ${url.pathname}`,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      if (url.pathname === `${base}/payments/subscription`) {
        if (input.subscription === "loading") return new Promise<Response>(() => undefined);
        if (input.subscription === "failing")
          return Response.json({ error: { code: "unavailable" } }, { status: 503 });
        if (input.subscription === "legacy")
          return Response.json({ error: { code: "not_found" } }, { status: 404 });
        return Response.json({
          subscription: null,
          planTable: finalizedHostedPlanTable(),
          ...(input.subscription === "hosted"
            ? {
                billingCapabilities: {
                  contractVersion: "hosted-billing-v1",
                  topUps: true,
                  subscriptionStart: true,
                  subscriptionCancellation: true,
                  subscriptionPlanChange: true,
                },
              }
            : {}),
        });
      }
      if (method === "GET" && url.pathname.startsWith(`${base}/wallet/checkout/`))
        return Response.json({
          reference: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
          state: input.receiptState ?? "paid",
          checkout: null,
        });
      if (method === "POST" && url.pathname === `${base}/wallet/checkout`)
        return input.subscription === "hosted"
          ? Response.json({ checkout: { url: checkoutUrl } }, { status: 201 })
          : Response.json({ error: { code: "not_found" } }, { status: 404 });
      if (url.pathname === `${base}/wallet/funding`) return Response.json({ wallet: {} });
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const state = await import("../console/src/state.ts");
  const { consoleLocale } = await import("../console/src/i18n.ts");
  const { billingPage } = await import("../console/src/pages/billing.ts");
  consoleLocale.set("en");
  state.setApiOrigin("https://api.example.test");
  const signIn = () => {
    state.principal.set({
      id: ownerPrincipalId,
      provider: "test",
      email: "owner@example.test",
      displayName: "Owner",
    });
    state.organizations.set([
      { id: organizationId, name: "Example", ownerPrincipalId, createdAt: "2026-10-01T00:00:00Z" },
    ]);
    state.selectOrganization(organizationId);
  };
  if (input.signedIn === false) {
    state.principal.set(null);
    state.organizations.set([]);
  } else signIn();
  const root = billingPage(organizationId) as unknown as TestNode;
  await flush();
  const button = (label: string) =>
    [...root.all(), ...body.all()]
      .filter((node) => node.tag === "button" && node.textContent.trim() === label)
      .at(-1);
  return {
    sent,
    calls: () => sent.map((request) => request.call),
    replaced,
    assigned,
    values,
    location,
    body,
    signIn,
    async click(label: string) {
      const target = button(label);
      expect(target).toBeDefined();
      target?.click();
      await flush();
    },
  };
}

const fundingCall = `POST /v1/organizations/${organizationId}/wallet/funding`;
const checkoutCall = `POST /v1/organizations/${organizationId}/wallet/checkout`;

function seededStorage(amountMinor = 5000) {
  const storage = new Map<string, string>();
  const seeded = intentStore({
    getItem: (key) => storage.get(key) ?? null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  }).getOrCreate({ ...scope, amountMinor });
  return seeded.then(() => ({
    storage,
    reference: JSON.parse(storage.get(storageKey) ?? "{}").reference as string,
  }));
}

describe("billing page top-up lane", () => {
  test("a legacy Host still exchanges the returned session through funding", async () => {
    const page = await billingPageFor({
      subscription: "legacy",
      search: "?checkout=cs_test_legacy",
    });
    expect(page.calls()).toContain(fundingCall);
    expect(page.sent.find((request) => request.call === fundingCall)?.body).toEqual({
      settlementProof: "cs_test_legacy",
    });
    expect(page.calls().some((call) => call.includes("/wallet/checkout/"))).toBe(false);
    expect(page.replaced).toEqual(["/billing"]);
  });

  test("a self-host with a subscription route but no hosted capabilities stays legacy", async () => {
    const page = await billingPageFor({
      subscription: "self-host-subscriptions",
      search: "?checkout=cs_test_selfhost",
    });
    expect(page.calls().filter((call) => call === fundingCall)).toHaveLength(1);
    expect(page.calls().some((call) => call.includes("/wallet/checkout/"))).toBe(false);

    await page.click("Add funds");
    await page.click("Continue to payment");
    expect(page.sent.find((request) => request.call === checkoutCall)?.body).toEqual({
      amountMinor: 5000,
    });
    // not_found from the legacy checkout falls back to the operator's proof.
    expect(page.body.textContent).toContain("Settlement proof");
    expect(page.values.has(storageKey)).toBe(false);
  });

  test("legacy Add funds sends only the amount and falls back to operator funding", async () => {
    const page = await billingPageFor({ subscription: "legacy" });
    await page.click("Add funds");
    await page.click("Continue to payment");
    expect(page.sent.filter((request) => request.call === checkoutCall)).toEqual([
      { call: checkoutCall, body: { amountMinor: 5000 } },
    ]);
    expect(page.body.textContent).toContain("Settlement proof");
    expect(page.body.textContent).toContain("Credit wallet");
    expect(page.values.has(storageKey)).toBe(false);
  });

  test("hosted Add funds sends a durable reference with the amount", async () => {
    const page = await billingPageFor({ subscription: "hosted" });
    await page.click("Add funds");
    await page.click("Continue to payment");
    const reference = JSON.parse(page.values.get(storageKey) ?? "{}").reference as string;
    expect(reference).toMatch(/^console-top-up-/u);
    expect(page.sent.filter((request) => request.call === checkoutCall)).toEqual([
      { call: checkoutCall, body: { reference, amountMinor: 5000 } },
    ]);
    expect(page.assigned).toEqual([checkoutUrl]);
    expect(page.calls()).not.toContain(fundingCall);
  });

  test("Add funds sends nothing while the lane is unknown", async () => {
    for (const subscription of ["loading", "failing"] as const) {
      const page = await billingPageFor({ subscription });
      await page.click("Add funds");
      expect(page.calls().filter((call) => call.includes("/wallet/"))).not.toContain(checkoutCall);
      expect(page.body.textContent).not.toContain("Continue to payment");
    }
  });

  test("a hosted Host reads the stored reference's receipt and never calls funding", async () => {
    const { storage, reference } = await seededStorage();
    const page = await billingPageFor({
      subscription: "hosted",
      search: "?checkout=cs_test_hosted",
      storage,
    });
    expect(page.calls()).toContain(
      `GET /v1/organizations/${organizationId}/wallet/checkout/${reference}`,
    );
    expect(page.calls()).not.toContain(fundingCall);
    expect(storage.has(storageKey)).toBe(false);
    expect(page.replaced).toEqual(["/billing"]);
  });

  test("while the lane is unknown a return calls neither funding nor a receipt", async () => {
    for (const subscription of ["loading", "failing"] as const) {
      const { storage } = await seededStorage();
      const page = await billingPageFor({ subscription, search: "?checkout=cs_test_x", storage });
      expect(page.calls()).not.toContain(fundingCall);
      expect(page.calls().some((call) => call.includes("/wallet/checkout/"))).toBe(false);
      expect(page.replaced).toEqual([]);
      expect(page.location.search).toBe("?checkout=cs_test_x");
      expect(storage.has(storageKey)).toBe(true);
    }
  });

  test("a hosted return before the owner scope loads is answered exactly once when it does", async () => {
    const { storage, reference } = await seededStorage();
    const page = await billingPageFor({
      subscription: "hosted",
      search: "?checkout=cs_test_hosted",
      storage,
      signedIn: false,
      receiptState: "pending",
    });
    const receiptCall = `GET /v1/organizations/${organizationId}/wallet/checkout/${reference}`;
    expect(page.calls()).not.toContain(receiptCall);
    expect(page.location.search).toBe("?checkout=cs_test_hosted");

    page.signIn();
    await flush();
    // Signal churn after the return was answered does not ask again.
    page.signIn();
    await flush();
    expect(page.calls().filter((call) => call === receiptCall)).toHaveLength(1);
    expect(page.calls()).not.toContain(fundingCall);
    expect(storage.has(storageKey)).toBe(true);
  });
});
