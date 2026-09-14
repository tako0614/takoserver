/**
 * The private, in-memory bridge between a trusted execution marker stream and
 * the payload stream that arrives through the owning adapter.  This is
 * deliberately not a durable step journal and it does not expose a Binding
 * or a public transport protocol.
 *
 * Markers are accepted in their trusted, consecutive order.  Payloads may
 * arrive before their marker (or in another order), but a payload is handed to
 * the observer only after its marker and every earlier sequence have been
 * observed and dispatched.
 */

export const WORKFLOW_TRANSPORT_MAX_PENDING_ENTRIES = 64;
export const WORKFLOW_TRANSPORT_SEQUENCE_WINDOW = 64;
export const WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES = 2 * 1024 * 1024;

export type WorkflowTransportJournalErrorCode =
  | "invalid_frame"
  | "capacity"
  | "unpaired_frame"
  | "dispatch_failed"
  | "sealed";

export class WorkflowTransportJournalError extends Error {
  constructor(readonly code: WorkflowTransportJournalErrorCode) {
    super(code);
    this.name = "WorkflowTransportJournalError";
  }
}

export interface WorkflowTransportJournal {
  /** Observe one trusted marker. Marker sequences must start at one and stay consecutive. */
  recordMarker(sequence: number): void;
  /** Observe one payload. Payloads may precede their marker within the bounded window. */
  recordPayload(sequence: number, payload: string): void;
  /** Permanently close the journal after the adapter's physical ingress barrier. */
  seal(): void;
}

export interface WorkflowTransportJournalOptions {
  /** Synchronous bookkeeping/control-latch observer. A return value is refused. */
  readonly dispatch: (sequence: number, payload: string) => void;
}

/**
 * Create one one-use, ephemeral marker/payload correlation journal.
 *
 * The observer is deliberately invoked synchronously.  In particular, a
 * Promise returned by an accidentally async observer is not awaited and does
 * not constitute an acknowledgement.
 */
export function createWorkflowTransportJournal(
  options: WorkflowTransportJournalOptions,
): WorkflowTransportJournal {
  if (typeof options?.dispatch !== "function") {
    throw new WorkflowTransportJournalError("invalid_frame");
  }
  const dispatch = options.dispatch;

  const markers = new Set<number>();
  const payloads = new Map<number, string>();
  let nextMarker = 1;
  let nextDispatch = 1;
  let dispatching = false;
  let sealed = false;
  let sealedError: WorkflowTransportJournalError | undefined;
  let failure: WorkflowTransportJournalError | undefined;

  function rejectSealed(): never {
    sealedError ??= new WorkflowTransportJournalError("sealed");
    throw sealedError;
  }

  function assertAccepting(): void {
    if (failure) throw failure;
    if (sealed) rejectSealed();
  }

  function fail(code: WorkflowTransportJournalErrorCode): never {
    if (failure) throw failure;
    const error = new WorkflowTransportJournalError(code);
    failure = error;
    // Payloads can contain application data.  A failed one-use journal keeps
    // no frame material and accepts no recovery or late ingress.
    markers.clear();
    payloads.clear();
    throw error;
  }

  function validSequence(sequence: number): boolean {
    return (
      Number.isSafeInteger(sequence) &&
      sequence >= 1 &&
      sequence >= nextDispatch &&
      sequence - nextDispatch < WORKFLOW_TRANSPORT_SEQUENCE_WINDOW
    );
  }

  function pendingUnpairedEntries(): number {
    let count = 0;
    for (const sequence of markers) {
      if (!payloads.has(sequence)) count += 1;
    }
    for (const sequence of payloads.keys()) {
      if (!markers.has(sequence)) count += 1;
    }
    return count;
  }

  function validatePayload(payload: string): void {
    if (typeof payload !== "string" || payload.length === 0) fail("invalid_frame");
    // Reject obviously oversized JS strings before allocating a UTF-8 buffer.
    // Strings at or below this code-unit bound still need an exact byte check:
    // non-ASCII input may occupy more than one byte per code unit.
    if (payload.length > WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES) fail("invalid_frame");
    const encoded = new TextEncoder().encode(payload);
    if (encoded.byteLength > WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES) fail("invalid_frame");
  }

  function validateWindow(sequence: number): void {
    if (!validSequence(sequence)) fail("invalid_frame");
  }

  function drain(): void {
    if (dispatching || failure || sealed) return;

    while (!dispatching && !failure && !sealed) {
      const sequence = nextDispatch;
      if (!markers.has(sequence)) return;
      const payload = payloads.get(sequence);
      if (payload === undefined) return;

      // Keep the pair in the maps while the observer runs.  A reentrant
      // duplicate therefore fails closed instead of looking like a second
      // acknowledgement; reentrant future frames are accepted and queued by
      // the dispatching latch (the next loop iteration drains them in order).
      dispatching = true;
      try {
        const result = dispatch(sequence, payload);
        if (result !== undefined) {
          dispatching = false;
          fail("dispatch_failed");
        }
        if (failure) {
          dispatching = false;
          throw failure;
        }
      } catch {
        dispatching = false;
        if (failure) throw failure;
        fail("dispatch_failed");
      }
      dispatching = false;

      // Only the synchronous, undefined-returning observer is an ACK.  The
      // pair is retired after it returns, then the contiguous prefix can move.
      markers.delete(sequence);
      payloads.delete(sequence);
      nextDispatch = sequence + 1;
    }
  }

  function recordMarker(sequence: number): void {
    assertAccepting();
    validateWindow(sequence);
    if (sequence !== nextMarker) fail("invalid_frame");

    const hasPayload = payloads.has(sequence);
    if (!hasPayload && pendingUnpairedEntries() >= WORKFLOW_TRANSPORT_MAX_PENDING_ENTRIES) {
      fail("capacity");
    }

    markers.add(sequence);
    nextMarker += 1;
    drain();
  }

  function recordPayload(sequence: number, payload: string): void {
    assertAccepting();
    validateWindow(sequence);
    if (payloads.has(sequence)) fail("invalid_frame");
    validatePayload(payload);

    const hasMarker = markers.has(sequence);
    if (!hasMarker && pendingUnpairedEntries() >= WORKFLOW_TRANSPORT_MAX_PENDING_ENTRIES) {
      fail("capacity");
    }

    payloads.set(sequence, payload);
    drain();
  }

  function seal(): void {
    if (failure) throw failure;
    // A callback must never be able to close the journal in the middle of an
    // observer invocation.  This refusal is transient; if the callback catches
    // it, the queued frames can still be drained and the adapter can seal after
    // its ingress barrier.
    if (dispatching) rejectSealed();
    if (sealed) return;

    drain();
    if (failure) throw failure;
    if (pendingUnpairedEntries() !== 0) fail("unpaired_frame");
    sealed = true;
  }

  return { recordMarker, recordPayload, seal };
}
