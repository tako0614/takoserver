import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharedPricing from "../config/shared-hosted-pricing.json";
import { createAccounts } from "../src/auth.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import {
  createWorkerEntry,
  type WorkerEnv,
  WorkerStartupError,
  workerCredentials,
} from "../src/entry-worker.ts";
import { HostedBillingRealmError } from "../src/hosted-billing-realm.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { migrateSqlite } from "../src/migrate-sqlite.ts";
import type { SqlParam } from "../src/ports.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";

const ORIGIN = "https://api.integration.example.test";
const ACCOUNT = "acct_entrySelection";
const AUTHORITY = "entry-selection-local-fixture";
const SECRET = "sk_test_entry_selection_local_fixture";
const compiled = {
  ...sharedPricing,
  plans: sharedPricing.plans.map((plan, index) => ({
    ...plan,
    stripePriceId: `price_entrySelection${index}`,
  })),
};
const pricing = compilePricingAuthoring({
  authoringVersion: 2,
  sharedPricing: compiled,
  planIds: { free: "free", usage: "usage" },
  billingConfig: {
    schemaVersion: 1,
    revision: compiled.revision,
    effectiveAt: "2026-10-01T00:00:00.000Z",
    currency: "USD",
    holdTtlSeconds: 300,
    freeIncludedMinor: 150,
    purchaseCreditExpiry: { kind: "none" },
    plans: Object.fromEntries(
      compiled.plans.map((plan) => [
        plan.planId,
        {
          includedMinor: Number(BigInt(plan.includedMicros) / 10000n),
          stripePriceId: plan.stripePriceId,
        },
      ]),
    ),
    meters: Object.fromEntries(
      Object.entries(compiled.meters)
        .filter(([, meter]) => meter.cloudflareCostMicros !== "0")
        .map(([name, meter]) => [
          name,
          {
            unit: meter.unit,
            rate: {
              numeratorMicros: (BigInt(meter.cloudflareCostMicros) * 3n).toString(),
              denominator: meter.quantity,
            },
          },
        ]),
    ),
  },
  checkout: { minimumMinor: 50, maximumMinor: 10000 },
});

function fixture(options: { accountPin?: boolean; modePin?: boolean; schemaCount?: number } = {}) {
  const db = new Database(":memory:");
  for (const migration of MIGRATIONS.slice(0, options.schemaCount)) db.exec(migration.sql);
  if (options.modePin !== false)
    db.exec("INSERT INTO stripe_mode_realm VALUES (1, 'test', '2026-10-15T00:00:00.000Z')");
  if (
    options.accountPin !== false &&
    (options.schemaCount === undefined || options.schemaCount >= 99)
  )
    db.query(
      "INSERT INTO stripe_billing_account_realms VALUES (1, ?, 'test', ?, '2026-10-15T00:00:00.000Z')",
    ).run(ACCOUNT, AUTHORITY);
  const queries: string[] = [];
  const state = {
    prepare(query: string) {
      queries.push(query);
      let values: readonly SqlParam[] = [];
      return {
        bind(...params: readonly SqlParam[]) {
          values = params;
          return this;
        },
        async all() {
          const statement = db.query(query);
          const args = values.map((value) =>
            value instanceof ArrayBuffer ? new Uint8Array(value) : value,
          );
          return { results: statement.all(...args) };
        },
      };
    },
    async batch(statements: readonly { all(): Promise<unknown> }[]) {
      return await Promise.all(statements.map((statement) => statement.all()));
    },
  };
  const env = {
    PUBLIC_ORIGIN: ORIGIN,
    STATE_DB: state,
    OBJECTS: {
      put: () => null,
      get: () => null,
      head: () => null,
      delete: () => null,
      list: () => null,
    },
    WORKER_VERSION: { id: "00000000-0000-4000-8000-0000000000a1" },
    TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
      documentation: "https://docs.example.invalid/takoform-v2",
      authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
    }),
    TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: "A".repeat(43),
    TAKOSERVER_HOSTED_BILLING: "canonical-test",
    TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID: ACCOUNT,
    TAKOSERVER_HOSTED_BILLING_AUTHORITY: AUTHORITY,
    TAKOSERVER_STRIPE_MODE: "test",
    TAKOSERVER_STRIPE_CHECKOUT_ENABLED: "1",
    TAKOSERVER_STRIPE_WEBHOOK_ENABLED: "1",
    STRIPE_SECRET_KEY: SECRET,
    STRIPE_WEBHOOK_SECRET: "whsec_entry_selection_local_fixture",
    TAKOSERVER_CONSOLE_ORIGIN: "https://console.example.test",
    ...pricing.environment,
  } as unknown as WorkerEnv;
  const changes = () =>
    (db.query("SELECT total_changes() AS count").get() as { count: number }).count;
  return { db, env, queries, changes };
}

function remoteFixture(
  options: { nativeAccount?: string; livePrice?: boolean; wrongAmount?: boolean } = {},
) {
  const requests: Request[] = [];
  const fetch = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (
        input: Parameters<typeof globalThis.fetch>[0],
        init?: Parameters<typeof globalThis.fetch>[1],
      ) => {
        const request = input instanceof Request ? input : new Request(input, init);
        requests.push(request);
        const url = new URL(request.url);
        if (request.method !== "GET") throw new Error("startup attempted a native mutation");
        expect(request.headers.get("authorization")).toBe(`Bearer ${SECRET}`);
        expect(request.headers.get("stripe-account")).toBeNull();
        if (url.pathname === "/v1/account")
          return Response.json({ id: options.nativeAccount ?? ACCOUNT, object: "account" });
        const price = compiled.plans.find(
          (plan) => url.pathname === `/v1/prices/${plan.stripePriceId}`,
        );
        if (!price) throw new Error(`unexpected remote read ${url.pathname}`);
        return Response.json({
          id: price.stripePriceId,
          object: "price",
          livemode: options.livePrice ?? false,
          active: true,
          currency: "usd",
          unit_amount: options.wrongAmount ? 42 : Number(BigInt(price.monthlyPriceMicros) / 10000n),
          type: "recurring",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      },
      {
        preconnect() {
          throw new Error("startup attempted an unexpected native preconnect");
        },
      },
    ),
  );
  return { requests, restore: () => fetch.mockRestore() };
}

async function localOwner(f: Pick<ReturnType<typeof fixture>, "db">) {
  const accounts = createAccounts({
    sql: createSqliteSql(f.db),
    clock: () => new Date(),
    randomSecret: () => "test_only_entry_selection_session",
    identity: {
      async verify({ assertion }) {
        return {
          providerSubject: assertion,
          email: "entry@example.test",
          displayName: "Entry fixture",
        };
      },
    },
  });
  const session = await accounts.signIn({ provider: "google", assertion: "entry-selection-owner" });
  const actor = await accounts.authenticate(`Bearer ${session.sessionToken}`);
  if (!actor) throw new Error("fixture session unavailable");
  const organization = await accounts.createOrganization({ actor, name: "Entry fixture" });
  return new Request(`${ORIGIN}/v1/organizations/${organization.id}/payments/subscription`, {
    headers: { authorization: `Bearer ${session.sessionToken}` },
  });
}

test("unselected entry preserves legacy public subscription shape and bypasses new realm authentication", async () => {
  for (const selection of [undefined, ""]) {
    const f = fixture({ accountPin: false });
    const remote = remoteFixture();
    try {
      const env = { ...f.env, TAKOSERVER_HOSTED_BILLING: selection } as WorkerEnv;
      const request = await localOwner(f);
      const credentials = workerCredentials(env, ORIGIN);
      expect(credentials.checkout).toBeUndefined();
      expect(credentials.paymentEvents).toBeDefined();
      const standaloneCredentials = workerCredentials(
        {
          ...env,
          TAKOSERVER_HOSTED_PRICING: undefined,
          TAKOSERVER_BILLING_CONFIG: undefined,
        } as unknown as WorkerEnv,
        ORIGIN,
      );
      expect(standaloneCredentials.checkout).toBeDefined();
      expect(standaloneCredentials.checkout?.referenceRequired).toBeUndefined();
      const response = await createWorkerEntry().fetch(request, env);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        subscription: null,
        planTable: pricing.hostedPlanTable,
      });
      expect(remote.requests).toEqual([]);
    } finally {
      remote.restore();
      f.db.close();
    }
  }
});

test("unselected legacy Worker payment flags retain the existing key and webhook gates", async () => {
  const f = fixture();
  const remote = remoteFixture();
  try {
    for (const checkout of [undefined, "0", "1"]) {
      for (const webhook of [undefined, "0", "1"]) {
        const env = {
          ...f.env,
          TAKOSERVER_HOSTED_BILLING: undefined,
          TAKOSERVER_HOSTED_PRICING: undefined,
          TAKOSERVER_BILLING_CONFIG: undefined,
          TAKOSERVER_STRIPE_CHECKOUT_ENABLED: checkout,
          TAKOSERVER_STRIPE_WEBHOOK_ENABLED: webhook,
        } as unknown as WorkerEnv;
        const credentials = workerCredentials(env, ORIGIN);
        expect(Boolean(credentials.checkout)).toBe(checkout === "1");
        expect(Boolean(credentials.paymentEvents)).toBe(checkout === "1");
        const response = await createWorkerEntry().fetch(
          new Request(`${ORIGIN}/v1/payments/stripe/webhook`, { method: "POST", body: "{}" }),
          env,
        );
        expect(response.status).toBe(checkout === "1" && webhook === "1" ? 400 : 404);
      }
    }
    expect(remote.requests).toEqual([]);
  } finally {
    remote.restore();
    f.db.close();
  }
});

test("selected invalid or incomplete startup refuses before durable binding access or processor effects", async () => {
  for (const overrides of [
    { TAKOSERVER_HOSTED_BILLING: "canonical-live" },
    { TAKOSERVER_HOSTED_BILLING: " canonical-test" },
    { TAKOSERVER_STRIPE_MODE: "live" },
    { TAKOSERVER_STRIPE_MODE: undefined },
    { TAKOSERVER_STRIPE_MODE: "" },
    { TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID: undefined },
    { TAKOSERVER_HOSTED_BILLING_AUTHORITY: undefined },
    { STRIPE_SECRET_KEY: undefined },
    { STRIPE_SECRET_KEY: "sk_live_local_fixture_refused" },
    { STRIPE_WEBHOOK_SECRET: undefined },
    { STRIPE_WEBHOOK_SECRET: "invalid-local-webhook-fixture" },
    { TAKOSERVER_CONSOLE_ORIGIN: undefined },
    { TAKOSERVER_CONSOLE_ORIGIN: "https://console.example.test/path" },
    { TAKOSERVER_CONSOLE_ORIGIN: "https://user@console.example.test" },
    { TAKOSERVER_CONSOLE_ORIGIN: "not-an-origin" },
    { TAKOSERVER_STRIPE_WEBHOOK_TOLERANCE_SECONDS: "garbage" },
    { TAKOSERVER_STRIPE_CHECKOUT_MINIMUM_MINOR: "100" },
    { TAKOSERVER_STRIPE_CHECKOUT_MAXIMUM_MINOR: "20000" },
    { TAKOSERVER_HOSTED_PRICING: undefined },
    { TAKOSERVER_BILLING_CONFIG: undefined },
    { TAKOSERVER_HOSTED_PRICING: "{}" },
  ]) {
    const f = fixture();
    const remote = remoteFixture();
    try {
      const before = f.changes();
      let accesses = 0;
      const env = {
        ...f.env,
        ...overrides,
        get STATE_DB(): never {
          accesses++;
          throw new Error("unexpected durable access");
        },
      } as WorkerEnv;
      const response = await createWorkerEntry().fetch(new Request(`${ORIGIN}/healthz`), env);
      expect(response.status).toBe(503);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.text();
      expect(body).not.toContain("unexpected durable access");
      expect(body).not.toContain(SECRET);
      expect(accesses).toBe(0);
      expect(f.changes()).toBe(before);
      expect(remote.requests).toEqual([]);
    } finally {
      remote.restore();
      f.db.close();
    }
  }
});

test("selected unbound, mismatched or incomplete schema refuses read-only without creating tariff or pins", async () => {
  for (const scenario of [
    "mode-unbound",
    "account-unbound",
    "authority-mismatch",
    "account-mismatch",
    "missing-immutability",
    "missing-extension",
  ] as const) {
    const f = fixture({
      modePin: scenario !== "mode-unbound",
      accountPin: scenario !== "account-unbound",
      ...(scenario === "missing-extension" ? { schemaCount: 98 } : {}),
    });
    const remote = remoteFixture();
    try {
      if (scenario === "missing-immutability")
        f.db.exec("DROP TRIGGER stripe_billing_account_realms_no_update");
      const env = {
        ...f.env,
        ...(scenario === "authority-mismatch"
          ? { TAKOSERVER_HOSTED_BILLING_AUTHORITY: "wrong-selected-authority" }
          : {}),
        ...(scenario === "account-mismatch"
          ? { TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID: "acct_wrongSelected" }
          : {}),
      };
      const before = f.changes();
      const response = await createWorkerEntry().fetch(new Request(`${ORIGIN}/healthz`), env);
      expect(response.status).toBe(503);
      expect(f.changes()).toBe(before);
      expect(f.db.query("SELECT * FROM org_wallet_pricing_revisions").all()).toEqual([]);
      expect(remote.requests).toEqual([]);
      expect(f.queries.every((query) => /^(SELECT|PRAGMA)\b/iu.test(query.trim()))).toBe(true);
    } finally {
      remote.restore();
      f.db.close();
    }
  }
});

test("selected wrong native account, LIVE price or mismatched amount refuses without mutations", async () => {
  for (const options of [
    { nativeAccount: "acct_wrongNative" },
    { livePrice: true },
    { wrongAmount: true },
  ]) {
    const f = fixture();
    const remote = remoteFixture(options);
    try {
      const before = f.changes();
      const response = await createWorkerEntry().fetch(new Request(`${ORIGIN}/healthz`), f.env);
      expect(response.status).toBe(503);
      expect(f.changes()).toBe(before);
      expect(f.db.query("SELECT * FROM org_wallet_pricing_revisions").all()).toEqual([]);
      expect(remote.requests.length).toBeGreaterThan(0);
      expect(remote.requests.every((request) => request.method === "GET")).toBe(true);
      expect(await response.text()).not.toContain("wrongNative");
    } finally {
      remote.restore();
      f.db.close();
    }
  }
});

test.each([undefined, "0", "1"])(
  "qualified canonical entry authenticates every price with one client when legacy flags are %s",
  async (flag) => {
    const f = fixture();
    const env = {
      ...f.env,
      TAKOSERVER_STRIPE_CHECKOUT_ENABLED: flag,
      TAKOSERVER_STRIPE_WEBHOOK_ENABLED: flag,
    } as unknown as WorkerEnv;
    const remote = remoteFixture();
    try {
      const request = await localOwner(f);
      const before = f.changes();
      const credentials = workerCredentials(env, ORIGIN);
      expect(credentials.checkout).toBeUndefined();
      expect(credentials.paymentEvents).toBeUndefined();
      const worker = createWorkerEntry();
      expect(
        (await worker.fetch(new Request(`${ORIGIN}/.well-known/takoserver`), env)).status,
      ).toBe(200);
      expect(f.changes()).toBe(before);
      expect(f.queries.every((query) => /^(SELECT|PRAGMA)\b/iu.test(query.trim()))).toBe(true);
      const response = await worker.fetch(request, env);
      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.billingCapabilities).toEqual({
        contractVersion: "hosted-billing-v1",
        topUps: true,
        subscriptionStart: true,
        subscriptionCancellation: true,
        subscriptionPlanChange: true,
      });
      expect(body.planTable).toEqual(pricing.hostedPlanTable);
      expect(remote.requests.map((request) => new URL(request.url).pathname)).toEqual([
        "/v1/account",
        ...compiled.plans.map((plan) => `/v1/prices/${plan.stripePriceId}`),
      ]);
      expect(f.db.query("SELECT * FROM org_wallet_pricing_revisions").all()).toEqual([]);
      expect(f.db.query("SELECT * FROM stripe_billing_account_realms").all()).toHaveLength(1);
      expect(f.db.query("SELECT * FROM ledger").all()).toEqual([]);
    } finally {
      remote.restore();
      f.db.close();
    }
  },
);

test("canonical realm refusal retains the original operator cause while HTTP exposes only the generic sentence", async () => {
  const f = fixture();
  const remote = remoteFixture({ nativeAccount: "acct_privateWrongNative" });
  try {
    const before = f.changes();
    const worker = createWorkerEntry();
    let thrown: unknown;
    try {
      await worker.scheduled({}, f.env);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(WorkerStartupError);
    if (!(thrown instanceof WorkerStartupError)) throw new Error("startup refusal absent");
    expect(thrown.reason).toBe("runtime-configuration");
    const generic = thrown.cause;
    expect(generic).toBeInstanceOf(TypeError);
    if (!(generic instanceof TypeError)) throw new Error("generic refusal cause absent");
    expect(generic.message).toBe(
      "Canonical Hosted billing requires the qualified TEST realm, prices and complete financial schema",
    );
    expect(generic.cause).toBeInstanceOf(HostedBillingRealmError);
    expect(generic.cause).toMatchObject({ code: "realm_mismatch" });
    const response = await worker.fetch(new Request(`${ORIGIN}/healthz`), f.env);
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.text();
    expect(body).toContain(generic.message);
    expect(body).not.toContain("realm_mismatch");
    expect(body).not.toContain("acct_privateWrongNative");
    expect(body).not.toContain(SECRET);
    expect(f.changes()).toBe(before);
    expect(remote.requests.every((request) => request.method === "GET")).toBe(true);
  } finally {
    remote.restore();
    f.db.close();
  }
});

test("failed startup is evicted so correcting the same binding object can qualify", async () => {
  const f = fixture({ accountPin: false });
  const remote = remoteFixture();
  try {
    const request = await localOwner(f);
    const worker = createWorkerEntry();
    expect((await worker.fetch(request.clone(), f.env)).status).toBe(503);
    expect(remote.requests).toEqual([]);
    f.db
      .query(
        "INSERT INTO stripe_billing_account_realms VALUES (1, ?, 'test', ?, '2026-10-15T00:00:00.000Z')",
      )
      .run(ACCOUNT, AUTHORITY);
    const before = f.changes();
    expect(
      (await worker.fetch(new Request(`${ORIGIN}/.well-known/takoserver`), f.env)).status,
    ).toBe(200);
    expect(f.changes()).toBe(before);
    expect(remote.requests).toHaveLength(1 + compiled.plans.length);
  } finally {
    remote.restore();
    f.db.close();
  }
});

test.each(["qualified", "foreign-account"] as const)(
  "the actual Bun entry cold start qualifies the selected realm or refuses %s without moving credit",
  async (scenario) => {
    const root = mkdtempSync(join(tmpdir(), "hosted-billing-entry-selection-"));
    const databasePath = join(root, "control.sqlite");
    const database = new Database(databasePath);
    migrateSqlite(database);
    database.exec("INSERT INTO stripe_mode_realm VALUES (1, 'test', '2026-10-15T00:00:00.000Z')");
    database
      .query(
        "INSERT INTO stripe_billing_account_realms VALUES (1, ?, 'test', ?, '2026-10-15T00:00:00.000Z')",
      )
      .run(ACCOUNT, AUTHORITY);
    const ownerRequest = await localOwner({ db: database });
    database.close();
    const reads: string[] = [];
    const stripe = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const path = new URL(request.url).pathname;
        reads.push(path);
        expect(request.method).toBe("GET");
        // The existing isolated-process preload strips the synthetic credential.
        expect(request.headers.get("authorization")).toBeNull();
        expect(request.headers.get("stripe-account")).toBeNull();
        if (path === "/v1/account")
          return Response.json({
            id: scenario === "qualified" ? ACCOUNT : "acct_foreignColdEntry",
            object: "account",
          });
        if (
          ["/v1/events", "/v1/invoices", "/v1/subscriptions", "/v1/checkout/sessions"].includes(
            path,
          )
        )
          return Response.json({ object: "list", data: [], has_more: false });
        const plan = compiled.plans.find((item) => path === `/v1/prices/${item.stripePriceId}`);
        if (!plan) return new Response("unexpected isolated native read", { status: 400 });
        return Response.json({
          id: plan.stripePriceId,
          object: "price",
          livemode: false,
          active: true,
          currency: "usd",
          unit_amount: Number(BigInt(plan.monthlyPriceMicros) / 10000n),
          type: "recurring",
          billing_scheme: "per_unit",
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      },
    });
    const listener = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(null, { status: 503 }),
    });
    const port = listener.port;
    await listener.stop(true);
    const child = Bun.spawn(
      [
        process.execPath,
        "--no-env-file",
        "--preload",
        join(import.meta.dir, "fixtures/subscription-entry-bun-auto-recovery-preload.ts"),
        join(import.meta.dir, "..", "src/entry-bun.ts"),
      ],
      {
        cwd: root,
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: {
          PATH: process.env.PATH ?? "/usr/bin:/bin",
          CI: "1",
          NO_COLOR: "1",
          PORT: String(port),
          TAKOSERVER_DATA_ROOT: root,
          TAKOSERVER_DB: databasePath,
          TAKOSERVER_PUBLIC_ORIGIN: ORIGIN,
          TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
            documentation: "https://docs.example.invalid/takoform-v2",
            authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
          }),
          TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: "A".repeat(43),
          TAKOSERVER_HOSTED_BILLING: "canonical-test",
          TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID: ACCOUNT,
          TAKOSERVER_HOSTED_BILLING_AUTHORITY: AUTHORITY,
          TAKOSERVER_STRIPE_MODE: "test",
          STRIPE_SECRET_KEY: SECRET,
          STRIPE_WEBHOOK_SECRET: "whsec_entry_selection_local_fixture",
          TAKOSERVER_CONSOLE_ORIGIN: "https://console.example.test",
          ...pricing.environment,
          AUTO_TEST_STRIPE_ORIGIN: `http://127.0.0.1:${stripe.port}`,
          AUTO_TEST_PAYMENT_AUDIT: join(root, "payment-timer.log"),
          AUTO_TEST_PAYMENT_INTERVAL_MS: "100",
        },
      },
    );
    const diagnostics = new Response(child.stderr).text();
    try {
      if (scenario === "foreign-account") {
        const exit = await Promise.race([child.exited, Bun.sleep(10_000).then(() => null)]);
        expect(exit).not.toBeNull();
        expect(exit).not.toBe(0);
        const output = await diagnostics;
        expect(output).toContain("realm_mismatch");
        expect(output).not.toContain(SECRET);
        expect(reads).toEqual(["/v1/account"]);
      } else {
        let ready = false;
        const deadline = Date.now() + 12_000;
        while (!ready && child.exitCode === null && Date.now() < deadline) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/_takoserver/health/ready`, {
              signal: AbortSignal.timeout(500),
            });
            await response.arrayBuffer();
            ready = response.status === 200;
          } catch {
            // The actual listener has not bound yet.
          }
          if (!ready) await Bun.sleep(50);
        }
        if (!ready && child.exitCode !== null)
          throw new Error(`isolated Bun cold entry exited: ${await diagnostics}`);
        expect(ready).toBe(true);
        const response = await fetch(
          `http://127.0.0.1:${port}${new URL(ownerRequest.url).pathname}`,
          { headers: ownerRequest.headers, signal: AbortSignal.timeout(2000) },
        );
        expect(response.status).toBe(200);
        const body = await response.json();
        expect(body.billingCapabilities).toEqual({
          contractVersion: "hosted-billing-v1",
          topUps: true,
          subscriptionStart: true,
          subscriptionCancellation: true,
          subscriptionPlanChange: true,
        });
        expect(body.planTable).toEqual(pricing.hostedPlanTable);
        expect(reads.slice(0, 1 + compiled.plans.length)).toEqual([
          "/v1/account",
          ...compiled.plans.map((plan) => `/v1/prices/${plan.stripePriceId}`),
        ]);
        const passDeadline = Date.now() + 5000;
        while (!reads.includes("/v1/invoices") && Date.now() < passDeadline) await Bun.sleep(25);
        expect(reads).toContain("/v1/invoices");
        const timer = await Bun.file(join(root, "payment-timer.log")).text();
        expect(timer.split("\n").filter((line) => line === "registered")).toHaveLength(1);
        expect(timer).toContain("tick");
      }
      const observed = new Database(databasePath, { readonly: true });
      try {
        expect(observed.query("SELECT * FROM ledger").all()).toEqual([]);
        expect(observed.query("SELECT * FROM org_wallet_pricing_revisions").all()).toEqual([]);
        expect(observed.query("SELECT * FROM stripe_billing_pricing").all()).toHaveLength(
          scenario === "qualified" ? 1 : 0,
        );
        expect(
          observed
            .query("SELECT account_id, billing_authority FROM stripe_billing_account_realms")
            .all(),
        ).toEqual([{ account_id: ACCOUNT, billing_authority: AUTHORITY }]);
      } finally {
        observed.close();
      }
    } finally {
      if (child.exitCode === null) {
        child.kill("SIGTERM");
        if ((await Promise.race([child.exited, Bun.sleep(5000).then(() => null)])) === null) {
          child.kill("SIGKILL");
          await child.exited;
        }
      }
      await diagnostics;
      await stripe.stop(true);
      rmSync(root, { recursive: true, force: true });
    }
  },
  60_000,
);
