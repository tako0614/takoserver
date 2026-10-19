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
import type { Row, Sql, SqlStatement, SqlWrite } from "./ports.ts";
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
function createSharedRpPrincipalIssuanceStoreInternal(
  options: { readonly sql: Sql },
  nativeCurrentness: (() => ReturnType<typeof auth103NativeRequestCurrentness>) | null,
) {
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
          let companion: SqlStatement = pair[1];
          if (nativeCurrentness !== null) {
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
            // principal_id. Keep the native source predicate in that mandatory
            // last statement, so stale source rolls back the entire fixed five.
            companion = Object.freeze({
              sql: companion.sql.replace(marker, `${marker}(${current.sql}) AND `),
              params: Object.freeze([...params.slice(0, 6), ...current.params, ...params.slice(6)]),
            });
          }
          const fixedFive = Object.freeze([...principalStatements, pair[0], companion]);
          if (fixedFive.some((statement) => (statement.params?.length ?? 0) > 100))
            return unavailable();
          const original: readonly SqlWrite[] = await Reflect.apply(originalBatch, sql, [
            fixedFive,
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

export function createSharedRpPrincipalIssuanceStore(options: { readonly sql: Sql }) {
  return createSharedRpPrincipalIssuanceStoreInternal(options, null);
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

interface PendingFreshRpIssuance {
  readonly original: Parameters<SharedAuthPrincipalProjection["resolve"]>[1];
  readonly held: WorkerRequestVerifiedSharedPrincipalInputs;
  readonly nativeOrigin: Auth103NativeRequestOrigin;
  readonly principal: FreshSharedPrincipal;
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
  const store: SharedAuthSessionStore = Object.freeze({
    ...ordinary,
    async createSession(record: OidcSessionRecord): Promise<boolean> {
      // A qualified fresh callback has no ordinary-write escape hatch. Lost
      // acknowledgement, absent original, or stale source all refuse retry.
      if (attempted) return unavailable();
      attempted = true;
      const selected = receiver;
      const pending = freshRpIssuance.get(connection);
      const original = selected && readSharedAuthFreshSessionWrite(selected, record);
      if (
        !selected ||
        !pending ||
        !original ||
        original.original !== pending.original ||
        original.session.digest !== record.digest ||
        original.session.principalId !== pending.principal.principalId ||
        original.session.workspaceId !== pending.held.principalOriginal.workspace.id ||
        original.session.accountId !== pending.held.principalOriginal.identity.accountId ||
        !exactDigest(record.digest)
      )
        return unavailable();
      originalFreshCurrent(connection, pending);
      const data = pending.held.principalOriginal;
      if (data.phase !== "fresh-callback") return unavailable();
      const nativeData = readAuth103NativeRequestOrigin(nativeOrigin, connection);
      if (!nativeData || nativeData.targetRef !== pending.principal.binding.targetRef)
        return unavailable();
      const issuanceDigest = await bytesDigest(
        new TextEncoder().encode(
          JSON.stringify([nativeData.sourceRef, pending.issuanceRef, record.digest]),
        ),
      );
      originalFreshCurrent(connection, pending);
      const issuedAt = pending.principal.createdAt;
      const credential: CredentialAuthorityOrigin = Object.freeze({
        ref: pending.credentialRef,
        incarnation: pending.credentialIncarnation,
        targetRef: nativeData.targetRef,
        principalId: pending.principal.principalId,
        principalIncarnation: pending.principal.principalIncarnation,
        issuanceRef: pending.issuanceRef,
        issuanceDigest,
        issuedAt,
      });
      const rp: RpAuthorityIdentity = Object.freeze({
        principalBindingRef: pending.principal.binding.ref,
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
      const input: FreshSharedRpIssuanceData = Object.freeze({
        principal: pending.principal,
        credential,
        rp,
        organizationId: data.workspaceOrganization.organizationId,
        session: original.session,
      });
      const inputs = readWorkerRequestFinancialInputs(connection);
      const consumers = readWorkerRequestConsumers(connection);
      if (consumers.sharedAuth !== selected || inputs !== pending.held.inputs) return unavailable();
      const issued = await createSharedRpPrincipalIssuanceStoreInternal({ sql: inputs.sql }, () =>
        auth103NativeRequestCurrentness(nativeOrigin, connection),
      ).issueFreshOnce(input);
      originalFreshCurrent(connection, pending);
      if (
        issued.session.digest !== record.digest ||
        issued.principal.binding.ref !== pending.principal.binding.ref ||
        readWorkerRequestConsumers(connection) !== consumers
      )
        return unavailable();
      freshRpIssuance.delete(connection);
      return true;
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
          readAuth103NativeRequestOrigin(bridge, connection) === null ||
          readAuth103SourceClock(held.inputs.clock) !== clock
        )
          return unavailable();
        const id = () => crypto.randomUUID();
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
            principal,
            registration,
            credentialRef: `cra_${id()}`,
            credentialIncarnation: `cri_${id()}`,
            issuanceRef: `iss_${id()}`,
          }),
        );
        return Object.freeze({ accountId: identity.accountId, principalId: principal.principalId });
      }
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
