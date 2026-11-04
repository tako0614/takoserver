import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

const globals = [
  "Node",
  "HTMLInputElement",
  "document",
  "window",
  "localStorage",
  "sessionStorage",
  "fetch",
] as const;
const saved = globals.map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);
const originalFetch = globalThis.fetch;

class TestNode {
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = {};
  readonly dataset = {};
  readonly listeners = new Map<string, EventListener[]>();
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
const root = new TestNode("main");
body.append(root);
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
    getElementById: (id: string) => (id === "root" ? root : null),
    createElement: (tag: string) => new TestNode(tag),
    createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
    createTextNode: (value: string) => new TestNode("text", value),
    createDocumentFragment: () => new TestNode("fragment"),
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  },
  sessionStorage: {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  },
  window: {
    location: new URL("https://console.example.test/fixture"),
    addEventListener() {},
  },
});

const organizations = ["a", "b"].map((id) => ({
  id: `org-${id}`,
  name: id,
  ownerPrincipalId: "owner",
  createdAt: "2026-11-04T00:00:00Z",
}));
const created = {
  id: "created-org",
  name: "Fixture Org",
  ownerPrincipalId: "owner",
  createdAt: "2026-11-04T00:00:00Z",
};
let requests: Request[] = [];
let identityReply: (() => Response | Promise<Response>) | null = null;
const stopObservers: Array<() => void> = [];
let reply: () => Response | Promise<Response> = () => Response.json({ organization: created });
globalThis.fetch = Object.assign(
  async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    requests.push(request);
    const path = new URL(request.url).pathname;
    if (request.method === "POST") return reply();
    if (path === "/v1/me" && identityReply) return identityReply();
    if (path === "/v1/me")
      return Response.json({
        principal: {
          id: "owner",
          provider: "local",
          email: "owner@example.test",
          displayName: "Owner",
        },
        organizations,
      });
    if (path === "/auth/oidc/session")
      return Response.json({ available: false, authenticated: false });
    if (path === "/v1/identity/providers") return Response.json({ providers: [] });
    throw new Error(`Unexpected fixture read: ${request.url}`);
  },
  { preconnect: originalFetch.preconnect },
);
const fixtureFetch = globalThis.fetch;
const state = await import("../console/src/state.ts");
const { setConsoleLocale } = await import("../console/src/i18n.ts");
setConsoleLocale("en");
await import("../console/src/main.ts");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
await tick();

function find(predicate: (node: TestNode) => boolean): TestNode {
  const result = body.all().find(predicate);
  if (!result) throw new Error("expected rendered control missing");
  return result;
}
function openCreate(): TestNode {
  find(
    (node) =>
      node.tag === "button" &&
      (node.attributes.get("aria-label") === "Create organization" ||
        node.textContent === "Create organization"),
  ).click();
  const modal = find((node) => node.attributes.get("role") === "dialog");
  const input = modal.all().find((node) => node.tag === "input");
  const confirm = modal
    .all()
    .find((node) => node.tag === "button" && node.textContent === "Create");
  if (!input || !confirm) throw new Error("actual organization dialog missing");
  input.value = "  Fixture Org  ";
  return confirm;
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
function retire(kind: "session" | "origin" | "origin-roundtrip" | "dismiss"): void {
  if (kind === "session") state.adoptSession();
  if (kind === "origin" || kind === "origin-roundtrip")
    state.setApiOrigin("https://new.example.test");
  if (kind === "origin-roundtrip") {
    state.setApiOrigin("https://api.example.test");
    state.adoptSession();
  }
  if (kind === "dismiss") dismiss();
}
const posts = () => requests.filter((request) => request.method === "POST");
const toasts = () => body.all().filter((node) => node.className.startsWith("toast toast--"));

beforeEach(async () => {
  identityReply = null;
  globalThis.fetch = fixtureFetch;
  dismiss();
  state.setApiOrigin("https://api.example.test");
  state.sharedAuthAvailable.set(false);
  state.adoptSession();
  state.selectOrganization("org-a");
  await tick();
  requests = [];
  reply = () => Response.json({ organization: created }, { status: 201 });
});
afterEach(() => {
  dismiss();
  for (const stop of stopObservers.splice(0)) stop();
});
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

for (const kind of ["session", "origin", "origin-roundtrip", "dismiss"] as const) {
  test(`retired organization dialog cannot dispatch (${kind})`, async () => {
    const confirm = openCreate();
    retire(kind);
    await tick();
    confirm.click();
    await tick();
    expect(posts()).toHaveLength(0);
  });
  for (const status of [201, 400, 503]) {
    test(`retired organization completion leaves current list, selection and notices unchanged (${kind}/${status})`, async () => {
      const answer = deferred();
      reply = () => answer.promise;
      openCreate().click();
      expect(posts()).toHaveLength(1);
      retire(kind);
      await tick();
      const originalOrganizations = state.organizations();
      const originalSelection = state.currentOrganizationId();
      const originalToasts = toasts().length;
      answer.resolve(
        Response.json(
          status === 201 ? { organization: created } : { error: { code: "unavailable" } },
          { status },
        ),
      );
      await tick();
      expect(state.organizations()).toBe(originalOrganizations);
      expect(state.currentOrganizationId()).toBe(originalSelection);
      expect(toasts()).toHaveLength(originalToasts);
      expect(body.all().filter((node) => node.attributes.get("role") === "dialog")).toHaveLength(0);
    });
  }
}

test("current organization creation keeps original request and adopts the Host result once", async () => {
  const confirm = openCreate();
  confirm.click();
  confirm.click();
  await tick();
  expect(posts()).toHaveLength(1);
  expect(posts()[0]?.url).toBe("https://api.example.test/v1/organizations");
  expect(await posts()[0]?.json()).toEqual({ name: "Fixture Org" });
  expect(state.organizations().map((item) => item.id)).toEqual(["org-a", "org-b", "created-org"]);
  expect(state.currentOrganizationId()).toBe("created-org");
  expect(body.textContent).toContain("Organization created");
  expect(body.all().some((node) => node.attributes.get("role") === "dialog")).toBe(false);
});

test("changing selected Org in the same account does not invalidate account-level creation", async () => {
  const answer = deferred();
  reply = () => answer.promise;
  openCreate().click();
  state.selectOrganization("org-b");
  answer.resolve(Response.json({ organization: created }, { status: 201 }));
  await tick();
  expect(state.currentOrganizationId()).toBe("created-org");
  expect(state.organizations()).toContainEqual(created);
});

test("a current refusal stays visible without adding an Org or retrying", async () => {
  reply = () => Response.json({ error: { code: "unavailable" } }, { status: 503 });
  const originalOrganizations = state.organizations();
  const originalToasts = toasts().length;
  openCreate().click();
  await tick();
  expect(posts()).toHaveLength(1);
  expect(state.organizations()).toBe(originalOrganizations);
  expect(state.currentOrganizationId()).toBe("org-a");
  expect(toasts()).toHaveLength(originalToasts + 1);
  expect(body.all().some((node) => node.attributes.get("role") === "dialog")).toBe(true);
});

test("blank current name does not POST and keeps the validation notice", async () => {
  const confirm = openCreate();
  find((node) => node.tag === "input").value = "  ";
  confirm.click();
  await tick();
  expect(posts()).toHaveLength(0);
  expect(body.textContent).toContain("Give the organization a name");
});

test("an older dismissed completion cannot close a newer current dialog", async () => {
  const answer = deferred();
  reply = () => answer.promise;
  openCreate().click();
  dismiss();
  openCreate();
  const originalOrganizations = state.organizations();
  answer.resolve(Response.json({ organization: created }, { status: 201 }));
  await tick();
  expect(state.organizations()).toBe(originalOrganizations);
  expect(body.all().filter((node) => node.attributes.get("role") === "dialog")).toHaveLength(1);
});

function identityResponse(rows = organizations): Response {
  return Response.json({
    principal: {
      id: "owner",
      provider: "local",
      email: "owner@example.test",
      displayName: "Owner",
    },
    organizations: rows,
  });
}

/** A second read of this known session, rather than adoption of a new unknown one. */
function refreshKnownIdentity(): void {
  stopObservers.push(
    state.observeSessionIdentity((error) => {
      throw error;
    }),
  );
}

for (const returned of ["old-list", "includes-created", "removes-old-org"] as const) {
  test(`same-session pending identity preserves only new create ACKs (${returned})`, async () => {
    const identity = deferred();
    identityReply = () => identity.promise;
    refreshKnownIdentity();
    state.organizations.set(organizations);
    await tick();
    openCreate().click();
    await tick();
    expect(state.currentOrganization()?.id).toBe(created.id);
    const serverCreated = { ...created, name: "Server canonical name" };
    identity.resolve(
      identityResponse(
        returned === "includes-created"
          ? [...organizations, serverCreated]
          : returned === "removes-old-org"
            ? organizations.slice(0, 1)
            : organizations,
      ),
    );
    await tick();
    expect(state.organizations().map((row) => row.id)).toEqual(
      returned === "removes-old-org" ? ["org-a", "created-org"] : ["org-a", "org-b", "created-org"],
    );
    expect(state.organizations().filter((row) => row.id === created.id)).toHaveLength(1);
    expect(state.currentOrganization()?.name).toBe(
      returned === "includes-created" ? "Server canonical name" : "Fixture Org",
    );
    expect(requests.filter((request) => new URL(request.url).pathname === "/v1/me")).toHaveLength(
      1,
    );
  });
}

test("later identity success can remove a created Org and cannot be overwritten by the older read", async () => {
  const older = deferred();
  const newer = deferred();
  identityReply = () => older.promise;
  refreshKnownIdentity();
  await tick();
  openCreate().click();
  await tick();
  expect(state.currentOrganization()?.id).toBe(created.id);
  identityReply = () => newer.promise;
  stopObservers.push(
    state.observeSessionIdentity(() => {
      throw new Error("newer identity unexpectedly failed");
    }),
  );
  newer.resolve(identityResponse(organizations.slice(0, 1)));
  await tick();
  expect(state.organizations().map((row) => row.id)).toEqual(["org-a"]);
  older.resolve(identityResponse());
  await tick();
  expect(state.organizations().map((row) => row.id)).toEqual(["org-a"]);
});

test("a newer failed identity read does not discard a still-current older success", async () => {
  const older = deferred();
  const newer = deferred();
  identityReply = () => older.promise;
  refreshKnownIdentity();
  await tick();
  openCreate().click();
  await tick();
  identityReply = () => newer.promise;
  const failures: unknown[] = [];
  stopObservers.push(state.observeSessionIdentity((error) => failures.push(error)));
  newer.resolve(Response.json({ error: { code: "unavailable" } }, { status: 503 }));
  await tick();
  expect(failures).toHaveLength(1);
  older.resolve(identityResponse());
  await tick();
  expect(state.organizations().map((row) => row.id)).toEqual(["org-a", "org-b", "created-org"]);
});

test("two acknowledged creates during one identity read are retained once each", async () => {
  const identity = deferred();
  identityReply = () => identity.promise;
  refreshKnownIdentity();
  await tick();
  openCreate().click();
  await tick();
  const second = { ...created, id: "created-second", name: "Second" };
  reply = () => Response.json({ organization: second }, { status: 201 });
  openCreate().click();
  await tick();
  identity.resolve(identityResponse());
  await tick();
  expect(state.organizations().map((row) => row.id)).toEqual([
    "org-a",
    "org-b",
    "created-org",
    "created-second",
  ]);
  expect(state.currentOrganization()?.id).toBe("created-second");
});

for (const kind of ["session", "origin"] as const) {
  test(`a new ${kind} cannot inherit old create ACKs or identity responses`, async () => {
    const older = deferred();
    identityReply = () => older.promise;
    refreshKnownIdentity();
    await tick();
    openCreate().click();
    await tick();
    expect(state.currentOrganization()?.id).toBe(created.id);
    identityReply = () => identityResponse([]);
    if (kind === "origin") state.setApiOrigin("https://new.example.test");
    state.adoptSession();
    await tick();
    older.resolve(identityResponse());
    await tick();
    expect(state.organizations()).toEqual([]);
    expect(state.currentOrganization()).toBeNull();
  });
}

const createOrganizationButtons = () =>
  body
    .all()
    .filter(
      (node) =>
        node.tag === "button" &&
        (node.attributes.get("aria-label") === "Create organization" ||
          node.textContent === "Create organization"),
    );

for (const kind of ["shared-auth", "takos-id"] as const) {
  test(`managed Organization session keeps selection without offering local create (${kind})`, async () => {
    if (kind === "shared-auth") state.adoptSession("shared-auth");
    await tick();
    if (kind === "takos-id") {
      const current = state.principal();
      if (!current) throw new Error("fixture principal missing");
      state.principal.set({ ...current, provider: "takos-id" });
    }
    await tick();
    expect(createOrganizationButtons()).toHaveLength(0);
    const picker = body.all().find((node) => node.attributes.get("aria-label") === "Organization");
    if (!picker) throw new Error("managed Organization picker missing");
    picker.value = "org-b";
    for (const listener of picker.listeners.get("change") ?? [])
      listener({ target: picker } as unknown as Event);
    await tick();
    expect(state.currentOrganization()?.id).toBe("org-b");
    expect(state.organizations().map((item) => item.id)).toEqual(["org-a", "org-b"]);
    expect(posts()).toHaveLength(0);
  });

  test(`managed session without an Organization gives guidance rather than a refused create (${kind})`, async () => {
    if (kind === "shared-auth") state.adoptSession("shared-auth");
    await tick();
    if (kind === "takos-id") {
      const current = state.principal();
      if (!current) throw new Error("fixture principal missing");
      state.principal.set({ ...current, provider: "takos-id" });
    }
    state.organizations.set([]);
    await tick();
    expect(createOrganizationButtons()).toHaveLength(0);
    expect(body.textContent).toContain("No organization available");
    expect(body.textContent).toContain("sign-in administrator");
    expect(posts()).toHaveLength(0);
  });
}

test("an old local create button cannot open a dialog after switching to shared login", async () => {
  const oldButton = createOrganizationButtons()[0];
  if (!oldButton) throw new Error("fixture local create button missing");
  state.adoptSession("shared-auth");
  await tick();
  oldButton.click();
  expect(body.all().filter((node) => node.attributes.get("role") === "dialog")).toHaveLength(0);
  expect(posts()).toHaveLength(0);
});

test("a projected sign-in cannot confirm a previously opened local create dialog", async () => {
  const confirm = openCreate();
  const current = state.principal();
  if (!current) throw new Error("fixture principal missing");
  state.principal.set({ ...current, provider: "takos-id" });
  confirm.click();
  await tick();
  expect(posts()).toHaveLength(0);
  expect(body.all().filter((node) => node.attributes.get("role") === "dialog")).toHaveLength(0);
});

test("switching back to local login restores the original create action", async () => {
  state.adoptSession("shared-auth");
  await tick();
  expect(createOrganizationButtons()).toHaveLength(0);
  state.adoptSession();
  await tick();
  openCreate().click();
  await tick();
  expect(posts()).toHaveLength(1);
  expect(posts()[0]?.url).toBe("https://api.example.test/v1/organizations");
  expect(await posts()[0]?.json()).toEqual({ name: "Fixture Org" });
});

for (const provider of ["local", "takos-id"] as const) {
  test(`pending identity lookup does not affirm local Organization creation (${provider})`, async () => {
    const oldButton = createOrganizationButtons()[0];
    if (!oldButton) throw new Error("fixture local create button missing");
    const me = await identityResponse().json();
    const answer = deferred();
    identityReply = () => answer.promise;
    state.adoptSession();
    await tick();
    expect(state.principal()).toBe(null);
    expect(createOrganizationButtons()).toHaveLength(0);
    oldButton.click();
    expect(body.all().filter((node) => node.attributes.get("role") === "dialog")).toHaveLength(0);
    expect(posts()).toHaveLength(0);
    answer.resolve(Response.json({ ...me, principal: { ...me.principal, provider } }));
    await tick();
    expect(createOrganizationButtons().length > 0).toBe(provider === "local");
  });
}

test("failed identity lookup gives unavailable guidance without a create action", async () => {
  identityReply = () => Response.json({ error: { code: "backend_unavailable" } }, { status: 503 });
  state.adoptSession();
  await tick();
  expect(state.principal()).toBe(null);
  expect(createOrganizationButtons()).toHaveLength(0);
  expect(body.textContent).toContain("Account details are not available yet");
  expect(body.textContent).not.toContain("No organization yet");
  expect(posts()).toHaveLength(0);
});
