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
  emit(name: string): void {
    for (const listener of this.listeners.get(name) ?? []) listener();
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
const discovery = { limits: { replayWindowSeconds: 3600 } };

async function setup(path = "/resources") {
  const body = installDom(path);
  const { consoleLocale } = await import("../console/src/i18n.ts");
  const { organizations, principal, selectOrganization, setApiOrigin } = await import(
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
  principal.set({
    id: "console-owner",
    provider: "google",
    email: "owner@example.test",
    displayName: "Owner",
  });
  selectOrganization("org-console");
  route.set({ path, segments: path.split("/").filter(Boolean), query: new URLSearchParams() });
  body.append(mountToasts() as unknown as TestNode);
  return { body, route, selectOrganization, principal };
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
      if (url.pathname === "/.well-known/takoform/v2") return Response.json(discovery);
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
  // The mock answers no known Form, so the exact URL field is the control.
  await settle();
  const inputs = body.all().filter((node) => node.tag === "input");
  if (!inputs[0] || !inputs[1]) throw new Error("create inputs missing");
  inputs[0].value = form;
  inputs[1].value = "one";
  inputs[1].emit("input");
  expect(body.textContent).toContain(
    JSON.stringify({ form, space: "org-console", name: "one", spec: {} }),
  );
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
  "%s keeps exact same-key retry across Console navigation",
  async (failure) => {
    const { body, route } = await setup();
    const { createResource } = await import("../console/src/pages/create-resource.ts");
    const { resourcesPage } = await import("../console/src/pages/resources.ts");
    const writes: Request[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const path = new URL(request.url).pathname;
        if (path.endsWith("/support"))
          return Response.json({ form, supported: true, operations: ["create"] });
        if (path === "/.well-known/takoform/v2") return Response.json(discovery);
        if (request.method === "GET") return Response.json({ items: [], nextCursor: null });
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
    expect(body.textContent).toContain("idempotency-key");
    await settle();
    const inputs = body.all().filter((node) => node.tag === "input");
    if (!inputs[0] || !inputs[1]) throw new Error("create inputs missing");
    inputs[0].value = form;
    inputs[1].value = "one";
    button(body, "Accept create").click();
    await settle();
    expect(writes).toHaveLength(1);
    expect(route().query.get("operation")).toBeNull();
    expect(route().query.get("acceptance")).toBe("unknown");
    expect(
      body.all().some((node) => node.tag === "button" && node.textContent === "Accept create"),
    ).toBe(false);
    body.append(resourcesPage("org-console") as unknown as TestNode);
    await settle();
    expect(body.textContent).toContain("Acceptance is unknown");
    expect(body.textContent).toContain("Retry exact request");
    expect(writes).toHaveLength(1);
    button(body, "Retry exact request").click();
    await settle();
    expect(writes).toHaveLength(2);
    expect(writes[0]?.headers.get("idempotency-key")).toBe(
      writes[1]?.headers.get("idempotency-key"),
    );
    expect(await writes[0]?.text()).toBe(await writes[1]?.text());
    expect(route().query.get("operation")).toBe(op.id);
  },
);

test("create offers the Forms this Host composes and sends the chosen exact URL", async () => {
  const { body } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  const worker = "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/";
  const endpoint = "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/";
  const asked: string[] = [];
  const writes: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/support")) {
        const asking = url.searchParams.get("form") ?? "";
        asked.push(asking);
        return Response.json({
          form: asking,
          supported: asking !== endpoint,
          operations: asking === endpoint ? [] : ["create", "read", "update", "delete"],
        });
      }
      if (url.pathname === "/.well-known/takoform/v2") return Response.json(discovery);
      writes.push(request.clone());
      return Response.json(op, { status: 202 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  const select = body.all().find((node) => node.tag === "select");
  const url = body.all().find((node) => node.tag === "input");
  if (!select || !url) throw new Error("Form choice missing");
  // The list is usable before the Host has answered.
  expect(select.disabled).toBe(false);
  expect(select.textContent).toContain("ModuleWorker 0.3.0");
  expect(body.textContent).toContain("Checking which Forms this Host supports");
  await settle();
  expect(asked).toHaveLength(16);
  expect(asked).toContain(worker);
  const options = select.all().filter((node) => node.tag === "option");
  const option = (label: string) => options.find((node) => node.textContent === label);
  expect(option("ModuleWorker 0.3.0")?.disabled).toBe(false);
  expect(option("WorkerEndpoint 0.3.0 — not on this Host")?.disabled).toBe(true);
  expect(option("Another exact Form URL…")).toBeDefined();
  expect(body.textContent).toContain("Only the Forms this Host supports can be chosen.");
  expect((url as unknown as { hidden: boolean }).hidden).toBe(true);
  select.value = worker;
  select.emit("change");
  const contract = body
    .all()
    .find((node) => node.tag === "a" && node.textContent.startsWith("ModuleWorker 0.3.0"));
  expect(contract?.attributes.get("href")).toBe(worker);
  expect(contract?.attributes.get("target")).toBe("_blank");
  expect(contract?.attributes.get("rel")).toBe("noopener noreferrer");
  const name = body.all().filter((node) => node.tag === "input")[1];
  if (!name) throw new Error("name input missing");
  name.value = "hello";
  button(body, "Accept create").click();
  await settle();
  expect(writes).toHaveLength(1);
  expect(JSON.parse(await (writes[0] as Request).text())).toEqual({
    form: worker,
    space: "org-console",
    name: "hello",
    spec: {},
  });
  select.value = "other";
  select.emit("change");
  expect((url as unknown as { hidden: boolean }).hidden).toBe(false);
});

test("create falls back to the exact URL field when the Host answers no Form", async () => {
  const { body } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  globalThis.fetch = Object.assign(async () => new Response("unavailable", { status: 503 }), {
    preconnect: globalThis.fetch.preconnect,
  });
  createResource("org-console");
  await settle();
  const select = body.all().find((node) => node.tag === "select") as unknown as {
    hidden: boolean;
  };
  const url = body.all().find((node) => node.tag === "input") as unknown as { hidden: boolean };
  expect(select.hidden).toBe(true);
  expect(url.hidden).toBe(false);
  expect(body.textContent).toContain(
    "Couldn't ask this Host which Forms it supports. Enter an exact Form URL.",
  );
});

test("a Form the Host did not answer for is marked, and typing a URL stays a plain hint", async () => {
  const { body } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  const workflow = "https://edge.forms.takoform.com/forms/DurableWorkflow/0.3.0/";
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      const asking = url.searchParams.get("form") ?? "";
      if (asking === workflow) return new Response("upstream failed", { status: 502 });
      return Response.json({ form: asking, supported: true, operations: ["create"] });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  await settle();
  const select = body.all().find((node) => node.tag === "select");
  if (!select) throw new Error("Form choice missing");
  const checked = select
    .all()
    .find((node) => node.tag === "option" && node.textContent.startsWith("DurableWorkflow"));
  expect(checked?.textContent).toBe("DurableWorkflow 0.3.0 — not checked");
  expect(checked?.disabled).toBe(false);
  select.value = "other";
  select.emit("change");
  const url = body.all().find((node) => node.tag === "input");
  if (!url) throw new Error("URL field missing");
  url.value = "https://forms.example.test/a/very/long/path/that/is/not/a/kind/and/version";
  url.emit("input");
  expect(body.textContent).toContain("The Host is asked whether it supports it");
  expect(
    body.all().some((node) => node.tag === "a" && node.textContent.includes("forms.example.test")),
  ).toBe(false);
});

test("delete requires explicit confirmation and retains the UID/generation fence", async () => {
  const { body, route } = await setup();
  const { deleteResource } = await import("../console/src/pages/create-resource.ts");
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json(discovery);
      seen.push(request);
      return Response.json({ ...op, action: "delete", generation: 2 }, { status: 202 });
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
      if (request.method === "GET") return Response.json(discovery);
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
      const url = new URL(request.url);
      if (url.pathname.endsWith("/support") && url.searchParams.get("form") !== form)
        return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      if (url.pathname.endsWith("/support"))
        return new Promise<Response>((resolve) => {
          release = resolve;
        });
      if (request.method === "GET") return Response.json(discovery);
      writes.push(request);
      return Response.json(op, { status: 202 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  await settle();
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

test("expired Host replay window refuses a second native mutation send", async () => {
  await setup();
  const {
    prepareResourceIntent,
    sendResourceIntent,
    canReplayResourceIntent,
    discardResourceIntent,
  } = await import("../console/src/resource-intent.ts");
  const intent = prepareResourceIntent(
    "org-console",
    { action: "delete", uid: one.uid, generation: 1 },
    60,
  );
  const writes: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      writes.push(request);
      throw new Error("ACK lost");
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  await expect(sendResourceIntent(intent.id, 10_000)).rejects.toMatchObject({
    code: "unreachable",
  });
  expect(canReplayResourceIntent(intent, 70_000)).toBe(false);
  await expect(sendResourceIntent(intent.id, 70_000)).rejects.toMatchObject({
    code: "replay_window_expired",
  });
  expect(writes).toHaveLength(1);
  discardResourceIntent(intent.id);
});

test("a different signed-in principal cannot inherit an in-memory replay handle", async () => {
  const { principal } = await setup();
  const { prepareResourceIntent, sendResourceIntent, discardResourceIntent } = await import(
    "../console/src/resource-intent.ts"
  );
  const intent = prepareResourceIntent(
    "org-console",
    { action: "delete", uid: one.uid, generation: 1 },
    60,
  );
  principal.set({
    id: "different-owner",
    provider: "google",
    email: "other@example.test",
    displayName: "Other",
  });
  const writes: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      writes.push(new Request(input, init));
      return Response.json({ ...op, action: "delete" }, { status: 202 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  await expect(sendResourceIntent(intent.id)).rejects.toMatchObject({ code: "principal_changed" });
  expect(writes).toHaveLength(0);
  discardResourceIntent(intent.id);
});

test("after a full reload without the in-memory exact intent, warning remains read-only", async () => {
  const { body, route, selectOrganization } = await setup();
  const { resourcesPage } = await import("../console/src/pages/resources.ts");
  selectOrganization("other");
  route.set({
    path: "/resources",
    segments: ["resources"],
    query: new URLSearchParams("acceptance=unknown&intent=lost-on-reload"),
  });
  const requests: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push(new Request(input, init));
      return Response.json({ items: [], nextCursor: null });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(resourcesPage("other") as unknown as TestNode);
  await settle();
  expect(body.textContent).toContain("Acceptance is unknown");
  expect(body.textContent).toContain("After a full reload without the exact request");
  expect(body.textContent).not.toContain("Retry exact request");
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});
