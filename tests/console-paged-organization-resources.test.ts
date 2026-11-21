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
const { resourcesPage } = await import("../console/src/pages/resources.ts");
const { live } = await import("../console/src/dom.ts");
const { signal } = await import("../console/src/reactive.ts");
const { navigate } = await import("../console/src/router.ts");
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
const operationId = "op-local-original";
const entry = (organizationId: string, name: string): ResourceSummary => ({
  uid: `uid-${name}`,
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
  lastOperation: operationId,
});
function requestOrganization(request: Request): string {
  const organizationId = request.headers.get("takoform-organization");
  if (!organizationId) throw new Error("missing local request Organization");
  const space = new URL(request.url).searchParams.get("space");
  if (space !== null && space !== organizationId) throw new Error("mismatched local list scope");
  return organizationId;
}
function terminal(request: Request): Response {
  return Response.json({
    id: operationId,
    resourceUid: `uid-${requestOrganization(request)}-first`,
    action: "delete",
    generation: 1,
    status: "succeeded",
    effect: "complete",
    createdAt: "2026-11-13T00:00:00Z",
    updatedAt: "2026-11-13T00:00:00Z",
    retainUntil: "2026-11-14T00:00:00Z",
  });
}
function listed(request: Request, name?: string): Response {
  const organizationId = requestOrganization(request);
  const cursor = new URL(request.url).searchParams.get("cursor");
  return Response.json({
    items: [entry(organizationId, name ?? `${organizationId}-${cursor ? "second" : "first"}`)],
    nextCursor: cursor ? null : "resource-page-two",
  });
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
let rosterReply: (request: Request) => Response | Promise<Response>;
let listReply: (request: Request) => Response | Promise<Response>;
let operationReply: (request: Request) => Response | Promise<Response>;
const lists = () =>
  requests.filter((request) => new URL(request.url).pathname.endsWith("/resources"));
const operations = () =>
  requests.filter((request) => new URL(request.url).pathname.includes("/operations/"));
const retries = (node: TestNode) =>
  node.all().filter((node) => node.tag === "button" && node.textContent.includes("Try again"));
function control(node: TestNode, label: string): TestNode {
  const button = node.all().find((node) => node.tag === "button" && node.textContent === label);
  if (!button) throw new Error(`missing local control: ${label}`);
  return button;
}
function render(organizationId: string): TestNode {
  const page = resourcesPage(organizationId);
  if (!(page instanceof TestNode)) throw new Error("resources page missing");
  body.append(page);
  return page;
}
function renderCurrentResources(): { frame: TestNode; pages: TestNode[] } {
  const enabled = signal(true);
  disableFrames.push(() => enabled.set(false));
  const pages: TestNode[] = [];
  const frame = live(() => {
    if (!enabled()) return null;
    const selected = state.currentOrganization();
    if (!selected) return null;
    const page = resourcesPage(selected.id);
    if (!(page instanceof TestNode)) throw new Error("resources page missing");
    pages.push(page);
    return page;
  });
  if (!(frame instanceof TestNode)) throw new Error("resources frame missing");
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
  navigate("/resources");
  await tick();
  requests = [];
  errors = [];
  rosterReply = (request) =>
    Response.json({
      principal,
      organizations: [org(new URL(request.url).searchParams.has("organizationCursor") ? "b" : "a")],
      nextOrganizationCursor: new URL(request.url).searchParams.has("organizationCursor")
        ? null
        : "org-page-two",
    });
  listReply = (request) => listed(request);
  operationReply = (request) => terminal(request);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method !== "GET") throw new Error("read-only fixture refuses mutation");
      const path = new URL(request.url).pathname;
      if (path === "/v1/me") return rosterReply(request);
      if (path.endsWith("/resources")) return listReply(request);
      if (path.includes("/operations/")) return operationReply(request);
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

test("a saved Org absent from the first bounded page cannot start Resource or Operation reads", async () => {
  navigate(`/resources?operation=${operationId}`);
  await identity("org-b");
  expect(state.currentOrganization()).toBeNull();
  const refused = render("org-b");
  await tick();
  expect(lists()).toHaveLength(0);
  expect(operations()).toHaveLength(0);
  expect(
    refused.all().some((node) => node.tag === "button" && node.textContent === "New resource"),
  ).toBe(false);
  await nextPage();
  const { frame } = renderCurrentResources();
  await tick();
  expect(frame.textContent.includes("org-b-first")).toBe(true);
  expect(frame.textContent.includes("Deletion complete")).toBe(true);
  expect(
    [...lists(), ...operations()].every((request) => requestOrganization(request) === "org-b"),
  ).toBe(true);
  expect(errors).toEqual([]);
});

for (const status of [200, 503]) {
  test(`a retired initial list cannot render or offer Retry after a same-Org roster repaint (${status})`, async () => {
    await identity();
    const pending = heldRead();
    listReply = () => pending.promise;
    const { frame, pages } = renderCurrentResources();
    await tick();
    const first = pages[0];
    if (!first) throw new Error("initial page missing");
    expect(lists()).toHaveLength(1);
    listReply = (request) => listed(request, "current-frame-list");
    await nextPage();
    const count = lists().length;
    pending.resolve(
      status === 200
        ? Response.json({ items: [entry("org-a", "retired-initial-row")], nextCursor: null })
        : unavailable(),
    );
    await tick();
    expect(first.textContent.includes("retired-initial-row")).toBe(false);
    expect(retries(first)).toHaveLength(0);
    expect(frame.textContent.includes("current-frame-list")).toBe(true);
    expect(lists()).toHaveLength(count);
    expect(state.currentOrganization()?.id).toBe("org-a");
    expect(state.organizations().map((org) => org.id)).toEqual(["org-b"]);
  });
}

for (const label of ["Try again", "Reload", "Load more"]) {
  test(`a captured ${label} cannot read a replaced same-Org Resources page`, async () => {
    await identity();
    if (label === "Try again") listReply = () => unavailable();
    const { frame } = renderCurrentResources();
    await tick();
    const held = control(frame, label);
    await nextPage();
    const count = lists().length;
    held.click();
    await tick();
    expect(lists()).toHaveLength(count);
    expect(state.currentOrganization()?.id).toBe("org-a");
    if (label === "Try again") {
      listReply = (request) => listed(request, "current-recovered-list");
      control(frame, "Try again").click();
      await tick();
      expect(lists()).toHaveLength(count + 1);
      expect(frame.textContent.includes("current-recovered-list")).toBe(true);
      expect(retries(frame)).toHaveLength(0);
    }
  });
}

for (const status of [200, 503]) {
  test(`a continuation cannot update a replaced same-Org list or restore Retry (${status})`, async () => {
    await identity();
    const pending = heldRead();
    listReply = (request) =>
      new URL(request.url).searchParams.has("cursor") ? pending.promise : listed(request);
    const { frame, pages } = renderCurrentResources();
    await tick();
    const first = pages[0];
    if (!first) throw new Error("initial page missing");
    control(frame, "Load more").click();
    await tick();
    expect(
      lists().filter((request) => new URL(request.url).searchParams.has("cursor")),
    ).toHaveLength(1);
    await nextPage();
    const count = lists().length;
    pending.resolve(
      status === 200
        ? Response.json({ items: [entry("org-a", "retired-continuation-row")], nextCursor: null })
        : unavailable(),
    );
    await tick();
    expect(first.textContent.includes("retired-continuation-row")).toBe(false);
    expect(retries(first)).toHaveLength(0);
    expect(frame.textContent.includes("retired-continuation-row")).toBe(false);
    expect(lists()).toHaveLength(count);
  });
}

test("current list pagination retries its original cursor once after same selected Org survives roster paging", async () => {
  await identity();
  let failMore = true;
  listReply = (request) =>
    new URL(request.url).searchParams.has("cursor") && failMore ? unavailable() : listed(request);
  const { frame } = renderCurrentResources();
  await tick();
  await nextPage();
  expect(state.currentOrganization()?.id).toBe("org-a");
  expect(state.organizations().map((org) => org.id)).toEqual(["org-b"]);
  control(frame, "Load more").click();
  await tick();
  expect(frame.textContent.includes("org-a-first")).toBe(true);
  const retry = control(frame, "Try again");
  failMore = false;
  retry.click();
  retry.click();
  await tick();
  expect(frame.textContent.includes("org-a-first")).toBe(true);
  expect(frame.textContent.includes("org-a-second")).toBe(true);
  expect(
    frame.all().some((node) => node.tag === "button" && node.textContent === "Load more"),
  ).toBe(false);
  const continuations = lists().filter((request) =>
    new URL(request.url).searchParams.has("cursor"),
  );
  expect(continuations).toHaveLength(2);
  expect(continuations.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual([
    "resource-page-two",
    "resource-page-two",
  ]);
  expect(lists().every((request) => requestOrganization(request) === "org-a")).toBe(true);
  control(frame, "Reload").click();
  await tick();
  expect(frame.textContent.includes("org-a-first")).toBe(true);
  expect(frame.textContent.includes("org-a-second")).toBe(false);
  expect(control(frame, "Load more")).toBeDefined();
  expect(errors).toEqual([]);
});

for (const label of ["Reload", "Try again"]) {
  test(`a captured Operation ${label} cannot recheck a replaced same-Org page`, async () => {
    navigate(`/resources?operation=${operationId}`);
    await identity();
    operationReply = () => unavailable();
    const { frame } = renderCurrentResources();
    await tick();
    const held = control(frame, label);
    await nextPage();
    const count = operations().length;
    held.click();
    await tick();
    expect(operations()).toHaveLength(count);
    expect(lists().every((request) => requestOrganization(request) === "org-a")).toBe(true);
  });
}

test("the current Operation Retry reads its accepted handle and refreshes the visible list without mutation", async () => {
  navigate(`/resources?operation=${operationId}`);
  await identity();
  operationReply = () => unavailable();
  const { frame } = renderCurrentResources();
  await tick();
  await nextPage();
  const beforeLists = lists().length;
  const beforeOperations = operations().length;
  operationReply = (request) => terminal(request);
  control(frame, "Try again").click();
  await tick();
  expect(operations()).toHaveLength(beforeOperations + 1);
  expect(lists()).toHaveLength(beforeLists + 1);
  expect(frame.textContent.includes("Deletion complete")).toBe(true);
  expect(frame.textContent.includes("org-a-first")).toBe(true);
  expect(
    operations().every(
      (request) =>
        request.url.endsWith(`/operations/${operationId}`) &&
        requestOrganization(request) === "org-a",
    ),
  ).toBe(true);
  expect(errors).toEqual([]);
});

test("a failed continuation preserves a saved unloaded Org without Resource reads", async () => {
  await identity("org-b");
  rosterReply = () => unavailable();
  await expect(nextPage()).rejects.toMatchObject({ status: 503 });
  expect(state.currentOrganizationId()).toBe("org-b");
  expect(state.currentOrganization()).toBeNull();
  render("org-b");
  await tick();
  expect(lists()).toHaveLength(0);
});
