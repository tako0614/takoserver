/** PRIVATE mechanical SQL execution DATA. No provider or admission permission API.
 * Qualified Root backing origin, genuine Auth/Clock and the actual caller are not mounted.
 */
import { canonicalJson } from "./json.ts";
import { type Row, type Sql, SqlError, type SqlStatement, type SqlWrite } from "./ports.ts";
import {
  type CustomerPhaseInput,
  compileCustomerPhase,
} from "./shared-financial-customer-dispatch.ts";
import {
  type CustomerCompletedReceipt,
  readCompletedCustomerReceipt,
} from "./shared-financial-customer-journal.ts";

export interface CustomerBatchAcknowledgementData {
  readonly physicalResults: readonly {
    readonly index: number;
    readonly changes: 1;
    readonly returnedRows: 0;
  }[];
  /** Actual result[2] of this invocation, never inferred from a receipt INSERT. */
  readonly dispatchCasChanges: 1 | null;
}
export type CustomerReceiptObservationData =
  /** Null full-chain read also covers partial/corrupt/unexplained history: no absence authority. */
  | { readonly status: "no-completed-match" }
  | { readonly status: "matching-original"; readonly receipt: CustomerCompletedReceipt }
  | { readonly status: "mismatch" | "unavailable" | "sql-method-drift" };
export type CustomerTrackedExecutionData = {
  readonly qualification: "private-mechanical-sql-data-only";
  /** Full detached phase/action/key/context/history data for exact GET-only recovery. */
  readonly original: CustomerPhaseInput;
  readonly observation: CustomerReceiptObservationData;
} & (
  | {
      readonly status: "acknowledged-own-phase-data";
      readonly acknowledgement: CustomerBatchAcknowledgementData;
      readonly observation: {
        readonly status: "matching-original";
        readonly receipt: CustomerCompletedReceipt;
      };
    }
  | {
      readonly status: "get-only";
      readonly reason:
        | "prior-completion"
        | "prior-read-unresolved"
        | "attempt-already-observed"
        | "batch-outcome-unknown"
        | "malformed-batch-ack"
        | "post-ack-read-unresolved"
        | "sql-method-drift";
      readonly acknowledgement: CustomerBatchAcknowledgementData | null;
    }
);

function invalid(): never {
  throw new SqlError("invalid", "invalid Customer execution DATA");
}
class MethodDrift extends Error {}

/** Capture data descriptors only, preserving JSON key order used by frozen Root guards. */
function detached<T>(input: T): T {
  let remaining = 50_000;
  const active = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (--remaining < 0 || depth > 64) invalid();
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (!value || typeof value !== "object" || active.has(value)) invalid();
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (
      array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null
    )
      invalid();
    active.add(value);
    const descriptors = Object.getOwnPropertyDescriptors(value);
    const keys = Reflect.ownKeys(descriptors);
    const result: unknown[] | Record<string, unknown> = array ? [] : Object.create(null);
    if (array) {
      const length = descriptors.length;
      if (
        !length ||
        !("value" in length) ||
        !Number.isSafeInteger(length.value) ||
        length.value < 0 ||
        length.value > 50_000 ||
        keys.length !== length.value + 1
      )
        invalid();
      for (let index = 0; index < length.value; index++) {
        const item = descriptors[String(index)];
        if (!item || !("value" in item) || item.enumerable !== true) invalid();
        (result as unknown[]).push(copy(item.value, depth + 1));
      }
    } else {
      for (const key of keys) {
        if (typeof key !== "string") invalid();
        const item = descriptors[key];
        if (!item || !("value" in item) || item.enumerable !== true) invalid();
        Object.defineProperty(result, key, {
          value: copy(item.value, depth + 1),
          enumerable: true,
        });
      }
    }
    active.delete(value);
    return Object.freeze(result);
  }
  return copy(input, 0) as T;
}

/** Closed, frozen phase original for a request-scoped Financial operation. */
export function captureCustomerTrackedPhaseOriginal(input: CustomerPhaseInput): CustomerPhaseInput {
  const original = detached(input);
  compileCustomerPhase(original);
  return original;
}

function acknowledgement(
  value: unknown,
  phase: CustomerPhaseInput["phase"],
): CustomerBatchAcknowledgementData | null {
  try {
    const result = detached(value);
    if (!Array.isArray(result) || result.length !== (phase === "L1" ? 9 : 8)) return null;
    const physicalResults: { index: number; changes: 1; returnedRows: 0 }[] = [];
    for (let index = 0; index < result.length; index++) {
      const item = result[index];
      if (
        !item ||
        typeof item !== "object" ||
        Array.isArray(item) ||
        Object.keys(item).sort().join() !== "changes,rows" ||
        item.changes !== 1 ||
        !Array.isArray(item.rows) ||
        item.rows.length !== 0
      )
        return null;
      physicalResults.push(Object.freeze({ index, changes: 1, returnedRows: 0 }));
    }
    return Object.freeze({
      physicalResults: Object.freeze(physicalResults),
      dispatchCasChanges: phase === "D" ? 1 : null,
    });
  } catch {
    return null;
  }
}

/** Immutable original context check supplements, and never replaces, the full-chain reader. */
const ORIGINAL = `SELECT e.entry_ref,e.history_ref,e.journal_sequence,e.coupling_attempt_ref,
 e.previous_history_receipt_ref,e.expected_history_receipt_ref,e.transition_ref,e.evidence_kind,
 e.command_org_id,e.original_command_key,e.admission_ref,e.l1_receipt_ref,
 e.dispatch_claim_ref,e.dispatch_receipt_ref,e.custody_receipt_ref,
 a.context_json,a.action_json,a.terms_json,a.challenge_ref,a.grant_ref,a.issuance_attempt,
 a.realm_json,a.customer_request_json,a.customer_fingerprint,a.stripe_key,a.created_at,
 cv.coverage_incarnation,cv.original_org_origin,cv.realm_registration,cv.realm_incarnation,cv.writer_epoch,
 hr.previous_entry_ref,hr.previous_journal_sequence,
 dc.attempt_ref AS dispatch_attempt_ref,dc.context_json AS dispatch_context_json,
 dc.expected_dispatch_receipt_ref AS dispatch_expected_receipt_ref,dc.created_at AS dispatch_created_at
 FROM financial_customer_history_entries e
 JOIN financial_customer_history_receipts hr ON hr.receipt_ref=e.expected_history_receipt_ref AND hr.entry_ref=e.entry_ref
 JOIN financial_customer_history_coverages cv ON cv.history_ref=e.history_ref
 JOIN financial_customer_admissions a ON a.admission_ref=e.admission_ref
 LEFT JOIN financial_customer_dispatch_claims dc ON dc.claim_ref=e.dispatch_claim_ref
 WHERE e.transition_ref=? AND hr.receipt_ref=? LIMIT 2`;

/** The tracker's second and only other fixed observation read. */
export function customerTrackedOriginalReadStatement(
  coreReceiptRef: string,
  historyReceiptRef: string,
): SqlStatement {
  if (
    typeof coreReceiptRef !== "string" ||
    coreReceiptRef.length === 0 ||
    typeof historyReceiptRef !== "string" ||
    historyReceiptRef.length === 0
  )
    invalid();
  return Object.freeze({
    sql: ORIGINAL,
    params: Object.freeze([coreReceiptRef, historyReceiptRef]),
  });
}

function matchesOriginal(
  q: CustomerPhaseInput,
  row: Row,
  receipt: CustomerCompletedReceipt,
): boolean {
  const a = q.admission;
  const phaseKind =
    q.phase === "L1"
      ? "customer-prepared"
      : q.phase === "D"
        ? "customer-first-dispatch"
        : "customer-verified-binding";
  const core =
    q.phase === "L1" ? a.receiptRef : q.phase === "D" ? q.dispatchReceiptRef : q.custodyReceiptRef;
  const expected: Row = {
    entry_ref: q.entryRef,
    history_ref: q.history.historyRef,
    journal_sequence: q.history.journalSequence + 1,
    coupling_attempt_ref: q.couplingAttemptRef,
    previous_history_receipt_ref: q.history.lastReceiptRef,
    expected_history_receipt_ref: q.historyReceiptRef,
    transition_ref: core,
    evidence_kind: phaseKind,
    command_org_id: a.identity.action.organizationId,
    original_command_key: a.original.key,
    admission_ref: a.admissionRef,
    l1_receipt_ref: a.receiptRef,
    dispatch_claim_ref: q.phase === "L1" ? null : q.claimRef,
    dispatch_receipt_ref: q.phase === "L1" ? null : q.dispatchReceiptRef,
    custody_receipt_ref: q.phase === "N" ? q.custodyReceiptRef : null,
    context_json: a.contextJson,
    action_json: canonicalJson(a.identity.action),
    terms_json: a.termsJson,
    challenge_ref: a.input.consent.challengeRef,
    grant_ref: a.input.consent.grantRef,
    issuance_attempt: a.issuanceAttempt,
    realm_json: a.original.realmJson,
    customer_request_json: a.original.requestJson,
    customer_fingerprint: a.original.fingerprint,
    stripe_key: a.original.key,
    created_at: a.createdAt,
    coverage_incarnation: q.history.coverageIncarnation,
    original_org_origin: q.history.originalOrgOrigin,
    realm_registration: q.history.realmRegistration,
    realm_incarnation: q.history.realmIncarnation,
    writer_epoch: q.writerEpoch,
    previous_entry_ref: q.history.lastEntryRef,
    previous_journal_sequence: q.history.journalSequence,
    dispatch_attempt_ref: q.phase === "L1" ? null : q.dispatchAttemptRef,
    dispatch_context_json: q.phase === "L1" ? null : a.contextJson,
    dispatch_expected_receipt_ref: q.phase === "L1" ? null : q.dispatchReceiptRef,
    dispatch_created_at: q.phase === "L1" ? null : q.dispatchedAt,
  };
  return (
    Object.keys(row).sort().join() === Object.keys(expected).sort().join() &&
    Object.entries(expected).every(([key, value]) => row[key] === value) &&
    receipt.evidenceKind === phaseKind &&
    receipt.organizationId === a.identity.action.organizationId &&
    receipt.commandKey === a.original.key &&
    receipt.coreReceiptRef === core &&
    receipt.historyReceiptRef === q.historyReceiptRef &&
    receipt.historyRef === q.history.historyRef &&
    receipt.journalSequence === q.history.journalSequence + 1 &&
    receipt.dispatchedAt === (q.phase === "L1" ? null : q.dispatchedAt) &&
    receipt.customerId === (q.phase === "N" ? q.nativeOriginal.customerId : null) &&
    receipt.verifiedAt === (q.phase === "N" ? q.verifiedAt : null)
  );
}

/**
 * Executes only this module's actual frozen compiler output, including permit0/last.
 * Own-data method/receiver identity is checked before/after every await. This is
 * NOT a Root physical-primary assertion or a qualified production constructor.
 */
export function createCustomerTrackedExecutionData(sql: Sql) {
  function own<K extends "query" | "run" | "batch">(name: K): Sql[K] {
    const property = Object.getOwnPropertyDescriptor(sql, name);
    if (!property || !("value" in property) || typeof property.value !== "function") invalid();
    return property.value;
  }
  const query = own("query"),
    run = own("run"),
    batch = own("batch");
  function stable(): void {
    try {
      if (own("query") !== query || own("run") !== run || own("batch") !== batch)
        throw new MethodDrift();
    } catch {
      throw new MethodDrift();
    }
  }
  async function read(text: string, params?: Parameters<Sql["query"]>[1]): Promise<readonly Row[]> {
    stable();
    const rows: unknown = await Reflect.apply(query, sql, [text, params]);
    stable();
    const captured = detached(rows);
    if (
      !Array.isArray(captured) ||
      captured.some((row) => !row || typeof row !== "object" || Array.isArray(row))
    )
      invalid();
    return captured;
  }
  const readonlySql: Sql = Object.freeze({
    query: read,
    async run(): Promise<SqlWrite> {
      return invalid();
    },
    async batch(): Promise<readonly SqlWrite[]> {
      return invalid();
    },
  });
  async function observe(q: CustomerPhaseInput): Promise<CustomerReceiptObservationData> {
    try {
      const core =
        q.phase === "L1"
          ? q.admission.receiptRef
          : q.phase === "D"
            ? q.dispatchReceiptRef
            : q.custodyReceiptRef;
      const receipt = await readCompletedCustomerReceipt(readonlySql, core);
      stable();
      if (receipt === null) return Object.freeze({ status: "no-completed-match" });
      const originalRead = customerTrackedOriginalReadStatement(core, q.historyReceiptRef);
      const rows = await read(originalRead.sql, originalRead.params);
      if (rows.length !== 1 || !rows[0] || !matchesOriginal(q, rows[0], receipt))
        return Object.freeze({ status: "mismatch" });
      return Object.freeze({ status: "matching-original", receipt: detached(receipt) });
    } catch (error) {
      return Object.freeze({
        status: error instanceof MethodDrift ? "sql-method-drift" : "unavailable",
      });
    }
  }
  // A negative-only local fence: no retry/re-entry of one original, even with a
  // fresh caller-supplied attempt. It is not durable unknown custody or authority.
  const observedOriginals = new Set<string>();
  function originalKey(q: CustomerPhaseInput): string {
    return canonicalJson([
      q.phase,
      q.admission.identity.action.organizationId,
      q.admission.original.key,
    ]);
  }
  return Object.freeze({
    async readOriginal(input: CustomerPhaseInput): Promise<CustomerTrackedExecutionData> {
      const q = detached(input);
      compileCustomerPhase(q); // Closed validation only, no batch.
      observedOriginals.add(originalKey(q)); // Recovery cannot reopen this instance's write lane.
      const observation = await observe(q);
      return Object.freeze({
        qualification: "private-mechanical-sql-data-only",
        original: q,
        status: "get-only",
        reason:
          observation.status === "matching-original" ? "prior-completion" : "prior-read-unresolved",
        acknowledgement: null,
        observation,
      });
    },
    async executePhase(input: CustomerPhaseInput): Promise<CustomerTrackedExecutionData> {
      const q = detached(input);
      const plan = compileCustomerPhase(q);
      const base = { qualification: "private-mechanical-sql-data-only" as const, original: q };
      const key = originalKey(q);
      if (observedOriginals.has(key))
        return Object.freeze({
          ...base,
          status: "get-only",
          reason: "attempt-already-observed",
          acknowledgement: null,
          observation: await observe(q),
        });
      // Close before the first await: concurrent calls cannot both enter a batch.
      observedOriginals.add(key);
      const prior = await observe(q);
      if (prior.status !== "no-completed-match")
        return Object.freeze({
          ...base,
          status: "get-only",
          reason:
            prior.status === "matching-original" ? "prior-completion" : "prior-read-unresolved",
          acknowledgement: null,
          observation: prior,
        });
      let ack: CustomerBatchAcknowledgementData | null;
      try {
        stable();
        const actual: unknown = await Reflect.apply(batch, sql, [plan.statements]);
        stable();
        ack = acknowledgement(actual, q.phase);
      } catch (error) {
        return Object.freeze({
          ...base,
          status: "get-only",
          reason: error instanceof MethodDrift ? "sql-method-drift" : "batch-outcome-unknown",
          acknowledgement: null,
          observation: await observe(q),
        });
      }
      const observation = await observe(q);
      if (ack === null)
        return Object.freeze({
          ...base,
          status: "get-only",
          reason: "malformed-batch-ack",
          acknowledgement: null,
          observation,
        });
      if (observation.status !== "matching-original")
        return Object.freeze({
          ...base,
          status: "get-only",
          reason:
            observation.status === "sql-method-drift"
              ? "sql-method-drift"
              : "post-ack-read-unresolved",
          acknowledgement: ack,
          observation,
        });
      try {
        stable();
      } catch {
        return Object.freeze({
          ...base,
          status: "get-only",
          reason: "sql-method-drift",
          acknowledgement: ack,
          observation: Object.freeze({ status: "sql-method-drift" }),
        });
      }
      return Object.freeze({
        ...base,
        status: "acknowledged-own-phase-data",
        acknowledgement: ack,
        observation,
      });
    },
  });
}
