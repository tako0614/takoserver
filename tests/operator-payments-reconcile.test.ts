import { beforeEach, describe, expect, test } from "bun:test";
import { workerCredentials } from "../src/entry-worker.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import {
  buildApp,
  createEphemeralSql,
  createMemoryObjectStore,
  InMemoryTakoformResourceDriver,
} from "../src/index.ts";
import { createLedger } from "../src/ledger.ts";
import { openApiDocument } from "../src/openapi.ts";
import {
  createOperatorPaymentsReconcileVerifier,
  OPERATOR_PAYMENTS_RECONCILE_SINGLE_USE_NAMESPACE,
} from "../src/operator-credentials.ts";
import { signOperatorAssertion } from "../src/operator-key.ts";
import type {
  FundingReconcileReport,
  PaymentEventContext,
  PaymentEvents,
} from "../src/payment-events.ts";
import { resolvePayment } from "../src/payment-setup.ts";
import type { Sql } from "../src/ports.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

/**
 * The on-demand reconcile route moves money across every organization, so
 * each guard on its credential gets a test that fails when it is removed: the
 * operator key, the purpose, the Host audience, the one-minute lifetime, the
 * exact claim set, single use, and that no session or API key stands in for it.
 */

const ORIGIN = "https://api.takoserver.test";
const PATH = "/v1/operator/payments/reconcile";
const ORG = "org_068e6b5ea58b4f8da5262274f869bce1";
const UNKNOWN_ORG = "org_9a8b7c6d5e4f4f8da5262274f869bce3";
const STRIPE_KEY = "sk_test_reconcile_route";
const START = Date.UTC(2026, 9, 14, 12, 0, 0);

let now = START;
const clock = () => new Date(now);
const nowSeconds = () => Math.floor(now / 1_000);

interface KeyPair {
  readonly publicJwk: { readonly kty: string; readonly crv: string; readonly x: string };
  readonly privateJwk: string;
}

let operator: KeyPair;

beforeEach(async () => {
  now = START;
  operator = await keyPair();
});

async function keyPair(): Promise<KeyPair> {
  const pair = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
    "sign",
    "verify",
  ])) as CryptoKeyPair;
  const publicJwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
  return {
    publicJwk: { kty: "OKP", crv: "Ed25519", x: String(publicJwk.x) },
    privateJwk: JSON.stringify(await crypto.subtle.exportKey("jwk", pair.privateKey)),
  };
}

const RECONCILE = { purpose: "payments-reconcile", aud: ORIGIN };

async function sign(
  claims: Record<string, unknown> = {},
  options: { readonly key?: KeyPair; readonly lifetimeSeconds?: number; readonly at?: number } = {},
): Promise<string> {
  return await signOperatorAssertion({
    privateJwk: (options.key ?? operator).privateJwk,
    claims: { ...RECONCILE, jti: crypto.randomUUID(), ...claims },
    nowSeconds: options.at ?? nowSeconds(),
    lifetimeSeconds: options.lifetimeSeconds ?? 60,
  });
}

type Session = Record<string, unknown>;

function paid(organizationId: string, id: string, amountMinor: number, age: number): Session {
  return {
    id,
    object: "checkout.session",
    status: "complete",
    mode: "payment",
    payment_status: "paid",
    amount_total: amountMinor,
    currency: "usd",
    created: nowSeconds() - age,
    payment_intent: {
      object: "payment_intent",
      status: "succeeded",
      latest_charge: { object: "charge", refunded: false, amount_refunded: 0, disputed: false },
    },
    metadata: { organizationId, takoserverPurpose: "wallet_funding" },
  };
}

/** Stripe's Checkout Session listing, newest first, optionally held until released. */
function stripeFake(sessions: readonly Session[]) {
  const listings: string[] = [];
  const state = { unavailable: false };
  let hold: Promise<void> | null = null;
  let release = () => {};
  const fetch = async (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/v1/checkout/sessions") {
      return new Response("unexpected", { status: 400 });
    }
    listings.push(url.search);
    if (hold) await hold;
    if (state.unavailable) return new Response("upstream down", { status: 500 });
    return Response.json({
      object: "list",
      data: [...sessions].sort((left, right) => Number(right.created) - Number(left.created)),
      has_more: false,
    });
  };
  return {
    fetch,
    listings,
    state,
    holdListings() {
      hold = new Promise((resolve) => {
        release = () => {
          hold = null;
          resolve();
        };
      });
    },
    releaseListings: () => release(),
  };
}

async function host(
  options: {
    readonly sessions?: readonly Session[];
    readonly stripe?: boolean;
    readonly operatorKey?: boolean;
    /** The Bun Host shares one pass; a Worker composition leaves this unset. */
    readonly share?: boolean;
    /** Replaces the processor's pass, to hold one open forever. */
    readonly paymentEvents?: (context: PaymentEventContext) => PaymentEvents;
    /** Fails every write to the single-use replay cache. */
    readonly replayCacheDown?: boolean;
  } = {},
) {
  const stripe = stripeFake(options.sessions ?? []);
  const base = createEphemeralSql();
  const sql: Sql = options.replayCacheDown
    ? {
        query: (statement, parameters) => base.query(statement, parameters),
        batch: (statements) => base.batch(statements),
        run: (statement, parameters) =>
          statement.includes("runtime_grant_replays")
            ? Promise.reject(new Error("replay cache unavailable"))
            : base.run(statement, parameters),
      }
    : base;
  await sql.run("INSERT INTO orgs (id, name, owner_principal_id, created_at) VALUES (?, ?, ?, ?)", [
    ORG,
    "Funded",
    "prn_owner",
    clock().toISOString(),
  ]);
  const payment = resolvePayment({
    ...(options.stripe === false ? {} : { stripeSecretKey: STRIPE_KEY }),
    consoleOrigin: "https://console.takoserver.test",
    fetch: stripe.fetch,
  });
  const identity = resolveIdentity({
    operatorPublicKeyJwk: operator.publicJwk,
    operatorAudience: ORIGIN,
    clock,
  });
  const app = buildApp({
    v2: TEST_TAKOFORM_V2_CONFIG,
    sql,
    clock,
    objects: createMemoryObjectStore(),
    identity: identity.verifier,
    identityProviders: identity.providers,
    settlement: payment.settlement ?? {
      async verify(): Promise<never> {
        throw new Error("settlement is not configured");
      },
    },
    ...(payment.checkout ? { checkout: payment.checkout } : {}),
    ...(options.paymentEvents
      ? { paymentEvents: options.paymentEvents }
      : payment.events
        ? { paymentEvents: payment.events }
        : {}),
    ...(options.share ? { shareReconcilePass: true } : {}),
    ...(options.operatorKey === false
      ? {}
      : {
          operatorPaymentsReconcile: createOperatorPaymentsReconcileVerifier({
            publicKeyJwk: operator.publicJwk,
            audience: ORIGIN,
            clock,
          }),
        }),
    publicOrigin: ORIGIN,
    forms: [],
    hostForms: [],
    driver: new InMemoryTakoformResourceDriver(),
    offerings: [],
  });
  const ledger = createLedger(sql, clock);
  async function call(
    path: string,
    init: { readonly method?: string; readonly body?: unknown; readonly bearer?: string } = {},
  ): Promise<{ readonly status: number; readonly text: string; readonly headers: Headers }> {
    const headers: Record<string, string> = {};
    if (init.body !== undefined) headers["content-type"] = "application/json";
    if (init.bearer !== undefined) headers.authorization = `Bearer ${init.bearer}`;
    const response = await app.fetch(
      new Request(`${ORIGIN}${path}`, {
        method: init.method ?? "POST",
        headers,
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
      }),
    );
    return { status: response.status, text: await response.text(), headers: response.headers };
  }
  return {
    app,
    sql,
    stripe,
    call,
    reconcile: (assertion: string) => call(PATH, { body: { assertion } }),
    balance: async (organizationId: string) => (await ledger.wallet(organizationId)).settledMicros,
    fundingRows: async () => await sql.query("SELECT ref FROM ledger WHERE type = 'funding'"),
  };
}

function errorCode(text: string): string | undefined {
  return (JSON.parse(text) as { error?: { code?: string } }).error?.code;
}

describe("operator payment reconcile route", () => {
  test("an operator assertion runs the scheduled pass and returns its report", async () => {
    const h = await host({
      sessions: [
        paid(ORG, "cs_route_paid", 2_500, 60),
        paid(UNKNOWN_ORG, "cs_route_foreign", 77_777, 120),
      ],
    });
    const response = await h.reconcile(await sign());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(JSON.parse(response.text)).toEqual({
      report: {
        examined: 2,
        credited: 1,
        alreadyCredited: 0,
        unknownOrganization: 1,
        skipped: {},
        truncated: false,
        creditedFundingRefs: ["stripe:cs_route_paid"],
        uncredited: [{ fundingRef: "stripe:cs_route_foreign", reason: "unknown_organization" }],
      },
    });
    // Funding references and reasons only: no amount, organization or secret.
    expect(response.text).not.toContain(STRIPE_KEY);
    expect(response.text).not.toContain(UNKNOWN_ORG);
    expect(response.text).not.toContain(ORG);
    expect(response.text).not.toContain("77777");
    expect(await h.balance(ORG)).toBe(25_000_000);
    expect(h.stripe.listings).toHaveLength(1);

    // The published response schema names exactly the fields the pass reports.
    const schemas = openApiDocument.components.schemas as unknown as Record<
      string,
      { required: string[]; additionalProperties: boolean }
    >;
    const report = (JSON.parse(response.text) as { report: Record<string, unknown> }).report;
    expect([...(schemas.FundingReconcileReport?.required ?? [])].sort()).toEqual(
      Object.keys(report).sort(),
    );
    expect(schemas.FundingReconcileReport?.additionalProperties).toBe(false);
  });

  test("a repeat with a fresh assertion credits nothing twice", async () => {
    const h = await host({ sessions: [paid(ORG, "cs_route_once", 1_200, 60)] });
    expect((await h.reconcile(await sign())).status).toBe(200);
    const second = await h.reconcile(await sign());
    expect(second.status).toBe(200);
    expect(JSON.parse(second.text).report).toMatchObject({
      examined: 1,
      credited: 0,
      alreadyCredited: 1,
      creditedFundingRefs: [],
    });
    // The scheduled pass meets the same reference and credits nothing either.
    expect(await h.app.reconcilePayments()).toMatchObject({ credited: 0, alreadyCredited: 1 });
    expect(await h.fundingRows()).toEqual([{ ref: "stripe:cs_route_once" }]);
    expect(await h.balance(ORG)).toBe(12_000_000);
  });

  test("an assertion runs one pass; its replay is refused before Stripe is read", async () => {
    const h = await host({ sessions: [paid(ORG, "cs_route_replay", 900, 60)] });
    const assertion = await sign();
    expect((await h.reconcile(assertion)).status).toBe(200);
    const replay = await h.reconcile(assertion);
    expect(replay.status).toBe(401);
    expect(errorCode(replay.text)).toBe("unauthenticated");
    expect(h.stripe.listings).toHaveLength(1);
    const spent = await h.sql.query("SELECT grant_id FROM runtime_grant_replays");
    expect(spent.map((row) => String(row.grant_id))).toEqual([
      expect.stringMatching(
        new RegExp(`^${OPERATOR_PAYMENTS_RECONCILE_SINGLE_USE_NAMESPACE}:sha256:[0-9a-f]{64}$`),
      ),
    ]);
  });

  test("a pass that cannot read Stripe is retryable, credits nothing and spends its assertion", async () => {
    const h = await host({ sessions: [paid(ORG, "cs_route_outage", 600, 60)] });
    h.stripe.state.unavailable = true;
    const assertion = await sign();
    const failed = await h.reconcile(assertion);
    // The same retryable answer the webhook gives for the same outage.
    expect(failed.status).toBe(503);
    expect(errorCode(failed.text)).toBe("unavailable");
    expect(failed.text).not.toContain(STRIPE_KEY);
    expect(await h.balance(ORG)).toBe(0);
    h.stripe.state.unavailable = false;
    expect((await h.reconcile(assertion)).status).toBe(401);
    // A fresh assertion runs the next pass, which credits the payment once.
    expect((await h.reconcile(await sign())).status).toBe(200);
    expect(await h.balance(ORG)).toBe(6_000_000);
  });

  test("refuses every assertion that is not exactly a fresh reconcile one from the operator", async () => {
    const h = await host({ sessions: [paid(ORG, "cs_route_refused", 500, 60)] });
    const stranger = await keyPair();
    const refused: Record<string, string> = {
      "another key": await sign({}, { key: stranger }),
      "sign-in purpose": await sign({
        purpose: "sign-in",
        provider: "google",
        subject: "operator",
        email: "operator@example.com",
        displayName: "Operator",
      }),
      "funding purpose": await sign({
        purpose: "funding",
        organizationId: ORG,
        fundingRef: "operator-credit",
        amountMinor: 500,
        currency: "USD",
      }),
      "the same claims for another purpose": await sign({ purpose: "funding" }),
      "another audience": await sign({ aud: "https://api.elsewhere.test" }),
      "no audience": await sign({ aud: undefined }),
      expired: await sign({}, { at: nowSeconds() - 120 }),
      "longer than a minute": await sign({}, { lifetimeSeconds: 61 }),
      "issued in the future": await sign({}, { at: nowSeconds() + 120 }),
      "no nonce": await sign({ jti: undefined }),
      "short nonce": await sign({ jti: "abc" }),
      "an extra claim": await sign({ organizationId: ORG }),
      "not an assertion": "not-an-assertion",
    };
    for (const [name, assertion] of Object.entries(refused)) {
      const response = await h.reconcile(assertion);
      expect({ name, status: response.status, code: errorCode(response.text) }).toEqual({
        name,
        status: 401,
        code: "unauthenticated",
      });
    }
    expect(h.stripe.listings).toEqual([]);
    expect(await h.balance(ORG)).toBe(0);
    // Nothing refused was spent, so nothing refused can block a later pass.
    expect(await h.sql.query("SELECT grant_id FROM runtime_grant_replays")).toEqual([]);
  });

  test("no session or API key runs the pass, even the operator's own", async () => {
    const h = await host({ sessions: [paid(ORG, "cs_route_session", 500, 60)] });
    const signIn = await h.call("/v1/sessions", {
      body: {
        provider: "google",
        method: "operator-assertion",
        assertion: await signOperatorAssertion({
          privateJwk: operator.privateJwk,
          claims: {
            purpose: "sign-in",
            aud: ORIGIN,
            provider: "google",
            subject: "operator",
            email: "operator@example.com",
            displayName: "Operator",
          },
          nowSeconds: nowSeconds(),
          lifetimeSeconds: 600,
        }),
      },
    });
    expect(signIn.status).toBe(200);
    const session = String(JSON.parse(signIn.text).sessionToken);
    const created = await h.call("/v1/organizations", { body: { name: "Owned" }, bearer: session });
    expect(created.status).toBe(201);
    const organizationId = String(JSON.parse(created.text).organization.id);
    const minted = await h.call(`/v1/organizations/${organizationId}/api-keys`, {
      body: {
        name: "every-scope",
        scopes: ["wallet:write", "wallet:read", "usage:write", "resources:write"],
        expiresInSeconds: 3_600,
      },
      bearer: session,
    });
    expect(minted.status).toBe(201);
    const apiKey = String(JSON.parse(minted.text).secret);

    for (const bearer of [session, apiKey]) {
      const bare = await h.call(PATH, { bearer });
      expect(bare.status).toBe(400);
      const empty = await h.call(PATH, { bearer, body: {} });
      expect(empty.status).toBe(400);
      const asAssertion = await h.call(PATH, { bearer, body: { assertion: bearer } });
      expect(asAssertion.status).toBe(401);
      expect(errorCode(asAssertion.text)).toBe("unauthenticated");
    }
    expect(h.stripe.listings).toEqual([]);
    expect(await h.balance(ORG)).toBe(0);
  });

  test("is not served where the pass or the operator key is not configured", async () => {
    for (const options of [{ stripe: false }, { operatorKey: false }] as const) {
      const h = await host({ ...options, sessions: [paid(ORG, "cs_route_absent", 500, 60)] });
      const assertion = await sign();
      const response = await h.reconcile(assertion);
      expect({ options, status: response.status }).toEqual({ options, status: 404 });
      expect(errorCode(response.text)).toBe("not_found");
      // Refused before the credential is read, so it was not spent here.
      expect(await h.sql.query("SELECT grant_id FROM runtime_grant_replays")).toEqual([]);
      expect(h.stripe.listings).toEqual([]);
    }
    const configured = await host();
    for (const method of ["GET", "PUT", "DELETE"]) {
      expect((await configured.call(PATH, { method })).status).toBe(404);
    }
  });

  test("on the Bun Host a request arriving mid-pass joins it instead of reading Stripe again", async () => {
    const h = await host({ share: true, sessions: [paid(ORG, "cs_route_shared", 800, 60)] });
    h.stripe.holdListings();
    // The scheduled pass is reading Stripe when both operator requests arrive.
    const scheduled = h.app.reconcilePayments();
    const first = h.reconcile(await sign());
    const second = h.reconcile(await sign());
    const spent = async () =>
      (await h.sql.query("SELECT grant_id FROM runtime_grant_replays")).length;
    for (let turn = 0; turn < 200 && (await spent()) < 2; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    for (let turn = 0; turn < 5; turn += 1) await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.stripe.listings).toHaveLength(1);
    h.stripe.releaseListings();
    const [one, two, cron] = await Promise.all([first, second, scheduled]);
    expect(one.status).toBe(200);
    expect(two.status).toBe(200);
    expect(JSON.parse(one.text).report).toEqual(JSON.parse(two.text).report);
    expect(cron).toEqual(JSON.parse(one.text).report);
    expect(h.stripe.listings).toHaveLength(1);
    expect(await h.balance(ORG)).toBe(8_000_000);
    // Once that pass has finished, the next request starts a new one.
    expect((await h.reconcile(await sign())).status).toBe(200);
    expect(h.stripe.listings).toHaveLength(2);
  });
});

describe("a pass that never settles", () => {
  const REPORT: FundingReconcileReport = {
    examined: 0,
    credited: 0,
    alreadyCredited: 0,
    unknownOrganization: 0,
    skipped: {},
    truncated: false,
    creditedFundingRefs: [],
    uncredited: [],
  };

  /** The first pass hangs forever, as one whose request was canceled mid-I/O can. */
  function stuckFirstPass() {
    let passes = 0;
    return {
      passes: () => passes,
      paymentEvents: (): PaymentEvents => ({
        reconcile() {
          passes += 1;
          return passes === 1
            ? new Promise<FundingReconcileReport>(() => {})
            : Promise.resolve(REPORT);
        },
      }),
    };
  }

  async function settlesWithin<T>(work: Promise<T>, milliseconds = 2_000): Promise<T | "hung"> {
    return await Promise.race([
      work,
      new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), milliseconds)),
    ]);
  }

  test("does not block a later Worker invocation, from the route or the schedule", async () => {
    const stuck = stuckFirstPass();
    const h = await host({ paymentEvents: stuck.paymentEvents });
    // The canceled request's pass: started, and never settling.
    void h.app.reconcilePayments();
    const route = await settlesWithin(h.reconcile(await sign()));
    expect(route === "hung" ? "hung" : route.status).toBe(200);
    expect(await settlesWithin(h.app.reconcilePayments())).toEqual(REPORT);
    expect(stuck.passes()).toBe(3);
  });

  test("the Bun Host, which may share, still joins its own pass", async () => {
    const stuck = stuckFirstPass();
    const h = await host({ share: true, paymentEvents: stuck.paymentEvents });
    void h.app.reconcilePayments();
    expect(await settlesWithin(h.app.reconcilePayments(), 100)).toBe("hung");
    expect(stuck.passes()).toBe(1);
  });
});

describe("a replay cache that cannot record the assertion", () => {
  test("fails closed and runs no pass", async () => {
    const h = await host({
      replayCacheDown: true,
      sessions: [paid(ORG, "cs_route_unrecorded", 400, 60)],
    });
    const response = await h.reconcile(await sign());
    expect(response.status).toBe(500);
    expect(errorCode(response.text)).toBe("internal_error");
    expect(h.stripe.listings).toEqual([]);
    expect(await h.balance(ORG)).toBe(0);
  });
});

describe("Worker composition of the reconcile authority", () => {
  const identityKey = () => JSON.stringify(operator.publicJwk);

  test("serves the route only beside Stripe funding and an operator identity key", () => {
    const stripe = {
      STRIPE_SECRET_KEY: STRIPE_KEY,
      TAKOSERVER_STRIPE_CHECKOUT_ENABLED: "1",
      TAKOSERVER_CONSOLE_ORIGIN: "https://console.takoserver.test",
    };
    expect(
      workerCredentials({ ...stripe, OPERATOR_IDENTITY_PUBLIC_JWK: identityKey() }, ORIGIN)
        .operatorPaymentsReconcile,
    ).toBeDefined();
    expect(
      workerCredentials({ OPERATOR_IDENTITY_PUBLIC_JWK: identityKey() }, ORIGIN)
        .operatorPaymentsReconcile,
    ).toBeUndefined();
    expect(workerCredentials(stripe, ORIGIN).operatorPaymentsReconcile).toBeUndefined();
  });

  test("the identity-only key that cannot fund can trigger the pass", async () => {
    const verifier = workerCredentials(
      {
        STRIPE_SECRET_KEY: STRIPE_KEY,
        TAKOSERVER_STRIPE_CHECKOUT_ENABLED: "1",
        OPERATOR_IDENTITY_PUBLIC_JWK: identityKey(),
      },
      ORIGIN,
    ).operatorPaymentsReconcile;
    if (!verifier) throw new Error("reconcile authority was not composed");
    now = Date.now();
    await expect(verifier.verify(await sign())).resolves.toMatchObject({
      namespace: OPERATOR_PAYMENTS_RECONCILE_SINGLE_USE_NAMESPACE,
    });
  });
});
