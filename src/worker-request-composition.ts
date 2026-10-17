import {
  type Accounts,
  type ApiKeyAdministration,
  type AuthTokenCaptureReader,
  assertAuthTokenCaptureReader,
  createAccounts,
  createApiKeyAdministration,
  type ExternalIdentityVerifier,
} from "./auth.ts";
import {
  assertHostedBillingFinancialRealm,
  type HostedBillingFinancialRealm,
} from "./hosted-billing-realm.ts";
import {
  assertMoneyCutoverSqlOrigin,
  createMoneyCutoverSql,
  inspectMoneyCutoverGuard,
  type MoneyCutoverGuardState,
} from "./money-cutover-sql.ts";
import type { Clock, Sql } from "./ports.ts";
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
  { readonly writerEpoch: string; readonly purpose: WorkerRequestOriginPurpose }
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
  const writerEpoch = options.writerEpoch;
  const moneyGuard = await inspectMoneyCutoverGuard(rawSql, writerEpoch);
  const sql = createMoneyCutoverSql(rawSql, writerEpoch);
  assertMoneyCutoverSqlOrigin(sql, { writerEpoch });
  const connection = Object.freeze({ sql, moneyGuard });
  requestOrigins.set(connection, Object.freeze({ writerEpoch, purpose }));
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
 * App's sole Accounts and RP constructors share the already verified financial
 * realm's exact Sql/client. Origin checks are local identity checks, not a
 * substitute for the RP's current row or a Financial effect's own admission.
 */
export function createWorkerRequestConsumers(
  options: WorkerRequestAppInputs & {
    readonly sql: Sql;
    readonly identity: ExternalIdentityVerifier;
    readonly clock: Clock;
    readonly randomId: () => string;
    readonly publicOrigin: string;
    readonly consoleOrigin: string | undefined;
  },
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
  const accounts = createAccounts({
    sql,
    identity: options.identity,
    clock,
    randomId,
    apiKeyAdministration,
  });
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
