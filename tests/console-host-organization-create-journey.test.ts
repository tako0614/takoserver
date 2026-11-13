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
  throw new Error(`local organization journey did not reach ${label}`);
}
function find(root: ConsoleTestNode, check: (node: ConsoleTestNode) => boolean): ConsoleTestNode {
  const node = root.all().find(check);
  if (!node) throw new Error("actual organization journey control missing");
  return node;
}
function button(root: ConsoleTestNode, label: string): ConsoleTestNode {
  return find(root, (node) => node.tag === "button" && node.textContent === label);
}
function chooseOrg(root: ConsoleTestNode, id: string): void {
  const picker = find(
    root,
    (node) => node.tag === "select" && node.attributes.get("aria-label") === "Organization",
  );
  if (!picker.children.some((node) => node.tag === "option" && node.value === id))
    throw new Error("actual organization option missing");
  picker.value = id;
  picker.change();
}
function createOrg(root: ConsoleTestNode, body: ConsoleTestNode, name: string): void {
  find(root, (node) => node.attributes.get("aria-label") === "Create organization").click();
  const dialog = find(body, (node) => node.attributes.get("role") === "dialog");
  find(dialog, (node) => node.tag === "input").value = name;
  button(dialog, "Create").click();
}

test("actual Console creates a first and paged Organization, then selects only acknowledged authenticated membership", async () => {
  const dom = installConsoleTestDom("https://console.organization-create.test/keys");
  let releaseCreate = (): void => {};
  const createDelivery = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  let holdCreate = false;
  let createHeld = false;
  let state: typeof import("../console/src/state.ts") | undefined;
  let host: Awaited<ReturnType<typeof createSignedConsoleHost>> | undefined;
  const pages: Array<{ bounded: boolean; rows: number; cursor: boolean; next: boolean }> = [];
  try {
    host = await createSignedConsoleHost(dom.origin, {
      beforeDelivery: async (request, response) => {
        const url = new URL(request.url);
        if (url.pathname === "/v1/me" && response.status === 200) {
          const me: unknown = await response.clone().json();
          if (typeof me !== "object" || me === null || !("organizations" in me))
            throw new Error("actual Host membership envelope missing");
          const rows = me.organizations;
          if (!Array.isArray(rows)) throw new Error("actual Host membership rows missing");
          pages.push({
            bounded: url.searchParams.get("organizationPageSize") === "100",
            rows: rows.length,
            cursor: url.searchParams.has("organizationCursor"),
            next: "nextOrganizationCursor" in me && typeof me.nextOrganizationCursor === "string",
          });
        }
        if (holdCreate && request.method === "POST" && url.pathname === "/v1/organizations") {
          holdCreate = false;
          createHeld = true;
          await createDelivery;
        }
      },
    });
    const fixture = host;
    // Only initial fixture rows are seeded. Both Organizations under test must
    // be created by the actual rendered dialog and normal authenticated route.
    await fixture.sql.run("DELETE FROM org_memberships WHERE org_id = ?", ["org-logout-a"]);
    await fixture.sql.run("DELETE FROM orgs WHERE id = ?", ["org-logout-a"]);
    for (let index = 0; index < 100; index++) {
      const id = `org-paged-${String(index).padStart(3, "0")}`;
      await fixture.sql.run(
        "INSERT INTO orgs (id,name,owner_principal_id,created_at) VALUES (?,?,?,?)",
        [id, "Existing local Organization", "logout-b", "2026-11-12T00:00:00.000Z"],
      );
      await fixture.sql.run(
        "INSERT INTO org_memberships (org_id,principal_id,role,created_at) VALUES (?,?,'owner',?)",
        [id, "logout-b", "2026-11-12T00:00:00.000Z"],
      );
    }
    globalThis.fetch = fixture.transport;
    expect((await fixture.initialSignIn("logout-a")).status === 200).toBe(true);
    state = await import("../console/src/state.ts");
    const { setConsoleLocale } = await import("../console/src/i18n.ts");
    setConsoleLocale("en");
    state.setApiOrigin(fixture.origin);
    state.adoptSession();
    await import("../console/src/main.ts");
    const active = state;
    await waitFor(
      "empty authenticated A roster",
      () => active.principal()?.id === "logout-a" && active.organizationPageState() === "ready",
    );
    expect(active.organizations().length).toBe(0);
    expect(active.currentOrganization() === null).toBe(true);
    expect(dom.root.textContent.includes("No organization yet")).toBe(true);
    expect(fixture.requests.filter((request) => request.path.endsWith("/api-keys")).length).toBe(0);
    createOrg(dom.root, dom.body, "First owned Organization");
    await waitFor("first created Organization page", () =>
      dom.root.textContent.includes("No keys"),
    );
    const firstRows = await fixture.sql.query(
      "SELECT o.id FROM orgs o JOIN org_memberships m ON m.org_id=o.id WHERE o.name=? AND o.owner_principal_id=? AND m.principal_id=? AND m.role='owner'",
      ["First owned Organization", "logout-a", "logout-a"],
    );
    const firstId = firstRows[0]?.id;
    if (firstRows.length !== 1 || typeof firstId !== "string")
      throw new Error("normal first Organization owner membership missing");
    expect(active.currentOrganization()?.id === firstId).toBe(true);
    chooseOrg(dom.root, firstId);
    expect(active.currentOrganization()?.id === firstId).toBe(true);
    expect(
      fixture.requests.some(
        (request) =>
          request.path === `/v1/organizations/${firstId}/api-keys` && request.status === 200,
      ),
    ).toBe(true);

    // A normal logout/form sign-in changes only fixture setup for the large
    // roster. This case does not repeat the separate logout/recovery race.
    find(
      dom.root,
      (node) => node.attributes.get("aria-label")?.includes("sign out") === true,
    ).click();
    await waitFor("B sign-in form", () => dom.root.all().some((node) => node.tag === "form"));
    const form = find(dom.root, (node) => node.tag === "form");
    find(form, (node) => node.attributes.get("id") === "assertion").value =
      await fixture.assertion("logout-b");
    await form.submit();
    await waitFor(
      "B bounded first roster page",
      () => active.principal()?.id === "logout-b" && active.organizationPageState() === "ready",
    );
    expect(active.organizations().length).toBe(100);
    expect(active.nextOrganizationCursor() !== null).toBe(true);
    expect(active.currentOrganization() === null).toBe(true);
    holdCreate = true;
    createOrg(dom.root, dom.body, "Created beyond first page");
    await waitFor("normal B create committed before ACK delivery", () => createHeld);
    const secondRows = await fixture.sql.query(
      "SELECT o.id FROM orgs o JOIN org_memberships m ON m.org_id=o.id WHERE o.name=? AND o.owner_principal_id=? AND m.principal_id=? AND m.role='owner'",
      ["Created beyond first page", "logout-b", "logout-b"],
    );
    const secondId = secondRows[0]?.id;
    if (secondRows.length !== 1 || typeof secondId !== "string")
      throw new Error("normal paged Organization owner membership missing");
    // The fixture knowing a persisted ID is not a delivered Console selection.
    expect(active.currentOrganization() === null).toBe(true);
    expect(active.organizations().some((organization) => organization.id === secondId)).toBe(false);
    expect(fixture.requests.some((request) => request.path.includes(secondId))).toBe(false);
    releaseCreate();
    await waitFor(
      "B create ACK and actual key read",
      () =>
        active.currentOrganization()?.id === secondId && dom.root.textContent.includes("No keys"),
    );
    expect(active.organizations().length).toBe(100);
    chooseOrg(dom.root, "org-paged-098");
    await waitFor("explicit existing selection", () => dom.root.textContent.includes("No keys"));
    button(dom.root, "Next organizations").click();
    await waitFor(
      "real cursor page includes created membership",
      () =>
        active.organizationPageCursor() !== undefined && active.organizationPageState() === "ready",
    );
    expect(active.organizations().length).toBe(2);
    expect(active.organizations().some((organization) => organization.id === secondId)).toBe(true);
    const readsBeforeSelection = fixture.requests.filter(
      (request) => request.path === `/v1/organizations/${secondId}/api-keys`,
    ).length;
    chooseOrg(dom.root, secondId);
    await waitFor(
      "explicit cursor selection reaches actual keys",
      () =>
        fixture.requests.filter(
          (request) => request.path === `/v1/organizations/${secondId}/api-keys`,
        ).length > readsBeforeSelection && dom.root.textContent.includes("No keys"),
    );
    expect(active.currentOrganization()?.id === secondId).toBe(true);
    expect(active.nextOrganizationCursor() === null).toBe(true);
    const ownReads = fixture.requests.filter(
      (request) => request.path === `/v1/organizations/${secondId}/api-keys`,
    );
    expect(ownReads.length >= 2 && ownReads.every((request) => request.status === 200)).toBe(true);
    // requireOwner deliberately conceals a foreign Organization as not_found.
    expect(
      (
        await fixture.transport(`${fixture.origin}/v1/organizations/${firstId}/api-keys`, {
          credentials: "include",
        })
      ).status,
    ).toBe(404);
    expect(active.currentOrganization()?.id === secondId).toBe(true);
    expect(pages.length >= 3 && pages.every((page) => page.bounded && page.rows <= 100)).toBe(true);
    expect(pages.some((page) => page.rows === 0 && !page.next)).toBe(true);
    expect(pages.some((page) => page.rows === 100 && page.next)).toBe(true);
    expect(pages.some((page) => page.cursor && page.rows === 2 && !page.next)).toBe(true);
    const creates = fixture.requests.filter(
      (request) => request.method === "POST" && request.path === "/v1/organizations",
    );
    expect(creates.length === 2 && creates.every((request) => request.status === 201)).toBe(true);
    expect(
      fixture.requests.every(
        (request) =>
          request.method === "GET" ||
          (request.method === "POST" &&
            ["/v1/sessions", "/v1/organizations"].includes(request.path)) ||
          (request.method === "DELETE" && request.path === "/v1/session"),
      ),
    ).toBe(true);
  } finally {
    releaseCreate();
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
