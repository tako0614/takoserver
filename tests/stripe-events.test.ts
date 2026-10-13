import { describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  type ExternalIdentityVerifier,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";
import { createLedger } from "../src/ledger.ts";
import type { PaymentEventContext } from "../src/payment-events.ts";
import {
  DEFAULT_CHECKOUT_MAXIMUM_MINOR,
  DEFAULT_CHECKOUT_MINIMUM_MINOR,
  type PaymentSettings,
  PaymentSettingsError,
  paymentSettingsFromEnvironment,
} from "../src/payment-settings.ts";
import { resolvePayment } from "../src/payment-setup.ts";
import type { Sql } from "../src/ports.ts";
import {
  createStripeEvents,
  STRIPE_DEFERRED_EVENT_TYPES,
  StripeSignatureError,
  type StripeSignatureFailure,
  verifyStripeSignature,
} from "../src/stripe-events.ts";
import { createStripeClient } from "../src/stripe-settlement.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

/**
 * The webhook and the reconcile pass move money without anybody presenting a
 * proof, so each guard they rely on gets a test that fails when it is removed:
 * the signature over the raw bytes, the timestamp window, re-reading the
 * session from Stripe instead of believing the event body, the organization
 * existing here, the currency, and crediting each session exactly once no
 * matter how many paths or deliveries reach it.
 */

const ORG = "org_068e6b5ea58b4f8da5262274f869bce1";
const OTHER_ORG = "org_1f2e3d4c5b6a4f8da5262274f869bce2";
const UNKNOWN_ORG = "org_9a8b7c6d5e4f4f8da5262274f869bce3";
const SECRET = "whsec_test_0123456789abcdefghijklmnop";
const KEY = "sk_test_pretend";
const NOW = new Date("2026-10-13T12:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ORIGIN = "https://api.takoserver.test";

const identity: ExternalIdentityVerifier = {
  async verify() {
    return { providerSubject: "subject", email: "owner@example.com", displayName: "Owner" };
  },
};

type Session = Record<string, unknown>;

/** A succeeded payment whose charge is neither refunded nor disputed. */
const HELD_PAYMENT = {
  object: "payment_intent",
  status: "succeeded",
  latest_charge: { object: "charge", refunded: false, amount_refunded: 0, disputed: false },
};

/** A paid wallet top-up this Host created; `metadata` overrides merge into its marker. */
function paid(overrides: Session = {}): Session {
  const { metadata, ...rest } = overrides;
  return {
    status: "complete",
    mode: "payment",
    payment_status: "paid",
    amount_total: 5_000,
    currency: "usd",
    created: NOW_SECONDS - 60,
    payment_intent: HELD_PAYMENT,
    metadata: {
      organizationId: ORG,
      takoserverPurpose: "wallet_funding",
      ...(metadata as Record<string, unknown> | undefined),
    },
    ...rest,
  };
}

/** Stripe's Checkout Session API, newest first, with a switch to fail it. */
function stripeFake(initial: Record<string, Session>) {
  const sessions = new Map(Object.entries(initial));
  const calls: string[] = [];
  const state = { unavailable: false };
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    calls.push(`${request.method} ${url.pathname}${url.search}`);
    expect(request.headers.get("authorization")).toBe(`Bearer ${KEY}`);
    if (state.unavailable) return new Response("upstream down", { status: 500 });
    const one = /^\/v1\/checkout\/sessions\/(cs_[A-Za-z0-9_]+)$/u.exec(url.pathname);
    if (request.method === "GET" && one?.[1]) {
      const session = sessions.get(one[1]);
      return session
        ? Response.json({ id: one[1], object: "checkout.session", ...session })
        : new Response("", { status: 404 });
    }
    if (request.method === "GET" && url.pathname === "/v1/checkout/sessions") {
      const status = url.searchParams.get("status");
      const listed = [...sessions.entries()]
        .map(([id, session]): Session => ({ id, object: "checkout.session", ...session }))
        .filter((session) => session.status === status)
        .sort((left, right) => Number(right.created) - Number(left.created));
      const after = url.searchParams.get("starting_after");
      const start = after ? listed.findIndex((session) => session.id === after) + 1 : 0;
      const limit = Number(url.searchParams.get("limit"));
      return Response.json({
        object: "list",
        data: listed.slice(start, start + limit),
        has_more: start + limit < listed.length,
      });
    }
    return new Response("unexpected", { status: 400 });
  };
  return { sessions, calls, state, fetch };
}

async function host(
  options: {
    readonly sessions?: Record<string, Session>;
    readonly webhookSecret?: string | null;
    readonly stripeKey?: string | null;
    readonly settings?: PaymentSettings;
  } = {},
) {
  const stripe = stripeFake(options.sessions ?? {});
  const base = createEphemeralSql();
  // Counts every statement, so a pass can be held to its query budget.
  const queries = { count: 0 };
  const sql: Sql = {
    query: (statement, parameters) => {
      queries.count += 1;
      return base.query(statement, parameters);
    },
    run: (statement, parameters) => {
      queries.count += 1;
      return base.run(statement, parameters);
    },
    batch: (statements) => {
      queries.count += 1;
      return base.batch(statements);
    },
  };
  for (const organizationId of [ORG, OTHER_ORG]) {
    await sql.run(
      "INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)",
      [organizationId, "Probe", "prn_owner", NOW.toISOString()],
    );
  }
  const payment = resolvePayment({
    ...(options.stripeKey === null ? {} : { stripeSecretKey: options.stripeKey ?? KEY }),
    ...(options.webhookSecret === null
      ? {}
      : { stripeWebhookSecret: options.webhookSecret ?? SECRET }),
    consoleOrigin: "https://console.example.test",
    fetch: stripe.fetch,
    ...(options.settings ? { settings: options.settings } : {}),
  });
  const app = buildApp({
    v2: TEST_TAKOFORM_V2_CONFIG,
    sql,
    objects: createMemoryObjectStore(),
    identity,
    settlement: payment.settlement ?? {
      async verify(): Promise<never> {
        throw new Error("settlement is not configured");
      },
    },
    ...(payment.checkout ? { checkout: payment.checkout } : {}),
    ...(payment.events ? { paymentEvents: payment.events } : {}),
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
    clock: () => NOW,
  });
  const ledger = createLedger(sql, () => NOW);
  return {
    app,
    queries,
    stripe,
    payment,
    balance: async (organizationId: string) => (await ledger.wallet(organizationId)).settledMinor,
    fund: async (organizationId: string, fundingRef: string, amountMinor: number) =>
      await ledger.fund({ organizationId, fundingRef, amountMinor }),
    fundingRows: async () =>
      await sql.query("SELECT org_id, ref, settled_delta FROM ledger WHERE type = 'funding'"),
    events: async () =>
      await sql.query(
        "SELECT event_id, type, outcome, outcome_detail, object_id FROM stripe_events ORDER BY event_id",
      ),
  };
}

let eventSequence = 0;

function nextEventId(): string {
  eventSequence += 1;
  return `evt_test_${String(eventSequence).padStart(6, "0")}`;
}

function event(type: string, object: Record<string, unknown>, id = nextEventId()): string {
  return JSON.stringify({
    id,
    object: "event",
    api_version: "2026-09-30",
    type,
    livemode: false,
    created: NOW_SECONDS - 5,
    data: { object },
  });
}

function sign(body: string, options: { secret?: string; timestamp?: number } = {}): string {
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const signature = createHmac("sha256", options.secret ?? SECRET)
    .update(`${timestamp}.${body}`)
    .digest("hex");
  return `t=${timestamp},v1=${signature}`;
}

async function deliver(
  app: { fetch: (request: Request) => Promise<Response> },
  body: string,
  signature: string | null = sign(body),
): Promise<Response> {
  return await app.fetch(
    new Request(`${ORIGIN}/v1/payments/stripe/webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        ...(signature === null ? {} : { "stripe-signature": signature }),
      },
      body,
    }),
  );
}

async function errorCode(response: Response): Promise<string | undefined> {
  return ((await response.json()) as { error?: { code?: string } }).error?.code;
}

/** What the event body says; deliberately wrong wherever Stripe's own record differs. */
function claimedSession(id: string): Record<string, unknown> {
  return {
    id,
    object: "checkout.session",
    payment_status: "paid",
    amount_total: 9_999_999,
    currency: "usd",
    metadata: { organizationId: OTHER_ORG },
  };
}

describe("Stripe webhook signature", () => {
  const payload = new TextEncoder().encode('{"id":"evt_1"}');
  const header = (secret = SECRET, timestamp = NOW_SECONDS) =>
    `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.{"id":"evt_1"}`).digest("hex")}`;
  const verify = (value: string | null, now = NOW_SECONDS) =>
    verifyStripeSignature({
      payload,
      header: value,
      secret: SECRET,
      nowSeconds: now,
      toleranceSeconds: 300,
    });

  test("accepts the exact bytes signed with this endpoint's secret", async () => {
    await expect(verify(header())).resolves.toBeUndefined();
  });

  test("accepts any one matching v1 while a secret is being rolled", async () => {
    const rolled = `${header("whsec_old_secret_value_0000000000")},v1=${header().split("v1=")[1]}`;
    await expect(verify(rolled)).resolves.toBeUndefined();
  });

  test("refuses a missing, malformed, foreign or mismatched signature", async () => {
    const cases: [string | null, StripeSignatureFailure][] = [
      [null, "missing"],
      ["", "missing"],
      ["t=1,v0=abc", "malformed"],
      [`v1=${"0".repeat(64)}`, "malformed"],
      [`t=${NOW_SECONDS},t=${NOW_SECONDS},v1=${"0".repeat(64)}`, "malformed"],
      [`t=${NOW_SECONDS},v1=XYZ`, "malformed"],
      [header("whsec_somebody_elses_secret_000000"), "mismatch"],
      [`t=${NOW_SECONDS},v1=${"0".repeat(64)}`, "mismatch"],
    ];
    for (const [value, reason] of cases) {
      const failure = await verify(value).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(StripeSignatureError);
      expect((failure as StripeSignatureError).reason).toBe(reason);
    }
  });

  test("refuses a genuine signature outside the timestamp tolerance, either side", async () => {
    await expect(verify(header(SECRET, NOW_SECONDS - 300))).resolves.toBeUndefined();
    for (const timestamp of [NOW_SECONDS - 301, NOW_SECONDS + 301]) {
      const failure = await verify(header(SECRET, timestamp)).catch((error: unknown) => error);
      expect((failure as StripeSignatureError).reason).toBe("outside_tolerance");
    }
  });
});

describe("Stripe webhook route", () => {
  test("credits what Stripe reports, not what the event body claims", async () => {
    const h = await host({ sessions: { cs_test_paid: paid() } });
    const body = event("checkout.session.completed", claimedSession("cs_test_paid"));
    const response = await deliver(h.app, body);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ received: true, duplicate: false });
    expect(await h.balance(ORG)).toBe(5_000);
    expect(await h.balance(OTHER_ORG)).toBe(0);
    expect(await h.fundingRows()).toEqual([
      { org_id: ORG, ref: "stripe:cs_test_paid", settled_delta: 5_000 },
    ]);
    expect(await h.events()).toEqual([
      {
        event_id: JSON.parse(body).id,
        type: "checkout.session.completed",
        outcome: "credited",
        outcome_detail: "credited",
        object_id: "cs_test_paid",
      },
    ]);
  });

  test("refuses unsigned, tampered, foreign-secret and stale deliveries without asking Stripe", async () => {
    const h = await host({ sessions: { cs_test_paid: paid() } });
    const body = event("checkout.session.completed", claimedSession("cs_test_paid"));
    const tampered = body.replace("9999999", "1");
    const deliveries: [string, string | null][] = [
      [body, null],
      [tampered, sign(body)],
      [body, sign(body, { secret: "whsec_another_endpoint_secret_00000" })],
      [body, sign(body, { timestamp: NOW_SECONDS - 3_600 })],
      [body, "t=abc,v1=def"],
    ];
    for (const [payload, signature] of deliveries) {
      const response = await deliver(h.app, payload, signature);
      expect(response.status).toBe(400);
      expect(await errorCode(response)).toBe("invalid_signature");
    }
    expect(h.stripe.calls).toEqual([]);
    expect(await h.events()).toEqual([]);
    expect(await h.balance(ORG)).toBe(0);
  });

  test("honours a configured timestamp tolerance", async () => {
    const h = await host({
      sessions: { cs_test_paid: paid() },
      settings: { webhookToleranceSeconds: 30 },
    });
    const body = event("checkout.session.completed", claimedSession("cs_test_paid"));
    const late = await deliver(h.app, body, sign(body, { timestamp: NOW_SECONDS - 31 }));
    expect(await errorCode(late)).toBe("invalid_signature");
    const inside = await deliver(h.app, body, sign(body, { timestamp: NOW_SECONDS - 30 }));
    expect(inside.status).toBe(200);
    expect(await h.balance(ORG)).toBe(5_000);
  });

  test("answers a redelivered event from its record without crediting or asking again", async () => {
    const h = await host({ sessions: { cs_test_paid: paid() } });
    const body = event("checkout.session.completed", claimedSession("cs_test_paid"));
    expect((await deliver(h.app, body)).status).toBe(200);
    const again = await deliver(h.app, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ received: true, duplicate: true });
    expect(h.stripe.calls).toEqual([
      "GET /v1/checkout/sessions/cs_test_paid?expand%5B%5D=payment_intent.latest_charge",
    ]);
    expect(await h.balance(ORG)).toBe(5_000);
  });

  test("credits a session once across distinct events and the console's own return", async () => {
    const h = await host({ sessions: { cs_test_paid: paid() } });
    const completed = event("checkout.session.completed", claimedSession("cs_test_paid"));
    const succeeded = event(
      "checkout.session.async_payment_succeeded",
      claimedSession("cs_test_paid"),
    );
    expect((await deliver(h.app, completed)).status).toBe(200);
    expect((await deliver(h.app, succeeded)).status).toBe(200);
    const settled = await h.payment.settlement?.verify({
      organizationId: ORG,
      settlementProof: "cs_test_paid",
    });
    expect(settled?.fundingRef).toBe("stripe:cs_test_paid");
    expect(await h.fundingRows()).toHaveLength(1);
    expect(await h.balance(ORG)).toBe(5_000);
    expect((await h.events()).map((row) => row.outcome_detail)).toEqual([
      "credited",
      "already_credited",
    ]);
  });

  test("credits the organization Stripe names, and nothing for one this Host lacks", async () => {
    const h = await host({
      sessions: {
        cs_test_other: paid({ metadata: { organizationId: OTHER_ORG }, amount_total: 1_200 }),
        cs_test_unknown: paid({ metadata: { organizationId: UNKNOWN_ORG } }),
        cs_test_none: paid({ metadata: { organizationId: undefined } }),
      },
    });
    for (const id of ["cs_test_other", "cs_test_unknown", "cs_test_none"]) {
      const body = event("checkout.session.completed", {
        ...claimedSession(id),
        metadata: { organizationId: ORG },
      });
      expect((await deliver(h.app, body)).status).toBe(200);
    }
    expect(await h.balance(ORG)).toBe(0);
    expect(await h.balance(OTHER_ORG)).toBe(1_200);
    expect(await h.balance(UNKNOWN_ORG)).toBe(0);
    expect(
      (await h.events()).map((row) => [row.object_id, row.outcome, row.outcome_detail]),
    ).toEqual([
      ["cs_test_other", "credited", "credited"],
      ["cs_test_unknown", "ignored", "unknown_organization"],
      ["cs_test_none", "ignored", "wrong_organization"],
    ]);
  });

  test("never credits another currency as dollars", async () => {
    const h = await host({ sessions: { cs_test_yen: paid({ currency: "jpy" }) } });
    const response = await deliver(
      h.app,
      event("checkout.session.completed", claimedSession("cs_test_yen")),
    );
    expect(response.status).toBe(200);
    expect(await h.fundingRows()).toEqual([]);
    expect((await h.events())[0]).toMatchObject({
      outcome: "ignored",
      outcome_detail: "wrong_currency",
    });
  });

  test("waits for a delayed payment method, then credits on its success event", async () => {
    const h = await host({ sessions: { cs_test_ach: paid({ payment_status: "unpaid" }) } });
    await deliver(h.app, event("checkout.session.completed", claimedSession("cs_test_ach")));
    expect(await h.balance(ORG)).toBe(0);
    h.stripe.sessions.set("cs_test_ach", paid());
    await deliver(
      h.app,
      event("checkout.session.async_payment_succeeded", claimedSession("cs_test_ach")),
    );
    expect(await h.balance(ORG)).toBe(5_000);
    expect((await h.events()).map((row) => row.outcome_detail)).toEqual(["not_paid", "credited"]);
  });

  test("keeps an event retryable while Stripe cannot be read, then settles it on redelivery", async () => {
    const h = await host({ sessions: { cs_test_paid: paid() } });
    const body = event("checkout.session.completed", claimedSession("cs_test_paid"));
    h.stripe.state.unavailable = true;
    const refused = await deliver(h.app, body);
    expect(refused.status).toBe(503);
    expect(await errorCode(refused)).toBe("unavailable");
    expect(await h.events()).toEqual([
      expect.objectContaining({ outcome: "received", outcome_detail: null }),
    ]);
    expect(await h.balance(ORG)).toBe(0);
    h.stripe.state.unavailable = false;
    const redelivered = await deliver(h.app, body);
    expect(await redelivered.json()).toEqual({ received: true, duplicate: false });
    expect(await h.balance(ORG)).toBe(5_000);
    expect((await h.events())[0]).toMatchObject({ outcome: "credited" });
  });

  test("records and acknowledges deferred and unknown event types without acting on them", async () => {
    const h = await host();
    const types = [...STRIPE_DEFERRED_EVENT_TYPES, "customer.created"];
    for (const type of types) {
      const response = await deliver(h.app, event(type, { id: "in_test_1", object: "invoice" }));
      expect(response.status).toBe(200);
    }
    expect(h.stripe.calls).toEqual([]);
    expect(await h.fundingRows()).toEqual([]);
    const rows = await h.events();
    expect(rows.map((row) => [row.type, row.outcome, row.object_id])).toEqual(
      types.map((type) => [
        type,
        type === "customer.created" ? "unsupported" : "deferred",
        "in_test_1",
      ]),
    );
    expect(new Set(STRIPE_DEFERRED_EVENT_TYPES)).toEqual(
      new Set([
        "invoice.paid",
        "invoice.payment_failed",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "charge.refunded",
      ]),
    );
  });

  test("refuses a signed body that is not a Stripe event, and an oversized one", async () => {
    const h = await host();
    const notAnEvent = JSON.stringify({ id: "evt_x", object: "charge" });
    const malformed = await deliver(h.app, notAnEvent);
    expect(malformed.status).toBe(400);
    expect(await errorCode(malformed)).toBe("malformed_event");
    const huge = `{"pad":"${"x".repeat(300 * 1_024)}"}`;
    const oversized = await deliver(h.app, huge);
    expect(oversized.status).toBe(413);
    expect(await errorCode(oversized)).toBe("payload_too_large");
    expect(await h.events()).toEqual([]);
  });

  test("is not served without a webhook secret, or without Stripe at all", async () => {
    for (const options of [{ webhookSecret: null }, { stripeKey: null }] as const) {
      const h = await host({ sessions: { cs_test_paid: paid() }, ...options });
      const body = event("checkout.session.completed", claimedSession("cs_test_paid"));
      const response = await deliver(h.app, body);
      expect(response.status).toBe(404);
      expect(await errorCode(response)).toBe("not_found");
      expect(h.stripe.calls).toEqual([]);
    }
    const get = await (await host()).app.fetch(new Request(`${ORIGIN}/v1/payments/stripe/webhook`));
    expect(get.status).toBe(404);
  });
});

describe("Stripe reconcile pass", () => {
  test("credits paid sessions nobody presented, once, and only inside the window", async () => {
    const h = await host({
      sessions: {
        cs_recon_paid: paid({ amount_total: 2_500 }),
        cs_recon_presented: paid({ amount_total: 700, created: NOW_SECONDS - 30 }),
        cs_recon_unpaid: paid({ payment_status: "unpaid", created: NOW_SECONDS - 90 }),
        cs_recon_yen: paid({ currency: "jpy", created: NOW_SECONDS - 120 }),
        cs_recon_other: paid({
          metadata: { organizationId: OTHER_ORG },
          amount_total: 900,
          created: NOW_SECONDS - 150,
        }),
        cs_recon_foreign: paid({
          metadata: { organizationId: UNKNOWN_ORG },
          created: NOW_SECONDS - 180,
        }),
        cs_recon_open: paid({ status: "open", payment_status: "unpaid" }),
        cs_recon_old: paid({ created: NOW_SECONDS - 8 * 24 * 60 * 60 }),
      },
    });
    // The console's return already credited this one, through the same reference.
    const presented = await h.payment.settlement?.verify({
      organizationId: ORG,
      settlementProof: "cs_recon_presented",
    });
    if (!presented) throw new Error("settlement is not configured");
    await h.fund(ORG, presented.fundingRef, presented.amountMinor);
    const first = await h.app.reconcilePayments();
    expect(first).toEqual({
      examined: 6,
      credited: 2,
      alreadyCredited: 1,
      unknownOrganization: 1,
      skipped: { not_paid: 1, wrong_currency: 1 },
      truncated: false,
    });
    expect(await h.balance(ORG)).toBe(2_500 + 700);
    expect(await h.balance(OTHER_ORG)).toBe(900);
    const second = await h.app.reconcilePayments();
    expect(second).toMatchObject({ credited: 0, alreadyCredited: 3 });
    expect(await h.fundingRows()).toHaveLength(3);
  });

  test("pages through Stripe's listing and says when one pass could not read it all", async () => {
    const sessions: Record<string, Session> = {};
    for (let index = 0; index < 1_050; index += 1) {
      sessions[`cs_page_${String(index).padStart(4, "0")}`] = paid({
        payment_status: "unpaid",
        created: NOW_SECONDS - index,
      });
    }
    const h = await host({ sessions });
    const report = await h.app.reconcilePayments();
    expect(report).toMatchObject({ examined: 1_000, truncated: true });
    expect(h.stripe.calls).toHaveLength(10);
    expect(h.stripe.calls[1]).toContain("starting_after=cs_page_0099");
  });

  test("honours a configured lookback window", async () => {
    const h = await host({
      sessions: {
        cs_window_inside: paid({ created: NOW_SECONDS - 3_000 }),
        cs_window_outside: paid({ created: NOW_SECONDS - 4_000 }),
      },
      settings: { reconcileLookbackSeconds: 3_600 },
    });
    expect(await h.app.reconcilePayments()).toMatchObject({ examined: 1, credited: 1 });
    expect(await h.balance(ORG)).toBe(5_000);
  });

  test("is absent where payment is off", async () => {
    const h = await host({ stripeKey: null });
    expect(await h.app.reconcilePayments()).toBeNull();
  });

  test("surfaces Stripe being unavailable instead of reporting an empty window", async () => {
    const h = await host({ sessions: { cs_recon_paid: paid() } });
    h.stripe.state.unavailable = true;
    await expect(h.app.reconcilePayments()).rejects.toMatchObject({ code: "unavailable" });
    expect(await h.balance(ORG)).toBe(0);
  });
});

describe("payment settings", () => {
  test("defaults stay what they were, and every one can be replaced", async () => {
    const defaults = resolvePayment({
      stripeSecretKey: KEY,
      consoleOrigin: "https://console.example.test",
    });
    expect(defaults.checkout?.bounds).toEqual({
      minimumMinor: DEFAULT_CHECKOUT_MINIMUM_MINOR,
      maximumMinor: DEFAULT_CHECKOUT_MAXIMUM_MINOR,
    });
    const settings = paymentSettingsFromEnvironment({
      TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR: "1000",
      TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR: " 250000 ",
      TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS: "120",
      TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS: "",
    });
    expect(settings).toEqual({
      checkoutMinimumMinor: 1_000,
      checkoutMaximumMinor: 250_000,
      webhookToleranceSeconds: 120,
    });
    const configured = resolvePayment({
      stripeSecretKey: KEY,
      consoleOrigin: "https://console.example.test",
      settings,
    });
    expect(configured.checkout?.bounds).toEqual({ minimumMinor: 1_000, maximumMinor: 250_000 });
  });

  test("refuses a value it would otherwise have to guess at", () => {
    const refused: [Record<string, string>, string][] = [
      [
        { TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR: "12.5" },
        "TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR",
      ],
      [
        { TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR: "10" },
        "TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR",
      ],
      [
        { TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR: "100000000" },
        "TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR",
      ],
      [
        { TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR: "400" },
        "TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR",
      ],
      [
        {
          TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR: "9000",
          TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR: "8000",
        },
        "TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR",
      ],
      [
        { TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS: "0" },
        "TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS",
      ],
      [
        { TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS: "60" },
        "TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS",
      ],
      [
        { TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS: "-3600" },
        "TAKOSERVER_STRIPE_RECONCILE_LOOKBACK_SECONDS",
      ],
    ];
    for (const [environment, setting] of refused) {
      const failure = (() => {
        try {
          paymentSettingsFromEnvironment(environment);
          return null;
        } catch (error) {
          return error;
        }
      })();
      expect(failure).toBeInstanceOf(PaymentSettingsError);
      expect((failure as PaymentSettingsError).setting).toBe(setting);
    }
  });

  test("checks settings even where payment is off", () => {
    expect(() => resolvePayment({ settings: { webhookToleranceSeconds: 0 } })).toThrow(
      PaymentSettingsError,
    );
  });
});

describe("independent review guards", () => {
  const refundedCharge = (charge: Record<string, unknown>) => ({
    payment_intent: {
      ...HELD_PAYMENT,
      latest_charge: { ...HELD_PAYMENT.latest_charge, ...charge },
    },
  });

  test("never credits a session whose payment was refunded, partly refunded or disputed", async () => {
    const h = await host({
      sessions: {
        cs_test_refunded: paid(refundedCharge({ refunded: true, amount_refunded: 5_000 })),
        cs_test_partial: paid(refundedCharge({ amount_refunded: 1 })),
        cs_test_disputed: paid(refundedCharge({ disputed: true })),
        cs_test_unexpanded: paid({ payment_intent: "pi_not_expanded" }),
      },
    });
    for (const id of [
      "cs_test_refunded",
      "cs_test_partial",
      "cs_test_disputed",
      "cs_test_unexpanded",
    ]) {
      expect(
        (await deliver(h.app, event("checkout.session.completed", claimedSession(id)))).status,
      ).toBe(200);
    }
    expect((await h.events()).map((row) => row.outcome_detail)).toEqual([
      "refunded",
      "refunded",
      "refunded",
      "unverifiable_payment",
    ]);
    expect(await h.app.reconcilePayments()).toMatchObject({
      credited: 0,
      skipped: { refunded: 3, unverifiable_payment: 1 },
    });
    await expect(
      h.payment.settlement?.verify({ organizationId: ORG, settlementProof: "cs_test_partial" }),
    ).rejects.toMatchObject({ code: "refunded" });
    expect(await h.fundingRows()).toEqual([]);
  });

  test("credits automatically only one-off top-ups this Host marked, while the console's return still works", async () => {
    const h = await host({
      sessions: {
        cs_test_unmarked: paid({ metadata: { takoserverPurpose: undefined } }),
        cs_test_link: paid({ metadata: { takoserverPurpose: "payment_link" } }),
        cs_test_subscription: paid({ mode: "subscription" }),
      },
    });
    for (const id of ["cs_test_unmarked", "cs_test_link", "cs_test_subscription"]) {
      await deliver(h.app, event("checkout.session.completed", claimedSession(id)));
    }
    expect(await h.app.reconcilePayments()).toMatchObject({
      credited: 0,
      skipped: { not_wallet_funding: 3 },
    });
    expect(await h.fundingRows()).toEqual([]);
    const presented = await h.payment.settlement?.verify({
      organizationId: ORG,
      settlementProof: "cs_test_unmarked",
    });
    expect(presented?.fundingRef).toBe("stripe:cs_test_unmarked");
    await expect(
      h.payment.settlement?.verify({
        organizationId: ORG,
        settlementProof: "cs_test_subscription",
      }),
    ).rejects.toMatchObject({ code: "not_wallet_funding" });
  });

  test("logs paid sessions it could not credit, by reference only", async () => {
    const h = await host({
      sessions: {
        cs_test_yen: paid({ currency: "jpy", amount_total: 77_777 }),
        cs_test_foreign: paid({ metadata: { organizationId: UNKNOWN_ORG } }),
      },
    });
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (line: unknown) => warnings.push(String(line));
    try {
      await h.app.reconcilePayments();
      await deliver(h.app, event("checkout.session.completed", claimedSession("cs_test_yen")));
    } finally {
      console.warn = original;
    }
    const logged = warnings
      .map((line) => JSON.parse(line) as { event: string; payments?: unknown })
      .filter((line) => line.event === "takoserver.stripe.uncredited_payments");
    expect(logged.map((line) => line.payments)).toEqual([
      [
        { fundingRef: "stripe:cs_test_yen", reason: "wrong_currency" },
        { fundingRef: "stripe:cs_test_foreign", reason: "unknown_organization" },
      ],
      [{ fundingRef: "stripe:cs_test_yen", reason: "wrong_currency" }],
    ]);
    expect(JSON.stringify(logged)).not.toContain("77777");
    expect(JSON.stringify(logged)).not.toContain(UNKNOWN_ORG);
  });

  test("a quiet pass costs one ledger read per page, not one per payment", async () => {
    const sessions: Record<string, Session> = {};
    for (let index = 0; index < 150; index += 1) {
      sessions[`cs_quiet_${String(index).padStart(3, "0")}`] = paid({
        amount_total: 500,
        created: NOW_SECONDS - index,
      });
    }
    const h = await host({ sessions });
    expect(await h.app.reconcilePayments()).toMatchObject({ credited: 150 });
    h.queries.count = 0;
    expect(await h.app.reconcilePayments()).toMatchObject({ credited: 0, alreadyCredited: 150 });
    expect(h.queries.count).toBe(2);
    expect(await h.balance(ORG)).toBe(150 * 500);
  });

  test("a deferred event is handled when it arrives again after its handler exists", async () => {
    const stripe = stripeFake({});
    const sql = createEphemeralSql();
    const handled: string[] = [];
    const context: PaymentEventContext = {
      sql,
      clock: () => NOW,
      credit: async () => "credited",
      creditedFunding: async () => new Set(),
    };
    const client = createStripeClient({ secretKey: KEY, fetch: stripe.fetch });
    const before = createStripeEvents({ client, webhook: { secret: SECRET } }, context);
    const after = createStripeEvents(
      {
        client,
        webhook: { secret: SECRET },
        handlers: {
          "charge.refunded": async (refund) => {
            handled.push(String(refund.objectId));
            return { outcome: "ignored", detail: "refund_recorded" };
          },
        },
      },
      context,
    );
    const body = event("charge.refunded", { id: "ch_test_1", object: "charge" });
    const payload = new TextEncoder().encode(body);
    const signature = sign(body);
    expect(await before.receive?.({ payload, signature })).toMatchObject({
      outcome: "deferred",
      duplicate: false,
    });
    expect(await before.receive?.({ payload, signature })).toMatchObject({ duplicate: true });
    expect(await after.receive?.({ payload, signature })).toMatchObject({
      outcome: "ignored",
      detail: "refund_recorded",
      duplicate: false,
    });
    expect(await after.receive?.({ payload, signature })).toMatchObject({ duplicate: true });
    expect(handled).toEqual(["ch_test_1"]);
  });
});
