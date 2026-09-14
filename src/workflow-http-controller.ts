import type { JsonObject } from "./ports.ts";
import {
  encodeDocument,
  inputIdentifier,
  parseDocument,
  plainInputRecord,
} from "./workflow-data.ts";
import {
  isWorkflowCallInputError,
  isWorkflowCallInputTypeError,
  isWorkflowRuntimeError,
  isWorkflowStepError,
  type WorkflowApplicationOutcome,
  WorkflowCallInputError,
  type WorkflowDriver,
  WorkflowRuntimeError,
  type WorkflowStepError,
} from "./workflow-driver.ts";

/**
 * The companion side of the private self-host Workflow bridge.  This is a
 * turn controller, not a transport journal: the owning ingress reserves the
 * HTTP request with `exchange` and then records its payload in the journal.
 * The journal invokes `acceptFrame` synchronously once its marker/payload
 * pair is trusted.
 */
export interface WorkflowHttpController {
  run(driver: WorkflowDriver): void;
  exchange(sequence: number, payload: string): Promise<string>;
  acceptFrame(sequence: number, payload: string): void;
  outcome(payload: string): WorkflowApplicationOutcome;
  close(): void;
  /** Infrastructure failures observed while a child run request is parked. */
  readonly failed: Promise<never>;
}

type Operation = "do" | "sleep" | "wait";
type FrameKind =
  | "call"
  | "name"
  | "pending"
  | "effect"
  | "effect_failed"
  | "input_error"
  | "mismatch";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

interface Request {
  readonly sequence: number;
  readonly payload: string;
  accepted: boolean;
  answered: boolean;
  readonly deferred: Deferred<string>;
}

interface OperationContext {
  readonly call: number;
  readonly operation: Operation;
  readonly request: Request;
  readonly name: Deferred<string>;
  readonly pending: Deferred<PendingValue>;
  readonly effect: Deferred<JsonObject | undefined>;
  nameRequested: boolean;
  pendingRequested: boolean;
  effectRequested: boolean;
  stage: OperationStage;
  nameValue: string | undefined;
  responseTarget: Request;
}

type OperationStage =
  | "call"
  | "name_wait"
  | "name_received"
  | "pending_wait"
  | "pending_received"
  | "effect_wait"
  | "effect_received"
  | "settling";

type PendingValue =
  | {
      readonly kind: "do";
      readonly retryDelaysSeconds: readonly number[];
    }
  | { readonly kind: "sleep"; readonly seconds: number }
  | { readonly kind: "wait"; readonly type: string; readonly timeoutSeconds: number };

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_REQUESTS = 64;
const MAX_TOKEN = 128;
const MAX_TOKENS = 1_024;
const MAX_SECONDS = 31_536_000;
const MAX_RETRY_DELAY = 43_200;
const MAX_RETRY_DELAYS = 99;

const NEED_NAME = '{"kind":"need_name"}';
const NEED_PENDING = '{"kind":"need_pending"}';
const INVOKE_EFFECT = '{"kind":"invoke_effect"}';

/**
 * Construct one private HTTP controller for one isolated Workflow run.
 *
 * The methods intentionally expose no public HTTP shape.  The caller owns
 * marker/payload correlation and physical request lifecycle; this module only
 * validates the closed protocol and bridges one live driver turn at a time.
 */
export function createWorkflowHttpController(): WorkflowHttpController {
  const requests = new Map<number, Request>();
  const byStepName = new Map<
    string,
    { readonly token: string; readonly error: WorkflowStepError }
  >();
  const byToken = new Map<string, WorkflowStepError>();

  let driver: WorkflowDriver | undefined;
  let operation: OperationContext | undefined;
  let mismatchRequest: Request | undefined;
  let mismatchLatched = false;
  let expectedCall = 1;
  let tokenCounter = 0;
  let completed = false;
  let closed = false;
  let failure: WorkflowRuntimeError | undefined;
  let failedReject!: (reason: unknown) => void;
  const failed = new Promise<never>((_resolve, reject) => {
    failedReject = reject;
  });
  // A child run can legitimately complete without this Promise ever settling.
  // Keep its rejection observed so an ingress failure does not become an
  // unhandled rejection before the owning host races it.
  void failed.catch(() => undefined);

  function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
      resolve = yes;
      reject = no;
    });
    void promise.catch(() => undefined);
    return { promise, resolve, reject };
  }

  function parked<T>(): Promise<T> {
    return new Promise<T>(() => undefined);
  }

  function runtime(
    code: ConstructorParameters<typeof WorkflowRuntimeError>[0],
  ): WorkflowRuntimeError {
    return new WorkflowRuntimeError(code);
  }

  function protocolFailure(): WorkflowRuntimeError {
    return runtime("invalid_runtime_input");
  }

  function hostUnavailable(): WorkflowRuntimeError {
    return runtime("host_unavailable");
  }

  function retainFailure(
    error: unknown,
    fallback: WorkflowRuntimeError = protocolFailure(),
  ): WorkflowRuntimeError {
    if (failure) return failure;
    failure = isWorkflowRuntimeError(error) ? error : fallback;
    closed = true;
    for (const request of requests.values()) request.deferred.reject(failure);
    requests.clear();
    if (operation) {
      operation.name.reject(failure);
      operation.pending.reject(failure);
      operation.effect.reject(failure);
      operation = undefined;
    }
    if (mismatchRequest) {
      mismatchRequest.deferred.reject(failure);
      mismatchRequest = undefined;
    }
    failedReject(failure);
    return failure;
  }

  function ensurePayload(payload: unknown): asserts payload is string {
    if (typeof payload !== "string" || payload.length === 0 || payload.length > MAX_FRAME_BYTES) {
      throw protocolFailure();
    }
    if (new TextEncoder().encode(payload).byteLength > MAX_FRAME_BYTES) {
      throw protocolFailure();
    }
  }

  function ensureSequence(sequence: unknown): asserts sequence is number {
    if (typeof sequence !== "number" || !Number.isSafeInteger(sequence) || sequence < 1) {
      throw protocolFailure();
    }
  }

  function ensureCall(value: unknown): asserts value is number {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
      throw protocolFailure();
    }
  }

  function ensureToken(value: unknown): asserts value is string {
    if (typeof value !== "string" || value.length === 0 || value.length > MAX_TOKEN) {
      throw protocolFailure();
    }
  }

  function parseFrame(payload: string): Record<string, unknown> {
    ensurePayload(payload);
    let value: unknown;
    try {
      value = JSON.parse(payload);
    } catch {
      throw protocolFailure();
    }
    try {
      return plainInputRecord(value, "workflow frame");
    } catch {
      throw protocolFailure();
    }
  }

  function closedFrame(
    frame: Record<string, unknown>,
    keys: readonly string[],
  ): Record<string, unknown> {
    for (const key of Object.keys(frame)) {
      if (!keys.includes(key)) throw protocolFailure();
    }
    return frame;
  }

  function owns(frame: Record<string, unknown>, kind: FrameKind): void {
    if (frame.kind !== kind) throw protocolFailure();
  }

  function requestResponse(request: Request, response: string): void {
    if (request.answered) throw protocolFailure();
    request.answered = true;
    requests.delete(request.sequence);
    request.deferred.resolve(response);
  }

  function jsonSettled(value: JsonObject | undefined): string {
    if (value === undefined) return '{"kind":"settled","present":false}';
    try {
      return `{"kind":"settled","present":true,"value":${encodeDocument(value)}}`;
    } catch {
      throw protocolFailure();
    }
  }

  function jsonStepError(code: "step_failed" | "wait_timeout", token: string): string {
    return `{"kind":"step_error","code":${JSON.stringify(code)},"token":${JSON.stringify(token)}}`;
  }

  function normalizeName(value: unknown): string {
    try {
      return inputIdentifier(value, "step name");
    } catch {
      throw protocolFailure();
    }
  }

  function normalizeEventType(value: unknown): string {
    try {
      return inputIdentifier(value, "event type");
    } catch {
      throw protocolFailure();
    }
  }

  function integer(value: unknown, minimum: number, maximum: number): number {
    if (
      typeof value !== "number" ||
      !Number.isSafeInteger(value) ||
      value < minimum ||
      value > maximum
    ) {
      throw protocolFailure();
    }
    return value;
  }

  function parseObjectValue(value: unknown): JsonObject {
    try {
      // Values arrive as JSON objects, but re-encoding gives this side an
      // independent data-only and one-megabyte bound before exposing them to
      // the host driver.
      return parseDocument(encodeDocument(value));
    } catch {
      throw protocolFailure();
    }
  }

  function pendingValue(context: OperationContext, frame: Record<string, unknown>): PendingValue {
    owns(frame, "pending");
    ensureCall(frame.call);
    if (frame.call !== context.call) throw protocolFailure();
    if (context.operation === "do") {
      if (
        !Array.isArray(frame.retryDelaysSeconds) ||
        frame.retryDelaysSeconds.length > MAX_RETRY_DELAYS
      ) {
        throw protocolFailure();
      }
      const delays: number[] = [];
      for (const delay of frame.retryDelaysSeconds) {
        delays.push(integer(delay, 0, MAX_RETRY_DELAY));
      }
      return { kind: "do", retryDelaysSeconds: delays };
    }
    if (context.operation === "sleep") {
      if (
        Object.hasOwn(frame, "retryDelaysSeconds") ||
        Object.hasOwn(frame, "type") ||
        Object.hasOwn(frame, "timeoutSeconds")
      ) {
        throw protocolFailure();
      }
      return { kind: "sleep", seconds: integer(frame.seconds, 0, MAX_SECONDS) };
    }
    return {
      kind: "wait",
      type: normalizeEventType(frame.type),
      timeoutSeconds: integer(frame.timeoutSeconds, 1, MAX_SECONDS),
    };
  }

  function issueToken(name: string, error: WorkflowStepError): string {
    const existing = byStepName.get(name);
    if (existing) {
      if (existing.error.code !== error.code) throw protocolFailure();
      return existing.token;
    }
    if (byStepName.size >= MAX_TOKENS) throw protocolFailure();
    tokenCounter += 1;
    if (tokenCounter > MAX_TOKENS) throw protocolFailure();
    const token = `wf-${tokenCounter.toString(36)}`;
    byStepName.set(name, { token, error });
    byToken.set(token, error);
    return token;
  }

  function driverError(context: OperationContext, error: unknown): void {
    if (failure || closed || mismatchLatched) return;
    const target = context.responseTarget;
    // Once a command has already answered its HTTP request, a driver failure
    // has no legal response turn.  Never attempt to write a second command to
    // an acknowledged request; retain it as infrastructure instead.
    if (target.answered) throw retainFailure(error, hostUnavailable());
    const checkedInput = isWorkflowCallInputError(error)
      ? error.error
      : isWorkflowCallInputTypeError(error)
        ? error
        : undefined;
    if (checkedInput !== undefined) {
      // A checked callback error can be represented on the wire only after the
      // child has actually received need_name.  A driver rejection before
      // that point has no corresponding child input_error turn and is an
      // infrastructure failure, never an application attempt result.
      if (!context.nameRequested) throw retainFailure(error, hostUnavailable());
      requestResponse(target, '{"kind":"input_error"}');
      operation = undefined;
      return;
    }
    if (
      isWorkflowStepError(error) &&
      (error.code === "step_failed" || error.code === "wait_timeout")
    ) {
      const name = context.nameValue;
      if (name === undefined) {
        throw retainFailure(protocolFailure());
      }
      const token = issueToken(name, error);
      requestResponse(target, jsonStepError(error.code, token));
      operation = undefined;
      return;
    }
    throw retainFailure(error, hostUnavailable());
  }

  function operationSettled(context: OperationContext, value: unknown): void {
    if (failure || closed || mismatchLatched) return;
    if (!context.nameRequested) throw retainFailure(hostUnavailable());
    if (
      value !== undefined &&
      (typeof value !== "object" || value === null || Array.isArray(value))
    ) {
      throw retainFailure(protocolFailure());
    }
    const result = value === undefined ? undefined : parseObjectValue(value);
    requestResponse(context.responseTarget, jsonSettled(result));
    operation = undefined;
  }

  function invoke(context: OperationContext): void {
    const selected = driver;
    if (!selected) throw retainFailure(hostUnavailable());
    const prepareName = (): Promise<string> => {
      if (failure || closed) return Promise.reject(hostUnavailable());
      if (mismatchLatched) return parked<string>();
      if (context.nameRequested || context.stage !== "call") {
        throw retainFailure(protocolFailure());
      }
      context.nameRequested = true;
      context.stage = "name_wait";
      requestResponse(context.request, NEED_NAME);
      return context.name.promise;
    };
    const preparePending = (): Promise<PendingValue> => {
      if (failure || closed) return Promise.reject(hostUnavailable());
      if (mismatchLatched) return parked<PendingValue>();
      if (!context.nameRequested || context.pendingRequested || context.stage !== "name_received") {
        throw retainFailure(protocolFailure());
      }
      context.pendingRequested = true;
      context.stage = "pending_wait";
      requestResponse(context.responseTarget, NEED_PENDING);
      return context.pending.promise;
    };
    const effect = (): Promise<JsonObject | undefined> => {
      if (failure || closed) return Promise.reject(hostUnavailable());
      if (mismatchLatched) return parked<JsonObject | undefined>();
      if (
        context.operation !== "do" ||
        !context.pendingRequested ||
        context.effectRequested ||
        context.stage !== "pending_received"
      ) {
        throw retainFailure(protocolFailure());
      }
      context.effectRequested = true;
      context.stage = "effect_wait";
      requestResponse(context.responseTarget, INVOKE_EFFECT);
      return context.effect.promise;
    };

    let result: Promise<unknown>;
    try {
      if (context.operation === "do") {
        result = selected.do(prepareName, async () => {
          const pending = await preparePending();
          if (pending.kind !== "do") throw retainFailure(protocolFailure());
          return { retryDelaysSeconds: pending.retryDelaysSeconds, effect };
        });
      } else if (context.operation === "sleep") {
        result = selected.sleep(prepareName, async () => {
          const pending = await preparePending();
          if (pending.kind !== "sleep") throw retainFailure(protocolFailure());
          return pending.seconds;
        });
      } else {
        result = selected.waitForEvent(prepareName, async () => {
          const pending = await preparePending();
          if (pending.kind !== "wait") throw retainFailure(protocolFailure());
          return { type: pending.type, timeoutSeconds: pending.timeoutSeconds };
        });
      }
    } catch (error) {
      driverError(context, error);
      return;
    }
    if (!result || typeof result.then !== "function") {
      driverError(context, protocolFailure());
      return;
    }
    void result.then(
      (value) => {
        if (failure || closed || mismatchLatched) return;
        context.stage = "settling";
        try {
          operationSettled(context, value);
        } catch (error) {
          retainFailure(error);
        }
      },
      (error: unknown) => {
        if (failure || closed || mismatchLatched) return;
        try {
          driverError(context, error);
        } catch {
          // driverError already retained the typed infrastructure failure.
        }
      },
    );
  }

  function accept(request: Request, frame: Record<string, unknown>): void {
    const kind = frame.kind;
    if (kind === "mismatch") {
      closedFrame(frame, ["kind"]);
      if (mismatchLatched || !driver) throw protocolFailure();
      mismatchLatched = true;
      mismatchRequest = request;
      try {
        const mismatch = driver.definitionMismatch();
        if (!mismatch || typeof mismatch.then !== "function") throw protocolFailure();
        void mismatch.catch((error: unknown) => {
          if (!failure && !closed) retainFailure(error, hostUnavailable());
        });
      } catch (error) {
        throw retainFailure(error, hostUnavailable());
      }
      return;
    }
    if (kind === "call") {
      owns(frame, "call");
      closedFrame(frame, ["kind", "call", "operation"]);
      ensureCall(frame.call);
      if (frame.operation !== "do" && frame.operation !== "sleep" && frame.operation !== "wait") {
        throw protocolFailure();
      }
      if (operation || mismatchLatched) {
        throw protocolFailure();
      }
      if (completed || frame.call !== expectedCall) throw protocolFailure();
      const context: OperationContext = {
        call: frame.call,
        operation: frame.operation,
        request,
        name: deferred<string>(),
        pending: deferred<PendingValue>(),
        effect: deferred<JsonObject | undefined>(),
        nameRequested: false,
        pendingRequested: false,
        effectRequested: false,
        stage: "call",
        nameValue: undefined,
        responseTarget: request,
      };
      operation = context;
      expectedCall += 1;
      invoke(context);
      return;
    }

    const context = operation;
    if (!context) throw protocolFailure();
    ensureCall(frame.call);
    if (frame.call !== context.call) throw protocolFailure();

    if (kind === "name") {
      owns(frame, "name");
      closedFrame(frame, ["kind", "call", "name"]);
      if (context.stage !== "name_wait") throw protocolFailure();
      context.nameValue = normalizeName(frame.name);
      context.responseTarget = request;
      context.stage = "name_received";
      context.name.resolve(context.nameValue);
      return;
    }
    if (kind === "pending") {
      closedFrame(
        frame,
        context.operation === "do"
          ? ["kind", "call", "retryDelaysSeconds"]
          : context.operation === "sleep"
            ? ["kind", "call", "seconds"]
            : ["kind", "call", "type", "timeoutSeconds"],
      );
      if (context.stage !== "pending_wait") throw protocolFailure();
      context.responseTarget = request;
      context.stage = "pending_received";
      context.pending.resolve(pendingValue(context, frame));
      return;
    }
    if (kind === "effect" || kind === "effect_failed") {
      if (context.operation !== "do" || context.stage !== "effect_wait") throw protocolFailure();
      if (kind === "effect_failed") {
        owns(frame, "effect_failed");
        closedFrame(frame, ["kind", "call"]);
        context.responseTarget = request;
        context.stage = "effect_received";
        context.effect.reject(new Error("effect_failed"));
        return;
      }
      owns(frame, "effect");
      closedFrame(frame, ["kind", "call", "present", "value"]);
      if (frame.present !== true && frame.present !== false) throw protocolFailure();
      let value: JsonObject | undefined;
      if (frame.present === false) {
        if (Object.hasOwn(frame, "value")) throw protocolFailure();
      } else {
        if (!Object.hasOwn(frame, "value")) throw protocolFailure();
        value = parseObjectValue(frame.value);
      }
      context.responseTarget = request;
      context.stage = "effect_received";
      context.effect.resolve(value);
      return;
    }
    if (kind === "input_error") {
      owns(frame, "input_error");
      closedFrame(frame, ["kind", "call"]);
      if (context.stage !== "name_wait" && context.stage !== "pending_wait") {
        throw protocolFailure();
      }
      context.responseTarget = request;
      const waitingStage = context.stage;
      context.stage = "settling";
      // `input_error` is sent by the child only after a checked host callback
      // threw.  Rejecting the matching callback lets the real driver classify
      // that native TypeError; the result handler sends the next input_error.
      const checked = new WorkflowCallInputError(new TypeError("invalid workflow step arguments"));
      if (waitingStage === "name_wait") context.name.reject(checked);
      else context.pending.reject(checked);
      return;
    }
    throw protocolFailure();
  }

  function exchange(sequence: number, payload: string): Promise<string> {
    if (failure) return Promise.reject(failure);
    if (closed || completed) return Promise.reject(hostUnavailable());
    try {
      ensureSequence(sequence);
      ensurePayload(payload);
    } catch (error) {
      const retained = retainFailure(error);
      return Promise.reject(retained);
    }
    if (requests.has(sequence) || requests.size >= MAX_PENDING_REQUESTS) {
      const retained = retainFailure(protocolFailure());
      return Promise.reject(retained);
    }
    const request: Request = {
      sequence,
      payload,
      accepted: false,
      answered: false,
      deferred: deferred<string>(),
    };
    requests.set(sequence, request);
    return request.deferred.promise;
  }

  function acceptFrame(sequence: number, payload: string): void {
    if (failure) throw failure;
    if (closed || completed) throw hostUnavailable();
    let frame: Record<string, unknown>;
    try {
      ensureSequence(sequence);
      ensurePayload(payload);
      const request = requests.get(sequence);
      if (!request || request.accepted || request.payload !== payload) throw protocolFailure();
      request.accepted = true;
      frame = parseFrame(payload);
      accept(request, frame);
    } catch (error) {
      throw retainFailure(error);
    }
  }

  function run(nextDriver: WorkflowDriver): void {
    if (failure) throw failure;
    if (closed || completed || driver !== undefined) throw hostUnavailable();
    if (
      nextDriver === null ||
      typeof nextDriver !== "object" ||
      typeof nextDriver.do !== "function" ||
      typeof nextDriver.sleep !== "function" ||
      typeof nextDriver.waitForEvent !== "function" ||
      typeof nextDriver.definitionMismatch !== "function"
    ) {
      throw retainFailure(runtime("invalid_runtime_input"));
    }
    driver = nextDriver;
  }

  function outcome(payload: string): WorkflowApplicationOutcome {
    if (failure) throw failure;
    if (closed || completed || operation || mismatchLatched || requests.size !== 0) {
      throw retainFailure(protocolFailure());
    }
    try {
      const frame = parseFrame(payload);
      if (frame.kind === "complete") {
        closedFrame(frame, ["kind", "present", "value"]);
        if (frame.present === false) {
          if (Object.keys(frame).length !== 2 || Object.hasOwn(frame, "value")) {
            throw protocolFailure();
          }
          completed = true;
          return { kind: "complete" };
        }
        if (
          frame.present !== true ||
          !Object.hasOwn(frame, "value") ||
          Object.keys(frame).length !== 3
        ) {
          throw protocolFailure();
        }
        const output = parseObjectValue(frame.value);
        completed = true;
        return { kind: "complete", output };
      }
      if (frame.kind === "failed") {
        const reason = frame.reason;
        closedFrame(frame, ["kind", "reason", "token"]);
        if (reason === "run_threw") {
          if (Object.keys(frame).length !== 2) throw protocolFailure();
          completed = true;
          return { kind: "failed", reason: "run_threw" };
        }
        if (reason !== "step_failed" || Object.keys(frame).length !== 3) throw protocolFailure();
        ensureToken(frame.token);
        const error = byToken.get(frame.token);
        if (!error || error.code !== "step_failed") throw protocolFailure();
        completed = true;
        return { kind: "failed", reason: "step_failed", error };
      }
      throw protocolFailure();
    } catch (error) {
      throw retainFailure(error);
    }
  }

  function close(): void {
    if (failure || closed) return;
    if (completed) {
      closed = true;
      return;
    }
    retainFailure(hostUnavailable(), hostUnavailable());
  }

  return { run, exchange, acceptFrame, outcome, close, failed };
}
