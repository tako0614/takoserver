import { afterEach, expect, test } from "bun:test";
import type { ResourceSummary } from "../console/src/api.ts";

class TestNode {
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<() => void>>();
  readonly style = {};
  readonly dataset = {};
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
  append(...values: Array<TestNode | string>): void {
    for (const value of values) {
      const child = typeof value === "string" ? new TestNode("text", value) : value;
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...values: Array<TestNode | string>): void {
    this.children.length = 0;
    this.append(...values);
  }
  remove(): void {
    const index = this.parent?.children.indexOf(this) ?? -1;
    if (index >= 0) this.parent?.children.splice(index, 1);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(name: string, listener: () => void): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  click(): void {
    if (!this.disabled) for (const listener of this.listeners.get("click") ?? []) listener();
  }
  focus(): void {}
  querySelector(): TestNode | null {
    return (
      this.all().find((node) => ["input", "textarea", "select", "button"].includes(node.tag)) ??
      null
    );
  }
  all(): TestNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

const saved = new Map(
  ["document", "window", "localStorage", "Node", "HTMLInputElement", "fetch"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});
function installDom(path = "/resources"): TestNode {
  const body = new TestNode("body");
  const values = new Map<string, string>();
  const location = new URL(`https://console.example.test${path}`);
  Object.assign(globalThis, {
    Node: TestNode,
    HTMLInputElement: TestNode,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    document: {
      body,
      documentElement: new TestNode("html"),
      createElement: (tag: string) => new TestNode(tag),
      createElementNS: (_ns: string, tag: string) => new TestNode(tag),
      createTextNode: (value: string) => new TestNode("text", value),
      createDocumentFragment: () => new TestNode("fragment"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    window: {
      location,
      addEventListener: () => undefined,
      scrollTo: () => undefined,
      history: {
        pushState: (_state: unknown, _title: string, next: string) => {
          location.href = new URL(next, location).href;
        },
      },
    },
  });
  return body;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}
function button(body: TestNode, label: string): TestNode {
  const found = body.all().find((node) => node.tag === "button" && node.textContent === label);
  if (!found) throw new Error(`missing button: ${label}`);
  return found;
}
const form = "https://forms.example.test/Widget/1.0.0";
const one: ResourceSummary = {
  uid: "uid-one",
  form,
  space: "org-console",
  name: "one",
  generation: 1,
  observedGeneration: 0,
  observedAt: null,
  phase: "pending",
  spec: {},
  observed: {},
  output: {},
  lastOperation: "op-one",
};
const two: ResourceSummary = { ...one, uid: "uid-two", name: "two" };
const op = {
  id: "op-one",
  resourceUid: one.uid,
  action: "create",
  generation: 1,
  status: "queued",
  effect: "none",
  createdAt: "2026-10-07T00:00:00Z",
  updatedAt: "2026-10-07T00:00:00Z",
  retainUntil: "2026-10-08T00:00:00Z",
};

async function setup(path = "/resources") {
  const body = installDom(path);
  const { consoleLocale } = await import("../console/src/i18n.ts");
  const { organizations, selectOrganization, setApiOrigin } = await import(
    "../console/src/state.ts"
  );
  const { route } = await import("../console/src/router.ts");
  const { mountToasts } = await import("../console/src/ui.ts");
  consoleLocale.set("en");
  setApiOrigin("https://api.example.test");
  organizations.set([
    { id: "org-console", name: "Console", ownerPrincipalId: "owner", createdAt: "2026-10-07" },
    { id: "other", name: "Other", ownerPrincipalId: "owner", createdAt: "2026-10-07" },
  ]);
  selectOrganization("org-console");
  route.set({ path, segments: path.split("/").filter(Boolean), query: new URLSearchParams() });
  body.append(mountToasts() as unknown as TestNode);
  return { body, route, selectOrganization };
}

test("accepted create is not shown as complete and checking it never re-sends", async () => {
  const { body, route } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  const { resourcesPage } = await import("../console/src/pages/resources.ts");
  const seen: Request[] = [];
  let checks = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/support"))
        return Response.json({ form, supported: true, operations: ["create"] });
      if (request.method === "POST") return Response.json(op, { status: 202 });
      if (url.pathname.includes("/operations/")) {
        checks += 1;
        return Response.json(
          checks === 1 ? op : { ...op, status: "succeeded", effect: "complete" },
        );
      }
      return Response.json({ items: [], nextCursor: null });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  const inputs = body.all().filter((node) => node.tag === "input");
  if (!inputs[0] || !inputs[1]) throw new Error("create inputs missing");
  inputs[0].value = form;
  inputs[1].value = "one";
  button(body, "Accept create").click();
  await settle();
  expect(route().query.get("operation")).toBe(op.id);
  body.append(resourcesPage("org-console") as unknown as TestNode);
  await settle();
  expect(body.textContent).toContain("queued · none");
  expect(body.textContent).not.toContain("View resource");
  button(body, "Reload").click();
  await settle();
  expect(body.textContent).toContain("View resource");
  expect(seen.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(checks).toBe(2);
});

test.each(["connection lost", "malformed accepted reply"] as const)(
  "%s never auto-resends and explicit retry retains the same key and body",
  async (failure) => {
    const { body, route } = await setup();
    const { createResource } = await import("../console/src/pages/create-resource.ts");
    const writes: Request[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).pathname.endsWith("/support"))
          return Response.json({ form, supported: true, operations: ["create"] });
        writes.push(request.clone());
        if (writes.length === 1) {
          if (failure === "connection lost") throw new Error("ACK lost");
          return Response.json({ id: "incomplete" }, { status: 202 });
        }
        return Response.json(op, { status: 202 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    createResource("org-console");
    const inputs = body.all().filter((node) => node.tag === "input");
    if (!inputs[0] || !inputs[1]) throw new Error("create inputs missing");
    inputs[0].value = form;
    inputs[1].value = "one";
    button(body, "Accept create").click();
    await settle();
    expect(writes).toHaveLength(1);
    expect(route().query.get("operation")).toBeNull();
    expect(body.textContent).toContain("Acceptance is unknown");
    button(body, "Accept create").click();
    await settle();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.headers.get("idempotency-key")).toBe(
      writes[1]?.headers.get("idempotency-key"),
    );
    expect(await writes[0]?.text()).toBe(await writes[1]?.text());
    expect(route().query.get("operation")).toBe(op.id);
  },
);

test("delete requires explicit confirmation and retains the UID/generation fence", async () => {
  const { body, route } = await setup();
  const { deleteResource } = await import("../console/src/pages/create-resource.ts");
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      return Response.json({ ...op, action: "delete" }, { status: 202 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  deleteResource("org-console", one);
  expect(seen).toHaveLength(0);
  expect(body.textContent).toContain("cannot be undone");
  button(body, "Delete resource").click();
  await settle();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.method).toBe("DELETE");
  expect(seen[0]?.headers.get("takoform-expected-generation")).toBe("1");
  expect(new URL(seen[0]?.url ?? "https://api.example.test").pathname).toBe(
    "/apis/forms.takoform.com/v2/resources/uid-one",
  );
  expect(route().query.get("operation")).toBe(op.id);
});

test("update uses the observed UID and generation rather than a name-based path", async () => {
  const { body, route } = await setup();
  const { updateResource } = await import("../console/src/pages/create-resource.ts");
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request);
      return Response.json({ ...op, action: "update", generation: 2 }, { status: 202 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  updateResource("org-console", one);
  const spec = body.all().find((node) => node.tag === "textarea");
  if (!spec) throw new Error("spec editor missing");
  spec.value = '{"value":"changed"}';
  button(body, "Accept update").click();
  await settle();
  expect(seen).toHaveLength(1);
  expect(seen[0]?.method).toBe("PUT");
  expect(seen[0]?.headers.get("takoform-expected-generation")).toBe("1");
  expect(new URL(seen[0]?.url ?? "https://api.example.test").pathname).toBe(
    "/apis/forms.takoform.com/v2/resources/uid-one",
  );
  expect(route().query.get("operation")).toBe(op.id);
});

test("organization switch during support read prevents a stale create send", async () => {
  const { body, selectOrganization } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  const writes: Request[] = [];
  let release: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/support"))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      writes.push(request);
      return Response.json(op, { status: 202 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  const inputs = body.all().filter((node) => node.tag === "input");
  if (!inputs[0] || !inputs[1]) throw new Error("create inputs missing");
  inputs[0].value = form;
  inputs[1].value = "one";
  button(body, "Accept create").click();
  selectOrganization("other");
  release?.(Response.json({ form, supported: true, operations: ["create"] }));
  await settle();
  expect(writes).toHaveLength(0);
  expect(body.textContent).toContain("Organization changed");
});

test("list appends cursor pages and discards a pending page after organization switch", async () => {
  const { body, selectOrganization } = await setup();
  const { resourcesPage } = await import("../console/src/pages/resources.ts");
  let release: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!url.searchParams.has("cursor"))
        return Response.json({ items: [one], nextCursor: "next" });
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(resourcesPage("org-console") as unknown as TestNode);
  await settle();
  expect(body.textContent).toContain("one");
  button(body, "Load more").click();
  selectOrganization("other");
  release?.(Response.json({ items: [two], nextCursor: null }));
  await settle();
  expect(body.textContent).not.toContain("two");
});

test("list appends the next v2 cursor page without repeating the request on rapid clicks", async () => {
  const { body } = await setup();
  const { resourcesPage } = await import("../console/src/pages/resources.ts");
  let cursorCalls = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (!url.searchParams.has("cursor"))
        return Response.json({ items: [one], nextCursor: "next" });
      cursorCalls += 1;
      return Response.json({ items: [two], nextCursor: null });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(resourcesPage("org-console") as unknown as TestNode);
  await settle();
  const more = button(body, "Load more");
  more.click();
  more.click();
  await settle();
  expect(cursorCalls).toBe(1);
  expect(body.textContent).toContain("one");
  expect(body.textContent).toContain("two");
  expect(body.textContent).not.toContain("Load more");
});
