import {
  type Accounts,
  type ApiKeyAdministration,
  type AuthTokenCaptureReader,
  assertAuthTokenCaptureReader,
  createAccounts,
  createAccountsWithUnregisteredLocalIssuer,
  createApiKeyAdministration,
  type ExternalIdentityVerifier,
} from "./auth.ts";
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
import type { Clock, Row, Sql } from "./ports.ts";
import { SHARED_AUTH_STAGING_PROFILE } from "./shared-auth-oidc-client.ts";
import {
  createSharedAuthSession,
  type SharedAuthOrganizationPins,
  type SharedAuthPrincipalProjection,
  type SharedAuthSession,
} from "./shared-auth-session.ts";
import {
  createSharedAuthFinalSessionStore,
  createSharedAuthSessionStore,
} from "./shared-auth-session-store.ts";
import { createD1Sql, type D1DatabaseLike } from "./sql-d1.ts";
import type { StripeBillingClient } from "./stripe-billing-client.ts";

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
  const rawSql = createD1Sql(nativeSession, { acknowledgement: "explicit-d1-result" });
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
      resolve: (input: Parameters<SharedAuthPrincipalProjection["resolve"]>[0]) =>
        Reflect.apply(resolvePrincipal, principalReceiver, [input]),
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

/** Original in-process RP observer/selection port; no HTTP path or raw Sql accessor. */
export function readWorkerRequestConsumers(connection: WorkerRequestSql): WorkerRequestConsumers {
  const consumers = requestConsumers.get(connection);
  const origin = requestOrigins.get(connection);
  if (!consumers || origin?.purpose !== "shared-auth-staging" || consumers.sql !== connection.sql)
    throw new TypeError("Worker request consumers have not been constructed");
  assertMoneyCutoverSqlOrigin(consumers.sql, { writerEpoch: origin.writerEpoch });
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

function constructWorkerRequestConsumers(
  options: WorkerRequestConsumerOptions,
  localIdentity: (ExternalIdentityVerifier & IdentityVerificationCaptureReader) | null,
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
  const apiKeyAdministration = createApiKeyAdministration({ sql, clock, randomId });
  const accountOptions = {
    sql,
    identity: options.identity,
    clock,
    randomId,
    apiKeyAdministration,
  };
  const accounts =
    localIdentity === null
      ? createAccounts(accountOptions)
      : createAccountsWithUnregisteredLocalIssuer({ ...accountOptions, identity: localIdentity });
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
    Object.freeze({ sql, client, realm, clock, writerEpoch: origin.writerEpoch }),
  );
  return consumers;
}
