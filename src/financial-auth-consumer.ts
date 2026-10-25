import {
  type Auth103NativeRequestOrigin,
  auth103NativeRequestCurrentness,
  qualifyAuth103NativeRequestOrigin,
  readAuth103NativeRequestOrigin,
  readAuth103NativeRpRegistrationOriginal,
} from "./auth103-native-origin-source.ts";
import type { Auth103NativeStorageSourceProfile } from "./auth103-native-source-contract.ts";
import { createAuth103SourceClock, readAuth103SourceClock } from "./auth103-source-clock.ts";
import type { HostedBillingFinancialRealm } from "./hosted-billing-realm.ts";
import type { Clock, Sql } from "./ports.ts";
import type { PrincipalAnchor, SharedPrincipalBinding } from "./shared-principal-authority.ts";
import {
  assertWorkerRequestBackingOrigin,
  captureWorkerRequestRetainedRpSession,
  createWorkerRequestConsumersWithQualifiedLocalIssuer,
  initializeWorkerRequestNativeInputs,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  type WorkerRequestRetainedRpCapture,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";
import { readWorkerRequestRetainedDirectKeyCapture } from "./worker-request-direct-owner-key.ts";
import {
  createWorkerRequestFinancialAuthOriginalReaders,
  readWorkerRequestAuthenticatedRpUserBindingOriginal,
  type WorkerRequestAuthenticatedRpUserBindingOriginal,
  type WorkerRequestCredentialOriginalData,
} from "./worker-request-financial-auth-original.ts";
import {
  captureWorkerRequestResolvedRpUserBindingOriginal,
  prepareWorkerRequestOriginalRpConsumerOptions,
} from "./worker-request-shared-principal-issuance.ts";

export class FinancialAuthConsumerUnavailable extends Error {
  readonly code = "unavailable" as const;
  constructor() {
    super("financial_auth_consumer_unavailable");
    this.name = "FinancialAuthConsumerUnavailable";
  }
}

/** Existing Financial0b9 ABI. Selection is not final same-primary CAS permission. */
export interface FinancialAuthConsumerPort {
  readValidatedCredential(opaqueCredentialCapture: unknown): WorkerRequestCredentialOriginalData;
  readValidatedPrincipalBinding(opaqueUserBindingCapture: unknown): {
    readonly anchor: PrincipalAnchor;
    readonly binding: SharedPrincipalBinding;
  };
}

export interface FinancialAuthConsumerContext {
  readonly sql: Sql;
  readonly realm: HostedBillingFinancialRealm;
  readonly sourceProfile: Auth103NativeStorageSourceProfile;
  readonly writerEpoch: string | undefined;
  readonly authSchemaRef: string;
  readonly targetRef: string;
}

function unavailable(): never {
  throw new FinancialAuthConsumerUnavailable();
}
function ownData(receiver: object, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(receiver, key);
  if (!d || !("value" in d)) return unavailable();
  return d.value;
}

const portOrigins = new WeakMap<
  FinancialAuthConsumerPort,
  {
    readonly connection: WorkerRequestSql;
    readonly assertOriginal: () => void;
    readonly context: FinancialAuthConsumerContext;
    readonly credential: FinancialAuthConsumerPort["readValidatedCredential"];
    readonly principal: FinancialAuthConsumerPort["readValidatedPrincipalBinding"];
    readonly sourceCurrentness: () => ReturnType<typeof auth103NativeRequestCurrentness>;
  }
>();
const requestFinancialAuthPorts = new WeakMap<WorkerRequestSql, FinancialAuthConsumerPort>();

/** Static owning assertion: no self method, callback, DTO or caller ref can mint it. */
export function assertFinancialAuthConsumerPort(
  port: unknown,
  context: FinancialAuthConsumerContext,
): asserts port is FinancialAuthConsumerPort {
  try {
    if (!port || typeof port !== "object") return unavailable();
    const held = portOrigins.get(port as FinancialAuthConsumerPort);
    if (!held || !context || typeof context !== "object") return unavailable();
    const keys = [
      "sql",
      "realm",
      "sourceProfile",
      "writerEpoch",
      "authSchemaRef",
      "targetRef",
    ] as const;
    const selected = keys.map((key) => ownData(context, key));
    if (
      keys.some((key, i) => selected[i] !== held.context[key]) ||
      (held.context.sourceProfile === "ordinary" && held.context.writerEpoch !== undefined) ||
      (held.context.sourceProfile === "money-preserved" &&
        typeof held.context.writerEpoch !== "string") ||
      ownData(port, "readValidatedCredential") !== held.credential ||
      ownData(port, "readValidatedPrincipalBinding") !== held.principal
    )
      return unavailable();
    held.assertOriginal();
  } catch {
    return unavailable();
  }
}

/**
 * Fixed owning predicate for the final same-primary consumer batch. It is bound
 * to the actual native original, including separate RP registration/receipt;
 * callers cannot supply SQL, refs or a claimed currentness boolean.
 */
export function financialAuthConsumerSourceCurrentness(
  port: FinancialAuthConsumerPort,
  context: FinancialAuthConsumerContext,
): ReturnType<typeof auth103NativeRequestCurrentness> {
  try {
    assertFinancialAuthConsumerPort(port, context);
    const held = portOrigins.get(port);
    if (!held) return unavailable();
    const predicate = held.sourceCurrentness();
    assertFinancialAuthConsumerPort(port, context);
    return predicate;
  } catch {
    return unavailable();
  }
}

/** Same owning port and original graph; no raw origin/context is returned. */
export function assertWorkerRequestFinancialAuthConsumerPort(
  connection: WorkerRequestSql,
  port: unknown,
): asserts port is FinancialAuthConsumerPort {
  try {
    if (!port || typeof port !== "object") return unavailable();
    const held = portOrigins.get(port as FinancialAuthConsumerPort);
    if (!held || held.connection !== connection) return unavailable();
    assertFinancialAuthConsumerPort(port, held.context);
  } catch {
    return unavailable();
  }
}

/** Existing mounted original only. Absence cannot authorize a second graph. */
export function readWorkerRequestFinancialAuthConsumerPort(
  connection: WorkerRequestSql,
): FinancialAuthConsumerPort | null {
  try {
    assertWorkerRequestBackingOrigin(connection);
    const port = requestFinancialAuthPorts.get(connection);
    if (!port) return null;
    assertWorkerRequestFinancialAuthConsumerPort(connection, port);
    return port;
  } catch {
    return unavailable();
  }
}

/** Original selection metadata for the existing required static assertion. */
export function readWorkerRequestFinancialAuthConsumerContext(
  connection: WorkerRequestSql,
  port: unknown,
): FinancialAuthConsumerContext | null {
  try {
    if (!port || typeof port !== "object") return null;
    const held = portOrigins.get(port as FinancialAuthConsumerPort);
    if (!held || held.connection !== connection) return null;
    assertWorkerRequestFinancialAuthConsumerPort(connection, port);
    return held.context;
  } catch {
    return unavailable();
  }
}

/**
 * Successful only after the real native owner authenticates actual platform
 * binding + code-built source/target/schema/Clock manifest + same-primary
 * immutable registration and canonical catalog. No equivalent input DTO exists.
 */
export async function createWorkerRequestFinancialAuthConsumerPort(
  connection: WorkerRequestSql,
): Promise<FinancialAuthConsumerPort> {
  try {
    assertWorkerRequestBackingOrigin(connection);
    const native = await qualifyAuth103NativeRequestOrigin(connection);
    return createFinancialAuthConsumerPortFromOriginal(connection, native);
  } catch {
    return unavailable();
  }
}

function createFinancialAuthConsumerPortFromOriginal(
  connection: WorkerRequestSql,
  native: Auth103NativeRequestOrigin,
): FinancialAuthConsumerPort {
  try {
    if (requestFinancialAuthPorts.has(connection)) return unavailable();
    assertWorkerRequestBackingOrigin(connection);
    const inputs = readWorkerRequestFinancialInputs(connection);
    const consumers = readWorkerRequestConsumers(connection);
    const clock = readAuth103SourceClock(inputs.clock);
    if (!clock) return unavailable();
    assertWorkerRequestBackingOrigin(connection);
    if (
      readWorkerRequestFinancialInputs(connection) !== inputs ||
      readWorkerRequestConsumers(connection) !== consumers
    )
      return unavailable();
    const qualified = readAuth103NativeRequestOrigin(native, connection);
    const rpRegistration = readAuth103NativeRpRegistrationOriginal(native, connection);
    if (!qualified || !rpRegistration) return unavailable();
    const nativeKeys = [
      "authSchemaRef",
      "targetRef",
      "sourceRef",
      "clockPolicyRef",
      "sourceProfile",
    ] as const;
    if (nativeKeys.some((key) => rpRegistration.native[key] !== qualified[key]))
      return unavailable();
    const originals = createWorkerRequestFinancialAuthOriginalReaders(connection);
    const assertOriginal = () => {
      assertWorkerRequestBackingOrigin(connection);
      if (
        readWorkerRequestFinancialInputs(connection) !== inputs ||
        readWorkerRequestConsumers(connection) !== consumers ||
        readAuth103SourceClock(inputs.clock) !== clock
      )
        return unavailable();
      const current = readAuth103NativeRequestOrigin(native, connection);
      const currentRp = readAuth103NativeRpRegistrationOriginal(native, connection);
      if (
        !current ||
        current.authSchemaRef !== qualified.authSchemaRef ||
        current.targetRef !== qualified.targetRef ||
        current.sourceRef !== qualified.sourceRef ||
        current.clockPolicyRef !== qualified.clockPolicyRef ||
        current.sourceProfile !== qualified.sourceProfile ||
        !currentRp ||
        currentRp.registrationRef !== rpRegistration.registrationRef ||
        currentRp.registrationDigest !== rpRegistration.registrationDigest ||
        currentRp.issuerSourceRef !== rpRegistration.issuerSourceRef ||
        nativeKeys.some((key) => currentRp.native[key] !== qualified[key]) ||
        (["environment", "issuer", "clientId", "publicOrigin", "consoleOrigin"] as const).some(
          (key) => currentRp.profile[key] !== rpRegistration.profile[key],
        )
      )
        return unavailable();
    };
    const context: FinancialAuthConsumerContext = Object.freeze({
      sql: inputs.sql,
      realm: inputs.realm,
      sourceProfile: qualified.sourceProfile,
      writerEpoch: inputs.writerEpoch,
      authSchemaRef: qualified.authSchemaRef,
      targetRef: qualified.targetRef,
    });
    const port: FinancialAuthConsumerPort = Object.freeze({
      readValidatedCredential(original: unknown) {
        try {
          assertOriginal();
          const retained = originals.readCredentialOriginalData(original);
          const key = readWorkerRequestRetainedDirectKeyCapture(connection, original);
          // Static owning handle readers, not absence-based dispatch or family
          // fallback. Exactly ONE original may authenticate this opaque input.
          if ((retained === null) === (key === null)) return unavailable();
          const selected =
            retained ??
            (key === null
              ? null
              : Object.freeze({
                  backend: key.backend,
                  record: key.record,
                  capturedExpiresAt: key.captured.expiresAt,
                }));
          assertOriginal();
          // Exact actual native target; unregistered local candidates never pass.
          if (!selected || selected.record.origin.targetRef !== qualified.targetRef)
            return unavailable();
          if (
            selected.backend === "shared-rp-session" &&
            (selected.record.rp.registrationRef !== rpRegistration.registrationRef ||
              selected.record.rp.registrationDigest !== rpRegistration.registrationDigest ||
              selected.record.rp.issuer !== rpRegistration.profile.issuer ||
              selected.record.rp.clientId !== rpRegistration.profile.clientId)
          )
            return unavailable();
          return selected;
        } catch {
          return unavailable();
        }
      },
      readValidatedPrincipalBinding(original: unknown) {
        try {
          assertOriginal();
          const selected = readWorkerRequestAuthenticatedRpUserBindingOriginal(
            connection,
            original,
          );
          assertOriginal();
          if (
            !selected ||
            selected.inputs !== inputs ||
            selected.binding.targetRef !== qualified.targetRef ||
            selected.registrationOriginal.ref !== rpRegistration.registrationRef ||
            selected.registrationOriginal.digest !== rpRegistration.registrationDigest ||
            selected.binding.issuer !== rpRegistration.profile.issuer
          )
            return unavailable();
          return Object.freeze({
            anchor: selected.anchor,
            binding: selected.binding,
          });
        } catch {
          return unavailable();
        }
      },
    });
    portOrigins.set(port, {
      connection,
      assertOriginal,
      context,
      credential: port.readValidatedCredential,
      principal: port.readValidatedPrincipalBinding,
      sourceCurrentness: () => {
        assertOriginal();
        const predicate = auth103NativeRequestCurrentness(native, connection);
        assertOriginal();
        return predicate;
      },
    });
    assertFinancialAuthConsumerPort(port, context);
    requestFinancialAuthPorts.set(connection, port);
    return port;
  } catch {
    return unavailable();
  }
}

export interface FinancialAuthRpRequestCaptures {
  readonly credential: WorkerRequestRetainedRpCapture;
  readonly userBinding: WorkerRequestAuthenticatedRpUserBindingOriginal;
}

/**
 * Actual request callsite: one owning RP final observer completes its original
 * projection before the separate user-binding capture. Neither request fields
 * nor a structural port can supply either original. Unknown is never retried.
 */
export async function captureWorkerRequestFinancialAuthRpRequest(
  port: FinancialAuthConsumerPort,
  request: Request,
  workspaceId: string,
): Promise<FinancialAuthRpRequestCaptures | null> {
  try {
    if (!port || typeof port !== "object") return unavailable();
    const held = portOrigins.get(port);
    if (!held) return unavailable();
    assertFinancialAuthConsumerPort(port, held.context);
    const credential = await captureWorkerRequestRetainedRpSession(
      held.connection,
      request,
      workspaceId,
    );
    assertFinancialAuthConsumerPort(port, held.context);
    if (!credential) return null;
    const userBinding = await captureWorkerRequestResolvedRpUserBindingOriginal(
      held.connection,
      credential,
    );
    assertFinancialAuthConsumerPort(port, held.context);
    if (!userBinding) return null;
    // Validate the exact same selected records before exposing their distinct
    // opaque handles. Final allNEW/current admission still belongs to Financial.
    port.readValidatedCredential(credential);
    port.readValidatedPrincipalBinding(userBinding);
    assertFinancialAuthConsumerPort(port, held.context);
    return Object.freeze({ credential, userBinding });
  } catch {
    return unavailable();
  }
}

/**
 * Explicit code-owned branch. The actual one source Clock enters the original
 * common graph before native qualification. Default/ordinary App construction
 * is unchanged. Fresh RP callbacks still require their separate original issuer.
 */
export async function createWorkerRequestConsumersWithFinancialAuth(
  options: Omit<
    Parameters<typeof createWorkerRequestConsumersWithQualifiedLocalIssuer>[0],
    "clock"
  >,
) {
  return await createWorkerRequestConsumersWithFinancialAuthSourceClock(
    options,
    createAuth103SourceClock(),
  );
}

/**
 * Entry chooses the source-owned Clock before creating its canonical Financial
 * realm/composition. An arbitrary caller function cannot select this path.
 */
export async function createWorkerRequestConsumersWithFinancialAuthSourceClock(
  options: Omit<
    Parameters<typeof createWorkerRequestConsumersWithQualifiedLocalIssuer>[0],
    "clock"
  >,
  clock: Clock,
) {
  try {
    if (!readAuth103SourceClock(clock)) return unavailable();
    if (!options || typeof options !== "object") return unavailable();
    const fields = [
      "connection",
      "sql",
      "client",
      "realm",
      "identity",
      "randomId",
      "publicOrigin",
      "consoleOrigin",
      "sharedAuth",
    ] as const;
    const selected = Object.fromEntries(
      fields.map((key) => [key, ownData(options, key)]),
    ) as unknown as typeof options;
    assertWorkerRequestBackingOrigin(selected.connection);
    const prepared = Object.freeze({
      ...prepareWorkerRequestOriginalRpConsumerOptions({ ...selected, clock }),
      identity: selected.identity,
    });
    initializeWorkerRequestNativeInputs(prepared);
    const native = await qualifyAuth103NativeRequestOrigin(selected.connection);
    const consumers = await createWorkerRequestConsumersWithQualifiedLocalIssuer(prepared, native);
    const port = createFinancialAuthConsumerPortFromOriginal(selected.connection, native);
    assertWorkerRequestBackingOrigin(selected.connection);
    if (
      readWorkerRequestConsumers(selected.connection) !== consumers ||
      readWorkerRequestFinancialInputs(selected.connection).clock !== clock
    )
      return unavailable();
    return Object.freeze({ consumers, port, clock });
  } catch {
    return unavailable();
  }
}
