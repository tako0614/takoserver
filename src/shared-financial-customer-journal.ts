/** PRIVATE mechanical Customer H1 data/reader component. No issuer or native authority.
 * Exact H0 source/complete inventory and Root captures are independent prerequisites.
 * The finite Customer union does not implement retained adoption or other history families.
 */
import { canonicalJson } from "./json.ts";
import { type Sql, SqlError, type SqlStatement } from "./ports.ts";

export type CustomerEvidenceKind =
  | "customer-prepared"
  | "customer-first-dispatch"
  | "customer-verified-binding";
export interface CustomerJournalSnapshot {
  readonly historyRef: string;
  readonly coverageIncarnation: string;
  readonly originalOrgOrigin: string;
  readonly realmRegistration: string;
  readonly realmIncarnation: string;
  readonly journalSequence: number;
  readonly lastEntryRef: string;
  readonly lastReceiptRef: string;
  readonly state: "active" | "closed";
}
export interface CustomerCompletedReceipt {
  readonly evidenceKind: CustomerEvidenceKind;
  readonly organizationId: string;
  readonly commandKey: string;
  readonly coreReceiptRef: string;
  readonly historyReceiptRef: string;
  readonly historyRef: string;
  readonly journalSequence: number;
  readonly dispatchedAt: string | null;
  readonly customerId: string | null;
  readonly verifiedAt: string | null;
}
const snapshotKeys = [
  "historyRef",
  "coverageIncarnation",
  "originalOrgOrigin",
  "realmRegistration",
  "realmIncarnation",
  "journalSequence",
  "lastEntryRef",
  "lastReceiptRef",
  "state",
] as const;
export function captureCustomerJournalSnapshot(value: unknown): CustomerJournalSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const copy = JSON.parse(canonicalJson(value)) as Record<string, unknown>;
  if (Object.keys(copy).sort().join() !== [...snapshotKeys].sort().join()) invalid();
  for (const key of snapshotKeys) {
    if (key === "journalSequence" || key === "state") continue;
    if (typeof copy[key] !== "string" || copy[key].length === 0 || copy[key].length > 1024)
      invalid();
  }
  if (
    !Number.isSafeInteger(copy.journalSequence) ||
    (copy.journalSequence as number) < 0 ||
    (copy.journalSequence as number) >= Number.MAX_SAFE_INTEGER ||
    (copy.state !== "active" && copy.state !== "closed")
  )
    invalid();
  return Object.freeze(copy) as unknown as CustomerJournalSnapshot;
}
function invalid(): never {
  throw new SqlError("invalid", "invalid closed Customer journal data");
}

/** Fixed SQL leaves consumed only by the finite compiler. They accept no caller SQL. */
export const CUSTOMER_ORIGINAL_JOINS = `
 JOIN financial_customer_admissions a ON a.admission_ref=e.admission_ref
 JOIN stripe_billing_customer_commands k ON k.org_id=e.command_org_id
 JOIN stripe_customer_admission_links l ON l.org_id=e.creation_link_org_id AND l.admission_ref=a.admission_ref
 JOIN financial_customer_admission_receipts ar ON ar.receipt_ref=e.l1_receipt_ref AND ar.admission_ref=a.admission_ref
 JOIN shared_customer_challenges c ON c.challenge_ref=a.challenge_ref
 JOIN financial_payer_grants g ON g.grant_ref=a.grant_ref AND g.challenge_ref=c.challenge_ref
 JOIN financial_payer_consent_witnesses w ON w.grant_ref=g.grant_ref AND w.challenge_ref=c.challenge_ref
 JOIN financial_payer_consent_receipts cr ON cr.grant_ref=g.grant_ref AND cr.challenge_ref=c.challenge_ref`;
export const CUSTOMER_ORIGINAL_MATCH = `(
 (e.command_org_id IS a.organization_id AND e.creation_link_org_id IS a.organization_id
 AND k.realm_json IS a.realm_json AND k.request_json IS a.customer_request_json
 AND k.fingerprint IS a.customer_fingerprint AND k.stripe_key IS a.stripe_key
 AND k.created_at IS a.created_at AND e.original_command_key IS k.stripe_key)
 AND (l.customer_fingerprint IS a.customer_fingerprint AND l.stripe_key IS a.stripe_key
 AND l.realm_json IS a.realm_json AND l.customer_request_json IS a.customer_request_json AND l.created_at IS a.created_at)
 AND (ar.receipt_ref IS a.expected_receipt_ref AND ar.issuance_attempt IS a.issuance_attempt
 AND ar.org_id IS a.organization_id AND ar.created_at IS a.created_at AND ar.all_rows_match IS 1)
 AND (c.history_ref IS e.history_ref
 AND c.organization_id IS a.organization_id AND c.action_kind IS a.action_kind AND c.action_ref IS a.action_ref
 AND c.request_fingerprint IS a.request_fingerprint AND c.action_json IS a.action_json AND c.selection_json IS a.selection_json)
 AND (json_extract(a.selection_json,'$.selectedTerms') IS a.terms_json
 AND json_extract(a.selection_json,'$.customer.realmJson') IS a.realm_json
 AND json_extract(a.selection_json,'$.customer.requestJson') IS a.customer_request_json
 AND json_extract(a.selection_json,'$.customer.fingerprint') IS a.customer_fingerprint
 AND json_extract(a.selection_json,'$.customer.key') IS a.stripe_key
 AND json_extract(a.context_json,'$.original.realmJson') IS a.realm_json
 AND json_extract(a.context_json,'$.original.requestJson') IS a.customer_request_json
 AND json_extract(a.context_json,'$.original.fingerprint') IS a.customer_fingerprint
 AND json_extract(a.context_json,'$.original.key') IS a.stripe_key
 AND json_extract(a.context_json,'$.selectedTerms') IS a.terms_json
 AND json_extract(a.context_json,'$.identity.action') IS a.action_json
 AND json_extract(a.context_json,'$.identity.requestFingerprint') IS a.request_fingerprint)
 AND (cr.receipt_ref IS g.expected_receipt_ref AND cr.issuance_attempt IS g.issuance_attempt AND cr.all_rows_match IS 1
 AND w.issuance_attempt IS g.issuance_attempt AND w.consumed_at IS g.issued_at
 AND w.consent_registration_ref IS g.consent_registration_ref AND w.consent_incarnation IS g.consent_incarnation
 AND w.consent_ref IS g.consent_ref AND w.consent_proof_ref IS g.consent_proof_ref AND w.consent_digest IS g.consent_digest)
)`;
export const CUSTOMER_DISPATCH_JOINS = `
 JOIN financial_customer_dispatch_claims dc ON dc.claim_ref=e.dispatch_claim_ref
 JOIN financial_customer_dispatch_receipts dr ON dr.receipt_ref=e.dispatch_receipt_ref AND dr.claim_ref=dc.claim_ref`;
export const CUSTOMER_DISPATCH_MATCH = `(
 (dc.admission_ref IS a.admission_ref AND dc.org_id IS a.organization_id AND dc.l1_receipt_ref IS ar.receipt_ref
 AND dc.context_json IS a.context_json AND dc.expected_dispatch_receipt_ref IS dr.receipt_ref)
 AND (dr.attempt_ref IS dc.attempt_ref AND dr.admission_ref IS a.admission_ref AND dr.org_id IS a.organization_id
 AND dr.dispatched_at IS dc.created_at AND dr.created_at IS dc.created_at AND dr.all_rows_match IS 1)
 AND (k.dispatched_at IS dc.created_at AND e.command_after_dispatched_at IS dc.created_at)
 AND EXISTS(SELECT 1 FROM financial_customer_history_coverages cv
 JOIN financial_customer_history_receipts previous ON previous.history_ref=cv.history_ref
 WHERE cv.history_ref IS dc.history_ref AND cv.coverage_incarnation IS dc.coverage_incarnation
 AND previous.receipt_ref IS dc.pre_history_receipt_ref AND previous.journal_sequence IS dc.pre_journal_sequence
 AND previous.all_rows_match IS 1)
)`;
export const CUSTOMER_NATIVE_JOINS = `
 JOIN financial_customer_custody_receipts nr ON nr.custody_receipt_ref=e.custody_receipt_ref AND nr.dispatch_receipt_ref=dr.receipt_ref
 JOIN stripe_billing_customers b ON b.org_id=e.binding_org_id AND b.customer_id=e.binding_customer_id`;
export const CUSTOMER_NATIVE_MATCH = `(
 (nr.org_id IS a.organization_id AND nr.customer_id IS b.customer_id AND b.org_id IS a.organization_id
 AND nr.binding_created_at IS b.created_at AND nr.verified_at IS b.created_at AND nr.created_at IS b.created_at AND nr.all_rows_match IS 1)
 AND (e.command_before_dispatched_at IS dc.created_at AND e.command_after_customer_id IS b.customer_id
 AND e.command_after_verified_at IS b.created_at AND e.binding_after_customer_id IS b.customer_id AND e.binding_after_created_at IS b.created_at)
)`;
/** The caller defines customer_match_scope(history_ref) from its fixed input.
 * MATERIALIZED keeps each finite parent proof as its own expression tree. The
 * same entry_ref/history_ref is used at every stage; parent rows are unique by
 * their frozen PK/UNIQUE keys. No current command state is pinned for old L1/D.
 */
export const CUSTOMER_MATCH_CTES = `
 customer_original_matches AS MATERIALIZED (
 SELECT e.history_ref,e.entry_ref,a.created_at AS matched_recorded_at
 FROM financial_customer_history_entries e
 JOIN customer_match_scope scoped ON scoped.history_ref=e.history_ref
 JOIN financial_customer_history_entries original ON original.entry_ref=e.entry_ref
 ${CUSTOMER_ORIGINAL_JOINS}
 WHERE ${CUSTOMER_ORIGINAL_MATCH}),
 customer_dispatch_matches AS MATERIALIZED (
 SELECT e.history_ref,e.entry_ref,dc.created_at AS matched_recorded_at
 FROM financial_customer_history_entries e
 JOIN customer_original_matches original_match ON original_match.history_ref=e.history_ref AND original_match.entry_ref=e.entry_ref
 JOIN financial_customer_history_entries accepted ON accepted.entry_ref=e.entry_ref
 ${CUSTOMER_ORIGINAL_JOINS}${CUSTOMER_DISPATCH_JOINS}
 WHERE ${CUSTOMER_DISPATCH_MATCH}),
 customer_native_matches AS MATERIALIZED (
 SELECT e.history_ref,e.entry_ref,b.created_at AS matched_recorded_at
 FROM financial_customer_history_entries e
 JOIN customer_dispatch_matches dispatch_match ON dispatch_match.history_ref=e.history_ref AND dispatch_match.entry_ref=e.entry_ref
 JOIN financial_customer_history_entries ack ON ack.entry_ref=e.entry_ref
 ${CUSTOMER_ORIGINAL_JOINS}${CUSTOMER_DISPATCH_JOINS}${CUSTOMER_NATIVE_JOINS}
 WHERE ${CUSTOMER_NATIVE_MATCH}),
 customer_entry_matches AS MATERIALIZED (
 SELECT e.history_ref,e.entry_ref
 FROM financial_customer_history_entries e
 JOIN customer_match_scope scoped ON scoped.history_ref=e.history_ref
 JOIN financial_customer_history_coverages cv ON cv.history_ref=e.history_ref
 WHERE (e.evidence_kind='genesis' AND e.journal_sequence=0 AND e.transition_ref=cv.expected_receipt_ref
 AND e.expected_history_receipt_ref=cv.expected_receipt_ref AND e.coupling_attempt_ref=cv.attempt_ref)
 UNION ALL
 SELECT e.history_ref,e.entry_ref FROM financial_customer_history_entries e
 JOIN customer_original_matches original_match ON original_match.history_ref=e.history_ref AND original_match.entry_ref=e.entry_ref
 WHERE e.evidence_kind<>'genesis' AND e.evidence_kind='customer-prepared'
 AND e.recorded_at IS original_match.matched_recorded_at
 UNION ALL
 SELECT e.history_ref,e.entry_ref FROM financial_customer_history_entries e
 JOIN customer_dispatch_matches dispatch_match ON dispatch_match.history_ref=e.history_ref AND dispatch_match.entry_ref=e.entry_ref
 WHERE e.evidence_kind<>'genesis' AND e.evidence_kind IN('customer-first-dispatch','customer-verified-binding')
 AND e.evidence_kind='customer-first-dispatch' AND e.recorded_at IS dispatch_match.matched_recorded_at
 UNION ALL
 SELECT e.history_ref,e.entry_ref FROM financial_customer_history_entries e
 JOIN customer_native_matches native_match ON native_match.history_ref=e.history_ref AND native_match.entry_ref=e.entry_ref
 WHERE e.evidence_kind<>'genesis' AND e.evidence_kind IN('customer-first-dispatch','customer-verified-binding')
 AND e.evidence_kind='customer-verified-binding' AND e.recorded_at IS native_match.matched_recorded_at
)`;
/** Structural historical contribution. A missing or NULL proof stays false. */
export const CUSTOMER_ENTRY_MATCH = `EXISTS(SELECT 1 FROM customer_entry_matches valid
 WHERE valid.history_ref=cv.history_ref AND valid.history_ref=e.history_ref AND valid.entry_ref=e.entry_ref)`;
/** Exact H0 root/seal/birth, bidirectional actual inventory and current realm;
 * no count/label authority. The origin birth's Org id must be outside the
 * capture's start roster and still match the current Org row (owner, created_at),
 * and no Org change may have been observed since that capture started (Root's Org
 * triggers no longer close a head; a change invalidates the coverage instead).
 * Money currentness is appended separately below. */
const CUSTOMER_COVERAGE_CORE = `(
 (cv.original_org_origin IS birth.birth_ref AND birth.org_id IS cv.organization_id AND birth.phase='post-seal'
 AND birth.primary_ref IS cv.primary_ref AND birth.enrollment_ref IS cv.enrollment_ref AND birth.complete_seal_ref IS cv.complete_seal_ref)
 AND (json_extract(root.root_json,'$.accountId') IS json_extract(cv.realm_json,'$.accountId')
 AND json_extract(root.root_json,'$.billingAuthority') IS json_extract(cv.realm_json,'$.billingAuthority')
 AND json_extract(root.root_json,'$.financialRealm') IS json_extract(cv.realm_json,'$.financialRealm')
 AND json_extract(root.root_json,'$.writerEpoch') IS cv.writer_epoch AND json_extract(root.root_json,'$.mode')='test')
 AND (seal.receipt_ref IS cv.complete_seal_ref AND seal.receipt_kind='complete-seal' AND seal.all_rows_match IS 1
 AND seal.enrollment_ref IS cv.enrollment_ref AND seal.primary_ref IS cv.primary_ref
 AND run.expected_seal_ref IS seal.receipt_ref AND run.required_json IS cv.required_scopes_json)
 AND (NOT EXISTS(SELECT 1 FROM financial_history_enrollment_roster ro WHERE ro.enrollment_ref=run.enrollment_ref AND ro.org_id=birth.org_id)
 AND EXISTS(SELECT 1 FROM orgs o WHERE o.id IS birth.org_id AND o.owner_principal_id IS birth.owner_principal_id AND o.created_at IS birth.org_created_at)
 AND NOT EXISTS(SELECT 1 FROM financial_customer_history_org_changes ch WHERE ch.change_seq>run.change_high_water))
 AND (eh.enrollment_ref IS run.enrollment_ref AND eh.generation IS run.generation AND eh.state='sealed'
 AND eh.expected_receipt_ref IS seal.receipt_ref)
 AND EXISTS(SELECT 1 FROM financial_history_enrollment_receipts start
 WHERE start.receipt_ref=run.expected_start_receipt_ref AND start.enrollment_ref=run.enrollment_ref
 AND start.primary_ref=run.primary_ref AND start.receipt_kind='capture-start' AND start.all_rows_match IS 1)
 AND NOT EXISTS(SELECT 1 FROM json_each(cv.required_scopes_json) j WHERE NOT EXISTS(
 SELECT 1 FROM financial_customer_history_scopes s JOIN financial_history_enrollment_inventory i ON i.inventory_ref=s.inventory_ref
 WHERE s.history_ref=cv.history_ref AND i.primary_ref=cv.primary_ref AND i.enrollment_ref=cv.enrollment_ref
 AND s.scope_kind IS i.scope_kind AND s.original_scope_ref IS i.original_scope_ref
 AND s.original_scope_incarnation IS i.original_scope_incarnation AND s.evidence_json IS i.evidence_json AND json(j.value)=json(i.evidence_json)))
 AND NOT EXISTS(SELECT 1 FROM financial_customer_history_scopes s LEFT JOIN financial_history_enrollment_inventory i ON i.inventory_ref=s.inventory_ref
 WHERE s.history_ref=cv.history_ref AND (i.inventory_ref IS NULL OR i.primary_ref IS NOT cv.primary_ref OR i.enrollment_ref IS NOT cv.enrollment_ref
 OR s.scope_kind IS NOT i.scope_kind OR s.original_scope_ref IS NOT i.original_scope_ref OR s.original_scope_incarnation IS NOT i.original_scope_incarnation
 OR s.evidence_json IS NOT i.evidence_json OR NOT EXISTS(SELECT 1 FROM json_each(cv.required_scopes_json) j WHERE json(j.value)=json(i.evidence_json))))
 AND EXISTS(SELECT 1 FROM stripe_billing_account_realms realm JOIN stripe_mode_realm mode ON mode.singleton=realm.singleton
 WHERE realm.singleton=1 AND realm.account_id IS json_extract(cv.realm_json,'$.accountId')
 AND realm.billing_authority IS json_extract(cv.realm_json,'$.billingAuthority') AND realm.mode='test' AND mode.mode='test')`;
/** Read/recovery coverage match, byte-identical to the original: the core plus the
 * authorized-epoch and freeze reads. Only fixed GET statements use it. */
export const CUSTOMER_COVERAGE_MATCH = `${CUSTOMER_COVERAGE_CORE}
 AND EXISTS(SELECT 1 FROM money_cutover_authorized_epoch ep WHERE ep.singleton=1 AND ep.writer_epoch IS cv.writer_epoch)
 AND NOT EXISTS(SELECT 1 FROM money_cutover_freeze)
)`;
/** Write coverage match for Customer phase statements. Every row they write is
 * 0104 money-fenced (freeze, Root permit and the coverage's own writer epoch),
 * so no money_cutover_* table is named and Root's Money writer sends them. */
export const CUSTOMER_COVERAGE_FENCED_MATCH = `${CUSTOMER_COVERAGE_CORE}
)`;
export const CUSTOMER_COVERAGE_JOINS = `FROM financial_customer_history_coverages cv
 JOIN financial_customer_history_birth_observations birth ON birth.birth_ref=cv.original_org_origin
 JOIN financial_history_primary_roots root ON root.primary_ref=cv.primary_ref
 JOIN financial_history_enrollments run ON run.enrollment_ref=cv.enrollment_ref AND run.primary_ref=cv.primary_ref
 JOIN financial_history_enrollment_heads eh ON eh.primary_ref=cv.primary_ref
 JOIN financial_history_enrollment_receipts seal ON seal.receipt_ref=cv.complete_seal_ref
 JOIN financial_customer_history_heads hh ON hh.original_org_origin=cv.original_org_origin AND hh.realm_registration=cv.realm_registration AND hh.realm_incarnation=cv.realm_incarnation`;
/** Full finite chain: real receipts/typed parents, no newest-state requirement on old receipts. */
export const CUSTOMER_CHAIN_MATCH = `(
 NOT EXISTS(SELECT 1 FROM financial_customer_history_entries e
 LEFT JOIN financial_customer_history_receipts receipt ON receipt.receipt_ref=e.expected_history_receipt_ref
 LEFT JOIN financial_customer_history_receipts previous ON previous.receipt_ref=e.previous_history_receipt_ref
 LEFT JOIN customer_entry_matches valid ON valid.history_ref=e.history_ref AND valid.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND (
 e.journal_sequence>hh.journal_sequence OR receipt.receipt_ref IS NULL OR receipt.all_rows_match IS NOT 1
 OR receipt.entry_ref IS NOT e.entry_ref OR receipt.attempt_ref IS NOT e.coupling_attempt_ref
 OR receipt.history_ref IS NOT e.history_ref OR receipt.journal_sequence IS NOT e.journal_sequence
 OR receipt.evidence_kind IS NOT e.evidence_kind OR receipt.command_org_id IS NOT e.command_org_id
 OR receipt.l1_receipt_ref IS NOT e.l1_receipt_ref OR receipt.dispatch_receipt_ref IS NOT e.dispatch_receipt_ref OR receipt.custody_receipt_ref IS NOT e.custody_receipt_ref
 OR receipt.original_org_origin IS NOT cv.original_org_origin OR receipt.realm_registration IS NOT cv.realm_registration OR receipt.realm_incarnation IS NOT cv.realm_incarnation
 OR (e.journal_sequence>0 AND (previous.receipt_ref IS NULL OR previous.history_ref IS NOT e.history_ref
 OR previous.journal_sequence IS NOT e.journal_sequence-1 OR receipt.previous_history_receipt_ref IS NOT previous.receipt_ref
 OR receipt.previous_entry_ref IS NOT previous.entry_ref OR receipt.previous_journal_sequence IS NOT previous.journal_sequence))
 OR valid.entry_ref IS NULL))
 AND EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.history_ref=cv.history_ref AND e.journal_sequence=0 AND e.evidence_kind='genesis' AND receipt.receipt_ref=cv.expected_receipt_ref)
 AND (SELECT count(*) FROM financial_customer_history_entries e WHERE e.history_ref=cv.history_ref)=hh.journal_sequence+1
 AND EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN financial_customer_history_receipts receipt ON receipt.entry_ref=e.entry_ref
 WHERE e.entry_ref=hh.last_entry_ref AND e.history_ref=cv.history_ref AND e.journal_sequence=hh.journal_sequence
 AND receipt.receipt_ref=hh.last_expected_receipt_ref AND receipt.all_rows_match=1)
)`;
export const CUSTOMER_CURRENT_CUSTODY_MATCH = `(
 NOT EXISTS(SELECT 1 FROM financial_customer_history_entries e JOIN stripe_billing_customer_commands k ON k.org_id=e.command_org_id
 LEFT JOIN stripe_billing_customers b ON b.org_id=k.org_id
 WHERE e.history_ref=cv.history_ref AND e.evidence_kind<>'genesis'
 AND NOT EXISTS(SELECT 1 FROM financial_customer_history_entries newer WHERE newer.command_org_id=e.command_org_id AND newer.journal_sequence>e.journal_sequence AND newer.history_ref=e.history_ref)
 AND (k.state IS NOT e.command_after_state OR k.dispatched_at IS NOT e.command_after_dispatched_at
 OR k.customer_id IS NOT e.command_after_customer_id OR k.verified_at IS NOT e.command_after_verified_at
 OR (e.binding_after_exists=0 AND b.org_id IS NOT NULL)
 OR (e.binding_after_exists=1 AND (b.org_id IS NULL OR b.customer_id IS NOT e.binding_after_customer_id OR b.created_at IS NOT e.binding_after_created_at))))
 AND NOT EXISTS(SELECT 1 FROM stripe_billing_customer_commands k WHERE k.org_id=cv.organization_id AND NOT EXISTS(
 SELECT 1 FROM financial_customer_history_entries e WHERE e.history_ref=cv.history_ref AND e.command_org_id=k.org_id))
 AND NOT EXISTS(SELECT 1 FROM stripe_billing_customers b WHERE b.org_id=cv.organization_id AND NOT EXISTS(
 SELECT 1 FROM financial_customer_history_entries e WHERE e.history_ref=cv.history_ref AND e.binding_org_id=b.org_id AND e.evidence_kind='customer-verified-binding'))
)`;
export async function readCustomerJournalSnapshot(
  sql: Sql,
  input: {
    readonly organizationId: string;
    readonly realmRegistration: string;
    readonly realmIncarnation: string;
  },
): Promise<CustomerJournalSnapshot | null> {
  const frozen = JSON.parse(canonicalJson(input)) as typeof input;
  const rows = await sql.query(
    `WITH requested(organization_id,realm_registration,realm_incarnation) AS (VALUES(?,?,?)),
 customer_match_scope(history_ref) AS MATERIALIZED (
 SELECT cv.history_ref FROM financial_customer_history_coverages cv CROSS JOIN requested req
 WHERE cv.organization_id=req.organization_id AND cv.realm_registration=req.realm_registration AND cv.realm_incarnation=req.realm_incarnation),
 ${CUSTOMER_MATCH_CTES}
 SELECT cv.history_ref,cv.coverage_incarnation,cv.original_org_origin,cv.realm_registration,cv.realm_incarnation,
 hh.journal_sequence,hh.last_entry_ref,hh.last_expected_receipt_ref,hh.state ${CUSTOMER_COVERAGE_JOINS}
 CROSS JOIN requested req
 WHERE cv.organization_id=req.organization_id AND cv.realm_registration=req.realm_registration AND cv.realm_incarnation=req.realm_incarnation AND hh.history_ref=cv.history_ref
 AND ${CUSTOMER_COVERAGE_MATCH} AND ${CUSTOMER_CHAIN_MATCH} AND ${CUSTOMER_CURRENT_CUSTODY_MATCH}`,
    [frozen.organizationId, frozen.realmRegistration, frozen.realmIncarnation],
  );
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new SqlError("constraint", "ambiguous Customer history");
  const r = rows[0];
  if (!r) invalid();
  return captureCustomerJournalSnapshot({
    historyRef: r.history_ref,
    coverageIncarnation: r.coverage_incarnation,
    originalOrgOrigin: r.original_org_origin,
    realmRegistration: r.realm_registration,
    realmIncarnation: r.realm_incarnation,
    journalSequence: r.journal_sequence,
    lastEntryRef: r.last_entry_ref,
    lastReceiptRef: r.last_expected_receipt_ref,
    state: r.state,
  });
}
/** Literal read selected by the tracker and Financial's request-bound origin. */
export function completedCustomerReceiptReadStatement(coreReceiptRef: string): SqlStatement {
  if (typeof coreReceiptRef !== "string" || coreReceiptRef.length === 0) invalid();
  return Object.freeze({
    sql: `WITH requested(core_receipt_ref) AS (VALUES(?)),
 customer_match_scope(history_ref) AS MATERIALIZED (
 SELECT DISTINCT e.history_ref FROM financial_customer_history_entries e CROSS JOIN requested req
 WHERE e.evidence_kind<>'genesis' AND e.transition_ref=req.core_receipt_ref),
 ${CUSTOMER_MATCH_CTES}
 SELECT e.*,r.receipt_ref ${CUSTOMER_COVERAGE_JOINS}
 JOIN financial_customer_history_entries e ON e.history_ref=cv.history_ref
 JOIN financial_customer_history_receipts r ON r.entry_ref=e.entry_ref
 CROSS JOIN requested req
 WHERE e.evidence_kind<>'genesis' AND e.transition_ref=req.core_receipt_ref AND hh.history_ref=cv.history_ref
 AND ${CUSTOMER_COVERAGE_MATCH} AND ${CUSTOMER_CHAIN_MATCH} AND ${CUSTOMER_CURRENT_CUSTODY_MATCH}`,
    params: Object.freeze([coreReceiptRef]),
  });
}
/** Exact retained completion only, never dispatch permission. Legal D/N advance preserves old L1/D. */
export async function readCompletedCustomerReceipt(
  sql: Sql,
  coreReceiptRef: string,
): Promise<CustomerCompletedReceipt | null> {
  const statement = completedCustomerReceiptReadStatement(coreReceiptRef);
  const rows = await sql.query(statement.sql, statement.params);
  if (rows.length === 0) return null;
  if (rows.length !== 1) throw new SqlError("constraint", "ambiguous retained Customer receipt");
  const r = rows[0];
  if (!r) invalid();
  return Object.freeze({
    evidenceKind: r.evidence_kind,
    organizationId: r.command_org_id,
    commandKey: r.original_command_key,
    coreReceiptRef: r.transition_ref,
    historyReceiptRef: r.receipt_ref,
    historyRef: r.history_ref,
    journalSequence: r.journal_sequence,
    dispatchedAt: r.command_after_dispatched_at,
    customerId: r.command_after_customer_id,
    verifiedAt: r.command_after_verified_at,
  }) as CustomerCompletedReceipt;
}
