import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const SAVED_GLOBALS = [
  "Node",
  "HTMLInputElement",
  "document",
  "window",
  "localStorage",
  "sessionStorage",
  "fetch",
] as const;

const savedDescriptors = SAVED_GLOBALS.map(
  (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)] as const,
);

afterEach(() => {
  for (const [key, descriptor] of savedDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

class FakeNode {
  readonly children: FakeNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, EventListener[]>();
  parent: FakeNode | null = null;
  className = "";
  value = "";
  checked = false;
  disabled = false;
  hidden = false;
  inert = false;
  reportValidityCalls = 0;

  constructor(
    readonly tag = "text",
    private readonly content = "",
    private readonly ownerDoc?: FakeDocument,
  ) {}

  get tagName(): string {
    return this.tag.toUpperCase();
  }

  get id(): string {
    return this.attributes.get("id") ?? "";
  }

  get parentElement(): FakeNode | null {
    return this.parent;
  }

  get isConnected(): boolean {
    let cur: FakeNode | null = this;
    while (cur) {
      if (cur === this.ownerDoc?.body) return true;
      cur = cur.parent;
    }
    return false;
  }

  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }

  all(): FakeNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }

  contains(other: FakeNode | null): boolean {
    if (!other) return false;
    return this.all().includes(other);
  }

  closest(selector: string): FakeNode | null {
    const parts = selector.split(",").map((part) => part.trim());
    let cur: FakeNode | null = this;
    while (cur) {
      for (const part of parts) {
        if (part === "[hidden]" && cur.hidden) return cur;
        if (part === "[inert]" && cur.inert) return cur;
        if (part === "summary" && cur.tag === "summary") return cur;
        if (part === "details:not([open])" && cur.tag === "details" && !cur.attributes.has("open"))
          return cur;
      }
      cur = cur.parent;
    }
    return null;
  }

  append(...values: Array<FakeNode | string>): void {
    for (const value of values) {
      const node = typeof value === "string" ? new FakeNode("text", value, this.ownerDoc) : value;
      if (node.tag === "fragment") {
        this.append(...node.children.slice());
      } else {
        node.remove();
        node.parent = this;
        this.children.push(node);
        if (
          this.tag === "select" &&
          (this.children.length === 1 || node.attributes.has("selected"))
        ) {
          this.value = node.value;
        }
      }
    }
  }

  replaceChildren(...values: Array<FakeNode | string>): void {
    for (const child of this.children.slice()) child.remove();
    this.append(...values);
  }

  remove(): void {
    if (this.parent) {
      const index = this.parent.children.indexOf(this);
      if (index >= 0) this.parent.children.splice(index, 1);
      this.parent = null;
      if (this.ownerDoc && this.contains(this.ownerDoc.activeElement)) {
        this.ownerDoc.activeElement = this.ownerDoc.body;
      }
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "disabled") this.disabled = true;
    if (name === "hidden") this.hidden = true;
  }

  removeAttribute(name: string): void {
    this.attributes.delete(name);
    if (name === "disabled") this.disabled = false;
    if (name === "hidden") this.hidden = false;
  }

  getAttribute(name: string): string | null {
    return this.attributes.get(name) ?? null;
  }

  addEventListener(type: string, listener: EventListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  removeEventListener(type: string, listener: EventListener): void {
    this.listeners.set(
      type,
      (this.listeners.get(type) ?? []).filter((item) => item !== listener),
    );
  }

  dispatch(type: string, event: Record<string, unknown> = {}): boolean {
    let prevented = false;
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({
        target: this,
        preventDefault() {
          prevented = true;
        },
        stopPropagation() {},
        ...event,
      } as unknown as Event);
    }
    return prevented;
  }

  click(): void {
    if (this.disabled) return;
    this.dispatch("click");
  }

  focus(): void {
    if (this.ownerDoc) this.ownerDoc.activeElement = this;
  }

  reportValidity(): boolean {
    this.reportValidityCalls += 1;
    return false;
  }

  private matchesFocusable(): boolean {
    if (this.disabled || this.hidden) return false;
    if (this.tag === "a") return this.attributes.has("href");
    if (["button", "input", "select", "textarea", "summary"].includes(this.tag)) {
      return this.attributes.get("type") !== "hidden";
    }
    const tabindex = this.attributes.get("tabindex");
    return tabindex !== undefined && tabindex !== "-1";
  }

  querySelectorAll<Value>(_selector: string): Value[] {
    return this.all().filter((node) => node !== this && node.matchesFocusable()) as Value[];
  }

  querySelector<Value>(_selector: string): Value | null {
    return (this.querySelectorAll<FakeNode>(_selector)[0] ?? null) as Value | null;
  }
}

interface FakeDocument {
  title: string;
  body: FakeNode;
  documentElement: FakeNode;
  activeElement: FakeNode | null;
  getElementById: (id: string) => FakeNode | null;
  createElement: (tag: string) => FakeNode;
  createElementNS: (_ns: string, tag: string) => FakeNode;
  createTextNode: (value: string) => FakeNode;
  createDocumentFragment: () => FakeNode;
  addEventListener: (type: string, listener: EventListener) => void;
  removeEventListener: (type: string, listener: EventListener) => void;
  dispatchKey: (key: string, extra?: Record<string, unknown>) => boolean;
}

function installFakeDom(
  pathname = "/",
  options: { readonly prefersDark?: boolean } = {},
): {
  readonly doc: FakeDocument;
  readonly body: FakeNode;
  readonly root: FakeNode;
  readonly setPrefersDark: (dark: boolean) => void;
} {
  const storageValues = new Map<string, string>();
  const storage = {
    getItem: (key: string): string | null => storageValues.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      storageValues.set(key, value);
    },
    removeItem: (key: string): void => {
      storageValues.delete(key);
    },
  };
  const docEvents = new FakeNode("document");
  const winEvents = new FakeNode("window");
  const doc: FakeDocument = {
    title: "Takoserver Console",
    body: null as unknown as FakeNode,
    documentElement: null as unknown as FakeNode,
    activeElement: null,
    getElementById: (id: string) => doc.body.all().find((node) => node.id === id) ?? null,
    createElement: (tag: string) => new FakeNode(tag, "", doc),
    createElementNS: (_ns: string, tag: string) => new FakeNode(tag, "", doc),
    createTextNode: (value: string) => new FakeNode("text", value, doc),
    createDocumentFragment: () => new FakeNode("fragment", "", doc),
    addEventListener: docEvents.addEventListener.bind(docEvents),
    removeEventListener: docEvents.removeEventListener.bind(docEvents),
    dispatchKey: (key: string, extra: Record<string, unknown> = {}) => {
      const d = docEvents.dispatch("keydown", { key, ...extra });
      const w = winEvents.dispatch("keydown", { key, ...extra });
      return d || w;
    },
  };
  doc.body = new FakeNode("body", "", doc);
  doc.documentElement = new FakeNode("html", "", doc);
  const root = new FakeNode("div", "", doc);
  root.setAttribute("id", "root");
  doc.body.append(root);

  let darkMatches = options.prefersDark ?? false;
  const mediaListeners: Array<(event: { matches: boolean }) => void> = [];
  const location = new URL(`https://console.example.test${pathname}`);
  Object.assign(globalThis, {
    Node: FakeNode,
    HTMLInputElement: FakeNode,
    localStorage: storage,
    sessionStorage: storage,
    document: doc,
    window: {
      location,
      addEventListener: winEvents.addEventListener.bind(winEvents),
      removeEventListener: winEvents.removeEventListener.bind(winEvents),
      scrollTo: () => undefined,
      matchMedia: (query: string) => ({
        media: query,
        get matches() {
          return query === "(prefers-color-scheme: dark)" ? darkMatches : false;
        },
        addEventListener: (_type: string, listener: (event: { matches: boolean }) => void) => {
          mediaListeners.push(listener);
        },
        removeEventListener: () => undefined,
      }),
      history: {
        pushState: (_state: unknown, _title: string, next: string) => {
          location.href = new URL(next, location).href;
        },
        replaceState: (_state: unknown, _title: string, next: string) => {
          location.href = new URL(next, location).href;
        },
      },
    },
  });
  return {
    doc,
    body: doc.body,
    root,
    setPrefersDark: (dark: boolean) => {
      darkMatches = dark;
      for (const listener of mediaListeners) listener({ matches: dark });
    },
  };
}

async function flush(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("Console & Site Wave 4 UI/UX improvements", () => {
  test("billingPage workspaceUsageCard and hostedSubscriptionCard keep section Refresh buttons focused in place", async () => {
    const { doc, root } = installFakeDom("/billing");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { navigate } = await import("../console/src/router.ts");
    const { billingPage } = await import("../console/src/pages/billing.ts");
    consoleLocale.set("en");
    navigate("/billing");
    state.setApiOrigin("https://billing-w4.example.test");
    const org = {
      id: "org-w4-billing",
      name: "Wave4 Org",
      ownerPrincipalId: "prn-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    state.principal.set({
      id: "prn-owner",
      provider: "google",
      email: "owner@example.test",
      displayName: "Owner",
    });
    state.organizations.set([org]);
    state.selectOrganization(org.id);

    const workspaceResolvers: Array<(response: Response) => void> = [];
    const subscriptionResolvers: Array<(response: Response) => void> = [];
    const workspacePayload = {
      organizationId: org.id,
      snapshotAt: "2026-11-28T10:00:00.000Z",
      periodStart: "2026-11-01T00:00:00.000Z",
      periodEnd: "2026-12-01T00:00:00.000Z",
      unit: "USD-micros",
      totalsScope: "organization",
      usageSummary: {
        organizationId: org.id,
        currency: "USD",
        unit: "USD-micros",
        periodStart: "2026-11-01T00:00:00.000Z",
        periodEnd: "2026-12-01T00:00:00.000Z",
      },
      totals: { usedMicros: "2000000", heldMicros: "0", pendingMicros: "0" },
      unattributed: { usedMicros: "0", heldMicros: "0", pendingMicros: "0" },
      workspaces: [
        { workspaceRef: "wbr_alpha", usedMicros: "2000000", heldMicros: "0", pendingMicros: "0" },
      ],
      cursor: "c1",
    };
    const subPayload = {
      subscription: null,
      planTable: {
        scope: "hosted",
        balanceScope: "organization",
        products: ["takosumi-hosted", "takoserver"],
        plans: [
          { planId: "free", tier: "free", resourceScope: "edge", edgeAllowance: "pending" },
          {
            planId: "usage",
            tier: "usage",
            checkoutMinimumMinor: 500,
            checkoutMaximumMinor: 25000,
            meters: {},
          },
        ],
      },
      billingCapabilities: {
        contractVersion: "hosted-billing-v1",
        topUps: true,
        subscriptionStart: true,
        subscriptionCancellation: true,
        subscriptionPlanChange: true,
      },
    };

    let moreFails = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/wallet")) {
          return Response.json({
            wallet: {
              organizationId: org.id,
              currency: "USD",
              settledMicros: "1000000",
              heldMicros: "0",
              availableMicros: "1000000",
              frozenMicros: "0",
              refundReceivableMicros: "0",
              entries: [],
            },
          });
        }
        if (url.pathname.endsWith("/usage-summary/workspaces")) {
          if (url.searchParams.has("cursor") && moreFails) {
            return Response.json({ error: { code: "billing_unavailable" } }, { status: 503 });
          }
          return await new Promise<Response>((resolve) => {
            workspaceResolvers.push(resolve);
          });
        }
        if (url.pathname.endsWith("/payments/subscription")) {
          return await new Promise<Response>((resolve) => {
            subscriptionResolvers.push(resolve);
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = billingPage(org.id) as unknown as FakeNode;
    root.append(page);
    await flush();

    // Resolve initial loads.
    workspaceResolvers.shift()?.(Response.json(workspacePayload));
    subscriptionResolvers.shift()?.(Response.json(subPayload));
    await flush();

    const usageSection = page
      .all()
      .find(
        (node) =>
          node.tag === "section" && node.children[0]?.textContent.includes("Workspace usage"),
      );
    const usageRefresh = usageSection?.children[0]?.all().find((node) => node.tag === "button");
    expect(usageRefresh).toBeDefined();
    if (!usageRefresh) throw new Error("workspace usage Refresh button missing");

    usageRefresh.focus();
    usageRefresh.click();
    await flush();

    // Button identity and focus survive ready -> loading -> ready in place.
    expect(page.all().includes(usageRefresh)).toBe(true);
    expect(doc.activeElement).toBe(usageRefresh);
    expect(usageRefresh.getAttribute("aria-busy")).toBe("true");
    expect(usageRefresh.getAttribute("aria-disabled")).toBe("true");
    expect(usageRefresh.textContent).toBe("Refreshing…");

    workspaceResolvers.shift()?.(Response.json(workspacePayload));
    await flush();
    expect(doc.activeElement).toBe(usageRefresh);
    expect(usageRefresh.getAttribute("aria-busy")).toBeNull();
    expect(usageRefresh.textContent).toBe("Refresh");

    // Pagination failure inside workspace usage renders role="alert".
    moreFails = true;
    const loadMoreBtn = usageSection
      ?.all()
      .find((node) => node.tag === "button" && node.textContent === "Load more");
    loadMoreBtn?.click();
    await flush();
    const moreAlert = usageSection
      ?.all()
      .find(
        (node) => node.className.includes("notice--bad") && node.getAttribute("role") === "alert",
      );
    expect(moreAlert).toBeDefined();

    // Subscription card header Refresh status button also preserves focus across reload.
    const subSection = page
      .all()
      .find(
        (node) => node.tag === "section" && node.children[0]?.textContent.includes("Subscription"),
      );
    const subRefresh = subSection?.children[0]?.all().find((node) => node.tag === "button");
    expect(subRefresh).toBeDefined();
    if (!subRefresh) throw new Error("Subscription Refresh status button missing");
    expect(subRefresh.textContent).toBe("Refresh status");

    subRefresh.focus();
    subRefresh.click();
    await flush();
    expect(doc.activeElement).toBe(subRefresh);
    expect(subRefresh.getAttribute("aria-busy")).toBe("true");
    expect(subRefresh.textContent).toBe("Refreshing…");

    subscriptionResolvers.shift()?.(Response.json(subPayload));
    await flush();
    expect(doc.activeElement).toBe(subRefresh);
    expect(subRefresh.getAttribute("aria-busy")).toBeNull();
    expect(subRefresh.textContent).toBe("Refresh status");
  });

  test("resourceDetailPage keeps persistent header Reload button mounted and focused across reload", async () => {
    const { doc, root } = installFakeDom("/resources/uid-w4");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { route } = await import("../console/src/router.ts");
    const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
    consoleLocale.set("en");
    route.set({
      path: "/resources/uid-w4",
      segments: ["resources", "uid-w4"],
      query: new URLSearchParams(),
    });
    state.setApiOrigin("https://detail-w4.example.test");
    const org = {
      id: "org-w4-detail",
      name: "Detail Org",
      ownerPrincipalId: "prn-owner",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    state.organizations.set([org]);
    state.selectOrganization(org.id);

    const resourceResolvers: Array<(response: Response) => void> = [];
    const sample = {
      uid: "uid-w4",
      form: "https://edge.forms.takoform.com/forms/SQLiteDatabase/0.2.0/",
      space: org.id,
      name: "notes-db",
      generation: 1,
      observedGeneration: 1,
      observedAt: "2026-11-28T00:00:00.000Z",
      phase: "idle",
      spec: {},
      observed: { databaseExists: true },
      output: {},
      lastOperation: "op-1",
    };
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/resources/uid-w4")) {
          return await new Promise<Response>((resolve) => {
            resourceResolvers.push(resolve);
          });
        }
        return Response.json({ items: [], nextCursor: null });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = resourceDetailPage(org.id, "uid-w4") as unknown as FakeNode;
    root.append(page);
    await flush();

    // During initial load: single visually-hidden h1 and Reloading… button.
    expect(page.all().filter((node) => node.tag === "h1")).toHaveLength(1);
    const reloadBtn = page
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Reloading…");
    expect(reloadBtn).toBeDefined();
    if (!reloadBtn) throw new Error("persistent Reload button missing");

    resourceResolvers.shift()?.(Response.json(sample));
    await flush();
    expect(reloadBtn.textContent).toBe("Reload");
    expect(page.all().filter((node) => node.tag === "h1")).toHaveLength(1);

    // Focus Reload and trigger reload: node identity and focus survive loading -> ready.
    reloadBtn.focus();
    reloadBtn.click();
    await flush();
    expect(page.all().includes(reloadBtn)).toBe(true);
    expect(doc.activeElement).toBe(reloadBtn);
    expect(reloadBtn.getAttribute("aria-busy")).toBe("true");
    expect(reloadBtn.getAttribute("aria-disabled")).toBe("true");
    expect(reloadBtn.textContent).toBe("Reloading…");

    resourceResolvers.shift()?.(Response.json(sample));
    await flush();
    expect(doc.activeElement).toBe(reloadBtn);
    expect(reloadBtn.getAttribute("aria-busy")).toBeNull();
    expect(reloadBtn.textContent).toBe("Reload");

    // 404 unmounts header so only the page-level empty h1 renders.
    reloadBtn.click();
    await flush();
    resourceResolvers.shift()?.(Response.json({ error: { code: "not_found" } }, { status: 404 }));
    await flush();
    const h1s = page.all().filter((node) => node.tag === "h1");
    expect(h1s).toHaveLength(1);
    expect(h1s[0]?.textContent).toBe("No such resource");
    expect(page.all().includes(reloadBtn)).toBe(false);
  });

  test("hostedBillingContinuationPage validates top-up amount inline with setFieldError instead of reportValidity", async () => {
    const selector = "b".repeat(64);
    const { doc, root } = installFakeDom(`/billing/hosted-continuations/${selector}`);
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { hostedBillingContinuationPage } = await import(
      "../console/src/pages/hosted-billing-continuation.ts"
    );
    consoleLocale.set("en");
    state.setApiOrigin("https://cont-w4.example.test");

    let postCount = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        if ((init?.method ?? "GET") === "POST") postCount += 1;
        if (url.pathname === `/v1/billing/hosted-continuations/${selector}`) {
          return Response.json({
            continuation: {
              contractVersion: "hosted-browser-v1",
              continuationRef: selector,
              kind: "view",
              workspaceId: "ws-w4",
              workspaceRef: "wbr_w4",
              organizationId: "org-w4",
              operation: null,
              phase: null,
            },
          });
        }
        if (url.pathname.endsWith("/payments/subscription")) {
          return Response.json({
            subscription: null,
            planTable: {
              scope: "hosted",
              balanceScope: "organization",
              products: ["takosumi-hosted", "takoserver"],
              plans: [
                {
                  planId: "free",
                  tier: "free",
                  resourceScope: "edge",
                  edgeAllowance: "pending-owner-runtime-policy",
                },
                {
                  planId: "team-monthly",
                  tier: "subscription",
                  monthlyAmountMinor: 2300,
                  includedCreditMinor: 1200,
                  stripePriceId: "price_team_monthly",
                },
                {
                  planId: "scale-monthly",
                  tier: "subscription",
                  monthlyAmountMinor: 8900,
                  includedCreditMinor: 6200,
                  stripePriceId: "price_scale_monthly",
                },
                {
                  planId: "usage",
                  tier: "usage",
                  checkoutMinimumMinor: 500,
                  checkoutMaximumMinor: 25000,
                  meters: {},
                },
              ],
            },
            billingCapabilities: {
              contractVersion: "hosted-billing-v1",
              topUps: true,
              subscriptionStart: false,
              subscriptionCancellation: false,
              subscriptionPlanChange: false,
            },
          });
        }
        return Response.json({
          wallet: {
            organizationId: "org-w4",
            currency: "USD",
            settledMicros: "10000000",
            heldMicros: "0",
            availableMicros: "10000000",
            frozenMicros: "0",
            refundReceivableMicros: "0",
            entries: [],
          },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = hostedBillingContinuationPage(selector) as unknown as FakeNode;
    root.append(page);
    await flush();

    const amount = page.all().find((node) => node.id === "hosted-continuation-topup-amount");
    const error = page.all().find((node) => node.id === "hosted-continuation-topup-amount-error");
    const consent = page.all().find((node) => node.getAttribute("type") === "checkbox");
    const prepare = page
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Prepare top-up");
    if (!amount || !error || !consent || !prepare) throw new Error("top-up controls missing");

    expect(amount.getAttribute("aria-describedby")).toBe("hosted-continuation-topup-amount-hint");
    expect(error.hidden).toBe(true);

    consent.checked = true;
    consent.dispatch("change");
    amount.value = "1.00";
    prepare.click();
    await flush();

    expect(postCount).toBe(0);
    expect(amount.reportValidityCalls).toBe(0);
    expect(error.hidden).toBe(false);
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toContain("$5.00");
    expect(error.textContent).toContain("$250.00");
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    expect(amount.getAttribute("aria-describedby")).toBe(
      "hosted-continuation-topup-amount-hint hosted-continuation-topup-amount-error",
    );
    expect(doc.activeElement).toBe(amount);

    // Valid edit clears inline error immediately while preserving base hint id.
    amount.value = "25.00";
    amount.dispatch("input");
    expect(error.hidden).toBe(true);
    expect(amount.getAttribute("aria-invalid")).toBeNull();
    expect(amount.getAttribute("aria-describedby")).toBe("hosted-continuation-topup-amount-hint");
  });

  test("boot pre-session status uses <main> landmark, topbar theme resolves system dark on first click and keeps focus", async () => {
    const mainSource = readFileSync(new URL("../console/src/main.ts", import.meta.url), "utf8");
    expect(mainSource).toContain(
      '"main",\n          { class: "signin" },\n          h(\n            "div",\n            { role: "status", "aria-busy": "true" },',
    );
    expect(mainSource).not.toContain('{ class: "signin", role: "status"');

    const { doc, root } = installFakeDom("/", { prefersDark: true });
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://topbar-w4.example.test");
    state.applyTheme("system");
    expect(state.resolvedTheme()).toBe("dark");
    state.adoptSession("legacy");

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/me") {
          return Response.json({
            principal: {
              id: "prn-1",
              provider: "local",
              email: "owner@example.test",
              displayName: "Owner",
            },
            organizations: [
              {
                id: "org-1",
                name: "Alpha",
                ownerPrincipalId: "prn-1",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
            ],
          });
        }
        return Response.json({ items: [], nextCursor: null });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    // Trigger topbar via main.ts module evaluation in isolated worker process.
    await import("../console/src/main.ts");
    await flush();

    const themeBtn = root
      .all()
      .find(
        (node) =>
          node.tag === "button" && (node.getAttribute("aria-label") ?? "").startsWith("Theme:"),
      );
    const localeBtn = root
      .all()
      .find((node) => node.tag === "button" && node.textContent === "日本語");
    expect(themeBtn).toBeDefined();
    expect(localeBtn).toBeDefined();
    if (!themeBtn || !localeBtn) throw new Error("topbar controls missing");

    // System dark -> first click switches immediately to light AND preserves focus on same button.
    themeBtn.focus();
    themeBtn.click();
    await flush();
    expect(state.theme()).toBe("light");
    expect(root.all().includes(themeBtn)).toBe(true);
    expect(doc.activeElement).toBe(themeBtn);
    expect(themeBtn.getAttribute("aria-label")).toBe("Theme: Light");

    // Locale button also preserves node identity and focus across JA <-> EN toggle.
    localeBtn.focus();
    localeBtn.click();
    await flush();
    expect(consoleLocale()).toBe("ja");
    expect(root.all().includes(localeBtn)).toBe(true);
    expect(doc.activeElement).toBe(localeBtn);
    expect(localeBtn.textContent).toBe("EN");
  });

  test("settings Appearance/Language cards (inside live page) and sign-in themeSwitch preserve focus", async () => {
    const { doc, root } = installFakeDom("/settings");
    const state = await import("../console/src/state.ts");
    const { live } = await import("../console/src/dom.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { settingsPage } = await import("../console/src/pages/settings.ts");
    const { signInPage } = await import("../console/src/pages/signin.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://settings-w4.example.test");
    state.applyTheme("light");
    let supportProbeCalls = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/support")) {
          supportProbeCalls += 1;
          return Response.json({ supported: true, operations: ["create"] });
        }
        return Response.json({ providers: [] });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const org = {
      id: "org-1",
      name: "Alpha",
      ownerPrincipalId: "prn-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    // Mount inside live(...) just like main.ts's live(page), so any accidental synchronous
    // theme()/consoleLocale() read in settingsPage() would tear down the page and drop focus.
    const pageHost = live(() => settingsPage(org)) as unknown as FakeNode;
    root.append(pageHost);
    await flush();
    const initialSupportCalls = supportProbeCalls;
    expect(initialSupportCalls).toBe(2);

    const darkBtn = pageHost
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Dark");
    expect(darkBtn).toBeDefined();
    if (!darkBtn) throw new Error("Dark button missing");
    darkBtn.focus();
    darkBtn.click();
    await flush();
    expect(state.theme()).toBe("dark");
    expect(pageHost.all().includes(darkBtn)).toBe(true);
    expect(doc.activeElement).toBe(darkBtn);
    expect(darkBtn.getAttribute("aria-pressed")).toBe("true");
    expect(supportProbeCalls).toBe(initialSupportCalls);

    // Switching language in Settings must NOT remount settingsPage(), drop focus, or re-probe Host support.
    const jaBtn = pageHost
      .all()
      .find((node) => node.tag === "button" && node.textContent === "日本語");
    const enBtn = pageHost
      .all()
      .find((node) => node.tag === "button" && node.textContent === "English");
    expect(jaBtn).toBeDefined();
    expect(enBtn).toBeDefined();
    if (!jaBtn || !enBtn) throw new Error("Settings language buttons missing");

    jaBtn.focus();
    jaBtn.click();
    await flush();
    expect(consoleLocale()).toBe("ja");
    expect(pageHost.all().includes(jaBtn)).toBe(true);
    expect(doc.activeElement).toBe(jaBtn);
    expect(jaBtn.getAttribute("aria-pressed")).toBe("true");
    expect(enBtn.getAttribute("aria-pressed")).toBe("false");
    expect(pageHost.all().find((node) => node.tag === "h1")?.textContent).toBe("設定");
    expect(
      pageHost
        .all()
        .some((node) => node.className === "card__title" && node.textContent === "組織"),
    ).toBe(true);
    expect(supportProbeCalls).toBe(initialSupportCalls);

    enBtn.focus();
    enBtn.click();
    await flush();
    expect(consoleLocale()).toBe("en");
    expect(pageHost.all().includes(enBtn)).toBe(true);
    expect(doc.activeElement).toBe(enBtn);
    expect(enBtn.getAttribute("aria-pressed")).toBe("true");
    expect(jaBtn.getAttribute("aria-pressed")).toBe("false");
    expect(pageHost.all().find((node) => node.tag === "h1")?.textContent).toBe("Settings");
    expect(supportProbeCalls).toBe(initialSupportCalls);

    // Sign-in segmented theme control preserves focus too.
    root.replaceChildren();
    const signin = signInPage() as unknown as FakeNode;
    root.append(signin);
    const lightBtn = signin
      .all()
      .find((node) => node.tag === "button" && node.getAttribute("aria-label") === "Light");
    expect(lightBtn).toBeDefined();
    if (!lightBtn) throw new Error("Light segmented button missing");
    lightBtn.focus();
    lightBtn.click();
    await flush();
    expect(state.theme()).toBe("light");
    expect(signin.all().includes(lightBtn)).toBe(true);
    expect(doc.activeElement).toBe(lightBtn);
    expect(lightBtn.getAttribute("aria-pressed")).toBe("true");
  });

  test("createResource validates missing and unsupported custom Form inline, focuses Form first, and clears on edit", async () => {
    const { doc, body } = installFakeDom("/resources");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { createResource } = await import("../console/src/pages/create-resource.ts");
    const { mountToasts } = await import("../console/src/ui.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://create-w4.example.test");
    state.adoptSession("shared-auth");
    state.organizations.set([
      {
        id: "org-1",
        name: "Alpha",
        ownerPrincipalId: "prn-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    state.selectOrganization("org-1");
    body.append(mountToasts() as unknown as FakeNode);

    const unsupportedFormUrl = "https://example.invalid/forms/Unsupported/0.1.0/";
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/support")) {
          const requestedForm = url.searchParams.get("form") ?? "";
          const supported = requestedForm !== unsupportedFormUrl;
          return Response.json({
            form: requestedForm,
            supported,
            operations: supported ? ["create"] : [],
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    createResource("org-1");
    await flush();

    const formSelect = body.all().find((node) => node.id === "create-resource-form");
    const formUrlInput = body.all().find((node) => node.id === "create-resource-form-url");
    const formError = body.all().find((node) => node.id === "create-resource-form-error");
    const nameInput = body.all().find((node) => node.id === "create-resource-name");
    const createBtn = body
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Create");
    if (!formSelect || !formUrlInput || !formError || !nameInput || !createBtn)
      throw new Error("createResource controls missing");

    // Submit with both Form and Name empty: Form gets inline error and takes focus first.
    createBtn.click();
    await flush();
    expect(formError.hidden).toBe(false);
    expect(formError.getAttribute("role")).toBe("alert");
    expect(formSelect.getAttribute("aria-invalid")).toBe("true");
    expect(formSelect.getAttribute("aria-describedby")).toBe(
      "create-resource-form-hint create-resource-form-error",
    );
    expect(doc.activeElement).toBe(formSelect);

    // Selecting a Form clears the inline error.
    formSelect.value = "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/";
    formSelect.dispatch("change");
    await flush();
    expect(formError.hidden).toBe(true);
    expect(formSelect.getAttribute("aria-invalid")).toBeNull();

    // Switching to custom Form URL ("other") and submitting an unsupported Form shows inline error on the URL input.
    formSelect.value = "other";
    formSelect.dispatch("change");
    await flush();
    expect(formUrlInput.hidden).toBe(false);

    formUrlInput.value = unsupportedFormUrl;
    formUrlInput.dispatch("input");
    nameInput.value = "demo-resource";
    nameInput.dispatch("input");
    createBtn.click();
    await flush();
    expect(formError.hidden).toBe(false);
    expect(formError.getAttribute("role")).toBe("alert");
    expect(formError.textContent).toContain("does not support create");
    expect(formUrlInput.getAttribute("aria-invalid")).toBe("true");
    expect(formUrlInput.getAttribute("aria-describedby")).toBe(
      "create-resource-form-hint create-resource-form-error",
    );
    expect(doc.activeElement).toBe(formUrlInput);

    // Clearing the custom Form URL text immediately clears the stale unsupported-Form error.
    formUrlInput.value = "";
    formUrlInput.dispatch("input");
    await flush();
    expect(formError.hidden).toBe(true);
    expect(formUrlInput.getAttribute("aria-invalid")).toBeNull();
    expect(formUrlInput.getAttribute("aria-describedby")).toBe("create-resource-form-hint");

    doc.dispatchKey("Escape", { keyCode: 27 });
  });

  test("console mobile brand link and public site nav landmarks, skip target, and mobile .more links meet a11y/touch-target bar", async () => {
    const css = readFileSync(new URL("../console/app.css", import.meta.url), "utf8");
    expect(css).toContain(
      ".brand a {\n    display: inline-flex;\n    align-items: center;\n    min-height: 44px;\n  }",
    );

    const resourcesSource = readFileSync(
      new URL("../console/src/pages/resources.ts", import.meta.url),
      "utf8",
    );
    expect(resourcesSource).toContain('class: "notice notice--bad", role: "alert"');

    const { landingHtml } = await import("../src/landing.ts");
    const enHtml = landingHtml({
      consoleOrigin: "https://console.takoserver.example",
      apiOrigin: "https://api.takoserver.example",
      locale: "en",
    });
    const jaHtml = landingHtml({
      consoleOrigin: "https://console.takoserver.example",
      apiOrigin: "https://api.takoserver.example",
      locale: "ja",
    });
    expect(enHtml).toContain(
      '<nav class="top-nav" aria-label="Primary" data-i18n-aria-label="navPrimary">',
    );
    expect(enHtml).toContain(
      '<nav class="footer-links" aria-label="Resources and links" data-i18n-aria-label="navFooter">',
    );
    expect(jaHtml).toContain(
      '<nav class="top-nav" aria-label="セクション移動" data-i18n-aria-label="navPrimary">',
    );
    expect(jaHtml).toContain(
      '<nav class="footer-links" aria-label="関連リンク" data-i18n-aria-label="navFooter">',
    );
    expect(enHtml).toContain('<main id="main" tabindex="-1">');
    expect(enHtml).toContain(".more a { min-height: 44px; }");
  });
});
