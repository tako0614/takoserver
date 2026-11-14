import { expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import {
  type ConsoleTestNode,
  createSignedConsoleHost,
  installConsoleTestDom,
} from "./helpers/console-local-host.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitFor(label: string, check: () => boolean): Promise<void> {
  for (let count = 0; count < 250; count++) {
    if (check()) return;
    await tick();
  }
  throw new Error(`local billing refresh did not reach ${label}`);
}
function find(root: ConsoleTestNode, check: (node: ConsoleTestNode) => boolean): ConsoleTestNode {
  const node = root.all().find(check);
  if (!node) throw new Error("actual billing refresh control missing");
  return node;
}
function statValue(root: ConsoleTestNode, label: string): string | undefined {
  return root
    .all()
    .find((node) => node.className === "stat__label" && node.textContent === label)
    ?.parent?.all()
    .find((node) => node.className === "stat__value")?.textContent;
}
function workspaceUsed(root: ConsoleTestNode, label: string): string | undefined {
  return root
    .all()
    .find((node) => node.tag === "tr" && node.children[0]?.textContent === label)
    ?.children.filter((node) => node.tag === "td")[1]?.textContent;
}
function chooseOrg(root: ConsoleTestNode, id: string): void {
  const picker = find(
    root,
    (node) => node.tag === "select" && node.attributes.get("aria-label") === "Organization",
  );
  if (!picker.children.some((node) => node.tag === "option" && node.value === id))
    throw new Error("actual billing Organization option missing");
  picker.value = id;
  picker.change();
}
const refresh = (root: ConsoleTestNode) =>
  find(root, (node) => node.tag === "button" && node.textContent === "Refresh balance and usage");

test("ordinary billing refresh reads current Host balances and usage without navigation and retires with its session", async () => {
  const dom = installConsoleTestDom("https://console.billing-refresh.test/billing");
  Object.assign(window, { localStorage });
  const config = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "local-billing-refresh",
      effectiveAt: "2026-11-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: 2000,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {},
    }),
  );
  if (!config) throw new Error("original billing refresh config missing");
  let releaseReads = (): void => {};
  const delivery = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  let holdA = false;
  const held = new Set<string>();
  let state: typeof import("../console/src/state.ts") | undefined;
  let host: Awaited<ReturnType<typeof createSignedConsoleHost>> | undefined;
  try {
    host = await createSignedConsoleHost(
      dom.origin,
      {
        beforeDelivery: async (request, response) => {
          const path = new URL(request.url).pathname;
          if (holdA && path.startsWith("/v1/organizations/org-logout-a/wallet")) {
            if (response.status !== 200)
              throw new Error("original delayed billing response did not succeed");
            held.add(path);
            await delivery;
          }
        },
      },
      config,
    );
    const fixture = host;
    globalThis.fetch = fixture.transport;
    expect((await fixture.initialSignIn("logout-a")).status).toBe(200);
    state = await import("../console/src/state.ts");
    const { setConsoleLocale } = await import("../console/src/i18n.ts");
    setConsoleLocale("en");
    state.setApiOrigin(fixture.origin);
    state.adoptSession();
    await import("../console/src/main.ts");
    const active = state;
    await waitFor(
      "A membership",
      () => active.principal()?.id === "logout-a" && active.organizationPageState() === "ready",
    );
    expect(active.currentOrganization()).toBe(null);
    expect(dom.root.all().some((node) => node.textContent === "Refresh balance and usage")).toBe(
      false,
    );
    chooseOrg(dom.root, "org-logout-a");
    await waitFor(
      "A original wallet and usage",
      () =>
        statValue(dom.root, "Available") === "$20" &&
        statValue(dom.root, "Included usage") === "0%" &&
        workspaceUsed(dom.root, "Organization total") === "—",
    );
    const originalRefresh = refresh(dom.root);
    // Disposable persisted history, as in the original wallet journey. The
    // actual Ledger/usage engines derive every response; no payment is sent.
    await fixture.sql.batch([
      {
        sql: "INSERT INTO ledger (id,org_id,type,ref,settled_delta_micros,held_delta_micros,created_at) VALUES (?,?,'usage_debit',?,-5000000,0,?)",
        params: [
          "local-refresh-history",
          "org-logout-a",
          "local-refresh-usage",
          "2026-11-13T00:00:00.000Z",
        ],
      },
      {
        sql: "INSERT INTO wallet_credit_allocations (org_id,debit_type,debit_ref,lot_ref,amount_micros,created_at) VALUES (?,'usage_debit',?,?,5000000,?)",
        params: [
          "org-logout-a",
          "local-refresh-usage",
          "free:org-logout-a:2026-11",
          "2026-11-13T00:00:00.000Z",
        ],
      },
    ]);
    const readsAfter = (start: number) =>
      fixture.requests.slice(start).filter((request) => request.path.includes("/wallet"));
    const beforeRefresh = fixture.requests.length;
    originalRefresh.click();
    await waitFor(
      "in-place updated balance and all usage views",
      () =>
        statValue(dom.root, "Available") === "$15" &&
        statValue(dom.root, "Included usage") === "25%" &&
        workspaceUsed(dom.root, "Organization total") === "$5" &&
        workspaceUsed(dom.root, "Unattributed") === "$5",
    );
    expect(window.location.pathname).toBe("/billing");
    expect(active.principal()?.id).toBe("logout-a");
    expect(active.currentOrganization()?.id).toBe("org-logout-a");
    expect(
      readsAfter(beforeRefresh)
        .map((request) => `${request.method} ${request.path} ${request.status}`)
        .sort(),
    ).toEqual([
      "GET /v1/organizations/org-logout-a/wallet 200",
      "GET /v1/organizations/org-logout-a/wallet/usage-summary 200",
      "GET /v1/organizations/org-logout-a/wallet/usage-summary/workspaces 200",
    ]);

    holdA = true;
    originalRefresh.click();
    await waitFor("three actual A refresh responses held", () => held.size === 3);
    find(
      dom.root,
      (node) => node.attributes.get("aria-label")?.includes("sign out") === true,
    ).click();
    await waitFor("normal sign-in form", () => dom.root.all().some((node) => node.tag === "form"));
    const form = find(dom.root, (node) => node.tag === "form");
    find(form, (node) => node.attributes.get("id") === "assertion").value =
      await fixture.assertion("logout-b");
    await form.submit();
    await waitFor(
      "B actual membership",
      () => active.principal()?.id === "logout-b" && active.organizationPageState() === "ready",
    );
    expect(active.currentOrganization()).toBe(null);
    chooseOrg(dom.root, "org-logout-b");
    await waitFor(
      "B wallet and usage",
      () =>
        statValue(dom.root, "Available") === "$20" &&
        statValue(dom.root, "Included usage") === "0%" &&
        workspaceUsed(dom.root, "Organization total") === "—",
    );
    const beforeRetired = fixture.requests.length;
    originalRefresh.click();
    await tick();
    expect(fixture.requests.length).toBe(beforeRetired);
    releaseReads();
    await waitFor("late A delivery complete", () => fixture.pending() === 0);
    await tick();
    expect(statValue(dom.root, "Available")).toBe("$20");
    expect(statValue(dom.root, "Included usage")).toBe("0%");
    expect(workspaceUsed(dom.root, "Organization total")).toBe("—");
    expect(workspaceUsed(dom.root, "Unattributed")).toBe("—");
    expect(active.principal()?.id).toBe("logout-b");
    expect(active.currentOrganization()?.id).toBe("org-logout-b");
    expect(fixture.requests.length).toBe(beforeRetired);
    refresh(dom.root).click();
    await waitFor(
      "B explicit refresh complete",
      () => readsAfter(beforeRetired).length === 3 && fixture.pending() === 0,
    );
    expect(
      readsAfter(beforeRetired).every(
        (request) =>
          request.path.startsWith("/v1/organizations/org-logout-b/wallet") &&
          request.status === 200,
      ),
    ).toBe(true);
    expect(
      fixture.requests.every(
        (request) =>
          request.method === "GET" ||
          (request.method === "POST" && request.path === "/v1/sessions") ||
          (request.method === "DELETE" && request.path === "/v1/session"),
      ),
    ).toBe(true);
  } finally {
    releaseReads();
    if (state) {
      state.session.set(null);
      state.sessionKind.set(null);
      await tick();
      await tick();
    }
    if (host) {
      await waitFor("original Host IO drained", () => host?.pending() === 0);
      host.close();
    }
    dom.restore();
  }
}, 10_000);
