import { expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import { createOpenAiGateway, parseOpenAiModelConfig } from "../src/providers/openai.ts";
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
  throw new Error(`local measured journey did not reach ${label}`);
}
function find(root: ConsoleTestNode, check: (node: ConsoleTestNode) => boolean): ConsoleTestNode {
  const node = root.all().find(check);
  if (!node) throw new Error("actual measured journey control missing");
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
    throw new Error("actual measured Organization option missing");
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

test("an original measured AI operation settles once, rolls up without a second charge, and reaches its own Console wallet and usage", async () => {
  const dom = installConsoleTestDom("https://console.measured-usage.test/billing");
  Object.assign(window, { localStorage });
  const billing = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "local-measured-usage",
      effectiveAt: "2026-11-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: 2000,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {},
    }),
  );
  if (!billing) throw new Error("original measured billing config missing");
  let upstreamAuthorization = `Bearer ${crypto.randomUUID()}`;
  const idempotencyKey = crypto.randomUUID();
  let upstreamCalls = 0;
  const gateway = createOpenAiGateway({
    baseUrl: "https://owned-upstream.example.test/v1",
    models: parseOpenAiModelConfig(
      JSON.stringify([
        {
          id: "local-measured-model",
          upstreamId: "local-upstream-model",
          created: 1_794_528_000,
          ownedBy: "synthetic-local",
          maxInputTokens: 5,
          maxOutputTokens: 5,
          inputMinorPerMillionTokens: 100_000_000,
          outputMinorPerMillionTokens: 100_000_000,
        },
      ]),
    ),
    authorize: () => upstreamAuthorization,
    // Only raw provider IO is synthetic. The existing gateway and Host parse,
    // price, reserve, settle and record this untrusted measurement themselves.
    fetch: async (request) => {
      const url = new URL(request.url);
      const body: unknown = await request.json();
      if (
        url.origin !== "https://owned-upstream.example.test" ||
        url.pathname !== "/v1/chat/completions" ||
        request.method !== "POST" ||
        request.headers.get("authorization") !== upstreamAuthorization ||
        request.headers.get("idempotency-key") !== idempotencyKey ||
        typeof body !== "object" ||
        body === null ||
        !("model" in body) ||
        body.model !== "local-upstream-model"
      )
        throw new Error("owned raw provider request contract mismatch");
      upstreamCalls++;
      return Response.json({
        id: "owned-local-completion",
        object: "chat.completion",
        created: 1_794_528_000,
        model: "local-upstream-model",
        choices: [
          {
            index: 0,
            message: { role: "assistant", content: "local result" },
            finish_reason: "stop",
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 },
      });
    },
  });
  let state: typeof import("../console/src/state.ts") | undefined;
  let host: Awaited<ReturnType<typeof createSignedConsoleHost>> | undefined;
  let apiSecret = "";
  try {
    host = await createSignedConsoleHost(dom.origin, {}, billing, gateway);
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
      "A authenticated roster",
      () => active.principal()?.id === "logout-a" && active.organizationPageState() === "ready",
    );
    chooseOrg(dom.root, "org-logout-a");
    await waitFor(
      "engine-prepared free precondition",
      () =>
        statValue(dom.root, "Available") === "$20" &&
        statValue(dom.root, "Included usage") === "0%" &&
        workspaceUsed(dom.root, "Organization total") === "—",
    );
    expect((await fixture.sql.query("SELECT COUNT(*) AS n FROM usage_events"))[0]?.n === 0).toBe(
      true,
    );
    expect(
      (
        await fixture.sql.query(
          "SELECT COUNT(*) AS n FROM ledger WHERE type IN ('capture','usage_debit')",
        )
      )[0]?.n === 0,
    ).toBe(true);
    const requestBody = JSON.stringify({
      model: "local-measured-model",
      messages: [{ role: "user", content: "owned local invocation" }],
      max_tokens: 5,
      stream: false,
    });
    const invoke = (authorized: boolean) =>
      fixture.transport(`${fixture.origin}/v1/ai/chat/completions`, {
        method: "POST",
        credentials: "include",
        headers: {
          "content-type": "application/json",
          "idempotency-key": idempotencyKey,
          ...(authorized ? { authorization: `Bearer ${apiSecret}` } : {}),
        },
        body: requestBody,
      });
    // A browser owner cookie alone is not the data plane's ai:invoke key.
    expect((await invoke(false)).status).toBe(401);
    expect(upstreamCalls).toBe(0);
    expect((await fixture.sql.query("SELECT COUNT(*) AS n FROM usage_events"))[0]?.n === 0).toBe(
      true,
    );
    const key = await active.api.createApiKey("org-logout-a", {
      name: "owned measured invocation",
      scopes: ["ai:invoke"],
      expiresInSeconds: 3600,
    });
    apiSecret = key.secret;
    expect(typeof apiSecret === "string" && apiSecret.length > 0).toBe(true);
    const first = await invoke(true);
    expect(first.status).toBe(200);
    expect(first.headers.get("x-takoserver-billed-micros") === "5000000").toBe(true);
    const originalRequestId = first.headers.get("x-request-id");
    expect(typeof originalRequestId === "string" && originalRequestId.length > 0).toBe(true);
    const replay = await invoke(true);
    expect(replay.status).toBe(200);
    expect(
      replay.headers.get("x-request-id") === originalRequestId &&
        replay.headers.get("x-takoserver-billed-micros") === "5000000",
    ).toBe(true);
    expect(upstreamCalls).toBe(1);
    const measured = await fixture.sql.query(
      "SELECT org_id,quantity,amount_micros,rollup_id FROM usage_events",
    );
    expect(
      measured.length === 1 &&
        measured[0]?.org_id === "org-logout-a" &&
        measured[0]?.quantity === 5 &&
        measured[0]?.amount_micros === 0 &&
        measured[0]?.rollup_id === null,
    ).toBe(true);
    const captureBefore = await fixture.sql.query(
      "SELECT org_id,settled_delta_micros FROM ledger WHERE type='capture'",
    );
    expect(
      captureBefore.length === 1 &&
        captureBefore[0]?.org_id === "org-logout-a" &&
        captureBefore[0]?.settled_delta_micros === -5_000_000,
    ).toBe(true);
    // AI has already settled its token charge. Its original zero-cost meter
    // event must still be claimed by App.tick without billing it a second time.
    expect((await fixture.tick()).meteredRows).toBe(1);
    const rolled = await fixture.sql.query("SELECT org_id,rollup_id FROM usage_events");
    expect(
      rolled.length === 1 &&
        rolled[0]?.org_id === "org-logout-a" &&
        typeof rolled[0]?.rollup_id === "string",
    ).toBe(true);
    expect((await fixture.tick()).meteredRows).toBe(0);
    expect(
      (await fixture.sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type='usage_debit'"))[0]
        ?.n === 0,
    ).toBe(true);
    expect(
      (await fixture.sql.query("SELECT COUNT(*) AS n FROM ledger WHERE type='capture'"))[0]?.n ===
        1,
    ).toBe(true);
    followRail(dom.root, "/keys");
    await waitFor("keys before usage read", () =>
      dom.root.textContent.includes("owned measured invocation"),
    );
    followRail(dom.root, "/billing");
    await waitFor(
      "measured results in original Console",
      () =>
        statValue(dom.root, "Available") === "$15" &&
        statValue(dom.root, "Included usage") === "25%" &&
        workspaceUsed(dom.root, "Organization total") === "$5" &&
        workspaceUsed(dom.root, "Unattributed") === "$5",
    );
    expect(statValue(dom.root, "Current credit") === "$15").toBe(true);
    expect(statValue(dom.root, "Held") === "$0").toBe(true);
    expect(
      workspaceUsed(dom.root, "Organization total") === "$5" &&
        workspaceUsed(dom.root, "Unattributed") === "$5",
    ).toBe(true);
    find(
      dom.root,
      (node) => node.attributes.get("aria-label")?.includes("sign out") === true,
    ).click();
    await waitFor("B normal sign-in", () => dom.root.all().some((node) => node.tag === "form"));
    const form = find(dom.root, (node) => node.tag === "form");
    find(form, (node) => node.attributes.get("id") === "assertion").value =
      await fixture.assertion("logout-b");
    await form.submit();
    await waitFor(
      "B authenticated roster",
      () => active.principal()?.id === "logout-b" && active.organizationPageState() === "ready",
    );
    chooseOrg(dom.root, "org-logout-b");
    await waitFor(
      "unrelated Org remains uncharged",
      () =>
        statValue(dom.root, "Available") === "$20" &&
        statValue(dom.root, "Included usage") === "0%" &&
        workspaceUsed(dom.root, "Organization total") === "—",
    );
    expect(workspaceUsed(dom.root, "Unattributed") === "—").toBe(true);
    expect(
      (
        await fixture.sql.query("SELECT COUNT(*) AS n FROM usage_events WHERE org_id=?", [
          "org-logout-b",
        ])
      )[0]?.n === 0,
    ).toBe(true);
    expect(
      (
        await fixture.sql.query(
          "SELECT COUNT(*) AS n FROM ledger WHERE org_id=? AND type IN ('capture','usage_debit')",
          ["org-logout-b"],
        )
      )[0]?.n === 0,
    ).toBe(true);
    expect(
      (
        await fixture.transport(
          `${fixture.origin}/v1/organizations/org-logout-a/wallet/usage-summary`,
          { credentials: "include" },
        )
      ).status,
    ).toBe(404);
    expect(active.currentOrganization()?.id === "org-logout-b").toBe(true);
    expect(upstreamCalls).toBe(1);
    expect(
      fixture.requests.every(
        (request) =>
          request.method === "GET" ||
          (request.method === "POST" &&
            [
              "/v1/sessions",
              "/v1/ai/chat/completions",
              "/v1/organizations/org-logout-a/api-keys",
            ].includes(request.path)) ||
          (request.method === "DELETE" && request.path === "/v1/session"),
      ),
    ).toBe(true);
  } finally {
    apiSecret = "";
    upstreamAuthorization = "";
    if (state) {
      state.session.set(null);
      state.sessionKind.set(null);
    }
    await tick();
    await tick();
    for (let count = 0; count < 250 && host && host.pending() > 0; count++) await tick();
    globalThis.fetch = dom.originalFetch;
    host?.close();
    dom.restore();
  }
}, 10_000);
