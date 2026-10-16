import { afterEach, expect, test } from "bun:test";

class TestNode {
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = {};
  readonly dataset = {};
  parent: TestNode | null = null;
  className = "";
  value = "";
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
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(): void {}
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

const MODULE_WORKER = "https://edge.forms.takoform.com/forms/ModuleWorker/0.3.0/";
const WORKER_ENDPOINT = "https://edge.forms.takoform.com/forms/WorkerEndpoint/0.3.0/";
const PUBLIC_V2 = "https://public.example.test/apis/forms.takoform.com/v2";

interface HostAnswers {
  /** The Host's discovery document, or null for one it does not serve. */
  readonly discovery: Record<string, unknown> | null;
  /** Whether each Form is supported, or null for a support query that fails. */
  readonly support: Readonly<Record<string, boolean | null>>;
}

/**
 * The Settings page's This Host card, for a Host that answers as given. Only
 * the card is built: the rest of the page reads signals that other suites set
 * after this one has ended.
 */
async function hostCard(answers: HostAnswers) {
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
      createElementNS: (_ns: string, tag: string) => new TestNode(tag),
      createTextNode: (value: string) => new TestNode("text", value),
      createDocumentFragment: () => new TestNode("fragment"),
      addEventListener: () => undefined,
    },
    window: {
      location: new URL("https://console.example.test/settings"),
      addEventListener: () => undefined,
    },
  });
  const { consoleLocale } = await import("../console/src/i18n.ts");
  const { setApiOrigin } = await import("../console/src/state.ts");
  const page = await import("../console/src/pages/settings.ts");
  consoleLocale.set("en");
  setApiOrigin("https://api.example.test");
  const asked: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      asked.push(url.pathname);
      if (url.pathname === "/.well-known/takoserver")
        return answers.discovery === null
          ? Response.json({ error: "not_found" }, { status: 404 })
          : Response.json(answers.discovery);
      if (url.pathname.endsWith("/support")) {
        const form = url.searchParams.get("form") ?? "";
        const supported = answers.support[form];
        if (supported === null || supported === undefined)
          return Response.json({ error: "unavailable" }, { status: 503 });
        return Response.json({ form, supported, operations: supported ? ["create"] : [] });
      }
      return Response.json({ error: "not_found" }, { status: 404 });
    },
    { preconnect: globalThis.fetch.preconnect },
  );
  body.append(page.hostCard("org-console") as unknown as TestNode);
  for (let i = 0; i < 12; i += 1) await new Promise((resolve) => setTimeout(resolve, 0));
  return { body, asked };
}

const link = (body: TestNode, label: string): TestNode | undefined =>
  body.all().find((node) => node.tag === "a" && node.textContent.startsWith(label));

test("names the Host's own v2 address and that it runs and publishes Workers", async () => {
  const { body, asked } = await hostCard({
    discovery: { endpoints: { takoform: PUBLIC_V2 } },
    support: { [MODULE_WORKER]: true, [WORKER_ENDPOINT]: true },
  });
  expect(body.textContent).toContain("This Host");
  // The address is the one the Host names, not the console's API origin.
  expect(body.textContent).toContain(PUBLIC_V2);
  expect(body.textContent).toContain("the Identifier above as the Space");
  expect(link(body, "an API key")?.attributes.get("href")).toBe("/keys");
  expect(body.textContent).toContain("Runs Workers");
  expect(body.textContent).toContain("WorkerEndpoint publishes Workers at HTTPS hostnames");
  // Asked once each, when the page was built.
  expect(asked.filter((path) => path === "/.well-known/takoserver")).toHaveLength(1);
  expect(asked.filter((path) => path.endsWith("/support"))).toHaveLength(2);
});

test("an artifact-only Host says it does not run Workers and nothing about publishing", async () => {
  const { body } = await hostCard({
    discovery: { endpoints: { takoform: PUBLIC_V2 } },
    support: { [MODULE_WORKER]: false, [WORKER_ENDPOINT]: false },
  });
  expect(body.textContent).toContain("Does not run Workers; it keeps artifacts only.");
  expect(link(body, "step 3 of the install guide")?.attributes.get("href")).toEndWith(
    "/docs/self-host-operations.md#3-configuration",
  );
  expect(body.textContent).not.toContain("HTTPS publishing");
});

test("a Host that runs Workers without the HTTPS listener says what publishing needs", async () => {
  const { body } = await hostCard({
    discovery: { endpoints: { takoform: PUBLIC_V2 } },
    support: { [MODULE_WORKER]: true, [WORKER_ENDPOINT]: false },
  });
  expect(body.textContent).toContain("Runs Workers");
  expect(body.textContent).toContain("Not yet: it needs the HTTPS listener on TCP 443");
  expect(link(body, "step 4 of the install guide")?.attributes.get("href")).toEndWith(
    "/docs/self-host-operations.md#4-https-and-tcp-443",
  );
});

test("a Host that runs Workers but does not say whether it publishes them is not guessed about", async () => {
  const { body } = await hostCard({
    discovery: { endpoints: { takoform: PUBLIC_V2 } },
    support: { [MODULE_WORKER]: true, [WORKER_ENDPOINT]: null },
  });
  expect(body.textContent).toContain("Runs Workers");
  expect(body.textContent).toContain("HTTPS publishing");
  expect(body.textContent).toContain("Couldn't check");
  expect(body.textContent).not.toContain("WorkerEndpoint publishes");
  expect(body.textContent).not.toContain("Not yet");
});

test("a Host that does not answer is not guessed about", async () => {
  const { body } = await hostCard({ discovery: null, support: {} });
  // Without the Host's discovery, the address is built from the console's API origin.
  expect(body.textContent).toContain("https://api.example.test/apis/forms.takoform.com/v2");
  expect(body.textContent).toContain("Couldn't check");
  expect(body.textContent).not.toContain("Runs Workers");
  expect(body.textContent).not.toContain("Does not run Workers");
  expect(body.textContent).not.toContain("HTTPS publishing");
});
