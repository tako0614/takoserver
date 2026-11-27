import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApi } from "../console/src/api.ts";
import { buildApp } from "../src/app.ts";
import { createAccounts } from "../src/auth.ts";
import { bytesDigest } from "../src/json.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import { createSelfhostV2SQLiteStore } from "../src/providers/selfhost-v2-sqlite-store.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { InMemoryTakoformResourceDriver } from "../src/takoform/memory-driver.ts";
import { SQLITE_DATABASE_FORM_URL } from "../src/takoform-v2/forms/sqlite-database.ts";
import { createSQLiteDatabaseForm } from "../src/takoform-v2/forms/sqlite-database-backend.ts";
import { migrateSqliteDatabase } from "./helpers/migrated-database.ts";

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

  emit(type: string): void {
    for (const listener of this.listeners.get(type) ?? [])
      listener({ target: this } as unknown as Event);
  }

  focus(): void {}
}

const body = new TestNode("body");
const documentEvents = new TestNode("document");
const storage = new Map<string, string>();
const location = new URL("https://console.console-host-journey.test/resources");
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
const { resourcesPage } = await import("../console/src/pages/resources.ts");
const { updateResource, deleteResource } = await import("../console/src/pages/create-resource.ts");
const { sendResourceIntent, uncertainResourceIntents } = await import(
  "../console/src/resource-intent.ts"
);
const { live } = await import("../console/src/dom.ts");
const { signal } = await import("../console/src/reactive.ts");
const { navigate, route } = await import("../console/src/router.ts");
const { setConsoleLocale } = await import("../console/src/i18n.ts");
setConsoleLocale("en");

const ORIGIN = "https://api.console-host-journey.test";
const CONSOLE = "https://console.console-host-journey.test";
const NOW = "2026-11-13T00:00:00.000Z";
// Public synthetic local inputs: only their digests enter the in-memory auth store.
const OWNER_SESSION = "console-host-local-owner-session-fixture";
const READER_KEY = "console-host-local-reader-key-fixture";
const WRITER_KEY = "console-host-local-writer-key-fixture";
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 5));
async function waitFor(label: string, check: () => boolean): Promise<void> {
  for (let count = 0; count < 200; count++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`local journey did not reach ${label}`);
}
function button(label: string, root = body): TestNode {
  const found = root
    .all()
    .reverse()
    .find((node) => node.tag === "button" && node.textContent.trim() === label);
  if (!found) throw new Error(`local journey control missing: ${label}`);
  return found;
}
function field(id: string): TestNode {
  const found = body.all().find((node) => node.attributes.get("id") === id);
  if (!found) throw new Error(`local journey field missing: ${id}`);
  return found;
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

async function resourceJourney(completedBeforeRetry: boolean): Promise<void> {
  const database = migrateSqliteDatabase();
  const root = mkdtempSync(join(tmpdir(), "console-host-v2-resource-journey-"));
  const sql = createSqliteSql(database);
  const enabled = signal(false);
  let stopIdentity: (() => void) | undefined;
  const failures: unknown[] = [];
  const requests: { method: string; path: string; status: number; selected: string | null }[] = [];
  const deleteRequests: {
    key: string | null;
    generation: string | null;
    selected: string | null;
    originalSession: boolean;
  }[] = [];
  let dropDelete = false;
  let lostDeleteId: string | null = null;
  try {
    const identity = {
      async verify(): Promise<never> {
        throw new Error("external identity is not used by this seeded local fixture");
      },
    };
    const clock = () => new Date(NOW);
    await sql.run(
      "INSERT INTO principals (id,provider,provider_subject,email,display_name,created_at) VALUES (?,?,?,?,?,?)",
      [
        "journey-owner",
        "google",
        "local-journey-owner",
        "journey-owner@example.test",
        "Journey owner",
        NOW,
      ],
    );
    await sql.run(
      "INSERT INTO auth_tokens (secret_digest,id,kind,principal_id,org_id,name,scopes_json,created_at,expires_at,revoked_at) VALUES (?,?,'session',?,NULL,'session','[]',?,?,NULL)",
      [
        await bytesDigest(new TextEncoder().encode(OWNER_SESSION)),
        "journey-session",
        "journey-owner",
        NOW,
        "2026-11-20T00:00:00.000Z",
      ],
    );
    const accounts = createAccounts({ sql, identity, clock });
    const owner = await accounts.authenticate(`Bearer ${OWNER_SESSION}`);
    if (!owner) throw new Error("seeded local owner did not authenticate");
    const organization = await accounts.createOrganization({
      actor: owner,
      name: "SQLite journey",
    });
    const other = await accounts.createOrganization({ actor: owner, name: "Other local Org" });
    for (const [id, secret, scopes] of [
      ["journey-reader", READER_KEY, ["resources:read"]],
      ["journey-writer", WRITER_KEY, ["resources:write"]],
    ] as const) {
      await sql.run(
        "INSERT INTO auth_tokens (secret_digest,id,kind,principal_id,org_id,name,scopes_json,created_at,expires_at,revoked_at) VALUES (?,?,'api_key',?,?,?,?,?,?,NULL)",
        [
          await bytesDigest(new TextEncoder().encode(secret)),
          id,
          "journey-owner",
          organization.id,
          id,
          JSON.stringify(scopes),
          NOW,
          "2026-11-13T01:00:00.000Z",
        ],
      );
    }
    const store = createSelfhostV2SQLiteStore({
      root: join(root, "sqlite"),
      targetKey: "console-local-sqlite",
      sql,
      now: clock,
    });
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
      // Required legacy port; the empty v1 Form set is never selected by this v2 journey.
      driver: new InMemoryTakoformResourceDriver(),
      v2: {
        cursorSigningKey: new Uint8Array(32).fill(0x5a),
        documentation: "https://docs.example.test/v2",
        authenticationDocumentation: "https://docs.example.test/v2/auth",
      },
      v2FormFactory: () => ({ [SQLITE_DATABASE_FORM_URL]: createSQLiteDatabaseForm({ store }) }),
    });
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        // Construct once from the client's original input/init, preserving its
        // method, URL, body, headers and AbortSignal; only browser-owned IO is added.
        const original = new Request(input, init);
        if (new URL(original.url).origin !== ORIGIN)
          throw new Error("external network is forbidden in this local journey");
        original.headers.set("origin", CONSOLE);
        if (original.credentials === "include")
          original.headers.set("cookie", `takoserver_session=${OWNER_SESSION}`);
        if (original.method === "DELETE")
          deleteRequests.push({
            key: original.headers.get("idempotency-key"),
            generation: original.headers.get("takoform-expected-generation"),
            selected: original.headers.get("takoform-organization"),
            originalSession:
              original.headers.get("cookie") === `takoserver_session=${OWNER_SESSION}`,
          });
        const response = await app.fetch(original);
        requests.push({
          method: original.method,
          path: new URL(original.url).pathname,
          status: response.status,
          selected: original.headers.get("takoform-organization"),
        });
        if (dropDelete && original.method === "DELETE" && response.status === 202) {
          dropDelete = false;
          const accepted: unknown = await response.clone().json();
          if (
            accepted === null ||
            typeof accepted !== "object" ||
            !("id" in accepted) ||
            typeof accepted.id !== "string"
          )
            throw new Error("actual lost receipt had no operation ID");
          lostDeleteId = accepted.id;
          throw new TypeError("local transport lost the accepted delete response");
        }
        return response;
      },
      { preconnect: originalFetch.preconnect },
    );

    state.setApiOrigin(ORIGIN);
    state.adoptSession();
    navigate("/resources");
    stopIdentity = state.observeSessionIdentity((error) => failures.push(error));
    await waitFor("actual bounded me", () => state.organizationPageState() === "ready");
    expect(state.principal()?.id).toBe("journey-owner");
    expect(state.currentOrganization()).toBeNull();
    expect(state.organizations().some((row) => row.id === organization.id)).toBe(true);
    state.selectOrganization(organization.id);
    expect(state.currentOrganization()?.id).toBe(organization.id);
    enabled.set(true);
    const frame = live(() => {
      if (!enabled()) return null;
      const current = state.currentOrganization();
      return current ? resourcesPage(current.id) : null;
    });
    if (!(frame instanceof TestNode)) throw new Error("actual Resources frame missing");
    body.append(frame);
    await waitFor("initial empty Resource list", () =>
      frame.textContent.includes("Nothing declared yet"),
    );
    button("New resource", frame).click();
    await waitFor("actual Form choices", () =>
      body.all().some((node) => node.tag === "option" && node.value === SQLITE_DATABASE_FORM_URL),
    );
    const picker = body.all().find((node) => node.tag === "select");
    if (!picker) throw new Error("actual Form picker missing");
    picker.value = SQLITE_DATABASE_FORM_URL;
    picker.emit("change");
    field("create-resource-name").value = "journey-db";
    field("create-resource-name").emit("input");
    field("create-resource-spec").value = "{}";
    button("Create").click();
    await waitFor("accepted create route", () => route().query.has("operation"));
    const createId = route().query.get("operation");
    if (!createId) throw new Error("actual create ACK missing");
    await waitFor(
      "original queued create display",
      () =>
        frame.textContent.includes(createId) &&
        frame.textContent.includes("In progress") &&
        frame.textContent.includes("Pending"),
    );
    expect(await state.api.resourceOperation(organization.id, createId)).toMatchObject({
      id: createId,
      status: "queued",
    });
    expect(await app.tickTakoformV2()).toMatchObject({ id: createId, status: "succeeded" });
    await waitFor("created Resource list", () => frame.textContent.includes("journey-db"));
    button("Reload", frame).click();
    await waitFor(
      "actual completed create display",
      () =>
        frame.textContent.includes(createId) &&
        frame.textContent.includes("Done") &&
        frame.textContent.includes("Applied"),
    );
    expect(frame.textContent.includes(createId)).toBe(true);
    const first = (await state.api.resources(organization.id)).resources[0];
    if (!first) throw new Error("actual created Resource missing");
    expect(first).toMatchObject({
      form: SQLITE_DATABASE_FORM_URL,
      generation: 1,
      observedGeneration: 1,
      observed: { databaseExists: true },
    });
    const file = join(root, "sqlite", "resources", first.uid, "database.sqlite");
    expect(existsSync(file)).toBe(true);
    expect(await state.api.resourceOperation(organization.id, createId)).toMatchObject({
      id: createId,
      status: "succeeded",
      effect: "complete",
    });

    let readerLost = 0;
    const reader = createApi({
      origin: ORIGIN,
      token: () => READER_KEY,
      onSessionLost: () => {
        readerLost++;
      },
    });
    const writer = createApi({ origin: ORIGIN, token: () => WRITER_KEY, onSessionLost() {} });
    expect((await reader.resource(organization.id, first.uid)).uid).toBe(first.uid);
    expect((await writer.resources(organization.id)).resources).toHaveLength(1);
    await expect(
      reader.updateResource(
        organization.id,
        first.uid,
        first.generation,
        {},
        "reader-refused-update-0001",
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(reader.resources(other.id)).rejects.toMatchObject({ status: 403 });
    expect(await sql.query("SELECT id FROM tf_v2_operations")).toHaveLength(1);
    await sql.run("UPDATE auth_tokens SET revoked_at=? WHERE id=?", [NOW, "journey-reader"]);
    await expect(reader.resource(organization.id, first.uid)).rejects.toMatchObject({
      status: 401,
    });
    expect(readerLost).toBe(1);
    await sql.run("UPDATE auth_tokens SET expires_at=? WHERE id=?", [NOW, "journey-writer"]);
    await expect(writer.resource(organization.id, first.uid)).rejects.toMatchObject({
      status: 401,
    });

    updateResource(organization.id, first);
    field("update-resource-spec").value = "{}";
    button("Update").click();
    await waitFor("accepted update route", () => {
      const operationId = route().query.get("operation");
      return operationId !== null && operationId !== createId;
    });
    const updateId = route().query.get("operation");
    if (!updateId) throw new Error("actual update ACK missing");
    await waitFor(
      "original queued update display",
      () =>
        frame.textContent.includes(updateId) &&
        frame.textContent.includes("In progress") &&
        frame.textContent.includes("Pending"),
    );
    expect(await app.tickTakoformV2()).toMatchObject({
      id: updateId,
      action: "update",
      generation: 2,
      status: "succeeded",
    });
    button("Reload", frame).click();
    await waitFor(
      "updated display",
      () =>
        frame.textContent.includes(updateId) &&
        frame.textContent.includes("Done") &&
        frame.textContent.includes("Applied"),
    );
    expect(frame.textContent.includes(updateId)).toBe(true);
    const changed = await state.api.resource(organization.id, first.uid);
    expect(changed).toMatchObject({
      generation: 2,
      observedGeneration: 2,
      observed: { databaseExists: true },
    });
    expect(existsSync(file)).toBe(true);

    deleteResource(organization.id, changed);
    await waitFor("read-before-delete completed", () => !button("Delete resource").disabled);
    dropDelete = true;
    button("Delete resource").click();
    await waitFor("unknown acceptance route", () => route().query.get("acceptance") === "unknown");
    expect(frame.textContent.includes("Acceptance is unknown")).toBe(true);
    const intent = uncertainResourceIntents(organization.id)[0];
    if (!intent || intent.firstSentAt === null || lostDeleteId === null)
      throw new Error("actual lost-delete intent/receipt missing");
    expect(intent.body).toEqual({ action: "delete", uid: first.uid, generation: 2 });
    expect(intent.operationId).toBeNull();
    const sentAt = intent.firstSentAt;
    const originalKey = intent.key;
    const originalPrincipal = state.principal();
    const originalOrganization = state.currentOrganization();
    const beforeResend = requests.filter((row) => row.method !== "GET").length;
    await expect(
      sendResourceIntent(intent.id, sentAt + intent.replayWindowSeconds * 1000 + 1),
    ).rejects.toMatchObject({ code: "replay_window_expired" });
    expect(requests.filter((row) => row.method !== "GET")).toHaveLength(beforeResend);

    if (completedBeforeRetry) {
      // The backend completes while the browser still has no accepted handle.
      // The retained original receipt, not a live Resource or a new key, must
      // allow the normal exact retry to recover this completed Operation.
      expect(existsSync(file)).toBe(true);
      const completedDelete = await app.tickTakoformV2();
      expect(completedDelete).toMatchObject({
        id: lostDeleteId,
        action: "delete",
        status: "succeeded",
      });
      if (completedDelete === null) throw new Error("original delete did not complete");
      expect(
        Date.parse(completedDelete.retainUntil) >=
          Date.parse(NOW) + intent.replayWindowSeconds * 1000,
      ).toBe(true);
      expect(existsSync(file)).toBe(false);
      await expect(state.api.resource(organization.id, first.uid)).rejects.toMatchObject({
        code: "gone",
        status: 410,
      });
      expect(frame.textContent.includes("Acceptance is unknown")).toBe(true);
    }

    // The dropped raw ACK is a comparison oracle only. The real Console must
    // discover that Operation via its original same-key recovery action.
    button("Retry exact request", frame).click();
    await waitFor(
      "normal Console discovers the original delete Operation",
      () =>
        route().query.get("operation") === lostDeleteId &&
        intent.operationId === lostDeleteId &&
        !intent.inFlight,
    );
    const recoveredDeleteId = route().query.get("operation");
    if (recoveredDeleteId === null) throw new Error("normal delete recovery returned no handle");
    expect(recoveredDeleteId === lostDeleteId).toBe(true);
    expect(route().query.get("intent") === intent.id).toBe(true);
    expect(route().query.get("acceptance")).toBeNull();
    expect(intent.firstSentAt === sentAt && intent.key === originalKey).toBe(true);
    expect(intent.uncertain).toBe(false);
    expect(state.principal() === originalPrincipal).toBe(true);
    expect(state.currentOrganization() === originalOrganization).toBe(true);
    expect(deleteRequests).toHaveLength(2);
    expect(
      deleteRequests.every(
        (request) =>
          request.key !== null &&
          request.key === originalKey &&
          request.generation === "2" &&
          request.selected === organization.id &&
          request.originalSession,
      ),
    ).toBe(true);
    expect(
      requests
        .filter((request) => request.method === "DELETE" && request.path.endsWith(first.uid))
        .map((request) => request.status),
    ).toEqual([202, completedBeforeRetry ? 200 : 202]);
    expect(await sql.query("SELECT id FROM tf_v2_operations")).toHaveLength(3);
    if (completedBeforeRetry) {
      expect(existsSync(file)).toBe(false);
      await waitFor("normal completed delete presentation", () =>
        frame.textContent.includes("Deletion complete"),
      );
    } else {
      expect(existsSync(file)).toBe(true);
      expect(await app.tickTakoformV2()).toMatchObject({
        id: recoveredDeleteId,
        action: "delete",
        status: "succeeded",
      });
    }
    expect(await app.tickTakoformV2()).toBeNull();
    expect(await state.api.resourceOperation(organization.id, recoveredDeleteId)).toMatchObject({
      id: recoveredDeleteId,
      status: "succeeded",
      effect: "complete",
    });
    button("Reload", frame).click();
    await waitFor("actual deletion display", () =>
      frame.textContent.includes("Nothing declared yet"),
    );
    expect(existsSync(file)).toBe(false);
    await expect(state.api.resource(organization.id, first.uid)).rejects.toMatchObject({
      code: "gone",
      status: 410,
    });
    expect((await state.api.resources(organization.id)).resources).toHaveLength(0);
    expect(await sql.query("SELECT uid FROM tf_v2_resources")).toHaveLength(1);
    expect(await sql.query("SELECT id FROM tf_v2_operations")).toHaveLength(3);
    expect(
      requests.filter((row) => row.method === "POST" && row.path.endsWith("/resources")),
    ).toHaveLength(1);
    expect(
      requests.filter((row) => row.method === "DELETE" && row.path.endsWith(first.uid)),
    ).toHaveLength(2);
    expect(requests.some((row) => row.path === "/v1/me" && row.status === 200)).toBe(true);
    expect(failures).toEqual([]);
  } finally {
    enabled.set(false);
    dismiss();
    stopIdentity?.();
    state.adoptSession();
    await tick();
    globalThis.fetch = originalFetch;
    database.close();
    rmSync(root, { recursive: true, force: true });
  }
  expect(existsSync(root)).toBe(false);
}

for (const completedBeforeRetry of [false, true]) {
  test(
    `Console selection and real SQLite Host resource recover a ${completedBeforeRetry ? "completed" : "queued"} delete after its lost ACK`,
    () => resourceJourney(completedBeforeRetry),
    10_000,
  );
}
