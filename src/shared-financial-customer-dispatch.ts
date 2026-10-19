/** PRIVATE finite Customer phase SQL compiler. Immutable SQL DATA, never an executor/issuer.
 * No Root backing-origin assertion exists in this closure. Only an actual owning, qualified
 * S/R composition may eventually execute a plan; these objects confer no payer/native authority.
 */
import { canonicalJson } from "./json.ts";
import { SqlError, type SqlParam, type SqlStatement } from "./ports.ts";
import {
  type CustomerAdmissionCandidate,
  prepareCustomerAdmissionBatch,
  prepareCustomerCompletionProof,
} from "./shared-financial-admission.ts";
import {
  CUSTOMER_CHAIN_MATCH,
  CUSTOMER_COVERAGE_JOINS,
  CUSTOMER_COVERAGE_MATCH,
  CUSTOMER_MATCH_CTES,
  type CustomerJournalSnapshot,
  captureCustomerJournalSnapshot,
} from "./shared-financial-customer-journal.ts";

interface Common {
  readonly admission: CustomerAdmissionCandidate;
  readonly history: CustomerJournalSnapshot;
  readonly writerEpoch: string;
  readonly couplingAttemptRef: string;
  readonly entryRef: string;
  readonly historyReceiptRef: string;
}
export interface CustomerPrepareInput extends Common {
  readonly phase: "L1";
}
export interface CustomerDispatchInput extends Common {
  readonly phase: "D";
  readonly claimRef: string;
  readonly dispatchAttemptRef: string;
  readonly dispatchReceiptRef: string;
  readonly dispatchedAt: string;
}
/** Sanitized original DATA only. This compiler does not authenticate a native read. */
export interface CustomerNativeOriginal {
  readonly organizationId: string;
  readonly commandKey: string;
  readonly fingerprint: string;
  readonly realmJson: string;
  readonly requestJson: string;
  readonly customerId: string;
}
export interface CustomerCustodyInput extends Common {
  readonly phase: "N";
  readonly claimRef: string;
  readonly dispatchAttemptRef: string;
  readonly dispatchReceiptRef: string;
  readonly dispatchedAt: string;
  readonly custodyReceiptRef: string;
  readonly verifiedAt: string;
  readonly nativeOriginal: CustomerNativeOriginal;
}
export type CustomerPhaseInput =
  | CustomerPrepareInput
  | CustomerDispatchInput
  | CustomerCustodyInput;
export interface CustomerPhasePlan {
  readonly qualification: "private-mechanical-sql-data";
  readonly phase: "L1" | "D" | "N";
  readonly statements: readonly SqlStatement[];
  readonly coreReceiptRef: string;
  readonly historyReceiptRef: string;
  readonly couplingAttemptRef: string;
  readonly commandKey: string;
  readonly firstDispatchResultIndex: 2 | null;
}
function fail(): never {
  throw new SqlError("invalid", "invalid closed Customer phase data");
}
function text(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) fail();
}
function instant(value: unknown): asserts value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/u.test(value) ||
    !Number.isFinite(Date.parse(value)) ||
    new Date(value).toISOString() !== value
  )
    fail();
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
function capture(value: CustomerPhaseInput): CustomerPhaseInput {
  // The frozen B/Root guard compares the original auth JSON bytes. Canonicalizing
  // key order here changes that evidence even when the values are identical.
  // Detach once in original JSON order, then validate the detached data.
  let q: CustomerPhaseInput;
  try {
    const originalJson = JSON.stringify(value);
    if (typeof originalJson !== "string") fail();
    q = JSON.parse(originalJson) as CustomerPhaseInput;
    canonicalJson(q);
  } catch {
    fail();
  }
  const keys = [
    "phase",
    "admission",
    "history",
    "writerEpoch",
    "couplingAttemptRef",
    "entryRef",
    "historyReceiptRef",
  ];
  if (q.phase === "D" || q.phase === "N")
    keys.push("claimRef", "dispatchAttemptRef", "dispatchReceiptRef", "dispatchedAt");
  if (q.phase === "N") keys.push("custodyReceiptRef", "verifiedAt", "nativeOriginal");
  if (
    (q.phase !== "L1" && q.phase !== "D" && q.phase !== "N") ||
    Object.keys(q).sort().join() !== keys.sort().join()
  )
    fail();
  captureCustomerJournalSnapshot(q.history);
  for (const key of [q.couplingAttemptRef, q.entryRef, q.historyReceiptRef, q.writerEpoch])
    text(key);
  if (!/^sha256:[0-9a-f]{64}$/u.test(q.writerEpoch)) fail();
  // A closed N needs an actual retained close/handoff receipt. The current private
  // schema has no such parent or active->closed transition, so a snapshot must not
  // create that authority. This port remains unresolved until its owner supplies it.
  if (q.history.state !== "active") fail();
  const a = q.admission;
  if (
    !a ||
    a.identity.action.organizationId !== a.input.action.organizationId ||
    canonicalJson(a.identity.action) !== canonicalJson(a.input.action) ||
    a.identity.action.kind !== a.input.consent.actionKind ||
    a.identity.action.reference !== a.input.consent.actionRef ||
    a.identity.requestFingerprint !== a.input.consent.requestFingerprint ||
    a.termsJson !== canonicalJson(a.input.selectedTerms)
  )
    fail();
  instant(a.createdAt);
  for (const key of [
    a.admissionRef,
    a.receiptRef,
    a.issuanceAttempt,
    a.original.key,
    a.original.fingerprint,
  ])
    text(key);
  if (q.phase !== "L1") {
    for (const key of [q.claimRef, q.dispatchAttemptRef, q.dispatchReceiptRef]) text(key);
    instant(q.dispatchedAt);
  }
  if (q.phase === "N") {
    instant(q.verifiedAt);
    text(q.custodyReceiptRef);
    const n = q.nativeOriginal;
    if (
      Object.keys(n).sort().join() !==
        ["organizationId", "commandKey", "fingerprint", "realmJson", "requestJson", "customerId"]
          .sort()
          .join() ||
      n.organizationId !== a.identity.action.organizationId ||
      n.commandKey !== a.original.key ||
      n.fingerprint !== a.original.fingerprint ||
      n.realmJson !== a.original.realmJson ||
      n.requestJson !== a.original.requestJson ||
      !/^cus_[A-Za-z0-9]+$/u.test(n.customerId)
    )
      fail();
  }
  return freeze(q);
}
const OLD = `(SELECT json_extract(data,'$.history.historyRef') AS history_ref,
 json_extract(data,'$.history.coverageIncarnation') AS coverage_incarnation,
 json_extract(data,'$.history.originalOrgOrigin') AS original_org_origin,
 json_extract(data,'$.history.realmRegistration') AS realm_registration,
 json_extract(data,'$.history.realmIncarnation') AS realm_incarnation,
 json_extract(data,'$.history.journalSequence') AS journal_sequence,
 json_extract(data,'$.history.lastEntryRef') AS last_entry_ref,
 json_extract(data,'$.history.lastReceiptRef') AS last_expected_receipt_ref,
 json_extract(data,'$.history.state') AS state FROM v) old`;
// Validate the entire completed old prefix. The single new own entry is checked separately.
const OLD_CHAIN = CUSTOMER_CHAIN_MATCH.replaceAll("hh.", "old.")
  .replace(
    "WHERE e.history_ref=cv.history_ref AND (",
    "WHERE e.history_ref=cv.history_ref AND e.journal_sequence<=old.journal_sequence AND (",
  )
  .replace(
    "WHERE e.history_ref=cv.history_ref)=old.journal_sequence+1",
    "WHERE e.history_ref=cv.history_ref AND e.journal_sequence<=old.journal_sequence)=old.journal_sequence+1",
  );
const V = (key: string) => `json_extract(v.data,'$.${key}')`;
const K_ORIGINAL = `(k.org_id IS ${V("admission.identity.action.organizationId")}
 AND k.realm_json IS ${V("admission.original.realmJson")} AND k.request_json IS ${V("admission.original.requestJson")}
 AND k.fingerprint IS ${V("admission.original.fingerprint")} AND k.stripe_key IS ${V("admission.original.key")}
 AND k.created_at IS ${V("admission.createdAt")})`;
const B_ORIGINAL = `(a.admission_ref IS ${V("admission.admissionRef")} AND a.context_json IS ${V("admission.contextJson")}
 AND a.issuance_attempt IS ${V("admission.issuanceAttempt")} AND a.organization_id IS ${V("admission.identity.action.organizationId")}
 AND a.expected_receipt_ref IS ${V("admission.receiptRef")} AND a.realm_json IS ${V("admission.original.realmJson")}
 AND a.customer_request_json IS ${V("admission.original.requestJson")} AND a.customer_fingerprint IS ${V("admission.original.fingerprint")}
 AND a.stripe_key IS ${V("admission.original.key")} AND a.created_at IS ${V("admission.createdAt")})`;
const B_JOINS = `FROM financial_customer_admissions a JOIN stripe_billing_customer_commands k ON k.org_id=a.organization_id
 JOIN stripe_customer_admission_links l ON l.org_id=a.organization_id AND l.admission_ref=a.admission_ref
 JOIN financial_customer_admission_receipts ar ON ar.admission_ref=a.admission_ref`;
const B_MATCH = `(${B_ORIGINAL} AND ${K_ORIGINAL}
 AND l.customer_fingerprint IS a.customer_fingerprint AND l.stripe_key IS a.stripe_key AND l.realm_json IS a.realm_json
 AND l.customer_request_json IS a.customer_request_json AND l.created_at IS a.created_at
 AND ar.receipt_ref IS a.expected_receipt_ref AND ar.issuance_attempt IS a.issuance_attempt AND ar.org_id IS a.organization_id
 AND ar.created_at IS a.created_at AND ar.all_rows_match IS 1)`;
const D_JOINS = ` JOIN financial_customer_dispatch_claims dc ON dc.org_id=k.org_id AND dc.admission_ref=a.admission_ref
 JOIN financial_customer_dispatch_receipts dr ON dr.claim_ref=dc.claim_ref`;
const D_MATCH = `(${B_MATCH} AND dc.claim_ref IS ${V("claimRef")} AND dc.attempt_ref IS ${V("dispatchAttemptRef")}
 AND dc.l1_receipt_ref IS ar.receipt_ref AND dc.context_json IS a.context_json
 AND dc.expected_dispatch_receipt_ref IS ${V("dispatchReceiptRef")} AND dc.created_at IS ${V("dispatchedAt")}
 AND dr.receipt_ref IS dc.expected_dispatch_receipt_ref AND dr.attempt_ref IS dc.attempt_ref AND dr.admission_ref IS a.admission_ref
 AND dr.org_id IS k.org_id AND dr.dispatched_at IS dc.created_at AND dr.created_at IS dc.created_at AND dr.all_rows_match IS 1
 AND k.dispatched_at IS dc.created_at)`;
/** Fixed-key L1/D parent proof. Every predicate from B_MATCH/D_MATCH is attached
 * to the first keyed INNER JOIN where all its aliases are in scope. The scalar v
 * row precedes the joins, so their original JSON projections stay correlated.
 * N deliberately keeps its frozen B_JOINS/D_JOINS and exact WHERE expression.
 */
const FLAT_B_FROM = `FROM v JOIN financial_customer_admissions a ON ${B_ORIGINAL}
 JOIN stripe_billing_customer_commands k ON k.org_id=a.organization_id AND ${K_ORIGINAL}
 JOIN stripe_customer_admission_links l ON l.org_id=a.organization_id AND l.admission_ref=a.admission_ref
 AND l.customer_fingerprint IS a.customer_fingerprint AND l.stripe_key IS a.stripe_key AND l.realm_json IS a.realm_json
 AND l.customer_request_json IS a.customer_request_json AND l.created_at IS a.created_at
 JOIN financial_customer_admission_receipts ar ON ar.admission_ref=a.admission_ref
 AND ar.receipt_ref IS a.expected_receipt_ref AND ar.issuance_attempt IS a.issuance_attempt AND ar.org_id IS a.organization_id
 AND ar.created_at IS a.created_at AND ar.all_rows_match IS 1`;
const FLAT_D_FROM = `${FLAT_B_FROM}
 JOIN financial_customer_dispatch_claims dc ON dc.org_id=k.org_id AND dc.admission_ref=a.admission_ref
 AND dc.claim_ref IS ${V("claimRef")} AND dc.attempt_ref IS ${V("dispatchAttemptRef")}
 AND dc.l1_receipt_ref IS ar.receipt_ref AND dc.context_json IS a.context_json
 AND dc.expected_dispatch_receipt_ref IS ${V("dispatchReceiptRef")} AND dc.created_at IS ${V("dispatchedAt")}
 JOIN financial_customer_dispatch_receipts dr ON dr.claim_ref=dc.claim_ref
 AND dr.receipt_ref IS dc.expected_dispatch_receipt_ref AND dr.attempt_ref IS dc.attempt_ref AND dr.admission_ref IS a.admission_ref
 AND dr.org_id IS k.org_id AND dr.dispatched_at IS dc.created_at AND dr.created_at IS dc.created_at AND dr.all_rows_match IS 1
 AND k.dispatched_at IS dc.created_at`;
const N_JOINS = `${B_JOINS}${D_JOINS} JOIN stripe_billing_customers b ON b.org_id=k.org_id JOIN financial_customer_custody_receipts nr ON nr.dispatch_receipt_ref=dr.receipt_ref`;
const N_CORE_EXACT = `${D_MATCH} AND nr.custody_receipt_ref IS ${V("custodyReceiptRef")}
 AND nr.dispatch_receipt_ref IS dr.receipt_ref AND nr.org_id IS k.org_id AND nr.customer_id IS k.customer_id
 AND nr.binding_created_at IS b.created_at AND nr.verified_at IS k.verified_at AND nr.created_at IS k.verified_at AND nr.all_rows_match IS 1
 AND b.org_id IS k.org_id AND b.customer_id IS k.customer_id AND b.created_at IS k.verified_at`;
function currentState(state: "absent" | "prepared" | "dispatched" | "verified"): string {
  if (state === "absent")
    return `NOT EXISTS(SELECT 1 FROM stripe_billing_customer_commands k WHERE k.org_id=cv.organization_id)
 AND NOT EXISTS(SELECT 1 FROM stripe_billing_customers b WHERE b.org_id=cv.organization_id)`;
  return `EXISTS(SELECT 1 FROM stripe_billing_customer_commands k LEFT JOIN stripe_billing_customers b ON b.org_id=k.org_id CROSS JOIN v
 WHERE ${K_ORIGINAL} AND k.state='${state}' AND k.dispatched_at IS ${state === "prepared" ? "NULL" : V("dispatchedAt")}
 AND k.customer_id IS ${state === "verified" ? V("nativeOriginal.customerId") : "NULL"}
 AND k.verified_at IS ${state === "verified" ? V("verifiedAt") : "NULL"}
 AND ${state === "verified" ? `b.org_id IS k.org_id AND b.customer_id IS k.customer_id AND b.created_at IS k.verified_at` : "b.org_id IS NULL"})`;
}
function anchorQuery(
  q: CustomerPhaseInput,
  state: "absent" | "prepared" | "dispatched" | "verified",
  post = false,
): string {
  const previousKind =
    q.phase === "L1"
      ? "genesis"
      : q.phase === "D"
        ? "customer-prepared"
        : "customer-first-dispatch";
  return `SELECT 1 ${CUSTOMER_COVERAGE_JOINS} CROSS JOIN v CROSS JOIN ${OLD}
 JOIN financial_customer_history_entries previous ON previous.entry_ref=old.last_entry_ref AND previous.history_ref=cv.history_ref
 WHERE cv.history_ref IS old.history_ref AND cv.coverage_incarnation IS old.coverage_incarnation
 AND cv.original_org_origin IS old.original_org_origin AND cv.realm_registration IS old.realm_registration AND cv.realm_incarnation IS old.realm_incarnation
 AND cv.organization_id IS ${V("admission.identity.action.organizationId")} AND cv.realm_json IS ${V("admission.original.realmJson")}
 AND cv.writer_epoch IS ${V("writerEpoch")} AND hh.history_ref IS old.history_ref AND hh.state IS old.state
 AND hh.journal_sequence=old.journal_sequence${post ? "+1" : ""}
 AND hh.last_entry_ref IS ${post ? V("entryRef") : "old.last_entry_ref"}
 AND hh.last_expected_receipt_ref IS ${post ? V("historyReceiptRef") : "old.last_expected_receipt_ref"}
 AND previous.journal_sequence IS old.journal_sequence AND previous.expected_history_receipt_ref IS old.last_expected_receipt_ref
 AND previous.evidence_kind='${previousKind}'
 AND old.state='active'
 AND ${CUSTOMER_COVERAGE_MATCH} AND ${OLD_CHAIN} AND ${currentState(state)}
 AND NOT EXISTS(SELECT 1 FROM financial_customer_history_entries extra WHERE extra.history_ref=cv.history_ref AND extra.journal_sequence>old.journal_sequence
 AND (extra.entry_ref IS NOT ${V("entryRef")} OR extra.journal_sequence<>old.journal_sequence+1 OR extra.expected_history_receipt_ref IS NOT ${V("historyReceiptRef")}))`;
}
type AnchorState = "absent" | "prepared" | "dispatched" | "verified";
function anchorName(state: AnchorState, post: boolean): string {
  return `customer_anchor_${state}_${post ? "post" : "pre"}`;
}
function anchorBoolName(state: AnchorState, post: boolean): string {
  return `${anchorName(state, post)}_bool`;
}
function anchor(_q: CustomerPhaseInput, state: AnchorState, post = false): string {
  return `EXISTS(SELECT 1 FROM ${anchorName(state, post)})`;
}
function anchorCtes(q: CustomerPhaseInput): string {
  const states: readonly [AnchorState, boolean][] =
    q.phase === "L1"
      ? [
          ["absent", false],
          ["prepared", false],
          ["prepared", true],
        ]
      : q.phase === "D"
        ? [
            ["prepared", false],
            ["dispatched", false],
            ["dispatched", true],
          ]
        : [
            ["dispatched", false],
            ["verified", false],
            ["verified", true],
          ];
  const ctes = states.map(
    ([state, post]) =>
      `${anchorName(state, post)} AS MATERIALIZED (${anchorQuery(q, state, post)})`,
  );
  if (q.phase === "L1") {
    for (const [state, post] of states) {
      if (post) continue;
      const name = anchorName(state, post);
      ctes.push(
        `${anchorBoolName(state, post)} AS MATERIALIZED (SELECT EXISTS(SELECT 1 FROM ${name}) AS ok)`,
      );
    }
  }
  if (q.phase === "N") {
    const bindingMid = anchorQuery(q, "dispatched").replace(
      "b.org_id IS NULL",
      `b.org_id IS k.org_id AND b.customer_id IS ${V("nativeOriginal.customerId")} AND b.created_at IS ${V("verifiedAt")}`,
    );
    ctes.push(`customer_anchor_binding_mid AS MATERIALIZED (${bindingMid})`);
    for (const [state, post] of states) {
      const name = anchorName(state, post);
      ctes.push(
        `${anchorBoolName(state, post)} AS MATERIALIZED (SELECT EXISTS(SELECT 1 FROM ${name}) AS ok)`,
      );
    }
    ctes.push(
      "customer_anchor_binding_mid_bool AS MATERIALIZED (SELECT EXISTS(SELECT 1 FROM customer_anchor_binding_mid) AS ok)",
    );
    ctes.push(`customer_native_core_matches AS MATERIALIZED (
 SELECT a.admission_ref,k.org_id,k.state,k.dispatched_at,k.customer_id,k.verified_at,l.org_id AS link_org_id,ar.receipt_ref AS l1_receipt_ref
 ${N_JOINS} CROSS JOIN v WHERE ${N_CORE_EXACT})`);
  }
  return ctes.join(",\n ");
}
/** The B owner supplies the same fixed guard leaves in a keyed proof relation.
 * Only the command projection differs after D's own CAS; Root is untouched.
 */
function completedNew(
  q: CustomerPhaseInput,
  state: "prepared" | "dispatched",
): { sql: string; params: readonly SqlParam[] } {
  return prepareCustomerCompletionProof(q.admission, state);
}
function wrap(
  sql: string,
  params: readonly SqlParam[],
  data: string,
  q: CustomerPhaseInput,
): SqlStatement {
  return {
    sql: `WITH v(data) AS (VALUES(?)),
 customer_match_scope(history_ref) AS MATERIALIZED (SELECT json_extract(v.data,'$.history.historyRef') FROM v),
 ${CUSTOMER_MATCH_CTES},
 ${anchorCtes(q)} ${sql}`,
    params: [data, ...params],
  };
}
function suffix(q: CustomerPhaseInput, data: string): SqlStatement[] {
  const kind =
    q.phase === "L1"
      ? "customer-prepared"
      : q.phase === "D"
        ? "customer-first-dispatch"
        : "customer-verified-binding";
  const core =
    q.phase === "L1"
      ? q.admission.receiptRef
      : q.phase === "D"
        ? q.dispatchReceiptRef
        : q.custodyReceiptRef;
  const full =
    q.phase === "N" ? null : completedNew(q, q.phase === "L1" ? "prepared" : "dispatched");
  const state = q.phase === "L1" ? "prepared" : q.phase === "D" ? "dispatched" : "verified";
  const joins = q.phase === "L1" ? FLAT_B_FROM : q.phase === "D" ? FLAT_D_FROM : N_JOINS;
  const crossV = q.phase === "N" ? " CROSS JOIN v" : "";
  const corePredicate = q.phase === "N" ? `${N_CORE_EXACT} AND ` : "";
  const dispatchClaim = q.phase === "L1" ? null : q.claimRef,
    dispatchReceipt = q.phase === "L1" ? null : q.dispatchReceiptRef;
  const entryAnchor =
    q.phase === "N" ? `${anchorBoolName("verified", false)}.ok=1` : anchor(q, state);
  const entryAnchorJoin = q.phase === "N" ? ` CROSS JOIN ${anchorBoolName("verified", false)}` : "";
  const entry = wrap(
    `INSERT INTO financial_customer_history_entries
 (entry_ref,history_ref,journal_sequence,ordinal,writer_kind,evidence_kind,original_command_key,transition_ref,
 coupling_attempt_ref,expected_history_receipt_ref,previous_history_receipt_ref,command_org_id,admission_ref,creation_link_org_id,l1_receipt_ref,
 dispatch_claim_ref,dispatch_receipt_ref,custody_receipt_ref,binding_org_id,binding_customer_id,
 command_before_exists,command_before_state,command_before_dispatched_at,command_before_customer_id,command_before_verified_at,
 command_after_state,command_after_dispatched_at,command_after_customer_id,command_after_verified_at,
 binding_before_exists,binding_before_customer_id,binding_before_created_at,binding_after_exists,binding_after_customer_id,binding_after_created_at,recorded_at)
 SELECT ?,?,?+1,0,'customer-custody',?,k.stripe_key,?,?,?,?,k.org_id,a.admission_ref,l.org_id,ar.receipt_ref,?,?,?,?,?,
 ?,?,?,NULL,NULL,k.state,k.dispatched_at,k.customer_id,k.verified_at,0,NULL,NULL,?,?,?,?
 ${joins}${crossV}${entryAnchorJoin}
 WHERE ${corePredicate}${entryAnchor} ${full ? `AND ${full.sql}` : ""}`,
    [
      q.entryRef,
      q.history.historyRef,
      q.history.journalSequence,
      kind,
      core,
      q.couplingAttemptRef,
      q.historyReceiptRef,
      q.history.lastReceiptRef,
      dispatchClaim,
      dispatchReceipt,
      q.phase === "N" ? q.custodyReceiptRef : null,
      q.phase === "N" ? q.admission.identity.action.organizationId : null,
      q.phase === "N" ? q.nativeOriginal.customerId : null,
      q.phase === "L1" ? 0 : 1,
      q.phase === "L1" ? null : q.phase === "D" ? "prepared" : "dispatched",
      q.phase === "N" ? q.dispatchedAt : null,
      q.phase === "N" ? 1 : 0,
      q.phase === "N" ? q.nativeOriginal.customerId : null,
      q.phase === "N" ? q.verifiedAt : null,
      q.phase === "L1" ? q.admission.createdAt : q.phase === "D" ? q.dispatchedAt : q.verifiedAt,
      ...(full?.params ?? []),
    ],
    data,
    q,
  );
  const head = wrap(
    `UPDATE financial_customer_history_heads SET journal_sequence=journal_sequence+1,last_entry_ref=?,last_expected_receipt_ref=?
 WHERE original_org_origin=? AND realm_registration=? AND realm_incarnation=? AND history_ref=? AND journal_sequence=?
 AND last_entry_ref=? AND last_expected_receipt_ref=? AND state=? AND ${anchor(q, state)}
 AND EXISTS(SELECT 1 FROM financial_customer_history_entries e WHERE e.entry_ref=? AND e.history_ref=? AND e.journal_sequence=?+1
 AND e.coupling_attempt_ref=? AND e.expected_history_receipt_ref=? AND e.previous_history_receipt_ref=? AND e.transition_ref=?)`,
    [
      q.entryRef,
      q.historyReceiptRef,
      q.history.originalOrgOrigin,
      q.history.realmRegistration,
      q.history.realmIncarnation,
      q.history.historyRef,
      q.history.journalSequence,
      q.history.lastEntryRef,
      q.history.lastReceiptRef,
      q.history.state,
      q.entryRef,
      q.history.historyRef,
      q.history.journalSequence,
      q.couplingAttemptRef,
      q.historyReceiptRef,
      q.history.lastReceiptRef,
      core,
    ],
    data,
    q,
  );
  const receiptMatch =
    q.phase === "N"
      ? `EXISTS(SELECT 1 FROM customer_native_core_matches parent CROSS JOIN v
 JOIN financial_customer_history_entries e ON e.entry_ref=${V("entryRef")}
 JOIN financial_customer_history_coverages cv ON cv.history_ref=e.history_ref
 JOIN customer_entry_matches valid ON valid.history_ref=cv.history_ref AND valid.history_ref=e.history_ref AND valid.entry_ref=e.entry_ref
 WHERE e.history_ref=${V("history.historyRef")} AND e.journal_sequence=${V("history.journalSequence")}+1
 AND e.evidence_kind=? AND e.transition_ref=? AND e.coupling_attempt_ref=${V("couplingAttemptRef")}
 AND e.expected_history_receipt_ref=${V("historyReceiptRef")} AND e.previous_history_receipt_ref=${V("history.lastReceiptRef")}
 AND e.command_org_id IS parent.org_id AND e.admission_ref IS parent.admission_ref AND e.creation_link_org_id IS parent.link_org_id
 AND e.l1_receipt_ref IS parent.l1_receipt_ref AND e.command_after_state IS parent.state AND e.command_after_dispatched_at IS parent.dispatched_at
 AND e.command_after_customer_id IS parent.customer_id AND e.command_after_verified_at IS parent.verified_at)`
      : `EXISTS(SELECT 1 ${joins} JOIN financial_customer_history_entries e ON e.entry_ref=${V("entryRef")}
 JOIN financial_customer_history_coverages cv ON cv.history_ref=e.history_ref
 JOIN customer_entry_matches valid ON valid.history_ref=cv.history_ref AND valid.history_ref=e.history_ref AND valid.entry_ref=e.entry_ref
 WHERE e.history_ref=${V("history.historyRef")} AND e.journal_sequence=${V("history.journalSequence")}+1
 AND e.evidence_kind=? AND e.transition_ref=? AND e.coupling_attempt_ref=${V("couplingAttemptRef")}
 AND e.expected_history_receipt_ref=${V("historyReceiptRef")} AND e.previous_history_receipt_ref=${V("history.lastReceiptRef")}
 AND e.command_org_id IS k.org_id AND e.admission_ref IS a.admission_ref AND e.creation_link_org_id IS l.org_id
 AND e.l1_receipt_ref IS ar.receipt_ref AND e.command_after_state IS k.state AND e.command_after_dispatched_at IS k.dispatched_at
 AND e.command_after_customer_id IS k.customer_id AND e.command_after_verified_at IS k.verified_at)`;
  const receipt = wrap(
    `INSERT INTO financial_customer_history_receipts
 (receipt_ref,attempt_ref,history_ref,journal_sequence,original_org_origin,realm_registration,realm_incarnation,
 previous_journal_sequence,previous_entry_ref,previous_history_receipt_ref,entry_ref,evidence_kind,command_org_id,l1_receipt_ref,dispatch_receipt_ref,custody_receipt_ref,all_rows_match,created_at)
 VALUES(?,?,?,?+1,?,?,?,?,?,?,?,?,?,?,?,?,CASE WHEN ${anchor(q, state, true)}
 AND ${receiptMatch}
 ${full ? `AND ${full.sql}` : ""} THEN 1 ELSE 0 END,?)`,
    [
      q.historyReceiptRef,
      q.couplingAttemptRef,
      q.history.historyRef,
      q.history.journalSequence,
      q.history.originalOrgOrigin,
      q.history.realmRegistration,
      q.history.realmIncarnation,
      q.history.journalSequence,
      q.history.lastEntryRef,
      q.history.lastReceiptRef,
      q.entryRef,
      kind,
      q.admission.identity.action.organizationId,
      q.admission.receiptRef,
      dispatchReceipt,
      q.phase === "N" ? q.custodyReceiptRef : null,
      kind,
      core,
      ...(full?.params ?? []),
      q.phase === "L1" ? q.admission.createdAt : q.phase === "D" ? q.dispatchedAt : q.verifiedAt,
    ],
    data,
    q,
  );
  return [entry, head, receipt];
}
export function compileCustomerPhase(input: CustomerPhaseInput): CustomerPhasePlan {
  const q = capture(input),
    data = canonicalJson(q);
  const core: SqlStatement[] = [];
  if (q.phase === "L1") {
    for (const [index, original] of prepareCustomerAdmissionBatch(q.admission).entries()) {
      let sql = original.sql;
      if (index < 3) {
        // The frozen B inserts have one outer FROM/WHERE. This anchor reads only
        // scalar v/old history data, never a B outer-row alias, so the one-row
        // 0/1 relation preserves its existing AND predicate for every B row.
        const target = [
          "INSERT INTO financial_customer_admissions",
          "INSERT INTO stripe_billing_customer_commands",
          "INSERT INTO stripe_customer_admission_links",
        ][index];
        const outerWhere = sql.indexOf(" WHERE ");
        const outerFrom = sql.indexOf("FROM shared_customer_challenges c");
        if (!target || !sql.startsWith(target) || outerFrom < 0 || outerWhere <= outerFrom) fail();
        const name = anchorBoolName(index <= 1 ? "absent" : "prepared", false);
        sql = `${sql.slice(0, outerWhere)} CROSS JOIN ${name}${sql.slice(outerWhere)} AND ${name}.ok=1`;
      } else {
        const end = " THEN 1 ELSE 0 END)";
        if (!sql.endsWith(end)) fail();
        sql = sql.slice(0, -end.length) + ` AND ${anchor(q, "prepared")}` + end;
      }
      core.push(wrap(sql, original.params ?? [], data, q));
    }
  } else if (q.phase === "D") {
    const pre = completedNew(q, "prepared"),
      mid = completedNew(q, "dispatched");
    core.push(
      wrap(
        `INSERT INTO financial_customer_dispatch_claims
 (claim_ref,attempt_ref,admission_ref,org_id,l1_receipt_ref,expected_dispatch_receipt_ref,context_json,history_ref,coverage_incarnation,pre_journal_sequence,pre_history_receipt_ref,created_at)
 SELECT ?,?,a.admission_ref,a.organization_id,ar.receipt_ref,?,a.context_json,?,?,?,?,?
 ${FLAT_B_FROM} WHERE ${pre.sql} AND ${anchor(q, "prepared")}`,
        [
          q.claimRef,
          q.dispatchAttemptRef,
          q.dispatchReceiptRef,
          q.history.historyRef,
          q.history.coverageIncarnation,
          q.history.journalSequence,
          q.history.lastReceiptRef,
          q.dispatchedAt,
          ...pre.params,
        ],
        data,
        q,
      ),
    );
    core.push(
      wrap(
        `UPDATE stripe_billing_customer_commands AS k SET state='dispatched',dispatched_at=? FROM v
 WHERE ${K_ORIGINAL} AND k.state='prepared' AND k.dispatched_at IS NULL AND k.customer_id IS NULL AND k.verified_at IS NULL
 AND EXISTS(SELECT 1 FROM financial_customer_dispatch_claims dc CROSS JOIN v WHERE dc.org_id=k.org_id
 AND dc.claim_ref=${V("claimRef")} AND dc.attempt_ref=${V("dispatchAttemptRef")} AND dc.expected_dispatch_receipt_ref=${V("dispatchReceiptRef")}
 AND dc.context_json=${V("admission.contextJson")} AND dc.created_at=${V("dispatchedAt")})
 AND ${pre.sql} AND ${anchor(q, "prepared")}`,
        [q.dispatchedAt, ...pre.params],
        data,
        q,
      ),
    );
    core.push(
      wrap(
        `INSERT INTO financial_customer_dispatch_receipts(receipt_ref,claim_ref,attempt_ref,admission_ref,org_id,dispatched_at,created_at,all_rows_match)
 VALUES(?,?,?,?,?,?,?,CASE WHEN ${mid.sql} AND ${anchor(q, "dispatched")}
 AND EXISTS(SELECT 1 FROM financial_customer_dispatch_claims dc CROSS JOIN v WHERE dc.claim_ref=${V("claimRef")}
 AND dc.attempt_ref=${V("dispatchAttemptRef")} AND dc.org_id=${V("admission.identity.action.organizationId")}
 AND dc.admission_ref=${V("admission.admissionRef")} AND dc.l1_receipt_ref=${V("admission.receiptRef")}
 AND dc.expected_dispatch_receipt_ref=${V("dispatchReceiptRef")} AND dc.context_json=${V("admission.contextJson")} AND dc.created_at=${V("dispatchedAt")}) THEN 1 ELSE 0 END)`,
        [
          q.dispatchReceiptRef,
          q.claimRef,
          q.dispatchAttemptRef,
          q.admission.admissionRef,
          q.admission.identity.action.organizationId,
          q.dispatchedAt,
          q.dispatchedAt,
          ...mid.params,
        ],
        data,
        q,
      ),
    );
  } else {
    const accepted = `EXISTS(SELECT 1 ${B_JOINS} ${D_JOINS} CROSS JOIN v WHERE ${D_MATCH})`;
    // If a binding already exists, deliberately attempt the unique insert and abort.
    // A zero-row INSERT followed by a matching existing row must never mint N.
    core.push(
      wrap(
        `INSERT INTO stripe_billing_customers(org_id,customer_id,created_at)
 SELECT ?,?,? FROM v CROSS JOIN ${anchorBoolName("dispatched", false)} WHERE ${accepted} AND (${anchorBoolName("dispatched", false)}.ok=1
 OR EXISTS(SELECT 1 FROM stripe_billing_customers old_binding
 WHERE old_binding.org_id=${V("admission.identity.action.organizationId")}))`,
        [q.admission.identity.action.organizationId, q.nativeOriginal.customerId, q.verifiedAt],
        data,
        q,
      ),
    );
    // Binding is this exact own prefix. No current NEW owner/card/consent re-authorization.
    const binding = `EXISTS(SELECT 1 FROM stripe_billing_customers b CROSS JOIN v WHERE b.org_id=${V("admission.identity.action.organizationId")}
 AND b.customer_id=${V("nativeOriginal.customerId")} AND b.created_at=${V("verifiedAt")})`;
    const bindingMid = "customer_anchor_binding_mid_bool.ok=1";
    core.push(
      wrap(
        `UPDATE stripe_billing_customer_commands AS k SET state='verified',customer_id=?,verified_at=? FROM v CROSS JOIN customer_anchor_binding_mid_bool
 WHERE ${K_ORIGINAL} AND k.state='dispatched' AND k.dispatched_at=${V("dispatchedAt")} AND k.customer_id IS NULL AND k.verified_at IS NULL
 AND ${accepted} AND ${binding} AND ${bindingMid}`,
        [q.nativeOriginal.customerId, q.verifiedAt],
        data,
        q,
      ),
    );
    core.push(
      wrap(
        `INSERT INTO financial_customer_custody_receipts(custody_receipt_ref,dispatch_receipt_ref,org_id,customer_id,binding_created_at,verified_at,created_at,all_rows_match)
 SELECT ?,?,?,?,?,?,?,CASE WHEN ${accepted} AND ${binding} AND ${anchorBoolName("verified", false)}.ok=1 THEN 1 ELSE 0 END FROM ${anchorBoolName("verified", false)}`,
        [
          q.custodyReceiptRef,
          q.dispatchReceiptRef,
          q.admission.identity.action.organizationId,
          q.nativeOriginal.customerId,
          q.verifiedAt,
          q.verifiedAt,
          q.verifiedAt,
        ],
        data,
        q,
      ),
    );
  }
  const statements: SqlStatement[] = [
    {
      sql: "INSERT INTO money_cutover_writer_permit(singleton,epoch,writer_epoch) VALUES(1,'usd-micros-v2',?)",
      params: [q.writerEpoch],
    },
    ...core,
    ...suffix(q, data),
    {
      sql: "DELETE FROM money_cutover_writer_permit WHERE singleton=1 AND epoch='usd-micros-v2' AND writer_epoch=?",
      params: [q.writerEpoch],
    },
  ];
  if (statements.length !== (q.phase === "L1" ? 9 : 8)) fail();
  return freeze({
    qualification: "private-mechanical-sql-data",
    phase: q.phase,
    statements,
    coreReceiptRef:
      q.phase === "L1"
        ? q.admission.receiptRef
        : q.phase === "D"
          ? q.dispatchReceiptRef
          : q.custodyReceiptRef,
    historyReceiptRef: q.historyReceiptRef,
    couplingAttemptRef: q.couplingAttemptRef,
    commandKey: q.admission.original.key,
    firstDispatchResultIndex: q.phase === "D" ? 2 : null,
  });
}
