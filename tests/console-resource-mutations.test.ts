import { afterEach, describe, expect, test } from "bun:test";
import type { Offering, Organization, ResourceSummary } from "../console/src/api.ts";

// The console uses a small DOM surface. Exercise its real event handlers and
// reactive rendering without replacing application modules or adding a browser
// dependency to the portable tests.
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
    const listeners = this.listeners.get(name) ?? [];
    listeners.push(listener);
    this.listeners.set(name, listeners);
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

const savedGlobals = new Map(
  ["document", "window", "localStorage", "Node", "HTMLInputElement", "fetch"].map((key) => [
    key,
    Object.getOwnPropertyDescriptor(globalThis, key),
  ]),
);
afterEach(() => {
  for (const [key, descriptor] of savedGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function installDom(): TestNode {
  const body = new TestNode("body");
  const values = new Map<string, string>();
  const location = new URL("https://console.example.test/resources");
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
      createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
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
        pushState: (_state: unknown, _title: string, path: string) => {
          location.href = new URL(path, location).href;
        },
      },
    },
  });
  return body;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

function button(body: TestNode, label: string): TestNode {
  const found = body.all().find((node) => node.tag === "button" && node.textContent === label);
  if (!found) throw new Error(`missing button: ${label}`);
  return found;
}

const form = {
  apiVersion: "example.forms.test",
  kind: "Widget",
  definitionVersion: "1.0.0",
  schemaDigest: `sha256:${"a".repeat(64)}`,
};
const receipt = {
  apiVersion: form.apiVersion,
  kind: form.kind,
  metadata: { space: "default", name: "widget", uid: "widget-uid", generation: "1", revision: "1" },
};
const operation = {
  apiVersion: "operations.takoform.com/v1alpha1",
  kind: "Operation",
  id: "op/console?test#%",
};
const offering = {
  id: "widget-offering",
  displayName: "Widget",
  form,
  pricePlan: { currency: "USD", provisioning: { amountMinor: 0 }, meters: [] },
} as unknown as Offering;

const organization = (id: string): Organization => ({
  id,
  name: id,
  ownerPrincipalId: "owner",
  createdAt: "2026-01-01T00:00:00Z",
});

const summary = (name: string): ResourceSummary => ({
  apiVersion: form.apiVersion,
  kind: form.kind,
  metadata: {
    space: "default",
    name,
    uid: name,
    generation: "1",
    revision: "1",
    updatedAt: "2026-01-01T00:00:00Z",
  },
  form: { formRef: form },
});

describe("console accepted resource mutations", () => {
  test.each(["create", "delete", "failure"] as const)(
    "shows accepted %s and checks status without replaying the mutation",
    async (action) => {
      const body = installDom();
      const { createResource, deleteResource } = await import(
        "../console/src/pages/create-resource.ts"
      );
      const { resourcesPage } = await import("../console/src/pages/resources.ts");
      const { consoleLocale } = await import("../console/src/i18n.ts");
      const { organizations, selectOrganization, setApiOrigin } = await import(
        "../console/src/state.ts"
      );
      const { route } = await import("../console/src/router.ts");
      const { mountToasts } = await import("../console/src/ui.ts");
      consoleLocale.set("en");
      setApiOrigin("https://api.example.test");
      organizations.set([organization("org-console")]);
      selectOrganization("org-console");
      route.set({ path: "/resources", segments: ["resources"], query: new URLSearchParams() });
      body.append(mountToasts() as unknown as TestNode);

      const requests: Request[] = [];
      let checks = 0;
      globalThis.fetch = Object.assign(
        async (input: RequestInfo | URL, init?: RequestInit) => {
          const request = new Request(input, init);
          requests.push(request);
          const path = new URL(request.url).pathname;
          if (path.endsWith("/prepare"))
            return Response.json({ review: { prepareDigest: "review" } });
          if (request.method === "PUT" || request.method === "DELETE") {
            return Response.json({ operation: { ...operation, done: false } }, { status: 202 });
          }
          if (path.includes("/operations/")) {
            checks += 1;
            return Response.json(
              checks === 1
                ? { ...operation, done: false }
                : action === "failure"
                  ? { ...operation, done: true, error: { code: "provider_refused" } }
                  : {
                      ...operation,
                      done: true,
                      result: action === "delete" ? { deleted: true } : { resource: receipt },
                    },
            );
          }
          if (path.endsWith("/resources")) return Response.json({ resources: [] });
          if (path === "/v1/catalog") return Response.json({ offerings: [] });
          throw new Error(`unexpected request: ${request.url}`);
        },
        { preconnect: globalThis.fetch.preconnect },
      );

      let deleted = false;
      if (action === "delete") {
        deleteResource("org-console", { form, ...receipt.metadata }, () => {
          deleted = true;
        });
        button(body, "Delete resource").click();
      } else {
        createResource("org-console", [offering]);
        const name = body.all().find((node) => node.tag === "input");
        if (!name) throw new Error("name input missing");
        name.value = "widget";
        button(body, "Apply").click();
      }
      await settle();
      expect(deleted).toBe(false);
      expect(route().path).toBe("/resources");
      expect(route().query.get("operation")).toBe(operation.id);
      expect(body.textContent).not.toContain("is ready");
      expect(body.textContent).not.toContain("deleted");
      expect(body.all().some((node) => node.className === "scrim")).toBe(false);

      body.append(resourcesPage("org-console") as unknown as TestNode);
      await settle();
      expect(body.textContent).toContain(operation.id);
      expect(body.textContent).toContain("Accepted, not yet complete");
      expect(body.textContent).not.toContain("Deletion complete");
      button(body, "Reload").click();
      await settle();
      expect(body.textContent).not.toContain("Accepted, not yet complete");
      expect(body.textContent).toContain(
        action === "failure"
          ? "provider_refused"
          : action === "delete"
            ? "Deletion complete"
            : "Widget widget created",
      );
      expect(requests.filter((request) => ["PUT", "DELETE"].includes(request.method))).toHaveLength(
        1,
      );
      expect(checks).toBe(2);
      expect(
        requests.filter((request) => new URL(request.url).pathname.endsWith("/resources")).length,
      ).toBeGreaterThanOrEqual(2);
      for (const request of requests.filter((request) =>
        new URL(request.url).pathname.includes("/operations/"),
      )) {
        expect(request.method).toBe("GET");
        expect(new URL(request.url).pathname).toBe(
          "/apis/forms.takoform.com/v1/operations/op%2Fconsole%3Ftest%23%25",
        );
        expect(request.headers.get("takoform-organization")).toBe("org-console");
      }
    },
  );
});

describe("console resource pagination", () => {
  test("appends cursor pages, ignores duplicate clicks, and stops at the terminal page", async () => {
    const body = installDom();
    const { resourcesPage } = await import("../console/src/pages/resources.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { organizations, selectOrganization, setApiOrigin } = await import(
      "../console/src/state.ts"
    );
    const { route } = await import("../console/src/router.ts");
    consoleLocale.set("en");
    setApiOrigin("https://api.example.test");
    organizations.set([organization("org-pagination")]);
    selectOrganization("org-pagination");
    route.set({ path: "/resources", segments: ["resources"], query: new URLSearchParams() });

    let resolveSecond!: (response: Response) => void;
    const secondPage = new Promise<Response>((resolve) => {
      resolveSecond = resolve;
    });
    const requests: Request[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        const cursor = url.searchParams.get("cursor");
        if (!cursor) return Response.json({ resources: [summary("first")], cursor: "next-1" });
        if (cursor === "next-1") return secondPage;
        if (cursor === "next-2") return Response.json({ resources: [summary("third")] });
        throw new Error(`unexpected cursor: ${cursor}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    body.append(resourcesPage("org-pagination") as unknown as TestNode);
    await settle();
    expect(body.textContent).toContain("first");
    expect(body.textContent).toContain("Filters match loaded resources only");
    const load = button(body, "Load more");
    load.click();
    load.click();
    const resourceRequests = () =>
      requests.filter((request) => new URL(request.url).pathname.endsWith("/resources"));
    expect(resourceRequests()).toHaveLength(2);
    await settle();
    expect(button(body, "Loading…").attributes.has("disabled")).toBe(true);
    resolveSecond(Response.json({ resources: [summary("second")], cursor: "next-2" }));
    await settle();
    expect(body.textContent).toContain("first");
    expect(body.textContent).toContain("second");
    button(body, "Load more").click();
    await settle();
    expect(body.textContent).toContain("third");
    expect(
      body.all().some((node) => node.tag === "button" && node.textContent === "Load more"),
    ).toBe(false);
    expect(
      resourceRequests().map((request) => new URL(request.url).searchParams.get("cursor")),
    ).toEqual([null, "next-1", "next-2"]);
  });

  test.each(["ja", "en"] as const)(
    "localizes API paging failures in %s and retries the same cursor with or without loaded rows",
    async (locale) => {
      for (const hasInitialResources of [false, true]) {
        const body = installDom();
        const { resourcesPage } = await import("../console/src/pages/resources.ts");
        const { consoleLocale } = await import("../console/src/i18n.ts");
        const { organizations, selectOrganization, setApiOrigin } = await import(
          "../console/src/state.ts"
        );
        const { route } = await import("../console/src/router.ts");
        const orgId = `org-pagination-retry-${locale}-${hasInitialResources}`;
        consoleLocale.set(locale);
        setApiOrigin("https://api.example.test");
        organizations.set([organization(orgId)]);
        selectOrganization(orgId);
        route.set({ path: "/resources", segments: ["resources"], query: new URLSearchParams() });
        let continuationRequests = 0;
        globalThis.fetch = Object.assign(
          async (input: RequestInfo | URL, init?: RequestInit) => {
            const request = new Request(input, init);
            const cursor = new URL(request.url).searchParams.get("cursor");
            if (!cursor) {
              return Response.json({
                resources: hasInitialResources ? [summary("kept")] : [],
                cursor: "retry-me",
              });
            }
            continuationRequests += 1;
            if (continuationRequests === 1) {
              return Response.json({ error: { code: "permission_denied" } }, { status: 403 });
            }
            return Response.json({ resources: [summary("added")] });
          },
          { preconnect: globalThis.fetch.preconnect },
        );

        body.append(resourcesPage(orgId) as unknown as TestNode);
        await settle();
        if (hasInitialResources) expect(body.textContent).toContain("kept");
        button(body, locale === "ja" ? "さらに読み込む" : "Load more").click();
        await settle();
        expect(body.textContent).toContain(
          locale === "ja"
            ? "このアカウントには操作する権限がありません。"
            : "This account is not allowed to do that.",
        );
        expect(body.textContent).not.toContain("permission_denied");
        if (hasInitialResources) expect(body.textContent).toContain("kept");
        button(body, locale === "ja" ? "もう一度試す" : "Try again").click();
        await settle();
        expect(body.textContent).toContain("added");
        expect(continuationRequests).toBe(2);
      }
    },
  );

  test("does not append a pending page after the current organization changes", async () => {
    const body = installDom();
    const { resourcesPage } = await import("../console/src/pages/resources.ts");
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { organizations, selectOrganization, setApiOrigin } = await import(
      "../console/src/state.ts"
    );
    const { route } = await import("../console/src/router.ts");
    consoleLocale.set("en");
    setApiOrigin("https://api.example.test");
    organizations.set([organization("org-a"), organization("org-b")]);
    selectOrganization("org-a");
    route.set({ path: "/resources", segments: ["resources"], query: new URLSearchParams() });
    let resolveNext!: (response: Response) => void;
    const nextPage = new Promise<Response>((resolve) => {
      resolveNext = resolve;
    });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        if (new URL(request.url).searchParams.has("cursor")) return nextPage;
        return Response.json({ resources: [summary("org-a-first")], cursor: "org-a-next" });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    body.append(resourcesPage("org-a") as unknown as TestNode);
    await settle();
    button(body, "Load more").click();
    selectOrganization("org-b");
    await settle();
    expect(body.textContent).not.toContain("org-a-first");
    resolveNext(Response.json({ resources: [summary("org-a-stale")] }));
    await settle();
    expect(body.textContent).not.toContain("org-a-stale");
  });
});
