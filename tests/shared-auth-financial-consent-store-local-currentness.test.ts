import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { RpAuthorityRecord } from "../src/credential-authority-class.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { canonicalJson } from "../src/json.ts";
import {
  createMoneyCutoverSql,
  MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
  MONEY_CUTOVER_FINANCIAL_TABLES,
  MONEY_CUTOVER_FREEZE_DDL,
  MONEY_CUTOVER_PERMIT_DDL,
  MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  moneyCutoverClassificationTriggerSql,
  moneyCutoverFinancialTriggerSql,
} from "../src/money-cutover-sql.ts";
import type { Row, Sql, SqlStatement, SqlWrite } from "../src/ports.ts";
import {
  requireSharedAuthFinancialConsentConsumePostimage,
  sharedAuthFinancialConsentLeafStatements,
} from "../src/shared-auth-financial-consent-schema-plan.ts";
import {
  createSharedAuthFinancialConsentLocalCurrentnessReader,
  createSharedAuthFinancialConsentOriginalReader,
  type SharedAuthFinancialConsentCaptureData,
  type SharedAuthFinancialConsentGuardedStatementData,
  type SharedAuthFinancialConsentOriginalCommand,
  SharedAuthFinancialConsentOriginalReadError,
  type SharedAuthFinancialConsentPendingData,
  sharedAuthFinancialConsentCommandCaptureStatement,
  sharedAuthFinancialConsentLocalCurrentnessStatement,
  sharedAuthFinancialConsentOriginalConsumeStatement,
} from "../src/shared-auth-financial-consent-store.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "../src/shared-auth-oidc-client.ts";
import { createSharedFinancialActionIdentity } from "../src/shared-financial-action.ts";
import type { SharedPrincipalBinding } from "../src/shared-principal-authority.ts";
import type { D1ResultLike, D1StatementLike } from "../src/sql-d1.ts";
import { createStripeBillingClient } from "../src/stripe-billing-client.ts";
import {
  captureWorkerSharedAuthStaging,
  createWorkerRequestConsumers,
  createWorkerRequestSql,
  type WorkerRequestDatabase,
  type WorkerRequestSql,
} from "../src/worker-request-composition.ts";
import { syntheticV4Original } from "./consent-v4-fixture.ts";

const P = "shared_auth_financial_consent_pending";
const C = "shared_auth_financial_consent_commands";
const O = "shared_auth_financial_consent_originals";
const roots = [
  "principals",
  "auth_principal_incarnations",
  "shared_principal_bindings",
  "credential_authority_classes",
  "shared_auth_sessions",
  "unrelated_kept",
];
const opened = new Set<Database>();
afterEach(() => {
  for (const db of opened) db.close();
  opened.clear();
});
type Bind = string | number | Uint8Array | null;
const bytes = (value: string) => new TextEncoder().encode(value);
const digest = (value: string) => `sha256:${value.repeat(64)}` as const;
async function custodyHash(value: Uint8Array): Promise<string> {
  const hash = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(value)));
  return `sha256:${Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}
function insert(db: Database, table: string, value: object): void {
  const names = Object.keys(value);
  db.query(
    `INSERT INTO ${table} (${names.join(",")}) VALUES (${names.map(() => "?").join(",")})`,
  ).run(...(Object.values(value) as Bind[]));
}
function binds(statement: SqlStatement): Bind[] {
  return (statement.params ?? []).map((value) =>
    value instanceof ArrayBuffer ? new Uint8Array(value) : value,
  );
}
function write(db: Database, statement: SqlStatement): SqlWrite {
  const rows = db.query(statement.sql).all(...binds(statement)) as Row[];
  const count = db.query("SELECT changes() AS n").get() as { n: number };
  return { rows, changes: count.n };
}
const query = (db: Database, statement: SqlStatement) =>
  db.query(statement.sql).all(...binds(statement)) as Row[];
const rows = (db: Database, table: string) =>
  db.query(`SELECT * FROM ${table} ORDER BY rowid`).all();
function snapshot(db: Database) {
  return {
    root: roots.map((table) => rows(db, table)),
    pending: rows(db, P),
    commands: rows(db, C),
    originals: rows(db, O),
    schema: db.query("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name").all(),
  };
}

/** Reduced SYNTHETIC anchors for the fixed Root mechanical expressions, not
 * full103, registered source, a genuine Root factory/human/Clock/current
 * admission, coherent Financial R1 reader or native D1. Date.now below only
 * makes this future local fixture coexist with Root's fixed SQL execution
 * clock. It is not an injectable production authority or Clock qualification.
 */
async function fixture(options: { wrongBindingUnique?: boolean; seedPending?: boolean } = {}) {
  const db = new Database(":memory:");
  opened.add(db);
  db.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE principals(id TEXT PRIMARY KEY NOT NULL,provider TEXT NOT NULL,provider_subject TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE auth_principal_incarnations (
 principal_id TEXT NOT NULL,principal_incarnation TEXT NOT NULL,state TEXT NOT NULL,identity_kind TEXT NOT NULL,
 identity_subject TEXT NOT NULL,principal_created_at TEXT NOT NULL,origin_kind TEXT NOT NULL,
 identity_authority_body TEXT,identity_authority_digest TEXT,PRIMARY KEY(principal_id,principal_incarnation));
CREATE TABLE shared_principal_bindings (
 binding_ref TEXT PRIMARY KEY NOT NULL,principal_id TEXT NOT NULL,principal_incarnation TEXT NOT NULL,state TEXT NOT NULL,
 issuer TEXT NOT NULL,subject TEXT NOT NULL,controller_incarnation TEXT NOT NULL,target_ref TEXT NOT NULL,
 evidence_ref TEXT NOT NULL,evidence_digest TEXT NOT NULL,binding_kind TEXT NOT NULL,
 ${options.wrongBindingUnique ? "" : "UNIQUE(binding_ref,principal_id,principal_incarnation),"}
 FOREIGN KEY(principal_id,principal_incarnation) REFERENCES auth_principal_incarnations(principal_id,principal_incarnation) ON DELETE RESTRICT);
CREATE TABLE credential_authority_classes (
 authority_ref TEXT PRIMARY KEY NOT NULL,credential_incarnation TEXT NOT NULL UNIQUE,principal_id TEXT NOT NULL,
 principal_incarnation TEXT NOT NULL,principal_binding_ref TEXT NOT NULL,target_ref TEXT NOT NULL,backend TEXT NOT NULL,
 class TEXT NOT NULL,organization_id TEXT NOT NULL,workspace_id TEXT NOT NULL,workspace_ref TEXT NOT NULL,state TEXT NOT NULL,
 issuance_ref TEXT NOT NULL,issuance_digest TEXT NOT NULL,rp_registration_ref TEXT NOT NULL,rp_registration_digest TEXT NOT NULL,
 session_digest TEXT NOT NULL,session_created_at INTEGER NOT NULL,session_enrolled_version INTEGER NOT NULL,
 issuer TEXT NOT NULL,client_id TEXT NOT NULL,subject TEXT NOT NULL,issuer_session_id TEXT NOT NULL,auth_time INTEGER NOT NULL,account_id TEXT NOT NULL);
CREATE TABLE shared_auth_sessions (
 digest TEXT PRIMARY KEY NOT NULL,created_at INTEGER NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,
 account_id TEXT NOT NULL,principal_id TEXT NOT NULL,workspace_id TEXT NOT NULL,absolute_expires_at INTEGER NOT NULL,
 last_used_at INTEGER NOT NULL,grant_checked_at INTEGER NOT NULL);
CREATE TABLE unrelated_kept(id TEXT PRIMARY KEY NOT NULL,value BLOB NOT NULL);
INSERT INTO unrelated_kept VALUES('keep',X'000102ff');`);
  const at = Date.now() - 2_000;
  const created = new Date(at - 10_000).toISOString();
  const human: SharedPrincipalBinding = {
    ref: "human_binding",
    issuer: "https://auth.example.test",
    subject: "account_original",
    controllerIncarnation: "controller_incarnation",
    principalId: "principal",
    principalIncarnation: "principal_incarnation",
    targetRef: "auth_target",
    kind: "fresh-shared",
    evidence: { ref: "human_evidence", digest: digest("c") },
    previousRef: null,
    enrolledAt: created,
    state: "active",
    terminal: null,
  };
  const credential: RpAuthorityRecord = {
    state: "active",
    terminal: null,
    class: "official-shared-rp-session",
    backend: "shared-rp-session",
    organizationId: "retained_org_A",
    origin: {
      ref: "authority",
      incarnation: "credential_incarnation",
      targetRef: "auth_target",
      principalId: "principal",
      principalIncarnation: "principal_incarnation",
      issuanceRef: "issuance_original",
      issuanceDigest: digest("d"),
      issuedAt: created,
    },
    rp: {
      principalBindingRef: human.ref,
      registrationRef: "rp_registration",
      registrationDigest: digest("e"),
      sessionDigest: digest("f"),
      sessionCreatedAt: at - 5_000,
      enrolledSessionVersion: 3,
      issuer: human.issuer,
      clientId: "actual_pinned_client",
      subject: human.subject,
      issuerSessionId: "issuer_session",
      authTime: at - 8_000,
      accountId: human.subject,
      workspaceId: "row_workspace_A",
      workspaceRef: "row_ref_A",
    },
  };
  const currentSession = { version: 7, absoluteExpiresAt: at + 600_000, lastUsedAt: at - 100 };
  insert(db, "principals", {
    id: human.principalId,
    provider: "shared-account",
    provider_subject: human.subject,
    created_at: created,
  });
  insert(db, "auth_principal_incarnations", {
    principal_id: human.principalId,
    principal_incarnation: human.principalIncarnation,
    state: "active",
    identity_kind: "shared-account",
    identity_subject: human.subject,
    principal_created_at: created,
    origin_kind: human.kind,
    identity_authority_body: null,
    identity_authority_digest: null,
  });
  insert(db, "shared_principal_bindings", {
    binding_ref: human.ref,
    principal_id: human.principalId,
    principal_incarnation: human.principalIncarnation,
    state: "active",
    issuer: human.issuer,
    subject: human.subject,
    controller_incarnation: human.controllerIncarnation,
    target_ref: human.targetRef,
    evidence_ref: human.evidence.ref,
    evidence_digest: human.evidence.digest,
    binding_kind: human.kind,
  });
  const r = credential.rp;
  insert(db, "credential_authority_classes", {
    authority_ref: credential.origin.ref,
    credential_incarnation: credential.origin.incarnation,
    principal_id: human.principalId,
    principal_incarnation: human.principalIncarnation,
    principal_binding_ref: human.ref,
    target_ref: human.targetRef,
    backend: credential.backend,
    class: credential.class,
    organization_id: credential.organizationId,
    workspace_id: r.workspaceId,
    workspace_ref: r.workspaceRef,
    state: "active",
    issuance_ref: credential.origin.issuanceRef,
    issuance_digest: credential.origin.issuanceDigest,
    rp_registration_ref: r.registrationRef,
    rp_registration_digest: r.registrationDigest,
    session_digest: r.sessionDigest,
    session_created_at: r.sessionCreatedAt,
    session_enrolled_version: r.enrolledSessionVersion,
    issuer: r.issuer,
    client_id: r.clientId,
    subject: r.subject,
    issuer_session_id: r.issuerSessionId,
    auth_time: r.authTime,
    account_id: r.accountId,
  });
  insert(db, "shared_auth_sessions", {
    digest: r.sessionDigest,
    created_at: r.sessionCreatedAt,
    status: "active",
    version: currentSession.version,
    account_id: r.accountId,
    principal_id: human.principalId,
    workspace_id: r.workspaceId,
    absolute_expires_at: currentSession.absoluteExpiresAt,
    last_used_at: currentSession.lastUsedAt,
    grant_checked_at: at - 200,
  });
  for (const statement of sharedAuthFinancialConsentLeafStatements()) db.exec(statement.sql);
  const action = bytes(
    '{"amountMinor":1000,"kind":"topup","organizationId":"org_action","reference":"original"}',
  );
  const terms = bytes("Original R1 terms — exact UTF8\nKeep original selection unchanged.");
  const actionIdentity = await createSharedFinancialActionIdentity(
    JSON.parse(new TextDecoder().decode(action)),
  );
  const challenge = bytes(
    canonicalJson({
      v: 1,
      challengeRef: "challenge_original",
      registrationRef: "financial_challenge_registration",
      clientId: "takoserver-console-staging-v1",
      workspaceId: "selected_workspace_B",
      organizationId: "org_action",
      workspaceRef: "selected_ref_B",
      requestFingerprint: actionIdentity.requestFingerprint,
      createdAt: at,
      expiresAt: at + 240_000,
    }),
  );
  const pending: SharedAuthFinancialConsentPendingData = {
    transaction_ref: `rpfc_${"a".repeat(43)}`,
    registration_ref: "rp_consent_registration",
    incarnation: "consent_incarnation",
    challenge_ref: "challenge_original",
    action_ref: "original",
    action_kind: "topup",
    organization_id: "org_action",
    workspace_id: "selected_workspace_B",
    workspace_ref: "selected_ref_B",
    request_fingerprint: actionIdentity.requestFingerprint,
    principal_id: human.principalId,
    principal_incarnation: human.principalIncarnation,
    principal_binding_ref: human.ref,
    authority_ref: credential.origin.ref,
    credential_incarnation: credential.origin.incarnation,
    credential_target_ref: human.targetRef,
    credential_organization_id: credential.organizationId,
    credential_workspace_id: r.workspaceId,
    credential_workspace_ref: r.workspaceRef,
    action_original_bytes: action,
    action_custody_sha256: await custodyHash(action),
    terms_original_bytes: terms,
    terms_digest_original: await custodyHash(terms),
    terms_custody_sha256: await custodyHash(terms),
    disclosure_ref: "disclosure_original",
    challenge_original_bytes: challenge,
    challenge_custody_sha256: await custodyHash(challenge),
    created_at: at,
    expires_at: at + 240_000,
  };
  const commandBytes = bytes('{"synthetic":"exact predispatch full command bytes"}');
  const identity = await syntheticV4Original(
    pending,
    credential,
    currentSession.version,
    "opaque consent Ω 01",
  );
  const originalBytes = bytes(identity.canonicalOriginalJson);
  const command: SharedAuthFinancialConsentOriginalCommand = {
    key: {
      registrationRef: pending.registration_ref,
      incarnation: pending.incarnation,
      transactionRef: pending.transaction_ref,
      commandRef: "command_original",
      consentRef: identity.original.consentRef,
      receiptRef: "receipt_original",
    },
    selectedScope: {
      organizationId: pending.organization_id,
      workspaceId: pending.workspace_id,
      workspaceRef: pending.workspace_ref,
    },
    family: "rp-explicit-action-consent",
    commandBytes,
    commandCustodySHA256: await custodyHash(commandBytes),
    originalBytes,
    originalDigest: identity.consentDigest,
    originalCustodySHA256: await custodyHash(originalBytes),
    capturedAt: at + 100,
  };
  const input: SharedAuthFinancialConsentGuardedStatementData = {
    pending,
    command,
    credential,
    human,
    currentSession,
    recordedAt: at + 200,
  };
  // Test-only insertion of a synthetic retained pending. This is NOT a product
  // pending producer or evidence of genuine Financial selection/human consent.
  if (options.seedPending !== false && !options.wrongBindingUnique) insert(db, P, pending);
  const sql: Pick<Sql, "query"> = {
    async query(statement, params = []) {
      return db
        .query(statement)
        .all(...params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p))) as Row[];
    },
  };
  return { db, input, sql };
}
const captureInput = (
  input: SharedAuthFinancialConsentGuardedStatementData,
): SharedAuthFinancialConsentCaptureData => ({ pending: input.pending, command: input.command });
const expected = (input: SharedAuthFinancialConsentGuardedStatementData) => ({
  key: input.command.key,
  selectedScope: input.command.selectedScope,
  originalBytes: input.command.originalBytes,
  originalDigest: input.command.originalDigest,
  originalCustodySHA256: input.command.originalCustodySHA256,
  recordedAt: input.recordedAt,
});
const originalRow = (input: SharedAuthFinancialConsentGuardedStatementData) => ({
  consent_ref: input.command.key.consentRef,
  command_ref: input.command.key.commandRef,
  transaction_ref: input.command.key.transactionRef,
  receipt_ref: input.command.key.receiptRef,
  registration_ref: input.command.key.registrationRef,
  incarnation: input.command.key.incarnation,
  organization_id: input.command.selectedScope.organizationId,
  workspace_id: input.command.selectedScope.workspaceId,
  workspace_ref: input.command.selectedScope.workspaceRef,
  original_bytes: input.command.originalBytes,
  original_digest: input.command.originalDigest,
  original_custody_sha256: input.command.originalCustodySHA256,
  recorded_at: input.recordedAt,
  receipt_recorded_at: input.recordedAt,
});
async function capture(f: Awaited<ReturnType<typeof fixture>>) {
  const result = write(
    f.db,
    await sharedAuthFinancialConsentCommandCaptureStatement(captureInput(f.input)),
  );
  expect(result.changes).toBe(1);
  expect(result.rows).toHaveLength(1);
  expect(Object.keys(result.rows[0]!).length).toBe(16);
  return result;
}
async function complete(f: Awaited<ReturnType<typeof fixture>>) {
  await capture(f);
  const result = write(f.db, await sharedAuthFinancialConsentOriginalConsumeStatement(f.input));
  expect(result.changes).toBe(1);
  expect(result.rows).toHaveLength(1);
  expect(Object.keys(result.rows[0]!).length).toBe(14);
  await requireSharedAuthFinancialConsentConsumePostimage(result, expected(f.input));
  return result;
}

const WRITER = digest("9");
const isLocal = (sql: string) => sql.startsWith("SELECT local_original.");
function moneySchema(db: Database) {
  for (const sql of [
    MONEY_CUTOVER_FREEZE_DDL,
    MONEY_CUTOVER_PERMIT_DDL,
    MONEY_CUTOVER_AUTHORIZED_EPOCH_DDL,
    MONEY_CUTOVER_PERMIT_EPOCH_GUARD_DDL,
  ])
    db.exec(sql);
  db.exec(
    "CREATE TABLE money_unit_policy(singleton INTEGER PRIMARY KEY,ledger_unit TEXT,historical_usage_unit TEXT,cash_unit TEXT)",
  );
  db.query("INSERT INTO money_cutover_authorized_epoch VALUES(1,?)").run(WRITER);
  db.exec("INSERT INTO money_unit_policy VALUES(1,'usd-micros-v2','microcent-v1','usd-cents-v1')");
  for (const table of [
    ...MONEY_CUTOVER_FINANCIAL_TABLES,
    "wallet_credit_lot_classification_proofs",
  ])
    db.exec(`CREATE TABLE ${table}(id TEXT)`);
  for (const verb of ["INSERT", "UPDATE", "DELETE"] as const) {
    for (const table of MONEY_CUTOVER_FINANCIAL_TABLES)
      db.exec(moneyCutoverFinancialTriggerSql(table, verb));
    db.exec(moneyCutoverClassificationTriggerSql(verb));
  }
}

/** Exact retained realm schema expressions copied from pinned463b9833. This
 * fixture is synthetic; only actual constructors establish local test origin.
 * No fake assert/brand/ready/Map or provider credential qualifies this graph.
 */
function realmSchema(db: Database, at: string) {
  db.exec(`CREATE TABLE stripe_billing_account_realms (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  account_id TEXT NOT NULL,
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  billing_authority TEXT NOT NULL,
  created_at TEXT NOT NULL,
  CHECK (length(account_id) BETWEEN 6 AND 255 AND substr(account_id, 1, 5) = 'acct_'
         AND substr(account_id, 6) NOT GLOB '*[^A-Za-z0-9]*'),
  CHECK (length(billing_authority) BETWEEN 1 AND 256
         AND billing_authority GLOB '[A-Za-z0-9]*'
         AND billing_authority NOT GLOB '*[^A-Za-z0-9._:-]*'),
  CHECK (strftime('%Y-%m-%dT%H:%M:%fZ', created_at) IS NOT NULL
         AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at) = created_at)
)`);
  for (const suffix of ["no_replace", "no_update", "no_delete"] as const)
    db.exec(`CREATE TRIGGER stripe_billing_account_realms_${suffix}
BEFORE ${suffix === "no_replace" ? "INSERT" : suffix === "no_update" ? "UPDATE" : "DELETE"} ON stripe_billing_account_realms
${suffix === "no_replace" ? "WHEN EXISTS (SELECT 1 FROM stripe_billing_account_realms)\n" : ""}BEGIN
  SELECT RAISE(ABORT, 'constraint: authenticated Stripe financial realm is immutable');
END`);
  db.exec(`CREATE TABLE stripe_mode_realm (
  singleton INTEGER PRIMARY KEY NOT NULL CHECK (singleton = 1),
  mode TEXT NOT NULL CHECK (mode IN ('test', 'live')),
  pinned_at TEXT NOT NULL
)`);
  for (const operation of ["update", "delete"] as const)
    db.exec(`CREATE TRIGGER stripe_mode_realm_no_${operation} BEFORE ${operation.toUpperCase()} ON stripe_mode_realm
BEGIN
  SELECT RAISE(ABORT, 'Stripe mode realm pin is immutable');
END`);
  db.query("INSERT INTO stripe_mode_realm VALUES(1,'test',?)").run(at);
  db.query(
    "INSERT INTO stripe_billing_account_realms VALUES(1,'acct_fixture','test','synthetic.fixture',?)",
  ).run(at);
}

type Trace = { sql: string; params: readonly (string | number | null | ArrayBuffer)[] };
class NativeStatement implements D1StatementLike {
  constructor(
    readonly owner: SyntheticNative,
    readonly sql: string,
    readonly params: Trace["params"] = [],
  ) {}
  bind(...params: Trace["params"]): NativeStatement {
    return new NativeStatement(this.owner, this.sql, [...params]);
  }
  execute(): D1ResultLike {
    this.owner.calls.push({ sql: this.sql, params: this.params });
    const before = (this.owner.db.query("SELECT total_changes() AS n").get() as { n: number }).n;
    const rows = this.owner.db
      .query(this.sql)
      .all(...this.params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p))) as Row[];
    const changes =
      (this.owner.db.query("SELECT total_changes() AS n").get() as { n: number }).n - before;
    return { success: true, results: rows, meta: { changes } };
  }
  async all(): Promise<D1ResultLike> {
    await this.owner.beforeRead?.(this.sql);
    const result = this.execute();
    return this.owner.rowFault
      ? { ...result, results: this.owner.rowFault(this.sql, result.results ?? []) }
      : result;
  }
}

/** This is an in-memory native-shaped test adapter, NOT actual D1. Its methods
 * provide real SQLite rows/changes to the unchanged strict D1 adapter and real
 * request constructors. Hook functions inject transport faults only, never
 * authority/capability/currentness predicates or replacement graph assertions.
 */
class SyntheticNative implements WorkerRequestDatabase {
  calls: Trace[] = [];
  batchCalls = 0;
  primaryCalls = 0;
  beforeRead?: (sql: string) => Promise<void>;
  rowFault?: (sql: string, rows: readonly Row[]) => readonly Row[];
  constructor(readonly db: Database) {}
  withSession(constraint: "first-primary"): SyntheticNative {
    expect(constraint).toBe("first-primary");
    this.primaryCalls++;
    return this;
  }
  prepare(sql: string): NativeStatement {
    return new NativeStatement(this, sql);
  }
  async batch(statements: readonly D1StatementLike[]): Promise<readonly D1ResultLike[]> {
    this.batchCalls++;
    return this.db.transaction(() =>
      statements.map((statement) => {
        if (!(statement instanceof NativeStatement) || statement.owner !== this)
          throw new Error("foreign synthetic statement");
        return statement.execute();
      }),
    )();
  }
}

async function graphFixture(options: Parameters<typeof fixture>[0] = {}, committed = true) {
  const f = await fixture(options);
  if (committed && !options.wrongBindingUnique && options.seedPending !== false) await complete(f);
  moneySchema(f.db);
  realmSchema(f.db, f.input.credential.origin.issuedAt);
  const native = new SyntheticNative(f.db);
  const connection = await createWorkerRequestSql({
    database: native,
    writerEpoch: WRITER,
    publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
    consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
  });
  let providerReads = 0;
  let rpTransport = 0;
  let principalReads = 0;
  let identityReads = 0;
  const client = createStripeBillingClient({
    mode: "test",
    secretKey: "sk_test_synthetic_private_fixture_not_a_credential",
    async fetch(request) {
      providerReads++;
      expect(request.method).toBe("GET");
      const path = new URL(request.url).pathname;
      if (path === "/v1/account") return Response.json({ object: "account", id: "acct_fixture" });
      if (path === "/v1/prices/price_fixture")
        return Response.json({
          object: "price",
          id: "price_fixture",
          livemode: false,
          currency: "usd",
          type: "recurring",
          billing_scheme: "per_unit",
          unit_amount: 500,
          recurring: { interval: "month", interval_count: 1, usage_type: "licensed" },
        });
      throw new Error("No real processor request allowed");
    },
  });
  const realm = await verifyHostedBillingFinancialRealm({
    sql: connection.sql,
    reader: { client },
    expected: { accountId: "acct_fixture", mode: "test", billingAuthority: "synthetic.fixture" },
    prices: [{ priceId: "price_fixture", monthlyAmountMinor: 500 }],
  });
  const sharedAuth = captureWorkerSharedAuthStaging({
    kind: "shared-auth-staging-v1",
    clientSecret: "synthetic-only-no-authority",
    encryptionKey: new Uint8Array(32).fill(7),
    principals: {
      async resolve(): Promise<never> {
        principalReads++;
        throw new Error("No genuine Principal producer");
      },
    },
    async fetch(): Promise<never> {
      rpTransport++;
      throw new Error("No real RP transport");
    },
  });
  const graph = createWorkerRequestConsumers({
    connection,
    sql: connection.sql,
    client,
    realm,
    sharedAuth,
    identity: {
      async verify(): Promise<never> {
        identityReads++;
        throw new Error("No identity verifier");
      },
    },
    clock: () => new Date(f.input.credential.origin.issuedAt),
    randomId: () => "unused_synthetic_id",
    publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
    consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
  });
  expect(native.primaryCalls).toBe(1);
  expect(connection.sql).toBe(graph.sql);
  native.calls = [];
  native.batchCalls = 0;
  return {
    ...f,
    native,
    connection,
    graph,
    sharedAuth,
    effects: () => ({ providerReads, rpTransport, principalReads, identityReads }),
  };
}

function routedSql(db: Database) {
  const trace = {
    query: [] as Trace[],
    run: [] as Trace[],
    batch: [] as (readonly SqlStatement[])[],
  };
  const raw: Sql = {
    async query(sql, params = []) {
      expect(this).toBe(raw);
      trace.query.push({ sql, params });
      return query(db, { sql, params });
    },
    async run(sql, params = []) {
      expect(this).toBe(raw);
      trace.run.push({ sql, params });
      return write(db, { sql, params });
    },
    async batch(statements) {
      expect(this).toBe(raw);
      trace.batch.push(statements);
      return db.transaction(() =>
        statements.map((s) => {
          const before = (db.query("SELECT total_changes() AS n").get() as { n: number }).n;
          const selected = query(db, s);
          const changes =
            (db.query("SELECT total_changes() AS n").get() as { n: number }).n - before;
          return { rows: selected, changes };
        }),
      )();
    },
  };
  return { wrapped: createMoneyCutoverSql(raw, WRITER), trace };
}

/** Static delta proof binds this extracted inner expression to the old3de
 * local SELECT byte-for-byte (apart from its captured-input helper extraction).
 * It is a specific old routing control, not a second implementation/SQL parser.
 */
function oldWithControl(next: SqlStatement): SqlStatement {
  const marker = " FROM (WITH expected(";
  const start = next.sql.indexOf(marker);
  expect(start > 0).toBe(true);
  expect(next.sql.endsWith(") AS local_original")).toBe(true);
  return {
    sql: next.sql.slice(start + " FROM (".length, -") AS local_original".length),
    params: next.params,
  };
}
function expectQueryOnly(f: Awaited<ReturnType<typeof graphFixture>>) {
  expect(f.native.batchCalls).toBe(0);
  expect(f.native.calls.every((q) => /^(?:SELECT\b|PRAGMA table_info\()/u.test(q.sql))).toBe(true);
  expect(
    f.native.calls.some((q) =>
      /^(?:INSERT INTO|DELETE FROM) money_cutover_writer_permit\b/u.test(q.sql),
    ),
  ).toBe(false);
  expect(f.effects().rpTransport).toBe(0);
  expect(f.effects().principalReads).toBe(0);
  expect(f.effects().identityReads).toBe(0);
  expect(rows(f.db, "money_cutover_writer_permit")).toEqual([]);
}

// Authored SOURCE ONLY. Future positive graph tests use ACTUAL constructors
// and unchanged private origin readers with reduced synthetic native/processor
// DATA. They do not prepare genuine Root credential/human/Clock/FinancialR1 or
// current permission. No type/SQL/Bun/graph test has run in this source unit.
describe("private request-origin local-currentness DATA reader: source cases", () => {
  test("explicit outer14 SELECT keeps81 binds and matches old WITH raw14 while avoiding actual Money permit routing", async () => {
    const f = await fixture();
    await complete(f);
    moneySchema(f.db);
    const next = await sharedAuthFinancialConsentLocalCurrentnessStatement(f.input);
    const old = oldWithControl(next);
    expect(next.params).toHaveLength(81);
    expect(next.sql.match(/\?/gu)).toHaveLength(81);
    expect(old.sql).toContain("LIMIT 2");
    expect(query(f.db, next)).toEqual([originalRow(f.input)]);
    expect(query(f.db, old)).toEqual(query(f.db, next));
    const newer = routedSql(f.db);
    expect(await newer.wrapped.query(next.sql, next.params)).toEqual([originalRow(f.input)]);
    expect(newer.trace.query).toHaveLength(1);
    expect(newer.trace.run).toEqual([]);
    expect(newer.trace.batch).toEqual([]);
    const prior = routedSql(f.db);
    expect(await prior.wrapped.query(old.sql, old.params)).toEqual([originalRow(f.input)]);
    expect(prior.trace.query).toEqual([]);
    expect(prior.trace.run).toEqual([]);
    expect(prior.trace.batch).toHaveLength(1);
    expect(prior.trace.batch[0]).toHaveLength(3);
    expect(prior.trace.batch[0]?.[0]?.sql).toStartWith("INSERT INTO money_cutover_writer_permit");
    expect(prior.trace.batch[0]?.[2]?.sql).toStartWith("DELETE FROM money_cutover_writer_permit");
    expect(rows(f.db, "money_cutover_writer_permit")).toEqual([]);
  });

  test("actual same-graph query-only method returns exact historical original14 without touch refresh or writer calls", async () => {
    const f = await graphFixture();
    const before = snapshot(f.db);
    const effects = f.effects();
    const reader = createSharedAuthFinancialConsentLocalCurrentnessReader(f.connection);
    expect(Object.keys(reader)).toEqual(["readLocalCurrentnessData"]);
    const result = await reader.readLocalCurrentnessData(f.input);
    expect(result?.command).toEqual(f.input.command);
    expect(result?.originalBytes).toEqual(f.input.command.originalBytes);
    expect(result?.recordedAt).toBe(f.input.recordedAt);
    expect(result?.receiptRecordedAt).toBe(f.input.recordedAt);
    expect(f.native.calls.filter((q) => isLocal(q.sql))).toHaveLength(1);
    expectQueryOnly(f);
    expect(f.effects()).toEqual(effects);
    expect(snapshot(f.db)).toEqual(before);
  });

  test("all four closed metadata SELECT forms preserve full native PRAGMA columns values and seq order", async () => {
    const f = await graphFixture();
    await createSharedAuthFinancialConsentLocalCurrentnessReader(
      f.connection,
    ).readLocalCurrentnessData(f.input);
    const seen = new Set<string>();
    for (const item of f.native.calls) {
      let prior: string | undefined;
      if (item.sql === "SELECT foreign_keys FROM pragma_foreign_keys") {
        prior = "PRAGMA foreign_keys";
        seen.add("foreign_keys");
      }
      if (item.sql.includes("FROM pragma_index_list(?)")) {
        prior = `PRAGMA index_list(${item.params[0]})`;
        seen.add("index_list");
      }
      if (item.sql.includes("FROM pragma_index_info(?)")) {
        prior = `PRAGMA index_info(${item.params[0]})`;
        seen.add("index_info");
      }
      if (item.sql.includes("FROM pragma_foreign_key_check(?)")) {
        prior = `PRAGMA foreign_key_check(${item.params[0]})`;
        seen.add("foreign_key_check");
      }
      if (prior) expect(query(f.db, item)).toEqual(f.db.query<Row, []>(prior).all());
    }
    expect([...seen].sort()).toEqual([
      "foreign_key_check",
      "foreign_keys",
      "index_info",
      "index_list",
    ]);
    expectQueryOnly(f);
  });

  test("local zero rows after retirement or version drift are nonmatch DATA while historical custody stays readable", async () => {
    for (const change of [
      "UPDATE credential_authority_classes SET state='retired'",
      "UPDATE shared_auth_sessions SET version=version+1",
      "UPDATE shared_auth_sessions SET absolute_expires_at=1",
    ]) {
      const f = await graphFixture();
      f.db.exec(change);
      const before = snapshot(f.db);
      expect(
        await createSharedAuthFinancialConsentLocalCurrentnessReader(
          f.connection,
        ).readLocalCurrentnessData(f.input),
      ).toBeUndefined();
      expect(
        (await createSharedAuthFinancialConsentOriginalReader(f.sql).readOriginal(f.input.command))
          ?.receiptRef,
      ).toBe(f.input.command.key.receiptRef);
      expectQueryOnly(f);
      expect(snapshot(f.db)).toEqual(before);
    }
  });

  test("historical positive absence pending-only command-only and wrong recordedAt are unavailable never local nonmatch", async () => {
    for (const kind of ["absent", "pending", "command", "recorded"] as const) {
      const f = await graphFixture(
        kind === "absent" ? { seedPending: false } : {},
        kind === "recorded",
      );
      if (kind === "command") await capture(f);
      const input =
        kind === "recorded" ? { ...f.input, recordedAt: f.input.recordedAt + 1 } : f.input;
      const before = snapshot(f.db);
      await expect(
        createSharedAuthFinancialConsentLocalCurrentnessReader(
          f.connection,
        ).readLocalCurrentnessData(input),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(f.native.calls.filter((q) => isLocal(q.sql))).toEqual([]);
      expectQueryOnly(f);
      expect(snapshot(f.db)).toEqual(before);
    }
  });

  test("foreign same-shaped connection Sql clone accessor or alternate realm cannot manufacture actual graph origin", async () => {
    const f = await graphFixture();
    let getters = 0;
    for (const connection of [
      { ...f.connection },
      { sql: { ...f.connection.sql }, moneyGuard: f.connection.moneyGuard },
    ]) {
      expect(() => createSharedAuthFinancialConsentLocalCurrentnessReader(connection)).toThrow();
    }
    const forged = Object.defineProperty({}, "sql", {
      get() {
        getters++;
        return f.connection.sql;
      },
    });
    expect(() =>
      createSharedAuthFinancialConsentLocalCurrentnessReader(forged as WorkerRequestSql),
    ).toThrow();
    const other = await graphFixture();
    const options = {
      connection: f.connection,
      sql: f.connection.sql,
      client: f.graph.client,
      realm: f.graph.realm,
      sharedAuth: f.sharedAuth,
      identity: {
        async verify(): Promise<never> {
          throw new Error("No identity producer");
        },
      },
      clock: () => new Date(f.input.credential.origin.issuedAt),
      randomId: () => "unused",
      publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
    };
    for (const changed of [
      { client: other.graph.client },
      { realm: { ...f.graph.realm } },
      { sql: other.connection.sql },
    ]) {
      expect(() => createWorkerRequestConsumers({ ...options, ...changed })).toThrow();
    }
    expect(getters).toBe(0);
    expect(f.native.calls).toEqual([]);
  });

  test("query method replacement before a read or across its SQL await fails actual owning-origin checks", async () => {
    const f = await graphFixture();
    const reader = createSharedAuthFinancialConsentLocalCurrentnessReader(f.connection);
    const original = f.connection.sql.query;
    Object.defineProperty(f.connection.sql, "query", {
      value: async () => [],
      configurable: true,
      writable: true,
    });
    await expect(reader.readLocalCurrentnessData(f.input)).rejects.toMatchObject({
      code: "unavailable",
    });
    Object.defineProperty(f.connection.sql, "query", {
      value: original,
      configurable: true,
      writable: true,
    });
    let announce!: () => void;
    let release!: () => void;
    const started = new Promise<void>((r) => {
      announce = r;
    });
    const gate = new Promise<void>((r) => {
      release = r;
    });
    f.native.beforeRead = async () => {
      announce();
      await gate;
    };
    const pending = reader.readLocalCurrentnessData(f.input);
    await started;
    Object.defineProperty(f.connection.sql, "query", {
      value: async () => [],
      configurable: true,
      writable: true,
    });
    release();
    await expect(pending).rejects.toMatchObject({ code: "unavailable" });
    expect(f.native.batchCalls).toBe(0);
  });

  test("all14 local fields plus duplicate extra accessor and aliased BLOB rows are strictly compared without a fake ACK", async () => {
    const fields = Object.keys(originalRow((await fixture()).input));
    expect(fields).toHaveLength(14);
    for (const field of [...fields, "duplicate", "extra", "accessor"]) {
      const f = await graphFixture();
      let reached = false;
      let getters = 0;
      const before = snapshot(f.db);
      f.native.rowFault = (sql, rows) => {
        if (!isLocal(sql)) return rows;
        reached = true;
        const row = { ...rows[0]! };
        if (field === "duplicate") return [row, { ...row }];
        if (field === "extra") return [{ ...row, changes: 1 }];
        if (field === "accessor")
          Object.defineProperty(row, "original_digest", {
            enumerable: true,
            get() {
              getters++;
              return f.input.command.originalDigest;
            },
          });
        else if (row[field] instanceof Uint8Array) {
          const value = new Uint8Array(row[field] as Uint8Array);
          value[0] = value[0]! ^ 1;
          row[field] = value;
        } else
          row[field] =
            typeof row[field] === "number" ? Number(row[field]) + 1 : `${row[field]}_changed`;
        return [row];
      };
      await expect(
        createSharedAuthFinancialConsentLocalCurrentnessReader(
          f.connection,
        ).readLocalCurrentnessData(f.input),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(reached).toBe(true);
      expect(getters).toBe(0);
      expectQueryOnly(f);
      expect(snapshot(f.db)).toEqual(before);
    }
  });

  test("borrowed exported query errors remain unavailable with no retry or writer dispatch", async () => {
    for (const code of ["invalid_request", "custody_conflict", "unavailable"] as const) {
      const f = await graphFixture();
      let count = 0;
      f.native.beforeRead = async (sql) => {
        if (isLocal(sql)) {
          count++;
          throw new SharedAuthFinancialConsentOriginalReadError(code);
        }
      };
      const before = snapshot(f.db);
      await expect(
        createSharedAuthFinancialConsentLocalCurrentnessReader(
          f.connection,
        ).readLocalCurrentnessData(f.input),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(count).toBe(1);
      expectQueryOnly(f);
      expect(snapshot(f.db)).toEqual(before);
    }
  });

  test("input fullcommand Root metadata and raw arrays detach before every query await", async () => {
    const f = await graphFixture();
    const input = structuredClone(f.input);
    const pending = createSharedAuthFinancialConsentLocalCurrentnessReader(
      f.connection,
    ).readLocalCurrentnessData(input);
    input.command.commandBytes.fill(0);
    input.command.originalBytes.fill(0);
    input.pending.action_original_bytes.fill(0);
    Reflect.set(input.command.key, "receiptRef", "changed_after_call");
    Reflect.set(input.currentSession, "version", 999);
    Reflect.set(input.credential.origin, "ref", "changed_after_call");
    Reflect.set(input.human, "ref", "changed_after_call");
    const result = await pending;
    expect(result?.command).toEqual(f.input.command);
    result?.originalBytes.fill(0);
    expect(
      (await createSharedAuthFinancialConsentOriginalReader(f.sql).readOriginal(f.input.command))
        ?.originalBytes,
    ).toEqual(f.input.command.originalBytes);
    expectQueryOnly(f);
  });

  test("FKoff orphan partial or wrong unique schema cannot become ready through metadata SELECTs", async () => {
    for (const kind of ["off", "orphan", "partial", "unique"] as const) {
      const f = await graphFixture(kind === "unique" ? { wrongBindingUnique: true } : {});
      if (kind === "off") f.db.exec("PRAGMA foreign_keys=OFF");
      if (kind === "orphan")
        f.db.exec(
          "PRAGMA foreign_keys=OFF; DELETE FROM auth_principal_incarnations; PRAGMA foreign_keys=ON",
        );
      if (kind === "partial")
        f.db.exec("DROP TRIGGER shared_auth_financial_consent_commands_no_update");
      const before = snapshot(f.db);
      await expect(
        createSharedAuthFinancialConsentLocalCurrentnessReader(
          f.connection,
        ).readLocalCurrentnessData(f.input),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(f.native.calls.filter((q) => isLocal(q.sql))).toEqual([]);
      expectQueryOnly(f);
      expect(snapshot(f.db)).toEqual(before);
    }
  });

  test("there is no arbitrary SQL metadata fallback or caller predicate API and accessors remain uncalled", async () => {
    const f = await graphFixture();
    const reader = createSharedAuthFinancialConsentLocalCurrentnessReader(f.connection);
    let getters = 0;
    for (const extra of [
      { sql: "PRAGMA foreign_keys=OFF" },
      { sql: "PRAGMA index_info(unknown); SELECT 1" },
      { predicate: () => true },
      { ready: true },
    ]) {
      await expect(reader.readLocalCurrentnessData({ ...f.input, ...extra })).rejects.toMatchObject(
        { code: "invalid_request" },
      );
    }
    const input = { ...f.input };
    Object.defineProperty(input, "credential", {
      enumerable: true,
      get() {
        getters++;
        return f.input.credential;
      },
    });
    await expect(reader.readLocalCurrentnessData(input)).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(getters).toBe(0);
    expect(f.native.calls).toEqual([]);
    expectQueryOnly(f);
  });

  test("unknown or injected index names cannot turn an unproven required key into schema readiness", async () => {
    for (const name of [
      "sqlite_autoindex_missing_1",
      "sqlite_autoindex_x);PRAGMA foreign_keys=OFF--",
    ]) {
      const f = await graphFixture();
      const before = snapshot(f.db);
      f.native.rowFault = (sql, found) =>
        sql.includes("FROM pragma_index_list(?)")
          ? found.map((row) =>
              String(row.name).includes("shared_principal_bindings") ? { ...row, name } : row,
            )
          : found;
      await expect(
        createSharedAuthFinancialConsentLocalCurrentnessReader(
          f.connection,
        ).readLocalCurrentnessData(f.input),
      ).rejects.toMatchObject({ code: "unavailable" });
      expectQueryOnly(f);
      expect(snapshot(f.db)).toEqual(before);
      expect(f.native.calls.some((q) => q.sql.includes("foreign_keys=OFF"))).toBe(false);
    }
  });
});
