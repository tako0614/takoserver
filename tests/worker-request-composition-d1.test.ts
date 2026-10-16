import { expect, test } from "bun:test";
import { Miniflare } from "miniflare";
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { assertAuthTokenCaptureReader } from "../src/auth.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { bytesDigest } from "../src/json.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import type { Row } from "../src/ports.ts";
import type { D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  captureWorkerSharedAuthStaging,
  createWorkerRequestConsumers,
  createWorkerRequestSql,
  readWorkerRequestConsumers,
  type WorkerRequestDatabase,
} from "../src/worker-request-composition.ts";
import {
  HOSTED_BILLING_REALM_TEST_INSTANT,
  hostedBillingRealmTestMigrations,
} from "./helpers/hosted-billing-realm-fixture.ts";
import { SHARED_AUTH_TEST_ONLY_DDL } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
} from "./helpers/shared-auth-session-issuer.ts";

const INITIAL_TIME = 1_800_000_000_000;
const WRITER = `sha256:${"b".repeat(64)}`;
const ACCOUNT = "acct_requestNative";
const AUTHORITY = "request-native-component";
const PRICE = "price_requestNative";
const PRINCIPAL = "protocol-fixture-principal-not-enrollment";
const COOKIE = "__Host-takoserver_shared_session";

interface NativeTrace {
  primaryCalls: number;
  armed: boolean;
  readonly reads: D1ResultLike[];
  readonly batches: (readonly D1ResultLike[])[];
  beforeFirstBatch?: () => Promise<void>;
  damageFirstAck?: boolean;
}

function browserCookie(response: Response, name: string): string {
  const value = response.headers.getSetCookie().find((item) => item.startsWith(`${name}=`));
  if (!value) throw new Error("native protocol fixture lacks its host-only cookie");
  return value.split(";")[0] ?? "";
}

/**
 * Native D1 protocol component, hosted by Miniflare's actual D1 proxy. This is
 * not a bundled product Worker, live target or Principal/class/payer proof.
 * Only native method forwarding and post-return ACK damage are test adapters;
 * the strict Sql, Money, realm, Accounts, store and RP factories stay genuine.
 */
async function fixture() {
  const id = `integration-request-d1-${crypto.randomUUID()}`;
  const runtime = new Miniflare({
    workers: [
      {
        config: {
          name: id,
          type: "worker",
          compatibilityDate: "2026-08-18",
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response('local only'); } };",
              },
            },
          },
          env: { STATE_DB: { type: "d1", id } },
          triggers: [],
        },
      },
    ],
  });
  try {
    const database = await runtime.getD1Database("STATE_DB");
    const setup = database.withSession("first-primary");
    // Existing owning migration/fixture bytes, framed by the canonical lexer.
    // RP's additive DDL remains explicitly test-only and has no migration number.
    for (const source of [
      ...(await hostedBillingRealmTestMigrations()),
      ...SHARED_AUTH_TEST_ONLY_DDL,
      MONEY_CUTOVER_FREEZE_DDL,
      MONEY_CUTOVER_PERMIT_DDL,
      MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
      MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
      moneyFenceInstallSql("0094"),
    ]) {
      const statements = frameHostMigrationSql(source);
      if (statements.length > 0)
        await setup.batch(statements.map((statement) => setup.prepare(statement)));
    }
    await setup
      .prepare("INSERT INTO stripe_mode_realm VALUES (1, 'test', ?)")
      .bind(HOSTED_BILLING_REALM_TEST_INSTANT)
      .all();
    await setup
      .prepare("INSERT INTO stripe_billing_account_realms VALUES (1, ?, 'test', ?, ?)")
      .bind(ACCOUNT, AUTHORITY, HOSTED_BILLING_REALM_TEST_INSTANT)
      .all();
    await setup
      .prepare("INSERT INTO money_cutover_authorized_epoch VALUES (1, ?)")
      .bind(WRITER)
      .all();
    let now = INITIAL_TIME;
    const issuer = await createSharedSessionTestIssuer(() => now);
    const client = createStripeBillingClient({
      secretKey: "sk_test_request_native_fixture",
      mode: "test",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method !== "GET")
          throw new Error("native fixture permits no processor mutation");
        if (path === "/v1/account") return Response.json({ id: ACCOUNT, object: "account" });
        if (path !== `/v1/prices/${PRICE}`) throw new Error("unexpected native processor read");
        return Response.json({
          id: PRICE,
          object: "price",
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
      clientSecret: SESSION_TEST_CONFIG.clientSecret,
      encryptionKey: new Uint8Array(32).fill(43),
      // Controlled RP protocol input, never a claim of genuine enrollment,
      // retained-principal lineage or a same-primary owning producer.
      principals: {
        async resolve(input) {
          if (input.accountId !== SESSION_TEST_ACCOUNT || input.subject !== SESSION_TEST_ACCOUNT)
            throw new Error("protocol fixture received a foreign canonical account");
          return { accountId: input.accountId, principalId: PRINCIPAL };
        },
      },
      fetch: (request) => issuer.send(request),
    });

    async function requestScope() {
      const trace: NativeTrace = { primaryCalls: 0, armed: false, reads: [], batches: [] };
      const observed: WorkerRequestDatabase = {
        prepare() {
          throw new Error("common factory used the root binding instead of its primary");
        },
        async batch() {
          throw new Error("common factory batched on the root binding");
        },
        withSession(constraint) {
          trace.primaryCalls++;
          expect(constraint).toBe("first-primary");
          const session = database.withSession(constraint);
          const nativeStatements = new WeakMap<
            D1StatementLike,
            ReturnType<typeof session.prepare>
          >();
          function forward(native: ReturnType<typeof session.prepare>): D1StatementLike {
            const statement: D1StatementLike = {
              bind(...values) {
                return forward(native.bind(...values));
              },
              async all() {
                const result = await native.all<Row>();
                if (trace.armed) trace.reads.push(structuredClone(result));
                return result;
              },
            };
            nativeStatements.set(statement, native);
            return statement;
          }
          return {
            prepare: (sql) => forward(session.prepare(sql)),
            async batch(statements) {
              const native = statements.map((statement) => {
                const captured = nativeStatements.get(statement);
                if (!captured) throw new Error("native batch crossed request primaries");
                return captured;
              });
              const first = trace.armed && trace.batches.length === 0;
              if (first) await trace.beforeFirstBatch?.();
              const packets = await session.batch<Row>(native);
              if (trace.armed) trace.batches.push(structuredClone(packets));
              if (first && trace.damageFirstAck) {
                // The actual native transaction has already returned/committed.
                // Damage only its middle ACK. No fabricated zero, write or resend.
                expect(packets).toHaveLength(3);
                return packets.map((packet, index) =>
                  index === 1 ? { ...packet, results: null } : packet,
                );
              }
              return packets;
            },
          };
        },
      };
      const connection = await createWorkerRequestSql({
        database: observed,
        writerEpoch: WRITER,
        publicOrigin: SESSION_TEST_CONFIG.publicOrigin,
        consoleOrigin: SESSION_TEST_CONSOLE,
      });
      const realm = await verifyHostedBillingFinancialRealm({
        sql: connection.sql,
        reader: { client },
        expected: { accountId: ACCOUNT, billingAuthority: AUTHORITY, mode: "test" },
        prices: [{ priceId: PRICE, monthlyAmountMinor: 1000 }],
      });
      const consumers = createWorkerRequestConsumers({
        connection,
        sql: connection.sql,
        client,
        realm,
        sharedAuth: profile,
        identity: {
          async verify(): Promise<never> {
            throw new Error("no local identity grant");
          },
        },
        clock: () => new Date(now),
        randomId: () => crypto.randomUUID(),
        publicOrigin: SESSION_TEST_CONFIG.publicOrigin,
        consoleOrigin: SESSION_TEST_CONSOLE,
      });
      expect(readWorkerRequestConsumers(connection)).toBe(consumers);
      expect(consumers.sql).toBe(connection.sql);
      expect(consumers.client).toBe(client);
      expect(consumers.realm).toBe(realm);
      assertAuthTokenCaptureReader(consumers.accounts, { sql: connection.sql });
      return { trace, connection, consumers };
    }

    async function signedIn() {
      const loginScope = await requestScope();
      const login = await loginScope.consumers.sharedAuth.fetch(
        new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/login`),
      );
      if (!login || login.status !== 303) throw new Error("real RP native login did not start");
      const callbackUrl = issuer.authorize(login.headers.get("location") ?? "");
      const callbackScope = await requestScope();
      const callback = await callbackScope.consumers.sharedAuth.fetch(
        new Request(callbackUrl, {
          headers: { cookie: browserCookie(login, "__Host-takoserver_oidc_attempt") },
        }),
      );
      if (!callback || callback.status !== 303) throw new Error("real RP native callback failed");
      const cookie = browserCookie(callback, COOKIE);
      const digest = await bytesDigest(new TextEncoder().encode(cookie.slice(COOKIE.length + 1)));
      return { cookie, digest };
    }
    const sessionRequest = (cookie: string) =>
      new Request(`${SESSION_TEST_CONFIG.publicOrigin}/control/native-protocol`, {
        headers: { cookie, origin: SESSION_TEST_CONSOLE },
      });
    async function row(digest: string) {
      // Independent test readback, never supplied back as the observer's selection.
      const independent = database.withSession("first-primary");
      const result = await independent
        .prepare("SELECT * FROM shared_auth_sessions WHERE digest = ?")
        .bind(digest)
        .all<Row>();
      return result.results[0];
    }
    return {
      runtime,
      issuer,
      requestScope,
      signedIn,
      sessionRequest,
      row,
      now: () => now,
      advance: () => {
        now += 10;
      },
    };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

function touchAck(trace: NativeTrace, index: number): D1ResultLike {
  const batch = trace.batches[index];
  if (!batch || batch.length !== 3 || !batch[1])
    throw new Error("missing actual native Money touch batch");
  expect(batch[0]?.success).toBe(true);
  expect(batch[0]?.meta?.changes).toBe(1);
  expect(batch[2]?.success).toBe(true);
  expect(batch[2]?.meta?.changes).toBe(1);
  return batch[1];
}

function noRefresh(issuer: Awaited<ReturnType<typeof createSharedSessionTestIssuer>>) {
  expect(
    issuer.requests.filter((request) => request.form.get("grant_type") === "refresh_token"),
  ).toEqual([]);
}

test("native common primary selects the actual retouch image after one acknowledged compatible miss", async () => {
  const f = await fixture();
  try {
    const signed = await f.signedIn();
    const observing = await f.requestScope();
    const competing = await f.requestScope();
    f.advance();
    let competitors = 0;
    observing.trace.beforeFirstBatch = async () => {
      competitors++;
      competing.trace.armed = true;
      const context = await competing.consumers.sharedAuth.authenticate(
        f.sessionRequest(signed.cookie),
      );
      expect(context?.accountId).toBe(SESSION_TEST_ACCOUNT);
    };
    observing.trace.armed = true;
    const context = await observing.consumers.sharedAuth.observeFinalSession(
      f.sessionRequest(signed.cookie),
    );
    const selected = observing.consumers.sharedAuth.finalSessionSelection(context);
    if (!context || !selected)
      throw new Error("real native retouch produced no original selection");
    expect(competitors).toBe(1);
    expect(competing.trace.batches).toHaveLength(1);
    expect(observing.trace.primaryCalls).toBe(1);
    expect(observing.trace.reads).toHaveLength(2);
    expect(observing.trace.batches).toHaveLength(2);
    const miss = touchAck(observing.trace, 0);
    expect(miss.success).toBe(true);
    expect(miss.meta?.changes).toBe(0);
    expect(miss.results).toEqual([]);
    const returned = touchAck(observing.trace, 1);
    expect(returned.success).toBe(true);
    expect(returned.meta?.changes).toBe(1);
    expect(returned.results).toHaveLength(1);
    const image = returned.results?.[0];
    if (!image) throw new Error("native second touch has no actual RETURNING row");
    const readback = await f.row(signed.digest);
    if (!readback) throw new Error("independent native readback has no row");
    expect(image).toEqual(readback);
    expect(image.digest).toBe(selected.sessionDigest);
    expect(selected.sessionVersion).toBe(2);
    expect(image.version).toBe(selected.sessionVersion);
    expect(image.account_id).toBe(selected.accountId);
    expect(image.principal_id).toBe(selected.principalId);
    expect(image.workspace_id).toBe(selected.sessionWorkspaceId);
    expect(image.created_at).toBe(selected.createdAt);
    expect(image.last_used_at).toBe(selected.lastUsedAt);
    expect(image.grant_checked_at).toBe(selected.grantCheckedAt);
    expect(image.absolute_expires_at).toBe(selected.absoluteExpiresAt);
    expect(selected.observedAt).toBe(f.now());
    expect(observing.consumers.sharedAuth.finalSessionSelection(context)).toBe(selected);
    expect(observing.consumers.sharedAuth.finalSessionSelection({ ...context })).toBeNull();
    noRefresh(f.issuer);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("native committed touch with damaged ACK cannot reload, resend or substitute a row", async () => {
  const f = await fixture();
  try {
    const signed = await f.signedIn();
    const observing = await f.requestScope();
    f.advance();
    observing.trace.damageFirstAck = true;
    observing.trace.armed = true;
    await expect(
      observing.consumers.sharedAuth.observeFinalSession(f.sessionRequest(signed.cookie)),
    ).rejects.toMatchObject({ code: "session_unavailable" });
    expect(observing.trace.primaryCalls).toBe(1);
    expect(observing.trace.reads).toHaveLength(1);
    expect(observing.trace.batches).toHaveLength(1);
    const committed = touchAck(observing.trace, 0);
    expect(committed.success).toBe(true);
    expect(committed.meta?.changes).toBe(1);
    expect(committed.results).toHaveLength(1);
    expect((await f.row(signed.digest))?.version).toBe(1);
    expect(observing.consumers.sharedAuth.finalSessionSelection(null)).toBeNull();
    noRefresh(f.issuer);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);

test("native incompatible payload or health race permits one reload and no retouch", async () => {
  const f = await fixture();
  try {
    for (const changed of ["payload", "health"] as const) {
      const signed = await f.signedIn();
      const observing = await f.requestScope();
      const competing = await f.requestScope();
      f.advance();
      let competitors = 0;
      observing.trace.beforeFirstBatch = async () => {
        competitors++;
        const result =
          changed === "payload"
            ? await competing.consumers.sql.run(
                "UPDATE shared_auth_sessions SET payload = payload || '.incompatible', version = version + 1 WHERE digest = ? AND version = 0 RETURNING *",
                [signed.digest],
              )
            : await competing.consumers.sql.run(
                "UPDATE shared_auth_sessions SET grant_checked_at = ?, last_used_at = ?, version = version + 1 WHERE digest = ? AND version = 0 RETURNING *",
                [f.now(), f.now(), signed.digest],
              );
        expect(result.changes).toBe(1);
        expect(result.rows).toHaveLength(1);
      };
      observing.trace.armed = true;
      await expect(
        observing.consumers.sharedAuth.observeFinalSession(f.sessionRequest(signed.cookie)),
      ).rejects.toMatchObject({ code: "session_unavailable" });
      expect(competitors).toBe(1);
      expect(observing.trace.primaryCalls).toBe(1);
      expect(observing.trace.reads).toHaveLength(2);
      expect(observing.trace.batches).toHaveLength(1);
      expect(touchAck(observing.trace, 0).meta?.changes).toBe(0);
      expect(touchAck(observing.trace, 0).results).toEqual([]);
      expect((await f.row(signed.digest))?.version).toBe(1);
      expect(observing.consumers.sharedAuth.finalSessionSelection(null)).toBeNull();
    }
    noRefresh(f.issuer);
  } finally {
    await f.runtime.dispose();
  }
}, 60_000);
