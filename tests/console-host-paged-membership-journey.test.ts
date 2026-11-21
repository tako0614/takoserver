import { afterAll, expect, test } from "bun:test";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { waitForConsole as waitFor } from "./helpers/console-test-wait.ts";
import { migrateSqliteDatabase } from "./helpers/migrated-database.ts";

const globals = [
  "Node",
  "HTMLInputElement",
  "document",
  "window",
  "localStorage",
  "sessionStorage",
  "fetch",
] as const;
const saved = globals.map(
  (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
);
const originalFetch = globalThis.fetch;

class TestNode {
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style = {};
  readonly dataset = {};
  readonly listeners = new Map<string, EventListener[]>();
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

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ target: this } as unknown as Event);
  }

  querySelector<Value>(_selector: string): Value | null {
    return (this.all().find(
      (node) => ["input", "textarea", "select", "button"].includes(node.tag) && !node.disabled,
    ) ?? null) as Value | null;
  }

  focus(): void {}
}

const body = new TestNode("body");
const root = new TestNode("main");
body.append(root);
const documentEvents = new TestNode("document");
const storage = new Map<string, string>();
const location = new URL("https://console.membership-journey.test/keys");
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
    getElementById: (id: string) => (id === "root" ? root : null),
    createElement: (tag: string) => new TestNode(tag),
    createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
    createTextNode: (value: string) => new TestNode("text", value),
    createDocumentFragment: () => new TestNode("fragment"),
    addEventListener: documentEvents.addEventListener.bind(documentEvents),
    removeEventListener: documentEvents.removeEventListener.bind(documentEvents),
  },
  sessionStorage: {
    getItem: () => null,
    setItem() {},
    removeItem() {},
  },
  window: {
    location,
    history: { replaceState: moveLocation, pushState: moveLocation },
    scrollTo() {},
    addEventListener() {},
  },
});

const ORIGIN = "https://api.membership-journey.test";
const CONSOLE = location.origin;
const NOW = "2026-11-13T00:00:00.000Z";
// Public synthetic local browser sessions. Only digests are stored in the fixture DB.
const SESSION_A = "membership-journey-local-session-a";
const SESSION_B = "membership-journey-local-session-b";
const A_IDS = Array.from({ length: 101 }, (_, index) => `org-a-${String(index).padStart(3, "0")}`);
const SECOND_PAGE_ORG = "org-a-100";
const B_ORG = "org-b-only";
const SAVED_UNKNOWN_ORG = "org-a-unloaded-saved";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function button(label: string): TestNode {
  const node = body.all().find((node) => node.tag === "button" && node.textContent === label);
  if (!node) throw new Error(`missing local control: ${label}`);
  return node;
}
function picker(): TestNode {
  const node = body
    .all()
    .find((node) => node.tag === "select" && node.attributes.get("aria-label") === "Organization");
  if (!node) throw new Error("actual organization picker missing");
  return node;
}
function gate() {
  let release = (): void => {
    throw new Error("local response gate is not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("actual Host membership cursors drive Console page-two selection and reject an old session page", async () => {
  const database = migrateSqliteDatabase();
  const sql = createSqliteSql(database);
  const identity = {
    async verify(): Promise<never> {
      throw new Error("seeded local sessions do not use external identity");
    },
  };
  const clock = () => new Date(NOW);
  const accounts = createAccounts({ sql, identity, clock });
  const delayed = gate();
  let holdA = false;
  let holdingA = false;
  let browserSession = SESSION_A;
  let state: typeof import("../console/src/state.ts") | undefined;
  const requests: Array<{
    method: string;
    path: string;
    cursor: string | null;
    pageSize: string | null;
    status: number;
    browser: "a" | "b";
    rows?: number;
    bytes?: number;
  }> = [];
  try {
    for (const [id, secret] of [
      ["member-a", SESSION_A],
      ["member-b", SESSION_B],
    ] as const) {
      await sql.run(
        "INSERT INTO principals (id,provider,provider_subject,email,display_name,created_at) VALUES (?,?,?,?,?,?)",
        [id, "google", id, `${id}@example.test`, id, NOW],
      );
      await sql.run(
        "INSERT INTO auth_tokens (secret_digest,id,kind,principal_id,org_id,name,scopes_json,created_at,expires_at,revoked_at) VALUES (?,?,'session',?,NULL,'session','[]',?,?,NULL)",
        [
          await bytesDigest(new TextEncoder().encode(secret)),
          `session-${id}`,
          id,
          NOW,
          "2026-11-20T00:00:00.000Z",
        ],
      );
    }
    // Reuse the existing Accounts page fixture's deterministic seeded membership
    // shape. Normal Accounts/auth still determines every returned row and scope.
    for (const [id, owner] of [
      ...A_IDS.map((id) => [id, "member-a"] as const),
      [B_ORG, "member-b"] as const,
    ]) {
      await sql.run("INSERT INTO orgs (id,name,owner_principal_id,created_at) VALUES (?,?,?,?)", [
        id,
        `Membership ${id}`,
        owner,
        NOW,
      ]);
      await sql.run(
        "INSERT INTO org_memberships (org_id,principal_id,role,created_at) VALUES (?,?,'owner',?)",
        [id, owner, NOW],
      );
    }
    expect((await accounts.authenticate(`Bearer ${SESSION_A}`))?.principalId).toBe("member-a");
    expect((await accounts.authenticate(`Bearer ${SESSION_B}`))?.principalId).toBe("member-b");
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity,
      clock,
      settlement: {
        async verify(): Promise<never> {
          throw new Error("payments are not configured");
        },
      },
      publicOrigin: ORIGIN,
      consoleOrigin: CONSOLE,
      forms: [],
      hostForms: [],
      offerings: [],
      driver: new InMemoryTakoformResourceDriver(),
      v2: {
        cursorSigningKey: new Uint8Array(32).fill(0x5a),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/auth",
      },
    });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        // The actual original Request enters App.fetch unchanged after browser IO
        // adds Origin/cookie; method, URL, body, headers and AbortSignal are retained.
        const original = new Request(input, init);
        if (new URL(original.url).origin !== ORIGIN)
          throw new Error("external network is forbidden");
        if (original.method !== "GET") throw new Error("membership journey is read-only");
        original.headers.set("origin", CONSOLE);
        const sentSession = browserSession;
        if (original.credentials === "include")
          original.headers.set("cookie", `takoserver_session=${sentSession}`);
        const response = await app.fetch(original);
        const url = new URL(original.url);
        const record: (typeof requests)[number] = {
          method: original.method,
          path: url.pathname,
          cursor: url.searchParams.get("organizationCursor"),
          pageSize: url.searchParams.get("organizationPageSize"),
          status: response.status,
          browser: sentSession === SESSION_A ? "a" : "b",
        };
        if (url.pathname === "/v1/me" && response.status === 200) {
          const json: unknown = await response.clone().json();
          if (
            json === null ||
            typeof json !== "object" ||
            !("organizations" in json) ||
            !Array.isArray(json.organizations)
          )
            throw new Error("actual Host roster shape missing");
          record.rows = json.organizations.length;
          record.bytes = new TextEncoder().encode(JSON.stringify(json)).byteLength;
        }
        requests.push(record);
        if (holdA && sentSession === SESSION_A && url.pathname === "/v1/me") {
          holdA = false;
          holdingA = true;
          await delayed.promise;
        }
        return response;
      },
      { preconnect: originalFetch.preconnect },
    );
    state = await import("../console/src/state.ts");
    const { setConsoleLocale } = await import("../console/src/i18n.ts");
    setConsoleLocale("en");
    state.setApiOrigin(ORIGIN);
    state.adoptSession();
    state.selectOrganization(SAVED_UNKNOWN_ORG);
    await import("../console/src/main.ts");
    await waitFor(
      "first actual Host membership page",
      () => state?.organizationPageState() === "ready",
    );
    const active = state;
    const me = () => requests.filter((request) => request.path === "/v1/me");
    const keys = () => requests.filter((request) => request.path.endsWith("/api-keys"));
    expect(active.principal()?.id).toBe("member-a");
    expect(active.organizations().map((org) => org.id)).toEqual(A_IDS.slice(0, 100));
    expect(active.currentOrganizationId()).toBe(SAVED_UNKNOWN_ORG);
    expect(active.currentOrganization()).toBeNull();
    expect(root.textContent.includes("Selected organization is not loaded")).toBe(true);
    expect(keys()).toHaveLength(0);
    expect(me()).toHaveLength(1);
    expect(me()[0]).toMatchObject({ pageSize: "100", cursor: null, rows: 100, status: 200 });
    const cursorA = active.nextOrganizationCursor();
    if (cursorA === null) throw new Error("actual Host page-two cursor missing");
    button("Next organizations").click();
    await waitFor("actual cursor continuation", () => active.organizationPageState() === "ready");
    expect(me()).toHaveLength(2);
    expect(me()[1]).toMatchObject({ cursor: cursorA, rows: 1, status: 200 });
    expect(active.organizations().map((org) => org.id)).toEqual([SECOND_PAGE_ORG]);
    expect(active.organizationPageCursor()).toBe(cursorA);
    expect(active.nextOrganizationCursor()).toBeNull();
    expect(active.currentOrganization()).toBeNull();
    expect(keys()).toHaveLength(0);
    const secondPicker = picker();
    secondPicker.value = SECOND_PAGE_ORG;
    secondPicker.emit("change");
    await waitFor(
      "page-two member selection and actual scoped key list",
      () => keys().length === 1 && root.textContent.includes("No keys"),
    );
    expect(root.textContent.includes("No keys")).toBe(true);
    expect(active.currentOrganization()?.id).toBe(SECOND_PAGE_ORG);
    expect(keys()[0]).toMatchObject({
      path: `/v1/organizations/${SECOND_PAGE_ORG}/api-keys`,
      status: 200,
      browser: "a",
    });
    expect(picker().value).toBe(SECOND_PAGE_ORG);
    expect(picker().textContent.includes(`Membership ${SECOND_PAGE_ORG}`)).toBe(true);

    // Hold only delivery of the genuine A response. B's cookie is authenticated
    // by the same Host and gets its own first page while A is still in flight.
    holdA = true;
    button("First page").click();
    await waitFor("actual A first-page response held in transport", () => holdingA);
    browserSession = SESSION_B;
    active.adoptSession();
    await waitFor(
      "new real session B membership",
      () => active.principal()?.id === "member-b" && active.organizationPageState() === "ready",
    );
    expect(active.organizations().map((org) => org.id)).toEqual([B_ORG]);
    // Adoption retires confirmed membership, while the saved local preference
    // remains unknown until B actually selects a member from B's Host page.
    expect(active.currentOrganizationId()).toBe(SECOND_PAGE_ORG);
    expect(active.currentOrganization()).toBeNull();
    expect(keys()).toHaveLength(1);
    expect(root.textContent.includes("Selected organization is not loaded")).toBe(true);
    const beforeRelease = requests.length;
    delayed.release();
    await tick();
    expect(active.principal()?.id).toBe("member-b");
    expect(active.organizations().map((org) => org.id)).toEqual([B_ORG]);
    expect(active.organizationPageState()).toBe("ready");
    expect(active.nextOrganizationCursor()).toBeNull();
    expect(root.textContent.includes("Membership org-a-")).toBe(false);
    expect(root.textContent.includes("Organization list unavailable")).toBe(false);
    expect(requests).toHaveLength(beforeRelease);

    // The old opaque cursor is also refused by the actual Host under B. This
    // is server cursor custody, not a claim that a retired DOM callback sends no GET.
    await expect(active.api.me(cursorA)).rejects.toMatchObject({ status: 400 });
    expect(me().at(-1)).toMatchObject({ cursor: cursorA, browser: "b", status: 400 });
    expect(active.principal()?.id).toBe("member-b");
    expect(active.organizations().map((org) => org.id)).toEqual([B_ORG]);
    const bPicker = picker();
    bPicker.value = B_ORG;
    bPicker.emit("change");
    await waitFor(
      "new B selected key list",
      () => keys().length === 2 && root.textContent.includes("No keys"),
    );
    expect(root.textContent.includes("No keys")).toBe(true);
    expect(active.currentOrganization()?.id).toBe(B_ORG);
    expect(keys()[1]).toMatchObject({
      path: `/v1/organizations/${B_ORG}/api-keys`,
      status: 200,
      browser: "b",
    });
    expect(
      me()
        .filter((request) => request.status === 200)
        .every(
          (request) =>
            request.rows !== undefined &&
            request.rows <= 100 &&
            request.bytes !== undefined &&
            request.bytes <= 65_536,
        ),
    ).toBe(true);
    expect(await sql.query("SELECT id FROM orgs")).toHaveLength(102);
    expect(await sql.query("SELECT org_id FROM org_memberships")).toHaveLength(102);
    expect(await sql.query("SELECT id FROM auth_tokens")).toHaveLength(2);
    expect(requests.every((request) => request.method === "GET")).toBe(true);
  } finally {
    delayed.release();
    if (state) {
      state.session.set(null);
      state.sessionKind.set(null);
      await tick();
      await tick();
    }
    globalThis.fetch = originalFetch;
    database.close();
  }
}, 10_000);
