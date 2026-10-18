import {
  assertFinancialAuthConsumerPort,
  assertWorkerRequestFinancialAuthConsumerPort,
  captureWorkerRequestFinancialAuthRpRequest,
  readWorkerRequestFinancialAuthConsumerContext,
  readWorkerRequestFinancialAuthConsumerPort,
  readWorkerRequestFinancialInputs,
  readWorkerRequestRetainedRpCapture,
  type WorkerRequestSql,
} from "./financial-request-origin.ts";
import { parseSharedAuthFinancialActionConsentOriginal } from "./shared-auth-financial-consent-contract.ts";
import {
  createSharedAuthFinancialConsentLocalProofDataReader,
  createSharedAuthFinancialConsentProofReferenceReader,
  persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData,
  type SharedAuthFinancialConsentCaptureData,
  type SharedAuthFinancialConsentLocalProofData,
  type SharedAuthFinancialConsentOriginalData,
  SharedAuthFinancialConsentOriginalReadError,
} from "./shared-auth-financial-consent-store.ts";
import { captureSharedAuthFinancialRequestClockObservation } from "./shared-auth-financial-source.ts";
import { readWorkerRequestConsumers } from "./worker-request-composition.ts";

/** Addressing metadata, not a credential, human, permission or NEW selector. */
export interface SharedAuthFinancialConsentRequestSelection {
  readonly workspaceId: string;
  readonly consentProofRef: string;
}

function unavailable(): never {
  throw new SharedAuthFinancialConsentOriginalReadError("unavailable");
}

function selection(input: SharedAuthFinancialConsentRequestSelection) {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new TypeError();
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError();
    const keys = Reflect.ownKeys(input);
    if (keys.length !== 2 || !keys.includes("workspaceId") || !keys.includes("consentProofRef"))
      throw new TypeError();
    const fields = Object.getOwnPropertyDescriptors(input);
    const value = (name: "workspaceId" | "consentProofRef") => {
      const field = fields[name];
      if (!field || !("value" in field) || !field.enumerable) throw new TypeError();
      if (typeof field.value !== "string" || field.value.length === 0) throw new TypeError();
      return field.value;
    };
    return Object.freeze({
      workspaceId: value("workspaceId"),
      consentProofRef: value("consentProofRef"),
    });
  } catch {
    throw new SharedAuthFinancialConsentOriginalReadError("invalid_request");
  }
}

function method<T extends object, K extends keyof T>(receiver: T, name: K): T[K] {
  const field = Object.getOwnPropertyDescriptor(receiver, name);
  if (!field || !("value" in field) || typeof field.value !== "function") unavailable();
  return field.value;
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function sameOriginal(
  a: SharedAuthFinancialConsentOriginalData,
  b: SharedAuthFinancialConsentOriginalData,
) {
  return (
    a.originalDigest === b.originalDigest &&
    a.originalCustodySHA256 === b.originalCustodySHA256 &&
    a.recordedAt === b.recordedAt &&
    a.receiptRef === b.receiptRef &&
    a.receiptRecordedAt === b.receiptRecordedAt &&
    equalBytes(a.originalBytes, b.originalBytes) &&
    a.command.family === b.command.family &&
    a.command.capturedAt === b.command.capturedAt &&
    a.command.commandCustodySHA256 === b.command.commandCustodySHA256 &&
    equalBytes(a.command.commandBytes, b.command.commandBytes) &&
    a.command.originalDigest === b.command.originalDigest &&
    a.command.originalCustodySHA256 === b.command.originalCustodySHA256 &&
    equalBytes(a.command.originalBytes, b.command.originalBytes) &&
    Object.entries(a.command.key).every(
      ([key, value]) => Reflect.get(b.command.key, key) === value,
    ) &&
    Object.entries(a.command.selectedScope).every(
      ([key, value]) => Reflect.get(b.command.selectedScope, key) === value,
    )
  );
}

/** Actual mounted Auth originals to stored original/local DATA. This supplies no
 * qualified current-consent/NEW/dispatch permission and performs no consent write.
 * The ordinary RP observer may touch its own session. Root owns the mount.
 */
export function createSharedAuthFinancialConsentRequestHandler(connection: WorkerRequestSql) {
  const graph = readWorkerRequestConsumers(connection);
  const inputs = readWorkerRequestFinancialInputs(connection);
  const sql = inputs.sql;
  const realm = inputs.realm;
  const writerEpoch = inputs.writerEpoch;
  const query = method(graph.sql, "query");
  const run = method(graph.sql, "run");
  const observe = method(graph.sharedAuth, "observeFinalWorkspaceOrganization");
  const inspect = method(graph.sharedAuth, "finalSessionSelection");
  const historicals = createSharedAuthFinancialConsentProofReferenceReader(connection);
  const readHistorical = method(historicals, "readProofOriginalData");
  const locals = createSharedAuthFinancialConsentLocalProofDataReader(connection);
  const readLocal = method(locals, "readLocalProofOriginalData");
  function sameOrigin() {
    try {
      if (
        readWorkerRequestConsumers(connection) !== graph ||
        readWorkerRequestFinancialInputs(connection) !== inputs ||
        graph.sql !== sql ||
        inputs.sql !== sql ||
        inputs.realm !== realm ||
        inputs.writerEpoch !== writerEpoch ||
        method(graph.sql, "query") !== query ||
        method(graph.sql, "run") !== run ||
        method(graph.sharedAuth, "observeFinalWorkspaceOrganization") !== observe ||
        method(graph.sharedAuth, "finalSessionSelection") !== inspect
      )
        unavailable();
    } catch {
      return unavailable();
    }
  }

  async function readExisting(
    request: Request,
    input: SharedAuthFinancialConsentRequestSelection,
  ): Promise<SharedAuthFinancialConsentLocalProofData | undefined> {
    const selected = selection(input);
    let assertPortOrigin: () => void = sameOrigin;
    try {
      sameOrigin();
      const port = readWorkerRequestFinancialAuthConsumerPort(connection);
      if (!port) unavailable();
      const context = readWorkerRequestFinancialAuthConsumerContext(connection, port);
      if (
        !context ||
        context.sql !== sql ||
        context.realm !== realm ||
        context.writerEpoch !== writerEpoch
      )
        unavailable();
      const readCredential = method(port, "readValidatedCredential");
      const readPrincipal = method(port, "readValidatedPrincipalBinding");
      assertPortOrigin = () => {
        try {
          sameOrigin();
          if (
            readWorkerRequestFinancialAuthConsumerPort(connection) !== port ||
            readWorkerRequestFinancialAuthConsumerContext(connection, port) !== context ||
            context.sql !== sql ||
            context.realm !== realm ||
            context.writerEpoch !== writerEpoch ||
            method(port, "readValidatedCredential") !== readCredential ||
            method(port, "readValidatedPrincipalBinding") !== readPrincipal
          )
            unavailable();
          assertWorkerRequestFinancialAuthConsumerPort(connection, port);
          assertFinancialAuthConsumerPort(port, context);
        } catch {
          unavailable();
        }
      };
      assertPortOrigin();
      if (!(request instanceof Request)) unavailable();
      const captures = await captureWorkerRequestFinancialAuthRpRequest(
        port,
        request,
        selected.workspaceId,
      );
      assertPortOrigin();
      if (!captures) unavailable();
      const credential = port.readValidatedCredential(captures.credential);
      assertPortOrigin();
      if (credential.backend !== "shared-rp-session") unavailable();
      const principal = port.readValidatedPrincipalBinding(captures.userBinding);
      assertPortOrigin();
      const credentialOriginal = readWorkerRequestRetainedRpCapture(
        connection,
        captures.credential,
      );
      assertPortOrigin();
      if (
        !credentialOriginal ||
        credentialOriginal.record !== credential.record ||
        credentialOriginal.current !== credential.current
      )
        unavailable();
      const { record, finalSession, selectedScope } = credentialOriginal;
      const { binding } = principal;
      const historical = await Reflect.apply(readHistorical, historicals, [
        selected.consentProofRef,
      ]);
      assertPortOrigin();
      const original = await parseSharedAuthFinancialActionConsentOriginal(
        historical.original.originalBytes,
      );
      assertPortOrigin();
      const identity = original.rpSession.identity;
      if (
        original.consentRef !== selected.consentProofRef ||
        original.rpSession.accountId !== finalSession.accountId ||
        original.rpSession.accountId !== record.rp.accountId ||
        identity.issuer !== finalSession.identity.issuer ||
        identity.clientId !== finalSession.identity.clientId ||
        identity.subject !== finalSession.identity.subject ||
        identity.sessionId !== finalSession.identity.sessionId ||
        identity.authTime !== finalSession.identity.authTime ||
        original.rpSession.sessionDigest !== finalSession.sessionDigest ||
        original.rpSession.observedPrincipalId !== finalSession.principalId ||
        original.rpSession.observedPrincipalId !== binding.principalId ||
        original.principalBinding.ref !== binding.ref ||
        original.principalBinding.ref !== record.rp.principalBindingRef ||
        original.credentialClass.ref !== record.origin.ref ||
        original.credentialClass.incarnation !== record.origin.incarnation ||
        original.path.workspaceId !== selected.workspaceId ||
        original.path.workspaceId !== selectedScope.workspaceId ||
        original.path.workspaceRef !== selectedScope.workspaceRef ||
        original.path.organizationId !== selectedScope.organizationId
      )
        unavailable();
      // No mapping is invented for original.principalBinding.digest/incarnation,
      // credentialClass.digest or the independent consentIssuer triple. Qualified owning
      // readers/issuers and Financial R1 admission remain required separately.
      const result = await Reflect.apply(readLocal, locals, [
        {
          consentProofRef: selected.consentProofRef,
          credential: record,
          human: binding,
          currentSession: credentialOriginal.current,
        },
      ]);
      assertPortOrigin();
      if (result === undefined) return undefined;
      if (
        result.consentProofRef !== selected.consentProofRef ||
        !sameOriginal(historical.original, result.original)
      )
        unavailable();
      return result;
    } catch (error) {
      assertPortOrigin();
      if (error instanceof SharedAuthFinancialConsentOriginalReadError) throw error;
      return unavailable();
    }
  }

  /**
   * Unmounted DATA write entry: one Root final observation and one native
   * required batch on the same request graph. This grants no affirmative or
   * current consent, Financial NEW admission or first-dispatch permission.
   */
  async function persistObservedData(
    request: Request,
    workspaceId: string,
    input: SharedAuthFinancialConsentCaptureData,
  ): Promise<SharedAuthFinancialConsentOriginalData> {
    try {
      sameOrigin();
      if (
        !(request instanceof Request) ||
        typeof workspaceId !== "string" ||
        workspaceId.length === 0
      )
        unavailable();
      const observation = await captureSharedAuthFinancialRequestClockObservation(
        connection,
        request,
        workspaceId,
      );
      sameOrigin();
      const result = await persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData(
        connection,
        request,
        workspaceId,
        observation,
        input,
      );
      sameOrigin();
      return result;
    } catch (error) {
      sameOrigin();
      if (error instanceof SharedAuthFinancialConsentOriginalReadError) throw error;
      return unavailable();
    }
  }
  return Object.freeze({ readExisting, persistObservedData });
}
