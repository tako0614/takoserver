import { afterEach, describe, expect, spyOn, test } from "bun:test";
import * as financialRequestOrigin from "@takoserver/core/financial-request-origin";
import sharedPricing from "../config/shared-hosted-pricing.json";
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { type AppPorts, buildApp } from "../src/app.ts";
import {
  assertAuthTokenCaptureReader,
  assertRetainedDirectOwnerSessionReader,
  assertVerifiedLocalPrincipalIssuanceReader,
} from "../src/auth.ts";
import { additiveAuthDDL, additiveAuthTokenDDL } from "../src/auth-authority-schema-plan.ts";
import { createCredentialAuthorityClassStore } from "../src/credential-authority-class.ts";
import { createWorkerEntry, type WorkerEnv } from "../src/entry-worker.ts";
import { FinancialAuthConsumerUnavailable } from "../src/financial-auth-consumer.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import { base64UrlEncode, bytesDigest } from "../src/json.ts";
import {
  assertMoneyCutoverSqlOrigin,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import { createMemoryObjectStore } from "../src/objects-mem.ts";
import type { Clock, SqlParam, SqlStatement, SqlWrite } from "../src/ports.ts";
import { createRouter } from "../src/router.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import { createSharedAuthSessionStore } from "../src/shared-auth-session-store.ts";
import {
  createFinancialActionConsentR1Reader,
  readFinancialActionConsentR1RequestCaptures,
} from "../src/shared-financial-retained-r1.ts";
import { createSharedPrincipalAuthorityStore } from "../src/shared-principal-authority.ts";
import type { D1DatabaseLike, D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  assertWorkerRequestBackingOrigin,
  assertWorkerRequestFinancialSqlOrigin,
  captureWorkerRequestRetainedDirectOwnerSession,
  captureWorkerRequestRetainedRpSession,
  captureWorkerSharedAuthStaging,
  createWorkerFreshNativeRequestSql,
  createWorkerPrimaryRequestSql,
  createWorkerRequestConsumers,
  createWorkerRequestConsumersWithUnregisteredLocalIssuer,
  createWorkerRequestSql,
  loadWorkerRequestRetainedRpFinancialIdentityProofOriginal,
  observeWorkerRequestAuthSchema,
  proveWorkerRequestRetainedRpFinancialIdentityOriginal,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialAuthSchemaObservation,
  readWorkerRequestFinancialInputs,
  readWorkerRequestRetainedCredentialInputs,
  readWorkerRequestRetainedRpCapture,
  readWorkerRequestRetainedRpPrincipalBindingInputs,
  readWorkerRequestVerifiedLocalPrincipalIssuanceInputs,
  verifyCurrentWorkerRequestRetainedRpFinancialIdentityProofOriginal,
  type WorkerRequestDatabase,
  type WorkerRequestSql,
  type WorkerSharedAuthStaging,
} from "../src/worker-request-composition.ts";
import {
  createHostedBillingRealmTestDatabase,
  HOSTED_BILLING_REALM_TEST_INSTANT,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

import { SHARED_AUTH_TEST_ONLY_DDL } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_ORGANIZATION,
  SESSION_TEST_PERSONAL,
  SESSION_TEST_PERSONAL_ORGANIZATION,
} from "./helpers/shared-auth-session-issuer.ts";
import { TEST_TAKOFORM_V2_CONFIG } from "./helpers/takoform-v2-config.ts";

const WRITER = `sha256:${"a".repeat(64)}`;
const ACCOUNT = "acct_requestComposition";
const AUTHORITY = "request-composition-component";
const PRICE = "price_requestComposition";
const compiled = {
  ...sharedPricing,
  plans: sharedPricing.plans.map((plan, index) => ({
    ...plan,
    stripePriceId: `price_requestEntry${index}`,
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

const close = new Set<() => void>();
afterEach(() => {
  for (const dispose of close) dispose();
  close.clear();
});

/** Real owning schema and SQLite execution; this structural binding is not native D1 proof. */
async function fixture(
  shape?: (result: SqlWrite, originalStatementSql: string) => D1ResultLike,
  selectedSharedAuth?: WorkerSharedAuthStaging,
  selectedClock?: Clock,
) {
  const database = await createHostedBillingRealmTestDatabase();
  close.add(() => database.db.close());
  for (const ddl of SHARED_AUTH_TEST_ONLY_DDL) database.db.exec(ddl);
  for (const ddl of [
    MONEY_CUTOVER_FREEZE_DDL,
    MONEY_CUTOVER_PERMIT_DDL,
    MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
    MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
    moneyFenceInstallSql("0094"),
  ])
    database.db.exec(ddl);
  await database.sql.run("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)", [WRITER]);
  await seedHostedBillingRealmTestPin(database.sql, {
    accountId: ACCOUNT,
    billingAuthority: AUTHORITY,
  });
  const sessions: { readonly constraint: "first-primary"; readonly queries: string[] }[] = [];
  const resultOf = (result: SqlWrite, originalStatementSql: string) =>
    shape?.(result, originalStatementSql) ?? {
      success: true,
      results: result.rows,
      meta: { changes: result.changes },
    };
  const binding: WorkerRequestDatabase = {
    prepare() {
      throw new Error("request used the root binding instead of its primary session");
    },
    async batch() {
      throw new Error("request batched on the root binding");
    },
    withSession(constraint) {
      const queries: string[] = [];
      sessions.push({ constraint, queries });
      const originals = new WeakMap<D1StatementLike, SqlStatement>();
      return {
        prepare(sql) {
          const statement: D1StatementLike = {
            bind(...params: readonly SqlParam[]) {
              originals.set(statement, { sql, params });
              return statement;
            },
            async all() {
              const original = originals.get(statement);
              if (!original) throw new Error("fixture statement ownership differs");
              queries.push(original.sql);
              return resultOf(await database.sql.run(original.sql, original.params), original.sql);
            },
          };
          originals.set(statement, { sql });
          return statement;
        },
        async batch(statements) {
          const inputs = statements.map((statement) => {
            const original = originals.get(statement);
            if (!original) throw new Error("fixture batch crossed primary sessions");
            return original;
          });
          queries.push(...inputs.map((input) => input.sql));
          return (await database.sql.batch(inputs)).map((result, index) => {
            const original = inputs[index];
            if (!original) throw new Error("fixture batch result ownership differs");
            return resultOf(result, original.sql);
          });
        },
      };
    },
  };
  const connect = () =>
    createWorkerRequestSql({
      database: binding,
      writerEpoch: WRITER,
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    });
  const client = createStripeBillingClient({
    secretKey: "sk_test_request_composition_fixture",
    mode: "test",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      if (request.method !== "GET") throw new Error("unexpected processor mutation");
      if (path === "/v1/account") return Response.json({ object: "account", id: ACCOUNT });
      if (path !== `/v1/prices/${PRICE}`) throw new Error("unexpected processor read");
      return Response.json({
        object: "price",
        id: PRICE,
        livemode: false,
        currency: "usd",
        type: "recurring",
        billing_scheme: "per_unit",
        unit_amount: 1000,
        recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
      });
    },
  });
  const profile = captureWorkerSharedAuthStaging(
    selectedSharedAuth ?? {
      kind: "shared-auth-staging-v1",
      clientSecret: "test-only-request-rp-secret",
      encryptionKey: new Uint8Array(32).fill(7),
      principals: {
        async resolve() {
          throw new Error("test grants no principal authority");
        },
      },
      async fetch() {
        throw new Error("test permits no Accounts transport");
      },
    },
  );
  async function consumers(localIdentity?: ReturnType<typeof resolveIdentity>["verifier"]) {
    const connection = await connect();
    const realm = await verifyHostedBillingFinancialRealm({
      sql: connection.sql,
      reader: { client },
      expected: { accountId: ACCOUNT, billingAuthority: AUTHORITY, mode: "test" },
      prices: [{ priceId: PRICE, monthlyAmountMinor: 1000 }],
    });
    const inputs = {
      connection,
      sql: connection.sql,
      realm,
      client,
      sharedAuth: profile,
      identity: {
        async verify(): Promise<never> {
          throw new Error("test grants no identity");
        },
      },
      clock: selectedClock ?? (() => new Date(HOSTED_BILLING_REALM_TEST_INSTANT)),
      randomId: () => crypto.randomUUID(),
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    };
    if (localIdentity !== undefined) {
      const localInputs = { ...inputs, identity: localIdentity };
      return {
        inputs: localInputs,
        runtime: createWorkerRequestConsumersWithUnregisteredLocalIssuer(localInputs),
      };
    }
    return { inputs, runtime: createWorkerRequestConsumers(inputs) };
  }
  const env: WorkerEnv = {
    STATE_DB: binding,
    PUBLIC_ORIGIN: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
    TAKOSERVER_CONSOLE_ORIGIN: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    TAKOSERVER_ENVIRONMENT: "integration",
    TAKOSERVER_MONEY_CUTOVER_WRITER_POLICY: "transaction-fenced-usd-micros-v1",
    TAKOSERVER_MONEY_CUTOVER_WRITER_EPOCH: WRITER,
    TAKOSERVER_HOSTED_BILLING: "canonical-test",
    TAKOSERVER_HOSTED_BILLING_ACCOUNT_ID: ACCOUNT,
    TAKOSERVER_HOSTED_BILLING_AUTHORITY: AUTHORITY,
    TAKOSERVER_STRIPE_MODE: "test",
    TAKOSERVER_STRIPE_CHECKOUT_ENABLED: "1",
    TAKOSERVER_STRIPE_WEBHOOK_ENABLED: "1",
    STRIPE_SECRET_KEY: "sk_test_request_entry_fixture",
    STRIPE_WEBHOOK_SECRET: "whsec_request_entry_fixture",
    WORKER_VERSION: { id: "00000000-0000-4000-8000-0000000000a1" },
    TAKOSERVER_TAKOFORM_V2_CONFIG: JSON.stringify({
      documentation: "https://docs.example.invalid/takoform-v2",
      authenticationDocumentation: "https://docs.example.invalid/takoform-v2/authentication",
    }),
    TAKOSERVER_TAKOFORM_V2_CURSOR_KEY: "A".repeat(43),
    OBJECTS: {
      async put() {
        throw new Error("unexpected object write");
      },
      async get() {
        return null;
      },
      async head() {
        return null;
      },
      async delete() {
        throw new Error("unexpected object delete");
      },
      async list() {
        return { objects: [], truncated: false };
      },
    },
    ...pricing.environment,
  };
  return { ...database, binding, sessions, connect, consumers, profile, env };
}

function processorReads() {
  const paths: string[] = [];
  const spy = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(
      async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        const request = input instanceof Request ? input : new Request(input, init);
        const url = new URL(request.url);
        if (url.origin !== "https://api.stripe.com" || request.method !== "GET")
          throw new Error("unexpected entry transport");
        paths.push(url.pathname);
        if (url.pathname === "/v1/account")
          return Response.json({ id: ACCOUNT, object: "account" });
        if (url.pathname === "/v1/checkout/sessions" && url.search === "?limit=100&status=complete")
          return Response.json({
            object: "list",
            url: "/v1/checkout/sessions",
            data: [],
            has_more: false,
          });
        const plan = compiled.plans.find(
          (item) => url.pathname === `/v1/prices/${item.stripePriceId}`,
        );
        if (!plan) throw new Error("unexpected entry processor read");
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
      {
        preconnect() {
          throw new Error("unexpected processor preconnect");
        },
      },
    ),
  );
  return { paths, restore: () => spy.mockRestore() };
}

describe("Worker request common construction", () => {
  test("actual selected entry mounts RP login and builds a fresh common primary on each request", async () => {
    const f = await fixture();
    const processor = processorReads();
    try {
      const entry = createWorkerEntry({ sharedAuthStaging: f.profile });
      for (let index = 0; index < 2; index += 1) {
        const response = await entry.fetch(
          new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/login`),
          f.env,
        );
        expect(response.status).toBe(303);
        const location = response.headers.get("location");
        if (!location) throw new Error("actual entry did not mount RP login");
        expect(new URL(location).origin).toBe(SHARED_AUTH_STAGING_PROFILE.issuer);
        expect(response.headers.get("set-cookie")).toContain("__Host-takoserver_oidc_attempt=");
      }
      expect(f.sessions).toHaveLength(2);
      expect(processor.paths.filter((path) => path === "/v1/account")).toHaveLength(2);
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM shared_auth_attempts")).toEqual([
        { n: 2 },
      ]);
      for (const session of f.sessions) {
        expect(session.constraint).toBe("first-primary");
        expect(
          session.queries.some((query) => query.includes("INSERT INTO shared_auth_attempts")),
        ).toBe(true);
        expect(
          session.queries.some((query) =>
            query.includes("INSERT INTO money_cutover_writer_permit"),
          ),
        ).toBe(true);
      }
      const preflight = (origin: string) =>
        new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/session`, {
          method: "OPTIONS",
          headers: { origin, "access-control-request-method": "GET" },
        });
      const accepted = await entry.fetch(
        preflight(SHARED_AUTH_STAGING_PROFILE.consoleOrigin),
        f.env,
      );
      expect(accepted.status).toBe(204);
      expect(accepted.headers.get("access-control-allow-credentials")).toBe("true");
      expect(accepted.headers.get("access-control-allow-methods")).toBe("GET, POST");
      const denied = await entry.fetch(preflight("https://foreign-staging.example.test"), f.env);
      expect(denied.status).toBe(400);
      expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
      expect(f.sessions).toHaveLength(4);
      expect(processor.paths.filter((path) => path === "/v1/account")).toHaveLength(4);
    } finally {
      processor.restore();
    }
  });

  test("ordinary entry keeps its existing cached App and does not mount the selected RP", async () => {
    const f = await fixture();
    const processor = processorReads();
    try {
      const open = f.binding.withSession;
      if (!open) throw new Error("fixture primary method is missing");
      const primary = Reflect.apply(open, f.binding, ["first-primary"]);
      const entry = createWorkerEntry();
      const env = { ...f.env, STATE_DB: primary };
      for (let index = 0; index < 2; index += 1) {
        const response = await entry.fetch(
          new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/login`),
          env,
        );
        expect(response.status).toBe(404);
      }
      expect(f.sessions).toHaveLength(1);
      expect(processor.paths.filter((path) => path === "/v1/account")).toHaveLength(1);
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM shared_auth_attempts")).toEqual([
        { n: 0 },
      ]);
    } finally {
      processor.restore();
    }
  });

  test("each invocation owns a fresh primary and its genuine Accounts/realm share the final Money Sql", async () => {
    const f = await fixture();
    const first = await f.consumers();
    const second = await f.consumers();
    expect(f.sessions.map((session) => session.constraint)).toEqual([
      "first-primary",
      "first-primary",
    ]);
    expect(first.inputs.connection.sql).not.toBe(second.inputs.connection.sql);
    expect(first.runtime.accounts).not.toBe(second.runtime.accounts);
    expect(readWorkerRequestConsumers(first.inputs.connection)).toBe(first.runtime);
    expect(first.runtime.sql).toBe(first.inputs.connection.sql);
    expect(first.runtime.client).toBe(first.inputs.client);
    expect(first.runtime.realm).toBe(first.inputs.realm);
    expect(readWorkerRequestConsumers(first.inputs.connection).sharedAuth).toBe(
      first.runtime.sharedAuth,
    );
    expect(() => readWorkerRequestConsumers({ ...first.inputs.connection })).toThrow();
    assertAuthTokenCaptureReader(first.runtime.accounts, { sql: first.inputs.connection.sql });
    assertAuthTokenCaptureReader(second.runtime.accounts, { sql: second.inputs.connection.sql });
    expect(() =>
      assertAuthTokenCaptureReader(first.runtime.accounts, {
        sql: second.inputs.connection.sql,
      }),
    ).toThrow();
    expect(() =>
      createWorkerRequestConsumers({
        ...second.inputs,
        realm: first.inputs.realm,
      }),
    ).toThrow();
    expect(
      await first.runtime.sharedAuth.observeFinalSession(
        new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/control/component`),
      ),
    ).toBeNull();
    expect(f.sessions.every((session) => session.queries.length > 0)).toBe(true);
  });

  test("copied connection and alternate Sql cannot import a genuine realm into another graph", async () => {
    const f = await fixture();
    const { inputs } = await f.consumers();
    expect(() =>
      createWorkerRequestConsumers({ ...inputs, connection: { ...inputs.connection } }),
    ).toThrow();
    expect(() => createWorkerRequestConsumers({ ...inputs, sql: f.sql })).toThrow();
    expect(() => createWorkerRequestConsumers({ ...inputs, realm: { ...inputs.realm } })).toThrow();
  });

  test("missing native session support and incomplete ACK fail without another primary or fallback", async () => {
    const f = await fixture((result) => ({ results: result.rows }));
    await expect(f.connect()).rejects.toThrow();
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]?.queries).toHaveLength(1);
    const { withSession: _withSession, ...withoutSession } = f.binding;
    await expect(
      createWorkerRequestSql({
        database: withoutSession,
        writerEpoch: WRITER,
        publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
        consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
      }),
    ).rejects.toThrow();
    expect(f.sessions).toHaveLength(1);
  });

  test("the existing router preserves RP's exact credentialed preflight and rejects foreign Origins", async () => {
    const f = await fixture();
    const { runtime } = await f.consumers();
    const ordinary: string[] = [];
    const router = createRouter({
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
      sharedAuth: runtime.sharedAuth,
      control: async () => {
        ordinary.push("control");
        return null;
      },
      takoformV2Host: {
        async fetch() {
          ordinary.push("v2");
          return null;
        },
      },
    });
    const preflight = (origin: string) =>
      new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/session`, {
        method: "OPTIONS",
        headers: { origin, "access-control-request-method": "GET" },
      });
    const accepted = await router(preflight(SHARED_AUTH_STAGING_PROFILE.consoleOrigin));
    expect(accepted.status).toBe(204);
    expect(accepted.headers.get("access-control-allow-credentials")).toBe("true");
    expect(accepted.headers.get("access-control-allow-methods")).toBe("GET, POST");
    const denied = await router(preflight("https://foreign-staging.example.test"));
    expect(denied.status).toBe(400);
    expect(denied.headers.get("access-control-allow-credentials")).toBeNull();
    expect(ordinary).toEqual([]);
    const normal = await router(new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/missing`));
    expect(normal.status).toBe(404);
    expect(ordinary).toEqual(["v2", "control"]);
  });
});

describe("Worker request Financial input carrier", () => {
  test("retains the original Sql/client/realm/clock/epoch without additional IO", async () => {
    const f = await fixture();
    const { inputs, runtime } = await f.consumers();
    const queriesBefore = f.sessions.map((session) => session.queries.length);
    const captured = readWorkerRequestFinancialInputs(inputs.connection);
    expect(captured.sql).toBe(runtime.sql);
    expect(captured.client).toBe(runtime.client);
    expect(captured.realm).toBe(runtime.realm);
    expect(captured.clock).toBe(inputs.clock);
    expect(captured.writerEpoch).toBe(WRITER);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(readWorkerRequestFinancialInputs(inputs.connection)).toBe(captured);
    expect(f.sessions.map((session) => session.queries.length)).toEqual(queriesBefore);
  });

  test("requires successful consumer construction on the original connection", async () => {
    const f = await fixture();
    const connection = await f.connect();
    expect(() => readWorkerRequestFinancialInputs(connection)).toThrow();
    const selected = await f.consumers();
    expect(() => readWorkerRequestFinancialInputs({ ...selected.inputs.connection })).toThrow();
    expect(() => readWorkerRequestFinancialInputs(connection)).toThrow();
    expect(readWorkerRequestFinancialInputs(selected.inputs.connection).sql).toBe(
      selected.runtime.sql,
    );
  });

  test("rejects a matching forged connection without reading its getter", async () => {
    const f = await fixture();
    const { runtime } = await f.consumers();
    let getterCalls = 0;
    const copied: WorkerRequestSql = {
      moneyGuard: "ready",
      get sql() {
        getterCalls += 1;
        return runtime.sql;
      },
    };
    expect(() => readWorkerRequestFinancialInputs(copied)).toThrow();
    expect(getterCalls).toBe(0);
  });

  test("keeps each construction clock and connection after options are mutated", async () => {
    const f = await fixture();
    const first = await f.consumers();
    const originalClock = first.inputs.clock;
    first.inputs.clock = () => new Date(0);
    const second = await f.consumers();
    const capturedFirst = readWorkerRequestFinancialInputs(first.inputs.connection);
    const capturedSecond = readWorkerRequestFinancialInputs(second.inputs.connection);
    expect(capturedFirst.clock).toBe(originalClock);
    expect(capturedFirst.clock).not.toBe(first.inputs.clock);
    expect(capturedSecond.clock).toBe(second.inputs.clock);
    expect(capturedFirst).not.toBe(capturedSecond);
    expect(capturedFirst.sql).not.toBe(capturedSecond.sql);
    expect(capturedFirst.realm).toBe(first.runtime.realm);
    expect(capturedSecond.realm).toBe(second.runtime.realm);
  });
});

describe("official read-only Financial request origin", () => {
  test("shares the original module and graph without exporting request constructors", async () => {
    const f = await fixture();
    const { inputs, runtime } = await f.consumers();
    const before = f.sessions.map((session) => session.queries.length);
    expect(Object.keys(financialRequestOrigin)).toEqual([
      "FinancialHostedOwnerReadUnavailable",
      "assertFinancialAuthConsumerPort",
      "assertWorkerRequestFinancialAuthConsumerPort",
      "captureWorkerRequestFinancialAuthRpRequest",
      "captureWorkerRequestRetainedDirectOwnerSession",
      "captureWorkerRequestRetainedRpSession",
      "createFinancialHostedOwnerRead",
      "createHostedBrowserBillingRpcClient",
      "financialAuthConsumerSourceCurrentness",
      "loadWorkerRequestRetainedRpFinancialIdentityProofOriginal",
      "proveWorkerRequestRetainedRpFinancialIdentityOriginal",
      "readWorkerRequestFinancialAuthConsumerContext",
      "readWorkerRequestFinancialAuthConsumerPort",
      "readWorkerRequestFinancialInputs",
      "readWorkerRequestRetainedCredentialInputs",
      "readWorkerRequestRetainedRpCapture",
      "readWorkerRequestRetainedRpPrincipalBindingInputs",
      "verifyCurrentWorkerRequestRetainedRpFinancialIdentityProofOriginal",
    ]);
    expect(financialRequestOrigin.readWorkerRequestFinancialInputs).toBe(
      readWorkerRequestFinancialInputs,
    );
    const original = readWorkerRequestFinancialInputs(inputs.connection);
    const exposed = financialRequestOrigin.readWorkerRequestFinancialInputs(inputs.connection);
    expect(exposed).toBe(original);
    expect(exposed.sql).toBe(runtime.sql);
    expect(exposed.client).toBe(runtime.client);
    expect(exposed.realm).toBe(runtime.realm);
    expect(exposed.clock).toBe(inputs.clock);
    expect(exposed.writerEpoch).toBe(WRITER);
    expect(Object.isFrozen(exposed)).toBe(true);
    expect(() =>
      financialRequestOrigin.readWorkerRequestFinancialInputs({ ...inputs.connection }),
    ).toThrow();
    expect(f.sessions.map((session) => session.queries.length)).toEqual(before);
  });
});

describe("post-graph shared-auth request observation", () => {
  test("awaits the original captured observer before HTTP and scheduled effects", async () => {
    const f = await fixture();
    const processor = processorReads();
    let release: () => void = () => {
      throw new Error("observer barrier was not initialized");
    };
    let entered: () => void = () => {
      throw new Error("observer signal was not initialized");
    };
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const requests: ReturnType<typeof readWorkerRequestFinancialInputs>[] = [];
    const actualRequests: (Request | undefined)[] = [];
    const factories: (typeof createFinancialActionConsentR1Reader | undefined)[] = [];
    const captureReaders: (typeof readFinancialActionConsentR1RequestCaptures | undefined)[] = [];
    let replacementCalls = 0;
    const options = {
      sharedAuthStaging: f.profile,
      async observeSharedAuthRequest(
        connection: WorkerRequestSql,
        request?: Request,
        createReader?: typeof createFinancialActionConsentR1Reader,
        readRequestCaptures?: typeof readFinancialActionConsentR1RequestCaptures,
      ) {
        const inputs = financialRequestOrigin.readWorkerRequestFinancialInputs(connection);
        expect(inputs.sql).toBe(connection.sql);
        expect(inputs.writerEpoch).toBe(WRITER);
        expect(Object.isFrozen(connection)).toBe(true);
        requests.push(inputs);
        actualRequests.push(request);
        factories.push(createReader);
        captureReaders.push(readRequestCaptures);
        if (requests.length === 1) {
          entered();
          await barrier;
        }
      },
    };
    const entry = createWorkerEntry(options);
    options.observeSharedAuthRequest = async () => {
      replacementCalls += 1;
    };
    let settled = false;
    const firstRequest = new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/login`);
    const first = entry.fetch(firstRequest, f.env).then((response) => {
      settled = true;
      return response;
    });
    try {
      await Promise.race([
        observed,
        first.then(() => {
          throw new Error("HTTP settled before the post-graph observer");
        }),
      ]);
      expect(settled).toBe(false);
      expect(processor.paths).not.toContain("/v1/checkout/sessions");
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM shared_auth_attempts")).toEqual([
        { n: 0 },
      ]);
      release();
      expect((await first).status).toBe(303);
      const secondRequest = new Request(
        `${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/login`,
      );
      expect((await entry.fetch(secondRequest, f.env)).status).toBe(303);
      await entry.scheduled({}, f.env);
      expect(processor.paths.filter((path) => path === "/v1/checkout/sessions")).toHaveLength(1);
      expect(requests).toHaveLength(3);
      expect(actualRequests).toEqual([firstRequest, secondRequest, undefined]);
      expect(factories).toEqual([
        createFinancialActionConsentR1Reader,
        createFinancialActionConsentR1Reader,
        undefined,
      ]);
      expect(captureReaders).toEqual([
        readFinancialActionConsentR1RequestCaptures,
        readFinancialActionConsentR1RequestCaptures,
        undefined,
      ]);
      expect(f.sessions).toHaveLength(3);
      expect(requests[0]?.sql).not.toBe(requests[1]?.sql);
      expect(requests[1]?.sql).not.toBe(requests[2]?.sql);
      expect(requests[0]?.clock).not.toBe(requests[1]?.clock);
      expect(requests[1]?.clock).not.toBe(requests[2]?.clock);
      expect(replacementCalls).toBe(0);
      expect(f.sessions.every((session) => session.constraint === "first-primary")).toBe(true);
    } finally {
      release();
      processor.restore();
    }
  });

  test("observer rejection redacts HTTP startup and rejects scheduled before route effects", async () => {
    const f = await fixture();
    const processor = processorReads();
    const secret = "PRIVATE-POST-GRAPH-OBSERVER-FAILURE";
    const originalFailure = new Error(secret);
    let calls = 0;
    const entry = createWorkerEntry({
      sharedAuthStaging: f.profile,
      async observeSharedAuthRequest(connection) {
        financialRequestOrigin.readWorkerRequestFinancialInputs(connection);
        calls += 1;
        throw originalFailure;
      },
    });
    try {
      const response = await entry.fetch(
        new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/login`),
        f.env,
      );
      expect(response.status).toBe(503);
      expect(await response.text()).not.toContain(secret);
      const scheduledFailure: unknown = await entry.scheduled({}, f.env).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(scheduledFailure).toBeInstanceOf(Error);
      if (!(scheduledFailure instanceof Error)) throw new Error("scheduled failure is absent");
      expect(scheduledFailure.message).toBe("operator shared-login request observation failed");
      const cause = scheduledFailure.cause;
      expect(cause).toBeInstanceOf(TypeError);
      if (!(cause instanceof TypeError)) throw new Error("observer failure cause is absent");
      expect(cause.cause).toBe(originalFailure);
      expect(calls).toBe(2);
      expect(f.sessions).toHaveLength(2);
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM shared_auth_attempts")).toEqual([
        { n: 0 },
      ]);
    } finally {
      processor.restore();
    }
  });

  test("an observer alone cannot select an origin or replace the ordinary cached App", async () => {
    const f = await fixture();
    const processor = processorReads();
    let calls = 0;
    try {
      const open = f.binding.withSession;
      if (!open) throw new Error("fixture primary method is missing");
      const primary = Reflect.apply(open, f.binding, ["first-primary"]);
      const env = { ...f.env, STATE_DB: primary };
      const entry = createWorkerEntry({
        observeSharedAuthRequest() {
          calls += 1;
        },
      });
      for (let index = 0; index < 2; index += 1) {
        const response = await entry.fetch(
          new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/login`),
          env,
        );
        expect(response.status).toBe(503);
      }
      await expect(entry.scheduled({}, env)).rejects.toThrow(
        "shared-login request observer requires its constructed original request",
      );
      expect(calls).toBe(0);
      expect(f.sessions).toHaveLength(1);
      expect(processor.paths.filter((path) => path === "/v1/account")).toHaveLength(1);
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM shared_auth_attempts")).toEqual([
        { n: 0 },
      ]);
    } finally {
      processor.restore();
    }
  });
});

test("post-observer validation rejects actual Sql method substitution after await", async () => {
  const f = await fixture();
  const processor = processorReads();
  const restore: (() => void)[] = [];
  let substitutions = 0;
  let replacementCalls = 0;
  const entry = createWorkerEntry({
    sharedAuthStaging: f.profile,
    async observeSharedAuthRequest(connection) {
      const inputs = financialRequestOrigin.readWorkerRequestFinancialInputs(connection);
      const descriptor = Object.getOwnPropertyDescriptor(inputs.sql, "query");
      if (!descriptor || !("value" in descriptor) || descriptor.configurable !== true)
        throw new Error("actual request Sql query is not the expected mutable data method");
      await Promise.resolve();
      Object.defineProperty(inputs.sql, "query", {
        ...descriptor,
        value() {
          replacementCalls += 1;
          throw new Error("substituted request method must never run");
        },
      });
      restore.push(() => Object.defineProperty(inputs.sql, "query", descriptor));
      substitutions += 1;
    },
  });
  try {
    const response = await entry.fetch(
      new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/login`),
      f.env,
    );
    expect(response.status).toBe(503);
    expect(await response.text()).toContain("operator shared-login request observation failed");
    expect(substitutions).toBe(1);
    const failure: unknown = await entry.scheduled({}, f.env).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("post-observer scheduled failure is absent");
    const stageCause = failure.cause;
    expect(stageCause).toBeInstanceOf(TypeError);
    if (!(stageCause instanceof TypeError)) throw new Error("post-observer cause is absent");
    expect(stageCause.cause).toMatchObject({
      code: "invalid",
      message: "money cutover Sql origin differs",
    });
    expect(substitutions).toBe(2);
    expect(replacementCalls).toBe(0);
    expect(f.sessions).toHaveLength(2);
    expect(await f.sql.query("SELECT COUNT(*) AS n FROM shared_auth_attempts")).toEqual([{ n: 0 }]);
  } finally {
    for (const original of restore) original();
    processor.restore();
  }
});

/** Actual catalog reads on the structural SQLite binding remain component observations. */
function catalogResult(result: SqlWrite): boolean {
  return result.rows.some((row) => Object.hasOwn(row, "tbl_name"));
}

function acknowledgement(result: SqlWrite): D1ResultLike {
  return { success: true, results: result.rows, meta: { changes: result.changes } };
}

describe("Worker primary Auth schema observations", () => {
  test("observes the captured primary and joins only its original Sql/realm/epoch", async () => {
    const f = await fixture();
    // Candidate metadata is sufficient for observation, never installed Auth103 proof.
    f.db.exec(additiveAuthTokenDDL);
    const { inputs, runtime } = await f.consumers();
    const before = f.sessions[0]?.queries.length ?? 0;
    const observation = await observeWorkerRequestAuthSchema(inputs.connection);
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]?.queries.length).toBe(before + 2);
    expect(Object.keys(observation)).toEqual(["kind", "catalogDigest", "objectCount"]);
    expect(observation.kind).toBe("worker-request-auth-schema-observation");
    expect(observation.catalogDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(observation.objectCount).toBeGreaterThan(6);
    expect(Object.isFrozen(observation)).toBe(true);
    const joined = readWorkerRequestFinancialAuthSchemaObservation(inputs.connection, observation);
    expect(joined.observation).toBe(observation);
    expect(joined.inputs).toBe(readWorkerRequestFinancialInputs(inputs.connection));
    expect(joined.inputs.sql).toBe(runtime.sql);
    expect(joined.inputs.realm).toBe(runtime.realm);
    expect(joined.inputs.writerEpoch).toBe(WRITER);
    expect(f.sessions[0]?.queries.length).toBe(before + 2);
    f.db.exec("CREATE INDEX request_auth_observation_extra ON principals(id)");
    const changed = await observeWorkerRequestAuthSchema(inputs.connection);
    expect(changed.catalogDigest).not.toBe(observation.catalogDigest);
    expect(changed.objectCount).toBe(observation.objectCount + 1);
    // Reading a prior observation deliberately does not claim current schema.
    expect(
      readWorkerRequestFinancialAuthSchemaObservation(inputs.connection, observation).observation,
    ).toBe(observation);
  });

  test("native-primary observation needs no consumer, but cannot supply a Financial graph", async () => {
    const f = await fixture();
    f.db.exec(additiveAuthTokenDDL);
    const connection = await createWorkerPrimaryRequestSql({
      database: f.binding,
      writerEpoch: WRITER,
    });
    const before = f.sessions[0]?.queries.length ?? 0;
    expect(before).toBe(5);
    const observation = await observeWorkerRequestAuthSchema(connection);
    expect(f.sessions).toHaveLength(1);
    expect(f.sessions[0]?.queries.length).toBe(before + 2);
    expect(() =>
      readWorkerRequestFinancialAuthSchemaObservation(connection, observation),
    ).toThrow();
  });

  test("fresh native request keeps one first-primary and cannot publish consumers before qualification", async () => {
    const f = await fixture();
    const connection = createWorkerFreshNativeRequestSql(f.binding);
    expect(f.sessions).toHaveLength(1);
    expect(connection.moneyGuard).toBe("fresh-native");
    expect(() => assertWorkerRequestBackingOrigin(connection)).not.toThrow();
    expect(() => readWorkerRequestConsumers(connection)).toThrow();
    expect(() => assertWorkerRequestFinancialSqlOrigin(connection, connection.sql)).toThrow();
    expect(() => assertMoneyCutoverSqlOrigin(connection.sql, { writerEpoch: WRITER })).toThrow();
  });

  test("missing Auth catalog rejects before publishing a capture or retrying", async () => {
    const f = await fixture();
    f.db.exec(additiveAuthTokenDDL);
    const { inputs } = await f.consumers();
    f.db.exec("DROP TABLE auth_principal_incarnations");
    const before = f.sessions[0]?.queries.length ?? 0;
    await expect(observeWorkerRequestAuthSchema(inputs.connection)).rejects.toThrow(
      "catalog is incomplete",
    );
    expect(f.sessions[0]?.queries.length).toBe(before + 1);
    expect(() =>
      readWorkerRequestFinancialAuthSchemaObservation(inputs.connection, {
        kind: "worker-request-auth-schema-observation",
        catalogDigest: `sha256:${"0".repeat(64)}`,
        objectCount: 0,
      }),
    ).toThrow();
  });

  test("a real catalog change between the two reads rejects the observation", async () => {
    let armed = false;
    let catalogReads = 0;
    const f = await fixture((result) => {
      if (armed && catalogResult(result) && ++catalogReads === 1)
        f.db.exec("CREATE INDEX request_auth_observation_during ON principals(id)");
      return acknowledgement(result);
    });
    f.db.exec(additiveAuthTokenDDL);
    const { inputs } = await f.consumers();
    armed = true;
    await expect(observeWorkerRequestAuthSchema(inputs.connection)).rejects.toThrow(
      "schema changed",
    );
    expect(catalogReads).toBe(2);
    expect(f.sessions).toHaveLength(1);
  });

  test.each(["withSession", "prepare", "batch"] as const)(
    "replacement %s accessor after await rejects without invoking it or opening another session",
    async (method) => {
      let armed = false;
      let getterCalls = 0;
      let session: D1DatabaseLike | undefined;
      const f = await fixture((result) => {
        if (armed && catalogResult(result)) {
          const receiver = method === "withSession" ? f.binding : session;
          if (!receiver) throw new Error("fixture primary session is missing");
          Object.defineProperty(receiver, method, {
            configurable: true,
            get() {
              getterCalls += 1;
              throw new Error("replacement method getter was invoked");
            },
          });
        }
        return acknowledgement(result);
      });
      f.db.exec(additiveAuthTokenDDL);
      const open = f.binding.withSession;
      if (!open) throw new Error("fixture primary constructor is missing");
      f.binding.withSession = function (constraint) {
        const opened: D1DatabaseLike = Reflect.apply(open, this, [constraint]);
        session = opened;
        return opened;
      };
      const { inputs } = await f.consumers();
      const before = f.sessions[0]?.queries.length ?? 0;
      armed = true;
      await expect(observeWorkerRequestAuthSchema(inputs.connection)).rejects.toThrow(
        "session methods differ",
      );
      expect(getterCalls).toBe(0);
      expect(f.sessions).toHaveLength(1);
      expect(f.sessions[0]?.queries.length).toBe(before + 1);
    },
  );

  test("Money method replacement after await rejects without invoking its getter", async () => {
    let armed = false;
    let getterCalls = 0;
    const f = await fixture((result) => {
      if (armed && catalogResult(result))
        Object.defineProperty(runtime.sql, "run", {
          configurable: true,
          get() {
            getterCalls += 1;
            throw new Error("replacement Money getter was invoked");
          },
        });
      return acknowledgement(result);
    });
    f.db.exec(additiveAuthTokenDDL);
    const { inputs, runtime } = await f.consumers();
    const before = f.sessions[0]?.queries.length ?? 0;
    armed = true;
    await expect(observeWorkerRequestAuthSchema(inputs.connection)).rejects.toThrow();
    expect(getterCalls).toBe(0);
    expect(f.sessions[0]?.queries.length).toBe(before + 1);
    expect(f.sessions).toHaveLength(1);
  });

  test("an incomplete catalog acknowledgement is unknown and never retried", async () => {
    let armed = false;
    const f = await fixture((result) =>
      armed && catalogResult(result)
        ? { success: true, results: result.rows }
        : acknowledgement(result),
    );
    f.db.exec(additiveAuthTokenDDL);
    const { inputs } = await f.consumers();
    const before = f.sessions[0]?.queries.length ?? 0;
    armed = true;
    await expect(observeWorkerRequestAuthSchema(inputs.connection)).rejects.toThrow(
      "incomplete statement acknowledgement",
    );
    expect(f.sessions[0]?.queries.length).toBe(before + 1);
    expect(f.sessions).toHaveLength(1);
  });

  test("copied observations, copied connections and foreign real graphs cannot be joined", async () => {
    const f = await fixture();
    f.db.exec(additiveAuthTokenDDL);
    const first = await f.consumers();
    const observation = await observeWorkerRequestAuthSchema(first.inputs.connection);
    const second = await f.consumers();
    const before = f.sessions.map((session) => session.queries.length);
    expect(first.runtime.sql).not.toBe(second.runtime.sql);
    expect(first.runtime.realm).not.toBe(second.runtime.realm);
    expect(() =>
      readWorkerRequestFinancialAuthSchemaObservation(second.inputs.connection, observation),
    ).toThrow();
    expect(() =>
      readWorkerRequestFinancialAuthSchemaObservation(first.inputs.connection, { ...observation }),
    ).toThrow();
    let getterCalls = 0;
    const copied: WorkerRequestSql = {
      moneyGuard: "ready",
      get sql() {
        getterCalls += 1;
        return first.runtime.sql;
      },
    };
    expect(() => readWorkerRequestFinancialAuthSchemaObservation(copied, observation)).toThrow();
    expect(getterCalls).toBe(0);
    expect(f.sessions.map((session) => session.queries.length)).toEqual(before);
  });
});

// Component-only retained rows/projection, with real signed OIDC callback,
// encrypted session and strict RP final touch. No target/human qualification.
async function retainedRpFixture(withClass = true) {
  const stamp = Date.now();
  const issuer = await createSharedSessionTestIssuer(() => stamp);
  issuer.control.personalBillingOrganization = SESSION_TEST_PERSONAL_ORGANIZATION;
  const principalId = "prn_retained_rp_component";
  const control: {
    onResult?: (result: SqlWrite, originalStatementSql: string) => D1ResultLike | undefined;
    onPin?: () => Promise<void>;
  } = {};
  const f = await fixture(
    (result, originalStatementSql) =>
      control.onResult?.(result, originalStatementSql) ?? acknowledgement(result),
    {
      kind: "shared-auth-staging-v1",
      clientSecret: SESSION_TEST_CONFIG.clientSecret,
      encryptionKey: new Uint8Array(32).fill(7),
      principals: {
        async resolve() {
          return { accountId: SESSION_TEST_ACCOUNT, principalId };
        },
      },
      organizations: {
        async pin(input) {
          await control.onPin?.();
          return input;
        },
      },
      fetch: issuer.send,
    },
    () => new Date(stamp),
  );
  f.db.exec(additiveAuthDDL);
  const createdAt = new Date(stamp).toISOString();
  await f.sql.run(
    "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES (?,'google',?,'component@example.test','Component',?)",
    [principalId, SESSION_TEST_ACCOUNT, createdAt],
  );
  const binding = await createSharedPrincipalAuthorityStore({ sql: f.sql }).bindLegacy({
    principalId,
    principalIncarnation: "principal_inc_retained_rp_component",
    provider: "google",
    providerSubject: SESSION_TEST_ACCOUNT,
    createdAt,
    origin: { ref: "synthetic:rp-origin", digest: `sha256:${"a".repeat(64)}` },
    binding: {
      ref: "binding_retained_rp_component",
      issuer: SESSION_TEST_CONFIG.issuer,
      subject: SESSION_TEST_ACCOUNT,
      controllerIncarnation: "synthetic:controller-incarnation",
      targetRef: "synthetic:unregistered-rp-target",
      evidence: { ref: "synthetic:rp-evidence", digest: `sha256:${"b".repeat(64)}` },
      enrolledAt: createdAt,
    },
  });
  const open = f.binding.withSession;
  if (!open) throw new Error("missing native session factory");
  let native: D1DatabaseLike | undefined;
  f.binding.withSession = function (constraint) {
    const session: D1DatabaseLike = Reflect.apply(open, this, [constraint]);
    native = session;
    return session;
  };
  const { inputs, runtime } = await f.consumers();
  const login = await runtime.sharedAuth.fetch(
    new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/login`),
  );
  const location = login?.headers.get("location");
  if (!login || login.status !== 303 || !location) throw new Error("real RP login did not start");
  const cookieFrom = (response: Response, name: string) => {
    const selected = response.headers
      .getSetCookie()
      .map((item) => item.split(";")[0] ?? "")
      .find((item) => item.startsWith(`${name}=`));
    if (!selected) throw new Error("missing actual RP cookie");
    return selected;
  };
  const callback = await runtime.sharedAuth.fetch(
    new Request(issuer.authorize(location), {
      headers: { cookie: cookieFrom(login, "__Host-takoserver_oidc_attempt") },
    }),
  );
  if (!callback || callback.status !== 303)
    throw new Error("real signed callback did not complete");
  const cookie = cookieFrom(callback, "__Host-takoserver_shared_session");
  const digest = await bytesDigest(new TextEncoder().encode(cookie.slice(cookie.indexOf("=") + 1)));
  const session = await createSharedAuthSessionStore(inputs.sql).readSession(digest);
  if (!session) throw new Error("real RP session row is missing");
  const origin = {
    ref: "authority_retained_rp_component",
    incarnation: "credential_inc_retained_rp_component",
    targetRef: binding.targetRef,
    principalId,
    principalIncarnation: binding.principalIncarnation,
    issuanceRef: "synthetic:rp-original-issuance",
    issuanceDigest: digest,
    issuedAt: createdAt,
  };
  const classes = createCredentialAuthorityClassStore({ sql: inputs.sql });
  if (withClass)
    await inputs.sql.batch([
      classes.sharedRpIssuanceStatement(
        origin,
        {
          principalBindingRef: binding.ref,
          registrationRef: "synthetic:original-registration",
          registrationDigest: `sha256:${"c".repeat(64)}`,
          sessionDigest: digest,
          sessionCreatedAt: session.createdAt,
          enrolledSessionVersion: session.version,
          issuer: SESSION_TEST_CONFIG.issuer,
          clientId: SESSION_TEST_CONFIG.clientId,
          subject: SESSION_TEST_ACCOUNT,
          issuerSessionId: issuer.sessionId,
          authTime: issuer.authTime,
          accountId: SESSION_TEST_ACCOUNT,
          workspaceId: session.workspaceId,
          workspaceRef: "synthetic:original-personal-workspace-ref",
        },
        "synthetic:credential-row-org",
      ),
    ]);
  const request = () =>
    new Request(`${SESSION_TEST_CONFIG.publicOrigin}/control/rp-component`, {
      method: "POST",
      headers: { cookie, origin: SESSION_TEST_CONSOLE },
      body: "private component request body",
    });
  const capture = (connection = inputs.connection) =>
    captureWorkerRequestRetainedRpSession(connection, request(), SESSION_TEST_ORGANIZATION.id);
  const read = (value: unknown) => readWorkerRequestRetainedRpCapture(inputs.connection, value);
  return {
    f,
    inputs,
    runtime,
    issuer,
    control,
    binding,
    origin,
    classes,
    digest,
    request,
    capture,
    read,
    native: () => {
      if (!native) throw new Error("native session missing");
      return native;
    },
  };
}

describe("Worker original RP final-touch retained DATA", () => {
  test("financial proof keeps the original request and fails closed without a selected binding", async () => {
    const r = await retainedRpFixture();
    const request = r.request();
    const capture = await captureWorkerRequestRetainedRpSession(
      r.inputs.connection,
      request,
      SESSION_TEST_ORGANIZATION.id,
    );
    if (!capture) throw new Error("missing actual retained RP capture");
    expect(financialRequestOrigin.proveWorkerRequestRetainedRpFinancialIdentityOriginal).toBe(
      proveWorkerRequestRetainedRpFinancialIdentityOriginal,
    );
    const before = r.f.sessions.map((session) => session.queries.length);
    const invoke = (selectedRequest: Request, selectedWorkspace: string) => () =>
      proveWorkerRequestRetainedRpFinancialIdentityOriginal(
        r.inputs.connection,
        selectedRequest,
        selectedWorkspace,
        "synthetic:proof-challenge",
        capture,
      );
    expect(invoke(r.request(), SESSION_TEST_ORGANIZATION.id)).toThrow();
    expect(invoke(request, SESSION_TEST_PERSONAL.id)).toThrow();
    const method = Object.getOwnPropertyDescriptor(
      r.runtime.sharedAuth,
      "proveFinalSessionFinancialIdentity",
    )?.value;
    if (typeof method === "function") {
      const pending = invoke(request, SESSION_TEST_ORGANIZATION.id)();
      expect(invoke(request, SESSION_TEST_ORGANIZATION.id)()).toBe(pending);
      expect(
        () =>
          void proveWorkerRequestRetainedRpFinancialIdentityOriginal(
            r.inputs.connection,
            request,
            SESSION_TEST_ORGANIZATION.id,
            "different-challenge",
            capture,
          ),
      ).toThrow();
      await expect(pending).rejects.toThrow();
    } else {
      await expect(
        Promise.resolve().then(invoke(request, SESSION_TEST_ORGANIZATION.id)),
      ).rejects.toThrow();
    }
    expect(r.f.sessions.map((session) => session.queries.length)).toEqual(before);
  });

  test("financial proof load/current follow this capture's own prove on one challenge", async () => {
    const r = await retainedRpFixture();
    const request = r.request();
    const capture = await captureWorkerRequestRetainedRpSession(
      r.inputs.connection,
      request,
      SESSION_TEST_ORGANIZATION.id,
    );
    if (!capture) throw new Error("missing actual retained RP capture");
    expect(financialRequestOrigin.loadWorkerRequestRetainedRpFinancialIdentityProofOriginal).toBe(
      loadWorkerRequestRetainedRpFinancialIdentityProofOriginal,
    );
    expect(
      financialRequestOrigin.verifyCurrentWorkerRequestRetainedRpFinancialIdentityProofOriginal,
    ).toBe(verifyCurrentWorkerRequestRetainedRpFinancialIdentityProofOriginal);
    const before = r.f.sessions.map((session) => session.queries.length);
    const call =
      (
        operation:
          | typeof proveWorkerRequestRetainedRpFinancialIdentityOriginal
          | typeof loadWorkerRequestRetainedRpFinancialIdentityProofOriginal
          | typeof verifyCurrentWorkerRequestRetainedRpFinancialIdentityProofOriginal,
        challengeRef = "synthetic:proof-challenge",
        selectedRequest = request,
      ) =>
      () =>
        operation(
          r.inputs.connection,
          selectedRequest,
          SESSION_TEST_ORGANIZATION.id,
          challengeRef,
          capture,
        );
    const own = (name: string) =>
      typeof Object.getOwnPropertyDescriptor(r.runtime.sharedAuth, name)?.value === "function";
    const load = loadWorkerRequestRetainedRpFinancialIdentityProofOriginal;
    const current = verifyCurrentWorkerRequestRetainedRpFinancialIdentityProofOriginal;
    expect(own("proveFinalSessionFinancialIdentity")).toBe(true);
    expect(own("loadFinalSessionFinancialIdentityProof")).toBe(true);
    expect(own("verifyCurrentFinalSessionFinancialIdentityProof")).toBe(true);
    // Neither operation may precede its own predecessor on this capture. Only
    // synchronous refusals count here; a returned rejected promise is not one.
    expect(() => void call(load)()).toThrow();
    expect(() => void call(current)()).toThrow();
    expect(() => void call(load, "synthetic:proof-challenge", r.request())()).toThrow();
    const proved = call(proveWorkerRequestRetainedRpFinancialIdentityOriginal)();
    await proved.catch(() => undefined);
    expect(() => void call(load, "different-challenge")()).toThrow();
    expect(() => void call(current)()).toThrow();
    const loaded = call(load)();
    expect(call(load)()).toBe(loaded);
    expect(() => void call(load, "different-challenge")()).toThrow();
    await loaded.catch(() => undefined);
    expect(() => void call(current, "different-challenge")()).toThrow();
    const verified = call(current)();
    expect(call(current)()).toBe(verified);
    expect(() => void call(current, "different-challenge")()).toThrow();
    await verified.catch(() => undefined);
    expect(r.f.sessions.map((session) => session.queries.length)).toEqual(before);
  });

  test("actual ACK postimage, original class and selected scope stay distinct", async () => {
    const r = await retainedRpFixture();
    const request = r.request();
    const capture = await captureWorkerRequestRetainedRpSession(
      r.inputs.connection,
      request,
      SESSION_TEST_ORGANIZATION.id,
    );
    expect(capture).not.toBeNull();
    const data = r.read(capture);
    if (!data) throw new Error("missing actual retained RP data");
    const queries = r.f.sessions[0]?.queries ?? [];
    let lastTouch = -1;
    for (let index = 0; index < queries.length; index++) {
      if (queries[index]?.startsWith("UPDATE shared_auth_sessions SET last_used_at"))
        lastTouch = index;
    }
    if (lastTouch < 0) throw new Error("actual final touch did not execute");
    const afterTouch = queries.slice(lastTouch + 1);
    expect(afterTouch).toHaveLength(3);
    // The actual Money wrapper closes the touch batch before the two retained reads.
    expect(afterTouch[0]).toBe(
      "DELETE FROM money_cutover_writer_permit WHERE singleton = 1 AND epoch = 'usd-micros-v2' AND writer_epoch = ?",
    );
    expect(afterTouch[1]).toBe("SELECT * FROM credential_authority_classes WHERE session_digest=?");
    expect(
      afterTouch[2]?.startsWith(
        "SELECT CASE WHEN EXISTS (SELECT 1 FROM credential_authority_classes a JOIN shared_auth_sessions s",
      ),
    ).toBe(true);
    const row = await createSharedAuthSessionStore(r.inputs.sql).readSession(r.digest);
    expect(data.current.version).toBe(2);
    expect(row?.version).toBe(data.current.version);
    expect(row?.lastUsedAt).toBe(data.current.lastUsedAt);
    expect(row?.absoluteExpiresAt).toBe(data.current.absoluteExpiresAt);
    expect(data.record.rp.enrolledSessionVersion).toBe(0);
    expect(data.record.rp.principalBindingRef).toBe(r.binding.ref);
    expect(data.record.rp.registrationRef).toBe("synthetic:original-registration");
    expect(data.record.rp.registrationDigest).toBe(`sha256:${"c".repeat(64)}`);
    expect(data.record.rp.workspaceId).toBe(SESSION_TEST_PERSONAL.id);
    expect(data.finalSession.sessionWorkspaceId).toBe(SESSION_TEST_PERSONAL.id);
    expect(data.finalSession.selectedWorkspaceId).toBe(SESSION_TEST_ORGANIZATION.id);
    expect(data.record.organizationId).toBe("synthetic:credential-row-org");
    expect(data.selectedScope).toEqual({
      workspaceId: SESSION_TEST_ORGANIZATION.id,
      workspaceRef: "immutable-shared-workspace-ref-456",
      organizationId: "retained-takoserver-organization-789",
    });
    expect(r.f.sessions).toHaveLength(1);
    for (const value of [
      capture,
      data,
      data.record,
      data.current,
      data.finalSession,
      data.selectedScope,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    expect(JSON.stringify(capture)).toBe("{}");
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain(r.issuer.issued[0]?.accessToken ?? "missing-access");
    expect(serialized).not.toContain(r.issuer.issued[0]?.refreshToken ?? "missing-refresh");
    expect(request.bodyUsed).toBe(false);
    expect(await request.text()).toBe("private component request body");
    expect(r.read({ ...capture })).toBeNull();
    let getterReads = 0;
    expect(
      r.read({
        get record() {
          getterReads++;
          throw new Error("untrusted capture getter");
        },
      }),
    ).toBeNull();
    expect(getterReads).toBe(0);
    const other = await r.f.consumers();
    expect(readWorkerRequestRetainedRpCapture(other.inputs.connection, capture)).toBeNull();
    const forged = {
      get sql(): never {
        getterReads++;
        throw new Error("untrusted connection getter");
      },
      moneyGuard: r.inputs.connection.moneyGuard,
    };
    await expect(r.capture(forged)).rejects.toThrow("not been constructed");
    expect(getterReads).toBe(0);
    const before = r.f.sessions[0]?.queries.length;
    await expect(r.capture({ ...r.inputs.connection })).rejects.toThrow("not been constructed");
    expect(r.f.sessions[0]?.queries.length).toBe(before);
    expect(() =>
      Object.defineProperty(r.runtime.sharedAuth, "finalSessionSelection", {
        value: () => data.finalSession,
      }),
    ).toThrow();
  });

  test("no retained class issues nothing; a changed row Workspace cannot become selected scope", async () => {
    const missing = await retainedRpFixture(false);
    expect(await missing.capture()).toBeNull();
    expect(
      await missing.inputs.sql.query("SELECT count(*) AS n FROM credential_authority_classes"),
    ).toEqual([{ n: 0 }]);
    const mismatch = await retainedRpFixture();
    let mismatchReached = false;
    mismatch.control.onResult = (result, originalStatementSql) => {
      if (
        originalStatementSql !== "SELECT * FROM credential_authority_classes WHERE session_digest=?"
      )
        return undefined;
      mismatchReached = true;
      return acknowledgement({
        ...result,
        rows: result.rows.map((row) => ({ ...row, workspace_id: SESSION_TEST_ORGANIZATION.id })),
      });
    };
    expect(await mismatch.capture()).toBeNull();
    expect(mismatchReached).toBe(true);
    delete mismatch.control.onResult;
    expect(
      await mismatch.inputs.sql.query(
        "SELECT workspace_id FROM shared_auth_sessions WHERE digest=?",
        [mismatch.digest],
      ),
    ).toEqual([{ workspace_id: SESSION_TEST_PERSONAL.id }]);
    expect(
      await mismatch.inputs.sql.query(
        "SELECT workspace_id FROM credential_authority_classes WHERE session_digest=?",
        [mismatch.digest],
      ),
    ).toEqual([{ workspace_id: SESSION_TEST_PERSONAL.id }]);
  });

  for (const ack of ["failed", "unknown"] as const) {
    test(`${ack} final-touch ACK stops before retained read without retouch`, async () => {
      const r = await retainedRpFixture();
      let faultReached = false;
      let classReads = 0;
      let touches = 0;
      r.control.onResult = (result, originalStatementSql) => {
        if (
          originalStatementSql.startsWith(
            "SELECT * FROM credential_authority_classes WHERE session_digest",
          )
        )
          classReads++;
        if (originalStatementSql.startsWith("UPDATE shared_auth_sessions SET last_used_at")) {
          touches++;
          faultReached = result.rows[0]?.digest === r.digest;
          if (ack === "failed") throw new Error("synthetic final-touch failure");
          return { results: result.rows, meta: { changes: result.changes } };
        }
        return undefined;
      };
      await expect(r.capture()).rejects.toMatchObject({ code: "session_unavailable" });
      expect(faultReached).toBe(true);
      expect(touches).toBe(1);
      expect(classReads).toBe(0);
    });
  }

  test("retirement during the retained read refuses NEW data and preserves original history", async () => {
    const r = await retainedRpFixture();
    const original = await r.capture();
    expect(original).not.toBeNull();
    const originalData = r.read(original);
    let retired = false;
    r.control.onResult = (_result, originalStatementSql) => {
      if (
        !retired &&
        originalStatementSql.startsWith(
          "SELECT * FROM credential_authority_classes WHERE session_digest",
        )
      ) {
        retired = true;
        r.f.db
          .query(
            "UPDATE credential_authority_classes SET state='retired',terminal_reason='component-race',terminal_at=?,terminal_ref='component-race' WHERE authority_ref=?",
          )
          .run(new Date().toISOString(), r.origin.ref);
      }
      return undefined;
    };
    expect(await r.capture()).toBeNull();
    expect(retired).toBe(true);
    expect(r.read(original)).toBe(originalData);
    expect(originalData?.record.state).toBe("active");
  });

  for (const method of [
    "query",
    "query callable",
    "prepare",
    "captureAuthenticatedToken",
  ] as const) {
    test(`replacement ${method} getter during retained read refuses without invoking it`, async () => {
      const r = await retainedRpFixture();
      let changed = false;
      let getterReads = 0;
      let replacementCalls = 0;
      let currentnessReads = 0;
      const receiver =
        method === "query" || method === "query callable"
          ? r.inputs.sql
          : method === "prepare"
            ? r.native()
            : r.runtime.accounts;
      r.control.onResult = (_result, originalStatementSql) => {
        if (originalStatementSql.startsWith("SELECT CASE WHEN ")) currentnessReads++;
        if (
          !changed &&
          originalStatementSql.startsWith(
            "SELECT * FROM credential_authority_classes WHERE session_digest",
          )
        ) {
          changed = true;
          Object.defineProperty(
            receiver,
            method === "query callable" ? "query" : method,
            method === "query callable"
              ? {
                  configurable: true,
                  value: async () => {
                    replacementCalls++;
                    throw new Error("replacement callable must not execute");
                  },
                }
              : {
                  configurable: true,
                  get() {
                    getterReads++;
                    throw new Error("replacement getter must not execute");
                  },
                },
          );
        }
        return undefined;
      };
      await expect(r.capture()).rejects.toThrow();
      expect(changed).toBe(true);
      expect(getterReads).toBe(0);
      expect(replacementCalls).toBe(0);
      expect(currentnessReads).toBe(0);
      expect(r.f.sessions).toHaveLength(1);
    });
  }
});

// The existing request fixture plus the real local verifier/issuer. This keeps
// candidate target DATA explicit and supplies no qualified target, Clock or human.
async function retainedDirectRequestFixture(sharedAuth?: WorkerSharedAuthStaging) {
  const now = Date.now();
  const control: {
    onResult?: (result: SqlWrite, originalStatementSql: string) => D1ResultLike | undefined;
    onClock?: () => void;
  } = {};
  const clock = () => {
    control.onClock?.();
    return new Date(now);
  };
  const f = await fixture(
    (result, originalStatementSql) =>
      control.onResult?.(result, originalStatementSql) ?? acknowledgement(result),
    sharedAuth,
    clock,
  );
  f.db.exec(additiveAuthTokenDDL);
  const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const audience = SHARED_AUTH_STAGING_PROFILE.publicOrigin;
  const identity = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(publicKey.x) },
    operatorAudience: audience,
    clock,
  }).verifier;
  const { inputs, runtime } = await f.consumers(identity);
  const accounts = runtime.accounts;
  assertRetainedDirectOwnerSessionReader(accounts, { sql: inputs.sql });
  const payload = base64UrlEncode(
    new TextEncoder().encode(
      JSON.stringify({
        purpose: "sign-in",
        aud: audience,
        provider: "google",
        subject: "retained-request-local",
        email: "retained-request-local@example.test",
        displayName: "Retained request local",
        iat: Math.floor(now / 1000),
        exp: Math.floor(now / 1000) + 300,
      }),
    ),
  );
  const signature = await crypto.subtle.sign(
    "Ed25519",
    pair.privateKey,
    new TextEncoder().encode(payload),
  );
  const issued = await accounts.signIn({
    provider: "google",
    method: "operator-assertion",
    audience,
    assertion: `${payload}.${base64UrlEncode(new Uint8Array(signature))}`,
  });
  const authorization = `Bearer ${issued.sessionToken}`;
  const queries = () => f.sessions[0]?.queries ?? [];
  return {
    f,
    inputs,
    accounts,
    issued,
    control,
    now,
    authorization,
    queries,
    lastSql: () => queries().at(-1) ?? "",
    async issueFresh(subject: string) {
      const nextPayload = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            purpose: "sign-in",
            aud: audience,
            provider: "google",
            subject,
            email: "retained-request-local@example.test",
            displayName: "Retained request local",
            iat: Math.floor(now / 1000),
            exp: Math.floor(now / 1000) + 300,
          }),
        ),
      );
      const nextSignature = await crypto.subtle.sign(
        "Ed25519",
        pair.privateKey,
        new TextEncoder().encode(nextPayload),
      );
      return accounts.signIn({
        provider: "google",
        method: "operator-assertion",
        audience,
        assertion: `${nextPayload}.${base64UrlEncode(new Uint8Array(nextSignature))}`,
      });
    },
    capture: (connection = inputs.connection) =>
      captureWorkerRequestRetainedDirectOwnerSession(connection, authorization),
    read: (capture: unknown, connection = inputs.connection) =>
      readWorkerRequestRetainedCredentialInputs(connection, capture),
  };
}

const retainedDirectRequestPrefixes = [
  "SELECT id, kind, principal_id",
  "SELECT * FROM credential_authority_classes",
  "SELECT * FROM auth_principal_incarnations",
  "SELECT CASE WHEN ",
] as const;

function directRequestReadCounts(queries: readonly string[]): number[] {
  return retainedDirectRequestPrefixes.map(
    (prefix) => queries.filter((query) => query.startsWith(prefix)).length,
  );
}

describe("Worker original retained credential inputs", () => {
  test("official reader preserves the direct handle and original request DATA", async () => {
    const r = await retainedDirectRequestFixture();
    expect(financialRequestOrigin.captureWorkerRequestRetainedDirectOwnerSession).toBe(
      captureWorkerRequestRetainedDirectOwnerSession,
    );
    expect(financialRequestOrigin.readWorkerRequestRetainedCredentialInputs).toBe(
      readWorkerRequestRetainedCredentialInputs,
    );
    const raw = await r.accounts.captureAuthenticatedToken(r.authorization);
    expect(r.read(raw)).toBeNull();
    const before = r.queries().length;
    const capture = await financialRequestOrigin.captureWorkerRequestRetainedDirectOwnerSession(
      r.inputs.connection,
      r.authorization,
    );
    expect(capture).not.toBeNull();
    expect(directRequestReadCounts(r.queries().slice(before))).toEqual([1, 1, 1, 1]);
    const original = r.accounts.readRetainedDirectOwnerSessionCapture(capture);
    expect(original).not.toBeNull();
    if (!original) throw new Error("actual retained direct original is missing");
    const afterCapture = r.queries().length;
    const selected = financialRequestOrigin.readWorkerRequestRetainedCredentialInputs(
      r.inputs.connection,
      capture,
    );
    expect(selected?.inputs).toBe(readWorkerRequestFinancialInputs(r.inputs.connection));
    expect(selected?.credentialOriginal).toBe(original);
    expect(selected?.credentialOriginal.backend).toBe("auth-token");
    expect(original?.record.origin.principalId).toBe(r.issued.principal.id);
    expect(original?.record.origin.targetRef).toBe("auth103:unregistered-local-candidate");
    expect(Object.isFrozen(selected)).toBe(true);
    expect(r.read(null)).toBeNull();
    expect(r.read({ ...capture })).toBeNull();
    expect(r.read(await r.accounts.authenticate(r.authorization))).toBeNull();
    let getterReads = 0;
    expect(
      r.read({
        get record(): never {
          getterReads++;
          throw new Error("capture getter");
        },
      }),
    ).toBeNull();
    const other = await r.f.consumers();
    expect(r.read(capture, other.inputs.connection)).toBeNull();
    expect(r.queries().length).toBe(afterCapture + 1); // ordinary authenticate above only
    const forged: WorkerRequestSql = {
      moneyGuard: "ready",
      get sql(): never {
        getterReads++;
        throw new Error("connection getter");
      },
    };
    const beforeForged = r.f.sessions.map((session) => session.queries.length);
    await expect(r.capture(forged)).rejects.toThrow("not been constructed");
    expect(() => r.read(capture, forged)).toThrow("not been constructed");
    expect(r.f.sessions.map((session) => session.queries.length)).toEqual(beforeForged);
    expect(getterReads).toBe(0);
  });

  test("unified reader preserves the original RP and separate selected scope", async () => {
    const r = await retainedRpFixture();
    expect(financialRequestOrigin.captureWorkerRequestRetainedRpSession).toBe(
      captureWorkerRequestRetainedRpSession,
    );
    expect(financialRequestOrigin.readWorkerRequestRetainedRpCapture).toBe(
      readWorkerRequestRetainedRpCapture,
    );
    const capture = await r.capture();
    expect(capture).not.toBeNull();
    const original = r.read(capture);
    if (!original) throw new Error("actual retained RP original is missing");
    const before = r.f.sessions.map((session) => session.queries.length);
    const selected = readWorkerRequestRetainedCredentialInputs(r.inputs.connection, capture);
    expect(selected?.inputs).toBe(readWorkerRequestFinancialInputs(r.inputs.connection));
    expect(selected?.credentialOriginal).toBe(original);
    if (selected?.credentialOriginal.backend !== "shared-rp-session")
      throw new Error("RP original was not recognized");
    expect(selected.credentialOriginal.record.rp.workspaceId).toBe(SESSION_TEST_PERSONAL.id);
    expect(selected.credentialOriginal.record.rp.enrolledSessionVersion).toBe(0);
    expect(selected.credentialOriginal.selectedScope.workspaceId).toBe(
      SESSION_TEST_ORGANIZATION.id,
    );
    expect(selected.credentialOriginal.record.organizationId).toBe("synthetic:credential-row-org");
    expect(
      readWorkerRequestRetainedCredentialInputs(r.inputs.connection, { ...capture }),
    ).toBeNull();
    expect(readWorkerRequestRetainedCredentialInputs(r.inputs.connection, null)).toBeNull();
    expect(r.f.sessions.map((session) => session.queries.length)).toEqual(before);
    const other = await r.f.consumers();
    expect(readWorkerRequestRetainedCredentialInputs(other.inputs.connection, capture)).toBeNull();
  });

  for (const mutation of ["getter", "replacement"] as const) {
    test(`actual direct read refuses ${mutation} query substitution`, async () => {
      const r = await retainedDirectRequestFixture();
      const descriptor = Object.getOwnPropertyDescriptor(r.inputs.sql, "query");
      if (!descriptor || !("value" in descriptor)) throw new Error("original query missing");
      let changed = false;
      let substitutedCalls = 0;
      r.control.onResult = () => {
        if (!changed && r.lastSql().startsWith(retainedDirectRequestPrefixes[0])) {
          changed = true;
          Object.defineProperty(
            r.inputs.sql,
            "query",
            mutation === "getter"
              ? {
                  configurable: true,
                  get(): never {
                    substitutedCalls++;
                    throw new Error("query getter must not run");
                  },
                }
              : {
                  configurable: true,
                  value: async () => {
                    substitutedCalls++;
                    throw new Error("query replacement must not run");
                  },
                },
          );
        }
        return undefined;
      };
      const before = r.queries().length;
      try {
        await expect(r.capture()).rejects.toMatchObject({ code: "invalid" });
        expect(changed).toBe(true);
        expect(substitutedCalls).toBe(0);
        expect(directRequestReadCounts(r.queries().slice(before))).toEqual([1, 0, 0, 0]);
      } finally {
        Object.defineProperty(r.inputs.sql, "query", descriptor);
      }
    });
  }

  test("capture reasserts original Accounts after the actual Auth method finishes", async () => {
    const r = await retainedDirectRequestFixture();
    const descriptor = Object.getOwnPropertyDescriptor(
      r.accounts,
      "captureRetainedDirectOwnerSession",
    );
    if (!descriptor || !("value" in descriptor)) throw new Error("original capture missing");
    let changed = false;
    let getterReads = 0;
    let returned = false;
    r.control.onResult = () => {
      if (r.lastSql().startsWith(retainedDirectRequestPrefixes[3])) {
        // Auth's final expiry Clock read is after its last internal origin check.
        r.control.onClock = () => {
          delete r.control.onClock;
          changed = true;
          Object.defineProperty(r.accounts, "captureRetainedDirectOwnerSession", {
            configurable: true,
            get(): never {
              getterReads++;
              throw new Error("capture getter must not run");
            },
          });
        };
      }
      return undefined;
    };
    const before = r.queries().length;
    try {
      await expect(
        r.capture().then((capture) => {
          returned = true;
          return capture;
        }),
      ).rejects.toMatchObject({ code: "invalid" });
      expect(changed).toBe(true);
      expect(returned).toBe(false);
      expect(getterReads).toBe(0);
      expect(directRequestReadCounts(r.queries().slice(before))).toEqual([1, 1, 1, 1]);
    } finally {
      delete r.control.onClock;
      Object.defineProperty(r.accounts, "captureRetainedDirectOwnerSession", descriptor);
    }
  });

  test("unknown currentness never retries authentication or falls back", async () => {
    const r = await retainedDirectRequestFixture();
    let unknownReached = false;
    r.control.onResult = () => {
      if (r.lastSql().startsWith(retainedDirectRequestPrefixes[3])) {
        unknownReached = true;
        throw new Error("component unknown currentness");
      }
      return undefined;
    };
    const before = r.queries().length;
    await expect(r.capture()).rejects.toMatchObject({ code: "unavailable" });
    expect(unknownReached).toBe(true);
    expect(directRequestReadCounts(r.queries().slice(before))).toEqual([1, 1, 1, 1]);
    expect(r.f.sessions).toHaveLength(1);
  });

  for (const mutation of ["getter", "replacement"] as const) {
    test(`unified reader refuses ${mutation} inspector substitution`, async () => {
      const r = await retainedDirectRequestFixture();
      const capture = await r.capture();
      expect(capture).not.toBeNull();
      const descriptor = Object.getOwnPropertyDescriptor(
        r.accounts,
        "readRetainedDirectOwnerSessionCapture",
      );
      if (!descriptor || !("value" in descriptor)) throw new Error("original inspector missing");
      let calls = 0;
      Object.defineProperty(
        r.accounts,
        "readRetainedDirectOwnerSessionCapture",
        mutation === "getter"
          ? {
              configurable: true,
              get(): never {
                calls++;
                throw new Error("inspector getter must not run");
              },
            }
          : {
              configurable: true,
              value: () => {
                calls++;
                return null;
              },
            },
      );
      const before = r.queries().length;
      try {
        expect(() => r.read(capture)).toThrow();
        expect(calls).toBe(0);
        expect(r.queries()).toHaveLength(before);
      } finally {
        Object.defineProperty(r.accounts, "readRetainedDirectOwnerSessionCapture", descriptor);
      }
    });
  }

  test("retained history survives retirement while a new capture fails closed", async () => {
    const r = await retainedDirectRequestFixture();
    const capture = await r.capture();
    const original = r.read(capture);
    if (original?.credentialOriginal.backend !== "auth-token")
      throw new Error("direct original missing");
    await createCredentialAuthorityClassStore({ sql: r.inputs.sql }).retire(
      original.credentialOriginal.record.origin,
      {
        reason: "component-retirement",
        at: new Date(r.now).toISOString(),
        ref: "component-retirement",
      },
    );
    expect(await r.capture()).toBeNull();
    expect(r.read(capture)?.credentialOriginal).toBe(original.credentialOriginal);
    expect(await r.accounts.authenticate(r.authorization)).toMatchObject({ kind: "session" });
  });
});

// This opt-in reuses local request-origin DATA; it does not qualify Auth103,
// a distinct human, policy Clock, current admission or Financial permission.
function originalRequestAppPorts(r: Awaited<ReturnType<typeof retainedDirectRequestFixture>>) {
  return {
    sql: r.inputs.sql,
    identity: r.inputs.identity,
    clock: r.inputs.clock,
    randomId: r.inputs.randomId,
    publicOrigin: r.inputs.publicOrigin,
    consoleOrigin: r.inputs.consoleOrigin,
    workerRequest: {
      connection: r.inputs.connection,
      sharedAuth: r.inputs.sharedAuth,
      client: r.inputs.client,
      realm: r.inputs.realm,
      originalConsumers: readWorkerRequestConsumers(r.inputs.connection),
    },
    objects: createMemoryObjectStore(),
    settlement: {
      async verify(): Promise<never> {
        throw new Error("original request App test permits no settlement");
      },
    },
    forms: [],
    hostForms: [],
    offerings: [],
    v2: TEST_TAKOFORM_V2_CONFIG,
  } satisfies AppPorts;
}

describe("App original Worker request graph opt-in", () => {
  test("Financial Auth port is optional DATA selection and never inferred from an original graph", async () => {
    const r = await retainedDirectRequestFixture();
    const ports = originalRequestAppPorts(r);
    const original = readWorkerRequestConsumers(r.inputs.connection);
    expect(
      financialRequestOrigin.readWorkerRequestFinancialAuthConsumerPort(r.inputs.connection),
    ).toBeNull();
    const app = buildApp({
      ...ports,
      workerRequest: { ...ports.workerRequest },
    });
    const response = await app.fetch(
      new Request(`${ports.publicOrigin}/v1/me`, { headers: { authorization: r.authorization } }),
    );
    expect(response.status).toBe(200);
    expect(readWorkerRequestConsumers(r.inputs.connection)).toBe(original);
    expect(
      financialRequestOrigin.readWorkerRequestFinancialAuthConsumerPort(r.inputs.connection),
    ).toBeNull();
  });

  test("matching Financial Auth DTO cannot qualify even an actual same-graph App selection", async () => {
    const r = await retainedDirectRequestFixture();
    const ports = originalRequestAppPorts(r);
    let calls = 0;
    const fake = {
      readValidatedCredential() {
        calls++;
        return {};
      },
      readValidatedPrincipalBinding() {
        calls++;
        return {};
      },
    };
    const before = r.f.sessions.map((session) => session.queries.length);
    expect(() =>
      buildApp({
        ...ports,
        workerRequest: { ...ports.workerRequest, financialAuth: fake as never },
      }),
    ).toThrow(FinancialAuthConsumerUnavailable);
    expect(
      financialRequestOrigin.readWorkerRequestFinancialAuthConsumerContext(
        r.inputs.connection,
        fake,
      ),
    ).toBeNull();
    expect(calls).toBe(0);
    expect(r.f.sessions.map((session) => session.queries.length)).toEqual(before);
  });

  test("App refuses a Financial Auth selection accessor without invoking it", async () => {
    const r = await retainedDirectRequestFixture();
    const ports = originalRequestAppPorts(r);
    let calls = 0;
    const selection = Object.defineProperty({ ...ports.workerRequest }, "financialAuth", {
      get() {
        calls++;
        throw new Error("forged native source");
      },
    });
    const before = r.f.sessions.map((session) => session.queries.length);
    expect(() => buildApp({ ...ports, workerRequest: selection })).toThrow();
    expect(calls).toBe(0);
    expect(r.f.sessions.map((session) => session.queries.length)).toEqual(before);
  });

  test("refuses accessor-backed graph selection and original fields without invoking getters", async () => {
    const r = await retainedDirectRequestFixture();
    const ports = originalRequestAppPorts(r);
    for (const field of ["originalConsumers", "connection", "client", "realm"] as const) {
      let reads = 0;
      const selected = { ...ports.workerRequest };
      Object.defineProperty(selected, field, {
        get() {
          reads += 1;
          return ports.workerRequest[field];
        },
      });
      expect(() => buildApp({ ...ports, workerRequest: selected })).toThrow();
      expect(reads).toBe(0);
    }
    let reads = 0;
    const selectedPorts = { ...ports };
    Object.defineProperty(selectedPorts, "workerRequest", {
      get() {
        reads += 1;
        return ports.workerRequest;
      },
    });
    expect(() => buildApp(selectedPorts)).toThrow();
    expect(reads).toBe(0);
    expect(readWorkerRequestConsumers(r.inputs.connection)).toBe(
      ports.workerRequest.originalConsumers,
    );
  });

  test("refuses accessor-selected mixed origins without evaluating the accessor", async () => {
    const r = await retainedDirectRequestFixture();
    const other = await r.f.consumers();
    const ports = originalRequestAppPorts(r);
    let reads = 0;
    const mixed = {
      ...ports,
      sql: other.inputs.sql,
      workerRequest: {
        ...ports.workerRequest,
        client: other.inputs.client,
        realm: other.inputs.realm,
        get connection() {
          reads += 1;
          return reads === 1 ? r.inputs.connection : other.inputs.connection;
        },
      },
    };
    expect(() => buildApp(mixed)).toThrow();
    expect(reads).toBe(0);
    expect(readWorkerRequestConsumers(r.inputs.connection)).toBe(
      ports.workerRequest.originalConsumers,
    );
  });

  test("reuses the actual explicit local Accounts and RP graph through App HTTP", async () => {
    const r = await retainedDirectRequestFixture();
    const original = readWorkerRequestConsumers(r.inputs.connection);
    const financialInputs = readWorkerRequestFinancialInputs(r.inputs.connection);
    const queriesBefore = r.f.sessions.map((session) => session.queries.length);
    const app = buildApp(originalRequestAppPorts(r));
    expect(r.f.sessions.map((session) => session.queries.length)).toEqual(queriesBefore);
    expect(readWorkerRequestConsumers(r.inputs.connection)).toBe(original);
    expect(readWorkerRequestFinancialInputs(r.inputs.connection)).toBe(financialInputs);
    const response = await app.fetch(
      new Request(`${r.inputs.publicOrigin}/v1/me`, {
        headers: { authorization: r.authorization },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ principal: { id: r.issued.principal.id } });
    const capture = await r.capture();
    expect(capture).not.toBeNull();
    expect(r.read(capture)?.inputs).toBe(financialInputs);
    expect(financialInputs.clock).toBe(r.inputs.clock);
    expect(financialInputs.writerEpoch).toBe(WRITER);
    const login = await app.fetch(new Request(`${r.inputs.publicOrigin}/auth/oidc/login`));
    expect(login.status).toBe(303);
    expect(r.f.sessions).toHaveLength(1);
    expect(original.accounts).toBe(r.accounts);
  });

  test("same composed RP receiver authenticates owner GET and POST through App HTTP", async () => {
    // Local mechanical connection only: the signed fixture issuer and explicit
    // principal projection do not qualify a deployed or native RP producer.
    const now = Date.now();
    const issuer = await createSharedSessionTestIssuer(() => now);
    issuer.control.personalBillingOrganization = SESSION_TEST_PERSONAL_ORGANIZATION;
    let ownerPrincipalId: string | undefined;
    const sharedAuth: WorkerSharedAuthStaging = {
      kind: "shared-auth-staging-v1",
      clientSecret: SESSION_TEST_CONFIG.clientSecret,
      encryptionKey: new Uint8Array(32).fill(53),
      principals: {
        async resolve(input) {
          if (input.accountId !== SESSION_TEST_ACCOUNT || !ownerPrincipalId)
            throw new Error("local RP projection has no selected owner");
          return { accountId: input.accountId, principalId: ownerPrincipalId };
        },
      },
      organizations: {
        async pin(input) {
          return input;
        },
      },
      fetch: issuer.send,
    };
    const r = await retainedDirectRequestFixture(sharedAuth);
    ownerPrincipalId = r.issued.principal.id;
    const app = buildApp(originalRequestAppPorts(r));
    const login = await app.fetch(new Request(`${r.inputs.publicOrigin}/auth/oidc/login`));
    expect(login.status).toBe(303);
    const location = login.headers.get("location");
    if (!location) throw new Error("local RP login omitted its authorization URL");
    const attemptCookie = login.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.startsWith("__Host-takoserver_oidc_attempt="));
    if (!attemptCookie) throw new Error("local RP login omitted its attempt cookie");
    const callback = await app.fetch(
      new Request(issuer.authorize(location), { headers: { cookie: attemptCookie } }),
    );
    expect(callback.status).toBe(303);
    const sharedCookie = callback.headers
      .getSetCookie()
      .map((value) => value.split(";")[0] ?? "")
      .find((value) => value.startsWith("__Host-takoserver_shared_session="));
    if (!sharedCookie) throw new Error("local RP callback omitted its session cookie");

    const owner = await r.accounts.authenticate(r.authorization);
    if (owner?.kind !== "session") throw new Error("local Accounts owner session is missing");
    const organization = await r.accounts.createOrganization({ actor: owner, name: "RP owner" });
    const headers = { cookie: sharedCookie, origin: r.inputs.consoleOrigin };
    const keysPath = `/v1/organizations/${organization.id}/api-keys`;
    expect(
      (await app.fetch(new Request(`${r.inputs.publicOrigin}${keysPath}`, { headers }))).status,
    ).toBe(200);
    const created = await app.fetch(
      new Request(`${r.inputs.publicOrigin}${keysPath}`, {
        method: "POST",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({
          name: "RP owner key",
          scopes: ["resources:read"],
          expiresInSeconds: 3600,
        }),
      }),
    );
    expect(created.status).toBe(201);

    expect(
      (
        await app.fetch(
          new Request(`${r.inputs.publicOrigin}${keysPath}`, {
            headers: { origin: r.inputs.consoleOrigin },
          }),
        )
      ).status,
    ).toBe(401);
    expect(
      (
        await app.fetch(
          new Request(`${r.inputs.publicOrigin}${keysPath}`, {
            headers: {
              origin: r.inputs.consoleOrigin,
              cookie: "__Host-takoserver_shared_session=unknown",
            },
          }),
        )
      ).status,
    ).toBe(401);

    const otherOwner = await r.issueFresh("crossed-rp-owner");
    const otherActor = await r.accounts.authenticate(`Bearer ${otherOwner.sessionToken}`);
    if (otherActor?.kind !== "session") throw new Error("second local owner session is missing");
    const otherOrganization = await r.accounts.createOrganization({
      actor: otherActor,
      name: "Other owner",
    });
    const crossed = await app.fetch(
      new Request(`${r.inputs.publicOrigin}/v1/organizations/${otherOrganization.id}/api-keys`, {
        headers,
      }),
    );
    expect(crossed.status).toBe(404);
  });

  test("refuses graph clones and mismatched connection, Sql, client, realm, Clock and origin without IO", async () => {
    const r = await retainedDirectRequestFixture();
    const other = await r.f.consumers();
    const ports = originalRequestAppPorts(r);
    const selected = ports.workerRequest;
    const mismatches: readonly AppPorts[] = [
      {
        ...ports,
        workerRequest: { ...selected, originalConsumers: { ...selected.originalConsumers } },
      },
      { ...ports, workerRequest: { ...selected, connection: { ...selected.connection } } },
      { ...ports, workerRequest: { ...selected, connection: other.inputs.connection } },
      { ...ports, workerRequest: { ...selected, originalConsumers: other.runtime } },
      { ...ports, sql: r.f.sql },
      { ...ports, workerRequest: { ...selected, client: { ...selected.client } } },
      { ...ports, workerRequest: { ...selected, realm: { ...selected.realm } } },
      { ...ports, clock: () => r.inputs.clock() },
      { ...ports, publicOrigin: "https://other-host.example.test" },
      { ...ports, consoleOrigin: "https://other-console.example.test" },
    ];
    const before = r.f.sessions.map((session) => session.queries.length);
    for (const mismatch of mismatches) expect(() => buildApp(mismatch)).toThrow();
    expect(r.f.sessions.map((session) => session.queries.length)).toEqual(before);
    expect(readWorkerRequestConsumers(r.inputs.connection)).toBe(selected.originalConsumers);
    expect(readWorkerRequestFinancialInputs(r.inputs.connection).writerEpoch).toBe(WRITER);
  });

  test("ordinary App construction stays available and never implicitly adopts an existing graph", async () => {
    const r = await retainedDirectRequestFixture();
    const ports = originalRequestAppPorts(r);
    const { originalConsumers: _original, ...requestInputs } = ports.workerRequest;
    expect(() => buildApp({ ...ports, workerRequest: requestInputs })).toThrow(
      "Worker request consumers are already constructed",
    );
    const { workerRequest: _request, ...ordinaryPorts } = ports;
    const app = buildApp(ordinaryPorts);
    const response = await app.fetch(
      new Request(`${ports.publicOrigin}/v1/me`, {
        headers: { authorization: r.authorization },
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ principal: { id: r.issued.principal.id } });
    expect(readWorkerRequestConsumers(r.inputs.connection)).toBe(_original);
    expect(r.f.sessions).toHaveLength(1);
  });
});

// Synthetic retained row DATA only: the real RP observer supplies the opaque
// capture; the fixture does not supply genuine human/enrollment/target authority.
describe("Worker original RP retained Principal and binding DATA", () => {
  const bindingQuery = "SELECT * FROM shared_principal_bindings WHERE binding_ref=?";
  const anchorQuery = "SELECT * FROM auth_principal_incarnations WHERE principal_id=?";

  test("reads the captured RP rows on the same primary without retouching or reclassifying versions", async () => {
    const r = await retainedRpFixture();
    const capture = await r.capture();
    const original = r.read(capture);
    if (!original) throw new Error("original RP capture missing");
    const before = r.f.sessions[0]?.queries.length ?? 0;
    const retained = await readWorkerRequestRetainedRpPrincipalBindingInputs(
      r.inputs.connection,
      capture,
    );
    if (!retained) throw new Error("retained RP Principal DATA missing");
    expect(financialRequestOrigin.readWorkerRequestRetainedRpPrincipalBindingInputs).toBe(
      readWorkerRequestRetainedRpPrincipalBindingInputs,
    );
    expect(retained.inputs).toBe(readWorkerRequestFinancialInputs(r.inputs.connection));
    expect(retained.credentialOriginal).toBe(original);
    expect(retained.binding).toEqual(r.binding);
    expect(retained.anchor.principalId).toBe(r.origin.principalId);
    expect(retained.anchor.incarnation).toBe(r.origin.principalIncarnation);
    expect(retained.anchor.originKind).toBe("proved-legacy");
    expect(original.record.rp.registrationRef).toBe("synthetic:original-registration");
    expect(original.record.rp.enrolledSessionVersion).toBe(0);
    expect(original.current.version).toBe(2);
    expect(r.f.sessions[0]?.queries.slice(before)).toEqual([bindingQuery, anchorQuery]);
    expect(Object.isFrozen(retained)).toBe(true);
    expect(Object.isFrozen(retained.anchor)).toBe(true);
    expect(Object.isFrozen(retained.binding)).toBe(true);
    expect(r.f.sessions).toHaveLength(1);
  });

  test("unknown, cloned, foreign and direct-token handles cannot select Principal rows", async () => {
    const r = await retainedRpFixture();
    const capture = await r.capture();
    if (!capture) throw new Error("original RP capture missing");
    const other = await r.f.consumers();
    let getterReads = 0;
    const forged = {
      get record(): never {
        getterReads++;
        throw new Error("untrusted capture getter");
      },
    };
    const before = r.f.sessions.map((session) => session.queries.length);
    for (const value of [null, {}, { ...capture }, forged])
      expect(
        await readWorkerRequestRetainedRpPrincipalBindingInputs(r.inputs.connection, value),
      ).toBeNull();
    expect(
      await readWorkerRequestRetainedRpPrincipalBindingInputs(other.inputs.connection, capture),
    ).toBeNull();
    expect(getterReads).toBe(0);
    expect(r.f.sessions.map((session) => session.queries.length)).toEqual(before);
    const direct = await retainedDirectRequestFixture();
    const directCapture = await direct.capture();
    expect(directCapture).not.toBeNull();
    const directBefore = direct.queries().length;
    expect(
      await readWorkerRequestRetainedRpPrincipalBindingInputs(
        direct.inputs.connection,
        directCapture,
      ),
    ).toBeNull();
    expect(direct.queries()).toHaveLength(directBefore);
  });

  for (const field of ["binding target", "Principal incarnation"] as const) {
    test(`refuses a different retained ${field}`, async () => {
      const r = await retainedRpFixture();
      const capture = await r.capture();
      if (!capture) throw new Error("original RP capture missing");
      let changed = false;
      r.control.onResult = (result, sql) => {
        if (sql !== (field === "binding target" ? bindingQuery : anchorQuery)) return undefined;
        changed = true;
        return acknowledgement({
          ...result,
          rows: result.rows.map((row) =>
            field === "binding target"
              ? { ...row, target_ref: "synthetic:other-target" }
              : { ...row, principal_incarnation: "synthetic:other-incarnation" },
          ),
        });
      };
      expect(
        await readWorkerRequestRetainedRpPrincipalBindingInputs(r.inputs.connection, capture),
      ).toBeNull();
      expect(changed).toBe(true);
      expect(r.read(capture)?.record.origin).toEqual(r.origin);
    });
  }

  for (const query of [bindingQuery, anchorQuery]) {
    test(`unknown ${query === bindingQuery ? "binding" : "anchor"} ACK propagates without fallback`, async () => {
      const r = await retainedRpFixture();
      const capture = await r.capture();
      if (!capture) throw new Error("original RP capture missing");
      const before = r.f.sessions[0]?.queries.length ?? 0;
      let unknown = 0;
      r.control.onResult = (result, sql) => {
        if (sql !== query) return undefined;
        unknown++;
        return { results: result.rows, meta: { changes: result.changes } };
      };
      await expect(
        readWorkerRequestRetainedRpPrincipalBindingInputs(r.inputs.connection, capture),
      ).rejects.toThrow();
      expect(unknown).toBe(1);
      expect(r.f.sessions[0]?.queries.slice(before)).toEqual(
        query === bindingQuery ? [bindingQuery] : [bindingQuery, anchorQuery],
      );
      expect(r.f.sessions).toHaveLength(1);
    });
  }

  for (const method of ["query", "prepare"] as const) {
    test(`refuses a ${method} getter installed after the binding await without invoking it`, async () => {
      const r = await retainedRpFixture();
      const capture = await r.capture();
      if (!capture) throw new Error("original RP capture missing");
      const receiver = method === "query" ? r.inputs.sql : r.native();
      const descriptor = Object.getOwnPropertyDescriptor(receiver, method);
      if (!descriptor) throw new Error("original method missing");
      const before = r.f.sessions[0]?.queries.length ?? 0;
      let changed = false;
      let getterReads = 0;
      r.control.onResult = (_result, sql) => {
        if (sql !== bindingQuery) return undefined;
        changed = true;
        Object.defineProperty(receiver, method, {
          configurable: true,
          get(): never {
            getterReads++;
            throw new Error("replacement method getter");
          },
        });
        return undefined;
      };
      try {
        await expect(
          readWorkerRequestRetainedRpPrincipalBindingInputs(r.inputs.connection, capture),
        ).rejects.toThrow();
        expect(changed).toBe(true);
        expect(getterReads).toBe(0);
        expect(r.f.sessions[0]?.queries.slice(before)).toEqual([bindingQuery]);
      } finally {
        Object.defineProperty(receiver, method, descriptor);
      }
    });
  }

  test("binding retirement stays readable history and never grants a new RP capture", async () => {
    const r = await retainedRpFixture();
    const capture = await r.capture();
    if (!capture) throw new Error("original RP capture missing");
    const before = await readWorkerRequestRetainedRpPrincipalBindingInputs(
      r.inputs.connection,
      capture,
    );
    if (!before) throw new Error("original retained rows missing");
    const terminal = {
      reason: "component-binding-retirement",
      at: new Date().toISOString(),
      ref: "component-binding-retirement",
    };
    await createSharedPrincipalAuthorityStore({ sql: r.inputs.sql }).retireBinding(
      r.binding.ref,
      r.binding.evidence,
      terminal,
    );
    const after = await readWorkerRequestRetainedRpPrincipalBindingInputs(
      r.inputs.connection,
      capture,
    );
    if (!after) throw new Error("retired retained rows missing");
    expect(after.credentialOriginal).toBe(before.credentialOriginal);
    expect(after.binding.state).toBe("retired");
    expect(after.binding.terminal).toEqual(terminal);
    expect(Object.isFrozen(after.binding.terminal)).toBe(true);
    expect(before.binding.state).toBe("active");
    expect(before.binding.terminal).toBeNull();
    expect(await r.capture()).toBeNull();
    expect(r.read(capture)).toBe(before.credentialOriginal);
  });
});

// The producer runs original identity verification and same-batch Principal/class
// issuance. It does not qualify shared human binding, schema/target or Clock.
describe("Worker verified local Principal issuance origin", () => {
  test("original successful verified issuance has a separate Principal origin without bearer inference", async () => {
    const r = await retainedDirectRequestFixture();
    assertVerifiedLocalPrincipalIssuanceReader(r.accounts, { sql: r.inputs.sql });
    const before = r.queries().length;
    const observed = readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(
      r.inputs.connection,
      r.issued,
    );
    if (!observed) throw new Error("verified Principal issuance missing");
    expect(r.queries()).toHaveLength(before);
    expect(observed.inputs).toBe(readWorkerRequestFinancialInputs(r.inputs.connection));
    expect(observed.principalOriginal.anchor.principalId).toBe(r.issued.principal.id);
    expect(observed.principalOriginal.anchor.originKind).toBe("fresh-local");
    expect(observed.principalOriginal.anchor.identitySubject).toBe(
      observed.principalOriginal.verification.providerSubject,
    );
    expect(observed.principalOriginal.anchor.origin.digest).toBe(
      observed.principalOriginal.verification.assertionDigest,
    );
    expect(observed.principalOriginal.anchor.verificationDomain).toEqual(
      observed.principalOriginal.verification.verificationDomain,
    );
    expect(Object.isFrozen(observed.principalOriginal)).toBe(true);
    expect(Object.isFrozen(observed.principalOriginal.anchor)).toBe(true);
    expect(Object.isFrozen(observed.principalOriginal.verification)).toBe(true);
    expect(JSON.stringify(observed).includes(r.issued.sessionToken)).toBe(false);
    const tokenCapture = await r.capture();
    const credential = r.read(tokenCapture);
    expect(credential?.credentialOriginal.record.origin.principalId).toBe(
      observed.principalOriginal.anchor.principalId,
    );
    expect(
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, tokenCapture),
    ).toBeNull();
    expect(r.read(r.issued)).toBeNull();
    expect(
      r.queries().filter((q) => q.startsWith("INSERT INTO credential_authority_classes")),
    ).toHaveLength(1);
  });

  test("clone, wire DTO, Actor and another Accounts instance cannot select the original verified Principal", async () => {
    const r = await retainedDirectRequestFixture();
    const other = await retainedDirectRequestFixture();
    const actor = await r.accounts.authenticate(r.authorization);
    let reads = 0;
    const forged = {
      get principal(): never {
        reads++;
        throw new Error("caller principal getter");
      },
    };
    const before = r.queries().length;
    for (const value of [
      null,
      {},
      { ...r.issued },
      JSON.parse(JSON.stringify(r.issued)),
      actor,
      forged,
    ])
      expect(
        readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, value),
      ).toBeNull();
    expect(
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(other.inputs.connection, r.issued),
    ).toBeNull();
    expect(reads).toBe(0);
    expect(r.queries()).toHaveLength(before);
  });

  test("the original result is an opaque key; mutable wire fields never replace the verified Principal", async () => {
    const r = await retainedDirectRequestFixture();
    const observed = readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(
      r.inputs.connection,
      r.issued,
    );
    if (!observed) throw new Error("verified Principal issuance missing");
    let reads = 0;
    Object.defineProperty(r.issued, "principal", {
      get(): never {
        reads++;
        throw new Error("mutable result getter");
      },
    });
    expect(
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, r.issued)
        ?.principalOriginal,
    ).toBe(observed.principalOriginal);
    expect(reads).toBe(0);
  });

  for (const method of [
    "query",
    "batch",
    "signIn",
    "readVerifiedLocalPrincipalIssuance",
  ] as const) {
    test(`replaced ${method} getter cannot read or mint a Principal origin`, async () => {
      const r = await retainedDirectRequestFixture();
      const receiver = method === "query" || method === "batch" ? r.inputs.sql : r.accounts;
      const descriptor = Object.getOwnPropertyDescriptor(receiver, method);
      if (!descriptor) throw new Error("original method missing");
      let reads = 0;
      Object.defineProperty(receiver, method, {
        configurable: true,
        get(): never {
          reads++;
          throw new Error("replacement getter");
        },
      });
      try {
        expect(() =>
          readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, r.issued),
        ).toThrow();
        expect(reads).toBe(0);
      } finally {
        Object.defineProperty(receiver, method, descriptor);
      }
    });
  }

  test("ordinary Accounts never acquires the explicit verified-issuance reader", async () => {
    const f = await fixture();
    const { inputs, runtime } = await f.consumers();
    expect(Object.hasOwn(runtime.accounts, "readVerifiedLocalPrincipalIssuance")).toBe(false);
    expect(() =>
      assertVerifiedLocalPrincipalIssuanceReader(runtime.accounts, { sql: inputs.sql }),
    ).toThrow();
    expect(() =>
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(inputs.connection, {}),
    ).toThrow();
  });

  test("an actual ignored class write cannot publish a Principal issuance origin", async () => {
    const r = await retainedDirectRequestFixture();
    r.f.db.exec(
      "CREATE TRIGGER component_ignore_class BEFORE INSERT ON credential_authority_classes BEGIN SELECT RAISE(IGNORE); END",
    );
    await expect(r.issueFresh("verified-ignored-class")).rejects.toThrow();
    expect(await r.inputs.sql.query("SELECT count(*) AS n FROM principals")).toEqual([{ n: 2 }]);
    expect(
      await r.inputs.sql.query("SELECT count(*) AS n FROM credential_authority_classes"),
    ).toEqual([{ n: 1 }]);
    expect(
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, {
        principal: { providerSubject: "verified-ignored-class" },
      }),
    ).toBeNull();
    expect(
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, r.issued),
    ).not.toBeNull();
  });

  test("unknown issuance ACK cannot publish verification/enrollment provenance even after actual local commit", async () => {
    const r = await retainedDirectRequestFixture();
    let fault = 0;
    r.control.onResult = (result, originalStatementSql) => {
      if (!originalStatementSql.startsWith("INSERT INTO credential_authority_classes"))
        return undefined;
      fault++;
      return { results: result.rows, meta: { changes: result.changes } };
    };
    await expect(r.issueFresh("verified-unknown-issuance")).rejects.toThrow();
    delete r.control.onResult;
    expect(fault).toBeGreaterThan(0);
    expect(
      await r.inputs.sql.query("SELECT count(*) AS n FROM credential_authority_classes"),
    ).toEqual([{ n: 2 }]);
    expect(
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, {
        principal: { providerSubject: "verified-unknown-issuance" },
      }),
    ).toBeNull();
    expect(
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, r.issued),
    ).not.toBeNull();
  });

  test("batch method substitution after the write await refuses provenance without invoking the getter", async () => {
    const r = await retainedDirectRequestFixture();
    const descriptor = Object.getOwnPropertyDescriptor(r.inputs.sql, "batch");
    if (!descriptor) throw new Error("original batch missing");
    let changed = false;
    let reads = 0;
    r.control.onResult = (_result, originalStatementSql) => {
      if (!changed && originalStatementSql.startsWith("INSERT INTO credential_authority_classes")) {
        changed = true;
        Object.defineProperty(r.inputs.sql, "batch", {
          configurable: true,
          get(): never {
            reads++;
            throw new Error("replacement batch getter");
          },
        });
      }
      return undefined;
    };
    try {
      await expect(r.issueFresh("verified-mutated-batch")).rejects.toThrow();
      expect(changed).toBe(true);
      expect(reads).toBe(0);
    } finally {
      delete r.control.onResult;
      Object.defineProperty(r.inputs.sql, "batch", descriptor);
    }
    expect(
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, {
        principal: { providerSubject: "verified-mutated-batch" },
      }),
    ).toBeNull();
    expect(
      readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(r.inputs.connection, r.issued),
    ).not.toBeNull();
  });
});
