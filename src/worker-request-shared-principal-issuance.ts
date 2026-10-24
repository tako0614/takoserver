import {
  type Auth103NativeRequestOrigin,
  auth103NativeRequestCurrentness,
  readAuth103NativeRequestOrigin,
  readAuth103NativeRpRegistrationOriginal,
} from "./auth103-native-origin-source.ts";
import { readAuth103SourceClock } from "./auth103-source-clock.ts";
import {
  type CredentialAuthorityOrigin,
  createCredentialAuthorityClassStore,
  type RpAuthorityIdentity,
} from "./credential-authority-class.ts";
import { bytesDigest } from "./json.ts";
import { type Row, type Sql, SqlError, type SqlStatement, type SqlWrite } from "./ports.ts";
import {
  readSharedAuthFreshSessionWrite,
  readSharedAuthVerifiedPrincipalInput,
  type SharedAuthPrincipalProjection,
  type SharedAuthVerifiedPrincipalData,
} from "./shared-auth-session.ts";
import type { OidcSessionRecord, SharedAuthSessionStore } from "./shared-auth-session-store.ts";
import {
  AuthAuthorityStoreError,
  createSharedPrincipalAuthorityStore,
  type FreshSharedPrincipal,
} from "./shared-principal-authority.ts";
import {
  assertWorkerRequestBackingOrigin,
  captureWorkerSharedAuthStaging,
  createWorkerRequestConsumers,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  readWorkerRequestNativeInitializationInputs,
  type WorkerRequestConsumers,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";
import {
  captureWorkerRequestAuthenticatedRpUserBindingOriginal,
  type WorkerRequestAuthenticatedRpUserBindingOriginal,
} from "./worker-request-financial-auth-original.ts";
import {
  isWorkspaceBillingOrganization,
  workspaceBillingOrganizationOwnerGuard,
  workspaceBillingOrganizationStatements,
} from "./workspace-billing-organization.ts";

/** Storage contribution, not a verified RP subject or qualified human capture. */
export interface FreshSharedRpIssuanceData {
  readonly principal: FreshSharedPrincipal;
  readonly credential: CredentialAuthorityOrigin;
  readonly rp: RpAuthorityIdentity;
  readonly organizationId: string;
  readonly session: OidcSessionRecord;
}

/**
 * The retained principal and binding a returning subject's later login reuses.
 * DATA only: resolution grants nothing; the retained issuance re-proves the
 * binding's currentness inside its own batch.
 */
export interface RetainedSharedRpPrincipal {
  readonly principalId: string;
  readonly principalIncarnation: string;
  readonly bindingRef: string;
  readonly targetRef: string;
  readonly issuer: string;
  readonly subject: string;
}

/** Storage contribution for a returning subject; not a verified RP subject. */
export interface RetainedSharedRpIssuanceData {
  readonly principal: RetainedSharedRpPrincipal;
  readonly credential: CredentialAuthorityOrigin;
  readonly rp: RpAuthorityIdentity;
  readonly organizationId: string;
  readonly session: OidcSessionRecord;
}

function unavailable(): never {
  throw new AuthAuthorityStoreError("unavailable");
}

/**
 * Closed diagnostic steps of one fresh RP session write: the qualified store's
 * own checks, then the issuance store's checks around its single batch.
 * DATA only; a step is never consulted for a decision.
 */
type SessionWriteFailureStep =
  | "attempted"
  | "write_original"
  | "origin_current"
  | "origin_recheck"
  | "phase"
  | "native_target"
  | "issuance_digest"
  | "consumers"
  | "issuance_attempted"
  | "issuance_input"
  | "organization_derivation"
  | "issuance_statements"
  | "native_currentness"
  | "batch"
  | "batch_ack"
  | "organization_ack"
  | "fixed_ack"
  | "pair_ack"
  | "row_postimage"
  | "principal_postimage"
  | "issuance_result"
  | "post_current"
  | "post_ack";

/**
 * Private diagnostic marker. It carries only the closed step and a closed code
 * derived from this module's own error classes: no message, stack, name, ID,
 * digest, SQL text or row. The caller rethrows the same error unchanged, and a
 * failing logger cannot alter that.
 */
function reportSessionWriteFailure(step: SessionWriteFailureStep, error: unknown): void {
  try {
    let code:
      | "sql_unavailable"
      | "sql_constraint"
      | "sql_invalid"
      | "store_invalid"
      | "store_conflict"
      | "store_unavailable"
      | "other" = "other";
    if (error instanceof SqlError) {
      switch (error.code) {
        case "unavailable":
          code = "sql_unavailable";
          break;
        case "constraint":
          code = "sql_constraint";
          break;
        case "invalid":
          code = "sql_invalid";
          break;
      }
    } else if (error instanceof AuthAuthorityStoreError) {
      switch (error.code) {
        case "invalid":
          code = "store_invalid";
          break;
        case "conflict":
          code = "store_conflict";
          break;
        case "unavailable":
          code = "store_unavailable";
          break;
      }
    }
    console.error(
      JSON.stringify({ marker: "takoserver.shared_auth.session_write.failure.v1", step, code }),
    );
  } catch {
    // A private diagnostic cannot change the write refusal, cleanup or response.
  }
}
function invalid(): never {
  throw new AuthAuthorityStoreError("invalid");
}
function exactDigest(value: string): value is `sha256:${string}` {
  return /^sha256:[0-9a-f]{64}$/u.test(value);
}

/** Own DATA only; snapshot all command/result bytes before any subsequent await. */
function snapshot<T>(input: T): T {
  let nodes = 0;
  const copy = (value: unknown, depth: number): unknown => {
    if (++nodes > 512 || depth > 12) return invalid();
    if (value === null || typeof value === "boolean") return value;
    if (typeof value === "number") return Number.isSafeInteger(value) ? value : invalid();
    if (typeof value === "string") {
      if (new TextEncoder().encode(value).byteLength > 262144) return invalid();
      return value;
    }
    if (typeof value !== "object" || value === null) return invalid();
    const proto = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
      if (proto !== Array.prototype || Reflect.ownKeys(value).length !== value.length + 1)
        return invalid();
      return Object.freeze(
        Array.from({ length: value.length }, (_, index) => {
          const d = Object.getOwnPropertyDescriptor(value, String(index));
          if (!d || !("value" in d)) return invalid();
          return copy(d.value, depth + 1);
        }),
      );
    }
    if (proto !== Object.prototype && proto !== null) return invalid();
    const result: Record<string, unknown> = {};
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string") return invalid();
      const d = Object.getOwnPropertyDescriptor(value, key);
      if (!d || !("value" in d) || !d.enumerable) return invalid();
      Object.defineProperty(result, key, {
        value: copy(d.value, depth + 1),
        enumerable: true,
      });
    }
    return Object.freeze(result);
  };
  return copy(input, 0) as T;
}
function exact(row: Row | undefined, expected: Readonly<Row>): Readonly<Row> {
  if (!row || Object.keys(row).sort().join("\0") !== Object.keys(expected).sort().join("\0"))
    return unavailable();
  for (const key of Object.keys(expected)) if (row[key] !== expected[key]) return unavailable();
  return Object.freeze({ ...row });
}
function batchMethod(sql: Sql): Sql["batch"] {
  const d = Object.getOwnPropertyDescriptor(sql, "batch");
  if (!d || !("value" in d) || typeof d.value !== "function") return unavailable();
  return d.value;
}

/**
 * One immutable NEW-only fixed 3+2 contribution. No arbitrary SQL/callback is
 * accepted. The caller must be the future genuine Root issuer; plain inputs and
 * this returned DATA never establish RP verification, human origin or admission.
 */
/** The fixed name of a shared-auth personal Workspace's billing Organization. */
const WORKSPACE_BILLING_ORGANIZATION_NAME = "Personal workspace";

function createSharedRpPrincipalIssuanceStoreInternal(
  options: {
    readonly sql: Sql;
    /**
     * The served realm's billing authority: the tuple's Organization must be
     * the workspace-billing derivation for it, and the Organization, its owner
     * membership and the Workspace binding are materialized in the same
     * issuance batch. Only an explicit null (no hosted billing realm) skips
     * both, so a caller cannot drop them by omission.
     */
    readonly workspaceBillingAuthority: string | null;
  },
  nativeCurrentness: (() => ReturnType<typeof auth103NativeRequestCurrentness>) | null,
) {
  const sql = options.sql;
  const originalBatch = batchMethod(sql);
  let attempted = false;
  const assertSql = () => {
    if (batchMethod(sql) !== originalBatch) unavailable();
  };
  /** Organization statements for this owner and the exact Org row they insert. */
  async function organizationFor(
    organizationId: string,
    r: RpAuthorityIdentity,
    n: OidcSessionRecord,
    principalId: string,
    mode: "materialize" | "owner-guard",
  ): Promise<{
    readonly statements: readonly SqlStatement[];
    readonly image: Readonly<Row> | null;
  }> {
    const authority = options.workspaceBillingAuthority;
    if (authority === null) return Object.freeze({ statements: Object.freeze([]), image: null });
    if (
      !(await isWorkspaceBillingOrganization(authority, {
        workspaceRef: r.workspaceRef,
        organizationId,
      }))
    )
      return invalid();
    let statements: readonly SqlStatement[];
    let image: Readonly<Row>;
    try {
      const createdAt = new Date(n.createdAt).toISOString();
      const materialization = {
        organizationId,
        workspaceRef: r.workspaceRef,
        principalId,
        name: WORKSPACE_BILLING_ORGANIZATION_NAME,
        createdAt,
      };
      statements =
        mode === "materialize"
          ? workspaceBillingOrganizationStatements(materialization)
          : Object.freeze([workspaceBillingOrganizationOwnerGuard(materialization)]);
      image = Object.freeze({
        id: organizationId,
        name: WORKSPACE_BILLING_ORGANIZATION_NAME,
        owner_principal_id: principalId,
        created_at: createdAt,
      });
    } catch {
      return invalid();
    }
    if (statements.length !== (mode === "materialize" ? 4 : 1)) return invalid();
    return Object.freeze({ statements, image: mode === "materialize" ? image : null });
  }
  /** The mandatory companion with the native source predicate in its CASE. */
  function nativeCompanion(companion: SqlStatement): SqlStatement {
    if (nativeCurrentness === null) return companion;
    const current = nativeCurrentness();
    const marker = "CASE WHEN ";
    const params = companion.params;
    if (
      !companion.sql.startsWith("INSERT INTO credential_authority_classes ") ||
      !companion.sql.endsWith(" RETURNING *") ||
      companion.sql.split(marker).length !== 2 ||
      !params ||
      params.length < 7
    )
      return unavailable();
    // The fixed class recipe places six base fields before the guarded
    // principal_id. Keep the native source predicate in that mandatory last
    // statement, so stale source rolls back the entire batch.
    return Object.freeze({
      sql: companion.sql.replace(marker, `${marker}(${current.sql}) AND `),
      params: Object.freeze([...params.slice(0, 6), ...current.params, ...params.slice(6)]),
    });
  }
  /**
   * Organization ACKs, in statement order. D1 reports each statement's changes
   * as its total_changes() delta, which also counts rows written by triggers.
   * Of these four tables only orgs has a writing trigger: Root 0105's AFTER
   * INSERT birth capture appends Financial-owned observations (zero, one, or
   * one per open capture) whenever an Org row is inserted. So:
   * - the Org INSERT proves its own base-row effect by RETURNING: no row means
   *   nothing was inserted and therefore no trigger ran (changes must be
   *   exactly 0); one row must be this exact Org, and changes counts it plus
   *   any capture rows (at least 1);
   * - the membership and Workspace binding INSERTs return no rows and change
   *   exactly 0 or 1 row (their tables carry no writing trigger);
   * - the final guard returns no rows and changes none: it aborts the batch
   *   through a CHECK unless the Organization is consistent.
   */
  function organizationAcknowledged(
    writes: readonly SqlWrite[],
    statements: readonly SqlStatement[],
    image: Readonly<Row> | null,
  ): boolean {
    if (writes.length !== statements.length) return false;
    return !writes.some((w, index) => {
      if (
        typeof w !== "object" ||
        w === null ||
        Array.isArray(w) ||
        Object.keys(w).sort().join(",") !== "changes,rows" ||
        !Number.isSafeInteger(w.changes) ||
        w.changes < 0 ||
        !Array.isArray(w.rows)
      )
        return true;
      if (index === 0) {
        if (w.rows.length === 0) return w.changes !== 0;
        if (w.rows.length !== 1 || w.changes < 1 || image === null) return true;
        exact(w.rows[0], image);
        return false;
      }
      if (w.rows.length !== 0) return true;
      return index === statements.length - 1 ? w.changes !== 0 : w.changes > 1;
    });
  }
  /** Each returning INSERT changed its row and returned exactly one plain row. */
  function returnedOne(writes: readonly SqlWrite[]): boolean {
    return !writes.some(
      (w) =>
        typeof w !== "object" ||
        w === null ||
        Array.isArray(w) ||
        Object.keys(w).sort().join(",") !== "changes,rows" ||
        !Number.isSafeInteger(w.changes) ||
        w.changes <= 0 ||
        !Array.isArray(w.rows) ||
        w.rows.length !== 1 ||
        typeof w.rows[0] !== "object" ||
        w.rows[0] === null ||
        Array.isArray(w.rows[0]),
    );
  }
  /** The exact session and credential class rows of the fixed RP pair. */
  function exactPairRows(
    session: SqlWrite | undefined,
    credentialClass: SqlWrite | undefined,
    c: CredentialAuthorityOrigin,
    r: RpAuthorityIdentity,
    n: OidcSessionRecord,
    organizationId: string,
  ): void {
    exact(session?.rows[0], {
      digest: n.digest,
      account_id: n.accountId,
      principal_id: n.principalId,
      workspace_id: n.workspaceId,
      payload: n.payload,
      created_at: n.createdAt,
      last_used_at: n.lastUsedAt,
      absolute_expires_at: n.absoluteExpiresAt,
      grant_checked_at: n.grantCheckedAt,
      version: 0,
      status: "active",
    });
    exact(credentialClass?.rows[0], {
      authority_ref: c.ref,
      credential_incarnation: c.incarnation,
      class: "official-shared-rp-session",
      backend: "shared-rp-session",
      target_ref: c.targetRef,
      organization_id: organizationId,
      principal_id: c.principalId,
      principal_incarnation: c.principalIncarnation,
      issuance_ref: c.issuanceRef,
      issuance_digest: c.issuanceDigest,
      issued_at: c.issuedAt,
      token_id: null,
      token_digest: null,
      token_kind: null,
      token_scopes_json: null,
      token_created_at: null,
      principal_binding_ref: r.principalBindingRef,
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
      workspace_id: r.workspaceId,
      workspace_ref: r.workspaceRef,
      state: "active",
      terminal_reason: null,
      terminal_at: null,
      terminal_ref: null,
    });
  }
  return Object.freeze({
    /** `mark` records diagnostic progress only; the caller reports and rethrows. */
    async issueFreshOnce(
      input: FreshSharedRpIssuanceData,
      mark: (step: SessionWriteFailureStep) => void,
    ) {
      if (attempted) return unavailable();
      mark("issuance_input");
      const data = snapshot(input);
      if (Object.keys(data).sort().join(",") !== "credential,organizationId,principal,rp,session")
        return invalid();
      const p = data.principal;
      const c = data.credential;
      const r = data.rp;
      const n = data.session;
      if (
        p.principalId !== c.principalId ||
        p.principalIncarnation !== c.principalIncarnation ||
        p.binding.ref !== r.principalBindingRef ||
        p.binding.targetRef !== c.targetRef ||
        p.binding.issuer !== r.issuer ||
        p.binding.subject !== r.subject ||
        r.subject !== r.accountId ||
        n.principalId !== p.principalId
      )
        return invalid();
      mark("organization_derivation");
      const organization = await organizationFor(
        data.organizationId,
        r,
        n,
        p.principalId,
        "materialize",
      );
      mark("issuance_statements");
      const pair = createCredentialAuthorityClassStore({
        sql,
      }).sharedRpNewSessionIssuanceStatements(c, r, data.organizationId, n);
      let pairRows: readonly SqlWrite[] | null = null;
      const facade: Sql = Object.freeze({
        async query() {
          return unavailable();
        },
        async run() {
          return unavailable();
        },
        async batch(principalStatements: readonly SqlStatement[]) {
          if (attempted || principalStatements.length !== 3) return unavailable();
          assertSql();
          attempted = true; // No retry after invocation/unknown; not durable phase permission.
          mark("native_currentness");
          const companion = nativeCompanion(pair[1]);
          // The Organization statements follow the companion, never between
          // pair[0] and the companion whose guard reads the statement before it.
          const fixedFive = Object.freeze([...principalStatements, pair[0], companion]);
          const statements = Object.freeze([...fixedFive, ...organization.statements]);
          if (statements.some((statement) => (statement.params?.length ?? 0) > 100))
            return unavailable();
          mark("batch");
          const original: readonly SqlWrite[] = await Reflect.apply(originalBatch, sql, [
            statements,
          ]);
          mark("batch_ack");
          assertSql();
          let writes: readonly SqlWrite[];
          try {
            const all = snapshot(original);
            if (!Array.isArray(all) || all.length !== 5 + organization.statements.length)
              return unavailable();
            mark("organization_ack");
            if (
              !organizationAcknowledged(all.slice(5), organization.statements, organization.image)
            )
              return unavailable();
            const candidate = all.slice(0, 5);
            mark("fixed_ack");
            if (candidate.length !== 5 || !returnedOne(candidate)) return unavailable();
            writes = candidate;
          } catch {
            return unavailable();
          }
          mark("row_postimage");
          exactPairRows(writes[3], writes[4], c, r, n, data.organizationId);
          pairRows = writes.slice(3);
          // The fixed3 recipe validates its own returned rows after this.
          mark("principal_postimage");
          return Object.freeze(writes.slice(0, 3));
        },
      });
      // Existing unchanged fixed3 recipe and exact full RETURNING validators.
      const principal = await createSharedPrincipalAuthorityStore({
        sql: facade,
      }).createFreshWithPostimages(p);
      mark("issuance_result");
      assertSql();
      if (pairRows === null) return unavailable();
      return Object.freeze({
        principal,
        session: snapshot(n),
        credential: snapshot(c),
        rp: snapshot(r),
        organizationId: data.organizationId,
      });
    },
    /**
     * A returning subject's later login: the fixed RP pair (NEW session and
     * NEW credential class) on its EXISTING principal and binding, followed
     * (when a realm is served) by the Organization owner guard alone. No
     * principal, incarnation, binding or Organization row is written. The binding's
     * currentness (active, its anchor active, exact principal incarnation,
     * target, issuer and subject) is re-proved inside this batch by the
     * companion's existing guard and the class insert trigger, so a binding
     * retired or crossed after resolution aborts the whole batch.
     * `mark` records diagnostic progress only; the caller reports and rethrows.
     */
    async issueRetainedOnce(
      input: RetainedSharedRpIssuanceData,
      mark: (step: SessionWriteFailureStep) => void,
    ) {
      if (attempted) return unavailable();
      mark("issuance_input");
      const data = snapshot(input);
      if (Object.keys(data).sort().join(",") !== "credential,organizationId,principal,rp,session")
        return invalid();
      const p = data.principal;
      const c = data.credential;
      const r = data.rp;
      const n = data.session;
      if (
        Object.keys(p).sort().join(",") !==
          "bindingRef,issuer,principalId,principalIncarnation,subject,targetRef" ||
        p.principalId !== c.principalId ||
        p.principalIncarnation !== c.principalIncarnation ||
        p.bindingRef !== r.principalBindingRef ||
        p.targetRef !== c.targetRef ||
        p.issuer !== r.issuer ||
        p.subject !== r.subject ||
        r.subject !== r.accountId ||
        n.principalId !== p.principalId
      )
        return invalid();
      mark("organization_derivation");
      // A returning owner sends only the owner guard: no Organization row can
      // be written, and a missing, foreign or differently bound Org aborts.
      const organization = await organizationFor(
        data.organizationId,
        r,
        n,
        p.principalId,
        "owner-guard",
      );
      mark("issuance_statements");
      const pair = createCredentialAuthorityClassStore({
        sql,
      }).sharedRpNewSessionIssuanceStatements(c, r, data.organizationId, n);
      if (attempted) return unavailable();
      assertSql();
      attempted = true; // No retry after invocation/unknown; not durable phase permission.
      mark("native_currentness");
      const companion = nativeCompanion(pair[1]);
      // The companion's guard reads the session INSERT immediately before it.
      const statements = Object.freeze([pair[0], companion, ...organization.statements]);
      if (statements.some((statement) => (statement.params?.length ?? 0) > 100))
        return unavailable();
      mark("batch");
      const original: readonly SqlWrite[] = await Reflect.apply(originalBatch, sql, [statements]);
      mark("batch_ack");
      assertSql();
      let writes: readonly SqlWrite[];
      try {
        const all = snapshot(original);
        if (!Array.isArray(all) || all.length !== 2 + organization.statements.length)
          return unavailable();
        mark("organization_ack");
        // The owner guard (when a realm is served) returns no row and changes none.
        if (
          all
            .slice(2)
            .some(
              (w) =>
                typeof w !== "object" ||
                w === null ||
                Array.isArray(w) ||
                Object.keys(w).sort().join(",") !== "changes,rows" ||
                w.changes !== 0 ||
                !Array.isArray(w.rows) ||
                w.rows.length !== 0,
            )
        )
          return unavailable();
        const candidate = all.slice(0, 2);
        mark("pair_ack");
        if (candidate.length !== 2 || !returnedOne(candidate)) return unavailable();
        writes = candidate;
      } catch {
        return unavailable();
      }
      mark("row_postimage");
      exactPairRows(writes[0], writes[1], c, r, n, data.organizationId);
      mark("issuance_result");
      return Object.freeze({
        principal: snapshot(p),
        session: snapshot(n),
        credential: snapshot(c),
        rp: snapshot(r),
        organizationId: data.organizationId,
      });
    },
  });
}

export function createSharedRpPrincipalIssuanceStore(options: {
  readonly sql: Sql;
  readonly workspaceBillingAuthority: string | null;
}) {
  const store = createSharedRpPrincipalIssuanceStoreInternal(options, null);
  // Private diagnostic progress only; the same error is rethrown unchanged.
  async function reported<T>(
    run: (mark: (step: SessionWriteFailureStep) => void) => Promise<T>,
  ): Promise<T> {
    let step: SessionWriteFailureStep = "issuance_attempted";
    try {
      return await run((next) => {
        step = next;
      });
    } catch (error) {
      reportSessionWriteFailure(step, error);
      throw error;
    }
  }
  return Object.freeze({
    async issueFreshOnce(input: FreshSharedRpIssuanceData) {
      return await reported((mark) => store.issueFreshOnce(input, mark));
    },
    async issueRetainedOnce(input: RetainedSharedRpIssuanceData) {
      return await reported((mark) => store.issueRetainedOnce(input, mark));
    },
  });
}

/**
 * Selects the binding a returning subject's fresh callback may reuse, from
 * retained rows only. DATA only: it grants nothing, and the retained issuance
 * re-proves the same binding inside its batch.
 *
 * - No binding for the exact (issuer, subject): null, so the callback may
 *   enroll a fresh principal (the Auth103 binding trigger still refuses a
 *   concurrent first enrollment).
 * - Exactly one binding, the subject's root fresh-shared binding, active with
 *   no terminal state, for the current native target, whose anchor is active
 *   with the same incarnation and origin: that principal and binding.
 * - Anything else (a retired binding, any successor or proved-legacy
 *   binding, more than one binding, another target, an inactive or mismatched
 *   anchor, or drift between two reads): refused. A retired subject is never
 *   re-enrolled; successor and legacy bindings are separate authority actions.
 */
export async function resolveSharedRpSubjectBinding(
  sql: Sql,
  identity: { readonly issuer: string; readonly subject: string; readonly targetRef: string },
): Promise<RetainedSharedRpPrincipal | null> {
  const principals = createSharedPrincipalAuthorityStore({ sql });
  const read = async () => {
    const bindings = await principals.readSubjectBindings(identity);
    if (bindings.length === 0) return null;
    // Only the subject's one root fresh-shared binding is reusable. Successor
    // and proved-legacy bindings are separate authority actions.
    const binding = bindings[0];
    if (
      bindings.length !== 1 ||
      !binding ||
      binding.kind !== "fresh-shared" ||
      binding.previousRef !== null ||
      binding.state !== "active" ||
      binding.terminal !== null ||
      binding.issuer !== identity.issuer ||
      binding.subject !== identity.subject ||
      binding.targetRef !== identity.targetRef
    )
      return unavailable();
    const anchor = await principals.readAnchor(binding.principalId);
    if (
      anchor?.state !== "active" ||
      anchor.terminal !== null ||
      anchor.principalId !== binding.principalId ||
      anchor.incarnation !== binding.principalIncarnation ||
      anchor.originKind !== binding.kind ||
      anchor.verificationDomain !== null ||
      (anchor.originKind === "fresh-shared" && anchor.identitySubject !== binding.ref)
    )
      return unavailable();
    return { binding, anchor };
  };
  const first = await read();
  if (first === null) return null;
  // Re-read the same retained rows to detect observed drift. Currentness at
  // the write is proved by the issuing batch itself, not by these reads.
  const again = await read();
  if (again === null || JSON.stringify(again) !== JSON.stringify(first)) return unavailable();
  return Object.freeze({
    principalId: first.binding.principalId,
    principalIncarnation: first.binding.principalIncarnation,
    bindingRef: first.binding.ref,
    targetRef: first.binding.targetRef,
    issuer: first.binding.issuer,
    subject: first.binding.subject,
  });
}

/** Bind the contribution to the actual completed common request graph, not caller Sql. */
export function createWorkerRequestSharedRpIssuanceContribution(connection: WorkerRequestSql) {
  const inputs = readWorkerRequestFinancialInputs(connection);
  const consumers = readWorkerRequestConsumers(connection);
  const store = createSharedRpPrincipalIssuanceStore({
    sql: inputs.sql,
    workspaceBillingAuthority: consumers.realm.billingAuthority,
  });
  const assertOrigin = () => {
    if (
      readWorkerRequestFinancialInputs(connection) !== inputs ||
      readWorkerRequestConsumers(connection) !== consumers
    )
      unavailable();
  };
  return Object.freeze({
    async issueFreshOnce(input: FreshSharedRpIssuanceData) {
      assertOrigin();
      const result = await store.issueFreshOnce(input);
      assertOrigin();
      return result;
    },
  });
}

/** Original verified RP observation on the completed original request graph.
 * DATA only: installed103/registration, a distinct human and policy Clock remain
 * separate Root obligations. No new capture/authority map is created here.
 */
export interface WorkerRequestVerifiedSharedPrincipalInputs {
  readonly inputs: ReturnType<typeof readWorkerRequestFinancialInputs>;
  readonly principalOriginal: SharedAuthVerifiedPrincipalData;
}

export function readWorkerRequestVerifiedSharedPrincipalInputs(
  connection: WorkerRequestSql,
  original: unknown,
): WorkerRequestVerifiedSharedPrincipalInputs | null {
  assertWorkerRequestBackingOrigin(connection);
  const inputs = readWorkerRequestFinancialInputs(connection);
  const consumers = readWorkerRequestConsumers(connection);
  const receiver = consumers.sharedAuth;
  const principalOriginal = readSharedAuthVerifiedPrincipalInput(receiver, original);
  assertWorkerRequestBackingOrigin(connection);
  if (!principalOriginal) return null;
  if (
    readWorkerRequestFinancialInputs(connection) !== inputs ||
    readWorkerRequestConsumers(connection) !== consumers ||
    readSharedAuthVerifiedPrincipalInput(receiver, original) !== principalOriginal
  )
    return unavailable();
  return Object.freeze({ inputs, principalOriginal });
}

/** A fresh enrollment, or a returning subject's retained principal and binding. */
type PendingRpPrincipal =
  | { readonly kind: "fresh"; readonly fresh: FreshSharedPrincipal }
  | {
      readonly kind: "retained";
      readonly retained: RetainedSharedRpPrincipal;
      readonly issuedAt: string;
    };

function pendingPrincipal(principal: PendingRpPrincipal) {
  return principal.kind === "fresh"
    ? Object.freeze({
        principalId: principal.fresh.principalId,
        principalIncarnation: principal.fresh.principalIncarnation,
        bindingRef: principal.fresh.binding.ref,
        targetRef: principal.fresh.binding.targetRef,
        issuedAt: principal.fresh.createdAt,
      })
    : Object.freeze({
        principalId: principal.retained.principalId,
        principalIncarnation: principal.retained.principalIncarnation,
        bindingRef: principal.retained.bindingRef,
        targetRef: principal.retained.targetRef,
        issuedAt: principal.issuedAt,
      });
}

interface PendingFreshRpIssuance {
  readonly original: Parameters<SharedAuthPrincipalProjection["resolve"]>[1];
  readonly held: WorkerRequestVerifiedSharedPrincipalInputs;
  readonly nativeOrigin: Auth103NativeRequestOrigin;
  readonly principal: PendingRpPrincipal;
  readonly registration: NonNullable<ReturnType<typeof readAuth103NativeRpRegistrationOriginal>>;
  readonly credentialRef: string;
  readonly credentialIncarnation: string;
  readonly issuanceRef: string;
}

const freshRpIssuance = new WeakMap<WorkerRequestSql, PendingFreshRpIssuance>();
const freshRpStores = new WeakMap<WorkerRequestSql, Auth103NativeRequestOrigin>();

function originalFreshCurrent(connection: WorkerRequestSql, pending: PendingFreshRpIssuance): void {
  assertWorkerRequestBackingOrigin(connection);
  const held = readWorkerRequestVerifiedSharedPrincipalInputs(connection, pending.original);
  const native = readAuth103NativeRequestOrigin(pending.nativeOrigin, connection);
  const registration = readAuth103NativeRpRegistrationOriginal(pending.nativeOrigin, connection);
  if (
    freshRpIssuance.get(connection) !== pending ||
    !held ||
    held.inputs !== pending.held.inputs ||
    held.principalOriginal !== pending.held.principalOriginal ||
    !native ||
    !registration ||
    registration.registrationRef !== pending.registration.registrationRef ||
    registration.registrationDigest !== pending.registration.registrationDigest ||
    readAuth103SourceClock(held.inputs.clock) === null
  )
    unavailable();
}

/** Qualified constructor's exact original store, never a caller-selected issuer. */
export function createWorkerRequestSharedRpFreshSessionStore(
  connection: WorkerRequestSql,
  ordinary: SharedAuthSessionStore,
  nativeOrigin: Auth103NativeRequestOrigin,
): Readonly<{
  store: SharedAuthSessionStore;
  bindReceiver(receiver: WorkerRequestConsumers["sharedAuth"]): void;
}> {
  assertWorkerRequestBackingOrigin(connection);
  const native = readAuth103NativeRequestOrigin(nativeOrigin, connection);
  const registration = readAuth103NativeRpRegistrationOriginal(nativeOrigin, connection);
  if (
    !native ||
    !registration ||
    readAuth103SourceClock(readWorkerRequestNativeInitializationInputs(connection).clock) ===
      null ||
    freshRpStores.has(connection)
  )
    return unavailable();
  const originalCreate = Object.getOwnPropertyDescriptor(ordinary, "createSession");
  if (!originalCreate || !("value" in originalCreate) || typeof originalCreate.value !== "function")
    return unavailable();
  let receiver: WorkerRequestConsumers["sharedAuth"] | null = null;
  let attempted = false;
  const unreported = Object.freeze({
    /** `mark` records diagnostic progress only; createSession reports and rethrows. */
    async createSession(
      record: OidcSessionRecord,
      mark: (step: SessionWriteFailureStep) => void,
    ): Promise<boolean> {
      // A qualified fresh callback has no ordinary-write escape hatch. Lost
      // acknowledgement, absent original, or stale source all refuse retry.
      if (attempted) return unavailable();
      attempted = true;
      mark("write_original");
      const selected = receiver;
      const pending = freshRpIssuance.get(connection);
      const original = selected && readSharedAuthFreshSessionWrite(selected, record);
      const subject = pending ? pendingPrincipal(pending.principal) : null;
      if (
        !selected ||
        !pending ||
        !subject ||
        !original ||
        original.original !== pending.original ||
        original.session.digest !== record.digest ||
        original.session.principalId !== subject.principalId ||
        original.session.workspaceId !== pending.held.principalOriginal.workspace.id ||
        original.session.accountId !== pending.held.principalOriginal.identity.accountId ||
        !exactDigest(record.digest)
      )
        return unavailable();
      mark("origin_current");
      originalFreshCurrent(connection, pending);
      const data = pending.held.principalOriginal;
      mark("phase");
      if (data.phase !== "fresh-callback") return unavailable();
      mark("native_target");
      const nativeData = readAuth103NativeRequestOrigin(nativeOrigin, connection);
      if (!nativeData || nativeData.targetRef !== subject.targetRef) return unavailable();
      mark("issuance_digest");
      const issuanceDigest = await bytesDigest(
        new TextEncoder().encode(
          JSON.stringify([nativeData.sourceRef, pending.issuanceRef, record.digest]),
        ),
      );
      mark("origin_recheck");
      originalFreshCurrent(connection, pending);
      const issuedAt = subject.issuedAt;
      const credential: CredentialAuthorityOrigin = Object.freeze({
        ref: pending.credentialRef,
        incarnation: pending.credentialIncarnation,
        targetRef: nativeData.targetRef,
        principalId: subject.principalId,
        principalIncarnation: subject.principalIncarnation,
        issuanceRef: pending.issuanceRef,
        issuanceDigest,
        issuedAt,
      });
      const rp: RpAuthorityIdentity = Object.freeze({
        principalBindingRef: subject.bindingRef,
        registrationRef: pending.registration.registrationRef,
        registrationDigest: pending.registration.registrationDigest,
        sessionDigest: record.digest,
        sessionCreatedAt: record.createdAt,
        enrolledSessionVersion: 0,
        issuer: data.identity.issuer,
        clientId: data.identity.clientId,
        subject: data.identity.subject,
        issuerSessionId: data.identity.sessionId,
        authTime: data.identity.authTime,
        accountId: data.identity.accountId,
        workspaceId: data.workspace.id,
        workspaceRef: data.workspaceOrganization.workspaceRef,
      });
      const contribution = Object.freeze({
        credential,
        rp,
        organizationId: data.workspaceOrganization.organizationId,
        session: original.session,
      });
      mark("consumers");
      const inputs = readWorkerRequestFinancialInputs(connection);
      const consumers = readWorkerRequestConsumers(connection);
      if (consumers.sharedAuth !== selected || inputs !== pending.held.inputs) return unavailable();
      mark("issuance_attempted");
      const issuance = createSharedRpPrincipalIssuanceStoreInternal(
        { sql: inputs.sql, workspaceBillingAuthority: consumers.realm.billingAuthority },
        () => auth103NativeRequestCurrentness(nativeOrigin, connection),
      );
      const issued =
        pending.principal.kind === "fresh"
          ? await issuance
              .issueFreshOnce(
                Object.freeze({ ...contribution, principal: pending.principal.fresh }),
                mark,
              )
              .then((result) => ({
                session: result.session,
                bindingRef: result.principal.binding.ref,
              }))
          : await issuance
              .issueRetainedOnce(
                Object.freeze({ ...contribution, principal: pending.principal.retained }),
                mark,
              )
              .then((result) => ({
                session: result.session,
                bindingRef: result.principal.bindingRef,
              }));
      mark("post_current");
      originalFreshCurrent(connection, pending);
      mark("post_ack");
      if (
        issued.session.digest !== record.digest ||
        issued.bindingRef !== subject.bindingRef ||
        readWorkerRequestConsumers(connection) !== consumers
      )
        return unavailable();
      freshRpIssuance.delete(connection);
      return true;
    },
  });
  const store: SharedAuthSessionStore = Object.freeze({
    ...ordinary,
    async createSession(record: OidcSessionRecord): Promise<boolean> {
      // Private diagnostic progress only; the same error is rethrown unchanged.
      let step: SessionWriteFailureStep = "attempted";
      try {
        return await unreported.createSession(record, (next) => {
          step = next;
        });
      } catch (error) {
        reportSessionWriteFailure(step, error);
        throw error;
      }
    },
  });
  freshRpStores.set(connection, nativeOrigin);
  return Object.freeze({
    store,
    bindReceiver(actual) {
      if (receiver !== null || freshRpStores.get(connection) !== nativeOrigin) return unavailable();
      receiver = actual;
    },
  });
}

// Populated only after this actual original projection verifies the retained
// class, Principal and binding. No caller can install an observation DATA row.
const resolvedRpUserOriginals = new WeakMap<
  WorkerRequestSql,
  {
    readonly original: unknown;
    readonly held: WorkerRequestVerifiedSharedPrincipalInputs;
  }
>();

/**
 * The RP original stays inside its actual Root projection. A later successful
 * final-touch credential selects the distinct user original through the owning
 * readers; external projections and matching DTOs have no captured entry.
 */
export async function captureWorkerRequestResolvedRpUserBindingOriginal(
  connection: WorkerRequestSql,
  originalRpCredential: unknown,
): Promise<WorkerRequestAuthenticatedRpUserBindingOriginal | null> {
  try {
    assertWorkerRequestBackingOrigin(connection);
    const selected = resolvedRpUserOriginals.get(connection);
    if (!selected) return null;
    const assertOriginal = () => {
      const current = readWorkerRequestVerifiedSharedPrincipalInputs(connection, selected.original);
      if (
        resolvedRpUserOriginals.get(connection) !== selected ||
        !current ||
        current.inputs !== selected.held.inputs ||
        current.principalOriginal !== selected.held.principalOriginal
      )
        return unavailable();
    };
    assertOriginal();
    const capture = await captureWorkerRequestAuthenticatedRpUserBindingOriginal(
      connection,
      selected.original,
      originalRpCredential,
    );
    assertOriginal();
    return capture;
  } catch {
    return unavailable();
  }
}

/**
 * Read-only retained Sql over the original request graph's own query method.
 * Every read rechecks that the verified original and its inputs are unchanged;
 * writes are refused.
 */
function retainedReader(
  connection: WorkerRequestSql,
  original: unknown,
  held: WorkerRequestVerifiedSharedPrincipalInputs,
): { readonly retainedSql: Sql; readonly assertOriginal: () => void } {
  const descriptor = Object.getOwnPropertyDescriptor(held.inputs.sql, "query");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    return unavailable();
  const query: Sql["query"] = descriptor.value;
  const assertOriginal = () => {
    const current = readWorkerRequestVerifiedSharedPrincipalInputs(connection, original);
    if (
      !current ||
      current.inputs !== held.inputs ||
      current.principalOriginal !== held.principalOriginal ||
      Object.getOwnPropertyDescriptor(held.inputs.sql, "query")?.value !== query
    )
      unavailable();
  };
  const retainedSql = Object.freeze<Sql>({
    async query(text, params) {
      assertOriginal();
      let rows: readonly Row[];
      try {
        rows = await Reflect.apply(query, held.inputs.sql, [text, params]);
      } catch {
        return unavailable();
      }
      assertOriginal();
      return rows;
    },
    async run() {
      return unavailable();
    },
    async batch() {
      return unavailable();
    },
  });
  return Object.freeze({ retainedSql, assertOriginal });
}

/** Real original callback -> retained rows only. No absence/fresh auto-enrollment.
 * This is ordinary identity resolution, never NEW/Financial/human authority.
 */
export function createWorkerRequestSharedRpOriginalPrincipalProjection(
  connection: WorkerRequestSql,
): SharedAuthPrincipalProjection {
  return Object.freeze({
    async resolve(
      input: Parameters<SharedAuthPrincipalProjection["resolve"]>[0],
      original: Parameters<SharedAuthPrincipalProjection["resolve"]>[1],
    ) {
      const held = readWorkerRequestVerifiedSharedPrincipalInputs(connection, original);
      if (!held) return unavailable();
      const compatibility = snapshot(input);
      const { identity, workspace } = held.principalOriginal;
      if (
        Object.keys(compatibility).sort().join(",") !==
          "accountId,authTime,clientId,issuer,sessionId,subject,workspaceId" ||
        compatibility.issuer !== identity.issuer ||
        compatibility.clientId !== identity.clientId ||
        compatibility.subject !== identity.subject ||
        compatibility.sessionId !== identity.sessionId ||
        compatibility.authTime !== identity.authTime ||
        compatibility.accountId !== identity.accountId ||
        compatibility.workspaceId !== workspace.id
      )
        return unavailable();
      if (held.principalOriginal.phase === "fresh-callback") {
        const bridge = freshRpStores.get(connection);
        const { workspaceOrganization, identity } = held.principalOriginal;
        if (
          !bridge ||
          freshRpIssuance.has(connection) ||
          workspaceOrganization.workspaceId !== workspace.id ||
          !workspaceOrganization.workspaceRef ||
          !workspaceOrganization.organizationId
        )
          return unavailable();
        const native = readAuth103NativeRequestOrigin(bridge, connection);
        const registration = readAuth103NativeRpRegistrationOriginal(bridge, connection);
        const clock = readAuth103SourceClock(held.inputs.clock);
        if (
          !native ||
          !registration ||
          !clock ||
          registration.profile.issuer !== identity.issuer ||
          registration.profile.clientId !== identity.clientId ||
          registration.native.targetRef !== native.targetRef ||
          registration.native.sourceRef !== native.sourceRef
        )
          return unavailable();
        // A subject that already holds a binding reuses its current principal
        // and binding (or is refused); only an unbound subject enrolls fresh.
        const { retainedSql } = retainedReader(connection, original, held);
        const retained = await resolveSharedRpSubjectBinding(retainedSql, {
          issuer: identity.issuer,
          subject: identity.subject,
          targetRef: native.targetRef,
        });
        const at = held.inputs.clock().toISOString();
        const evidenceBytes = new TextEncoder().encode(
          JSON.stringify([
            native.authSchemaRef,
            native.targetRef,
            native.sourceRef,
            registration.registrationRef,
            registration.registrationDigest,
            identity,
            workspace,
            workspaceOrganization,
            at,
          ]),
        );
        const digest = await bytesDigest(evidenceBytes);
        const current = readWorkerRequestVerifiedSharedPrincipalInputs(connection, original);
        if (
          !current ||
          current.inputs !== held.inputs ||
          current.principalOriginal !== held.principalOriginal ||
          freshRpIssuance.has(connection) ||
          readAuth103NativeRequestOrigin(bridge, connection) === null ||
          readAuth103NativeRequestOrigin(bridge, connection)?.targetRef !== native.targetRef ||
          readAuth103SourceClock(held.inputs.clock) !== clock
        )
          return unavailable();
        const id = () => crypto.randomUUID();
        if (retained !== null) {
          freshRpIssuance.set(
            connection,
            Object.freeze({
              original,
              held,
              nativeOrigin: bridge,
              principal: Object.freeze({ kind: "retained" as const, retained, issuedAt: at }),
              registration,
              credentialRef: `cra_${id()}`,
              credentialIncarnation: `cri_${id()}`,
              issuanceRef: `iss_${id()}`,
            }),
          );
          return Object.freeze({
            accountId: identity.accountId,
            principalId: retained.principalId,
          });
        }
        const principal: FreshSharedPrincipal = Object.freeze({
          principalId: `prn_${id()}`,
          principalIncarnation: `pri_${id()}`,
          createdAt: at,
          origin: Object.freeze({ ref: `pro_${id()}`, digest }),
          binding: Object.freeze({
            ref: `spb_${id()}`,
            issuer: identity.issuer,
            subject: identity.subject,
            controllerIncarnation: `ctl_${id()}`,
            targetRef: native.targetRef,
            evidence: Object.freeze({ ref: `bev_${id()}`, digest }),
            enrolledAt: at,
          }),
        });
        freshRpIssuance.set(
          connection,
          Object.freeze({
            original,
            held,
            nativeOrigin: bridge,
            principal: Object.freeze({ kind: "fresh" as const, fresh: principal }),
            registration,
            credentialRef: `cra_${id()}`,
            credentialIncarnation: `cri_${id()}`,
            issuanceRef: `iss_${id()}`,
          }),
        );
        return Object.freeze({ accountId: identity.accountId, principalId: principal.principalId });
      }
      const observation = held.principalOriginal.sessionObservation;
      const { retainedSql, assertOriginal } = retainedReader(connection, original, held);
      const classes = createCredentialAuthorityClassStore({ sql: retainedSql });
      const principals = createSharedPrincipalAuthorityStore({
        sql: retainedSql,
      });
      const record = await classes.readActiveSharedRpSessionByDigest(observation.digest);
      assertOriginal();
      if (
        !record ||
        record.origin.principalId !== observation.principalId ||
        record.rp.sessionCreatedAt !== observation.createdAt ||
        record.rp.workspaceId !== observation.sessionWorkspaceId ||
        record.rp.issuer !== identity.issuer ||
        record.rp.clientId !== identity.clientId ||
        record.rp.subject !== identity.subject ||
        record.rp.accountId !== identity.accountId ||
        record.rp.issuerSessionId !== identity.sessionId ||
        record.rp.authTime !== identity.authTime ||
        record.rp.enrolledSessionVersion > observation.readVersion ||
        observation.readVersion > observation.resolvedVersion
      )
        return unavailable();
      const binding = await principals.readBinding(record.rp.principalBindingRef);
      assertOriginal();
      if (
        binding?.state !== "active" ||
        binding.terminal !== null ||
        binding.principalId !== record.origin.principalId ||
        binding.principalIncarnation !== record.origin.principalIncarnation ||
        binding.targetRef !== record.origin.targetRef ||
        binding.issuer !== identity.issuer ||
        binding.subject !== identity.subject
      )
        return unavailable();
      const anchor = await principals.readAnchor(record.origin.principalId);
      assertOriginal();
      if (
        anchor?.state !== "active" ||
        anchor.terminal !== null ||
        anchor.principalId !== record.origin.principalId ||
        anchor.incarnation !== record.origin.principalIncarnation ||
        anchor.originKind !== binding.kind ||
        anchor.verificationDomain !== null ||
        (anchor.originKind === "fresh-shared" && anchor.identitySubject !== binding.ref)
      )
        return unavailable();
      // Re-read the same exact retained records. This detects observed drift but
      // does not claim an atomic/current authority snapshot or new enrollment.
      const recordAfter = await classes.readActiveSharedRpSessionByDigest(observation.digest);
      const bindingAfter = await principals.readBinding(binding.ref);
      const anchorAfter = await principals.readAnchor(anchor.principalId);
      assertOriginal();
      if (
        JSON.stringify(recordAfter) !== JSON.stringify(record) ||
        JSON.stringify(bindingAfter) !== JSON.stringify(binding) ||
        JSON.stringify(anchorAfter) !== JSON.stringify(anchor)
      )
        return unavailable();
      resolvedRpUserOriginals.set(connection, Object.freeze({ original, held }));
      return Object.freeze({
        accountId: identity.accountId,
        principalId: anchor.principalId,
      });
    },
  });
}

function ownOption(receiver: object, name: string, optional = false): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(receiver, name);
  if (!descriptor && optional) return undefined;
  if (!descriptor || !("value" in descriptor)) return unavailable();
  return descriptor.value;
}

/** Explicit Root-owned retained-original branch. Ordinary default is unchanged.
 * The actual RP is created once by the existing common-request constructor.
 * External selected.principals is not read, called or elevated by this factory.
 * Fresh callbacks remain refused until the owning original session hook and
 * registered Root issuer inputs exist; this factory does not mount them.
 */
export function prepareWorkerRequestOriginalRpConsumerOptions(
  options: Parameters<typeof createWorkerRequestConsumers>[0],
): Parameters<typeof createWorkerRequestConsumers>[0] {
  const fields = [
    "connection",
    "sql",
    "client",
    "realm",
    "identity",
    "clock",
    "randomId",
    "publicOrigin",
    "consoleOrigin",
    "sharedAuth",
  ] as const;
  const selected = Object.fromEntries(
    fields.map((name) => [name, ownOption(options, name)]),
  ) as unknown as typeof options;
  assertWorkerRequestBackingOrigin(selected.connection);
  const shared = selected.sharedAuth;
  const kind = ownOption(shared, "kind");
  if (kind !== "shared-auth-staging-v1") return unavailable();
  const clientSecret = ownOption(shared, "clientSecret") as string;
  const encryptionKey = ownOption(shared, "encryptionKey") as Uint8Array;
  const organizations = ownOption(shared, "organizations", true) as typeof shared.organizations;
  const fetch = ownOption(shared, "fetch", true) as typeof shared.fetch;
  return Object.freeze({
    ...selected,
    sharedAuth: captureWorkerSharedAuthStaging({
      kind,
      clientSecret,
      encryptionKey,
      principals: createWorkerRequestSharedRpOriginalPrincipalProjection(selected.connection),
      ...(organizations === undefined ? {} : { organizations }),
      ...(fetch === undefined ? {} : { fetch }),
    }),
  });
}

/** One ordinary constructor after the original Root RP inputs are captured. */
export function createWorkerRequestConsumersWithOriginalRpProjection(
  options: Parameters<typeof createWorkerRequestConsumers>[0],
): ReturnType<typeof createWorkerRequestConsumers> {
  const selected = prepareWorkerRequestOriginalRpConsumerOptions(options);
  const consumers = createWorkerRequestConsumers(selected);
  assertWorkerRequestBackingOrigin(selected.connection);
  return consumers;
}
