import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { RpAuthorityRecord } from "../src/credential-authority-class.ts";
import { verifyHostedBillingFinancialRealm } from "../src/hosted-billing-realm.ts";
import { canonicalJson } from "../src/json.ts";
import {
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
  captureSharedAuthFinancialConsentRequestCommandData,
  createSharedAuthFinancialConsentRequestCommandRecovery,
  type SharedAuthFinancialConsentCaptureData,
  type SharedAuthFinancialConsentGuardedStatementData,
  type SharedAuthFinancialConsentOriginalCommand,
  SharedAuthFinancialConsentOriginalReadError,
  type SharedAuthFinancialConsentPendingData,
  sharedAuthFinancialConsentCommandCaptureStatement,
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
async function fixture(
  options: { wrongBindingUnique?: boolean; seedPending?: boolean; at?: number } = {},
) {
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
  const at = options.at ?? Date.now() - 2_000;
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
    const rows = this.owner.db
      .query(this.sql)
      .all(...this.params.map((p) => (p instanceof ArrayBuffer ? new Uint8Array(p) : p))) as Row[];
    const changes = (this.owner.db.query("SELECT changes() AS n").get() as { n: number }).n;
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
  beforeBatch?: () => Promise<void>;
  afterBatch?: (results: readonly D1ResultLike[]) => readonly D1ResultLike[];
  committedBatches: (readonly D1ResultLike[])[] = [];
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
    await this.beforeBatch?.();
    const result = this.db.transaction(() =>
      statements.map((statement) => {
        if (!(statement instanceof NativeStatement) || statement.owner !== this)
          throw new Error("foreign synthetic statement");
        return statement.execute();
      }),
    )();
    this.committedBatches.push(result);
    return this.afterBatch ? this.afterBatch(result) : result;
  }
}

async function graphFixture(options: Parameters<typeof fixture>[0] = {}, committed = false) {
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
  const composition = {
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
  };
  const graph = createWorkerRequestConsumers(composition);
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
    replaceGraph: () => createWorkerRequestConsumers(composition),
    effects: () => ({ providerReads, rpTransport, principalReads, identityReads }),
  };
}

export {
  bytes,
  capture,
  captureInput,
  complete,
  custodyHash,
  digest,
  graphFixture,
  insert,
  rows,
  snapshot,
  write,
};
