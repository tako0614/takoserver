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

describe("Console Wave 2 UI/UX improvements", () => {
  test("toasts separate alert/status roles without nested aria-live, support dismiss, and pause on hover/focus", async () => {
    const { body } = installFakeDom("/");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { mountToasts, toast } = await import("../console/src/ui.ts");
    consoleLocale.set("en");

    const host = mountToasts() as unknown as FakeNode;
    body.append(host);
    // Host itself has no role/aria-live so child alerts/statuses never nest live regions.
    expect(host.getAttribute("role")).toBeNull();
    expect(host.getAttribute("aria-live")).toBeNull();

    toast("Saved settings", "ok");
    toast("Request refused", "bad");

    expect(host.children).toHaveLength(2);
    const [okToast, badToast] = host.children;
    expect(okToast?.getAttribute("role")).toBe("status");
    expect(badToast?.getAttribute("role")).toBe("alert");

    // Hovering and focusing pause timer cleanly; dismiss button removes toast immediately.
    badToast?.dispatch("pointerenter");
    badToast?.dispatch("focusin");
    const dismissBtn = badToast
      ?.all()
      .find(
        (node) =>
          node.tag === "button" && node.getAttribute("aria-label") === "Dismiss notification",
      );
    expect(dismissBtn).toBeDefined();
    dismissBtn?.click();
    expect(host.children).toHaveLength(1);
    expect(host.children[0]).toBe(okToast);

    // Dismiss remaining toast cleanly.
    const okDismiss = okToast?.all().find((node) => node.tag === "button");
    okDismiss?.click();
    expect(host.children).toHaveLength(0);
  });

  test("openModal guards Escape during IME, traps Shift+Tab from dialog panel, and falls back to #main-content when opener disconnects", async () => {
    const { doc, root } = installFakeDom("/");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { openModal } = await import("../console/src/ui.ts");
    consoleLocale.set("en");

    const main = doc.createElement("main");
    main.setAttribute("id", "main-content");
    main.setAttribute("tabindex", "-1");
    const trigger = doc.createElement("button");
    trigger.append("Launch");
    main.append(trigger);
    root.append(main);
    trigger.focus();

    const input = doc.createElement("input");
    openModal({
      title: "Focus Test",
      body: input as unknown as HTMLElement,
      confirmLabel: "Apply",
      onConfirm: () => undefined,
    });

    const dialog = doc.body.all().find((node) => node.getAttribute("role") === "dialog");
    expect(dialog).toBeDefined();
    if (!dialog) throw new Error("dialog missing");

    // IME-composing Escape must not close the modal.
    doc.dispatchKey("Escape", { isComposing: true });
    doc.dispatchKey("Escape", { keyCode: 229 });
    expect(doc.body.all().some((node) => node.getAttribute("role") === "dialog")).toBe(true);

    // Shift+Tab when focus sits on the dialog panel itself wraps to the last focusable button.
    dialog.focus();
    expect(doc.activeElement).toBe(dialog);
    const prevented = doc.dispatchKey("Tab", { shiftKey: true });
    expect(prevented).toBe(true);
    expect(doc.activeElement?.textContent).toBe("Apply");

    // Removing the original opener before closing falls back cleanly to #main-content.
    trigger.remove();
    doc.dispatchKey("Escape", { isComposing: false, keyCode: 27 });
    expect(doc.body.all().some((node) => node.getAttribute("role") === "dialog")).toBe(false);
    expect(doc.activeElement).toBe(main);
  });

  test("/resources and /keys support guarded `/` shortcut, IME-safe Escape clear, match count, and refresh busy state", async () => {
    const { doc, root } = installFakeDom("/keys");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { keysPage } = await import("../console/src/pages/keys.ts");
    const { openModal } = await import("../console/src/ui.ts");
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
                name: "deploy-prod",
                scopes: ["resources:write"],
                createdAt: "2026-01-01T00:00:00.000Z",
                expiresAt: "2027-01-01T00:00:00.000Z",
              },
              {
                id: "key-2",
                organizationId: "org-1",
                name: "readonly-audit",
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

    const filterInput = page.all().find((node) => node.id === "keys-filter");
    expect(filterInput).toBeDefined();
    if (!filterInput) throw new Error("keys-filter missing");

    // `/` focuses filter input when target is non-editable and no modal is open.
    const focusedBySlash = doc.dispatchKey("/", { target: doc.body });
    expect(focusedBySlash).toBe(true);
    expect(doc.activeElement).toBe(filterInput);

    // `/` does NOT hijack when modifier is held or target is an input.
    const otherInput = doc.createElement("input");
    expect(doc.dispatchKey("/", { target: otherInput })).toBe(false);
    expect(doc.dispatchKey("/", { target: doc.body, ctrlKey: true })).toBe(false);

    // `/` does NOT hijack while a modal is open.
    const closeModal = openModal({ title: "Temp", body: "x" });
    expect(doc.dispatchKey("/", { target: doc.body })).toBe(false);
    closeModal();

    // Typing updates match count ("1 of 2").
    if (filterInput) {
      filterInput.value = "deploy";
      filterInput.dispatch("input");
      await flush();
      expect(page.textContent).toContain("1 of 2");
      expect(page.textContent).toContain("deploy-prod");
      expect(page.textContent).not.toContain("readonly-audit");

      // IME-composing Escape must not clear the filter.
      filterInput.dispatch("keydown", { key: "Escape", isComposing: true });
      filterInput.dispatch("keydown", { key: "Escape", keyCode: 229 });
      expect(filterInput.value).toBe("deploy");

      // Normal Escape clears the filter and restores full list.
      filterInput.dispatch("keydown", { key: "Escape", isComposing: false, keyCode: 27 });
      await flush();
      expect(filterInput.value).toBe("");
      expect(page.textContent).toContain("readonly-audit");
    }
  });

  test("createResource and updateResource show inline JSON validation with aria-invalid and aria-describedby", async () => {
    const { body } = installFakeDom("/resources");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { createResource, updateResource } = await import(
      "../console/src/pages/create-resource.ts"
    );
    const { mountToasts } = await import("../console/src/ui.ts");
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
    body.append(mountToasts() as unknown as FakeNode);

    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname === "/apis/forms.takoform.com/v2/support") {
          const form = url.searchParams.get("form") ?? "";
          return Response.json({ form, supported: true, operations: ["create"] });
        }
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    createResource("org-1");
    await flush();
    const spec = body.all().find((node) => node.id === "create-resource-spec");
    const specError = body.all().find((node) => node.id === "create-resource-spec-error");
    expect(spec).toBeDefined();
    expect(specError?.hidden).toBe(true);

    if (spec) {
      spec.value = "{bad json";
      spec.dispatch("input");
      expect(spec.getAttribute("aria-invalid")).toBe("true");
      expect(spec.getAttribute("aria-describedby")).toContain("create-resource-spec-error");
      expect(specError?.hidden).toBe(false);
      expect(specError?.textContent).toContain("Invalid JSON");

      spec.value = "[]";
      spec.dispatch("input");
      expect(spec.getAttribute("aria-invalid")).toBe("true");
      expect(specError?.textContent).toContain("JSON object");

      spec.value = '{"ok": true}';
      spec.dispatch("input");
      expect(spec.getAttribute("aria-invalid")).toBeNull();
      expect(specError?.hidden).toBe(true);
    }

    // Update modal also sets inline JSON error while preserving proposal note describedby.
    const cancelBtn = body
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Cancel");
    cancelBtn?.click();

    updateResource(
      "org-1",
      {
        uid: "uid-1",
        form: "https://takoform.com/forms/ModuleWorker/1.0.0/",
        space: "org-1",
        name: "edge-api",
        generation: 1,
        observedGeneration: 1,
        observedAt: "2026-11-27T00:00:00.000Z",
        phase: "idle",
        spec: { a: 1 },
        observed: {},
        output: {},
        lastOperation: "op-1",
      },
      { spec: { a: 1 }, note: "Review before applying." },
    );
    const updateSpec = body.all().find((node) => node.id === "update-resource-spec");
    const updateError = body.all().find((node) => node.id === "update-resource-spec-error");
    if (updateSpec) {
      updateSpec.value = "{not valid";
      updateSpec.dispatch("input");
      expect(updateSpec.getAttribute("aria-invalid")).toBe("true");
      expect(updateSpec.getAttribute("aria-describedby")).toBe(
        "update-resource-note update-resource-spec-error",
      );
      expect(updateError?.hidden).toBe(false);

      updateSpec.value = '{"a": 2}';
      updateSpec.dispatch("input");
      expect(updateSpec.getAttribute("aria-invalid")).toBeNull();
      expect(updateSpec.getAttribute("aria-describedby")).toBe("update-resource-note");
      expect(updateError?.hidden).toBe(true);
    }
    const updateCancel = body
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Cancel");
    updateCancel?.click();
  });

  test("bindSearchShortcut survives temporary disconnect while active and detaches once inactive", async () => {
    const { doc, body, windowKeydownCount } = installFakeDom("/resources");
    const { bindSearchShortcut } = await import("../console/src/ui.ts");
    const input = doc.createElement("input");
    let active = true;

    bindSearchShortcut(input as unknown as HTMLInputElement, undefined, () => active);
    expect(windowKeydownCount()).toBe(1);

    // Keystrokes while input is temporarily unmounted (initial load / refresh) must NOT detach listener.
    expect(input.isConnected).toBe(false);
    expect(doc.dispatchKey("a", { target: body })).toBe(false);
    expect(doc.dispatchKey("/", { target: body })).toBe(false);
    expect(windowKeydownCount()).toBe(1);

    // Once input mounts, `/` focuses it.
    body.append(input);
    expect(input.isConnected).toBe(true);
    expect(doc.dispatchKey("/", { target: body })).toBe(true);
    expect(doc.activeElement).toBe(input);

    // Survives another unmount/remount cycle (e.g., manual Reload/Refresh).
    input.remove();
    expect(doc.dispatchKey("/", { target: body })).toBe(false);
    expect(windowKeydownCount()).toBe(1);
    body.append(input);
    body.focus();
    expect(doc.dispatchKey("/", { target: body })).toBe(true);
    expect(doc.activeElement).toBe(input);

    // Once scope becomes inactive, listener detaches cleanly and stops focusing.
    active = false;
    body.focus();
    expect(doc.dispatchKey("/", { target: body })).toBe(false);
    expect(doc.activeElement).toBe(body);
    expect(windowKeydownCount()).toBe(0);
  });

  test("Refresh and Reload buttons preserve DOM identity and focus across loading, and keysPage scopes to route", async () => {
    const { doc, body, windowKeydownCount } = installFakeDom("/keys");
    const state = await import("../console/src/state.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { navigate } = await import("../console/src/router.ts");
    const { keysPage } = await import("../console/src/pages/keys.ts");
    const { resourcesPage } = await import("../console/src/pages/resources.ts");
    consoleLocale.set("en");
    navigate("/keys");
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

    let keyCalls = 0;
    const keyResolvers: Array<(response: Response) => void> = [];
    let resourceCalls = 0;
    const resourceResolvers: Array<(response: Response) => void> = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        if (url.pathname.endsWith("/api-keys")) {
          keyCalls += 1;
          return await new Promise<Response>((resolve) => {
            keyResolvers.push(resolve);
          });
        }
        if (url.pathname.endsWith("/resources")) {
          resourceCalls += 1;
          return await new Promise<Response>((resolve) => {
            resourceResolvers.push(resolve);
          });
        }
        return Response.json({ capabilities: {} });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    const keyPayload = {
      apiKeys: [
        {
          id: "key-1",
          organizationId: "org-1",
          name: "deploy-prod",
          scopes: ["resources:read"],
          createdAt: "2026-11-20T00:00:00.000Z",
          expiresAt: "2027-11-20T00:00:00.000Z",
        },
      ],
    };

    const page = keysPage("org-1") as unknown as FakeNode;
    body.append(page);
    await flush();

    // Pressing keys during initial loading must NOT unregister `/`.
    expect(doc.dispatchKey("j", { target: body })).toBe(false);
    expect(windowKeydownCount()).toBe(1);

    keyResolvers.shift()?.(Response.json(keyPayload));
    await flush();

    const refreshBtn = page
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Refresh keys");
    expect(refreshBtn).toBeDefined();
    if (!refreshBtn) throw new Error("Refresh keys button missing");

    // Focus Refresh button and trigger reload: DOM node & focus must stay intact through loading -> ready.
    refreshBtn.focus();
    expect(doc.activeElement).toBe(refreshBtn);
    refreshBtn.click();
    await flush();

    expect(keyCalls).toBe(2);
    expect(page.all().includes(refreshBtn)).toBe(true);
    expect(doc.activeElement).toBe(refreshBtn);
    expect(refreshBtn.getAttribute("aria-busy")).toBe("true");
    expect(refreshBtn.getAttribute("aria-disabled")).toBe("true");
    expect(refreshBtn.textContent).toBe("Refreshing…");

    // Keypress during Refresh (while #keys-filter is unmounted) keeps `/` active.
    expect(doc.dispatchKey("k", { target: body })).toBe(false);
    expect(windowKeydownCount()).toBe(1);

    keyResolvers.shift()?.(Response.json(keyPayload));
    await flush();

    expect(page.all().includes(refreshBtn)).toBe(true);
    expect(doc.activeElement).toBe(refreshBtn);
    expect(refreshBtn.getAttribute("aria-busy")).toBeNull();
    expect(refreshBtn.getAttribute("aria-disabled")).toBeNull();
    expect(refreshBtn.textContent).toBe("Refresh keys");

    // `/` still focuses `#keys-filter` after the refresh cycle completes.
    const filterInput = page.all().find((node) => node.id === "keys-filter");
    expect(filterInput).toBeDefined();
    if (!filterInput) throw new Error("keys-filter missing after refresh");
    expect(doc.dispatchKey("/", { target: body })).toBe(true);
    expect(doc.activeElement).toBe(filterInput);

    // Navigating away from `/keys` retires `isPageCurrent`: `/` detaches and retired Refresh button is inert.
    navigate("/settings");
    await flush();
    body.focus();
    expect(doc.dispatchKey("/", { target: body })).toBe(false);
    expect(windowKeydownCount()).toBe(0);
    refreshBtn.click();
    await flush();
    expect(keyCalls).toBe(2);

    // Resources Reload button also preserves DOM identity & focus across ready -> loading -> ready.
    navigate("/resources");
    await flush();
    body.replaceChildren();
    const resPage = resourcesPage("org-1") as unknown as FakeNode;
    body.append(resPage);
    await flush();

    const resPayload = {
      resources: [
        {
          uid: "uid-1",
          form: "https://takoform.com/forms/ModuleWorker/1.0.0/",
          space: "org-1",
          name: "edge-api",
          generation: 1,
          observedGeneration: 1,
          observedAt: "2026-11-27T00:00:00.000Z",
          phase: "idle",
        },
      ],
    };
    resourceResolvers.shift()?.(Response.json(resPayload));
    await flush();

    const reloadBtn = resPage
      .all()
      .find((node) => node.tag === "button" && node.textContent === "Reload");
    expect(reloadBtn).toBeDefined();
    if (!reloadBtn) throw new Error("Reload button missing");
    reloadBtn.focus();
    reloadBtn.click();
    await flush();

    expect(resourceCalls).toBe(2);
    expect(resPage.all().includes(reloadBtn)).toBe(true);
    expect(doc.activeElement).toBe(reloadBtn);
    expect(reloadBtn.getAttribute("aria-busy")).toBe("true");
    expect(reloadBtn.textContent).toBe("Reloading…");

    resourceResolvers.shift()?.(Response.json(resPayload));
    await flush();

    expect(resPage.all().includes(reloadBtn)).toBe(true);
    expect(doc.activeElement).toBe(reloadBtn);
    expect(reloadBtn.getAttribute("aria-busy")).toBeNull();
    expect(reloadBtn.textContent).toBe("Reload");
  });

  test("console CSS tokens meet WCAG AA (>= 4.5:1) across all light and dark surfaces", () => {
    const css = readFileSync(new URL("../console/app.css", import.meta.url), "utf8");
    const parseVars = (block: string): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const m of block.matchAll(/(--[a-z0-9-]+):\s*(#[0-9a-fA-F]{6})\b/g)) {
        out[m[1] as string] = (m[2] as string).toLowerCase();
      }
      return out;
    };
    const lum = (hex: string): number => {
      const clean = hex.replace("#", "");
      const [r, g, b] = [0, 2, 4].map((o) => {
        const v = Number.parseInt(clean.slice(o, o + 2), 16) / 255;
        return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
    };
    const contrast = (a: string, b: string): number => {
      const l1 = lum(a);
      const l2 = lum(b);
      return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    };
    const light = parseVars(css.slice(css.indexOf(":root {"), css.indexOf(":root:not")));
    const dark = parseVars(css.slice(css.indexOf(':root[data-theme="dark"]'), css.indexOf("* {")));
    for (const [mode, v] of [
      ["light", light],
      ["dark", dark],
    ] as const) {
      for (const [label, fgKey, bgKey] of [
        ["ink-1 on surface-0", "--ink-1", "--surface-0"],
        ["ink-2 on surface-1", "--ink-2", "--surface-1"],
        ["ink-3 on surface-1", "--ink-3", "--surface-1"],
        ["ink-3 on surface-2", "--ink-3", "--surface-2"],
        ["ink-3 on surface-3", "--ink-3", "--surface-3"],
        ["accent-ink on accent", "--accent-ink", "--accent"],
        ["bad on surface-1", "--bad", "--surface-1"],
        ["bad on bad-soft", "--bad", "--bad-soft"],
        ["ok on ok-soft", "--ok", "--ok-soft"],
        ["warn on warn-soft", "--warn", "--warn-soft"],
      ] as const) {
        const fg = v[fgKey];
        const bg = v[bgKey];
        expect(fg, `${mode} ${fgKey}`).toBeDefined();
        expect(bg, `${mode} ${bgKey}`).toBeDefined();
        if (fg && bg) {
          expect(contrast(fg, bg), `${mode} ${label}`).toBeGreaterThanOrEqual(4.5);
        }
      }
    }
  });
});
