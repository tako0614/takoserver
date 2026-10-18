import {
  type CredentialAuthorityOrigin,
  createCredentialAuthorityClassStore,
  type RpAuthorityIdentity,
} from "./credential-authority-class.ts";
import type { Row, Sql, SqlStatement, SqlWrite } from "./ports.ts";
import type { OidcSessionRecord } from "./shared-auth-session-store.ts";
import {
  AuthAuthorityStoreError,
  createSharedPrincipalAuthorityStore,
  type FreshSharedPrincipal,
} from "./shared-principal-authority.ts";
import {
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";

/** Storage contribution, not a verified RP subject or qualified human capture. */
export interface FreshSharedRpIssuanceData {
  readonly principal: FreshSharedPrincipal;
  readonly credential: CredentialAuthorityOrigin;
  readonly rp: RpAuthorityIdentity;
  readonly organizationId: string;
  readonly session: OidcSessionRecord;
}

function unavailable(): never {
  throw new AuthAuthorityStoreError("unavailable");
}
function invalid(): never {
  throw new AuthAuthorityStoreError("invalid");
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
      Object.defineProperty(result, key, { value: copy(d.value, depth + 1), enumerable: true });
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
export function createSharedRpPrincipalIssuanceStore(options: { readonly sql: Sql }) {
  const sql = options.sql;
  const originalBatch = batchMethod(sql);
  let attempted = false;
  const assertSql = () => {
    if (batchMethod(sql) !== originalBatch) unavailable();
  };
  return Object.freeze({
    async issueFreshOnce(input: FreshSharedRpIssuanceData) {
      if (attempted) return unavailable();
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
          const original: readonly SqlWrite[] = await Reflect.apply(originalBatch, sql, [
            Object.freeze([...principalStatements, ...pair]),
          ]);
          assertSql();
          let writes: readonly SqlWrite[];
          try {
            const candidate = snapshot(original);
            if (
              !Array.isArray(candidate) ||
              candidate.length !== 5 ||
              candidate.some(
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
              )
            )
              return unavailable();
            writes = candidate;
          } catch {
            return unavailable();
          }
          exact(writes[3]?.rows[0], {
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
          exact(writes[4]?.rows[0], {
            authority_ref: c.ref,
            credential_incarnation: c.incarnation,
            class: "official-shared-rp-session",
            backend: "shared-rp-session",
            target_ref: c.targetRef,
            organization_id: data.organizationId,
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
          pairRows = writes.slice(3);
          return Object.freeze(writes.slice(0, 3));
        },
      });
      // Existing unchanged fixed3 recipe and exact full RETURNING validators.
      const principal = await createSharedPrincipalAuthorityStore({
        sql: facade,
      }).createFreshWithPostimages(p);
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
  });
}

/** Bind the contribution to the actual completed common request graph, not caller Sql. */
export function createWorkerRequestSharedRpIssuanceContribution(connection: WorkerRequestSql) {
  const inputs = readWorkerRequestFinancialInputs(connection);
  const consumers = readWorkerRequestConsumers(connection);
  const store = createSharedRpPrincipalIssuanceStore({ sql: inputs.sql });
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
