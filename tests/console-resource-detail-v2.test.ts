import { afterEach, expect, test } from "bun:test";

class NodeStub {
  readonly children: NodeStub[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = {};
  readonly dataset = {};
  parent: NodeStub | null = null;
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
  append(...values: Array<NodeStub | string>): void {
    for (const value of values) {
      const child = typeof value === "string" ? new NodeStub("text", value) : value;
      child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...values: Array<NodeStub | string>): void {
    this.children.length = 0;
    this.append(...values);
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(): void {}
  all(): NodeStub[] {
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
function installDom(): NodeStub {
  const body = new NodeStub("body");
  const values = new Map<string, string>();
  Object.assign(globalThis, {
    Node: NodeStub,
    HTMLInputElement: NodeStub,
    localStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    },
    document: {
      body,
      documentElement: new NodeStub("html"),
      createElement: (tag: string) => new NodeStub(tag),
      createElementNS: (_ns: string, tag: string) => new NodeStub(tag),
      createTextNode: (value: string) => new NodeStub("text", value),
      createDocumentFragment: () => new NodeStub("fragment"),
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    },
    window: {
      location: new URL("https://console.example.test/resources/uid-one"),
      addEventListener: () => undefined,
      scrollTo: () => undefined,
      history: { pushState: () => undefined },
    },
  });
  return body;
}
async function settle(): Promise<void> {
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

test("resource detail uses direct UID GET and shows declared versus observed generations", async () => {
  const body = installDom();
  const { consoleLocale } = await import("../console/src/i18n.ts");
  const { organizations, selectOrganization, setApiOrigin } = await import(
    "../console/src/state.ts"
  );
  const { route } = await import("../console/src/router.ts");
  const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
  consoleLocale.set("en");
  setApiOrigin("https://api.example.test");
  organizations.set([
    { id: "org-one", name: "One", ownerPrincipalId: "owner", createdAt: "2026-10-07" },
  ]);
  selectOrganization("org-one");
  route.set({
    path: "/resources/uid-one",
    segments: ["resources", "uid-one"],
    query: new URLSearchParams(),
  });
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      paths.push(url.pathname);
      return Response.json({
        uid: "uid-one",
        form: "https://forms.example.test/Widget/1.0.0",
        space: "org-one",
        name: "widget",
        generation: 2,
        observedGeneration: 1,
        observedAt: "2026-10-07T00:00:00Z",
        phase: "pending",
        spec: { value: "new" },
        observed: { value: "old" },
        output: {},
        lastOperation: "op-one",
      });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(resourceDetailPage("org-one", "uid-one") as unknown as NodeStub);
  await settle();
  expect(paths).toEqual(["/apis/forms.takoform.com/v2/resources/uid-one"]);
  expect(body.textContent).toContain("widget");
  expect(body.textContent).toContain("new");
  expect(body.textContent).toContain("old");
  expect(body.textContent).toContain("Observed generation");
  expect(body.textContent).toContain("not yet been observed");
});

test("confirmed ready:false is NotReady and visible in overview attention", async () => {
  const body = installDom();
  const { consoleLocale } = await import("../console/src/i18n.ts");
  const { organizations, selectOrganization, setApiOrigin } = await import(
    "../console/src/state.ts"
  );
  const { overviewPage } = await import("../console/src/pages/overview.ts");
  const { byForm, health } = await import("../console/src/resource-state.ts");
  const item = {
    uid: "uid-not-ready",
    form: "https://forms.example.test/WorkerVersion/1.0.0",
    space: "org-one",
    name: "not-ready",
    generation: 1,
    observedGeneration: 1,
    observedAt: "2026-10-07T00:00:00Z",
    phase: "idle" as const,
    spec: {},
    observed: { ready: false },
    output: {},
    lastOperation: "op-one",
  };
  expect(health(item)).toMatchObject({ phase: "NotReady", tone: "warn", stale: false });
  expect(health({ ...item, observedAt: null })).toMatchObject({ phase: "Unknown" });
  // A settled Resource whose Form reports no readiness reads as applied.
  expect(health({ ...item, observed: { fileCount: 1 } })).toMatchObject({
    phase: "Applied",
    tone: "ok",
  });
  expect(health({ ...item, observed: {}, observedGeneration: 0 })).toMatchObject({
    phase: "Pending",
  });
  // An explicit negative flag, an unusable ready, or a failed operation is
  // never presented as Applied.
  expect(health({ ...item, observed: { databaseExists: false } })).toMatchObject({
    phase: "Unknown",
  });
  expect(health({ ...item, observed: { ready: null } })).toMatchObject({ phase: "Unknown" });
  expect(health({ ...item, phase: "error", observed: {} })).toMatchObject({ phase: "Failed" });
  expect(byForm([item])).toMatchObject([{ form: item.form, attention: 1 }]);
  consoleLocale.set("en");
  setApiOrigin("https://api.example.test");
  const organization = {
    id: "org-one",
    name: "One",
    ownerPrincipalId: "owner",
    createdAt: "2026-10-07",
  };
  organizations.set([organization]);
  selectOrganization(organization.id);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/wallet"))
        return Response.json({
          wallet: {
            availableMicros: "0",
            heldMicros: "0",
            settledMicros: "0",
            currency: "USD",
            unit: "USD-micros",
            moneyPolicy: "usd-micros-v2",
          },
        });
      if (path.endsWith("/operations")) return Response.json({ operations: [] });
      return Response.json({ items: [item], nextCursor: null });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(overviewPage(organization) as unknown as NodeStub);
  await settle();
  expect(body.textContent).toContain("Needs attention");
  expect(body.textContent).toContain("NotReady");
  expect(body.textContent).toContain("latest observation reports not ready");
  expect(body.textContent).not.toContain("Unknown");
});

test("overview counts only what it read and offers the first create", async () => {
  installDom();
  const { consoleLocale } = await import("../console/src/i18n.ts");
  const { organizations, selectOrganization, setApiOrigin } = await import(
    "../console/src/state.ts"
  );
  const { overviewPage } = await import("../console/src/pages/overview.ts");
  const organization = {
    id: "org-one",
    name: "One",
    ownerPrincipalId: "owner",
    createdAt: "2026-10-07",
  };
  const item = {
    uid: "uid-ready",
    form: "https://forms.example.test/WorkerVersion/1.0.0",
    space: "org-one",
    name: "ready",
    generation: 1,
    observedGeneration: 1,
    observedAt: "2026-10-07T00:00:00Z",
    phase: "idle" as const,
    spec: {},
    observed: { ready: true },
    output: {},
    lastOperation: "op-one",
  };
  const render = async (page: { items: unknown[]; nextCursor: string | null }) => {
    const body = installDom();
    consoleLocale.set("en");
    setApiOrigin("https://api.example.test");
    organizations.set([organization]);
    selectOrganization(organization.id);
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.endsWith("/wallet"))
          return Response.json({
            wallet: {
              organizationId: organization.id,
              availableMicros: "0",
              heldMicros: "0",
              settledMicros: "0",
              currency: "USD",
              unit: "USD-micros",
              moneyPolicy: "usd-micros-v2",
              entries: [],
            },
          });
        if (path.endsWith("/operations")) return Response.json({ operations: [] });
        return Response.json(page);
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    body.append(overviewPage(organization) as unknown as NodeStub);
    await settle();
    return body;
  };

  const partial = await render({ items: [item], nextCursor: "next" });
  expect(partial.textContent).toContain("1+");
  expect(partial.textContent).toContain("first page only");
  expect(partial.textContent).toContain("By Form (first page)");

  const complete = await render({ items: [item], nextCursor: null });
  expect(complete.textContent).toContain("none failed or not ready");
  expect(complete.textContent).toContain("By Form");
  expect(complete.textContent).not.toContain("first page");
  expect(complete.textContent).not.toContain("invalid");

  // A just-accepted create is stale but not failed: the caption must not
  // claim nothing needs attention while the card below lists it.
  const pending = await render({
    items: [{ ...item, uid: "uid-pending", name: "pending", observedGeneration: 0 }],
    nextCursor: null,
  });
  expect(pending.textContent).toContain("none failed or not ready");
  expect(pending.textContent).toContain("Needs attention");
  expect(pending.textContent).not.toContain("none need attention");

  const failing = await render({
    items: [{ ...item, observed: { ready: false } }],
    nextCursor: "next",
  });
  expect(failing.textContent).toContain("1+");
  expect(failing.textContent).toContain("1+ need attention");

  const none = await render({ items: [], nextCursor: null });
  expect(none.textContent).toContain("none yet");
  expect(none.textContent).toContain("Nothing declared yet");
  const create = none.all().find((node) => node.tag === "button");
  expect(create?.className).toBe("btn btn--primary");
  expect(create?.textContent).toContain("New resource");
});

test("resource detail calls a settled artifact Resource Applied", async () => {
  const body = installDom();
  const { consoleLocale } = await import("../console/src/i18n.ts");
  const { organizations, selectOrganization, setApiOrigin } = await import(
    "../console/src/state.ts"
  );
  const { route } = await import("../console/src/router.ts");
  const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
  consoleLocale.set("en");
  setApiOrigin("https://api.example.test");
  organizations.set([
    { id: "org-one", name: "One", ownerPrincipalId: "owner", createdAt: "2026-10-07" },
  ]);
  selectOrganization("org-one");
  route.set({
    path: "/resources/uid-bundle",
    segments: ["resources", "uid-bundle"],
    query: new URLSearchParams(),
  });
  globalThis.fetch = Object.assign(
    async () =>
      Response.json({
        uid: "uid-bundle",
        form: "https://edge.forms.takoform.com/forms/WorkerBundle/0.2.0/",
        space: "org-one",
        name: "hello-v1",
        generation: 1,
        observedGeneration: 1,
        observedAt: "2026-10-07T00:00:00Z",
        phase: "idle",
        spec: {},
        observed: { entrypoint: "worker.js", fileCount: 1, totalBytes: 80 },
        output: {},
        lastOperation: "op-one",
      }),
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(resourceDetailPage("org-one", "uid-bundle") as unknown as NodeStub);
  await settle();
  expect(body.textContent).toContain("hello-v1");
  expect(body.textContent).toContain("Applied");
  expect(body.textContent).not.toContain("Unknown");
});

test("names each referenced Resource where the spec names it", async () => {
  const { specReferences, publishedUrl } = await import("../console/src/pages/resource-detail.ts");
  expect(
    specReferences({
      worker: { resourceUid: "uid-worker" },
      bundle: { resourceUid: "uid-bundle" },
      handlers: ["fetch"],
      sqliteBindings: [{ name: "DB", resource: { resourceUid: "uid-db" } }],
      versions: [{ workerVersion: { resourceUid: "uid-version" }, weight: 10000 }],
      vars: { note: { resourceUid: "not-a-reference", extra: true } },
    }),
  ).toEqual([
    { path: "worker", uid: "uid-worker" },
    { path: "bundle", uid: "uid-bundle" },
    { path: "sqliteBindings · DB", uid: "uid-db" },
    { path: "versions · #1 · workerVersion", uid: "uid-version" },
  ]);
  expect(specReferences({})).toEqual([]);
  expect(publishedUrl({ hostname: "hello.example.com", url: "https://hello.example.com/" })).toBe(
    "https://hello.example.com/",
  );
  expect(publishedUrl({ url: "http://hello.example.com/" })).toBeNull();
  expect(publishedUrl({ url: "javascript:alert(1)" })).toBeNull();
  expect(publishedUrl({})).toBeNull();
});

test("resource detail links the Resources a spec names and its published URL", async () => {
  const body = installDom();
  const { consoleLocale } = await import("../console/src/i18n.ts");
  const { organizations, selectOrganization, setApiOrigin } = await import(
    "../console/src/state.ts"
  );
  const { route } = await import("../console/src/router.ts");
  const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
  consoleLocale.set("en");
  setApiOrigin("https://api.example.test");
  organizations.set([
    { id: "org-one", name: "One", ownerPrincipalId: "owner", createdAt: "2026-10-07" },
  ]);
  selectOrganization("org-one");
  route.set({
    path: "/resources/uid-version",
    segments: ["resources", "uid-version"],
    query: new URLSearchParams(),
  });
  const forms = "https://edge.forms.takoform.com/forms";
  const summary = (uid: string, name: string, form: string, spec: unknown, output = {}) => ({
    uid,
    form: `${forms}/${form}/`,
    space: "org-one",
    name,
    generation: 1,
    observedGeneration: 1,
    observedAt: "2026-10-07T00:00:00Z",
    phase: "idle",
    spec,
    observed: {},
    output,
    lastOperation: `op-${uid}`,
  });
  const resources: Record<string, unknown> = {
    "uid-version": summary(
      "uid-version",
      "hello-version-v1",
      "WorkerVersion/0.5.0",
      {
        worker: { resourceUid: "uid-worker" },
        bundle: { resourceUid: "uid-bundle" },
        sqliteBindings: [{ name: "DB", resource: { resourceUid: "uid-gone" } }],
      },
      { url: "https://hello.apps.example.com/" },
    ),
    "uid-worker": summary("uid-worker", "hello", "ModuleWorker/0.3.0", {}),
    "uid-bundle": summary("uid-bundle", "hello-bundle-v1", "WorkerBundle/0.2.0", {}),
  };
  const paths: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      paths.push(path);
      const found = resources[path.split("/").at(-1) ?? ""];
      return found
        ? Response.json(found)
        : Response.json({ error: { code: "not_found" } }, { status: 404 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(resourceDetailPage("org-one", "uid-version") as unknown as NodeStub);
  await settle();
  expect(new Set(paths)).toEqual(
    new Set(
      ["uid-version", "uid-worker", "uid-bundle", "uid-gone"].map(
        (uid) => `/apis/forms.takoform.com/v2/resources/${uid}`,
      ),
    ),
  );
  const text = body.textContent;
  expect(text).toContain("Resources it names");
  expect(text).toContain("sqliteBindings · DB");
  expect(text).toContain("ModuleWorker 0.3.0");
  expect(text).toContain("WorkerBundle 0.2.0");
  expect(text).toContain("uid-gone — not in this organization");
  const links = body.all().filter((node) => node.tag === "a");
  const worker = links.find((node) => node.textContent === "hello");
  expect(worker?.attributes.get("href")).toBe("/resources/uid-worker");
  const published = links.find((node) => node.textContent.startsWith("https://hello.apps"));
  expect(published?.attributes.get("href")).toBe("https://hello.apps.example.com/");
  expect(published?.attributes.get("target")).toBe("_blank");
  expect(published?.attributes.get("rel")).toBe("noopener noreferrer");
});
