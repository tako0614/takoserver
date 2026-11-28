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
  disabled = false;
  hidden = false;
  inert = false;
  isContentEditable = false;

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

  select(): void {}

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
  readonly windowKeydownCount: () => number;
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
    windowKeydownCount: () => (winEvents.listeners.get("keydown") ?? []).length,
  };
}

async function flush(ticks = 6): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
}

function cssBlock(css: string, selector: string, within?: string): string {
  const source = within ? css.slice(css.indexOf(within)) : css;
  const start = source.indexOf(`${selector} {`);
  if (start < 0) throw new Error(`missing CSS block ${selector}`);
  return source.slice(start, source.indexOf("}", start));
}

describe("Console Wave 3 UI/UX improvements", () => {
  test("a dialog that opts out of backdrop dismissal survives a stray click but still closes on Escape", async () => {
    const { doc, root } = installFakeDom("/keys");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { openModal } = await import("../console/src/ui.ts");
    consoleLocale.set("en");
    const main = doc.createElement("main");
    main.setAttribute("id", "main-content");
    root.append(main);

    const dialogs = () => doc.body.all().filter((node) => node.getAttribute("role") === "dialog");
    const scrim = () => doc.body.children.find((node) => node.className === "scrim");

    openModal({ title: "Copy this key now", body: "secret", dismissOnBackdrop: false });
    expect(dialogs()).toHaveLength(1);
    scrim()?.dispatch("click");
    expect(dialogs()).toHaveLength(1);
    // A click inside the dialog is never a dismissal either.
    dialogs()[0]?.dispatch("click");
    expect(dialogs()).toHaveLength(1);
    doc.dispatchKey("Escape", { keyCode: 27 });
    expect(dialogs()).toHaveLength(0);

    // Ordinary dialogs keep closing on a backdrop click, unless the pointer
    // started inside the dialog (dragging a text selection out onto the scrim).
    openModal({ title: "Revoke key?", body: "sure?" });
    expect(dialogs()).toHaveLength(1);
    dialogs()[0]?.dispatch("pointerdown");
    scrim()?.dispatch("click");
    expect(dialogs()).toHaveLength(1);
    scrim()?.dispatch("pointerdown");
    scrim()?.dispatch("click");
    expect(dialogs()).toHaveLength(0);
  });

  test("the key secret dialog opts out of backdrop dismissal and makes its shell block keyboard-scrollable", () => {
    const source = readFileSync(new URL("../console/src/pages/keys.ts", import.meta.url), "utf8");
    const reveal = source.slice(source.indexOf("function revealSecret("));
    expect(reveal).toContain("dismissOnBackdrop: false");
    expect(reveal).toContain('tabindex: "0"');
  });

  test("page-level empty states carry the page's one h1, others keep a plain title", async () => {
    installFakeDom("/");
    const { empty } = await import("../console/src/ui.ts");
    const page = empty("No such page", "Nothing is served here.", null, {
      heading: true,
    }) as unknown as FakeNode;
    const title = page.all().find((node) => node.className === "empty__title");
    expect(title?.tag).toBe("h1");
    expect(title?.textContent).toBe("No such page");

    const inline = empty("No keys", "Create one.") as unknown as FakeNode;
    expect(inline.all().find((node) => node.className === "empty__title")?.tag).toBe("div");

    const main = readFileSync(new URL("../console/src/main.ts", import.meta.url), "utf8");
    expect(main.match(/\{ heading: true \}/g)?.length).toBe(3);
    const detail = readFileSync(
      new URL("../console/src/pages/resource-detail.ts", import.meta.url),
      "utf8",
    );
    expect(detail).toContain("{ heading: true }");
    expect(detail).toContain(
      'h("h1", { class: "visually-hidden" }, tr("リソース詳細", "Resource"))',
    );
  });

  test("loading skeletons announce themselves while their bars stay decorative", async () => {
    installFakeDom("/");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { skeletonRows } = await import("../console/src/ui.ts");
    consoleLocale.set("en");
    const region = skeletonRows(3) as unknown as FakeNode;
    expect(region.getAttribute("role")).toBe("status");
    expect(region.getAttribute("aria-busy")).toBe("true");
    expect(region.textContent).toBe("Loading…");
    const bars = region.all().filter((node) => node.className === "skeleton");
    expect(bars).toHaveLength(3);
    for (const bar of bars) expect(bar.getAttribute("aria-hidden")).toBe("true");
  });

  test("an unreadable answer and a failing Host are not described as refusals", async () => {
    installFakeDom("/");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { ApiError } = await import("../console/src/api.ts");
    const { explain } = await import("../console/src/ui.ts");
    consoleLocale.set("en");
    const unreadable = explain(new ApiError("invalid_response", 200, "/v1/me"));
    expect(unreadable).toStartWith("This console could not read the Host's answer.");
    expect(unreadable).toContain("(invalid_response)");
    expect(explain(new ApiError("backend_unavailable", 503, "/v1/me"))).toBe(
      "The Host ran into a problem (HTTP 503, backend_unavailable). Try again shortly.",
    );
    // Known codes keep their own sentence, and a 4xx code the console does not
    // know is still quoted as a refusal.
    expect(explain(new ApiError("temporarily_unavailable", 503, "/v1/me"))).toBe(
      "The Host cannot take this right now. Try again shortly.",
    );
    expect(explain(new ApiError("private_inputs_conflict", 409, "/v1/x"))).toBe(
      "The server refused this: private_inputs_conflict",
    );
    consoleLocale.set("ja");
    expect(explain(new ApiError("invalid_response", 200, "/v1/me"))).toContain(
      "Hostの応答をこのコンソールで読み取れませんでした",
    );
  });

  test("JSON blocks can be scrolled from the keyboard", async () => {
    installFakeDom("/");
    const { jsonBlock } = await import("../console/src/ui.ts");
    const pre = jsonBlock({ observed: { ready: true } }) as unknown as FakeNode;
    expect(pre.tag).toBe("pre");
    expect(pre.getAttribute("tabindex")).toBe("0");
  });

  test("sign-in shows an empty or refused assertion beside the field and the language names include their visible codes", async () => {
    const { doc, root } = installFakeDom("/");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { signInPage } = await import("../console/src/pages/signin.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://signin-w3.example.test");
    state.sharedAuthAvailable.set(null);
    state.sharedAuthProbeState.set("idle");
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/identity/providers") {
          return Response.json({
            providers: [
              { id: "google", displayName: "Operator assertion", method: "operator-assertion" },
            ],
          });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = signInPage() as unknown as FakeNode;
    root.append(page);
    await flush();
    expect(page.tag).toBe("main");

    const textarea = page.all().find((node) => node.id === "assertion");
    const error = page.all().find((node) => node.id === "assertion-error");
    const form = page.all().find((node) => node.tag === "form");
    if (!textarea || !error || !form) throw new Error("operator form missing");
    expect(textarea.getAttribute("aria-describedby")).toBe("assertion-hint");
    expect(error.hidden).toBe(true);

    form.dispatch("submit");
    await flush();
    expect(error.hidden).toBe(false);
    expect(error.getAttribute("role")).toBe("alert");
    expect(error.textContent).toBe("Paste an assertion first");
    expect(textarea.getAttribute("aria-invalid")).toBe("true");
    expect(textarea.getAttribute("aria-describedby")).toBe("assertion-hint assertion-error");
    expect(doc.activeElement).toBe(textarea);

    // A refusal (here, a malformed assertion) stays beside the field too, and
    // clears as soon as the person edits or clears the box.
    textarea.value = "not-an-assertion";
    textarea.dispatch("input");
    expect(error.hidden).toBe(true);
    form.dispatch("submit");
    await flush();
    expect(error.hidden).toBe(false);
    expect(error.textContent).toContain("The assertion format is invalid");
    textarea.value = "";
    textarea.dispatch("input");
    expect(error.hidden).toBe(true);

    const language = page
      .all()
      .filter((node) => node.tag === "button" && node.className === "segmented__item")
      .filter(
        (node) =>
          node.getAttribute("title") === "日本語" || node.getAttribute("title") === "English",
      );
    expect(language).toHaveLength(2);
    for (const button of language) {
      expect(button.getAttribute("aria-label")).toBeNull();
      const visible = button.children.find((node) => node.getAttribute("aria-hidden") === "true");
      const spoken = button.children.find((node) => node.className === "visually-hidden");
      expect(spoken?.textContent.startsWith(visible?.textContent ?? "?")).toBe(true);
    }
  });

  test("dialogs keep head and foot in view while the body scrolls, and phone targets reach 44px", () => {
    const css = readFileSync(new URL("../console/app.css", import.meta.url), "utf8");
    const modal = cssBlock(css, ".modal");
    expect(modal).toContain("flex-direction: column");
    expect(modal).toContain("overflow: hidden");
    expect(modal).toContain("max-height: 86dvh");
    const body = cssBlock(css, ".modal__body");
    expect(body).toContain("overflow-y: auto");
    expect(body).toContain("min-height: 0");
    expect(cssBlock(css, ".modal__head")).toContain("flex: none");
    expect(cssBlock(css, ".modal__foot")).toContain("flex: none");

    const phone = ".topbar .btn--sm {";
    for (const selector of [
      ".btn--sm",
      ".segmented__item",
      ".topbar__org",
      ".input,\n  .select",
      ".copy",
      ".request-details summary",
      ".signin__endpoint summary",
    ]) {
      expect(cssBlock(css, selector, phone)).toContain("44px");
    }
  });

  test("sign-in loading bar and discovery failures carry live-region semantics", async () => {
    const { root } = installFakeDom("/");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { signInPage } = await import("../console/src/pages/signin.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://signin-status-w3.example.test");
    state.sharedAuthAvailable.set(false);
    state.sharedAuthProbeState.set("settled");

    const deferred: { reject: ((error: Error) => void) | null } = { reject: null };
    globalThis.fetch = Object.assign(
      (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/identity/providers") {
          return new Promise<Response>((_resolve, reject) => {
            deferred.reject = reject;
          });
        }
        return Promise.resolve(Response.json({ error: { code: "not_found" } }, { status: 404 }));
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = signInPage() as unknown as FakeNode;
    root.append(page);
    const status = page.all().find((node) => node.getAttribute("role") === "status");
    expect(status?.getAttribute("aria-busy")).toBe("true");
    expect(status?.textContent).toBe("Loading…");
    const bar = status?.all().find((node) => node.className === "skeleton");
    expect(bar?.getAttribute("aria-hidden")).toBe("true");

    deferred.reject?.(new Error("offline"));
    await flush();
    const alert = page.all().find((node) => node.getAttribute("role") === "alert");
    expect(alert?.className).toContain("notice--bad");
  });

  test("Add funds modal shows inline field validation, focuses invalid input, and clears on valid edit", async () => {
    const { doc, root } = installFakeDom("/billing");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { billingPage } = await import("../console/src/pages/billing.ts");
    consoleLocale.set("en");
    state.setApiOrigin("https://billing-w3.example.test");
    const org = {
      id: "org-billing-w3",
      name: "Billing Org",
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

    let checkoutCalls = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === `/v1/organizations/${org.id}/wallet`) {
          return Response.json({
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
          });
        }
        if (url.pathname === `/v1/organizations/${org.id}/wallet/checkout`) {
          checkoutCalls += 1;
          return Response.json({ error: { code: "not_found" } }, { status: 404 });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const page = billingPage(org.id) as unknown as FakeNode;
    root.append(page);
    await flush();

    const addButton = page
      .all()
      .find((node) => node.tag === "button" && node.textContent.includes("Add funds"));
    addButton?.click();
    await flush();

    const dialog = doc.body.all().find((node) => node.getAttribute("role") === "dialog");
    const amount = dialog?.all().find((node) => node.tag === "input");
    const error = dialog?.all().find((node) => node.className === "field__error");
    if (!dialog || !amount || !error) throw new Error("Add funds dialog missing");
    expect(error.hidden).toBe(true);

    // Invalid amount (< $5) displays inline alert error and focuses the input.
    amount.value = "2";
    // IME Enter must not submit.
    amount.dispatch("keydown", { key: "Enter", isComposing: true, keyCode: 229 });
    await flush();
    expect(error.hidden).toBe(true);
    // Regular Enter validates inline without calling checkout.
    amount.dispatch("keydown", { key: "Enter", isComposing: false, keyCode: 13 });
    await flush();
    expect(checkoutCalls).toBe(0);
    expect(error.hidden).toBe(false);
    expect(error.getAttribute("role")).toBe("alert");
    expect(amount.getAttribute("aria-invalid")).toBe("true");
    expect(amount.getAttribute("aria-describedby")).toContain(error.id);
    expect(doc.activeElement).toBe(amount);

    // Editing to a valid amount clears the inline error.
    amount.value = "25";
    amount.dispatch("input");
    expect(error.hidden).toBe(true);
    expect(amount.getAttribute("aria-invalid")).toBeNull();

    // Closing cleans up the modal stack.
    doc.dispatchKey("Escape", { keyCode: 27 });
  });

  test("hosted billing continuation invalid selector carries h1 and loading card carries status", async () => {
    installFakeDom("/billing/hosted-continuations/bad");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { hostedBillingContinuationPage } = await import(
      "../console/src/pages/hosted-billing-continuation.ts"
    );
    consoleLocale.set("en");
    const invalid = hostedBillingContinuationPage("short") as unknown as FakeNode;
    const h1 = invalid.all().find((node) => node.tag === "h1");
    expect(h1?.textContent).toBe("Invalid continuation");

    const source = readFileSync(
      new URL("../console/src/pages/hosted-billing-continuation.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain('class: "card__body", role: "status", "aria-busy": "true"');
  });

  test("public landing code blocks are keyboard-scrollable and mobile nav links reach 44px width", async () => {
    const { landingHtml } = await import("../src/landing.ts");
    const html = landingHtml({
      consoleOrigin: "https://console.takoserver.example",
      apiOrigin: "https://api.takoserver.example",
    });
    expect(html).not.toContain("<pre>");
    expect(html).toContain('<pre tabindex="0">');
    expect(html).toContain(".top-link { min-width: 44px; justify-content: center; }");
  });
});
