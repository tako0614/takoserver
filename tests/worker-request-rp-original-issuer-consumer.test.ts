import { afterEach, expect, test } from "bun:test";
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { additiveAuthDDL } from "../src/auth-authority-schema-plan.ts";
import { createCredentialAuthorityClassStore } from "../src/credential-authority-class.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { bytesDigest } from "../src/json.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import type { SqlParam, SqlStatement, SqlWrite } from "../src/ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import type {
  SharedAuthPrincipalProjection,
  SharedAuthVerifiedPrincipalInput,
} from "../src/shared-auth-session.ts";
import { createSharedAuthSessionStore } from "../src/shared-auth-session-store.ts";
import { createSharedPrincipalAuthorityStore } from "../src/shared-principal-authority.ts";
import type { D1DatabaseLike, D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  assertWorkerRequestNativeBinding,
  captureWorkerSharedAuthStaging,
  createWorkerRequestConsumers,
  createWorkerRequestSql,
  readWorkerRequestConsumers,
  type WorkerRequestDatabase,
  type WorkerSharedAuthStaging,
} from "../src/worker-request-composition.ts";
import {
  createWorkerRequestConsumersWithOriginalRpProjection,
  createWorkerRequestSharedRpOriginalPrincipalProjection,
  readWorkerRequestVerifiedSharedPrincipalInputs,
} from "../src/worker-request-shared-principal-issuance.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";
import { SHARED_AUTH_TEST_ONLY_DDL } from "./helpers/shared-auth-session-fixture.ts";
import {
  createSharedSessionTestIssuer,
  SESSION_TEST_ACCOUNT,
  SESSION_TEST_CONFIG,
  SESSION_TEST_CONSOLE,
  SESSION_TEST_ORGANIZATION,
  SESSION_TEST_PERSONAL_ORGANIZATION,
} from "./helpers/shared-auth-session-issuer.ts";

// Synthetic protocol+SQLite/common-graph mechanics only. No installed/native103,
// genuine human, policy Clock, NEW grant, principal enrollment or live transport.
const closes: (() => void)[] = [];
afterEach(() => {
  for (const close of closes.splice(0)) close();
});
const WRITER = `sha256:${"a".repeat(64)}`;
const PRINCIPAL = "prn_original_rp_retained_fixture";
const ACCOUNT = "acct_OriginalRPFixture";
const AUTHORITY = "original-rp-component";
const PRICE = "price_original_rp_fixture";
const cookieFrom = (response: Response, name: string) => {
  const selected = response.headers.getSetCookie().find((value) => value.startsWith(`${name}=`));
  if (!selected) throw new Error("actual protocol cookie absent");
  return selected.split(";")[0]!;
};
async function fixture() {
  const stamp = Date.now();
  const issuer = await createSharedSessionTestIssuer(() => stamp);
  issuer.control.personalBillingOrganization = SESSION_TEST_PERSONAL_ORGANIZATION;
  const database = await createHostedBillingRealmTestDatabase();
  closes.push(() => database.db.close());
  for (const ddl of SHARED_AUTH_TEST_ONLY_DDL) database.db.exec(ddl);
  database.db.exec(additiveAuthDDL);
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
  const control = {
    failClassRead: false,
    classReads: 0,
    legacyResolve: 0,
    afterClassRead: null as (() => void) | null,
  };
  const primarySessions: D1DatabaseLike[] = [];
  const captured: {
    input: Parameters<SharedAuthPrincipalProjection["resolve"]>[0];
    original: SharedAuthVerifiedPrincipalInput;
  }[] = [];
  const queries: string[] = [];
  const acknowledgement = (write: SqlWrite): D1ResultLike => ({
    success: true,
    results: write.rows,
    meta: { changes: write.changes },
  });
  const binding: WorkerRequestDatabase = {
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
              queries.push(original.sql);
              if (
                original.sql.startsWith(
                  "SELECT * FROM credential_authority_classes WHERE session_digest=?",
                )
              ) {
                control.classReads++;
                if (control.failClassRead) throw new Error("unknown original query result");
              }
              const result = acknowledgement(await database.sql.run(original.sql, original.params));
              if (
                original.sql.startsWith(
                  "SELECT * FROM credential_authority_classes WHERE session_digest=?",
                )
              )
                control.afterClassRead?.();
              return result;
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
          queries.push(...selected.map((s) => s.sql));
          return (await database.sql.batch(selected)).map(acknowledgement);
        },
      };
      primarySessions.push(primary);
      return primary;
    },
  };
  const client = createStripeBillingClient({
    secretKey: "sk_test_original_rp_fixture",
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
        recurring: {
          interval: "month",
          interval_count: 1,
          usage_type: "licensed",
        },
      });
    },
  });
  const profile = captureWorkerSharedAuthStaging({
    kind: "shared-auth-staging-v1",
    clientSecret: SESSION_TEST_CONFIG.clientSecret,
    encryptionKey: new Uint8Array(32).fill(7),
    fetch: issuer.send,
    principals: {
      async resolve(input, original) {
        control.legacyResolve++;
        captured.push({ input, original });
        return { accountId: SESSION_TEST_ACCOUNT, principalId: PRINCIPAL };
      },
    },
  });
  const options = async (sharedAuth: WorkerSharedAuthStaging = profile) => {
    const connection = await createWorkerRequestSql({
      database: binding,
      writerEpoch: WRITER,
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    });
    const realm = await verifyHostedBillingFinancialRealm({
      sql: connection.sql,
      reader: { client },
      expected: {
        accountId: ACCOUNT,
        billingAuthority: AUTHORITY,
        mode: "test",
      },
      prices: [{ priceId: PRICE, monthlyAmountMinor: 1000 }],
    });
    return {
      connection,
      sql: connection.sql,
      realm,
      client,
      sharedAuth,
      identity: {
        async verify(): Promise<never> {
          throw new Error("no local identity grant");
        },
      },
      clock: () => new Date(stamp),
      randomId: () => crypto.randomUUID(),
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    };
  };
  const begin = async (runtime: ReturnType<typeof createWorkerRequestConsumers>) => {
    const login = await runtime.sharedAuth.fetch(
      new Request(`${SESSION_TEST_CONFIG.publicOrigin}/auth/oidc/login`),
    );
    if (!login || login.status !== 303 || !login.headers.get("location"))
      throw new Error("actual RP login did not start");
    return await runtime.sharedAuth.fetch(
      new Request(issuer.authorize(login.headers.get("location")!), {
        headers: {
          cookie: cookieFrom(login, "__Host-takoserver_oidc_attempt"),
        },
      }),
    );
  };
  const counts = () =>
    [
      "principals",
      "auth_principal_incarnations",
      "shared_principal_bindings",
      "shared_auth_sessions",
      "credential_authority_classes",
    ].map(
      (table) =>
        (
          database.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
            n: number;
          }
        ).n,
    );
  return {
    ...database,
    stamp,
    issuer,
    control,
    captured,
    queries,
    options,
    begin,
    counts,
    binding,
    primarySessions,
  };
}
async function retained(withClass = true) {
  const f = await fixture();
  const at = new Date(f.stamp).toISOString();
  await f.sql.run(
    "INSERT INTO principals(id,provider,provider_subject,email,display_name,created_at) VALUES (?,'google',?,'rp-original@example.invalid','RP Original Fixture',?)",
    [PRINCIPAL, SESSION_TEST_ACCOUNT, at],
  );
  const principalBinding = await createSharedPrincipalAuthorityStore({
    sql: f.sql,
  }).bindLegacy({
    principalId: PRINCIPAL,
    principalIncarnation: "original-rp-principal-inc",
    provider: "google",
    providerSubject: SESSION_TEST_ACCOUNT,
    createdAt: at,
    origin: {
      ref: "synthetic-retained-origin",
      digest: `sha256:${"b".repeat(64)}`,
    },
    binding: {
      ref: "original-rp-binding",
      issuer: SESSION_TEST_CONFIG.issuer,
      subject: SESSION_TEST_ACCOUNT,
      controllerIncarnation: "synthetic-controller",
      targetRef: "synthetic-unregistered-target",
      evidence: {
        ref: "synthetic-retained-evidence",
        digest: `sha256:${"c".repeat(64)}`,
      },
      enrolledAt: at,
    },
  });
  const options = await f.options();
  const runtime = createWorkerRequestConsumers(options);
  const callback = await f.begin(runtime);
  if (!callback || callback.status !== 303) throw new Error("actual ordinary callback failed");
  const cookie = cookieFrom(callback, "__Host-takoserver_shared_session");
  const digest = await bytesDigest(new TextEncoder().encode(cookie.slice(cookie.indexOf("=") + 1)));
  const session = await createSharedAuthSessionStore(options.sql).readSession(digest);
  if (!session) throw new Error("actual session absent");
  if (withClass)
    await options.sql.batch([
      createCredentialAuthorityClassStore({
        sql: options.sql,
      }).sharedRpIssuanceStatement(
        {
          ref: "original-rp-authority",
          incarnation: "original-rp-credential-inc",
          targetRef: principalBinding.targetRef,
          principalId: PRINCIPAL,
          principalIncarnation: principalBinding.principalIncarnation,
          issuanceRef: "synthetic-retained-issuance",
          issuanceDigest: digest,
          issuedAt: at,
        },
        {
          principalBindingRef: principalBinding.ref,
          registrationRef: "synthetic-retained-registration",
          registrationDigest: `sha256:${"d".repeat(64)}`,
          sessionDigest: digest,
          sessionCreatedAt: session.createdAt,
          enrolledSessionVersion: session.version,
          issuer: SESSION_TEST_CONFIG.issuer,
          clientId: SESSION_TEST_CONFIG.clientId,
          subject: SESSION_TEST_ACCOUNT,
          issuerSessionId: f.issuer.sessionId,
          authTime: f.issuer.authTime,
          accountId: SESSION_TEST_ACCOUNT,
          workspaceId: session.workspaceId,
          workspaceRef: "synthetic-retained-personal-ref",
        },
        "synthetic-retained-row-org",
      ),
    ]);
  const request = () =>
    new Request(`${SESSION_TEST_CONFIG.publicOrigin}/control/root-original`, {
      method: "POST",
      headers: { cookie, origin: SESSION_TEST_CONSOLE },
    });
  return {
    ...f,
    optionsOriginal: options,
    runtimeOriginal: runtime,
    principalBinding,
    digest,
    session,
    request,
  };
}

test("capture wrapper forwards the same opaque original and original receiver", async () => {
  const original = Object.freeze({}) as SharedAuthVerifiedPrincipalInput;
  let observed: unknown;
  let receiver: unknown;
  const principals: SharedAuthPrincipalProjection = {
    async resolve(_input, capture) {
      observed = capture;
      receiver = this;
      return { accountId: "account", principalId: "principal" };
    },
  };
  const selected = captureWorkerSharedAuthStaging({
    kind: "shared-auth-staging-v1",
    clientSecret: "fixture",
    encryptionKey: new Uint8Array(32),
    principals,
  });
  await selected.principals.resolve(
    {
      issuer: "https://issuer.invalid",
      clientId: "client",
      subject: "account",
      sessionId: "sid",
      authTime: 1,
      accountId: "account",
      workspaceId: "workspace",
    },
    original,
  );
  expect(observed).toBe(original);
  expect(receiver).toBe(principals);
});

test("actual verified callback capture is accepted only on its original completed request graph", async () => {
  const f = await retained();
  const captured = f.captured[0];
  if (!captured) throw new Error("capture absent");
  const held = readWorkerRequestVerifiedSharedPrincipalInputs(
    f.optionsOriginal.connection,
    captured.original,
  );
  expect(held?.principalOriginal.phase).toBe("fresh-callback");
  expect(held?.principalOriginal.identity.accountId).toBe(SESSION_TEST_ACCOUNT);
  if (held?.principalOriginal.phase !== "fresh-callback") throw new Error("fresh original absent");
  expect(held.principalOriginal.workspaceOrganization).toEqual(SESSION_TEST_PERSONAL_ORGANIZATION);
  expect(
    readWorkerRequestVerifiedSharedPrincipalInputs(f.optionsOriginal.connection, {}),
  ).toBeNull();
  expect(
    readWorkerRequestVerifiedSharedPrincipalInputs(f.optionsOriginal.connection, {
      ...captured.original,
    }),
  ).toBeNull();
  const otherOptions = await f.options();
  createWorkerRequestConsumers(otherOptions);
  expect(
    readWorkerRequestVerifiedSharedPrincipalInputs(otherOptions.connection, captured.original),
  ).toBeNull();
  expect(() =>
    readWorkerRequestVerifiedSharedPrincipalInputs(
      { ...f.optionsOriginal.connection },
      captured.original,
    ),
  ).toThrow();
});

test("explicit Root factory resolves only retained existing Principal and preserves enrolled version and scope", async () => {
  const f = await retained();
  const oldCalls = f.control.legacyResolve;
  const options = await f.options();
  const runtime = createWorkerRequestConsumersWithOriginalRpProjection(options);
  expect(readWorkerRequestConsumers(options.connection)).toBe(runtime);
  const before = await createCredentialAuthorityClassStore({
    sql: options.sql,
  }).readActiveSharedRpSessionByDigest(f.digest);
  const context = await runtime.sharedAuth.authenticate(f.request(), SESSION_TEST_ORGANIZATION.id);
  expect(context?.actor.principalId).toBe(PRINCIPAL);
  expect(context?.workspace.id).toBe(SESSION_TEST_ORGANIZATION.id);
  expect(f.control.legacyResolve).toBe(oldCalls);
  const after = await createCredentialAuthorityClassStore({
    sql: options.sql,
  }).readActiveSharedRpSessionByDigest(f.digest);
  expect(after).toEqual(before);
  expect(after?.rp.enrolledSessionVersion).toBe(f.session.version);
  expect(after?.rp.workspaceId).toBe(f.session.workspaceId);
  const current = await createSharedAuthSessionStore(options.sql).readSession(f.digest);
  expect(current?.version).toBeGreaterThan(f.session.version);
});

test("fresh callback remains failclosed before Principal3 plus RPclass2 without original session and native issuer", async () => {
  const f = await fixture();
  const options = await f.options();
  const runtime = createWorkerRequestConsumersWithOriginalRpProjection(options);
  const before = f.counts();
  const callback = await f.begin(runtime);
  expect(callback?.status).toBe(503);
  expect(f.counts()).toEqual(before);
  expect(f.control.legacyResolve).toBe(0);
  expect(f.control.classReads).toBe(0);
});

test("missing retained class never becomes fresh enrollment or external callback fallback", async () => {
  const f = await retained(false);
  const oldCalls = f.control.legacyResolve;
  const options = await f.options();
  const runtime = createWorkerRequestConsumersWithOriginalRpProjection(options);
  const before = f.counts();
  await expect(runtime.sharedAuth.authenticate(f.request())).rejects.toThrow();
  expect(f.counts()).toEqual(before);
  expect(f.control.legacyResolve).toBe(oldCalls);
});

test("existing compatibility DATA is only checked after the real original input and must match exactly", async () => {
  const f = await retained();
  await f.runtimeOriginal.sharedAuth.authenticate(f.request(), SESSION_TEST_ORGANIZATION.id);
  const c = f.captured.at(-1);
  if (!c) throw new Error("capture absent");
  const projection = createWorkerRequestSharedRpOriginalPrincipalProjection(
    f.optionsOriginal.connection,
  );
  expect(await projection.resolve(c.input, c.original)).toEqual({
    accountId: SESSION_TEST_ACCOUNT,
    principalId: PRINCIPAL,
  });
  const before = f.control.classReads;
  await expect(projection.resolve({ ...c.input, subject: "other" }, c.original)).rejects.toThrow();
  expect(f.control.classReads).toBe(before);
  let inspected = 0;
  const unknownInput = new Proxy(
    {},
    {
      ownKeys() {
        inspected++;
        throw new Error("unverified DATA inspected");
      },
    },
  );
  await expect(
    projection.resolve(unknownInput as never, {} as SharedAuthVerifiedPrincipalInput),
  ).rejects.toThrow();
  expect(inspected).toBe(0);
});

test("Root factory does not evaluate or invoke an external principal getter", async () => {
  const f = await retained();
  const options = await f.options();
  let getters = 0;
  const shared = { ...options.sharedAuth };
  Object.defineProperty(shared, "principals", {
    enumerable: true,
    get() {
      getters++;
      throw new Error("external principal getter");
    },
  });
  const runtime = createWorkerRequestConsumersWithOriginalRpProjection({
    ...options,
    sharedAuth: shared,
  });
  expect((await runtime.sharedAuth.authenticate(f.request()))?.actor.principalId).toBe(PRINCIPAL);
  expect(getters).toBe(0);
});

test("unknown retained query is unavailable without a second attempt or enrollment", async () => {
  const f = await retained();
  const options = await f.options();
  const runtime = createWorkerRequestConsumersWithOriginalRpProjection(options);
  const before = f.counts();
  const priorReads = f.control.classReads;
  f.control.failClassRead = true;
  await expect(runtime.sharedAuth.authenticate(f.request())).rejects.toThrow();
  expect(f.control.classReads - priorReads).toBe(1);
  expect(f.counts()).toEqual(before);
});

test("original RP reader refuses genuine native method substitution before any retained read", async () => {
  for (const key of ["prepare", "batch", "withSession"] as const) {
    const f = await retained();
    await f.runtimeOriginal.sharedAuth.authenticate(f.request());
    const c = f.captured.at(-1);
    const session = f.primarySessions[0];
    if (!c || !session) throw new Error("original capture/session absent");
    const receiver = key === "withSession" ? f.binding : session;
    const original = Object.getOwnPropertyDescriptor(receiver, key);
    if (!original || !("value" in original)) throw new Error("original method absent");
    let substituted = 0;
    Object.defineProperty(receiver, key, {
      ...original,
      value: function (...args: unknown[]) {
        substituted++;
        return Reflect.apply(original.value, receiver, args);
      },
    });
    const reads = f.control.classReads;
    expect(() =>
      readWorkerRequestVerifiedSharedPrincipalInputs(f.optionsOriginal.connection, c.original),
    ).toThrow();
    await expect(
      createWorkerRequestSharedRpOriginalPrincipalProjection(f.optionsOriginal.connection).resolve(
        c.input,
        c.original,
      ),
    ).rejects.toThrow();
    expect(f.control.classReads).toBe(reads);
    expect(substituted).toBe(0);
  }
});

test("retained query rechecks native backing after await without invoking substituted getters", async () => {
  for (const key of ["prepare", "batch", "withSession"] as const) {
    const f = await retained();
    await f.runtimeOriginal.sharedAuth.authenticate(f.request());
    const c = f.captured.at(-1);
    const session = f.primarySessions[0];
    if (!c || !session) throw new Error("original capture/session absent");
    const receiver = key === "withSession" ? f.binding : session;
    let getterCalls = 0;
    f.control.afterClassRead = () => {
      f.control.afterClassRead = null;
      Object.defineProperty(receiver, key, {
        configurable: true,
        get() {
          getterCalls++;
          throw new Error("substituted native getter");
        },
      });
    };
    const before = f.control.classReads;
    await expect(
      createWorkerRequestSharedRpOriginalPrincipalProjection(f.optionsOriginal.connection).resolve(
        c.input,
        c.original,
      ),
    ).rejects.toThrow();
    expect(f.control.classReads - before).toBe(1);
    expect(getterCalls).toBe(0);
  }
});

test("explicit original RP factory refuses native substitution before constructing consumers", async () => {
  const f = await fixture();
  const options = await f.options();
  const session = f.primarySessions[0];
  if (!session) throw new Error("original primary absent");
  let getters = 0;
  Object.defineProperty(session, "prepare", {
    configurable: true,
    get() {
      getters++;
      throw new Error("foreign native method");
    },
  });
  const before = f.queries.length;
  expect(() => createWorkerRequestConsumersWithOriginalRpProjection(options)).toThrow();
  expect(f.queries.length).toBe(before);
  expect(getters).toBe(0);
});

test("native binding assertion accepts only the actual captured platform binding and returns no origin", async () => {
  const f = await fixture();
  const options = await f.options();
  const before = f.queries.length;
  expect(assertWorkerRequestNativeBinding(options.connection, f.binding)).toBeUndefined();
  expect(() => assertWorkerRequestNativeBinding(options.connection, { ...f.binding })).toThrow();
  expect(() =>
    assertWorkerRequestNativeBinding(options.connection, f.primarySessions[0]),
  ).toThrow();
  let getters = 0;
  const fake = new Proxy(
    {},
    {
      get() {
        getters++;
        throw new Error("alleged native binding inspected");
      },
    },
  );
  expect(() => assertWorkerRequestNativeBinding(options.connection, fake)).toThrow();
  expect(getters).toBe(0);
  expect(f.queries.length).toBe(before);
});
