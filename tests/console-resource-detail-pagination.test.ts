import { afterEach, describe, expect, test } from "bun:test";
import type { Organization, ResourceSummary } from "../console/src/api.ts";

class TestNode {
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
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

  addEventListener(): void {}

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
      location: new URL("https://console.example.test/resources/default/Widget/target"),
      addEventListener: () => undefined,
      scrollTo: () => undefined,
      history: { pushState: () => undefined },
    },
  });
  return body;
}

async function settle(): Promise<void> {
  for (let turn = 0; turn < 12; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

const organization: Organization = {
  id: "org-detail-pagination",
  name: "Pagination",
  ownerPrincipalId: "owner",
  createdAt: "2026-01-01T00:00:00Z",
};

function summary(name: string, endpoint?: string, space = "default"): ResourceSummary {
  return {
    apiVersion: "example.forms.test",
    kind: "Widget",
    metadata: {
      space,
      name,
      uid: name,
      generation: "1",
      revision: "1",
      updatedAt: "2026-01-01T00:00:00Z",
    },
    status: endpoint ? { outputs: { endpoint } } : undefined,
  };
}

describe("console resource detail pagination", () => {
  test("finds a resource on a later cursor page instead of reporting it missing", async () => {
    const body = installDom();
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { organizations, selectOrganization, setApiOrigin } = await import(
      "../console/src/state.ts"
    );
    const { route } = await import("../console/src/router.ts");
    const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
    consoleLocale.set("en");
    setApiOrigin("https://api.example.test");
    organizations.set([organization]);
    selectOrganization(organization.id);
    route.set({
      path: "/resources/default/Widget/target",
      segments: ["resources", "default", "Widget", "target"],
      query: new URLSearchParams(),
    });

    const requests: Request[] = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        const cursor = new URL(request.url).searchParams.get("cursor");
        if (cursor === null) {
          return Response.json({
            resources: [summary("target", "wrong-space-output", "other")],
            cursor: "page-two",
          });
        }
        if (cursor === "page-two") {
          return Response.json({ resources: [summary("target", "page-two-output")] });
        }
        throw new Error(`unexpected cursor: ${cursor}`);
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    body.append(
      resourceDetailPage(organization.id, {
        space: "default",
        kind: "Widget",
        name: "target",
      }) as unknown as TestNode,
    );
    await settle();

    expect(body.textContent).toContain("page-two-output");
    expect(body.textContent).not.toContain("wrong-space-output");
    expect(body.textContent).not.toContain("No such resource");
    expect(requests.map((request) => new URL(request.url).searchParams.get("cursor"))).toEqual([
      null,
      "page-two",
    ]);
    expect(requests.map((request) => new URL(request.url).searchParams.get("space"))).toEqual([
      "default",
      "default",
    ]);
  });

  test("reports not found only after the cursor chain is exhausted", async () => {
    const body = installDom();
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { organizations, selectOrganization, setApiOrigin } = await import(
      "../console/src/state.ts"
    );
    const { route } = await import("../console/src/router.ts");
    const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
    consoleLocale.set("en");
    setApiOrigin("https://api.example.test");
    organizations.set([organization]);
    selectOrganization(organization.id);
    route.set({
      path: "/resources/default/Widget/target",
      segments: ["resources", "default", "Widget", "target"],
      query: new URLSearchParams(),
    });

    const cursors: Array<string | null> = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        return cursor === null
          ? Response.json({ resources: [summary("first-page-item")], cursor: "last-page" })
          : Response.json({ resources: [summary("another-item")] });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    body.append(
      resourceDetailPage(organization.id, {
        space: "default",
        kind: "Widget",
        name: "target",
      }) as unknown as TestNode,
    );
    await settle();

    expect(body.textContent).toContain("No such resource");
    expect(cursors).toEqual([null, "last-page"]);
  });

  test("stops and offers retry if the server repeats a cursor", async () => {
    const body = installDom();
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { organizations, selectOrganization, setApiOrigin } = await import(
      "../console/src/state.ts"
    );
    const { route } = await import("../console/src/router.ts");
    const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
    consoleLocale.set("en");
    setApiOrigin("https://api.example.test");
    organizations.set([organization]);
    selectOrganization(organization.id);
    route.set({
      path: "/resources/default/Widget/target",
      segments: ["resources", "default", "Widget", "target"],
      query: new URLSearchParams(),
    });

    const cursors: Array<string | null> = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const cursor = new URL(request.url).searchParams.get("cursor");
        cursors.push(cursor);
        return Response.json({ resources: [summary("other-item")], cursor: "repeated" });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    body.append(
      resourceDetailPage(organization.id, {
        space: "default",
        kind: "Widget",
        name: "target",
      }) as unknown as TestNode,
    );
    await settle();

    expect(cursors).toEqual([null, "repeated"]);
    expect(body.textContent).toContain("invalid_response");
    expect(body.textContent).not.toContain("No such resource");
    expect(
      body.all().some((node) => node.tag === "button" && node.textContent === "Try again"),
    ).toBe(true);
  });

  test("surfaces a page request failure instead of waiting forever", async () => {
    const body = installDom();
    const { consoleLocale } = await import("../console/src/i18n.ts");
    const { organizations, selectOrganization, setApiOrigin } = await import(
      "../console/src/state.ts"
    );
    const { route } = await import("../console/src/router.ts");
    const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
    consoleLocale.set("en");
    setApiOrigin("https://api.example.test");
    organizations.set([organization]);
    selectOrganization(organization.id);
    route.set({
      path: "/resources/default/Widget/target",
      segments: ["resources", "default", "Widget", "target"],
      query: new URLSearchParams(),
    });

    let calls = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = new Request(input, init);
        const cursor = new URL(request.url).searchParams.get("cursor");
        calls += 1;
        return cursor === null
          ? Response.json({ resources: [summary("first-page-item")], cursor: "next" })
          : Response.json({ error: { code: "backend_unavailable" } }, { status: 503 });
      },
      { preconnect: globalThis.fetch.preconnect },
    );

    body.append(
      resourceDetailPage(organization.id, {
        space: "default",
        kind: "Widget",
        name: "target",
      }) as unknown as TestNode,
    );
    await settle();

    expect(calls).toBe(2);
    expect(body.textContent).toContain("backend_unavailable");
    expect(body.textContent).not.toContain("No such resource");
    expect(
      body.all().some((node) => node.tag === "button" && node.textContent === "Try again"),
    ).toBe(true);
  });

  test.each(["organization", "route"] as const)(
    "does not render or continue a pending detail lookup after %s changes",
    async (change) => {
      const body = installDom();
      const { consoleLocale } = await import("../console/src/i18n.ts");
      const { organizations, selectOrganization, setApiOrigin } = await import(
        "../console/src/state.ts"
      );
      const { route } = await import("../console/src/router.ts");
      const { resourceDetailPage } = await import("../console/src/pages/resource-detail.ts");
      const secondOrganization = { ...organization, id: "org-detail-other" };
      consoleLocale.set("en");
      setApiOrigin("https://api.example.test");
      organizations.set([organization, secondOrganization]);
      selectOrganization(organization.id);
      route.set({
        path: "/resources/default/Widget/target",
        segments: ["resources", "default", "Widget", "target"],
        query: new URLSearchParams(),
      });

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
          if (url.searchParams.get("cursor") === "second-page") return secondPage;
          if (url.pathname.includes(secondOrganization.id) || route().segments[3] === "current") {
            return Response.json({
              resources: [
                summary(change === "organization" ? "target" : "current", "current-result"),
              ],
            });
          }
          if (url.searchParams.has("cursor")) {
            throw new Error("stale lookup must not request another page");
          }
          return Response.json({ resources: [summary("first-page-item")], cursor: "second-page" });
        },
        { preconnect: globalThis.fetch.preconnect },
      );

      body.append(
        resourceDetailPage(organization.id, {
          space: "default",
          kind: "Widget",
          name: "target",
        }) as unknown as TestNode,
      );
      await settle();
      expect(requests).toHaveLength(2);

      if (change === "organization") {
        selectOrganization(secondOrganization.id);
      } else {
        route.set({
          path: "/resources/default/Widget/current",
          segments: ["resources", "default", "Widget", "current"],
          query: new URLSearchParams(),
        });
      }
      body.replaceChildren(
        resourceDetailPage(change === "organization" ? secondOrganization.id : organization.id, {
          space: "default",
          kind: "Widget",
          name: change === "organization" ? "target" : "current",
        }) as unknown as TestNode,
      );
      await settle();
      expect(body.textContent).toContain("current-result");

      resolveSecond(Response.json({ resources: [summary("target", "stale-result")] }));
      await settle();

      expect(body.textContent).toContain("current-result");
      expect(body.textContent).not.toContain("stale-result");
      expect(requests).toHaveLength(3);
    },
  );
});
