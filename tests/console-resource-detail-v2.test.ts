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
