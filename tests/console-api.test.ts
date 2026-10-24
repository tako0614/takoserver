import { afterEach, expect, test } from "bun:test";
import {
  createApi,
  formatMicrosCurrency,
  formatUsagePercent,
  type WalletUsageSummary,
} from "../console/src/api.ts";
import { finalizedHostedPlanTable } from "./helpers/finalized-hosted-plan-table.ts";

const origin = "https://api.example.test";
const org = "org/example?x=1#%";
const form = "https://forms.example.test/Widget/1.0.0";
const resource = {
  uid: "uid/one?%",
  form,
  space: org,
  name: "one",
  generation: 1,
  observedGeneration: 0,
  observedAt: null,
  phase: "pending" as const,
  spec: { value: 1 },
  observed: {},
  output: {},
  lastOperation: "operation-one",
};
const operation = {
  id: "operation-one",
  resourceUid: resource.uid,
  action: "create",
  generation: 1,
  status: "queued",
  effect: "none",
  createdAt: "2026-10-07T00:00:00Z",
  updatedAt: "2026-10-07T00:00:00Z",
  retainUntil: "2026-10-08T00:00:00Z",
};
const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("usage percent preserves the server basis points, including zero allowance and warning thresholds", async () => {
  for (const [basisPoints, effectiveIncludedMicros, percent] of [
    [0, "0", "0%"],
    [0, "1500000", "0%"],
    [8000, "1500000", "80%"],
    [9500, "20000000", "95%"],
    [10000, "20000000", "100%"],
    [8001, "20000000", "80.01%"],
  ] as const) {
    const usageSummary: WalletUsageSummary = {
      organizationId: org,
      currency: "USD",
      unit: "USD-micros",
      effectiveIncludedMicros,
      utilizationBasisPoints: basisPoints,
    };
    const seen = transport(() => Response.json({ usageSummary }));
    const result = await client().usageSummary(org);
    expect(result).toEqual({ usageSummary });
    expect(formatUsagePercent(result.usageSummary.utilizationBasisPoints, "en-US")).toBe(percent);
    expect(formatUsagePercent(result.usageSummary.utilizationBasisPoints, "ja-JP")).toBe(percent);
    expect(new URL(seen[0]?.url ?? origin).pathname).toBe(
      "/v1/organizations/org%2Fexample%3Fx%3D1%23%25/wallet/usage-summary",
    );
    expect(seen[0]?.credentials).toBe("include");
    expect(seen[0]?.method).toBe("GET");
    expect(seen[0]?.headers.get("authorization")).toBe("Bearer session");
  }
});

test("shared-auth session oracle uses only the cookie and accepts its exact status envelopes", async () => {
  const authenticated = transport(() => Response.json({ authenticated: true }));
  expect(await client().sharedAuthSession()).toEqual({ available: true, authenticated: true });
  expect(new URL(authenticated[0]?.url ?? origin).pathname).toBe("/auth/oidc/session");
  expect(new URL(authenticated[0]?.url ?? origin).search).toBe("");
  expect(authenticated[0]?.method).toBe("GET");
  expect(authenticated[0]?.credentials).toBe("include");
  expect(authenticated[0]?.cache).toBe("no-store");
  expect(authenticated[0]?.headers.has("authorization")).toBe(false);

  transport(() => Response.json({ authenticated: false }, { status: 401 }));
  expect(await client().sharedAuthSession()).toEqual({ available: true, authenticated: false });

  transport(() => Response.json({ error: { code: "not_found" } }, { status: 404 }));
  expect(await client().sharedAuthSession()).toEqual({ available: false, authenticated: false });

  for (const [status, code] of [
    [400, "session_invalid"],
    [503, "session_unavailable"],
  ] as const) {
    transport(() => Response.json({ error: { code } }, { status }));
    await expect(client().sharedAuthSession()).rejects.toMatchObject({ code, status });
  }

  for (const [status, payload] of [
    [200, { authenticated: false }],
    [200, { authenticated: true, subject: "must-not-be-consumed" }],
    [401, { authenticated: true }],
    [401, { authenticated: false, subject: "must-not-be-consumed" }],
  ] as const) {
    transport(() => Response.json(payload, { status }));
    await expect(client().sharedAuthSession()).rejects.toMatchObject({ code: "invalid_response" });
  }
});

test("shared-auth logout uses only its cookie endpoint and accepts only 204", async () => {
  const seen = transport(() => new Response(null, { status: 204 }));
  await client().sharedAuthSignOut();
  expect(new URL(seen[0]?.url ?? origin).pathname).toBe("/auth/oidc/logout");
  expect(new URL(seen[0]?.url ?? origin).search).toBe("");
  expect(seen[0]?.method).toBe("POST");
  expect(seen[0]?.credentials).toBe("include");
  expect(seen[0]?.headers.has("authorization")).toBe(false);

  transport(() => Response.json({ error: { code: "session_unavailable" } }, { status: 503 }));
  await expect(client().sharedAuthSignOut()).rejects.toMatchObject({
    code: "session_unavailable",
    status: 503,
  });
});

test("Hosted continuation metadata is closed, cookie-only, no-store, and selector-bound", async () => {
  const selector = "a".repeat(64);
  const envelope = {
    continuation: {
      contractVersion: "hosted-browser-v1",
      continuationRef: selector,
      kind: "payment",
      workspaceId: "workspace-17",
      workspaceRef: "wbr_opaque-17",
      organizationId: "org-17",
      operation: {
        action: "topup",
        method: "POST",
        path: "/v1/organizations/org-17/wallet/checkout",
        body: { reference: "topup-ref-17", amountMinor: 4200 },
      },
      phase: "prepared",
    },
  };
  const seen = transport(() => Response.json(envelope));
  expect(await client().hostedBillingContinuation(selector)).toEqual({
    continuationRef: selector,
    kind: "payment",
    workspaceId: "workspace-17",
    workspaceRef: "wbr_opaque-17",
    organizationId: "org-17",
    operation: {
      action: "topup",
      method: "POST",
      path: "/v1/organizations/org-17/wallet/checkout",
      body: { reference: "topup-ref-17", amountMinor: 4200 },
    },
    phase: "prepared",
  });
  expect(new URL(seen[0]?.url ?? origin).pathname).toBe(
    `/v1/billing/hosted-continuations/${selector}`,
  );
  expect(seen[0]?.method).toBe("GET");
  expect(seen[0]?.credentials).toBe("include");
  expect(seen[0]?.cache).toBe("no-store");
  expect(seen[0]?.headers.has("authorization")).toBe(false);

  for (const invalid of [
    { continuation: { ...envelope.continuation, extra: true } },
    { continuation: { ...envelope.continuation, continuationRef: "b".repeat(64) } },
    { continuation: { ...envelope.continuation, phase: null } },
    { continuation: { ...envelope.continuation, phase: ["prepared"] } },
    { continuation: { ...envelope.continuation, phase: { value: "prepared" } } },
    { continuation: { ...envelope.continuation, phase: 17 } },
    {
      continuation: {
        ...envelope.continuation,
        operation: { ...envelope.continuation.operation, method: "GET" },
      },
    },
    {
      continuation: {
        ...envelope.continuation,
        operation: {
          ...envelope.continuation.operation,
          body: { ...envelope.continuation.operation.body, extra: true },
        },
      },
    },
    { continuation: { ...envelope.continuation, phase: "unknown" } },
  ]) {
    transport(() => Response.json(invalid));
    await expect(client().hostedBillingContinuation(selector)).rejects.toMatchObject({
      code: "invalid_response",
      status: 200,
    });
  }
  await expect(client().hostedBillingContinuation(`${selector}\n`)).rejects.toMatchObject({
    code: "invalid_request",
    status: 0,
  });
});

test("Hosted continuation preparation posts only the four closed explicit choices and accepts matching prepared metadata", async () => {
  const selector = "a".repeat(64);
  const choices = [
    {
      kind: "topup",
      amountMinor: 4200,
      checkoutConsent: "interactive-checkout",
    },
    { kind: "start", planKey: "pro-tier", consent: "subscription-checkout" },
    { kind: "cancel", consent: "cancel-subscription" },
    { kind: "change-plan", planKey: "team-next", consent: "change-subscription-plan" },
  ] as const;
  const operations = [
    {
      action: "topup",
      method: "POST",
      path: "/v1/organizations/org-17/wallet/checkout",
      body: { reference: "topup-ref-17", amountMinor: 4200 },
    },
    {
      action: "subscription-start",
      method: "POST",
      path: "/v1/organizations/org-17/payments/subscription",
      body: { reference: "start-ref-17", planKey: "pro-tier" },
    },
    {
      action: "cancel",
      method: "PATCH",
      path: "/v1/organizations/org-17/payments/subscription",
      body: {
        reference: "cancel-ref-17",
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: `sra_${"b".repeat(64)}`,
      },
    },
    {
      action: "plan-change",
      method: "PATCH",
      path: "/v1/organizations/org-17/payments/subscription",
      body: {
        reference: "change-ref-17",
        planKey: "team-next",
        expectedSubscriptionRef: `sra_${"c".repeat(64)}`,
      },
    },
  ] as const;

  for (const [index, choice] of choices.entries()) {
    const seen = transport(() =>
      Response.json({
        continuation: {
          contractVersion: "hosted-browser-v1",
          continuationRef: selector,
          kind: "payment",
          workspaceId: "workspace-17",
          workspaceRef: "wbr_opaque-17",
          organizationId: "org-17",
          operation: operations[index],
          phase: "prepared",
        },
      }),
    );
    expect(await client().prepareHostedBillingContinuation(selector, choice)).toMatchObject({
      continuationRef: selector,
      kind: "payment",
      phase: "prepared",
      operation: { action: operations[index]?.action },
    });
    expect(new URL(seen[0]?.url ?? origin).pathname).toBe(
      `/v1/billing/hosted-continuations/${selector}`,
    );
    expect(new URL(seen[0]?.url ?? origin).search).toBe("");
    expect(seen[0]?.method).toBe("POST");
    expect(seen[0]?.credentials).toBe("include");
    expect(seen[0]?.cache).toBe("no-store");
    expect(seen[0]?.headers.has("authorization")).toBe(false);
    expect(await seen[0]?.json()).toEqual(choice);
    expect(seen).toHaveLength(1);
  }

  const startWithReconciliationChoice = {
    kind: "start",
    planKey: "pro-tier",
    consent: "subscription-checkout",
    reconcileOriginalConsent: "check-original-subscription",
  } as const;
  const reconcileSeen = transport(() =>
    Response.json({
      continuation: {
        contractVersion: "hosted-browser-v1",
        continuationRef: selector,
        kind: "payment",
        workspaceId: "workspace-17",
        workspaceRef: "wbr_opaque-17",
        organizationId: "org-17",
        operation: operations[1],
        phase: "prepared",
      },
    }),
  );
  await client().prepareHostedBillingContinuation(selector, startWithReconciliationChoice);
  expect(await reconcileSeen[0]?.json()).toEqual(startWithReconciliationChoice);
  expect(reconcileSeen).toHaveLength(1);
});

test("Hosted continuation preparation refuses malformed or scoped choices before fetch", async () => {
  const selector = "b".repeat(64);
  const seen = transport(() => Response.json({}));
  const api = client();
  const invalidChoices: unknown[] = [
    { kind: "topup", amountMinor: 0, checkoutConsent: "interactive-checkout" },
    { kind: "topup", amountMinor: 4200, checkoutConsent: "other" },
    { kind: "topup", amountMinor: 4200, checkoutConsent: "interactive-checkout", orgId: "org-17" },
    Object.assign(Object.create({ kind: "topup" }), {
      amountMinor: 4200,
      checkoutConsent: "interactive-checkout",
      unexpected: true,
    }),
    {
      kind: "topup",
      amountMinor: 4200,
      checkoutConsent: "interactive-checkout",
      accountId: "account-17",
      workspaceId: "workspace-17",
      organizationId: "org-17",
      target: "subscription-target",
      reference: "client-reference",
      commandKey: "client-command-key",
    },
    { kind: "start", planKey: "bad/key", consent: "subscription-checkout" },
    { kind: "start", planKey: "pro", consent: "subscription-checkout", reference: "client-ref" },
    {
      kind: "start",
      planKey: "pro",
      consent: "subscription-checkout",
      reconcileOriginalConsent: "new-reference",
    },
    { kind: "cancel", consent: "cancel-subscription", workspaceId: "workspace-17" },
    { kind: "change-plan", planKey: "pro", consent: "cancel-subscription" },
    { kind: "unknown", consent: "subscription-checkout" },
    null,
  ];
  for (const choice of invalidChoices) {
    await expect(
      api.prepareHostedBillingContinuation(selector, choice as never),
    ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
  }
  await expect(
    api.prepareHostedBillingContinuation(`${selector}\n`, {
      kind: "cancel",
      consent: "cancel-subscription",
    }),
  ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
  expect(seen).toHaveLength(0);
});

test("Hosted continuation preparation only accepts the same selector's matching prepared payment response", async () => {
  const selector = "c".repeat(64);
  const choice = {
    kind: "topup",
    amountMinor: 4200,
    checkoutConsent: "interactive-checkout",
  } as const;
  const base = {
    contractVersion: "hosted-browser-v1",
    continuationRef: selector,
    kind: "payment",
    workspaceId: "workspace-17",
    workspaceRef: "wbr_opaque-17",
    organizationId: "org-17",
    operation: {
      action: "topup",
      method: "POST",
      path: "/v1/organizations/org-17/wallet/checkout",
      body: { reference: "topup-ref-17", amountMinor: 4200 },
    },
    phase: "prepared",
  };
  const invalidResponses = [
    { continuation: { ...base, kind: "view", operation: null, phase: null } },
    { continuation: { ...base, phase: "dispatch-started" } },
    { continuation: { ...base, continuationRef: "d".repeat(64) } },
    {
      continuation: {
        ...base,
        operation: { ...base.operation, body: { reference: "topup-ref-17", amountMinor: 4201 } },
      },
    },
    {
      continuation: {
        ...base,
        operation: {
          action: "subscription-start",
          method: "POST",
          path: "/v1/organizations/org-17/payments/subscription",
          body: { reference: "start-ref-17", planKey: "pro" },
        },
      },
    },
  ];
  for (const payload of invalidResponses) {
    transport(() => Response.json(payload));
    await expect(client().prepareHostedBillingContinuation(selector, choice)).rejects.toMatchObject(
      {
        code: "invalid_response",
        status: 200,
      },
    );
  }
});

test("Hosted continuation preparation never retries an unknown network result", async () => {
  let calls = 0;
  globalThis.fetch = Object.assign(
    async () => {
      calls += 1;
      throw new TypeError("connection lost");
    },
    { preconnect: originalFetch.preconnect },
  );
  await expect(
    client().prepareHostedBillingContinuation("e".repeat(64), {
      kind: "cancel",
      consent: "cancel-subscription",
    }),
  ).rejects.toMatchObject({ code: "unreachable", status: 0 });
  expect(calls).toBe(1);
});

function preparedHostedResponse(selector: string, action: string, path: string, body: unknown) {
  return Response.json({
    continuation: {
      contractVersion: "hosted-browser-v1",
      continuationRef: selector,
      kind: "payment",
      workspaceId: "workspace-17",
      workspaceRef: "wbr_opaque-17",
      organizationId: "org-17",
      operation: {
        action,
        method: action === "topup" || action === "subscription-start" ? "POST" : "PATCH",
        path,
        body,
      },
      phase: "prepared",
    },
  });
}

test("Hosted continuation preparation rejects hidden toJSON without invoking it", async () => {
  const selector = "f".repeat(64);
  let toJsonCalls = 0;
  const withHiddenToJson = {
    kind: "topup",
    amountMinor: 4200,
    checkoutConsent: "interactive-checkout",
  };
  Object.defineProperty(withHiddenToJson, "toJSON", {
    value: () => {
      toJsonCalls += 1;
      return { kind: "cancel", consent: "cancel-subscription" };
    },
  });
  const hiddenMethodSeen = transport(() =>
    preparedHostedResponse(selector, "topup", "/v1/organizations/org-17/wallet/checkout", {
      reference: "topup-ref-17",
      amountMinor: 4200,
    }),
  );
  await expect(
    client().prepareHostedBillingContinuation(selector, withHiddenToJson as never),
  ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
  expect(hiddenMethodSeen).toHaveLength(0);
  expect(toJsonCalls).toBe(0);
});

test("Hosted continuation preparation snapshots a getter value once for body and response matching", async () => {
  const selector = "f".repeat(64);
  let amount = 4200;
  let amountReads = 0;
  const topupChoice = {
    kind: "topup" as const,
    get amountMinor() {
      amountReads += 1;
      return amountReads === 1 ? amount : amount + 1;
    },
    checkoutConsent: "interactive-checkout" as const,
  };
  const topupSeen = transport(() => {
    amount = 9000;
    return preparedHostedResponse(selector, "topup", "/v1/organizations/org-17/wallet/checkout", {
      reference: "topup-ref-17",
      amountMinor: 4200,
    });
  });
  await client().prepareHostedBillingContinuation(selector, topupChoice);
  expect(amountReads).toBe(1);
  expect(await topupSeen[0]?.json()).toEqual({
    kind: "topup",
    amountMinor: 4200,
    checkoutConsent: "interactive-checkout",
  });
});

test("Hosted continuation preparation does not reread original plan choice after sending", async () => {
  const selector = "f".repeat(64);
  const startChoice = {
    kind: "start" as const,
    planKey: "pro-tier",
    consent: "subscription-checkout" as const,
  };
  const startSeen = transport(() => {
    startChoice.planKey = "mutated-after-send";
    return preparedHostedResponse(
      selector,
      "subscription-start",
      "/v1/organizations/org-17/payments/subscription",
      { reference: "start-ref-17", planKey: "pro-tier" },
    );
  });
  await client().prepareHostedBillingContinuation(selector, startChoice);
  expect(await startSeen[0]?.json()).toEqual({
    kind: "start",
    planKey: "pro-tier",
    consent: "subscription-checkout",
  });
});

test("Hosted continuation accepts only action-specific concrete paths for its selected Organization", async () => {
  const selector = "a".repeat(64);
  const base = {
    contractVersion: "hosted-browser-v1",
    continuationRef: selector,
    kind: "payment",
    workspaceId: "workspace-17",
    workspaceRef: "wbr_opaque-17",
    organizationId: "org:17",
    phase: "prepared",
  };
  const operations = [
    {
      action: "topup",
      method: "POST",
      path: "/v1/organizations/org:17/wallet/checkout",
      body: { reference: "topup-ref-17", amountMinor: 4200 },
    },
    {
      action: "subscription-start",
      method: "POST",
      path: "/v1/organizations/org:17/payments/subscription",
      body: { reference: "subscription-ref-17", planKey: "pro" },
    },
    {
      action: "cancel",
      method: "PATCH",
      path: "/v1/organizations/org:17/payments/subscription",
      body: {
        reference: "cancel-ref-17",
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: `sra_${"b".repeat(64)}`,
      },
    },
    {
      action: "plan-change",
      method: "PATCH",
      path: "/v1/organizations/org:17/payments/subscription",
      body: {
        reference: "plan-change-ref-17",
        planKey: "pro",
        expectedSubscriptionRef: `sra_${"c".repeat(64)}`,
      },
    },
  ] as const;

  for (const operation of operations) {
    transport(() => Response.json({ continuation: { ...base, operation } }));
    const result = await client().hostedBillingContinuation(selector);
    expect(result.kind).toBe("payment");
    if (result.kind === "payment") expect(result.operation).toEqual(operation);
  }

  const operation = operations[0];
  for (const path of [
    "/v1/organizations/other-org/wallet/checkout",
    "/v1/organizations/org:17/payments/subscription",
    "https://api.example.test/v1/organizations/org:17/wallet/checkout",
    "/v1/organizations/org:17/wallet/checkout?next=/",
    "/v1/organizations/org:17/wallet/checkout\n",
    "/v1/organizations/{organizationId}/wallet/checkout",
  ]) {
    transport(() =>
      Response.json({ continuation: { ...base, operation: { ...operation, path } } }),
    );
    await expect(client().hostedBillingContinuation(selector)).rejects.toMatchObject({
      code: "invalid_response",
      status: 200,
    });
  }
});

test("Hosted continuation effects keep existing route and exact body while using selector header and cookie only", async () => {
  const selector = "b".repeat(64);
  const seen = transport(() =>
    Response.json({ checkout: { url: "https://checkout.stripe.com/c/pay/test" } }, { status: 201 }),
  );
  expect(await client().beginTopUp("org:17", "topup-ref-17", 4200, selector)).toEqual({
    checkout: { url: "https://checkout.stripe.com/c/pay/test" },
  });
  expect(new URL(seen[0]?.url ?? origin).pathname).toBe("/v1/organizations/org:17/wallet/checkout");
  expect(seen[0]?.method).toBe("POST");
  expect(seen[0]?.credentials).toBe("include");
  expect(seen[0]?.headers.get("Takoserver-Billing-Continuation")).toBe(
    `hosted-browser-v1.${selector}`,
  );
  expect(seen[0]?.headers.has("authorization")).toBe(false);
  expect(await seen[0]?.json()).toEqual({ reference: "topup-ref-17", amountMinor: 4200 });
});

test("Hosted continuation effects use raw canonical Organization segments for all four actions", async () => {
  const selector = "e".repeat(64);
  const target = `sra_${"f".repeat(64)}`;
  const expectedPath = "/v1/organizations/org:17/payments/subscription";

  const topup = transport(() =>
    Response.json({ checkout: { url: "https://checkout.stripe.com/c/pay/test" } }, { status: 201 }),
  );
  await client().beginTopUp("org:17", "topup-ref-17", 4200, selector);
  expect(new URL(topup[0]?.url ?? origin).pathname).toBe(
    "/v1/organizations/org:17/wallet/checkout",
  );

  const subscription = transport(() =>
    Response.json(
      {
        checkout: {
          state: "open",
          id: "cs_test_console_1",
          url: "https://checkout.stripe.com/c/pay/test",
        },
      },
      { status: 201 },
    ),
  );
  await client().beginSubscription("org:17", "subscription-ref-17", "pro", selector);
  expect(new URL(subscription[0]?.url ?? origin).pathname).toBe(expectedPath);

  const cancellation = transport(() =>
    Response.json(
      {
        cancellation: {
          state: "verified",
          subscriptionRef: target,
          effectiveAt: "2026-11-01T00:00:00.000Z",
        },
      },
      { status: 200 },
    ),
  );
  await client().cancelSubscription("org:17", "cancel-ref-17", target, selector);
  expect(new URL(cancellation[0]?.url ?? origin).pathname).toBe(expectedPath);

  const planChange = transport(() =>
    Response.json(
      {
        planChange: {
          state: "pending",
          subscriptionRef: target,
        },
      },
      { status: 202 },
    ),
  );
  await client().changeSubscriptionPlan("org:17", "plan-ref-17", "pro", target, selector);
  expect(new URL(planChange[0]?.url ?? origin).pathname).toBe(expectedPath);
});

test("Hosted continuation effects reject Organization IDs outside the server segment contract before fetch", async () => {
  const selector = "f".repeat(64);
  const target = `sra_${"a".repeat(64)}`;
  const seen = transport(() => Response.json({}));
  const api = client();

  await expect(api.beginTopUp("org/slash", "topup-ref-17", 4200, selector)).rejects.toMatchObject({
    code: "invalid_request",
    status: 0,
  });
  await expect(
    api.beginSubscription("org%2Fslash", "subscription-ref-17", "pro", selector),
  ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
  await expect(
    api.cancelSubscription("org?query", "cancel-ref-17", target, selector),
  ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
  await expect(
    api.changeSubscriptionPlan("org#fragment", "plan-ref-17", "pro", target, selector),
  ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
  expect(seen).toHaveLength(0);
});

test("Hosted plan change confirmation uses only its closed existing PATCH body and receipt", async () => {
  const selector = "c".repeat(64);
  const target = `sra_${"d".repeat(64)}`;
  const seen = transport(() =>
    Response.json(
      {
        planChange: {
          state: "verified",
          subscriptionRef: target,
          pendingChange: {
            planKey: "team-next",
            pricingRevision: "rev_2026-10",
            effectiveAt: "2026-11-01T00:00:00.000Z",
          },
        },
      },
      { status: 200 },
    ),
  );
  expect(
    await client().changeSubscriptionPlan("org-17", "plan-ref-17", "team-next", target, selector),
  ).toEqual({
    state: "verified",
    subscriptionRef: target,
    pendingChange: {
      planKey: "team-next",
      pricingRevision: "rev_2026-10",
      effectiveAt: "2026-11-01T00:00:00.000Z",
    },
  });
  expect(seen[0]?.method).toBe("PATCH");
  expect(seen[0]?.credentials).toBe("include");
  expect(seen[0]?.headers.get("Takoserver-Billing-Continuation")).toBe(
    `hosted-browser-v1.${selector}`,
  );
  expect(seen[0]?.headers.has("authorization")).toBe(false);
  expect(await seen[0]?.json()).toEqual({
    reference: "plan-ref-17",
    planKey: "team-next",
    expectedSubscriptionRef: target,
  });
});

test("Hosted-only plan-change method refuses a missing or malformed selector before fetch", async () => {
  const seen = transport(() => Response.json({}));
  const api = client();
  await expect(
    api.changeSubscriptionPlan(
      "org-17",
      "plan-ref-17",
      "team-next",
      `sra_${"d".repeat(64)}`,
      undefined as unknown as string,
    ),
  ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
  await expect(
    api.changeSubscriptionPlan(
      "org-17",
      "plan-ref-17",
      "team-next",
      `sra_${"d".repeat(64)}`,
      `${"c".repeat(64)}\n`,
    ),
  ).rejects.toMatchObject({ code: "invalid_request", status: 0 });
  expect(seen).toHaveLength(0);
});

test("usage summary refuses unknown, foreign or invalid units and utilization instead of showing zero", async () => {
  const valid = {
    organizationId: org,
    currency: "USD",
    unit: "USD-micros",
    effectiveIncludedMicros: "1500000",
    utilizationBasisPoints: 8000,
  };
  for (const change of [
    { organizationId: "foreign-org" },
    { currency: "JPY" },
    { unit: "USD-cents" },
    { effectiveIncludedMicros: 1500000 },
    { effectiveIncludedMicros: "9007199254740992" },
    { effectiveIncludedMicros: "0" },
    { utilizationBasisPoints: undefined },
    { utilizationBasisPoints: null },
    { utilizationBasisPoints: "8000" },
    { utilizationBasisPoints: -1 },
    { utilizationBasisPoints: 10001 },
    { utilizationBasisPoints: 8000.5 },
  ]) {
    transport(() => Response.json({ usageSummary: { ...valid, ...change } }));
    await expect(client().usageSummary(org)).rejects.toMatchObject({ code: "invalid_response" });
  }
  transport(() => Response.json({}));
  await expect(client().usageSummary(org)).rejects.toMatchObject({ code: "invalid_response" });
  transport(() => Response.json({ error: { code: "billing_unavailable" } }, { status: 503 }));
  await expect(client().usageSummary(org)).rejects.toMatchObject({
    code: "billing_unavailable",
    status: 503,
  });
  let sessionLost = false;
  transport(() => Response.json({ error: { code: "unauthenticated" } }, { status: 401 }));
  await expect(client(() => (sessionLost = true)).usageSummary(org)).rejects.toMatchObject({
    code: "unauthenticated",
  });
  expect(sessionLost).toBe(true);
});

function workspaceUsagePage(change: Record<string, unknown> = {}) {
  return {
    organizationId: org,
    snapshotAt: "2026-10-15T00:00:00.000Z",
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    unit: "USD-micros",
    totalsScope: "organization",
    totals: { usedMicros: "12000", heldMicros: "8000", pendingMicros: "1000" },
    usageSummary: {
      organizationId: org,
      currency: "USD",
      unit: "USD-micros",
      periodKind: "free",
      periodStart: "2026-10-01T00:00:00.000Z",
      periodEnd: "2026-11-01T00:00:00.000Z",
      usedMicros: "9000",
      effectiveIncludedMicros: "1500000",
    },
    workspaces: [
      { workspaceRef: "ws_a", usedMicros: "6000", heldMicros: "8000", pendingMicros: "0" },
      { workspaceRef: "ws_b", usedMicros: "4000", heldMicros: "0", pendingMicros: "1000" },
    ],
    unattributed: { usedMicros: "2000", heldMicros: "0", pendingMicros: "0" },
    cursor: "eyJhZnRlciI6IndzX2IifQ",
    ...change,
  };
}

test("Workspace usage decodes exact micros strings, snapshot identity and an opaque cursor", async () => {
  const seen = transport(() => Response.json(workspaceUsagePage()));
  const page = await client().workspaceUsage(org);
  expect(page).toEqual({
    organizationId: org,
    snapshotAt: "2026-10-15T00:00:00.000Z",
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    unit: "USD-micros",
    totalsScope: "organization",
    totals: { usedMicros: "12000", heldMicros: "8000", pendingMicros: "1000" },
    unattributed: { usedMicros: "2000", heldMicros: "0", pendingMicros: "0" },
    workspaces: [
      { workspaceRef: "ws_a", usedMicros: "6000", heldMicros: "8000", pendingMicros: "0" },
      { workspaceRef: "ws_b", usedMicros: "4000", heldMicros: "0", pendingMicros: "1000" },
    ],
    cursor: "eyJhZnRlciI6IndzX2IifQ",
  });
  const first = new URL(seen[0]?.url ?? origin);
  expect(first.pathname).toBe(
    "/v1/organizations/org%2Fexample%3Fx%3D1%23%25/wallet/usage-summary/workspaces",
  );
  expect(first.search).toBe("");
  expect(seen[0]?.method).toBe("GET");
  expect(seen[0]?.credentials).toBe("include");
  expect(seen[0]?.headers.get("authorization")).toBe("Bearer session");

  const continued = transport(() =>
    Response.json(workspaceUsagePage({ workspaces: [], cursor: null })),
  );
  expect(
    (await client().workspaceUsage(org, { cursor: "eyJhZnRlciI6IndzX2IifQ", limit: 25 })).cursor,
  ).toBeNull();
  const next = new URL(continued[0]?.url ?? origin);
  expect([...next.searchParams.entries()]).toEqual([
    ["limit", "25"],
    ["cursor", "eyJhZnRlciI6IndzX2IifQ"],
  ]);
});

test("Workspace usage refuses foreign, malformed or inconsistent pages instead of showing them", async () => {
  const workspace = (change: Record<string, unknown>) => ({
    workspaces: [
      {
        workspaceRef: "ws_a",
        usedMicros: "6000",
        heldMicros: "8000",
        pendingMicros: "0",
        ...change,
      },
    ],
  });
  for (const change of [
    { organizationId: "foreign-org" },
    { unit: "USD-cents" },
    { totalsScope: "page" },
    { snapshotAt: "2026-10-15T00:00:00Z" },
    { snapshotAt: "2026-11-02T00:00:00.000Z" },
    { periodEnd: "2026-10-01T00:00:00.000Z" },
    { extra: true },
    { usageSummary: undefined },
    { usageSummary: { ...workspaceUsagePage().usageSummary, organizationId: "foreign-org" } },
    { usageSummary: { ...workspaceUsagePage().usageSummary, currency: "JPY" } },
    {
      usageSummary: {
        ...workspaceUsagePage().usageSummary,
        periodStart: "2026-09-01T00:00:00.000Z",
      },
    },
    { cursor: "" },
    { cursor: 7 },
    { cursor: "has space" },
    { cursor: "a".repeat(1025) },
    { cursor: "next", workspaces: [] },
    { totals: { usedMicros: 12000, heldMicros: "8000", pendingMicros: "1000" } },
    { totals: { usedMicros: "12000", heldMicros: "8000" } },
    { totals: { usedMicros: "12000", heldMicros: "8000", pendingMicros: "1000", extra: "0" } },
    { totals: { usedMicros: "-1", heldMicros: "8000", pendingMicros: "1000" } },
    { totals: { usedMicros: "9007199254740992", heldMicros: "0", pendingMicros: "0" } },
    { totals: { usedMicros: "9007199254740991", heldMicros: "1", pendingMicros: "0" } },
    { totals: { usedMicros: "11999", heldMicros: "8000", pendingMicros: "1000" } },
    { unattributed: null },
    { unattributed: { usedMicros: "2001", heldMicros: "0", pendingMicros: "0" } },
    { workspaces: null },
    workspace({ workspaceRef: "bad/ref" }),
    workspace({ workspaceRef: "" }),
    workspace({ usedMicros: "06000" }),
    workspace({ pendingMicros: undefined }),
    workspace({ name: "Workspace A" }),
    {
      workspaces: [
        { workspaceRef: "ws_b", usedMicros: "0", heldMicros: "0", pendingMicros: "0" },
        { workspaceRef: "ws_a", usedMicros: "0", heldMicros: "0", pendingMicros: "0" },
      ],
    },
    {
      workspaces: [
        { workspaceRef: "ws_a", usedMicros: "0", heldMicros: "0", pendingMicros: "0" },
        { workspaceRef: "ws_a", usedMicros: "0", heldMicros: "0", pendingMicros: "0" },
      ],
    },
  ]) {
    transport(() => Response.json(workspaceUsagePage(change)));
    await expect(client().workspaceUsage(org)).rejects.toMatchObject({ code: "invalid_response" });
  }
  transport(() => Response.json(workspaceUsagePage()));
  await expect(client().workspaceUsage(org, { limit: 1 })).rejects.toMatchObject({
    code: "invalid_response",
  });
  transport(() => Response.json(workspaceUsagePage(), { status: 202 }));
  await expect(client().workspaceUsage(org)).rejects.toMatchObject({ code: "invalid_response" });
  transport(() => Response.json([]));
  await expect(client().workspaceUsage(org)).rejects.toMatchObject({ code: "invalid_response" });

  let sent = 0;
  transport(() => {
    sent += 1;
    return Response.json(workspaceUsagePage());
  });
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: "" }])
    await expect(client().workspaceUsage(org, query)).rejects.toMatchObject({
      code: "invalid_request",
    });
  expect(sent).toBe(0);

  transport(() => Response.json({ error: { code: "expired", retryable: false } }, { status: 409 }));
  await expect(client().workspaceUsage(org, { cursor: "old" })).rejects.toMatchObject({
    code: "expired",
    status: 409,
  });
  transport(() => Response.json({ error: { code: "not_found" } }, { status: 404 }));
  await expect(client().workspaceUsage(org)).rejects.toMatchObject({
    code: "not_found",
    status: 404,
  });
  let sessionLost = false;
  transport(() => Response.json({ error: { code: "unauthenticated" } }, { status: 401 }));
  await expect(client(() => (sessionLost = true)).workspaceUsage(org)).rejects.toMatchObject({
    code: "unauthenticated",
  });
  expect(sessionLost).toBe(true);
});

test("wallet micros decode as canonical bounded USD strings and display exact fractions", async () => {
  const wallet = {
    organizationId: org,
    currency: "USD",
    settledMicros: "1234000001",
    heldMicros: "1",
    availableMicros: "1234000000",
    entries: [
      {
        id: "entry-one",
        organizationId: org,
        type: "capture",
        reference: "hold-one",
        settledDeltaMicros: "-10001",
        heldDeltaMicros: "0",
        createdAt: "2026-10-14T00:00:00.000Z",
      },
    ],
  };
  const seen = transport(() => Response.json({ wallet }));
  expect(await client().wallet(org)).toEqual({ wallet });
  expect(new URL(seen[0]?.url ?? origin).pathname).toBe(
    "/v1/organizations/org%2Fexample%3Fx%3D1%23%25/wallet",
  );
  expect(formatMicrosCurrency("1234000001", "USD", "en-US")).toBe("$1,234.000001");
  expect(formatMicrosCurrency("10000", "USD", "en-US")).toBe("$0.01");
  expect(formatMicrosCurrency("1", "USD", "en-US")).toBe("$0.000001");
  expect(formatMicrosCurrency("-10001", "USD", "en-US")).toBe("-$0.010001");
});

test("wallet rejects numeric, unsafe or nonconserving money responses", async () => {
  transport(() =>
    Response.json({
      wallet: {
        organizationId: org,
        currency: "USD",
        settledMicros: 10000,
        heldMicros: "0",
        availableMicros: "10000",
        entries: [],
      },
    }),
  );
  await expect(client().wallet(org)).rejects.toMatchObject({ code: "invalid_response" });
  transport(() =>
    Response.json({
      wallet: {
        organizationId: org,
        currency: "USD",
        settledMicros: "9007199254740992",
        heldMicros: "0",
        availableMicros: "9007199254740992",
        entries: [],
      },
    }),
  );
  await expect(client().wallet(org)).rejects.toMatchObject({ code: "invalid_response" });
  transport(() =>
    Response.json({
      wallet: {
        organizationId: org,
        currency: "USD",
        settledMicros: "10000",
        heldMicros: "0",
        availableMicros: "9999",
        entries: [],
      },
    }),
  );
  await expect(client().wallet(org)).rejects.toMatchObject({ code: "invalid_response" });
});

test("Hosted selection wallet uses a raw finite Org segment, shared cookie, and no bearer token", async () => {
  const organizationId = "org:17";
  const wallet = {
    organizationId,
    currency: "USD",
    settledMicros: "10000000",
    heldMicros: "0",
    availableMicros: "10000000",
    entries: [],
  };
  const seen = transport(() => Response.json({ wallet }));
  expect(await client().hostedBillingSelectionWallet(organizationId)).toEqual({ wallet });
  expect(new URL(seen[0]?.url ?? origin).pathname).toBe("/v1/organizations/org:17/wallet");
  expect(seen[0]?.method).toBe("GET");
  expect(seen[0]?.credentials).toBe("include");
  expect(seen[0]?.cache).toBe("no-store");
  expect(seen[0]?.headers.has("authorization")).toBe(false);

  const ordinary = transport(() => Response.json({ wallet }));
  await client().wallet(organizationId);
  expect(new URL(ordinary[0]?.url ?? origin).pathname).toBe("/v1/organizations/org%3A17/wallet");

  let sent = 0;
  transport(() => {
    sent += 1;
    return Response.json({ wallet });
  });
  for (const invalid of ["org/a", "org?17", "org#17", "org%17", "org:17\n"])
    await expect(client().hostedBillingSelectionWallet(invalid)).rejects.toMatchObject({
      code: "invalid_request",
    });
  expect(sent).toBe(0);
});

function client(onSessionLost: () => void = () => undefined) {
  return createApi({ origin, token: () => "session", onSessionLost });
}

function transport(handler: (request: Request) => Response | Promise<Response>): Request[] {
  const seen: Request[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push(request.clone());
      return handler(request);
    },
    { preconnect: originalFetch.preconnect },
  );
  return seen;
}

test("v2 create, read, update and delete keep exact UID, generation and caller key", async () => {
  const seen = transport((request) => {
    const path = new URL(request.url).pathname;
    if (
      request.method === "GET" &&
      path.endsWith(`/operations/${encodeURIComponent(operation.id)}`)
    )
      return Response.json({ ...operation, status: "succeeded", effect: "complete" });
    if (request.method === "GET") return Response.json(resource);
    return Response.json(
      {
        ...operation,
        action:
          request.method === "DELETE" ? "delete" : request.method === "PUT" ? "update" : "create",
        generation: request.method === "POST" ? 1 : 2,
      },
      { status: 202 },
    );
  });
  const api = client();
  expect(
    await api.createResource(
      org,
      { form, space: org, name: "one", spec: { value: 1 } },
      "console-create-0001",
    ),
  ).toMatchObject({ status: "queued", effect: "none" });
  expect(await api.resource(org, resource.uid)).toEqual(resource);
  expect(
    await api.updateResource(org, resource.uid, 1, { value: 2 }, "console-update-0001"),
  ).toMatchObject({ action: "update" });
  expect(await api.deleteResource(org, resource.uid, 1, "console-delete-0001")).toMatchObject({
    action: "delete",
  });
  expect(await api.resourceOperation(org, operation.id)).toMatchObject({
    status: "succeeded",
    effect: "complete",
  });
  expect(seen.map((request) => request.method)).toEqual(["POST", "GET", "PUT", "DELETE", "GET"]);
  expect(seen.every((request) => request.headers.get("takoform-organization") === org)).toBe(true);
  expect(seen[0]?.headers.get("idempotency-key")).toBe("console-create-0001");
  expect(seen[2]?.headers.get("takoform-expected-generation")).toBe("1");
  expect(seen[2]?.headers.get("idempotency-key")).toBe("console-update-0001");
  expect(seen[3]?.headers.get("idempotency-key")).toBe("console-delete-0001");
  expect(new URL(seen[1]?.url ?? origin).pathname).toBe(
    `/apis/forms.takoform.com/v2/resources/${encodeURIComponent(resource.uid)}`,
  );
  expect(
    seen.filter((request) => new URL(request.url).pathname.includes("/v1/resources")),
  ).toHaveLength(0);
});

test("v2 list keeps signed cursor opaque and filters to organization space", async () => {
  const seen = transport(() => Response.json({ items: [resource], nextCursor: "opaque+/&?%" }));
  expect(await client().resources(org, { cursor: "prior+/&?%" })).toEqual({
    resources: [resource],
    cursor: "opaque+/&?%",
  });
  const url = new URL(seen[0]?.url ?? origin);
  expect(url.pathname).toBe("/apis/forms.takoform.com/v2/resources");
  expect(url.searchParams.get("space")).toBe(org);
  expect(url.searchParams.get("cursor")).toBe("prior+/&?%");
});

test("v2 support checks only the exact operator-supplied Form URL", async () => {
  const seen = transport(() =>
    Response.json({ form, supported: true, operations: ["create"], privateInputs: false }),
  );
  expect(await client().formSupport(org, form)).toBe(true);
  expect(new URL(seen[0]?.url ?? origin).searchParams.get("form")).toBe(form);
  transport(() =>
    Response.json({ form, supported: true, operations: ["read"], privateInputs: false }),
  );
  expect(await client().formSupport(org, form)).toBe(false);
});

test("Host discovery supplies the replay window; absent limits cannot authorize retry", async () => {
  const seen = transport(() => Response.json({ limits: { replayWindowSeconds: 7200 } }));
  expect(await client().replayWindowSeconds()).toBe(7200);
  expect(new URL(seen[0]?.url ?? origin).pathname).toBe("/.well-known/takoform/v2");
  transport(() => Response.json({ limits: {} }));
  await expect(client().replayWindowSeconds()).rejects.toMatchObject({ code: "invalid_response" });
});

test("ambiguous ACK stays unknown; client does not replay the mutation", async () => {
  const seen = transport(() => {
    throw new Error("connection reset after send");
  });
  await expect(
    client().createResource(
      org,
      { form, space: org, name: "one", spec: {} },
      "console-create-0001",
    ),
  ).rejects.toMatchObject({ code: "unreachable", status: 0 });
  expect(seen).toHaveLength(1);
});

test("v2 problem codes and session loss are distinct from malformed success", async () => {
  let lost = 0;
  transport(() =>
    Response.json({ code: "unauthenticated", message: "no session" }, { status: 401 }),
  );
  await expect(
    client(() => {
      lost += 1;
    }).resources(org),
  ).rejects.toMatchObject({ code: "unauthenticated", status: 401 });
  expect(lost).toBe(1);
  transport(() => Response.json({ code: "generation_conflict" }, { status: 412 }));
  await expect(
    client().updateResource(org, resource.uid, 1, {}, "console-update-0001"),
  ).rejects.toMatchObject({ code: "generation_conflict", status: 412 });
  transport(() => Response.json({ id: operation.id }, { status: 202 }));
  await expect(
    client().createResource(
      org,
      { form, space: org, name: "one", spec: {} },
      "console-create-0001",
    ),
  ).rejects.toMatchObject({ code: "invalid_response", status: 202 });
  transport(() =>
    Response.json({ ...operation, status: "succeeded", effect: "unknown" }, { status: 200 }),
  );
  await expect(
    client().createResource(
      org,
      { form, space: org, name: "one", spec: {} },
      "console-create-0001",
    ),
  ).rejects.toMatchObject({ code: "invalid_response", status: 200 });
});

test("a shaped but wrong Operation is unknown ACK, never accepted as this mutation", async () => {
  transport(() => Response.json({ ...operation, action: "delete" }, { status: 202 }));
  await expect(
    client().createResource(
      org,
      { form, space: org, name: "one", spec: {} },
      "console-create-0001",
    ),
  ).rejects.toMatchObject({ code: "invalid_response", status: 202 });
  transport(() =>
    Response.json(
      { ...operation, action: "update", generation: 2, resourceUid: "other-uid" },
      { status: 202 },
    ),
  );
  await expect(
    client().updateResource(org, resource.uid, 1, {}, "console-update-0001"),
  ).rejects.toMatchObject({ code: "invalid_response", status: 202 });
  transport(() =>
    Response.json({ ...operation, action: "delete", generation: 3 }, { status: 202 }),
  );
  await expect(
    client().deleteResource(org, resource.uid, 1, "console-delete-0001"),
  ).rejects.toMatchObject({ code: "invalid_response", status: 202 });
});

const hostedPlanTable = {
  scope: "hosted",
  products: ["takosumi-hosted", "takoserver"],
  balanceScope: "organization",
  plans: [
    {
      planId: "free-configured",
      tier: "free",
      resourceScope: "edge",
      configuredMonthlyCreditMinor: 0,
      edgeAllowance: "pending-owner-runtime-policy",
    },
    {
      planId: "subscription-configured",
      tier: "subscription",
      monthlyAmountMinor: 1250,
      includedCreditMinor: 0,
      stripePriceId: "price_configured",
    },
    {
      planId: "usage-configured",
      tier: "usage",
      checkoutMinimumMinor: 500,
      checkoutMaximumMinor: 10000,
      meters: {},
    },
  ],
  consumptionOrder: ["free", "subscription", "purchased", "postpaid"],
} as const;

const subscription = {
  organizationId: org,
  subscriptionId: "sub_private_processor_id",
  subscriptionRef: `sra_${"a".repeat(64)}`,
  planKey: "subscription-configured",
  pricingRevision: "revision-1",
  status: "active",
  cancelAtPeriodEnd: false,
  periodStart: "2026-10-01T00:00:00.000Z",
  periodEnd: "2026-11-01T00:00:00.000Z",
  paidThrough: "2026-11-01T00:00:00.000Z",
  paidFeatures: true,
  updatedAt: "2026-10-01T00:00:00.000Z",
} as const;

test("canonical subscription read returns its plan table and organization projection", async () => {
  const seen = transport(() => Response.json({ subscription, planTable: hostedPlanTable }));
  expect(await client().subscription(org)).toEqual({
    subscription,
    planTable: hostedPlanTable,
  });
  expect(new URL(seen[0]?.url ?? origin).pathname).toBe(
    `/v1/organizations/${encodeURIComponent(org)}/payments/subscription`,
  );
  expect(seen[0]?.method).toBe("GET");
});

test("canonical subscription read accepts the finalized two-tier hosted plan table", async () => {
  const planTable = finalizedHostedPlanTable();
  expect(planTable.plans.map((plan) => plan.planId)).toEqual([
    "free",
    "hosted-10",
    "hosted-50",
    "usage",
  ]);
  expect(planTable.plans.filter((plan) => plan.tier === "subscription")).toMatchObject([
    { monthlyAmountMinor: 1000, includedCreditMinor: 2000 },
    { monthlyAmountMinor: 5000, includedCreditMinor: 10000 },
  ]);
  transport(() => Response.json({ subscription: null, planTable }));
  expect(await client().subscription(org)).toEqual({ subscription: null, planTable });
});

test("Hosted selection subscription read validates colon Org and remains cookie-only", async () => {
  const organizationId = "org:17";
  const planTable = finalizedHostedPlanTable();
  const capabilities = {
    contractVersion: "hosted-billing-v1",
    topUps: true,
    subscriptionStart: true,
    subscriptionCancellation: true,
    subscriptionPlanChange: true,
  };
  const seen = transport(() =>
    Response.json({ subscription: null, planTable, billingCapabilities: capabilities }),
  );
  expect(await client().hostedBillingSelectionSubscription(organizationId)).toEqual({
    subscription: null,
    planTable,
    billingCapabilities: capabilities,
  });
  expect(new URL(seen[0]?.url ?? origin).pathname).toBe(
    "/v1/organizations/org:17/payments/subscription",
  );
  expect(seen[0]?.method).toBe("GET");
  expect(seen[0]?.credentials).toBe("include");
  expect(seen[0]?.cache).toBe("no-store");
  expect(seen[0]?.headers.has("authorization")).toBe(false);

  const ordinary = transport(() => Response.json({ subscription: null, planTable }));
  await client().subscription(organizationId);
  expect(new URL(ordinary[0]?.url ?? origin).pathname).toBe(
    "/v1/organizations/org%3A17/payments/subscription",
  );

  let sent = 0;
  transport(() => {
    sent += 1;
    return Response.json({ subscription: null, planTable });
  });
  for (const invalid of ["org/a", "org?17", "org#17", "org%17", "org:17\n"])
    await expect(client().hostedBillingSelectionSubscription(invalid)).rejects.toMatchObject({
      code: "invalid_request",
    });
  expect(sent).toBe(0);
});

test("canonical subscription read validates every paid row and rejects extra tiers", async () => {
  const planTable = finalizedHostedPlanTable();
  const invalidRows = [
    {
      ...planTable,
      plans: [
        ...planTable.plans.slice(0, 2),
        { ...planTable.plans[2], stripePriceId: "bad" },
        planTable.plans[3],
      ],
    },
    {
      ...planTable,
      plans: [
        ...planTable.plans.slice(0, 2),
        { ...planTable.plans[2], planId: "hosted-10" },
        planTable.plans[3],
      ],
    },
    {
      ...planTable,
      plans: [
        planTable.plans[0],
        planTable.plans[1],
        planTable.plans[2],
        planTable.plans[2],
        planTable.plans[3],
      ],
    },
  ];
  for (const invalid of invalidRows) {
    transport(() => Response.json({ subscription: null, planTable: invalid }));
    await expect(client().subscription(org)).rejects.toMatchObject({ code: "invalid_response" });
  }
});

test("subscription Checkout uses the selected configured key and preserves status semantics", async () => {
  const seen = transport(() =>
    Response.json(
      {
        checkout: {
          state: "open",
          id: "cs_test_console_1",
          url: "https://checkout.stripe.com/c/pay/test",
        },
      },
      { status: 201 },
    ),
  );
  expect(
    await client().beginSubscription(org, "checkout-ref-1", "configured-subscription"),
  ).toEqual({
    status: 201,
    checkout: {
      state: "open",
      id: "cs_test_console_1",
      url: "https://checkout.stripe.com/c/pay/test",
    },
  });
  expect(new URL(seen[0]?.url ?? origin).pathname).toBe(
    "/v1/organizations/org%2Fexample%3Fx%3D1%23%25/payments/subscription",
  );
  expect(await seen[0]?.json()).toEqual({
    reference: "checkout-ref-1",
    planKey: "configured-subscription",
  });
});

test("pending, associated, and expired Checkout receipts are bound to their HTTP status", async () => {
  let next = Response.json(
    { checkout: { state: "pending", id: "sci_00000000-0000-4000-8000-000000000001" } },
    { status: 202 },
  );
  transport(() => next);
  expect(
    await client().beginSubscription(org, "checkout-ref-1", "configured-subscription"),
  ).toMatchObject({
    status: 202,
    checkout: { state: "pending" },
  });
  next = Response.json(
    {
      checkout: {
        state: "associated",
        id: "cs_test_console_1",
        subscriptionRef: subscription.subscriptionRef,
      },
    },
    { status: 200 },
  );
  expect(
    await client().beginSubscription(org, "checkout-ref-1", "configured-subscription"),
  ).toMatchObject({
    status: 200,
    checkout: { state: "associated" },
  });
  next = Response.json(
    { checkout: { state: "expired", id: "cs_test_console_1" } },
    { status: 200 },
  );
  expect(
    await client().beginSubscription(org, "checkout-ref-1", "configured-subscription"),
  ).toMatchObject({
    status: 200,
    checkout: { state: "expired" },
  });
});

test("cancellation sends the exact expected subscription target and accepts only matching receipts", async () => {
  const target = `sra_${"c".repeat(64)}`;
  const seen = transport(() =>
    Response.json(
      {
        cancellation: {
          state: "verified",
          subscriptionRef: target,
          effectiveAt: "2026-11-01T00:00:00.000Z",
        },
      },
      { status: 200 },
    ),
  );
  expect(await client().cancelSubscription(org, "cancel-ref-1", target)).toEqual({
    state: "verified",
    subscriptionRef: target,
    effectiveAt: "2026-11-01T00:00:00.000Z",
  });
  expect(await seen[0]?.json()).toEqual({
    reference: "cancel-ref-1",
    cancelAtPeriodEnd: true,
    expectedSubscriptionRef: target,
  });
});

test("subscription API refuses mismatched projections, payment status, and cancellation target", async () => {
  transport(() =>
    Response.json({
      subscription: { ...subscription, organizationId: "other-org" },
      planTable: hostedPlanTable,
    }),
  );
  await expect(client().subscription(org)).rejects.toMatchObject({ code: "invalid_response" });

  transport(() =>
    Response.json(
      { checkout: { state: "open", id: "cs_test_open", url: "https://checkout.stripe.com/pay/1" } },
      { status: 200 },
    ),
  );
  await expect(
    client().beginSubscription(org, "checkout-ref-1", "configured-subscription"),
  ).rejects.toMatchObject({ code: "invalid_response", status: 200 });

  transport(() =>
    Response.json(
      {
        checkout: {
          state: "open",
          id: "cs_test_open",
          url: "https://checkout.stripe.com:8443/pay/1",
        },
      },
      { status: 201 },
    ),
  );
  await expect(
    client().beginSubscription(org, "checkout-ref-1", "configured-subscription"),
  ).rejects.toMatchObject({ code: "invalid_response", status: 201 });

  transport(() =>
    Response.json(
      {
        cancellation: {
          state: "verified",
          subscriptionRef: `sra_${"d".repeat(64)}`,
          effectiveAt: "2026-11-01T00:00:00.000Z",
        },
      },
      { status: 200 },
    ),
  );
  await expect(
    client().cancelSubscription(org, "cancel-ref-1", `sra_${"c".repeat(64)}`),
  ).rejects.toMatchObject({ code: "invalid_response", status: 200 });
});

test("associated subscription Checkout requires a canonical persisted target reference", async () => {
  transport(() =>
    Response.json({ checkout: { state: "associated", id: "cs_test_console_1" } }, { status: 200 }),
  );
  await expect(
    client().beginSubscription(org, "checkout-ref-1", "configured-subscription"),
  ).rejects.toMatchObject({ code: "invalid_response", status: 200 });

  transport(() =>
    Response.json(
      {
        checkout: {
          state: "associated",
          id: "cs_test_console_1",
          subscriptionRef: `sra_${"A".repeat(64)}`,
        },
      },
      { status: 200 },
    ),
  );
  await expect(
    client().beginSubscription(org, "checkout-ref-1", "configured-subscription"),
  ).rejects.toMatchObject({ code: "invalid_response", status: 200 });
});
