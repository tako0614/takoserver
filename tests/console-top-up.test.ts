import { afterEach, describe, expect, test } from "bun:test";
import { createApi, type TopUpCheckoutStart, type TopUpReceipt } from "../console/src/api.ts";
import { createTopUpCheckoutController } from "../console/src/top-up-checkout.ts";
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
  readonly begin?: (reference: string, amountMinor: number) => Promise<TopUpCheckoutStart>;
  readonly receipt?: (reference: string) => Promise<TopUpReceipt>;
}) {
  const storage = input?.storage ?? new MemoryStorage();
  const intents = input?.intents ?? intentStore(storage);
  const location = browser(input?.search);
  const begins: { readonly reference: string; readonly amountMinor: number }[] = [];
  const receipts: string[] = [];
  let refreshes = 0;
  let activeScope = {
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
    const page = harness({ storage });
    const otherTab = intentStore(storage);
    await otherTab.getOrCreate({ ...scope, amountMinor: 1000 });
    const otherReference = storedReference(storage);
    await expect(otherTab.getOrCreate({ ...scope, amountMinor: 2000 })).rejects.toMatchObject({
      code: "intent_amount_mismatch",
    });
    await page.controller.start(2000);
    expect(page.begins).toEqual([]);
    expect(page.controller.state()).toEqual({ status: "amount_conflict", amountMinor: 1000 });
    expect(storedReference(storage)).toBe(otherReference);
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
  remove(): void {}
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(): void {}
  removeEventListener(): void {}
}

/**
 * Builds the billing page over a Host that answers as given, then reports
 * which money paths it called. Only the lane decision is under test.
 */
async function billingPageFor(input: {
  readonly hosted: boolean;
  readonly search: string;
  readonly storage?: Map<string, string>;
}) {
  const values = input.storage ?? new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const location = new URL(`https://console.example.test/billing${input.search}`);
  const replaced: string[] = [];
  Object.assign(globalThis, {
    Node: TestNode,
    HTMLInputElement: TestNode,
    localStorage: storage,
    document: {
      body: new TestNode("body"),
      documentElement: new TestNode("html"),
      createElement: (tag: string) => new TestNode(tag),
      createElementNS: (_ns: string, tag: string) => new TestNode(tag),
      createTextNode: (value: string) => new TestNode("text", value),
      createDocumentFragment: () => new TestNode("fragment"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    window: {
      location: Object.assign(location, { assign: () => undefined }),
      localStorage: storage,
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          replaced.push(url);
          const next = new URL(url, location);
          location.search = next.search;
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
  const calls: string[] = [];
  globalThis.fetch = Object.assign(
    async (target: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(target));
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.pathname}`);
      const base = `/v1/organizations/${organizationId}`;
      if (url.pathname === `${base}/payments/subscription`)
        return input.hosted
          ? Response.json({ subscription: null, planTable: finalizedHostedPlanTable() })
          : Response.json({ error: { code: "not_found" } }, { status: 404 });
      if (url.pathname.startsWith(`${base}/wallet/checkout/`))
        return Response.json({
          reference: decodeURIComponent(url.pathname.split("/").at(-1) ?? ""),
          state: "paid",
          checkout: null,
        });
      if (url.pathname === `${base}/wallet/funding`) return Response.json({ wallet: {} });
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const state = await import("../console/src/state.ts");
  const { billingPage } = await import("../console/src/pages/billing.ts");
  state.setApiOrigin("https://api.example.test");
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
  billingPage(organizationId);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return { calls, replaced, values };
}

describe("billing page top-up lane", () => {
  test("a legacy Host still exchanges the returned session through funding", async () => {
    const page = await billingPageFor({ hosted: false, search: "?checkout=cs_test_legacy" });
    expect(page.calls).toContain(`POST /v1/organizations/${organizationId}/wallet/funding`);
    expect(page.calls.some((call) => call.includes("/wallet/checkout/"))).toBe(false);
    expect(page.replaced).toEqual(["/billing"]);
  });

  test("a hosted Host reads the stored reference's receipt and never calls funding", async () => {
    const storage = new Map<string, string>();
    await intentStore({
      getItem: (key) => storage.get(key) ?? null,
      setItem: (key, value) => storage.set(key, value),
      removeItem: (key) => storage.delete(key),
    }).getOrCreate({ ...scope, amountMinor: 5000 });
    const reference = JSON.parse(storage.get(storageKey) ?? "{}").reference as string;
    const page = await billingPageFor({
      hosted: true,
      search: "?checkout=cs_test_hosted",
      storage,
    });
    expect(page.calls).toContain(
      `GET /v1/organizations/${organizationId}/wallet/checkout/${reference}`,
    );
    expect(page.calls.some((call) => call.endsWith("/wallet/funding"))).toBe(false);
    expect(storage.has(storageKey)).toBe(false);
    expect(page.replaced).toEqual(["/billing"]);
  });
});
