import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { finalizedHostedPlanTable } from "./helpers/finalized-hosted-plan-table.ts";

const SAVED_GLOBALS = [
  "Node",
  "HTMLInputElement",
  "document",
  "window",
  "navigator",
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
  private _disabled = false;
  hidden = false;
  inert = false;

  constructor(
    readonly tag = "text",
    private readonly content = "",
    private readonly ownerDoc?: FakeDocument,
  ) {}

  get disabled(): boolean {
    return this._disabled;
  }

  set disabled(next: boolean) {
    this._disabled = next;
    // Mirror real browsers: disabling the currently focused element blurs it to body.
    if (next && this.ownerDoc?.activeElement === this) {
      this.ownerDoc.activeElement = this.ownerDoc.body;
    }
  }

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

function installFakeDom(pathname = "/"): {
  readonly doc: FakeDocument;
  readonly body: FakeNode;
  readonly root: FakeNode;
  readonly sessionValues: Map<string, string>;
} {
  const localValues = new Map<string, string>();
  const sessionValues = new Map<string, string>();
  const makeStorage = (map: Map<string, string>) => ({
    getItem: (key: string): string | null => map.get(key) ?? null,
    setItem: (key: string, value: string): void => {
      map.set(key, value);
    },
    removeItem: (key: string): void => {
      map.delete(key);
    },
  });
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

  const localStorageObj = makeStorage(localValues);
  const location = new URL(`https://console.example.test${pathname}`);
  Object.assign(globalThis, {
    Node: FakeNode,
    HTMLInputElement: FakeNode,
    localStorage: localStorageObj,
    sessionStorage: makeStorage(sessionValues),
    document: doc,
    navigator: {
      languages: ["en-US"],
      language: "en-US",
      locks: {
        request: async <Value>(
          _name: string,
          _options: unknown,
          callback: () => Value | Promise<Value>,
        ): Promise<Value> => callback(),
      },
    },
    window: {
      location,
      localStorage: localStorageObj,
      addEventListener: winEvents.addEventListener.bind(winEvents),
      removeEventListener: winEvents.removeEventListener.bind(winEvents),
      scrollTo: () => undefined,
      matchMedia: (query: string) => ({
        media: query,
        matches: false,
        addEventListener: () => undefined,
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
  return { doc, body: doc.body, root, sessionValues };
}

async function flush(ticks = 8): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function relativeLuminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * (channels[0] ?? 0) + 0.7152 * (channels[1] ?? 0) + 0.0722 * (channels[2] ?? 0);
}

function contrastRatio(fg: string, bg: string): number {
  const l1 = relativeLuminance(fg);
  const l2 = relativeLuminance(bg);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

describe("Console Wave 5 UI/UX improvements", () => {
  test("sign-in language switch keeps focus, preserves operator draft and open endpoint disclosure, and does not refetch providers", async () => {
    const { doc, root } = installFakeDom("/");
    const state = await import("../console/src/state.ts");
    const { live } = await import("../console/src/dom.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { signInPage } = await import("../console/src/pages/signin.ts");

    consoleLocale.set("en");
    state.setApiOrigin("https://signin-w5.example.test");
    state.sharedAuthAvailable.set(false);
    state.sharedAuthProbeState.set("settled");

    let providerCalls = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/identity/providers") {
          providerCalls += 1;
          return Response.json({
            providers: [{ id: "local", displayName: "Operator", method: "operator-assertion" }],
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    // Mount inside live(...) just like boot()'s outer screen effect in main.ts.
    const host = live(() => signInPage()) as unknown as FakeNode;
    root.append(host);
    await flush();
    expect(providerCalls).toBe(1);

    const textarea = host.all().find((node) => node.id === "assertion");
    const details = host.all().find((node) => node.className === "signin__endpoint");
    const jaBtn = host
      .all()
      .find((node) => node.tag === "button" && node.getAttribute("title") === "日本語");
    const enBtn = host
      .all()
      .find((node) => node.tag === "button" && node.getAttribute("title") === "English");
    if (!textarea || !details || !jaBtn || !enBtn) throw new Error("sign-in controls missing");

    textarea.value = "draft-operator-assertion";
    details.setAttribute("open", "");

    jaBtn.focus();
    jaBtn.click();
    await flush();

    expect(consoleLocale()).toBe("ja");
    expect(providerCalls).toBe(1);
    expect(host.all().includes(jaBtn)).toBe(true);
    expect(doc.activeElement).toBe(jaBtn);
    expect(jaBtn.getAttribute("aria-pressed")).toBe("true");
    expect(enBtn.getAttribute("aria-pressed")).toBe("false");
    expect(textarea.value).toBe("draft-operator-assertion");
    expect(details.getAttribute("open")).toBe("");
    expect(host.textContent).toContain("Takoformで宣言したリソース");
    expect(host.textContent).toContain("API接続先");
    expect(host.textContent).toContain("assertionでサインイン");

    enBtn.focus();
    enBtn.click();
    await flush();

    expect(consoleLocale()).toBe("en");
    expect(providerCalls).toBe(1);
    expect(host.all().includes(enBtn)).toBe(true);
    expect(doc.activeElement).toBe(enBtn);
    expect(enBtn.getAttribute("aria-pressed")).toBe("true");
    expect(textarea.value).toBe("draft-operator-assertion");
    expect(details.getAttribute("open")).toBe("");
    expect(host.textContent).toContain("Manage resources declared through Takoform");
    expect(host.textContent).toContain("API endpoint");

    // Active inline validation errors re-translate in place when toggling JA <-> EN.
    const form = host.all().find((node) => node.tag === "form");
    const assertionError = host.all().find((node) => node.id === "assertion-error");
    const originInput = host.all().find((node) => node.id === "signin-api-origin");
    const originError = host.all().find((node) => node.id === "signin-api-origin-error");
    const saveOriginBtn = details.all().find((node) => node.tag === "button");
    if (!form || !assertionError || !originInput || !originError || !saveOriginBtn) {
      throw new Error("sign-in error controls missing");
    }

    jaBtn.click();
    await flush();
    textarea.value = "";
    form.dispatch("submit");
    originInput.value = "not-a-valid-origin";
    saveOriginBtn.click();
    await flush();
    expect(assertionError.hidden).toBe(false);
    expect(assertionError.textContent).toBe("assertionを貼り付けてください");
    expect(originError.hidden).toBe(false);
    expect(originError.textContent).toContain("有効なHTTP(S)オリジン");

    enBtn.focus();
    enBtn.click();
    await flush();
    expect(doc.activeElement).toBe(enBtn);
    expect(assertionError.hidden).toBe(false);
    expect(assertionError.textContent).toBe("Paste an assertion first");
    expect(originError.hidden).toBe(false);
    expect(originError.textContent).toContain("Enter a valid HTTP(S) origin");

    jaBtn.click();
    await flush();
    expect(assertionError.textContent).toBe("assertionを貼り付けてください");
    expect(originError.textContent).toContain("有効なHTTP(S)オリジン");

    textarea.value = "some-token";
    textarea.dispatch("input");
    originInput.value = "https://valid.example.test";
    originInput.dispatch("input");
    await flush();
    expect(assertionError.hidden).toBe(true);
    expect(originError.hidden).toBe(true);
  });

  test("hostedSubscriptionCard keeps cancel and checkout buttons mounted and focused across async transitions", async () => {
    const { doc, root } = installFakeDom("/");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { navigate } = await import("../console/src/router.ts");
    const { billingPage } = await import("../console/src/pages/billing.ts");

    consoleLocale.set("en");
    navigate("/billing");
    state.setApiOrigin("https://billing-w5.example.test");
    const org = {
      id: "org-bill-w5",
      name: "Billing W5",
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

    const subRef = `sra_${"a".repeat(64)}`;
    let subscriptionProjection: Record<string, unknown> | null = {
      organizationId: org.id,
      subscriptionId: "sub_w5",
      subscriptionRef: subRef,
      planKey: "hosted-10",
      pricingRevision: "rev_w5",
      status: "active",
      cancelAtPeriodEnd: false,
      periodStart: "2026-11-01T00:00:00.000Z",
      periodEnd: "2026-12-01T00:00:00.000Z",
      paidThrough: "2026-12-01T00:00:00.000Z",
      paidFeatures: true,
      updatedAt: "2026-11-28T00:00:00.000Z",
    };
    let resolvePatch!: (response: Response) => void;
    let resolveCheckout!: (response: Response) => void;

    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        if (url.pathname === `/v1/organizations/${org.id}/payments/subscription`) {
          if (method === "PATCH") {
            return new Promise<Response>((resolve) => {
              resolvePatch = resolve;
            });
          }
          if (method === "POST") {
            return new Promise<Response>((resolve) => {
              resolveCheckout = resolve;
            });
          }
          return Promise.resolve(
            Response.json({
              subscription: subscriptionProjection,
              planTable: finalizedHostedPlanTable(),
              billingCapabilities: {
                contractVersion: "hosted-billing-v1",
                topUps: true,
                subscriptionStart: true,
                subscriptionCancellation: true,
                subscriptionPlanChange: true,
              },
            }),
          );
        }
        if (url.pathname === `/v1/organizations/${org.id}/wallet`) {
          return Promise.resolve(
            Response.json({
              wallet: {
                organizationId: org.id,
                currency: "USD",
                settledMicros: "0",
                heldMicros: "0",
                availableMicros: "0",
                frozenMicros: "0",
                refundReceivableMicros: "0",
                entries: [],
              },
            }),
          );
        }
        return Promise.resolve(Response.json({ error: { code: "not_found" } }, { status: 404 }));
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = billingPage(org.id) as unknown as FakeNode;
    root.append(page);
    await flush();

    // 1. Cancellation button stays mounted and focused across idle -> busy -> pending.
    const cancelBtn = page
      .all()
      .find(
        (node) => node.tag === "button" && node.textContent === "Schedule period-end cancellation",
      );
    expect(cancelBtn).toBeDefined();
    if (!cancelBtn) throw new Error("cancel button missing");

    cancelBtn.focus();
    cancelBtn.click();
    await flush();
    expect(page.all().includes(cancelBtn)).toBe(true);
    expect(doc.activeElement).toBe(cancelBtn);
    expect(cancelBtn.getAttribute("aria-busy")).toBe("true");
    expect(cancelBtn.getAttribute("aria-disabled")).toBe("true");

    resolvePatch(
      Response.json(
        { cancellation: { state: "pending", subscriptionRef: subRef } },
        { status: 202 },
      ),
    );
    await flush();
    expect(page.all().includes(cancelBtn)).toBe(true);
    expect(doc.activeElement).toBe(cancelBtn);
    expect(cancelBtn.getAttribute("aria-busy")).toBeNull();
    expect(cancelBtn.getAttribute("aria-disabled")).toBeNull();
    expect(cancelBtn.textContent).toBe("Retry cancellation status");

    // 2. Checkout button stays mounted and focused across idle -> busy -> uncertain.
    subscriptionProjection = null;
    root.replaceChildren();
    const page2 = billingPage(org.id) as unknown as FakeNode;
    root.append(page2);
    await flush();

    const beginBtn = page2
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Begin hosted-10 subscription");
    expect(beginBtn).toBeDefined();
    if (!beginBtn) throw new Error("checkout button missing");

    beginBtn.focus();
    beginBtn.click();
    await flush();
    expect(page2.all().includes(beginBtn)).toBe(true);
    expect(doc.activeElement).toBe(beginBtn);
    expect(beginBtn.getAttribute("aria-busy")).toBe("true");
    expect(beginBtn.getAttribute("aria-disabled")).toBe("true");

    resolveCheckout(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
    await flush();
    expect(page2.all().includes(beginBtn)).toBe(true);
    expect(doc.activeElement).toBe(beginBtn);
    expect(beginBtn.getAttribute("aria-busy")).toBeNull();
    expect(beginBtn.getAttribute("aria-disabled")).toBeNull();
    expect(beginBtn.textContent).toBe("Retry hosted-10 Checkout");
  });

  test("Resources and Keys keep filter status live regions stably mounted, Resources failed operation stacks cleanly as alert, and Keys fixes scopes alignment + Actions header", async () => {
    const { root } = installFakeDom("/");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { navigate } = await import("../console/src/router.ts");
    const { resourcesPage } = await import("../console/src/pages/resources.ts");
    const { keysPage } = await import("../console/src/pages/keys.ts");

    consoleLocale.set("en");
    navigate("/resources?operation=op-fail-1");
    state.setApiOrigin("https://list-w5.example.test");
    const org = {
      id: "org-list-w5",
      name: "List W5",
      ownerPrincipalId: "prn-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    state.organizations.set([org]);
    state.selectOrganization(org.id);

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/apis/forms.takoform.com/v2/operations/op-fail-1") {
          return Response.json({
            id: "op-fail-1",
            resourceUid: "res-1",
            action: "create",
            generation: 1,
            status: "failed",
            effect: "partial",
            createdAt: "2026-11-28T00:00:00.000Z",
            updatedAt: "2026-11-28T00:01:00.000Z",
            retainUntil: "2026-12-28T00:01:00.000Z",
            error: { code: "dependency_conflict", message: "Missing version" },
          });
        }
        if (url.pathname === "/apis/forms.takoform.com/v2/resources") {
          return Response.json({
            items: [
              {
                uid: "res-1",
                form: "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/",
                space: org.id,
                name: "alpha-worker",
                generation: 1,
                observedGeneration: 1,
                observedAt: "2026-11-28T00:00:00.000Z",
                phase: "idle",
                spec: {},
                observed: { ready: true },
                output: {},
                lastOperation: "op-1",
              },
              {
                uid: "res-2",
                form: "https://edge.forms.takoform.com/forms/SQLiteDatabase/0.2.0/",
                space: org.id,
                name: "beta-db",
                generation: 1,
                observedGeneration: 1,
                observedAt: "2026-11-28T00:00:00.000Z",
                phase: "idle",
                spec: {},
                observed: { ready: true },
                output: {},
                lastOperation: "op-2",
              },
            ],
            nextCursor: null,
          });
        }
        if (url.pathname === `/v1/organizations/${org.id}/api-keys`) {
          return Response.json({
            apiKeys: [
              {
                id: "key-1",
                organizationId: org.id,
                name: "Deploy Key",
                scopes: ["resources:write", "wallet:read"],
                createdAt: "2026-10-01T00:00:00.000Z",
                expiresAt: "2027-01-01T00:00:00.000Z",
              },
            ],
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const resPage = resourcesPage(org.id) as unknown as FakeNode;
    root.append(resPage);
    await flush();

    // Failed operation notice uses grid layout and role="alert".
    const failedNotice = resPage
      .all()
      .find(
        (node) => node.className === "notice notice--bad" && node.textContent.includes("Failed"),
      );
    expect(failedNotice).toBeDefined();
    expect(failedNotice?.getAttribute("role")).toBe("alert");
    expect(failedNotice?.style.display).toBe("grid");

    // Resources filter count keeps exact same live-region node exposed in a11y tree across edits.
    const resInput = resPage.all().find((node) => node.id === "resources-filter");
    const resCount = resPage
      .all()
      .find((node) => node.className.split(" ").includes("filter-count"));
    if (!resInput || !resCount) throw new Error("resources filter controls missing");
    expect(resCount.getAttribute("role")).toBe("status");
    expect(resCount.getAttribute("aria-live")).toBe("polite");
    expect(resCount.hidden).toBe(false);
    expect(resCount.className).toBe("filter-count visually-hidden");

    resInput.value = "a";
    resInput.dispatch("input");
    await flush();
    expect(resCount.hidden).toBe(false);
    expect(resCount.className).toBe("filter-count");
    expect(resCount.textContent).toBe("2 of 2");

    resInput.value = "alpha";
    resInput.dispatch("input");
    await flush();
    expect(resPage.all().find((node) => node.className.split(" ").includes("filter-count"))).toBe(
      resCount,
    );
    expect(resCount.textContent).toBe("1 of 2");

    resInput.value = "";
    resInput.dispatch("input");
    await flush();
    expect(resCount.hidden).toBe(false);
    expect(resCount.className).toBe("filter-count visually-hidden");
    expect(resCount.textContent).toBe("");

    // Keys page: live region node stability, .keys-scopes__list class (not inline flex-end), Actions th.
    root.replaceChildren();
    navigate("/keys");
    const kPage = keysPage(org.id) as unknown as FakeNode;
    root.append(kPage);
    await flush();

    const keysInput = kPage.all().find((node) => node.id === "keys-filter");
    const keysCount = kPage
      .all()
      .find((node) => node.className.split(" ").includes("filter-count"));
    if (!keysInput || !keysCount) throw new Error("keys filter controls missing");
    expect(keysCount.hidden).toBe(false);
    expect(keysCount.className).toBe("filter-count visually-hidden");
    keysInput.value = "dep";
    keysInput.dispatch("input");
    await flush();
    expect(keysCount.hidden).toBe(false);
    expect(keysCount.className).toBe("filter-count");
    expect(keysCount.textContent).toBe("1 of 1");
    keysInput.value = "deploy";
    keysInput.dispatch("input");
    await flush();
    expect(kPage.all().find((node) => node.className.split(" ").includes("filter-count"))).toBe(
      keysCount,
    );

    const scopesList = kPage.all().find((node) => node.className === "keys-scopes__list");
    expect(scopesList).toBeDefined();
    expect(scopesList?.style.justifyContent).toBeUndefined();
    const actionsTh = kPage
      .all()
      .find((node) => node.tag === "th" && node.textContent === "Actions");
    expect(actionsTh).toBeDefined();
    expect(actionsTh?.children[0]?.className).toBe("visually-hidden");
  });

  test("hosted continuation error offers Try again, localizes prior prepare state in JA, and modal recovers focus after async refusal", async () => {
    const selector = "b".repeat(64);
    const { doc, root, body, sessionValues } = installFakeDom(
      `/billing/hosted-continuations/${selector}`,
    );
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { hostedBillingContinuationPage } = await import(
      "../console/src/pages/hosted-billing-continuation.ts"
    );
    const { openModal } = await import("../console/src/ui.ts");

    consoleLocale.set("en");
    state.setApiOrigin("https://cont-w5.example.test");

    let getCalls = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === `/v1/billing/hosted-continuations/${selector}`) getCalls += 1;
        return Response.json({ error: { code: "temporarily_unavailable" } }, { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = hostedBillingContinuationPage(selector) as unknown as FakeNode;
    root.append(page);
    await flush();
    expect(getCalls).toBe(1);

    const retryBtn = page
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Try again");
    expect(retryBtn).toBeDefined();
    retryBtn?.click();
    await flush();
    expect(getCalls).toBe(2);

    // Japanese prior-prepare state is localized instead of leaking English.
    consoleLocale.set("ja");
    sessionValues.set(`takoserver.hosted-continuation-prepare:${selector}`, "attempted");
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === `/v1/billing/hosted-continuations/${selector}`) {
          return Response.json({
            continuation: {
              contractVersion: "hosted-browser-v1",
              continuationRef: selector,
              kind: "view",
              workspaceId: "ws-1",
              workspaceRef: "ws-ref-1",
              organizationId: "org-1",
              operation: null,
              phase: null,
            },
          });
        }
        if (url.pathname === "/v1/organizations/org-1/wallet") {
          return Response.json({
            wallet: {
              organizationId: "org-1",
              currency: "USD",
              settledMicros: "0",
              heldMicros: "0",
              availableMicros: "0",
              entries: [],
            },
          });
        }
        return Response.json({
          subscription: null,
          planTable: finalizedHostedPlanTable(),
          billingCapabilities: {
            contractVersion: "hosted-billing-v1",
            topUps: true,
            subscriptionStart: true,
            subscriptionCancellation: true,
            subscriptionPlanChange: true,
          },
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    root.replaceChildren();
    const jaPage = hostedBillingContinuationPage(selector) as unknown as FakeNode;
    root.append(jaPage);
    await flush();
    expect(jaPage.textContent).toContain("前回の準備操作が未確定です");
    expect(jaPage.textContent).not.toContain("A prior prepare attempt is unresolved");

    // Modal confirm restores focus inside dialog when async refusal leaves dialog open.
    consoleLocale.set("en");
    let finishConfirm!: () => void;
    const close = openModal({
      title: "Async refusal test",
      confirmLabel: "Send",
      body: "Body",
      onConfirm: () =>
        new Promise<void>((resolve) => {
          finishConfirm = resolve;
        }),
    });
    const sendBtn = body.all().find((node) => node.tag === "button" && node.textContent === "Send");
    if (!sendBtn) throw new Error("Send button missing");
    sendBtn.focus();
    sendBtn.click();
    // While disabled, focus drops to body (as in real browsers).
    expect(sendBtn.disabled).toBe(true);
    expect(doc.activeElement).toBe(body);

    finishConfirm();
    await flush();
    expect(sendBtn.disabled).toBe(false);
    expect(doc.activeElement).toBe(sendBtn);

    // If a second modal opens while a lower modal's async confirm is in flight,
    // the lower modal's completion must not steal focus from the upper modal.
    let finishLower!: () => void;
    const closeLower = openModal({
      title: "Lower modal",
      confirmLabel: "Lower send",
      body: "Lower body",
      onConfirm: () =>
        new Promise<void>((resolve) => {
          finishLower = resolve;
        }),
    });
    const lowerSend = body
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Lower send");
    if (!lowerSend) throw new Error("Lower send button missing");
    lowerSend.focus();
    lowerSend.click();
    expect(lowerSend.disabled).toBe(true);

    const closeUpper = openModal({
      title: "Upper modal",
      dismissLabel: "Close upper",
      body: "Upper body",
    });
    const upperCloseBtn = body
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Close upper");
    if (!upperCloseBtn) throw new Error("Upper close button missing");
    expect(doc.activeElement).toBe(upperCloseBtn);

    finishLower();
    await flush();
    expect(doc.activeElement).toBe(upperCloseBtn);

    closeUpper();
    closeLower();
    close();
  });

  test("Settings origin hint explains sign-out, Overview retries wallet and spaces refund notice, and CSS fixes contrast + continuation wrapping + mobile targets", async () => {
    const { root } = installFakeDom("/settings");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { settingsPage } = await import("../console/src/pages/settings.ts");
    const { overviewPage } = await import("../console/src/pages/overview.ts");

    const org = {
      id: "org-pol-w5",
      name: "Polish W5",
      ownerPrincipalId: "prn-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    state.setApiOrigin("https://polish-w5.example.test");
    let walletCalls = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === `/v1/organizations/${org.id}/wallet`) {
          walletCalls += 1;
          return Response.json({ error: { code: "temporarily_unavailable" } }, { status: 503 });
        }
        if (url.pathname === "/apis/forms.takoform.com/v2/resources") {
          return Response.json({ items: [], nextCursor: null });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    consoleLocale.set("en");
    const settings = settingsPage(org) as unknown as FakeNode;
    root.append(settings);
    await flush();
    const enHint = settings.all().find((node) => node.id === "settings-api-origin-hint");
    expect(enHint?.textContent).toContain("signs you out of the current session");

    consoleLocale.set("ja");
    await flush();
    const jaHint = settings.all().find((node) => node.id === "settings-api-origin-hint");
    expect(jaHint?.textContent).toContain("現在のセッションからサインアウトします");

    // Overview wallet error provides Try again button.
    consoleLocale.set("en");
    root.replaceChildren();
    const overview = overviewPage(org) as unknown as FakeNode;
    root.append(overview);
    await flush();
    expect(walletCalls).toBe(1);
    const walletRetry = overview
      .all()
      .find((node) => node.tag === "button" && node.textContent.includes("Try again"));
    expect(walletRetry).toBeDefined();
    walletRetry?.click();
    await flush();
    expect(walletCalls).toBe(2);

    // CSS checks: light --ink-4 >= 3:1 on surface-0 & surface-2, continuation dl wrap, desktop/mobile scopes, mobile standalone link targets.
    const css = readFileSync(new URL("../console/app.css", import.meta.url), "utf8");
    const lightRoot = css.slice(css.indexOf(":root {"), css.indexOf("}", css.indexOf(":root {")));
    const ink4Match = /--ink-4:\s*(#[0-9a-f]{6})/iu.exec(lightRoot);
    expect(ink4Match).not.toBeNull();
    const lightInk4 = ink4Match?.[1] ?? "#000000";
    expect(contrastRatio(lightInk4, "#ffffff")).toBeGreaterThanOrEqual(3.0);
    expect(contrastRatio(lightInk4, "#f6f6f7")).toBeGreaterThanOrEqual(3.0);

    expect(css).toContain(".btn[hidden],\n[hidden] {\n  display: none;\n}");
    expect(css).toContain(".hosted-continuation__facts dd {");
    expect(css).toContain("overflow-wrap: anywhere;");
    expect(css).toContain(".keys-scopes__list {");
    expect(css).toContain(".keys-table .keys-scopes__list {\n    justify-content: flex-end;\n  }");
    expect(css).toContain(".wallet-card__notice {");
    expect(css).toContain(".head__text > .dim > a,");
    expect(css).toContain(
      ".published a,\n  .row__value > a,\n  .ref a {\n    display: inline-block;",
    );
  });

  test("topbar sign-out button stays stably mounted and keeps focus when principal resolves or locale toggles", async () => {
    const { doc, root } = installFakeDom("/settings");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");

    consoleLocale.set("en");
    state.setApiOrigin("https://topbar-w5.example.test");
    state.adoptSession("legacy");

    let resolveMe!: (response: Response) => void;
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/me") {
          return new Promise<Response>((resolve) => {
            resolveMe = resolve;
          });
        }
        return Promise.resolve(Response.json({ error: { code: "not_found" } }, { status: 404 }));
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    await import("../console/src/main.ts");
    await flush();

    const signOutBtn = root
      .all()
      .find(
        (node) =>
          node.tag === "button" && (node.getAttribute("aria-label") ?? "").includes("Sign out"),
      );
    expect(signOutBtn).toBeDefined();
    if (!signOutBtn) throw new Error("topbar sign-out button missing");

    signOutBtn.focus();
    expect(doc.activeElement).toBe(signOutBtn);

    resolveMe(
      Response.json({
        principal: {
          id: "prn-w5",
          provider: "local",
          email: "owner@example.test",
          displayName: "Wave 5 Owner",
        },
        organizations: [
          {
            id: "org-w5",
            name: "Alpha",
            ownerPrincipalId: "prn-w5",
            createdAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
    );
    await flush();

    expect(root.all().includes(signOutBtn)).toBe(true);
    expect(doc.activeElement).toBe(signOutBtn);
    expect(signOutBtn.getAttribute("aria-label")).toBe("Wave 5 Owner — sign out");
    expect(signOutBtn.textContent).toBe("Wave 5 Owner");

    consoleLocale.set("ja");
    await flush();
    expect(root.all().includes(signOutBtn)).toBe(true);
    expect(doc.activeElement).toBe(signOutBtn);
    expect(signOutBtn.getAttribute("aria-label")).toBe("Wave 5 Owner — サインアウト");
  });
});
