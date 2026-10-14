import { afterEach, expect, test } from "bun:test";
import { createApi, formatMicrosCurrency } from "../console/src/api.ts";
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
