import { expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import {
  type ConsoleTestNode,
  createSignedConsoleHost,
  installConsoleTestDom,
} from "./helpers/console-local-host.ts";
import { waitForConsole as waitFor } from "./helpers/console-test-wait.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function find(root: ConsoleTestNode, check: (node: ConsoleTestNode) => boolean): ConsoleTestNode {
  const node = root.all().find(check);
  if (!node) throw new Error("actual wallet journey control missing");
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
    throw new Error("actual wallet Organization option missing");
  picker.value = id;
  picker.change();
}
function followRail(root: ConsoleTestNode, href: string): void {
  const link = find(root, (node) => node.tag === "a" && node.attributes.get("href") === href);
  for (const listener of link.listeners.get("click") ?? [])
    listener({
      target: link,
      button: 0,
      preventDefault() {},
      stopPropagation() {},
    } as unknown as Event);
}

test("actual Host wallet and included usage render original SQL history and retire delayed reads after a real session change", async () => {
  const dom = installConsoleTestDom("https://console.wallet-usage.test/billing");
  // The owned minimal Window shares the same browser storage as the global.
  Object.assign(window, { localStorage });
  const config = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "local-console-usage",
      effectiveAt: "2026-11-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: 2000,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {},
    }),
  );
  if (!config) throw new Error("original local billing config missing");
  let releaseReads = (): void => {};
  const delivery = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  let holdA = false;
  const held = new Set<string>();
  let state: typeof import("../console/src/state.ts") | undefined;
  let host: Awaited<ReturnType<typeof createSignedConsoleHost>> | undefined;
  let cleanupFailure: { error: unknown } | undefined;
  try {
    host = await createSignedConsoleHost(
      dom.origin,
      {
        beforeDelivery: async (request, response) => {
          const path = new URL(request.url).pathname;
          if (holdA && path.startsWith("/v1/organizations/org-logout-a/wallet")) {
            if (response.status !== 200)
              throw new Error("original delayed wallet read did not succeed");
            held.add(path);
            await delivery;
          }
        },
      },
      config,
    );
    const fixture = host;
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
      "actual A membership",
      () => active.principal()?.id === "logout-a" && active.organizationPageState() === "ready",
    );
    expect(active.currentOrganization() === null).toBe(true);
    expect(fixture.requests.some((request) => request.path.includes("/wallet"))).toBe(false);
    chooseOrg(dom.root, "org-logout-a");
    await waitFor(
      "original configured wallet and usage",
      () =>
        statValue(dom.root, "Available") === "$20" &&
        statValue(dom.root, "Included usage") === "0%" &&
        dom.root.textContent.includes("Organization total"),
    );
    expect(statValue(dom.root, "Current credit") === "$20").toBe(true);
    expect(statValue(dom.root, "Held") === "$0").toBe(true);
    expect(statValue(dom.root, "Frozen") === "$0").toBe(true);
    expect(statValue(dom.root, "Refund receivable") === "$0").toBe(true);
    const originalGrants = await fixture.sql.query(
      "SELECT amount_micros FROM org_wallet_grant_snapshots WHERE org_id=?",
      ["org-logout-a"],
    );
    expect(originalGrants.length === 1 && originalGrants[0]?.amount_micros === 20_000_000).toBe(
      true,
    );
    // Disposable persisted usage history, not a successful wire DTO or a call
    // to a funding/payment/usage mutation endpoint. The original engines must
    // derive the wallet, allowance and unattributed totals from these rows.
    await fixture.sql.batch([
      {
        sql: "INSERT INTO ledger (id,org_id,type,ref,settled_delta_micros,held_delta_micros,created_at) VALUES (?,?,'usage_debit',?,-5000000,0,?)",
        params: [
          "local-wallet-history",
          "org-logout-a",
          "local-usage-history",
          "2026-11-13T00:00:00.000Z",
        ],
      },
      {
        sql: "INSERT INTO wallet_credit_allocations (org_id,debit_type,debit_ref,lot_ref,amount_micros,created_at) VALUES (?,'usage_debit',?,?,5000000,?)",
        params: [
          "org-logout-a",
          "local-usage-history",
          "free:org-logout-a:2026-11",
          "2026-11-13T00:00:00.000Z",
        ],
      },
    ]);
    followRail(dom.root, "/keys");
    await waitFor("keys route", () => dom.root.textContent.includes("No keys"));
    followRail(dom.root, "/billing");
    await waitFor(
      "original positive usage history displayed",
      () =>
        statValue(dom.root, "Available") === "$15" &&
        statValue(dom.root, "Included usage") === "25%" &&
        dom.root
          .all()
          .some(
            (node) =>
              node.tag === "tr" &&
              node.textContent.includes("Unattributed") &&
              node.textContent.includes("$5"),
          ),
    );
    expect(statValue(dom.root, "Current credit") === "$15").toBe(true);
    expect(workspaceUsed(dom.root, "Organization total") === "$5").toBe(true);
    expect(workspaceUsed(dom.root, "Unattributed") === "$5").toBe(true);
    expect(
      dom.root
        .all()
        .some(
          (node) =>
            node.tag === "tr" &&
            node.textContent.includes("Organization total") &&
            node.textContent.includes("$5"),
        ),
    ).toBe(true);
    const oldRefresh = find(
      dom.root,
      (node) => node.tag === "button" && node.textContent === "Refresh",
    );
    const aUsage = fixture.requests.filter(
      (request) => request.path === "/v1/organizations/org-logout-a/wallet/usage-summary",
    );
    expect(aUsage.length > 0 && aUsage.every((request) => request.status === 200)).toBe(true);
    holdA = true;
    followRail(dom.root, "/keys");
    await waitFor("keys before delayed reads", () => dom.root.textContent.includes("No keys"));
    followRail(dom.root, "/billing");
    await waitFor("original A wallet/summary/workspace responses held", () => held.size === 3);
    find(
      dom.root,
      (node) => node.attributes.get("aria-label")?.includes("sign out") === true,
    ).click();
    await waitFor("real B sign-in form", () => dom.root.all().some((node) => node.tag === "form"));
    const form = find(dom.root, (node) => node.tag === "form");
    find(form, (node) => node.attributes.get("id") === "assertion").value =
      await fixture.assertion("logout-b");
    await form.submit();
    await waitFor(
      "actual B membership",
      () => active.principal()?.id === "logout-b" && active.organizationPageState() === "ready",
    );
    expect(active.currentOrganization() === null).toBe(true);
    chooseOrg(dom.root, "org-logout-b");
    await waitFor(
      "B wallet and usage before A delivery",
      () =>
        statValue(dom.root, "Available") === "$20" &&
        statValue(dom.root, "Included usage") === "0%" &&
        dom.root.textContent.includes("Organization total"),
    );
    expect(workspaceUsed(dom.root, "Organization total") === "—").toBe(true);
    expect(workspaceUsed(dom.root, "Unattributed") === "—").toBe(true);
    releaseReads();
    await waitFor("late A reads settled", () => fixture.pending() === 0);
    await tick();
    expect(
      active.principal()?.id === "logout-b" && active.currentOrganization()?.id === "org-logout-b",
    ).toBe(true);
    expect(statValue(dom.root, "Available") === "$20").toBe(true);
    expect(statValue(dom.root, "Included usage") === "0%").toBe(true);
    expect(workspaceUsed(dom.root, "Organization total") === "—").toBe(true);
    expect(workspaceUsed(dom.root, "Unattributed") === "—").toBe(true);
    expect(
      !dom.root.textContent.includes("25%") &&
        !dom.root.textContent.includes("$15") &&
        !dom.root.textContent.includes("local-usage-history"),
    ).toBe(true);
    const oldCount = fixture.requests.length;
    oldRefresh.click();
    await tick();
    await tick();
    expect(fixture.requests.length).toBe(oldCount);
    const bWorkspacePath = "/v1/organizations/org-logout-b/wallet/usage-summary/workspaces";
    const countBeforeRefresh = fixture.requests.filter(
      (request) => request.path === bWorkspacePath,
    ).length;
    find(dom.root, (node) => node.tag === "button" && node.textContent === "Refresh").click();
    await waitFor(
      "current B workspace refresh",
      () =>
        fixture.requests.filter((request) => request.path === bWorkspacePath).length >
          countBeforeRefresh && fixture.pending() === 0,
    );
    expect(
      fixture.requests
        .filter((request) => request.path === bWorkspacePath)
        .every((request) => request.status === 200),
    ).toBe(true);
    holdA = false;
    for (const suffix of ["wallet", "wallet/usage-summary"]) {
      const response = await fixture.transport(
        `${fixture.origin}/v1/organizations/org-logout-a/${suffix}`,
        { credentials: "include" },
      );
      expect(response.status).toBe(404);
    }
    expect(active.currentOrganization()?.id === "org-logout-b").toBe(true);
    expect(statValue(dom.root, "Included usage") === "0%").toBe(true);
    expect(
      fixture.requests.every(
        (request) =>
          request.method === "GET" ||
          (request.method === "POST" && request.path === "/v1/sessions") ||
          (request.method === "DELETE" && request.path === "/v1/session"),
      ),
    ).toBe(true);
    const localUsage = await fixture.sql.query(
      "SELECT settled_delta_micros FROM ledger WHERE type='usage_debit'",
    );
    expect(localUsage.length === 1 && localUsage[0]?.settled_delta_micros === -5_000_000).toBe(
      true,
    );
  } finally {
    try {
      try {
        holdA = false;
        releaseReads();
        if (state) {
          state.session.set(null);
          state.sessionKind.set(null);
        }
        await tick();
        await tick();
        if (host) await waitFor("original Host IO drained", () => host?.pending() === 0);
      } finally {
        globalThis.fetch = dom.originalFetch;
        try {
          host?.close();
        } finally {
          dom.restore();
        }
      }
    } catch (error) {
      cleanupFailure = { error };
    }
  }
  if (cleanupFailure) throw cleanupFailure.error;
}, 10_000);
