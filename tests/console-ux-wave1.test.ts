import { afterEach, describe, expect, test } from "bun:test";
import { effect, signal, untrack } from "../console/src/reactive.ts";

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
  disabled = false;
  hidden = false;
  inert = false;

  constructor(
    readonly tag = "text",
    private readonly content = "",
    private readonly ownerDoc?: FakeDocument,
  ) {}

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
    }
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
    if (name === "disabled") this.disabled = true;
    if (name === "hidden") this.hidden = true;
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

  dispatch(type: string, event: Record<string, unknown> = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener({
        target: this,
        preventDefault() {},
        stopPropagation() {},
        ...event,
      } as unknown as Event);
    }
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
  const doc: FakeDocument = {
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
      let prevented = false;
      docEvents.dispatch("keydown", {
        key,
        preventDefault() {
          prevented = true;
        },
        ...extra,
      });
      return prevented;
    },
  };
  doc.body = new FakeNode("body", "", doc);
  doc.documentElement = new FakeNode("html", "", doc);
  const root = new FakeNode("div", "", doc);
  root.setAttribute("id", "root");
  doc.body.append(root);

  Object.assign(globalThis, {
    Node: FakeNode,
    HTMLInputElement: FakeNode,
    localStorage: storage,
    sessionStorage: storage,
    document: doc,
    window: {
      location: new URL(`https://console.example.test${pathname}`),
      addEventListener: () => undefined,
      history: {
        pushState: () => undefined,
        replaceState: () => undefined,
      },
    },
  });
  return { doc, body: doc.body, root };
}

async function flush(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

describe("Console Wave 1 UI/UX improvements", () => {
  test("untrack reads a signal without subscribing the enclosing effect", async () => {
    const tracked = signal(1);
    const untracked = signal("a");
    let runs = 0;
    const stop = effect(() => {
      runs += 1;
      tracked();
      untrack(() => untracked());
    });
    expect(runs).toBe(1);
    untracked.set("b");
    await flush(2);
    expect(runs).toBe(1);
    tracked.set(2);
    await flush(2);
    expect(runs).toBe(2);
    stop();
  });

  test("openModal traps Tab/Shift+Tab, marks background inert, and restores focus on Escape", async () => {
    const { doc, root } = installFakeDom("/");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { openModal } = await import("../console/src/ui.ts");
    consoleLocale.set("en");

    const trigger = doc.createElement("button");
    trigger.append("Open dialog");
    root.append(trigger);
    trigger.focus();
    expect(doc.activeElement).toBe(trigger);

    const input = doc.createElement("input");
    input.setAttribute("id", "modal-input");
    openModal({
      title: "Sample Dialog",
      body: input as unknown as HTMLElement,
      confirmLabel: "Save",
      onConfirm: () => undefined,
    });

    const dialog = doc.body.all().find((node) => node.getAttribute("role") === "dialog");
    expect(dialog).toBeDefined();
    expect(dialog?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(root.inert).toBe(true);
    expect(doc.activeElement).toBe(input);

    // Shift+Tab from first focusable wraps to Save button (last focusable inside modal).
    const shiftPrevented = doc.dispatchKey("Tab", { shiftKey: true });
    expect(shiftPrevented).toBe(true);
    expect(doc.activeElement?.textContent).toBe("Save");

    // Tab from last focusable wraps back to input (first focusable inside modal).
    const tabPrevented = doc.dispatchKey("Tab", { shiftKey: false });
    expect(tabPrevented).toBe(true);
    expect(doc.activeElement).toBe(input);

    // Escape closes dialog, clears inert on background, and restores focus to trigger.
    doc.dispatchKey("Escape");
    expect(root.inert).toBe(false);
    expect(doc.body.all().find((node) => node.getAttribute("role") === "dialog")).toBeUndefined();
    expect(doc.activeElement).toBe(trigger);
  });

  test("normalizeApiOrigin accepts bare HTTP(S) origins and rejects invalid inputs", async () => {
    installFakeDom("/signin");
    const { normalizeApiOrigin } = await import("../console/src/state.ts");
    expect(normalizeApiOrigin("https://api.example.com/")).toBe("https://api.example.com");
    expect(normalizeApiOrigin("http://127.0.0.1:8787///")).toBe("http://127.0.0.1:8787");
    expect(normalizeApiOrigin("not-a-url")).toBeNull();
    expect(normalizeApiOrigin("javascript:alert(1)")).toBeNull();
    expect(normalizeApiOrigin("https://api.example.com/v1")).toBeNull();
    expect(normalizeApiOrigin("https://user:pass@api.example.com")).toBeNull();
  });

  test("sign-in hides contradictory empty-provider warning when shared auth is available, retries both probes on error, and rejects invalid origin", async () => {
    const { root } = installFakeDom("/signin");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { mountToasts } = await import("../console/src/ui.ts");
    const { signInPage } = await import("../console/src/pages/signin.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://api.example.test");
    state.sharedAuthAvailable.set(true);

    let failProviders = false;
    const requested: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        requested.push(url.pathname);
        if (url.pathname === "/v1/identity/providers") {
          return failProviders
            ? Response.json({ error: { code: "unavailable" } }, { status: 503 })
            : Response.json({ providers: [] });
        }
        if (url.pathname === "/auth/oidc/session") {
          return Response.json({ authenticated: false }, { status: 401 });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    root.append(mountToasts() as unknown as FakeNode);
    const page = signInPage() as unknown as FakeNode;
    root.append(page);
    await flush();

    // Shared auth available + empty providers => no contradictory notice.
    expect(page.textContent).toContain("Continue with Takos account");
    expect(page.textContent).not.toContain("No identity provider is configured");

    // Invalid endpoint Save does not clear or overwrite apiOrigin.
    const originInput = page.all().find((node) => node.id === "signin-api-origin");
    const saveButton = page
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Save");
    expect(originInput).toBeDefined();
    expect(saveButton).toBeDefined();
    if (originInput && saveButton) {
      originInput.value = "not-a-valid-url";
      saveButton.click();
      expect(state.apiOrigin()).toBe("https://api.example.test");
      expect(root.textContent).toContain("Enter a valid HTTP(S) origin");
    }

    // Error state exposes Retry button that re-probes BOTH providers and shared-auth session.
    failProviders = true;
    const errorPage = signInPage() as unknown as FakeNode;
    root.append(errorPage);
    await flush();
    const retryButton = errorPage
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Retry");
    expect(retryButton).toBeDefined();

    requested.length = 0;
    failProviders = false;
    retryButton?.click();
    await flush();
    expect(requested).toContain("/v1/identity/providers");
    expect(requested).toContain("/auth/oidc/session");
  });

  test("/resources filter keeps the input node stable, triggers zero refetches, and supports Clear", async () => {
    const { doc, root } = installFakeDom("/resources");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { resourcesPage } = await import("../console/src/pages/resources.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://api.example.test");
    state.adoptSession("shared-auth");
    state.organizations.set([
      {
        id: "org-1",
        name: "Alpha",
        ownerPrincipalId: "pri-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    state.selectOrganization("org-1");

    let resourceListCalls = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/apis/forms.takoform.com/v2/resources") {
          resourceListCalls += 1;
          return Response.json({
            items: [
              {
                uid: "uid-1",
                form: "https://takoform.com/forms/ModuleWorker/v1",
                space: "org-1",
                name: "alpha-worker",
                generation: 1,
                observedGeneration: 1,
                observedAt: "2026-11-27T00:00:00.000Z",
                phase: "idle",
                spec: {},
                observed: { ready: true },
                output: {},
                lastOperation: "op-1",
              },
              {
                uid: "uid-2",
                form: "https://takoform.com/forms/ObjectBucket/v1",
                space: "org-1",
                name: "media-bucket",
                generation: 1,
                observedGeneration: 1,
                observedAt: "2026-11-27T00:00:00.000Z",
                phase: "idle",
                spec: {},
                observed: {},
                output: {},
                lastOperation: "op-2",
              },
            ],
            nextCursor: null,
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = resourcesPage("org-1") as unknown as FakeNode;
    root.append(page);
    await flush();

    const input = page.all().find((node) => node.id === "resources-filter");
    expect(input).toBeDefined();
    if (!input) throw new Error("resources-filter input missing");
    expect(resourceListCalls).toBe(1);
    input.focus();
    input.value = "alpha";
    input.dispatch("input");
    await flush();

    // Same DOM element stays focused and no extra network fetch happened.
    expect(doc.activeElement).toBe(input);
    expect(resourceListCalls).toBe(1);
    expect(page.textContent).toContain("alpha-worker");
    expect(page.textContent).not.toContain("media-bucket");

    // Clear button resets filter and restores focus to input.
    const clearBtn = page
      .all()
      .find((node) => node.tag === "button" && node.getAttribute("aria-label") === "Clear filter");
    expect(clearBtn).toBeDefined();
    clearBtn?.click();
    await flush();
    expect(input.value).toBe("");
    expect(doc.activeElement).toBe(input);
    expect(page.textContent).toContain("media-bucket");
  });

  test("createResource bounds support probes to 4, disables Create when all Forms are unsupported, and has no unassociated Space label", async () => {
    const { body } = installFakeDom("/resources");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { createResource } = await import("../console/src/pages/create-resource.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://api.example.test");
    state.adoptSession("shared-auth");
    state.organizations.set([
      {
        id: "org-1",
        name: "Alpha",
        ownerPrincipalId: "pri-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    state.selectOrganization("org-1");

    let activeProbes = 0;
    let maxActiveProbes = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/apis/forms.takoform.com/v2/support") {
          activeProbes += 1;
          maxActiveProbes = Math.max(maxActiveProbes, activeProbes);
          await new Promise<void>((resolve) => setTimeout(resolve, 2));
          activeProbes -= 1;
          const form = url.searchParams.get("form") ?? "";
          return Response.json({ form, supported: false, operations: [] });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    createResource("org-1");
    await new Promise<void>((resolve) => setTimeout(resolve, 80));

    expect(maxActiveProbes).toBeGreaterThan(0);
    expect(maxActiveProbes).toBeLessThanOrEqual(4);

    // Confirm button is disabled when all known Forms are unsupported.
    const createBtn = body
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Create");
    expect(createBtn?.disabled).toBe(true);
    expect(body.textContent).toContain("None of the known Forms are enabled on this Host");
    expect(
      body.all().some((node) => node.tag === "button" && node.textContent === "Check again"),
    ).toBe(true);

    // No unassociated <label> for Space.
    const unassocLabels = body
      .all()
      .filter((node) => node.tag === "label" && !node.getAttribute("for"));
    expect(unassocLabels).toHaveLength(0);
  });

  test("billing shows calm unavailable notices on 404 for optional usage-summary and subscription routes", async () => {
    const { root } = installFakeDom("/billing");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { billingPage } = await import("../console/src/pages/billing.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://api.example.test");
    state.adoptSession("shared-auth");
    state.organizations.set([
      {
        id: "org-1",
        name: "Alpha",
        ownerPrincipalId: "pri-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    state.selectOrganization("org-1");

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/organizations/org-1/wallet") {
          return Response.json({
            wallet: {
              organizationId: "org-1",
              currency: "USD",
              settledMicros: "1000000",
              heldMicros: "0",
              availableMicros: "1000000",
              entries: [],
            },
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = billingPage("org-1") as unknown as FakeNode;
    root.append(page);
    await flush(10);

    expect(page.textContent).toContain("Not enabled on this Host");
    expect(page.textContent).toContain("Subscription management is not enabled on this Host.");
    expect(page.textContent).not.toContain("does not exist or does not belong");
  });

  test("settings exposes aria-pressed on appearance/language toggles and hostCard updates heading on locale change without refetching", async () => {
    const { root } = installFakeDom("/settings");
    const state = await import("../console/src/state.ts");
    const { consoleLocale, setConsoleLocale } = await import("../console/src/i18n.ts");
    const { hostCard, settingsPage } = await import("../console/src/pages/settings.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://api.example.test");

    let discoveryCalls = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/.well-known/takoserver") {
          discoveryCalls += 1;
          return Response.json({ endpoints: {} });
        }
        if (url.pathname.endsWith("/support")) {
          const form = url.searchParams.get("form") ?? "";
          return Response.json({ form, supported: false, operations: [] });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const card = hostCard("org-1") as unknown as FakeNode;
    root.append(card);
    await flush();
    expect(card.textContent).toContain("This Host");
    expect(discoveryCalls).toBe(1);

    setConsoleLocale("ja");
    await flush();
    expect(card.textContent).toContain("このHost");
    expect(discoveryCalls).toBe(1);

    const page = settingsPage({
      id: "org-1",
      name: "Alpha",
      ownerPrincipalId: "pri-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as FakeNode;
    const pressedButtons = page
      .all()
      .filter((node) => node.tag === "button" && node.getAttribute("aria-pressed") !== null);
    expect(pressedButtons).toHaveLength(5);
  });

  test("API keys Revoke buttons expose descriptive aria-label naming each key", async () => {
    const { root } = installFakeDom("/keys");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { keysPage } = await import("../console/src/pages/keys.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://api.example.test");
    state.adoptSession("shared-auth");
    state.organizations.set([
      {
        id: "org-1",
        name: "Alpha",
        ownerPrincipalId: "pri-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    state.selectOrganization("org-1");

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/organizations/org-1/api-keys") {
          return Response.json({
            apiKeys: [
              {
                id: "key-1",
                organizationId: "org-1",
                name: "ci-runner",
                scopes: ["resources:read"],
                createdAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2027-01-01T00:00:00.000Z",
              },
            ],
          });
        }
        return Response.json({ endpoints: {} });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = keysPage("org-1") as unknown as FakeNode;
    root.append(page);
    await flush();

    const revoke = page
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Revoke");
    expect(revoke?.getAttribute("aria-label")).toBe("Revoke ci-runner");
  });

  test("signInPage probes shared auth on mount after expiry/origin change and never sticks on skeleton on 5xx", async () => {
    const { root } = installFakeDom("/signin");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { settingsPage } = await import("../console/src/pages/settings.ts");
    const { signInPage } = await import("../console/src/pages/signin.ts");
    consoleLocale.set("en");

    // 1) Session expiry / unprobed state with 5xx shared-auth probe + empty providers:
    // must show loading skeleton only while probing, then settle to error notice with Retry.
    state.setApiOrigin("https://expiry.example.test");
    state.sharedAuthAvailable.set(null);
    state.sharedAuthProbeState.set("idle");

    let resolveProbe!: (response: Response) => void;
    let probeStatus = 503;
    const requested: string[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        requested.push(`${url.origin}${url.pathname}`);
        if (url.pathname === "/v1/identity/providers") {
          return Response.json({ providers: [] });
        }
        if (url.pathname === "/auth/oidc/session") {
          if (probeStatus === 0) {
            return new Promise<Response>((resolve) => {
              resolveProbe = resolve;
            });
          }
          return probeStatus === 404
            ? Response.json({ error: { code: "not_found" } }, { status: 404 })
            : Response.json({ error: { code: "unavailable" } }, { status: probeStatus });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    probeStatus = 0;
    const page = signInPage() as unknown as FakeNode;
    root.append(page);
    await flush();
    expect(requested).toContain("https://expiry.example.test/auth/oidc/session");
    expect(page.all().some((node) => node.className === "skeleton")).toBe(true);

    // Probe returns 503 -> skeleton clears and Retry notice appears.
    resolveProbe(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
    await flush();
    expect(page.all().some((node) => node.className === "skeleton")).toBe(false);
    expect(page.textContent).toContain("Couldn't check sign-in availability");
    const retryBtn = page
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Retry");
    expect(retryBtn).toBeDefined();

    // Retry when shared auth is unavailable (404) -> settles to unconfigured warning (no skeleton).
    probeStatus = 404;
    retryBtn?.click();
    await flush();
    expect(page.all().some((node) => node.className === "skeleton")).toBe(false);
    expect(page.textContent).toContain("No identity provider is configured");

    // 2) Settings origin change triggers shared-auth re-probe cleanly and ignores IME Enter.
    requested.length = 0;
    const settings = settingsPage({
      id: "org-1",
      name: "Alpha",
      ownerPrincipalId: "pri-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    }) as unknown as FakeNode;
    root.replaceChildren(settings);
    const settingsInput = settings.all().find((node) => node.id === "settings-api-origin");
    expect(settingsInput).toBeDefined();
    if (settingsInput) {
      settingsInput.value = "https://other.example.test";
      settingsInput.dispatch("keydown", { key: "Enter", isComposing: true });
      settingsInput.dispatch("keydown", { key: "Enter", keyCode: 229 });
      expect(state.apiOrigin()).toBe("https://expiry.example.test");
      settingsInput.dispatch("keydown", { key: "Enter", isComposing: false, keyCode: 13 });
      await flush();
      expect(state.apiOrigin()).toBe("https://other.example.test");
      expect(requested).toContain("https://other.example.test/auth/oidc/session");
      expect(state.sharedAuthAvailable()).toBe(false);
    }
  });

  test("openModal keeps toast host non-inert, ref-counts stacked modals, and skips closed <details> in focus trap", async () => {
    const { doc, body, root } = installFakeDom("/");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { mountToasts, openModal, toast } = await import("../console/src/ui.ts");
    consoleLocale.set("en");

    const toasts = mountToasts() as unknown as FakeNode;
    body.append(toasts);
    const preInert = doc.createElement("div");
    preInert.inert = true;
    body.append(preInert);

    const trigger = doc.createElement("button");
    trigger.append("Open A");
    root.append(trigger);
    trigger.focus();

    const bodyA = doc.createElement("div");
    const closedDetails = doc.createElement("details");
    const summary = doc.createElement("summary");
    summary.append("More");
    const hiddenBtn = doc.createElement("button");
    hiddenBtn.append("Hidden inside details");
    closedDetails.append(summary, hiddenBtn);
    const inputA = doc.createElement("input");
    bodyA.append(closedDetails, inputA);

    openModal({
      title: "Modal A",
      body: bodyA as unknown as HTMLElement,
      confirmLabel: "Save A",
      onConfirm: () => undefined,
    });

    const scrimA = body.children.find((node) => node.className === "scrim");
    expect(scrimA).toBeDefined();
    expect(root.inert).toBe(true);
    expect(preInert.inert).toBe(true);
    expect(toasts.inert).toBe(false);
    toast("Modal error notice", "bad");
    expect(toasts.textContent).toContain("Modal error notice");

    // Initial focus skips hiddenBtn inside closed <details> and lands on summary (first visible focusable).
    expect(doc.activeElement).toBe(summary);
    // Focus trap never lands on hiddenBtn inside closed <details>.
    const seenFocused = new Set<FakeNode | null>();
    for (let i = 0; i < 6; i += 1) {
      seenFocused.add(doc.activeElement);
      doc.dispatchKey("Tab", { shiftKey: false });
    }
    expect(seenFocused.has(hiddenBtn)).toBe(false);

    // Open stacked Modal B on top of Modal A.
    const inputB = doc.createElement("input");
    openModal({
      title: "Modal B",
      body: inputB as unknown as HTMLElement,
      confirmLabel: "Save B",
      onConfirm: () => undefined,
    });
    expect(scrimA?.inert).toBe(true);
    expect(root.inert).toBe(true);
    expect(preInert.inert).toBe(true);
    expect(toasts.inert).toBe(false);
    expect(doc.activeElement).toBe(inputB);

    // First Escape closes only Modal B; Modal A becomes active again while root stays inert.
    doc.dispatchKey("Escape");
    expect(body.all().filter((node) => node.getAttribute("role") === "dialog")).toHaveLength(1);
    expect(scrimA?.inert).toBe(false);
    expect(root.inert).toBe(true);
    expect(preInert.inert).toBe(true);
    expect(toasts.inert).toBe(false);

    // Second Escape closes Modal A; root restores inert=false, preInert stays inert=true.
    doc.dispatchKey("Escape");
    expect(body.all().filter((node) => node.getAttribute("role") === "dialog")).toHaveLength(0);
    expect(root.inert).toBe(false);
    expect(preInert.inert).toBe(true);
    expect(toasts.inert).toBe(false);
    expect(doc.activeElement).toBe(trigger);
  });

  test("createResource re-enables Confirm for custom URL, clears stale migration note on retry, and aborts probes on close", async () => {
    const { doc, body } = installFakeDom("/resources");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { createResource } = await import("../console/src/pages/create-resource.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://api.example.test");
    state.adoptSession("shared-auth");
    state.organizations.set([
      {
        id: "org-1",
        name: "Alpha",
        ownerPrincipalId: "pri-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    state.selectOrganization("org-1");

    let supportedAnswer = false;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/apis/forms.takoform.com/v2/support") {
          const form = url.searchParams.get("form") ?? "";
          return Response.json({
            form,
            supported: supportedAnswer,
            operations: supportedAnswer ? ["create"] : [],
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    createResource("org-1");
    await flush(12);

    const createBtn = body
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Create");
    const formSelect = body.all().find((node) => node.id === "create-resource-form");
    const formUrlInput = body.all().find((node) => node.id === "create-resource-form-url");
    expect(createBtn?.disabled).toBe(true);
    expect(body.textContent).toContain("SQLiteMigrationSet");

    // Switching to "other" immediately re-enables Confirm and reveals URL input.
    if (formSelect) {
      formSelect.value = "other";
      formSelect.dispatch("change");
      await flush(2);
    }
    expect(createBtn?.disabled).toBe(false);
    expect(formUrlInput?.hidden).toBe(false);

    // Switching back to empty and clicking "Check again" when supported clears stale migration note.
    if (formSelect) {
      formSelect.value = "";
      formSelect.dispatch("change");
      await flush(2);
    }
    const checkAgain = body
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Check again");
    expect(checkAgain).toBeDefined();
    supportedAnswer = true;
    checkAgain?.click();
    await flush(12);
    expect(createBtn?.disabled).toBe(false);
    expect(body.textContent).not.toContain("SQLiteMigrationSet, and on a Host that runs Workers");
    doc.dispatchKey("Escape");

    // Closing mid-probe aborts in-flight probe signals cleanly.
    const signals: AbortSignal[] = [];
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        if (init?.signal) signals.push(init.signal);
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    createResource("org-1");
    await flush(2);
    expect(signals.length).toBeGreaterThan(0);
    expect(signals.every((sig) => !sig.aborted)).toBe(true);
    doc.dispatchKey("Escape");
    await flush(2);
    expect(signals.every((sig) => sig.aborted)).toBe(true);
  });

  test("billing still shows Try again notice on 500 errors for optional routes", async () => {
    const { root } = installFakeDom("/billing");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { billingPage } = await import("../console/src/pages/billing.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://api.example.test");
    state.adoptSession("shared-auth");
    state.organizations.set([
      {
        id: "org-1",
        name: "Alpha",
        ownerPrincipalId: "pri-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    state.selectOrganization("org-1");

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/organizations/org-1/wallet") {
          return Response.json({
            wallet: {
              organizationId: "org-1",
              currency: "USD",
              settledMicros: "1000000",
              heldMicros: "0",
              availableMicros: "1000000",
              entries: [],
            },
          });
        }
        return Response.json({ error: { code: "temporarily_unavailable" } }, { status: 500 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = billingPage("org-1") as unknown as FakeNode;
    root.append(page);
    await flush(10);

    expect(page.textContent).not.toContain("Not enabled on this Host");
    const retryButtons = page
      .all()
      .filter((node) => node.tag === "button" && node.textContent === "Try again");
    expect(retryButtons.length).toBeGreaterThanOrEqual(2);
  });

  test("shell mounts toasts on body, keeps #topbar-organization focus stable, and guards createOrganization Enter against IME and duplicate POSTs", async () => {
    const { doc, body, root } = installFakeDom("/");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://api.example.test");
    state.sharedAuthAvailable.set(false);
    state.adoptSession("legacy");

    let postCount = 0;
    let resolveCreate!: (response: Response) => void;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = (init?.method ?? "GET").toUpperCase();
        if (url.pathname === "/v1/me") {
          return Response.json({
            principal: {
              id: "pri-1",
              provider: "local",
              email: "owner@example.test",
              displayName: "Owner",
            },
            organizations: [
              {
                id: "org-1",
                name: "Alpha",
                ownerPrincipalId: "pri-1",
                createdAt: "2026-01-01T00:00:00.000Z",
              },
              {
                id: "org-2",
                name: "Beta",
                ownerPrincipalId: "pri-1",
                createdAt: "2026-01-02T00:00:00.000Z",
              },
            ],
          });
        }
        if (url.pathname === "/v1/organizations" && method === "POST") {
          postCount += 1;
          return new Promise<Response>((resolve) => {
            resolveCreate = resolve;
          });
        }
        return Response.json({ items: [], nextCursor: null });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    await import("../console/src/main.ts");
    await flush(10);

    // Toasts are mounted on document.body outside #root.
    const toasts = body.children.find((node) => node.className === "toasts");
    expect(toasts).toBeDefined();
    expect(root.contains(toasts ?? null)).toBe(false);

    // Switching organization keeps the exact #topbar-organization node focused.
    const select = root.all().find((node) => node.id === "topbar-organization");
    expect(select).toBeDefined();
    if (!select) throw new Error("#topbar-organization missing");
    select.focus();
    select.value = "org-2";
    select.dispatch("change");
    await flush(4);
    expect(root.all().find((node) => node.id === "topbar-organization")).toBe(select);
    expect(doc.activeElement).toBe(select);
    expect(state.currentOrganizationId()).toBe("org-2");

    // Open Create Organization modal.
    const openCreateBtn = root
      .all()
      .find(
        (node) =>
          node.tag === "button" && node.getAttribute("aria-label") === "Create organization",
      );
    expect(openCreateBtn).toBeDefined();
    openCreateBtn?.click();
    await flush(2);
    expect(toasts?.inert).toBe(false);
    expect(root.inert).toBe(true);

    const orgInput = body.all().find((node) => node.id === "create-organization-name");
    const confirmBtn = body
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Create");
    expect(orgInput).toBeDefined();
    expect(confirmBtn).toBeDefined();
    if (!orgInput || !confirmBtn) throw new Error("create organization modal controls missing");

    orgInput.value = "Gamma";
    // Enter during IME composition must be ignored.
    orgInput.dispatch("keydown", { key: "Enter", isComposing: true });
    orgInput.dispatch("keydown", { key: "Enter", keyCode: 229 });
    await flush(2);
    expect(postCount).toBe(0);

    // Rapid double-Enter + immediate Confirm click issues only a single POST,
    // and Confirm becomes disabled on the reactive flush.
    orgInput.dispatch("keydown", { key: "Enter", isComposing: false, keyCode: 13 });
    orgInput.dispatch("keydown", { key: "Enter", isComposing: false, keyCode: 13 });
    confirmBtn.click();
    await flush(2);
    expect(confirmBtn.disabled).toBe(true);
    expect(postCount).toBe(1);

    resolveCreate(
      Response.json(
        {
          organization: {
            id: "org-3",
            name: "Gamma",
            ownerPrincipalId: "pri-1",
            createdAt: "2026-01-03T00:00:00.000Z",
          },
        },
        { status: 201 },
      ),
    );
    await flush(6);
    expect(state.currentOrganizationId()).toBe("org-3");
    expect(body.all().filter((node) => node.getAttribute("role") === "dialog")).toHaveLength(0);
    expect(root.inert).toBe(false);
  });
});
