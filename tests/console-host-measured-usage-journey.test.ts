import { expect, test } from "bun:test";
import { parseBillingConfig } from "../src/billing-config.ts";
import type { Offering } from "../src/catalog.ts";
import { createProviderPack } from "../src/provider-pack.ts";
import { FakeProvider } from "../src/providers/fake.ts";
import { createOpenAiGateway, parseOpenAiModelConfig } from "../src/providers/openai.ts";
import { createResourceDeploymentStore } from "../src/resource-deployments.ts";
import {
  ConsoleTestNode,
  createSignedConsoleHost,
  installConsoleTestDom,
} from "./helpers/console-local-host.ts";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
async function waitFor(label: string, check: () => boolean): Promise<void> {
  const deadline = performance.now() + 3_000;
  while (!check()) {
    if (performance.now() >= deadline)
      throw new Error(`local measured journey did not reach ${label}`);
    await Bun.sleep(10);
  }
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

test("a priced provider window survives checkpoint retry without a second charge and reaches only its own Console", async () => {
  const billing = parseBillingConfig(
    JSON.stringify({
      schemaVersion: 1,
      revision: "local-provider-window",
      effectiveAt: "2026-11-01T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 60,
      freeIncludedMinor: 2000,
      purchaseCreditExpiry: { kind: "none" },
      plans: {},
      meters: {},
    }),
  );
  if (!billing) throw new Error("local provider-window billing config missing");
  const ownerOrg = "org-logout-a";
  const providerId = "local-metered-provider";
  const deploymentId = "dep_local_metered_provider";
  const resourceUid = "uid_local_metered_provider";
  const meter = "compute.requests";
  const from = "2026-11-12T00:00:00.000Z";
  const until = "2026-11-13T00:00:00.000Z";
  let now = new Date(until);
  const offering: Offering = {
    id: "compute.edge.local-metered",
    providerPackRef: providerId,
    providerInstallationRef: `${providerId}.local`,
    supplyContractRef: `${providerId}.contract`,
    pricePlanRef: "compute.edge.local-metered.price-v1",
    pricePlan: {
      id: "compute.edge.local-metered.price-v1",
      currency: "USD",
      provisioning: { meter: "resource.create", amountMinor: 0 },
      meters: [{ meter, amountMinor: 150 }],
    },
    resourceClass: "compute.edge",
    deliveryMode: "embedded-binding",
    supportPolicyRef: "support:local",
    abusePolicyRef: "abuse:local",
    kind: "worker",
    displayName: "Local metered compute",
    form: {
      apiVersion: "example.forms.test",
      kind: "ExampleWorkload",
      definitionVersion: "1.0.0",
      schemaDigest: `sha256:${"a".repeat(64)}`,
    },
    providedInterfaces: [],
    bindingRefs: [],
    regions: ["test"],
    portability: { api: "portable", exportFormats: [], importFormats: [], migrationModes: [] },
    isolation: "dedicated-resource",
    available: true,
  };
  let reads = 0;
  const pack = createProviderPack({
    id: providerId,
    providerType: providerId,
    provisioners: [new FakeProvider({ id: providerId, offerings: [] })],
    attachmentFactories: [],
    transferEndpoints: [],
    credentialIssuers: [],
    meterSources: [
      {
        id: "local-provider-usage",
        meters: [meter],
        settlementDelaySeconds: 0,
        maximumWindowSeconds: 86_400,
        windowAlignment: "utc-day",
        async read(input) {
          if (
            input.tenantId !== ownerOrg ||
            input.deployment.id !== deploymentId ||
            input.deployment.resourceUid !== resourceUid ||
            input.from !== from ||
            input.until !== until
          )
            throw new Error("unexpected provider window");
          reads++;
          return [{ meter, quantity: 2 }];
        },
      },
    ],
    costEstimators: [],
  });
  const dom = installConsoleTestDom("https://console.measured-usage.test/billing");
  Object.assign(window, { localStorage });
  let host: Awaited<ReturnType<typeof createSignedConsoleHost>> | undefined;
  let state: typeof import("../console/src/state.ts") | undefined;
  let stopIdentity: (() => void) | undefined;
  try {
    host = await createSignedConsoleHost(dom.origin, {}, billing, undefined, () => now, {
      offerings: [offering],
      providerPacks: [pack],
    });
    const fixture = host;
    globalThis.fetch = fixture.transport;
    state = await import("../console/src/state.ts");
    const { setConsoleLocale } = await import("../console/src/i18n.ts");
    const { billingPage } = await import("../console/src/pages/billing.ts");
    setConsoleLocale("en");
    const active = state;
    active.setApiOrigin(fixture.origin);
    stopIdentity = active.observeSessionIdentity(() => {});
    const showBilling = async (subject: string) => {
      expect(
        await active.signInSession(
          "google",
          await fixture.assertion(subject),
          "operator-assertion",
        ),
      ).toBe(true);
      await waitFor(
        `${subject} authenticated roster`,
        () => active.organizationPageState() !== "loading",
      );
      expect(active.principal()?.id).toBe(subject);
      const org = `org-${subject}`;
      active.selectOrganization(org);
      expect(active.currentOrganization()?.id).toBe(org);
      const page = billingPage(org);
      if (!(page instanceof ConsoleTestNode)) throw new Error("Console billing page missing");
      dom.root.replaceChildren(page);
    };
    const uncharged = () =>
      statValue(dom.root, "Available") === "$20" &&
      statValue(dom.root, "Included usage") === "0%" &&
      workspaceUsed(dom.root, "Organization total") === "—" &&
      workspaceUsed(dom.root, "Unattributed") === "—";
    await showBilling("logout-a");
    await waitFor("uncharged provider wallet", uncharged);

    // Only placement is a precondition. The original maintenance pass creates
    // all usage, checkpoint, and debit records from the inert meter source.
    await createResourceDeploymentStore(fixture.sql, () => new Date(from)).create({
      tenantId: ownerOrg,
      id: deploymentId,
      resourceUid,
      offeringId: offering.id,
      providerPackRef: providerId,
      providerInstallationRef: offering.providerInstallationRef,
      nativeId: "local:metered-workload",
      state: "active",
      observed: {},
      outputs: {},
    });
    // Fail after the measurement is durable, before its cursor can advance.
    // Retry covers the same closed day and must reuse that exact usage row.
    await fixture.sql.run(`
      CREATE TEMP TRIGGER fail_provider_checkpoint BEFORE UPDATE OF cursor_at ON provider_meter_checkpoints
      BEGIN SELECT RAISE(ABORT, 'fixture checkpoint write failure'); END
    `);
    expect(await fixture.tick()).toMatchObject({
      providerMeterWindows: 0,
      providerMeterFailures: [deploymentId],
      meteredRows: 1,
    });
    expect(reads).toBe(1);
    const readUsage = () =>
      fixture.sql.query(
        "SELECT request_id,org_id,resource_uid,meter,quantity,amount_micros,rollup_id FROM usage_events",
      );
    const usage = await readUsage();
    expect(usage).toEqual([
      {
        request_id: expect.stringMatching(/^provider:/u),
        org_id: ownerOrg,
        resource_uid: resourceUid,
        meter,
        quantity: 2,
        amount_micros: 3_000_000,
        rollup_id: expect.any(String),
      },
    ]);
    const readDebits = () =>
      fixture.sql.query(
        "SELECT org_id,type,ref,settled_delta_micros FROM ledger WHERE type IN ('usage_debit','capture')",
      );
    const debits = await readDebits();
    expect(debits).toEqual([
      {
        org_id: ownerOrg,
        type: "usage_debit",
        ref: usage[0]?.rollup_id,
        settled_delta_micros: -3_000_000,
      },
    ]);

    await fixture.sql.run("DROP TRIGGER fail_provider_checkpoint");
    now = new Date(now.getTime() + 300_000);
    expect(await fixture.tick()).toMatchObject({
      providerMeterWindows: 1,
      providerMeterFailures: [],
      meteredRows: 0,
    });
    expect(
      await fixture.sql.query(
        "SELECT tenant_id,deployment_id,meter_source_id,cursor_at FROM provider_meter_checkpoints",
      ),
    ).toEqual([
      {
        tenant_id: ownerOrg,
        deployment_id: deploymentId,
        meter_source_id: "local-provider-usage",
        cursor_at: Date.parse(until),
      },
    ]);
    expect(await fixture.tick()).toMatchObject({
      providerMeterWindows: 0,
      providerMeterFailures: [],
      meteredRows: 0,
    });
    expect(reads).toBe(2);
    expect(await readUsage()).toEqual(usage);
    expect(await readDebits()).toEqual(debits);

    find(
      dom.root,
      (node) => node.tag === "button" && node.textContent === "Refresh balance and usage",
    ).click();
    await waitFor(
      "priced provider usage in Console",
      () =>
        statValue(dom.root, "Available") === "$17" &&
        statValue(dom.root, "Included usage") === "15%" &&
        workspaceUsed(dom.root, "Organization total") === "$3" &&
        workspaceUsed(dom.root, "Unattributed") === "$3",
    );
    await active.signOut();
    await showBilling("logout-b");
    await waitFor("unrelated Organization provider usage", uncharged);
    expect(
      (
        await fixture.transport(
          `${fixture.origin}/v1/organizations/${ownerOrg}/wallet/usage-summary`,
          { credentials: "include" },
        )
      ).status,
    ).toBe(404);
    expect(await readUsage()).toEqual(usage);
    expect(await readDebits()).toEqual(debits);
  } finally {
    try {
      stopIdentity?.();
      state?.session.set(null);
      state?.sessionKind.set(null);
      if (host) await waitFor("provider Host IO drained", () => host?.pending() === 0);
      await tick();
    } finally {
      try {
        host?.close();
      } finally {
        dom.restore();
      }
    }
  }
}, 10_000);

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
  let cleanupFailure: { error: unknown } | undefined;
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
    try {
      try {
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
