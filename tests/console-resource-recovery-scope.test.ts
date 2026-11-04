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

type ScopeChange =
  | "session"
  | "origin"
  | "organization-roundtrip"
  | "route-roundtrip"
  | "page-rebuild";
const scopeChanges: readonly ScopeChange[] = [
  "session",
  "origin",
  "organization-roundtrip",
  "route-roundtrip",
  "page-rebuild",
];
const cleanupIntents: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanupIntents.splice(0)) cleanup();
});
async function beginRecovery() {
  const fixture = await setup();
  const { resourcesPage } = await import("../console/src/pages/resources.ts");
  const { prepareResourceIntent, sendResourceIntent, discardResourceIntent } = await import(
    "../console/src/resource-intent.ts"
  );
  const { adoptSession, organizations, setApiOrigin } = await import("../console/src/state.ts");
  const { navigate } = await import("../console/src/router.ts");
  const writes: Request[] = [];
  let finish: ((response: Response) => void) | undefined;
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      if (request.method === "GET") return Response.json({ items: [], nextCursor: null });
      writes.push(request.clone());
      if (writes.length === 1)
        return Response.json({ error: { code: "unavailable" } }, { status: 503 });
      return await new Promise<Response>((resolve) => {
        finish = resolve;
      });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  const original = prepareResourceIntent(
    "org-console",
    { action: "create", form, name: "recover-original", spec: {} },
    3600,
  );
  cleanupIntents.push(() => discardResourceIntent(original.id));
  await expect(sendResourceIntent(original.id)).rejects.toThrow();
  expect(original.uncertain).toBe(true);
  const firstSentAt = original.firstSentAt;
  fixture.body.append(resourcesPage("org-console") as unknown as TestNode);
  await settle();
  const retire = (change: ScopeChange): void => {
    const orgs = organizations();
    const owner = fixture.principal();
    if (change === "session") adoptSession("shared-auth");
    else if (change === "origin") setApiOrigin("https://replacement.example.test");
    else if (change === "organization-roundtrip") {
      fixture.selectOrganization("other");
      fixture.selectOrganization("org-console");
    } else if (change === "route-roundtrip") {
      navigate("/keys");
      navigate("/resources");
    } else fixture.body.replaceChildren(resourcesPage("org-console") as unknown as TestNode);
    if (change === "session" || change === "origin") {
      fixture.principal.set(owner);
      organizations.set(orgs);
      fixture.selectOrganization("org-console");
    }
  };
  return {
    ...fixture,
    original,
    firstSentAt,
    writes,
    retire,
    retry: () => button(fixture.body, "Retry exact request").click(),
    answer: (response: Response) => {
      if (!finish) throw new Error("actual retry not in flight");
      finish(response);
    },
    cleanup: () => discardResourceIntent(original.id),
    rebuild: () => {
      fixture.body.replaceChildren(resourcesPage("org-console") as unknown as TestNode);
    },
  };
}
for (const change of scopeChanges) {
  test(`recovery scope: late accepted retry cannot navigate after ${change}`, async () => {
    const f = await beginRecovery();
    f.retry();
    await settle();
    expect(f.writes).toHaveLength(2);
    f.retire(change);
    const replacementRoute = f.route();
    f.answer(Response.json(op, { status: 202 }));
    await settle();
    expect(f.original.operationId).toBe(op.id);
    expect(f.original.uncertain).toBe(false);
    expect(f.original.firstSentAt).toBe(f.firstSentAt);
    expect(f.writes).toHaveLength(2);
    expect(f.route()).toBe(replacementRoute);
    expect(f.route().query.get("operation")).toBeNull();
    f.cleanup();
  });
  test(`recovery scope: late unknown retry does not display an error after ${change}`, async () => {
    const f = await beginRecovery();
    f.retry();
    await settle();
    expect(f.writes).toHaveLength(2);
    f.retire(change);
    const replacementRoute = f.route();
    f.answer(
      Response.json(
        {
          type: "about:blank",
          title: "retired-retry-refusal",
          status: 503,
          code: "retired_retry_refusal",
        },
        { status: 503, headers: { "content-type": "application/problem+json" } },
      ),
    );
    await settle();
    expect(f.original.operationId).toBeNull();
    expect(f.original.uncertain).toBe(true);
    expect(f.writes).toHaveLength(2);
    expect(f.route()).toBe(replacementRoute);
    expect(f.body.textContent).not.toContain("retired_retry_refusal");
    f.cleanup();
  });
  test(`recovery scope: retained retry control cannot send after ${change}`, async () => {
    const f = await beginRecovery();
    const held = button(f.body, "Retry exact request");
    f.retire(change);
    await settle();
    held.click();
    await settle();
    expect(f.writes).toHaveLength(1);
    expect(f.original.firstSentAt).toBe(f.firstSentAt);
    expect(f.original.operationId).toBeNull();
    expect(f.original.uncertain).toBe(true);
    expect(f.body.textContent).not.toContain("session_changed");
    f.cleanup();
  });
}
test("recovery scope: current retry keeps exact bytes and original ACK without reentry", async () => {
  const f = await beginRecovery();
  f.retry();
  await settle();
  f.retry();
  await settle();
  expect(f.writes).toHaveLength(2);
  f.answer(Response.json(op, { status: 202 }));
  await settle();
  const [first, second] = f.writes;
  if (!first || !second) throw new Error("original and retry missing");
  expect(second.url).toBe(first.url);
  expect(second.method).toBe(first.method);
  expect(second.headers.get("idempotency-key")).toBe(first.headers.get("idempotency-key"));
  expect(await second.text()).toBe(await first.text());
  expect(f.original.firstSentAt).toBe(f.firstSentAt);
  expect(f.original.operationId).toBe(op.id);
  expect(f.route().query.get("operation")).toBe(op.id);
  f.cleanup();
});
test("recovery scope: a rebuilt same-session Org round trip can recover the exact original", async () => {
  const f = await beginRecovery();
  f.retire("organization-roundtrip");
  f.rebuild();
  await settle();
  f.retry();
  await settle();
  expect(f.writes).toHaveLength(2);
  f.answer(Response.json(op, { status: 202 }));
  await settle();
  expect(f.original.operationId).toBe(op.id);
  expect(f.original.firstSentAt).toBe(f.firstSentAt);
  expect(f.route().query.get("operation")).toBe(op.id);
  f.cleanup();
});

for (const locale of ["en", "ja"] as const) {
  test(`recovery scope: expired unknown request does not authorize a new key (${locale})`, async () => {
    const f = await beginRecovery();
    const { consoleLocale } = await import("../console/src/i18n.ts");
    f.original.firstSentAt = performance.now() - 3_600_000;
    consoleLocale.set(locale);
    f.rebuild();
    await settle();
    expect(f.writes).toHaveLength(1);
    expect(f.original.uncertain).toBe(true);
    if (locale === "en") {
      expect(f.body.textContent).toContain(
        "Do not send the same change under a new key while its outcome remains unknown",
      );
      expect(f.body.textContent).not.toContain(
        "a create still missing after a moment was not accepted",
      );
    } else {
      expect(f.body.textContent).toContain("元の要求が未受理だったとは判断できません");
      expect(f.body.textContent).not.toContain(
        "少し待っても出ないなら受け付けられておらず、作り直せます",
      );
    }
    f.cleanup();
  });
}
