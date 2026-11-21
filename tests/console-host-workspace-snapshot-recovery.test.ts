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
  if (!node) throw new Error("actual snapshot recovery control missing");
  return node;
}
function workspaceRefs(root: ConsoleTestNode): string[] {
  return root
    .all()
    .filter((node) => node.tag === "tr" && node.children[0]?.textContent.startsWith("snapshot_ws_"))
    .map((node) => node.children[0]?.textContent ?? "");
}
function heldTotal(root: ConsoleTestNode): string | undefined {
  return root
    .all()
    .find((node) => node.tag === "tr" && node.children[0]?.textContent === "Organization total")
    ?.children.filter((node) => node.tag === "td")[2]?.textContent;
}

test("normal Console Load more replaces its expired Host snapshot without resending wallet holds", async () => {
  const dom = installConsoleTestDom("https://console.snapshot-recovery.test/billing");
  Object.assign(window, { localStorage });
  const config = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "local-snapshot-recovery",
      effectiveAt: "2026-11-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 3600,
      freeIncludedMinor: 20_000,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {},
    }),
  );
  if (!config) throw new Error("original snapshot recovery config missing");
  const start = "2026-11-13T00:00:00.000Z";
  let instant = start;
  const org = "org-logout-a";
  const path = `/v1/organizations/${org}/wallet/usage-summary/workspaces`;
  const snapshots: {
    continued: boolean;
    status: number;
    snapshotAt?: string;
    code?: string;
  }[] = [];
  let state: typeof import("../console/src/state.ts") | undefined;
  let host: Awaited<ReturnType<typeof createSignedConsoleHost>> | undefined;
  let journeyFailed = false;
  let journeyError: unknown;
  const cleanupErrors: unknown[] = [];
  try {
    host = await createSignedConsoleHost(
      dom.origin,
      {
        beforeDelivery: async (request, response) => {
          const url = new URL(request.url);
          if (url.pathname !== path) return;
          // Witness the original Host reply; never replace a snapshot or 409.
          const payload: unknown = await response.clone().json();
          if (payload === null || typeof payload !== "object")
            throw new Error("original snapshot response missing");
          const continued = url.searchParams.has("cursor");
          if (response.status === 200) {
            if (!("snapshotAt" in payload) || typeof payload.snapshotAt !== "string")
              throw new Error("original snapshot timestamp missing");
            snapshots.push({ continued, status: response.status, snapshotAt: payload.snapshotAt });
          } else {
            if (
              !("error" in payload) ||
              payload.error === null ||
              typeof payload.error !== "object" ||
              !("code" in payload.error) ||
              typeof payload.error.code !== "string"
            )
              throw new Error("original snapshot refusal missing");
            snapshots.push({ continued, status: response.status, code: payload.error.code });
          }
        },
      },
      config,
      undefined,
      () => new Date(instant),
    );
    const fixture = host;
    globalThis.fetch = fixture.transport;
    expect((await fixture.initialSignIn("logout-a")).status).toBe(200);
    const refs = Array.from(
      { length: 51 },
      (_, index) => `snapshot_ws_${String(index).padStart(2, "0")}`,
    );
    // The real Host defaults to 50 rows. These original, authorized admissions
    // create the smallest next-page boundary, including their own bindings.
    for (const workspaceRef of refs) {
      const response = await fixture.transport(
        `${fixture.origin}/v1/organizations/${org}/wallet/holds`,
        {
          method: "POST",
          credentials: "include",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            reference: workspaceRef,
            workspaceRef,
            amountMicros: "1000000",
            pricingRevision: config.revision,
            measurementFingerprint: "local-snapshot-estimate",
          }),
        },
      );
      expect(response.status).toBe(201);
    }
    expect(
      await fixture.sql.query(
        "SELECT workspace_ref FROM org_wallet_workspace_bindings WHERE org_id = ?",
        [org],
      ),
    ).toHaveLength(51);

    state = await import("../console/src/state.ts");
    const { setConsoleLocale } = await import("../console/src/i18n.ts");
    setConsoleLocale("en");
    state.setApiOrigin(fixture.origin);
    state.adoptSession();
    await import("../console/src/main.ts");
    const active = state;
    await waitFor(
      "original session membership",
      () => active.principal()?.id === "logout-a" && active.organizationPageState() === "ready",
    );
    expect(active.currentOrganization()).toBe(null);
    const picker = find(
      dom.root,
      (node) => node.tag === "select" && node.attributes.get("aria-label") === "Organization",
    );
    expect(picker.children.some((node) => node.value === org)).toBe(true);
    picker.value = org;
    picker.change();
    await waitFor(
      "original fifty-row snapshot",
      () => workspaceRefs(dom.root).length === 50 && heldTotal(dom.root) === "$51",
    );
    expect(workspaceRefs(dom.root)).toEqual(refs.slice(0, 50));
    expect(snapshots).toEqual([{ continued: false, status: 200, snapshotAt: start }]);
    const loadMore = find(
      dom.root,
      (node) => node.tag === "button" && node.textContent === "Load more",
    );
    // Change the original source through its normal release operation, then
    // advance only the App clock beyond the ten-minute snapshot lifetime.
    expect(
      (
        await fixture.transport(
          `${fixture.origin}/v1/organizations/${org}/wallet/holds/${refs[0]}/release`,
          {
            method: "POST",
            credentials: "include",
          },
        )
      ).status,
    ).toBe(200);
    instant = "2026-11-13T00:10:01.000Z";
    const beforeRecovery = fixture.requests.length;
    loadMore.click();
    await waitFor(
      "normal restarted snapshot",
      () =>
        heldTotal(dom.root) === "$50" &&
        workspaceRefs(dom.root).includes(refs[50] ?? "") &&
        dom.root.textContent.includes("The earlier snapshot expired") &&
        fixture.pending() === 0,
    );
    expect(workspaceRefs(dom.root)).toEqual(refs.slice(1));
    expect(snapshots).toEqual([
      { continued: false, status: 200, snapshotAt: start },
      { continued: true, status: 409, code: "expired" },
      { continued: false, status: 200, snapshotAt: instant },
    ]);
    expect(
      fixture.requests
        .slice(beforeRecovery)
        .map((row) => `${row.method} ${row.path} ${row.status}`),
    ).toEqual([`GET ${path} 409`, `GET ${path} 200`]);
    expect(
      dom.root.all().some((node) => node.tag === "button" && node.textContent === "Load more"),
    ).toBe(false);
    expect(active.principal()?.id).toBe("logout-a");
    expect(active.currentOrganization()?.id).toBe(org);
    const originalHolds = await fixture.sql.query(
      "SELECT state, workspace_ref FROM org_wallet_holds WHERE org_id = ? ORDER BY workspace_ref",
      [org],
    );
    expect(originalHolds).toHaveLength(51);
    expect(originalHolds[0]).toMatchObject({ state: "released", workspace_ref: refs[0] });
    expect(originalHolds.slice(1).every((row) => row.state === "live")).toBe(true);
    expect(
      fixture.requests.filter((row) => row.method === "POST" && row.path.endsWith("/holds")),
    ).toHaveLength(51);
    expect(
      fixture.requests.filter((row) => row.method === "POST" && row.path.endsWith("/release")),
    ).toHaveLength(1);
  } catch (error) {
    journeyFailed = true;
    journeyError = error;
  } finally {
    try {
      try {
        if (state) {
          state.session.set(null);
          state.sessionKind.set(null);
          await tick();
          await tick();
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
      try {
        if (host) {
          await waitFor("original Host IO drained", () => host?.pending() === 0);
          host.close();
        }
      } catch (error) {
        cleanupErrors.push(error);
      }
    } finally {
      try {
        dom.restore();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
  }
  if (cleanupErrors.length > 0)
    throw new AggregateError(
      journeyFailed ? [journeyError, ...cleanupErrors] : cleanupErrors,
      "local snapshot cleanup failed",
    );
  if (journeyFailed) throw journeyError;
}, 10_000);
