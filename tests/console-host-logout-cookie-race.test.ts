import { expect, test } from "bun:test";
import {
  type ConsoleTestNode,
  createSignedConsoleHost,
  installConsoleTestDom,
} from "./helpers/console-local-host.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitFor(label: string, check: () => boolean): Promise<void> {
  for (let count = 0; count < 200; count++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`local logout journey did not reach ${label}`);
}
function gate() {
  let release = (): void => {
    throw new Error("local IO gate not initialized");
  };
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}
function button(root: ConsoleTestNode, label: string): ConsoleTestNode {
  const found = root.all().find((node) => node.tag === "button" && node.textContent === label);
  if (!found) throw new Error("local logout control missing");
  return found;
}
function loginForm(root: ConsoleTestNode): ConsoleTestNode | undefined {
  return root
    .all()
    .find(
      (node) =>
        node.tag === "form" &&
        node.all().some((child) => child.attributes.get("id") === "assertion"),
    );
}
function chooseOrg(root: ConsoleTestNode, id: string): void {
  const picker = root
    .all()
    .find((node) => node.tag === "select" && node.attributes.get("aria-label") === "Organization");
  if (!picker) throw new Error("actual organization picker missing");
  picker.value = id;
  picker.change();
}

test("actual UI logout delivers cookie expiry before a replacement signed login can remain active", async () => {
  const dom = installConsoleTestDom("https://console.logout-cookie.test/keys");
  const read = gate();
  const logout = gate();
  let pauseRead = false;
  let readWaiting = false;
  let logoutWaiting = false;
  let state: typeof import("../console/src/state.ts") | undefined;
  let host: Awaited<ReturnType<typeof createSignedConsoleHost>> | undefined;
  try {
    host = await createSignedConsoleHost(dom.origin, {
      beforeHost: async (request) => {
        if (
          pauseRead &&
          new URL(request.url).pathname === "/v1/organizations/org-logout-a/api-keys"
        ) {
          pauseRead = false;
          readWaiting = true;
          await read.promise;
        }
      },
      beforeDelivery: async (request) => {
        if (request.method === "DELETE" && new URL(request.url).pathname === "/v1/session") {
          logoutWaiting = true;
          await logout.promise;
        }
      },
    });
    globalThis.fetch = host.transport;
    expect((await host.initialSignIn("logout-a")).status).toBe(200);
    state = await import("../console/src/state.ts");
    const { setConsoleLocale } = await import("../console/src/i18n.ts");
    setConsoleLocale("en");
    state.setApiOrigin(host.origin);
    state.adoptSession();
    await import("../console/src/main.ts");
    const active = state;
    const fixture = host;
    await waitFor(
      "initial A identity",
      () => active.principal()?.id === "logout-a" && active.organizationPageState() === "ready",
    );
    chooseOrg(dom.root, "org-logout-a");
    await waitFor("initial key page", () => dom.root.textContent.includes("No keys"));
    // A real UI read leaves the browser before logout, but reaches the actual
    // Host after its durable revoke. Its actual401 exposes the competing login.
    pauseRead = true;
    button(dom.root, "Refresh keys").click();
    await waitFor("key read delayed before Host", () => readWaiting);
    const signOut = dom.root
      .all()
      .find(
        (node) => node.tag === "button" && node.attributes.get("aria-label")?.includes("sign out"),
      );
    if (!signOut) throw new Error("actual logout button missing");
    signOut.click();
    await waitFor("actual logout response held before cookie delivery", () => logoutWaiting);
    const logoutResponse = fixture.requests.find(
      (request) => request.method === "DELETE" && request.path === "/v1/session",
    );
    expect(logoutResponse?.status === 204 && logoutResponse.clearsSessionCookie).toBe(true);
    expect(fixture.cookiePresent()).toBe(true);
    read.release();
    await waitFor("current revoked-session read clears selection", () => active.session() === null);
    expect(active.currentOrganizationId() === null).toBe(true);
    await waitFor(
      "login or explicit pending logout",
      () =>
        loginForm(dom.root) !== undefined ||
        dom.root
          .all()
          .some(
            (node) =>
              node.attributes.get("role") === "status" && node.textContent === "Signing out…",
          ),
    );
    let form = loginForm(dom.root);
    // The original implementation accepts B before delivering A's clear-cookie.
    // A serialization fence may instead withhold this form until A completes.
    if (!form) {
      expect(dom.root.textContent.includes("Signing out…")).toBe(true);
      logout.release();
      await waitFor(
        "logout finished and sign-in is usable",
        () => loginForm(dom.root) !== undefined,
      );
      form = loginForm(dom.root);
    }
    const assertion = form?.all().find((node) => node.attributes.get("id") === "assertion");
    if (!form || !assertion) throw new Error("actual replacement sign-in form missing");
    assertion.value = await fixture.assertion("logout-b");
    await form.submit();
    await waitFor(
      "genuine replacement B session",
      () => active.principal()?.id === "logout-b" && active.organizationPageState() === "ready",
    );
    expect(fixture.cookiePresent()).toBe(true);
    logout.release();
    await waitFor("old logout cookie applied", () => logoutResponse?.deliveredAt !== undefined);
    await tick();
    await tick();
    // Assert only safe booleans: no token/header/credential body may enter logs.
    expect(fixture.cookiePresent()).toBe(true);
    expect(active.principal()?.id === "logout-b").toBe(true);
    expect(active.session() === "cookie").toBe(true);
    const signIns = fixture.requests.filter(
      (request) =>
        request.method === "POST" && request.path === "/v1/sessions" && request.status === 200,
    );
    const replacement = signIns[1];
    expect(signIns.length).toBe(2);
    expect(
      typeof logoutResponse?.deliveredAt === "number" &&
        typeof replacement?.deliveredAt === "number" &&
        logoutResponse.deliveredAt < replacement.deliveredAt,
    ).toBe(true);
    expect(active.currentOrganization() === null).toBe(true);
    chooseOrg(dom.root, "org-logout-b");
    await waitFor("replacement key page still works", () =>
      dom.root.textContent.includes("No keys"),
    );
    expect(active.currentOrganization()?.id === "org-logout-b").toBe(true);
    const replacementReads = fixture.requests.filter(
      (request) => request.path === "/v1/organizations/org-logout-b/api-keys",
    );
    expect(
      replacementReads.length > 0 && replacementReads.every((request) => request.status === 200),
    ).toBe(true);
    const rows = await fixture.sql.query("SELECT revoked_at FROM auth_tokens WHERE kind='session'");
    expect(rows.length).toBe(2);
    expect(rows.filter((row) => row.revoked_at !== null).length).toBe(1);
    expect(rows.filter((row) => row.revoked_at === null).length).toBe(1);
    expect(fixture.requests.filter((request) => request.method === "DELETE").length).toBe(1);
    expect(
      fixture.requests.every(
        (request) =>
          request.method === "GET" ||
          (request.method === "POST" && request.path === "/v1/sessions") ||
          (request.method === "DELETE" && request.path === "/v1/session"),
      ),
    ).toBe(true);
  } finally {
    read.release();
    logout.release();
    if (state) {
      state.session.set(null);
      state.sessionKind.set(null);
    }
    await tick();
    await tick();
    for (let count = 0; count < 200 && host && host.pending() > 0; count++) await tick();
    globalThis.fetch = dom.originalFetch;
    host?.close();
    dom.restore();
  }
}, 10_000);
