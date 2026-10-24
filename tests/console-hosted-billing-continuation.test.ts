import { afterEach, expect, test } from "bun:test";

class TestNode {
  readonly children: TestNode[] = [];
  readonly attributes = new Map<string, string>();
  readonly listeners = new Map<string, Array<EventListener>>();
  readonly style = {};
  className = "";
  disabled = false;
  checked = false;
  value = "";
  parent: TestNode | null = null;

  constructor(
    readonly tag = "text",
    private readonly content = "",
  ) {}

  get textContent(): string {
    return this.content + this.children.map((child) => child.textContent).join("");
  }

  append(...values: TestNode[]): void {
    for (const child of values) {
      child.parent = this;
      this.children.push(child);
    }
  }

  replaceChildren(...values: TestNode[]): void {
    this.children.length = 0;
    this.append(...values);
  }

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }

  addEventListener(name: string, listener: EventListener): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }

  click(): void {
    if (!this.disabled)
      for (const listener of this.listeners.get("click") ?? []) listener({} as Event);
  }

  change(): void {
    for (const listener of this.listeners.get("change") ?? [])
      listener({ target: this } as unknown as Event);
  }

  reportValidity(): boolean {
    return false;
  }

  all(): TestNode[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
}

const saved = new Map(
  ["document", "window", "localStorage", "sessionStorage", "Node", "HTMLInputElement", "fetch"].map(
    (key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)],
  ),
);

afterEach(() => {
  for (const [key, descriptor] of saved) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

function installDom(): { readonly body: TestNode; readonly session: Map<string, string> } {
  const body = new TestNode("body");
  const local = new Map<string, string>();
  const session = new Map<string, string>();
  Object.assign(globalThis, {
    Node: TestNode,
    HTMLInputElement: TestNode,
    localStorage: {
      getItem: (key: string) => local.get(key) ?? null,
      setItem: (key: string, value: string) => local.set(key, value),
      removeItem: (key: string) => local.delete(key),
    },
    sessionStorage: {
      getItem: (key: string) => session.get(key) ?? null,
      setItem: (key: string, value: string) => session.set(key, value),
      removeItem: (key: string) => session.delete(key),
    },
    document: {
      body,
      documentElement: { dataset: {} },
      createElement: (tag: string) => new TestNode(tag),
      createElementNS: (_namespace: string, tag: string) => new TestNode(tag),
      createTextNode: (value: string) => new TestNode("text", value),
      createDocumentFragment: () => new TestNode("fragment"),
      addEventListener: () => undefined,
    },
    window: {
      location: new URL("https://console.example.test/billing/hosted-continuations"),
      addEventListener: () => undefined,
    },
  });
  return { body, session };
}

async function settle(): Promise<void> {
  for (let index = 0; index < 12; index += 1)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

const unexpectedPreconnect: typeof fetch.preconnect = () => {
  throw new Error("unexpected fetch preconnect");
};

function findButton(body: TestNode, label: string): TestNode | undefined {
  return body.all().find((node) => node.tag === "button" && node.textContent === label);
}

function findByAttribute(
  body: TestNode,
  tag: string,
  name: string,
  value: string,
): TestNode | undefined {
  return body.all().find((node) => node.tag === tag && node.attributes.get(name) === value);
}

function buttonInConsentPanel(consent: TestNode): TestNode | undefined {
  return consent.parent?.parent?.all().find((node) => node.tag === "button");
}

const selector = "a".repeat(64);
const payment = {
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

const planTable = {
  scope: "hosted",
  balanceScope: "organization",
  products: ["takosumi-hosted", "takoserver"],
  plans: [
    {
      planId: "free",
      tier: "free",
      resourceScope: "edge",
      edgeAllowance: "pending-owner-runtime-policy",
    },
    {
      planId: "team-monthly",
      tier: "subscription",
      monthlyAmountMinor: 2300,
      includedCreditMinor: 1200,
      stripePriceId: "price_team_monthly",
    },
    {
      planId: "scale-monthly",
      tier: "subscription",
      monthlyAmountMinor: 8900,
      includedCreditMinor: 6200,
      stripePriceId: "price_scale_monthly",
    },
    {
      planId: "usage",
      tier: "usage",
      checkoutMinimumMinor: 500,
      checkoutMaximumMinor: 25000,
      meters: {},
    },
  ],
};

const capabilities = {
  contractVersion: "hosted-billing-v1",
  topUps: true,
  subscriptionStart: true,
  subscriptionCancellation: true,
  subscriptionPlanChange: true,
};

function viewResponse() {
  return {
    continuation: { ...payment.continuation, kind: "view", operation: null, phase: null },
  };
}

function subscriptionResponse(subscription: unknown = null, caps = capabilities) {
  return { subscription, planTable, billingCapabilities: caps };
}

function walletResponse() {
  return {
    wallet: {
      organizationId: "org-17",
      currency: "USD",
      settledMicros: "12345678",
      heldMicros: "2345678",
      availableMicros: "10000000",
      entries: [],
    },
  };
}

test("continuation page shows selected Workspace and view-only metadata without payment effects", async () => {
  const { body } = installDom();
  const asked: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      asked.push(`${init?.method ?? "GET"} ${url.pathname}`);
      return Response.json({
        continuation: { ...payment.continuation, kind: "view", operation: null, phase: null },
      });
    },
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  setApiOrigin("https://api.example.test");
  const { hostedBillingContinuationPage } = await import(
    "../console/src/pages/hosted-billing-continuation.ts"
  );
  body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
  await settle();
  expect(body.textContent).toContain("workspace-17");
  expect(body.textContent).toContain("org-17");
  expect(body.textContent).toContain("no payment operation");
  expect(findButton(body, "Confirm this operation once")).toBeUndefined();
  expect(asked).toEqual([
    `GET /v1/billing/hosted-continuations/${selector}`,
    "GET /v1/organizations/org-17/payments/subscription",
    "GET /v1/organizations/org-17/wallet",
  ]);
});

test("prepared operation requires one explicit click and the same selector effect is never resent", async () => {
  const { body, session } = installDom();
  const requests: Array<{ method: string; path: string; body: unknown; headers: Headers }> = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      requests.push({
        method,
        path: url.pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        headers: new Headers(init?.headers),
      });
      if (url.pathname.startsWith("/v1/billing/hosted-continuations/"))
        return Response.json(payment);
      return Response.json(
        { checkout: { url: "https://checkout.stripe.com/c/pay/test" } },
        { status: 201 },
      );
    },
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  setApiOrigin("https://api.example.test");
  const { hostedBillingContinuationPage } = await import(
    "../console/src/pages/hosted-billing-continuation.ts"
  );
  body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
  await settle();
  expect(body.textContent).toContain("$42.00");
  const confirm = findButton(body, "Confirm this operation once");
  expect(confirm).toBeDefined();
  confirm?.click();
  confirm?.click();
  await settle();
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
  const effect = requests.find((request) => request.method === "POST");
  expect(effect?.path).toBe("/v1/organizations/org-17/wallet/checkout");
  expect(effect?.body).toEqual({ reference: "topup-ref-17", amountMinor: 4200 });
  expect(effect?.headers.get("Takoserver-Billing-Continuation")).toBe(
    `hosted-browser-v1.${selector}`,
  );
  expect(effect?.headers.has("authorization")).toBe(false);
  expect(session.get(`takoserver.hosted-continuation-attempt:${selector}`)).toBe("attempted");
  expect(body.textContent).toContain("Continue to Stripe");
});

test("unknown continuation data fails closed and does not offer the ordinary billing action", async () => {
  const { body } = installDom();
  globalThis.fetch = Object.assign(
    async () => Response.json({ continuation: { ...payment.continuation, phase: "unknown" } }),
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  setApiOrigin("https://api.example.test");
  const { hostedBillingContinuationPage } = await import(
    "../console/src/pages/hosted-billing-continuation.ts"
  );
  body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
  await settle();
  expect(body.textContent).toContain("Continuation unavailable");
  expect(findButton(body, "Confirm this operation once")).toBeUndefined();
});

test("history-only phases are read-only in the dedicated view", async () => {
  for (const phase of ["dispatch-started", "outcome-recorded"] as const) {
    const { body } = installDom();
    const methods: string[] = [];
    globalThis.fetch = Object.assign(
      async (_input: RequestInfo | URL, init?: RequestInit) => {
        methods.push(init?.method ?? "GET");
        return Response.json({
          continuation: { ...payment.continuation, phase },
        });
      },
      { preconnect: unexpectedPreconnect },
    );
    const { setApiOrigin } = await import("../console/src/state.ts");
    setApiOrigin("https://api.example.test");
    const { hostedBillingContinuationPage } = await import(
      "../console/src/pages/hosted-billing-continuation.ts"
    );
    body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
    await settle();
    expect(findButton(body, "Confirm this operation once")).toBeUndefined();
    expect(methods).toEqual(["GET"]);
  }
});

test("a lost effect acknowledgement rereads the same continuation and never resends", async () => {
  const { body, session } = installDom();
  const methods: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      methods.push(method);
      if (url.pathname.startsWith("/v1/billing/hosted-continuations/"))
        return Response.json(payment);
      throw new TypeError("network lost after request");
    },
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  setApiOrigin("https://api.example.test");
  const { hostedBillingContinuationPage } = await import(
    "../console/src/pages/hosted-billing-continuation.ts"
  );
  body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
  await settle();
  findButton(body, "Confirm this operation once")?.click();
  await settle();
  expect(methods).toEqual(["GET", "POST", "GET"]);
  expect(session.get(`takoserver.hosted-continuation-attempt:${selector}`)).toBe("attempted");
  expect(body.textContent).toContain("no resend will occur");
  expect(findButton(body, "Confirm this operation once")).toBeUndefined();
});

test("history after a prepared selection overrides local prepared data after lost confirmation ACK", async () => {
  for (const phase of ["dispatch-started", "outcome-recorded"] as const) {
    const { body, session } = installDom();
    const requests: string[] = [];
    let continuationReads = 0;
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(String(input));
        const method = init?.method ?? "GET";
        requests.push(`${method} ${url.pathname}`);
        if (url.pathname.startsWith("/v1/billing/hosted-continuations/")) {
          if (method === "POST")
            return Response.json({
              continuation: {
                ...payment.continuation,
                operation: {
                  ...payment.continuation.operation,
                  body: { ...payment.continuation.operation.body, amountMinor: 500 },
                },
              },
            });
          continuationReads += 1;
          if (continuationReads === 1) return Response.json(viewResponse());
          return Response.json({
            continuation: {
              ...payment.continuation,
              operation: {
                ...payment.continuation.operation,
                body: { ...payment.continuation.operation.body, amountMinor: 500 },
              },
              phase,
            },
          });
        }
        if (url.pathname.endsWith("/payments/subscription"))
          return Response.json(subscriptionResponse());
        if (url.pathname.endsWith("/wallet")) return Response.json(walletResponse());
        throw new TypeError("effect acknowledgement lost");
      },
      { preconnect: unexpectedPreconnect },
    );
    const { setApiOrigin } = await import("../console/src/state.ts");
    setApiOrigin("https://api.example.test");
    const { hostedBillingContinuationPage } = await import(
      "../console/src/pages/hosted-billing-continuation.ts"
    );
    body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
    await settle();
    const consent = findByAttribute(
      body,
      "input",
      "aria-label",
      "I consent to continue to interactive Checkout.",
    );
    const prepare = findButton(body, "Prepare top-up");
    if (!consent || !prepare) throw new Error("top-up controls missing");
    consent.checked = true;
    consent.change();
    prepare.click();
    await settle();
    expect(findButton(body, "Confirm this operation once")).toBeDefined();

    findButton(body, "Confirm this operation once")?.click();
    await settle();
    expect(requests.filter((entry) => entry.startsWith("POST "))).toEqual([
      `POST /v1/billing/hosted-continuations/${selector}`,
      "POST /v1/organizations/org-17/wallet/checkout",
    ]);
    expect(continuationReads).toBe(2);
    expect(session.get(`takoserver.hosted-continuation-prepare:${selector}`)).toBe("attempted");
    expect(session.get(`takoserver.hosted-continuation-attempt:${selector}`)).toBe("attempted");
    expect(body.textContent).toContain(
      phase === "dispatch-started" ? "dispatch-started" : "recorded the outcome",
    );
    expect(body.textContent).toContain("No resend will occur");
    expect(findButton(body, "Confirm this operation once")).toBeUndefined();
  }
});

test("view selection uses the locked organization reads and prepares a bounded top-up without dispatching it", async () => {
  const { body, session } = installDom();
  const requests: Array<{
    method: string;
    path: string;
    body: unknown;
    credentials?: RequestCredentials;
    headers: Headers;
  }> = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      const method = init?.method ?? "GET";
      const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({
        method,
        path: url.pathname,
        body: requestBody,
        ...(init?.credentials === undefined ? {} : { credentials: init.credentials }),
        headers: new Headers(init?.headers),
      });
      if (url.pathname.startsWith("/v1/billing/hosted-continuations/")) {
        if (method === "POST")
          return Response.json({
            continuation: {
              ...payment.continuation,
              operation: {
                action: "topup",
                method: "POST",
                path: "/v1/organizations/org-17/wallet/checkout",
                body: { reference: "topup-prepared-17", amountMinor: requestBody.amountMinor },
              },
            },
          });
        return Response.json(viewResponse());
      }
      if (url.pathname.endsWith("/payments/subscription"))
        return Response.json(subscriptionResponse());
      if (url.pathname.endsWith("/wallet")) return Response.json(walletResponse());
      throw new Error(`unexpected request: ${url.pathname}`);
    },
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  setApiOrigin("https://api.example.test");
  const { hostedBillingContinuationPage } = await import(
    "../console/src/pages/hosted-billing-continuation.ts"
  );
  body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
  await settle();
  expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
    `GET /v1/billing/hosted-continuations/${selector}`,
    "GET /v1/organizations/org-17/payments/subscription",
    "GET /v1/organizations/org-17/wallet",
  ]);
  expect(body.textContent).toContain("$250.00");
  expect(body.textContent).toContain("Available wallet balance: $10");
  expect(body.textContent).not.toContain("USD-micros");
  const amount = findByAttribute(body, "input", "aria-label", "Amount (USD)");
  const consent = findByAttribute(
    body,
    "input",
    "aria-label",
    "I consent to continue to interactive Checkout.",
  );
  const prepareButton = findButton(body, "Prepare top-up");
  expect(findButton(body, "Prepare subscription start")).toBeDefined();
  expect(amount?.value).toBe("5.00");
  expect(amount?.attributes.get("min")).toBe("5.00");
  expect(amount?.attributes.get("max")).toBe("250.00");
  expect(prepareButton?.disabled).toBe(true);
  if (!amount || !consent || !prepareButton) throw new Error("top-up controls missing");
  consent.checked = true;
  consent.change();
  expect(prepareButton.disabled).toBe(false);
  for (const invalid of ["4.99", "4.999", "250.01", "NaN", "90071992547409.92"]) {
    amount.value = invalid;
    prepareButton.click();
  }
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(0);
  amount.value = "42.00";
  prepareButton.click();
  await settle();
  expect(
    requests
      .filter((request) => request.method === "POST")
      .map(({ method, path, body, credentials }) => ({
        method,
        path,
        body,
        credentials,
      })),
  ).toEqual([
    {
      method: "POST",
      path: `/v1/billing/hosted-continuations/${selector}`,
      body: { kind: "topup", amountMinor: 4200, checkoutConsent: "interactive-checkout" },
      credentials: "include",
    },
  ]);
  expect(requests.every((request) => request.credentials === "include")).toBe(true);
  expect(requests.every((request) => !request.headers.has("authorization"))).toBe(true);
  expect(session.get(`takoserver.hosted-continuation-prepare:${selector}`)).toBe("attempted");
  expect(body.textContent).toContain("$42.00");
  expect(findButton(body, "Confirm this operation once")).toBeDefined();
  expect(requests.filter((request) => request.method === "PATCH")).toHaveLength(0);
  expect(requests.filter((request) => request.method === "POST")).toHaveLength(1);
});

test("selected subscription facts gate start, cancel and plan-change choices", async () => {
  const { body } = installDom();
  const currentSubscription = {
    organizationId: "org-17",
    subscriptionId: "sub-17",
    subscriptionRef: `sra_${"1".repeat(64)}`,
    planKey: "team-monthly",
    pricingRevision: "rev-1",
    status: "active",
    cancelAtPeriodEnd: false,
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    paidThrough: null,
    paidFeatures: true,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/v1/billing/hosted-continuations/"))
        return Response.json(viewResponse());
      if (path.endsWith("/payments/subscription"))
        return Response.json(subscriptionResponse(currentSubscription));
      if (path.endsWith("/wallet")) return Response.json(walletResponse());
      throw new Error(`unexpected request: ${path}`);
    },
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  setApiOrigin("https://api.example.test");
  const { hostedBillingContinuationPage } = await import(
    "../console/src/pages/hosted-billing-continuation.ts"
  );
  body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
  await settle();
  expect(body.textContent).toContain("Cancel subscription");
  expect(body.textContent).toContain("Change subscription plan");
  expect(body.textContent).not.toContain("Start subscription");
  expect(body.textContent).toContain("team-monthly");
  expect(body.textContent).toContain("scale-monthly");
  expect(body.textContent).toContain("$23 / month ($12 included)");
  expect(body.textContent).toContain("$89 / month ($62 included)");
  expect(body.textContent).not.toContain("1,200");
  expect(findButton(body, "Confirm this operation once")).toBeUndefined();
  const changeSelect = findByAttribute(body, "select", "id", "hosted-change-plan");
  const changeLabel = body
    .all()
    .find((node) => node.tag === "label" && node.attributes.get("for") === "hosted-change-plan");
  expect(changeSelect).toBeDefined();
  expect(changeLabel?.textContent).toBe("Plan and monthly price (USD)");
  expect(findButton(body, "Prepare cancellation")).toBeDefined();
  expect(findButton(body, "Prepare plan change")).toBeDefined();
});

test("plan price and included credit copy follows the Console locale", async () => {
  const { body } = installDom();
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith("/v1/billing/hosted-continuations/"))
        return Response.json(viewResponse());
      if (path.endsWith("/payments/subscription")) return Response.json(subscriptionResponse());
      if (path.endsWith("/wallet")) return Response.json(walletResponse());
      throw new Error(`unexpected request: ${path}`);
    },
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  const { setConsoleLocale } = await import("../console/src/i18n.ts");
  setApiOrigin("https://api.example.test");
  setConsoleLocale("ja");
  try {
    const { hostedBillingContinuationPage } = await import(
      "../console/src/pages/hosted-billing-continuation.ts"
    );
    body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
    await settle();
    const select = findByAttribute(body, "select", "id", "hosted-start-plan");
    expect(select?.textContent).toContain("team-monthly — $23 / 月（$12を含む）");
    expect(select?.textContent).toContain("scale-monthly — $89 / 月（$62を含む）");
    expect(select?.textContent).not.toContain("/ month");
    expect(select?.textContent).not.toContain("included");
  } finally {
    setConsoleLocale("en");
  }
});

test("start selection submits a runtime plan key and waits for the separate confirmation", async () => {
  const { body, session } = installDom();
  const requests: Array<{ method: string; body: unknown }> = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
      requests.push({ method, body: requestBody });
      if (path.startsWith("/v1/billing/hosted-continuations/")) {
        if (method === "POST")
          return Response.json({
            continuation: {
              ...payment.continuation,
              operation: {
                action: "subscription-start",
                method: "POST",
                path: "/v1/organizations/org-17/payments/subscription",
                body: { reference: "sub-start-ref-17", planKey: requestBody.planKey },
              },
            },
          });
        return Response.json(viewResponse());
      }
      if (path.endsWith("/payments/subscription")) return Response.json(subscriptionResponse());
      if (path.endsWith("/wallet")) return Response.json(walletResponse());
      throw new Error(`unexpected request: ${path}`);
    },
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  setApiOrigin("https://api.example.test");
  const { hostedBillingContinuationPage } = await import(
    "../console/src/pages/hosted-billing-continuation.ts"
  );
  body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
  await settle();
  const consent = findByAttribute(
    body,
    "input",
    "aria-label",
    "I consent to continue to subscription Checkout.",
  );
  const select = findByAttribute(body, "select", "id", "hosted-start-plan");
  if (!consent || !select) throw new Error("subscription start controls missing");
  select.value = "scale-monthly";
  const prepareButton = buttonInConsentPanel(consent);
  expect(prepareButton?.textContent).toBe("Prepare subscription start");
  expect(prepareButton?.disabled).toBe(true);
  consent.checked = true;
  consent.change();
  prepareButton?.click();
  await settle();
  expect(requests.filter((request) => request.method === "POST")).toEqual([
    {
      method: "POST",
      body: { kind: "start", planKey: "scale-monthly", consent: "subscription-checkout" },
    },
  ]);
  expect(session.get(`takoserver.hosted-continuation-prepare:${selector}`)).toBe("attempted");
  expect(body.textContent).toContain("Confirm this operation once");
  expect(requests.some((request) => request.method === "PATCH")).toBe(false);
});

test("cancel and change-plan choices send no browser-selected target or organization", async () => {
  const currentSubscription = {
    organizationId: "org-17",
    subscriptionId: "sub-17",
    subscriptionRef: `sra_${"1".repeat(64)}`,
    planKey: "team-monthly",
    pricingRevision: "rev-1",
    status: "active",
    cancelAtPeriodEnd: false,
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    paidThrough: null,
    paidFeatures: true,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  for (const choice of ["cancel", "change-plan"] as const) {
    const { body } = installDom();
    const posts: Array<{ path: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const path = new URL(String(input)).pathname;
        const method = init?.method ?? "GET";
        const requestBody = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        if (path.startsWith("/v1/billing/hosted-continuations/")) {
          if (method === "POST") {
            posts.push({ path, body: requestBody });
            const operation =
              choice === "cancel"
                ? {
                    action: "cancel",
                    method: "PATCH",
                    path: "/v1/organizations/org-17/payments/subscription",
                    body: {
                      reference: "cancel-ref-17",
                      cancelAtPeriodEnd: true,
                      expectedSubscriptionRef: currentSubscription.subscriptionRef,
                    },
                  }
                : {
                    action: "plan-change",
                    method: "PATCH",
                    path: "/v1/organizations/org-17/payments/subscription",
                    body: {
                      reference: "plan-ref-17",
                      planKey: requestBody.planKey,
                      expectedSubscriptionRef: currentSubscription.subscriptionRef,
                    },
                  };
            return Response.json({ continuation: { ...payment.continuation, operation } });
          }
          return Response.json(viewResponse());
        }
        if (path.endsWith("/payments/subscription"))
          return Response.json(subscriptionResponse(currentSubscription));
        if (path.endsWith("/wallet")) return Response.json(walletResponse());
        throw new Error(`unexpected request: ${path}`);
      },
      { preconnect: unexpectedPreconnect },
    );
    const { setApiOrigin } = await import("../console/src/state.ts");
    setApiOrigin("https://api.example.test");
    const { hostedBillingContinuationPage } = await import(
      "../console/src/pages/hosted-billing-continuation.ts"
    );
    body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
    await settle();
    const ariaLabel =
      choice === "cancel"
        ? "I consent to cancel the current subscription at the end of its period."
        : "I consent to change the current subscription to the selected plan.";
    const consent = findByAttribute(body, "input", "aria-label", ariaLabel);
    if (!consent) throw new Error(`${choice} consent missing`);
    const prepareButton = buttonInConsentPanel(consent);
    expect(prepareButton?.textContent).toBe(
      choice === "cancel" ? "Prepare cancellation" : "Prepare plan change",
    );
    if (choice === "change-plan") {
      const select = findByAttribute(body, "select", "id", "hosted-change-plan");
      const label = body
        .all()
        .find(
          (node) => node.tag === "label" && node.attributes.get("for") === "hosted-change-plan",
        );
      expect(select?.attributes.get("aria-label")).toBe("Change subscription plan");
      expect(label?.textContent).toBe("Plan and monthly price (USD)");
    }
    consent.checked = true;
    consent.change();
    prepareButton?.click();
    await settle();
    expect(posts).toHaveLength(1);
    expect(posts[0]?.path).toBe(`/v1/billing/hosted-continuations/${selector}`);
    expect(posts[0]?.body).toEqual(
      choice === "cancel"
        ? { kind: "cancel", consent: "cancel-subscription" }
        : { kind: "change-plan", planKey: "team-monthly", consent: "change-subscription-plan" },
    );
    expect(Object.keys(posts[0]?.body ?? {}).sort()).toEqual(
      choice === "cancel" ? ["consent", "kind"] : ["consent", "kind", "planKey"],
    );
    expect(body.textContent).toContain("Confirm this operation once");
  }
});

test("missing Hosted capability contract or selected reads leave all choices unavailable", async () => {
  for (const mode of ["wrong-contract", "wallet-denied"] as const) {
    const { body } = installDom();
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.startsWith("/v1/billing/hosted-continuations/"))
          return Response.json(viewResponse());
        if (path.endsWith("/payments/subscription"))
          return Response.json(
            subscriptionResponse(
              null,
              mode === "wrong-contract"
                ? { ...capabilities, contractVersion: "other" }
                : capabilities,
            ),
          );
        if (path.endsWith("/wallet") && mode !== "wallet-denied")
          return Response.json(walletResponse());
        return Response.json({ message: "unavailable" }, { status: 503 });
      },
      { preconnect: unexpectedPreconnect },
    );
    const { setApiOrigin } = await import("../console/src/state.ts");
    setApiOrigin("https://api.example.test");
    const { hostedBillingContinuationPage } = await import(
      "../console/src/pages/hosted-billing-continuation.ts"
    );
    body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
    await settle();
    expect(findButton(body, "Prepare top-up")).toBeUndefined();
    expect(body.textContent).not.toContain("Confirm this operation once");
  }
});

test("each false capability hides only its own action", async () => {
  const currentSubscription = {
    organizationId: "org-17",
    subscriptionId: "sub-17",
    subscriptionRef: `sra_${"1".repeat(64)}`,
    planKey: "team-monthly",
    pricingRevision: "rev-1",
    status: "active",
    cancelAtPeriodEnd: false,
    periodStart: "2026-10-01T00:00:00.000Z",
    periodEnd: "2026-11-01T00:00:00.000Z",
    paidThrough: null,
    paidFeatures: true,
    updatedAt: "2026-10-01T00:00:00.000Z",
  };
  for (const scenario of [
    {
      subscription: null,
      caps: { ...capabilities, subscriptionPlanChange: false },
      visible: ["Prepare top-up", "Prepare subscription start"],
      hidden: ["Prepare plan change", "Prepare cancellation"],
    },
    {
      subscription: currentSubscription,
      caps: { ...capabilities, subscriptionCancellation: false },
      visible: ["Prepare top-up", "Prepare plan change"],
      hidden: ["Prepare subscription start", "Prepare cancellation"],
    },
  ] as const) {
    const { body } = installDom();
    globalThis.fetch = Object.assign(
      async (input: RequestInfo | URL) => {
        const path = new URL(String(input)).pathname;
        if (path.startsWith("/v1/billing/hosted-continuations/"))
          return Response.json(viewResponse());
        if (path.endsWith("/payments/subscription"))
          return Response.json(subscriptionResponse(scenario.subscription, scenario.caps));
        if (path.endsWith("/wallet")) return Response.json(walletResponse());
        throw new Error(`unexpected request: ${path}`);
      },
      { preconnect: unexpectedPreconnect },
    );
    const { setApiOrigin } = await import("../console/src/state.ts");
    setApiOrigin("https://api.example.test");
    const { hostedBillingContinuationPage } = await import(
      "../console/src/pages/hosted-billing-continuation.ts"
    );
    body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
    await settle();
    for (const label of scenario.visible) expect(findButton(body, label)).toBeDefined();
    for (const label of scenario.hidden) expect(findButton(body, label)).toBeUndefined();
    const visibleButtons = body.all().filter((node) => node.tag === "button");
    expect(visibleButtons.map((node) => node.textContent)).toEqual([...scenario.visible]);
  }
});

test("unknown prepare result rereads only the same selector and never prepares again", async () => {
  const { body, session } = installDom();
  const methods: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      methods.push(`${method} ${path}`);
      if (path.startsWith("/v1/billing/hosted-continuations/") && method === "POST")
        throw new TypeError("lost prepare response");
      if (path.startsWith("/v1/billing/hosted-continuations/"))
        return Response.json(viewResponse());
      if (path.endsWith("/payments/subscription")) return Response.json(subscriptionResponse());
      if (path.endsWith("/wallet")) return Response.json(walletResponse());
      throw new Error(`unexpected request: ${path}`);
    },
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  setApiOrigin("https://api.example.test");
  const { hostedBillingContinuationPage } = await import(
    "../console/src/pages/hosted-billing-continuation.ts"
  );
  body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
  await settle();
  const consent = findByAttribute(
    body,
    "input",
    "aria-label",
    "I consent to continue to interactive Checkout.",
  );
  const prepareButton = findButton(body, "Prepare top-up");
  if (!consent || !prepareButton) throw new Error("top-up controls missing");
  consent.checked = true;
  consent.change();
  prepareButton.click();
  await settle();
  expect(methods.filter((entry) => entry.startsWith("POST "))).toEqual([
    `POST /v1/billing/hosted-continuations/${selector}`,
  ]);
  expect(
    methods.filter((entry) => entry.startsWith("GET /v1/billing/hosted-continuations/")),
  ).toHaveLength(2);
  expect(session.get(`takoserver.hosted-continuation-prepare:${selector}`)).toBe("attempted");
  expect(body.textContent).toContain("no automatic resend will occur");
  expect(findButton(body, "Prepare top-up")?.disabled).toBe(true);
});

test("a noncanonical existing prepare marker remains fail-closed for this selector", async () => {
  const { body, session } = installDom();
  session.set(`takoserver.hosted-continuation-prepare:${selector}`, "modified");
  const methods: string[] = [];
  globalThis.fetch = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = new URL(String(input)).pathname;
      const method = init?.method ?? "GET";
      methods.push(method);
      if (path.startsWith("/v1/billing/hosted-continuations/"))
        return Response.json(viewResponse());
      if (path.endsWith("/payments/subscription")) return Response.json(subscriptionResponse());
      if (path.endsWith("/wallet")) return Response.json(walletResponse());
      throw new Error(`unexpected request: ${path}`);
    },
    { preconnect: unexpectedPreconnect },
  );
  const { setApiOrigin } = await import("../console/src/state.ts");
  setApiOrigin("https://api.example.test");
  const { hostedBillingContinuationPage } = await import(
    "../console/src/pages/hosted-billing-continuation.ts"
  );
  body.append(hostedBillingContinuationPage(selector) as unknown as TestNode);
  await settle();
  expect(findButton(body, "Prepare top-up")?.disabled).toBe(true);
  expect(methods.every((method) => method === "GET")).toBe(true);
  expect(body.textContent).toContain("no automatic resend will occur");
});
