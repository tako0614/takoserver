import { afterAll, expect, test } from "bun:test";
import { ApiError, createApi } from "../console/src/api.ts";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import { base64UrlEncode } from "../src/json.ts";
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

  async submit(): Promise<void> {
    for (const listener of this.listeners.get("submit") ?? [])
      await listener({ preventDefault() {} } as unknown as Event);
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
const location = new URL("https://console.session-recovery-journey.test/keys");
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

const ORIGIN = "https://api.session-recovery-journey.test";
const CONSOLE = location.origin;
const NOW = "2026-11-13T00:00:00.000Z";
const ORG_A = "org-recovery-a";
const ORG_B = "org-recovery-b";
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitFor(label: string, check: () => boolean): Promise<void> {
  for (let count = 0; count < 200; count++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`local session recovery did not reach ${label}`);
}
function button(label: string): TestNode {
  const found = root.all().find((node) => node.tag === "button" && node.textContent === label);
  if (!found) throw new Error("local session recovery control missing");
  return found;
}
function chooseOrg(id: string): void {
  const picker = root
    .all()
    .find((node) => node.tag === "select" && node.attributes.get("aria-label") === "Organization");
  if (!picker) throw new Error("actual organization picker missing");
  picker.value = id;
  picker.emit("change");
}
function gate() {
  let release = (): void => {
    throw new Error("local response gate not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
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
afterAll(() => {
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
});

test("real revoked session returns main to signed assertion login and a delayed old 401 cannot retire its replacement", async () => {
  const database = migrateSqliteDatabase();
  const sql = createSqliteSql(database);
  const clock = () => new Date(NOW);
  const delayed = gate();
  let browserCookie = "";
  let oldCookie = "";
  let recoveryAssertion = "";
  let holdNext401 = false;
  let holding401 = false;
  let state: typeof import("../console/src/state.ts") | undefined;
  const requests: Array<{
    method: string;
    path: string;
    status: number;
    sessionCookieWritten: boolean;
    bodyHasSessionToken: boolean;
  }> = [];
  try {
    // A genuine ephemeral verifier, not a successful identity DTO or an auth
    // override. Keys/assertions/cookies never leave this in-memory fixture.
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
    if (typeof jwk.x !== "string") throw new Error("local public verifier key missing");
    const setup = resolveIdentity({
      operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: jwk.x },
      operatorAudience: ORIGIN,
      clock,
    });
    const signed = async (subject: string): Promise<string> => {
      const payload = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            purpose: "sign-in",
            aud: ORIGIN,
            provider: "google",
            subject,
            email: `${subject}@example.test`,
            displayName: subject,
            iat: clock().getTime() / 1000,
            exp: clock().getTime() / 1000 + 300,
          }),
        ),
      );
      const signature = await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(payload),
      );
      return `${payload}.${base64UrlEncode(new Uint8Array(signature))}`;
    };
    for (const [id, organization] of [
      ["recovery-a", ORG_A],
      ["recovery-b", ORG_B],
    ] as const) {
      await sql.run(
        "INSERT INTO principals (id,provider,provider_subject,email,display_name,created_at) VALUES (?,?,?,?,?,?)",
        [id, "google", id, `${id}@example.test`, id, NOW],
      );
      await sql.run("INSERT INTO orgs (id,name,owner_principal_id,created_at) VALUES (?,?,?,?)", [
        organization,
        `Organization ${id}`,
        id,
        NOW,
      ]);
      await sql.run(
        "INSERT INTO org_memberships (org_id,principal_id,role,created_at) VALUES (?,?,'owner',?)",
        [organization, id, NOW],
      );
    }
    const accounts = createAccounts({ sql, identity: setup.verifier, clock });
    const app = buildApp({
      sql,
      objects: createMemoryObjectStore(),
      identity: setup.verifier,
      identityProviders: setup.providers,
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
        // Same constructed Request, including body/headers/URL/method/signal,
        // enters App.fetch. This bridge implements only browser IO and one hold.
        const original = new Request(input, init);
        const url = new URL(original.url);
        if (url.origin !== ORIGIN) throw new Error("external network is forbidden");
        original.headers.set("origin", CONSOLE);
        if (original.credentials === "include" && browserCookie !== "")
          original.headers.set("cookie", `takoserver_session=${browserCookie}`);
        const response = await app.fetch(original);
        const payload: unknown = await response.clone().json();
        const cookies = response.headers.getSetCookie();
        const writeSession = (): void => {
          for (const cookie of cookies) {
            const pair = cookie.split(";", 1)[0];
            if (pair?.startsWith("takoserver_session="))
              browserCookie = /max-age=0/iu.test(cookie)
                ? ""
                : pair.slice("takoserver_session=".length);
          }
        };
        requests.push({
          method: original.method,
          path: url.pathname,
          status: response.status,
          sessionCookieWritten: cookies.some((cookie) => cookie.startsWith("takoserver_session=")),
          bodyHasSessionToken:
            payload !== null &&
            typeof payload === "object" &&
            Object.hasOwn(payload, "sessionToken"),
        });
        if (
          holdNext401 &&
          response.status === 401 &&
          url.pathname === `/v1/organizations/${ORG_A}/api-keys`
        ) {
          holdNext401 = false;
          holding401 = true;
          await delayed.promise;
        }
        // Apply Set-Cookie at response delivery, including after a deliberate hold.
        writeSession();
        return response;
      },
      { preconnect: originalFetch.preconnect },
    );
    const initial = await fetch(`${ORIGIN}/v1/sessions`, {
      method: "POST",
      credentials: "include",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        provider: "google",
        method: "operator-assertion",
        assertion: await signed("recovery-a"),
      }),
    });
    expect(initial.status).toBe(200);
    expect(browserCookie.length > 0).toBe(true);
    oldCookie = browserCookie;
    state = await import("../console/src/state.ts");
    const { setConsoleLocale } = await import("../console/src/i18n.ts");
    setConsoleLocale("en");
    state.setApiOrigin(ORIGIN);
    state.adoptSession();
    await import("../console/src/main.ts");
    const active = state;
    await waitFor(
      "initial genuine A identity",
      () => active.principal()?.id === "recovery-a" && active.organizationPageState() === "ready",
    );
    chooseOrg(ORG_A);
    await waitFor("selected A key page", () => root.textContent.includes("No keys"));
    expect(active.currentOrganization()?.id === ORG_A).toBe(true);

    await accounts.revokeSession(`Bearer ${oldCookie}`);
    expect((await accounts.authenticate(`Bearer ${oldCookie}`)) === null).toBe(true);
    holdNext401 = true;
    const lateUnauthorized = status(() => active.api.apiKeys(ORG_A));
    await waitFor("actual revoked A response held", () => holding401);
    button("Refresh keys").click();
    await waitFor(
      "main returned to configured operator login",
      () =>
        active.session() === null &&
        root.all().some((node) => node.attributes.get("id") === "assertion"),
    );
    expect(active.principal() === null).toBe(true);
    expect(active.currentOrganizationId() === null).toBe(true);
    expect(active.currentOrganization() === null).toBe(true);
    expect(active.organizations().length).toBe(0);
    expect(storage.has("takoserver.organization")).toBe(false);
    expect(root.all().some((node) => node.tag === "h1" && node.textContent === "API keys")).toBe(
      false,
    );
    const assertion = root.all().find((node) => node.attributes.get("id") === "assertion");
    const form = root
      .all()
      .find((node) => node.tag === "form" && node.all().some((child) => child === assertion));
    if (!assertion || !form) throw new Error("actual operator sign-in form missing");
    recoveryAssertion = await signed("recovery-b");
    assertion.value = recoveryAssertion;
    await form.submit();
    await waitFor(
      "genuine signed B reauthentication",
      () => active.principal()?.id === "recovery-b" && active.organizationPageState() === "ready",
    );
    expect(browserCookie.length > 0 && browserCookie !== oldCookie).toBe(true);
    expect(active.session() === "cookie").toBe(true);
    expect(active.organizations().length).toBe(1);
    expect(active.organizations().every((org) => org.id === ORG_B)).toBe(true);
    expect(active.currentOrganizationId() === null).toBe(true);
    expect(active.currentOrganization() === null).toBe(true);
    expect(root.textContent.includes("Choose an organization")).toBe(true);
    expect(root.textContent.includes(recoveryAssertion)).toBe(false);
    const beforeRelease = requests.length;
    delayed.release();
    expect(await lateUnauthorized).toBe(401);
    await tick();
    expect(active.principal()?.id === "recovery-b").toBe(true);
    expect(active.session() === "cookie").toBe(true);
    expect(active.organizationPageState() === "ready").toBe(true);
    expect(active.currentOrganization() === null).toBe(true);
    expect(requests.length).toBe(beforeRelease);
    chooseOrg(ORG_B);
    await waitFor("explicit B selection reads current key page", () =>
      root.textContent.includes("No keys"),
    );
    expect(active.currentOrganization()?.id === ORG_B).toBe(true);
    const beforeRefresh = requests.filter(
      (request) => request.path === `/v1/organizations/${ORG_B}/api-keys`,
    ).length;
    button("Refresh keys").click();
    await waitFor(
      "replacement session remains accepted by Host",
      () =>
        requests.filter(
          (request) =>
            request.path === `/v1/organizations/${ORG_B}/api-keys` && request.status === 200,
        ).length > beforeRefresh,
    );
    expect(active.principal()?.id === "recovery-b").toBe(true);
    const oldClient = createApi({ origin: ORIGIN, token: () => oldCookie, onSessionLost() {} });
    expect(await status(() => oldClient.me())).toBe(401);
    expect(active.principal()?.id === "recovery-b").toBe(true);
    const rows = await sql.query("SELECT revoked_at FROM auth_tokens WHERE kind='session'");
    expect(rows.length).toBe(2);
    expect(rows.filter((row) => row.revoked_at === NOW).length).toBe(1);
    expect(rows.filter((row) => row.revoked_at === null).length).toBe(1);
    expect(
      requests.filter(
        (request) =>
          request.method === "POST" && request.path === "/v1/sessions" && request.status === 200,
      ).length,
    ).toBe(2);
    expect(requests.filter((request) => request.sessionCookieWritten).length).toBe(2);
    expect(requests.some((request) => request.bodyHasSessionToken)).toBe(false);
    expect(
      requests.every(
        (request) =>
          request.method === "GET" ||
          (request.method === "POST" && request.path === "/v1/sessions"),
      ),
    ).toBe(true);
    expect((await sql.query("SELECT id FROM principals")).length).toBe(2);
    expect((await sql.query("SELECT id FROM orgs")).length).toBe(2);
  } finally {
    delayed.release();
    recoveryAssertion = "";
    oldCookie = "";
    browserCookie = "";
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
