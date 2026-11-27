import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

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
const location = new URL("https://console.example.test/keys");
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
    history: { pushState: moveLocation, replaceState: moveLocation },
    scrollTo() {},
    addEventListener() {},
  },
});

const state = await import("../console/src/state.ts");
const { keysPage } = await import("../console/src/pages/keys.ts");
const { live } = await import("../console/src/dom.ts");
const { signal } = await import("../console/src/reactive.ts");
const { navigate } = await import("../console/src/router.ts");
const { mountToasts } = await import("../console/src/ui.ts");
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
const key = (organizationId = "org-a", id = "expired-local-key") => ({
  id,
  organizationId,
  name: id,
  scopes: ["resources:write"],
  createdAt: "2020-01-01T00:00:00Z",
  expiresAt: "2021-01-01T00:00:00Z",
});
const createdKey = {
  ...key("org-a", "new-local-key"),
  name: "local new key",
  expiresAt: "2099-01-01T00:00:00Z",
};
const dummySecret = "local-fixture-only-secret";
let requests: Request[];
let keys: ReturnType<typeof key>[];
let stopObserver: (() => void) | undefined;
const disableFrames: (() => void)[] = [];
let errors: unknown[];
let rosterReply: (request: Request) => Response | Promise<Response>;
let listReply: (request: Request) => Response | Promise<Response>;
let mutateReply: (request: Request) => Response | Promise<Response>;

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function find(label: string, footer = false): TestNode {
  const node = body
    .all()
    .find(
      (node) =>
        node.tag === "button" &&
        node.textContent === label &&
        (!footer || node.parent?.tag === "footer"),
    );
  if (!node) throw new Error(`missing local control: ${label}`);
  return node;
}
function render(organizationId: string): TestNode {
  const page = keysPage(organizationId);
  if (!(page instanceof TestNode)) throw new Error("keys page did not return DOM");
  body.append(page);
  return page;
}
function renderCurrentKeys(): TestNode {
  // Use the same live selection-to-page boundary as the real Console shell.
  // Disable this mounted fixture after its test so later sessions cannot wake it.
  const enabled = signal(true);
  disableFrames.push(() => enabled.set(false));
  const frame = live(() => {
    if (!enabled()) return null;
    const selected = state.currentOrganization();
    return selected ? keysPage(selected.id) : null;
  });
  if (!(frame instanceof TestNode)) throw new Error("current keys frame missing");
  body.append(frame);
  return frame;
}
function dismiss(): void {
  for (const listener of [...(documentEvents.listeners.get("keydown") ?? [])])
    listener({ key: "Escape" } as unknown as Event);
}
function openCreate(): TestNode {
  find("Create key").click();
  const name = body.all().find((node) => node.attributes.get("id") === "create-key-name");
  if (!name) throw new Error("create field missing");
  name.value = createdKey.name;
  return find("Create key", true);
}
function openRevoke(id: string): TestNode {
  const row = body.all().find((node) => node.tag === "tr" && node.textContent.includes(id));
  const button = row?.all().find((node) => node.tag === "button" && node.textContent === "Revoke");
  if (!button) throw new Error("local revoke action missing");
  button.click();
  return find("Revoke key", true);
}
const reads = () =>
  requests.filter(
    (request) => request.method === "GET" && new URL(request.url).pathname.endsWith("/api-keys"),
  );
const mutations = () =>
  requests.filter((request) => request.method === "POST" || request.method === "DELETE");
const toasts = () => body.all().filter((node) => node.className.startsWith("toast toast--"));
async function identity(saved = "org-a"): Promise<void> {
  state.selectOrganization(saved);
  stopObserver = state.observeSessionIdentity((error) => errors.push(error));
  await tick();
}
async function nextPage(): Promise<void> {
  const cursor = state.nextOrganizationCursor();
  if (cursor === null) throw new Error("expected explicit next roster page");
  await state.loadOrganizationPage(cursor);
}

beforeEach(async () => {
  dismiss();
  body.replaceChildren();
  storage.clear();
  state.setApiOrigin("https://api.example.test");
  state.adoptSession();
  navigate("/keys");
  await tick();
  requests = [];
  errors = [];
  keys = [key()];
  rosterReply = (request) =>
    Response.json({
      principal,
      organizations: [org(new URL(request.url).searchParams.has("organizationCursor") ? "b" : "a")],
      nextOrganizationCursor: new URL(request.url).searchParams.has("organizationCursor")
        ? null
        : "page-two",
    });
  listReply = (request) =>
    Response.json({
      apiKeys: keys.filter((key) => request.url.includes(`/${key.organizationId}/`)),
    });
  mutateReply = (request) => {
    if (request.method === "POST") {
      keys.push(createdKey);
      return Response.json({ apiKey: createdKey, secret: dummySecret }, { status: 201 });
    }
    keys = keys.filter((key) => !request.url.endsWith(`/${key.id}`));
    return Response.json({ apiKey: createdKey });
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      const path = new URL(request.url).pathname;
      if (path === "/v1/me") return rosterReply(request);
      if (path === "/.well-known/takoserver") return Response.json({ endpoints: {} });
      if (request.method === "POST" || request.method === "DELETE") return mutateReply(request);
      if (path.endsWith("/api-keys")) return listReply(request);
      throw new Error("unexpected local API route");
    },
    { preconnect: originalFetch.preconnect },
  );
  const host = mountToasts();
  if (!(host instanceof TestNode)) throw new Error("toast host missing");
  body.append(host);
});
afterEach(async () => {
  for (const disable of disableFrames.splice(0)) disable();
  stopObserver?.();
  stopObserver = undefined;
  dismiss();
  state.adoptSession();
  await tick();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("a saved Organization absent from a bounded page cannot start key reads or key creation", async () => {
  await identity("org-b");
  expect(state.currentOrganization()).toBeNull();
  const page = render("org-b");
  await tick();
  expect(reads()).toHaveLength(0);
  expect(
    page.all().some((node) => node.tag === "button" && node.textContent === "Create key"),
  ).toBe(false);
  await nextPage();
  expect(state.currentOrganization()?.id).toBe("org-b");
  render("org-b");
  await tick();
  expect(reads().map((request) => new URL(request.url).pathname)).toEqual([
    "/v1/organizations/org-b/api-keys",
  ]);
  expect(mutations()).toHaveLength(0);
});

for (const status of [200, 503]) {
  test(`a delayed key list cannot render or offer retry after explicit paged Org selection changes (${status})`, async () => {
    await identity();
    const pending = deferred();
    listReply = () => pending.promise;
    const oldPage = render("org-a");
    await nextPage();
    state.selectOrganization("org-b");
    pending.resolve(
      status === 200
        ? Response.json({ apiKeys: [key("org-a", "retired-local-key")] })
        : Response.json({ error: { code: "unavailable" } }, { status }),
    );
    await tick();
    expect(oldPage.textContent.includes("retired-local-key")).toBe(false);
    expect(
      oldPage.all().some((node) => node.tag === "button" && node.textContent.includes("Try again")),
    ).toBe(false);
    expect(reads()).toHaveLength(1);
    expect(mutations()).toHaveLength(0);
  });
}

test("a selected earlier-page Org keeps key creation, expired display and revocation scoped while browsing another page", async () => {
  rosterReply = (request) => {
    const cursor = new URL(request.url).searchParams.get("organizationCursor");
    return Response.json({
      principal,
      organizations: [org(cursor === "page-three" ? "c" : cursor === "page-two" ? "b" : "a")],
      nextOrganizationCursor:
        cursor === "page-three" ? null : cursor === "page-two" ? "page-three" : "page-two",
    });
  };
  await identity();
  const frame = renderCurrentKeys();
  await tick();
  expect(frame.all().some((node) => node.textContent === "expired")).toBe(true);
  const confirm = openCreate();
  await nextPage();
  await tick();
  expect(state.organizations().map((org) => org.id)).toEqual(["org-b"]);
  expect(state.currentOrganization()?.id).toBe("org-a");
  confirm.click();
  await tick();
  expect(
    mutations().map((request) => `${request.method} ${new URL(request.url).pathname}`),
  ).toEqual(["POST /v1/organizations/org-a/api-keys"]);
  expect((await mutations()[0]?.json())?.name).toBe(createdKey.name);
  expect(body.textContent.includes(dummySecret)).toBe(true);
  expect(frame.textContent.includes(createdKey.id)).toBe(true);
  find("Done", true).click();
  const revoke = openRevoke(createdKey.id);
  await nextPage();
  await tick();
  expect(state.organizations().map((org) => org.id)).toEqual(["org-c"]);
  expect(state.currentOrganization()?.id).toBe("org-a");
  revoke.click();
  await tick();
  expect(
    mutations().map((request) => `${request.method} ${new URL(request.url).pathname}`),
  ).toEqual([
    "POST /v1/organizations/org-a/api-keys",
    "DELETE /v1/organizations/org-a/api-keys/new-local-key",
  ]);
  expect(body.textContent.includes(createdKey.id)).toBe(false);
  expect(body.textContent.includes("expired-local-key")).toBe(true);
  expect(frame.all().some((node) => node.textContent === "expired")).toBe(true);
  expect(reads()).toHaveLength(5);
  expect(errors).toEqual([]);
});

test("cancelling a create during a page continuation leaves no request or secret", async () => {
  await identity();
  render("org-a");
  await tick();
  const confirm = openCreate();
  await nextPage();
  find("Cancel", true).click();
  confirm.click();
  await tick();
  expect(mutations()).toHaveLength(0);
  expect(body.textContent.includes(dummySecret)).toBe(false);
});

for (const method of ["POST", "DELETE"] as const) {
  test(`a delayed ${method} ACK stays with its original Org after loading and selecting the next page`, async () => {
    await identity();
    render("org-a");
    await tick();
    const pending = deferred();
    mutateReply = () => pending.promise;
    const confirm = method === "POST" ? openCreate() : openRevoke("expired-local-key");
    confirm.click();
    expect(mutations()).toHaveLength(1);
    await nextPage();
    state.selectOrganization("org-b");
    await tick();
    pending.resolve(
      Response.json(
        { apiKey: createdKey, secret: dummySecret },
        { status: method === "POST" ? 201 : 200 },
      ),
    );
    await tick();
    expect(mutations()[0]?.url.includes("/org-a/")).toBe(true);
    expect(mutations()).toHaveLength(1);
    expect(reads()).toHaveLength(1);
    expect(body.textContent.includes(dummySecret)).toBe(false);
    expect(toasts()).toHaveLength(0);
    expect([...storage.values()].some((value) => value.includes(dummySecret))).toBe(false);
  });
}

test("a failed continuation leaves a saved unloaded Org unresolved and cannot open its key list", async () => {
  await identity("org-b");
  rosterReply = () => Response.json({ error: { code: "unavailable" } }, { status: 503 });
  await expect(nextPage()).rejects.toMatchObject({ status: 503 });
  expect(state.currentOrganizationId()).toBe("org-b");
  expect(state.currentOrganization()).toBeNull();
  render("org-b");
  await tick();
  expect(reads()).toHaveLength(0);
  expect(mutations()).toHaveLength(0);
});

test("a Retry control captured before paged Org retirement cannot reissue the old list request", async () => {
  await identity();
  listReply = () => Response.json({ error: { code: "unavailable" } }, { status: 503 });
  const oldPage = render("org-a");
  await tick();
  const retry = oldPage
    .all()
    .find((node) => node.tag === "button" && node.textContent.includes("Try again"));
  if (!retry) throw new Error("local retry control missing");
  await nextPage();
  state.selectOrganization("org-b");
  retry.click();
  await tick();
  expect(reads()).toHaveLength(1);
  expect(mutations()).toHaveLength(0);
});
