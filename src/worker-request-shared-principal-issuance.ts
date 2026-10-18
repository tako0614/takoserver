import {
  type CredentialAuthorityOrigin,
  createCredentialAuthorityClassStore,
  type RpAuthorityIdentity,
} from "./credential-authority-class.ts";
import type { Row, Sql, SqlStatement, SqlWrite } from "./ports.ts";
import {
  readSharedAuthVerifiedPrincipalInput,
  type SharedAuthPrincipalProjection,
  type SharedAuthVerifiedPrincipalData,
} from "./shared-auth-session.ts";
import type { OidcSessionRecord } from "./shared-auth-session-store.ts";
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
  type WorkerRequestSql,
} from "./worker-request-composition.ts";
import {
  captureWorkerRequestAuthenticatedRpUserBindingOriginal,
  type WorkerRequestAuthenticatedRpUserBindingOriginal,
} from "./worker-request-financial-auth-original.ts";

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
      // The actual callback has not yet created its sealed OIDC session draft.
      // Calling fixed5 here would invent that original input. No fallback to the
      // externally selected projection, local issuer, random refs or old touch.
      if (held.principalOriginal.phase !== "existing-session") return unavailable();
      const observation = held.principalOriginal.sessionObservation;
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
