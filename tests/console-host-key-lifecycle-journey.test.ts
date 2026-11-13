import { afterAll, expect, test } from "bun:test";
import { ApiError, createApi } from "../console/src/api.ts";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
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
const location = new URL("https://console.key-lifecycle-journey.test/keys");
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

const ORIGIN = "https://api.key-lifecycle-journey.test";
const CONSOLE = location.origin;
const NOW = "2026-11-13T00:00:00.000Z";
const ORG = "org-owner-100";
const FOREIGN = "org-other-only";
const KEY_NAME = "journey-reader";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitFor(label: string, check: () => boolean): Promise<void> {
  for (let count = 0; count < 200; count++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`local key journey did not reach ${label}`);
}
function button(label: string, parent = body): TestNode {
  const found = parent.all().find((node) => node.tag === "button" && node.textContent === label);
  if (!found) throw new Error("local key journey control missing");
  return found;
}
function modal(label: string): TestNode {
  const found = body
    .all()
    .find(
      (node) =>
        node.attributes.get("role") === "dialog" && node.attributes.get("aria-label") === label,
    );
  if (!found) throw new Error("local key journey dialog missing");
  return found;
}
function field(id: string): TestNode {
  const found = body.all().find((node) => node.attributes.get("id") === id);
  if (!found) throw new Error("local key journey field missing");
  return found;
}
function chooseOrg(id: string): void {
  const found = root
    .all()
    .find((node) => node.tag === "select" && node.attributes.get("aria-label") === "Organization");
  if (!found) throw new Error("actual organization picker missing");
  found.value = id;
  found.emit("change");
}
function createDialog(name: string): TestNode {
  button("Create key", root).click();
  field("create-key-name").value = name;
  return modal("Create API key");
}
function scope(dialog: TestNode, id: string, checked: boolean): void {
  const label = dialog
    .all()
    .find(
      (node) =>
        node.tag === "label" &&
        node
          .all()
          .some((child) => child.className === "mono check__id" && child.textContent === id),
    );
  const box = label?.all().find((node) => node.tag === "input");
  if (!box) throw new Error("actual scope checkbox missing");
  box.checked = checked;
  box.emit("change");
}
async function status(action: () => Promise<unknown>): Promise<number> {
  try {
    await action();
    return 200;
  } catch (error) {
    if (error instanceof ApiError) return error.status;
    throw new Error("unexpected local API failure; payload deliberately omitted");
  }
}
function dismiss(): void {
  for (const listener of [...(documentEvents.listeners.get("keydown") ?? [])])
    listener({ key: "Escape" } as unknown as Event);
}
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("page-two Console key creation/reveal/revoke uses actual Host scope and never widens a reader or retired session", async () => {
  const database = migrateSqliteDatabase();
  const sql = createSqliteSql(database);
  // All credential plaintext is generated for this in-memory fixture at runtime.
  // It is never asserted as a value, logged, serialized to evidence, or fixed here.
  const sessions = new Map(["owner", "other", "member"].map((id) => [id, crypto.randomUUID()]));
  const sessionFor = (id: string): string => {
    const value = sessions.get(id);
    if (!value) throw new Error("local session fixture missing");
    return value;
  };
  let browserSession = sessionFor("owner");
  let issuedSecret = "";
  let state: typeof import("../console/src/state.ts") | undefined;
  const requests: Array<{ method: string; path: string; status: number; hasSecret: boolean }> = [];
  try {
    for (const id of ["owner", "other", "member"]) {
      await sql.run(
        "INSERT INTO principals (id,provider,provider_subject,email,display_name,created_at) VALUES (?,?,?,?,?,?)",
        [id, "google", id, `${id}@example.test`, id, NOW],
      );
      await sql.run(
        "INSERT INTO auth_tokens (secret_digest,id,kind,principal_id,org_id,name,scopes_json,created_at,expires_at,revoked_at) VALUES (?,?,'session',?,NULL,'session','[]',?,?,NULL)",
        [
          await bytesDigest(new TextEncoder().encode(sessionFor(id))),
          `session-${id}`,
          id,
          NOW,
          "2026-11-20T00:00:00.000Z",
        ],
      );
    }
    for (const id of [
      ...Array.from({ length: 101 }, (_, index) => `org-owner-${String(index).padStart(3, "0")}`),
      FOREIGN,
    ]) {
      const owner = id === FOREIGN ? "other" : "owner";
      await sql.run("INSERT INTO orgs (id,name,owner_principal_id,created_at) VALUES (?,?,?,?)", [
        id,
        `Organization ${id}`,
        owner,
        NOW,
      ]);
      await sql.run(
        "INSERT INTO org_memberships (org_id,principal_id,role,created_at) VALUES (?,?,'owner',?)",
        [id, owner, NOW],
      );
    }
    await sql.run(
      "INSERT INTO org_memberships (org_id,principal_id,role,created_at) VALUES (?,?,'member',?)",
      [ORG, "member", NOW],
    );
    const identity = {
      async verify(): Promise<never> {
        throw new Error("external identity is not used");
      },
    };
    const clock = () => new Date(NOW);
    const accounts = createAccounts({ sql, identity, clock });
    expect((await accounts.authenticate(`Bearer ${sessionFor("owner")}`))?.kind === "session").toBe(
      true,
    );
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
        const original = new Request(input, init);
        if (new URL(original.url).origin !== ORIGIN)
          throw new Error("external network is forbidden");
        original.headers.set("origin", CONSOLE);
        if (original.credentials === "include")
          original.headers.set("cookie", `takoserver_session=${browserSession}`);
        // No request, headers, body or response object is recorded. Only safe
        // metadata and presence of a top-level secret field leave this bridge.
        const response = await app.fetch(original);
        const json: unknown = await response.clone().json();
        requests.push({
          method: original.method,
          path: new URL(original.url).pathname,
          status: response.status,
          hasSecret: json !== null && typeof json === "object" && Object.hasOwn(json, "secret"),
        });
        return response;
      },
      { preconnect: originalFetch.preconnect },
    );
    state = await import("../console/src/state.ts");
    const { setConsoleLocale } = await import("../console/src/i18n.ts");
    setConsoleLocale("en");
    state.setApiOrigin(ORIGIN);
    state.adoptSession();
    await import("../console/src/main.ts");
    const active = state;
    await waitFor(
      "real owner first membership page",
      () => active.organizationPageState() === "ready",
    );
    button("Next organizations", root).click();
    await waitFor(
      "real owner second membership page",
      () => active.organizationPageState() === "ready",
    );
    chooseOrg(ORG);
    await waitFor("selected page-two key list", () => root.textContent.includes("No keys"));
    expect(active.currentOrganization()?.id === ORG).toBe(true);

    const create = createDialog(KEY_NAME);
    scope(create, "resources:write", false);
    scope(create, "resources:read", true);
    // Actual roster repaint preserves the already-confirmed second-page Org.
    // The open modal must reload the currently visible replacement key list.
    button("First page", root).click();
    await waitFor("same-Org first-page repaint", () => active.organizationPageState() === "ready");
    expect(active.currentOrganization()?.id === ORG).toBe(true);
    expect(active.organizations().some((org) => org.id === ORG)).toBe(false);
    button("Create key", create).click();
    await waitFor("once-only key reveal", () =>
      body.all().some((node) => node.attributes.get("aria-label") === "Copy this key now"),
    );
    const reveal = modal("Copy this key now");
    const plaintext = reveal.all().find((node) => node.tag === "span" && node.className === "mono");
    if (!plaintext) throw new Error("local once-only reveal field missing");
    issuedSecret = plaintext.textContent;
    expect(issuedSecret.length > 0).toBe(true);
    expect(body.textContent.includes(issuedSecret)).toBe(true);
    await waitFor("current list records created key", () =>
      root.all().some((node) => node.tag === "tr" && node.textContent.includes(KEY_NAME)),
    );
    button("Done", reveal).click();
    expect(body.textContent.includes(issuedSecret)).toBe(false);
    button("Refresh keys", root).click();
    await tick();
    expect(body.textContent.includes(issuedSecret)).toBe(false);
    const listed = await active.api.apiKeys(ORG);
    expect(listed.apiKeys.length).toBe(1);
    expect(JSON.stringify(listed).includes(issuedSecret)).toBe(false);
    const key = listed.apiKeys[0];
    if (!key) throw new Error("local created key metadata missing");
    expect(
      key.organizationId === ORG &&
        key.name === KEY_NAME &&
        JSON.stringify(key.scopes) === JSON.stringify(["resources:read"]),
    ).toBe(true);
    const stored = await sql.query("SELECT secret_digest FROM auth_tokens WHERE id=?", [key.id]);
    expect(stored.length).toBe(1);
    expect(JSON.stringify(stored).includes(issuedSecret)).toBe(false);
    expect([...storage.values()].some((value) => value.includes(issuedSecret))).toBe(false);
    const reader = createApi({ origin: ORIGIN, token: () => issuedSecret, onSessionLost() {} });
    expect((await reader.resources(ORG)).resources.length).toBe(0);
    expect(
      await status(() =>
        reader.updateResource(ORG, "uid-local-absent", 1, {}, "local-reader-update-refusal-0001"),
      ),
    ).toBe(403);
    expect(await status(() => reader.resources(FOREIGN))).toBe(403);
    expect(
      await status(() =>
        reader.createApiKey(ORG, {
          name: "reader-cannot-issue",
          scopes: ["resources:write"],
          expiresInSeconds: 3600,
        }),
      ),
    ).toBe(401);
    const foreign = createApi({
      origin: ORIGIN,
      token: () => sessionFor("other"),
      onSessionLost() {},
    });
    const member = createApi({
      origin: ORIGIN,
      token: () => sessionFor("member"),
      onSessionLost() {},
    });
    expect(
      await status(() =>
        foreign.createApiKey(ORG, {
          name: "foreign-cannot-issue",
          scopes: ["resources:write"],
          expiresInSeconds: 3600,
        }),
      ),
    ).toBe(404);
    expect(
      await status(() =>
        member.createApiKey(ORG, {
          name: "member-cannot-issue",
          scopes: ["resources:write"],
          expiresInSeconds: 3600,
        }),
      ),
    ).toBe(404);
    expect(await status(() => member.revokeApiKey(ORG, key.id))).toBe(404);
    expect((await reader.resources(ORG)).resources.length).toBe(0);
    expect((await sql.query("SELECT id FROM auth_tokens WHERE kind='api_key'")).length).toBe(1);

    const retiredCreate = createDialog("retired-session-attempt");
    const oldConfirm = button("Create key", retiredCreate);
    const beforeSwitchPost = requests.filter((request) => request.method === "POST").length;
    browserSession = sessionFor("other");
    active.adoptSession();
    await waitFor(
      "other real session membership",
      () => active.principal()?.id === "other" && active.organizationPageState() === "ready",
    );
    expect(body.all().some((node) => node === retiredCreate)).toBe(false);
    oldConfirm.click();
    await tick();
    expect(requests.filter((request) => request.method === "POST").length).toBe(beforeSwitchPost);
    expect(active.currentOrganization() === null).toBe(true);
    expect(body.textContent.includes(issuedSecret)).toBe(false);

    browserSession = sessionFor("owner");
    active.adoptSession();
    await waitFor(
      "owner first page returns",
      () => active.principal()?.id === "owner" && active.organizationPageState() === "ready",
    );
    button("Next organizations", root).click();
    await waitFor(
      "owner selected second-page membership returns",
      () => active.organizationPageState() === "ready",
    );
    chooseOrg(ORG);
    await waitFor("owner key row returns", () =>
      root.all().some((node) => node.tag === "tr" && node.textContent.includes(KEY_NAME)),
    );
    const row = root.all().find((node) => node.tag === "tr" && node.textContent.includes(KEY_NAME));
    if (!row) throw new Error("local key row missing");
    button("Revoke", row).click();
    const revoke = modal(`Revoke ${KEY_NAME}?`);
    button("First page", root).click();
    await waitFor(
      "same-Org repaint before actual revoke",
      () => active.organizationPageState() === "ready",
    );
    button("Revoke key", revoke).click();
    await waitFor("visible revoked key list", () => root.textContent.includes("No keys"));
    expect(
      root.all().some((node) => node.tag === "tr" && node.textContent.includes(KEY_NAME)),
    ).toBe(false);
    expect(body.textContent.includes(issuedSecret)).toBe(false);
    expect(await status(() => reader.resources(ORG))).toBe(401);
    expect((await active.api.apiKeys(ORG)).apiKeys.length).toBe(0);
    const revoked = await sql.query("SELECT revoked_at FROM auth_tokens WHERE id=?", [key.id]);
    expect(revoked.length === 1 && revoked[0]?.revoked_at === NOW).toBe(true);
    expect(
      requests.filter((request) => request.method === "POST" && request.status === 201).length,
    ).toBe(1);
    expect(
      requests.filter((request) => request.method === "DELETE" && request.status === 200).length,
    ).toBe(1);
    expect(requests.filter((request) => request.hasSecret).length).toBe(1);
    expect(
      requests.every(
        (request) => !request.hasSecret || (request.method === "POST" && request.status === 201),
      ),
    ).toBe(true);
    expect((await sql.query("SELECT uid FROM tf_v2_resources")).length).toBe(0);
    expect((await sql.query("SELECT id FROM tf_v2_operations")).length).toBe(0);
  } finally {
    dismiss();
    issuedSecret = "";
    browserSession = "";
    sessions.clear();
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
