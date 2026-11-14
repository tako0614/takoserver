import { afterAll, beforeEach, expect, test } from "bun:test";
import {
  type ConsoleTestNode,
  createSignedConsoleHost,
  installConsoleTestDom,
} from "./helpers/console-local-host.ts";

const dom = installConsoleTestDom("https://console.google-recovery.test/");
Object.assign(window, { localStorage });
const values = new Map<string, string>();
const pendingKey = "takoserver.google.pending";
const storage = {
  getItem: (key: string) => values.get(key) ?? null,
  setItem: (key: string, value: string) => values.set(key, value),
  removeItem: (key: string) => values.delete(key),
};
Object.assign(globalThis, { sessionStorage: storage });
const assigned: string[] = [];
Object.assign(window.location, { assign: (url: string) => assigned.push(url) });
const google = await import("../console/src/google.ts");
const { navigate, route } = await import("../console/src/router.ts");
const { setConsoleLocale } = await import("../console/src/i18n.ts");
setConsoleLocale("en");
let state: typeof import("../console/src/state.ts") | undefined;
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function begin() {
  google.beginGoogleSignIn("local-client", "/billing");
  const raw = values.get(pendingKey);
  if (raw === undefined) throw new Error("original pending producer did not persist");
  const pending: unknown = JSON.parse(raw);
  if (
    typeof pending !== "object" ||
    pending === null ||
    !("state" in pending) ||
    typeof pending.state !== "string" ||
    !("nonce" in pending) ||
    typeof pending.nonce !== "string" ||
    !("from" in pending) ||
    typeof pending.from !== "string"
  )
    throw new Error("original pending producer shape changed");
  return { raw, state: pending.state, nonce: pending.nonce, from: pending.from };
}
function callback(stateValue: string): string {
  const token = crypto.randomUUID();
  navigate(`/auth/google#${new URLSearchParams({ state: stateValue, id_token: token })}`);
  return token;
}
function scrubbed(): void {
  expect(window.location.pathname === "/" && window.location.hash === "").toBe(true);
  expect(route().path === "/").toBe(true);
}
function find(root: ConsoleTestNode, check: (node: ConsoleTestNode) => boolean): ConsoleTestNode {
  const node = root.all().find(check);
  if (!node) throw new Error("normal recovery control missing");
  return node;
}
async function waitFor(label: string, check: () => boolean): Promise<void> {
  for (let count = 0; count < 250; count++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`Google callback recovery did not reach ${label}`);
}

beforeEach(() => {
  values.clear();
  assigned.length = 0;
  Object.assign(globalThis, { sessionStorage: storage });
  navigate("/", { replace: true });
});
afterAll(async () => {
  if (state) {
    state.session.set(null);
    state.sessionKind.set(null);
    await tick();
    await tick();
  }
  dom.restore();
});

test("Google callback leaves a noncallback location and pending storage untouched", () => {
  navigate("/billing#local");
  let storageReads = 0;
  Object.assign(globalThis, {
    sessionStorage: {
      getItem(): never {
        storageReads++;
        throw new Error("noncallback storage must not be read");
      },
      removeItem(): never {
        throw new Error("noncallback storage must not be removed");
      },
    },
  });
  expect(google.readGoogleReturn().kind === "none").toBe(true);
  expect(storageReads).toBe(0);
  expect(window.location.pathname === "/billing" && window.location.hash === "#local").toBe(true);
});

test.each([
  "broken-json",
  "null",
  "array",
  "primitive",
  "missing-state",
  "missing-nonce",
  "missing-from",
  "empty-state",
  "empty-nonce",
  "empty-from",
  "wrong-state-type",
  "wrong-nonce-type",
  "wrong-from-type",
])("Google callback refuses %s pending without returning sign-in material", (kind) => {
  const pending = begin();
  const fields: Record<string, unknown> = {
    state: pending.state,
    nonce: pending.nonce,
    from: pending.from,
  };
  if (kind.startsWith("missing-")) delete fields[kind.slice("missing-".length)];
  if (kind.startsWith("empty-")) fields[kind.slice("empty-".length)] = "";
  if (kind.startsWith("wrong-")) fields[kind.slice("wrong-".length, -"-type".length)] = 1;
  values.set(
    pendingKey,
    kind === "broken-json"
      ? "{"
      : kind === "null"
        ? "null"
        : kind === "array"
          ? "[]"
          : kind === "primitive"
            ? "true"
            : JSON.stringify(fields),
  );
  callback(pending.state);
  expect(google.readGoogleReturn().kind === "error").toBe(true);
  expect(values.has(pendingKey)).toBe(false);
  scrubbed();
  expect(google.readGoogleReturn().kind === "none").toBe(true);
});

test.each(["read", "consume"])(
  "Google callback fails closed when pending storage cannot %s",
  (kind) => {
    const pending = begin();
    Object.assign(globalThis, {
      sessionStorage: {
        getItem: (key: string) => {
          if (kind === "read") throw new Error("local storage unavailable");
          return storage.getItem(key);
        },
        removeItem(): never {
          throw new Error("local storage unavailable");
        },
      },
    });
    callback(pending.state);
    expect(google.readGoogleReturn().kind === "error").toBe(true);
    scrubbed();
    expect(google.readGoogleReturn().kind === "none").toBe(true);
  },
);

test("Google callback preserves the original generated state, nonce and one-use return", () => {
  const pending = begin();
  const authorize = new URL(assigned[0] ?? "");
  expect(authorize.origin === "https://accounts.google.com").toBe(true);
  expect(authorize.searchParams.get("state") === pending.state).toBe(true);
  expect(authorize.searchParams.get("nonce") === pending.nonce).toBe(true);
  const token = callback(pending.state);
  const result = google.readGoogleReturn();
  expect(result.kind === "ok").toBe(true);
  if (result.kind !== "ok") throw new Error("original local return was refused");
  expect(result.value.idToken === token).toBe(true);
  expect(result.value.nonce === pending.nonce && result.value.from === "/billing").toBe(true);
  expect(values.has(pendingKey)).toBe(false);
  scrubbed();
  expect(google.readGoogleReturn().kind === "none").toBe(true);

  const next = begin();
  callback(`${next.state}-foreign`);
  expect(google.readGoogleReturn().kind === "error").toBe(true);
  expect(values.has(pendingKey)).toBe(false);
  scrubbed();
});

test("Google callback damaged pending resumes the actual Console sign-in and genuine local Host session", async () => {
  const fixture = await createSignedConsoleHost(dom.origin);
  globalThis.fetch = fixture.transport;
  try {
    state = await import("../console/src/state.ts");
    state.setApiOrigin(fixture.origin);
    values.set(pendingKey, "{");
    const token = callback(crypto.randomUUID());
    // Actual boot invokes readGoogleReturn before its async startup handler.
    // A thrown parser/storage error here would prevent the sign-in UI itself.
    await import("../console/src/main.ts");
    await waitFor("configured sign-in form", () =>
      dom.root.all().some((node) => node.tag === "form"),
    );
    scrubbed();
    expect(values.has(pendingKey)).toBe(false);
    expect(dom.root.textContent.includes(token)).toBe(false);
    expect(fixture.requests.some((request) => request.method !== "GET")).toBe(false);
    expect(fixture.requests.some((request) => request.path === "/auth/oidc/session")).toBe(false);
    const form = find(dom.root, (node) => node.tag === "form");
    find(form, (node) => node.attributes.get("id") === "assertion").value =
      await fixture.assertion("logout-a");
    await form.submit();
    const active = state;
    await waitFor(
      "original signed Host identity",
      () => active.principal()?.id === "logout-a" && active.organizationPageState() === "ready",
    );
    expect(active.currentOrganization()).toBe(null);
    expect(active.session() === "cookie" && fixture.cookiePresent()).toBe(true);
    expect(
      fixture.requests.filter(
        (request) =>
          request.method === "POST" && request.path === "/v1/sessions" && request.status === 200,
      ).length,
    ).toBe(1);
    const picker = find(
      dom.root,
      (node) => node.tag === "select" && node.attributes.get("aria-label") === "Organization",
    );
    expect(picker.children.some((node) => node.value === "org-logout-a")).toBe(true);
    picker.value = "org-logout-a";
    picker.change();
    await tick();
    expect(active.currentOrganization()?.id === "org-logout-a").toBe(true);
  } finally {
    if (state) {
      state.session.set(null);
      state.sessionKind.set(null);
      await tick();
      await tick();
    }
    await waitFor("original Host IO complete", () => fixture.pending() === 0);
    fixture.close();
    globalThis.fetch = dom.originalFetch;
  }
}, 10_000);
