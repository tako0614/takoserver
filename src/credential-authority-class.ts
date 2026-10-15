import type { Row, Sql, SqlParam, SqlStatement } from "./ports.ts";
import {
  type AuthAuthorityDigest,
  AuthAuthorityStoreError,
  type AuthAuthorityTerminal,
  type AuthCurrentnessPredicate,
  authAuthorityDigest,
  authAuthorityInteger,
  authAuthorityText,
  authAuthorityTime,
} from "./shared-principal-authority.ts";

export type CredentialAuthorityClass =
  | "direct-owner-session"
  | "direct-exact-org-key"
  | "official-shared-broker"
  | "official-shared-rp-session";
export interface CredentialAuthorityOrigin {
  readonly ref: string;
  readonly incarnation: string;
  readonly targetRef: string;
  readonly principalId: string;
  readonly principalIncarnation: string;
  readonly issuanceRef: string;
  readonly issuanceDigest: AuthAuthorityDigest;
  readonly issuedAt: string;
}
export interface TokenAuthorityIdentity {
  readonly id: string;
  readonly digest: AuthAuthorityDigest;
  readonly scopesJson: string;
  readonly createdAt: string;
}
export interface RpAuthorityIdentity {
  readonly principalBindingRef: string;
  readonly registrationRef: string;
  readonly registrationDigest: AuthAuthorityDigest;
  readonly sessionDigest: AuthAuthorityDigest;
  readonly sessionCreatedAt: number;
  readonly enrolledSessionVersion: number;
  readonly issuer: string;
  readonly clientId: string;
  readonly subject: string;
  readonly issuerSessionId: string;
  readonly authTime: number;
  readonly accountId: string;
  readonly workspaceId: string;
  readonly workspaceRef: string;
}
interface RetainedClassState {
  readonly state: "active" | "retired";
  readonly terminal: AuthAuthorityTerminal | null;
}
export interface TokenAuthorityRecord extends RetainedClassState {
  readonly origin: CredentialAuthorityOrigin;
  readonly class: "direct-owner-session" | "direct-exact-org-key" | "official-shared-broker";
  readonly backend: "auth-token";
  readonly organizationId: string | null;
  readonly tokenKind: "session" | "api_key";
  readonly token: TokenAuthorityIdentity;
}
export interface RpAuthorityRecord extends RetainedClassState {
  readonly origin: CredentialAuthorityOrigin;
  readonly class: "official-shared-rp-session";
  readonly backend: "shared-rp-session";
  readonly organizationId: string;
  readonly rp: RpAuthorityIdentity;
}
export type CredentialAuthorityRecord = TokenAuthorityRecord | RpAuthorityRecord;

function origin(input: CredentialAuthorityOrigin): CredentialAuthorityOrigin {
  return Object.freeze({
    ref: authAuthorityText(input.ref, 256),
    incarnation: authAuthorityText(input.incarnation, 256),
    targetRef: authAuthorityText(input.targetRef),
    principalId: authAuthorityText(input.principalId),
    principalIncarnation: authAuthorityText(input.principalIncarnation, 256),
    issuanceRef: authAuthorityText(input.issuanceRef),
    issuanceDigest: authAuthorityDigest(input.issuanceDigest),
    issuedAt: authAuthorityTime(input.issuedAt),
  });
}
function scopes(value: unknown): string {
  const raw = authAuthorityText(value, 1024);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new AuthAuthorityStoreError("invalid");
  }
  if (
    !Array.isArray(parsed) ||
    parsed.length > 128 ||
    parsed.some((item) => typeof item !== "string" || item.length > 64)
  ) {
    throw new AuthAuthorityStoreError("invalid");
  }
  return raw;
}
function token(input: TokenAuthorityIdentity): TokenAuthorityIdentity {
  return Object.freeze({
    id: authAuthorityText(input.id),
    digest: authAuthorityDigest(input.digest),
    scopesJson: scopes(input.scopesJson),
    createdAt: authAuthorityText(input.createdAt),
  });
}
function rp(input: RpAuthorityIdentity): RpAuthorityIdentity {
  return Object.freeze({
    principalBindingRef: authAuthorityText(input.principalBindingRef, 256),
    registrationRef: authAuthorityText(input.registrationRef),
    registrationDigest: authAuthorityDigest(input.registrationDigest),
    sessionDigest: authAuthorityDigest(input.sessionDigest),
    sessionCreatedAt: authAuthorityInteger(input.sessionCreatedAt),
    enrolledSessionVersion: authAuthorityInteger(input.enrolledSessionVersion),
    issuer: authAuthorityText(input.issuer, 2048),
    clientId: authAuthorityText(input.clientId),
    subject: authAuthorityText(input.subject),
    issuerSessionId: authAuthorityText(input.issuerSessionId),
    authTime: authAuthorityInteger(input.authTime),
    accountId: authAuthorityText(input.accountId),
    workspaceId: authAuthorityText(input.workspaceId),
    workspaceRef: authAuthorityText(input.workspaceRef),
  });
}
function retainedState(row: Row): RetainedClassState {
  if (
    row.state === "active" &&
    row.terminal_reason === null &&
    row.terminal_at === null &&
    row.terminal_ref === null
  ) {
    return Object.freeze({ state: "active", terminal: null });
  }
  if (row.state !== "retired") throw new AuthAuthorityStoreError("unavailable");
  return Object.freeze({
    state: "retired",
    terminal: Object.freeze({
      reason: authAuthorityText(row.terminal_reason),
      at: authAuthorityTime(row.terminal_at),
      ref: authAuthorityText(row.terminal_ref),
    }),
  });
}
function fromRow(row: Row): CredentialAuthorityRecord {
  const common = origin({
    ref: authAuthorityText(row.authority_ref),
    incarnation: authAuthorityText(row.credential_incarnation),
    targetRef: authAuthorityText(row.target_ref),
    principalId: authAuthorityText(row.principal_id),
    principalIncarnation: authAuthorityText(row.principal_incarnation),
    issuanceRef: authAuthorityText(row.issuance_ref),
    issuanceDigest: authAuthorityDigest(row.issuance_digest),
    issuedAt: authAuthorityTime(row.issued_at),
  });
  const retained = retainedState(row);
  if (
    row.backend === "auth-token" &&
    (row.class === "direct-owner-session" ||
      row.class === "direct-exact-org-key" ||
      row.class === "official-shared-broker")
  ) {
    const organizationId = row.organization_id;
    for (const field of [
      "principal_binding_ref",
      "rp_registration_ref",
      "rp_registration_digest",
      "session_digest",
      "session_created_at",
      "session_enrolled_version",
      "issuer",
      "client_id",
      "subject",
      "issuer_session_id",
      "auth_time",
      "account_id",
      "workspace_id",
      "workspace_ref",
    ]) {
      if (row[field] !== null) throw new AuthAuthorityStoreError("unavailable");
    }
    // Do not infer session from a non-api_key value or a hostPrincipalId prefix.
    if (
      (row.token_kind !== "session" && row.token_kind !== "api_key") ||
      (row.class === "direct-owner-session" &&
        (row.token_kind !== "session" || row.organization_id !== null)) ||
      (row.class !== "direct-owner-session" &&
        (row.token_kind !== "api_key" || typeof row.organization_id !== "string"))
    ) {
      throw new AuthAuthorityStoreError("unavailable");
    }
    return Object.freeze({
      origin: common,
      ...retained,
      backend: "auth-token",
      class: row.class,
      organizationId: organizationId === null ? null : authAuthorityText(organizationId),
      tokenKind: row.token_kind,
      token: token({
        id: authAuthorityText(row.token_id),
        digest: authAuthorityDigest(row.token_digest),
        scopesJson: scopes(row.token_scopes_json),
        createdAt: authAuthorityText(row.token_created_at),
      }),
    });
  }
  if (row.backend !== "shared-rp-session" || row.class !== "official-shared-rp-session") {
    throw new AuthAuthorityStoreError("unavailable");
  }
  for (const field of [
    "token_id",
    "token_digest",
    "token_kind",
    "token_scopes_json",
    "token_created_at",
  ]) {
    if (row[field] !== null) throw new AuthAuthorityStoreError("unavailable");
  }
  return Object.freeze({
    origin: common,
    ...retained,
    backend: "shared-rp-session",
    class: "official-shared-rp-session",
    organizationId: authAuthorityText(row.organization_id),
    rp: rp({
      principalBindingRef: authAuthorityText(row.principal_binding_ref),
      registrationRef: authAuthorityText(row.rp_registration_ref),
      registrationDigest: authAuthorityDigest(row.rp_registration_digest),
      sessionDigest: authAuthorityDigest(row.session_digest),
      sessionCreatedAt: authAuthorityInteger(row.session_created_at),
      enrolledSessionVersion: authAuthorityInteger(row.session_enrolled_version),
      issuer: authAuthorityText(row.issuer),
      clientId: authAuthorityText(row.client_id),
      subject: authAuthorityText(row.subject),
      issuerSessionId: authAuthorityText(row.issuer_session_id),
      authTime: authAuthorityInteger(row.auth_time),
      accountId: authAuthorityText(row.account_id),
      workspaceId: authAuthorityText(row.workspace_id),
      workspaceRef: authAuthorityText(row.workspace_ref),
    }),
  });
}

type Column =
  | "authority_ref"
  | "credential_incarnation"
  | "class"
  | "backend"
  | "target_ref"
  | "organization_id"
  | "principal_id"
  | "principal_incarnation"
  | "issuance_ref"
  | "issuance_digest"
  | "issued_at"
  | "token_id"
  | "token_digest"
  | "token_kind"
  | "token_scopes_json"
  | "token_created_at"
  | "principal_binding_ref"
  | "rp_registration_ref"
  | "rp_registration_digest"
  | "session_digest"
  | "session_created_at"
  | "session_enrolled_version"
  | "issuer"
  | "client_id"
  | "subject"
  | "issuer_session_id"
  | "auth_time"
  | "account_id"
  | "workspace_id"
  | "workspace_ref";
type Field = readonly [Column, SqlParam];
function base(
  input: CredentialAuthorityOrigin,
  kind: CredentialAuthorityClass,
  backend: "auth-token" | "shared-rp-session",
  organizationId: string | null,
): readonly Field[] {
  return [
    ["authority_ref", input.ref],
    ["credential_incarnation", input.incarnation],
    ["class", kind],
    ["backend", backend],
    ["target_ref", input.targetRef],
    ["organization_id", organizationId],
    ["principal_id", input.principalId],
    ["principal_incarnation", input.principalIncarnation],
    ["issuance_ref", input.issuanceRef],
    ["issuance_digest", input.issuanceDigest],
    ["issued_at", input.issuedAt],
  ];
}
function insert(fields: readonly Field[], guard: AuthCurrentnessPredicate): SqlStatement {
  const params: SqlParam[] = [];
  const values = fields.map(([column, value]) => {
    if (column === "principal_id") {
      params.push(...guard.params, value);
      return `CASE WHEN ${guard.sql} THEN ? ELSE NULL END`;
    }
    params.push(value);
    return "?";
  });
  return Object.freeze({
    sql: `INSERT INTO credential_authority_classes (${fields.map(([column]) => column).join(",")}) VALUES (${values.join(",")})`,
    params: Object.freeze(params),
  });
}
function currentAnchor(prefix: string): string {
  // Prefix comes only from this module's closed literal calls, never a DTO.
  return `EXISTS (SELECT 1 FROM auth_principal_incarnations i JOIN principals p ON p.id=i.principal_id
    WHERE i.principal_id=${prefix}.principal_id AND i.principal_incarnation=${prefix}.principal_incarnation
      AND i.state='active' AND p.provider=i.identity_kind AND p.provider_subject=i.identity_subject
      AND p.created_at=i.principal_created_at)`;
}
function tokenIssuance(
  input: CredentialAuthorityOrigin,
  identity: TokenAuthorityIdentity,
  kind: "direct-owner-session" | "direct-exact-org-key" | "official-shared-broker",
  organizationId: string | null,
): SqlStatement {
  const selected = origin(input);
  const credential = token(identity);
  const tokenKind = kind === "direct-owner-session" ? "session" : "api_key";
  const guard = Object.freeze({
    sql: `EXISTS (SELECT 1 FROM auth_tokens t JOIN auth_principal_incarnations i ON i.principal_id=t.principal_id
      JOIN principals p ON p.id=i.principal_id WHERE t.id=? AND t.secret_digest=? AND t.kind=?
        AND t.principal_id=? AND t.org_id IS ? AND t.created_at=? AND t.scopes_json=?
        AND t.revoked_at IS NULL AND t.created_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')
        AND i.principal_incarnation=? AND i.state='active' AND p.provider=i.identity_kind
        AND p.provider_subject=i.identity_subject AND p.created_at=i.principal_created_at)`,
    params: Object.freeze([
      credential.id,
      credential.digest,
      tokenKind,
      selected.principalId,
      organizationId,
      credential.createdAt,
      credential.scopesJson,
      selected.principalIncarnation,
    ]),
  });
  return insert(
    [
      ...base(selected, kind, "auth-token", organizationId),
      ["token_id", credential.id],
      ["token_digest", credential.digest],
      ["token_kind", tokenKind],
      ["token_scopes_json", credential.scopesJson],
      ["token_created_at", credential.createdAt],
    ],
    guard,
  );
}

/**
 * Internal statement/retained-read component. There is deliberately no generic
 * register(class, JSON) method or public endpoint. A genuine future issuer must
 * append the mandatory class INSERT to its actual token/RP Sql.batch. Neither
 * these helpers nor candidate rows prove identity, enrollment or payer consent.
 */
export function createCredentialAuthorityClassStore(options: { readonly sql: Sql }) {
  const { sql } = options;
  return {
    localSessionIssuanceStatement(
      input: CredentialAuthorityOrigin,
      credential: TokenAuthorityIdentity,
    ): SqlStatement {
      return tokenIssuance(input, credential, "direct-owner-session", null);
    },
    directKeyIssuanceStatement(
      input: CredentialAuthorityOrigin,
      credential: TokenAuthorityIdentity,
      organizationId: string,
    ): SqlStatement {
      return tokenIssuance(
        input,
        credential,
        "direct-exact-org-key",
        authAuthorityText(organizationId),
      );
    },
    sharedBrokerIssuanceStatement(
      input: CredentialAuthorityOrigin,
      credential: TokenAuthorityIdentity,
      organizationId: string,
    ): SqlStatement {
      return tokenIssuance(
        input,
        credential,
        "official-shared-broker",
        authAuthorityText(organizationId),
      );
    },
    sharedRpIssuanceStatement(
      input: CredentialAuthorityOrigin,
      identity: RpAuthorityIdentity,
      organizationId: string,
    ): SqlStatement {
      const selected = origin(input);
      const session = rp(identity);
      const organization = authAuthorityText(organizationId);
      const guard = Object.freeze({
        sql: `EXISTS (SELECT 1 FROM shared_auth_sessions s JOIN shared_principal_bindings b ON b.binding_ref=?
          WHERE s.digest=? AND s.created_at=? AND s.version=? AND s.status='active'
            AND s.account_id=? AND s.principal_id=? AND s.workspace_id=?
            AND b.principal_id=s.principal_id AND b.principal_incarnation=? AND b.target_ref=?
            AND b.issuer=? AND b.subject=? AND b.subject=s.account_id AND b.state='active'
            AND ${currentAnchor("b")})`,
        params: Object.freeze([
          session.principalBindingRef,
          session.sessionDigest,
          session.sessionCreatedAt,
          session.enrolledSessionVersion,
          session.accountId,
          selected.principalId,
          session.workspaceId,
          selected.principalIncarnation,
          selected.targetRef,
          session.issuer,
          session.subject,
        ]),
      });
      return insert(
        [
          ...base(selected, "official-shared-rp-session", "shared-rp-session", organization),
          ["principal_binding_ref", session.principalBindingRef],
          ["rp_registration_ref", session.registrationRef],
          ["rp_registration_digest", session.registrationDigest],
          ["session_digest", session.sessionDigest],
          ["session_created_at", session.sessionCreatedAt],
          ["session_enrolled_version", session.enrolledSessionVersion],
          ["issuer", session.issuer],
          ["client_id", session.clientId],
          ["subject", session.subject],
          ["issuer_session_id", session.issuerSessionId],
          ["auth_time", session.authTime],
          ["account_id", session.accountId],
          ["workspace_id", session.workspaceId],
          ["workspace_ref", session.workspaceRef],
        ],
        guard,
      );
    },
    async readRetained(ref: string): Promise<CredentialAuthorityRecord | null> {
      const rows = await sql.query(
        "SELECT * FROM credential_authority_classes WHERE authority_ref=?",
        [authAuthorityText(ref, 256)],
      );
      if (rows.length > 1) throw new AuthAuthorityStoreError("unavailable");
      return rows[0] ? fromRow(rows[0]) : null;
    },
    async retire(
      expected: CredentialAuthorityOrigin,
      closure: AuthAuthorityTerminal,
    ): Promise<void> {
      const selected = origin(expected);
      const reason = authAuthorityText(closure.reason);
      const at = authAuthorityTime(closure.at);
      const ref = authAuthorityText(closure.ref);
      const result = await sql.run(
        `UPDATE credential_authority_classes
        SET state='retired',terminal_reason=?,terminal_at=?,terminal_ref=?
        WHERE authority_ref=? AND credential_incarnation=? AND target_ref=? AND principal_id=?
          AND principal_incarnation=? AND issuance_ref=? AND issuance_digest=? AND issued_at=? AND state='active'`,
        [
          reason,
          at,
          ref,
          selected.ref,
          selected.incarnation,
          selected.targetRef,
          selected.principalId,
          selected.principalIncarnation,
          selected.issuanceRef,
          selected.issuanceDigest,
          selected.issuedAt,
        ],
      );
      if (result.changes !== 1) throw new AuthAuthorityStoreError("conflict");
    },
  };
}

/** Only Auth/Financial's current captured transport constraints; never payer authority. */
export function sharedBrokerCredentialCurrentness(
  record: TokenAuthorityRecord,
  capturedExpiresAt: string,
  organizationId: string,
): AuthCurrentnessPredicate {
  if (record.class !== "official-shared-broker" || record.tokenKind !== "api_key")
    throw new AuthAuthorityStoreError("invalid");
  const selected = origin(record.origin);
  const credential = token(record.token);
  const organization = authAuthorityText(organizationId);
  if (record.organizationId !== organization) throw new AuthAuthorityStoreError("conflict");
  return Object.freeze({
    sql: `EXISTS (SELECT 1 FROM credential_authority_classes a JOIN auth_tokens t
      ON t.id=a.token_id AND t.secret_digest=a.token_digest
      WHERE ((((a.authority_ref=? AND (a.credential_incarnation=? AND a.target_ref=?)) AND (a.class='official-shared-broker' AND (a.backend='auth-token' AND a.state='active'))) AND ((a.organization_id=? AND (a.principal_id=? AND a.principal_incarnation=?)) AND ((a.issuance_ref=? AND a.issuance_digest=?) AND (a.token_id=? AND a.token_digest=?)))) AND (((a.token_created_at=? AND (a.token_scopes_json=? AND a.token_kind='api_key')) AND ((t.principal_id=a.principal_id AND t.org_id=a.organization_id) AND (t.kind='api_key' AND t.created_at=a.token_created_at))) AND ((t.scopes_json=a.token_scopes_json AND (t.revoked_at IS NULL AND t.expires_at=?)) AND ((t.created_at<=strftime('%Y-%m-%dT%H:%M:%fZ','now') AND t.expires_at>strftime('%Y-%m-%dT%H:%M:%fZ','now')) AND (EXISTS (SELECT 1 FROM json_each(t.scopes_json) WHERE type='text' AND value='payments:write') AND ${currentAnchor("a")}))))))`,
    params: Object.freeze([
      selected.ref,
      selected.incarnation,
      selected.targetRef,
      organization,
      selected.principalId,
      selected.principalIncarnation,
      selected.issuanceRef,
      selected.issuanceDigest,
      credential.id,
      credential.digest,
      credential.createdAt,
      credential.scopesJson,
      authAuthorityTime(capturedExpiresAt),
    ]),
  });
}

export function sharedRpCredentialCurrentness(
  record: RpAuthorityRecord,
  current: {
    readonly version: number;
    readonly absoluteExpiresAt: number;
    readonly lastUsedAt: number;
  },
  organizationId: string,
): AuthCurrentnessPredicate {
  const selected = origin(record.origin);
  const session = rp(record.rp);
  const organization = authAuthorityText(organizationId);
  if (record.organizationId !== organization) throw new AuthAuthorityStoreError("conflict");
  const version = authAuthorityInteger(current.version);
  const expiry = authAuthorityInteger(current.absoluteExpiresAt);
  const lastUsed = authAuthorityInteger(current.lastUsedAt);
  const now =
    "(CAST(strftime('%s','now') AS INTEGER)*1000+CAST(substr(strftime('%f','now'),4,3) AS INTEGER))";
  return Object.freeze({
    sql: `EXISTS (SELECT 1 FROM credential_authority_classes a JOIN shared_auth_sessions s
      ON s.digest=a.session_digest AND s.created_at=a.session_created_at
      WHERE (((((a.authority_ref=? AND a.credential_incarnation=?) AND (a.target_ref=? AND (a.class='official-shared-rp-session' AND a.backend='shared-rp-session'))) AND ((a.state='active' AND a.organization_id=?) AND (a.principal_id=? AND (a.principal_incarnation=? AND a.issuance_ref=?)))) AND (((a.issuance_digest=? AND a.principal_binding_ref=?) AND (a.rp_registration_ref=? AND (a.rp_registration_digest=? AND a.session_digest=?))) AND ((a.session_created_at=? AND a.session_enrolled_version=?) AND (a.issuer=? AND (a.client_id=? AND a.subject=?))))) AND ((((a.issuer_session_id=? AND a.auth_time=?) AND (a.account_id=? AND (a.workspace_id=? AND a.workspace_ref=?))) AND ((s.status='active' AND s.version=?) AND (s.version>=a.session_enrolled_version AND (s.account_id=a.account_id AND s.principal_id=a.principal_id)))) AND (((s.workspace_id=a.workspace_id AND s.absolute_expires_at=?) AND (s.last_used_at=? AND (s.created_at<=${now} AND s.last_used_at<=${now}))) AND ((s.grant_checked_at<=${now} AND s.absolute_expires_at>${now}) AND (s.last_used_at+43200000>${now} AND (EXISTS (SELECT 1 FROM shared_principal_bindings b
          WHERE b.binding_ref=a.principal_binding_ref AND b.principal_id=a.principal_id
            AND b.principal_incarnation=a.principal_incarnation AND b.target_ref=a.target_ref
            AND b.issuer=a.issuer AND b.subject=a.subject AND b.subject=a.account_id AND b.state='active') AND ${currentAnchor("a")})))))))`,
    params: Object.freeze([
      selected.ref,
      selected.incarnation,
      selected.targetRef,
      organization,
      selected.principalId,
      selected.principalIncarnation,
      selected.issuanceRef,
      selected.issuanceDigest,
      session.principalBindingRef,
      session.registrationRef,
      session.registrationDigest,
      session.sessionDigest,
      session.sessionCreatedAt,
      session.enrolledSessionVersion,
      session.issuer,
      session.clientId,
      session.subject,
      session.issuerSessionId,
      session.authTime,
      session.accountId,
      session.workspaceId,
      session.workspaceRef,
      version,
      expiry,
      lastUsed,
    ]),
  });
}
