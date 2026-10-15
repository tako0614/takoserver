import type { Row, Sql, SqlParam, SqlStatement } from "./ports.ts";

/** Internal retained storage, not an identity verifier or a public enrollment API. */
export class AuthAuthorityStoreError extends Error {
  constructor(readonly code: "invalid" | "conflict" | "unavailable") {
    super(`auth_authority_${code}`);
    this.name = "AuthAuthorityStoreError";
  }
}

export type AuthAuthorityDigest = `sha256:${string}`;
export type PrincipalIdentityKind = "google" | "github" | "takos-id" | "shared-account";
export interface AuthAuthorityEvidence {
  readonly ref: string;
  readonly digest: AuthAuthorityDigest;
}
export interface AuthAuthorityTerminal {
  readonly reason: string;
  readonly at: string;
  readonly ref: string;
}
export interface PrincipalAnchor {
  readonly principalId: string;
  readonly incarnation: string;
  readonly identityKind: PrincipalIdentityKind;
  readonly identitySubject: string;
  readonly principalCreatedAt: string;
  readonly originKind: "fresh-local" | "fresh-shared" | "proved-legacy";
  readonly origin: AuthAuthorityEvidence;
  readonly enrolledAt: string;
  readonly state: "active" | "retired";
  readonly terminal: AuthAuthorityTerminal | null;
}
export interface SharedPrincipalBinding {
  readonly ref: string;
  readonly issuer: string;
  readonly subject: string;
  readonly controllerIncarnation: string;
  readonly principalId: string;
  readonly principalIncarnation: string;
  readonly targetRef: string;
  readonly kind: "fresh-shared" | "proved-legacy";
  readonly evidence: AuthAuthorityEvidence;
  readonly previousRef: string | null;
  readonly enrolledAt: string;
  readonly state: "active" | "retired";
  readonly terminal: AuthAuthorityTerminal | null;
}
export interface AuthCurrentnessPredicate {
  /** Fixed owning expression; its result alone is never financial permission. */
  readonly sql: string;
  readonly params: readonly SqlParam[];
}
export interface InitialSharedBinding {
  readonly ref: string;
  readonly issuer: string;
  readonly subject: string;
  readonly controllerIncarnation: string;
  readonly targetRef: string;
  readonly evidence: AuthAuthorityEvidence;
  readonly enrolledAt: string;
}
export interface FreshSharedPrincipal {
  readonly principalId: string;
  readonly principalIncarnation: string;
  readonly createdAt: string;
  readonly origin: AuthAuthorityEvidence;
  readonly binding: InitialSharedBinding;
}
export interface ProvedLegacyPrincipal {
  readonly principalId: string;
  readonly principalIncarnation: string;
  readonly provider: "google" | "github" | "takos-id";
  readonly providerSubject: string;
  readonly createdAt: string;
  readonly origin: AuthAuthorityEvidence;
  readonly binding: InitialSharedBinding;
}

/** Shared internal validators also used by the credential storage component. */
export function authAuthorityText(value: unknown, max = 512): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /\p{Cc}/u.test(value)
  ) {
    throw new AuthAuthorityStoreError("invalid");
  }
  return value;
}
export function authAuthorityDigest(value: unknown): AuthAuthorityDigest {
  if (typeof value !== "string" || !/^sha256:[0-9a-f]{64}$/u.test(value)) {
    throw new AuthAuthorityStoreError("invalid");
  }
  return value as AuthAuthorityDigest;
}
export function authAuthorityTime(value: unknown): string {
  const text = authAuthorityText(value, 24);
  const parsed = new Date(text);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== text) {
    throw new AuthAuthorityStoreError("invalid");
  }
  return text;
}
export function authAuthorityInteger(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AuthAuthorityStoreError("invalid");
  }
  return value;
}
function evidence(value: AuthAuthorityEvidence): AuthAuthorityEvidence {
  return Object.freeze({
    ref: authAuthorityText(value.ref),
    digest: authAuthorityDigest(value.digest),
  });
}
function terminal(value: AuthAuthorityTerminal): AuthAuthorityTerminal {
  return Object.freeze({
    reason: authAuthorityText(value.reason),
    at: authAuthorityTime(value.at),
    ref: authAuthorityText(value.ref),
  });
}
function state(row: Row): "active" | "retired" {
  if (row.state !== "active" && row.state !== "retired")
    throw new AuthAuthorityStoreError("unavailable");
  return row.state;
}
function rowTerminal(row: Row): AuthAuthorityTerminal | null {
  if (state(row) === "active") {
    if (row.terminal_reason !== null || row.terminal_at !== null || row.terminal_ref !== null) {
      throw new AuthAuthorityStoreError("unavailable");
    }
    return null;
  }
  return terminal({
    reason: authAuthorityText(row.terminal_reason),
    at: authAuthorityTime(row.terminal_at),
    ref: authAuthorityText(row.terminal_ref),
  });
}
function anchorFrom(row: Row): PrincipalAnchor {
  const kind = row.identity_kind;
  const originKind = row.origin_kind;
  if (
    (kind !== "google" && kind !== "github" && kind !== "takos-id" && kind !== "shared-account") ||
    (originKind !== "fresh-local" &&
      originKind !== "fresh-shared" &&
      originKind !== "proved-legacy")
  )
    throw new AuthAuthorityStoreError("unavailable");
  return Object.freeze({
    principalId: authAuthorityText(row.principal_id),
    incarnation: authAuthorityText(row.principal_incarnation, 256),
    identityKind: kind,
    identitySubject: authAuthorityText(row.identity_subject),
    principalCreatedAt: authAuthorityText(row.principal_created_at),
    originKind,
    origin: evidence({
      ref: authAuthorityText(row.origin_ref),
      digest: authAuthorityDigest(row.origin_digest),
    }),
    enrolledAt: authAuthorityTime(row.enrolled_at),
    state: state(row),
    terminal: rowTerminal(row),
  });
}
function bindingFrom(row: Row): SharedPrincipalBinding {
  if (row.binding_kind !== "fresh-shared" && row.binding_kind !== "proved-legacy") {
    throw new AuthAuthorityStoreError("unavailable");
  }
  return Object.freeze({
    ref: authAuthorityText(row.binding_ref, 256),
    issuer: authAuthorityText(row.issuer, 2048),
    subject: authAuthorityText(row.subject),
    controllerIncarnation: authAuthorityText(row.controller_incarnation, 256),
    principalId: authAuthorityText(row.principal_id),
    principalIncarnation: authAuthorityText(row.principal_incarnation, 256),
    targetRef: authAuthorityText(row.target_ref),
    kind: row.binding_kind,
    evidence: evidence({
      ref: authAuthorityText(row.evidence_ref),
      digest: authAuthorityDigest(row.evidence_digest),
    }),
    previousRef:
      row.previous_binding_ref === null ? null : authAuthorityText(row.previous_binding_ref, 256),
    enrolledAt: authAuthorityTime(row.enrolled_at),
    state: state(row),
    terminal: rowTerminal(row),
  });
}
function initial(input: InitialSharedBinding): InitialSharedBinding {
  return Object.freeze({
    ref: authAuthorityText(input.ref, 256),
    issuer: authAuthorityText(input.issuer, 2048),
    subject: authAuthorityText(input.subject),
    controllerIncarnation: authAuthorityText(input.controllerIncarnation, 256),
    targetRef: authAuthorityText(input.targetRef),
    evidence: evidence(input.evidence),
    enrolledAt: authAuthorityTime(input.enrolledAt),
  });
}
function statement(sql: string, params: readonly SqlParam[]): SqlStatement {
  return Object.freeze({ sql, params: Object.freeze([...params]) });
}
async function batch(sql: Sql, statements: readonly SqlStatement[]): Promise<void> {
  const result = await sql.batch(statements);
  if (result.length !== statements.length || result.some((item) => item.changes !== 1)) {
    // A real atomic Sql implementation is required. This reports an invalid
    // adapter result; a JavaScript throw cannot roll back an already committed batch.
    throw new AuthAuthorityStoreError("unavailable");
  }
}
function bindingInsert(
  principalId: string,
  incarnation: string,
  kind: SharedPrincipalBinding["kind"],
  selected: InitialSharedBinding,
  previous: string | null,
  guard: AuthCurrentnessPredicate,
): SqlStatement {
  return statement(
    `INSERT INTO shared_principal_bindings
    (binding_ref,issuer,subject,controller_incarnation,principal_id,principal_incarnation,
     target_ref,binding_kind,evidence_ref,evidence_digest,previous_binding_ref,enrolled_at)
    VALUES (?,?,?,?,CASE WHEN ${guard.sql} THEN ? ELSE NULL END,?,?,?,?,?,?,?)`,
    [
      selected.ref,
      selected.issuer,
      selected.subject,
      selected.controllerIncarnation,
      ...guard.params,
      principalId,
      incarnation,
      selected.targetRef,
      kind,
      selected.evidence.ref,
      selected.evidence.digest,
      previous,
      selected.enrolledAt,
    ],
  );
}
function anchorMatch(input: {
  readonly principalId: string;
  readonly incarnation: string;
  readonly kind: PrincipalIdentityKind;
  readonly subject: string;
  readonly createdAt: string;
  readonly origin: AuthAuthorityEvidence;
  readonly originKind: PrincipalAnchor["originKind"];
  readonly enrolledAt: string;
}): AuthCurrentnessPredicate {
  return Object.freeze({
    sql: `EXISTS (SELECT 1 FROM auth_principal_incarnations i JOIN principals p ON p.id=i.principal_id
      WHERE i.principal_id=? AND i.principal_incarnation=? AND i.identity_kind=?
        AND i.identity_subject=? AND i.principal_created_at=? AND i.origin_kind=?
        AND i.origin_ref=? AND i.origin_digest=? AND i.enrolled_at=? AND i.state='active'
        AND p.provider=i.identity_kind AND p.provider_subject=i.identity_subject
        AND p.created_at=i.principal_created_at)`,
    params: Object.freeze([
      input.principalId,
      input.incarnation,
      input.kind,
      input.subject,
      input.createdAt,
      input.originKind,
      input.origin.ref,
      input.origin.digest,
      input.enrolledAt,
    ]),
  });
}

/** A fixed constraint to embed in a same-primary mutation after all proof awaits. */
export function sharedPrincipalCurrentness(
  selected: SharedPrincipalBinding,
): AuthCurrentnessPredicate {
  const ref = authAuthorityText(selected.ref, 256);
  const params: readonly SqlParam[] = Object.freeze([
    ref,
    authAuthorityText(selected.principalId),
    authAuthorityText(selected.principalIncarnation, 256),
    authAuthorityText(selected.issuer, 2048),
    authAuthorityText(selected.subject),
    authAuthorityText(selected.controllerIncarnation, 256),
    authAuthorityText(selected.targetRef),
    authAuthorityText(selected.evidence.ref),
    authAuthorityDigest(selected.evidence.digest),
  ]);
  return Object.freeze({
    sql: `EXISTS (SELECT 1 FROM shared_principal_bindings b
      JOIN auth_principal_incarnations i ON i.principal_id=b.principal_id
        AND i.principal_incarnation=b.principal_incarnation
      JOIN principals p ON p.id=i.principal_id
      WHERE (((b.binding_ref=? AND (b.principal_id=? AND b.principal_incarnation=?)) AND ((b.issuer=? AND b.subject=?) AND (b.controller_incarnation=? AND b.target_ref=?))) AND ((b.evidence_ref=? AND (b.evidence_digest=? AND b.state='active')) AND ((i.state='active' AND p.provider=i.identity_kind) AND (p.provider_subject=i.identity_subject AND p.created_at=i.principal_created_at)))))`,
    params,
  });
}

/**
 * Fixed-Sql retained writer/reader for a future genuine Auth issuer. Its inputs
 * are storage constraints, not proof of identity. This module has no route,
 * enrollment callback, payer grant or runtime mount; schema adoption is separate.
 */
export function createSharedPrincipalAuthorityStore(options: { readonly sql: Sql }) {
  const { sql } = options;
  const readBinding = async (ref: string): Promise<SharedPrincipalBinding | null> => {
    const rows = await sql.query("SELECT * FROM shared_principal_bindings WHERE binding_ref=?", [
      authAuthorityText(ref, 256),
    ]);
    if (rows.length > 1) throw new AuthAuthorityStoreError("unavailable");
    return rows[0] ? bindingFrom(rows[0]) : null;
  };
  const requireBinding = async (ref: string): Promise<SharedPrincipalBinding> => {
    const found = await readBinding(ref);
    if (!found) throw new AuthAuthorityStoreError("unavailable");
    return found;
  };
  return {
    readBinding,
    async readAnchor(principalId: string): Promise<PrincipalAnchor | null> {
      const rows = await sql.query(
        "SELECT * FROM auth_principal_incarnations WHERE principal_id=?",
        [authAuthorityText(principalId)],
      );
      if (rows.length > 1) throw new AuthAuthorityStoreError("unavailable");
      return rows[0] ? anchorFrom(rows[0]) : null;
    },
    async findBinding(identity: {
      readonly issuer: string;
      readonly subject: string;
      readonly controllerIncarnation: string;
    }): Promise<SharedPrincipalBinding | null> {
      const captured = [
        authAuthorityText(identity.issuer, 2048),
        authAuthorityText(identity.subject),
        authAuthorityText(identity.controllerIncarnation, 256),
      ];
      const rows = await sql.query(
        "SELECT * FROM shared_principal_bindings WHERE issuer=? AND subject=? AND controller_incarnation=?",
        captured,
      );
      if (rows.length > 1) throw new AuthAuthorityStoreError("unavailable");
      return rows[0] ? bindingFrom(rows[0]) : null;
    },
    async createFresh(input: FreshSharedPrincipal): Promise<SharedPrincipalBinding> {
      const principalId = authAuthorityText(input.principalId);
      const incarnation = authAuthorityText(input.principalIncarnation, 256);
      const createdAt = authAuthorityTime(input.createdAt);
      const origin = evidence(input.origin);
      const selected = initial(input.binding);
      const guard = anchorMatch({
        principalId,
        incarnation,
        kind: "shared-account",
        subject: selected.ref,
        createdAt,
        origin,
        originKind: "fresh-shared",
        enrolledAt: selected.enrolledAt,
      });
      await batch(sql, [
        statement(
          `INSERT INTO principals (id,provider,provider_subject,email,display_name,created_at)
          VALUES (?,'shared-account',?,NULL,NULL,?)`,
          [principalId, selected.ref, createdAt],
        ),
        statement(
          `INSERT INTO auth_principal_incarnations
          (principal_id,principal_incarnation,identity_kind,identity_subject,principal_created_at,
           origin_kind,origin_ref,origin_digest,enrolled_at)
          VALUES (?,?,'shared-account',?,?,'fresh-shared',?,?,?)`,
          [
            principalId,
            incarnation,
            selected.ref,
            createdAt,
            origin.ref,
            origin.digest,
            selected.enrolledAt,
          ],
        ),
        bindingInsert(principalId, incarnation, "fresh-shared", selected, null, guard),
      ]);
      return await requireBinding(selected.ref);
    },
    async bindLegacy(input: ProvedLegacyPrincipal): Promise<SharedPrincipalBinding> {
      const principalId = authAuthorityText(input.principalId);
      const incarnation = authAuthorityText(input.principalIncarnation, 256);
      const provider = input.provider;
      if (provider !== "google" && provider !== "github" && provider !== "takos-id")
        throw new AuthAuthorityStoreError("invalid");
      const subject = authAuthorityText(input.providerSubject);
      // Retained creation text is an exact historical value, not a new clock.
      const createdAt = authAuthorityText(input.createdAt);
      const origin = evidence(input.origin);
      const selected = initial(input.binding);
      const guard = anchorMatch({
        principalId,
        incarnation,
        kind: provider,
        subject,
        createdAt,
        origin,
        originKind: "proved-legacy",
        enrolledAt: selected.enrolledAt,
      });
      await batch(sql, [
        statement(
          `INSERT INTO auth_principal_incarnations
          (principal_id,principal_incarnation,identity_kind,identity_subject,principal_created_at,
           origin_kind,origin_ref,origin_digest,enrolled_at)
          SELECT id,?,provider,provider_subject,created_at,'proved-legacy',?,?,? FROM principals
          WHERE id=? AND provider=? AND provider_subject=? AND created_at=?`,
          [
            incarnation,
            origin.ref,
            origin.digest,
            selected.enrolledAt,
            principalId,
            provider,
            subject,
            createdAt,
          ],
        ),
        bindingInsert(principalId, incarnation, "proved-legacy", selected, null, guard),
      ]);
      return await requireBinding(selected.ref);
    },
    async appendSuccessor(
      predecessor: SharedPrincipalBinding,
      next: {
        readonly ref: string;
        readonly controllerIncarnation: string;
        readonly evidence: AuthAuthorityEvidence;
        readonly enrolledAt: string;
      },
    ): Promise<SharedPrincipalBinding> {
      if (predecessor.state !== "retired" || !predecessor.terminal)
        throw new AuthAuthorityStoreError("conflict");
      const old = Object.freeze({
        ...initial({ ...predecessor, evidence: predecessor.evidence }),
        principalId: authAuthorityText(predecessor.principalId),
        principalIncarnation: authAuthorityText(predecessor.principalIncarnation, 256),
        kind: predecessor.kind,
        previousRef:
          predecessor.previousRef === null ? null : authAuthorityText(predecessor.previousRef, 256),
        terminal: terminal(predecessor.terminal),
      });
      if (old.kind !== "fresh-shared" && old.kind !== "proved-legacy")
        throw new AuthAuthorityStoreError("invalid");
      const selected = initial({
        ...old,
        ref: next.ref,
        controllerIncarnation: next.controllerIncarnation,
        evidence: next.evidence,
        enrolledAt: next.enrolledAt,
      });
      const guard = Object.freeze({
        sql: `EXISTS (SELECT 1 FROM shared_principal_bindings old
          WHERE old.binding_ref=? AND old.principal_id=? AND old.principal_incarnation=?
            AND old.issuer=? AND old.subject=? AND old.target_ref=? AND old.binding_kind=?
            AND old.controller_incarnation=? AND old.evidence_ref=? AND old.evidence_digest=?
            AND old.previous_binding_ref IS ? AND old.enrolled_at=? AND old.state='retired'
            AND old.terminal_reason=? AND old.terminal_at=? AND old.terminal_ref=?)`,
        params: Object.freeze([
          old.ref,
          old.principalId,
          old.principalIncarnation,
          old.issuer,
          old.subject,
          old.targetRef,
          old.kind,
          old.controllerIncarnation,
          old.evidence.ref,
          old.evidence.digest,
          old.previousRef,
          old.enrolledAt,
          old.terminal.reason,
          old.terminal.at,
          old.terminal.ref,
        ]),
      });
      await batch(sql, [
        bindingInsert(
          old.principalId,
          old.principalIncarnation,
          old.kind,
          selected,
          old.ref,
          guard,
        ),
      ]);
      return await requireBinding(selected.ref);
    },
    async retireBinding(
      ref: string,
      expectedEvidence: AuthAuthorityEvidence,
      closure: AuthAuthorityTerminal,
    ): Promise<SharedPrincipalBinding> {
      const id = authAuthorityText(ref, 256);
      const expected = evidence(expectedEvidence);
      const closed = terminal(closure);
      const result = await sql.run(
        `UPDATE shared_principal_bindings
        SET state='retired',terminal_reason=?,terminal_at=?,terminal_ref=?
        WHERE binding_ref=? AND evidence_ref=? AND evidence_digest=? AND state='active'`,
        [closed.reason, closed.at, closed.ref, id, expected.ref, expected.digest],
      );
      if (result.changes !== 1) throw new AuthAuthorityStoreError("conflict");
      return await requireBinding(id);
    },
  };
}
