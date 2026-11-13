import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";

import { finalizedHostedPlanTable } from "./helpers/finalized-hosted-plan-table.ts";

const globals = [
  "Node",
  "HTMLInputElement",
  "document",
  "window",
  "localStorage",
  "fetch",
] as const;
const saved = globals.map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);
const originalFetch = globalThis.fetch;

class TestNode {
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly dataset = {};
  readonly listeners = new Map<string, EventListener[]>();
  parent: TestNode | null = null;
  className = "";
  value = "";
  disabled = false;
  checked = false;
  hidden = false;

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
    if (name === "checked") this.checked = true;
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
const documentEvents = new TestNode("document");
const storage = new Map<string, string>();
const location = new URL("https://console.example.test/billing");
const moveLocation = (_state: unknown, _title: string, path: string | URL | null): void => {
  if (path !== null) location.href = new URL(path, location).href;
};
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
    createElement: (tag: string) => new TestNode(tag),
    createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
    createTextNode: (value: string) => new TestNode("text", value),
    createDocumentFragment: () => new TestNode("fragment"),
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  },
  window: {
    location,
    localStorage: globalThis.localStorage,
    history: { pushState: moveLocation, replaceState: moveLocation },
    scrollTo() {},
    addEventListener() {},
  },
});

const state = await import("../console/src/state.ts");
const { billingPage } = await import("../console/src/pages/billing.ts");
const { live } = await import("../console/src/dom.ts");
const { signal } = await import("../console/src/reactive.ts");
const { navigate } = await import("../console/src/router.ts");
const { setConsoleLocale } = await import("../console/src/i18n.ts");
setConsoleLocale("en");
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const planTable = finalizedHostedPlanTable();
const org = (id: string) => ({
  id: `org-${id}`,
  name: id,
  ownerPrincipalId: "local-owner",
  createdAt: "2026-11-13T00:00:00Z",
});
const principal = {
  id: "local-owner",
  provider: "local",
  email: "local@example.test",
  displayName: "Local",
};
const readSuffixes = [
  "wallet",
  "wallet/usage-summary",
  "payments/subscription",
  "wallet/usage-summary/workspaces",
] as const;
type ReadSuffix = (typeof readSuffixes)[number];
const guardedReads = readSuffixes.slice(0, 3);
const suffixOf = (request: Request) => new URL(request.url).pathname.split("/").slice(4).join("/");
const organizationOf = (request: Request) => new URL(request.url).pathname.split("/")[3];
let requests: Request[];
let stopObserver: (() => void) | undefined;
const disableFrames: (() => void)[] = [];
let errors: unknown[];
let rosterReply: (request: Request) => Response | Promise<Response>;
let readReply: (request: Request) => Response | Promise<Response>;

function ready(request: Request, old = false): Response {
  const organizationId = organizationOf(request);
  switch (suffixOf(request)) {
    case "wallet": {
      const credit = old ? "701000000" : organizationId === "org-a" ? "101000000" : "202000000";
      return Response.json({
        wallet: {
          organizationId,
          currency: "USD",
          settledMicros: credit,
          availableMicros: credit,
          heldMicros: "0",
          frozenMicros: "0",
          refundReceivableMicros: "0",
          entries: [],
        },
      });
    }
    case "wallet/usage-summary":
      return Response.json({
        usageSummary: {
          organizationId,
          currency: "USD",
          unit: "USD-micros",
          effectiveIncludedMicros: "10000000",
          utilizationBasisPoints: old ? 1700 : organizationId === "org-a" ? 2500 : 5000,
        },
      });
    case "payments/subscription":
      return Response.json({ subscription: null, planTable });
    case "wallet/usage-summary/workspaces":
      return Response.json({
        organizationId,
        snapshotAt: "2026-11-13T00:00:00.000Z",
        periodStart: "2026-11-01T00:00:00.000Z",
        periodEnd: "2026-12-01T00:00:00.000Z",
        unit: "USD-micros",
        totalsScope: "organization",
        totals: { usedMicros: "3000000", heldMicros: "0", pendingMicros: "0" },
        usageSummary: {
          organizationId,
          currency: "USD",
          unit: "USD-micros",
          periodStart: "2026-11-01T00:00:00.000Z",
          periodEnd: "2026-12-01T00:00:00.000Z",
        },
        workspaces: [
          {
            workspaceRef: old ? "ws_retired" : `ws_${organizationId.replaceAll("-", "_")}`,
            usedMicros: "2000000",
            heldMicros: "0",
            pendingMicros: "0",
          },
        ],
        unattributed: { usedMicros: "1000000", heldMicros: "0", pendingMicros: "0" },
        cursor: null,
      });
    default:
      throw new Error("unexpected local read");
  }
}
const unavailable = () => Response.json({ error: { code: "unavailable" } }, { status: 503 });
const reads = (suffix?: ReadSuffix) =>
  requests.filter(
    (request) =>
      readSuffixes.some((item) => suffixOf(request) === item) &&
      (suffix === undefined || suffixOf(request) === suffix),
  );
const retries = (page: TestNode) =>
  page.all().filter((node) => node.tag === "button" && node.textContent.includes("Try again"));
function render(organizationId: string): TestNode {
  const page = billingPage(organizationId);
  if (!(page instanceof TestNode)) throw new Error("billing page missing");
  body.append(page);
  return page;
}
function renderCurrentBilling(): { frame: TestNode; pages: TestNode[] } {
  const enabled = signal(true);
  disableFrames.push(() => enabled.set(false));
  const pages: TestNode[] = [];
  // The real Console shell recreates the page through this live selection boundary.
  const frame = live(() => {
    if (!enabled()) return null;
    const selected = state.currentOrganization();
    if (!selected) return null;
    const page = billingPage(selected.id);
    if (!(page instanceof TestNode)) throw new Error("billing page missing");
    pages.push(page);
    return page;
  });
  if (!(frame instanceof TestNode)) throw new Error("billing frame missing");
  body.append(frame);
  return { frame, pages };
}
async function identity(saved = "org-a"): Promise<void> {
  state.selectOrganization(saved);
  stopObserver = state.observeSessionIdentity((error) => errors.push(error));
  await tick();
}
async function nextPage(): Promise<void> {
  const cursor = state.nextOrganizationCursor();
  if (cursor === null) throw new Error("expected explicit next roster page");
  await state.loadOrganizationPage(cursor);
  await tick();
}

beforeEach(async () => {
  body.replaceChildren();
  storage.clear();
  state.setApiOrigin("https://api.example.test");
  state.adoptSession();
  navigate("/billing");
  await tick();
  requests = [];
  errors = [];
  rosterReply = (request) =>
    Response.json({
      principal,
      organizations: [org(new URL(request.url).searchParams.has("organizationCursor") ? "b" : "a")],
      nextOrganizationCursor: new URL(request.url).searchParams.has("organizationCursor")
        ? null
        : "page-two",
    });
  readReply = (request) => ready(request);
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request);
      if (request.method !== "GET") throw new Error("read-only fixture refuses mutation");
      if (new URL(request.url).pathname === "/v1/me") return rosterReply(request);
      if (readSuffixes.some((suffix) => suffixOf(request) === suffix)) return readReply(request);
      throw new Error("unexpected local API route");
    },
    { preconnect: originalFetch.preconnect },
  );
});
afterEach(async () => {
  for (const disable of disableFrames.splice(0)) disable();
  stopObserver?.();
  stopObserver = undefined;
  state.adoptSession();
  await tick();
  expect(requests.every((request) => request.method === "GET")).toBe(true);
  globalThis.fetch = originalFetch;
});
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("an unloaded saved Org cannot start billing reads; its actual next roster page enables the selected view", async () => {
  await identity("org-b");
  expect(state.currentOrganization()).toBeNull();
  const refused = render("org-b");
  await tick();
  expect(reads()).toHaveLength(0);
  expect(refused.textContent.includes("$202")).toBe(false);
  await nextPage();
  expect(state.currentOrganization()?.id).toBe("org-b");
  const { frame } = renderCurrentBilling();
  await tick();
  expect(reads().map((request) => organizationOf(request))).toEqual(Array(4).fill("org-b"));
  expect(frame.textContent.includes("$202")).toBe(true);
  expect(frame.textContent.includes("50%")).toBe(true);
  expect(frame.textContent.includes("ws_org_b")).toBe(true);
  expect(errors).toEqual([]);
});

for (const status of [200, 503]) {
  test(`retired billing reads cannot restore values or Retry after paged Org selection changes (${status})`, async () => {
    await identity();
    const pending: { request: Request; resolve: (value: Response) => void }[] = [];
    readReply = (request) =>
      organizationOf(request) === "org-a"
        ? new Promise<Response>((resolve) => pending.push({ request, resolve }))
        : ready(request);
    const { frame, pages } = renderCurrentBilling();
    await tick();
    await nextPage();
    const retired = pages.slice();
    state.selectOrganization("org-b");
    await tick();
    const count = reads().length;
    for (const held of pending)
      held.resolve(status === 200 ? ready(held.request, true) : unavailable());
    await tick();
    for (const page of retired) {
      expect(page.textContent.includes("$701")).toBe(false);
      expect(page.textContent.includes("17%")).toBe(false);
      expect(page.textContent.includes("No subscription reported")).toBe(false);
      expect(page.textContent.includes("ws_retired")).toBe(false);
      expect(retries(page)).toHaveLength(0);
    }
    expect(frame.textContent.includes("$202")).toBe(true);
    expect(frame.textContent.includes("50%")).toBe(true);
    expect(frame.textContent.includes("ws_org_b")).toBe(true);
    expect(frame.textContent.includes("$701")).toBe(false);
    expect(reads()).toHaveLength(count);
    expect(errors).toEqual([]);
  });
}

for (const suffix of guardedReads) {
  test(`a captured ${suffix} Retry cannot reissue a read after selecting the next-page Org`, async () => {
    await identity();
    readReply = (request) => (suffixOf(request) === suffix ? unavailable() : ready(request));
    const { frame } = renderCurrentBilling();
    await tick();
    const retry = retries(frame)[0];
    if (!retry) throw new Error("local Retry missing");
    await nextPage();
    state.selectOrganization("org-b");
    await tick();
    const count = reads().length;
    retry.click();
    await tick();
    expect(reads()).toHaveLength(count);
    expect(errors).toEqual([]);
  });

  test(`the current ${suffix} Retry remains functional after a same-Org roster-page repaint`, async () => {
    await identity();
    readReply = (request) => (suffixOf(request) === suffix ? unavailable() : ready(request));
    const { frame, pages } = renderCurrentBilling();
    await tick();
    await nextPage();
    expect(pages.length).toBeGreaterThan(1);
    expect(state.organizations().map((item) => item.id)).toEqual(["org-b"]);
    expect(state.currentOrganization()?.id).toBe("org-a");
    const retry = retries(frame)[0];
    if (!retry) throw new Error("current Retry missing");
    const count = reads(suffix).length;
    readReply = (request) => ready(request);
    retry.click();
    await tick();
    expect(reads(suffix)).toHaveLength(count + 1);
    expect(reads().every((request) => organizationOf(request) === "org-a")).toBe(true);
    expect(frame.textContent.includes("$101")).toBe(true);
    expect(frame.textContent.includes("25%")).toBe(true);
    expect(frame.textContent.includes("No subscription reported")).toBe(true);
    expect(frame.textContent.includes("ws_org_a")).toBe(true);
    expect(retries(frame)).toHaveLength(0);
    expect(errors).toEqual([]);
  });
}

test("captured subscription Refresh status cannot reload after a paged selection roundtrip", async () => {
  await identity();
  const { frame } = renderCurrentBilling();
  await tick();
  const refresh = frame
    .all()
    .find((node) => node.tag === "button" && node.textContent === "Refresh status");
  if (!refresh) throw new Error("local refresh missing");
  await nextPage();
  state.selectOrganization("org-b");
  state.selectOrganization("org-a");
  expect(state.currentOrganization()).toBeNull();
  // The earlier page must actually return before this selection is valid again.
  await state.loadOrganizationPage();
  await tick();
  const count = reads().length;
  refresh.click();
  await tick();
  expect(reads()).toHaveLength(count);
  expect(state.currentOrganization()?.id).toBe("org-a");
});

test("a failed next roster page keeps the saved Org unknown and cannot start its billing reads", async () => {
  await identity("org-b");
  rosterReply = () => unavailable();
  await expect(nextPage()).rejects.toMatchObject({ status: 503 });
  expect(state.currentOrganizationId()).toBe("org-b");
  expect(state.currentOrganization()).toBeNull();
  render("org-b");
  await tick();
  expect(reads()).toHaveLength(0);
});
