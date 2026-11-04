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
  window: { location: new URL("https://console.example.test/"), addEventListener() {} },
});

const state = await import("../console/src/state.ts");
const { keysPage } = await import("../console/src/pages/keys.ts");
const { mountToasts, openModal } = await import("../console/src/ui.ts");
const { setConsoleLocale } = await import("../console/src/i18n.ts");
setConsoleLocale("en");

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const organizations = ["a", "b"].map((id) => ({
  id: `org-${id}`,
  name: id,
  ownerPrincipalId: "owner",
  createdAt: "2026-11-04T00:00:00Z",
}));
const existingKey = {
  id: "synthetic-key",
  name: "fixture-key",
  scopes: ["resources:write"],
  organizationId: "org-a",
  createdAt: "2026-11-04T00:00:00Z",
  expiresAt: "2099-01-01T00:00:00Z",
};
const created = {
  apiKey: { id: "synthetic-key", name: "fixture-key", scopes: ["resources:write"] },
  secret: "synthetic-key-secret",
};
let requests: Request[];
let reply: (request: Request) => Response | Promise<Response>;
let discoveryReply: () => Response | Promise<Response>;

function find(predicate: (node: TestNode) => boolean): TestNode {
  const result = body.all().find(predicate);
  if (!result) throw new Error("expected rendered control missing");
  return result;
}

function render(): void {
  const page = keysPage(state.currentOrganization()?.id ?? "org-a");
  if (!(page instanceof TestNode)) throw new Error("keysPage did not render DOM");
  body.append(page);
}

function openCreate(): TestNode {
  find((node) => node.tag === "button" && node.textContent === "Create key").click();
  find((node) => node.attributes.get("id") === "create-key-name").value = "fixture-key";
  return find(
    (node) =>
      node.tag === "button" && node.textContent === "Create key" && node.parent?.tag === "footer",
  );
}

function dismiss(): void {
  for (const listener of [...(documentEvents.listeners.get("keydown") ?? [])])
    listener({ key: "Escape" } as unknown as Event);
}

function deferred() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function changeScope(kind: "org" | "roundtrip" | "session" | "origin"): void {
  if (kind === "org" || kind === "roundtrip") state.selectOrganization("org-b");
  if (kind === "roundtrip") state.selectOrganization("org-a");
  if (kind === "session") state.adoptSession();
  if (kind === "origin") state.setApiOrigin("https://other.example.test");
}

const posts = () => requests.filter((request) => request.method === "POST");
const reads = () =>
  requests.filter((request) => request.method === "GET" && request.url.endsWith("/api-keys"));
const secretVisible = () => body.textContent.includes(created.secret);
const toasts = () => body.all().filter((node) => node.className.startsWith("toast toast--"));

beforeEach(async () => {
  dismiss();
  body.replaceChildren();
  storage.clear();
  state.setApiOrigin("https://api.example.test");
  state.adoptSession();
  state.organizations.set(organizations);
  state.selectOrganization("org-a");
  await tick();
  requests = [];
  reply = () => Response.json(created);
  discoveryReply = () => Response.json({ endpoints: {} });
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method === "POST" || request.method === "DELETE") return reply(request);
      if (new URL(request.url).pathname === "/.well-known/takoserver") return discoveryReply();
      return Response.json(
        new URL(request.url).pathname.endsWith("/api-keys")
          ? { apiKeys: [existingKey] }
          : { endpoints: {} },
      );
    },
    { preconnect: originalFetch.preconnect },
  );
  const toastHost = mountToasts();
  if (!(toastHost instanceof TestNode)) throw new Error("toast host did not render DOM");
  body.append(toastHost);
  render();
  await tick();
});

afterEach(() => {
  dismiss();
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("current create issues one original request and reveals its one-time secret", async () => {
  openCreate().click();
  await tick();
  expect(posts()).toHaveLength(1);
  expect(posts()[0]?.url).toBe("https://api.example.test/v1/organizations/org-a/api-keys");
  expect(await posts()[0]?.json()).toEqual({
    name: "fixture-key",
    scopes: ["resources:write"],
    expiresInSeconds: 7776000,
  });
  expect(secretVisible()).toBe(true);
  expect(reads()).toHaveLength(2);
});

function scopeInput(id: string): TestNode | undefined {
  const label = body
    .all()
    .find(
      (node) =>
        node.tag === "label" &&
        node
          .all()
          .some((child) => child.className.includes("check__id") && child.textContent === id),
    );
  return label?.all().find((node) => node.tag === "input");
}

function scopeOffered(id: string): boolean {
  const input = scopeInput(id);
  if (!input) return false;
  for (let node: TestNode | null = input; node; node = node.parent) {
    if (node.hidden || node.disabled || node.style.display === "none") return false;
  }
  return true;
}

function chooseScope(id: string, checked: boolean): TestNode {
  const input = scopeInput(id);
  if (!input) throw new Error(`scope ${id} is not rendered`);
  input.checked = checked;
  for (const listener of input.listeners.get("change") ?? [])
    listener({ target: input } as unknown as Event);
  return input;
}

async function renderPendingDiscovery() {
  const answer = deferred();
  discoveryReply = () => answer.promise;
  body.replaceChildren();
  render();
  await tick();
  return answer;
}

test("an open create dialog receives late AI discovery without replacing entered controls", async () => {
  const answer = await renderPendingDiscovery();
  const confirm = openCreate();
  const name = find((node) => node.attributes.get("id") === "create-key-name");
  const writer = chooseScope("resources:write", false);
  const reader = chooseScope("resources:read", true);
  expect(scopeOffered("ai:invoke")).toBe(false);
  expect(posts()).toHaveLength(0);

  answer.resolve(Response.json({ endpoints: { ai: "https://api.example.test/v1/ai" } }));
  await tick();

  expect(scopeOffered("ai:invoke")).toBe(true);
  expect(find((node) => node.attributes.get("id") === "create-key-name")).toBe(name);
  expect(name.value).toBe("fixture-key");
  expect(scopeInput("resources:write")).toBe(writer);
  expect(scopeInput("resources:read")).toBe(reader);
  expect(writer.checked).toBe(false);
  expect(reader.checked).toBe(true);
  expect(posts()).toHaveLength(0);
  chooseScope("ai:invoke", true);
  confirm.click();
  await tick();
  expect(posts()).toHaveLength(1);
  expect(await posts()[0]?.json()).toEqual({
    name: "fixture-key",
    scopes: ["resources:read", "ai:invoke"],
    expiresInSeconds: 7776000,
  });
});

for (const [label, payload, status] of [
  ["absent", { endpoints: {} }, 200],
  ["malformed", { endpoints: { ai: true } }, 200],
  ["failed", { endpoints: { ai: "https://api.example.test/v1/ai" } }, 503],
] as const) {
  test(`late ${label} discovery keeps AI unavailable and ordinary key creation usable`, async () => {
    const answer = await renderPendingDiscovery();
    const confirm = openCreate();
    answer.resolve(Response.json(payload, { status }));
    await tick();
    expect(scopeOffered("ai:invoke")).toBe(false);
    expect(scopeOffered("resources:write")).toBe(true);
    confirm.click();
    await tick();
    expect(posts()).toHaveLength(1);
    expect((await posts()[0]?.json())?.scopes).toEqual(["resources:write"]);
  });
}

for (const kind of ["org", "roundtrip", "session", "origin"] as const) {
  test(`a retired create dialog cannot dispatch (${kind})`, async () => {
    const confirm = openCreate();
    changeScope(kind);
    confirm.click();
    await tick();
    expect(posts()).toHaveLength(0);
    expect(secretVisible()).toBe(false);
  });

  for (const status of [201, 400, 503]) {
    test(`retired ${kind} completion cannot reveal, reload or toast (${status})`, async () => {
      const answer = deferred();
      reply = () => answer.promise;
      openCreate().click();
      expect(posts()).toHaveLength(1);
      changeScope(kind);
      answer.resolve(
        Response.json(status === 201 ? created : { error: { code: "unavailable" } }, { status }),
      );
      await tick();
      expect(secretVisible()).toBe(false);
      expect(reads()).toHaveLength(1);
      expect(toasts()).toHaveLength(0);
    });
  }

  test(`an already shown key is removed when its presentation scope retires (${kind})`, async () => {
    openCreate().click();
    await tick();
    expect(secretVisible()).toBe(true);
    changeScope(kind);
    await tick();
    expect(secretVisible()).toBe(false);
  });
}

test("dismissing an in-flight create prevents late secret presentation", async () => {
  const answer = deferred();
  reply = () => answer.promise;
  openCreate().click();
  dismiss();
  answer.resolve(Response.json(created, { status: 201 }));
  await tick();
  expect(secretVisible()).toBe(false);
  expect(reads()).toHaveLength(1);
});

test("a current failed create still reports the refusal without a secret or retry", async () => {
  reply = () => Response.json({ error: { code: "unavailable" } }, { status: 503 });
  openCreate().click();
  await tick();
  expect(posts()).toHaveLength(1);
  expect(secretVisible()).toBe(false);
  expect(toasts()).toHaveLength(1);
});

test("a dismissed pending create cannot replace the next dialog's current result", async () => {
  const old = deferred();
  reply = () => old.promise;
  openCreate().click();
  dismiss();
  reply = () => Response.json({ ...created, secret: "new-synthetic-secret" });
  openCreate().click();
  await tick();
  expect(body.textContent).toContain("new-synthetic-secret");
  old.resolve(Response.json(created));
  await tick();
  expect(secretVisible()).toBe(false);
  expect(body.textContent).toContain("new-synthetic-secret");
  expect(posts()).toHaveLength(2);
});

test("modal close notifies its lifetime once and removes the Escape listener", () => {
  let closed = 0;
  const close = openModal({
    title: "Fixture",
    body: "No secret",
    onClose: () => {
      closed += 1;
    },
  });
  close();
  close();
  dismiss();
  expect(closed).toBe(1);
  expect(documentEvents.listeners.get("keydown") ?? []).toHaveLength(0);
});

const deletions = () => requests.filter((request) => request.method === "DELETE");
function openRevoke(): TestNode {
  find((node) => node.tag === "button" && node.textContent === "Revoke").click();
  return find((node) => node.tag === "button" && node.textContent === "Revoke key");
}

test("current revocation sends the original DELETE once and refreshes", async () => {
  openRevoke().click();
  await tick();
  expect(deletions()).toHaveLength(1);
  expect(deletions()[0]?.url).toBe(
    "https://api.example.test/v1/organizations/org-a/api-keys/synthetic-key",
  );
  expect(reads()).toHaveLength(2);
  expect(toasts()).toHaveLength(1);
  expect(body.all().filter((node) => node.attributes.get("role") === "dialog")).toHaveLength(0);
});

test("current revocation failure reports the refusal without refresh or retry", async () => {
  reply = () => Response.json({ error: { code: "unavailable" } }, { status: 503 });
  openRevoke().click();
  await tick();
  expect(deletions()).toHaveLength(1);
  expect(reads()).toHaveLength(1);
  expect(toasts()).toHaveLength(1);
  expect(body.all().filter((node) => node.attributes.get("role") === "dialog")).toHaveLength(1);
});

for (const kind of ["org", "roundtrip", "session", "origin"] as const) {
  test(`a retired revoke dialog cannot dispatch (${kind})`, async () => {
    const confirm = openRevoke();
    changeScope(kind);
    confirm.click();
    await tick();
    expect(deletions()).toHaveLength(0);
  });

  for (const status of [200, 404, 503]) {
    test(`retired revoke completion cannot reload or toast (${kind}, ${status})`, async () => {
      const answer = deferred();
      reply = () => answer.promise;
      openRevoke().click();
      expect(deletions()).toHaveLength(1);
      changeScope(kind);
      answer.resolve(
        Response.json(status === 200 ? created : { error: { code: "unavailable" } }, { status }),
      );
      await tick();
      expect(reads()).toHaveLength(1);
      expect(toasts()).toHaveLength(0);
    });
  }
}

for (const status of [200, 503]) {
  test(`a dismissed revoke cannot update the next dialog (${status})`, async () => {
    const answer = deferred();
    reply = () => answer.promise;
    openRevoke().click();
    dismiss();
    openCreate();
    answer.resolve(
      Response.json(status === 200 ? created : { error: { code: "unavailable" } }, { status }),
    );
    await tick();
    expect(deletions()).toHaveLength(1);
    expect(reads()).toHaveLength(1);
    expect(toasts()).toHaveLength(0);
    expect(
      body.all().filter((node) => node.attributes.get("aria-label") === "Create API key"),
    ).toHaveLength(1);
  });
}

test("pending revocation rejects local reentry", async () => {
  const answer = deferred();
  reply = () => answer.promise;
  const confirm = openRevoke();
  confirm.click();
  confirm.click();
  expect(deletions()).toHaveLength(1);
  answer.resolve(Response.json(created));
  await tick();
  expect(deletions()).toHaveLength(1);
  expect(reads()).toHaveLength(2);
});
