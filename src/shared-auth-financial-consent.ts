import {
  assertFinancialAuthConsumerPort,
  assertWorkerRequestFinancialAuthConsumerPort,
  captureWorkerRequestFinancialAuthRpRequest,
  readWorkerRequestFinancialAuthConsumerContext,
  readWorkerRequestFinancialAuthConsumerPort,
} from "./financial-auth-consumer.ts";
import { base64UrlDecode, base64UrlEncode, bytesDigest, canonicalJson } from "./json.ts";
import {
  createSharedAuthFinancialActionConsentCaptureKeyData,
  parseSharedAuthFinancialActionConsentOriginal,
} from "./shared-auth-financial-consent-contract.ts";
import { createSharedAuthFinancialConsentIssuerSource } from "./shared-auth-financial-consent-issuer.ts";
import {
  parseSharedAuthFinancialConfirmationSubmissionCandidate,
  renderSharedAuthFinancialPreparedConsentView,
  type SharedAuthFinancialConfirmationSubmissionData,
} from "./shared-auth-financial-consent-request.ts";
import {
  createSharedAuthFinancialConsentLocalProofDataReader,
  createSharedAuthFinancialConsentProofReferenceReader,
  persistCaptureAndConsumeSharedAuthFinancialConsentObservedRequestData,
  prepareSharedAuthFinancialConsentPendingFromObservation,
  readSharedAuthFinancialConsentPreparedPendingForPost,
  type SharedAuthFinancialConsentCaptureData,
  type SharedAuthFinancialConsentLocalProofData,
  type SharedAuthFinancialConsentOriginalData,
  SharedAuthFinancialConsentOriginalReadError,
  type SharedAuthFinancialConsentPendingData,
  snapshotSharedAuthFinancialConsentRequestCaptureData,
} from "./shared-auth-financial-consent-store.ts";
import {
  captureSharedAuthFinancialRequestClockObservation,
  captureSharedAuthFinancialRequestClockObservationFromR1,
  proveSharedAuthFinancialRequestIdentityFromObservation,
  readSharedAuthFinancialRequestNativeObservationData,
} from "./shared-auth-financial-source.ts";
import {
  createFinancialActionConsentR1Reader,
  type FinancialActionConsentR1Original,
} from "./shared-financial-retained-r1.ts";
import { financialSourceRef } from "./shared-financial-source-contract.ts";
import {
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  readWorkerRequestRetainedRpCapture,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";

/** Addressing metadata, not a credential, human, permission or NEW selector. */
export interface SharedAuthFinancialConsentRequestSelection {
  readonly workspaceId: string;
  readonly consentProofRef: string;
}

/** Root/Clock/issuer/local-original observation DATA, not current consent. */
export interface SharedAuthFinancialConsentUnexpiredLocalData {
  readonly state: "unexpired-consent-local-data";
  readonly sampledAt: number;
  readonly local: SharedAuthFinancialConsentLocalProofData;
}

/** Exact retained R1 plus local Root/Clock/issuer/original DATA at this read.
 * A later Financial NEW or first-dispatch effect needs its own same-primary
 * currentness and CAS; this witness does not authorize either effect. */
export interface SharedAuthFinancialConsentLocalCurrentWitness {
  readonly state: "financial-action-consent-local-current-witness";
  readonly consentProofRef: string;
  readonly sampledAt: number;
  readonly originalDigest: string;
}

/** A detached copy of the existing receipted original, still only local DATA. */
export interface SharedAuthFinancialConsentCurrentOriginalData {
  readonly sampledAt: number;
  readonly original: SharedAuthFinancialConsentOriginalData;
}

type NativeObservation = ReturnType<typeof readSharedAuthFinancialRequestNativeObservationData>;
type ParsedConsent = Awaited<ReturnType<typeof parseSharedAuthFinancialActionConsentOriginal>>;

interface HeldCurrentOriginal {
  readonly handler: object;
  readonly connection: WorkerRequestSql;
  readonly request: Request;
  readonly workspaceId: string;
  readonly consentProofRef: string;
  readonly sampledAt: number;
  readonly observation: unknown;
  readonly native: NativeObservation;
  readonly original: SharedAuthFinancialConsentOriginalData;
  readonly baseline: SharedAuthFinancialConsentOriginalData;
  readonly consent: ParsedConsent;
  readonly retained: FinancialActionConsentR1Original;
  readonly finalRetained: FinancialActionConsentR1Original;
  readonly assertOrigin: () => void;
}

const currentOriginalOrigins = new WeakMap<object, HeldCurrentOriginal>();

function sameNativeObservation(a: NativeObservation, b: NativeObservation): boolean {
  return (
    a.selectedScope === b.selectedScope &&
    a.sampledAt === b.sampledAt &&
    a.credential === b.credential &&
    a.human === b.human &&
    a.currentSession === b.currentSession &&
    a.finalSession === b.finalSession
  );
}

function detachReceiptedOriginal(
  original: SharedAuthFinancialConsentOriginalData,
): SharedAuthFinancialConsentOriginalData {
  const command = original.command;
  return Object.freeze({
    state: "receipted-original-data",
    command: Object.freeze({
      key: Object.freeze({
        registrationRef: command.key.registrationRef,
        incarnation: command.key.incarnation,
        transactionRef: command.key.transactionRef,
        commandRef: command.key.commandRef,
        consentRef: command.key.consentRef,
        receiptRef: command.key.receiptRef,
      }),
      selectedScope: Object.freeze({
        organizationId: command.selectedScope.organizationId,
        workspaceId: command.selectedScope.workspaceId,
        workspaceRef: command.selectedScope.workspaceRef,
      }),
      family: command.family,
      commandBytes: new Uint8Array(command.commandBytes),
      commandCustodySHA256: command.commandCustodySHA256,
      originalBytes: new Uint8Array(command.originalBytes),
      originalDigest: command.originalDigest,
      originalCustodySHA256: command.originalCustodySHA256,
      capturedAt: command.capturedAt,
    }),
    originalBytes: new Uint8Array(original.originalBytes),
    originalDigest: original.originalDigest,
    originalCustodySHA256: original.originalCustodySHA256,
    recordedAt: original.recordedAt,
    receiptRef: original.receiptRef,
    receiptRecordedAt: original.receiptRecordedAt,
  });
}

/** Read only an already completed verifier's exact original and receipt DATA.
 * This performs no R1 GET, Root observation, Clock sample, SQL or write. */
export function readSharedAuthFinancialConsentCurrentOriginalData(
  handler: object,
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  witness: unknown,
): SharedAuthFinancialConsentCurrentOriginalData {
  try {
    if (!witness || typeof witness !== "object") unavailable();
    const held = currentOriginalOrigins.get(witness);
    if (
      !held ||
      held.handler !== handler ||
      held.connection !== connection ||
      held.request !== request ||
      held.workspaceId !== workspaceId ||
      held.consentProofRef !== held.original.command.key.consentRef ||
      held.original.state !== "receipted-original-data"
    )
      unavailable();
    held.assertOrigin();
    const now = readSharedAuthFinancialRequestNativeObservationData(
      connection,
      request,
      workspaceId,
      held.observation,
    );
    if (
      !sameNativeObservation(now, held.native) ||
      held.sampledAt !== now.sampledAt ||
      !sameOriginal(held.original, held.baseline) ||
      held.retained.fullCommandJson !== held.finalRetained.fullCommandJson ||
      held.retained.r1ReceiptRef !== held.finalRetained.r1ReceiptRef ||
      held.retained.c0ReceiptRef !== held.finalRetained.c0ReceiptRef
    )
      unavailable();
    assertSameFinancialR1Original(held.consent, held.retained);
    assertSameFinancialR1Original(held.consent, held.finalRetained);
    const detached = detachReceiptedOriginal(held.baseline);
    held.assertOrigin();
    const last = readSharedAuthFinancialRequestNativeObservationData(
      connection,
      request,
      workspaceId,
      held.observation,
    );
    if (!sameNativeObservation(last, held.native) || !sameOriginal(held.original, held.baseline))
      unavailable();
    held.assertOrigin();
    return Object.freeze({ sampledAt: held.sampledAt, original: detached });
  } catch {
    return unavailable();
  }
}

/** Server-side presentation input from Financial's exact retained original.
 * It records neither HTTP delivery nor the later user's affirmation. */
export interface SharedAuthFinancialR1PresentationData {
  readonly state: "financial-r1-presentation-data";
  /** Existing private rpfc form address from the fixed capture-key v2 tuple. */
  readonly transactionRef: string;
  readonly challengeRef: string;
  readonly requestFingerprint: string;
  readonly actionIdentity: FinancialActionConsentR1Original["actionIdentity"];
  readonly selectedTerms: FinancialActionConsentR1Original["selectedTerms"];
  readonly r1ReceiptRef: string;
  readonly c0ReceiptRef: string;
}

/** Prepared GET DATA. A caller must separately deliver the HTML response;
 * neither this result nor pending29 is an affirmative action or NEW grant. */
export interface SharedAuthFinancialPreparedConsentViewData {
  readonly state: "prepared-financial-consent-view-data";
  readonly transactionRef: string;
  readonly disclosureRef: string;
  readonly html: string;
  readonly disposition: "strict-insert-ack" | "original-get";
}

/** Query-only POST preflight over the prepared GET original. No affirmative
 * consent, acceptedAt, command claim, current permission or Financial effect. */
export interface SharedAuthFinancialPreparedSubmissionData {
  readonly state: "prepared-financial-consent-submission-data";
  readonly submission: SharedAuthFinancialConfirmationSubmissionData;
  readonly pending: SharedAuthFinancialConsentPendingData;
}

/** A proof reference obtained from the same prepared POST original. This is
 * identity-proof DATA only: it grants neither consent nor NEW/CAS dispatch. */
export interface SharedAuthFinancialPreparedIdentityProofData {
  readonly proofRef: string;
}

interface HeldPreparedSubmission {
  readonly handler: object;
  readonly connection: WorkerRequestSql;
  readonly request: Request;
  readonly workspaceId: string;
  readonly challengeRef: string;
  readonly reader: ReturnType<typeof createFinancialActionConsentR1Reader>;
  readonly retained: FinancialActionConsentR1Original;
  readonly readR1: ReturnType<
    typeof createFinancialActionConsentR1Reader
  >["readRetainedActionConsentR1"];
  readonly observation: unknown;
  readonly native: NativeObservation;
  readonly pendingValues: ReadonlyMap<string, unknown>;
  readonly assertOrigin: () => void;
  readonly assertRequestOrigin: () => void;
}

const preparedSubmissionOrigins = new WeakMap<object, HeldPreparedSubmission>();
const preparedProofAttempts = new WeakMap<
  object,
  Promise<SharedAuthFinancialPreparedIdentityProofData>
>();

function detachedPendingValues(
  pending: SharedAuthFinancialConsentPendingData,
): ReadonlyMap<string, unknown> {
  const values = new Map<string, unknown>();
  const descriptors = Object.getOwnPropertyDescriptors(pending);
  for (const key of Reflect.ownKeys(descriptors)) {
    if (typeof key !== "string") unavailable();
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) unavailable();
    values.set(
      key,
      descriptor.value instanceof Uint8Array ? new Uint8Array(descriptor.value) : descriptor.value,
    );
  }
  return values;
}

function sameDetachedPending(
  baseline: ReadonlyMap<string, unknown>,
  pending: SharedAuthFinancialConsentPendingData,
): boolean {
  const descriptors = Object.getOwnPropertyDescriptors(pending);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.length !== baseline.size) return false;
  return keys.every((key) => {
    if (typeof key !== "string" || !baseline.has(key)) return false;
    const descriptor = descriptors[key];
    if (!descriptor || !("value" in descriptor) || !descriptor.enumerable) return false;
    const before = baseline.get(key);
    const after = descriptor.value;
    return before instanceof Uint8Array && after instanceof Uint8Array
      ? equalBytes(before, after)
      : before === after;
  });
}

function proofReferenceData(value: unknown): SharedAuthFinancialPreparedIdentityProofData {
  if (!value || typeof value !== "object" || Array.isArray(value)) unavailable();
  const keys = Reflect.ownKeys(value);
  if (keys.length !== 1 || keys[0] !== "proofRef") unavailable();
  const descriptor = Object.getOwnPropertyDescriptor(value, "proofRef");
  if (
    !descriptor ||
    !("value" in descriptor) ||
    !descriptor.enumerable ||
    !financialSourceRef(descriptor.value)
  )
    unavailable();
  return Object.freeze({ proofRef: descriptor.value });
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

async function transactionRefForR1(original: FinancialActionConsentR1Original): Promise<string> {
  const action = original.actionIdentity.action;
  const challengeRef = original.original.challengeRef;
  if (
    original.actionIdentity.requestFingerprint !== original.original.c0.challenge.requestFingerprint
  )
    unavailable();
  const captureKey = await createSharedAuthFinancialActionConsentCaptureKeyData({
    challengeRef,
    actionKind: action.kind,
    actionReference: action.reference,
    actionRequestFingerprint: original.actionIdentity.requestFingerprint,
  });
  const hex = captureKey.slice("sha256:".length);
  const transactionRef = `rpfc_${base64UrlEncode(Uint8Array.from({ length: 32 }, (_, i) => Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)))}`;
  if (!/^rpfc_[A-Za-z0-9_-]{43}$/u.test(transactionRef)) unavailable();
  return transactionRef;
}

/** Only exact retained Financial bytes may accompany the unmounted native DATA
 * batch. The separate RP display/POST/identity-evidence proof is still absent. */
async function assertSameFinancialR1CaptureData(
  input: SharedAuthFinancialConsentCaptureData,
  retained: FinancialActionConsentR1Original,
): Promise<void> {
  const { pending, command } = input;
  const consent = await parseSharedAuthFinancialActionConsentOriginal(command.originalBytes);
  assertSameFinancialR1Original(consent, retained);
  const selectedTerms = base64UrlDecode(retained.selectedTerms.bodyUtf8Base64url);
  if (
    !selectedTerms ||
    !equalBytes(pending.terms_original_bytes, selectedTerms) ||
    pending.terms_digest_original !== retained.selectedTerms.digest ||
    !equalBytes(
      pending.action_original_bytes,
      new TextEncoder().encode(canonicalJson(retained.actionIdentity.action)),
    ) ||
    !equalBytes(
      pending.challenge_original_bytes,
      new TextEncoder().encode(canonicalJson(retained.original.c0.challenge)),
    )
  )
    unavailable();
}

/** Exact cross-owner original DATA comparison. The Financial reader qualifies
 * its own history; this comparison alone is neither display nor consent. */
function assertSameFinancialR1Original(
  consent: Awaited<ReturnType<typeof parseSharedAuthFinancialActionConsentOriginal>>,
  retained: FinancialActionConsentR1Original,
): void {
  const financial = retained.original;
  const binding = retained.billingBinding;
  const source = retained.actionSource;
  const scope = retained.scopeRealm;
  if (
    financial.challengeRef !== consent.challenge.challengeRef ||
    canonicalJson(financial.c0.challenge) !== canonicalJson(consent.challenge) ||
    retained.actionIdentity.version !== consent.actionVersion ||
    retained.actionIdentity.requestFingerprint !== consent.actionRequestFingerprint ||
    canonicalJson(retained.actionIdentity.action) !== canonicalJson(consent.action) ||
    retained.selectedTerms.ref !== consent.selectedTerms.ref ||
    retained.selectedTerms.digest !== consent.selectedTerms.digest ||
    source.ref !== consent.source.ref ||
    source.digest !== consent.source.digest ||
    source.registrationRef !== consent.source.registrationRef ||
    source.incarnation !== consent.source.incarnation ||
    scope.organizationId !== consent.path.organizationId ||
    scope.workspaceId !== consent.path.workspaceId ||
    scope.workspaceRef !== consent.path.workspaceRef ||
    scope.financialRealm !== consent.financialRealmRef ||
    binding.organizationId !== consent.path.organizationId ||
    binding.workspaceId !== consent.path.workspaceId ||
    binding.workspaceRef !== consent.path.workspaceRef ||
    financial.c0.selection.terms.ref !== consent.selectedTerms.ref ||
    financial.c0.selection.terms.digest !== consent.selectedTerms.digest
  )
    unavailable();
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
  const issuerSource = createSharedAuthFinancialConsentIssuerSource(connection);
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
      const result = await persistObservedDataWithObservation(
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

  /** Private DATA bridge for a retained Financial R1. The R1 reader observes
   * Root first; the Clock and native batch use those exact held handles. The
   * caller supplies only detached pending/command DATA, never originals or
   * a currentness predicate. This is not the live GET/POST consent producer. */
  async function persistFinancialR1ObservedData(
    request: Request,
    workspaceId: string,
    challengeRef: string,
    input: SharedAuthFinancialConsentCaptureData,
  ): Promise<SharedAuthFinancialConsentOriginalData> {
    try {
      sameOrigin();
      if (!(request instanceof Request) || !workspaceId || !challengeRef) unavailable();
      const detached = snapshotSharedAuthFinancialConsentRequestCaptureData(input);
      const reader = createFinancialActionConsentR1Reader(connection, request, workspaceId);
      const retained = await reader.readRetainedActionConsentR1(challengeRef);
      sameOrigin();
      if (retained.original.challengeRef !== challengeRef) unavailable();
      await assertSameFinancialR1CaptureData(detached, retained);
      sameOrigin();
      const observation = await captureSharedAuthFinancialRequestClockObservationFromR1(
        connection,
        request,
        workspaceId,
        reader,
        retained,
      );
      sameOrigin();
      return await persistObservedDataWithObservation(request, workspaceId, observation, detached);
    } catch {
      sameOrigin();
      return unavailable();
    }
  }

  /** RP-internal continuation for a Financial-held Root original. The caller
   * does not provide credential, human, Clock, SQL or currentness predicates. */
  async function persistObservedDataWithObservation(
    request: Request,
    workspaceId: string,
    observation: unknown,
    input: SharedAuthFinancialConsentCaptureData,
  ): Promise<SharedAuthFinancialConsentOriginalData> {
    try {
      sameOrigin();
      readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
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
    } catch {
      sameOrigin();
      return unavailable();
    }
  }

  /** The actual R1 owner reads the original Request and immutable full history
   * before any RP observation. A renderer may use these exact terms and action;
   * returning them is not evidence that a response was delivered or accepted. */
  async function readFinancialR1PresentationData(
    request: Request,
    workspaceId: string,
    challengeRef: string,
  ): Promise<SharedAuthFinancialR1PresentationData> {
    try {
      sameOrigin();
      if (
        !(request instanceof Request) ||
        request.method !== "GET" ||
        typeof workspaceId !== "string" ||
        !workspaceId
      )
        unavailable();
      const reader = createFinancialActionConsentR1Reader(connection, request, workspaceId);
      const original = await reader.readRetainedActionConsentR1(challengeRef);
      sameOrigin();
      if (original.original.challengeRef !== challengeRef) unavailable();
      // RP's existing pending29 custody caps are narrower than Financial's
      // retained history. Refuse a new presentation that RP cannot preserve;
      // the original Financial historical GET remains readable separately.
      const termsBytes = base64UrlDecode(original.selectedTerms.bodyUtf8Base64url);
      if (
        !termsBytes ||
        termsBytes.byteLength !== original.selectedTerms.bodyByteLength ||
        termsBytes.byteLength > 16_384
      )
        unavailable();
      const terms = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(termsBytes);
      if (!terms || terms.length > 8_192) unavailable();
      const encoder = new TextEncoder();
      if (
        encoder.encode(canonicalJson(original.actionIdentity.action)).byteLength > 16_384 ||
        encoder.encode(canonicalJson(original.original.c0.challenge)).byteLength > 16_384
      )
        unavailable();
      const transactionRef = await transactionRefForR1(original);
      sameOrigin();
      const stillOriginal = await reader.readRetainedActionConsentR1(challengeRef);
      sameOrigin();
      if (
        stillOriginal.fullCommandJson !== original.fullCommandJson ||
        stillOriginal.r1ReceiptRef !== original.r1ReceiptRef ||
        stillOriginal.c0ReceiptRef !== original.c0ReceiptRef
      )
        unavailable();
      sameOrigin();
      return Object.freeze({
        state: "financial-r1-presentation-data",
        transactionRef,
        challengeRef,
        requestFingerprint: original.actionIdentity.requestFingerprint,
        actionIdentity: original.actionIdentity,
        selectedTerms: original.selectedTerms,
        r1ReceiptRef: original.r1ReceiptRef,
        c0ReceiptRef: original.c0ReceiptRef,
      });
    } catch {
      sameOrigin();
      return unavailable();
    }
  }

  /** Unmounted GET preparation. The same successful R1 result holds Root's
   * originals for Clock and one guarded pending29 write/query; no POST body,
   * command16, acceptedAt, current consent or Financial effect is produced. */
  async function prepareFinancialR1ConsentView(
    request: Request,
    workspaceId: string,
    challengeRef: string,
  ): Promise<SharedAuthFinancialPreparedConsentViewData> {
    try {
      sameOrigin();
      if (
        !(request instanceof Request) ||
        request.method !== "GET" ||
        !workspaceId ||
        !challengeRef
      )
        unavailable();
      const reader = createFinancialActionConsentR1Reader(connection, request, workspaceId);
      const retained = await reader.readRetainedActionConsentR1(challengeRef);
      sameOrigin();
      const challenge = retained.original.c0.challenge;
      const action = retained.actionIdentity.action;
      if (
        retained.original.challengeRef !== challengeRef ||
        challenge.challengeRef !== challengeRef ||
        challenge.workspaceId !== workspaceId ||
        retained.actionIdentity.requestFingerprint !== challenge.requestFingerprint
      )
        unavailable();
      const transactionRef = await transactionRefForR1(retained);
      sameOrigin();
      const view = await renderSharedAuthFinancialPreparedConsentView({
        transactionRef,
        action,
        termsOriginalUtf8Base64url: retained.selectedTerms.bodyUtf8Base64url,
      });
      sameOrigin();
      const observation = await captureSharedAuthFinancialRequestClockObservationFromR1(
        connection,
        request,
        workspaceId,
        reader,
        retained,
      );
      sameOrigin();
      const held = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      const issuer = await issuerSource.readCurrentOriginal(request, workspaceId, observation);
      sameOrigin();
      const current = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      if (
        current.selectedScope !== held.selectedScope ||
        current.sampledAt !== held.sampledAt ||
        current.credential !== held.credential ||
        current.human !== held.human ||
        current.currentSession !== held.currentSession ||
        current.finalSession !== held.finalSession ||
        held.selectedScope.organizationId !== challenge.organizationId ||
        held.selectedScope.workspaceId !== challenge.workspaceId ||
        held.selectedScope.workspaceRef !== challenge.workspaceRef ||
        retained.actionSource.organizationId !== challenge.organizationId ||
        retained.actionSource.workspaceId !== challenge.workspaceId ||
        retained.actionSource.workspaceRef !== challenge.workspaceRef
      )
        unavailable();
      const expiry = Math.min(
        challenge.expiresAt,
        held.currentSession.absoluteExpiresAt,
        held.sampledAt + 300_000,
      );
      if (held.sampledAt < challenge.createdAt || expiry <= held.sampledAt) unavailable();
      const encoder = new TextEncoder();
      const actionBytes = encoder.encode(canonicalJson(action));
      const challengeBytes = encoder.encode(canonicalJson(challenge));
      const termsBytes = base64UrlDecode(retained.selectedTerms.bodyUtf8Base64url);
      if (
        !termsBytes ||
        termsBytes.byteLength !== retained.selectedTerms.bodyByteLength ||
        actionBytes.byteLength < 1 ||
        actionBytes.byteLength > 16_384 ||
        challengeBytes.byteLength < 1 ||
        challengeBytes.byteLength > 16_384
      )
        unavailable();
      const [actionCustody, termsCustody, challengeCustody] = await Promise.all([
        bytesDigest(actionBytes),
        bytesDigest(termsBytes),
        bytesDigest(challengeBytes),
      ]);
      sameOrigin();
      readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      if (termsCustody !== retained.selectedTerms.digest) unavailable();
      const credential = held.credential;
      const pending: SharedAuthFinancialConsentPendingData = Object.freeze({
        transaction_ref: transactionRef,
        registration_ref: issuer.registrationRef,
        incarnation: issuer.incarnation,
        challenge_ref: challengeRef,
        action_ref: action.reference,
        action_kind: action.kind,
        organization_id: held.selectedScope.organizationId,
        workspace_id: held.selectedScope.workspaceId,
        workspace_ref: held.selectedScope.workspaceRef,
        request_fingerprint: retained.actionIdentity.requestFingerprint,
        principal_id: credential.origin.principalId,
        principal_incarnation: credential.origin.principalIncarnation,
        principal_binding_ref: held.human.ref,
        authority_ref: credential.origin.ref,
        credential_incarnation: credential.origin.incarnation,
        credential_target_ref: credential.origin.targetRef,
        credential_organization_id: credential.organizationId,
        credential_workspace_id: credential.rp.workspaceId,
        credential_workspace_ref: credential.rp.workspaceRef,
        action_original_bytes: actionBytes,
        action_custody_sha256: actionCustody,
        terms_original_bytes: termsBytes,
        terms_digest_original: retained.selectedTerms.digest,
        terms_custody_sha256: termsCustody,
        disclosure_ref: view.disclosureRef,
        challenge_original_bytes: challengeBytes,
        challenge_custody_sha256: challengeCustody,
        created_at: held.sampledAt,
        expires_at: expiry,
      });
      const saved = await prepareSharedAuthFinancialConsentPendingFromObservation(
        connection,
        request,
        workspaceId,
        observation,
        pending,
      );
      sameOrigin();
      readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      const stillRetained = await reader.readRetainedActionConsentR1(challengeRef);
      sameOrigin();
      const finalHeld = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      if (
        finalHeld.selectedScope !== held.selectedScope ||
        finalHeld.sampledAt !== held.sampledAt ||
        finalHeld.credential !== held.credential ||
        finalHeld.human !== held.human ||
        finalHeld.currentSession !== held.currentSession ||
        finalHeld.finalSession !== held.finalSession
      )
        unavailable();
      if (
        retained !== stillRetained &&
        (retained.fullCommandJson !== stillRetained.fullCommandJson ||
          retained.r1ReceiptRef !== stillRetained.r1ReceiptRef ||
          retained.c0ReceiptRef !== stillRetained.c0ReceiptRef)
      )
        unavailable();
      return Object.freeze({
        state: "prepared-financial-consent-view-data",
        transactionRef,
        disclosureRef: view.disclosureRef,
        html: view.html,
        disposition: saved.disposition,
      });
    } catch {
      sameOrigin();
      return unavailable();
    }
  }

  /** POST syntax and original pending29 are checked against one actual R1
   * request capture. This is read-only preflight DATA, not consent production. */
  async function readPreparedFinancialR1SubmissionData(
    request: Request,
    workspaceId: string,
    challengeRef: string,
  ): Promise<SharedAuthFinancialPreparedSubmissionData> {
    const assertRequestOrigin = () => {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      if (
        (url.protocol !== "https:" && url.protocol !== "http:") ||
        url.origin === "null" ||
        origin === null ||
        origin === "null" ||
        origin !== url.origin ||
        request.signal.aborted
      )
        unavailable();
    };
    try {
      sameOrigin();
      if (
        !(request instanceof Request) ||
        request.method !== "POST" ||
        !workspaceId ||
        !challengeRef
      )
        unavailable();
      assertRequestOrigin(); // No Referer fallback or caller-supplied origin authority.
      const reader = createFinancialActionConsentR1Reader(connection, request, workspaceId);
      const retained = await reader.readRetainedActionConsentR1(challengeRef);
      sameOrigin();
      assertRequestOrigin();
      const challenge = retained.original.c0.challenge;
      const action = retained.actionIdentity.action;
      if (
        retained.original.challengeRef !== challengeRef ||
        challenge.challengeRef !== challengeRef ||
        challenge.workspaceId !== workspaceId ||
        retained.actionIdentity.requestFingerprint !== challenge.requestFingerprint
      )
        unavailable();
      const transactionRef = await transactionRefForR1(retained);
      sameOrigin();
      assertRequestOrigin();
      const submission = await parseSharedAuthFinancialConfirmationSubmissionCandidate(request, {
        transactionRef,
        challengeRef,
        requestFingerprint: retained.actionIdentity.requestFingerprint,
      });
      sameOrigin();
      assertRequestOrigin();
      const view = await renderSharedAuthFinancialPreparedConsentView({
        transactionRef,
        action,
        termsOriginalUtf8Base64url: retained.selectedTerms.bodyUtf8Base64url,
      });
      sameOrigin();
      assertRequestOrigin();
      const observation = await captureSharedAuthFinancialRequestClockObservationFromR1(
        connection,
        request,
        workspaceId,
        reader,
        retained,
      );
      sameOrigin();
      assertRequestOrigin();
      const held = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      const issuer = await issuerSource.readCurrentOriginal(request, workspaceId, observation);
      sameOrigin();
      assertRequestOrigin();
      const pending = await readSharedAuthFinancialConsentPreparedPendingForPost(
        connection,
        request,
        workspaceId,
        observation,
        transactionRef,
      );
      sameOrigin();
      assertRequestOrigin();
      const current = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      if (
        current.selectedScope !== held.selectedScope ||
        current.sampledAt !== held.sampledAt ||
        current.credential !== held.credential ||
        current.human !== held.human ||
        current.currentSession !== held.currentSession ||
        current.finalSession !== held.finalSession ||
        held.selectedScope.organizationId !== challenge.organizationId ||
        held.selectedScope.workspaceId !== challenge.workspaceId ||
        held.selectedScope.workspaceRef !== challenge.workspaceRef ||
        retained.actionSource.organizationId !== challenge.organizationId ||
        retained.actionSource.workspaceId !== challenge.workspaceId ||
        retained.actionSource.workspaceRef !== challenge.workspaceRef
      )
        unavailable();
      const credential = held.credential;
      const actionBytes = new TextEncoder().encode(canonicalJson(action));
      const challengeBytes = new TextEncoder().encode(canonicalJson(challenge));
      const termsBytes = base64UrlDecode(retained.selectedTerms.bodyUtf8Base64url);
      if (
        !termsBytes ||
        termsBytes.byteLength !== retained.selectedTerms.bodyByteLength ||
        !equalBytes(pending.action_original_bytes, actionBytes) ||
        !equalBytes(pending.challenge_original_bytes, challengeBytes) ||
        !equalBytes(pending.terms_original_bytes, termsBytes) ||
        pending.transaction_ref !== transactionRef ||
        pending.registration_ref !== issuer.registrationRef ||
        pending.incarnation !== issuer.incarnation ||
        pending.challenge_ref !== challengeRef ||
        pending.action_ref !== action.reference ||
        pending.action_kind !== action.kind ||
        pending.organization_id !== held.selectedScope.organizationId ||
        pending.workspace_id !== held.selectedScope.workspaceId ||
        pending.workspace_ref !== held.selectedScope.workspaceRef ||
        pending.request_fingerprint !== retained.actionIdentity.requestFingerprint ||
        pending.principal_id !== credential.origin.principalId ||
        pending.principal_incarnation !== credential.origin.principalIncarnation ||
        pending.principal_binding_ref !== held.human.ref ||
        pending.authority_ref !== credential.origin.ref ||
        pending.credential_incarnation !== credential.origin.incarnation ||
        pending.credential_target_ref !== credential.origin.targetRef ||
        pending.credential_organization_id !== credential.organizationId ||
        pending.credential_workspace_id !== credential.rp.workspaceId ||
        pending.credential_workspace_ref !== credential.rp.workspaceRef ||
        pending.terms_digest_original !== retained.selectedTerms.digest ||
        pending.disclosure_ref !== view.disclosureRef ||
        pending.created_at < challenge.createdAt ||
        pending.created_at > held.sampledAt ||
        held.sampledAt >= pending.expires_at ||
        pending.expires_at > challenge.expiresAt ||
        pending.expires_at > pending.created_at + 300_000 ||
        pending.expires_at > held.currentSession.absoluteExpiresAt
      )
        unavailable();
      readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      const stillRetained = await reader.readRetainedActionConsentR1(challengeRef);
      sameOrigin();
      assertRequestOrigin();
      if (
        retained.fullCommandJson !== stillRetained.fullCommandJson ||
        retained.r1ReceiptRef !== stillRetained.r1ReceiptRef ||
        retained.c0ReceiptRef !== stillRetained.c0ReceiptRef
      )
        unavailable();
      const finalHeld = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        workspaceId,
        observation,
      );
      if (
        finalHeld.selectedScope !== held.selectedScope ||
        finalHeld.sampledAt !== held.sampledAt ||
        finalHeld.credential !== held.credential ||
        finalHeld.human !== held.human ||
        finalHeld.currentSession !== held.currentSession ||
        finalHeld.finalSession !== held.finalSession
      )
        unavailable();
      const prepared: SharedAuthFinancialPreparedSubmissionData = Object.freeze({
        state: "prepared-financial-consent-submission-data",
        submission,
        pending,
      });
      preparedSubmissionOrigins.set(
        prepared,
        Object.freeze({
          handler,
          connection,
          request,
          workspaceId,
          challengeRef,
          reader,
          retained,
          readR1: method(reader, "readRetainedActionConsentR1"),
          observation,
          native: held,
          pendingValues: detachedPendingValues(pending),
          assertOrigin: sameOrigin,
          assertRequestOrigin,
        }),
      );
      return prepared;
    } catch {
      sameOrigin();
      return unavailable();
    }
  }

  /** A separate, one-attempt identity-proof effect for the same prepared POST
   * original. The query-only preflight above never invokes this operation.
   * Even a successful reference is DATA, not consent or Financial NEW/CAS. */
  function provePreparedFinancialR1Identity(
    request: Request,
    workspaceId: string,
    challengeRef: string,
    prepared: SharedAuthFinancialPreparedSubmissionData,
  ): Promise<SharedAuthFinancialPreparedIdentityProofData> {
    const held = preparedSubmissionOrigins.get(prepared);
    if (
      !held ||
      held.handler !== handler ||
      held.connection !== connection ||
      held.request !== request ||
      held.workspaceId !== workspaceId ||
      held.challengeRef !== challengeRef
    )
      return Promise.reject(new SharedAuthFinancialConsentOriginalReadError("unavailable"));
    const prior = preparedProofAttempts.get(prepared);
    if (prior) return prior;
    // Publish the attempt before the first await. Unknown proof or post-effect
    // currentness failure remains sticky for this exact prepared original.
    const attempt = Promise.resolve().then(async () => {
      const assertHeld = () => {
        held.assertOrigin();
        held.assertRequestOrigin();
        if (method(held.reader, "readRetainedActionConsentR1") !== held.readR1) unavailable();
        const now = readSharedAuthFinancialRequestNativeObservationData(
          connection,
          request,
          workspaceId,
          held.observation,
        );
        if (!sameNativeObservation(now, held.native)) unavailable();
      };
      const assertCurrent = async () => {
        assertHeld();
        const currentPending = await readSharedAuthFinancialConsentPreparedPendingForPost(
          connection,
          request,
          workspaceId,
          held.observation,
          held.pendingValues.get("transaction_ref") as string,
        );
        assertHeld();
        if (!sameDetachedPending(held.pendingValues, currentPending)) unavailable();
        const currentR1 = await Reflect.apply(held.readR1, held.reader, [challengeRef]);
        assertHeld();
        if (
          currentR1.fullCommandJson !== held.retained.fullCommandJson ||
          currentR1.r1ReceiptRef !== held.retained.r1ReceiptRef ||
          currentR1.c0ReceiptRef !== held.retained.c0ReceiptRef
        )
          unavailable();
      };
      try {
        await assertCurrent();
        assertHeld();
        const response = await proveSharedAuthFinancialRequestIdentityFromObservation(
          connection,
          request,
          workspaceId,
          challengeRef,
          held.observation,
        );
        assertHeld();
        const proof = proofReferenceData(response);
        await assertCurrent();
        assertHeld();
        return proof;
      } catch {
        return unavailable();
      }
    });
    preparedProofAttempts.set(prepared, attempt);
    return attempt;
  }

  /** Shared local/issuer/expiry checks over one already-held Root observation.
   * The Financial continuation supplies the observation made from its own
   * original capture; this helper never invokes the RP observer again. */
  async function readUnexpiredLocalDataWithObservation(
    request: Request,
    selected: ReturnType<typeof selection>,
    observation: unknown,
  ): Promise<SharedAuthFinancialConsentUnexpiredLocalData> {
    try {
      const held = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        selected.workspaceId,
        observation,
      );
      const assertHeld = () => {
        sameOrigin();
        const now = readSharedAuthFinancialRequestNativeObservationData(
          connection,
          request,
          selected.workspaceId,
          observation,
        );
        if (
          now.selectedScope !== held.selectedScope ||
          now.sampledAt !== held.sampledAt ||
          now.credential !== held.credential ||
          now.human !== held.human ||
          now.currentSession !== held.currentSession ||
          now.finalSession !== held.finalSession
        )
          unavailable();
      };
      assertHeld();
      const historical = await Reflect.apply(readHistorical, historicals, [
        selected.consentProofRef,
      ]);
      assertHeld();
      const original = await parseSharedAuthFinancialActionConsentOriginal(
        historical.original.originalBytes,
      );
      assertHeld();
      const issuer = await issuerSource.readCurrentOriginal(
        request,
        selected.workspaceId,
        observation,
      );
      assertHeld();
      const { finalSession, selectedScope, credential, human, currentSession, sampledAt } = held;
      const identity = original.rpSession.identity;
      if (
        original.consentRef !== selected.consentProofRef ||
        original.path.workspaceId !== selected.workspaceId ||
        original.path.workspaceId !== selectedScope.workspaceId ||
        original.path.workspaceRef !== selectedScope.workspaceRef ||
        original.path.organizationId !== selectedScope.organizationId ||
        original.rpSession.accountId !== finalSession.accountId ||
        original.rpSession.accountId !== credential.rp.accountId ||
        original.rpSession.sessionDigest !== finalSession.sessionDigest ||
        original.rpSession.acceptedVersion > currentSession.version ||
        original.rpSession.observedPrincipalId !== finalSession.principalId ||
        original.rpSession.observedPrincipalId !== human.principalId ||
        identity.issuer !== finalSession.identity.issuer ||
        identity.clientId !== finalSession.identity.clientId ||
        identity.subject !== finalSession.identity.subject ||
        identity.sessionId !== finalSession.identity.sessionId ||
        identity.authTime !== finalSession.identity.authTime ||
        original.principalBinding.ref !== human.ref ||
        original.principalBinding.ref !== credential.rp.principalBindingRef ||
        original.principalBinding.digest !== human.evidence.digest ||
        original.principalBinding.incarnation !== human.controllerIncarnation ||
        original.credentialClass.ref !== credential.origin.ref ||
        original.credentialClass.digest !== credential.origin.issuanceDigest ||
        original.credentialClass.incarnation !== credential.origin.incarnation ||
        original.consentIssuer.registrationRef !== issuer.registrationRef ||
        original.consentIssuer.registrationDigest !== issuer.registrationDigest ||
        original.consentIssuer.incarnation !== issuer.incarnation ||
        original.acceptedAt > sampledAt ||
        sampledAt >= original.expiresAt ||
        sampledAt >= currentSession.absoluteExpiresAt
      )
        unavailable();
      const local = await Reflect.apply(readLocal, locals, [
        {
          consentProofRef: selected.consentProofRef,
          credential,
          human,
          currentSession,
        },
      ]);
      assertHeld();
      if (
        local === undefined ||
        local.consentProofRef !== selected.consentProofRef ||
        !sameOriginal(historical.original, local.original)
      )
        unavailable();
      return Object.freeze({ state: "unexpired-consent-local-data", sampledAt, local });
    } catch {
      sameOrigin();
      return unavailable();
    }
  }

  /** The R1 original was matched before observation. Re-read the exact local
   * proof under that same held observation, including its immutable custody. */
  async function currentWitnessWithObservation(
    request: Request,
    selected: ReturnType<typeof selection>,
    observation: unknown,
    historicalOriginal: SharedAuthFinancialConsentOriginalData,
  ): Promise<{
    readonly witness: SharedAuthFinancialConsentLocalCurrentWitness;
    readonly original: SharedAuthFinancialConsentOriginalData;
  }> {
    const current = await readUnexpiredLocalDataWithObservation(request, selected, observation);
    sameOrigin();
    if (!sameOriginal(historicalOriginal, current.local.original)) unavailable();
    readSharedAuthFinancialRequestNativeObservationData(
      connection,
      request,
      selected.workspaceId,
      observation,
    );
    sameOrigin();
    return Object.freeze({
      witness: Object.freeze({
        state: "financial-action-consent-local-current-witness",
        consentProofRef: selected.consentProofRef,
        sampledAt: current.sampledAt,
        originalDigest: current.local.original.originalDigest,
      }),
      original: current.local.original,
    });
  }

  /** The historical DATA method retains its original one-capture behavior. */
  async function readUnexpiredLocalData(
    request: Request,
    input: SharedAuthFinancialConsentRequestSelection,
  ): Promise<SharedAuthFinancialConsentUnexpiredLocalData> {
    const selected = selection(input);
    try {
      sameOrigin();
      const observation = await captureSharedAuthFinancialRequestClockObservation(
        connection,
        request,
        selected.workspaceId,
      );
      sameOrigin();
      return await readUnexpiredLocalDataWithObservation(request, selected, observation);
    } catch {
      sameOrigin();
      return unavailable();
    }
  }

  /** R1 is read on the exact Request before Clock/local currentness. The
   * Financial-held Root originals are reused, not reobserved. This returns
   * a local DATA witness only; Financial NEW/CAS remains independently gated. */
  async function verifyCurrentActionConsent(
    request: Request,
    input: SharedAuthFinancialConsentRequestSelection,
  ): Promise<SharedAuthFinancialConsentLocalCurrentWitness> {
    const selected = selection(input);
    try {
      sameOrigin();
      const historical = await Reflect.apply(readHistorical, historicals, [
        selected.consentProofRef,
      ]);
      sameOrigin();
      const consent = await parseSharedAuthFinancialActionConsentOriginal(
        historical.original.originalBytes,
      );
      sameOrigin();
      if (consent.consentRef !== selected.consentProofRef) unavailable();
      const reader = createFinancialActionConsentR1Reader(
        connection,
        request,
        selected.workspaceId,
      );
      const retained = await reader.readRetainedActionConsentR1(consent.challenge.challengeRef);
      sameOrigin();
      assertSameFinancialR1Original(consent, retained);
      const observation = await captureSharedAuthFinancialRequestClockObservationFromR1(
        connection,
        request,
        selected.workspaceId,
        reader,
        retained,
      );
      sameOrigin();
      const current = await currentWitnessWithObservation(
        request,
        selected,
        observation,
        historical.original,
      );
      sameOrigin();
      const baseline = detachReceiptedOriginal(current.original);
      if (!sameOriginal(current.original, baseline)) unavailable();
      const stillRetained = await reader.readRetainedActionConsentR1(
        consent.challenge.challengeRef,
      );
      sameOrigin();
      if (
        retained.fullCommandJson !== stillRetained.fullCommandJson ||
        retained.r1ReceiptRef !== stillRetained.r1ReceiptRef ||
        retained.c0ReceiptRef !== stillRetained.c0ReceiptRef
      )
        unavailable();
      assertSameFinancialR1Original(consent, stillRetained);
      const native = readSharedAuthFinancialRequestNativeObservationData(
        connection,
        request,
        selected.workspaceId,
        observation,
      );
      sameOrigin();
      if (
        !sameOriginal(current.original, baseline) ||
        current.witness.sampledAt !== native.sampledAt
      )
        unavailable();
      currentOriginalOrigins.set(
        current.witness,
        Object.freeze({
          handler,
          connection,
          request,
          workspaceId: selected.workspaceId,
          consentProofRef: selected.consentProofRef,
          sampledAt: current.witness.sampledAt,
          observation,
          native,
          original: current.original,
          baseline,
          consent,
          retained,
          finalRetained: stillRetained,
          assertOrigin: sameOrigin,
        }),
      );
      return current.witness;
    } catch {
      sameOrigin();
      return unavailable();
    }
  }
  const handler = Object.freeze({
    readExisting,
    persistObservedData,
    persistFinancialR1ObservedData,
    readFinancialR1PresentationData,
    prepareFinancialR1ConsentView,
    readPreparedFinancialR1SubmissionData,
    provePreparedFinancialR1Identity,
    readUnexpiredLocalData,
    verifyCurrentActionConsent,
  });
  return handler;
}
