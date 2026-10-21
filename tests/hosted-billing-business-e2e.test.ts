import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  assertStagingTarget,
  BillingHttp,
  type BusinessInput,
  billingE2eFailureDiagnostic,
  parseBusinessInput,
  runStart,
  runVerify,
} from "../scripts/hosted-billing-business-e2e.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import type { CheckoutReceipt } from "../src/subscription-custody.ts";
import { workspaceBillingOrganizationRef } from "../src/workspace-billing-organization.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "billing-business-e2e-"));
  chmodSync(dir, 0o700);
  dirs.push(dir);
  const inputRaw = JSON.stringify({
    kind: "takoserver.hosted-billing-business-e2e-input@v1",
    sourceHead: "a".repeat(40),
    targetSha256: `sha256:${"b".repeat(64)}`,
    usage: {
      reference: "usage-original",
      meter: "edge-request",
      quantityUnit: "request",
      quantity: "1",
      periodStart: "2026-10-18T00:00:00.000Z",
      periodEnd: "2026-10-18T01:00:00.000Z",
      pricingRevision: "revision-original",
      expectedMicros: "1",
      measurementFingerprint: "measurement-original",
      workspaceRef: "workspace-original",
    },
    subscription: { reference: "subscription-original", planKey: "monthly-original" },
    topup: { reference: "topup-original", amountMinor: 500 },
  });
  return {
    inputRaw,
    input: parseBusinessInput(inputRaw),
    journalPath: join(dir, "original.jsonl"),
    handoffPath: join(dir, "checkout"),
    targetSha256: `sha256:${"b".repeat(64)}`,
    origin: "https://api.staging.example",
  };
}

function publicUsage(input: BusinessInput, organizationId: string) {
  const usage = input.usage;
  return {
    organizationId,
    reference: usage.reference,
    workspaceRef: usage.workspaceRef,
    meter: usage.meter,
    quantity: usage.quantity,
    quantityUnit: usage.quantityUnit,
    periodStart: usage.periodStart,
    periodEnd: usage.periodEnd,
    attributionPeriodStart: "2026-10-01T00:00:00.000Z",
    attributionPeriodEnd: "2026-11-01T00:00:00.000Z",
    pricingRevision: usage.pricingRevision,
    amountMicros: usage.expectedMicros,
    status: "pending",
    createdAt: "2026-10-18T01:00:00.000Z",
  };
}

function workspaceUsagePage(
  input: BusinessInput,
  organizationId: string,
  amounts: { usedMicros?: string; heldMicros?: string; pendingMicros?: string } = {},
  period = { start: "2026-10-01T00:00:00.000Z", end: "2026-11-01T00:00:00.000Z" },
) {
  return {
    organizationId,
    snapshotAt: period.start.startsWith("2026-11")
      ? "2026-11-18T02:00:00.000Z"
      : "2026-10-18T02:00:00.000Z",
    periodStart: period.start,
    periodEnd: period.end,
    unit: "USD-micros",
    workspaces: [
      {
        workspaceRef: input.usage.workspaceRef,
        usedMicros: amounts.usedMicros ?? input.usage.expectedMicros,
        heldMicros: amounts.heldMicros ?? "0",
        pendingMicros: amounts.pendingMicros ?? "0",
      },
    ],
    cursor: null,
  };
}

function sharedAuthoring() {
  const sharedPricing = JSON.parse(
    readFileSync(new URL("../config/shared-hosted-pricing.json", import.meta.url), "utf8"),
  );
  sharedPricing.plans[0].stripePriceId = "price_final10";
  sharedPricing.plans[1].stripePriceId = "price_final50";
  const meters = Object.fromEntries(
    Object.entries(
      sharedPricing.meters as Record<
        string,
        { unit: string; cloudflareCostMicros: string; quantity: string }
      >,
    )
      .filter(([, meter]) => meter.cloudflareCostMicros !== "0")
      .map(([key, meter]) => [
        key,
        {
          unit: meter.unit,
          rate: {
            numeratorMicros: (BigInt(meter.cloudflareCostMicros) * 3n).toString(),
            denominator: meter.quantity,
          },
        },
      ]),
  );
  return compilePricingAuthoring({
    authoringVersion: 2,
    sharedPricing,
    planIds: { free: "free", usage: "usage" },
    billingConfig: {
      schemaVersion: 1,
      revision: sharedPricing.revision,
      effectiveAt: "2026-10-14T00:00:00.000Z",
      currency: "USD",
      holdTtlSeconds: 86400,
      freeIncludedMinor: 150,
      purchaseCreditExpiry: { kind: "none" },
      plans: {
        "hosted-10": { includedMinor: 2000, stripePriceId: "price_final10" },
        "hosted-50": { includedMinor: 10000, stripePriceId: "price_final50" },
      },
      meters,
    },
    checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
  }).hostedPlanTable;
}

function reverseObjectKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseObjectKeys);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .reverse()
      .map(([key, child]) => [key, reverseObjectKeys(child)]),
  );
}

test("CLI diagnostics distinguish HTTP refusals without disclosing request or response secrets", async () => {
  for (const status of [401, 503]) {
    for (const method of ["GET", "POST"] as const) {
      const client = new BillingHttp(
        "https://private.staging.example",
        "private-session",
        async () =>
          new Response("private-response-body", { status, statusText: "private-status-text" }),
      );
      let failure: unknown;
      try {
        await client.request(method, "/v1/organizations/private-org/wallet", {
          secret: "private-body",
        });
      } catch (error) {
        failure = error;
      }
      const diagnostic = billingE2eFailureDiagnostic(failure);
      expect(diagnostic).toContain(`HTTP ${method} ${status}`);
      expect(diagnostic).toContain("do not repeat start");
      expect(diagnostic).not.toContain("private-");
      expect(diagnostic).not.toContain("private.staging.example");
    }
  }
});

test("CLI diagnostics keep transport failures and foreign errors private", async () => {
  const client = new BillingHttp("https://private.staging.example", "private-session", async () => {
    throw new Error("private-transport-detail");
  });
  let failure: unknown;
  try {
    await client.request("POST", "/v1/organizations/personal", {});
  } catch (error) {
    failure = error;
  }
  const generic =
    "Billing E2E refused or outcome unknown. Inspect the private journal; do not repeat start.\n";
  expect(billingE2eFailureDiagnostic(failure)).toBe(generic);
  expect(billingE2eFailureDiagnostic(new Error("HTTP GET 401; private-session"))).toBe(generic);
  expect(
    billingE2eFailureDiagnostic({
      get message() {
        throw new Error("must not inspect foreign error fields");
      },
    }),
  ).toBe(generic);
  expect(billingE2eFailureDiagnostic(null)).toBe(generic);
});

test("production and unselected billing targets are refused", () => {
  expect(() =>
    assertStagingTarget({
      environment: "production",
      publicOrigin: "https://api.example",
      hostedBilling: {
        selector: "canonical-test",
        stripeMode: "test",
        accountId: "acct",
        billingAuthority: "realm",
      },
    }),
  ).toThrow();
  expect(() =>
    assertStagingTarget({
      environment: "integration",
      publicOrigin: "https://api.example",
    }),
  ).toThrow();
});

test("closed usage accepts the API's fractional quantity and rejects malformed period", () => {
  const f = fixture();
  const value = JSON.parse(f.inputRaw);
  value.usage.quantity = "0.9";
  expect(parseBusinessInput(JSON.stringify(value)).usage.quantity).toBe("0.9");
  value.usage.periodEnd = value.usage.periodStart;
  expect(() => parseBusinessInput(JSON.stringify(value))).toThrow("not closed");
});

test("selected target pricing must exactly match the public table before billing mutations", async () => {
  const expectedPlanTable = sharedAuthoring();
  const selectedInputRaw = fixture().inputRaw.replace('"monthly-original"', '"hosted-10"');
  const reversed = reverseObjectKeys(expectedPlanTable);
  const f = fixture();
  const posts: string[] = [];
  const client = new BillingHttp(f.origin, "session-private", async (request) => {
    const path = new URL(request.url).pathname;
    if (request.method === "POST") posts.push(path);
    if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
    if (path === "/v1/organizations/personal")
      return Response.json({ organization: { id: "org_original" }, created: true });
    if (path.endsWith("/payments/subscription") && request.method === "GET")
      return Response.json({ subscription: null, planTable: reversed });
    if (path.endsWith("/wallet/usage-records") && request.method === "POST")
      return Response.json({ usageRecord: publicUsage(f.input, "org_original") });
    if (path.endsWith("/payments/subscription"))
      return Response.json({ checkout: { state: "pending", id: "sci_original" } });
    if (path.endsWith("/wallet/checkout"))
      return Response.json({
        checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_topup" },
      });
    if (path.endsWith("/wallet"))
      return Response.json({ wallet: { organizationId: "org_original" } });
    if (path.endsWith("/wallet/usage-summary"))
      return Response.json({ usageSummary: { organizationId: "org_original" } });
    if (path.endsWith("/wallet/usage-summary/workspaces"))
      return Response.json(workspaceUsagePage(f.input, "org_original"));
    throw new Error("unexpected route");
  });
  await runStart({ ...f, inputRaw: selectedInputRaw, client, expectedPlanTable });
  expect(posts).toHaveLength(4);

  const changedTables: unknown[] = [];
  const changedPlanPrice = structuredClone(expectedPlanTable);
  const paidPlan = changedPlanPrice.plans.find((plan) => plan.tier === "subscription");
  if (paidPlan?.tier !== "subscription") throw new Error("missing paid fixture plan");
  (paidPlan as { monthlyAmountMinor: number }).monthlyAmountMinor++;
  changedTables.push(changedPlanPrice);
  const changedContainerRate = structuredClone(expectedPlanTable);
  const usagePlan = changedContainerRate.plans.find((plan) => plan.tier === "usage");
  if (usagePlan?.tier !== "usage") throw new Error("missing usage fixture plan");
  const containerEgress = usagePlan.meters["container.egress"] as {
    rate: { numeratorMicros: string };
  };
  containerEgress.rate.numeratorMicros = (
    BigInt(containerEgress.rate.numeratorMicros) + 1n
  ).toString();
  changedTables.push(changedContainerRate);
  const missingContainerMeter = structuredClone(expectedPlanTable);
  const missingUsage = missingContainerMeter.plans.find((plan) => plan.tier === "usage");
  if (missingUsage?.tier !== "usage") throw new Error("missing usage fixture plan");
  delete (missingUsage.meters as Record<string, unknown>)["container.image-storage"];
  changedTables.push(missingContainerMeter);

  for (const planTable of changedTables) {
    const mismatchFixture = fixture();
    const calls: string[] = [];
    const mismatchClient = new BillingHttp(
      mismatchFixture.origin,
      "session-private",
      async (request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "POST") calls.push(path);
        if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
        if (path === "/v1/organizations/personal")
          return Response.json({ organization: { id: "org_original" }, created: true });
        if (path.endsWith("/payments/subscription"))
          return Response.json({ subscription: null, planTable });
        if (path.endsWith("/wallet"))
          return Response.json({ wallet: { organizationId: "org_original" } });
        if (path.endsWith("/wallet/usage-summary"))
          return Response.json({ usageSummary: { organizationId: "org_original" } });
        if (path.endsWith("/wallet/usage-summary/workspaces"))
          return Response.json(workspaceUsagePage(mismatchFixture.input, "org_original"));
        throw new Error("unexpected route");
      },
    );
    await expect(
      runStart({
        ...mismatchFixture,
        inputRaw: selectedInputRaw,
        client: mismatchClient,
        expectedPlanTable,
      }),
    ).rejects.toThrow("public pricing table differs from selected target pricing");
    expect(calls).toEqual(["/v1/organizations/personal"]);
    const journalAfterMismatch = readFileSync(mismatchFixture.journalPath, "utf8");
    await expect(
      runStart({
        ...mismatchFixture,
        inputRaw: selectedInputRaw,
        client: mismatchClient,
        expectedPlanTable,
      }),
    ).rejects.toThrow("journal already exists");
    expect(calls).toEqual(["/v1/organizations/personal"]);
    expect(readFileSync(mismatchFixture.journalPath, "utf8")).toBe(journalAfterMismatch);
  }

  const absentPlanFixture = fixture();
  const absentPlanClient = new BillingHttp(
    absentPlanFixture.origin,
    "session-private",
    async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") {
        expect(path).toBe("/v1/organizations/personal");
      }
      if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
      if (path === "/v1/organizations/personal")
        return Response.json({ organization: { id: "org_original" }, created: true });
      if (path.endsWith("/payments/subscription"))
        return Response.json({ subscription: null, planTable: reversed });
      if (path.endsWith("/wallet"))
        return Response.json({ wallet: { organizationId: "org_original" } });
      if (path.endsWith("/wallet/usage-summary"))
        return Response.json({ usageSummary: { organizationId: "org_original" } });
      if (path.endsWith("/wallet/usage-summary/workspaces"))
        return Response.json(workspaceUsagePage(absentPlanFixture.input, "org_original"));
      throw new Error("unexpected route");
    },
  );
  await expect(
    runStart({ ...absentPlanFixture, client: absentPlanClient, expectedPlanTable }),
  ).rejects.toThrow("selected plan is absent from the target plan table");
  expect(readFileSync(absentPlanFixture.journalPath, "utf8")).toContain('"step":"personal"');
});

test("verify reports only compared pricing and refuses a changed public table without mutation", async () => {
  const f = fixture();
  const selectedInputRaw = f.inputRaw.replace('"monthly-original"', '"hosted-10"');
  const selectedInput = parseBusinessInput(selectedInputRaw);
  const expectedPlanTable = sharedAuthoring();
  let currentTable: unknown = reverseObjectKeys(expectedPlanTable);
  const calls: string[] = [];
  const client = new BillingHttp(f.origin, "session-private", async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    calls.push(`${request.method} ${path}`);
    if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
    if (path === "/v1/organizations/personal")
      return Response.json({ organization: { id: "org_original" }, created: true });
    if (path.endsWith("/payments/subscription") && request.method === "GET")
      return Response.json({ subscription: null, planTable: currentTable });
    if (path.endsWith("/wallet/usage-records") && request.method === "POST")
      return Response.json({ usageRecord: publicUsage(selectedInput, "org_original") });
    if (path.endsWith("/payments/subscription"))
      return Response.json({ checkout: { state: "pending", id: "sci_original" } });
    if (path.endsWith("/wallet/checkout") && request.method === "POST")
      return Response.json({
        checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_topup" },
      });
    if (path.endsWith("/wallet/checkout/topup-original"))
      return Response.json({ reference: "topup-original", state: "open" });
    if (path.endsWith("/wallet/usage-records"))
      return Response.json({
        usageRecords: [publicUsage(selectedInput, "org_original")],
        cursor: null,
      });
    if (path.endsWith("/wallet/usage-summary/workspaces"))
      return Response.json(workspaceUsagePage(selectedInput, "org_original"));
    if (path.endsWith("/wallet/usage-summary"))
      return Response.json({ usageSummary: { organizationId: "org_original" } });
    if (path.endsWith("/wallet"))
      return Response.json({ wallet: { organizationId: "org_original" } });
    if (path.endsWith("/payments/subscription/commands/start/subscription-original"))
      return Response.json({
        receipt: {
          reference: "subscription-original",
          organizationId: "org_original",
          planKey: "hosted-10",
          state: "open",
        },
      });
    throw new Error("unexpected route");
  });
  await runStart({ ...f, inputRaw: selectedInputRaw, client, expectedPlanTable });
  const journal = readFileSync(f.journalPath, "utf8");
  calls.length = 0;
  const verified = await runVerify({ ...f, inputRaw: selectedInputRaw, client, expectedPlanTable });
  expect(verified).toMatchObject({ pricingTableMatched: true, containerPricingMatched: true });
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  expect(readFileSync(f.journalPath, "utf8")).toBe(journal);

  const changed = structuredClone(expectedPlanTable);
  const paidPlan = changed.plans.find((plan) => plan.tier === "subscription");
  if (paidPlan?.tier !== "subscription") throw new Error("missing paid fixture plan");
  (paidPlan as { monthlyAmountMinor: number }).monthlyAmountMinor++;
  currentTable = changed;
  calls.length = 0;
  await expect(
    runVerify({ ...f, inputRaw: selectedInputRaw, client, expectedPlanTable }),
  ).rejects.toThrow("public pricing table differs from selected target pricing");
  expect(calls.every((call) => call.startsWith("GET "))).toBe(true);
  expect(calls.some((call) => call.endsWith("/wallet/usage-records"))).toBe(false);
  expect(calls.some((call) => call.startsWith("POST "))).toBe(false);
  expect(readFileSync(f.journalPath, "utf8")).toBe(journal);
});

test("unavailable authenticated session preflight creates no journal or mutation", async () => {
  const f = fixture();
  let calls = 0;
  const client = new BillingHttp(f.origin, "session-private", async (request) => {
    calls++;
    expect(request.method).toBe("GET");
    expect(new URL(request.url).pathname).toBe("/v1/me");
    return Response.json({ error: { code: "billing_unavailable" } }, { status: 503 });
  });
  await expect(runStart({ ...f, client })).rejects.toThrow("HTTP 503");
  expect(calls).toBe(1);
  expect(() => readFileSync(f.journalPath)).toThrow();
});

test("start refuses Workspace snapshots that cannot establish a positive used plus pending lower bound", async () => {
  const base = fixture();
  const wrongPeriod = {
    ...workspaceUsagePage(base.input, "org_original", { usedMicros: "1000" }),
    periodStart: "2026-11-18T00:00:00.000Z",
    periodEnd: "2026-11-18T01:00:00.000Z",
  };
  const malformedAmount = workspaceUsagePage(base.input, "org_original", {
    usedMicros: "01",
  });
  const badCursor = { ...workspaceUsagePage(base.input, "org_original"), cursor: "next" };
  const beforeReceipt = {
    ...workspaceUsagePage(base.input, "org_original"),
    snapshotAt: "2026-10-18T00:59:59.999Z",
  };
  const wrongOrganization = {
    ...workspaceUsagePage(base.input, "org_original"),
    organizationId: "org_crossed",
  };
  for (const page of [
    workspaceUsagePage(base.input, "org_original", { usedMicros: "0", pendingMicros: "0" }),
    workspaceUsagePage(base.input, "org_original", {
      usedMicros: "0",
      heldMicros: "1",
      pendingMicros: "0",
    }),
    wrongPeriod,
    malformedAmount,
    badCursor,
    wrongOrganization,
    beforeReceipt,
  ]) {
    const f = fixture();
    const posts: string[] = [];
    const client = new BillingHttp(f.origin, "session-private", async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") posts.push(path);
      if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
      if (path === "/v1/organizations/personal")
        return Response.json({ organization: { id: "org_original" }, created: true });
      if (path.endsWith("/wallet/usage-records") && request.method === "POST")
        return Response.json({ usageRecord: publicUsage(f.input, "org_original") });
      if (path.endsWith("/payments/subscription") && request.method === "GET")
        return Response.json({
          subscription: null,
          planTable: { plans: [{ planId: "monthly-original" }] },
        });
      if (path.endsWith("/wallet/usage-summary/workspaces")) return Response.json(page);
      if (path.endsWith("/wallet/usage-summary"))
        return Response.json({ usageSummary: { organizationId: "org_original" } });
      if (path.endsWith("/wallet"))
        return Response.json({ wallet: { organizationId: "org_original" } });
      throw new Error("unexpected route");
    });
    await expect(runStart({ ...f, client })).rejects.toThrow();
    expect(posts).toEqual([
      "/v1/organizations/personal",
      "/v1/organizations/org_original/wallet/usage-records",
    ]);
    const journal = readFileSync(f.journalPath, "utf8");
    expect(journal).toContain('"kind":"ack","step":"usage"');
    expect(journal).not.toContain('"step":"subscription"');
  }
  const zero = fixture();
  const zeroRaw = zero.inputRaw.replace('"expectedMicros":"1"', '"expectedMicros":"0"');
  expect(parseBusinessInput(zeroRaw).usage.expectedMicros).toBe("0");
  const zeroClient = new BillingHttp(zero.origin, "session-private", async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
    if (path === "/v1/organizations/personal")
      return Response.json({ organization: { id: "org_original" }, created: true });
    if (path.endsWith("/wallet/usage-records") && request.method === "POST")
      return Response.json({
        usageRecord: publicUsage(parseBusinessInput(zeroRaw), "org_original"),
      });
    if (path.endsWith("/wallet/usage-records"))
      return Response.json({
        usageRecords: [publicUsage(parseBusinessInput(zeroRaw), "org_original")],
        cursor: null,
      });
    if (path.endsWith("/payments/subscription") && request.method === "GET")
      return Response.json({
        subscription: null,
        planTable: { plans: [{ planId: "monthly-original" }] },
      });
    if (path.endsWith("/wallet/usage-summary/workspaces"))
      return Response.json(workspaceUsagePage(parseBusinessInput(zeroRaw), "org_original"));
    if (path.endsWith("/wallet/usage-summary"))
      return Response.json({ usageSummary: { organizationId: "org_original" } });
    if (path.endsWith("/wallet"))
      return Response.json({ wallet: { organizationId: "org_original" } });
    throw new Error("unexpected route");
  });
  await expect(runStart({ ...zero, inputRaw: zeroRaw, client: zeroClient })).rejects.toThrow(
    "zero usage amount",
  );
  expect(await runVerify({ ...zero, inputRaw: zeroRaw, client: zeroClient })).toMatchObject({
    usagePublicFieldsMatch: true,
    workspaceUsageAggregateLowerBoundProven: false,
    workspaceUsageAggregateLowerBoundSource: "not-comparable",
    webhookProven: false,
  });
});

test("a lost personal POST acknowledgement is journaled before transport and never resent", async () => {
  const f = fixture();
  const calls: string[] = [];
  const client = new BillingHttp(f.origin, "session-private", async (request) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    if (request.method === "GET") return Response.json({ principal: {}, organizations: [] });
    throw new Error("connection lost after commit");
  });
  await expect(runStart({ ...f, client })).rejects.toThrow();
  expect(calls).toEqual(["GET /v1/me", "POST /v1/organizations/personal"]);
  const journal = readFileSync(f.journalPath, "utf8");
  expect(journal).toContain('"step":"personal","organizationId":null,"body":{}');
  expect(journal).not.toContain("session-private");
  await expect(runStart({ ...f, client })).rejects.toThrow("journal already exists");
  expect(calls).toHaveLength(2);
  expect(await runVerify({ ...f, client })).toEqual({
    state: "unresolved-personal-ack",
    webhookProven: false,
  });
  expect(calls).toHaveLength(2);
});

test("GET recovery rejects crossed or malformed journal custody before transport", async () => {
  const f = fixture();
  const seedClient = new BillingHttp(f.origin, "session-private", async (request) => {
    const path = new URL(request.url).pathname;
    if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
    if (path === "/v1/organizations/personal")
      return Response.json({ organization: { id: "org_original" }, created: true });
    throw new Error("stop after the original personal acknowledgement");
  });
  await expect(runStart({ ...f, client: seedClient })).rejects.toThrow();
  const original = readFileSync(f.journalPath, "utf8");
  const usageIntent = (organizationId: string) => ({
    kind: "intent",
    step: "usage",
    organizationId,
    body: f.input.usage,
  });
  const mutations: readonly ((events: Record<string, unknown>[]) => void)[] = [
    (events) => {
      const intent = events.find((event) => event.kind === "intent");
      if (!intent) throw new Error("fixture has no intent");
      intent.organizationId = "org_other";
    },
    (events) => {
      const intent = events.find((event) => event.kind === "intent");
      if (!intent) throw new Error("fixture has no intent");
      intent.step = "unknown-step";
    },
    (events) => {
      events.pop();
      events.push(usageIntent("org_original"));
    },
    (events) => events.push(usageIntent("org_other")),
    (events) => {
      const header = events[0];
      if (!header) throw new Error("fixture has no header");
      header.unexpected = true;
    },
    (events) => {
      events.push(usageIntent("org_original"));
      events.push({ kind: "ack", step: "usage", organizationId: "org_other" });
    },
  ];
  for (const mutate of mutations) {
    const events: Record<string, unknown>[] = original
      .trimEnd()
      .split("\n")
      .map((line) => JSON.parse(line));
    mutate(events);
    writeFileSync(f.journalPath, `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
    let gets = 0;
    const client = new BillingHttp(f.origin, "session-private", async () => {
      gets++;
      throw new Error("a malformed journal must not select any remote original");
    });
    await expect(runVerify({ ...f, client })).rejects.toThrow();
    expect(gets).toBe(0);
  }
  writeFileSync(f.journalPath, original);
  let reads = 0;
  const healthy = new BillingHttp(f.origin, "session-private", async (request) => {
    reads++;
    expect(request.method).toBe("GET");
    const path = new URL(request.url).pathname;
    if (path.endsWith("/wallet"))
      return Response.json({ wallet: { organizationId: "org_original" } });
    if (path.endsWith("/wallet/usage-summary"))
      return Response.json({ usageSummary: { organizationId: "org_original" } });
    if (path.endsWith("/wallet/usage-summary/workspaces"))
      return Response.json(workspaceUsagePage(f.input, "org_original"));
    if (path.endsWith("/payments/subscription")) return Response.json({ subscription: null });
    return Response.json({ principal: {}, organizations: [] });
  });
  expect(await runVerify({ ...f, client: healthy })).toMatchObject({
    state: "readback-incomplete",
    organizationId: "org_original",
    webhookProven: false,
  });
  expect(reads).toBe(5);
  expect(readFileSync(f.journalPath, "utf8")).toBe(original);
});

test("short private writes complete before POST, and a zero write prevents POST", () => {
  const childSource = `
import { mock } from "bun:test";
const fs = await import("node:fs");
const realWrite = fs.writeSync;
const mode = process.argv[1];
const options = JSON.parse(process.argv[2]);
mock.module("node:fs", () => ({
  ...fs,
  writeSync(fd, value, offset, length, position) {
    const bytes = typeof value === "string" ? Buffer.from(value, "utf8") : value;
    const start = typeof value === "string" ? 0 : offset;
    const count = typeof value === "string" ? bytes.length : length;
    if (mode === "zero" && bytes.toString("utf8", start, start + count).includes('"kind":"intent"'))
      return 0;
    return realWrite(fd, bytes, start, mode === "short" ? Math.min(3, count) : count, position);
  },
}));
const { BillingHttp, runStart } = await import("./scripts/hosted-billing-business-e2e.ts");
let posts = 0;
let completeIntent = false;
const client = new BillingHttp(options.origin, "local-test-session", async (request) => {
  if (request.method === "GET") return Response.json({ principal: {}, organizations: [] });
  posts++;
  const raw = fs.readFileSync(options.journalPath, "utf8");
  if (raw.endsWith("\\n")) {
    const events = raw.trimEnd().split("\\n").map((line) => JSON.parse(line));
    completeIntent = events.some((event) => event.kind === "intent" && event.step === "personal" && JSON.stringify(event.body) === "{}");
  }
  throw new Error("stop after first POST");
});

let failure = "";
try { await runStart({ ...options, client }); } catch (error) { failure = String(error); }
if (mode === "short" && (posts !== 1 || !completeIntent || !failure.includes("HTTP outcome unknown")))
  throw new Error("POST ran without a complete durable intent");
if (mode === "zero" && (posts !== 0 || !failure.includes("private file write incomplete")))
  throw new Error("failed journal write did not stop POST");
console.log("durability regression passed");
`;
  for (const mode of ["short", "zero"]) {
    const f = fixture();
    const options = {
      journalPath: f.journalPath,
      inputRaw: f.inputRaw,
      targetSha256: f.targetSha256,
      origin: f.origin,
      handoffPath: f.handoffPath,
    };
    const child = spawnSync(
      process.execPath,
      ["--no-env-file", "-e", childSource, mode, JSON.stringify(options)],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe("durability regression passed");
  }
});

test("observation publication faults keep the acknowledged usage journal readable for GET recovery", () => {
  const childSource = `
import { mock } from "bun:test";
const fs = await import("node:fs");
const { dirname } = await import("node:path");
const realOpen = fs.openSync;
const realWrite = fs.writeSync;
const realRename = fs.renameSync;
const realFsync = fs.fsyncSync;
const mode = process.argv[1];
const data = JSON.parse(process.argv[2]);
const common = {
  journalPath: data.journalPath,
  inputRaw: data.inputRaw,
  targetSha256: data.targetSha256,
  origin: data.origin,
  handoffPath: data.handoffPath,
};
let temporaryFd = -1;
let temporaryWrites = 0;
let renamed = false;
let fault = false;
let original = null;
mock.module("node:fs", () => ({
  ...fs,
  openSync(path, flags, modeBits) {
    const fd = realOpen(path, flags, modeBits);
    if (typeof path === "string" && path.includes(".observation-")) {
      temporaryFd = fd;
      original = fs.readFileSync(data.journalPath);
    }
    return fd;
  },
  writeSync(fd, value, offset, length, position) {
    if (mode === "partial" && fd === temporaryFd) {
      temporaryWrites++;
      if (temporaryWrites === 1)
        return realWrite(fd, value, offset, Math.min(3, length), position);
      fault = true;
      throw Object.assign(new Error("injected ENOSPC"), { code: "ENOSPC" });
    }
    return realWrite(fd, value, offset, length, position);
  },
  renameSync(from, to) {
    if (String(from).includes(".observation-")) {
      if (mode === "rename") {
        fault = true;
        throw new Error("injected rename failure");
      }
      const result = realRename(from, to);
      renamed = true;
      return result;
    }
    return realRename(from, to);
  },
  fsyncSync(fd) {
    if (mode === "parent-fsync" && renamed) {
      fault = true;
      throw new Error("injected parent fsync failure");
    }
    return realFsync(fd);
  },
}));
const { BillingHttp, runStart, runVerify } = await import("./scripts/hosted-billing-business-e2e.ts");
const posts = [];
const client = new BillingHttp(data.origin, "local-test-session", async (request) => {
  const path = new URL(request.url).pathname;
  if (request.method === "POST") posts.push(path);
  if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
  if (path === "/v1/organizations/personal")
    return Response.json({ organization: { id: "org_original" }, created: true });
  if (path.endsWith("/wallet/usage-records") && request.method === "POST")
    return Response.json({ usageRecord: data.receipt });
  if (path.endsWith("/wallet/usage-records"))
    return Response.json({ usageRecords: [data.receipt], cursor: null });
  if (path.endsWith("/wallet/usage-summary/workspaces")) return Response.json(data.workspace);
  if (path.endsWith("/wallet/usage-summary"))
    return Response.json({ usageSummary: { organizationId: "org_original" } });
  if (path.endsWith("/wallet"))
    return Response.json({ wallet: { organizationId: "org_original" } });
  if (path.endsWith("/payments/subscription") && request.method === "GET")
    return Response.json({ subscription: null, planTable: { plans: [{ planId: "monthly-original" }] } });
  throw new Error("unexpected financial POST or route");
});
let failure = "";
try { await runStart({ ...common, client }); } catch (error) { failure = String(error); }
if (!fault || original === null || failure.length === 0)
  throw new Error("injected observation fault was not reached");
if (posts.length !== 2 || !posts[0].endsWith("/organizations/personal") ||
    !posts[1].endsWith("/wallet/usage-records"))
  throw new Error("a subscription or top-up POST escaped observation failure");
const current = fs.readFileSync(data.journalPath);
const records = current.toString("utf8").trimEnd().split("\\n").map((line) => JSON.parse(line));
const observations = records.filter((event) => event.kind === "workspace-usage-observation");
if (mode === "parent-fsync") {
  if (!current.subarray(0, original.length).equals(original) || observations.length !== 1)
    throw new Error("renamed observation journal is incomplete");
} else if (!current.equals(original) || observations.length !== 0) {
  throw new Error("failed observation publication changed the original usage ACK bytes");
}
if (!records.some((event) => event.kind === "ack" && event.step === "usage"))
  throw new Error("original usage acknowledgement was lost");
const leftovers = fs.readdirSync(dirname(data.journalPath)).filter((name) => name.includes(".observation-"));
if (leftovers.length !== 0) throw new Error("observation temp was not removed");
const verified = await runVerify({ ...common, client });
if (verified.usagePublicFieldsMatch !== true || verified.workspaceUsageAggregateLowerBoundProven !== true ||
    verified.workspaceUsageAggregateLowerBoundSource !==
      (mode === "parent-fsync" ? "saved-pre-checkout-observation" : "current-filtered-snapshot"))
  throw new Error("GET-only original usage recovery failed");
if (posts.length !== 2) throw new Error("verify sent a financial POST");
console.log(mode + " observation recovery passed");
`;
  for (const mode of ["partial", "rename", "parent-fsync"]) {
    const f = fixture();
    const data = {
      journalPath: f.journalPath,
      inputRaw: f.inputRaw,
      targetSha256: f.targetSha256,
      origin: f.origin,
      handoffPath: f.handoffPath,
      receipt: publicUsage(f.input, "org_original"),
      workspace: workspaceUsagePage(f.input, "org_original"),
    };
    const child = spawnSync(
      process.execPath,
      ["--no-env-file", "-e", childSource, mode, JSON.stringify(data)],
      { cwd: new URL("..", import.meta.url), encoding: "utf8" },
    );
    expect(child.status, child.stderr).toBe(0);
    expect(child.stdout.trim()).toBe(`${mode} observation recovery passed`);
  }
});

test("real route sequence retains exact commands, permits GET reentry, and never claims webhook proof", async () => {
  const f = fixture();
  const originalInput = parseBusinessInput(f.inputRaw);
  const calls: string[] = [];
  const postBodies: unknown[] = [];
  let crossedUsage = false;
  let crossedPlan = false;
  let receiptPaid = false;
  let periodDrifted = false;
  let usageMissing = false;
  let manyUsagePages = false;
  let usagePageReads = 0;
  const openCheckout: CheckoutReceipt = {
    state: "open",
    id: "cs_test_original",
    url: "https://checkout.stripe.com/c/pay/cs_test_original",
  };
  const client = new BillingHttp(f.origin, "session-private", async (request) => {
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    if (request.method === "POST") postBodies.push(await request.clone().json());
    if (url.pathname === "/v1/me") {
      Object.assign(f.input.usage, { reference: "caller-mutated-usage" });
      Object.assign(f.input.subscription, { planKey: "caller-mutated-plan" });
      Object.assign(f.input.topup, { amountMinor: 999 });
      return Response.json({ principal: {}, organizations: [] });
    }
    if (url.pathname === "/v1/organizations/personal")
      return Response.json({ organization: { id: "org_original" }, created: true });
    if (url.pathname.endsWith("/wallet/usage-records") && request.method === "POST")
      return Response.json({ usageRecord: publicUsage(originalInput, "org_original") });
    if (url.pathname.endsWith("/wallet/usage-records") && request.method === "GET") {
      if (usageMissing) {
        usagePageReads++;
        return Response.json({
          usageRecords: [],
          cursor: manyUsagePages && usagePageReads < 100 ? `cursor-${usagePageReads}` : null,
        });
      }
      return Response.json({
        usageRecords: [
          {
            ...publicUsage(originalInput, "org_original"),
            status: receiptPaid ? "paid" : "pending",
            workspaceRef: crossedUsage ? "other-workspace" : originalInput.usage.workspaceRef,
          },
        ],
        cursor: null,
      });
    }
    if (url.pathname.endsWith("/wallet/usage-summary/workspaces"))
      return Response.json(
        workspaceUsagePage(
          originalInput,
          "org_original",
          {},
          periodDrifted
            ? { start: "2026-11-01T00:00:00.000Z", end: "2026-12-01T00:00:00.000Z" }
            : undefined,
        ),
      );
    if (url.pathname.endsWith("/wallet/usage-summary"))
      return Response.json({ usageSummary: { organizationId: "org_original" } });
    if (url.pathname.endsWith("/wallet"))
      return Response.json({ wallet: { organizationId: "org_original" } });
    if (url.pathname.endsWith("/payments/subscription/commands/start/subscription-original"))
      return Response.json({
        receipt: {
          reference: "subscription-original",
          organizationId: "org_original",
          planKey: crossedPlan ? "other-plan" : "monthly-original",
          state: "open",
          checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_original" },
        },
      });
    if (url.pathname.endsWith("/payments/subscription") && request.method === "GET")
      return Response.json({
        subscription: null,
        planTable: { plans: [{ planId: "monthly-original" }] },
      });
    if (url.pathname.endsWith("/payments/subscription"))
      return Response.json({ checkout: openCheckout });
    if (url.pathname.endsWith("/wallet/checkout/topup-original"))
      return Response.json({
        reference: "topup-original",
        state: "paid",
        checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_topup" },
      });
    if (url.pathname.endsWith("/wallet/checkout"))
      return Response.json({
        checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_topup" },
      });
    throw new Error("unexpected route");
  });
  await runStart({ ...f, client });
  expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(4);
  expect(postBodies).toEqual([
    {},
    originalInput.usage,
    originalInput.subscription,
    originalInput.topup,
  ]);
  expect(f.input.usage.reference).toBe("caller-mutated-usage");
  const events = readFileSync(f.journalPath, "utf8");
  expect(events).toContain('"reference":"usage-original"');
  expect(events).toContain('"amountMinor":500');
  expect(events).not.toContain("caller-mutated");
  expect(events).not.toContain("cs_test_");
  expect(statSync(f.journalPath).mode & 0o077).toBe(0);
  expect(statSync(`${f.handoffPath}.topup.url`).mode & 0o077).toBe(0);
  expect(readFileSync(`${f.handoffPath}.subscription.url`, "utf8")).toContain("cs_test_original");
  const verified = await runVerify({ ...f, client });
  expect(verified).toMatchObject({
    usagePublicFieldsMatch: true,
    workspaceUsageAggregateLowerBoundProven: true,
    workspaceUsageAggregateLowerBoundSource: "saved-pre-checkout-observation",
    topupState: "paid",
    topupAmountProven: true,
    subscriptionCommandState: "open",
    webhookProven: false,
  });
  expect(verified).not.toHaveProperty("pricingTableMatched");
  expect(verified).not.toHaveProperty("containerPricingMatched");
  expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(4);
  receiptPaid = true;
  periodDrifted = true;
  expect(await runVerify({ ...f, client })).toMatchObject({
    usagePublicFieldsMatch: true,
    workspaceUsageAggregateLowerBoundProven: true,
    workspaceUsageAggregateLowerBoundSource: "saved-pre-checkout-observation",
    workspaceUsageAggregateLowerBound: {
      usedMicros: "1",
      pendingMicros: "0",
      attributionPeriodStart: "2026-10-01T00:00:00.000Z",
      attributionPeriodEnd: "2026-11-01T00:00:00.000Z",
    },
  });
  expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(4);
  crossedPlan = true;
  await expect(runVerify({ ...f, client })).rejects.toThrow(
    "subscription command readback differs",
  );
  crossedPlan = false;
  crossedUsage = true;
  await expect(runVerify({ ...f, client })).rejects.toThrow("usage receipt differs");
  crossedUsage = false;
  rmSync(`${f.handoffPath}.topup.url`);
  expect(await runVerify({ ...f, client })).toMatchObject({ topupAmountProven: true });
  expect(readFileSync(`${f.handoffPath}.topup.url`, "utf8")).toContain("cs_test_topup");
  await expect(runVerify({ ...f, inputRaw: `${f.inputRaw} `, client })).rejects.toThrow(
    "differs from journal",
  );
  writeFileSync(`${f.handoffPath}.topup.url`, "https://checkout.stripe.com/c/pay/different\n", {
    mode: 0o600,
  });
  await expect(runVerify({ ...f, client })).rejects.toThrow("handoff differs");
  writeFileSync(`${f.handoffPath}.topup.url`, "https://checkout.stripe.com/c/pay/cs_test_topup\n");
  const cleanJournal = readFileSync(f.journalPath, "utf8");
  const journalRecords = cleanJournal
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  const observationIndex = journalRecords.findIndex(
    (event) => event.kind === "workspace-usage-observation",
  );
  expect(observationIndex).toBeGreaterThan(0);
  const usageAckIndex = journalRecords.findIndex(
    (event) => event.kind === "ack" && event.step === "usage",
  );
  const corruptions: Record<string, unknown>[][] = [];
  const crossed = structuredClone(journalRecords);
  const crossedObservation = crossed[observationIndex];
  if (!crossedObservation) throw new Error("missing crossed observation fixture");
  Object.assign(crossedObservation, { usageReference: "other-usage" });
  corruptions.push(crossed);
  const duplicate = structuredClone(journalRecords);
  duplicate.push(structuredClone(duplicate[observationIndex]) as Record<string, unknown>);
  corruptions.push(duplicate);
  const orphan = structuredClone(journalRecords);
  const [orphanObservation] = orphan.splice(observationIndex, 1);
  if (!orphanObservation) throw new Error("missing observation fixture");
  orphan.splice(usageAckIndex, 0, orphanObservation);
  corruptions.push(orphan);
  const insufficient = structuredClone(journalRecords);
  const insufficientObservation = insufficient[observationIndex];
  if (!insufficientObservation) throw new Error("missing insufficient observation fixture");
  Object.assign(insufficientObservation, { usedMicros: "0", pendingMicros: "0" });
  corruptions.push(insufficient);
  const unsafeTotal = structuredClone(journalRecords);
  const unsafeObservation = unsafeTotal[observationIndex];
  if (!unsafeObservation) throw new Error("missing unsafe observation fixture");
  Object.assign(unsafeObservation, {
    usedMicros: "9007199254740991",
    pendingMicros: "1",
  });
  corruptions.push(unsafeTotal);
  const outOfPeriodSnapshot = structuredClone(journalRecords);
  const outOfPeriodObservation = outOfPeriodSnapshot[observationIndex];
  if (!outOfPeriodObservation) throw new Error("missing out-of-period observation fixture");
  Object.assign(outOfPeriodObservation, { snapshotAt: "2026-11-01T00:00:00.000Z" });
  corruptions.push(outOfPeriodSnapshot);
  for (const malformed of corruptions) {
    writeFileSync(f.journalPath, `${malformed.map((event) => JSON.stringify(event)).join("\n")}\n`);
    calls.length = 0;
    await expect(runVerify({ ...f, client })).rejects.toThrow();
    expect(calls).toEqual([]);
  }
  writeFileSync(f.journalPath, cleanJournal);
  const legacyJournal = journalRecords.filter(
    (event) => event.kind !== "workspace-usage-observation",
  );
  writeFileSync(
    f.journalPath,
    `${legacyJournal.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
  periodDrifted = false;
  receiptPaid = true;
  expect(await runVerify({ ...f, client })).toMatchObject({
    workspaceUsageAggregateLowerBoundProven: true,
    workspaceUsageAggregateLowerBoundSource: "current-filtered-snapshot",
  });
  periodDrifted = true;
  expect(await runVerify({ ...f, client })).toMatchObject({
    workspaceUsageAggregateLowerBoundProven: false,
    workspaceUsageAggregateLowerBoundSource: "not-comparable",
    workspaceUsageAggregateLowerBound: null,
  });
  writeFileSync(f.journalPath, cleanJournal);
  usageMissing = true;
  calls.length = 0;
  expect(await runVerify({ ...f, client })).toMatchObject({
    usagePublicFieldsMatch: false,
    workspaceUsageAggregateLowerBoundProven: false,
    workspaceUsageAggregateLowerBoundSource: "unproven",
  });
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
  manyUsagePages = true;
  usagePageReads = 0;
  expect(await runVerify({ ...f, client })).toMatchObject({
    usagePublicFieldsMatch: false,
    workspaceUsageAggregateLowerBoundProven: false,
    workspaceUsageAggregateLowerBoundSource: "unproven",
  });
  expect(usagePageReads).toBe(100);
  expect(calls.filter((call) => call.startsWith("POST"))).toEqual([]);
});

test("a shared-auth Workspace selects its derived Organization and never creates a personal one", async () => {
  const f = fixture();
  const authority = "takoserver.hosted.staging-test.v1";
  const workspaceRef = `wrk_${"c".repeat(32)}`;
  const inputRaw = f.inputRaw.replace('"workspace-original"', `"${workspaceRef}"`);
  const input = parseBusinessInput(inputRaw);
  const org = await workspaceBillingOrganizationRef(authority, workspaceRef);
  let ownsOrg = true;
  const calls: string[] = [];
  const client = new BillingHttp(f.origin, "session-private", async (request) => {
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}`);
    if (url.pathname === "/v1/me")
      return Response.json({
        principal: {},
        organizations: ownsOrg ? [{ id: org }] : [{ id: "org_other" }],
      });
    if (url.pathname === "/v1/organizations/personal") throw new Error("personal POST refused");
    if (url.pathname.endsWith("/wallet/usage-records") && request.method === "POST")
      return Response.json({ usageRecord: publicUsage(input, org) });
    if (url.pathname.endsWith("/wallet/usage-records"))
      return Response.json({ usageRecords: [publicUsage(input, org)], cursor: null });
    if (url.pathname.endsWith("/wallet/usage-summary/workspaces"))
      return Response.json(workspaceUsagePage(input, org));
    if (url.pathname.endsWith("/wallet/usage-summary"))
      return Response.json({ usageSummary: { organizationId: org } });
    if (url.pathname.endsWith("/wallet")) return Response.json({ wallet: { organizationId: org } });
    if (url.pathname.endsWith("/payments/subscription/commands/start/subscription-original"))
      return Response.json({
        receipt: {
          reference: "subscription-original",
          organizationId: org,
          planKey: "monthly-original",
          state: "open",
          checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_shared" },
        },
      });
    if (url.pathname.endsWith("/payments/subscription") && request.method === "GET")
      return Response.json({
        subscription: null,
        planTable: { plans: [{ planId: "monthly-original" }] },
      });
    if (url.pathname.endsWith("/payments/subscription"))
      return Response.json({
        checkout: {
          state: "open",
          id: "cs_test_shared",
          url: "https://checkout.stripe.com/c/pay/cs_test_shared",
        },
      });
    if (url.pathname.endsWith("/wallet/checkout/topup-original"))
      return Response.json({
        reference: "topup-original",
        state: "paid",
        checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_topup" },
      });
    if (url.pathname.endsWith("/wallet/checkout"))
      return Response.json({
        checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_topup" },
      });
    throw new Error("unexpected route");
  });
  // Without the target authority, or when the session lacks the derived Org, nothing is journaled.
  await expect(runStart({ ...f, inputRaw, client })).rejects.toThrow("billing authority");
  ownsOrg = false;
  await expect(runStart({ ...f, inputRaw, client, billingAuthority: authority })).rejects.toThrow(
    "does not own",
  );
  expect(() => statSync(f.journalPath)).toThrow();
  ownsOrg = true;
  await runStart({ ...f, inputRaw, client, billingAuthority: authority });
  expect(calls).not.toContain("POST /v1/organizations/personal");
  expect(calls.filter((call) => call.startsWith("POST"))).toHaveLength(3);
  expect(calls).toContain(`POST /v1/organizations/${org}/wallet/usage-records`);
  const journal = readFileSync(f.journalPath, "utf8");
  expect(journal).toContain('"kind":"select"');
  expect(journal).toContain(`"organizationId":"${org}"`);
  expect(await runVerify({ ...f, inputRaw, client })).toMatchObject({
    organizationId: org,
    usagePublicFieldsMatch: true,
    webhookProven: false,
  });
});

for (const outcome of ["lost-ack", "conflict"] as const)
  test(`uncertain top-up ${outcome} stays GET-only and withholds URL`, async () => {
    const f = fixture();
    const posts: string[] = [];
    const pendingCheckout: CheckoutReceipt = { state: "pending", id: "sci_original" };
    const client = new BillingHttp(f.origin, "session-private", async (request) => {
      const path = new URL(request.url).pathname;
      if (request.method === "POST") posts.push(path);
      if (path === "/v1/me") return Response.json({ principal: {}, organizations: [] });
      if (path === "/v1/organizations/personal")
        return Response.json({ organization: { id: "org_original" }, created: true });
      if (path.endsWith("/wallet/usage-records") && request.method === "POST")
        return Response.json({ usageRecord: publicUsage(f.input, "org_original") });
      if (path.endsWith("/wallet/usage-records"))
        return Response.json({
          usageRecords: [publicUsage(f.input, "org_original")],
          cursor: null,
        });
      if (path.endsWith("/wallet/usage-summary/workspaces"))
        return Response.json(workspaceUsagePage(f.input, "org_original"));
      if (path.endsWith("/wallet/usage-summary"))
        return Response.json({ usageSummary: { organizationId: "org_original" } });
      if (path.endsWith("/wallet"))
        return Response.json({ wallet: { organizationId: "org_original" } });
      if (path.endsWith("/payments/subscription/commands/start/subscription-original"))
        return Response.json({
          receipt: {
            reference: "subscription-original",
            organizationId: "org_original",
            planKey: "monthly-original",
            state: "open",
            checkout: null,
          },
        });
      if (path.endsWith("/payments/subscription") && request.method === "GET")
        return Response.json({
          subscription: null,
          planTable: { plans: [{ planId: "monthly-original" }] },
        });
      if (path.endsWith("/payments/subscription"))
        return Response.json({ checkout: pendingCheckout });
      if (path.endsWith("/wallet/checkout/topup-original"))
        return Response.json({
          reference: "topup-original",
          state: "paid",
          checkout: { url: "https://checkout.stripe.com/c/pay/cs_test_recovered" },
        });
      if (path.endsWith("/wallet/checkout")) {
        if (outcome === "conflict")
          return Response.json({ error: { code: "conflict" } }, { status: 409 });
        throw new Error("ACK lost after commit");
      }
      throw new Error("unexpected route");
    });
    await expect(runStart({ ...f, client })).rejects.toThrow();
    expect(readFileSync(f.journalPath, "utf8")).toContain(
      '"step":"topup","organizationId":"org_original","body":{"reference":"topup-original","amountMinor":500}',
    );
    expect(await runVerify({ ...f, client })).toMatchObject({
      topupState: "paid",
      topupAmountProven: false,
      webhookProven: false,
    });
    expect(() => readFileSync(`${f.handoffPath}.topup.url`)).toThrow();
    await expect(runStart({ ...f, client })).rejects.toThrow("journal already exists");
    expect(posts).toHaveLength(4);
  });

test("redirect response is refused without following it or exposing credential", async () => {
  let calls = 0;
  const client = new BillingHttp(
    "https://api.staging.example",
    "session-private",
    async (request) => {
      calls++;
      expect(request.redirect).toBe("error");
      return new Response(null, { status: 302, headers: { location: "https://attacker.example" } });
    },
  );
  await expect(client.request("GET", "/v1/me")).rejects.toThrow("redirect");
  expect(calls).toBe(1);
});
