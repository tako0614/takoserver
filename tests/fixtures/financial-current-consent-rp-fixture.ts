// Mechanical positive fixture derived from the existing RP local-currentness test.
// It is used only to compare Financial's packed guard with the actual 81-bind RP builder.
import { Database } from "bun:sqlite";
import { expect } from "bun:test";
import type { RpAuthorityRecord } from "../../src/credential-authority-class.ts";
import { canonicalJson } from "../../src/json.ts";
import type { Row, Sql, SqlStatement, SqlWrite } from "../../src/ports.ts";
import {
  requireSharedAuthFinancialConsentConsumePostimage,
  sharedAuthFinancialConsentLeafStatements,
} from "../../src/shared-auth-financial-consent-schema-plan.ts";
import {
  type SharedAuthFinancialConsentCaptureData,
  type SharedAuthFinancialConsentGuardedStatementData,
  type SharedAuthFinancialConsentOriginalCommand,
  type SharedAuthFinancialConsentPendingData,
  sharedAuthFinancialConsentCommandCaptureStatement,
  sharedAuthFinancialConsentOriginalConsumeStatement,
} from "../../src/shared-auth-financial-consent-store.ts";
import { createSharedFinancialActionIdentity } from "../../src/shared-financial-action.ts";
import type { SharedPrincipalBinding } from "../../src/shared-principal-authority.ts";
import { syntheticV4Original } from "../consent-v4-fixture.ts";

const P = "shared_auth_financial_consent_pending";
const opened = new Set<Database>();
export function closeRpCurrentConsentFixtures() {
  for (const db of opened) db.close();
  opened.clear();
}
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
export async function rpCurrentConsentFixture(
  options: { wrongBindingUnique?: boolean; seedPending?: boolean } = {},
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
async function capture(f: Awaited<ReturnType<typeof rpCurrentConsentFixture>>) {
  const result = write(
    f.db,
    await sharedAuthFinancialConsentCommandCaptureStatement(captureInput(f.input)),
  );
  expect(result.changes).toBe(1);
  expect(result.rows).toHaveLength(1);
  expect(Object.keys(result.rows[0] ?? {}).length).toBe(16);
  return result;
}
export async function completeRpCurrentConsentFixture(
  f: Awaited<ReturnType<typeof rpCurrentConsentFixture>>,
) {
  await capture(f);
  const result = write(f.db, await sharedAuthFinancialConsentOriginalConsumeStatement(f.input));
  expect(result.changes).toBe(1);
  expect(result.rows).toHaveLength(1);
  expect(Object.keys(result.rows[0] ?? {}).length).toBe(14);
  await requireSharedAuthFinancialConsentConsumePostimage(result, expected(f.input));
  return result;
}
