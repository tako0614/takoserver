import type { AiGateway } from "../../src/ai-port.ts";
import { buildApp } from "../../src/app.ts";
import type { BillingConfig } from "../../src/billing-config.ts";
import { resolveIdentity } from "../../src/identity-setup.ts";
import { base64UrlEncode } from "../../src/json.ts";
import { createMemoryObjectStore } from "../../src/objects-mem.ts";
import { createSqliteSql } from "../../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../../src/takoform/memory-driver.ts";
import { migrateSqliteDatabase } from "./migrated-database.ts";

/** Registration-free DOM boundary. No globals or database are touched on import. */
export class ConsoleTestNode {
  readonly children: ConsoleTestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly style: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly listeners = new Map<string, EventListener[]>();
  parent: ConsoleTestNode | null = null;
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
  all(): ConsoleTestNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  append(...values: Array<ConsoleTestNode | string>): void {
    for (const value of values) {
      const child = typeof value === "string" ? new ConsoleTestNode("text", value) : value;
      if (child.tag === "fragment") {
        this.append(...child.children.slice());
        continue;
      }
      child.remove();
      child.parent = this;
      this.children.push(child);
      if (this.tag === "select" && (this.children.length === 1 || child.attributes.has("selected")))
        this.value = child.value;
    }
  }
  replaceChildren(...values: Array<ConsoleTestNode | string>): void {
    for (const child of this.children.slice()) child.remove();
    this.append(...values);
  }
  remove(): void {
    if (!this.parent) return;
    const index = this.parent.children.indexOf(this);
    if (index >= 0) this.parent.children.splice(index, 1);
    this.parent = null;
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
      (this.listeners.get(type) ?? []).filter((held) => held !== listener),
    );
  }
  click(): void {
    if (!this.disabled)
      for (const listener of this.listeners.get("click") ?? [])
        listener({ target: this, preventDefault() {}, stopPropagation() {} } as unknown as Event);
  }
  change(): void {
    for (const listener of this.listeners.get("change") ?? [])
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

export function installConsoleTestDom(url: string) {
  const names = [
    "Node",
    "HTMLInputElement",
    "document",
    "window",
    "localStorage",
    "sessionStorage",
    "fetch",
  ] as const;
  const saved = names.map(
    (name) => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const,
  );
  const originalFetch = globalThis.fetch;
  const body = new ConsoleTestNode("body");
  const root = new ConsoleTestNode("main");
  body.append(root);
  const events = new ConsoleTestNode("document");
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
  const location = new URL(url);
  const move = (_state: unknown, _title: string, path: string | URL | null): void => {
    if (path !== null) location.href = new URL(path, location).href;
  };
  Object.assign(globalThis, {
    Node: ConsoleTestNode,
    HTMLInputElement: ConsoleTestNode,
    localStorage: storage,
    sessionStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    document: {
      body,
      documentElement: new ConsoleTestNode("html"),
      getElementById: (id: string) => (id === "root" ? root : null),
      createElement: (tag: string) => new ConsoleTestNode(tag),
      createElementNS: (_namespace: string, tag: string) => new ConsoleTestNode(tag),
      createTextNode: (text: string) => new ConsoleTestNode("text", text),
      createDocumentFragment: () => new ConsoleTestNode("fragment"),
      addEventListener: events.addEventListener.bind(events),
      removeEventListener: events.removeEventListener.bind(events),
    },
    window: {
      location,
      history: { replaceState: move, pushState: move },
      scrollTo() {},
      addEventListener() {},
    },
  });
  return {
    root,
    body,
    origin: location.origin,
    originalFetch,
    restore(): void {
      for (const [name, descriptor] of saved) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else Reflect.deleteProperty(globalThis, name);
      }
    },
  };
}

export interface LocalConsoleRequest {
  readonly method: string;
  readonly path: string;
  readonly status: number;
  readonly clearsSessionCookie: boolean;
  deliveredAt?: number;
}
export interface LocalConsoleIo {
  readonly beforeHost?: (request: Request) => Promise<void>;
  readonly beforeDelivery?: (request: Request, response: Response) => Promise<void>;
}

/** Actual App/auth/signatures; only local browser IO can be delayed by callers. */
export async function createSignedConsoleHost(
  consoleOrigin: string,
  io: LocalConsoleIo = {},
  billingConfig?: BillingConfig,
  ai?: AiGateway,
) {
  const origin = "https://api.logout-cookie.test";
  const now = "2026-11-13T00:00:00.000Z";
  const database = migrateSqliteDatabase();
  let cookie = "";
  try {
    const sql = createSqliteSql(database);
    const clock = () => new Date(now);
    const keys = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicJwk = await crypto.subtle.exportKey("jwk", keys.publicKey);
    if (typeof publicJwk.x !== "string") throw new Error("local public verifier key missing");
    const setup = resolveIdentity({
      operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: publicJwk.x },
      operatorAudience: origin,
      clock,
    });
    for (const id of ["logout-a", "logout-b"]) {
      await sql.run(
        "INSERT INTO principals (id,provider,provider_subject,email,display_name,created_at) VALUES (?,?,?,?,?,?)",
        [id, "google", id, `${id}@example.test`, id, now],
      );
      await sql.run("INSERT INTO orgs (id,name,owner_principal_id,created_at) VALUES (?,?,?,?)", [
        `org-${id}`,
        id,
        id,
        now,
      ]);
      await sql.run(
        "INSERT INTO org_memberships (org_id,principal_id,role,created_at) VALUES (?,?,'owner',?)",
        [`org-${id}`, id, now],
      );
    }
    const assertion = async (subject: string): Promise<string> => {
      const payload = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            purpose: "sign-in",
            aud: origin,
            provider: "google",
            subject,
            email: `${subject}@example.test`,
            displayName: subject,
            iat: clock().getTime() / 1000,
            exp: clock().getTime() / 1000 + 300,
          }),
        ),
      );
      return `${payload}.${base64UrlEncode(new Uint8Array(await crypto.subtle.sign("Ed25519", keys.privateKey, new TextEncoder().encode(payload))))}`;
    };
    const app = buildApp({
      sql,
      ...(billingConfig === undefined ? {} : { billingConfig }),
      ...(ai === undefined ? {} : { ai }),
      objects: createMemoryObjectStore(),
      identity: setup.verifier,
      identityProviders: setup.providers,
      clock,
      settlement: {
        async verify(): Promise<never> {
          throw new Error("payments are not configured");
        },
      },
      publicOrigin: origin,
      consoleOrigin,
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
    const requests: LocalConsoleRequest[] = [];
    let deliverySequence = 0;
    let inFlight = 0;
    const transport = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const original = new Request(input, init);
        const url = new URL(original.url);
        if (url.origin !== origin) throw new Error("external network is forbidden");
        original.headers.set("origin", consoleOrigin);
        if (original.credentials === "include" && cookie !== "")
          original.headers.set("cookie", `takoserver_session=${cookie}`);
        inFlight++;
        try {
          await io.beforeHost?.(original);
          const response = await app.fetch(original);
          const cookies = response.headers.getSetCookie();
          const record: LocalConsoleRequest = {
            method: original.method,
            path: url.pathname,
            status: response.status,
            clearsSessionCookie: cookies.some(
              (value) => value.startsWith("takoserver_session=") && /max-age=0/iu.test(value),
            ),
          };
          requests.push(record);
          await io.beforeDelivery?.(original, response);
          for (const value of cookies) {
            const pair = value.split(";", 1)[0];
            if (pair?.startsWith("takoserver_session="))
              cookie = /max-age=0/iu.test(value) ? "" : pair.slice("takoserver_session=".length);
          }
          record.deliveredAt = ++deliverySequence;
          return response;
        } finally {
          inFlight--;
        }
      },
      { preconnect: globalThis.fetch.preconnect },
    );
    return {
      origin,
      sql,
      requests,
      transport,
      tick: () => app.tick(),
      assertion,
      cookiePresent: () => cookie !== "",
      pending: () => inFlight,
      initialSignIn: async (subject: string) =>
        transport(`${origin}/v1/sessions`, {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            provider: "google",
            method: "operator-assertion",
            assertion: await assertion(subject),
          }),
        }),
      close(): void {
        cookie = "";
        database.close();
      },
    };
  } catch (error) {
    database.close();
    throw error;
  }
}
