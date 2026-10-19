import { expect, test } from "bun:test";
import * as financialRequestOrigin from "@takoserver/core/financial-request-origin";
import { Miniflare } from "miniflare";
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { assertRetainedDirectOwnerSessionReader } from "../src/auth.ts";
import { additiveAuthTokenDDL } from "../src/auth-authority-schema-plan.ts";
import { readWorkerRequestFinancialAuthConsumerPort } from "../src/financial-auth-consumer.ts";
import { createFinancialCurrentConsentCustomerExecutor } from "../src/financial-current-consent-customer.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { resolveIdentity } from "../src/identity-setup.ts";
import { base64UrlEncode, bytesDigest } from "../src/json.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import type { Row } from "../src/ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import type { D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  captureWorkerSharedAuthStaging,
  createWorkerRequestConsumersWithUnregisteredLocalIssuer,
  createWorkerRequestSql,
  readWorkerRequestConsumers,
  type WorkerRequestDatabase,
} from "../src/worker-request-composition.ts";
import {
  HOSTED_BILLING_REALM_TEST_INSTANT,
  hostedBillingRealmTestMigrations,
} from "./helpers/hosted-billing-realm-fixture.ts";
import { SHARED_AUTH_TEST_ONLY_DDL } from "./helpers/shared-auth-session-fixture.ts";

// Native SQLite/D1 mechanical request origin only. The existing <=0099 fixture
// plus unregistered token-only candidate is neither installed Auth103 nor a
// physical target, distinct human, qualified Financial port or mounted Worker.
const WRITER = `sha256:${"e".repeat(64)}`;
const ACCOUNT = "acct_requestCredentialNative";
const AUTHORITY = "request-credential-native-component";
const PRICE = "price_requestCredentialNative";
const retainedStages = ["token", "class", "anchor", "currentness"] as const;
type RetainedStage = (typeof retainedStages)[number];
type StatementKind =
  | "permit-enter"
  | "permit-exit"
  | "principal"
  | "anchor"
  | "token"
  | "class"
  | "other";

function retainedStage(sql: string): RetainedStage | "other" {
  if (sql.startsWith("SELECT id, kind, principal_id")) return "token";
  if (sql.startsWith("SELECT * FROM credential_authority_classes")) return "class";
  if (sql.startsWith("SELECT * FROM auth_principal_incarnations")) return "anchor";
  if (sql.startsWith("SELECT CASE WHEN ")) return "currentness";
  return "other";
}

function statementKind(sql: string): StatementKind {
  const head = sql.trimStart();
  if (head.startsWith("INSERT INTO money_cutover_writer_permit")) return "permit-enter";
  if (head.startsWith("DELETE FROM money_cutover_writer_permit")) return "permit-exit";
  if (head.startsWith("INSERT INTO principals ")) return "principal";
  if (head.startsWith("INSERT INTO auth_principal_incarnations")) return "anchor";
  if (head.startsWith("INSERT INTO auth_tokens")) return "token";
  if (head.startsWith("INSERT INTO credential_authority_classes")) return "class";
  return "other";
}

interface NativeTrace {
  primaryCalls: number;
  rootCalls: number;
  armed: boolean;
  readonly reads: (RetainedStage | "other")[];
  readonly batches: {
    readonly kinds: readonly StatementKind[];
    readonly success: readonly boolean[];
    readonly changes: readonly number[];
  }[];
  fault: { readonly stage: RetainedStage; readonly kind: "incomplete" | "lost" } | null;
  damagedRead: {
    readonly stage: RetainedStage;
    readonly success: boolean;
    readonly rows: number;
  } | null;
  beforeCurrentness: (() => Promise<void>) | null;
}

async function fixture() {
  const id = `request-credential-d1-${crypto.randomUUID()}`;
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
    // Reuse the two owning fixtures' exact setup sources. No new DDL, schema
    // registration, Principal/class row seed or canonical SQL body copy.
    for (const source of [
      ...(await hostedBillingRealmTestMigrations()),
      ...SHARED_AUTH_TEST_ONLY_DDL,
      MONEY_CUTOVER_FREEZE_DDL,
      MONEY_CUTOVER_PERMIT_DDL,
      MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
      MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
      moneyFenceInstallSql("0094"),
      additiveAuthTokenDDL,
    ]) {
      try {
        const statements = frameHostMigrationSql(source);
        if (statements.length > 0)
          await setup.batch(statements.map((statement) => setup.prepare(statement)));
      } catch (error) {
        // A native setup error must not expose programmatically imported SQL.
        // Preserve failure without attaching raw messages, queries or causes.
        const message = error instanceof Error ? error.message : typeof error;
        const digest = await bytesDigest(new TextEncoder().encode(message));
        throw new Error(`Native request schema fixture failed (${digest})`);
      }
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

    const now = Date.now();
    const clock = () => new Date(now);
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = await crypto.subtle.exportKey("jwk", pair.publicKey);
    const audience = SHARED_AUTH_STAGING_PROFILE.publicOrigin;
    const identity = resolveIdentity({
      operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(publicKey.x) },
      operatorAudience: audience,
      clock,
    }).verifier;
    const client = createStripeBillingClient({
      secretKey: "sk_test_request_credential_native_fixture",
      mode: "test",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (request.method !== "GET") throw new Error("fixture permits no processor mutation");
        if (path === "/v1/account") return Response.json({ id: ACCOUNT, object: "account" });
        if (path !== `/v1/prices/${PRICE}`) throw new Error("unexpected fixture processor read");
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
    const sharedAuth = captureWorkerSharedAuthStaging({
      kind: "shared-auth-staging-v1",
      clientSecret: "test-only-unused-request-rp-secret",
      encryptionKey: new Uint8Array(32).fill(47),
      principals: {
        async resolve(): Promise<never> {
          throw new Error("local credential fixture grants no shared human or RP Principal");
        },
      },
      async fetch(): Promise<never> {
        throw new Error("local credential fixture permits no Accounts transport");
      },
    });

    async function requestScope() {
      const trace: NativeTrace = {
        primaryCalls: 0,
        rootCalls: 0,
        armed: false,
        reads: [],
        batches: [],
        fault: null,
        damagedRead: null,
        beforeCurrentness: null,
      };
      const observed: WorkerRequestDatabase = {
        prepare(): never {
          trace.rootCalls++;
          throw new Error("request used root binding instead of first-primary");
        },
        async batch(): Promise<never> {
          trace.rootCalls++;
          throw new Error("request batched on root binding");
        },
        withSession(constraint) {
          trace.primaryCalls++;
          expect(constraint).toBe("first-primary");
          const session = database.withSession(constraint);
          // Statement forwarding only; this map cannot mint Auth/request origins.
          const originals = new WeakMap<
            D1StatementLike,
            { readonly native: ReturnType<typeof session.prepare>; readonly sql: string }
          >();
          function forward(
            native: ReturnType<typeof session.prepare>,
            sql: string,
          ): D1StatementLike {
            const statement: D1StatementLike = {
              bind(...values) {
                return forward(native.bind(...values), sql);
              },
              async all(): Promise<D1ResultLike> {
                const stage = retainedStage(sql);
                if (trace.armed) trace.reads.push(stage);
                if (trace.armed && stage === "currentness") await trace.beforeCurrentness?.();
                const result = await native.all<Row>();
                const fault = trace.fault;
                if (trace.armed && fault && stage === fault.stage) {
                  trace.damagedRead = {
                    stage: fault.stage,
                    success: result.success,
                    rows: result.results.length,
                  };
                  // Real native read completed. Damage only its acknowledgement;
                  // do not fabricate rows, retry, or replace any Auth method.
                  if (fault.kind === "lost") throw new Error("synthetic native read ACK lost");
                  return { ...result, results: null };
                }
                return result;
              },
            };
            originals.set(statement, { native, sql });
            return statement;
          }
          return {
            prepare: (sql) => forward(session.prepare(sql), sql),
            async batch(statements) {
              const selected = statements.map((statement) => {
                const original = originals.get(statement);
                if (!original) throw new Error("native batch crossed request primaries");
                return original;
              });
              const packets = await session.batch<Row>(selected.map((item) => item.native));
              trace.batches.push({
                kinds: selected.map((item) => statementKind(item.sql)),
                success: packets.map((packet) => packet.success),
                changes: packets.map((packet) => packet.meta.changes),
              });
              return packets;
            },
          };
        },
      };
      // The selected profile uses the real common native constructor. A plain
      // native-primary purpose is deliberately not a consumer graph capability.
      const connection = await createWorkerRequestSql({
        database: observed,
        writerEpoch: WRITER,
        publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
        consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
      });
      const realm = await verifyHostedBillingFinancialRealm({
        sql: connection.sql,
        reader: { client },
        expected: { accountId: ACCOUNT, billingAuthority: AUTHORITY, mode: "test" },
        prices: [{ priceId: PRICE, monthlyAmountMinor: 1000 }],
      });
      const consumers = createWorkerRequestConsumersWithUnregisteredLocalIssuer({
        connection,
        sql: connection.sql,
        client,
        realm,
        sharedAuth,
        identity,
        clock,
        randomId: () => crypto.randomUUID(),
        publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
        consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
      });
      const accounts = consumers.accounts;
      assertRetainedDirectOwnerSessionReader(accounts, { sql: connection.sql });
      expect(readWorkerRequestConsumers(connection)).toBe(consumers);
      expect(consumers.sql).toBe(connection.sql);
      expect(consumers.realm).toBe(realm);
      expect(trace.primaryCalls).toBe(1);
      expect(trace.rootCalls).toBe(0);
      return { trace, connection, consumers, accounts, realm, clock };
    }

    async function signedIn() {
      const scope = await requestScope();
      const payload = base64UrlEncode(
        new TextEncoder().encode(
          JSON.stringify({
            purpose: "sign-in",
            aud: audience,
            provider: "google",
            subject: "native-request-local-person",
            email: "native-request-local-person@example.test",
            displayName: "Native request local person",
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
      const issued = await scope.accounts.signIn({
        provider: "google",
        method: "operator-assertion",
        audience,
        assertion: `${payload}.${base64UrlEncode(new Uint8Array(signature))}`,
      });
      return { ...scope, issued, authorization: `Bearer ${issued.sessionToken}` };
    }

    async function counts() {
      const result = await setup
        .prepare(`SELECT
          (SELECT COUNT(*) FROM principals) AS principals,
          (SELECT COUNT(*) FROM auth_principal_incarnations) AS anchors,
          (SELECT COUNT(*) FROM auth_tokens) AS tokens,
          (SELECT COUNT(*) FROM credential_authority_classes) AS classes`)
        .all<Row>();
      const row = result.results[0];
      if (!row) throw new Error("native count readback missing");
      return [row.principals, row.anchors, row.tokens, row.classes];
    }
    return { runtime, requestScope, signedIn, counts };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}

test("native request preserves actual issued direct handle and same original inputs", async () => {
  const f = await fixture();
  try {
    expect(await f.counts()).toEqual([0, 0, 0, 0]);
    const r = await f.signedIn();
    expect(await f.counts()).toEqual([1, 1, 1, 1]);
    const issuance = r.trace.batches.filter((batch) => batch.kinds.includes("class"));
    expect(issuance).toHaveLength(1);
    // Four real issuer statements share exactly one native Money permit pair.
    expect(issuance[0]?.kinds).toEqual([
      "permit-enter",
      "principal",
      "anchor",
      "token",
      "class",
      "permit-exit",
    ]);
    expect(issuance[0]?.success).toEqual([true, true, true, true, true, true]);
    expect(issuance[0]?.changes).toEqual([1, 1, 1, 1, 1, 1]);
    expect(await r.accounts.authenticate(r.authorization)).toMatchObject({
      principalId: r.issued.principal.id,
      kind: "session",
    });
    const ordinary = await r.accounts.captureAuthenticatedToken(r.authorization);
    expect(
      financialRequestOrigin.readWorkerRequestRetainedCredentialInputs(r.connection, ordinary),
    ).toBeNull();
    r.trace.armed = true;
    const batches = r.trace.batches.length;
    const capture = await financialRequestOrigin.captureWorkerRequestRetainedDirectOwnerSession(
      r.connection,
      r.authorization,
    );
    expect(capture).not.toBeNull();
    expect(r.trace.reads).toEqual([...retainedStages]);
    expect(r.trace.batches).toHaveLength(batches);
    const direct = r.accounts.readRetainedDirectOwnerSessionCapture(capture);
    const original = financialRequestOrigin.readWorkerRequestRetainedCredentialInputs(
      r.connection,
      capture,
    );
    if (!direct || !original) throw new Error("actual native retained direct origin missing");
    expect(original.credentialOriginal).toBe(direct);
    expect(direct.record.origin.principalId).toBe(r.issued.principal.id);
    expect(direct.record.origin.targetRef).toBe("auth103:unregistered-local-candidate");
    expect(direct.record.class).toBe("direct-owner-session");
    expect(original.inputs).toBe(
      financialRequestOrigin.readWorkerRequestFinancialInputs(r.connection),
    );
    expect(original.inputs.sql).toBe(r.connection.sql);
    expect(original.inputs.realm).toBe(r.realm);
    expect(original.inputs.clock).toBe(r.clock);
    expect(original.inputs.writerEpoch).toBe(WRITER);
    expect(JSON.stringify(capture)).toBe("{}");
    expect(
      financialRequestOrigin.readWorkerRequestRetainedCredentialInputs(r.connection, {
        ...capture,
      }),
    ).toBeNull();
    const foreign = await f.requestScope();
    expect(foreign.connection.sql).not.toBe(r.connection.sql);
    expect(
      financialRequestOrigin.readWorkerRequestRetainedCredentialInputs(foreign.connection, capture),
    ).toBeNull();
    const reads = r.trace.reads.length;
    const clone = { ...r.connection };
    expect(() =>
      financialRequestOrigin.readWorkerRequestRetainedCredentialInputs(clone, capture),
    ).toThrow("not been constructed");
    await expect(
      financialRequestOrigin.captureWorkerRequestRetainedDirectOwnerSession(clone, r.authorization),
    ).rejects.toThrow("not been constructed");
    expect(r.trace.reads).toHaveLength(reads);
    expect(r.trace.primaryCalls).toBe(1);
    expect(r.trace.rootCalls).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

test("native original request refuses Financial Customer before its Auth103 port with no new effect", async () => {
  const f = await fixture();
  try {
    const r = await f.requestScope();
    const reads = r.trace.reads.length;
    const batches = r.trace.batches.length;
    const primaryCalls = r.trace.primaryCalls;
    const rootCalls = r.trace.rootCalls;
    const counts = await f.counts();
    expect(readWorkerRequestFinancialAuthConsumerPort(r.connection)).toBeNull();
    expect(() =>
      createFinancialCurrentConsentCustomerExecutor(
        r.connection,
        undefined as never,
        new Request("https://fixture.invalid/financial-current-consent"),
        "fixture-workspace",
        undefined as never,
        undefined as never,
        undefined as never,
      ),
    ).toThrow("financial current consent customer unavailable");
    expect(r.trace.reads).toHaveLength(reads);
    expect(r.trace.batches).toHaveLength(batches);
    expect(r.trace.primaryCalls).toBe(primaryCalls);
    expect(r.trace.rootCalls).toBe(rootCalls);
    expect(await f.counts()).toEqual(counts);
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);

for (const fault of [
  ...retainedStages.map((stage) => ({ stage, kind: "incomplete" as const })),
  { stage: "currentness", kind: "lost" },
] as const) {
  test(`native ${fault.stage} ${fault.kind} ACK refuses without requery or fallback`, async () => {
    const f = await fixture();
    try {
      const r = await f.signedIn();
      r.trace.fault = fault;
      r.trace.armed = true;
      const batches = r.trace.batches.length;
      await expect(
        financialRequestOrigin.captureWorkerRequestRetainedDirectOwnerSession(
          r.connection,
          r.authorization,
        ),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(r.trace.damagedRead).toEqual({ stage: fault.stage, success: true, rows: 1 });
      expect(r.trace.reads).toEqual(
        retainedStages.slice(0, retainedStages.indexOf(fault.stage) + 1),
      );
      expect(r.trace.batches).toHaveLength(batches);
      expect(r.trace.primaryCalls).toBe(1);
      expect(r.trace.rootCalls).toBe(0);
      expect(await f.counts()).toEqual([1, 1, 1, 1]);
      r.trace.armed = false;
      expect(await r.accounts.authenticate(r.authorization)).toMatchObject({ kind: "session" });
    } finally {
      await f.runtime.dispose();
    }
  }, 30_000);
}

test("native revoke race refuses new capture and preserves history", async () => {
  const f = await fixture();
  try {
    const r = await f.signedIn();
    const capture = await financialRequestOrigin.captureWorkerRequestRetainedDirectOwnerSession(
      r.connection,
      r.authorization,
    );
    const original = financialRequestOrigin.readWorkerRequestRetainedCredentialInputs(
      r.connection,
      capture,
    );
    if (!original) throw new Error("native historical direct original missing");
    const history = structuredClone(original.credentialOriginal);
    let revocations = 0;
    r.trace.beforeCurrentness = async () => {
      r.trace.beforeCurrentness = null;
      revocations++;
      await r.accounts.revokeSession(r.authorization);
      const revocation = r.trace.batches.at(-1);
      expect(revocation?.kinds).toEqual(["permit-enter", "other", "permit-exit"]);
      expect(revocation?.changes).toEqual([1, 2, 1]);
      expect(revocation?.success).toEqual([true, true, true]);
    };
    r.trace.armed = true;
    const batches = r.trace.batches.length;
    expect(
      await financialRequestOrigin.captureWorkerRequestRetainedDirectOwnerSession(
        r.connection,
        r.authorization,
      ),
    ).toBeNull();
    expect(revocations).toBe(1);
    expect(r.trace.reads).toEqual([...retainedStages]);
    expect(r.trace.batches).toHaveLength(batches + 1); // actual revoke, no issuer/fallback batch
    r.trace.armed = false;
    expect(await r.accounts.authenticate(r.authorization)).toBeNull();
    expect(
      financialRequestOrigin.readWorkerRequestRetainedCredentialInputs(r.connection, capture)
        ?.credentialOriginal,
    ).toBe(original.credentialOriginal);
    expect(original.credentialOriginal).toEqual(history);
    expect(await f.counts()).toEqual([1, 1, 1, 1]);
    expect(r.trace.primaryCalls).toBe(1);
    expect(r.trace.rootCalls).toBe(0);
  } finally {
    await f.runtime.dispose();
  }
}, 30_000);
