import * as financialRequestOrigin from "@takoserver/core/financial-request-origin";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import sharedPricing from "../config/shared-hosted-pricing.json";
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { assertAuthTokenCaptureReader } from "../src/auth.ts";
import { createWorkerEntry, type WorkerEnv } from "../src/entry-worker.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { compilePricingAuthoring } from "../src/hosted-pricing.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import type { SqlParam, SqlStatement, SqlWrite } from "../src/ports.ts";
import { createRouter } from "../src/router.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import type { D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  captureWorkerSharedAuthStaging,
  createWorkerRequestConsumers,
  createWorkerRequestSql,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  type WorkerRequestDatabase,
  type WorkerRequestSql,
} from "../src/worker-request-composition.ts";
import {
  createHostedBillingRealmTestDatabase,
  HOSTED_BILLING_REALM_TEST_INSTANT,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

import { SHARED_AUTH_TEST_ONLY_DDL } from "./helpers/shared-auth-session-fixture.ts";

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
async function fixture(shape?: (result: SqlWrite) => D1ResultLike) {
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
  const resultOf = (result: SqlWrite) =>
    shape?.(result) ?? {
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
              return resultOf(await database.sql.run(original.sql, original.params));
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
          return (await database.sql.batch(inputs)).map(resultOf);
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
  const profile = captureWorkerSharedAuthStaging({
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
  });
  async function consumers() {
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
      clock: () => new Date(HOSTED_BILLING_REALM_TEST_INSTANT),
      randomId: () => crypto.randomUUID(),
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    };
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
    expect(Object.keys(financialRequestOrigin)).toEqual(["readWorkerRequestFinancialInputs"]);
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
    let replacementCalls = 0;
    const options = {
      sharedAuthStaging: f.profile,
      async observeSharedAuthRequest(connection: WorkerRequestSql) {
        const inputs = financialRequestOrigin.readWorkerRequestFinancialInputs(connection);
        expect(inputs.sql).toBe(connection.sql);
        expect(inputs.writerEpoch).toBe(WRITER);
        expect(Object.isFrozen(connection)).toBe(true);
        requests.push(inputs);
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
    const first = entry
      .fetch(
        new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/login`),
        f.env,
      )
      .then((response) => {
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
      expect(await f.sql.query("SELECT COUNT(*) AS n FROM shared_auth_attempts")).toEqual([
        { n: 0 },
      ]);
      release();
      expect((await first).status).toBe(303);
      expect(
        (
          await entry.fetch(
            new Request(`${SHARED_AUTH_STAGING_PROFILE.publicOrigin}/auth/oidc/login`),
            f.env,
          )
        ).status,
      ).toBe(303);
      await entry.scheduled({}, f.env);
      expect(requests).toHaveLength(3);
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
