import { Database } from "bun:sqlite";
import { expect, mock, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  compileAuth103NativeSourceCatalog,
  createAuth103CanonicalSourceArtifacts,
  prepareAuth103NativeBuildSource,
  readAuth103NativeBuildDefine,
  readAuth103NativeBuildProfileDefine,
} from "../scripts/deploy/auth103-native-source.ts";
import { DeployError } from "../scripts/deploy/errors.ts";
import { moneyFenceInstallSql } from "../scripts/deploy/schema-money-unit-cutover.ts";
import type { DeployTarget } from "../scripts/deploy/target.ts";
import { prepareWorkerArtifact } from "../scripts/deploy/worker-artifact.ts";
import { additiveAuthFull103DDL } from "../src/auth-authority-schema-plan.ts";
import {
  auth103NativeSourceCodeSelected,
  captureAuth103NativeRpTransportInputs,
  qualifyAuth103NativeRequestOrigin,
  readAuth103NativeRequestOrigin,
} from "../src/auth103-native-origin-source.ts";
import {
  AUTH103_NATIVE_CATALOG_QUERY,
  AUTH103_NATIVE_CURRENT_PREDICATE,
  AUTH103_NATIVE_CURRENT_REGISTRATION_QUERY,
  AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE,
  AUTH103_NATIVE_MIGRATIONS,
  AUTH103_NATIVE_PROJECTED_CATALOG_QUERY,
  AUTH103_NATIVE_REGISTRATION_DDL,
  AUTH103_NATIVE_REGISTRATION_QUERY,
  auth103NativeCurrentnessSql,
  auth103RpRegistrationRecord,
} from "../src/auth103-native-source-contract.ts";
import { createAuth103SourceClock } from "../src/auth103-source-clock.ts";
import { MIGRATIONS } from "../src/db-schema.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { canonicalDigest, canonicalJson } from "../src/json.ts";
import {
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
} from "../src/money-cutover-sql.ts";
import { type Row, SqlError, type SqlParam } from "../src/ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import { frameHostMigrationSql } from "../src/sqlite-migration-policy.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  captureWorkerSharedAuthStaging,
  createWorkerOrdinaryPrimaryRequestSql,
  initializeWorkerRequestNativeInputs,
  readWorkerRequestNativeInitializationInputs,
} from "../src/worker-request-composition.ts";
import {
  createHostedBillingRealmTestDatabase,
  seedHostedBillingRealmTestPin,
} from "./helpers/hosted-billing-realm-fixture.ts";

// Local source-assembly/negative tests only. A local build original is not a
// native request, installed103, physical target or Financial permission.
const root = resolve(import.meta.dir, "..");
const hash = (value: string): `sha256:${string}` =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;
const fresh9dOrigin =
  "https://integration-root-ga-9d9c84f4281649c884e0579d93e5c926.shoutatomiyama0614.workers.dev";
const old8732Origin =
  "https://integration-money-8732b77a789fd563406269261bf09e71.shoutatomiyama0614.workers.dev";
const target = {
  kind: "takoserver.deploy-target@v2",
  environment: "integration",
  accountId: "a".repeat(32),
  workerName: "auth103-source-component",
  d1: {
    databaseName: "auth103-source-component",
    databaseId: "00000000-0000-4000-8000-000000000000",
  },
  r2: { bucketName: "auth103-source-component" },
  publicOrigin: "https://auth103-source-component.example.test",
  signing: { currentKeyId: "component-key" },
} satisfies DeployTarget;

test("registered source assembly retains the original full103 recipe and fixed predecessor order", () => {
  const actual = createAuth103CanonicalSourceArtifacts(root);
  expect(actual.files.map(({ name }) => name)).toEqual([...AUTH103_NATIVE_MIGRATIONS]);
  expect(actual.files[2]?.sql.startsWith(additiveAuthFull103DDL)).toBe(true);
  expect(actual.recipeDigest).toBe(hash(additiveAuthFull103DDL));
  expect(actual.files[2]?.sql.indexOf(AUTH103_NATIVE_REGISTRATION_DDL)).toBeGreaterThan(
    additiveAuthFull103DDL.length,
  );
  expect(actual.registrationRef).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(actual.clockPolicyRef).not.toBe(actual.registrationRef);
  expect(actual.clockSourceDigest).not.toBe(actual.recipeDigest);
  expect(createAuth103CanonicalSourceArtifacts(root).files.map(({ sql }) => hash(sql))).toEqual(
    actual.files.map(({ sql }) => hash(sql)),
  );
});

test("native source currentness keeps Money bytes and ten binds while ordinary excludes physical guards", () => {
  const money = auth103NativeCurrentnessSql("money-preserved");
  expect(money).toBe(
    `(${AUTH103_NATIVE_CURRENT_PREDICATE}) AND (${AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE})`,
  );
  const ordinary = auth103NativeCurrentnessSql("ordinary");
  expect(ordinary).toContain(`(${AUTH103_NATIVE_CURRENT_PREDICATE} AND (NOT EXISTS (`);
  expect(ordinary).toContain("FROM main.sqlite_schema WHERE name IN (");
  expect([...ordinary.matchAll(/\?/gu)]).toHaveLength(10);
  expect([...money.matchAll(/\?/gu)]).toHaveLength(10);
  expect(() => auth103NativeCurrentnessSql("unknown" as never)).toThrow(
    "Auth103 native currentness source profile is invalid",
  );
});

test("compiled registered source has complete fixed objects while unrelated later objects stay outside its identity", () => {
  const actual = createAuth103CanonicalSourceArtifacts(root);
  const sources = [
    ...MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100).map(({ sql }) => sql),
    ...actual.files.map(({ sql }) => sql),
  ];
  const digest = compileAuth103NativeSourceCatalog(sources);
  expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
  expect(
    compileAuth103NativeSourceCatalog([
      ...sources,
      "CREATE TABLE source_component_unrelated_later_leaf (id TEXT PRIMARY KEY NOT NULL)",
    ]),
  ).toBe(digest);
});

test("source compiler stops on a non-final constraint and never returns a catalog from a skipped guard", () => {
  const actual = createAuth103CanonicalSourceArtifacts(root);
  const sources = [
    ...MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) <= 100).map(({ sql }) => sql),
    ...actual.files.map(({ sql }) => sql),
  ];
  // Establish complete positive objects first. The deliberate failure is not
  // an early missing-table error and the trailing valid statement cannot hide it.
  expect(compileAuth103NativeSourceCatalog(sources)).toMatch(/^sha256:[0-9a-f]{64}$/u);
  let failure: unknown;
  try {
    compileAuth103NativeSourceCatalog([
      ...sources,
      "CREATE TABLE source_component_stop (value TEXT NOT NULL); " +
        "INSERT INTO source_component_stop VALUES (NULL); SELECT 1;",
    ]);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(DeployError);
  if (!(failure instanceof DeployError)) throw new Error("missing finite source compiler failure");
  expect(failure.phase).toBe("preflight");
  expect(failure.message).toBe("Auth103 source catalog compilation failed");
});

test("registration is a single immutable original, including duplicate identical rows", () => {
  const actual = createAuth103CanonicalSourceArtifacts(root);
  const schemaFile = actual.files[2];
  if (schemaFile === undefined) throw new Error("fixed source artifact missing");
  const database = new Database(":memory:", { strict: true });
  try {
    const suffix = schemaFile.sql.slice(additiveAuthFull103DDL.length);
    for (const statement of frameHostMigrationSql(suffix)) database.query(statement).all();
    const before = database.query(AUTH103_NATIVE_REGISTRATION_QUERY).all();
    expect(before).toHaveLength(1);
    expect(before[0]).toEqual({
      registration_ref: actual.registrationRef,
      recipe_digest: actual.recipeDigest,
      clock_source_digest: actual.clockSourceDigest,
      clock_policy_ref: actual.clockPolicyRef,
    });
    const catalog = database
      .query<
        {
          type: string;
          name: string;
          tbl_name: string;
          sql: string | null;
        },
        []
      >(AUTH103_NATIVE_CATALOG_QUERY)
      .all();
    const catalogJson = JSON.stringify(catalog);
    expect(database.query(AUTH103_NATIVE_CURRENT_REGISTRATION_QUERY).all(catalogJson)).toEqual(
      before,
    );
    for (const statement of [
      "INSERT INTO auth103_native_source_registration SELECT * FROM auth103_native_source_registration",
      "UPDATE auth103_native_source_registration SET recipe_digest=recipe_digest",
      "DELETE FROM auth103_native_source_registration",
    ]) {
      let rejected = false;
      try {
        database.query(statement).all();
      } catch {
        rejected = true;
      }
      expect(rejected).toBe(true);
      expect(database.query(AUTH103_NATIVE_REGISTRATION_QUERY).all()).toEqual(before);
    }
    const projectionJson = JSON.stringify(catalog.map((row) => [row.type, row.name, row.tbl_name]));
    const current = () =>
      database
        .query(`SELECT CASE WHEN ${AUTH103_NATIVE_CURRENT_PREDICATE}
      THEN 1 ELSE 0 END AS current`)
        .get(
          actual.registrationRef,
          actual.recipeDigest,
          actual.clockSourceDigest,
          actual.clockPolicyRef,
          catalogJson,
        );
    expect(database.query(AUTH103_NATIVE_PROJECTED_CATALOG_QUERY).all(projectionJson)).toEqual(
      catalog,
    );
    expect(current()).toEqual({ current: 1 });
    // Unrelated later tables and their own indexes remain additive. A hook or
    // index on an Auth103-owned table is not an unrelated extension; it needs
    // a separately reviewed source enrollment rather than blanket admission.
    database.query("CREATE TABLE source_component_later_leaf (id TEXT PRIMARY KEY NOT NULL)").all();
    database
      .query("CREATE INDEX source_component_later_index ON source_component_later_leaf(id)")
      .all();
    expect(database.query(AUTH103_NATIVE_CURRENT_REGISTRATION_QUERY).all(catalogJson)).toEqual(
      before,
    );
    expect(database.query(AUTH103_NATIVE_PROJECTED_CATALOG_QUERY).all(projectionJson)).toEqual(
      catalog,
    );
    expect(current()).toEqual({ current: 1 });
    for (const extra of [
      {
        create:
          "CREATE TRIGGER source_component_later_hook AFTER INSERT ON auth103_native_source_registration BEGIN SELECT 1; END",
        drop: "DROP TRIGGER source_component_later_hook",
      },
      {
        create:
          "CREATE INDEX source_component_auth_extra_index ON auth103_native_source_registration(recipe_digest)",
        drop: "DROP INDEX source_component_auth_extra_index",
      },
    ]) {
      database.query(extra.create).all();
      expect(
        database.query(AUTH103_NATIVE_PROJECTED_CATALOG_QUERY).all(projectionJson),
      ).not.toEqual(catalog);
      expect(
        database.query(AUTH103_NATIVE_CURRENT_REGISTRATION_QUERY).all(catalogJson),
      ).toHaveLength(0);
      expect(current()).toEqual({ current: 0 });
      database.query(extra.drop).all();
      expect(database.query(AUTH103_NATIVE_PROJECTED_CATALOG_QUERY).all(projectionJson)).toEqual(
        catalog,
      );
      expect(database.query(AUTH103_NATIVE_CURRENT_REGISTRATION_QUERY).all(catalogJson)).toEqual(
        before,
      );
      expect(current()).toEqual({ current: 1 });
    }
    database.query("DROP TRIGGER auth103_native_source_registration_no_update").all();
    expect(database.query(AUTH103_NATIVE_CURRENT_REGISTRATION_QUERY).all(catalogJson)).toHaveLength(
      0,
    );
    const restore = frameHostMigrationSql(AUTH103_NATIVE_REGISTRATION_DDL).find((sql) =>
      sql.includes("CREATE TRIGGER auth103_native_source_registration_no_update"),
    );
    if (restore === undefined) throw new Error("fixed registration guard source missing");
    database.query(restore).all();
    expect(database.query(AUTH103_NATIVE_CURRENT_REGISTRATION_QUERY).all(catalogJson)).toEqual(
      before,
    );
  } finally {
    database.close();
  }
});

test("an ordinary unregistered build defines null and a copied handle cannot select a manifest", () => {
  const directory = mkdtempSync(resolve(tmpdir(), "auth103-native-source-"));
  try {
    mkdirSync(resolve(directory, "migrations"));
    const original = prepareAuth103NativeBuildSource({
      sourceRoot: directory,
      commit: "a".repeat(40),
      target,
    });
    expect(readAuth103NativeBuildDefine(original, target, "a".repeat(40), directory)).toBe("null");
    expect(readAuth103NativeBuildProfileDefine(original, target, "a".repeat(40), directory)).toBe(
      "null",
    );
    expect(() =>
      readAuth103NativeBuildDefine({ ...original }, target, "a".repeat(40), directory),
    ).toThrow("Auth103 build origin does not match the owning config");
    expect(() =>
      readAuth103NativeBuildDefine(original, { ...target }, "a".repeat(40), directory),
    ).toThrow("Auth103 build origin does not match the owning config");
    expect(() => readAuth103NativeBuildDefine(original, target, "b".repeat(40), directory)).toThrow(
      "Auth103 build origin does not match the owning config",
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a mandatory deployment receipt requires the exact separate RP original and rolls back a partial install", () => {
  // Synthetic DATA for fixed SQL mechanics only. No native origin/factory is
  // constructed or mocked, and none of these rows can qualify this Bun process.
  const actual = createAuth103CanonicalSourceArtifacts(root);
  const authSchemaFile = actual.files[2];
  if (authSchemaFile === undefined) throw new Error("fixed source artifact missing");
  const database = new Database(":memory:", { strict: true });
  try {
    database.query("PRAGMA foreign_keys = ON").all();
    for (const statement of frameHostMigrationSql(
      authSchemaFile.sql.slice(additiveAuthFull103DDL.length),
    ))
      database.query(statement).all();
    const rpRef = hash("component RP original"),
      rpDigest = hash("component RP digest");
    const rpReceipt = hash("component RP receipt"),
      targetRef = hash("component target");
    const sourceRef = hash("component source"),
      artifactDigest = hash("component artifact");
    const rpJson = canonicalJson({
      registrationRef: rpRef,
      registrationDigest: rpDigest,
      receiptRef: rpReceipt,
      profile: SHARED_AUTH_STAGING_PROFILE,
      issuerSourceRef: hash("component issuer"),
      configDigest: hash(canonicalJson(SHARED_AUTH_STAGING_PROFILE)),
      targetRef,
      authSchemaRef: hash(authSchemaFile.sql),
      clockPolicyRef: actual.clockPolicyRef,
    });
    const snapshot = () =>
      hash(
        canonicalJson({
          schema: database
            .query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")
            .all(),
          sourceRegistration: database.query(AUTH103_NATIVE_REGISTRATION_QUERY).all(),
          rp: database
            .query("SELECT * FROM auth103_native_rp_registrations ORDER BY registration_ref")
            .all(),
          rpReceipts: database
            .query("SELECT * FROM auth103_native_rp_registration_receipts ORDER BY receipt_ref")
            .all(),
          deployments: database
            .query("SELECT * FROM auth103_native_deployments ORDER BY deployment_ref")
            .all(),
          receipts: database
            .query("SELECT * FROM auth103_native_deployment_receipts ORDER BY receipt_ref")
            .all(),
        }),
      );
    const insert = (suffix: string, completeRp: boolean) => {
      const deploymentRef = hash(`component deployment ${suffix}`),
        receiptRef = hash(`component receipt ${suffix}`);
      const recordJson = canonicalJson({
        receiptRef,
        artifactDigest,
        rpRecordJson: rpJson,
        manifest: {
          targetRef,
          sourceRef,
          rpRegistration: { registrationRef: rpRef, registrationDigest: rpDigest },
        },
      });
      expect(
        database
          .query("INSERT INTO auth103_native_rp_registrations VALUES (?,?,?) RETURNING *")
          .all(rpRef, rpDigest, rpJson),
      ).toHaveLength(1);
      if (completeRp)
        expect(
          database
            .query("INSERT INTO auth103_native_rp_registration_receipts VALUES (?,?,?) RETURNING *")
            .all(rpReceipt, rpRef, rpJson),
        ).toHaveLength(1);
      expect(
        database
          .query("INSERT INTO auth103_native_deployments VALUES (?,?,?,?,?) RETURNING *")
          .all(deploymentRef, targetRef, sourceRef, artifactDigest, recordJson),
      ).toHaveLength(1);
      return { deploymentRef, recordJson, receiptRef };
    };
    const before = snapshot();
    database.query("BEGIN IMMEDIATE").all();
    const partial = insert("partial", false);
    let failure: unknown;
    try {
      database
        .query("INSERT INTO auth103_native_deployment_receipts VALUES (?,?,?) RETURNING *")
        .all(partial.receiptRef, partial.deploymentRef, partial.recordJson);
    } catch (error) {
      failure = error;
    }
    database.query("ROLLBACK").all();
    expect(failure).toBeInstanceOf(Error);
    if (!(failure instanceof Error)) throw new Error("missing mandatory receipt failure");
    expect(failure.message.includes("Auth103 deployment receipt mismatch")).toBe(true);
    expect(snapshot()).toBe(before);
    database.query("BEGIN IMMEDIATE").all();
    const complete = insert("complete", true);
    expect(
      database
        .query("INSERT INTO auth103_native_deployment_receipts VALUES (?,?,?) RETURNING *")
        .all(complete.receiptRef, complete.deploymentRef, complete.recordJson),
    ).toHaveLength(1);
    database.query("COMMIT").all();
    const catalogJson = JSON.stringify(database.query(AUTH103_NATIVE_CATALOG_QUERY).all());
    const guarded = database
      .query(`SELECT CASE WHEN (${AUTH103_NATIVE_CURRENT_PREDICATE})
      AND (${AUTH103_NATIVE_INSTALL_CURRENT_PREDICATE}) THEN 1 ELSE 0 END AS current`)
      .get(
        actual.registrationRef,
        actual.recipeDigest,
        actual.clockSourceDigest,
        actual.clockPolicyRef,
        catalogJson,
        complete.deploymentRef,
        complete.recordJson,
        rpRef,
        rpDigest,
        rpJson,
      );
    expect(guarded).toEqual({ current: 1 });
  } finally {
    database.close();
  }
});

test("unregistered portable code refuses before inspecting a counterfeit request or invoking its getter", async () => {
  expect(auth103NativeSourceCodeSelected()).toBe(false);
  let calls = 0;
  const forged = Object.freeze({
    get sql(): never {
      calls++;
      throw new Error("must not inspect");
    },
    get moneyGuard(): never {
      calls++;
      throw new Error("must not inspect");
    },
  });
  let failure: unknown;
  try {
    await qualifyAuth103NativeRequestOrigin(forged);
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(SqlError);
  if (!(failure instanceof SqlError)) throw new Error("missing source refusal");
  expect(failure.code).toBe("unavailable");
  expect(calls).toBe(0);
  expect(readAuth103NativeRequestOrigin({}, forged)).toBeNull();
  expect(readAuth103NativeRequestOrigin(null, forged)).toBeNull();
  expect(calls).toBe(0);
});

test("artifact construction refuses alternating run and config accessors without invoking them", async () => {
  for (const key of ["run", "writeConfig"] as const) {
    let getters = 0;
    const supplied = {
      root: "/not-read-auth103-output",
      target,
      commit: "a".repeat(40),
      run: async () => ({ exitCode: 0, stdout: "", stderr: "" }),
    };
    Object.defineProperty(supplied, key, {
      enumerable: true,
      get() {
        getters++;
        throw new Error("must not inspect a build callable getter");
      },
    });
    let failure: unknown;
    try {
      await prepareWorkerArtifact(supplied);
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeployError);
    if (!(failure instanceof DeployError)) throw new Error("missing finite build input refusal");
    expect(failure.message).toBe("Worker artifact options require own data properties");
    expect(getters).toBe(0);
  }
});

test("an ordinary registered installation qualifies its exact first-primary and real Financial realm graph", async () => {
  const database = await createHostedBillingRealmTestDatabase();
  try {
    await seedHostedBillingRealmTestPin(database.sql, {
      accountId: "acct_auth103ordinary",
      billingAuthority: "auth103-ordinary-component",
    });
    for (const migration of MIGRATIONS.filter(({ name }) => Number(name.slice(0, 4)) >= 100))
      for (const statement of frameHostMigrationSql(migration.sql))
        database.db.query(statement).all();
    const canonical = createAuth103CanonicalSourceArtifacts(root);
    for (const file of canonical.files)
      for (const statement of frameHostMigrationSql(file.sql)) database.db.query(statement).all();

    const catalog = database.db.query(AUTH103_NATIVE_CATALOG_QUERY).all() as {
      type: string;
      name: string;
      tbl_name: string;
      sql: string | null;
    }[];
    const sourceCommit = "c".repeat(40);
    const targetRef = hash("ordinary installed target");
    const sourceRef = hash("ordinary installed source");
    const artifactDigest = hash("ordinary installed local artifact");
    const authSchemaFile = canonical.files[2];
    if (authSchemaFile === undefined) throw new Error("fixed source artifact missing");
    const authSchemaRef = hash(authSchemaFile.sql);
    const issuerSourceRef = hash("ordinary selected RP issuer source");
    const configDigest = hash(canonicalJson(SHARED_AUTH_STAGING_PROFILE));
    const rpRegistrationRef = hash("ordinary RP registration");
    const rpRegistrationDigest = hash("ordinary RP registration digest");
    const rpReceiptRef = hash("ordinary RP receipt");
    const manifest = Object.freeze({
      version: 1 as const,
      sourceCommit,
      sourceRef,
      targetRef,
      authSchemaRef,
      catalogDigest: await canonicalDigest(catalog),
      catalogProjection: Object.freeze(
        catalog.map(({ type, name, tbl_name }) => Object.freeze([type, name, tbl_name] as const)),
      ),
      registrationRef: canonical.registrationRef,
      recipeDigest: canonical.recipeDigest,
      clockSourceDigest: canonical.clockSourceDigest,
      clockPolicyRef: canonical.clockPolicyRef,
      rpRegistration: Object.freeze({
        registrationRef: rpRegistrationRef,
        registrationDigest: rpRegistrationDigest,
        receiptRef: rpReceiptRef,
        issuerSourceRef,
        configDigest,
        profile: SHARED_AUTH_STAGING_PROFILE,
      }),
    });
    const rpRecordJson = canonicalJson(auth103RpRegistrationRecord(manifest));
    const deploymentRef = await canonicalDigest([
      "takoserver.auth103.native-deployment.v1",
      targetRef,
      sourceRef,
      artifactDigest,
      "ordinary",
    ]);
    const deploymentReceiptRef = await canonicalDigest([
      "takoserver.auth103.native-deployment-receipt.v1",
      deploymentRef,
    ]);
    const deploymentRecordJson = canonicalJson({
      receiptRef: deploymentReceiptRef,
      manifest,
      artifactDigest,
      sourceProfile: "ordinary",
      rpRecordJson,
    });
    await database.sql.run("INSERT INTO auth103_native_rp_registrations VALUES (?,?,?)", [
      rpRegistrationRef,
      rpRegistrationDigest,
      rpRecordJson,
    ]);
    await database.sql.run("INSERT INTO auth103_native_rp_registration_receipts VALUES (?,?,?)", [
      rpReceiptRef,
      rpRegistrationRef,
      rpRecordJson,
    ]);
    await database.sql.run("INSERT INTO auth103_native_deployments VALUES (?,?,?,?,?)", [
      deploymentRef,
      targetRef,
      sourceRef,
      artifactDigest,
      deploymentRecordJson,
    ]);
    await database.sql.run("INSERT INTO auth103_native_deployment_receipts VALUES (?,?,?)", [
      deploymentReceiptRef,
      deploymentRef,
      deploymentRecordJson,
    ]);

    const originals = new WeakMap<
      object,
      { readonly sql: string; readonly params: readonly SqlParam[] }
    >();
    const binding = {
      prepare(sql: string) {
        const statement = {
          bind(...params: readonly SqlParam[]) {
            originals.set(statement, { sql, params });
            return statement;
          },
          async all() {
            const original = originals.get(statement);
            if (!original) throw new Error("ordinary native fixture statement differs");
            return {
              success: true,
              results: database.db
                .query<Row, never[]>(original.sql)
                .all(...(original.params as never[])),
              meta: { changes: 0 },
            };
          },
        };
        originals.set(statement, { sql, params: [] });
        return statement;
      },
      async batch() {
        throw new Error("native qualification must not write or batch");
      },
      withSession(constraint: "first-primary") {
        expect(constraint).toBe("first-primary");
        return this;
      },
    };
    const connection = await createWorkerOrdinaryPrimaryRequestSql({ database: binding });
    const client = createStripeBillingClient({
      secretKey: "sk_test_auth103_native_component",
      mode: "test",
      async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/v1/account")
          return Response.json({ object: "account", id: "acct_auth103ordinary" });
        if (path === "/v1/prices/price_auth103ordinary")
          return Response.json({
            object: "price",
            id: "price_auth103ordinary",
            livemode: false,
            currency: "usd",
            type: "recurring",
            billing_scheme: "per_unit",
            unit_amount: 1000,
            recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
          });
        throw new Error(`unexpected read-only processor request: ${path}`);
      },
    });
    const realm = await verifyHostedBillingFinancialRealm({
      sql: connection.sql,
      reader: { client },
      expected: {
        accountId: "acct_auth103ordinary",
        billingAuthority: "auth103-ordinary-component",
        mode: "test",
      },
      prices: [{ priceId: "price_auth103ordinary", monthlyAmountMinor: 1000 }],
    });
    const sharedAuth = captureWorkerSharedAuthStaging({
      kind: "shared-auth-staging-v1",
      clientSecret: "test-only-auth103-component-secret",
      encryptionKey: new Uint8Array(32).fill(3),
      principals: {
        async resolve() {
          throw new Error("positive source qualification grants no principal");
        },
      },
    });
    const options = {
      connection,
      sql: connection.sql,
      client,
      realm,
      identity: {
        async verify(): Promise<never> {
          throw new Error("positive source qualification grants no identity");
        },
      },
      clock: createAuth103SourceClock(),
      randomId: () => crypto.randomUUID(),
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
      sharedAuth,
    };
    initializeWorkerRequestNativeInputs(options);

    const env = {
      STATE_DB: binding,
      TAKOSERVER_SOURCE_COMMIT: sourceCommit,
      TAKOSERVER_WORKER_ARTIFACT_DIGEST: artifactDigest,
    };
    const globals = globalThis as Record<string, unknown>;
    const savedSource = globals.__TAKOSERVER_AUTH103_NATIVE_SOURCE__;
    const savedProfile = globals.__TAKOSERVER_AUTH103_NATIVE_PROFILE__;
    globals.__TAKOSERVER_AUTH103_NATIVE_SOURCE__ = manifest;
    globals.__TAKOSERVER_AUTH103_NATIVE_PROFILE__ = {
      profile: "root-shared-auth-staging-v1",
      sourceProfile: "ordinary",
    };
    mock.module("cloudflare:workers", () => ({ env }));
    try {
      const native = await import("../src/auth103-native-origin-source.ts" + "?ordinary-positive");
      expect(native.auth103NativeSourceCodeSelected()).toBe(true);
      expect(native.auth103NativeStorageSourceProfile()).toBe("ordinary");
      const capture = await native.qualifyAuth103NativeRequestOrigin(connection);
      expect(native.readAuth103NativeRequestOrigin(capture, connection)).toEqual({
        authSchemaRef,
        targetRef,
        sourceRef,
        clockPolicyRef: canonical.clockPolicyRef,
        sourceProfile: "ordinary",
      });
      const capturedCurrentness = native.auth103NativeRequestCurrentness(capture, connection);
      expect(capturedCurrentness.params).toHaveLength(10);
      const evaluateCurrentness = () =>
        database.db
          .query(`SELECT CASE WHEN (${capturedCurrentness.sql}) THEN 1 ELSE 0 END AS current`)
          .get(...(capturedCurrentness.params as never[]));
      expect(evaluateCurrentness()).toEqual({ current: 1 });
      expect(readWorkerRequestNativeInitializationInputs(connection)).toEqual({
        sql: connection.sql,
        client,
        realm,
        clock: options.clock,
        writerEpoch: undefined,
      });
      for (const ddl of [
        MONEY_CUTOVER_FREEZE_DDL,
        MONEY_CUTOVER_PERMIT_DDL,
        MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
        MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
        moneyFenceInstallSql("0094"),
      ])
        database.db.exec(ddl);
      expect(evaluateCurrentness()).toEqual({ current: 0 });
      await expect(native.qualifyAuth103NativeRequestOrigin(connection)).rejects.toMatchObject({
        code: "unavailable",
      });
    } finally {
      mock.restore();
      if (savedSource === undefined) delete globals.__TAKOSERVER_AUTH103_NATIVE_SOURCE__;
      else globals.__TAKOSERVER_AUTH103_NATIVE_SOURCE__ = savedSource;
      if (savedProfile === undefined) delete globals.__TAKOSERVER_AUTH103_NATIVE_PROFILE__;
      else globals.__TAKOSERVER_AUTH103_NATIVE_PROFILE__ = savedProfile;
    }
  } finally {
    database.db.close();
  }
});

test("the selected fresh Root origin reaches source qualification while old and foreign origins refuse", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "auth103-profile-source-"));
  try {
    mkdirSync(resolve(directory, "migrations"));
    const selected = {
      ...target,
      publicOrigin: fresh9dOrigin,
      auth103NativeProfile: "root-shared-auth-staging-v1",
    } satisfies DeployTarget;
    let failure: unknown;
    try {
      prepareAuth103NativeBuildSource({
        sourceRoot: directory,
        commit: "a".repeat(40),
        target: selected,
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(DeployError);
    if (!(failure instanceof DeployError))
      throw new Error("missing selected-profile source refusal");
    expect(failure.message).toBe("Auth103 selected Money source profile is invalid");
    expect(SHARED_AUTH_STAGING_PROFILE.publicOrigin).toBe(fresh9dOrigin);
    for (const publicOrigin of [old8732Origin, "https://foreign-auth.example.test"]) {
      expect(() =>
        prepareAuth103NativeBuildSource({
          sourceRoot: directory,
          commit: "a".repeat(40),
          target: { ...selected, publicOrigin },
        }),
      ).toThrow("Auth103 selected profile must retain its actual Root staging origin");
    }
    let transport: unknown;
    try {
      await captureAuth103NativeRpTransportInputs();
    } catch (error) {
      transport = error;
    }
    expect(transport).toBeInstanceOf(SqlError);
    if (!(transport instanceof SqlError))
      throw new Error("missing unselected-profile transport refusal");
    expect(transport.code).toBe("unavailable");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
