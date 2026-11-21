import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import type { ResourceSummary } from "../console/src/api.ts";

const globals = [
  "Node",
  "HTMLInputElement",
  "document",
  "window",
  "localStorage",
  "fetch",
] as const;
const saved = globals.map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);
const originalFetch = globalThis.fetch;

class TestNode {
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly dataset = {};
  readonly listeners = new Map<string, EventListener[]>();
  parent: TestNode | null = null;
  className = "";
  value = "";
  disabled = false;
  checked = false;
  hidden = false;

  constructor(
    readonly tag = "text",
    private readonly content = "",
  ) {}

  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }

  all(): TestNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }

  append(...values: Array<TestNode | string>): void {
    for (const value of values) {
      const node = typeof value === "string" ? new TestNode("text", value) : value;
      if (node.tag === "fragment") {
        this.append(...node.children.slice());
      } else {
        node.remove();
        node.parent = this;
        this.children.push(node);
        if (
          this.tag === "select" &&
          (this.children.length === 1 || node.attributes.has("selected"))
        )
          this.value = node.value;
      }
    }
  }

  replaceChildren(...values: Array<TestNode | string>): void {
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
    if (name === "checked") this.checked = true;
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

  click(): void {
    if (this.disabled) return;
    for (const listener of this.listeners.get("click") ?? [])
      listener({ target: this, stopPropagation() {} } as unknown as Event);
  }

  querySelector<Value>(_selector: string): Value | null {
    return (this.all().find(
      (node) => ["input", "textarea", "select", "button"].includes(node.tag) && !node.disabled,
    ) ?? null) as Value | null;
  }

  focus(): void {}
}

const body = new TestNode("body");
const documentEvents = new TestNode("document");
const storage = new Map<string, string>();
const location = new URL("https://console.example.test/resources");
const moveLocation = (_state: unknown, _title: string, path: string | URL | null): void => {
  if (path !== null) location.href = new URL(path, location).href;
};
Object.assign(globalThis, {
  Node: TestNode,
  HTMLInputElement: TestNode,
  localStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  },
  document: {
    body,
    documentElement: new TestNode("html"),
    createElement: (tag: string) => new TestNode(tag),
    createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
    createTextNode: (value: string) => new TestNode("text", value),
    createDocumentFragment: () => new TestNode("fragment"),
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  },
  window: {
    location,
    localStorage: globalThis.localStorage,
    history: { pushState: moveLocation, replaceState: moveLocation },
    scrollTo() {},
    addEventListener() {},
  },
});

const state = await import("../console/src/state.ts");
const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
const { live } = await import("../console/src/dom.ts");
const { signal } = await import("../console/src/reactive.ts");
const { navigate, route } = await import("../console/src/router.ts");
const { setConsoleLocale } = await import("../console/src/i18n.ts");
setConsoleLocale("en");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const org = (id: string) => ({
  id: `org-${id}`,
  name: id,
  ownerPrincipalId: "local-owner",
  createdAt: "2026-11-13T00:00:00Z",
});
const principal = {
  id: "local-owner",
  provider: "local",
  email: "local@example.test",
  displayName: "Local",
};
const uid = "uid-local-detail";
const entry = (organizationId: string, name: string): ResourceSummary => ({
  uid,
  form: "https://forms.example.test/Widget/1.0.0",
  space: organizationId,
  name,
  generation: 1,
  observedGeneration: 1,
  observedAt: "2026-11-13T00:00:00Z",
  phase: "idle",
  spec: {},
  observed: {},
  output: {},
  lastOperation: "op-local-original",
});
function requestOrganization(request: Request): string {
  const organizationId = request.headers.get("takoform-organization");
  if (!organizationId) throw new Error("missing local request Organization");
  const space = new URL(request.url).searchParams.get("space");
  if (space !== null && space !== organizationId) throw new Error("mismatched local read scope");
  return organizationId;
}
function found(request: Request, name?: string): Response {
  return Response.json(
    entry(requestOrganization(request), name ?? `${requestOrganization(request)}-current`),
  );
}
const unavailable = () => Response.json({ error: { code: "unavailable" } }, { status: 503 });
function heldRead(): { promise: Promise<Response>; resolve: (response: Response) => void } {
  let resolve = (_response: Response): void => {
    throw new Error("local read was not initialized");
  };
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve: (response) => resolve(response) };
}
let requests: Request[];
let errors: unknown[];
let stopObserver: (() => void) | undefined;
const disableFrames: (() => void)[] = [];
let detailReply: (request: Request) => Response | Promise<Response>;
const details = () =>
  requests.filter((request) => new URL(request.url).pathname.endsWith(`/resources/${uid}`));
const reads = () => requests.filter((request) => new URL(request.url).pathname !== "/v1/me");
const retries = (node: TestNode) =>
  node.all().filter((node) => node.tag === "button" && node.textContent.includes("Try again"));
function control(node: TestNode, label: string): TestNode {
  const button = node.all().find((node) => node.tag === "button" && node.textContent === label);
  if (!button) throw new Error(`missing local control: ${label}`);
  return button;
}
function render(organizationId: string): TestNode {
  const page = resourceDetailPage(organizationId, uid);
  if (!(page instanceof TestNode)) throw new Error("detail page missing");
  body.append(page);
  return page;
}
function renderCurrentDetail(): { frame: TestNode; pages: TestNode[] } {
  const enabled = signal(true);
  disableFrames.push(() => enabled.set(false));
  const pages: TestNode[] = [];
  const frame = live(() => {
    if (!enabled()) return null;
    const current = state.currentOrganization();
    const here = route();
    if (
      !current ||
      here.segments.length !== 2 ||
      here.segments[0] !== "resources" ||
      here.segments[1] !== uid
    )
      return null;
    const page = resourceDetailPage(current.id, uid);
    if (!(page instanceof TestNode)) throw new Error("detail page missing");
    pages.push(page);
    return page;
  });
  if (!(frame instanceof TestNode)) throw new Error("detail frame missing");
  body.append(frame);
  return { frame, pages };
}
async function identity(saved = "org-a"): Promise<void> {
  state.selectOrganization(saved);
  stopObserver = state.observeSessionIdentity((error) => errors.push(error));
  await tick();
}
async function nextPage(): Promise<void> {
  const cursor = state.nextOrganizationCursor();
  if (cursor === null) throw new Error("expected explicit next roster page");
  await state.loadOrganizationPage(cursor);
  await tick();
}
beforeEach(async () => {
  body.replaceChildren();
  storage.clear();
  state.setApiOrigin("https://api.example.test");
  state.adoptSession();
  navigate(`/resources/${uid}`);
  await tick();
  requests = [];
  errors = [];
  detailReply = (request) => found(request);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method !== "GET") throw new Error("read-only fixture refuses mutation");
      const url = new URL(request.url);
      if (url.pathname === "/v1/me")
        return Response.json({
          principal,
          organizations: [org(url.searchParams.has("organizationCursor") ? "b" : "a")],
          nextOrganizationCursor: url.searchParams.has("organizationCursor")
            ? null
            : "org-page-two",
        });
      if (url.pathname.endsWith(`/resources/${uid}`)) return detailReply(request);
      if (url.pathname.endsWith("/resources")) {
        requestOrganization(request);
        return Response.json({ items: [], nextCursor: null });
      }
      throw new Error("unexpected local API route");
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  for (const disable of disableFrames.splice(0)) disable();
  stopObserver?.();
  stopObserver = undefined;
  state.adoptSession();
  await tick();
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("an unloaded saved Org cannot read a detail or claim nonmembership before its bounded page arrives", async () => {
  await identity("org-b");
  expect(state.currentOrganization()).toBeNull();
  const refused = render("org-b");
  await tick();
  expect(reads()).toHaveLength(0);
  expect(refused.textContent.includes("Choose an organization")).toBe(true);
  expect(refused.textContent.includes("No such resource")).toBe(false);
  await nextPage();
  const { frame } = renderCurrentDetail();
  await tick();
  expect(frame.textContent.includes("org-b-current")).toBe(true);
  expect(details()).toHaveLength(1);
  expect(reads().every((request) => requestOrganization(request) === "org-b")).toBe(true);
  expect(errors).toEqual([]);
});

for (const stage of ["initial", "Reload"]) {
  for (const status of [200, 503]) {
    test(`a retired ${stage} detail read cannot render or restore Retry after a same-Org roster remount (${status})`, async () => {
      await identity();
      const pending = heldRead();
      if (stage === "initial") detailReply = () => pending.promise;
      const { frame, pages } = renderCurrentDetail();
      await tick();
      const first = pages[0];
      if (!first) throw new Error("initial detail missing");
      if (stage === "Reload") {
        detailReply = () => pending.promise;
        control(frame, "Reload").click();
        await tick();
      }
      expect(details()).toHaveLength(stage === "initial" ? 1 : 2);
      detailReply = (request) => found(request, "visible-current-detail");
      await nextPage();
      expect(pages.length).toBe(2);
      const count = reads().length;
      pending.resolve(
        status === 200 ? Response.json(entry("org-a", "retired-detail-result")) : unavailable(),
      );
      await tick();
      expect(first.textContent.includes("retired-detail-result")).toBe(false);
      expect(retries(first)).toHaveLength(0);
      expect(first.textContent.includes("No such resource")).toBe(false);
      expect(frame.textContent.includes("visible-current-detail")).toBe(true);
      expect(reads()).toHaveLength(count);
      expect(state.currentOrganization()?.id).toBe("org-a");
      expect(state.organizations().map((row) => row.id)).toEqual(["org-b"]);
      expect(errors).toEqual([]);
    });
  }
}

for (const label of ["Reload", "Try again"]) {
  test(`a captured detail ${label} is retired, while the current control still reads the selected Org`, async () => {
    await identity();
    if (label === "Try again") detailReply = () => unavailable();
    const { frame, pages } = renderCurrentDetail();
    await tick();
    const oldControl = control(frame, label);
    detailReply =
      label === "Try again" ? () => unavailable() : (request) => found(request, "current-detail");
    await nextPage();
    expect(pages).toHaveLength(2);
    const count = reads().length;
    const countDetails = details().length;
    oldControl.click();
    await tick();
    expect(reads()).toHaveLength(count);
    detailReply = (request) => found(request, "current-reloaded-detail");
    control(frame, label).click();
    await tick();
    expect(details()).toHaveLength(countDetails + 1);
    expect(frame.textContent.includes("current-reloaded-detail")).toBe(true);
    expect(retries(frame)).toHaveLength(0);
    expect(reads().every((request) => requestOrganization(request) === "org-a")).toBe(true);
    expect(state.currentOrganization()?.id).toBe("org-a");
    expect(errors).toEqual([]);
  });
}
