import {
  type Accounts,
  type ApiKeyAdministration,
  type AuthenticatedTokenCapture,
  type AuthTokenCaptureReader,
  assertAuthTokenCaptureReader,
  assertRetainedDirectOwnerSessionReader,
  assertVerifiedLocalPrincipalIssuanceReader,
  createAccounts,
  createAccountsWithUnregisteredLocalIssuer,
  createApiKeyAdministration,
  type ExternalIdentityVerifier,
  type RetainedDirectOwnerSessionData,
  type RetainedDirectOwnerSessionReader,
  type VerifiedLocalPrincipalIssuance,
  type VerifiedLocalPrincipalIssuanceReader,
} from "./auth.ts";
import type { Auth103NativeRequestOrigin } from "./auth103-native-origin-source.ts";
import { readAuth103SourceClock } from "./auth103-source-clock.ts";
import {
  createCredentialAuthorityClassStore,
  type RpAuthorityRecord,
  sharedRpCredentialCurrentness,
} from "./credential-authority-class.ts";
import {
  type FinancialCurrentConsentCustomerOperation,
  readFinancialCurrentConsentNativeOriginal,
} from "./financial-current-consent-customer.ts";
import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import {
  assertIdentityVerificationCaptureReader,
  type IdentityVerificationCaptureReader,
} from "./identity-setup.ts";
import { canonicalDigest } from "./json.ts";
import {
  assertMoneyCutoverSqlBackingOrigin,
  assertMoneyCutoverSqlOrigin,
  createMoneyCutoverSql,
  inspectMoneyCutoverGuard,
  type MoneyCutoverGuardState,
} from "./money-cutover-sql.ts";
import { type Clock, type Row, type Sql, SqlError, type SqlWrite } from "./ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "./shared-auth-oidc-client.ts";
import {
  createSharedAuthSession,
  type SharedAuthFinalSessionSelection,
  type SharedAuthOrganizationPins,
  type SharedAuthPrincipalProjection,
  type SharedAuthSession,
  type SharedWorkspaceOrganization,
} from "./shared-auth-session.ts";
import {
  createSharedAuthFinalSessionStore,
  createSharedAuthSessionStore,
} from "./shared-auth-session-store.ts";
import {
  createSharedPrincipalAuthorityStore,
  type PrincipalAnchor,
  type SharedPrincipalBinding,
} from "./shared-principal-authority.ts";
import { createD1Sql, type D1DatabaseLike } from "./sql-d1.ts";
import type { StripeBillingClient } from "./stripe-billing-client.ts";
import { createAccountsWithQualifiedLocalIssuer } from "./worker-request-qualified-local-issuer.ts";

/** The native binding owns primary consistency; no Sql-shaped input selects it. */
export interface WorkerRequestDatabase extends D1DatabaseLike {
  withSession?(constraint: "first-primary"): D1DatabaseLike;
}

/**
 * Code-selected inputs for the one existing isolated shared-login profile.
 * The caller owns qualification of principal/pin producers. Capturing these
 * ports does not prove that their own storage uses this request's primary.
 */
export interface WorkerSharedAuthStaging {
  readonly kind: "shared-auth-staging-v1";
  readonly clientSecret: string;
  readonly encryptionKey: Uint8Array;
  readonly principals: SharedAuthPrincipalProjection;
  readonly organizations?: SharedAuthOrganizationPins;
  readonly fetch?: (request: Request) => Promise<Response>;
}

/** A request-local connection, constructed here rather than supplied as generic Sql. */
export interface WorkerRequestSql {
  readonly sql: Sql;
  readonly moneyGuard: MoneyCutoverGuardState;
}

type WorkerRequestOriginPurpose = "native-primary" | "shared-auth-staging";
const requestOrigins = new WeakMap<
  WorkerRequestSql,
  {
    readonly writerEpoch: string;
    readonly purpose: WorkerRequestOriginPurpose;
    readonly database: WorkerRequestDatabase;
    readonly withSession: NonNullable<WorkerRequestDatabase["withSession"]>;
    readonly session: D1DatabaseLike;
    readonly prepare: unknown;
    readonly batch: unknown;
    readonly rawSql: Sql;
  }
>();

/**
 * One native primary session, one strict raw adapter and one Money wrapper.
 * The guard reads the captured raw adapter before wrapping; the raw adapter and
 * native session are never returned to consumers. This constructs only a local
 * request origin, not shared-login, credential, realm or current authority.
 */
export async function createWorkerPrimaryRequestSql(options: {
  readonly database: WorkerRequestDatabase;
  readonly writerEpoch: string;
}): Promise<WorkerRequestSql> {
  return await constructWorkerPrimaryRequestSql(options, "native-primary");
}

async function constructWorkerPrimaryRequestSql(
  options: {
    readonly database: WorkerRequestDatabase;
    readonly writerEpoch: string;
  },
  purpose: WorkerRequestOriginPurpose,
): Promise<WorkerRequestSql> {
  const diagnostic = purpose === "shared-auth-staging" ? "shared-login Worker" : "Worker";
  const database = options.database;
  const withSession = database?.withSession;
  if (typeof withSession !== "function")
    throw new TypeError(`${diagnostic} requires a native primary D1 session`);
  let nativeSession: D1DatabaseLike;
  try {
    nativeSession = Reflect.apply(withSession, database, ["first-primary"]);
  } catch {
    throw new TypeError(`${diagnostic} primary session is unavailable`);
  }
  const rawSql = createD1Sql(nativeSession, {
    acknowledgement: "explicit-d1-result",
  });
  const prepare = dataMethod(nativeSession, "prepare");
  const batch = dataMethod(nativeSession, "batch");
  const writerEpoch = options.writerEpoch;
  const moneyGuard = await inspectMoneyCutoverGuard(rawSql, writerEpoch);
  const sql = createMoneyCutoverSql(rawSql, writerEpoch);
  assertMoneyCutoverSqlBackingOrigin(sql, { rawSql, writerEpoch });
  const connection = Object.freeze({ sql, moneyGuard });
  requestOrigins.set(
    connection,
    Object.freeze({
      writerEpoch,
      purpose,
      database,
      withSession,
      session: nativeSession,
      prepare,
      batch,
      rawSql,
    }),
  );
  return connection;
}

/** Shared-login retains its exact selected origins before native construction. */
export async function createWorkerRequestSql(options: {
  readonly database: WorkerRequestDatabase;
  readonly writerEpoch: string;
  readonly publicOrigin: string;
  readonly consoleOrigin: string | undefined;
}): Promise<WorkerRequestSql> {
  if (
    options.publicOrigin !== SHARED_AUTH_STAGING_PROFILE.publicOrigin ||
    options.consoleOrigin !== SHARED_AUTH_STAGING_PROFILE.consoleOrigin
  )
    throw new TypeError("shared-login Worker requires the exact selected staging origins");
  return await constructWorkerPrimaryRequestSql(options, "shared-auth-staging");
}

/** Capture only code inputs; request/environment data cannot replace the owning ports. */
export function captureWorkerSharedAuthStaging(
  options: WorkerSharedAuthStaging,
): WorkerSharedAuthStaging {
  if (
    options.kind !== "shared-auth-staging-v1" ||
    typeof options.clientSecret !== "string" ||
    options.clientSecret.length === 0 ||
    !(options.encryptionKey instanceof Uint8Array) ||
    options.encryptionKey.byteLength !== 32 ||
    typeof options.principals?.resolve !== "function" ||
    (options.organizations !== undefined && typeof options.organizations.pin !== "function") ||
    (options.fetch !== undefined && typeof options.fetch !== "function")
  )
    throw new TypeError("shared-login Worker requires its selected staging composition");
  const principalReceiver = options.principals;
  const resolvePrincipal = principalReceiver.resolve;
  const organizationReceiver = options.organizations;
  const pinOrganization = organizationReceiver?.pin;
  return Object.freeze({
    kind: "shared-auth-staging-v1",
    clientSecret: options.clientSecret,
    encryptionKey: Uint8Array.from(options.encryptionKey),
    principals: Object.freeze({
      resolve: (...input: Parameters<SharedAuthPrincipalProjection["resolve"]>) =>
        Reflect.apply(resolvePrincipal, principalReceiver, input),
    }),
    ...(organizationReceiver === undefined || pinOrganization === undefined
      ? {}
      : {
          organizations: Object.freeze({
            pin: (input: Parameters<SharedAuthOrganizationPins["pin"]>[0]) =>
              Reflect.apply(pinOrganization, organizationReceiver, [input]),
          }),
        }),
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
}

export interface WorkerRequestAppInputs {
  readonly connection: WorkerRequestSql;
  readonly sharedAuth: WorkerSharedAuthStaging;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
}

/** Private common graph. It grants no authority class, payer or Financial permission. */
export interface WorkerRequestConsumers {
  readonly sql: Sql;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
  readonly accounts: Accounts & AuthTokenCaptureReader;
  readonly apiKeyAdministration: ApiKeyAdministration;
  readonly sharedAuth: SharedAuthSession;
}

const requestConsumers = new WeakMap<WorkerRequestSql, WorkerRequestConsumers>();

/**
 * The actual request construction inputs, retained at the same successful
 * construction boundary as Accounts/RP. Clock identity is not qualified Clock
 * policy, source qualification, Principal/payer authority or M/G command custody.
 */
export interface WorkerRequestFinancialInputs {
  readonly sql: Sql;
  readonly client: StripeBillingClient;
  readonly realm: HostedBillingFinancialRealm;
  readonly clock: Clock;
  readonly writerEpoch: string;
}

const requestFinancialInputs = new WeakMap<WorkerRequestSql, WorkerRequestFinancialInputs>();

// A D1 batch may have reached the target even when its acknowledgement was lost.
// The Financial owner mints each operation, while this native request owns the
// local send fence. A new operation for the same phase cannot resend it here.
const financialCurrentConsentBatches = new WeakMap<WorkerRequestSql, Set<"L1" | "D">>();

function readWorkerFinancialCurrentConsentNativeOriginal(
  connection: WorkerRequestSql,
  operation: FinancialCurrentConsentCustomerOperation,
  expectedKind: "query" | "batch",
) {
  const origin = assertWorkerRequestBacking(connection);
  const inputs = readWorkerRequestFinancialInputs(connection);
  const original = readFinancialCurrentConsentNativeOriginal(operation, expectedKind);
  if (
    !original ||
    original.kind !== expectedKind ||
    original.connection !== connection ||
    original.inputs !== inputs ||
    original.writerEpoch !== origin.writerEpoch ||
    original.original.writerEpoch !== origin.writerEpoch ||
    original.original.phase !== original.phase ||
    inputs.sql !== connection.sql
  )
    throw new SqlError("invalid", "Financial current consent operation origin differs");
  return { origin, inputs, original };
}

/** Only Financial's retained fixed completed/original read uses the raw primary. */
export async function queryWorkerRequestFinancialCurrentConsentOriginal(
  connection: WorkerRequestSql,
  operation: FinancialCurrentConsentCustomerOperation,
): Promise<readonly Row[]> {
  const { original, origin, inputs } = readWorkerFinancialCurrentConsentNativeOriginal(
    connection,
    operation,
    "query",
  );
  if (original.kind !== "query")
    throw new SqlError("invalid", "Financial current consent read origin differs");
  const rows = await origin.rawSql.query(original.statement.sql, original.statement.params);
  assertWorkerRequestBacking(connection);
  const current = readFinancialCurrentConsentNativeOriginal(operation, "query");
  if (current?.kind !== "query" || current.connection !== connection || current.inputs !== inputs)
    throw new SqlError("unavailable", "Financial current consent read origin changed");
  return rows;
}

/** Send one complete Financial-owned permit/receipt transaction on its original primary. */
export async function batchWorkerRequestFinancialCurrentConsentOriginal(
  connection: WorkerRequestSql,
  operation: FinancialCurrentConsentCustomerOperation,
): Promise<readonly SqlWrite[]> {
  const { original, origin, inputs } = readWorkerFinancialCurrentConsentNativeOriginal(
    connection,
    operation,
    "batch",
  );
  if (
    original.kind !== "batch" ||
    connection.moneyGuard !== "ready" ||
    original.plan.phase !== original.phase ||
    original.plan.statements.length !== (original.phase === "L1" ? 9 : 8)
  )
    throw new SqlError("invalid", "Financial current consent batch origin differs");
  const sent = financialCurrentConsentBatches.get(connection) ?? new Set<"L1" | "D">();
  if (sent.has(original.phase))
    throw new SqlError("unavailable", "Financial current consent phase was already sent");
  sent.add(original.phase);
  financialCurrentConsentBatches.set(connection, sent);
  const result = await origin.rawSql.batch(original.plan.statements);
  assertWorkerRequestBacking(connection);
  const current = readFinancialCurrentConsentNativeOriginal(operation, "batch");
  if (current?.kind !== "batch" || current.connection !== connection || current.inputs !== inputs)
    throw new SqlError("unavailable", "Financial current consent batch origin changed");
  if (
    result.length !== original.plan.statements.length ||
    result[0]?.changes !== 1 ||
    result.at(-1)?.changes !== 1
  )
    throw new SqlError("unavailable", "Financial current consent permit acknowledgement differs");
  return result;
}

const retainedRpCaptureBrand: unique symbol = Symbol("worker-request-retained-rp");
export interface WorkerRequestRetainedRpCapture {
  readonly [retainedRpCaptureBrand]: true;
}

/** Actual retained DATA and final-touch origin, not qualified authority or consent. */
export interface WorkerRequestRetainedRpData {
  readonly backend: "shared-rp-session";
  readonly record: RpAuthorityRecord;
  readonly current: {
    readonly version: number;
    readonly absoluteExpiresAt: number;
    readonly lastUsedAt: number;
  };
  readonly finalSession: SharedAuthFinalSessionSelection;
  readonly selectedScope: SharedWorkspaceOrganization;
}

const retainedRpCaptures = new WeakMap<
  object,
  {
    readonly connection: WorkerRequestSql;
    readonly data: WorkerRequestRetainedRpData;
  }
>();

/** Calls only this request graph's existing RP observer; no DTO/callback can mint a capture. */
export async function captureWorkerRequestRetainedRpSession(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
): Promise<WorkerRequestRetainedRpCapture | null> {
  assertWorkerRequestBacking(connection);
  const inputs = readWorkerRequestFinancialInputs(connection);
  const consumers = readWorkerRequestConsumers(connection);
  const receiver = consumers.sharedAuth;
  const observer = Object.getOwnPropertyDescriptor(receiver, "observeFinalWorkspaceOrganization");
  const inspector = Object.getOwnPropertyDescriptor(receiver, "finalSessionSelection");
  const queryDescriptor = Object.getOwnPropertyDescriptor(inputs.sql, "query");
  if (
    !observer ||
    !("value" in observer) ||
    typeof observer.value !== "function" ||
    !inspector ||
    !("value" in inspector) ||
    typeof inspector.value !== "function" ||
    !queryDescriptor ||
    !("value" in queryDescriptor) ||
    typeof queryDescriptor.value !== "function"
  )
    throw new TypeError("Worker retained RP reader methods differ");
  const observe: SharedAuthSession["observeFinalWorkspaceOrganization"] = observer.value;
  const inspect: SharedAuthSession["finalSessionSelection"] = inspector.value;
  const query: Sql["query"] = queryDescriptor.value;
  const assertOriginal = () => {
    assertWorkerRequestBacking(connection);
    if (
      readWorkerRequestFinancialInputs(connection) !== inputs ||
      readWorkerRequestConsumers(connection) !== consumers ||
      Object.getOwnPropertyDescriptor(receiver, "observeFinalWorkspaceOrganization")?.value !==
        observe ||
      Object.getOwnPropertyDescriptor(receiver, "finalSessionSelection")?.value !== inspect ||
      Object.getOwnPropertyDescriptor(inputs.sql, "query")?.value !== query
    )
      throw new TypeError("Worker retained RP reader origin differs");
  };
  const retainedSql = Object.freeze<Sql>({
    async query(text, params) {
      assertOriginal();
      const rows: readonly Row[] = await Reflect.apply(query, inputs.sql, [text, params]);
      assertOriginal();
      return rows;
    },
    async run() {
      throw new TypeError("Worker retained RP observation is read-only");
    },
    async batch() {
      throw new TypeError("Worker retained RP observation is read-only");
    },
  });
  assertOriginal();
  const context = await Reflect.apply(observe, receiver, [request, workspaceId]);
  assertOriginal();
  if (!context) return null;
  const finalSession = Reflect.apply(inspect, receiver, [context]);
  if (
    !finalSession ||
    finalSession.selectedWorkspaceId !== workspaceId ||
    context.workspaceId !== workspaceId ||
    context.workspace.id !== workspaceId ||
    finalSession.accountId !== context.accountId ||
    finalSession.principalId !== context.actor.principalId
  )
    return null;
  const record = await createCredentialAuthorityClassStore({
    sql: retainedSql,
  }).readActiveSharedRpSessionByDigest(finalSession.sessionDigest);
  assertOriginal();
  if (
    !record ||
    record.origin.principalId !== finalSession.principalId ||
    record.rp.sessionCreatedAt !== finalSession.createdAt ||
    record.rp.enrolledSessionVersion > finalSession.sessionVersion ||
    record.rp.accountId !== finalSession.accountId ||
    record.rp.workspaceId !== finalSession.sessionWorkspaceId ||
    record.rp.issuer !== finalSession.identity.issuer ||
    record.rp.clientId !== finalSession.identity.clientId ||
    record.rp.subject !== finalSession.identity.subject ||
    record.rp.issuerSessionId !== finalSession.identity.sessionId ||
    record.rp.authTime !== finalSession.identity.authTime
  )
    return null;
  const current = Object.freeze({
    version: finalSession.sessionVersion,
    absoluteExpiresAt: finalSession.absoluteExpiresAt,
    lastUsedAt: finalSession.lastUsedAt,
  });
  // Credential row scope stays original. Selected payment scope is separate DATA.
  const predicate = sharedRpCredentialCurrentness(record, current, record.organizationId);
  const rows = await retainedSql.query(
    `SELECT CASE WHEN ${predicate.sql} THEN 1 ELSE 0 END AS valid`,
    predicate.params,
  );
  assertOriginal();
  if (rows.length !== 1 || rows[0]?.valid !== 1) return null;
  const data: WorkerRequestRetainedRpData = Object.freeze({
    backend: "shared-rp-session",
    record,
    current,
    finalSession,
    selectedScope: Object.freeze({
      workspaceId: context.workspaceId,
      workspaceRef: context.workspaceRef,
      organizationId: context.organizationId,
    }),
  });
  const capture: WorkerRequestRetainedRpCapture = {
    [retainedRpCaptureBrand]: true,
  };
  Object.freeze(capture);
  retainedRpCaptures.set(capture, Object.freeze({ connection, data }));
  return capture;
}

/** Historical DATA is readable only through its original request graph and opaque handle. */
export function readWorkerRequestRetainedRpCapture(
  connection: WorkerRequestSql,
  capture: unknown,
): WorkerRequestRetainedRpData | null {
  assertWorkerRequestBacking(connection);
  readWorkerRequestFinancialInputs(connection);
  if (!capture || typeof capture !== "object") return null;
  const original = retainedRpCaptures.get(capture);
  return original?.connection === connection ? original.data : null;
}

/** Same-request retained RP row selections, not a distinct human or authority port.
 * These separate reads do not assert an atomic/current snapshot or grant NEW use.
 */
export interface WorkerRequestRetainedRpPrincipalBindingInputs {
  readonly inputs: WorkerRequestFinancialInputs;
  readonly credentialOriginal: WorkerRequestRetainedRpData;
  readonly anchor: PrincipalAnchor;
  readonly binding: SharedPrincipalBinding;
}

/** Only an original RP capture selects the fixed retained rows on its original Sql.
 * Registration/enrollment and final-touch versions remain in their original fields.
 * Retired history is readable; qualified schema/target, human, Clock, source admission
 * and the mandatory final same-primary currentness batch remain separate obligations.
 */
export async function readWorkerRequestRetainedRpPrincipalBindingInputs(
  connection: WorkerRequestSql,
  originalCapture: unknown,
): Promise<WorkerRequestRetainedRpPrincipalBindingInputs | null> {
  const credentialOriginal = readWorkerRequestRetainedRpCapture(connection, originalCapture);
  if (!credentialOriginal) return null;
  const inputs = readWorkerRequestFinancialInputs(connection);
  const descriptor = Object.getOwnPropertyDescriptor(inputs.sql, "query");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    throw new TypeError("Worker retained RP Principal reader method differs");
  const query: Sql["query"] = descriptor.value;
  const assertOriginal = () => {
    assertWorkerRequestBacking(connection);
    if (
      readWorkerRequestFinancialInputs(connection) !== inputs ||
      readWorkerRequestRetainedRpCapture(connection, originalCapture) !== credentialOriginal ||
      Object.getOwnPropertyDescriptor(inputs.sql, "query")?.value !== query
    )
      throw new TypeError("Worker retained RP Principal reader origin differs");
  };
  const retainedSql = Object.freeze<Sql>({
    async query(text, params) {
      assertOriginal();
      const rows: readonly Row[] = await Reflect.apply(query, inputs.sql, [text, params]);
      assertOriginal();
      return rows;
    },
    async run() {
      throw new TypeError("Worker retained RP Principal observation is read-only");
    },
    async batch() {
      throw new TypeError("Worker retained RP Principal observation is read-only");
    },
  });
  const store = createSharedPrincipalAuthorityStore({ sql: retainedSql });
  const { record } = credentialOriginal;
  assertOriginal();
  const binding = await store.readBinding(record.rp.principalBindingRef);
  assertOriginal();
  if (
    !binding ||
    binding.ref !== record.rp.principalBindingRef ||
    binding.principalId !== record.origin.principalId ||
    binding.principalIncarnation !== record.origin.principalIncarnation ||
    binding.targetRef !== record.origin.targetRef ||
    binding.issuer !== record.rp.issuer ||
    binding.subject !== record.rp.subject ||
    binding.subject !== record.rp.accountId
  )
    return null;
  const anchor = await store.readAnchor(record.origin.principalId);
  assertOriginal();
  if (
    !anchor ||
    anchor.principalId !== record.origin.principalId ||
    anchor.incarnation !== record.origin.principalIncarnation ||
    anchor.originKind !== binding.kind ||
    anchor.verificationDomain !== null ||
    (anchor.originKind === "fresh-shared" && anchor.identitySubject !== binding.ref)
  )
    return null;
  return Object.freeze({ inputs, credentialOriginal, anchor, binding });
}

/** Original verified fresh-local Principal issuance, separate from credential DATA.
 * Not shared-human enrollment, qualified policy Clock/schema/target or NEW permission.
 */
export interface WorkerRequestVerifiedLocalPrincipalIssuanceInputs {
  readonly inputs: WorkerRequestFinancialInputs;
  readonly principalOriginal: VerifiedLocalPrincipalIssuance;
}

/** No bearer/Actor/Principal selector can replace the original signIn result. */
export function readWorkerRequestVerifiedLocalPrincipalIssuanceInputs(
  connection: WorkerRequestSql,
  originalSignInResult: unknown,
): WorkerRequestVerifiedLocalPrincipalIssuanceInputs | null {
  assertWorkerRequestBacking(connection);
  const inputs = readWorkerRequestFinancialInputs(connection);
  const consumers = readWorkerRequestConsumers(connection);
  const receiver = consumers.accounts;
  assertVerifiedLocalPrincipalIssuanceReader(receiver, { sql: inputs.sql });
  const descriptor = Object.getOwnPropertyDescriptor(
    receiver,
    "readVerifiedLocalPrincipalIssuance",
  );
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    throw new TypeError("Worker verified Principal issuance reader differs");
  const read: VerifiedLocalPrincipalIssuanceReader["readVerifiedLocalPrincipalIssuance"] =
    descriptor.value;
  const principalOriginal: VerifiedLocalPrincipalIssuance | null = Reflect.apply(read, receiver, [
    originalSignInResult,
  ]);
  assertWorkerRequestBacking(connection);
  assertVerifiedLocalPrincipalIssuanceReader(receiver, { sql: inputs.sql });
  if (
    readWorkerRequestFinancialInputs(connection) !== inputs ||
    readWorkerRequestConsumers(connection) !== consumers
  )
    throw new TypeError("Worker verified Principal issuance request origin differs");
  return principalOriginal ? Object.freeze({ inputs, principalOriginal }) : null;
}

/** Original request inputs plus retained historical DATA, not an authority port.
 * Schema/physical target, distinct human, policy Clock and final current admission
 * remain unqualified. The existing opaque credential is never rebranded here.
 */
export interface WorkerRequestRetainedCredentialInputs {
  readonly inputs: WorkerRequestFinancialInputs;
  readonly credentialOriginal: RetainedDirectOwnerSessionData | WorkerRequestRetainedRpData;
}

/** One actual same-Accounts capture; unknown reads are propagated without fallback. */
export async function captureWorkerRequestRetainedDirectOwnerSession(
  connection: WorkerRequestSql,
  authorization: string | null,
): Promise<AuthenticatedTokenCapture | null> {
  assertWorkerRequestBacking(connection);
  const inputs = readWorkerRequestFinancialInputs(connection);
  const consumers = readWorkerRequestConsumers(connection);
  const receiver = consumers.accounts;
  assertRetainedDirectOwnerSessionReader(receiver, { sql: inputs.sql });
  const descriptor = Object.getOwnPropertyDescriptor(receiver, "captureRetainedDirectOwnerSession");
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    throw new TypeError("Worker retained direct capture method differs");
  const capture: RetainedDirectOwnerSessionReader["captureRetainedDirectOwnerSession"] =
    descriptor.value;
  const assertOriginal = () => {
    assertWorkerRequestBacking(connection);
    if (
      readWorkerRequestFinancialInputs(connection) !== inputs ||
      readWorkerRequestConsumers(connection) !== consumers
    )
      throw new TypeError("Worker retained direct request origin differs");
    assertRetainedDirectOwnerSessionReader(receiver, { sql: inputs.sql });
    if (
      Object.getOwnPropertyDescriptor(receiver, "captureRetainedDirectOwnerSession")?.value !==
      capture
    )
      throw new TypeError("Worker retained direct capture method differs");
  };
  assertOriginal();
  const original: AuthenticatedTokenCapture | null = await Reflect.apply(capture, receiver, [
    authorization,
  ]);
  assertOriginal();
  return original;
}

/** Actual readers select their own handle; a caller supplies no family or grant.
 * Invalid request graphs throw. Unknown, copied or foreign captures return null.
 */
export function readWorkerRequestRetainedCredentialInputs(
  connection: WorkerRequestSql,
  originalCapture: unknown,
): WorkerRequestRetainedCredentialInputs | null {
  assertWorkerRequestBacking(connection);
  const inputs = readWorkerRequestFinancialInputs(connection);
  const consumers = readWorkerRequestConsumers(connection);
  const receiver = consumers.accounts;
  assertRetainedDirectOwnerSessionReader(receiver, { sql: inputs.sql });
  if (typeof originalCapture !== "object" || originalCapture === null) return null;
  const descriptor = Object.getOwnPropertyDescriptor(
    receiver,
    "readRetainedDirectOwnerSessionCapture",
  );
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    throw new TypeError("Worker retained direct reader method differs");
  const read: RetainedDirectOwnerSessionReader["readRetainedDirectOwnerSessionCapture"] =
    descriptor.value;
  const direct: RetainedDirectOwnerSessionData | null = Reflect.apply(read, receiver, [
    originalCapture,
  ]);
  const credentialOriginal =
    direct ?? readWorkerRequestRetainedRpCapture(connection, originalCapture);
  assertWorkerRequestBacking(connection);
  if (
    readWorkerRequestFinancialInputs(connection) !== inputs ||
    readWorkerRequestConsumers(connection) !== consumers
  )
    throw new TypeError("Worker retained credential request origin differs");
  assertRetainedDirectOwnerSessionReader(receiver, { sql: inputs.sql });
  return credentialOriginal ? Object.freeze({ inputs, credentialOriginal }) : null;
}

/** Original in-process RP observer/selection port; no HTTP path or raw Sql accessor. */
export function readWorkerRequestConsumers(connection: WorkerRequestSql): WorkerRequestConsumers {
  const consumers = requestConsumers.get(connection);
  const origin = requestOrigins.get(connection);
  if (!consumers || origin?.purpose !== "shared-auth-staging" || consumers.sql !== connection.sql)
    throw new TypeError("Worker request consumers have not been constructed");
  assertMoneyCutoverSqlOrigin(consumers.sql, {
    writerEpoch: origin.writerEpoch,
  });
  assertAuthTokenCaptureReader(consumers.accounts, { sql: consumers.sql });
  assertHostedBillingFinancialRealm(consumers.realm, {
    sql: consumers.sql,
    client: consumers.client,
    billingAuthority: consumers.realm.billingAuthority,
  });
  return consumers;
}

/**
 * Only the owning in-process composition calls this with its original connection.
 * A matching object or a copied return value is not an accepted connection.
 * No reader, registration, key, schema digest, receiver or command is minted here.
 */
export function readWorkerRequestFinancialInputs(
  connection: WorkerRequestSql,
): WorkerRequestFinancialInputs {
  const consumers = readWorkerRequestConsumers(connection);
  const inputs = requestFinancialInputs.get(connection);
  const origin = requestOrigins.get(connection);
  if (
    !inputs ||
    !origin ||
    inputs.sql !== connection.sql ||
    inputs.sql !== consumers.sql ||
    inputs.client !== consumers.client ||
    inputs.realm !== consumers.realm ||
    inputs.writerEpoch !== origin.writerEpoch
  )
    throw new TypeError("Worker request Financial inputs have not been constructed");
  return inputs;
}

/**
 * Metadata read from this request's actual first-primary session. This observes
 * catalog bytes and required table presence, not canonical Auth103 definitions,
 * a registered/applied migration, physical D1 UUID, current binding or authority.
 * No raw Sql, native binding/session, catalog SQL or row value is returned.
 */
export interface WorkerRequestAuthSchemaObservation {
  readonly kind: "worker-request-auth-schema-observation";
  readonly catalogDigest: `sha256:${string}`;
  readonly objectCount: number;
}

const requestAuthSchemaObservations = new WeakMap<
  WorkerRequestAuthSchemaObservation,
  WorkerRequestSql
>();

const authSchemaTables = [
  "principals",
  "auth_tokens",
  "auth_principal_incarnations",
  "shared_principal_bindings",
  "credential_authority_classes",
  "shared_auth_sessions",
] as const;

const authCatalogQuery = `SELECT type, name, tbl_name, sql FROM main.sqlite_schema
WHERE (type='table' AND name IN (?,?,?,?,?,?))
 OR (type IN ('index','trigger') AND tbl_name IN (?,?,?,?,?,?))
ORDER BY type, name`;

/**
 * Explicit observation only; ordinary request construction issues no new SQL.
 * Two matching reads detect an observed change, not continuous schema stability.
 * Rejection, unknown acknowledgement or a changed backing publishes no capture.
 */
export async function observeWorkerRequestAuthSchema(
  connection: WorkerRequestSql,
): Promise<WorkerRequestAuthSchemaObservation> {
  const origin = assertWorkerRequestBacking(connection);
  const first = await origin.rawSql.query(authCatalogQuery, [
    ...authSchemaTables,
    ...authSchemaTables,
  ]);
  assertWorkerRequestBacking(connection);
  const catalog = authCatalog(first);
  const catalogDigest = await canonicalDigest(catalog);
  assertWorkerRequestBacking(connection);
  const second = await origin.rawSql.query(authCatalogQuery, [
    ...authSchemaTables,
    ...authSchemaTables,
  ]);
  assertWorkerRequestBacking(connection);
  const secondDigest = await canonicalDigest(authCatalog(second));
  assertWorkerRequestBacking(connection);
  if (catalogDigest !== secondDigest)
    throw new TypeError("Worker request Auth schema changed during observation");
  const observation = Object.freeze({
    kind: "worker-request-auth-schema-observation" as const,
    catalogDigest,
    objectCount: catalog.length,
  });
  requestAuthSchemaObservations.set(observation, connection);
  return observation;
}

/**
 * Joins an original observation to the existing original Financial input graph.
 * The returned Sql/realm/epoch are construction inputs, not qualified Financial
 * ports or installed-schema/target evidence. This reader performs no SQL and
 * does not claim the previously observed schema is still current.
 */
export function readWorkerRequestFinancialAuthSchemaObservation(
  connection: WorkerRequestSql,
  observation: WorkerRequestAuthSchemaObservation,
): {
  readonly inputs: WorkerRequestFinancialInputs;
  readonly observation: WorkerRequestAuthSchemaObservation;
} {
  if (requestAuthSchemaObservations.get(observation) !== connection)
    throw new TypeError("Worker request Auth schema observation origin differs");
  const origin = assertWorkerRequestBacking(connection);
  const inputs = readWorkerRequestFinancialInputs(connection);
  if (inputs.sql !== connection.sql || inputs.writerEpoch !== origin.writerEpoch)
    throw new TypeError("Worker request Auth schema observation graph differs");
  return Object.freeze({ inputs, observation });
}

/** Revalidate the original native request backing without exposing its private origin. */
export function assertWorkerRequestBackingOrigin(connection: WorkerRequestSql): void {
  assertWorkerRequestBacking(connection);
}

/** Match the actual platform binding without exposing the private native origin. */
export function assertWorkerRequestNativeBinding(
  connection: WorkerRequestSql,
  expectedPlatformDatabase: unknown,
): void {
  const original = assertWorkerRequestBacking(connection);
  if (original.database !== expectedPlatformDatabase)
    throw new TypeError("Worker request platform database binding differs");
}

function assertWorkerRequestBacking(connection: WorkerRequestSql) {
  const origin = requestOrigins.get(connection);
  if (!origin) throw new TypeError("Worker request backing has not been constructed");
  if (
    dataMethod(origin.database, "withSession") !== origin.withSession ||
    typeof origin.prepare !== "function" ||
    typeof origin.batch !== "function" ||
    dataMethod(origin.session, "prepare") !== origin.prepare ||
    dataMethod(origin.session, "batch") !== origin.batch
  )
    throw new TypeError("Worker request primary session methods differ");
  assertMoneyCutoverSqlBackingOrigin(connection.sql, {
    rawSql: origin.rawSql,
    writerEpoch: origin.writerEpoch,
  });
  return origin;
}

/** Method identity inspection never invokes a replacement accessor. */
function dataMethod(receiver: object, key: string): unknown {
  let current: object | null = receiver;
  while (current !== null && current !== Object.prototype) {
    const descriptor = Object.getOwnPropertyDescriptor(current, key);
    if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
    current = Object.getPrototypeOf(current) as object | null;
  }
  return undefined;
}

function authCatalog(rows: readonly Row[]): readonly (readonly unknown[])[] {
  const tables = new Set<string>();
  const objects = new Set<string>();
  const catalog = rows.map((row) => {
    const field = (key: string): unknown => {
      const descriptor = Object.getOwnPropertyDescriptor(row, key);
      return descriptor && "value" in descriptor ? descriptor.value : undefined;
    };
    const type = field("type");
    const name = field("name");
    const table = field("tbl_name");
    const sql = field("sql");
    if (
      (type !== "table" && type !== "index" && type !== "trigger") ||
      typeof name !== "string" ||
      name.length === 0 ||
      typeof table !== "string" ||
      !authSchemaTables.some((expected) => expected === table) ||
      (type === "table" && name !== table) ||
      (typeof sql !== "string" && !(type === "index" && sql === null)) ||
      objects.has(`${type}:${name}`)
    )
      throw new TypeError("Worker request Auth schema catalog is invalid");
    objects.add(`${type}:${name}`);
    if (type === "table") tables.add(name);
    return [type, name, table, sql] as const;
  });
  if (authSchemaTables.some((name) => !tables.has(name)))
    throw new TypeError("Worker request Auth schema catalog is incomplete");
  return catalog;
}

/**
 * App's sole Accounts and RP constructors share the already verified financial
 * realm's exact Sql/client. Origin checks are local identity checks, not a
 * substitute for the RP's current row or a Financial effect's own admission.
 */
type WorkerRequestConsumerOptions = WorkerRequestAppInputs & {
  readonly sql: Sql;
  readonly identity: ExternalIdentityVerifier;
  readonly clock: Clock;
  readonly randomId: () => string;
  readonly publicOrigin: string;
  readonly consoleOrigin: string | undefined;
};

const nativeConsumerOptionKeys = [
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

const nativeInitializations = new WeakMap<
  WorkerRequestSql,
  {
    readonly options: WorkerRequestConsumerOptions;
    readonly inputs: WorkerRequestFinancialInputs;
    readonly methods: readonly unknown[];
    readonly clock: NonNullable<ReturnType<typeof readAuth103SourceClock>>;
    construction: object | null;
    phase: "prepared" | "constructing" | "constructed";
  }
>();

function ownNativeInitializationOption(receiver: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(receiver, key);
  if (!d || !("value" in d))
    throw new TypeError("Worker request native initialization inputs differ");
  return d.value;
}

/**
 * Capture the actual original constructor inputs BEFORE its one Accounts/RP
 * construction. This is DATA origin, not installed/native/source permission;
 * the separate native owner must authenticate the real platform registration.
 */
export function initializeWorkerRequestNativeInputs(options: WorkerRequestConsumerOptions): void {
  const selected = Object.freeze(
    Object.fromEntries(
      nativeConsumerOptionKeys.map((key) => [key, ownNativeInitializationOption(options, key)]),
    ),
  ) as unknown as WorkerRequestConsumerOptions;
  const origin = assertWorkerRequestBacking(selected.connection);
  if (
    origin.purpose !== "shared-auth-staging" ||
    selected.sql !== selected.connection.sql ||
    selected.connection.moneyGuard !== "ready" ||
    selected.publicOrigin !== SHARED_AUTH_STAGING_PROFILE.publicOrigin ||
    selected.consoleOrigin !== SHARED_AUTH_STAGING_PROFILE.consoleOrigin ||
    nativeInitializations.has(selected.connection) ||
    requestConsumers.has(selected.connection)
  )
    throw new TypeError("Worker request native initialization differs");
  assertHostedBillingFinancialRealm(selected.realm, {
    sql: selected.sql,
    client: selected.client,
    billingAuthority: selected.realm.billingAuthority,
  });
  const clock = readAuth103SourceClock(selected.clock);
  if (!clock) throw new TypeError("Worker request requires the original source Clock");
  const methods = ["query", "run", "batch"].map((key) => dataMethod(selected.sql, key));
  const inputs = Object.freeze({
    sql: selected.sql,
    client: selected.client,
    realm: selected.realm,
    clock: selected.clock,
    writerEpoch: origin.writerEpoch,
  });
  nativeInitializations.set(selected.connection, {
    options: selected,
    inputs,
    methods,
    clock,
    construction: null,
    phase: "prepared",
  });
  readWorkerRequestNativeInitializationInputs(selected.connection);
}

/** Original preconsumer inputs, rechecked before and after every native await. */
export function readWorkerRequestNativeInitializationInputs(
  connection: WorkerRequestSql,
): WorkerRequestFinancialInputs {
  const origin = assertWorkerRequestBacking(connection);
  const held = nativeInitializations.get(connection);
  if (
    !held ||
    held.inputs.sql !== connection.sql ||
    held.inputs.writerEpoch !== origin.writerEpoch ||
    readAuth103SourceClock(held.inputs.clock) !== held.clock ||
    ["query", "run", "batch"].some(
      (key, index) => dataMethod(held.inputs.sql, key) !== held.methods[index],
    ) ||
    (requestConsumers.has(connection) && requestFinancialInputs.get(connection) !== held.inputs)
  )
    throw new TypeError("Worker request native initialization origin differs");
  assertHostedBillingFinancialRealm(held.inputs.realm, {
    sql: held.inputs.sql,
    client: held.inputs.client,
    billingAuthority: held.inputs.realm.billingAuthority,
  });
  return held.inputs;
}

export function createWorkerRequestConsumers(
  options: WorkerRequestConsumerOptions,
): WorkerRequestConsumers {
  return constructWorkerRequestConsumers(options, null);
}

/**
 * Explicit local candidate constructor. No active shared entry selects this.
 * It retains real local issuance on the same primary, without qualifying Auth103.
 */
export function createWorkerRequestConsumersWithUnregisteredLocalIssuer(
  options: WorkerRequestConsumerOptions & {
    readonly identity: ExternalIdentityVerifier & IdentityVerificationCaptureReader;
  },
): WorkerRequestConsumers {
  const identity = Object.getOwnPropertyDescriptor(options, "identity");
  if (!identity || !("value" in identity))
    throw new TypeError("local candidate requires the original identity reader");
  assertIdentityVerificationCaptureReader(identity.value);
  return constructWorkerRequestConsumers(options, identity.value);
}

/**
 * The actual native original is obtained before the ONE Accounts constructor.
 * This branch consumes an existing original initialization, not a caller-supplied
 * target/Clock/ref or preconstructed Accounts facade. Default remains unchanged.
 */
export async function createWorkerRequestConsumersWithQualifiedLocalIssuer(
  options: WorkerRequestConsumerOptions & {
    readonly identity: ExternalIdentityVerifier & IdentityVerificationCaptureReader;
  },
  nativeOrigin: Auth103NativeRequestOrigin,
): Promise<WorkerRequestConsumers> {
  const selected = Object.freeze(
    Object.fromEntries(
      nativeConsumerOptionKeys.map((key) => [key, ownNativeInitializationOption(options, key)]),
    ),
  ) as unknown as typeof options;
  const inputs = readWorkerRequestNativeInitializationInputs(selected.connection);
  const held = nativeInitializations.get(selected.connection);
  if (
    held?.phase !== "prepared" ||
    requestConsumers.has(selected.connection) ||
    nativeConsumerOptionKeys.some((key) => selected[key] !== held.options[key])
  )
    throw new TypeError("Worker request qualified construction differs");
  assertIdentityVerificationCaptureReader(selected.identity);
  const construction = Object.freeze({});
  held.construction = construction;
  held.phase = "constructing"; // An exception/unknown cannot construct a second Accounts.
  const apiKeyAdministration = createApiKeyAdministration({
    sql: inputs.sql,
    clock: inputs.clock,
    randomId: selected.randomId,
  });
  const accounts = await createAccountsWithQualifiedLocalIssuer(selected.connection, nativeOrigin, {
    identity: selected.identity,
    apiKeyAdministration,
  });
  if (
    readWorkerRequestNativeInitializationInputs(selected.connection) !== inputs ||
    nativeInitializations.get(selected.connection) !== held ||
    held.phase !== "constructing" ||
    held.construction !== construction
  )
    throw new TypeError("Worker request qualified construction origin differs");
  return constructWorkerRequestConsumers(selected, null, {
    construction,
    accounts,
    apiKeyAdministration,
  });
}

function constructWorkerRequestConsumers(
  options: WorkerRequestConsumerOptions,
  localIdentity: (ExternalIdentityVerifier & IdentityVerificationCaptureReader) | null,
  qualified: {
    readonly construction: object;
    readonly accounts: Accounts;
    readonly apiKeyAdministration: ApiKeyAdministration;
  } | null = null,
): WorkerRequestConsumers {
  const origin = requestOrigins.get(options.connection);
  const { sql, client, realm, clock, randomId } = options;
  if (
    origin?.purpose !== "shared-auth-staging" ||
    options.connection.sql !== sql ||
    options.connection.moneyGuard !== "ready" ||
    options.publicOrigin !== SHARED_AUTH_STAGING_PROFILE.publicOrigin ||
    options.consoleOrigin !== SHARED_AUTH_STAGING_PROFILE.consoleOrigin
  )
    throw new TypeError("shared-login Worker request composition differs");
  assertMoneyCutoverSqlOrigin(sql, { writerEpoch: origin.writerEpoch });
  assertHostedBillingFinancialRealm(realm, {
    sql,
    client,
    billingAuthority: realm.billingAuthority,
  });
  if (requestConsumers.has(options.connection))
    throw new TypeError("Worker request consumers are already constructed");
  const initialization = nativeInitializations.get(options.connection);
  if (initialization) {
    readWorkerRequestNativeInitializationInputs(options.connection);
    if (
      (qualified === null
        ? initialization.phase !== "prepared"
        : initialization.phase !== "constructing" ||
          initialization.construction !== qualified.construction) ||
      nativeConsumerOptionKeys.some(
        (key) => ownNativeInitializationOption(options, key) !== initialization.options[key],
      )
    )
      throw new TypeError("Worker request constructor differs from original initialization");
    // One constructor only. A constructor exception is not permission to retry.
    initialization.phase = "constructing";
  } else if (qualified !== null)
    throw new TypeError("Worker request qualified initialization is absent");
  const apiKeyAdministration =
    qualified?.apiKeyAdministration ??
    createApiKeyAdministration({
      sql,
      clock,
      randomId,
    });
  const accountOptions = {
    sql,
    identity: options.identity,
    clock,
    randomId,
    apiKeyAdministration,
  };
  const accounts =
    qualified?.accounts ??
    (localIdentity === null
      ? createAccounts(accountOptions)
      : createAccountsWithUnregisteredLocalIssuer({
          ...accountOptions,
          identity: localIdentity,
        }));
  assertAuthTokenCaptureReader(accounts, { sql });
  const store = createSharedAuthSessionStore(sql);
  const finalStore = createSharedAuthFinalSessionStore(sql);
  const selected = options.sharedAuth;
  const sharedAuth = Object.freeze(
    createSharedAuthSession({
      config: {
        environment: SHARED_AUTH_STAGING_PROFILE.environment,
        issuer: SHARED_AUTH_STAGING_PROFILE.issuer,
        publicOrigin: SHARED_AUTH_STAGING_PROFILE.publicOrigin,
        clientId: SHARED_AUTH_STAGING_PROFILE.clientId,
        clientSecret: selected.clientSecret,
      },
      consoleOrigin: SHARED_AUTH_STAGING_PROFILE.consoleOrigin,
      encryptionKey: selected.encryptionKey,
      store: () => store,
      finalStore: () => finalStore,
      principals: selected.principals,
      ...(selected.organizations === undefined ? {} : { organizations: selected.organizations }),
      ...(selected.fetch === undefined ? {} : { fetch: selected.fetch }),
      now: () => clock().getTime(),
    }),
  );
  const consumers = Object.freeze({
    sql,
    client,
    realm,
    accounts,
    apiKeyAdministration,
    sharedAuth,
  });
  requestConsumers.set(options.connection, consumers);
  requestFinancialInputs.set(
    options.connection,
    initialization?.inputs ??
      Object.freeze({
        sql,
        client,
        realm,
        clock,
        writerEpoch: origin.writerEpoch,
      }),
  );
  if (initialization) {
    initialization.phase = "constructed";
    readWorkerRequestNativeInitializationInputs(options.connection);
  }
  return consumers;
}
