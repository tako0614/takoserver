import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAccounts } from "../src/auth.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

type StripeObject = Record<string, unknown> & { id: string };
const NOW = new Date("2026-10-14T12:00:00.000Z");
const START = NOW.getTime() / 1000;
const END = Date.parse("2026-11-14T12:00:00.000Z") / 1000;
const PUBLIC_ORIGIN = "https://api.example.test";
const object = (id: string, name: string, extra: Record<string, unknown> = {}): StripeObject => ({
  id,
  object: name,
  livemode: false,
  ...extra,
});

function stripeService() {
  const customers = new Map<string, StripeObject>();
  const sessions = new Map<string, StripeObject>();
  const subscriptions = new Map<string, StripeObject>();
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
    const metadata = {
      organizationId: org,
      takoserverPurpose: "hosted_subscription",
      planKey: "hosted-10",
      pricingRevision: "hosted-20261014-final-v1",
    };
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
  return { server, complete, payInvoice, calls, sessions, subscriptions };
}

async function start(root: string, stripeOrigin: string, operatorPublicJwk: string) {
  const child = Bun.spawn(
    [
      process.execPath,
      "--no-env-file",
      join(import.meta.dir, "fixtures/subscription-custody-process-host.ts"),
      root,
      stripeOrigin,
      operatorPublicJwk,
    ],
    { stdin: "ignore", stdout: "pipe", stderr: "pipe" },
  );
  const errors = new Response(child.stderr).text();
  const reader = child.stdout.getReader();
  let buffer = "";
  const events: { stage: string; port: number; pid: number }[] = [];
  const reading = (async () => {
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      for (let end = buffer.indexOf("\n"); end >= 0; end = buffer.indexOf("\n")) {
        events.push(JSON.parse(buffer.slice(0, end)) as (typeof events)[number]);
        buffer = buffer.slice(end + 1);
      }
    }
  })();
  async function kill() {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await reading;
    await errors;
  }
  for (let i = 0; i < 500; i++) {
    const ready = events.find((event) => event.stage === "listening");
    if (ready) return { ...ready, kill };
    if (child.exitCode !== null) throw new Error(`host exited before listen: ${await errors}`);
    await Bun.sleep(10);
  }
  await kill();
  throw new Error("host startup timed out");
}

async function operatorKeyPair() {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    publicJwk: JSON.stringify({ kty: "OKP", crv: "Ed25519", x: publicJwk.x }),
    privateJwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
  };
}

async function reconcileAssertion(privateJwk: string) {
  return await signOperatorAssertion({
    privateJwk,
    claims: { purpose: "payments-reconcile", aud: PUBLIC_ORIGIN, jti: crypto.randomUUID() },
    nowSeconds: Math.floor(NOW.getTime() / 1_000),
    lifetimeSeconds: 60,
  });
}

async function requestReconcile(port: number, assertion: string) {
  return await fetch(`http://127.0.0.1:${port}/v1/operator/payments/reconcile`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ assertion }),
    signal: AbortSignal.timeout(8_000),
  });
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
  const database = new Database(join(root, "control.sqlite"), { readonly: true });
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

test("subscription Checkout, invoice and cancellation custody survive killed host PIDs", async () => {
  const root = mkdtempSync(join(tmpdir(), "subscription-custody-os-"));
  const stripe = stripeService();
  const stripeOrigin = `http://127.0.0.1:${stripe.server.port}`;
  const operator = await operatorKeyPair();
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
    first = await start(root, stripeOrigin, operator.publicJwk);
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

    second = await start(root, stripeOrigin, operator.publicJwk);
    expect(second.pid).not.toBe(firstPid);
    const stripeBeforeRecovery = stripe.calls.length;
    const recoveryAssertion = await reconcileAssertion(operator.privateJwk);
    const recovered = await requestReconcile(second.port, recoveryAssertion);
    expect(recovered.status).toBe(200);
    expect(
      stripe.calls.slice(stripeBeforeRecovery).every((request) => request.method === "GET"),
    ).toBe(true);
    const afterRecovery = new Database(join(root, "control.sqlite"), { readonly: true });
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
      balance: { settledMicros: "0", heldMicros: "0", availableMicros: "0" },
      grants: [],
      lots: [],
    };
    expect(await moneySnapshot(root, second.port, issued.secret, organization.id)).toEqual(
      emptyMoney,
    );
    stripe.complete(organization.id);
    const beforePayment = await requestReconcile(
      second.port,
      await reconcileAssertion(operator.privateJwk),
    );
    expect(beforePayment.status).toBe(200);
    const heldBeforePayment = new Database(join(root, "control.sqlite"), {
      readonly: true,
    });
    try {
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
    const paid = await requestReconcile(second.port, await reconcileAssertion(operator.privateJwk));
    expect(paid.status).toBe(200);
    const paidReport = (await paid.json()) as { report: { billing?: { unresolved: number } } };
    expect(paidReport.report.billing?.unresolved).toBe(0);
    const associatedAfterPayment = new Database(join(root, "control.sqlite"), {
      readonly: true,
    });
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
          period_start: "2026-10-14T12:00:00.000Z",
          period_end: "2026-11-14T12:00:00.000Z",
          expires_at: "2026-11-14T12:00:00.000Z",
        },
      ],
      lots: [
        {
          ref: "stripe:invoice:in_process_1",
          kind: "plan-included",
          amount_micros: 20_000_000,
        },
      ],
    };
    expect(await moneySnapshot(root, second.port, issued.secret, organization.id)).toEqual(
      invoiceCredit,
    );
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

    third = await start(root, stripeOrigin, operator.publicJwk);
    expect(third.pid).not.toBe(secondPid);
    const beforeReplay = stripe.calls.length;
    expect((await requestReconcile(third.port, recoveryAssertion)).status).toBe(401);
    expect(stripe.calls).toHaveLength(beforeReplay);
    expect(
      (await requestReconcile(third.port, await reconcileAssertion(operator.privateJwk))).status,
    ).toBe(200);
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

    const fourth = await start(root, stripeOrigin, operator.publicJwk);
    try {
      expect(fourth.pid).not.toBe(thirdPid);
      const beforeCancelRecovery = stripe.calls.length;
      expect(
        (await requestReconcile(fourth.port, await reconcileAssertion(operator.privateJwk))).status,
      ).toBe(200);
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
    const persisted = new Database(join(root, "control.sqlite"), { readonly: true });
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
