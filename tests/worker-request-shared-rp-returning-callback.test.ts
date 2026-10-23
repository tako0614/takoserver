// The returning-subject path through the real request graph: actual RP login
// and callback HTTP against the signed test issuer, the real Root principal
// projection, the qualified fresh session store and the issuance store, all on
// one same-primary connection. Only the native platform boundary is replaced:
// the opaque Auth103 native origin (which needs a registered build and the
// workerd platform binding) is a per-graph test original whose readers return
// fixed synthetic DATA for that graph's own connection only.
//
// Limits: the real reader's platform and request-input identity checks are
// not exercised, and the in-batch native currentness predicate is `1=1` here
// (binding currentness inside the batch is covered by the served-D1 tests).
// The target-change case pins that the projection's own recheck refuses in
// the principal phase, before session_write; a real capture's manifest is
// frozen. Nothing here qualifies a native target, Clock, human or Financial
// permission.
import { Database } from "bun:sqlite";
import { afterEach, expect, mock, spyOn, test } from "bun:test";
import { resolve } from "node:path";
import { createAuth103CanonicalSourceArtifacts } from "../scripts/deploy/auth103-canonical-recipes.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { FINANCIAL_0104_DDL } from "../src/financial-0104-source-contract.ts";
import type { SqlParam, SqlStatement, SqlWrite } from "../src/ports.ts";
import { ROOT_0105_DDL } from "../src/root-0105-org-capture-triggers.ts";
import type { D1DatabaseLike, D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";
import { createSqliteSql } from "../src/sql-sqlite.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import {
  HOSTED_BILLING_REALM_TEST_INSTANT,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_CONFIG,
  SESSION_TEST_PERSONAL,
} from "./helpers/shared-auth-session-issuer.ts";

const ROOT = resolve(import.meta.dir, "..");
const NATIVE_MODULE = resolve(ROOT, "src/auth103-native-origin-source.ts");
const real = await import(NATIVE_MODULE);
const TARGET = `sha256:${"1".repeat(64)}`;
const SOURCE = `sha256:${"2".repeat(64)}`;
const native = {
  /** Each graph's test original, bound to that graph's own connection. */
  origins: new WeakMap<object, object>(),
  targetRef: TARGET,
};
/** Like the real readers: an unknown original or another connection reads null. */
const ownOrigin = (capture: unknown, connection: unknown) =>
  typeof capture === "object" &&
  capture !== null &&
  typeof connection === "object" &&
  connection !== null &&
  native.origins.get(capture) === connection;
mock.module(NATIVE_MODULE, () => ({
  ...real,
  readAuth103NativeRequestOrigin(capture: unknown, connection: unknown) {
    if (!ownOrigin(capture, connection)) return null;
    return Object.freeze({
      authSchemaRef: `sha256:${"3".repeat(64)}`,
      targetRef: native.targetRef,
      sourceRef: SOURCE,
      clockPolicyRef: `sha256:${"4".repeat(64)}`,
    });
  },
  readAuth103NativeRpRegistrationOriginal(capture: unknown, connection: unknown) {
    if (!ownOrigin(capture, connection)) return null;
    return Object.freeze({
      registrationRef: `sha256:${"5".repeat(64)}`,
      registrationDigest: `sha256:${"6".repeat(64)}`,
      profile: Object.freeze({
        issuer: SESSION_TEST_CONFIG.issuer,
        clientId: SESSION_TEST_CONFIG.clientId,
      }),
      native: Object.freeze({ targetRef: TARGET, sourceRef: SOURCE }),
    });
  },
  auth103NativeRequestCurrentness() {
    return Object.freeze({ sql: "1=1", params: Object.freeze([]) });
  },
  async captureAuth103NativeFinancialProofReceiver() {
    return null;
  },
}));

const { createAuth103SourceClock } = await import("../src/auth103-source-clock.ts");
const { verifyHostedBillingFinancialRealm } = await import("../src/hosted-billing-realm.ts");
const { resolveIdentity } = await import("../src/identity-setup.ts");
const { SHARED_AUTH_STAGING_PROFILE } = await import("../src/shared-auth-oidc-client.ts");
const { createStripeBillingClient } = await import("../src/stripe-billing-client.ts");
const {
  captureWorkerSharedAuthStaging,
  createWorkerFreshNativeRequestSql,
  createWorkerRequestConsumersWithQualifiedLocalIssuer,
  initializeWorkerRequestNativeInputs,
} = await import("../src/worker-request-composition.ts");
const { createWorkerRequestSharedRpOriginalPrincipalProjection } = await import(
  "../src/worker-request-shared-principal-issuance.ts"
);
const { workspaceBillingOrganizationRef } = await import(
  "../src/workspace-billing-organization.ts"
);

const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
const ACCOUNT = "acct_ReturningRPFixture";
const AUTHORITY = "returning-rp-component";
const PRICE = "price_returning_rp_fixture";
const WORKSPACE_REF = `wrk_${"7".repeat(32)}`;

const cookieFrom = (response: Response, name: string) => {
  const selected = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!selected) throw new Error("actual protocol cookie absent");
  return selected.split(";")[0] ?? "";
};

async function fixture() {
  const stamp = Date.now();
  const issuer = await createSharedSessionTestIssuer(() => Date.now());
  const organizationId = await workspaceBillingOrganizationRef(AUTHORITY, WORKSPACE_REF);
  issuer.control.personalBillingOrganization = Object.freeze({
    workspaceId: SESSION_TEST_PERSONAL.id,
    workspaceRef: WORKSPACE_REF,
    organizationId,
  });
  // The served schema: migrations through 0100, the Auth103 canonical source,
  // Financial 0104 and Root 0105.
  const db = new Database(":memory:", { strict: true });
  closes.push(() => db.close());
  db.exec("PRAGMA foreign_keys = ON");
  for (const source of [
    ...MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100).map(({ sql }) => sql),
    ...createAuth103CanonicalSourceArtifacts(ROOT).files.map(({ sql }) => sql),
    FINANCIAL_0104_DDL,
    ROOT_0105_DDL,
  ])
    for (const statement of frameHostMigrationSql(source)) db.query(statement).run();
  const database = { db, sql: createSqliteSql(db) };
  await database.sql.run("INSERT INTO stripe_mode_realm VALUES (1, ?, ?)", [
    "test",
    HOSTED_BILLING_REALM_TEST_INSTANT,
  ]);
  await seedHostedBillingRealmTestPin(database.sql, {
    accountId: ACCOUNT,
    billingAuthority: AUTHORITY,
  });
  const hooks = { onQuery: null as ((sql: string) => void) | null };
  const acknowledgement = (write: SqlWrite): D1ResultLike => ({
    success: true,
    results: write.rows,
    meta: { changes: write.changes },
  });
  const binding = {
    prepare() {
      throw new Error("root binding is not the original primary session");
    },
    async batch() {
      throw new Error("root binding batch forbidden");
    },
    withSession() {
      const originals = new WeakMap<D1StatementLike, SqlStatement>();
      const primary: D1DatabaseLike = {
        prepare(sql) {
          const statement: D1StatementLike = {
            bind(...params: readonly SqlParam[]) {
              originals.set(statement, { sql, params });
              return statement;
            },
            async all() {
              const original = originals.get(statement);
              if (!original) throw new Error("foreign statement");
              hooks.onQuery?.(original.sql);
              return acknowledgement(await database.sql.run(original.sql, original.params));
            },
          };
          originals.set(statement, { sql });
          return statement;
        },
        async batch(statements) {
          const selected = statements.map((statement) => {
            const s = originals.get(statement);
            if (!s) throw new Error("foreign batch");
            return s;
          });
          return (await database.sql.batch(selected)).map(acknowledgement);
        },
      };
      return primary;
    },
  };
  const client = createStripeBillingClient({
    secretKey: "sk_test_returning_rp_fixture",
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
  // The original local verifier the qualified constructor requires. No local
  // sign-in happens in these tests.
  const operator = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const operatorKey = await crypto.subtle.exportKey("jwk", operator.publicKey);
  const identity = resolveIdentity({
    operatorPublicKeyJwk: { kty: "OKP", crv: "Ed25519", x: String(operatorKey.x) },
    operatorAudience: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
    clock: () => new Date(),
  }).verifier;
  /**
   * One qualified request graph: its own same-primary connection, the actual
   * Root projection bound to that connection, one native initialization and
   * the one qualified constructor. `wrap` may observe the projection only.
   */
  const graph = async (
    wrap?: (
      projection: ReturnType<typeof createWorkerRequestSharedRpOriginalPrincipalProjection>,
    ) => ReturnType<typeof createWorkerRequestSharedRpOriginalPrincipalProjection>,
  ) => {
    // The qualified fresh-native request connection: one first-primary
    // session with the strict D1 driver and the fresh-native Sql wrapper.
    const connection = createWorkerFreshNativeRequestSql(binding as never);
    const realm = await verifyHostedBillingFinancialRealm({
      sql: connection.sql,
      reader: { client },
      expected: { accountId: ACCOUNT, billingAuthority: AUTHORITY, mode: "test" },
      prices: [{ priceId: PRICE, monthlyAmountMinor: 1000 }],
    });
    const projection = createWorkerRequestSharedRpOriginalPrincipalProjection(connection);
    const options = {
      connection,
      sql: connection.sql,
      realm,
      client,
      sharedAuth: captureWorkerSharedAuthStaging({
        kind: "shared-auth-staging-v1",
        clientSecret: SESSION_TEST_CONFIG.clientSecret,
        encryptionKey: new Uint8Array(32).fill(7),
        fetch: issuer.send,
        principals: wrap ? wrap(projection) : projection,
      }),
      identity,
      clock: createAuth103SourceClock(),
      randomId: () => crypto.randomUUID(),
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    };
    initializeWorkerRequestNativeInputs(options as never);
    const origin = Object.freeze({});
    native.origins.set(origin, connection);
    return await createWorkerRequestConsumersWithQualifiedLocalIssuer(
      options as never,
      origin as never,
    );
  };
  const callback = async (runtime: Awaited<ReturnType<typeof graph>>) => {
    const login = await runtime.sharedAuth.fetch(
      new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/login`),
    );
    const location = login?.headers.get("location");
    if (login?.status !== 303 || !location) throw new Error("actual RP login did not start");
    const response = await runtime.sharedAuth.fetch(
      new Request(issuer.authorize(location), {
        headers: { cookie: cookieFrom(login, "__Host-takoserver_oidc_attempt") },
      }),
    );
    if (!response) throw new Error("actual RP callback absent");
    return response;
  };
  const rows = (sql: string) => database.db.query(sql).all();
  const counts = () =>
    Object.fromEntries(
      [
        "principals",
        "auth_principal_incarnations",
        "shared_principal_bindings",
        "shared_auth_sessions",
        "credential_authority_classes",
        "orgs",
        "org_memberships",
        "org_wallet_workspace_bindings",
      ].map((table) => [
        table,
        (database.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
      ]),
    );
  return { stamp, database, issuer, organizationId, hooks, graph, callback, rows, counts };
}

/** The callback's private failure marker phase, read from the console. */
async function failurePhase(run: () => Promise<Response>) {
  const spy = spyOn(console, "error").mockImplementation(() => {});
  try {
    const response = await run();
    const phases = spy.mock.calls
      .map((call) => {
        try {
          return JSON.parse(String(call[0]));
        } catch {
          return null;
        }
      })
      .filter((line) => line?.marker === "takoserver.shared_auth.callback.failure.v1")
      .map((line) => line.phase);
    return { response, phases };
  } finally {
    spy.mockRestore();
  }
}

test("a returning subject's callback reuses its binding, and a retired binding is refused", async () => {
  const f = await fixture();
  native.targetRef = TARGET;
  const first = await f.callback(await f.graph());
  expect(first.status).toBe(303);
  const enrolled = f.rows(
    "SELECT binding_ref, principal_id, target_ref, state FROM shared_principal_bindings",
  );
  expect(enrolled).toHaveLength(1);
  expect(f.counts()).toMatchObject({
    principals: 1,
    shared_principal_bindings: 1,
    shared_auth_sessions: 1,
    credential_authority_classes: 1,
    orgs: 1,
    org_memberships: 1,
    org_wallet_workspace_bindings: 1,
  });

  // A later login on a NEW request graph: same principal, binding and Org.
  const second = await f.callback(await f.graph());
  expect(second.status).toBe(303);
  expect(f.counts()).toMatchObject({
    principals: 1,
    auth_principal_incarnations: 1,
    shared_principal_bindings: 1,
    shared_auth_sessions: 2,
    credential_authority_classes: 2,
    orgs: 1,
    org_memberships: 1,
    org_wallet_workspace_bindings: 1,
  });
  const [bound] = enrolled as { binding_ref: string; principal_id: string }[];
  expect(
    f.rows(
      "SELECT DISTINCT principal_binding_ref, principal_id, organization_id FROM credential_authority_classes",
    ),
  ).toEqual([
    {
      principal_binding_ref: bound?.binding_ref,
      principal_id: bound?.principal_id,
      organization_id: f.organizationId,
    },
  ]);
  expect(f.rows("SELECT DISTINCT principal_id FROM shared_auth_sessions")).toEqual([
    { principal_id: bound?.principal_id },
  ]);
  expect(f.rows("SELECT owner_principal_id FROM orgs")).toEqual([
    { owner_principal_id: bound?.principal_id },
  ]);

  // Retired: the callback is refused before any write and never re-enrolls.
  f.database.db
    .query(
      `UPDATE shared_principal_bindings SET state='retired', terminal_reason='fixture-retired',
        terminal_at=?, terminal_ref='fixture-retire' WHERE binding_ref=?`,
    )
    .run(new Date().toISOString(), bound?.binding_ref ?? "");
  const before = f.counts();
  const { response, phases } = await failurePhase(async () => f.callback(await f.graph()));
  expect(response.status).toBe(503);
  expect(phases).toEqual(["principal"]);
  expect(f.counts()).toEqual(before);
}, 60000);

test("two resolutions on one request graph cannot both hold a pending issuance", async () => {
  const f = await fixture();
  native.targetRef = TARGET;
  const outcomes: PromiseSettledResult<unknown>[] = [];
  const response = await f.callback(
    await f.graph((projection) => ({
      async resolve(input, original) {
        // The same verified original twice on the same connection: the
        // projection must refuse the second after its own awaits.
        const settled = await Promise.allSettled([
          projection.resolve(input, original),
          projection.resolve(input, original),
        ]);
        outcomes.push(...settled);
        const won = settled.find((result) => result.status === "fulfilled");
        if (!won) throw new Error("no resolution");
        return (won as PromiseFulfilledResult<Awaited<ReturnType<typeof projection.resolve>>>)
          .value;
      },
    })),
  );
  expect(outcomes.map((outcome) => outcome.status).sort()).toEqual(["fulfilled", "rejected"]);
  expect(response.status).toBe(303);
  expect(f.counts()).toMatchObject({
    principals: 1,
    shared_principal_bindings: 1,
    shared_auth_sessions: 1,
  });
}, 60000);

test("a native target that changes during resolution refuses the callback before session_write", async () => {
  const f = await fixture();
  native.targetRef = TARGET;
  expect((await f.callback(await f.graph())).status).toBe(303);
  const before = f.counts();
  const runtime = await f.graph();
  // The target moves while the projection reads the subject's bindings.
  f.hooks.onQuery = (sql) => {
    if (sql.includes("FROM shared_principal_bindings WHERE issuer=?"))
      native.targetRef = `sha256:${"9".repeat(64)}`;
  };
  try {
    const { response, phases } = await failurePhase(() => f.callback(runtime));
    expect(response.status).toBe(503);
    expect(phases).toEqual(["principal"]);
    expect(f.counts()).toEqual(before);
  } finally {
    f.hooks.onQuery = null;
    native.targetRef = TARGET;
  }
}, 60000);
