import { readAuth103SourceClock } from "./auth103-source-clock.ts";
import {
  assertFinancialAuthConsumerPort,
  assertWorkerRequestFinancialAuthConsumerPort,
  captureWorkerRequestFinancialAuthRpRequest,
  readWorkerRequestFinancialAuthConsumerContext,
  readWorkerRequestFinancialAuthConsumerPort,
} from "./financial-auth-consumer.ts";
import {
  type FinancialActionConsentR1Original,
  type FinancialActionConsentR1Reader,
  readFinancialActionConsentR1RequestCaptures,
} from "./shared-financial-retained-r1.ts";
import {
  loadWorkerRequestRetainedRpFinancialIdentityProofOriginal,
  proveWorkerRequestRetainedRpFinancialIdentityOriginal,
  readWorkerRequestConsumers,
  readWorkerRequestFinancialInputs,
  readWorkerRequestRetainedRpCapture,
  verifyCurrentWorkerRequestRetainedRpFinancialIdentityProofOriginal,
  type WorkerRequestRetainedRpCapture,
  type WorkerRequestSql,
} from "./worker-request-composition.ts";

/** Private, unmounted request observation. No consent, acceptedAt or current grant. */
export class SharedAuthFinancialSourceUnavailable extends Error {
  readonly code = "unavailable" as const;
  constructor() {
    super("shared_auth_financial_source_unavailable");
    this.name = "SharedAuthFinancialSourceUnavailable";
  }
}

const unavailable = (): never => {
  throw new SharedAuthFinancialSourceUnavailable();
};

declare const observationBrand: unique symbol;
export interface SharedAuthFinancialRequestClockObservation {
  readonly [observationBrand]: true;
}

export interface SharedAuthFinancialRequestClockData {
  readonly state: "shared-auth-financial-request-clock-data";
  readonly sampledAt: number;
}

/** RP-internal DATA for the existing native batch, never consent or admission. */
export interface SharedAuthFinancialRequestNativeObservationData {
  readonly state: "shared-auth-financial-request-native-observation-data";
  readonly selectedScope: Retained["selectedScope"];
  readonly sampledAt: number;
  readonly credential: Retained["record"];
  readonly human: Principal["binding"];
  readonly currentSession: Retained["current"];
  readonly finalSession: Retained["finalSession"];
}

type Port = NonNullable<ReturnType<typeof readWorkerRequestFinancialAuthConsumerPort>>;
type Context = NonNullable<ReturnType<typeof readWorkerRequestFinancialAuthConsumerContext>>;
type Captures = NonNullable<Awaited<ReturnType<typeof captureWorkerRequestFinancialAuthRpRequest>>>;
type Credential = ReturnType<Port["readValidatedCredential"]>;
type SharedRpCredential = Extract<Credential, { readonly backend: "shared-rp-session" }>;
type Principal = ReturnType<Port["readValidatedPrincipalBinding"]>;
type Retained = NonNullable<ReturnType<typeof readWorkerRequestRetainedRpCapture>>;
const dateGetTime = Date.prototype.getTime;

function ownMethod(receiver: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(receiver, key);
  if (!descriptor || !("value" in descriptor) || typeof descriptor.value !== "function")
    return unavailable();
  return descriptor.value;
}

function requestIsOriginal(request: Request): boolean {
  return request instanceof Request && !request.signal.aborted;
}

function sampleClock(clock: ReturnType<typeof readWorkerRequestFinancialInputs>["clock"]): number {
  // Root's frozen source Clock returns a Date. Read its internal slot through
  // the captured intrinsic; neither a caller time nor Date.now enters here.
  const value: unknown = Reflect.apply(clock, undefined, []);
  const milliseconds: unknown = Reflect.apply(dateGetTime, value, []);
  if (
    typeof milliseconds !== "number" ||
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > 8_640_000_000_000_000
  )
    return unavailable();
  return milliseconds;
}

interface Held {
  readonly connection: WorkerRequestSql;
  readonly request: Request;
  readonly workspaceId: string;
  readonly inputs: ReturnType<typeof readWorkerRequestFinancialInputs>;
  readonly graph: ReturnType<typeof readWorkerRequestConsumers>;
  readonly clock: ReturnType<typeof readWorkerRequestFinancialInputs>["clock"];
  readonly clockOriginal: NonNullable<ReturnType<typeof readAuth103SourceClock>>;
  readonly port: Port;
  readonly context: Context;
  readonly methods: Readonly<{
    sqlQuery: unknown;
    sqlRun: unknown;
    sqlBatch: unknown;
    observe: unknown;
    finalSelection: unknown;
    credential: unknown;
    principal: unknown;
  }>;
  readonly captures: Captures;
  readonly credential: SharedRpCredential;
  readonly principal: Principal;
  readonly retained: Retained;
  readonly sampledAt: number;
}

const observations = new WeakMap<object, Held>();

function assertOrigin(
  held: Pick<
    Held,
    | "connection"
    | "request"
    | "inputs"
    | "graph"
    | "clock"
    | "clockOriginal"
    | "port"
    | "context"
    | "methods"
  >,
): void {
  const { connection, request, inputs, graph, clock, clockOriginal, port, context, methods } = held;
  if (
    !requestIsOriginal(request) ||
    readWorkerRequestFinancialInputs(connection) !== inputs ||
    readWorkerRequestConsumers(connection) !== graph ||
    connection.sql !== inputs.sql ||
    graph.sql !== inputs.sql ||
    graph.realm !== inputs.realm ||
    graph.client !== inputs.client ||
    inputs.clock !== clock ||
    readAuth103SourceClock(clock) !== clockOriginal ||
    clockOriginal.clock !== clock ||
    readWorkerRequestFinancialAuthConsumerPort(connection) !== port ||
    readWorkerRequestFinancialAuthConsumerContext(connection, port) !== context ||
    context.sql !== inputs.sql ||
    context.realm !== inputs.realm ||
    context.writerEpoch !== inputs.writerEpoch ||
    ownMethod(inputs.sql, "query") !== methods.sqlQuery ||
    ownMethod(inputs.sql, "run") !== methods.sqlRun ||
    ownMethod(inputs.sql, "batch") !== methods.sqlBatch ||
    ownMethod(graph.sharedAuth, "observeFinalWorkspaceOrganization") !== methods.observe ||
    ownMethod(graph.sharedAuth, "finalSessionSelection") !== methods.finalSelection ||
    ownMethod(port, "readValidatedCredential") !== methods.credential ||
    ownMethod(port, "readValidatedPrincipalBinding") !== methods.principal
  )
    unavailable();
  assertWorkerRequestFinancialAuthConsumerPort(connection, port);
  assertFinancialAuthConsumerPort(port, context);
}

function assertCaptures(held: Held): void {
  assertOrigin(held);
  const credential = held.port.readValidatedCredential(held.captures.credential);
  assertOrigin(held);
  const principal = held.port.readValidatedPrincipalBinding(held.captures.userBinding);
  assertOrigin(held);
  const retained = readWorkerRequestRetainedRpCapture(held.connection, held.captures.credential);
  assertOrigin(held);
  if (
    credential.backend !== "shared-rp-session" ||
    !retained ||
    retained !== held.retained ||
    retained.record !== credential.record ||
    retained.current !== credential.current ||
    retained.selectedScope.workspaceId !== held.workspaceId ||
    credential.record !== held.credential.record ||
    credential.current !== held.credential.current ||
    principal.anchor !== held.principal.anchor ||
    principal.binding !== held.principal.binding
  )
    unavailable();
}

/**
 * Real request/connection Root input and source Clock observation only. The
 * sampled time stays inside this capture; it is not acceptedAt or a permission.
 * A successful Financial R1 reader can supply its held Root originals here.
 * This sample remains DATA; affirmative POST, NEW/CAS and any mounted effect
 * need separate qualification.
 */
async function captureClockObservationFromOriginal(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  readOriginalCaptures: (port: Port) => Promise<Captures | null>,
): Promise<SharedAuthFinancialRequestClockObservation> {
  try {
    if (!requestIsOriginal(request) || typeof workspaceId !== "string" || workspaceId.length === 0)
      unavailable();
    const inputs = readWorkerRequestFinancialInputs(connection);
    const graph = readWorkerRequestConsumers(connection);
    const clock = inputs.clock;
    const clockOriginal = readAuth103SourceClock(clock) ?? unavailable();
    const port = readWorkerRequestFinancialAuthConsumerPort(connection) ?? unavailable();
    const context =
      readWorkerRequestFinancialAuthConsumerContext(connection, port) ?? unavailable();
    const methods = Object.freeze({
      sqlQuery: ownMethod(inputs.sql, "query"),
      sqlRun: ownMethod(inputs.sql, "run"),
      sqlBatch: ownMethod(inputs.sql, "batch"),
      observe: ownMethod(graph.sharedAuth, "observeFinalWorkspaceOrganization"),
      finalSelection: ownMethod(graph.sharedAuth, "finalSessionSelection"),
      credential: ownMethod(port, "readValidatedCredential"),
      principal: ownMethod(port, "readValidatedPrincipalBinding"),
    });
    const origin = {
      connection,
      request,
      inputs,
      graph,
      clock,
      clockOriginal,
      port,
      context,
      methods,
    };
    assertOrigin(origin);
    const captures = await readOriginalCaptures(port);
    assertOrigin(origin);
    if (!captures) return unavailable();
    const credential = port.readValidatedCredential(captures.credential);
    assertOrigin(origin);
    if (credential.backend !== "shared-rp-session") return unavailable();
    const principal = port.readValidatedPrincipalBinding(captures.userBinding);
    assertOrigin(origin);
    const retained = readWorkerRequestRetainedRpCapture(connection, captures.credential);
    assertOrigin(origin);
    if (
      !retained ||
      retained.record !== credential.record ||
      retained.current !== credential.current ||
      retained.selectedScope.workspaceId !== workspaceId
    )
      return unavailable();
    const sampledAt = sampleClock(clock);
    assertOrigin(origin);
    const held = Object.freeze({
      ...origin,
      workspaceId,
      captures,
      credential,
      principal,
      retained,
      sampledAt,
    });
    assertCaptures(held);
    const observation = Object.freeze({}) as SharedAuthFinancialRequestClockObservation;
    observations.set(observation, held);
    return observation;
  } catch {
    return unavailable();
  }
}

/** Historical DATA callers keep the original Root observation path. An RP
 * Financial-R1 continuation supplies the Financial owner's static original
 * reader to the private common implementation; it must not retouch here. */
export function captureSharedAuthFinancialRequestClockObservation(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
): Promise<SharedAuthFinancialRequestClockObservation> {
  return captureClockObservationFromOriginal(connection, request, workspaceId, (port) =>
    captureWorkerRequestFinancialAuthRpRequest(port, request, workspaceId),
  );
}

/** Exact Financial successful-R1 result is only a custody key. The Financial
 * static reader returns the Root handles from its own prior observer; this
 * path never invokes the observer again or accepts caller-shaped originals. */
export function captureSharedAuthFinancialRequestClockObservationFromR1(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  reader: FinancialActionConsentR1Reader,
  retainedR1: FinancialActionConsentR1Original,
): Promise<SharedAuthFinancialRequestClockObservation> {
  return captureClockObservationFromOriginal(connection, request, workspaceId, () =>
    Promise.resolve(
      readFinancialActionConsentR1RequestCaptures(
        connection,
        request,
        workspaceId,
        reader,
        retainedR1,
      ),
    ),
  );
}

/** Static reader: the original Request object and Root graph must still match. */
export function readSharedAuthFinancialRequestClockObservation(
  connection: WorkerRequestSql,
  request: Request,
  observation: unknown,
): SharedAuthFinancialRequestClockData {
  try {
    if (!observation || typeof observation !== "object") return unavailable();
    const held = observations.get(observation);
    if (!held || held.connection !== connection || held.request !== request) return unavailable();
    assertCaptures(held);
    return Object.freeze({
      state: "shared-auth-financial-request-clock-data",
      sampledAt: held.sampledAt,
    });
  } catch {
    return unavailable();
  }
}

/**
 * RP-owned bridge to the original native batch. The source-held Root originals
 * are read again under the same connection, exact Request and selected
 * Workspace; no caller field, port, Sql, token or currentness SQL is returned.
 * The caller must re-read across awaits and before/after its single batch.
 */
export function readSharedAuthFinancialRequestNativeObservationData(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  observation: unknown,
): SharedAuthFinancialRequestNativeObservationData {
  try {
    if (!observation || typeof observation !== "object") return unavailable();
    const held = observations.get(observation);
    if (
      !held ||
      held.connection !== connection ||
      held.request !== request ||
      held.workspaceId !== workspaceId
    )
      return unavailable();
    assertCaptures(held);
    return Object.freeze({
      state: "shared-auth-financial-request-native-observation-data",
      selectedScope: held.retained.selectedScope,
      sampledAt: held.sampledAt,
      credential: held.retained.record,
      human: held.principal.binding,
      currentSession: held.retained.current,
      finalSession: held.retained.finalSession,
    });
  } catch {
    return unavailable();
  }
}

/** One proof attempt from the exact held Root capture. The result remains
 * Accounts reference DATA, not an affirmative consent or financial grant. */
export function proveSharedAuthFinancialRequestIdentityFromObservation(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  challengeRef: string,
  observation: unknown,
): Promise<unknown> {
  return retainedProofOperation(
    proveWorkerRequestRetainedRpFinancialIdentityOriginal,
    connection,
    request,
    workspaceId,
    challengeRef,
    observation,
  );
}

/** One Accounts load of the proof the same held capture produced; Root keeps the
 * prove→load sequence and never resends. The result is found/absent DATA only. */
export function loadSharedAuthFinancialRequestIdentityProofFromObservation(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  challengeRef: string,
  observation: unknown,
): Promise<unknown> {
  return retainedProofOperation(
    loadWorkerRequestRetainedRpFinancialIdentityProofOriginal,
    connection,
    request,
    workspaceId,
    challengeRef,
    observation,
  );
}

/** One Accounts current check after the same capture's load; DATA, not consent. */
export function verifyCurrentSharedAuthFinancialRequestIdentityProofFromObservation(
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  challengeRef: string,
  observation: unknown,
): Promise<unknown> {
  return retainedProofOperation(
    verifyCurrentWorkerRequestRetainedRpFinancialIdentityProofOriginal,
    connection,
    request,
    workspaceId,
    challengeRef,
    observation,
  );
}

async function retainedProofOperation(
  operation: typeof proveWorkerRequestRetainedRpFinancialIdentityOriginal,
  connection: WorkerRequestSql,
  request: Request,
  workspaceId: string,
  challengeRef: string,
  observation: unknown,
): Promise<unknown> {
  try {
    if (!observation || typeof observation !== "object") return unavailable();
    const held = observations.get(observation);
    if (
      !held ||
      held.connection !== connection ||
      held.request !== request ||
      held.workspaceId !== workspaceId ||
      typeof challengeRef !== "string" ||
      challengeRef.length === 0
    )
      return unavailable();
    assertCaptures(held);
    // Root's static reader above proves this exact opaque handle belongs to
    // the same request/connection. The brand is never accepted from a caller.
    const capture = held.captures.credential as WorkerRequestRetainedRpCapture;
    try {
      return await operation(connection, request, workspaceId, challengeRef, capture);
    } finally {
      assertCaptures(held);
    }
  } catch {
    return unavailable();
  }
}
