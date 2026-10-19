import { afterEach, expect, test } from "bun:test";
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import { additiveAuthDDL } from "../src/auth-authority-schema-plan.ts";
import { createAuth103SourceClock } from "../src/auth103-source-clock.ts";
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
  captureWorkerRequestRetainedRpSession,
  captureWorkerSharedAuthStaging,
  createWorkerRequestConsumers,
  createWorkerRequestSql,
  initializeWorkerRequestNativeInputs,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  readWorkerRequestNativeInitializationInputs,
  type WorkerRequestDatabase,
  type WorkerSharedAuthStaging,
} from "../src/worker-request-composition.ts";
import {
  captureWorkerRequestAuthenticatedRpUserBindingOriginal,
  createWorkerRequestFinancialAuthOriginalReaders,
  readWorkerRequestAuthenticatedRpUserBindingOriginal,
  WorkerRequestFinancialAuthOriginalUnavailable,
} from "../src/worker-request-financial-auth-original.ts";
import {
  captureWorkerRequestResolvedRpUserBindingOriginal,
  createWorkerRequestConsumersWithOriginalRpProjection,
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
    failBindingRead: false,
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
                control.failBindingRead &&
                original.sql.startsWith("SELECT") &&
                original.sql.includes("FROM shared_principal_bindings")
              )
                throw new Error("unknown retained binding read");
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
    organizations: {
      async pin(input) {
        return input;
      },
    },
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

async function observed() {
  const f = await retained();
  const credential = await captureWorkerRequestRetainedRpSession(
    f.optionsOriginal.connection,
    f.request(),
    SESSION_TEST_ORGANIZATION.id,
  );
  const verified = f.captured.at(-1)?.original;
  if (!credential || !verified) throw new Error("actual original observations absent");
  return { ...f, credential, verified };
}

test("distinct actual RP originals connect to retained binding DATA without qualified-port claims", async () => {
  const f = await observed();
  const readers = createWorkerRequestFinancialAuthOriginalReaders(f.optionsOriginal.connection);
  const credential = readers.readCredentialOriginalData(f.credential);
  const binding = await readers.readRpVerifiedPrincipalBindingOriginalData(
    f.verified,
    f.credential,
  );
  expect(credential?.backend).toBe("shared-rp-session");
  expect(credential?.record.origin.principalId).toBe(PRINCIPAL);
  expect(binding?.binding.ref).toBe(f.principalBinding.ref);
  expect(binding?.anchor.incarnation).toBe(f.principalBinding.principalIncarnation);
  expect(Object.isFrozen(binding)).toBe(true);
  expect(Object.hasOwn(readers, "readValidatedCredential")).toBe(false);
  expect(Object.hasOwn(readers, "readValidatedPrincipalBinding")).toBe(false);
});

test("credential capture and matching DTO are not a separate original RP observation", async () => {
  const f = await observed();
  const readers = createWorkerRequestFinancialAuthOriginalReaders(f.optionsOriginal.connection);
  expect(
    await readers.readRpVerifiedPrincipalBindingOriginalData(f.credential, f.credential),
  ).toBeNull();
  expect(
    await readers.readRpVerifiedPrincipalBindingOriginalData({ ...f.verified }, f.credential),
  ).toBeNull();
  expect(
    await readers.readRpVerifiedPrincipalBindingOriginalData(f.verified, {
      ...f.credential,
    }),
  ).toBeNull();
  expect(
    readers.readCredentialOriginalData({
      backend: "auth-token",
      record: credentialDto,
    }),
  ).toBeNull();
});
const credentialDto = Object.freeze({
  class: "official-shared-broker",
  principalId: PRINCIPAL,
});

test("unrecognized inputs are not inspected and never promote a key or Actor to human", async () => {
  const f = await observed();
  const readers = createWorkerRequestFinancialAuthOriginalReaders(f.optionsOriginal.connection);
  let calls = 0;
  const alleged = new Proxy(
    {},
    {
      ownKeys() {
        calls++;
        throw new Error("DTO inspection");
      },
      get() {
        calls++;
        throw new Error("DTO getter");
      },
    },
  );
  expect(readers.readCredentialOriginalData(alleged)).toBeNull();
  expect(
    await readers.readRpVerifiedPrincipalBindingOriginalData(alleged, f.credential),
  ).toBeNull();
  expect(await readers.readRpVerifiedPrincipalBindingOriginalData(f.verified, alleged)).toBeNull();
  expect(calls).toBe(0);
});

test("fresh callback capture cannot be combined with a later credential as a human issuance", async () => {
  const f = await observed();
  const fresh = f.captured[0]?.original;
  if (!fresh) throw new Error("actual callback original absent");
  const readers = createWorkerRequestFinancialAuthOriginalReaders(f.optionsOriginal.connection);
  expect(await readers.readRpVerifiedPrincipalBindingOriginalData(fresh, f.credential)).toBeNull();
});

test("same-shaped different native graph and foreign real observations failclosed", async () => {
  const f = await observed();
  expect(() =>
    createWorkerRequestFinancialAuthOriginalReaders({
      ...f.optionsOriginal.connection,
    }),
  ).toThrow(WorkerRequestFinancialAuthOriginalUnavailable);
  const other = await observed();
  const readers = createWorkerRequestFinancialAuthOriginalReaders(f.optionsOriginal.connection);
  expect(readers.readCredentialOriginalData(other.credential)).toBeNull();
  expect(
    await readers.readRpVerifiedPrincipalBindingOriginalData(other.verified, f.credential),
  ).toBeNull();
  expect(
    await readers.readRpVerifiedPrincipalBindingOriginalData(f.verified, other.credential),
  ).toBeNull();
});

test("credential enrollment version and stored Workspace are preserved separately from final touch", async () => {
  const f = await observed();
  const readers = createWorkerRequestFinancialAuthOriginalReaders(f.optionsOriginal.connection);
  const data = readers.readCredentialOriginalData(f.credential);
  if (data?.backend !== "shared-rp-session") throw new Error("actual credential data absent");
  expect(data.record.rp.enrolledSessionVersion).toBe(f.session.version);
  expect(data.current.version).toBeGreaterThan(data.record.rp.enrolledSessionVersion);
  expect(data.record.rp.workspaceId).toBe(f.session.workspaceId);
  expect(
    (await readers.readRpVerifiedPrincipalBindingOriginalData(f.verified, f.credential))?.binding
      .ref,
  ).toBe(f.principalBinding.ref);
});

test("unknown retained query is unavailable rather than absence or retry", async () => {
  const f = await observed();
  const readers = createWorkerRequestFinancialAuthOriginalReaders(f.optionsOriginal.connection);
  const before = f.queries.length;
  f.control.failBindingRead = true;
  await expect(
    readers.readRpVerifiedPrincipalBindingOriginalData(f.verified, f.credential),
  ).rejects.toBeInstanceOf(WorkerRequestFinancialAuthOriginalUnavailable);
  expect(f.queries.length - before).toBe(1);
});

test("native method replacement is rejected without evaluating substituted accessor", async () => {
  const f = await observed();
  const readers = createWorkerRequestFinancialAuthOriginalReaders(f.optionsOriginal.connection);
  const native = f.primarySessions[0];
  if (!native) throw new Error("original native session absent");
  let calls = 0;
  Object.defineProperty(native, "prepare", {
    configurable: true,
    get() {
      calls++;
      throw new Error("substituted native accessor");
    },
  });
  expect(() => readers.readCredentialOriginalData(f.credential)).toThrow(
    WorkerRequestFinancialAuthOriginalUnavailable,
  );
  await expect(
    readers.readRpVerifiedPrincipalBindingOriginalData(f.verified, f.credential),
  ).rejects.toBeInstanceOf(WorkerRequestFinancialAuthOriginalUnavailable);
  expect(calls).toBe(0);
});

test("Root user-binding capture comes from separate actual RP original and exposes the same source Clock", async () => {
  const f = await observed();
  const original = await captureWorkerRequestAuthenticatedRpUserBindingOriginal(
    f.optionsOriginal.connection,
    f.verified,
    f.credential,
  );
  if (!original) throw new Error("actual original user binding absent");
  const read = readWorkerRequestAuthenticatedRpUserBindingOriginal(
    f.optionsOriginal.connection,
    original,
  );
  expect(read?.binding.ref).toBe(f.principalBinding.ref);
  expect(read?.anchor.identityKind).toBe("google");
  expect(read?.anchor.identitySubject).toBe(SESSION_TEST_ACCOUNT);
  expect(read?.inputs.clock).toBe(f.optionsOriginal.clock);
  expect(read?.inputs.sql).toBe(f.optionsOriginal.sql);
  expect(read?.inputs.realm).toBe(f.optionsOriginal.realm);
  expect(read?.registrationOriginal.ref).toBe("synthetic-retained-registration");
  expect(Object.isFrozen(original)).toBe(true);
});

test("separate user-binding reader rejects raw credentials, copies and foreign actual request graphs", async () => {
  const f = await observed();
  const original = await captureWorkerRequestAuthenticatedRpUserBindingOriginal(
    f.optionsOriginal.connection,
    f.verified,
    f.credential,
  );
  if (!original) throw new Error("original absent");
  const other = await observed();
  expect(
    readWorkerRequestAuthenticatedRpUserBindingOriginal(f.optionsOriginal.connection, f.credential),
  ).toBeNull();
  expect(
    readWorkerRequestAuthenticatedRpUserBindingOriginal(f.optionsOriginal.connection, {
      ...original,
    }),
  ).toBeNull();
  expect(
    readWorkerRequestAuthenticatedRpUserBindingOriginal(other.optionsOriginal.connection, original),
  ).toBeNull();
  expect(
    readWorkerRequestAuthenticatedRpUserBindingOriginal(
      f.optionsOriginal.connection,
      credentialDto,
    ),
  ).toBeNull();
});

test("a user-binding capture cannot be minted from matching binding or verification DATA", async () => {
  const f = await observed();
  expect(
    await captureWorkerRequestAuthenticatedRpUserBindingOriginal(
      f.optionsOriginal.connection,
      { ...f.verified },
      f.credential,
    ),
  ).toBeNull();
  expect(
    await captureWorkerRequestAuthenticatedRpUserBindingOriginal(
      f.optionsOriginal.connection,
      f.verified,
      { anchor: { principalId: PRINCIPAL }, binding: f.principalBinding },
    ),
  ).toBeNull();
  expect(
    await captureWorkerRequestAuthenticatedRpUserBindingOriginal(
      f.optionsOriginal.connection,
      f.credential,
      f.credential,
    ),
  ).toBeNull();
});

test("user-binding reader rechecks original native backing and never evaluates substituted getter", async () => {
  const f = await observed();
  const original = await captureWorkerRequestAuthenticatedRpUserBindingOriginal(
    f.optionsOriginal.connection,
    f.verified,
    f.credential,
  );
  const native = f.primarySessions[0];
  if (!original || !native) throw new Error("original native capture absent");
  let getters = 0;
  Object.defineProperty(native, "batch", {
    configurable: true,
    get() {
      getters++;
      throw new Error("replacement native batch");
    },
  });
  expect(() =>
    readWorkerRequestAuthenticatedRpUserBindingOriginal(f.optionsOriginal.connection, original),
  ).toThrow(WorkerRequestFinancialAuthOriginalUnavailable);
  expect(getters).toBe(0);
});

test("retired binding cannot mint a new user original while old original custody remains historical", async () => {
  const f = await observed();
  const original = await captureWorkerRequestAuthenticatedRpUserBindingOriginal(
    f.optionsOriginal.connection,
    f.verified,
    f.credential,
  );
  if (!original) throw new Error("original absent");
  await createSharedPrincipalAuthorityStore({
    sql: f.optionsOriginal.sql,
  }).retireBinding(f.principalBinding.ref, f.principalBinding.evidence, {
    reason: "synthetic-retirement",
    at: new Date(f.stamp).toISOString(),
    ref: "synthetic-terminal",
  });
  expect(
    await captureWorkerRequestAuthenticatedRpUserBindingOriginal(
      f.optionsOriginal.connection,
      f.verified,
      f.credential,
    ),
  ).toBeNull();
  expect(
    readWorkerRequestAuthenticatedRpUserBindingOriginal(f.optionsOriginal.connection, original)
      ?.binding.state,
  ).toBe("active");
});

test("actual Root projection retains the verified original for its final-touch user capture", async () => {
  const f = await retained();
  const options = await f.options();
  const legacyBefore = f.control.legacyResolve;
  createWorkerRequestConsumersWithOriginalRpProjection(options);
  expect(
    await captureWorkerRequestResolvedRpUserBindingOriginal(options.connection, {}),
  ).toBeNull();
  const countsBefore = f.counts();
  const credential = await captureWorkerRequestRetainedRpSession(
    options.connection,
    f.request(),
    SESSION_TEST_ORGANIZATION.id,
  );
  if (!credential) throw new Error("actual Root final-touch capture absent");
  const user = await captureWorkerRequestResolvedRpUserBindingOriginal(
    options.connection,
    credential,
  );
  if (!user) throw new Error("actual Root resolved user capture absent");
  const selected = readWorkerRequestAuthenticatedRpUserBindingOriginal(options.connection, user);
  expect(selected?.binding.ref).toBe(f.principalBinding.ref);
  expect(selected?.anchor.identitySubject).toBe(SESSION_TEST_ACCOUNT);
  expect(selected?.inputs.sql).toBe(options.sql);
  expect(selected?.inputs.clock).toBe(options.clock);
  expect(selected?.registrationOriginal.ref).toBe("synthetic-retained-registration");
  expect(user).not.toBe(credential);
  expect(f.control.legacyResolve).toBe(legacyBefore);
  expect(f.counts()).toEqual(countsBefore);
});

test("ordinary external RP projection does not install a Root resolved-user original", async () => {
  const f = await observed();
  const before = f.queries.length;
  expect(
    await captureWorkerRequestResolvedRpUserBindingOriginal(
      f.optionsOriginal.connection,
      f.credential,
    ),
  ).toBeNull();
  expect(f.queries.length).toBe(before);
});

test("Root resolved callsite cannot combine its real original with copied or foreign credentials", async () => {
  const f = await retained();
  const options = await f.options();
  createWorkerRequestConsumersWithOriginalRpProjection(options);
  const credential = await captureWorkerRequestRetainedRpSession(
    options.connection,
    f.request(),
    SESSION_TEST_ORGANIZATION.id,
  );
  if (!credential) throw new Error("actual Root final-touch capture absent");
  const other = await observed();
  expect(
    await captureWorkerRequestResolvedRpUserBindingOriginal(options.connection, {
      ...credential,
    }),
  ).toBeNull();
  expect(
    await captureWorkerRequestResolvedRpUserBindingOriginal(options.connection, other.credential),
  ).toBeNull();
  expect(
    await captureWorkerRequestResolvedRpUserBindingOriginal(options.connection, credential),
  ).not.toBeNull();
});

test("native initialization captures real inputs before one graph and preserves the same object after it", async () => {
  const f = await retained();
  const options = { ...(await f.options()), clock: createAuth103SourceClock() };
  initializeWorkerRequestNativeInputs(options);
  const original = readWorkerRequestNativeInitializationInputs(options.connection);
  expect(original.sql).toBe(options.sql);
  expect(original.client).toBe(options.client);
  expect(original.realm).toBe(options.realm);
  expect(original.clock).toBe(options.clock);
  expect(original.writerEpoch).toBe(WRITER);
  expect(() => readWorkerRequestConsumers(options.connection)).toThrow();
  const consumers = createWorkerRequestConsumers(options);
  expect(readWorkerRequestConsumers(options.connection)).toBe(consumers);
  expect(readWorkerRequestFinancialInputs(options.connection)).toBe(original);
  expect(readWorkerRequestNativeInitializationInputs(options.connection)).toBe(original);
  expect(() => createWorkerRequestConsumers(options)).toThrow();
  expect(() => initializeWorkerRequestNativeInputs(options)).toThrow();
});

test("a caller Clock or copied connection cannot become original native initialization", async () => {
  const f = await retained();
  const options = await f.options();
  expect(() => initializeWorkerRequestNativeInputs(options)).toThrow();
  expect(() =>
    initializeWorkerRequestNativeInputs({
      ...options,
      clock: createAuth103SourceClock(),
      connection: { ...options.connection },
    }),
  ).toThrow();
  expect(() => readWorkerRequestNativeInitializationInputs(options.connection)).toThrow();
});

test("native initialization rejects input accessors without evaluating them", async () => {
  const f = await retained();
  const options = { ...(await f.options()), clock: createAuth103SourceClock() };
  let getters = 0;
  Object.defineProperty(options, "realm", {
    get() {
      getters++;
      throw new Error("substituted realm");
    },
  });
  expect(() => initializeWorkerRequestNativeInputs(options)).toThrow();
  expect(getters).toBe(0);
});

test("native initialization refuses primary method replacement without invoking its accessor", async () => {
  const f = await retained();
  const options = { ...(await f.options()), clock: createAuth103SourceClock() };
  initializeWorkerRequestNativeInputs(options);
  const native = f.primarySessions.at(-1);
  if (!native) throw new Error("actual primary missing");
  let getters = 0;
  Object.defineProperty(native, "prepare", {
    configurable: true,
    get() {
      getters++;
      throw new Error("substituted primary");
    },
  });
  expect(() => readWorkerRequestNativeInitializationInputs(options.connection)).toThrow();
  expect(() => createWorkerRequestConsumers(options)).toThrow();
  expect(getters).toBe(0);
});

test("one native initialization cannot be consumed with another original Clock selection", async () => {
  const f = await retained();
  const options = { ...(await f.options()), clock: createAuth103SourceClock() };
  initializeWorkerRequestNativeInputs(options);
  const before = f.queries.length;
  expect(() =>
    createWorkerRequestConsumers({
      ...options,
      clock: createAuth103SourceClock(),
    }),
  ).toThrow();
  expect(f.queries.length).toBe(before);
  createWorkerRequestConsumers(options);
  expect(readWorkerRequestFinancialInputs(options.connection).clock).toBe(options.clock);
});
