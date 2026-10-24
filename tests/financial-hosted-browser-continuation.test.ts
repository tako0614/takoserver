import { expect, test } from "bun:test";
import {
  assertHostedBrowserBillingBody,
  HostedBrowserContinuationError,
  hostedBrowserContinuationMetadata,
  parseHostedBrowserBillingChoice,
  parseHostedBrowserBillingOriginal,
  sameHostedBrowserBillingOriginal,
  toFinancialHostedBrowserRequestOriginal,
} from "../src/financial-hosted-browser-continuation.ts";
import {
  createHostedBrowserBillingRpcClient,
  createHostedBrowserLiveAuthorizationTarget,
  parseHostedBrowserBillingClaim,
  parseHostedBrowserBillingOutcome,
  parseHostedBrowserBillingPrepare,
  parseHostedBrowserBillingRead,
  sameHostedBrowserBillingAccepted,
} from "../src/financial-hosted-browser-rpc.ts";

const HEX = "a".repeat(64);
const scope = Object.freeze({
  continuationRef: HEX,
  canonicalAccountId: "account-a",
  workspaceId: "workspace-a",
  workspaceRef: "workspace-ref-a",
  organizationId: "org-a",
  billingSourceRef: "source-a",
  sourceEpoch: "epoch-a",
});
const topup = {
  contractVersion: "hosted-browser-v1",
  scope,
  action: {
    family: "topup",
    request: {
      workspaceId: scope.workspaceId,
      operationKey: "operation-a",
      amountMinor: 50,
      checkoutConsent: "interactive-checkout",
    },
    claim: {
      ownerId: "historical-owner-a",
      organizationId: scope.organizationId,
      billingSourceRef: scope.billingSourceRef,
      operationKey: "operation-a",
      reference: `takosumi:topup:${HEX}`,
      amountMinor: 50,
    },
  },
};
const start = {
  contractVersion: "hosted-browser-v1",
  scope,
  action: {
    family: "subscription",
    request: {
      workspaceId: scope.workspaceId,
      operationKey: "operation-b",
      planKey: "starter",
      consent: "subscription-checkout",
    },
    claim: {
      ownerId: "historical-owner-a",
      organizationId: scope.organizationId,
      billingSourceRef: scope.billingSourceRef,
      sourceEpoch: scope.sourceEpoch,
      kind: "start",
      operationKey: "operation-b",
      reference: `takosumi:subscription:${HEX}`,
      planKey: "starter",
    },
  },
};
const cancel = {
  contractVersion: "hosted-browser-v1",
  scope,
  action: {
    family: "subscription",
    request: {
      workspaceId: scope.workspaceId,
      operationKey: "operation-c",
      consent: "cancel-subscription",
    },
    claim: {
      ownerId: "historical-owner-a",
      organizationId: scope.organizationId,
      billingSourceRef: scope.billingSourceRef,
      sourceEpoch: scope.sourceEpoch,
      kind: "cancel",
      operationKey: "operation-c",
      reference: `takosumi:subscription:${HEX}`,
      expectedSubscriptionRef: `sra_${HEX}`,
    },
  },
};
const plan = {
  contractVersion: "hosted-browser-v1",
  scope,
  action: {
    family: "subscription",
    request: {
      workspaceId: scope.workspaceId,
      operationKey: "operation-d",
      planKey: "pro",
      consent: "change-subscription-plan",
    },
    claim: {
      ownerId: "historical-owner-a",
      organizationId: scope.organizationId,
      billingSourceRef: scope.billingSourceRef,
      sourceEpoch: scope.sourceEpoch,
      kind: "change-plan",
      operationKey: "operation-d",
      reference: `takosumi:subscription:${HEX}`,
      planKey: "pro",
      expectedSubscriptionRef: `sra_${HEX}`,
    },
  },
};

test("four Hosted original kinds map only to their exact existing Server body", () => {
  for (const [input, method, body, kind] of [
    [topup, "POST", { reference: topup.action.claim.reference, amountMinor: 50 }, "topup"],
    [
      start,
      "POST",
      { reference: start.action.claim.reference, planKey: "starter" },
      "subscription-start",
    ],
    [
      cancel,
      "PATCH",
      {
        reference: cancel.action.claim.reference,
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: `sra_${HEX}`,
      },
      "cancel",
    ],
    [
      plan,
      "PATCH",
      {
        reference: plan.action.claim.reference,
        planKey: "pro",
        expectedSubscriptionRef: `sra_${HEX}`,
      },
      "plan-change",
    ],
  ] as const) {
    const original = parseHostedBrowserBillingOriginal(input);
    expect(toFinancialHostedBrowserRequestOriginal(original).action.kind).toBe(kind);
    expect(assertHostedBrowserBillingBody(method, body, original).kind).toBe(kind);
    expect(sameHostedBrowserBillingOriginal(original, structuredClone(input))).toBe(true);
  }
});

test("full original rejects extra/accessor fields, source/account/scope/claim drift and newline suffix", () => {
  const original = parseHostedBrowserBillingOriginal(topup);
  for (const changed of [
    { ...topup, extra: true },
    { ...topup, scope: { ...scope, continuationRef: `${HEX}\n` } },
    {
      ...topup,
      scope: { ...scope, canonicalAccountId: "different-account" },
      action: {
        ...topup.action,
        claim: { ...topup.action.claim, billingSourceRef: "other-source" },
      },
    },
    {
      ...topup,
      action: { ...topup.action, request: { ...topup.action.request, amountMinor: 51 } },
    },
    {
      ...topup,
      action: {
        ...topup.action,
        claim: { ...topup.action.claim, reference: `${topup.action.claim.reference}\n` },
      },
    },
    {
      ...topup,
      action: { ...topup.action, claim: { ...topup.action.claim, organizationId: "other-org" } },
    },
  ]) {
    expect(sameHostedBrowserBillingOriginal(original, changed)).toBe(false);
  }
  const accessor = {
    ...topup,
    get action() {
      return topup.action;
    },
  };
  expect(() => parseHostedBrowserBillingOriginal(accessor)).toThrow(HostedBrowserContinuationError);
});

test("method, plan, amount, predecessor and surplus body fields cannot select a different effect", () => {
  const original = parseHostedBrowserBillingOriginal(topup);
  for (const [method, body] of [
    ["PATCH", { reference: topup.action.claim.reference, amountMinor: 50 }],
    ["POST", { reference: topup.action.claim.reference, amountMinor: 51 }],
    ["POST", { reference: topup.action.claim.reference, amountMinor: 50, extra: true }],
  ] as const) {
    expect(() => assertHostedBrowserBillingBody(method, body, original)).toThrow(
      HostedBrowserContinuationError,
    );
  }
  expect(() =>
    assertHostedBrowserBillingBody(
      "POST",
      { reference: start.action.claim.reference, planKey: "other" },
      parseHostedBrowserBillingOriginal(start),
    ),
  ).toThrow(HostedBrowserContinuationError);
  expect(() =>
    assertHostedBrowserBillingBody(
      "PATCH",
      {
        reference: cancel.action.claim.reference,
        cancelAtPeriodEnd: true,
        expectedSubscriptionRef: `sra_${"b".repeat(64)}`,
      },
      parseHostedBrowserBillingOriginal(cancel),
    ),
  ).toThrow(HostedBrowserContinuationError);
});

test("read, fresh claim and metadata require the complete matching original and accepted command", () => {
  const original = parseHostedBrowserBillingOriginal(topup);
  const lookup = {
    continuationRef: scope.continuationRef,
    canonicalAccountId: scope.canonicalAccountId,
  };
  const accepted = {
    family: "topup",
    command: {
      ...topup.action.claim,
      purpose: "usd-top-up",
      generation: 1,
      previousOperationKey: null,
      terminalReference: null,
      terminalState: null,
    },
  };
  const view = parseHostedBrowserBillingRead(
    {
      kind: "view",
      contractVersion: "hosted-browser-v1",
      scope,
    },
    lookup,
  );
  expect(view.kind).toBe("view");
  if (view.kind === "view") {
    expect(hostedBrowserContinuationMetadata(view).continuation.operation).toBeNull();
  }
  const payment = parseHostedBrowserBillingRead(
    {
      kind: "payment",
      original: topup,
      custody: { phase: "prepared" },
      [Symbol.dispose]() {},
    },
    lookup,
  );
  expect(payment.kind).toBe("payment");
  if (payment.kind === "payment") {
    expect(hostedBrowserContinuationMetadata(payment).continuation.operation).toEqual({
      action: "topup",
      method: "POST",
      path: "/v1/organizations/org-a/wallet/checkout",
      body: { reference: topup.action.claim.reference, amountMinor: 50 },
    });
  }
  const fresh = parseHostedBrowserBillingClaim(
    {
      kind: "fresh-dispatch",
      original: topup,
      accepted,
    },
    original,
  );
  expect(fresh.kind).toBe("fresh-dispatch");
  const history = parseHostedBrowserBillingClaim(
    {
      kind: "accepted-history",
      original: topup,
      custody: { phase: "dispatch-started", accepted },
    },
    original,
  );
  expect(history.kind).toBe("accepted-history");
  const reorderedRead = parseHostedBrowserBillingRead(
    {
      kind: "payment",
      original: topup,
      custody: {
        phase: "dispatch-started",
        accepted: {
          family: "topup",
          command: Object.fromEntries(Object.entries(accepted.command).reverse()),
        },
      },
    },
    lookup,
  );
  expect(reorderedRead.kind).toBe("payment");
  if (
    fresh.kind === "fresh-dispatch" &&
    reorderedRead.kind === "payment" &&
    reorderedRead.custody.phase === "dispatch-started"
  ) {
    expect(sameHostedBrowserBillingAccepted(fresh.accepted, reorderedRead.custody.accepted)).toBe(
      true,
    );
  }
  for (const command of [
    { ...accepted.command, generation: 2 },
    { ...accepted.command, previousOperationKey: "operation-before" },
    { ...accepted.command, terminalReference: topup.action.claim.reference, terminalState: "paid" },
  ]) {
    expect(() =>
      parseHostedBrowserBillingClaim(
        {
          kind: "fresh-dispatch",
          original: topup,
          accepted: { family: "topup", command },
        },
        original,
      ),
    ).toThrow(HostedBrowserContinuationError);
  }
  const successor = parseHostedBrowserBillingOriginal({
    ...topup,
    action: {
      ...topup.action,
      request: { ...topup.action.request, expectedOperationKey: "operation-before" },
    },
  });
  const successorCommand = {
    ...accepted.command,
    generation: 2,
    previousOperationKey: "operation-before",
    terminalReference: `takosumi:topup:${"b".repeat(64)}`,
    terminalState: "paid",
  };
  const successorClaim = parseHostedBrowserBillingClaim(
    {
      kind: "fresh-dispatch",
      original: successor,
      accepted: { family: "topup", command: successorCommand },
    },
    successor,
  );
  expect(successorClaim.kind).toBe("fresh-dispatch");
  const differentGeneration = parseHostedBrowserBillingClaim(
    {
      kind: "fresh-dispatch",
      original: successor,
      accepted: { family: "topup", command: { ...successorCommand, generation: 3 } },
    },
    successor,
  );
  if (successorClaim.kind === "fresh-dispatch" && differentGeneration.kind === "fresh-dispatch") {
    expect(
      sameHostedBrowserBillingAccepted(successorClaim.accepted, differentGeneration.accepted),
    ).toBe(false);
  }
  expect(() =>
    parseHostedBrowserBillingClaim(
      {
        kind: "fresh-dispatch",
        original: successor,
        accepted: {
          family: "topup",
          command: { ...successorCommand, terminalReference: successor.action.claim.reference },
        },
      },
      successor,
    ),
  ).toThrow(HostedBrowserContinuationError);
  expect(() =>
    parseHostedBrowserBillingClaim(
      {
        kind: "fresh-dispatch",
        original: successor,
        accepted: {
          family: "topup",
          command: {
            ...successorCommand,
            terminalReference: `${successorCommand.terminalReference}\n`,
          },
        },
      },
      successor,
    ),
  ).toThrow(HostedBrowserContinuationError);
  expect(() =>
    parseHostedBrowserBillingClaim(
      {
        kind: "fresh-dispatch",
        original: { ...topup, scope: { ...scope, sourceEpoch: "epoch-other" } },
        accepted,
      },
      original,
    ),
  ).toThrow(HostedBrowserContinuationError);
  expect(() =>
    parseHostedBrowserBillingClaim(
      {
        kind: "fresh-dispatch",
        original: topup,
        accepted: { ...accepted, command: { ...accepted.command, generation: 0 } },
      },
      original,
    ),
  ).toThrow(HostedBrowserContinuationError);
  expect(() =>
    parseHostedBrowserBillingRead(
      {
        kind: "payment",
        original: topup,
        custody: { phase: "prepared", extra: true },
      },
      lookup,
    ),
  ).toThrow(HostedBrowserContinuationError);
  let coercions = 0;
  expect(() =>
    parseHostedBrowserBillingRead(
      {
        kind: {
          toString() {
            coercions++;
            return "view";
          },
        },
        contractVersion: "hosted-browser-v1",
        scope,
      },
      lookup,
    ),
  ).toThrow(HostedBrowserContinuationError);
  expect(coercions).toBe(0);
});

test("a structural fake current-owner callback cannot become a native RpcTarget", async () => {
  const original = parseHostedBrowserBillingOriginal(topup);
  await expect(
    createHostedBrowserLiveAuthorizationTarget(
      {
        async assertOriginalCurrent() {},
        dispose() {},
      },
      original,
    ),
  ).rejects.toThrow();
});

test("RPC DATA disposal uses only an own method descriptor and normalizes cleanup failure", async () => {
  const lookup = {
    continuationRef: scope.continuationRef,
    canonicalAccountId: scope.canonicalAccountId,
  };
  let getterCalls = 0;
  const result = { kind: "view", contractVersion: "hosted-browser-v1", scope };
  Object.defineProperty(result, Symbol.dispose, {
    get() {
      getterCalls++;
      throw new Error("foreign getter");
    },
  });
  const client = createHostedBrowserBillingRpcClient({
    async readBrowserBillingContinuation() {
      return result;
    },
    async claimBrowserBillingContinuation() {
      throw new Error("unused");
    },
    async recordBrowserBillingContinuationOutcome() {
      throw new Error("unused");
    },
  });
  await expect(client.read(lookup)).rejects.toThrow(HostedBrowserContinuationError);
  expect(getterCalls).toBe(0);
});

test("subscription outcome receipts stay correlated to original claim kind, plan and target", () => {
  const started = parseHostedBrowserBillingOriginal(start);
  const startReceipt = {
    contractVersion: "hosted-subscription-command-v1",
    organizationId: scope.organizationId,
    reference: start.action.claim.reference,
    checkout: null,
    pendingChange: null,
    kind: "start",
    state: "pending",
    lifecycle: "pending",
    subscriptionRef: null,
    planKey: "starter",
    pricingRevision: "pricing-a",
    effectiveAt: null,
  };
  expect(
    parseHostedBrowserBillingOutcome(
      {
        kind: "subscription",
        receipt: startReceipt,
      },
      started,
    ).kind,
  ).toBe("subscription");
  expect(() =>
    parseHostedBrowserBillingOutcome(
      {
        kind: "subscription",
        receipt: { ...startReceipt, planKey: "other" },
      },
      started,
    ),
  ).toThrow(HostedBrowserContinuationError);
  const associated = {
    ...startReceipt,
    state: "associated",
    lifecycle: "associated",
    subscriptionRef: `sra_${HEX}`,
  };
  expect(
    parseHostedBrowserBillingOutcome(
      {
        kind: "subscription",
        receipt: associated,
      },
      started,
    ).kind,
  ).toBe("subscription");
  expect(() =>
    parseHostedBrowserBillingOutcome(
      {
        kind: "subscription",
        receipt: { ...associated, subscriptionRef: `${associated.subscriptionRef}\n` },
      },
      started,
    ),
  ).toThrow(HostedBrowserContinuationError);
  const cancelled = parseHostedBrowserBillingOriginal(cancel);
  const cancelReceipt = {
    ...startReceipt,
    kind: "cancel",
    reference: cancel.action.claim.reference,
    subscriptionRef: cancel.action.claim.expectedSubscriptionRef,
    planKey: null,
    pricingRevision: null,
  };
  expect(
    parseHostedBrowserBillingOutcome(
      {
        kind: "subscription",
        receipt: cancelReceipt,
      },
      cancelled,
    ).kind,
  ).toBe("subscription");
  expect(() =>
    parseHostedBrowserBillingOutcome(
      {
        kind: "subscription",
        receipt: { ...cancelReceipt, subscriptionRef: `sra_${"b".repeat(64)}` },
      },
      cancelled,
    ),
  ).toThrow(HostedBrowserContinuationError);
});

test("prepare accepts only a closed choice and same scope/selection original", () => {
  const choice = parseHostedBrowserBillingChoice({
    kind: "topup",
    amountMinor: 50,
    checkoutConsent: "interactive-checkout",
  });
  if (choice.kind !== "topup") throw new Error("expected topup choice");
  const expected = { scope, choice, current: choice };
  expect(
    parseHostedBrowserBillingPrepare(
      {
        kind: "prepared",
        original: topup,
      },
      expected,
    ).kind,
  ).toBe("prepared");
  expect(
    parseHostedBrowserBillingPrepare(
      {
        kind: "already-prepared",
        original: topup,
      },
      expected,
    ).kind,
  ).toBe("already-prepared");
  for (const body of [
    {
      kind: "topup",
      amountMinor: 50,
      checkoutConsent: "interactive-checkout",
      organizationId: scope.organizationId,
    },
    { kind: "topup", amountMinor: 50, checkoutConsent: "wrong" },
    { kind: "cancel", consent: "cancel-subscription", expectedSubscriptionRef: `sra_${HEX}` },
  ])
    expect(() => parseHostedBrowserBillingChoice(body)).toThrow(HostedBrowserContinuationError);
  expect(() =>
    parseHostedBrowserBillingPrepare(
      {
        kind: "prepared",
        original: {
          ...topup,
          action: {
            ...topup.action,
            request: { ...topup.action.request, amountMinor: 51 },
            claim: { ...topup.action.claim, amountMinor: 51 },
          },
        },
      },
      expected,
    ),
  ).toThrow(HostedBrowserContinuationError);
  expect(() =>
    parseHostedBrowserBillingPrepare(
      {
        kind: "prepared",
        original: {
          ...topup,
          scope: { ...scope, billingSourceRef: "changed" },
          action: {
            ...topup.action,
            claim: { ...topup.action.claim, billingSourceRef: "changed" },
          },
        },
      },
      expected,
    ),
  ).toThrow(HostedBrowserContinuationError);
});
