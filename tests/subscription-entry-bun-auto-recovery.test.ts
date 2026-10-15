// Native local proof: real entry-bun processes and SQLite, loopback fake Stripe,
// and only the production payment-reconcile interval shortened by a preload.
// This does not qualify the five-minute cadence, real Stripe, or Cloud deployment.
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts } from "../src/auth.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { base64UrlEncode } from "../src/json.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

type StripeObject = Record<string, unknown> & { id: string };
function nextMonthlyPeriodEnd(start: Date): Date {
  const result = new Date(start);
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + 2);
  result.setUTCDate(0);
  result.setUTCDate(Math.min(start.getUTCDate(), result.getUTCDate()));
  return result;
}

const NOW = new Date(Math.floor((Date.now() - 1000) / 1000) * 1000);
const START = NOW.getTime() / 1000;
const end = nextMonthlyPeriodEnd(NOW);
const END = end.getTime() / 1000;
const PUBLIC_ORIGIN = "https://api.example.test";
const shared = JSON.parse(
  readFileSync(new URL("../config/shared-hosted-pricing.json", import.meta.url), "utf8"),
);
shared.plans[0].stripePriceId = "price_hosted10";
shared.plans[1].stripePriceId = "price_hosted50";
const meters = Object.fromEntries(
  Object.entries(
    shared.meters as Record<
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
const PRICING = compilePricingAuthoring({
  authoringVersion: 2,
  sharedPricing: shared,
  planIds: { free: "free", usage: "usage" },
  billingConfig: {
    schemaVersion: 1,
    revision: shared.revision,
    effectiveAt: "2026-10-01T00:00:00.000Z",
    currency: "USD",
    holdTtlSeconds: 86_400,
    freeIncludedMinor: 150,
    purchaseCreditExpiry: { kind: "none" },
    plans: {
      "hosted-10": { includedMinor: 2000, stripePriceId: "price_hosted10" },
      "hosted-50": { includedMinor: 10000, stripePriceId: "price_hosted50" },
    },
    meters,
  },
  checkout: { minimumMinor: 50, maximumMinor: 99_999_999 },
});
const object = (id: string, name: string, extra: Record<string, unknown> = {}): StripeObject => ({
  id,
  object: name,
  livemode: false,
  ...extra,
});

test("initial invoice period clamps UTC month ends and retains time", () => {
  expect(nextMonthlyPeriodEnd(new Date("2025-01-31T12:34:56.789Z")).toISOString()).toBe(
    "2025-02-28T12:34:56.789Z",
  );
  expect(nextMonthlyPeriodEnd(new Date("2024-01-31T12:34:56.789Z")).toISOString()).toBe(
    "2024-02-29T12:34:56.789Z",
  );
  expect(nextMonthlyPeriodEnd(new Date("2026-03-31T12:34:56.789Z")).toISOString()).toBe(
    "2026-04-30T12:34:56.789Z",
  );
  expect(nextMonthlyPeriodEnd(new Date("2026-12-31T12:34:56.789Z")).toISOString()).toBe(
    "2027-01-31T12:34:56.789Z",
  );
});

function stripeService() {
  const customers = new Map<string, StripeObject>();
  const sessions = new Map<string, StripeObject>();
  const subscriptions = new Map<string, StripeObject>();
  const originalSubscriptionMetadata = new Map<string, Readonly<Record<string, string>>>();
  const invoices = new Map<string, StripeObject>();
  const charges = new Map<string, StripeObject>();
  const calls: { method: string; path: string }[] = [];
  let loseCheckoutAck = true;
  let loseCancelAck = true;
  let loseCancelRead = false;
  const lists: Record<string, Map<string, StripeObject>> = {
    customers,
    "checkout/sessions": sessions,
    subscriptions,
    invoices,
    charges,
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      calls.push({ method: request.method, path: url.pathname });
      if (!url.pathname.startsWith("/v1/")) return new Response("not Stripe", { status: 404 });
      const path = url.pathname.slice(4);
      if (request.method === "GET") {
        if (path === "subscriptions/sub_process_1" && loseCancelRead) {
          loseCancelRead = false;
          return new Response("readback temporarily unavailable", { status: 503 });
        }
        if (path === "prices/price_hosted10")
          return Response.json(
            object("price_hosted10", "price", {
              active: true,
              currency: "usd",
              type: "recurring",
              billing_scheme: "per_unit",
              unit_amount: 1000,
              recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
            }),
          );
        const lines = /^checkout\/sessions\/(cs_[A-Za-z0-9_]+)\/line_items$/u.exec(path);
        if (lines)
          return Response.json({
            object: "list",
            data: [{ id: `li_${lines[1]}`, price: { id: "price_hosted10" }, quantity: 1 }],
            has_more: false,
          });
        for (const [kind, values] of Object.entries(lists)) {
          if (path === kind) {
            let data = [...values.values()];
            for (const filter of ["customer", "subscription", "charge", "payment_intent"]) {
              const expected = url.searchParams.get(filter);
              if (expected) data = data.filter((value) => value[filter] === expected);
            }
            const after = url.searchParams.get("starting_after");
            if (after) {
              const index = data.findIndex((value) => value.id === after);
              data = index < 0 ? [] : data.slice(index + 1);
            }
            const limit = Number(url.searchParams.get("limit") ?? 100);
            return Response.json({
              object: "list",
              data: data.slice(0, limit),
              has_more: data.length > limit,
            });
          }
          if (path.startsWith(`${kind}/`)) {
            const value = values.get(path.slice(kind.length + 1));
            return value ? Response.json(value) : new Response("", { status: 404 });
          }
        }
        if (path === "events" || path === "refunds")
          return Response.json({ object: "list", data: [], has_more: false });
        return new Response("", { status: 404 });
      }
      if (request.method !== "POST") return new Response("method", { status: 405 });
      const form = new URLSearchParams(await request.text());
      if (path === "customers") {
        const customer = object("cus_process_1", "customer", {
          metadata: {
            organizationId: form.get("metadata[organizationId]"),
            takoserverPurpose: form.get("metadata[takoserverPurpose]"),
          },
        });
        customers.set(customer.id, customer);
        return Response.json(customer);
      }
      if (path === "checkout/sessions") {
        if (!customers.has("cus_process_1"))
          customers.set("cus_process_1", object("cus_process_1", "customer", { metadata: {} }));
        const session = object("cs_process_1", "checkout.session", {
          url: "https://checkout.stripe.com/c/pay/cs_process_1",
          mode: "subscription",
          status: "open",
          payment_status: "unpaid",
          currency: "usd",
          amount_subtotal: 1000,
          amount_total: 1000,
          client_reference_id: form.get("client_reference_id"),
          customer: form.get("customer") ?? "cus_process_1",
          subscription: null,
          invoice: null,
          after_expiration: null,
          recovered_from: null,
          metadata: {
            organizationId: form.get("metadata[organizationId]"),
            subscriptionCheckoutIntentId: form.get("metadata[subscriptionCheckoutIntentId]"),
            planKey: form.get("metadata[planKey]"),
            pricingRevision: form.get("metadata[pricingRevision]"),
            takoserverPurpose: form.get("metadata[takoserverPurpose]"),
          },
        });
        sessions.set(session.id, session);
        const prefix = "subscription_data[metadata]";
        originalSubscriptionMetadata.set(
          session.id,
          Object.fromEntries(
            [...form.entries()]
              .filter(([name]) => name.startsWith(`${prefix}[`) && name.endsWith("]"))
              .map(([name, value]) => [name.slice(prefix.length + 1, -1), value]),
          ),
        );
        if (loseCheckoutAck) {
          loseCheckoutAck = false;
          return new Response("effect committed, acknowledgement lost", { status: 503 });
        }
        return Response.json(session);
      }
      if (path === "subscriptions/sub_process_1") {
        const current = subscriptions.get("sub_process_1");
        if (!current) return new Response("", { status: 404 });
        const updated = {
          ...current,
          cancel_at_period_end: form.get("cancel_at_period_end") === "true",
        };
        subscriptions.set("sub_process_1", updated);
        if (loseCancelAck) {
          loseCancelAck = false;
          loseCancelRead = true;
          return new Response("effect committed, acknowledgement lost", { status: 503 });
        }
        return Response.json(updated);
      }
      return new Response("unhandled fake Stripe POST", { status: 400 });
    },
  });
  function complete(org: string) {
    const session = sessions.get("cs_process_1");
    if (!session) throw new Error("Checkout effect absent");
    sessions.set(session.id, {
      ...session,
      status: "complete",
      payment_status: "unpaid",
      subscription: "sub_process_1",
      invoice: "in_process_1",
    });
    const originalMetadata = originalSubscriptionMetadata.get(session.id);
    if (!originalMetadata || originalMetadata.organizationId !== org)
      throw new Error("original Checkout subscription metadata absent or wrong Organization");
    const metadata = { ...originalMetadata };
    subscriptions.set(
      "sub_process_1",
      object("sub_process_1", "subscription", {
        customer: session.customer,
        metadata,
        status: "incomplete",
        collection_method: "charge_automatically",
        currency: "usd",
        cancel_at_period_end: false,
        current_period_start: START,
        current_period_end: END,
        items: {
          has_more: false,
          data: [
            {
              id: "si_process_1",
              object: "subscription_item",
              quantity: 1,
              price: { id: "price_hosted10" },
            },
          ],
        },
      }),
    );
    invoices.set(
      "in_process_1",
      object("in_process_1", "invoice", {
        customer: session.customer,
        subscription: "sub_process_1",
        status: "open",
        paid: false,
        paid_out_of_band: false,
        amount_remaining: 1000,
        billing_reason: "subscription_create",
        subscription_details: { metadata },
        lines: {
          has_more: false,
          data: [
            {
              id: "il_process_1",
              object: "line_item",
              type: "subscription",
              proration: false,
              quantity: 1,
              subscription: "sub_process_1",
              price: "price_hosted10",
              period: { start: START, end: END },
            },
          ],
        },
        currency: "usd",
        amount_paid: 0,
        total: 1000,
        total_excluding_tax: 1000,
        amount_shipping: 0,
        starting_balance: 0,
        ending_balance: 0,
        post_payment_credit_notes_amount: 0,
        pre_payment_credit_notes_amount: 0,
        charge: null,
      }),
    );
  }
  function payInvoice() {
    const invoice = invoices.get("in_process_1");
    const session = sessions.get("cs_process_1");
    const subscription = subscriptions.get("sub_process_1");
    if (!invoice || !session || !subscription) throw new Error("initial payment graph absent");
    sessions.set(session.id, { ...session, payment_status: "paid" });
    subscriptions.set(subscription.id, { ...subscription, status: "active" });
    invoices.set(invoice.id, {
      ...invoice,
      status: "paid",
      paid: true,
      amount_remaining: 0,
      amount_paid: 1000,
      charge: "ch_process_1",
    });
    charges.set(
      "ch_process_1",
      object("ch_process_1", "charge", {
        customer: invoice.customer,
        invoice: "in_process_1",
        currency: "usd",
        paid: true,
        status: "succeeded",
        captured: true,
        disputed: false,
        amount: 1000,
        amount_refunded: 0,
        payment_intent: "pi_process_1",
      }),
    );
  }
  return {
    server,
    complete,
    payInvoice,
    calls,
    sessions,
    subscriptions,
    originalSubscriptionMetadata,
  };
}

async function unusedPort() {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response(null) });
  const port = Number(server.port);
  await server.stop(true);
  return port;
}

async function start(
  root: string,
  stripeOrigin: string,
  operatorPublicJwk: string,
  phase: string,
  accelerated: boolean,
) {
  const port = await unusedPort();
  const auditPath = join(root, `payment-timer-${phase}.log`);
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      "--preload",
      join(import.meta.dir, "fixtures/subscription-entry-bun-auto-recovery-preload.ts"),
      join(import.meta.dir, "..", "src", "entry-bun.ts"),
    ],
    {
      cwd: root,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "pipe",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: root,
        TMPDIR: root,
        CI: "1",
        NO_COLOR: "1",
        PORT: String(port),
        TAKOSERVER_DATA_ROOT: root,
        TAKOSERVER_DB: join(root, "control.sqlite"),
        TAKOSERVER_PUBLIC_ORIGIN: PUBLIC_ORIGIN,
        TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
          documentation: "https://docs.example.test/v2",
          authenticationDocumentation: "https://docs.example.test/v2/authentication",
        }),
        TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: base64UrlEncode(new Uint8Array(32).fill(0x74)),
        TAKOSERVER_OPERATOR_IDENTITY_PUBLIC_JWK: operatorPublicJwk,
        TAKOSERVER_STRIPE_MODE: "test",
        STRIPE_SECRET_KEY: "sk_test_local_process_only",
        STRIPE_WEBHOOK_SECRET: "whsec_local_process_only",
        TAKOSERVER_CONSOLE_ORIGIN: "https://console.example.test",
        ...PRICING.environment,
        AUTO_TEST_STRIPE_ORIGIN: stripeOrigin,
        AUTO_TEST_PAYMENT_AUDIT: auditPath,
        AUTO_TEST_PAYMENT_INTERVAL_MS: accelerated ? "100" : "300000",
      },
    },
  );
  const errors = new Response(child.stderr).text();
  async function kill() {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await errors;
  }
  for (let i = 0; i < 600; i++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/_takoserver/health/ready`, {
        signal: AbortSignal.timeout(500),
      });
      await response.arrayBuffer();
      if (response.status === 200) return { port, pid: child.pid, auditPath, kill };
    } catch {
      // The real entry has not bound its listener yet.
    }
    if (child.exitCode !== null) throw new Error(`host exited before listen: ${await errors}`);
    await Bun.sleep(50);
  }
  await kill();
  throw new Error("host startup timed out");
}

async function operatorPublicKey() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicJwk.x });
}

function timerEvents(path: string): string[] {
  return existsSync(path) ? readFileSync(path, "utf8").trim().split("\n") : [];
}

function openReadonly(root: string): Database {
  const database = new Database(join(root, "control.sqlite"), { readonly: true });
  database.exec("PRAGMA busy_timeout = 1000");
  return database;
}

function intentState(root: string, table: "checkout" | "cancellation", id: string): string {
  const database = openReadonly(root);
  try {
    const query =
      table === "checkout"
        ? "SELECT state FROM stripe_subscription_checkout_intents WHERE id = ?"
        : "SELECT state FROM stripe_subscription_cancellation_intents WHERE org_id = ?";
    return (database.query(query).get(id) as { state: string }).state;
  } finally {
    database.close();
  }
}

async function until(probe: () => boolean | Promise<boolean>, description: string) {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await probe()) return;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${description}`);
}

async function call(port: number, key: string, org: string, method: string, body?: unknown) {
  return await fetch(`http://127.0.0.1:${port}/v1/organizations/${org}/payments/subscription`, {
    method,
    headers: {
      authorization: `Bearer ${key}`,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(8_000),
  });
}

async function moneySnapshot(root: string, port: number, key: string, org: string) {
  const response = await fetch(`http://127.0.0.1:${port}/v1/organizations/${org}/wallet`, {
    headers: { authorization: `Bearer ${key}` },
    signal: AbortSignal.timeout(8_000),
  });
  expect(response.status).toBe(200);
  const { wallet } = (await response.json()) as {
    wallet: { settledMicros: string; heldMicros: string; availableMicros: string };
  };
  const database = openReadonly(root);
  try {
    return {
      balance: {
        settledMicros: wallet.settledMicros,
        heldMicros: wallet.heldMicros,
        availableMicros: wallet.availableMicros,
      },
      grants: database
        .query(
          "SELECT funding_ref,amount_micros,period_start,period_end,expires_at FROM stripe_billing_grants WHERE org_id = ? ORDER BY funding_ref",
        )
        .all(org),
      lots: database
        .query(
          "SELECT ref,kind,amount_micros FROM wallet_credit_lots WHERE org_id = ? ORDER BY ref",
        )
        .all(org),
    };
  } finally {
    database.close();
  }
}

test("entry-bun automatic payment pass recovers subscription custody after killed host PIDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "subscription-entry-auto-"));
  const stripe = stripeService();
  const stripeOrigin = `http://127.0.0.1:${stripe.server.port}`;
  const operatorPublicJwk = await operatorPublicKey();
  let first: Awaited<ReturnType<typeof start>> | undefined;
  let second: Awaited<ReturnType<typeof start>> | undefined;
  let third: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const database = new Database(join(root, "control.sqlite"));
    migrateSqlite(database);
    const sql = createSqliteSql(database);
    const accounts = createAccounts({
      sql,
      clock: () => new Date(NOW),
      identity: {
        async verify({ assertion }) {
          return {
            providerSubject: assertion,
            email: `${assertion}@example.test`,
            displayName: assertion,
          };
        },
      },
    });
    const ownerSession = await accounts.signIn({
      provider: "google",
      assertion: "subscription-owner",
    });
    const owner = await accounts.authenticate(`Bearer ${ownerSession.sessionToken}`);
    if (!owner) throw new Error("owner setup failed");
    const organization = await accounts.createOrganization({
      actor: owner,
      name: "Subscription OS",
    });
    const issued = await accounts.createApiKey({
      actor: owner,
      organizationId: organization.id,
      name: "subscription payments",
      scopes: ["wallet:read", "payments:write"],
      expiresInSeconds: 3600,
    });
    const foreignOrganization = await accounts.createOrganization({
      actor: owner,
      name: "Foreign OS",
    });
    const foreign = await accounts.createApiKey({
      actor: owner,
      organizationId: foreignOrganization.id,
      name: "foreign payments",
      scopes: ["wallet:read", "payments:write"],
      expiresInSeconds: 3600,
    });
    database.close();

    const begin = { reference: "hosted-os-checkout", planKey: "hosted-10" };
    first = await start(root, stripeOrigin, operatorPublicJwk, "first", false);
    expect(timerEvents(first.auditPath)).toEqual(["registered"]);
    expect((await call(first.port, foreign.secret, organization.id, "POST", begin)).status).toBe(
      403,
    );
    const started = await call(first.port, issued.secret, organization.id, "POST", begin);
    expect(started.status).toBe(202);
    const pending = (await started.json()) as { checkout: { state: string; id: string } };
    expect(pending.checkout.state).toBe("pending");
    expect(
      stripe.calls.filter(
        (request) => request.method === "POST" && request.path === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    const firstPid = first.pid;
    await first.kill();
    first = undefined;

    const stripeBeforeRecovery = stripe.calls.length;
    second = await start(root, stripeOrigin, operatorPublicJwk, "second", true);
    expect(second.pid).not.toBe(firstPid);
    await until(
      () => intentState(root, "checkout", pending.checkout.id) === "session_known",
      "automatic checkout custody recovery",
    );
    expect(timerEvents(second.auditPath)).toContain("tick");
    expect(stripe.calls.length).toBeGreaterThan(stripeBeforeRecovery);
    expect(
      stripe.calls.slice(stripeBeforeRecovery).every((request) => request.method === "GET"),
    ).toBe(true);
    const afterRecovery = openReadonly(root);
    try {
      expect(
        afterRecovery
          .query("SELECT state,session_id FROM stripe_subscription_checkout_intents WHERE id = ?")
          .get(pending.checkout.id),
      ).toEqual({ state: "session_known", session_id: "cs_process_1" });
    } finally {
      afterRecovery.close();
    }
    const resumed = await call(second.port, issued.secret, organization.id, "POST", begin);
    expect(resumed.status).toBe(201);
    expect((await resumed.json()) as unknown).toMatchObject({
      checkout: { id: "cs_process_1", state: "open" },
    });
    expect((await call(second.port, foreign.secret, organization.id, "GET")).status).toBe(403);
    const emptyMoney = {
      balance: { settledMicros: "1500000", heldMicros: "0", availableMicros: "1500000" },
      grants: [],
      lots: [
        {
          ref: `free:${organization.id}:${NOW.toISOString().slice(0, 7)}`,
          kind: "plan-included",
          amount_micros: 1_500_000,
        },
      ],
    };
    expect(await moneySnapshot(root, second.port, issued.secret, organization.id)).toEqual(
      emptyMoney,
    );
    stripe.complete(organization.id);
    expect(stripe.subscriptions.get("sub_process_1")?.metadata).toEqual(
      stripe.originalSubscriptionMetadata.get("cs_process_1"),
    );
    const readsBeforePayment = stripe.calls.length;
    await until(
      () =>
        stripe.calls
          .slice(readsBeforePayment)
          .some((request) => request.path === "/v1/invoices/in_process_1"),
      "automatic unpaid invoice observation",
    );
    const heldBeforePayment = openReadonly(root);
    try {
      const original = heldBeforePayment
        .query(
          "SELECT plan_key,pricing_revision FROM stripe_subscription_checkout_intents WHERE id=?",
        )
        .get(pending.checkout.id) as { plan_key: string; pricing_revision: string };
      expect(stripe.originalSubscriptionMetadata.get("cs_process_1")).toMatchObject({
        organizationId: organization.id,
        subscriptionCheckoutIntentId: pending.checkout.id,
        planKey: original.plan_key,
        pricingRevision: original.pricing_revision,
      });
      expect(
        heldBeforePayment
          .query(
            "SELECT state,subscription_id FROM stripe_subscription_checkout_intents WHERE id = ?",
          )
          .get(pending.checkout.id),
      ).toEqual({ state: "session_known", subscription_id: null });
    } finally {
      heldBeforePayment.close();
    }
    expect(await moneySnapshot(root, second.port, issued.secret, organization.id)).toEqual(
      emptyMoney,
    );
    stripe.payInvoice();
    await until(
      () => intentState(root, "checkout", pending.checkout.id) === "associated",
      "automatic paid invoice association",
    );
    const associatedAfterPayment = openReadonly(root);
    try {
      expect(
        associatedAfterPayment
          .query(
            "SELECT state,subscription_id FROM stripe_subscription_checkout_intents WHERE id = ?",
          )
          .get(pending.checkout.id),
      ).toEqual({ state: "associated", subscription_id: "sub_process_1" });
    } finally {
      associatedAfterPayment.close();
    }
    const invoiceCredit = {
      balance: {
        settledMicros: "20000000",
        heldMicros: "0",
        availableMicros: "20000000",
      },
      grants: [
        {
          funding_ref: "stripe:invoice:in_process_1",
          amount_micros: 20_000_000,
          period_start: NOW.toISOString(),
          period_end: end.toISOString(),
          expires_at: end.toISOString(),
        },
      ],
      lots: [
        {
          ref: `free:${organization.id}:${NOW.toISOString().slice(0, 7)}`,
          kind: "plan-included",
          amount_micros: 1_500_000,
        },
        {
          ref: "stripe:invoice:in_process_1",
          kind: "plan-included",
          amount_micros: 20_000_000,
        },
      ],
    };
    const secondPort = second.port;
    await until(async () => {
      const snapshot = await moneySnapshot(root, secondPort, issued.secret, organization.id);
      return snapshot.grants.length === 1 && snapshot.balance.settledMicros === "20000000";
    }, "automatic paid invoice credit");
    expect(await moneySnapshot(root, second.port, issued.secret, organization.id)).toEqual(
      invoiceCredit,
    );
    await until(async () => {
      const response = await call(secondPort, issued.secret, organization.id, "GET");
      const body = (await response.json()) as { subscription: unknown };
      return response.status === 200 && body.subscription !== null;
    }, "public subscription projection");
    const subscription = (await (
      await call(second.port, issued.secret, organization.id, "GET")
    ).json()) as {
      subscription: { subscriptionRef: string };
    };
    expect(subscription.subscription).not.toBeNull();
    expect(subscription.subscription.subscriptionRef).toMatch(/^sra_[0-9a-f]{64}$/u);
    const secondPid = second.pid;
    await second.kill();
    second = undefined;

    third = await start(root, stripeOrigin, operatorPublicJwk, "third", false);
    expect(third.pid).not.toBe(secondPid);
    expect(timerEvents(third.auditPath)).toEqual(["registered"]);
    const replay = await call(third.port, issued.secret, organization.id, "POST", begin);
    expect(replay.status).toBe(200);
    expect(
      ((await replay.json()) as { checkout: { subscriptionRef: string } }).checkout.subscriptionRef,
    ).toBe(subscription.subscription.subscriptionRef);
    expect(await moneySnapshot(root, third.port, issued.secret, organization.id)).toEqual(
      invoiceCredit,
    );
    const cancellation = {
      reference: "hosted-os-cancel",
      cancelAtPeriodEnd: true,
      expectedSubscriptionRef: subscription.subscription.subscriptionRef,
    };
    expect(
      (await call(third.port, foreign.secret, organization.id, "PATCH", cancellation)).status,
    ).toBe(403);
    const canceled = await call(third.port, issued.secret, organization.id, "PATCH", cancellation);
    expect(canceled.status).toBe(202);
    expect(
      ((await canceled.json()) as { cancellation: { state: string } }).cancellation.state,
    ).toBe("pending");
    const thirdPid = third.pid;
    await third.kill();
    third = undefined;

    const beforeCancelRecovery = stripe.calls.length;
    const fourth = await start(root, stripeOrigin, operatorPublicJwk, "fourth", true);
    try {
      expect(fourth.pid).not.toBe(thirdPid);
      await until(
        () => intentState(root, "cancellation", organization.id) === "verified",
        "automatic cancellation custody recovery",
      );
      expect(timerEvents(fourth.auditPath)).toContain("tick");
      expect(stripe.calls.length).toBeGreaterThan(beforeCancelRecovery);
      expect(
        stripe.calls.slice(beforeCancelRecovery).every((request) => request.method === "GET"),
      ).toBe(true);
      const final = await call(fourth.port, issued.secret, organization.id, "PATCH", cancellation);
      expect(final.status).toBe(200);
      expect((await final.json()) as unknown).toMatchObject({
        cancellation: {
          state: "verified",
          subscriptionRef: subscription.subscription.subscriptionRef,
        },
      });
      expect(await moneySnapshot(root, fourth.port, issued.secret, organization.id)).toEqual(
        invoiceCredit,
      );
    } finally {
      await fourth.kill();
    }
    expect(
      stripe.calls.filter(
        (request) => request.method === "POST" && request.path === "/v1/checkout/sessions",
      ),
    ).toHaveLength(1);
    expect(
      stripe.calls.filter(
        (request) =>
          request.method === "POST" && request.path === "/v1/subscriptions/sub_process_1",
      ),
    ).toHaveLength(1);
    const persisted = openReadonly(root);
    try {
      expect(
        persisted
          .query(
            "SELECT state, session_id, subscription_id FROM stripe_subscription_checkout_intents WHERE org_id = ?",
          )
          .all(organization.id),
      ).toEqual([
        { state: "associated", session_id: "cs_process_1", subscription_id: "sub_process_1" },
      ]);
      expect(
        persisted
          .query(
            "SELECT state, subscription_id FROM stripe_subscription_cancellation_intents WHERE org_id = ?",
          )
          .all(organization.id),
      ).toEqual([{ state: "verified", subscription_id: "sub_process_1" }]);
      expect(
        persisted
          .query("SELECT funding_ref, amount_micros FROM stripe_billing_grants WHERE org_id = ?")
          .all(organization.id),
      ).toEqual([{ funding_ref: "stripe:invoice:in_process_1", amount_micros: 20_000_000 }]);
      expect(
        persisted
          .query(
            "SELECT COUNT(*) AS count FROM wallet_credit_lots WHERE org_id = ? AND ref = 'stripe:invoice:in_process_1'",
          )
          .get(organization.id),
      ).toEqual({ count: 1 });
    } finally {
      persisted.close();
    }
  } finally {
    await first?.kill();
    await second?.kill();
    await third?.kill();
    stripe.server.stop(true);
    rmSync(root, { recursive: true, force: true });
  }
});
