import { expect, test } from "bun:test";
import {
  createWorkflowTransportJournal,
  WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES,
  WORKFLOW_TRANSPORT_SEQUENCE_WINDOW,
  type WorkflowTransportJournal,
  WorkflowTransportJournalError,
} from "../src/workflow-transport-journal.ts";

function journalWith(
  calls: Array<{ sequence: number; payload: string }>,
): WorkflowTransportJournal {
  return createWorkflowTransportJournal({
    dispatch(sequence, payload) {
      calls.push({ sequence, payload });
    },
  });
}

test("pairs payload-first and marker-first arrivals exactly once", () => {
  for (const payloadFirst of [true, false]) {
    const calls: Array<{ sequence: number; payload: string }> = [];
    const journal = journalWith(calls);
    if (payloadFirst) journal.recordPayload(1, "one");
    journal.recordMarker(1);
    if (!payloadFirst) journal.recordPayload(1, "one");
    expect(calls).toEqual([{ sequence: 1, payload: "one" }]);
    journal.seal();
  }
});

test("drains only the contiguous marker/payload prefix in sequence order", () => {
  const calls: Array<{ sequence: number; payload: string }> = [];
  const journal = journalWith(calls);
  journal.recordPayload(3, "three");
  journal.recordPayload(2, "two");
  journal.recordMarker(1);
  journal.recordMarker(2);
  journal.recordMarker(3);
  expect(calls).toEqual([]);
  journal.recordPayload(1, "one");
  expect(calls).toEqual([
    { sequence: 1, payload: "one" },
    { sequence: 2, payload: "two" },
    { sequence: 3, payload: "three" },
  ]);
  journal.seal();
});

test("marker gaps and duplicates fail closed", () => {
  const gap = journalWith([]);
  expect(() => gap.recordMarker(2)).toThrow(new WorkflowTransportJournalError("invalid_frame"));
  expect(() => gap.recordMarker(1)).toThrow("invalid_frame");

  const duplicate = journalWith([]);
  duplicate.recordMarker(1);
  expect(() => duplicate.recordMarker(1)).toThrow("invalid_frame");
});

test("duplicate and already-dispatched payloads fail closed", () => {
  const beforeMarker = journalWith([]);
  beforeMarker.recordPayload(1, "one");
  expect(() => beforeMarker.recordPayload(1, "again")).toThrow("invalid_frame");

  const afterDispatchCalls: Array<{ sequence: number; payload: string }> = [];
  const afterDispatch = journalWith(afterDispatchCalls);
  afterDispatch.recordMarker(1);
  afterDispatch.recordPayload(1, "one");
  expect(() => afterDispatch.recordPayload(1, "again")).toThrow("invalid_frame");
  expect(afterDispatchCalls).toHaveLength(1);
});

test("invalid numbers and sequences outside the moving window fail closed", () => {
  for (const value of [Number.NaN, Number.POSITIVE_INFINITY, 0, -1, 1.5, "1"] as unknown[]) {
    const journal = journalWith([]);
    expect(() => journal.recordPayload(value as number, "x")).toThrow("invalid_frame");
  }
  const journal = journalWith([]);
  expect(() => journal.recordPayload(1 + WORKFLOW_TRANSPORT_SEQUENCE_WINDOW, "x")).toThrow(
    "invalid_frame",
  );
});

test("payload validation enforces nonempty UTF-8 bytes and checks length before encoding", () => {
  const empty = journalWith([]);
  expect(() => empty.recordPayload(1, "")).toThrow("invalid_frame");

  const exact = "é".repeat(WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES / 2);
  const exactCalls: Array<{ sequence: number; payload: string }> = [];
  const exactJournal = journalWith(exactCalls);
  exactJournal.recordPayload(1, exact);
  exactJournal.recordMarker(1);
  expect(exactCalls[0]?.payload).toBe(exact);

  const overBytes = journalWith([]);
  expect(() =>
    overBytes.recordPayload(1, "é".repeat(WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES / 2 + 1)),
  ).toThrow("invalid_frame");

  const overCodeUnits = journalWith([]);
  expect(() =>
    overCodeUnits.recordPayload(1, "x".repeat(WORKFLOW_TRANSPORT_MAX_PAYLOAD_BYTES + 1)),
  ).toThrow("invalid_frame");
});

test("seal rejects an unpaired frame permanently and retains its typed error", () => {
  const calls: Array<{ sequence: number; payload: string }> = [];
  const journal = journalWith(calls);
  journal.recordMarker(1);
  let failure: unknown;
  try {
    journal.seal();
  } catch (error) {
    failure = error;
  }
  expect(failure).toMatchObject({ code: "unpaired_frame" });
  expect(() => journal.seal()).toThrow(failure as Error);
  expect(() => journal.recordPayload(1, "late")).toThrow("unpaired_frame");
  expect(calls).toEqual([]);
});

test("a payload without its marker is withheld and cannot arrive after a failed seal", () => {
  const calls: Array<{ sequence: number; payload: string }> = [];
  const journal = journalWith(calls);
  journal.recordPayload(1, "one");
  expect(() => journal.seal()).toThrow("unpaired_frame");
  expect(() => journal.recordMarker(1)).toThrow("unpaired_frame");
  expect(calls).toEqual([]);
});

test("successful seal is idempotent and rejects late frames without dispatch", () => {
  const calls: Array<{ sequence: number; payload: string }> = [];
  const journal = journalWith(calls);
  journal.recordMarker(1);
  journal.recordPayload(1, "one");
  journal.seal();
  journal.seal();
  expect(() => journal.recordMarker(2)).toThrow("sealed");
  expect(() => journal.recordPayload(2, "late")).toThrow("sealed");
  expect(calls).toEqual([{ sequence: 1, payload: "one" }]);
});

test("observer throws and nonundefined returns become dispatch_failed", () => {
  const throwing = createWorkflowTransportJournal({
    dispatch() {
      throw new Error("observer failed");
    },
  });
  throwing.recordMarker(1);
  expect(() => throwing.recordPayload(1, "one")).toThrow("dispatch_failed");
  expect(() => throwing.seal()).toThrow("dispatch_failed");

  const returning = createWorkflowTransportJournal({
    dispatch: (() => Promise.resolve()) as unknown as (sequence: number, payload: string) => void,
  });
  returning.recordMarker(1);
  expect(() => returning.recordPayload(1, "one")).toThrow("dispatch_failed");
});

test("reentrant receive queues safely and reentrant seal cannot acknowledge mid-callback", () => {
  const calls: Array<{ sequence: number; payload: string }> = [];
  let journal!: WorkflowTransportJournal;
  journal = createWorkflowTransportJournal({
    dispatch(sequence, payload) {
      calls.push({ sequence, payload });
      if (sequence === 1) {
        journal.recordMarker(2);
        journal.recordPayload(2, "two");
        expect(() => journal.seal()).toThrow("sealed");
      }
    },
  });
  journal.recordMarker(1);
  journal.recordPayload(1, "one");
  expect(calls).toEqual([
    { sequence: 1, payload: "one" },
    { sequence: 2, payload: "two" },
  ]);
  journal.seal();
});
