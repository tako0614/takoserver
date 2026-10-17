import { afterEach, expect, test } from "bun:test";
import type { ResourceSummary } from "../console/src/api.ts";
import { valueAt } from "../console/src/form-specs.ts";

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
/** The last button with this label: a dialog's, when a page under it has one too. */
function button(body: TestNode, label: string): TestNode {
  const found = body
    .all()
    .reverse()
    .find((node) => node.tag === "button" && node.textContent === label);
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

test("a refused create says why in the dialog, and how to change the request", async () => {
  const { body } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  const posts: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/support"))
        return Response.json({ form, supported: true, operations: ["create"] });
      if (url.pathname === "/.well-known/takoform/v2") return Response.json(discovery);
      if (request.method === "POST") {
        posts.push(request);
        return new Response(
          JSON.stringify({
            type: "about:blank",
            title: "Conflict",
            status: 409,
            code: "name_conflict",
          }),
          { status: 409, headers: { "content-type": "application/problem+json" } },
        );
      }
      return Response.json({ items: [], nextCursor: null });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  await settle();
  const inputs = body.all().filter((node) => node.tag === "input");
  if (!inputs[0] || !inputs[1]) throw new Error("create inputs missing");
  inputs[0].value = form;
  inputs[1].value = "one";
  inputs[1].emit("input");
  button(body, "Create").click();
  await settle();
  expect(posts).toHaveLength(1);
  // Said in the dialog, where it stays until the next attempt, not in a passing toast.
  const alert = body.all().find((node) => node.attributes.get("role") === "alert");
  expect(alert?.textContent).toContain(
    "Another Resource in this organization already has that name, whatever its Form.",
  );
  expect(alert?.textContent).toContain("To change the request, cancel and open the dialog again.");
});

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
  button(body, "Create").click();
  await settle();
  expect(route().query.get("operation")).toBe(op.id);
  body.append(resourcesPage("org-console") as unknown as TestNode);
  await settle();
  expect(body.textContent).toContain("In progress. Checking automatically.");
  expect(body.textContent).toContain("(queued)");
  expect(body.textContent).not.toContain("View resource");
  button(body, "Reload").click();
  await settle();
  expect(body.textContent).toContain("View resource");
  expect(seen.filter((request) => request.method === "POST")).toHaveLength(1);
  expect(checks).toBe(2);
});

type Answer = Record<string, unknown>;

/** The Resources page of an accepted operation whose checks answer from `answers`, in turn. */
async function operationPage(answers: Array<Answer | Promise<Answer>>) {
  const { body, route } = await setup();
  const { resourcesPage } = await import("../console/src/pages/resources.ts");
  let checks = 0;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.includes("/operations/")) {
        const answer = answers[Math.min(checks, answers.length - 1)];
        checks += 1;
        return Response.json(await answer);
      }
      return Response.json({ items: [one], nextCursor: null });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  route.set({
    path: "/resources",
    segments: ["resources"],
    query: new URLSearchParams(`operation=${op.id}`),
  });
  body.append(resourcesPage("org-console") as unknown as TestNode);
  return { body, checks: () => checks };
}

test("an accepted operation is followed until it settles, without pressing Reload", async () => {
  await setup();
  const { OPERATION_FOLLOW } = await import("../console/src/pages/resources.ts");
  const saved = { ...OPERATION_FOLLOW };
  OPERATION_FOLLOW.intervalMs = 5;
  try {
    const { body, checks } = await operationPage([
      op,
      { ...op, status: "running" },
      { ...op, status: "succeeded", effect: "complete" },
    ]);
    for (let i = 0; i < 20 && checks() < 3; i += 1) await new Promise((r) => setTimeout(r, 10));
    await settle();
    expect(checks()).toBe(3);
    expect(body.textContent).toContain("Done");
    expect(body.textContent).toContain("View resource");
    expect(body.textContent).not.toContain("In progress");
  } finally {
    Object.assign(OPERATION_FOLLOW, saved);
  }
});

test("a check in progress keeps the last answer on screen", async () => {
  await setup();
  const { OPERATION_FOLLOW } = await import("../console/src/pages/resources.ts");
  const saved = { ...OPERATION_FOLLOW };
  OPERATION_FOLLOW.intervalMs = 5;
  try {
    let release: (answer: Answer) => void = () => {};
    const held = new Promise<Answer>((resolve) => {
      release = resolve;
    });
    const { body, checks } = await operationPage([op, held]);
    for (let i = 0; i < 20 && checks() < 2; i += 1) await new Promise((r) => setTimeout(r, 10));
    await settle();
    // The second check has not answered; the card still says how the first one stood.
    expect(checks()).toBe(2);
    expect(body.textContent).toContain("In progress. Checking automatically.");
    expect(body.textContent).toContain("(queued)");
    release({ ...op, status: "succeeded", effect: "complete" });
    for (let i = 0; i < 20 && !body.textContent.includes("Done"); i += 1)
      await new Promise((r) => setTimeout(r, 10));
    await settle();
    expect(body.textContent).toContain("Done");
  } finally {
    Object.assign(OPERATION_FOLLOW, saved);
  }
});

test("following stops after its budget and then asks for Reload", async () => {
  await setup();
  const { OPERATION_FOLLOW } = await import("../console/src/pages/resources.ts");
  const saved = { ...OPERATION_FOLLOW };
  OPERATION_FOLLOW.budgetMs = 0;
  try {
    const { body, checks } = await operationPage([op]);
    await settle();
    expect(checks()).toBe(1);
    expect(body.textContent).toContain("Not complete yet. Use Reload to check again.");
  } finally {
    Object.assign(OPERATION_FOLLOW, saved);
  }
});

test("a failed operation says so with the Host's message", async () => {
  const { body } = await operationPage([
    {
      ...op,
      status: "failed",
      effect: "none",
      error: {
        code: "dependency_conflict",
        message: "WorkerDeployment for this Worker is missing",
      },
    },
  ]);
  await settle();
  expect(body.textContent).toContain(
    "Failed: WorkerDeployment for this Worker is missing (dependency_conflict)",
  );
  // Whether anything changed is said with the failure.
  expect(body.textContent).toContain("Nothing was changed.");
});

test("a failed operation that changed some things says to check the Resource", async () => {
  const { body } = await operationPage([
    {
      ...op,
      status: "failed",
      effect: "partial",
      error: { code: "worker_unavailable", message: "workerd stopped" },
    },
  ]);
  await settle();
  expect(body.textContent).toContain("Partly applied. Check the Resource.");
});

test("a rebuilt page leaves only one loop following the operation", async () => {
  await setup();
  const { OPERATION_FOLLOW, resourcesPage } = await import("../console/src/pages/resources.ts");
  const saved = { ...OPERATION_FOLLOW };
  OPERATION_FOLLOW.intervalMs = 5;
  try {
    // Two builds each read once; then one loop reads the third answer and
    // stops. Two loops would read a fourth time.
    const { body, checks } = await operationPage([
      op,
      op,
      { ...op, status: "succeeded", effect: "complete" },
    ]);
    body.append(resourcesPage("org-console") as unknown as TestNode);
    let seen = -1;
    for (let i = 0; i < 40 && seen !== checks(); i += 1) {
      seen = checks();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(checks()).toBe(3);
  } finally {
    Object.assign(OPERATION_FOLLOW, saved);
  }
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
    button(body, "Create").click();
    await settle();
    expect(writes).toHaveLength(1);
    expect(route().query.get("operation")).toBeNull();
    expect(route().query.get("acceptance")).toBe("unknown");
    expect(body.all().some((node) => node.tag === "button" && node.textContent === "Create")).toBe(
      false,
    );
    body.append(resourcesPage("org-console") as unknown as TestNode);
    await settle();
    expect(body.textContent).toContain("Acceptance is unknown");
    // While the exact request can still be resent, that is the advice.
    expect(body.textContent).toContain(
      "Use “Retry exact request”: it sends the same request under the same key. If the Host already accepted it, it returns that same Operation; if not, it accepts it now.",
    );
    expect(body.textContent).not.toContain("it can no longer resend it exactly");
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

test("a request past its replay window gets the read-first advice, not the retry", async () => {
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
      // A one-second window has already closed, less its margin, once the request is sent.
      if (path === "/.well-known/takoform/v2")
        return Response.json({ limits: { replayWindowSeconds: 1 } });
      if (request.method === "GET") return Response.json({ items: [], nextCursor: null });
      writes.push(request.clone());
      throw new Error("ACK lost");
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  await settle();
  const inputs = body.all().filter((node) => node.tag === "input");
  if (!inputs[0] || !inputs[1]) throw new Error("create inputs missing");
  inputs[0].value = form;
  inputs[1].value = "one";
  button(body, "Create").click();
  await settle();
  expect(writes).toHaveLength(1);
  expect(route().query.get("acceptance")).toBe("unknown");
  body.append(resourcesPage("org-console") as unknown as TestNode);
  await settle();
  expect(body.textContent).toContain("it can no longer resend it exactly");
  expect(body.textContent).not.toContain("Use “Retry exact request”");
  expect(body.textContent).toContain("Replay window expired");
});

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
  button(body, "Create").click();
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

test("create starts from the chosen Form's smallest spec and fills references by choice", async () => {
  const { body } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  const edge = "https://edge.forms.takoform.com/forms";
  const deployment = `${edge}/WorkerDeployment/0.4.0/`;
  const listed = (uid: string, name: string, kind: string): ResourceSummary => ({
    ...one,
    uid,
    name,
    form: `${edge}/${kind}/`,
  });
  const byForm = new Map([
    [`${edge}/ModuleWorker/0.3.0/`, [listed("uid-worker", "hello", "ModuleWorker/0.3.0")]],
    [`${edge}/WorkerVersion/0.5.0/`, [listed("uid-version", "hello-v1", "WorkerVersion/0.5.0")]],
  ]);
  const writes: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/support")) {
        const asking = url.searchParams.get("form") ?? "";
        return Response.json({ form: asking, supported: true, operations: ["create"] });
      }
      if (url.pathname === "/.well-known/takoform/v2") return Response.json(discovery);
      if (request.method === "GET" && url.pathname.endsWith("/resources")) {
        const items = byForm.get(url.searchParams.get("form") ?? "") ?? [];
        return Response.json({ items, nextCursor: null });
      }
      writes.push(request.clone());
      return Response.json(op, { status: 202 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  await settle();
  const [select] = body.all().filter((node) => node.tag === "select");
  const spec = body.all().find((node) => node.tag === "textarea");
  const name = body.all().filter((node) => node.tag === "input")[1];
  if (!select || !spec || !name) throw new Error("create dialog incomplete");
  select.value = deployment;
  select.emit("change");
  await settle();
  expect(JSON.parse(spec.value)).toEqual({
    worker: { resourceUid: "" },
    versions: [{ workerVersion: { resourceUid: "" }, weight: 10000 }],
  });
  expect(body.textContent).toContain("versions[0].workerVersion — WorkerVersion 0.5.0");
  const [, worker, version] = body.all().filter((node) => node.tag === "select");
  if (!worker || !version) throw new Error("reference choices missing");
  expect(worker.textContent).toContain("hello");
  worker.value = "uid-worker";
  worker.emit("change");
  expect(JSON.parse(spec.value).worker).toEqual({ resourceUid: "uid-worker" });
  // An empty reference is named instead of being sent for the Host to refuse.
  name.value = "hello-deployment";
  button(body, "Create").click();
  await settle();
  expect(writes).toHaveLength(0);
  expect(body.textContent).toContain("Still empty: versions[0].workerVersion");
  version.value = "uid-version";
  version.emit("change");
  button(body, "Create").click();
  await settle();
  expect(writes).toHaveLength(1);
  expect(JSON.parse(await (writes[0] as Request).text())).toEqual({
    form: deployment,
    space: "org-console",
    name: "hello-deployment",
    spec: {
      worker: { resourceUid: "uid-worker" },
      versions: [{ workerVersion: { resourceUid: "uid-version" }, weight: 10000 }],
    },
  });
});

const edgeForms = "https://edge.forms.takoform.com/forms";
const listedAs = (uid: string, name: string, kind: string): ResourceSummary => ({
  ...one,
  uid,
  name,
  form: `${edgeForms}/${kind}/`,
});

test("an edited spec is never overwritten; only the replace button writes a starter", async () => {
  const { body } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  const answers: Array<() => void> = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/support")) {
        const asking = url.searchParams.get("form") ?? "";
        // Support answers arrive only when the test releases them.
        await new Promise<void>((resolve) => answers.push(resolve));
        return Response.json({ form: asking, supported: true, operations: ["create"] });
      }
      if (url.pathname.endsWith("/resources")) {
        const wanted = url.searchParams.get("form");
        const items =
          wanted === `${edgeForms}/ModuleWorker/0.3.0/`
            ? [listedAs("uid-worker", "hello", "ModuleWorker/0.3.0")]
            : [];
        return Response.json({ items, nextCursor: null });
      }
      return Response.json(discovery);
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  const [select] = body.all().filter((node) => node.tag === "select");
  const spec = body.all().find((node) => node.tag === "textarea");
  if (!select || !spec) throw new Error("create dialog incomplete");
  // Chosen before the Host has answered about any Form.
  select.value = `${edgeForms}/QueueConsumer/0.3.0/`;
  select.emit("change");
  await settle();
  expect(JSON.parse(spec.value).maxBatchSize).toBe(10);
  // A chosen Resource is carried to the next Form's same place.
  const worker = body.all().filter((node) => node.tag === "select")[2];
  if (!worker) throw new Error("worker choice missing");
  worker.value = "uid-worker";
  worker.emit("change");
  select.value = `${edgeForms}/WorkerEndpoint/0.3.0/`;
  select.emit("change");
  await settle();
  expect(JSON.parse(spec.value)).toEqual({ worker: { resourceUid: "uid-worker" } });
  // Typed into, the spec belongs to the person.
  spec.value = '{ "worker": { "resourceUid": "typed-by-hand" } }';
  spec.emit("input");
  for (const answer of answers.splice(0)) answer();
  await settle();
  expect(spec.value).toBe('{ "worker": { "resourceUid": "typed-by-hand" } }');
  select.value = `${edgeForms}/ActorNamespace/0.3.0/`;
  select.emit("change");
  await settle();
  expect(spec.value).toBe('{ "worker": { "resourceUid": "typed-by-hand" } }');
  expect(body.textContent).toContain("Your spec is kept.");
  button(body, "Replace with the smallest ActorNamespace 0.3.0 spec").click();
  expect(JSON.parse(spec.value)).toEqual({ worker: { resourceUid: "" }, className: "" });
  expect(body.textContent).toContain("Fill in the empty values.");
  // An exact URL typed by hand gets its starter too, once the spec is the Console's again.
  select.value = "other";
  select.emit("change");
  const url = body.all().find((node) => node.tag === "input");
  if (!url) throw new Error("URL field missing");
  url.value = `${edgeForms}/WorkerCronTrigger/0.3.0/`;
  url.emit("input");
  expect(JSON.parse(spec.value)).toEqual({ worker: { resourceUid: "" }, cron: "" });
});

test("reference choices say when a list failed, is empty or goes on, and lock while sending", async () => {
  const { body } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  const consumer = `${edgeForms}/QueueConsumer/0.3.0/`;
  let supportAsked = 0;
  let lockedWhileAsking: boolean[] = [];
  let choices: TestNode[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname.endsWith("/support")) {
        const asking = url.searchParams.get("form") ?? "";
        if (asking === consumer) supportAsked += 1;
        // The create's own check finds the Form gone from this Host.
        const supported = !(asking === consumer && supportAsked > 1);
        if (asking === consumer && supportAsked > 1)
          lockedWhileAsking = choices.map((node) => node.disabled);
        return Response.json({ form: asking, supported, operations: supported ? ["create"] : [] });
      }
      if (url.pathname.endsWith("/resources")) {
        const wanted = url.searchParams.get("form");
        if (wanted === `${edgeForms}/WorkerVersion/0.5.0/`)
          return Response.json({ error: { code: "unavailable" } }, { status: 503 });
        if (wanted === `${edgeForms}/AtLeastOnceQueue/0.2.0/`)
          return Response.json({
            items: [listedAs("uid-queue", "jobs", "AtLeastOnceQueue/0.2.0")],
            nextCursor: "more",
          });
        if (wanted === `${edgeForms}/ModuleWorker/0.3.0/`)
          return Response.json({
            items: [listedAs("uid-worker", "hello", "ModuleWorker/0.3.0")],
            nextCursor: null,
          });
        return Response.json({ items: [], nextCursor: null });
      }
      return Response.json(discovery);
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  await settle();
  const [select] = body.all().filter((node) => node.tag === "select");
  const name = body.all().filter((node) => node.tag === "input")[1];
  if (!select || !name) throw new Error("create dialog incomplete");
  select.value = `${edgeForms}/SQLiteMigrationApplication/0.2.0/`;
  select.emit("change");
  await settle();
  const [, database] = body.all().filter((node) => node.tag === "select");
  expect(database?.textContent).toContain("None yet");
  expect(database?.disabled).toBe(true);
  select.value = `${edgeForms}/WorkerDeployment/0.4.0/`;
  select.emit("change");
  await settle();
  const version = body.all().filter((node) => node.tag === "select")[2];
  expect(version?.textContent).toContain("Couldn't load");
  expect(version?.disabled).toBe(true);
  select.value = consumer;
  select.emit("change");
  await settle();
  choices = body
    .all()
    .filter((node) => node.tag === "select")
    .slice(1);
  const [queue, worker] = choices;
  if (!queue || !worker) throw new Error("consumer choices missing");
  expect(queue.textContent).toContain("Others: write the UID");
  queue.value = "uid-queue";
  queue.emit("change");
  worker.value = "uid-worker";
  worker.emit("change");
  name.value = "jobs-consumer";
  button(body, "Create").click();
  await settle();
  expect(lockedWhileAsking).toEqual([true, true]);
  expect(body.textContent).toContain("This Host does not support create for that exact Form");
  expect(choices.map((node) => node.disabled)).toEqual([false, false]);
});

test("an artifact Form's starter says where its url and sha256 come from", async () => {
  const { body } = await setup();
  const { createResource } = await import("../console/src/pages/create-resource.ts");
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(new Request(input, init).url);
      if (url.pathname.endsWith("/support")) {
        const asking = url.searchParams.get("form") ?? "";
        return Response.json({ form: asking, supported: true, operations: ["create"] });
      }
      if (url.pathname.endsWith("/resources"))
        return Response.json({ items: [], nextCursor: null });
      return Response.json(discovery);
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  createResource("org-console");
  await settle();
  const [select] = body.all().filter((node) => node.tag === "select");
  if (!select) throw new Error("Form choice missing");
  select.value = `${edgeForms}/WorkerBundle/0.2.0/`;
  select.emit("change");
  await settle();
  expect(body.textContent).toContain(
    "url and sha256 are the artifact that scripts/selfhost-artifact.ts seed prints (then restart the Host;",
  );
  const step = body
    .all()
    .find((node) => node.tag === "a" && node.textContent.startsWith("step 6 of the install guide"));
  expect(step?.attributes.get("href")).toBe(
    "https://github.com/tako0614/takoserver/blob/main/docs/self-host-operations.md#6-seed-held-artifacts",
  );
  // A Form without an artifact says nothing about one.
  select.value = `${edgeForms}/ModuleWorker/0.3.0/`;
  select.emit("change");
  await settle();
  expect(body.textContent).not.toContain("url and sha256 are the artifact");
});

const versionForm = "https://edge.forms.takoform.com/forms/WorkerVersion/0.5.0/";
const deploymentForm = "https://edge.forms.takoform.com/forms/WorkerDeployment/0.4.0/";
const resourceAt = (
  uid: string,
  name: string,
  form: string,
  spec: ResourceSummary["spec"],
): ResourceSummary => ({
  ...one,
  uid,
  name,
  form,
  generation: 3,
  observedGeneration: 3,
  observedAt: "2026-10-07T00:00:00Z",
  phase: "idle" as const,
  spec,
});
const helloV2: ResourceSummary = {
  ...resourceAt("uid-version", "hello-v2", versionForm, {
    worker: { resourceUid: "uid-worker" },
    handlers: ["fetch"],
  }),
  observed: { ready: true },
};
/** A Deployment of uid-worker as the Host returns it: keys sorted, as canonical JSON stores them. */
const deploymentOf = (
  versions: ResourceSummary["spec"][],
  change: Partial<ResourceSummary> = {},
) => ({
  ...resourceAt("uid-deployment", "hello-deployment", deploymentForm, {
    versions,
    worker: { resourceUid: "uid-worker" },
  }),
  ...change,
});

/**
 * A Resource's page against a Host whose Deployments are `deployments` and
 * whose full list is `listed`. The Resource is read from `shown` on every
 * request, so a test can change it between reads.
 */
async function detailPage(
  shown: () => ResourceSummary,
  deployments: ResourceSummary[],
  listed: ResourceSummary[] = [],
) {
  const uid = shown().uid;
  const { body } = await setup(`/resources/${uid}`);
  const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
  const writes: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.pathname === "/.well-known/takoform/v2") return Response.json(discovery);
      if (url.pathname.endsWith("/support")) {
        const asking = url.searchParams.get("form") ?? "";
        return Response.json({ form: asking, supported: true, operations: ["create", "update"] });
      }
      if (request.method !== "GET") {
        writes.push(request.clone());
        return Response.json(op, { status: 202 });
      }
      if (url.pathname.endsWith(`/resources/${uid}`)) return Response.json(shown());
      if (url.pathname.endsWith("/resources")) {
        const form = url.searchParams.get("form");
        const items =
          form === deploymentForm
            ? deployments
            : form === null
              ? listed
              : listed.filter((item) => item.form === form);
        return Response.json({ items, nextCursor: null });
      }
      return Response.json({ error: { code: "not_found" } }, { status: 404 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(resourceDetailPage("org-console", uid) as unknown as TestNode);
  await settle();
  return { body, writes };
}

/** A WorkerVersion's page against a Host whose Deployments are `deployments`. */
const versionPage = (deployments: ResourceSummary[], version: ResourceSummary = helloV2) =>
  detailPage(() => version, deployments);

test("a WorkerVersion's page serves it by updating the Worker's Deployment", async () => {
  const deployment = deploymentOf([{ weight: 10000, workerVersion: { resourceUid: "uid-v1" } }]);
  const { body, writes } = await versionPage([deployment]);
  button(body, "Serve this version").click();
  await settle();
  expect(body.textContent).toContain(
    "This updates hello-deployment to serve only hello-v2, at weight 10000. Check it, then choose Update.",
  );
  // Nothing is sent until the person chooses Update.
  expect(writes).toHaveLength(0);
  button(body, "Update").click();
  await settle();
  expect(writes).toHaveLength(1);
  const [update] = writes;
  expect(update?.method).toBe("PUT");
  expect(new URL(update?.url ?? "").pathname).toEndWith("/resources/uid-deployment");
  expect(update?.headers.get("takoform-expected-generation")).toBe("3");
  expect(JSON.parse(await (update as Request).text())).toEqual({
    spec: {
      worker: { resourceUid: "uid-worker" },
      versions: [{ workerVersion: { resourceUid: "uid-version" }, weight: 10000 }],
    },
  });
});

test("a version a Deployment already names alone reports how that change stands", async () => {
  const only = [{ weight: 10000, workerVersion: { resourceUid: "uid-version" } }];
  const served = await versionPage([deploymentOf(only)]);
  expect(served.body.textContent).toContain("Serving this version: hello-deployment");
  expect(
    served.body
      .all()
      .some((node) => node.tag === "button" && node.textContent === "Serve this version"),
  ).toBe(false);
  // The spec names it, but the Host has not applied that yet, or failed to.
  const pending = await versionPage([deploymentOf(only, { observedGeneration: 2 })]);
  expect(pending.body.textContent).toContain("The Deployment is updating: hello-deployment");
  expect(pending.body.textContent).not.toContain("Serving this version");
  // As a real Host leaves them: a failed or deleting change raised the
  // generation, and the Host never observed it.
  const failed = await versionPage([
    deploymentOf(only, { phase: "error", generation: 4, observedGeneration: 3 }),
  ]);
  expect(failed.body.textContent).toContain("The Deployment's update failed: hello-deployment");
  const deleting = await versionPage([
    deploymentOf(only, { phase: "deleting", generation: 4, observedGeneration: 3 }),
  ]);
  expect(deleting.body.textContent).toContain("The Deployment is being deleted: hello-deployment");
  expect(deleting.body.textContent).not.toContain("Serving this version");
  const unread = await versionPage([deploymentOf(only, { observedAt: null })]);
  expect(unread.body.textContent).not.toContain("Serving this version");
});

test("serving one version says when it replaces a split", async () => {
  const { body } = await versionPage([
    deploymentOf([
      { weight: 9000, workerVersion: { resourceUid: "uid-v1" } },
      { weight: 1000, workerVersion: { resourceUid: "uid-version" } },
    ]),
  ]);
  button(body, "Serve this version").click();
  await settle();
  expect(body.textContent).toContain(
    "It serves 2 versions now; after this update it serves only hello-v2. This updates hello-deployment. Check it, then choose Update.",
  );
});

test("a version that is not ready is not offered for serving", async () => {
  const { body } = await versionPage([], { ...helloV2, observed: { ready: false } });
  expect(body.textContent).toContain("This version can be served once it is Ready");
  expect(
    body.all().some((node) => node.tag === "button" && node.textContent === "Serve this version"),
  ).toBe(false);
});

test("Reload reads the version and its Deployment again", async () => {
  let version: ResourceSummary = { ...helloV2, observed: { ready: false } };
  const deployments = [deploymentOf([{ weight: 10000, workerVersion: { resourceUid: "uid-v1" } }])];
  const { body } = await detailPage(() => version, deployments);
  expect(body.textContent).toContain("This version can be served once it is Ready");
  // The version became ready: Reload offers to serve it.
  version = helloV2;
  button(body, "Reload").click();
  await settle();
  expect(body.textContent).not.toContain("This version can be served once it is Ready");
  button(body, "Serve this version");
  // The Deployment now serves it: Reload says so instead.
  deployments[0] = deploymentOf([{ weight: 10000, workerVersion: { resourceUid: "uid-version" } }]);
  button(body, "Reload").click();
  await settle();
  expect(body.textContent).toContain("Serving this version: hello-deployment");
});

const moduleWorkerForm = "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/";
/** hello as the Host leaves it when it was created before its Deployment. */
const unrecordedWorker: ResourceSummary = {
  ...resourceAt("uid-worker", "hello", moduleWorkerForm, {}),
  observed: { activeDeploymentUid: null, ready: false },
};
const servingDeployment = deploymentOf(
  [{ weight: 10000, workerVersion: { resourceUid: "uid-v1" } }],
  {
    observed: { active: true, ready: true },
  },
);
/** hello's Endpoint, published: its route and its certificate are ready. */
const publishedEndpoint: ResourceSummary = {
  ...resourceAt(
    "uid-endpoint",
    "hello-endpoint",
    "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/",
    { worker: { resourceUid: "uid-worker" } },
  ),
  observed: { activeDeploymentRouteReady: true, tlsReady: true },
};

test("a Worker that has not recorded the Deployment serving it offers to record it", async () => {
  const { body, writes } = await detailPage(
    () => unrecordedWorker,
    [servingDeployment],
    [servingDeployment, publishedEndpoint],
  );
  expect(body.textContent).toContain(
    "This Worker has not recorded hello-deployment, which serves it: the Host records a Worker's Deployment only when the Worker itself is applied.",
  );
  expect(body.textContent).toContain(
    "Until it does, the Host reports it NotReady, and a WorkerCronTrigger for it cannot finish being applied, so it never runs.",
  );
  expect(body.textContent).not.toContain("The latest observation reports not ready.");
  button(body, "Record the Deployment").click();
  await settle();
  expect(body.textContent).toContain(
    "This updates hello with the same spec, so that it records hello-deployment. Check it, then choose Update.",
  );
  expect(writes).toHaveLength(0);
  button(body, "Update").click();
  await settle();
  const [update] = writes;
  expect(update?.method).toBe("PUT");
  expect(new URL(update?.url ?? "").pathname).toEndWith("/resources/uid-worker");
  expect(update?.headers.get("takoform-expected-generation")).toBe("3");
  expect(JSON.parse(await (update as Request).text())).toEqual({ spec: {} });
});

test("a Worker is offered to record a Deployment only when one serves it unrecorded", async () => {
  // It already records the Deployment: nothing to say.
  const recorded = await detailPage(
    () => ({
      ...unrecordedWorker,
      observed: { activeDeploymentUid: "uid-deployment", ready: true },
    }),
    [servingDeployment],
  );
  expect(recorded.body.textContent).not.toContain("has not recorded");
  // Its Deployment is not active, or not ready: the plain notice stays.
  for (const deployment of [
    deploymentOf([], { observed: { active: false, ready: true } }),
    deploymentOf([], { observed: { active: true, ready: false } }),
  ]) {
    const { body } = await detailPage(() => unrecordedWorker, [deployment]);
    expect(body.textContent).toContain("The latest observation reports not ready.");
    expect(body.textContent).not.toContain("Record the Deployment");
  }
  // No Deployment at all.
  const alone = await detailPage(() => unrecordedWorker, []);
  expect(alone.body.textContent).toContain("The latest observation reports not ready.");
  expect(alone.body.textContent).not.toContain("Record the Deployment");
});

test("the record update is offered only where the Host can finish it", async () => {
  const offered = (body: TestNode) =>
    body
      .all()
      .some((node) => node.tag === "button" && node.textContent === "Record the Deployment");
  // An Endpoint that failed would keep the update reconciling and the Worker busy.
  const failed = await detailPage(
    () => unrecordedWorker,
    [servingDeployment],
    [servingDeployment, { ...publishedEndpoint, phase: "error", generation: 4 }],
  );
  expect(failed.body.textContent).toContain(
    "Re-apply or delete hello-endpoint first. Until it is Ready, this update cannot finish, and it would hold the Worker busy meanwhile.",
  );
  expect(offered(failed.body)).toBe(false);
  // Ready but without its certificate is not published either.
  const noTls = await detailPage(
    () => unrecordedWorker,
    [servingDeployment],
    [servingDeployment, { ...publishedEndpoint, observed: { activeDeploymentRouteReady: true } }],
  );
  expect(noTls.body.textContent).toContain("Re-apply or delete hello-endpoint first.");
  expect(offered(noTls.body)).toBe(false);
  // Anything naming the Worker still in progress: the Host would refuse it.
  const pendingVersion = {
    ...resourceAt("uid-v9", "hello-v9", versionForm, { worker: { resourceUid: "uid-worker" } }),
    generation: 4,
  };
  const pending = await detailPage(
    () => unrecordedWorker,
    [servingDeployment],
    [servingDeployment, publishedEndpoint, pendingVersion],
  );
  expect(pending.body.textContent).toContain(
    "hello-v9 is in progress. Wait until it finishes: the Host refuses this update while anything that names the Worker is in progress.",
  );
  expect(offered(pending.body)).toBe(false);
});

test("a WorkerCronTrigger stuck on the Worker is not something to wait for", async () => {
  const trigger = {
    ...resourceAt(
      "uid-cron",
      "hello-cron",
      "https://edge.forms.takoform.com/forms/WorkerCronTrigger/0.3.0/",
      { worker: { resourceUid: "uid-worker" }, cron: "*/5 * * * *" },
    ),
    generation: 4,
  };
  const { body } = await detailPage(
    () => unrecordedWorker,
    [servingDeployment],
    [servingDeployment, publishedEndpoint, trigger],
  );
  expect(body.textContent).toContain(
    "hello-cron cannot finish until this Worker records hello-deployment, and the Host refuses that update while it is in progress. Neither can be resolved from the console; it needs a fix on the Host.",
  );
  expect(body.textContent).not.toContain("Wait until");
  expect(
    body
      .all()
      .some((node) => node.tag === "button" && node.textContent === "Record the Deployment"),
  ).toBe(false);
  // Its delete does not read the Worker, so that one is worth waiting for.
  const deleting = await detailPage(
    () => unrecordedWorker,
    [servingDeployment],
    [servingDeployment, publishedEndpoint, { ...trigger, phase: "deleting" }],
  );
  expect(deleting.body.textContent).toContain("hello-cron is in progress. Wait until it finishes");
  expect(deleting.body.textContent).not.toContain("cannot finish until this Worker records");
  expect(
    deleting.body
      .all()
      .some((node) => node.tag === "button" && node.textContent === "Record the Deployment"),
  ).toBe(false);
});

test("a Worker that still names an earlier Deployment is out of date too", async () => {
  const { body } = await detailPage(
    () => ({ ...unrecordedWorker, observed: { activeDeploymentUid: "uid-old", ready: true } }),
    [servingDeployment],
    [servingDeployment],
  );
  expect(body.textContent).toContain(
    "This Worker has not recorded hello-deployment, which serves it",
  );
  // It reports Ready, so the notice does not say otherwise.
  expect(body.textContent).toContain(
    "Until it does, a WorkerCronTrigger for it cannot finish being applied, so it never runs.",
  );
  expect(body.textContent).not.toContain("reports it NotReady");
  expect(body.textContent).not.toContain("The latest observation reports not ready.");
  button(body, "Record the Deployment");
});

test("a version's page starts the next version from it, with its code left to choose", async () => {
  const withCode: ResourceSummary = {
    ...helloV2,
    spec: {
      worker: { resourceUid: "uid-worker" },
      bundle: { resourceUid: "uid-bundle" },
      handlers: ["fetch"],
      sqliteBindings: [{ name: "DB", resource: { resourceUid: "uid-db" } }],
    },
  };
  const { body, writes } = await versionPage([], withCode);
  // A version cannot be changed; its same spec can only be sent again.
  expect(body.all().some((node) => node.tag === "button" && node.textContent === "Update")).toBe(
    false,
  );
  button(body, "New version from this one").click();
  await settle();
  expect(body.textContent).toContain(
    "A version cannot be changed, so this creates a new one from hello-v2's spec, with its handlers, vars and Bindings.",
  );
  const [form] = body.all().filter((node) => node.tag === "select");
  expect(form?.value).toBe(versionForm);
  const spec = body.all().find((node) => node.tag === "textarea");
  expect(JSON.parse(spec?.value ?? "{}")).toEqual({
    worker: { resourceUid: "uid-worker" },
    bundle: { resourceUid: "" },
    handlers: ["fetch"],
    sqliteBindings: [{ name: "DB", resource: { resourceUid: "uid-db" } }],
  });
  // The copy is the Console's own writing, not the smallest spec of the Form.
  expect(body.textContent).toContain("Fill in the empty values.");
  expect(body.textContent).not.toContain("The smallest spec");
  expect(writes).toHaveLength(0);
});

test("choosing the next version's code keeps it described as the copy it is", async () => {
  const withCode: ResourceSummary = {
    ...helloV2,
    spec: {
      worker: { resourceUid: "uid-worker" },
      bundle: { resourceUid: "uid-bundle" },
      handlers: ["fetch"],
    },
  };
  const bundleV2 = resourceAt(
    "uid-bundle-v2",
    "hello-bundle-v2",
    "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/",
    {
      artifact: { url: "https://artifacts.example.test/v2/manifest.json", sha256: "a".repeat(64) },
    },
  );
  const { body } = await detailPage(() => withCode, [], [bundleV2]);
  button(body, "New version from this one").click();
  await settle();
  const choice = body
    .all()
    .find(
      (node) =>
        node.tag === "select" && node.all().some((option) => option.value === "uid-bundle-v2"),
    );
  if (!choice) throw new Error("no code bundle choice");
  choice.value = "uid-bundle-v2";
  choice.emit("change");
  await settle();
  const spec = body.all().find((node) => node.tag === "textarea");
  expect(valueAt(JSON.parse(spec?.value ?? "{}"), ["bundle", "resourceUid"])).toBe("uid-bundle-v2");
  expect(body.textContent).not.toContain("The smallest spec");
  expect(body.textContent).not.toContain("Fill in the empty values.");
});

test("a version keeps its assets in the next one, and only its code bundle is chosen again", async () => {
  const assets = {
    bundle: { resourceUid: "uid-assets" },
    runWorkerFirst: false,
    notFoundHandling: "none",
  };
  const both = await versionPage([], {
    ...helloV2,
    spec: {
      worker: { resourceUid: "uid-worker" },
      bundle: { resourceUid: "uid-bundle" },
      handlers: ["fetch"],
      assets,
    },
  });
  button(both.body, "New version from this one").click();
  await settle();
  const spec = both.body.all().find((node) => node.tag === "textarea");
  expect(JSON.parse(spec?.value ?? "{}")).toEqual({
    worker: { resourceUid: "uid-worker" },
    bundle: { resourceUid: "" },
    handlers: ["fetch"],
    assets,
  });
  // A static-site version has no code bundle: it is told where its new files go.
  const site = await versionPage([], {
    ...helloV2,
    spec: { worker: { resourceUid: "uid-worker" }, handlers: [], assets },
  });
  button(site.body, "New version from this one").click();
  await settle();
  expect(site.body.textContent).toContain(
    "Write the new StaticAssetBundle's UID in assets.bundle, name it, then choose Create",
  );
  // Its spec has no code bundle, so none is offered to choose.
  expect(site.body.textContent).not.toContain("bundle — WorkerBundle");
});

test("a version that needs secret values is not copied in the console", async () => {
  const { body } = await versionPage([], {
    ...helloV2,
    spec: {
      worker: { resourceUid: "uid-worker" },
      bundle: { resourceUid: "uid-bundle" },
      handlers: ["fetch"],
      requiredSensitiveVars: ["API_TOKEN"],
    },
  });
  expect(body.textContent).toContain(
    "This version needs secret values, which the console cannot send; create the next version over the API with privateInputs.",
  );
  expect(
    body
      .all()
      .some((node) => node.tag === "button" && node.textContent === "New version from this one"),
  ).toBe(false);
});

test("a version can be sent again with its same spec, to retry it", async () => {
  const { body, writes } = await versionPage([]);
  button(body, "Re-apply").click();
  await settle();
  expect(body.textContent).toContain(
    "A Resource of this Form cannot change. Sending the same spec again retries it, for example after its create failed.",
  );
  // The dialog says what it does: no change, a re-apply.
  expect(body.textContent).toContain("Re-apply hello-v2");
  expect(body.all().some((node) => node.tag === "button" && node.textContent === "Update")).toBe(
    false,
  );
  button(body, "Re-apply").click();
  await settle();
  const [update] = writes;
  expect(update?.method).toBe("PUT");
  expect(JSON.parse(await (update as Request).text())).toEqual({ spec: helloV2.spec });
});

test("a Resource that can change keeps its Update", async () => {
  const { body } = await detailPage(() => servingDeployment, [servingDeployment]);
  button(body, "Update");
  expect(
    body
      .all()
      .some((node) => node.tag === "button" && node.textContent === "New version from this one"),
  ).toBe(false);
});

test("a Deployment serves one version only when its single entry is that version at 10000", async () => {
  const { servesOnly } = await import("../console/src/pages/resource-detail.ts");
  expect(servesOnly([{ weight: 10000, workerVersion: { resourceUid: "v" } }], "v")).toBe(true);
  expect(servesOnly([{ workerVersion: { resourceUid: "v" }, weight: 10000 }], "v")).toBe(true);
  expect(servesOnly([{ weight: 5000, workerVersion: { resourceUid: "v" } }], "v")).toBe(false);
  expect(servesOnly([{ weight: 10000, workerVersion: { resourceUid: "w" } }], "v")).toBe(false);
  expect(servesOnly([], "v")).toBe(false);
  expect(servesOnly(undefined, "v")).toBe(false);
});

test("a Worker without a Deployment gets one to create for the version", async () => {
  const { body, writes } = await versionPage([]);
  button(body, "Serve this version").click();
  await settle();
  expect(body.textContent).toContain("This Worker has no Deployment yet.");
  const [form] = body.all().filter((node) => node.tag === "select");
  expect(form?.value).toBe(deploymentForm);
  const spec = body.all().find((node) => node.tag === "textarea");
  expect(JSON.parse(spec?.value ?? "{}")).toEqual({
    worker: { resourceUid: "uid-worker" },
    versions: [{ workerVersion: { resourceUid: "uid-version" }, weight: 10000 }],
  });
  expect(writes).toHaveLength(0);
});

const edgeKind = (kind: string) => `https://edge.forms.takoform.com/forms/${kind}/`;
const workerItem = (uid: string, name: string, kind: string, spec: ResourceSummary["spec"]) =>
  ({
    ...one,
    uid,
    name,
    form: edgeKind(kind),
    generation: 1,
    observedGeneration: 1,
    observedAt: "2026-10-07T00:00:00Z",
    phase: "idle",
    spec,
  }) as ResourceSummary;
const hello = workerItem("uid-hello", "hello", "ModuleWorker/0.3.0", {});
const named = { worker: { resourceUid: "uid-hello" } };

/** The overview of an organization holding `items`, against a Host that supports every Form. */
async function overviewWith(items: ResourceSummary[]) {
  const { body, route } = await setup("/");
  const { overviewPage } = await import("../console/src/pages/overview.ts");
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith("/support")) {
        const asking = url.searchParams.get("form") ?? "";
        return Response.json({ form: asking, supported: true, operations: ["create"] });
      }
      if (url.pathname === "/.well-known/takoform/v2") return Response.json(discovery);
      if (url.pathname.endsWith("/wallet"))
        return Response.json({ error: { code: "not_found" } }, { status: 404 });
      return Response.json({ items, nextCursor: null });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(
    overviewPage({
      id: "org-console",
      name: "Console",
      ownerPrincipalId: "owner",
      createdAt: "2026-10-07",
    }) as unknown as TestNode,
  );
  await settle();
  return { body, route };
}

const bundle = workerItem("uid-bundle", "hello-bundle", "WorkerBundle/0.2.0", {});
const fetchVersion = workerItem("uid-v1", "hello-v1", "WorkerVersion/0.5.0", {
  ...named,
  handlers: ["fetch"],
});
const deploymentOfV1 = (change: Partial<ResourceSummary> = {}) => ({
  ...workerItem("uid-dep", "hello-deployment", "WorkerDeployment/0.4.0", {
    versions: [{ weight: 10000, workerVersion: { resourceUid: "uid-v1" } }],
    ...named,
  }),
  observed: { active: true, ready: true },
  ...change,
});

test("a Worker without code offers to add it first", async () => {
  const { body } = await overviewWith([hello]);
  expect(body.textContent).toContain("No code yet");
  button(body, "Add code for hello").click();
  await settle();
  const [form] = body.all().filter((node) => node.tag === "select");
  expect(form?.value).toBe(edgeKind("WorkerBundle/0.2.0"));
  expect(JSON.parse(body.all().find((node) => node.tag === "textarea")?.value ?? "{}")).toEqual({
    artifact: { url: "", sha256: "" },
  });
});

test("a Worker with code and no version offers to create its first version", async () => {
  const { body } = await overviewWith([hello, bundle]);
  expect(body.textContent).toContain("No version yet");
  button(body, "Create a version of hello").click();
  await settle();
  expect(body.textContent).toContain("This creates a version of hello.");
  const [form] = body.all().filter((node) => node.tag === "select");
  expect(form?.value).toBe(edgeKind("WorkerVersion/0.5.0"));
  const spec = body.all().find((node) => node.tag === "textarea");
  expect(JSON.parse(spec?.value ?? "{}")).toEqual({
    worker: { resourceUid: "uid-hello" },
    bundle: { resourceUid: "" },
    handlers: ["fetch"],
  });
});

test("a Worker with one version and no Deployment links to serving that version", async () => {
  const { body } = await overviewWith([hello, bundle, fetchVersion]);
  const serve = body
    .all()
    .find((node) => node.tag === "a" && node.textContent === "Serve hello-v1");
  expect(serve?.attributes.get("href")).toBe("/resources/uid-v1");
});

test("a ready Deployment serving HTTP without an address offers to publish it", async () => {
  const { body } = await overviewWith([hello, bundle, fetchVersion, deploymentOfV1()]);
  expect(body.textContent).toContain("Not published yet");
  button(body, "Publish hello").click();
  await settle();
  expect(body.textContent).toContain("This creates a WorkerEndpoint that publishes hello");
  const [form] = body.all().filter((node) => node.tag === "select");
  expect(form?.value).toBe(edgeKind("WorkerEndpoint/0.3.0"));
  const spec = body.all().find((node) => node.tag === "textarea");
  expect(JSON.parse(spec?.value ?? "{}")).toEqual(named);
});

test("publishing is not offered where the Host would refuse it", async () => {
  const hasPublish = (body: TestNode) =>
    body.all().some((node) => node.tag === "button" && node.textContent === "Publish hello");
  // A Deployment still being applied.
  const pending = await overviewWith([
    hello,
    bundle,
    fetchVersion,
    deploymentOfV1({ generation: 2, observedGeneration: 1 }),
  ]);
  expect(pending.body.textContent).toContain("Waiting for the deployment to finish");
  expect(hasPublish(pending.body)).toBe(false);
  // A Worker that only runs on a schedule answers no HTTP.
  const scheduled = workerItem("uid-v1", "hello-v1", "WorkerVersion/0.5.0", {
    ...named,
    handlers: ["scheduled"],
  });
  const cron = await overviewWith([hello, bundle, scheduled, deploymentOfV1()]);
  expect(hasPublish(cron.body)).toBe(false);
});

test("an Endpoint without an address says how it stands", async () => {
  const endpoint = workerItem("uid-end", "hello-endpoint", "WorkerEndpoint/0.3.0", named);
  const preparing = await overviewWith([hello, deploymentOfV1(), { ...endpoint, generation: 2 }]);
  expect(preparing.body.textContent).toContain("Its address is being prepared");
  const failed = await overviewWith([
    hello,
    deploymentOfV1(),
    { ...endpoint, phase: "error", generation: 2 },
  ]);
  expect(failed.body.textContent).toContain("Publishing failed: hello-endpoint");
  const link = failed.body
    .all()
    .find((node) => node.tag === "a" && node.textContent === "hello-endpoint");
  expect(link?.attributes.get("href")).toBe("/resources/uid-end");
});

test("Needs attention says when a served Worker has not recorded its Deployment", async () => {
  const stale = { ...hello, observed: { activeDeploymentUid: null, ready: false } };
  const { body } = await overviewWith([stale, deploymentOfV1()]);
  // The Workers card shows the Deployment's state as serving, so it does not
  // read as the Worker's own Ready beside its Not ready below.
  expect(body.textContent).toContain("Serving");
  expect(body.textContent).toContain("1 needs attention");
  expect(body.textContent).toContain("Needs attention");
  expect(body.textContent).toContain(
    "its Deployment serves it, but the Worker has not recorded it",
  );
  // Without a serving Deployment it is only not ready.
  const alone = await overviewWith([stale]);
  expect(alone.body.textContent).toContain("latest observation reports not ready");
  expect(alone.body.textContent).not.toContain("has not recorded it");
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

/**
 * The delete dialog for `one`, against a Host whose full list is `listed`, read
 * afresh on every request; `more` makes every page say another follows.
 */
async function deleteDialog(
  listed: ResourceSummary[] | null,
  more = false,
  target: ResourceSummary = one,
) {
  const { body, route } = await setup();
  const { deleteResource } = await import("../console/src/pages/create-resource.ts");
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET" && new URL(request.url).pathname.endsWith("/resources"))
        return listed === null
          ? Response.json({ error: { code: "unavailable" } }, { status: 503 })
          : Response.json({ items: listed, nextCursor: more ? "next" : null });
      if (request.method === "GET") return Response.json(discovery);
      seen.push(request);
      return Response.json({ ...op, action: "delete", generation: 2 }, { status: 202 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  deleteResource("org-console", target);
  return { body, route, seen };
}

test("delete requires explicit confirmation and retains the UID/generation fence", async () => {
  const { body, route, seen } = await deleteDialog([one, two]);
  expect(seen).toHaveLength(0);
  expect(body.textContent).toContain("cannot be undone");
  await settle();
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

test("delete lists what still names the Resource and is not offered until nothing does", async () => {
  const naming = { ...two, name: "names-one", spec: { target: { resourceUid: "uid-one" } } };
  const { body, seen } = await deleteDialog([one, naming]);
  // Until the check answers, the delete is not offered either.
  expect(button(body, "Delete resource").disabled).toBe(true);
  await settle();
  expect(body.textContent).toContain("The Host refuses this delete while these still name it.");
  expect(body.textContent).toContain(
    "names-one https://forms.example.test/Widget/1.0.0: change it so it no longer names this, or delete it",
  );
  const link = body.all().find((node) => node.tag === "a" && node.textContent === "names-one");
  expect(link?.attributes.get("href")).toBe("/resources/uid-two");
  expect(button(body, "Delete resource").disabled).toBe(true);
  button(body, "Delete resource").click();
  await settle();
  expect(seen).toHaveLength(0);
});

test("delete says what to do first about each Resource that still names it", async () => {
  const edge = (kind: string) => `https://edge.forms.takoform.com/forms/${kind}/`;
  const version = {
    ...one,
    uid: "uid-version",
    name: "hello-version-v1",
    form: edge("WorkerVersion/0.5.0"),
  };
  // A version served by a Deployment: serve another one first, never delete the Deployment.
  const serving = {
    ...two,
    name: "hello-deployment",
    form: edge("WorkerDeployment/0.4.0"),
    spec: { versions: [{ weight: 10000, workerVersion: { resourceUid: "uid-version" } }] },
  };
  const served = await deleteDialog([version, serving], false, version);
  await settle();
  expect(served.body.textContent).toContain(
    "hello-deployment WorkerDeployment 0.4.0: serve another version first",
  );
  // A database named by a version, which cannot change: delete the version once nothing serves it.
  const database = { ...one, uid: "uid-db", name: "hello-db", form: edge("SQLiteDatabase/0.2.0") };
  const binding = {
    ...two,
    name: "hello-version-v1",
    form: edge("WorkerVersion/0.5.0"),
    spec: { sqliteBindings: [{ name: "DB", resource: { resourceUid: "uid-db" } }] },
  };
  const bound = await deleteDialog([database, binding], false, database);
  await settle();
  expect(bound.body.textContent).toContain(
    "hello-version-v1 WorkerVersion 0.5.0: it cannot change, so delete it once nothing serves it",
  );
  // What deleting it takes with it, for this Form.
  expect(bound.body.textContent).toContain(
    "The Host deletes this Resource. Its data is deleted with it. This cannot be undone.",
  );
  const endpoint = {
    ...one,
    uid: "uid-end",
    name: "hello-endpoint",
    form: edge("WorkerEndpoint/0.3.0"),
  };
  const alone = await deleteDialog([endpoint], false, endpoint);
  await settle();
  expect(alone.body.textContent).toContain("Its hostname stops serving the Worker.");
});

test("delete checks again on request, and marks a referrer being deleted", async () => {
  const naming = {
    ...two,
    name: "names-one",
    phase: "deleting" as const,
    spec: { target: { resourceUid: "uid-one" } },
  };
  const listed: ResourceSummary[] = [one, naming];
  const { body, seen } = await deleteDialog(listed);
  await settle();
  expect(body.textContent).toContain(
    "names-one https://forms.example.test/Widget/1.0.0 (being deleted)",
  );
  expect(button(body, "Delete resource").disabled).toBe(true);
  // Its delete finished; the dialog reads the list again only when asked.
  listed.splice(1, 1);
  button(body, "Check again").click();
  await settle();
  expect(body.textContent).not.toContain("still name it");
  expect(button(body, "Delete resource").disabled).toBe(false);
  expect(seen).toHaveLength(0);
});

test("delete that could not read every page says so and stays offered", async () => {
  const { body } = await deleteDialog([one], true);
  await settle();
  expect(body.textContent).toContain(
    "Not everything that might name this Resource could be checked. If another still names it, the Host refuses the delete.",
  );
  expect(button(body, "Delete resource").disabled).toBe(false);
});

test("delete that could not check what names the Resource says so and stays offered", async () => {
  const { body, seen } = await deleteDialog(null);
  await settle();
  expect(body.textContent).toContain(
    "Couldn't check what names this Resource. If another still names it, the Host refuses the delete.",
  );
  button(body, "Delete resource").click();
  await settle();
  expect(seen).toHaveLength(1);
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
  button(body, "Update").click();
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
  button(body, "Create").click();
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
  // No further page is offered (a notice may still name the button).
  expect(body.all().some((node) => node.tag === "button" && node.textContent === "Load more")).toBe(
    false,
  );
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
  // The empty list's note asks the Host what it serves only once the list has
  // loaded; let those two answers land before this test hands the DOM back.
  expect(requests.filter((request) => request.url.includes("/support"))).toHaveLength(2);
  await settle();
  expect(body.textContent).toContain("Acceptance is unknown");
  expect(body.textContent).toContain("it can no longer resend it exactly");
  expect(body.textContent).toContain("An accepted create is listed at once");
  expect(body.textContent).not.toContain("Use “Retry exact request”");
  expect(body.textContent).not.toContain("Retry exact request");
  expect(requests.every((request) => request.method === "GET")).toBe(true);
});
