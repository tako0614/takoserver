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
  parseBillingSessionFile,
  parseBusinessInput,
  runStart,
  runVerify,
} from "../scripts/hosted-billing-business-e2e.ts";
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
    pricingRevision: usage.pricingRevision,
    amountMicros: usage.expectedMicros,
  };
}

test("shared Server session uses its own cookie and exact console Origin on actual billing requests", async () => {
  const credential = parseBillingSessionFile(
    "__Host-takoserver_shared_session=actual-server-session\n",
    "https://console.staging.example",
  );
  const seen: Request[] = [];
  const client = new BillingHttp("https://api.staging.example", credential, async (request) => {
    seen.push(request);
    return Response.json({ ok: true });
  });
  await client.request("GET", "/v1/me");
  await client.request("POST", "/v1/organizations/org_original/wallet/checkout", {
    reference: "original-reference",
    amountMinor: 500,
  });
  expect(seen).toHaveLength(2);
  for (const request of seen) {
    expect(request.headers.get("cookie")).toBe(
      "__Host-takoserver_shared_session=actual-server-session",
    );
    expect(request.headers.get("origin")).toBe("https://console.staging.example");
    expect(request.headers.has("authorization")).toBe(false);
  }
  const post = seen[1];
  if (!post) throw new Error("missing business POST");
  expect(await post.json()).toEqual({ reference: "original-reference", amountMinor: 500 });
});

test("session file refuses other cookies, mixed credentials and an unselected console Origin", () => {
  expect(parseBillingSessionFile("legacy-session\n")).toBe("legacy-session");
  expect(parseBillingSessionFile("legacy-padded==\n")).toBe("legacy-padded==");
  for (const raw of [
    "__Host-takosumi_hosted_session=foreign-session",
    "takoserver_session=legacy-session",
    "__Host-takoserver_shared_session=first; other=second",
    "__Host-takoserver_shared_session=first\nother=second",
    "__Host-takoserver_shared_session=",
  ]) {
    expect(() => parseBillingSessionFile(raw, "https://console.staging.example")).toThrow();
  }
  expect(() => parseBillingSessionFile("__Host-takoserver_shared_session=original")).toThrow();
  for (const origin of ["http://console.staging.example", "https://console.staging.example/path"]) {
    expect(() =>
      parseBillingSessionFile("__Host-takoserver_shared_session=original", origin),
    ).toThrow();
  }
});

test("HTTP client detaches the selected session credential before caller mutation", async () => {
  const credential = {
    kind: "shared-cookie" as const,
    secret: "original-session",
    consoleOrigin: "https://console.staging.example",
  };
  const client = new BillingHttp("https://api.staging.example", credential, async (request) => {
    expect(request.headers.get("cookie")).toBe("__Host-takoserver_shared_session=original-session");
    expect(request.headers.get("origin")).toBe("https://console.staging.example");
    return Response.json({ ok: true });
  });
  credential.secret = "replacement-session";
  credential.consoleOrigin = "https://other.example";
  await client.request("GET", "/v1/me");
});

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
    if (path.endsWith("/wallet/usage-summary/workspaces")) return Response.json({ workspaces: [] });
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

test("real route sequence retains exact commands, permits GET reentry, and never claims webhook proof", async () => {
  const f = fixture();
  const originalInput = parseBusinessInput(f.inputRaw);
  const calls: string[] = [];
  const postBodies: unknown[] = [];
  let crossedUsage = false;
  let crossedPlan = false;
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
    if (url.pathname.endsWith("/wallet/usage-records"))
      return Response.json({
        usageRecords: [
          {
            ...publicUsage(originalInput, "org_original"),
            workspaceRef: crossedUsage ? "other-workspace" : originalInput.usage.workspaceRef,
          },
        ],
        cursor: null,
      });
    if (url.pathname.endsWith("/wallet/usage-summary/workspaces"))
      return Response.json({ workspaces: [{ workspaceRef: "workspace-original" }] });
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
    topupState: "paid",
    topupAmountProven: true,
    subscriptionCommandState: "open",
    webhookProven: false,
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
      return Response.json({ workspaces: [{ workspaceRef }] });
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
        return Response.json({ workspaces: [{ workspaceRef: "workspace-original" }] });
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
